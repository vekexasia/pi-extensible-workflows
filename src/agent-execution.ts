import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, type AgentSessionEvent, type InlineExtension, type ToolDefinition } from "@earendil-works/pi-coding-agent";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type AgentMessage = { role: string; content?: unknown; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } } };
import type { AgentIdentity, AgentSetupSummary, JsonSchema, JsonValue, ModelSpec, WorkflowRunContext } from "./index.js";
import { resolveModelReference, WorkflowError } from "./index.js";
import type { RunStore } from "./persistence.js";

export interface AgentBudgetHooks {
  beforeAttempt(): void;
  beforeTurn(): void;
  afterTurn(accounting: AgentAccounting, final: boolean): void;
  instruction(): string | undefined;
}
export interface AgentDefinition { prompt?: string; description?: string; model?: string; thinking?: ThinkingLevel; tools?: readonly string[] }
export interface AgentExecutionOptions {
  label: string;
  workflowName: string;
  phase?: string;
  parent?: string;
  model?: string;
  thinking?: ThinkingLevel;
  onProgress?: (progress: AgentProgress) => void | Promise<void>;
  onAttempt?: (attempt: Pick<AgentAttempt, "attempt" | "sessionId" | "sessionFile" | "setup">) => void | Promise<void>;
  tools?: readonly string[];
  effectiveTools?: readonly string[];
  role?: string;
  schema?: JsonSchema;
  retries?: number;
  timeoutMs?: number | null;
  retryState?: string;
  worktreeOwner?: string;
  cwd?: string;
  budget?: AgentBudgetHooks;
  agentOptions?: Readonly<Record<string, JsonValue>>;
  agentIdentity?: AgentIdentity;
}
export interface AgentExecutionRoot {
  cwd: string;
  model: ModelSpec;
  tools: ReadonlySet<string>;
  agentDefinitions?: Readonly<Record<string, AgentDefinition>>;
  agentDir?: string;
  availableModels?: ReadonlySet<string>;
  knownModels?: ReadonlySet<string>;
  modelAliases?: Readonly<Record<string, string>>;
  blockedAliases?: ReadonlySet<string>;
  settingsPath?: string;
  runStore?: RunStore;
  providerPause?: () => Promise<void>;
  agentSetupHooks?: readonly RegisteredAgentSetupHook[];
  runContext?: Readonly<WorkflowRunContext>;
}
export interface AgentAccounting { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export interface AgentToolCallProgress { id: string; name: string; state: "running" | "completed" | "failed" }
export interface AgentActivity { kind: "reasoning" | "tool" | "text"; text: string }
export interface AgentProgress { accounting: AgentAccounting; toolCalls: readonly AgentToolCallProgress[]; activity?: AgentActivity; persist: boolean }
export interface AgentAttempt { attempt: number; sessionId: string; sessionFile: string; result?: JsonValue; error?: { code: string; message: string }; accounting: AgentAccounting; setup?: AgentSetupSummary }
export interface AgentExecutionResult { value: JsonValue; attempts: readonly AgentAttempt[]; cwd: string }
export interface AgentSetup { prompt: string; options: Record<string, JsonValue>; sessionInput: SessionInput; createSession: SessionFactory }
export interface AgentSetupContext { readonly run: Readonly<WorkflowRunContext>; readonly identity: Readonly<AgentIdentity>; readonly attempt: number; readonly signal: AbortSignal }
export interface AgentSetupHook { priority?: number; setup: (agent: AgentSetup, context: Readonly<AgentSetupContext>) => void | Promise<void> }
export interface RegisteredAgentSetupHook { name: string; priority: number; setup: AgentSetupHook["setup"] }
export interface NativeSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly messages: readonly AgentMessage[];
  readonly systemPrompt?: string;
  readonly agent?: { state: { tools: readonly { name: string }[] } };
  subscribe?(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  steer?(text: string): Promise<void>;
  abort?(): Promise<void>;
  dispose(): void;
}
export interface SessionInput { cwd: string; model: ModelSpec; tools: string[]; sessionLabel: string; agentDir?: string; customTools?: ToolDefinition[]; resultTool?: ToolDefinition; systemPromptAppend?: string; extensionFactories?: InlineExtension[]; options?: Record<string, JsonValue> }
export type SessionFactory = (input: SessionInput) => Promise<NativeSession>;

function parseModel(value: string | undefined, fallback: ModelSpec, thinking?: ThinkingLevel, aliases: Readonly<Record<string, string>> = {}, knownModels?: ReadonlySet<string>, settingsPath?: string): ModelSpec {
  if (!value) return { ...fallback, ...(thinking ? { thinking } : {}) };
  const parsed = resolveModelReference(value, aliases, knownModels, settingsPath);
  return { ...parsed, ...(thinking ? { thinking } : !parsed.thinking && fallback.thinking ? { thinking: fallback.thinking } : {}) };
}
function modelCapability(model: ModelSpec): string { return `${model.provider}/${model.model}`; }

function text(messages: readonly AgentMessage[]): string {
  const message = [...messages].reverse().find((item) => item.role === "assistant");
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.filter((part: unknown): part is { type: "text"; text: string } => typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string").map((part) => part.text).join("");
}

function hasToolCall(message: unknown): boolean {
  return typeof message === "object" && message !== null && Array.isArray((message as { content?: unknown }).content) && (message as { content: unknown[] }).content.some((part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "toolCall");
}

function latestAssistantHasToolCall(messages: readonly AgentMessage[]): boolean {
  const message = [...messages].reverse().find((item) => item.role === "assistant");
  return hasToolCall(message);
}

function accounting(messages: readonly AgentMessage[]): AgentAccounting {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const message of messages) if (message.role === "assistant" && message.usage) {
    total.input += typeof message.usage.input === "number" && Number.isFinite(message.usage.input) ? message.usage.input : 0;
    total.output += typeof message.usage.output === "number" && Number.isFinite(message.usage.output) ? message.usage.output : 0;
    total.cacheRead += typeof message.usage.cacheRead === "number" && Number.isFinite(message.usage.cacheRead) ? message.usage.cacheRead : 0;
    total.cacheWrite += typeof message.usage.cacheWrite === "number" && Number.isFinite(message.usage.cacheWrite) ? message.usage.cacheWrite : 0;
    total.cost += typeof message.usage.cost.total === "number" && Number.isFinite(message.usage.cost.total) ? message.usage.cost.total : 0;
  }
  return total;
}

export async function createNativeAgentSession(input: SessionInput): Promise<NativeSession> {
  const agentDir = input.agentDir ?? getAgentDir();
  const manager = input.agentDir ? SessionManager.create(input.cwd, join(agentDir, "sessions")) : SessionManager.create(input.cwd);
  manager.appendSessionInfo(input.sessionLabel);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const model = modelRuntime.getModel(input.model.provider, input.model.model);
  if (!model) throw new WorkflowError("UNKNOWN_MODEL", `Unknown model: ${input.model.provider}/${input.model.model}`);
  const customTools = [...(input.customTools ?? []), ...(input.resultTool ? [input.resultTool] : [])];
  const tools = [...new Set([...input.tools, ...customTools.map(({ name }) => name)])];
  const resourceLoader = input.systemPromptAppend || input.extensionFactories?.length ? new DefaultResourceLoader({ cwd: input.cwd, agentDir, ...(input.extensionFactories?.length ? { extensionFactories: input.extensionFactories } : {}), ...(input.systemPromptAppend ? { appendSystemPromptOverride: (base) => [...base, input.systemPromptAppend ?? ""] } : {}) }) : undefined;
  if (resourceLoader) await resourceLoader.reload();
  const { session } = await createAgentSession({ ...(input.options ?? {}), cwd: input.cwd, agentDir, modelRuntime, model, ...(input.model.thinking ? { thinkingLevel: input.model.thinking } : {}), tools, ...(customTools.length ? { customTools } : {}), ...(input.extensionFactories?.length ? { extensionFactories: input.extensionFactories } : {}), ...(resourceLoader ? { resourceLoader } : {}), sessionManager: manager });
  return session;
}
function changedOption(options: Readonly<Record<string, JsonValue>>, baseline: Readonly<Record<string, JsonValue>>, key: string): boolean { return JSON.stringify(options[key]) !== JSON.stringify(baseline[key]); }
function validThinking(value: unknown): value is ThinkingLevel { return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value); }
function fallbackSetupContext(root: AgentExecutionRoot, options: AgentExecutionOptions, signal: AbortSignal): { run: Readonly<WorkflowRunContext>; identity: Readonly<AgentIdentity> } {
  const identity = options.agentIdentity ?? { structuralPath: [], callSite: options.label, occurrence: 1 };
  const run = root.runContext ?? Object.freeze({ cwd: root.cwd, sessionId: "", runId: "", workflow: Object.freeze({ name: options.workflowName }), args: null, signal });
  return { run, identity: Object.freeze({ ...identity, structuralPath: Object.freeze([...identity.structuralPath]) }) };
}
async function prepareAgentSetup(root: AgentExecutionRoot, createSession: SessionFactory, task: string, options: AgentExecutionOptions, resolved: { model: ModelSpec; tools: readonly string[]; systemPromptAppend: string }, cwd: string, attempt: number, signal: AbortSignal | undefined, customTools: readonly ToolDefinition[], resultTool: ToolDefinition | undefined): Promise<{ setup: AgentSetup; summary: AgentSetupSummary }> {
  const setupSignal = signal ?? root.runContext?.signal ?? new AbortController().signal;
  const baselineOptions = structuredClone(options.agentOptions ?? {});
  const sessionInput: SessionInput = { cwd, model: { ...resolved.model }, tools: [...resolved.tools], sessionLabel: `${options.workflowName}:${options.label}:attempt-${String(attempt)}`, ...(root.agentDir ? { agentDir: root.agentDir } : {}), ...(customTools.length ? { customTools: [...customTools] } : {}), ...(resultTool ? { resultTool } : {}), systemPromptAppend: resolved.systemPromptAppend, options: structuredClone(baselineOptions) };
  const setup: AgentSetup = { prompt: task, options: sessionInput.options ?? {}, sessionInput, createSession };
  const base = fallbackSetupContext(root, options, setupSignal);
  const context = Object.freeze({ run: base.run, identity: base.identity, attempt, signal: setupSignal });
  const hookNames: string[] = [];
  for (const hook of [...(root.agentSetupHooks ?? [])].sort((left, right) => left.priority - right.priority || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    if (setupSignal.aborted) throw new WorkflowError("CANCELLED", "Agent cancelled");
    try { await hook.setup(setup, context); } catch (error) { if (setupSignal.reason !== undefined) throw new WorkflowError("CANCELLED", "Agent cancelled"); throw error; }
    hookNames.push(hook.name);
    if (setupSignal.reason !== undefined) throw new WorkflowError("CANCELLED", "Agent cancelled");
  }
  setup.sessionInput.options = setup.options;
  if (changedOption(setup.options, baselineOptions, "model") && typeof setup.options.model === "string") setup.sessionInput.model = parseModel(setup.options.model, setup.sessionInput.model, validThinking(setup.options.thinking) ? setup.options.thinking : setup.sessionInput.model.thinking);
  if (changedOption(setup.options, baselineOptions, "thinking") && validThinking(setup.options.thinking)) setup.sessionInput.model = { ...setup.sessionInput.model, thinking: setup.options.thinking };
  if (changedOption(setup.options, baselineOptions, "tools") && Array.isArray(setup.options.tools) && setup.options.tools.every((tool) => typeof tool === "string")) setup.sessionInput.tools = [...setup.options.tools];
  if (changedOption(setup.options, baselineOptions, "cwd") && typeof setup.options.cwd === "string") setup.sessionInput.cwd = setup.options.cwd;
  const model = setup.sessionInput.model;
  const summary: AgentSetupSummary = { hookNames: [...hookNames], model: { provider: model.provider, model: model.model, ...(model.thinking ? { thinking: model.thinking } : {}) }, tools: [...setup.sessionInput.tools], cwd: setup.sessionInput.cwd };
  return { setup, summary };
}

export class WorkflowAgentExecutor {
  constructor(private readonly root: AgentExecutionRoot, private readonly createSession: SessionFactory = createNativeAgentSession) {}
  setRunContext(runContext: Readonly<WorkflowRunContext>): void { this.root.runContext = runContext; }

  resolve(options: AgentExecutionOptions, inheritedTools?: readonly string[]): { model: ModelSpec; requestedModel?: string; tools: readonly string[]; systemPromptAppend: string } {
    const role = options.role;
    const definition = role ? this.root.agentDefinitions?.[role] : undefined;
    if (role && !definition) throw new WorkflowError("UNKNOWN_AGENT_TYPE", `Unknown agent role: ${role}`);
    if (role && (options.model !== undefined || options.thinking !== undefined || options.tools !== undefined)) throw new WorkflowError("INVALID_METADATA", "Role agents must not specify model, thinking, or tools");
    const requested = options.tools !== undefined ? options.tools : definition?.tools !== undefined ? definition.tools : options.effectiveTools !== undefined ? options.effectiveTools : inheritedTools !== undefined ? inheritedTools : [...this.root.tools];
    const forbidden = requested.find((tool) => !this.root.tools.has(tool));
    if (forbidden) throw new WorkflowError("UNKNOWN_TOOL", `Tool is outside the launching session boundary: ${forbidden}`);
    const requestedModel = options.model ?? definition?.model;
    const hasAlias = requestedModel !== undefined && Object.prototype.hasOwnProperty.call(this.root.modelAliases ?? {}, requestedModel);
    if (requestedModel !== undefined && this.root.blockedAliases?.has(requestedModel) && !hasAlias) throw new WorkflowError("UNKNOWN_MODEL", `Unknown model alias ${requestedModel}${this.root.settingsPath ? ` (settings: ${this.root.settingsPath})` : ""}`);
    const model = parseModel(requestedModel, this.root.model, options.thinking ?? definition?.thinking, this.root.modelAliases, this.root.knownModels ?? this.root.availableModels, this.root.settingsPath);
    const availableModels = this.root.knownModels ?? this.root.availableModels ?? new Set([modelCapability(this.root.model)]);
    if (!availableModels.has(modelCapability(model))) throw new WorkflowError("UNKNOWN_MODEL", `Unknown model${requestedModel ? ` ${requestedModel} resolved to ${modelCapability(model)}` : ""}${this.root.settingsPath ? ` (settings: ${this.root.settingsPath})` : ""}`);
    return { model, ...(hasAlias ? { requestedModel } : {}), tools: [...requested], systemPromptAppend: definition?.prompt ?? "" };
  }

  async execute(task: string, options: AgentExecutionOptions, signal?: AbortSignal, customTools: readonly ToolDefinition[] = [], setSteer?: (handler: (message: string) => void | Promise<void>) => void, beforeRetry?: () => void): Promise<AgentExecutionResult> {
    const executionSignal = signal ?? this.root.runContext?.signal;
    if (!Number.isInteger(options.retries ?? 0) || (options.retries ?? 0) < 0) throw new WorkflowError("INVALID_METADATA", "retries must be a non-negative integer");
    if (options.timeoutMs !== undefined && options.timeoutMs !== null && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)) throw new WorkflowError("INVALID_METADATA", "timeoutMs must be null or a positive integer");
    const resolved = this.resolve(options);
    let cwd: string;
    if (options.parent) {
      if (!options.cwd) throw new WorkflowError("INVALID_METADATA", "Child agents require their parent cwd");
      if (options.worktreeOwner) {
        if (!this.root.runStore) throw new WorkflowError("WORKTREE_FAILED", "Worktree inheritance requires a persisted run");
        cwd = (await this.root.runStore.validateWorktree(options.worktreeOwner, options.cwd)).cwd;
      } else {
        if (options.cwd !== this.root.cwd) throw new WorkflowError("INVALID_METADATA", "Shared-tree children must inherit the root cwd");
        cwd = this.root.cwd;
      }
    } else if (options.worktreeOwner) {
      if (!this.root.runStore) throw new WorkflowError("WORKTREE_FAILED", "Worktree scope requires a persisted run");
      const worktree = await this.root.runStore.worktree(options.worktreeOwner);
      if (options.cwd && resolvePath(options.cwd) !== resolvePath(worktree.cwd)) throw new WorkflowError("WORKTREE_FAILED", "Agent cwd does not match its owned worktree");
      cwd = worktree.cwd;
    } else {
      if (options.cwd) throw new WorkflowError("INVALID_METADATA", "Only child agents or worktree scopes may provide a cwd");
      cwd = this.root.cwd;
    }
    const attempts: AgentAttempt[] = [];
    const maxAttempts = (options.retries ?? 0) + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      options.budget?.beforeAttempt();
      let accepted = false;
      let schemaResult: JsonValue | undefined;
      let session: NativeSession | undefined;
      let setup: AgentSetup | undefined;
      let setupSummary: AgentSetupSummary | undefined;
      let setupFailed = false;
      let budgetError: WorkflowError | undefined;
      let turnStarted = false;
      const hasSchemaResult = () => schemaResult !== undefined;
      const resultTool = options.schema ? {
        name: "workflow_result", label: "Workflow Result", description: "Submit the terminal structured workflow result", parameters: Type.Unsafe(options.schema),
        async execute(_id: string, value: unknown) {
          if (!accepted) return { content: [{ type: "text" as const, text: "Result acceptance is not enabled yet." }], details: {}, isError: true };
          if (!Value.Check(options.schema as object, value)) return { content: [{ type: "text" as const, text: "Result does not match the required schema." }], details: {}, isError: true };
          schemaResult = structuredClone(value) as JsonValue;
          void session?.abort?.();
          return { content: [{ type: "text" as const, text: "Result accepted." }], details: {} };
        },
      } as ToolDefinition : undefined;
      const toolCalls = new Map<string, AgentToolCallProgress>();
      let activity: AgentActivity | undefined;
      let progress = Promise.resolve();
      let unsubscribe: (() => void) | undefined;
      let systemPromptTurn = 0;
      let systemPromptWrite = Promise.resolve();
      let systemPromptWriteError: unknown;
      const flushSystemPrompts = async () => {
        await systemPromptWrite;
        if (systemPromptWriteError) throw new WorkflowError("INTERNAL_ERROR", `Failed to persist effective system prompt: ${systemPromptWriteError instanceof Error ? systemPromptWriteError.message : typeof systemPromptWriteError === "string" ? systemPromptWriteError : "unknown error"}`);
      };
      const report = (persist: boolean) => {
        if (!session || !options.onProgress) return;
        const update = { accounting: accounting(session.messages), toolCalls: [...toolCalls.values()], ...(activity ? { activity } : {}), persist };
        progress = progress.then(() => options.onProgress?.(update)).then(() => undefined);
      };
      try {
        setupFailed = true;
        const prepared = await prepareAgentSetup(this.root, this.createSession, task, options, resolved, cwd, attempt, executionSignal, customTools, resultTool);
        setup = prepared.setup;
        setupSummary = prepared.summary;
        setupFailed = false;
        if (executionSignal?.aborted) throw new WorkflowError("CANCELLED", "Agent cancelled");
        const started = Date.now();
        session = await setup.createSession(setup.sessionInput);
        await options.onAttempt?.({ attempt, sessionId: session.sessionId, sessionFile: requiredFile(session.sessionFile), ...(this.root.agentSetupHooks?.length ? { setup: setupSummary } : {}) });
        unsubscribe = session.subscribe?.((event) => {
          if (event.type === "agent_start" && session?.systemPrompt !== undefined && this.root.runStore) {
            systemPromptTurn += 1;
            const entry = { sessionId: session.sessionId, attempt, turn: systemPromptTurn, prompt: session.systemPrompt };
            systemPromptWrite = systemPromptWrite.then(() => this.root.runStore?.recordSystemPrompt(entry)).then(() => undefined).catch((error: unknown) => { systemPromptWriteError ??= error; });
          }
          if (event.type === "message_start" && event.message.role === "assistant") {
            if (!turnStarted) { try { options.budget?.beforeTurn(); turnStarted = true; } catch (error) { budgetError ??= error instanceof WorkflowError ? error : new WorkflowError("BUDGET_EXHAUSTED", error instanceof Error ? error.message : String(error)); void session?.abort?.(); } }
            activity = { kind: "text", text: "responding" }; report(false);
          }
          if (event.type === "message_end") {
            activity = undefined;
            if (event.message.role === "assistant") {
              const needsMoreWork = hasToolCall(event.message);
              const final = !needsMoreWork || (options.schema !== undefined && accepted);
              if (!budgetError) { try { options.budget?.afterTurn(accounting(session?.messages ?? []), final); if (!final) { const instruction = options.budget?.instruction(); if (instruction) void session?.steer?.(instruction); } } catch (error) { budgetError ??= error instanceof WorkflowError ? error : new WorkflowError("BUDGET_EXHAUSTED", error instanceof Error ? error.message : String(error)); void session?.abort?.(); } }
              turnStarted = false;
              report(true);
            }
          }
          if (event.type === "tool_execution_start") { toolCalls.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, state: "running" }); activity = { kind: "tool", text: event.toolName }; report(false); }
          if (event.type === "tool_execution_end") { toolCalls.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, state: event.isError ? "failed" : "completed" }); if (activity?.kind === "tool" && activity.text === event.toolName) activity = undefined; report(false); }
        });
        report(false);
        if (setSteer) {
          if (!session.steer) throw new WorkflowError("INTERNAL_ERROR", "Native Pi session does not support steering");
          setSteer((message) => session?.steer?.(message));
        }
        const context = [`Workflow: ${options.workflowName}`, `Agent: ${options.label}`, options.phase ? `Phase: ${options.phase}` : "", options.parent ? `Parent: ${options.parent}` : "", "You own this task and any direct child agents you create. Return child results to your parent; do not leave descendants running.", attempt > 1 ? `Retry attempt ${String(attempt)}. Previous state: ${options.retryState ?? attempts.at(-1)?.error?.message ?? "failed attempt"}` : ""].filter(Boolean).join("\n");
        const instruction = options.budget?.instruction();
        const promptText = `${context}\n\nTask:\n${setup.prompt}${instruction ? `\n\n${instruction}` : ""}`;
        options.budget?.beforeTurn();
        turnStarted = true;
        await promptWithProviderPause(session, promptText, remaining(options.timeoutMs, started), executionSignal, this.root.providerPause);
        { const completedAccounting = accounting(session.messages); options.budget?.afterTurn(completedAccounting, options.schema !== undefined ? false : !latestAssistantHasToolCall(session.messages)); turnStarted = false; }
        if (budgetError) throw budgetError;
        if (options.schema) {
          accepted = true;
          try { options.budget?.beforeTurn(); turnStarted = true; await promptWithProviderPause(session, "Submit the final result now by calling workflow_result exactly once. Do not return prose.", remaining(options.timeoutMs, started), executionSignal, this.root.providerPause); { const completedAccounting = accounting(session.messages); options.budget?.afterTurn(completedAccounting, true); turnStarted = false; } } catch (error) { if (!hasSchemaResult()) throw error; }
          if (!hasSchemaResult()) {
            try { options.budget?.beforeTurn(); turnStarted = true; await promptWithProviderPause(session, "Your result was missing or invalid. Repair it by calling workflow_result exactly once with a schema-valid value.", remaining(options.timeoutMs, started), executionSignal, this.root.providerPause); { const completedAccounting = accounting(session.messages); options.budget?.afterTurn(completedAccounting, true); turnStarted = false; } } catch (error) { if (!hasSchemaResult()) throw error; }
          }
          if (schemaResult === undefined) throw new WorkflowError("RESULT_INVALID", "Agent did not submit a valid workflow_result after one repair");
        }
        const value = options.schema ? schemaResult as JsonValue : text(session.messages);
        if (options.worktreeOwner) await this.root.runStore?.snapshotWorktree(options.worktreeOwner);
        report(true);
        await progress;
        await flushSystemPrompts();
        unsubscribe?.();
        const attemptAccounting = accounting(session.messages);
        attempts.push({ attempt, sessionId: session.sessionId, sessionFile: requiredFile(session.sessionFile), result: value, accounting: attemptAccounting, ...(this.root.agentSetupHooks?.length ? { setup: setupSummary } : {}) });
        session.dispose();
        return { value, attempts, cwd: setupSummary.cwd };
      } catch (error) {
        const typed = budgetError ?? (error instanceof WorkflowError ? error : new WorkflowError(executionSignal?.aborted && setupFailed ? "CANCELLED" : "AGENT_FAILED", error instanceof Error ? error.message : String(error)));
        if (session) {
          report(true);
          await progress;
          try { await flushSystemPrompts(); } catch { /* Preserve the agent failure that prompted this cleanup. */ }
          unsubscribe?.();
          const attemptAccounting = accounting(session.messages);
          if (!budgetError && typed.code !== "BUDGET_EXHAUSTED") { try { options.budget?.afterTurn(attemptAccounting, true); } catch (budgetFailure) { budgetError ??= budgetFailure instanceof WorkflowError ? budgetFailure : new WorkflowError("BUDGET_EXHAUSTED", budgetFailure instanceof Error ? budgetFailure.message : String(budgetFailure)); } }
          attempts.push({ attempt, sessionId: session.sessionId, sessionFile: requiredFile(session.sessionFile), error: { code: typed.code, message: typed.message }, accounting: attemptAccounting, ...(this.root.agentSetupHooks?.length && setupSummary ? { setup: setupSummary } : {}) });
          session.dispose();
        }
        if (options.worktreeOwner && typed.code !== "WORKTREE_FAILED") await this.root.runStore?.snapshotWorktree(options.worktreeOwner).catch(() => undefined);
        if (attempt === maxAttempts || setupFailed || typed.code === "CANCELLED" || typed.code === "WORKTREE_FAILED") throw Object.assign(typed, { attempts });
        beforeRetry?.();
      }
    }
    throw new WorkflowError("AGENT_FAILED", "Agent execution failed");
  }
}

