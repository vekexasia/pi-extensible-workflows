import assert from "node:assert/strict";
import fs, { mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SubagentPresentation, SubagentPresenter } from "../src/agents-actions-contract.js";
import { buildWorkflowPhaseModel, buildWorkflowPhaseTree, workflowPhaseTreeInitialExpanded, workflowPhaseTreeVisibleNodes } from "../src/host-phases.js";
import { formatWorkflowNodeDetails, formatWorkflowTreeLine, type WorkflowProgressStyles } from "../src/host-view.js";
import { formatWorkflowPhaseDashboard, PLAIN_WORKFLOW_PROGRESS_STYLES, type AgentAttemptSummary, type AgentRecord, type PersistedRun, RunStore, type WorkflowAgentSession } from "../src/index.js";
import { createSessionAgentsSource, type SessionAgentsDependencies, type SessionAgent, type SessionTreeNode } from "../src/session-agents.js";
import type { SubagentManager, SubagentManagerContext } from "../subagents/src/contracts.js";
import { createSubagentManager } from "../subagents/src/manager.js";
import { createRun, launch, project } from "./agents-workspace-harness.js";

const MODEL = { provider: "openai", model: "gpt" } as const;
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
const PLAIN = PLAIN_WORKFLOW_PROGRESS_STYLES;
/** Each style names itself around the text, so a row shows which style drew which part. */
const TAGGED: WorkflowProgressStyles = Object.fromEntries((["accent", "success", "error", "warning", "muted", "dim", "bold"] as const).map((name) => [name, (text: string) => `<${name}>${text}</${name}>`])) as unknown as WorkflowProgressStyles;
/** A row of the /workflow tree with its depth, as the sidebar draws a run's node below its root. */
function shifted(row: string, levels = 1): string { return `${row.slice(0, 2)}${"  ".repeat(levels)}${row.slice(2)}`; }
/** The agents of the tree, in sidebar order. */
function agentsOf(nodes: readonly SessionTreeNode[]): SessionAgent[] { return nodes.flatMap(({ agent }) => agent ? [agent] : []); }

function commandContext(cwd: string, sessionId = "session"): ExtensionCommandContext {
  return { cwd, sessionManager: { getSessionId: () => sessionId } } as unknown as ExtensionCommandContext;
}
function attempt(number: number, sessionId: string | undefined, cwd = "/repo/worktree"): AgentAttemptSummary {
  return { attempt: number, transport: "local", ...(sessionId === undefined ? {} : { session: { transport: "local", sessionId, locator: { sessionFile: `/sessions/${sessionId}.jsonl` } } }), setup: { hookNames: [], model: MODEL, tools: [], cwd }, accounting: ZERO };
}
function agent(id: string, name: string, state: AgentRecord["state"], attempts: readonly AgentAttemptSummary[], extra: Partial<AgentRecord> = {}): AgentRecord {
  return { id, name, path: id, state, model: MODEL, tools: [], attempts: Math.max(1, attempts.length), attemptDetails: attempts, ...extra };
}
/** Sets the terminal time recorded in the run's summary.json, which the dashboards sort settled runs by. */
function setTerminalAt(store: RunStore, terminalAt: string): void {
  const path = join(store.directory, "summary.json");
  const summary: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(typeof summary === "object" && summary !== null);
  writeFileSync(path, JSON.stringify({ ...summary, terminalAt }));
}
/** Sets the creation time recorded in the run's summary.json. */
function setCreatedAt(store: RunStore, createdAt: string): void {
  const path = join(store.directory, "summary.json");
  const summary: unknown = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(typeof summary === "object" && summary !== null);
  writeFileSync(path, JSON.stringify({ ...summary, createdAt }));
}
function liveSession(sessionId: string, transport = "local"): WorkflowAgentSession {
  return {
    reference: { transport, sessionId },
    getState: () => ({ model: MODEL, tools: [] }),
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    getLastAssistant: () => undefined,
    subscribe: () => () => {},
    prompt: async () => ({}),
    steer: async () => {},
    abort: async () => {},
    dispose: async () => {},
  };
}
function dependencies(home: string, extra: Partial<SessionAgentsDependencies> = {}): SessionAgentsDependencies {
  return { home, overlayRun: (run) => run, liveAgent: () => undefined, subagents: () => undefined, ...extra };
}
/** A manager whose list returns `listed` and whose per-id inspection returns `inspected[id]`, or the listed row. */
function fakeManager(listed: readonly Record<string, unknown>[], inspected: Readonly<Record<string, Record<string, unknown>>> = {}, extra: Partial<SubagentManager> = {}): SubagentManager & { readonly contexts: SubagentManagerContext[] } {
  const contexts: SubagentManagerContext[] = [];
  return {
    contexts,
    async run() { throw new Error("unexpected run"); },
    async inspect(request, context) {
      contexts.push(context);
      if (request.id === undefined) return listed;
      return inspected[request.id] ?? listed.find((status) => status.id === request.id);
    },
    async steer() { throw new Error("unexpected steer"); },
    async stop() { throw new Error("unexpected stop"); },
    async retry() { throw new Error("unexpected retry"); },
    ...extra,
  };
}
/** A presenter that names the ids of `names` and records each describe() call; its details name the id and the time. */
function fakePresenter(names: Readonly<Record<string, string>>, calls: (readonly string[])[] = []): SubagentPresenter {
  return {
    async describe(ids) {
      calls.push(ids);
      return new Map(ids.flatMap((id): [string, SubagentPresentation][] => {
        const name = names[id];
        return name === undefined ? [] : [[id, { name, details: (styles, now) => [styles.bold(`Subagent ${id}`), `at ${String(now)}`] }]];
      }));
    },
  };
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

void test("lists this session's workflow runs in attention order, each as its /workflow tree, with the agents' summary, attempt and keys", async () => {
  const { home, cwd } = project("session-agents");
  // Whatever order readdir returns: the running run first, then the settled runs by the time they settled, newest first.
  const older = "aaaaaaaa-1111-4111-8111-111111111111";
  const newer = "bbbbbbbb-2222-4222-8222-222222222222";
  const active = "cccccccc-3333-4333-8333-333333333333";
  setTerminalAt(await createRun({ home, cwd }, older, "completed", { workflowName: "gamma", agents: [agent("only", "only", "completed", [attempt(1, "only-1")])] }), "2026-01-01T00:00:00.000Z");
  setTerminalAt(await createRun({ home, cwd }, newer, "completed", { workflowName: "beta", agents: [agent("solo", "solo", "completed", [attempt(1, "solo-1")])] }), "2026-06-01T00:00:00.000Z");
  await createRun({ home, cwd }, active, "running", { workflowName: "alpha", agents: [
    agent("root", "planner", "running", [attempt(1, "root-1", "/repo/first"), attempt(2, "root-2", "/repo/second")], { label: "Planner", model: { ...MODEL, thinking: "high" }, accounting: { input: 1200, output: 300, cacheRead: 0, cacheWrite: 0, cost: 0.5 } }),
    agent("child", "worker", "completed", [attempt(1, "child-1")], { parentId: "root" }),
    agent("grandchild", "helper\u001b[31m", "queued", [], { parentId: "child" }),
  ] });
  const overlaid: string[] = [];
  const source = createSessionAgentsSource(commandContext(cwd), dependencies(home, {
    // The settled child keeps a stale activity in the overlay: activity shows only while an agent runs.
    overlayRun: (run: PersistedRun) => { overlaid.push(run.id); return { ...run, agents: run.agents.map((record) => record.id === "root" ? { ...record, activity: { kind: "tool", text: "bash" } } : record.id === "child" ? { ...record, activity: { kind: "tool", text: "stale" } } : record) }; },
  }));
  const nodes = await source.list();
  // Without declared phases or a phase history every agent sits in the /workflow tree's "Unassigned" phase.
  assert.deepEqual(nodes.map(({ key, parentKey, depth, kind }) => [key, parentKey, depth, kind]), [
    [`run:${active}`, undefined, 0, "run"],
    [`run:${active}:node:phase/unassigned`, `run:${active}`, 1, "phase"],
    [`run:${active}:root`, `run:${active}:node:phase/unassigned`, 2, "agent"],
    [`run:${active}:child`, `run:${active}:root`, 3, "agent"],
    [`run:${active}:grandchild`, `run:${active}:child`, 4, "agent"],
    [`run:${newer}`, undefined, 0, "run"],
    [`run:${newer}:node:phase/unassigned`, `run:${newer}`, 1, "phase"],
    [`run:${newer}:solo`, `run:${newer}:node:phase/unassigned`, 2, "agent"],
    [`run:${older}`, undefined, 0, "run"],
    [`run:${older}:node:phase/unassigned`, `run:${older}`, 1, "phase"],
    [`run:${older}:only`, `run:${older}:node:phase/unassigned`, 2, "agent"],
  ]);
  assert.deepEqual(overlaid.sort(), [older, newer, active].sort(), "every run goes through overlayRun");
  assert.ok(nodes.every((node) => (node.kind === "agent") === (node.agent?.key === node.key)), "an agent node carries its agent, under the same key; no other node has one");
  assert.equal(nodes.find(({ key }) => key === `run:${active}:grandchild`)?.line(PLAIN, false, false), "          • helper · ○", "the label is display text");
  // Agents outside any phase appear in the run's timeline and in the Unassigned node's details.
  const unassignedRun = nodes.find(({ key }) => key === `run:${active}`)?.details(PLAIN, Date.now(), 64) ?? [];
  assert.match(unassignedRun.join("\n"), /Timeline {2}0s ── [\s\S]*Unassigned\s+Planner/);
  const unassignedPhase = nodes.find(({ key }) => key === `run:${active}:node:phase/unassigned`)?.details(PLAIN, Date.now(), 64) ?? [];
  assert.ok(unassignedPhase.some((row) => /^Timeline {2}0s ── /.test(row)));
  assert.equal(unassignedPhase.filter((row) => /Planner|worker|helper/.test(row)).length, 3);
  const agents = agentsOf(nodes);
  assert.deepEqual(agents.map(({ name }) => name), ["Planner", "worker", "helper", "solo", "only"]);
  assert.deepEqual(agents.map(({ state }) => state), ["running", "completed", "queued", "completed", "completed"]);
  assert.deepEqual(agents.map(({ running }) => running), [true, false, true, false, false]);
  assert.deepEqual(agents.map(({ owned }) => owned), [true, true, true, true, true]);
  const [root, child, grandchild] = agents;
  assert.ok(root && child && grandchild);
  assert.equal(root.summary, "gpt:high 1.5kt $0.50");
  assert.equal(child.summary, "gpt");
  assert.equal(root.activity, "bash", "the overlaid run supplies the activity");
  assert.equal(child.activity, undefined, "a completed agent shows no activity");
  assert.equal(root.attempt, 2);
  assert.deepEqual(root.session, attempt(2, "root-2").session, "the latest attempt's session");
  assert.equal(root.cwd, "/repo/second", "the latest attempt's setup cwd");
  assert.equal(grandchild.attempt, undefined);
  assert.equal(grandchild.session, undefined, "an agent without a session still appears");
  assert.equal(grandchild.cwd, cwd, "without an attempt the project directory");
  assert.equal(root.live, undefined);
});

void test("a run with phases, a shell and parallel scopes gives the /workflow tree's nodes, rows, details and initial expansion", async () => {
  const { home, cwd } = project("session-agents");
  const now = Date.now();
  const phased = launch({ phases: ["plan", "review", "ship"] });
  const accounting = (input: number, cost: number): NonNullable<AgentRecord["accounting"]> => ({ input, output: 0, cacheRead: 0, cacheWrite: 0, cost });
  await createRun({ home, cwd }, "run", "running", { workflowName: "review flow", agents: [
    agent("planner", "planner", "completed", [attempt(1, "planner-1")], { accounting: accounting(100, 0.5), startedAt: now - 60_000, durationMs: 20_000 }),
    agent("api", "api", "running", [attempt(1, "api-1")], { structuralPath: ["p", "a"], accounting: accounting(800, 0.25), startedAt: now - 30_000 }),
    agent("helper", "helper", "queued", [], { parentId: "api", structuralPath: ["p", "a"] }),
    agent("ui", "ui", "completed", [attempt(1, "ui-1")], { structuralPath: ["p", "b"], accounting: accounting(400, 0.125), startedAt: now - 25_000, durationMs: 10_000 }),
  ], phase: "review", phaseHistory: [{ phase: "plan", afterAgent: 0 }, { phase: "review", afterAgent: 1 }] }, phased);
  // The live view of the run brings the shell running in the review phase.
  const overlayRun = (run: PersistedRun): PersistedRun => ({ ...run, activeShellsByPhase: [{ phaseIndex: 1, active: 2, startedAt: now - 3000 }] });
  // A running run's header shows its runtime once it has run a second: a creation time ahead of the clock keeps "1s" out under load.
  setCreatedAt(new RunStore(cwd, "session", "run", home), new Date(now + 3_600_000).toISOString());
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { overlayRun })).list();
  const review = "run:run:node:phase/review%231";
  assert.deepEqual(nodes.map(({ key, parentKey, depth, kind, initiallyExpanded }) => [key, parentKey, depth, kind, initiallyExpanded]), [
    ["run:run", undefined, 0, "run", true],
    ["run:run:node:phase/plan%231", "run:run", 1, "phase", true],
    ["run:run:planner", "run:run:node:phase/plan%231", 2, "agent", false],
    [review, "run:run", 1, "phase", true],
    [`${review}/shell`, review, 2, "shell", false],
    [`${review}/operation/p`, review, 2, "operation", true],
    [`${review}/operation/p/a`, `${review}/operation/p`, 3, "operation", true],
    ["run:run:api", `${review}/operation/p/a`, 4, "agent", true],
    ["run:run:helper", "run:run:api", 5, "agent", false],
    [`${review}/operation/p/b`, `${review}/operation/p`, 3, "operation", true],
    ["run:run:ui", `${review}/operation/p/b`, 4, "agent", false],
    ["run:run:node:phase/ship%231", "run:run", 1, "phase", false],
  ]);
  // The rows /workflow draws for the same run, its root selected and every node expanded: below the root each one a level
  // deeper; the root is a header that names the run, since the sidebar holds several runs and /workflow's "Workflow" would not tell them apart.
  const store = new RunStore(cwd, "session", "run", home);
  const loaded = await store.load();
  const dashboard = formatWorkflowPhaseDashboard(overlayRun(loaded.run), loaded.snapshot, 70, { treeOnly: true }, PLAIN, now);
  const rows = dashboard.slice(dashboard.indexOf("Tree") + 1);
  assert.equal(rows[0], "→ ▾ Workflow · ⠦");
  assert.deepEqual(nodes.map((node) => node.line(PLAIN, node.key === "run:run", node.initiallyExpanded)), ["→ ▾ review flow run  ⠦ 2/4 $0.88", ...rows.slice(1).map((row) => shifted(row))]);
  assert.equal(rows[1], "  ▾ plan · ✓");
  assert.equal(nodes[1]?.line(PLAIN, false, false), "    ▸ plan · ✓", "a collapsed node");
  // The details /workflow shows beside the tree, without its enter hints.
  const details = (key: string): readonly string[] => nodes.find((node) => node.key === key)?.details(PLAIN, now, 64) ?? [];
  const runDetails = details("run:run");
  assert.deepEqual(runDetails.slice(0, 5), ["Selected workflow: review flow", "Run ID: run", "Status: running", "agents completed=2 running=1 failed=0 cancelled=0 pending=1", "Agents: 4"]);
  assert.equal(runDetails[5], "", "a blank line before the timeline");
  assert.equal(runDetails[6], "Timeline  0s ── 1m");
  assert.equal(runDetails.length, 7 + 4, "one timeline row per agent");
  assert.match(runDetails[7] ?? "", /^plan\s+planner/, "the first row carries its phase group and label");
  const timelineRow = (rows: readonly string[], label: string): string => rows.map((line) => line.replace(ANSI, "")).find((line) => new RegExp(`^\\s*(?:\\S+\\s+)?${label}\\s`).test(line)) ?? "";
  assert.match(timelineRow(runDetails, "planner"), /20s ✓$/, "a settled agent ends at its start plus duration");
  assert.match(timelineRow(runDetails, "ui"), /10s ✓$/);
  assert.match(timelineRow(runDetails, "api"), /30s ⠦$/, "a running agent grows to now");
  assert.match(timelineRow(runDetails, "helper"), /○ queued/);
  const phaseDetails = details(review);
  assert.deepEqual(phaseDetails.slice(0, 7), ["Selected phase: review", "Status: running", "agents completed=1 running=1 failed=0 cancelled=0 pending=1", "Agents: 3", "Tokens: ∑1.2k ↑1.2k ↓0 ⇢0 ⇠0", "Cost: $0.38", "Elapsed: 30s"]);
  assert.equal(phaseDetails[7], "");
  assert.equal(phaseDetails[8], "Timeline  0s ── 30s");
  assert.equal(phaseDetails.length, 9 + 3);
  assert.deepEqual(phaseDetails.slice(9).map((line) => /(api|helper|ui)/.exec(line)?.[1]).sort(), ["api", "helper", "ui"]);
  assert.doesNotMatch(phaseDetails.join("\n"), /planner/, "agents of other phases are absent");
  assert.match(timelineRow(phaseDetails, "ui"), /10s ✓$/);
  assert.match(timelineRow(phaseDetails, "api"), /30s ⠦$/);
  assert.match(timelineRow(phaseDetails, "helper"), /○ queued/);
  assert.deepEqual(details(`${review}/operation/p/b`), ["Selected operation: p > b", "Phase: review", "Status: completed", "agents completed=1 running=0 failed=0 cancelled=0 pending=0", "Agents: 1", "Tokens: ∑400 ↑400 ↓0 ⇢0 ⇠0", "Cost: $0.13", "Elapsed: 10s"]);
  assert.deepEqual(details(`${review}/shell`).slice(0, 1), ["Selected shell"]);
  assert.deepEqual(details("run:run:api"), ["State: running", "Structural path: p > a", "Model: openai/gpt", "Tools: (none)", "Duration: 30s", "Tokens: ∑800 ↑800 ↓0 ⇢0 ⇠0", "Cost: $0.25"], "what d shows for an agent: /workflow's agent details");
  const title = (key: string): string | undefined => nodes.find((node) => node.key === key)?.title(PLAIN);
  assert.equal(title("run:run"), "review flow run running");
  assert.equal(title(`${review}/operation/p`), "p running");
  assert.equal(title("run:run:node:phase/ship%231"), "ship not started");
});

