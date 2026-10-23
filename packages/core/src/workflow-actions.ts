import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { agentsAction, type ActionUi, type AgentsActionProvider, type AgentsActionTarget } from "./agents-actions-contract.js";
import { failureDiagnosticsFrom, formatWorkflowFailureDelivery, formatWorkflowFailureDeliveryFallback } from "./host-delivery.js";
import type { WorkflowNavigatorDependencies } from "./host-navigator.js";
import { agentActionLabels, visibleAgentAttemptActions as visibleRegisteredAgentAttemptActions } from "./host-view.js";
import { worktreeDiff, worktreeHasUntracked } from "./agent-worktree.js";
import { listRunIds, RunStore, type AwaitingCheckpoint, type PersistedRun, type WorktreeReference } from "./persistence.js";
import { runDependencyIds } from "./retention.js";
import type { AgentAttemptAction, AgentAttemptActionContext, AgentAttemptActionUi, AgentRecord, JsonValue, LaunchSnapshot } from "./types.js";
import { deepFreeze, errorText, resolveModelReference, validateModelAliases } from "./utils.js";
import { resolveWorkflowSettings, saveModelAliases, workflowProjectSettingsPath, workflowSettingsPath } from "./validation.js";
import { workflowPromptArtifact, workflowResultArtifact, workflowScriptArtifact } from "./workflow-artifacts.js";
import { latestAttempt } from "../subagents/src/decode.js";

/**
 * The actions /workflow offers on a run and on a workflow agent: their labels per run
 * state and mode, and what each one does. The /agents workspace runs them through createWorkflowActionProvider, the
 * /workflow picker and its dashboard outside the TUI through the functions below; everything they ask of the person goes
 * through an ActionUi.
 */
export type WorkflowActionDependencies = Pick<WorkflowNavigatorDependencies, "home" | "clipboard" | "extensionAgentDir" | "runs" | "terminalRunStates" | "hardTerminalRunStates" | "answerCheckpoint" | "recovery" | "stopWorkflowRun" | "moveForegroundToBackground" | "isForegroundAttached" | "liveAgents" | "registry" | "projectTrusted" | "resumeHostContext" | "resumeSelectedWorkflow" | "coordinateRunMutation">;
export type ReportBlocked = (active: boolean, label?: string) => void;
export type WorkflowStoredRun = { store: RunStore; loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> }; resolvedAt: number | undefined };
/** What the /workflow dashboard does after an action: show the run again or go back to the picker. */
type WorkflowActionOutcome = "dashboard" | "picker";
type RunDependencies = ReadonlyMap<string, readonly string[]>;
type ManualDeletionPlan = { ordered: readonly WorkflowStoredRun[]; skipped: readonly { entry: WorkflowStoredRun; dependentIds: readonly string[] }[] };

function dependencyClosure(runId: string, dependencies: RunDependencies): ReadonlySet<string> {
  const closure = new Set<string>();
  const pending = [runId];
  while (pending.length) {
    const current = pending.pop();
    if (current === undefined) continue;
    for (const dependency of dependencies.get(current) ?? []) {
      if (closure.has(dependency)) continue;
      closure.add(dependency);
      pending.push(dependency);
    }
  }
  return closure;
}
async function runDependencies(entries: readonly WorkflowStoredRun[]): Promise<RunDependencies> {
  const dependencies = new Map<string, readonly string[]>();
  for (const entry of entries) dependencies.set(entry.loaded.run.id, runDependencyIds(entry.loaded.run, await entry.store.borrowedWorktrees()));
  return dependencies;
}
function dependentRunId(targetRunId: string, entries: readonly WorkflowStoredRun[], dependencies: RunDependencies): string | undefined {
  for (const entry of entries) {
    if (entry.store.runId !== targetRunId && dependencyClosure(entry.store.runId, dependencies).has(targetRunId)) return entry.store.runId;
  }
  return undefined;
}
export function manualDeletionPlan(entries: readonly WorkflowStoredRun[], state: "completed" | "failed", dependencies: RunDependencies): ManualDeletionPlan {
  const candidates = new Set(entries.filter(({ loaded }) => loaded.run.state === state).map(({ store }) => store.runId));
  const protectedRuns = new Set<string>();
  for (const entry of entries) {
    if (candidates.has(entry.store.runId)) continue;
    for (const dependency of dependencyClosure(entry.store.runId, dependencies)) if (candidates.has(dependency)) protectedRuns.add(dependency);
  }
  const skipped = entries.filter(({ store }) => candidates.has(store.runId) && protectedRuns.has(store.runId)).map((entry) => ({ entry, dependentIds: entries.filter((candidate) => !candidates.has(candidate.store.runId) && dependencyClosure(candidate.store.runId, dependencies).has(entry.store.runId)).map(({ store }) => store.runId) }));
  const remaining = new Set([...candidates].filter((runId) => !protectedRuns.has(runId)));
  const ordered: WorkflowStoredRun[] = [];
  while (remaining.size) {
    const next = entries.find((entry) => remaining.has(entry.store.runId) && ![...remaining].some((childId) => (dependencies.get(childId) ?? []).includes(entry.store.runId)));
    if (!next) throw new Error("Run dependency cycle prevents safe deletion");
    ordered.push(next);
    remaining.delete(next.store.runId);
  }
  return { ordered, skipped };
}
function formatSkippedDeletion(skipped: ManualDeletionPlan["skipped"]): string {
  return skipped.map(({ entry, dependentIds }) => `${entry.store.runId} (needed by ${dependentIds.join(", ") || "a surviving workflow"})`).join(", ");
}

