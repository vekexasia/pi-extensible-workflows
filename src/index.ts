import { AsyncLocalStorage } from "node:async_hooks";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";
import { Script } from "node:vm";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { copyToClipboard, getAgentDir, parseFrontmatter, highlightCode, SessionManager, truncateToVisualLines, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createNativeAgentSession, FairAgentScheduler, WorkflowAgentExecutor, type AgentActivity, type AgentAccounting, type AgentAttempt, type AgentBudgetHooks, type AgentDefinition, type AgentProgress, type AgentSetupHook, type RegisteredAgentSetupHook, type SessionFactory } from "./agent-execution.js";
import { transcriptLines } from "./session-inspector.js";
import { acquireSessionLease, atomicWriteFile, listRunIds, RunStore, SessionLease, structuralPath as operationPath } from "./persistence.js";
import type { AwaitingCheckpoint, PersistedRun, WorktreeReference } from "./persistence.js";

export const RUN_STATES = ["queued", "running", "pausing", "paused", "awaiting_input", "completed", "failed", "stopped", "interrupted", "budget_exhausted"] as const;
export const AGENT_STATES = ["queued", "running", "waiting_for_child", "paused", "retrying", "completed", "failed", "cancelled"] as const;
export const WORKFLOW_CALL_KINDS = ["agent", "conversation", "parallel", "pipeline", "checkpoint", "phase", "withWorktree"] as const;
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
const SETTLED_AGENT_STATES: ReadonlySet<AgentState> = new Set(["completed", "failed", "cancelled"]);
export const ERROR_CODES = [
  "CONFIG_ERROR", "INVALID_SETTINGS", "INVALID_SYNTAX", "INVALID_METADATA", "DUPLICATE_NAME", "INVALID_SCHEMA", "UNKNOWN_MODEL", "UNKNOWN_TOOL", "UNKNOWN_AGENT_TYPE",
  "RUN_OWNED", "REGISTRY_FROZEN", "GLOBAL_COLLISION", "MISSING_WORKFLOW", "RPC_LIMIT_EXCEEDED", "AGENT_TIMEOUT", "AGENT_FAILED", "RESULT_INVALID",
  "CANCELLED", "WORKER_UNRESPONSIVE", "WORKTREE_FAILED", "RESUME_INCOMPATIBLE", "BUDGET_EXHAUSTED", "INTERNAL_ERROR",
  ] as const;

export type RunState = (typeof RUN_STATES)[number];
export type AgentState = (typeof AGENT_STATES)[number];
export type WorkflowErrorCode = (typeof ERROR_CODES)[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = { [key: string]: JsonValue };
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
export interface AgentSetupSummary { hookNames: readonly string[]; model: ModelSpec; tools: readonly string[]; cwd: string; disabledAgentResources?: { skills: readonly string[]; extensions: readonly string[]; unmatchedSkills: readonly string[]; unmatchedExtensions: readonly string[] } }
export interface AgentAttemptSummary { attempt: number; sessionId: string; sessionFile: string; error?: { code: string; message: string }; accounting: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }; setup?: AgentSetupSummary }
export interface WorkflowWorktreeCreatedEvent extends WorkflowEventBase { owner: string; branch: string; path: string; base: string }
export interface AgentRecord { id: string; name: string; label?: string; path: string; state: AgentState; parentId?: string; structuralPath?: readonly string[]; parentBreadcrumb?: string; worktreeOwner?: string; role?: string; requestedModel?: string; model: ModelSpec; tools: readonly string[]; attempts: number; attemptDetails?: readonly AgentAttemptSummary[]; accounting?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }; toolCalls?: readonly { id: string; name: string; state: "running" | "completed" | "failed" }[]; activity?: AgentActivity | undefined }
export interface WorkflowRunEvent { type: string; message: string }
export interface RunRecord { id: string; workflowName: string; cwd: string; sessionId: string; state: RunState; phase?: string; agents: readonly AgentRecord[]; error?: WorkflowErrorShape; budget?: WorkflowBudget; budgetVersion?: number; usage?: WorkflowBudgetUsage; budgetEvents?: readonly BudgetEvent[]; events?: readonly WorkflowRunEvent[] }
export const LAUNCH_SNAPSHOT_IDENTITY_VERSION = 3;
export interface LaunchSnapshot { identityVersion?: number; script: string; args: JsonValue; metadata: WorkflowMetadata; settings: WorkflowSettings; budget?: WorkflowBudget; settingsPath?: string; modelAliases?: Readonly<Record<string, string>>; models: readonly string[]; tools: readonly string[]; agentTypes: readonly string[]; roles?: Readonly<Record<string, AgentDefinition>>; projectRoles?: readonly string[]; schemas: readonly JsonSchema[] }
export interface PreflightCapabilities { models: ReadonlySet<string>; tools: ReadonlySet<string>; agentTypes: ReadonlySet<string>; modelAliases?: Readonly<Record<string, string>>; knownModels?: ReadonlySet<string>; settingsPath?: string; skipModelAvailability?: boolean }
export interface PreflightResult { metadata: WorkflowMetadata; referenced: { phases: readonly string[]; models: readonly string[]; tools: readonly string[]; agentTypes: readonly string[] }; schemas: readonly JsonSchema[]; dynamicAgentRoles: boolean }
export interface WorkflowOrchestrationContext {
  agent: (...args: readonly unknown[]) => Promise<JsonValue>;
  prompt: (template: string, values: Readonly<Record<string, JsonValue>>) => string;
  parallel: (...args: readonly unknown[]) => Promise<JsonValue>;
  pipeline: (...args: readonly unknown[]) => Promise<JsonValue>;
  withWorktree: (...args: readonly unknown[]) => Promise<JsonValue>;
  checkpoint: (...args: readonly unknown[]) => Promise<boolean>;
  phase: (name: string) => void;
  log: (message: string) => void;
}
export interface WorkflowRunContext { cwd: string; sessionId: string; runId: string; workflow: Readonly<WorkflowMetadata>; args: JsonValue; signal: AbortSignal }
export interface WorkflowFunctionContext extends WorkflowOrchestrationContext {
  run: Readonly<WorkflowRunContext>;
  invoke: (name: string, input: Readonly<Record<string, JsonValue>>) => Promise<JsonValue>;
}
export interface WorkflowFunction { description: string; input: JsonSchema; output: JsonSchema; run: (input: Readonly<Record<string, JsonValue>>, context: Readonly<WorkflowFunctionContext>) => Promise<JsonValue> | JsonValue }
export interface WorkflowVariable { description: string; schema: JsonSchema; resolve: (run: Readonly<WorkflowRunContext>) => Promise<JsonValue> | JsonValue }
export interface WorkflowScriptDefinition { description: string; script: string }
export interface WorkflowExtension { version: string; headline: string; description: string; functions?: Readonly<Record<string, WorkflowFunction>>; variables?: Readonly<Record<string, WorkflowVariable>>; workflows?: Readonly<Record<string, WorkflowScriptDefinition>>; agentSetupHooks?: Readonly<Record<string, AgentSetupHook>> }
export interface WorkflowJournal { get(path: string): JsonValue | undefined; put(path: string, value: JsonValue): void }

export class WorkflowError extends Error {
  constructor(public readonly code: WorkflowErrorCode, message: string) { super(message); this.name = "WorkflowError"; }
}

export interface WorkflowFailureAgent {
  id: string;
  label?: string;
  role?: string;
  structuralPath: readonly string[];
  attempt: number;
  sessionId?: string;
  sessionFile?: string;
}
export interface WorkflowFailureDiagnostics {
  runId: string;
  workflowName: string;
  state: RunState;
  failedAt: string | null;
  error: WorkflowErrorShape;
  failedAgent?: WorkflowFailureAgent;
  completedSiblingPaths: readonly (readonly string[])[];
  artifacts: { runDirectory: string; statePath: string; journalPath: string };
}

const WORKFLOW_FAILURE_DIAGNOSTICS = Symbol("workflowFailureDiagnostics");

const WORKFLOW_AUTHORED_ERROR = Symbol("workflowAuthoredError");
type WorkerErrorShape = WorkflowErrorShape & { authored?: boolean; failedAt?: string };

function errorText(error: unknown): string { return error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : error instanceof Error ? error.message : String(error); }
function errorCode(error: unknown): WorkflowErrorCode | undefined {
  if (error instanceof WorkflowError) return ERROR_CODES.includes(error.code) ? error.code : undefined;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && ERROR_CODES.includes(code as WorkflowErrorCode) ? code as WorkflowErrorCode : undefined;
}
function markWorkflowAuthored(error: WorkflowError, authored = false): WorkflowError {
  if (authored) Object.defineProperty(error, WORKFLOW_AUTHORED_ERROR, { value: true });
  return error;
}
function isWorkflowAuthored(error: unknown): boolean { return Boolean(error && typeof error === "object" && WORKFLOW_AUTHORED_ERROR in error); }
function workflowDetail(message: string): string {
  const detail = message.trim().replace(new RegExp(`\\b(?:${ERROR_CODES.join("|")})\\b:?\\s*`, "g"), "").replace(/^\s*[A-Z][A-Z0-9_]+:\s*/, "").split("\n").filter((line) => !/^\s*at\s/.test(line)).join("\n").replace(/^Run \S+(?=\s(?:exceeded|is))/i, "Run").replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "the workflow").replace(/^(?:Pi )session \S+(?=\s(?:is|has))/i, "session").replace(/^(Unknown scheduler run|Missing production ownership record|Persisted agent belongs to another run):\s*\S+/i, "$1").replace(/\b(?:runId|sessionId|callSite|occurrence|failedAt|id)[:=]\s*\S+/gi, "").replace(/\s{2,}/g, " ").trim();
  return detail || "No further details were provided";
}

const WORKFLOW_ERROR_PROSE: Record<WorkflowErrorCode, (detail: string) => string> = {
  CONFIG_ERROR: (detail) => `The workflow configuration is invalid: ${detail}.`,
  INVALID_SETTINGS: (detail) => `The workflow settings are invalid: ${detail}.`,
  INVALID_SYNTAX: (detail) => `The workflow source is invalid: ${detail}.`,
  INVALID_METADATA: (detail) => `The workflow metadata is invalid: ${detail}.`,
  DUPLICATE_NAME: (detail) => `The workflow contains a duplicate name: ${detail}.`,
  INVALID_SCHEMA: (detail) => `The workflow schema is invalid: ${detail}.`,
  REGISTRY_FROZEN: (detail) => `Workflow extension registration is closed: ${detail}.`,
  GLOBAL_COLLISION: (detail) => `The workflow global name is already in use: ${detail}.`,
  MISSING_WORKFLOW: (detail) => `The workflow primitive is unavailable: ${detail}.`,
  UNKNOWN_MODEL: (detail) => `The workflow requested the unavailable model ${detail.replace(/^(?:Unknown model(?: for role [^:]+)?|Invalid model spec):\s*/, "")}.`,
  UNKNOWN_TOOL: (detail) => `The workflow requested the unavailable tool ${detail.replace(/^Unknown tool:\s*/, "")}.`,
  UNKNOWN_AGENT_TYPE: (detail) => `The workflow requested the unavailable agent role ${detail.replace(/^Unknown agent role:\s*/, "")}.`,
  RUN_OWNED: (detail) => /already owned|active ownership/.test(detail) ? "The workflow session is already in use." : `The workflow session is already in use: ${detail}.`,
  RPC_LIMIT_EXCEEDED: (detail) => `The workflow communication data exceeded its size limit: ${detail}.`,
  AGENT_TIMEOUT: (detail) => `The workflow agent timed out: ${detail}.`,
  AGENT_FAILED: (detail) => `The workflow agent failed: ${detail}.`,
  RESULT_INVALID: (detail) => `The workflow produced an invalid result: ${detail}.`,
  CANCELLED: (detail) => `The workflow was cancelled: ${detail}.`,
  WORKER_UNRESPONSIVE: (detail) => `The workflow worker stopped responding: ${detail}.`,
  WORKTREE_FAILED: (detail) => `The workflow worktree operation failed: ${detail}.`,
  RESUME_INCOMPATIBLE: (detail) => `The workflow cannot resume this run: ${detail}.`,
  BUDGET_EXHAUSTED: (detail) => `The workflow budget was exhausted: ${detail}.`,
  INTERNAL_ERROR: (detail) => `The workflow encountered an internal error: ${detail}.`,
};
export function formatWorkflowFailure(error: unknown): string {
  if (isWorkflowAuthored(error)) return errorText(error);
  const code = errorCode(error);
  if (code) return WORKFLOW_ERROR_PROSE[code](workflowDetail(errorText(error)));
  if (error instanceof Error) return error.message || "The workflow failed without an error message.";
  return `The workflow failed with value ${String(error)}.`;
}
function workflowErrorFromWorker(error: WorkerErrorShape): WorkflowError {
  const code = errorCode(error);
  const typed = markWorkflowAuthored(new WorkflowError(code ?? "INTERNAL_ERROR", error.message), error.authored || !code);
  return error.failedAt === undefined ? typed : Object.assign(typed, { failedAt: error.failedAt });
}
function asWorkflowError(error: unknown): WorkflowError {
  const code = errorCode(error);
  return markWorkflowAuthored(error instanceof WorkflowError && code ? error : new WorkflowError(code ?? "INTERNAL_ERROR", errorText(error)), isWorkflowAuthored(error) || !code);
}
function mainAgentError(error: unknown): WorkflowError {
  const typed = asWorkflowError(error);
  const presented = new WorkflowError(typed.code, formatWorkflowFailure(typed));
  Object.assign(presented, typed);
  presented.message = formatWorkflowFailure(typed);
  return presented;
}

export class RunLifecycle {
  #state: RunState;
  #active = 0;
  #waiters: Array<() => void> = [];

