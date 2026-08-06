import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { createLocalPiSession, FairAgentScheduler, localAgentTransport, prepareAgentSetupForInspection, WorkflowAgentExecutor, type AgentExecutionRoot, type AgentProgress, type SessionInput } from "../src/agent-execution.js";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { WorkflowError, roleNameOf, type AgentExecutionResult, type AgentToolCallProgress } from "../src/index.js";
import type { AgentResourcePolicy } from "../src/types.js";
import type { RunStore } from "../src/persistence.js";
import { testTransport, type TestPiSessionEvent } from "./test-transport.js";
import { executeTool, executeToolUnchecked, testTransportContext } from "./support.js";
type TestEventMessage = NonNullable<TestPiSessionEvent["message"]>;
type TestAssistantMessageEvent = NonNullable<TestPiSessionEvent["assistantMessageEvent"]>;
function messageStart(message: TestEventMessage | undefined): TestPiSessionEvent { return { type: "message_start", ...(message === undefined ? {} : { message }) }; }
function messageEnd(message: TestEventMessage | undefined): TestPiSessionEvent { return { type: "message_end", ...(message === undefined ? {} : { message }) }; }
function messageUpdate(message: TestEventMessage | undefined, assistantMessageEvent: TestAssistantMessageEvent): TestPiSessionEvent { return { type: "message_update", ...(message === undefined ? {} : { message }), assistantMessageEvent }; }
function thinkingStart(partial: TestEventMessage | undefined, contentIndex = 0): TestAssistantMessageEvent { return { type: "thinking_start", contentIndex, ...(partial === undefined ? {} : { partial }) }; }
function thinkingDelta(partial: TestEventMessage | undefined, delta: string, contentIndex = 0): TestAssistantMessageEvent { return { type: "thinking_delta", contentIndex, delta, ...(partial === undefined ? {} : { partial }) }; }
function textStart(partial: TestEventMessage | undefined, contentIndex = 0): TestAssistantMessageEvent { return { type: "text_start", contentIndex, ...(partial === undefined ? {} : { partial }) }; }
function textDelta(partial: TestEventMessage | undefined, delta: string, contentIndex = 0): TestAssistantMessageEvent { return { type: "text_delta", contentIndex, delta, ...(partial === undefined ? {} : { partial }) }; }
function toolExecutionStart(toolCallId: string, toolName: string, args: unknown): TestPiSessionEvent { return { type: "tool_execution_start", toolCallId, toolName, args }; }
function toolExecutionEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): TestPiSessionEvent { return { type: "tool_execution_end", toolCallId, toolName, result, isError }; }
function agentEnd(): TestPiSessionEvent { return { type: "agent_end" }; }
function turnEnd(message: TestEventMessage | undefined): TestPiSessionEvent { return { type: "turn_end", ...(message === undefined ? {} : { message }) }; }
function malformedEvent(): TestPiSessionEvent { return { type: "turn_started" }; }
void test("public agent execution result types remain exported", () => {
  const result: AgentExecutionResult = { value: null, attempts: [], cwd: "/repo" };
  const progress: AgentToolCallProgress = { id: "tool", name: "read", state: "completed" };
  assert.equal(result.cwd, "/repo");
  assert.equal(progress.state, "completed");
});

const root: AgentExecutionRoot = { cwd: "/repo", model: { provider: "openai", model: "gpt", thinking: "medium" }, availableModels: new Set(["openai/gpt", "anthropic/opus", "google/gemini"]), tools: new Set(["read", "grep", "find", "bash"]), agentDefinitions: { reviewer: { prompt: "Review carefully", model: "anthropic/opus", thinking: "high", tools: ["read"] }, scout: { prompt: "Inspect broadly", model: "google/gemini", thinking: "low", tools: ["read", "grep"] } } };
const usage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.25 } };
function assistant(text: string) { return { role: "assistant", content: [{ type: "text", text }], usage }; }
function terminalAssistant(errorMessage: string) { return { ...assistant(""), stopReason: "error", errorMessage }; }
type AgentExecutionRunStore = Pick<RunStore, "recordSystemPrompt" | "validateWorktree" | "worktree" | "snapshotWorktree">;
const runStoreDefaults = {
  recordSystemPrompt: async () => {},
  validateWorktree: async () => { throw new Error("unexpected validateWorktree"); },
  worktree: async () => { throw new Error("unexpected worktree"); },
  snapshotWorktree: async () => { throw new Error("unexpected snapshotWorktree"); },
} satisfies AgentExecutionRunStore;
function sessionStats(cost = usage.cost.total) { return { tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite }, cost }; }
async function createHangingLocalSession(extensionFactories: NonNullable<SessionInput["extensionFactories"]> = []) {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-hanging-session-"));
  const agentDir = join(rootDir, "agent");
  const cwd = join(rootDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const sockets = new Set<{ destroy(): void }>();
  const server = createServer((request) => { if (request.url?.endsWith("/chat/completions")) { requestStarted(); } });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => { sockets.delete(socket); }); });
  let closed = false;
  const closeServer = (): Promise<void> => {
    if (closed) return Promise.resolve();
    closed = true;
    return new Promise<void>((resolve, reject) => { for (const socket of sockets) socket.destroy(); server.close((error) => { if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING") reject(error); else resolve(); }); });
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server did not open a TCP port");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id: "fixture-model", name: "Fixture model", reasoning: false, input: ["text"], contextWindow: 1_024, maxTokens: 128 }] } } }));
    writeFileSync(join(agentDir, "auth.json"), "{}");
    const session = await localAgentTransport.createSession({ cwd, agentDir, model: { provider: "fixture", model: "fixture-model" }, tools: [], sessionLabel: "hanging-session", ...(extensionFactories.length ? { extensionFactories } : {}) }, {} as never);
    return { session, started, async close() { await closeServer(); rmSync(rootDir, { recursive: true, force: true }); } };
  } catch (error) {
    await closeServer().catch(() => undefined);
    rmSync(rootDir, { recursive: true, force: true });
    throw error;
  }
}
async function createRespondingLocalSession(extensionFactories: NonNullable<SessionInput["extensionFactories"]> = []) {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-responding-session-"));
  const agentDir = join(rootDir, "agent");
  const cwd = join(rootDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    if (request.url?.endsWith("/chat/completions")) {
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => { body += chunk; });
      request.on("end", () => {
        try { requests.push(JSON.parse(body)); } catch { requests.push(body); }
        response.writeHead(200, { "Connection": "close", "Content-Type": "application/json" });
        response.end(JSON.stringify({ id: "fixture", object: "chat.completion", model: "fixture-model", choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
      });
    } else response.writeHead(404).end();
  });
  const sockets = new Set<{ destroy(): void }>();
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => { sockets.delete(socket); }); });
  let closed = false;
  const closeServer = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
  };
  try {
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("fixture server did not open a TCP port");
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id: "fixture-model", name: "Fixture model", reasoning: false, input: ["text"], contextWindow: 1_024, maxTokens: 128 }] } } }));
    writeFileSync(join(agentDir, "auth.json"), "{}");
    const session = await localAgentTransport.createSession({ cwd, agentDir, model: { provider: "fixture", model: "fixture-model" }, tools: [], sessionLabel: "responding-session", ...(extensionFactories.length ? { extensionFactories } : {}) }, {} as never);
    return { session, requests, async close() { await closeServer(); rmSync(rootDir, { recursive: true, force: true }); } };
  } catch (error) {
    await closeServer().catch(() => undefined);
    rmSync(rootDir, { recursive: true, force: true });
    throw error;
  }
}
async function settlesWithin(promise: Promise<unknown>, timeoutMs = 2_000): Promise<boolean> { return await new Promise((resolve) => { const timer = setTimeout(() => { resolve(false); }, timeoutMs); promise.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); }); }); }
void test("uses a transport-neutral session and persists its final reference shape", async () => {
  const events: string[] = [];
  const transport = {
    id: "test",
    async createSession(prepared: Readonly<import("../src/types.js").PreparedAgentSession>, context: Readonly<import("../src/types.js").AgentTransportContext>) {
      assert.equal(Object.isFrozen(prepared), true);
      assert.equal(context.attempt, 1);
      return {
        reference: { transport: "test", sessionId: "external-1" },
        getState: () => ({ model: prepared.model, tools: prepared.tools }),
        getSessionStats: sessionStats,
        getLastAssistant: () => undefined,
        subscribe(listener: (event: import("../src/types.js").WorkflowAgentSessionEvent) => void) { listener({ type: "state_changed", state: { model: prepared.model, tools: prepared.tools } }); return () => undefined; },
        async prompt() { events.push("prompt"); return { assistant: { role: "assistant", content: [{ type: "text", text: "transport result" }] } }; },
        async steer() {},
        async abort() {},
        async dispose() { events.push("dispose"); },
      };
    },
  } satisfies import("../src/types.js").AgentTransport;
  const result = await new WorkflowAgentExecutor({ ...root, agentSetupHooks: [{ name: "replace", priority: 1, setup(agent) { agent.transport = transport; } }] }, localAgentTransport).execute("work", { label: "worker", workflowName: "flow" });
  assert.equal(result.value, "transport result");
  const attempt = result.attempts[0];
  assert.ok(attempt);
  assert.equal(attempt.session?.transport, "test");
  assert.equal(attempt.session.sessionId, "external-1");
  assert.deepEqual(events, ["prompt", "dispose"]);
});
void test("does not retry after terminal success persistence fails and preserves attempt history", async () => {
  let prompts = 0;
  let terminalAttempts = 0;
  let thrownAttempts: readonly import("../src/agent-execution.js").AgentAttempt[] | undefined;
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({ sessionId: "success-persist", messages: [assistant("done")], getSessionStats: sessionStats, async prompt() { prompts += 1; }, dispose() {} })));
  await assert.rejects(executor.execute("work", { label: "worker", workflowName: "flow", retries: 1, onAttempt: (attempt) => { if (attempt.result !== undefined) { terminalAttempts += 1; throw new Error("persist failed"); } } }), (error: unknown) => {
    if (!(error instanceof Error)) return false;
    thrownAttempts = (error as WorkflowError & { attempts?: typeof thrownAttempts }).attempts;
    return error.message === "persist failed";
  });
  assert.equal(prompts, 1);
  assert.equal(terminalAttempts, 1);
  assert.deepEqual(thrownAttempts?.map(({ attempt, result, error }) => ({ attempt, result, error })), [{ attempt: 1, result: "done", error: undefined }]);
});
void test("does not retry after terminal failure persistence fails and preserves attempt history", async () => {
  let prompts = 0;
  let terminalAttempts = 0;
  let thrownAttempts: readonly import("../src/agent-execution.js").AgentAttempt[] | undefined;
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({ sessionId: "failure-persist", messages: [assistant("done")], getSessionStats: sessionStats, async prompt() { prompts += 1; throw new Error("agent failed"); }, dispose() {} })));
  await assert.rejects(executor.execute("work", { label: "worker", workflowName: "flow", retries: 1, onAttempt: (attempt) => { if (attempt.error !== undefined) { terminalAttempts += 1; throw new Error("persist failed"); } } }), (error: unknown) => {
    if (!(error instanceof Error)) return false;
    thrownAttempts = (error as WorkflowError & { attempts?: typeof thrownAttempts }).attempts;
    return error.message === "persist failed";
  });
  assert.equal(prompts, 1);
  assert.equal(terminalAttempts, 1);
  assert.deepEqual(thrownAttempts?.map(({ attempt, error }) => ({ attempt, error })), [{ attempt: 1, error: { code: "AGENT_FAILED", message: "agent failed" } }]);
});
void test("failed attempt disposal does not mask the agent failure", async () => {
  let prompts = 0;
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({ sessionId: "failed-dispose", messages: [assistant("failed")], getSessionStats: sessionStats, async prompt() { prompts += 1; throw new Error("primary prompt failure"); }, dispose() { throw new Error("session_shutdown cleanup failure"); } })));
  let attempts: readonly import("../src/agent-execution.js").AgentAttempt[] | undefined;
  await assert.rejects(executor.execute("work", { label: "worker", workflowName: "flow", retries: 1 }), (error: unknown) => {
    if (!(error instanceof Error)) return false;
    attempts = (error as WorkflowError & { attempts?: typeof attempts }).attempts;
    return error.message === "primary prompt failure";
  });
  assert.equal(prompts, 2);
  assert.ok(attempts);
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0]?.error?.message, "primary prompt failure");
});
void test("does not retry after terminal success disposal fails and preserves attempt history", async () => {
  let prompts = 0;
  let disposals = 0;
  let thrownAttempts: readonly import("../src/agent-execution.js").AgentAttempt[] | undefined;
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({ sessionId: "success-dispose", messages: [assistant("done")], getSessionStats: sessionStats, async prompt() { prompts += 1; }, dispose() { disposals += 1; throw new Error("dispose failed"); } })));
  await assert.rejects(executor.execute("work", { label: "worker", workflowName: "flow", retries: 1 }), (error: unknown) => {
    if (!(error instanceof Error)) return false;
    thrownAttempts = (error as WorkflowError & { attempts?: typeof thrownAttempts }).attempts;
    return error.message === "dispose failed";
  });
  assert.equal(prompts, 1);
  assert.equal(disposals, 1);
  assert.deepEqual(thrownAttempts?.map(({ attempt, result, error }) => ({ attempt, result, error })), [{ attempt: 1, result: "done", error: undefined }]);
});
void test("reports terminal attempts without a live session before disposal", async () => {
  const events: string[] = [];
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({ sessionId: "terminal-attempt", messages: [assistant("done")], getSessionStats: sessionStats, async prompt() {}, dispose() { events.push("dispose"); } })));
  const result = await executor.execute("work", { label: "worker", workflowName: "flow", onAttempt: (attempt) => { events.push(`${attempt.liveSession ? "live" : "not-live"}:${attempt.result === undefined ? "active" : "result"}`); } });
  assert.equal(result.value, "done");
  assert.deepEqual(events, ["not-live:active", "live:active", "not-live:result", "dispose"]);
});
void test("setup hooks can wrap the selected transport session", async () => {
  const events: string[] = [];
  const base = testTransport(async () => ({ sessionId: "wrapped-base", messages: [assistant("wrapped result")], getSessionStats: sessionStats, async prompt() { events.push("base-prompt"); }, dispose() { events.push("base-dispose"); } }));
  const wrapped: import("../src/types.js").AgentTransport = {
    id: "wrapped",
    async createSession(prepared, context) {
      const session = await base.createSession(prepared, context);
      return {
        ...session,
        reference: { ...session.reference, transport: "wrapped" },
        async prompt(text) { events.push(`wrapper-prompt:${text}`); const result = await session.prompt(text); events.push("wrapper-result"); return result; },
        async dispose() { events.push("wrapper-dispose"); await session.dispose(); },
      };
    },
  };
  const result = await new WorkflowAgentExecutor({ ...root, agentSetupHooks: [{ name: "wrap", priority: 1, setup(agent) { agent.transport = wrapped; } }] }, localAgentTransport).execute("work", { label: "worker", workflowName: "flow" });
  assert.equal(result.value, "wrapped result");
  assert.equal(result.attempts[0]?.session?.transport, "wrapped");
  assert.match(events[0] ?? "", /^wrapper-prompt:Workflow: flow\nAgent: worker/);
  assert.deepEqual(events.slice(1), ["base-prompt", "wrapper-result", "wrapper-dispose", "base-dispose"]);
});
void test("reruns setup hooks and reselects the transport for ordinary retries", async () => {
  const selected: string[] = [];
  const makeTransport = (id: string, fail: boolean): import("../src/types.js").AgentTransport => ({
    id,
    async createSession(prepared) {
      selected.push(id);
      return {
        reference: { transport: id, sessionId: id },
        getState: () => ({ model: prepared.model, tools: prepared.tools }),
        getSessionStats: sessionStats,
        getLastAssistant: () => undefined,
        subscribe() { return () => undefined; },
        async prompt() { if (fail) throw new Error("retry"); return { assistant: { role: "assistant", content: [{ type: "text", text: "done" }] } }; },
        async steer() {},
        async abort() {},
        async dispose() {},
      };
    },
  });
  const first = makeTransport("first", true);
  const second = makeTransport("second", false);
  let hookAttempts = 0;
  const executor = new WorkflowAgentExecutor({ ...root, agentSetupHooks: [{ name: "select", priority: 0, setup(agent, context) { hookAttempts += 1; agent.transport = context.attempt === 1 ? first : second; } }] }, localAgentTransport);
  const result = await executor.execute("work", { label: "worker", workflowName: "flow", retries: 1 });
  assert.equal(result.value, "done");
  assert.deepEqual(selected, ["first", "second"]);
  assert.equal(hookAttempts, 2);
  assert.deepEqual(result.attempts.map(({ transport, session }) => [transport, session?.transport]), [["first", "first"], ["second", "second"]]);
});