export async function confirmWithBlocked(ui: { confirm(title: string, message: string): Promise<boolean> }, reportBlocked: ReportBlocked | undefined, title: string, message: string): Promise<boolean> {
  reportBlocked?.(true, title);
  try { return await ui.confirm(title, message); }
  finally { reportBlocked?.(false); }
}

/**
 * The session's runs. `cleanup` (the /workflow command and the deletions) also removes abandoned temporary run
 * directories and incomplete runs that cannot be read; a display read leaves them alone.
 */
export async function loadWorkflowStores(deps: Pick<WorkflowActionDependencies, "home" | "liveAgents">, ctx: ExtensionContext, cleanup: boolean): Promise<WorkflowStoredRun[]> {
  const sessionId = ctx.sessionManager.getSessionId();
  const entries = await Promise.all((await listRunIds(ctx.cwd, sessionId, deps.home, cleanup)).map(async (runId) => {
    const store = new RunStore(ctx.cwd, sessionId, runId, deps.home);
    try {
      const loaded = await store.load();
      const summary = await store.loadSummary().catch(() => undefined);
      const terminalAt = summary?.terminalAt === undefined ? undefined : Date.parse(summary.terminalAt);
      return { store, loaded: { ...loaded, run: deps.liveAgents.overlay(loaded.run) }, resolvedAt: terminalAt !== undefined && Number.isFinite(terminalAt) ? terminalAt : undefined };
    }
    catch { if (cleanup && !await store.isComplete()) await store.delete(true).catch(() => undefined); return undefined; }
  }));
  return entries.filter((entry): entry is WorkflowStoredRun => entry !== undefined);
}

