import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { agentsAction, type AgentsActionTarget, type SubagentPresenter } from "../src/agents-actions-contract.js";
import { formatWorkflowRuntime, PLAIN_WORKFLOW_PROGRESS_STYLES, registerWorkflowExtension, resetWorkflowRegistry } from "../src/index.js";
import { getSubagentsHandle } from "../src/subagent-actions-handle.js";
import { createSessionAgentsSource } from "../src/session-agents.js";
import { createSubagentActionProvider, createSubagentPresenter, listNames, loadEntries, performAction } from "../subagents/src/actions.js";
import type { SubagentManager } from "../subagents/src/contracts.js";
import { createSubagentManager, registerSubagentsExtension } from "../subagents/src/index.js";
import { latestAttempt, safeSubagentId, shortSubagentId } from "../subagents/src/decode.js";
import { settleAfterShutdown, recordingUi, SESSION, settle, SUBAGENT_ATTEMPT as ATTEMPT, subagentFixture, temporary } from "./agents-workspace-harness.js";

const NOW = 61_000;

/** A command context whose ui fails the test: providers ask the person only through the ActionUi they are given. */
function commandContext(cwd: string, mode: "tui" | "rpc" = "tui"): ExtensionCommandContext {
  const refuse = (): never => { throw new Error("providers never call ctx.ui"); };
  return { cwd, mode, hasUI: true, sessionManager: { getSessionId: () => SESSION }, isProjectTrusted: () => true, ui: { notify: refuse, confirm: refuse, select: refuse, input: refuse, custom: refuse, setWorkingMessage: refuse, setStatus: refuse } } as unknown as ExtensionCommandContext;
}

/** The shared subagent fixture with its provider over a command context whose ui fails the test. */
function fixture(options: Parameters<typeof subagentFixture>[0] = {}) {
  const s = subagentFixture(options);
  const context = commandContext(s.cwd);
  return { ...s, context, provider: createSubagentActionProvider({ manager: s.manager, storageDirectory: s.directory, clipboard: s.clipboard }, context) };
}
const subagent = (id: string): AgentsActionTarget => ({ kind: "subagent", id });
const GROUP: AgentsActionTarget = { kind: "subagents" };
const IN_PLACE = new Set(["Copy branch", "Copy worktree path", "Open prompt in editor", "Open system prompt in editor", "Open result in editor", "Copy run path", "Copy agent ID"]);
/** The menu as the provider gives it: each label with its inPlace mark. */
function marked(labels: readonly string[]) { return labels.map((label) => IN_PLACE.has(label) ? { label, inPlace: true } : { label }); }

void test("a subagent id is safe only as one plain path segment", () => {
  for (const id of ["sub-safe", "a.b_c-1", "...", "A9"]) assert.equal(safeSubagentId(id), true, id);
  for (const id of ["", ".", "..", "bad/id", "bad\\id", "a b", "id\n", "ü"]) assert.equal(safeSubagentId(id), false, JSON.stringify(id));
});

void test("the shared helpers: the latest attempt in any order, the short id of a long id, one in-place set for every provider", () => {
  assert.equal(latestAttempt([{ ...ATTEMPT, attempt: 2 }, { ...ATTEMPT, attempt: 3 }, ATTEMPT])?.attempt, 3);
  assert.equal(latestAttempt(undefined), undefined);
  assert.equal(shortSubagentId("0123456789abc"), "01234567");
  assert.equal(shortSubagentId("0123456789ab"), "0123456789ab");
  assert.deepEqual(["Open diff in editor", "Copy run ID", "Copy agent ID", "Steer"].map(agentsAction), [{ label: "Open diff in editor", inPlace: true }, { label: "Copy run ID", inPlace: true }, { label: "Copy agent ID", inPlace: true }, { label: "Steer" }]);
});

void test("offers each subagent today's /subagents labels for its state, without Back, and marks the in-place ones", async () => {
  const { provider } = fixture();
  assert.deepEqual(await provider.actions(subagent("run-a")), marked(["Copy branch", "Copy worktree path", "Open prompt in editor", "Open system prompt in editor", "Steer", "Stop", "Copy run path", "Copy agent ID"]));
  assert.deepEqual(await provider.actions(subagent("run-b")), marked(["Open prompt in editor", "Open result in editor", "Delete", "Copy run path", "Copy agent ID"]));
  assert.deepEqual(await provider.actions(subagent("run-c")), marked(["Retry", "Delete", "Copy run path", "Copy agent ID"]));
  assert.deepEqual(await provider.actions(GROUP), marked(["Delete all completed", "Delete all failed"]), "the bulk deletions belong to the group only");
  assert.deepEqual(await provider.actions({ kind: "run", runId: "run-a" }), []);
  assert.deepEqual(await provider.actions({ kind: "workflow-agent", runId: "run-a", agentId: "run-a" }), []);
});

