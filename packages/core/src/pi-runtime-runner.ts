import { Compile } from "typebox/compile";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createPiRuntimeSessionAdapter, isTurnBoundaryStart, isTurnEnd, normalizePiMessage, type PiRuntimeSessionAdapter } from "./pi-runtime-adapter.js";
import type { RuntimeAgentProgress, RuntimeAgentProviderFailure, RuntimeAgentProviderRecovery, RuntimeAgentRunRequest, RuntimeAgentRunResult, RuntimeAgentRunner, RuntimeJsonSchema, RuntimeJsonValue, RuntimeTool, RuntimeToolCall, RuntimeUsage } from "./runtime/agent-runner.js";
import { RuntimeAgentProviderError } from "./runtime/agent-runner.js";
import { jsonValue } from "./utils.js";
import { WorkflowError, type AgentTransport, type AgentTransportContext, type JsonValue, type LiveSessionHandoff, type PreparedAgentSession, type WorkflowAgentMessage, type WorkflowAgentSession, type WorkflowAgentSessionEvent } from "./types.js";

const providerContinuationPrompt = "The provider error was transient. Continue the task from your current state.";
const handoffContinuationPrompt = "Continue the task from the current session state.";
const defaultResultSchema: RuntimeJsonSchema = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
  additionalProperties: false,
};

type PiRuntimeAgentRunnerCallbacks = {
  readonly onSession?: (session: WorkflowAgentSession, handoff: LiveSessionHandoff, prepared: Readonly<PreparedAgentSession>) => void | Promise<void>;
  readonly onSessionReady?: () => void | Promise<void>;
  readonly onBeforeComplete?: () => void | Promise<void>;
  readonly onComplete?: (result: RuntimeAgentRunResult, session: WorkflowAgentSession) => void | Promise<void>;
  readonly onFailure?: (error: WorkflowError, session: WorkflowAgentSession) => void | Promise<void>;
  readonly onSystemPrompt?: (entry: { readonly sessionId: string; readonly turn: number; readonly prompt: string }) => void | Promise<void>;
};

export interface PiRuntimeAgentRunnerOptions {
  readonly transport: AgentTransport;
  readonly prepared: Readonly<PreparedAgentSession>;
  readonly context: Readonly<AgentTransportContext>;
  readonly handoff: LiveSessionHandoff;
  readonly callbacks?: PiRuntimeAgentRunnerCallbacks;
}

type PiToolContext = Parameters<ToolDefinition["execute"]>[4];

export function runtimeToolFromPiDefinition(definition: ToolDefinition, context: PiToolContext): RuntimeTool {
  const parameters = definition.parameters;
  if (!jsonValue(parameters)) throw new WorkflowError("INVALID_METADATA", `Pi tool ${definition.name} has a non-JSON parameter schema`);
  return {
    name: definition.name,
    description: definition.description,
    parameters: parameters as RuntimeJsonSchema,
    async execute(call: RuntimeToolCall) {
      const result: unknown = await definition.execute(call.id, call.input, call.signal, undefined, context);
      const isError = typeof result === "object" && result !== null && "isError" in result && (result as { readonly isError?: unknown }).isError === true;
      if (!jsonValue(result)) throw new WorkflowError("RESULT_INVALID", `Pi tool ${definition.name} returned a non-JSON result`);
      return { value: runtimeValue(result), ...(isError ? { isError: true } : {}) };
    },
  };
}