/** A run as its actions see it: the live run, its labels in menu order with the command each one runs, the copies and the checkpoint reviews. */
type WorkflowRunView = {
  readonly store: RunStore;
  readonly run: PersistedRun;
  readonly snapshot: Readonly<LaunchSnapshot>;
  readonly worktrees: readonly WorktreeReference[];
  readonly agentResults: ReadonlyMap<string, JsonValue>;
  readonly actions: ReadonlyMap<string, string>;
  readonly copies: ReadonlyMap<string, { readonly value: string; readonly artifact: string }>;
  readonly reviews: ReadonlyMap<string, AwaitingCheckpoint>;
};
/** `agentId`: the agent whose journaled result the TUI may open; no other journal entry is read. */
export async function loadWorkflowRunView(deps: WorkflowActionDependencies, ctx: ExtensionContext, store: RunStore, agentId?: string): Promise<WorkflowRunView> {
  const loaded = await store.load();
  const activeRun = deps.runs.get(store.runId);
  const liveRun = deps.liveAgents.overlay({ ...loaded.run, ...(activeRun ? { usage: activeRun.budget.usage } : {}) });
  const checkpoints = await store.awaitingCheckpoints();
  const worktrees = await store.worktrees();
  const agentResults = new Map<string, JsonValue>();
  const agent = ctx.mode === "tui" && agentId !== undefined ? liveRun.agents.find((candidate) => candidate.id === agentId) : undefined;
  if (agent?.state === "completed" && !agent.parentId && agent.resultPath) {
    const operation = await store.replay(agent.resultPath).catch(() => undefined);
    if (operation) agentResults.set(agent.id, operation.value);
  }
  const actions = new Map<string, string>();
  const copies = new Map<string, { value: string; artifact: string }>();
  const reviews = new Map<string, AwaitingCheckpoint>();
  const add = (label: string, value: string) => { actions.set(label, `${value} ${store.runId}`); };
  const addCopy = (label: string, value: string, artifact: string) => { actions.set(label, "copy"); copies.set(label, { value, artifact }); };
  if (liveRun.state === "running") add("Pause", "pause");
  if (liveRun.state === "pausing") add("Cancel pause", "cancel-pause");
  if (["paused", "interrupted"].includes(liveRun.state)) add("Resume", "resume");
  if (liveRun.state === "budget_exhausted") { actions.set("Resume unchanged", `resume ${store.runId}`); actions.set("Adjust budget", `adjust ${store.runId}`); }
  for (const decision of await store.pendingWorkflowDecisions()) {
    const id = decision.proposalId.slice(0, 8);
    actions.set(`Approve budget ${id}`, `budget-approve ${store.runId} ${decision.proposalId}`);
    actions.set(`Reject budget ${id}`, `budget-reject ${store.runId} ${decision.proposalId}`);
  }
  if (deps.isForegroundAttached(store.runId)) actions.set("Move to background", `background ${store.runId}`);
  if (!deps.hardTerminalRunStates.has(liveRun.state)) add("Stop", "stop");
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
  else actions.set("Open script in editor", "open-script");
  if (ctx.mode !== "tui" && liveRun.agents.length) actions.set("Agents...", "agents");
  if (deps.hardTerminalRunStates.has(liveRun.state)) add("Delete", "delete");
  if (ctx.mode === "tui") {
    addCopy("Copy run path", store.directory, "run path");
    addCopy("Copy run ID", store.runId, "run ID");
  }
  return { store, run: liveRun, snapshot: loaded.snapshot, worktrees, agentResults, actions, copies, reviews };
}

/** Copies `value` and reports it, a failure too, the same for a workflow agent and a subagent. */
export async function copyArtifact(clipboard: WorkflowActionDependencies["clipboard"], ui: Pick<ActionUi, "notify">, value: string, artifact: string): Promise<void> {
  try {
    await clipboard(value);
    ui.notify(`Copied ${artifact}.`, "info");
  } catch (error) {
    ui.notify(`Failed to copy ${artifact}: ${errorText(error)}`, "error");
  }
}

function agentWorktree(view: WorkflowRunView, agent: AgentRecord): WorktreeReference | undefined {
  return agent.worktreeOwner ? view.worktrees.find((candidate) => candidate.owner === agent.worktreeOwner) : undefined;
}
//NOTE: visible() decides from the run, the agent and its attempt; the ui of the context it receives is never used for a dialog.
export const VISIBILITY_UI: AgentAttemptActionUi = Object.freeze({ notify() {}, confirm: async () => false, select: async () => undefined, input: async () => undefined });
/** The ui a registered agent-attempt action runs with, over the ActionUi of its run. */
export function attemptActionUi(ui: ActionUi): AgentAttemptActionUi {
  return { notify: (message, level = "info") => { ui.notify(message, level); }, confirm: (title, message) => ui.confirm(title, message), select: (title, options) => ui.select(title, options), input: (title, placeholder) => ui.input(title, placeholder), setWorkingMessage: (message) => { ui.setWorkingMessage(message); } };
}
/**
 * The ui of a registered agent-attempt action the TUI workspace starts detached: the workspace opens again at once, so a
 * Pi dialog would draw over it or never be answered. Each dialog is refused with one notice and answered as cancelled.
 */