void test("a run's root row is a header: name, short id, styled state glyph, done/total agents, cost, and the runtime once the run has usage", async () => {
  const { home, cwd } = project("session-agents");
  const running = "aaaaaaaa-1111-4111-8111-111111111111";
  const completed = "bbbbbbbb-2222-4222-8222-222222222222";
  const interrupted = "cccccccc-3333-4333-8333-333333333333";
  const cost = (value: number): Partial<AgentRecord> => ({ accounting: { ...ZERO, cost: value } });
  setCreatedAt(await createRun({ home, cwd }, running, "running", { workflowName: "alpha", agents: [
    agent("a", "a", "completed", [attempt(1, "a-1")], cost(0.5)),
    agent("b", "b", "running", [attempt(1, "b-1")], cost(0.25)),
    agent("c", "c", "failed", [attempt(1, "c-1")]),
    agent("d", "d", "queued", []),
  ] }), new Date(Date.now() - 7_200_000).toISOString());
  setTerminalAt(await createRun({ home, cwd }, completed, "completed", { workflowName: "beta\u001b[31m", agents: [agent("e", "e", "completed", [attempt(1, "e-1")])], usage: { tokens: 0, costUsd: 0, durationMs: 65_000, agentLaunches: 1 } }), "2026-06-01T00:00:00.000Z");
  await createRun({ home, cwd }, interrupted, "interrupted", { workflowName: "gamma", agents: [agent("f", "f", "cancelled", [attempt(1, "f-1")], cost(0.004))], usage: { tokens: 0, costUsd: 0, durationMs: 3000, agentLaunches: 1 } });
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list();
  const root = (runId: string): SessionTreeNode => {
    const node = nodes.find(({ key }) => key === `run:${runId}`);
    assert.ok(node, runId);
    return node;
  };
  // The ▾/▸ icon in the column of a depth-0 row; the label bold, the glyph in the run state's style.
  assert.equal(root(running).line(TAGGED, true, true), "→ ▾ <bold>alpha aaaaaaaa</bold>  <accent>⠦</accent> 2/4 $0.75 2h");
  assert.equal(root(running).line(PLAIN, false, false), "  ▸ alpha aaaaaaaa  ⠦ 2/4 $0.75 2h");
  assert.equal(root(completed).line(TAGGED, false, false), "  ▸ <bold>beta bbbbbbbb</bold>  <success>✓</success> 1/1 1m 5s", "no cost without one; the runtime of the run's usage; the name as display text");
  assert.equal(root(interrupted).line(TAGGED, false, true), "  ▾ <bold>gamma cccccccc</bold>  <warning>↯</warning> 1/1 $0.004 3s");
  // A run that is not in a hard terminal state starts expanded; a finished one collapsed.
  assert.deepEqual([running, completed, interrupted].map((runId) => root(runId).initiallyExpanded), [true, false, true]);
  // The root keeps its key, details and title.
  assert.equal(root(running).title(PLAIN), "alpha aaaaaaaa running");
  assert.equal(root(completed).details(PLAIN, Date.now())[0], "Selected workflow: beta");
});

void test("below its root every node of a run is its /workflow tree node one level deeper, with that node's row and initial expansion", async () => {
  const { home, cwd } = project("session-agents");
  const phased = launch({ phases: ["plan", "review"] });
  const agents = (state: AgentRecord["state"]): AgentRecord[] => [
    agent("planner", "planner", "completed", [attempt(1, "planner-1")]),
    agent("api", "api", state, [attempt(1, "api-1")], { structuralPath: ["p", "a"] }),
    agent("helper", "helper", state === "running" ? "queued" : state, [], { parentId: "api", structuralPath: ["p", "a"] }),
    agent("ui", "ui", "completed", [attempt(1, "ui-1")], { structuralPath: ["p", "b"] }),
  ];
  const history = { phase: "review", phaseHistory: [{ phase: "plan", afterAgent: 0 }, { phase: "review", afterAgent: 1 }] };
  await createRun({ home, cwd }, "run-live", "running", { workflowName: "live", agents: agents("running"), ...history }, phased);
  setTerminalAt(await createRun({ home, cwd }, "run-done", "completed", { workflowName: "done", agents: agents("completed"), ...history }, phased), "2026-06-01T00:00:00.000Z");
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list();
  for (const runId of ["run-live", "run-done"]) {
    const { run, snapshot: loaded } = await new RunStore(cwd, "session", runId, home).load();
    const tree = buildWorkflowPhaseTree(buildWorkflowPhaseModel(run, loaded));
    const expanded = workflowPhaseTreeInitialExpanded(tree);
    const ordered = workflowPhaseTreeVisibleNodes(tree, new Set(tree.nodes.map(({ id }) => id)));
    const mine = nodes.filter(({ key }) => key === `run:${runId}` || key.startsWith(`run:${runId}:`));
    assert.equal(mine.length, ordered.length, runId);
    assert.ok(ordered.length > 5, "phases, operation scopes and agents");
    ordered.forEach((treeNode, index) => {
      const node = mine[index];
      assert.ok(node);
      if (treeNode.kind === "workflow") {
        assert.deepEqual([node.depth, node.initiallyExpanded], [0, runId === "run-live"], runId);
        return;
      }
      const depth = treeNode.depth + 1;
      assert.equal(node.depth, depth, node.key);
      assert.equal(node.initiallyExpanded, expanded.has(treeNode.id), node.key);
      for (const [selected, open] of [[false, false], [true, true], [false, true]] as const) assert.equal(node.line(TAGGED, selected, open), formatWorkflowTreeLine({ ...treeNode, depth }, selected, open, TAGGED), node.key);
    });
  }
});