export interface ScheduledAgentOptions {
  label: string;
  requestedLabel?: string;
  parentBreadcrumb?: string;
  cwd: string;
  tools: readonly string[];
  worktreeOwner?: string;
  model?: string;
  thinking?: ThinkingLevel;
  role?: string;
  schema?: JsonSchema;
  retries?: number;
  timeoutMs?: number | null;
  agentOptions?: Readonly<Record<string, JsonValue>>;
  agentIdentity?: AgentIdentity;
}

export type ScheduledAgentResult =
  | { id: string; ok: true; value: JsonValue }
  | { id: string; ok: false; error: { code: string; message: string } };

export interface ScheduledAgentInput {
  id: string;
  runId: string;
  parentId?: string;
  prompt: string;
  options: Readonly<ScheduledAgentOptions>;
  signal: AbortSignal;
  setSteer: (handler: (message: string) => void | Promise<void>) => void;
}

export type ScheduledAgentRunner = (input: ScheduledAgentInput) => Promise<JsonValue>;

type ScheduledNode = {
  id: string;
  runId: string;
  parentId?: string;
  options: Readonly<ScheduledAgentOptions>;
  children: Set<string>;
  collected: boolean;
  state: "queued" | "running" | "waiting_for_child" | "completed" | "failed" | "cancelled";
  controller: AbortController;
  promise: Promise<ScheduledAgentResult>;
  resolve: (result: ScheduledAgentResult) => void;
  task: () => Promise<void>;
  restored: boolean;
  steer?: (message: string) => void | Promise<void>;
};

