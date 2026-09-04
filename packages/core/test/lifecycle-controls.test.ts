import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { testExtensionApi } from "./support.js";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, RunLifecycle, RunStore, WORKFLOW_AGENT_STATE_CHANGED_EVENT, WORKFLOW_BLOCKED_EVENT, WORKFLOW_BUDGET_EVENT, WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, WORKFLOW_PHASE_CHANGED_EVENT, WORKFLOW_RUN_COMPLETED_EVENT, WORKFLOW_RUN_FAILED_EVENT, WORKFLOW_RUN_RESUMED_EVENT, WORKFLOW_RUN_STARTED_EVENT, WORKFLOW_RUN_STATE_CHANGED_EVENT, WORKFLOW_WORKTREE_CREATED_EVENT, WorkflowError } from "../src/index.js";
import type { SessionInput } from "../src/agent-execution.js";
import { listRunIds } from "../src/persistence.js";
import { testTransport, type TestPiSession } from "./test-transport.js";
import { waitForIssue105 } from "./support.js";
import { contextualWorkflowAction } from "./support.js";
void test("advertises only described effective roles in the system prompt while workflow is active", () => {
  type StartHandler = (event: { systemPrompt: string }, ctx: { cwd: string; isProjectTrusted?: () => boolean }) => { systemPrompt?: string } | undefined;
  let handler: StartHandler | undefined;
  const activeTools = ["workflow"];
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-role-guidance-"));
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "project-reviewer.md"), "---\ndescription: Reviews correctness\nmodel: private/model:medium\ntools: [private-tool]\n---\nPRIVATE ROLE BODY");
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "hidden.md"), "UNDESCRIBED ROLE BODY");
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => activeTools, on(name: string, candidate: unknown) { if (name === "before_agent_start") handler = candidate as StartHandler; } }));
  assert.ok(handler);
  const result = handler({ systemPrompt: "BASE SYSTEM" }, { cwd });
  const guidance = result?.systemPrompt ?? "";
  assert.match(guidance, /^BASE SYSTEM\n\nWorkflow role descriptions:/);
  assert.match(guidance, /`project-reviewer`: Reviews correctness/);
  assert.doesNotMatch(guidance, /PRIVATE ROLE BODY|UNDESCRIBED ROLE BODY|private\/model|private-tool|workflow_catalog/);
  const untrustedGuidance = handler({ systemPrompt: "BASE SYSTEM" }, { cwd, isProjectTrusted: () => false })?.systemPrompt ?? "";
  assert.doesNotMatch(untrustedGuidance, /project-reviewer|Reviews correctness/);
});

