import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { contextualWorkflowAction, testExtensionApi, waitForIssue105 } from "./support.js";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, formatAgentDetail, formatCost, formatNavigatorDashboard, formatNavigatorRun, formatWorkflowPhaseDashboard, formatWorkflowProgress, mergeBudget, RunStore, truncateWorkflowProgress, WORKFLOW_AGENT_STALL_THRESHOLD_MS, type AgentRecord, type PersistedRun } from "../src/index.js";
import { navigatorRunLabels } from "../src/host-view.js";
import { listRunIds } from "../src/persistence.js";
import { testTransport, type TestPiSession, type TestPiSessionEvent } from "./test-transport.js";

function makeAgent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return { id: "run:1", name: "worker", path: "run:1", state: "running", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1, ...overrides };
}

function makeRun(overrides: Partial<PersistedRun> = {}): PersistedRun {
  return { id: "run", workflowName: "test", cwd: "/repo", sessionId: "session", state: "running", agents: [], agentSessions: [], ...overrides };
}

void test("workflow progress warns after ten minutes of agent silence and resets on events", () => {
  const now = 12 * 60 * 60 * 1000;
  const agent = makeAgent({ activity: { kind: "text", text: "responding" }, lastEventAt: now - WORKFLOW_AGENT_STALL_THRESHOLD_MS + 1 });
  const run = makeRun({ workflowName: "stalling", agents: [agent] });
  assert.doesNotMatch(formatWorkflowProgress(run, "◇", undefined, now), /stalled\?/);
  const atThreshold = makeRun({ ...run, agents: [{ ...agent, lastEventAt: now - WORKFLOW_AGENT_STALL_THRESHOLD_MS }] });
  assert.match(formatWorkflowProgress(atThreshold, "◇", undefined, now), /responding - stalled\? 10m/);
  const stalled = makeRun({ ...run, agents: [{ ...agent, lastEventAt: now - WORKFLOW_AGENT_STALL_THRESHOLD_MS - 2 * 60 * 1000 }] });
  assert.match(formatWorkflowProgress(stalled, "◇", undefined, now), /responding - stalled\? 12m/);
  const longStalled = makeRun({ ...run, agents: [{ ...agent, lastEventAt: now - WORKFLOW_AGENT_STALL_THRESHOLD_MS - 62 * 60 * 1000 }] });
  assert.match(formatWorkflowProgress(longStalled, "◇", undefined, now), /responding - stalled\? 1h 12m/);
  const stalledAgent = stalled.agents[0];
  assert.ok(stalledAgent);
  const noActivity = makeRun({ ...stalled, agents: [{ ...stalledAgent, activity: undefined }] });
  assert.match(formatWorkflowProgress(noActivity, "◇", undefined, now), /stalled\? 12m/);
  assert.doesNotMatch(formatWorkflowProgress(noActivity, "◇", undefined, now), / - stalled\?/);
  const reset = makeRun({ ...stalled, agents: [{ ...stalledAgent, lastEventAt: now }] });
  assert.doesNotMatch(formatWorkflowProgress(reset, "◇", undefined, now), /stalled\?/);
  assert.match(formatNavigatorDashboard(stalled, [], [], now), /responding - stalled\? 12m/);
  const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "stalling" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  assert.match(formatWorkflowPhaseDashboard(stalled, snapshot, 120, { agentId: "run:1" }, undefined, now).join("\n"), /stalled\? 12m/);
});
void test("workflow progress shows runtime after the workflow state", () => {
  const run = makeRun({ workflowName: "runtime", usage: { tokens: 0, costUsd: 0, durationMs: 12_345, agentLaunches: 0 } });
  assert.match(formatWorkflowProgress(run), /\[running\] runtime=12s/);
  assert.match(formatWorkflowProgress({ ...run, state: "completed", usage: { tokens: 0, costUsd: 0, durationMs: 65_432, agentLaunches: 0 } }), /\[completed\] runtime=1m 5s/);
});
void test("foreground progress shows compact usage and expanded agent details", () => {
  const now = 65_432;
  const agent = makeAgent({
    state: "completed",
    model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" },
    startedAt: 0,
    durationMs: now,
    attempts: 2,
    accounting: { input: 1_200, output: 300, cacheRead: 40, cacheWrite: 0, cost: 0.001 },
  });
  const run = makeRun({
    workflowName: "accounted",
    state: "completed",
    agents: [agent],
    usage: { tokens: 1_500, costUsd: 0.001, durationMs: now, agentLaunches: 1 },
  });
  const collapsed = formatWorkflowProgress(run, "◇", undefined, now);
  assert.match(collapsed, /\[completed\] 1\.5kt · \$0\.001 runtime=1m 5s/);
  assert.doesNotMatch(collapsed, /gpt-5\.6-sol|attempt 2/);
  const expanded = formatWorkflowProgress(run, "◇", undefined, now, true);
  assert.match(expanded, /gpt-5\.6-sol:high · 1\.5kt · \$0\.001 · 1m 5s · attempt 2/);
});
void test("workflow TUI cost views preserve shared sub-cent formatting", () => {
  const cheap = makeAgent({ accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.001 } });
  const run = makeRun({ workflowName: "cheap", agents: [cheap] });
  const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "cheap" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  const store = new RunStore("/repo", "session", "run", "/tmp");
  assert.equal(formatCost(0.001), "$0.001");
  assert.match(navigatorRunLabels([{ store, loaded: { run } }])[0] ?? "", /\$0\.001/);
  assert.match(formatNavigatorDashboard(run, [], []), /\$0\.001/);
  assert.match(formatAgentDetail(cheap).join("\n"), /Cost: \$0\.001/);
  assert.match(formatNavigatorRun({ run, snapshot }, [], []), /cost=\$0\.001/);
});