void test("persists a selected transport when session creation fails", async () => {
  const attempts: unknown[] = [];
  const transport = {
    id: "connect-failure",
    async createSession() { throw new Error("connection failed"); },
  } satisfies import("../src/types.js").AgentTransport;
  await assert.rejects(new WorkflowAgentExecutor(root, transport).execute("work", { label: "worker", workflowName: "flow", onAttempt: (attempt) => { attempts.push(attempt); } }), (error: unknown) => {
    const typed = error as WorkflowError & { attempts?: readonly { session?: unknown; transport?: string; error?: { message: string } }[] };
    assert.equal(typed.code, "AGENT_FAILED");
    const latest = typed.attempts?.at(-1);
    assert.ok(latest);
    assert.equal(latest.transport, "connect-failure");
    assert.equal(latest.session, undefined);
    assert.equal(latest.error?.message, "connection failed");
    return true;
  });
  assert.equal(attempts.length, 2);
});
void test("rejects a session whose reference transport differs from the selected transport", async () => {
  let disposed = 0;
  const transport: import("../src/types.js").AgentTransport = {
    id: "selected",
    async createSession(prepared) {
      return {
        reference: { transport: "wrong", sessionId: "mismatch" },
        getState: () => ({ model: prepared.model, tools: prepared.tools }),
        getSessionStats: sessionStats,
        getLastAssistant: () => undefined,
        subscribe() { return () => undefined; },
        async prompt() { return { assistant: { role: "assistant", content: [{ type: "text", text: "unused" }] } }; },
        async steer() {},
        async abort() {},
        async dispose() { disposed += 1; },
      };
    },
  };
  const attempts: Array<{ session?: unknown }> = [];
  await assert.rejects(new WorkflowAgentExecutor(root, transport).execute("work", { label: "worker", workflowName: "flow", onAttempt: (attempt) => { attempts.push(attempt); } }), (error: unknown) => error instanceof WorkflowError && error.code === "INTERNAL_ERROR");
  assert.equal(disposed, 1);
  assert.equal(attempts.at(-1)?.session, undefined);
});
void test("rejects transport-reported tools outside the prepared capability ceiling", async () => {
  let prompted = false;
  let disposed = 0;
  const transport: import("../src/types.js").AgentTransport = {
    id: "widened",
    async createSession(prepared) {
      return {
        reference: { transport: "widened", sessionId: "widened-session" },
        getState: () => ({ model: prepared.model, tools: ["read", "write"] }),
        getSessionStats: sessionStats,
        getLastAssistant: () => undefined,
        subscribe() { return () => undefined; },
        async prompt() { prompted = true; return { assistant: { role: "assistant", content: [{ type: "text", text: "unexpected" }] } }; },
        async steer() {},
        async abort() {},
        async dispose() { disposed += 1; },
      };
    },
  };
  await assert.rejects(new WorkflowAgentExecutor(root, transport).execute("work", { label: "worker", workflowName: "flow" }), (error: unknown) => error instanceof WorkflowError && error.code === "INTERNAL_ERROR" && error.message === "Agent transport widened widened the prepared tool policy");
  assert.equal(prompted, false);
  assert.equal(disposed, 1);
});

void test("resolves explicit capabilities without widening least privilege", () => {
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => { throw new Error("unused"); }));
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", role: "reviewer" }), { model: { provider: "anthropic", model: "opus", thinking: "high" }, tools: ["read"], systemPromptAppend: "Review carefully" });
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", role: "scout" }).tools, ["read", "grep"]);
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", model: "google/gemini" }), { model: { provider: "google", model: "gemini", thinking: "medium" }, tools: ["read", "grep", "find", "bash"], systemPromptAppend: "" });
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", model: "google/gemini", tools: [] }).tools, []);
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", tools: ["read", "grep"] }).tools, ["read", "grep"]);
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", tools: ["read", "write"] }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", model: "missing/model" }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", role: "missing" }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_AGENT_TYPE");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", role: "reviewer", model: "google/gemini" }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", role: "reviewer", thinking: "low" }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", role: "reviewer", tools: [] }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  const broken = new WorkflowAgentExecutor({ ...root, agentDefinitions: { broken: { tools: ["write"] } } }, testTransport(async () => { throw new Error("must not launch"); }));
  assert.throws(() => broken.resolve({ label: "a", workflowName: "w", role: "broken" }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
});
void test("applies named role object overrides to the resolved role policy", () => {
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => { throw new Error("unused"); }));
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", role: { name: "reviewer" } }), { model: { provider: "anthropic", model: "opus", thinking: "high" }, tools: ["read"], systemPromptAppend: "Review carefully" });
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", role: { name: "reviewer", model: "google/gemini", thinking: "low", tools: ["read", "grep"] } }), { model: { provider: "google", model: "gemini", thinking: "low" }, tools: ["read", "grep"], systemPromptAppend: "Review carefully" });
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", role: { name: "reviewer", tools: [] } }).tools, []);
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", role: { name: "reviewer", tools: null } }).tools, ["read", "grep", "find", "bash"]);
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", role: { name: "scout", tools: null } }).tools, ["read", "grep", "find", "bash"]);
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", role: { name: "scout", model: null, thinking: null } }), { model: { provider: "openai", model: "gpt", thinking: "medium" }, tools: ["read", "grep"], systemPromptAppend: "Inspect broadly" });
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", role: { name: "missing" } }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_AGENT_TYPE");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", role: { name: "reviewer" }, model: "google/gemini" }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", role: { name: "reviewer", tools: ["write"] } }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", role: { name: "reviewer", model: "missing/model" } }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL");
});
void test("role object overrides carry description, context files, resource exclusions, and system prompt policy", async () => {
  const basePolicy: AgentResourcePolicy = { globalSettingsPath: "/g", projectSettingsPath: "/p", projectTrusted: true, global: { skills: [], extensions: [] }, project: { skills: [], extensions: [] }, effective: { skills: ["global"], extensions: ["/global.ts"] }, unmatchedSkills: [], unmatchedExtensions: [] };
  const roleRoot: AgentExecutionRoot = { ...root, agentDefinitions: { ...root.agentDefinitions, scoped: { prompt: "Scoped role", contextFiles: ["global", "project"], overrideSystemPrompt: true, disabledAgentResources: { skills: ["role-skill"], extensions: ["/role.ts"] } } }, agentResourcePolicy: () => structuredClone(basePolicy) };
  const executor = new WorkflowAgentExecutor(roleRoot, testTransport(async () => { throw new Error("unused"); }));
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", role: { name: "scoped", description: "per-call", contextFiles: ["cwd"], overrideSystemPrompt: false } }), { model: { provider: "openai", model: "gpt", thinking: "medium" }, tools: ["read", "grep", "find", "bash"], systemPromptAppend: "Scoped role", contextFiles: ["cwd"] });
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", role: { name: "scoped", contextFiles: null, overrideSystemPrompt: null } }), { model: { provider: "openai", model: "gpt", thinking: "medium" }, tools: ["read", "grep", "find", "bash"], systemPromptAppend: "Scoped role" });
  const prepared = await prepareAgentSetupForInspection(roleRoot, "probe", { label: "a", workflowName: "w", role: { name: "scoped", disabledAgentResources: { skills: ["extra"], extensions: [] } } }, localAgentTransport);
  assert.ok(prepared.setup.sessionInput.resourcePolicy);
  assert.deepEqual(prepared.setup.sessionInput.resourcePolicy.effective, { skills: ["global", "extra"], extensions: ["/global.ts"] });
});
void test("passes role prompt as system append, not task text", async () => {
  let input: unknown;
  let prompt = "";
  const executor = new WorkflowAgentExecutor(root, testTransport(async (sessionInput) => { input = sessionInput; return { transport: "local", session: { transport: "local", sessionId: "role", locator: { sessionFile: "/sessions/role.jsonl" } }, messages: [assistant("done")], getSessionStats: sessionStats, prompt: async (text) => { prompt = text; }, dispose() {} }; }));
  await executor.execute("Do work", { label: "worker", workflowName: "flow", role: "reviewer", effectiveTools: ["read", "grep"] });
  assert.equal((input as { systemPromptAppend?: string }).systemPromptAppend, "Review carefully");
  assert.deepEqual((input as { tools?: readonly string[] }).tools, ["read"]);
  assert.doesNotMatch(prompt, /Review carefully/);
  assert.match(prompt, /Task:\nDo work/);
});

void test("carries role context file scope policy into session preparation", async () => {
  const roleRoot: AgentExecutionRoot = { ...root, agentDefinitions: { ...root.agentDefinitions, scoped: { prompt: "Scoped role", contextFiles: ["global", "project"] } } };
  let input: SessionInput | undefined;
  const executor = new WorkflowAgentExecutor(roleRoot, testTransport(async (sessionInput) => { input = sessionInput; return { transport: "local", session: { transport: "local", sessionId: "scoped", locator: { sessionFile: "/sessions/scoped.jsonl" } }, messages: [assistant("done")], getSessionStats: sessionStats, prompt: async () => {}, dispose() {} }; }));
  assert.deepEqual(executor.resolve({ label: "worker", workflowName: "flow", role: "scoped" }).contextFiles, ["global", "project"]);
  await executor.execute("Do work", { label: "worker", workflowName: "flow", role: "scoped" });
  assert.deepEqual(input?.contextFiles, ["global", "project"]);
});
void test("uses a role body as the full system prompt when requested", async () => {
  const roleRoot: AgentExecutionRoot = { ...root, agentDefinitions: { ...root.agentDefinitions, override: { prompt: "Replace the system prompt", model: "anthropic/opus", thinking: "high", tools: ["read"], overrideSystemPrompt: true } } };
  let input: unknown;
  const executor = new WorkflowAgentExecutor(roleRoot, testTransport(async (sessionInput) => { input = sessionInput; return { transport: "local", session: { transport: "local", sessionId: "override", locator: { sessionFile: "/sessions/override.jsonl" } }, messages: [assistant("done")], getSessionStats: sessionStats, prompt: async () => {}, dispose() {} }; }));
  assert.deepEqual(executor.resolve({ label: "worker", workflowName: "flow", role: "override" }), { model: { provider: "anthropic", model: "opus", thinking: "high" }, tools: ["read"], systemPrompt: "Replace the system prompt", systemPromptAppend: "" });
  await executor.execute("Do work", { label: "worker", workflowName: "flow", role: "override" });
  assert.equal((input as { systemPrompt?: string }).systemPrompt, "Replace the system prompt");
  assert.equal((input as { systemPromptAppend?: string }).systemPromptAppend, "");
});
void test("prepares the resolved workflow system prompt path for external transports", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-system-prompt-path-"));
  const cwd = join(rootDir, "project");
  const systemPromptPath = join(cwd, ".pi", "pi-extensible-workflows", "SYSTEM.md");
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  writeFileSync(systemPromptPath, "Project workflow system");
  let prepared: import("../src/types.js").PreparedAgentSession | undefined;
  const transport: import("../src/types.js").AgentTransport = {
    id: "capture",
    async createSession(value) {
      prepared = value;
      return {
        reference: { transport: "capture", sessionId: "system-prompt-path" },
        getState: () => ({ model: value.model, tools: value.tools }),
        getLastAssistant: () => undefined,
        getSessionStats: sessionStats,
        subscribe: () => () => {},
        async prompt() { return { assistant: assistant("done") }; },
        async steer() {},
        async abort() {},
        async dispose() {},
      };
    },
  };
  await new WorkflowAgentExecutor({ ...root, cwd, agentDir: join(rootDir, "agent") }, transport).execute("work", { label: "worker", workflowName: "flow" });
  assert.equal(prepared?.systemPrompt, undefined);
  assert.equal(prepared?.systemPromptPath, systemPromptPath);
  assert.ok(prepared);
  assert.equal(prepared.piRuntime?.executable, process.execPath);
  const runtime = prepared.piRuntime;
  assert.ok(runtime);
  assert.ok(runtime.entrypoint);
  assert.match(runtime.entrypoint, /@earendil-works[\\/]pi-coding-agent[\\/]dist[\\/]cli\.js$/);
});

void test("persists the effective role system prompt emitted for the native turn", async () => {
  const saved: Array<{ sessionId: string; attempt: number; turn: number; prompt: string }> = [];
  let listener: ((event: TestPiSessionEvent) => void) | undefined;
  const runStore = { ...runStoreDefaults, recordSystemPrompt: async (entry: (typeof saved)[number]) => { saved.push(entry); } } satisfies AgentExecutionRunStore;
  const executor = new WorkflowAgentExecutor({ ...root, runStore }, testTransport(async (input) => ({
    transport: "local", session: { transport: "local", sessionId: "role", locator: { sessionFile: "/sessions/role.jsonl" } }, messages: [assistant("done")], getSessionStats: sessionStats,
    systemPrompt: `BASE\n\n${input.systemPromptAppend ?? ""}`,
    subscribe(candidate) { listener = candidate; return () => {}; },
    async prompt() { listener?.({ type: "agent_start" }); },
    dispose() {},
  })));
  await executor.execute("Do work", { label: "worker", workflowName: "flow", role: "reviewer" });
  assert.deepEqual(saved, [{ sessionId: "role", attempt: 1, turn: 1, prompt: "BASE\n\nReview carefully" }]);
});

void test("does not mask agent failures when system prompt persistence also fails", async () => {
  let listener: ((event: TestPiSessionEvent) => void) | undefined;
  const runStore = { ...runStoreDefaults, recordSystemPrompt: async () => { throw new Error("disk full"); } } satisfies AgentExecutionRunStore;
  const executor = new WorkflowAgentExecutor({ ...root, runStore }, testTransport(async () => ({
    transport: "local", session: { transport: "local", sessionId: "failed", locator: { sessionFile: "/sessions/failed.jsonl" } }, messages: [], getSessionStats: sessionStats, systemPrompt: "effective",
    subscribe(candidate) { listener = candidate; return () => {}; },
    async prompt() { listener?.({ type: "agent_start" }); throw new Error("provider failed"); },
    dispose() {},
  })));
  await assert.rejects(executor.execute("Do work", { label: "worker", workflowName: "flow" }), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === "provider failed");
});


void test("runs prioritized setup hooks with fresh retry baselines and safe attempt summaries", async () => {
  const order: string[] = [];
  const inputs: Array<{ prompt: string; options: Record<string, unknown>; tools: readonly string[]; cwd: string }> = [];
  const hooks = [
    { name: "z-last", priority: 10, async setup(agent: { prompt: string; options: Record<string, unknown>; sessionInput: { tools: readonly string[]; cwd: string } }, context: { attempt: number }) { order.push(`${String(context.attempt)}:z-last`); agent.prompt += " z"; agent.sessionInput.tools = ["bash"]; } },
    { name: "a-first", priority: 10, setup(agent: { prompt: string; options: Record<string, unknown>; sessionInput: { tools: readonly string[]; cwd: string } }, context: { attempt: number }) { order.push(`${String(context.attempt)}:a-first`); assert.equal(Object.hasOwn(agent.options, "transient"), false); agent.prompt += " a"; agent.options.transient = context.attempt === 1 ? "discard" : "fresh"; agent.sessionInput.tools = ["grep"]; agent.sessionInput.cwd = "/hooked"; } },
    { name: "early", priority: 1, setup(agent: { prompt: string; options: Record<string, unknown>; sessionInput: { tools: readonly string[]; cwd: string } }, context: { attempt: number }) { order.push(`${String(context.attempt)}:early`); agent.options.seen = true; } },
  ];
  let created = 0;
  const executor = new WorkflowAgentExecutor({ ...root, agentSetupHooks: hooks }, testTransport(async (input) => {
    inputs.push({ prompt: input.options?.transient === "fresh" ? "fresh" : "baseline", options: input.options ?? {}, tools: input.tools, cwd: input.cwd });
    const attempt = ++created;
    return { sessionId: `hook-${String(attempt)}`, sessionFile: `/sessions/hook-${String(attempt)}.jsonl`, messages: [assistant("done")], getSessionStats: sessionStats, async prompt(text) { if (attempt === 1) throw new Error(text); }, dispose() {} };
  }));
  const result = await executor.execute("original", { label: "hooked", workflowName: "flow", retries: 1, timeoutMs: 5, agentOptions: { advisor: true } });
  assert.equal(result.value, "done");
  assert.deepEqual(order, ["1:early", "1:a-first", "1:z-last", "2:early", "2:a-first", "2:z-last"]);
  assert.deepEqual(inputs.map(({ tools, cwd }) => ({ tools, cwd })), [{ tools: ["bash"], cwd: "/hooked" }, { tools: ["bash"], cwd: "/hooked" }]);
  assert.deepEqual(result.attempts.map(({ setup }) => setup.hookNames), [["early", "a-first", "z-last"], ["early", "a-first", "z-last"]]);
  assert.equal(result.attempts[1]?.setup.model.provider, "openai");
});

void test("provider limits pause and retry the same native session", async () => {
  let prompts = 0;
  let pauses = 0;
  const executor = new WorkflowAgentExecutor({ ...root, providerPause: async () => { pauses += 1; } }, testTransport(async () => ({ transport: "local", session: { transport: "local", sessionId: "same", locator: { sessionFile: "/sessions/same.jsonl" } }, messages: [assistant("continued")], getSessionStats: sessionStats, prompt: async () => { prompts += 1; if (prompts === 1) throw Object.assign(new Error("limited"), { status: 429 }); }, dispose() {} })));
  assert.equal((await executor.execute("work", { label: "worker", workflowName: "flow" })).value, "continued");
  assert.equal(prompts, 2);
  assert.equal(pauses, 1);
});

void test("returns final text and captures persisted native session accounting", async () => {
  const prompts: string[] = [];
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({ transport: "local", session: { transport: "local", sessionId: "s1", locator: { sessionFile: "/sessions/s1.jsonl" } }, messages: [assistant("done")], getSessionStats: sessionStats, prompt: async (prompt) => { prompts.push(prompt); }, dispose() {} })));
  const result = await executor.execute("Do work", { label: "worker", workflowName: "flow", phase: "build", parent: "root", cwd: root.cwd });
  assert.equal(result.value, "done");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /Workflow: flow[\s\S]*Phase: build[\s\S]*Parent: root[\s\S]*Task:\nDo work/);
  assert.deepEqual(result.attempts[0], { attempt: 1, transport: "local", session: { transport: "local", sessionId: "s1", locator: { sessionFile: "/sessions/s1.jsonl" } }, result: "done", accounting: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25 }, setup: { hookNames: [], model: root.model, tools: ["read", "grep", "find", "bash"], cwd: "/repo" } });
});

