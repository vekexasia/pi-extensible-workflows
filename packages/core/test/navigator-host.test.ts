import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { registerWorkflowNavigator, type WorkflowNavigatorDependencies } from "../src/host-navigator.js";
import { executeCommand, testExtensionApi } from "./support.js";
import workflowExtension, { agentActionLabels, createLaunchSnapshot, DEFAULT_SETTINGS, formatAgentDetail, formatNavigatorDashboard, formatNavigatorRun, formatWorkflowPhaseDashboard, registerWorkflowExtension, RunStore, openWorkflowArtifact, WorkflowError, WORKFLOW_BLOCKED_EVENT } from "../src/index.js";
import { testTransport, type TestPiSession } from "./test-transport.js";

type OwnershipNodes = Parameters<RunStore["saveOwnership"]>[0];
const delayedOwnership = new Map<string, { start: () => void; cleanup: Promise<void> }>();
const failedOwnership = new Set<string>();
const nativeSaveOwnership = Reflect.get(RunStore.prototype, "saveOwnership");
RunStore.prototype.saveOwnership = async function (nodes: OwnershipNodes) {
  const delayed = delayedOwnership.get(this.directory);
  if (delayed) { delayed.start(); await delayed.cleanup; }
  if (failedOwnership.has(this.directory)) throw new Error("scheduler cleanup failed");
  await nativeSaveOwnership.call(this, nodes);
};
void test("workflow slash subcommands are rejected with picker guidance", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-workflow-slash-"));
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const notices: string[] = [];
  workflowExtension(testExtensionApi({ registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, registerTool() {}, on() {}, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  const command = commands[0]?.handler;
  assert.ok(command);
  await executeCommand(command, "resume run-id", { ui: { notify(message: string) { notices.push(message); } } });
  assert.match(notices[0] ?? "", /\/workflow/);
  assert.match(notices[0] ?? "", /do not accept arguments/);
});
void test("trajectory is the only accepted workflow argument", async () => {
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const opened: unknown[] = [];
  registerWorkflowNavigator({ pi: { registerCommand(_name: string, options: { handler: typeof handler }) { handler = options.handler; } }, trajectoryProvider: (context: unknown) => { opened.push(context); return { cwd: "/repo", sessionId: "session", themes: false, loadRuns: async () => [], loadSubagents: async () => [], loadMetadata: async () => ({ runs: [], subagents: [] }), handleAction: async () => {} }; } } as unknown as WorkflowNavigatorDependencies);
  assert.ok(handler);
  const notices: string[] = [];
  const context = { ui: { notify(message: string) { notices.push(message); } } };
  await executeCommand(handler, "trajectory", context);
  assert.equal(opened.length, 0);
  assert.equal(notices[0], "Trajectory is disabled");
  await executeCommand(handler, "resume run-id", context);
  assert.match(notices[1] ?? "", /do not accept arguments/);
});
void test("selected workflow agent details use the shared formatter seam", () => {
  const agent = { id: "agent-1", name: "reviewer", path: "agent-1", state: "running" as const, model: { provider: "openai", model: "gpt" }, tools: ["read"], attempts: 2, startedAt: 0, durationMs: 2000, lastEventAt: 0, role: "critic", activity: { kind: "tool" as const, text: "read" }, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } };
  const shared = formatAgentDetail(agent, undefined, 600_000);
  const run = { id: "run-1", workflowName: "shared", cwd: "/tmp", sessionId: "session", state: "running" as const, agents: [agent], agentSessions: [] };
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'shared'}", args: null, metadata: { name: "shared" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: ["read"], agentTypes: [], schemas: [] });
  const dashboard = formatNavigatorDashboard(run, [], [], 600_000);
  const phase = formatWorkflowPhaseDashboard(run, snapshot, 120, { agentId: agent.id }, undefined, 600_000).join("\n");
  for (const line of shared) assert.ok(phase.includes(line), `missing shared detail line: ${line}`);
  assert.match(dashboard, /reviewer · running/);
  const failed = { ...agent, state: "failed" as const, attemptDetails: [{ attempt: 1, transport: "fixture", setup: { hookNames: [], model: agent.model, tools: agent.tools, cwd: "/tmp" }, accounting: agent.accounting, error: { code: "AGENT_FAILED", message: "boom" } }] };
  assert.match(formatWorkflowPhaseDashboard({ ...run, agents: [failed] }, snapshot, 120, { agentId: failed.id }, undefined, 600_000).join("\n"), /Error: AGENT_FAILED: boom/);
});
void test("shared agent action labels gate standalone controls by state", () => {
  const labels = (state: "running" | "completed" | "failed" | "stopped") => agentActionLabels({ extensionLabels: [], hasWorktree: false, openPrompt: false, openSystemPrompt: false, openResult: false, standaloneState: state });
  assert.deepEqual(labels("running").slice(-4), ["Steer", "Stop", "Copy agent ID", "Back"]);
  assert.deepEqual(labels("completed").slice(-2), ["Copy agent ID", "Back"]);
  assert.deepEqual(labels("failed").slice(-3), ["Retry", "Copy agent ID", "Back"]);
  assert.deepEqual(labels("stopped").slice(-3), ["Retry", "Copy agent ID", "Back"]);
});
void test("session-scoped navigator shows metadata and confirms terminal deletion", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-navigator-"));
  const cwd = join(home, "project");
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'nav',description:'nav'}", args: null, metadata: { name: "nav", description: "nav" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: ["read"], agentTypes: [], schemas: [] });
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "nav", cwd, sessionId: "session-a", state: "completed", phase: "review", agents: [{ id: "run-a:1", name: "reviewer", path: "run-a:1", state: "failed", role: "reviewer", model: { provider: "openai", model: "gpt", thinking: "medium" }, tools: ["read"], attempts: 2, attemptDetails: [{ attempt: 2, transport: "local", session: { transport: "local", sessionId: "native-a", locator: { sessionFile: "/pi/native-a.jsonl" } }, setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd: "/repo" }, error: { code: "AGENT_FAILED", message: "boom" }, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }], accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }], agentSessions: [{ transport: "local", sessionId: "native-a", locator: { sessionFile: "/pi/native-a.jsonl" } }] }, snapshot);
  const same = new RunStore(cwd, "session-a", "run-c", home);
  await same.create({ id: "run-c", workflowName: "nav", cwd, sessionId: "session-a", state: "awaiting_input", agents: [], agentSessions: [] }, snapshot);
  await same.awaitCheckpoint({ path: "checkpoint/ship", name: "ship", prompt: "Ship?", context: null });
  const other = new RunStore(cwd, "session-b", "run-b", home);
  await other.create({ id: "run-b", workflowName: "other", cwd, sessionId: "session-b", state: "completed", agents: [], agentSessions: [] }, snapshot);
  const rendered = formatNavigatorRun(await store.load(), [], [{ owner: "worktree/named/reviewer", branch: "pi-extensible-workflows/run-a/tree", path: "/worktree", cwd: "/worktree/project", base: "abc" }]);
  assert.match(rendered, /Phase: review/);
  assert.match(rendered, /reviewer state=failed model=openai\/gpt:medium role=reviewer tools=read attempts=2 retries=1/);
  assert.match(rendered, /error=AGENT_FAILED: boom/);
  assert.match(rendered, /Worktrees: 1/);
  assert.match(rendered, /Agent sessions: 1/);
  assert.doesNotMatch(rendered, /worktree\/named|branch=|native-a: \/pi\/native-a|\/worktree/);

  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const prompts: string[] = [];
  const selections: string[][] = [];
  const copied: string[] = [];
  const pi = { registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["read", "workflow"] };
  workflowExtension(testExtensionApi(pi), home, async (value) => { copied.push(value); });
  const actionRuns: Array<{ attempt: number; sessionId: string | undefined; live: boolean }> = [];
  const workingMessages: Array<string | undefined> = [];
  registerWorkflowExtension({ version: "1.0.0", headline: "Navigator actions", agentAttemptActions: { inspectLatest: { label: "Inspect latest attempt", visible: (context) => context.attempt.attempt === 2, run: (context) => { actionRuns.push({ attempt: context.attempt.attempt, sessionId: context.session?.sessionId, live: context.liveSession !== undefined }); context.ui.setWorkingMessage?.("navigator working"); } } } });
  let selectCall = 0;
  const ctx = { cwd, mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {}, setWorkingMessage(message?: string) { workingMessages.push(message); }, select: async (prompt: string, options: string[]) => { prompts.push(prompt); selections.push(options); selectCall += 1; if (selectCall === 1) return options.find((option) => option.includes("completed")); if (selectCall === 2) return "Agents..."; if (selectCall === 3) return options.find((option) => option.includes("#1")); if (selectCall === 4) return "Inspect latest attempt"; if (selectCall === 5) return "Back"; return prompt === "Workflows\n" ? "Close" : "Back"; }, confirm: async () => false } };
  const command = commands[0]?.handler;
  assert.ok(command);
  await executeCommand(command, "", ctx);
  assert.ok(selections.length >= 2);
  const runList = selections[0]?.join("\n") ?? "";
  assert.match(runList, /nav/);
  assert.match(runList, /Close/);
  const dashActions = selections[1]?.join("\n") ?? "";
  assert.match(dashActions, /Delete|Stop|Approve|Reject/);
  assert.match(dashActions, /Agents\.\.\./);
  assert.doesNotMatch(dashActions, /Transcript paths|View transcript|Copy run path|Copy run ID|Copy branch|Copy worktree path/);
  assert.doesNotMatch(`${prompts.join("\n")}\n${selections.flat().join("\n")}`, /other|\/pi\/native-a/);
  assert.deepEqual(copied, []);
  assert.deepEqual(actionRuns, [{ attempt: 2, sessionId: "native-a", live: false }]);
  assert.deepEqual(workingMessages, ["navigator working"]);
  assert.doesNotMatch(`${prompts.join("\n")}\n${selections.flat().join("\n")}`, /other/);
  await store.delete(true);
  assert.equal(existsSync(store.directory), false);
});
void test("latest-attempt actions receive the active session and lose it after completion reload", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-active-attempt-actions-"));
  let releasePrompt!: () => void;
  let markPromptStarted!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
  const createSession = async (): Promise<TestPiSession> => ({
    sessionId: "active-action-session",
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    prompt: async () => { markPromptStarted(); await promptGate; },
    steer: async () => {},
    dispose() {},
  });
  const baseTransport = testTransport(createSession);
  let expectedSession: import("../src/types.js").WorkflowAgentSession | undefined;
  const transport: import("../src/types.js").AgentTransport = {
    id: "local",
    async createSession(prepared, context) { expectedSession = await baseTransport.createSession(prepared, context); return expectedSession; },
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const pi = { registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] };
  workflowExtension(testExtensionApi(pi), home, undefined, transport);
  const actionRuns: boolean[] = [];
  registerWorkflowExtension({ version: "1.0.0", headline: "Active attempt actions", agentAttemptActions: { inspectActiveAttempt147: { label: "Inspect active attempt", visible: (context) => context.run.workflowName === "active-attempt-actions", run: (context) => { actionRuns.push(context.liveSession === expectedSession); } } } });
  const workflow = tools.find(({ name }) => name === "workflow");
  const command = commands[0]?.handler;
  assert.ok(workflow && command);
  let commandInvocations = 0;
  const context = { cwd: home, mode: "rpc", hasUI: true, model: { provider: "openai", id: "gpt" }, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt" }] }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {}, select: async (_title: string, options: string[]) => { if (options.some((option) => option.includes("active-attempt-actions"))) return actionRuns.length < commandInvocations ? options.find((option) => option.includes("active-attempt-actions")) : "Close"; if (options.includes("Agents...")) return actionRuns.length < commandInvocations ? "Agents..." : "Back"; if (options.some((option) => option.startsWith("#1 "))) return options.find((option) => option.startsWith("#1 ")); if (options.includes("Inspect active attempt")) return "Inspect active attempt"; return "Back"; }, confirm: async () => false, input: async () => undefined } };
  const running = workflow.execute("id", { name: "active-attempt-actions", script: "return agent('work');", foreground: true }, new AbortController().signal, undefined, context);
  await promptStarted;
  commandInvocations = 1;
  await executeCommand(command, "", context);
  assert.deepEqual(actionRuns, [true]);
  releasePrompt();
  await running;
  commandInvocations = 2;
  await executeCommand(command, "", context);
  assert.deepEqual(actionRuns, [true, false]);
});
void test("navigator attempt actions retain live steering and takeover handoff", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-navigator-handoff-actions-"));
  let listener: ((event: import("../src/types.js").WorkflowAgentSessionEvent) => void) | undefined;
  let releasePrompt!: () => void;
  let markPromptStarted!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
  const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }] };
  const messages = [message];
  const steered: string[] = [];
  const createSession = async (): Promise<TestPiSession> => ({
    sessionId: "handoff-action-session",
    sessionFile: "/sessions/handoff-action.jsonl",
    messages,
    getSessionStats: () => ({ tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.5 }),
    subscribe(candidate) { listener = candidate; return () => { listener = undefined; }; },
    async prompt() { markPromptStarted(); listener?.({ type: "turn_start" }); await promptGate; listener?.({ type: "turn_end", message }); },
    steer: async (text) => { steered.push(text); },
    abort: async () => {},
    dispose() {},
  });
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  let expectedSession: import("../src/types.js").WorkflowAgentSession | undefined;
  const baseTransport = testTransport(createSession);
  const transport: import("../src/types.js").AgentTransport = { id: "local", async createSession(prepared, context) { expectedSession = await baseTransport.createSession(prepared, context); return expectedSession; } };
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, undefined, transport);
  const actionResults: Array<{ live: boolean; transferred: boolean; steered: string }> = [];
  registerWorkflowExtension({ version: "1.0.0", headline: "Handoff actions", agentAttemptActions: { takeOver: { label: "Take over live attempt", visible: (context) => context.liveSession !== undefined && context.handoff !== undefined, run: async (context) => { const handoff = context.handoff; if (!handoff) throw new Error("missing handoff"); await context.liveSession?.steer("continue"); const opening = handoff.request(async () => { handoff.takeover(); }); releasePrompt(); await opening; actionResults.push({ live: context.liveSession === expectedSession, transferred: handoff.transferred, steered: steered.at(-1) ?? "" }); } } } });
  const workflow = tools.find(({ name }) => name === "workflow");
  const command = commands[0]?.handler;
  assert.ok(workflow && command);
  const context = { cwd: home, mode: "rpc", hasUI: true, model: { provider: "openai", id: "gpt" }, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt" }] }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {}, select: async (_title: string, options: string[]) => { if (options.some((option) => option.includes("handoff-actions"))) return actionResults.length ? "Close" : options.find((option) => option.includes("handoff-actions")); if (options.includes("Agents...")) return actionResults.length ? "Back" : "Agents..."; if (options.some((option) => option.startsWith("#1 "))) return options.find((option) => option.startsWith("#1 ")); if (options.includes("Take over live attempt")) return "Take over live attempt"; return "Back"; }, confirm: async () => false, input: async () => undefined } };
  const running = workflow.execute("id", { name: "handoff-actions", script: "return agent('work');", foreground: true }, new AbortController().signal, undefined, context);
  await promptStarted;
  await executeCommand(command, "", context);
  await running;
  assert.deepEqual(actionResults, [{ live: true, transferred: true, steered: "continue" }]);
});
void test("host cancellation releases a navigator handoff", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-navigator-handoff-cancel-"));
  let listener: ((event: import("../src/types.js").WorkflowAgentSessionEvent) => void) | undefined;
  let releasePrompt!: () => void;
  let markPromptStarted!: () => void;
  let markActionStarted!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
  const actionStarted = new Promise<void>((resolve) => { markActionStarted = resolve; });
  const message = { role: "assistant" as const, content: [{ type: "text" as const, text: "done" }] };
  const messages = [message];
  let promptAborted = false;
  const createSession = async (): Promise<TestPiSession> => ({
    sessionId: "handoff-cancel-session",
    sessionFile: "/sessions/handoff-cancel.jsonl",
    messages,
    getSessionStats: () => ({ tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.5 }),
    subscribe(candidate) { listener = candidate; return () => { listener = undefined; }; },
    async prompt() { markPromptStarted(); listener?.({ type: "turn_start" }); await promptGate; if (!promptAborted) listener?.({ type: "turn_end", message }); },
    steer: async () => {},
    abort: async () => { promptAborted = true; releasePrompt(); listener?.({ type: "turn_end", message }); },
    dispose() {},
  });
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const baseTransport = testTransport(createSession);
  const transport: import("../src/types.js").AgentTransport = { id: "local", async createSession(prepared, context) { return baseTransport.createSession(prepared, context); } };
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, undefined, transport);
  let actionFinished = false;
  let handoffLaunched = false;
  registerWorkflowExtension({ version: "1.0.0", headline: "Handoff cancellation", agentAttemptActions: { holdHandoff: { label: "Hold handoff", visible: (context) => context.liveSession !== undefined && context.handoff !== undefined, run: async (context) => { const handoff = context.handoff; if (!handoff) throw new Error("missing handoff"); markActionStarted(); await handoff.request(async () => { handoffLaunched = true; }); actionFinished = true; } } } });
  const workflow = tools.find(({ name }) => name === "workflow");
  const command = commands[0]?.handler;
  assert.ok(workflow && command);
  const controller = new AbortController();
  const context = { cwd: home, mode: "rpc", hasUI: true, model: { provider: "openai", id: "gpt" }, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt" }] }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {}, select: async (_title: string, options: string[]) => { if (options.some((option) => option.includes("handoff-cancel"))) return actionFinished ? "Close" : options.find((option) => option.includes("handoff-cancel")); if (options.includes("Agents...")) return actionFinished ? "Back" : "Agents..."; if (options.some((option) => option.startsWith("#1 "))) return options.find((option) => option.startsWith("#1 ")); if (options.includes("Hold handoff")) return "Hold handoff"; return "Back"; }, confirm: async () => false, input: async () => undefined } };
  const running = workflow.execute("id", { name: "handoff-cancel", script: "return agent('work');", foreground: true }, controller.signal, undefined, context);
  await promptStarted;
  const navigating = executeCommand(command, "", context);
  await actionStarted;
  controller.abort();
  await navigating;
  await assert.rejects(running, (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  assert.equal(actionFinished, true);
  assert.equal(handoffLaunched, false);
});
void test("TUI navigator exposes agent-scoped worktree actions without transcript actions", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-agent-actions-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "tracked\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  const runId = `run-${"x".repeat(40)}`;
  const transcriptA = join(home, "transcript-a.jsonl");
  const transcriptB = join(home, "transcript-b.jsonl");
  const store = new RunStore(repo, "session", runId, home);
  const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "copy" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: runId, workflowName: "copy", cwd: repo, sessionId: "session", state: "completed", agents: [{ id: "agent", name: "agent", path: "agent", state: "completed", structuralPath: ["issues", "issue-65"], parentBreadcrumb: "developUntilApproved", worktreeOwner: "copy-owner", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 2, attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: "native-a", locator: { sessionFile: transcriptA } }, setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd: "/repo" }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }, { attempt: 2, transport: "local", session: { transport: "local", sessionId: "native-b", locator: { sessionFile: transcriptB } }, setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd: "/repo" }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }], agentSessions: [] }, snapshot);
  const worktree = await store.worktree("copy-owner");
  const copied: string[] = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const pi = { registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] };
  workflowExtension(testExtensionApi(pi), home, async (value) => { copied.push(value); });
  let customCalls = 0;
  let pickerCalls = 0;
  let detailActions = 0;
  const ctx = {
    cwd: repo, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify(message: string, type?: string) { notifications.push({ message, type }); },
      confirm: async () => false,
      select: async (prompt: string, options: string[]) => {
        if (prompt === "Workflows\n") { pickerCalls += 1; return pickerCalls === 1 ? options.find((option) => option.includes("copy")) ?? "Close" : "Close"; }
        if (prompt === "Agents") return options.find((option) => option.includes("#1")) ?? "Back";
        if (prompt.includes("issue-65")) { const action = ["Copy branch", "Copy worktree path", "Copy agent ID", "Back"][detailActions] ?? "Back"; detailActions += 1; return options.includes(action) ? action : "Back"; }
        return "Back";
      },
      custom: async (factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }) => {
        customCalls += 1;
        let result: string | undefined;
        const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { result = value; });
        const rendered = component.render(80).join("\n");
        assert.match(rendered, /issues/);
        assert.match(rendered, /issue-65/);
        assert.doesNotMatch(rendered, /Agents\.\.\.|copy-owner|Copy branch|Copy worktree path/);
        const selectedTreeRow = (): string => component.render(80).find((line) => line.startsWith("→")) ?? "";
        const initialTreeRow = selectedTreeRow();
        component.handleInput?.("l");
        assert.notEqual(selectedTreeRow(), initialTreeRow);
        component.handleInput?.("h");
        assert.notEqual(selectedTreeRow(), initialTreeRow);
        component.handleInput?.("h");
        assert.equal(selectedTreeRow(), initialTreeRow);
        component.handleInput?.("l");
        component.handleInput?.("l");
        // Drive action menus by label so the assertions do not depend on which
        // optional actions the environment offers (fork needs herdr).
        const chooseAction = (label: string): void => {
          for (let step = 0; step < 12; step += 1) {
            if (component.render(80).join("\n").includes(`→ ${label}`)) { component.handleInput?.("tui.select.confirm"); return; }
            component.handleInput?.("j");
          }
          throw new Error(`action not reachable: ${label}`);
        };
        if (customCalls === 1) {
          // Select the agent node, then open its actions inline (no separate picker).
          component.handleInput?.("j");
          component.handleInput?.("j");
          component.handleInput?.("j");
          component.handleInput?.("j");
          component.handleInput?.("tui.select.confirm");
          const withActions = component.render(80).join("\n");
          assert.match(withActions, /Agent actions/);
          assert.match(withActions, /Copy branch/);
          assert.match(withActions, /issue-65/, "tree must stay visible beside the actions");
          component.handleInput?.("h");
          assert.doesNotMatch(component.render(80).join("\n"), /Agent actions/);
          component.handleInput?.("tui.select.confirm");
          assert.match(component.render(80).join("\n"), /Agent actions/);
          component.handleInput?.("tui.editor.cursorLeft");
          assert.doesNotMatch(component.render(80).join("\n"), /Agent actions/);
          component.handleInput?.("tui.select.confirm");
          const selectedActionRow = (): string => component.render(80).join("\n").split("\n").find((line) => line.includes("| →")) ?? "";
          const firstActionRow = selectedActionRow();
          component.handleInput?.("j");
          component.handleInput?.("k");
          assert.equal(selectedActionRow(), firstActionRow);
          chooseAction("Copy branch");
          chooseAction("Copy worktree path");
          chooseAction("Copy agent ID");
          chooseAction("Back");
          // Back at the tree: climb to the Workflow root so run-level actions apply.
          for (let step = 0; step < 12 && !component.render(80).join("\n").split("\n").some((line) => line.startsWith("→") && line.includes("Workflow ·")); step += 1) component.handleInput?.("h");
          component.handleInput?.("tui.select.confirm");
          chooseAction("Copy run path");
        } else if (customCalls === 2) {
          component.handleInput?.("a");
          chooseAction("Copy run ID");
        } else component.handleInput?.("tui.select.cancel");
        component.dispose?.();
        return result;
      },
    },
  };
  const command = commands[0]?.handler;
  assert.ok(command);
  await executeCommand(command, "", ctx);
  assert.deepEqual(copied, [worktree.branch, worktree.path, "agent", store.directory, runId]);
  assert.ok(notifications.some(({ message }) => message === "Copied branch."));
  assert.ok(notifications.some(({ message }) => message === "Copied worktree path."));
  assert.ok(notifications.some(({ message }) => message === "Copied agent ID."));
  assert.doesNotMatch(JSON.stringify(notifications), /transcript/i);
  assert.equal(customCalls, 3);
  await store.delete(true);
});