void test("phase tree uses compact state glyphs while details keep activity", () => {
  const agents = [
    { id: "run:1", name: "running", path: "run:1", state: "running" as const, model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1, activity: { kind: "text" as const, text: "responding" } },
    { id: "run:2", name: "paused", path: "run:2", state: "paused" as const, model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
    { id: "run:3", name: "failed", path: "run:3", state: "failed" as const, model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
  ];
  const run = { id: "run", workflowName: "glyphs", cwd: "/repo", sessionId: "session", state: "running" as const, agents, agentSessions: [] };
  const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "glyphs" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  const lines = formatWorkflowPhaseDashboard(run, snapshot, 120, { agentId: "run:1" });
  const tree = lines.map((line) => line.split(" | ")[0]).join("\n");
  assert.match(tree, /running · ⠦/);
  assert.match(tree, /paused · ⏸/);
  assert.match(tree, /failed · ✗/);
  assert.doesNotMatch(tree, /responding/);
  assert.match(lines.join("\n"), /Activity: responding/);
});
void test("workflow log rendering keeps recent visual lines collapsed and all lines expanded", () => {
  type Rendered = { render: (width: number) => string[] };
  type WorkflowTool = { name: string; renderResult?: (result: unknown, options: { expanded: boolean; isPartial: boolean }, theme: unknown, context: unknown) => Rendered };
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-log-rendering-"));
  const tools: WorkflowTool[] = [];
  workflowExtension(testExtensionApi({ registerTool(tool: WorkflowTool) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool?.renderResult);
  const run = makeRun({ workflowName: "logs", cwd: home, state: "completed", events: Array.from({ length: 6 }, (_, index) => ({ type: "log", message: index === 5 ? "last line\ncontinued line" : `log-${String(index)}`, timestamp: Date.UTC(2024, 0, 2, 3, 4, index) })) });
  const result = { content: [], details: { run } };
  const theme = { fg: (color: string, text: string) => `<${color}>${text}</${color}>`, bold: (text: string) => `<bold>${text}</bold>` };
  const context = { state: {}, cwd: home, invalidate: () => {} };
  const collapsed = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context).render(200).join("\n");
  assert.match(collapsed, /Logs/);
  assert.doesNotMatch(collapsed, /log-0|log-1/);
  assert.match(collapsed, /log-2|last line/);
  assert.match(collapsed, /continued line/);
  const expanded = tool.renderResult(result, { expanded: true, isPartial: false }, theme, context).render(200).join("\n");
  assert.match(expanded, /log-0[\s\S]*last line/);
  assert.match(expanded, /\d{2}:\d{2}:\d{2}/);
  assert.match(expanded, /last line[\s\S]*continued line/);
});
void test("inline workflow progress rebases runtime after pause and resume", () => {
  const previousNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-inline-runtime-"));
    const tools: Array<{ name: string; renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => { render: (width: number) => string[] } }> = [];
    workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
    const tool = tools.find(({ name }) => name === "workflow");
    assert.ok(tool?.renderResult);
    const agent = makeAgent();
    const running = makeRun({ workflowName: "runtime", cwd: home, agents: [agent], usage: { tokens: 0, costUsd: 0, durationMs: 100, agentLaunches: 0 } });
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const context = { state: {}, cwd: home, invalidate: () => {} };
    tool.renderResult({ content: [], details: { run: running } }, { expanded: false, isPartial: true }, theme, context);
    now = 2_000;
    const paused = { ...running, state: "paused" as const, agents: [{ ...agent, state: "paused" as const }], usage: { ...running.usage, durationMs: 250 } };
    tool.renderResult({ content: [], details: { run: paused } }, { expanded: false, isPartial: true }, theme, context);
    now = 62_000;
    const resumed = { ...running, usage: { ...running.usage, durationMs: 250 } };
    const current = tool.renderResult({ content: [], details: { run: resumed } }, { expanded: false, isPartial: true }, theme, context);
    assert.match(current.render(200).join("\n"), /runtime=0s/);
    tool.renderResult({ content: [], details: { run: { ...resumed, state: "completed" as const } } }, { expanded: false, isPartial: false }, theme, context);
  } finally {
    Date.now = previousNow;
  }
});
void test("terminal inline progress freezes stale child animation and stall duration", () => {
  const previousNow = Date.now;
  let now = 12 * 60 * 60 * 1000;
  Date.now = () => now;
  try {
    const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-terminal-progress-"));
    const tools: Array<{ name: string; renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => { render: (width: number) => string[] } }> = [];
    workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
    const tool = tools.find(({ name }) => name === "workflow");
    assert.ok(tool?.renderResult);
    const child = makeAgent({ activity: { kind: "text", text: "responding" }, lastEventAt: now - WORKFLOW_AGENT_STALL_THRESHOLD_MS });
    const terminal = makeRun({ cwd: home, state: "failed", agents: [child] });
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const context = { state: {}, cwd: home, invalidate: () => {} };
    const result = { content: [], details: { run: terminal } };
    const component = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
    const initial = component.render(200).join("\n");
    assert.match(initial, /stalled\? 10m/);
    now += 60 * 60 * 1000;
    assert.equal(component.render(200).join("\n"), initial);
    const rerendered = tool.renderResult(result, { expanded: false, isPartial: false }, theme, context);
    assert.equal(rerendered.render(200).join("\n"), initial);
  } finally {
    Date.now = previousNow;
  }
});
void test("final failure rendering clears inline progress invalidations", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-failure-progress-"));
  const tools: Array<{ name: string; renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => { render: (width: number) => string[] } }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool?.renderResult);
  const state: { workflowSpinner?: ReturnType<typeof setInterval>; workflowProgress?: unknown; workflowProgressComponent?: unknown } = {};
  let invalidations = 0;
  const context = { state, cwd: home, invalidate: () => { invalidations += 1; } };
  const running = makeRun({ cwd: home });
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  tool.renderResult({ content: [], details: { run: running } }, { expanded: false, isPartial: true }, theme, context);
  assert.ok(state.workflowSpinner);
  const failure = { runId: "run", workflowName: "test", state: "failed", failedAt: null, error: { code: "INTERNAL_ERROR", message: "boom" }, completedSiblingPaths: [], artifacts: { runDirectory: home, statePath: join(home, "state.json"), journalPath: join(home, "journal.json") } };
  tool.renderResult({ content: [], details: failure }, { expanded: false, isPartial: false }, theme, context);
  assert.equal(state.workflowSpinner, undefined);
  const after = invalidations;
  await new Promise<void>((resolve) => setTimeout(resolve, 180));
  assert.equal(invalidations, after);
});
void test("workflow progress shows active shell operations with start and elapsed time", () => {
  const now = 65_432;
  const run = makeRun({ workflowName: "shell-progress", activeShells: 2, activeShellStartedAt: 0 });
  const progress = formatWorkflowProgress(run, "◇", undefined, now);
  assert.match(progress, /shell \[running\] \(2 active\)/);
  assert.match(progress, /started=1970-01-01T00:00:00\.000Z/);
  assert.match(progress, /elapsed=1m 5s/);
  assert.match(formatNavigatorDashboard(run, [], [], now), /started=1970-01-01T00:00:00\.000Z.*elapsed=1m 5s/);
  assert.doesNotMatch(progress, /command-secret/);
  const scoped = { ...run, activeShellsByPhase: [{ phaseIndex: 0, active: 2, startedAt: 0 }] };
  assert.match(formatNavigatorDashboard(scoped, [], [], now), /shell \[running\] \(2 active\)/);
  const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "shell-progress" }, settings: DEFAULT_SETTINGS, models: [], tools: [], agentTypes: [], schemas: [] });
  assert.match(formatNavigatorRun({ run: scoped, snapshot }, [], [], now), /shell \[running\] \(2 active\)/);
  const legacy = { ...run };
  delete legacy.activeShells;
  delete legacy.activeShellStartedAt;
  assert.doesNotMatch(formatWorkflowProgress(legacy), /shell \[running\]/);
});
void test("workflow progress nests active shell under its phase occurrence", () => {
  const run = makeRun({ workflowName: "shell-phase", phase: "verify", phaseHistory: [{ phase: "build", afterAgent: 0 }, { phase: "verify", afterAgent: 0 }], activeShells: 1, activeShellStartedAt: 0, activeShellsByPhase: [{ phaseIndex: 1, active: 1, startedAt: 0 }] });
  const progress = formatWorkflowProgress(run, "◇", undefined, 65_432);
  assert.match(progress, /\[Phase: verify\]\n\s{4}◇ shell \[running\] \(1 active\)/);
  assert.doesNotMatch(progress, /\n\s{2}◇ shell \[running\]/);
});
void test("navigator keeps agent rows compact while preserving identity and state", () => {
  const run = makeRun({ workflowName: "policy", agents: [makeAgent({ id: "run:1", name: "review", path: "run:1", role: "reviewer", model: { provider: "anthropic", model: "opus", thinking: "high" }, tools: ["read", "grep"] })] });
  const dashboard = formatNavigatorDashboard(run, [], []);
  assert.match(dashboard, /⠦ review · running/);
  assert.doesNotMatch(dashboard, /model=|requested=|tools=|role=/);
  assert.doesNotMatch(dashboard, /Launch models/);
});
void test("compact TUI hides budgets without effective limits", () => {
  const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "render" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  const render = (budget: PersistedRun["budget"]): string => {
    const run = makeRun({ workflowName: "render", ...(budget === undefined ? {} : { budget }) });
    return [formatWorkflowProgress(run), formatNavigatorDashboard(run, [], []), formatNavigatorRun({ run, snapshot }, [], [])].join("\n");
  };
  for (const budget of [undefined, {}, { tokens: {} }]) assert.doesNotMatch(render(budget), /Budget|unlimited|tokens|costUsd|durationMs|agentLaunches/);
  const partial = render({ tokens: { hard: 10 } });
  assert.match(partial, /Budget version/);
  assert.match(partial, /tokens:/);
  assert.doesNotMatch(partial, /costUsd:|durationMs:|agentLaunches:/);
  const fullBudget = { tokens: { soft: 1, hard: 2 }, costUsd: { soft: 1, hard: 2 }, durationMs: { soft: 1, hard: 2 }, agentLaunches: { soft: 1, hard: 2 } };
  const full = render(fullBudget);
  for (const dimension of ["tokens", "costUsd", "durationMs", "agentLaunches"]) assert.match(full, new RegExp(`${dimension}:`));
  const removed = mergeBudget(fullBudget, { tokens: null, costUsd: null, durationMs: null, agentLaunches: null });
  assert.deepEqual(removed, {});
  assert.doesNotMatch(render(removed), /Budget|unlimited|tokens|costUsd|durationMs|agentLaunches/);
});
void test("navigator uses persisted labels and model fallbacks across views", () => {
  const run = makeRun({ workflowName: "labels", agents: [
    makeAgent({ id: "run:1", name: "stale-name", label: "explicit label", path: "run:1", model: { provider: "provider", model: "worker" } }),
    makeAgent({ id: "run:2", name: "worker", path: "run:2", state: "completed", parentId: "run:1", model: { provider: "provider", model: "worker" } }),
  ] });
  const dashboard = formatNavigatorDashboard(run, [], []);
  const progress = formatWorkflowProgress(run);
  const detail = formatNavigatorRun({ run, snapshot: createLaunchSnapshot({ script: "return 1;", args: null, metadata: { name: "labels" }, settings: DEFAULT_SETTINGS, models: ["provider/worker"], tools: [], agentTypes: [], schemas: [] }) }, [], []);
  assert.match(dashboard, /explicit label > worker/);
  assert.match(progress, /explicit label/);
  assert.match(detail, /explicit label .*model=provider\/worker/);
  assert.match(detail, /worker .*model=provider\/worker/);
  assert.doesNotMatch(`${dashboard}\n${detail}`, /role=custom/);
});