function hasToolCall(message: unknown): boolean {
  return typeof message === "object" && message !== null && Array.isArray((message as { content?: unknown }).content) && (message as { content: unknown[] }).content.some((part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "toolCall");
}

function isEmptyAbortedAssistant(message: WorkflowAgentMessage | undefined): boolean { return message?.stopReason === "aborted" && Array.isArray(message.content) && message.content.length === 0; }
function isTerminalAssistant(message: WorkflowAgentMessage | undefined): boolean { return Boolean(message) && message?.stopReason !== "aborted" && !hasToolCall(message); }
function runtimeUsage(session: WorkflowAgentSession): RuntimeUsage {
  const stats = session.getSessionStats();
  const values = [stats.tokens.input, stats.tokens.output, stats.tokens.cacheRead, stats.tokens.cacheWrite, stats.cost];
  if (values.some((value) => !Number.isFinite(value))) return { availability: "unavailable" };
  return { availability: "complete", input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite, costUsd: stats.cost };
}

function providerFailure(session: WorkflowAgentSession, message: WorkflowAgentMessage | undefined): RuntimeAgentProviderFailure | undefined {
  if (message?.stopReason !== "error") return undefined;
  const state = session.getState();
  return { provider: state.model.provider, model: state.model.model, error: message.errorMessage ?? "Workflow agent session ended with a terminal provider error" };
}

function runtimeValue(value: JsonValue): RuntimeJsonValue { return value; }
function unstructuredResult(value: RuntimeJsonValue | undefined): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.result !== "string") return undefined;
  return value.result;
}
function remaining(timeoutMs: number | null | undefined, started: number): number | null | undefined { return timeoutMs === null || timeoutMs === undefined ? timeoutMs : Math.max(1, timeoutMs - (Date.now() - started)); }
function providerLimited(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 429 || candidate.code === 429 || candidate.code === "rate_limit_exceeded" || candidate.code === "RATE_LIMITED";
}
function errorText(error: unknown): string { return error instanceof Error ? error.message : typeof error === "string" ? error : String(error); }
function isToolError(result: unknown): boolean { return typeof result === "object" && result !== null && "isError" in result && (result as { readonly isError?: unknown }).isError === true; }
function piToolFromRuntime(definition: RuntimeTool, signal: AbortSignal): ToolDefinition {
  if (typeof definition.name !== "string" || !definition.name || typeof definition.description !== "string" || !jsonValue(definition.parameters) || typeof definition.execute !== "function") throw new WorkflowError("INVALID_METADATA", `Runtime tool ${definition.name || "<unnamed>"} is not JSON-compatible`);
  return {
    name: definition.name,
    label: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    async execute(toolCallId, input, toolSignal) {
      if (!jsonValue(input)) throw new WorkflowError("INVALID_METADATA", `Runtime tool ${definition.name} received a non-JSON input`);
      const result = await definition.execute({ id: toolCallId, input: runtimeValue(input), signal: toolSignal ?? signal });
      if (!jsonValue(result.value)) throw new WorkflowError("RESULT_INVALID", `Runtime tool ${definition.name} returned a non-JSON result`);
      return { content: [{ type: "text" as const, text: JSON.stringify(result.value) }], details: result.value, ...(result.isError ? { isError: true } : {}) };
    },
  };
}

function preparedForRuntimeRequest(prepared: Readonly<PreparedAgentSession>, customTools: readonly RuntimeTool[], signal: AbortSignal, captureResult: (value: RuntimeJsonValue) => void, resultTool: ToolDefinition | undefined = prepared.resultTool): Readonly<PreparedAgentSession> {
  const names = new Set([...prepared.tools, ...(prepared.customTools ?? []).map(({ name }) => name), ...(resultTool ? [resultTool.name] : [])]);
  const additions = customTools.map((tool) => {
    if (names.has(tool.name)) throw new WorkflowError("INTERNAL_ERROR", `Runtime tool ${tool.name} conflicts with the prepared Pi tool policy`);
    names.add(tool.name);
    return piToolFromRuntime(tool, signal);
  });
  const nativeResultTool = resultTool;
  const wrappedResultTool = nativeResultTool ? Object.freeze({
    ...nativeResultTool,
    async execute(toolCallId: string, input: unknown, toolSignal: AbortSignal | undefined, onUpdate: Parameters<ToolDefinition["execute"]>[3], context: Parameters<ToolDefinition["execute"]>[4]) {
      const result = await nativeResultTool.execute(toolCallId, input, toolSignal, onUpdate, context);
      if (!isToolError(result) && jsonValue(input)) captureResult(runtimeValue(structuredClone(input)));
      return result;
    },
  }) : undefined;
  if (additions.length === 0 && wrappedResultTool === undefined) return prepared;
  return Object.freeze({
    ...prepared,
    ...(additions.length === 0 ? {} : { customTools: Object.freeze([...(prepared.customTools ?? []), ...additions]) }),
    ...(wrappedResultTool === undefined ? {} : { resultTool: wrappedResultTool }),
  });
}

export function isRuntimeAgentProviderError(error: unknown): error is RuntimeAgentProviderError { return error instanceof RuntimeAgentProviderError; }

export function normalizePiRuntimeError(error: unknown, signal: AbortSignal, setupFailed = false): WorkflowError {
  if (error instanceof WorkflowError) return error;
  if (error instanceof RuntimeAgentProviderError) return new WorkflowError("AGENT_FAILED", error.failure.error);
  return new WorkflowError(signal.aborted && setupFailed ? "CANCELLED" : "AGENT_FAILED", errorText(error));
}

