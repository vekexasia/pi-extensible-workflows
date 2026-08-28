import type { CreateAgentSessionOptions, InlineExtension, SessionManager, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Static, TSchema } from "typebox";
export const RUN_STATES = ["queued", "running", "pausing", "paused", "awaiting_input", "completed", "failed", "stopped", "interrupted", "budget_exhausted"] as const;
export const AGENT_STATES = ["queued", "running", "waiting_for_child", "paused", "retrying", "completed", "failed", "cancelled"] as const;
export type RunState = (typeof RUN_STATES)[number];
export type AgentState = (typeof AGENT_STATES)[number];
// Shared terminal-state vocabularies: a hard-terminal run and a settled agent are decided here once,
// so display, persistence, and lifecycle code cannot drift apart on what "finished" means.
export const HARD_TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set(["completed", "failed", "stopped"]);
export const SETTLED_AGENT_STATES: ReadonlySet<AgentState> = new Set(["completed", "failed", "cancelled"]);
export const WORKFLOW_CALL_KINDS = ["agent", "parallel", "pipeline", "checkpoint", "phase", "withWorktree", "shell"] as const;
export type WorkflowCallKind = (typeof WORKFLOW_CALL_KINDS)[number];
export const WORKFLOW_RUN_STARTED_EVENT = "workflow:run-started";
export const WORKFLOW_RUN_RESUMED_EVENT = "workflow:run-resumed";
export const WORKFLOW_RUN_STATE_CHANGED_EVENT = "workflow:run-state-changed";
export const WORKFLOW_RUN_COMPLETED_EVENT = "workflow:run-completed";
export const WORKFLOW_RUN_FAILED_EVENT = "workflow:run-failed";
export const WORKFLOW_AGENT_STATE_CHANGED_EVENT = "workflow:agent-state-changed";
export const WORKFLOW_PHASE_CHANGED_EVENT = "workflow:phase-changed";
export const WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT = "workflow:checkpoint-state-changed";
export const WORKFLOW_BUDGET_EVENT = "workflow:budget-event";
export const WORKFLOW_WORKTREE_CREATED_EVENT = "workflow:worktree-created";
export const WORKFLOW_BLOCKED_EVENT = "workflow:blocked";
export const ERROR_CODES = [
  "CONFIG_ERROR", "INVALID_SETTINGS", "INVALID_SYNTAX", "INVALID_METADATA", "DUPLICATE_NAME", "INVALID_SCHEMA", "UNKNOWN_MODEL", "UNKNOWN_TOOL", "UNKNOWN_AGENT_TYPE",
  "RUN_OWNED", "RUN_NOT_FOUND", "REGISTRY_FROZEN", "GLOBAL_COLLISION", "MISSING_WORKFLOW", "RPC_LIMIT_EXCEEDED", "SHELL_FAILED", "AGENT_TIMEOUT", "AGENT_FAILED", "AGENT_RESULT_COLLECTED", "RESULT_INVALID",
  "CANCELLED", "WORKER_UNRESPONSIVE", "WORKTREE_FAILED", "RESUME_INCOMPATIBLE", "BUDGET_EXHAUSTED", "INTERNAL_ERROR",
  ] as const;

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];
export type WorkflowErrorCode = (typeof ERROR_CODES)[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = { [key: string]: JsonValue };
type WorkflowSchema = JsonSchema | TSchema;
export function roleNameOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}
// Extra keys are reserved for extensions and forwarded as JSON to agentOptions; core options remain typed.
export interface AgentOptions<Schema extends TSchema = never> {
  label?: string;
  model?: string;
  tools?: string[];
  skills?: string[];
  extensions?: string[];
  contextFiles?: ContextFileScope[];
  role?: string;
  outputSchema?: JsonSchema | Schema;
  retries?: number;
  timeoutMs?: number | null;
  [key: string]: JsonValue | NoInfer<Schema>;
}
export type ParallelTasks = Record<string, () => JsonValue | Promise<JsonValue>>;
export type ParallelResult<Tasks extends ParallelTasks> = { [Key in keyof Tasks]: Awaited<ReturnType<Tasks[Key]>> };
export type PipelineItems = Record<string, JsonValue>;
export type PipelineStage<Input extends JsonValue, Output extends JsonValue> = (value: Input) => Output | Promise<Output>;
export type PipelineStages<Input extends JsonValue, Output extends JsonValue> = Record<string, PipelineStage<Input, Output>>;
export type PipelineResult<Items extends PipelineItems, Output extends JsonValue> = { [Key in keyof Items]: Output };
export interface ShellOptions { timeoutMs?: number; env?: Record<string, string> }
export interface ShellResult { exitCode: number | null; stdout: string; stderr: string }
export type BudgetDimension = "tokens" | "costUsd" | "durationMs" | "agentLaunches";
export interface BudgetLimits { soft?: number; hard?: number }
export type WorkflowBudget = Partial<Record<BudgetDimension, BudgetLimits>>;
export type WorkflowBudgetPatch = Partial<Record<BudgetDimension, BudgetLimits | { soft?: number | null; hard?: number | null } | null>>;
export interface WorkflowBudgetUsage { tokens: number; costUsd: number; durationMs: number; agentLaunches: number }
export type BudgetEventType = "soft_crossed" | "hard_overrun" | "hard_exhausted" | "adjustment_requested" | "adjustment_approved" | "adjustment_rejected";
export interface BudgetEvent { type: BudgetEventType; budgetVersion: number; dimensions: readonly BudgetDimension[]; usage: WorkflowBudgetUsage; limits: WorkflowBudget; at: number; proposalId?: string; previous?: WorkflowBudget; proposed?: WorkflowBudget }
export interface BudgetApprovalRequest { kind: "budget"; proposalId: string; runId: string; consumed: WorkflowBudgetUsage; previous: WorkflowBudget; proposed: WorkflowBudget; budgetVersion: number; foreground?: boolean }
export interface WorkflowErrorShape { code: WorkflowErrorCode; message: string; failedAt?: string }
export interface WorkflowEventBase { runId: string; sessionId: string; workflowName: string; cwd: string; runDirectory: string; timestamp: number }
export type WorkflowRunStartedEvent = WorkflowEventBase;
export type WorkflowRunResumedEvent = WorkflowEventBase;
export interface WorkflowRunStateChangedEvent extends WorkflowEventBase { previousState: RunState; state: RunState; reason?: string; errorCode?: WorkflowErrorCode }
export interface WorkflowRunCompletedEvent extends WorkflowEventBase { resultPath: string }
export interface WorkflowRunFailedEvent extends WorkflowEventBase { error: WorkflowErrorShape }
export interface WorkflowAgentStateChangedEvent extends WorkflowEventBase { agentId: string; displayLabel: string; role?: string; structuralPath: readonly string[]; parentId?: string; parentBreadcrumb?: string; worktreeOwner?: string; previousState?: AgentState; state: AgentState; attempt: number }
export interface WorkflowPhaseChangedEvent extends WorkflowEventBase { previousPhase?: string; phase: string }
export type WorkflowCheckpointState = "awaiting" | "approved" | "rejected";
export interface WorkflowCheckpointStateChangedEvent extends WorkflowEventBase { name: string; state: WorkflowCheckpointState }
export interface WorkflowBudgetEvent extends WorkflowEventBase { type: BudgetEventType; budgetVersion: number; dimensions: readonly BudgetDimension[]; usage: WorkflowBudgetUsage; limits: WorkflowBudget; proposalId?: string; previous?: WorkflowBudget; proposed?: WorkflowBudget }
export interface ModelSpec { provider: string; model: string; thinking?: ThinkingLevel }
export interface WorkflowModelAliasResolverContext { cwd: string; projectTrusted: boolean; rootModel: ModelSpec; knownModels: ReadonlySet<string>; availableModels: ReadonlySet<string>; signal: AbortSignal }
export interface WorkflowModelAlias { resolve: (context: Readonly<WorkflowModelAliasResolverContext>) => string | Promise<string> }
export interface WorkflowMetadata { name: string; description?: string }
export interface HerdrExtensionSettings { enableFullyInspectableMode?: boolean }
export interface TrajectoryExtensionSettings { port?: number; themes?: boolean }
export interface WorkflowExtensionSettings { herdr?: Readonly<HerdrExtensionSettings>; trajectory?: Readonly<TrajectoryExtensionSettings> }
export interface WorkflowRetentionSettings { olderThanDays?: number; maxTerminalRuns?: number }
export interface WorkflowSettings { concurrency: number; backgroundWidget?: boolean; modelAliases?: Readonly<Record<string, string>>; skills?: readonly string[]; extensions?: readonly string[]; extensionSettings?: Readonly<WorkflowExtensionSettings>; tools?: readonly string[]; retention?: Readonly<WorkflowRetentionSettings> }
export interface WorkflowSettingsOverrides { concurrency?: number; modelAliases?: Readonly<Record<string, string>>; skills?: readonly string[]; extensions?: readonly string[]; extensionSettings?: Readonly<WorkflowExtensionSettings>; tools?: readonly string[]; retention?: Readonly<WorkflowRetentionSettings> }
export interface WorkflowSettingsSources { concurrency: string; modelAliases: string; skills?: string; extensions?: string; tools?: string; extensionSettings?: string; retention?: string }
export interface WorkflowSettingsResolution { globalSettingsPath: string; projectSettingsPath: string; projectTrusted: boolean; global: Readonly<WorkflowSettings>; project: Readonly<WorkflowSettingsOverrides>; effective: Readonly<WorkflowSettings>; sources: Readonly<WorkflowSettingsSources> }
export interface AgentResourceSelectors { skills?: readonly string[]; extensions?: readonly string[]; tools?: readonly string[] }
export interface AgentResourceSelectorSet { skills: readonly string[]; extensions: readonly string[]; tools?: readonly string[] }
export interface AgentResourceSelectorSources { global: AgentResourceSelectors; project: AgentResourceSelectors; role?: AgentResourceSelectors; call?: AgentResourceSelectors }
export type ContextFileScope = "global" | "project" | "cwd";
export interface AgentResourcePolicy {
  globalSettingsPath: string;
  projectSettingsPath: string;
  projectTrusted: boolean;
  global: AgentResourceSelectorSet;
  project: AgentResourceSelectorSet;
  effective: AgentResourceSelectorSet;
  selectedSkills?: readonly string[];
  selectedExtensions?: readonly string[];
  selectedTools?: readonly string[];
  unmatchedSkills: readonly string[];
  unmatchedExtensions: readonly string[];
  unmatchedTools?: readonly string[];
  selectorSources: AgentResourceSelectorSources;
}
export interface AgentResourceInspection { selectors: AgentResourceSelectorSet; skills: readonly string[]; extensions: readonly string[]; tools: readonly string[]; unmatchedSkills: readonly string[]; unmatchedExtensions: readonly string[]; unmatchedTools: readonly string[]; selectorSources?: AgentResourceSelectorSources }