export function detachedAttemptActionUi(ui: ActionUi, owner: object): AgentAttemptActionUi {
  const refuse = (title: string): void => { ui.notify(`Refused "${title}": an action started from the agents workspace cannot use Pi's dialogs.`, "warning"); };
  return { ...attemptActionUi(ui), setWorkingMessage: (message) => { ui.setWorkingMessage(message, owner); }, confirm: async (title) => { refuse(title); return false; }, select: async (title) => { refuse(title); return undefined; }, input: async (title) => { refuse(title); return undefined; } };
}
function agentAttemptActionContext(deps: Pick<WorkflowActionDependencies, "liveAgents" | "runs">, view: WorkflowRunView, agent: AgentRecord, ui: AgentAttemptActionUi): AgentAttemptActionContext | undefined {
  const attempt = latestAttempt(agent.attemptDetails);
  if (!attempt) return undefined;
  const liveAgent = deps.liveAgents.get(view.run.id, agent.id);
  const liveCandidate = liveAgent?.session;
  const live = liveCandidate && attempt.session && liveCandidate.reference.transport === attempt.session.transport && liveCandidate.reference.sessionId === attempt.session.sessionId ? liveCandidate : undefined;
  const run = deps.runs.get(view.run.id);
  const attemptSnapshot = deepFreeze(structuredClone(attempt));
  const prepared = live ? liveAgent?.prepared : undefined;
  const handoff = live ? liveAgent?.handoff : undefined;
  return { run: deepFreeze(structuredClone(view.run)), agent: deepFreeze(structuredClone(agent)), attempt: attemptSnapshot, ...(attemptSnapshot.session ? { session: attemptSnapshot.session } : {}), ...(live ? { liveSession: live } : {}), ...(prepared ? { prepared } : {}), ...(handoff ? { handoff } : {}), signal: run?.abortController.signal ?? new AbortController().signal, ui: Object.freeze(ui) };
}
/** The registered agent-attempt actions visible on the agent's latest attempt. */
export function visibleAgentAttemptActions(deps: Pick<WorkflowActionDependencies, "liveAgents" | "runs" | "registry">, view: WorkflowRunView, agent: AgentRecord): readonly [string, AgentAttemptAction][] {
  const context = agentAttemptActionContext(deps, view, agent, VISIBILITY_UI);
  return context ? visibleRegisteredAgentAttemptActions(deps.registry.agentAttemptActions(), context) : [];
}
/** The agent's labels in menu order, Back last. */
export function agentActionOptions(deps: WorkflowActionDependencies, ctx: ExtensionContext, view: WorkflowRunView, agent: AgentRecord): string[] {
  const worktree = agentWorktree(view, agent);
  const labels = agentActionLabels({
    extensionLabels: visibleAgentAttemptActions(deps, view, agent).map(([, action]) => action.label),
    hasWorktree: worktree !== undefined,
    openPrompt: ctx.mode === "tui" && agent.prompt !== undefined,
    openSystemPrompt: ctx.mode === "tui" && agent.systemPrompt !== undefined,
    openResult: ctx.mode === "tui" && view.agentResults.has(agent.id),
  });
  const at = labels.indexOf("Copy worktree path");
  if (ctx.mode === "tui" && worktree && at >= 0) labels.splice(at + 1, 0, "Open diff in editor");
  return labels;
}
/** Runs one of the agent's labels other than Back; a label it does not know does nothing. `detached` (the TUI workspace): a registered action is started, not awaited. */
export async function runAgentAction(deps: WorkflowActionDependencies, ui: ActionUi, view: WorkflowRunView, agent: AgentRecord, label: string, detached = false): Promise<void> {
  const worktree = agentWorktree(view, agent);
  if (label === "Open prompt in editor") { if (agent.prompt !== undefined) await ui.openArtifact(workflowPromptArtifact(agent.prompt), "agent prompt"); return; }
  if (label === "Open system prompt in editor") { if (agent.systemPrompt !== undefined) await ui.openArtifact(workflowPromptArtifact(agent.systemPrompt), "agent system prompt"); return; }
  if (label === "Open result in editor") {
    const result = view.agentResults.get(agent.id);
    if (result !== undefined) await ui.openArtifact(workflowResultArtifact(result), "agent result");
    return;
  }
  if (label === "Open diff in editor" && worktree) {
    let diff: string;
    try { diff = await worktreeDiff(worktree); }
    catch (error) { ui.notify(`Cannot read the worktree diff: ${errorText(error)}`, "warning"); return; }
    if (diff.trim() === "") ui.notify(await worktreeHasUntracked(worktree).catch(() => false) ? "No tracked changes since the worktree was created; untracked files are not in the diff." : "No changes since the worktree was created.", "info");
    else await ui.openArtifact({ extension: ".diff", content: diff }, "worktree diff");
    return;
  }
  if (label === "Copy agent ID") { await copyArtifact(deps.clipboard, ui, agent.id, "agent ID"); return; }
  if (label === "Copy branch" && worktree) { await copyArtifact(deps.clipboard, ui, worktree.branch, "branch"); return; }
  if (label === "Copy worktree path" && worktree) { await copyArtifact(deps.clipboard, ui, worktree.path, "worktree path"); return; }
  const extensionAction = visibleAgentAttemptActions(deps, view, agent).find(([, candidate]) => candidate.label === label);
  const owner = {};
  const context = extensionAction ? agentAttemptActionContext(deps, view, agent, detached ? detachedAttemptActionUi(ui, owner) : attemptActionUi(ui)) : undefined;
  if (!extensionAction || !context) return;
  const running = (async () => {
    try { await extensionAction[1].run(context); }
    catch (error) { ui.notify(`Agent attempt action failed: ${errorText(error)}`, "error"); }
    finally { if (detached) ui.setWorkingMessage(undefined, owner); }
  })();
  // The workspace opens again at once, as the /workflow dashboard ran these: a Herdr pane must not hold it, the loop or Pi.
  if (!detached) await running;
}

