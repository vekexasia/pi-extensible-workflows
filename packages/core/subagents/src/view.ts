import type { AgentToolResult, ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { formatCost, formatStalledDuration, formatWorkflowRuntime, sanitizeDisplayText, WORKFLOW_AGENT_STALL_THRESHOLD_MS } from "../../src/index.js";
import { agentActivityLabel, stalledDuration, textBlock } from "../../src/host-view.js";
import { drawFrame, formatElapsed, formatTokens, mark, QUIET_MS, REPAINT_MS, type Paint } from "../../src/background-widget.js";
import type { SubagentRunRequest, SubagentStatus } from "./contracts.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const TERMINAL_STATES = new Set<SubagentStatus["state"]>(["completed", "failed", "stopped"]);
const MAX_INSPECT_VALUE_CHARS = 4000;
const MAX_INSPECT_TOOL_CALLS = 32;
const MAX_BACKGROUND_WIDGET_ROWS = 10;
type SubagentRenderArgs = Partial<SubagentRunRequest> & { id?: string };

type ProgressComponent = ReturnType<typeof subagentProgressBlock>;
export type SubagentRenderState = {
  subagentSpinner?: ReturnType<typeof setInterval>;
  subagentStatus?: SubagentStatus;
  subagentProgressComponent?: ProgressComponent;
  subagentProgressFrozenAt?: number;
};

function roleName(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const name = (value as Record<string, unknown>).name;
  return typeof name === "string" ? name.trim() || undefined : undefined;
}

function modeName(value: unknown): "background" | "foreground" | undefined {
  return value === "background" || value === "foreground" ? value : undefined;
}

function requestMetadata(args: SubagentRenderArgs, metadataAvailable: boolean): string {
  const mode = modeName(args.mode) ?? (metadataAvailable ? "background" : undefined);
  const role = metadataAvailable ? roleName(args.role) ?? "none" : undefined;
  return [mode === undefined ? undefined : `mode=${mode}`, role === undefined ? undefined : `role=${role}`].filter((value): value is string => value !== undefined).join(" ");
}

function label(args: SubagentRenderArgs): string {
  if (typeof args.label === "string" && args.label.trim()) return args.label.trim();
  const role = roleName(args.role);
  if (role) return role;
  if (typeof args.id === "string" && args.id) return args.id.slice(0, 8);
  return "subagent";
}

export function formatSubagentPreview(args: Partial<SubagentRunRequest>): string {
  return `subagent ${label(args)} ${requestMetadata(args, true)}`;
}

export function renderSubagentCall(args: Partial<SubagentRunRequest>, context?: { state?: SubagentRenderState; isError?: boolean }) {
  const preview = formatSubagentPreview(args);
  return {
    render(width: number): string[] {
      if (context?.state?.subagentStatus && !context.isError) return [];
      return [truncateToWidth(preview, Math.max(1, width), "…")];
    },
    invalidate() {},
  };
}

function statusValue(value: unknown): SubagentStatus | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || (record.state !== "running" && record.state !== "completed" && record.state !== "failed" && record.state !== "stopped")) return undefined;
  return value as SubagentStatus;
}

function stateGlyph(state: SubagentStatus["state"], spinner: string): string {
  if (state === "running") return spinner;
  return state === "completed" ? "✓" : "✗";
}

function stateColor(state: SubagentStatus["state"]): "accent" | "success" | "error" {
  if (state === "running") return "accent";
  return state === "completed" ? "success" : "error";
}

/** Tokens and cost as the workflow header shows them. */
function usageStats(status: SubagentStatus): string {
  const value = status.progress?.accounting;
  return value ? [formatTokens(value.input + value.output), formatCost(value.cost)].filter(Boolean).join(" · ") : "";
}
function modelName(status: SubagentStatus): string {
  const model = status.progress?.state?.model ?? status.attemptDetails?.at(-1)?.setup.model;
  return model ? `${model.model}${model.thinking ? `:${model.thinking}` : ""}` : "";
}