void test("exposes native attempt metadata before the prompt completes", async () => {
  let finish!: () => void;
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => { promptStarted = resolve; });
  let exposed!: (value: import("../src/agent-execution.js").AgentAttempt) => void;
  const exposure = new Promise<import("../src/agent-execution.js").AgentAttempt>((resolve) => { exposed = resolve; });
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({ transport: "local", session: { transport: "local", sessionId: "active", locator: { sessionFile: "/sessions/active.jsonl" } }, messages: [assistant("done")], getSessionStats: sessionStats, prompt: () => new Promise<void>((resolve) => { finish = resolve; promptStarted(); }), dispose() {} })));
  const running = executor.execute("work", { label: "worker", workflowName: "flow", onAttempt: (attempt) => { exposed(attempt); } });
  assert.deepEqual(await exposure, { attempt: 1, transport: "local", accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, setup: { hookNames: [], model: root.model, tools: ["read", "grep", "find", "bash"], cwd: "/repo" } });
  await started;
  finish();
  await running;
});

void test("streams non-content and tool-call progress", async () => {
  let listener: ((event: TestPiSessionEvent) => void) | undefined;
  const messages = [assistant("")];
  const updates: AgentProgress[] = [];
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({
    transport: "local", session: { transport: "local", sessionId: "progress", locator: { sessionFile: "/sessions/progress.jsonl" } }, messages, getSessionStats: sessionStats,
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    async prompt() {
      listener?.(messageStart(messages[0]));
      listener?.(messageUpdate(messages[0], thinkingStart(messages[0])));
      listener?.(messageUpdate(messages[0], thinkingDelta(messages[0], "REASONING_ONE")));
      listener?.(messageUpdate(messages[0], thinkingDelta(messages[0], "REASONING_TWO")));
      for (let index = 0; index < 100; index += 1) listener?.(messageUpdate(messages[0], thinkingDelta(messages[0], "reasoning")));
      listener?.(toolExecutionStart("call-1", "read", {}));
      messages[0] = assistant("done");
      listener?.(messageUpdate(messages[0], textStart(messages[0])));
      listener?.(messageUpdate(messages[0], textDelta(messages[0], "RESPONSE_ONE")));
      listener?.(messageUpdate(messages[0], textDelta(messages[0], "RESPONSE_TWO")));
      for (let index = 0; index < 100; index += 1) listener?.(messageUpdate(messages[0], textDelta(messages[0], "response")));
      listener?.(toolExecutionEnd("call-1", "read", {}, false));
      listener?.(messageEnd(messages[0]));
    },
    dispose() {},
  })));
  const result = await executor.execute("work", { label: "worker", workflowName: "flow", onProgress: (update) => { updates.push(update); } });
  assert.equal(result.value, "done");
  assert.equal(updates.length, 8);
  assert.doesNotMatch(JSON.stringify(updates), /REASONING_ONE|REASONING_TWO|RESPONSE_ONE|RESPONSE_TWO/);
  assert.ok(updates.some(({ activity }) => activity?.kind === "reasoning" && activity.text === "reasoning"));
  assert.ok(updates.some(({ activity }) => activity?.kind === "text" && activity.text === "responding"));
  assert.ok(updates.some(({ toolCalls, activity }) => activity?.kind === "tool" && toolCalls.some(({ name, state }) => name === "read" && state === "running")));
  assert.ok(updates.some(({ toolCalls, persist }) => !persist && toolCalls.some(({ name, state }) => name === "read" && state === "completed")));
  assert.deepEqual(updates.at(-1)?.accounting, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25 });
  assert.deepEqual(updates.at(-1)?.toolCalls, []);
  assert.equal(updates.at(-1)?.persist, true);
  assert.equal(typeof updates.at(-1)?.lastEventAt, "number");
});
void test("uses cumulative session stats after compaction for progress, budget, and attempts", async () => {
  let listener: ((event: TestPiSessionEvent) => void) | undefined;
  const updates: AgentProgress[] = [];
  const budgetAccounting: AgentProgress["accounting"][] = [];
  const activeMessages = [assistant("compacted response")];
  const cumulative = { tokens: { input: 100, output: 50, cacheRead: 25, cacheWrite: 10, total: 185 }, cost: 9 };
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({
    transport: "local", session: { transport: "local", sessionId: "compaction-safe", locator: { sessionFile: "/sessions/compaction-safe.jsonl" } }, messages: activeMessages, getSessionStats: () => cumulative,
    subscribe(next) { listener = next; return () => {}; },
    async prompt() {
      listener?.(messageStart(activeMessages[0]));
      listener?.(messageEnd(activeMessages[0]));
    },
    dispose() {},
  })));
  const budget = { beforeAttempt() {}, beforeTurn() {}, afterTurn(accounting: AgentProgress["accounting"]) { budgetAccounting.push(accounting); }, instruction() { return undefined; } };
  const result = await executor.execute("work", { label: "worker", workflowName: "flow", onProgress: (update) => { updates.push(update); }, budget });
  const expected = { input: 100, output: 50, cacheRead: 25, cacheWrite: 10, cost: 9 };
  assert.ok(updates.some(({ accounting }) => JSON.stringify(accounting) === JSON.stringify(expected)));
  assert.ok(budgetAccounting.length > 0 && budgetAccounting.every((accounting) => JSON.stringify(accounting) === JSON.stringify(expected)));
  assert.deepEqual(result.attempts[0]?.accounting, expected);
});

void test("keeps workflow_result present, validates invalid values, and allows one repair", async () => {
  const responses: Array<{ wrong: boolean } | { answer: number }> = [{ wrong: true }, { wrong: true }, { answer: 9 }];
  const calls: Array<{ prompt: string; result: unknown }> = [];
  const toolResults: unknown[] = [];
  const executor = new WorkflowAgentExecutor(root, testTransport(async ({ resultTool }) => {
    assert.ok(resultTool);
    return { transport: "local", session: { transport: "local", sessionId: "schema", locator: { sessionFile: "/sessions/schema.jsonl" } }, messages: [assistant("ignored")], getSessionStats: sessionStats, async prompt(prompt) {
      const result = responses.shift();
      if (result !== undefined) {
        calls.push({ prompt, result });
        toolResults.push(await ("answer" in result ? executeTool(resultTool, "id", result) : executeToolUnchecked(resultTool, "id", result)));
      }
    }, dispose() {} };
  }));
  const result = await executor.execute("structured", { label: "schema", workflowName: "flow", role: "reviewer", schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false } });
  assert.deepEqual(result.value, { answer: 9 });
  assert.equal(calls.length, 3);
  assert.equal((toolResults[0] as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(toolResults[0]), /Result does not match the required schema/);
  assert.equal((toolResults[1] as { isError?: boolean }).isError, true);
  assert.match(JSON.stringify(toolResults[1]), /Result does not match the required schema/);
  assert.match(calls[1]?.prompt ?? "", /Submit the final result/);
  assert.match(calls[2]?.prompt ?? "", /Repair/);
});

void test("accepts workflow_result before agent_end without repair or overwrite", async () => {
  let listener: ((event: TestPiSessionEvent) => void) | undefined;
  let prompts = 0;
  let aborts = 0;
  const executor = new WorkflowAgentExecutor(root, testTransport(async ({ resultTool }) => {
    assert.ok(resultTool);
    const message = { role: "assistant", content: [{ type: "toolCall", id: "early", name: "workflow_result", arguments: { answer: 7 } }] };
    return {
      transport: "local", session: { transport: "local", sessionId: "early-schema", locator: { sessionFile: "/sessions/early-schema.jsonl" } }, messages: [assistant("ignored")], getSessionStats: sessionStats,
      subscribe(next) { listener = next; return () => { listener = undefined; }; },
      async prompt() {
        prompts += 1;
        listener?.(messageStart(message));
        listener?.(toolExecutionStart("early", "workflow_result", { answer: 7 }));
        const accepted = await executeTool(resultTool, "early", { answer: 7 });
        assert.equal((accepted as { isError?: boolean }).isError, undefined);
        const duplicate = await executeTool(resultTool, "duplicate", { answer: 9 });
        assert.equal((duplicate as { isError?: boolean }).isError, true);
        listener?.(toolExecutionEnd("early", "workflow_result", accepted, false));
        listener?.(messageEnd(message));
        listener?.(agentEnd());
      },
      async abort() { aborts += 1; },
      dispose() {},
    };
  }));
  const result = await executor.execute("structured", { label: "schema", workflowName: "flow", schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false } });
  assert.deepEqual(result.value, { answer: 7 });
  assert.equal(prompts, 1);
  assert.equal(aborts, 1);
});

void test("fails native terminal provider errors before structured finalization", async () => {
  const errorMessage = "OAuth refresh failed for anthropic";
  const messages = [terminalAssistant(errorMessage)];
  const prompts: string[] = [];
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({ transport: "local", session: { transport: "local", sessionId: "terminal", locator: { sessionFile: "/sessions/terminal.jsonl" } }, messages, getSessionStats: sessionStats, async prompt(prompt) { prompts.push(prompt); }, dispose() {} })));
  let attempts: readonly import("../src/agent-execution.js").AgentAttempt[] | undefined;
  await assert.rejects(executor.execute("structured", { label: "schema", workflowName: "flow", schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false } }), (error: unknown) => {
    if (!(error instanceof WorkflowError)) return false;
    attempts = (error as WorkflowError & { attempts?: typeof attempts }).attempts;
    return error.code === "AGENT_FAILED" && error.message === errorMessage;
  });
  assert.equal(prompts.length, 1);
  assert.ok(attempts);
  const session = attempts[0]?.session;
  assert.ok(session);
  const locator = session.locator;
  assert.ok(locator && typeof locator === "object" && !Array.isArray(locator));
  assert.equal((locator as { sessionFile?: string }).sessionFile, "/sessions/terminal.jsonl");
  const failedAttempt = attempts[0];
  assert.ok(failedAttempt);
  assert.deepEqual(failedAttempt.error, { code: "AGENT_FAILED", message: errorMessage });
});
void test("falls back when a terminal provider error omits errorMessage", async () => {
  const messages = [{ ...assistant(""), stopReason: "error" }];
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({ transport: "local", session: { transport: "local", sessionId: "terminal-without-message", locator: { sessionFile: "/sessions/terminal-without-message.jsonl" } }, messages, getSessionStats: sessionStats, async prompt() {}, dispose() {} })));
  let attempts: readonly { error?: { code: string; message: string } }[] | undefined;
  await assert.rejects(executor.execute("work", { label: "worker", workflowName: "flow" }), (error: unknown) => {
    if (!(error instanceof WorkflowError)) return false;
    attempts = (error as WorkflowError & { attempts?: typeof attempts }).attempts;
    return error.code === "AGENT_FAILED" && error.message === "Workflow agent session ended with a terminal provider error";
  });
  assert.deepEqual(attempts?.[0]?.error, { code: "AGENT_FAILED", message: "Workflow agent session ended with a terminal provider error" });
});

void test("preserves a prior report after an empty aborted assistant turn", async () => {
  const report = { role: "assistant", content: [{ type: "text", text: "report" }] };
  const aborted = { role: "assistant", content: [], stopReason: "aborted", errorMessage: "Request was aborted" };
  const transport = {
    id: "aborted-test",
    async createSession(prepared: Readonly<import("../src/types.js").PreparedAgentSession>) {
      return {
        reference: { transport: "aborted-test", sessionId: "aborted-after-compaction" },
        getState: () => ({ model: prepared.model, tools: prepared.tools }),
        getSessionStats: sessionStats,
        getLastAssistant: () => report,
        subscribe() { return () => undefined; },
        async prompt() { return { assistant: aborted }; },
        async steer() {},
        async abort() {},
        async dispose() {},
      };
    },
  } satisfies import("../src/types.js").AgentTransport;
  const result = await new WorkflowAgentExecutor(root, transport).execute("work", { label: "worker", workflowName: "flow" });
  assert.equal(result.value, "report");
});
void test("fails terminal provider errors during finalization without repair", async () => {
  const errorMessage = "OAuth refresh failed during finalization";
  const messages = [assistant("ready")];
  const prompts: string[] = [];
  let promptCount = 0;
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({ transport: "local", session: { transport: "local", sessionId: "finalization-terminal", locator: { sessionFile: "/sessions/finalization-terminal.jsonl" } }, messages, getSessionStats: sessionStats, async prompt(prompt) { prompts.push(prompt); promptCount += 1; if (promptCount === 2) messages.push(terminalAssistant(errorMessage)); }, dispose() {} })));
  await assert.rejects(executor.execute("structured", { label: "schema", workflowName: "flow", schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false } }), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === errorMessage);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /Submit the final result/);
  assert.doesNotMatch(prompts.join("\n"), /Repair/);
});

void test("retries native terminal errors as fresh workflow attempts", async () => {
  const errorMessage = "OAuth refresh failed for retry";
  const promptsByAttempt: string[][] = [];
  let created = 0;
  const executor = new WorkflowAgentExecutor(root, testTransport(async ({ resultTool }) => {
    const attempt = ++created;
    const prompts: string[] = [];
    promptsByAttempt.push(prompts);
    const messages = attempt === 1 ? [terminalAssistant(errorMessage)] : [assistant("ready")];
    return { sessionId: `terminal-retry-${String(attempt)}`, sessionFile: `/sessions/terminal-retry-${String(attempt)}.jsonl`, messages, getSessionStats: sessionStats, async prompt(prompt) { prompts.push(prompt); if (attempt === 2 && prompt.includes("Submit the final result")) { assert.ok(resultTool); await executeTool(resultTool, "id", { answer: 42 }); } }, dispose() {} };
  }));
  const result = await executor.execute("structured", { label: "schema", workflowName: "flow", retries: 1, schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false } });
  assert.deepEqual(result.value, { answer: 42 });
  assert.deepEqual(promptsByAttempt.map((prompts) => prompts.length), [1, 2]);
  assert.deepEqual(result.attempts.map(({ session }) => session?.sessionId), ["terminal-retry-1", "terminal-retry-2"]);
  assert.deepEqual(result.attempts[0]?.error, { code: "AGENT_FAILED", message: errorMessage });
  assert.deepEqual(result.attempts[1]?.result, { answer: 42 });
});
void test("continues terminal provider errors in the same native session when recovery retries", async () => {
  const prompts: string[] = [];
  const recoveries: Array<{ label: string; provider: string; model: string; error: string }> = [];
  const messages: Array<{ role: string; content: unknown; stopReason?: string; errorMessage?: string; usage?: typeof usage }> = [terminalAssistant("TRANSIENT_PROVIDER_ERROR")];
  let sessions = 0;
  let disposals = 0;
  const executor = new WorkflowAgentExecutor(root, testTransport(async ({ resultTool }) => {
    sessions += 1;
    assert.ok(resultTool);
    return {
      transport: "local", session: { transport: "local", sessionId: "same-session", locator: { sessionFile: "/sessions/same-session.jsonl" } }, messages, getSessionStats: sessionStats,
      async prompt(prompt) {
        prompts.push(prompt);
        if (prompts.length === 2) messages[0] = assistant("continued");
        if (prompt.includes("Submit the final result")) await executeTool(resultTool, "id", { answer: 42 });
      },
      dispose() { disposals += 1; },
    };
  }));
  const result = await executor.execute("structured", {
    label: "schema", workflowName: "flow", schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false },
    providerErrorRecovery: async (failure) => { recoveries.push(failure); return "retry"; },
  });
  assert.deepEqual(result.value, { answer: 42 });
  assert.equal(sessions, 1);
  assert.equal(disposals, 1);
  assert.equal(recoveries.length, 1);
  assert.deepEqual(result.attempts.map(({ attempt, session }) => ({ attempt, sessionId: session?.sessionId })), [{ attempt: 1, sessionId: "same-session" }]);
  assert.equal(prompts.length, 3);
  assert.match(prompts[0] ?? "", /Task:\nstructured/);
  assert.equal(prompts[1], "The provider error was transient. Continue the task from your current state.");
  assert.match(prompts[2] ?? "", /Submit the final result/);
});
void test("recovers a terminal provider error thrown by prompt before disposing the session", async () => {
  const messages: Array<{ role: string; content: unknown; stopReason?: string; errorMessage?: string; usage?: typeof usage }> = [terminalAssistant("THROWN_PROVIDER_ERROR")];
  let prompts = 0;
  let disposals = 0;
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({
    transport: "local", session: { transport: "local", sessionId: "thrown-provider", locator: { sessionFile: "/sessions/thrown-provider.jsonl" } }, messages, getSessionStats: sessionStats,
    async prompt() {
      prompts += 1;
      if (prompts === 1) throw new Error("provider request failed");
      messages[0] = assistant("done");
    },
    dispose() { assert.equal(disposals, 0); disposals += 1; },
  })));
  const result = await executor.execute("work", { label: "worker", workflowName: "flow", providerErrorRecovery: async (failure) => {
    assert.equal(disposals, 0);
    assert.deepEqual(failure, { label: "worker", provider: "openai", model: "gpt", error: "THROWN_PROVIDER_ERROR" });
    return "retry";
  } });
  assert.equal(result.value, "done");
  assert.equal(prompts, 2);
  assert.equal(disposals, 1);
  assert.deepEqual(result.attempts.map(({ attempt, session }) => ({ attempt, sessionId: session?.sessionId })), [{ attempt: 1, sessionId: "thrown-provider" }]);
});
void test("keeps an accepted structured result when same-session continuation aborts its prompt", async () => {
  const messages: Array<{ role: string; content: unknown; stopReason?: string; errorMessage?: string; usage?: typeof usage }> = [terminalAssistant("TRANSIENT_PROVIDER_ERROR")];
  let prompts = 0;
  let sessions = 0;
  let disposals = 0;
  const executor = new WorkflowAgentExecutor(root, testTransport(async ({ resultTool }) => {
    sessions += 1;
    assert.ok(resultTool);
    return {
      transport: "local", session: { transport: "local", sessionId: "same-session-abort", locator: { sessionFile: "/sessions/same-session-abort.jsonl" } }, messages, getSessionStats: sessionStats,
      async prompt(prompt) {
        prompts += 1;
        if (prompt === "The provider error was transient. Continue the task from your current state.") {
          await executeTool(resultTool, "id", { answer: 7 });
          messages[0] = assistant("accepted");
          throw new Error("aborted after workflow_result");
        }
      },
      async abort() {},
      dispose() { disposals += 1; },
    };
  }));
  const result = await executor.execute("structured", {
    label: "schema", workflowName: "flow", schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false },
    providerErrorRecovery: async () => "retry",
  });
  assert.deepEqual(result.value, { answer: 7 });
  assert.equal(sessions, 1);
  assert.equal(prompts, 2);
  assert.equal(disposals, 1);
});
void test("does not overwrite a terminal result with a post-handoff assistant", async () => {
  const completed = { ...assistant("original report"), stopReason: "stop" };
  const messages: Array<{ role: string; content: unknown; stopReason?: string; usage?: typeof usage }> = [completed];
  let listener: ((event: TestPiSessionEvent) => void) | undefined;
  let triggerHandoff: (() => void) | undefined;
  let handoffPromise: Promise<void> | undefined;
  let prompts = 0;
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({
    transport: "local", session: { transport: "local", sessionId: "handoff-defense", locator: { sessionFile: "/sessions/handoff-defense.jsonl" } }, messages, getSessionStats: sessionStats,
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    async prompt() {
      prompts += 1;
      listener?.(malformedEvent());
      triggerHandoff?.();
      listener?.(messageEnd(completed));
      listener?.(turnEnd(completed));
      await handoffPromise;
    },
    dispose() {},
  })));
  const result = await executor.execute("work", { label: "worker", workflowName: "flow", onAttempt: (attempt) => {
    if (!attempt.handoff || !attempt.liveSession) return;
    const handoff = attempt.handoff;
    triggerHandoff = () => { handoffPromise = handoff.request(async () => { handoff.takeover(); messages[0] = assistant("replacement report"); }); };
  } });
  assert.equal(result.value, "original report");
  assert.equal(prompts, 1);
});
void test("continues after a Herdr handoff with an aborted assistant", async () => {
  const aborted = { role: "assistant", content: [], stopReason: "aborted" };
  const messages: Array<{ role: string; content: unknown; stopReason?: string; usage?: typeof usage }> = [aborted];
  const prompts: string[] = [];
  let listener: ((event: TestPiSessionEvent) => void) | undefined;
  let triggerHandoff: (() => void) | undefined;
  let handoffPromise: Promise<void> | undefined;
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({
    transport: "local", session: { transport: "local", sessionId: "handoff-continuation", locator: { sessionFile: "/sessions/handoff-continuation.jsonl" } }, messages, getSessionStats: sessionStats,
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    async prompt(prompt) {
      prompts.push(prompt);
      if (prompts.length === 1) {
        listener?.(malformedEvent());
        triggerHandoff?.();
        listener?.(messageEnd(aborted));
        listener?.(turnEnd(aborted));
        await handoffPromise;
      } else {
        messages[0] = assistant("continued report");
      }
    },
    dispose() {},
  })));
  const result = await executor.execute("work", { label: "worker", workflowName: "flow", onAttempt: (attempt) => {
    if (!attempt.handoff) return;
    const handoff = attempt.handoff;
    triggerHandoff = () => { handoffPromise = handoff.request(async () => { handoff.takeover(); }); };
  } });
  assert.equal(result.value, "continued report");
  assert.equal(prompts[1], "Continue the task from the current session state.");
  assert.equal(prompts.length, 2);
});

