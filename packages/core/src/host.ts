import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { copyFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type, type Api, type Model, type Static, type TSchema } from "@earendil-works/pi-ai";
import { copyToClipboard, getAgentDir, ModelSelectorComponent, type ExtensionAPI, type ExtensionContext, type ModelRuntime, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { FairAgentScheduler, getAgentAttempts, WorkflowAgentExecutor, localAgentTransport, type AgentActivity, type AgentAttempt, type AgentDefinition, type AgentProgress, type AgentProviderFailure, type AgentProviderRecovery } from "./agent-execution.js";
import { RunLifecycle, WorkflowEventPublisher, nextNamedOccurrence, withWorkflowFunctions, workflowRunContext, type WorkflowRunRecord, type WorkflowToolUpdate } from "./host-runtime.js";
import { createWorkflowRecovery, persistedFailure } from "./host-recovery.js";
import { registerWorkflowNavigator, uiHostCapabilities } from "./host-navigator.js";
import { acquireSessionLease, isPersistedRun, listPersistedSessionIds, listRunIds, RunStore, SessionLease, structuralPath as operationPath } from "./persistence.js";
import { retainTerminalRuns } from "./retention.js";
import type { PersistedRun, WorktreeReference } from "./persistence.js";
import { validateBudget, WorkflowBudgetRuntime } from "./budget.js";
import { SerialLane, asWorkflowError, createLaunchSnapshot, errorCode, errorText, fail, isNodeError, jsonValue, modelAliasErrorName, modelCapability, object, parseModelReference, positiveInteger, sanitizeDisplayText, validateModelAliases } from "./utils.js";
import { loadAgentDefinitions, loadSettings, preflight, resolveAgentResourcePolicy, resolveWorkflowSettings, validateCheckpoint, validateModelAliasAvailability, validateWorkflowLaunchWithRegistry, workflowProjectSettingsPath, workflowSettingsPath } from "./validation.js";
import { beginWorkflowExtensionLoading, loadingRegistry, resetWorkflowRegistryIfIdle, retainWorkflowRegistry, type WorkflowRegistryApi } from "./registry.js";
import { agentHandleTurnPath, agentIdentityPath, agentWorktree, encoded, executeShellCommand, persistActiveAgentAttempt, persistAgentAttempts, readShellResult, runWorkflow, shellIdentityPath } from "./execution.js";
import backgroundWidget, { type BackgroundWidgetAPI } from "./background-widget.js";
import { showChangelogNotice } from "./changelog.js";
import { createTrajectoryRunLoader, createTrajectoryRunMetadataLoader, createTrajectorySubagentLoader, createTrajectorySubagentMetadataLoader, createTrajectoryTranscriptLoader, type TrajectoryActionRequest, type TrajectoryActionResult } from "./trajectory.js";
import { getTrajectoryHost, type TrajectoryPublisherProvider } from "./trajectory-host-handle.js";
import { getSubagentManager } from "./subagent-manager-handle.js";
import { HARD_TERMINAL_RUN_STATES, LAUNCH_SNAPSHOT_IDENTITY_VERSION, WORKFLOW_BLOCKED_EVENT, WorkflowError, roleNameOf, type AgentRecord, type AgentResourcePolicy, type AgentTransport, type JsonValue, type LaunchSnapshot, type ModelSpec, type RunState, type ShellIdentity, type ShellOptions, type ShellResult, type WorkflowErrorCode, type WorkflowMetadata, type WorkflowModelAliasResolverContext, type WorkflowSettings, type WorkflowSettingsResolution, type WorkflowWorktreeReference } from "./types.js";
import type { SubagentManagerContext, SubagentRunRequest, SubagentStatus } from "../subagents/src/contracts.js";
import {
  SETTLED_AGENT_STATES,
  catalogResultValue,
  formatWorkflowCatalog,
  styledTextBlock,
  textBlock,
  workflowCatalogBlock,
  workflowControlCall,
  workflowControlResult,
  workflowProgressBlock,
  formatWorkflowProgress,
  type WorkflowProgressRenderState,
} from "./host-view.js";
import {
  DELIVERY_LIMIT_BYTES,
  ForegroundDeliveryController,
  markWorkflowFailureDiagnostics,
  WORKFLOW_LOG_ENTRY,
  completionDescriptor,
  completionDeliveryFromStore,
  createWorkflowFailureDiagnostics,
  failureDiagnosticsFrom,
  formatWorkflowFailure,
  formatWorkflowFailureDelivery,
  formatWorkflowFailureDeliveryFallback,
  formatWorkflowFailureDiagnostics,
  isWorkflowFailureDiagnostics,
  serializeWorkflowFailureDiagnostics,
  utf8Prefix,
  type CompletionDeliveryContext,
  type ForegroundDelivery,
  type ForegroundDetachResult,
  type WorkflowLogEntry,
} from "./host-delivery.js";

export type WorkflowExtensionAPI = Pick<ExtensionAPI, "appendEntry" | "getActiveTools" | "getThinkingLevel" | "on" | "registerCommand" | "registerTool" | "sendMessage"> & Pick<BackgroundWidgetAPI, "events" | "registerEntryRenderer" | "registerShortcut">;

export {
  agentBreadcrumb,
  agentBreadcrumbParts,
  formatBudgetStatus,
  formatNavigatorDashboard,
  formatNavigatorRun,
  formatStalledDuration,
  formatWorkflowPhaseDashboard,
  formatWorkflowProgress,
  navigatorAttentionSort,
  truncateWorkflowProgress,
} from "./host-view.js";
export { buildWorkflowPhaseModel, buildWorkflowPhaseTree, navigateWorkflowPhaseTree, preserveWorkflowPhaseSelection, preserveWorkflowPhaseTreeSelection, workflowPhaseTreeInitialExpanded, workflowPhaseTreeVisibleNodes } from "./host-phases.js";
export type {
  WorkflowPhaseAgentCounts,
  WorkflowPhaseModel,
  WorkflowPhaseSelection,
  WorkflowPhaseState,
  WorkflowPhaseTree,
  WorkflowPhaseTreeDirection,
  WorkflowPhaseTreeNode,
  WorkflowPhaseTreeNodeKind,
  WorkflowPhaseTreeSelection,
  WorkflowPhaseView,
} from "./host-phases.js";
export type { WorkflowProgressStyles } from "./host-view.js";
export { formatWorkflowFailure, formatWorkflowFailureDelivery, formatWorkflowFailureDiagnostics } from "./host-delivery.js";
export { RunLifecycle } from "./host-runtime.js";

const INTERNAL_WORKFLOW_TOOLS: readonly string[] = ["workflow", "workflow_respond", "workflow_stop", "workflow_status", "workflow_resume", "workflow_retry", "workflow_catalog"];
const SHUTDOWN_TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(["completed", "failed", "stopped", "budget_exhausted"]);
function snapshotResourcePolicy(snapshot: Readonly<LaunchSnapshot>, cwd: string, projectTrusted: boolean, globalSettingsPath: string): AgentResourcePolicy {
  const selectors = snapshot.settings;
  const empty = { skills: [], extensions: [] };
  const effective = { skills: selectors.skills ?? [], extensions: selectors.extensions ?? [], ...(selectors.tools === undefined ? {} : { tools: selectors.tools }) };
  const source = { ...(selectors.skills === undefined ? {} : { skills: selectors.skills }), ...(selectors.extensions === undefined ? {} : { extensions: selectors.extensions }), ...(selectors.tools === undefined ? {} : { tools: selectors.tools }) };
  return { globalSettingsPath, projectSettingsPath: workflowProjectSettingsPath(cwd), projectTrusted, global: empty, project: empty, effective, unmatchedSkills: [], unmatchedExtensions: [], unmatchedTools: [], selectorSources: { global: source, project: {} } };
}
type WorkflowLaunchSettings = { settings: Readonly<WorkflowSettings>; resolution: WorkflowSettingsResolution; resourcePolicy: AgentResourcePolicy };
function workflowLaunchSettings(cwd: string, projectTrusted: boolean, globalSettingsPath: string, concurrency?: number): WorkflowLaunchSettings {
  const resolution = resolveWorkflowSettings(cwd, projectTrusted, globalSettingsPath);
  const settings = Object.freeze({ ...resolution.effective, ...(concurrency === undefined ? {} : { concurrency }) });
  return { settings, resolution, resourcePolicy: resolveAgentResourcePolicy(cwd, projectTrusted, globalSettingsPath) };
}
function frozenResourcePolicy(policy: AgentResourcePolicy): () => AgentResourcePolicy { return () => structuredClone(policy); }
function resumedSnapshotSettings(snapshot: Readonly<LaunchSnapshot>, resolution: WorkflowSettingsResolution, modelAliases: Readonly<Record<string, string>>): { settings: WorkflowSettings; settingsSources?: NonNullable<LaunchSnapshot["settingsSources"]> } {
  const settings: WorkflowSettings = { ...snapshot.settings, concurrency: snapshot.settingsSources === undefined || snapshot.settingsSources.concurrency === "per-run options" ? snapshot.settings.concurrency : resolution.effective.concurrency, backgroundWidget: resolution.effective.backgroundWidget ?? true, ...(resolution.effective.skills === undefined ? {} : { skills: resolution.effective.skills }), ...(resolution.effective.extensions === undefined ? {} : { extensions: resolution.effective.extensions }), ...(resolution.effective.extensionSettings === undefined ? {} : { extensionSettings: resolution.effective.extensionSettings }), ...(resolution.effective.tools === undefined ? {} : { tools: resolution.effective.tools }), ...(resolution.effective.retention === undefined ? {} : { retention: resolution.effective.retention }), modelAliases };
  const settingsSources = snapshot.settingsSources === undefined ? undefined : { ...snapshot.settingsSources, modelAliases: resolution.sources.modelAliases, ...(resolution.sources.skills === undefined ? {} : { skills: resolution.sources.skills }), ...(resolution.sources.extensions === undefined ? {} : { extensions: resolution.sources.extensions }), ...(resolution.sources.tools === undefined ? {} : { tools: resolution.sources.tools }), ...(resolution.sources.extensionSettings === undefined ? {} : { extensionSettings: resolution.sources.extensionSettings }), ...(resolution.sources.retention === undefined ? {} : { retention: resolution.sources.retention }), concurrency: snapshot.settingsSources.concurrency === "per-run options" ? "per-run options" : resolution.sources.concurrency };
  return { settings, ...(settingsSources === undefined ? {} : { settingsSources }) };
}
function mainAgentError(error: unknown): WorkflowError {
  const typed = asWorkflowError(error);
  const presented = new WorkflowError(typed.code, formatWorkflowFailure(typed));
  Object.assign(presented, typed);
  return presented;
}
function completionControlContent(result: unknown, controlRunId?: string): string {
  const record = object(result) ? { ...result } : undefined;
  if (record && controlRunId !== undefined && record.runId === undefined) record.runId = controlRunId;
  const completion = record && object(record.completion) ? record.completion : undefined;
  if (!record || !completion || typeof completion.content !== "string") {
    const serialized = JSON.stringify(record ?? result);
    return typeof serialized === "string" ? serialized : String(result);
  }
  let value: unknown;
  try { value = JSON.parse(completion.content) as unknown; }
  catch { value = completion.content; }
  delete record.value;
  delete record.completion;
  delete record.run;
  return JSON.stringify({ ...record, value });
}
export function formatWorkflowPreview(args: { script?: unknown; scriptPath?: unknown; name?: unknown; description?: unknown }): string {
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : "workflow";
  if (typeof args.script !== "string" || !args.script.trim()) return `workflow ${name}`;
  return [`workflow ${name}`, typeof args.description === "string" && args.description.trim() ? args.description.trim() : ""].filter(Boolean).join("\n");
}
export const WORKFLOW_TOOL_LABEL = "Workflow";
export const WORKFLOW_TOOL_DESCRIPTION = "Run a deterministic JavaScript workflow with a named inline or file-backed parallel-to-summary path by default"
export const WORKFLOW_TOOL_PROMPT_SNIPPET = "Run a deterministic, resumable JavaScript workflow. Prefer a named inline script that fans out independent work with parallel(...), awaits the keyed results before interpolating them into one summarizing agent(...), and returns. Provide exactly one of script or scriptPath and a non-empty name. Registered catalog functions are available as globals inside the script; call them there, for example return await someFunction(args). Advanced controls include registered functions, outputSchema, budgets, checkpoints, worktrees, retry/resume, CLI export, and pipelines. Runs are in the background by default; completion arrives as a follow-up message. Set foreground: true when the caller must wait for the final value. Manage runs from the interactive /workflow picker; use workflow_status, workflow_resume, workflow_retry, workflow_stop, and workflow_respond for explicit tool controls. If a foreground call detaches before its result is accepted, its terminal success or failure is promoted to one follow-up message. Foreground results include the completed run ID. Recovery inherits the source launch mode; legacy snapshots without launchMode recover in the background. Set foreground: true or false on workflow_resume/workflow_retry to override it; foreground recovery waits for terminal value and run details, while background recovery returns immediately and delivers completion or failure as a follow-up. After failure follow-ups, especially CANCELLED or interrupted runs, call workflow_status({ runId }) before recovery or replacement work, then pass its state as expectedState to workflow_retry/workflow_resume so recovery cannot act on a state that changed. Recovery map: agent(..., { retries }) reruns one agent call in the same run for transient failures; workflow_retry({ runId, expectedState?, foreground? }) replays a failed run into a child; workflow_resume({ runId, expectedState?, budget?, foreground? }) continues a budget_exhausted run; parentRunId on a new launch only borrows named worktrees and never replays or resumes."
export const WORKFLOW_TOOL_PARAMETERS = Type.Object({
  name: Type.String({ description: "Required non-empty workflow name" }),
  description: Type.Optional(Type.String({ description: "Optional human-readable workflow description" })),
  script: Type.Optional(Type.String({ description: "Immutable inline workflow source; provide exactly one of script or scriptPath" })),
  scriptPath: Type.Optional(Type.String({ description: "Path to a JavaScript workflow file, read once at launch and persisted as the inline source; provide exactly one of script or scriptPath" })),
  args: Type.Optional(Type.Unknown({ description: "JSON-compatible values available inside the workflow script as args" })),
  foreground: Type.Optional(Type.Boolean({ description: "Wait for completion instead of the default background launch" })),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16, description: "Advanced: optional per-run active-agent limit" })),
  budget: Type.Optional(Type.Unknown({ description: "Advanced: optional aggregate soft and hard run budgets" })),
  parentRunId: Type.Optional(Type.String({ description: "Advanced: terminal run whose named worktrees may be reused" })),
}, { additionalProperties: false });
export const WORKFLOW_STATUS_PARAMETERS = Type.Object({ runId: Type.String({ description: "Workflow run ID visible in the current project" }) }, { additionalProperties: false });
export const WORKFLOW_RETRY_PARAMETERS = Type.Object({ runId: Type.String({ description: "Explicit failed workflow run ID" }), expectedState: Type.Optional(Type.String({ description: "Persisted source state observed before recovery" })), foreground: Type.Optional(Type.Boolean({ description: "Override the source launch mode for this recovery" })) });

