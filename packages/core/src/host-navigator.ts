import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { type ExtensionUIContext, SettingsManager, truncateToVisualLines, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { listRunIds, RunStore, type AwaitingCheckpoint, type PersistedRun, type WorktreeReference } from "./persistence.js";
import { type WorkflowRegistryApi } from "./registry.js";
import { deepFreeze, errorText, object, resolveModelReference, validateModelAliases } from "./utils.js";
import { saveModelAliases, resolveWorkflowSettings, workflowProjectSettingsPath, workflowSettingsPath } from "./validation.js";
import { openWorkflowArtifact, workflowPromptArtifact, workflowResultArtifact, workflowScriptArtifact, type WorkflowArtifact } from "./workflow-artifacts.js";
import { agentActionLabels, agentBreadcrumb, formatCheckpointReview, formatNavigatorRun, formatWorkflowPhaseDashboard, navigatorAttentionSort, navigatorRunLabels, SETTLED_AGENT_STATES, themeWorkflowProgressStyles, visibleAgentAttemptActions as visibleRegisteredAgentAttemptActions } from "./host-view.js";
import { buildWorkflowPhaseModel, buildWorkflowPhaseTree, navigateWorkflowPhaseTree, preserveWorkflowPhaseTreeSelection, workflowPhaseTreeInitialExpanded } from "./host-phases.js";
import { type WorkflowRecoveryContext, type createWorkflowRecovery } from "./host-recovery.js";
import { failureDiagnosticsFrom, formatWorkflowFailureDelivery, formatWorkflowFailureDeliveryFallback } from "./host-delivery.js";
import { type WorkflowRunRecord } from "./host-runtime.js";
import { getTrajectoryHost, type TrajectoryPublisherProvider } from "./trajectory-host-handle.js";
import { type AgentAttemptActionContext, type AgentAttemptSummary, type AgentRecord, type JsonValue, type LaunchSnapshot } from "./types.js";

type UiSelect = (title: string, options: string[]) => Promise<string | undefined>;
type UiInput = (title: string, placeholder?: string) => Promise<string | undefined>;
type UiSetStatus = (key: string, text?: string) => void;
type UiCustom = ExtensionUIContext["custom"];
export type UiHostCapabilities = { select?: UiSelect; input?: UiInput; setStatus?: UiSetStatus; custom?: UiCustom };
type UiConfirm = (title: string, message: string) => Promise<boolean>;
type ReportBlocked = (active: boolean, label?: string) => void;
async function confirmWithBlocked(ui: { confirm: UiConfirm }, reportBlocked: ReportBlocked | undefined, title: string, message: string): Promise<boolean> {
  reportBlocked?.(true, title);
  try { return await ui.confirm(title, message); }
  finally { reportBlocked?.(false); }
}
function isUiSelect(value: unknown): value is UiSelect { return typeof value === "function"; }
function isUiInput(value: unknown): value is UiInput { return typeof value === "function"; }
function isUiSetStatus(value: unknown): value is UiSetStatus { return typeof value === "function"; }
function isUiCustom(value: unknown): value is UiCustom { return typeof value === "function"; }
function isCheckpointDecision(value: unknown): value is "Approve" | "Reject" { return value === "Approve" || value === "Reject"; }
export function uiHostCapabilities(ui: unknown): UiHostCapabilities | undefined {
  if (!object(ui)) return undefined;
  const selectValue = ui.select;
  const inputValue = ui.input;
  const setStatusValue = ui.setStatus;
  const customValue = ui.custom;
  const select = isUiSelect(selectValue) ? selectValue.bind(ui) : undefined;
  const input = isUiInput(inputValue) ? inputValue.bind(ui) : undefined;
  const setStatus = isUiSetStatus(setStatusValue) ? setStatusValue.bind(ui) : undefined;
  const custom = isUiCustom(customValue) ? customValue.bind(ui) : undefined;
  return { ...(select ? { select } : {}), ...(input ? { input } : {}), ...(setStatus ? { setStatus } : {}), ...(custom ? { custom } : {}) };
}
function tuiRows(tui: unknown): number {
  const rows = object(tui) && object(tui.terminal) ? tui.terminal.rows : undefined;
  return typeof rows === "number" && Number.isFinite(rows) ? rows : 24;
}
const WORKFLOW_PANEL_FOOTER_ROWS = 2;
const WORKFLOW_OVERLAY_BORDER_ROWS = 2;
const WORKFLOW_OVERLAY_TOP_MARGIN = 1;
const WORKFLOW_OVERLAY_OPTIONS = { anchor: "top-left", width: "100%", maxHeight: "100%", margin: { top: WORKFLOW_OVERLAY_TOP_MARGIN } } as const;
type WorkflowOverlayComponent = { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void; dispose?(): void };
function borderWorkflowOverlay(component: WorkflowOverlayComponent, theme: { fg(color: "border", text: string): string }): WorkflowOverlayComponent {
  return { ...component, render(width: number) { const border = theme.fg("border", "─".repeat(Math.max(1, width))); return [border, ...component.render(width), border]; } };
}
type KeybindingsHostCapabilities = { getKeys?: (name: string) => readonly string[] };
type KeybindingGetKeys = NonNullable<KeybindingsHostCapabilities["getKeys"]>;
function isKeybindingGetKeys(value: unknown): value is KeybindingGetKeys { return typeof value === "function"; }
function keybindingKeys(keybindings: unknown, name: string): readonly string[] | undefined {
  if (!object(keybindings)) return undefined;
  const getKeys = keybindings.getKeys;
  return isKeybindingGetKeys(getKeys) ? getKeys.call(keybindings, name) : undefined;
}
type WorkflowKeybindings = { matches(data: string, binding: string): boolean };
const WORKFLOW_VIM_KEYS: Readonly<Record<string, string>> = { "tui.select.up": "k", "tui.select.down": "j", "tui.editor.cursorLeft": "h", "tui.editor.cursorRight": "l" };
function workflowKeyMatches(keybindings: WorkflowKeybindings, data: string, binding: string): boolean { return keybindings.matches(data, binding) || WORKFLOW_VIM_KEYS[binding] === data; }
function workflowKeyLabel(keybindings: unknown, binding: string, fallback: string, labels: Readonly<Record<string, string>>): string {
  const keys = keybindingKeys(keybindings, binding);
  const configured = keys?.length ? keys.map((key) => labels[key] ?? key) : [fallback];
  const vim = WORKFLOW_VIM_KEYS[binding];
  return [...new Set(vim ? [...configured, vim] : configured)].join("/");
}

export type WorkflowNavigatorDependencies = {
  pi: Pick<ExtensionAPI, "registerCommand">;
  home: string | undefined;
  clipboard: (value: string) => Promise<void>;
  extensionAgentDir: string;
  runs: Map<string, WorkflowRunRecord>;
  terminalRunStates: Map<string, "completed" | "failed" | "stopped">;
  hardTerminalRunStates: ReadonlySet<string>;
  ensureSessionLease: (cwd: string, sessionId: string) => Promise<void>;
  answerCheckpoint: (runId: string, name: string, approved: boolean, silent?: boolean) => Promise<boolean>;
  recovery: ReturnType<typeof createWorkflowRecovery>;
  stopWorkflowRun: (runId: string) => Promise<{ runId: string; state: string; stopped: boolean; reason?: "unknown_run" | "already_terminal" }>;
  moveForegroundToBackground: (runId: string) => Promise<{ runId: string; state: "running"; detached: true }>;
  isForegroundAttached: (runId: string) => boolean;
  liveAgents: {
    get(runId: string, agentId: string): Readonly<{ session?: import("./types.js").WorkflowAgentSession; prepared?: Readonly<import("./types.js").PreparedAgentSession>; handoff?: import("./types.js").LiveSessionHandoff }> | undefined;
    overlay(run: PersistedRun): PersistedRun;
  };
  registry: WorkflowRegistryApi;
  projectTrusted: (context: unknown) => boolean;
  resumeHostContext: (context: unknown) => WorkflowRecoveryContext;
  resumeSelectedWorkflow: (runId: string, foreground: boolean, context: unknown, budgetPatch?: unknown) => Promise<{ workflowName: string; state: "running" | "completed" | "awaiting_approval"; attached: boolean; value?: JsonValue }>;
  reportBlocked?: ReportBlocked;
  setNavigatorOpen?: (open: boolean) => void;
  trajectoryProvider: TrajectoryPublisherProvider;
};
export function registerWorkflowNavigator(deps: WorkflowNavigatorDependencies): void {
  const { pi, home, clipboard, extensionAgentDir, runs, terminalRunStates, hardTerminalRunStates, ensureSessionLease, answerCheckpoint, recovery, stopWorkflowRun, moveForegroundToBackground, isForegroundAttached, liveAgents, registry, projectTrusted, resumeHostContext, resumeSelectedWorkflow, reportBlocked, setNavigatorOpen, trajectoryProvider } = deps;
  const command = {
    description: "Open the workflow picker; workflow actions are available contextually",
    handler: async (args, ctx) => {
      const command = args.trim();
      if (command && command !== "trajectory") {
        ctx.ui.notify("Workflow slash commands do not accept arguments. Open the workflow picker with /workflow; actions are available there or through workflow tools.", "warning");
        return;
      }
      if (command === "trajectory") {
        const trajectory = getTrajectoryHost();
        if (!trajectory) {
          ctx.ui.notify("Trajectory is disabled", "warning");
          return;
        }
        await trajectory.open(trajectoryProvider, ctx);
        return;
      }
      await ensureSessionLease(ctx.cwd, ctx.sessionManager.getSessionId());
      const loadStores = async () => {
        const entries = await Promise.all((await listRunIds(ctx.cwd, ctx.sessionManager.getSessionId(), home)).map(async (runId) => {
          const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
          try {
            const loaded = await store.load();
            const summary = await store.loadSummary().catch(() => undefined);
            const terminalAt = summary?.terminalAt === undefined ? undefined : Date.parse(summary.terminalAt);
            return { store, loaded: { ...loaded, run: liveAgents.overlay(loaded.run) }, resolvedAt: terminalAt !== undefined && Number.isFinite(terminalAt) ? terminalAt : undefined };
          }
          catch { if (!await store.isComplete()) await store.delete(true).catch(() => undefined); return undefined; }
        }));
        return entries.filter((entry): entry is { store: RunStore; loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> }; resolvedAt: number | undefined } => entry !== undefined);
      };
      let stores = await loadStores();
      const setWorkflowStatus = (text: string | undefined) => {
        const setStatus = uiHostCapabilities(ctx.ui)?.setStatus;
        setStatus?.call(ctx.ui, "workflow-stop", text);
      };
      const runAction = async (actionCommand: string, status: (text: string | undefined) => void = setWorkflowStatus): Promise<"dashboard" | "picker" | "stopped"> => {
        const [action, runId, ...rest] = actionCommand.split(/\s+/);
        try {
          const run = runId ? runs.get(runId) : undefined;
          const storedEntry = runId ? stores.find(({ store }) => store.runId === runId) : undefined;
          const stored = storedEntry ? { store: storedEntry.store, loaded: await storedEntry.store.load() } : undefined;
          if (action === "background" && runId) {
            const result = await moveForegroundToBackground(runId);
            ctx.ui.notify(`Moved workflow ${result.runId} to background.`, "info");
            return "dashboard";
          }
          if ((action === "approve" || action === "reject") && runId && rest.length) {
            const accepted = await answerCheckpoint(runId, rest.join(" "), action === "approve", true);
            ctx.ui.notify(accepted ? `${action === "approve" ? "Approved" : "Rejected"} checkpoint ${rest.join(" ")}.` : "Checkpoint is not awaiting a response.", accepted ? "info" : "warning");
            return "dashboard";
          }
          if ((action === "budget-approve" || action === "budget-reject") && runId && rest[0]) {
            const result = await recovery.answerBudgetDecision(runId, rest[0], action === "budget-approve", true, ctx, undefined, false);
            ctx.ui.notify(result ? `Budget adjustment ${rest[0]} ${result.approved ? "approved" : "rejected"}.` : "Budget proposal is not pending.", result ? "info" : "warning");
            return "dashboard";
          }
          if (action === "delete" && stored) {
            if (!hardTerminalRunStates.has(stored.loaded.run.state)) { ctx.ui.notify("Stop the workflow before deleting it.", "warning"); return "dashboard"; }
            if (!await confirmWithBlocked(ctx.ui, reportBlocked, "Delete workflow?", `Delete ${stored.loaded.run.workflowName} (${stored.store.runId}) and all owned artifacts? This cannot be undone.`)) return "dashboard";
            await stored.store.delete(true); runs.delete(stored.store.runId); terminalRunStates.delete(stored.store.runId); ctx.ui.notify(`Deleted workflow ${stored.store.runId}.`, "info"); return "picker";
          }
          if (action === "pause" && run) { await run.lifecycle.pause(); ctx.ui.notify(`Paused workflow ${run.store.runId}.`, "info"); return "dashboard"; }
          if (action === "resume" && run) {
            if (run.lifecycle.state === "budget_exhausted") {
              const patch: unknown = rest.length ? JSON.parse(rest.join(" ")) as unknown : undefined;
              const result = await recovery.resumeWorkflowRun(run.store.runId, patch, ctx, undefined, undefined, false);
              ctx.ui.notify(result.state === "completed" ? `Workflow ${run.store.runId} completed.` : result.state === "running" ? `Resumed workflow ${run.store.runId}.` : `Budget adjustment for ${run.store.runId} is awaiting approval.`, result.state === "awaiting_approval" ? "warning" : "info");
            } else {
              if (run.lifecycle.state === "interrupted") await recovery.coldResumeRun(run, ctx.hasUI, ctx.ui, projectTrusted(ctx), resumeHostContext(ctx), undefined, false);
              else {
                if (run.lifecycle.state === "paused") await recovery.refreshPausedRunAliases(run, { ...resumeHostContext(ctx), projectTrusted: projectTrusted(ctx) });
                await run.lifecycle.resume();
              }
              ctx.ui.notify(`Resumed workflow ${run.store.runId}.`, "info");
            }
            return "dashboard";
          }
          if (action === "adjust" && run?.lifecycle.state === "budget_exhausted") {
            const input = await uiHostCapabilities(ctx.ui)?.input?.call(ctx.ui, "Budget patch (JSON)", "{\"tokens\":{\"hard\":null}}" );
            if (input === undefined) return "dashboard";
            const result = await recovery.resumeWorkflowRun(run.store.runId, JSON.parse(input), ctx, undefined, undefined, false);
            ctx.ui.notify(result.state === "completed" ? `Workflow ${run.store.runId} completed.` : result.state === "running" ? `Resumed workflow ${run.store.runId}.` : `Budget adjustment for ${run.store.runId} is awaiting approval.`, result.state === "awaiting_approval" ? "warning" : "info");
            return "dashboard";
          }
          if (action === "stop" && run) {
            const workflowName = stored?.loaded.run.workflowName ?? run.metadata.name;
            if (!await confirmWithBlocked(ctx.ui, reportBlocked, "Stop workflow?", `Stop workflow ${workflowName} (${run.store.runId})? This cannot be undone.`)) return "dashboard";
            status(`Stopping workflow ${workflowName}...`);
            await stopWorkflowRun(run.store.runId);
            status(`Workflow ${run.store.runId} stopped.`);
            ctx.ui.notify(`Stopped workflow ${run.store.runId}.`, "info"); return "stopped";
          }
          if (action && runId) ctx.ui.notify(`Cannot ${action} workflow ${runId}: the run is no longer available.`, "warning");
          else ctx.ui.notify("Workflow action is no longer available.", "warning");
          return "dashboard";
        } catch (error) {
          const message = errorText(error);
          if (action === "stop") status(`Could not stop workflow ${runId ?? ""}: ${message}`);
          ctx.ui.notify(`Cannot ${action ?? "workflow action"}${runId ? ` for ${runId}` : ""}: ${message}`, "warning");
          return "dashboard";
        }
      };
      const manageAliases = async (): Promise<void> => {
        const settingsPath = workflowSettingsPath(extensionAgentDir);
        let aliasSettingsPath = settingsPath;
        const trustedProject = projectTrusted(ctx);
        const modelRegistry = resumeHostContext(ctx).modelRegistry;
        const available = () => [...new Set((modelRegistry?.getAvailable?.() ?? []).map((model) => `${model.provider}/${model.id}`))].sort();
        const selectTarget = async (aliases: Readonly<Record<string, string>>): Promise<string | undefined> => {
          const models = available();
          const choice = await ctx.ui.select("Model alias target", [...models, ...Object.keys(aliases).sort(), "Manual model ID", "Back"]);
          if (!choice || choice === "Back") return undefined;
          if (choice !== "Manual model ID") return choice;
          return (await ctx.ui.input("Manual model ID", "provider/model[:thinking] or alias[:thinking]"))?.trim() || undefined;
        };
        const save = (aliases: Readonly<Record<string, string>>): boolean => {
          try { saveModelAliases(aliasSettingsPath, aliases); ctx.ui.notify(`Saved model aliases to ${aliasSettingsPath}.`, "info"); return true; }
          catch (error) { ctx.ui.notify(`${aliasSettingsPath}: ${errorText(error)}`, "error"); return false; }
        };
        for (;;) {
          let aliases: Readonly<Record<string, string>>;
          try { const resolution = resolveWorkflowSettings(ctx.cwd, trustedProject, settingsPath); aliases = resolution.effective.modelAliases ?? {}; aliasSettingsPath = resolution.sources.modelAliases; }
          catch (error) { ctx.ui.notify(`${trustedProject ? workflowProjectSettingsPath(ctx.cwd) : settingsPath}: ${errorText(error)}`, "error"); return; }
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
            try { validateModelAliases(next, aliasSettingsPath); } catch (error) { ctx.ui.notify(`${aliasSettingsPath}: ${errorText(error)}`, "error"); continue; }
            const parsed = resolveModelReference(target, next, new Set(available()), aliasSettingsPath);
            if (!available().includes(`${parsed.provider}/${parsed.model}`)) {
              ctx.ui.notify(`Warning: ${target} is not currently available in Pi.`, "warning");
              if (!await confirmWithBlocked(ctx.ui, reportBlocked, "Save unknown model?", "Save this target for cross-machine portability?")) continue;
            }
            save(next);
            continue;
          }
          const edit = /^Edit (.+)$/.exec(choice);
          if (edit?.[1]) {
            const target = await selectTarget(aliases);
            if (!target) continue;
            const next = { ...aliases, [edit[1]]: target };
            try { validateModelAliases(next, aliasSettingsPath); } catch (error) { ctx.ui.notify(`${aliasSettingsPath}: ${errorText(error)}`, "error"); continue; }
            const parsed = resolveModelReference(target, next, new Set(available()), aliasSettingsPath);
            if (!available().includes(`${parsed.provider}/${parsed.model}`)) {
              ctx.ui.notify(`Warning: ${target} is not currently available in Pi.`, "warning");
              if (!await confirmWithBlocked(ctx.ui, reportBlocked, "Save unknown model?", "Save this target for cross-machine portability?")) continue;
            }
            save(next);
            continue;
          }
          const deletion = /^Delete (.+)$/.exec(choice);
          if (deletion?.[1] && await confirmWithBlocked(ctx.ui, reportBlocked, "Delete model alias?", `Delete ${deletion[1]}? Future workflow resumes using this alias may fail.`)) {
            const next = Object.fromEntries(Object.entries(aliases).filter(([name]) => name !== deletion[1]));
            save(next);
          }
        }
      };
      if (!command) {
        for (;;) {
          if (!ctx.hasUI) {
            if (!stores.length) { ctx.ui.notify("No workflow runs in this session. Mutations are available through workflow tools.", "info"); return; }
            const sorted = navigatorAttentionSort(stores);
            const details = await Promise.all(sorted.map(async ({ store, loaded }) => formatNavigatorRun(loaded, await store.awaitingCheckpoints(), await store.worktrees())));
            ctx.ui.notify(`${details.join("\n\n")}\n\nMutations are available through workflow tools.`, "info"); return;
          }
          const sorted = navigatorAttentionSort(stores);
          const labels = navigatorRunLabels(sorted);
          const terminalStates = hardTerminalRunStates;
          const hasCompleted = sorted.some(({ loaded: { run } }) => run.state === "completed");
          const hasFailed = sorted.some(({ loaded: { run } }) => run.state === "failed");
          const pickerOptions = [...labels, "Model aliases", "Close", ...(hasCompleted ? ["Delete all completed"] : []), ...(hasFailed ? ["Delete all failed"] : [])];
          const runChoice = await ctx.ui.select("Workflows\n", pickerOptions);
          if (!runChoice || runChoice === "Close") return;
          if (runChoice === "Model aliases") { await manageAliases(); stores = await loadStores(); continue; }
          if (runChoice === "Delete all completed") {
            if (!await confirmWithBlocked(ctx.ui, reportBlocked, "Delete completed runs?", "Delete all completed workflow runs and their artifacts? This cannot be undone.")) continue;
            for (const entry of sorted) {
              if (entry.loaded.run.state === "completed") { await entry.store.delete(true); runs.delete(entry.store.runId); terminalRunStates.delete(entry.store.runId); }
            }
            ctx.ui.notify("Deleted all completed workflow runs.", "info"); stores = await loadStores(); continue;
          }
          if (runChoice === "Delete all failed") {
            if (!await confirmWithBlocked(ctx.ui, reportBlocked, "Delete failed runs?", "Delete all failed workflow runs and their artifacts? This cannot be undone.")) continue;
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
              ctx.ui.notify(`Failed to copy ${artifact}: ${errorText(error)}`, "error");
            }
          };
          const loadDashboard = async () => {
            const loaded = await store.load();
            const activeRun = runs.get(store.runId);
            const liveRun = liveAgents.overlay({ ...loaded.run, ...(activeRun ? { usage: activeRun.budget.usage } : {}) });
            const checkpoints = await store.awaitingCheckpoints();
            const worktrees = await store.worktrees();
            const completedOperations = ctx.mode === "tui" ? await store.replayableOperations().catch(() => []) : [];
            const agentResults = new Map<string, JsonValue>();
            for (const agent of liveRun.agents) {
              if (agent.state !== "completed" || agent.parentId || !agent.resultPath) continue;
              const operation = completedOperations.find((candidate) => candidate.path === agent.resultPath);
              if (operation) agentResults.set(agent.id, operation.value);
            }
            const actions = new Map<string, string>();
            const copies = new Map<string, { value: string; artifact: string }>();
            const reviews = new Map<string, AwaitingCheckpoint>();
            const add = (label: string, value: string) => { actions.set(label, `${value} ${store.runId}`); };
            const addCopy = (label: string, value: string, artifact: string) => { actions.set(label, "copy"); copies.set(label, { value, artifact }); };
            if (liveRun.state === "running") add("Pause", "pause");
            if (["paused", "interrupted"].includes(liveRun.state)) add("Resume", "resume");
            if (liveRun.state === "budget_exhausted") { actions.set("Resume unchanged", `resume ${store.runId}`); actions.set("Adjust budget", `adjust ${store.runId}`); }
            for (const decision of await store.pendingWorkflowDecisions()) {
              const id = decision.proposalId.slice(0, 8);
              actions.set(`Approve budget ${id}`, `budget-approve ${store.runId} ${decision.proposalId}`);
              actions.set(`Reject budget ${id}`, `budget-reject ${store.runId} ${decision.proposalId}`);
            }
            if (isForegroundAttached(store.runId)) actions.set("Move to background", `background ${store.runId}`);
            if (!terminalStates.has(liveRun.state)) add("Stop", "stop");
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
            if (terminalStates.has(liveRun.state)) add("Delete", "delete");
            if (ctx.mode === "tui") {
              addCopy("Copy run path", store.directory, "run path");
              addCopy("Copy run ID", store.runId, "run ID");
            }
            return { dashboard: formatWorkflowPhaseDashboard(liveRun, loaded.snapshot, process.stdout.columns || 80).join("\n"), phaseModel: buildWorkflowPhaseModel(liveRun, loaded.snapshot), run: liveRun, snapshot: loaded.snapshot, actions, copies, reviews, agentResults, agents: liveRun.agents, worktrees, cwd: liveRun.cwd };
          };
          const agentWorktreeFor = (dashboard: Awaited<ReturnType<typeof loadDashboard>>, agent: AgentRecord): WorktreeReference | undefined => agent.worktreeOwner ? dashboard.worktrees.find((candidate) => candidate.owner === agent.worktreeOwner) : undefined;
          const agentAttemptActionContext = (dashboard: Awaited<ReturnType<typeof loadDashboard>>, agent: AgentRecord): AgentAttemptActionContext | undefined => {
            const attempt = (agent.attemptDetails ?? []).reduce<AgentAttemptSummary | undefined>((latest, candidate) => !latest || candidate.attempt > latest.attempt ? candidate : latest, undefined);
            if (!attempt) return undefined;
            const liveAgent = liveAgents.get(dashboard.run.id, agent.id);
            const liveCandidate = liveAgent?.session;
            const live = liveCandidate && attempt.session && liveCandidate.reference.transport === attempt.session.transport && liveCandidate.reference.sessionId === attempt.session.sessionId ? liveCandidate : undefined;
            const run = runs.get(dashboard.run.id);
            const ui = { notify: (message: string, level: "info" | "warning" | "error" = "info") => { ctx.ui.notify(message, level); }, confirm: (title: string, message: string) => confirmWithBlocked(ctx.ui, reportBlocked, title, message), select: (title: string, options: readonly string[]) => { return ctx.ui.select(title, [...options]); }, input: (title: string, placeholder?: string) => ctx.ui.input(title, placeholder), setWorkingMessage: (message?: string) => { ctx.ui.setWorkingMessage(message); } };
            const attemptSnapshot = deepFreeze(structuredClone(attempt));
            const prepared = live ? liveAgent?.prepared : undefined;
            const handoff = live ? liveAgent?.handoff : undefined;
            return { run: deepFreeze(structuredClone(dashboard.run)), agent: deepFreeze(structuredClone(agent)), attempt: attemptSnapshot, ...(attemptSnapshot.session ? { session: attemptSnapshot.session } : {}), ...(live ? { liveSession: live } : {}), ...(prepared ? { prepared } : {}), ...(handoff ? { handoff } : {}), signal: run?.abortController.signal ?? new AbortController().signal, ui: Object.freeze(ui) };
          };
          const visibleAgentAttemptActions = (dashboard: Awaited<ReturnType<typeof loadDashboard>>, agent: AgentRecord): readonly [string, import("./types.js").AgentAttemptAction][] => {
            const context = agentAttemptActionContext(dashboard, agent);
            return context ? visibleRegisteredAgentAttemptActions(registry.agentAttemptActions(), context) : [];
          };
          const agentActionOptions = (dashboard: Awaited<ReturnType<typeof loadDashboard>>, agent: AgentRecord): string[] => {
            const worktree = agentWorktreeFor(dashboard, agent);
            return agentActionLabels({
              extensionLabels: visibleAgentAttemptActions(dashboard, agent).map(([, action]) => action.label),
              hasWorktree: worktree !== undefined,
              openPrompt: ctx.mode === "tui" && agent.prompt !== undefined,
              openSystemPrompt: ctx.mode === "tui" && agent.systemPrompt !== undefined,
              openResult: ctx.mode === "tui" && dashboard.agentResults.has(agent.id),
            });
          };
          const selectAgent = async (dashboard: Awaited<ReturnType<typeof loadDashboard>>, requestedAgentId?: string): Promise<void> => {
            const byId = new Map(dashboard.agents.map((agent) => [agent.id, agent]));
            const title = (agent: AgentRecord): string => agentBreadcrumb(agent, byId, true);
            const labels = dashboard.agents.map((agent, index) => `#${String(index + 1)} ${title(agent)} [${agent.state}]`);
            let selected: AgentRecord | undefined;
            if (requestedAgentId) selected = dashboard.agents.find((agent) => agent.id === requestedAgentId);
            else {
              const selectedLabel = await ctx.ui.select("Agents", [...labels, "Back"]);
              const selectedIndex = selectedLabel ? labels.indexOf(selectedLabel) : -1;
              selected = selectedIndex >= 0 ? dashboard.agents[selectedIndex] : undefined;
            }
            if (!selected) return;
            const worktree = agentWorktreeFor(dashboard, selected);
            const actions = agentActionOptions(dashboard, selected);
            for (;;) {
              const action = await ctx.ui.select(title(selected), actions);
              if (!action || action === "Back") return;
              const extensionAction = visibleAgentAttemptActions(dashboard, selected).find(([, candidate]) => candidate.label === action);
              if (extensionAction) {
                const context = agentAttemptActionContext(dashboard, selected);
                if (context) { try { await extensionAction[1].run(context); } catch (error) { ctx.ui.notify(`Agent attempt action failed: ${errorText(error)}`, "error"); } }
                return;
              }
              if (action === "Copy agent ID") { await copyArtifact(selected.id, "agent ID"); continue; }
              if (action === "Copy branch" && worktree) { await copyArtifact(worktree.branch, "branch"); continue; }
              if (action === "Copy worktree path" && worktree) { await copyArtifact(worktree.path, "worktree path"); continue; }
            }
          };
          const resumeDashboard = async (dashboard: Awaited<ReturnType<typeof loadDashboard>>, action: string): Promise<void> => {
            const ui = uiHostCapabilities(ctx.ui);
            if (!ui?.select) return;
            const mode = await ui.select(`Resume ${dashboard.run.workflowName}`, ["Foreground", "Background", "Cancel"]);
            if (!mode || mode === "Cancel") return;
            let budgetPatch: unknown;
            if (dashboard.run.state === "budget_exhausted") {
              if (action === "Adjust budget") {
                const input = await uiHostCapabilities(ctx.ui)?.input?.call(ctx.ui, "Budget patch (JSON)", "{\"tokens\":{\"hard\":null}}");
                if (input === undefined) return;
                try { budgetPatch = JSON.parse(input); } catch (error) { ctx.ui.notify(`Cannot parse budget patch: ${errorText(error)}`, "warning"); return; }
              }
            }
            try {
              const result = await resumeSelectedWorkflow(store.runId, mode === "Foreground", ctx, budgetPatch);
              if (result.state === "completed" && !result.attached) ctx.ui.notify(`Workflow ${result.workflowName} completed${result.value === undefined ? "." : `: ${JSON.stringify(result.value)}`}`, "info");
              else if (result.state === "awaiting_approval") ctx.ui.notify(`Budget adjustment for ${result.workflowName} is awaiting approval.`, "warning");
              else if (result.state === "running") ctx.ui.notify(`Resumed workflow ${result.workflowName} in ${mode.toLowerCase()}.`, "info");
            } catch (error) {
              if (error && typeof error === "object" && "workflowResumeAttached" in error && error.workflowResumeAttached === true) return;
              const diagnostic = failureDiagnosticsFrom(error);
              const message = diagnostic ? formatWorkflowFailureDelivery(diagnostic) : formatWorkflowFailureDeliveryFallback(dashboard.run.workflowName, store.runId, store.directory, error);
              ctx.ui.notify(`Cannot resume workflow ${store.runId}: ${message}`, "warning");
            }
          };
          for (;;) {
            let view = await loadDashboard();
            const actionChoice = ctx.mode === "tui"
              ? await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
                  let dashboardOffset = 0;
                  let refreshing = false;
                  let disposed = false;
                  let detailsMode = false;
                  let actionMode = false;
                  let actionIndex = 0;
                  let stopRequested = false;
                  let stopStatus: string | undefined;
                  let selectionNeedsScroll = true;
                  let renderedWidth = 80;
                  let refreshGeneration = 0;
                  let frozenAt = Date.now();
                  let previousRunState = view.run.state;
                  let tree = buildWorkflowPhaseTree(view.phaseModel);
                  let selectedNodeId = tree.nodes[0]?.id;
                  let expandedNodeIds = new Set(workflowPhaseTreeInitialExpanded(tree));
                  const terminalRows = () => Math.max(1, tuiRows(tui) - WORKFLOW_PANEL_FOOTER_ROWS);
                  const keyLabels: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→", pageUp: "pgup", pageDown: "pgdn" };
                  const keyLabel = (binding: string, fallback: string) => workflowKeyLabel(keybindings, binding, fallback, keyLabels);
                  const progressNow = () => {
                    const now = Date.now();
                    if (hardTerminalRunStates.has(view.run.state)) {
                      if (!hardTerminalRunStates.has(previousRunState)) frozenAt = now;
                      previousRunState = view.run.state;
                      return frozenAt;
                    }
                    frozenAt = now;
                    previousRunState = view.run.state;
                    return now;
                  };
                  const selectedAgentRecord = (): AgentRecord | undefined => {
                    const node = selectedNodeId ? tree.byId.get(selectedNodeId) : tree.nodes[0];
                    return node?.kind === "agent" && node.agentId ? view.agents.find((agent) => agent.id === node.agentId) : undefined;
                  };
                  const actionOptions = () => {
                    const agent = selectedAgentRecord();
                    return agent ? agentActionOptions(view, agent) : [...view.actions.keys(), "Back"];
                  };
                  let editorRunning = false;
                  let timer: ReturnType<typeof setInterval> | undefined;
                  const stopTimer = () => {
                    if (timer !== undefined) {
                      clearInterval(timer);
                      timer = undefined;
                    }
                  };
                  const openArtifact = async (artifact: Promise<WorkflowArtifact>, label: string): Promise<void> => {
                    if (editorRunning) return;
                    editorRunning = true;
                    try {
                      const command = SettingsManager.create(view.cwd, extensionAgentDir, { projectTrusted: projectTrusted(ctx) }).getExternalEditorCommand();
                      if (!command) { ctx.ui.notify(`Cannot open ${label}: no external editor is configured.`, "warning"); return; }
                      const exitCode = await openWorkflowArtifact(tui, command, await artifact);
                      if (exitCode !== 0) {
                        const detail = exitCode === null ? "could not be started" : `exited with code ${String(exitCode)}`;
                        ctx.ui.notify(`Cannot open ${label}: external editor ${detail}.`, "warning");
                      }
                    } catch (error) {
                      ctx.ui.notify(`Cannot open ${label}: ${errorText(error)}`, "warning");
                    } finally {
                      editorRunning = false;
                    }
                  };
                  const updateDashboard = async () => {
                    const generation = ++refreshGeneration;
                    const hadExpandableNodes = tree.nodes.some((node) => node.children.length > 0);
                    const next = await loadDashboard();
                    if (disposed || generation !== refreshGeneration) return;
                    const previousNodeId = selectedNodeId;
                    const previousExpanded = expandedNodeIds;
                    const selectedAction = actionMode ? actionOptions()[actionIndex] : undefined;
                    view = next;
                    if (hardTerminalRunStates.has(next.run.state) && next.run.agents.every((agent) => SETTLED_AGENT_STATES.has(agent.state))) stopTimer();
                    tree = buildWorkflowPhaseTree(view.phaseModel);
                    selectedNodeId = preserveWorkflowPhaseTreeSelection(tree, { nodeId: previousNodeId }).nodeId;
                    expandedNodeIds = new Set([...previousExpanded].filter((id) => tree.byId.has(id)));
                    if (!hadExpandableNodes && !expandedNodeIds.size && tree.nodes.some((node) => node.children.length > 0)) expandedNodeIds = new Set(workflowPhaseTreeInitialExpanded(tree));
                    const nextActions = actionOptions();
                    const preservedActionIndex = selectedAction ? nextActions.indexOf(selectedAction) : -1;
                    actionIndex = preservedActionIndex >= 0 ? preservedActionIndex : selectedAction ? nextActions.length - 1 : Math.min(actionIndex, Math.max(0, nextActions.length - 1));
                    selectionNeedsScroll = true;
                    tui.requestRender();
                  };
                  const requestStop = () => {
                    if (stopRequested) return;
                    stopRequested = true;
                    stopStatus = undefined;
                    setWorkflowStatus(undefined);
                    void runAction(`stop ${store.runId}`, (status) => {
                      stopStatus = status;
                      setWorkflowStatus(status);
                      if (!disposed) tui.requestRender();
                    }).then(async (outcome) => {
                      if (outcome === "stopped") { done("__stopped__"); return; }
                      await updateDashboard();
                    }).catch((error: unknown) => {
                      if (disposed) return;
                      stopStatus = `Could not stop workflow ${store.runId}: ${errorText(error)}`;
                      setWorkflowStatus(stopStatus);
                      tui.requestRender();
                    }).finally(() => {
                      stopRequested = false;
                      if (!disposed) tui.requestRender();
                    });
                  };
                  timer = setInterval(() => {
                    if (refreshing || stopRequested) return;
                    refreshing = true;
                    //NOTE: background dashboard refresh self-heals next tick; swallow so a transient render/read error surfaces as an unhandled rejection instead of refreshing state.
                    void updateDashboard().catch(() => undefined).finally(() => { refreshing = false; });
                  }, 1000);
                  timer.unref();
                  if (hardTerminalRunStates.has(view.run.state) && view.run.agents.every((agent) => SETTLED_AGENT_STATES.has(agent.state))) stopTimer();
                  return {
                    render(width: number) {
                      renderedWidth = width;
                      const narrow = width < 80;
                      const styles = themeWorkflowProgressStyles(theme);
                      const agent = selectedAgentRecord();
                      const actions = actionMode ? { title: agent ? "Agent actions" : "Run actions", options: actionOptions(), index: actionIndex } : undefined;
                      const phaseLines = formatWorkflowPhaseDashboard(view.run, view.snapshot, width, { nodeId: selectedNodeId, expandedNodeIds: [...expandedNodeIds], ...(narrow && !detailsMode && !actionMode ? { treeOnly: true } : {}), ...(narrow && (detailsMode || actionMode) ? { detailsOnly: true } : {}), ...(actions ? { actions } : {}) }, styles, progressNow());
                      const statusLines = stopStatus ? truncateToVisualLines(styles.error(stopStatus), Number.MAX_SAFE_INTEGER, width, 0).visualLines.map((line) => line.trimEnd()) : [];
                      const content = [...statusLines, ...phaseLines];
                      const rows = terminalRows();
                      const hintRows = rows >= 3 ? 1 : 0;
                      const viewport = Math.max(1, rows - hintRows);
                      const maxOffset = Math.max(0, content.length - viewport);
                      dashboardOffset = Math.max(0, Math.min(maxOffset, dashboardOffset));
                      if (actionMode) {
                        const label = actions?.options[actionIndex];
                        const actionRow = label ? content.findIndex((line) => line.includes(label)) : -1;
                        if (actionRow >= 0) {
                          if (actionRow < dashboardOffset) dashboardOffset = actionRow;
                          else if (actionRow >= dashboardOffset + viewport) dashboardOffset = actionRow - viewport + 1;
                        }
                      } else if (!detailsMode && selectionNeedsScroll) {
                        const selectedRow = content.findIndex((line) => line.startsWith("→"));
                        if (selectedRow >= 0) {
                          if (selectedRow < dashboardOffset) dashboardOffset = selectedRow;
                          else if (selectedRow >= dashboardOffset + viewport) dashboardOffset = selectedRow - viewport + 1;
                        }
                        selectionNeedsScroll = false;
                      }
                      dashboardOffset = Math.max(0, Math.min(maxOffset, dashboardOffset));
                      const selectedNode = selectedNodeId ? tree.byId.get(selectedNodeId) : undefined;
                      const enterAction = selectedNode?.kind === "workflow" ? "run actions" : selectedNode?.kind === "agent" ? "agent actions" : selectedNode?.children.length ? "expand/collapse" : narrow ? "inspect" : "focus details";
                      const hint = truncateToVisualLines(theme.fg("dim", actionMode ? `${keyLabel("tui.select.up", "↑")}/${keyLabel("tui.select.down", "↓")} actions · ${keyLabel("tui.select.confirm", "enter")} run · ${keyLabel("tui.editor.cursorLeft", "←")} tree · ${keyLabel("tui.select.cancel", "esc")} tree` : `${keyLabel("tui.select.up", "↑")}/${keyLabel("tui.select.down", "↓")} tree · ${keyLabel("tui.editor.cursorLeft", "←")}/${keyLabel("tui.editor.cursorRight", "→")} collapse/expand · ${keyLabel("tui.select.confirm", "enter")} ${enterAction} · a actions · ${keyLabel("tui.select.cancel", "esc")} ${narrow && detailsMode ? "tree" : "back"}${content.length > viewport ? ` · ${keyLabel("tui.select.pageUp", "pgup")}/${keyLabel("tui.select.pageDown", "pgdn")} scroll` : ""} · auto-refresh 1s`), Number.MAX_SAFE_INTEGER, width, 1).visualLines[0] ?? "";
                      return [...content.slice(dashboardOffset, dashboardOffset + viewport), ...(hintRows ? [hint] : [])];
                    },
                    invalidate() {},
                    handleInput(data: string) {
                      if (stopRequested || editorRunning) return;
                      const narrow = renderedWidth < 80;
                      if (!actionMode && (data === "a" || data === "A")) { actionMode = true; actionIndex = 0; dashboardOffset = 0; tui.requestRender(); return; }
                      if (actionMode) {
                        const options = actionOptions();
                        if (workflowKeyMatches(keybindings, data, "tui.select.cancel") || workflowKeyMatches(keybindings, data, "tui.editor.cursorLeft")) { actionMode = false; dashboardOffset = 0; tui.requestRender(); return; }
                        if (workflowKeyMatches(keybindings, data, "tui.select.up")) actionIndex = (actionIndex + options.length - 1) % options.length;
                        else if (workflowKeyMatches(keybindings, data, "tui.select.down")) actionIndex = (actionIndex + 1) % options.length;
                        else if (workflowKeyMatches(keybindings, data, "tui.select.pageUp")) dashboardOffset = Math.max(0, dashboardOffset - Math.max(1, terminalRows() - 1));
                        else if (workflowKeyMatches(keybindings, data, "tui.select.pageDown")) dashboardOffset += Math.max(1, terminalRows() - 1);
                        else if (workflowKeyMatches(keybindings, data, "tui.select.confirm")) {
                          const action = options[actionIndex];
                          const agent = selectedAgentRecord();
                          if (!action || action === "Back") { actionMode = false; dashboardOffset = 0; }
                          else if (agent) {
                            const worktree = agentWorktreeFor(view, agent);
                            if (action === "Open prompt in editor") {
                              if (agent.prompt !== undefined) void openArtifact(Promise.resolve(workflowPromptArtifact(agent.prompt)), "agent prompt");
                            }
                            else if (action === "Open system prompt in editor") {
                              if (agent.systemPrompt !== undefined) void openArtifact(Promise.resolve(workflowPromptArtifact(agent.systemPrompt)), "agent system prompt");
                            }
                            else if (action === "Open result in editor") {
                              const result = view.agentResults.get(agent.id);
                              if (result !== undefined) void openArtifact(Promise.resolve(workflowResultArtifact(result)), "agent result");
                            }
                            else if (action === "Copy agent ID") void copyArtifact(agent.id, "agent ID");
                            else if (action === "Copy branch" && worktree) void copyArtifact(worktree.branch, "branch");
                            else if (action === "Copy worktree path" && worktree) void copyArtifact(worktree.path, "worktree path");
                            else {
                              const extensionAction = visibleAgentAttemptActions(view, agent).find(([, candidate]) => candidate.label === action);
                              const actionContext = extensionAction ? agentAttemptActionContext(view, agent) : undefined;
                              if (extensionAction && actionContext) {
                                actionMode = false;
                                void Promise.resolve(extensionAction[1].run(actionContext)).catch((error: unknown) => { ctx.ui.notify(`Agent attempt action failed: ${errorText(error)}`, "error"); }).finally(() => { void updateDashboard(); });
                              }
                            }
                          }
                          else if (action === "Open script in editor") void openArtifact(readFile(join(store.directory, "workflow.js"), "utf8").then(workflowScriptArtifact), "workflow script");
                          else if (action === "Stop") requestStop();
                          else done(action);
                        }
                        tui.requestRender();
                        return;
                      }
                      if (workflowKeyMatches(keybindings, data, "tui.select.cancel")) {
                        if (narrow && detailsMode) { detailsMode = false; selectionNeedsScroll = true; } else done("Back");
                      } else if (narrow && detailsMode) {
                        if (workflowKeyMatches(keybindings, data, "tui.select.pageUp")) dashboardOffset = Math.max(0, dashboardOffset - Math.max(1, terminalRows() - 1));
                        else if (workflowKeyMatches(keybindings, data, "tui.select.pageDown")) dashboardOffset += Math.max(1, terminalRows() - 1);
                        else if (workflowKeyMatches(keybindings, data, "tui.select.confirm")) {
                          const node = selectedNodeId ? tree.byId.get(selectedNodeId) : undefined;
                          if (node?.kind === "agent") { actionMode = true; actionIndex = 0; dashboardOffset = 0; }
                        }
                      } else if (workflowKeyMatches(keybindings, data, "tui.editor.cursorLeft")) {
                        const next = navigateWorkflowPhaseTree(tree, selectedNodeId, expandedNodeIds, "left");
                        selectedNodeId = next.nodeId; expandedNodeIds = new Set(next.expandedNodeIds); selectionNeedsScroll = true;
                      } else if (workflowKeyMatches(keybindings, data, "tui.editor.cursorRight")) {
                        const next = navigateWorkflowPhaseTree(tree, selectedNodeId, expandedNodeIds, "right");
                        selectedNodeId = next.nodeId; expandedNodeIds = new Set(next.expandedNodeIds); selectionNeedsScroll = true;
                      } else if (workflowKeyMatches(keybindings, data, "tui.select.up")) {
                        const next = navigateWorkflowPhaseTree(tree, selectedNodeId, expandedNodeIds, "up");
                        selectedNodeId = next.nodeId; selectionNeedsScroll = true;
                      } else if (workflowKeyMatches(keybindings, data, "tui.select.down")) {
                        const next = navigateWorkflowPhaseTree(tree, selectedNodeId, expandedNodeIds, "down");
                        selectedNodeId = next.nodeId; selectionNeedsScroll = true;
                      } else if (workflowKeyMatches(keybindings, data, "tui.select.pageUp")) dashboardOffset = Math.max(0, dashboardOffset - Math.max(1, terminalRows() - 1));
                      else if (workflowKeyMatches(keybindings, data, "tui.select.pageDown")) dashboardOffset += Math.max(1, terminalRows() - 1);
                      else if (workflowKeyMatches(keybindings, data, "tui.select.confirm")) {
                        const node = selectedNodeId ? tree.byId.get(selectedNodeId) : undefined;
                        if (node?.kind === "workflow") {
                          actionMode = true;
                          actionIndex = 0;
                          dashboardOffset = 0;
                        } else if (node?.kind === "agent") {
                          if (narrow) detailsMode = true;
                          else {
                            actionMode = true;
                            actionIndex = 0;
                            dashboardOffset = 0;
                          }
                        } else if (node?.children.length) {
                          if (expandedNodeIds.has(node.id)) expandedNodeIds.delete(node.id); else expandedNodeIds.add(node.id);
                          selectionNeedsScroll = true;
                        } else if (narrow) detailsMode = true;
                      }
                      tui.requestRender();
                    },
                    dispose() { disposed = true; stopTimer(); setWorkflowStatus(undefined); },
                  };
                })
              : await ctx.ui.select(view.dashboard, [...view.actions.keys(), "Back"]);
            if (actionChoice === "__stopped__") return;
            if (!actionChoice || actionChoice === "Back") { stores = await loadStores(); break; }
            if (actionChoice === "Agents...") { await selectAgent(view); continue; }
            if (actionChoice.startsWith("__workflow_agent__:")) { await selectAgent(view, actionChoice.slice("__workflow_agent__:".length)); continue; }
            if (actionChoice === "Refresh") continue;
            if (["Resume", "Resume unchanged", "Adjust budget"].includes(actionChoice)) { await resumeDashboard(view, actionChoice); continue; }
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
                    const keyLabels: Record<string, string> = { up: "↑", down: "↓", left: "←", right: "→", pageUp: "pgup", pageDown: "pgdn" };
                    const keyLabel = (binding: string, fallback: string) => workflowKeyLabel(keybindings, binding, fallback, keyLabels);
                    const hint = truncateToVisualLines(theme.fg("dim", `${keyLabel("tui.select.up", "↑")}/${keyLabel("tui.select.down", "↓")}/pgup/pgdn scroll · enter select · esc cancel`), Number.MAX_SAFE_INTEGER, width, 1).visualLines[0] ?? "";
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
                    if (workflowKeyMatches(keybindings, data, "tui.select.up")) selectedIndex = (selectedIndex + options.length - 1) % options.length;
                    else if (workflowKeyMatches(keybindings, data, "tui.select.down")) selectedIndex = (selectedIndex + 1) % options.length;
                    else if (workflowKeyMatches(keybindings, data, "tui.select.pageUp")) move(-layout().contentViewport);
                    else if (workflowKeyMatches(keybindings, data, "tui.select.pageDown")) move(layout().contentViewport);
                    else if (workflowKeyMatches(keybindings, data, "tui.select.confirm")) {
                      const selected = options[selectedIndex];
                      done(isCheckpointDecision(selected) ? selected : undefined);
                    }
                    else if (workflowKeyMatches(keybindings, data, "tui.select.cancel")) done(undefined);
                    tui.requestRender();
                  },
                }, theme);
              }, { overlay: true, overlayOptions: WORKFLOW_OVERLAY_OPTIONS });
              if (decision) {
                const accepted = await answerCheckpoint(store.runId, checkpoint.name, decision === "Approve", true);
                if (!accepted) ctx.ui.notify("Checkpoint is not awaiting a response.", "warning");
              }
              continue;
            }
            const actionCommand = view.actions.get(actionChoice);
            if (!actionCommand) { ctx.ui.notify(`Cannot select workflow action: ${actionChoice}`, "warning"); continue; }
            const outcome = await runAction(actionCommand);
            if (outcome === "picker") { stores = await loadStores(); break; }
          }
        }
      }
    },
  } satisfies Parameters<ExtensionAPI["registerCommand"]>[1];
  pi.registerCommand("workflow", {
    ...command,
    handler: async (args, ctx) => {
      setNavigatorOpen?.(true);
      try { await command.handler(args, ctx); }
      finally { setNavigatorOpen?.(false); }
    },
  });
}