export interface ContextFile { readonly path: string; readonly content: string }
export interface AgentActivity { kind: "reasoning" | "tool" | "text"; text: string }
export const WORKFLOW_AGENT_STALL_THRESHOLD_MS = 10 * 60 * 1000;
export interface AgentAccounting { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export function zeroAccounting(): AgentAccounting { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }; }
export function addAccounting(left: AgentAccounting, right: AgentAccounting): AgentAccounting { return { input: left.input + right.input, output: left.output + right.output, cacheRead: left.cacheRead + right.cacheRead, cacheWrite: left.cacheWrite + right.cacheWrite, cost: left.cost + right.cost }; }
export function sumAccounting(values: Iterable<AgentAccounting>): AgentAccounting {
  let total = zeroAccounting();
  for (const value of values) total = addAccounting(total, value);
  return total;
}
export interface AgentSetupSummary { hookNames: readonly string[]; model: ModelSpec; tools: readonly string[]; cwd: string; resourceSelectors?: AgentResourceInspection }

export interface AgentAttemptError { code: string; message: string }
export interface AgentAttemptSummary { attempt: number; transport: string; session?: WorkflowAgentSessionReference; setup: AgentSetupSummary; error?: AgentAttemptError; accounting: AgentAccounting }
export interface WorkflowWorktreeCreatedEvent extends WorkflowEventBase { owner: string; branch: string; path: string; base: string }
export interface WorkflowWorktreeReference { readonly path: string; readonly branch: string }
export interface AgentRecord {
  systemPrompt?: string;
  prompt?: string;
  id: string;
  name: string;
  label?: string;
  path: string;
  state: AgentState;
  parentId?: string;
  structuralPath?: readonly string[];
  resultPath?: string;
  parentBreadcrumb?: string;
  worktreeOwner?: string;
  role?: string;
  requestedModel?: string;
  model: ModelSpec;
  tools: readonly string[];
  toolDefinitions?: readonly { readonly name: string; readonly description: string }[];
  attempts: number;
  startedAt?: number;
  durationMs?: number;
  attemptDetails?: readonly AgentAttemptSummary[];
  accounting?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  toolCalls?: readonly { id: string; name: string; state: "running" | "completed" | "failed" }[];
  activity?: AgentActivity | undefined;
  lastEventAt?: number;
}
export type WorkflowDeliveryMode = "foreground" | "background";
export type WorkflowDeliveryStatus = "attached" | "pending" | "delivered";
export interface WorkflowRunDelivery { mode: WorkflowDeliveryMode; state: WorkflowDeliveryStatus; toolCallId?: string }
export interface WorkflowRunEvent { type: string; message: string; timestamp?: number }
export interface WorkflowRetryProvenance { sourceRunId: string; lineageRootRunId: string; completedPaths: readonly string[]; incompletePaths: readonly string[]; namedWorktrees: readonly string[] }
export interface WorkflowPhaseRecord { phase: string; afterAgent: number }
export interface WorkflowPhaseShellActivity { phaseIndex: number; active: number; startedAt: number }
export interface RunRecord {
  id: string;
  workflowName: string;
  cwd: string;
  sessionId: string;
  state: RunState;
  agentSessions: readonly WorkflowAgentSessionReference[];
  parentRunId?: string;
  retry?: WorkflowRetryProvenance;
  phase?: string;
  phaseHistory?: readonly WorkflowPhaseRecord[];
  phaseHistoryIndex?: number;
  agents: readonly AgentRecord[];
  activeShells?: number;
  activeShellStartedAt?: number;
  activeShellsByPhase?: readonly WorkflowPhaseShellActivity[];
  error?: WorkflowErrorShape;
  failedAt?: string;
  budget?: WorkflowBudget;
  budgetVersion?: number;
  usage?: WorkflowBudgetUsage;
  budgetEvents?: readonly BudgetEvent[];
  events?: readonly WorkflowRunEvent[];
  delivery?: WorkflowRunDelivery;
}
export const LAUNCH_SNAPSHOT_IDENTITY_VERSION = 5;
export type WorkflowLaunchMode = "foreground" | "background";
export interface AgentDefinition { prompt?: string; description?: string; model?: string; thinking?: NonNullable<ModelSpec["thinking"]>; tools?: readonly string[]; skills?: readonly string[]; extensions?: readonly string[]; overrideSystemPrompt?: boolean; contextFiles?: readonly ContextFileScope[] }
export interface LaunchSnapshot {
  identityVersion?: number;
  launchMode?: WorkflowLaunchMode;
  script: string;
  args: JsonValue;
  metadata: WorkflowMetadata;
  settings: WorkflowSettings;
  settingsSources?: WorkflowSettingsSources;
  budget?: WorkflowBudget;
  settingsPath?: string;
  modelAliases?: Readonly<Record<string, string>>;
  phases?: readonly string[];
  models: readonly string[];
  tools: readonly string[];
  agentTypes: readonly string[];
  roles?: Readonly<Record<string, AgentDefinition>>;
  projectRoles?: readonly string[];
  schemas: readonly JsonSchema[];
}
export interface PreflightCapabilities { models: ReadonlySet<string>; tools: ReadonlySet<string>; agentTypes: ReadonlySet<string>; modelAliases?: Readonly<Record<string, string>>; knownModels?: ReadonlySet<string>; settingsPath?: string; skipModelAvailability?: boolean }
export interface PreflightResult { metadata: WorkflowMetadata; referenced: { phases: readonly string[]; models: readonly string[]; tools: readonly string[]; agentTypes: readonly string[] }; schemas: readonly JsonSchema[]; dynamicAgentRoles: boolean }
export interface WorkflowOrchestrationContext { agent: { <Schema extends TSchema>(prompt: string, options: Readonly<AgentOptions<Schema> & { outputSchema: Schema }>): Promise<Static<Schema>>; (prompt: string, options?: Readonly<AgentOptions>): Promise<JsonValue> }; shell: (command: string, options?: ShellOptions) => Promise<ShellResult>; prompt: (template: string, values: Readonly<Record<string, JsonValue>>) => string; parallel: <Tasks extends ParallelTasks>(operationName: string, tasks: Tasks) => Promise<ParallelResult<Tasks>>; pipeline: <Items extends PipelineItems, Output extends JsonValue>(operationName: string, items: Items, stages: PipelineStages<Items[keyof Items], Output>) => Promise<PipelineResult<Items, Output>>; withWorktree: <Result extends JsonValue>(name: string, callback: WorkflowWorktreeCallback<Result>) => Promise<Result>; checkpoint: (input: CheckpointInput) => Promise<boolean>; phase: (name: string) => void; log: (message: string) => void }
export interface WorkflowRunContext { cwd: string; sessionId: string; runId: string; workflow: Readonly<WorkflowMetadata>; args: JsonValue; signal: AbortSignal }
export interface WorkflowFunctionContext extends WorkflowOrchestrationContext { run: Readonly<WorkflowRunContext>; invoke: (name: string, input: Readonly<Record<string, JsonValue>>, label?: string) => Promise<JsonValue> }
export type WorkflowWorktreeCallback<Result extends JsonValue = JsonValue> = (reference: Readonly<WorkflowWorktreeReference>) => Result | Promise<Result>;
export interface WorkflowFunction { description: string; input: WorkflowSchema; output: WorkflowSchema; run(input: Readonly<Record<string, JsonValue>>, context: Readonly<WorkflowFunctionContext>): unknown }
type TypedWorkflowFunction<InputSchema extends TSchema, OutputSchema extends TSchema> = {
  description: string;
  input: InputSchema;
  output: OutputSchema;
  run: (input: Readonly<Static<NoInfer<InputSchema>>>, context: Readonly<WorkflowFunctionContext>) => Promise<Static<NoInfer<OutputSchema>>> | Static<NoInfer<OutputSchema>>;
};
type DefinedWorkflowFunction<InputSchema extends TSchema, OutputSchema extends TSchema, Run extends TypedWorkflowFunction<InputSchema, OutputSchema>["run"]> = Omit<TypedWorkflowFunction<InputSchema, OutputSchema>, "run"> & { run: Run };
export function defineWorkflowFunction<InputSchema extends TSchema, OutputSchema extends TSchema, Run extends TypedWorkflowFunction<InputSchema, OutputSchema>["run"]>(workflowFunction: DefinedWorkflowFunction<InputSchema, OutputSchema, Run>): DefinedWorkflowFunction<InputSchema, OutputSchema, Run> { return workflowFunction; }
export interface WorkflowAgentSessionReference { readonly transport: string; readonly sessionId: string; readonly locator?: JsonValue }
export interface WorkflowAgentSessionStats { readonly tokens: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly total: number }; readonly cost: number }
export interface WorkflowAgentMessage { readonly role: string; readonly content?: unknown; readonly stopReason?: string; readonly errorMessage?: string; readonly usage?: { readonly input: number; readonly output: number; readonly cacheRead: number; readonly cacheWrite: number; readonly cost: { readonly total: number } } }
export interface WorkflowAgentSessionState { readonly model: ModelSpec; readonly thinking?: ModelSpec["thinking"]; readonly tools: readonly string[]; readonly systemPrompt?: string }
export interface WorkflowAgentSessionEvent { readonly type: string; readonly state?: Readonly<WorkflowAgentSessionState>; readonly message?: WorkflowAgentMessage; readonly assistantMessageEvent?: { readonly type: string }; readonly toolCallId?: string; readonly toolName?: string; readonly isError?: boolean }
export type LiveSessionHandoffState = "local-running" | "handoff-pending" | "herdr-running" | "returning-local" | "completed";
export interface LiveSessionHandoff {
  readonly state: LiveSessionHandoffState;
  readonly transferred: boolean;
  observe(event: WorkflowAgentSessionEvent): void;
  request(launch: () => Promise<void>): Promise<void>;
  waitForTakeover(): Promise<void>;
  takeover(): void;
  waitForResume(): Promise<void>;
  release(reason?: string): void;
}
export interface WorkflowAgentTurnResult { readonly assistant?: WorkflowAgentMessage }
export interface WorkflowAgentSession {
  readonly reference: WorkflowAgentSessionReference;
  getState(): Readonly<WorkflowAgentSessionState>;
  getSessionStats(): WorkflowAgentSessionStats;
  getLastAssistant(): WorkflowAgentMessage | undefined;
  subscribe(listener: (event: WorkflowAgentSessionEvent) => void): () => void;
  subscribeAsync?(listener: (event: WorkflowAgentSessionEvent) => void | Promise<void>): () => void;
  prompt(text: string): Promise<WorkflowAgentTurnResult>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  suspendForHandoff?(): Promise<void>;
  resumeFromHandoff?(): Promise<void>;
  dispose(): Promise<void>;
  getResourceInspection?(): { readonly skills: readonly string[]; readonly extensions: readonly string[] };
}
type SessionTools = NonNullable<CreateAgentSessionOptions["tools"]>;
type SessionCustomTools = NonNullable<CreateAgentSessionOptions["customTools"]>;
export interface SessionInput {
  cwd: string;
  model: ModelSpec;
  tools: SessionTools;
  sessionLabel: string;
  sessionPath?: string;
  sessionManager?: SessionManager;
  agentDir?: string;
  customTools?: SessionCustomTools;
  resultTool?: ToolDefinition;
  systemPrompt?: string;
  systemPromptAppend?: string;
  extensionFactories?: InlineExtension[];
  additionalSkillPaths?: readonly string[];
  contextFiles?: readonly ContextFileScope[];
  resourcePolicy?: AgentResourcePolicy;
  options?: AgentOptions;
}
export interface PiRuntimeLaunchInfo {
  readonly executable: string;
  readonly entrypoint?: string;
}
export interface PreparedAgentSession {
  readonly cwd: string;
  readonly model: ModelSpec;
  readonly tools: readonly string[];
  readonly sessionLabel: string;
  readonly initialPrompt?: string;
  readonly agentDir?: string;
  readonly customTools?: readonly ToolDefinition[];
  readonly resultTool?: ToolDefinition;
  readonly options?: Readonly<Record<string, JsonValue>>;
  readonly piRuntime?: Readonly<PiRuntimeLaunchInfo>;
  readonly piRuntimeError?: string;
  readonly systemPrompt?: string;
  readonly systemPromptPath?: string;
  readonly systemPromptAppend?: string;
  readonly extensionFactories?: readonly InlineExtension[];
  readonly additionalSkillPaths?: readonly string[];
  readonly contextFiles?: readonly ContextFileScope[];
  readonly resourcePolicy?: Readonly<AgentResourcePolicy>;
}
export type AgentInspectionMode = "execution" | "inspection";
export interface AgentTransportContext { readonly run: Readonly<WorkflowRunContext>; readonly identity: Readonly<AgentIdentity>; readonly attempt: number; readonly signal: AbortSignal; readonly tuiIndex?: number; readonly tuiLabel?: string }
export interface AgentTransport { readonly id: string; createSession(prepared: Readonly<PreparedAgentSession>, context: Readonly<AgentTransportContext>): Promise<WorkflowAgentSession> }
export interface AgentSetup { prompt: string; options: AgentOptions; sessionInput: SessionInput; prepared: Readonly<PreparedAgentSession>; transport: AgentTransport }
export interface AgentSetupContext { readonly run: Readonly<WorkflowRunContext>; readonly identity: Readonly<AgentIdentity>; readonly attempt: number; readonly signal: AbortSignal; readonly tuiIndex?: number; readonly tuiLabel?: string; readonly mode?: AgentInspectionMode }