function workflowToolUpdate(run: PersistedRun): WorkflowToolUpdate {
  return { content: [{ type: "text", text: formatWorkflowProgress(run) }], details: { runId: run.id, run } };
}
function agentWithProgress(agent: AgentRecord, progress: AgentProgress): AgentRecord {
  const next = { ...agent, accounting: progress.accounting, toolCalls: progress.toolCalls };
  if (progress.state !== undefined) {
    next.model = progress.state.model;
    next.tools = progress.state.tools;
    if (progress.state.systemPrompt !== undefined) next.systemPrompt = progress.state.systemPrompt;
  }
  delete next.activity;
  if (progress.lastEventAt !== undefined) next.lastEventAt = progress.lastEventAt;
  return next;
}

type WorkflowToolResult = { runId?: string; run?: PersistedRun; value?: JsonValue; preview?: string };
function isWorkflowToolResult(value: unknown): value is WorkflowToolResult {
  return object(value) && (value.runId === undefined || typeof value.runId === "string") && (value.run === undefined || isPersistedRun(value.run)) && (value.value === undefined || jsonValue(value.value)) && (value.preview === undefined || typeof value.preview === "string");
}

function deliver(pi: WorkflowExtensionAPI, content: string): void {
  if (typeof pi.sendMessage !== "function") return;
  pi.sendMessage({ customType: "workflow", content, display: true }, { deliverAs: "followUp", triggerTurn: true });
}
const WORKFLOW_WARNING_ENTRY = "workflow-warning";
interface WorkflowWarningEntry { message: string }
function deliverWarning(pi: WorkflowExtensionAPI, content: string): void {
  pi.appendEntry<WorkflowWarningEntry>(WORKFLOW_WARNING_ENTRY, { message: content });
}

type WorkflowEventSink = { emit: (name: string, payload: unknown) => unknown };



function projectTrusted(ctx: unknown): boolean {
  const check = object(ctx) ? ctx.isProjectTrusted : undefined;
  return typeof check === "function" ? Boolean(Reflect.apply(check, ctx, [])) : true;
}
function asFn(value: unknown): ((...args: never[]) => unknown) | undefined { return typeof value === "function" ? value as (...args: never[]) => unknown : undefined; }
function completionContext(ctx: unknown): CompletionDeliveryContext {
  const host = object(ctx) ? ctx : undefined;
  if (!host) return {};
  const getContextUsage = asFn(host.getContextUsage);
  const getModel = () => {
    const model = object(ctx) && object(ctx.model) ? ctx.model : undefined;
    const contextWindow = typeof model?.contextWindow === "number" ? model.contextWindow : undefined;
    const maxTokens = typeof model?.maxTokens === "number" ? model.maxTokens : undefined;
    return contextWindow === undefined && maxTokens === undefined ? undefined : { ...(contextWindow === undefined ? {} : { contextWindow }), ...(maxTokens === undefined ? {} : { maxTokens }) };
  };
  return {
    ...(getContextUsage ? { getContextUsage: () => Reflect.apply(getContextUsage, ctx, []) as ReturnType<NonNullable<CompletionDeliveryContext["getContextUsage"]>> } : {}),
    getModel,
  };
}
type PiHostCapabilities = { registerEntryRenderer?: ExtensionAPI["registerEntryRenderer"]; events?: WorkflowEventSink };
function isWorkflowEventSink(value: unknown): value is WorkflowEventSink { return object(value) && typeof value.emit === "function"; }
function piHostCapabilities(pi: unknown): PiHostCapabilities {
  if (!object(pi)) return {};
  const registerEntryRenderer = asFn(pi.registerEntryRenderer) as NonNullable<PiHostCapabilities["registerEntryRenderer"]> | undefined;
  const events = pi.events;
  return { ...(registerEntryRenderer ? { registerEntryRenderer } : {}), ...(isWorkflowEventSink(events) ? { events } : {}) };
}
type ContextHostCapabilities = { modelRegistry?: ModelRegistryCapability };
type ModelRegistryGetter = () => readonly Model<Api>[];
type ModelRegistryCapability = { getAll?: ModelRegistryGetter; getAvailable?: ModelRegistryGetter; find?: (provider: string, model: string) => Model<Api> | undefined; refresh?: () => Promise<void>; getError?: () => string | undefined };
function contextHostCapabilities(ctx: unknown): ContextHostCapabilities {
  if (!object(ctx) || !object(ctx.modelRegistry)) return {};
  const registry = ctx.modelRegistry;
  const getAll = asFn(registry.getAll) as ModelRegistryGetter | undefined;
  const getAvailable = asFn(registry.getAvailable) as ModelRegistryGetter | undefined;
  const find = asFn(registry.find) as ModelRegistryCapability["find"];
  const refresh = asFn(registry.refresh) as ModelRegistryCapability["refresh"];
  const getError = asFn(registry.getError) as ModelRegistryCapability["getError"];
  return { modelRegistry: { ...(getAll ? { getAll: () => getAll.call(registry) } : {}), ...(getAvailable ? { getAvailable: () => getAvailable.call(registry) } : {}), ...(find ? { find: (provider, model) => find.call(registry, provider, model) } : {}), ...(refresh ? { refresh: () => refresh.call(registry) } : {}), ...(getError ? { getError: () => getError.call(registry) } : {}) } };
}
function modelInventory(root: ModelSpec | undefined, registry: ModelRegistryCapability | undefined): { knownModels: ReadonlySet<string>; availableModels: ReadonlySet<string> } {
  const all = registry?.getAll?.() ?? registry?.getAvailable?.() ?? [];
  const available = registry?.getAvailable?.() ?? registry?.getAll?.() ?? [];
  const knownModels = new Set(all.map((model) => `${model.provider}/${model.id}`));
  const availableModels = new Set(available.map((model) => `${model.provider}/${model.id}`));
  const rootName = root?.provider && root.model ? `${root.provider}/${root.model}` : undefined;
  if (rootName) { knownModels.add(rootName); availableModels.add(rootName); }
  return { knownModels, availableModels };
}
function resumeHostContext(ctx: unknown): { model: { provider: string; id: string } | undefined; modelRegistry: ModelRegistryCapability | undefined; deliveryContext: CompletionDeliveryContext } {
  const model = object(ctx) && object(ctx.model) && typeof ctx.model.provider === "string" && typeof ctx.model.id === "string" ? { provider: ctx.model.provider, id: ctx.model.id } : undefined;
  return { model, modelRegistry: contextHostCapabilities(ctx).modelRegistry, deliveryContext: completionContext(ctx) };
}
async function resolveLaunchAliases(registry: WorkflowRegistryApi, staticAliases: Readonly<Record<string, string>>, context: Readonly<WorkflowModelAliasResolverContext>, availableModels: ReadonlySet<string>, knownModels: ReadonlySet<string>, settingsPath: string): Promise<{ aliases: Readonly<Record<string, string>>; dynamicNames: readonly string[] }> {
  const dynamic = typeof registry.resolveModelAliases === "function" ? await registry.resolveModelAliases(context, new Set(Object.keys(staticAliases))) : {};
  const dynamicNames = Object.keys(dynamic);
  try {
    const aliases = validateModelAliases({ ...dynamic, ...staticAliases }, settingsPath);
    validateModelAliasAvailability(aliases, dynamicNames, availableModels, knownModels, settingsPath);
    return { aliases, dynamicNames };
  } catch (error) {
    const name = modelAliasErrorName(error);
    const descriptor = name && typeof registry.modelAliases === "function" ? registry.modelAliases().find((candidate) => candidate.name === name) : undefined;
    if (descriptor && errorCode(error) !== "CANCELLED") throw new WorkflowError(errorCode(error) ?? "CONFIG_ERROR", `${errorText(error)} (extension: ${descriptor.headline})`);
    throw error;
  }
}

