import assert from "node:assert/strict";
import test from "node:test";
import { createLaunchSnapshot, DEFAULT_SETTINGS, formatWorkflowPhaseDashboard, type AgentRecord, type PersistedRun, type WorkflowPhaseSelection, type WorkflowProgressStyles } from "../src/index.js";

// The whole /workflow dashboard (tree rows and node details) pinned byte for byte: /agents draws the same rows and details
// through the functions this dashboard calls, so a change here is a change of both.
const NOW = 1_000_000;
function agent(id: string, state: AgentRecord["state"], extra: Partial<AgentRecord> = {}): AgentRecord {
  return { id, name: id, path: id, state, model: { provider: "openai", model: "gpt" }, tools: ["read"], attempts: 1, ...extra };
}
function usage(input: number, output: number, cost: number, startedAt: number, durationMs?: number): Partial<AgentRecord> {
  return { accounting: { input, output, cacheRead: 0, cacheWrite: 0, cost }, startedAt, ...(durationMs === undefined ? {} : { durationMs }) };
}
/** Phases plan (done), review (running, with a shell and parallel("p") branches a and b, api with a child) and ship (not started). */
const RUN: PersistedRun = {
  id: "run-1", workflowName: "review flow", cwd: "/repo", sessionId: "session", state: "running", agentSessions: [], phase: "review",
  phaseHistory: [{ phase: "plan", afterAgent: 0 }, { phase: "review", afterAgent: 1 }],
  activeShellsByPhase: [{ phaseIndex: 1, active: 2, startedAt: NOW - 3000 }],
  agents: [
    agent("planner", "completed", { label: "Planner", ...usage(1200, 300, 0.5, NOW - 60_000, 20_000) }),
    agent("api", "running", { structuralPath: ["p", "a"], ...usage(800, 100, 0.25, NOW - 30_000) }),
    agent("helper", "queued", { parentId: "api", structuralPath: ["p", "a"] }),
    agent("ui", "completed", { structuralPath: ["p", "b"], ...usage(400, 50, 0.125, NOW - 25_000, 10_000) }),
  ],
};
const SNAPSHOT = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "review flow" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, phases: ["plan", "review", "ship"], schemas: [] });
const ANSI: WorkflowProgressStyles = {
  accent: (text) => `\x1b[36m${text}\x1b[39m`, success: (text) => `\x1b[32m${text}\x1b[39m`, error: (text) => `\x1b[31m${text}\x1b[39m`, warning: (text) => `\x1b[33m${text}\x1b[39m`,
  muted: (text) => `\x1b[90m${text}\x1b[39m`, dim: (text) => `\x1b[2m${text}\x1b[22m`, bold: (text) => `\x1b[1m${text}\x1b[22m`,
};
const HEADER = ["Workflow: review flow", "phase: review", "Run state: running", "Phases: 1 not started · 1 running · 1 completed"];
const ANSI_HEADER = ["\x1b[1m\x1b[36mWorkflow: review flow\x1b[39m\x1b[22m", ...HEADER.slice(1)];
function dashboard(width: number, selection: WorkflowPhaseSelection, styles?: WorkflowProgressStyles): string[] {
  return formatWorkflowPhaseDashboard(RUN, SNAPSHOT, width, selection, styles, NOW);
}

void test("the initial dashboard selects the run and expands every node", () => {
  assert.deepEqual(dashboard(120, {}), [
    ...HEADER,
    "Tree                                       | Selected workflow: review flow",
    "→ ▾ Workflow · ⠦                           | Run ID: run-1",
    "  ▾ plan · ✓                               | Status: running",
    "    • Planner · ✓                          | agents completed=2 running=1 failed=0 cancelled=0 pending=1",
    "  ▾ review · ⠦                             | Agents: 4",
    "    ◇ shell [running] (2 active) · ⠦       | enter run actions",
    "    ▾ p · ⠦                                |",
    "      ▾ a · ⠦                              |",
    "        ▾ api · ⠦                          |",
    "          • helper · ○                     |",
    "      ▾ b · ✓                              |",
    "        • ui · ✓                           |",
    "    ship · ○                               |",
  ]);
});

void test("a selected phase shows its counts, usage and hint, with the states styled", () => {
  assert.deepEqual(dashboard(120, { nodeId: "phase/review%231" }, ANSI), [
    ...ANSI_HEADER,
    "\x1b[1mTree\x1b[22m                                       | \x1b[1mSelected phase: review\x1b[22m",
    "  ▾ Workflow · \x1b[36m⠦\x1b[39m                           | Status: \x1b[36mrunning\x1b[39m",
    "  ▾ plan · \x1b[32m✓\x1b[39m                               | agents completed=1 running=1 failed=0 cancelled=0 pending=1",
    "    • Planner · \x1b[32m✓\x1b[39m                          | Agents: 3",
    "→ ▾ review · \x1b[36m⠦\x1b[39m                             | Tokens: ∑1.4k ↑1.2k ↓150 ⇢0 ⇠0",
    "    ◇ shell [running] (2 active) · \x1b[36m⠦\x1b[39m       | Cost: $0.38",
    "    ▾ p · \x1b[36m⠦\x1b[39m                                | Elapsed: 30s",
    "      ▾ a · \x1b[36m⠦\x1b[39m                              | \x1b[90menter expand/collapse\x1b[39m",
    "        ▾ api · \x1b[36m⠦\x1b[39m                          |",
    "          • helper · \x1b[90m○\x1b[39m                     |",
    "      ▾ b · \x1b[32m✓\x1b[39m                              |",
    "        • ui · \x1b[32m✓\x1b[39m                           |",
    "    ship · \x1b[90m○\x1b[39m                               |",
  ]);
});

