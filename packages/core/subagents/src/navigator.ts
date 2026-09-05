import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { copyToClipboard, getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionCommandContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Editor, truncateToWidth, type EditorTheme } from "@earendil-works/pi-tui";
import { agentActionLabels, deepFreeze, errorText, formatAgentDetail, jsonValue, loadingRegistry, navigatorAttentionSortByState, openWorkflowArtifact, themeWorkflowProgressStyles, visibleStandaloneAgentAttemptActions, workflowPromptArtifact, workflowResultArtifact, type AgentAttemptSummary, type AgentDetailPresentation, type StandaloneAgentAttemptActionContext, type WorkflowArtifact } from "../../src/index.js";
import { normalizeSubagentRunRequest, type SubagentManager, type SubagentManagerContext, type SubagentProgress, type SubagentRunRequest, type SubagentStatus } from "./contracts.js";
import { attemptValue, statusValue } from "./decode.js";
const MAX_DETAIL_TEXT = 4000;
const MAX_DETAIL_TOOL_CALLS = 32;

type NavigatorEntry = {
  readonly status: SubagentStatus;
  readonly request?: SubagentRunRequest;
  readonly requestError?: string;
};
type Inspection = { readonly entry: NavigatorEntry; readonly record: Record<string, unknown> };

type RegisterCommand = ExtensionAPI["registerCommand"];

