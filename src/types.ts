export const RUN_STATES = ["queued", "running", "pausing", "paused", "awaiting_input", "completed", "failed", "stopped", "interrupted", "budget_exhausted"] as const;
export const AGENT_STATES = ["queued", "running", "waiting_for_child", "paused", "retrying", "completed", "failed", "cancelled"] as const;
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
export const ERROR_CODES = [
  "CONFIG_ERROR", "INVALID_SETTINGS", "INVALID_SYNTAX", "INVALID_METADATA", "DUPLICATE_NAME", "INVALID_SCHEMA", "UNKNOWN_MODEL", "UNKNOWN_TOOL", "UNKNOWN_AGENT_TYPE",
  "RUN_OWNED", "REGISTRY_FROZEN", "GLOBAL_COLLISION", "MISSING_WORKFLOW", "RPC_LIMIT_EXCEEDED", "SHELL_FAILED", "AGENT_TIMEOUT", "AGENT_FAILED", "RESULT_INVALID",
  "CANCELLED", "WORKER_UNRESPONSIVE", "WORKTREE_FAILED", "RESUME_INCOMPATIBLE", "BUDGET_EXHAUSTED", "INTERNAL_ERROR",
  ] as const;

export type RunState = (typeof RUN_STATES)[number];
export type AgentState = (typeof AGENT_STATES)[number];
export type WorkflowErrorCode = (typeof ERROR_CODES)[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = { [key: string]: JsonValue };
export interface AgentOptions {
  label?: string;
  model?: string;
  thinking?: NonNullable<ModelSpec["thinking"]>;
  tools?: string[];
  role?: string;
  outputSchema?: JsonSchema;
  retries?: number;
  timeoutMs?: number | null;
  [key: string]: JsonValue;
}
export interface ShellOptions { timeoutMs?: number; env?: Record<string, string> }
export interface ShellResult { exitCode: number | null; stdout: string; stderr: string }
export type BudgetDimension = "tokens" | "costUsd" | "durationMs" | "agentLaunches";
export interface BudgetLimits { soft?: number; hard?: number }
export type WorkflowBudget = Partial<Record<BudgetDimension, BudgetLimits>>;
export type WorkflowBudgetPatch = Partial<Record<BudgetDimension, BudgetLimits | { soft?: number | null; hard?: number | null } | null>>;
export interface WorkflowBudgetUsage { tokens: number; costUsd: number; durationMs: number; agentLaunches: number }
export type BudgetEventType = "soft_crossed" | "hard_overrun" | "hard_exhausted" | "adjustment_requested" | "adjustment_approved" | "adjustment_rejected";
export interface BudgetEvent { type: BudgetEventType; budgetVersion: number; dimensions: readonly BudgetDimension[]; usage: WorkflowBudgetUsage; limits: WorkflowBudget; at: number; proposalId?: string; previous?: WorkflowBudget; proposed?: WorkflowBudget }
export interface BudgetApprovalRequest { kind: "budget"; proposalId: string; runId: string; consumed: WorkflowBudgetUsage; previous: WorkflowBudget; proposed: WorkflowBudget; budgetVersion: number }
export interface WorkflowErrorShape { code: WorkflowErrorCode; message: string }
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
export interface ModelSpec { provider: string; model: string; thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }
export interface WorkflowMetadata { name: string; description?: string }
export interface WorkflowSettings { concurrency: number; modelAliases?: Readonly<Record<string, string>>; disabledAgentResources?: Readonly<AgentResourceExclusions> }
export interface AgentResourceExclusions { skills: readonly string[]; extensions: readonly string[] }
export interface AgentResourcePolicy { globalSettingsPath: string; projectSettingsPath: string; projectTrusted: boolean; global: AgentResourceExclusions; project: AgentResourceExclusions; effective: AgentResourceExclusions; unmatchedSkills: string[]; unmatchedExtensions: string[] }
export interface AgentActivity { kind: "reasoning" | "tool" | "text"; text: string }
export interface AgentAccounting { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export interface AgentSetupSummary { hookNames: readonly string[]; model: ModelSpec; tools: readonly string[]; cwd: string; disabledAgentResources?: { skills: readonly string[]; extensions: readonly string[]; unmatchedSkills: readonly string[]; unmatchedExtensions: readonly string[] } }
export interface AgentAttemptSummary { attempt: number; sessionId: string; sessionFile: string; error?: { code: string; message: string }; accounting: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }; setup?: AgentSetupSummary }
export interface WorkflowWorktreeCreatedEvent extends WorkflowEventBase { owner: string; branch: string; path: string; base: string }
export interface WorkflowWorktreeReference { readonly path: string; readonly branch: string }
export interface AgentRecord { id: string; name: string; label?: string; path: string; state: AgentState; parentId?: string; structuralPath?: readonly string[]; parentBreadcrumb?: string; worktreeOwner?: string; role?: string; requestedModel?: string; model: ModelSpec; tools: readonly string[]; attempts: number; attemptDetails?: readonly AgentAttemptSummary[]; accounting?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }; toolCalls?: readonly { id: string; name: string; state: "running" | "completed" | "failed" }[]; activity?: AgentActivity | undefined }
export interface WorkflowRunEvent { type: string; message: string }
export interface WorkflowRetryProvenance { sourceRunId: string; lineageRootRunId: string; completedPaths: readonly string[]; incompletePaths: readonly string[]; namedWorktrees: readonly string[] }
export interface WorkflowPhaseRecord { phase: string; afterAgent: number }
export interface RunRecord { id: string; workflowName: string; cwd: string; sessionId: string; state: RunState; parentRunId?: string; retry?: WorkflowRetryProvenance; phase?: string; phaseHistory?: readonly WorkflowPhaseRecord[]; agents: readonly AgentRecord[]; error?: WorkflowErrorShape; budget?: WorkflowBudget; budgetVersion?: number; usage?: WorkflowBudgetUsage; budgetEvents?: readonly BudgetEvent[]; events?: readonly WorkflowRunEvent[] }
export const LAUNCH_SNAPSHOT_IDENTITY_VERSION = 5;
export interface AgentDefinition { prompt?: string; description?: string; model?: string; thinking?: NonNullable<ModelSpec["thinking"]>; tools?: readonly string[]; disabledAgentResources?: AgentResourceExclusions }
export interface LaunchSnapshot { identityVersion?: number; launchKind?: "inline" | "function"; functionName?: string; script: string; args: JsonValue; metadata: WorkflowMetadata; settings: WorkflowSettings; budget?: WorkflowBudget; settingsPath?: string; modelAliases?: Readonly<Record<string, string>>; models: readonly string[]; tools: readonly string[]; agentTypes: readonly string[]; roles?: Readonly<Record<string, AgentDefinition>>; projectRoles?: readonly string[]; schemas: readonly JsonSchema[] }
export interface PreflightCapabilities { models: ReadonlySet<string>; tools: ReadonlySet<string>; agentTypes: ReadonlySet<string>; modelAliases?: Readonly<Record<string, string>>; knownModels?: ReadonlySet<string>; settingsPath?: string; skipModelAvailability?: boolean }
export interface PreflightResult { metadata: WorkflowMetadata; referenced: { phases: readonly string[]; models: readonly string[]; tools: readonly string[]; agentTypes: readonly string[] }; schemas: readonly JsonSchema[]; dynamicAgentRoles: boolean }
export interface WorkflowOrchestrationContext { agent: (prompt: string, options?: Readonly<AgentOptions>) => Promise<JsonValue>; shell: (command: string, options?: ShellOptions) => Promise<ShellResult>; prompt: (template: string, values: Readonly<Record<string, JsonValue>>) => string; parallel: (...args: readonly unknown[]) => Promise<JsonValue>; pipeline: (...args: readonly unknown[]) => Promise<JsonValue>; withWorktree: (name: string, callback: WorkflowWorktreeCallback) => Promise<JsonValue>; checkpoint: (...args: readonly unknown[]) => Promise<boolean>; phase: (name: string) => void; log: (message: string) => void }
export interface WorkflowRunContext { cwd: string; sessionId: string; runId: string; workflow: Readonly<WorkflowMetadata>; args: JsonValue; signal: AbortSignal }
export interface WorkflowFunctionContext extends WorkflowOrchestrationContext { run: Readonly<WorkflowRunContext>; invoke: (name: string, input: Readonly<Record<string, JsonValue>>) => Promise<JsonValue> }
export type WorkflowWorktreeCallback = (reference: Readonly<WorkflowWorktreeReference>) => JsonValue | Promise<JsonValue>;
export interface WorkflowFunction { description: string; input: JsonSchema; output: JsonSchema; run: (input: Readonly<Record<string, JsonValue>>, context: Readonly<WorkflowFunctionContext>) => Promise<JsonValue> | JsonValue }
export interface WorkflowVariable { description: string; schema: JsonSchema; resolve: (run: Readonly<WorkflowRunContext>) => Promise<JsonValue> | JsonValue }
export interface AgentSetup { prompt: string; options: Record<string, JsonValue>; sessionInput: { extensionFactories?: unknown[]; [key: string]: unknown }; createSession: unknown }
export interface AgentSetupContext { readonly run: Readonly<WorkflowRunContext>; readonly identity: Readonly<AgentIdentity>; readonly attempt: number; readonly signal: AbortSignal }
export interface AgentSetupHook { priority?: number; setup: (agent: AgentSetup, context: Readonly<AgentSetupContext>) => void | Promise<void> }
export interface RegisteredAgentSetupHook { name: string; priority: number; setup: AgentSetupHook["setup"] }
export interface WorkflowExtension { version: string; headline: string; description: string; functions?: Readonly<Record<string, WorkflowFunction>>; variables?: Readonly<Record<string, WorkflowVariable>>; agentSetupHooks?: Readonly<Record<string, AgentSetupHook>> }
export interface WorkflowJournal { get(path: string): JsonValue | undefined; put(path: string, value: JsonValue): void }
export class WorkflowError extends Error { constructor(public readonly code: WorkflowErrorCode, message: string) { super(message); this.name = "WorkflowError"; } }
export interface WorkflowFailureAgent { id: string; label?: string; role?: string; structuralPath: readonly string[]; attempt: number; sessionId?: string; sessionFile?: string }
export interface WorkflowSiblingAgent { id: string; label?: string; role?: string; structuralPath: readonly string[] }
export interface WorkflowFailureDiagnostics { runId: string; workflowName: string; state: RunState; failedAt: string | null; error: WorkflowErrorShape; failedAgent?: WorkflowFailureAgent; completedSiblingAgents?: readonly WorkflowSiblingAgent[]; completedSiblingPaths: readonly (readonly string[])[]; retry?: { sourceRunId: string; action: string; completedPaths: readonly string[]; incompletePaths: readonly string[]; namedWorktrees: readonly string[]; warning: string }; artifacts: { runDirectory: string; statePath: string; journalPath: string } }
export interface CheckpointInput { name: string; prompt: string; context: JsonValue }
export interface AgentIdentity { structuralPath: readonly string[]; callSite: string; occurrence: number; parentBreadcrumb?: string; worktreeOwner?: string }
export interface ShellIdentity { structuralPath: readonly string[]; callSite: string; occurrence: number; worktreeOwner?: string }
export interface WorkflowBridge { agent?: (prompt: string, options: Readonly<Record<string, JsonValue>>, signal: AbortSignal, identity: AgentIdentity) => Promise<JsonValue>; shell?: (command: string, options: ShellOptions, signal: AbortSignal, identity: ShellIdentity) => Promise<ShellResult>; checkpoint?: (input: Readonly<Record<string, JsonValue>>, signal: AbortSignal) => boolean | Promise<boolean>; function?: (name: string, input: Readonly<Record<string, JsonValue>>, path: string, signal: AbortSignal, worktreeOwner?: string, structuralPath?: readonly string[]) => Promise<JsonValue>; worktree?: (owner: string, signal: AbortSignal) => Promise<Readonly<WorkflowWorktreeReference>>; functions?: Readonly<Record<string, { name: string }>>; variables?: Readonly<Record<string, JsonValue>>; phase?: (name: string) => void | Promise<void>; log?: (message: string) => void | Promise<void> }
export interface WorkflowExecution { result: Promise<JsonValue>; cancel: () => void }
export interface StaticWorkflowScope { kind: "parallel" | "pipeline"; name: string | null; key: string | null }
export type StaticWorkflowExecution = "parallel" | "sequential";
export interface StaticWorkflowCall { kind: WorkflowCallKind; start: number; end: number; name: string | null; prompt: string | null; model: string | null; label?: string | null; role: string | null; retries?: number | null; outputSchema?: JsonSchema | null; options?: Readonly<Record<string, JsonValue>> | null; optionKeys?: readonly string[]; execution?: StaticWorkflowExecution; structure?: readonly StaticWorkflowScope[] }
export interface WorkflowCatalogFunction { name: string; version: string; headline: string; extensionDescription: string; description: string; input: JsonSchema; output: JsonSchema }
export interface WorkflowCatalogVariable { name: string; version: string; headline: string; extensionDescription: string; description: string; schema: JsonSchema }
export interface WorkflowCatalog { functions: readonly WorkflowCatalogFunction[]; variables: readonly WorkflowCatalogVariable[]; modelAliases?: Readonly<Record<string, string>> }
export interface WorkflowCatalogIndexFunction { name: string; description: string; input: JsonSchema }
export interface WorkflowCatalogIndexVariable { name: string; description: string; schema: JsonSchema }
export interface WorkflowCatalogIndex { functions: readonly WorkflowCatalogIndexFunction[]; variables: readonly WorkflowCatalogIndexVariable[]; modelAliases?: Readonly<Record<string, string>> }
export interface WorkflowCatalogError { error: { code: "NOT_FOUND"; name: string; message: string } }
export interface WorkflowValidationParameters { name?: string; description?: string; script?: string; workflow?: string; args?: unknown }
export interface WorkflowValidationContext { cwd: string; projectTrusted: boolean; availableModels: ReadonlySet<string>; rootTools: ReadonlySet<string>; modelAliases?: Readonly<Record<string, string>>; knownModels?: ReadonlySet<string>; settingsPath?: string; agentDir?: string }
export interface ValidatedWorkflowLaunch { script: string; checked: PreflightResult; agentDefinitions: Readonly<Record<string, AgentDefinition>>; projectAgentDefinitions: Readonly<Record<string, AgentDefinition>>; roleNames: readonly string[]; functionName?: string }