async function withTimeout(work: Promise<{ assistant?: WorkflowAgentMessage }>, timeoutMs: number | null | undefined, signal: AbortSignal, session: WorkflowAgentSession): Promise<{ assistant?: WorkflowAgentMessage }> {
  if (signal.aborted) throw new WorkflowError("CANCELLED", "Agent cancelled");
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const state = { interrupted: false };
  const timeout = timeoutMs === undefined || timeoutMs === null ? new Promise<never>(() => undefined) : new Promise<never>((_, reject) => {
    timer = setTimeout(() => { state.interrupted = true; reject(new WorkflowError("AGENT_TIMEOUT", "Agent attempt timed out")); }, timeoutMs);
  });
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => { state.interrupted = true; reject(new WorkflowError("CANCELLED", "Agent cancelled")); };
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    return await Promise.race([work, timeout, cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) signal.removeEventListener("abort", abort);
    if (state.interrupted) await session.abort();
  }
}

async function promptWithProviderPause(session: WorkflowAgentSession, textValue: string, timeoutMs: number | null | undefined, started: number, request: Readonly<RuntimeAgentRunRequest>): Promise<{ assistant?: WorkflowAgentMessage }> {
  const promptTimeout = remaining(timeoutMs, started);
  for (;;) {
    try { return await withTimeout(session.prompt(textValue), promptTimeout, request.signal, session); }
    catch (error) {
      if (!request.onProviderLimit || !providerLimited(error)) throw error;
      await request.onProviderLimit();
    }
  }
}