void test("does not deadlock or fail when an async subscriber rejects a handed-off prompt", async () => {
  type Event = import("../src/types.js").WorkflowAgentSessionEvent;
  let listener: ((event: Event) => void | Promise<void>) | undefined;
  let handoffOpening: Promise<void> | undefined;
  let takeover: import("../src/types.js").LiveSessionHandoff | undefined;
  let beginHandoff: (() => void) | undefined;
  let releasePromptSettlement!: () => void;
  const promptSettled = new Promise<void>((resolve) => { releasePromptSettlement = resolve; });
  const completed = assistant("completed");
  const messages = [completed];
  const session = {
    reference: { transport: "local", sessionId: "async-handoff", locator: { sessionFile: "/sessions/async-handoff.jsonl" } },
    getState: () => ({ model: root.model, tools: [...root.tools] }),
    getSessionStats: () => sessionStats(),
    getLastAssistant: () => messages[0],
    subscribe(next: (event: Event) => void) { listener = next; return () => { listener = undefined; }; },
    subscribeAsync(next: (event: Event) => void | Promise<void>) { listener = next; return () => { listener = undefined; }; },
    steer: async () => {},
    async prompt() {
      await listener?.({ type: "turn_started" });
      beginHandoff?.();
      await listener?.({ type: "turn_end", message: completed });
      releasePromptSettlement();
      throw new Error("prompt aborted during handoff");
    },
    async suspendForHandoff() { await promptSettled; },
    async abort() { releasePromptSettlement(); },
    async dispose() {},
  };
  const transport: import("../src/types.js").AgentTransport = { id: "local", async createSession() { return session; } };
  const executor = new WorkflowAgentExecutor(root, transport);
  const execution = executor.execute("work", { label: "worker", workflowName: "flow", onAttempt: (attempt) => {
    if (!attempt.liveSession || !attempt.handoff) return;
    const currentHandoff = attempt.handoff;
    beginHandoff = () => {
      takeover = currentHandoff;
      handoffOpening = currentHandoff.request(async () => { await session.suspendForHandoff(); currentHandoff.takeover(); });
    };
  } });
  const settled = await settlesWithin(execution, 2_000);
  if (!settled) takeover?.takeover();
  await Promise.allSettled([execution, handoffOpening ?? Promise.resolve()]);
  assert.equal(settled, true, "handoff must not wait on the subscriber that is settling the prompt");
  await execution;
  await handoffOpening;
});
void test("cancellation settles while a Herdr pane launch is pending", async () => {
  type Event = import("../src/types.js").WorkflowAgentSessionEvent;
  let listener: ((event: Event) => void) | undefined;
  let handoffOpening: Promise<void> | undefined;
  let releaseLaunch!: () => void;
  const launchGate = new Promise<void>((resolve) => { releaseLaunch = resolve; });
  const completed = assistant("completed");
  const messages = [completed];
  let promptFinished!: () => void;
  const promptDone = new Promise<void>((resolve) => { promptFinished = resolve; });
  const session = {
    reference: { transport: "local", sessionId: "cancelled-handoff", locator: { sessionFile: "/sessions/cancelled-handoff.jsonl" } },
    getState: () => ({ model: root.model, tools: [...root.tools] }),
    getSessionStats: () => sessionStats(),
    getLastAssistant: () => messages[0],
    subscribe(next: (event: Event) => void) { listener = next; return () => { listener = undefined; }; },
    steer: async () => {},
    async prompt() {
      listener?.({ type: "turn_started" });
      listener?.({ type: "turn_end", message: completed });
      promptFinished();
      return { assistant: completed };
    },
    async abort() {},
    async dispose() {},
  };
  const transport: import("../src/types.js").AgentTransport = { id: "local", async createSession() { return session; } };
  const controller = new AbortController();
  const executor = new WorkflowAgentExecutor(root, transport);
  const execution = executor.execute("work", { label: "worker", workflowName: "flow", onAttempt: (attempt) => {
    if (!attempt.liveSession || !attempt.handoff) return;
    handoffOpening = attempt.handoff.request(async () => { await launchGate; attempt.handoff?.takeover(); });
  } }, controller.signal);
  await promptDone;
  controller.abort();
  const settled = await settlesWithin(execution, 2_000);
  releaseLaunch();
  await Promise.allSettled([execution, handoffOpening ?? Promise.resolve()]);
  assert.equal(settled, true, "cancellation must release a pending handoff wait");
  await assert.rejects(execution, (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
});

void test("retries in fresh persisted sessions and reports terminal attempt history", async () => {
  let created = 0;
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => {
    const attempt = ++created;
    return { sessionId: `s${String(attempt)}`, sessionFile: `/sessions/s${String(attempt)}.jsonl`, messages: [assistant(attempt === 2 ? "ok" : "bad")], getSessionStats: sessionStats, async prompt() { if (attempt === 1) throw new Error("provider failed"); }, dispose() {} };
  }));
  const result = await executor.execute("retry", { label: "retry", workflowName: "flow", retries: 1 });
  assert.equal(result.value, "ok");
  assert.deepEqual(result.attempts.map(({ session }) => session?.sessionId), ["s1", "s2"]);
  assert.equal(result.attempts[0]?.error?.code, "AGENT_FAILED");
});

void test("top-level worktree cwd is inherited and reused by retries", async () => {
  const cwds: string[] = [];
  const snapshots: string[] = [];
  const worktreeRoot = { ...root, runStore: { ...runStoreDefaults, worktree: async () => ({ owner: "worker", path: "/runs/worktree", branch: "pi-extensible-workflows/run/key", cwd: "/runs/worktree/subdir", base: "base" }), validateWorktree: async () => ({ owner: "worker", path: "/runs/worktree", branch: "pi-extensible-workflows/run/key", cwd: "/runs/worktree/subdir", base: "base" }), snapshotWorktree: async (owner: string) => { snapshots.push(owner); return "commit"; } } satisfies AgentExecutionRunStore };
  let attempt = 0;
  const executor = new WorkflowAgentExecutor(worktreeRoot, testTransport(async (input) => {
    cwds.push(input.cwd);
    const current = ++attempt;
    return { sessionId: `s${String(current)}`, sessionFile: `/sessions/s${String(current)}.jsonl`, messages: [assistant("ok")], getSessionStats: sessionStats, async prompt() { if (current === 1) throw new Error("retry"); }, dispose() {} };
  }));
  const result = await executor.execute("worktree", { label: "worker", workflowName: "flow", worktreeOwner: "worker", retries: 1 });
  assert.deepEqual(cwds, ["/runs/worktree/subdir", "/runs/worktree/subdir"]);
  assert.deepEqual(snapshots, ["worker", "worker"]);
  assert.equal(result.cwd, "/runs/worktree/subdir");
  await executor.execute("child", { label: "child", workflowName: "flow", parent: "worker", worktreeOwner: "worker", cwd: result.cwd });
  assert.equal(cwds.at(-1), result.cwd);
});


void test("concurrent siblings keep their own cwd and plain top-level calls use root cwd", async () => {
  const cwds: Record<string, string> = {};
  const worktreeRoot = { ...root, runStore: { ...runStoreDefaults, worktree: async (owner: string) => ({ owner, path: `/runs/${owner}`, branch: `branch/${owner}`, cwd: `/runs/${owner}/repo`, base: "base" }), validateWorktree: async (owner: string, cwd: string) => ({ owner, path: `/runs/${owner}`, branch: `branch/${owner}`, cwd, base: "base" }), snapshotWorktree: async () => "commit" } satisfies AgentExecutionRunStore };
  const executor = new WorkflowAgentExecutor(worktreeRoot, testTransport(async (input) => ({ sessionId: input.sessionLabel, sessionFile: `/sessions/${input.sessionLabel}.jsonl`, messages: [assistant("ok")], getSessionStats: sessionStats, async prompt() { cwds[input.sessionLabel] = input.cwd; await Promise.resolve(); }, dispose() {} })));
  const [left, right] = await Promise.all([
    executor.execute("left", { label: "left", workflowName: "flow", worktreeOwner: "left" }),
    executor.execute("right", { label: "right", workflowName: "flow", worktreeOwner: "right" }),
  ]);
  await Promise.all([
    executor.execute("left child", { label: "child-left", workflowName: "flow", parent: "left", worktreeOwner: "left", cwd: left.cwd }),
    executor.execute("right child", { label: "child-right", workflowName: "flow", parent: "right", worktreeOwner: "right", cwd: right.cwd }),
  ]);
  const plain = await executor.execute("plain", { label: "plain", workflowName: "flow" });
  assert.equal(cwds["flow:left:attempt-1"], "/runs/left/repo");
  assert.equal(cwds["flow:right:attempt-1"], "/runs/right/repo");
  assert.equal(cwds["flow:child-left:attempt-1"], left.cwd);
  assert.equal(cwds["flow:child-right:attempt-1"], right.cwd);
  assert.equal(plain.cwd, root.cwd);
});

void test("rejects arbitrary child cwd before launching a session", async () => {
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => { throw new Error("must not launch"); }));
  await assert.rejects(executor.execute("child", { label: "child", workflowName: "flow", parent: "root", cwd: "/tmp/arbitrary" }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});

void test("stale worktree parent cwd fails before launching a session", async () => {
  const worktreeRoot = { ...root, runStore: { ...runStoreDefaults, validateWorktree: async () => { throw new WorkflowError("WORKTREE_FAILED", "stale"); } } satisfies AgentExecutionRunStore };
  const executor = new WorkflowAgentExecutor(worktreeRoot, testTransport(async () => { throw new Error("must not launch"); }));
  await assert.rejects(executor.execute("child", { label: "child", workflowName: "flow", parent: "worker", worktreeOwner: "worker", cwd: "/runs/stale" }), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
});

void test("worktree scope without persisted ownership fails without launching a session", async () => {
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => { throw new Error("must not launch"); }));
  await assert.rejects(executor.execute("worktree", { label: "worker", workflowName: "flow", worktreeOwner: "worker" }), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
});

void test("snapshot failures stay WORKTREE_FAILED without a second snapshot", async () => {
  let snapshots = 0;
  const worktreeRoot = { ...root, runStore: { ...runStoreDefaults, worktree: async () => ({ owner: "worker", path: "/runs/worker", branch: "branch/worker", cwd: "/runs/worker/repo", base: "base" }), snapshotWorktree: async () => { snapshots += 1; throw new WorkflowError("WORKTREE_FAILED", "snapshot failed"); } } satisfies AgentExecutionRunStore };
  const executor = new WorkflowAgentExecutor(worktreeRoot, testTransport(async () => ({ transport: "local", session: { transport: "local", sessionId: "s", locator: { sessionFile: "/sessions/s.jsonl" } }, messages: [assistant("ok")], getSessionStats: sessionStats, async prompt() {}, dispose() {} })));
  await assert.rejects(executor.execute("worktree", { label: "worker", workflowName: "flow", worktreeOwner: "worker" }), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED" && error.message === "snapshot failed");
  assert.equal(snapshots, 1);
});

void test("failed best-effort snapshots do not mask agent failures", async () => {
  const worktreeRoot = { ...root, runStore: { ...runStoreDefaults, worktree: async () => ({ owner: "worker", path: "/runs/worker", branch: "branch/worker", cwd: "/runs/worker/repo", base: "base" }), snapshotWorktree: async () => { throw new WorkflowError("WORKTREE_FAILED", "snapshot failed"); } } satisfies AgentExecutionRunStore };
  const executor = new WorkflowAgentExecutor(worktreeRoot, testTransport(async () => ({ transport: "local", session: { transport: "local", sessionId: "s", locator: { sessionFile: "/sessions/s.jsonl" } }, messages: [assistant("bad")], getSessionStats: sessionStats, async prompt() { throw new Error("agent failed"); }, dispose() {} })));
  await assert.rejects(executor.execute("worktree", { label: "worker", workflowName: "flow", worktreeOwner: "worker" }), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === "agent failed");
});

void test("rejects invalid retries and timeoutMs before launching", async () => {
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => { throw new Error("must not launch"); }));
  for (const options of [{ retries: -1 }, { retries: 1.5 }, { timeoutMs: 0 }, { timeoutMs: 1.5 }] as const) {
    await assert.rejects(executor.execute("work", { label: "worker", workflowName: "flow", ...options }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  }
});

void test("per-attempt timeout is typed and terminal", async () => {
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({ transport: "local", session: { transport: "local", sessionId: "slow", locator: { sessionFile: "/sessions/slow.jsonl" } }, messages: [], getSessionStats: sessionStats, prompt: () => new Promise(() => {}), dispose() {} })));
  await assert.rejects(executor.execute("slow", { label: "slow", workflowName: "flow", timeoutMs: 10 }), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_TIMEOUT" && Array.isArray((error as WorkflowError & { attempts: unknown[] }).attempts));
});

void test("direct local Pi sessions shut down extensions when disposed", async () => {
  const lifecycle: string[] = [];
  const extensionFactory: NonNullable<SessionInput["extensionFactories"]>[number] = (pi) => {
    pi.on("session_start", (event) => { lifecycle.push(`start:${event.reason}`); });
    pi.on("session_shutdown", (event) => { lifecycle.push(`shutdown:${event.reason}`); });
  };
  const session = await createLocalPiSession({ cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], sessionLabel: "direct-session-lifecycle", extensionFactories: [extensionFactory] });
  await Promise.all([session.dispose(), session.dispose()]);
  assert.deepEqual(lifecycle, ["start:startup", "shutdown:quit"]);
});