  constructor(state: RunState = "running", private readonly changed?: (state: RunState, previousState: RunState, reason?: string) => void | Promise<void>) { this.#state = state; }
  get state(): RunState { return this.#state; }

  async enter(): Promise<void> {
    while (this.#state === "pausing" || this.#state === "paused" || this.#state === "awaiting_input") await new Promise<void>((resolve) => { this.#waiters.push(resolve); });
    if (this.#state !== "running") throw new WorkflowError("CANCELLED", `Run is ${this.#state}`);
    this.#active += 1;
  }

  async leave(): Promise<void> {
    if (this.#active > 0) this.#active -= 1;
    if (this.#state === "pausing" && this.#active === 0) await this.#set("paused", "pause");
  }

  async enterAwaitingInput(): Promise<void> {
    while (this.#state === "pausing" || this.#state === "paused") await new Promise<void>((resolve) => { this.#waiters.push(resolve); });
    if (this.#state === "awaiting_input") return;
    if (this.#state !== "running") throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot await input for ${this.#state} run`);
    await this.#set("awaiting_input", "awaiting_input");
  }

  async resolveAwaitingInput(): Promise<void> {
    if (this.#state !== "awaiting_input") return;
    await this.#set("running", "checkpoint_resolved");
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async pause(): Promise<void> {
    if (this.#state !== "running") throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot pause ${this.#state} run`);
    await this.#set("pausing", "pause");
    if (this.#active === 0) await this.#set("paused", "pause");
  }

  async resume(): Promise<void> {
    if (this.#state !== "paused" && this.#state !== "interrupted" && this.#state !== "budget_exhausted") throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot resume ${this.#state} run`);
    await this.#set("running", "resume");
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async providerPause(): Promise<void> {
    await this.leave();
    if (this.#state === "running") await this.pause();
    await this.enter();
  }

  async terminal(state: "completed" | "failed" | "stopped" | "interrupted" | "budget_exhausted", reason?: string): Promise<void> {
    if (["completed", "failed", "stopped"].includes(this.#state)) throw new WorkflowError("RESUME_INCOMPATIBLE", `${this.#state} runs are terminal`);
    await this.#set(state, reason ?? state);
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async #set(state: RunState, reason?: string): Promise<void> {
    const previousState = this.#state;
    this.#state = state;
    await this.changed?.(state, previousState, reason);
  }
}

export const DEFAULT_SETTINGS: Readonly<WorkflowSettings> = Object.freeze({ concurrency: 8 });

function fail(code: WorkflowErrorCode, message: string): never { throw new WorkflowError(code, message); }
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export { object as isObject };
function nonNegativeInteger(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 0; }
function nonNegativeFinite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
export function validateBudget(value: unknown): WorkflowBudget | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) fail("INVALID_METADATA", "budget must be an object");
  const result: WorkflowBudget = {};
  for (const [dimension, raw] of Object.entries(value)) {
    if (!["tokens", "costUsd", "durationMs", "agentLaunches"].includes(dimension)) fail("INVALID_METADATA", `Unknown budget dimension: ${dimension}`);
    if (!object(raw)) fail("INVALID_METADATA", `${dimension} budget must be an object`);
    if (Object.keys(raw).some((key) => key !== "soft" && key !== "hard")) fail("INVALID_METADATA", `${dimension} budget has an unknown limit`);
    const isCost = dimension === "costUsd";
    for (const key of ["soft", "hard"] as const) if (raw[key] !== undefined && !(isCost ? nonNegativeFinite(raw[key]) : nonNegativeInteger(raw[key]))) fail("INVALID_METADATA", `${dimension}.${key} must be a non-negative ${isCost ? "finite number" : "integer"}`);
    if (raw.soft !== undefined && raw.soft !== null && raw.hard !== undefined && raw.hard !== null && raw.soft >= raw.hard) fail("INVALID_METADATA", `${dimension}.soft must be less than hard`);
    const limits: BudgetLimits = {};
    if (raw.soft !== undefined) limits.soft = raw.soft as number;
    if (raw.hard !== undefined) limits.hard = raw.hard as number;
    if (Object.keys(limits).length) (result as Record<string, BudgetLimits>)[dimension] = limits;
  }
  return Object.freeze(result);
}
export function validateBudgetPatch(value: unknown): WorkflowBudgetPatch {
  if (!object(value)) fail("INVALID_METADATA", "budget patch must be an object");
  const result: WorkflowBudgetPatch = {};
  for (const [dimension, raw] of Object.entries(value)) {
    if (!["tokens", "costUsd", "durationMs", "agentLaunches"].includes(dimension)) fail("INVALID_METADATA", `Unknown budget dimension: ${dimension}`);
    if (raw === null) { (result as Record<string, null>)[dimension] = null; continue; }
    if (!object(raw) || Object.keys(raw).some((key) => key !== "soft" && key !== "hard")) fail("INVALID_METADATA", `${dimension} budget patch must contain only soft and hard`);
    const limits: { soft?: number | null; hard?: number | null } = {};
    for (const key of ["soft", "hard"] as const) if (Object.prototype.hasOwnProperty.call(raw, key)) {
      if (raw[key] === null) limits[key] = null;
      else { const checked = validateBudget({ [dimension]: { [key]: raw[key] } })?.[dimension as BudgetDimension]; if (checked?.[key] !== undefined) limits[key] = checked[key]; }
    }
    if (limits.soft !== null && limits.hard !== null && limits.soft !== undefined && limits.hard !== undefined && limits.soft >= limits.hard) fail("INVALID_METADATA", `${dimension}.soft must be less than hard`);
    (result as Record<string, { soft?: number | null; hard?: number | null }>)[dimension] = limits;
  }
  return result;
}
function budgetUsage(value?: Partial<WorkflowBudgetUsage>): WorkflowBudgetUsage { return { tokens: value?.tokens ?? 0, costUsd: value?.costUsd ?? 0, durationMs: value?.durationMs ?? 0, agentLaunches: value?.agentLaunches ?? 0 }; }
export class WorkflowBudgetRuntime {
  readonly #now: () => number;
  readonly #onChange: (() => void) | undefined;
  readonly #injected = new Set<string>();
  readonly #seen = new Set<string>();
  #active: boolean;
  #activeSince: number | undefined;
  #usage: WorkflowBudgetUsage;
  #events: BudgetEvent[];
  #turnAccounting?: { input: number; output: number; cost: number };
  constructor(readonly budget: WorkflowBudget | undefined, readonly version = 1, usage?: Partial<WorkflowBudgetUsage>, events: readonly BudgetEvent[] = [], options: { now?: () => number; onChange?: () => void; active?: boolean } = {}) {
    this.#now = options.now ?? (() => Date.now());
    this.#onChange = options.onChange;
    this.#active = options.active ?? true;
    this.#activeSince = this.#active ? this.#now() : undefined;
    this.#usage = budgetUsage(usage);
    this.#events = [...events];
    for (const event of events) if (event.budgetVersion === version) this.#seen.add(event.type);
  }
  get usage(): WorkflowBudgetUsage { this.#syncDuration(); return { ...this.#usage }; }
  get events(): readonly BudgetEvent[] { return this.#events; }
  get hardExhausted(): boolean { return this.#events.some((event) => event.type === "hard_exhausted" && event.budgetVersion === this.version); }
  checkAgentLaunch(): void { this.#checkHard(["agentLaunches"]); }
  beforeAttempt(): void { this.#checkHard(["agentLaunches"]); this.#usage.agentLaunches += 1; this.#evaluate(); }
  beforeTurn(): void { this.#syncDuration(); this.#evaluate(); this.#checkHard(["tokens", "costUsd", "durationMs"]); }
  afterTurn(accounting: AgentAccounting, final: boolean): void { this.#syncDuration(); this.#applyTurn(accounting, final, this.#turnAccounting); this.#turnAccounting = { input: accounting.input, output: accounting.output, cost: accounting.cost }; }
  #applyTurn(accounting: AgentAccounting, final: boolean, previous = { input: 0, output: 0, cost: 0 }): void {
    this.#usage.tokens += Math.max(0, accounting.input - previous.input) + Math.max(0, accounting.output - previous.output);
    this.#usage.costUsd += Math.max(0, accounting.cost - previous.cost);
    this.#evaluate();
    if (!final) this.#checkHard(["tokens", "costUsd", "durationMs"]);
  }
  instruction(agentId = "agent"): string | undefined {
    if (!this.#hasSoftCrossed() || this.#injected.has(agentId)) return undefined;
    this.#injected.add(agentId);
    return `The workflow budget soft limit has been reached. Finish the requested output now, preserving any required output schema. Current usage: ${JSON.stringify(this.usage)}. Do not start additional model work unless it is required to produce the final requested result.`;
  }
  forAgent(agentId: string): AgentBudgetHooks {
    let attempt = 0;
    let previous: { input: number; output: number; cost: number } | undefined;
    return {
      beforeAttempt: () => { attempt += 1; previous = undefined; this.beforeAttempt(); },
      beforeTurn: () => { this.beforeTurn(); },
      afterTurn: (accounting, final) => { this.#applyTurn(accounting, final, previous); previous = { input: accounting.input, output: accounting.output, cost: accounting.cost }; },
      instruction: () => this.instruction(`${agentId}:${String(attempt + 1)}`),
    };
  }
  transition(state: RunState): void {
    const active = state === "running";
    if (active === this.#active) return;
    if (active) { this.#active = true; this.#activeSince = this.#now(); }
    else { this.#syncDuration(); this.#evaluate(); this.#active = false; this.#activeSince = undefined; }
    this.#onChange?.();
  }
  #syncDuration(): void { if (this.#active && this.#activeSince !== undefined) { const now = this.#now(); this.#usage.durationMs += Math.max(0, now - this.#activeSince); this.#activeSince = now; } }
  #hasSoftCrossed(): boolean { return !!this.budget && (Object.entries(this.budget) as [BudgetDimension, BudgetLimits][]).some(([dimension, limits]) => limits.soft !== undefined && this.#usage[dimension] >= limits.soft); }
  #checkHard(dimensions: readonly BudgetDimension[]): void {
    const exhausted = dimensions.filter((dimension) => { const hard = this.budget?.[dimension]?.hard; return hard !== undefined && this.#usage[dimension] >= hard; });
    if (!exhausted.length) return;
    this.#record("hard_exhausted", exhausted);
    const detail = exhausted.map((dimension) => `${dimension} usage=${String(this.#usage[dimension])} hard=${String(this.budget?.[dimension]?.hard)}`).join(", ");
    throw new WorkflowError("BUDGET_EXHAUSTED", `Budget version ${String(this.version)} exhausted: ${detail}`);
  }
  #evaluate(): void {
    const budget = this.budget;
    if (!budget) return;
    const soft = (Object.keys(budget) as BudgetDimension[]).filter((dimension) => { const limits = budget[dimension]; return limits !== undefined && limits.soft !== undefined && this.#usage[dimension] >= limits.soft; });
    if (soft.length) this.#record("soft_crossed", soft);
    const overrun = (Object.keys(budget) as BudgetDimension[]).filter((dimension) => { const limits = budget[dimension]; return limits !== undefined && limits.hard !== undefined && this.#usage[dimension] > limits.hard; });
    if (overrun.length) this.#record("hard_overrun", overrun);
  }
  #record(type: BudgetEvent["type"], dimensions: readonly BudgetDimension[]): void { if (this.#seen.has(type)) return; this.#seen.add(type); this.#events.push({ type, budgetVersion: this.version, dimensions: [...dimensions], usage: this.usage, limits: structuredClone(this.budget ?? {}), at: this.#now() }); this.#onChange?.(); }
  recordEvent(event: BudgetEvent): void { this.#events.push(structuredClone(event)); }
  snapshot(): { usage: WorkflowBudgetUsage; budgetEvents: readonly BudgetEvent[] } { return { usage: this.usage, budgetEvents: [...this.#events] }; }
}
export function mergeBudget(budget: WorkflowBudget | undefined, patch: WorkflowBudgetPatch): WorkflowBudget | undefined {
  const merged: WorkflowBudget = structuredClone(budget ?? {});
  for (const dimension of ["tokens", "costUsd", "durationMs", "agentLaunches"] as const) if (Object.prototype.hasOwnProperty.call(patch, dimension)) {
    const value = patch[dimension];
    if (value === null) { Reflect.deleteProperty(merged, dimension); continue; }
    const next: BudgetLimits = { ...(merged[dimension] ?? {}) };
    for (const key of ["soft", "hard"] as const) if (value && Object.prototype.hasOwnProperty.call(value, key)) { const limit = value[key]; if (limit === null) Reflect.deleteProperty(next, key); else if (limit !== undefined) next[key] = limit; }
    if (Object.keys(next).length) (merged as Record<string, BudgetLimits>)[dimension] = next; else Reflect.deleteProperty(merged, dimension);
  }
  return validateBudget(merged);
}
export function budgetRelaxed(previous: WorkflowBudget | undefined, next: WorkflowBudget | undefined): boolean { for (const dimension of ["tokens", "costUsd", "durationMs", "agentLaunches"] as const) { const oldLimit = previous?.[dimension]; const newLimit = next?.[dimension]; for (const key of ["soft", "hard"] as const) if ((oldLimit?.[key] !== undefined && newLimit?.[key] === undefined) || (oldLimit?.[key] !== undefined && newLimit?.[key] !== undefined && newLimit[key] > oldLimit[key])) return true; } return false; }
export function exhaustedBudgetDimensions(budget: WorkflowBudget | undefined, usage: WorkflowBudgetUsage): BudgetDimension[] {
  if (!budget) return [];
  return (Object.keys(budget) as BudgetDimension[]).filter((dimension) => { const limits = budget[dimension]; return limits !== undefined && limits.hard !== undefined && usage[dimension] >= limits.hard; });
}
export function resumeBudgetAllowed(budget: WorkflowBudget | undefined, usage: WorkflowBudgetUsage): boolean { return exhaustedBudgetDimensions(budget, usage).length === 0; }
function positiveInteger(value: unknown): value is number { return Number.isInteger(value) && (value as number) > 0; }
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const MODEL_ALIAS_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
export function parseModelReference(value: string): ModelSpec {
  const match = /^([^/:\s]+)\/([^:\s]+)(?::([^:\s]+))?$/.exec(value);
  if (!match?.[1] || !match[2]) fail("UNKNOWN_MODEL", `Invalid model spec: ${value}`);
  const thinking = match[3];
  if (thinking && !THINKING_LEVELS.includes(thinking as (typeof THINKING_LEVELS)[number])) fail("UNKNOWN_MODEL", `Invalid thinking level: ${thinking}`);
  return { provider: match[1], model: match[2], ...(thinking ? { thinking: thinking as NonNullable<ModelSpec["thinking"]> } : {}) };
}

function aliasError(message: string, settingsPath: string): never { fail("CONFIG_ERROR", `${message} (settings: ${settingsPath})`); }
export function validateModelAliases(value: unknown, settingsPath = "workflow settings"): Readonly<Record<string, string>> {
  if (!object(value)) aliasError("modelAliases must be an object", settingsPath);
  const aliases: Record<string, string> = {};
  for (const [name, target] of Object.entries(value)) {
    if (!MODEL_ALIAS_NAME.test(name)) aliasError(`Invalid model alias name: ${name}`, settingsPath);
    if (typeof target !== "string" || !target.trim()) aliasError(`Invalid model alias target for ${name}`, settingsPath);
    try { parseModelReference(target); } catch (error) { aliasError(`Invalid model alias target for ${name}: ${errorText(error)}`, settingsPath); }
    aliases[name] = target;
  }
  return Object.freeze(aliases);
}

function unknownModel(value: string, target: string | undefined, settingsPath?: string): never {
  const resolved = target ? ` resolved to ${target}` : "";
  const path = settingsPath ? ` (settings: ${settingsPath})` : "";
  fail("UNKNOWN_MODEL", `Unknown model${target ? " alias" : ""} ${value}${resolved}${path}`);
}

export function resolveModelReference(value: string, aliases: Readonly<Record<string, string>> = {}, knownModels?: ReadonlySet<string>, settingsPath?: string): ModelSpec {
  const target = Object.prototype.hasOwnProperty.call(aliases, value) ? aliases[value] : undefined;
  if (target !== undefined) {
    try { return parseModelReference(target); } catch { unknownModel(value, target, settingsPath); }
  }
  if (value.includes("/")) return parseModelReference(value);
  const match = /^([^:\s]+)(?::([^:\s]+))?$/.exec(value);
  const thinking = match?.[2];
  if (!match?.[1] || thinking && !THINKING_LEVELS.includes(thinking as (typeof THINKING_LEVELS)[number])) unknownModel(value, undefined, settingsPath);
  const candidates = [...(knownModels ?? [])].filter((model) => model.slice(model.indexOf("/") + 1) === match[1]);
  if (candidates.length === 1) {
    const parsed = parseModelReference(candidates[0] as string);
    return thinking ? { ...parsed, thinking: thinking as NonNullable<ModelSpec["thinking"]> } : parsed;
  }
  unknownModel(value, undefined, settingsPath);
}

function modelCapability(value: string, aliases?: Readonly<Record<string, string>>, knownModels?: ReadonlySet<string>, settingsPath?: string): string {
  const parsed = resolveModelReference(value, aliases, knownModels, settingsPath);
  return `${parsed.provider}/${parsed.model}`;
}

function aliasDrift(previous: Readonly<Record<string, string>>, current: Readonly<Record<string, string>>): string[] {
  return [...new Set([...Object.keys(previous), ...Object.keys(current)])].sort().flatMap((name) => previous[name] === current[name] ? [] : [`${name}: ${previous[name] ?? "(missing)"} -> ${current[name] ?? "(missing)"}`]);
}

export interface CheckpointInput { name: string; prompt: string; context: JsonValue }
export function validateCheckpoint(value: unknown): CheckpointInput {
  if (!object(value) || Object.keys(value).some((key) => !["name", "prompt", "context"].includes(key)) || typeof value.name !== "string" || value.name.trim() === "" || typeof value.prompt !== "string" || !jsonValue(value.context)) fail("INVALID_METADATA", "checkpoint requires only name, prompt, and JSON context");
  if (Buffer.byteLength(value.prompt) > 1024) fail("INVALID_METADATA", "checkpoint prompt exceeds 1024 UTF-8 bytes");
  if (Buffer.byteLength(JSON.stringify(value.context)) > 4096) fail("INVALID_METADATA", "checkpoint context exceeds 4096 UTF-8 bytes");
  return { name: value.name, prompt: value.prompt, context: value.context };
}

export function workflowSettingsPath(agentDir = getAgentDir()): string { return join(agentDir, ROLE_DIRECTORY, "settings.json"); }
export function workflowProjectSettingsPath(cwd: string): string { return join(cwd, ".pi", ROLE_DIRECTORY, "settings.json"); }
const EMPTY_AGENT_RESOURCE_EXCLUSIONS: AgentResourceExclusions = Object.freeze({ skills: [], extensions: [] });
function normalizedResourcePath(value: string, settingsPath: string): string {
  let expanded = value === "~" ? homedir() : value.startsWith("~/") || value.startsWith("~\\") ? join(homedir(), value.slice(2)) : value;
  if (expanded.startsWith("file://")) expanded = fileURLToPath(expanded);
  const resolved = resolve(dirname(settingsPath), expanded);
  try { return realpathSync(resolved); } catch { return resolved; }
}
export function mergeAgentResourceExclusions(...values: (AgentResourceExclusions | undefined)[]): AgentResourceExclusions {
  return { skills: [...new Set(values.flatMap((value) => value?.skills ?? []))], extensions: [...new Set(values.flatMap((value) => value?.extensions ?? []))] };
}
function validateAgentResourceExclusions(value: unknown, settingsPath: string, errorCode: "INVALID_SETTINGS" | "INVALID_METADATA" = "INVALID_SETTINGS"): AgentResourceExclusions | undefined {
  if (value === undefined) return undefined;
  const base = `${settingsPath}.disabledAgentResources`;
  if (!object(value)) fail(errorCode, `${base} must be an object`);
  for (const key of Object.keys(value)) if (key !== "skills" && key !== "extensions") fail(errorCode, `${base}.${key} is not supported`);
  const normalized: { skills: string[]; extensions: string[] } = { skills: [], extensions: [] };
  for (const kind of ["skills", "extensions"] as const) {
    const entries = value[kind];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) fail(errorCode, `${base}.${kind} must be an array`);
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (typeof entry !== "string" || !entry.trim()) fail(errorCode, `${base}.${kind}[${String(index)}] must be a non-empty string`);
      let selector = entry.trim();
      if (kind === "extensions") {
        try { selector = normalizedResourcePath(selector, settingsPath); } catch (error) { fail(errorCode, `${base}.${kind}[${String(index)}] must be a valid path: ${errorText(error)}`); }
      }
      if (!seen.has(selector)) { seen.add(selector); normalized[kind].push(selector); }
    }
  }
  return Object.freeze({ skills: Object.freeze(normalized.skills), extensions: Object.freeze(normalized.extensions) });
}
export function loadSettings(path = workflowSettingsPath()): Readonly<WorkflowSettings> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SETTINGS;
    fail("CONFIG_ERROR", `Invalid workflow settings JSON at ${path}: ${errorText(error)}`);
  }
  if (!object(parsed)) fail("INVALID_SETTINGS", `Workflow settings at ${path} must be an object`);
  const allowed = new Set(["concurrency", "modelAliases", "disabledAgentResources"]);
  const unknown = Object.keys(parsed).find((key) => !allowed.has(key));
  if (unknown) fail("INVALID_SETTINGS", `Unknown workflow setting at ${path}: ${unknown}`);
  const concurrency = parsed.concurrency === undefined ? DEFAULT_SETTINGS.concurrency : parsed.concurrency;
  if (!positiveInteger(concurrency) || concurrency > 16) fail("INVALID_SETTINGS", `${path}.concurrency must be an integer from 1 to 16`);
  const modelAliases = parsed.modelAliases === undefined ? undefined : validateModelAliases(parsed.modelAliases, path);
  const disabledAgentResources = validateAgentResourceExclusions(parsed.disabledAgentResources, path);
  return Object.freeze({ concurrency, ...(modelAliases ? { modelAliases } : {}), ...(disabledAgentResources ? { disabledAgentResources } : {}) });
}
export function resolveAgentResourcePolicy(cwd: string, projectTrusted: boolean, globalSettingsPath = workflowSettingsPath()): AgentResourcePolicy {
  const projectSettingsPath = workflowProjectSettingsPath(cwd);
  const global = loadSettings(globalSettingsPath).disabledAgentResources ?? EMPTY_AGENT_RESOURCE_EXCLUSIONS;
  const project = projectTrusted ? loadSettings(projectSettingsPath).disabledAgentResources ?? EMPTY_AGENT_RESOURCE_EXCLUSIONS : EMPTY_AGENT_RESOURCE_EXCLUSIONS;
  const effective = mergeAgentResourceExclusions(global, project);
  return { globalSettingsPath, projectSettingsPath, projectTrusted, global, project, effective, unmatchedSkills: [], unmatchedExtensions: [] };
}
export function saveModelAliases(path = workflowSettingsPath(), aliases: Readonly<Record<string, string>> = {}): void {
  const normalized = validateModelAliases(aliases, path);
  let parsed: Record<string, unknown> = {};
  try {
    loadSettings(path);
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, `${JSON.stringify({ ...parsed, modelAliases: normalized }, null, 2)}\n`, true);
}

export function parseRoleMarkdown(content: string, strict = false, rolePath?: string): AgentDefinition {
  if (!strict) {
    if (!content.startsWith("---\n")) return { prompt: content };
    const end = content.indexOf("\n---", 4);
    if (end < 0) return { prompt: content };
    const meta: Record<string, string> = {};
    for (const line of content.slice(4, end).split("\n")) {
      const match = /^(model|thinking|tools|description)\s*:\s*(.+)$/.exec(line.trim());
      if (match?.[1] && match[2]) meta[match[1]] = match[2].trim();
    }
    const tools = meta.tools ? meta.tools.replace(/^\[|\]$/g, "").split(",").map((tool) => tool.trim().replace(/^[']|[']$/g, "").replace(/^["]|["]$/g, "")).filter(Boolean) : undefined;
    const thinking = meta.thinking?.replace(/^[']|[']$/g, "").replace(/^["]|["]$/g, "");
    if (thinking && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) fail("INVALID_METADATA", `Invalid role thinking level: ${thinking}`);
    const definition: AgentDefinition = { prompt: content.slice(end + 4).replace(/^\n/, "") };
    if (meta.model) definition.model = meta.model.replace(/^[']|[']$/g, "").replace(/^["]|["]$/g, "");
    if (meta.description) definition.description = meta.description.replace(/^[']|[']$/g, "").replace(/^["]|["]$/g, "");
    if (thinking) definition.thinking = thinking as NonNullable<AgentDefinition["thinking"]>;
    if (tools) definition.tools = tools;
    return definition;
  }
  const normalized = content.replace(/\r\n?/g, "\n");
  if (normalized.startsWith("---\n") && normalized.indexOf("\n---", 3) < 0) fail("INVALID_METADATA", "Role frontmatter is missing its closing delimiter");
  let parsed: ReturnType<typeof parseFrontmatter>;
  try { parsed = parseFrontmatter(content); }
  catch (error) { fail("INVALID_METADATA", `Invalid role frontmatter: ${errorText(error)}`); }
  if (!object(parsed.frontmatter)) fail("INVALID_METADATA", "Role frontmatter must be an object");
  const { model, thinking, tools, description, disabledAgentResources } = parsed.frontmatter;
  if (model !== undefined && (typeof model !== "string" || model.trim() === "")) fail("INVALID_METADATA", "Role model must be a non-empty string");
  if (thinking !== undefined && (typeof thinking !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking))) fail("INVALID_METADATA", `Invalid role thinking level: ${typeof thinking === "string" ? thinking : typeof thinking}`);
  if (description !== undefined && (typeof description !== "string" || description.trim() === "" || description.length > 1024 || /[\r\n]/.test(description))) fail("INVALID_METADATA", "Role description must be a non-empty single-line string of at most 1024 characters");
  if (tools !== undefined && (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || tool.trim() === ""))) fail("INVALID_METADATA", "Role tools must be an array of non-empty strings");
  const normalizedResources = validateAgentResourceExclusions(disabledAgentResources, rolePath ?? "<role>", "INVALID_METADATA");
  return { prompt: parsed.body, ...(typeof description === "string" ? { description: description.trim() } : {}), ...(typeof model === "string" ? { model: model.trim() } : {}), ...(typeof thinking === "string" ? { thinking: thinking as NonNullable<AgentDefinition["thinking"]> } : {}), ...(Array.isArray(tools) ? { tools: tools.map((tool) => (tool as string).trim()) } : {}), ...(normalizedResources ? { disabledAgentResources: normalizedResources } : {}) };
}

const ROLE_DIRECTORY = "pi-extensible-workflows";

export function workflowRoleDirectories(agentDir = getAgentDir()): readonly string[] {
  return [join(agentDir, ROLE_DIRECTORY, "roles")];
}

function projectRoleDirectories(root: string): readonly string[] {
  return [join(root, ROLE_DIRECTORY, "roles")];
}

function readAgentDefinitions(dir: string): Record<string, AgentDefinition> {
  try {
    return Object.fromEntries(readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name) === ".md")
      .map((entry) => { const path = join(dir, entry.name); return [basename(entry.name, ".md"), parseRoleMarkdown(readFileSync(path, "utf8"), true, path)]; }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function readRoleDefinitions(dirs: readonly string[]): Record<string, AgentDefinition> {
  return Object.fromEntries(dirs.flatMap((dir) => Object.entries(readAgentDefinitions(dir))));
}

export function loadAgentDefinitions(cwd: string, agentDir = getAgentDir(), projectTrusted = true): Readonly<Record<string, AgentDefinition>> {
  return deepFreeze({ ...readRoleDefinitions(workflowRoleDirectories(agentDir)), ...(projectTrusted ? readRoleDefinitions(projectRoleDirectories(join(cwd, ".pi"))) : {}) });
}
function validateRolePolicies(definitions: Readonly<Record<string, AgentDefinition>>, roles: readonly string[], availableModels: ReadonlySet<string>, rootTools: ReadonlySet<string>, aliases: Readonly<Record<string, string>> = {}, knownModels = availableModels, settingsPath?: string): void {
  for (const role of roles) {
    const definition = definitions[role];
    if (!definition) continue;
    if (definition.model !== undefined) {
      const resolved = modelCapability(definition.model, aliases, knownModels, settingsPath);
      if (!availableModels.has(resolved)) {
        if (Object.prototype.hasOwnProperty.call(aliases, definition.model)) unknownModel(definition.model, resolved, settingsPath);
        fail("UNKNOWN_MODEL", `Unknown model for role ${role}: ${resolved}`);
      }
    }
    const missingTool = (definition.tools ?? [...rootTools]).find((tool) => !rootTools.has(tool));
    if (missingTool) fail("UNKNOWN_TOOL", `Unknown tool for role ${role}: ${missingTool}`);
  }
}

function validateWorkflowMetadata(value: unknown): WorkflowMetadata {
  if (!object(value) || typeof value.name !== "string" || value.name.trim() === "") fail("INVALID_METADATA", "Workflow metadata requires a non-empty name");
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.trim() === "")) fail("INVALID_METADATA", "Workflow description must be a non-empty string when provided");
  if (Object.keys(value).some((key) => !["name", "description"].includes(key))) fail("INVALID_METADATA", "Unknown workflow metadata");
  return Object.freeze({ name: value.name.trim(), ...(typeof value.description === "string" ? { description: value.description.trim() } : {}) });
}

function workflowBody(script: string): string {
  if (typeof script !== "string" || script.trim() === "") fail("INVALID_SYNTAX", "Workflow script must be non-empty");
  try {
    const program = acorn.parse(script, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true });
    const first = program.body[0];
    if (first?.type === "ExportNamedDeclaration" && first.declaration?.type === "VariableDeclaration") {
      const declarator = first.declaration.declarations[0];
      if (declarator?.id.type === "Identifier" && declarator.id.name === "meta") return script.slice(first.end).replace(/^\s*/, "");
    }
    return script;
  } catch (error) { fail("INVALID_SYNTAX", `Invalid workflow syntax: ${errorText(error)}`); }
}

function parseWorkflow(script: string): acorn.Program {
  const body = workflowBody(script);
  try {
    new Script(`(async()=>{${body}\n})`);
    return acorn.parse(body, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true });
  } catch (error) { fail("INVALID_SYNTAX", `Invalid workflow syntax: ${errorText(error)}`); }
}

type WorkflowCall = acorn.CallExpression & { callee: acorn.Identifier };

function astNode(value: unknown): value is acorn.AnyNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}
function astChildren(node: acorn.AnyNode): acorn.AnyNode[] {
  const children: acorn.AnyNode[] = [];
  for (const value of Object.values(node) as unknown[]) {
    if (Array.isArray(value)) {
      for (const child of value) if (astNode(child)) children.push(child);
    } else if (astNode(value)) children.push(value);
  }
  return children;
}
function workflowCallKind(node: acorn.AnyNode): WorkflowCallKind | undefined {
  if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return undefined;
  const kind = node.callee.name as WorkflowCallKind;
  return WORKFLOW_CALL_KINDS.includes(kind) ? kind : undefined;
}
function workflowCalls(program: acorn.Program): WorkflowCall[] {
  const calls: WorkflowCall[] = [];
  const visit = (node: acorn.AnyNode): void => {
    if (workflowCallKind(node)) calls.push(node as WorkflowCall);
    for (const child of astChildren(node)) visit(child);
  };
  visit(program);
  return calls.sort((left, right) => left.start - right.start);
}
export type StaticWorkflowExecution = "parallel" | "sequential";
export interface StaticWorkflowScope { kind: "parallel" | "pipeline"; name: string | null; key: string | null }
type StaticWorkflowContext = { execution: StaticWorkflowExecution; structure: readonly StaticWorkflowScope[] };
function workflowCallsWithStructure(program: acorn.Program): Array<{ call: WorkflowCall; execution: StaticWorkflowExecution; structure: readonly StaticWorkflowScope[] }> {
  const calls: Array<{ call: WorkflowCall; execution: StaticWorkflowExecution; structure: readonly StaticWorkflowScope[] }> = [];
  const visit = (node: acorn.AnyNode, context: StaticWorkflowContext): void => {
    let current = context;
    if (node.type === "Property" && current.structure.length) {
      const scope = current.structure.at(-1);
      const key = node.key.type === "Identifier" ? node.key.name : node.key.type === "Literal" ? String(node.key.value) : undefined;
      if (scope?.key === null && key) current = { ...current, structure: [...current.structure.slice(0, -1), { ...scope, key }] };
    }
    const operation = workflowCallKind(node);
    if (operation) {
      const call = node as WorkflowCall;
      const execution = operation === "parallel" ? "parallel" : operation === "pipeline" ? "sequential" : current.execution;
      calls.push({ call, execution, structure: current.structure });
      for (const [index, argument] of call.arguments.entries()) {
        if (argument.type === "SpreadElement") continue;
        const scopeKind = operation === "parallel" && index === 1 ? "parallel" : operation === "pipeline" && index === 2 ? "pipeline" : undefined;
        visit(argument, scopeKind ? { execution, structure: [...current.structure, { kind: scopeKind, name: staticString(callArgument(call, 0)), key: null }] } : current);
      }
      return;
    }
    for (const child of astChildren(node)) visit(child, current);
  };
  visit(program, { execution: "sequential", structure: [] });
  return calls.sort((left, right) => left.call.start - right.call.start);
}
function validateDirectPrimitiveReferences(program: acorn.AnyNode, name: string): void {
  const visit = (node: acorn.AnyNode, parent?: acorn.AnyNode): void => {
    if (node.type === "Identifier" && node.name === name) {
      const directCall = parent?.type === "CallExpression" && parent.callee === node;
      const propertyKey = parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand;
      if (!directCall && !propertyKey) fail("INVALID_METADATA", `${name} calls must use a direct ${name}(...) call; aliases and indirect calls are unsupported`);
    }
    for (const child of astChildren(node)) visit(child, node);
  };
  visit(program);
}
function hasIdentifier(node: acorn.AnyNode, name: string): boolean {
  if (node.type === "Identifier" && node.name === name) return true;
  return astChildren(node).some((child) => hasIdentifier(child, name));
}

const INTERNAL_AGENT_NAME = "__pi_extensible_workflows_agent";
const INTERNAL_CONVERSATION_NAME = "__pi_extensible_workflows_conversation";
const INTERNAL_WORKTREE_NAME = "__pi_extensible_workflows_withWorktree";

function callHasTrailingComma(source: string, call: WorkflowCall): boolean {
  let previous: acorn.Token | undefined;
  let current: acorn.Token | undefined;
  for (const token of acorn.tokenizer(source.slice(call.start, call.end), { ecmaVersion: "latest", sourceType: "module" })) {
    previous = current;
    current = token;
  }
  return current?.type.label === ")" && previous?.type.label === ",";
}

function instrumentWorkflow(script: string): string {
  const body = workflowBody(script);
  if (!body.trim()) return body;
  const program = parseWorkflow(body);
  if (hasIdentifier(program, INTERNAL_AGENT_NAME)) fail("INVALID_METADATA", `${INTERNAL_AGENT_NAME} is reserved for workflow agent instrumentation`);
  if (hasIdentifier(program, INTERNAL_CONVERSATION_NAME)) fail("INVALID_METADATA", `${INTERNAL_CONVERSATION_NAME} is reserved for workflow conversation instrumentation`);
  if (hasIdentifier(program, INTERNAL_WORKTREE_NAME)) fail("INVALID_METADATA", `${INTERNAL_WORKTREE_NAME} is reserved for workflow withWorktree instrumentation`);
  const calls = workflowCalls(program).filter((call) => ["agent", "conversation", "withWorktree"].includes(call.callee.name));
  const edits = calls.flatMap((call) => {
    const callSite = `${String(call.start)}:${String(call.end)}`;
    const hiddenArgument = call.arguments.length === 0 || callHasTrailingComma(body, call) ? "" : ", ";
    return [
      { start: call.callee.start, end: call.callee.end, text: call.callee.name === "agent" ? INTERNAL_AGENT_NAME : call.callee.name === "conversation" ? INTERNAL_CONVERSATION_NAME : INTERNAL_WORKTREE_NAME },
      { start: call.end - 1, end: call.end - 1, text: `${hiddenArgument}${JSON.stringify(callSite)}` },
    ];
  }).sort((left, right) => right.start - left.start);
  let instrumented = body;
  for (const edit of edits) instrumented = instrumented.slice(0, edit.start) + edit.text + instrumented.slice(edit.end);
  return instrumented;
}

function literalString(node: acorn.AnyNode | undefined): string | undefined {
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function propertyNode(node: acorn.AnyNode | undefined, name: string): acorn.AnyNode | undefined {
  if (node?.type !== "ObjectExpression") return undefined;
  for (let index = node.properties.length - 1; index >= 0; index -= 1) {
    const property = node.properties[index];
    if (!property || property.type === "SpreadElement" || property.computed) return undefined;
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
    if (key === name) return property.value;
  }
  return undefined;
}

function stableName(node: acorn.AnyNode | undefined): boolean | undefined {
  if (!node) return false;
  if (node.type !== "ObjectExpression") {
    if (["Literal", "ArrayExpression", "ArrowFunctionExpression", "FunctionExpression", "ClassExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "BinaryExpression"].includes(node.type)) return false;
    return undefined;
  }
  let result: boolean | undefined = false;
  for (const property of node.properties) {
    if (property.type === "SpreadElement" || property.computed) { result = undefined; continue; }
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
    if (key !== "name") continue;
    const value = literalString(property.value);
    result = value === undefined ? property.value.type === "Literal" ? false : undefined : value.trim() !== "";
  }
  return result;
}


function jsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  seen.add(value);
  const values = Array.isArray(value) ? Array.from(value) : keys.map((key) => (value as Record<string, unknown>)[key as string]);
  const valid = values.every((item) => jsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function workflowPrompt(template: string, values: Readonly<Record<string, JsonValue>>): string {
  if (typeof template !== "string") fail("INVALID_METADATA", "prompt() template must be a string");
  if (!object(values) || Array.isArray(values) || !jsonValue(values)) fail("INVALID_METADATA", "prompt() values must be a plain JSON-compatible object");
  const placeholders = [...template.matchAll(/{{|}}|{([A-Za-z_$][\w$]*)}/g)].flatMap((match) => match[1] === undefined ? [] : [match[1]]);
  const used = new Set(placeholders);
  const keys = Object.keys(values);
  const missing = placeholders.find((key) => !Object.prototype.hasOwnProperty.call(values, key));
  if (missing) fail("INVALID_METADATA", `Missing prompt value "${missing}"`);
  const unused = keys.find((key) => !used.has(key));
  if (unused !== undefined) fail("INVALID_METADATA", `Unused prompt value "${unused}"`);
  return template.replace(/{{|}}|{([A-Za-z_$][\w$]*)}/g, (match, key: string | undefined) => match === "{{" ? "{" : match === "}}" ? "}" : typeof values[key as string] === "string" ? values[key as string] as string : JSON.stringify(values[key as string], null, 2));
}

function validateSchema(schema: unknown, at = "schema"): asserts schema is JsonSchema {
  if (!object(schema) || Object.getPrototypeOf(schema) !== Object.prototype || !jsonValue(schema)) fail("INVALID_SCHEMA", `${at} must be a plain JSON-compatible Schema object`);
  if (typeof schema.type !== "string" && !Array.isArray(schema.type) && schema.$ref === undefined && schema.anyOf === undefined && schema.oneOf === undefined && schema.allOf === undefined && schema.const === undefined && schema.enum === undefined) fail("INVALID_SCHEMA", `${at} has no JSON Schema shape`);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) fail("INVALID_SCHEMA", `${at}.required must be an array of strings`);
  if (schema.properties !== undefined && !object(schema.properties)) fail("INVALID_SCHEMA", `${at}.properties must be an object`);
}

const AGENT_OPTION_KEYS = new Set(["label", "model", "thinking", "tools", "role", "outputSchema", "retries", "timeoutMs"]);
function validateAgentOption(key: string, value: unknown, aliases?: Readonly<Record<string, string>>, knownModels?: ReadonlySet<string>, settingsPath?: string): void {
  switch (key) {
    case "label":
      if (typeof value !== "string" || !value.trim()) fail("INVALID_METADATA", "agent label must be a non-empty string");
      break;
    case "model":
      if (typeof value !== "string" || !value.trim()) fail("INVALID_METADATA", "agent model must be a non-empty string");
      if (aliases !== undefined) resolveModelReference(value, aliases, knownModels, settingsPath);
      break;
    case "thinking":
      if (typeof value !== "string" || !parseThinking(value)) fail("INVALID_METADATA", "agent thinking must be off, minimal, low, medium, high, xhigh, or max");
      break;
    case "tools":
      if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string")) fail("INVALID_METADATA", "agent tools must be an array of strings");
      break;
    case "role":
      if (typeof value !== "string" || !value.trim()) fail("INVALID_METADATA", "agent role must be a non-empty string");
      break;
    case "outputSchema":
      validateSchema(value, "agent outputSchema");
      break;
    case "retries":
      if (!Number.isInteger(value) || (value as number) < 0) fail("INVALID_METADATA", "agent retries must be a non-negative integer");
      break;
    case "timeoutMs":
      if (value !== null && !positiveInteger(value)) fail("INVALID_METADATA", "agent timeoutMs must be null or a positive integer");
      break;
  }
}
function validateAgentOptions(value: unknown): Readonly<Record<string, JsonValue>> {
  if (!object(value) || !jsonValue(value)) fail("INVALID_METADATA", "agent options must be a JSON object");
  for (const [key, option] of Object.entries(value)) if (AGENT_OPTION_KEYS.has(key)) validateAgentOption(key, option);
  if (typeof value.role === "string" && ["model", "thinking", "tools"].some((key) => Object.prototype.hasOwnProperty.call(value, key))) fail("INVALID_METADATA", "Role agents must not specify model, thinking, or tools");
  return value;
}

type StaticValue = { known: true; value: unknown } | { known: false };

function staticValue(node: acorn.AnyNode | undefined): StaticValue {
  if (!node) return { known: false };
  if (node.type === "Literal") return { known: true, value: node.value };
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    const argument = staticValue(node.argument);
    return argument.known && typeof argument.value === "number" ? { known: true, value: node.operator === "-" ? -argument.value : argument.value } : { known: false };
  }
  if (node.type === "ArrayExpression") {
    const values: unknown[] = [];
    for (const element of node.elements) {
      if (!element || element.type === "SpreadElement") return { known: false };
      const value = staticValue(element);
      if (!value.known) return { known: false };
      values.push(value.value);
    }
    return { known: true, value: values };
  }
  if (node.type === "ObjectExpression") {
    const value: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (property.type === "SpreadElement" || property.computed) return { known: false };
      const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
      const child = staticValue(property.value);
      if (!key || !child.known) return { known: false };
      value[key] = child.value;
    }
    return { known: true, value };
  }
  return { known: false };
}

export interface StaticWorkflowCall {
  kind: WorkflowCallKind;
  start: number;
  end: number;
  name: string | null;
  prompt: string | null;
  model: string | null;
  label?: string | null;
  role: string | null;
  retries?: number | null;
  outputSchema?: JsonSchema | null;
  options?: Readonly<Record<string, JsonValue>> | null;
  optionKeys?: readonly string[];
  execution?: StaticWorkflowExecution;
  structure?: readonly StaticWorkflowScope[];
}

function callArgument(call: WorkflowCall, index: number): acorn.AnyNode | undefined {
  const argument = call.arguments[index];
  return argument?.type === "SpreadElement" ? undefined : argument;
}

function staticString(node: acorn.AnyNode | undefined): string | null {
  const value = staticValue(node);
  return value.known && typeof value.value === "string" ? value.value : null;
}

export function inspectWorkflowScript(script: string): StaticWorkflowCall[] {
  return workflowCallsWithStructure(parseWorkflow(script)).map(({ call, execution, structure }) => {
    const kind = call.callee.name as StaticWorkflowCall["kind"];
    const first = callArgument(call, 0);
    const options = callArgument(call, 1);
    const placement = { execution, structure };
    if (kind === "agent" || kind === "conversation") {
      const retries = staticValue(propertyNode(options, "retries"));
      const outputSchema = staticValue(propertyNode(options, "outputSchema"));
      const optionKeys = options?.type === "ObjectExpression" ? options.properties.flatMap((property) => {
        if (property.type === "SpreadElement" || property.computed) return [];
        const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
        return key ? [key] : [];
      }) : [];
      const knownOptions = Object.fromEntries(optionKeys.flatMap((key) => { const value = staticValue(propertyNode(options, key)); return value.known && jsonValue(value.value) ? [[key, value.value]] : []; })) as Record<string, JsonValue>;
      const base = { ...placement, kind, start: call.start, end: call.end, name: kind === "conversation" ? staticString(first) : null, prompt: kind === "conversation" ? null : staticString(first), model: staticString(propertyNode(options, "model")), label: staticString(propertyNode(options, "label")), role: staticString(propertyNode(options, "role")) };
      return { ...base, ...(retries.known && typeof retries.value === "number" ? { retries: retries.value } : {}), ...(outputSchema.known && object(outputSchema.value) ? { outputSchema: outputSchema.value as JsonSchema } : {}), ...(optionKeys.length ? { options: knownOptions, optionKeys } : {}) };
    }
    if (kind === "checkpoint") return { ...placement, kind, start: call.start, end: call.end, name: staticString(propertyNode(first, "name")), prompt: staticString(propertyNode(first, "prompt")), model: null, role: null };
    return { ...placement, kind, start: call.start, end: call.end, name: staticString(first), prompt: null, model: null, role: null };
  });
}

function validateStaticAgentOptions(node: acorn.AnyNode | undefined, aliases: Readonly<Record<string, string>> = {}, knownModels?: ReadonlySet<string>, settingsPath?: string): void {
  if (node?.type !== "ObjectExpression") return;
  const options = staticValue(node);
  if (options.known && object(options.value) && typeof options.value.role === "string" && ["model", "thinking", "tools"].some((key) => Object.prototype.hasOwnProperty.call(options.value as Record<string, unknown>, key))) fail("INVALID_METADATA", "Role agents must not specify model, thinking, or tools");
  for (const key of AGENT_OPTION_KEYS) {
    const value = staticValue(propertyNode(node, key));
    if (value.known) validateAgentOption(key, value.value, aliases, knownModels, settingsPath);
  }
}

function validateStaticWithWorktree(call: WorkflowCall): void {
  if (call.arguments.some((argument) => argument.type === "SpreadElement")) return;
  if (call.arguments.length !== 1 && call.arguments.length !== 2) fail("INVALID_METADATA", "withWorktree requires a callback or a name and callback");
  const callback = call.arguments[call.arguments.length - 1];
  if (staticValue(callback).known) fail("INVALID_METADATA", "withWorktree callback must be a function");
  if (call.arguments.length === 2) {
    const name = staticValue(call.arguments[0]);
    if (name.known && (typeof name.value !== "string" || !name.value.trim())) fail("INVALID_METADATA", "withWorktree name must be a non-empty string");
  }
}

export interface WorkflowCatalogFunction { name: string; version: string; headline: string; extensionDescription: string; description: string; input: JsonSchema; output: JsonSchema }
export interface WorkflowCatalogVariable { name: string; version: string; headline: string; extensionDescription: string; description: string; schema: JsonSchema }
export interface WorkflowCatalogWorkflow { name: string; version: string; headline: string; extensionDescription: string; description: string }
export interface WorkflowCatalog { functions: readonly WorkflowCatalogFunction[]; variables: readonly WorkflowCatalogVariable[]; workflows: readonly WorkflowCatalogWorkflow[]; modelAliases?: Readonly<Record<string, string>> }
const RESERVED_GLOBALS = new Set(["agent", "conversation", "prompt", "checkpoint", "parallel", "pipeline", "phase", "withWorktree", "log", "args", "Promise", "JSON", "Math", "Date", "eval", "Function", "WebAssembly", "process", "require", "module", "exports", "console", "fetch", "XMLHttpRequest", "WebSocket", "performance", "crypto", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "Intl", "SharedArrayBuffer", "Atomics", "globalThis", "global", "undefined", "NaN", "Infinity", "extensions", "workflow_catalog"]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export class WorkflowRegistry {
  readonly #extensions = new Set<Readonly<WorkflowExtension>>();
  readonly #globals = new Map<string, string>();
  readonly #workflows = new Map<string, WorkflowScriptDefinition>();
  readonly #hooks = new Map<string, RegisteredAgentSetupHook>();
  #frozen = false;

  get frozen(): boolean { return this.#frozen; }
  freeze(): void { this.#frozen = true; }

  register(extension: WorkflowExtension): void {
    if (this.#frozen) fail("REGISTRY_FROZEN", "Workflow extension registration is closed after session_start");
    if (!object(extension) || Object.keys(extension).some((key) => !["version", "headline", "description", "functions", "variables", "workflows", "agentSetupHooks"].includes(key)) || typeof extension.version !== "string" || !SEMVER.test(extension.version) || typeof extension.headline !== "string" || !extension.headline.trim() || typeof extension.description !== "string" || !extension.description.trim()) fail("INVALID_METADATA", "Workflow extensions require a semantic version, headline, and description");
    const functions = extension.functions ?? {};
    const variables = extension.variables ?? {};
    const workflows = extension.workflows ?? {};
    const agentSetupHooks = extension.agentSetupHooks ?? {};
    if (!object(functions) || !object(variables) || !object(workflows) || !object(agentSetupHooks) || (Object.keys(functions).length === 0 && Object.keys(variables).length === 0 && Object.keys(workflows).length === 0 && Object.keys(agentSetupHooks).length === 0)) fail("INVALID_METADATA", "Workflow extensions require functions, variables, workflows, or agent setup hooks");
    const names = [...Object.keys(functions), ...Object.keys(variables)];
    if (new Set(names).size !== names.length) fail("GLOBAL_COLLISION", "Global name collision inside extension");
    for (const name of names) {
      if (!IDENTIFIER.test(name) || name.startsWith("__pi_extensible_workflows_")) fail("INVALID_METADATA", `Invalid global name: ${name}`);
      if (RESERVED_GLOBALS.has(name)) fail("GLOBAL_COLLISION", `Global name is reserved: ${name}`);
      if (this.#globals.has(name)) fail("GLOBAL_COLLISION", `Global name is already registered: ${name}`);
    }
    for (const [name, fn] of Object.entries(functions)) {
      if (!object(fn) || Object.keys(fn).some((key) => !["description", "input", "output", "run"].includes(key)) || typeof fn.description !== "string" || !fn.description.trim() || typeof fn.run !== "function") fail("INVALID_METADATA", `Invalid workflow function: ${name}`);
      validateSchema(fn.input, `${name} input`);
      validateSchema(fn.output, `${name} output`);
      if (fn.input.type !== "object") fail("INVALID_SCHEMA", `${name} input must describe one object`);
    }
    for (const [name, variable] of Object.entries(variables)) {
      if (!object(variable) || Object.keys(variable).some((key) => !["description", "schema", "resolve"].includes(key)) || typeof variable.description !== "string" || !variable.description.trim() || typeof variable.resolve !== "function") fail("INVALID_METADATA", `Invalid workflow variable: ${name}`);
      validateSchema(variable.schema, `${name} schema`);
    }
    for (const [name, workflow] of Object.entries(workflows)) {
      if (!IDENTIFIER.test(name) || !object(workflow) || Object.keys(workflow).some((key) => !["description", "script"].includes(key)) || typeof workflow.description !== "string" || !workflow.description.trim() || typeof workflow.script !== "string" || !workflow.script.trim()) fail("INVALID_METADATA", `Invalid workflow script: ${name}`);
      if (this.#workflows.has(name)) fail("DUPLICATE_NAME", `Reusable workflow already registered: ${name}`);
      parseWorkflow(workflow.script);
    }
    for (const [name, hook] of Object.entries(agentSetupHooks)) {
      if (!IDENTIFIER.test(name) || !object(hook) || Object.keys(hook).some((key) => !["priority", "setup"].includes(key)) || typeof hook.setup !== "function" || hook.priority !== undefined && (typeof hook.priority !== "number" || !Number.isFinite(hook.priority))) fail("INVALID_METADATA", `Invalid agent setup hook: ${name}`);
      if (this.#hooks.has(name)) fail("DUPLICATE_NAME", `Agent setup hook already registered: ${name}`);
    }
    const stored = deepFreeze({ ...extension, functions, variables, workflows, agentSetupHooks });
    this.#extensions.add(stored);
    for (const name of names) this.#globals.set(name, name);
    for (const [name, workflow] of Object.entries(workflows)) this.#workflows.set(name, workflow);
    for (const [name, hook] of Object.entries(agentSetupHooks)) this.#hooks.set(name, { name, priority: hook.priority ?? 10, setup: hook.setup });
  }

  workflow(name: string): WorkflowScriptDefinition {
    if (!IDENTIFIER.test(name)) fail("MISSING_WORKFLOW", `Registered workflows require an unqualified name: ${name}`);
    const workflow = this.#workflows.get(name);
    if (!workflow) fail("MISSING_WORKFLOW", `Workflow is unavailable: ${name}`);
    return workflow;
  }

  workflows(): Readonly<Record<string, WorkflowScriptDefinition>> {
    return Object.freeze(Object.fromEntries(this.#workflows));
  }

  catalog(): WorkflowCatalog {
    const functions: WorkflowCatalogFunction[] = [];
    const variables: WorkflowCatalogVariable[] = [];
    const workflows: WorkflowCatalogWorkflow[] = [];
    for (const extension of this.#extensions) {
      for (const [name, fn] of Object.entries(extension.functions ?? {})) functions.push({ name, version: extension.version, headline: extension.headline, extensionDescription: extension.description, description: fn.description, input: structuredClone(fn.input), output: structuredClone(fn.output) });
      for (const [name, variable] of Object.entries(extension.variables ?? {})) variables.push({ name, version: extension.version, headline: extension.headline, extensionDescription: extension.description, description: variable.description, schema: structuredClone(variable.schema) });
      for (const [name, workflow] of Object.entries(extension.workflows ?? {})) workflows.push({ name, version: extension.version, headline: extension.headline, extensionDescription: extension.description, description: workflow.description });
    }
    let aliases: Readonly<Record<string, string>> | undefined;
    try { aliases = loadSettings().modelAliases; } catch { aliases = undefined; }
    const sort = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name);
    return deepFreeze({ functions: functions.sort(sort), variables: variables.sort(sort), workflows: workflows.sort(sort), ...(aliases ? { modelAliases: structuredClone(aliases) } : {}) });
  }

  globals(): Readonly<Record<string, { name: string }>> {
    return Object.freeze(Object.fromEntries([...this.#extensions].flatMap((extension) => Object.keys(extension.functions ?? {}).map((name) => [name, { name }]))));
  }

  async invokeFunction(name: string, input: unknown, context: Readonly<WorkflowFunctionContext>, path: string, journal: WorkflowJournal): Promise<JsonValue> {
    const fn = [...this.#extensions].find((extension) => extension.functions?.[name])?.functions?.[name];
    if (!fn) fail("MISSING_WORKFLOW", `Workflow function is unavailable: ${name}`);
    if (!object(input) || !jsonValue(input) || !Value.Check(fn.input, input)) fail("RESULT_INVALID", `Invalid input for ${name}`);
    const replayed = journal.get(path);
    if (replayed !== undefined) {
      if (!jsonValue(replayed) || !Value.Check(fn.output, replayed)) fail("RESULT_INVALID", `Invalid replay for ${name}`);
      return structuredClone(replayed);
    }
    const result: unknown = await fn.run(deepFreeze(structuredClone(input)), Object.freeze({ run: context.run, invoke: context.invoke, agent: context.agent, prompt: context.prompt, parallel: context.parallel, pipeline: context.pipeline, withWorktree: context.withWorktree, checkpoint: context.checkpoint, phase: context.phase, log: context.log }));
    if (!jsonValue(result) || !Value.Check(fn.output, result)) fail("RESULT_INVALID", `Invalid output from ${name}`);
    const stored = structuredClone(result);
    journal.put(path, stored);
    return structuredClone(stored);
  }

  variables(): readonly { name: string; variable: WorkflowVariable }[] {
    return [...this.#extensions].flatMap((extension) => Object.entries(extension.variables ?? {}).map(([name, variable]) => ({ name, variable })));
  }
  agentSetupHooks(): readonly RegisteredAgentSetupHook[] {
    return [...this.#hooks.values()].sort((left, right) => left.priority - right.priority || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  }
}
type WorkflowRegistryApi = Pick<WorkflowRegistry, "frozen" | "freeze" | "register" | "workflow" | "workflows" | "catalog" | "globals" | "invokeFunction" | "variables" | "agentSetupHooks">;
interface WorkflowRegistryHost { api: WorkflowRegistryApi }
const WORKFLOW_REGISTRY_KEY = Symbol.for("pi-extensible-workflows.workflow-registry");
const globalRegistry = globalThis as typeof globalThis & Record<symbol, WorkflowRegistryHost | undefined>;
function createWorkflowRegistryApi(registry: WorkflowRegistry): WorkflowRegistryApi {
  return {
    get frozen() { return registry.frozen; },
    freeze: () => { registry.freeze(); },
    register: (extension) => { registry.register(extension); },
    workflow: (name) => registry.workflow(name),
    workflows: () => registry.workflows(),
    catalog: () => registry.catalog(),
    globals: () => registry.globals(),
    invokeFunction: (...args) => registry.invokeFunction(...args),
    variables: () => registry.variables(),
    agentSetupHooks: () => registry.agentSetupHooks(),
  };
}
function workflowRegistryHost(): WorkflowRegistryHost {
  return globalRegistry[WORKFLOW_REGISTRY_KEY] ??= { api: createWorkflowRegistryApi(new WorkflowRegistry()) };
}
function resetWorkflowRegistry(): void {
  workflowRegistryHost().api = createWorkflowRegistryApi(new WorkflowRegistry());
}
function beginWorkflowExtensionLoading(): void {
  if (workflowRegistryHost().api.frozen) resetWorkflowRegistry();
}
function loadingRegistry(): WorkflowRegistryApi { return workflowRegistryHost().api; }
beginWorkflowExtensionLoading();
export function registerWorkflowExtension(extension: WorkflowExtension): void { loadingRegistry().register(extension); }
export function workflowCatalog(): WorkflowCatalog { return loadingRegistry().catalog(); }
export function registeredWorkflowDefinitions(): Readonly<Record<string, WorkflowScriptDefinition>> { return loadingRegistry().workflows(); }


export function formatWorkflowPreview(args: { script?: unknown; workflow?: unknown; name?: unknown; description?: unknown }): string {
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : typeof args.workflow === "string" && args.workflow.trim() ? args.workflow : "workflow";
  if (typeof args.script !== "string" || !args.script.trim()) return `workflow ${name}${typeof args.workflow === "string" ? "\nRegistered workflow" : ""}`;
  return [`workflow ${name}`, typeof args.description === "string" && args.description.trim() ? args.description.trim() : ""].filter(Boolean).join("\n");
}
export const WORKFLOW_TOOL_LABEL = "Workflow";
export const WORKFLOW_TOOL_DESCRIPTION = "Run a deterministic JavaScript workflow";
export const WORKFLOW_TOOL_PROMPT_SNIPPET = "Run a deterministic, resumable JavaScript workflow that orchestrates subagents. Inline scripts require a name; registered workflows use their workflow name. Runs in the background by default; completion arrives as a follow-up message.";
export const WORKFLOW_TOOL_PARAMETERS = Type.Object({
  name: Type.Optional(Type.String({ description: "Workflow name for inline scripts" })),
  description: Type.Optional(Type.String({ description: "Optional human-readable workflow description" })),
  script: Type.Optional(Type.String({ description: "Immutable workflow source without metadata" })),
  workflow: Type.Optional(Type.String({ description: "Registered reusable workflow as an unqualified name" })),
  args: Type.Optional(Type.Unknown({ description: "JSON-compatible workflow arguments" })),
  foreground: Type.Optional(Type.Boolean({ description: "Wait for completion instead of running in the background" })),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
  budget: Type.Optional(Type.Unknown({ description: "Optional aggregate soft and hard run budgets" })),
});

function hasDynamicAgentRole(node: acorn.AnyNode | undefined): boolean {
  if (!node) return false;
  if (node.type !== "ObjectExpression") return true;
  for (let index = node.properties.length - 1; index >= 0; index -= 1) {
    const property = node.properties[index];
    if (!property || property.type === "SpreadElement" || property.computed) return true;
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
    if (key === "role") return literalString(property.value) === undefined;
  }
  return false;
}

export function preflight(script: string, capabilities: PreflightCapabilities, schemas: readonly unknown[] = [], metadata: WorkflowMetadata = { name: "workflow" }): PreflightResult {
  const checkedMetadata = validateWorkflowMetadata(metadata);
  const program = parseWorkflow(script);
  if (hasIdentifier(program, INTERNAL_AGENT_NAME)) fail("INVALID_METADATA", `${INTERNAL_AGENT_NAME} is reserved for workflow agent instrumentation`);
  if (hasIdentifier(program, INTERNAL_CONVERSATION_NAME)) fail("INVALID_METADATA", `${INTERNAL_CONVERSATION_NAME} is reserved for workflow conversation instrumentation`);
  if (hasIdentifier(program, INTERNAL_WORKTREE_NAME)) fail("INVALID_METADATA", `${INTERNAL_WORKTREE_NAME} is reserved for workflow withWorktree instrumentation`);
  validateDirectPrimitiveReferences(program, "withWorktree");
  validateDirectPrimitiveReferences(program, "conversation");
  for (const [index, schema] of schemas.entries()) validateSchema(schema, `schema[${String(index)}]`);
  const calls = workflowCalls(program);
  const phases = calls.filter((call) => call.callee.name === "phase").map((call) => literalString(call.arguments[0])).filter((phase): phase is string => phase !== undefined);
  for (const call of calls) {
    const operation = call.callee.name;
    if (operation === "agent" || operation === "conversation") {
      if (operation === "conversation" && (!literalString(call.arguments[0])?.trim() || call.arguments.length > 2)) fail("INVALID_METADATA", "conversation requires a stable name and optional options object");
      validateStaticAgentOptions(call.arguments[1], capabilities.modelAliases ?? {}, capabilities.knownModels ?? capabilities.models, capabilities.settingsPath);
    }
    if (operation === "withWorktree") validateStaticWithWorktree(call);
    if ((operation === "parallel" || operation === "pipeline") && call.arguments.some((argument) => argument.type === "SpreadElement")) continue;
    if (operation === "checkpoint" && stableName(call.arguments[0]) === false) fail("INVALID_METADATA", `${operation} requires a stable explicit name`);
    if (operation === "parallel" && (call.arguments.length !== 2 || !literalString(call.arguments[0])?.trim() || call.arguments[1]?.type !== "ObjectExpression")) fail("INVALID_METADATA", "parallel requires an operation name string and tasks record");
    if (operation === "pipeline" && (call.arguments.length !== 3 || !literalString(call.arguments[0])?.trim() || call.arguments[1]?.type !== "ObjectExpression" || call.arguments[2]?.type !== "ObjectExpression")) fail("INVALID_METADATA", "pipeline requires an operation name string, items record, and stages record");
  }
  const agentCalls = calls.filter((call) => call.callee.name === "agent" || call.callee.name === "conversation");
  const dynamicAgentRoles = agentCalls.some((call) => hasDynamicAgentRole(call.arguments[1]));
  const staticSchemas = agentCalls.flatMap((call) => { const value = staticValue(propertyNode(call.arguments[1], "outputSchema")); return value.known ? [value.value] : []; });
  for (const [index, schema] of staticSchemas.entries()) validateSchema(schema, `agent outputSchema[${String(index)}]`);
  const checkedSchemas = [...schemas, ...staticSchemas];
  const modelRefs = agentCalls.flatMap((call) => { const requested = literalString(propertyNode(call.arguments[1], "model")); return requested === undefined ? [] : [{ requested, resolved: modelCapability(requested, capabilities.modelAliases, capabilities.knownModels ?? capabilities.models, capabilities.settingsPath) }]; });
  const models = modelRefs.map(({ resolved }) => resolved);
  const tools = agentCalls.flatMap((call) => {
    const value = propertyNode(call.arguments[1], "tools");
    return value?.type === "ArrayExpression" ? value.elements.flatMap((element) => { const tool = element && element.type !== "SpreadElement" ? literalString(element) : undefined; return tool === undefined ? [] : [tool]; }) : [];
  });
  const agentTypes = agentCalls.flatMap((call) => { const value = literalString(propertyNode(call.arguments[1], "role")); return value === undefined ? [] : [value]; });
  const missingModel = capabilities.skipModelAvailability ? undefined : modelRefs.find(({ resolved }) => !capabilities.models.has(resolved));
  if (missingModel) {
    if (Object.prototype.hasOwnProperty.call(capabilities.modelAliases ?? {}, missingModel.requested)) unknownModel(missingModel.requested, missingModel.resolved, capabilities.settingsPath);
    fail("UNKNOWN_MODEL", `Unknown model: ${missingModel.resolved}`);
  }
  const missingTool = tools.find((tool) => !capabilities.tools.has(tool));
  if (missingTool) fail("UNKNOWN_TOOL", `Unknown tool: ${missingTool}`);
  const missingType = agentTypes.find((type) => !capabilities.agentTypes.has(type));
  if (missingType) fail("UNKNOWN_AGENT_TYPE", `Unknown agent type: ${missingType}`);
  return Object.freeze({ metadata: deepFreeze(checkedMetadata), referenced: deepFreeze({ phases, models, tools, agentTypes }), schemas: deepFreeze(checkedSchemas) as readonly JsonSchema[], dynamicAgentRoles });
}

export interface WorkflowValidationParameters {
  name?: string;
  description?: string;
  script?: string;
  workflow?: string;
}

export interface WorkflowValidationContext {
  cwd: string;
  projectTrusted: boolean;
  availableModels: ReadonlySet<string>;
  rootTools: ReadonlySet<string>;
  modelAliases?: Readonly<Record<string, string>>;
  knownModels?: ReadonlySet<string>;
  settingsPath?: string;
}


export interface ValidatedWorkflowLaunch {
  script: string;
  checked: PreflightResult;
  agentDefinitions: Readonly<Record<string, AgentDefinition>>;
  projectAgentDefinitions: Readonly<Record<string, AgentDefinition>>;
  roleNames: readonly string[];
}

export function validateWorkflowLaunch(params: WorkflowValidationParameters, context: WorkflowValidationContext): ValidatedWorkflowLaunch {
  return validateWorkflowLaunchWithRegistry(params, context, loadingRegistry());
}
function validateWorkflowLaunchWithRegistry(params: WorkflowValidationParameters, context: WorkflowValidationContext, registry: WorkflowRegistryApi): ValidatedWorkflowLaunch {
  if (Object.prototype.hasOwnProperty.call(params, "maxAgentLaunches")) fail("INVALID_METADATA", "maxAgentLaunches has been removed; use budget.agentLaunches");
  if (params.script !== undefined && params.workflow !== undefined) fail("INVALID_METADATA", "Provide either script or workflow, not both");
  const definition = typeof params.workflow === "string" ? registry.workflow(params.workflow) : undefined;
  const script = typeof params.script === "string" && params.script.trim() ? params.script : definition?.script ?? "";
  if (!script) fail("INVALID_SYNTAX", "Provide script or registered workflow");
  const workflowName = typeof params.name === "string" && params.name.trim() ? params.name.trim() : typeof params.workflow === "string" ? params.workflow : "";
  if (!workflowName) fail("INVALID_METADATA", "Inline workflows require name");
  const metadata = validateWorkflowMetadata({ name: workflowName, ...(typeof params.description === "string" ? { description: params.description } : definition?.description ? { description: definition.description } : {}) });
  const globalAgentDefinitions = loadAgentDefinitions(context.cwd, undefined, false);
  const projectAgentDefinitions = context.projectTrusted ? readRoleDefinitions(projectRoleDirectories(join(context.cwd, ".pi"))) : {};
  const agentDefinitions = deepFreeze({ ...globalAgentDefinitions, ...projectAgentDefinitions });
  const aliases = context.modelAliases ?? {};
  const knownModels = context.knownModels ?? context.availableModels;
  const checked = preflight(script, { models: context.availableModels, tools: context.rootTools, agentTypes: new Set(Object.keys(agentDefinitions)), modelAliases: aliases, knownModels, ...(context.settingsPath ? { settingsPath: context.settingsPath } : {}) }, [], metadata);
  const roleNames = checked.dynamicAgentRoles ? Object.keys(agentDefinitions) : checked.referenced.agentTypes;
  validateRolePolicies(agentDefinitions, roleNames, context.availableModels, context.rootTools, aliases, knownModels, context.settingsPath);
  return { script, checked, agentDefinitions, projectAgentDefinitions, roleNames };
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

type LaunchSnapshotInput = Omit<LaunchSnapshot, "identityVersion"> & { identityVersion?: number };

export function createLaunchSnapshot(input: LaunchSnapshotInput): Readonly<LaunchSnapshot> {
  return deepFreeze(structuredClone({ ...input, identityVersion: input.identityVersion ?? LAUNCH_SNAPSHOT_IDENTITY_VERSION }));
}

export function loadLaunchSnapshot(input: LaunchSnapshot): Readonly<LaunchSnapshot> {
  return deepFreeze(structuredClone(input));
}

export const RPC_LIMIT_BYTES = 10 * 1024 * 1024;
export const HEARTBEAT_TIMEOUT_MS = 5000;

export interface AgentIdentity { structuralPath: readonly string[]; callSite: string; occurrence: number; parentBreadcrumb?: string; worktreeOwner?: string; conversation?: { name: string; turn: number } }
export interface WorkflowBridge {
  agent?: (prompt: string, options: Readonly<Record<string, JsonValue>>, signal: AbortSignal, identity: AgentIdentity) => Promise<JsonValue>;
  checkpoint?: (input: Readonly<Record<string, JsonValue>>, signal: AbortSignal) => boolean | Promise<boolean>;
  function?: (name: string, input: Readonly<Record<string, JsonValue>>, path: string, signal: AbortSignal, worktreeOwner?: string, structuralPath?: readonly string[]) => Promise<JsonValue>;
  functions?: Readonly<Record<string, { name: string }>>;
  variables?: Readonly<Record<string, JsonValue>>;
  phase?: (name: string) => void | Promise<void>;
  log?: (message: string) => void | Promise<void>;
}

export interface WorkflowExecution { result: Promise<JsonValue>; cancel: () => void }

const OUTCOME_ERRORS = new Set<string>(["AGENT_TIMEOUT", "AGENT_FAILED", "RESULT_INVALID"]);
const WORK_RESULT_BRAND = "__workResult";

const childSource = String.raw`
"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const vm = require("node:vm");
const LIMIT = parseInt(process.argv[2], 10);
const config = JSON.parse(process.argv[3]);
for (const key of ["getBuiltinModule","binding","_linkedBinding","dlopen","kill","abort","exit","reallyExit","_kill","umask","chdir","setuid","setgid","seteuid","setegid","setgroups","initgroups"]) {
  if (key in process) process[key] = undefined;
}
let nextId = 0;
let cancelled = false;
const pending = new Map();
const inflight = new Set();
const hasMessage = error => Boolean(error && typeof error === "object" && typeof error.message === "string");
const errorText = error => hasMessage(error) ? error.message : String(error);
const errorCode = error => { if (!error || typeof error !== "object") return undefined; const code = error.code; return typeof code === "string" ? code : undefined; };
const errorAuthored = error => Boolean(error && typeof error === "object" && error.authored === true);
const workerError = error => { const code = errorCode(error); return { code: code || "INTERNAL_ERROR", message: errorText(error), ...(error && typeof error === "object" && typeof error.failedAt === "string" ? { failedAt: error.failedAt } : {}), ...(errorAuthored(error) || hasMessage(error) && !code ? { authored: true } : {}) }; };
const workflowError = error => Object.assign(new Error(errorText(error)), workerError(error));
function send(value) {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > LIMIT) throw Object.assign(new Error("RPC value exceeds the 10 MB JSON boundary"), { code: "RPC_LIMIT_EXCEEDED" });
  process.send(json);
}
function rpc(method, args) {
  if (cancelled) throw Object.assign(new Error("Workflow cancelled"), { code: "CANCELLED" });
  const id = ++nextId;
  send({ type: "rpc", id, method, args });
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  inflight.add(promise);
  void promise.then(() => inflight.delete(promise), () => inflight.delete(promise));
  return promise;
}
process.on("message", raw => {
  let message;
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > LIMIT) throw Object.assign(new Error("RPC value exceeds the 10 MB JSON boundary"), { code: "RPC_LIMIT_EXCEEDED" });
    message = JSON.parse(raw);
  } catch (error) { send({ type: "error", error: workerError(error) }); return; }
  if (message.type === "cancel") { cancelled = true; for (const { reject } of pending.values()) reject(Object.assign(new Error("Workflow cancelled"), { code: "CANCELLED" })); pending.clear(); return; }
  if (message.type !== "rpcResult") return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.ok) request.resolve(message.value);
  else request.reject(workflowError(message.error));
});
const heartbeat = setInterval(() => send({ type: "heartbeat" }), 1000);
send({ type: "heartbeat" });
const BRAND = "${WORK_RESULT_BRAND}";
const workError = (code, message) => Object.assign(new Error(message), { code });
const isBranded = value => value && typeof value === "object" && value[BRAND] === true;
const unwrap = result => {
  if (!isBranded(result)) return result;
  if (result.ok) return result.value;
  throw Object.assign(workflowError(result.error), { failedAt: result.failedAt });
};
const named = (value, kind) => { if (typeof value !== "string" || !value.trim()) throw workError("INVALID_METADATA", kind + " requires a stable explicit name"); return value; };
const path = (...names) => names.map(encodeURIComponent).join("/");
const inheritedAgentPath = new AsyncLocalStorage();
const agentOccurrences = new Map();
const conversationOccurrences = new Map();
const worktreeOwners = new AsyncLocalStorage();
const worktreeOccurrences = new Map();
const rejectAgent = () => { throw workError("INVALID_METADATA", "Workflow agent calls must use a direct agent(...) call; aliases and indirect calls are unsupported"); };
const rejectWorktree = () => { throw workError("INVALID_METADATA", "withWorktree calls must use a direct withWorktree(...) call; aliases and indirect calls are unsupported"); };
const internalWithWorktree = async (...values) => {
  const callSite = values.pop();
  if (typeof callSite !== "string") throw workError("INTERNAL_ERROR", "Missing withWorktree call-site identity");
  if (values.length !== 1 && values.length !== 2) throw workError("INVALID_METADATA", "withWorktree requires a callback or a name and callback");
  const callback = values[values.length - 1];
  if (typeof callback !== "function") throw workError("INVALID_METADATA", "withWorktree callback must be a function");
  let owner;
  if (values.length === 2) {
    if (typeof values[0] !== "string" || !values[0].trim()) throw workError("INVALID_METADATA", "withWorktree name must be a non-empty string");
    owner = path("worktree", "named", values[0].trim());
  } else {
    const inherited = inheritedAgentPath.getStore() || [];
    const occurrenceKey = JSON.stringify([inherited, callSite]);
    const occurrence = (worktreeOccurrences.get(occurrenceKey) || 0) + 1;
    worktreeOccurrences.set(occurrenceKey, occurrence);
    owner = path("worktree", "unnamed", ...inherited, "callsite:" + callSite, "occurrence:" + String(occurrence));
  }
  return await worktreeOwners.run(owner, callback);
};
const internalConversation = (...values) => {
  const callSite = values.pop();
  if (typeof callSite !== "string") throw workError("INTERNAL_ERROR", "Missing workflow conversation call-site identity");
  const name = values[0];
  if (typeof name !== "string" || !name.trim()) throw workError("INVALID_METADATA", "conversation requires a non-empty name");
  const conversationOptions = values.length < 2 || values[1] === undefined ? {} : values[1];
  if (!conversationOptions || typeof conversationOptions !== "object" || Array.isArray(conversationOptions)) throw workError("INVALID_METADATA", "conversation options must be a JSON object");
  const inherited = inheritedAgentPath.getStore() || [];
  const occurrenceKey = JSON.stringify([inherited, callSite, name]);
  const occurrence = (conversationOccurrences.get(occurrenceKey) || 0) + 1;
  conversationOccurrences.set(occurrenceKey, occurrence);
  const fixedOptions = structuredClone(conversationOptions);
  const defaultTimeout = fixedOptions.timeoutMs;
  const defaultRetries = fixedOptions.retries;
  delete fixedOptions.timeoutMs;
  delete fixedOptions.retries;
  const worktreeOwner = worktreeOwners.getStore();
  let turn = 0;
  let active = false;
  return Object.freeze({
    run(prompt, turnOptions = {}) {
      if (typeof prompt !== "string") throw workError("INVALID_METADATA", "conversation.run prompt must be a string");
      if (!turnOptions || typeof turnOptions !== "object" || Array.isArray(turnOptions) || Object.keys(turnOptions).some(key => key !== "timeoutMs" && key !== "retries")) throw workError("INVALID_METADATA", "conversation.run options only support timeoutMs and retries");
      if (active) throw workError("RESUME_INCOMPATIBLE", "Conversation turns cannot overlap");
      active = true;
      const turnNumber = turn + 1;
      const options = { ...fixedOptions, ...(defaultTimeout !== undefined && turnOptions.timeoutMs === undefined ? { timeoutMs: defaultTimeout } : {}), ...(defaultRetries !== undefined && turnOptions.retries === undefined ? { retries: defaultRetries } : {}), ...turnOptions };
      const identity = { structuralPath: [...inherited], callSite, occurrence, ...(worktreeOwner ? { worktreeOwner } : {}), conversation: { name: name.trim(), turn: turnNumber } };
      const result = rpc("agent", [prompt, options, identity]).then(value => { const unwrapped = unwrap(value); turn = turnNumber; return unwrapped; }).finally(() => { active = false; });
      Object.defineProperties(result, {
        toJSON: { value() { throw workError("INVALID_METADATA", "Workflow conversation result is a Promise; await it before serialization"); } },
        toString: { value() { throw workError("INVALID_METADATA", "Workflow conversation result is a Promise; await it before interpolation"); } },
        [Symbol.toPrimitive]: { value() { throw workError("INVALID_METADATA", "Workflow conversation result is a Promise; await it before interpolation"); } },
      });
      return result;
    },
  });
};
const internalAgent = (...values) => {
  const callSite = values.pop();
  if (typeof callSite !== "string") throw workError("INTERNAL_ERROR", "Missing workflow agent call-site identity");
  const inherited = inheritedAgentPath.getStore() || [];
  // ponytail: same-callsite races outside parallel/pipeline lack a stable structural scope and are unsupported.
  const occurrenceKey = JSON.stringify([inherited, callSite]);
  const occurrence = (agentOccurrences.get(occurrenceKey) || 0) + 1;
  agentOccurrences.set(occurrenceKey, occurrence);
  const options = values.length < 2 || values[1] === undefined ? {} : values[1];
  const worktreeOwner = worktreeOwners.getStore();
  const identity = { structuralPath: [...inherited], callSite, occurrence, ...(worktreeOwner ? { worktreeOwner } : {}) };
  const result = rpc("agent", [values[0], options, identity]).then(unwrap);
  Object.defineProperties(result, {
    toJSON: { value() { throw workError("INVALID_METADATA", "Workflow agent result is a Promise; await it before serialization"); } },
    toString: { value() { throw workError("INVALID_METADATA", "Workflow agent result is a Promise; await it before interpolation"); } },
    [Symbol.toPrimitive]: { value() { throw workError("INVALID_METADATA", "Workflow agent result is a Promise; await it before interpolation"); } },
  });
  return result;
};
const agent = rejectAgent;
const promptPath = (at, key) => /^[A-Za-z_$][\w$]*$/.test(key) ? at + "." + key : at + "[" + JSON.stringify(key) + "]";
const plainPromptObject = value => {
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null && Object.prototype.hasOwnProperty.call(proto, "constructor") && typeof proto.constructor === "function" && Function.prototype.toString.call(proto.constructor) === Function.prototype.toString.call(Object);
};
const promptValue = (value, at, seen) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" must be a finite number"); return; }
  if (typeof value !== "object") throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" cannot be " + typeof value);
  if (typeof value.then === "function") throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" is a Promise or thenable; await it before calling prompt()");
  if (!Array.isArray(value) && !plainPromptObject(value)) throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" must be a plain object");
  if (seen.has(value)) throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" contains a cycle");
  const keys = Reflect.ownKeys(value);
  const symbol = keys.find(key => typeof key === "symbol");
  if (symbol) throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" contains a symbol key");
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) promptProperty(value, String(index), at + "[" + index + "]", seen);
    for (const key of keys) {
      const index = Number(key);
      if (key !== "length" && !(Number.isInteger(index) && index >= 0 && index < value.length && String(index) === key)) promptProperty(value, key, promptPath(at, key), seen);
    }
  } else for (const key of keys) promptProperty(value, key, promptPath(at, key), seen);
  seen.delete(value);
};
const promptProperty = (value, key, at, seen) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && (descriptor.get || descriptor.set)) throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" cannot use getters or setters");
  promptValue(descriptor && descriptor.value, at, seen);
};
const prompt = (template, values) => {
  if (typeof template !== "string") throw workError("INVALID_METADATA", "prompt() template must be a string");
  if (!values || typeof values !== "object" || Array.isArray(values) || !plainPromptObject(values)) throw workError("INVALID_METADATA", "prompt() values must be a plain object");
  const placeholders = [...template.matchAll(/{{|}}|{([A-Za-z_$][\w$]*)}/g)].flatMap(match => match[1] === undefined ? [] : [match[1]]);
  const used = new Set(placeholders);
  const keys = Reflect.ownKeys(values);
  const symbol = keys.find(key => typeof key === "symbol");
  if (symbol) throw workError("INVALID_METADATA", "prompt() values must use string keys");
  const missing = placeholders.find(key => !Object.prototype.hasOwnProperty.call(values, key));
  if (missing) throw workError("INVALID_METADATA", "Missing prompt value \"" + missing + "\"");
  const unused = keys.find(key => !used.has(key));
  if (unused !== undefined) throw workError("INVALID_METADATA", "Unused prompt value \"" + unused + "\"");
  for (const key of keys) promptProperty(values, key, key, new Set());
  return template.replace(/{{|}}|{([A-Za-z_$][\w$]*)}/g, (match, key) => match === "{{" ? "{" : match === "}}" ? "}" : typeof values[key] === "string" ? values[key] : JSON.stringify(values[key], null, 2));
};
const checkpoint = input => rpc("checkpoint", [input]).then(unwrap);
const phase = name => rpc("phase", [name]);
const log = message => rpc("log", [message]);
const functionOccurrences = new Map();
const functionPath = name => {
  const inherited = inheritedAgentPath.getStore() || [];
  const key = JSON.stringify([inherited, name]);
  const occurrence = (functionOccurrences.get(key) || 0) + 1;
  functionOccurrences.set(key, occurrence);
  return path("function", ...inherited, name, String(occurrence));
};
const functions = Object.freeze(Object.fromEntries(Object.entries(config.functions || {}).map(([local, target]) => [local, (...values) => {
  if (values.length !== 1 || !values[0] || typeof values[0] !== "object" || Array.isArray(values[0])) throw workError("RESULT_INVALID", local + " requires exactly one JSON object argument");
  const inherited = inheritedAgentPath.getStore() || [];
  const result = rpc("function", [target.name, values[0], functionPath(target.name), worktreeOwners.getStore() || null, inherited]).then(unwrap);
  Object.defineProperty(result, "toJSON", { value() { throw workError("INVALID_METADATA", "Workflow function result is a Promise; await it before serialization"); } });
  return result;
}])));
const freeze = value => { if (value && typeof value === "object" && !Object.isFrozen(value)) { Object.freeze(value); for (const child of Object.values(value)) freeze(child); } return value; };
const recordEntries = (value, kind) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw workError("INVALID_METADATA", kind + " must be a record");
  return Object.entries(value);
};
const parallel = async (operationName, tasks) => {
  named(operationName, "parallel");
  const entries = recordEntries(tasks, "parallel tasks");
  for (const [name, run] of entries) {
    named(name, "parallel task");
    if (typeof run !== "function") throw workError("INVALID_METADATA", "parallel task values must be run functions");
  }
  const results = await Promise.all(entries.map(async ([name, run]) => {
    try {
      const parent = inheritedAgentPath.getStore() || [];
      return { name, ok: true, value: await inheritedAgentPath.run([...parent, operationName, name], run) };
    } catch (error) {
      if (errorCode(error) === "CANCELLED") throw error;
      const failedAt = error && typeof error === "object" && typeof error.failedAt === "string" ? error.failedAt : undefined;
      return { name, ok: false, failedAt: failedAt ? path(operationName, name, failedAt) : path(operationName, name), error: workerError(error) };
    }
  }));
  const failure = results.find(result => !result.ok);
  if (failure) throw Object.assign(workflowError(failure.error), { failedAt: failure.failedAt });
  return Object.fromEntries(results.map(result => [result.name, result.value]));
};
const pipeline = async (operationName, items, stages) => {
  named(operationName, "pipeline");
  const itemEntries = recordEntries(items, "pipeline items");
  const stageEntries = recordEntries(stages, "pipeline stages");
  if (!stageEntries.length) throw workError("INVALID_METADATA", "pipeline requires at least one stage");
  for (const [name] of itemEntries) named(name, "pipeline item");
  for (const [stageName, run] of stageEntries) {
    named(stageName, "pipeline stage");
    if (typeof run !== "function") throw workError("INVALID_METADATA", "pipeline stage values must be run functions");
  }
  const results = await Promise.all(itemEntries.map(async ([name, initial]) => {
    let value = initial;
    let failedAt = path(operationName, name);
    try {
      for (const [stageName, run] of stageEntries) {
        failedAt = path(operationName, name, stageName);
        const parent = inheritedAgentPath.getStore() || [];
        value = await inheritedAgentPath.run([...parent, operationName, name, stageName], () => run(value));
      }
      return { name, ok: true, value };
    } catch (error) {
      if (errorCode(error) === "CANCELLED") throw error;
      const nestedFailedAt = error && typeof error === "object" && typeof error.failedAt === "string" ? error.failedAt : undefined;
      return { name, ok: false, failedAt: nestedFailedAt ? path(failedAt, nestedFailedAt) : failedAt, error: workerError(error) };
    }
  }));
  const failure = results.find(result => !result.ok);
  if (failure) throw Object.assign(workflowError(failure.error), { failedAt: failure.failedAt });
  return Object.fromEntries(results.map(result => [result.name, result.value]));
};
const safeMath = Object.fromEntries(Object.getOwnPropertyNames(Math).filter(name => name !== "random").map(name => [name, Math[name]]));
const sandbox = { agent, conversation: internalConversation, withWorktree: rejectWorktree, prompt, checkpoint, parallel, pipeline, phase, log, args: config.args, Promise, JSON, Math: Object.freeze(safeMath) };
for (const [name, fn] of Object.entries(functions)) Object.defineProperty(sandbox, name, { value: fn, writable: false, configurable: false });
for (const [name, value] of Object.entries(config.variables || {})) Object.defineProperty(sandbox, name, { value: freeze(value), writable: false, configurable: false });
for (const name of ["Date","eval","Function","WebAssembly","process","require","module","exports","console","fetch","XMLHttpRequest","WebSocket","performance","crypto","setTimeout","setInterval","setImmediate","queueMicrotask","Intl","SharedArrayBuffer","Atomics"]) sandbox[name] = undefined;
const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
const body = config.script;
Promise.resolve().then(() => new vm.Script("(async(__pi_extensible_workflows_agent,__pi_extensible_workflows_conversation,__pi_extensible_workflows_withWorktree)=>{" + body + "\n})", { filename: "workflow.js" }).runInContext(context)(internalAgent, internalConversation, internalWithWorktree))
  .then(async value => { await Promise.all(inflight); send({ type: "result", value: value === undefined ? null : value }); })
  .catch(error => send({ type: "error", error: workerError(error) }))
  .finally(() => clearInterval(heartbeat));
`;

function encoded(value: unknown): string {
  if (!jsonValue(value)) fail("RPC_LIMIT_EXCEEDED", "RPC values must be JSON-compatible");
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > RPC_LIMIT_BYTES) fail("RPC_LIMIT_EXCEEDED", "RPC value exceeds the 10 MB JSON boundary");
  return json;
}

function readAgentIdentity(value: unknown): AgentIdentity {
  if (!object(value)) fail("INTERNAL_ERROR", "Invalid workflow agent identity");
  const structuralPath = value.structuralPath;
  const callSite = value.callSite;
  const occurrence = value.occurrence;
  const worktreeOwner = value.worktreeOwner;
  const parentBreadcrumb = value.parentBreadcrumb;
  const conversation = value.conversation;
  const parsedConversation = object(conversation) && typeof conversation.name === "string" && Boolean(conversation.name.trim()) && positiveInteger(conversation.turn) ? { name: conversation.name, turn: conversation.turn } : undefined;
  if (!Array.isArray(structuralPath) || !structuralPath.every((part): part is string => typeof part === "string" && Boolean(part.trim())) || typeof callSite !== "string" || !callSite || !positiveInteger(occurrence) || parentBreadcrumb !== undefined && (typeof parentBreadcrumb !== "string" || !parentBreadcrumb.trim()) || worktreeOwner !== undefined && (typeof worktreeOwner !== "string" || !worktreeOwner) || conversation !== undefined && !parsedConversation) fail("INTERNAL_ERROR", "Invalid workflow agent identity");
  return { structuralPath: [...structuralPath], callSite, occurrence, ...(typeof parentBreadcrumb === "string" ? { parentBreadcrumb } : {}), ...(typeof worktreeOwner === "string" ? { worktreeOwner } : {}), ...(parsedConversation ? { conversation: parsedConversation } : {}) };
}

function agentIdentityPath(identity: AgentIdentity): string {
  return operationPath("agent", ...identity.structuralPath, `callsite:${identity.callSite}`, `occurrence:${String(identity.occurrence)}`);
}
function conversationIdentityPath(identity: AgentIdentity): string {
  if (!identity.conversation) throw new WorkflowError("INTERNAL_ERROR", "Missing conversation identity");
  return operationPath("conversation", identity.conversation.name, ...identity.structuralPath, `callsite:${identity.callSite}`, `occurrence:${String(identity.occurrence)}`);
}
function conversationTurnPath(identity: AgentIdentity): string {
  if (!identity.conversation) throw new WorkflowError("INTERNAL_ERROR", "Missing conversation identity");
  return operationPath(conversationIdentityPath(identity), `turn:${String(identity.conversation.turn)}`);
}
function agentWorktree(identity: AgentIdentity): { worktreeOwner?: string } {
  return identity.worktreeOwner ? { worktreeOwner: identity.worktreeOwner } : {};
}
export function runWorkflow(script: string, args: JsonValue = null, bridge: WorkflowBridge = {}, signal?: AbortSignal): WorkflowExecution {
  encoded(args);
  const config = JSON.stringify({ script: instrumentWorkflow(script), args: structuredClone(args), functions: bridge.functions ?? {}, variables: bridge.variables ?? {} });
  const childDir = mkdtempSync(join(tmpdir(), "pi-wf-"));
  const childFile = join(childDir, "child.cjs");
  writeFileSync(childFile, childSource);
  const child: ChildProcess = fork(childFile, [String(RPC_LIMIT_BYTES), config], {
    execArgv: (() => {
      const filtered: string[] = [];
      const skip = new Set(["--input-type", "-e", "--eval", "-p", "--print"]);
      let skipNext = false;
      for (const arg of process.execArgv) {
        if (skipNext) { skipNext = false; continue; }
        if (skip.has(arg) || skip.has(arg.split("=")[0] ?? "")) { if (!arg.includes("=")) skipNext = true; continue; }
        filtered.push(arg);
      }
      return [...filtered, "--max-old-space-size=128", "--permission", `--allow-fs-read=${childDir}`];
    })(),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
  const controller = new AbortController();
  let settled = false;
  let rejectResult: (error: WorkflowError) => void = () => undefined;
  let watchdog = setTimeout(() => { stop("WORKER_UNRESPONSIVE", "Workflow worker missed its five-second heartbeat"); }, HEARTBEAT_TIMEOUT_MS);
  const result = new Promise<JsonValue>((resolve, reject) => {
    rejectResult = reject;
    child.on("message", (raw: unknown) => {
      try {
        if (typeof raw !== "string" || Buffer.byteLength(raw) > RPC_LIMIT_BYTES) fail("RPC_LIMIT_EXCEEDED", "RPC value exceeds the 10 MB JSON boundary");
        const message = JSON.parse(raw) as { type?: string; id?: number; method?: string; args?: JsonValue[]; ok?: boolean; value?: JsonValue; error?: WorkerErrorShape };
        if (!jsonValue(message)) fail("RPC_LIMIT_EXCEEDED", "Worker RPC must contain JSON-compatible values");
        if (message.type === "heartbeat") { clearTimeout(watchdog); watchdog = setTimeout(() => { stop("WORKER_UNRESPONSIVE", "Workflow worker missed its five-second heartbeat"); }, HEARTBEAT_TIMEOUT_MS); return; }
        if (message.type === "result") { encoded(message.value); finish(); resolve(message.value ?? null); return; }
        if (message.type === "error") { finish(); reject(workflowErrorFromWorker(message.error ?? { code: "INTERNAL_ERROR", message: "Worker failed" })); return; }
        if (message.type === "rpc" && message.id !== undefined) void handleRpc(message.id, message.method ?? "", message.args ?? []);
      } catch (error) { stop(error instanceof WorkflowError ? error.code : "INTERNAL_ERROR", error instanceof Error ? error.message : String(error)); }
    });
    child.on("error", (error: Error) => { stop("INTERNAL_ERROR", error.message); });
    child.on("exit", (code) => { if (!settled && code !== 0) stop("INTERNAL_ERROR", `Workflow child exited with code ${String(code)}`); });
  });
  function killChild() {
    if (!child.killed) {
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 1000).unref();
    }
  }
  function finish() { settled = true; clearTimeout(watchdog); signal?.removeEventListener("abort", cancel); killChild(); rmSync(childDir, { recursive: true, force: true }); }
  function stop(code: WorkflowErrorCode, message: string) { if (settled) return; controller.abort(); finish(); rejectResult(new WorkflowError(code, message)); }
  function branded(result: Record<string, JsonValue>): JsonValue { return { ...result, [WORK_RESULT_BRAND]: true }; }
  async function handleRpc(id: number, method: string, values: JsonValue[]) {
    try {
      encoded(values);
      let value: JsonValue = null;
      if (method === "agent") {
        if (!bridge.agent) fail("AGENT_FAILED", "No agent bridge is available");
        if (typeof values[0] !== "string") fail("INTERNAL_ERROR", "agent prompt must be a string");
        const opts = validateAgentOptions(values[1]);
        const identity = readAgentIdentity(values[2]);
        const path = agentIdentityPath(identity);
        const label = typeof opts.label === "string" ? opts.label : typeof opts.role === "string" ? opts.role : "agent";
        try {
          const result = await bridge.agent(values[0], opts, controller.signal, identity);
          value = branded({ name: label, ok: true, value: result ?? null });
        } catch (error) {
          const typed = asWorkflowError(error);
          if (!OUTCOME_ERRORS.has(typed.code)) throw typed;
          value = branded({ name: label, ok: false, failedAt: path, error: { code: typed.code, message: typed.message, ...(isWorkflowAuthored(typed) ? { authored: true } : {}) } });
        }
      } else if (method === "checkpoint") {
        if (!bridge.checkpoint || !object(values[0])) fail("INTERNAL_ERROR", "checkpoint requires an available bridge and object input");
        const name = typeof values[0].name === "string" ? values[0].name : "checkpoint";
        try {
          const result = await bridge.checkpoint(values[0], controller.signal);
          if (typeof result !== "boolean") fail("INTERNAL_ERROR", "checkpoint must return a boolean");
          value = branded({ name, ok: true, value: result ? "approved" : "rejected" });
        } catch (error) {
          const typed = asWorkflowError(error);
          if (!OUTCOME_ERRORS.has(typed.code)) throw typed;
          value = branded({ name, ok: false, failedAt: name, error: { code: typed.code, message: typed.message, ...(isWorkflowAuthored(typed) ? { authored: true } : {}) } });
        }
      } else if (method === "function") {
        const worktreeOwner = values[3] === undefined || values[3] === null ? undefined : typeof values[3] === "string" && values[3] ? values[3] : fail("INTERNAL_ERROR", "function worktree scope is invalid");
        const structuralPath = values[4] === undefined ? [] : values[4];
        if (!Array.isArray(structuralPath) || !structuralPath.every((part): part is string => typeof part === "string" && Boolean(part.trim()))) fail("INTERNAL_ERROR", "function structural scope is invalid");
        if (!bridge.function || typeof values[0] !== "string" || !object(values[1]) || typeof values[2] !== "string") fail("INTERNAL_ERROR", "function requires an available bridge, name, object input, and path");
        const name = values[0];
        try {
          const result = await bridge.function(values[0], values[1], values[2], controller.signal, worktreeOwner, structuralPath);
          value = branded({ name, ok: true, value: result ?? null });
        } catch (error) {
          const typed = asWorkflowError(error);
          if (!OUTCOME_ERRORS.has(typed.code)) throw typed;
          value = branded({ name, ok: false, failedAt: name, error: { code: typed.code, message: typed.message, ...(isWorkflowAuthored(typed) ? { authored: true } : {}) } });
        }
      } else if (method === "phase") {
        if (typeof values[0] !== "string") fail("INTERNAL_ERROR", "phase name must be a string");
        await bridge.phase?.(values[0]);
      } else if (method === "log") {
        if (typeof values[0] !== "string") fail("INTERNAL_ERROR", "log message must be a string");
        await bridge.log?.(values[0]);
      }
      else fail("INTERNAL_ERROR", `Unknown worker RPC method: ${method}`);
      encoded(value);
      child.send(encoded({ type: "rpcResult", id, ok: true, value }));
    } catch (error) {
      const typed = asWorkflowError(error);
      child.send(encoded({ type: "rpcResult", id, ok: false, error: { code: typed.code, message: typed.message, ...(isWorkflowAuthored(typed) ? { authored: true } : {}) } }));
    }
  }
  function cancel() {
    if (settled) return;
    controller.abort();
    child.send(encoded({ type: "cancel" }));
    stop("CANCELLED", "Workflow cancelled");
  }
  if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
  return { result, cancel };
}
function nativeSessionReference(attempt: Pick<AgentAttempt, "sessionId" | "sessionFile">): { sessionId: string; sessionFile: string } {
  return { sessionId: attempt.sessionId, sessionFile: attempt.sessionFile };
}

export async function persistActiveAgentAttempt(store: RunStore, id: string, active: Pick<AgentAttempt, "attempt" | "sessionId" | "sessionFile" | "setup">): Promise<void> {
  await store.updateState((run) => {
    const agent = run.agents.find((candidate) => candidate.id === id);
    if (!agent) throw new WorkflowError("INTERNAL_ERROR", `Missing production ownership record: ${id}`);
    const accounting = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const details = [...(agent.attemptDetails ?? []).filter((candidate) => candidate.attempt !== active.attempt), { ...active, accounting }];
    const nativeSessions = run.nativeSessions.some(({ sessionId }) => sessionId === active.sessionId) ? run.nativeSessions : [...run.nativeSessions, nativeSessionReference(active)];
    return { ...run, agents: run.agents.map((candidate) => candidate.id === id ? { ...candidate, attempts: Math.max(candidate.attempts, active.attempt), attemptDetails: details } : candidate), nativeSessions };
  });
}

export async function persistAgentAttempts(store: RunStore, id: string, attempts: readonly AgentAttempt[]): Promise<void> {
  await store.updateState((run) => {
    const agent = run.agents.find((candidate) => candidate.id === id);
    if (!agent) throw new WorkflowError("INTERNAL_ERROR", `Missing production ownership record: ${id}`);
    const total = attempts.reduce((sum, attempt) => ({ input: sum.input + attempt.accounting.input, output: sum.output + attempt.accounting.output, cacheRead: sum.cacheRead + attempt.accounting.cacheRead, cacheWrite: sum.cacheWrite + attempt.accounting.cacheWrite, cost: sum.cost + attempt.accounting.cost }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    const attemptDetails = attempts.map(({ attempt, sessionId, sessionFile, error, accounting, setup }) => ({ attempt, sessionId, sessionFile, ...(error ? { error } : {}), accounting, ...(setup ? { setup } : {}) }));
    const sessionIds = new Set(attempts.map(({ sessionId }) => sessionId));
    return { ...run, agents: run.agents.map((candidate) => candidate.id === id ? { ...candidate, attempts: attempts.length, attemptDetails, accounting: total } : candidate), nativeSessions: [...run.nativeSessions.filter(({ sessionId }) => !sessionIds.has(sessionId)), ...attempts.map((attempt) => nativeSessionReference(attempt))] };
  });
}

type WorkflowToolUpdate = { content: [{ type: "text"; text: string }]; details: { runId: string; run: PersistedRun } };

type AgentGroup = { label: string; entries: readonly { agent: AgentRecord; index: number; depth: number }[] };
function agentGroupKey(agent: AgentRecord): string { return JSON.stringify([agent.structuralPath ?? [], agent.parentBreadcrumb ?? null]); }
function agentGroupLabel(agents: readonly AgentRecord[]): string {
  const structural = agents[0]?.structuralPath ?? [];
  const breadcrumbs = [...new Set(agents.map((agent) => agent.parentBreadcrumb).filter((value): value is string => Boolean(value)))];
  return [...(structural.length ? [structural.join(" > ")] : []), ...(breadcrumbs.length === 1 ? breadcrumbs : breadcrumbs.length ? [breadcrumbs.join(" | ")] : [])].join(" > ") || "Agents";
}
function agentGroups(agents: readonly AgentRecord[]): AgentGroup[] {
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const groups = new Map<string, { agents: Array<{ agent: AgentRecord; index: number; depth: number }> }>();
  for (const [index, agent] of agents.entries()) {
    let depth = 0;
    for (let parent = agent.parentId; parent && byId.has(parent); parent = byId.get(parent)?.parentId) depth += 1;
    const key = agentGroupKey(agent);
    const group = groups.get(key) ?? { agents: [] };
    group.agents.push({ agent, index, depth });
    groups.set(key, group);
  }
  return [...groups].map(([, group]) => ({ label: agentGroupLabel(group.agents.map(({ agent }) => agent)), entries: group.agents }));
}
function renderGroupedAgents(agents: readonly AgentRecord[], render: (entry: { agent: AgentRecord; index: number; depth: number }, grouped: boolean) => string): string[] {
  const groups = agentGroups(agents);
  const grouped = groups.length > 1 || groups.some(({ label }) => label !== "Agents");
  return groups.flatMap((group) => [
    ...(grouped ? [`  ${group.label}`] : []),
    ...group.entries.map((entry) => render(entry, grouped)),
  ]);
}
export function formatWorkflowProgress(run: PersistedRun, spinner = "◇"): string {
  const done = run.agents.filter((agent) => SETTLED_AGENT_STATES.has(agent.state)).length;
  const lines = [`${run.state === "completed" ? "✓" : run.state === "failed" || run.state === "stopped" ? "✗" : run.state === "budget_exhausted" ? "!" : run.state === "running" ? spinner : "◆"} Workflow: ${run.workflowName} (${String(done)}/${String(run.agents.length)} done)`];
  if (run.phase) lines.push(`  Phase: ${run.phase}`);
  lines.push(...formatCompactBudgetStatus(run).map((line) => `  ${line}`));
  const byId = new Map(run.agents.map((agent) => [agent.id, agent]));
  lines.push(...renderGroupedAgents(run.agents, ({ agent, index, depth }, grouped) => {
    const icon = agent.state === "completed" ? "✓" : agent.state === "failed" || agent.state === "cancelled" ? "✗" : agent.state === "running" ? spinner : "○";
    const indent = "  ".repeat((grouped ? 2 : 1) + depth);
    const activity = SETTLED_AGENT_STATES.has(agent.state) ? "" : formatAgentActivity(agent, spinner);
    const name = grouped ? agent.label ?? agent.name : agentBreadcrumb(agent, byId);
    return `${indent}#${String(index + 1)} ${icon} ${name} [${agent.state}]${activity ? ` ${activity}` : ""}`;
  }));
  return lines.join("\n");
}

function workflowToolUpdate(run: PersistedRun): WorkflowToolUpdate {
  return { content: [{ type: "text", text: formatWorkflowProgress(run) }], details: { runId: run.id, run } };
}

const workflowSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function textBlock(text: string) {
  return {
    render(width: number) {
      return text.split("\n").map((line) => line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`);
    },
    invalidate() {},
  };
}

function workflowProgressBlock(run: PersistedRun) {
  return {
    render(width: number) {
      const frame = workflowSpinner[Math.floor(Date.now() / 80) % workflowSpinner.length] ?? "◇";
      return formatWorkflowProgress(run, frame).split("\n").map((line) => line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`);
    },
    invalidate() {},
  };
}
export function formatBudgetStatus(run: Pick<PersistedRun, "budget" | "budgetVersion" | "usage" | "budgetEvents">): string[] {
  const usage = budgetUsage(run.usage);
  if (!run.budget || !Object.keys(run.budget).length) return ["Budget: unlimited"];
  const lines = [`Budget version ${String(run.budgetVersion ?? 1)}`];
  for (const dimension of ["tokens", "costUsd", "durationMs", "agentLaunches"] as const) {
    const limits = run.budget[dimension];
    if (!limits || (limits.soft === undefined && limits.hard === undefined)) continue;
    const limit = limits.hard ?? limits.soft;
    const percent = limit === undefined ? "" : ` ${limit === 0 ? "100.0" : ((usage[dimension] / limit) * 100).toFixed(1)}%`;
    const state = (run.budgetEvents ?? []).filter((event) => event.dimensions.includes(dimension)).at(-1)?.type;
    lines.push(`  ${dimension}: ${String(usage[dimension])}${limits.soft !== undefined ? ` soft=${String(limits.soft)}` : ""}${limits.hard !== undefined ? ` hard=${String(limits.hard)}` : ""}${percent}${state ? ` state=${state}` : ""}`);
  }
  const events = run.budgetEvents ?? [];
  if (events.length) lines.push(`  events: ${events.map((event) => `${event.type}@v${String(event.budgetVersion)}`).join(", ")}`);
  return lines;
}

function formatCompactBudgetStatus(run: Pick<PersistedRun, "budget" | "budgetVersion" | "usage" | "budgetEvents">): string[] {
  if (!Object.values(run.budget ?? {}).some((limits) => limits.soft !== undefined || limits.hard !== undefined)) return [];
  return formatBudgetStatus(run);
}

const ATTENTION_ORDER: Record<string, number> = { awaiting_input: 0, budget_exhausted: 1, running: 2, pausing: 3, paused: 4, interrupted: 5, failed: 6, queued: 7, stopped: 8, completed: 9 };

function navigatorAttentionSort<T extends { loaded: { run: PersistedRun } }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => (ATTENTION_ORDER[a.loaded.run.state] ?? 9) - (ATTENTION_ORDER[b.loaded.run.state] ?? 9));
}

function navigatorRunLabels(entries: readonly { store: RunStore; loaded: { run: PersistedRun } }[]): string[] {
  const nameCount = new Map<string, number>();
  for (const { loaded: { run } } of entries) nameCount.set(run.workflowName, (nameCount.get(run.workflowName) ?? 0) + 1);
  return entries.map(({ store, loaded: { run } }) => {
    const done = run.agents.filter((a) => SETTLED_AGENT_STATES.has(a.state)).length;
    const glyph = run.state === "completed" ? "✓" : run.state === "failed" || run.state === "stopped" ? "✗" : run.state === "budget_exhausted" ? "!" : run.state === "running" ? "⠦" : run.state === "awaiting_input" ? "●" : "◆";
    const suffix = (nameCount.get(run.workflowName) ?? 0) > 1 ? ` ${store.runId.slice(0, 8)}` : "";
    const cost = run.agents.reduce((sum, a) => sum + (a.accounting?.cost ?? 0), 0);
    const costStr = cost > 0 ? ` $${cost.toFixed(2)}` : "";
    return `${glyph} ${run.workflowName}${suffix}  ${run.state}  ${run.phase ?? ""}  ${String(done)}/${String(run.agents.length)} agents${costStr}`;
  });
}

function agentBreadcrumb(agent: AgentRecord, byId: Map<string, AgentRecord>): string {
  const name = agent.label ?? agent.name;
  const parts: string[] = agent.parentBreadcrumb ? [agent.parentBreadcrumb] : [];
  const seen = new Set<string>([agent.id]);
  for (let parentId = agent.parentId; parentId; parentId = byId.get(parentId)?.parentId) {
    if (seen.has(parentId)) break; // ponytail: cycle guard for corrupt data
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (parent) parts.push(parent.label ?? parent.name);
    else break;
  }
  parts.push(name);
  return parts.length > 1 ? parts.join(" > ") : name;
}

function formatAgentActivity(agent: AgentRecord, spinner: string): string {
  if (agent.activity?.kind === "reasoning") return `${spinner} reasoning`;
  if (agent.activity?.kind === "text") return `${spinner} responding`;
  if (agent.activity?.kind === "tool") return `${spinner} ${agent.activity.text}`;
  const tool = [...(agent.toolCalls ?? [])].reverse().find(({ state }) => state === "running");
  return tool ? `${spinner} ${tool.name}` : "";
}

function formatAccounting(accounting: NonNullable<AgentRecord["accounting"]>): string {
  const total = accounting.input + accounting.output + accounting.cacheRead + accounting.cacheWrite;
  return `${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(total).toLowerCase()} tok`;
}


export function formatNavigatorDashboard(run: PersistedRun, checkpoints: readonly AwaitingCheckpoint[], worktrees: readonly WorktreeReference[]): string {
  void worktrees;
  const done = run.agents.filter((a) => SETTLED_AGENT_STATES.has(a.state)).length;
  const totalAccounting = run.agents.reduce((sum, a) => ({ input: sum.input + (a.accounting?.input ?? 0), output: sum.output + (a.accounting?.output ?? 0), cacheRead: sum.cacheRead + (a.accounting?.cacheRead ?? 0), cacheWrite: sum.cacheWrite + (a.accounting?.cacheWrite ?? 0), cost: sum.cost + (a.accounting?.cost ?? 0) }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const hasAccounting = run.agents.some((a) => a.accounting);
  const glyph = run.state === "completed" ? "✓" : run.state === "failed" || run.state === "stopped" ? "✗" : run.state === "budget_exhausted" ? "!" : run.state === "running" ? "⠦" : run.state === "awaiting_input" ? "●" : "◆";
  const header = `${glyph} ${run.workflowName}`;
  const meta = [run.state, run.phase ? `phase: ${run.phase}` : "", `${String(done)}/${String(run.agents.length)} agents`, hasAccounting ? formatAccounting(totalAccounting) : "", totalAccounting.cost > 0 ? `$${totalAccounting.cost.toFixed(2)}` : ""].filter(Boolean).join(" · ");
  const lines = [header, meta, ...formatCompactBudgetStatus(run)];
  if (run.error) lines.push(`Error: ${run.error.code}: ${run.error.message}`);
  if (run.events?.length) lines.push(...run.events.map((event) => `Warning: ${event.message}`));
  lines.push("");
  const byId = new Map(run.agents.map((a) => [a.id, a]));
  const render = ({ agent, depth }: { agent: AgentRecord; index: number; depth: number }, grouped: boolean) => {
    const icon = agent.state === "completed" ? "✓" : agent.state === "failed" || agent.state === "cancelled" ? "✗" : agent.state === "running" ? "⠦" : "○";
    const breadcrumb = grouped ? agent.label ?? agent.name : agentBreadcrumb(agent, byId);
    const tokens = agent.accounting ? formatAccounting(agent.accounting) : "";
    const indent = "  ".repeat((grouped ? 2 : 1) + depth);
    const result = [`${indent}${icon} ${breadcrumb} · ${agent.state}${tokens ? ` · ${tokens}` : ""}`];
    if (agent.state === "failed" && agent.attemptDetails?.length) {
      const last = agent.attemptDetails[agent.attemptDetails.length - 1];
      if (last?.error) result.push(`${indent}  error: ${last.error.code}: ${last.error.message}`);
    }
    const activity = !SETTLED_AGENT_STATES.has(agent.state) ? formatAgentActivity(agent, "⠦") : "";
    if (activity) result.push(`${indent}  ${activity}`);
    return result.join("\n");
  };
  lines.push(...renderGroupedAgents(run.agents, render));
  if (checkpoints.length) { lines.push(""); for (const cp of checkpoints) lines.push(`● checkpoint ${cp.name}: ${cp.prompt}`); }
  return lines.join("\n");
}

export function formatNavigatorRun(loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> }, checkpoints: readonly AwaitingCheckpoint[], _worktrees: readonly WorktreeReference[]): string {
  const { run, snapshot } = loaded;
  const lines = [
    `Workflow: ${run.workflowName}`,
    `Run: ${run.id}`,
    `Status: ${run.state}`,
    `Phase: ${run.phase ?? "(none)"}`,
    `Launch cwd: ${run.cwd}`,
    ...formatCompactBudgetStatus(run),
    `Launch models: ${snapshot.models.join(", ") || "(none)"}`,
  ];
  if (run.error) lines.push(`Run error: ${run.error.code}: ${run.error.message}`);
  if (run.events?.length) lines.push(...run.events.map((event) => `Warning: ${event.message}`));
  const aliases = snapshot.modelAliases ?? snapshot.settings.modelAliases;
  if (aliases && Object.keys(aliases).length) lines.push(`Model aliases: ${Object.entries(aliases).map(([name, target]) => `${name}=${target}`).join(", ")}`);
  lines.push("Agents / ownership:");
  if (!run.agents.length) lines.push("  (none)");
  const byId = new Map(run.agents.map((agent) => [agent.id, agent]));
  lines.push(...renderGroupedAgents(run.agents, ({ agent, index, depth }, grouped) => {
    const model = `${agent.model.provider}/${agent.model.model}${agent.model.thinking ? `:${agent.model.thinking}` : ""}`;
    const role = agent.role ? ` role=${agent.role}` : "";
    const tools = ` tools=${agent.tools.join(",") || "(none)"}`;
    const accounting = agent.accounting ? ` input=${String(agent.accounting.input)} output=${String(agent.accounting.output)} cache-read=${String(agent.accounting.cacheRead)} cache-write=${String(agent.accounting.cacheWrite)} cost=${String(agent.accounting.cost)}` : "";
    const indent = "  ".repeat((grouped ? 2 : 1) + depth);
    const result = [`${indent}#${String(index + 1)} ${grouped ? agent.label ?? agent.name : agentBreadcrumb(agent, byId)} state=${agent.state} model=${model}${agent.requestedModel ? ` requested=${agent.requestedModel}` : ""}${role}${tools} attempts=${String(agent.attempts)} retries=${String(Math.max(0, agent.attempts - 1))}${accounting}`];
    for (const attempt of agent.attemptDetails ?? []) result.push(`${indent}  attempt ${String(attempt.attempt)}${attempt.error ? ` error=${attempt.error.code}: ${attempt.error.message}` : ""}`);
    for (const call of agent.toolCalls ?? []) result.push(`${indent}  tool ${call.name} state=${call.state}`);
    return result.join("\n");
  }));
  lines.push("Checkpoints:");
  if (!checkpoints.length) lines.push("  (none)");
  for (const checkpoint of checkpoints) lines.push(`  ${checkpoint.name}: ${checkpoint.prompt} context=${JSON.stringify(checkpoint.context)}`);
  lines.push(`Worktrees: ${String(_worktrees.length)}`);
  lines.push(`Native Pi transcripts: ${String(run.nativeSessions.length)}`);
  return lines.join("\n");
}
function formatCheckpointReview(checkpoint: AwaitingCheckpoint): string {
  return [`Name: ${checkpoint.name}`, "Prompt:", checkpoint.prompt, "Context:", JSON.stringify(checkpoint.context, null, 2)].join("\n");
}

const DELIVERY_LIMIT_BYTES = 4 * 1024;
const WORKFLOW_LOG_ENTRY = "workflow-log";
interface WorkflowLogEntry { workflowName: string; message: string }

function completionDelivery(name: string, value: JsonValue, resultPath: string, worktrees: readonly { branch: string; path: string }[]): string {
  const locations = worktrees.length ? ` Changes: ${worktrees.map(({ branch, path }) => `${branch} (${path})`).join(", ")}.` : "";
  const message = `Workflow ${name} completed: ${JSON.stringify(value)}${locations}`;
  if (Buffer.byteLength(message) <= DELIVERY_LIMIT_BYTES) return message;
  const suffix = `... Full result: ${resultPath}${locations}`;
  const suffixBytes = Buffer.byteLength(suffix);
  if (suffixBytes >= DELIVERY_LIMIT_BYTES) return utf8Prefix(suffix, DELIVERY_LIMIT_BYTES);
  return utf8Prefix(message, DELIVERY_LIMIT_BYTES - suffixBytes) + suffix;
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  let end = Math.min(bytes.length, maxBytes);
  while (end < bytes.length && end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}
const DIAGNOSTIC_LIMIT_BYTES = DELIVERY_LIMIT_BYTES - 512;
function failureDiagnosticsFrom(error: unknown): WorkflowFailureDiagnostics | undefined {
  if (!error || typeof error !== "object") return undefined;
  return (error as { [WORKFLOW_FAILURE_DIAGNOSTICS]?: WorkflowFailureDiagnostics })[WORKFLOW_FAILURE_DIAGNOSTICS];
}

function boundedWorkflowFailureDiagnostics(value: WorkflowFailureDiagnostics): WorkflowFailureDiagnostics {
  let bounded: WorkflowFailureDiagnostics = {
    runId: utf8Prefix(value.runId, 128),
    workflowName: utf8Prefix(value.workflowName, 256),
    state: value.state,
    failedAt: value.failedAt === null ? null : utf8Prefix(value.failedAt, 1024),
    error: { code: value.error.code, message: utf8Prefix(value.error.message, 1024) },
    ...(value.failedAgent ? { failedAgent: {
      id: utf8Prefix(value.failedAgent.id, 128),
      ...(value.failedAgent.label ? { label: utf8Prefix(value.failedAgent.label, 128) } : {}),
      ...(value.failedAgent.role ? { role: utf8Prefix(value.failedAgent.role, 128) } : {}),
      structuralPath: value.failedAgent.structuralPath.slice(0, 8).map((part) => utf8Prefix(part, 128)),
      attempt: value.failedAgent.attempt,
      ...(value.failedAgent.sessionId ? { sessionId: utf8Prefix(value.failedAgent.sessionId, 256) } : {}),
      ...(value.failedAgent.sessionFile ? { sessionFile: utf8Prefix(value.failedAgent.sessionFile, 1024) } : {}),
    } } : {}),
    completedSiblingPaths: value.completedSiblingPaths.slice(0, 16).map((path) => path.slice(0, 8).map((part) => utf8Prefix(part, 128))),
    artifacts: { runDirectory: utf8Prefix(value.artifacts.runDirectory, 1024), statePath: utf8Prefix(value.artifacts.statePath, 1024), journalPath: utf8Prefix(value.artifacts.journalPath, 1024) },
  };
  const size = () => Buffer.byteLength(JSON.stringify(bounded));
  while (size() > DIAGNOSTIC_LIMIT_BYTES) {
    if (bounded.completedSiblingPaths.length) { bounded = { ...bounded, completedSiblingPaths: bounded.completedSiblingPaths.slice(0, -1) }; continue; }
    if (bounded.failedAgent?.sessionFile) { const failedAgent = { ...bounded.failedAgent }; delete failedAgent.sessionFile; bounded = { ...bounded, failedAgent }; continue; }
    if (bounded.failedAgent?.sessionId) { const failedAgent = { ...bounded.failedAgent }; delete failedAgent.sessionId; bounded = { ...bounded, failedAgent }; continue; }
    if (Buffer.byteLength(bounded.artifacts.runDirectory) > 256) { bounded = { ...bounded, artifacts: { ...bounded.artifacts, runDirectory: utf8Prefix(bounded.artifacts.runDirectory, 256) } }; continue; }
    if (Buffer.byteLength(bounded.error.message) > 256) { bounded = { ...bounded, error: { ...bounded.error, message: utf8Prefix(bounded.error.message, 256) } }; continue; }
    if (bounded.failedAt !== null && Buffer.byteLength(bounded.failedAt) > 256) { bounded = { ...bounded, failedAt: utf8Prefix(bounded.failedAt, 256) }; continue; }
    if (bounded.failedAgent && bounded.failedAgent.structuralPath.length > 4) { bounded = { ...bounded, failedAgent: { ...bounded.failedAgent, structuralPath: bounded.failedAgent.structuralPath.slice(0, 4) } }; continue; }
    if (bounded.failedAgent?.structuralPath.some((part) => Buffer.byteLength(part) > 64)) { bounded = { ...bounded, failedAgent: { ...bounded.failedAgent, structuralPath: bounded.failedAgent.structuralPath.map((part) => utf8Prefix(part, 64)) } }; continue; }
    if (Buffer.byteLength(bounded.artifacts.statePath) > 512 || Buffer.byteLength(bounded.artifacts.journalPath) > 512) { bounded = { ...bounded, artifacts: { ...bounded.artifacts, statePath: utf8Prefix(bounded.artifacts.statePath, 512), journalPath: utf8Prefix(bounded.artifacts.journalPath, 512) } }; continue; }
    if (Buffer.byteLength(bounded.workflowName) > 128) { bounded = { ...bounded, workflowName: utf8Prefix(bounded.workflowName, 128) }; continue; }
    break;
  }
  return bounded;
}

function createWorkflowFailureDiagnostics(store: RunStore, metadata: WorkflowMetadata, error: unknown, run: PersistedRun): WorkflowFailureDiagnostics {
  const rawFailedAt = error && typeof error === "object" ? (error as { failedAt?: unknown }).failedAt : undefined;
  const failedAt = typeof rawFailedAt === "string" && rawFailedAt ? rawFailedAt : null;
  const failedAgents = run.agents.filter((agent) => agent.state === "failed");
  const failedAgentRecord = failedAgents.find((agent) => {
    if (failedAt === null) return false;
    try { return failedAt.includes(`${operationPath("agent", ...(agent.structuralPath ?? []))}/`); } catch { return false; }
  }) ?? failedAgents.at(-1);
  const failedAttempt = failedAgentRecord ? [...(failedAgentRecord.attemptDetails ?? [])].reverse().find((attempt) => attempt.error) ?? failedAgentRecord.attemptDetails?.at(-1) : undefined;
  const failedAgent = failedAgentRecord ? {
    id: failedAgentRecord.id,
    ...(failedAgentRecord.label ?? failedAgentRecord.name ? { label: failedAgentRecord.label ?? failedAgentRecord.name } : {}),
    ...(failedAgentRecord.role ? { role: failedAgentRecord.role } : {}),
    structuralPath: [...(failedAgentRecord.structuralPath ?? [])],
    attempt: Math.max(1, failedAttempt?.attempt ?? failedAgentRecord.attempts),
    ...(failedAttempt?.sessionId ? { sessionId: failedAttempt.sessionId } : {}),
    ...(failedAttempt?.sessionFile ? { sessionFile: failedAttempt.sessionFile } : {}),
  } satisfies WorkflowFailureAgent : undefined;
  const completedSiblingPaths = run.agents.filter((agent) => {
    if (agent.state !== "completed" || agent.id === failedAgentRecord?.id) return false;
    return failedAgentRecord?.parentId === undefined ? agent.parentId === undefined : agent.parentId === failedAgentRecord.parentId;
  }).map((agent) => [...(agent.structuralPath ?? [])]);
  return boundedWorkflowFailureDiagnostics({
    runId: run.id, workflowName: metadata.name, state: run.state, failedAt,
    error: { code: errorCode(error) ?? "INTERNAL_ERROR", message: errorText(error) || "The workflow failed without an error message." },
    ...(failedAgent ? { failedAgent } : {}), completedSiblingPaths,
    artifacts: { runDirectory: store.directory, statePath: join(store.directory, "state.json"), journalPath: join(store.directory, "journal.json") },
  });
}

export function formatWorkflowFailureDiagnostics(diagnostic: WorkflowFailureDiagnostics): string {
  const failedAgent = diagnostic.failedAgent ? `${diagnostic.failedAgent.label ?? diagnostic.failedAgent.id}${diagnostic.failedAgent.role ? ` role=${diagnostic.failedAgent.role}` : ""} attempt=${String(diagnostic.failedAgent.attempt)} path=${diagnostic.failedAgent.structuralPath.join(" > ") || "(root)"}${diagnostic.failedAgent.sessionFile ? ` session=${diagnostic.failedAgent.sessionFile}` : ""}` : "(not persisted)";
  const siblings = diagnostic.completedSiblingPaths.map((path) => path.join(" > ") || "(root)").join(", ") || "(none)";
  return [`✗ Workflow: ${diagnostic.workflowName}`, `  Run: ${diagnostic.runId}`, `  State: ${diagnostic.state}`, `  Error: ${diagnostic.error.code}: ${diagnostic.error.message}`, `  Failed at: ${diagnostic.failedAt ?? "(unknown)"}`, `  Failed agent: ${failedAgent}`, `  Completed sibling paths: ${siblings}`, `  Artifacts: state=${diagnostic.artifacts.statePath} journal=${diagnostic.artifacts.journalPath}`].join("\n");
}

function serializeWorkflowFailureDiagnostics(diagnostic: WorkflowFailureDiagnostics): string { return JSON.stringify(diagnostic); }
function isWorkflowFailureDiagnostics(value: unknown): value is WorkflowFailureDiagnostics {
  return object(value) && typeof value.runId === "string" && typeof value.workflowName === "string" && typeof value.state === "string" && "failedAt" in value && object(value.error) && object(value.artifacts);
}
function deliver(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: "workflow", content, display: true }, { deliverAs: "followUp", triggerTurn: true });
}
function deliverFailure(pi: ExtensionAPI, diagnostic: WorkflowFailureDiagnostics): void {
  deliver(pi, `Workflow ${utf8Prefix(diagnostic.workflowName, 128)} failure diagnostics: ${serializeWorkflowFailureDiagnostics(diagnostic)}`);
}

type WorkflowEventSink = { emit: (name: string, payload: unknown) => unknown };

function safeEventError(error: unknown): WorkflowErrorShape {
  const code = errorCode(error) ?? "INTERNAL_ERROR";
  return { code, message: `Workflow execution failed (${code})` };
}

class WorkflowEventPublisher {
  #queues = new Map<string, Promise<void>>();
  #budgetEvents = new Map<string, Set<string>>();
  #worktrees = new Map<string, Set<string>>();

  constructor(private readonly sink: WorkflowEventSink | undefined) {}

  seedBudget(runId: string, events: readonly BudgetEvent[] | undefined): void {
    const seen = this.#budgetEvents.get(runId) ?? new Set<string>();
    for (const event of events ?? []) seen.add(this.budgetKey(event));
    this.#budgetEvents.set(runId, seen);
  }

  async runStarted(store: RunStore, metadata: WorkflowMetadata): Promise<void> { await this.#publish(store, metadata, WORKFLOW_RUN_STARTED_EVENT, {}); }
  async runResumed(store: RunStore, metadata: WorkflowMetadata): Promise<void> { await this.#publish(store, metadata, WORKFLOW_RUN_RESUMED_EVENT, {}); }

  async runState(store: RunStore, metadata: WorkflowMetadata, previousState: RunState, state: RunState, reason?: string): Promise<void> {
    await this.#publish(store, metadata, WORKFLOW_RUN_STATE_CHANGED_EVENT, { previousState, state, ...(reason ? { reason } : {}), ...(ERROR_CODES.includes(reason as WorkflowErrorCode) ? { errorCode: reason } : {}) });
    if ((previousState === "paused" || previousState === "interrupted" || previousState === "budget_exhausted") && state === "running") await this.runResumed(store, metadata);
  }

  async runCompleted(store: RunStore, metadata: WorkflowMetadata, resultPath: string): Promise<void> { await this.#publish(store, metadata, WORKFLOW_RUN_COMPLETED_EVENT, { resultPath }); }
  async runFailed(store: RunStore, metadata: WorkflowMetadata, error: unknown, state: "failed" | "stopped" | "interrupted" | "budget_exhausted"): Promise<void> {
    if (state === "failed") await this.#publish(store, metadata, WORKFLOW_RUN_FAILED_EVENT, { error: safeEventError(error) });
  }

  async agentState(store: RunStore, metadata: WorkflowMetadata, previous: AgentRecord | undefined, agent: AgentRecord): Promise<void> {
    await this.#publish(store, metadata, WORKFLOW_AGENT_STATE_CHANGED_EVENT, { agentId: agent.id, displayLabel: agent.label ?? agent.name, ...(agent.role ? { role: agent.role } : {}), structuralPath: [...(agent.structuralPath ?? [])], ...(agent.parentId ? { parentId: agent.parentId } : {}), ...(agent.parentBreadcrumb ? { parentBreadcrumb: agent.parentBreadcrumb } : {}), ...(agent.worktreeOwner ? { worktreeOwner: agent.worktreeOwner } : {}), ...(previous ? { previousState: previous.state } : {}), state: agent.state, attempt: agent.attempts });
  }

  async agentStates(store: RunStore, metadata: WorkflowMetadata, previous: readonly AgentRecord[], current: readonly AgentRecord[]): Promise<void> {
    const previousById = new Map(previous.map((agent) => [agent.id, agent]));
    for (const agent of current) {
      const old = previousById.get(agent.id);
      if (!old || old.state !== agent.state || old.attempts !== agent.attempts) await this.agentState(store, metadata, old, agent);
    }
  }

  async phase(store: RunStore, metadata: WorkflowMetadata, previousPhase: string | undefined, phase: string): Promise<void> {
    if (previousPhase !== phase) await this.#publish(store, metadata, WORKFLOW_PHASE_CHANGED_EVENT, { ...(previousPhase !== undefined ? { previousPhase } : {}), phase });
  }

  async checkpoint(store: RunStore, metadata: WorkflowMetadata, name: string, state: WorkflowCheckpointState): Promise<void> { await this.#publish(store, metadata, WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, { name, state }); }

  async budget(store: RunStore, metadata: WorkflowMetadata, run: Pick<PersistedRun, "budgetEvents">): Promise<void> {
    const seen = this.#budgetEvents.get(store.runId) ?? new Set<string>();
    this.#budgetEvents.set(store.runId, seen);
    for (const event of run.budgetEvents ?? []) {
      const key = this.budgetKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      await this.#publish(store, metadata, WORKFLOW_BUDGET_EVENT, { ...event, timestamp: event.at });
    }
  }

  async worktree(store: RunStore, metadata: WorkflowMetadata, worktree: WorktreeReference): Promise<void> {
    const seen = this.#worktrees.get(store.runId) ?? new Set<string>();
    this.#worktrees.set(store.runId, seen);
    if (seen.has(worktree.owner)) return;
    seen.add(worktree.owner);
    await this.#publish(store, metadata, WORKFLOW_WORKTREE_CREATED_EVENT, { owner: worktree.owner, branch: worktree.branch, path: worktree.path, base: worktree.base });
  }

  async #publish(store: RunStore, metadata: WorkflowMetadata, name: string, payload: Record<string, unknown>): Promise<void> {
    const base: WorkflowEventBase = { runId: store.runId, sessionId: store.sessionId, workflowName: metadata.name, cwd: store.cwd, runDirectory: store.directory, timestamp: Date.now() };
    const previous = this.#queues.get(store.runId) ?? Promise.resolve();
    const next = previous.then(() => {
      try { void Promise.resolve(this.sink?.emit(name, { ...base, ...payload })).catch(() => undefined); } catch { /* Best effort: listeners cannot affect a run. */ }
    });
    this.#queues.set(store.runId, next.catch(() => undefined));
    await next;
  }

  private budgetKey(event: BudgetEvent): string { return `${String(event.budgetVersion)}:${event.type}:${event.proposalId ?? ""}`; }
}

const inheritedHostAgentPath = new AsyncLocalStorage<readonly string[]>();
const inheritedHostWorktreeOwner = new AsyncLocalStorage<string>();


function namedRecord(value: unknown, kind: string): Array<[string, unknown]> {
  if (!object(value)) fail("INVALID_METADATA", `${kind} must be a record`);
  return Object.entries(value);
}
function hostWithWorktree(args: readonly unknown[], identity: string, occurrences: Map<string, number>): Promise<JsonValue> {
  if (args.length !== 1 && args.length !== 2) fail("INVALID_METADATA", "withWorktree requires a callback or a name and callback");
  const callback = args[args.length - 1];
  if (typeof callback !== "function") fail("INVALID_METADATA", "withWorktree callback must be a function");
  let owner: string;
  if (args.length === 2) {
    if (typeof args[0] !== "string" || !args[0].trim()) fail("INVALID_METADATA", "withWorktree name must be a non-empty string");
    owner = operationPath("worktree", "named", args[0].trim());
  } else {
    const structuralPath = inheritedHostAgentPath.getStore() ?? [];
    const key = `${identity}\0${JSON.stringify(structuralPath)}`;
    const occurrence = (occurrences.get(key) ?? 0) + 1;
    occurrences.set(key, occurrence);
    owner = operationPath("worktree", "unnamed", "function", identity, ...structuralPath, `occurrence:${String(occurrence)}`);
  }
  return inheritedHostWorktreeOwner.run(owner, async () => await (callback as () => unknown)()) as Promise<JsonValue>;
}
function workflowRunContext(cwd: string, sessionId: string, runId: string, workflow: WorkflowMetadata, args: JsonValue, signal: AbortSignal): Readonly<WorkflowRunContext> {
  return Object.freeze({ cwd, sessionId, runId, workflow: deepFreeze(structuredClone(workflow)), args: deepFreeze(structuredClone(args)), signal });
}

async function resolveWorkflowVariables(run: Readonly<WorkflowRunContext>, controller: AbortController, registry: WorkflowRegistryApi): Promise<Readonly<Record<string, JsonValue>>> {
  let first: WorkflowError | undefined;
  const tasks = registry.variables().map(async ({ name, variable }) => {
    try {
      const result: unknown = await variable.resolve(run);
      if (!jsonValue(result) || !Value.Check(variable.schema, result)) fail("RESULT_INVALID", `Invalid output from ${name}`);
      return [name, deepFreeze(structuredClone(result))] as const;
    } catch (error) {
      const typed = errorCode(error) ? new WorkflowError(errorCode(error) as WorkflowErrorCode, `${name}: ${errorText(error)}`) : new WorkflowError("INTERNAL_ERROR", `${name}: ${errorText(error)}`);
      if (!first) { first = typed; controller.abort(); }
      throw typed;
    }
  });
  await Promise.allSettled(tasks);
  if (first) throw first;
  return Object.freeze(Object.fromEntries((await Promise.all(tasks)).map(([name, value]) => [name, value])));
}

async function hostParallel(rawOperation: unknown, rawTasks: unknown): Promise<JsonValue> {
  if (typeof rawOperation !== "string" || !rawOperation.trim()) fail("INVALID_METADATA", "parallel requires a stable explicit name");
  const tasks = namedRecord(rawTasks, "parallel tasks");
  for (const [name, run] of tasks) {
    if (!name.trim()) fail("INVALID_METADATA", "parallel task requires a stable explicit name");
    if (typeof run !== "function") fail("INVALID_METADATA", "parallel task values must be run functions");
  }
  const results = await Promise.all(tasks.map(async ([name, run]) => {
    try {
      const parent = inheritedHostAgentPath.getStore() ?? [];
      return { name, value: await inheritedHostAgentPath.run([...parent, rawOperation, name], run as () => unknown) as JsonValue };
    } catch (error) {
      const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
      if (typed.code === "CANCELLED") throw typed;
      return { name, error: typed };
    }
  }));
  const failure = results.find((result) => result.error);
  if (failure?.error) throw failure.error;
  return Object.fromEntries(results.map((result) => [result.name, result.value as JsonValue]));
}

async function hostPipeline(rawOperation: unknown, rawItems: unknown, rawStages: unknown): Promise<JsonValue> {
  if (typeof rawOperation !== "string" || !rawOperation.trim()) fail("INVALID_METADATA", "pipeline requires a stable explicit name");
  const items = namedRecord(rawItems, "pipeline items");
  const stages = namedRecord(rawStages, "pipeline stages");
  if (!stages.length) fail("INVALID_METADATA", "pipeline requires at least one stage");
  for (const [name] of items) if (!name.trim()) fail("INVALID_METADATA", "pipeline item requires a stable explicit name");
  for (const [stageName, run] of stages) {
    if (!stageName.trim()) fail("INVALID_METADATA", "pipeline stage requires a stable explicit name");
    if (typeof run !== "function") fail("INVALID_METADATA", "pipeline stage values must be run functions");
  }
  const results = await Promise.all(items.map(async ([name, initial]) => {
    let current = initial;
    try {
      for (const [stageName, run] of stages) {
        const parent = inheritedHostAgentPath.getStore() ?? [];
        current = await inheritedHostAgentPath.run([...parent, rawOperation, name, stageName], () => (run as (value: unknown) => unknown)(current));
      }
      return { name, value: current as JsonValue };
    } catch (error) {
      const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
      if (typed.code === "CANCELLED") throw typed;
      return { name, error: typed };
    }
  }));
  const failure = results.find((result) => result.error);
  if (failure?.error) throw failure.error;
  return Object.fromEntries(results.map((result) => [result.name, result.value as JsonValue]));
}

function nextNamedOccurrence(counters: Map<string, number>, label: string): string {
  const count = (counters.get(label) ?? 0) + 1;
  counters.set(label, count);
  return count === 1 ? label : `${label}#${String(count)}`;
}

function withWorkflowFunctions(bridge: WorkflowBridge, store: RunStore, runContext: Readonly<WorkflowRunContext>, variables: Readonly<Record<string, JsonValue>>, registry: WorkflowRegistryApi): WorkflowBridge {
  const functionAgentOccurrences = new Map<string, number>();
  const functionWorktreeOccurrences = new Map<string, number>();
  const functionInvokeOccurrences = new Map<string, number>();
  const invokeFunction = async (name: string, input: Readonly<Record<string, JsonValue>>, path: string, signal: AbortSignal, worktreeOwner?: string, structuralPath: readonly string[] = [], breadcrumb?: string): Promise<JsonValue> => {
    const replayed = await store.replay(path);
    let stored: JsonValue | undefined;
    const sideEffects: Promise<void>[] = [];
    const functionBreadcrumb = breadcrumb ?? name;
    const context: WorkflowFunctionContext = {
      run: runContext,
      invoke: async (targetName, targetInput) => {
        const inherited = inheritedHostAgentPath.getStore() ?? structuralPath;
        const scopedWorktreeOwner = inheritedHostWorktreeOwner.getStore() ?? worktreeOwner;
        const key = JSON.stringify([path, inherited, targetName]);
        const occurrence = (functionInvokeOccurrences.get(key) ?? 0) + 1;
        functionInvokeOccurrences.set(key, occurrence);
        const nestedPath = operationPath("function", "nested", path, ...inherited, targetName, `occurrence:${String(occurrence)}`);
        return invokeFunction(targetName, targetInput, nestedPath, signal, scopedWorktreeOwner, inherited, `${functionBreadcrumb} > ${targetName}`);
      },
      agent: async (...args: readonly unknown[]) => {
        if (!bridge.agent || typeof args[0] !== "string") fail("AGENT_FAILED", "No agent bridge is available");
        const options = validateAgentOptions(args[1] === undefined ? {} : args[1]);
        const scopedWorktreeOwner = inheritedHostWorktreeOwner.getStore() ?? worktreeOwner;
        const inherited = inheritedHostAgentPath.getStore() ?? [];
        const key = `${path}\0${JSON.stringify(inherited)}`;
        const occurrence = (functionAgentOccurrences.get(key) ?? 0) + 1;
        functionAgentOccurrences.set(key, occurrence);
        return bridge.agent(args[0], options, signal, { structuralPath: [...inherited], callSite: `function:${path}`, occurrence, parentBreadcrumb: functionBreadcrumb, ...(scopedWorktreeOwner ? { worktreeOwner: scopedWorktreeOwner } : {}) });
      },
      prompt: workflowPrompt,
      parallel: (...args: readonly unknown[]) => hostParallel(args[0], args[1]),
      pipeline: (...args: readonly unknown[]) => hostPipeline(args[0], args[1], args[2]),
      withWorktree: (...args: readonly unknown[]) => hostWithWorktree(args, path, functionWorktreeOccurrences),
      checkpoint: async (...args: readonly unknown[]) => {
        if (!bridge.checkpoint || !object(args[0]) || !jsonValue(args[0])) fail("INTERNAL_ERROR", "No checkpoint bridge is available");
        return bridge.checkpoint(args[0], signal);
      },
      phase: (name: string) => { sideEffects.push(Promise.resolve(bridge.phase?.(name))); },
      log: (message: string) => { sideEffects.push(Promise.resolve(bridge.log?.(message))); },
    };
    const result = await inheritedHostAgentPath.run([...structuralPath], async () => registry.invokeFunction(name, input, context, path, { get: () => replayed?.value, put: (_path, value) => { stored = value; } }));
    await Promise.all(sideEffects);
    if (!replayed) await store.complete(path, stored ?? result);
    return result;
  };
  return { ...bridge, functions: registry.globals(), variables, function: invokeFunction };
}

function projectTrusted(ctx: unknown): boolean {
  const check = object(ctx) ? ctx.isProjectTrusted : undefined;
  return typeof check === "function" ? Boolean(Reflect.apply(check, ctx, [])) : true;
}
type PiHostCapabilities = { registerEntryRenderer?: ExtensionAPI["registerEntryRenderer"]; events?: WorkflowEventSink };
function isEntryRenderer(value: unknown): value is NonNullable<PiHostCapabilities["registerEntryRenderer"]> { return typeof value === "function"; }
function isWorkflowEventSink(value: unknown): value is WorkflowEventSink { return object(value) && typeof value.emit === "function"; }
function piHostCapabilities(pi: unknown): PiHostCapabilities {
  if (!object(pi)) return {};
  const registerEntryRenderer = pi.registerEntryRenderer;
  const events = pi.events;
  return { ...(isEntryRenderer(registerEntryRenderer) ? { registerEntryRenderer } : {}), ...(isWorkflowEventSink(events) ? { events } : {}) };
}
type ContextHostCapabilities = { modelRegistry?: ModelRegistryCapability };
type ModelSummary = { provider: string; id: string };
type ModelRegistryGetter = () => readonly ModelSummary[];
type ModelRegistryCapability = { getAll?: ModelRegistryGetter; getAvailable?: ModelRegistryGetter };
function isModelRegistryGetter(value: unknown): value is ModelRegistryGetter { return typeof value === "function"; }
function contextHostCapabilities(ctx: unknown): ContextHostCapabilities {
  if (!object(ctx) || !object(ctx.modelRegistry)) return {};
  const registry = ctx.modelRegistry;
  const getAll = registry.getAll;
  const getAvailable = registry.getAvailable;
  return { modelRegistry: { ...(isModelRegistryGetter(getAll) ? { getAll: () => getAll.call(registry) } : {}), ...(isModelRegistryGetter(getAvailable) ? { getAvailable: () => getAvailable.call(registry) } : {}) } };
}
type UiSelect = (title: string, options: string[]) => Promise<string | undefined>;
type UiInput = (title: string, placeholder?: string) => Promise<string | undefined>;
type UiSetStatus = (key: string, text?: string) => void;
type UiHostCapabilities = { select?: UiSelect; input?: UiInput; setStatus?: UiSetStatus };
function isUiSelect(value: unknown): value is UiSelect { return typeof value === "function"; }
function isUiInput(value: unknown): value is UiInput { return typeof value === "function"; }
function isUiSetStatus(value: unknown): value is UiSetStatus { return typeof value === "function"; }
function uiHostCapabilities(ui: unknown): UiHostCapabilities | undefined {
  if (!object(ui)) return undefined;
  const select = ui.select;
  const input = ui.input;
  const setStatus = ui.setStatus;
  return { ...(isUiSelect(select) ? { select } : {}), ...(isUiInput(input) ? { input } : {}), ...(isUiSetStatus(setStatus) ? { setStatus } : {}) };
}
type TuiHostCapabilities = { terminal?: { rows?: unknown } };
function tuiHostCapabilities(tui: unknown): TuiHostCapabilities {
  if (!object(tui) || !object(tui.terminal)) return {};
  return { terminal: { ...(tui.terminal.rows === undefined ? {} : { rows: tui.terminal.rows }) } };
}
function tuiRows(tui: unknown): number { const rows = tuiHostCapabilities(tui).terminal?.rows; return typeof rows === "number" && Number.isFinite(rows) ? rows : 24; }
type KeybindingsHostCapabilities = { getKeys?: (name: string) => readonly string[] };
function isKeybindingGetter(value: unknown): value is NonNullable<KeybindingsHostCapabilities["getKeys"]> { return typeof value === "function"; }
function keybindingsHostCapabilities(keybindings: unknown): KeybindingsHostCapabilities {
  if (!object(keybindings) || !isKeybindingGetter(keybindings.getKeys)) return {};
  return { getKeys: keybindings.getKeys };
}
function keybindingKeys(keybindings: unknown, name: string): readonly string[] | undefined { const getKeys = keybindingsHostCapabilities(keybindings).getKeys; return typeof getKeys === "function" ? getKeys.call(keybindings, name) : undefined; }
function parseThinking(value: unknown): ModelSpec["thinking"] | undefined {
  switch (value) {
    case "off": case "minimal": case "low": case "medium": case "high": case "xhigh": case "max": return value;
    default: return undefined;
  }
}

export default function workflowExtension(pi: ExtensionAPI, home?: string, clipboard = copyToClipboard, createSession: SessionFactory = createNativeAgentSession) {
  beginWorkflowExtensionLoading();
  const registry = loadingRegistry();
  const registerEntryRenderer = piHostCapabilities(pi).registerEntryRenderer;
  registerEntryRenderer?.<WorkflowLogEntry>(WORKFLOW_LOG_ENTRY, (entry) => {
    const data = entry.data;
    return textBlock(data ? `Workflow ${data.workflowName}: ${data.message}` : "");
  });
  const logBridge = (lifecycle: RunLifecycle, workflowName: string) => async (message: string) => {
    await lifecycle.enter();
    try { pi.appendEntry<WorkflowLogEntry>(WORKFLOW_LOG_ENTRY, { workflowName, message: utf8Prefix(message, DELIVERY_LIMIT_BYTES) }); }
    finally { await lifecycle.leave(); }
  };
  const eventPublisher = new WorkflowEventPublisher(piHostCapabilities(pi).events);
  pi.on("resources_discover", () => {
    if (!pi.getActiveTools().includes("workflow")) return;
    const extensionDir = dirname(fileURLToPath(import.meta.url));
    const skillPath = [join(extensionDir, "../skills"), join(extensionDir, "../../skills")].find((path) => existsSync(path));
    return skillPath ? { skillPaths: [skillPath] } : undefined;
  });
  type BudgetDecisionResult = { state: "running" | "budget_exhausted"; approved: boolean };
  const runs = new Map<string, { executor: WorkflowAgentExecutor; store: RunStore; metadata: WorkflowMetadata; model: ModelSpec; lifecycle: RunLifecycle; budget: WorkflowBudgetRuntime; abortController: AbortController; projectTrusted: () => boolean; execution?: WorkflowExecution; completion?: Promise<unknown>; checkpointResolvers: Map<string, (value: boolean) => void>; budgetResolvers: Map<string, (result: BudgetDecisionResult) => void>; update?: (result: WorkflowToolUpdate) => void }>();
  const pendingFailureDiagnostics = new Map<string, WorkflowFailureDiagnostics>();
  pi.on("tool_result", (event) => {
    if (event.toolName !== "workflow" || !event.isError) return;
    const diagnostic = pendingFailureDiagnostics.get(event.toolCallId);
    if (!diagnostic) return;
    pendingFailureDiagnostics.delete(event.toolCallId);
    return { content: [{ type: "text" as const, text: serializeWorkflowFailureDiagnostics(diagnostic) }], details: diagnostic, isError: true };
  });
  const liveActivities = new Map<string, Map<string, AgentActivity>>();
  const setLiveActivity = (runId: string, agentId: string, activity?: AgentActivity) => {
    const activities = liveActivities.get(runId);
    if (activity) {
      if (activities) activities.set(agentId, activity);
      else liveActivities.set(runId, new Map([[agentId, activity]]));
    } else {
      activities?.delete(agentId);
      if (activities?.size === 0) liveActivities.delete(runId);
    }
  };
  const withLiveActivities = (run: PersistedRun): PersistedRun => {
    const activities = liveActivities.get(run.id);
    return activities?.size ? { ...run, agents: run.agents.map((agent) => {
      const activity = activities.get(agent.id);
      return activity ? { ...agent, activity } : agent;
    }) } : run;
  };
  const conversationLocks = new Set<string>();
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
  const persistWorktree = async (store: RunStore, metadata: WorkflowMetadata, owner: string): Promise<WorktreeReference> => {
    const existing = (await store.worktrees()).some((worktree) => worktree.owner === owner);
    const worktree = await store.worktree(owner);
    if (!existing) await eventPublisher.worktree(store, metadata, worktree);
    return worktree;
  };
  const lifecycleFor = (store: RunStore, state: RunState, budget: WorkflowBudgetRuntime, metadata: WorkflowMetadata) => new RunLifecycle(state, async (next, previous, reason) => {
    if (next !== "pausing") budget.transition(next);
    const persisted = await persistRunState(store, metadata, (current) => {
      const nextRun = { ...current, state: next, ...budget.snapshot() };
      if (next === "running" || next === "completed") delete nextRun.error;
      return nextRun;
    });
    await eventPublisher.runState(store, metadata, previous, next, reason);
    runs.get(store.runId)?.update?.(workflowToolUpdate(withLiveActivities(persisted)));
  });
  const scheduler = new FairAgentScheduler(async ({ id, runId, parentId, prompt, options, signal, setSteer }) => {
    const run = runs.get(runId);
    if (!run) throw new WorkflowError("INTERNAL_ERROR", `Unknown production run: ${runId}`);
    try {
      const budget = run.budget.forAgent(id);
      const onProgress = async (progress: AgentProgress) => {
        let runState: PersistedRun;
        if (progress.persist) {
          runState = await persistRunState(run.store, run.metadata, (current) => current.agents.some((agent) => agent.id === id) ? { ...current, ...run.budget.snapshot(), agents: current.agents.map((agent) => agent.id === id ? { ...agent, accounting: progress.accounting, toolCalls: progress.toolCalls, activity: progress.activity } : agent) } : current);
        } else {
          const loaded = await run.store.load();
          if (!loaded.run.agents.some((agent) => agent.id === id)) return;
          runState = { ...loaded.run, ...run.budget.snapshot(), agents: loaded.run.agents.map((agent) => agent.id === id ? { ...agent, accounting: progress.accounting, toolCalls: progress.toolCalls, activity: progress.activity } : agent) };
        }
        if (!runState.agents.some((agent) => agent.id === id)) return;
        setLiveActivity(runId, id, progress.activity);
        run.update?.(workflowToolUpdate(withLiveActivities(runState)));
      };
      const onAttempt = async (attempt: Pick<AgentAttempt, "attempt" | "sessionId" | "sessionFile" | "setup">) => {
        await scheduler.flush();
        scheduler.attemptStarted(id);
        await scheduler.flush();
        const before = (await run.store.load()).run;
        await persistActiveAgentAttempt(run.store, id, attempt);
        const active = (await run.store.load()).run;
        await eventPublisher.agentStates(run.store, run.metadata, before.agents, active.agents);
        const persisted = await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot() }));
        run.update?.(workflowToolUpdate(withLiveActivities(persisted)));
      };
      const result = await run.executor.execute(prompt, { label: options.label, workflowName: run.metadata.name, onProgress, onAttempt, budget, ...(parentId ? { parent: parentId, cwd: options.cwd, ...(options.worktreeOwner ? { worktreeOwner: options.worktreeOwner } : {}) } : options.worktreeOwner ? { worktreeOwner: options.worktreeOwner } : {}), ...(options.model ? { model: options.model } : {}), ...(options.thinking ? { thinking: options.thinking } : {}), ...(options.role ? { role: options.role } : {}), ...(options.role ? {} : { tools: options.tools }), effectiveTools: options.tools, ...(options.schema ? { schema: options.schema } : {}), ...(options.retries === undefined ? {} : { retries: options.retries }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.agentOptions ? { agentOptions: options.agentOptions } : {}), ...(options.agentIdentity ? { agentIdentity: options.agentIdentity } : {}), ...(options.conversation ? { conversation: options.conversation } : {}) }, signal, scheduler.toolsFor(id, (role, tools, model, inheritedTools, thinking) => run.executor.resolve({ label: "child", workflowName: run.metadata.name, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(tools !== undefined ? { tools } : {}) }, inheritedTools).tools), setSteer, () => { scheduler.cancelChildren(id); scheduler.retry(id); });
      const before = (await run.store.load()).run;
      await persistAgentAttempts(run.store, id, result.attempts);
      const completed = (await run.store.load()).run;
      await eventPublisher.agentStates(run.store, run.metadata, before.agents, completed.agents);
      const persisted = await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot() }));
      setLiveActivity(runId, id);
      run.update?.(workflowToolUpdate(withLiveActivities(persisted)));
      return result.value;
    } catch (error) {
      const attempts = (error as WorkflowError & { attempts?: readonly AgentAttempt[] }).attempts;
      if (attempts?.length) {
        const before = (await run.store.load()).run;
        await persistAgentAttempts(run.store, id, attempts);
        const failed = (await run.store.load()).run;
        await eventPublisher.agentStates(run.store, run.metadata, before.agents, failed.agents);
      }
      const persisted = await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot() }));
      setLiveActivity(runId, id);
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
        const requested = { label: node.options.label, workflowName: run.metadata.name, ...(node.options.model ? { model: node.options.model } : {}), ...(node.options.thinking ? { thinking: node.options.thinking } : {}), ...(node.options.role ? { role: node.options.role } : {}), effectiveTools: node.options.tools };
        let effective: { model: ModelSpec; requestedModel?: string; tools: readonly string[] };
        try { effective = run.executor.resolve(requested); }
        catch { effective = previous ? { model: previous.model, ...(previous.requestedModel ? { requestedModel: previous.requestedModel } : {}), tools: previous.tools } : { model: node.options.model ? modelSpec(node.options.model, run.model) : { ...run.model, ...(node.options.thinking ? { thinking: node.options.thinking } : {}) }, ...(node.options.model ? { requestedModel: node.options.model } : {}), tools: node.options.tools }; }
        return { id: node.id, name: node.label, ...(node.options.requestedLabel ? { label: node.options.requestedLabel } : {}), path: node.id, state: node.state, ...(node.parentId ? { parentId: node.parentId } : {}), structuralPath: [...(node.options.agentIdentity?.structuralPath ?? [])], ...(node.options.parentBreadcrumb ? { parentBreadcrumb: node.options.parentBreadcrumb } : {}), ...(node.options.worktreeOwner ? { worktreeOwner: node.options.worktreeOwner } : {}), ...(node.options.role ? { role: node.options.role } : {}), ...(effective.requestedModel ? { requestedModel: effective.requestedModel } : {}), model: effective.model, tools: effective.tools, attempts: previous?.attempts ?? 0, ...(previous?.attemptDetails ? { attemptDetails: previous.attemptDetails } : {}), ...(previous?.accounting ? { accounting: previous.accounting } : {}), ...(previous?.toolCalls ? { toolCalls: previous.toolCalls } : {}), ...(previous?.activity ? { activity: previous.activity } : {}) };
      });
      return { ...current, agents };
    });
    await eventPublisher.agentStates(run.store, run.metadata, previousAgents, runState.agents);
    run.update?.(workflowToolUpdate(withLiveActivities(runState)));
  });
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
    await scheduler.flush();
    return { runId, state: "stopped", stopped: true };
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
  const budgetDecisionDelivery = (metadata: WorkflowMetadata, request: BudgetApprovalRequest) => `Workflow ${metadata.name} budget adjustment ${request.proposalId} for run ${request.runId} requires approval. Consumed usage: ${JSON.stringify(request.consumed)}. Previous limits: ${JSON.stringify(request.previous)}. Proposed limits: ${JSON.stringify(request.proposed)}. Respond with workflow_respond using proposalId ${request.proposalId}.`;
  const appendBudgetDecisionEvent = async (run: NonNullable<ReturnType<typeof runs.get>>, request: BudgetApprovalRequest, type: "adjustment_requested" | "adjustment_approved" | "adjustment_rejected") => {
    run.budget.recordEvent({ type, budgetVersion: request.budgetVersion, dimensions: [], usage: structuredClone(request.consumed), limits: structuredClone(request.proposed), at: Date.now(), proposalId: request.proposalId, previous: structuredClone(request.previous), proposed: structuredClone(request.proposed) });
    await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot() }));
  };
  const answerBudgetDecision = async (runId: string, proposalId: string, approved: boolean, silent = false): Promise<BudgetDecisionResult | undefined> => {
    const run = runs.get(runId);
    if (!run) return undefined;
    const request = await run.store.answerWorkflowDecision(proposalId, approved);
    if (!request) return undefined;
    await appendBudgetDecisionEvent(run, request, approved ? "adjustment_approved" : "adjustment_rejected");
    const result = await applyBudgetDecision(request, approved);
    run.budgetResolvers.get(proposalId)?.(result);
    run.budgetResolvers.delete(proposalId);
    if (!silent) deliver(pi, `Workflow ${run.metadata.name} budget adjustment ${proposalId}: ${approved ? "Approved" : "Rejected"}.`);
    return result;
  };
  const checkpointBridge = (runId: string, store: RunStore, metadata: WorkflowMetadata, foreground: boolean, ui?: { select?: (prompt: string, options: string[]) => Promise<string | undefined> }) => {
    const checkpointCounters = new Map<string, number>();
    return async (raw: Readonly<Record<string, JsonValue>>, signal: AbortSignal): Promise<boolean> => {
      const input = validateCheckpoint(raw);
      const label = nextNamedOccurrence(checkpointCounters, input.name);
      const path = operationPath("checkpoint", label);
      if (foreground && !ui?.select) fail("RESUME_INCOMPATIBLE", "Foreground checkpoints require UI");
      const alreadyAwaiting = (await store.awaitingCheckpoints()).some((checkpoint) => checkpoint.path === path);
      const replayed = await store.awaitCheckpoint({ ...input, name: label, path });
      if (replayed !== undefined) return replayed;
      if (!alreadyAwaiting) await eventPublisher.checkpoint(store, metadata, label, "awaiting");
      const run = runs.get(runId);
      await run?.lifecycle.enterAwaitingInput();
      if (!alreadyAwaiting && !ui?.select) deliver(pi, `Workflow ${metadata.name} checkpoint ${label}: ${input.prompt}\nContext: ${JSON.stringify(input.context)}\nRespond with workflow_respond.`);
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
      if (ui?.select) void (async () => {
        while (!signal.aborted && run?.checkpointResolvers.has(path)) {
          const choice = await ui.select?.(input.prompt, ["Approve", "Reject"]);
          if (!choice) {
            if (foreground) continue; // foreground: retry until answered
            deliver(pi, `Workflow ${metadata.name} checkpoint ${label}: ${input.prompt}\nContext: ${JSON.stringify(input.context)}\nRespond with workflow_respond.`);
            return;
          }
          if (await answerCheckpoint(runId, label, choice === "Approve", true)) return;
        }
      })().catch(() => undefined);
      return decision;
    };
  };

  pi.registerTool({
    name: "workflow_respond",
    label: "Workflow Respond",
    description: "Approve or reject one pending workflow checkpoint or budget decision",
    parameters: Type.Object({ runId: Type.String(), name: Type.Optional(Type.String()), proposalId: Type.Optional(Type.String()), approved: Type.Boolean() }, { additionalProperties: false }),
    async execute(_id, params) {
      try {
        if (params.proposalId) {
          const result = await answerBudgetDecision(params.runId, params.proposalId, params.approved);
          if (!result) { const denied = { state: "budget_exhausted" as const, approved: false, reason: "proposal_not_pending" }; return { content: [{ type: "text" as const, text: JSON.stringify(denied) }], details: denied }; }
          return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: { ...result, reason: params.approved ? "approved" : "rejected" } };
        }
        if (!params.name) throw new WorkflowError("INVALID_METADATA", "workflow_respond requires name or proposalId");
        const accepted = await answerCheckpoint(params.runId, params.name, params.approved);
        return { content: [{ type: "text" as const, text: accepted ? "Checkpoint response accepted." : "Checkpoint is not awaiting a response." }], details: { accepted, state: accepted ? "checkpoint_answered" : "not_pending", approved: params.approved, reason: "checkpoint" } as never };
      } catch (error) {
        throw mainAgentError(error);
      }
    },
  });
  pi.registerTool({
    name: "workflow_stop",
    label: "Workflow Stop",
    description: "Stop an active workflow run by ID",
    parameters: Type.Object({ runId: Type.String() }, { additionalProperties: false }),
    async execute(_id, params) {
      try {
        const result = await stopWorkflowRun(params.runId);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      } catch (error) {
        throw mainAgentError(error);
      }
    },
  });
  let catalogRegistered = false;
  let sessionStarted = false;
  const registerCatalog = () => {
    if (catalogRegistered || !pi.getActiveTools().includes("workflow")) return;
    const catalog = registry.catalog();
    const hasAliases = Object.keys(catalog.modelAliases ?? {}).length > 0;
    if (!catalog.functions.length && !catalog.variables.length && !catalog.workflows.length && !hasAliases) return;
    pi.registerTool({
      name: "workflow_catalog",
      label: "Workflow Catalog",
      description: "List global workflow functions, variables, and reusable workflows",
      parameters: Type.Object({}, { additionalProperties: false }),
      async execute() { return { content: [{ type: "text" as const, text: JSON.stringify(registry.catalog()) }], details: {} }; }
    });
    catalogRegistered = true;
  };
  const refreshPausedRunAliases = async (run: NonNullable<ReturnType<typeof runs.get>>, context?: { model: { provider: string; id: string } | undefined; modelRegistry: { getAll?: () => Array<{ provider: string; id: string }>; getAvailable?: () => Array<{ provider: string; id: string }> } | undefined }) => {
    const loaded = await run.store.load();
    const active = new Set(pi.getActiveTools().filter((tool) => tool !== "workflow" && tool !== "workflow_respond" && tool !== "workflow_stop" && tool !== "workflow_catalog"));
    const missing = loaded.snapshot.tools.filter((tool) => tool !== "workflow_catalog").find((tool) => !active.has(tool));
    if (missing) throw new WorkflowError("RESUME_INCOMPATIBLE", `Required tool is unavailable: ${missing}`);
    const settingsPath = workflowSettingsPath();
    const currentSettings = loadSettings(settingsPath);
    resolveAgentResourcePolicy(run.store.cwd, run.projectTrusted(), settingsPath);
    const currentAliases = currentSettings.modelAliases ?? {};
    const previousAliases = loaded.snapshot.modelAliases ?? loaded.snapshot.settings.modelAliases ?? {};
    const modelRegistry = context?.modelRegistry;
    const knownModels = new Set((modelRegistry?.getAll?.() ?? modelRegistry?.getAvailable?.() ?? []).map((model) => `${model.provider}/${model.id}`));
    if (context?.model) knownModels.add(`${context.model.provider}/${context.model.id}`);
    const resumeModels = modelRegistry ? knownModels : new Set([...loaded.snapshot.models, ...knownModels]);
    const blockedAliases = new Set(Object.keys(previousAliases).filter((name) => !Object.prototype.hasOwnProperty.call(currentAliases, name)));
    const blockedAliasTargets = Object.fromEntries(Object.entries(previousAliases).filter(([name]) => !Object.prototype.hasOwnProperty.call(currentAliases, name)));
    const snapshot = createLaunchSnapshot({ ...loaded.snapshot, settingsPath, settings: { ...loaded.snapshot.settings, modelAliases: currentAliases }, modelAliases: currentAliases });
    await run.store.saveSnapshot(snapshot);
    run.executor = new WorkflowAgentExecutor({ cwd: run.store.cwd, model: run.model, tools: new Set(snapshot.tools.filter((tool) => pi.getActiveTools().includes(tool) && tool !== "workflow_catalog")), availableModels: resumeModels, knownModels: resumeModels, modelAliases: currentAliases, blockedAliases, blockedAliasTargets, settingsPath, agentDefinitions: snapshot.roles ?? {}, runStore: run.store, providerPause: async () => { deliver(pi, `Workflow ${snapshot.metadata.name} paused: provider limit.`); await run.lifecycle.providerPause(); }, agentSetupHooks: registry.agentSetupHooks(), agentResourcePolicy: () => resolveAgentResourcePolicy(run.store.cwd, run.projectTrusted(), settingsPath) }, createSession);
    run.executor.setRunContext(workflowRunContext(run.store.cwd, run.store.sessionId, run.store.runId, loaded.snapshot.metadata, loaded.snapshot.args, run.abortController.signal));
    const drift = aliasDrift(previousAliases, currentAliases);
    if (drift.length) await run.store.appendEvent({ type: "warning", message: `Model alias mappings changed on resume: ${drift.join("; ")}` });
  };
  const coldResumeRun = async (run: NonNullable<ReturnType<typeof runs.get>>, hasUI: boolean, ui: { select?: (prompt: string, options: string[]) => Promise<string | undefined> }, trustedProject: boolean, context?: { model: { provider: string; id: string } | undefined; modelRegistry: { getAll?: () => Array<{ provider: string; id: string }>; getAvailable?: () => Array<{ provider: string; id: string }> } | undefined }) => {
    const loaded = await run.store.load();
    if (loaded.snapshot.identityVersion !== LAUNCH_SNAPSHOT_IDENTITY_VERSION) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow launch snapshot identity version is incompatible");
    if (loaded.snapshot.roles === undefined) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow role definitions are missing from the launch snapshot");
    if ((loaded.snapshot.projectRoles?.length ?? 0) > 0 && !trustedProject) throw new WorkflowError("RESUME_INCOMPATIBLE", "Cannot restore project roles in an untrusted project");
    const missingRole = loaded.snapshot.agentTypes.find((role) => !loaded.snapshot.roles?.[role]);
    if (missingRole) throw new WorkflowError("RESUME_INCOMPATIBLE", `Role definition is missing from the launch snapshot: ${missingRole}`);
    const active = new Set(pi.getActiveTools().filter((tool) => tool !== "workflow" && tool !== "workflow_respond" && tool !== "workflow_stop" && tool !== "workflow_catalog"));
    const missing = loaded.snapshot.tools.filter((tool) => tool !== "workflow_catalog").find((tool) => !active.has(tool));
    if (missing) throw new WorkflowError("RESUME_INCOMPATIBLE", `Required tool is unavailable: ${missing}`);
    const settingsPath = workflowSettingsPath();
    const currentSettings = loadSettings(settingsPath);
    resolveAgentResourcePolicy(run.store.cwd, trustedProject, settingsPath);
    const currentAliases = currentSettings.modelAliases ?? {};
    const previousAliases = loaded.snapshot.modelAliases ?? loaded.snapshot.settings.modelAliases ?? {};
    const modelRegistry = context?.modelRegistry;
    const knownModels = new Set((modelRegistry?.getAll?.() ?? modelRegistry?.getAvailable?.() ?? []).map((model) => `${model.provider}/${model.id}`));
    if (context?.model) knownModels.add(`${context.model.provider}/${context.model.id}`);
    const resumeModels = modelRegistry ? knownModels : new Set([...loaded.snapshot.models, ...knownModels]);
    const resumeAliases = { ...previousAliases, ...currentAliases };
    const blockedAliases = new Set(Object.keys(previousAliases).filter((name) => !Object.prototype.hasOwnProperty.call(currentAliases, name)));
    const blockedAliasTargets = Object.fromEntries(Object.entries(previousAliases).filter(([name]) => !Object.prototype.hasOwnProperty.call(currentAliases, name)));
    preflight(loaded.snapshot.script, { models: resumeModels, tools: active, agentTypes: new Set(loaded.snapshot.agentTypes), modelAliases: resumeAliases, knownModels: resumeModels, settingsPath, skipModelAvailability: true }, loaded.snapshot.schemas, loaded.snapshot.metadata);
    const snapshot = createLaunchSnapshot({ ...loaded.snapshot, settingsPath, settings: { ...loaded.snapshot.settings, modelAliases: currentAliases }, modelAliases: currentAliases });
    await run.store.saveSnapshot(snapshot);
    run.executor = new WorkflowAgentExecutor({ cwd: run.store.cwd, model: run.model, tools: new Set(snapshot.tools.filter((tool) => pi.getActiveTools().includes(tool) && tool !== "workflow_catalog")), availableModels: resumeModels, knownModels: resumeModels, modelAliases: currentAliases, blockedAliases, blockedAliasTargets, settingsPath, agentDefinitions: snapshot.roles ?? {}, runStore: run.store, providerPause: async () => { deliver(pi, `Workflow ${snapshot.metadata.name} paused: provider limit.`); await run.lifecycle.providerPause(); }, agentSetupHooks: registry.agentSetupHooks(), agentResourcePolicy: () => resolveAgentResourcePolicy(run.store.cwd, run.projectTrusted(), settingsPath) }, createSession);
    const drift = aliasDrift(previousAliases, currentAliases);
    if (drift.length) await run.store.appendEvent({ type: "warning", message: `Model alias mappings changed on resume: ${drift.join("; ")}` });
    const controller = new AbortController();
    run.abortController = controller;
    const runContext = workflowRunContext(run.store.cwd, run.store.sessionId, run.store.runId, loaded.snapshot.metadata, loaded.snapshot.args, controller.signal);
    run.executor.setRunContext(runContext);
    let variables: Readonly<Record<string, JsonValue>>;
    try { variables = await resolveWorkflowVariables(runContext, controller, registry); }
    catch (error) {
      const typed = asWorkflowError(error);
      if (!["completed", "failed", "stopped"].includes(run.lifecycle.state)) { await run.lifecycle.terminal("failed", typed.code).catch(() => undefined); const persisted = await persistRunState(run.store, run.metadata, (current) => ({ ...current, error: { code: typed.code, message: typed.message } })); await eventPublisher.runFailed(run.store, run.metadata, typed, run.lifecycle.state === "interrupted" ? "interrupted" : "failed"); run.update?.(workflowToolUpdate(persisted)); }
      throw typed;
    }
    await scheduler.cancelRun(run.store.runId);
    await run.lifecycle.resume();
    const execution = runWorkflow(loaded.snapshot.script, loaded.snapshot.args, withWorkflowFunctions({ agent: async (prompt, options, signal, identity) => {
      await run.lifecycle.enter();
      const conversationId = identity.conversation ? conversationIdentityPath(identity) : undefined;
      const conversationLock = conversationId ? `${run.store.runId}:${conversationId}` : "";
      try {
        const path = conversationId ? conversationTurnPath(identity) : agentIdentityPath(identity);
        const replayed = await run.store.replay(path);
        if (replayed) {
          if (conversationId) {
            const conversation = await run.store.conversation(conversationId);
            if (!conversation || conversation.head.turn < (identity.conversation?.turn ?? 0)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Completed conversation turn has no persisted head");
          }
          return replayed.value;
        }
        if (conversationId) {
          if (conversationLocks.has(conversationLock)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Conversation turns cannot overlap");
          const conversation = await run.store.conversation(conversationId);
          if (conversation ? conversation.head.turn + 1 !== identity.conversation?.turn : identity.conversation?.turn !== 1) throw new WorkflowError("RESUME_INCOMPATIBLE", "Conversation turn does not continue its persisted head");
          conversationLocks.add(conversationLock);
        }
        const worktree = agentWorktree(identity);
        const cwd = worktree.worktreeOwner ? (await persistWorktree(run.store, run.metadata, worktree.worktreeOwner)).cwd : run.store.cwd;
        const role = typeof options.role === "string" ? options.role : undefined;
        const model = typeof options.model === "string" ? options.model : undefined;
        const thinking = parseThinking(options.thinking);
        const requestedLabel = typeof options.label === "string" ? options.label : undefined;
        const resolved = run.executor.resolve({ label: requestedLabel ?? role ?? "agent", workflowName: run.metadata.name, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(Array.isArray(options.tools) ? { tools: options.tools as string[] } : {}) });
        const label = displayAgentName(requestedLabel, role, resolved.model);
        const tools = resolved.tools;
        const schema = object(options.outputSchema) ? options.outputSchema : undefined;
        const spawned = scheduler.spawn(run.store.runId, prompt, { label, ...(requestedLabel ? { requestedLabel } : {}), ...(identity.parentBreadcrumb ? { parentBreadcrumb: identity.parentBreadcrumb } : {}), cwd, tools, ...worktree, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(schema ? { schema } : {}), ...(typeof options.retries === "number" ? { retries: options.retries } : {}), ...(positiveInteger(options.timeoutMs) || options.timeoutMs === null ? { timeoutMs: options.timeoutMs } : {}), ...(conversationId ? { conversation: { id: conversationId, turn: identity.conversation?.turn ?? 0 } } : {}), agentOptions: options, agentIdentity: identity });
        const cancel = () => { scheduler.cancel(spawned.id); };
        signal.addEventListener("abort", cancel, { once: true });
        const outcome = await spawned.result.finally(() => { signal.removeEventListener("abort", cancel); });
        if (!outcome.ok) throw new WorkflowError(outcome.error.code as WorkflowErrorCode, outcome.error.message);
        await run.store.complete(path, outcome.value);
        return outcome.value;
      } finally { if (conversationLock) conversationLocks.delete(conversationLock); await run.lifecycle.leave(); }
    }, checkpoint: checkpointBridge(run.store.runId, run.store, run.metadata, false, hasUI ? ui : undefined), phase: async (phase) => { await run.lifecycle.enter(); try { let previousPhase: string | undefined; const persisted = await persistRunState(run.store, run.metadata, (current) => { previousPhase = current.phase; return { ...current, phase }; }); await eventPublisher.phase(run.store, run.metadata, previousPhase, phase); runs.get(run.store.runId)?.update?.(workflowToolUpdate(persisted)); } finally { await run.lifecycle.leave(); } }, log: logBridge(run.lifecycle, run.metadata.name) }, run.store, runContext, variables, registry), controller.signal);
    run.execution = execution;
    const completion = execution.result.then(async (value) => {
      await scheduler.flush();
      if (run.budget.hardExhausted) throw new WorkflowError("BUDGET_EXHAUSTED", "Budgeted work was attempted after hard exhaustion");
      const resultPath = await run.store.saveResult(value);
      await run.lifecycle.terminal("completed", "completed");
      await eventPublisher.runCompleted(run.store, run.metadata, resultPath);
      return { value, resultPath };
    }).catch(async (error: unknown) => {
      await scheduler.flush();
      const typed = error instanceof WorkflowError ? error : new WorkflowError(errorCode(error) ?? "INTERNAL_ERROR", errorText(error));
      if (!["stopped", "interrupted", "budget_exhausted"].includes(run.lifecycle.state)) await run.lifecycle.terminal(typed.code === "BUDGET_EXHAUSTED" ? "budget_exhausted" : "failed", typed.code);
      const persisted = await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot(), error: { code: typed.code, message: typed.message } }));
      const state = run.lifecycle.state === "stopped" || run.lifecycle.state === "interrupted" || run.lifecycle.state === "budget_exhausted" ? run.lifecycle.state : "failed";
      await eventPublisher.runFailed(run.store, run.metadata, typed, state);
      run.update?.(workflowToolUpdate(persisted));
      if (!["stopped", "interrupted", "budget_exhausted"].includes(run.lifecycle.state)) deliverFailure(pi, createWorkflowFailureDiagnostics(run.store, run.metadata, typed, persisted));
    });
    void completion;
  };
  const applyBudgetDecision = async (request: BudgetApprovalRequest, approved: boolean): Promise<BudgetDecisionResult> => {
    const run = runs.get(request.runId);
    if (!run) throw new WorkflowError("RESUME_INCOMPATIBLE", `Unknown workflow run: ${request.runId}`);
    if (!approved) return { state: "budget_exhausted", approved: false };
    const nextBudget = validateBudget(request.proposed);
    const nextVersion = request.budgetVersion + 1;
    const runtime = new WorkflowBudgetRuntime(nextBudget, nextVersion, request.consumed, run.budget.events, { active: false });
    run.budget = runtime;
    await persistRunState(run.store, run.metadata, (current) => { const next = { ...current, ...runtime.snapshot(), budgetVersion: nextVersion }; if (nextBudget) next.budget = nextBudget; else delete next.budget; return next; });
    await coldResumeRun(run, false, {}, true);
    return { state: "running", approved: true };
  };
  const resumeWorkflowRun = async (runId: string, rawPatch?: unknown): Promise<Record<string, JsonValue>> => {
    const run = runs.get(runId);
    if (!run) throw new WorkflowError("RESUME_INCOMPATIBLE", `Unknown workflow run: ${runId}`);
    const loaded = await run.store.load();
    if (loaded.run.state !== "budget_exhausted") throw new WorkflowError("RESUME_INCOMPATIBLE", "Only budget-exhausted runs can be resumed with workflow_resume");
    const currentBudget = validateBudget(loaded.run.budget ?? loaded.snapshot.budget);
    const patch = rawPatch === undefined ? {} : validateBudgetPatch(rawPatch);
    const nextBudget = mergeBudget(currentBudget, patch);
    const usage = budgetUsage(loaded.run.usage);
    if (!resumeBudgetAllowed(nextBudget, usage)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Every exhausted hard budget must be raised above retained usage or removed");
    if (budgetRelaxed(currentBudget, nextBudget)) {
      const proposalId = randomUUID();
      const request: BudgetApprovalRequest = { kind: "budget", proposalId, runId, consumed: usage, previous: currentBudget ?? {}, proposed: nextBudget ?? {}, budgetVersion: loaded.run.budgetVersion ?? 1 };
      const decision = new Promise<BudgetDecisionResult>((resolve) => { run.budgetResolvers.set(proposalId, resolve); });
      try { await run.store.requestWorkflowDecision(request); await appendBudgetDecisionEvent(run, request, "adjustment_requested"); } catch (error) { run.budgetResolvers.delete(proposalId); throw error; }
      deliver(pi, budgetDecisionDelivery(run.metadata, request));
      const decisionResult = await decision;
      return { state: decisionResult.state };
    }
    const changed = JSON.stringify(currentBudget ?? {}) !== JSON.stringify(nextBudget ?? {});
    if (changed) {
      const nextVersion = (loaded.run.budgetVersion ?? 1) + 1;
      const runtime = new WorkflowBudgetRuntime(nextBudget, nextVersion, usage, loaded.run.budgetEvents, { active: false });
      run.budget = runtime;
      await persistRunState(run.store, run.metadata, (current) => { const next = { ...current, ...runtime.snapshot(), budgetVersion: nextVersion }; if (nextBudget) next.budget = nextBudget; else delete next.budget; return next; });
    }
    await coldResumeRun(run, false, {}, true);
    return { state: "running" };
  };
  pi.registerTool({
    name: "workflow_resume",
    label: "Workflow Resume",
    description: "Resume an exhausted workflow with unchanged or patched aggregate budgets",
    parameters: Type.Object({ runId: Type.String(), budget: Type.Optional(Type.Unknown()) }, { additionalProperties: false }),
    async execute(_id, params) {
      try { const result = await resumeWorkflowRun(params.runId, params.budget); return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result }; }
      catch (error) { throw mainAgentError(error); }
    },
  });
  pi.on("session_start", async (_event, ctx) => {
    if (sessionStarted) return;
    sessionStarted = true;
    registry.freeze();
    registerCatalog();
    await ensureSessionLease(ctx.cwd, ctx.sessionManager.getSessionId());
    try {
    for (const runId of await listRunIds(ctx.cwd, ctx.sessionManager.getSessionId(), home)) {
      if (runs.has(runId)) continue;
      const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
      let loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> };
      try { loaded = await store.load(); } catch { if (!await store.isComplete()) await store.delete(true).catch(() => undefined); continue; }
      if (loaded.run.state === "completed" || loaded.run.state === "failed" || loaded.run.state === "stopped") { terminalRunStates.set(runId, loaded.run.state); continue; }
      if (loaded.run.state !== "interrupted" && loaded.run.state !== "budget_exhausted") {
        const previousState = loaded.run.state;
        await store.updateState((current) => ["completed", "failed", "stopped", "interrupted", "budget_exhausted"].includes(current.state) ? current : { ...current, state: "interrupted" });
        loaded = { ...loaded, run: (await store.load()).run };
        await eventPublisher.runState(store, loaded.snapshot.metadata, previousState, "interrupted", "session_shutdown");
        loaded = { ...loaded, run: (await store.load()).run };
      }
      const model = modelSpec(loaded.snapshot.models[0] ?? "", { provider: ctx.model?.provider ?? "", model: ctx.model?.id ?? "", thinking: pi.getThinkingLevel() });
      const budget = validateBudget(loaded.run.budget ?? loaded.snapshot.budget);
      eventPublisher.seedBudget(runId, loaded.run.budgetEvents);
      const budgetRuntime = new WorkflowBudgetRuntime(budget, loaded.run.budgetVersion ?? 1, loaded.run.usage, loaded.run.budgetEvents, { active: loaded.run.state === "running" });
      const lifecycle = lifecycleFor(store, loaded.run.state, budgetRuntime, loaded.snapshot.metadata);
      const providerPause = async () => { deliver(pi, `Workflow ${loaded.snapshot.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      const roleDefinitions = loaded.snapshot.roles ?? {};
      runs.set(runId, { executor: new WorkflowAgentExecutor({ cwd: ctx.cwd, model, tools: new Set(loaded.snapshot.tools.filter((tool) => pi.getActiveTools().includes(tool) && tool !== "workflow_catalog")), availableModels: new Set(loaded.snapshot.models), knownModels: new Set(loaded.snapshot.models), ...(loaded.snapshot.modelAliases ?? loaded.snapshot.settings.modelAliases ? { modelAliases: loaded.snapshot.modelAliases ?? loaded.snapshot.settings.modelAliases } : {}), ...(loaded.snapshot.settingsPath ? { settingsPath: loaded.snapshot.settingsPath } : {}), agentDefinitions: roleDefinitions, runStore: store, providerPause, agentSetupHooks: registry.agentSetupHooks(), agentResourcePolicy: () => resolveAgentResourcePolicy(store.cwd, projectTrusted(ctx)) }, createSession), store, metadata: loaded.snapshot.metadata, model, lifecycle, budget: budgetRuntime, abortController: new AbortController(), projectTrusted: () => projectTrusted(ctx), checkpointResolvers: new Map(), budgetResolvers: new Map() });
      for (const checkpoint of await store.awaitingCheckpoints()) deliver(pi, `Workflow ${loaded.snapshot.metadata.name} checkpoint ${checkpoint.name}: ${checkpoint.prompt}\nContext: ${JSON.stringify(checkpoint.context)}\nRespond with workflow_respond.`);
      for (const decision of await store.pendingWorkflowDecisions()) deliver(pi, budgetDecisionDelivery(loaded.snapshot.metadata, decision));
      scheduler.restoreRun(runId, loaded.snapshot.settings.concurrency, loaded.snapshot.identityVersion === LAUNCH_SNAPSHOT_IDENTITY_VERSION ? await store.loadOwnership() : [], () => runs.get(runId)?.budget.checkAgentLaunch());
    }
    const resumeSelect = uiHostCapabilities(ctx.ui)?.select;
    if (ctx.hasUI && resumeSelect) {
      const interrupted = [...runs.values()].filter((r) => r.lifecycle.state === "interrupted");
      if (interrupted.length > 0) {
        const labels = interrupted.map((r) => `Resume: ${r.metadata.name} (${r.store.runId.slice(0, 8)})`);
        const options = [...labels, ...(interrupted.length > 1 ? ["Resume all"] : []), "Skip"];
        const choice = await resumeSelect(`${String(interrupted.length)} interrupted workflow${interrupted.length > 1 ? "s" : ""} found`, options);
        if (choice && choice !== "Skip") {
          const toResume = choice === "Resume all" ? interrupted : interrupted.filter((_, i) => labels[i] === choice);
          for (const run of toResume) {
            try { await coldResumeRun(run, true, ctx.ui, projectTrusted(ctx), ctx); ctx.ui.notify(`Resumed workflow ${run.metadata.name}.`, "info"); }
            catch (err) { ctx.ui.notify(`Cannot resume ${run.metadata.name}: ${err instanceof Error ? err.message : String(err)}`, "warning"); }
          }
        }
      }
    }
    } catch (error) { await releaseSessionLease(); throw error; }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!pi.getActiveTools().includes("workflow")) return;
    const roles = Object.entries(loadAgentDefinitions(ctx.cwd, undefined, projectTrusted(ctx))).filter(([, definition]) => definition.description);
    if (!roles.length) return;
    const content = `Workflow role descriptions:\n${roles.map(([name, definition]) => `- \`${name}\`: ${String(definition.description)}`).join("\n")}`;
    return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
  });
  pi.registerTool({
    name: "workflow",
    label: WORKFLOW_TOOL_LABEL,
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_TOOL_PROMPT_SNIPPET,
    parameters: WORKFLOW_TOOL_PARAMETERS,
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      try {
      const settingsPath = workflowSettingsPath();
      const defaults = loadSettings(settingsPath);
      if (!ctx.model) throw new WorkflowError("UNKNOWN_MODEL", "A launching model is required");
      const settings = Object.freeze({ concurrency: params.concurrency ?? defaults.concurrency, ...(defaults.modelAliases ? { modelAliases: defaults.modelAliases } : {}) });
      const budget = validateBudget(params.budget);
      const rootModel: ModelSpec = { provider: ctx.model.provider, model: ctx.model.id, thinking: pi.getThinkingLevel() };
      const rootModelName = `${rootModel.provider}/${rootModel.model}`;
      const modelRegistry = contextHostCapabilities(ctx).modelRegistry;
      const knownModels = new Set((modelRegistry?.getAll?.() ?? modelRegistry?.getAvailable?.() ?? [ctx.model]).map((model) => `${model.provider}/${model.id}`));
      knownModels.add(rootModelName);
      const availableModels = knownModels;
      const rootTools = pi.getActiveTools().filter((name) => name !== "workflow" && name !== "workflow_respond" && name !== "workflow_stop" && name !== "workflow_catalog");
      const trustedProject = projectTrusted(ctx);
      if (typeof ctx.cwd === "string") resolveAgentResourcePolicy(ctx.cwd, trustedProject, settingsPath);
      const validated = validateWorkflowLaunchWithRegistry(params, { cwd: ctx.cwd, projectTrusted: trustedProject, availableModels, rootTools: new Set(rootTools), modelAliases: defaults.modelAliases ?? {}, knownModels, settingsPath }, registry);
      const { script, checked, agentDefinitions, projectAgentDefinitions, roleNames } = validated;
      await ensureSessionLease(ctx.cwd, ctx.sessionManager.getSessionId());
      const runId = randomUUID();
      const args = (params.args ?? null) as JsonValue;
      encoded(args);
      const runController = new AbortController();
      if (signal?.aborted) runController.abort(); else signal?.addEventListener("abort", () => { runController.abort(); }, { once: true });
      const runContext = workflowRunContext(ctx.cwd, ctx.sessionManager.getSessionId(), runId, checked.metadata, args, runController.signal);
      const variables = await resolveWorkflowVariables(runContext, runController, registry);
      const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
      const roles = Object.fromEntries(roleNames.map((role) => [role, agentDefinitions[role]])) as Record<string, AgentDefinition>;
      const projectRoles = roleNames.filter((role) => projectAgentDefinitions[role] !== undefined);
      const roleModels = roleNames.flatMap((role) => { const model = agentDefinitions[role]?.model; return model ? [modelCapability(model, defaults.modelAliases, knownModels, settingsPath)] : []; });
      const snapshotModels = [...new Set([rootModelName, ...checked.referenced.models, ...roleModels])];
      const snapshot = createLaunchSnapshot({ script, args, metadata: checked.metadata, settings, settingsPath, ...(defaults.modelAliases ? { modelAliases: defaults.modelAliases } : {}), ...(budget ? { budget } : {}), models: snapshotModels, tools: rootTools, agentTypes: checked.referenced.agentTypes, roles, projectRoles, schemas: checked.schemas });
      const budgetRuntime = new WorkflowBudgetRuntime(budget);
      const initialBudget = budgetRuntime.snapshot();
      await store.create({ id: runId, workflowName: checked.metadata.name, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), state: "running", agents: [], nativeSessions: [], ...(budget ? { budget } : {}), budgetVersion: 1, ...initialBudget }, snapshot);
      const lifecycle = lifecycleFor(store, "running", budgetRuntime, checked.metadata);
      const background = !params.foreground;
      const providerPause = async () => { if (background) deliver(pi, `Workflow ${checked.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      const executor = new WorkflowAgentExecutor({ cwd: ctx.cwd, model: rootModel, tools: new Set(rootTools), availableModels, knownModels, modelAliases: defaults.modelAliases ?? {}, settingsPath, agentDefinitions, runStore: store, providerPause, agentSetupHooks: registry.agentSetupHooks(), agentResourcePolicy: () => resolveAgentResourcePolicy(ctx.cwd, projectTrusted(ctx)), runContext }, createSession);
      runs.set(runId, { executor, store, metadata: checked.metadata, model: rootModel, lifecycle, budget: budgetRuntime, abortController: runController, projectTrusted: () => projectTrusted(ctx), checkpointResolvers: new Map(), budgetResolvers: new Map(), ...(params.foreground && onUpdate ? { update: onUpdate } : {}) });
      if (params.foreground && onUpdate) onUpdate(workflowToolUpdate((await store.load()).run));
      scheduler.addRun(runId, settings.concurrency, () => runs.get(runId)?.budget.checkAgentLaunch());
      const execution = runWorkflow(script, args, withWorkflowFunctions({ agent: async (prompt, options, agentSignal, identity) => {
        await lifecycle.enter();
        const conversationId = identity.conversation ? conversationIdentityPath(identity) : undefined;
        const conversationLock = conversationId ? `${runId}:${conversationId}` : "";
        try {
          const path = conversationId ? conversationTurnPath(identity) : agentIdentityPath(identity);
          const replayed = await store.replay(path);
          if (replayed) {
            if (conversationId) {
              const conversation = await store.conversation(conversationId);
              if (!conversation || conversation.head.turn < (identity.conversation?.turn ?? 0)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Completed conversation turn has no persisted head");
            }
            return replayed.value;
          }
          if (conversationId) {
            if (conversationLocks.has(conversationLock)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Conversation turns cannot overlap");
            const conversation = await store.conversation(conversationId);
            if (conversation ? conversation.head.turn + 1 !== identity.conversation?.turn : identity.conversation?.turn !== 1) throw new WorkflowError("RESUME_INCOMPATIBLE", "Conversation turn does not continue its persisted head");
            conversationLocks.add(conversationLock);
          }
          const worktree = agentWorktree(identity);
          const cwd = worktree.worktreeOwner ? (await persistWorktree(store, checked.metadata, worktree.worktreeOwner)).cwd : ctx.cwd;
          const role = typeof options.role === "string" ? options.role : undefined;
          const model = typeof options.model === "string" ? options.model : undefined;
          const thinking = parseThinking(options.thinking);
          const requestedLabel = typeof options.label === "string" ? options.label : undefined;
          const resolved = executor.resolve({ label: requestedLabel ?? role ?? "agent", workflowName: checked.metadata.name, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(Array.isArray(options.tools) ? { tools: options.tools as string[] } : {}) });
          const label = displayAgentName(requestedLabel, role, resolved.model);
          const tools = resolved.tools;
          const schema = object(options.outputSchema) ? options.outputSchema : undefined;
          const spawned = scheduler.spawn(runId, prompt, { label, ...(requestedLabel ? { requestedLabel } : {}), ...(identity.parentBreadcrumb ? { parentBreadcrumb: identity.parentBreadcrumb } : {}), cwd, tools, ...worktree, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(schema ? { schema } : {}), ...(typeof options.retries === "number" ? { retries: options.retries } : {}), ...(positiveInteger(options.timeoutMs) || options.timeoutMs === null ? { timeoutMs: options.timeoutMs } : {}), ...(conversationId ? { conversation: { id: conversationId, turn: identity.conversation?.turn ?? 0 } } : {}), agentOptions: options, agentIdentity: identity });
          const cancel = () => { scheduler.cancel(spawned.id); };
          if (agentSignal.aborted) cancel(); else agentSignal.addEventListener("abort", cancel, { once: true });
          const outcome = await spawned.result.finally(() => { agentSignal.removeEventListener("abort", cancel); });
          if (!outcome.ok) throw new WorkflowError(outcome.error.code as WorkflowErrorCode, outcome.error.message);
          await store.complete(path, outcome.value);
          return outcome.value;
        } finally { if (conversationLock) conversationLocks.delete(conversationLock); await lifecycle.leave(); }
      }, checkpoint: checkpointBridge(runId, store, checked.metadata, Boolean(params.foreground), params.foreground && ctx.hasUI ? ctx.ui : undefined), phase: async (phase) => {
        await lifecycle.enter();
        try {
          let previousPhase: string | undefined;
          const persisted = await persistRunState(store, checked.metadata, (current) => { previousPhase = current.phase; return { ...current, phase }; });
          await eventPublisher.phase(store, checked.metadata, previousPhase, phase);
          runs.get(runId)?.update?.(workflowToolUpdate(persisted));
        } finally { await lifecycle.leave(); }
      }, log: logBridge(lifecycle, checked.metadata.name) }, store, runContext, variables, registry), runController.signal);
      (runs.get(runId) as NonNullable<ReturnType<typeof runs.get>>).execution = execution;
      await eventPublisher.runStarted(store, checked.metadata);
      const finish = execution.result.then(async (value) => {
        await scheduler.flush();
        if (budgetRuntime.hardExhausted) throw new WorkflowError("BUDGET_EXHAUSTED", "Budgeted work was attempted after hard exhaustion");
        const resultPath = await store.saveResult(value);
        await lifecycle.terminal("completed", "completed");
        await eventPublisher.runCompleted(store, checked.metadata, resultPath);
        return { value, resultPath };
      }).catch(async (error: unknown) => {
        await scheduler.flush();
        const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", String(error));
        if (!["stopped", "interrupted", "budget_exhausted"].includes(lifecycle.state)) await lifecycle.terminal(typed.code === "CANCELLED" ? "stopped" : typed.code === "BUDGET_EXHAUSTED" ? "budget_exhausted" : "failed", typed.code);
        const persisted = await persistRunState(store, checked.metadata, (current) => ({ ...current, ...budgetRuntime.snapshot(), error: { code: typed.code, message: typed.message } }));
        const state = lifecycle.state === "stopped" || lifecycle.state === "interrupted" || lifecycle.state === "budget_exhausted" ? lifecycle.state : "failed";
        await eventPublisher.runFailed(store, checked.metadata, typed, state);
        const diagnostic = createWorkflowFailureDiagnostics(store, checked.metadata, typed, persisted);
        Object.defineProperty(typed, WORKFLOW_FAILURE_DIAGNOSTICS, { value: diagnostic });
        if (params.foreground) pendingFailureDiagnostics.set(toolCallId, diagnostic);
        throw typed;
      });
      (runs.get(runId) as NonNullable<ReturnType<typeof runs.get>>).completion = finish;
      if (background) {
        void finish.then(async ({ value, resultPath }) => {
          deliver(pi, completionDelivery(checked.metadata.name, value, resultPath, await store.changedWorktrees()));
        }, (error: unknown) => {
          const diagnostic = failureDiagnosticsFrom(error);
          if (diagnostic) deliverFailure(pi, diagnostic);
          else deliver(pi, `Workflow ${checked.metadata.name} failed: ${formatWorkflowFailure(error)}`);
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ runId, state: "running" }) }], details: { runId, preview: `Started workflow ${runId}.` } };
      }
      const { value } = await finish;
      const run = (await store.load()).run;
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: { runId, value, run } };
      } catch (error) {
        throw mainAgentError(error);
      }
    },
    renderCall(args) {
      return textBlock(formatWorkflowPreview(args));
    },
    renderResult(result, { isPartial }, _theme, context) {
      const details = result.details;
      if (isWorkflowFailureDiagnostics(details)) return textBlock(formatWorkflowFailureDiagnostics(details));
      const runDetails = details as { run?: PersistedRun; value?: JsonValue; preview?: string } | undefined;
      const state = context.state as { workflowSpinner?: ReturnType<typeof setInterval> };
      if (runDetails?.run && isPartial && runDetails.run.state === "running" && !state.workflowSpinner) {
        state.workflowSpinner = setInterval(context.invalidate, 80);
        state.workflowSpinner.unref();
      } else if ((!isPartial || runDetails?.run?.state !== "running") && state.workflowSpinner) {
        clearInterval(state.workflowSpinner);
        delete state.workflowSpinner;
      }
      if (runDetails?.run) return workflowProgressBlock(runDetails.run);
      const content = result.content[0];
      return textBlock(isPartial ? "Workflow starting..." : runDetails?.preview ?? (content?.type === "text" ? content.text : "Workflow finished"));
    },
  });
  pi.registerCommand("workflow", {
    description: "Inspect and control workflows for this Pi session",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command === "doctor") {
        const { doctor, doctorExitCode, formatDoctorReport } = await import("./doctor.js");
        const report = await doctor({ cwd: ctx.cwd, activeTools: pi.getActiveTools().filter((tool) => tool !== "workflow" && tool !== "workflow_respond") });
        ctx.ui.notify(formatDoctorReport(report), doctorExitCode(report) ? "warning" : "info");
        return;
      }
      await ensureSessionLease(ctx.cwd, ctx.sessionManager.getSessionId());
      const loadStores = async () => {
        const entries = await Promise.all((await listRunIds(ctx.cwd, ctx.sessionManager.getSessionId(), home)).map(async (runId) => {
          const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
          try { return { store, loaded: await store.load() }; }
          catch { if (!await store.isComplete()) await store.delete(true).catch(() => undefined); return undefined; }
        }));
        return entries.filter((entry): entry is { store: RunStore; loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> } } => entry !== undefined);
      };
      let stores = await loadStores();
      const usage = "Usage: /workflow [doctor|model-aliases], or /workflow pause|resume|stop|approve|reject|delete <run-id> [checkpoint or proposal-id]. Use workflow_resume for budget patches."
      const setWorkflowStatus = (text: string | undefined) => {
        const setStatus = uiHostCapabilities(ctx.ui)?.setStatus;
        setStatus?.call(ctx.ui, "workflow-stop", text);
      };
      const runAction = async (actionCommand: string, keepContext: boolean, status: (text: string | undefined) => void = setWorkflowStatus): Promise<"dashboard" | "picker" | "done"> => {
        const [action, runId, ...rest] = actionCommand.split(/\s+/);
        try {
          const run = runId ? runs.get(runId) : undefined;
          const storedEntry = runId ? stores.find(({ store }) => store.runId === runId) : undefined;
          const stored = storedEntry ? { store: storedEntry.store, loaded: await storedEntry.store.load() } : undefined;
          if ((action === "approve" || action === "reject") && runId && rest.length) {
            const accepted = await answerCheckpoint(runId, rest.join(" "), action === "approve", true);
            ctx.ui.notify(accepted ? `${action === "approve" ? "Approved" : "Rejected"} checkpoint ${rest.join(" ")}.` : "Checkpoint is not awaiting a response.", accepted ? "info" : "warning");
            return keepContext ? "dashboard" : "done";
          }
          if ((action === "budget-approve" || action === "budget-reject") && runId && rest[0]) {
            const result = await answerBudgetDecision(runId, rest[0], action === "budget-approve", true);
            ctx.ui.notify(result ? `Budget adjustment ${rest[0]} ${result.approved ? "approved" : "rejected"}.` : "Budget proposal is not pending.", result ? "info" : "warning");
            return keepContext ? "dashboard" : "done";
          }
          if (action === "delete" && stored) {
            if (!["completed", "failed", "stopped"].includes(stored.loaded.run.state)) { ctx.ui.notify("Stop the workflow before deleting it.", "warning"); return keepContext ? "dashboard" : "done"; }
            if (!await ctx.ui.confirm("Delete workflow?", `Delete ${stored.loaded.run.workflowName} (${stored.store.runId}) and all owned artifacts? This cannot be undone.`)) return keepContext ? "dashboard" : "done";
            await stored.store.delete(true); runs.delete(stored.store.runId); terminalRunStates.delete(stored.store.runId); ctx.ui.notify(`Deleted workflow ${stored.store.runId}.`, "info"); return keepContext ? "picker" : "done";
          }
          if (action === "pause" && run) { await run.lifecycle.pause(); ctx.ui.notify(`Paused workflow ${run.store.runId}.`, "info"); return keepContext ? "dashboard" : "done"; }
          if (action === "resume" && run) {
            if (run.lifecycle.state === "budget_exhausted") {
              const patch: unknown = rest.length ? JSON.parse(rest.join(" ")) as unknown : undefined;
              const result = await resumeWorkflowRun(run.store.runId, patch);
              ctx.ui.notify(result.state === "running" ? `Resumed workflow ${run.store.runId}.` : `Budget adjustment for ${run.store.runId} is awaiting approval.`, result.state === "running" ? "info" : "warning");
            } else {
              if (run.lifecycle.state === "interrupted") await coldResumeRun(run, ctx.hasUI, ctx.ui, projectTrusted(ctx), ctx);
              else {
                if (run.lifecycle.state === "paused") await refreshPausedRunAliases(run, ctx);
                await run.lifecycle.resume();
              }
              ctx.ui.notify(`Resumed workflow ${run.store.runId}.`, "info");
            }
            return keepContext ? "dashboard" : "done";
          }
          if (action === "adjust" && run?.lifecycle.state === "budget_exhausted") {
            const input = await uiHostCapabilities(ctx.ui)?.input?.call(ctx.ui, "Budget patch (JSON)", "{\"tokens\":{\"hard\":null}}" );
            if (input === undefined) return keepContext ? "dashboard" : "done";
            const result = await resumeWorkflowRun(run.store.runId, JSON.parse(input));
            ctx.ui.notify(result.state === "running" ? `Resumed workflow ${run.store.runId}.` : `Budget adjustment for ${run.store.runId} is awaiting approval.`, result.state === "running" ? "info" : "warning");
            return keepContext ? "dashboard" : "done";
          }
          if (action === "stop" && run) {
            const workflowName = stored?.loaded.run.workflowName ?? run.metadata.name;
            if (keepContext && !await ctx.ui.confirm("Stop workflow?", `Stop workflow ${workflowName} (${run.store.runId})? This cannot be undone.`)) return "dashboard";
            if (keepContext) status(`Stopping workflow ${workflowName}...`);
            await stopWorkflowRun(run.store.runId);
            if (keepContext) status(`Workflow ${run.store.runId} stopped.`);
            ctx.ui.notify(`Stopped workflow ${run.store.runId}.`, "info"); return keepContext ? "dashboard" : "done";
          }
          if (keepContext && action && runId) { ctx.ui.notify(`Cannot ${action} workflow ${runId}: the run is no longer available.`, "warning"); return "dashboard"; }
          ctx.ui.notify(usage, "warning");
          return "done";
        } catch (error) {
          if (!keepContext) throw error;
          const message = error instanceof Error ? error.message : String(error);
          if (action === "stop") status(`Could not stop workflow ${runId ?? ""}: ${message}`);
          ctx.ui.notify(`Cannot ${action ?? "workflow action"}${runId ? ` for ${runId}` : ""}: ${message}`, "warning");
          return "dashboard";
        }
      };
      const manageAliases = async (): Promise<void> => {
        const settingsPath = workflowSettingsPath();
        const modelRegistry = contextHostCapabilities(ctx).modelRegistry;
        const available = () => [...new Set((modelRegistry?.getAvailable?.() ?? []).map((model) => `${model.provider}/${model.id}`))].sort();
        const selectTarget = async (): Promise<string | undefined> => {
          const models = available();
          const choice = await ctx.ui.select("Model alias target", [...models, "Manual model ID", "Back"]);
          if (!choice || choice === "Back") return undefined;
          if (choice !== "Manual model ID") return choice;
          return (await ctx.ui.input("Manual model ID", "provider/model[:thinking]"))?.trim() || undefined;
        };
        const save = (aliases: Readonly<Record<string, string>>): boolean => {
          try { saveModelAliases(settingsPath, aliases); ctx.ui.notify(`Saved model aliases to ${settingsPath}.`, "info"); return true; }
          catch (error) { ctx.ui.notify(`${settingsPath}: ${error instanceof Error ? error.message : String(error)}`, "error"); return false; }
        };
        for (;;) {
          let aliases: Readonly<Record<string, string>>;
          try { aliases = loadSettings(settingsPath).modelAliases ?? {}; }
          catch (error) { ctx.ui.notify(`${settingsPath}: ${error instanceof Error ? error.message : String(error)}`, "error"); return; }
          const names = Object.keys(aliases).sort();
          const listing = names.length ? names.map((name) => `${name} = ${aliases[name] ?? ""}`).join("\n") : "(none)";
          const options = ["Add alias", ...names.map((name) => `Edit ${name}`), ...names.map((name) => `Delete ${name}`), "Back"];
          const choice = await ctx.ui.select(`Model aliases\n${listing}`, options);
          if (!choice || choice === "Back") return;
          if (choice === "Add alias") {
            const name = (await ctx.ui.input("Alias name", "reviewer-model"))?.trim();
            if (!name) continue;
            if (Object.prototype.hasOwnProperty.call(aliases, name)) { ctx.ui.notify(`Alias ${name} already exists; choose Edit ${name}.`, "warning"); continue; }
            const target = await selectTarget();
            if (!target) continue;
            const next = { ...aliases, [name]: target };
            try { validateModelAliases(next, settingsPath); } catch (error) { ctx.ui.notify(`${settingsPath}: ${error instanceof Error ? error.message : String(error)}`, "error"); continue; }
            const parsed = parseModelReference(target);
            if (!available().includes(`${parsed.provider}/${parsed.model}`)) {
              ctx.ui.notify(`Warning: ${target} is not currently available in Pi.`, "warning");
              if (!await ctx.ui.confirm("Save unknown model?", "Save this target for cross-machine portability?")) continue;
            }
            save(next);
            continue;
          }
          const edit = /^Edit (.+)$/.exec(choice);
          if (edit?.[1]) {
            const target = await selectTarget();
            if (!target) continue;
            const next = { ...aliases, [edit[1]]: target };
            try { validateModelAliases(next, settingsPath); } catch (error) { ctx.ui.notify(`${settingsPath}: ${error instanceof Error ? error.message : String(error)}`, "error"); continue; }
            const parsed = parseModelReference(target);
            if (!available().includes(`${parsed.provider}/${parsed.model}`)) {
              ctx.ui.notify(`Warning: ${target} is not currently available in Pi.`, "warning");
              if (!await ctx.ui.confirm("Save unknown model?", "Save this target for cross-machine portability?")) continue;
            }
            save(next);
            continue;
          }
          const deletion = /^Delete (.+)$/.exec(choice);
          if (deletion?.[1] && await ctx.ui.confirm("Delete model alias?", `Delete ${deletion[1]}? Future workflow resumes using this alias may fail.`)) {
            const next = Object.fromEntries(Object.entries(aliases).filter(([name]) => name !== deletion[1]));
            save(next);
          }
        }
      };
      if (command === "model-aliases") {
        if (!ctx.hasUI) { ctx.ui.notify("Model alias management requires UI.", "warning"); return; }
        await manageAliases();
        return;
      }
      if (!command) {
        for (;;) {
          if (!ctx.hasUI) {
            if (!stores.length) { ctx.ui.notify("No workflow runs in this session.", "info"); return; }
            const details = await Promise.all(stores.map(async ({ store, loaded }) => formatNavigatorRun(loaded, await store.awaitingCheckpoints(), await store.worktrees())));
            ctx.ui.notify(details.join("\n\n"), "info"); return;
          }
          const sorted = navigatorAttentionSort(stores);
          const labels = navigatorRunLabels(sorted);
          const terminalStates = new Set(["completed", "failed", "stopped"]);
          const hasCompleted = sorted.some(({ loaded: { run } }) => run.state === "completed");
          const pickerOptions = [...labels, "Model aliases", "Close", ...(hasCompleted ? ["Delete all completed"] : [])];
          const runChoice = await ctx.ui.select("Workflows\n", pickerOptions);
          if (!runChoice || runChoice === "Close") return;
          if (runChoice === "Model aliases") { await manageAliases(); stores = await loadStores(); continue; }
          if (runChoice === "Delete all completed") {
            if (!await ctx.ui.confirm("Delete completed runs?", "Delete all completed workflow runs and their artifacts? This cannot be undone.")) continue;
            for (const entry of sorted) {
              if (entry.loaded.run.state === "completed") { await entry.store.delete(true); runs.delete(entry.store.runId); terminalRunStates.delete(entry.store.runId); }
            }
            ctx.ui.notify("Deleted all completed workflow runs.", "info"); stores = await loadStores(); continue;
          }
          const runIndex = labels.indexOf(runChoice);
          if (runIndex < 0) return;
          const selected = sorted[runIndex];
          if (!selected) return;
          const { store } = selected;
          const copyArtifact = async (value: string, artifact: string) => {
            try {
              await clipboard(value);
              ctx.ui.notify(`Copied ${artifact}.`, "info");
            } catch (error) {
              ctx.ui.notify(`Failed to copy ${artifact}: ${error instanceof Error ? error.message : String(error)}`, "error");
            }
          };
          const openTranscript = async (transcript: string): Promise<void> => {
            try {
              const entries = SessionManager.open(transcript).buildContextEntries();
              if (ctx.mode !== "tui") { ctx.ui.notify(`Transcript: ${transcript}`, "info"); return; }
              await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
                let offset = 0;
                let renderedLines: string[] = [];
                const viewport = () => Math.max(1, tuiRows(tui) - 3);
                const move = (delta: number) => { offset = Math.max(0, Math.min(Math.max(0, renderedLines.length - viewport()), offset + delta)); };
                return {
                  render(width: number) {
                    renderedLines = transcriptLines(entries).flatMap((line) => line ? truncateToVisualLines(line, Number.MAX_SAFE_INTEGER, width, 0).visualLines : [""]);
                    offset = Math.min(offset, Math.max(0, renderedLines.length - viewport()));
                    return [theme.fg("accent", "Native Pi transcript"), ...renderedLines.slice(offset, offset + viewport()), "", theme.fg("dim", "↑↓/pgup/pgdn scroll · esc close")];
                  },
                  invalidate() {},
                  handleInput(data: string) {
                    if (keybindings.matches(data, "tui.select.up")) move(-1);
                    else if (keybindings.matches(data, "tui.select.down")) move(1);
                    else if (keybindings.matches(data, "tui.select.pageUp")) move(-viewport());
                    else if (keybindings.matches(data, "tui.select.pageDown")) move(viewport());
                    else if (keybindings.matches(data, "tui.editor.cursorLineStart")) offset = 0;
                    else if (keybindings.matches(data, "tui.editor.cursorLineEnd")) offset = Math.max(0, renderedLines.length - viewport());
                    else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
                    tui.requestRender();
                  },
                };
              }, { overlay: true });
            } catch (error) {
              ctx.ui.notify(`Cannot open transcript: ${error instanceof Error ? error.message : String(error)}`, "warning");
            }
          };
          const loadDashboard = async () => {
            const loaded = await store.load();
            const checkpoints = await store.awaitingCheckpoints();
            const worktrees = await store.worktrees();
            const actions = new Map<string, string>();
            const copies = new Map<string, { value: string; artifact: string }>();
            const reviews = new Map<string, AwaitingCheckpoint>();
            const add = (label: string, value: string) => { actions.set(label, `${value} ${store.runId}`); };
            const addCopy = (label: string, value: string, artifact: string) => { actions.set(label, "copy"); copies.set(label, { value, artifact }); };
            if (loaded.run.state === "running") add("Pause", "pause");
            if (["paused", "interrupted"].includes(loaded.run.state)) add("Resume", "resume");
            if (loaded.run.state === "budget_exhausted") { actions.set("Resume unchanged", `resume ${store.runId}`); actions.set("Adjust budget", `adjust ${store.runId}`); }
            for (const decision of await store.pendingWorkflowDecisions()) {
              const id = decision.proposalId.slice(0, 8);
              actions.set(`Approve budget ${id}`, `budget-approve ${store.runId} ${decision.proposalId}`);
              actions.set(`Reject budget ${id}`, `budget-reject ${store.runId} ${decision.proposalId}`);
            }
            if (!terminalStates.has(loaded.run.state)) add("Stop", "stop");
            for (const cp of checkpoints) {
              if (ctx.mode === "tui") {
                const label = `Review ${cp.name}`;
                actions.set(label, "review");
                reviews.set(label, cp);
              } else {
                actions.set(`Approve ${cp.name}`, `approve ${store.runId} ${cp.name}`);
                actions.set(`Reject ${cp.name}`, `reject ${store.runId} ${cp.name}`);
              }
            }
            if (ctx.mode !== "tui") actions.set("Refresh", "refresh");
            else actions.set("View script", "view-script");
            const transcripts = [...new Set([...loaded.run.agents.flatMap((agent) => (agent.attemptDetails ?? []).map((attempt) => attempt.sessionFile)), ...loaded.run.nativeSessions.map(({ sessionFile }) => sessionFile)])];
            if (loaded.run.agents.length) actions.set("Agents...", "agents");
            if (!loaded.run.agents.length && ctx.mode === "tui" && transcripts.length) actions.set("View transcript", "view-transcript");
            if (!loaded.run.agents.length && transcripts.length) actions.set("Transcript paths", "transcripts");
            if (terminalStates.has(loaded.run.state)) add("Delete", "delete");
            if (ctx.mode === "tui") {
              addCopy("Copy run path", store.directory, "run path");
              addCopy("Copy run ID", store.runId, "run ID");
            }
            return { dashboard: formatNavigatorDashboard(loaded.run, checkpoints, worktrees), actions, copies, reviews, transcripts, script: loaded.snapshot.script, agents: loaded.run.agents, worktrees };
          };
          const selectAgent = async (dashboard: Awaited<ReturnType<typeof loadDashboard>>): Promise<void> => {
            const byId = new Map(dashboard.agents.map((agent) => [agent.id, agent]));
            const title = (agent: AgentRecord): string => {
              const parents: string[] = [];
              for (let parentId = agent.parentId; parentId; parentId = byId.get(parentId)?.parentId) {
                const parent = byId.get(parentId);
                if (!parent) break;
                parents.unshift(parent.label ?? parent.name);
              }
              return [...((agent.structuralPath ?? []).length ? [(agent.structuralPath ?? []).join(" > ")] : []), ...(agent.parentBreadcrumb ? [agent.parentBreadcrumb] : []), ...parents, agent.label ?? agent.name].join(" > ");
            };
            const labels = dashboard.agents.map((agent, index) => `#${String(index + 1)} ${title(agent)} [${agent.state}]`);
            const selectedLabel = await ctx.ui.select("Agents", [...labels, "Back"]);
            const selectedIndex = selectedLabel ? labels.indexOf(selectedLabel) : -1;
            const selected = selectedIndex >= 0 ? dashboard.agents[selectedIndex] : undefined;
            if (!selected) return;
            const attempts = [...(selected.attemptDetails ?? [])].sort((left, right) => left.attempt - right.attempt);
            const worktree = selected.worktreeOwner ? dashboard.worktrees.find((candidate) => candidate.owner === selected.worktreeOwner) : undefined;
            const actions = [
              ...(attempts.length ? ["View transcript", "Copy transcript path"] : []),
              ...(worktree ? ["Copy branch", "Copy worktree path"] : []),
              "Copy agent ID",
              "Back",
            ];
            const chooseAttempt = async (): Promise<AgentAttemptSummary | undefined> => {
              const choices = attempts.map((attempt) => `Attempt ${String(attempt.attempt)}`);
              const choice = choices.length === 1 ? choices[0] : await ctx.ui.select("Transcript attempts", [...choices, "Back"]);
              const index = choice ? choices.indexOf(choice) : -1;
              return index >= 0 ? attempts[index] : undefined;
            };
            for (;;) {
              const action = await ctx.ui.select(title(selected), actions);
              if (!action || action === "Back") return;
              if (action === "Copy agent ID") { await copyArtifact(selected.id, "agent ID"); continue; }
              if (action === "Copy branch" && worktree) { await copyArtifact(worktree.branch, "branch"); continue; }
              if (action === "Copy worktree path" && worktree) { await copyArtifact(worktree.path, "worktree path"); continue; }
              if (action === "View transcript" || action === "Copy transcript path") {
                const attempt = await chooseAttempt();
                if (!attempt) continue;
                if (action === "Copy transcript path") await copyArtifact(attempt.sessionFile, "transcript path");
                else await openTranscript(attempt.sessionFile);
              }
            }
          };
          for (;;) {
            let view = await loadDashboard();
            const actionChoice = ctx.mode === "tui"
              ? await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
                  let options = [...view.actions.keys(), "Close"];
                  let selectedIndex = 0;
                  let dashboardOffset = 0;
                  let refreshing = false;
                  let disposed = false;
                  let stopRequested = false;
                  let stopStatus: string | undefined;
                  const terminalRows = () => Math.max(1, tuiRows(tui));
                  const keyLabels: Record<string, string> = { up: "↑", down: "↓", pageUp: "pgup", pageDown: "pgdn", escape: "esc" };
                  const keyLabel = (binding: string, fallback: string) => {
                    const keys = keybindingKeys(keybindings, binding);
                    return keys?.length ? keys.map((key) => keyLabels[key] ?? key).join("/") : fallback;
                  };
                  const dashboardLayout = () => {
                    const rows = terminalRows();
                    const hintRows = rows >= 4 ? 1 : 0;
                    const separatorRows = rows >= 6 ? 1 : 0;
                    const available = Math.max(1, rows - hintRows - separatorRows);
                    const actionViewport = Math.min(options.length, Math.max(1, Math.floor(available / 2)));
                    return { rows, hintRows, separatorRows, actionViewport, dashboardViewport: available - actionViewport };
                  };
                  const updateDashboard = async (selectedOption: string | undefined) => {
                    const next = await loadDashboard();
                    if (disposed) return;
                    view = next;
                    options = [...view.actions.keys(), "Close"];
                    selectedIndex = Math.max(0, options.indexOf(selectedOption ?? ""));
                    tui.requestRender();
                  };
                  const requestStop = () => {
                    if (stopRequested) return;
                    stopRequested = true;
                    stopStatus = undefined;
                    setWorkflowStatus(undefined);
                    const selectedOption = options[selectedIndex];
                    void runAction(`stop ${store.runId}`, true, (status) => {
                      stopStatus = status;
                      setWorkflowStatus(status);
                      if (!disposed) tui.requestRender();
                    }).then(() => updateDashboard(selectedOption)).catch((error: unknown) => {
                      if (disposed) return;
                      stopStatus = `Could not stop workflow ${store.runId}: ${error instanceof Error ? error.message : String(error)}`;
                      tui.requestRender();
                    }).finally(() => {
                      stopRequested = false;
                      if (!disposed) tui.requestRender();
                    });
                  };
                  const timer = setInterval(() => {
                    if (refreshing || stopRequested) return;
                    refreshing = true;
                    const selectedOption = options[selectedIndex];
                    void updateDashboard(selectedOption).catch(() => undefined).finally(() => { refreshing = false; });
                  }, 1000);
                  timer.unref();
                  return {
                    render(width: number) {
                      const dashboard = stopStatus ? `${view.dashboard}\n\n${stopStatus}` : view.dashboard;
                      const dashboardLines = truncateToVisualLines(theme.fg("accent", dashboard), Number.MAX_SAFE_INTEGER, width, 1).visualLines;
                      const actionLines = options.map((option, index) => truncateToVisualLines(`${index === selectedIndex ? "→ " : "  "}${option}`, Number.MAX_SAFE_INTEGER, width, 1).visualLines[0] ?? "");
                      const layout = dashboardLayout();
                      const hint = truncateToVisualLines(theme.fg("dim", `${keyLabel("tui.select.up", "↑")}/${keyLabel("tui.select.down", "↓")} navigate${dashboardLines.length > layout.dashboardViewport ? ` · ${keyLabel("tui.select.pageUp", "pgup")}/${keyLabel("tui.select.pageDown", "pgdn")} scroll` : ""} · ${keyLabel("tui.select.confirm", "enter")} select · ${keyLabel("tui.select.cancel", "esc")} close · auto-refresh 1s`), Number.MAX_SAFE_INTEGER, width, 1).visualLines[0] ?? "";
                      const compact = [...dashboardLines, "", ...actionLines, "", hint];
                      if (compact.length <= layout.rows) { dashboardOffset = 0; return compact; }
                      const maxOffset = Math.max(0, dashboardLines.length - layout.dashboardViewport);
                      dashboardOffset = Math.max(0, Math.min(maxOffset, dashboardOffset));
                      const actionStart = Math.min(Math.max(0, selectedIndex - layout.actionViewport + 1), Math.max(0, options.length - layout.actionViewport));
                      return [
                        ...dashboardLines.slice(dashboardOffset, dashboardOffset + layout.dashboardViewport),
                        ...(layout.separatorRows && layout.dashboardViewport ? [""] : []),
                        ...actionLines.slice(actionStart, actionStart + layout.actionViewport),
                        ...(layout.hintRows ? [hint] : []),
                      ];
                    },
                    invalidate() {},
                    handleInput(data: string) {
                      if (stopRequested) return;
                      if (keybindings.matches(data, "tui.select.up")) selectedIndex = (selectedIndex + options.length - 1) % options.length;
                      else if (keybindings.matches(data, "tui.select.down")) selectedIndex = (selectedIndex + 1) % options.length;
                      else if (keybindings.matches(data, "tui.select.pageUp")) {
                        dashboardOffset = Math.max(0, dashboardOffset - Math.max(1, dashboardLayout().dashboardViewport));
                      }
                      else if (keybindings.matches(data, "tui.select.pageDown")) {
                        dashboardOffset += Math.max(1, dashboardLayout().dashboardViewport);
                      }
                      else if (keybindings.matches(data, "tui.select.confirm")) {
                        if (options[selectedIndex] === "Stop") requestStop();
                        else done(options[selectedIndex]);
                      }
                      else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
                      tui.requestRender();
                    },
                    dispose() { disposed = true; clearInterval(timer); setWorkflowStatus(undefined); },
                  };
                }, { overlay: true })
              : await ctx.ui.select(view.dashboard, [...view.actions.keys(), "Close"]);
            if (!actionChoice || actionChoice === "Close") return;
            if (actionChoice === "Agents...") { await selectAgent(view); continue; }
            if (actionChoice === "Refresh") continue;
            if (actionChoice === "View script") {
              await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
                const highlighted = highlightCode(view.script, "javascript");
                let offset = 0;
                let renderedLines: string[] = [];
                const viewport = () => Math.max(1, tuiRows(tui) - 3);
                const move = (delta: number) => {
                  const maxOffset = Math.max(0, renderedLines.length - viewport());
                  offset = Math.max(0, Math.min(maxOffset, offset + delta));
                };
                return {
                  render(width: number) {
                    renderedLines = highlighted.flatMap((line) => line ? truncateToVisualLines(line, Number.MAX_SAFE_INTEGER, width, 0).visualLines : [""]);
                    const maxOffset = Math.max(0, renderedLines.length - viewport());
                    offset = Math.min(offset, maxOffset);
                    return [
                      theme.fg("accent", "Workflow script"),
                      ...renderedLines.slice(offset, offset + viewport()),
                      "",
                      theme.fg("dim", "↑↓/pgup/pgdn scroll · esc close"),
                    ];
                  },
                  invalidate() {},
                  handleInput(data: string) {
                    if (keybindings.matches(data, "tui.select.up")) move(-1);
                    else if (keybindings.matches(data, "tui.select.down")) move(1);
                    else if (keybindings.matches(data, "tui.select.pageUp")) move(-viewport());
                    else if (keybindings.matches(data, "tui.select.pageDown")) move(viewport());
                    else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
                    tui.requestRender();
                  },
                };
              }, { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } });
              continue;
            }
            if (actionChoice === "View transcript") {
              const transcript = await ctx.ui.select("Native Pi transcripts", [...view.transcripts, "Back"]);
              if (transcript && transcript !== "Back") await openTranscript(transcript);
              continue;
            }
            if (actionChoice === "Transcript paths") {
              const transcript = await ctx.ui.select("Native Pi transcript paths", [...view.transcripts, "Back"]);
              if (transcript && transcript !== "Back") {
                if (ctx.mode === "tui") await copyArtifact(transcript, "transcript path");
                else ctx.ui.notify(transcript, "info");
              }
              continue;
            }
            const copy = view.copies.get(actionChoice);
            if (copy) { await copyArtifact(copy.value, copy.artifact); continue; }
            if (actionChoice.startsWith("Review ")) {
              const checkpoint = view.reviews.get(actionChoice);
              if (!checkpoint) continue;
              const decision = await ctx.ui.custom<"Approve" | "Reject" | undefined>((tui, theme, keybindings, done) => {
                const options = ["Approve", "Reject", "Cancel"];
                let selectedIndex = 0;
                let offset = 0;
                let renderedLines: string[] = [];
                const layout = () => {
                  const rows = Math.max(1, tuiRows(tui));
                  const compactControls = rows < 4;
                  const titleRows = rows >= 5 ? 1 : 0;
                  const hintRows = rows >= 8 ? 1 : 0;
                  const separatorRows = rows >= 8 ? 2 : 0;
                  const controlRows = compactControls ? 1 : options.length;
                  const contentViewport = Math.max(0, rows - titleRows - hintRows - separatorRows - controlRows);
                  return { rows, compactControls, titleRows, hintRows, separatorRows, contentViewport };
                };
                const move = (delta: number) => {
                  const maxOffset = Math.max(0, renderedLines.length - layout().contentViewport);
                  offset = Math.max(0, Math.min(maxOffset, offset + delta));
                };
                return {
                  render(width: number) {
                    renderedLines = truncateToVisualLines(formatCheckpointReview(checkpoint), Number.MAX_SAFE_INTEGER, width, 0).visualLines;
                    const currentLayout = layout();
                    const maxOffset = Math.max(0, renderedLines.length - currentLayout.contentViewport);
                    offset = Math.min(offset, maxOffset);
                    const hint = truncateToVisualLines(theme.fg("dim", "↑↓/pgup/pgdn scroll · enter select · esc cancel"), Number.MAX_SAFE_INTEGER, width, 1).visualLines[0] ?? "";
                    const controls = currentLayout.compactControls
                      ? [options.map((option, index) => `${index === selectedIndex ? "[" : " "}${option}${index === selectedIndex ? "]" : " "}`).join(" ")]
                      : options.map((option, index) => `${index === selectedIndex ? "→ " : "  "}${option}`);
                    return [
                      ...(currentLayout.titleRows ? [theme.fg("accent", "Checkpoint review")] : []),
                      ...renderedLines.slice(offset, offset + currentLayout.contentViewport),
                      ...(currentLayout.separatorRows ? [""] : []),
                      ...controls,
                      ...(currentLayout.separatorRows ? [""] : []),
                      ...(currentLayout.hintRows ? [hint] : []),
                    ];
                  },
                  invalidate() {},
                  handleInput(data: string) {
                    if (keybindings.matches(data, "tui.select.up")) selectedIndex = (selectedIndex + options.length - 1) % options.length;
                    else if (keybindings.matches(data, "tui.select.down")) selectedIndex = (selectedIndex + 1) % options.length;
                    else if (keybindings.matches(data, "tui.select.pageUp")) move(-layout().contentViewport);
                    else if (keybindings.matches(data, "tui.select.pageDown")) move(layout().contentViewport);
                    else if (keybindings.matches(data, "tui.select.confirm")) done(options[selectedIndex] === "Cancel" ? undefined : options[selectedIndex] as "Approve" | "Reject");
                    else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
                    tui.requestRender();
                  },
                };
              }, { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } });
              if (decision) {
                const accepted = await answerCheckpoint(store.runId, checkpoint.name, decision === "Approve", true);
                if (!accepted) ctx.ui.notify("Checkpoint is not awaiting a response.", "warning");
              }
              continue;
            }
            const actionCommand = view.actions.get(actionChoice);
            if (!actionCommand) { ctx.ui.notify(`Cannot select workflow action: ${actionChoice}`, "warning"); continue; }
            const outcome = await runAction(actionCommand, true);
            if (outcome === "picker") { stores = await loadStores(); break; }
          }
        }
      }
      await runAction(command, false);
    },
  });
  pi.on("session_shutdown", async () => {
    try {
      await Promise.all([...runs.entries()].map(async ([runId, run]) => {
        if (["completed", "failed", "stopped", "budget_exhausted"].includes(run.lifecycle.state)) { await run.completion?.catch(() => undefined); return; }
        if (!["completed", "failed", "stopped", "budget_exhausted"].includes(run.lifecycle.state)) {
          try { await run.lifecycle.terminal("interrupted"); } catch (error) { if (!["completed", "failed", "stopped", "budget_exhausted"].includes(run.lifecycle.state)) throw error; }
          run.abortController.abort();
          run.execution?.cancel();
          await scheduler.cancelRun(runId);
        }
        await run.completion?.catch(() => undefined);
      }));
      await scheduler.flush();
    } finally {
      await releaseSessionLease();
      resetWorkflowRegistry();
    }
  });
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

export { acquireSessionLease, projectStorageKey, RunStore, runsDirectory, SessionLease, structuralPath } from "./persistence.js";
export type { AwaitingCheckpoint, CompletedOperation, ConversationHead, NativeSessionReference, PendingWorkflowDecision, PersistedConversation, PersistedOwnershipNode, PersistedRun, WorktreeReference } from "./persistence.js";
export { FairAgentScheduler, WorkflowAgentExecutor } from "./agent-execution.js";
export type { AgentAccounting, AgentAttempt, AgentBudgetHooks, AgentDefinition, AgentExecutionOptions, AgentExecutionResult, AgentExecutionRoot, AgentProgress, AgentSetup, AgentSetupContext, AgentSetupHook, AgentToolCallProgress, RegisteredAgentSetupHook, SessionInput } from "./agent-execution.js";
export { doctor, doctorExitCode, formatDoctorReport } from "./doctor.js";
export type { DoctorDiagnostic, DoctorOptions, DoctorPiState, DoctorReport, DoctorRole, DoctorSeverity, DoctorTrust, DoctorWorkflow } from "./doctor.js";