void test("labels, phase names and operation scopes are display text", async () => {
  const { home, cwd } = project("session-agents");
  const phased = launch({ phases: ["re\u001b[31mview"] });
  await createRun({ home, cwd }, "run", "running", { workflowName: "flow\u0007", agents: [agent("api", "api", "running", [attempt(1, "api-1")], { structuralPath: ["p\u001b]0;title\u0007"] })], phaseHistory: [{ phase: "re\u001b[31mview", afterAgent: 0 }] }, phased);
  setCreatedAt(new RunStore(cwd, "session", "run", home), new Date(Date.now() + 3_600_000).toISOString());
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list();
  const lines = nodes.map((node) => node.line(PLAIN, false, true));
  assert.deepEqual(lines, ["  ▾ flow  run  ⠦ 0/1", "    ▾ review · ⠦", "      ▾ p · ⠦", "        • api · ⠦"]);
  const text = nodes.flatMap((node) => [node.line(PLAIN, false, true), node.title(PLAIN), ...node.details(PLAIN, Date.now())]).join("\n");
  // Every control character but the line breaks joining the lines above, built as utils.ts builds its own.
  const control = new RegExp(`[${String.fromCharCode(0)}-${String.fromCharCode(9)}${String.fromCharCode(11)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]`);
  assert.doesNotMatch(text, control, "no control character, escape sequences included");
  assert.match(text, /Selected workflow: flow /);
  assert.match(text, /Selected operation: p/);
  // The keys keep the run's own ids.
  assert.equal(nodes[2]?.key, `run:run:node:phase/re${encodeURIComponent("\u001b[31m")}view%231/operation/${encodeURIComponent("p\u001b]0;title\u0007")}`);
});

void test("does not list runs of another Pi session or another project", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "run-other-session", "running", { workflowName: "other", sessionId: "other-session", agents: [agent("a", "a", "running", [attempt(1, "a-1")])] });
  await createRun({ home, cwd: join(home, "other-project") }, "run-other-project", "running", { workflowName: "other", agents: [agent("b", "b", "running", [attempt(1, "b-1")])] });
  await createRun({ home, cwd }, "run-mine", "running", { workflowName: "mine", agents: [agent("c", "c", "running", [attempt(1, "c-1")])] });
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list();
  assert.deepEqual(nodes.map(({ key }) => key), ["run:run-mine", "run:run-mine:node:phase/unassigned", "run:run-mine:c"]);
});

void test("skips an unreadable run", async () => {
  const { home, cwd } = project("session-agents");
  const broken = await createRun({ home, cwd }, "run-broken", "running", { workflowName: "broken", agents: [agent("a", "a", "running", [attempt(1, "a-1")])] });
  writeFileSync(join(broken.directory, "state.json"), "{");
  await createRun({ home, cwd }, "run-good", "running", { workflowName: "good", agents: [agent("b", "b", "running", [attempt(1, "b-1")])] });
  const agents = agentsOf(await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list());
  assert.deepEqual(agents.map(({ key }) => key), ["run:run-good:b"]);
});

void test("keeps a run whose journal cannot be read, sorted as not yet settled", async () => {
  const { home, cwd } = project("session-agents");
  setTerminalAt(await createRun({ home, cwd }, "run-settled", "completed", { workflowName: "settled", agents: [agent("a", "a", "completed", [attempt(1, "a-1")])] }), "2026-06-01T00:00:00.000Z");
  // Settled before run-settled: with a readable journal it would sort after it.
  const corrupt = await createRun({ home, cwd }, "run-corrupt", "completed", { workflowName: "corrupt", agents: [agent("b", "b", "completed", [attempt(1, "b-1")])] });
  setTerminalAt(corrupt, "2026-01-01T00:00:00.000Z");
  writeFileSync(join(corrupt.directory, "journal.json"), "{");
  const agents = agentsOf(await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list());
  assert.deepEqual(agents.map(({ key }) => key), ["run:run-corrupt:b", "run:run-settled:a"]);
  assert.deepEqual(agents[0]?.session, attempt(1, "b-1").session);
});

void test("a parentId cycle ends as the /workflow tree ends it", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "run", "running", { workflowName: "cycle", agents: [
    agent("a", "a", "running", [attempt(1, "a-1")], { parentId: "b" }),
    agent("b", "b", "running", [attempt(1, "b-1")], { parentId: "a" }),
  ] });
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list();
  assert.deepEqual(nodes.filter(({ kind }) => kind === "agent").map(({ key, parentKey, depth }) => ({ key, parentKey, depth })), [
    { key: "run:run:b", parentKey: "run:run:node:phase/unassigned", depth: 2 },
    { key: "run:run:a", parentKey: "run:run:b", depth: 3 },
  ]);
});

void test("returns the live session only when its reference names the latest attempt's session", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "run", "running", { workflowName: "live", agents: [
    agent("matching", "matching", "running", [attempt(1, "m-1"), attempt(2, "m-2")]),
    agent("stale", "stale", "running", [attempt(1, "s-1"), attempt(2, "s-2")]),
    agent("transport", "transport", "running", [attempt(1, "t-1")]),
  ] });
  const sessions: Readonly<Record<string, WorkflowAgentSession>> = { matching: liveSession("m-2"), stale: liveSession("s-1"), transport: liveSession("t-1", "herdr") };
  const asked: string[] = [];
  const agents = agentsOf(await createSessionAgentsSource(commandContext(cwd), dependencies(home, { liveAgent: (runId, agentId) => { asked.push(`${runId}:${agentId}`); return sessions[agentId]; } })).list());
  assert.deepEqual(asked.sort(), ["run:matching", "run:stale", "run:transport"]);
  const byId = new Map(agents.map((record) => [record.key, record]));
  assert.equal(byId.get("run:run:matching")?.live, sessions.matching);
  assert.equal(byId.get("run:run:stale")?.live, undefined, "a session of the previous attempt is not this attempt's");
  assert.deepEqual(byId.get("run:run:stale")?.session, attempt(2, "s-2").session);
  assert.equal(byId.get("run:run:transport")?.live, undefined, "another transport is another session");
});

void test("lists the subagents of this session after the runs and owns only those whose inspected record names this session, a safe id and this project", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "run", "running", { workflowName: "flow", agents: [agent("a", "a", "running", [attempt(1, "a-1")])] });
  const accounting = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0.25 };
  const row = (id: string, state: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, sessionId: "session", state, startedAt: 1, attempts: 1, progress: { accounting, toolCalls: [] }, ...extra });
  const detailed = (id: string, state: string, extra: Record<string, unknown> = {}): Record<string, unknown> => row(id, state, { attemptDetails: [attempt(1, `${id}-1`, cwd)], ...extra });
  // Ids are not UUIDs: the owner check is the /subagents dashboard's safe-id check, not the manager's id format.
  const listed = [
    row("run-owned", "running"),
    row("run-other", "completed", { finishedAt: 30 }),
    row("bad/id", "failed", { finishedAt: 20 }),
    row("run-elsewhere", "stopped", { finishedAt: 40 }),
    row("run-here", "completed", { finishedAt: 10 }),
    row("run-nosession", "running"),
    row("run-foreign", "running", { sessionId: "other-session" }),
  ];
  const ownedLive = liveSession("run-owned-2");
  const manager = fakeManager(listed, {
    "run-owned": detailed("run-owned", "running", { progress: { accounting, toolCalls: [], state: { model: { provider: "fixture", model: "model", thinking: "low" }, tools: [] }, activity: { kind: "tool", text: "read" } } }),
    // The list row names this session; the record read for the agent names another one.
    "run-other": detailed("run-other", "completed", { finishedAt: 30, sessionId: "other-session" }),
    "bad/id": detailed("bad/id", "failed", { finishedAt: 20 }),
    "run-elsewhere": detailed("run-elsewhere", "stopped", { finishedAt: 40, cwd: join(home, "elsewhere"), progress: { accounting, toolCalls: [{ id: "call", name: "bash", state: "running" }], activity: { kind: "tool", text: "stale" } } }),
    "run-here": detailed("run-here", "completed", { finishedAt: 10, cwd: join(cwd, ".") }),
    "run-nosession": row("run-nosession", "running", { attemptDetails: [attempt(1, undefined, cwd)] }),
  }, {
    getAttemptActionData: (id) => {
      if (id === "run-owned") return { attempt: attempt(2, "run-owned-2", join(cwd, "worktree")), liveSession: ownedLive, signal: new AbortController().signal };
      if (id === "run-other") return { attempt: attempt(1, "run-other-1", cwd), liveSession: liveSession("run-other-1"), signal: new AbortController().signal };
      return undefined;
    },
  });
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => manager })).list();
  const keys = ["subagent:run-owned", "subagent:run-nosession", "subagent:run-elsewhere", "subagent:run-other", "subagent:bad/id", "subagent:run-here"];
  assert.deepEqual(nodes.map(({ key, parentKey, depth, kind, initiallyExpanded }) => [key, parentKey, depth, kind, initiallyExpanded]), [
    ["run:run", undefined, 0, "run", true],
    ["run:run:node:phase/unassigned", "run:run", 1, "phase", true],
    ["run:run:a", "run:run:node:phase/unassigned", 2, "agent", false],
    ["subagents", undefined, 0, "group", true],
    ...keys.map((key) => [key, "subagents", 1, "agent", false]),
  ]);
  // What the sidebar filter matches: the label each row draws, the node's own state, and the run or agent ID.
  assert.deepEqual(nodes.map(({ label, state, id }) => [label, state, id]), [
    ["flow run", "running", "run"], ["Unassigned", "running", undefined], ["a", "running", "a"], ["Subagents", "running", undefined],
    ["run-owned", "running", "run-owned"], ["run-nose", "running", "run-nosession"], ["run-else", "stopped", "run-elsewhere"], ["run-other", "completed", "run-other"], ["bad/id", "failed", "bad/id"], ["run-here", "completed", "run-here"],
  ]);
  const [group, ...children] = nodes.slice(3);
  assert.ok(group);
  // The group's row is a header with the counts and cost of its details; its details are the /subagents header and it takes
  // the state the /subagents order puts first.
  assert.equal(group.line(PLAIN, true, true), "→ ▾ Subagents  2 running · 1 failed · 1 stopped · 2 completed · $1.50");
  assert.equal(group.line(PLAIN, false, false), "  ▸ Subagents  2 running · 1 failed · 1 stopped · 2 completed · $1.50");
  const groupDetails = group.details(PLAIN, Date.now(), 64);
  assert.deepEqual(groupDetails.slice(0, 3), ["Subagents", "2 running · 1 failed · 1 stopped · 2 completed · $1.50", ""]);
  assert.match(groupDetails[3] ?? "", /^Timeline {2}0s ── /);
  assert.equal(groupDetails.length, 4 + 6, "one timeline row per subagent");
  assert.equal(group.title(PLAIN), "Subagents running");
  assert.equal(group.agent, undefined);
  // The rows of the /subagents list, one level down.
  assert.deepEqual(children.map((node) => node.line(PLAIN, false, false)), ["    • run-owned · ⠦", "    • run-nose · ⠦", "    • run-else · ✗", "    • run-other · ✓", "    • bad/id · ✗", "    • run-here · ✓"]);
  assert.deepEqual(children.map((node) => node.details(PLAIN, Date.now())), children.map(() => []));
  const agents = agentsOf(nodes);
  assert.deepEqual(agents.map(({ key }) => key), ["run:run:a", ...keys]);
  const subagents = agents.slice(1);
  assert.deepEqual(subagents.map(({ owned }) => owned), [true, true, false, false, false, true]);
  const listContext = manager.contexts[0];
  assert.equal(listContext?.includeAttemptMetadata, undefined, "the list is read without attempt metadata");
  assert.ok(manager.contexts.slice(1).every((context) => context.includeAttemptMetadata === true && context.includeActivity === true), "each agent is inspected with attempt metadata and activity");
  const [owned, noSession, elsewhere, other] = subagents;
  assert.ok(owned && noSession && elsewhere && other);
  assert.equal(owned.name, "run-owned");
  assert.equal(owned.state, "running");
  assert.equal(owned.running, true);
  assert.equal(owned.summary, "model:low 1.5kt $0.25");
  assert.equal(owned.activity, "read");
  assert.equal(owned.attempt, 2, "the attempt running in this process");
  assert.deepEqual(owned.session, attempt(2, "run-owned-2").session);
  assert.equal(owned.cwd, join(cwd, "worktree"));
  assert.equal(owned.live, ownedLive);
  assert.equal(noSession.session, undefined, "an agent whose session cannot be read still appears");
  assert.equal(noSession.attempt, 1);
  assert.equal(elsewhere.summary, "gpt 1.5kt $0.25", "the attempt's model without live progress state");
  assert.equal(elsewhere.running, false);
  assert.equal(elsewhere.activity, undefined, "a stopped subagent shows no activity, even with a stale one recorded");
  assert.equal(other.live, undefined, "an agent that is not owned has no live stream");
});

