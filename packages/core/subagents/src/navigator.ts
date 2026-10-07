import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { copyToClipboard, getAgentDir, SettingsManager, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Editor, truncateToWidth, type EditorTheme } from "@earendil-works/pi-tui";
import { agentActionLabels, createInlineConfirm, deepFreeze, errorText, formatAgentDetail, formatAgentError, formatCost, formatNavigatorColumns, formatWorkflowRuntime, jsonValue, loadingRegistry, navigatorAttentionSortByState, openWorkflowArtifact, PLAIN_WORKFLOW_PROGRESS_STYLES, progressStyleForState, runStateGlyph, themeWorkflowProgressStyles, visibleStandaloneAgentAttemptActions, workflowKeyLabel, workflowKeyMatches, workflowPromptArtifact, workflowResultArtifact, type AgentAttemptSummary, type AgentDetailPresentation, type StandaloneAgentAttemptActionContext, type WorkflowArtifact, type WorkflowProgressStyles } from "../../src/index.js";
import { normalizeSubagentRunRequest, type SubagentManager, type SubagentManagerContext, type SubagentProgress, type SubagentRunRequest, type SubagentStatus } from "./contracts.js";
import { attemptValue, statusValue } from "./decode.js";
const MAX_DETAIL_TEXT = 4000;

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