/** `view`: the run as loaded to offer the action; only a delete loads it again, since a run can leave its terminal state. */
async function runAction(deps: WorkflowActionDependencies, ctx: ExtensionContext, ui: ActionUi, view: WorkflowRunView, actionCommand: string): Promise<WorkflowActionOutcome> {
  const { runs, terminalRunStates, hardTerminalRunStates } = deps;
  const coordinateRunMutation = deps.coordinateRunMutation ?? (<T>(task: () => Promise<T>): Promise<T> => task());
  const [action, runId, ...rest] = actionCommand.split(/\s+/);
  try {
    const run = runId ? runs.get(runId) : undefined;
    const stored = runId === view.store.runId ? { store: view.store, loaded: action === "delete" ? await view.store.load() : view } : undefined;
    if (action === "background" && runId) {
      const result = await deps.moveForegroundToBackground(runId);
      ui.notify(`Moved workflow ${result.runId} to background.`, "info");
      return "dashboard";
    }
    if ((action === "approve" || action === "reject") && runId && rest.length) {
      const accepted = await deps.answerCheckpoint(runId, rest.join(" "), action === "approve", true);
      ui.notify(accepted ? `${action === "approve" ? "Approved" : "Rejected"} checkpoint ${rest.join(" ")}.` : "Checkpoint is not awaiting a response.", accepted ? "info" : "warning");
      return "dashboard";
    }
    if ((action === "budget-approve" || action === "budget-reject") && runId && rest[0]) {
      const result = await deps.recovery.answerBudgetDecision(runId, rest[0], action === "budget-approve", true, ctx, undefined, false);
      ui.notify(result ? `Budget adjustment ${rest[0]} ${result.approved ? "approved" : "rejected"}.` : "Budget proposal is not pending.", result ? "info" : "warning");
      return "dashboard";
    }
    if (action === "delete" && stored) {
      if (!hardTerminalRunStates.has(stored.loaded.run.state)) { ui.notify("Stop the workflow before deleting it.", "warning"); return "dashboard"; }
      if (!await ui.confirm("Delete workflow?", `Delete ${stored.loaded.run.workflowName} (${stored.store.runId}) and all owned artifacts? This cannot be undone.`)) return "dashboard";
      const deleted = await coordinateRunMutation(async () => {
        const currentStores = await loadWorkflowStores(deps, ctx, true);
        const current = currentStores.find(({ store: candidate }) => candidate.runId === stored.store.runId);
        if (!current) { ui.notify(`Workflow ${stored.store.runId} is no longer available.`, "warning"); return false; }
        if (!hardTerminalRunStates.has(current.loaded.run.state)) { ui.notify("Stop the workflow before deleting it.", "warning"); return false; }
        const dependencies = await runDependencies(currentStores);
        const dependent = dependentRunId(current.store.runId, currentStores, dependencies);
        if (dependent) {
          const dependentEntry = currentStores.find(({ store: candidate }) => candidate.runId === dependent);
          ui.notify(`Cannot delete workflow ${current.store.runId}: surviving workflow ${dependent}${dependentEntry ? ` (${dependentEntry.loaded.run.workflowName})` : ""} depends on it.`, "warning");
          return false;
        }
        await current.store.delete(true);
        runs.delete(current.store.runId);
        terminalRunStates.delete(current.store.runId);
        ui.notify(`Deleted workflow ${current.store.runId}.`, "info");
        return true;
      });
      return deleted ? "picker" : "dashboard";
    }
    if (action === "pause" && run) {
      await run.lifecycle.pause();
      ui.notify(run.lifecycle.state === "pausing" ? `Pausing workflow ${run.store.runId}; it pauses once the active operation finishes.` : `Paused workflow ${run.store.runId}.`, "info");
      return "dashboard";
    }
    if (action === "cancel-pause" && run?.lifecycle.state === "pausing") { await run.lifecycle.resume(); ui.notify(`Cancelled the pending pause of workflow ${run.store.runId}.`, "info"); return "dashboard"; }
    if (action === "stop" && run) {
      const workflowName = stored?.loaded.run.workflowName ?? run.metadata.name;
      if (!await ui.confirm("Stop workflow?", `Stop workflow ${workflowName} (${run.store.runId})? This cannot be undone.`)) return "dashboard";
      ui.status(`Stopping workflow ${workflowName}...`);
      await deps.stopWorkflowRun(run.store.runId);
      ui.status(`Workflow ${run.store.runId} stopped.`);
      ui.notify(`Stopped workflow ${run.store.runId}.`, "info"); return "dashboard";
    }
    if (action && runId) ui.notify(`Cannot ${action} workflow ${runId}: the run is no longer available.`, "warning");
    else ui.notify("Workflow action is no longer available.", "warning");
    return "dashboard";
  } catch (error) {
    const message = errorText(error);
    if (action === "stop") ui.status(`Could not stop workflow ${runId ?? ""}: ${message}`);
    ui.notify(`Cannot ${action ?? "workflow action"}${runId ? ` for ${runId}` : ""}: ${message}`, "warning");
    return "dashboard";
  }
}

