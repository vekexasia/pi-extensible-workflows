import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LAUNCH_SNAPSHOT_IDENTITY_VERSION,
  DEFAULT_SETTINGS,
  agentBreadcrumb,
  buildWorkflowPhaseModel,
  createLaunchSnapshot,
  formatWorkflowPhaseDashboard,
  buildWorkflowPhaseTree,
  preserveWorkflowPhaseTreeSelection,
  navigateWorkflowPhaseTree,
  workflowPhaseTreeVisibleNodes,
  workflowPhaseTreeInitialExpanded,
  preflight,
  preserveWorkflowPhaseSelection,
  workflowScriptArtifact,
  workflowPromptArtifact,
  workflowResultArtifact,
  type AgentRecord,
  type PersistedRun,
} from "../src/index.js";
import { RunStore } from "../src/persistence.js";

function agent(id: string, state: AgentRecord["state"] = "completed", parentId?: string): AgentRecord {
  return { id, name: id, path: id, state, ...(parentId ? { parentId } : {}), model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 };
}

function run(state: PersistedRun["state"], agents: readonly AgentRecord[] = [], phaseHistory?: PersistedRun["phaseHistory"]): PersistedRun {
  return { id: "run", workflowName: "phases", cwd: "/repo", sessionId: "session", state, agents, agentSessions: [], ...(phaseHistory ? { phaseHistory } : {}) };
}

function snapshot(phases?: readonly string[]) {
  return createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "phases" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, ...(phases ? { phases } : {}), schemas: [] });
}


void test("phase model merges empty and unstarted declarations without inventing runtime order", () => {
  const model = buildWorkflowPhaseModel(run("running", [], [{ phase: "build", afterAgent: 0 }]), ["build", "review"]);
  assert.deepEqual(model.phases.map(({ name, state }) => [name, state]), [["build", "running"], ["review", "not started"]]);
  assert.equal(model.currentPhaseId, "build#1");
  const unstarted = buildWorkflowPhaseModel(run("running"), ["build", "review"]);
  assert.deepEqual(unstarted.phases.map(({ name, state }) => [name, state]), [["build", "not started"], ["review", "not started"]]);
  assert.equal(unstarted.currentPhaseId, undefined);
});
void test("phase model ignores malformed history, clamps boundaries, and exposes unassigned agents", () => {
  const first = agent("first");
  const second = agent("second");
  const third = agent("third");
  const malformed = buildWorkflowPhaseModel({ ...run("running", [first, second, third]), phaseHistory: [
    null,
    { phase: "build", afterAgent: -4 },
    { phase: "review", afterAgent: 99 },
    { phase: "ignored", afterAgent: 1.5 },
  ] }, ["build", "review"]);
  assert.deepEqual(malformed.phases.filter(({ observed }) => observed).map(({ name, afterAgent, agents }) => [name, afterAgent, agents.map(({ id }) => id)]), [
    ["build", 0, ["first", "second", "third"]],
    ["review", 3, []],
  ]);
  const withUnassigned = buildWorkflowPhaseModel(run("running", [first, second], [{ phase: "review", afterAgent: 1 }]), ["review"]);
  assert.deepEqual(withUnassigned.unassignedAgents?.map(({ id }) => id), ["first"]);
  const tree = buildWorkflowPhaseTree(withUnassigned);
  assert.equal(tree.roots[0] && tree.byId.get(tree.roots[0])?.label, "Workflow");
  assert.ok(tree.nodes.some((node) => node.label === "Unassigned"));
});

void test("phase model preserves repeated and out-of-order observed occurrences", () => {
  const repeated = buildWorkflowPhaseModel(run("completed", [agent("a"), agent("b")], [{ phase: "build", afterAgent: 0 }, { phase: "build", afterAgent: 1 }]), ["build", "build", "review"]);
  assert.deepEqual(repeated.phases.map(({ id, observed }) => [id, observed]), [["build#1", true], ["build#2", true], ["review#1", false]]);
  const outOfOrder = buildWorkflowPhaseModel(run("running", [agent("a"), agent("b")], [{ phase: "review", afterAgent: 0 }, { phase: "build", afterAgent: 1 }]), ["build", "review"]);
  assert.deepEqual(outOfOrder.phases.map(({ name, observed }) => [name, observed]), [["review", true], ["build", true]]);
  assert.equal(outOfOrder.phases.filter(({ name }) => name === "build").length, 1);
});