void test("offers no deletion without manager.delete, and the group then has no labels", async () => {
  const { provider } = fixture({ delete: false });
  assert.deepEqual(await provider.actions(subagent("run-b")), marked(["Open prompt in editor", "Open result in editor", "Copy run path", "Copy agent ID"]));
  assert.deepEqual(await provider.actions(subagent("run-c")), marked(["Retry", "Copy run path", "Copy agent ID"]));
  assert.deepEqual(await provider.actions(GROUP), []);
});

void test("a subagent whose inspection fails has no labels: the provider rejects with the inspection's error", async () => {
  const { provider } = fixture({ unreadable: ["run-x"] });
  await assert.rejects(provider.actions(subagent("run-x")), /inspection of run-x failed/);
});

void test("copies the agent ID, run path, branch and worktree path with today's notices, and reports a failed copy as a workflow agent's", async () => {
  const { provider, copied, directory } = fixture();
  for (const [label, value, notice] of [
    ["Copy agent ID", "run-a", "Copied agent ID."],
    ["Copy run path", join(directory, "run-a"), "Copied run path."],
    ["Copy branch", "subagent/run-a", "Copied branch."],
    ["Copy worktree path", "/repo/worktree-a", "Copied worktree path."],
  ] as const) {
    const ui = recordingUi();
    assert.deepEqual(await provider.run(subagent("run-a"), label, ui), {});
    assert.equal(copied.at(-1), value);
    assert.deepEqual(ui.calls, [["notify", notice, "info"]]);
  }
  const failing = fixture({ clipboardError: "no clipboard" });
  const ui = recordingUi();
  assert.deepEqual(await failing.provider.run(subagent("run-a"), "Copy agent ID", ui), {});
  assert.deepEqual(ui.calls, [["notify", "Failed to copy agent ID: no clipboard", "error"]]);
});

void test("deletes a settled subagent only after ui.confirm accepts today's question", async () => {
  const declined = fixture();
  const no = recordingUi({ confirm: () => false });
  assert.deepEqual(await declined.provider.run(subagent("run-b"), "Delete", no), {});
  assert.deepEqual(no.calls, [["confirm", "Delete subagent?", "Delete scout (run-b) and its record? This cannot be undone."]]);
  assert.deepEqual(declined.calls, []);

  const accepted = fixture();
  const yes = recordingUi({ confirm: () => true });
  assert.deepEqual(await accepted.provider.run(subagent("run-b"), "Delete", yes), {});
  assert.deepEqual(yes.calls, [["confirm", "Delete subagent?", "Delete scout (run-b) and its record? This cannot be undone."], ["notify", "Deleted subagent run-b.", "info"]]);
  assert.deepEqual(accepted.calls.map(([name, request]) => [name, request]), [["delete", { id: "run-b" }]]);
  assert.equal(accepted.calls[0]?.[2].extensionContext, accepted.context);
});

void test("stops a running subagent only after ui.confirm accepts today's question", async () => {
  const declined = fixture();
  const no = recordingUi({ confirm: () => false });
  assert.deepEqual(await declined.provider.run(subagent("run-a"), "Stop", no), {});
  assert.deepEqual(no.calls, [["confirm", "Stop subagent?", "Stop subagent scout (run-a)? This cannot be undone."]]);
  assert.deepEqual(declined.calls, []);

  const accepted = fixture();
  const yes = recordingUi({ confirm: () => true });
  assert.deepEqual(await accepted.provider.run(subagent("run-a"), "Stop", yes), {});
  assert.deepEqual(yes.calls, [["confirm", "Stop subagent?", "Stop subagent scout (run-a)? This cannot be undone."], ["notify", "Stopped subagent run-a.", "info"]]);
  assert.deepEqual(accepted.calls.map(([name, request]) => [name, request]), [["stop", { id: "run-a" }]]);
  assert.deepEqual(await accepted.provider.actions(subagent("run-a")), marked(["Copy branch", "Copy worktree path", "Open prompt in editor", "Retry", "Edit and retry", "Delete", "Copy run path", "Copy agent ID"]), "a stopped run with a request is offered Retry, Edit and retry and Delete");
});

void test("Stop inspects again after the confirm and refuses a run that settled meanwhile", async () => {
  const { provider, calls, statuses } = fixture();
  const ui = recordingUi({ confirm: () => { statuses.set("run-a", { ...statuses.get("run-a"), state: "completed", finishedAt: 2_000 }); return true; } });
  assert.deepEqual(await provider.run(subagent("run-a"), "Stop", ui), {});
  assert.deepEqual(ui.calls, [["confirm", "Stop subagent?", "Stop subagent scout (run-a)? This cannot be undone."], ["notify", "Cannot stop: Subagent run-a is no longer running", "warning"]]);
  assert.deepEqual(calls, []);
});