void test("streams foreground workflow progress into its tool card", async () => {
  type Update = { content: Array<{ type: string; text: string }>; details: { run: { state: string; phase?: string } } };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-progress-"));
  workflowExtension(testExtensionApi({
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
    registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {},
  }), home);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool);
  const updates: Update[] = [];
  const result = await tool.execute("id", { name: "progress", script: `phase('work'); return true;`, foreground: true }, new AbortController().signal, (update: Update) => { updates.push(update); }, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }) as { details: { run: Parameters<typeof formatWorkflowProgress>[0] } };
  assert.ok(updates.some(({ details }) => details.run.phase === "work"));
  assert.equal(updates.at(-1)?.details.run.state, "completed");
  assert.match(formatWorkflowProgress(result.details.run), /✓ Workflow: progress/);
});
void test("host persists neutral live tool and state progress while preserving captured system prompts", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-neutral-host-progress-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let listener: ((event: TestPiSessionEvent) => void) | undefined;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }] };
  const messages = [message];
  const native: TestPiSession & { systemPrompt?: string } = {
    sessionId: "neutral-host-progress",
    sessionFile: "/sessions/neutral-host-progress.jsonl",
    model: { provider: "changed", model: "model" },
    agent: { state: { tools: [{ name: "read" }] } },
    systemPrompt: "effective",
    messages,
    getSessionStats: () => ({ tokens: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, total: 14 }, cost: 0.25 }),
    subscribe(candidate: (event: TestPiSessionEvent) => void) { listener = candidate; return () => { listener = undefined; }; },
    async prompt() {
      listener?.({ type: "state_changed", state: { model: { provider: "changed", model: "model" }, tools: ["read"], systemPrompt: "effective" } });
      listener?.({ type: "tool_execution_start", toolCallId: "call", toolName: "read", args: {} });
      delete native.systemPrompt;
      listener?.({ type: "state_changed", state: { model: { provider: "changed", model: "model" }, tools: ["read"] } });
      await hold;
      listener?.({ type: "tool_execution_end", toolCallId: "call", toolName: "read", isError: false });
      listener?.({ type: "message_end", message });
    },
    steer: async () => {},
    dispose() {},
  };
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "read"] }), home, undefined, testTransport(async () => native));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  let live: PersistedRun | undefined;
  const running = workflow.execute("id", { name: "neutral-host-progress", script: `return agent("work", { tools: ["read"] });`, foreground: true }, new AbortController().signal, (update: { details: { run: PersistedRun } }) => { live = update.details.run; }, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  await waitForIssue105(() => live !== undefined && live.agents.some((agent) => agent.toolCalls?.some(({ state }) => state === "running") === true));
  assert.ok(live);
  const liveAgent = live.agents[0];
  assert.ok(liveAgent);
  assert.match(formatWorkflowProgress(live), /#1 .* gpt .*read/);
  assert.match(formatWorkflowPhaseDashboard(live, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "neutral-host-progress" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: ["read"], agentTypes: [], schemas: [] }), 120, { agentId: liveAgent.id }).join("\n"), /Model: changed\/model[\s\S]*Tools: read/);
  release();
  await running;
  const ids = await listRunIds(home, "session", home);
  const loaded = await new RunStore(home, "session", ids[0] as string, home).load();
  const agent = loaded.run.agents[0];
  assert.ok(agent);
  assert.deepEqual(agent.accounting, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25 });
  assert.deepEqual(agent.toolCalls, []);
  assert.deepEqual(agent.model, { provider: "openai", model: "gpt", thinking: "medium" });
  assert.deepEqual(agent.tools, ["read"]);
  assert.equal(agent.systemPrompt, "effective");
  assert.equal(typeof agent.lastEventAt, "number");
});
void test("host restart recovers persisted neutral state with the declared ownership policy", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-host-restart-recovery-"));
  const store = new RunStore(home, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: `return await agent("work");`, args: null, metadata: { name: "host-restart" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: ["agent", "read"], agentTypes: [], roles: {}, schemas: [] });
  await store.create({ id: "run", workflowName: "host-restart", cwd: home, sessionId: "session", state: "interrupted", agents: [{ id: "run:1", name: "work", path: "run:1", state: "cancelled", systemPrompt: "persisted prompt", model: { provider: "stale", model: "stale", thinking: "high" }, tools: ["agent", "read", "injected"], attempts: 1 }], agentSessions: [] }, snapshot);
  await store.saveOwnership([]);
  const createSession = async (): Promise<TestPiSession> => ({
    sessionId: "host-restart-session",
    sessionFile: "/sessions/host-restart-session.jsonl",
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    getSessionStats: () => ({ tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.5 }),
    prompt: async () => {},
    steer: async () => {},
    dispose() {},
  });
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "agent", "read"] }), home, undefined, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const command = commands[0]?.handler;
  assert.ok(workflow && start && command);
  const context = { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
  await start({}, context);
  await contextualWorkflowAction(command, context, "run", "Resume");
  const loaded = await store.load();
  assert.equal(loaded.run.id, "run");
  assert.equal(loaded.run.state, "completed");
  assert.deepEqual(loaded.run.agents.map(({ model, tools }) => ({ model, tools })), [{ model: { provider: "openai", model: "gpt", thinking: "medium" }, tools: ["agent", "read"] }]);
  assert.equal(loaded.run.agents[0]?.systemPrompt, "persisted prompt");
  await shutdown?.();
});
void test("host restart restores declared ownership over stale live session policy", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-host-restart-policy-"));
  const store = new RunStore(home, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "host-restart-policy" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: ["agent", "read"], agentTypes: [], roles: {}, schemas: [] });
  await store.create({ id: "run", workflowName: "host-restart-policy", cwd: home, sessionId: "session", state: "interrupted", agents: [{ id: "run:1", name: "work", path: "run:1", state: "running", model: { provider: "stale", model: "stale", thinking: "high" }, tools: ["agent", "read", "injected"], attempts: 1 }], agentSessions: [] }, snapshot);
  await store.saveOwnership([{ id: "run:1", label: "work", state: "running", options: { label: "work", cwd: home, model: "openai/gpt:medium", tools: ["agent", "read"] } }]);
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "agent", "read"] }), home);
  const stop = tools.find(({ name }) => name === "workflow_stop");
  assert.ok(stop && start);
  const context = { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
  await start({}, context);
  await stop.execute("stop", { runId: "run" });
  const loaded = await store.load();
  assert.equal(loaded.run.state, "stopped");
  assert.deepEqual(loaded.run.agents.map(({ model, tools }) => ({ model, tools })), [{ model: { provider: "openai", model: "gpt", thinking: "medium" }, tools: ["agent", "read"] }]);
  await shutdown?.();
});
void test("inline workflow progress refreshes persisted state for stalled agents", async () => {
  type Rendered = { render: (width: number) => string[]; invalidate?: () => void };
  type WorkflowTool = { name: string; renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => Rendered };
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-inline-stall-"));
  const store = new RunStore(home, "session", "run", home);
  const staleAt = Date.now() - WORKFLOW_AGENT_STALL_THRESHOLD_MS - 1;
  const agent = makeAgent({ activity: { kind: "text", text: "responding" }, lastEventAt: staleAt });
  const persistedRun = makeRun({ workflowName: "inline-stall", cwd: home, agents: [agent] });
  await store.create(persistedRun, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "inline-stall" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] }));
  const visibleRun = { ...persistedRun, agents: [{ ...agent, lastEventAt: Date.now() }] };
  const tools: WorkflowTool[] = [];
  workflowExtension(testExtensionApi({ registerTool(tool: WorkflowTool) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool?.renderResult);
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const result = { content: [], details: { run: visibleRun } };
  const context = { state: {}, cwd: home, invalidate: () => { current.invalidate?.(); } };
  const current = tool.renderResult(result, { expanded: false, isPartial: true }, theme, context);
  assert.doesNotMatch(current.render(200).join("\n"), /stalled\?/);
  assert.match(current.render(200).join("\n"), /runtime=0s/);
  await new Promise<void>((resolve) => setTimeout(resolve, 1_100));
  assert.match(current.render(200).join("\n"), /runtime=1s/);
  await new Promise<void>((resolve) => setTimeout(resolve, 200));
  const refreshed = tool.renderResult(result, { expanded: false, isPartial: true }, theme, context);
  assert.equal(refreshed, current);
  assert.match(refreshed.render(200).join("\n"), /stalled\? 10m/);
  tool.renderResult({ content: [], details: { run: { ...visibleRun, state: "completed" as const, agents: [] } } }, { expanded: false, isPartial: false }, theme, context);
});
void test("foreground workflow progress reports a shell waiting after agents settle", { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shell-progress-"));
  const startedPath = join(home, "shell-started");
  const releasePath = join(home, "shell-release");
  const command = `${process.execPath} -e ${JSON.stringify(`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(startedPath)},"started");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releasePath)})){clearInterval(timer);process.exit(0);}},1);`)}`;
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const createSession = async (): Promise<TestPiSession> => ({ transport: "local", session: { transport: "local", sessionId: "shell-progress-agent", locator: { sessionFile: "/sessions/shell-progress-agent.jsonl" } }, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {} });
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const updates: PersistedRun[] = [];
  let reportActive!: () => void;
  const active = new Promise<void>((resolve) => { reportActive = resolve; });
  const running = workflow.execute("id", { name: "shell-progress", script: `phase("build"); await agent("finish", {label:"worker"}); phase("verify"); await shell(${JSON.stringify(command)}); return true;`, foreground: true }, new AbortController().signal, (update: { details: { run: PersistedRun } }) => {
    const run = update.details.run;
    updates.push(run);
    if (run.activeShells === 1) reportActive();
  }, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  await active;
  await waitForIssue105(() => existsSync(startedPath));
  const live = updates.find(({ activeShells }) => activeShells === 1);
  assert.ok(live);
  assert.equal(live.agents.every((agent) => agent.state === "completed"), true);
  assert.deepEqual(live.activeShellsByPhase?.map(({ phaseIndex, active }) => [phaseIndex, active]), [[1, 1]]);
  assert.equal(live.phaseHistoryIndex, 1);
  const shellStartedAt = live.activeShellStartedAt;
  assert.equal(typeof shellStartedAt, "number");
  assert.ok(typeof shellStartedAt === "number" && shellStartedAt <= Date.now());
  assert.match(formatWorkflowProgress(live), /\[Phase: verify\]\n\s{4}.*shell \[running\] \(1 active\)/);
  writeFileSync(releasePath, "release");
  const result = await running as { details: { run: PersistedRun } };
  assert.equal(result.details.run.activeShells, undefined);
  assert.equal(result.details.run.activeShellStartedAt, undefined);
  assert.equal(result.details.run.activeShellsByPhase, undefined);
  assert.equal(updates.some(({ activeShells }) => activeShells === undefined), true);
});