void test("a subagent whose inspection fails or returns no status stays listed without an owner, and the other agents remain", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "run", "running", { workflowName: "flow", agents: [agent("a", "a", "running", [attempt(1, "a-1")])] });
  const row = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, sessionId: "session", state: "running", startedAt: 1, attempts: 1, progress: { accounting: ZERO, toolCalls: [] }, attemptDetails: [attempt(1, `${id}-1`, cwd)], ...extra });
  const listed = [row("sub-rejects"), row("sub-invalid"), row("sub-ok")];
  // Each one runs in this process with a matching session: only the owner check keeps its stream away.
  const sessions: Readonly<Record<string, WorkflowAgentSession>> = { "sub-rejects": liveSession("sub-rejects-1"), "sub-invalid": liveSession("sub-invalid-1"), "sub-ok": liveSession("sub-ok-1") };
  const base = fakeManager(listed, { "sub-invalid": { id: "sub-invalid", state: "unknown" } }, {
    getAttemptActionData: (id) => { const session = sessions[id]; return session && { attempt: attempt(1, `${id}-1`, cwd), liveSession: session, signal: new AbortController().signal }; },
  });
  const manager: SubagentManager = {
    ...base,
    async inspect(request, context) {
      if (request.id === "sub-rejects") throw new Error("inspection failed");
      return base.inspect(request, context);
    },
  };
  const agents = agentsOf(await createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => manager })).list());
  assert.deepEqual(agents.map(({ key, owned, state }) => ({ key, owned, state })), [
    { key: "run:run:a", owned: true, state: "running" },
    { key: "subagent:sub-rejects", owned: false, state: "running" },
    { key: "subagent:sub-invalid", owned: false, state: "running" },
    { key: "subagent:sub-ok", owned: true, state: "running" },
  ]);
  const byKey = new Map(agents.map((record) => [record.key, record]));
  assert.equal(byKey.get("subagent:sub-rejects")?.live, undefined, "a rejected inspection proves no owner");
  assert.equal(byKey.get("subagent:sub-invalid")?.live, undefined, "an inspection without a status proves no owner");
  assert.equal(byKey.get("subagent:sub-ok")?.live, sessions["sub-ok"]);
});

void test("a custom storageDir changes nothing: a real manager's run of this session is owned", async () => {
  const { home, cwd } = project("session-agents");
  const storageDir = join(home, "custom", "subagents");
  const id = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const otherId = "1f1e1d1c-1b1a-4918-8716-151413121110";
  for (const [runId, sessionId] of [[id, "session"], [otherId, "other-session"]] as const) {
    mkdirSync(join(storageDir, runId), { recursive: true });
    writeFileSync(join(storageDir, runId, "status.json"), JSON.stringify({ id: runId, sessionId, state: "stopped", startedAt: 1, finishedAt: 2, attempts: 1, attemptDetails: [attempt(1, `${runId}-1`, cwd)], progress: { accounting: ZERO, toolCalls: [] } }));
  }
  const manager = createSubagentManager({ agentDir: join(home, "agent"), storageDir });
  try {
    const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => manager })).list();
    assert.deepEqual(nodes.map(({ key }) => key), ["subagents", `subagent:${id}`], "the group, without workflow runs");
    const agents = agentsOf(nodes);
    assert.deepEqual(agents.map(({ key, owned, attempt: number, state }) => ({ key, owned, attempt: number, state })), [{ key: `subagent:${id}`, owned: true, attempt: 1, state: "stopped" }]);
    assert.deepEqual(agents[0]?.session, attempt(1, `${id}-1`).session);
    assert.equal(agents[0]?.name, "0f0e0d0c", "an id longer than 12 characters shows its first 8");
    assert.equal(agents[0].cwd, cwd);
  } finally {
    await manager.dispose?.();
  }
});

void test("without a subagent manager, or without subagents of this session, there is no Subagents group", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "run", "running", { workflowName: "flow", agents: [agent("a", "a", "running", [attempt(1, "a-1")])] });
  const keys = ["run:run", "run:run:node:phase/unassigned", "run:run:a"];
  const without = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => undefined })).list();
  assert.deepEqual(without.map(({ key }) => key), keys);
  const foreign = fakeManager([{ id: "run-foreign", sessionId: "other-session", state: "running", startedAt: 1, attempts: 1, progress: { accounting: ZERO, toolCalls: [] } }]);
  const others = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => foreign })).list();
  assert.deepEqual(others.map(({ key }) => key), keys);
});

void test("the Subagents group's row is a header with its counts and cost, and the group starts expanded only while one of its subagents runs", async () => {
  const { home, cwd } = project("session-agents");
  const row = (id: string, state: string, cost: number, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, sessionId: "session", state, startedAt: 1, attempts: 1, progress: { accounting: { ...ZERO, cost }, toolCalls: [] }, ...extra });
  const group = async (listed: readonly Record<string, unknown>[]): Promise<SessionTreeNode> => {
    const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => fakeManager(listed) })).list();
    const found = nodes.find(({ key }) => key === "subagents");
    assert.ok(found);
    return found;
  };
  const idle = await group([row("sub-done", "completed", 0.25, { finishedAt: 2 }), row("sub-failed", "failed", 0, { finishedAt: 3 })]);
  assert.equal(idle.initiallyExpanded, false, "no subagent runs");
  assert.equal(idle.line(TAGGED, false, false), "  ▸ <bold>Subagents</bold>  1 failed · 1 completed · $0.25");
  assert.equal(idle.line(PLAIN, true, true), "→ ▾ Subagents  1 failed · 1 completed · $0.25");
  assert.equal(idle.details(PLAIN, Date.now())[1], "1 failed · 1 completed · $0.25", "the counts and cost of its details");
  const busy = await group([row("sub-done", "completed", 0, { finishedAt: 2 }), row("sub-running", "running", 0)]);
  assert.equal(busy.initiallyExpanded, true, "a subagent runs");
  assert.equal(busy.line(PLAIN, false, true), "  ▾ Subagents  1 running · 1 completed");
});

void test("the Subagents group takes a summary state: running while one runs, else failed if one failed, else done", async () => {
  const { home, cwd } = project("session-agents");
  const row = (id: string, state: string): Record<string, unknown> => ({ id, sessionId: "session", state, startedAt: 1, finishedAt: state === "running" ? undefined : 2, attempts: 1, progress: { accounting: ZERO, toolCalls: [] } });
  const title = async (states: readonly string[]): Promise<string> => {
    const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => fakeManager(states.map((state, index) => row(`sub-${String(index)}`, state))) })).list();
    return nodes.find(({ key }) => key === "subagents")?.title(PLAIN) ?? "";
  };
  assert.equal(await title(["completed", "failed", "running"]), "Subagents running");
  assert.equal(await title(["completed", "failed", "stopped"]), "Subagents failed");
  assert.equal(await title(["stopped", "completed"]), "Subagents completed", "a stopped subagent beside a finished one does not make the group stopped");
  assert.equal(await title(["stopped"]), "Subagents stopped");
});

void test("a run that has reached a terminal state is read once: a later list reuses the time it settled", async () => {
  const { home, cwd } = project("session-agents");
  const a = await createRun({ home, cwd }, "run-a", "completed", { workflowName: "flow", agents: [agent("a", "a", "completed", [attempt(1, "a-1")])] });
  const b = await createRun({ home, cwd }, "run-b", "completed", { workflowName: "flow", agents: [agent("b", "b", "completed", [attempt(1, "b-1")])] });
  const order = async (source: ReturnType<typeof createSessionAgentsSource>): Promise<string[]> => (await source.list()).filter(({ kind }) => kind === "run").map(({ key }) => key);
  setTerminalAt(a, "2026-01-02T00:00:00.000Z");
  setTerminalAt(b, "2026-01-01T00:00:00.000Z");
  const source = createSessionAgentsSource(commandContext(cwd), dependencies(home));
  const first = await order(source);
  setTerminalAt(a, "2025-01-01T00:00:00.000Z");
  assert.deepEqual(await order(source), first, "the settled time is not read again");
  const before = (await source.list()).map(({ key, agent }) => [key, agent?.state]);
  writeFileSync(join(a.directory, "snapshot.json"), "{ not json");
  writeFileSync(join(b.directory, "snapshot.json"), "{ not json");
  assert.deepEqual((await source.list()).map(({ key, agent }) => [key, agent?.state]), before, "a settled run's snapshot is not read again");
  assert.equal((await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list()).some(({ key }) => key === "run:run-a"), false, "a new source reads the damaged file");
  assert.notDeepEqual(await order(createSessionAgentsSource(commandContext(cwd), dependencies(home))), first, "a new source reads the file");
});

void test("a cached settled run still goes through the host's overlay on every list", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "run-a", "completed", { workflowName: "flow", agents: [agent("a", "a", "completed", [attempt(1, "a-1")])] });
  let label = "first";
  const overlaid: string[] = [];
  const source = createSessionAgentsSource(commandContext(cwd), dependencies(home, {
    overlayRun: (run: PersistedRun) => { overlaid.push(run.id); return { ...run, workflowName: label }; },
  }));
  const title = async (): Promise<string | undefined> => (await source.list()).find(({ key }) => key === "run:run-a")?.title(PLAIN);
  assert.match(await title() ?? "", /first/);
  label = "second";
  assert.match(await title() ?? "", /second/, "the cached run shows the overlay of this list, not the first one");
  assert.deepEqual(overlaid, ["run-a", "run-a"]);
});

void test("a settled run whose summary.json is older than its state.json or journal.json is read again until the summary is current", async () => {
  const { home, cwd } = project("session-agents");
  const a = await createRun({ home, cwd }, "run-a", "completed", { workflowName: "flow", agents: [agent("a", "a", "completed", [attempt(1, "a-1")])] });
  const b = await createRun({ home, cwd }, "run-b", "completed", { workflowName: "flow", agents: [agent("b", "b", "completed", [attempt(1, "b-1")])] });
  const old = Date.now() / 1000 - 100;
  utimesSync(join(a.directory, "summary.json"), old, old);
  setTerminalAt(b, "2026-01-01T00:00:00.000Z");
  setTerminalAt(a, "2026-01-02T00:00:00.000Z");
  utimesSync(join(a.directory, "summary.json"), old, old);
  const source = createSessionAgentsSource(commandContext(cwd), dependencies(home));
  const order = async (): Promise<string[]> => (await source.list()).filter(({ kind }) => kind === "run").map(({ key }) => key);
  const stale = await order();
  setTerminalAt(a, "2025-01-01T00:00:00.000Z");
  utimesSync(join(a.directory, "summary.json"), old, old);
  assert.notDeepEqual(await order(), stale, "a stale summary was not cached");
  const now = Date.now() / 1000 + 10;
  utimesSync(join(a.directory, "summary.json"), now, now);
  const current = await order();
  setTerminalAt(a, "2026-06-01T00:00:00.000Z");
  utimesSync(join(a.directory, "summary.json"), now, now);
  assert.deepEqual(await order(), current, "a current summary is cached");
});