void test("foreground lifecycle events are redacted and throwing listeners cannot stop execution", async () => {
  const events: Array<{ channel: string; data: unknown }> = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-lifecycle-events-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], events: { emit(channel: string, data: unknown) { events.push({ channel, data }); throw new Error("listener failure"); } } }), home);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await workflow.execute("id", { name: "foreground-events", args: { secret: "ARG_SECRET" }, script: "phase('build'); return {value:'RESULT_SECRET'}; // SOURCE_SECRET", foreground: true }, new AbortController().signal, undefined, context);
  assert.deepEqual(events.map(({ channel }) => channel), [WORKFLOW_RUN_STARTED_EVENT, WORKFLOW_PHASE_CHANGED_EVENT, WORKFLOW_RUN_STATE_CHANGED_EVENT, WORKFLOW_RUN_COMPLETED_EVENT]);
  assert.doesNotMatch(JSON.stringify(events), /ARG_SECRET|RESULT_SECRET|SOURCE_SECRET|listener failure/);
  const failedEvents: Array<{ channel: string; data: unknown }> = [];
  const failedHome = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-failed-events-"));
  const failedTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof failedTools)[number]) { failedTools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], events: { emit(channel: string, data: unknown) { failedEvents.push({ channel, data }); throw new Error("listener failure"); } } }), failedHome);
  const failedWorkflow = failedTools.find(({ name }) => name === "workflow");
  assert.ok(failedWorkflow);
  await assert.rejects(failedWorkflow.execute("id", { name: "failed-events", script: "throw new Error('RESULT_SECRET');", foreground: true }, new AbortController().signal, undefined, { ...context, cwd: failedHome }), (error: unknown) => error instanceof WorkflowError);
  assert.ok(failedEvents.some(({ channel }) => channel === WORKFLOW_RUN_FAILED_EVENT));
  assert.ok(failedEvents.some(({ channel }) => channel === WORKFLOW_RUN_STATE_CHANGED_EVENT));
  assert.doesNotMatch(JSON.stringify(failedEvents), /RESULT_SECRET|listener failure/);
});
void test("orchestration lifecycle events cover phase, worktree, retry, checkpoint, and agent ordering", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-orchestration-events-"));
  const cwd = join(home, "repo");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "test"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  writeFileSync(join(cwd, "tracked.txt"), "tracked");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "initial"]);
  const events: Array<{ channel: string; data: unknown }> = [];
  let sessions = 0;
  const createSession = async (): Promise<TestPiSession> => {
    const attempt = ++sessions;
    return { sessionId: `event-session-${String(attempt)}`, sessionFile: `/sessions/event-${String(attempt)}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => { if (attempt === 1) throw new Error("PROMPT_SECRET"); }, steer: async () => {}, dispose() {} };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], events: { emit(channel: string, data: unknown) { events.push({ channel, data }); } } }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const result = await workflow.execute("id", { name: "orchestration-events", args: { secret: "ARG_SECRET" }, script: "phase('build'); return withWorktree('OWNER_SECRET', async () => { const value = await agent('PROMPT_SECRET', {label:'worker', retries:1}); const approved = await checkpoint({name:'ship', prompt:'CHECKPOINT_SECRET', context:{secret:'CONTEXT_SECRET'}}); const rejected = await checkpoint({name:'reject', prompt:'Reject?', context:{secret:'REJECT_CONTEXT_SECRET'}}); return {value, approved, rejected}; });", foreground: true }, new AbortController().signal, undefined, { cwd, hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { select: async (prompt: string) => prompt === "Reject?" ? "Reject" : "Approve" } }) as { details?: { value?: unknown } };
  assert.deepEqual(result.details?.value, { value: "done", approved: "approved", rejected: "rejected" });
  const channels = events.map(({ channel }) => channel);
  assert.equal(channels.filter((channel) => channel === WORKFLOW_RUN_STARTED_EVENT).length, 1);
  assert.ok(channels.includes(WORKFLOW_PHASE_CHANGED_EVENT));
  assert.ok(channels.includes(WORKFLOW_WORKTREE_CREATED_EVENT));
  assert.ok(channels.includes(WORKFLOW_AGENT_STATE_CHANGED_EVENT));
  assert.ok(channels.includes(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT));
  assert.ok(channels.includes(WORKFLOW_RUN_COMPLETED_EVENT));
  const agentStates = events.filter(({ channel }) => channel === WORKFLOW_AGENT_STATE_CHANGED_EVENT).map(({ data }) => (data as { state: string }).state);
  assert.ok(agentStates.includes("retrying"));
  assert.ok(agentStates.includes("completed"));
  const checkpointStates = events.filter(({ channel }) => channel === WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT).map(({ data }) => (data as { state: string }).state);
  assert.deepEqual(checkpointStates, ["awaiting", "approved", "awaiting", "rejected"]);
  assert.ok(channels.indexOf(WORKFLOW_RUN_STARTED_EVENT) < channels.indexOf(WORKFLOW_PHASE_CHANGED_EVENT));
  assert.ok(channels.indexOf(WORKFLOW_WORKTREE_CREATED_EVENT) < channels.indexOf(WORKFLOW_AGENT_STATE_CHANGED_EVENT));
  assert.ok(channels.indexOf(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT) < channels.indexOf(WORKFLOW_RUN_COMPLETED_EVENT));
  assert.doesNotMatch(JSON.stringify(events), /PROMPT_SECRET|RESULT_SECRET|ARG_SECRET|CHECKPOINT_SECRET|CONTEXT_SECRET/);
});
void test("TUI terminal provider recovery shows factual failure and retries without a recommendation", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-provider-recovery-retry-"));
  let sessions = 0;
  let disposals = 0;
  const prompts: Array<{ title: string; options: string[] }> = [];
  const workflowEvents: Array<{ active: boolean; label?: string }> = [];
  let shutdown: (() => Promise<void>) | undefined;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    const attempt = ++sessions;
    const terminal = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "AUTH_FAILED" };
    const messages: Array<{ role: string; content: unknown; stopReason?: string; errorMessage?: string }> = [terminal];
    let promptCount = 0;
    return { sessionId: `recovery-retry-${String(attempt)}`, sessionFile: `/sessions/recovery-retry-${String(attempt)}.jsonl`, model: { provider: input.model.provider, model: input.model.model }, messages, getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => { promptCount += 1; if (promptCount === 2) messages[0] = { role: "assistant", content: [{ type: "text", text: "done" }] }; }, steer: async () => {}, dispose() { disposals += 1; } };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], events: { emit(channel: string, data: unknown) { if (channel === WORKFLOW_BLOCKED_EVENT) workflowEvents.push(data as { active: boolean; label?: string }); } } }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd: home, mode: "tui", hasUI: true, model: { provider: "openai", id: "gpt" }, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt" }, { provider: "anthropic", id: "opus" }] }, sessionManager: { getSessionId: () => "session" }, ui: { select: async (title: string, options: string[]) => { prompts.push({ title, options }); return "Retry"; } } };
  try {
    const result = await workflow.execute("id", { name: "provider-recovery-retry", script: "return await agent('work', {label:'worker', retries:2});", foreground: true }, new AbortController().signal, undefined, context) as { details?: { value?: unknown } };
    assert.equal(result.details?.value, "done");
    assert.equal(sessions, 1);
    assert.deepEqual(prompts, [{ title: "Subagent \"worker\" failed\nCurrent provider/model: openai/gpt\nProvider error: AUTH_FAILED\nChoose what to do", options: ["Retry", "Change model", "Abort workflow"] }]);
    assert.deepEqual(workflowEvents, [{ active: true, label: "Subagent \"worker\" failed" }, { active: false }]);
    assert.equal(disposals, 1);
    assert.doesNotMatch(prompts[0]?.title ?? "", /recommend/i);
  } finally {
    await shutdown?.();
  }
});
void test("TUI terminal provider recovery changes model before a fresh attempt", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-provider-recovery-model-"));
  let sessions = 0;
  const prompts: Array<{ title: string; options: string[] }> = [];
  const inputs: SessionInput[] = [];
  let shutdown: (() => Promise<void>) | undefined;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    inputs.push(input);
    const attempt = ++sessions;
    return { sessionId: `recovery-model-${String(attempt)}`, sessionFile: `/sessions/recovery-model-${String(attempt)}.jsonl`, model: { provider: input.model.provider, model: input.model.model }, messages: [attempt === 1 ? { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "MODEL_UNAVAILABLE" } : { role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {} };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  let selectCalls = 0;
  const context = { cwd: home, mode: "tui", hasUI: true, model: { provider: "openai", id: "gpt" }, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt" }, { provider: "anthropic", id: "opus" }] }, sessionManager: { getSessionId: () => "session" }, ui: { select: async (title: string, options: string[]) => { prompts.push({ title, options }); selectCalls += 1; return selectCalls === 1 ? "Change model" : "anthropic/opus"; } } };
  try {
    const result = await workflow.execute("id", { name: "provider-recovery-model", script: "return await agent('work', {label:'worker'});", foreground: true }, new AbortController().signal, undefined, context) as { details?: { value?: unknown } };
    assert.equal(result.details?.value, "done");
    assert.equal(sessions, 2);
    assert.deepEqual(inputs.map(({ model }) => `${model.provider}/${model.model}`), ["openai/gpt", "anthropic/opus"]);
    assert.deepEqual(prompts[0]?.options, ["Retry", "Change model", "Abort workflow"]);
    assert.deepEqual(prompts[1]?.options, ["anthropic/opus", "openai/gpt"]);
  } finally {
    await shutdown?.();
  }
});
void test("the searchable recovery model picker constructs against the installed pi and applies the picked model", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-provider-recovery-model-picker-"));
  let sessions = 0;
  const inputs: SessionInput[] = [];
  let shutdown: (() => Promise<void>) | undefined;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    inputs.push(input);
    const attempt = ++sessions;
    return { sessionId: `recovery-model-picker-${String(attempt)}`, sessionFile: `/sessions/recovery-model-picker-${String(attempt)}.jsonl`, model: { provider: input.model.provider, model: input.model.model }, messages: [attempt === 1 ? { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "MODEL_UNAVAILABLE" } : { role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {} };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const models = [{ provider: "openai", id: "gpt", name: "GPT" }, { provider: "anthropic", id: "opus", name: "Opus" }];
  type PickerFactory = (tui: { requestRender(): void }, theme: undefined, keybindings: undefined, done: (value: unknown) => void) => { handleInput(key: string): void; dispose?(): void };
  initTheme("dark", false);
  let selectCalls = 0;
  const context = { cwd: home, mode: "tui", hasUI: true, model: models[0], modelRegistry: { getAvailable: () => models, find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id) }, sessionManager: { getSessionId: () => "session" }, ui: {
    select: async () => { selectCalls += 1; return selectCalls === 1 ? "Change model" : "Abort workflow"; },
    custom: (factory: PickerFactory) => new Promise((resolve) => {
      const picker = factory({ requestRender() {} }, undefined, undefined, resolve);
      picker.handleInput("opus");
      picker.handleInput("\r");
      picker.dispose?.();
    }),
  } };
  try {
    const result = await workflow.execute("id", { name: "provider-recovery-model-picker", script: "return await agent('work', {label:'worker'});", foreground: true }, new AbortController().signal, undefined, context) as { details?: { value?: unknown } };
    assert.equal(result.details?.value, "done");
    assert.deepEqual(inputs.map(({ model }) => `${model.provider}/${model.model}`), ["openai/gpt", "anthropic/opus"]);
  } finally {
    await shutdown?.();
  }
});
void test("a throwing recovery model picker surfaces its cause in the agent error", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-provider-recovery-model-picker-throws-"));
  let shutdown: (() => Promise<void>) | undefined;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => ({ sessionId: "recovery-model-picker-throws", sessionFile: "/sessions/recovery-model-picker-throws.jsonl", model: { provider: input.model.provider, model: input.model.model }, messages: [{ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "MODEL_UNAVAILABLE" }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {} });
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const models = [{ provider: "openai", id: "gpt", name: "GPT" }];
  const context = { cwd: home, mode: "tui", hasUI: true, model: models[0], modelRegistry: { getAvailable: () => models }, sessionManager: { getSessionId: () => "session" }, ui: { select: async () => "Change model", custom: async () => { throw new TypeError("getAvailableSnapshot is not a function"); } } };
  try {
    await assert.rejects(workflow.execute("id", { name: "provider-recovery-model-picker-throws", script: "return await agent('work', {label:'worker'});", foreground: true }, new AbortController().signal, undefined, context), /MODEL_UNAVAILABLE \(provider recovery failed: getAvailableSnapshot is not a function\)/);
  } finally {
    await shutdown?.();
  }
});
void test("escaping the searchable recovery model picker returns to the recovery action menu", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-provider-recovery-model-cancel-"));
  let prompts = 0;
  let customCalls = 0;
  let shutdown: (() => Promise<void>) | undefined;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    const messages: Array<{ role: string; content: unknown; stopReason?: string; errorMessage?: string }> = [{ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "MODEL_UNAVAILABLE" }];
    return { sessionId: "recovery-model-cancel", sessionFile: "/sessions/recovery-model-cancel.jsonl", model: { provider: input.model.provider, model: input.model.model }, messages, getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => { if (prompts >= 2) messages[0] = { role: "assistant", content: [{ type: "text", text: "done" }] }; }, steer: async () => {}, dispose() {} };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const models = [{ provider: "openai", id: "gpt", name: "GPT" }, { provider: "anthropic", id: "opus", name: "Opus" }];
  const context = { cwd: home, mode: "tui", hasUI: true, model: models[0], modelRegistry: { getAvailable: () => models, find: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id) }, sessionManager: { getSessionId: () => "session" }, ui: {
    select: async () => { prompts += 1; return prompts === 1 ? "Change model" : "Retry"; },
    custom: async () => { customCalls += 1; return undefined; },
  } };
  try {
    const result = await workflow.execute("id", { name: "provider-recovery-model-cancel", script: "return await agent('work', {label:'worker'});", foreground: true }, new AbortController().signal, undefined, context) as { details?: { value?: unknown } };
    assert.equal(result.details?.value, "done");
    assert.equal(customCalls, 1);
    assert.equal(prompts, 2);
  } finally {
    await shutdown?.();
  }
});
void test("TUI provider recovery aborts the workflow even when workflow code catches the agent failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-provider-recovery-abort-"));
  let shutdown: (() => Promise<void>) | undefined;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => ({ transport: "local", session: { transport: "local", sessionId: "recovery-abort", locator: { sessionFile: "/sessions/recovery-abort.jsonl" } }, model: { provider: input.model.provider, model: input.model.model }, messages: [{ role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "PROVIDER_FAILED" }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {} });
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd: home, mode: "tui", hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { select: async () => "Abort workflow" } };
  try {
    await assert.rejects(workflow.execute("id", { name: "provider-recovery-abort", script: "try { await agent('work', {label:'worker'}); } catch {} return 'continued';", foreground: true }, new AbortController().signal, undefined, context), WorkflowError);
    const runIds = await listRunIds(home, "session", home);
    assert.equal(runIds.length, 1);
    const runId = runIds[0];
    assert.ok(runId);
    assert.equal((await new RunStore(home, "session", runId, home).load()).run.state, "stopped");
  } finally {
    await shutdown?.();
  }
});
void test("budget exhaustion emits a budget event and state change, not run failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-budget-events-"));
  const events: string[] = [];
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], events: { emit(channel: string) { events.push(channel); } } }), home, async () => {}, testTransport(async () => { throw new Error("must not launch"); }));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  await assert.rejects(workflow.execute("id", { name: "budget-events", script: "return agent('PROMPT_SECRET');", budget: { agentLaunches: { hard: 0 } }, foreground: true }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError);
  assert.ok(events.includes(WORKFLOW_BUDGET_EVENT));
  assert.ok(events.includes(WORKFLOW_RUN_STATE_CHANGED_EVENT));
  assert.equal(events.includes(WORKFLOW_RUN_FAILED_EVENT), false);
  assert.equal(events.includes(WORKFLOW_RUN_COMPLETED_EVENT), false);
});
void test("run control lifecycle events cover pause, resume, and stop", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-run-control-events-"));
  const events: Array<{ channel: string; data: unknown }> = [];
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  let shutdown: (() => Promise<void>) | undefined;
  let resolvePause!: (runId: string) => void;
  let resolveStop!: (runId: string) => void;
  const pauseReady = new Promise<string>((resolve) => { resolvePause = resolve; });
  const stopReady = new Promise<string>((resolve) => { resolveStop = resolve; });
  let releaseAgent!: () => void;
  const agentReady = new Promise<void>((resolve) => { releaseAgent = resolve; });
  const createSession = async (): Promise<TestPiSession> => ({ transport: "local", session: { transport: "local", sessionId: "control-session", locator: { sessionFile: "/sessions/control.jsonl" } }, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => { await agentReady; }, steer: async () => {}, dispose() {} });
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, sendMessage() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], events: { emit(channel: string, data: unknown) { events.push({ channel, data }); if (channel === WORKFLOW_PHASE_CHANGED_EVENT) { const event = data as { phase: string; runId: string }; if (event.phase === "pause") { const action = commands[0]?.handler; if (action) void contextualWorkflowAction(action, context, event.runId, "Pause").then(() => { setImmediate(() => { resolvePause(event.runId); }); }); } if (event.phase === "stop") { const action = commands[0]?.handler; if (action) void contextualWorkflowAction(action, context, event.runId, "Stop").then(() => { setImmediate(() => { resolveStop(event.runId); }); }); } } } } }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const command = commands[0]?.handler;
  assert.ok(workflow && command);
  const context = { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
  try {
    const pausedRun = workflow.execute("id", { name: "pause-events", script: "phase('pause'); const value = await agent('PROMPT_SECRET'); await phase('after'); return value;", foreground: true }, new AbortController().signal, undefined, context);
    const pausedRunId = await pauseReady;
    releaseAgent();
    for (let attempt = 0; attempt < 1000 && (await new RunStore(home, "session", pausedRunId, home).load()).run.state !== "paused"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await new RunStore(home, "session", pausedRunId, home).load()).run.state, "paused");
    await contextualWorkflowAction(command, context, pausedRunId, "Resume");
    await pausedRun;
    const stoppedRun = workflow.execute("id", { name: "stop-events", script: "phase('stop'); return await agent('PROMPT_SECRET');", foreground: true }, new AbortController().signal, undefined, context);
    void stoppedRun.catch(() => undefined);
    const stoppedRunId = await stopReady;
    await assert.rejects(stoppedRun, (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
    const stoppedEvents = events.filter(({ data }) => (data as { runId: string }).runId === stoppedRunId);
    assert.equal(stoppedEvents.filter(({ channel }) => channel === WORKFLOW_RUN_STARTED_EVENT).length, 1);
    assert.equal(stoppedEvents.some(({ channel }) => channel === WORKFLOW_RUN_COMPLETED_EVENT || channel === WORKFLOW_RUN_FAILED_EVENT), false);
    assert.equal((await new RunStore(home, "session", stoppedRunId, home).load()).run.state, "stopped");
    const pausedStates = events.filter(({ data, channel }) => channel === WORKFLOW_RUN_STATE_CHANGED_EVENT && (data as { runId: string }).runId === pausedRunId).map(({ data }) => (data as { state: string }).state);
    assert.deepEqual(pausedStates, ["pausing", "paused", "running", "completed"]);
    assert.equal(events.filter(({ channel, data }) => channel === WORKFLOW_RUN_RESUMED_EVENT && (data as { runId: string }).runId === pausedRunId).length, 1);
    assert.equal(events.filter(({ channel, data }) => channel === WORKFLOW_RUN_STARTED_EVENT && (data as { runId: string }).runId === pausedRunId).length, 1);
  } finally {
    await shutdown?.();
  }
});
void test("workflow_stop reports unknown and terminal runs and persists cancellation", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-stop-tool-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let agentStarted!: () => void;
  const started = new Promise<void>((resolve) => { agentStarted = resolve; });
  const createSession = async (): Promise<TestPiSession> => ({ transport: "local", session: { transport: "local", sessionId: "stop-tool-session", locator: { sessionFile: "/sessions/stop-tool.jsonl" } }, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => { agentStarted(); await new Promise<void>(() => {}); }, steer: async () => {}, abort: async () => {}, dispose() {} });
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; }, sendMessage() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const stop = tools.find(({ name }) => name === "workflow_stop");
  const resume = tools.find(({ name }) => name === "workflow_resume");
  assert.ok(workflow && stop && resume);
  const context = { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const result = (await stop.execute("id", { runId: "missing" })) as { content: [{ text: string }] };
  assert.deepEqual(JSON.parse(result.content[0].text), { runId: "missing", state: "unknown", stopped: false, reason: "unknown_run" });
  const foreignStore = new RunStore(home, "other-session", "foreign", home);
  const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "foreign" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await foreignStore.create({ id: "foreign", workflowName: "foreign", cwd: home, sessionId: "other-session", state: "running", agents: [], agentSessions: [] }, snapshot);
  const foreignResult = (await stop.execute("id", { runId: "foreign" })) as { content: [{ text: string }] };
  assert.deepEqual(JSON.parse(foreignResult.content[0].text), { runId: "foreign", state: "unknown", stopped: false, reason: "unknown_run" });
  assert.equal((await foreignStore.load()).run.state, "running");
  const terminalStore = new RunStore(home, "session", "terminal", home);
  await terminalStore.create({ id: "terminal", workflowName: "terminal", cwd: home, sessionId: "session", state: "completed", agents: [], agentSessions: [] }, snapshot);
  const exhaustedStore = new RunStore(home, "session", "exhausted", home);
  await exhaustedStore.create({ id: "exhausted", workflowName: "exhausted", cwd: home, sessionId: "session", state: "budget_exhausted", agents: [], agentSessions: [] }, snapshot);
  assert.ok(start);
  await start({}, context);
  const terminalResult = (await stop.execute("id", { runId: "terminal" })) as { content: [{ text: string }] };
  assert.deepEqual(JSON.parse(terminalResult.content[0].text), { runId: "terminal", state: "completed", stopped: false, reason: "already_terminal" });
  const stoppedExhausted = (await stop.execute("id", { runId: "exhausted" })) as { content: [{ text: string }] };
  assert.deepEqual(JSON.parse(stoppedExhausted.content[0].text), { runId: "exhausted", state: "stopped", stopped: true });
  assert.equal((await exhaustedStore.load()).run.state, "stopped");
  await assert.rejects(resume.execute("id", { runId: "exhausted" }), /Unknown workflow run/);
  const running = await workflow.execute("id", { name: "active-stop", script: "return await agent('wait');" }, new AbortController().signal, undefined, context) as { content: [{ text: string }] };
  const activeRunId = (JSON.parse(running.content[0].text) as { runId: string }).runId;
  await started;
  const stopped = (await stop.execute("id", { runId: activeRunId })) as { content: [{ text: string }] };
  assert.deepEqual(JSON.parse(stopped.content[0].text), { runId: activeRunId, state: "stopped", stopped: true });
  const activeStore = new RunStore(home, "session", activeRunId, home);
  const persisted = await activeStore.load();
  assert.equal(persisted.run.state, "stopped");
  assert.deepEqual(persisted.run.agents.map(({ state }) => state), ["cancelled"]);
  const stoppedAgain = (await stop.execute("id", { runId: activeRunId })) as { content: [{ text: string }] };
  assert.deepEqual(JSON.parse(stoppedAgain.content[0].text), { runId: activeRunId, state: "stopped", stopped: false, reason: "already_terminal" });
});
void test("cold resume does not duplicate the phase recorded before interruption", async () => {
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-phase-cold-resume-"));
  const context = { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const createHeldSession = async (input: SessionInput): Promise<TestPiSession> => ({
    sessionId: `phase-first-${input.sessionLabel}`, sessionFile: `/sessions/phase-first-${input.sessionLabel}.jsonl`,
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    prompt: async () => { await held; },
    steer: async () => {},
    abort: async () => { release(); },
    dispose() {},
  });
  const firstTools: Tool[] = [];
  let firstShutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool(tool: Tool) { firstTools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_shutdown") firstShutdown = handler as typeof firstShutdown; }, sendMessage() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createHeldSession));
  const firstWorkflow = firstTools.find(({ name }) => name === "workflow");
  assert.ok(firstWorkflow);
  const first = await firstWorkflow.execute("phase-first", { name: "phase-cold", script: "phase('build'); return await agent('wait');" }, undefined, undefined, context) as { content: Array<{ text: string }> };
  const runId = (JSON.parse(first.content[0]?.text ?? "null") as { runId: string }).runId;
  const store = new RunStore(home, "session", runId, home);
  for (let attempt = 0; attempt < 1000 && (await store.load()).run.phase !== "build"; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await store.load()).run.phase, "build");
  await firstShutdown?.();
  assert.equal((await store.load()).run.state, "interrupted");
  const secondTools: Tool[] = [];
  let secondStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let secondCommand: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let secondShutdown: (() => Promise<void>) | undefined;
  const createImmediateSession = async (input: SessionInput): Promise<TestPiSession> => ({
    sessionId: `phase-second-${input.sessionLabel}`, sessionFile: `/sessions/phase-second-${input.sessionLabel}.jsonl`,
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    prompt: async () => {}, steer: async () => {}, dispose() {},
  });
  workflowExtension(testExtensionApi({ registerTool(tool: Tool) { secondTools.push(tool); }, registerCommand(_name: string, value: { handler: NonNullable<typeof secondCommand> }) { secondCommand = value.handler; }, on(name: string, handler: unknown) { if (name === "session_start") secondStart = handler as typeof secondStart; if (name === "session_shutdown") secondShutdown = handler as typeof secondShutdown; }, sendMessage() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createImmediateSession));
  try {
    assert.ok(secondStart && secondCommand);
    await secondStart({}, context);
    await contextualWorkflowAction(secondCommand, context, runId, "Resume");
    for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
    const resumed = (await store.load()).run;
    assert.equal(resumed.state, "completed");
    assert.deepEqual(resumed.phaseHistory?.filter(({ phase }) => phase === "build"), [{ phase: "build", afterAgent: 0 }]);
  } finally {
    release();
    await secondShutdown?.();
  }
});
void test("session recovery emits interruption as state change only", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-interruption-events-"));
  const cwd = join(home, "project");
  const runId = "interrupted-run";
  const store = new RunStore(cwd, "session", runId, home);
  const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "interrupted" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] });
  await store.create({ id: runId, workflowName: "interrupted", cwd, sessionId: "session", state: "running", agents: [], agentSessions: [] }, snapshot);
  const events: Array<{ channel: string; data: unknown }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, sendMessage() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], events: { emit(channel: string, data: unknown) { events.push({ channel, data }); } } }), home);
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
  try {
    assert.ok(start);
    await start({}, context);
    const interruption = events.find(({ channel }) => channel === WORKFLOW_RUN_STATE_CHANGED_EVENT);
    assert.deepEqual(interruption && { previousState: (interruption.data as { previousState: string }).previousState, state: (interruption.data as { state: string }).state, reason: (interruption.data as { reason: string }).reason }, { previousState: "running", state: "interrupted", reason: "session_shutdown" });
    assert.equal((await store.load()).run.state, "interrupted");
    assert.equal(events.some(({ channel }) => channel === WORKFLOW_RUN_COMPLETED_EVENT || channel === WORKFLOW_RUN_FAILED_EVENT), false);
  } finally {
    await shutdown?.();
  }
});
void test("resuming a launched trusted-project run keeps per-run concurrency and clears removed exclusions", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-project-resume-settings-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const globalSettings = join(agentDir, "pi-extensible-workflows", "settings.json");
  const projectSettings = join(cwd, ".pi", "pi-extensible-workflows", "settings.json");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  writeFileSync(globalSettings, JSON.stringify({ concurrency: 1 }));
  writeFileSync(projectSettings, JSON.stringify({ concurrency: 2, skills: ["project-old"], extensions: [] }));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const inputs: SessionInput[] = [];
  let releaseAgent: (() => void) | undefined;
  const agentReady = new Promise<void>((resolve) => { releaseAgent = resolve; });
  let resolvePause!: (runId: string) => void;
  const pauseReady = new Promise<string>((resolve) => { resolvePause = resolve; });
  const context = { cwd, hasUI: false, isProjectTrusted: () => true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    inputs.push(input);
    return { sessionId: `project-resume-${String(inputs.length)}`, sessionFile: `/sessions/project-resume-${String(inputs.length)}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => { await agentReady; }, steer: async () => {}, dispose() {} };
  };
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, sendMessage() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], events: { emit(channel: string, data: unknown) { if (channel !== WORKFLOW_PHASE_CHANGED_EVENT || (data as { phase?: string }).phase !== "pause") return; const event = data as { runId: string }; const action = commands[0]?.handler; if (action) void contextualWorkflowAction(action, context, event.runId, "Pause").then(() => setImmediate(() => { resolvePause(event.runId); })); } } }), home, async () => {}, testTransport(createSession), agentDir);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const run = workflow.execute("id", { name: "project-resume-settings", script: "phase('pause'); const value = await agent('work'); phase('after'); return value;", concurrency: 4, foreground: true }, new AbortController().signal, undefined, context);
  const runId = await pauseReady;
  const store = new RunStore(cwd, "session", runId, home);
  releaseAgent?.();
  for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "paused"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  const paused = await store.load();
  assert.equal(paused.run.state, "paused");
  assert.equal(paused.snapshot.settings.concurrency, 4);
  assert.equal(paused.snapshot.settingsSources?.concurrency, "per-run options");
  assert.deepEqual(paused.snapshot.settings.skills, ["project-old"]);
  writeFileSync(globalSettings, JSON.stringify({ concurrency: 1 }));
  writeFileSync(projectSettings, JSON.stringify({ concurrency: 2 }));
  const resumeCommand = commands[0]?.handler;
  assert.ok(resumeCommand);
  await contextualWorkflowAction(resumeCommand, context, runId, "Resume");
  await run;
  const resumed = await store.load();
  assert.equal(resumed.run.state, "completed");
  assert.equal(resumed.snapshot.settings.concurrency, 4);
  assert.equal(resumed.snapshot.settingsSources?.concurrency, "per-run options");
  assert.deepEqual(resumed.snapshot.settings.skills, ["project-old"]);
  await shutdown?.();
});