void test("foreground workflow reports parallel agent activities together", { timeout: 5000 }, async () => {
  type Update = { details: { run: { agents: Array<{ activity?: { kind: string; text: string } }> } } };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-parallel-progress-"));
  let session = 0;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const createSession = async (): Promise<TestPiSession> => {
    const id = ++session;
    const toolName = id === 1 ? "read" : "grep";
    let listener: ((event: TestPiSessionEvent) => void) | undefined;
    return {
      sessionId: `parallel-${String(id)}`, sessionFile: `/sessions/parallel-${String(id)}.jsonl`,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      subscribe(candidate) { listener = candidate; return () => {}; },
      async prompt() {
        listener?.({ type: "tool_execution_start", toolCallId: `call-${String(id)}`, toolName, args: {} });
        await hold;
        listener?.({ type: "tool_execution_end", toolCallId: `call-${String(id)}`, toolName, result: {}, isError: false });
      },
      steer: async () => {},
      dispose() {},
    };
  };
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "read", "grep"], on() {} }), home, async () => {}, testTransport(createSession));
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool);
  const seen = new Set<string>();
  let combined = false;
  let resolveReported!: () => void;
  const reported = new Promise<void>((resolve) => { resolveReported = resolve; });
  const execution = tool.execute("id", { name: "parallel-progress", script: `return Promise.all([agent("one", {label:"first"}), agent("two", {label:"second"})]);`, concurrency: 2, foreground: true }, new AbortController().signal, (update: Update) => {
    const activities = update.details.run.agents.flatMap(({ activity }) => activity?.kind === "tool" ? [activity.text] : []);
    for (const activity of activities) seen.add(activity);
    if (activities.length === 2) combined = true;
    if (seen.has("read") && seen.has("grep")) resolveReported();
  }, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  await reported;
  release();
  await execution;
  assert.equal(combined, true);
});

