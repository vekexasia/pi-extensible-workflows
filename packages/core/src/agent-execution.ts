import { existsSync, realpathSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import { createAgentSession, DefaultPackageManager, DefaultResourceLoader, defineTool, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { ExtensionContext, ModelRegistry, SessionStartEvent, ToolDefinition } from "@earendil-works/pi-coding-agent";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type HerdrModelContext = { readonly model: ExtensionContext["model"]; readonly modelRegistry: ModelRegistry | undefined };
type AgentMessage = { role: string; content?: unknown; stopReason?: string; errorMessage?: string; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } } };
type LocalSessionShutdownReason = "quit" | "resume";
export interface PiSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly messages: readonly AgentMessage[];
  getSessionStats(): { tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number }; cost: number };
  readonly systemPrompt?: string;
  readonly model?: { provider: string; model?: string; id?: string } | undefined;
  readonly herdrModelContext?: HerdrModelContext;
  readonly thinkingLevel?: string;
  readonly agent?: { state: { tools: readonly { name: string }[] }; subscribe?(listener: (event: unknown) => void | Promise<void>): () => void };
  readonly herdrResourcePaths?: { extensions: readonly string[]; skills: readonly string[] };
  readonly herdrContextFiles?: readonly import("./types.js").ContextFile[];
  preparePrompt(text: string): Promise<PiPromptInspection>;
  getResourceInspection(): PiResourceInspection;
  subscribe?(listener: (event: unknown) => void): () => void;
  prompt(text: string): Promise<void>;
  steer?(text: string): Promise<void>;
  abort?(): Promise<void>;
  dispose(): Promise<void>;
};
export interface PiPromptInspection {
  readonly prompt: string;
  readonly expandedPrompt: string;
  readonly systemPrompt: string;
  readonly messages: readonly unknown[];
  readonly systemPromptOptions: unknown;
  readonly inputHandled: boolean;
  readonly diagnostics: readonly { type: "error"; message: string; source?: string }[];
}
export interface PiResourceInspection {
  readonly extensions: readonly string[];
  readonly skills: readonly string[];
  readonly diagnostics: readonly { type: "warning" | "error" | "collision"; message: string; source?: string }[];
  readonly systemPromptSource?: string;
}
import type { AgentIdentity, AgentResourceExclusions, AgentResourcePolicy, AgentSetup, AgentSetupSummary, AgentTransport, AgentTransportContext, ContextFileScope, JsonSchema, JsonValue, LiveSessionHandoff, ModelSpec, PiRuntimeLaunchInfo, PreparedAgentSession, RegisteredAgentSetupHook, RoleOverride, SessionInput, WorkflowAgentMessage, WorkflowAgentSession, WorkflowAgentSessionEvent, WorkflowAgentSessionReference, WorkflowAgentSessionState, WorkflowAgentSessionStats, WorkflowAgentTurnResult, WorkflowRunContext } from "./types.js";
import { deepFreeze, jsonObject, jsonValue, object, disabledResources, mergeAgentResourceExclusions, modelAliasName, modelCapability, resolveModelReference, unmatchedResourcePatterns } from "./utils.js";
import { roleNameOf } from "./types.js";
import { WorkflowError } from "./types.js";
import { createLiveSessionHandoff } from "./session-handoff.js";
import { normalizePiMessage, normalizePiSessionEvent, runtimeProgressToAgentProgress } from "./pi-runtime-adapter.js";
import { createPiRuntimeAgentRunner, isRuntimeAgentProviderError, normalizePiRuntimeError } from "./pi-runtime-runner.js";
import type { RuntimeAgentProgress, RuntimeUsage } from "./runtime/agent-runner.js";
import { validateSchema } from "./validation.js";
import type { RunStore } from "./persistence.js";
type AgentExecutionRunStore = Pick<RunStore, "recordSystemPrompt" | "validateWorktree" | "worktree" | "snapshotWorktree">;
export type { AgentInspectionMode, AgentSetup, AgentSetupContext, AgentSetupHook, AgentTransport, AgentTransportContext, PiRuntimeLaunchInfo, PreparedAgentSession, RegisteredAgentSetupHook, SessionInput, WorkflowAgentMessage, WorkflowAgentSession, WorkflowAgentSessionEvent, WorkflowAgentSessionReference, WorkflowAgentSessionState, WorkflowAgentSessionStats, WorkflowAgentTurnResult } from "./types.js";
export interface AgentBudgetHooks {
  beforeAttempt(): void;
  beforeTurn(): void;
  afterTurn(accounting: AgentAccounting, final: boolean): void;
  instruction(): string | undefined;
}
export interface AgentDefinition { prompt?: string; description?: string; model?: string; thinking?: ThinkingLevel; tools?: readonly string[]; overrideSystemPrompt?: boolean; contextFiles?: readonly ContextFileScope[]; disabledAgentResources?: AgentResourceExclusions }
export interface AgentProviderFailure { label: string; provider: string; model: string; error: string }
export type AgentProviderRecovery = "retry" | "abort" | { model: string };
export interface AgentExecutionOptions {
  label: string;
  workflowName: string;
  tuiIndex?: number;
  tuiLabel?: string;
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
  role?: string | RoleOverride;
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
  runStore?: AgentExecutionRunStore;
  providerPause?: () => Promise<void>;
  agentSetupHooks?: readonly RegisteredAgentSetupHook[];
  agentResourcePolicy?: () => AgentResourcePolicy | Promise<AgentResourcePolicy>;
  runContext?: Readonly<WorkflowRunContext>;
}
export interface AgentAccounting { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export interface AgentToolCallProgress { id: string; name: string; state: "running" | "completed" | "failed" }
export interface AgentActivity { kind: "reasoning" | "tool" | "text"; text: string }
export interface AgentProgress { accounting: AgentAccounting; toolCalls: readonly AgentToolCallProgress[]; state?: WorkflowAgentSessionState; activity?: AgentActivity; lastEventAt?: number; persist: boolean }
export interface AgentAttempt { attempt: number; transport: string; session?: WorkflowAgentSessionReference; liveSession?: WorkflowAgentSession; prepared?: Readonly<PreparedAgentSession>; handoff?: LiveSessionHandoff; result?: JsonValue; error?: { code: string; message: string }; accounting: AgentAccounting; setup: AgentSetupSummary }
export interface AgentExecutionResult { value: JsonValue; attempts: readonly AgentAttempt[]; cwd: string }

function parseModel(value: string | undefined, fallback: ModelSpec, thinking?: ThinkingLevel, aliases: Readonly<Record<string, string>> = {}, knownModels?: ReadonlySet<string>, settingsPath?: string): ModelSpec {
  if (!value) return { ...fallback, ...(thinking ? { thinking } : {}) };
  const parsed = resolveModelReference(value, aliases, knownModels, settingsPath);
  return { ...parsed, ...(thinking ? { thinking } : !parsed.thinking && fallback.thinking ? { thinking: fallback.thinking } : {}) };
}

function isEmptyAbortedAssistant(message: WorkflowAgentMessage | undefined): boolean { return message?.stopReason === "aborted" && Array.isArray(message.content) && message.content.length === 0; }

function accounting(stats: WorkflowAgentSessionStats): AgentAccounting {
  return { input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite, cost: stats.cost };
}

function canonicalSourcePath(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }
const extensionDirectory = dirname(fileURLToPath(import.meta.url));
const workflowPackageRoot = basename(dirname(extensionDirectory)) === "dist" ? resolve(extensionDirectory, "../..") : resolve(extensionDirectory, "..");
const WORKFLOW_HOST_ENTRIES = new Set([
  canonicalSourcePath(resolve(workflowPackageRoot, "src/index.ts")),
  canonicalSourcePath(resolve(workflowPackageRoot, "dist/src/index.js")),
]);
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
function filterContextFiles(base: readonly { path: string; content: string }[], scopes: readonly ContextFileScope[], cwd: string, agentDir: string): { path: string; content: string }[] {
  const globalPath = resolve(agentDir);
  const cwdPath = resolve(cwd);
  return base.filter(({ path }) => {
    const resolvedPath = resolve(dirname(path));
    return scopes.some((scope) => scope === "global" ? resolvedPath === globalPath : scope === "cwd" ? resolvedPath === cwdPath : resolvedPath !== globalPath && resolvedPath !== cwdPath);
  });
}
type NativePromptTemplateModule = { expandPromptTemplate(text: string, templates: readonly { name: string; content: string }[]): string };
let nativePromptTemplateModule: Promise<NativePromptTemplateModule> | undefined;
function loadNativePromptTemplateModule(): Promise<NativePromptTemplateModule> {
  return nativePromptTemplateModule ??= import(resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "core/prompt-templates.js")).then((module) => module as NativePromptTemplateModule);
}
async function expandPromptTemplateForInspection(text: string, templates: readonly { name: string; content: string }[]): Promise<string> {
  return (await loadNativePromptTemplateModule()).expandPromptTemplate(text, templates);
}
type NativePromptSession = PiSession & {
  readonly _extensionRunner?: { hasHandlers(event: string): boolean; emitInput(text: string, images: undefined, source: "interactive"): Promise<unknown>; emitBeforeAgentStart(prompt: string, images: undefined, systemPrompt: string, options: unknown): Promise<unknown>; onError(listener: (error: unknown) => void): () => void };
  readonly _baseSystemPrompt?: string;
  readonly _baseSystemPromptOptions?: unknown;
  readonly _expandSkillCommand?: (text: string) => string;
  readonly promptTemplates?: readonly { name: string; content: string }[];
};
async function preparePiPrompt(native: PiSession, text: string): Promise<PiPromptInspection> {
  const session = native as NativePromptSession;
  const diagnostics: Array<{ type: "error"; message: string; source?: string }> = [];
  const runner = session._extensionRunner;
  const baseSystemPrompt = typeof session._baseSystemPrompt === "string" ? session._baseSystemPrompt : session.systemPrompt ?? "";
  const baseOptions = session._baseSystemPromptOptions;
  const expandSkillCommand = session._expandSkillCommand;
  const templates = session.promptTemplates;
  if (!runner) diagnostics.push({ type: "error", message: "Pi prompt inspection seam is unavailable: extension runner is missing", source: "Pi session" });
  if (typeof session._baseSystemPrompt !== "string") diagnostics.push({ type: "error", message: "Pi prompt inspection seam is unavailable: base system prompt is missing", source: "Pi session" });
  if (baseOptions === undefined) diagnostics.push({ type: "error", message: "Pi prompt inspection seam is unavailable: base system prompt options are missing", source: "Pi session" });
  if (typeof expandSkillCommand !== "function") diagnostics.push({ type: "error", message: "Pi prompt inspection seam is unavailable: skill expansion is missing", source: "Pi session" });
  if (!Array.isArray(templates)) diagnostics.push({ type: "error", message: "Pi prompt inspection seam is unavailable: prompt templates are missing", source: "Pi session" });
  const unsubscribe = runner?.onError((error) => {
    const value = error as { error?: unknown; extensionPath?: unknown };
    diagnostics.push({ type: "error", message: typeof value.error === "string" ? value.error : String(value.error ?? error), ...(typeof value.extensionPath === "string" ? { source: value.extensionPath } : {}) });
  });
  try {
    let current = text;
    let inputHandled = false;
    if (runner?.hasHandlers("input")) {
      const result = await runner.emitInput(current, undefined, "interactive") as { action?: unknown; text?: unknown };
      if (result.action === "handled") inputHandled = true;
      else if (result.action === "transform" && typeof result.text === "string") current = result.text;
    }
    let expandedPrompt = current;
    if (!inputHandled) {
      const skillExpanded = typeof expandSkillCommand === "function" ? expandSkillCommand.call(session, current) : current;
      try { expandedPrompt = await expandPromptTemplateForInspection(skillExpanded, Array.isArray(templates) ? templates : []); }
      catch (error) { diagnostics.push({ type: "error", message: `Pi prompt template expansion is unavailable: ${error instanceof Error ? error.message : String(error)}`, source: "Pi session" }); }
    }
    const result = !inputHandled && runner && baseOptions !== undefined ? await runner.emitBeforeAgentStart(expandedPrompt, undefined, baseSystemPrompt, baseOptions) : undefined;
    const prepared = result as { messages?: readonly unknown[]; systemPrompt?: unknown } | undefined;
    return { prompt: text, expandedPrompt, systemPrompt: typeof prepared?.systemPrompt === "string" ? prepared.systemPrompt : baseSystemPrompt, systemPromptOptions: baseOptions, messages: prepared?.messages ?? [], inputHandled, diagnostics };
  } finally { unsubscribe?.(); }
}