void test("a settled run whose journal.json is newer than its summary.json is not cached, though the summary is newer than state.json", async () => {
  const { home, cwd } = project("session-agents");
  const a = await createRun({ home, cwd }, "run-a", "completed", { workflowName: "flow", agents: [agent("a", "a", "completed", [attempt(1, "a-1")])] });
  const b = await createRun({ home, cwd }, "run-b", "completed", { workflowName: "flow", agents: [agent("b", "b", "completed", [attempt(1, "b-1")])] });
  setTerminalAt(b, "2026-01-01T00:00:00.000Z");
  setTerminalAt(a, "2026-01-02T00:00:00.000Z");
  const base = Date.now() / 1000;
  utimesSync(join(a.directory, "state.json"), base - 30, base - 30);
  utimesSync(join(a.directory, "summary.json"), base - 20, base - 20);
  utimesSync(join(a.directory, "journal.json"), base - 10, base - 10);
  const source = createSessionAgentsSource(commandContext(cwd), dependencies(home));
  const order = async (): Promise<string[]> => (await source.list()).filter(({ kind }) => kind === "run").map(({ key }) => key);
  const first = await order();
  setTerminalAt(a, "2020-01-01T00:00:00.000Z");
  utimesSync(join(a.directory, "summary.json"), base - 20, base - 20);
  assert.notDeepEqual(await order(), first, "the stale summary was read again");
});

void test("a run resumed after it was cached is read again: state.json is read on every list", async () => {
  const { home, cwd } = project("session-agents");
  const store = await createRun({ home, cwd }, "run-a", "completed", { workflowName: "flow", agents: [agent("a", "a", "completed", [attempt(1, "a-1")])] });
  const source = createSessionAgentsSource(commandContext(cwd), dependencies(home));
  const expanded = async (): Promise<boolean | undefined> => (await source.list()).find(({ key }) => key === "run:run-a")?.initiallyExpanded;
  assert.equal(await expanded(), false);
  await store.saveState({ ...(await store.load()).run, state: "running" });
  assert.equal(await expanded(), true);
});

void test("an unsettled run is read once while its state and journal are unchanged; its runtime and overlay are of each list", async () => {
  const { home, cwd } = project("session-agents");
  const store = await createRun({ home, cwd }, "run-a", "running", { workflowName: "flow", agents: [agent("a", "a", "running", [attempt(1, "a-1")])] });
  setCreatedAt(store, new Date(Date.now() - 7_200_000).toISOString());
  const base = Date.now() / 1000;
  for (const name of ["state.json", "journal.json"]) utimesSync(join(store.directory, name), base - 30, base - 30);
  // An older summary.json keeps a settled run from the cache, not an unsettled one.
  utimesSync(join(store.directory, "summary.json"), base - 100, base - 100);
  let label = "first";
  const source = createSessionAgentsSource(commandContext(cwd), dependencies(home, { overlayRun: (run) => ({ ...run, workflowName: label }) }));
  const root = async (): Promise<string | undefined> => (await source.list()).find(({ key }) => key === "run:run-a")?.line(PLAIN, false, true);
  assert.equal(await root(), "  ▾ first run-a  ⠦ 0/1 2h");
  const snapshotPath = join(store.directory, "snapshot.json");
  const intact = readFileSync(snapshotPath, "utf8");
  writeFileSync(snapshotPath, "{ not json");
  label = "second";
  assert.equal(await root(), "  ▾ second run-a  ⠦ 0/1 2h", "not read again: the overlay and the runtime of this list");
  for (const [name, at] of [["state.json", 25], ["journal.json", 20]] as const) {
    utimesSync(join(store.directory, name), base - at, base - at);
    assert.equal(await root(), undefined, `a changed ${name} is read again`);
    writeFileSync(snapshotPath, intact);
    assert.equal(await root(), "  ▾ second run-a  ⠦ 0/1 2h", "a run that could not be read is not kept");
    writeFileSync(snapshotPath, "{ not json");
  }
});

void test("an agent id that starts like a tree node's key part gets its own key, and no two ids share one", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "run", "completed", { workflowName: "flow", agents: [agent("node:phase/unassigned", "x", "completed", [attempt(1, "x-1")]), agent("~node:phase/unassigned", "y", "completed", [attempt(1, "y-1")]), agent("plain", "z", "completed", [attempt(1, "z-1")])] });
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list();
  const keys = nodes.map(({ key }) => key);
  assert.equal(new Set(keys).size, keys.length, keys.join(", "));
  for (const node of nodes) assert.ok(node.parentKey === undefined || keys.includes(node.parentKey), node.key);
  assert.deepEqual(nodes.flatMap(({ target }) => target?.kind === "workflow-agent" ? [target.agentId] : []).sort(), ["node:phase/unassigned", "plain", "~node:phase/unassigned"]);
  const agentNodes = nodes.filter(({ target }) => target?.kind === "workflow-agent");
  assert.equal(agentNodes.length, 3);
  for (const node of agentNodes) assert.equal(node.agent?.key, node.key);
});

void test("the Subagents group's timeline starts and ends at the subagents' status times", async () => {
  const { home, cwd } = project("session-agents");
  const T = 1_000_000;
  const row = (id: string, state: string, extra: Record<string, unknown>): Record<string, unknown> => ({ id, sessionId: "session", state, attempts: 1, progress: { accounting: ZERO, toolCalls: [] }, ...extra });
  const manager = fakeManager([row("sub-done", "completed", { startedAt: T, finishedAt: T + 20_000 }), row("sub-live", "running", { startedAt: T + 10_000 })]);
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => manager })).list();
  const lines = nodes.find(({ key }) => key === "subagents")?.details(PLAIN, T + 30_000, 64) ?? [];
  assert.equal(lines[3], "Timeline  0s ── 30s");
  const done = lines.find((line) => line.includes("sub-done")) ?? "";
  const live = lines.find((line) => line.includes("sub-live")) ?? "";
  assert.match(done, /20s ✓$/);
  assert.match(live, /20s ⠦$/);
  const cells = (line: string): string => /sub-\w+\s(.*)\s+\d+s /.exec(line)?.[1] ?? "";
  assert.ok(cells(done).startsWith("█") && cells(live).startsWith(" "), "the later start sits further right");
  assert.ok(cells(live).trimEnd().length > cells(done).trimEnd().length - 1);
});

void test("the workflows scope lists only the runs and the subagents scope only the Subagents group, without reading the other side", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "run", "running", { workflowName: "flow", agents: [agent("a", "a", "running", [attempt(1, "a-1")])] });
  const row = { id: "sub", sessionId: "session", state: "running", startedAt: 1, attempts: 1, progress: { accounting: ZERO, toolCalls: [] } };
  const list = async (scope?: "all" | "workflows" | "subagents"): Promise<{ keys: string[]; overlaid: string[]; inspections: number; described: number }> => {
    const manager = fakeManager([row]);
    const overlaid: string[] = [];
    const described: (readonly string[])[] = [];
    const deps = dependencies(home, { overlayRun: (run) => { overlaid.push(run.id); return run; }, subagents: () => manager, subagentPresenter: () => fakePresenter({ sub: "named" }, described) });
    const nodes = await createSessionAgentsSource(commandContext(cwd), deps, scope).list();
    return { keys: nodes.map(({ key }) => key), overlaid, inspections: manager.contexts.length, described: described.length };
  };
  const runKeys = ["run:run", "run:run:node:phase/unassigned", "run:run:a"];
  const subagentKeys = ["subagents", "subagent:sub"];
  const all = { keys: [...runKeys, ...subagentKeys], overlaid: ["run"], inspections: 2, described: 1 };
  assert.deepEqual(await list(), all, "the default scope lists both");
  assert.deepEqual(await list("all"), all);
  assert.deepEqual(await list("workflows"), { keys: runKeys, overlaid: ["run"], inspections: 0, described: 0 }, "no subagent is read or described");
  assert.deepEqual(await list("subagents"), { keys: subagentKeys, overlaid: [], inspections: 2, described: 1 }, "no run is read");
});

void test("every node carries the target its actions apply to, with the run's and the agents' own ids", async () => {
  const { home, cwd } = project("session-agents");
  const phased = launch({ phases: ["plan", "review"] });
  // Keys join ids with ":", so an id with one cannot be read back from its key; the target keeps it whole.
  await createRun({ home, cwd }, "run", "running", { workflowName: "flow\u001b[31m", agents: [
    agent("planner", "planner", "completed", [attempt(1, "planner-1")]),
    agent("api:1", "api", "running", [attempt(1, "api-1")], { structuralPath: ["p"] }),
  ], phase: "review", phaseHistory: [{ phase: "plan", afterAgent: 0 }, { phase: "review", afterAgent: 1 }] }, phased);
  const overlayRun = (run: PersistedRun): PersistedRun => ({ ...run, activeShellsByPhase: [{ phaseIndex: 1, active: 1, startedAt: Date.now() }] });
  const manager = fakeManager([{ id: "sub:1", sessionId: "session", state: "running", startedAt: 1, attempts: 1, progress: { accounting: ZERO, toolCalls: [] } }]);
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { overlayRun, subagents: () => manager })).list();
  const run = { kind: "run", runId: "run" } as const;
  const review = "run:run:node:phase/review%231";
  assert.deepEqual(nodes.map(({ key, kind, target }) => [key, kind, target]), [
    ["run:run", "run", run],
    ["run:run:node:phase/plan%231", "phase", run],
    ["run:run:planner", "agent", { kind: "workflow-agent", runId: "run", agentId: "planner" }],
    [review, "phase", run],
    [`${review}/shell`, "shell", run],
    [`${review}/operation/p`, "operation", run],
    ["run:run:api:1", "agent", { kind: "workflow-agent", runId: "run", agentId: "api:1" }],
    ["subagents", "group", { kind: "subagents" }],
    ["subagent:sub:1", "agent", { kind: "subagent", id: "sub:1" }],
  ]);
});

void test("a workflow agent's details are /workflow's details of its node, without the enter hints", async () => {
  const { home, cwd } = project("session-agents");
  const now = Date.now();
  const phased = launch({ phases: ["plan", "review"] });
  await createRun({ home, cwd }, "run", "running", { workflowName: "flow", agents: [
    agent("planner", "planner", "completed", [attempt(1, "planner-1")], { label: "Planner", accounting: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0.5 }, startedAt: now - 60_000, durationMs: 20_000 }),
    agent("api", "api", "failed", [attempt(1, "api-1"), { ...attempt(2, "api-2"), error: { code: "E_FAIL", message: "boom" } }], { structuralPath: ["p", "a"], tools: ["read", "bash"], startedAt: now - 30_000 }),
    agent("helper", "helper", "running", [attempt(1, "helper-1")], { parentId: "api", structuralPath: ["p", "a"], model: { ...MODEL, thinking: "high" }, startedAt: now - 5000 }),
  ], phase: "review", phaseHistory: [{ phase: "plan", afterAgent: 0 }, { phase: "review", afterAgent: 1 }] }, phased);
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list();
  const { run, snapshot: loaded } = await new RunStore(cwd, "session", "run", home).load();
  const tree = buildWorkflowPhaseTree(buildWorkflowPhaseModel(run, loaded));
  const agentNodes = tree.nodes.filter(({ kind }) => kind === "agent");
  assert.equal(agentNodes.length, 3);
  for (const treeNode of agentNodes) {
    const node = nodes.find(({ key }) => key === `run:run:${treeNode.agentId ?? ""}`);
    assert.ok(node, treeNode.id);
    assert.deepEqual(node.details(TAGGED, now), formatWorkflowNodeDetails(run, tree, treeNode, TAGGED, now, false), treeNode.id);
  }
  assert.deepEqual(nodes.find(({ key }) => key === "run:run:api")?.details(TAGGED, now), ["State: <error>failed</error>", "Structural path: p > a", "Model: openai/gpt", "Tools: read, bash", "Attempts: 2", "Duration: 30s", "<error>Error: E_FAIL: boom</error>"], "the latest attempt's error last, no enter hint");
});

