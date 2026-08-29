import { keyHint, truncateToVisualLines, type Theme } from "@earendil-works/pi-coding-agent";
import { type AwaitingCheckpoint, type PersistedRun, type RunStore, type WorktreeReference } from "./persistence.js";
import { budgetUsage } from "./budget.js";
import { formatCost } from "./background-widget.js";
import { WORKFLOW_AGENT_STALL_THRESHOLD_MS, type AgentAttemptAction, type AgentAttemptActionContext, type AgentRecord, type LaunchSnapshot, type StandaloneAgentAttemptActionContext, type WorkflowCatalogFunction, type WorkflowCatalogIndex, type WorkflowPhaseShellActivity } from "./types.js";
import { object } from "./utils.js";
import {
  buildWorkflowPhaseModel,
  buildWorkflowPhaseTree,
  phaseAgentCounts,
  workflowPhaseTreeInitialExpanded,
  workflowPhaseTreePath,
  workflowPhaseTreeVisibleNodes,
  type WorkflowPhaseSelection,
  type WorkflowPhaseState,
  type WorkflowPhaseTreeNode,
} from "./host-phases.js";

export { SETTLED_AGENT_STATES } from "./types.js";
import { SETTLED_AGENT_STATES } from "./types.js";
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
    const seen = new Set<string>([agent.id]);
    for (let parent = agent.parentId; parent && byId.has(parent); parent = byId.get(parent)?.parentId) { if (seen.has(parent)) break; seen.add(parent); depth += 1; }
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
const RUN_STATE_GLYPH: Record<string, string> = { "not started": "○", queued: "○", pausing: "⏸", paused: "⏸", completed: "✓", failed: "✗", stopped: "✗", interrupted: "↯", budget_exhausted: "!", awaiting_input: "?" };
const AGENT_STATE_GLYPH: Record<string, string> = { queued: "○", waiting_for_child: "…", paused: "⏸", retrying: "↻", completed: "✓", failed: "✗", cancelled: "✗" };
function runStateGlyph(state: string, running: string): string { return state === "running" ? running : RUN_STATE_GLYPH[state] ?? "◆"; }
function agentStateGlyph(state: string, running: string): string { return state === "running" ? running : AGENT_STATE_GLYPH[state] ?? "○"; }
type ProgressStyleKey = "success" | "error" | "warning" | "accent" | "muted";
const PROGRESS_STATE_STYLE: Record<string, ProgressStyleKey> = { completed: "success", failed: "error", cancelled: "error", running: "accent", paused: "warning", pausing: "warning", interrupted: "warning", retrying: "accent", budget_exhausted: "warning", awaiting_input: "warning" };
const WORKFLOW_ICON_STYLE: Record<string, ProgressStyleKey> = { completed: "success", failed: "error", stopped: "error", interrupted: "warning", budget_exhausted: "warning", awaiting_input: "warning", paused: "warning", pausing: "warning", running: "accent" };
const PHASE_STATE_STYLE: Record<string, ProgressStyleKey> = { completed: "success", failed: "error", cancelled: "error", stopped: "error", running: "accent", paused: "warning", pausing: "warning", interrupted: "warning", budget_exhausted: "warning" };
function styleForState(map: Record<string, ProgressStyleKey>, state: string, styles: WorkflowProgressStyles): (text: string) => string {
  const key = map[state] ?? "muted";
  return (text) => styles[key](text);
}
function progressStyleForState(state: string, styles: WorkflowProgressStyles): (text: string) => string { return styleForState(PROGRESS_STATE_STYLE, state, styles); }
function workflowIconStyle(state: string, styles: WorkflowProgressStyles): (text: string) => string { return styleForState(WORKFLOW_ICON_STYLE, state, styles); }
function phaseStyleForState(state: string, styles: WorkflowProgressStyles): (text: string) => string { return styleForState(PHASE_STATE_STYLE, state, styles); }
function formatWorkflowRuntime(durationMs: number): string {
  const seconds = Math.max(0, Math.floor(durationMs / 1000));
  if (seconds < 60) return `${String(seconds)}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${String(minutes)}m${remainingSeconds ? ` ${String(remainingSeconds)}s` : ""}`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${String(hours)}h${remainingMinutes ? ` ${String(remainingMinutes)}m` : ""}`;
}
function formatWorkflowTokens(tokens: number): string {
  if (!tokens) return "";
  if (tokens < 1000) return `${String(tokens)}t`;
  const thousands = tokens / 1000;
  return `${thousands < 10 ? thousands.toFixed(1) : String(Math.round(thousands))}kt`;
}
function formatShellActivity(activeShells: number | undefined, startedAt: number | undefined, spinner: string, styles: WorkflowProgressStyles, now: number): string | undefined {
  const count = activeShells ?? 0;
  if (count <= 0) return undefined;
  const started = startedAt !== undefined && Number.isFinite(startedAt) ? new Date(startedAt) : undefined;
  const timing = started && startedAt !== undefined && !Number.isNaN(started.getTime()) ? ` ${styles.dim(`started=${started.toISOString()} elapsed=${formatWorkflowRuntime(Math.max(0, now - startedAt))}`)}` : "";
  return `${styles.accent(spinner)} shell ${styles.accent("[running]")} ${styles.dim(`(${String(count)} active)`)}${timing}`;
}
function phaseShellActivity(run: Pick<PersistedRun, "activeShellsByPhase">, phaseIndex: number): WorkflowPhaseShellActivity | undefined {
  return run.activeShellsByPhase?.find((activity) => activity.phaseIndex === phaseIndex && activity.active > 0);
}
function formatLogTimestamp(timestamp: number | undefined): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return "--:--:--";
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, "0")).join(":");
}
function workflowLogLines(run: PersistedRun, styles: WorkflowProgressStyles, expanded: boolean, width?: number, showHint = false): string[] {
  const events = (run.events ?? []).filter((event) => event.type === "log");
  if (!events.length) return [];
  const indent = " ".repeat(11);
  const visualLines = events.flatMap((event) => event.message.split("\n").flatMap((message, lineIndex) => {
    const prefix = lineIndex === 0 ? `  ${styles.dim(formatLogTimestamp(event.timestamp))} ` : indent;
    if (width === undefined) return [`${prefix}${message}`];
    const chunks = truncateToVisualLines(message, Number.MAX_SAFE_INTEGER, Math.max(1, width - 11), 0).visualLines;
    return chunks.map((chunk, chunkIndex) => `${chunkIndex === 0 ? prefix : indent}${chunk}`);
  }));
  const visible = expanded ? visualLines : visualLines.slice(-5);
  let hint = "";
  if (!expanded && showHint) { try { hint = ` (${keyHint("app.tools.expand", "to expand")})`; } catch { /* Theme is unavailable in non-interactive render tests. */ } }
  return [expanded ? `  ${styles.muted("Logs")}` : `  ${styles.muted(`Logs${hint}`)}`, ...visible];
}
export function formatWorkflowProgress(run: PersistedRun, spinner = "◇", styles: WorkflowProgressStyles = PLAIN_WORKFLOW_PROGRESS_STYLES, now = Date.now(), expanded = false, width?: number, showHint = false): string {
  const done = run.agents.filter((agent) => SETTLED_AGENT_STATES.has(agent.state)).length;
  const workflowIcon = runStateGlyph(run.state, spinner);
  const iconStyle = workflowIconStyle(run.state, styles);
  const header = styles.bold(styles.accent(`Workflow: ${run.workflowName} (${String(done)}/${String(run.agents.length)} done)`));
  const state = progressStyleForState(run.state, styles)(`[${run.state}]`);
  const usageStats = run.usage ? [formatWorkflowTokens(run.usage.tokens), formatCost(run.usage.costUsd)].filter(Boolean).join(" · ") : "";
  const runtime = run.usage ? ` runtime=${formatWorkflowRuntime(run.usage.durationMs)}` : "";
  const lines = [`${iconStyle(workflowIcon)} ${header} ${state}${usageStats ? ` ${usageStats}` : ""}${runtime}`];
  const budgetWarning = run.state === "budget_exhausted" || (run.budgetEvents ?? []).some((event) => event.type === "hard_exhausted");
  lines.push(...formatCompactBudgetStatus(run).map((line) => `  ${budgetWarning ? styles.warning(line) : line}`));
  const scopedShells = (run.activeShellsByPhase?.length ?? 0) > 0;
  const shellActivity = scopedShells ? undefined : formatShellActivity(run.activeShells, run.activeShellStartedAt, spinner, styles, now);
  if (shellActivity) lines.push(`  ${shellActivity}`);
  const byId = new Map(run.agents.map((agent) => [agent.id, agent]));
  const renderAgents = (agents: readonly AgentRecord[], offset: number, nested: boolean) => renderGroupedAgents(agents, ({ agent, index, depth }, grouped) => {
    const icon = agentStateGlyph(agent.state, spinner);
    const indent = "  ".repeat((grouped ? 2 : 1) + depth);
    const activity = SETTLED_AGENT_STATES.has(agent.state) ? "" : formatAgentActivity(agent, spinner, styles, now);
    const name = grouped ? agent.label ?? agent.name : styledAgentBreadcrumb(agent, byId, styles);
    const state = progressStyleForState(agent.state, styles);
    const detail = expanded ? formatWorkflowAgentDetail(agent, now) : "";
    return `${indent}#${String(offset + index + 1)} ${state(icon)} ${name} ${state(`[${agent.state}]`)}${activity ? ` ${activity}` : ""}${detail ? ` ${detail}` : ""}`;
  }, run.agents, (label) => styles.muted(label)).map((line) => nested ? `  ${line}` : line);
  const phases = run.phaseHistory?.length ? run.phaseHistory : run.phase ? [{ phase: run.phase, afterAgent: 0 }] : [];
  if (scopedShells) {
    const preflight = phaseShellActivity(run, -1);
    if (preflight) {
      lines.push(`  ${styles.muted("[Preflight]")}`);
      const rendered = formatShellActivity(preflight.active, preflight.startedAt, spinner, styles, now);
      if (rendered) lines.push(`    ${rendered}`);
    }
  }
  let renderedAgents = 0;
  let nested = false;
  for (const [phaseIndex, phase] of phases.entries()) {
    const boundary = Math.max(renderedAgents, Math.min(run.agents.length, phase.afterAgent));
    lines.push(...renderAgents(run.agents.slice(renderedAgents, boundary), renderedAgents, nested));
    lines.push(`  ${styles.muted(`[Phase: ${phase.phase}]`)}`);
    const phaseShell = scopedShells ? phaseShellActivity(run, phaseIndex) : undefined;
    if (phaseShell) {
      const rendered = formatShellActivity(phaseShell.active, phaseShell.startedAt, spinner, styles, now);
      if (rendered) lines.push(`    ${rendered}`);
    }
    renderedAgents = boundary;
    nested = true;
  }
  lines.push(...renderAgents(run.agents.slice(renderedAgents), renderedAgents, nested));
  lines.push(...workflowLogLines(run, styles, expanded, width, showHint));
  return lines.join("\n");
}

const workflowSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const WORKFLOW_PROGRESS_REFRESH_MS = 1_000;

export function textBlock(text: string) {
  return {
    render(width: number) {
      return text.split("\n").map((line) => line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`);
    },
    invalidate() {},
  };
}
export function styledTextBlock(text: string) {
  return {
    render(width: number) {
      return truncateWorkflowProgress(text, width);
    },
    invalidate() {},
  };
}
export function workflowCatalogBlock(text: string, expanded: boolean) {
  return {
    render(width: number) {
      const safeWidth = Math.max(1, width);
      if (!expanded) return truncateWorkflowProgress(text, safeWidth);
      return truncateToVisualLines(text, Number.MAX_SAFE_INTEGER, safeWidth, 0).visualLines.map((line) => line.trimEnd());
    },
    invalidate() {},
  };
}

type WorkflowControlResult = { details?: unknown; content?: readonly { type: string; text?: string }[] };
function controlString(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value : undefined; }
function controlValue(value: unknown): string {
  if (value === null) return "removed";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  const json = JSON.stringify(value);
  return typeof json === "string" ? json : "unknown";
}
function controlTitle(name: string, theme: Theme): string { return theme.fg("toolTitle", theme.bold(name)); }
function controlState(state: string, theme: Theme): string {
  const color = state === "completed" || state === "running" || state === "stopped" ? "success" : state === "failed" || state === "unknown" ? "error" : state === "budget_exhausted" || state === "awaiting_approval" ? "warning" : "accent";
  return theme.fg(color, state);
}
function controlAction(action: string, theme: Theme): string {
  const color = /approved|completed|stopped|started|resumed/.test(action) ? "success" : /rejected|failed/.test(action) ? "error" : "warning";
  return theme.fg(color, action);
}
function budgetPatchEntries(value: unknown): string[] {
  if (!object(value)) return value === undefined ? [] : [controlValue(value)];
  return Object.entries(value).map(([dimension, limits]) => {
    if (limits === null) return `${dimension}=removed`;
    if (!object(limits)) return `${dimension}=${controlValue(limits)}`;
    const parts = ["soft", "hard"].filter((key) => Object.prototype.hasOwnProperty.call(limits, key)).map((key) => `${key}=${controlValue(limits[key])}`);
    return `${dimension} ${parts.join(" ")}`;
  });
}
function budgetPatchSummary(value: unknown): string {
  const entries = budgetPatchEntries(value);
  return entries.length ? entries.join(", ") : "unchanged";
}
function budgetPatchDetails(value: unknown, theme: Theme): string[] {
  const entries = budgetPatchEntries(value);
  return entries.length ? [theme.fg("accent", theme.bold("Budget patch")), ...entries.map((entry) => `  ${theme.fg("toolOutput", entry)}`)] : [];
}
function workflowControlValue(result: WorkflowControlResult): unknown { return catalogResultValue(result); }
export function workflowControlCall(name: string, args: Record<string, unknown>, theme: Theme): string {
  const runId = controlString(args.runId) ?? "(missing run ID)";
  if (name === "workflow_respond") {
    const proposalId = controlString(args.proposalId);
    const target = proposalId ? `budget proposal ${proposalId}` : `checkpoint ${controlString(args.name) ?? "(missing name)"}`;
    const decision = args.approved === true ? "approve" : "reject";
    return [`${controlTitle(name, theme)} ${theme.fg("accent", runId)}`, `${theme.fg("muted", target)} · ${controlAction(decision, theme)}`].join("\n");
  }
  if (name === "workflow_status") return `${controlTitle(name, theme)} ${theme.fg("accent", runId)}`;
  if (name === "workflow_resume") return args.budget === undefined ? `${controlTitle(name, theme)} ${theme.fg("accent", runId)}` : [`${controlTitle(name, theme)} ${theme.fg("accent", runId)}`, `${theme.fg("muted", "Budget")} ${theme.fg("toolOutput", budgetPatchSummary(args.budget))}`].join("\n");
  if (name === "workflow_retry") return `${controlTitle(name, theme)} ${theme.fg("accent", runId)} ${theme.fg("muted", "failed run")}`;
  return `${controlTitle(name, theme)} ${theme.fg("accent", runId)}`;
}
export function workflowControlResult(name: string, args: Record<string, unknown>, result: WorkflowControlResult, expanded: boolean, theme: Theme, isError: boolean): string {
  if (isError) {
    const text = result.content?.filter(({ type }) => type === "text").map(({ text }) => text ?? "").join("\n").trim();
    return theme.fg("error", text || `The ${name} tool failed.`);
  }
  const value = workflowControlValue(result);
  if (!object(value)) return theme.fg("error", `The ${name} tool returned an invalid result.`);
  const runId = controlString(args.runId) ?? controlString(value.runId) ?? "(unknown)";
  const title = controlTitle(name, theme);
  if (name === "workflow_stop") {
    const state = controlString(value.state) ?? "unknown";
    const action = value.stopped === true ? "stopped" : value.reason === "already_terminal" ? "already terminal" : value.reason === "unknown_run" ? "run not found" : "no change";
    if (!expanded) return `${title}\nRun ${theme.fg("accent", runId)} · ${controlState(state, theme)} · ${controlAction(action, theme)}`;
    return [title, `Run: ${theme.fg("accent", runId)}`, `State: ${controlState(state, theme)}`, `Action: ${controlAction(action, theme)}`, ...(controlString(value.reason) ? [`Reason: ${theme.fg("toolOutput", controlValue(value.reason))}`] : [])].join("\n");
  }
  if (name === "workflow_status") {
    const state = controlString(value.state) ?? "unknown";
    const workflowName = controlString(value.workflowName);
    const agents = Array.isArray(value.agents) ? value.agents.length : 0;
    if (!expanded) return [title, `Run ${theme.fg("accent", runId)} · ${controlState(state, theme)}`, ...(workflowName ? [workflowName] : [])].join("\n");
    return [title, `Run: ${theme.fg("accent", runId)}`, ...(workflowName ? [`Workflow: ${theme.fg("toolOutput", workflowName)}`] : []), `State: ${controlState(state, theme)}`, `Agents: ${String(agents)}`].join("\n");
  }
  if (name === "workflow_retry") {
    const childRunId = controlString(value.runId) ?? "(unknown)";
    const state = controlString(value.state) ?? "unknown";
    const action = state === "completed" ? "completed" : "started";
    if (!expanded) return [title, `Source ${theme.fg("accent", runId)}`, `Child ${theme.fg("accent", childRunId)} · ${controlState(state, theme)} · ${controlAction(action, theme)}`].join("\n");
    return [title, `Source run: ${theme.fg("accent", runId)}`, `Retry run: ${theme.fg("accent", childRunId)}`, `State: ${controlState(state, theme)}`, `Action: ${controlAction(action === "completed" ? "completed" : "started; completed work will be replayed", theme)}`].join("\n");
  }
  if (name === "workflow_resume") {
    const state = controlString(value.state) ?? "unknown";
    const proposalId = controlString(value.proposalId);
    const action = state === "awaiting_approval" ? "approval required" : state === "running" ? "resumed" : state === "completed" ? "completed" : "no change";
    if (!expanded) return [title, `Run ${theme.fg("accent", runId)} · ${controlState(state, theme)} · ${controlAction(action, theme)}`, ...(proposalId ? [`Proposal ${theme.fg("accent", proposalId)}`] : [])].join("\n");
    return [title, `Run: ${theme.fg("accent", runId)}`, `State: ${controlState(state, theme)}`, `Action: ${controlAction(action, theme)}`, ...(proposalId ? [`Proposal: ${theme.fg("accent", proposalId)}`] : []), ...budgetPatchDetails(args.budget, theme)].join("\n");
  }
  const proposalId = controlString(args.proposalId);
  const checkpointName = controlString(args.name);
  const target = proposalId ? `Budget proposal ${theme.fg("accent", proposalId)}` : `Checkpoint ${theme.fg("accent", checkpointName ?? "(missing)")}`;
  const accepted = value.accepted === true;
  const approved = value.approved === true;
  const reason = controlString(value.reason);
  const action = reason === "proposal_not_pending" ? "not pending" : reason === "checkpoint" && !accepted ? "not pending" : approved ? "approved" : "rejected";
  const state = controlString(value.state);
  if (!expanded) return [title, target, `Run ${theme.fg("accent", runId)} · ${controlAction(action, theme)}${state ? ` · ${controlState(state, theme)}` : ""}`].join("\n");
  return [title, `Run: ${theme.fg("accent", runId)}`, `Target: ${target}`, `Action: ${controlAction(action, theme)}`, ...(state ? [`State: ${controlState(state, theme)}`] : []), ...(reason ? [`Reason: ${theme.fg("toolOutput", reason)}`] : [])].join("\n");
}

function catalogText(value: string): string { return value.replace(/\s+/g, " ").trim(); }

type CatalogToolResult = { details?: unknown; content?: readonly { type: string; text?: string }[] };

export function catalogResultValue(result: CatalogToolResult): unknown {
  if (result.details !== undefined) return result.details;
  const text = result.content?.find((entry) => entry.type === "text")?.text;
  if (!text) return undefined;
  try { return JSON.parse(text) as unknown; } catch { return text; }
}

function isCatalogIndex(value: unknown): value is WorkflowCatalogIndex {
  return object(value) && Array.isArray(value.functions);
}

function isCatalogFunction(value: unknown): value is WorkflowCatalogFunction {
  return object(value) && typeof value.name === "string" && typeof value.description === "string" && object(value.input) && object(value.output);
}

function isWorkflowCatalogModelAlias(value: unknown): value is import("./types.js").WorkflowCatalogModelAlias {
  return object(value) && typeof value.name === "string" && (value.kind === "static" || value.kind === "dynamic") && typeof value.provenance === "string" && (value.version === undefined || typeof value.version === "string") && (value.headline === undefined || typeof value.headline === "string");
}

function isCatalogError(value: unknown): value is { error: { message: string } } {
  return object(value) && object(value.error) && typeof value.error.message === "string";
}

function catalogSectionTitle(label: string, count: number, theme: Theme): string {
  return theme.fg("accent", theme.bold(`${label} (${String(count)})`));
}

function catalogIndexEntries(entries: readonly { name: string; description: string }[], theme: Theme): string[] {
  const width = Math.max(0, ...entries.map((entry) => entry.name.length));
  return entries.map((entry) => `  ${theme.fg("accent", entry.name.padEnd(width))}  ${theme.fg("toolOutput", catalogText(entry.description))}`);
}

function formatCatalogIndex(catalog: WorkflowCatalogIndex, theme: Theme): string {
  const aliases = Object.prototype.propertyIsEnumerable.call(catalog, "modelAliases") ? Object.keys(catalog.modelAliases ?? {}).sort().map((name) => ({ name, kind: "static" as const, provenance: "settings" })) : catalog.modelAliasEntries ?? Object.keys(catalog.modelAliases ?? {}).sort().map((name) => ({ name, kind: "static" as const, provenance: "settings" }));
  const aliasWidth = Math.max(0, ...aliases.map(({ name }) => name.length));
  const aliasLines = aliases.map(({ name, kind, provenance }) => `  ${theme.fg("accent", name.padEnd(aliasWidth))}  ${theme.fg("toolOutput", `${kind} · ${provenance}`)}`);
  return [
    catalogSectionTitle("Functions", catalog.functions.length, theme),
    ...catalogIndexEntries(catalog.functions, theme),
    "",
    catalogSectionTitle("Model aliases", aliases.length, theme),
    ...aliasLines,
  ].join("\n");
}

function catalogSchemaLines(schema: unknown, theme: Theme): string[] {
  const json = JSON.stringify(schema, null, 2);
  return json.split("\n").map((line) => `  ${theme.fg("toolOutput", line)}`);
}

function formatCatalogDetail(value: WorkflowCatalogFunction | import("./types.js").WorkflowCatalogModelAlias, expanded: boolean, theme: Theme): string {
  if ("kind" in value) return [theme.fg("accent", theme.bold("Model alias")), `  ${theme.fg("accent", value.name)}  ${theme.fg("toolOutput", `${value.kind} · ${value.provenance}`)}`].join("\n");
  const kind = "Function";
  if (!expanded) return [theme.fg("accent", theme.bold(kind)), `  ${theme.fg("accent", value.name)}  ${theme.fg("toolOutput", catalogText(value.description))}`, `  ${theme.fg("muted", "version")}: ${theme.fg("toolOutput", value.version)}  ${theme.fg("muted", "headline")}: ${theme.fg("toolOutput", catalogText(value.headline))}`].join("\n");
  const lines = [theme.fg("accent", theme.bold(`${kind}: ${value.name}`)), `${theme.fg("muted", "description")}: ${theme.fg("toolOutput", value.description)}`, "", theme.fg("accent", theme.bold("Extension")), `  ${theme.fg("muted", "version")}: ${theme.fg("toolOutput", value.version)}`, `  ${theme.fg("muted", "headline")}: ${theme.fg("toolOutput", catalogText(value.headline))}`, "", theme.fg("accent", theme.bold("Schema")), theme.fg("muted", "Input schema"), ...catalogSchemaLines(value.input, theme), "", theme.fg("muted", "Output schema"), ...catalogSchemaLines(value.output, theme)];
  return lines.join("\n");
}

export function formatWorkflowCatalog(value: unknown, expanded: boolean, theme: Theme): string {
  if (isCatalogIndex(value)) return formatCatalogIndex(value, theme);
  if (isCatalogFunction(value)) return formatCatalogDetail(value, expanded, theme);
  if (isWorkflowCatalogModelAlias(value)) return formatCatalogDetail(value, expanded, theme);
  if (isCatalogError(value)) return theme.fg("error", value.error.message);
  return theme.fg("error", "The workflow catalog returned an invalid result.");
}

const ANSI_SGR_SOURCE = `${String.fromCharCode(27)}\\[[0-9;]*m`;
const ANSI_SGR = new RegExp(ANSI_SGR_SOURCE);
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
export function themeWorkflowProgressStyles(theme: Theme): WorkflowProgressStyles {
  return {
    accent: (text) => theme.fg("accent", text),
    success: (text) => theme.fg("success", text),
    error: (text) => theme.fg("error", text),
    warning: (text) => theme.fg("warning", text),
    muted: (text) => theme.fg("muted", text),
    dim: (text) => theme.fg("dim", text),
    bold: (text) => typeof theme.bold === "function" ? theme.bold(text) : text,
  };
}
export type WorkflowProgressRefreshState = { runId: string; inputRun: PersistedRun; run: PersistedRun; lastRefreshAt: number; runtimeStartedAt: number; runtimeBaseMs: number; refresh?: Promise<void> };
export type WorkflowProgressRenderState = { workflowSpinner?: ReturnType<typeof setInterval>; workflowProgress?: WorkflowProgressRefreshState; workflowProgressComponent?: ReturnType<typeof workflowProgressBlock>; workflowProgressFrozenAt?: number };
function isTerminalWorkflowState(state: PersistedRun["state"]): boolean { return state === "completed" || state === "failed" || state === "stopped"; }
export function workflowProgressBlock(run: PersistedRun, theme: Theme, progress?: WorkflowProgressRefreshState, refresh?: () => Promise<PersistedRun | undefined>, invalidate?: () => void, prefix?: string, freezeAt?: number) {
  const styles = themeWorkflowProgressStyles(theme);
  let expanded = false;
  let frozenAt = freezeAt ?? Date.now();
  let previousState = run.state;
  const currentRun = () => {
    const displayed = progress?.run ?? run;
    if (!progress || displayed.state !== "running") return displayed;
    const durationMs = Math.max(displayed.usage?.durationMs ?? 0, progress.runtimeBaseMs + Date.now() - progress.runtimeStartedAt);
    return { ...displayed, usage: { ...budgetUsage(displayed.usage), durationMs } };
  };
  return {
    render(width: number) {
      const displayed = currentRun();
      const terminal = isTerminalWorkflowState(displayed.state);
      let now = Date.now();
      if (freezeAt !== undefined || terminal) {
        if (previousState !== displayed.state && !isTerminalWorkflowState(previousState)) frozenAt = now;
        now = frozenAt;
      } else {
        frozenAt = now;
      }
      previousState = displayed.state;
      const frame = displayed.state === "running" ? workflowSpinner[Math.floor(now / 80) % workflowSpinner.length] ?? "◇" : "◇";
      const progressText = formatWorkflowProgress(displayed, frame, styles, now, expanded, width, true);
      return truncateWorkflowProgress(prefix ? `${prefix}\n\n${progressText}` : progressText, width);
    },
    setExpanded(value: boolean) { expanded = value; },
    invalidate() {
      const displayed = currentRun();
      const now = Date.now();
      if (!progress || !refresh || displayed.state !== "running" || (!displayed.agents.some((agent) => agent.state === "running") && (displayed.activeShells ?? 0) <= 0)) return;
      if (progress.refresh || now - progress.lastRefreshAt < WORKFLOW_PROGRESS_REFRESH_MS) return;
      progress.lastRefreshAt = now;
      const inputRun = progress.inputRun;
      const pending = refresh().then((next) => {
        if (next && progress.inputRun === inputRun) {
          progress.run = next;
          invalidate?.();
        }
      }).catch(() => undefined);
      progress.refresh = pending;
      void pending.finally(() => {
        if (progress.refresh === pending) delete progress.refresh;
      });
    },
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

export function navigatorAttentionSortByState<T>(entries: readonly T[], stateOf: (entry: T) => string, resolvedAtOf: (entry: T) => number | undefined, stateOrder: Readonly<Record<string, number>> = ATTENTION_ORDER): T[] {
  return [...entries].sort((left, right) => {
    const leftResolvedAt = resolvedAtOf(left);
    const rightResolvedAt = resolvedAtOf(right);
    if (leftResolvedAt !== undefined || rightResolvedAt !== undefined) {
      if (leftResolvedAt === undefined) return -1;
      if (rightResolvedAt === undefined) return 1;
      if (leftResolvedAt !== rightResolvedAt) return rightResolvedAt - leftResolvedAt;
    }
    return (stateOrder[stateOf(left)] ?? 9) - (stateOrder[stateOf(right)] ?? 9);
  });
}

export function navigatorAttentionSort<T extends { loaded: { run: PersistedRun }; resolvedAt?: number | undefined }>(entries: readonly T[]): T[] {
  return navigatorAttentionSortByState(entries, (entry) => entry.loaded.run.state, (entry) => entry.resolvedAt);
}

export function navigatorRunLabels(entries: readonly { store: RunStore; loaded: { run: PersistedRun } }[]): string[] {
  const nameCount = new Map<string, number>();
  for (const { loaded: { run } } of entries) nameCount.set(run.workflowName, (nameCount.get(run.workflowName) ?? 0) + 1);
  return entries.map(({ store, loaded: { run } }) => {
    const done = run.agents.filter((a) => SETTLED_AGENT_STATES.has(a.state)).length;
    const glyph = runStateGlyph(run.state, "⠦");
    const suffix = (nameCount.get(run.workflowName) ?? 0) > 1 ? ` ${store.runId.slice(0, 8)}` : "";
    const cost = run.agents.reduce((sum, a) => sum + (a.accounting?.cost ?? 0), 0);
    const costStr = formatCost(cost);
    const runtime = run.usage ? ` runtime=${formatWorkflowRuntime(run.usage.durationMs)}` : "";
    return `${glyph} ${run.workflowName}${suffix}  ${run.state}  ${run.phase ?? ""}  ${String(done)}/${String(run.agents.length)} agents${costStr ? ` ${costStr}` : ""}${runtime}`;
  });
}

export function agentBreadcrumbParts(agent: AgentRecord, byId: Map<string, AgentRecord>, includeStructuralPath = false): string[] {
  const leaf = agent.label ?? agent.name;
  const parts: string[] = includeStructuralPath && agent.structuralPath?.length ? [agent.structuralPath.join(" > ")] : [];
  if (agent.parentBreadcrumb) parts.push(agent.parentBreadcrumb);
  const ancestors: string[] = [];
  const seen = new Set<string>([agent.id]);
  for (let parentId = agent.parentId; parentId; parentId = byId.get(parentId)?.parentId) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    ancestors.push(parent.label ?? parent.name);
  }
  parts.push(...ancestors.reverse(), leaf);
  return parts;
}
export function agentBreadcrumb(agent: AgentRecord, byId: Map<string, AgentRecord>, includeStructuralPath = false): string {
  return agentBreadcrumbParts(agent, byId, includeStructuralPath).join(" > ");
}
function styledAgentBreadcrumb(agent: AgentRecord, byId: Map<string, AgentRecord>, styles: WorkflowProgressStyles): string {
  const parts = agentBreadcrumbParts(agent, byId);
  if (parts.length <= 1) return parts[0] ?? "";
  return `${styles.muted(parts.slice(0, -1).join(" > "))} > ${styles.bold(parts[parts.length - 1] ?? "")}`;
}

export function formatStalledDuration(durationMs: number): string {
  const minutes = Math.max(0, Math.floor(durationMs / 60_000));
  if (minutes < 60) return `${String(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${String(hours)}h${remainingMinutes ? ` ${String(remainingMinutes)}m` : ""}`;
}
function stalledDuration(agent: AgentRecord, now: number): number | undefined {
  if (agent.state !== "running" || agent.lastEventAt === undefined || !Number.isFinite(agent.lastEventAt)) return undefined;
  const duration = now - agent.lastEventAt;
  return duration >= WORKFLOW_AGENT_STALL_THRESHOLD_MS ? duration : undefined;
}
function agentActivityLabel(agent: { readonly activity?: AgentRecord["activity"]; readonly toolCalls?: AgentRecord["toolCalls"] }): string {
  const activity = agent.activity;
  if (activity?.kind === "reasoning" || activity?.kind === "text") {
    const name = activity.kind === "reasoning" ? "reasoning" : "responding";
    return activity.text && activity.text !== name ? `${name} · ${activity.text}` : name;
  }
  if (activity?.kind === "tool") return activity.text;
  return [...(agent.toolCalls ?? [])].reverse().find(({ state }) => state === "running")?.name ?? "";
}
function formatAgentActivity(agent: AgentRecord, spinner: string, styles: WorkflowProgressStyles = PLAIN_WORKFLOW_PROGRESS_STYLES, now = Date.now()): string {
  const label = agentActivityLabel(agent);
  const activity = label ? `${styles.accent(spinner)} ${styles.dim(label)}` : "";
  const stalled = stalledDuration(agent, now);
  if (stalled === undefined) return activity;
  const warning = `stalled? ${formatStalledDuration(stalled)}`;
  return activity ? `${activity} ${styles.warning(`- ${warning}`)}` : styles.warning(warning);
}
function formatWorkflowAgentDetail(agent: AgentRecord, now: number): string {
  const durationMs = agent.durationMs !== undefined && Number.isFinite(agent.durationMs)
    ? Math.max(0, agent.durationMs)
    : agent.startedAt === undefined || !Number.isFinite(agent.startedAt)
      ? undefined
      : Math.max(0, now - agent.startedAt);
  const accounting = agent.accounting;
  return [
    `${agent.model.model}${agent.model.thinking ? `:${agent.model.thinking}` : ""}`,
    accounting ? formatWorkflowTokens(accounting.input + accounting.output) : "",
    accounting ? formatCost(accounting.cost) : "",
    durationMs === undefined ? "" : formatWorkflowRuntime(durationMs),
    agent.attempts > 1 ? `attempt ${String(agent.attempts)}` : "",
  ].filter(Boolean).join(" · ");
}

function formatAccountingValue(value: number): string {
  return new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(value).toLowerCase();
}

function formatAccounting(accounting: NonNullable<AgentRecord["accounting"]>): string {
  const total = accounting.input + accounting.output + accounting.cacheRead + accounting.cacheWrite;
  return `${formatAccountingValue(total)} tok`;
}
export interface AgentDetailPresentation {
  readonly state: string;
  readonly activity?: AgentRecord["activity"];
  readonly lastEventAt?: number;
  readonly structuralPath?: readonly string[];
  readonly model?: AgentRecord["model"];
  readonly role?: string;
  readonly tools?: readonly string[];
  readonly attempts?: number;
  readonly startedAt?: number;
  readonly finishedAt?: number;
  readonly durationMs?: number;
  readonly accounting?: NonNullable<AgentRecord["accounting"]>;
  readonly error?: { readonly code: string; readonly message: string };
}
function formatAgentError(error: NonNullable<AgentDetailPresentation["error"]>, styles: WorkflowProgressStyles = PLAIN_WORKFLOW_PROGRESS_STYLES): string {
  return styles.error(`Error: ${error.code}: ${error.message}`);
}

export function formatAgentDetail(agent: Readonly<AgentDetailPresentation>, styles: WorkflowProgressStyles = PLAIN_WORKFLOW_PROGRESS_STYLES, now = Date.now(), options: Readonly<{ includeError?: boolean }> = {}): string[] {
  const duration = agent.durationMs !== undefined && Number.isFinite(agent.durationMs)
    ? Math.max(0, agent.durationMs)
    : agent.startedAt === undefined || !Number.isFinite(agent.startedAt)
      ? undefined
      : Math.max(0, (agent.finishedAt ?? now) - agent.startedAt);
  const stalled = agent.state === "running" && agent.lastEventAt !== undefined && Number.isFinite(agent.lastEventAt) && now - agent.lastEventAt >= WORKFLOW_AGENT_STALL_THRESHOLD_MS
    ? Math.max(0, now - agent.lastEventAt)
    : undefined;
  const state = phaseStyleForState(agent.state, styles);
  const model = agent.model === undefined ? undefined : `${agent.model.provider}/${agent.model.model}${agent.model.thinking ? `:${agent.model.thinking}` : ""}`;
  const tools = agent.tools?.join(", ") || "(none)";
  const lines = [
    ...(agent.activity ? [`Activity: ${agentActivityLabel(agent) || agent.activity.kind}`] : []),
    ...(stalled === undefined ? [] : [styles.warning(`stalled? ${formatStalledDuration(stalled)}`)]),
    `State: ${state(agent.state)}`,
    ...(agent.structuralPath?.length ? [`Structural path: ${agent.structuralPath.join(" > ")}`] : []),
    ...(model === undefined ? [] : [`Model: ${model}`]),
    `Role: ${agent.role ?? "(none)"}`,
    `Tools: ${tools}`,
    ...(agent.attempts !== undefined && Number.isFinite(agent.attempts) && agent.attempts > 1 ? [`Attempts: ${String(agent.attempts)}`] : []),
    ...(duration === undefined ? [] : [`Duration: ${formatWorkflowRuntime(duration)}`]),
    ...(agent.accounting ? formatAgentAccounting(agent.accounting) : []),
  ];
  if (agent.error && options.includeError !== false) lines.push(formatAgentError(agent.error, styles));
  return lines;
}

export interface AgentActionPresentation {
  readonly extensionLabels: readonly string[];
  readonly hasWorktree: boolean;
  readonly openPrompt: boolean;
  readonly openSystemPrompt: boolean;
  readonly openResult: boolean;
  readonly standaloneState?: "running" | "completed" | "failed" | "stopped";
}

export function agentActionLabels(options: Readonly<AgentActionPresentation>): string[] {
  return [
    ...options.extensionLabels,
    ...(options.hasWorktree ? ["Copy branch", "Copy worktree path"] : []),
    ...(options.openPrompt ? ["Open prompt in editor"] : []),
    ...(options.openSystemPrompt ? ["Open system prompt in editor"] : []),
    ...(options.openResult ? ["Open result in editor"] : []),
    ...(options.standaloneState === "running" ? ["Steer", "Stop"] : []),
    ...(options.standaloneState === "failed" || options.standaloneState === "stopped" ? ["Retry"] : []),
    "Copy agent ID",
    "Back",
  ];
}

export function visibleAgentAttemptActions(actions: Readonly<Record<string, AgentAttemptAction>>, context: Readonly<AgentAttemptActionContext>): readonly [string, AgentAttemptAction][] {
  return Object.entries(actions).filter(([, action]) => {
    try { return action.visible(context); } catch { return false; }
  });
}

export function visibleStandaloneAgentAttemptActions(actions: Readonly<Record<string, AgentAttemptAction>>, context: Readonly<StandaloneAgentAttemptActionContext>): readonly [string, AgentAttemptAction][] {
  return Object.entries(actions).filter(([, action]) => {
    try { return action.visibleStandalone?.(context) === true; } catch { return false; }
  });
}


function formatAgentAccounting(accounting: NonNullable<AgentRecord["accounting"]>): string[] {
  const total = accounting.input + accounting.output + accounting.cacheRead + accounting.cacheWrite;
  return [`Tokens: ∑${formatAccountingValue(total)} ↑${formatAccountingValue(accounting.input)} ↓${formatAccountingValue(accounting.output)} ⇢${formatAccountingValue(accounting.cacheRead)} ⇠${formatAccountingValue(accounting.cacheWrite)}`, `Cost: ${formatCost(accounting.cost) || "$0.00"}`];
}

export function formatNavigatorDashboard(run: PersistedRun, checkpoints: readonly AwaitingCheckpoint[], worktrees: readonly WorktreeReference[], now = Date.now()): string {
  void worktrees;
  const done = run.agents.filter((a) => SETTLED_AGENT_STATES.has(a.state)).length;
  const totalAccounting = run.agents.reduce((sum, a) => ({ input: sum.input + (a.accounting?.input ?? 0), output: sum.output + (a.accounting?.output ?? 0), cacheRead: sum.cacheRead + (a.accounting?.cacheRead ?? 0), cacheWrite: sum.cacheWrite + (a.accounting?.cacheWrite ?? 0), cost: sum.cost + (a.accounting?.cost ?? 0) }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const hasAccounting = run.agents.some((a) => a.accounting);
  const glyph = runStateGlyph(run.state, "⠦");
  const header = `${glyph} ${run.workflowName}`;
  const runtime = run.usage ? `runtime=${formatWorkflowRuntime(run.usage.durationMs)}` : "";
  const meta = [run.state, run.phase ? `phase: ${run.phase}` : "", `${String(done)}/${String(run.agents.length)} agents`, runtime, hasAccounting ? formatAccounting(totalAccounting) : "", formatCost(totalAccounting.cost)].filter(Boolean).join(" · ");
  const lines = [header, meta, ...formatCompactBudgetStatus(run)];
  const shellActivity = formatShellActivity(run.activeShells, run.activeShellStartedAt, "⠦", PLAIN_WORKFLOW_PROGRESS_STYLES, now);
  if (shellActivity) lines.push(`  ${shellActivity}`);
  if (run.error) lines.push(`Error: ${run.error.code}: ${run.error.message}`);
  if (run.events?.length) lines.push(...run.events.filter((event) => event.type === "warning").map((event) => `Warning: ${event.message}`));
  lines.push("");
  const byId = new Map(run.agents.map((a) => [a.id, a]));
  const render = ({ agent, depth }: { agent: AgentRecord; index: number; depth: number }, grouped: boolean) => {
    const icon = agentStateGlyph(agent.state, "⠦");
    const breadcrumb = grouped ? agent.label ?? agent.name : agentBreadcrumb(agent, byId);
    const tokens = agent.accounting ? formatAccounting(agent.accounting) : "";
    const indent = "  ".repeat((grouped ? 2 : 1) + depth);
    const result = [`${indent}${icon} ${breadcrumb} · ${agent.state}${tokens ? ` · ${tokens}` : ""}`];
    if (agent.state === "failed" && agent.attemptDetails?.length) {
      const last = agent.attemptDetails[agent.attemptDetails.length - 1];
      if (last?.error) result.push(`${indent}  error: ${last.error.code}: ${last.error.message}`);
    }
    const activity = !SETTLED_AGENT_STATES.has(agent.state) ? formatAgentActivity(agent, "⠦", PLAIN_WORKFLOW_PROGRESS_STYLES, now) : "";
    if (activity) result.push(`${indent}  ${activity}`);
    return result.join("\n");
  };
  lines.push(...renderGroupedAgents(run.agents, render));
  if (checkpoints.length) { lines.push(""); for (const cp of checkpoints) lines.push(`● checkpoint ${cp.name}: ${cp.prompt}`); }
  return lines.join("\n");
}

export function formatNavigatorRun(loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> }, checkpoints: readonly AwaitingCheckpoint[], worktrees: readonly WorktreeReference[], now = Date.now()): string {
  const { run, snapshot } = loaded;
  const lines = [
    `Workflow: ${run.workflowName}`,
    `Run: ${run.id}`,
    `Status: ${run.state}`,
    `Phase: ${run.phase ?? "(none)"}`,
    `Launch cwd: ${run.cwd}`,
    ...formatCompactBudgetStatus(run),
    `Launch models: ${snapshot.models.join(", ") || "(none)"}`,
    `Settings: concurrency=${String(snapshot.settings.concurrency)}`,
  ];
  const shellActivity = formatShellActivity(run.activeShells, run.activeShellStartedAt, "⠦", PLAIN_WORKFLOW_PROGRESS_STYLES, now);
  if (shellActivity) lines.push(`  ${shellActivity}`);
  if (run.error) lines.push(`Run error: ${run.error.code}: ${run.error.message}`);
  if (run.events?.length) lines.push(...run.events.filter((event) => event.type === "warning").map((event) => `Warning: ${event.message}`));
  const aliases = snapshot.modelAliases ?? snapshot.settings.modelAliases;
  if (aliases && Object.keys(aliases).length) lines.push(`Model aliases: ${Object.entries(aliases).map(([name, target]) => `${name}=${target}`).join(", ")}`);
  if (snapshot.settingsSources) lines.push(`Settings sources: concurrency=${snapshot.settingsSources.concurrency}, modelAliases=${snapshot.settingsSources.modelAliases}, skills=${snapshot.settingsSources.skills ?? "(none)"}, extensions=${snapshot.settingsSources.extensions ?? "(none)"}, tools=${snapshot.settingsSources.tools ?? "(none)"}`);
  lines.push("Agents / ownership:");
  if (!run.agents.length) lines.push("  (none)");
  const byId = new Map(run.agents.map((agent) => [agent.id, agent]));
  lines.push(...renderGroupedAgents(run.agents, ({ agent, index, depth }, grouped) => {
    const model = `${agent.model.provider}/${agent.model.model}${agent.model.thinking ? `:${agent.model.thinking}` : ""}`;
    const role = agent.role ? ` role=${agent.role}` : "";
    const tools = ` tools=${agent.tools.join(",") || "(none)"}`;
    const accounting = agent.accounting ? ` input=${String(agent.accounting.input)} output=${String(agent.accounting.output)} cache-read=${String(agent.accounting.cacheRead)} cache-write=${String(agent.accounting.cacheWrite)} cost=${formatCost(agent.accounting.cost) || "$0.00"}` : "";
    const indent = "  ".repeat((grouped ? 2 : 1) + depth);
    const result = [`${indent}#${String(index + 1)} ${grouped ? agent.label ?? agent.name : agentBreadcrumb(agent, byId)} state=${agent.state} model=${model}${agent.requestedModel ? ` requested=${agent.requestedModel}` : ""}${role}${tools} attempts=${String(agent.attempts)} retries=${String(Math.max(0, agent.attempts - 1))}${accounting}`];
    for (const attempt of agent.attemptDetails ?? []) result.push(`${indent}  attempt ${String(attempt.attempt)}${attempt.error ? ` error=${attempt.error.code}: ${attempt.error.message}` : ""}`);
    for (const call of agent.toolCalls ?? []) result.push(`${indent}  tool ${call.name} state=${call.state}`);
    const activity = !SETTLED_AGENT_STATES.has(agent.state) ? formatAgentActivity(agent, "⠦", PLAIN_WORKFLOW_PROGRESS_STYLES, now) : "";
    if (activity) result.push(`${indent}  ${activity}`);
    return result.join("\n");
  }));
  lines.push("Checkpoints:");
  if (!checkpoints.length) lines.push("  (none)");
  for (const checkpoint of checkpoints) lines.push(`  ${checkpoint.name}: ${checkpoint.prompt} context=${JSON.stringify(checkpoint.context)}`);
  lines.push(`Worktrees: ${String(worktrees.length)}`);
  lines.push(`Agent sessions: ${String(run.agentSessions.length)}`);
  return lines.join("\n");
}
export function formatWorkflowPhaseDashboard(run: PersistedRun, snapshot: Readonly<LaunchSnapshot>, width: number, selection: WorkflowPhaseSelection = {}, styles: WorkflowProgressStyles = PLAIN_WORKFLOW_PROGRESS_STYLES, now = Date.now()): string[] {
  const safeWidth = Math.max(1, width);
  const model = buildWorkflowPhaseModel(run, snapshot);
  const tree = buildWorkflowPhaseTree(model);
  const expanded = selection.expandedNodeIds === undefined ? workflowPhaseTreeInitialExpanded(tree) : new Set(selection.expandedNodeIds);
  const wrap = (text: string, limit = safeWidth): string[] => truncateToVisualLines(text, Number.MAX_SAFE_INTEGER, Math.max(1, limit), 0).visualLines.map((line) => line.trimEnd());
  // ponytail: ANSI-only width, good enough for the ASCII labels the tree renders
  const ansiPattern = new RegExp(ANSI_SGR_SOURCE, "g");
  const visibleLength = (text: string): number => text.replace(ansiPattern, "").length;
  const padTo = (text: string, limit: number): string => `${text}${" ".repeat(Math.max(0, limit - visibleLength(text)))}`;
  const phaseStyle = (state: string): ((text: string) => string) => phaseStyleForState(state, styles);
  const phase = selection.phaseId ? model.phases.find((candidate) => candidate.id === selection.phaseId) : undefined;
  const selectedByAgent = selection.agentId ? tree.nodes.find((node) => node.kind === "agent" && node.agentId === selection.agentId && (!selection.phaseId || node.phaseId === selection.phaseId)) : undefined;
  const selectedNode = (selection.nodeId ? tree.byId.get(selection.nodeId) : undefined) ?? selectedByAgent ?? (phase ? tree.byId.get(workflowPhaseTreePath("phase", phase.id, [])) : undefined) ?? tree.byId.get("workflow") ?? (model.currentPhaseId ? tree.byId.get(workflowPhaseTreePath("phase", model.currentPhaseId, [])) : undefined) ?? tree.nodes[0];
  const selectedPhase = selectedNode?.phase ?? (selectedNode ? model.phases.find((candidate) => candidate.id === selectedNode.phaseId) : undefined);
  const currentPhase = model.currentPhaseIndex === undefined ? undefined : model.phases[model.currentPhaseIndex];
  const visibleNodes = workflowPhaseTreeVisibleNodes(tree, expanded);
  const nodeAgents = (node: WorkflowPhaseTreeNode): AgentRecord[] => {
    const agents: AgentRecord[] = [];
    const visit = (id: string): void => {
      const child = tree.byId.get(id);
      if (!child) return;
      if (child.agent) agents.push(child.agent); else for (const childId of child.children) visit(childId);
    };
    if (node.agent) agents.push(node.agent); else for (const childId of node.children) visit(childId);
    return agents;
  };
  const nodeStatus = (node: WorkflowPhaseTreeNode): string => phaseStyle(node.state)(node.state);
  const nodeIcon = (node: WorkflowPhaseTreeNode): string => node.children.length ? expanded.has(node.id) ? "▾" : "▸" : node.kind === "agent" ? "•" : node.kind === "shell" ? "◇" : " ";
  const treeLine = (node: WorkflowPhaseTreeNode): string => {
    const selected = node.id === selectedNode?.id;
    const state = progressStyleForState(node.state, styles);
    const glyph = node.kind === "agent" && node.agent ? agentStateGlyph(node.agent.state, "⠦") : runStateGlyph(node.state, "⠦");
    return `${selected ? "→" : " "} ${"  ".repeat(node.depth)}${nodeIcon(node)} ${node.label} · ${state(glyph)}`;
  };
  const details = (node: WorkflowPhaseTreeNode | undefined): string[] => {
    if (!node) return [styles.muted("No workflow node is selected"), ...(selection.actions ? [] : [styles.muted("enter run actions")])];
    const agents = nodeAgents(node);
    if (node.kind === "workflow") {
      const counts = phaseAgentCounts(agents);
      return [styles.bold(`Selected workflow: ${run.workflowName}`), `Run ID: ${run.id}`, `Status: ${nodeStatus(node)}`, `agents completed=${String(counts.completed)} running=${String(counts.running)} failed=${String(counts.failed)} cancelled=${String(counts.cancelled)} pending=${String(counts.pending)}`, `Agents: ${String(agents.length)}`, ...(selection.actions ? [] : [styles.muted("enter run actions")])];
    }
    if (node.kind === "phase") {
      const selected = node.phase;
      const counts = selected?.counts ?? phaseAgentCounts(agents);
      const hint = node.children.length ? "enter expand/collapse" : "enter phase details";
      return [styles.bold(`Selected phase: ${node.label}`), `Status: ${nodeStatus(node)}`, `agents completed=${String(counts.completed)} running=${String(counts.running)} failed=${String(counts.failed)} cancelled=${String(counts.cancelled)} pending=${String(counts.pending)}`, `Agents: ${String(agents.length)}`, ...(selection.actions ? [] : [styles.muted(hint)])];
    }
    if (node.kind === "operation") {
      const states = phaseAgentCounts(agents);
      const hint = node.children.length ? "enter expand/collapse" : "enter phase details";
      return [styles.bold(`Selected operation: ${node.operationPath.join(" > ")}`), `Phase: ${node.phase?.name ?? node.phaseId}`, `Status: ${nodeStatus(node)}`, `agents completed=${String(states.completed)} running=${String(states.running)} failed=${String(states.failed)} cancelled=${String(states.cancelled)} pending=${String(states.pending)}`, `Agents: ${String(agents.length)}`, ...(selection.actions ? [] : [styles.muted(hint)])];
    }
    if (node.kind === "shell") {
      return [styles.bold("Selected shell"), formatShellActivity(node.shellActivity?.active, node.shellActivity?.startedAt, "⠦", styles, now) ?? "shell [running]"];
    }
    const agent = node.agent;
    if (!agent) return [styles.muted("Agent details are unavailable")];
    const attemptError = agent.attemptDetails?.at(-1)?.error;
    const detail = formatAgentDetail(attemptError === undefined ? agent : { ...agent, error: attemptError }, styles, now, { includeError: false });
    const errorLine = attemptError === undefined ? undefined : formatAgentError(attemptError, styles);
    return [...detail, ...(selection.actions ? [] : [styles.muted("enter agent actions")]), ...(errorLine === undefined ? [] : [errorLine])];
  };
  const stateNames: readonly WorkflowPhaseState[] = ["not started", "running", "completed", "failed", "cancelled", "interrupted", "budget_exhausted"];
  const statusSummary = stateNames.filter((state) => (model.counts[state] ?? 0) > 0).map((state) => `${String(model.counts[state])} ${state}`).join(" · ") || "0 phases";
  const lines: string[] = [styles.bold(styles.accent(`Workflow: ${run.workflowName}`))];
  if (run.error) lines.push(styles.error(`ERROR ${run.error.code}: ${run.error.message}`));
  const runtime = run.usage ? ` runtime=${formatWorkflowRuntime(run.usage.durationMs)}` : "";
  lines.push(`phase: ${run.phase ?? selectedPhase?.name ?? currentPhase?.name ?? "none"}`, `Run state: ${run.state}${runtime}`, `Phases: ${statusSummary}`);
  for (const event of run.events?.filter((event) => event.type === "warning") ?? []) lines.push(styles.warning(`Warning: ${event.message}`));
  lines.push(...formatCompactBudgetStatus(run));
  const scopedShells = (run.activeShellsByPhase?.length ?? 0) > 0;
  const shellActivity = scopedShells ? undefined : formatShellActivity(run.activeShells, run.activeShellStartedAt, "⠦", styles, now);
  if (shellActivity) lines.push(`  ${shellActivity}`);
  const renderTree = (limit: number): string[] => [styles.bold("Tree"), ...(visibleNodes.length ? visibleNodes.flatMap((node) => wrap(treeLine(node), limit)) : [styles.muted("(empty)")])];
  const actionRows = (): string[] => {
    const actions = selection.actions;
    if (!actions) return [];
    return ["", styles.bold(actions.title), ...actions.options.map((option, index) => `${index === actions.index ? "→ " : "  "}${index === actions.index ? styles.accent(option) : option}`)];
  };
  const detailRows = (): string[] => [...details(selectedNode), ...actionRows()];
  if (safeWidth >= 80) {
    const sidebarWidth = Math.min(42, Math.max(24, Math.floor((safeWidth - 3) * 0.38)));
    const detailWidth = Math.max(1, safeWidth - sidebarWidth - 3);
    const sidebar = renderTree(sidebarWidth).flatMap((line) => wrap(line, sidebarWidth));
    const detail = detailRows().flatMap((line) => wrap(line, detailWidth));
    const rows = Math.max(sidebar.length, detail.length);
    for (let index = 0; index < rows; index += 1) lines.push(`${padTo(sidebar[index] ?? "", sidebarWidth)} | ${detail[index] ?? ""}`);
  } else if (selection.detailsOnly) {
    lines.push(...detailRows().flatMap((line) => wrap(line)));
  } else {
    lines.push(...renderTree(safeWidth));
    if (!selection.treeOnly) lines.push("", ...detailRows().flatMap((line) => wrap(line)));
  }
  if (model.unassignedAgents?.length && !tree.nodes.some((node) => node.phaseId === "unassigned")) lines.push(...wrap(styles.muted(`Unassigned agents: ${String(model.unassignedAgents.length)}`)));
  return lines.flatMap((line) => wrap(line));
}
export function formatCheckpointReview(checkpoint: AwaitingCheckpoint): string {
  const context = JSON.stringify(checkpoint.context, null, 2);
  return [`Name: ${checkpoint.name}`, "Prompt:", checkpoint.prompt, context === "null" ? "Context: null" : "Context:", ...(context === "null" ? [] : [context])].join("\n");
}