function objectValue(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function isFileNotFound(error: unknown): boolean { return objectValue(error)?.code === "ENOENT"; }
function safeRunId(id: string): boolean { return id !== "." && id !== ".." && /^[A-Za-z0-9._-]+$/.test(id); }

function inspectionValue(value: unknown): { status: SubagentStatus; record: Record<string, unknown> } | undefined {
  const record = objectValue(value);
  const status = statusValue(value);
  return record && status ? { status, record } : undefined;
}

function managerContext(context: ExtensionCommandContext, waitForForeground = true, includeAttemptMetadata = false): SubagentManagerContext {
  return { toolCallId: "subagents-command", signal: undefined, onUpdate: undefined, ...(waitForForeground ? {} : { waitForForeground: false }), ...(includeAttemptMetadata ? { includeAttemptMetadata: true } : {}), extensionContext: context };
}

async function loadRequest(storageDirectory: string, id: string): Promise<{ request?: SubagentRunRequest; error?: string }> {
  if (!safeRunId(id)) return {};
  try {
    const value: unknown = JSON.parse(await readFile(join(storageDirectory, id, "request.json"), "utf8"));
    return { request: normalizeSubagentRunRequest(value) };
  } catch (error) {
    if (isFileNotFound(error)) return {};
    return { error: errorText(error) };
  }
}

const ATTENTION_ORDER: Readonly<Record<SubagentStatus["state"], number>> = { running: 0, failed: 1, stopped: 2, completed: 3 };
function attentionSort(entries: readonly NavigatorEntry[]): NavigatorEntry[] {
  return navigatorAttentionSortByState(entries, (entry) => entry.status.state, (entry) => entry.status.finishedAt, ATTENTION_ORDER);
}

async function loadEntries(manager: SubagentManager, storageDirectory: string, context: ExtensionCommandContext): Promise<NavigatorEntry[]> {
  const value = await manager.inspect({}, managerContext(context));
  if (!Array.isArray(value)) return [];
  const entries: NavigatorEntry[] = [];
  const sessionId = context.sessionManager.getSessionId();
  for (const candidate of value) {
    const status = statusValue(candidate);
    if (!status || status.sessionId !== sessionId) continue;
    const request = await loadRequest(storageDirectory, status.id);
    entries.push({ status, ...(request.request === undefined ? {} : { request: request.request }), ...(request.error === undefined ? {} : { requestError: request.error }) });
  }
  return attentionSort(entries);
}

async function inspectEntry(manager: SubagentManager, storageDirectory: string, entry: NavigatorEntry, context: ExtensionCommandContext): Promise<Inspection> {
  const inspected = inspectionValue(await manager.inspect({ id: entry.status.id }, managerContext(context, true, true)));
  if (!inspected) throw new Error(`Subagent ${entry.status.id} returned an invalid inspection`);
  const request = await loadRequest(storageDirectory, entry.status.id);
  return {
    record: inspected.record,
    entry: { status: inspected.status, ...(request.request === undefined ? {} : { request: request.request }), ...(request.error === undefined ? {} : { requestError: request.error }) },
  };
}

function requestLabel(request: SubagentRunRequest | undefined): string { return request?.label?.trim() || "none"; }
function requestRole(request: SubagentRunRequest | undefined): string {
  const role: unknown = request?.role;
  if (typeof role === "string" && role.trim()) return role.trim();
  const override = objectValue(role);
  return typeof override?.name === "string" && override.name.trim() ? override.name.trim() : "none";
}
function shortId(id: string): string { return id.length > 12 ? id.slice(0, 8) : id; }
function pickerLabel(entry: NavigatorEntry, index: number): string { return `${String(index + 1)}. label=${boundedText(requestLabel(entry.request), 256)} role=${boundedText(requestRole(entry.request), 256)} [${entry.status.state}] ${shortId(entry.status.id)}`; }
function boundedText(value: unknown, limit = MAX_DETAIL_TEXT): string {
  const text = typeof value === "string" ? value : (() => { try { const serialized: unknown = JSON.stringify(value); return typeof serialized === "string" ? serialized : String(value); } catch { return String(value); } })();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
function timestamp(value: unknown): string | undefined { return typeof value === "number" && Number.isFinite(value) ? new Date(value).toISOString() : undefined; }

function appendValue(lines: string[], title: string, value: unknown): void {
  lines.push(`${title}:`);
  for (const line of boundedText(value).split("\n")) lines.push(`  ${line}`);
}

function latestAttempt(status: SubagentStatus): AgentAttemptSummary | undefined {
  return [...(status.attemptDetails ?? [])].sort((left, right) => right.attempt - left.attempt)[0];
}
function usageAccounting(status: SubagentStatus): SubagentProgress["accounting"] | undefined {
  return status.progress?.accounting;
}
function detailPresentation(inspection: Inspection): AgentDetailPresentation {
  const { status, request } = inspection.entry;
  const attempt = latestAttempt(status);
  const state = status.progress?.state;
  const activity = status.progress?.activity;
  const model = state?.model ?? attempt?.setup.model;
  const tools = state?.tools ?? attempt?.setup.tools;
  const lastEventAt = status.progress?.lastEventAt;
  const attempts = status.attempts ?? attempt?.attempt;
  const accounting = usageAccounting(status);
  const role = requestRole(request);
  const error = status.error ?? attempt?.error;
  return {
    state: status.state,
    ...(activity === undefined ? {} : { activity: { kind: activity.kind, text: boundedText(activity.text) } }),
    ...(lastEventAt === undefined ? {} : { lastEventAt }),
    ...(model === undefined ? {} : { model: { provider: boundedText(model.provider, 256), model: boundedText(model.model, 256), ...(model.thinking === undefined ? {} : { thinking: model.thinking }) } }),
    ...(role === "none" ? {} : { role: boundedText(role, 256) }),
    ...(tools === undefined ? {} : { tools: tools.slice(0, 256).map((tool) => boundedText(tool, 256)) }),
    ...(attempts === undefined ? {} : { attempts }),
    ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt }),
    ...(status.finishedAt === undefined ? {} : { finishedAt: status.finishedAt }),
    ...(accounting === undefined ? {} : { accounting }),
    ...(error === undefined ? {} : { error: { code: boundedText(error.code, 256), message: boundedText(error.message) } }),
  };
}
function detailLines(inspection: Inspection, theme?: Theme): string[] {
  const { entry, record } = inspection;
  const { status, request } = entry;
  const styles = theme === undefined ? undefined : themeWorkflowProgressStyles(theme);
  const lines = [
    theme?.bold(theme.fg("accent", `Subagent ${boundedText(status.id, 256)}`)) ?? `Subagent ${boundedText(status.id, 256)}`,
    `label=${boundedText(requestLabel(request), 256)} role=${boundedText(requestRole(request), 256)}`,
    ...formatAgentDetail(detailPresentation(inspection), styles, status.finishedAt ?? Date.now()),
  ];
  const startedAt = timestamp(status.startedAt);
  const finishedAt = timestamp(status.finishedAt);
  if (startedAt) lines.push(`startedAt=${startedAt}`);
  if (finishedAt) lines.push(`finishedAt=${finishedAt}`);
  if (request?.prompt) appendValue(lines, "prompt", request.prompt);
  if (entry.requestError) lines.push(`request=unavailable: ${boundedText(entry.requestError)}`);
  if (status.worktree) lines.push(`worktree=${boundedText(status.worktree.path)} branch=${boundedText(status.worktree.branch)}`);
  const toolCalls = status.progress?.toolCalls;
  if (toolCalls?.length) {
    lines.push(`toolCalls=${String(toolCalls.length)}`);
    for (const call of toolCalls.slice(-MAX_DETAIL_TOOL_CALLS)) lines.push(`  ${boundedText(call.name, 256)} [${call.state}]`);
  }
  if (Object.prototype.hasOwnProperty.call(record, "value")) appendValue(lines, "value", record.value);
  return lines;
}