function timestamp(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function boundedValue(value: unknown): string {
  let text: string;
  try {
    const serialized: unknown = JSON.stringify(value, null, 2);
    text = typeof serialized === "string" ? serialized : String(value);
  } catch {
    text = String(value);
  }
  return text.length > MAX_INSPECT_VALUE_CHARS ? `${text.slice(0, MAX_INSPECT_VALUE_CHARS)}…` : text;
}

function formatSubagentProgress(status: SubagentStatus, args: SubagentRenderArgs, theme: Theme, spinner: string, now: number, expanded: boolean): string {
  const color = stateColor(status.state);
  const elapsed = status.startedAt === undefined ? "" : formatWorkflowRuntime((status.finishedAt ?? now) - status.startedAt);
  const metadata = requestMetadata(args, args.id === undefined);
  const stats = usageStats(status);
  const lines = [
    `${theme.fg(color, stateGlyph(status.state, spinner))} ${theme.bold(theme.fg("accent", `Subagent: ${label({ ...args, id: status.id })}`))} ${theme.fg(color, `[${status.state}]`)}${metadata ? ` ${theme.fg("dim", metadata)}` : ""}${stats ? ` ${stats}` : ""}${elapsed ? ` runtime=${elapsed}` : ""}`,
  ];
  const current = status.state === "running" ? agentActivityLabel(status.progress ?? {}) : undefined;
  const stalled = stalledDuration({ ...status.progress, state: status.state }, now);
  if (current) lines.push(`  ${theme.fg("accent", spinner)} ${theme.fg("dim", current)}${stalled === undefined ? "" : ` ${theme.fg("warning", `- stalled? ${formatStalledDuration(stalled)}`)}`}`);
  else if (stalled !== undefined) lines.push(`  ${theme.fg("warning", `stalled? ${formatStalledDuration(stalled)}`)}`);
  if (status.error) lines.push(`  ${theme.fg("error", `${status.error.code}: ${status.error.message}`)}`);
  if (expanded) {
    lines.push(`  ${theme.fg("dim", `id=${status.id}`)}`);
    const model = status.progress?.state?.model;
    if (model) lines.push(`  ${theme.fg("dim", `model=${model.provider}/${model.model}${model.thinking ? `:${model.thinking}` : ""}`)}`);
    if (status.worktree) lines.push(`  ${theme.fg("dim", `worktree=${status.worktree.path} branch=${status.worktree.branch}`)}`);
  }
  return lines.join("\n");
}

function formatSubagentLaunch(status: SubagentStatus, args: SubagentRenderArgs, theme: Theme, expanded: boolean): string {
  const metadata = requestMetadata(args, args.id === undefined);
  const lines = [
    `${theme.fg("success", "✓")} ${theme.bold(theme.fg("accent", `Subagent: ${label({ ...args, id: status.id })}`))} ${theme.fg("success", "[launched]")}${metadata ? ` ${theme.fg("dim", metadata)}` : ""}`,
  ];
  if (expanded) lines.push(`  ${theme.fg("dim", `id=${status.id}`)}`);
  return lines.join("\n");
}

function formatSubagentInspection(status: SubagentStatus, args: { id?: string }, details: unknown, theme: Theme, expanded: boolean): string {
  const lines = [formatSubagentProgress(status, { id: args.id ?? status.id }, theme, "◇", Date.now(), false)];
  if (!expanded) return lines[0] ?? "";
  lines.push(`  ${theme.fg("dim", `id=${status.id}`)}`);
  const startedAt = timestamp(status.startedAt);
  const finishedAt = timestamp(status.finishedAt);
  const lastEventAt = timestamp(status.progress?.lastEventAt);
  if (startedAt) lines.push(`  ${theme.fg("dim", `startedAt=${startedAt}`)}`);
  if (finishedAt) lines.push(`  ${theme.fg("dim", `finishedAt=${finishedAt}`)}`);
  if (lastEventAt) lines.push(`  ${theme.fg("dim", `lastEventAt=${lastEventAt}`)}`);
  const model = status.progress?.state?.model;
  if (model) lines.push(`  ${theme.fg("dim", `model=${model.provider}/${model.model}${model.thinking ? `:${model.thinking}` : ""}`)}`);
  const currentActivity = status.progress?.activity;
  if (currentActivity) lines.push(`  ${theme.fg("dim", `activity=${currentActivity.kind}${currentActivity.text ? ` ${sanitizeDisplayText(currentActivity.text)}` : ""}`)}`);
  const accounting = status.progress?.accounting;
  if (accounting) lines.push(`  ${theme.fg("dim", `accounting=input=${String(accounting.input)} output=${String(accounting.output)} cacheRead=${String(accounting.cacheRead)} cacheWrite=${String(accounting.cacheWrite)} cost=${formatCost(accounting.cost) || "$0.00"}`)}`);
  if (status.worktree) lines.push(`  ${theme.fg("dim", `worktree=${status.worktree.path} branch=${status.worktree.branch}`)}`);
  const toolCalls = status.progress?.toolCalls;
  if (toolCalls?.length) {
    lines.push(`  ${theme.fg("dim", `toolCalls=${String(toolCalls.length)}`)}`);
    for (const call of toolCalls.slice(-MAX_INSPECT_TOOL_CALLS)) lines.push(`    ${theme.fg("dim", `${call.name} [${call.state}]`)}`);
  }
  const record = typeof details === "object" && details !== null && !Array.isArray(details) ? details as Record<string, unknown> : undefined;
  if (record && Object.prototype.hasOwnProperty.call(record, "value")) {
    lines.push(`  ${theme.fg("dim", "value:")}`);
    for (const line of boundedValue(record.value).split("\n")) lines.push(`    ${line}`);
  }
  return lines.join("\n");
}

export function subagentProgressBlock(status: SubagentStatus, args: SubagentRenderArgs, theme: Theme, freezeAt?: number) {
  let current = status;
  let currentTheme = theme;
  let expanded = false;
  let frozenAt = freezeAt ?? Date.now();
  return {
    id: status.id,
    update(next: SubagentStatus, nextTheme: Theme, nextFreezeAt?: number) {
      current = next;
      currentTheme = nextTheme;
      if (nextFreezeAt !== undefined) frozenAt = nextFreezeAt;
    },
    setExpanded(value: boolean) { expanded = value; },
    render(width: number): string[] {
      const now = TERMINAL_STATES.has(current.state) ? frozenAt : Date.now();
      if (!TERMINAL_STATES.has(current.state)) frozenAt = now;
      const frame = SPINNER[Math.floor(now / REPAINT_MS) % SPINNER.length] ?? "◇";
      return formatSubagentProgress(current, args, currentTheme, frame, now, expanded).split("\n").map((line) => truncateToWidth(line, Math.max(1, width), "…"));
    },
    invalidate() {},
  };
}

function resultText(result: AgentToolResult<unknown>): string {
  return result.content.filter(({ type }) => type === "text").map((content) => content.type === "text" ? content.text : "").join("\n");
}

export function renderSubagentResult(result: AgentToolResult<unknown>, options: { isPartial: boolean; expanded: boolean }, theme: Theme, context: { args: SubagentRenderArgs; state: SubagentRenderState; invalidate(): void; isError?: boolean }) {
  const incoming = statusValue(result.details);
  const state = context.state;
  if (incoming) state.subagentStatus = state.subagentStatus?.id === incoming.id ? { ...state.subagentStatus, ...incoming } : incoming;
  const status = state.subagentStatus;

  if (status?.state === "running" && options.isPartial && !state.subagentSpinner) {
    state.subagentSpinner = setInterval(() => { context.invalidate(); }, REPAINT_MS);
    state.subagentSpinner.unref();
  } else if ((!options.isPartial || status?.state !== "running") && state.subagentSpinner) {
    clearInterval(state.subagentSpinner);
    delete state.subagentSpinner;
  }

  if (!status || context.isError) return textBlock(resultText(result));
  if (!options.isPartial && status.state === "running") return textBlock(formatSubagentLaunch(status, context.args, theme, options.expanded));
  if (TERMINAL_STATES.has(status.state)) state.subagentProgressFrozenAt ??= Date.now();
  else delete state.subagentProgressFrozenAt;
  let component = state.subagentProgressComponent;
  if (!component || component.id !== status.id) {
    component = subagentProgressBlock(status, context.args, theme, state.subagentProgressFrozenAt);
    state.subagentProgressComponent = component;
  } else {
    component.update(status, theme, state.subagentProgressFrozenAt);
  }
  component.setExpanded(options.expanded);
  return component;
}

type WidgetRun = { status: Readonly<SubagentStatus>; request: Readonly<SubagentRunRequest> };

/** One run as a workflow agent row: a quiet or stalled warning on the left, model and figures against the right rule. */
function widgetRow({ status, request }: WidgetRun, now: number, paint: Paint): { text: string; right: string } {
  const lastEventAt = status.progress?.lastEventAt;
  const silent = lastEventAt === undefined || !Number.isFinite(lastEventAt) || now - lastEventAt < QUIET_MS ? undefined : now - lastEventAt;
  const role = silent !== undefined && silent >= WORKFLOW_AGENT_STALL_THRESHOLD_MS ? "error" : "warning";
  const icon = silent === undefined ? mark(status.state, now, paint) : paint(role, "⚠");
  const warning = silent === undefined ? "" : `  ${paint(role, `${role === "error" ? "stalled" : "quiet"} ${formatElapsed(silent)}`)}`;
  const accounting = status.progress?.accounting;
  const attempts = status.attempts ?? 1;
  const right = [
    modelName(status),
    formatTokens(accounting === undefined ? undefined : accounting.input + accounting.output),
    formatCost(accounting?.cost),
    status.startedAt === undefined ? "" : formatElapsed(now - status.startedAt),
    attempts > 1 ? `attempt ${String(attempts)}` : "",
  ].filter(Boolean).join(" · ");
  return { text: `${icon} ${sanitizeDisplayText(label({ ...request, id: status.id }))}${warning}`, right };
}

const RECEIPT_ENTRY_TYPE = "piewf-subagent-receipt";
type SubagentReceipt = { readonly id: string; readonly label: string; readonly state: string; readonly model?: string; readonly role?: string; readonly tools?: readonly string[]; readonly input: number; readonly output: number; readonly cacheRead: number; readonly costUsd: number; readonly durationMs: number; readonly attempts: number; readonly error?: string };

function receiptFor(status: Readonly<SubagentStatus>, request: Readonly<SubagentRunRequest>): SubagentReceipt {
  const accounting = status.progress?.accounting;
  const model = modelName(status);
  const role = roleName(request.role);
  const tools = status.progress?.state?.tools ?? status.attemptDetails?.at(-1)?.setup.tools;
  return {
    id: status.id,
    label: label({ ...request, id: status.id }),
    state: status.state,
    ...(model ? { model } : {}),
    ...(role === undefined ? {} : { role }),
    ...(tools === undefined ? {} : { tools: [...tools] }),
    input: accounting?.input ?? 0,
    output: accounting?.output ?? 0,
    cacheRead: accounting?.cacheRead ?? 0,
    costUsd: accounting?.cost ?? 0,
    durationMs: status.startedAt === undefined ? 0 : Math.max(0, (status.finishedAt ?? Date.now()) - status.startedAt),
    attempts: status.attempts ?? 1,
    ...(status.error === undefined ? {} : { error: `${status.error.code}: ${status.error.message}` }),
  };
}

/** The transcript line a finished background run leaves behind, in the shape of the workflow receipt. */
export function renderSubagentReceipt(data: SubagentReceipt, expanded: boolean, theme: Theme): string[] {
  const glyph = data.state === "completed" ? theme.fg("success", "✓") : data.state === "failed" ? theme.fg("error", "✗") : theme.fg("muted", "·");
  const headline = [formatTokens(data.input + data.output), formatCost(data.costUsd) || "$0.00", formatElapsed(data.durationMs), data.state].filter(Boolean).join(" · ");
  const lines = [`${glyph} ${theme.bold(sanitizeDisplayText(data.label))} ${theme.fg("muted", headline)}`];
  if (!expanded) return lines;
  const meta = [data.model ?? "", data.role ? `role ${data.role}` : "", data.attempts > 1 ? `${String(data.attempts)} attempts` : "", data.tools?.join(" ") ?? ""].filter(Boolean);
  if (meta.length > 0) lines.push(theme.fg("muted", `   ${meta.join(" · ")}`));
  const split = [data.input ? `in ${formatTokens(data.input)}` : "", data.output ? `out ${formatTokens(data.output)}` : "", data.cacheRead ? `cache ${formatTokens(data.cacheRead)}` : ""].filter(Boolean);
  if (split.length > 0) lines.push(theme.fg("muted", `   ${split.join(" · ")}`));
  if (data.error !== undefined) lines.push(theme.fg("error", `   ${sanitizeDisplayText(data.error)}`));
  lines.push(theme.fg("muted", `   run ${data.id}`));
  return lines;
}

type ReceiptHost = { appendEntry?: (customType: string, data: SubagentReceipt) => void; registerEntryRenderer?: ExtensionAPI["registerEntryRenderer"] };

export function createSubagentBackgroundWidget(host: ReceiptHost = {}) {
  const key = "piewf-subagents-background";
  const runs = new Map<string, WidgetRun>();
  const receipted = new Set<string>();
  host.registerEntryRenderer?.<SubagentReceipt>(RECEIPT_ENTRY_TYPE, (entry, options, theme) => {
    if (!entry.data) return undefined;
    const lines = renderSubagentReceipt(entry.data, options.expanded, theme);
    // Pi treats an over-wide line as fatal, and an error message has no bound.
    return { render: (width: number): string[] => lines.map((line) => truncateToWidth(line, Math.max(1, width), "…")), invalidate() {} };
  });
  let context: ExtensionContext | undefined;
  let requestRender: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let showing = false;

  const hide = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
    requestRender = undefined;
    if (showing) {
      try { context?.ui.setWidget(key, undefined); } catch { /* The session UI may already be closing. */ }
    }
    showing = false;
  };
  const paint = (): void => {
    if (context?.mode !== "tui" || runs.size === 0) {
      hide();
      return;
    }
    if (showing) {
      requestRender?.();
      return;
    }
    try {
      context.ui.setWidget(key, (tui, theme) => {
        requestRender = () => { tui.requestRender(); };
        return {
          render(width: number): string[] {
            const now = Date.now();
            const paintRole: Paint = (role, text) => theme.fg(role, text);
            // One row per run, so the default concurrency of eight fills the frame exactly.
            // ponytail: no Alt+O scrolling as in the workflow widget; add it if runs routinely exceed the frame.
            const budget = MAX_BACKGROUND_WIDGET_ROWS - 2;
            const rows = [...runs.values()].map((run) => widgetRow(run, now, paintRole));
            const body = rows.length <= budget ? rows : [...rows.slice(0, budget - 1), { text: theme.fg("muted", `… ${String(rows.length - budget + 1)} more`) }];
            const title = runs.size === 1 ? "Subagent" : `Subagents · ${String(runs.size)} runs`;
            return drawFrame(title, "", body, width, paintRole, (text) => theme.fg("accent", text)).map((line) => truncateToWidth(line, Math.max(1, width), ""));
          },
          invalidate() {},
        };
      }, { placement: "belowEditor" });
      showing = true;
      timer = setInterval(() => { requestRender?.(); }, REPAINT_MS);
      timer.unref();
    } catch {
      hide();
    }
  };

  return {
    start(next: ExtensionContext): void {
      hide();
      runs.clear();
      receipted.clear();
      context = next.mode === "tui" ? next : undefined;
    },
    update(status: Readonly<SubagentStatus>, request: Readonly<SubagentRunRequest>): void {
      if (request.mode !== "background" || context === undefined) return;
      if (TERMINAL_STATES.has(status.state)) {
        runs.delete(status.id);
        // A foreground run already has its tool block; a background one leaves a receipt, once, like a workflow run.
        if (!receipted.has(status.id)) {
          receipted.add(status.id);
          try { host.appendEntry?.(RECEIPT_ENTRY_TYPE, receiptFor(status, request)); } catch { /* A receipt is display-only. */ }
        }
      } else runs.set(status.id, { status, request });
      paint();
    },
    dispose(): void {
      hide();
      runs.clear();
      context = undefined;
    },
  };
}