export default function workflowExtension(pi: WorkflowExtensionAPI, home?: string, clipboard = copyToClipboard, transport: AgentTransport = localAgentTransport, agentDir?: string, additionalSkillPaths: readonly string[] = []) {
  beginWorkflowExtensionLoading();
  const registry = loadingRegistry();
  const extensionAgentDir = agentDir ?? getAgentDir();
  const registerEntryRenderer = piHostCapabilities(pi).registerEntryRenderer;
  registerEntryRenderer?.<WorkflowLogEntry>(WORKFLOW_LOG_ENTRY, (entry) => {
    const data = entry.data;
    return textBlock(data ? `Workflow ${data.workflowName}: ${data.message}` : "");
  });
  registerEntryRenderer?.<WorkflowWarningEntry>(WORKFLOW_WARNING_ENTRY, (entry) => {
    const data = entry.data;
    return textBlock(data ? `Warning: ${data.message}` : "");
  });
  let backgroundWidgetEnabled = true;
  try { backgroundWidgetEnabled = loadSettings(workflowSettingsPath(extensionAgentDir)).backgroundWidget ?? true; } catch { /* Keep the optional UI enabled; the launch path reports settings errors. */ }
  const backgroundWidgetController = backgroundWidget(pi, backgroundWidgetEnabled);
  const logBridge = (store: RunStore, lifecycle: RunLifecycle, workflowName: string) => async (message: string) => {
    const timestamp = Date.now();
    const bounded = utf8Prefix(message, DELIVERY_LIMIT_BYTES);
    await lifecycle.enter();
    try {
      const active = runs.get(store.runId);
      const update = active?.foreground ? active.update : undefined;
      const event = { type: "log", message: bounded, timestamp };
      const persisted = await store.updateState((current) => ({ ...current, events: [...(current.events ?? []), event] }));
      if (update && persisted.delivery?.mode === "foreground" && persisted.delivery.state === "attached") { update(workflowToolUpdate(persisted)); return; }
      pi.appendEntry<WorkflowLogEntry>(WORKFLOW_LOG_ENTRY, { workflowName, message: bounded });
    } finally { await lifecycle.leave(); }
  };
  const eventPublisher = new WorkflowEventPublisher(piHostCapabilities(pi).events);
  const reportWorkflowBlocked = (active: boolean, label?: string): void => { try { piHostCapabilities(pi).events?.emit(WORKFLOW_BLOCKED_EVENT, { active, ...(label === undefined ? {} : { label }) }); } catch { /* Workflow state is advisory and must not alter recovery. */ } };
  pi.on("resources_discover", () => {
    if (!pi.getActiveTools().includes("workflow")) return;
    const extensionDir = dirname(fileURLToPath(import.meta.url));
    const skillPath = [join(extensionDir, "../skills"), join(extensionDir, "../../skills")].find((path) => existsSync(path));
    return skillPath ? { skillPaths: [skillPath] } : undefined;
  });
  const runs = new Map<string, WorkflowRunRecord>();
  const deliveryController = new ForegroundDeliveryController({ runs, ...(typeof pi.sendMessage === "function" ? { deliver: (content: string) => { deliver(pi, content); } } : {}) });
  let releaseWorkflowRegistry: (() => void) | undefined;
  const providerRecoveryLane = new SerialLane();
  const enqueueProviderRecovery = <T>(task: () => Promise<T>): Promise<T> => providerRecoveryLane.run(task);
  const runMutationLane = new SerialLane();
  const coordinateRunMutation = <T>(task: () => Promise<T>): Promise<T> => runMutationLane.run(task);
  // The recovery adapter implements only getAvailableSnapshot, refresh, getModel, and getError from ModelRuntime; the constructor below is the one third-party boundary because it cannot create another authenticated runtime.
  type ModelSelectorRuntimeAdapter = Pick<ModelRuntime, "getAvailableSnapshot" | "refresh" | "getModel" | "getError">;
  const createProviderErrorRecovery = (host: unknown, fallbackModels: ReadonlySet<string>, abort: () => void) => {
    if (!object(host) || host.mode !== "tui" || host.hasUI !== true) return undefined;
    const ui = object(host.ui) ? host.ui : undefined;
    const uiCapabilities = uiHostCapabilities(ui);
    const select = uiCapabilities?.select;
    if (!select) return undefined;
    const hostModels = contextHostCapabilities(host).modelRegistry;
    const choose = (title: string, options: string[]) => select.call(ui, title, options);
    const chooseModel = async (failure: AgentProviderFailure): Promise<string | undefined> => {
      const custom = uiCapabilities.custom;
      const getAvailable = hostModels?.getAvailable;
      if (!custom || !getAvailable) {
        const available = getAvailable ? getAvailable().map((model) => `${model.provider}/${model.id}`) : [...fallbackModels];
        return choose(`Available models for subagent "${failure.label}"`, [...new Set(available)].sort());
      }
      const available = getAvailable();
      const current = hostModels.find?.(failure.provider, failure.model) ?? available.find((model) => model.provider === failure.provider && model.id === failure.model);
      const runtime: ModelSelectorRuntimeAdapter = {
        getAvailableSnapshot: getAvailable,
        refresh: async ({ signal }: { signal?: AbortSignal } = {}) => {
          if (signal?.aborted) return { aborted: true, errors: new Map<string, Error>() };
          try { await hostModels.refresh?.(); return { aborted: false, errors: new Map<string, Error>() }; }
          catch (error) { return { aborted: false, errors: new Map([["models", error instanceof Error ? error : new Error(String(error))]]) }; }
        },
        getModel: (provider: string, model: string) => hostModels.find?.(provider, model) ?? getAvailable().find((candidate) => candidate.provider === provider && candidate.id === model),
        getError: () => hostModels.getError?.(),
      };
      return await custom.call(ui, (tui, _theme, _keybindings, done) => new ModelSelectorComponent(tui, current, runtime as ModelRuntime, [], (model) => { done(`${model.provider}/${model.id}`); }, () => { done(undefined); })) as string | undefined;
    };
    return (failure: AgentProviderFailure): Promise<AgentProviderRecovery> => enqueueProviderRecovery(async () => {
      reportWorkflowBlocked(true, `Subagent "${failure.label}" failed`);
      try {
        for (;;) {
          const action = await choose(`Subagent "${failure.label}" failed\nCurrent provider/model: ${failure.provider}/${failure.model}\nProvider error: ${failure.error}\nChoose what to do`, ["Retry", "Change model", "Abort workflow"]);
          if (action === "Retry") return "retry";
          if (action === "Change model") {
            const selected = await chooseModel(failure);
            if (selected) return { model: selected };
            continue;
          }
          abort();
          return "abort";
        }
      } finally {
        reportWorkflowBlocked(false);
      }
    });
  };
  const liveAgents = new LiveAgentRegistry();
  const liveSubagents = new Map<string, { readonly status: Readonly<SubagentStatus>; readonly request: Readonly<SubagentRunRequest> }>();
  const clearSubagentStatusObserver = (): void => { liveSubagents.clear(); registry.setSubagentStatusObserver(undefined); };
  registry.setSubagentStatusObserver((status, request) => { liveSubagents.set(status.id, { status, request }); });
  const trajectoryRuns = (context: unknown) => {
    const host = object(context) ? context : undefined;
    const cwd = typeof host?.cwd === "string" ? host.cwd : undefined;
    const sessionManager = host && object(host.sessionManager) ? host.sessionManager : undefined;
    const sessionId = typeof sessionManager?.getSessionId === "function" ? String(Reflect.apply(sessionManager.getSessionId, sessionManager, [])) : undefined;
    if (!cwd || !sessionId) throw new WorkflowError("RUN_NOT_FOUND", "Trajectory requires the current project and Pi session");
    return { cwd, sessionId };
  };
  const trajectoryAction = async (request: Readonly<TrajectoryActionRequest>, context: unknown): Promise<TrajectoryActionResult | undefined> => {
    if (request.target.kind === "subagent") {
      if (!request.target.id.trim()) throw new WorkflowError("RUN_NOT_FOUND", "Trajectory action requires a subagent ID");
      const manager = getSubagentManager();
      if (!manager) throw new WorkflowError("INTERNAL_ERROR", "Trajectory subagent actions require the subagents extension");
      const managerContext: SubagentManagerContext = { toolCallId: "trajectory", signal: undefined, onUpdate: undefined, extensionContext: context as ExtensionContext };
      if (request.action === "steer") {
        const payload = object(request.payload) ? request.payload : undefined;
        const message = typeof payload?.message === "string" ? payload.message : undefined;
        if (message === undefined || !message.trim()) throw new WorkflowError("INVALID_METADATA", "Trajectory steer requires a message");
        await manager.steer({ id: request.target.id, message }, managerContext);
        return;
      }
      if (request.action === "stop") { await manager.stop({ id: request.target.id }, managerContext); return; }
      if (request.action === "retry") {
        const result = await manager.retry({ id: request.target.id }, { ...managerContext, waitForForeground: false });
        if (!object(result) || typeof result.id !== "string" || result.state !== "running") throw new WorkflowError("INTERNAL_ERROR", "Subagent retry returned an invalid result");
        return { id: result.id, state: "running" };
      }
      throw new WorkflowError("INVALID_METADATA", `Trajectory action ${request.action} is not supported for subagent targets`);
    }
    if (!request.target.id.trim()) throw new WorkflowError("RUN_NOT_FOUND", "Trajectory action requires a run ID");
    const runId = request.target.id;
    const run = runs.get(runId);
    if (request.action === "checkpoint-approve" || request.action === "checkpoint-reject") {
      if (!request.name || !await answerCheckpoint(runId, request.name, request.action === "checkpoint-approve", true)) throw new WorkflowError("RUN_NOT_FOUND", "Checkpoint is no longer awaiting a response");
      return;
    }
    if (request.action === "pause") { if (!run) throw new WorkflowError("RUN_NOT_FOUND", "Workflow run is not active"); await run.lifecycle.pause(); return; }
    if (request.action === "stop") { const result = await stopWorkflowRun(runId); if (!result.stopped && result.reason !== "already_terminal") throw new WorkflowError("RUN_NOT_FOUND", "Workflow run is not active"); return; }
    if (request.action === "resume") { await resumeSelectedWorkflow(runId, false, context); return; }
    if (request.action !== "retry") throw new WorkflowError("INVALID_METADATA", `Trajectory action ${request.action} is handled by the Trajectory extension`);
    await recovery.retryWorkflowRun(runId, context);
  };
  const trajectoryProvider: TrajectoryPublisherProvider = (context) => {
    const { cwd, sessionId } = trajectoryRuns(context);
    const trusted = projectTrusted(context);
    const settings = resolveWorkflowSettings(cwd, trusted, workflowSettingsPath(extensionAgentDir)).effective.extensionSettings?.trajectory;
    const port = settings?.port;
    const themes = settings?.themes ?? false;
    const loadRuns = createTrajectoryRunLoader(cwd, sessionId, home, (run) => {
      const active = runs.get(run.id);
      const live = withLiveActivities(run);
      return active ? { ...live, state: active.lifecycle.state, usage: active.budget.usage } : live;
    });
    const loadSubagents = createTrajectorySubagentLoader(cwd, sessionId, extensionAgentDir, (subagent) => {
      const live = liveSubagents.get(subagent.id);
      if (!live) return subagent;
      if (live.status.sessionId !== subagent.sessionId) return subagent;
      if (live.status.state !== "running" && live.status.finishedAt === subagent.finishedAt) { liveSubagents.delete(subagent.id); return subagent; }
      const attempt = live.status.attemptDetails?.at(-1) ?? subagent.attempt;
      const tools = live.status.progress?.state?.tools ?? attempt?.setup.tools ?? subagent.tools;
      const model = live.status.progress?.state?.model ?? attempt?.setup.model ?? subagent.model;
      return { ...subagent, request: live.request, mode: live.request.mode ?? subagent.mode, state: live.status.state, tools, ...(live.status.startedAt === undefined ? {} : { startedAt: live.status.startedAt }), ...(live.status.finishedAt === undefined ? {} : { finishedAt: live.status.finishedAt }), ...(live.status.attempts === undefined ? {} : { attempts: live.status.attempts }), ...(live.status.error === undefined ? {} : { error: live.status.error }), ...(live.status.worktree === undefined ? {} : { worktree: live.status.worktree }), ...(model === undefined ? {} : { model }), ...(live.status.progress === undefined ? {} : { progress: live.status.progress }), ...(attempt === undefined ? {} : { attempt }) };
    });
    const loadRunsMetadata = createTrajectoryRunMetadataLoader(cwd, sessionId, home, (run) => {
      const active = runs.get(run.id);
      const live = withLiveActivities(run);
      return active ? { ...live, state: active.lifecycle.state, usage: active.budget.usage } : live;
    });
    const loadSubagentsMetadata = createTrajectorySubagentMetadataLoader(cwd, sessionId, extensionAgentDir, (subagent) => {
      const live = liveSubagents.get(subagent.id);
      if (!live || live.status.sessionId !== subagent.sessionId) return subagent;
      if (live.status.state !== "running" && live.status.finishedAt === subagent.finishedAt) { liveSubagents.delete(subagent.id); return subagent; }
      const attempt = live.status.attemptDetails?.at(-1) ?? subagent.attempt;
      const tools = live.status.progress?.state?.tools ?? attempt?.setup.tools ?? subagent.tools;
      const model = live.status.progress?.state?.model ?? attempt?.setup.model ?? subagent.model;
      return { ...subagent, request: live.request, mode: live.request.mode ?? subagent.mode, state: live.status.state, tools, ...(live.status.startedAt === undefined ? {} : { startedAt: live.status.startedAt }), ...(live.status.finishedAt === undefined ? {} : { finishedAt: live.status.finishedAt }), ...(live.status.attempts === undefined ? {} : { attempts: live.status.attempts }), ...(live.status.error === undefined ? {} : { error: live.status.error }), ...(live.status.worktree === undefined ? {} : { worktree: live.status.worktree }), ...(model === undefined ? {} : { model }), ...(live.status.progress === undefined ? {} : { progress: live.status.progress }), ...(attempt === undefined ? {} : { attempt }) };
    });
    const loadTranscript = createTrajectoryTranscriptLoader(cwd, sessionId, home, extensionAgentDir, (subagentId) => {
      const live = liveSubagents.get(subagentId);
      return live?.status.sessionId === sessionId ? live.status.attemptDetails?.at(-1)?.session : undefined;
    });
    return { cwd, sessionId, ...(port === undefined ? {} : { port }), themes, loadRuns, loadSubagents, loadMetadata: async () => ({ runs: await loadRunsMetadata(), subagents: await loadSubagentsMetadata() }), loadTranscript, handleAction: (request: Readonly<TrajectoryActionRequest>) => trajectoryAction(request, context) };
  };
  const withLiveActivities = (run: PersistedRun): PersistedRun => liveAgents.overlay(run);
  const terminalRunStates = new Map<string, "completed" | "failed" | "stopped">();
  let sessionLease: SessionLease | undefined;
  let sessionLeasePromise: Promise<SessionLease> | undefined;
  const ensureSessionLease = async (cwd: string, sessionId: string) => {
    if (sessionLease?.active) return;
    const pending = sessionLeasePromise ?? (sessionLeasePromise = acquireSessionLease(cwd, sessionId, home));
    try { sessionLease = await pending; }
    finally { if (sessionLeasePromise === pending) sessionLeasePromise = undefined; }
  };
  const releaseSessionLease = async () => {
    const lease = sessionLease ?? await sessionLeasePromise?.catch(() => undefined);
    sessionLease = undefined;
    sessionLeasePromise = undefined;
    await lease?.release();
  };
  const persistRunState = async (store: RunStore, metadata: WorkflowMetadata, update: (run: PersistedRun) => PersistedRun | Promise<PersistedRun>): Promise<PersistedRun> => {
    const persisted = await store.updateState(update);
    await eventPublisher.budget(store, metadata, persisted);
    return persisted;
  };
  pi.on("tool_result", async (event) => {
    const delivery = event.toolName === "workflow" ? deliveryController.foregroundDeliveries.get(event.toolCallId) : undefined;
    if (delivery && !delivery.detached) deliveryController.foregroundDeliveries.delete(event.toolCallId);
    if (event.toolName !== "workflow" || !event.isError) return;
    const pending = deliveryController.pendingFailureDiagnostics.get(event.toolCallId);
    if (!pending) return;
    deliveryController.pendingFailureDiagnostics.delete(event.toolCallId);
    const run = (await pending.store.load()).run;
    return { content: [{ type: "text" as const, text: serializeWorkflowFailureDiagnostics(pending.diagnostic) }], details: { ...pending.diagnostic, run }, isError: true };
  });
  const phaseBridge = (store: RunStore, metadata: WorkflowMetadata, lifecycle: RunLifecycle) => {
    let cursor = 0;
    return async (phase: string): Promise<void> => {
      await scheduler.flush(store.runId);
      await lifecycle.enter();
      try {
        let previousPhase: string | undefined;
        const persisted = await persistRunState(store, metadata, (current) => {
          previousPhase = current.phase;
          const history = current.phaseHistory ?? [];
          if (history[cursor]?.phase === phase) {
            const phaseHistoryIndex = cursor;
            cursor += 1;
            return { ...current, phase, phaseHistoryIndex };
          }
          const phaseHistoryIndex = history.length;
          cursor = history.length + 1;
          return { ...current, phase, phaseHistoryIndex, phaseHistory: [...history, { phase, afterAgent: current.agents.length }] };
        });
        await eventPublisher.phase(store, metadata, previousPhase, phase);
        runs.get(store.runId)?.update?.(workflowToolUpdate(persisted));
      } finally { await lifecycle.leave(); }
    };
  };
  const persistWorktree = async (store: RunStore, metadata: WorkflowMetadata, owner: string): Promise<WorktreeReference> => {
    const existing = (await store.worktrees()).some((worktree) => worktree.owner === owner);
    const worktree = await store.worktree(owner);
    if (!existing && await store.ownsWorktree(owner)) await eventPublisher.worktree(store, metadata, worktree);
    return worktree;
  };
  const resolveWorktree = async (store: RunStore, metadata: WorkflowMetadata, owner: string): Promise<Readonly<WorkflowWorktreeReference>> => {
    const run = runs.get(store.runId);
    if (!run) fail("INTERNAL_ERROR", `Unknown production run: ${store.runId}`);
    await run.lifecycle.enter();
    try {
      const worktree = await persistWorktree(store, metadata, owner);
      return { path: worktree.path, branch: worktree.branch };
    } finally { await run.lifecycle.leave(); }
  };
  const shellForRun = async (store: RunStore, metadata: WorkflowMetadata, lifecycle: RunLifecycle, command: string, options: ShellOptions, signal: AbortSignal, identity: ShellIdentity): Promise<ShellResult> => {
    await lifecycle.enter();
    try {
      const path = shellIdentityPath(identity);
      const replayed = await store.replay(path);
      if (replayed) return readShellResult(replayed.value);
      const shellStartedAt = Date.now();
      let shellPhaseIndex = -1;
      const started = await persistRunState(store, metadata, (current) => {
        const history = current.phaseHistory ?? [];
        if (current.phase !== undefined) shellPhaseIndex = current.phaseHistoryIndex ?? (history.length ? history.length - 1 : 0);
        const phaseActivities = [...(current.activeShellsByPhase ?? [])];
        const phaseActivityIndex = phaseActivities.findIndex(({ phaseIndex }) => phaseIndex === shellPhaseIndex);
        const nextPhaseActivities = phaseActivityIndex >= 0
          ? phaseActivities.map((activity, index) => index === phaseActivityIndex ? { ...activity, active: activity.active + 1 } : activity)
          : [...phaseActivities, { phaseIndex: shellPhaseIndex, active: 1, startedAt: shellStartedAt }];
        const activeShells = current.activeShells ?? 0;
        return { ...current, activeShells: activeShells + 1, ...(activeShells > 0 && current.activeShellStartedAt !== undefined ? {} : { activeShellStartedAt: shellStartedAt }), activeShellsByPhase: nextPhaseActivities };
      });
      runs.get(store.runId)?.update?.(workflowToolUpdate(withLiveActivities(started)));
      try {
        const cwd = identity.worktreeOwner ? (await persistWorktree(store, metadata, identity.worktreeOwner)).cwd : store.cwd;
        const result = await executeShellCommand(command, options, signal, cwd);
        if (!jsonValue(result)) fail("SHELL_FAILED", "Shell result is not JSON-compatible");
        await store.complete(path, result);
        return result;
      } finally {
        const stopped = await persistRunState(store, metadata, (current) => {
          const phaseActivities = [...(current.activeShellsByPhase ?? [])];
          const phaseActivityIndex = phaseActivities.findIndex(({ phaseIndex }) => phaseIndex === shellPhaseIndex);
          const phaseActivity = phaseActivities[phaseActivityIndex];
          const nextPhaseActivities = phaseActivityIndex < 0 ? phaseActivities : phaseActivity && phaseActivity.active > 1
            ? phaseActivities.map((activity, index) => index === phaseActivityIndex ? { ...activity, active: activity.active - 1 } : activity)
            : phaseActivities.filter((_, index) => index !== phaseActivityIndex);
          const activeShells = Math.max(0, (current.activeShells ?? 0) - 1);
          if (activeShells > 0) {
            const next = { ...current, activeShells };
            if (nextPhaseActivities.length) next.activeShellsByPhase = nextPhaseActivities; else delete next.activeShellsByPhase;
            return next;
          }
          const next = { ...current };
          delete next.activeShells;
          delete next.activeShellStartedAt;
          delete next.activeShellsByPhase;
          return next;
        });
        runs.get(store.runId)?.update?.(workflowToolUpdate(withLiveActivities(stopped)));
      }
    } finally { await lifecycle.leave(); }
  };
  const lifecycleFor = (store: RunStore, state: RunState, metadata: WorkflowMetadata) => new RunLifecycle(state, async (next, previous, reason) => {
    const run = runs.get(store.runId);
    if (!run) throw new WorkflowError("INTERNAL_ERROR", `Unknown production run: ${store.runId}`);
    if (next !== "pausing") run.budget.transition(next);
    const persisted = await persistRunState(store, metadata, (current) => {
      const nextRun = { ...current, state: next, ...run.budget.snapshot() };
      if (next === "running" || next === "completed") { delete nextRun.error; delete nextRun.failedAt; }
      if (next === "running" && (previous === "paused" || previous === "interrupted" || previous === "budget_exhausted") && nextRun.delivery?.state === "delivered") nextRun.delivery = { ...nextRun.delivery, state: "pending" };
      return nextRun;
    });
    await eventPublisher.runState(store, metadata, previous, next, reason);
    runs.get(store.runId)?.update?.(workflowToolUpdate(withLiveActivities(persisted)));
  });
  const scheduler = new FairAgentScheduler(async ({ id, runId, tuiIndex, parentId, prompt, options, signal, setSteer }) => {
    const run = runs.get(runId);
    if (!run) throw new WorkflowError("INTERNAL_ERROR", `Unknown production run: ${runId}`);
    try {
      const budget = run.budget.forAgent(id);
      const onProgress = async (progress: AgentProgress) => {
        let runState: PersistedRun;
        if (progress.persist) {
          runState = await persistRunState(run.store, run.metadata, (current) => current.agents.some((agent) => agent.id === id) ? { ...current, ...run.budget.snapshot(), agents: current.agents.map((agent) => agent.id === id ? agentWithProgress(agent, progress) : agent) } : current);
        } else {
          const loaded = await run.store.load();
          if (!loaded.run.agents.some((agent) => agent.id === id)) return;
          runState = { ...loaded.run, ...run.budget.snapshot(), agents: loaded.run.agents.map((agent) => agent.id === id ? agentWithProgress(agent, progress) : agent) };
        }
        if (!runState.agents.some((agent) => agent.id === id)) return;
        liveAgents.setActivity(runId, id, progress.activity);
        liveAgents.setEventTime(runId, id, progress.lastEventAt);
        run.update?.(workflowToolUpdate(withLiveActivities(runState)));
      };
      const onAttempt = async (attempt: AgentAttempt) => {
        liveAgents.setSession(runId, id, attempt.liveSession);
        liveAgents.setHandoff(runId, id, attempt);
        await scheduler.flush(runId);
        scheduler.attemptStarted(id);
        const lastEventAt = Date.now();
        liveAgents.setEventTime(runId, id, lastEventAt);
        await scheduler.flush(runId);
        const before = (await run.store.load()).run;
        await persistActiveAgentAttempt(run.store, id, attempt);
        const active = (await run.store.load()).run;
        await eventPublisher.agentStates(run.store, run.metadata, before.agents, active.agents);
        const persisted = await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot(), agents: current.agents.map((agent) => agent.id === id ? { ...agent, lastEventAt } : agent) }));
        run.update?.(workflowToolUpdate(withLiveActivities(persisted)));
      };
      const result = await run.executor.execute(prompt, { label: options.label, workflowName: run.metadata.name, tuiIndex, tuiLabel: options.requestedLabel ?? options.label, onProgress, onAttempt, budget, ...(run.providerErrorRecovery ? { providerErrorRecovery: run.providerErrorRecovery } : {}), ...(parentId ? { parent: parentId, cwd: options.cwd, ...(options.worktreeOwner ? { worktreeOwner: options.worktreeOwner } : {}) } : options.worktreeOwner ? { worktreeOwner: options.worktreeOwner } : {}), ...(options.model ? { model: options.model } : {}), ...(options.role ? { role: options.role } : {}), ...(options.contextFiles ? { contextFiles: options.contextFiles } : {}), tools: options.tools, ...(options.skills ? { skills: options.skills } : {}), ...(options.extensions ? { extensions: options.extensions } : {}), effectiveTools: options.tools, ...(options.schema ? { schema: options.schema } : {}), ...(options.retries === undefined ? {} : { retries: options.retries }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.sessionPath ? { sessionPath: options.sessionPath } : {}), ...(options.agentOptions ? { agentOptions: options.agentOptions } : {}), ...(options.agentIdentity ? { agentIdentity: options.agentIdentity } : {}) }, signal, scheduler.toolsFor(id, (role, tools, model, inheritedTools, skills, extensions) => run.executor.resolve({ label: "child", workflowName: run.metadata.name, ...(model ? { model } : {}), ...(role ? { role } : {}), ...(tools !== undefined ? { tools } : {}), ...(skills !== undefined ? { skills } : {}), ...(extensions !== undefined ? { extensions } : {}) }, inheritedTools).tools), setSteer, () => { scheduler.cancelChildren(id); scheduler.retry(id); });
      const before = (await run.store.load()).run;
      await persistAgentAttempts(run.store, id, result.attempts);
      const completed = (await run.store.load()).run;
      await eventPublisher.agentStates(run.store, run.metadata, before.agents, completed.agents);
      const persisted = await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot() }));
      liveAgents.setActivity(runId, id);
      liveAgents.setSession(runId, id);
      run.update?.(workflowToolUpdate(withLiveActivities(persisted)));
      return result.value;
    } catch (error) {
      liveAgents.setSession(runId, id);
      const attempts = getAgentAttempts(error);
      if (attempts?.length) {
        const before = (await run.store.load()).run;
        await persistAgentAttempts(run.store, id, attempts);
        const failed = (await run.store.load()).run;
        await eventPublisher.agentStates(run.store, run.metadata, before.agents, failed.agents);
      }
      const persisted = await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot() }));
      liveAgents.setActivity(runId, id);
      run.update?.(workflowToolUpdate(withLiveActivities(persisted)));
      throw error;
    }
  }, 16, async (runId, ownership) => {
    const run = runs.get(runId);
    if (!run) return;
    await run.store.saveOwnership(ownership);
    let previousAgents: readonly AgentRecord[] = [];
    const runState = await persistRunState(run.store, run.metadata, (current) => {
      previousAgents = current.agents;
      const existing = new Map(current.agents.map((agent) => [agent.id, agent]));
      const agents = ownership.map((node) => {
        const previous = existing.get(node.id);
        const requested = { label: node.options.label, workflowName: run.metadata.name, ...(node.options.skills ? { skills: node.options.skills } : {}), ...(node.options.extensions ? { extensions: node.options.extensions } : {}), ...(node.options.model ? { model: node.options.model } : {}), ...(node.options.role ? { role: node.options.role } : {}), ...(node.options.contextFiles ? { contextFiles: node.options.contextFiles } : {}) };
        let effective: { model: ModelSpec; requestedModel?: string; tools: readonly string[] };
        try { effective = { ...run.executor.resolve({ ...requested, effectiveTools: node.options.tools }), tools: node.options.tools }; }
        catch { effective = previous ? { model: previous.model, ...(previous.requestedModel ? { requestedModel: previous.requestedModel } : {}), tools: previous.tools } : { model: node.options.model ? modelSpec(node.options.model, run.model) : run.model, ...(node.options.model ? { requestedModel: node.options.model } : {}), tools: node.options.tools }; }
        const resultPath = !node.parentId && node.options.agentIdentity ? agentIdentityPath(node.options.agentIdentity) : undefined;
        const nodeRole = roleNameOf(node.options.role);
        const now = Date.now();
        const lastEventAt = node.state === "running" ? previous?.state === "running" && previous.lastEventAt !== undefined ? previous.lastEventAt : now : previous?.lastEventAt;
        const startedAt = previous?.startedAt ?? (node.state === "running" ? now : undefined);
        const durationMs = previous?.durationMs ?? (SETTLED_AGENT_STATES.has(node.state) && startedAt !== undefined ? Math.max(0, now - startedAt) : undefined);
        return { ...(previous?.systemPrompt === undefined ? {} : { systemPrompt: previous.systemPrompt }), ...(node.prompt !== undefined ? { prompt: node.prompt } : previous?.prompt !== undefined ? { prompt: previous.prompt } : {}), id: node.id, name: node.label, ...(node.options.requestedLabel ? { label: node.options.requestedLabel } : {}), path: node.id, state: node.state, ...(node.parentId ? { parentId: node.parentId } : {}), structuralPath: [...(node.options.agentIdentity?.structuralPath ?? [])], ...(resultPath ? { resultPath } : {}), ...(node.options.parentBreadcrumb ? { parentBreadcrumb: node.options.parentBreadcrumb } : {}), ...(node.options.worktreeOwner ? { worktreeOwner: node.options.worktreeOwner } : {}), ...(node.options.agentIdentity?.handle === undefined ? {} : { handle: node.options.agentIdentity.handle, ...(node.options.agentIdentity.turn === undefined ? {} : { turn: node.options.agentIdentity.turn }), ...(node.options.continuity ? { continuity: node.options.continuity } : {}) }), ...(nodeRole ? { role: nodeRole } : {}), ...(effective.requestedModel ? { requestedModel: effective.requestedModel } : {}), model: effective.model, tools: effective.tools, attempts: previous?.attempts ?? 0, ...(startedAt === undefined ? {} : { startedAt }), ...(durationMs === undefined ? {} : { durationMs }), ...(previous?.attemptDetails ? { attemptDetails: previous.attemptDetails } : {}), ...(previous?.accounting ? { accounting: previous.accounting } : {}), ...(previous?.toolCalls ? { toolCalls: previous.toolCalls } : {}), ...(previous?.activity ? { activity: previous.activity } : {}), ...(lastEventAt === undefined ? {} : { lastEventAt }) };
      });
      return { ...current, agents };
    });
    await eventPublisher.agentStates(run.store, run.metadata, previousAgents, runState.agents);
    run.update?.(workflowToolUpdate(withLiveActivities(runState)));
  });
  const cleanupTerminalRun = async (runId: string): Promise<void> => {
    const run = runs.get(runId);
    if (!run || !HARD_TERMINAL_RUN_STATES.has(run.lifecycle.state)) return;
    await scheduler.cancelRun(runId);
    await scheduler.flush(runId);
    if (runs.get(runId) !== run) return;
    scheduler.removeRun(runId);
    terminalRunStates.set(runId, run.lifecycle.state as "completed" | "failed" | "stopped");
    run.checkpointResolvers.clear();
    liveAgents.deleteRun(runId);
    eventPublisher.removeRun(runId);
    runs.delete(runId);
  };
  type WorkflowStopResult = { runId: string; state: RunState | "unknown"; stopped: boolean; reason?: "unknown_run" | "already_terminal" };
  const stopWorkflowRun = async (runId: string): Promise<WorkflowStopResult> => {
    const run = runs.get(runId);
    const terminalState = terminalRunStates.get(runId);
    if (!run) return terminalState ? { runId, state: terminalState, stopped: false, reason: "already_terminal" } : { runId, state: "unknown", stopped: false, reason: "unknown_run" };
    const state = run.lifecycle.state;
    if (state === "completed" || state === "failed" || state === "stopped") return { runId, state, stopped: false, reason: "already_terminal" };
    await run.lifecycle.terminal("stopped");
    run.abortController.abort();
    run.execution?.cancel();
    await scheduler.cancelRun(run.store.runId);
    await scheduler.flush(run.store.runId);
    await cleanupTerminalRun(runId);
    return { runId, state: "stopped", stopped: true };
  };
  type WorkflowStatusAgent = { id: string; label?: string; path: string; state: AgentRecord["state"]; lastEventAt?: number; accounting?: NonNullable<AgentRecord["accounting"]> };
  type WorkflowStatusResult = { runId: string; workflowName: string; state: RunState; error?: { code: WorkflowErrorCode; message: string }; failedAt?: string; budget?: NonNullable<PersistedRun["budget"]>; usage?: NonNullable<PersistedRun["usage"]>; phase?: string; delivery?: Pick<NonNullable<PersistedRun["delivery"]>, "mode" | "state">; agents: readonly WorkflowStatusAgent[] };
  const workflowStatusRun = async (runId: string, context: unknown): Promise<WorkflowStatusResult> => {
    const host = object(context) ? context : {};
    const cwd = typeof host.cwd === "string" ? host.cwd : undefined;
    if (!cwd || !runId.trim()) throw new WorkflowError("RUN_NOT_FOUND", `Unknown workflow run ${runId} in the current project`);
    for (const sessionId of await listPersistedSessionIds(cwd, home)) {
      if (!(await listRunIds(cwd, sessionId, home, false)).includes(runId)) continue;
      const store = new RunStore(cwd, sessionId, runId, home);
      try {
        const run = await store.loadStatus();
        const failedAt = run.failedAt ?? run.error?.failedAt;
        return {
          runId: run.id, workflowName: run.workflowName, state: run.state,
          ...(run.error ? { error: { code: run.error.code, message: run.error.message } } : {}),
          ...(failedAt ? { failedAt } : {}),
          ...(run.budget === undefined ? {} : { budget: run.budget, ...(run.usage === undefined ? {} : { usage: run.usage }) }),
          ...(run.phase ? { phase: run.phase } : {}),
          ...(run.delivery ? { delivery: { mode: run.delivery.mode, state: run.delivery.state } } : {}),
          agents: run.agents.map((agent) => ({ id: agent.id, ...(agent.label === undefined ? {} : { label: agent.label }), path: agent.path, state: agent.state, ...(agent.lastEventAt === undefined ? {} : { lastEventAt: agent.lastEventAt }), ...(agent.accounting === undefined ? {} : { accounting: agent.accounting }) })),
        };
      } catch {
        continue;
      }
    }
    throw new WorkflowError("RUN_NOT_FOUND", `Unknown workflow run ${runId} in the current project`);
  };
  const answerCheckpoint = async (runId: string, name: string, approved: boolean, silent = false) => {
    const run = runs.get(runId);
    if (!run) return false;
    const checkpoint = await run.store.answerCheckpoint(name, approved);
    if (!checkpoint) return false;
    await eventPublisher.checkpoint(run.store, run.metadata, checkpoint.name, approved ? "approved" : "rejected");
    if ((await run.store.awaitingCheckpoints()).length === 0) await run.lifecycle.resolveAwaitingInput();
    run.checkpointResolvers.get(checkpoint.path)?.(approved);
    run.checkpointResolvers.delete(checkpoint.path);
    if (!silent) deliver(pi, `Workflow ${run.metadata.name} checkpoint ${name}: ${approved ? "Approved" : "Rejected"}.`);
    return true;
  };
  const backgroundCheckpointDeliveries = new Set<string>();
  const deliverBackgroundCheckpoint = (workflowName: string, runId: string, checkpoint: { path: string; name: string; prompt: string; context: JsonValue }): void => {
    const key = `${runId}:${checkpoint.path}`;
    if (backgroundCheckpointDeliveries.has(key)) return;
    backgroundCheckpointDeliveries.add(key);
    deliver(pi, `Workflow ${workflowName} checkpoint ${checkpoint.name}: ${checkpoint.prompt}\nContext: ${JSON.stringify(checkpoint.context)}\nRespond with workflow_respond.`);
  };
  const checkpointBridge = (runId: string, store: RunStore, metadata: WorkflowMetadata, foreground: boolean | (() => boolean), ui?: { select?: (prompt: string, options: string[]) => Promise<string | undefined> }, headless = false) => {
    const checkpointCounters = new Map<string, number>();
    const isForeground = () => typeof foreground === "function" ? foreground() : foreground;
    return async (raw: Readonly<Record<string, JsonValue>>, signal: AbortSignal): Promise<boolean> => {
      const input = validateCheckpoint(raw);
      const label = nextNamedOccurrence(checkpointCounters, input.name);
      const path = operationPath("checkpoint", label);
      if (headless) fail("RESUME_INCOMPATIBLE", "Headless CLI checkpoints are unsupported");
      if (isForeground() && !ui?.select) fail("RESUME_INCOMPATIBLE", "Foreground checkpoints require UI");
      const alreadyAwaiting = (await store.awaitingCheckpoints()).some((checkpoint) => checkpoint.path === path);
      const replayed = await store.awaitCheckpoint({ ...input, name: label, path });
      if (replayed !== undefined) return replayed;
      if (!alreadyAwaiting) await eventPublisher.checkpoint(store, metadata, label, "awaiting");
      const run = runs.get(runId);
      await run?.lifecycle.enterAwaitingInput();
      if (!alreadyAwaiting && (!isForeground() || !ui?.select)) deliverBackgroundCheckpoint(metadata.name, runId, { ...input, name: label, path });
      const decision = new Promise<boolean>((resolve, reject) => {
        run?.checkpointResolvers.set(path, resolve);
        if (signal.aborted) reject(new WorkflowError("CANCELLED", "Workflow cancelled"));
        else signal.addEventListener("abort", () => { run?.checkpointResolvers.delete(path); reject(new WorkflowError("CANCELLED", "Workflow cancelled")); }, { once: true });
      });
      const answered = await store.awaitCheckpoint({ ...input, name: label, path });
      if (answered !== undefined) {
        if ((await store.awaitingCheckpoints()).length === 0) await run?.lifecycle.resolveAwaitingInput();
        run?.checkpointResolvers.get(path)?.(answered);
        run?.checkpointResolvers.delete(path);
      }
      if (ui?.select && isForeground()) void (async () => {
        while (!signal.aborted && run?.checkpointResolvers.has(path)) {
          const choice = await ui.select?.(input.prompt, ["Approve", "Reject"]);
          if (!choice) {
            if (isForeground()) continue;
            deliverBackgroundCheckpoint(metadata.name, runId, { ...input, name: label, path });
            return;
          }
          if (await answerCheckpoint(runId, label, choice === "Approve", true)) return;
        }
        if (!isForeground() && !signal.aborted && run?.checkpointResolvers.has(path)) deliverBackgroundCheckpoint(metadata.name, runId, { ...input, name: label, path });
      //NOTE: background checkpoint-UI poll loop; swallow so a transient render error stops polling silently instead of surfacing as an unhandled rejection — the pending checkpoint resolves via the normal delivery path below.
      })().catch(() => undefined);
      return decision;
    };
  };
  const registerControlTool = <P extends TSchema>(
    name: string,
    label: string,
    description: string,
    parameters: P,
    run: (params: Static<P>, signal: AbortSignal, ctx: unknown) => Promise<{ text: string; details: unknown }>,
  ) => {
    pi.registerTool({
      name,
      label,
      description,
      parameters,
      async execute(_id, params, signal: AbortSignal, _onUpdate, ctx) {
        try {
          const result = await run(params, signal, ctx);
          return { content: [{ type: "text" as const, text: result.text }], details: result.details };
        } catch (error) {
          throw mainAgentError(error);
        }
      },
      renderCall(args, theme) { return styledTextBlock(workflowControlCall(name, args, theme)); },
      renderResult(result, options, theme, context) { return workflowCatalogBlock(workflowControlResult(name, context.args, result, options.expanded, theme, context.isError), options.expanded); },
    });
  };

  registerControlTool(
    "workflow_respond",
    "Workflow Respond",
    "Approve or reject one pending workflow checkpoint or budget decision",
    Type.Object({ runId: Type.String(), name: Type.Optional(Type.String()), proposalId: Type.Optional(Type.String()), approved: Type.Boolean() }, { additionalProperties: false }),
    async (params, signal, ctx) => {
      if (params.proposalId) {
        const result = await recovery.answerBudgetDecision(params.runId, params.proposalId, params.approved, false, ctx, signal);
        if (!result) { const denied = { state: "budget_exhausted" as const, approved: false, reason: "proposal_not_pending" }; return { text: JSON.stringify(denied), details: denied }; }
        return { text: completionControlContent(result, params.runId), details: { ...result, reason: params.approved ? "approved" : "rejected" } };
      }
      if (!params.name) throw new WorkflowError("INVALID_METADATA", "workflow_respond requires name or proposalId");
      const accepted = await answerCheckpoint(params.runId, params.name, params.approved);
      return { text: accepted ? "Checkpoint response accepted." : "Checkpoint is not awaiting a response.", details: { accepted, state: accepted ? "checkpoint_answered" : "not_pending", approved: params.approved, reason: "checkpoint" } };
    },
  );
  registerControlTool(
    "workflow_stop",
    "Workflow Stop",
    "Stop an active workflow run by ID",
    Type.Object({ runId: Type.String() }, { additionalProperties: false }),
    async (params) => {
      const result = await stopWorkflowRun(params.runId);
      return { text: JSON.stringify(result), details: result };
    },
  );
  registerControlTool(
    "workflow_status",
    "Workflow Status",
    "Read a compact summary of a workflow run in the current project",
    WORKFLOW_STATUS_PARAMETERS,
    async (params, _signal, ctx) => {
      const result = await workflowStatusRun(params.runId, ctx);
      return { text: JSON.stringify(result), details: result };
    },
  );
  let catalogRegistered = false;
  let sessionStarted = false;
  const registerCatalog = (cwd: string, trustedProject: boolean) => {
    if (catalogRegistered || !pi.getActiveTools().includes("workflow")) return;
    const catalog = registry.catalog({ cwd, projectTrusted: trustedProject, globalSettingsPath: workflowSettingsPath(extensionAgentDir) });
    const hasAliases = Object.keys(catalog.modelAliases ?? {}).length > 0 || Boolean(catalog.modelAliasEntries?.length);
    const hasSettings = catalog.settings !== undefined && [catalog.settings.globalSettingsPath, catalog.settings.projectSettingsPath].some((path) => existsSync(path));
    if (!catalog.functions.length && !hasAliases && !hasSettings) return;
    pi.registerTool({
      name: "workflow_catalog",
      label: "Workflow Catalog",
      description: "List reusable workflow functions and model aliases; pass `name` to load one entry in full",
      parameters: Type.Object({ name: Type.Optional(Type.String({ description: "Registered function or model alias name for full detail" })) }, { additionalProperties: false }),
      async execute(_id, params = {}) {
        const context = { cwd, projectTrusted: trustedProject, globalSettingsPath: workflowSettingsPath(extensionAgentDir) };
        const result = params.name === undefined ? registry.catalogIndex(context) : registry.catalogDetail(params.name, context);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      },
      renderCall(args, theme) {
        const title = theme.fg("toolTitle", theme.bold("workflow_catalog"));
        return styledTextBlock(args.name === undefined ? title : `${title} ${theme.fg("accent", args.name)}`);
      },
      renderResult(result, options, theme) {
        return workflowCatalogBlock(formatWorkflowCatalog(catalogResultValue(result), options.expanded, theme), options.expanded);
      },
    });
    catalogRegistered = true;
  };
  const createAgentExecutor = (root: Omit<import("./agent-execution.js").AgentExecutionRoot, "agentDir" | "agentSetupHooks">) => new WorkflowAgentExecutor({ ...root, agentDir: extensionAgentDir, ...(additionalSkillPaths.length ? { additionalSkillPaths } : {}), agentSetupHooks: registry.agentSetupHooks(), onResourceWarning: (message) => { deliverWarning(pi, message); } }, transport);
  const activeSnapshotTools = (tools: readonly string[], active: ReadonlySet<string> | "session") => active === "session"
    ? new Set(tools.filter((tool) => pi.getActiveTools().includes(tool) && tool !== "workflow_catalog"))
    : new Set(tools.filter((tool) => active.has(tool) || tool === "workflow_catalog"));
  const resumeLaunchPrologue = async (input: {
    snapshot: Readonly<LaunchSnapshot>;
    cwd: string;
    trustedProject: boolean;
    rootModel: ModelSpec;
    modelRegistry?: ModelRegistryCapability | undefined;
    signal: AbortSignal;
    resolvedAliases?: Readonly<Record<string, string>>;
    blockedAliases?: ReadonlySet<string>;
    blockedAliasTargets?: Readonly<Record<string, string>>;
    withPreflight: boolean;
  }) => {
    const active = new Set(pi.getActiveTools().filter((tool) => !INTERNAL_WORKFLOW_TOOLS.includes(tool)));
    const missing = input.snapshot.tools.filter((tool) => tool !== "workflow_catalog").find((tool) => !active.has(tool));
    if (missing) throw new WorkflowError("RESUME_INCOMPATIBLE", `Required tool is unavailable: ${missing}`);
    const settingsPath = workflowSettingsPath(extensionAgentDir);
    const resolution = resolveWorkflowSettings(input.cwd, input.trustedProject, settingsPath);
    const currentPolicy = resolveAgentResourcePolicy(input.cwd, input.trustedProject, settingsPath);
    const staticAliases = resolution.effective.modelAliases ?? {};
    const previousAliases = input.snapshot.modelAliases ?? input.snapshot.settings.modelAliases ?? {};
    const inventory = modelInventory(input.rootModel, input.modelRegistry);
    const knownModels = input.modelRegistry ? inventory.knownModels : new Set([...input.snapshot.models, ...inventory.knownModels]);
    const availableModels = input.modelRegistry ? inventory.availableModels : new Set([...input.snapshot.models, ...inventory.availableModels]);
    const currentAliases = input.resolvedAliases ?? (await resolveLaunchAliases(registry, staticAliases, { cwd: input.cwd, projectTrusted: input.trustedProject, rootModel: input.rootModel, knownModels, availableModels, signal: input.signal }, availableModels, knownModels, settingsPath)).aliases;
    const blockedAliases = input.blockedAliases ?? new Set(Object.keys(previousAliases).filter((name) => !Object.prototype.hasOwnProperty.call(currentAliases, name)));
    const blockedAliasTargets = input.blockedAliasTargets ?? Object.fromEntries(Object.entries(previousAliases).filter(([name]) => !Object.prototype.hasOwnProperty.call(currentAliases, name)));
    const script = input.withPreflight ? input.snapshot.script : undefined;
    if (script !== undefined) {
      const resumeAliases = { ...previousAliases, ...currentAliases };
      preflight(script, { models: availableModels, tools: active, agentTypes: new Set(input.snapshot.agentTypes), modelAliases: resumeAliases, knownModels, settingsPath, skipModelAvailability: true }, input.snapshot.schemas, input.snapshot.metadata, true);
    }
    const refreshed = resumedSnapshotSettings(input.snapshot, resolution, currentAliases);
    const snapshot = createLaunchSnapshot({ ...input.snapshot, settingsPath, ...refreshed, modelAliases: currentAliases });
    return { active, settingsPath, resolution, currentPolicy, previousAliases, knownModels, availableModels, currentAliases, blockedAliases, blockedAliasTargets, snapshot, script };
  };
  const workflowAgentHandler = (store: RunStore, metadata: WorkflowMetadata, lifecycle: RunLifecycle, executor: WorkflowAgentExecutor, cwd: string, runId: string, captureRole?: (role: string, model: ModelSpec) => Promise<void>) => async (prompt: string, options: Readonly<Record<string, JsonValue>>, agentSignal: AbortSignal, identity: import("./types.js").AgentIdentity) => {
    await lifecycle.enter();
    try {
      const path = agentIdentityPath(identity);
      const replayed = await store.replay(path);
      if (replayed) {
        return replayed.value;
      }
      const worktree = agentWorktree(identity);
      const agentCwd = worktree.worktreeOwner ? (await persistWorktree(store, metadata, worktree.worktreeOwner)).cwd : cwd;
      const role = typeof options.role === "string" ? options.role : undefined;
      const model = typeof options.model === "string" ? options.model : undefined;
      const requestedLabel = typeof options.label === "string" ? options.label : undefined;
      const skills = Array.isArray(options.skills) ? options.skills as string[] : undefined;
      const extensions = Array.isArray(options.extensions) ? options.extensions as string[] : undefined;
      const contextFiles = Array.isArray(options.contextFiles) && options.contextFiles.every((scope) => scope === "global" || scope === "project" || scope === "cwd") ? options.contextFiles : undefined;
      const resolved = executor.resolve({ label: requestedLabel ?? role ?? "agent", workflowName: metadata.name, ...(model ? { model } : {}), ...(role ? { role } : {}), ...(contextFiles ? { contextFiles } : {}), ...(Array.isArray(options.tools) ? { tools: options.tools as string[] } : {}), ...(skills ? { skills } : {}), ...(extensions ? { extensions } : {}) });
      if (role) await captureRole?.(role, resolved.model);
      const label = displayAgentName(requestedLabel, role, resolved.model);
      const tools = resolved.tools;
      const schema = object(options.outputSchema) ? options.outputSchema : undefined;
      const sessionPath = identity.handle !== undefined && identity.turn !== undefined ? await handleTurnInput(store, identity.handle, identity.turn) : undefined;
      const continuity = identity.handle === undefined ? undefined : sessionPath ? "continued" as const : "fresh" as const;
      const spawned = scheduler.spawn(runId, prompt, { label, ...(requestedLabel ? { requestedLabel } : {}), ...(identity.parentBreadcrumb ? { parentBreadcrumb: identity.parentBreadcrumb } : {}), cwd: agentCwd, tools, ...(skills ? { skills } : {}), ...(extensions ? { extensions } : {}), ...worktree, ...(model ? { model } : {}), ...(role ? { role } : {}), ...(contextFiles ? { contextFiles } : {}), ...(schema ? { schema } : {}), ...(typeof options.retries === "number" ? { retries: options.retries } : {}), ...(positiveInteger(options.timeoutMs) || options.timeoutMs === null ? { timeoutMs: options.timeoutMs } : {}), ...(sessionPath ? { sessionPath } : {}), ...(continuity ? { continuity } : {}), agentOptions: options, agentIdentity: identity });
      const cancel = () => { scheduler.cancel(spawned.id); };
      if (agentSignal.aborted) cancel(); else agentSignal.addEventListener("abort", cancel, { once: true });
      const outcome = await spawned.result.finally(() => { agentSignal.removeEventListener("abort", cancel); });
      if (!outcome.ok) throw new WorkflowError(outcome.error.code as WorkflowErrorCode, outcome.error.message);
      await store.complete(path, outcome.value);
      scheduler.releaseResult(spawned.id);
      return outcome.value;
    } finally { await lifecycle.leave(); }
  };
  const recovery = createWorkflowRecovery({
    pi, home, runs, scheduler, eventPublisher, persistRunState, projectTrusted, resumeHostContext, ensureSessionLease, coordinateRunMutation, createAgentExecutor, activeSnapshotTools, frozenResourcePolicy, resolveLaunchPrologue: resumeLaunchPrologue, workflowAgentHandler, shellForRun, resolveWorktree, checkpointBridge, phaseBridge, logBridge, lifecycleFor, createProviderErrorRecovery, cleanupTerminalRun, deliver: (content) => { deliver(pi, content); }, deliverTerminal: deliveryController.deliverTerminal, workflowToolUpdate, registry, modelSpec,
  });
  const resumeSelectedWorkflow = async (runId: string, foreground: boolean, context: unknown, budgetPatch?: unknown): Promise<{ workflowName: string; state: "running" | "completed" | "awaiting_approval"; attached: boolean; value?: JsonValue }> => {
    const run = runs.get(runId);
    if (!run) throw new WorkflowError("RESUME_INCOMPATIBLE", `Unknown workflow run ${runId} in the current project and Pi session`);
    const host = object(context) ? context : {};
    const hasUI = host.hasUI === true;
    const capabilities = uiHostCapabilities(host.ui);
    const ui = capabilities?.select ? { select: capabilities.select } : {};
    const recoveryContext = { ...resumeHostContext(context) };
    if (run.lifecycle.state === "paused") {
      const wasAttached = deliveryController.isForegroundAttached(runId);
      if (!foreground && wasAttached) await deliveryController.moveForegroundToBackground(runId);
      if (foreground && !wasAttached) {
        run.foreground = true;
        const loaded = await run.store.load();
        await persistRunState(run.store, run.metadata, (current) => ({ ...current, delivery: { ...(current.delivery ?? {}), mode: "foreground", state: "attached" } }));
        await run.store.saveSnapshot(createLaunchSnapshot({ ...loaded.snapshot, launchMode: "foreground" }));
      } else if (!foreground) run.foreground = false;
      else run.foreground = true;
      await recovery.refreshPausedRunAliases(run, { ...recoveryContext, projectTrusted: projectTrusted(context) });
      const claimedForegroundResume = foreground && !wasAttached;
      if (claimedForegroundResume) deliveryController.foregroundResumeClaims.add(run.store);
      const completion = run.completion;
      await run.lifecycle.resume();
      if (!foreground) return { workflowName: run.metadata.name, state: "running", attached: false };
      if (!completion) { if (claimedForegroundResume) deliveryController.foregroundResumeClaims.delete(run.store); return { workflowName: run.metadata.name, state: "running", attached: false }; }
      try {
        const completed = await completion as { value?: JsonValue };
        if (!wasAttached) await run.store.updateState((current) => current.delivery?.mode === "foreground" && current.delivery.state === "attached" ? { ...current, delivery: { ...current.delivery, state: "delivered" } } : current);
        return { workflowName: run.metadata.name, state: "completed", attached: wasAttached, ...(!wasAttached && completed.value !== undefined ? { value: completed.value } : {}) };
      } catch (error) {
        if (!wasAttached) await run.store.updateState((current) => current.delivery?.mode === "foreground" && current.delivery.state === "attached" ? { ...current, delivery: { ...current.delivery, state: "delivered" } } : current);
        if (wasAttached && error && typeof error === "object") Object.defineProperty(error, "workflowResumeAttached", { value: true });
        throw error;
      }
    }
    if (!foreground && deliveryController.isForegroundAttached(runId)) await deliveryController.moveForegroundToBackground(runId);
    if (run.lifecycle.state === "budget_exhausted") {
      const result = await recovery.resumeWorkflowRun(runId, budgetPatch, context, undefined, foreground, foreground);
      return { workflowName: run.metadata.name, state: result.state === "completed" ? "completed" : result.state === "awaiting_approval" ? "awaiting_approval" : "running", attached: false, ...(result.state === "completed" && result.value !== undefined ? { value: result.value } : {}) };
    }
    if (run.lifecycle.state !== "interrupted") throw new WorkflowError("RESUME_INCOMPATIBLE", `Workflow run state changed: ${run.lifecycle.state}`);
    const completed = await recovery.coldResumeRun(run, hasUI, ui, projectTrusted(context), recoveryContext, foreground, foreground);
    return completed ? { workflowName: run.metadata.name, state: "completed", attached: false, value: completed.value } : { workflowName: run.metadata.name, state: "running", attached: false };
  };
  registerControlTool(
    "workflow_retry",
    "Workflow Retry",
    "Retry a failed workflow run by replaying its completed structural operations",
    WORKFLOW_RETRY_PARAMETERS,
    async (params, signal, ctx) => {
      const result = await recovery.retryWorkflowRun(params.runId, ctx, signal, params.foreground, params.expectedState);
      return { text: completionControlContent(result), details: result };
    },
  );
  registerControlTool(
    "workflow_resume",
    "Workflow Resume",
    "Resume an exhausted workflow with unchanged or patched aggregate budgets",
    Type.Object({ runId: Type.String(), expectedState: Type.Optional(Type.String({ description: "Persisted source state observed before recovery" })), budget: Type.Optional(Type.Unknown()), foreground: Type.Optional(Type.Boolean({ description: "Override the source launch mode for this recovery" })) }, { additionalProperties: false }),
    async (params, signal, ctx) => {
      const result = await recovery.resumeWorkflowRun(params.runId, params.budget, ctx, signal, params.foreground, true, params.expectedState);
      return { text: completionControlContent(result), details: result };
    },
  );
  const deliverStaleTerminal = async (store: RunStore, run: PersistedRun): Promise<void> => {
    if (!((run.delivery?.mode === "foreground" && run.delivery.state === "attached") || (run.delivery?.mode === "background" && run.delivery.state === "pending"))) return;
    if (run.state === "completed") {
      const resultPath = join(store.directory, "result.json");
      let resultBytes = 0;
      let hasResult = true;
      try { resultBytes = await store.resultBytes(); } catch (error) { if (!isNodeError(error, "ENOENT")) throw error; hasResult = false; }
      await deliveryController.deliverTerminal(store, completionDescriptor({ runId: run.id, ...(hasResult ? { resultPath } : {}), resultBytes }));
      return;
    }
    const error = run.error ? new WorkflowError(run.error.code, run.error.message) : new WorkflowError(run.state === "stopped" ? "CANCELLED" : "INTERNAL_ERROR", `Workflow ${run.workflowName} ended in ${run.state} without an error`);
    await deliveryController.deliverTerminal(store, formatWorkflowFailureDeliveryFallback(run.workflowName, run.id, store.directory, error, run.state === "failed"), true);
  };
  pi.on("session_start", async (_event, ctx) => {
    if (sessionStarted) return;
    sessionStarted = true;
    try {
    await showChangelogNotice(ctx, extensionAgentDir);
    releaseWorkflowRegistry = retainWorkflowRegistry();
    registry.freeze();
    registerCatalog(ctx.cwd, projectTrusted(ctx));
    await ensureSessionLease(ctx.cwd, ctx.sessionManager.getSessionId());
    let retention: WorkflowSettings["retention"];
    try { retention = resolveWorkflowSettings(ctx.cwd, projectTrusted(ctx), workflowSettingsPath(extensionAgentDir)).effective.retention; } catch { retention = undefined; }
    const runIds = await listRunIds(ctx.cwd, ctx.sessionManager.getSessionId(), home);
    for (const runId of runIds) {
      if (runs.has(runId)) continue;
      const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
      let loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> };
      try { loaded = await store.load(); } catch { if (!await store.isComplete()) await store.delete(true).catch(() => undefined); continue; }
      // Stale terminal delivery is best effort; a corrupt run must not block session recovery.
      if (loaded.run.state === "completed" || loaded.run.state === "failed" || loaded.run.state === "stopped") { terminalRunStates.set(runId, loaded.run.state); await deliverStaleTerminal(store, loaded.run).catch(() => undefined); continue; }
      if (loaded.run.state !== "interrupted" && loaded.run.state !== "budget_exhausted") {
        const previousState = loaded.run.state;
        await store.updateState((current) => {
          if (["completed", "failed", "stopped", "interrupted", "budget_exhausted"].includes(current.state)) return current;
          const next = { ...current, state: "interrupted" as const };
          delete next.activeShells;
          delete next.activeShellStartedAt;
          delete next.activeShellsByPhase;
          return next;
        });
        loaded = { ...loaded, run: (await store.load()).run };
        await eventPublisher.runState(store, loaded.snapshot.metadata, previousState, "interrupted", "session_shutdown");
        loaded = { ...loaded, run: (await store.load()).run };
      } else if (loaded.run.activeShells !== undefined || loaded.run.activeShellStartedAt !== undefined || loaded.run.activeShellsByPhase !== undefined) {
        await store.updateState((current) => {
          if (HARD_TERMINAL_RUN_STATES.has(current.state)) return current;
          const next = { ...current };
          delete next.activeShells;
          delete next.activeShellStartedAt;
          delete next.activeShellsByPhase;
          return next;
        });
        loaded = { ...loaded, run: (await store.load()).run };
      }
      const model = modelSpec(loaded.snapshot.models[0] ?? "", { provider: ctx.model?.provider ?? "", model: ctx.model?.id ?? "", thinking: pi.getThinkingLevel() });
      const budget = validateBudget(loaded.run.budget ?? loaded.snapshot.budget);
      eventPublisher.seedBudget(runId, loaded.run.budgetEvents);
      const budgetRuntime = new WorkflowBudgetRuntime(budget, loaded.run.budgetVersion ?? 1, loaded.run.usage, loaded.run.budgetEvents, { active: loaded.run.state === "running" });
      const lifecycle = lifecycleFor(store, loaded.run.state, loaded.snapshot.metadata);
      const providerPause = async () => { deliver(pi, `Workflow ${loaded.snapshot.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      const roleDefinitions = loaded.snapshot.roles ?? {};
      const abortController = new AbortController();
      const providerErrorRecovery = createProviderErrorRecovery(ctx, new Set(loaded.snapshot.models), () => { abortController.abort(); });
      runs.set(runId, { executor: createAgentExecutor({ cwd: ctx.cwd, model, tools: activeSnapshotTools(loaded.snapshot.tools, "session"), resourceSelectors: snapshotResourcePolicy(loaded.snapshot, store.cwd, projectTrusted(ctx), workflowSettingsPath(extensionAgentDir)).effective, availableModels: new Set(loaded.snapshot.models), knownModels: new Set(loaded.snapshot.models), ...(loaded.snapshot.modelAliases ?? loaded.snapshot.settings.modelAliases ? { modelAliases: loaded.snapshot.modelAliases ?? loaded.snapshot.settings.modelAliases } : {}), ...(loaded.snapshot.settingsSources?.modelAliases ? { settingsPath: loaded.snapshot.settingsSources.modelAliases } : loaded.snapshot.settingsPath ? { settingsPath: loaded.snapshot.settingsPath } : {}), agentDefinitions: roleDefinitions, runStore: store, providerPause, agentResourcePolicy: frozenResourcePolicy(snapshotResourcePolicy(loaded.snapshot, store.cwd, projectTrusted(ctx), workflowSettingsPath(extensionAgentDir))) }), store, metadata: loaded.snapshot.metadata, model, lifecycle, budget: budgetRuntime, abortController, projectTrusted: () => projectTrusted(ctx), checkpointResolvers: new Map(), ...(providerErrorRecovery ? { providerErrorRecovery } : {}) });
      for (const checkpoint of await store.awaitingCheckpoints()) deliver(pi, `Workflow ${loaded.snapshot.metadata.name} checkpoint ${checkpoint.name}: ${checkpoint.prompt}\nContext: ${JSON.stringify(checkpoint.context)}\nRespond with workflow_respond.`);
      for (const decision of await store.pendingWorkflowDecisions()) deliver(pi, recovery.budgetDecisionDelivery(loaded.snapshot.metadata, decision));
      scheduler.restoreRun(runId, loaded.snapshot.settings.concurrency, loaded.snapshot.identityVersion === LAUNCH_SNAPSHOT_IDENTITY_VERSION ? await store.loadOwnership() : [], () => runs.get(runId)?.budget.checkAgentLaunch());
    }
    if (runIds.length > 0) getTrajectoryHost()?.autoAttach(trajectoryProvider, ctx);
    // Retention is optional housekeeping; start it only after recovery stops reading terminal runs.
    if (retention !== undefined) void retainTerminalRuns({ cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), ...(home === undefined ? {} : { home }), allSessions: true, retention }).catch(() => undefined);
    const resumeSelect = uiHostCapabilities(ctx.ui)?.select;
    if (ctx.hasUI && resumeSelect) {
      const interrupted = [...runs.values()].filter((r) => r.lifecycle.state === "interrupted");
      if (interrupted.length > 0) {
        const labels = interrupted.map((r) => `Resume: ${r.metadata.name} (${r.store.runId.slice(0, 8)})`);
        const options = [...labels, ...(interrupted.length > 1 ? ["Resume all"] : []), "Skip"];
        const choice = await resumeSelect(`${String(interrupted.length)} interrupted workflow${interrupted.length > 1 ? "s" : ""} found`, options);
        if (choice && choice !== "Skip") {
          const toResume = choice === "Resume all" ? interrupted : interrupted.filter((_, i) => labels[i] === choice);
          await Promise.all(toResume.map(async (run) => {
            try { await recovery.coldResumeRun(run, true, ctx.ui, projectTrusted(ctx), resumeHostContext(ctx), undefined, false); ctx.ui.notify(`Resumed workflow ${run.metadata.name}.`, "info"); }
            catch (err) { ctx.ui.notify(`Cannot resume ${run.metadata.name}: ${err instanceof Error ? err.message : String(err)}`, "warning"); }
          }));
        }
      }
    }
    } catch (error) {
      clearSubagentStatusObserver();
      try { await releaseSessionLease(); } finally {
        if (releaseWorkflowRegistry) {
          releaseWorkflowRegistry();
          releaseWorkflowRegistry = undefined;
        }
      }
      throw error;
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!pi.getActiveTools().includes("workflow")) return;
    const roles = Object.entries(loadAgentDefinitions(ctx.cwd, extensionAgentDir, projectTrusted(ctx), typeof registry.roleDirectoryRegistrations === "function" ? registry.roleDirectoryRegistrations() : undefined)).filter(([, definition]) => definition.description);
    if (!roles.length) return;
    const content = `Workflow role descriptions:\n${roles.map(([name, definition]) => `- \`${name}\`: ${String(definition.description)}`).join("\n")}`;
    return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
  });
  const workflowTool: ToolDefinition<typeof WORKFLOW_TOOL_PARAMETERS, WorkflowToolResult, WorkflowProgressRenderState> = {
    name: "workflow",
    label: WORKFLOW_TOOL_LABEL,
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_TOOL_PROMPT_SNIPPET,
    parameters: WORKFLOW_TOOL_PARAMETERS,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      let resolveDetached: ((result: ForegroundDetachResult) => void) | undefined;
      let foregroundStore: RunStore | undefined;
      let completionInstalled = false;
      const detachedResult = params.foreground ? new Promise<ForegroundDetachResult>((resolve) => { resolveDetached = resolve; }) : undefined;
      const detachedToolResult = (run: PersistedRun) => {
        const detached = { runId: run.id, state: "running" as const, detached: true as const };
        return { content: [{ type: "text" as const, text: JSON.stringify(detached) }], details: { ...detached, run, preview: `Moved workflow ${run.id} to background.` } };
      };
      try {
      const headless = object(ctx) && ctx.headless === true;
      const settingsPath = workflowSettingsPath(extensionAgentDir);
      if (!ctx.model) throw new WorkflowError("UNKNOWN_MODEL", "A launching model is required");
      const budget = validateBudget(params.budget);
      const rootModel: ModelSpec = { provider: ctx.model.provider, model: ctx.model.id, thinking: pi.getThinkingLevel() };
      const rootModelName = `${rootModel.provider}/${rootModel.model}`;
      const modelRegistry = contextHostCapabilities(ctx).modelRegistry;
      const inventory = modelInventory(rootModel, modelRegistry);
      const knownModels = inventory.knownModels;
      const availableModels = inventory.availableModels;
      const rootTools = pi.getActiveTools().filter((name) => !INTERNAL_WORKFLOW_TOOLS.includes(name));
      const trustedProject = projectTrusted(ctx);
      const launchCwd = typeof ctx.cwd === "string" ? ctx.cwd : process.cwd();
      const launch = workflowLaunchSettings(launchCwd, trustedProject, settingsPath, params.concurrency);
      const runController = new AbortController();
      let foregroundAttached = Boolean(params.foreground);
      const onForegroundAbort = () => { runController.abort(); };
      if (signal?.aborted) runController.abort(); else signal?.addEventListener("abort", onForegroundAbort, { once: true });
      const resolvedAliases = await resolveLaunchAliases(registry, launch.settings.modelAliases ?? {}, { cwd: launchCwd, projectTrusted: trustedProject, rootModel, knownModels, availableModels, signal: runController.signal }, availableModels, knownModels, settingsPath);
      const modelAliases = resolvedAliases.aliases;
      const settings = Object.freeze({ ...launch.settings, ...(Object.keys(modelAliases).length ? { modelAliases } : {}) });
      const validated = validateWorkflowLaunchWithRegistry(params, { cwd: ctx.cwd, agentDir: extensionAgentDir, projectTrusted: trustedProject, availableModels, rootTools: new Set(rootTools), modelAliases, knownModels, settingsPath }, registry);
      const { script, checked, agentDefinitions, projectAgentDefinitions, roleNames } = validated;
      await ensureSessionLease(ctx.cwd, ctx.sessionManager.getSessionId());
      const runId = randomUUID();
      const args = params.args ?? null;
      encoded(args);
      const runContext = workflowRunContext(ctx.cwd, ctx.sessionManager.getSessionId(), runId, checked.metadata, args, runController.signal);
      const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
      const parentRunId = params.parentRunId;
      if (parentRunId !== undefined) await store.validateParentRun(parentRunId);
      const roles = Object.fromEntries(roleNames.map((role) => [role, agentDefinitions[role]])) as Record<string, AgentDefinition>;
      const projectRoles = roleNames.filter((role) => projectAgentDefinitions[role] !== undefined);
      const roleModels = roleNames.flatMap((role) => { const model = agentDefinitions[role]?.model; return model ? [modelCapability(model, modelAliases, knownModels, settingsPath)] : []; });
      const snapshotModels = [...new Set([rootModelName, ...checked.referenced.models, ...roleModels])];
      const snapshot = createLaunchSnapshot({ script, args, metadata: checked.metadata, launchMode: params.foreground ? "foreground" : "background", settings, settingsPath, settingsSources: { ...launch.resolution.sources, concurrency: params.concurrency === undefined ? launch.resolution.sources.concurrency : "per-run options" }, ...(Object.keys(modelAliases).length ? { modelAliases } : {}), ...(budget ? { budget } : {}), ...(checked.referenced.phases.length ? { phases: checked.referenced.phases } : {}), models: snapshotModels, tools: rootTools, agentTypes: checked.referenced.agentTypes, roles, projectRoles, schemas: checked.schemas });
      let persistedSnapshot = snapshot;
      const captureRole = async (role: string, model: ModelSpec): Promise<void> => {
        const definition = agentDefinitions[role];
        if (!definition) return;
        const modelName = `${model.provider}/${model.model}`;
        const hasProjectRole = projectAgentDefinitions[role] !== undefined;
        if (persistedSnapshot.roles?.[role] !== undefined && (!hasProjectRole || persistedSnapshot.projectRoles?.includes(role)) && persistedSnapshot.models.includes(modelName)) return;
        const roles = { ...(persistedSnapshot.roles ?? {}), [role]: definition };
        const projectRoles = hasProjectRole ? [...new Set([...(persistedSnapshot.projectRoles ?? []), role])] : persistedSnapshot.projectRoles ?? [];
        const models = [...new Set([...persistedSnapshot.models, modelName])];
        persistedSnapshot = createLaunchSnapshot({ ...persistedSnapshot, models, roles, projectRoles });
        await store.saveSnapshot(persistedSnapshot);
      };
      const budgetRuntime = new WorkflowBudgetRuntime(budget);
      const initialBudget = budgetRuntime.snapshot();
      await store.create({ id: runId, workflowName: checked.metadata.name, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), state: "running", ...(parentRunId !== undefined ? { parentRunId } : {}), agents: [], agentSessions: [], delivery: params.foreground ? { mode: "foreground", state: "attached", toolCallId } : { mode: "background", state: "pending" }, ...(budget ? { budget } : {}), budgetVersion: 1, ...initialBudget }, snapshot);
      foregroundStore = params.foreground ? store : undefined;
      getTrajectoryHost()?.autoAttach(trajectoryProvider, ctx);
      if (params.foreground) {
        const delivery: ForegroundDelivery = {
          store, detached: false,
          detach: async () => {
            let moved: boolean | undefined;
            await store.updateState((current) => {
              if (HARD_TERMINAL_RUN_STATES.has(current.state) || current.delivery?.mode !== "foreground" || current.delivery.state !== "attached") return current;
              moved = true;
              return { ...current, delivery: { mode: "background", state: "pending" } };
            });
            if (moved !== true) throw new WorkflowError("RESUME_INCOMPATIBLE", `Workflow ${runId} is no longer an attached foreground run`);
            foregroundAttached = false;
            delivery.detached = true;
            const activeRun = runs.get(runId);
            if (activeRun) { activeRun.foreground = false; delete activeRun.update; }
            await store.saveSnapshot(createLaunchSnapshot({ ...persistedSnapshot, launchMode: "background" }));
            for (const checkpoint of await store.awaitingCheckpoints()) deliverBackgroundCheckpoint(checked.metadata.name, runId, checkpoint);
            signal?.removeEventListener("abort", onForegroundAbort);
            const run = (await store.load()).run;
            const result = { runId, state: "running" as const, detached: true as const, run };
            resolveDetached?.(result);
            return result;
          },
        };
        deliveryController.foregroundDeliveries.set(toolCallId, delivery);
      }
      const lifecycle = lifecycleFor(store, "running", checked.metadata);
      const backgroundLaunch = !params.foreground;
      const providerPause = async () => { if (!foregroundAttached) deliver(pi, `Workflow ${checked.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      const providerErrorRecovery = createProviderErrorRecovery(ctx, availableModels, () => { runController.abort(); });
      const executor = createAgentExecutor({ cwd: ctx.cwd, model: rootModel, tools: new Set(rootTools), resourceSelectors: launch.resourcePolicy.effective, availableModels, knownModels, modelAliases, settingsPath, agentDefinitions, runStore: store, providerPause, agentResourcePolicy: frozenResourcePolicy(launch.resourcePolicy), runContext });
      const runRecord: WorkflowRunRecord = { executor, store, metadata: checked.metadata, model: rootModel, lifecycle, budget: budgetRuntime, abortController: runController, foreground: foregroundAttached, projectTrusted: () => projectTrusted(ctx), checkpointResolvers: new Map(), ...(providerErrorRecovery ? { providerErrorRecovery } : {}), ...(params.foreground && onUpdate ? { update: onUpdate } : {}) };
      runs.set(runId, runRecord);
      if (params.foreground && onUpdate) onUpdate(workflowToolUpdate((await store.load()).run));
      scheduler.addRun(runId, settings.concurrency, () => runs.get(runId)?.budget.checkAgentLaunch());
      const execution = runWorkflow(script, args, withWorkflowFunctions({ shell: (command, options, signal, identity) => shellForRun(store, checked.metadata, lifecycle, command, options, signal, identity), agent: workflowAgentHandler(store, checked.metadata, lifecycle, executor, ctx.cwd, runId, captureRole), worktree: async (owner) => resolveWorktree(store, checked.metadata, owner), checkpoint: checkpointBridge(runId, store, checked.metadata, () => runs.get(runId)?.foreground ?? foregroundAttached, ctx.hasUI ? ctx.ui : undefined, headless), phase: phaseBridge(store, checked.metadata, lifecycle), log: logBridge(store, lifecycle, checked.metadata.name) }, store, runContext, registry), runController.signal);
      runRecord.execution = execution;
      await eventPublisher.runStarted(store, checked.metadata);
      const finish = execution.result.then(async (value) => {
        await scheduler.flush(runId);
        if (budgetRuntime.hardExhausted) throw new WorkflowError("BUDGET_EXHAUSTED", "Budgeted work was attempted after hard exhaustion");
        const resultPath = await store.saveResult(value);
        const resultBytes = await store.resultBytes();
        await lifecycle.terminal("completed", "completed");
        await eventPublisher.runCompleted(store, checked.metadata, resultPath);
        return { value, resultPath, resultBytes };
      }).catch(async (error: unknown) => {
        await scheduler.flush(runId);
        const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", String(error));
        if (!["stopped", "interrupted", "budget_exhausted"].includes(lifecycle.state)) await lifecycle.terminal(typed.code === "CANCELLED" ? "stopped" : typed.code === "BUDGET_EXHAUSTED" ? "budget_exhausted" : "failed", typed.code);
        const persisted = await persistRunState(store, checked.metadata, (current) => persistedFailure({ ...current, ...budgetRuntime.snapshot() }, typed));
        const state = lifecycle.state === "stopped" || lifecycle.state === "interrupted" || lifecycle.state === "budget_exhausted" ? lifecycle.state : "failed";
        await eventPublisher.runFailed(store, checked.metadata, typed, state);
        const diagnostic = await createWorkflowFailureDiagnostics(store, checked.metadata, typed, persisted);
        markWorkflowFailureDiagnostics(typed, diagnostic);
        if (params.foreground) deliveryController.pendingFailureDiagnostics.set(toolCallId, { diagnostic, store });
        throw typed;
      });
      const completion = finish.finally(() => cleanupTerminalRun(runId));
      runRecord.completion = completion;
      completionInstalled = true;
      const deliverFailureContent = (error: unknown): string => {
        const diagnostic = failureDiagnosticsFrom(error);
        return diagnostic ? formatWorkflowFailureDelivery(diagnostic) : formatWorkflowFailureDeliveryFallback(checked.metadata.name, runId, store.directory, error);
      };
      type Completion = { value: JsonValue; resultPath: string; resultBytes: number };
      const completionContent = (mode: "foreground" | "background", result: Completion): (() => Promise<string>) => async () => (await completionDeliveryFromStore({ mode, name: checked.metadata.name, runId, value: result.value, resultPath: result.resultPath, resultBytes: result.resultBytes, store, context: completionContext(ctx) })).content;
      if (backgroundLaunch) {
        void completion.then(async (result) => {
          await deliveryController.deliverTerminal(store, completionContent("background", result));
        }, async (error: unknown) => {
          await deliveryController.deliverTerminal(store, deliverFailureContent(error), true);
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ runId, state: "running" }) }], details: { runId, preview: `Started workflow ${runId}.` } };
      }
      void completion.then(async (result) => {
        await deliveryController.deliverDetachedTerminal(toolCallId, completionContent("background", result));
      }, async (error: unknown) => {
        await deliveryController.deliverDetachedTerminal(toolCallId, deliverFailureContent(error), true);
      });
      const outcome = detachedResult === undefined
        ? { kind: "completed" as const, result: await completion }
        : await Promise.race([
          completion.then((result) => ({ kind: "completed" as const, result })),
          detachedResult.then((result) => ({ kind: "detached" as const, result })),
        ]);
      if (outcome.kind === "detached") return detachedToolResult(outcome.result.run);
      const { value, resultPath, resultBytes } = outcome.result;
      const foregroundDelivery = await completionDeliveryFromStore({ mode: "foreground", name: checked.metadata.name, runId, value, resultPath, resultBytes, store, context: completionContext(ctx) });
      const claim = await deliveryController.claimForegroundDelivery(store, toolCallId);
      if (claim === "detached") {
        // deliverTerminal sends only if the detached follow-up handler has not already sent.
        await deliveryController.deliverTerminal(store, completionContent("background", outcome.result));
        deliveryController.foregroundDeliveries.delete(toolCallId);
        return detachedToolResult((await store.load()).run);
      }
      deliveryController.foregroundDeliveries.delete(toolCallId);
      const run = (await store.load()).run;
      return { content: [{ type: "text" as const, text: foregroundDelivery.content }, ...(foregroundDelivery.inlined ? [{ type: "text" as const, text: `Workflow run ID: ${runId}` }] : [])], details: { runId, value, run } };
      } catch (error) {
        if (params.foreground && foregroundStore && completionInstalled) {
          const claim = await deliveryController.claimForegroundDelivery(foregroundStore, toolCallId);
          if (claim === "detached") {
            // deliverTerminal sends only if the detached follow-up handler has not already sent.
            const failed = await foregroundStore.load();
            const diagnostic = failureDiagnosticsFrom(error);
            await deliveryController.deliverTerminal(foregroundStore, diagnostic ? formatWorkflowFailureDelivery(diagnostic) : formatWorkflowFailureDeliveryFallback(failed.run.workflowName, failed.run.id, foregroundStore.directory, error), true);
            deliveryController.foregroundDeliveries.delete(toolCallId);
            return detachedToolResult((await foregroundStore.load()).run);
          }
          deliveryController.foregroundDeliveries.delete(toolCallId);
        }
        throw mainAgentError(error);
      }
    },
    renderCall(args) {
      return textBlock(formatWorkflowPreview(args));
    },
    renderResult(result, { isPartial, expanded }, theme, context) {
      const details = result.details;
      const runDetails = isWorkflowToolResult(details) ? details : undefined;
      const state = context.state;
      if (runDetails?.run && isPartial && runDetails.run.state === "running" && !state.workflowSpinner) {
        state.workflowSpinner = setInterval(context.invalidate, 80);
        state.workflowSpinner.unref();
      } else if ((!isPartial || runDetails?.run?.state !== "running") && state.workflowSpinner) {
        clearInterval(state.workflowSpinner);
        delete state.workflowSpinner;
      }
      if (isPartial && runDetails?.run?.state === "running") delete state.workflowProgressFrozenAt;
      if (isWorkflowFailureDiagnostics(details)) {
        delete state.workflowProgress;
        delete state.workflowProgressComponent;
        const failureRun = object(details) && isPersistedRun(details.run) ? details.run : undefined;
        if (!failureRun) return textBlock(formatWorkflowFailureDiagnostics(details));
        state.workflowProgressFrozenAt ??= Date.now();
        const failure = workflowProgressBlock(failureRun, theme, undefined, undefined, undefined, formatWorkflowFailureDiagnostics(details), state.workflowProgressFrozenAt);
        failure.setExpanded(expanded);
        return failure;
      }
      if (runDetails?.run) {
        const incoming = runDetails.run;
        if (HARD_TERMINAL_RUN_STATES.has(incoming.state)) state.workflowProgressFrozenAt ??= Date.now();
        else if (incoming.state === "running") delete state.workflowProgressFrozenAt;
        let progress = state.workflowProgress;
        if (!isPartial || !progress || progress.runId !== incoming.id) {
          progress = undefined;
          delete state.workflowProgress;
          delete state.workflowProgressComponent;
          if (isPartial) {
            progress = { runId: incoming.id, inputRun: incoming, run: incoming, lastRefreshAt: 0, runtimeStartedAt: Date.now(), runtimeBaseMs: incoming.usage?.durationMs ?? 0 };
            state.workflowProgress = progress;
          }
        } else if (progress.inputRun !== incoming) {
          if (progress.run.state !== "running" && incoming.state === "running") {
            progress.runtimeBaseMs = incoming.usage?.durationMs ?? 0;
            progress.runtimeStartedAt = Date.now();
          }
          progress.inputRun = incoming;
          progress.run = incoming;
        }
        if (!state.workflowProgressComponent) {
          const requestRender = context.invalidate;
          const currentProgress = progress;
          state.workflowProgressComponent = workflowProgressBlock(currentProgress?.run ?? incoming, theme, currentProgress, async () => {
            const active = runs.get(incoming.id);
            const store = active?.store ?? new RunStore(incoming.cwd, incoming.sessionId, incoming.id, home);
            const loaded = await store.load();
            return withLiveActivities(loaded.run);
          }, () => { if (state.workflowProgress === currentProgress) requestRender(); }, undefined, state.workflowProgressFrozenAt);
        }
        state.workflowProgressComponent.setExpanded(expanded);
        return state.workflowProgressComponent;
      }
      const content = result.content[0];
      return textBlock(isPartial ? "Workflow starting..." : runDetails?.preview ?? (content?.type === "text" ? content.text : "Workflow finished"));
    },
  };
  pi.registerTool(workflowTool);
  registerWorkflowNavigator({ pi, home, clipboard, extensionAgentDir, runs, terminalRunStates, hardTerminalRunStates: HARD_TERMINAL_RUN_STATES, ensureSessionLease, coordinateRunMutation, answerCheckpoint, recovery, stopWorkflowRun, moveForegroundToBackground: deliveryController.moveForegroundToBackground, isForegroundAttached: deliveryController.isForegroundAttached, liveAgents, registry, projectTrusted, resumeHostContext, resumeSelectedWorkflow, reportBlocked: reportWorkflowBlocked, trajectoryProvider, setNavigatorOpen: (open) => { if (open) backgroundWidgetController.suspend(); else backgroundWidgetController.resume(); } });
  pi.on("session_shutdown", async () => {
    try {
      await Promise.all([...runs.entries()].map(async ([runId, run]) => {
        const isTerminal = SHUTDOWN_TERMINAL_RUN_STATES.has(run.lifecycle.state);
        if (!isTerminal) {
          try { await run.lifecycle.terminal("interrupted"); } catch (error) { if (!SHUTDOWN_TERMINAL_RUN_STATES.has(run.lifecycle.state)) throw error; }
          run.abortController.abort();
          run.execution?.cancel();
          await scheduler.cancelRun(runId);
        }
        await run.completion?.catch(() => undefined);
      }));
      await scheduler.flush();
    } finally {
      clearSubagentStatusObserver();
      try { await releaseSessionLease(); } finally {
        if (releaseWorkflowRegistry) {
          releaseWorkflowRegistry();
          releaseWorkflowRegistry = undefined;
        } else {
          resetWorkflowRegistryIfIdle();
        }
      }
    }
  });
}