export interface AgentSetupHook { priority?: number; setup: (agent: AgentSetup, context: Readonly<AgentSetupContext>) => void | Promise<void> }
export interface RegisteredAgentSetupHook { name: string; priority: number; setup: AgentSetupHook["setup"] }
export interface WorkflowExtensionMetadata { version: string; headline: string }
export interface WorkflowRoleDirectoryRegistration { path: string; extension: WorkflowExtensionMetadata }
export interface AgentAttemptActionUi { notify(message: string, level?: "info" | "warning" | "error"): void; confirm(title: string, message: string): Promise<boolean>; select(title: string, options: readonly string[]): Promise<string | undefined>; input(title: string, placeholder?: string): Promise<string | undefined>; setWorkingMessage?(message?: string): void }
export interface StandaloneAgentRecord { readonly id: string; readonly name: string; readonly label?: string; readonly state: "running" | "completed" | "failed" | "stopped"; readonly structuralPath?: readonly string[] }
export interface StandaloneAgentAttemptActionContext { readonly agent: Readonly<StandaloneAgentRecord>; readonly attempt: Readonly<AgentAttemptSummary>; readonly session?: WorkflowAgentSessionReference; readonly liveSession?: WorkflowAgentSession; readonly prepared?: Readonly<PreparedAgentSession>; readonly handoff?: LiveSessionHandoff; readonly signal: AbortSignal; readonly ui: Readonly<AgentAttemptActionUi> }
export interface AgentAttemptActionContext { readonly run: Readonly<RunRecord>; readonly agent: Readonly<AgentRecord>; readonly attempt: Readonly<AgentAttemptSummary>; readonly session?: WorkflowAgentSessionReference; readonly liveSession?: WorkflowAgentSession; readonly prepared?: Readonly<PreparedAgentSession>; readonly handoff?: LiveSessionHandoff; readonly signal: AbortSignal; readonly ui: Readonly<AgentAttemptActionUi> }
export interface AgentAttemptAction { readonly label: string; visible(context: Readonly<AgentAttemptActionContext>): boolean; run(context: Readonly<AgentAttemptActionContext>): void | Promise<void>; visibleStandalone?(context: Readonly<StandaloneAgentAttemptActionContext>): boolean; runStandalone?(context: Readonly<StandaloneAgentAttemptActionContext>): void | Promise<void> }
export interface WorkflowExtension extends WorkflowExtensionMetadata { description?: string; functions?: Readonly<Record<string, WorkflowFunction>>; modelAliases?: Readonly<Record<string, WorkflowModelAlias>>; agentSetupHooks?: Readonly<Record<string, AgentSetupHook>>; agentAttemptActions?: Readonly<Record<string, AgentAttemptAction>>; roleDirectories?: readonly (string | URL)[] }
export interface WorkflowJournal { get(path: string): JsonValue | undefined; put(path: string, value: JsonValue): void }
// The brand keeps instanceof working across the bundled extension entries, which each inline their own copy of this class.
const WORKFLOW_ERROR_BRAND = Symbol.for("pi-extensible-workflows.workflow-error");
export class WorkflowError extends Error {
  constructor(public readonly code: WorkflowErrorCode, message: string) { super(message); this.name = "WorkflowError"; (this as unknown as Record<symbol, boolean>)[WORKFLOW_ERROR_BRAND] = true; }
  static [Symbol.hasInstance](value: unknown): boolean {
    if (Function.prototype[Symbol.hasInstance].call(this, value)) return true;
    // Subclasses do not own the brand marker, so they keep plain prototype-chain semantics.
    return Object.hasOwn(this, WORKFLOW_ERROR_BRAND) && typeof value === "object" && value !== null && WORKFLOW_ERROR_BRAND in value;
  }
}
Object.defineProperty(WorkflowError, WORKFLOW_ERROR_BRAND, { value: true });
export interface WorkflowFailureAgent { id: string; label?: string; role?: string; structuralPath: readonly string[]; attempt: number; transport?: string; session?: WorkflowAgentSessionReference }
export interface WorkflowSiblingAgent { id: string; label?: string; role?: string; structuralPath: readonly string[] }
export interface WorkflowFailureDiagnostics { runId: string; workflowName: string; state: RunState; failedAt: string | null; error: WorkflowErrorShape; failedAgent?: WorkflowFailureAgent; completedSiblingAgents?: readonly WorkflowSiblingAgent[]; completedSiblingPaths: readonly (readonly string[])[]; retry?: { sourceRunId: string; action: string; completedPaths: readonly string[]; incompletePaths: readonly string[]; namedWorktrees: readonly string[]; warning: string }; artifacts: { runDirectory: string; statePath: string; journalPath: string } }
export interface CheckpointInput { name: string; prompt: string; context: JsonValue }
export interface FunctionIdentity { path: string; structuralPath: readonly string[]; occurrence: number; worktreeOwner?: string }
export interface AgentIdentity { structuralPath: readonly string[]; callSite: string; occurrence: number; parentBreadcrumb?: string; worktreeOwner?: string }
export interface ShellIdentity { structuralPath: readonly string[]; callSite: string; occurrence: number; worktreeOwner?: string }
export interface WorkflowBridge { agent?: (prompt: string, options: Readonly<Record<string, JsonValue>>, signal: AbortSignal, identity: AgentIdentity) => Promise<JsonValue>; shell?: (command: string, options: ShellOptions, signal: AbortSignal, identity: ShellIdentity) => Promise<ShellResult>; checkpoint?: (input: Readonly<Record<string, JsonValue>>, signal: AbortSignal) => boolean | Promise<boolean>; function?: (name: string, input: Readonly<Record<string, JsonValue>>, signal: AbortSignal, identity: FunctionIdentity) => Promise<JsonValue>; worktree?: (owner: string, signal: AbortSignal) => Promise<Readonly<WorkflowWorktreeReference>>; functions?: Readonly<Record<string, { name: string }>>; phase?: (name: string) => void | Promise<void>; log?: (message: string) => void | Promise<void> }
export interface WorkflowExecution { result: Promise<JsonValue>; cancel: () => void }
export interface StaticWorkflowScope { kind: "parallel" | "pipeline"; name: string | null; key: string | null }
export type StaticWorkflowExecution = "parallel" | "sequential";
export interface StaticWorkflowCall { kind: WorkflowCallKind; start: number; end: number; name: string | null; prompt: string | null; model: string | null; label?: string | null; role: string | null; retries?: number | null; outputSchema?: JsonSchema | null; options?: Readonly<Record<string, JsonValue>> | null; optionKeys?: readonly string[]; execution?: StaticWorkflowExecution; structure?: readonly StaticWorkflowScope[] }
export interface WorkflowCatalogFunction { name: string; version: string; headline: string; description: string; input: JsonSchema; output: JsonSchema }
export interface WorkflowCatalogModelAlias { name: string; kind: "static" | "dynamic"; provenance: string; version?: string; headline?: string }
export interface WorkflowCatalogSettings { concurrency: number; backgroundWidget: boolean; modelAliases: Readonly<Record<string, string>>; skills: readonly string[]; extensions: readonly string[]; extensionSettings?: Readonly<WorkflowExtensionSettings>; tools: readonly string[]; globalSettingsPath: string; projectSettingsPath: string; projectTrusted: boolean; sources: WorkflowSettingsSources }
export interface WorkflowCatalogContext { cwd: string; projectTrusted: boolean; globalSettingsPath?: string }
export interface WorkflowCatalog { functions: readonly WorkflowCatalogFunction[]; modelAliases?: Readonly<Record<string, string>>; modelAliasEntries?: readonly WorkflowCatalogModelAlias[]; settings?: WorkflowCatalogSettings }
export interface WorkflowCatalogIndexFunction { name: string; description: string; input: JsonSchema }
export interface WorkflowCatalogIndex { functions: readonly WorkflowCatalogIndexFunction[]; modelAliases?: Readonly<Record<string, string>>; modelAliasEntries?: readonly WorkflowCatalogModelAlias[]; settings?: WorkflowCatalogSettings }
export interface WorkflowCatalogError { error: { code: "NOT_FOUND"; name: string; message: string } }
export interface WorkflowValidationParameters { name: string; description?: string; script?: string; scriptPath?: string; args?: unknown }
export interface WorkflowValidationContext { cwd: string; projectTrusted: boolean; availableModels: ReadonlySet<string>; rootTools: ReadonlySet<string>; modelAliases?: Readonly<Record<string, string>>; knownModels?: ReadonlySet<string>; settingsPath?: string; agentDir?: string }
export interface ValidatedWorkflowLaunch { script: string; checked: PreflightResult; agentDefinitions: Readonly<Record<string, AgentDefinition>>; projectAgentDefinitions: Readonly<Record<string, AgentDefinition>>; roleNames: readonly string[] }