async function resumeWorkflow(deps: WorkflowActionDependencies, ctx: ExtensionContext, ui: ActionUi, view: WorkflowRunView, label: string): Promise<void> {
  const { store } = view;
  const mode = await ui.select(`Resume ${view.run.workflowName}`, ["Foreground", "Background", "Cancel"]);
  if (!mode || mode === "Cancel") return;
  let budgetPatch: unknown;
  if (view.run.state === "budget_exhausted") {
    if (label === "Adjust budget") {
      const input = await ui.input("Budget patch (JSON)", "{\"tokens\":{\"hard\":null}}");
      if (input === undefined) return;
      try { budgetPatch = JSON.parse(input); } catch (error) { ui.notify(`Cannot parse budget patch: ${errorText(error)}`, "warning"); return; }
    }
  }
  try {
    const result = await deps.resumeSelectedWorkflow(store.runId, mode === "Foreground", ctx, budgetPatch);
    if (result.state === "completed" && !result.attached) ui.notify(`Workflow ${result.workflowName} completed${result.value === undefined ? "." : `: ${JSON.stringify(result.value)}`}`, "info");
    else if (result.state === "awaiting_approval") ui.notify(`Budget adjustment for ${result.workflowName} is awaiting approval.`, "warning");
    else if (result.state === "running") ui.notify(`Resumed workflow ${result.workflowName} in ${mode.toLowerCase()}.`, "info");
  } catch (error) {
    if (error && typeof error === "object" && "workflowResumeAttached" in error && error.workflowResumeAttached === true) return;
    const diagnostic = failureDiagnosticsFrom(error);
    const message = diagnostic ? formatWorkflowFailureDelivery(diagnostic) : formatWorkflowFailureDeliveryFallback(view.run.workflowName, store.runId, store.directory, error);
    ui.notify(`Cannot resume workflow ${store.runId}: ${message}`, "warning");
  }
}

/** Runs one of the run's labels from `view` (Refresh and Agents... are the rpc dashboard's own); a label the view does not offer is reported. */
export async function runWorkflowRunAction(deps: WorkflowActionDependencies, ctx: ExtensionContext, ui: ActionUi, view: WorkflowRunView, label: string): Promise<WorkflowActionOutcome> {
  if (["Resume", "Resume unchanged", "Adjust budget"].includes(label)) { await resumeWorkflow(deps, ctx, ui, view, label); return "dashboard"; }
  const copy = view.copies.get(label);
  if (copy) { await copyArtifact(deps.clipboard, ui, copy.value, copy.artifact); return "dashboard"; }
  const checkpoint = view.reviews.get(label);
  if (checkpoint) {
    const decision = await ui.reviewCheckpoint(checkpoint);
    if (decision) {
      const accepted = await deps.answerCheckpoint(view.store.runId, checkpoint.name, decision === "Approve", true);
      if (!accepted) ui.notify("Checkpoint is not awaiting a response.", "warning");
    }
    return "dashboard";
  }
  if (label === "Open script in editor") {
    let script: string;
    try { script = await readFile(join(view.store.directory, "workflow.js"), "utf8"); }
    catch (error) { ui.notify(`Cannot open workflow script: ${errorText(error)}`, "warning"); return "dashboard"; }
    await ui.openArtifact(workflowScriptArtifact(script), "workflow script");
    return "dashboard";
  }
  const actionCommand = view.actions.get(label);
  if (!actionCommand) { ui.notify(`Cannot select workflow action: ${label}`, "warning"); return "dashboard"; }
  return runAction(deps, ctx, ui, view, actionCommand);
}

