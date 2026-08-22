import assert from "node:assert/strict";
import test from "node:test";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { createLiveSessionHandoff } from "../src/session-handoff.js";
import { createRuntimeHandoffAdapter } from "../src/pi-runtime-adapter.js";
import { createPiRuntimeAgentRunner, runtimeToolFromPiDefinition } from "../src/pi-runtime-runner.js";
import type { RuntimeAgentRunRequest, RuntimeJsonSchema, RuntimeTool } from "../src/runtime/agent-runner.js";
import { defaultWorkflowResultSchema } from "../src/runtime/workflow-result.js";
import { WorkflowError, type AgentTransport, type AgentTransportContext, type PreparedAgentSession, type WorkflowAgentMessage, type WorkflowAgentSession, type WorkflowAgentSessionEvent, type WorkflowAgentTurnResult } from "../src/types.js";
import { testExtensionContext } from "./support.js";
type SessionPrompt = (text: string, emit: (event: WorkflowAgentSessionEvent) => void) => Promise<WorkflowAgentTurnResult>;
function sessionFor(prompt: SessionPrompt, options: { tools?: readonly string[]; lastAssistant?: () => WorkflowAgentMessage | undefined; abort?: () => Promise<void>; steer?: (message: string) => Promise<void>; dispose?: () => Promise<void>; stats?: { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost: number }; getStats?: () => { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost: number } } ): WorkflowAgentSession {
  let listener: ((event: WorkflowAgentSessionEvent) => void) | undefined;
  return {
    reference: { transport: "local", sessionId: "runner-session" },
    getState: () => ({ model: { provider: "test", model: "model" }, tools: [...(options.tools ?? [])] }),
    getSessionStats: () => options.getStats?.() ?? options.stats ?? { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.5 },
    getLastAssistant: () => options.lastAssistant?.(),
    subscribe(next) { listener = next; return () => { if (listener === next) listener = undefined; }; },
    async prompt(text) { return prompt(text, (event) => { listener?.(event); }); },
    async steer(message) { await options.steer?.(message); },
    async abort() { await options.abort?.(); },
    async dispose() { await options.dispose?.(); },
  };
}
function requestFor(signal: AbortSignal, overrides: Omit<Partial<RuntimeAgentRunRequest>, "signal"> = {}): RuntimeAgentRunRequest {
  return { task: "work", cwd: "/repo", model: { provider: "test", model: "model" }, enabledTools: [], customTools: [], run: { id: "run", namespaceId: "host", workflowName: "flow" }, agent: { id: "worker", structuralPath: ["worker"] }, signal, ...overrides };
}
function preparedWithResultTool(parameters: RuntimeJsonSchema = defaultWorkflowResultSchema): Readonly<PreparedAgentSession> {
  const schema = Compile(parameters);
  let accepted = false;
  return {
    cwd: "/repo", model: { provider: "test", model: "model" }, tools: [], sessionLabel: "worker",
    resultTool: defineTool({ name: "workflow_result", label: "Workflow Result", description: "Submit the terminal workflow result", parameters: schema.Type(), async execute(_id, value) {
      if (!schema.Check(value) || accepted) return { content: [{ type: "text" as const, text: "Result rejected." }], details: {}, isError: true };
      accepted = true;
      return { content: [{ type: "text" as const, text: "Result accepted." }], details: {} };
    } }),
  };
}
function assistantText(message: WorkflowAgentMessage | undefined): string | undefined {
  if (!message || !Array.isArray(message.content)) return undefined;
  const text = message.content.filter((part): part is { type: "text"; text: string } => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "text" && typeof (part as { text?: unknown }).text === "string").map((part) => part.text).join("");
  return text;
}
function runnerFor(session: WorkflowAgentSession, prepared: Readonly<PreparedAgentSession> = preparedWithResultTool(), transport?: AgentTransport, callbacks?: Parameters<typeof createPiRuntimeAgentRunner>[0]["callbacks"], autoResult = true) {
  const controller = new AbortController();
  const context: AgentTransportContext = { run: { cwd: "/repo", sessionId: "host", runId: "run", workflow: { name: "flow" }, args: null, signal: controller.signal }, identity: { structuralPath: ["worker"], callSite: "worker", occurrence: 1 }, attempt: 1, signal: controller.signal };
  const baseTransport = transport ?? { id: "local", async createSession() { return session; } };
  const effectiveTransport = !autoResult ? baseTransport : { id: baseTransport.id, async createSession(preparedForSession: Readonly<PreparedAgentSession>, transportContext: AgentTransportContext) {
    const current = await baseTransport.createSession(preparedForSession, transportContext);
    if (!preparedForSession.resultTool) return current;
    return { ...current, async prompt(text: string) { const response = await current.prompt(text); const value = assistantText(response.assistant); const hasToolCall = Array.isArray(response.assistant?.content) && response.assistant.content.some((part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "toolCall"); if (value !== undefined && !hasToolCall) await preparedForSession.resultTool?.execute("test-result", { result: value }, undefined, undefined, testExtensionContext); return response; } };
  } };
  return { runner: createPiRuntimeAgentRunner({ transport: effectiveTransport, prepared, context, handoff: createLiveSessionHandoff(), ...(callbacks ? { callbacks } : {}) }), controller };
}
void test("Pi runtime runner owns one complete session invocation", async () => {
  let prompts = 0;
  let disposals = 0;
  const session: WorkflowAgentSession = {
    reference: { transport: "local", sessionId: "session" },
    getState: () => ({ model: { provider: "test", model: "model" }, tools: [] }),
    getSessionStats: () => ({ tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.5 }),
    getLastAssistant: () => ({ role: "assistant", content: [{ type: "text", text: "done" }] }),
    subscribe: () => () => undefined,
    async prompt() { prompts += 1; return { assistant: { role: "assistant", content: [{ type: "text", text: "done" }] } }; },
    async steer() {},
    async abort() {},
    async dispose() { disposals += 1; },
  };
  const { runner, controller } = runnerFor(session);
  const result = await runner.run(requestFor(controller.signal));
  assert.equal(result.value, "done");
  assert.equal(prompts, 1);
  assert.equal(disposals, 1);
});

void test("Pi runtime runner preserves an explicit unstructured result after asynchronous search notifications append empty turns", async () => {
  const search = { role: "assistant" as const, content: [{ type: "toolCall" as const, id: "search", name: "web_search", arguments: {} }] };
  const resultMessage: WorkflowAgentMessage = { role: "assistant", content: [{ type: "toolCall", id: "result", name: "workflow_result", arguments: { result: "recommendation" } }] };
  const empty = { role: "assistant" as const, content: [{ type: "text" as const, text: "" }] };
  let current: WorkflowAgentMessage = search;
  let preparedWithResult: Readonly<PreparedAgentSession> | undefined;
  const session = sessionFor(async (_text, emit) => {
    emit({ type: "message_end", message: search });
    const tool = preparedWithResult?.resultTool;
    if (!tool) throw new Error("unstructured workflow_result tool is missing");
    current = resultMessage;
    const invalid = await tool.execute("invalid", { result: 7 }, undefined, undefined, testExtensionContext);
    assert.equal((invalid as { isError?: boolean }).isError, true);
    await tool.execute("result", { result: "recommendation" }, undefined, undefined, testExtensionContext);
    const duplicate = await tool.execute("duplicate", { result: "other" }, undefined, undefined, testExtensionContext);
    assert.equal((duplicate as { isError?: boolean }).isError, true);
    emit({ type: "tool_execution_end", toolCallId: "result", toolName: "workflow_result", isError: false });
    emit({ type: "message_end", message: resultMessage });
    current = empty;
    emit({ type: "message_end", message: empty });
    emit({ type: "message_end", message: empty });
    return { assistant: empty };
  }, { lastAssistant: () => current });
  const transport: AgentTransport = { id: "local", async createSession(prepared) { preparedWithResult = prepared; return session; } };
  const { runner, controller } = runnerFor(session, undefined, transport);
  const result = await runner.run(requestFor(controller.signal));
  assert.equal(result.value, "recommendation");
});

void test("Pi runtime runner rejects an unstructured agent that omits workflow_result", async () => {
  const prompts: string[] = [];
  const plain: WorkflowAgentMessage = { role: "assistant", content: [{ type: "text", text: "plain response" }] };
  const session = sessionFor(async (prompt) => { prompts.push(prompt); return { assistant: plain }; }, { lastAssistant: () => plain });
  const { runner, controller } = runnerFor(session, undefined, undefined, undefined, false);
  await assert.rejects(runner.run(requestFor(controller.signal)), (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID");
  assert.equal(prompts.length, 3);
  assert.match(prompts[1] ?? "", /Submit the final result/);
  assert.match(prompts[2] ?? "", /Repair/);
});

void test("Pi tool mapping keeps the native context and error flag", async () => {
  const definition = defineTool({
    name: "failed", label: "Failed", description: "Fail", parameters: Type.Object({}),
    async execute(_id, _params, _signal, _onUpdate, context) {
      assert.equal(context, testExtensionContext);
      return { content: [{ type: "text" as const, text: "failed" }], details: {}, isError: true };
    },
  });
  const tool = runtimeToolFromPiDefinition(definition, testExtensionContext);
  const result = await tool.execute({ id: "call", input: {}, signal: new AbortController().signal });
  assert.equal(result.isError, true);
});
void test("Pi runtime runner wires neutral custom tools before the Pi session starts", async () => {
  let received: unknown;
  let mapped: PreparedAgentSession | undefined;
  const tool: RuntimeTool = { name: "echo", description: "Echo", parameters: { type: "object" }, async execute(call) { received = call.input; return { value: call.input }; } };
  const session = sessionFor(async () => ({ assistant: { role: "assistant", content: [{ type: "text", text: "done" }] } }), { tools: ["echo"] });
  const transport: AgentTransport = { id: "local", async createSession(prepared) { mapped = prepared; return session; } };
  const { runner, controller } = runnerFor(session, undefined, transport);
  const result = await runner.run(requestFor(controller.signal, { customTools: [tool] }));
  assert.equal(result.value, "done");
  const definition = mapped?.customTools?.find(({ name }) => name === "echo");
  if (!definition) throw new Error("mapped runtime tool is missing");
  await definition.execute("call", { ok: true }, controller.signal, undefined, testExtensionContext);
  assert.deepEqual(received, { ok: true });
});
void test("Pi runtime runner finalizes structured results into its returned value", async () => {
  let last: WorkflowAgentMessage | undefined;
  let preparedWithResult: PreparedAgentSession | undefined;
  const resultTool = defineTool({
    name: "workflow_result", label: "Workflow Result", description: "Result", parameters: Type.Object({ answer: Type.Number() }),
    async execute() { return { content: [{ type: "text" as const, text: "accepted" }], details: {} }; },
  });
  const message: WorkflowAgentMessage = { role: "assistant", content: [{ type: "toolCall", id: "result", name: "workflow_result", arguments: { answer: 7 } }] };
  const session = sessionFor(async (_text, emit) => {
    last = message;
    emit({ type: "message_start", message });
    const tool = preparedWithResult?.resultTool;
    if (!tool) throw new Error("result tool is missing");
    await tool.execute("result", { answer: 7 }, undefined, undefined, testExtensionContext);
    emit({ type: "tool_execution_end", toolCallId: "result", toolName: "workflow_result", isError: false });
    emit({ type: "message_end", message });
    return { assistant: message };
  }, { lastAssistant: () => last });
  const transport: AgentTransport = { id: "local", async createSession(prepared) { preparedWithResult = prepared; return session; } };
  const { runner, controller } = runnerFor(session, { cwd: "/repo", model: { provider: "test", model: "model" }, tools: [], sessionLabel: "worker", resultTool }, transport);
  const result = await runner.run(requestFor(controller.signal, { resultSchema: { type: "object", properties: { answer: { type: "number" } } } }));
  assert.deepEqual(result.value, { answer: 7 });
});
void test("Pi runtime runner exposes the prepared result tool during handoff takeover", async () => {
  let activePrepared: Readonly<PreparedAgentSession> | undefined;
  let nativeAccepted = false;
  let startHandoff: (() => void) | undefined;
  let opening: Promise<void> | undefined;
  const resultTool = defineTool({
    name: "workflow_result", label: "Workflow Result", description: "Result", parameters: Type.Object({ answer: Type.Number() }),
    async execute() { nativeAccepted = true; return { content: [{ type: "text" as const, text: "accepted" }], details: {} }; },
  });
  const message: WorkflowAgentMessage = { role: "assistant", content: [{ type: "toolCall", id: "result", name: "workflow_result", arguments: { answer: 42 } }] };
  const session = sessionFor(async (_text, emit) => {
    emit({ type: "turn_start" });
    startHandoff?.();
    emit({ type: "message_end", message });
    emit({ type: "turn_end", message });
    if (!opening) throw new Error("handoff was not requested");
    await opening;
    return { assistant: message };
  }, {});
  const prepared: PreparedAgentSession = { cwd: "/repo", model: { provider: "test", model: "model" }, tools: [], sessionLabel: "worker", resultTool };
  const { runner, controller } = runnerFor(session, prepared, undefined, {
    onSession: async (_session, _handoff, sessionPrepared) => { activePrepared = sessionPrepared; },
  });
  const result = await runner.run(requestFor(controller.signal, {
    onControl: (control) => {
      const handoff = control.handoff;
      if (!handoff) throw new Error("runtime handoff is missing");
      startHandoff = () => {
        opening = handoff.request(async () => {
          const tool = activePrepared?.resultTool;
          if (!tool) throw new Error("live session result tool is missing");
          await tool.execute("result", { answer: 42 }, undefined, undefined, testExtensionContext);
          handoff.takeover();
        });
        void opening.then(() => { handoff.release("test resume"); }, () => { handoff.release("test failed"); });
      };
    },
    resultSchema: { type: "object", properties: { answer: { type: "number" } } },
  }));
  assert.equal(nativeAccepted, true);
  assert.deepEqual(result.value, { answer: 42 });
});
void test("continues locally when a live handoff fails before takeover", async () => {
  const prompts: string[] = [];
  let handoff: import("../src/types.js").LiveSessionHandoff | undefined;
  let opening: Promise<void> | undefined;
  let rejectPrompt!: (error: unknown) => void;
  const aborted = { role: "assistant", content: [], stopReason: "aborted" };
  const session = sessionFor(async (text, emit) => {
    prompts.push(text);
    if (prompts.length === 1) {
      const promptAborted = new Promise<never>((_, reject) => { rejectPrompt = reject; });
      emit({ type: "turn_start" });
      if (!handoff) throw new Error("runtime handoff is missing");
      opening = handoff.request(async () => { throw new Error("pane launch failed"); });
      void opening.catch(() => undefined);
      emit({ type: "turn_end", message: aborted });
      return await promptAborted;
    }
    return { assistant: { role: "assistant", content: [{ type: "text", text: "continued" }] } };
  }, { abort: async () => { rejectPrompt(new WorkflowError("CANCELLED", "Agent cancelled")); }, lastAssistant: () => aborted });
  const { runner, controller } = runnerFor(session, undefined, undefined, { onSession: async (_session, current) => { handoff = current; } });
  const result = await runner.run(requestFor(controller.signal));
  if (!opening) throw new Error("handoff launch was not started");
  await assert.rejects(opening, /pane launch failed/);
  assert.equal(result.value, "continued");
  assert.deepEqual(prompts, ["work", "Continue the task from the current session state."]);
});
void test("Pi runtime runner uses the executor's prepared structured result tool", async () => {
  const resultSchema: RuntimeJsonSchema = { type: "object", properties: { answer: { type: "number" } } };
  let preparedWithResult: PreparedAgentSession | undefined;
  const message: WorkflowAgentMessage = { role: "assistant", content: [{ type: "toolCall", id: "result", name: "workflow_result", arguments: { answer: 11 } }] };
  const session = sessionFor(async (_text, emit) => {
    const tool = preparedWithResult?.resultTool;
    if (!tool) throw new Error("result tool is missing");
    await tool.execute("result", { answer: 11 }, undefined, undefined, testExtensionContext);
    emit({ type: "message_end", message });
    return { assistant: message };
  }, {});
  const transport: AgentTransport = { id: "local", async createSession(prepared) { preparedWithResult = prepared; return session; } };
  const { runner, controller } = runnerFor(session, preparedWithResultTool(resultSchema), transport);
  const result = await runner.run(requestFor(controller.signal, { resultSchema }));
  assert.deepEqual(result.value, { answer: 11 });
});
void test("Pi runtime runner ignores an empty provider error after accepting workflow_result", async () => {
  const resultSchema: RuntimeJsonSchema = { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false };
  let preparedWithResult: PreparedAgentSession | undefined;
  let prompts = 0;
  let providerErrors = 0;
  const providerAbort: WorkflowAgentMessage = { role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" };
  const session = sessionFor(async () => {
    prompts += 1;
    if (prompts > 1) return { assistant: { role: "assistant", content: [{ type: "text", text: "continued" }] } };
    const tool = preparedWithResult?.resultTool;
    if (!tool) throw new Error("result tool is missing");
    await tool.execute("result", { answer: 7 }, undefined, undefined, testExtensionContext);
    return { assistant: providerAbort };
  }, {});
  const transport: AgentTransport = { id: "local", async createSession(prepared) { preparedWithResult = prepared; return session; } };
  const { runner, controller } = runnerFor(session, preparedWithResultTool(resultSchema), transport);
  const result = await runner.run(requestFor(controller.signal, {
    resultSchema,
    onProviderError: async () => { providerErrors += 1; return "retry"; },
  }));
  assert.deepEqual(result.value, { answer: 7 });
  assert.deepEqual({ prompts, providerErrors }, { prompts: 1, providerErrors: 0 });
});
void test("Pi runtime runner leaves retry ownership with its caller", async () => {
  let sessions = 0;
  let prompts = 0;
  let disposals = 0;
  const transport: AgentTransport = { id: "local", async createSession() {
    sessions += 1;
    const current = sessions;
    return sessionFor(async () => { prompts += 1; if (current === 1) throw new Error("first attempt"); return { assistant: { role: "assistant", content: [{ type: "text", text: "done" }] } }; }, { dispose: async () => { disposals += 1; } });
  } };
  const prepared: PreparedAgentSession = preparedWithResultTool();
  const { runner, controller } = runnerFor(sessionFor(async () => ({ assistant: { role: "assistant", content: [{ type: "text", text: "unused" }] } }), {}), prepared, transport);
  await assert.rejects(runner.run(requestFor(controller.signal)), /first attempt/);
  const result = await runner.run(requestFor(controller.signal));
  assert.equal(result.value, "done");
  assert.deepEqual({ sessions, prompts, disposals }, { sessions: 2, prompts: 2, disposals: 2 });
});
void test("Pi runtime runner cancels and disposes an in-flight prompt", async () => {
  let started!: () => void;
  const promptStarted = new Promise<void>((resolve) => { started = resolve; });
  let aborts = 0;
  let disposals = 0;
  const session = sessionFor(async () => { started(); return new Promise<WorkflowAgentTurnResult>(() => undefined); }, { abort: async () => { aborts += 1; }, dispose: async () => { disposals += 1; } });
  const { runner, controller } = runnerFor(session);
  const running = runner.run(requestFor(controller.signal));
  await promptStarted;
  controller.abort();
  await assert.rejects(running, (error: unknown) => error instanceof Error && error.name === "WorkflowError" && "code" in error && (error as { code?: unknown }).code === "CANCELLED");
  assert.deepEqual({ aborts, disposals }, { aborts: 1, disposals: 1 });
});
void test("Pi runtime runner times out and disposes an in-flight prompt", async () => {
  let aborts = 0;
  let disposals = 0;
  const session = sessionFor(async () => new Promise<WorkflowAgentTurnResult>(() => undefined), { abort: async () => { aborts += 1; }, dispose: async () => { disposals += 1; } });
  const { runner, controller } = runnerFor(session);
  await assert.rejects(runner.run(requestFor(controller.signal, { timeoutMs: 10 })), (error: unknown) => error instanceof Error && "code" in error && (error as { code?: unknown }).code === "AGENT_TIMEOUT");
  assert.deepEqual({ aborts, disposals }, { aborts: 1, disposals: 1 });
});
void test("Pi runtime runner keeps a completed value when cancellation arrives during finalization", async () => {
  const session = sessionFor(async () => ({ assistant: { role: "assistant", content: [{ type: "text", text: "done" }] } }), {});
  const control = { current: undefined as AbortController | undefined };
  const { runner, controller } = runnerFor(session, undefined, undefined, { onBeforeComplete: () => { control.current?.abort(); } });
  control.current = controller;
  const result = await runner.run(requestFor(controller.signal));
  assert.equal(result.value, "done");
});
void test("Pi runtime runner exposes steering and awaits the control callback", async () => {
  const steered: string[] = [];
  const session = sessionFor(async () => ({ assistant: { role: "assistant", content: [{ type: "text", text: "done" }] } }), { steer: async (message) => { steered.push(message); } });
  let controlHandoff: unknown;
  const { runner, controller } = runnerFor(session);
  await runner.run(requestFor(controller.signal, { onControl: async (control) => { controlHandoff = control.handoff; await control.steer("continue"); } }));
  assert.ok(controlHandoff);
  assert.deepEqual(steered, ["continue"]);
});
void test("Pi runtime runner observes a caller-supplied handoff and resumes with continuation", async () => {
  const remote = createLiveSessionHandoff();
  const requestHandoff = createRuntimeHandoffAdapter(remote);
  let last: WorkflowAgentMessage | undefined;
  let startHandoff: (() => void) | undefined;
  let opening: Promise<void> | undefined;
  const prompts: string[] = [];
  const first = { role: "assistant", content: [{ type: "toolCall", id: "tool", name: "read", arguments: {} }] };
  const continued = { role: "assistant", content: [{ type: "text", text: "continued" }] };
  const session = sessionFor(async (text, emit) => {
    prompts.push(text);
    if (prompts.length === 1) {
      last = first;
      emit({ type: "turn_start" });
      startHandoff?.();
      emit({ type: "message_end", message: first });
      emit({ type: "turn_end", message: first });
      await opening;
      return { assistant: first };
    }
    last = continued;
    return { assistant: continued };
  }, { lastAssistant: () => last });
  const { runner, controller } = runnerFor(session);
  await runner.run(requestFor(controller.signal, {
    onControl: (control) => {
      assert.equal(control.handoff, requestHandoff);
      startHandoff = () => {
        opening = requestHandoff.request(async () => { requestHandoff.takeover(); last = { role: "assistant", content: [], stopReason: "aborted" }; });
        void opening.then(() => { requestHandoff.release("test resume"); });
      };
    },
    handoff: requestHandoff,
  }));
  assert.equal(prompts[1], "Continue the task from the current session state.");
  assert.equal(requestHandoff.transferred, true);
});
void test("Pi runtime runner persists tool progress and live state", async () => {
  const updates: Array<{ toolCalls: readonly { state: string }[]; state: { tools: readonly string[] } | undefined; persist: boolean }> = [];
  const message = { role: "assistant", content: [{ type: "text", text: "done" }] };
  const session = sessionFor(async (_text, emit) => {
    emit({ type: "state_changed", state: { model: { provider: "test", model: "model" }, tools: ["read"] } });
    emit({ type: "tool_execution_start", toolCallId: "call", toolName: "read" });
    emit({ type: "tool_execution_end", toolCallId: "call", toolName: "read", isError: false });
    emit({ type: "message_end", message });
    return { assistant: message };
  }, { tools: ["read"] });
  const { runner, controller } = runnerFor(session, { ...preparedWithResultTool(), tools: ["read"] });
  await runner.run(requestFor(controller.signal, { enabledTools: ["read"], onProgress: (progress) => { updates.push({ toolCalls: progress.toolCalls, state: progress.state ? { tools: progress.state.tools } : undefined, persist: progress.persist }); } }));
  assert.ok(updates.some(({ toolCalls }) => toolCalls.some(({ state }) => state === "running")));
  assert.ok(updates.some(({ toolCalls }) => toolCalls.some(({ state }) => state === "completed")));
  assert.ok(updates.some(({ state, persist }) => persist && state?.tools[0] === "read"));
});
void test("Pi runtime runner avoids progress materialization without a handler", async () => {
  let statsCalls = 0;
  const message: WorkflowAgentMessage = { role: "assistant", content: [{ type: "text", text: "done" }] };
  const session = sessionFor(async (_text, emit) => {
    emit({ type: "state_changed", state: { model: { provider: "test", model: "model" }, tools: [] } });
    emit({ type: "message_end", message });
    return { assistant: message };
  }, { getStats: () => {
    statsCalls += 1;
    return { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.5 };
  } });
  const { runner, controller } = runnerFor(session);
  const result = await runner.run(requestFor(controller.signal));
  assert.equal(result.value, "done");
  assert.equal(statsCalls, 1);
});
void test("Pi runtime runner keeps session event observation best effort", async () => {
  let statsCalls = 0;
  const message: WorkflowAgentMessage = { role: "assistant", content: [{ type: "text", text: "done" }] };
  const session = sessionFor(async (_text, emit) => {
    emit({ type: "state_changed", state: { model: { provider: "test", model: "model" }, tools: [] } });
    emit({ type: "message_end", message });
    return { assistant: message };
  }, { getStats: () => {
    statsCalls += 1;
    if (statsCalls === 2) throw new Error("progress stats failed");
    return { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.5 };
  } });
  const { runner, controller } = runnerFor(session);
  const result = await runner.run(requestFor(controller.signal, { onProgress: () => undefined }));
  assert.equal(result.value, "done");
  assert.ok(statsCalls >= 3);
});
void test("Pi runtime runner preserves disposal failures after success", async () => {
  let disposals = 0;
  const session = sessionFor(async () => ({ assistant: { role: "assistant", content: [{ type: "text", text: "done" }] } }), { dispose: async () => { disposals += 1; throw new Error("dispose failed"); } });
  const { runner, controller } = runnerFor(session);
  await assert.rejects(runner.run(requestFor(controller.signal)), /dispose failed/);
  assert.equal(disposals, 1);
});
void test("Pi runtime runner preserves the primary failure when disposal also fails", async () => {
  let disposals = 0;
  const session = sessionFor(async () => { throw new Error("prompt failed"); }, { dispose: async () => { disposals += 1; throw new Error("dispose failed"); } });
  const { runner, controller } = runnerFor(session);
  await assert.rejects(runner.run(requestFor(controller.signal)), /prompt failed/);
  assert.equal(disposals, 1);
});
void test("Pi runtime runner reports unavailable usage without inventing accounting", async () => {
  const session = sessionFor(async () => ({ assistant: { role: "assistant", content: [{ type: "text", text: "done" }] } }), { stats: { tokens: { input: Number.NaN, output: 2, cacheRead: 3, cacheWrite: 4, total: 9 }, cost: 0.5 } });
  const { runner, controller } = runnerFor(session);
  const result = await runner.run(requestFor(controller.signal));
  assert.deepEqual(result.usage, { availability: "unavailable" });
});
void test("Pi runtime runner keeps a provider pause outside the attempt deadline", async () => {
  let prompts = 0;
  const session = sessionFor(async () => {
    prompts += 1;
    if (prompts === 1) throw Object.assign(new Error("limited"), { status: 429 });
    return { assistant: { role: "assistant", content: [{ type: "text", text: "done" }] } };
  }, {});
  const { runner, controller } = runnerFor(session);
  const result = await runner.run(requestFor(controller.signal, { timeoutMs: 10, onProviderLimit: async () => { await new Promise<void>((resolve) => setTimeout(resolve, 20)); } }));
  assert.equal(result.value, "done");
  assert.equal(prompts, 2);
});