export class PiRuntimeAgentRunner implements RuntimeAgentRunner {
  readonly id = "pi";
  // Prepared Pi definitions remain native; request-neutral tools are adapted before session creation.
  readonly capabilities = { customTools: true, structuredResults: true, steering: true, handoff: true, usage: "complete" as const };
  readonly #options: PiRuntimeAgentRunnerOptions;
  constructor(options: PiRuntimeAgentRunnerOptions) { this.#options = options; }
  run(request: Readonly<RuntimeAgentRunRequest>): Promise<RuntimeAgentRunResult> { return this.#runOnce(request); }

  async #runOnce(request: Readonly<RuntimeAgentRunRequest>): Promise<RuntimeAgentRunResult> {
    if (request.signal.aborted) throw new WorkflowError("CANCELLED", "Agent cancelled");
    if (request.timeoutMs !== undefined && request.timeoutMs !== null && (!Number.isInteger(request.timeoutMs) || request.timeoutMs <= 0)) throw new WorkflowError("INVALID_METADATA", "timeoutMs must be null or a positive integer");
    const started = Date.now();
    const prepared = this.#options.prepared;
    if (request.cwd !== prepared.cwd || request.model.provider !== prepared.model.provider || request.model.model !== prepared.model.model || request.model.thinking !== prepared.model.thinking || request.enabledTools.length !== prepared.tools.length || request.enabledTools.some((tool, index) => tool !== prepared.tools[index])) throw new WorkflowError("INTERNAL_ERROR", "Pi runtime request does not match the prepared session");
    let session: WorkflowAgentSession | undefined;
    let structuredResult: RuntimeJsonValue | undefined;
    let resultAccepted = false;
    const resultSchema = Compile(request.resultSchema ?? defaultResultSchema);
    const resultTool = prepared.resultTool ?? defineTool({
      name: "workflow_result", label: "Workflow Result", description: "Submit the terminal structured workflow result", parameters: resultSchema.Type(),
      async execute(_id: string, value: unknown) {
        if (!resultSchema.Check(value) || !jsonValue(value)) return { content: [{ type: "text" as const, text: "Result does not match the required schema." }], details: {}, isError: true };
        if (resultAccepted) return { content: [{ type: "text" as const, text: "Result has already been accepted." }], details: {}, isError: true };
        resultAccepted = true;
        const currentSession = session;
        if (currentSession) void currentSession.abort().catch(() => undefined);
        return { content: [{ type: "text" as const, text: "Result accepted." }], details: {} };
      },
    });
    const preparedForSession = preparedForRuntimeRequest(prepared, request.customTools, request.signal, (value) => { structuredResult = value; }, resultTool);
    const callbacks = this.#options.callbacks;
    const handoff = this.#options.handoff;
    let adapter: PiRuntimeSessionAdapter | undefined;
    let unsubscribe: (() => void) | undefined;
    let disposeStarted = false;
    let sessionReady = false;
    let successfulInvocation = false;
    let progress = Promise.resolve();
    const eventNotifications = new Set<Promise<void>>();
    let systemPromptTurn = 0;
    let systemPromptWrite = Promise.resolve();
    let systemPromptWriteError: unknown;
    let turnStarted = false;
    let turnPolicyFailure: WorkflowError | undefined;
    let lastAssistant: WorkflowAgentMessage | undefined;
    let handoffBoundaryAssistant: WorkflowAgentMessage | undefined;

    const hasResult = (): boolean => structuredResult !== undefined;
    // Session event observations are best effort, matching the legacy synchronous subscription.
    const trackEvent = (notification: Promise<void>): void => {
      eventNotifications.add(notification);
      void notification.then(() => { eventNotifications.delete(notification); }, () => { eventNotifications.delete(notification); });
    };
    const flushEvents = async (): Promise<void> => {
      while (eventNotifications.size > 0) {
        const pending = [...eventNotifications];
        await Promise.allSettled(pending);
        for (const notification of pending) eventNotifications.delete(notification);
      }
    };
    const report = (value: RuntimeAgentProgress | (() => RuntimeAgentProgress)): void => {
      const progressHandler = request.onProgress;
      if (!progressHandler) return;
      const materialized = typeof value === "function" ? value() : value;
      progress = progress.then(() => progressHandler(materialized)).then(() => undefined);
    };
    const flushProgress = async (): Promise<void> => { await progress; };
    const recordSystemPrompt = (entry: { readonly sessionId: string; readonly turn: number; readonly prompt: string }): void => {
      systemPromptWrite = systemPromptWrite.then(() => callbacks?.onSystemPrompt?.(entry)).catch((error: unknown) => { systemPromptWriteError ??= error; });
    };
    const flushSystemPrompts = async (): Promise<void> => {
      await systemPromptWrite;
      if (systemPromptWriteError !== undefined) throw new WorkflowError("INTERNAL_ERROR", `Failed to persist effective system prompt: ${errorText(systemPromptWriteError)}`);
    };
    const policy = request.turnPolicy;
    const turnPolicyError = (error: unknown): WorkflowError => error instanceof WorkflowError ? error : new WorkflowError("BUDGET_EXHAUSTED", errorText(error));
    const beginTurn = (abortOnFailure = true): void => {
      if (!policy || turnStarted) return;
      try { policy.beforeTurn(); turnStarted = true; }
      catch (error) {
        turnPolicyFailure ??= turnPolicyError(error);
        if (abortOnFailure && session) void session.abort().catch(() => undefined);
      }
    };
    const throwIfTurnPolicyFailed = (): void => { const failure = turnPolicyFailure; if (failure) throw failure; };
    const completeTurn = (final: boolean, steerInstruction: boolean, force = false): void => {
      if (!policy) { turnStarted = false; return; }
      if (turnPolicyFailure && !force) { turnStarted = false; return; }
      try {
        const instruction = policy.afterTurn(runtimeUsage(session as WorkflowAgentSession), final, steerInstruction);
        if (steerInstruction && instruction && session) void session.steer(instruction).catch(() => undefined);
      } catch (error) {
        turnPolicyFailure ??= turnPolicyError(error);
        if (session) void session.abort().catch(() => undefined);
      }
      turnStarted = false;
    };
    const acceptAssistant = (candidate: WorkflowAgentMessage | undefined): void => {
      if (isEmptyAbortedAssistant(candidate)) {
        const previous = session?.getLastAssistant();
        if (previous && !isEmptyAbortedAssistant(previous)) lastAssistant = previous;
      } else if (candidate) lastAssistant = candidate;
    };
    const throwIfCancelled = (): void => { if (request.signal.aborted) throw new WorkflowError("CANCELLED", "Agent cancelled"); };

    try {
      session = await this.#options.transport.createSession(preparedForSession, this.#options.context);
      if (session.reference.transport !== this.#options.transport.id) {
        const actualTransport = session.reference.transport;
        disposeStarted = true;
        await session.dispose();
        session = undefined;
        throw new WorkflowError("INTERNAL_ERROR", `Agent transport ${this.#options.transport.id} created a session for ${actualTransport}`);
      }
      sessionReady = true;
      const createdAdapter = createPiRuntimeSessionAdapter(session, handoff);
      adapter = createdAdapter;
      await callbacks?.onSession?.(session, handoff, preparedForSession);
      const activeSession = session;
      const runtimeHandoff = request.handoff ?? adapter.handoff;
      const preparedTools = new Set([...preparedForSession.tools, ...(preparedForSession.customTools ?? []).map(({ name }) => name), ...(preparedForSession.resultTool ? [preparedForSession.resultTool.name] : [])]);
      if (session.getState().tools.some((tool) => !preparedTools.has(tool))) throw new WorkflowError("INTERNAL_ERROR", `Agent transport ${this.#options.transport.id} widened the prepared tool policy`);
      await callbacks?.onSessionReady?.();
      const handleSessionEvent = async (event: WorkflowAgentSessionEvent): Promise<void> => {
        const observation = adapter?.observe(event);
        if (!observation || !session) return;
        const observedEvent = observation.event;
        if (isTurnEnd(observedEvent.type)) handoffBoundaryAssistant = observedEvent.message?.role === "assistant" ? observedEvent.message : session.getLastAssistant() ?? lastAssistant;
        if (runtimeHandoff !== adapter?.handoff) runtimeHandoff.observe({ type: observedEvent.type });
        if (isTurnEnd(observedEvent.type) && runtimeHandoff.state === "takeover-pending") void session.abort().catch(() => undefined);
        if (observedEvent.type === "agent_start" && session.getState().systemPrompt !== undefined) {
          systemPromptTurn += 1;
          recordSystemPrompt({ sessionId: session.reference.sessionId, turn: systemPromptTurn, prompt: session.getState().systemPrompt ?? "" });
        }
        if (isTurnBoundaryStart(observedEvent.type) || (observedEvent.type === "message_start" && observedEvent.message?.role === "assistant")) beginTurn();
        if (observedEvent.type === "message_end" && observedEvent.message?.role === "assistant") {
          acceptAssistant(observedEvent.message);
          const final = !hasToolCall(observedEvent.message) || hasResult();
          completeTurn(final, !final);
        }
        if (observation.report) report(() => observation.progress);
      };
      if (session.subscribeAsync) unsubscribe = session.subscribeAsync((event) => { const notification = handleSessionEvent(event); trackEvent(notification); return notification; });
      else unsubscribe = session.subscribe((event) => { trackEvent(handleSessionEvent(event)); });
      report(() => createdAdapter.snapshot(false));
      await request.onControl?.({ handoff: runtimeHandoff, steer: (message) => activeSession.steer(message) });

      const promptOnce = async (prompt: string, turnAlreadyStarted = false): Promise<void> => {
        if (!turnAlreadyStarted) beginTurn();
        throwIfTurnPolicyFailed();
        const response = await promptWithProviderPause(session as WorkflowAgentSession, prompt, request.timeoutMs, started, request);
        acceptAssistant(normalizePiMessage(response.assistant));
        await flushEvents();
      };
      const recoverTerminal = async (): Promise<boolean> => {
        let continued = false;
        for (;;) {
          if (hasResult()) return continued;
          const failure = providerFailure(session as WorkflowAgentSession, lastAssistant);
          if (!failure) return continued;
          if (!request.onProviderError) throw new RuntimeAgentProviderError(failure, undefined, false);
          let recovery: RuntimeAgentProviderRecovery;
          try { recovery = await request.onProviderError(failure); }
          catch { throw new RuntimeAgentProviderError(failure, undefined, true); }
          if (recovery !== "retry") throw new RuntimeAgentProviderError(failure, recovery, true);
          continued = true;
          try { await promptOnce(providerContinuationPrompt); }
          catch (error) { acceptAssistant(session?.getLastAssistant() ?? lastAssistant); if (!hasResult()) throw error; }
        }
      };
      const promptAndRecover = async (prompt: string, turnAlreadyStarted = false): Promise<void> => {
        let promptFailed = false;
        let promptError: unknown;
        try { await promptOnce(prompt, turnAlreadyStarted); }
        catch (error) { acceptAssistant(session?.getLastAssistant() ?? lastAssistant); promptFailed = true; promptError = error; }
        const recovered = await recoverTerminal();
        const preHandoffAssistant = handoffBoundaryAssistant;
        handoffBoundaryAssistant = undefined;
        const handoffWasAttempted = runtimeHandoff.state !== "local-running";
        throwIfCancelled();
        await runtimeHandoff.waitForResume();
        throwIfCancelled();
        const resumed = session?.getLastAssistant();
        const preservePreHandoffResult = runtimeHandoff.transferred && isTerminalAssistant(preHandoffAssistant);
        if (preservePreHandoffResult) lastAssistant = preHandoffAssistant;
        else acceptAssistant(resumed);
        let handoffError: unknown;
        let handoffRecovered = false;
        if (runtimeHandoff.transferred && !preservePreHandoffResult && !hasResult() && (!resumed || resumed.stopReason === "aborted" || hasToolCall(resumed))) {
          try { await promptOnce(handoffContinuationPrompt); }
          catch (error) { handoffError = error; }
        }
        if (handoffWasAttempted && !runtimeHandoff.transferred && promptFailed && !hasResult()) {
          try { await promptOnce(handoffContinuationPrompt); handoffRecovered = true; }
          catch (error) { handoffError = error; }
        }
        if (handoffError && !hasResult()) throw handoffError instanceof Error ? handoffError : new Error(errorText(handoffError));
        if (promptFailed && !hasResult() && !recovered && !handoffRecovered && !runtimeHandoff.transferred) throw promptError instanceof Error ? promptError : new Error(errorText(promptError));
      };

      beginTurn(false);
      throwIfTurnPolicyFailed();
      await promptAndRecover(request.task, true);
      completeTurn(hasResult() || !hasToolCall(lastAssistant), false, true);
      if (turnPolicyFailure) throw turnPolicyFailure;
      if (!hasResult()) {
        beginTurn(false);
        throwIfTurnPolicyFailed();
        await promptAndRecover("Submit the final result now by calling workflow_result exactly once. Do not return prose.", true);
        completeTurn(true, false, true);
      }
      if (!hasResult()) {
        beginTurn(false);
        throwIfTurnPolicyFailed();
        await promptAndRecover("Your result was missing or invalid. Repair it by calling workflow_result exactly once with a schema-valid value.", true);
        completeTurn(true, false, true);
      }
      if (!hasResult()) throw new WorkflowError("RESULT_INVALID", "Agent did not submit a valid workflow_result after one repair");
      await callbacks?.onBeforeComplete?.();
      report(() => createdAdapter.snapshot(true));
      await flushProgress();
      await flushEvents();
      await flushSystemPrompts();
      unsubscribe();
      createdAdapter.dispose();
      adapter = undefined;
      const value = request.resultSchema === undefined ? unstructuredResult(structuredResult) : structuredResult;
      if (value === undefined) throw new WorkflowError("RESULT_INVALID", "Agent did not submit a valid workflow_result after one repair");
      const result: RuntimeAgentRunResult = { value, usage: runtimeUsage(session), reference: { transport: session.reference.transport, ...(session.reference.locator === undefined ? {} : { locator: runtimeValue(session.reference.locator) }) } };
      successfulInvocation = true;
      await callbacks?.onComplete?.(result, session);
      disposeStarted = true;
      await session.dispose();
      session = undefined;
      return result;
    } catch (error) {
      const typed = turnPolicyFailure ?? normalizePiRuntimeError(error, request.signal);
      if (session && sessionReady) {
        const activeSession = session;
        const activeAdapter = adapter;
        report(() => activeAdapter?.snapshot(true) ?? { usage: runtimeUsage(activeSession), toolCalls: [], state: activeSession.getState(), persist: true });
        //NOTE: best-effort telemetry flush during teardown; the agent failure is rethrown after this block, so dropping the flush must not mask the primary error.
        await flushProgress().catch(() => undefined);
        await flushEvents().catch(() => undefined);
        await flushSystemPrompts().catch(() => undefined);
        unsubscribe?.();
        activeAdapter?.dispose();
        adapter = undefined;
        if (!successfulInvocation && !turnPolicyFailure && typed.code !== "BUDGET_EXHAUSTED") {
          try { request.turnPolicy?.afterTurn(runtimeUsage(activeSession), true); }
          catch (budgetFailure) { turnPolicyFailure ??= turnPolicyError(budgetFailure); }
        }
        let callbackFailure: unknown;
        if (!successfulInvocation) {
          try { await callbacks?.onFailure?.(turnPolicyFailure ?? typed, activeSession); }
          catch (failure) { callbackFailure = failure; }
        }
        if (!disposeStarted) {
          await activeSession.dispose().catch(() => undefined);
        }
        if (callbackFailure !== undefined) throw callbackFailure instanceof Error ? callbackFailure : new Error(errorText(callbackFailure));
      }
      throw turnPolicyFailure ?? (error instanceof Error ? error : new Error(errorText(error)));
    }
  }
}

export function createPiRuntimeAgentRunner(options: PiRuntimeAgentRunnerOptions): RuntimeAgentRunner { return new PiRuntimeAgentRunner(options); }

export type { PiRuntimeAgentRunnerCallbacks };