void test("deletes every completed or failed run of the session from the group after ui.confirm", async () => {
  const declined = fixture();
  const no = recordingUi({ confirm: () => false });
  assert.deepEqual(await declined.provider.run(GROUP, "Delete all completed", no), {});
  assert.deepEqual(no.calls, [["confirm", "Delete completed runs?", "Delete all completed subagent runs and their records? This cannot be undone."]]);
  assert.deepEqual(declined.calls, []);

  const completed = fixture();
  const yes = recordingUi({ confirm: () => true });
  assert.deepEqual(await completed.provider.run(GROUP, "Delete all completed", yes), {});
  assert.deepEqual(yes.calls, [["confirm", "Delete completed runs?", "Delete all completed subagent runs and their records? This cannot be undone."], ["notify", "Deleted 1 completed subagent run(s).", "info"]]);
  assert.deepEqual(completed.calls.map(([name, request]) => [name, request]), [["delete", { id: "run-b" }]], "a run of another session is never deleted");
  assert.deepEqual(await completed.provider.actions(GROUP), marked(["Delete all failed"]));

  const failed = fixture({ failDelete: "run-c" });
  const skipped = recordingUi({ confirm: () => true });
  assert.deepEqual(await failed.provider.run(GROUP, "Delete all failed", skipped), {});
  assert.deepEqual(skipped.calls, [["confirm", "Delete failed runs?", "Delete all failed subagent runs and their records? This cannot be undone."], ["notify", "Skipped failed runs: run-c (locked).", "warning"]]);
});

void test("Retry selects the new run, and an invalid retry result is reported, not thrown", async () => {
  const { provider, calls } = fixture({ retry: { id: "run-d", state: "running" } });
  const ui = recordingUi();
  assert.deepEqual(await provider.run(subagent("run-c"), "Retry", ui), { select: "subagent:run-d" });
  assert.deepEqual(ui.calls, [["notify", "Retried subagent run-c as run-d.", "info"]]);
  assert.deepEqual(calls.map(([name, request]) => [name, request]), [["retry", { id: "run-c" }]]);
  assert.equal(calls[0]?.[2].waitForForeground, false, "a foreground run is retried in the background");
  assert.deepEqual(calls.map(([, , , edits]) => edits), [undefined], "a plain Retry asks nothing and passes no edits");

  const invalid = fixture({ retry: { id: "run-c", state: "failed" } });
  const warned = recordingUi();
  assert.deepEqual(await invalid.provider.run(subagent("run-c"), "Retry", warned), {});
  assert.deepEqual(warned.calls, [["notify", "Cannot retry: Retry returned an invalid subagent result", "warning"]]);
});

void test("Edit and retry edits the prompt, model and retries, and an empty answer keeps the model and the count", async () => {
  const { provider, calls, directory } = fixture();
  mkdirSync(join(directory, "run-c"), { recursive: true });
  writeFileSync(join(directory, "run-c", "request.json"), JSON.stringify({ prompt: "OLD", mode: "background", model: "fixture/old:low", retries: 1 }));
  assert.deepEqual(await provider.actions(subagent("run-c")), marked(["Open prompt in editor", "Retry", "Edit and retry", "Delete", "Copy run path", "Copy agent ID"]));
  const inputs = ["fixture/other:high", "3"];
  const ui = recordingUi({ editText: () => "NEW", input: () => inputs.shift() });
  assert.deepEqual(await provider.run(subagent("run-c"), "Edit and retry", ui), { select: "subagent:run-d" });
  assert.deepEqual(ui.of("editText"), [["Edit and retry: prompt", "OLD"]]);
  assert.deepEqual(ui.of("input").map(([title]) => title), ["Model, empty keeps fixture/old:low", "Retries from 0 to 255, empty keeps 1"]);
  assert.deepEqual(calls.map(([name, request, , edits]) => [name, request, edits]), [["retry", { id: "run-c" }, { prompt: "NEW", model: "fixture/other:high", retries: 3 }]]);

  const kept = fixture();
  mkdirSync(join(kept.directory, "run-c"), { recursive: true });
  writeFileSync(join(kept.directory, "run-c", "request.json"), JSON.stringify({ prompt: "OLD", mode: "background" }));
  const keep = recordingUi({ editText: () => "OLD", input: () => "" });
  await kept.provider.run(subagent("run-c"), "Edit and retry", keep);
  assert.deepEqual(keep.of("input").map(([title]) => title), ["Model, empty keeps the current one", "Retries from 0 to 255, empty keeps the current count"]);
  assert.deepEqual(kept.calls.map(([, , , edits]) => edits), [{}], "nothing changed: the persisted request is retried as edited, with no field replaced");
});

void test("Edit and retry cancels at each step without a retry call", async () => {
  for (const cancelAt of ["prompt", "model", "retries"] as const) {
    const { provider, calls, directory } = fixture();
    mkdirSync(join(directory, "run-c"), { recursive: true });
    writeFileSync(join(directory, "run-c", "request.json"), JSON.stringify({ prompt: "OLD", mode: "background" }));
    const ui = recordingUi({ editText: () => cancelAt === "prompt" ? undefined : "NEW", input: (title) => title.startsWith("Model") ? (cancelAt === "model" ? undefined : "") : (cancelAt === "retries" ? undefined : "") });
    assert.deepEqual(await provider.run(subagent("run-c"), "Edit and retry", ui), {}, cancelAt);
    assert.deepEqual(ui.of("notify"), [], cancelAt);
    assert.deepEqual(calls, [], cancelAt);
  }
});

