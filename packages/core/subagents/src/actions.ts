import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { agentsAction, type ActionUi, type AgentsActionProvider, type AgentsActionTarget, type SubagentPresentation, type SubagentPresenter } from "../../src/agents-actions-contract.js";
import { agentActionLabels, deepFreeze, errorText, formatAgentDetail, formatAgentError, jsonValue, loadingRegistry, navigatorAttentionSortByState, sanitizeDisplayText, visibleStandaloneAgentAttemptActions, workflowPromptArtifact, workflowResultArtifact, type AgentAttemptActionUi, type AgentDetailPresentation, type StandaloneAgentAttemptActionContext, type WorkflowProgressStyles } from "../../src/index.js";
import { attemptActionUi, copyArtifact, detachedAttemptActionUi, VISIBILITY_UI } from "../../src/workflow-actions.js";
import { isNodeError, object } from "../../src/utils.js";
import { normalizeSubagentRunRequest, SUBAGENT_MAX_RETRIES, type SubagentManager, type SubagentProgress, type SubagentRunRequest, type SubagentStatus } from "./contracts.js";
import { attemptValue, latestAttempt, managerContext, safeSubagentId, shortSubagentId, statusValue, SUBAGENT_ATTENTION_ORDER } from "./decode.js";

/**
 * The /subagents actions: the rules the /subagents picker (navigator.ts) and the
 * agents workspace /subagents and /agents open share. Whatever they ask of the person goes through the ActionUi they are
 * given; nothing here calls ctx.ui.
 */

const MAX_DETAIL_TEXT = 4000;

export type NavigatorEntry = {
  readonly status: SubagentStatus;
  readonly request?: SubagentRunRequest;
  readonly requestError?: string;
};
type Inspection = { readonly entry: NavigatorEntry; readonly record: Record<string, unknown> };

function inspectionValue(value: unknown): { status: SubagentStatus; record: Record<string, unknown> } | undefined {
  const record = object(value) ? value : undefined;
  const status = statusValue(value);
  return record && status ? { status, record } : undefined;
}

async function loadRequest(storageDirectory: string, id: string): Promise<{ request?: SubagentRunRequest; error?: string }> {
  if (!safeSubagentId(id)) return {};
  try {
    const value: unknown = JSON.parse(await readFile(join(storageDirectory, id, "request.json"), "utf8"));
    return { request: normalizeSubagentRunRequest(value) };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return {};
    return { error: errorText(error) };
  }
}

function attentionSort(entries: readonly NavigatorEntry[]): NavigatorEntry[] {
  return navigatorAttentionSortByState(entries, (entry) => entry.status.state, (entry) => entry.status.finishedAt, SUBAGENT_ATTENTION_ORDER);
}