function tuiRows(tui: { terminal?: { rows?: number } }): number { return typeof tui.terminal?.rows === "number" && Number.isFinite(tui.terminal.rows) ? tui.terminal.rows : 24; }
function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  const value: unknown = timer;
  if (typeof value !== "object" || value === null || !("unref" in value) || typeof value.unref !== "function") return;
  Reflect.apply(value.unref, value, []);
}

type NavigatorTui = Parameters<typeof openWorkflowArtifact>[0];
type DetailResult = { readonly kind: "steer"; readonly message: string } | "retry" | undefined;
function standaloneActionContext(manager: SubagentManager, inspection: Inspection, context: ExtensionCommandContext): StandaloneAgentAttemptActionContext | undefined {
  const status = inspection.entry.status;
  const request = inspection.entry.request;
  const liveData = manager.getAttemptActionData?.(status.id);
  const attempt = attemptValue(liveData?.attempt) ?? latestAttempt(status);
  if (!attempt) return undefined;
  const session = attempt.session;
  const live = liveData?.liveSession && session && liveData.liveSession.reference.transport === session.transport && liveData.liveSession.reference.sessionId === session.sessionId ? liveData.liveSession : undefined;
  const label = request?.label?.trim();
  const role = requestRole(request);
  const name = label || (role === "none" ? "subagent" : role);
  const ui = {
    notify: (message: string, level: "info" | "warning" | "error" = "info") => { context.ui.notify(message, level); },
    confirm: (title: string, message: string) => context.ui.confirm(title, message),
    select: (title: string, options: readonly string[]) => context.ui.select(title, [...options]),
    input: (title: string, placeholder?: string) => context.ui.input(title, placeholder),
    setWorkingMessage: (message?: string) => { context.ui.setWorkingMessage(message); },
  };
  const actionAttempt = deepFreeze(attempt);
  const actionAgent = deepFreeze({ id: status.id, name, state: status.state, ...(label === undefined ? {} : { label }) });
  return {
    agent: actionAgent,
    attempt: actionAttempt,
    ...(actionAttempt.session === undefined ? {} : { session: actionAttempt.session }),
    ...(live === undefined ? {} : { liveSession: live, ...(liveData?.prepared === undefined ? {} : { prepared: liveData.prepared }), ...(liveData?.handoff === undefined ? {} : { handoff: liveData.handoff }) }),
    signal: liveData?.signal ?? new AbortController().signal,
    ui: Object.freeze(ui),
  };
}
function liveSystemPrompt(manager: SubagentManager, status: SubagentStatus): string | undefined {
  return manager.getAttemptActionData?.(status.id)?.prepared?.systemPrompt;
}
function actionOptions(manager: SubagentManager, inspection: Inspection, context: ExtensionCommandContext): string[] {
  const actionContext = standaloneActionContext(manager, inspection, context);
  const extensionLabels = actionContext === undefined ? [] : visibleStandaloneAgentAttemptActions(loadingRegistry().agentAttemptActions(), actionContext).map(([, action]) => action.label);
  const value = inspection.record.value;
  return agentActionLabels({
    extensionLabels,
    hasWorktree: inspection.entry.status.worktree !== undefined,
    openPrompt: context.mode === "tui" && inspection.entry.request?.prompt !== undefined,
    openSystemPrompt: context.mode === "tui" && liveSystemPrompt(manager, inspection.entry.status) !== undefined,
    openResult: context.mode === "tui" && Object.prototype.hasOwnProperty.call(inspection.record, "value") && jsonValue(value),
    standaloneState: inspection.entry.status.state,
  });
}
function retryResult(value: unknown): { readonly id: string; readonly state: "running" } | undefined {
  const record = objectValue(value);
  return record && typeof record.id === "string" && record.id.trim() && record.state === "running" ? { id: record.id, state: "running" } : undefined;
}
async function openNavigatorArtifact(context: ExtensionCommandContext, tui: NavigatorTui, artifact: WorkflowArtifact, label: string): Promise<void> {
  const command = SettingsManager.create(context.cwd, getAgentDir(), { projectTrusted: context.isProjectTrusted() }).getExternalEditorCommand();
  if (!command) { context.ui.notify(`Cannot open ${label}: no external editor is configured.`, "warning"); return; }
  const exitCode = await openWorkflowArtifact(tui, command, artifact);
  if (exitCode !== 0) context.ui.notify(`Cannot open ${label}: external editor ${exitCode === null ? "could not be started" : `exited with code ${String(exitCode)}`}.`, "warning");
}
async function steerSubagent(manager: SubagentManager, storageDirectory: string, entry: NavigatorEntry, context: ExtensionCommandContext, message: string): Promise<void> {
  const current = await inspectEntry(manager, storageDirectory, entry, context);
  if (current.entry.status.state !== "running") throw new Error(`Subagent ${entry.status.id} is no longer running`);
  await manager.steer({ id: entry.status.id, message }, managerContext(context));
  context.ui.notify(`Steered subagent ${entry.status.id}.`, "info");
}
async function performAction(manager: SubagentManager, storageDirectory: string, entry: NavigatorEntry, action: string, context: ExtensionCommandContext, tui: NavigatorTui | undefined, clipboard: (value: string) => Promise<void>): Promise<"stay" | "retry"> {
  const fresh = await inspectEntry(manager, storageDirectory, entry, context);
  const available = actionOptions(manager, fresh, context);
  if (!available.includes(action)) throw new Error(`Action ${action} is no longer available`);
  const actionContext = standaloneActionContext(manager, fresh, context);
  const registered = actionContext === undefined ? undefined : visibleStandaloneAgentAttemptActions(loadingRegistry().agentAttemptActions(), actionContext).find(([, candidate]) => candidate.label === action);
  if (registered) {
    if (!actionContext || registered[1].runStandalone === undefined) throw new Error(`Action ${action} has no standalone implementation`);
    await registered[1].runStandalone(actionContext);
    return "stay";
  }
  if (action === "Copy agent ID") { await clipboard(fresh.entry.status.id); context.ui.notify("Copied agent ID.", "info"); return "stay"; }
  if (action === "Copy branch" && fresh.entry.status.worktree) { await clipboard(fresh.entry.status.worktree.branch); context.ui.notify("Copied branch.", "info"); return "stay"; }
  if (action === "Copy worktree path" && fresh.entry.status.worktree) { await clipboard(fresh.entry.status.worktree.path); context.ui.notify("Copied worktree path.", "info"); return "stay"; }
  if (action === "Open prompt in editor" && tui && fresh.entry.request?.prompt !== undefined) { await openNavigatorArtifact(context, tui, workflowPromptArtifact(fresh.entry.request.prompt), "agent prompt"); return "stay"; }
  if (action === "Open system prompt in editor" && tui) { const systemPrompt = liveSystemPrompt(manager, fresh.entry.status); if (systemPrompt !== undefined) { await openNavigatorArtifact(context, tui, workflowPromptArtifact(systemPrompt), "agent system prompt"); return "stay"; } }
  if (action === "Open result in editor" && tui && Object.prototype.hasOwnProperty.call(fresh.record, "value") && jsonValue(fresh.record.value)) { await openNavigatorArtifact(context, tui, workflowResultArtifact(fresh.record.value), "agent result"); return "stay"; }
  if (action === "Steer") {
    const message = await context.ui.input("Steer subagent", "Message for the running subagent");
    if (message === undefined) return "stay";
    await steerSubagent(manager, storageDirectory, entry, context, message);
    return "stay";
  }
  if (action === "Stop") {
    const current = await inspectEntry(manager, storageDirectory, entry, context);
    if (current.entry.status.state !== "running") throw new Error(`Subagent ${entry.status.id} is no longer running`);
    await manager.stop({ id: entry.status.id }, managerContext(context));
    context.ui.notify(`Stopped subagent ${entry.status.id}.`, "info");
    return "stay";
  }
  if (action === "Retry") {
    const current = await inspectEntry(manager, storageDirectory, entry, context);
    if (current.entry.status.state !== "failed" && current.entry.status.state !== "stopped") throw new Error(`Subagent ${entry.status.id} is no longer retryable`);
    const result = retryResult(await manager.retry({ id: entry.status.id }, managerContext(context, false)));
    if (!result) throw new Error("Retry returned an invalid subagent result");
    context.ui.notify(`Retried subagent ${entry.status.id} as ${result.id}.`, "info");
    return "retry";
  }
  return "stay";
}
async function showDetail(manager: SubagentManager, storageDirectory: string, entry: NavigatorEntry, context: ExtensionCommandContext, clipboard: (value: string) => Promise<void>): Promise<"exit" | undefined> {
  let inspection = await inspectEntry(manager, storageDirectory, entry, context);
  if (context.mode !== "tui") {
    for (;;) {
      const action = await context.ui.select(detailLines(inspection).join("\n"), actionOptions(manager, inspection, context));
      if (!action || action === "Back") return;
      try {
        if (await performAction(manager, storageDirectory, entry, action, context, undefined, clipboard) === "retry") return;
        inspection = await inspectEntry(manager, storageDirectory, entry, context);
      } catch (error) {
        context.ui.notify(`Cannot ${action.toLowerCase()}: ${errorText(error)}`, "warning");
      }
    }
  }
  const result = await context.ui.custom<DetailResult>((tui, theme, keybindings, done) => {
    let offset = 0;
    let actionMode = false;
    let actionIndex = 0;
    let actionRunning = false;
    let disposed = false;
    let steerMode = false;
    const editorTheme: EditorTheme = {
      borderColor: (text) => theme.fg("accent", text),
      selectList: {
        selectedPrefix: (text) => theme.fg("accent", text),
        selectedText: (text) => theme.fg("accent", text),
        description: (text) => theme.fg("muted", text),
        scrollInfo: (text) => theme.fg("dim", text),
        noMatch: (text) => theme.fg("warning", text),
      },
    };
    const steerEditor = new Editor(tui, editorTheme);
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    let refreshing = false;
    let refreshGeneration = 0;
    const requestRender = (): void => {
      if (!disposed) tui.requestRender();
    };
    const stopRefresh = (): void => {
      if (refreshTimer !== undefined) {
        clearInterval(refreshTimer);
        refreshTimer = undefined;
      }
      refreshGeneration += 1;
    };
    const buildActionRows = (detail: readonly string[], options: readonly string[]): string[] => [
      ...detail,
      "",
      theme.bold("Agent actions"),
      ...options.map((option, index) => `${index === actionIndex ? "→ " : "  "}${index === actionIndex ? theme.fg("accent", option) : option}`),
    ];
    const viewportRows = (): number => Math.max(1, tuiRows(tui) - 1);
    const maxOffsetFor = (rows: readonly string[]): number => Math.max(0, rows.length - viewportRows());
    const clampOffset = (rows: readonly string[]): void => {
      offset = Math.max(0, Math.min(maxOffsetFor(rows), offset));
    };
    const actionView = (): { readonly detail: string[]; readonly options: string[]; readonly rows: string[] } => {
      const detail = detailLines(inspection, theme);
      const options = actionOptions(manager, inspection, context);
      return { detail, options, rows: buildActionRows(detail, options) };
    };
    const scrollActionIntoView = (view = actionView()): void => {
      const { options, rows } = view;
      if (actionIndex >= options.length) { clampOffset(rows); return; }
      const viewport = viewportRows();
      const actionRow = rows.length - options.length + actionIndex;
      if (actionRow < offset) offset = actionRow;
      else if (actionRow >= offset + viewport) offset = actionRow - viewport + 1;
      clampOffset(rows);
    };
    const reportRefreshError = (error: unknown): void => {
      if (disposed) return;
      try { context.ui.notify(`Cannot refresh subagent ${entry.status.id}: ${errorText(error)}`, "warning"); } catch { /* The session UI may already be closing. */ }
    };
    const refreshInspection = async (): Promise<void> => {
      if (disposed || actionRunning || refreshing || inspection.entry.status.state !== "running") return;
      refreshing = true;
      const generation = ++refreshGeneration;
      const actionIndexBeforeRefresh = actionIndex;
      const viewBeforeRefresh = actionMode ? actionView() : undefined;
      const actionRowBeforeRefresh = viewBeforeRefresh === undefined ? -1 : viewBeforeRefresh.rows.length - viewBeforeRefresh.options.length + actionIndex;
      const wasVisible = actionRowBeforeRefresh >= offset && actionRowBeforeRefresh < offset + viewportRows();
      try {
        const next = await inspectEntry(manager, storageDirectory, entry, context);
        if (generation !== refreshGeneration) return;
        inspection = next;
        if (inspection.entry.status.state !== "running") stopRefresh();
        if (actionMode) {
          const options = actionOptions(manager, inspection, context);
          actionIndex = Math.min(actionIndex, Math.max(0, options.length - 1));
          const view = actionView();
          if (wasVisible || actionIndex !== actionIndexBeforeRefresh) scrollActionIntoView(view);
          else clampOffset(view.rows);
        }
        requestRender();
      } catch (error: unknown) {
        if (generation === refreshGeneration) reportRefreshError(error);
      } finally {
        refreshing = false;
      }
    };
    const close = (value: DetailResult): void => {
      if (disposed) return;
      disposed = true;
      stopRefresh();
      done(value);
    };
    steerEditor.onSubmit = (value) => {
      const message = value.trim();
      if (message) close({ kind: "steer", message });
    };
    const isDisposed = (): boolean => disposed;
    const renderLines = (width: number): string[] => {
      if (disposed) return [];
      const renderWidth = Math.max(1, width);
      const action = actionMode ? actionView() : undefined;
      const detail = (action?.detail ?? detailLines(inspection, theme)).map((line) => truncateToWidth(line, renderWidth, "…"));
      const rows = steerMode ? [...detail, "", theme.bold("Steer subagent"), ...steerEditor.render(renderWidth)] : action?.rows ?? detail;
      const viewport = viewportRows();
      const maxOffset = maxOffsetFor(rows);
      const visibleOffset = steerMode ? maxOffset : Math.max(0, Math.min(maxOffset, offset));
      const hint = theme.fg("dim", steerMode ? "enter submit · esc back" : actionMode ? "↑/↓ actions · enter run · esc back" : "↑/↓ scroll · a actions · enter actions · esc back");
      return [...rows.slice(visibleOffset, visibleOffset + viewport), hint].map((line) => truncateToWidth(line, renderWidth, "…"));
    };
    const runAction = (action: string): void => {
      if (disposed) return;
      actionRunning = true;
      requestRender();
      void performAction(manager, storageDirectory, entry, action, context, tui, clipboard).then(async (outcome) => {
        if (disposed) return;
        if (outcome === "retry") { close("retry"); return; }
        const next = await inspectEntry(manager, storageDirectory, entry, context);
        if (isDisposed()) return;
        inspection = next;
        if (inspection.entry.status.state !== "running") stopRefresh();
        actionMode = false;
        actionIndex = 0;
        offset = 0;
      }).catch((error: unknown) => {
        if (!disposed) context.ui.notify(`Cannot ${action.toLowerCase()}: ${errorText(error)}`, "warning");
      }).finally(() => {
        actionRunning = false;
        if (!disposed) requestRender();
      });
    };
    if (inspection.entry.status.state === "running") {
      refreshTimer = setInterval(() => { void refreshInspection().catch(reportRefreshError); }, 1000);
      unrefTimer(refreshTimer);
    }
    return {
      render: renderLines,
      invalidate() {},
      handleInput(data: string) {
        if (disposed || actionRunning) return;
        if (steerMode) {
          if (keybindings.matches(data, "tui.select.cancel")) { steerMode = false; actionMode = true; steerEditor.setText(""); offset = 0; scrollActionIntoView(); }
          else steerEditor.handleInput(data);
          requestRender();
          return;
        }
        if (!actionMode && data === "a") { actionMode = true; actionIndex = 0; offset = 0; scrollActionIntoView(); requestRender(); return; }
        if (keybindings.matches(data, "tui.select.cancel")) {
          if (actionMode) { actionMode = false; actionIndex = 0; offset = 0; requestRender(); } else close(undefined);
          return;
        }
        if (!actionMode) {
          if (keybindings.matches(data, "tui.select.confirm")) { actionMode = true; actionIndex = 0; offset = 0; scrollActionIntoView(); requestRender(); }
          else if (keybindings.matches(data, "tui.select.up")) { offset = Math.max(0, offset - 1); clampOffset(detailLines(inspection, theme)); requestRender(); }
          else if (keybindings.matches(data, "tui.select.down")) { offset += 1; clampOffset(detailLines(inspection, theme)); requestRender(); }
          return;
        }
        const options = actionOptions(manager, inspection, context);
        if (keybindings.matches(data, "tui.select.up")) { actionIndex = (actionIndex + options.length - 1) % options.length; scrollActionIntoView(); }
        else if (keybindings.matches(data, "tui.select.down")) { actionIndex = (actionIndex + 1) % options.length; scrollActionIntoView(); }
        else if (keybindings.matches(data, "tui.select.confirm")) { const action = options[actionIndex]; if (action === "Steer") { steerMode = true; actionMode = false; steerEditor.setText(""); offset = 0; } else if (action && action !== "Back") runAction(action); else actionMode = false; }
        else if (keybindings.matches(data, "tui.select.pageUp")) { offset = Math.max(0, offset - viewportRows()); clampOffset(actionView().rows); }
        else if (keybindings.matches(data, "tui.select.pageDown")) { offset += viewportRows(); clampOffset(actionView().rows); }
        requestRender();
      },
      dispose() { if (!disposed) { disposed = true; stopRefresh(); } },
    };
  });
  if (!result || result === "retry") return;
  try { await steerSubagent(manager, storageDirectory, entry, context, result.message); }
  catch (error) { context.ui.notify(`Cannot steer: ${errorText(error)}`, "warning"); }
  return "exit";
}