void test("Edit and retry is not offered without a readable request", async () => {
  const { provider, calls } = fixture();
  assert.deepEqual(await provider.actions(subagent("run-c")), marked(["Retry", "Delete", "Copy run path", "Copy agent ID"]));
  const ui = recordingUi();
  assert.deepEqual(await provider.run(subagent("run-c"), "Edit and retry", ui), {});
  assert.deepEqual(ui.of("notify"), [["Cannot edit and retry: Action Edit and retry is no longer available", "warning"]]);
  assert.deepEqual(calls, []);
});

void test("Retry inspects again and refuses a run that is running again", async () => {
  const { calls, statuses, manager, directory, context } = fixture();
  let inspections = 0;
  // The menu check and the action's own check see run-c failed; the check right before the retry sees it running.
  const flipping: SubagentManager = { ...manager, async inspect(request, managerContext) {
    if (request.id === "run-c" && ++inspections === 3) statuses.set("run-c", { ...statuses.get("run-c"), state: "running" });
    return manager.inspect(request, managerContext);
  } };
  const ui = recordingUi();
  const flipped = createSubagentActionProvider({ manager: flipping, storageDirectory: directory, clipboard: async () => {} }, context);
  assert.deepEqual(await flipped.run(subagent("run-c"), "Retry", ui), {});
  assert.equal(inspections, 3);
  assert.deepEqual(ui.calls, [["notify", "Cannot retry: Subagent run-c is no longer retryable", "warning"]]);
  assert.deepEqual(calls, []);
});

void test("Steer asks through editText: a cancel sends nothing, a message steers the running subagent", async () => {
  const cancelled = fixture();
  const ui = recordingUi();
  assert.deepEqual(await cancelled.provider.run(subagent("run-a"), "Steer", ui), {});
  assert.deepEqual(ui.calls, [["editText", "Steer subagent"]]);
  assert.deepEqual(cancelled.calls, []);

  const sent = fixture();
  const message = recordingUi({ editText: () => "check the docs too" });
  assert.deepEqual(await sent.provider.run(subagent("run-a"), "Steer", message), {});
  assert.deepEqual(message.calls, [["editText", "Steer subagent"], ["notify", "Steered subagent run-a.", "info"]]);
  assert.deepEqual(sent.calls.map(([name, request]) => [name, request]), [["steer", { id: "run-a", message: "check the docs too" }]]);
});

void test("Steer checks again after the editor answer and refuses a run that settled meanwhile", async () => {
  const { provider, calls, statuses } = fixture();
  const ui = recordingUi({ editText: () => { statuses.set("run-a", { ...statuses.get("run-a"), state: "completed", finishedAt: 2_000 }); return "too late"; } });
  assert.deepEqual(await provider.run(subagent("run-a"), "Steer", ui), {});
  assert.deepEqual(ui.calls, [["editText", "Steer subagent"], ["notify", "Cannot steer: Subagent run-a is no longer running", "warning"]]);
  assert.deepEqual(calls, []);
});

void test("opens the prompt, the live system prompt and the result through ui.openArtifact", async () => {
  const { provider } = fixture();
  const ui = recordingUi();
  await provider.run(subagent("run-a"), "Open prompt in editor", ui);
  await provider.run(subagent("run-a"), "Open system prompt in editor", ui);
  await provider.run(subagent("run-b"), "Open result in editor", ui);
  assert.deepEqual(ui.calls, [
    ["openArtifact", { extension: ".md", content: "PROMPT A" }, "agent prompt"],
    ["openArtifact", { extension: ".md", content: "SYSTEM" }, "agent system prompt"],
    ["openArtifact", { extension: ".json", content: '{\n  "answer": 42\n}\n' }, "agent result"],
  ]);
});

void test("a label the subagent is no longer offered is reported and does nothing", async () => {
  const { provider, calls } = fixture();
  const ui = recordingUi({ confirm: () => true });
  await provider.run(subagent("run-b"), "Stop", ui);
  await provider.run(subagent("run-a"), "View transcript", ui);
  await provider.run(GROUP, "Delete", ui);
  await provider.run(subagent("run-b"), "Delete all completed", ui);
  await provider.run({ kind: "run", runId: "run-a" }, "Pause", ui);
  await provider.run(subagent("run-missing"), "Copy agent ID", ui);
  assert.deepEqual(ui.calls, [
    ["notify", "Cannot stop: Action Stop is no longer available", "warning"],
    ["notify", "Cannot view transcript: Action View transcript is no longer available", "warning"],
    ["notify", "Cannot delete: Action Delete is no longer available", "warning"],
    ["notify", "Cannot delete all completed: Action Delete all completed is no longer available", "warning"],
    ["notify", "Cannot pause: Action Pause is no longer available", "warning"],
    ["notify", "Cannot copy agent id: Unknown subagent run-missing", "warning"],
  ]);
  assert.deepEqual(calls, []);
});