void test("only the latest phase inherits terminal status and interrupted or exhausted runs stay distinct", () => {
  const history = [{ phase: "build", afterAgent: 0 }, { phase: "review", afterAgent: 1 }];
  for (const [state, latest] of [["failed", "failed"], ["stopped", "cancelled"], ["interrupted", "interrupted"], ["budget_exhausted", "budget_exhausted"]] as const) {
    const phases = buildWorkflowPhaseModel(run(state, [agent("done"), agent("done-2")], history), ["build", "review"]).phases;
    assert.deepEqual(phases.map(({ state: phaseState }) => phaseState), ["completed", latest]);
  }
});

void test("phase agent counts are explicit for every state", () => {
  const phases = buildWorkflowPhaseModel(run("running", [agent("done"), agent("live", "running"), agent("bad", "failed"), agent("cancelled", "cancelled"), agent("queued", "queued")], [{ phase: "review", afterAgent: 0 }]), ["review"]).phases;
  assert.deepEqual(phases[0]?.counts, { total: 5, completed: 1, running: 1, failed: 1, cancelled: 1, pending: 1 });
});

void test("phase launch metadata is optional, immutable, and survives old snapshot reloads", async () => {
  const checked = preflight("phase('build'); phase('build'); return true;", { models: new Set(["openai/gpt"]), tools: new Set(), });
  assert.deepEqual(checked.referenced.phases, ["build", "build"]);
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-phase-snapshot-"));
  const cwd = join(home, "repo");
  const store = new RunStore(cwd, "session", "run", home);
  const launch = snapshot(checked.referenced.phases);
  await store.create({ ...run("completed"), cwd }, launch);
  const loaded = await store.load();
  assert.deepEqual(loaded.snapshot.phases, ["build", "build"]);
  assert.equal(loaded.snapshot.identityVersion, LAUNCH_SNAPSHOT_IDENTITY_VERSION);
  const old = { ...launch };
  delete old.phases;
  await store.saveSnapshot(old);
  const oldLoaded = await store.load();
  assert.equal(oldLoaded.snapshot.phases, undefined);
  assert.equal(oldLoaded.snapshot.identityVersion, LAUNCH_SNAPSHOT_IDENTITY_VERSION);
});

void test("agent breadcrumbs are root-to-leaf, picker-compatible, and cycle-safe", () => {
  const root = agent("root");
  const child = agent("child", "completed", "root");
  const cycleRoot = agent("cycle-root", "completed", "cycle-child");
  const cycleChild = agent("cycle-child", "completed", "cycle-root");
  const byId = new Map([root, child, cycleRoot, cycleChild].map((value) => [value.id, value]));
  assert.equal(agentBreadcrumb(child, byId), "root > child");
  assert.equal(agentBreadcrumb({ ...child, structuralPath: ["issues", "42"], parentBreadcrumb: "review" }, byId, true), "issues > 42 > review > root > child");
  assert.equal(agentBreadcrumb(cycleRoot, byId), "cycle-child > cycle-root");
});

void test("phase dashboard keeps wide and narrow content within bounds while retaining counts", () => {
  const current = { ...run("running", [agent("done"), agent("live", "running")], [{ phase: "build", afterAgent: 0 }, { phase: "review", afterAgent: 1 }]), phase: "review" };
  const launch = snapshot(["build", "review"]);
  for (const width of [1, 10, 30, 79, 80, 120]) {
    const lines = formatWorkflowPhaseDashboard(current, launch, width);
    assert.ok(lines.every((line) => line.length <= width), `line exceeded width ${String(width)}`);
    if (width >= 10) {
      const rendered = lines.join("\n");
      for (const field of ["completed=", "running=", "failed=", "cancelled=", "pending="]) assert.match(rendered, new RegExp(field));
    }
  }
  const wide = formatWorkflowPhaseDashboard(current, launch, 120).join("\n");
  assert.match(wide, /\|/);
  const columns = formatWorkflowPhaseDashboard(current, launch, 120).filter((line) => line.includes(" | ")).map((line) => line.indexOf(" | "));
  assert.ok(columns.length > 1, "expected multiple two-column rows");
  assert.equal(new Set(columns).size, 1, `separator column drifted: ${columns.join(",")}`);
  const narrow = formatWorkflowPhaseDashboard(current, launch, 40).join("\n");
  assert.match(narrow, /Selected workflow: phases/);
});