void test("navigator stop asks for confirmation before cancelling", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-stop-confirm-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'live',description:'live'}", args: null, metadata: { name: "live", description: "live" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "live", cwd, sessionId: "session", state: "running", agents: [], agentSessions: [] }, snapshot);
  await store.saveOwnership([{ id: "run:1", label: "worker", state: "running", options: { label: "worker", cwd, tools: [] } }]);
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const confirmations: string[] = [];
  const blockedEvents: unknown[] = [];
  let customCalls = 0;
  let pickerCalls = 0;
  let disposed = false;
  let closeNavigator = () => {};
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; }, events: { emit(name: string, data: unknown) { if (name === WORKFLOW_BLOCKED_EVENT) blockedEvents.push(data); } }, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  assert.ok(start && commands[0]);
  const ctx = {
    cwd, mode: "tui", hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify() {}, setStatus() {}, confirm: async (_title: string, message: string) => { confirmations.push(message); return false; },
      select: async (prompt: string, options: string[]) => { if (prompt === "Workflow actions") return "Stop"; if (prompt !== "Workflows\n") return options[0] ?? "Close"; pickerCalls += 1; return pickerCalls === 1 ? options[0] ?? "Close" : "Close"; },
      custom: async (factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }, options?: { overlay?: boolean; overlayOptions?: { width?: string; maxHeight?: string } }) => {
        customCalls += 1;
        assert.equal(options?.overlay, undefined);
        assert.equal(options?.overlayOptions, undefined);
        let result: string | undefined;
        let resolveCustom!: (value: string | undefined) => void;
        const completed = new Promise<string | undefined>((resolve) => { resolveCustom = resolve; });
        const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { disposed = true; result = value; resolveCustom(value); });
        closeNavigator = () => component.handleInput?.("tui.select.cancel");
        if (customCalls === 1) { component.handleInput?.("a"); component.handleInput?.("tui.select.down"); component.handleInput?.("tui.select.confirm"); } else component.handleInput?.("tui.select.cancel");
        await completed;
        component.dispose?.();
        return result;
      },
    },
  };
  const command = commands[0];
  assert.ok(command);
  await start({}, ctx);
  const pending = executeCommand(command.handler, "", ctx);
  for (let attempt = 0; attempt < 100 && confirmations.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0] ?? "", /live|run/);
  assert.equal(disposed, false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (let attempt = 0; attempt < 20; attempt += 1) { closeNavigator(); await new Promise((resolve) => setTimeout(resolve, 10)); }
  await pending;
  assert.deepEqual(blockedEvents, [{ active: true, label: "Stop workflow?" }, { active: false }]);
  assert.equal(customCalls, 1);
  assert.equal((await store.load()).run.state, "interrupted");
  assert.deepEqual((await store.loadOwnership()).map(({ state }) => state), ["running"]);
});