void test("a selected operation scope with collapsed nodes shows ▸ and its details", () => {
  assert.deepEqual(dashboard(120, { nodeId: "phase/review%231/operation/p", expandedNodeIds: ["workflow", "phase/review%231", "phase/review%231/operation/p"] }), [
    ...HEADER,
    "Tree                                       | Selected operation: p",
    "  ▾ Workflow · ⠦                           | Phase: review",
    "  ▸ plan · ✓                               | Status: running",
    "  ▾ review · ⠦                             | agents completed=1 running=1 failed=0 cancelled=0 pending=1",
    "    ◇ shell [running] (2 active) · ⠦       | Agents: 3",
    "→   ▾ p · ⠦                                | Tokens: ∑1.4k ↑1.2k ↓150 ⇢0 ⇠0",
    "      ▸ a · ⠦                              | Cost: $0.38",
    "      ▸ b · ✓                              | Elapsed: 30s",
    "    ship · ○                               | enter expand/collapse",
  ]);
});

void test("a selected agent shows its details and hint, or the action menu instead of the hint", () => {
  assert.deepEqual(dashboard(120, { nodeId: "phase/review%231/operation/p/a/agent/helper", expandedNodeIds: ["workflow", "phase/review%231", "phase/review%231/operation/p", "phase/review%231/operation/p/a", "phase/review%231/operation/p/a/agent/api"] }, ANSI), [
    ...ANSI_HEADER,
    "\x1b[1mTree\x1b[22m                                       | State: \x1b[90mqueued\x1b[39m",
    "  ▾ Workflow · \x1b[36m⠦\x1b[39m                           | Structural path: p > a",
    "  ▸ plan · \x1b[32m✓\x1b[39m                               | Model: openai/gpt",
    "  ▾ review · \x1b[36m⠦\x1b[39m                             | Tools: read",
    "    ◇ shell [running] (2 active) · \x1b[36m⠦\x1b[39m       | \x1b[90menter agent actions\x1b[39m",
    "    ▾ p · \x1b[36m⠦\x1b[39m                                |",
    "      ▾ a · \x1b[36m⠦\x1b[39m                              |",
    "        ▾ api · \x1b[36m⠦\x1b[39m                          |",
    "→         • helper · \x1b[90m○\x1b[39m                     |",
    "      ▸ b · \x1b[32m✓\x1b[39m                              |",
    "    ship · \x1b[90m○\x1b[39m                               |",
  ]);
  assert.deepEqual(dashboard(120, { nodeId: "phase/review%231/operation/p/a/agent/api", actions: { title: "Agent actions", options: ["Back"], index: 0 } }), [
    ...HEADER,
    "Tree                                       | State: running",
    "  ▾ Workflow · ⠦                           | Structural path: p > a",
    "  ▾ plan · ✓                               | Model: openai/gpt",
    "    • Planner · ✓                          | Tools: read",
    "  ▾ review · ⠦                             | Duration: 30s",
    "    ◇ shell [running] (2 active) · ⠦       | Tokens: ∑900 ↑800 ↓100 ⇢0 ⇠0",
    "    ▾ p · ⠦                                | Cost: $0.25",
    "      ▾ a · ⠦                              | Agent actions",
    "→       ▾ api · ⠦                          | → Back",
    "          • helper · ○                     |",
    "      ▾ b · ✓                              |",
    "        • ui · ✓                           |",
    "    ship · ○                               |",
  ]);
});

void test("below 80 columns the dashboard shows the details or the tree alone", () => {
  assert.deepEqual(dashboard(70, { nodeId: "phase/review%231/shell", detailsOnly: true }), [
    ...HEADER,
    "Selected shell",
    "⠦ shell [running] (2 active) started=1970-01-01T00:16:37.000Z",
    "elapsed=3s",
  ]);
  assert.deepEqual(dashboard(70, { nodeId: "phase/ship%231", treeOnly: true }), [
    ...HEADER,
    "Tree",
    "  ▾ Workflow · ⠦",
    "  ▾ plan · ✓",
    "    • Planner · ✓",
    "  ▾ review · ⠦",
    "    ◇ shell [running] (2 active) · ⠦",
    "    ▾ p · ⠦",
    "      ▾ a · ⠦",
    "        ▾ api · ⠦",
    "          • helper · ○",
    "      ▾ b · ✓",
    "        • ui · ✓",
    "→   ship · ○",
  ]);
});
