import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { createAgentSession, DefaultPackageManager, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type AgentMessage = { role: string; content?: unknown; stopReason?: string; errorMessage?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } } };
type PiSession = {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly messages: readonly AgentMessage[];
  getSessionStats(): { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost: number };
  readonly systemPrompt?: string;
  readonly model?: { provider: string; model?: string; id?: string };
  readonly agent?: { state: { tools: readonly { name: string }[] } };
  subscribe?(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  steer?(text: string): Promise<void>;
  abort?(): Promise<void>;
  dispose(): void;
};
import type { AgentIdentity, AgentResourceExclusions, AgentResourcePolicy, AgentSetup, AgentSetupSummary, AgentTransport, AgentTransportContext, JsonSchema, JsonValue, ModelSpec, PreparedAgentSession, RegisteredAgentSetupHook, SessionInput, WorkflowAgentMessage, WorkflowAgentSession, WorkflowAgentSessionEvent, WorkflowAgentSessionReference, WorkflowAgentSessionState, WorkflowAgentSessionStats, WorkflowAgentTurnResult, WorkflowRunContext } from "./types.js";
import { deepFreeze, jsonObject, disabledResources, mergeAgentResourceExclusions, modelAliasName, modelCapability, resolveModelReference, unmatchedResourcePatterns } from "./utils.js";
import { WorkflowError } from "./types.js";
import type { RunStore } from "./persistence.js";
export type { AgentSetup, AgentSetupContext, AgentSetupHook, AgentTransport, AgentTransportContext, PreparedAgentSession, RegisteredAgentSetupHook, SessionInput, WorkflowAgentMessage, WorkflowAgentSession, WorkflowAgentSessionEvent, WorkflowAgentSessionReference, WorkflowAgentSessionState, WorkflowAgentSessionStats, WorkflowAgentTurnResult } from "./types.js";
export interface AgentBudgetHooks {
  beforeAttempt(): void;
  beforeTurn(): void;
  afterTurn(accounting: AgentAccounting, final: boolean): void;
  instruction(): string | undefined;
}
export interface AgentDefinition { prompt?: string; description?: string; model?: string; thinking?: ThinkingLevel; tools?: readonly string[]; overrideSystemPrompt?: boolean; disabledAgentResources?: AgentResourceExclusions }
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
  onAttempt?: (attempt: AgentAttempt) => void | Promise<void>;
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
}
export interface AgentExecutionRoot {
  cwd: string;
  model: ModelSpec;
  tools: ReadonlySet<string>;
  agentDefinitions?: Readonly<Record<string, AgentDefinition>>;
  agentDir?: string;
  additionalSkillPaths?: readonly string[];
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
export interface AgentProgress { accounting: AgentAccounting; toolCalls: readonly AgentToolCallProgress[]; state?: WorkflowAgentSessionState; activity?: AgentActivity; lastEventAt?: number; persist: boolean }
export interface AgentAttempt { attempt: number; transport: string; session?: WorkflowAgentSessionReference; liveSession?: WorkflowAgentSession; result?: JsonValue; error?: { code: string; message: string }; accounting: AgentAccounting; setup: AgentSetupSummary }
export interface AgentExecutionResult { value: JsonValue; attempts: readonly AgentAttempt[]; cwd: string }

function parseModel(value: string | undefined, fallback: ModelSpec, thinking?: ThinkingLevel, aliases: Readonly<Record<string, string>> = {}, knownModels?: ReadonlySet<string>, settingsPath?: string): ModelSpec {
  if (!value) return { ...fallback, ...(thinking ? { thinking } : {}) };
  const parsed = resolveModelReference(value, aliases, knownModels, settingsPath);
  return { ...parsed, ...(thinking ? { thinking } : !parsed.thinking && fallback.thinking ? { thinking: fallback.thinking } : {}) };
}

function text(message: WorkflowAgentMessage | undefined): string {
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.filter((part: unknown): part is { type: "text"; text: string } => typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string").map((part) => part.text).join("");
}
function isEmptyAbortedAssistant(message: WorkflowAgentMessage | undefined): boolean { return message?.stopReason === "aborted" && Array.isArray(message.content) && message.content.length === 0; }

function hasToolCall(message: unknown): boolean {
  return typeof message === "object" && message !== null && Array.isArray((message as { content?: unknown }).content) && (message as { content: unknown[] }).content.some((part) => typeof part === "object" && part !== null && (part as { type?: unknown }).type === "toolCall");
}

function latestAssistantHasToolCall(message: WorkflowAgentMessage | undefined): boolean { return hasToolCall(message); }

type TerminalProviderError = { provider: string; model: string; error: string };
function throwIfTerminalAssistantError(session: WorkflowAgentSession, message: WorkflowAgentMessage | undefined): void {
  if (message?.stopReason !== "error") return;
  const state = session.getState();
  const error = message.errorMessage ?? "Workflow agent session ended with a terminal provider error";
  const failure = new WorkflowError("AGENT_FAILED", error);
  Object.defineProperty(failure, "terminalProviderError", { value: { provider: state.model.provider, model: state.model.model, error }, configurable: true });
  throw failure;
}
function terminalProviderError(error: WorkflowError): TerminalProviderError | undefined {
  const value = (error as WorkflowError & { terminalProviderError?: unknown }).terminalProviderError;
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Partial<TerminalProviderError>;
  return typeof candidate.provider === "string" && typeof candidate.model === "string" && typeof candidate.error === "string" ? { provider: candidate.provider, model: candidate.model, error: candidate.error } : undefined;
}
type ProviderRecoveryMarker = { providerRecoveryHandled?: boolean; providerRecovery?: AgentProviderRecovery; providerRecoveryFailed?: boolean };
const providerContinuationPrompt = "The provider error was transient. Continue the task from your current state.";
async function recoverTerminalProviderError(session: WorkflowAgentSession, label: string, recovery: AgentExecutionOptions["providerErrorRecovery"], continuePrompt: () => Promise<void>, getAssistant: () => WorkflowAgentMessage | undefined): Promise<boolean> {
  let continued = false;
  for (;;) {
    try { throwIfTerminalAssistantError(session, getAssistant()); return continued; }
    catch (error) {
      const typed = error instanceof WorkflowError ? error : new WorkflowError("AGENT_FAILED", error instanceof Error ? error.message : String(error));
      const terminal = terminalProviderError(typed);
      if (!terminal || !recovery) throw error;
      let action: AgentProviderRecovery;
      try { action = await recovery({ label, ...terminal }); } catch { Object.assign(typed, { providerRecoveryHandled: true, providerRecoveryFailed: true }); throw typed; }
      if (action === "retry") { continued = true; await continuePrompt(); continue; }
      Object.assign(typed, { providerRecoveryHandled: true, providerRecovery: action });
      throw typed;
    }
  }
}

function accounting(stats: WorkflowAgentSessionStats): AgentAccounting {
  return { input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite, cost: stats.cost };
}
function canonicalSourcePath(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }
function canonicalExtensionSelector(selector: string): string {
  const negated = selector.startsWith("!");
  const body = negated ? selector.slice(1) : selector;
  if (!existsSync(body) && /[*?\x5b\x5d{}()]/.test(body)) return selector;
  return `${negated ? "!" : ""}${canonicalSourcePath(body)}`;
}
const WORKFLOW_DIRECTORY = "pi-extensible-workflows";
function workflowSystemPromptPath(cwd: string, agentDir: string, projectTrusted: boolean): string | undefined {
  const projectPath = join(cwd, ".pi", WORKFLOW_DIRECTORY, "SYSTEM.md");
  if (projectTrusted && existsSync(projectPath)) return projectPath;
  const globalPaths = [join(homedir(), ".pi", WORKFLOW_DIRECTORY, "SYSTEM.md"), join(agentDir, WORKFLOW_DIRECTORY, "SYSTEM.md")];
  return globalPaths.find((path) => existsSync(path));
}

export async function createLocalPiSession(input: SessionInput): Promise<PiSession> {
  const agentDir = input.agentDir ?? getAgentDir();
  const systemPromptSource = workflowSystemPromptPath(input.cwd, agentDir, input.resourcePolicy?.projectTrusted ?? true);
  const systemPromptOptions = input.systemPrompt !== undefined ? { systemPromptOverride: () => input.systemPrompt } : systemPromptSource !== undefined ? { systemPrompt: systemPromptSource } : {};
  const manager = input.agentDir ? SessionManager.create(input.cwd, join(agentDir, "sessions")) : SessionManager.create(input.cwd);
  manager.appendSessionInfo(input.sessionLabel);
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
    const discoveredExtensions = [...new Set(resolved.extensions.filter(({ enabled, metadata }) => enabled && (policy.projectTrusted || metadata.scope !== "project")).map(({ path }) => canonicalSourcePath(path)))];
    const extensionSelectors = policy.effective.extensions.map((selector) => ({ original: selector, matching: canonicalExtensionSelector(selector) }));
    const excludedExtensions = new Set(disabledResources(extensionSelectors.map(({ matching }) => matching), discoveredExtensions));
    const extensionPaths = discoveredExtensions.filter((path) => !excludedExtensions.has(path));
    const unmatchedExtensions = extensionSelectors.filter(({ matching }) => unmatchedResourcePatterns([matching], discoveredExtensions).length > 0).map(({ original }) => original);
    Object.assign(policy, { excludedExtensions: [...excludedExtensions], unmatchedExtensions });
    const skillPaths = [...new Set(resolved.skills.filter(({ enabled, metadata }) => enabled && (policy.projectTrusted || metadata.scope !== "project")).map(({ path }) => path))];
    const updateSkillMatches = (skills: readonly { name: string }[]): Set<string> => {
      const names = [...new Set(skills.map(({ name }) => name))];
      const excludedSkills = disabledResources(policy.effective.skills, names);
      Object.assign(policy, { excludedSkills, unmatchedSkills: unmatchedResourcePatterns(policy.effective.skills, names) });
      return new Set(excludedSkills);
    };
    resourceLoader = new DefaultResourceLoader({
      cwd: input.cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      additionalExtensionPaths: extensionPaths,
      noSkills: true,
      additionalSkillPaths: [...new Set([...skillPaths, ...(input.additionalSkillPaths ?? [])])],
      ...(input.extensionFactories?.length ? { extensionFactories: input.extensionFactories } : {}),
      skillsOverride: (base) => {
        const disabledSkills = updateSkillMatches(base.skills);
        return { ...base, skills: base.skills.filter(({ name }) => !disabledSkills.has(name)) };
      },
      ...(input.systemPromptAppend ? { appendSystemPromptOverride: (base) => [...base, input.systemPromptAppend ?? ""] } : {}),
      ...systemPromptOptions,
    });
    await resourceLoader.reload();
  } else if (input.systemPrompt !== undefined || systemPromptSource !== undefined || input.systemPromptAppend || input.extensionFactories?.length || input.additionalSkillPaths?.length) {
    resourceLoader = new DefaultResourceLoader({ cwd: input.cwd, agentDir, ...(input.additionalSkillPaths?.length ? { additionalSkillPaths: [...input.additionalSkillPaths] } : {}), ...(input.extensionFactories?.length ? { extensionFactories: input.extensionFactories } : {}), ...systemPromptOptions, ...(input.systemPromptAppend ? { appendSystemPromptOverride: (base) => [...base, input.systemPromptAppend ?? ""] } : {}) });
    await resourceLoader.reload();
  }
  const { session } = await createAgentSession({ ...(input.options ?? {}), cwd: input.cwd, agentDir, modelRuntime, model, ...(settingsManager ? { settingsManager } : {}), ...(input.model.thinking ? { thinkingLevel: input.model.thinking } : {}), tools, ...(customTools.length ? { customTools } : {}), ...(input.extensionFactories?.length ? { extensionFactories: input.extensionFactories } : {}), ...(resourceLoader ? { resourceLoader } : {}), sessionManager: manager });
  return Object.assign(session, {
    getLeafId: () => manager.getLeafId(),
    getToolDefinitions: () => session.getAllTools().map(({ name, description, parameters, promptGuidelines }) => ({ name, description, parameters, ...(promptGuidelines ? { promptGuidelines } : {}) })),
  }) as unknown as PiSession;
}
function workflowAgentMessage(message: AgentMessage | undefined): WorkflowAgentMessage | undefined { return message ? { role: message.role, ...(message.content === undefined ? {} : { content: message.content }), ...(message.stopReason === undefined ? {} : { stopReason: message.stopReason }), ...(message.errorMessage === undefined ? {} : { errorMessage: message.errorMessage }), ...(message.usage === undefined ? {} : { usage: message.usage }) } : undefined; }
function latestUsableAssistant(messages: readonly AgentMessage[]): WorkflowAgentMessage | undefined { for (let index = messages.length - 1; index >= 0; index -= 1) { const candidate = workflowAgentMessage(messages[index]); if (candidate?.role === "assistant" && !isEmptyAbortedAssistant(candidate)) return candidate; } return undefined; }
function workflowAgentStats(stats: ReturnType<PiSession["getSessionStats"]>): WorkflowAgentSessionStats { return { tokens: { input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite, total: stats.tokens.total }, cost: stats.cost }; }
function workflowAgentState(native: PiSession, prepared: Readonly<PreparedAgentSession>): WorkflowAgentSessionState {
  const tools = native.agent?.state.tools.map(({ name }) => name) ?? prepared.tools;
  const model = native.model?.provider && (native.model.model ?? native.model.id) ? { provider: native.model.provider, model: native.model.model ?? native.model.id ?? prepared.model.model, ...(prepared.model.thinking ? { thinking: prepared.model.thinking } : {}) } : { ...prepared.model };
  return { model, ...(model.thinking ? { thinking: model.thinking } : {}), tools: [...tools], ...(native.systemPrompt === undefined ? {} : { systemPrompt: native.systemPrompt }) };
}
function localSessionEvent(event: unknown): WorkflowAgentSessionEvent { return event as WorkflowAgentSessionEvent; }
export async function createLocalWorkflowAgentSession(prepared: Readonly<PreparedAgentSession>, context: Readonly<AgentTransportContext>): Promise<WorkflowAgentSession> {
  void context;
  const input: SessionInput = {
    cwd: prepared.cwd, model: { ...prepared.model }, tools: [...prepared.tools] as SessionInput["tools"], sessionLabel: prepared.sessionLabel,
    ...(prepared.agentDir ? { agentDir: prepared.agentDir } : {}), ...(prepared.customTools?.length ? { customTools: [...prepared.customTools] as NonNullable<SessionInput["customTools"]> } : {}),
    ...(prepared.resultTool ? { resultTool: prepared.resultTool } : {}), ...(prepared.systemPrompt === undefined ? {} : { systemPrompt: prepared.systemPrompt }),
    ...(prepared.systemPromptAppend ? { systemPromptAppend: prepared.systemPromptAppend } : {}), ...(prepared.extensionFactories?.length ? { extensionFactories: [...prepared.extensionFactories] } : {}),
    ...(prepared.additionalSkillPaths?.length ? { additionalSkillPaths: [...prepared.additionalSkillPaths] } : {}), ...(prepared.resourcePolicy ? { resourcePolicy: structuredClone(prepared.resourcePolicy) } : {}), ...(prepared.options ? { options: { ...prepared.options } } : {}),
  };
  const native = await createLocalPiSession(input);
  let disposal: Promise<void> | undefined;
  let aborting: Promise<void> | undefined;
  const prompts = new Set<Promise<WorkflowAgentTurnResult>>();
  let disposed = false;
  const startAbort = () => aborting ??= Promise.resolve().then(() => native.abort?.()).then(() => undefined).finally(() => { aborting = undefined; });
  const reference: WorkflowAgentSessionReference = { transport: "local", sessionId: native.sessionId, ...(native.sessionFile ? { locator: { sessionFile: native.sessionFile } } : {}) };
  const session = {
    reference,
    getState: () => Object.freeze(workflowAgentState(native, prepared)),
    getSessionStats: () => workflowAgentStats(native.getSessionStats()),
    subscribe(listener: (event: WorkflowAgentSessionEvent) => void) { listener({ type: "state_changed", state: workflowAgentState(native, prepared) }); return native.subscribe?.((event) => { listener(localSessionEvent(event)); }) ?? (() => undefined); },
    getLastAssistant: () => latestUsableAssistant(native.messages),
    async prompt(text: string) {
      if (disposed) throw new WorkflowError("INTERNAL_ERROR", "Local workflow session is disposed");
      const prompt = Promise.resolve().then(async () => { await native.prompt(text); const assistant = latestUsableAssistant(native.messages); return assistant ? { assistant } : {}; });
      prompts.add(prompt);
      try { return await prompt; } finally { prompts.delete(prompt); }
    },
    async steer(text: string) { if (!native.steer) throw new WorkflowError("INTERNAL_ERROR", "Local workflow session does not support steering"); await native.steer(text); },
    async abort() { if (disposed) return; await startAbort(); },
    async dispose() {
      disposal ??= (async () => {
        disposed = true;
        try { await startAbort(); } catch { /* Abort failure must not prevent the prompt from settling. */ }
        await Promise.allSettled(prompts);
        native.dispose();
      })();
      await disposal;
    },
  };
  return session;
}
export const localAgentTransport: AgentTransport = Object.freeze({ id: "local", createSession: createLocalWorkflowAgentSession });
function changedOption(options: Readonly<Record<string, JsonValue>>, baseline: Readonly<Record<string, JsonValue>>, key: string): boolean { return JSON.stringify(options[key]) !== JSON.stringify(baseline[key]); }
function validThinking(value: unknown): value is ThinkingLevel { return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value); }
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
  return { skills: [...policy.effective.skills], extensions: [...policy.effective.extensions], excludedSkills: [...(policy.excludedSkills ?? [])], excludedExtensions: [...(policy.excludedExtensions ?? [])], unmatchedSkills: [...policy.unmatchedSkills], unmatchedExtensions: [...policy.unmatchedExtensions] };
}
function resourcePolicyWidened(ceiling: AgentResourcePolicy | undefined, candidate: AgentResourcePolicy | undefined): boolean {
  if (!ceiling) return false;
  if (!candidate) return true;
  if (!ceiling.projectTrusted && candidate.projectTrusted) return true;
  return ceiling.effective.skills.some((pattern) => !candidate.effective.skills.includes(pattern)) || ceiling.effective.extensions.some((pattern) => !candidate.effective.extensions.includes(pattern));
}
function preparedAgentSession(input: SessionInput): Readonly<PreparedAgentSession> {
  const prepared = {
    cwd: input.cwd, model: Object.freeze({ ...input.model }), tools: Object.freeze([...input.tools]), sessionLabel: input.sessionLabel,
    ...(input.agentDir ? { agentDir: input.agentDir } : {}), ...(input.customTools?.length ? { customTools: Object.freeze([...input.customTools]) } : {}), ...(input.resultTool ? { resultTool: input.resultTool } : {}), ...(input.options ? { options: Object.freeze(structuredClone(input.options)) } : {}),
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }), ...(input.systemPromptAppend ? { systemPromptAppend: input.systemPromptAppend } : {}),
    ...(input.extensionFactories?.length ? { extensionFactories: Object.freeze([...input.extensionFactories]) } : {}), ...(input.additionalSkillPaths?.length ? { additionalSkillPaths: Object.freeze([...input.additionalSkillPaths]) } : {}),
    ...(input.resourcePolicy ? { resourcePolicy: Object.freeze(structuredClone(input.resourcePolicy)) } : {}),
  };
  return deepFreeze(prepared);
}
function agentSetupSummary(setup: AgentSetup, hookNames: readonly string[]): AgentSetupSummary {
  const model = setup.sessionInput.model;
  return { hookNames: [...hookNames], model: { provider: model.provider, model: model.model, ...(model.thinking ? { thinking: model.thinking } : {}) }, tools: [...setup.sessionInput.tools], cwd: setup.sessionInput.cwd, ...(setup.sessionInput.resourcePolicy ? { disabledAgentResources: resourcePolicySummary(setup.sessionInput.resourcePolicy) } : {}) };
}
type PreparedAgentSetup = { setup: AgentSetup; summary: AgentSetupSummary; failure?: { error: unknown } };
async function prepareAgentSetup(root: AgentExecutionRoot, transport: AgentTransport, task: string, options: AgentExecutionOptions, resolved: { model: ModelSpec; tools: readonly string[]; systemPrompt?: string; systemPromptAppend: string }, cwd: string, attempt: number, signal: AbortSignal | undefined, customTools: readonly ToolDefinition[], resultTool: ToolDefinition | undefined): Promise<PreparedAgentSetup> {
  const setupSignal = signal ?? root.runContext?.signal ?? new AbortController().signal;
  const baselineOptions = structuredClone(options.agentOptions ?? {});
  const baseResourcePolicy = await root.agentResourcePolicy?.();
  const roleExclusions = options.role ? root.agentDefinitions?.[options.role]?.disabledAgentResources : undefined;
  const resourcePolicy = baseResourcePolicy && roleExclusions ? { ...baseResourcePolicy, effective: mergeAgentResourceExclusions(baseResourcePolicy.effective, roleExclusions) } : baseResourcePolicy;
  const resourcePolicyCeiling = resourcePolicy ? structuredClone(resourcePolicy) : undefined;
  const sessionInput: SessionInput = { cwd, model: { ...resolved.model }, tools: [...resolved.tools], sessionLabel: `${options.workflowName}:${options.label}:attempt-${String(attempt)}`, ...(root.agentDir ? { agentDir: root.agentDir } : {}), ...(root.additionalSkillPaths?.length ? { additionalSkillPaths: [...root.additionalSkillPaths] } : {}), ...(customTools.length ? { customTools: [...customTools] } : {}), ...(resultTool ? { resultTool } : {}), ...(resolved.systemPrompt !== undefined ? { systemPrompt: resolved.systemPrompt } : {}), systemPromptAppend: resolved.systemPromptAppend, ...(resourcePolicy ? { resourcePolicy } : {}), options: structuredClone(baselineOptions) };
  const setup = { prompt: task, options: sessionInput.options ?? {}, sessionInput, prepared: preparedAgentSession(sessionInput), transport };
  const base = fallbackSetupContext(root, options, setupSignal);
  const context = Object.freeze({ run: base.run, identity: base.identity, attempt, signal: setupSignal });
  const hookNames: string[] = [];
  for (const hook of [...(root.agentSetupHooks ?? [])].sort((left, right) => left.priority - right.priority || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    if (setupSignal.aborted) return { setup, summary: agentSetupSummary(setup, hookNames), failure: { error: new WorkflowError("CANCELLED", "Agent cancelled") } };
    try { await hook.setup(setup, context); } catch (error) {
      setup.prepared = preparedAgentSession(setup.sessionInput);
      return { setup, summary: agentSetupSummary(setup, hookNames), failure: { error: setupSignal.reason !== undefined ? new WorkflowError("CANCELLED", "Agent cancelled") : error } };
    }
    setup.prepared = preparedAgentSession(setup.sessionInput);
    hookNames.push(hook.name);
    if (setupSignal.reason !== undefined) return { setup, summary: agentSetupSummary(setup, hookNames), failure: { error: new WorkflowError("CANCELLED", "Agent cancelled") } };
  }
  try {
    if (resourcePolicyWidened(resourcePolicyCeiling, setup.sessionInput.resourcePolicy)) throw new WorkflowError("INVALID_METADATA", "Agent setup widened the prepared resource policy");
    setup.sessionInput.options = setup.options;
    if (changedOption(setup.options, baselineOptions, "model") && typeof setup.options.model === "string") setup.sessionInput.model = parseModel(setup.options.model, setup.sessionInput.model, changedOption(setup.options, baselineOptions, "thinking") && validThinking(setup.options.thinking) ? setup.options.thinking : undefined, root.modelAliases, root.knownModels ?? root.availableModels, root.settingsPath);
    if (changedOption(setup.options, baselineOptions, "thinking") && validThinking(setup.options.thinking)) setup.sessionInput.model = { ...setup.sessionInput.model, thinking: setup.options.thinking };
    if (changedOption(setup.options, baselineOptions, "tools") && Array.isArray(setup.options.tools) && setup.options.tools.every((tool) => typeof tool === "string")) setup.sessionInput.tools = [...setup.options.tools];
    if (changedOption(setup.options, baselineOptions, "cwd") && typeof setup.options.cwd === "string") setup.sessionInput.cwd = setup.options.cwd;
    const customToolNames = new Set([...(setup.sessionInput.customTools ?? []).map(({ name }) => name), ...(setup.sessionInput.resultTool ? [setup.sessionInput.resultTool.name] : [])]);
    const widened = setup.sessionInput.tools.find((tool) => !resolved.tools.includes(tool) && !customToolNames.has(tool));
    const outsideTool = widened ?? setup.sessionInput.tools.find((tool) => !root.tools.has(tool) && !customToolNames.has(tool));
    if (outsideTool) throw new WorkflowError("UNKNOWN_TOOL", `Tool is outside the prepared agent policy: ${outsideTool}`);
  } catch (error) {
    setup.prepared = preparedAgentSession(setup.sessionInput);
    return { setup, summary: agentSetupSummary(setup, hookNames), failure: { error } };
  }
  setup.prepared = preparedAgentSession(setup.sessionInput);
  return { setup, summary: agentSetupSummary(setup, hookNames) };
}
function attemptRecord(transport: string, attempt: number, session: WorkflowAgentSession, setup: AgentSetupSummary, stats: AgentAccounting, result?: JsonValue, error?: { code: string; message: string }): AgentAttempt {
  return { attempt, transport, session: session.reference, ...(result === undefined ? {} : { result }), ...(error ? { error } : {}), accounting: stats, setup };
}
function errorWithAttempts(error: unknown, attempts: readonly AgentAttempt[]): Error {
  const typed = error instanceof Error ? error : new Error(typeof error === "string" ? error : String(error));
  return Object.assign(typed, { attempts });
}
export class WorkflowAgentExecutor {
  private readonly transport: AgentTransport;
  constructor(private readonly root: AgentExecutionRoot, transport: AgentTransport = localAgentTransport) { this.transport = transport; }
  setRunContext(runContext: Readonly<WorkflowRunContext>): void { this.root.runContext = runContext; }

  resolve(options: AgentExecutionOptions, inheritedTools?: readonly string[]): { model: ModelSpec; requestedModel?: string; tools: readonly string[]; systemPrompt?: string; systemPromptAppend: string } {
    const role = options.role;
    const definition = role ? this.root.agentDefinitions?.[role] : undefined;
    if (role && !definition) throw new WorkflowError("UNKNOWN_AGENT_TYPE", `Unknown agent role: ${role}`);
    if (role && (options.model !== undefined || options.thinking !== undefined || options.tools !== undefined)) throw new WorkflowError("INVALID_METADATA", "Role agents must not specify model, thinking, or tools");
    const requested = options.tools !== undefined ? options.tools : definition?.tools !== undefined ? definition.tools : options.effectiveTools !== undefined ? options.effectiveTools : inheritedTools !== undefined ? inheritedTools : [...this.root.tools];
    const forbidden = requested.find((tool) => !this.root.tools.has(tool));
    if (forbidden) throw new WorkflowError("UNKNOWN_TOOL", `Tool is outside the launching session boundary: ${forbidden}`);
    const requestedModel = options.model ?? definition?.model;
    const alias = requestedModel === undefined ? undefined : modelAliasName(requestedModel, this.root.modelAliases ?? {});
    const blockedAlias = requestedModel?.split(":", 1)[0];
    if (requestedModel !== undefined && blockedAlias && this.root.blockedAliases?.has(blockedAlias) && !alias) { const target = this.root.blockedAliasTargets?.[blockedAlias]; throw new WorkflowError("UNKNOWN_MODEL", `Unknown model alias ${requestedModel}${target ? ` resolved to ${target}` : ""}${this.root.settingsPath ? ` (settings: ${this.root.settingsPath})` : ""}`); }
    const aliasThinking = requestedModel !== undefined && alias ? resolveModelReference(requestedModel, this.root.modelAliases, this.root.knownModels ?? this.root.availableModels, this.root.settingsPath).thinking : undefined;
    const model = options.modelOverride ?? parseModel(requestedModel, this.root.model, options.thinking ?? (aliasThinking === undefined ? definition?.thinking : undefined), this.root.modelAliases, this.root.knownModels ?? this.root.availableModels, this.root.settingsPath);
    const availableModels = this.root.knownModels ?? this.root.availableModels ?? new Set([modelCapability(this.root.model)]);
    if (!availableModels.has(modelCapability(model))) throw new WorkflowError("UNKNOWN_MODEL", `Unknown model${requestedModel ? ` ${requestedModel} resolved to ${modelCapability(model)}` : ""}${this.root.settingsPath ? ` (settings: ${this.root.settingsPath})` : ""}`);
    const overrideSystemPrompt = definition?.overrideSystemPrompt === true;
    return { model, ...(alias && requestedModel ? { requestedModel } : {}), tools: [...requested], ...(overrideSystemPrompt ? { systemPrompt: definition.prompt ?? "" } : {}), systemPromptAppend: overrideSystemPrompt ? "" : definition?.prompt ?? "" };
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
    const attempts: AgentAttempt[] = [];
    let maxAttempts = (options.retries ?? 0) + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const attemptSignal = executionSignal ?? new AbortController().signal;
      if (recoveryModel) resolved = this.resolve({ ...options, modelOverride: recoveryModel });
      options.budget?.beforeAttempt();
      let schemaResult: JsonValue | undefined;
      let session: WorkflowAgentSession | undefined;
      let setup: AgentSetup | undefined;
      let setupSummary: AgentSetupSummary = { hookNames: [], model: { ...resolved.model }, tools: [...resolved.tools], cwd };
      let setupFailed = false;
      let budgetError: WorkflowError | undefined;
      const hasSchemaResult = () => schemaResult !== undefined;
      const resultTool = options.schema ? {
        name: "workflow_result", label: "Workflow Result", description: "Submit the terminal structured workflow result", parameters: Type.Unsafe(options.schema),
        async execute(_id: string, value: unknown) {
          if (!Value.Check(options.schema as object, value)) return { content: [{ type: "text" as const, text: "Result does not match the required schema." }], details: {}, isError: true };
          if (schemaResult !== undefined) return { content: [{ type: "text" as const, text: "Result has already been accepted." }], details: {}, isError: true };
          schemaResult = structuredClone(value) as JsonValue;
          const currentSession = session;
          if (currentSession) void currentSession.abort();
          return { content: [{ type: "text" as const, text: "Result accepted." }], details: {} };
        },
      } as ToolDefinition : undefined;
      const toolCalls = new Map<string, AgentToolCallProgress>();
      let activity: AgentActivity | undefined;
      let lastEventAt: number | undefined;
      let lastReportedEventAt: number | undefined;
      let progress = Promise.resolve();
      let unsubscribe: (() => void) | undefined;
      let systemPromptTurn = 0;
      let systemPromptWrite = Promise.resolve();
      let systemPromptWriteError: unknown;
      let turnStarted = false;
      let completedAttempt: AgentAttempt | undefined;
      const flushSystemPrompts = async () => {
        await systemPromptWrite;
        if (systemPromptWriteError) throw new WorkflowError("INTERNAL_ERROR", `Failed to persist effective system prompt: ${systemPromptWriteError instanceof Error ? systemPromptWriteError.message : typeof systemPromptWriteError === "string" ? systemPromptWriteError : "unknown error"}`);
      };
      const report = (persist: boolean) => {
        if (!session || !options.onProgress) return;
        const update = { accounting: accounting(session.getSessionStats()), toolCalls: [...toolCalls.values()], state: session.getState(), ...(activity ? { activity } : {}), ...(lastEventAt === undefined ? {} : { lastEventAt }), persist };
        if (lastEventAt !== undefined) lastReportedEventAt = lastEventAt;
        progress = progress.then(() => options.onProgress?.(update)).then(() => undefined);
      };
      const reportTimestamp = () => {
        if (lastEventAt !== undefined && lastReportedEventAt !== undefined && lastEventAt - lastReportedEventAt < 1000) return;
        report(false);
      };
      const activityChanged = (previous: AgentActivity | undefined) => previous?.kind !== activity?.kind || previous?.text !== activity?.text;
      try {
        setupFailed = true;
        const prepared = await prepareAgentSetup(this.root, this.transport, task, options, resolved, cwd, attempt, attemptSignal, customTools, resultTool);
        setup = prepared.setup;
        setupSummary = prepared.summary;
        if (prepared.failure) throw prepared.failure.error;
        setupFailed = false;
        if (attemptSignal.aborted) throw new WorkflowError("CANCELLED", "Agent cancelled");
        const started = Date.now();
        const transportSignal = attemptSignal;
        await options.onAttempt?.({ attempt, transport: setup.transport.id, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, setup: setupSummary });
        const transportBase = fallbackSetupContext(this.root, options, transportSignal);
        const createdSession = await setup.transport.createSession(setup.prepared, Object.freeze({ run: transportBase.run, identity: transportBase.identity, attempt, signal: transportSignal }));
        if (createdSession.reference.transport !== setup.transport.id) {
          await createdSession.dispose();
          throw new WorkflowError("INTERNAL_ERROR", `Agent transport ${setup.transport.id} created a session for ${createdSession.reference.transport}`);
        }
        session = createdSession;
        await options.onAttempt?.({ attempt, transport: setup.transport.id, session: session.reference, liveSession: session, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, setup: setupSummary });
        const preparedTools = new Set([...setup.prepared.tools, ...(setup.prepared.customTools ?? []).map(({ name }) => name), ...(setup.prepared.resultTool ? [setup.prepared.resultTool.name] : [])]);
        if (session.getState().tools.some((tool) => !preparedTools.has(tool))) throw new WorkflowError("INTERNAL_ERROR", `Agent transport ${setup.transport.id} widened the prepared tool policy`);
        if (setup.sessionInput.resourcePolicy) setupSummary = { ...setupSummary, disabledAgentResources: resourcePolicySummary(setup.sessionInput.resourcePolicy) };
        const activeSession = session;
        let lastAssistant: WorkflowAgentMessage | undefined;
        const acceptAssistant = (candidate: WorkflowAgentMessage | undefined) => {
          if (isEmptyAbortedAssistant(candidate)) {
            const previous = (activeSession as WorkflowAgentSession & { getLastAssistant?: () => WorkflowAgentMessage | undefined }).getLastAssistant?.();
            if (previous && !isEmptyAbortedAssistant(previous)) lastAssistant = previous;
          } else if (candidate) lastAssistant = candidate;
        };
        const recoverTerminal = () => recoverTerminalProviderError(activeSession, options.label, options.providerErrorRecovery, async () => { try { acceptAssistant((await promptWithProviderPause(activeSession, providerContinuationPrompt, remaining(options.timeoutMs, started), attemptSignal, this.root.providerPause)).assistant); } catch (error) { acceptAssistant((activeSession as WorkflowAgentSession & { getLastAssistant?: () => WorkflowAgentMessage | undefined }).getLastAssistant?.() ?? lastAssistant); if (!hasSchemaResult()) throw error; } }, () => lastAssistant);
        const promptAndRecover = async (prompt: string): Promise<void> => {
          let promptFailed = false;
          let promptError: unknown;
          try { acceptAssistant((await promptWithProviderPause(activeSession, prompt, remaining(options.timeoutMs, started), attemptSignal, this.root.providerPause)).assistant); } catch (error) { acceptAssistant((activeSession as WorkflowAgentSession & { getLastAssistant?: () => WorkflowAgentMessage | undefined }).getLastAssistant?.() ?? lastAssistant); promptFailed = true; promptError = error; }
          const recovered = await recoverTerminal();
          if (promptFailed && !hasSchemaResult() && !recovered) throw promptError;
        };
        unsubscribe = activeSession.subscribe((event) => {
          lastEventAt = Date.now();
          let persist = false;
          let shouldReport = false;
          let removeToolCallId: string | undefined;
          if (event.type === "agent_start" && session?.getState().systemPrompt !== undefined) {
            if (this.root.runStore) {
              systemPromptTurn += 1;
              const entry = { sessionId: session.reference.sessionId, attempt, turn: systemPromptTurn, prompt: session.getState().systemPrompt ?? "" };
              systemPromptWrite = systemPromptWrite.then(() => this.root.runStore?.recordSystemPrompt(entry)).then(() => undefined).catch((error: unknown) => { systemPromptWriteError ??= error; });
            }
          }
          if (event.type === "state_changed") { shouldReport = true; persist = true; }
          if (event.type === "turnStarted" || event.type === "turn_started") { if (!turnStarted) { try { options.budget?.beforeTurn(); turnStarted = true; } catch (error) { budgetError ??= error instanceof WorkflowError ? error : new WorkflowError("BUDGET_EXHAUSTED", error instanceof Error ? error.message : String(error)); void activeSession.abort(); } } }
          if (event.type === "message_start" && event.message?.role === "assistant") {
            if (!turnStarted) { try { options.budget?.beforeTurn(); turnStarted = true; } catch (error) { budgetError ??= error instanceof WorkflowError ? error : new WorkflowError("BUDGET_EXHAUSTED", error instanceof Error ? error.message : String(error)); void activeSession.abort(); } }
            activity = { kind: "text", text: "responding" };
            shouldReport = true;
          }
          if (event.type === "message_update") {
            const previousActivity = activity;
            const updateType = event.assistantMessageEvent?.type;
            if (updateType && ["thinking_start", "thinking_delta", "thinking_end"].includes(updateType)) activity = { kind: "reasoning", text: "reasoning" };
            else if (updateType && ["text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end"].includes(updateType)) activity = { kind: "text", text: "responding" };
            shouldReport = activityChanged(previousActivity);
          }
          if (event.type === "message_end") {
            const previousActivity = activity;
            activity = undefined;
            shouldReport = activityChanged(previousActivity);
            if (event.message?.role === "assistant") {
              acceptAssistant(event.message);
              const needsMoreWork = hasToolCall(event.message);
              const final = !needsMoreWork || (options.schema !== undefined && hasSchemaResult());
              if (!budgetError) { try { options.budget?.afterTurn(accounting(activeSession.getSessionStats()), final); if (!final) { const instruction = options.budget?.instruction(); if (instruction) void activeSession.steer(instruction); } } catch (error) { budgetError ??= error instanceof WorkflowError ? error : new WorkflowError("BUDGET_EXHAUSTED", error instanceof Error ? error.message : String(error)); void activeSession.abort(); } }
              turnStarted = false;
              persist = true;
            }
          }
          if (event.type === "tool_execution_start" && event.toolCallId && event.toolName) { toolCalls.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, state: "running" }); activity = { kind: "tool", text: event.toolName }; shouldReport = true; }
          if (event.type === "tool_execution_update" && event.toolName) { const previousActivity = activity; activity = { kind: "tool", text: event.toolName }; shouldReport = activityChanged(previousActivity); }
          if (event.type === "tool_execution_end" && event.toolCallId && event.toolName) { toolCalls.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, state: event.isError ? "failed" : "completed" }); if (activity?.kind === "tool" && activity.text === event.toolName) activity = undefined; shouldReport = true; removeToolCallId = event.toolCallId; }
          if (shouldReport || persist) report(persist); else reportTimestamp();
          if (removeToolCallId) toolCalls.delete(removeToolCallId);
        });
        report(false);
        if (setSteer) {
          setSteer((message) => activeSession.steer(message));
        }
        const context = [`Workflow: ${options.workflowName}`, `Agent: ${options.label}`, options.phase ? `Phase: ${options.phase}` : "", options.parent ? `Parent: ${options.parent}` : "", "You own this task and any direct child agents you create. Return child results to your parent; do not leave descendants running.", attempt > 1 ? `Retry attempt ${String(attempt)}. Previous state: ${options.retryState ?? attempts.at(-1)?.error?.message ?? "failed attempt"}` : ""].filter(Boolean).join("\n");
        const instruction = options.budget?.instruction();
        const promptText = `${context}\n\nTask:\n${setup.prompt}${instruction ? `\n\n${instruction}` : ""}`;
        options.budget?.beforeTurn();
        turnStarted = true;
        await promptAndRecover(promptText);
        { const completedAccounting = accounting(session.getSessionStats()); options.budget?.afterTurn(completedAccounting, options.schema !== undefined ? hasSchemaResult() : !latestAssistantHasToolCall(lastAssistant)); turnStarted = false; }
        if (budgetError) throw budgetError;
        if (options.schema) {
          if (!hasSchemaResult()) {
            options.budget?.beforeTurn();
            turnStarted = true;
            await promptAndRecover("Submit the final result now by calling workflow_result exactly once. Do not return prose.");
            { const completedAccounting = accounting(session.getSessionStats()); options.budget?.afterTurn(completedAccounting, true); turnStarted = false; }
          }
          if (!hasSchemaResult()) {
            options.budget?.beforeTurn();
            turnStarted = true;
            await promptAndRecover("Your result was missing or invalid. Repair it by calling workflow_result exactly once with a schema-valid value.");
            { const completedAccounting = accounting(session.getSessionStats()); options.budget?.afterTurn(completedAccounting, true); turnStarted = false; }
          }
          if (schemaResult === undefined) throw new WorkflowError("RESULT_INVALID", "Agent did not submit a valid workflow_result after one repair");
        }
        const value = options.schema ? schemaResult as JsonValue : text(lastAssistant);
        if (options.worktreeOwner) await this.root.runStore?.snapshotWorktree(options.worktreeOwner);
        report(true);
        await progress;
        await flushSystemPrompts();
        unsubscribe();
        const attemptAccounting = accounting(session.getSessionStats());
        completedAttempt = attemptRecord(setup.transport.id, attempt, session, setupSummary, attemptAccounting, value);
        attempts.push(completedAttempt);
        try { await options.onAttempt?.(completedAttempt); } finally { await session.dispose(); }
        return { value, attempts, cwd: setupSummary.cwd };
      } catch (error) {
        if (completedAttempt) throw errorWithAttempts(error, attempts);
        const typed = budgetError ?? (error instanceof WorkflowError ? error : new WorkflowError(attemptSignal.aborted && setupFailed ? "CANCELLED" : "AGENT_FAILED", error instanceof Error ? error.message : String(error)));
        if (!session) {
          const failedAttempt: AgentAttempt = { attempt, transport: setup?.transport.id ?? this.transport.id, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, error: { code: typed.code, message: typed.message }, setup: setupSummary };
          attempts.push(failedAttempt);
          try { await options.onAttempt?.(failedAttempt); } catch (persistenceError) { throw errorWithAttempts(persistenceError, attempts); }
        }
        if (session) {
          report(true);
          await progress.catch(() => undefined);
          try { await flushSystemPrompts(); } catch { /* Preserve the agent failure that prompted this cleanup. */ }
          unsubscribe?.();
          const attemptAccounting = accounting(session.getSessionStats());
          if (!budgetError && typed.code !== "BUDGET_EXHAUSTED") { try { options.budget?.afterTurn(attemptAccounting, true); } catch (budgetFailure) { budgetError ??= budgetFailure instanceof WorkflowError ? budgetFailure : new WorkflowError("BUDGET_EXHAUSTED", budgetFailure instanceof Error ? budgetFailure.message : String(budgetFailure)); } }
          const failedAttempt = attemptRecord(setup?.transport.id ?? this.transport.id, attempt, session, setupSummary, attemptAccounting, undefined, { code: typed.code, message: typed.message });
          attempts.push(failedAttempt);
          try {
            try { await options.onAttempt?.(failedAttempt); } finally { await session.dispose(); }
          } catch (persistenceError) {
            throw errorWithAttempts(persistenceError, attempts);
          }
        }
        if (options.worktreeOwner && typed.code !== "WORKTREE_FAILED") await this.root.runStore?.snapshotWorktree(options.worktreeOwner).catch(() => undefined);
        const terminal = terminalProviderError(typed);
        const recoveryState = typed as WorkflowError & ProviderRecoveryMarker;
        let recovery = recoveryState.providerRecovery;
        if (terminal && options.providerErrorRecovery && !recoveryState.providerRecoveryHandled) {
          try { recovery = await options.providerErrorRecovery({ label: options.label, ...terminal }); } catch { throw Object.assign(typed, { attempts }); }
          if (recovery === "retry") {
            maxAttempts += 1;
            beforeRetry?.();
            continue;
          }
        }
        if (recoveryState.providerRecoveryFailed || recovery === "abort") throw Object.assign(typed, { attempts });
        if (typeof recovery === "object" && typeof recovery.model === "string") {
          try {
            const selected = resolveModelReference(recovery.model, this.root.modelAliases, this.root.knownModels ?? this.root.availableModels, this.root.settingsPath);
            recoveryModel = selected.thinking === undefined && resolved.model.thinking ? { ...selected, thinking: resolved.model.thinking } : selected;
          } catch { throw Object.assign(typed, { attempts }); }
          maxAttempts += 1;
          beforeRetry?.();
          continue;
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
  prompt?: string;
  options: Readonly<ScheduledAgentOptions>;
  children: Set<string>;
  collected: boolean;
  collecting: boolean;
  state: "queued" | "running" | "waiting_for_child" | "paused" | "retrying" | "completed" | "failed" | "cancelled";
  controller: AbortController;
  promise: Promise<ScheduledAgentResult> | undefined;
  resolve: ((result: ScheduledAgentResult) => void) | undefined;
  completion: Promise<void>;
  resolveCompletion: () => void;
  task: () => Promise<void>;
  restored: boolean;
  steer?: (message: string) => void | Promise<void>;
};

type ScheduledRun = { limit: number; beforeLaunch?: () => void; logical: number; active: number; queue: Array<{ node?: ScheduledNode; start: () => void }> };
export type OwnershipRecord = { id: string; parentId?: string; prompt?: string; label: string; state: ScheduledNode["state"]; options: Readonly<ScheduledAgentOptions> };
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
  updateRunLimit(runId: string, limit: number): void {
    const run = this.#runs.get(runId);
    if (!run) throw new WorkflowError("INTERNAL_ERROR", `Unknown scheduler run: ${runId}`);
    if (!Number.isInteger(limit) || limit < 1 || limit > this.sessionLimit) throw new WorkflowError("INVALID_SETTINGS", "Invalid run concurrency");
    run.limit = limit;
    this.#dispatch();
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
    let resolveCompletion: () => void = () => undefined;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const node: ScheduledNode = { id, runId, ...(parentId ? { parentId } : {}), prompt, options: effective, children: new Set<string>(), collected: false, collecting: false, state: "queued", controller: new AbortController(), promise, resolve: resolveResult, completion, resolveCompletion, task: async () => undefined, restored: false };
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
    if (child.collected || !child.promise) throw new WorkflowError("AGENT_RESULT_COLLECTED", "Child result has already been collected; nested results are one-shot");
    if (child.collecting) throw new WorkflowError("AGENT_FAILED", "Child result is already being collected");
    child.collecting = true;
    const childPromise = child.promise;
    try {
      parent.state = "waiting_for_child";
      this.#persist(parent.runId);
      this.#release(parent.runId);
      const outcome = await childPromise;
      await new Promise<void>((resolve) => { this.#enqueue(parent.runId, undefined, () => { resolve(); }); });
      parent.state = "running";
      if (parent.controller.signal.aborted) throw new WorkflowError("CANCELLED", "Parent agent cancelled");
      child.collected = true;
      child.collecting = false;
      this.releaseResult(child.id);
      this.#persist(parent.runId);
      return outcome;
    } catch (error) {
      child.collecting = false;
      throw error;
    }
  }

  async steer(parentId: string, childId: string, message: string): Promise<void> {
    const child = this.#node(childId);
    if (child.parentId !== parentId) throw new WorkflowError("UNKNOWN_AGENT_TYPE", "Steering is scoped to direct children");
    if (child.state !== "running" && child.state !== "waiting_for_child") throw new WorkflowError("AGENT_FAILED", "Child is not running");
    if (!child.steer) throw new WorkflowError("AGENT_FAILED", "Child has not registered a steering handler");
    await child.steer(message);
  }

  cancel(id: string): void { this.#cancelTree(this.#node(id)); }
  releaseResult(id: string): void {
    const node = this.#nodes.get(id);
    if (!node || !node.promise) return;
    if (!["completed", "failed", "cancelled"].includes(node.state)) throw new WorkflowError("INTERNAL_ERROR", `Cannot release active agent result: ${id}`);
    node.promise = undefined;
    node.task = async () => undefined;
  }
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
    await Promise.all(nodes.map(({ completion }) => completion));
    if (nodes.every(({ restored }) => restored)) run.logical = 0;
  }

  removeRun(runId: string): void {
    const run = this.#runs.get(runId);
    if (!run) return;
    const nodes = [...this.#nodes.values()].filter((node) => node.runId === runId);
    if (run.active > 0 || nodes.some(({ state }) => !["completed", "failed", "cancelled"].includes(state))) throw new WorkflowError("INTERNAL_ERROR", `Cannot remove active scheduler run: ${runId}`);
    for (const { id } of nodes) this.#nodes.delete(id);
    this.#runs.delete(runId);
    const index = this.#runOrder.indexOf(runId);
    if (index >= 0) {
      this.#runOrder.splice(index, 1);
      if (index < this.#cursor) this.#cursor -= 1;
      if (this.#cursor >= this.#runOrder.length) this.#cursor = 0;
    }
    this.#dispatch();
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
      name: "get_subagent_result", label: "Child Result", description: "Wait for a direct child and return its result once; repeated retrieval fails with AGENT_RESULT_COLLECTED",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id: string, params: { id: string }) => { const value = await this.result(parentId, params.id); if (!value.ok && value.error.code === "BUDGET_EXHAUSTED") throw new WorkflowError("BUDGET_EXHAUSTED", value.error.message); return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value }; }
    } as ToolDefinition;
    const steerTool = {
      name: "steer_subagent", label: "Steer Child", description: "Steer a running direct child",
      parameters: Type.Object({ id: Type.String(), message: Type.String() }),
      execute: async (_id: string, params: { id: string; message: string }) => { await this.steer(parentId, params.id, params.message); return { content: [{ type: "text" as const, text: "Steering delivered." }], details: {} }; },
    } as ToolDefinition;
    return [agentTool, resultTool, steerTool];
  }

  snapshot(): readonly OwnershipRecord[] {
    return [...this.#nodes.values()].map(({ id, parentId, prompt, options, state }) => ({ id, ...(parentId ? { parentId } : {}), ...(prompt === undefined ? {} : { prompt }), label: options.label, state, options }));
  }

  restoreRun(runId: string, limit: number, ownership: readonly OwnershipRecord[], beforeLaunch?: () => void): void {
    this.addRun(runId, limit, beforeLaunch);
    const run = this.#runs.get(runId) as ScheduledRun;
    for (const record of ownership) {
      if (record.id.split(":").slice(0, -1).join(":") !== runId) throw new WorkflowError("RESUME_INCOMPATIBLE", `Persisted agent belongs to another run: ${record.id}`);
      let resolveResult: (result: ScheduledAgentResult) => void = () => undefined;
      const promise = new Promise<ScheduledAgentResult>((resolve) => { resolveResult = resolve; });
      let resolveCompletion: () => void = () => undefined;
      const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
      const node: ScheduledNode = { id: record.id, runId, ...(record.parentId ? { parentId: record.parentId } : {}), ...(record.prompt === undefined ? {} : { prompt: record.prompt }), options: this.#inherit(undefined, record.options), children: new Set(), collected: false, collecting: false, state: record.state, controller: new AbortController(), promise, resolve: resolveResult, completion, resolveCompletion, task: async () => undefined, restored: true };
      this.#nodes.set(node.id, node);
      run.logical += 1;
      this.#nextId = Math.max(this.#nextId, Number(node.id.slice(node.id.lastIndexOf(":") + 1)) || 0);
      if (record.state === "completed") { resolveResult({ id: node.id, ok: true, value: null }); resolveCompletion(); }
      else if (record.state === "failed" || record.state === "cancelled") { resolveResult({ id: node.id, ok: false, error: { code: record.state === "cancelled" ? "CANCELLED" : "AGENT_FAILED", message: `Persisted agent ${record.state}` } }); resolveCompletion(); }
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
    Reflect.deleteProperty(node, "steer");
    this.#persist(node.runId);
    if (heldPermit) this.#release(node.runId);
    for (const childId of node.children) { const child = this.#nodes.get(childId); if (child && !child.collected) this.#cancelTree(child); }
    const resolve = node.resolve;
    node.resolve = undefined;
    resolve?.(result);
    node.resolveCompletion();
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

function remaining(timeoutMs: number | null | undefined, started: number): number | null | undefined {
  return timeoutMs === null || timeoutMs === undefined ? timeoutMs : Math.max(1, timeoutMs - (Date.now() - started));
}

function providerLimited(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { status?: unknown; code?: unknown };
  return candidate.status === 429 || candidate.code === 429 || candidate.code === "rate_limit_exceeded" || candidate.code === "RATE_LIMITED";
}

async function promptWithProviderPause(session: WorkflowAgentSession, text: string, timeoutMs: number | null | undefined, signal: AbortSignal | undefined, pause?: () => Promise<void>): Promise<WorkflowAgentTurnResult> {
  for (;;) {
    try { return await withTimeout(session.prompt(text), timeoutMs, signal, session); }
    catch (error) { if (!pause || !providerLimited(error)) throw error; await pause(); }
  }
}

async function withTimeout(work: Promise<WorkflowAgentTurnResult>, timeoutMs: number | null | undefined, signal: AbortSignal | undefined, session: WorkflowAgentSession): Promise<WorkflowAgentTurnResult> {
  if (signal?.aborted) throw new WorkflowError("CANCELLED", "Agent cancelled");
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const state = { interrupted: false };
  const timeout = timeoutMs ? new Promise<never>((_, reject) => { timer = setTimeout(() => { state.interrupted = true; reject(new WorkflowError("AGENT_TIMEOUT", "Agent attempt timed out")); }, timeoutMs); }) : new Promise<never>(() => {});
  const cancelled = signal ? new Promise<never>((_, reject) => { abort = () => { state.interrupted = true; reject(new WorkflowError("CANCELLED", "Agent cancelled")); }; signal.addEventListener("abort", abort, { once: true }); }) : new Promise<never>(() => {});
  try { return await Promise.race([work, timeout, cancelled]); }
  finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); if (state.interrupted) await session.abort(); }
}