void test("navigator stop stays visible through cleanup, then closes", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-stop-progress-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'live',description:'live'}", args: null, metadata: { name: "live", description: "live" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "live", cwd, sessionId: "session", state: "running", agents: [], agentSessions: [] }, snapshot);
  await store.saveOwnership([{ id: "run:1", label: "worker", state: "running", options: { label: "worker", cwd, tools: [] } }]);
  let releaseCleanup = () => {};
  let cleanupStarted = false;
  const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  delayedOwnership.set(store.directory, { start: () => { cleanupStarted = true; }, cleanup });
  const isCleanupStarted = () => cleanupStarted;
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const confirmations: string[] = [];
  const statuses: Array<string | undefined> = [];
  const notices: string[] = [];
  let componentDisposed = false;
  let pickerCalls = 0;
  let rendered = "";
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; }, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  assert.ok(start && commands[0]);
  const ctx = {
    cwd, mode: "tui", hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify(message: string) { notices.push(message); }, setStatus(_key: string, text: string | undefined) { statuses.push(text); }, confirm: async (_title: string, message: string) => { confirmations.push(message); return true; },
      select: async (prompt: string, options: string[]) => { if (prompt === "Workflow actions") return "Stop"; if (prompt !== "Workflows\n") return options[0] ?? "Close"; pickerCalls += 1; return pickerCalls === 1 ? options[0] ?? "Close" : "Close"; },
      custom: async (factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }, options?: { overlay?: boolean }) => {
        assert.equal(options?.overlay, undefined);
        let result: string | undefined;
        let resolveCustom!: (value: string | undefined) => void;
        const completed = new Promise<string | undefined>((resolve) => { resolveCustom = resolve; });
        const component = factory({ requestRender() { rendered = component.render(200).join("\n"); } }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { componentDisposed = true; result = value; resolveCustom(value); });
        if (componentDisposed) component.handleInput?.("tui.select.cancel"); else { component.handleInput?.("a"); component.handleInput?.("tui.select.down"); component.handleInput?.("tui.select.confirm"); component.handleInput?.("tui.select.confirm"); }
        await completed;
        component.dispose?.();
        return result;
      },
    },
  };
  const command = commands[0];
  assert.ok(command);
  await start({}, ctx);
  const pending = executeCommand(command.handler, "", ctx);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (isCleanupStarted()) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(isCleanupStarted(), true);
  assert.equal(componentDisposed, false);
  assert.match(rendered, /Stopping workflow live/);
  assert.equal(confirmations.length, 1);
  assert.equal((await store.load()).run.state, "stopped");
  releaseCleanup();
  await Promise.race([pending, new Promise<never>((_resolve, reject) => setTimeout(() => { reject(new Error("navigator did not close after stop")); }, 1_000))]);
  assert.equal(componentDisposed, true);
  delayedOwnership.delete(store.directory);
  assert.deepEqual((await store.loadOwnership()).map(({ state }) => state), ["cancelled"]);
  assert.ok(statuses.some((status) => status?.includes("Stopping workflow")));
  assert.ok(statuses.some((status) => status?.includes("Workflow run stopped")));
  assert.equal(statuses.at(-1), undefined);
  assert.ok(notices.some((notice) => notice.includes("Stopped workflow run.")));
});
void test("non-TUI navigator Stop confirms before cancelling", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-stop-select-confirm-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "select-stop" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "select-stop", cwd, sessionId: "session", state: "running", agents: [], agentSessions: [] }, snapshot);
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let selectCalls = 0;
  let confirmations = 0;
  const notices: string[] = [];
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; }, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  const ctx = {
    cwd, mode: "rpc", hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify(message: string) { notices.push(message); },
      confirm: async () => { confirmations += 1; return true; },
      select: async (_prompt: string, options: string[]) => {
        selectCalls += 1;
        if (selectCalls === 1) return "Skip";
        if (selectCalls === 2) return options.find((option) => option.includes("select-stop")) ?? "Close";
        if (selectCalls === 3) return options.find((option) => option === "Stop") ?? "Close";
        if (selectCalls === 4) return "Back";
        return "Close";
      },
    },
  };
  assert.ok(start && commands[0]);
  await start({}, ctx);
  await executeCommand(commands[0].handler, "", ctx);
  assert.equal(confirmations, 1);
  assert.equal((await store.load()).run.state, "stopped");
  assert.ok(notices.some((notice) => notice.includes("Stopped workflow run.")));
});