export async function deleteBulkRuns(deps: WorkflowActionDependencies, ctx: ExtensionContext, ui: ActionUi, state: "completed" | "failed"): Promise<void> {
  const coordinateRunMutation = deps.coordinateRunMutation ?? (<T>(task: () => Promise<T>): Promise<T> => task());
  const label = state === "failed" ? "failed" : "completed";
  const title = state === "failed" ? "Delete failed runs?" : "Delete completed runs?";
  const message = `Delete all ${label} workflow runs and their artifacts? This cannot be undone.`;
  if (!await ui.confirm(title, message)) return;
  try {
    await coordinateRunMutation(async () => {
      const currentStores = await loadWorkflowStores(deps, ctx, true);
      const dependencies = await runDependencies(currentStores);
      const plan = manualDeletionPlan(currentStores, state, dependencies);
      for (const entry of plan.ordered) {
        await entry.store.delete(true);
        deps.runs.delete(entry.store.runId);
        deps.terminalRunStates.delete(entry.store.runId);
      }
      if (plan.skipped.length) ui.notify(`Skipped ${label} runs required by surviving workflows: ${formatSkippedDeletion(plan.skipped)}.`, "warning");
      if (plan.ordered.length) ui.notify(`Deleted ${String(plan.ordered.length)} ${label} workflow run(s).`, "info");
    });
  } catch (error) {
    ui.notify(`Cannot delete ${label} runs: ${errorText(error)}`, "warning");
  }
}

export async function manageAliases(deps: WorkflowActionDependencies, ctx: ExtensionContext, ui: ActionUi): Promise<void> {
  const settingsPath = workflowSettingsPath(deps.extensionAgentDir);
  let aliasSettingsPath = settingsPath;
  const trustedProject = deps.projectTrusted(ctx);
  const modelRegistry = deps.resumeHostContext(ctx).modelRegistry;
  const available = () => [...new Set((modelRegistry?.getAvailable?.() ?? []).map((model) => `${model.provider}/${model.id}`))].sort();
  const selectTarget = async (aliases: Readonly<Record<string, string>>): Promise<string | undefined> => {
    const models = available();
    const choice = await ui.select("Model alias target", [...models, ...Object.keys(aliases).sort(), "Manual model ID", "Back"]);
    if (!choice || choice === "Back") return undefined;
    if (choice !== "Manual model ID") return choice;
    return (await ui.input("Manual model ID", "provider/model[:thinking] or alias[:thinking]"))?.trim() || undefined;
  };
  const save = (aliases: Readonly<Record<string, string>>): boolean => {
    try { saveModelAliases(aliasSettingsPath, aliases); ui.notify(`Saved model aliases to ${aliasSettingsPath}.`, "info"); return true; }
    catch (error) { ui.notify(`${aliasSettingsPath}: ${errorText(error)}`, "error"); return false; }
  };
  for (;;) {
    let aliases: Readonly<Record<string, string>>;
    try { const resolution = resolveWorkflowSettings(ctx.cwd, trustedProject, settingsPath); aliases = resolution.effective.modelAliases ?? {}; aliasSettingsPath = resolution.sources.modelAliases; }
    catch (error) { ui.notify(`${trustedProject ? workflowProjectSettingsPath(ctx.cwd) : settingsPath}: ${errorText(error)}`, "error"); return; }
    const names = Object.keys(aliases).sort();
    const listing = names.length ? names.map((name) => `${name} = ${aliases[name] ?? ""}`).join("\n") : "(none)";
    const options = ["Add alias", ...names.map((name) => `Edit ${name}`), ...names.map((name) => `Delete ${name}`), "Back"];
    const choice = await ui.select(`Model aliases\n${listing}`, options);
    if (!choice || choice === "Back") return;
    // Add alias asks for the new name, Edit <name> has it; then both choose and check the target alike.
    const adding = choice === "Add alias";
    const name = adding ? (await ui.input("Alias name", "reviewer-model"))?.trim() : /^Edit (.+)$/.exec(choice)?.[1];
    if (adding && !name) continue;
    if (name) {
      if (adding && Object.prototype.hasOwnProperty.call(aliases, name)) { ui.notify(`Alias ${name} already exists; choose Edit ${name}.`, "warning"); continue; }
      const target = await selectTarget(aliases);
      if (!target) continue;
      const next = { ...aliases, [name]: target };
      try { validateModelAliases(next, aliasSettingsPath); } catch (error) { ui.notify(`${aliasSettingsPath}: ${errorText(error)}`, "error"); continue; }
      const parsed = resolveModelReference(target, next, new Set(available()), aliasSettingsPath);
      if (!available().includes(`${parsed.provider}/${parsed.model}`)) {
        ui.notify(`Warning: ${target} is not currently available in Pi.`, "warning");
        if (!await ui.confirm("Save unknown model?", "Save this target for cross-machine portability?")) continue;
      }
      save(next);
      continue;
    }
    const deletion = /^Delete (.+)$/.exec(choice);
    if (deletion?.[1] && await ui.confirm("Delete model alias?", `Delete ${deletion[1]}? Future workflow resumes using this alias may fail.`)) {
      const next = Object.fromEntries(Object.entries(aliases).filter(([name]) => name !== deletion[1]));
      save(next);
    }
  }
}