export function renderSubagentInspectCall(args: { id?: string }, theme: Theme) {
  const title = theme.fg("toolTitle", theme.bold("subagents_inspect"));
  return textBlock(args.id ? `${title} ${theme.fg("accent", args.id)}` : `${title} ${theme.fg("muted", "all")}`);
}

export function renderSubagentInspectResult(result: AgentToolResult<unknown>, options: { expanded: boolean }, theme: Theme, args: { id?: string }) {
  const status = statusValue(result.details);
  if (status) return textBlock(formatSubagentInspection(status, args, result.details, theme, options.expanded));
  if (Array.isArray(result.details)) {
    const statuses = result.details.map(statusValue).filter((value): value is SubagentStatus => value !== undefined);
    const lines = [theme.bold(theme.fg("accent", `Subagents (${String(statuses.length)})`)), ...statuses.map((entry) => {
      const color = stateColor(entry.state);
      return `  ${theme.fg(color, stateGlyph(entry.state, "◇"))} ${entry.id.slice(0, 8)} ${theme.fg(color, `[${entry.state}]`)}`;
    })];
    return textBlock(lines.join("\n"));
  }
  return textBlock(resultText(result));
}

export function renderSubagentControlCall(name: string, args: { id: string; message?: string }, theme: Theme) {
  const title = theme.fg("toolTitle", theme.bold(name));
  const message = args.message ? ` ${theme.fg("dim", args.message)}` : "";
  return textBlock(`${title} ${theme.fg("accent", args.id)}${message}`);
}

export function renderSubagentControlResult(result: AgentToolResult<unknown>, theme: Theme) {
  const status = statusValue(result.details);
  if (status) {
    const color = stateColor(status.state);
    return textBlock(`${theme.fg(color, stateGlyph(status.state, "◇"))} ${status.id.slice(0, 8)} ${theme.fg(color, `[${status.state}]`)}`);
  }
  const record = typeof result.details === "object" && result.details !== null && !Array.isArray(result.details) ? result.details as Record<string, unknown> : undefined;
  if (record && typeof record.id === "string") return textBlock(`${theme.fg("success", "✓")} ${record.id.slice(0, 8)}`);
  return textBlock(resultText(result));
}