void test("navigator dashboard auto-refreshes the selected run", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-refresh-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'live',description:'live'}", args: null, metadata: { name: "live", description: "live" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "live", cwd, sessionId: "session", state: "running", phase: "before", agents: [], agentSessions: [] }, snapshot);
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  let selectCall = 0;
  let refreshRenders = 0;
  const ctx = {
    cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify() {}, confirm: async () => false,
      select: async (_prompt: string, options: string[]) => { selectCall += 1; return selectCall === 1 ? options[0] : "Close"; },
      custom: async (factory: (tui: { terminal: { rows: number }; requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }) => {
        const component = factory({ terminal: { rows: 8 }, requestRender() { refreshRenders += 1; } }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, () => {});
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.down");
        const before = component.render(200);
        assert.ok(before.length <= 8);
        assert.match(before.join("\n"), /phase: before/);
        assert.match(before.join("\n"), /Tree/);
        const loaded = await store.load();
        const agents = Array.from({ length: 12 }, (_, index) => ({ id: `agent-${String(index)}`, name: `agent-${String(index)}`, path: `agent-${String(index)}`, state: "running" as const, model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 }));
        await store.saveState({ ...loaded.run, phase: "after", agents });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const grown = component.render(200);
        assert.ok(grown.length <= 8);
        assert.match(grown.join("\n"), /phase: after/);
        assert.match(grown.join("\n"), /Tree/);
        component.handleInput?.("tui.editor.cursorRight");
        component.handleInput?.("tui.editor.cursorRight");
        for (let index = 0; index < 12; index += 1) component.handleInput?.("tui.select.down");
        const bottom = component.render(200);
        assert.ok(bottom.length <= 8);
        assert.match(bottom.join("\n"), /agent-11/);
        const terminalRefreshStart = refreshRenders;
        const mixed = await store.load();
        await store.saveState({ ...mixed.run, state: "failed", agents: mixed.run.agents });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const mixedTerminalRefreshCount = refreshRenders;
        assert.ok(mixedTerminalRefreshCount > terminalRefreshStart);
        const settled = await store.load();
        await store.saveState({ ...settled.run, agents: settled.run.agents.map((agent) => ({ ...agent, state: "cancelled" as const })) });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const compact = component.render(200);
        assert.ok(compact.length <= 8);
        assert.match(compact.join("\n"), /agent-11/);
        assert.doesNotMatch(compact.join("\n"), /→ Stop/);
        assert.ok(refreshRenders > mixedTerminalRefreshCount);
        const terminalRefreshCount = refreshRenders;
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.equal(refreshRenders, terminalRefreshCount);
        component.dispose?.();
        return undefined;
      },
    },
  };
  await executeCommand(commands[0]?.handler, "", ctx);
});
void test("navigator returns to the picker after cancelling a recovered run dashboard", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-actions-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "actions" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "actions", cwd, sessionId: "session", state: "running", agents: [], agentSessions: [] }, snapshot);
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const notices: string[] = [];
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; }, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  const sessionContext = { cwd, hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify(message: string) { notices.push(message); } } };
  assert.ok(start);
  await start({}, sessionContext);
  let pickerCalls = 0;
  let customCalls = 0;
  const ctx = { ...sessionContext, mode: "tui", ui: {
    notify(message: string) { notices.push(message); }, confirm: async () => false,
    select: async (_prompt: string, options: string[]) => { pickerCalls += 1; return pickerCalls === 1 ? options[0] : "Close"; },
    custom: async (factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }) => {
      customCalls += 1;
      let result: string | undefined;
      const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { result = value; });
      const dashboard = component.render(200).join("\n");
      assert.match(dashboard, /interrupted/);
      assert.match(dashboard, /Tree/);
      const narrowTree = component.render(79).join("\n");
      assert.match(narrowTree, /enter run actions/);
      component.handleInput?.("tui.select.confirm");
      assert.match(component.render(40).join("\n"), /Run actions/);
      component.handleInput?.("tui.select.cancel");
      component.handleInput?.("a");
      assert.match(component.render(200).join("\n"), /Resume/);
      component.handleInput?.("tui.select.cancel");
      component.handleInput?.("tui.select.cancel");
      assert.equal(result, "Back");
      component.dispose?.();
      return result;
    },
  } };
  await executeCommand(commands[0]?.handler, "", ctx);
  assert.equal(pickerCalls, 2);
  assert.equal(customCalls, 1);
  assert.equal((await store.load()).run.state, "interrupted");
});
void test("navigator keeps consecutive checkpoint decisions in the same dashboard", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-checkpoint-actions-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "checkpoints" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "checkpoints", cwd, sessionId: "session", state: "awaiting_input", agents: [], agentSessions: [] }, snapshot);
  await store.awaitCheckpoint({ path: "checkpoint/ship", name: "ship", prompt: "Ship?", context: null });
  await store.awaitCheckpoint({ path: "checkpoint/deploy", name: "deploy", prompt: "Deploy?", context: null });
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) { commands.push(options); }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; }, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"], sendMessage() {} }), home);
  const sessionContext = { cwd, hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {}, select: async () => "Skip" } };
  assert.ok(start);
  await start({}, sessionContext);
  let customCalls = 0;
  let pickerCalls = 0;
  const ctx = { ...sessionContext, mode: "tui", ui: {
    notify() {}, confirm: async () => false, select: async (prompt: string, options: string[]) => { if (prompt === "Workflow actions") return options.find((option) => option.startsWith("Review ")) ?? options[0]; pickerCalls += 1; return pickerCalls === 1 ? options[0] : "Close"; },
    custom: async (factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }) => {
      customCalls += 1;
      let result: string | undefined;
      const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { result = value; });
      const dashboard = component.render(200).join("\n");
      if (customCalls === 1) {
        assert.match(dashboard, /Tree/);
        component.handleInput?.("a");
        assert.match(component.render(200).join("\n"), /→ Resume/);
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.down");
        assert.match(component.render(200).join("\n"), /→ Review ship/);
        component.handleInput?.("tui.select.confirm");
      } else if (customCalls === 2) {
        assert.match(dashboard, /Name: ship/);
        component.handleInput?.("tui.select.confirm");
      } else if (customCalls === 3) {
        assert.match(dashboard, /Tree/);
        component.handleInput?.("a");
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.confirm");
      } else if (customCalls === 4) {
        assert.match(dashboard, /Name: deploy/);
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.confirm");
      } else {
        assert.match(dashboard, /interrupted/);
        component.handleInput?.("tui.select.cancel");
      }
      component.dispose?.();
      return result;
    },
  } };
  await executeCommand(commands[0]?.handler, "", ctx);
  assert.equal(customCalls, 5);
  assert.deepEqual(await store.replay("checkpoint/ship"), { path: "checkpoint/ship", value: true });
  assert.deepEqual(await store.replay("checkpoint/deploy"), { path: "checkpoint/deploy", value: false });
});
void test("navigator returns to the picker after deleting a run", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-delete-actions-"));
  const cwd = join(home, "project");
  const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "delete", }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  const oldStore = new RunStore(cwd, "session", "old", home);
  const keepStore = new RunStore(cwd, "session", "keep", home);
  await oldStore.create({ id: "old", workflowName: "old", cwd, sessionId: "session", state: "completed", agents: [], agentSessions: [] }, snapshot);
  await keepStore.create({ id: "keep", workflowName: "keep", cwd, sessionId: "session", state: "completed", agents: [], agentSessions: [] }, snapshot);
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const pickerOptions: string[][] = [];
  let pickerCalls = 0;
  let customCalls = 0;
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  const ctx = { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" }, ui: { notify() {}, confirm: async () => true, select: async (prompt: string, options: string[]) => { if (prompt === "Workflow actions") return "Delete"; pickerCalls += 1; pickerOptions.push(options); return pickerCalls === 1 ? options.find((option) => option.includes("old")) : "Close"; }, custom: async (factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }) => {
      customCalls += 1;
      let result: string | undefined;
      const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { result = value; });
      assert.match(component.render(200).join("\n"), /Tree/);
      component.handleInput?.("a");
      component.handleInput?.("tui.select.down");
      component.handleInput?.("tui.select.confirm");
      component.dispose?.();
      return result;
    } } };
  await executeCommand(commands[0]?.handler, "", ctx);
  assert.equal(customCalls, 1);
  assert.equal(pickerCalls, 2);
  assert.ok(pickerOptions[1]?.some((option) => option.includes("keep")));
  assert.doesNotMatch(pickerOptions[1]?.join("\n") ?? "", /old/);
  assert.equal(existsSync(oldStore.directory), false);
  assert.equal(existsSync(keepStore.directory), true);
});
void test("navigator opens the workflow script in the configured external editor", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-external-editor-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const script = ["// SCRIPT_START", ...Array.from({ length: 20 }, (_, index) => `const line${String(index)} = ${String(index)};`), "// SCRIPT_END"].join("\n");
  const snapshot = createLaunchSnapshot({ script, args: null, metadata: { name: "viewer", description: "viewer" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "viewer", cwd, sessionId: "session", state: "running", phase: "view", agents: [], agentSessions: [] }, snapshot);
  const editorPath = join(home, "fake-editor.sh");
  const editedPath = join(home, "edited-content");
  const openedPath = join(home, "opened-path");
  writeFileSync(editorPath, "#!/bin/sh\nprintf '%s' \"$3\" > \"$2\"\ncat \"$3\" > \"$1\"\n", { encoding: "utf8", mode: 0o755 });
  const previousVisual = process.env.VISUAL;
  const previousEditor = process.env.EDITOR;
  process.env.VISUAL = `${editorPath} ${editedPath} ${openedPath}`;
  process.env.EDITOR = process.env.VISUAL;
  let stops = 0;
  let pickerCalls = 0;
  let starts = 0;
  let renders = 0;
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home, undefined, undefined, join(home, "agent"));
  const ctx = {
    cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" },
    ui: {
      select: async (_prompt: string, options: string[]) => { pickerCalls += 1; return pickerCalls === 1 ? options[0] ?? "Close" : "Close"; },
      custom: async (factory: (tui: { terminal: { rows: number }; stop(): void; start(): void; requestRender(force?: boolean): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }) => {
        const component = factory({ terminal: { rows: 8 }, stop() { stops += 1; }, start() { starts += 1; }, requestRender() { renders += 1; } }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, () => {});
        component.handleInput?.("a");
        for (let step = 0; step < 12; step += 1) {
          if (component.render(80).join("\n").includes("→ Open script in editor")) { component.handleInput?.("tui.select.confirm"); break; }
          component.handleInput?.("tui.select.down");
        }
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          if (starts === 1 && existsSync(editedPath) && readFileSync(editedPath, "utf8").includes("SCRIPT_START")) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(existsSync(editedPath), "external editor was not invoked");
        assert.match(readFileSync(editedPath, "utf8"), /SCRIPT_START/);
        assert.match(readFileSync(editedPath, "utf8"), /SCRIPT_END/);
        assert.match(readFileSync(openedPath, "utf8"), /artifact.*\.js$/);
        component.dispose?.();
        return undefined;
      },
    },
  };
  try {
    await executeCommand(commands[0]?.handler, "", ctx);
    assert.equal(stops, 1);
    assert.equal(starts, 1);
    assert.ok(renders > 0);
    assert.equal(existsSync(join(store.directory, "workflow.js")), true);
  } finally {
    if (previousVisual === undefined) delete process.env.VISUAL; else process.env.VISUAL = previousVisual;
    if (previousEditor === undefined) delete process.env.EDITOR; else process.env.EDITOR = previousEditor;
  }
});
void test("external artifact failures restore the TUI and remove temporary copies", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-external-editor-failure-"));
  const editorPath = join(home, "failing-editor.sh");
  const openedPath = join(home, "opened-path");
  writeFileSync(editorPath, "#!/bin/sh\nprintf '%s' \"$2\" > \"$1\"\nexit 7\n", { encoding: "utf8", mode: 0o755 });
  const events: string[] = [];
  const tui = { stop() { events.push("stop"); }, start() { events.push("start"); }, requestRender() { events.push("render"); } };
  const exitCode = await openWorkflowArtifact(tui, `${editorPath} ${openedPath}`, { extension: ".md", content: "read-only" });
  assert.equal(exitCode, 7);
  const opened = readFileSync(openedPath, "utf8");
  assert.equal(existsSync(opened), false);
  assert.deepEqual(events, ["stop", "start", "render"]);
  assert.equal(await openWorkflowArtifact(tui, join(home, "missing-editor"), { extension: ".js", content: "return true;" }), null);
  assert.deepEqual(events, ["stop", "start", "render", "stop", "start", "render"]);
});
void test("navigator opens a persisted top-level agent prompt and result in the external editor", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-agent-result-editor-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const resultPath = "agent/reviewer/callsite%3Areviewer/occurrence%3A1";
  const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "agent-result" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "agent-result", cwd, sessionId: "session", state: "completed", phase: "review", agents: [{ id: "agent", name: "reviewer", path: "agent", state: "completed", prompt: "PROMPT_START\nInspect the target\nPROMPT_END", systemPrompt: "SYSTEM_PROMPT_START\nFollow the workflow\nSYSTEM_PROMPT_END", resultPath, structuralPath: ["reviewer"], model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 }], agentSessions: [] }, snapshot);
  await store.complete(resultPath, { answer: 42 });
  const editorPath = join(home, "fake-editor.sh");
  const editedPath = join(home, "edited-content");
  const openedPath = join(home, "opened-path");
  writeFileSync(editorPath, "#!/bin/sh\nprintf '%s' \"$3\" > \"$2\"\ncat \"$3\" > \"$1\"\n", { encoding: "utf8", mode: 0o755 });
  const previousVisual = process.env.VISUAL;
  const previousEditor = process.env.EDITOR;
  process.env.VISUAL = `${editorPath} ${editedPath} ${openedPath}`;
  process.env.EDITOR = process.env.VISUAL;
  let stops = 0;
  let starts = 0;
  let pickerCalls = 0;
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  const ctx = {
    cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" },
    ui: {
      select: async (_prompt: string, options: string[]) => { pickerCalls += 1; return pickerCalls === 1 ? options[0] ?? "Close" : "Close"; },
      custom: async (factory: (tui: { terminal: { rows: number }; stop(): void; start(): void; requestRender(force?: boolean): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }) => {
        const component = factory({ terminal: { rows: 10 }, stop() { stops += 1; }, start() { starts += 1; }, requestRender() {} }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, () => {});
        const phase = component.render(120).join("\n");
        assert.doesNotMatch(phase, /Open result in editor/);
        component.handleInput?.("tui.select.down");
        assert.doesNotMatch(component.render(120).join("\n"), /Open result in editor/);
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.confirm");
        const actions = component.render(120).join("\n");
        assert.match(actions, /Agent actions/);
        assert.match(actions, /Open prompt in editor/);
        const waitForStarts = async (expected: number) => {
          const deadline = Date.now() + 5_000;
          while (starts < expected && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
          assert.equal(starts, expected);
        };
        const openAction = async (label: string) => {
          const deadline = Date.now() + 5_000;
          while (Date.now() < deadline) {
            if (component.render(120).join("\n").includes(`→ ${label}`)) { component.handleInput?.("tui.select.confirm"); return; }
            component.handleInput?.("tui.select.down");
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          assert.fail(`Timed out selecting ${label}`);
        };
        await openAction("Open system prompt in editor");
        let deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          if (existsSync(editedPath) && readFileSync(editedPath, "utf8").includes("SYSTEM_PROMPT_START")) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(existsSync(editedPath), "external editor was not invoked for the system prompt");
        assert.match(readFileSync(editedPath, "utf8"), /SYSTEM_PROMPT_START[\s\S]*SYSTEM_PROMPT_END/);
        assert.match(readFileSync(openedPath, "utf8"), /artifact.*\.md$/);
        await waitForStarts(1);
        await openAction("Open prompt in editor");
        deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          if (existsSync(editedPath) && readFileSync(editedPath, "utf8").includes("PROMPT_START")) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(existsSync(editedPath), "external editor was not invoked for the prompt");
        assert.match(readFileSync(editedPath, "utf8"), /PROMPT_START[\s\S]*PROMPT_END/);
        assert.match(readFileSync(openedPath, "utf8"), /artifact.*\.md$/);
        await waitForStarts(2);
        await openAction("Open result in editor");
        deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          if (existsSync(editedPath) && readFileSync(editedPath, "utf8").includes("\"answer\": 42")) break;
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        assert.ok(existsSync(editedPath), "external editor was not invoked for the result");
        assert.match(readFileSync(editedPath, "utf8"), /"answer": 42/);
        assert.match(readFileSync(openedPath, "utf8"), /artifact.*\.json$/);
        const artifactPath = readFileSync(openedPath, "utf8");
        const cleanupDeadline = Date.now() + 5_000;
        while (existsSync(artifactPath) && Date.now() < cleanupDeadline) await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(existsSync(artifactPath), false);
        await waitForStarts(3);
        component.dispose?.();
        return undefined;
      },
    },
  };
  try {
    await executeCommand(commands[0]?.handler, "", ctx);
    assert.equal(stops, 3);
    assert.equal(starts, 3);
  } finally {
    if (previousVisual === undefined) delete process.env.VISUAL; else process.env.VISUAL = previousVisual;
    if (previousEditor === undefined) delete process.env.EDITOR; else process.env.EDITOR = previousEditor;
  }
});
void test("navigator omits transcript actions outside and inside Herdr", async () => {
  const previousEnvironment = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID };
  try {
    for (const inHerdr of [false, true]) {
      process.env.HERDR_ENV = inHerdr ? "1" : "0";
      if (inHerdr) process.env.HERDR_PANE_ID = "navigator-test-pane"; else delete process.env.HERDR_PANE_ID;
      const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-transcript-actions-"));
      const cwd = join(home, "project");
      mkdirSync(cwd);
      const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "navigator" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
      const noAgent = new RunStore(cwd, "session", "no-agent-run", home);
      await noAgent.create({ id: "no-agent-run", workflowName: "no-agent-run", cwd, sessionId: "session", state: "completed", agents: [], agentSessions: [{ transport: "local", sessionId: "native", locator: { sessionFile: join(home, "native.jsonl") } }] }, snapshot);
      const withAgent = new RunStore(cwd, "session", "agent-run", home);
      await withAgent.create({ id: "agent-run", workflowName: "agent-run", cwd, sessionId: "session", state: "completed", agents: [{ id: "agent", name: "agent", path: "agent", state: "completed", resultPath: "agent/result", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1, attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: "native-agent", locator: { sessionFile: join(home, "agent.jsonl") } }, setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd: "/repo" }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }], agentSessions: [] }, snapshot);
      await withAgent.complete("agent/result", { done: true });
      const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
      workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
      const dashboardActions: string[][] = [];
      const agentActions: string[][] = [];
      const workflowPickers: string[][] = [];
      let workflowSelection = 0;
      const ctx = {
        cwd, mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "session" },
        ui: {
          notify() {},
          confirm: async () => false,
          select: async (prompt: string, options: string[]) => {
            if (prompt === "Workflows\n") {
              workflowPickers.push(options);
              workflowSelection += 1;
              if (workflowSelection > 2) return "Close";
              const target = workflowSelection === 1 ? "agent-run" : "no-agent-run";
              return options.find((option) => option.includes(target)) ?? "Close";
            }
            if (prompt === "Agents") return options[0] ?? "Back";
            if (options.includes("Copy agent ID")) { agentActions.push(options); return "Back"; }
            if (agentActions.length === 0 && options.includes("Agents...")) return "Agents...";
            dashboardActions.push(options);
            return "Back";
          },
        },
      };
      const command = commands[0]?.handler;
      assert.ok(command);
      await executeCommand(command, "", ctx);
      await executeCommand(command, "", ctx);
      const renderedActions = dashboardActions.flat().join("\n");
      const runPicker = workflowPickers[0] ?? [];
      assert.equal(runPicker.includes("Inspect session in pane"), false);
      assert.doesNotMatch(renderedActions, /View transcript|Transcript paths|Copy transcript path|Open transcript in pane/);
      assert.equal(agentActions.length, 1);
      const selectedAgentActions = agentActions[0];
      assert.ok(selectedAgentActions);
      assert.equal(selectedAgentActions.includes("Open result in editor"), false);
      assert.equal(selectedAgentActions.includes("Fork as Pi session in pane"), false);
      assert.ok(selectedAgentActions.includes("Copy agent ID"));
      await noAgent.delete(true);
      await withAgent.delete(true);
    }
  } finally {
    if (previousEnvironment.HERDR_ENV === undefined) delete process.env.HERDR_ENV; else process.env.HERDR_ENV = previousEnvironment.HERDR_ENV;
    if (previousEnvironment.HERDR_PANE_ID === undefined) delete process.env.HERDR_PANE_ID; else process.env.HERDR_PANE_ID = previousEnvironment.HERDR_PANE_ID;
  }
});