/**
 * In-memory per-agent state that must not be persisted: the live session handle, the prepared
 * session, the handoff, and the freshest activity sample. One map keyed by run then agent replaces
 * five parallel maps that previously had to stay consistent by hand; deleteRun() is the single
 * cleanup point when a run reaches a hard-terminal state.
 */
type LiveAgentState = { session?: import("./types.js").WorkflowAgentSession; prepared?: Readonly<import("./types.js").PreparedAgentSession>; handoff?: import("./types.js").LiveSessionHandoff; activity?: AgentActivity; lastEventAt?: number };
class LiveAgentRegistry {
  readonly #byRun = new Map<string, Map<string, LiveAgentState>>();
  get(runId: string, agentId: string): Readonly<LiveAgentState> | undefined { return this.#byRun.get(runId)?.get(agentId); }
  setSession(runId: string, agentId: string, session?: import("./types.js").WorkflowAgentSession): void {
    if (session) this.#state(runId, agentId).session = session;
    else this.#clear(runId, agentId, (state) => { delete state.session; });
  }
  setHandoff(runId: string, agentId: string, attempt: AgentAttempt): void {
    if (attempt.liveSession && attempt.prepared && attempt.handoff) { const state = this.#state(runId, agentId); state.prepared = attempt.prepared; state.handoff = attempt.handoff; }
    else this.#clear(runId, agentId, (state) => { delete state.prepared; delete state.handoff; });
  }
  setActivity(runId: string, agentId: string, activity?: AgentActivity): void {
    if (activity) this.#state(runId, agentId).activity = { ...activity, text: sanitizeDisplayText(activity.text) };
    else this.#clear(runId, agentId, (state) => { delete state.activity; });
  }
  setEventTime(runId: string, agentId: string, timestamp?: number): void {
    if (timestamp !== undefined) this.#state(runId, agentId).lastEventAt = timestamp;
  }
  deleteRun(runId: string): void { this.#byRun.delete(runId); }
  /** Overlays live activity and freshness onto a persisted run; returns the input when nothing is live. */
  overlay(run: PersistedRun): PersistedRun {
    const agents = this.#byRun.get(run.id);
    if (!agents?.size) return run;
    const next = run.agents.map((agent) => {
      const live = agents.get(agent.id);
      if (!live || (live.activity === undefined && live.lastEventAt === undefined)) return agent;
      return { ...agent, ...(live.activity === undefined ? {} : { activity: live.activity }), ...(live.lastEventAt === undefined ? {} : { lastEventAt: live.lastEventAt }) };
    });
    return next.some((agent, index) => agent !== run.agents[index]) ? { ...run, agents: next } : run;
  }
  #state(runId: string, agentId: string): LiveAgentState {
    const agents = this.#byRun.get(runId) ?? new Map<string, LiveAgentState>();
    this.#byRun.set(runId, agents);
    const state = agents.get(agentId) ?? {};
    agents.set(agentId, state);
    return state;
  }
  #clear(runId: string, agentId: string, remove: (state: LiveAgentState) => void): void {
    const agents = this.#byRun.get(runId);
    const state = agents?.get(agentId);
    if (!agents || !state) return;
    remove(state);
    if (Object.keys(state).length === 0) agents.delete(agentId);
    if (agents.size === 0) this.#byRun.delete(runId);
  }
}

/**
 * Copies the transcript a handle turn continues from into the run directory.
 *
 * The agent appends to the copy, so the previous turn's file stays a frozen
 * snapshot: a crash mid-send can never corrupt the input a recovery re-run
 * reads, and recovery needs no special casing.
 *
 * Only journaled turns qualify as a source, so a turn that never completed is walked
 * past; when no previous turn ever completed the send starts fresh, and a turn that
 * completed without a usable session file fails the send instead of silently
 * continuing from an older transcript.
 */
async function handleTurnInput(store: RunStore, handle: string, turn: number): Promise<string | undefined> {
  if (turn <= 1) return undefined;
  const files = await store.agentSessionFiles();
  let source: string | undefined;
  let completed = false;
  for (let previous = turn - 1; previous >= 1; previous -= 1) {
    const path = agentHandleTurnPath(handle, previous);
    if (!files.has(path)) continue;
    completed = true;
    source = files.get(path);
    break;
  }
  if (!completed) return undefined;
  if (source === undefined) fail("AGENT_FAILED", `Agent handle ${handle} cannot continue from its previous turn: the completed turn recorded no session file`);
  const target = join(store.directory, "handles", encodeURIComponent(handle), `turn-${String(turn)}-input.jsonl`);
  try {
    await mkdir(dirname(target), { recursive: true });
    await copyFile(source, target);
  } catch (error) { fail("AGENT_FAILED", `Agent handle ${handle} cannot continue from its previous turn: ${errorText(error)}`); }
  return target;
}

function displayAgentName(label: string | undefined, role: string | undefined, model: ModelSpec): string {
  return label ?? role ?? model.model;
}

function modelSpec(value: string, fallback: ModelSpec): ModelSpec {
  try {
    const parsed = parseModelReference(value);
    return { ...parsed, ...(parsed.thinking || !fallback.thinking ? {} : { thinking: fallback.thinking }) };
  } catch {
    return fallback;
  }
}