export async function loadEntries(manager: SubagentManager, storageDirectory: string, context: ExtensionCommandContext): Promise<NavigatorEntry[]> {
  const value = await manager.inspect({}, managerContext("subagents-command", context));
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

export async function inspectEntry(manager: SubagentManager, storageDirectory: string, id: string, context: ExtensionCommandContext): Promise<Inspection> {
  const inspected = inspectionValue(await manager.inspect({ id }, managerContext("subagents-command", context, true)));
  if (!inspected) throw new Error(`Subagent ${id} returned an invalid inspection`);
  const request = await loadRequest(storageDirectory, id);
  return {
    record: inspected.record,
    entry: { status: inspected.status, ...(request.request === undefined ? {} : { request: request.request }), ...(request.error === undefined ? {} : { requestError: request.error }) },
  };
}

function entryName(entry: NavigatorEntry): string {
  return boundedText(sanitizeDisplayText(entry.request?.label ?? "").trim() || sanitizeDisplayText(shortSubagentId(entry.status.id)), 256);
}
/** Names for a list of runs; a repeated name carries its short ID, as in the `/workflow` picker, so every row stays unique. */
export function listNames(entries: readonly NavigatorEntry[]): string[] {
  const names = entries.map(entryName);
  return entries.map(({ status }, index) => {
    const name = names[index] ?? "";
    return names.indexOf(name) === names.lastIndexOf(name) ? name : `${name} ${sanitizeDisplayText(shortSubagentId(status.id))}`;
  });
}
export function boundedText(value: unknown, limit = MAX_DETAIL_TEXT): string {
  const text = typeof value === "string" ? value : (() => { try { const serialized: unknown = JSON.stringify(value, null, 2); return typeof serialized === "string" ? serialized : String(value); } catch { return String(value); } })();
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
function displayText(value: unknown, limit?: number): string { return sanitizeDisplayText(boundedText(value, limit)); }

function usageAccounting(status: SubagentStatus): SubagentProgress["accounting"] | undefined {
  return status.progress?.accounting;
}
function detailPresentation(inspection: Inspection): AgentDetailPresentation {
  const { status } = inspection.entry;
  const attempt = latestAttempt(status.attemptDetails);
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
    ...(activity === undefined ? {} : { activity: { kind: activity.kind, text: displayText(activity.text) } }),
    ...(lastEventAt === undefined ? {} : { lastEventAt }),
    ...(model === undefined ? {} : { model: { provider: displayText(model.provider, 256), model: displayText(model.model, 256), ...(model.thinking === undefined ? {} : { thinking: model.thinking }) } }),
    ...(tools === undefined ? {} : { tools: tools.slice(0, 256).map((tool) => displayText(tool, 256)) }),
    ...(attempts === undefined ? {} : { attempts }),
    ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt }),
    ...(status.finishedAt === undefined ? {} : { finishedAt: status.finishedAt }),
    ...(accounting === undefined ? {} : { accounting }),
    ...(error === undefined ? {} : { error: { code: displayText(error.code, 256), message: displayText(error.message) } }),
  };
}
/** Details of the selected run in the order of a /workflow agent: fields, then the error. The prompt and result open in the editor. */
export function detailRows(inspection: Inspection, styles: WorkflowProgressStyles, now: number): string[] {
  const { entry } = inspection;
  const presentation = detailPresentation(inspection);
  return [
    styles.bold(`Selected subagent: ${entryName(entry)}`),
    `ID: ${displayText(entry.status.id, 256)}`,
    ...formatAgentDetail(presentation, styles, entry.status.finishedAt ?? now, { includeError: false }),
    ...(entry.requestError === undefined ? [] : [styles.warning(`Request unavailable: ${displayText(entry.requestError)}`)]),
    ...(presentation.error === undefined ? [] : [formatAgentError(presentation.error, styles)]),
  ];
}