/**
 * The /workflow actions for the /agents workspace: a run target (its root, phases, scopes and shells) gets the run's
 * labels as the dashboard offers them in `ctx.mode`, then Model aliases and the bulk deletes the session allows; a
 * workflow agent gets its agent labels. `ctx` is only handed to the host operations that need it.
 */
export function createWorkflowActionProvider(deps: WorkflowActionDependencies, ctx: ExtensionContext): AgentsActionProvider {
  const loadView = async (runId: string, agentId?: string): Promise<WorkflowRunView | undefined> => {
    try { return await loadWorkflowRunView(deps, ctx, new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, deps.home), agentId); }
    catch { return undefined; }
  };
  // The bulk deletes need every run of the session: read again once this Pi's live runs, their states or the runs it saw end
  // change (only the Pi holding the session's lease changes runs), and after an action.
  //NOTE: a run deleted by retention keeps its bulk delete offered until then; the delete finds nothing to delete.
  let bulk: { readonly key: string; readonly labels: readonly string[] } | undefined;
  const bulkLabels = async (): Promise<readonly string[]> => {
    const key = JSON.stringify([[...deps.runs].map(([runId, run]) => [runId, run.lifecycle.state]), [...deps.terminalRunStates]]);
    if (bulk?.key === key) return bulk.labels;
    const stores = await loadWorkflowStores(deps, ctx, false);
    const labels = [...(stores.some(({ loaded }) => loaded.run.state === "completed") ? ["Delete all completed"] : []), ...(stores.some(({ loaded }) => loaded.run.state === "failed") ? ["Delete all failed"] : [])];
    bulk = { key, labels };
    return labels;
  };
  const offer = async (target: AgentsActionTarget): Promise<{ readonly labels: readonly string[]; perform(label: string, ui: ActionUi): Promise<void> } | undefined> => {
    if (target.kind === "run") {
      const view = await loadView(target.runId);
      if (!view) return undefined;
      return {
        labels: [...view.actions.keys(), "Model aliases", ...await bulkLabels()],
        async perform(label, ui) {
          if (label === "Model aliases") await manageAliases(deps, ctx, ui);
          else if (label === "Delete all completed") await deleteBulkRuns(deps, ctx, ui, "completed");
          else if (label === "Delete all failed") await deleteBulkRuns(deps, ctx, ui, "failed");
          else await runWorkflowRunAction(deps, ctx, ui, view, label);
        },
      };
    }
    if (target.kind === "workflow-agent") {
      const view = await loadView(target.runId, target.agentId);
      const agent = view?.run.agents.find((candidate) => candidate.id === target.agentId);
      if (!view || !agent) return undefined;
      return { labels: agentActionOptions(deps, ctx, view, agent).filter((label) => label !== "Back"), perform: (label, ui) => runAgentAction(deps, ui, view, agent, label, true) };
    }
    return undefined;
  };
  return {
    async actions(target) {
      //NOTE: a session directory that cannot be listed leaves the menu empty until the next read.
      try { return (await offer(target))?.labels.map(agentsAction) ?? []; }
      catch { return []; }
    },
    async run(target, label, ui) {
      // The label is checked against the run as it is now and the bulk labels the menu read; the menu reads them again after it ran.
      try {
        const current = await offer(target);
        if (current?.labels.includes(label)) await current.perform(label, ui);
        else ui.notify(`Cannot select workflow action: ${label}`, "warning");
      } catch (error) {
        ui.notify(`Cannot run ${label}: ${errorText(error)}`, "warning");
      } finally { bulk = undefined; }
      return {};
    },
  };
}