void test("local Pi sessions shut down after partial extension binding failure", async () => {
  const originalBind = Object.getOwnPropertyDescriptor(AgentSession.prototype, "bindExtensions");
  assert.ok(originalBind);
  const lifecycle: string[] = [];
  const extensionFactory: NonNullable<SessionInput["extensionFactories"]>[number] = (pi) => {
    pi.on("session_start", () => { lifecycle.push("start"); });
    pi.on("session_shutdown", () => { lifecycle.push("shutdown"); });
  };
  AgentSession.prototype.bindExtensions = async function (bindings) {
    await Reflect.apply(originalBind.value as (this: AgentSession, value: typeof bindings) => Promise<void>, this, [bindings]);
    throw new Error("binding failed");
  };
  try {
    await assert.rejects(createLocalPiSession({ cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], sessionLabel: "partial-binding-lifecycle", extensionFactories: [extensionFactory] }), /binding failed/);
    assert.deepEqual(lifecycle, ["start", "shutdown"]);
  } finally {
    Object.defineProperty(AgentSession.prototype, "bindExtensions", originalBind);
  }
});
void test("bare no-policy local sessions exclude the workflow host and retain configured extensions", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-no-policy-extensions-"));
  const agentDir = join(rootDir, "agent");
  const cwd = join(rootDir, "project");
  const lifecycleFile = join(rootDir, "lifecycle.txt");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  writeFileSync(join(agentDir, "auth.json"), "{}");
  const benignExtension = join(rootDir, "benign-extension.mjs");
  writeFileSync(benignExtension, `import { appendFileSync } from "node:fs"; export default function(pi) { pi.on("session_start", (event) => appendFileSync(${JSON.stringify(lifecycleFile)}, "start:" + event.reason + "\\n")); pi.on("session_shutdown", (event) => appendFileSync(${JSON.stringify(lifecycleFile)}, "shutdown:" + event.reason + "\\n")); }`);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [realpathSync(process.cwd())], extensions: [join(process.cwd(), "dist/src/index.js"), benignExtension] }));
  try {
    const session = await createLocalPiSession({ cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: [], sessionLabel: "no-policy-extensions" });
    try {
      assert.deepEqual(session.getResourceInspection().extensions, [realpathSync(benignExtension)]);
      assert.deepEqual(readFileSync(lifecycleFile, "utf8").trim().split("\n"), ["start:startup"]);
    } finally {
      await session.dispose();
    }
    assert.deepEqual(readFileSync(lifecycleFile, "utf8").trim().split("\n"), ["start:startup", "shutdown:quit"]);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
void test("local workflow sessions run startup once and surface event listener failures", async () => {
  let sessionStarts = 0;
  const extensionFactory: NonNullable<SessionInput["extensionFactories"]>[number] = (pi) => {
    pi.on("session_start", async () => {
      await new Promise<void>((resolve) => setImmediate(resolve));
      sessionStarts += 1;
      pi.sendMessage({ customType: "startup-probe", content: "startup context", display: false });
    });
  };
  const fixture = await createRespondingLocalSession([extensionFactory]);
  try {
    const unsubscribe = fixture.session.subscribeAsync?.(async (event) => { if (event.type === "message_start") throw new Error("progress listener failed"); });
    try {
      await assert.rejects(fixture.session.prompt("first user message"), /progress listener failed/);
      assert.equal(sessionStarts, 1);
      const request = fixture.requests[0] as { messages?: readonly { role?: string; customType?: string; content?: unknown }[] } | undefined;
      const userMessages = request?.messages?.filter((message) => message.role === "user").map((message) => JSON.stringify(message.content)) ?? [];
      assert.deepEqual(userMessages.slice(-2), [JSON.stringify([{ type: "text", text: "startup context" }]), JSON.stringify([{ type: "text", text: "first user message" }])]);
    } finally {
      unsubscribe?.();
    }
  } finally {
    await fixture.close();
    await fixture.session.dispose();
  }
});
void test("local session handoff reports resume lifecycle context", async () => {
  const lifecycle: Array<{ type: string; reason: string; previousSessionFile?: string; targetSessionFile?: string }> = [];
  const extensionFactory: NonNullable<SessionInput["extensionFactories"]>[number] = (pi) => {
    pi.on("session_start", (event) => { lifecycle.push({ type: event.type, reason: event.reason, ...(event.previousSessionFile ? { previousSessionFile: event.previousSessionFile } : {}) }); });
    pi.on("session_shutdown", (event) => { lifecycle.push({ type: event.type, reason: event.reason, ...(event.targetSessionFile ? { targetSessionFile: event.targetSessionFile } : {}) }); });
  };
  const prepared = { cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], sessionLabel: "handoff-lifecycle", extensionFactories: [extensionFactory] } satisfies import("../src/types.js").PreparedAgentSession;
  let session: Awaited<ReturnType<typeof localAgentTransport.createSession>> | undefined;
  let sessionFile: string | undefined;
  try {
    session = await localAgentTransport.createSession(prepared, {} as never);
    const locator = session.reference.locator;
    assert.equal(typeof locator, "object");
    sessionFile = locator && typeof locator === "object" && !Array.isArray(locator) && typeof locator.sessionFile === "string" ? locator.sessionFile : undefined;
    assert.equal(typeof sessionFile, "string");
    if (typeof sessionFile !== "string") throw new Error("session file is missing");
    await Promise.all([session.suspendForHandoff?.(), session.suspendForHandoff?.()]);
    await session.resumeFromHandoff?.();
    await session.dispose();
  } finally {
    await session?.dispose();
  }
  assert.deepEqual(lifecycle, [
    { type: "session_start", reason: "startup" },
    { type: "session_shutdown", reason: "resume", targetSessionFile: sessionFile },
    { type: "session_start", reason: "resume", previousSessionFile: sessionFile },
    { type: "session_shutdown", reason: "quit" },
  ]);
});
void test("local session can retry after a failed resume", async () => {
  const prepared = { cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], sessionLabel: "failed-resume-retry" } satisfies import("../src/types.js").PreparedAgentSession;
  let session: Awaited<ReturnType<typeof localAgentTransport.createSession>> | undefined;
  let sessionFile: string | undefined;
  try {
    session = await localAgentTransport.createSession(prepared, {} as never);
    const locator = session.reference.locator;
    sessionFile = locator && typeof locator === "object" && !Array.isArray(locator) && typeof locator.sessionFile === "string" ? locator.sessionFile : undefined;
    assert.ok(sessionFile);
    const resume = session.resumeFromHandoff?.bind(session);
    assert.ok(resume);
    await session.suspendForHandoff?.();
    rmSync(sessionFile, { force: true });
    mkdirSync(sessionFile);
    await assert.rejects(resume(), /EISDIR/);
    rmSync(sessionFile, { recursive: true, force: true });
    await assert.doesNotReject(resume());
  } finally {
    if (sessionFile) rmSync(sessionFile, { recursive: true, force: true });
    await session?.dispose();
  }
});
void test("local session suspends after a concurrent resume completes", async () => {
  let releaseResume!: () => void;
  let markResumeStarted!: () => void;
  const resumeGate = new Promise<void>((resolve) => { releaseResume = resolve; });
  const resumeStarted = new Promise<void>((resolve) => { markResumeStarted = resolve; });
  const extensionFactory: NonNullable<SessionInput["extensionFactories"]>[number] = (pi) => {
    pi.on("session_start", async (event) => { if (event.reason === "resume") { markResumeStarted(); await resumeGate; } });
  };
  const prepared = { cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], sessionLabel: "concurrent-resume-suspend", extensionFactories: [extensionFactory] } satisfies import("../src/types.js").PreparedAgentSession;
  let session: Awaited<ReturnType<typeof localAgentTransport.createSession>> | undefined;
  let resume: Promise<void> | undefined;
  let suspend: Promise<void> | undefined;
  try {
    session = await localAgentTransport.createSession(prepared, {} as never);
    await session.suspendForHandoff?.();
    resume = session.resumeFromHandoff?.();
    await resumeStarted;
    suspend = session.suspendForHandoff?.();
    releaseResume();
    await Promise.all([resume, suspend]);
    await assert.rejects(session.prompt("must remain suspended"), (error: unknown) => error instanceof WorkflowError && error.code === "INTERNAL_ERROR");
  } finally {
    releaseResume();
    await Promise.allSettled([resume, suspend, session?.dispose()]);
  }
});
void test("local session emits resume then quit shutdown when terminal disposal follows suspension", async () => {
  let releaseShutdown!: () => void;
  let markShutdownStarted!: () => void;
  const shutdownGate = new Promise<void>((resolve) => { releaseShutdown = resolve; });
  const shutdownStarted = new Promise<void>((resolve) => { markShutdownStarted = resolve; });
  const reasons: string[] = [];
  let quitCleanup = 0;
  const extensionFactory: NonNullable<SessionInput["extensionFactories"]>[number] = (pi) => {
    pi.on("session_shutdown", async (event, context) => { reasons.push(event.reason); if (event.reason === "quit") { context.sessionManager.getSessionId(); quitCleanup += 1; } markShutdownStarted(); await shutdownGate; });
  };
  let session: Awaited<ReturnType<typeof localAgentTransport.createSession>> | undefined;
  let suspend: Promise<void> | undefined;
  let dispose: Promise<void> | undefined;
  try {
    const prepared = { cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], sessionLabel: "overlapping-handoff-disposal", extensionFactories: [extensionFactory] } satisfies import("../src/types.js").PreparedAgentSession;
    session = await localAgentTransport.createSession(prepared, {} as never);
    suspend = session.suspendForHandoff?.();
    await shutdownStarted;
    dispose = session.dispose();
    releaseShutdown();
    await Promise.all([suspend, dispose]);
    assert.deepEqual(reasons, ["resume", "quit"]);
    assert.equal(quitCleanup, 1);
    await session.dispose();
    assert.deepEqual(reasons, ["resume", "quit"]);
  } finally {
    releaseShutdown();
    await Promise.allSettled([suspend, dispose, session?.dispose()]);
  }
});
void test("local session rejects prompts while handoff teardown is in flight", async () => {
  let shutdownStarted!: () => void;
  let releaseShutdown!: () => void;
  const shutdownGate = new Promise<void>((resolve) => { releaseShutdown = resolve; });
  const shutdownReady = new Promise<void>((resolve) => { shutdownStarted = resolve; });
  const extensionFactory: NonNullable<SessionInput["extensionFactories"]>[number] = (pi) => {
    pi.on("session_shutdown", async () => { shutdownStarted(); await shutdownGate; });
  };
  const prepared = { cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], sessionLabel: "handoff-prompt-race", extensionFactories: [extensionFactory] } satisfies import("../src/types.js").PreparedAgentSession;
  let session: Awaited<ReturnType<typeof localAgentTransport.createSession>> | undefined;
  let suspend: Promise<void> | undefined;
  try {
    session = await localAgentTransport.createSession(prepared, {} as never);
    suspend = session.suspendForHandoff?.();
    await shutdownReady;
    await assert.rejects(session.prompt("must not start"), (error: unknown) => error instanceof WorkflowError && error.code === "INTERNAL_ERROR");
    releaseShutdown();
    await suspend;
  } finally {
    releaseShutdown();
    await Promise.allSettled([suspend, session?.dispose()]);
  }
});
void test("local session suspension waits for an in-flight prompt", async () => {
  let shutdownStarted = false;
  const extensionFactory: NonNullable<SessionInput["extensionFactories"]>[number] = (pi) => { pi.on("session_shutdown", () => { shutdownStarted = true; }); };
  const fixture = await createHangingLocalSession([extensionFactory]);
  let prompt: Promise<unknown> | undefined;
  let suspend: Promise<void> | undefined;
  try {
    prompt = fixture.session.prompt("work");
    await fixture.started;
    suspend = fixture.session.suspendForHandoff?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(shutdownStarted, false);
    await fixture.close();
    await Promise.allSettled([prompt, suspend]);
    assert.equal(shutdownStarted, true);
  } finally {
    await fixture.close().catch(() => undefined);
    await Promise.allSettled([prompt, suspend, fixture.session.dispose()]);
  }
});
void test("local session disposal aborts a prompt while active resume is waiting", async () => {
  const reasons: string[] = [];
  const fixture = await createHangingLocalSession([(pi) => { pi.on("session_shutdown", (event) => { reasons.push(event.reason); }); }]);
  let prompt: Promise<unknown> | undefined;
  let resume: Promise<void> | undefined;
  let dispose: Promise<void> | undefined;
  try {
    prompt = fixture.session.prompt("work");
    await fixture.started;
    resume = fixture.session.resumeFromHandoff?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    dispose = fixture.session.dispose();
    const all = Promise.all([prompt, resume, dispose]);
    assert.equal(await settlesWithin(all), true);
    await all;
    assert.deepEqual(reasons, ["resume", "quit"]);
  } finally {
    await fixture.close();
    await Promise.allSettled([prompt, resume, dispose, fixture.session.dispose()]);
  }
});
void test("local session disposal aborts a prompt while suspension is waiting", async () => {
  const reasons: string[] = [];
  const fixture = await createHangingLocalSession([(pi) => { pi.on("session_shutdown", (event) => { reasons.push(event.reason); }); }]);
  let prompt: Promise<unknown> | undefined;
  let suspend: Promise<void> | undefined;
  let dispose: Promise<void> | undefined;
  try {
    prompt = fixture.session.prompt("work");
    await fixture.started;
    suspend = fixture.session.suspendForHandoff?.();
    await new Promise<void>((resolve) => setImmediate(resolve));
    dispose = fixture.session.dispose();
    const all = Promise.all([prompt, suspend, dispose]);
    assert.equal(await settlesWithin(all), true);
    await Promise.allSettled([prompt, dispose]);
    assert.ok(suspend);
    await assert.rejects(suspend, (error: unknown) => error instanceof WorkflowError && error.code === "INTERNAL_ERROR" && error.message === "Local workflow session is closing");
    assert.deepEqual(reasons, ["quit"]);
  } finally {
    await fixture.close();
    await Promise.allSettled([prompt, suspend, dispose, fixture.session.dispose()]);
  }
});
void test("local session suspend and resume retain the session seam with a stubbed prompt", async () => {
  const originalPrompt = Object.getOwnPropertyDescriptor(AgentSession.prototype, "prompt");
  const originalSessionFile = Object.getOwnPropertyDescriptor(AgentSession.prototype, "sessionFile");
  assert.ok(originalPrompt && originalSessionFile);
  const prompts: string[] = [];
  const events: string[] = [];
  AgentSession.prototype.prompt = async function (text) {
    prompts.push(text);
    for (const listener of (this.agent["listeners"] as Set<(event: unknown) => void>)) listener({ type: "agent_end", messages: [], willRetry: false });
  };
  try {
    const prepared = { cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], sessionLabel: "handoff-real-local" } satisfies import("../src/types.js").PreparedAgentSession;
    const session = await localAgentTransport.createSession(prepared, testTransportContext);
    try {
      session.subscribe((event) => { if (event.type === "agent_end") events.push(event.type); });
      assert.ok(session.reference.locator);
      await session.prompt("before handoff");
      assert.equal(typeof session.suspendForHandoff, "function");
      assert.equal(typeof session.resumeFromHandoff, "function");
      if (typeof session.suspendForHandoff !== "function" || typeof session.resumeFromHandoff !== "function") throw new Error("handoff methods are missing");
      await session.suspendForHandoff();
      await session.resumeFromHandoff();
      await session.prompt("after handoff");
      assert.deepEqual(prompts, ["before handoff", "after handoff"]);
      assert.deepEqual(events, ["agent_end", "agent_end"]);
    } finally {
      await session.dispose();
    }
    Object.defineProperty(AgentSession.prototype, "sessionFile", { configurable: true, get: () => undefined });
    try {
      const noFile = await localAgentTransport.createSession(prepared, testTransportContext);
      try {
        assert.equal(noFile.reference.locator, undefined);
        assert.equal(typeof noFile.suspendForHandoff, "function");
        assert.equal(typeof noFile.resumeFromHandoff, "function");
        if (typeof noFile.suspendForHandoff !== "function" || typeof noFile.resumeFromHandoff !== "function") throw new Error("handoff methods are missing");
        await noFile.suspendForHandoff();
        await noFile.resumeFromHandoff();
        await noFile.prompt("without session file");
        assert.deepEqual(prompts, ["before handoff", "after handoff", "without session file"]);
      } finally {
        await noFile.dispose();
      }
    } finally {
      Object.defineProperty(AgentSession.prototype, "sessionFile", originalSessionFile);
    }
  } finally {
    Object.defineProperty(AgentSession.prototype, "prompt", originalPrompt);
  }
});