interface LocalPiSessionHandle { readonly session: PiSession; shutdown(reason: LocalSessionShutdownReason, targetSessionFile?: string): Promise<void> }
export async function createLocalPiSession(input: SessionInput): Promise<PiSession> { return (await createLocalPiSessionHandle(input)).session; }
/**
 * Hands the runtime the providers that extensions registered while loading.
 *
 * An extension that adds models (a proxy front-end, a gateway) registers them
 * from its factory, and the loader parks those registrations on the extension
 * runtime rather than applying them. Pi's own session assembly drains that
 * queue; a workflow agent builds its runtime here by hand, so without this the
 * models an extension provides stay unknown and every agent asking for one
 * fails with UNKNOWN_MODEL.
 */
export function flushExtensionProviders(resourceLoader: DefaultResourceLoader, modelRuntime: ModelRuntime): string[] {
  const { runtime } = resourceLoader.getExtensions();
  const failures: string[] = [];
  for (const { name, config } of runtime.pendingProviderRegistrations) {
    // A provider that cannot be registered must not stop the agent from
    // starting: the model it offers may not be the one this agent asked for.
    // The reason is kept, though — if the model does turn out to be missing,
    // "unknown model" alone sends the reader looking in the wrong place.
    try {
      modelRuntime.registerProvider(name, config);
    } catch (error) {
      failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  runtime.pendingProviderRegistrations = [];
  for (const { provider } of runtime.pendingNativeProviderRegistrations) {
    try {
      modelRuntime.registerNativeProvider(provider);
    } catch (error) {
      failures.push(`${provider.id || "native provider"}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  runtime.pendingNativeProviderRegistrations = [];
  return failures;
}

async function createLocalPiSessionHandle(input: SessionInput, sessionStartEvent?: SessionStartEvent): Promise<LocalPiSessionHandle> {
  const agentDir = input.agentDir ?? getAgentDir();
  const systemPromptSource = workflowSystemPromptPath(input.cwd, agentDir, input.resourcePolicy?.projectTrusted ?? true);
  const systemPromptOptions = input.systemPrompt !== undefined ? { systemPromptOverride: () => input.systemPrompt } : systemPromptSource !== undefined ? { systemPrompt: systemPromptSource } : {};
  const contextFilesOverride = input.contextFiles === undefined ? undefined : (base: { agentsFiles: Array<{ path: string; content: string }> }) => ({ ...base, agentsFiles: filterContextFiles(base.agentsFiles, input.contextFiles ?? [], input.cwd, agentDir) });
  const manager = input.sessionManager ?? (input.sessionPath ? SessionManager.open(input.sessionPath, join(agentDir, "sessions"), input.cwd) : input.agentDir ? SessionManager.create(input.cwd, join(agentDir, "sessions")) : SessionManager.create(input.cwd));
  if (!input.sessionPath) manager.appendSessionInfo(input.sessionLabel);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json") });
  const customTools = [...(input.customTools ?? []), ...(input.resultTool ? [input.resultTool] : [])];
  const tools = [...new Set([...input.tools, ...customTools.map(({ name }) => name)])];
  let settingsManager: SettingsManager;
  let resourceLoader: DefaultResourceLoader;
  const policy = input.resourcePolicy;
  if (policy) {
    settingsManager = SettingsManager.create(input.cwd, agentDir, { projectTrusted: false });
    settingsManager.setProjectTrusted(policy.projectTrusted);
    const packageManager = new DefaultPackageManager({ cwd: input.cwd, agentDir, settingsManager });
    const resolved = await packageManager.resolve();
    const discoveredExtensions = [...new Set(resolved.extensions.filter(({ enabled, metadata }) => enabled && (policy.projectTrusted || metadata.scope !== "project")).map(({ path }) => canonicalSourcePath(path)))];
    const extensionSelectors = policy.effective.extensions.map((selector) => ({ original: selector, matching: canonicalExtensionSelector(selector) }));
    const excludedExtensions = new Set(disabledResources(extensionSelectors.map(({ matching }) => matching), discoveredExtensions));
    const extensionPaths = discoveredExtensions.filter((path) => !excludedExtensions.has(path) && !WORKFLOW_HOST_ENTRIES.has(path));
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
      ...(contextFilesOverride ? { agentsFilesOverride: contextFilesOverride } : {}),
      skillsOverride: (base) => {
        const disabledSkills = updateSkillMatches(base.skills);
        return { ...base, skills: base.skills.filter(({ name }) => !disabledSkills.has(name)) };
      },
      ...(input.systemPromptAppend ? { appendSystemPromptOverride: (base) => [...base, input.systemPromptAppend ?? ""] } : {}),
      ...systemPromptOptions,
    });
    await resourceLoader.reload();
  } else {
    settingsManager = SettingsManager.create(input.cwd, agentDir, { projectTrusted: true });
    const packageManager = new DefaultPackageManager({ cwd: input.cwd, agentDir, settingsManager });
    const resolved = await packageManager.resolve();
    const extensionPaths = [...new Set(resolved.extensions.filter(({ enabled }) => enabled).map(({ path }) => canonicalSourcePath(path)).filter((path) => !WORKFLOW_HOST_ENTRIES.has(path)))];
    resourceLoader = new DefaultResourceLoader({ cwd: input.cwd, agentDir, settingsManager, noExtensions: true, additionalExtensionPaths: extensionPaths, ...(input.additionalSkillPaths?.length ? { additionalSkillPaths: [...input.additionalSkillPaths] } : {}), ...(input.extensionFactories?.length ? { extensionFactories: input.extensionFactories } : {}), ...(contextFilesOverride ? { agentsFilesOverride: contextFilesOverride } : {}), ...systemPromptOptions, ...(input.systemPromptAppend ? { appendSystemPromptOverride: (base) => [...base, input.systemPromptAppend ?? ""] } : {}) });
    await resourceLoader.reload();
  }
  const providerFailures = flushExtensionProviders(resourceLoader, modelRuntime);
  await modelRuntime.refresh({ allowNetwork: false });
  const model = modelRuntime.getModel(input.model.provider, input.model.model);
  if (!model) {
    // A provider that failed to register is the likeliest reason its models are
    // missing, so the failure travels with the complaint rather than being
    // swallowed — otherwise a misconfigured gateway reads as a typo in a model
    // name.
    const because = providerFailures.length > 0 ? ` (provider registration failed — ${providerFailures.join("; ")})` : "";
    throw new WorkflowError("UNKNOWN_MODEL", `Unknown model: ${input.model.provider}/${input.model.model}${because}`);
  }
  const { session } = await createAgentSession({ ...(input.options ?? {}), cwd: input.cwd, agentDir, modelRuntime, model, settingsManager, ...(input.model.thinking ? { thinkingLevel: input.model.thinking } : {}), tools, ...(customTools.length ? { customTools } : {}), ...(input.extensionFactories?.length ? { extensionFactories: input.extensionFactories } : {}), resourceLoader, ...(sessionStartEvent ? { sessionStartEvent } : {}), sessionManager: manager });
  const nativeDispose = session.dispose.bind(session);
  let disposal: Promise<void> | undefined;
  const shutdown = (reason: LocalSessionShutdownReason, targetSessionFile?: string): Promise<void> => {
    if (disposal) return disposal;
    disposal = (async () => {
      try {
        if (session.extensionRunner.hasHandlers("session_shutdown")) await session.extensionRunner.emit({ type: "session_shutdown", reason, ...(targetSessionFile === undefined ? {} : { targetSessionFile }) });
      } finally {
        nativeDispose();
      }
    })();
    return disposal;
  };
  Object.assign(session, { dispose: () => shutdown("quit") });
  try {
    await session.bindExtensions({ mode: "print" });
  } catch (error) {
    await shutdown("quit").catch(() => undefined);
    throw error;
  }
  const resourcePaths = { extensions: resourceLoader.getExtensions().extensions.filter(({ path }) => !path.startsWith("<")).map(({ resolvedPath }) => canonicalSourcePath(resolvedPath)), skills: resourceLoader.getSkills().skills.map(({ filePath }) => canonicalSourcePath(filePath)) };
  const resourceInspection = (): PiResourceInspection => {
    const extensions = resourceLoader.getExtensions();
    const skills = resourceLoader.getSkills();
    const diagnostics = [...extensions.errors.map(({ path, error }) => ({ type: "error" as const, message: error, source: path })), ...skills.diagnostics.map(({ type, path, message }) => ({ type, message, ...(path ? { source: path } : {}) }))];
    const systemSource = systemPromptSource;
    return { extensions: resourceLoader.getExtensions().extensions.filter(({ path }) => !path.startsWith("<")).map(({ resolvedPath }) => canonicalSourcePath(resolvedPath)), skills: skills.skills.map(({ name }) => name), diagnostics, ...(systemSource ? { systemPromptSource: systemSource } : resourceLoader.getSystemPrompt() !== undefined ? { systemPromptSource: "Pi resource loader" } : {}) };
  };
  const managedSession = Object.assign(session, {
    getLeafId: () => manager.getLeafId(),
    getToolDefinitions: () => session.getAllTools().map(({ name, description, parameters, promptGuidelines }) => ({ name, description, parameters, ...(promptGuidelines ? { promptGuidelines } : {}) })),
    preparePrompt: (text: string) => preparePiPrompt(session as unknown as PiSession, text),
    getResourceInspection: resourceInspection,
    herdrModelContext: { model: session.model, modelRegistry: session.extensionRunner.getModelRegistry() },
    herdrResourcePaths: resourcePaths,
    herdrContextFiles: resourceLoader.getAgentsFiles().agentsFiles,
  }) as unknown as PiSession;
  return { session: managedSession, shutdown };
}
function workflowAgentMessage(message: AgentMessage | undefined): WorkflowAgentMessage | undefined { return normalizePiMessage(message); }
function latestUsableAssistant(messages: readonly AgentMessage[]): WorkflowAgentMessage | undefined { for (let index = messages.length - 1; index >= 0; index -= 1) { const candidate = workflowAgentMessage(messages[index]); if (candidate?.role === "assistant" && !isEmptyAbortedAssistant(candidate)) return candidate; } return undefined; }
function workflowAgentStats(stats: ReturnType<PiSession["getSessionStats"]>): WorkflowAgentSessionStats { return { tokens: { input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite, total: stats.tokens.total }, cost: stats.cost }; }
function workflowAgentState(native: PiSession, prepared: Readonly<PreparedAgentSession>): WorkflowAgentSessionState {
  const tools = native.agent?.state.tools.map(({ name }) => name) ?? prepared.tools;
  const model = native.model?.provider && (native.model.model ?? native.model.id) ? { provider: native.model.provider, model: native.model.model ?? native.model.id ?? prepared.model.model, ...(prepared.model.thinking ? { thinking: prepared.model.thinking } : {}) } : { ...prepared.model };
  return { model, ...(model.thinking ? { thinking: model.thinking } : {}), tools: [...tools], ...(native.systemPrompt === undefined ? {} : { systemPrompt: native.systemPrompt }) };
}
function notifyPiSessionEvent(notify: (event: WorkflowAgentSessionEvent) => Promise<void>, event: unknown, settledOnly = false): Promise<void> | undefined {
  const normalized = normalizePiSessionEvent(event);
  if (!normalized || (settledOnly && normalized.type !== "agent_settled")) return undefined;
  return notify(normalized);
}
export async function createLocalWorkflowAgentSession(prepared: Readonly<PreparedAgentSession>, context: Readonly<AgentTransportContext>): Promise<WorkflowAgentSession> {
  void context;
  const input: SessionInput = {
    cwd: prepared.cwd, model: { ...prepared.model }, tools: [...prepared.tools] as SessionInput["tools"], sessionLabel: prepared.sessionLabel,
    ...(prepared.agentDir ? { agentDir: prepared.agentDir } : {}), ...(prepared.customTools?.length ? { customTools: [...prepared.customTools] as NonNullable<SessionInput["customTools"]> } : {}),
    ...(prepared.resultTool ? { resultTool: prepared.resultTool } : {}), ...(prepared.systemPrompt === undefined ? {} : { systemPrompt: prepared.systemPrompt }),
    ...(prepared.systemPromptAppend ? { systemPromptAppend: prepared.systemPromptAppend } : {}), ...(prepared.extensionFactories?.length ? { extensionFactories: [...prepared.extensionFactories] } : {}),
    ...(prepared.additionalSkillPaths?.length ? { additionalSkillPaths: [...prepared.additionalSkillPaths] } : {}), ...(prepared.contextFiles === undefined ? {} : { contextFiles: [...prepared.contextFiles] }), ...(prepared.resourcePolicy ? { resourcePolicy: structuredClone(prepared.resourcePolicy) } : {}), ...(prepared.options ? { options: { ...prepared.options } } : {}),
  };
  let nativeHandle = await createLocalPiSessionHandle(input);
  let native = nativeHandle.session;
  let nativeShutdownReason: LocalSessionShutdownReason | undefined;
  let disposal: Promise<void> | undefined;
  let aborting: Promise<void> | undefined;
  let lifecycle: Promise<void> | undefined;
  let state: "active" | "suspending" | "suspended" | "resuming" | "disposing" | "disposed" = "active";
  let suspendOperation: Promise<void> | undefined;
  let resumeOperation: Promise<void> | undefined;
  let resumingActive = false;
  const prompts = new Set<Promise<WorkflowAgentTurnResult>>();
  const listeners = new Set<(event: WorkflowAgentSessionEvent) => void | Promise<void>>();
  let coreUnsubscribe: (() => void) | undefined;
  let sessionUnsubscribe: (() => void) | undefined;
  const eventNotifications = new Set<Promise<void>>();
  const noEventNotificationFailure = Symbol("no event notification failure");
  let eventNotificationFailure: unknown = noEventNotificationFailure;
  let observationGeneration = 0;
  const notify = async (event: WorkflowAgentSessionEvent) => { for (const listener of listeners) await listener(event); };
  const trackNotification = (notification: Promise<void> | undefined, generation: number): void => {
    if (!notification) return;
    if (generation !== observationGeneration) { void notification.then(() => undefined, () => undefined); return; }
    eventNotifications.add(notification);
    void notification.then(() => {
      eventNotifications.delete(notification);
    }, (error: unknown) => {
      eventNotifications.delete(notification);
      if (generation === observationGeneration && eventNotificationFailure === noEventNotificationFailure) {
        eventNotificationFailure = error;
      }
    });
  };
  const flushNotifications = async (): Promise<void> => {
    let failure: unknown;
    let failed = false;
    const takeFailure = () => {
      if (eventNotificationFailure === noEventNotificationFailure) return;
      if (!failed) {
        failure = eventNotificationFailure;
        failed = true;
      }
      eventNotificationFailure = noEventNotificationFailure;
    };
    takeFailure();
    while (eventNotifications.size > 0) {
      const pending = [...eventNotifications];
      const outcomes = await Promise.allSettled(pending);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected" && !failed) {
          failure = outcome.reason;
          failed = true;
        }
      }
      for (const notification of pending) eventNotifications.delete(notification);
      takeFailure();
    }
    takeFailure();
    if (failed) throw failure;
  };
  const unbindNative = () => {
    observationGeneration += 1;
    coreUnsubscribe?.();
    sessionUnsubscribe?.();
    coreUnsubscribe = undefined;
    sessionUnsubscribe = undefined;
    eventNotifications.clear();
    eventNotificationFailure = noEventNotificationFailure;
  };
  const bindNative = (next: PiSession) => {
    unbindNative();
    const generation = observationGeneration;
    coreUnsubscribe = next.agent?.subscribe?.((event) => { trackNotification(notifyPiSessionEvent(notify, event), generation); });
    sessionUnsubscribe = next.subscribe?.((event) => { trackNotification(notifyPiSessionEvent(notify, event, true), generation); });
  };
  const enqueue = (operation: () => Promise<void>): Promise<void> => {
    const previous = lifecycle;
    const next = previous ? previous.then(operation, operation) : operation();
    lifecycle = next;
    void next.then(() => { if (lifecycle === next) lifecycle = undefined; }, () => { if (lifecycle === next) lifecycle = undefined; });
    return next;
  };
  const shutdownNative = (reason: LocalSessionShutdownReason, targetSessionFile?: string): Promise<void> => {
    nativeShutdownReason = reason;
    return nativeHandle.shutdown(reason, targetSessionFile);
  };
  bindNative(native);
  const startAbort = () => {
    if (state !== "active" && state !== "suspending" && !(state === "resuming" && resumingActive)) return Promise.resolve();
    return aborting ??= Promise.resolve().then(() => native.abort?.()).then(() => undefined).finally(() => { aborting = undefined; });
  };
  const suspend = async (): Promise<void> => {
    if (state === "disposing" || state === "disposed") throw new WorkflowError("INTERNAL_ERROR", "Local workflow session is closing");
    if (state === "suspended" || !native.sessionFile) return;
    if (state === "suspending") { await suspendOperation; return; }
    if (state === "resuming") { await resumeOperation; return suspend(); }
    const sessionFile = native.sessionFile;
    state = "suspending";
    suspendOperation = enqueue(async () => {
      await Promise.allSettled(prompts);
      if (state !== "suspending") {
        if (isClosing()) throw new WorkflowError("INTERNAL_ERROR", "Local workflow session is closing");
        return;
      }
      unbindNative();
      try { await shutdownNative("resume", sessionFile); }
      catch (error) { if (!isClosing()) state = "suspended"; throw error; }
      if (!isClosing()) state = "suspended";
    });
    await suspendOperation;
  };
  const isActive = () => state === "active";
  const isClosing = () => state === "disposing" || state === "disposed";
  const resume = async (): Promise<void> => {
    if (state === "suspending") { await suspendOperation; return resume(); }
    if (state === "resuming") { if (resumeOperation) await resumeOperation; return; }
    if (state === "disposing" || state === "disposed" || !native.sessionFile) return;
    const sessionFile = native.sessionFile;
    const wasSuspended = state === "suspended";
    resumingActive = !wasSuspended;
    state = "resuming";
    const operation = enqueue(async () => {
      try {
        await Promise.allSettled(prompts);
        if (!wasSuspended) {
          unbindNative();
          await shutdownNative("resume", sessionFile);
        }
        if (isClosing()) return;
        const nextHandle = await createLocalPiSessionHandle({ ...input, sessionPath: sessionFile }, { type: "session_start", reason: "resume", previousSessionFile: sessionFile });
        nativeHandle = nextHandle;
        native = nextHandle.session;
        nativeShutdownReason = undefined;
        if (isClosing()) { await shutdownNative("quit"); return; }
        bindNative(native);
        state = "active";
      } catch (error) {
        if (state === "resuming") state = "suspended";
        throw error;
      }
    });
    resumeOperation = operation;
    try { await operation; } finally { if (resumeOperation === operation) { resumeOperation = undefined; resumingActive = false; } }
  };
  const disposeSession = async (): Promise<void> => {
    if (disposal) { await disposal; return; }
    if (state === "disposed") return;
    const abort = startAbort();
    state = "disposing";
    disposal = enqueue(async () => {
      try {
        try { await abort; } catch { /* Abort failure must not prevent the prompt from settling. */ }
        await Promise.allSettled(prompts);
        unbindNative();
        if (nativeShutdownReason === "resume") {
          const sessionFile = native.sessionFile;
          if (sessionFile) {
            const nextHandle = await createLocalPiSessionHandle({ ...input, sessionPath: sessionFile }, { type: "session_start", reason: "resume", previousSessionFile: sessionFile });
            nativeHandle = nextHandle;
            native = nextHandle.session;
            nativeShutdownReason = undefined;
          }
        }
        if (nativeShutdownReason === undefined) await shutdownNative("quit");
      } finally {
        state = "disposed";
      }
    });
    await disposal;
  };
  const reference: WorkflowAgentSessionReference = { transport: "local", sessionId: native.sessionId, ...(native.sessionFile ? { locator: { sessionFile: native.sessionFile } } : {}) };
  const session = {
    reference,
    getHerdrResourcePaths: () => native.herdrResourcePaths,
    getHerdrContextFiles: () => native.herdrContextFiles,
    getHerdrModelContext: () => native.herdrModelContext,
    getState: () => Object.freeze(workflowAgentState(native, prepared)),
    getSessionStats: () => workflowAgentStats(native.getSessionStats()),
    getLastAssistant: () => latestUsableAssistant(native.messages),
    subscribe(listener: (event: WorkflowAgentSessionEvent) => void) { listeners.add(listener); listener({ type: "state_changed", state: workflowAgentState(native, prepared) }); return () => listeners.delete(listener); },
    subscribeAsync(listener: (event: WorkflowAgentSessionEvent) => void | Promise<void>) {
      listeners.add(listener);
      let notification: Promise<void>;
      try { notification = Promise.resolve(listener({ type: "state_changed", state: workflowAgentState(native, prepared) })); }
      catch (error) { notification = Promise.resolve().then(() => { throw error; }); }
      trackNotification(notification, observationGeneration);
      return () => listeners.delete(listener);
    },
    async prompt(text: string) {
      if (!isActive()) throw new WorkflowError("INTERNAL_ERROR", "Local workflow session is not active");
      const prompt = (async () => {
        let promptFailure: unknown;
        let promptFailed = false;
        try { await native.prompt(text); }
        catch (error) { promptFailure = error; promptFailed = true; }
        let notificationFailure: unknown;
        let notificationFailed = false;
        try { await flushNotifications(); }
        catch (error) { notificationFailure = error; notificationFailed = true; }
        if (promptFailed) throw promptFailure;
        if (notificationFailed) throw notificationFailure;
        const assistant = latestUsableAssistant(native.messages);
        return assistant ? { assistant } : {};
      })();
      prompts.add(prompt);
      try { return await prompt; } finally { prompts.delete(prompt); }
    },
    async steer(text: string) {
      if (!isActive()) throw new WorkflowError("INTERNAL_ERROR", "Local workflow session is not active");
      if (!native.steer) throw new WorkflowError("INTERNAL_ERROR", "Local workflow session does not support steering");
      await native.steer(text);
    },
    async abort() { if (!isActive()) return; await startAbort(); },
    suspendForHandoff: suspend,
    resumeFromHandoff: resume,
    dispose: disposeSession,
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
  role?: string | RoleOverride;
  outputSchema?: unknown;
  retries?: number;
  timeoutMs?: number | null;
  [key: string]: unknown;
}
function isChildAgentToolParams(value: unknown): value is ChildAgentToolParams & Record<string, JsonValue> {
  if (!jsonObject(value) || typeof value.prompt !== "string" || typeof value.label !== "string") return false;
  if (value.tools !== undefined && (!Array.isArray(value.tools) || value.tools.some((tool) => typeof tool !== "string"))) return false;
  if (value.model !== undefined && typeof value.model !== "string") return false;
  if (value.thinking !== undefined && !validThinking(value.thinking)) return false;
  if (value.role !== undefined && !validRoleOverride(value.role)) return false;
  if (value.outputSchema !== undefined && !jsonObject(value.outputSchema)) return false;
  if (value.retries !== undefined && (typeof value.retries !== "number" || !Number.isInteger(value.retries) || value.retries < 0)) return false;
  if (value.timeoutMs !== undefined && (value.timeoutMs !== null && (typeof value.timeoutMs !== "number" || !Number.isInteger(value.timeoutMs) || value.timeoutMs < 1))) return false;
  return true;
}
function validRoleOverride(value: unknown): boolean {
  if (typeof value === "string") return value.trim() !== "";
  if (!jsonObject(value) || typeof value.name !== "string" || !value.name.trim()) return false;
  if (value.model !== undefined && value.model !== null && typeof value.model !== "string") return false;
  if (value.thinking !== undefined && value.thinking !== null && !validThinking(value.thinking)) return false;
  if (value.tools !== undefined && value.tools !== null && (!Array.isArray(value.tools) || value.tools.some((tool) => typeof tool !== "string"))) return false;
  if (value.description !== undefined && value.description !== null && typeof value.description !== "string") return false;
  if (value.overrideSystemPrompt !== undefined && value.overrideSystemPrompt !== null && typeof value.overrideSystemPrompt !== "boolean") return false;
  if (value.contextFiles !== undefined && value.contextFiles !== null && (!Array.isArray(value.contextFiles) || value.contextFiles.some((scope) => typeof scope !== "string" || !["global", "project", "cwd"].includes(scope)))) return false;
  if (value.disabledAgentResources !== undefined && value.disabledAgentResources !== null) {
    if (!jsonObject(value.disabledAgentResources)) return false;
    const exclusions = value.disabledAgentResources;
    if (exclusions.skills !== undefined && (!Array.isArray(exclusions.skills) || exclusions.skills.some((entry) => typeof entry !== "string"))) return false;
    if (exclusions.extensions !== undefined && (!Array.isArray(exclusions.extensions) || exclusions.extensions.some((entry) => typeof entry !== "string"))) return false;
  }
  return true;
}
function fallbackSetupContext(root: AgentExecutionRoot, options: AgentExecutionOptions, signal: AbortSignal): { run: Readonly<WorkflowRunContext>; identity: Readonly<AgentIdentity>; tuiIndex?: number; tuiLabel?: string } {
  const identity = options.agentIdentity ?? { structuralPath: [], callSite: options.label, occurrence: 1 };
  const run = root.runContext ?? Object.freeze({ cwd: root.cwd, sessionId: "", runId: "", workflow: Object.freeze({ name: options.workflowName }), args: null, signal });
  return { run, identity: Object.freeze({ ...identity, structuralPath: Object.freeze([...identity.structuralPath]) }), ...(options.tuiIndex === undefined ? {} : { tuiIndex: options.tuiIndex }), ...(options.tuiLabel === undefined ? {} : { tuiLabel: options.tuiLabel }) };
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
function packageRoot(start: string): string | undefined {
  let current = dirname(realpathSync(start));
  for (;;) {
    const candidates = [current, join(current, "..", "@earendil-works", "pi-coding-agent"), join(current, "..", "pi-coding-agent")];
    for (const candidate of candidates) {
      try {
        const packageJson: unknown = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
        if (object(packageJson) && typeof packageJson.name === "string" && packageJson.name === "@earendil-works/pi-coding-agent") return candidate;
      } catch { /* Continue to the next package candidate. */ }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}
type PiRuntimeResolution = { runtime?: PiRuntimeLaunchInfo; error?: string };
function resolvePiRuntime(): PiRuntimeResolution {
  const executableName = basename(process.execPath).toLowerCase();
  const bunBinary = ["$bunfs", "~BUN", "%7EBUN"].some((marker) => import.meta.url.includes(marker)) || Boolean(process.versions.bun && !["bun", "bun.exe"].includes(executableName));
  if (bunBinary) return { runtime: Object.freeze({ executable: process.execPath }) };
  try {
    const packageEntry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
    const root = packageRoot(packageEntry);
    if (!root) throw new Error("could not locate the @earendil-works/pi-coding-agent package root");
    const packageJson: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    if (!object(packageJson)) throw new Error("the @earendil-works/pi-coding-agent package does not declare a pi CLI");
    const bin = packageJson.bin;
    const cli = typeof bin === "string" ? bin : object(bin) && typeof bin.pi === "string" ? bin.pi : undefined;
    if (!cli) throw new Error("the @earendil-works/pi-coding-agent package does not declare a pi CLI");
    const entrypoint = resolve(root, cli);
    if (!existsSync(entrypoint)) throw new Error(`the originating Pi CLI entrypoint is unavailable: ${entrypoint}`);
    return { runtime: Object.freeze({ executable: process.execPath, entrypoint }) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
const piRuntimeResolution = resolvePiRuntime();
const piRuntime = piRuntimeResolution.runtime;
const piRuntimeError = piRuntimeResolution.error;
function preparedAgentSession(input: SessionInput, initialPrompt?: string): Readonly<PreparedAgentSession> {
  const systemPromptPath = input.systemPrompt === undefined ? workflowSystemPromptPath(input.cwd, input.agentDir ?? getAgentDir(), input.resourcePolicy?.projectTrusted ?? true) : undefined;
  const prepared = {
    cwd: input.cwd, model: Object.freeze({ ...input.model }), tools: Object.freeze([...input.tools]), sessionLabel: input.sessionLabel, ...(initialPrompt === undefined ? {} : { initialPrompt }),
    ...(input.agentDir ? { agentDir: input.agentDir } : {}), ...(input.customTools?.length ? { customTools: Object.freeze([...input.customTools]) } : {}), ...(input.resultTool ? { resultTool: input.resultTool } : {}), ...(input.options ? { options: Object.freeze(structuredClone(input.options)) } : {}),
    ...(piRuntime ? { piRuntime } : {}), ...(piRuntimeError ? { piRuntimeError } : {}),
    ...(input.systemPrompt === undefined ? {} : { systemPrompt: input.systemPrompt }), ...(systemPromptPath ? { systemPromptPath } : {}), ...(input.systemPromptAppend ? { systemPromptAppend: input.systemPromptAppend } : {}),
    ...(input.extensionFactories?.length ? { extensionFactories: Object.freeze([...input.extensionFactories]) } : {}), ...(input.additionalSkillPaths?.length ? { additionalSkillPaths: Object.freeze([...input.additionalSkillPaths]) } : {}), ...(input.contextFiles === undefined ? {} : { contextFiles: Object.freeze([...input.contextFiles]) }),
    ...(input.resourcePolicy ? { resourcePolicy: Object.freeze(structuredClone(input.resourcePolicy)) } : {}),
  };
  return deepFreeze(prepared);
}
function agentSetupSummary(setup: AgentSetup, hookNames: readonly string[]): AgentSetupSummary {
  const model = setup.sessionInput.model;
  return { hookNames: [...hookNames], model: { provider: model.provider, model: model.model, ...(model.thinking ? { thinking: model.thinking } : {}) }, tools: [...setup.sessionInput.tools], cwd: setup.sessionInput.cwd, ...(setup.sessionInput.resourcePolicy ? { disabledAgentResources: resourcePolicySummary(setup.sessionInput.resourcePolicy) } : {}) };
}
export type PreparedAgentSetup = { setup: AgentSetup; summary: AgentSetupSummary; failure?: { error: unknown; hook?: string } };
async function prepareAgentSetup(root: AgentExecutionRoot, transport: AgentTransport, task: string, options: AgentExecutionOptions, resolved: { model: ModelSpec; tools: readonly string[]; systemPrompt?: string; systemPromptAppend: string; contextFiles?: readonly ContextFileScope[] }, cwd: string, attempt: number, signal: AbortSignal | undefined, customTools: readonly ToolDefinition[], resultTool: ToolDefinition | undefined, inspection = false): Promise<PreparedAgentSetup> {
  const setupSignal = signal ?? root.runContext?.signal ?? new AbortController().signal;
  const baselineOptions = structuredClone(options.agentOptions ?? {});
  const baseResourcePolicy = await root.agentResourcePolicy?.();
  const roleName = roleNameOf(options.role);
  const roleDefinition = roleName ? root.agentDefinitions?.[roleName] : undefined;
  const roleExclusions = roleDefinition ? (typeof options.role === "object" ? applyRoleOverride(roleDefinition, options.role) : roleDefinition)?.disabledAgentResources : undefined;
  const resourcePolicy = baseResourcePolicy && roleExclusions ? { ...baseResourcePolicy, effective: mergeAgentResourceExclusions(baseResourcePolicy.effective, roleExclusions) } : baseResourcePolicy;
  const resourcePolicyCeiling = resourcePolicy ? structuredClone(resourcePolicy) : undefined;
  const sessionInput: SessionInput = { cwd, model: { ...resolved.model }, tools: [...resolved.tools], sessionLabel: `${options.workflowName}:${options.label}:attempt-${String(attempt)}`, ...(root.agentDir ? { agentDir: root.agentDir } : {}), ...(root.additionalSkillPaths?.length ? { additionalSkillPaths: [...root.additionalSkillPaths] } : {}), ...(resolved.contextFiles === undefined ? {} : { contextFiles: [...resolved.contextFiles] }), ...(customTools.length ? { customTools: [...customTools] } : {}), ...(resultTool ? { resultTool } : {}), ...(resolved.systemPrompt !== undefined ? { systemPrompt: resolved.systemPrompt } : {}), systemPromptAppend: resolved.systemPromptAppend, ...(resourcePolicy ? { resourcePolicy } : {}), options: structuredClone(baselineOptions) };
  const setup = { prompt: task, options: sessionInput.options ?? {}, sessionInput, prepared: preparedAgentSession(sessionInput, task), transport };
  const base = fallbackSetupContext(root, options, setupSignal);
  const context = Object.freeze({ run: base.run, identity: base.identity, attempt, signal: setupSignal, ...(base.tuiIndex === undefined ? {} : { tuiIndex: base.tuiIndex }), ...(base.tuiLabel === undefined ? {} : { tuiLabel: base.tuiLabel }), ...(inspection ? { mode: "inspection" as const } : {}) });
  const hookNames: string[] = [];
  for (const hook of [...(root.agentSetupHooks ?? [])].sort((left, right) => left.priority - right.priority || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))) {
    if (setupSignal.aborted) return { setup, summary: agentSetupSummary(setup, hookNames), failure: { error: new WorkflowError("CANCELLED", "Agent cancelled") } };
    try { await hook.setup(setup, context); } catch (error) {
      setup.prepared = preparedAgentSession(setup.sessionInput, task);
      return { setup, summary: agentSetupSummary(setup, hookNames), failure: { error: setupSignal.reason !== undefined ? new WorkflowError("CANCELLED", "Agent cancelled") : error, hook: hook.name } };
    }
    setup.prepared = preparedAgentSession(setup.sessionInput, task);
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
    setup.prepared = preparedAgentSession(setup.sessionInput, task);
    return { setup, summary: agentSetupSummary(setup, hookNames), failure: { error } };
  }
  setup.prepared = preparedAgentSession(setup.sessionInput, task);
  return { setup, summary: agentSetupSummary(setup, hookNames) };
}
export async function prepareAgentSetupForInspection(root: AgentExecutionRoot, task: string, options: AgentExecutionOptions, transport: AgentTransport): Promise<PreparedAgentSetup> {
  const executor = new WorkflowAgentExecutor(root);
  const resolved = executor.resolve(options);
  return prepareAgentSetup(root, transport, task, options, resolved, root.cwd, 1, root.runContext?.signal, [], undefined, true);
}
function attemptRecord(transport: string, attempt: number, session: WorkflowAgentSession, setup: AgentSetupSummary, stats: AgentAccounting, result?: JsonValue, error?: { code: string; message: string }): AgentAttempt {
  return { attempt, transport, session: session.reference, ...(result === undefined ? {} : { result }), ...(error ? { error } : {}), accounting: stats, setup };
}
const agentAttemptsByError = new WeakMap<Error, readonly AgentAttempt[]>();
function errorWithAttempts(error: unknown, attempts: readonly AgentAttempt[]): Error {
  const typed = error instanceof Error ? error : new Error(typeof error === "string" ? error : String(error));
  const annotated = Object.assign(typed, { attempts });
  agentAttemptsByError.set(typed, attempts);
  return annotated;
}
export function getAgentAttempts(error: unknown): readonly AgentAttempt[] | undefined {
  return error instanceof Error ? agentAttemptsByError.get(error) : undefined;
}
type RoleOverrideKey = Exclude<keyof RoleOverride, "name">;
type RoleOverrideValues = { [Key in RoleOverrideKey]: RoleOverride[Key] };
const ROLE_OVERRIDE_KEYS = ["model", "thinking", "tools", "description", "overrideSystemPrompt", "contextFiles", "disabledAgentResources"] as const satisfies readonly RoleOverrideKey[];
function roleOverrideValues(override: RoleOverride): RoleOverrideValues {
  return { model: override.model, thinking: override.thinking, tools: override.tools, description: override.description, overrideSystemPrompt: override.overrideSystemPrompt, contextFiles: override.contextFiles, disabledAgentResources: override.disabledAgentResources };
}
function applyRoleOverride(definition: AgentDefinition | undefined, override: RoleOverride): AgentDefinition | undefined {
  if (!definition) return definition;
  const merged: AgentDefinition = { ...definition };
  const values = roleOverrideValues(override);
  for (const key of ROLE_OVERRIDE_KEYS) {
    const value = values[key];
    if (value === undefined) continue;
    if (value === null) Reflect.deleteProperty(merged, key);
    else Object.assign(merged, { [key]: value });
  }
  return merged;
}
export class WorkflowAgentExecutor {
  private readonly transport: AgentTransport;
  constructor(private readonly root: AgentExecutionRoot, transport: AgentTransport = localAgentTransport) { this.transport = transport; }
  setRunContext(runContext: Readonly<WorkflowRunContext>): void { this.root.runContext = runContext; }

  resolve(options: AgentExecutionOptions, inheritedTools?: readonly string[]): { model: ModelSpec; requestedModel?: string; tools: readonly string[]; systemPrompt?: string; systemPromptAppend: string; contextFiles?: readonly ContextFileScope[] } {
    const role = options.role;
    const roleName = roleNameOf(role);
    const definition = roleName ? this.root.agentDefinitions?.[roleName] : undefined;
    if (roleName && !definition) throw new WorkflowError("UNKNOWN_AGENT_TYPE", `Unknown agent role: ${roleName}`);
    if (roleName && (options.model !== undefined || options.thinking !== undefined || options.tools !== undefined)) throw new WorkflowError("INVALID_METADATA", "Role agents must not specify model, thinking, or tools");
    const roleDefinition = typeof role === "object" ? applyRoleOverride(definition, role) : definition;
    const requested = options.tools !== undefined ? options.tools : roleDefinition?.tools !== undefined ? roleDefinition.tools : options.effectiveTools !== undefined ? options.effectiveTools : inheritedTools !== undefined ? inheritedTools : [...this.root.tools];
    const forbidden = requested.find((tool) => !this.root.tools.has(tool));
    if (forbidden) throw new WorkflowError("UNKNOWN_TOOL", `Tool is outside the launching session boundary: ${forbidden}`);
    const requestedModel = options.model ?? roleDefinition?.model;
    const alias = requestedModel === undefined ? undefined : modelAliasName(requestedModel, this.root.modelAliases ?? {});
    const blockedAlias = requestedModel?.split(":", 1)[0];
    if (requestedModel !== undefined && blockedAlias && this.root.blockedAliases?.has(blockedAlias) && !alias) { const target = this.root.blockedAliasTargets?.[blockedAlias]; throw new WorkflowError("UNKNOWN_MODEL", `Unknown model alias ${requestedModel}${target ? ` resolved to ${target}` : ""}${this.root.settingsPath ? ` (settings: ${this.root.settingsPath})` : ""}`); }
    const aliasThinking = requestedModel !== undefined && alias ? resolveModelReference(requestedModel, this.root.modelAliases, this.root.knownModels ?? this.root.availableModels, this.root.settingsPath).thinking : undefined;
    const model = options.modelOverride ?? parseModel(requestedModel, this.root.model, options.thinking ?? (aliasThinking === undefined ? roleDefinition?.thinking : undefined), this.root.modelAliases, this.root.knownModels ?? this.root.availableModels, this.root.settingsPath);
    const availableModels = this.root.knownModels ?? this.root.availableModels ?? new Set([modelCapability(this.root.model)]);
    if (!availableModels.has(modelCapability(model))) throw new WorkflowError("UNKNOWN_MODEL", `Unknown model${requestedModel ? ` ${requestedModel} resolved to ${modelCapability(model)}` : ""}${this.root.settingsPath ? ` (settings: ${this.root.settingsPath})` : ""}`);
    const overrideSystemPrompt = roleDefinition?.overrideSystemPrompt === true;
    return { model, ...(alias && requestedModel ? { requestedModel } : {}), tools: [...requested], ...(overrideSystemPrompt ? { systemPrompt: roleDefinition.prompt ?? "" } : {}), systemPromptAppend: overrideSystemPrompt ? "" : roleDefinition?.prompt ?? "", ...(roleDefinition?.contextFiles === undefined ? {} : { contextFiles: [...roleDefinition.contextFiles] }) };
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

      let session: WorkflowAgentSession | undefined;
      let handoff: LiveSessionHandoff | undefined;
      let handoffAbort: (() => void) | undefined;
      const releaseHandoff = (reason: string): void => {
        handoff?.release(reason);
        if (handoffAbort) {
          attemptSignal.removeEventListener("abort", handoffAbort);
          handoffAbort = undefined;
        }
      };
      const releaseIfAttemptCancelled = (): void => { if (attemptSignal.aborted) releaseHandoff("attempt cancelled"); };
      let setup: AgentSetup | undefined;
      let setupSummary: AgentSetupSummary = { hookNames: [], model: { ...resolved.model }, tools: [...resolved.tools], cwd };
      let setupFailed = false;
      let completedAttempt: AgentAttempt | undefined;
      let attemptCallbackFailure: unknown;
      const resultSchema = options.schema ? Compile(options.schema) : undefined;
      let resultAccepted = false;
      const resultTool = resultSchema ? defineTool({
        name: "workflow_result", label: "Workflow Result", description: "Submit the terminal structured workflow result", parameters: resultSchema.Type(),
        async execute(_id: string, value: unknown) {
          if (!resultSchema.Check(value) || !jsonValue(value)) return { content: [{ type: "text" as const, text: "Result does not match the required schema." }], details: {}, isError: true };
          if (resultAccepted) return { content: [{ type: "text" as const, text: "Result has already been accepted." }], details: {}, isError: true };
          resultAccepted = true;
          const currentSession = session;
          if (currentSession) void currentSession.abort().catch(() => undefined);
          return { content: [{ type: "text" as const, text: "Result accepted." }], details: {} };
        },
      }) : undefined;
      let lastKnownAccounting: AgentAccounting = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
      const accountingFromRuntime = (usage: RuntimeUsage, active: WorkflowAgentSession): AgentAccounting => {
        const input = usage.input;
        const output = usage.output;
        const cacheRead = usage.cacheRead;
        const cacheWrite = usage.cacheWrite;
        const cost = usage.costUsd;
        if (usage.availability === "complete" && typeof input === "number" && Number.isFinite(input) && typeof output === "number" && Number.isFinite(output) && typeof cacheRead === "number" && Number.isFinite(cacheRead) && typeof cacheWrite === "number" && Number.isFinite(cacheWrite) && typeof cost === "number" && Number.isFinite(cost)) return { input, output, cacheRead, cacheWrite, cost };
        return accounting(active.getSessionStats());
      };
      const progressHandler = options.onProgress;
      const reportProgress = progressHandler ? async (value: RuntimeAgentProgress): Promise<void> => {
        const values = [value.usage.input, value.usage.output, value.usage.cacheRead, value.usage.cacheWrite, value.usage.costUsd];
        const complete = value.usage.availability === "complete" && values.every((entry): entry is number => typeof entry === "number" && Number.isFinite(entry));
        const reportable = complete ? value : { ...value, usage: { availability: "complete" as const, input: lastKnownAccounting.input, output: lastKnownAccounting.output, cacheRead: lastKnownAccounting.cacheRead, cacheWrite: lastKnownAccounting.cacheWrite, costUsd: lastKnownAccounting.cost } };
        const update = runtimeProgressToAgentProgress(reportable);
        if (complete) lastKnownAccounting = { ...update.accounting };
        await progressHandler(update);
      } : undefined;

      try {
        setupFailed = true;
        const prepared = await prepareAgentSetup(this.root, this.transport, task, options, resolved, cwd, attempt, attemptSignal, customTools, resultTool);
        setup = prepared.setup;
        const attemptSetup = prepared.setup;
        setupSummary = prepared.summary;
        if (prepared.failure) throw prepared.failure.error;
        setupFailed = false;
        if (attemptSignal.aborted) throw new WorkflowError("CANCELLED", "Agent cancelled");
        await options.onAttempt?.({ attempt, transport: attemptSetup.transport.id, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, setup: setupSummary });

        const transportBase = fallbackSetupContext(this.root, options, attemptSignal);
        const transportContext = Object.freeze({ run: transportBase.run, identity: transportBase.identity, attempt, signal: attemptSignal, ...(transportBase.tuiIndex === undefined ? {} : { tuiIndex: transportBase.tuiIndex }), ...(transportBase.tuiLabel === undefined ? {} : { tuiLabel: transportBase.tuiLabel }) });
        handoff = createLiveSessionHandoff();
        handoffAbort = () => { releaseHandoff("attempt cancelled"); };
        attemptSignal.addEventListener("abort", handoffAbort, { once: true });
        releaseIfAttemptCancelled();
        const runStore = this.root.runStore;

        const runner = createPiRuntimeAgentRunner({
          transport: setup.transport,
          prepared: setup.prepared,
          context: transportContext,
          handoff,
          callbacks: {
            onSession: async (createdSession, createdHandoff, createdPrepared) => {
              session = createdSession;
              releaseIfAttemptCancelled();
              const activeAttempt: AgentAttempt = { attempt, transport: attemptSetup.transport.id, session: createdSession.reference, liveSession: createdSession, prepared: createdPrepared, handoff: createdHandoff, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, setup: setupSummary };
              await options.onAttempt?.(activeAttempt);
            },
            onSessionReady: async () => {
              if (attemptSetup.sessionInput.resourcePolicy) setupSummary = { ...setupSummary, disabledAgentResources: resourcePolicySummary(attemptSetup.sessionInput.resourcePolicy) };
            },
            onBeforeComplete: async () => {
              if (options.worktreeOwner) await runStore?.snapshotWorktree(options.worktreeOwner);
            },
            ...(runStore ? { onSystemPrompt: (entry: { readonly sessionId: string; readonly turn: number; readonly prompt: string }) => runStore.recordSystemPrompt({ ...entry, attempt }) } : {}),
            onComplete: async (result, completedSession) => {
              const completedAccounting = accountingFromRuntime(result.usage, completedSession);
              completedAttempt = attemptRecord(attemptSetup.transport.id, attempt, completedSession, setupSummary, completedAccounting, result.value);
              attempts.push(completedAttempt);
              try { await options.onAttempt?.(completedAttempt); }
              catch (error) { attemptCallbackFailure = error; throw error; }
              finally { releaseHandoff("session completed"); }
            },
            onFailure: async (failure, failedSession) => {
              releaseHandoff("attempt failed");
              const failedAccounting = accounting(failedSession.getSessionStats());
              const failedAttempt = attemptRecord(attemptSetup.transport.id, attempt, failedSession, setupSummary, failedAccounting, undefined, { code: failure.code, message: failure.message });
              attempts.push(failedAttempt);
              try { await options.onAttempt?.(failedAttempt); }
              catch (error) { attemptCallbackFailure = error; throw error; }
            },
          },
        });
        const basePrompt = [`Workflow: ${options.workflowName}`, `Agent: ${options.label}`, options.phase ? `Phase: ${options.phase}` : "", options.parent ? `Parent: ${options.parent}` : "", "You own this task and any direct child agents you create. Return child results to your parent; do not leave descendants running.", attempt > 1 ? `Retry attempt ${String(attempt)}. Previous state: ${options.retryState ?? attempts.at(-1)?.error?.message ?? "failed attempt"}` : ""].filter(Boolean).join("\n");
        const instruction = options.budget?.instruction();
        const promptText = `${basePrompt}\n\nTask:\n${setup.prompt}${instruction ? `\n\n${instruction}` : ""}`;
        const runtimeRun = { id: transportBase.run.runId, namespaceId: transportBase.run.sessionId, workflowName: transportBase.run.workflow.name };
        const providerRecovery = options.providerErrorRecovery;
        const runtimeAgent = { id: transportBase.identity.callSite, structuralPath: [...transportBase.identity.structuralPath], ...(options.parent ? { parentId: options.parent } : {}) };
        const runtimeRequest = {
          task: promptText,
          cwd: setup.prepared.cwd,
          model: { ...setup.prepared.model },
          enabledTools: [...setup.prepared.tools],
          // Pi sessions execute the prepared native definitions; the executor does not duplicate them as neutral request tools.
          customTools: [],
          ...(options.schema ? { resultSchema: options.schema } : {}),
          run: runtimeRun,
          agent: runtimeAgent,
          signal: attemptSignal,
          ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
          ...(reportProgress ? { onProgress: reportProgress } : {}),
          ...(setSteer ? { onControl: async (control: { steer(message: string): Promise<void> }) => { setSteer((message) => control.steer(message)); } } : {}),
          ...(options.budget ? { turnPolicy: {
            beforeTurn: () => {
              try { options.budget?.beforeTurn(); }
              catch (error) { throw error instanceof WorkflowError ? error : new WorkflowError("BUDGET_EXHAUSTED", error instanceof Error ? error.message : String(error)); }
            },
            afterTurn: (usage: RuntimeUsage, final: boolean, requestInstruction?: boolean) => {
              const active = session;
              if (!active) return undefined;
              options.budget?.afterTurn(accountingFromRuntime(usage, active), final);
              return requestInstruction && !final ? options.budget?.instruction() : undefined;
            },
          } } : {}),
          ...(providerRecovery ? { onProviderError: (failure: { provider: string; model: string; error: string }) => providerRecovery({ label: options.label, ...failure }) } : {}),
          ...(this.root.providerPause ? { onProviderLimit: this.root.providerPause } : {}),
        } as const;
        const result = await runner.run(runtimeRequest);
        if (attemptCallbackFailure) throw errorWithAttempts(attemptCallbackFailure, attempts);
        return { value: result.value, attempts, cwd: setupSummary.cwd };
      } catch (error) {
        if (attemptCallbackFailure || completedAttempt) throw errorWithAttempts(attemptCallbackFailure ?? error, attempts);
        const providerError = isRuntimeAgentProviderError(error) ? error : undefined;
        const typed = normalizePiRuntimeError(error, attemptSignal, setupFailed);
        releaseHandoff("attempt failed");
        if (!session) {
          const failedAttempt: AgentAttempt = { attempt, transport: setup?.transport.id ?? this.transport.id, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, error: { code: typed.code, message: typed.message }, setup: setupSummary };
          attempts.push(failedAttempt);
          try { await options.onAttempt?.(failedAttempt); }
          catch (persistenceError) { throw errorWithAttempts(persistenceError, attempts); }
        }
        if (options.worktreeOwner && typed.code !== "WORKTREE_FAILED") await this.root.runStore?.snapshotWorktree(options.worktreeOwner).catch(() => undefined);
        if (providerError?.handled) {
          if (typeof providerError.recovery === "object" && typeof providerError.recovery.model === "string") {
            try {
              const selected = resolveModelReference(providerError.recovery.model, this.root.modelAliases, this.root.knownModels ?? this.root.availableModels, this.root.settingsPath);
              recoveryModel = selected.thinking === undefined && resolved.model.thinking ? { ...selected, thinking: resolved.model.thinking } : selected;
            } catch { throw errorWithAttempts(typed, attempts); }
            maxAttempts += 1;
            beforeRetry?.();
            continue;
          }
          throw errorWithAttempts(typed, attempts);
        }
        if (attempt === maxAttempts || setupFailed || typed.code === "CANCELLED" || typed.code === "WORKTREE_FAILED" || typed.code === "RESUME_INCOMPATIBLE") throw errorWithAttempts(typed, attempts);
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
  role?: string | RoleOverride;
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
  tuiIndex: number;
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

type ScheduledRun = { limit: number; beforeLaunch?: () => void; logical: number; active: number; nextIndex: number; queue: Array<{ node?: ScheduledNode; start: () => void }> };
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
    this.#runs.set(runId, { limit, ...(beforeLaunch ? { beforeLaunch } : {}), logical: 0, active: 0, nextIndex: 0, queue: [] });
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
    const tuiIndex = ++run.nextIndex;
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
        const value = await this.runner({ id, runId, tuiIndex, ...(parentId ? { parentId } : {}), prompt, options: effective, signal: node.controller.signal, setSteer: (handler) => { node.steer = handler; } });
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

  toolsFor(parentId: string, resolveTools?: (role: string | RoleOverride | undefined, tools: readonly string[] | undefined, model: string | undefined, inheritedTools: readonly string[], thinking: ThinkingLevel | undefined) => readonly string[]): ToolDefinition[] {
    const parent = this.#node(parentId);
    if (!parent.options.tools.includes("agent")) return [];
    const agentTool = defineTool({
      name: "agent", label: "Child Agent", description: "Start a direct child agent",
      parameters: Type.Object({ prompt: Type.String(), label: Type.String(), tools: Type.Optional(Type.Array(Type.String())), model: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()), role: Type.Optional(Type.Union([Type.String(), Type.Object({ name: Type.String(), model: Type.Optional(Type.Union([Type.String(), Type.Null()])), thinking: Type.Optional(Type.Union([Type.String(), Type.Null()])), tools: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])), description: Type.Optional(Type.Union([Type.String(), Type.Null()])), overrideSystemPrompt: Type.Optional(Type.Union([Type.Boolean(), Type.Null()])), contextFiles: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])), disabledAgentResources: Type.Optional(Type.Union([Type.Object({ skills: Type.Optional(Type.Array(Type.String())), extensions: Type.Optional(Type.Array(Type.String())) }), Type.Null()])) }, { additionalProperties: true })])), outputSchema: Type.Optional(Type.Record(Type.String(), Type.Unknown())), retries: Type.Optional(Type.Integer({ minimum: 0 })), timeoutMs: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])) }, { additionalProperties: true }),
      execute: async (_id, params) => {
        if (!isChildAgentToolParams(params)) throw new WorkflowError("INVALID_METADATA", "Invalid child agent parameters");
        if (params.role !== undefined && (params.model !== undefined || params.thinking !== undefined || params.tools !== undefined)) throw new WorkflowError("INVALID_METADATA", "Role agents must not specify model, thinking, or tools");
        const outputSchema = params.outputSchema;
        if (outputSchema !== undefined) validateSchema(outputSchema, "agent outputSchema");
        const tools = (params.tools !== undefined || params.role !== undefined ? resolveTools?.(params.role, params.tools, params.model, parent.options.tools, params.thinking) : undefined) ?? params.tools ?? parent.options.tools;
        const agentOptions = { ...params };
        Reflect.deleteProperty(agentOptions, "prompt");
        const options: ScheduledAgentOptions = { label: params.label, requestedLabel: params.label, cwd: parent.options.cwd, tools, agentOptions, ...(params.model ? { model: params.model } : {}), ...(params.thinking ? { thinking: params.thinking } : {}), ...(params.role ? { role: params.role } : {}), ...(outputSchema === undefined ? {} : { schema: outputSchema }), ...(params.retries === undefined ? {} : { retries: params.retries }), ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }) };
        const child = this.spawn(parent.runId, params.prompt, options, parentId);
        return { content: [{ type: "text" as const, text: JSON.stringify({ id: child.id }) }], details: { id: child.id } };
      },
    });
    const resultTool = defineTool({
      name: "get_subagent_result", label: "Child Result", description: "Wait for a direct child and return its result once; repeated retrieval fails with AGENT_RESULT_COLLECTED",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id, params) => { const value = await this.result(parentId, params.id); if (!value.ok && value.error.code === "BUDGET_EXHAUSTED") throw new WorkflowError("BUDGET_EXHAUSTED", value.error.message); return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value }; }
    });
    const steerTool = defineTool({
      name: "steer_subagent", label: "Steer Child", description: "Steer a running direct child",
      parameters: Type.Object({ id: Type.String(), message: Type.String() }),
      execute: async (_id, params) => { await this.steer(parentId, params.id, params.message); return { content: [{ type: "text" as const, text: "Steering delivered." }], details: {} }; },
    });
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