void test("phase dashboard shows agent accounting breakdown only when measured", () => {
  const render = (accounting?: AgentRecord["accounting"]): string => formatWorkflowPhaseDashboard(run("running", [{ ...agent("worker", "running"), ...(accounting ? { accounting } : {}) }], [{ phase: "review", afterAgent: 0 }]), snapshot(["review"]), 120, { detailsOnly: true, agentId: "worker" }).join("\n");

  const measured = render({ input: 90_100, output: 12_200, cacheRead: 26_100, cacheWrite: 0, cost: 0.43 });
  assert.match(measured, /Tokens: ∑128\.4k ↑90\.1k ↓12\.2k ⇢26\.1k ⇠0/);
  assert.match(measured, /Cost: \$0\.43/);

  const missing = render();
  assert.doesNotMatch(missing, /Tokens:|Cost:/);

  const free = render({ input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 });
  assert.match(free, /Tokens: ∑3 ↑1 ↓2 ⇢0 ⇠0/);
  assert.match(free, /Cost: \$0\.00/);
});
void test("phase dashboard puts activity first and only shows repeated attempts", () => {
  const selected = { ...agent("worker", "running"), structuralPath: ["work", "worker"], activity: { kind: "text" as const, text: "responding" } };
  const render = (value: AgentRecord): string => formatWorkflowPhaseDashboard(run("running", [value], [{ phase: "review", afterAgent: 0 }]), snapshot(["review"]), 120, { detailsOnly: true, agentId: value.id }).join("\n");
  const firstAttempt = render(selected);
  assert.ok(firstAttempt.indexOf("Activity: responding") < firstAttempt.indexOf("State: running"));
  assert.doesNotMatch(firstAttempt, /Selected agent:/);
  assert.match(firstAttempt, /Structural path: work > worker/);
  assert.doesNotMatch(firstAttempt, /Attempts:/);
  assert.match(render({ ...selected, attempts: 2 }), /Attempts: 2/);
});
void test("phase dashboard shows workflow and selected agent durations", () => {
  const now = 100_000;
  const live = { ...agent("live", "running"), startedAt: now - 12_345 };
  const completed = { ...agent("completed"), durationMs: 65_432 };
  const render = (selected: AgentRecord): string => formatWorkflowPhaseDashboard({ ...run("running", [selected]), usage: { tokens: 0, costUsd: 0, durationMs: 12_345, agentLaunches: 0 } }, snapshot(["review"]), 120, { detailsOnly: true, agentId: selected.id }, undefined, now).join("\n");
  assert.match(render(live), /Run state: running runtime=12s/);
  assert.match(render(live), /Duration: 12s/);
  assert.match(render(completed), /Duration: 1m 5s/);
});
void test("phase dashboard shows active shell start and elapsed time", () => {
  const now = 65_432;
  const current = { ...run("running"), activeShells: 1, activeShellStartedAt: 0 };
  const rendered = formatWorkflowPhaseDashboard(current, snapshot(), 120, {}, undefined, now).join("\n");
  assert.match(rendered, /shell \[running\] \(1 active\)/);
  assert.match(rendered, /started=1970-01-01T00:00:00\.000Z/);
  assert.match(rendered, /elapsed=1m 5s/);
});
void test("phase dashboard nests active shells under their phase occurrence", () => {
  const current = { ...run("running", [agent("done"), agent("later")], [{ phase: "build", afterAgent: 0 }, { phase: "verify", afterAgent: 1 }]), activeShellsByPhase: [{ phaseIndex: 0, active: 2, startedAt: 0 }] };
  const model = buildWorkflowPhaseModel(current, ["build", "verify"]);
  assert.deepEqual(model.phases.map(({ name, state, shellActivity }) => [name, state, shellActivity?.active]), [["build", "running", 2], ["verify", "running", undefined]]);
  const tree = buildWorkflowPhaseTree(model);
  const visible = workflowPhaseTreeVisibleNodes(tree, workflowPhaseTreeInitialExpanded(tree));
  assert.deepEqual(visible.filter(({ kind }) => kind === "shell").map(({ label, phaseId }) => [label, phaseId]), [["shell [running] (2 active)", "build#1"]]);
  const rendered = formatWorkflowPhaseDashboard(current, snapshot(["build", "verify"]), 120, {}, undefined, 65_432).join("\n");
  assert.match(rendered, /build[\s\S]*shell \[running\] \(2 active\)/);
});
void test("phase dashboard places preflight shells in a fallback phase", () => {
  const current = { ...run("running"), activeShellsByPhase: [{ phaseIndex: -1, active: 1, startedAt: 0 }] };
  const model = buildWorkflowPhaseModel(current, snapshot(["build"]));
  assert.equal(model.phases[0]?.name, "Preflight");
  assert.match(formatWorkflowPhaseDashboard(current, snapshot(["build"]), 120, {}, undefined, 65_432).join("\n"), /Preflight[\s\S]*shell \[running\] \(1 active\)/);
});
void test("phase shell activity follows repeated phase occurrences", () => {
  const current = { ...run("running"), phaseHistory: [{ phase: "build", afterAgent: 0 }, { phase: "build", afterAgent: 0 }], activeShellsByPhase: [{ phaseIndex: 1, active: 1, startedAt: 0 }] };
  const model = buildWorkflowPhaseModel(current, ["build", "build"]);
  assert.equal(model.phases[0]?.shellActivity, undefined);
  assert.equal(model.phases[1]?.shellActivity?.active, 1);
});
void test("phase and agent selections survive read-model polling", () => {
  const before = buildWorkflowPhaseModel(run("running", [agent("one")], [{ phase: "build", afterAgent: 0 }]), ["build", "review"]);
  const selected = preserveWorkflowPhaseSelection(before, { phaseId: "build#1", agentId: "one" });
  const after = buildWorkflowPhaseModel(run("running", [agent("one"), agent("two")], [{ phase: "build", afterAgent: 0 }, { phase: "review", afterAgent: 1 }]), ["build", "review"]);
  assert.deepEqual(preserveWorkflowPhaseSelection(after, selected), selected);
});

