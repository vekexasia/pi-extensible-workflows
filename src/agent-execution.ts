import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { createAgentSession, DefaultPackageManager, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager, type AgentSessionEvent, type InlineExtension, type SessionStats, type ToolDefinition } from "@earendil-works/pi-coding-agent";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type AgentMessage = { role: string; content?: unknown; stopReason?: string; errorMessage?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } } };
import type { AgentIdentity, AgentResourceExclusions, AgentResourcePolicy, AgentSetupSummary, JsonSchema, JsonValue, ModelSpec, WorkflowRunContext } from "./index.js";
import { mergeAgentResourceExclusions, resolveModelReference, WorkflowError } from "./index.js";
import type { ConversationHead, PersistedConversation, RunStore } from "./persistence.js";

export interface AgentBudgetHooks {
  beforeAttempt(): void;
  beforeTurn(): void;
  afterTurn(accounting: AgentAccounting, final: boolean): void;
  instruction(): string | undefined;
}
export interface AgentDefinition { prompt?: string; description?: string; model?: string; thinking?: ThinkingLevel; tools?: readonly string[]; disabledAgentResources?: AgentResourceExclusions }
export interface AgentProviderFailure { label: string; provider: string; model: string; error: string }
export type AgentProviderRecovery = "retry" | "abort" | { model: string };
export interface AgentExecutionOptions {
  label: string;
  workflowName: string;
  phase?: string;
  parent?: string;
  model?: string;
  thinking?: ThinkingLevel;
  onProgress?: (progress: AgentProgress) => void | Promise<void>;
  onAttempt?: (attempt: Pick<AgentAttempt, "attempt" | "sessionId" | "sessionFile" | "setup">) => void | Promise<void>;
  providerErrorRecovery?: (failure: AgentProviderFailure) => Promise<AgentProviderRecovery>;
  modelOverride?: ModelSpec;
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
  conversation?: { id: string; turn: number };
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
  blockedAliasTargets?: Readonly<Record<string, string>>;
  settingsPath?: string;
  runStore?: RunStore;
  providerPause?: () => Promise<void>;
  agentSetupHooks?: readonly RegisteredAgentSetupHook[];
  agentResourcePolicy?: () => AgentResourcePolicy | Promise<AgentResourcePolicy>;
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
type NativeSessionStats = Pick<SessionStats, "tokens" | "cost">;
export interface NativeSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly messages: readonly AgentMessage[];
  getSessionStats(): NativeSessionStats;
  readonly systemPrompt?: string;
  readonly model?: { provider: string; model?: string; id?: string };
  readonly agent?: { state: { tools: readonly { name: string }[] } };
  getLeafId?: () => string | null;
  getToolDefinitions?: () => unknown;
  subscribe?(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  steer?(text: string): Promise<void>;
  abort?(): Promise<void>;
  dispose(): void;
}
export interface SessionInput { cwd: string; model: ModelSpec; tools: string[]; sessionLabel: string; agentDir?: string; customTools?: ToolDefinition[]; resultTool?: ToolDefinition; systemPromptAppend?: string; extensionFactories?: InlineExtension[]; resourcePolicy?: AgentResourcePolicy; options?: Record<string, JsonValue>; continuation?: { sessionId: string; sessionFile: string; leafId: string }; allowModelChange?: boolean }
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

type TerminalProviderError = { provider: string; model: string; error: string };
function throwIfTerminalAssistantError(session: NativeSession, fallbackModel: ModelSpec): void {
  const message = [...session.messages].reverse().find((item) => item.role === "assistant");
  if (message?.stopReason !== "error") return;
  const provider = session.model?.provider ?? fallbackModel.provider;
  const model = session.model?.model ?? session.model?.id ?? fallbackModel.model;
  const error = message.errorMessage ?? "Native Pi assistant ended with a terminal provider error";
  const failure = new WorkflowError("AGENT_FAILED", error);
  Object.defineProperty(failure, "terminalProviderError", { value: { provider, model, error }, configurable: true });
  throw failure;
}
function terminalProviderError(error: WorkflowError): TerminalProviderError | undefined {
  const value = (error as WorkflowError & { terminalProviderError?: unknown }).terminalProviderError;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<TerminalProviderError>;
  return typeof candidate.provider === "string" && typeof candidate.model === "string" && typeof candidate.error === "string" ? { provider: candidate.provider, model: candidate.model, error: candidate.error } : undefined;
}

function accounting(stats: NativeSessionStats): AgentAccounting {
  return { input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite, cost: stats.cost };
}
function canonicalSourcePath(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }

export async function createNativeAgentSession(input: SessionInput): Promise<NativeSession> {
  const agentDir = input.agentDir ?? getAgentDir();
  let manager: SessionManager;
  if (input.continuation) {
    try {
      manager = SessionManager.open(input.continuation.sessionFile, input.agentDir ? join(agentDir, "sessions") : undefined, input.cwd);
      const header = manager.getHeader();
      if (!header || canonicalSourcePath(header.cwd) !== canonicalSourcePath(input.cwd) || manager.getSessionId() !== input.continuation.sessionId || !manager.getEntry(input.continuation.leafId)) throw new Error("Persisted transcript identity does not match the conversation head");
      manager.branch(input.continuation.leafId);
      const context = manager.buildSessionContext();
      if (context.model && (context.model.provider !== input.model.provider || context.model.modelId !== input.model.model)) {
        if (!input.allowModelChange) throw new Error("Persisted transcript model does not match the conversation execution policy");
        manager.appendModelChange(input.model.provider, input.model.model);
      }
      if (input.model.thinking && context.thinkingLevel !== input.model.thinking) throw new Error("Persisted transcript thinking level does not match the conversation execution policy");
    } catch (error) {
      if (error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE") throw error;
      throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot reopen conversation transcript: ${error instanceof Error ? error.message : String(error)}`);
    }
  } else {
    manager = input.agentDir ? SessionManager.create(input.cwd, join(agentDir, "sessions")) : SessionManager.create(input.cwd);
    manager.appendSessionInfo(input.sessionLabel);
  }
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const model = modelRuntime.getModel(input.model.provider, input.model.model);
  if (!model) throw new WorkflowError("UNKNOWN_MODEL", `Unknown model: ${input.model.provider}/${input.model.model}`);
  const customTools = [...(input.customTools ?? []), ...(input.resultTool ? [input.resultTool] : [])];
  const tools = [...new Set([...input.tools, ...customTools.map(({ name }) => name)])];
  let settingsManager: SettingsManager | undefined;
  let resourceLoader: DefaultResourceLoader | undefined;
  const policy = input.resourcePolicy;
  if (policy) {
    settingsManager = SettingsManager.create(input.cwd, agentDir, { projectTrusted: false });
    settingsManager.setProjectTrusted(policy.projectTrusted);
    const packageManager = new DefaultPackageManager({ cwd: input.cwd, agentDir, settingsManager });
    const resolved = await packageManager.resolve();
    const disabledExtensions = new Set(policy.effective.extensions);
    const extensionPaths = [...new Set(resolved.extensions.filter(({ enabled, metadata }) => enabled && (policy.projectTrusted || metadata.scope !== "project")).map(({ path }) => canonicalSourcePath(path)).filter((path) => !disabledExtensions.has(canonicalSourcePath(path))))];
    const skillPaths = [...new Set(resolved.skills.filter(({ enabled, metadata }) => enabled && (policy.projectTrusted || metadata.scope !== "project")).map(({ path }) => path))];
    const updateSkillMatches = (skills: readonly { name: string }[]) => {
      const names = new Set(skills.map(({ name }) => name));
      Object.assign(policy, { unmatchedSkills: policy.effective.skills.filter((name) => !names.has(name)) });
    };
    const disabledSkills = new Set(policy.effective.skills);
    resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: extensionPaths,
      noSkills: true,
      additionalSkillPaths: skillPaths,
      ...(input.extensionFactories?.length ? { extensionFactories: input.extensionFactories } : {}),
      skillsOverride: (base) => {
        updateSkillMatches(base.skills);
        return { ...base, skills: base.skills.filter(({ name }) => !disabledSkills.has(name)) };
      },
      ...(input.systemPromptAppend ? { appendSystemPromptOverride: (base) => [...base, input.systemPromptAppend ?? ""] } : {}),
    });
    await resourceLoader.reload();
    const discoveredExtensions = new Set(resolved.extensions.filter(({ enabled, metadata }) => enabled && (policy.projectTrusted || metadata.scope !== "project")).map(({ path }) => canonicalSourcePath(path)));
    Object.assign(policy, { unmatchedExtensions: policy.effective.extensions.filter((path) => !discoveredExtensions.has(canonicalSourcePath(path))) });
  } else if (input.systemPromptAppend || input.extensionFactories?.length) {
    resourceLoader = new DefaultResourceLoader({ cwd: input.cwd, agentDir, ...(input.extensionFactories?.length ? { extensionFactories: input.extensionFactories } : {}), ...(input.systemPromptAppend ? { appendSystemPromptOverride: (base) => [...base, input.systemPromptAppend ?? ""] } : {}) });
    await resourceLoader.reload();
  }
  const { session, modelFallbackMessage } = await createAgentSession({ ...(input.options ?? {}), cwd: input.cwd, agentDir, modelRuntime, model, ...(settingsManager ? { settingsManager } : {}), ...(input.model.thinking ? { thinkingLevel: input.model.thinking } : {}), tools, ...(customTools.length ? { customTools } : {}), ...(input.extensionFactories?.length ? { extensionFactories: input.extensionFactories } : {}), ...(resourceLoader ? { resourceLoader } : {}), sessionManager: manager });
  if (input.continuation && modelFallbackMessage) throw new WorkflowError("RESUME_INCOMPATIBLE", modelFallbackMessage);
  return Object.assign(session, {
    getLeafId: () => manager.getLeafId(),
    getToolDefinitions: () => session.getAllTools().map(({ name, description, parameters, promptGuidelines }) => ({ name, description, parameters, ...(promptGuidelines ? { promptGuidelines } : {}) })),
  }) as unknown as NativeSession;
}
function changedOption(options: Readonly<Record<string, JsonValue>>, baseline: Readonly<Record<string, JsonValue>>, key: string): boolean { return JSON.stringify(options[key]) !== JSON.stringify(baseline[key]); }
function validThinking(value: unknown): value is ThinkingLevel { return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value); }
function jsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? Array.from(value) : keys.map((key) => (value as Record<string, unknown>)[key as string])).every((item) => jsonValue(item, seen));
  seen.delete(value);
  return valid;
}
function jsonObject(value: unknown): value is Record<string, JsonValue> { return jsonValue(value) && typeof value === "object" && value !== null && !Array.isArray(value); }
interface ChildAgentToolParams {
  prompt: string;
  label: string;
  tools?: string[];
  model?: string;
  thinking?: ThinkingLevel;
  role?: string;
  outputSchema?: JsonSchema;
  retries?: number;
  timeoutMs?: number | null;
  [key: string]: unknown;
}
function isChildAgentToolParams(value: unknown): value is ChildAgentToolParams & Record<string, JsonValue> {
  if (!jsonObject(value) || typeof value.prompt !== "string" || typeof value.label !== "string") return false;
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.some((tool) => typeof tool !== "string"))) return false;
  if (value.model !== undefined && typeof value.model !== "string") return false;
  if (value.thinking !== undefined && !validThinking(value.thinking)) return false;
  if (value.role !== undefined && typeof value.role !== "string") return false;
  if (value.outputSchema !== undefined && !jsonObject(value.outputSchema)) return false;
  if (value.retries !== undefined && (typeof value.retries !== "number" || !Number.isInteger(value.retries) || value.retries < 0)) return false;
  if (value.timeoutMs !== undefined && (value.timeoutMs !== null && (typeof value.timeoutMs !== "number" || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1))) return false;
  return true;
}
function fallbackSetupContext(root: AgentExecutionRoot, options: AgentExecutionOptions, signal: AbortSignal): { run: Readonly<WorkflowRunContext>; identity: Readonly<AgentIdentity> } {
  const identity = options.agentIdentity ?? { structuralPath: [], callSite: options.label, occurrence: 1 };
  const run = root.runContext ?? Object.freeze({ cwd: root.cwd, sessionId: "", runId: "", workflow: Object.freeze({ name: options.workflowName }), args: null, signal });
  return { run, identity: Object.freeze({ ...identity, structuralPath: Object.freeze([...identity.structuralPath]) }) };
}
function resourcePolicySummary(policy: AgentResourcePolicy): NonNullable<AgentSetupSummary["disabledAgentResources"]> {
  return { skills: [...policy.effective.skills], extensions: [...policy.effective.extensions], unmatchedSkills: [...policy.unmatchedSkills], unmatchedExtensions: [...policy.unmatchedExtensions] };
}
function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalJson(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, canonicalJson(item)]));
  return value;
}
function fingerprint(value: unknown): string { return createHash("sha256").update(JSON.stringify(canonicalJson(value))).digest("hex"); }
function promptFingerprint(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function fixedConversationOptions(options: Readonly<Record<string, JsonValue>>): JsonValue {
  const fixedOptions = structuredClone(options) as Record<string, JsonValue>;
  delete fixedOptions.timeoutMs;
  delete fixedOptions.retries;
  return fixedOptions;
}
function conversationExecutionPolicy(options: AgentExecutionOptions, setup: AgentSetup): JsonValue {
  return structuredClone({
    model: setup.sessionInput.model,
    tools: [...setup.sessionInput.tools],
    cwd: setup.sessionInput.cwd,
    role: options.role ?? null,
    worktreeOwner: options.worktreeOwner ?? null,
    parent: options.parent ?? null,
    systemPromptAppend: setup.sessionInput.systemPromptAppend ?? "",
    options: fixedConversationOptions(setup.options),
    resourcePolicy: setup.sessionInput.resourcePolicy ? resourcePolicySummary(setup.sessionInput.resourcePolicy) : null,
  }) as unknown as JsonValue;
}
function conversationPolicyMatches(expected: JsonValue, current: JsonValue, allowModelChange: boolean): boolean {
  if (fingerprint(expected) === fingerprint(current)) return true;
  if (!allowModelChange || !expected || typeof expected !== "object" || Array.isArray(expected) || !current || typeof current !== "object" || Array.isArray(current)) return false;
  const expectedModel = conversationPolicyModel(expected);
  const currentModel = conversationPolicyModel(current);
  if (!expectedModel || !currentModel) return false;
  return fingerprint(expected) === fingerprint({ ...current, model: { ...currentModel, provider: expectedModel.provider, model: expectedModel.model } });
}
function conversationPolicyModel(policy: JsonValue): ModelSpec | undefined {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return undefined;
  const model = policy.model;
  if (!model || typeof model !== "object" || Array.isArray(model) || typeof model.provider !== "string" || typeof model.model !== "string") return undefined;
  const thinking = typeof model.thinking === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(model.thinking) ? model.thinking as ModelSpec["thinking"] : undefined;
  return thinking === undefined ? { provider: model.provider, model: model.model } : { provider: model.provider, model: model.model, thinking };
}
function conversationFailure(message: string): WorkflowError { return new WorkflowError("RESUME_INCOMPATIBLE", message); }
async function prepareAgentSetup(root: AgentExecutionRoot, createSession: SessionFactory, task: string, options: AgentExecutionOptions, resolved: { model: ModelSpec; tools: readonly string[]; systemPromptAppend: string }, cwd: string, attempt: number, signal: AbortSignal | undefined, customTools: readonly ToolDefinition[], resultTool: ToolDefinition | undefined, continuation?: ConversationHead): Promise<{ setup: AgentSetup; summary: AgentSetupSummary }> {
  const setupSignal = signal ?? root.runContext?.signal ?? new AbortController().signal;
  const baselineOptions = structuredClone(options.agentOptions ?? {});
  const baseResourcePolicy = await root.agentResourcePolicy?.();
  const roleExclusions = options.role ? root.agentDefinitions?.[options.role]?.disabledAgentResources : undefined;
  const resourcePolicy = baseResourcePolicy && roleExclusions ? { ...baseResourcePolicy, effective: mergeAgentResourceExclusions(baseResourcePolicy.effective, roleExclusions) } : baseResourcePolicy;
  const sessionInput: SessionInput = { cwd, model: { ...resolved.model }, tools: [...resolved.tools], sessionLabel: `${options.workflowName}:${options.label}:attempt-${String(attempt)}`, ...(root.agentDir ? { agentDir: root.agentDir } : {}), ...(customTools.length ? { customTools: [...customTools] } : {}), ...(resultTool ? { resultTool } : {}), systemPromptAppend: resolved.systemPromptAppend, ...(resourcePolicy ? { resourcePolicy } : {}), options: structuredClone(baselineOptions) };
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
  if (changedOption(setup.options, baselineOptions, "model") && typeof setup.options.model === "string") setup.sessionInput.model = parseModel(setup.options.model, setup.sessionInput.model, changedOption(setup.options, baselineOptions, "thinking") && validThinking(setup.options.thinking) ? setup.options.thinking : undefined, root.modelAliases, root.knownModels ?? root.availableModels, root.settingsPath);
  if (changedOption(setup.options, baselineOptions, "thinking") && validThinking(setup.options.thinking)) setup.sessionInput.model = { ...setup.sessionInput.model, thinking: setup.options.thinking };
  if (changedOption(setup.options, baselineOptions, "tools") && Array.isArray(setup.options.tools) && setup.options.tools.every((tool) => typeof tool === "string")) setup.sessionInput.tools = [...setup.options.tools];
  if (changedOption(setup.options, baselineOptions, "cwd") && typeof setup.options.cwd === "string") setup.sessionInput.cwd = setup.options.cwd;
  if (continuation) setup.sessionInput.continuation = { sessionId: continuation.sessionId, sessionFile: continuation.sessionFile, leafId: continuation.leafId };
  const model = setup.sessionInput.model;
  const summary: AgentSetupSummary = { hookNames: [...hookNames], model: { provider: model.provider, model: model.model, ...(model.thinking ? { thinking: model.thinking } : {}) }, tools: [...setup.sessionInput.tools], cwd: setup.sessionInput.cwd, ...(setup.sessionInput.resourcePolicy ? { disabledAgentResources: resourcePolicySummary(setup.sessionInput.resourcePolicy) } : {}) };
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
    if (requestedModel !== undefined && this.root.blockedAliases?.has(requestedModel) && !hasAlias) { const target = this.root.blockedAliasTargets?.[requestedModel]; throw new WorkflowError("UNKNOWN_MODEL", `Unknown model alias ${requestedModel}${target ? ` resolved to ${target}` : ""}${this.root.settingsPath ? ` (settings: ${this.root.settingsPath})` : ""}`); }
    const aliasThinking = requestedModel !== undefined && hasAlias ? resolveModelReference(requestedModel, this.root.modelAliases, this.root.knownModels ?? this.root.availableModels, this.root.settingsPath).thinking : undefined;
    const model = options.modelOverride ?? parseModel(requestedModel, this.root.model, options.thinking ?? (aliasThinking === undefined ? definition?.thinking : undefined), this.root.modelAliases, this.root.knownModels ?? this.root.availableModels, this.root.settingsPath);
    const availableModels = this.root.knownModels ?? this.root.availableModels ?? new Set([modelCapability(this.root.model)]);
    if (!availableModels.has(modelCapability(model))) throw new WorkflowError("UNKNOWN_MODEL", `Unknown model${requestedModel ? ` ${requestedModel} resolved to ${modelCapability(model)}` : ""}${this.root.settingsPath ? ` (settings: ${this.root.settingsPath})` : ""}`);
    return { model, ...(hasAlias ? { requestedModel } : {}), tools: [...requested], systemPromptAppend: definition?.prompt ?? "" };
  }

  async execute(task: string, options: AgentExecutionOptions, signal?: AbortSignal, customTools: readonly ToolDefinition[] = [], setSteer?: (handler: (message: string) => void | Promise<void>) => void, beforeRetry?: () => void): Promise<AgentExecutionResult> {
    const executionSignal = signal ?? this.root.runContext?.signal;
    if (!Number.isInteger(options.retries ?? 0) || (options.retries ?? 0) < 0) throw new WorkflowError("INVALID_METADATA", "retries must be a non-negative integer");
    if (options.timeoutMs !== undefined && options.timeoutMs !== null && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)) throw new WorkflowError("INVALID_METADATA", "timeoutMs must be null or a positive integer");
    let resolved = this.resolve(options);
    let recoveryModel: ModelSpec | undefined;
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
    let conversationRecord: PersistedConversation | undefined;
    if (options.conversation) {
      const store = this.root.runStore;
      if (!store) throw conversationFailure("Conversation persistence is unavailable");
      try { conversationRecord = await store.conversation(options.conversation.id); } catch (error) { throw conversationFailure(`Cannot load conversation state: ${error instanceof Error ? error.message : String(error)}`); }
      if (conversationRecord) {
        const model = conversationPolicyModel(conversationRecord.policy);
        if (model) resolved = this.resolve({ ...options, modelOverride: model });
      }
      if (!Number.isInteger(options.conversation.turn) || options.conversation.turn < 1) throw conversationFailure("Conversation turn must be a positive integer");
      if (conversationRecord ? conversationRecord.head.turn + 1 !== options.conversation.turn : options.conversation.turn !== 1) throw conversationFailure(`Conversation turn ${String(options.conversation.turn)} does not continue its persisted head`);
    }
    const attempts: AgentAttempt[] = [];
    let conversationBaseline: { executionPolicy: JsonValue; toolDefinitionsSha256: string; systemPrompt?: string; systemPromptSha256?: string } | undefined;
    let maxAttempts = (options.retries ?? 0) + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (recoveryModel) resolved = this.resolve({ ...options, modelOverride: recoveryModel });
      options.budget?.beforeAttempt();
      const accepted = options.schema !== undefined;
      let schemaResult: JsonValue | undefined;
      let session: NativeSession | undefined;
      let setup: AgentSetup | undefined;
      let setupSummary: AgentSetupSummary | undefined;
      let setupFailed = false;
      let budgetError: WorkflowError | undefined;
      let turnStarted = false;
      let conversationSystemPrompt = "";
      let conversationToolDefinitionsSha256 = "";
      let conversationMismatch: WorkflowError | undefined;
      const conversationMismatchError = () => conversationMismatch ? new WorkflowError("RESUME_INCOMPATIBLE", conversationMismatch.message) : undefined;
      const hasSchemaResult = () => schemaResult !== undefined;
      const resultTool = options.schema ? {
        name: "workflow_result", label: "Workflow Result", description: "Submit the terminal structured workflow result", parameters: Type.Unsafe(options.schema),
        async execute(_id: string, value: unknown) {
          if (!accepted) return { content: [{ type: "text" as const, text: "Result acceptance is not enabled yet." }], details: {}, isError: true };
          if (!Value.Check(options.schema as object, value)) return { content: [{ type: "text" as const, text: "Result does not match the required schema." }], details: {}, isError: true };
          if (schemaResult !== undefined) return { content: [{ type: "text" as const, text: "Result has already been accepted." }], details: {}, isError: true };
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
        const update = { accounting: accounting(session.getSessionStats()), toolCalls: [...toolCalls.values()], ...(activity ? { activity } : {}), persist };
        progress = progress.then(() => options.onProgress?.(update)).then(() => undefined);
      };
      try {
        setupFailed = true;
        const prepared = await prepareAgentSetup(this.root, this.createSession, task, options, resolved, cwd, attempt, executionSignal, customTools, resultTool, conversationRecord?.head);
        setup = prepared.setup;
        setupSummary = prepared.summary;
        setupFailed = false;
        if (executionSignal?.aborted) throw new WorkflowError("CANCELLED", "Agent cancelled");
        if (recoveryModel && conversationRecord) setup.sessionInput.allowModelChange = true;
        const started = Date.now();
        session = await setup.createSession(setup.sessionInput);
        if (setup.sessionInput.resourcePolicy) setupSummary = { ...setupSummary, disabledAgentResources: resourcePolicySummary(setup.sessionInput.resourcePolicy) };
        if (options.conversation) {
          conversationSystemPrompt = session.systemPrompt ?? "";
          conversationToolDefinitionsSha256 = fingerprint(session.getToolDefinitions?.() ?? session.agent?.state.tools ?? []);
          const currentExecutionPolicy = conversationExecutionPolicy(options, setup);
          if (conversationRecord) {
            if (session.sessionId !== conversationRecord.head.sessionId || requiredFile(session.sessionFile) !== conversationRecord.head.sessionFile) throw conversationFailure("Conversation transcript identity changed");
            if (!session.getLeafId || (!recoveryModel && session.getLeafId() !== conversationRecord.head.leafId)) throw conversationFailure("Conversation transcript leaf identity changed");
            if (!conversationPolicyMatches(conversationRecord.policy, currentExecutionPolicy, Boolean(recoveryModel))) throw conversationFailure("Conversation execution policy changed");
            if (!session.subscribe && (promptFingerprint(conversationSystemPrompt) !== conversationRecord.head.systemPromptSha256 || conversationSystemPrompt !== conversationRecord.head.systemPrompt)) throw conversationFailure("Conversation system prompt changed");
            if (conversationToolDefinitionsSha256 !== conversationRecord.head.toolDefinitionsSha256) throw conversationFailure("Conversation tool definitions changed");
          } else if (conversationBaseline) {
            if (!conversationPolicyMatches(conversationBaseline.executionPolicy, currentExecutionPolicy, Boolean(recoveryModel))) throw conversationFailure("Conversation execution policy changed");
            if (conversationToolDefinitionsSha256 !== conversationBaseline.toolDefinitionsSha256) throw conversationFailure("Conversation tool definitions changed");
          } else {
            conversationBaseline = { executionPolicy: currentExecutionPolicy, toolDefinitionsSha256: conversationToolDefinitionsSha256 };
          }
          if (!session.subscribe) {
            const expectedPrompt = conversationRecord?.head.systemPrompt ?? conversationBaseline?.systemPrompt;
            const expectedDigest = conversationRecord?.head.systemPromptSha256 ?? conversationBaseline?.systemPromptSha256;
            if (expectedPrompt !== undefined && expectedDigest !== undefined && (promptFingerprint(conversationSystemPrompt) !== expectedDigest || expectedPrompt !== conversationSystemPrompt)) throw conversationFailure("Conversation system prompt changed");
            if (!conversationRecord && conversationBaseline && conversationBaseline.systemPrompt === undefined) conversationBaseline = { ...conversationBaseline, systemPrompt: conversationSystemPrompt, systemPromptSha256: promptFingerprint(conversationSystemPrompt) };
          }
          if (conversationRecord && (!session.model || session.model.provider !== setup.sessionInput.model.provider || (session.model.model ?? session.model.id) !== setup.sessionInput.model.model)) throw conversationFailure("Conversation model changed");
        }
        const includeAttemptSetup = Boolean(this.root.agentSetupHooks?.length || setup.sessionInput.resourcePolicy);
        await options.onAttempt?.({ attempt, sessionId: session.sessionId, sessionFile: requiredFile(session.sessionFile), ...(includeAttemptSetup ? { setup: setupSummary } : {}) });
        const activeSession = session;
        unsubscribe = activeSession.subscribe?.((event) => {
          if (event.type === "agent_start" && session?.systemPrompt !== undefined) {
            if (options.conversation) {
              conversationSystemPrompt = session.systemPrompt;
              const expectedPrompt = conversationRecord?.head.systemPrompt ?? conversationBaseline?.systemPrompt;
              const expectedDigest = conversationRecord?.head.systemPromptSha256 ?? conversationBaseline?.systemPromptSha256;
              if (expectedPrompt !== undefined && expectedDigest !== undefined && (promptFingerprint(conversationSystemPrompt) !== expectedDigest || expectedPrompt !== conversationSystemPrompt)) { conversationMismatch = conversationFailure("Conversation system prompt changed"); void session.abort?.(); }
              if (!conversationRecord && conversationBaseline && conversationBaseline.systemPrompt === undefined) conversationBaseline = { ...conversationBaseline, systemPrompt: conversationSystemPrompt, systemPromptSha256: promptFingerprint(conversationSystemPrompt) };
            }
            if (this.root.runStore) {
              systemPromptTurn += 1;
              const entry = { sessionId: session.sessionId, attempt, turn: systemPromptTurn, prompt: session.systemPrompt };
              systemPromptWrite = systemPromptWrite.then(() => this.root.runStore?.recordSystemPrompt(entry)).then(() => undefined).catch((error: unknown) => { systemPromptWriteError ??= error; });
            }
          }
          if (event.type === "message_start" && event.message.role === "assistant") {
            if (!turnStarted) { try { options.budget?.beforeTurn(); turnStarted = true; } catch (error) { budgetError ??= error instanceof WorkflowError ? error : new WorkflowError("BUDGET_EXHAUSTED", error instanceof Error ? error.message : String(error)); void session?.abort?.(); } }
            activity = { kind: "text", text: "responding" }; report(false);
          }
          if (event.type === "message_end") {
            activity = undefined;
            if (event.message.role === "assistant") {
              const needsMoreWork = hasToolCall(event.message);
              const final = !needsMoreWork || (options.schema !== undefined && hasSchemaResult());
              if (!budgetError) { try { options.budget?.afterTurn(accounting(activeSession.getSessionStats()), final); if (!final) { const instruction = options.budget?.instruction(); if (instruction) void session?.steer?.(instruction); } } catch (error) { budgetError ??= error instanceof WorkflowError ? error : new WorkflowError("BUDGET_EXHAUSTED", error instanceof Error ? error.message : String(error)); void session?.abort?.(); } }
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
        try { await promptWithProviderPause(session, promptText, remaining(options.timeoutMs, started), executionSignal, this.root.providerPause); } catch (error) { if (!hasSchemaResult()) throw error; }
        if (conversationMismatch) throw conversationMismatch;
        throwIfTerminalAssistantError(session, setup.sessionInput.model);
        { const completedAccounting = accounting(session.getSessionStats()); options.budget?.afterTurn(completedAccounting, options.schema !== undefined ? hasSchemaResult() : !latestAssistantHasToolCall(session.messages)); turnStarted = false; }
        if (budgetError) throw budgetError;
        if (options.schema) {
          if (!hasSchemaResult()) {
            try { options.budget?.beforeTurn(); turnStarted = true; await promptWithProviderPause(session, "Submit the final result now by calling workflow_result exactly once. Do not return prose.", remaining(options.timeoutMs, started), executionSignal, this.root.providerPause); { const completedAccounting = accounting(session.getSessionStats()); options.budget?.afterTurn(completedAccounting, true); turnStarted = false; } } catch (error) { if (!hasSchemaResult()) throw error; }
          }
          throwIfTerminalAssistantError(session, setup.sessionInput.model);
          if (!hasSchemaResult()) {
            try { options.budget?.beforeTurn(); turnStarted = true; await promptWithProviderPause(session, "Your result was missing or invalid. Repair it by calling workflow_result exactly once with a schema-valid value.", remaining(options.timeoutMs, started), executionSignal, this.root.providerPause); { const completedAccounting = accounting(session.getSessionStats()); options.budget?.afterTurn(completedAccounting, true); turnStarted = false; } } catch (error) { if (!hasSchemaResult()) throw error; }
            throwIfTerminalAssistantError(session, setup.sessionInput.model);
          }
          if (schemaResult === undefined) throw new WorkflowError("RESULT_INVALID", "Agent did not submit a valid workflow_result after one repair");
        }
        const mismatch = conversationMismatchError();
        if (mismatch) throw mismatch;
        const value = options.schema ? schemaResult as JsonValue : text(session.messages);
        if (options.worktreeOwner) await this.root.runStore?.snapshotWorktree(options.worktreeOwner);
        report(true);
        await progress;
        await flushSystemPrompts();
        unsubscribe?.();
        const attemptAccounting = accounting(session.getSessionStats());
        const leafId = session.getLeafId?.() ?? undefined;
        if (options.conversation) {
          if (!leafId) throw conversationFailure("Conversation transcript has no persisted leaf");
          const store = this.root.runStore;
          if (!store) throw conversationFailure("Conversation persistence is unavailable");
          await store.saveConversation({ id: options.conversation.id, policy: conversationExecutionPolicy(options, setup), head: { turn: options.conversation.turn, sessionId: session.sessionId, sessionFile: requiredFile(session.sessionFile), leafId, systemPrompt: conversationSystemPrompt, systemPromptSha256: promptFingerprint(conversationSystemPrompt), toolDefinitionsSha256: conversationToolDefinitionsSha256 } });
        }
        const includeCompletedSetup = Boolean(this.root.agentSetupHooks?.length || setup.sessionInput.resourcePolicy);
        attempts.push({ attempt, sessionId: session.sessionId, sessionFile: requiredFile(session.sessionFile), result: value, accounting: attemptAccounting, ...(includeCompletedSetup ? { setup: setupSummary } : {}) });
        session.dispose();
        return { value, attempts, cwd: setupSummary.cwd };
      } catch (error) {
        const typed = budgetError ?? conversationMismatch ?? (error instanceof WorkflowError ? error : new WorkflowError(executionSignal?.aborted && setupFailed ? "CANCELLED" : "AGENT_FAILED", error instanceof Error ? error.message : String(error)));
        if (session) {
          report(true);
          await progress;
          try { await flushSystemPrompts(); } catch { /* Preserve the agent failure that prompted this cleanup. */ }
          unsubscribe?.();
          const attemptAccounting = accounting(session.getSessionStats());
          if (!budgetError && typed.code !== "BUDGET_EXHAUSTED") { try { options.budget?.afterTurn(attemptAccounting, true); } catch (budgetFailure) { budgetError ??= budgetFailure instanceof WorkflowError ? budgetFailure : new WorkflowError("BUDGET_EXHAUSTED", budgetFailure instanceof Error ? budgetFailure.message : String(budgetFailure)); } }
          const includeFailedSetup = Boolean(this.root.agentSetupHooks?.length || setup?.sessionInput.resourcePolicy);
          attempts.push({ attempt, sessionId: session.sessionId, sessionFile: requiredFile(session.sessionFile), error: { code: typed.code, message: typed.message }, accounting: attemptAccounting, ...(includeFailedSetup && setupSummary ? { setup: setupSummary } : {}) });
          session.dispose();
        }
        if (options.worktreeOwner && typed.code !== "WORKTREE_FAILED") await this.root.runStore?.snapshotWorktree(options.worktreeOwner).catch(() => undefined);
        const terminal = terminalProviderError(typed);
        if (terminal && options.providerErrorRecovery) {
          let recovery: AgentProviderRecovery;
          try { recovery = await options.providerErrorRecovery({ label: options.label, ...terminal }); } catch { throw Object.assign(typed, { attempts }); }
          if (recovery === "retry" || typeof recovery === "object" && typeof recovery.model === "string") {
            if (typeof recovery === "object") {
              try {
                const selected = resolveModelReference(recovery.model, this.root.modelAliases, this.root.knownModels ?? this.root.availableModels, this.root.settingsPath);
                recoveryModel = selected.thinking === undefined && resolved.model.thinking ? { ...selected, thinking: resolved.model.thinking } : selected;
              } catch { throw Object.assign(typed, { attempts }); }
            }
            maxAttempts += 1;
            beforeRetry?.();
            continue;
          }
        }
        if (attempt === maxAttempts || setupFailed || typed.code === "CANCELLED" || typed.code === "WORKTREE_FAILED" || typed.code === "RESUME_INCOMPATIBLE") throw Object.assign(typed, { attempts });
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
  conversation?: { id: string; turn: number };
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
  state: "queued" | "running" | "waiting_for_child" | "paused" | "retrying" | "completed" | "failed" | "cancelled";
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
  retry(id: string): void {
    const node = this.#node(id);
    if (node.state === "running") { node.state = "retrying"; this.#persist(node.runId); }
  }

  attemptStarted(id: string): void {
    const node = this.#node(id);
    if (node.state === "retrying") { node.state = "running"; this.#persist(node.runId); }
  }

  async cancelRun(runId: string): Promise<void> {
    const run = this.#runs.get(runId);
    if (!run) throw new WorkflowError("INTERNAL_ERROR", `Unknown scheduler run: ${runId}`);
    const nodes = [...this.#nodes.values()].filter((node) => node.runId === runId);
    for (const node of nodes) if (!node.parentId) this.#cancelTree(node);
    await Promise.all(nodes.map(({ promise }) => promise));
    if (nodes.every(({ restored }) => restored)) run.logical = 0;
  }

  toolsFor(parentId: string, resolveTools?: (role: string | undefined, tools: readonly string[] | undefined, model: string | undefined, inheritedTools: readonly string[], thinking: ThinkingLevel | undefined) => readonly string[]): ToolDefinition[] {
    const parent = this.#node(parentId);
    if (!parent.options.tools.includes("agent")) return [];
    const agentTool = {
      name: "agent", label: "Child Agent", description: "Start a direct child agent",
      parameters: Type.Object({ prompt: Type.String(), label: Type.String(), tools: Type.Optional(Type.Array(Type.String())), model: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()), role: Type.Optional(Type.String()), outputSchema: Type.Optional(Type.Unsafe<JsonSchema>({})), retries: Type.Optional(Type.Integer({ minimum: 0 })), timeoutMs: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])) }, { additionalProperties: true }),
      execute: async (_id: string, rawParams: unknown) => {
        if (!isChildAgentToolParams(rawParams)) throw new WorkflowError("INVALID_METADATA", "Invalid child agent parameters");
        const params = rawParams;
        if (params.role !== undefined && (params.model !== undefined || params.thinking !== undefined || params.tools !== undefined)) throw new WorkflowError("INVALID_METADATA", "Role agents must not specify model, thinking, or tools");
        const tools = (params.tools !== undefined || params.role !== undefined ? resolveTools?.(params.role, params.tools, params.model, parent.options.tools, params.thinking) : undefined) ?? params.tools ?? parent.options.tools;
        const agentOptions = { ...params };
        Reflect.deleteProperty(agentOptions, "prompt");
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
    const inheritedTools: readonly string[] = options.tools;
    if (!parent) return Object.freeze({ ...options, tools: Object.freeze([...inheritedTools]), ...(options.agentOptions ? { agentOptions: structuredClone(options.agentOptions) } : {}), ...(options.agentIdentity ? { agentIdentity: Object.freeze({ ...options.agentIdentity, structuralPath: Object.freeze([...options.agentIdentity.structuralPath]) }) } : {}) });
    if (options.cwd !== parent.options.cwd) throw new WorkflowError("UNKNOWN_TOOL", "Child cwd cannot differ from its parent");
    const forbidden = inheritedTools.find((tool: string) => !parent.options.tools.includes(tool));
    if (forbidden) throw new WorkflowError("UNKNOWN_TOOL", `Child tool escalates parent boundary: ${forbidden}`);
    const identity = options.agentIdentity ?? parent.options.agentIdentity;
    return Object.freeze({ ...options, cwd: parent.options.cwd, tools: Object.freeze([...inheritedTools]), ...(options.agentOptions ? { agentOptions: structuredClone(options.agentOptions) } : {}), ...(parent.options.parentBreadcrumb && !options.parentBreadcrumb ? { parentBreadcrumb: parent.options.parentBreadcrumb } : {}), ...(identity ? { agentIdentity: Object.freeze({ ...identity, structuralPath: Object.freeze([...identity.structuralPath]) }) } : {}), ...(parent.options.worktreeOwner ? { worktreeOwner: parent.options.worktreeOwner } : {}) });
  }

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
    const heldPermit = node.state === "running" || node.state === "retrying";
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
