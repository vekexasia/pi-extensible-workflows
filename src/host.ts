import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { copyToClipboard, getAgentDir, highlightCode, truncateToVisualLines, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import { createNativeAgentSession, FairAgentScheduler, WorkflowAgentExecutor, type AgentActivity, type AgentAttempt, type AgentDefinition, type AgentProgress, type AgentProviderFailure, type AgentProviderRecovery, type SessionFactory } from "./agent-execution.js";
import { herdrPaneId, openHerdrPane } from "./herdr.js";
import { acquireSessionLease, listRunIds, RunStore, SessionLease, structuralPath as operationPath } from "./persistence.js";
import type { AwaitingCheckpoint, PersistedRun, WorktreeReference } from "./persistence.js";
import { budgetRelaxed, budgetUsage, mergeBudget, resumeBudgetAllowed, validateBudget, validateBudgetPatch, WorkflowBudgetRuntime } from "./budget.js";
import { asWorkflowError, aliasDrift, createLaunchSnapshot, deepFreeze, errorCode, errorText, fail, isWorkflowAuthored, jsonValue, modelCapability, object, parseModelReference, parseThinking, positiveInteger, resolveModelReference, validateModelAliases } from "./utils.js";
import { launchScriptForSnapshot, loadAgentDefinitions, loadSettings, preflight, resolveAgentResourcePolicy, saveModelAliases, validateAgentOptions, validateCheckpoint, validateShellOptions, validateWorkflowLaunchWithRegistry, workflowPrompt, workflowSettingsPath } from "./validation.js";
import { beginWorkflowExtensionLoading, loadingRegistry, resetWorkflowRegistry, type WorkflowRegistryApi } from "./registry.js";
import { agentIdentityPath, agentWorktree, encoded, executeShellCommand, persistActiveAgentAttempt, persistAgentAttempts, readShellResult, runWorkflow, shellIdentityPath } from "./execution.js";
import { ERROR_CODES, LAUNCH_SNAPSHOT_IDENTITY_VERSION, WORKFLOW_AGENT_STATE_CHANGED_EVENT, WORKFLOW_BUDGET_EVENT, WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, WORKFLOW_PHASE_CHANGED_EVENT, WORKFLOW_RUN_COMPLETED_EVENT, WORKFLOW_RUN_FAILED_EVENT, WORKFLOW_RUN_RESUMED_EVENT, WORKFLOW_RUN_STARTED_EVENT, WORKFLOW_RUN_STATE_CHANGED_EVENT, WORKFLOW_WORKTREE_CREATED_EVENT, WorkflowError, type AgentAttemptSummary, type AgentOptions, type AgentRecord, type BudgetApprovalRequest, type BudgetEvent, type JsonValue, type LaunchSnapshot, type ModelSpec, type RunState, type ShellIdentity, type ShellOptions, type ShellResult, type WorkflowBridge, type WorkflowCheckpointState, type WorkflowErrorCode, type WorkflowErrorShape, type WorkflowEventBase, type WorkflowFailureAgent, type WorkflowFailureDiagnostics, type WorkflowFunctionContext, type WorkflowExecution, type WorkflowMetadata, type WorkflowRetryProvenance, type WorkflowRunContext, type WorkflowSiblingAgent, type WorkflowWorktreeReference } from "./types.js";
const SETTLED_AGENT_STATES: ReadonlySet<import("./types.js").AgentState> = new Set(["completed", "failed", "cancelled"]);
export interface WorkflowProgressStyles {
  accent(text: string): string;
  success(text: string): string;
  error(text: string): string;
  warning(text: string): string;
  muted(text: string): string;
  dim(text: string): string;
  bold(text: string): string;
}
const PLAIN_WORKFLOW_PROGRESS_STYLES: WorkflowProgressStyles = { accent: (text) => text, success: (text) => text, error: (text) => text, warning: (text) => text, muted: (text) => text, dim: (text) => text, bold: (text) => text };
const WORKFLOW_FAILURE_DIAGNOSTICS = Symbol("workflowFailureDiagnostics");

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
  MISSING_WORKFLOW: (detail) => `The registered workflow function is unavailable: ${detail}.`,
  UNKNOWN_MODEL: (detail) => `The workflow requested the unavailable model ${detail.replace(/^(?:Unknown model(?: for role [^:]+)?|Invalid model spec):\s*/, "")}.`,
  UNKNOWN_TOOL: (detail) => `The workflow requested the unavailable tool ${detail.replace(/^Unknown tool:\s*/, "")}.`,
  UNKNOWN_AGENT_TYPE: (detail) => `The workflow requested the unavailable agent role ${detail.replace(/^Unknown agent role:\s*/, "")}.`,
  RUN_OWNED: (detail) => /already owned|active ownership/.test(detail) ? "The workflow session is already in use." : `The workflow session is already in use: ${detail}.`,
  RPC_LIMIT_EXCEEDED: (detail) => `The workflow communication data exceeded its size limit: ${detail}.`,
  SHELL_FAILED: (detail) => `The workflow shell command failed: ${detail}.`,
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
    if (this.#active === 0 && this.state === "pausing") await this.#set("paused", "pause");
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

export function formatWorkflowPreview(args: { script?: unknown; workflow?: unknown; name?: unknown; description?: unknown }): string {
  const explicitName = typeof args.name === "string" && args.name.trim() ? args.name.trim() : undefined;
  const registeredName = typeof args.workflow === "string" && args.workflow.trim() ? args.workflow.trim() : undefined;
  const name = registeredName ?? explicitName ?? "workflow";
  if (typeof args.script !== "string" || !args.script.trim()) return `workflow ${name}${registeredName ? "\nRegistered function" : ""}`;
  return [`workflow ${name}`, typeof args.description === "string" && args.description.trim() ? args.description.trim() : ""].filter(Boolean).join("\n");
}
export const WORKFLOW_TOOL_LABEL = "Workflow";
export const WORKFLOW_TOOL_DESCRIPTION = "Run a deterministic JavaScript workflow";
export const WORKFLOW_TOOL_PROMPT_SNIPPET = "Run a deterministic, resumable JavaScript workflow that orchestrates subagents. Inline launches require an explicit non-empty name; registered function launches reject name and use workflow as the run name. Runs in the background by default; completion arrives as a follow-up message. Foreground results include the completed run ID. Use workflow_retry with an explicit failed run ID to replay completed structural operations; parentRunId only reuses named worktrees.";
export const WORKFLOW_TOOL_PARAMETERS = Type.Object({
  name: Type.Optional(Type.String({ description: "Required non-empty name for inline workflow runs; invalid for registered function launches" })),
  description: Type.Optional(Type.String({ description: "Optional human-readable workflow description" })),
  script: Type.Optional(Type.String({ description: "Immutable workflow source without metadata" })),
  workflow: Type.Optional(Type.String({ description: "Registered reusable function as an unqualified name" })),
  args: Type.Optional(Type.Unknown({ description: "JSON-compatible workflow arguments" })),
  foreground: Type.Optional(Type.Boolean({ description: "Wait for completion instead of running in the background" })),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
  budget: Type.Optional(Type.Unknown({ description: "Optional aggregate soft and hard run budgets" })),
  parentRunId: Type.Optional(Type.String({ description: "Terminal run whose named worktrees may be reused" })),
});
export const WORKFLOW_RETRY_PARAMETERS = Type.Object({ runId: Type.String({ description: "Explicit failed workflow run ID" }) });

type WorkflowToolUpdate = { content: [{ type: "text"; text: string }]; details: { runId: string; run: PersistedRun } };

type AgentGroup = { label: string; entries: readonly { agent: AgentRecord; index: number; depth: number }[] };
function agentGroupKey(agent: AgentRecord): string { return JSON.stringify([agent.structuralPath ?? [], agent.parentBreadcrumb ?? null]); }
function agentGroupLabel(agents: readonly AgentRecord[]): string {
  const structural = agents[0]?.structuralPath ?? [];
  const breadcrumbs = [...new Set(agents.map((agent) => agent.parentBreadcrumb).filter((value): value is string => Boolean(value)))];
  return [...(structural.length ? [structural.join(" > ")] : []), ...(breadcrumbs.length === 1 ? breadcrumbs : breadcrumbs.length ? [breadcrumbs.join(" | ")] : [])].join(" > ") || "Agents";
}
function agentGroups(agents: readonly AgentRecord[], allAgents: readonly AgentRecord[] = agents): AgentGroup[] {
  const byId = new Map(allAgents.map((agent) => [agent.id, agent]));
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
function renderGroupedAgents(agents: readonly AgentRecord[], render: (entry: { agent: AgentRecord; index: number; depth: number }, grouped: boolean) => string, allAgents: readonly AgentRecord[] = agents, groupLabel: (label: string) => string = (label) => label): string[] {
  const groups = agentGroups(agents, allAgents);
  const grouped = groups.length > 1 || groups.some(({ label }) => label !== "Agents");
  return groups.flatMap((group) => [
    ...(grouped ? [`  ${groupLabel(group.label)}`] : []),
    ...group.entries.map((entry) => render(entry, grouped)),
  ]);
}
function progressStyleForState(state: string, styles: WorkflowProgressStyles): (text: string) => string {
  if (state === "completed") return (text) => styles.success(text);
  if (state === "failed" || state === "cancelled") return (text) => styles.error(text);
  if (state === "running") return (text) => styles.accent(text);
  return (text) => styles.muted(text);
}
export function formatWorkflowProgress(run: PersistedRun, spinner = "◇", styles: WorkflowProgressStyles = PLAIN_WORKFLOW_PROGRESS_STYLES): string {
  const done = run.agents.filter((agent) => SETTLED_AGENT_STATES.has(agent.state)).length;
  const workflowIcon = run.state === "completed" ? "✓" : run.state === "failed" || run.state === "stopped" ? "✗" : run.state === "budget_exhausted" ? "!" : run.state === "running" ? spinner : "◆";
  const workflowIconStyle = run.state === "completed" ? (text: string) => styles.success(text) : run.state === "failed" || run.state === "stopped" ? (text: string) => styles.error(text) : run.state === "budget_exhausted" ? (text: string) => styles.warning(text) : run.state === "running" ? (text: string) => styles.accent(text) : (text: string) => styles.muted(text);
  const header = styles.bold(styles.accent(`Workflow: ${run.workflowName} (${String(done)}/${String(run.agents.length)} done)`));
  const lines = [`${workflowIconStyle(workflowIcon)} ${header}`];
  const budgetWarning = run.state === "budget_exhausted" || (run.budgetEvents ?? []).some((event) => event.type === "hard_exhausted");
  lines.push(...formatCompactBudgetStatus(run).map((line) => `  ${budgetWarning ? styles.warning(line) : line}`));
  const byId = new Map(run.agents.map((agent) => [agent.id, agent]));
  const renderAgents = (agents: readonly AgentRecord[], offset: number, nested: boolean) => renderGroupedAgents(agents, ({ agent, index, depth }, grouped) => {
    const icon = agent.state === "completed" ? "✓" : agent.state === "failed" || agent.state === "cancelled" ? "✗" : agent.state === "running" ? spinner : "○";
    const indent = "  ".repeat((grouped ? 2 : 1) + depth);
    const activity = SETTLED_AGENT_STATES.has(agent.state) ? "" : formatAgentActivity(agent, spinner, styles);
    const name = grouped ? agent.label ?? agent.name : styledAgentBreadcrumb(agent, byId, styles);
    const state = progressStyleForState(agent.state, styles);
    return `${indent}#${String(offset + index + 1)} ${state(icon)} ${name} ${state(`[${agent.state}]`)}${activity ? ` ${activity}` : ""}`;
  }, run.agents, (label) => styles.muted(label)).map((line) => nested ? `  ${line}` : line);
  const phases = run.phaseHistory?.length ? run.phaseHistory : run.phase ? [{ phase: run.phase, afterAgent: 0 }] : [];
  let renderedAgents = 0;
  let nested = false;
  for (const phase of phases) {
    const boundary = Math.max(renderedAgents, Math.min(run.agents.length, phase.afterAgent));
    lines.push(...renderAgents(run.agents.slice(renderedAgents, boundary), renderedAgents, nested));
    lines.push(`  ${styles.muted(`[Phase: ${phase.phase}]`)}`);
    renderedAgents = boundary;
    nested = true;
  }
  lines.push(...renderAgents(run.agents.slice(renderedAgents), renderedAgents, nested));
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

const ANSI_SGR = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`);
export function truncateWorkflowProgress(text: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  return text.split("\n").flatMap((line) => {
    if (!line) return [""];
    const visualLines = truncateToVisualLines(line, Number.MAX_SAFE_INTEGER, safeWidth, 0).visualLines;
    if (visualLines.length <= 1) return [visualLines[0]?.trimEnd() ?? ""];
    if (safeWidth === 1) return [ANSI_SGR.test(line) ? "…\u001b[0m" : "…"];
    const prefix = (truncateToVisualLines(line, Number.MAX_SAFE_INTEGER, safeWidth - 1, 0).visualLines[0] ?? "").trimEnd();
    const truncated = `${prefix}…`;
    return [ANSI_SGR.test(line) ? `${truncated}\u001b[0m` : truncated];
  });
}
function themeWorkflowProgressStyles(theme: Theme): WorkflowProgressStyles {
  return {
    accent: (text) => theme.fg("accent", text),
    success: (text) => theme.fg("success", text),
    error: (text) => theme.fg("error", text),
    warning: (text) => theme.fg("warning", text),
    muted: (text) => theme.fg("muted", text),
    dim: (text) => theme.fg("dim", text),
    bold: (text) => theme.bold(text),
  };
}
function workflowProgressBlock(run: PersistedRun, theme: Theme) {
  const styles = themeWorkflowProgressStyles(theme);
  return {
    render(width: number) {
      const frame = workflowSpinner[Math.floor(Date.now() / 80) % workflowSpinner.length] ?? "◇";
      return truncateWorkflowProgress(formatWorkflowProgress(run, frame, styles), width);
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

function agentBreadcrumbParts(agent: AgentRecord, byId: Map<string, AgentRecord>): string[] {
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
  return parts;
}
function agentBreadcrumb(agent: AgentRecord, byId: Map<string, AgentRecord>): string {
  const parts = agentBreadcrumbParts(agent, byId);
  return parts.length > 1 ? parts.join(" > ") : parts[0] ?? "";
}
function styledAgentBreadcrumb(agent: AgentRecord, byId: Map<string, AgentRecord>, styles: WorkflowProgressStyles): string {
  const parts = agentBreadcrumbParts(agent, byId);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${styles.muted(parts.slice(0, -1).join(" > "))} > ${parts[parts.length - 1] ?? ""}`;
}

function formatAgentActivity(agent: AgentRecord, spinner: string, styles: WorkflowProgressStyles = PLAIN_WORKFLOW_PROGRESS_STYLES): string {
  const label = agent.activity?.kind === "reasoning" ? "reasoning" : agent.activity?.kind === "text" ? "responding" : agent.activity?.kind === "tool" ? agent.activity.text : [...(agent.toolCalls ?? [])].reverse().find(({ state }) => state === "running")?.name ?? "";
  return label ? `${styles.accent(spinner)} ${styles.dim(label)}` : "";
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
  const context = JSON.stringify(checkpoint.context, null, 2);
  return [`Name: ${checkpoint.name}`, "Prompt:", checkpoint.prompt, context === "null" ? "Context: null" : "Context:", ...(context === "null" ? [] : [context])].join("\n");
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
    completedSiblingAgents: (value.completedSiblingAgents ?? []).slice(0, 16).map((agent) => ({
      id: utf8Prefix(agent.id, 128),
      ...(agent.label ? { label: utf8Prefix(agent.label, 128) } : {}),
      ...(agent.role ? { role: utf8Prefix(agent.role, 128) } : {}),
      structuralPath: agent.structuralPath.slice(0, 8).map((part) => utf8Prefix(part, 128)),
    })),
    completedSiblingPaths: value.completedSiblingPaths.slice(0, 16).map((path) => path.slice(0, 8).map((part) => utf8Prefix(part, 128))),
    ...(value.retry ? { retry: { sourceRunId: utf8Prefix(value.retry.sourceRunId, 128), action: utf8Prefix(value.retry.action, 256), completedPaths: value.retry.completedPaths.slice(0, 16).map((path) => utf8Prefix(path, 256)), incompletePaths: value.retry.incompletePaths.slice(0, 16).map((path) => utf8Prefix(path, 256)), namedWorktrees: value.retry.namedWorktrees.slice(0, 16).map((name) => utf8Prefix(name, 128)), warning: utf8Prefix(value.retry.warning, 512) } } : {}),
    artifacts: { runDirectory: utf8Prefix(value.artifacts.runDirectory, 1024), statePath: utf8Prefix(value.artifacts.statePath, 1024), journalPath: utf8Prefix(value.artifacts.journalPath, 1024) },
  };
  const size = () => Buffer.byteLength(JSON.stringify(bounded));
  while (size() > DIAGNOSTIC_LIMIT_BYTES) {
    if (bounded.completedSiblingAgents?.length || bounded.completedSiblingPaths.length) {
      bounded = { ...bounded, completedSiblingAgents: bounded.completedSiblingAgents?.slice(0, -1) ?? [], completedSiblingPaths: bounded.completedSiblingPaths.slice(0, -1) };
      continue;
    }
    if (bounded.retry && (bounded.retry.completedPaths.length || bounded.retry.incompletePaths.length || bounded.retry.namedWorktrees.length)) {
      const retry = { ...bounded.retry };
      if (retry.completedPaths.length) retry.completedPaths = retry.completedPaths.slice(0, -1);
      else if (retry.incompletePaths.length) retry.incompletePaths = retry.incompletePaths.slice(0, -1);
      else retry.namedWorktrees = retry.namedWorktrees.slice(0, -1);
      bounded = { ...bounded, retry };
      continue;
    }
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
async function diagnosticNamedWorktrees(store: RunStore, run: PersistedRun): Promise<readonly string[]> {
  const names = new Set<string>();
  try {
    for (const name of await store.validNamedWorktrees()) names.add(name);
  } catch { /* Do not block failure delivery on an invalid worktree record. */ }
  for (const name of run.retry?.namedWorktrees ?? []) {
    try { await store.resolveNamedWorktree(name); names.add(name); } catch { /* Do not advertise stale inherited worktrees. */ }
  }
  return [...names];
}
function incompleteRetryPaths(paths: readonly string[], completedPaths: readonly string[]): string[] {
  return [...new Set(paths)].filter((path) => !completedPaths.some((completedPath) => completedPath === path || completedPath.startsWith(`${path}/`)));
}
async function createWorkflowFailureDiagnostics(store: RunStore, metadata: WorkflowMetadata, error: unknown, run: PersistedRun): Promise<WorkflowFailureDiagnostics> {
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
  const completedSiblingAgents = run.agents.filter((agent) => {
    if (agent.state !== "completed" || agent.id === failedAgentRecord?.id) return false;
    return failedAgentRecord?.parentId === undefined ? agent.parentId === undefined : agent.parentId === failedAgentRecord.parentId;
  }).map((agent) => ({
    id: agent.id,
    ...(agent.label ?? agent.name ? { label: agent.label ?? agent.name } : {}),
    ...(agent.role ? { role: agent.role } : {}),
    structuralPath: [...(agent.structuralPath ?? [])],
  } satisfies WorkflowSiblingAgent));
  const completedSiblingPaths = completedSiblingAgents.map((agent) => [...agent.structuralPath]);
  let journalCompletedPaths: readonly string[] = [];
  try { journalCompletedPaths = (await store.replayableOperations()).map(({ path }) => path); } catch { /* Preserve failure diagnostics when retry history is unavailable. */ }
  const completedPaths = run.retry ? [...new Set([...run.retry.completedPaths, ...journalCompletedPaths])] : journalCompletedPaths.length ? journalCompletedPaths : run.agents.filter((agent) => agent.state === "completed").map((agent) => operationPath("agent", ...(agent.structuralPath ?? [])));
  const namedWorktrees = await diagnosticNamedWorktrees(store, run);
  const retry = run.state === "failed" ? {
    sourceRunId: run.id,
    action: `workflow_retry({ runId: ${JSON.stringify(run.id)} })`,
    completedPaths,
    incompletePaths: incompleteRetryPaths([...(run.retry?.incompletePaths ?? []), ...(failedAt ? [failedAt] : [])], completedPaths),
    namedWorktrees,
    warning: "Retry re-executes incomplete operations; external side effects before failure are not guaranteed exactly once.",
  } : undefined;
  return boundedWorkflowFailureDiagnostics({
    runId: run.id, workflowName: metadata.name, state: run.state, failedAt,
    error: { code: errorCode(error) ?? "INTERNAL_ERROR", message: errorText(error) || "The workflow failed without an error message." },
    ...(failedAgent ? { failedAgent } : {}), completedSiblingAgents, completedSiblingPaths,
    ...(retry ? { retry } : {}),
    artifacts: { runDirectory: store.directory, statePath: join(store.directory, "state.json"), journalPath: join(store.directory, "journal.json") },
  });
}

export function formatWorkflowFailureDiagnostics(diagnostic: WorkflowFailureDiagnostics): string {
  const failedAgent = diagnostic.failedAgent ? `${diagnostic.failedAgent.label ?? diagnostic.failedAgent.id}${diagnostic.failedAgent.role ? ` role=${diagnostic.failedAgent.role}` : ""} attempt=${String(diagnostic.failedAgent.attempt)} path=${diagnostic.failedAgent.structuralPath.join(" > ") || "(root)"}${diagnostic.failedAgent.sessionFile ? ` session=${diagnostic.failedAgent.sessionFile}` : ""}` : "(not persisted)";
  const siblingAgents = diagnostic.completedSiblingAgents;
  const siblings = siblingAgents ? siblingAgents.map((agent) => `${agent.label ?? agent.id}${agent.role ? ` role=${agent.role}` : ""} path=${agent.structuralPath.join(" > ") || "(root)"}`).join(", ") || "(none)" : diagnostic.completedSiblingPaths.map((path) => path.join(" > ") || "(root)").join(", ") || "(none)";
  const retry = diagnostic.retry ? [`  Retry: ${diagnostic.retry.action}`, `  Replayable completed paths: ${diagnostic.retry.completedPaths.join(", ") || "(none)"}`, `  Incomplete paths: ${diagnostic.retry.incompletePaths.join(", ") || "(unknown)"}`, `  Named worktrees: ${diagnostic.retry.namedWorktrees.join(", ") || "(none)"}`, `  Warning: ${diagnostic.retry.warning}`] : [];
  return [`✗ Workflow: ${diagnostic.workflowName}`, `  Run: ${diagnostic.runId}`, `  State: ${diagnostic.state}`, `  Error: ${diagnostic.error.code}: ${diagnostic.error.message}`, `  Failed at: ${diagnostic.failedAt ?? "(unknown)"}`, `  Failed agent: ${failedAgent}`, `  Completed sibling ${siblingAgents ? "agents" : "paths"}: ${siblings}`, ...retry, `  Artifacts: state=${diagnostic.artifacts.statePath} journal=${diagnostic.artifacts.journalPath}`].join("\n");
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

  removeRun(runId: string): void {
    this.#queues.delete(runId);
    this.#budgetEvents.delete(runId);
    this.#worktrees.delete(runId);
  }

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
function publicWorktreeReference(reference: WorkflowWorktreeReference): Readonly<WorkflowWorktreeReference> {
  if (!object(reference) || typeof reference.path !== "string" || typeof reference.branch !== "string") fail("WORKTREE_FAILED", "Worktree reference is invalid");
  return Object.freeze({ path: reference.path, branch: reference.branch });
}
async function hostWithWorktree(args: readonly unknown[], resolveWorktree: ((owner: string, signal: AbortSignal) => Promise<Readonly<WorkflowWorktreeReference>>) | undefined, signal: AbortSignal): Promise<JsonValue> {
  if (args.length !== 2) fail("INVALID_METADATA", "withWorktree requires a name and callback");
  const name = args[0];
  const callback = args[1];
  if (typeof name !== "string" || !name.trim()) fail("INVALID_METADATA", "withWorktree name must be a non-empty string");
  if (typeof callback !== "function") fail("INVALID_METADATA", "withWorktree callback must be a function");
  if (!resolveWorktree) fail("WORKTREE_FAILED", "No worktree bridge is available");
  const owner = operationPath("worktree", "named", name.trim());
  const reference = publicWorktreeReference(await resolveWorktree(owner, signal));
  return inheritedHostWorktreeOwner.run(owner, async () => await (callback as (reference: Readonly<WorkflowWorktreeReference>) => unknown)(reference)) as Promise<JsonValue>;
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
  const functionShellOccurrences = new Map<string, number>();
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
      agent: async (prompt: string, options: Readonly<AgentOptions> = {}) => {
        if (!bridge.agent || typeof prompt !== "string") fail("AGENT_FAILED", "No agent bridge is available");
        const validatedOptions = validateAgentOptions(options);
        const scopedWorktreeOwner = inheritedHostWorktreeOwner.getStore() ?? worktreeOwner;
        const inherited = inheritedHostAgentPath.getStore() ?? [];
        const key = `${path}\0${JSON.stringify(inherited)}`;
        const occurrence = (functionAgentOccurrences.get(key) ?? 0) + 1;
        functionAgentOccurrences.set(key, occurrence);
        return bridge.agent(prompt, validatedOptions, signal, { structuralPath: [...inherited], callSite: `function:${path}`, occurrence, parentBreadcrumb: functionBreadcrumb, ...(scopedWorktreeOwner ? { worktreeOwner: scopedWorktreeOwner } : {}) });
      },
      shell: async (...args: readonly unknown[]) => {
        if (!bridge.shell) fail("SHELL_FAILED", "No shell bridge is available");
        if (typeof args[0] !== "string") fail("INVALID_METADATA", "shell command must be a string");
        const options = validateShellOptions(args[1] === undefined ? {} : args[1]);
        const scopedWorktreeOwner = inheritedHostWorktreeOwner.getStore() ?? worktreeOwner;
        const inherited = inheritedHostAgentPath.getStore() ?? [];
        const key = `${path}\0${JSON.stringify([inherited, scopedWorktreeOwner ?? null])}`;
        const occurrence = (functionShellOccurrences.get(key) ?? 0) + 1;
        functionShellOccurrences.set(key, occurrence);
        return bridge.shell(args[0], options, signal, { structuralPath: [...inherited], callSite: `function:${path}`, occurrence, ...(scopedWorktreeOwner ? { worktreeOwner: scopedWorktreeOwner } : {}) });
      },
      prompt: workflowPrompt,
      parallel: (...args: readonly unknown[]) => hostParallel(args[0], args[1]),
      pipeline: (...args: readonly unknown[]) => hostPipeline(args[0], args[1], args[2]),
      withWorktree: (...args: readonly unknown[]) => hostWithWorktree(args, bridge.worktree, signal),
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
const WORKFLOW_OVERLAY_BORDER_ROWS = 2;
type WorkflowOverlayComponent = { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void; dispose?(): void };
function borderWorkflowOverlay(component: WorkflowOverlayComponent, theme: { fg(color: "border", text: string): string }): WorkflowOverlayComponent {
  return {
    ...component,
    render(width: number) {
      const border = theme.fg("border", "─".repeat(Math.max(1, width)));
      return [border, ...component.render(width), border];
    },
  };
}
type KeybindingsHostCapabilities = { getKeys?: (name: string) => readonly string[] };
function isKeybindingGetter(value: unknown): value is NonNullable<KeybindingsHostCapabilities["getKeys"]> { return typeof value === "function"; }
function keybindingsHostCapabilities(keybindings: unknown): KeybindingsHostCapabilities {
  if (!object(keybindings) || !isKeybindingGetter(keybindings.getKeys)) return {};
  return { getKeys: keybindings.getKeys };
}
function keybindingKeys(keybindings: unknown, name: string): readonly string[] | undefined { const getKeys = keybindingsHostCapabilities(keybindings).getKeys; return typeof getKeys === "function" ? getKeys.call(keybindings, name) : undefined; }

export default function workflowExtension(pi: ExtensionAPI, home?: string, clipboard = copyToClipboard, createSession: SessionFactory = createNativeAgentSession, agentDir?: string) {
  beginWorkflowExtensionLoading();
  const registry = loadingRegistry();
  const extensionAgentDir = agentDir ?? getAgentDir();
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
  const runs = new Map<string, { executor: WorkflowAgentExecutor; store: RunStore; metadata: WorkflowMetadata; model: ModelSpec; lifecycle: RunLifecycle; budget: WorkflowBudgetRuntime; abortController: AbortController; projectTrusted: () => boolean; providerErrorRecovery?: (failure: AgentProviderFailure) => Promise<AgentProviderRecovery>; execution?: WorkflowExecution; completion?: Promise<unknown>; checkpointResolvers: Map<string, (value: boolean) => void>; update?: (result: WorkflowToolUpdate) => void }>();
  let providerRecoveryQueue = Promise.resolve();
  const enqueueProviderRecovery = <T>(task: () => Promise<T>): Promise<T> => { const next = providerRecoveryQueue.then(task, task); providerRecoveryQueue = next.then(() => undefined, () => undefined); return next; };
  const createProviderErrorRecovery = (host: unknown, fallbackModels: ReadonlySet<string>, abort: () => void) => {
    if (!object(host) || host.mode !== "tui" || host.hasUI !== true) return undefined;
    const ui = object(host.ui) ? host.ui : undefined;
    const select = uiHostCapabilities(ui)?.select;
    if (!select) return undefined;
    const hostModels = contextHostCapabilities(host).modelRegistry;
    const choose = (title: string, options: string[]) => select.call(ui, title, options);
    return (failure: AgentProviderFailure): Promise<AgentProviderRecovery> => enqueueProviderRecovery(async () => {
      const action = await choose(`Subagent "${failure.label}" failed\nCurrent provider/model: ${failure.provider}/${failure.model}\nProvider error: ${failure.error}\nChoose what to do`, ["Retry", "Change model", "Abort workflow"]);
      if (action === "Retry") return "retry";
      if (action === "Change model") {
        const available = hostModels?.getAvailable?.().map((model) => `${model.provider}/${model.id}`) ?? [...fallbackModels];
        const selected = await choose(`Available models for subagent "${failure.label}"`, [...new Set(available)].sort());
        if (selected) return { model: selected };
      }
      abort();
      return "abort";
    });
  };
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
  const phaseBridge = (store: RunStore, metadata: WorkflowMetadata, lifecycle: RunLifecycle) => {
    let cursor = 0;
    let executionPhase: string | undefined;
    return async (phase: string): Promise<void> => {
      if (phase === executionPhase) return;
      executionPhase = phase;
      await scheduler.flush();
      await lifecycle.enter();
      try {
        let previousPhase: string | undefined;
        const persisted = await persistRunState(store, metadata, (current) => {
          previousPhase = current.phase;
          const history = current.phaseHistory ?? [];
          if (history[cursor]?.phase === phase) { cursor += 1; return { ...current, phase }; }
          cursor = history.length + 1;
          return { ...current, phase, phaseHistory: [...history, { phase, afterAgent: current.agents.length }] };
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
      const cwd = identity.worktreeOwner ? (await persistWorktree(store, metadata, identity.worktreeOwner)).cwd : store.cwd;
      const result = await executeShellCommand(command, options, signal, cwd);
      await store.complete(path, result as unknown as JsonValue);
      return result;
    } finally { await lifecycle.leave(); }
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
      const result = await run.executor.execute(prompt, { label: options.label, workflowName: run.metadata.name, onProgress, onAttempt, budget, ...(run.providerErrorRecovery ? { providerErrorRecovery: run.providerErrorRecovery } : {}), ...(parentId ? { parent: parentId, cwd: options.cwd, ...(options.worktreeOwner ? { worktreeOwner: options.worktreeOwner } : {}) } : options.worktreeOwner ? { worktreeOwner: options.worktreeOwner } : {}), ...(options.model ? { model: options.model } : {}), ...(options.thinking ? { thinking: options.thinking } : {}), ...(options.role ? { role: options.role } : {}), ...(options.role ? {} : { tools: options.tools }), effectiveTools: options.tools, ...(options.schema ? { schema: options.schema } : {}), ...(options.retries === undefined ? {} : { retries: options.retries }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }), ...(options.agentOptions ? { agentOptions: options.agentOptions } : {}), ...(options.agentIdentity ? { agentIdentity: options.agentIdentity } : {}) }, signal, scheduler.toolsFor(id, (role, tools, model, inheritedTools, thinking) => run.executor.resolve({ label: "child", workflowName: run.metadata.name, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(tools !== undefined ? { tools } : {}) }, inheritedTools).tools), setSteer, () => { scheduler.cancelChildren(id); scheduler.retry(id); });
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
  const cleanupTerminalRun = async (runId: string): Promise<void> => {
    const run = runs.get(runId);
    if (!run || !["completed", "failed", "stopped"].includes(run.lifecycle.state)) return;
    await scheduler.cancelRun(runId);
    await scheduler.flush();
    if (runs.get(runId) !== run) return;
    scheduler.removeRun(runId);
    terminalRunStates.set(runId, run.lifecycle.state as "completed" | "failed" | "stopped");
    run.checkpointResolvers.clear();
    liveActivities.delete(runId);
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
    await scheduler.flush();
    await cleanupTerminalRun(runId);
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
    if (!silent) deliver(pi, `Workflow ${run.metadata.name} budget adjustment ${proposalId}: ${approved ? "Approved" : "Rejected"}.`);
    return result;
  };
  const checkpointBridge = (runId: string, store: RunStore, metadata: WorkflowMetadata, foreground: boolean, ui?: { select?: (prompt: string, options: string[]) => Promise<string | undefined> }, headless = false) => {
    const checkpointCounters = new Map<string, number>();
    return async (raw: Readonly<Record<string, JsonValue>>, signal: AbortSignal): Promise<boolean> => {
      const input = validateCheckpoint(raw);
      const label = nextNamedOccurrence(checkpointCounters, input.name);
      const path = operationPath("checkpoint", label);
      if (headless) fail("RESUME_INCOMPATIBLE", "Headless CLI checkpoints are unsupported");
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
    if (!catalog.functions.length && !catalog.variables.length && !hasAliases) return;
    pi.registerTool({
      name: "workflow_catalog",
      label: "Workflow Catalog",
      description: "List reusable workflow functions, variables, and model aliases, or load one entry in full",
      parameters: Type.Object({ name: Type.Optional(Type.String({ description: "Registered function or variable name for full detail" })) }, { additionalProperties: false }),
      async execute(_id, params = {}) {
        const result = params.name === undefined ? registry.catalogIndex() : registry.catalogDetail(params.name);
        return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result };
      }
    });
    catalogRegistered = true;
  };
  const refreshPausedRunAliases = async (run: NonNullable<ReturnType<typeof runs.get>>, context?: { model: { provider: string; id: string } | undefined; modelRegistry: { getAll?: () => Array<{ provider: string; id: string }>; getAvailable?: () => Array<{ provider: string; id: string }> } | undefined }) => {
    const loaded = await run.store.load();
    const active = new Set(pi.getActiveTools().filter((tool) => !["workflow", "workflow_respond", "workflow_stop", "workflow_resume", "workflow_retry", "workflow_catalog"].includes(tool)));
    const missing = loaded.snapshot.tools.filter((tool) => tool !== "workflow_catalog").find((tool) => !active.has(tool));
    if (missing) throw new WorkflowError("RESUME_INCOMPATIBLE", `Required tool is unavailable: ${missing}`);
    const settingsPath = workflowSettingsPath(extensionAgentDir);
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
    run.executor = new WorkflowAgentExecutor({ cwd: run.store.cwd, agentDir: extensionAgentDir, model: run.model, tools: new Set(snapshot.tools.filter((tool) => pi.getActiveTools().includes(tool) && tool !== "workflow_catalog")), availableModels: resumeModels, knownModels: resumeModels, modelAliases: currentAliases, blockedAliases, blockedAliasTargets, settingsPath, agentDefinitions: snapshot.roles ?? {}, runStore: run.store, providerPause: async () => { deliver(pi, `Workflow ${snapshot.metadata.name} paused: provider limit.`); await run.lifecycle.providerPause(); }, agentSetupHooks: registry.agentSetupHooks(), agentResourcePolicy: () => resolveAgentResourcePolicy(run.store.cwd, run.projectTrusted(), settingsPath) }, createSession);
    run.executor.setRunContext(workflowRunContext(run.store.cwd, run.store.sessionId, run.store.runId, loaded.snapshot.metadata, loaded.snapshot.args, run.abortController.signal));
    const drift = aliasDrift(previousAliases, currentAliases);
    if (drift.length) await run.store.appendEvent({ type: "warning", message: `Model alias mappings changed on resume: ${drift.join("; ")}` });
  };
  const coldResumeRun = async (run: NonNullable<ReturnType<typeof runs.get>>, hasUI: boolean, ui: { select?: (prompt: string, options: string[]) => Promise<string | undefined> }, trustedProject: boolean, context?: { model: { provider: string; id: string } | undefined; modelRegistry: { getAll?: () => Array<{ provider: string; id: string }>; getAvailable?: () => Array<{ provider: string; id: string }> } | undefined }) => {
    const loaded = await run.store.load();
    await run.store.validateRetrySource();
    await run.store.validateBorrowedWorktrees();
    if (loaded.snapshot.identityVersion !== LAUNCH_SNAPSHOT_IDENTITY_VERSION) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow launch snapshot identity version is incompatible");
    if (loaded.snapshot.roles === undefined) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow role definitions are missing from the launch snapshot");
    if ((loaded.snapshot.projectRoles?.length ?? 0) > 0 && !trustedProject) throw new WorkflowError("RESUME_INCOMPATIBLE", "Cannot restore project roles in an untrusted project");
    const missingRole = loaded.snapshot.agentTypes.find((role) => !loaded.snapshot.roles?.[role]);
    if (missingRole) throw new WorkflowError("RESUME_INCOMPATIBLE", `Role definition is missing from the launch snapshot: ${missingRole}`);
    const active = new Set(pi.getActiveTools().filter((tool) => !["workflow", "workflow_respond", "workflow_stop", "workflow_resume", "workflow_retry", "workflow_catalog"].includes(tool)));
    const missing = loaded.snapshot.tools.filter((tool) => tool !== "workflow_catalog").find((tool) => !active.has(tool));
    if (missing) throw new WorkflowError("RESUME_INCOMPATIBLE", `Required tool is unavailable: ${missing}`);
    const settingsPath = workflowSettingsPath(extensionAgentDir);
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
    const script = launchScriptForSnapshot(loaded.snapshot, registry);
    preflight(script, { models: resumeModels, tools: active, agentTypes: new Set(loaded.snapshot.agentTypes), modelAliases: resumeAliases, knownModels: resumeModels, settingsPath, skipModelAvailability: true }, loaded.snapshot.schemas, loaded.snapshot.metadata, true);
    const snapshot = createLaunchSnapshot({ ...loaded.snapshot, settingsPath, settings: { ...loaded.snapshot.settings, modelAliases: currentAliases }, modelAliases: currentAliases });
    await run.store.saveSnapshot(snapshot);
    run.executor = new WorkflowAgentExecutor({ cwd: run.store.cwd, agentDir: extensionAgentDir, model: run.model, tools: new Set(snapshot.tools.filter((tool) => pi.getActiveTools().includes(tool) && tool !== "workflow_catalog")), availableModels: resumeModels, knownModels: resumeModels, modelAliases: currentAliases, blockedAliases, blockedAliasTargets, settingsPath, agentDefinitions: snapshot.roles ?? {}, runStore: run.store, providerPause: async () => { deliver(pi, `Workflow ${snapshot.metadata.name} paused: provider limit.`); await run.lifecycle.providerPause(); }, agentSetupHooks: registry.agentSetupHooks(), agentResourcePolicy: () => resolveAgentResourcePolicy(run.store.cwd, run.projectTrusted(), settingsPath) }, createSession);
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
      if (!["completed", "failed", "stopped"].includes(run.lifecycle.state)) { await run.lifecycle.terminal("failed", typed.code).catch(() => undefined); const persisted = await persistRunState(run.store, run.metadata, (current) => ({ ...current, error: { code: typed.code, message: typed.message } })); await eventPublisher.runFailed(run.store, run.metadata, typed, run.lifecycle.state === "interrupted" ? "interrupted" : "failed"); run.update?.(workflowToolUpdate(persisted)); if (!["stopped", "interrupted", "budget_exhausted"].includes(run.lifecycle.state)) await createWorkflowFailureDiagnostics(run.store, run.metadata, typed, persisted).then((diagnostic) => { deliverFailure(pi, diagnostic); }).catch(() => undefined); }
      await cleanupTerminalRun(run.store.runId);
      throw typed;
    }
    await scheduler.cancelRun(run.store.runId);
    await run.lifecycle.resume();
    const execution = runWorkflow(script, loaded.snapshot.args, withWorkflowFunctions({ shell: (command, options, signal, identity) => shellForRun(run.store, run.metadata, run.lifecycle, command, options, signal, identity), agent: async (prompt, options, signal, identity) => {
      await run.lifecycle.enter();
      try {
        const path = agentIdentityPath(identity);
        const replayed = await run.store.replay(path);
        if (replayed) {
          return replayed.value;
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
        const spawned = scheduler.spawn(run.store.runId, prompt, { label, ...(requestedLabel ? { requestedLabel } : {}), ...(identity.parentBreadcrumb ? { parentBreadcrumb: identity.parentBreadcrumb } : {}), cwd, tools, ...worktree, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(schema ? { schema } : {}), ...(typeof options.retries === "number" ? { retries: options.retries } : {}), ...(positiveInteger(options.timeoutMs) || options.timeoutMs === null ? { timeoutMs: options.timeoutMs } : {}), agentOptions: options, agentIdentity: identity });
        const cancel = () => { scheduler.cancel(spawned.id); };
        signal.addEventListener("abort", cancel, { once: true });
        const outcome = await spawned.result.finally(() => { signal.removeEventListener("abort", cancel); });
        if (!outcome.ok) throw new WorkflowError(outcome.error.code as WorkflowErrorCode, outcome.error.message);
        await run.store.complete(path, outcome.value);
        return outcome.value;
      } finally { await run.lifecycle.leave(); }
      }, worktree: async (owner) => resolveWorktree(run.store, run.metadata, owner), checkpoint: checkpointBridge(run.store.runId, run.store, run.metadata, false, hasUI ? ui : undefined), phase: phaseBridge(run.store, run.metadata, run.lifecycle), log: logBridge(run.lifecycle, run.metadata.name) }, run.store, runContext, variables, registry), controller.signal);
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
      if (state === "failed") retryReservations.delete(persisted.retry?.lineageRootRunId ?? run.store.runId);
      await eventPublisher.runFailed(run.store, run.metadata, typed, state);
      run.update?.(workflowToolUpdate(persisted));
      if (!["stopped", "interrupted", "budget_exhausted"].includes(run.lifecycle.state)) await createWorkflowFailureDiagnostics(run.store, run.metadata, typed, persisted).then((diagnostic) => { deliverFailure(pi, diagnostic); }).catch(() => undefined);
    }).finally(() => cleanupTerminalRun(run.store.runId));
    run.completion = completion;
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
      await run.store.requestWorkflowDecision(request);
      await appendBudgetDecisionEvent(run, request, "adjustment_requested");
      deliver(pi, budgetDecisionDelivery(run.metadata, request));
      return { state: "awaiting_approval", proposalId };
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
  const retryReservations = new Set<string>();
  const retryWorkflowRun = async (runId: string, context: unknown): Promise<{ runId: string; parentRunId: string; state: "running" }> => {
    if (typeof runId !== "string" || !runId.trim()) throw new WorkflowError("RESUME_INCOMPATIBLE", "workflow_retry requires an explicit run ID");
    const host = object(context) ? context : {};
    const cwd = typeof host.cwd === "string" ? host.cwd : undefined;
    const sessionManager = object(host.sessionManager) ? host.sessionManager : undefined;
    const sessionId = typeof sessionManager?.getSessionId === "function" ? String(Reflect.apply(sessionManager.getSessionId, sessionManager, [])) : undefined;
    if (!cwd || !sessionId) throw new WorkflowError("RESUME_INCOMPATIBLE", "workflow_retry requires the current project and Pi session");
    await ensureSessionLease(cwd, sessionId);
    const sourceStore = new RunStore(cwd, sessionId, runId, home);
    let loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> };
    try { loaded = await sourceStore.load(); } catch (error) { throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot load failed source run ${runId}: ${errorText(error)}`); }
    if (loaded.run.state !== "failed") throw new WorkflowError("RESUME_INCOMPATIBLE", `Only failed workflow runs can be retried; source is ${loaded.run.state}`);
    if (loaded.run.retry && (typeof loaded.run.retry.sourceRunId !== "string" || !loaded.run.retry.sourceRunId || typeof loaded.run.retry.lineageRootRunId !== "string" || !loaded.run.retry.lineageRootRunId || !Array.isArray(loaded.run.retry.completedPaths) || loaded.run.retry.completedPaths.some((path) => typeof path !== "string") || !Array.isArray(loaded.run.retry.incompletePaths) || loaded.run.retry.incompletePaths.some((path) => typeof path !== "string") || !Array.isArray(loaded.run.retry.namedWorktrees) || loaded.run.retry.namedWorktrees.some((name) => typeof name !== "string"))) throw new WorkflowError("RESUME_INCOMPATIBLE", "The source retry provenance is incomplete");
    const lineageRootRunId = loaded.run.retry?.lineageRootRunId ?? loaded.run.id;
    if (retryReservations.has(lineageRootRunId)) throw new WorkflowError("RESUME_INCOMPATIBLE", `An active retry already owns lineage ${lineageRootRunId}`);
    const activeStates = new Set<RunState>(["queued", "running", "pausing", "paused", "awaiting_input", "interrupted", "budget_exhausted"]);
    for (const candidateId of await listRunIds(cwd, sessionId, home)) {
      if (candidateId === runId) continue;
      const candidate = new RunStore(cwd, sessionId, candidateId, home);
      try {
        const candidateRun = (await candidate.load()).run;
        if (activeStates.has(candidateRun.state) && candidateRun.retry?.lineageRootRunId === lineageRootRunId) throw new WorkflowError("RESUME_INCOMPATIBLE", `An active retry child already exists for source lineage ${lineageRootRunId}`);
      } catch (error) {
        if (error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE") throw error;
      }
    }
    retryReservations.add(lineageRootRunId);
    let childStarted = false;
    try {
      const trustedProject = projectTrusted(context);
      await sourceStore.validateRetrySource();
      await sourceStore.validateBorrowedWorktrees();
      if (loaded.snapshot.identityVersion !== LAUNCH_SNAPSHOT_IDENTITY_VERSION) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow launch snapshot identity version is incompatible");
      if (loaded.snapshot.roles === undefined) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow role definitions are missing from the launch snapshot");
      if ((loaded.snapshot.projectRoles?.length ?? 0) > 0 && !trustedProject) throw new WorkflowError("RESUME_INCOMPATIBLE", "Cannot restore project roles in an untrusted project");
      const missingRole = loaded.snapshot.agentTypes.find((role) => !loaded.snapshot.roles?.[role]);
      if (missingRole) throw new WorkflowError("RESUME_INCOMPATIBLE", `Role definition is missing from the launch snapshot: ${missingRole}`);
      const active = new Set<string>(pi.getActiveTools().filter((tool) => !["workflow", "workflow_respond", "workflow_stop", "workflow_resume", "workflow_retry", "workflow_catalog"].includes(tool)));
      const missing = loaded.snapshot.tools.filter((tool) => tool !== "workflow_catalog").find((tool) => !active.has(tool));
      if (missing) throw new WorkflowError("RESUME_INCOMPATIBLE", `Required tool is unavailable: ${missing}`);
      const settingsPath = workflowSettingsPath(extensionAgentDir);
      const currentSettings = loadSettings(settingsPath);
      resolveAgentResourcePolicy(cwd, trustedProject, settingsPath);
      const currentAliases = currentSettings.modelAliases ?? {};
      const previousAliases = loaded.snapshot.modelAliases ?? loaded.snapshot.settings.modelAliases ?? {};
      const modelRegistry = contextHostCapabilities(context).modelRegistry;
      const knownModels = new Set((modelRegistry?.getAll?.() ?? modelRegistry?.getAvailable?.() ?? []).map((model) => `${model.provider}/${model.id}`));
      const hostModel = object(host.model) && typeof host.model.provider === "string" && typeof host.model.id === "string" ? { provider: host.model.provider, id: host.model.id } : { provider: "", id: "" };
      if (hostModel.provider && hostModel.id) knownModels.add(`${hostModel.provider}/${hostModel.id}`);
      const resumeModels = modelRegistry ? knownModels : new Set([...loaded.snapshot.models, ...knownModels]);
      const resumeAliases = { ...previousAliases, ...currentAliases };
      const script = launchScriptForSnapshot(loaded.snapshot, registry);
      preflight(script, { models: resumeModels, tools: active, agentTypes: new Set(loaded.snapshot.agentTypes), modelAliases: resumeAliases, knownModels: resumeModels, settingsPath, skipModelAvailability: true }, loaded.snapshot.schemas, loaded.snapshot.metadata, true);
      await sourceStore.validateNamedWorktrees();
      for (const name of loaded.run.retry?.namedWorktrees ?? []) await sourceStore.resolveNamedWorktree(name);
      const completedPaths = (await sourceStore.replayableOperations()).map(({ path }) => path);
      const incompletePaths = incompleteRetryPaths([...(loaded.run.retry?.incompletePaths ?? []), ...loaded.run.agents.filter((agent) => agent.state !== "completed").map((agent) => operationPath("agent", ...(agent.structuralPath ?? [])))], completedPaths);
      const namedWorktrees = [...new Set([...(loaded.run.retry?.namedWorktrees ?? []), ...(await sourceStore.worktrees()).filter(({ owner }) => owner.startsWith(`${operationPath("worktree", "named")}/`)).map(({ owner }) => decodeURIComponent(owner.split("/").at(-1) ?? owner))])];
      const budget = validateBudget(loaded.run.budget ?? loaded.snapshot.budget);
      const childRunId = randomUUID();
      const childStore = new RunStore(cwd, sessionId, childRunId, home);
      const childSnapshot = createLaunchSnapshot(loaded.snapshot);
      const childBudget = new WorkflowBudgetRuntime(budget, loaded.run.budgetVersion ?? 1, loaded.run.usage, loaded.run.budgetEvents);
      const childInitialBudget = childBudget.snapshot();
      const retry: WorkflowRetryProvenance = { sourceRunId: loaded.run.id, lineageRootRunId, completedPaths, incompletePaths, namedWorktrees };
      await childStore.create({ id: childRunId, workflowName: loaded.snapshot.metadata.name, cwd, sessionId, state: "interrupted", parentRunId: loaded.run.id, retry, agents: [], nativeSessions: [], ...(budget ? { budget } : {}), budgetVersion: loaded.run.budgetVersion ?? 1, ...childInitialBudget }, childSnapshot);
      const fallbackModel: ModelSpec = { provider: hostModel.provider, model: hostModel.id, thinking: pi.getThinkingLevel() };
      const model = modelSpec(loaded.snapshot.models[0] ?? "", fallbackModel);
      const lifecycle = lifecycleFor(childStore, "interrupted", childBudget, loaded.snapshot.metadata);
      const abortController = new AbortController();
      const providerErrorRecovery = createProviderErrorRecovery(context, resumeModels, () => { abortController.abort(); });
      const providerPause = async () => { deliver(pi, `Workflow ${loaded.snapshot.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      const childRun = { executor: new WorkflowAgentExecutor({ cwd, agentDir: extensionAgentDir, model, tools: new Set(loaded.snapshot.tools.filter((tool) => active.has(tool) || tool === "workflow_catalog")), availableModels: resumeModels, knownModels: resumeModels, modelAliases: currentAliases, settingsPath, agentDefinitions: loaded.snapshot.roles ?? {}, runStore: childStore, providerPause, agentSetupHooks: registry.agentSetupHooks(), agentResourcePolicy: () => resolveAgentResourcePolicy(cwd, projectTrusted(context), settingsPath) }, createSession), store: childStore, metadata: loaded.snapshot.metadata, model, lifecycle, budget: childBudget, abortController, projectTrusted: () => projectTrusted(context), checkpointResolvers: new Map(), ...(providerErrorRecovery ? { providerErrorRecovery } : {}) };
      runs.set(childRunId, childRun);
      scheduler.addRun(childRunId, loaded.snapshot.settings.concurrency, () => { childBudget.checkAgentLaunch(); });
      await eventPublisher.runStarted(childStore, loaded.snapshot.metadata);
      await coldResumeRun(childRun, false, {}, trustedProject, { model: hostModel, modelRegistry: modelRegistry ? { getAll: () => [...(modelRegistry.getAll?.() ?? [])], getAvailable: () => [...(modelRegistry.getAvailable?.() ?? [])] } : undefined });
      const completion = runs.get(childRunId)?.completion;
      if (completion) {
        childStarted = true;
        void completion.then(() => { retryReservations.delete(lineageRootRunId); }, () => { retryReservations.delete(lineageRootRunId); });
      }
      return { runId: childRunId, parentRunId: loaded.run.id, state: "running" };
    } finally {
      if (!childStarted) retryReservations.delete(lineageRootRunId);
    }
  };
  pi.registerTool({
    name: "workflow_retry",
    label: "Workflow Retry",
    description: "Retry a failed workflow run by replaying its completed structural operations",
    parameters: WORKFLOW_RETRY_PARAMETERS,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try { const result = await retryWorkflowRun(params.runId, ctx); return { content: [{ type: "text" as const, text: JSON.stringify(result) }], details: result }; }
      catch (error) { throw mainAgentError(error); }
    },
  });
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
      const abortController = new AbortController();
      const providerErrorRecovery = createProviderErrorRecovery(ctx, new Set(loaded.snapshot.models), () => { abortController.abort(); });
      runs.set(runId, { executor: new WorkflowAgentExecutor({ cwd: ctx.cwd, agentDir: extensionAgentDir, model, tools: new Set(loaded.snapshot.tools.filter((tool) => pi.getActiveTools().includes(tool) && tool !== "workflow_catalog")), availableModels: new Set(loaded.snapshot.models), knownModels: new Set(loaded.snapshot.models), ...(loaded.snapshot.modelAliases ?? loaded.snapshot.settings.modelAliases ? { modelAliases: loaded.snapshot.modelAliases ?? loaded.snapshot.settings.modelAliases } : {}), ...(loaded.snapshot.settingsPath ? { settingsPath: loaded.snapshot.settingsPath } : {}), agentDefinitions: roleDefinitions, runStore: store, providerPause, agentSetupHooks: registry.agentSetupHooks(), agentResourcePolicy: () => resolveAgentResourcePolicy(store.cwd, projectTrusted(ctx), loaded.snapshot.settingsPath ?? workflowSettingsPath(extensionAgentDir)) }, createSession), store, metadata: loaded.snapshot.metadata, model, lifecycle, budget: budgetRuntime, abortController, projectTrusted: () => projectTrusted(ctx), checkpointResolvers: new Map(), ...(providerErrorRecovery ? { providerErrorRecovery } : {}) });
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
    const roles = Object.entries(loadAgentDefinitions(ctx.cwd, extensionAgentDir, projectTrusted(ctx))).filter(([, definition]) => definition.description);
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
      const headless = object(ctx) && ctx.headless === true;
      const settingsPath = workflowSettingsPath(extensionAgentDir);
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
      const rootTools = pi.getActiveTools().filter((name) => !["workflow", "workflow_respond", "workflow_stop", "workflow_resume", "workflow_retry", "workflow_catalog"].includes(name));
      const trustedProject = projectTrusted(ctx);
      if (typeof ctx.cwd === "string") resolveAgentResourcePolicy(ctx.cwd, trustedProject, settingsPath);
      const validated = validateWorkflowLaunchWithRegistry({ ...params, args: params.args }, { cwd: ctx.cwd, agentDir: extensionAgentDir, projectTrusted: trustedProject, availableModels, rootTools: new Set(rootTools), modelAliases: defaults.modelAliases ?? {}, knownModels, settingsPath }, registry);
      const { script, checked, agentDefinitions, projectAgentDefinitions, roleNames, functionName } = validated;
      await ensureSessionLease(ctx.cwd, ctx.sessionManager.getSessionId());
      const runId = randomUUID();
      const args = (params.args ?? null) as JsonValue;
      encoded(args);
      const runController = new AbortController();
      if (signal?.aborted) runController.abort(); else signal?.addEventListener("abort", () => { runController.abort(); }, { once: true });
      const runContext = workflowRunContext(ctx.cwd, ctx.sessionManager.getSessionId(), runId, checked.metadata, args, runController.signal);
      const variables = await resolveWorkflowVariables(runContext, runController, registry);
      const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
      const parentRunId = params.parentRunId;
      if (parentRunId !== undefined) await store.validateParentRun(parentRunId);
      const roles = Object.fromEntries(roleNames.map((role) => [role, agentDefinitions[role]])) as Record<string, AgentDefinition>;
      const projectRoles = roleNames.filter((role) => projectAgentDefinitions[role] !== undefined);
      const roleModels = roleNames.flatMap((role) => { const model = agentDefinitions[role]?.model; return model ? [modelCapability(model, defaults.modelAliases, knownModels, settingsPath)] : []; });
      const snapshotModels = [...new Set([rootModelName, ...checked.referenced.models, ...roleModels])];
      const snapshot = createLaunchSnapshot({ script, args, metadata: checked.metadata, settings, settingsPath, ...(functionName ? { launchKind: "function" as const, functionName } : {}), ...(defaults.modelAliases ? { modelAliases: defaults.modelAliases } : {}), ...(budget ? { budget } : {}), models: snapshotModels, tools: rootTools, agentTypes: checked.referenced.agentTypes, roles, projectRoles, schemas: checked.schemas });
      const budgetRuntime = new WorkflowBudgetRuntime(budget);
      const initialBudget = budgetRuntime.snapshot();
      await store.create({ id: runId, workflowName: checked.metadata.name, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), state: "running", ...(parentRunId !== undefined ? { parentRunId } : {}), agents: [], nativeSessions: [], ...(budget ? { budget } : {}), budgetVersion: 1, ...initialBudget }, snapshot);
      const lifecycle = lifecycleFor(store, "running", budgetRuntime, checked.metadata);
      const background = !params.foreground;
      const providerPause = async () => { if (background) deliver(pi, `Workflow ${checked.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      const providerErrorRecovery = createProviderErrorRecovery(ctx, availableModels, () => { runController.abort(); });
      const executor = new WorkflowAgentExecutor({ cwd: ctx.cwd, agentDir: extensionAgentDir, model: rootModel, tools: new Set(rootTools), availableModels, knownModels, modelAliases: defaults.modelAliases ?? {}, settingsPath, agentDefinitions, runStore: store, providerPause, agentSetupHooks: registry.agentSetupHooks(), agentResourcePolicy: () => resolveAgentResourcePolicy(ctx.cwd, projectTrusted(ctx), settingsPath), runContext }, createSession);
      runs.set(runId, { executor, store, metadata: checked.metadata, model: rootModel, lifecycle, budget: budgetRuntime, abortController: runController, projectTrusted: () => projectTrusted(ctx), checkpointResolvers: new Map(), ...(providerErrorRecovery ? { providerErrorRecovery } : {}), ...(params.foreground && onUpdate ? { update: onUpdate } : {}) });
      if (params.foreground && onUpdate) onUpdate(workflowToolUpdate((await store.load()).run));
      scheduler.addRun(runId, settings.concurrency, () => runs.get(runId)?.budget.checkAgentLaunch());
      const execution = runWorkflow(script, args, withWorkflowFunctions({ shell: (command, options, signal, identity) => shellForRun(store, checked.metadata, lifecycle, command, options, signal, identity), agent: async (prompt, options, agentSignal, identity) => {
        await lifecycle.enter();
        try {
          const path = agentIdentityPath(identity);
          const replayed = await store.replay(path);
          if (replayed) {
            return replayed.value;
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
          const spawned = scheduler.spawn(runId, prompt, { label, ...(requestedLabel ? { requestedLabel } : {}), ...(identity.parentBreadcrumb ? { parentBreadcrumb: identity.parentBreadcrumb } : {}), cwd, tools, ...worktree, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(schema ? { schema } : {}), ...(typeof options.retries === "number" ? { retries: options.retries } : {}), ...(positiveInteger(options.timeoutMs) || options.timeoutMs === null ? { timeoutMs: options.timeoutMs } : {}), agentOptions: options, agentIdentity: identity });
          const cancel = () => { scheduler.cancel(spawned.id); };
          if (agentSignal.aborted) cancel(); else agentSignal.addEventListener("abort", cancel, { once: true });
          const outcome = await spawned.result.finally(() => { agentSignal.removeEventListener("abort", cancel); });
          if (!outcome.ok) throw new WorkflowError(outcome.error.code as WorkflowErrorCode, outcome.error.message);
          await store.complete(path, outcome.value);
          return outcome.value;
        } finally { await lifecycle.leave(); }
      }, worktree: async (owner) => resolveWorktree(store, checked.metadata, owner), checkpoint: checkpointBridge(runId, store, checked.metadata, Boolean(params.foreground), params.foreground && ctx.hasUI ? ctx.ui : undefined, headless), phase: phaseBridge(store, checked.metadata, lifecycle), log: logBridge(lifecycle, checked.metadata.name) }, store, runContext, variables, registry), runController.signal);
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
        const diagnostic = await createWorkflowFailureDiagnostics(store, checked.metadata, typed, persisted);
        Object.defineProperty(typed, WORKFLOW_FAILURE_DIAGNOSTICS, { value: diagnostic });
        if (params.foreground) pendingFailureDiagnostics.set(toolCallId, diagnostic);
        throw typed;
      });
      const completion = finish.finally(() => cleanupTerminalRun(runId));
      (runs.get(runId) as NonNullable<ReturnType<typeof runs.get>>).completion = completion;
      if (background) {
        void completion.then(async ({ value, resultPath }) => {
          deliver(pi, completionDelivery(checked.metadata.name, value, resultPath, await store.changedWorktrees()));
        }, (error: unknown) => {
          const diagnostic = failureDiagnosticsFrom(error);
          if (diagnostic) deliverFailure(pi, diagnostic);
          else deliver(pi, `Workflow ${checked.metadata.name} failed: ${formatWorkflowFailure(error)}`);
        });
        return { content: [{ type: "text" as const, text: JSON.stringify({ runId, state: "running" }) }], details: { runId, preview: `Started workflow ${runId}.` } };
      }
      const { value } = await completion;
      const run = (await store.load()).run;
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }, { type: "text" as const, text: `Workflow run ID: ${runId}` }], details: { runId, value, run } };
      } catch (error) {
        throw mainAgentError(error);
      }
    },
    renderCall(args) {
      return textBlock(formatWorkflowPreview(args));
    },
    renderResult(result, { isPartial }, theme, context) {
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
      if (runDetails?.run) return workflowProgressBlock(runDetails.run, theme);
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
      const usage = "Usage: /workflow [doctor|model-aliases], or /workflow pause|resume|stop|approve|reject|delete <run-id> [checkpoint-name]. Approve/reject are for checkpoints only; use workflow_respond with a proposalId or the navigator's budget controls for budget decisions. Use workflow_resume for budget patches."
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
        const settingsPath = workflowSettingsPath(extensionAgentDir);
        const modelRegistry = contextHostCapabilities(ctx).modelRegistry;
        const available = () => [...new Set((modelRegistry?.getAvailable?.() ?? []).map((model) => `${model.provider}/${model.id}`))].sort();
        const selectTarget = async (aliases: Readonly<Record<string, string>>): Promise<string | undefined> => {
          const models = available();
          const choice = await ctx.ui.select("Model alias target", [...models, ...Object.keys(aliases).sort(), "Manual model ID", "Back"]);
          if (!choice || choice === "Back") return undefined;
          if (choice !== "Manual model ID") return choice;
          return (await ctx.ui.input("Manual model ID", "provider/model[:thinking] or alias[:thinking]"))?.trim() || undefined;
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
            const target = await selectTarget(aliases);
            if (!target) continue;
            const next = { ...aliases, [name]: target };
            try { validateModelAliases(next, settingsPath); } catch (error) { ctx.ui.notify(`${settingsPath}: ${error instanceof Error ? error.message : String(error)}`, "error"); continue; }
            const parsed = resolveModelReference(target, next, new Set(available()), settingsPath);
            if (!available().includes(`${parsed.provider}/${parsed.model}`)) {
              ctx.ui.notify(`Warning: ${target} is not currently available in Pi.`, "warning");
              if (!await ctx.ui.confirm("Save unknown model?", "Save this target for cross-machine portability?")) continue;
            }
            save(next);
            continue;
          }
          const edit = /^Edit (.+)$/.exec(choice);
          if (edit?.[1]) {
            const target = await selectTarget(aliases);
            if (!target) continue;
            const next = { ...aliases, [edit[1]]: target };
            try { validateModelAliases(next, settingsPath); } catch (error) { ctx.ui.notify(`${settingsPath}: ${error instanceof Error ? error.message : String(error)}`, "error"); continue; }
            const parsed = resolveModelReference(target, next, new Set(available()), settingsPath);
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
          const hasFailed = sorted.some(({ loaded: { run } }) => run.state === "failed");
          const pickerOptions = [...labels, ...(herdrPaneId() ? ["Inspect session in pane"] : []), "Model aliases", "Close", ...(hasCompleted ? ["Delete all completed"] : []), ...(hasFailed ? ["Delete all failed"] : [])];
          const runChoice = await ctx.ui.select("Workflows\n", pickerOptions);
          if (!runChoice || runChoice === "Close") return;
          if (runChoice === "Inspect session in pane") {
            try {
              await openHerdrPane({ action: "inspect", cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId() });
              ctx.ui.notify("Opened session inspector in pane.", "info");
            } catch (error) {
              ctx.ui.notify(`Cannot open session inspector in pane: ${error instanceof Error ? error.message : String(error)}`, "warning");
            }
            continue;
          }
          if (runChoice === "Model aliases") { await manageAliases(); stores = await loadStores(); continue; }
          if (runChoice === "Delete all completed") {
            if (!await ctx.ui.confirm("Delete completed runs?", "Delete all completed workflow runs and their artifacts? This cannot be undone.")) continue;
            for (const entry of sorted) {
              if (entry.loaded.run.state === "completed") { await entry.store.delete(true); runs.delete(entry.store.runId); terminalRunStates.delete(entry.store.runId); }
            }
            ctx.ui.notify("Deleted all completed workflow runs.", "info"); stores = await loadStores(); continue;
          }
          if (runChoice === "Delete all failed") {
            if (!await ctx.ui.confirm("Delete failed runs?", "Delete all failed workflow runs and their artifacts? This cannot be undone.")) continue;
            for (const entry of sorted) {
              if (entry.loaded.run.state === "failed") { await entry.store.delete(true); runs.delete(entry.store.runId); terminalRunStates.delete(entry.store.runId); }
            }
            ctx.ui.notify("Deleted all failed workflow runs.", "info"); stores = await loadStores(); continue;
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
            if (loaded.run.agents.length) actions.set("Agents...", "agents");
            if (terminalStates.has(loaded.run.state)) add("Delete", "delete");
            if (ctx.mode === "tui") {
              addCopy("Copy run path", store.directory, "run path");
              addCopy("Copy run ID", store.runId, "run ID");
            }
            return { dashboard: formatNavigatorDashboard(loaded.run, checkpoints, worktrees), actions, copies, reviews, script: loaded.snapshot.script, agents: loaded.run.agents, worktrees, cwd: loaded.run.cwd };
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
              ...(attempts.length && herdrPaneId() ? ["Fork as Pi session in pane"] : []),
              ...(worktree ? ["Copy branch", "Copy worktree path"] : []),
              "Copy agent ID",
              "Back",
            ];
            const chooseAttempt = async (): Promise<AgentAttemptSummary | undefined> => {
              const choices = attempts.map((attempt) => `Attempt ${String(attempt.attempt)}`);
              const choice = choices.length === 1 ? choices[0] : await ctx.ui.select("Fork attempts", [...choices, "Back"]);
              const index = choice ? choices.indexOf(choice) : -1;
              return index >= 0 ? attempts[index] : undefined;
            };
            for (;;) {
              const action = await ctx.ui.select(title(selected), actions);
              if (!action || action === "Back") return;
              if (action === "Copy agent ID") { await copyArtifact(selected.id, "agent ID"); continue; }
              if (action === "Copy branch" && worktree) { await copyArtifact(worktree.branch, "branch"); continue; }
              if (action === "Copy worktree path" && worktree) { await copyArtifact(worktree.path, "worktree path"); continue; }
              if (action === "Fork as Pi session in pane") {
                const attempt = await chooseAttempt();
                if (!attempt) continue;
                const running = !SETTLED_AGENT_STATES.has(selected.state) && attempt.attempt === attempts.at(-1)?.attempt && !attempt.error;
                if (running && !await ctx.ui.confirm("Fork running attempt?", "This attempt is still running. The snapshot may end mid-turn and will not receive later updates. It opens read-only to avoid concurrent changes to the workflow agent's working directory. Continue?")) continue;
                try {
                  await openHerdrPane({ action: "fork", cwd: worktree?.cwd ?? attempt.setup?.cwd ?? dashboard.cwd, original: attempt.sessionFile, ...(running ? { readOnly: true } : {}) });
                  ctx.ui.notify("Forked Pi session in pane.", "info");
                } catch (error) {
                  ctx.ui.notify(`Cannot fork Pi session in pane: ${error instanceof Error ? error.message : String(error)}`, "warning");
                }
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
                  const terminalRows = () => Math.max(1, tuiRows(tui) - WORKFLOW_OVERLAY_BORDER_ROWS);
                  const keyLabels: Record<string, string> = { up: "↑", down: "↓", pageUp: "pgup", pageDown: "pgdn", escape: "esc" };
                  const keyLabel = (binding: string, fallback: string) => {
                    const keys = keybindingKeys(keybindings, binding);
                    return keys?.length ? keys.map((key) => keyLabels[key] ?? key).join("/") : fallback;
                  };
                  const dashboardLayout = () => {
                    const rows = terminalRows();
                    const hintRows = rows >= 4 ? 1 : 0;
                    const separatorRows = rows >= 8 ? 1 : 0;
                    const available = Math.max(1, rows - hintRows - separatorRows);
                    const actionViewport = Math.min(options.length, Math.max(1, Math.ceil(available / 2)));
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
                  return borderWorkflowOverlay({
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
                  }, theme);
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
                const viewport = () => Math.max(1, tuiRows(tui) - 3 - WORKFLOW_OVERLAY_BORDER_ROWS);
                const move = (delta: number) => {
                  const maxOffset = Math.max(0, renderedLines.length - viewport());
                  offset = Math.max(0, Math.min(maxOffset, offset + delta));
                };
                return borderWorkflowOverlay({
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
                }, theme);
              }, { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } });
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
                  const rows = Math.max(1, tuiRows(tui) - WORKFLOW_OVERLAY_BORDER_ROWS);
                  const compactControls = rows < 4;
                  const titleRows = rows >= 5 ? 1 : 0;
                  const hintRows = rows >= 8 ? 1 : 0;
                  const separatorRows = rows >= 8 ? 1 : 0;
                  const controlRows = compactControls ? 1 : options.length;
                  const contentViewport = Math.max(0, rows - titleRows - hintRows - separatorRows - controlRows);
                  return { rows, compactControls, titleRows, hintRows, separatorRows, contentViewport };
                };
                const move = (delta: number) => {
                  const maxOffset = Math.max(0, renderedLines.length - layout().contentViewport);
                  offset = Math.max(0, Math.min(maxOffset, offset + delta));
                };
                return borderWorkflowOverlay({
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
                }, theme);
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