void test("phase tree groups structural paths and preserves stable node selection", () => {
  const current = run("running", [
    { ...agent("api", "running"), structuralPath: ["reviewers", "api"] },
    { ...agent("ui", "completed"), structuralPath: ["reviewers", "ui"] },
  ], [{ phase: "review", afterAgent: 0 }]);
  const model = buildWorkflowPhaseModel(current, ["review"]);
  const tree = buildWorkflowPhaseTree(model);
  const expanded = new Set(tree.nodes.filter((node) => node.kind !== "agent").map((node) => node.id));
  const visible = workflowPhaseTreeVisibleNodes(tree, expanded);
  assert.deepEqual(visible.map(({ kind, label }) => [kind, label]), [
    ["workflow", "Workflow"],
    ["phase", "review"],
    ["operation", "reviewers"],
    ["operation", "api"],
    ["agent", "api"],
    ["operation", "ui"],
    ["agent", "ui"],
  ]);
  const selected = tree.nodes.find((node) => node.kind === "agent" && node.agentId === "ui");
  assert.ok(selected);
  const refreshed = buildWorkflowPhaseTree(buildWorkflowPhaseModel({ ...current, agents: [...current.agents, agent("later")] }, ["review"]));
  assert.deepEqual(preserveWorkflowPhaseTreeSelection(refreshed, { nodeId: selected.id }), { nodeId: selected.id });
  const rendered = formatWorkflowPhaseDashboard(current, snapshot(["review"]), 120, { nodeId: selected.id, expandedNodeIds: [...expanded] }).join("\n");
  assert.match(rendered, /reviewers/);
  assert.match(rendered, /→.*ui/);
});