type ScheduledRun = { limit: number; beforeLaunch?: () => void; logical: number; active: number; queue: Array<{ node?: ScheduledNode; start: () => void }> };
export type OwnershipRecord = { id: string; parentId?: string; label: string; state: ScheduledNode["state"]; options: Readonly<ScheduledAgentOptions> };
type OwnershipWriter = (runId: string, ownership: readonly OwnershipRecord[]) => void | Promise<void>;

export class FairAgentScheduler {
  readonly #runs = new Map<string, ScheduledRun>();
  readonly #nodes = new Map<string, ScheduledNode>();
  #runOrder: string[] = [];
  #cursor = 0;
  #active = 0;
  #nextId = 0;
  #persistence = Promise.resolve();

  constructor(private readonly runner: ScheduledAgentRunner, readonly sessionLimit = 16, private readonly writeOwnership?: OwnershipWriter) {
    if (!Number.isInteger(sessionLimit) || sessionLimit < 1 || sessionLimit > 16) throw new WorkflowError("INVALID_SETTINGS", "Session concurrency must be an integer from 1 to 16");
  }

  addRun(runId: string, limit = 8, beforeLaunch?: () => void): void {
    if (this.#runs.has(runId)) throw new WorkflowError("DUPLICATE_NAME", `Scheduler run already exists: ${runId}`);
    if (!Number.isInteger(limit) || limit < 1 || limit > this.sessionLimit) throw new WorkflowError("INVALID_SETTINGS", "Invalid run concurrency");
    this.#runs.set(runId, { limit, ...(beforeLaunch ? { beforeLaunch } : {}), logical: 0, active: 0, queue: [] });
    this.#runOrder.push(runId);
  }

  spawn(runId: string, prompt: string, options: ScheduledAgentOptions, parentId?: string): { id: string; result: Promise<ScheduledAgentResult> } {
    const run = this.#runs.get(runId);
    if (!run) throw new WorkflowError("INTERNAL_ERROR", `Unknown scheduler run: ${runId}`);
    const parent = parentId ? this.#nodes.get(parentId) : undefined;
    if (parentId && (!parent || parent.runId !== runId)) throw new WorkflowError("UNKNOWN_AGENT_TYPE", "Parent agent is not owned by this run");
    const effective = this.#inherit(parent, options);
    const id = `${runId}:${String(++this.#nextId)}`;
    let resolveResult: (result: ScheduledAgentResult) => void = () => undefined;
    const promise = new Promise<ScheduledAgentResult>((resolve) => { resolveResult = resolve; });
    const node: ScheduledNode = { id, runId, ...(parentId ? { parentId } : {}), options: effective, children: new Set<string>(), collected: false, state: "queued", controller: new AbortController(), promise, resolve: resolveResult, task: async () => undefined, restored: false };
    node.task = async () => {
      if (node.controller.signal.aborted) { this.#release(node.runId); return; }
      node.state = "running";
      this.#persist(runId);
      try {
        const value = await this.runner({ id, runId, ...(parentId ? { parentId } : {}), prompt, options: effective, signal: node.controller.signal, setSteer: (handler) => { node.steer = handler; } });
        this.#settle(node, { id, ok: true, value });
      } catch (error) {
        const typed = error instanceof WorkflowError ? error : new WorkflowError("AGENT_FAILED", error instanceof Error ? error.message : String(error));
        this.#settle(node, { id, ok: false, error: { code: typed.code, message: typed.message } });
      }
    };
    this.#nodes.set(id, node);
    parent?.children.add(id);
    this.#persist(runId);
    this.#enqueue(runId, node, () => { void node.task(); });
    return { id, result: promise };
  }

  async result(parentId: string, childId: string): Promise<ScheduledAgentResult> {
    const parent = this.#node(parentId);
    const child = this.#node(childId);
    if (child.parentId !== parentId) throw new WorkflowError("UNKNOWN_AGENT_TYPE", "Results are scoped to direct children");
    child.collected = true;
    parent.state = "waiting_for_child";
    this.#persist(parent.runId);
    this.#release(parent.runId);
    const outcome = await child.promise;
    await new Promise<void>((resolve) => { this.#enqueue(parent.runId, undefined, () => { resolve(); }); });
    parent.state = "running";
    if (parent.controller.signal.aborted) throw new WorkflowError("CANCELLED", "Parent agent cancelled");
    this.#persist(parent.runId);
    return outcome;
  }

  async steer(parentId: string, childId: string, message: string): Promise<void> {
    const child = this.#node(childId);
    if (child.parentId !== parentId) throw new WorkflowError("UNKNOWN_AGENT_TYPE", "Steering is scoped to direct children");
    if (child.state !== "running" && child.state !== "waiting_for_child") throw new WorkflowError("AGENT_FAILED", "Child is not running");
    if (!child.steer) throw new WorkflowError("AGENT_FAILED", "Child has not registered a steering handler");
    await child.steer(message);
  }

  cancel(id: string): void { this.#cancelTree(this.#node(id)); }

  cancelChildren(id: string): void {
    for (const childId of this.#node(id).children) { const child = this.#nodes.get(childId); if (child) this.#cancelTree(child); }
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run) throw new WorkflowError("INTERNAL_ERROR", `Unknown scheduler run: ${runId}`);
    const nodes = [...this.#nodes.values()].filter((node) => node.runId === runId);
    for (const node of nodes) if (!node.parentId) this.#cancelTree(node);
    await Promise.all(nodes.map(({ promise }) => promise));
    if (nodes.every(({ restored }) => restored)) run.logical = 0;
  }

  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/restrict-template-expressions */
  toolsFor(parentId: string, resolveTools?: (role: string | undefined, tools: readonly string[] | undefined, model: string | undefined, inheritedTools: readonly string[], thinking: ThinkingLevel | undefined) => readonly string[]): ToolDefinition[] {
    const parent = this.#node(parentId);
    if (!parent.options.tools.includes("agent")) return [];
    const agentTool = {
      name: "agent", label: "Child Agent", description: "Start a direct child agent",
      parameters: Type.Object({ prompt: Type.String(), label: Type.String(), tools: Type.Optional(Type.Array(Type.String())), model: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()), role: Type.Optional(Type.String()), outputSchema: Type.Optional(Type.Unsafe<JsonSchema>({})), retries: Type.Optional(Type.Integer({ minimum: 0 })), timeoutMs: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])) }, { additionalProperties: true }),
      execute: async (_id: string, params: { prompt: string; label: string; tools?: string[]; model?: string; thinking?: ThinkingLevel; role?: string; outputSchema?: JsonSchema; retries?: number; timeoutMs?: number | null; [key: string]: unknown }) => {
        if (params.role !== undefined && (params.model !== undefined || params.thinking !== undefined || params.tools !== undefined)) throw new WorkflowError("INVALID_METADATA", "Role agents must not specify model, thinking, or tools");
        const tools = (params.tools !== undefined || params.role !== undefined ? resolveTools?.(params.role, params.tools, params.model, parent.options.tools, params.thinking) : undefined) ?? params.tools ?? parent.options.tools;
        const agentOptions = Object.fromEntries(Object.entries(params).filter(([key]) => key !== "prompt")) as Record<string, JsonValue>;
        const options: ScheduledAgentOptions = { label: params.label, requestedLabel: params.label, cwd: parent.options.cwd, tools, agentOptions, ...(params.model ? { model: params.model } : {}), ...(params.thinking ? { thinking: params.thinking } : {}), ...(params.role ? { role: params.role } : {}), ...(params.outputSchema ? { schema: params.outputSchema } : {}), ...(params.retries === undefined ? {} : { retries: params.retries }), ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }) };
        const child = this.spawn(parent.runId, params.prompt, options, parentId);
        return { content: [{ type: "text" as const, text: JSON.stringify({ id: child.id }) }], details: { id: child.id } };
      },
    } as ToolDefinition;
    const resultTool = {
      name: "get_subagent_result", label: "Child Result", description: "Wait for a direct child and return its result",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id: string, params: { id: string }) => { const value = await this.result(parentId, params.id); if (!value.ok && value.error.code === "BUDGET_EXHAUSTED") throw new WorkflowError("BUDGET_EXHAUSTED", value.error.message); return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value }; },
    } as ToolDefinition;
    const steerTool = {
      name: "steer_subagent", label: "Steer Child", description: "Steer a running direct child",
      parameters: Type.Object({ id: Type.String(), message: Type.String() }),
      execute: async (_id: string, params: { id: string; message: string }) => { await this.steer(parentId, params.id, params.message); return { content: [{ type: "text" as const, text: "Steering delivered." }], details: {} }; },
    } as ToolDefinition;
    return [agentTool, resultTool, steerTool];
  }

  snapshot(): readonly OwnershipRecord[] {
    return [...this.#nodes.values()].map(({ id, parentId, options, state }) => ({ id, ...(parentId ? { parentId } : {}), label: options.label, state, options }));
  }

  restoreRun(runId: string, limit: number, ownership: readonly OwnershipRecord[], beforeLaunch?: () => void): void {
    this.addRun(runId, limit, beforeLaunch);
    const run = this.#runs.get(runId) as ScheduledRun;
    for (const record of ownership) {
      if (record.id.split(":").slice(0, -1).join(":") !== runId) throw new WorkflowError("RESUME_INCOMPATIBLE", `Persisted agent belongs to another run: ${record.id}`);
      let resolveResult: (result: ScheduledAgentResult) => void = () => undefined;
      const promise = new Promise<ScheduledAgentResult>((resolve) => { resolveResult = resolve; });
      const node: ScheduledNode = { id: record.id, runId, ...(record.parentId ? { parentId: record.parentId } : {}), options: this.#inherit(undefined, record.options), children: new Set(), collected: false, state: record.state, controller: new AbortController(), promise, resolve: resolveResult, task: async () => undefined, restored: true };
      this.#nodes.set(node.id, node);
      run.logical += 1;
      this.#nextId = Math.max(this.#nextId, Number(node.id.slice(node.id.lastIndexOf(":") + 1)) || 0);
      if (record.state === "completed") resolveResult({ id: node.id, ok: true, value: null });
      else if (record.state === "failed" || record.state === "cancelled") resolveResult({ id: node.id, ok: false, error: { code: record.state === "cancelled" ? "CANCELLED" : "AGENT_FAILED", message: `Persisted agent ${record.state}` } });
    }
    for (const node of this.#nodes.values()) if (node.runId === runId && node.parentId) this.#nodes.get(node.parentId)?.children.add(node.id);
  }

  async flush(): Promise<void> { await this.#persistence; }

  #inherit(parent: ScheduledNode | undefined, options: ScheduledAgentOptions): Readonly<ScheduledAgentOptions> {
    if (!options.label.trim() || !options.cwd || !Array.isArray(options.tools)) throw new WorkflowError("INVALID_METADATA", "Agents require label, cwd, and tools");
    if (!parent) return Object.freeze({ ...options, tools: Object.freeze([...options.tools]), ...(options.agentOptions ? { agentOptions: structuredClone(options.agentOptions) } : {}) });
    if (options.cwd !== parent.options.cwd) throw new WorkflowError("UNKNOWN_TOOL", "Child cwd cannot differ from its parent");
    const forbidden = options.tools.find((tool) => !parent.options.tools.includes(tool));
    if (forbidden) throw new WorkflowError("UNKNOWN_TOOL", `Child tool escalates parent boundary: ${forbidden}`);
    return Object.freeze({ ...options, cwd: parent.options.cwd, tools: Object.freeze([...options.tools]), ...(options.agentOptions ? { agentOptions: structuredClone(options.agentOptions) } : {}), ...(parent.options.worktreeOwner ? { worktreeOwner: parent.options.worktreeOwner } : {}) });
  }
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/restrict-template-expressions */

  #enqueue(runId: string, node: ScheduledNode | undefined, start: () => void): void { this.#runs.get(runId)?.queue.push({ ...(node ? { node } : {}), start }); this.#dispatch(); }

  #dispatch(): void {
    while (this.#active < this.sessionLimit && this.#runOrder.length) {
      let selected: string | undefined;
      for (let checked = 0; checked < this.#runOrder.length; checked += 1) {
        const index = (this.#cursor + checked) % this.#runOrder.length;
        const id = this.#runOrder[index];
        const run = id ? this.#runs.get(id) : undefined;
        if (id && run && run.active < run.limit && run.queue.length) { selected = id; this.#cursor = (index + 1) % this.#runOrder.length; break; }
      }
      if (!selected) return;
      const run = this.#runs.get(selected) as ScheduledRun;
      const item = run.queue.shift() as { node?: ScheduledNode; start: () => void };
      if (item.node) {
        try { run.beforeLaunch?.(); }
        catch (error) { const typed = error instanceof WorkflowError ? error : new WorkflowError("AGENT_FAILED", error instanceof Error ? error.message : String(error)); this.#settle(item.node, { id: item.node.id, ok: false, error: { code: typed.code, message: typed.message } }); continue; }
      }
      run.active += 1; this.#active += 1; item.start();
    }
  }

  #release(runId: string): void {
    const run = this.#runs.get(runId);
    if (run && run.active > 0) { run.active -= 1; this.#active -= 1; this.#dispatch(); }
  }

  #settle(node: ScheduledNode, result: ScheduledAgentResult): void {
    if (["completed", "failed", "cancelled"].includes(node.state)) return;
    const heldPermit = node.state === "running";
    node.state = result.ok ? "completed" : result.error.code === "CANCELLED" ? "cancelled" : "failed";
    this.#persist(node.runId);
    if (heldPermit) this.#release(node.runId);
    for (const childId of node.children) { const child = this.#nodes.get(childId); if (child && !child.collected) this.#cancelTree(child); }
    node.resolve(result);
  }

  #cancelTree(node: ScheduledNode): void {
    if (["completed", "failed", "cancelled"].includes(node.state)) return;
    node.controller.abort();
    for (const childId of node.children) { const child = this.#nodes.get(childId); if (child) this.#cancelTree(child); }
    if (node.state === "queued" || node.restored) this.#settle(node, { id: node.id, ok: false, error: { code: "CANCELLED", message: "Agent cancelled" } });
  }

  #node(id: string): ScheduledNode {
    const node = this.#nodes.get(id);
    if (!node) throw new WorkflowError("UNKNOWN_AGENT_TYPE", `Unknown owned agent: ${id}`);
    return node;
  }

  #persist(runId: string): void {
    if (!this.writeOwnership) return;
    const ownership = this.snapshot().filter(({ id }) => id.startsWith(`${runId}:`));
    this.#persistence = this.#persistence.then(() => this.writeOwnership?.(runId, ownership)).then(() => undefined);
  }
}

function resolvePath(path: string): string { return path.replace(/[\\/]+$/, ""); }

function requiredFile(file: string | undefined): string {
  if (!file) throw new WorkflowError("INTERNAL_ERROR", "Workflow agents require persisted native Pi sessions");
  return file;
}

function remaining(timeoutMs: number | null | undefined, started: number): number | null | undefined {
  return timeoutMs === null || timeoutMs === undefined ? timeoutMs : Math.max(1, timeoutMs - (Date.now() - started));
}

function providerLimited(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 429 || candidate.code === 429 || candidate.code === "rate_limit_exceeded" || candidate.code === "RATE_LIMITED";
}

async function promptWithProviderPause(session: NativeSession, text: string, timeoutMs: number | null | undefined, signal: AbortSignal | undefined, pause?: () => Promise<void>): Promise<void> {
  for (;;) {
    try { await withTimeout(session.prompt(text), timeoutMs, signal, session); return; }
    catch (error) { if (!pause || !providerLimited(error)) throw error; await pause(); }
  }
}

async function withTimeout(work: Promise<void>, timeoutMs: number | null | undefined, signal: AbortSignal | undefined, session: NativeSession): Promise<void> {
  if (signal?.aborted) throw new WorkflowError("CANCELLED", "Agent cancelled");
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const state = { interrupted: false };
  const timeout = timeoutMs ? new Promise<never>((_, reject) => { timer = setTimeout(() => { state.interrupted = true; reject(new WorkflowError("AGENT_TIMEOUT", "Agent attempt timed out")); }, timeoutMs); }) : new Promise<never>(() => {});
  const cancelled = signal ? new Promise<never>((_, reject) => { abort = () => { state.interrupted = true; reject(new WorkflowError("CANCELLED", "Agent cancelled")); }; signal.addEventListener("abort", abort, { once: true }); }) : new Promise<never>(() => {});
  try { await Promise.race([work, timeout, cancelled]); }
  finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); if (state.interrupted) await session.abort?.(); }
}