void test("navigator attention-orders runs, disambiguates names, shows breadcrumbs and bulk delete", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-navigator-v2-"));
  const cwd = join(home, "project");
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'build',description:'b'}", args: null, metadata: { name: "build", description: "b" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: ["read"], agentTypes: [], schemas: [] });
  const storeA = new RunStore(cwd, "s", "aaaa-1111-2222-3333", home);
  await storeA.create({ id: "aaaa-1111-2222-3333", workflowName: "build", cwd, sessionId: "s", state: "completed", agents: [{ id: "a:1", name: "scout", path: "a:1", state: "completed", model: { provider: "openai", model: "gpt" }, tools: ["read"], attempts: 1, accounting: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 } }], agentSessions: [] }, snapshot);
  const storeB = new RunStore(cwd, "s", "bbbb-1111-2222-3333", home);
  await storeB.create({ id: "bbbb-1111-2222-3333", workflowName: "build", cwd, sessionId: "s", state: "running", phase: "review", agents: [{ id: "b:1", name: "root", path: "b:1", state: "completed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 }, { id: "b:2", name: "child", path: "b:2", state: "running", parentId: "b:1", role: "reviewer", model: { provider: "openai", model: "gpt", thinking: "high" }, tools: ["read"], attempts: 1, attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: "active", locator: { sessionFile: "/sessions/active.jsonl" } }, setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd: "/repo" }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }], accounting: { input: 10, output: 5, cacheRead: 20, cacheWrite: 2, cost: 0.04 }, toolCalls: [{ id: "tc1", name: "read", state: "running" }], activity: { kind: "reasoning", text: "checking source" } }], agentSessions: [{ transport: "local", sessionId: "active", locator: { sessionFile: "/sessions/active.jsonl" } }] }, snapshot);
  const storeC = new RunStore(cwd, "s", "cccc-1111-2222-3333", home);
  await storeC.create({ id: "cccc-1111-2222-3333", workflowName: "deploy", cwd, sessionId: "s", state: "failed", agents: [{ id: "c:1", name: "deployer", path: "c:1", state: "failed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 2, attemptDetails: [{ attempt: 2, transport: "local", session: { transport: "local", sessionId: "n", locator: { sessionFile: "/n" } }, setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd: "/repo" }, error: { code: "AGENT_FAILED", message: "timeout" }, accounting: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }], agentSessions: [] }, snapshot);

  // Dashboard with breadcrumbs and inline errors
  const dashB = formatNavigatorDashboard((await storeB.load()).run, [], []);
  assert.match(dashB, /root > child/);
  assert.match(dashB, /phase: review/);
  assert.match(dashB, /1\/2 agents/);
  assert.match(dashB, /37 tok/);
  assert.match(dashB, /reasoning · checking source/);
  assert.match(dashB, /⠦ root > child · running · 37 tok/);
  assert.doesNotMatch(dashB, /model=|requested=|tools=|role=/);
  assert.doesNotMatch(dashB, /cache read|transcript attempt/);

  const dashC = formatNavigatorDashboard((await storeC.load()).run, [], []);
  assert.match(dashC, /error: AGENT_FAILED: timeout/);

  // Interactive: attention order + name disambiguation + bulk delete
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const prompts: string[] = [];
  const selections: string[][] = [];
  const pi = { registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["read", "workflow"] };
  workflowExtension(testExtensionApi(pi), home);
  let selectCall = 0;
  const confirmResult = true;
  const notified: string[] = [];
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => "s" }, ui: { notify(msg: string) { notified.push(msg); }, select: async (_prompt: string, options: string[]) => { prompts.push(_prompt); selections.push(options); selectCall += 1; if (selectCall === 1) return "Delete all completed"; return "Close"; }, confirm: async () => confirmResult } };
  const command = commands[0]?.handler;
  assert.ok(command);
  await executeCommand(command, "", ctx);

  // Verify attention order: running (build bbbb) before failed (deploy) before completed (build aaaa)
  const pickerOptions = selections[0] ?? [];
  assert.ok(pickerOptions.length >= 4);
  const runningIdx = pickerOptions.findIndex((o) => o.includes("running"));
  const failedIdx = pickerOptions.findIndex((o) => o.includes("failed"));
  const completedIdx = pickerOptions.findIndex((o) => o.includes("completed"));
  assert.ok(runningIdx < failedIdx, `running (${String(runningIdx)}) should come before failed (${String(failedIdx)})`);
  assert.ok(failedIdx < completedIdx, `failed (${String(failedIdx)}) should come before completed (${String(completedIdx)})`);

  // Verify name disambiguation: both 'build' runs get 8-char suffix
  const buildRows = pickerOptions.filter((o) => o.includes("build"));
  assert.equal(buildRows.length, 2);
  assert.ok(buildRows.every((r) => r.includes("aaaa-111") || r.includes("bbbb-111")), `Build rows should have suffixes: ${buildRows.join("; ")}`);

  // Verify 'Delete all completed' was offered
  assert.ok(pickerOptions.includes("Delete all completed"));

  // Verify bulk delete removed the completed run
  assert.ok(notified.some((n) => n.includes("Deleted all completed")));
  assert.equal(existsSync(storeA.directory), false);
  assert.equal(existsSync(storeB.directory), true);
  assert.equal(existsSync(storeC.directory), true);
});
void test("navigator bulk deletes only failed runs after confirmation", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-navigator-failed-bulk-"));
  const cwd = join(home, "project");
  const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "bulk", description: "bulk" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  const states = ["failed", "failed", "completed", "stopped", "running", "interrupted", "budget_exhausted"] as const;
  const stores = await Promise.all(states.map(async (state, index) => {
    const store = new RunStore(cwd, "session", `bulk-${String(index)}`, home);
    await store.create({ id: store.runId, workflowName: "bulk", cwd, sessionId: "session", state, agents: [], agentSessions: [] }, snapshot);
    return store;
  }));
  const failedArtifact = await stores[0]?.saveResult({ owned: true });
  assert.ok(failedArtifact && existsSync(failedArtifact));
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const selections: string[][] = [];
  const notifications: string[] = [];
  let selectCall = 0;
  let confirmCall = 0;
  const pi = { registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] };
  workflowExtension(testExtensionApi(pi), home);
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => "session" }, ui: { notify(message: string) { notifications.push(message); }, select: async (_prompt: string, options: string[]) => { selections.push(options); selectCall += 1; return selectCall < 3 ? "Delete all failed" : "Close"; }, confirm: async (title: string, message: string) => { confirmCall += 1; if (confirmCall === 1) { assert.equal(title, "Delete failed runs?"); assert.match(message, /cannot be undone/); assert.equal(existsSync(stores[0]?.directory ?? ""), true); assert.equal(existsSync(stores[1]?.directory ?? ""), true); } return confirmCall === 2; } } };
  const command = commands[0]?.handler;
  assert.ok(command);
  await executeCommand(command, "", ctx);
  assert.ok(selections[0]?.includes("Delete all failed"));
  assert.ok(selections[1]?.includes("Delete all failed"));
  assert.ok(!selections[2]?.includes("Delete all failed"));
  assert.equal(confirmCall, 2);
  assert.equal(existsSync(stores[0]?.directory ?? ""), false);
  assert.equal(existsSync(stores[1]?.directory ?? ""), false);
  assert.equal(existsSync(failedArtifact), false);
  for (const store of stores.slice(2)) assert.equal(existsSync(store.directory), true);
  assert.ok(notifications.some((message) => message.includes("Deleted all failed workflow runs.")));
});
void test("navigator remains usable when retry provenance is unavailable", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-navigator-missing-retry-source-"));
  const cwd = join(home, "project");
  const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "broken-retry" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  const store = new RunStore(cwd, "session", "broken-retry", home);
  await store.create({ id: "broken-retry", workflowName: "broken-retry", cwd, sessionId: "session", state: "failed", retry: { sourceRunId: "deleted-source", lineageRootRunId: "broken-retry", completedPaths: [], incompletePaths: [], namedWorktrees: [] }, agents: [], agentSessions: [] }, snapshot);
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const selections: string[][] = [];
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  const ctx = { cwd, mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "session" }, ui: { notify() {}, confirm: async () => false, select: async (prompt: string, options: string[]) => { selections.push(options); if (prompt === "Workflows\n") return selections.length === 1 ? options[0] ?? "Close" : "Close"; return "Back"; } } };
  const command = commands[0]?.handler;
  assert.ok(command);
  await assert.doesNotReject(executeCommand(command, "", ctx));
  assert.ok(selections.length >= 2);
  assert.ok(selections[1]?.includes("Delete"));
});