void test("the workspace's provider starts a registered standalone action detached, its dialogs refused; the picker awaits it with the ActionUi's dialogs", async (t) => {
  resetWorkflowRegistry();
  t.after(() => { resetWorkflowRegistry(); });
  const seen: string[] = [];
  registerWorkflowExtension({ version: "1.0.0", headline: "Standalone action fixture", agentAttemptActions: {
    fixture: {
      label: "Fixture action",
      visible() { return false; },
      run() {},
      visibleStandalone(context) { return context.agent.name === "scout" && context.attempt.attempt === 1; },
      async runStandalone(context) {
        seen.push(`${context.agent.id} ${context.agent.name}`);
        const accepted = await context.ui.confirm("Proceed?", "Run the fixture action.");
        context.ui.notify(accepted ? "accepted" : "declined");
        context.ui.setWorkingMessage?.("working");
        await context.ui.select("Pick one", ["x", "y"]);
      },
    },
    broken: { label: "Broken action", visible() { return false; }, run() {}, visibleStandalone() { return true; }, runStandalone() { return Promise.reject(new Error("pane closed")); } },
  } });
  const { provider, manager, directory, clipboard, cwd } = fixture();
  assert.deepEqual((await provider.actions(subagent("run-a")))[0], { label: "Fixture action" });
  assert.deepEqual((await provider.actions(subagent("run-b"))).map(({ label }) => label).includes("Fixture action"), false, "run-b has no attempt to act on");
  const ui = recordingUi({ confirm: () => true, select: () => "y" });
  assert.deepEqual(await provider.run(subagent("run-a"), "Fixture action", ui), {});
  await settle();
  assert.deepEqual(seen, ["run-a scout"]);
  const refused = (title: string): [string, string, string] => ["notify", `Refused "${title}": an action started from the agents workspace cannot use Pi's dialogs.`, "warning"];
  assert.deepEqual(ui.calls, [refused("Proceed?"), ["notify", "declined", "info"], ["setWorkingMessage", "working"], refused("Pick one"), ["setWorkingMessage", undefined]]);
  const failing = recordingUi();
  assert.deepEqual(await provider.run(subagent("run-a"), "Broken action", failing), {});
  await settle();
  assert.deepEqual(failing.calls, [["notify", "Agent attempt action failed: pane closed", "error"], ["setWorkingMessage", undefined]], "a failure after run returned, reported once");
  // The /subagents picker outside the TUI awaits it, as before the workspace.
  const picker = recordingUi({ confirm: () => true, select: () => "y" });
  assert.equal(await performAction(manager, directory, "run-a", "Fixture action", commandContext(cwd, "rpc"), picker, clipboard), "stay");
  assert.deepEqual(picker.calls, [["confirm", "Proceed?", "Run the fixture action."], ["notify", "accepted", "info"], ["setWorkingMessage", "working"], ["select", "Pick one", ["x", "y"]]]);
});

/** The subagents the session source lists with `presenter`, as the workspace's sidebar shows them: each one's name and detail rows, by id, in sidebar order. */
async function presented(presenter: SubagentPresenter, manager: SubagentManager, context: ExtensionCommandContext): Promise<ReadonlyMap<string, { readonly name: string; readonly details: readonly string[] }>> {
  const nodes = await createSessionAgentsSource(context, { home: undefined, overlayRun: (run) => run, liveAgent: () => undefined, subagents: () => manager, subagentPresenter: () => presenter }, "subagents").list();
  return new Map(nodes.flatMap((node) => node.agent !== undefined && node.target?.kind === "subagent" ? [[node.target.id, { name: node.agent.name, details: node.details(PLAIN_WORKFLOW_PROGRESS_STYLES, NOW) }] as const] : []));
}
function names(shown: ReadonlyMap<string, { readonly name: string }>): Record<string, string> { return Object.fromEntries([...shown].map(([id, { name }]) => [id, name])); }

void test("the presenter names subagents as the /subagents list does and gives their detail rows", async () => {
  const { manager, directory, context, statuses } = fixture();
  mkdirSync(join(directory, "run-red"));
  writeFileSync(join(directory, "run-red", "request.json"), JSON.stringify({ prompt: "red", label: "red\u001b[31m!", mode: "background" }));
  statuses.set("run-red", { id: "run-red", sessionId: SESSION, state: "completed", startedAt: 1_000, finishedAt: 2_000 });
  const described = await presented(createSubagentPresenter({ manager, storageDirectory: directory }, context), manager, context);
  assert.deepEqual(names(described), { "run-a": "scout run-a", "run-b": "scout run-b", "run-c": "run-c", "run-red": "red!" }, "a repeated label carries the short ID");
  assert.deepEqual(described.get("run-a")?.details, ["Selected subagent: scout", "ID: run-a", "State: running", "Model: fixture/model", "Tools: read", `Duration: ${formatWorkflowRuntime(NOW - 1_000)}`]);
  assert.deepEqual(described.get("run-c")?.details, ["Selected subagent: run-c", "ID: run-c", "State: failed", "Tools: (none)", "Duration: 2s", "Error: AGENT_FAILED: boom"]);
});