void test("run lifecycle pauses cooperatively, resumes waiters, and keeps terminal states irreversible", async () => {
  const states: string[] = [];
  const lifecycle = new RunLifecycle("running", (state) => { states.push(state); });
  await lifecycle.enter();
  await lifecycle.pause();
  assert.equal(lifecycle.state, "pausing");
  let continued = false;
  const waiting = lifecycle.enter().then(() => { continued = true; });
  await lifecycle.leave();
  assert.equal(lifecycle.state, "paused");
  assert.equal(continued, false);
  await lifecycle.resume();
  await waiting;
  assert.equal(continued, true);
  await lifecycle.leave();
  await lifecycle.terminal("stopped");
  await assert.rejects(lifecycle.resume(), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  assert.deepEqual(states, ["pausing", "paused", "running", "stopped"]);
});
void test("run lifecycle does not resurrect a paused run after stop races its pause", async () => {
  let releasePauseTransition!: () => void;
  const pauseTransition = new Promise<void>((resolve) => { releasePauseTransition = resolve; });
  const lifecycle = new RunLifecycle("running", async (state) => { if (state === "pausing") await pauseTransition; });
  const pausing = lifecycle.pause();
  assert.equal(lifecycle.state, "pausing");
  const stopping = lifecycle.terminal("stopped");
  releasePauseTransition();
  await Promise.all([pausing, stopping]);
  assert.equal(lifecycle.state, "stopped");
});

void test("run lifecycle waits for resume before awaiting input and wakes on resolution", async () => {
  const pausedStates: string[] = [];
  const paused = new RunLifecycle("running", (state) => { pausedStates.push(state); });
  await paused.pause();
  let awaiting = false;
  const transition = paused.enterAwaitingInput().then(() => { awaiting = true; });
  assert.equal(awaiting, false);
  await paused.resume();
  await transition;
  assert.equal(paused.state, "awaiting_input");
  assert.deepEqual(pausedStates, ["pausing", "paused", "running", "awaiting_input"]);

  const states: string[] = [];
  const lifecycle = new RunLifecycle("running", (state) => { states.push(state); });
  await lifecycle.enterAwaitingInput();
  await lifecycle.enterAwaitingInput();
  let entered = false;
  const waiting = lifecycle.enter().then(() => { entered = true; });
  await assert.rejects(lifecycle.pause(), /Cannot pause awaiting_input/);
  assert.equal(entered, false);
  await lifecycle.resolveAwaitingInput();
  await waiting;
  await lifecycle.leave();
  assert.deepEqual(states, ["awaiting_input", "running"]);
});
void test("pause waits for parallel agents and blocks later operations until resume", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-pause-parallel-"));
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const events: Array<{ channel: string; data: unknown }> = [];
  const starts: string[] = [];
  const releases = new Map<string, () => void>();
  let resolveBothStarted!: () => void;
  const bothStarted = new Promise<void>((resolve) => { resolveBothStarted = resolve; });
  let sessionCount = 0;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    const label = input.sessionLabel.split(":")[1] ?? "unknown";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    releases.set(label, release);
    return {
      sessionId: `${label}-${String(++sessionCount)}`, sessionFile: `/sessions/${label}.jsonl`,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      prompt: async () => { starts.push(label); if (starts.includes("first") && starts.includes("second")) resolveBothStarted(); await gate; },
      abort: async () => { release(); }, steer: async () => {}, dispose() {},
    };
  };
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], events: { emit(channel: string, data: unknown) { events.push({ channel, data }); } } }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const command = commands[0]?.handler;
  assert.ok(workflow && command);
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
  const running = workflow.execute("id", { name: "parallel-pause", script: "const values = await Promise.all([agent('first', {label:'first'}), agent('second', {label:'second'})]); values.push(await agent('after', {label:'after'})); return values;", concurrency: 2, foreground: true }, new AbortController().signal, undefined, context);
  await bothStarted;
  const runId = (await listRunIds(cwd, "session", home))[0];
  assert.ok(runId);
  const store = new RunStore(cwd, "session", runId, home);
  await contextualWorkflowAction(command, context, runId, "Pause");
  assert.equal((await store.load()).run.state, "pausing");
  releases.get("first")?.();
  await waitForIssue105(async () => (await store.load()).run.agents.some((agent) => agent.name === "first" && agent.state === "completed"));
  assert.equal((await store.load()).run.state, "pausing");
  releases.get("second")?.();
  await waitForIssue105(async () => (await store.load()).run.state === "paused");
  assert.deepEqual([...starts].sort(), ["first", "second"]);
  await contextualWorkflowAction(command, context, runId, "Resume", "Background");
  await waitForIssue105(() => starts.includes("after"));
  releases.get("after")?.();
  await running;
  await waitForIssue105(async () => (await store.load()).run.state === "completed");
  assert.equal((await store.load()).run.state, "completed");
  const stateEvents = events.filter(({ channel, data }) => channel === WORKFLOW_RUN_STATE_CHANGED_EVENT && (data as { runId: string }).runId === runId).map(({ data }) => (data as { state: string }).state);
  assert.deepEqual(stateEvents, ["pausing", "paused", "running", "completed"]);
  assert.equal(events.filter(({ channel, data }) => channel === WORKFLOW_RUN_RESUMED_EVENT && (data as { runId: string }).runId === runId).length, 1);
});
void test("pause blocks shell work at both shared and worktree operation boundaries", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-pause-shell-"));
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "test"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", cwd, "commit", "--allow-empty", "-qm", "initial"]);
  const runBoundary = async (name: string, script: string, startPath: string, releasePath: string, afterPath: string) => {
    const sessionId = name;
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
    const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
    const createSession = async (): Promise<TestPiSession> => { throw new Error("agent must not launch"); };
    workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
    const workflow = tools.find(({ name }) => name === "workflow");
    const command = commands[0]?.handler;
    assert.ok(workflow && command);
    const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => sessionId }, ui: { notify() {} } };
    const running = workflow.execute("id", { name, script, foreground: true }, new AbortController().signal, undefined, context);
    await waitForIssue105(() => existsSync(startPath));
    const runId = (await listRunIds(cwd, sessionId, home))[0];
    assert.ok(runId);
    const store = new RunStore(cwd, sessionId, runId, home);
    await contextualWorkflowAction(command, context, runId, "Pause");
    assert.equal((await store.load()).run.state, "pausing");
    writeFileSync(releasePath, "release");
    await waitForIssue105(async () => (await store.load()).run.state === "paused");
    assert.equal(existsSync(afterPath), false);
    await contextualWorkflowAction(command, context, runId, "Resume");
    await waitForIssue105(() => existsSync(afterPath));
    await running;
    await waitForIssue105(async () => (await store.load()).run.state === "completed");
    assert.equal((await store.load()).run.state, "completed");
  };
  const shell = (startPath: string, releasePath: string) => `${process.execPath} -e ${JSON.stringify(`const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(startPath)},"started");const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(releasePath)})){clearInterval(timer);process.exit(0);}},1);`)}`;
  const sharedStart = join(home, "shared-start");
  const sharedRelease = join(home, "shared-release");
  const sharedAfter = join(home, "shared-after");
  await runBoundary("pause-shell", `await shell(${JSON.stringify(shell(sharedStart, sharedRelease))}); await shell(${JSON.stringify(`${process.execPath} -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(sharedAfter)},"after")`)}`)}); return true;`, sharedStart, sharedRelease, sharedAfter);
  const worktreeStart = join(home, "worktree-start");
  const worktreeRelease = join(home, "worktree-release");
  const worktreeAfter = join(home, "worktree-after");
  await runBoundary("pause-worktree", `return await withWorktree("pause-scope", async () => { await shell(${JSON.stringify(shell(worktreeStart, worktreeRelease))}); await shell(${JSON.stringify(`${process.execPath} -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(worktreeAfter)},"after")`)}`)}); return true; });`, worktreeStart, worktreeRelease, worktreeAfter);
});
void test("invalid and duplicate lifecycle controls fail with typed errors without blocking waiters", async () => {
  const lifecycle = new RunLifecycle("running");
  await assert.rejects(lifecycle.resume(), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  await lifecycle.enter();
  const pausing = lifecycle.pause();
  await assert.rejects(lifecycle.pause(), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  await assert.rejects(lifecycle.resume(), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  await lifecycle.leave();
  await pausing;
  let entered = false;
  const waiting = lifecycle.enter().then(() => { entered = true; });
  const resumed = lifecycle.resume();
  await assert.rejects(lifecycle.resume(), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  await resumed;
  await waiting;
  assert.equal(entered, true);
  await lifecycle.leave();
  await lifecycle.terminal("stopped");
  await assert.rejects(lifecycle.pause(), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  await assert.rejects(lifecycle.terminal("failed"), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  const raced = new RunLifecycle("running");
  await raced.pause();
  await Promise.all([raced.resume(), raced.terminal("stopped")]);
  assert.equal(raced.state, "stopped");
});
void test("registered workflow command controls reject races and cancel queued work", { timeout: 10_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-command-controls-"));
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const starts: string[] = [];
  const releases = new Map<string, () => void>();
  let sessionCount = 0;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    const label = input.sessionLabel.split(":")[1] ?? "unknown";
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    releases.set(label, release);
    return {
      sessionId: `${label}-${String(++sessionCount)}`, sessionFile: `/sessions/${label}.jsonl`,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      prompt: async () => { starts.push(label); await gate; }, abort: async () => { release(); }, steer: async () => {}, dispose() {},
    };
  };
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const command = commands[0]?.handler;
  assert.ok(workflow && command);
  const notifications: string[] = [];
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify(message: string) { notifications.push(message); } } };
  const running = workflow.execute("id", { name: "command-controls", script: `const values = await Promise.all([agent("first", {label:"first"}), agent("second", {label:"second"}), agent("third", {label:"third"})]); return values;`, concurrency: 1, foreground: true }, new AbortController().signal, undefined, context);
  const runningRejected = assert.rejects(running);
  await waitForIssue105(() => starts.includes("first"));
  const runId = (await listRunIds(cwd, "session", home))[0];
  assert.ok(runId);
  const store = new RunStore(cwd, "session", runId, home);
  const invoke = (action: string) => contextualWorkflowAction(command, context, runId, action.charAt(0).toUpperCase() + action.slice(1));
  t.after(async () => {
    await invoke("stop").catch(() => {});
    for (const release of releases.values()) release();
    await running.catch(() => {});
  });
  await waitForIssue105(async () => (await store.loadOwnership()).some(({ label }) => label === "second" || label === "third"));
  const controls = await Promise.allSettled([invoke("pause"), invoke("pause"), invoke("stop")]);
  assert.equal(controls[2].status, "fulfilled");
  assert.ok(notifications.some((message) => message.includes("Cannot pause")));
  assert.ok(notifications.some((message) => message.startsWith("Stopped workflow")));
  await runningRejected;
  const stopped = await store.load();
  assert.equal(stopped.run.state, "stopped");
  assert.deepEqual(starts, ["first"]);
  for (const name of ["second", "third"]) assert.equal(stopped.run.agents.find((agent) => agent.name === name)?.state, "cancelled");
});
void test("moves an attached foreground workflow to background without restarting it", { timeout: 10_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-background-command-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const messages: string[] = [];
  const entries: string[] = [];
  const starts: string[] = [];
  let toolResultHandler: ((event: { toolName: string; toolCallId: string; isError: boolean }) => Promise<unknown>) | undefined;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const createSession = async (): Promise<TestPiSession> => ({
    sessionId: "background-command-session", sessionFile: "/sessions/background-command.jsonl",
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    prompt: async () => { starts.push("first"); await gate; }, abort: async () => { release(); }, steer: async () => {}, dispose() {},
  });
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on(name: string, handler: unknown) { if (name === "tool_result") toolResultHandler = handler as typeof toolResultHandler; }, appendEntry(_type: string, data: { message: string }) { entries.push(data.message); }, sendMessage(message: { content: string }) { messages.push(message.content); }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const command = commands[0]?.handler;
  assert.ok(workflow && command);
  const context = { cwd: home, hasUI: true, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" }, ui: { notify() {}, select: async (_prompt: string, options: string[]) => options.find((option) => option.includes("background-command")) } };
  const controller = new AbortController();
  const execution = workflow.execute("foreground-call", { name: "background-command", script: `await log("before detach"); return await agent("first", {label:"first"});`, foreground: true }, controller.signal, () => {}, context);
  await waitForIssue105(() => starts.includes("first"));
  const runId = (await listRunIds(home, "session", home))[0];
  assert.ok(runId);
  const store = new RunStore(home, "session", runId, home);
  t.after(async () => { release(); await execution.catch(() => {}); });
  const noUiNotices: string[] = [];
  const noUiContext = { ...context, hasUI: false, ui: { ...context.ui, notify(message: string) { noUiNotices.push(message); } } };
  await command("", noUiContext);
  assert.deepEqual((await store.load()).run.delivery, { mode: "foreground", state: "attached", toolCallId: "foreground-call" });
  assert.ok(noUiNotices.some((message) => message.includes("Mutations are available through workflow tools.")));
  await contextualWorkflowAction(command, context, runId, "Move to background");
  await toolResultHandler?.({ toolName: "workflow", toolCallId: "foreground-call", isError: false });
  const detached = await execution as { details: { runId: string; state: string; detached: boolean; preview?: string; run: { events?: readonly { type: string; message: string; timestamp?: number }[] } } };
  assert.deepEqual({ runId: detached.details.runId, state: detached.details.state, detached: detached.details.detached }, { runId, state: "running", detached: true });
  assert.equal(detached.details.run.events?.filter((event) => event.type === "log").map((event) => event.message).join("\n"), "before detach");
  assert.deepEqual(entries, []);
  assert.match(detached.details.preview ?? "", /Moved workflow .* to background/);
  assert.deepEqual((await store.load()).run.delivery, { mode: "background", state: "pending" });
  release();
  await waitForIssue105(async () => (await store.load()).run.delivery?.state === "delivered");
  await waitForIssue105(() => messages.some((message) => message.startsWith("Workflow background-command completed:")));
  assert.equal(messages.filter((message) => message.startsWith("Workflow background-command completed:")).length, 1);
});

void test("picker detachment delivers a foreground failure as one follow-up", { timeout: 10_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-background-failure-command-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const messages: string[] = [];
  let agentStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { agentStarted = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const createSession = async (): Promise<TestPiSession> => ({
    sessionId: "background-failure-command-session", sessionFile: "/sessions/background-failure-command.jsonl",
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    prompt: async () => { agentStarted(); await gate; }, abort: async () => { release(); }, steer: async () => {}, dispose() {},
  });
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, sendMessage(message: { content: string }) { messages.push(message.content); }, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const command = commands[0]?.handler;
  assert.ok(workflow && command);
  const context = { cwd: home, hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {}, select: async (_prompt: string, options: string[]) => options.find((option) => option.includes("background-failure-command")) } };
  const execution = workflow.execute("foreground-failure-call", { name: "background-failure-command", script: `await log("before failure"); await agent("first"); throw new Error("detached failure");`, foreground: true }, new AbortController().signal, () => {}, context);
  await started;
  await waitForIssue105(async () => (await listRunIds(home, "session", home)).length === 1);
  const runId = (await listRunIds(home, "session", home))[0];
  assert.ok(runId);
  const store = new RunStore(home, "session", runId, home);
  t.after(async () => { release(); await execution.catch(() => {}); });
  await contextualWorkflowAction(command, context, runId, "Move to background");
  const detached = await execution as { details: { runId: string; state: string; detached: boolean } };
  assert.deepEqual({ runId: detached.details.runId, state: detached.details.state, detached: detached.details.detached }, { runId, state: "running", detached: true });
  release();
  await waitForIssue105(async () => (await store.load()).run.delivery?.state === "delivered");
  await waitForIssue105(() => messages.some((message) => message.startsWith("Workflow background-failure-command failed")));
  assert.equal(messages.filter((message) => message.startsWith("Workflow background-failure-command failed")).length, 1);
  assert.match(messages[0] ?? "", /detached failure/);
});

void test("detaching a checkpointed foreground workflow switches future prompts to follow-up delivery", { timeout: 10_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-background-checkpoint-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  const messages: string[] = [];
  let selectStarted = false;
  let releaseSelect!: () => void;
  const selectGate = new Promise<void>((resolve) => { releaseSelect = resolve; });
  const createSession = async (): Promise<TestPiSession> => ({
    sessionId: "checkpoint-background-session", sessionFile: "/sessions/checkpoint-background.jsonl", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    prompt: async () => {}, abort: async () => { releaseSelect(); }, steer: async () => {}, dispose() {},
  });
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, sendMessage(message: { content: string }) { messages.push(message.content); }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const respond = tools.find(({ name }) => name === "workflow_respond");
  const command = commands[0]?.handler;
  assert.ok(workflow && respond && command);
  const context = { cwd: home, hasUI: true, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" }, ui: { notify() {}, select: async () => { selectStarted = true; await selectGate; return undefined; } } };
  const execution = workflow.execute("checkpoint-call", { name: "background-checkpoint", script: `return await checkpoint({name:"ship", prompt:"Approve ship", context:null});`, foreground: true }, new AbortController().signal, undefined, context);
  await waitForIssue105(() => selectStarted);
  const runId = (await listRunIds(home, "session", home))[0];
  assert.ok(runId);
  const store = new RunStore(home, "session", runId, home);
  t.after(() => { releaseSelect(); });
  await waitForIssue105(async () => (await store.load()).run.state === "awaiting_input");
  await contextualWorkflowAction(command, context, runId, "Move to background");
  const detached = await execution as { details: { runId: string; state: string; detached: boolean } };
  assert.deepEqual({ runId: detached.details.runId, state: detached.details.state, detached: detached.details.detached }, { runId, state: "running", detached: true });
  assert.deepEqual((await store.load()).run.delivery, { mode: "background", state: "pending" });
  assert.equal((await store.load()).snapshot.launchMode, "background");
  await waitForIssue105(() => messages.some((message) => message.includes("Workflow background-checkpoint checkpoint ship") && message.includes("Respond with workflow_respond")));
  releaseSelect();
  await respond.execute("respond", { runId, name: "ship", approved: true }, undefined, undefined, context);
  await waitForIssue105(async () => (await store.load()).run.delivery?.state === "delivered");
  assert.equal(messages.filter((message) => message.startsWith("Workflow background-checkpoint completed:")).length, 1);
});
void test("interrupted lifecycle can cold-resume while completed and failed cannot", async () => {
  const interrupted = new RunLifecycle("interrupted");
  await interrupted.resume();
  assert.equal(interrupted.state, "running");
  for (const state of ["completed", "failed"] as const) await assert.rejects(new RunLifecycle(state).resume(), /Cannot resume/);
});