void test("navigator stop reports cleanup failures without closing unexpectedly", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-stop-failure-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'broken',description:'broken'}", args: null, metadata: { name: "broken", description: "broken" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "broken", cwd, sessionId: "session", state: "running", agents: [], agentSessions: [] }, snapshot);
  await store.saveOwnership([{ id: "run:1", label: "worker", state: "running", options: { label: "worker", cwd, tools: [] } }]);
  failedOwnership.add(store.directory);
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const notices: string[] = [];
  const statuses: Array<string | undefined> = [];
  let customCalls = 0;
  let pickerCalls = 0;
  let componentDisposed = false;
  let rendered = "";
  let closeNavigator = () => {};
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; }, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  assert.ok(start && commands[0]);
  const ctx = {
    cwd, mode: "tui", hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify(message: string) { notices.push(message); }, setStatus(_key: string, text: string | undefined) { statuses.push(text); }, confirm: async () => true,
      select: async (prompt: string, options: string[]) => { if (prompt === "Workflow actions") return "Stop"; if (prompt !== "Workflows\n") return options[0] ?? "Close"; pickerCalls += 1; return pickerCalls === 1 ? options[0] ?? "Close" : "Close"; },
      custom: async (factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }, options?: { overlay?: boolean }) => {
        customCalls += 1;
        assert.equal(options?.overlay, undefined);
        let result: string | undefined;
        let resolveCustom!: (value: string | undefined) => void;
        const completed = new Promise<string | undefined>((resolve) => { resolveCustom = resolve; });
        const component = factory({ requestRender() { rendered = component.render(200).join("\n"); } }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { componentDisposed = true; result = value; resolveCustom(value); });
        closeNavigator = () => component.handleInput?.("tui.select.cancel");
        if (componentDisposed) component.handleInput?.("tui.select.cancel"); else { component.handleInput?.("a"); component.handleInput?.("tui.select.down"); component.handleInput?.("tui.select.confirm"); }
        await completed;
        component.dispose?.();
        return result;
      },
    },
  };
  const command = commands[0];
  assert.ok(command);
  await start({}, ctx);
  const pending = executeCommand(command.handler, "", ctx);
  for (let attempt = 0; attempt < 100 && !statuses.some((status) => status?.includes("Could not stop workflow")); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(statuses.some((status) => status?.includes("Could not stop workflow")));
  assert.equal(componentDisposed, false);
  assert.match(rendered, /scheduler cleanup failed/);
  assert.ok(statuses.some((status) => status?.includes("scheduler cleanup failed")));
  failedOwnership.delete(store.directory);
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (let attempt = 0; attempt < 20; attempt += 1) { closeNavigator(); await new Promise((resolve) => setTimeout(resolve, 10)); }
  await pending;
  assert.equal(customCalls, 1);
  assert.ok(notices.some((notice) => notice.includes("scheduler cleanup failed")));
});