void test("the presenter names a subagent whose inspection fails from its request label, as the /subagents list does, and details it with its listed row", async () => {
  const { manager, directory, context } = fixture({ unreadable: ["run-b", "run-c"] });
  const described = await presented(createSubagentPresenter({ manager, storageDirectory: directory }, context), manager, context);
  assert.deepEqual([...described.values()].map(({ name }) => name), ["scout run-a", "run-c", "scout run-b"], "its twin still carries the short ID, in the sidebar's order");
  const listed = await loadEntries(manager, directory, context);
  assert.deepEqual(names(described), Object.fromEntries(listNames(listed).map((name, index) => [listed[index]?.status.id, name])), "the names of the /subagents list");
  assert.deepEqual(described.get("run-b")?.details, ["Selected subagent: scout", "ID: run-b", "State: completed", "Tools: (none)", "Duration: 1s"], "what its listed row still tells");
  assert.deepEqual(described.get("run-c")?.details, ["Selected subagent: run-c", "ID: run-c", "State: failed", "Tools: (none)", "Duration: 2s", "Error: AGENT_FAILED: boom"]);
});

void test("each list of the session source lists the subagents once and inspects again only a running one or one whose state or finishedAt changed; the presenter inspects none and reads each request.json once", async () => {
  const { manager, directory, context, statuses } = fixture();
  const counts = { listings: 0, inspections: new Map<string, number>() };
  const counted: SubagentManager = {
    ...manager,
    async inspect(request, managerContext) {
      if (request.id === undefined) counts.listings += 1;
      else counts.inspections.set(request.id, (counts.inspections.get(request.id) ?? 0) + 1);
      return manager.inspect(request, managerContext);
    },
  };
  const source = createSessionAgentsSource(context, { home: undefined, overlayRun: (run) => run, liveAgent: () => undefined, subagents: () => counted, subagentPresenter: () => createSubagentPresenter({ manager: counted, storageDirectory: directory }, context) }, "subagents");
  const names = async (): Promise<string[]> => (await source.list()).flatMap(({ agent }) => agent ? [agent.name] : []);
  assert.deepEqual(await names(), ["scout run-a", "run-c", "scout run-b"]);
  assert.deepEqual([counts.listings, Object.fromEntries(counts.inspections)], [1, { "run-a": 1, "run-b": 1, "run-c": 1 }], "one listing and one inspection per subagent of this session");
  // A read would now return these labels; request.json is written once, so the labels read before stay.
  writeFileSync(join(directory, "run-a", "request.json"), JSON.stringify({ prompt: "p", label: "changed", mode: "background" }));
  mkdirSync(join(directory, "run-c"));
  writeFileSync(join(directory, "run-c", "request.json"), JSON.stringify({ prompt: "p", label: "late", mode: "background" }));
  assert.deepEqual(await names(), ["scout run-a", "run-c", "scout run-b"], "no request.json is read again, an inspected one or a missing one");
  assert.deepEqual([counts.listings, Object.fromEntries(counts.inspections)], [2, { "run-a": 2, "run-b": 1, "run-c": 1 }], "only the running subagent is inspected again");
  statuses.set("run-b", { ...statuses.get("run-b"), finishedAt: 2_500 });
  statuses.set("run-c", { ...statuses.get("run-c"), state: "stopped" });
  assert.deepEqual(await names(), ["scout run-a", "run-c", "scout run-b"]);
  assert.deepEqual([counts.listings, Object.fromEntries(counts.inspections)], [3, { "run-a": 3, "run-b": 2, "run-c": 2 }], "a changed finishedAt or state is inspected again");
});

void test("a list of settled subagents twice inspects and describes them once and reads no result.json again", async () => {
  const home = temporary("settled-subagents");
  const storageDir = join(home, "subagents");
  const context = commandContext(home);
  const done = "11111111-1111-4111-8111-111111111111", broken = "22222222-2222-4222-8222-222222222222";
  for (const [id, label, state, finishedAt] of [[done, "done", "completed", 2_000], [broken, "broken", "failed", 3_000]] as const) {
    mkdirSync(join(storageDir, id), { recursive: true });
    writeFileSync(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "p", label, mode: "background" }));
    writeFileSync(join(storageDir, id, "status.json"), JSON.stringify({ id, sessionId: SESSION, state, startedAt: 1_000, finishedAt, ...(state === "failed" ? { error: { code: "AGENT_FAILED", message: "boom" } } : {}) }));
  }
  writeFileSync(join(storageDir, done, "result.json"), JSON.stringify({ answer: 42 }));
  const manager = createSubagentManager({ storageDir });
  const inspected: string[] = [];
  let described = 0;
  const counted: SubagentManager = { ...manager, async inspect(request, managerContext) { if (request.id !== undefined) inspected.push(request.id); return manager.inspect(request, managerContext); } };
  const presenter = createSubagentPresenter({ manager: counted, storageDirectory: storageDir }, context);
  const source = createSessionAgentsSource(context, { home: undefined, overlayRun: (run) => run, liveAgent: () => undefined, subagents: () => counted, subagentPresenter: () => ({ describe: (...args) => { described += 1; return presenter.describe(...args); } }) }, "subagents");
  const first = await source.list();
  assert.deepEqual(first.flatMap(({ agent }) => agent ? [[agent.name, agent.state, agent.owned]] : []), [["broken", "failed", true], ["done", "completed", true]]);
  assert.deepEqual([inspected.sort(), described], [[done, broken].sort(), 1]);
  // Read again, the result would fail the inspection and the row would lose its owner.
  writeFileSync(join(storageDir, done, "result.json"), "{ not json");
  const second = await source.list();
  assert.deepEqual(second.map(({ key, agent }) => [key, agent?.name, agent?.owned]), first.map(({ key, agent }) => [key, agent?.name, agent?.owned]));
  assert.deepEqual([inspected.length, described], [2, 1], "no second inspection, presentation or result.json read");
  await manager.dispose?.();
});