void test("production native Pi session installs nested scheduler tools", async () => {
  const nestedTool = { name: "agent", label: "Child Agent", description: "Start child", parameters: Type.Object({}), async execute() { return { content: [{ type: "text" as const, text: "ok" }], details: {} }; } };
  const session = await createLocalPiSession({ cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], customTools: [nestedTool], sessionLabel: "scheduler-production-seam" });
  assert.ok(session.agent?.state.tools.some(({ name }) => name === "agent"));
  await session.dispose();
});
void test("local transport waits for an in-flight prompt and abort before disposing", async () => {
  const originalAbort = Object.getOwnPropertyDescriptor(AgentSession.prototype, "abort");
  const originalPrompt = Object.getOwnPropertyDescriptor(AgentSession.prototype, "prompt");
  const originalDispose = Object.getOwnPropertyDescriptor(AgentSession.prototype, "dispose");
  assert.ok(originalAbort && originalPrompt && originalDispose);
  const events: string[] = [];
  let releaseAbort!: () => void;
  let releasePrompt!: () => void;
  let markAbortStarted!: () => void;
  let markPromptStarted!: () => void;
  const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const abortStarted = new Promise<void>((resolve) => { markAbortStarted = resolve; });
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
  AgentSession.prototype.abort = async function () { events.push("abort-start"); markAbortStarted(); await abortGate; events.push("abort-end"); };
  AgentSession.prototype.prompt = async function () { events.push("prompt-start"); markPromptStarted(); await promptGate; events.push("prompt-end"); };
  AgentSession.prototype.dispose = function (this: AgentSession) { events.push("dispose"); Reflect.apply(originalDispose.value as (this: AgentSession) => void, this, []); };
  try {
    const prepared = { cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], sessionLabel: "async-dispose-contract" } satisfies import("../src/types.js").PreparedAgentSession;
    const session = await localAgentTransport.createSession(prepared, testTransportContext);
    const prompt = session.prompt("work");
    await promptStarted;
    const abort = session.abort();
    await abortStarted;
    const firstDispose = session.dispose();
    const secondDispose = session.dispose();
    await Promise.resolve();
    assert.deepEqual(events, ["prompt-start", "abort-start"]);
    releaseAbort();
    await Promise.resolve();
    assert.deepEqual(events, ["prompt-start", "abort-start", "abort-end"]);
    releasePrompt();
    await Promise.all([prompt, abort, firstDispose, secondDispose]);
    assert.deepEqual(events, ["prompt-start", "abort-start", "abort-end", "prompt-end", "dispose"]);
    await session.abort();
    assert.deepEqual(events, ["prompt-start", "abort-start", "abort-end", "prompt-end", "dispose"]);
  } finally {
    Object.defineProperty(AgentSession.prototype, "abort", originalAbort);
    Object.defineProperty(AgentSession.prototype, "prompt", originalPrompt);
    Object.defineProperty(AgentSession.prototype, "dispose", originalDispose);
  }
});
void test("local transport waits for every in-flight prompt before disposing", async () => {
  const originalAbort = Object.getOwnPropertyDescriptor(AgentSession.prototype, "abort");
  const originalPrompt = Object.getOwnPropertyDescriptor(AgentSession.prototype, "prompt");
  const originalDispose = Object.getOwnPropertyDescriptor(AgentSession.prototype, "dispose");
  assert.ok(originalAbort && originalPrompt && originalDispose);
  const events: string[] = [];
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let markFirstStarted!: () => void;
  let markSecondStarted!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve; });
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const secondStarted = new Promise<void>((resolve) => { markSecondStarted = resolve; });
  AgentSession.prototype.prompt = async function (text) {
    events.push(`prompt-start:${text}`);
    if (text === "first") { markFirstStarted(); await firstGate; } else { markSecondStarted(); await secondGate; }
    events.push(`prompt-end:${text}`);
  };
  AgentSession.prototype.abort = async function () { events.push("abort"); };
  AgentSession.prototype.dispose = function () { events.push("dispose"); };
  try {
    const prepared = { cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], sessionLabel: "async-multi-dispose-contract" } satisfies import("../src/types.js").PreparedAgentSession;
    const session = await localAgentTransport.createSession(prepared, testTransportContext);
    const firstPrompt = session.prompt("first");
    await firstStarted;
    const secondPrompt = session.prompt("second");
    await secondStarted;
    const disposal = session.dispose();
    releaseSecond();
    await secondPrompt;
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(events.includes("dispose"), false);
    releaseFirst();
    await Promise.all([firstPrompt, disposal]);
    assert.deepEqual(events, ["prompt-start:first", "prompt-start:second", "abort", "prompt-end:second", "prompt-end:first", "dispose"]);
  } finally {
    Object.defineProperty(AgentSession.prototype, "abort", originalAbort);
    Object.defineProperty(AgentSession.prototype, "prompt", originalPrompt);
    Object.defineProperty(AgentSession.prototype, "dispose", originalDispose);
  }
});
void test("local transport resets abort state for each prompt and disposal", async () => {
  const originalAbort = Object.getOwnPropertyDescriptor(AgentSession.prototype, "abort");
  const originalPrompt = Object.getOwnPropertyDescriptor(AgentSession.prototype, "prompt");
  const originalDispose = Object.getOwnPropertyDescriptor(AgentSession.prototype, "dispose");
  assert.ok(originalAbort && originalPrompt && originalDispose);
  const events: string[] = [];
  let aborts = 0;
  let releaseFirstPrompt!: () => void;
  let releaseSecondPrompt!: () => void;
  let markFirstPromptStarted!: () => void;
  let markSecondPromptStarted!: () => void;
  const firstPromptGate = new Promise<void>((resolve) => { releaseFirstPrompt = resolve; });
  const secondPromptGate = new Promise<void>((resolve) => { releaseSecondPrompt = resolve; });
  const firstPromptStarted = new Promise<void>((resolve) => { markFirstPromptStarted = resolve; });
  const secondPromptStarted = new Promise<void>((resolve) => { markSecondPromptStarted = resolve; });
  AgentSession.prototype.prompt = async function (text) {
    events.push(`prompt-start:${text}`);
    if (text === "first") { markFirstPromptStarted(); await firstPromptGate; } else { markSecondPromptStarted(); await secondPromptGate; }
    events.push(`prompt-end:${text}`);
  };
  AgentSession.prototype.abort = async function () { events.push("abort-" + String(++aborts)); };
  AgentSession.prototype.dispose = function (this: AgentSession) { events.push("dispose"); Reflect.apply(originalDispose.value as (this: AgentSession) => void, this, []); };
  try {
    const prepared = { cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], sessionLabel: "async-abort-lifecycle" } satisfies import("../src/types.js").PreparedAgentSession;
    const session = await localAgentTransport.createSession(prepared, testTransportContext);
    const firstPrompt = session.prompt("first");
    await firstPromptStarted;
    releaseFirstPrompt();
    await firstPrompt;
    await session.abort();
    const secondPrompt = session.prompt("second");
    await secondPromptStarted;
    await session.abort();
    releaseSecondPrompt();
    await secondPrompt;
    await session.dispose();
    assert.deepEqual(events, ["prompt-start:first", "prompt-end:first", "abort-1", "prompt-start:second", "abort-2", "prompt-end:second", "abort-3", "dispose"]);
  } finally {
    Object.defineProperty(AgentSession.prototype, "abort", originalAbort);
    Object.defineProperty(AgentSession.prototype, "prompt", originalPrompt);
    Object.defineProperty(AgentSession.prototype, "dispose", originalDispose);
  }
});
void test("local transport swallows an in-flight prompt rejection during idempotent disposal", async () => {
  const originalAbort = Object.getOwnPropertyDescriptor(AgentSession.prototype, "abort");
  const originalPrompt = Object.getOwnPropertyDescriptor(AgentSession.prototype, "prompt");
  const originalDispose = Object.getOwnPropertyDescriptor(AgentSession.prototype, "dispose");
  assert.ok(originalAbort && originalPrompt && originalDispose);
  let rejectPrompt!: (error: Error) => void;
  let markPromptStarted!: () => void;
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
  let releaseAbort!: () => void;
  let markAbortStarted!: () => void;
  const abortGate = new Promise<void>((resolve) => { releaseAbort = resolve; });
  const abortStarted = new Promise<void>((resolve) => { markAbortStarted = resolve; });
  AgentSession.prototype.abort = async function () { markAbortStarted(); await abortGate; };
  AgentSession.prototype.prompt = async function () { markPromptStarted(); await new Promise<void>((_, reject) => { rejectPrompt = reject; }); };
  try {
    const prepared = { cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], sessionLabel: "rejected-prompt-dispose" } satisfies import("../src/types.js").PreparedAgentSession;
    const session = await localAgentTransport.createSession(prepared, testTransportContext);
    const prompt = session.prompt("work");
    await promptStarted;
    const firstDispose = session.dispose();
    const secondDispose = session.dispose();
    await abortStarted;
    releaseAbort();
    await new Promise<void>((resolve) => setImmediate(resolve));
    rejectPrompt(new Error("prompt aborted"));
    await assert.rejects(prompt, /prompt aborted/);
    await assert.doesNotReject(Promise.all([firstDispose, secondDispose]));
    await assert.doesNotReject(session.dispose());
  } finally {
    Object.defineProperty(AgentSession.prototype, "abort", originalAbort);
    Object.defineProperty(AgentSession.prototype, "prompt", originalPrompt);
    Object.defineProperty(AgentSession.prototype, "dispose", originalDispose);
  }
});
void test("local transport ignores abort failure while finishing disposal", async () => {
  const originalAbort = Object.getOwnPropertyDescriptor(AgentSession.prototype, "abort");
  const originalPrompt = Object.getOwnPropertyDescriptor(AgentSession.prototype, "prompt");
  const originalDispose = Object.getOwnPropertyDescriptor(AgentSession.prototype, "dispose");
  assert.ok(originalAbort && originalPrompt && originalDispose);
  const events: string[] = [];
  let releasePrompt!: () => void;
  let markPromptStarted!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const promptStarted = new Promise<void>((resolve) => { markPromptStarted = resolve; });
  AgentSession.prototype.abort = async function () { events.push("abort"); throw new Error("abort failed"); };
  AgentSession.prototype.prompt = async function () { events.push("prompt-start"); markPromptStarted(); await promptGate; events.push("prompt-end"); };
  AgentSession.prototype.dispose = function (this: AgentSession) { events.push("dispose"); Reflect.apply(originalDispose.value as (this: AgentSession) => void, this, []); };
  try {
    const prepared = { cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], sessionLabel: "abort-failure-dispose" } satisfies import("../src/types.js").PreparedAgentSession;
    const session = await localAgentTransport.createSession(prepared, testTransportContext);
    const prompt = session.prompt("work");
    await promptStarted;
    const disposal = session.dispose();
    void disposal.catch(() => undefined);
    await new Promise<void>((resolve) => setImmediate(resolve));
    releasePrompt();
    await prompt;
    await assert.doesNotReject(Promise.all([disposal, session.dispose()]));
    assert.deepEqual(events, ["prompt-start", "abort", "prompt-end", "dispose"]);
  } finally {
    Object.defineProperty(AgentSession.prototype, "abort", originalAbort);
    Object.defineProperty(AgentSession.prototype, "prompt", originalPrompt);
    Object.defineProperty(AgentSession.prototype, "dispose", originalDispose);
  }
});
void test("executor registers the production native steering handler", async () => {
  const steered: string[] = [];
  let registered: ((message: string) => void | Promise<void>) | undefined;
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({ transport: "local", session: { transport: "local", sessionId: "steer", locator: { sessionFile: "/sessions/steer.jsonl" } }, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: sessionStats, prompt: async () => undefined, steer: async (message) => { steered.push(message); }, dispose() {} })));
  await executor.execute("work", { label: "worker", workflowName: "flow" }, undefined, [], (handler) => { registered = handler; });
  assert.ok(registered);
  await registered("redirect");
  assert.deepEqual(steered, ["redirect"]);
});

void test("fair scheduler enforces session/run ceilings and round-robins runs", async () => {
  const order: string[] = [];
  const releases: Array<() => void> = [];
  const scheduler = new FairAgentScheduler(async ({ prompt }) => { order.push(prompt); await new Promise<void>((resolve) => releases.push(resolve)); return prompt; }, 1);
  scheduler.addRun("a", 1);
  scheduler.addRun("b", 1);
  const a1 = scheduler.spawn("a", "a1", { label: "a1", cwd: "/repo", tools: ["read"] });
  const a2 = scheduler.spawn("a", "a2", { label: "a2", cwd: "/repo", tools: ["read"] });
  const b1 = scheduler.spawn("b", "b1", { label: "b1", cwd: "/repo", tools: ["read"] });
  await Promise.resolve();
  assert.deepEqual(order, ["a1"]);
  releases.shift()?.(); await a1.result; await Promise.resolve();
  assert.deepEqual(order, ["a1", "b1"]);
  releases.shift()?.(); await b1.result; await Promise.resolve();
  assert.deepEqual(order, ["a1", "b1", "a2"]);
  releases.shift()?.(); await a2.result;
});

void test("cancelling a queued agent releases its eventual permit so later work starts", async () => {
  const started: string[] = [];
  let release!: () => void;
  const scheduler = new FairAgentScheduler(async ({ prompt }) => { started.push(prompt); if (prompt === "r1") await new Promise<void>((resolve) => { release = resolve; }); return prompt; }, 1);
  scheduler.addRun("r", 1);
  const r1 = scheduler.spawn("r", "r1", { label: "r1", cwd: "/repo", tools: [] });
  const r2 = scheduler.spawn("r", "r2", { label: "r2", cwd: "/repo", tools: [] });
  const r3 = scheduler.spawn("r", "r3", { label: "r3", cwd: "/repo", tools: [] });
  scheduler.cancel(r2.id);
  release();
  await r1.result;
  assert.equal((await r2.result).ok, false);
  assert.equal((await r3.result).ok, true);
  assert.deepEqual(started, ["r1", "r3"]);
});

void test("writes each ownership-tree transition to persistence", async () => {
  const writes: Array<readonly unknown[]> = [];
  const scheduler = new FairAgentScheduler(async () => "done", 1, (_run, ownership) => { writes.push(structuredClone(ownership)); });
  scheduler.addRun("r", 1);
  const child = scheduler.spawn("r", "work", { label: "worker", cwd: "/repo", tools: [] });
  await child.result;
  await scheduler.flush();
  assert.equal(writes.at(-1)?.[0] && (writes.at(-1)?.[0] as { state: string }).state, "completed");
  assert.equal((writes.at(-1)?.[0] as { label: string }).label, "worker");
  assert.equal((writes.at(-1)?.[0] as { prompt: string }).prompt, "work");
});

void test("scheduler flush waits for terminal ownership persistence", async () => {
  let release!: () => void;
  const persisted = new Promise<void>((resolve) => { release = resolve; });
  const writes: Array<readonly unknown[]> = [];
  const scheduler = new FairAgentScheduler(async () => "done", 1, async (_run, ownership) => { await persisted; writes.push(ownership); });
  scheduler.addRun("run", 1);
  const agent = scheduler.spawn("run", "work", { label: "worker", cwd: "/repo", tools: [] });
  assert.equal((await agent.result).ok, true);
  assert.equal(writes.length, 0);
  release();
  await scheduler.flush();
  assert.equal((writes.at(-1)?.[0] as { state: string }).state, "completed");
});
void test("releases consumed scheduler result payloads while retaining node metadata", async () => {
  const references: WeakRef<object>[] = [];
  const scheduler = new FairAgentScheduler(async ({ prompt }) => {
    const result = { prompt, payload: `${prompt}-${"x".repeat(1024 * 1024)}` };
    references.push(new WeakRef(result));
    return result;
  }, 1);
  scheduler.addRun("run", 1);
  const consume = async (index: number) => {
    const agent = scheduler.spawn("run", `work-${String(index)}`, { label: "worker", cwd: "/repo", tools: ["read"], model: "openai/gpt" });
    const outcome = await agent.result;
    assert.equal(outcome.ok, true);
    scheduler.releaseResult(agent.id);
  };
  for (let index = 0; index < 200; index += 1) await consume(index);
  const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  assert.ok(forceGc, "regression test requires --expose-gc");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    forceGc();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  const live = references.filter((reference) => reference.deref() !== undefined).length;
  assert.ok(live < 10, `scheduler retained ${String(live)} of ${String(references.length)} consumed results`);
  assert.equal(scheduler.snapshot().length, 200);
  const last = scheduler.snapshot().at(-1);
  assert.deepEqual(last && { id: last.id, state: last.state, label: last.options.label, model: last.options.model, tools: last.options.tools }, { id: "run:200", state: "completed", label: "worker", model: "openai/gpt", tools: ["read"] });
});
void test("collected nested results are one-shot after payload release", async () => {
  const references: WeakRef<object>[] = [];
  const scheduler = new FairAgentScheduler(async ({ prompt, signal }) => {
    if (prompt === "parent") { await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); }); throw new WorkflowError("CANCELLED", "cancelled"); }
    const result = { prompt, payload: `${prompt}-${"x".repeat(1024 * 1024)}` };
    references.push(new WeakRef(result));
    return result;
  }, 2);
  scheduler.addRun("run", 2);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: [] });
  const child = scheduler.spawn("run", "child", { label: "child", cwd: "/repo", tools: [] }, parent.id);
  const collect = async () => {
    const outcome = await scheduler.result(parent.id, child.id);
    assert.equal(outcome.ok, true);
  };
  await collect();
  const forceGc = (globalThis as typeof globalThis & { gc?: () => void }).gc;
  assert.ok(forceGc, "regression test requires --expose-gc");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    forceGc();
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  }
  const live = references.filter((reference) => reference.deref() !== undefined).length;
  assert.ok(live < 2, `scheduler retained ${String(live)} collected nested results`);
  await assert.rejects(scheduler.result(parent.id, child.id), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_RESULT_COLLECTED" && /one-shot/.test(error.message));
  scheduler.cancel(parent.id);
  assert.equal((await parent.result).ok, false);
});
void test("releasing a result after run cleanup is harmless", async () => {
  const scheduler = new FairAgentScheduler(async () => "done", 1);
  scheduler.addRun("run", 1);
  const agent = scheduler.spawn("run", "work", { label: "worker", cwd: "/repo", tools: [] });
  assert.equal((await agent.result).ok, true);
  scheduler.removeRun("run");
  scheduler.releaseResult(agent.id);
  assert.deepEqual(scheduler.snapshot(), []);
});


void test("rejects concurrent child results, late steering, and active result release", async () => {
  let releaseChild!: () => void;
  let childStarted!: () => void;
  const started = new Promise<void>((resolve) => { childStarted = resolve; });
  const childGate = new Promise<void>((resolve) => { releaseChild = resolve; });
  let scheduler: FairAgentScheduler;
  // eslint-disable-next-line prefer-const
  scheduler = new FairAgentScheduler(async ({ prompt, signal }) => {
    if (prompt === "parent") {
      await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
      throw new WorkflowError("CANCELLED", "cancelled");
    }
    if (prompt === "child") { childStarted(); await childGate; return "child result"; }
    return "other";
  }, 2);
  scheduler.addRun("run", 2);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: [] });
  const child = scheduler.spawn("run", "child", { label: "child", cwd: "/repo", tools: [] }, parent.id);
  await started;
  const first = scheduler.result(parent.id, child.id);
  await assert.rejects(scheduler.result(parent.id, child.id), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === "Child result is already being collected");
  assert.throws(() => { scheduler.releaseResult(child.id); }, (error: unknown) => error instanceof WorkflowError && error.code === "INTERNAL_ERROR");
  releaseChild();
  assert.deepEqual(await first, { id: child.id, ok: true, value: "child result" });
  await assert.rejects(scheduler.steer(parent.id, child.id, "too late"), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === "Child is not running");
  scheduler.cancel(parent.id);
  await parent.result;
  scheduler.releaseResult(parent.id);
});

void test("nested ownership releases permits, contains child failure, and blocks escalation", async () => {
  let scheduler: FairAgentScheduler;
  // eslint-disable-next-line prefer-const
  scheduler = new FairAgentScheduler(async ({ id, prompt, options }) => {
    if (prompt === "parent") {
      assert.throws(() => scheduler.spawn("run", "bad", { label: "bad", cwd: options.cwd, tools: ["bash"] }, id), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
      const child = scheduler.spawn("run", "child", { label: "child", cwd: options.cwd, tools: options.tools }, id);
      return scheduler.result(id, child.id);
    }
    throw new WorkflowError("AGENT_FAILED", "child failed");
  }, 1);
  scheduler.addRun("run", 1);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: ["read"] });
  const result = await parent.result;
  assert.equal(result.ok, true);
  assert.deepEqual((result as { ok: true; value: unknown }).value, { id: "run:2", ok: false, error: { code: "AGENT_FAILED", message: "child failed" } });
  assert.deepEqual(scheduler.snapshot().map(({ state }) => state), ["completed", "failed"]);
});