void test("a workflow agent's details show its strings as display text and keep the styles' escapes", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "run", "running", { workflowName: "flow", agents: [
    agent("api", "api", "failed", [{ ...attempt(1, "api-1"), error: { code: "E\u001b[31m", message: "bad\u0007\nline" } }], { structuralPath: ["p\u001b]0;title\u0007", "q\u0008"], tools: ["read\u001b[2J", "bash"], model: { provider: "open\u0007ai", model: "g\u001b[1mpt" } }),
  ] });
  const overlayRun = (run: PersistedRun): PersistedRun => ({ ...run, agents: run.agents.map((record) => ({ ...record, activity: { kind: "tool", text: "grep\u001b[31m" } })) });
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { overlayRun })).list();
  const red = (text: string): string => `\u001b[31m${text}\u001b[39m`;
  const styles: WorkflowProgressStyles = { ...PLAIN, error: red };
  assert.deepEqual(nodes.find(({ key }) => key === "run:run:api")?.details(styles, Date.now()), [
    "Activity: grep",
    `State: ${red("failed")}`,
    "Structural path: p > q ",
    "Model: open ai/gpt",
    "Tools: read, bash",
    red("Error: E: bad  line"),
  ]);
});

void test("a subagent takes its name and details from the subagents presenter, asked once per list with this session's subagents", async () => {
  const { home, cwd } = project("session-agents");
  const row = (id: string, state: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({ id, sessionId: "session", state, startedAt: 1, attempts: 1, progress: { accounting: ZERO, toolCalls: [] }, ...extra });
  const longId = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const manager = fakeManager([row("sub-named", "running"), row(longId, "completed", { finishedAt: 2 }), row("sub-foreign", "running", { sessionId: "other-session" })]);
  const described: (readonly string[])[] = [];
  // The presenter knows the foreign subagent too, but it is not this session's; it cannot read the long id's request.
  const presenter = fakePresenter({ "sub-named": "review\u001b[31m (sub-name)", "sub-foreign": "foreign" }, described);
  const source = createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => manager, subagentPresenter: () => presenter }));
  const nodes = await source.list();
  assert.deepEqual(described.map((ids) => [...ids].sort()), [[longId, "sub-named"].sort()], "one call, with this session's subagents only");
  const children = nodes.filter(({ parentKey }) => parentKey === "subagents");
  assert.deepEqual(children.map(({ key, agent: shown }) => [key, shown?.name]), [["subagent:sub-named", "review (sub-name)"], [`subagent:${longId}`, "0f0e0d0c"]], "the presentation's name as display text; an id it left out keeps its short id");
  assert.deepEqual(children.map((node) => node.line(PLAIN, false, false)), ["    • review (sub-name) · ⠦", "    • 0f0e0d0c · ✓"]);
  assert.deepEqual(children.map((node) => node.title(PLAIN)), ["review (sub-name) running", "0f0e0d0c completed"]);
  assert.deepEqual(children.map((node) => node.details(TAGGED, 42)), [["<bold>Subagent sub-named</bold>", "at 42"], []], "the presentation's details with the styles and time asked for");
  await source.list();
  assert.equal(described.length, 2, "each list asks again");
});

void test("without a presenter, with a presenter getter that throws, or with a describe() that rejects or throws, a subagent keeps its short id and no details, and the list succeeds", async () => {
  const { home, cwd } = project("session-agents");
  const longId = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const manager = fakeManager(["sub-short", longId].map((id) => ({ id, sessionId: "session", state: "running", startedAt: 1, attempts: 1, progress: { accounting: ZERO, toolCalls: [] } })));
  const rejecting: SubagentPresenter = { describe: async () => { throw new Error("cannot read the requests"); } };
  const throwing: SubagentPresenter = { describe: () => { throw new Error("cannot read the requests"); } };
  const throwingGetter = (): SubagentPresenter | undefined => { throw new Error("no presenter for this context"); };
  for (const [name, subagentPresenter] of [["no dependency", undefined], ["no presenter", () => undefined], ["a presenter getter that throws", throwingGetter], ["a rejecting describe()", () => rejecting], ["a describe() that throws", () => throwing]] as const) {
    const deps = dependencies(home, { subagents: () => manager, ...(subagentPresenter === undefined ? {} : { subagentPresenter }) });
    const nodes = await createSessionAgentsSource(commandContext(cwd), deps).list();
    assert.deepEqual(nodes.map(({ key }) => key), ["subagents", "subagent:sub-short", `subagent:${longId}`], name);
    const children = nodes.slice(1);
    assert.deepEqual(children.map(({ agent: shown }) => shown?.name), ["sub-short", "0f0e0d0c"], name);
    assert.deepEqual(children.map((node) => node.details(PLAIN, Date.now())), [[], []], name);
  }
});

void test("a subagent whose presentation name is blank after sanitizing keeps its short id, as /subagents does with a blank label, and details that throw show none", async () => {
  const { home, cwd } = project("session-agents");
  const longId = "0f0e0d0c-0b0a-4908-8706-050403020100";
  const names: Readonly<Record<string, string>> = { [longId]: "", "sub-bel": "\u0007", "sub-space": "   ", "sub-escape": "\u001b[31m", "sub-padded": "  padded\u0007 " };
  const manager = fakeManager([...Object.keys(names), "sub-broken"].map((id) => ({ id, sessionId: "session", state: "running", startedAt: 1, attempts: 1, progress: { accounting: ZERO, toolCalls: [] } })));
  const presenter: SubagentPresenter = {
    describe: async () => new Map<string, SubagentPresentation>([
      ...Object.entries(names).map(([id, name]): [string, SubagentPresentation] => [id, { name, details: () => ["kept"] }]),
      ["sub-broken", { name: "broken", details: () => { throw new Error("cannot draw"); } }],
    ]),
  };
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => manager, subagentPresenter: () => presenter })).list();
  const children = new Map(nodes.filter(({ parentKey }) => parentKey === "subagents").map((node) => [node.key, node]));
  assert.deepEqual([longId, "sub-bel", "sub-space", "sub-escape", "sub-padded"].map((id) => children.get(`subagent:${id}`)?.agent?.name), ["0f0e0d0c", "sub-bel", "sub-space", "sub-escape", "padded"], "an empty, BEL-only, whitespace-only or escape-only name falls back to the short id; a name is trimmed");
  assert.deepEqual(children.get(`subagent:${longId}`)?.details(PLAIN, 1), ["kept"]);
  assert.equal(children.get("subagent:sub-broken")?.agent?.name, "broken");
  assert.deepEqual(children.get("subagent:sub-broken")?.details(PLAIN, 1), [], "a presenter that throws while drawing shows no details");
});

void test("the presenter is asked for every subagent this Pi session lists with a safe id, whatever its inspection shows, as /subagents names its rows; owned still follows the inspection", async () => {
  const { home, cwd } = project("session-agents");
  const row = (id: string): Record<string, unknown> => ({ id, sessionId: "session", state: "running", startedAt: 1, attempts: 1, progress: { accounting: ZERO, toolCalls: [] } });
  const ids = ["sub-safe", "bad/id", "..", "sub-foreign", "sub-away", "sub-rejected"];
  // The list rows all claim this session; the inspected records name another session and another cwd, and one inspection rejects.
  const base = fakeManager(ids.map(row), { "sub-foreign": { ...row("sub-foreign"), sessionId: "other-session" }, "sub-away": { ...row("sub-away"), cwd: join(cwd, "elsewhere") } });
  const manager: SubagentManager = { ...base, inspect: async (request, context) => request.id === "sub-rejected" ? Promise.reject(new Error("unreadable record")) : base.inspect(request, context) };
  const described: (readonly string[])[] = [];
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => manager, subagentPresenter: () => fakePresenter(Object.fromEntries(ids.map((id) => [id, `named ${id}`])), described) })).list();
  assert.deepEqual(described.map((asked) => [...asked].sort()), [["sub-away", "sub-foreign", "sub-rejected", "sub-safe"]], "one call, with the session-listed safe ids only");
  assert.deepEqual(nodes.filter(({ parentKey }) => parentKey === "subagents").map(({ agent: shown }) => [shown?.name, shown?.owned]).sort(), [
    ["..", false],
    ["bad/id", false],
    ["named sub-away", false],
    ["named sub-foreign", false],
    ["named sub-rejected", false],
    ["named sub-safe", true],
  ]);
});

void test("a presentation for an id the source did not ask for is ignored: the listed row keeps its own id for its key, name, details and target", async () => {
  const { home, cwd } = project("session-agents");
  const row = (id: string, sessionId = "session", state = "running"): Record<string, unknown> => ({ id, sessionId, state, startedAt: 1, attempts: 1, progress: { accounting: ZERO, toolCalls: [] } });
  const manager = fakeManager([row("sub-safe"), row("bad/id"), row(".."), row("sub-other", "other-session"), row("sub-moved")]);
  const described: (readonly string[])[] = [];
  // A presenter that answers for every id it knows, asked or not.
  const presenter: SubagentPresenter = {
    async describe(asked) {
      described.push(asked);
      return new Map(["sub-safe", "bad/id", "..", "sub-other", "sub-moved", "sub-elsewhere"].map((id): [string, SubagentPresentation] => [id, { name: `named ${id}`, details: () => [`details ${id}`] }]));
    },
  };
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => manager, subagentPresenter: () => presenter })).list();
  assert.deepEqual(described.map((asked) => [...asked].sort()), [["sub-moved", "sub-safe"]]);
  const children = nodes.filter(({ parentKey }) => parentKey === "subagents");
  assert.deepEqual(children.map(({ key, agent: shown }) => [key, shown?.key, shown?.name]).sort(), [["subagent:..", "subagent:..", ".."], ["subagent:bad/id", "subagent:bad/id", "bad/id"], ["subagent:sub-moved", "subagent:sub-moved", "named sub-moved"], ["subagent:sub-safe", "subagent:sub-safe", "named sub-safe"]]);
  assert.deepEqual(children.map((node) => [node.key, node.details(PLAIN, 1)]).sort(), [["subagent:..", []], ["subagent:bad/id", []], ["subagent:sub-moved", ["details sub-moved"]], ["subagent:sub-safe", ["details sub-safe"]]]);
  const moved = children.find(({ key }) => key === "subagent:sub-moved");
  assert.ok(moved);
  assert.deepEqual(moved.target, { kind: "subagent", id: "sub-moved" }, "its actions address the listed subagent");
  assert.ok(nodes.every(({ key, agent: shown, target }) => !key.includes("sub-elsewhere") && !shown?.key.includes("sub-elsewhere") && !(target?.kind === "subagent" && target.id === "sub-elsewhere")), "no node names or targets the id the list never named");
});