/** The fixture with run-a settled too, a source over it that counts each inspection by id and each describe(), and the names it lists. */
function settledSource(options: Parameters<typeof subagentFixture>[0] = {}, describeFails: () => boolean = () => false, presenterReady: () => boolean = () => true) {
  const f = fixture(options);
  f.statuses.set("run-a", { ...f.statuses.get("run-a"), state: "completed", finishedAt: 2_000 });
  const counts = { inspections: new Map<string, number>(), described: 0 };
  const counted: SubagentManager = { ...f.manager, async inspect(request, managerContext) { if (request.id !== undefined) counts.inspections.set(request.id, (counts.inspections.get(request.id) ?? 0) + 1); return f.manager.inspect(request, managerContext); } };
  const presenter = createSubagentPresenter({ manager: counted, storageDirectory: f.directory }, f.context);
  const source = createSessionAgentsSource(f.context, { home: undefined, overlayRun: (run) => run, liveAgent: () => undefined, subagents: () => counted, subagentPresenter: () => presenterReady() ? ({ describe: (...args) => { counts.described += 1; if (describeFails()) throw new Error("describe failed"); return presenter.describe(...args); } }) : undefined }, "subagents");
  const names = async (): Promise<string[]> => (await source.list()).flatMap(({ agent }) => agent ? [agent.name] : []);
  return { ...f, counts, names };
}

void test("a subagent gone from the listing has the settled ones described again, so a twin loses its short id", async () => {
  const { statuses, counts, names } = settledSource();
  assert.deepEqual(await names(), ["run-c", "scout run-a", "scout run-b"]);
  assert.deepEqual(await names(), ["run-c", "scout run-a", "scout run-b"]);
  assert.equal(counts.described, 1, "an unchanged settled listing is not described again");
  statuses.delete("run-b");
  assert.deepEqual(await names(), ["run-c", "scout"]);
  assert.equal(counts.described, 2);
  assert.deepEqual(Object.fromEntries(counts.inspections), { "run-a": 1, "run-b": 1, "run-c": 1 }, "the survivors are not inspected again");
});

void test("a settled subagent whose inspection failed is not inspected again until its listing changes", async () => {
  const { statuses, counts, names } = settledSource({ unreadable: ["run-b"] });
  await names();
  await names();
  assert.deepEqual(Object.fromEntries(counts.inspections), { "run-a": 1, "run-b": 1, "run-c": 1 });
  statuses.set("run-b", { ...statuses.get("run-b"), finishedAt: 3_000 });
  await names();
  assert.deepEqual(Object.fromEntries(counts.inspections), { "run-a": 1, "run-b": 2, "run-c": 1 }, "a changed finishedAt inspects it again");
});

void test("a describe() that failed is tried again on the next list, which names the settled subagents", async () => {
  let fail = true;
  const { counts, names } = settledSource({}, () => fail);
  assert.deepEqual(await names(), ["run-c", "run-a", "run-b"], "without presentations each keeps its short id");
  fail = false;
  assert.deepEqual(await names(), ["run-c", "scout run-a", "scout run-b"]);
  assert.equal(counts.described, 2);
  assert.deepEqual(Object.fromEntries(counts.inspections), { "run-a": 1, "run-b": 1, "run-c": 1 }, "rows whose describe() failed keep their inspection");
});

void test("settled subagents listed before the presenter is available are named once it is", async () => {
  let ready = false;
  const { counts, names } = settledSource({}, () => false, () => ready);
  assert.deepEqual(await names(), ["run-c", "run-a", "run-b"]);
  ready = true;
  assert.deepEqual(await names(), ["run-c", "scout run-a", "scout run-b"]);
  assert.equal(counts.described, 1);
  assert.deepEqual(Object.fromEntries(counts.inspections), { "run-a": 1, "run-b": 1, "run-c": 1 }, "the second list inspects nothing again");
});

void test("a new presenter per refresh does not read a request label again", async () => {
  const { manager, directory, context } = fixture({ unreadable: ["run-b"] });
  const dependencies = { manager, storageDirectory: directory };
  assert.equal((await presented(createSubagentPresenter(dependencies, context), manager, context)).get("run-b")?.name, "scout run-b");
  // A read would now return this label; the cached one is what the next presenter shows.
  writeFileSync(join(directory, "run-b", "request.json"), JSON.stringify({ prompt: "p", label: "changed", mode: "background" }));
  const again = await presented(createSubagentPresenter(dependencies, context), manager, context);
  assert.equal(again.get("run-b")?.name, "scout run-b", "run-b's label was not read again");
  rmSync(join(directory, "run-b"), { recursive: true });
  const gone = await presented(createSubagentPresenter(dependencies, context), manager, context);
  assert.equal(gone.get("run-a")?.name, "scout run-a", "the label of a subagent that is still listed survives");
});