void test("cancelling a parent waiting for a child releases its reacquired permit", async () => {
  let scheduler: FairAgentScheduler;
  let childStarted!: () => void;
  const started = new Promise<void>((resolve) => { childStarted = resolve; });
  // eslint-disable-next-line prefer-const
  scheduler = new FairAgentScheduler(async ({ id, prompt, options, signal }) => {
    if (prompt === "parent") {
      const child = scheduler.spawn("run", "child", { label: "child", cwd: options.cwd, tools: [] }, id);
      return scheduler.result(id, child.id);
    }
    if (prompt === "child") {
      childStarted();
      await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
      throw new WorkflowError("CANCELLED", "cancelled");
    }
    return "later completed";
  }, 1);
  scheduler.addRun("run", 1);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: [] });
  await started;
  scheduler.cancel(parent.id);
  assert.equal((await parent.result).ok, false);
  const later = scheduler.spawn("run", "later", { label: "later", cwd: "/repo", tools: [] });
  assert.deepEqual(await later.result, { id: later.id, ok: true, value: "later completed" });
  assert.deepEqual(scheduler.snapshot().map(({ state }) => state), ["cancelled", "cancelled", "completed"]);
});

void test("restores scheduler terminal states and rejects foreign runs", async () => {
  const scheduler = new FairAgentScheduler(async () => "unused", 1);
  const options = { label: "restored", cwd: "/repo", tools: [] };
  scheduler.restoreRun("run", 1, [
    { id: "run:1", label: "parent", state: "waiting_for_child", options },
    { id: "run:2", parentId: "run:1", label: "done", state: "completed", options },
    { id: "run:3", parentId: "run:1", label: "failed", state: "failed", options },
    { id: "run:4", parentId: "run:1", label: "cancelled", state: "cancelled", options },
  ]);
  assert.deepEqual(await scheduler.result("run:1", "run:2"), { id: "run:2", ok: true, value: null });
  assert.deepEqual(await scheduler.result("run:1", "run:3"), { id: "run:3", ok: false, error: { code: "AGENT_FAILED", message: "Persisted agent failed" } });
  assert.deepEqual(await scheduler.result("run:1", "run:4"), { id: "run:4", ok: false, error: { code: "CANCELLED", message: "Persisted agent cancelled" } });
  assert.deepEqual(scheduler.snapshot().map(({ id, state }) => ({ id, state })), [
    { id: "run:1", state: "running" },
    { id: "run:2", state: "completed" },
    { id: "run:3", state: "failed" },
    { id: "run:4", state: "cancelled" },
  ]);
  assert.throws(() => { new FairAgentScheduler(async () => "unused", 1).restoreRun("run", 1, [{ id: "other:1", label: "foreign", state: "completed", options }]); }, (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
});

void test("persisted ownership restores cancellation and scoped runtime state", async () => {
  const options = { label: "parent", cwd: "/repo", tools: ["agent"] };
  const persisted = [{ id: "run:1", label: "parent", state: "running" as const, options }, { id: "run:2", parentId: "run:1", label: "child", state: "waiting_for_child" as const, options: { ...options, label: "child" } }];
  const scheduler = new FairAgentScheduler(async () => "unused", 1);
  scheduler.restoreRun("run", 1, persisted);
  assert.deepEqual(scheduler.toolsFor("run:1").map(({ name }) => name), ["agent", "get_subagent_result", "steer_subagent"]);
  scheduler.cancel("run:1");
  assert.deepEqual(scheduler.snapshot().map(({ state }) => state), ["cancelled", "cancelled"]);
});
void test("cold replacement does not consume restored logical agent slots", async () => {
  const scheduler = new FairAgentScheduler(async () => "replacement", 1);
  scheduler.restoreRun("run", 1, [{ id: "run:1", label: "restored", state: "running", options: { label: "restored", cwd: "/repo", tools: [] } }]);
  await scheduler.cancelRun("run");
  const replacement = scheduler.spawn("run", "replacement", { label: "replacement", cwd: "/repo", tools: [] });
  assert.deepEqual(await replacement.result, { id: replacement.id, ok: true, value: "replacement" });
});

void test("scoped tools honor the root capability boundary and cancel orphan descendants", async () => {
  let scheduler: FairAgentScheduler;
  let orphanId = "";
  // eslint-disable-next-line prefer-const
  scheduler = new FairAgentScheduler(async ({ id, prompt, signal, setSteer, options }) => {
    if (prompt === "parent") {
      const orphan = scheduler.spawn("run", "orphan", { label: "orphan", cwd: options.cwd, tools: options.tools }, id);
      orphanId = orphan.id;
      return "done";
    }
    setSteer(() => {});
    await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
    throw new WorkflowError("CANCELLED", "cancelled");
  }, 2);
  scheduler.addRun("run", 2);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: ["agent"] });
  await parent.result;
  await Promise.resolve();
  assert.equal(scheduler.snapshot().find(({ id }) => id === orphanId)?.state, "cancelled");
  const denied = scheduler.spawn("run", "denied", { label: "denied", cwd: "/repo", tools: ["read"] });
  assert.deepEqual(scheduler.toolsFor(denied.id), []);
  scheduler.cancel(denied.id);
  await denied.result;
  const outsider = scheduler.spawn("run", "outsider", { label: "outsider", cwd: "/repo", tools: ["agent"] });
  const scopedTools = scheduler.toolsFor(outsider.id);
  assert.deepEqual(scopedTools.map(({ name }) => name), ["agent", "get_subagent_result", "steer_subagent"]);
  const resultTool = scopedTools[1];
  assert.ok(resultTool);
  await assert.rejects(executeTool(resultTool, "x", { id: orphanId }), /direct children/);
  scheduler.cancel(outsider.id);
  await outsider.result;
});

void test("nested role policy conflicts fail before scheduler spawn", async () => {
  const scheduler = new FairAgentScheduler(async ({ signal }) => {
    await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
    throw new WorkflowError("CANCELLED", "cancelled");
  }, 1);
  scheduler.addRun("run", 1);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: ["agent", "read"] });
  const agentTool = scheduler.toolsFor(parent.id)[0];
  assert.ok(agentTool);
  for (const extra of [{ model: "openai/gpt" }, { thinking: "low" }, { tools: ["read"] }]) {
    await assert.rejects(executeToolUnchecked(agentTool, "call", { prompt: "child", label: "child", role: "reviewer", ...extra }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  }
  assert.equal(scheduler.snapshot().length, 1);
  scheduler.cancel(parent.id);
  await parent.result;
});
void test("child tool validates raw input and preserves extension options", async () => {
  const scheduler = new FairAgentScheduler(async () => "done", 1);
  scheduler.addRun("run", 1);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: ["agent", "read"] });
  const agentTool = scheduler.toolsFor(parent.id)[0];
  assert.ok(agentTool);
  for (const params of [{ prompt: "child", label: "child", thinking: "invalid" }, { prompt: "child", label: "child", providerOptions: () => undefined }]) {
    await assert.rejects(executeToolUnchecked(agentTool, "call", params), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  }
  assert.equal(scheduler.snapshot().length, 1);
  const response = await executeTool(agentTool, "call", { prompt: "child", label: "child", providerOptions: { temperature: 0.2 }, timeoutMs: null });
  const childId = ((response as { details: { id: string } }).details).id;
  const child = scheduler.snapshot().find(({ id }) => id === childId);
  assert.deepEqual(child?.options.agentOptions, { label: "child", providerOptions: { temperature: 0.2 }, timeoutMs: null });
  scheduler.cancel(parent.id);
  await parent.result;
});

void test("nested agent roles resolve tools before scheduler spawn", async () => {
  const scheduler = new FairAgentScheduler(async ({ signal }) => {
    await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
    throw new WorkflowError("CANCELLED", "cancelled");
  }, 1);
  scheduler.addRun("run", 1);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: ["agent", "read", "bash"] });
  const agentTool = scheduler.toolsFor(parent.id, (role, tools) => role === "reviewer" && tools === undefined ? ["read"] : tools ?? ["bash"])[0];
  assert.ok(agentTool);
  await executeTool(agentTool, "call", { prompt: "child", label: "child", role: "reviewer", retries: 1, timeoutMs: null });
  assert.deepEqual(scheduler.snapshot().find(({ options }) => options.label === "child")?.options.tools, ["read"]);
  scheduler.cancel(parent.id);
  await parent.result;
});
void test("nested child agents accept role override objects and resolve their tools", async () => {
  const scheduler = new FairAgentScheduler(async ({ signal }) => {
    await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
    throw new WorkflowError("CANCELLED", "cancelled");
  }, 1);
  scheduler.addRun("run", 1);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: ["agent", "read", "bash"] });
  const agentTool = scheduler.toolsFor(parent.id, (role, tools) => roleNameOf(role) === "reviewer" ? tools ?? ["read"] : tools ?? ["bash"])[0];
  assert.ok(agentTool);
  await executeTool(agentTool, "call", { prompt: "child", label: "child", role: { name: "reviewer", model: "openai/gpt", tools: null } });
  const child = scheduler.snapshot().find(({ options }) => options.label === "child");
  assert.deepEqual(child?.options.role, { name: "reviewer", model: "openai/gpt", tools: null });
  await assert.rejects(executeToolUnchecked(agentTool, "call", { prompt: "bad", label: "bad", role: { name: "reviewer", tools: 1 } }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  scheduler.cancel(parent.id);
  await parent.result;
});

void test("explicit null timeout remains unlimited", async () => {
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({ transport: "local", session: { transport: "local", sessionId: "unlimited", locator: { sessionFile: "/sessions/unlimited.jsonl" } }, messages: [assistant("done")], getSessionStats: sessionStats, prompt: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }, dispose() {} })));
  assert.equal((await executor.execute("work", { label: "worker", workflowName: "flow", timeoutMs: null })).value, "done");
});

void test("setup hook errors stop later hooks and session creation", async () => {
  let later = false;
  let launched = false;
  const attempts: string[] = [];
  const selected: import("../src/types.js").AgentTransport = { id: "selected", async createSession() { launched = true; throw new Error("must not launch"); } };
  const executor = new WorkflowAgentExecutor({ ...root, agentSetupHooks: [
    { name: "fails", priority: 1, setup(agent) { agent.transport = selected; throw new Error("hook failed"); } },
    { name: "later", priority: 2, setup() { later = true; } },
  ] }, localAgentTransport);
  await assert.rejects(executor.execute("work", { label: "worker", workflowName: "flow", retries: 3, onAttempt: (attempt) => { attempts.push(attempt.transport); } }), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === "hook failed");
  assert.equal(later, false);
  assert.equal(launched, false);
  assert.deepEqual(attempts, ["selected"]);
});