void test("phase tree exposes function breadcrumbs as presentation scopes", () => {
  const first = { ...agent("first"), parentBreadcrumb: "reviewLoop" };
  const second = { ...agent("second"), parentBreadcrumb: "reviewLoop #2" };
  const current = run("running", [first, second], [{ phase: "review", afterAgent: 0 }]);
  const tree = buildWorkflowPhaseTree(buildWorkflowPhaseModel(current, ["review"]));
  const operations = tree.nodes.filter((node) => node.kind === "operation");
  assert.deepEqual(operations.map(({ label }) => label), ["reviewLoop", "reviewLoop #2"]);
  assert.deepEqual(current.agents.map(({ structuralPath }) => structuralPath), [undefined, undefined]);
  assert.deepEqual(tree.nodes.filter((node) => node.kind === "agent").map(({ operationPath }) => operationPath), [[], []]);
});
void test("agent actions render inside the details column beside the tree", () => {
  const current = run("running", [{ ...agent("api", "completed"), structuralPath: ["reviewers", "api"] }], [{ phase: "review", afterAgent: 0 }]);
  const model = buildWorkflowPhaseModel(current, ["review"]);
  const tree = buildWorkflowPhaseTree(model);
  const expanded = new Set(tree.nodes.filter((node) => node.kind !== "agent").map((node) => node.id));
  const selected = tree.nodes.find((node) => node.kind === "agent" && node.agentId === "api");
  assert.ok(selected);
  const actions = { title: "Agent actions", options: ["Copy agent ID", "Back"], index: 0 };
  const lines = formatWorkflowPhaseDashboard(current, snapshot(["review"]), 120, { nodeId: selected.id, expandedNodeIds: [...expanded], actions });
  const actionRow = lines.find((line) => line.includes("Copy agent ID"));
  assert.ok(actionRow, `expected an action row:\n${lines.join("\n")}`);
  assert.ok(actionRow.includes(" | "), `actions must stay in the two-column layout: ${actionRow}`);
  assert.ok(actionRow.indexOf("Copy agent ID") > actionRow.indexOf(" | "), `actions belong in the details column: ${actionRow}`);
  assert.ok(lines.some((line) => line.includes("Agent actions")), "expected the actions title");
  assert.ok(!lines.some((line) => line.includes("enter agent actions")), "hint should disappear once actions are open");
});
void test("run action hints hide when run actions are open", () => {
  const current = run("running", [{ ...agent("api"), structuralPath: ["reviewers", "api"] }], [{ phase: "review", afterAgent: 0 }]);
  const tree = buildWorkflowPhaseTree(buildWorkflowPhaseModel(current, ["review"]));
  const expandedNodeIds = tree.nodes.filter((node) => node.kind !== "agent").map((node) => node.id);
  const actions = { title: "Run actions", options: ["Back"], index: 0 };
  for (const node of tree.nodes.filter((candidate) => candidate.kind === "phase" || candidate.kind === "operation")) {
    const lines = formatWorkflowPhaseDashboard(current, snapshot(["review"]), 120, { nodeId: node.id, expandedNodeIds, actions }).join("\n");
    assert.doesNotMatch(lines, /enter run actions/);
  }
  const empty = formatWorkflowPhaseDashboard(run("running"), snapshot(), 120, { actions }).join("\n");
  assert.match(empty, /Run actions/);
  assert.doesNotMatch(empty, /enter run actions/);
});
void test("phase dashboard keeps system prompts out of agent details", () => {
  const current = run("running", [{ ...agent("api"), systemPrompt: "PRIVATE SYSTEM PROMPT" }], [{ phase: "review", afterAgent: 0 }]);
  const rendered = formatWorkflowPhaseDashboard(current, snapshot(["review"]), 120, { detailsOnly: true, agentId: "api" }).join("\n");
  assert.doesNotMatch(rendered, /System prompt:|PRIVATE SYSTEM PROMPT/);
});

void test("phase tree preserves parent nesting across different structural paths", () => {
  const current = run("running", [
    { ...agent("parent", "running"), structuralPath: ["reviewers", "parent"] },
    { ...agent("child", "completed", "parent"), structuralPath: ["other", "child"] },
  ], [{ phase: "review", afterAgent: 0 }]);
  const tree = buildWorkflowPhaseTree(buildWorkflowPhaseModel(current, ["review"]));
  const phase = tree.nodes.find((node) => node.kind === "phase");
  const parent = tree.nodes.find((node) => node.agentId === "parent");
  const child = tree.nodes.find((node) => node.agentId === "child");
  const suffix = tree.nodes.find((node) => node.kind === "operation" && node.operationPath.join("/") === "other/child");
  const scope = tree.nodes.find((node) => node.kind === "operation" && node.operationPath.join("/") === "other");
  assert.ok(phase && parent && child && suffix && scope);
  assert.deepEqual(phase.children, [tree.nodes.find((node) => node.kind === "operation" && node.operationPath[0] === "reviewers")?.id]);
  assert.ok(parent.children.includes(scope.id));
  assert.equal(suffix.children.includes(child.id), true);
  assert.equal(child.operationPath.join("/"), "other/child");
  const visible = workflowPhaseTreeVisibleNodes(tree, new Set(tree.nodes.filter((node) => node.children.length).map((node) => node.id)));
  assert.equal(visible.filter((node) => node.kind === "agent" && node.agentId === "child").length, 1);
  const sameScope = buildWorkflowPhaseTree(buildWorkflowPhaseModel(run("running", [
    { ...agent("same-parent", "running"), structuralPath: ["shared"] },
    { ...agent("same-child", "completed", "same-parent"), structuralPath: ["shared"] },
  ], [{ phase: "review", afterAgent: 0 }]), ["review"]));
  const sameParent = sameScope.nodes.find((node) => node.agentId === "same-parent");
  const sameChild = sameScope.nodes.find((node) => node.agentId === "same-child");
  assert.ok(sameParent && sameChild);
  assert.equal(sameChild.parentId, sameParent.id);
  const repeatedScope = buildWorkflowPhaseTree(buildWorkflowPhaseModel(run("running", [
    { ...agent("parent-a", "running"), structuralPath: ["parents", "a"] },
    { ...agent("child-a", "completed", "parent-a"), structuralPath: ["shared", "child"] },
    { ...agent("parent-b", "running"), structuralPath: ["parents", "b"] },
    { ...agent("child-b", "completed", "parent-b"), structuralPath: ["shared", "child"] },
  ], [{ phase: "review", afterAgent: 0 }]), ["review"]));
  assert.equal(repeatedScope.nodes.filter((node) => node.kind === "operation" && node.operationPath.join("/") === "shared/child").length, 2);
  const cycle = buildWorkflowPhaseTree(buildWorkflowPhaseModel(run("running", [agent("left", "completed", "right"), agent("right", "completed", "left")], [{ phase: "review", afterAgent: 0 }]), ["review"]));
  assert.equal(cycle.nodes.filter((node) => node.kind === "agent").length, 2);
});