void test("when no subagent this Pi session lists has a safe id, the presenter is never asked and every row keeps its id", async () => {
  const { home, cwd } = project("session-agents");
  const manager = fakeManager(["bad/id", ".."].map((id) => ({ id, sessionId: "session", state: "running", startedAt: 1, attempts: 1, progress: { accounting: ZERO, toolCalls: [] } })));
  const described: (readonly string[])[] = [];
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => manager, subagentPresenter: () => fakePresenter({ "bad/id": "named bad", "..": "named dots" }, described) })).list();
  assert.deepEqual(described, [], "describe() is not called");
  assert.deepEqual(nodes.map(({ key, agent: shown }) => [key, shown?.name]), [["subagents", undefined], ["subagent:bad/id", "bad/id"], ["subagent:..", ".."]]);
});

void test("workflow agents and subagents carry tokens, cost and their newest activity: the later of the last event and the transcript's last write", async () => {
  const { home, cwd } = project("session-agents");
  const transcript = join(home, "b.jsonl");
  writeFileSync(transcript, "");
  utimesSync(transcript, new Date(9_000_000), new Date(9_000_000));
  const withFile = { ...attempt(1, "b-1"), session: { transport: "local", sessionId: "b-1", locator: { sessionFile: transcript } } };
  await createRun({ home, cwd }, "run", "running", { workflowName: "flow", agents: [
    agent("a", "a", "running", [attempt(1, "a-1")], { accounting: { ...ZERO, input: 100, output: 50, cost: 0.2 }, lastEventAt: 5_000_000 }),
    agent("b", "b", "running", [withFile], { lastEventAt: 5_000_000 }),
    agent("c", "c", "queued", []),
  ] });
  const manager = fakeManager([{ id: "s1", sessionId: "session", state: "running", progress: { accounting: { ...ZERO, input: 7, output: 3, cost: 0.5 }, toolCalls: [], lastEventAt: 123 } }, { id: "s2", sessionId: "session", state: "completed" }]);
  const agents = agentsOf(await createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => manager })).list());
  const by = (key: string): SessionAgent | undefined => agents.find((candidate) => candidate.key === key);
  assert.deepEqual([by("run:run:a")?.tokens, by("run:run:a")?.cost, by("run:run:a")?.lastActivityAt], [150, 0.2, 5_000_000]);
  assert.equal(by("run:run:b")?.lastActivityAt, 9_000_000, "the transcript is newer than the event");
  assert.deepEqual([by("run:run:c")?.tokens, by("run:run:c")?.cost, by("run:run:c")?.lastActivityAt], [undefined, undefined, undefined]);
  assert.deepEqual([by("subagent:s1")?.tokens, by("subagent:s1")?.cost, by("subagent:s1")?.lastActivityAt], [10, 0.5, 123]);
  assert.deepEqual([by("subagent:s2")?.tokens, by("subagent:s2")?.lastActivityAt], [undefined, undefined]);
});

void test("the transcript stat cache lives for one list(): a later list sees a newer write", async () => {
  const { home, cwd } = project("session-agents");
  const transcript = join(home, "a.jsonl");
  writeFileSync(transcript, "");
  utimesSync(transcript, new Date(1_000_000), new Date(1_000_000));
  await createRun({ home, cwd }, "run", "running", { workflowName: "flow", agents: [agent("a", "a", "running", [{ ...attempt(1, "a-1"), session: { transport: "local", sessionId: "a-1", locator: { sessionFile: transcript } } }])] });
  const source = createSessionAgentsSource(commandContext(cwd), dependencies(home));
  assert.equal(agentsOf(await source.list())[0]?.lastActivityAt, 1_000_000);
  utimesSync(transcript, new Date(2_000_000), new Date(2_000_000));
  assert.equal(agentsOf(await source.list())[0]?.lastActivityAt, 2_000_000);
});

void test("a settled workflow agent carries no newest activity: list() stats only the transcripts of agents not settled", async (t) => {
  const { home, cwd } = project("session-agents");
  const states = ["running", "retrying", "completed", "failed", "cancelled"] as const;
  const file = (state: string): string => join(home, `${state}.jsonl`);
  for (const state of states) writeFileSync(file(state), "");
  await createRun({ home, cwd }, "run", "running", { workflowName: "flow", agents: states.map((state) => agent(state, state, state, [{ ...attempt(1, state), session: { transport: "local", sessionId: state, locator: { sessionFile: file(state) } } }], { lastEventAt: 5_000_000 })) });
  const stat = t.mock.method(fs, "statSync");
  syncBuiltinESMExports();
  try {
    const agents = agentsOf(await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list());
    const statted = stat.mock.calls.map(({ arguments: [path] }) => path);
    // Follow takes any agent not settled, so a retrying one keeps its activity.
    assert.deepEqual(states.filter((state) => statted.includes(file(state))), ["running", "retrying"], "only the transcripts of agents not settled");
    assert.deepEqual(states.map((state) => agents.find(({ key }) => key === `run:run:${state}`)?.lastActivityAt !== undefined), [true, true, false, false, false]);
  } finally {
    stat.mock.restore();
    syncBuiltinESMExports();
  }
});

void test("needsPerson and the marks at the end of the rows: quiet and stalled agents and subagents, failed agents and subagents, runs awaiting input or out of budget", async () => {
  const { home, cwd } = project("session-agents");
  const now = Date.now();
  await createRun({ home, cwd }, "wait", "awaiting_input", { workflowName: "waiting", agents: [] });
  await createRun({ home, cwd }, "named", "awaiting_input", { workflowName: "named", agents: [] });
  const named = new RunStore(cwd, "session", "named", home);
  const journalPath = join(named.directory, "journal.json");
  const journal: unknown = JSON.parse(readFileSync(journalPath, "utf8"));
  assert.ok(typeof journal === "object" && journal !== null);
  writeFileSync(journalPath, JSON.stringify({ ...journal, awaiting: { p: { path: "p", name: "ship it?\u001b[31m", prompt: "ok", context: null } } }));
  await createRun({ home, cwd }, "budget", "budget_exhausted", { workflowName: "budgeted", agents: [] });
  await createRun({ home, cwd }, "busy", "running", { workflowName: "busy", agents: [
    agent("fresh", "fresh", "running", [attempt(1, "f")], { lastEventAt: now - 1_000 }),
    agent("quiet", "quiet", "running", [attempt(1, "q")], { lastEventAt: now - 4 * 60_000 - 5_000 }),
    agent("stalled", "stalled", "running", [attempt(1, "s")], { lastEventAt: now - 12 * 60_000 - 5_000 }),
    agent("failed", "failed", "failed", [attempt(1, "x")]),
    agent("done", "done", "completed", [attempt(1, "d")], { lastEventAt: now - 60 * 60_000 }),
  ] });
  const progress = (lastEventAt: number): Record<string, unknown> => ({ progress: { accounting: ZERO, toolCalls: [], lastEventAt } });
  const manager = fakeManager([
    { id: "s1", sessionId: "session", state: "failed" }, { id: "s2", sessionId: "session", state: "completed", ...progress(now - 60 * 60_000) },
    { id: "s3", sessionId: "session", state: "running", ...progress(now - 1_000) }, { id: "s4", sessionId: "session", state: "running", ...progress(now - 4 * 60_000 - 5_000) },
    { id: "s5", sessionId: "session", state: "running", ...progress(now - 12 * 60_000 - 5_000) },
  ]);
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => manager })).list();
  const node = (key: string): SessionTreeNode => { const found = nodes.find((candidate) => candidate.key === key); assert.ok(found, key); return found; };
  assert.deepEqual(["run:wait", "run:named", "run:budget", "run:busy", "run:busy:fresh", "run:busy:quiet", "run:busy:stalled", "run:busy:failed", "run:busy:done", "subagent:s1", "subagent:s2", "subagent:s3", "subagent:s4", "subagent:s5"].map((key) => node(key).needsPerson),
    ["awaiting_input", "awaiting_input", "budget_exhausted", undefined, undefined, "quiet", "stalled", "failed", undefined, "failed", undefined, undefined, "quiet", "stalled"]);
  const mark = (key: string, styles = PLAIN): string => node(key).mark?.(styles) ?? "";
  assert.equal(mark("run:wait"), "  ◆ waiting");
  assert.equal(mark("run:named"), "  ◆ waiting: ship it?");
  assert.equal(mark("run:named", TAGGED), "<warning>  ◆ waiting: ship it?</warning>");
  assert.equal(mark("run:busy:quiet"), "  ⚠ quiet 4m");
  assert.equal(mark("run:busy:stalled"), "  ⚠ stalled 12m");
  assert.equal(mark("run:busy:quiet", TAGGED), "<warning>  ⚠ quiet 4m</warning>");
  assert.equal(mark("run:busy:stalled", TAGGED), "<error>  ⚠ stalled 12m</error>");
  assert.equal(mark("subagent:s4", TAGGED), "<warning>  ⚠ quiet 4m</warning>");
  assert.equal(mark("subagent:s5", TAGGED), "<error>  ⚠ stalled 12m</error>");
  for (const key of ["run:budget", "run:busy:fresh", "run:busy:failed", "subagent:s2", "subagent:s3"]) assert.equal(mark(key), "", key);
  // The rows carry no mark: the sidebar draws it after the row only where it fits whole.
  for (const key of ["run:named", "run:busy:quiet", "subagent:s5"]) assert.doesNotMatch(node(key).line(PLAIN, false, true), /◆|⚠/, key);
});

void test("an agent left running in a crashed run is not running: the widget's quiet dot, no quiet mark, no needsPerson, no follow activity", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "crashed", "interrupted", { workflowName: "crashed", agents: [agent("stuck", "stuck", "running", [attempt(1, "k")], { lastEventAt: Date.now() - 12 * 60_000 })] });
  await createRun({ home, cwd }, "live", "running", { workflowName: "live", agents: [agent("busy", "busy", "running", [attempt(1, "b")])] });
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list();
  const stuck = nodes.find(({ key }) => key === "run:crashed:stuck");
  assert.ok(stuck?.agent);
  assert.equal(stuck.agent.running, false);
  assert.equal(stuck.agent.lastActivityAt, undefined);
  assert.equal(stuck.needsPerson, undefined);
  assert.equal(stuck.mark?.(PLAIN) ?? "", "");
  assert.equal(stuck.line(TAGGED, false, false), "      • stuck · <muted>·</muted>", "no spinner: the widget's mark for a running agent of a run that is not running");
  assert.equal(nodes.find(({ key }) => key === "run:live:busy")?.line(TAGGED, false, false), "      • busy · <accent>⠦</accent>", "an agent of a running run keeps the spinner");
});

void test("an agent running in a run awaiting input is still running: parallel agents go on", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "waiting", "awaiting_input", { workflowName: "waiting", agents: [agent("busy", "busy", "running", [attempt(1, "k")], { lastEventAt: Date.now() - 4 * 60_000 })] });
  const busy = (await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list()).find(({ key }) => key === "run:waiting:busy");
  assert.equal(busy?.agent?.running, true);
  assert.equal(busy.needsPerson, "quiet");
});

for (const [state, live] of [["running", true], ["pausing", true], ["awaiting_input", true], ["paused", false], ["budget_exhausted", false], ["interrupted", false], ["completed", false], ["failed", false], ["stopped", false]] as const) {
  void test(`an agent recorded running in a ${state} run is ${live ? "live: running, with its quiet mark" : "not live: not running, no quiet mark, the quiet dot"}`, async () => {
    const { home, cwd } = project("session-agents");
    await createRun({ home, cwd }, "r", state, { workflowName: "flow", agents: [agent("busy", "busy", "running", [attempt(1, "k")], { lastEventAt: Date.now() - 4 * 60_000 })] });
    const busy = (await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list()).find(({ key }) => key === "run:r:busy");
    assert.equal(busy?.agent?.running, live);
    assert.equal(busy.needsPerson, live ? "quiet" : undefined);
    assert.equal(busy.line(TAGGED, false, false).includes("<muted>·</muted>"), !live);
  });
}