void test("setup cancellation prevents native session creation", async () => {
  const controller = new AbortController();
  let launched = false;
  const executor = new WorkflowAgentExecutor({ ...root, agentSetupHooks: [{ name: "cancel", priority: 10, setup() { controller.abort(); } }] }, testTransport(async () => { launched = true; throw new Error("must not launch"); }));
  await assert.rejects(executor.execute("work", { label: "worker", workflowName: "flow" }, controller.signal), (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  assert.equal(launched, false);
});

void test("cancelRun waits for active agents to terminate", async () => {
  let terminated = false;
  const scheduler = new FairAgentScheduler(async ({ signal }) => {
    await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { setTimeout(() => { terminated = true; resolve(); }, 20); }, { once: true }); });
    throw new WorkflowError("CANCELLED", "cancelled");
  }, 1);
  scheduler.addRun("run", 1);
  const agent = scheduler.spawn("run", "active", { label: "active", cwd: "/repo", tools: [] });
  await Promise.resolve();
  await scheduler.cancelRun("run");
  assert.equal(terminated, true);
  assert.equal((await agent.result).ok, false);
});
void test("removeRun evicts only settled scheduler state", async () => {
  let release!: () => void;
  const scheduler = new FairAgentScheduler(async () => { await new Promise<void>((resolve) => { release = resolve; }); return "done"; }, 1);
  scheduler.addRun("run", 1);
  const agent = scheduler.spawn("run", "active", { label: "active", cwd: "/repo", tools: [] });
  await Promise.resolve();
  assert.throws(() => { scheduler.removeRun("run"); }, /Cannot remove active scheduler run/);
  release();
  assert.equal((await agent.result).ok, true);
  scheduler.removeRun("run");
  assert.deepEqual(scheduler.snapshot(), []);
  assert.throws(() => scheduler.spawn("run", "missing", { label: "missing", cwd: "/repo", tools: [] }), /Unknown scheduler run/);
  scheduler.addRun("run", 1);
  const replacement = scheduler.spawn("run", "replacement", { label: "replacement", cwd: "/repo", tools: [] });
  release();
  assert.equal((await replacement.result).ok, true);
});
void test("setup hooks cannot widen the prepared resource policy", async () => {
  const policy = (): AgentResourcePolicy => ({ globalSettingsPath: "/global/settings.json", projectSettingsPath: "/project/settings.json", projectTrusted: false, global: { skills: [], extensions: [] }, project: { skills: [], extensions: [] }, effective: { skills: ["excluded"], extensions: [] }, unmatchedSkills: [], unmatchedExtensions: [] });
  const mutations: Array<[string, (input: SessionInput) => void]> = [
    ["trust project", (input) => { assert.ok(input.resourcePolicy); input.resourcePolicy.projectTrusted = true; }],
    ["remove exclusion", (input) => { assert.ok(input.resourcePolicy); input.resourcePolicy.effective = { skills: [], extensions: [] }; }],
    ["remove policy", (input) => { delete input.resourcePolicy; }],
  ];
  for (const [name, mutate] of mutations) {
    let launched = false;
    const executor = new WorkflowAgentExecutor({ ...root, agentResourcePolicy: policy, agentSetupHooks: [{ name, priority: 1, setup(agent) { mutate(agent.sessionInput); } }] }, testTransport(async () => { launched = true; throw new Error("must not launch"); }));
    await assert.rejects(executor.execute("work", { label: "worker", workflowName: "flow" }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA" && /widened/.test(error.message));
    assert.equal(launched, false);
  }
});

void test("refreshes resource exclusions for every fresh attempt and inspects the effective policy", async () => {
  let policyCalls = 0;
  let sessions = 0;
  const inputs: Array<NonNullable<SessionInput["resourcePolicy"]>> = [];
  const executor = new WorkflowAgentExecutor({ ...root, agentResourcePolicy: () => {
    policyCalls += 1;
    const skill = `skill-${String(policyCalls)}`;
    const extension = `/extensions/extension-${String(policyCalls)}.ts`;
    return { globalSettingsPath: "/global/settings.json", projectSettingsPath: "/project/settings.json", projectTrusted: true, global: { skills: [], extensions: [] }, project: { skills: [], extensions: [] }, effective: { skills: [skill], extensions: [extension] }, unmatchedSkills: [skill], unmatchedExtensions: [extension] };
  } }, testTransport(async (input) => {
    assert.ok(input.resourcePolicy);
    inputs.push(input.resourcePolicy);
    sessions += 1;
    return { sessionId: `policy-${String(sessions)}`, sessionFile: `/sessions/policy-${String(sessions)}.jsonl`, messages: [assistant("done")], getSessionStats: sessionStats, async prompt() { if (sessions === 1) throw new Error("retry"); }, dispose() {} };
  }));
  const result = await executor.execute("work", { label: "worker", workflowName: "flow", retries: 1 });
  assert.equal(result.value, "done");
  assert.equal(policyCalls, 2);
  assert.deepEqual(inputs.map(({ effective }) => effective), [{ skills: ["skill-1"], extensions: ["/extensions/extension-1.ts"] }, { skills: ["skill-2"], extensions: ["/extensions/extension-2.ts"] }]);
  assert.deepEqual(result.attempts.map(({ setup }) => setup.disabledAgentResources?.skills), [["skill-1"], ["skill-2"]]);
});
void test("isolates role resource exclusions and reapplies them on retries", async () => {
  const roleExtension = "/role/extension.ts";
  const basePolicy = { globalSettingsPath: "/global/settings.json", projectSettingsPath: "/project/settings.json", projectTrusted: true, global: { skills: ["global"], extensions: ["/global.ts"] }, project: { skills: ["project"], extensions: ["/project.ts"] }, effective: { skills: ["global", "project"], extensions: ["/global.ts", "/project.ts"] }, unmatchedSkills: [], unmatchedExtensions: [] };
  const policies: Array<NonNullable<SessionInput["resourcePolicy"]>> = [];
  let sessions = 0;
  const executor = new WorkflowAgentExecutor({ ...root, agentDefinitions: { ...root.agentDefinitions, reviewer: { ...root.agentDefinitions?.reviewer, disabledAgentResources: { skills: ["role", "global"], extensions: [roleExtension, "/global.ts"] } }, scout: { ...root.agentDefinitions?.scout } }, agentResourcePolicy: () => structuredClone(basePolicy) }, testTransport(async (input) => {
    assert.ok(input.resourcePolicy);
    policies.push(input.resourcePolicy);
    const session = ++sessions;
    return { sessionId: `role-policy-${String(session)}`, sessionFile: `/sessions/role-policy-${String(session)}.jsonl`, messages: [assistant("done")], getSessionStats: sessionStats, async prompt() { if (session === 1) throw new Error("retry"); }, dispose() {} };
  }));
  await executor.execute("role", { label: "role", workflowName: "flow", role: "reviewer", retries: 1 });
  await executor.execute("other", { label: "other", workflowName: "flow", role: "scout" });
  await executor.execute("plain", { label: "plain", workflowName: "flow" });
  assert.deepEqual(policies.map(({ effective }) => effective), [
    { skills: ["global", "project", "role", "global"], extensions: ["/global.ts", "/project.ts", roleExtension, "/global.ts"] },
    { skills: ["global", "project", "role", "global"], extensions: ["/global.ts", "/project.ts", roleExtension, "/global.ts"] },
    { skills: ["global", "project"], extensions: ["/global.ts", "/project.ts"] },
    { skills: ["global", "project"], extensions: ["/global.ts", "/project.ts"] },
  ]);
  assert.deepEqual(basePolicy.effective, { skills: ["global", "project"], extensions: ["/global.ts", "/project.ts"] });
});
void test("filters disabled native extensions before factories and skills before session registration", async () => {
  const fixtureRoot = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-resource-loader-"));
  const physicalRoot = join(fixtureRoot, "physical");
  const rootDir = join(fixtureRoot, "alias");
  mkdirSync(physicalRoot);
  symlinkSync(physicalRoot, rootDir, process.platform === "win32" ? "junction" : "dir");
  const agentDir = join(rootDir, "agent");
  const cwd = join(rootDir, "project");
  const projectExtensions = join(cwd, ".pi", "extensions");
  const projectSkills = join(cwd, ".pi", "skills");
  mkdirSync(projectExtensions, { recursive: true });
  mkdirSync(projectSkills, { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  writeFileSync(join(agentDir, "auth.json"), "{}");
  const disabledExtension = join(agentDir, "extensions", "disabled (1).ts");
  const allowedExtension = join(agentDir, "extensions", "allowed.ts");
  const disabledMarker = join(rootDir, "disabled-extension-ran");
  const allowedMarker = join(rootDir, "allowed-extension-ran");
  const projectDisabledExtension = join(projectExtensions, "disabled.ts");
  const projectAllowedExtension = join(projectExtensions, "allowed.ts");
  const projectDisabledMarker = join(rootDir, "project-disabled-extension-ran");
  const projectAllowedMarker = join(rootDir, "project-allowed-extension-ran");
  writeFileSync(disabledExtension, `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(disabledMarker)}, "ran"); }`);
  writeFileSync(allowedExtension, `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(allowedMarker)}, "ran"); }`);
  writeFileSync(projectDisabledExtension, `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(projectDisabledMarker)}, "ran"); }`);
  writeFileSync(projectAllowedExtension, `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(projectAllowedMarker)}, "ran"); }`);
  const skillsDir = join(agentDir, "skills");
  mkdirSync(join(skillsDir, "disabled-skill"), { recursive: true });
  mkdirSync(join(skillsDir, "kept-skill"), { recursive: true });
  writeFileSync(join(skillsDir, "disabled-skill", "SKILL.md"), "---\nname: disabled-skill\ndescription: Disabled\n---\nDisabled");
  writeFileSync(join(skillsDir, "kept-skill", "SKILL.md"), "---\nname: kept-skill\ndescription: Kept\n---\nKept");
  mkdirSync(join(projectSkills, "project-disabled-skill"), { recursive: true });
  mkdirSync(join(projectSkills, "project-kept-skill"), { recursive: true });
  writeFileSync(join(projectSkills, "project-disabled-skill", "SKILL.md"), "---\nname: project-disabled-skill\ndescription: Disabled project skill\n---\nDisabled");
  writeFileSync(join(projectSkills, "project-kept-skill", "SKILL.md"), "---\nname: project-kept-skill\ndescription: Kept project skill\n---\nKept");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [disabledExtension, allowedExtension], skills: [skillsDir] }));
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: [projectDisabledExtension, projectAllowedExtension], skills: [projectSkills] }));
  const resourcePolicy: AgentResourcePolicy = { globalSettingsPath: "/workflow/settings.json", projectSettingsPath: "/project/.pi/pi-extensible-workflows/settings.json", projectTrusted: false, global: { skills: ["disabled-skill"], extensions: [resolve(disabledExtension)] }, project: { skills: [], extensions: [] }, effective: { skills: ["disabled-skill"], extensions: [resolve(disabledExtension)] }, unmatchedSkills: [], unmatchedExtensions: [] };
  const session = await createLocalPiSession({ cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: ["read"], sessionLabel: "resource-filter", resourcePolicy, extensionFactories: [() => {}] });
  const loaded = (session as typeof session & { resourceLoader: { getSkills(): { skills: Array<{ name: string }> }; getExtensions(): { extensions: Array<{ resolvedPath: string }> } } }).resourceLoader;
  const resourcePaths = session.herdrResourcePaths;
  assert.ok(resourcePaths);
  assert.deepEqual(resourcePaths.extensions, [realpathSync(allowedExtension)]);
  assert.ok(resourcePaths.skills.includes(realpathSync(join(skillsDir, "kept-skill", "SKILL.md"))));
  assert.equal(resourcePaths.skills.some((path) => path.includes("disabled-skill")), false);
  assert.equal(existsSync(disabledMarker), false);
  assert.equal(existsSync(allowedMarker), true);
  assert.equal(existsSync(projectDisabledMarker), false);
  assert.equal(existsSync(projectAllowedMarker), false);
  const skillNames = loaded.getSkills().skills.map(({ name }) => name);
  assert.ok(skillNames.includes("kept-skill"));
  assert.equal(skillNames.includes("disabled-skill"), false);
  assert.equal(skillNames.includes("project-disabled-skill"), false);
  assert.equal(skillNames.includes("project-kept-skill"), false);
  assert.ok(loaded.getExtensions().extensions.every(({ resolvedPath }) => resolvedPath !== realpathSync(disabledExtension)));
  assert.match(session.systemPrompt ?? "", /kept-skill/);
  assert.doesNotMatch(session.systemPrompt ?? "", /disabled-skill/);
  const commands = (session as typeof session & { _extensionRunner: { runtime: { getCommands(): Array<{ name: string }> } } })._extensionRunner.runtime.getCommands();
  assert.ok(commands.some(({ name }) => name === "skill:kept-skill"));
  const preparedPrompt = await session.preparePrompt("/skill:kept-skill");
  assert.equal(preparedPrompt.diagnostics.length, 0);
  assert.match(preparedPrompt.expandedPrompt, /Kept/);
  assert.equal(commands.some(({ name }) => name === "skill:disabled-skill"), false);
  assert.deepEqual(resourcePolicy.unmatchedSkills, []);
  assert.deepEqual(resourcePolicy.unmatchedExtensions, []);
  await session.dispose();
  const trustedPolicy = { globalSettingsPath: "/workflow/settings.json", projectSettingsPath: "/project/.pi/pi-extensible-workflows/settings.json", projectTrusted: true, global: { skills: ["disabled-skill"], extensions: [resolve(disabledExtension)] }, project: { skills: ["project-disabled-skill"], extensions: [resolve(projectDisabledExtension)] }, effective: { skills: ["disabled-skill", "project-disabled-skill"], extensions: [resolve(disabledExtension), resolve(projectDisabledExtension)] }, unmatchedSkills: [], unmatchedExtensions: [] };
  const trusted = await createLocalPiSession({ cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: ["read"], sessionLabel: "resource-trusted", resourcePolicy: trustedPolicy });
  const trustedLoaded = (trusted as typeof trusted & { resourceLoader: { getSkills(): { skills: Array<{ name: string }> }; getExtensions(): { extensions: Array<{ resolvedPath: string }> } } }).resourceLoader;
  assert.equal(existsSync(projectDisabledMarker), false);
  assert.equal(existsSync(projectAllowedMarker), true);
  const trustedSkillNames = trustedLoaded.getSkills().skills.map(({ name }) => name);
  assert.ok(trustedSkillNames.includes("project-kept-skill"));
  assert.equal(trustedSkillNames.includes("project-disabled-skill"), false);
  assert.ok(trustedLoaded.getExtensions().extensions.every(({ resolvedPath }) => resolvedPath !== resolve(projectDisabledExtension)));
  assert.deepEqual(trustedPolicy.unmatchedSkills, []);
  assert.deepEqual(trustedPolicy.unmatchedExtensions, []);
  await trusted.dispose();
  const parent = await createLocalPiSession({ cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: ["read"], sessionLabel: "resource-parent" });
  assert.match(parent.systemPrompt ?? "", /disabled-skill/);
  await parent.dispose();
});

void test("treats role system prompt bodies as literal content", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-literal-system-prompt-"));
  const agentDir = join(rootDir, "agent");
  const cwd = join(rootDir, "project");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  writeFileSync(join(agentDir, "auth.json"), "{}");
  const promptBody = join(rootDir, "prompt-body");
  writeFileSync(promptBody, "This file must not be loaded as the prompt body.");
  const session = await createLocalPiSession({ cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: [], sessionLabel: "literal-system-prompt", systemPrompt: promptBody });
  try {
    assert.ok(session.systemPrompt?.startsWith(promptBody));
    assert.doesNotMatch(session.systemPrompt ?? "", /This file must not be loaded/);
  } finally {
    await session.dispose();
  }
});
void test("loads workflow SYSTEM.md with project trust and precedence", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-system-prompt-"));
  const agentDir = join(rootDir, "agent");
  const cwd = join(rootDir, "project");
  const previousHome = process.env.HOME;
  process.env.HOME = rootDir;
  try {
    mkdirSync(join(agentDir, "extensions"), { recursive: true });
    mkdirSync(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
    mkdirSync(join(rootDir, ".pi", "pi-extensible-workflows"), { recursive: true });
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(rootDir, ".pi", "pi-extensible-workflows", "SYSTEM.md"), "Global workflow system");
    writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "SYSTEM.md"), "Project workflow system");
    const policy = (projectTrusted: boolean): AgentResourcePolicy => ({ globalSettingsPath: "/workflow/settings.json", projectSettingsPath: "/project/.pi/pi-extensible-workflows/settings.json", projectTrusted, global: { skills: [], extensions: [] }, project: { skills: [], extensions: [] }, effective: { skills: [], extensions: [] }, unmatchedSkills: [], unmatchedExtensions: [] });
    const untrusted = await createLocalPiSession({ cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: [], sessionLabel: "system-untrusted", systemPromptAppend: "Role append", resourcePolicy: policy(false) });
    assert.match(untrusted.systemPrompt ?? "", /Global workflow system/);
    assert.doesNotMatch(untrusted.systemPrompt ?? "", /Project workflow system/);
    assert.match(untrusted.systemPrompt ?? "", /Role append/);
    await untrusted.dispose();
    const trusted = await createLocalPiSession({ cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: [], sessionLabel: "system-trusted", resourcePolicy: policy(true) });
    assert.match(trusted.systemPrompt ?? "", /Project workflow system/);
    assert.doesNotMatch(trusted.systemPrompt ?? "", /Global workflow system/);
    await trusted.dispose();
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  }
});
void test("applies ordered minimatch resource exclusions and records concrete matches", async () => {
  const rootDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-extensible-workflows-resource-globs-")));
  const agentDir = join(rootDir, "agent");
  const cwd = join(rootDir, "project");
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  mkdirSync(join(agentDir, "skills", "disabled-skill"), { recursive: true });
  mkdirSync(join(agentDir, "skills", "kept-skill"), { recursive: true });
  const disabledExtension = join(agentDir, "extensions", "disabled.ts");
  const allowedExtension = join(agentDir, "extensions", "allowed.ts");
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(disabledExtension, "export default function() {}");
  writeFileSync(allowedExtension, "export default function() {}");
  writeFileSync(join(agentDir, "skills", "disabled-skill", "SKILL.md"), "---\nname: disabled-skill\ndescription: Disabled\n---\nDisabled");
  writeFileSync(join(agentDir, "skills", "kept-skill", "SKILL.md"), "---\nname: kept-skill\ndescription: Kept\n---\nKept");
  const resourcePolicy: AgentResourcePolicy = { globalSettingsPath: "/workflow/settings.json", projectSettingsPath: "/project/.pi/pi-extensible-workflows/settings.json", projectTrusted: false, global: { skills: [], extensions: [] }, project: { skills: [], extensions: [] }, effective: { skills: ["disabled-*", "!kept-skill"], extensions: ["**/*", `!${allowedExtension}`] }, unmatchedSkills: [], unmatchedExtensions: [] };
  const session = await createLocalPiSession({ cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: ["read"], sessionLabel: "resource-glob", resourcePolicy });
  const loaded = (session as typeof session & { resourceLoader: { getSkills(): { skills: Array<{ name: string }> }; getExtensions(): { extensions: Array<{ resolvedPath: string }> } } }).resourceLoader;
  const skillNames = loaded.getSkills().skills.map(({ name }) => name);
  assert.ok(skillNames.includes("kept-skill"));
  assert.equal(skillNames.includes("disabled-skill"), false);
  assert.deepEqual(loaded.getExtensions().extensions.map(({ resolvedPath }) => resolve(resolvedPath)), [resolve(allowedExtension)]);
  assert.deepEqual(resourcePolicy.excludedSkills, ["disabled-skill"]);
  assert.deepEqual(resourcePolicy.excludedExtensions, [resolve(disabledExtension)]);
  assert.deepEqual(resourcePolicy.unmatchedSkills, []);
  assert.deepEqual(resourcePolicy.unmatchedExtensions, []);
  await session.dispose();
});
void test("filters local context files by the role scope policy", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-context-files-"));
  const agentDir = join(rootDir, "agent");
  const projectRoot = join(rootDir, "project");
  const cwd = join(projectRoot, "nested");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(join(agentDir, "AGENTS.md"), "global");
  writeFileSync(join(rootDir, "AGENTS.md"), "ancestor");
  writeFileSync(join(projectRoot, "AGENTS.md"), "project");
  writeFileSync(join(cwd, "AGENTS.md"), "cwd");
  const session = await createLocalPiSession({ cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: [], sessionLabel: "context-files", contextFiles: ["global", "project"] });
  try {
    assert.deepEqual(session.herdrContextFiles?.map(({ content }) => content), ["global", "ancestor", "project"]);
  } finally {
    await session.dispose();
  }
});

void test("selected skill paths load in native Pi sessions", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-skill-runtime-"));
  const agentDir = join(rootDir, "agent");
  const cwd = join(rootDir, "project");
  const skillDir = join(rootDir, "bundle-skill");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  writeFileSync(join(agentDir, "auth.json"), "{}");
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: bundle-skill\ndescription: Selected bundle skill\n---\nUse this selected bundle skill.");
  const session = await createLocalPiSession({ cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: [], sessionLabel: "bundle-skill", additionalSkillPaths: [skillDir] });
  const loaded = (session as typeof session & { resourceLoader: { getSkills(): { skills: Array<{ name: string }> } } }).resourceLoader;
  assert.ok(loaded.getSkills().skills.some(({ name }) => name === "bundle-skill"));
  await session.dispose();
});
void test("uses the neutral turn_start event for budget turn boundaries", async () => {
  const triggers: string[] = [];
  let marker = "initial";
  let listener: ((event: TestPiSessionEvent) => void) | undefined;
  const first = { role: "assistant", content: [{ type: "toolCall", id: "call", name: "read" }] };
  const final = assistant("done");
  const messages: Array<{ role: string; content: unknown }> = [];
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({
    sessionId: "budget-boundary", messages, getSessionStats: sessionStats,
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    async prompt() {
      marker = "first-start"; listener?.({ type: "turn_start" });
      marker = "first-message-start"; listener?.(messageStart({ role: "assistant" }));
      messages.push(first);
      marker = "first-end"; listener?.(messageEnd(first));
      marker = "agent-start"; listener?.({ type: "agent_start" });
      marker = "second-start"; listener?.({ type: "turn_start" });
      marker = "second-message-start"; listener?.(messageStart({ role: "assistant" }));
      messages.push(final);
      marker = "second-end"; listener?.(messageEnd(final));
    },
    dispose() {},
  })));
  await executor.execute("work", { label: "worker", workflowName: "flow", budget: { beforeAttempt() {}, beforeTurn() { triggers.push(marker); }, afterTurn() {}, instruction: () => undefined } });
  assert.deepEqual(triggers, ["initial", "second-start"]);
});
void test("preserves terminal progress when usage becomes unavailable", async () => {
  const updates: AgentProgress[] = [];
  let invalidUsage = false;
  let listener: ((event: TestPiSessionEvent) => void) | undefined;
  const final = assistant("done");
  const messages = [final];
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => ({
    sessionId: "unavailable-progress", messages, getSessionStats: () => invalidUsage ? { ...sessionStats(), cost: Number.NaN } : sessionStats(),
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    async prompt() {
      listener?.(messageStart(final));
      invalidUsage = true;
      listener?.(messageEnd(final));
    },
    dispose() {},
  })));
  await executor.execute("work", { label: "worker", workflowName: "flow", onProgress: (update) => { updates.push(update); } });
  const terminal = updates.at(-1);
  assert.ok(terminal);
  assert.equal(terminal.persist, true);
  assert.deepEqual(terminal.accounting, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25 });
});
void test("models registered by an extension are available to the agent", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-extension-provider-"));
  const agentDir = join(rootDir, "agent");
  const cwd = join(rootDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  // No provider on disk: the only route to this model is the extension below,
  // which is the whole point — an extension that supplies models (a proxy
  // front-end, a gateway) registers them while its resources load, and the
  // loader parks those registrations rather than applying them.
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  writeFileSync(join(agentDir, "auth.json"), "{}");

  const extensionFactory: NonNullable<SessionInput["extensionFactories"]>[number] = (pi) => {
    pi.registerProvider("proxied", {
      baseUrl: "http://127.0.0.1:1/v1",
      api: "openai-completions",
      apiKey: "fixture",
      models: [{ id: "proxied-model", name: "Proxied model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1_024, maxTokens: 128 }],
    });
  };

  try {
    const session = await createLocalPiSession({ cwd, agentDir, model: { provider: "proxied", model: "proxied-model" }, tools: [], sessionLabel: "extension-provider", extensionFactories: [extensionFactory] });
    await session.dispose();
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