void test("workflow progress keeps each agent to one line with latest tool", () => {
  const run = makeRun({ workflowName: "live", phase: "work", agents: [makeAgent({ id: "run:1", name: "review", path: "run:1", model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" }, tools: ["read"], accounting: { input: 120, output: 30, cacheRead: 40, cacheWrite: 0, cost: 0.01 }, toolCalls: [{ id: "call-1", name: "ls", state: "completed" }, { id: "call-2", name: "read", state: "running" }] })] });
  const rendered = formatWorkflowProgress(run);
  assert.match(rendered, /#1 ◇ review \[running\] ◇ read/);
  assert.doesNotMatch(rendered, /Model:/);
  assert.doesNotMatch(rendered, /Tokens:/);
  assert.doesNotMatch(rendered, /✓ ls/);
  assert.match(formatWorkflowProgress(run, "⠙"), /⠙ Workflow:[\s\S]*#1 ⠙ review \[running\] ⠙ read/);
  const agent = run.agents[0];
  assert.ok(agent);
  const reasoning = makeRun({ ...run, agents: [{ ...agent, activity: { kind: "reasoning", text: "checking cache" } }] });
  assert.match(formatWorkflowProgress(reasoning), /reasoning · checking cache/);
  const text = makeRun({ ...run, agents: [{ ...agent, activity: { kind: "text", text: "streaming answer" } }] });
  assert.match(formatWorkflowProgress(text), /responding · streaming answer/);
  const settled = makeRun({ ...run, agents: [{ ...agent, state: "completed", activity: { kind: "text", text: "stale output" } }] });
  assert.doesNotMatch(formatWorkflowProgress(settled), /stale output|◇ read/);
});
void test("workflow progress applies semantic styles without coloring agent names", () => {
  const styles = {
    accent: (text: string) => `<accent>${text}</accent>`,
    success: (text: string) => `<success>${text}</success>`,
    error: (text: string) => `<error>${text}</error>`,
    warning: (text: string) => `<warning>${text}</warning>`,
    muted: (text: string) => `<muted>${text}</muted>`,
    dim: (text: string) => `<dim>${text}</dim>`,
    bold: (text: string) => `<bold>${text}</bold>`,
  };
  const run = makeRun({ workflowName: "styled", state: "budget_exhausted", phase: "work", agents: [
    makeAgent({ id: "run:1", name: "done", path: "run:1", state: "completed" }),
    makeAgent({ id: "run:2", name: "live", path: "run:2", activity: { kind: "text", text: "answer" } }),
    makeAgent({ id: "run:3", name: "waiting", path: "run:3", state: "queued" }),
    makeAgent({ id: "run:4", name: "failed", path: "run:4", state: "failed" }),
    makeAgent({ id: "run:5", name: "cancelled", path: "run:5", state: "cancelled" }),
  ] });
  const progress = formatWorkflowProgress(run, "@", styles);
  assert.match(progress, /<bold><accent>Workflow: styled/);
  assert.match(progress, /<warning>!<\/warning>/);
  assert.match(progress, /<success>✓<\/success> done <success>\[completed\]<\/success>/);
  assert.match(progress, /<accent>@<\/accent> live <accent>\[running\]<\/accent> <accent>@<\/accent> <dim>responding · answer<\/dim>/);
  assert.match(progress, /<muted>○<\/muted> waiting <muted>\[queued\]<\/muted>/);
  assert.match(progress, /<error>✗<\/error> failed <error>\[failed\]<\/error>/);
  assert.match(progress, /<error>✗<\/error> cancelled <error>\[cancelled\]<\/error>/);
  assert.doesNotMatch(progress, /<accent>[^<]*live/);
});
void test("workflow progress truncation closes ANSI styles within terminal width", () => {
  const line = "\u001b[36m@\u001b[0m \u001b[1m\u001b[36mWorkflow: very-long-name (0/0 done)\u001b[0m\u001b[0m";
  const stripAnsi = (value: string): string => value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
  for (const width of [1, 20]) {
    const rendered = truncateWorkflowProgress(line, width)[0] ?? "";
    assert.ok(stripAnsi(rendered).length <= width);
    assert.equal(rendered.endsWith("\u001b[0m"), true);
  }
  assert.equal(stripAnsi(truncateWorkflowProgress(line, 1)[0] ?? ""), "…");
});
void test("workflow cards group structural scopes with stable creation order", () => {
  const run = makeRun({ workflowName: "grouped", agents: [
    makeAgent({ id: "run:1", name: "developer", path: "run:1", state: "completed", structuralPath: ["issues", "issue-65"], parentBreadcrumb: "developUntilApproved" }),
    makeAgent({ id: "run:2", name: "developer", path: "run:2", structuralPath: ["issues", "issue-66"], parentBreadcrumb: "developUntilApproved" }),
    makeAgent({ id: "run:3", name: "reviewer", path: "run:3", structuralPath: ["issues", "issue-65"], parentBreadcrumb: "developUntilApproved" }),
    makeAgent({ id: "run:4", name: "child", path: "run:4", parentId: "run:3", structuralPath: ["issues", "issue-65"], parentBreadcrumb: "developUntilApproved" }),
  ] });
  const progress = formatWorkflowProgress(run);
  const dashboard = formatNavigatorDashboard(run, [], [{ owner: "worktree/named/issue-65", branch: "hidden", path: "/hidden", cwd: "/hidden", base: "base" }]);
  assert.match(progress, /issues > issue-65 > developUntilApproved/);
  assert.match(dashboard, /issues > issue-65 > developUntilApproved/);
  assert.doesNotMatch(dashboard, /worktree\/named|hidden|\/hidden/);
  assert.ok(progress.indexOf("#1") < progress.indexOf("#3"));
  assert.ok(progress.indexOf("#3") < progress.indexOf("#4"));
  assert.ok(progress.indexOf("#3") < progress.indexOf("#2"));
  assert.match(progress, /#4 ◇ child/);
});
void test("workflow cards separate repeated function invocations", () => {
  const run = makeRun({ workflowName: "repeated", agents: [
    makeAgent({ id: "run:1", name: "developer", path: "run:1", state: "completed", parentBreadcrumb: "developUntilApproved" }),
    makeAgent({ id: "run:2", name: "reviewer", path: "run:2", state: "running", parentBreadcrumb: "developUntilApproved #2" }),
  ] });
  const progress = formatWorkflowProgress(run);
  const dashboard = formatNavigatorDashboard(run, [], []);
  assert.match(progress, /developUntilApproved\n {4}#1/);
  assert.match(progress, /developUntilApproved #2\n {4}#2/);
  assert.match(dashboard, /developUntilApproved[\s\S]*developUntilApproved #2/);
});
void test("workflow progress keeps top-level agents separate from review-loop groups", () => {
  const run = makeRun({ workflowName: "mixed", agents: [
    makeAgent({ id: "run:1", name: "scout", path: "run:1", state: "completed", structuralPath: [] }),
    makeAgent({ id: "run:2", name: "developer", path: "run:2", structuralPath: [], parentBreadcrumb: "reviewLoop.developUntilApproved" }),
  ] });
  const progress = formatWorkflowProgress(run);
  assert.match(progress, / {2}Agents\n {4}#1 ✓ scout \[completed\]/);
  assert.match(progress, / {2}reviewLoop\.developUntilApproved\n {4}#2 ◇ developer \[running\]/);
});