// Detail inspections only feed this UI, so they carry the live activity that tool results leave out.
function managerContext(context: ExtensionCommandContext, waitForForeground = true, includeAttemptMetadata = false): SubagentManagerContext {
  return { toolCallId: "subagents-command", signal: undefined, onUpdate: undefined, ...(waitForForeground ? {} : { waitForForeground: false }), ...(includeAttemptMetadata ? { includeAttemptMetadata: true, includeActivity: true } : {}), extensionContext: context };
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


function shortId(id: string): string { return id.length > 12 ? id.slice(0, 8) : id; }
function entryName(entry: NavigatorEntry): string {
  return boundedText(entry.request?.label?.trim() || shortId(entry.status.id), 256);
}
/** Names for a list of runs; a repeated name carries its short ID, as in the `/workflow` picker, so every row stays unique. */
function listNames(entries: readonly NavigatorEntry[]): string[] {
  const names = entries.map(entryName);
  return entries.map(({ status }, index) => {
    const name = names[index] ?? "";
    return names.indexOf(name) === names.lastIndexOf(name) ? name : `${name} ${shortId(status.id)}`;
  });
}
/** Picker rows in the `/workflow` style. */
function pickerLabels(entries: readonly NavigatorEntry[]): string[] {
  const names = listNames(entries);
  return entries.map(({ status }, index) => {
    const name = names[index] ?? "";
    const model = status.progress?.state?.model;
    const cost = formatCost(status.progress?.accounting.cost);
    const runtime = status.startedAt === undefined ? "" : ` runtime=${formatWorkflowRuntime((status.finishedAt ?? Date.now()) - status.startedAt)}`;
    return `${runStateGlyph(status.state, "⠦")} ${name}  ${status.state}${model ? `  ${boundedText(model.model, 256)}${model.thinking ? `:${model.thinking}` : ""}` : ""}${cost ? ` ${cost}` : ""}${runtime}`;
  });
}
function boundedText(value: unknown, limit = MAX_DETAIL_TEXT): string {
  const text = typeof value === "string" ? value : (() => { try { const serialized: unknown = JSON.stringify(value, null, 2); return typeof serialized === "string" ? serialized : String(value); } catch { return String(value); } })();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

function latestAttempt(status: SubagentStatus): AgentAttemptSummary | undefined {
  return [...(status.attemptDetails ?? [])].sort((left, right) => right.attempt - left.attempt)[0];
}
function usageAccounting(status: SubagentStatus): SubagentProgress["accounting"] | undefined {
  return status.progress?.accounting;
}
function detailPresentation(inspection: Inspection): AgentDetailPresentation {
  const { status } = inspection.entry;
  const attempt = latestAttempt(status);
  const state = status.progress?.state;
  const activity = status.progress?.activity;
  const model = state?.model ?? attempt?.setup.model;
  const tools = state?.tools ?? attempt?.setup.tools;
  const lastEventAt = status.progress?.lastEventAt;
  const attempts = status.attempts ?? attempt?.attempt;
  const accounting = usageAccounting(status);
  const error = status.error ?? attempt?.error;
  return {
    state: status.state,
    ...(activity === undefined ? {} : { activity: { kind: activity.kind, text: boundedText(activity.text) } }),
    ...(lastEventAt === undefined ? {} : { lastEventAt }),
    ...(model === undefined ? {} : { model: { provider: boundedText(model.provider, 256), model: boundedText(model.model, 256), ...(model.thinking === undefined ? {} : { thinking: model.thinking }) } }),
    ...(tools === undefined ? {} : { tools: tools.slice(0, 256).map((tool) => boundedText(tool, 256)) }),
    ...(attempts === undefined ? {} : { attempts }),
    ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt }),
    ...(status.finishedAt === undefined ? {} : { finishedAt: status.finishedAt }),
    ...(accounting === undefined ? {} : { accounting }),
    ...(error === undefined ? {} : { error: { code: boundedText(error.code, 256), message: boundedText(error.message) } }),
  };
}
type DetailMenu = "hint" | { readonly options: readonly string[]; readonly index: number } | undefined;
/** Details of the selected run in the order of a /workflow agent: fields, hint, error, then the action menu. The prompt and result open in the editor. */
function detailRows(inspection: Inspection, styles: WorkflowProgressStyles, menu?: DetailMenu): string[] {
  const { entry } = inspection;
  const presentation = detailPresentation(inspection);
  return [
    styles.bold(`Selected subagent: ${entryName(entry)}`),
    `ID: ${boundedText(entry.status.id, 256)}`,
    ...formatAgentDetail(presentation, styles, entry.status.finishedAt ?? Date.now(), { includeError: false }),
    ...(entry.requestError === undefined ? [] : [styles.warning(`Request unavailable: ${boundedText(entry.requestError)}`)]),
    ...(menu === "hint" ? [styles.muted("enter agent actions")] : []),
    ...(presentation.error === undefined ? [] : [formatAgentError(presentation.error, styles)]),
    ...(typeof menu === "object" ? [styles.bold("Agent actions"), ...menu.options.map((option, index) => index === menu.index ? `→ ${styles.accent(option)}` : `  ${option}`)] : []),
  ];
}
function listRows(entries: readonly NavigatorEntry[], selectedId: string, styles: WorkflowProgressStyles): string[] {
  const names = listNames(entries);
  return [styles.bold("Runs"), ...entries.map((entry, index) => `${entry.status.id === selectedId ? "→" : " "} • ${names[index] ?? ""} · ${progressStyleForState(entry.status.state, styles)(runStateGlyph(entry.status.state, "⠦"))}`)];
}
function headerRows(entries: readonly NavigatorEntry[], styles: WorkflowProgressStyles): string[] {
  const counts = (["running", "failed", "stopped", "completed"] as const).flatMap((state) => {
    const count = entries.filter((entry) => entry.status.state === state).length;
    return count ? [`${String(count)} ${state}`] : [];
  });
  const cost = formatCost(entries.reduce((sum, entry) => sum + (entry.status.progress?.accounting.cost ?? 0), 0));
  return [styles.bold(styles.accent("Subagents")), [...counts, ...(cost ? [cost] : [])].join(" · ")];
}

function tuiRows(tui: { terminal?: { rows?: number } }): number { return typeof tui.terminal?.rows === "number" && Number.isFinite(tui.terminal.rows) ? tui.terminal.rows : 24; }
function unrefTimer(timer: ReturnType<typeof setInterval>): void {
  const value: unknown = timer;
  if (typeof value !== "object" || value === null || !("unref" in value) || typeof value.unref !== "function") return;
  Reflect.apply(value.unref, value, []);
}