for (const [state, live] of [["running", true], ["pausing", true], ["awaiting_input", true], ["paused", false], ["budget_exhausted", false], ["interrupted", false], ["completed", false], ["failed", false], ["stopped", false]] as const) {
  void test(`the details of an agent recorded running in a ${state} run ${live ? "say stalled and keep counting its duration" : "say neither stalled nor a duration that grows"}`, async () => {
    const { home, cwd } = project("session-agents");
    const now = Date.now();
    await createRun({ home, cwd }, "r", state, { workflowName: "flow", agents: [agent("busy", "busy", "running", [attempt(1, "k")], { startedAt: now - 3_600_000, lastEventAt: now - 12 * 60_000 })] });
    const busy = (await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list()).find(({ key }) => key === "run:r:busy");
    assert.ok(busy);
    const duration = (time: number): string | undefined => busy.details(PLAIN, time).find((line) => line.startsWith("Duration:"));
    assert.equal(busy.details(PLAIN, now).some((line) => line.startsWith("stalled?")), live, busy.details(PLAIN, now).join("\n"));
    assert.equal(duration(now) !== undefined, live, busy.details(PLAIN, now).join("\n"));
    assert.equal(duration(now + 60_000) !== duration(now), live);
  });
}

for (const [state, live] of [["running", true], ["interrupted", false], ["paused", false]] as const) {
  void test(`the run, phase and operation details of an agent recorded running in a ${state} run ${live ? "keep counting its time" : "count nothing from it: Elapsed does not grow"}`, async () => {
    const { home, cwd } = project("session-agents");
    const now = Date.now();
    await createRun({ home, cwd }, "run", state, { workflowName: "flow", agents: [
      agent("done", "done", "completed", [attempt(1, "d")], { structuralPath: ["p", "a"], startedAt: now - 3_600_000, durationMs: 20_000 }),
      agent("busy", "busy", "running", [attempt(1, "b")], { structuralPath: ["p", "a"], startedAt: now - 3_000_000, lastEventAt: now - 12 * 60_000 }),
    ], phase: "work", phaseHistory: [{ phase: "work", afterAgent: 0 }] }, launch({ phases: ["work"] }));
    const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list();
    const work = "run:run:node:phase/work%231";
    const details = (key: string, time: number): readonly string[] => nodes.find((node) => node.key === key)?.details(PLAIN, time) ?? [];
    for (const key of [work, `${work}/operation/p`, `${work}/operation/p/a`]) {
      assert.equal(details(key, now + 60_000).join("\n") !== details(key, now).join("\n"), live, key);
      if (!live) assert.ok(details(key, now).includes("Elapsed: 20s"), `${key}: only the settled agent's span\n${details(key, now).join("\n")}`);
    }
    const run = nodes.find((node) => node.key === "run:run");
    assert.ok(run);
    assert.equal(run.details(PLAIN, now).some((line) => line.includes("interrupted=")), !live, "the run's counts name the leftover as interrupted, not running");
    assert.ok(run.details(PLAIN, now).includes(live ? "agents completed=1 running=1 failed=0 cancelled=0 pending=0" : "agents completed=1 running=0 failed=0 cancelled=0 pending=0 interrupted=1"), run.details(PLAIN, now).join("\n"));
    // The rows of the phase and the operations holding the leftover: no spinner, no running, in a run that is not live.
    for (const key of [work, `${work}/operation/p`, `${work}/operation/p/a`]) {
      const node = nodes.find((candidate) => candidate.key === key);
      assert.ok(node, key);
      assert.equal(node.line(PLAIN, false, false).includes("⠦"), live, `${key}: ${node.line(PLAIN, false, false)}`);
      assert.equal(node.title(PLAIN).includes(" running"), live, `${key}: ${node.title(PLAIN)}`);
      assert.equal(node.details(PLAIN, now).includes("Status: running"), live, `${key}: ${node.details(PLAIN, now).join("\n")}`);
      if (!live) assert.ok(node.details(PLAIN, now).includes(`Status: ${state}`), key);
    }
  });
}

for (const agentState of ["waiting_for_child", "retrying", "paused"] as const) {
  for (const [state, live] of [["running", true], ["interrupted", false]] as const) {
    void test(`an agent recorded ${agentState} in a ${state} run ${live ? "is live: its duration keeps growing" : "is a leftover: not running, the quiet dot, no duration that grows"}`, async () => {
      const { home, cwd } = project("session-agents");
      const now = Date.now();
      await createRun({ home, cwd }, "r", state, { workflowName: "flow", agents: [agent("busy", "busy", agentState, [attempt(1, "k")], { startedAt: now - 3_600_000, lastEventAt: now - 12 * 60_000 })] });
      const busy = (await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list()).find(({ key }) => key === "run:r:busy");
      assert.ok(busy?.agent);
      assert.equal(busy.agent.running, live);
      assert.equal(busy.agent.leftover, live ? undefined : true);
      assert.equal(busy.line(TAGGED, false, false).includes("<muted>·</muted>"), !live);
      const duration = (time: number): string | undefined => busy.details(PLAIN, time).find((line) => line.startsWith("Duration:"));
      assert.equal(duration(now) !== undefined, live, busy.details(PLAIN, now).join("\n"));
      assert.equal(duration(now + 60_000) !== duration(now), live);
    });
  }
}

for (const agentState of ["running", "waiting_for_child", "retrying", "paused"] as const) {
  for (const state of ["running", "pausing", "awaiting_input", "paused", "interrupted", "completed"] as const) {
    const live = state === "running" || state === "pausing" || state === "awaiting_input";
    void test(`/agents names an agent recorded ${agentState} in a ${state} run ${live ? "as the /workflow details do" : "interrupted in its own and its run's, phase's and operation's details, not running"}`, async () => {
      const { home, cwd } = project("session-agents");
      const now = Date.now();
      await createRun({ home, cwd }, "run", state, { workflowName: "flow", agents: [
        agent("done", "done", "completed", [attempt(1, "d")], { structuralPath: ["p"], startedAt: now - 3_600_000, durationMs: 20_000 }),
        agent("busy", "busy", agentState, [attempt(1, "b")], { structuralPath: ["p"], startedAt: now - 3_000_000, lastEventAt: now - 60_000 }),
      ], phase: "work", phaseHistory: [{ phase: "work", afterAgent: 0 }] }, launch({ phases: ["work"] }));
      const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list();
      const details = (key: string): readonly string[] => nodes.find((node) => node.key === key)?.details(PLAIN, now) ?? [];
      const work = "run:run:node:phase/work%231";
      const counts = (key: string): string => details(key).find((line) => line.startsWith("agents completed=")) ?? "";
      assert.ok(details("run:run:busy").includes(live ? `State: ${agentState}` : `State: interrupted (recorded ${agentState})`), details("run:run:busy").join("\n"));
      for (const key of ["run:run", work, `${work}/operation/p`]) {
        const asRecorded = `agents completed=1 running=${agentState === "running" ? "1" : "0"} failed=0 cancelled=0 pending=${agentState === "running" ? "0" : "1"}`;
        assert.equal(counts(key), live ? asRecorded : "agents completed=1 running=0 failed=0 cancelled=0 pending=0 interrupted=1", key);
      }
    });
  }
}

void test("a leftover shows interrupted=N only when N > 0, and /workflow's own details keep counting it as recorded", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "run", "interrupted", { workflowName: "flow", agents: [agent("busy", "busy", "running", [attempt(1, "b")]), agent("hung", "hung", "retrying", [attempt(1, "h")])] });
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list();
  assert.ok(nodes.find((node) => node.key === "run:run")?.details(PLAIN, 0).includes("agents completed=0 running=0 failed=0 cancelled=0 pending=0 interrupted=2"));
  const { run, snapshot } = await new RunStore(cwd, "session", "run", home).load();
  const tree = buildWorkflowPhaseTree(buildWorkflowPhaseModel(run, snapshot));
  const root = tree.byId.get("workflow");
  assert.ok(root);
  assert.ok(formatWorkflowNodeDetails(run, tree, root, PLAIN, 0, false).includes("agents completed=0 running=1 failed=0 cancelled=0 pending=1"), "no leftovers given: as before");
  const busy = tree.nodes.find((node) => node.agentId === "busy");
  assert.ok(busy);
  assert.ok(formatWorkflowNodeDetails(run, tree, busy, PLAIN, 0, false).includes("State: running"), "no leftovers given: the recorded state");
  const styled = formatWorkflowNodeDetails(run, tree, busy, TAGGED, 0, false, new Set(["busy"])).find((line) => line.startsWith("State:"));
  assert.match(styled ?? "", /^State: <\w+>interrupted<\/\w+> \(recorded <\w+>running<\/\w+>\)$/, "styled like states");
});

void test("a queued agent in a run that is not live never started: it is not a leftover", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "r", "interrupted", { workflowName: "flow", agents: [agent("waiting", "waiting", "queued", [])] });
  const waiting = (await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list()).find(({ key }) => key === "run:r:waiting");
  assert.ok(waiting?.agent);
  assert.equal(waiting.agent.leftover, undefined);
  assert.equal(waiting.line(TAGGED, false, false).includes("<muted>·</muted>"), false);
});

for (const [agentState, glyph] of [["running", "⠦"], ["waiting_for_child", "…"], ["retrying", "↻"], ["paused", "⏸"]] as const) {
  for (const [state, live] of [["running", true], ["pausing", true], ["awaiting_input", true], ["paused", false], ["budget_exhausted", false], ["interrupted", false]] as const) {
    void test(`the timeline draws an agent recorded ${agentState} in a ${state} run ${live ? "as it is: growing to now" : "interrupted: up to its last recorded event, not growing"}`, async () => {
      const { home, cwd } = project("session-agents");
      await createRun({ home, cwd }, "r", state, { workflowName: "flow", agents: [agent("busy", "busy", agentState, [attempt(1, "k")], { startedAt: 1000, lastEventAt: 11_000 })] });
      const run = (await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list()).find(({ key }) => key === "run:r");
      const row = (now: number): string => run?.details(PLAIN, now, 64).find((line) => /busy/.test(line)) ?? "";
      assert.equal(row(31_000).endsWith(`30s ${glyph}`), live, row(31_000));
      assert.equal(row(31_000).endsWith(" 10s ↯"), !live, row(31_000));
      if (!live) assert.equal(row(91_000), row(31_000), "the row does not change with now");
    });
  }
}

void test("a leftover without a last recorded event is drawn as a one-cell bar, not growing", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "r", "interrupted", { workflowName: "flow", agents: [agent("busy", "busy", "running", [attempt(1, "k")], { startedAt: 1000 })] });
  const run = (await createSessionAgentsSource(commandContext(cwd), dependencies(home)).list()).find(({ key }) => key === "run:r");
  const row = (now: number): string => run?.details(PLAIN, now, 64).find((line) => /busy/.test(line)) ?? "";
  assert.match(row(31_000), /█ +0s ↯$/, row(31_000));
  assert.equal(row(91_000), row(31_000));
});

void test("a subagent storage failure keeps the run nodes and lists the Subagents group, unavailable, without children", async () => {
  const { home, cwd } = project("session-agents");
  await createRun({ home, cwd }, "run", "completed", { workflowName: "flow", agents: [agent("a", "a", "completed", [attempt(1, "a-1")])] });
  const manager = fakeManager([], {}, { async inspect() { throw new Error("storage \u001b[31mbroken"); } });
  const nodes = await createSessionAgentsSource(commandContext(cwd), dependencies(home, { subagents: () => manager })).list();
  assert.deepEqual(nodes.map(({ key }) => key), ["run:run", "run:run:node:phase/unassigned", "run:run:a", "subagents"]);
  const group = nodes[3];
  assert.ok(group);
  assert.equal(group.kind, "group");
  assert.deepEqual(group.details(PLAIN, 0), ["Subagents", "subagents unavailable: storage broken"]);
  assert.equal(group.line(PLAIN, false, false).includes("unavailable"), true);
  assert.deepEqual(nodes.filter(({ parentKey }) => parentKey === "subagents"), []);
});