function standaloneActionContext(manager: SubagentManager, inspection: Inspection, ui: AgentAttemptActionUi): StandaloneAgentAttemptActionContext | undefined {
  const status = inspection.entry.status;
  const request = inspection.entry.request;
  const liveData = manager.getAttemptActionData?.(status.id);
  const attempt = attemptValue(liveData?.attempt) ?? latestAttempt(status.attemptDetails);
  if (!attempt) return undefined;
  const session = attempt.session;
  const live = liveData?.liveSession && session && liveData.liveSession.reference.transport === session.transport && liveData.liveSession.reference.sessionId === session.sessionId ? liveData.liveSession : undefined;
  const label = request?.label?.trim();
  const name = label || "subagent";
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
export const BULK_DELETE: Readonly<Record<string, BulkDeleteState>> = { "Delete all completed": "completed", "Delete all failed": "failed" };
/** The /workflow picker's bulk deletions, offered for the states present in the list. */
export function bulkDeleteLabels(manager: SubagentManager, entries: readonly NavigatorEntry[]): string[] {
  if (manager.delete === undefined) return [];
  return Object.entries(BULK_DELETE).filter(([, state]) => entries.some((entry) => entry.status.state === state)).map(([label]) => label);
}
/**
 * Agent actions plus the /workflow run actions that apply to a standalone run: Delete and Copy run path, before Copy agent ID.
 * `ui` is the one a registered action's visibility sees.
 */
export function actionOptions(manager: SubagentManager, inspection: Inspection, context: ExtensionCommandContext, ui: AgentAttemptActionUi, bulk: readonly string[] = []): string[] {
  const actionContext = standaloneActionContext(manager, inspection, ui);
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
  // Edit and retry needs the request it edits; it follows Retry.
  const retry = labels.indexOf("Retry");
  if (retry >= 0 && inspection.entry.request !== undefined) labels.splice(retry + 1, 0, "Edit and retry");
  return labels;
}
export async function deleteAll(manager: SubagentManager, storageDirectory: string, context: ExtensionCommandContext, state: BulkDeleteState, ui: Pick<ActionUi, "confirm" | "notify">): Promise<boolean> {
  if (!await ui.confirm(`Delete ${state} runs?`, `Delete all ${state} subagent runs and their records? This cannot be undone.`)) return false;
  const skipped: string[] = [];
  let deleted = 0;
  for (const entry of await loadEntries(manager, storageDirectory, context)) {
    if (entry.status.state !== state) continue;
    try {
      await manager.delete?.({ id: entry.status.id }, managerContext("subagents-command", context));
      deleted += 1;
    } catch (error) {
      skipped.push(`${entry.status.id} (${errorText(error)})`);
    }
  }
  if (skipped.length) ui.notify(`Skipped ${state} runs: ${skipped.join(", ")}.`, "warning");
  if (deleted) ui.notify(`Deleted ${String(deleted)} ${state} subagent run(s).`, "info");
  return true;
}
function retryResult(value: unknown): { readonly id: string; readonly state: "running" } | undefined {
  const record = object(value) ? value : undefined;
  return record && typeof record.id === "string" && record.id.trim() && record.state === "running" ? { id: record.id, state: "running" } : undefined;
}
async function steerSubagent(manager: SubagentManager, storageDirectory: string, id: string, context: ExtensionCommandContext, message: string, ui: Pick<ActionUi, "notify">): Promise<void> {
  const current = await inspectEntry(manager, storageDirectory, id, context);
  if (current.entry.status.state !== "running") throw new Error(`Subagent ${id} is no longer running`);
  await manager.steer({ id, message }, managerContext("subagents-command", context));
  ui.notify(`Steered subagent ${id}.`, "info");
}
/** What the picker does next: inspect the run again, go back to the list once it is gone, or show the new run of a Retry. */
type ActionOutcome = "stay" | "deleted" | { readonly retryId: string };
export async function performAction(manager: SubagentManager, storageDirectory: string, id: string, action: string, context: ExtensionCommandContext, ui: ActionUi, clipboard: (value: string) => Promise<void>, detached = false): Promise<ActionOutcome> {
  const fresh = await inspectEntry(manager, storageDirectory, id, context);
  const owner = {};
  const actionUi = detached ? detachedAttemptActionUi(ui, owner) : attemptActionUi(ui);
  const available = actionOptions(manager, fresh, context, actionUi);
  if (!available.includes(action)) throw new Error(`Action ${action} is no longer available`);
  const actionContext = standaloneActionContext(manager, fresh, actionUi);
  const registered = actionContext === undefined ? undefined : visibleStandaloneAgentAttemptActions(loadingRegistry().agentAttemptActions(), actionContext).find(([, candidate]) => candidate.label === action);
  if (registered) {
    if (!actionContext || registered[1].runStandalone === undefined) throw new Error(`Action ${action} has no standalone implementation`);
    if (!detached) { await registered[1].runStandalone(actionContext); return "stay"; }
    // As runAgentAction runs a workflow agent's in the workspace: started, not awaited, a failure reported once.
    void (async () => {
      try { await registered[1].runStandalone?.(actionContext); }
      catch (error) { ui.notify(`Agent attempt action failed: ${errorText(error)}`, "error"); }
      finally { ui.setWorkingMessage(undefined, owner); }
    })();
    return "stay";
  }
  if (action === "Copy agent ID") { await copyArtifact(clipboard, ui, fresh.entry.status.id, "agent ID"); return "stay"; }
  if (action === "Copy run path") { await copyArtifact(clipboard, ui, join(storageDirectory, fresh.entry.status.id), "run path"); return "stay"; }
  if (action === "Delete" && manager.delete !== undefined) {
    if (!await ui.confirm("Delete subagent?", `Delete ${entryName(fresh.entry)} (${fresh.entry.status.id}) and its record? This cannot be undone.`)) return "stay";
    await manager.delete({ id: fresh.entry.status.id }, managerContext("subagents-command", context));
    ui.notify(`Deleted subagent ${fresh.entry.status.id}.`, "info");
    return "deleted";
  }
  if (action === "Copy branch" && fresh.entry.status.worktree) { await copyArtifact(clipboard, ui, fresh.entry.status.worktree.branch, "branch"); return "stay"; }
  if (action === "Copy worktree path" && fresh.entry.status.worktree) { await copyArtifact(clipboard, ui, fresh.entry.status.worktree.path, "worktree path"); return "stay"; }
  if (action === "Open prompt in editor" && fresh.entry.request?.prompt !== undefined) { await ui.openArtifact(workflowPromptArtifact(fresh.entry.request.prompt), "agent prompt"); return "stay"; }
  if (action === "Open system prompt in editor") { const systemPrompt = liveSystemPrompt(manager, fresh.entry.status); if (systemPrompt !== undefined) { await ui.openArtifact(workflowPromptArtifact(systemPrompt), "agent system prompt"); return "stay"; } }
  if (action === "Open result in editor" && Object.prototype.hasOwnProperty.call(fresh.record, "value") && jsonValue(fresh.record.value)) { await ui.openArtifact(workflowResultArtifact(fresh.record.value), "agent result"); return "stay"; }
  if (action === "Steer") {
    const message = await ui.editText("Steer subagent");
    if (message === undefined) return "stay";
    await steerSubagent(manager, storageDirectory, id, context, message, ui);
    return "stay";
  }
  if (action === "Stop") {
    if (!await ui.confirm("Stop subagent?", `Stop subagent ${entryName(fresh.entry)} (${fresh.entry.status.id})? This cannot be undone.`)) return "stay";
    const current = await inspectEntry(manager, storageDirectory, id, context);
    if (current.entry.status.state !== "running") throw new Error(`Subagent ${id} is no longer running`);
    await manager.stop({ id }, managerContext("subagents-command", context));
    ui.notify(`Stopped subagent ${id}.`, "info");
    return "stay";
  }
  const request = fresh.entry.request;
  if (action === "Retry" || (action === "Edit and retry" && request !== undefined)) {
    const edits: { prompt?: string; model?: string; retries?: number } = {};
    // Edit and retry: the prompt, then the model and the retries count; an empty answer keeps the value, a cancel retries nothing.
    if (action === "Edit and retry" && request !== undefined) {
      const prompt = await ui.editText("Edit and retry: prompt", request.prompt);
      if (prompt === undefined) return "stay";
      const model = (await ui.input(`Model, empty keeps ${request.model ?? "the current one"}`, "provider/model:thinking or alias[:thinking]"))?.trim();
      if (model === undefined) return "stay";
      const retries = (await ui.input(`Retries from 0 to ${String(SUBAGENT_MAX_RETRIES)}, empty keeps ${request.retries === undefined ? "the current count" : String(request.retries)}`))?.trim();
      if (retries === undefined) return "stay";
      if (prompt !== request.prompt) edits.prompt = prompt;
      if (model !== "") edits.model = model;
      if (retries !== "") edits.retries = Number(retries);
    }
    const current = await inspectEntry(manager, storageDirectory, id, context);
    if (current.entry.status.state !== "failed" && current.entry.status.state !== "stopped") throw new Error(`Subagent ${id} is no longer retryable`);
    const result = retryResult(await manager.retry({ id }, managerContext("subagents-command", context, false, false), action === "Edit and retry" ? edits : undefined));
    if (!result) throw new Error("Retry returned an invalid subagent result");
    ui.notify(`Retried subagent ${id} as ${result.id}.`, "info");
    return { retryId: result.id };
  }
  return "stay";
}

interface SubagentActionDependencies {
  readonly manager: SubagentManager;
  readonly storageDirectory: string;
  readonly clipboard: (value: string) => Promise<void>;
}

/** The actions of a subagent (today's /subagents menu without Back) and of the Subagents group (the bulk deletions). */
export function createSubagentActionProvider({ manager, storageDirectory, clipboard }: SubagentActionDependencies, context: ExtensionCommandContext): AgentsActionProvider {
  const labels = async (target: AgentsActionTarget): Promise<string[]> => {
    if (target.kind === "subagents") return bulkDeleteLabels(manager, await loadEntries(manager, storageDirectory, context));
    if (target.kind !== "subagent") return [];
    const options = actionOptions(manager, await inspectEntry(manager, storageDirectory, target.id, context), context, VISIBILITY_UI);
    return options.filter((label) => label !== "Back");
  };
  return {
    async actions(target) {
      return (await labels(target)).map(agentsAction);
    },
    async run(target, label, ui) {
      try {
        if (!(await labels(target)).includes(label)) throw new Error(`Action ${label} is no longer available`);
        if (target.kind === "subagent") {
          const outcome = await performAction(manager, storageDirectory, target.id, label, context, ui, clipboard, true);
          return typeof outcome === "object" ? { select: `subagent:${outcome.retryId}` } : {};
        }
        // Only the group is left: labels() offers it the bulk deletions alone.
        const state = BULK_DELETE[label];
        if (state !== undefined) await deleteAll(manager, storageDirectory, context, state, ui);
      } catch (error) {
        ui.notify(`Cannot ${label.toLowerCase()}: ${errorText(error)}`, "warning");
      }
      return {};
    },
  };
}

type Request = Awaited<ReturnType<typeof loadRequest>>;
/** The request labels read so far, kept across presenters (each /agents refresh builds a new one) per storage directory, which a registration of the extension fixes. */
const REQUEST_CACHES = new Map<string, Map<string, Request>>();

/** The /subagents list names and detail rows of the subagents the session source lists and inspects. */
export function createSubagentPresenter({ storageDirectory }: Omit<SubagentActionDependencies, "clipboard">, context: ExtensionCommandContext): SubagentPresenter {
  const cache = REQUEST_CACHES.get(storageDirectory) ?? new Map<string, Request>();
  REQUEST_CACHES.set(storageDirectory, cache);
  return {
    async describe(ids, listed, inspected) {
      // Forget the requests of subagents the list no longer has.
      for (const id of [...cache.keys()]) if (!listed.some((status) => status.id === id)) cache.delete(id);
      // request.json is written once, before the run is listed: each one is read once, a failed read too.
      const requests = await Promise.all(listed.map(async (status): Promise<Request> => {
        const known = cache.get(status.id);
        if (known !== undefined) return known;
        const loaded = await loadRequest(storageDirectory, status.id);
        cache.set(status.id, loaded);
        return loaded;
      }));
      const sessionId = context.sessionManager.getSessionId();
      // An inspection that names another subagent or session counts as failed: the listed row stands in, without a record.
      const inspections = new Map(listed.map((listedStatus, index): [string, Inspection] => {
        const own = inspectionValue(inspected.get(listedStatus.id));
        const valid = own !== undefined && own.status.id === listedStatus.id && own.status.sessionId === sessionId ? own : undefined;
        const request = requests[index] ?? {};
        const entry: NavigatorEntry = { status: valid?.status ?? listedStatus, ...(request.request === undefined ? {} : { request: request.request }), ...(request.error === undefined ? {} : { requestError: request.error }) };
        return [listedStatus.id, { entry, record: valid?.record ?? {} }];
      }));
      // Twin names among all of the session's subagents.
      const entries = [...inspections.values()].map(({ entry }) => entry);
      const names = new Map(listNames(entries).map((name, index) => [entries[index]?.status.id ?? "", name]));
      return new Map(ids.flatMap((id): [string, SubagentPresentation][] => {
        const inspection = inspections.get(id);
        return inspection === undefined ? [] : [[id, { name: names.get(id) ?? "", details: (styles, now) => detailRows(inspection, styles, now) }]];
      }));
    },
  };
}
