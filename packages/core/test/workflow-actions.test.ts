import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentsAction, AgentsActionTarget } from "../src/agents-actions-contract.js";
import { RunStore } from "../src/persistence.js";
import type { AgentAttemptAction } from "../src/types.js";
import { workflowSettingsPath } from "../src/validation.js";
import type { WorkflowArtifact } from "../src/workflow-artifacts.js";
import { createWorkflowActionProvider, loadWorkflowRunView, runAgentAction, runWorkflowRunAction, type WorkflowActionDependencies } from "../src/workflow-actions.js";
import { settleAfterShutdown, agentRecord, createRun, launch, liveRun, recordingUi, SESSION, settle, workflowFixture } from "./agents-workspace-harness.js";

const notices = (ui: ReturnType<typeof recordingUi>): unknown[] => ui.of("notify").map(([message]) => message);

type Fixture = ReturnType<typeof workflowFixture> & { readonly ctx: (mode: "tui" | "rpc") => ExtensionCommandContext };
/** The shared workflow fixture with a command context whose ui fails the test: providers never touch Pi's UI. */
function fixture(overrides: Partial<WorkflowActionDependencies> = {}): Fixture {
  const f = workflowFixture(overrides);
  const forbiddenUi = new Proxy({}, { get(_target, key) { throw new Error(`ctx.ui.${String(key)} used by a workflow action`); } });
  return { ...f, ctx: (mode) => ({ cwd: f.cwd, mode, hasUI: true, sessionManager: { getSessionId: () => SESSION }, ui: forbiddenUi }) as unknown as ExtensionCommandContext };
}

const runTarget = (runId: string): AgentsActionTarget => ({ kind: "run", runId });
const labels = (actions: readonly AgentsAction[]): string[] => actions.map(({ label }) => label);
const inPlace = (actions: readonly AgentsAction[]): string[] => actions.filter((action) => action.inPlace).map(({ label }) => label);