void test("phase tree navigation collapses, expands, and moves through visible rows", () => {
  const current = run("running", [{ ...agent("api"), structuralPath: ["reviewers", "api"] }], [{ phase: "review", afterAgent: 0 }]);
  const tree = buildWorkflowPhaseTree(buildWorkflowPhaseModel(current, ["review"]));
  const phase = tree.nodes.find((node) => node.kind === "phase");
  const operation = tree.nodes.find((node) => node.kind === "operation");
  assert.ok(phase && operation);
  const collapsed = navigateWorkflowPhaseTree(tree, phase.id, new Set(), "right");
  assert.deepEqual(collapsed, { nodeId: phase.id, expandedNodeIds: new Set([phase.id]) });
  const child = navigateWorkflowPhaseTree(tree, phase.id, collapsed.expandedNodeIds, "right");
  assert.equal(child.nodeId, operation.id);
  const opened = navigateWorkflowPhaseTree(tree, operation.id, child.expandedNodeIds, "right");
  const folded = navigateWorkflowPhaseTree(tree, operation.id, opened.expandedNodeIds, "left");
  assert.equal(folded.nodeId, operation.id);
  assert.equal(folded.expandedNodeIds.has(operation.id), false);
});
void test("phase tree navigation handles empty, invalid, and wrapping selections", () => {
  const empty = buildWorkflowPhaseTree(buildWorkflowPhaseModel(run("running"), []));
  for (const direction of ["up", "down", "left", "right"] as const) assert.deepEqual(navigateWorkflowPhaseTree(empty, undefined, new Set(), direction), { nodeId: "workflow", expandedNodeIds: new Set() });
  const tree = buildWorkflowPhaseTree(buildWorkflowPhaseModel(run("running", [agent("one"), agent("two")], [{ phase: "review", afterAgent: 0 }]), ["review"]));
  const expanded = new Set(tree.nodes.filter((node) => node.children.length).map((node) => node.id));
  const visible = workflowPhaseTreeVisibleNodes(tree, expanded);
  assert.ok(visible.length > 1);
  assert.equal(navigateWorkflowPhaseTree(tree, "missing", expanded, "down").nodeId, visible[1]?.id);
  assert.equal(navigateWorkflowPhaseTree(tree, visible[0]?.id, expanded, "up").nodeId, visible.at(-1)?.id);
  assert.equal(navigateWorkflowPhaseTree(tree, visible.at(-1)?.id, expanded, "down").nodeId, visible[0]?.id);
});

void test("workflow artifact views use type-appropriate temporary file content", () => {
  assert.deepEqual(workflowScriptArtifact("export const value = 1;"), { extension: ".js", content: "export const value = 1;" });
  assert.deepEqual(workflowPromptArtifact("Inspect the target"), { extension: ".md", content: "Inspect the target" });
  assert.deepEqual(workflowResultArtifact("plain result"), { extension: ".md", content: "plain result" });
  assert.deepEqual(workflowResultArtifact({ answer: 42 }), { extension: ".json", content: "{\n  \"answer\": 42\n}\n" });
  for (const value of [null, false, ["a", 1]]) assert.deepEqual(workflowResultArtifact(value), { extension: ".json", content: `${JSON.stringify(value, null, 2)}\n` });
});