type NavigatorTui = Parameters<typeof openWorkflowArtifact>[0];
type DashboardResult = { readonly entry: NavigatorEntry; readonly message: string } | undefined;
// Pi keeps its footer below a custom component; the dashboard leaves room for it as /workflow does.
const DASHBOARD_FOOTER_ROWS = 2;
function standaloneActionContext(manager: SubagentManager, inspection: Inspection, context: ExtensionCommandContext): StandaloneAgentAttemptActionContext | undefined {
  const status = inspection.entry.status;
  const request = inspection.entry.request;
  const liveData = manager.getAttemptActionData?.(status.id);
  const attempt = attemptValue(liveData?.attempt) ?? latestAttempt(status);
  if (!attempt) return undefined;
  const session = attempt.session;
  const live = liveData?.liveSession && session && liveData.liveSession.reference.transport === session.transport && liveData.liveSession.reference.sessionId === session.sessionId ? liveData.liveSession : undefined;
  const label = request?.label?.trim();
  const name = label || "subagent";
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
type BulkDeleteState = "completed" | "failed";
const BULK_DELETE: Readonly<Record<string, BulkDeleteState>> = { "Delete all completed": "completed", "Delete all failed": "failed" };
/** The /workflow picker's bulk deletions, offered for the states present in the list. */
function bulkDeleteLabels(manager: SubagentManager, entries: readonly NavigatorEntry[]): string[] {
  if (manager.delete === undefined) return [];
  return Object.entries(BULK_DELETE).filter(([, state]) => entries.some((entry) => entry.status.state === state)).map(([label]) => label);
}
/** Agent actions plus the /workflow run actions that apply to a standalone run: Delete and Copy run path, before Copy agent ID. */
function actionOptions(manager: SubagentManager, inspection: Inspection, context: ExtensionCommandContext, bulk: readonly string[] = []): string[] {
  const actionContext = standaloneActionContext(manager, inspection, context);
  const extensionLabels = actionContext === undefined ? [] : visibleStandaloneAgentAttemptActions(loadingRegistry().agentAttemptActions(), actionContext).map(([, action]) => action.label);
  const value = inspection.record.value;
  const labels = agentActionLabels({
    extensionLabels,
    hasWorktree: inspection.entry.status.worktree !== undefined,
    openPrompt: context.mode === "tui" && inspection.entry.request?.prompt !== undefined,
    openSystemPrompt: context.mode === "tui" && liveSystemPrompt(manager, inspection.entry.status) !== undefined,
    openResult: context.mode === "tui" && Object.prototype.hasOwnProperty.call(inspection.record, "value") && jsonValue(value),
    standaloneState: inspection.entry.status.state,
  });
  const runActions = [...(manager.delete !== undefined && inspection.entry.status.state !== "running" ? ["Delete"] : []), ...bulk, ...(context.mode === "tui" ? ["Copy run path"] : [])];
  labels.splice(labels.indexOf("Copy agent ID"), 0, ...runActions);
  return labels;
}
type Confirm = (title: string, message: string) => Promise<boolean>;
async function deleteAll(manager: SubagentManager, storageDirectory: string, context: ExtensionCommandContext, state: BulkDeleteState, confirm: Confirm): Promise<boolean> {
  if (!await confirm(`Delete ${state} runs?`, `Delete all ${state} subagent runs and their records? This cannot be undone.`)) return false;
  const skipped: string[] = [];
  let deleted = 0;
  for (const entry of await loadEntries(manager, storageDirectory, context)) {
    if (entry.status.state !== state) continue;
    try {
      await manager.delete?.({ id: entry.status.id }, managerContext(context));
      deleted += 1;
    } catch (error) {
      skipped.push(`${entry.status.id} (${errorText(error)})`);
    }
  }
  if (skipped.length) context.ui.notify(`Skipped ${state} runs: ${skipped.join(", ")}.`, "warning");
  if (deleted) context.ui.notify(`Deleted ${String(deleted)} ${state} subagent run(s).`, "info");
  return true;
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
/** `unchanged` leaves the menu where it was, as /workflow does after an editor or copy action: the user declined, or the action does not touch the run. */
type ActionOutcome = "stay" | "unchanged" | "deleted" | { readonly retryId: string };
async function performAction(manager: SubagentManager, storageDirectory: string, entry: NavigatorEntry, action: string, context: ExtensionCommandContext, tui: NavigatorTui | undefined, clipboard: (value: string) => Promise<void>, confirm: Confirm): Promise<ActionOutcome> {
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
  if (action === "Copy agent ID") { await clipboard(fresh.entry.status.id); context.ui.notify("Copied agent ID.", "info"); return "unchanged"; }
  if (action === "Copy run path") { await clipboard(join(storageDirectory, fresh.entry.status.id)); context.ui.notify("Copied run path.", "info"); return "unchanged"; }
  if (action === "Delete" && manager.delete !== undefined) {
    if (!await confirm("Delete subagent?", `Delete ${entryName(fresh.entry)} (${fresh.entry.status.id}) and its record? This cannot be undone.`)) return "unchanged";
    await manager.delete({ id: fresh.entry.status.id }, managerContext(context));
    context.ui.notify(`Deleted subagent ${fresh.entry.status.id}.`, "info");
    return "deleted";
  }
  if (action === "Copy branch" && fresh.entry.status.worktree) { await clipboard(fresh.entry.status.worktree.branch); context.ui.notify("Copied branch.", "info"); return "unchanged"; }
  if (action === "Copy worktree path" && fresh.entry.status.worktree) { await clipboard(fresh.entry.status.worktree.path); context.ui.notify("Copied worktree path.", "info"); return "unchanged"; }
  if (action === "Open prompt in editor" && tui && fresh.entry.request?.prompt !== undefined) { await openNavigatorArtifact(context, tui, workflowPromptArtifact(fresh.entry.request.prompt), "agent prompt"); return "unchanged"; }
  if (action === "Open system prompt in editor" && tui) { const systemPrompt = liveSystemPrompt(manager, fresh.entry.status); if (systemPrompt !== undefined) { await openNavigatorArtifact(context, tui, workflowPromptArtifact(systemPrompt), "agent system prompt"); return "unchanged"; } }
  if (action === "Open result in editor" && tui && Object.prototype.hasOwnProperty.call(fresh.record, "value") && jsonValue(fresh.record.value)) { await openNavigatorArtifact(context, tui, workflowResultArtifact(fresh.record.value), "agent result"); return "unchanged"; }
  if (action === "Steer") {
    const message = await context.ui.input("Steer subagent", "Message for the running subagent");
    if (message === undefined) return "unchanged";
    await steerSubagent(manager, storageDirectory, entry, context, message);
    return "stay";
  }
  if (action === "Stop") {
    if (!await confirm("Stop subagent?", `Stop subagent ${entryName(fresh.entry)} (${fresh.entry.status.id})? This cannot be undone.`)) return "unchanged";
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
    return { retryId: result.id };
  }
  return "stay";
}
async function showDetail(manager: SubagentManager, storageDirectory: string, entry: NavigatorEntry, context: ExtensionCommandContext, clipboard: (value: string) => Promise<void>): Promise<void> {
  let inspection = await inspectEntry(manager, storageDirectory, entry, context);
  for (;;) {
    const action = await context.ui.select(detailRows(inspection, PLAIN_WORKFLOW_PROGRESS_STYLES).join("\n"), actionOptions(manager, inspection, context));
    if (!action || action === "Back") return;
    try {
      const outcome = await performAction(manager, storageDirectory, entry, action, context, undefined, clipboard, (title, message) => context.ui.confirm(title, message));
      if (outcome === "deleted" || typeof outcome === "object") return;
      inspection = await inspectEntry(manager, storageDirectory, entry, context);
    } catch (error) {
      context.ui.notify(`Cannot ${action.toLowerCase()}: ${errorText(error)}`, "warning");
    }
  }
}

/** The `/workflow` dashboard layout for standalone runs: the run list beside the selected run's details. */
async function showDashboard(manager: SubagentManager, storageDirectory: string, initial: readonly NavigatorEntry[], context: ExtensionCommandContext, clipboard: (value: string) => Promise<void>): Promise<void> {
  const first = initial[0];
  if (first === undefined) return;
  let initialInspection: Inspection;
  try { initialInspection = await inspectEntry(manager, storageDirectory, first, context); }
  catch (error) {
    context.ui.notify(`Cannot inspect subagent ${first.status.id}: ${errorText(error)}`, "warning");
    initialInspection = { entry: first, record: {} };
  }
  const result = await context.ui.custom<DashboardResult>((tui, theme, keybindings, done) => {
    const styles = themeWorkflowProgressStyles(theme);
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
    let entries = initial;
    let inspection = initialInspection;
    let offset = 0;
    let detailsMode = false;
    let actionMode = false;
    let actionIndex = 0;
    let steerMode = false;
    const inlineConfirm = createInlineConfirm(() => { if (!disposed) tui.requestRender(); });
    const confirmInline: Confirm = (title, message) => inlineConfirm.ask(title, message);
    let actionRunning = false;
    let refreshing = false;
    let disposed = false;
    let generation = 0;
    let renderedWidth = 80;
    let selectionNeedsScroll = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    const keyLabel = (binding: string, fallback: string): string => workflowKeyLabel(keybindings, binding, fallback);
    const matches = (data: string, binding: string): boolean => workflowKeyMatches(keybindings, data, binding);
    const requestRender = (): void => { if (!disposed) tui.requestRender(); };
    const options = (): string[] => actionOptions(manager, inspection, context, bulkDeleteLabels(manager, entries));
    const warn = (message: string): void => {
      if (disposed) return;
      try { context.ui.notify(message, "warning"); } catch { /* The session UI may already be closing. */ }
    };
    const stopTimer = (): void => {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    };
    // Refresh while anything runs; a settled list has nothing left to change.
    const syncTimer = (): void => {
      if (!entries.some((entry) => entry.status.state === "running") && inspection.entry.status.state !== "running") stopTimer();
      else if (timer === undefined && !disposed) {
        timer = setInterval(() => { if (timer !== undefined) void refresh(); }, 1000);
        unrefTimer(timer);
      }
    };
    const apply = (nextEntries: readonly NavigatorEntry[], next: Inspection): void => {
      const selectedAction = actionMode ? options()[actionIndex] : undefined;
      const position = (list: readonly NavigatorEntry[]): number => list.findIndex((entry) => entry.status.id === next.entry.status.id);
      if (position(entries) !== position(nextEntries)) selectionNeedsScroll = true;
      entries = nextEntries;
      inspection = next;
      if (selectedAction !== undefined) {
        const nextOptions = options();
        const kept = nextOptions.indexOf(selectedAction);
        actionIndex = kept >= 0 ? kept : Math.min(actionIndex, Math.max(0, nextOptions.length - 1));
      }
      syncTimer();
      requestRender();
    };
    const reload = async (id = inspection.entry.status.id): Promise<void> => {
      const current = ++generation;
      const nextEntries = await loadEntries(manager, storageDirectory, context);
      if (current !== generation) return;
      const selected = nextEntries.find((entry) => entry.status.id === id) ?? nextEntries[0];
      if (selected === undefined) {
        context.ui.notify("No durable subagent runs in this session.", "info");
        close(undefined);
        return;
      }
      let next: Inspection;
      try { next = await inspectEntry(manager, storageDirectory, selected, context); }
      catch (error: unknown) {
        // The fresh list still shows, with the row's own data as when moving the selection.
        if (current === generation) apply(nextEntries, { entry: selected, record: {} });
        throw error;
      }
      if (current === generation) apply(nextEntries, next);
    };
    // A tick re-reads only the active runs and the selection; the full list is read on open and after an action.
    // A failed read keeps the last known row, as the /workflow refresh does, so one unreadable run cannot hold back the rest.
    // Moving the selection bumps the generation, so a tick that survives it still has the selection it read.
    //NOTE: a running run whose files vanish keeps the timer alive until the dashboard closes.
    const refresh = async (): Promise<void> => {
      if (disposed || actionRunning || refreshing) return;
      refreshing = true;
      const current = generation;
      const selectedId = inspection.entry.status.id;
      try {
        const stale = entries.filter((entry) => entry.status.state === "running" || entry.status.id === selectedId);
        const results = await Promise.allSettled(stale.map((entry) => inspectEntry(manager, storageDirectory, entry, context)));
        if (current !== generation) return;
        const fresh = new Map(results.flatMap((result) => result.status === "fulfilled" ? [[result.value.entry.status.id, result.value] as const] : []));
        apply(attentionSort(entries.map((entry) => fresh.get(entry.status.id)?.entry ?? entry)), fresh.get(selectedId) ?? inspection);
      } finally {
        refreshing = false;
      }
    };
    const select = (delta: number): void => {
      const index = Math.max(0, entries.findIndex((entry) => entry.status.id === inspection.entry.status.id));
      const entry = entries[(index + delta + entries.length) % entries.length];
      if (entry === undefined || entry.status.id === inspection.entry.status.id) return;
      // The list row already holds the state; the full inspection adds the result and attempt details.
      inspection = { entry, record: {} };
      selectionNeedsScroll = true;
      const current = ++generation;
      void inspectEntry(manager, storageDirectory, entry, context).then((next) => {
        if (current === generation) apply(entries, next);
      }, (error: unknown) => { if (current === generation) warn(`Cannot inspect subagent ${entry.status.id}: ${errorText(error)}`); });
    };
    // Reads still in flight check the generation, so closing invalidates them.
    const shutDown = (): void => {
      disposed = true;
      generation += 1;
      stopTimer();
      inlineConfirm.cancel();
    };
    const close = (value: DashboardResult): void => {
      if (disposed) return;
      shutDown();
      done(value);
    };
    steerEditor.onSubmit = (value) => {
      const message = value.trim();
      if (message) close({ entry: inspection.entry, message });
    };
    const reloadAfterAction = async (id?: string): Promise<void> => {
      try { await reload(id); }
      catch (error: unknown) { warn(`Cannot refresh subagents: ${errorText(error)}`); }
    };
    const runAction = (action: string): void => {
      actionRunning = true;
      requestRender();
      const bulk = BULK_DELETE[action];
      const pending = bulk === undefined ? performAction(manager, storageDirectory, inspection.entry, action, context, tui, clipboard, confirmInline) : deleteAll(manager, storageDirectory, context, bulk, confirmInline).then((done): ActionOutcome => done ? "stay" : "unchanged");
      void pending.then(async (outcome) => {
        if (disposed || outcome === "unchanged") return;
        // The action already happened: a failed reload must not read as a failed action that invites a second retry.
        await reloadAfterAction(typeof outcome === "object" ? outcome.retryId : undefined);
        actionMode = false;
        actionIndex = 0;
        offset = 0;
        selectionNeedsScroll = true;
      }, async (error: unknown) => {
        warn(`Cannot ${action.toLowerCase()}: ${errorText(error)}`);
        // The menu stays open on fresh options: a failed Stop usually means the run has already settled.
        if (!disposed) await reloadAfterAction();
      }).finally(() => {
        actionRunning = false;
        requestRender();
      });
    };
    syncTimer();
    return {
      render(width: number): string[] {
        if (disposed) return [];
        renderedWidth = width;
        const narrow = width < 80;
        const actions = actionMode ? options() : [];
        const menu: DetailMenu = actionMode ? { options: actions, index: actionIndex } : steerMode ? undefined : "hint";
        const layout = narrow ? detailsMode || actionMode || steerMode ? { detailsOnly: true } : { treeOnly: true } : {};
        const content = [...headerRows(entries, styles), ...formatNavigatorColumns(listRows(entries, inspection.entry.status.id, styles), detailRows(inspection, styles, menu), width, layout)];
        const footer = steerMode ? [styles.bold("Steer subagent"), ...steerEditor.render(width)] : inlineConfirm.rows(width, styles);
        const rows = Math.max(1, tuiRows(tui) - DASHBOARD_FOOTER_ROWS);
        const hintRows = rows >= 3 ? 1 : 0;
        const viewport = Math.max(1, rows - hintRows - footer.length);
        const keepVisible = (row: number): void => {
          if (row < 0) return;
          if (row < offset) offset = row;
          else if (row >= offset + viewport) offset = row - viewport + 1;
        };
        // The selected action is the first arrow in the details column: it precedes the prompt and result.
        if (actionMode) keepVisible(content.findIndex((line) => narrow ? line.startsWith("→ ") : line.includes(" | → ")));
        else if (selectionNeedsScroll && !(narrow && detailsMode)) {
          keepVisible(content.findIndex((line) => line.startsWith("→")));
          selectionNeedsScroll = false;
        }
        offset = Math.max(0, Math.min(Math.max(0, content.length - viewport), offset));
        const up = keyLabel("tui.select.up", "↑");
        const down = keyLabel("tui.select.down", "↓");
        const enter = keyLabel("tui.select.confirm", "enter");
        const esc = keyLabel("tui.select.cancel", "esc");
        const scroll = content.length > viewport ? ` · ${keyLabel("tui.select.pageUp", "pgup")}/${keyLabel("tui.select.pageDown", "pgdn")} scroll` : "";
        const refreshHint = timer === undefined ? "" : " · auto-refresh 1s";
        const back = narrow && detailsMode ? "details" : "list";
        const hint = steerMode ? "enter submit · esc back"
          : inlineConfirm.active() ? inlineConfirm.hint(keybindings)
          : actionMode ? `${up}/${down} actions · ${enter} run · ${keyLabel("tui.editor.cursorLeft", "←")} ${back} · ${esc} ${back}`
            : narrow && detailsMode ? `${up}/${down} scroll · ${enter} actions · a actions · ${esc} list${scroll}${refreshHint}`
              : `${up}/${down} select · ${enter} ${narrow ? "details" : "actions"} · a actions · ${esc} close${scroll}${refreshHint}`;
        return [...content.slice(offset, offset + viewport), ...footer, ...(hintRows ? [styles.dim(hint)] : [])].map((line) => truncateToWidth(line, Math.max(1, width), "…"));
      },
      invalidate() {},
      handleInput(data: string) {
        if (disposed) return;
        if (inlineConfirm.active()) { inlineConfirm.handleInput(keybindings, data); return; }
        if (actionRunning) return;
        if (steerMode) {
          if (keybindings.matches(data, "tui.select.cancel")) { steerMode = false; actionMode = true; steerEditor.setText(""); }
          else steerEditor.handleInput(data);
          requestRender();
          return;
        }
        const narrow = renderedWidth < 80;
        const page = Math.max(1, tuiRows(tui) - DASHBOARD_FOOTER_ROWS - 1);
        if (matches(data, "tui.select.pageUp")) offset = Math.max(0, offset - page);
        else if (matches(data, "tui.select.pageDown")) offset += page;
        else if (actionMode) {
          const actions = options();
          if (matches(data, "tui.select.cancel") || matches(data, "tui.editor.cursorLeft")) { actionMode = false; offset = 0; selectionNeedsScroll = true; }
          else if (matches(data, "tui.select.up")) actionIndex = (actionIndex + actions.length - 1) % actions.length;
          else if (matches(data, "tui.select.down")) actionIndex = (actionIndex + 1) % actions.length;
          else if (matches(data, "tui.select.confirm")) {
            const action = actions[actionIndex];
            if (action === "Steer") { steerMode = true; actionMode = false; steerEditor.setText(""); }
            else if (action && action !== "Back") runAction(action);
            else { actionMode = false; offset = 0; selectionNeedsScroll = true; }
          }
        } else if (data === "a" || data === "A") { actionMode = true; actionIndex = 0; offset = 0; }
        else if (matches(data, "tui.select.cancel")) {
          if (!narrow || !detailsMode) { close(undefined); return; }
          detailsMode = false;
          offset = 0;
          selectionNeedsScroll = true;
        } else if (narrow && detailsMode) {
          if (matches(data, "tui.select.up")) offset = Math.max(0, offset - 1);
          else if (matches(data, "tui.select.down")) offset += 1;
          else if (matches(data, "tui.select.confirm")) { actionMode = true; actionIndex = 0; offset = 0; }
        } else if (matches(data, "tui.select.up")) select(-1);
        else if (matches(data, "tui.select.down")) select(1);
        else if (matches(data, "tui.select.confirm")) {
          if (narrow) detailsMode = true;
          else actionMode = true;
          actionIndex = 0;
          offset = 0;
        }
        requestRender();
      },
      dispose() { shutDown(); },
    };
  });
  if (result === undefined) return;
  try { await steerSubagent(manager, storageDirectory, result.entry, context, result.message); }
  catch (error) { context.ui.notify(`Cannot steer: ${errorText(error)}`, "warning"); }
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
    const labels = pickerLabels(entries);
    if (!context.hasUI) {
      context.ui.notify(labels.join("\n"), "info");
      return;
    }
    if (context.mode === "tui") {
      await showDashboard(manager, storageDirectory, entries, context, clipboard);
      return;
    }
    const choice = await context.ui.select("Subagents\n", [...labels, "Close", ...bulkDeleteLabels(manager, entries)]);
    if (!choice || choice === "Close") return;
    const bulk = BULK_DELETE[choice];
    if (bulk !== undefined) {
      try { await deleteAll(manager, storageDirectory, context, bulk, (title, message) => context.ui.confirm(title, message)); }
      catch (error) { context.ui.notify(`Cannot delete ${bulk} runs: ${errorText(error)}`, "warning"); }
      continue;
    }
    const selected = entries[labels.indexOf(choice)];
    if (!selected) return;
    try {
      await showDetail(manager, storageDirectory, selected, context, clipboard);
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