void test("run labels follow the run state, without Back", async () => {
  const f = fixture();
  await createRun(f, "running", "running");
  await createRun(f, "pausing", "pausing");
  await createRun(f, "paused", "paused");
  const exhausted = await createRun(f, "exhausted", "budget_exhausted", { agents: [{ id: "a", name: "a", path: "a", state: "completed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 }] });
  await exhausted.requestWorkflowDecision({ kind: "budget", proposalId: "proposal-123456789", runId: exhausted.runId, consumed: { tokens: 1, costUsd: 0, durationMs: 0, agentLaunches: 0 }, previous: { tokens: { hard: 1 } }, proposed: { tokens: { hard: 2 } }, budgetVersion: 1 });
  const waiting = await createRun(f, "waiting", "awaiting_input");
  await waiting.awaitCheckpoint({ path: "checkpoint/ship", name: "ship", prompt: "Ship?", context: null });
  await createRun(f, "done", "completed");
  const tui = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const tuiTail = ["Open script in editor", "Copy run path", "Copy run ID", "Model aliases", "Delete all completed"];
  assert.deepEqual(labels(await tui.actions(runTarget("running"))), ["Pause", "Stop", ...tuiTail]);
  assert.deepEqual(labels(await tui.actions(runTarget("pausing"))), ["Cancel pause", "Stop", ...tuiTail]);
  assert.deepEqual(labels(await tui.actions(runTarget("paused"))), ["Resume", "Stop", ...tuiTail]);
  assert.deepEqual(labels(await tui.actions(runTarget("exhausted"))), ["Resume unchanged", "Adjust budget", "Approve budget proposal", "Reject budget proposal", "Stop", ...tuiTail]);
  assert.deepEqual(labels(await tui.actions(runTarget("waiting"))), ["Stop", "Review ship", ...tuiTail]);
  assert.deepEqual(labels(await tui.actions(runTarget("done"))), ["Open script in editor", "Delete", "Copy run path", "Copy run ID", "Model aliases", "Delete all completed"]);
  assert.deepEqual(inPlace(await tui.actions(runTarget("done"))), ["Open script in editor", "Copy run path", "Copy run ID"]);
  liveRun(f, await createRun(f, "broken", "failed"), "failed");
  assert.deepEqual(labels(await tui.actions(runTarget("done"))), ["Open script in editor", "Delete", "Copy run path", "Copy run ID", "Model aliases", "Delete all completed", "Delete all failed"]);
  const attached = fixture({ isForegroundAttached: (runId) => runId === "attached" });
  await createRun(attached, "attached", "running");
  assert.deepEqual(labels(await createWorkflowActionProvider(attached.deps, attached.ctx("tui")).actions(runTarget("attached"))), ["Pause", "Move to background", "Stop", "Open script in editor", "Copy run path", "Copy run ID", "Model aliases"]);
  assert.deepEqual(await tui.actions(runTarget("missing")), []);
  assert.deepEqual(await tui.actions({ kind: "subagent", id: "running" }), []);
  assert.deepEqual(await tui.actions({ kind: "subagents" }), []);
});

void test("a run's labels replay no journaled operation and read the session's other runs once until those runs change", async (t) => {
  const f = fixture();
  const running = await createRun(f, "running", "running");
  const lifecycle = liveRun(f, running, "running");
  await createRun(f, "done", "completed");
  const journal = t.mock.method(RunStore.prototype, "replayableOperations");
  const replay = t.mock.method(RunStore.prototype, "replay");
  const loads = t.mock.method(RunStore.prototype, "load");
  const others = (): number => loads.mock.calls.filter((call) => (call.this as RunStore).runId !== "running").length;
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const expected = ["Pause", "Stop", "Open script in editor", "Copy run path", "Copy run ID", "Model aliases", "Delete all completed"];
  assert.deepEqual(labels(await provider.actions(runTarget("running"))), expected);
  assert.deepEqual(labels(await provider.actions(runTarget("running"))), expected);
  assert.equal(journal.mock.callCount() + replay.mock.callCount(), 0, "the run's labels replay no journaled operation");
  assert.equal(others(), 1, "the other runs are read once for both asks");
  liveRun(f, await createRun(f, "broken", "failed"), "failed");
  assert.deepEqual(labels(await provider.actions(runTarget("running"))), [...expected, "Delete all failed"], "a new run of this Pi has the session's runs read again");
  const read = others();
  lifecycle.state = "pausing";
  await provider.actions(runTarget("running"));
  assert.ok(others() > read, "a live run that changed state has the session's runs read again");
  const ui = recordingUi({ confirm: () => true });
  await provider.run(runTarget("running"), "Delete all failed", ui);
  assert.deepEqual(notices(ui), ["Deleted 1 failed workflow run(s)."]);
  assert.deepEqual(labels(await provider.actions(runTarget("running"))), expected, "the deleted run's bulk delete is gone");
});

void test("an action that steps aside loads its run once and the session's other runs at most once", async (t) => {
  const f = fixture();
  liveRun(f, await createRun(f, "running", "running"), "running", "paused");
  await createRun(f, "done", "completed");
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  assert.ok(labels(await provider.actions(runTarget("running"))).includes("Pause"), "the menu read the labels");
  const loads = t.mock.method(RunStore.prototype, "load");
  const of = (runId: string): number => loads.mock.calls.filter((call) => (call.this as RunStore).runId === runId).length;
  const ui = recordingUi();
  await provider.run(runTarget("running"), "Pause", ui);
  assert.deepEqual(notices(ui), ["Paused workflow running."]);
  assert.equal(of("running"), 1, "the run is loaded once to check the label and act");
  assert.equal(of("done"), 0, "the bulk labels the menu read are checked as they were read");
  await provider.actions(runTarget("running"));
  assert.equal(of("done"), 1, "the menu reads the other runs again once the action ran");
});

async function agentFixture(actions: Readonly<Record<string, AgentAttemptAction>> = {}): Promise<{ f: Fixture; store: RunStore; branch: string; path: string }> {
  const f = fixture({ registry: { agentAttemptActions: () => actions } as unknown as WorkflowActionDependencies["registry"] });
  execFileSync("git", ["init", "-q", f.cwd]);
  execFileSync("git", ["-C", f.cwd, "config", "user.name", "test"]);
  execFileSync("git", ["-C", f.cwd, "config", "user.email", "test@example.com"]);
  writeFileSync(join(f.cwd, "tracked.txt"), "tracked\n");
  execFileSync("git", ["-C", f.cwd, "add", "."]);
  execFileSync("git", ["-C", f.cwd, "commit", "-qm", "initial"]);
  const store = await createRun(f, "agents", "completed", { agents: [agentRecord("agent-1", { prompt: "PROMPT", systemPrompt: "SYSTEM", resultPath: "agent/result", worktreeOwner: "owner" }), agentRecord("plain")] });
  await store.complete("agent/result", { answer: 42 });
  const { branch, path } = await store.worktree("owner");
  return { f, store, branch, path };
}

void test("agent labels have no View transcript and no Back; copies and editors run in place", async (t) => {
  const extension: AgentAttemptAction = { label: "Inspect attempt", visible: () => true, run: () => {} };
  const { f } = await agentFixture({ inspect: extension });
  const worktrees = await new RunStore(f.cwd, SESSION, "agents", f.home).worktrees();
  assert.equal(worktrees.length, 1, "the fixture's worktree record must load");
  const tui = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const target: AgentsActionTarget = { kind: "workflow-agent", runId: "agents", agentId: "agent-1" };
  const journal = t.mock.method(RunStore.prototype, "replayableOperations");
  const replay = t.mock.method(RunStore.prototype, "replay");
  const actions = await tui.actions(target);
  assert.equal(journal.mock.callCount(), 0, "the agent's labels decode no full journal");
  assert.deepEqual(replay.mock.calls.map(({ arguments: args }) => args), [["agent/result"]], "they read only the agent's result");
  assert.deepEqual(labels(actions), ["Inspect attempt", "Copy branch", "Copy worktree path", "Open diff in editor", "Open prompt in editor", "Open system prompt in editor", "Open result in editor", "Copy agent ID"]);
  assert.deepEqual(inPlace(actions), ["Copy branch", "Copy worktree path", "Open diff in editor", "Open prompt in editor", "Open system prompt in editor", "Open result in editor", "Copy agent ID"]);
  assert.deepEqual(labels(await createWorkflowActionProvider(f.deps, f.ctx("rpc")).actions(target)), ["Inspect attempt", "Copy branch", "Copy worktree path", "Copy agent ID"]);
  assert.deepEqual(labels(await tui.actions({ kind: "workflow-agent", runId: "agents", agentId: "plain" })), ["Inspect attempt", "Copy agent ID"]);
  assert.deepEqual(await tui.actions({ kind: "workflow-agent", runId: "agents", agentId: "gone" }), []);
});

void test("agent actions copy, open editors and run registered actions through the ActionUi; the workspace's provider starts a registered one detached, its dialogs refused", async () => {
  const contexts: string[] = [];
  const answers: unknown[] = [];
  const actions: Record<string, AgentAttemptAction> = {
    inspect: { label: "Inspect attempt", visible: () => true, run: async (context) => { contexts.push(`${context.run.id}/${context.agent.id}/${String(context.attempt.attempt)}/${context.session?.sessionId ?? ""}`); context.ui.notify("from action"); answers.push(await context.ui.confirm("Sure?", "Really?"), await context.ui.select("Pick", ["a", "b"]), await context.ui.input("Name", "hint")); context.ui.setWorkingMessage?.("working"); } },
    broken: { label: "Broken action", visible: () => true, run: () => { throw new Error("action exploded"); } },
  };
  const { f, store, branch, path } = await agentFixture(actions);
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const target: AgentsActionTarget = { kind: "workflow-agent", runId: "agents", agentId: "agent-1" };
  const ui = recordingUi({ confirm: () => true, select: (_title, options) => options.at(-1), input: () => "typed" });
  for (const label of ["Copy branch", "Copy worktree path", "Copy agent ID"]) assert.deepEqual(await provider.run(target, label, ui), {});
  assert.deepEqual(f.copied, [branch, path, "agent-1"]);
  for (const label of ["Open prompt in editor", "Open system prompt in editor", "Open result in editor"]) await provider.run(target, label, ui);
  assert.deepEqual(ui.of("openArtifact"), [
    [{ extension: ".md", content: "PROMPT" }, "agent prompt"],
    [{ extension: ".md", content: "SYSTEM" }, "agent system prompt"],
    [{ extension: ".json", content: "{\n  \"answer\": 42\n}\n" }, "agent result"],
  ]);
  await provider.run(target, "Inspect attempt", ui);
  await settle();
  assert.deepEqual(contexts, ["agents/agent-1/1/native"]);
  assert.deepEqual(answers, [false, undefined, undefined], "each dialog answered as cancelled");
  assert.deepEqual([...ui.of("confirm"), ...ui.of("select"), ...ui.of("input")], [], "Pi is never asked");
  assert.deepEqual(ui.of("setWorkingMessage").flat(), ["working", undefined], "cleared once the detached action settled");
  await provider.run(target, "Broken action", ui);
  await provider.run(target, "View transcript", ui);
  await provider.run({ kind: "workflow-agent", runId: "agents", agentId: "plain" }, "Copy branch", ui);
  const refused = (title: string): [string, string] => [`Refused "${title}": an action started from the agents workspace cannot use Pi's dialogs.`, "warning"];
  assert.deepEqual(ui.of("notify"), [
    ["Copied branch.", "info"],
    ["Copied worktree path.", "info"],
    ["Copied agent ID.", "info"],
    ["from action", "info"],
    refused("Sure?"),
    refused("Pick"),
    refused("Name"),
    ["Agent attempt action failed: action exploded", "error"],
    ["Cannot select workflow action: View transcript", "warning"],
    ["Cannot select workflow action: Copy branch", "warning"],
  ]);
  // The /workflow picker outside the TUI awaits the action, with Pi's dialogs.
  const view = await loadWorkflowRunView(f.deps, f.ctx("rpc"), store);
  const agent = view.run.agents.find((candidate) => candidate.id === "agent-1");
  assert.ok(agent);
  const picker = recordingUi({ confirm: () => true, select: (_title, options) => options.at(-1), input: () => "typed" });
  answers.length = 0;
  await runAgentAction(f.deps, picker, view, agent, "Inspect attempt");
  assert.deepEqual(answers, [true, "b", "typed"], "settled when runAgentAction returned");
  assert.deepEqual(picker.of("confirm"), [["Sure?", "Really?"]]);
  assert.deepEqual(ui.of("editText"), [], "workflow actions never edit text");
  const failing = fixture({ clipboard: async () => { throw new Error("no clipboard"); } });
  await createRun(failing, "copy", "completed");
  const failingUi = recordingUi();
  await createWorkflowActionProvider(failing.deps, failing.ctx("tui")).run(runTarget("copy"), "Copy run ID", failingUi);
  assert.deepEqual(failingUi.of("notify"), [["Failed to copy run ID: no clipboard", "error"]]);
});

void test("run copies and the script editor work on the run's store", async () => {
  const f = fixture();
  const store = await createRun(f, "copy", "running", {}, launch({ script: "// SCRIPT\nreturn 1;" }));
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const ui = recordingUi();
  await provider.run(runTarget("copy"), "Copy run path", ui);
  await provider.run(runTarget("copy"), "Copy run ID", ui);
  await provider.run(runTarget("copy"), "Open script in editor", ui);
  assert.deepEqual(f.copied, [store.directory, "copy"]);
  assert.deepEqual(notices(ui), ["Copied run path.", "Copied run ID."]);
  assert.deepEqual(ui.of("openArtifact"), [[{ extension: ".js", content: readFileSync(join(store.directory, "workflow.js"), "utf8") }, "workflow script"]]);
  assert.match(JSON.stringify(ui.of("openArtifact")), /SCRIPT/);
  rmSync(join(store.directory, "workflow.js"));
  await provider.run(runTarget("copy"), "Open script in editor", ui);
  assert.equal(ui.of("openArtifact").length, 1, "a missing script opens no editor");
  assert.match(String(notices(ui).at(-1)), /^Cannot open workflow script: ENOENT/);
});

void test("Pause, Cancel pause, Move to background and budget decisions notify as the dashboard does", async () => {
  const f = fixture({ isForegroundAttached: (runId) => runId === "run" });
  const store = await createRun(f, "run", "running");
  const lifecycle = liveRun(f, store, "running");
  const provider = createWorkflowActionProvider(f.deps, f.ctx("rpc"));
  const ui = recordingUi();
  await provider.run(runTarget("run"), "Pause", ui);
  assert.equal(lifecycle.state, "pausing");
  await store.saveState({ ...(await store.load()).run, state: "pausing" });
  await provider.run(runTarget("run"), "Cancel pause", ui);
  assert.equal(lifecycle.state, "running");
  await store.saveState({ ...(await store.load()).run, state: "running" });
  await provider.run(runTarget("run"), "Move to background", ui);
  const paused = await createRun(f, "paused-now", "running");
  liveRun(f, paused, "running", "paused");
  await provider.run(runTarget("paused-now"), "Pause", ui);
  assert.deepEqual(ui.of("notify"), [
    ["Pausing workflow run; it pauses once the active operation finishes.", "info"],
    ["Cancelled the pending pause of workflow run.", "info"],
    ["Moved workflow run to background.", "info"],
    ["Paused workflow paused-now.", "info"],
  ]);
  const budget = await createRun(f, "budget", "budget_exhausted");
  for (const proposalId of ["approve-1234567890", "reject-12345678901", "missing-123456789"]) await budget.requestWorkflowDecision({ kind: "budget", proposalId, runId: "budget", consumed: { tokens: 1, costUsd: 0, durationMs: 0, agentLaunches: 0 }, previous: { tokens: { hard: 1 } }, proposed: { tokens: { hard: 2 } }, budgetVersion: 1 });
  f.deps.recovery.answerBudgetDecision = (async (runId: string, proposalId: string, approved: boolean, ...rest: unknown[]) => { f.calls.push(["answerBudgetDecision", runId, proposalId, approved, ...rest]); return proposalId.startsWith("missing") ? undefined : { approved }; }) as unknown as WorkflowActionDependencies["recovery"]["answerBudgetDecision"];
  const budgetUi = recordingUi();
  await provider.run(runTarget("budget"), "Approve budget approve-", budgetUi);
  await provider.run(runTarget("budget"), "Reject budget reject-1", budgetUi);
  await provider.run(runTarget("budget"), "Approve budget missing-", budgetUi);
  assert.deepEqual(budgetUi.of("notify"), [
    ["Budget adjustment approve-1234567890 approved.", "info"],
    ["Budget adjustment reject-12345678901 rejected.", "info"],
    ["Budget proposal is not pending.", "warning"],
  ]);
  const decisions = f.calls.filter(([name]) => name === "answerBudgetDecision");
  assert.deepEqual(decisions.map((call) => call.slice(1, 5)), [["budget", "approve-1234567890", true, true], ["budget", "reject-12345678901", false, true], ["budget", "missing-123456789", true, true]]);
  assert.ok(decisions.every((call) => call[6] === undefined && call[7] === false), "decisions do not wait for the run to finish");
  assert.deepEqual(f.calls.filter(([name]) => name === "moveForegroundToBackground"), [["moveForegroundToBackground", "run"]]);
});

void test("Stop confirms, reports its progress through the status and survives a failing stop", async () => {
  const f = fixture();
  const store = await createRun(f, "run", "running");
  liveRun(f, store, "running");
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const declined = recordingUi({ confirm: () => false });
  await provider.run(runTarget("run"), "Stop", declined);
  assert.deepEqual(declined.of("confirm"), [["Stop workflow?", "Stop workflow run-name (run)? This cannot be undone."]]);
  assert.deepEqual(declined.of("status").flat(), []);
  assert.deepEqual(declined.of("notify"), []);
  assert.deepEqual(f.calls, []);
  const accepted = recordingUi({ confirm: () => true });
  await provider.run(runTarget("run"), "Stop", accepted);
  assert.deepEqual(accepted.of("status").flat(), ["Stopping workflow run-name...", "Workflow run stopped."]);
  assert.deepEqual(accepted.of("notify"), [["Stopped workflow run.", "info"]]);
  assert.deepEqual(f.calls, [["stopWorkflowRun", "run"]]);
  f.deps.stopWorkflowRun = async () => { throw new Error("cleanup failed"); };
  const failed = recordingUi({ confirm: () => true });
  assert.deepEqual(await provider.run(runTarget("run"), "Stop", failed), {});
  assert.deepEqual(failed.of("status").flat(), ["Stopping workflow run-name...", "Could not stop workflow run: cleanup failed"]);
  assert.deepEqual(failed.of("notify"), [["Cannot stop for run: cleanup failed", "warning"]]);
});

void test("Resume asks the mode, parses a budget patch and reports the outcome", async () => {
  const f = fixture();
  await createRun(f, "paused", "paused");
  await createRun(f, "exhausted", "budget_exhausted");
  const results: (() => Promise<{ workflowName: string; state: "running" | "completed" | "awaiting_approval"; attached: boolean; value?: string }>)[] = [
    async () => ({ workflowName: "paused-name", state: "running", attached: false }),
    async () => ({ workflowName: "exhausted-name", state: "completed", attached: false, value: "done" }),
    async () => ({ workflowName: "exhausted-name", state: "awaiting_approval", attached: false }),
    async () => { throw Object.assign(new Error("attached failure"), { workflowResumeAttached: true }); },
    async () => { throw new Error("resume exploded"); },
  ];
  f.deps.resumeSelectedWorkflow = async (...args: unknown[]) => { f.calls.push(["resumeSelectedWorkflow", ...args]); const next = results.shift(); assert.ok(next); return next(); };
  const ctx = f.ctx("tui");
  const provider = createWorkflowActionProvider(f.deps, ctx);
  const modes = ["Background", "Foreground", "Background", "Foreground", "Foreground", "Cancel", "Foreground"];
  const ui = recordingUi({ select: () => modes.shift(), input: () => "{\"tokens\":{\"hard\":3}}" });
  await provider.run(runTarget("paused"), "Resume", ui);
  await provider.run(runTarget("exhausted"), "Resume unchanged", ui);
  await provider.run(runTarget("exhausted"), "Adjust budget", ui);
  await provider.run(runTarget("paused"), "Resume", ui);
  await provider.run(runTarget("paused"), "Resume", ui);
  await provider.run(runTarget("paused"), "Resume", ui);
  assert.deepEqual(ui.of("select").map(([title, options]) => [title, ...(options as string[])]), Array.from({ length: 6 }, (_, index) => [`Resume ${[1, 2].includes(index) ? "exhausted" : "paused"}-name`, "Foreground", "Background", "Cancel"]));
  assert.deepEqual(ui.of("input"), [["Budget patch (JSON)", "{\"tokens\":{\"hard\":null}}"]]);
  const resumes = f.calls.filter(([name]) => name === "resumeSelectedWorkflow");
  assert.deepEqual(resumes.map(([, runId, foreground, context, patch]) => [runId, foreground, context === ctx, patch]), [["paused", false, true, undefined], ["exhausted", true, true, undefined], ["exhausted", false, true, { tokens: { hard: 3 } }], ["paused", true, true, undefined], ["paused", true, true, undefined]]);
  assert.equal(ui.of("notify").length, 4, "the attached failure stays silent");
  assert.deepEqual(ui.of("notify").slice(0, 3), [
    ["Resumed workflow paused-name in background.", "info"],
    ["Workflow exhausted-name completed: \"done\"", "info"],
    ["Budget adjustment for exhausted-name is awaiting approval.", "warning"],
  ]);
  const failure = ui.of("notify")[3];
  assert.equal(failure?.[1], "warning");
  assert.match(String(failure[0]), /^Cannot resume workflow paused: [\s\S]*resume exploded/);
  const bad = recordingUi({ select: () => "Foreground", input: () => "{not json" });
  await provider.run(runTarget("exhausted"), "Adjust budget", bad);
  assert.equal(bad.of("notify").length, 1);
  assert.match(String(bad.of("notify")[0]?.[0]), /^Cannot parse budget patch: /);
  assert.equal(bad.of("notify")[0]?.[1], "warning");
  const cancelled = recordingUi({ select: () => "Foreground", input: () => undefined });
  await provider.run(runTarget("exhausted"), "Adjust budget", cancelled);
  assert.deepEqual(cancelled.of("notify"), []);
  assert.equal(f.calls.filter(([name]) => name === "resumeSelectedWorkflow").length, 5);
});

void test("a Foreground resume settles only after the resumed run settles", async () => {
  const f = fixture();
  await createRun(f, "paused", "paused");
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let resumed = false;
  f.deps.resumeSelectedWorkflow = async () => { resumed = true; await gate; return { workflowName: "paused-name", state: "completed", attached: false }; };
  const ui = recordingUi({ select: () => "Foreground" });
  let settled = false;
  const running = createWorkflowActionProvider(f.deps, f.ctx("tui")).run(runTarget("paused"), "Resume", ui).then((result) => { settled = true; return result; });
  const isResumed = () => resumed;
  for (let attempt = 0; attempt < 100 && !isResumed(); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(isResumed(), true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(settled, false);
  release();
  assert.deepEqual(await running, {});
  assert.deepEqual(notices(ui), ["Workflow paused-name completed."]);
});

void test("Review answers the checkpoint chosen in the review and rpc approves or rejects it directly", async () => {
  const f = fixture();
  const store = await createRun(f, "run", "awaiting_input");
  await store.awaitCheckpoint({ path: "checkpoint/ship", name: "ship", prompt: "Ship?", context: null });
  const tui = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const decisions: ("Approve" | "Reject" | undefined)[] = ["Approve", undefined, "Reject"];
  const ui = recordingUi({ review: () => decisions.shift() });
  await tui.run(runTarget("run"), "Review ship", ui);
  await tui.run(runTarget("run"), "Review ship", ui);
  f.deps.answerCheckpoint = async (...args: unknown[]) => { f.calls.push(["answerCheckpoint", ...args]); return false; };
  await tui.run(runTarget("run"), "Review ship", ui);
  assert.deepEqual(ui.of("reviewCheckpoint").flat(), ["ship", "ship", "ship"]);
  assert.deepEqual(f.calls, [["answerCheckpoint", "run", "ship", true, true], ["answerCheckpoint", "run", "ship", false, true]]);
  assert.deepEqual(ui.of("notify"), [["Checkpoint is not awaiting a response.", "warning"]]);
  f.deps.answerCheckpoint = async () => true;
  const rpc = createWorkflowActionProvider(f.deps, f.ctx("rpc"));
  const rpcUi = recordingUi();
  await rpc.run(runTarget("run"), "Approve ship", rpcUi);
  await rpc.run(runTarget("run"), "Reject ship", rpcUi);
  await rpc.run(runTarget("run"), "Review ship", rpcUi);
  assert.deepEqual(notices(rpcUi), ["Approved checkpoint ship.", "Rejected checkpoint ship.", "Cannot select workflow action: Review ship"]);
});

void test("Delete confirms, refuses a run that is not stopped or that a surviving run depends on", async (t) => {
  const f = fixture();
  const keep = await createRun(f, "keep", "completed");
  const old = await createRun(f, "old", "completed");
  f.deps.terminalRunStates.set("old", "completed");
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const declined = recordingUi({ confirm: () => false });
  await provider.run(runTarget("old"), "Delete", declined);
  assert.deepEqual(declined.of("confirm"), [["Delete workflow?", "Delete old-name (old) and all owned artifacts? This cannot be undone."]]);
  assert.equal(existsSync(old.directory), true);
  const deletes = t.mock.method(RunStore.prototype, "delete");
  const ownStores = new Set<unknown>();
  const providerDeletes = (): number => deletes.mock.calls.filter((call) => !ownStores.has(call.this)).length;
  const accepted = recordingUi({ confirm: () => true });
  assert.deepEqual(await provider.run(runTarget("old"), "Delete", accepted), {});
  assert.deepEqual(accepted.of("notify"), [["Deleted workflow old.", "info"]]);
  assert.equal(providerDeletes(), 1);
  assert.equal(existsSync(old.directory), false);
  assert.equal(existsSync(keep.directory), true);
  assert.equal(f.deps.terminalRunStates.has("old"), false);
  await provider.run(runTarget("old"), "Delete", accepted);
  assert.deepEqual(notices(accepted).at(-1), "Cannot select workflow action: Delete");

  // A run that left its terminal state after its labels were read.
  const stale = await loadWorkflowRunView(f.deps, f.ctx("tui"), keep);
  await keep.saveState({ ...(await keep.load()).run, state: "running" });
  const refused = recordingUi({ confirm: () => true });
  assert.equal(await runWorkflowRunAction(f.deps, f.ctx("tui"), refused, stale, "Delete"), "dashboard");
  assert.deepEqual(refused.of("notify"), [["Stop the workflow before deleting it.", "warning"]]);
  assert.deepEqual(refused.of("confirm"), []);
  assert.equal(existsSync(keep.directory), true);

  // Under the run lock, after the confirm: a run another Pi deleted, and a run resumed meanwhile.
  for (const [id, change, notice, kept] of [
    ["gone", (store: RunStore) => store.delete(true), "Workflow gone is no longer available.", false],
    ["revived", async (store: RunStore) => { await store.saveState({ ...(await store.load()).run, state: "running" }); }, "Stop the workflow before deleting it.", true],
  ] as const) {
    const store = await createRun(f, id, "completed");
    ownStores.add(store);
    const ui = recordingUi();
    const answering = { ...ui, async confirm(title: string, message: string) { await ui.confirm(title, message); await change(store); return true; } };
    assert.deepEqual(await provider.run(runTarget(id), "Delete", answering), {});
    assert.equal(ui.of("confirm").length, 1, id);
    assert.deepEqual(ui.of("notify"), [[notice, "warning"]], id);
    assert.equal(existsSync(store.directory), kept, id);
    assert.equal(providerDeletes(), 1, `${id}: the provider deleted nothing more`);
  }

  const source = await createRun(f, "source-run", "failed");
  await source.complete("agent/replayable", "kept");
  await createRun(f, "retry-child", "interrupted", { workflowName: "retry", parentRunId: "source-run", retry: { sourceRunId: "source-run", lineageRootRunId: "source-run", completedPaths: ["agent/replayable"], incompletePaths: [], namedWorktrees: [] } });
  const dependent = recordingUi({ confirm: () => true });
  await provider.run(runTarget("source-run"), "Delete", dependent);
  assert.deepEqual(dependent.of("notify"), [["Cannot delete workflow source-run: surviving workflow retry-child (retry) depends on it.", "warning"]]);
  assert.equal(existsSync(source.directory), true);
});

void test("Delete of the run whose view is open removes its store, notifies and returns to the picker; a declined one stays on the dashboard", async () => {
  const f = fixture();
  const store = await createRun(f, "open", "completed");
  const view = await loadWorkflowRunView(f.deps, f.ctx("tui"), store);
  const declined = recordingUi({ confirm: () => false });
  assert.equal(await runWorkflowRunAction(f.deps, f.ctx("tui"), declined, view, "Delete"), "dashboard");
  assert.equal(existsSync(store.directory), true);
  const ui = recordingUi({ confirm: () => true });
  assert.equal(await runWorkflowRunAction(f.deps, f.ctx("tui"), ui, view, "Delete"), "picker");
  assert.deepEqual(ui.of("notify"), [["Deleted workflow open.", "info"]]);
  assert.equal(existsSync(store.directory), false);
});

void test("bulk deletes confirm and report deleted and skipped runs", async () => {
  const f = fixture();
  const completed = await createRun(f, "completed-run", "completed");
  const failedA = await createRun(f, "failed-a", "failed");
  const source = await createRun(f, "failed-source", "failed");
  const child = await createRun(f, "interrupted-child", "interrupted", { parentRunId: "failed-source", retry: { sourceRunId: "failed-source", lineageRootRunId: "failed-source", completedPaths: [], incompletePaths: [], namedWorktrees: [] } });
  const provider = createWorkflowActionProvider(f.deps, f.ctx("rpc"));
  const declined = recordingUi({ confirm: () => false });
  await provider.run(runTarget("interrupted-child"), "Delete all failed", declined);
  assert.deepEqual(declined.of("confirm"), [["Delete failed runs?", "Delete all failed workflow runs and their artifacts? This cannot be undone."]]);
  assert.equal(existsSync(failedA.directory), true);
  const ui = recordingUi({ confirm: () => true });
  await provider.run(runTarget("interrupted-child"), "Delete all failed", ui);
  assert.deepEqual(ui.of("notify"), [
    ["Skipped failed runs required by surviving workflows: failed-source (needed by interrupted-child).", "warning"],
    ["Deleted 1 failed workflow run(s).", "info"],
  ]);
  assert.equal(existsSync(failedA.directory), false);
  assert.equal(existsSync(source.directory), true);
  f.deps.coordinateRunMutation = async () => { throw new Error("runs locked"); };
  await provider.run(runTarget("interrupted-child"), "Delete all completed", ui);
  assert.deepEqual(ui.of("notify").at(-1), ["Cannot delete completed runs: runs locked", "warning"]);
  assert.equal(existsSync(completed.directory), true, "a locked run store deletes nothing");
  f.deps.coordinateRunMutation = (task) => task();
  await provider.run(runTarget("interrupted-child"), "Delete all completed", ui);
  assert.deepEqual(ui.of("confirm").at(-1), ["Delete completed runs?", "Delete all completed workflow runs and their artifacts? This cannot be undone."]);
  assert.deepEqual(notices(ui).at(-1), "Deleted 1 completed workflow run(s).");
  assert.equal(existsSync(completed.directory), false);
  assert.equal(existsSync(child.directory), true);
  await provider.run(runTarget("interrupted-child"), "Delete all completed", ui);
  assert.deepEqual(notices(ui).at(-1), "Cannot select workflow action: Delete all completed");
});

void test("Model aliases adds, edits and deletes aliases and confirms an unknown model", async () => {
  const f = fixture();
  await createRun(f, "run", "running");
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const settingsPath = workflowSettingsPath(f.deps.extensionAgentDir);
  const script: Record<string, (string | undefined)[]> = {
    menu: ["Add alias", "Edit fast", "Add alias", "Delete fast", "Back"],
    target: ["openai/gpt", "Manual model ID", "Manual model ID"],
    input: ["fast", "private/model:high", "portable", "private/other"],
  };
  const ui = recordingUi({
    select: (title) => (title.startsWith("Model aliases") ? script.menu : script.target)?.shift(),
    input: () => script.input?.shift(),
    confirm: (title) => title !== "Save unknown model?" || script.input?.length === 0,
  });
  assert.deepEqual(await provider.run(runTarget("run"), "Model aliases", ui), {});
  assert.deepEqual(ui.of("select").map(([title]) => String(title).split("\n")[0]), ["Model aliases", "Model alias target", "Model aliases", "Model alias target", "Model aliases", "Model alias target", "Model aliases", "Model aliases"]);
  assert.deepEqual(ui.of("select")[1]?.[1], ["openai/gpt", "Manual model ID", "Back"]);
  assert.deepEqual(ui.of("select")[2], ["Model aliases\nfast = openai/gpt", ["Add alias", "Edit fast", "Delete fast", "Back"]]);
  assert.deepEqual(ui.of("input").map(([title]) => title), ["Alias name", "Manual model ID", "Alias name", "Manual model ID"]);
  assert.deepEqual(ui.of("confirm"), [
    ["Save unknown model?", "Save this target for cross-machine portability?"],
    ["Save unknown model?", "Save this target for cross-machine portability?"],
    ["Delete model alias?", "Delete fast? Future workflow resumes using this alias may fail."],
  ]);
  assert.deepEqual(ui.of("notify"), [
    [`Saved model aliases to ${settingsPath}.`, "info"],
    ["Warning: private/model:high is not currently available in Pi.", "warning"],
    ["Warning: private/other is not currently available in Pi.", "warning"],
    [`Saved model aliases to ${settingsPath}.`, "info"],
    [`Saved model aliases to ${settingsPath}.`, "info"],
  ]);
  const saved = JSON.parse(readFileSync(settingsPath, "utf8")) as { modelAliases?: Record<string, string> };
  assert.deepEqual(saved.modelAliases, { portable: "private/other" });
});

void test("a label no longer offered is reported and does nothing", async () => {
  const f = fixture();
  await createRun(f, "done", "completed");
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const ui = recordingUi({ confirm: () => true });
  assert.deepEqual(await provider.run(runTarget("done"), "Pause", ui), {});
  assert.deepEqual(await provider.run(runTarget("done"), "Refresh", ui), {});
  assert.deepEqual(await provider.run(runTarget("missing"), "Delete", ui), {});
  assert.deepEqual(await provider.run({ kind: "subagent", id: "done" }, "Stop", ui), {});
  assert.deepEqual(ui.of("notify"), [
    ["Cannot select workflow action: Pause", "warning"],
    ["Cannot select workflow action: Refresh", "warning"],
    ["Cannot select workflow action: Delete", "warning"],
    ["Cannot select workflow action: Stop", "warning"],
  ]);
  assert.deepEqual(ui.of("confirm"), []);
  assert.deepEqual(f.calls, []);
});

void test("Open diff in editor opens the worktree's diff as a .diff artifact, or says there are no changes; it is not offered once the worktree is gone", async () => {
  const { f, path } = await agentFixture();
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const target: AgentsActionTarget = { kind: "workflow-agent", runId: "agents", agentId: "agent-1" };
  const ui = recordingUi();
  await provider.run(target, "Open diff in editor", ui);
  assert.equal(ui.of("openArtifact").length, 0);
  assert.deepEqual(notices(ui), ["No changes since the worktree was created."]);
  writeFileSync(join(path, "tracked.txt"), "tracked\nchanged\n");
  await provider.run(target, "Open diff in editor", ui);
  assert.equal(ui.of("openArtifact").length, 1);
  const opened = ui.of("openArtifact")[0]?.[0] as WorkflowArtifact | undefined;
  assert.equal(opened?.extension, ".diff");
  assert.match(opened.content, /\+changed/);
  assert.equal(labels(await provider.actions({ kind: "workflow-agent", runId: "agents", agentId: "plain" })).includes("Open diff in editor"), false);
  rmSync(path, { recursive: true, force: true });
  assert.equal(labels(await provider.actions(target)).includes("Open diff in editor"), false);
});

void test("Open diff in editor says untracked files are not in the diff when the worktree holds only those", async () => {
  const { f, path } = await agentFixture();
  const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
  const ui = recordingUi();
  writeFileSync(join(path, "fresh.txt"), "new\n");
  await provider.run({ kind: "workflow-agent", runId: "agents", agentId: "agent-1" }, "Open diff in editor", ui);
  assert.equal(ui.of("openArtifact").length, 0);
  assert.deepEqual(notices(ui), ["No tracked changes since the worktree was created; untracked files are not in the diff."]);
});

void test("Open diff in editor on a menu built earlier says when its diff cannot be read", async () => {
  const { f, store, path } = await agentFixture();
  const view = await loadWorkflowRunView(f.deps, f.ctx("tui"), store);
  const agent = view.run.agents.find((candidate) => candidate.id === "agent-1");
  assert.ok(agent);
  const reference = view.worktrees[0];
  assert.ok(reference);
  const broken = recordingUi();
  await runAgentAction(f.deps, broken, { ...view, worktrees: [{ ...reference, base: "0".repeat(40) }] }, agent, "Open diff in editor");
  assert.equal(broken.of("openArtifact").length, 0);
  assert.equal(notices(broken).length, 1);
  assert.match(String(notices(broken)[0]), /^Cannot read the worktree diff: /);
  rmSync(path, { recursive: true, force: true });
  const gone = recordingUi();
  await runAgentAction(f.deps, gone, view, agent, "Open diff in editor");
  assert.equal(gone.of("openArtifact").length, 0);
  assert.match(String(notices(gone)[0]), /^Cannot read the worktree diff: /);
});

for (const reason of ["reload", "new"] as const) for (const outcome of ["resolves", "throws"]) {
  void test(`a detached agent action that ${outcome} after /${reason} reaches no stale Pi ui and escapes nowhere`, async () => {
    let settleAction = (): void => {};
    const gate = new Promise<void>((resolve) => { settleAction = resolve; });
    const progress: string[] = [];
    const { f } = await agentFixture({ later: { label: "Later", visible: () => true, run: async (context) => { progress.push("started"); context.ui.setWorkingMessage?.("queued"); await gate; progress.push("settled"); if (outcome === "throws") throw new Error("pane failed"); } } });
    const provider = createWorkflowActionProvider(f.deps, f.ctx("tui"));
    const { touched, escaped } = await settleAfterShutdown(provider, { kind: "workflow-agent", runId: "agents", agentId: "agent-1" }, "Later", reason, settleAction);
    assert.deepEqual(progress, ["started", "settled"], "started before the shutdown, settled after it");
    assert.deepEqual(escaped, []);
    assert.deepEqual(touched, []);
  });
}