void test("the request-label cache keeps an unreadable request.json and is pruned by the listing", async () => {
  const { manager, directory, context } = fixture();
  let mode: "all" | "without-b" = "all";
  const switched: SubagentManager = {
    ...manager,
    async inspect(request, managerContext) {
      if (request.id !== undefined || mode === "all") return manager.inspect(request, managerContext);
      const listed = await manager.inspect(request, managerContext);
      return !Array.isArray(listed) ? [] : (listed as { id?: string }[]).filter((status) => status.id !== "run-b");
    },
  };
  const dependencies = { manager: switched, storageDirectory: directory };
  const describeB = async (): Promise<string[] | undefined> => { const shown = (await presented(createSubagentPresenter(dependencies, context), switched, context)).get("run-b"); return shown && [shown.name, ...shown.details]; };
  const rewrite = (value: string): void => { writeFileSync(join(directory, "run-b", "request.json"), value); };
  rewrite("{ not json");
  assert.match((await describeB())?.join("\n") ?? "", /^run-b\n[\s\S]*Request unavailable: /, "an unreadable request names the run by its id and says why");
  rewrite(JSON.stringify({ prompt: "p", label: "second", mode: "background" }));
  assert.match((await describeB())?.join("\n") ?? "", /Request unavailable: /, "the unreadable request is not read again");
  mode = "without-b";
  await presented(createSubagentPresenter(dependencies, context), switched, context);
  mode = "all";
  assert.equal((await describeB())?.[0], "second", "listed without run-b, its label is read again");
});

void test("an inspection that returns another subagent's status is treated as failed: the requested id keeps its own name and listed row", async () => {
  const { manager, directory, context } = fixture();
  const swapped: SubagentManager = { ...manager, async inspect(request, managerContext) { return manager.inspect(request.id === "run-a" ? { ...request, id: "run-b" } : request, managerContext); } };
  const described = await presented(createSubagentPresenter({ manager: swapped, storageDirectory: directory }, context), swapped, context);
  assert.deepEqual(names(described), { "run-a": "scout run-a", "run-b": "scout run-b", "run-c": "run-c" }, "run-a is named from its listed row, not left empty");
  const details = described.get("run-a")?.details ?? [];
  assert.ok(details.includes("ID: run-a") && !details.includes("ID: run-b"), "its details are those of its own listed row");
});

void test("publishes the subagents handle on start and clears it on shutdown", async () => {
  const { manager, directory, copied } = fixture();
  let shutdown: (() => Promise<void>) | undefined;
  const pi = {
    registerTool() {},
    registerCommand() {},
    on(name: string, handler: () => Promise<void>) { if (name === "session_shutdown") shutdown = handler; },
  } as unknown as Parameters<typeof registerSubagentsExtension>[0];
  registerSubagentsExtension(pi, { manager, managerDependencies: { storageDir: directory }, clipboard: async (value) => { copied.push(value); } });
  const handle = getSubagentsHandle();
  assert.ok(handle);
  const context = commandContext(directory);
  const ui = recordingUi();
  await handle.actions(context).run(subagent("run-b"), "Copy run path", ui);
  assert.deepEqual(copied, [join(directory, "run-b")], "the handle's provider uses the extension's storage and clipboard");
  assert.equal((await presented(handle.presenter(context), manager, context)).get("run-b")?.name, "scout run-b");
  assert.ok(shutdown);
  await shutdown();
  assert.equal(getSubagentsHandle(), undefined);
});

for (const reason of ["reload", "new"] as const) for (const outcome of ["resolves", "throws"]) {
  void test(`a detached standalone action that ${outcome} after /${reason} reaches no stale Pi ui and escapes nowhere`, async (t) => {
    resetWorkflowRegistry();
    t.after(() => { resetWorkflowRegistry(); });
    let settleAction = (): void => {};
    const gate = new Promise<void>((resolve) => { settleAction = resolve; });
    const progress: string[] = [];
    registerWorkflowExtension({ version: "1.0.0", headline: "Late standalone action", agentAttemptActions: {
      later: { label: "Later", visible: () => false, run() {}, visibleStandalone: () => true, async runStandalone(context) { progress.push("started"); context.ui.setWorkingMessage?.("queued"); await gate; progress.push("settled"); if (outcome === "throws") throw new Error("pane failed"); } },
    } });
    const { provider } = fixture();
    const { touched, escaped } = await settleAfterShutdown(provider, subagent("run-a"), "Later", reason, settleAction);
    assert.deepEqual(progress, ["started", "settled"], "started before the shutdown, settled after it");
    assert.deepEqual(escaped, []);
    assert.deepEqual(touched, []);
  });
}