async function runNavigator(manager: SubagentManager, storageDirectory: string, args: string, context: ExtensionCommandContext, clipboard: (value: string) => Promise<void>): Promise<void> {
  if (args.trim()) {
    context.ui.notify("Subagent slash commands do not accept arguments. Open the picker with /subagents to inspect and control current-session runs.", "warning");
    return;
  }
  for (;;) {
    const entries = await loadEntries(manager, storageDirectory, context);
    if (!entries.length) {
      context.ui.notify("No durable subagent runs in this session.", "info");
      return;
    }
    if (!context.hasUI) {
      context.ui.notify(entries.map((entry, index) => pickerLabel(entry, index)).join("\n"), "info");
      return;
    }
    const labels = entries.map(pickerLabel);
    const choice = await context.ui.select("Subagents\n", [...labels, "Close"]);
    if (!choice || choice === "Close") return;
    const selected = entries[labels.indexOf(choice)];
    if (!selected) return;
    try {
      if (await showDetail(manager, storageDirectory, selected, context, clipboard) === "exit") return;
    } catch (error) {
      context.ui.notify(`Cannot inspect subagent ${selected.status.id}: ${errorText(error)}`, "warning");
    }
  }
}

export function registerSubagentNavigator(registerCommand: RegisterCommand, manager: SubagentManager, storageDirectory: string, clipboard: (value: string) => Promise<void> = copyToClipboard): void {
  registerCommand("subagents", {
    description: "Open the durable subagent picker and inspect run status",
    handler: async (args, context) => {
      try {
        await runNavigator(manager, storageDirectory, args, context, clipboard);
      } catch (error) {
        context.ui.notify(`Cannot inspect subagents: ${errorText(error)}`, "warning");
      }
    },
  });
}
