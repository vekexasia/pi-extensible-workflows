import { type ExtensionCommandContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AgentsWorkspaceLoop } from "./agents-command.js";
import { type PersistedRun } from "./persistence.js";
import { type WorkflowRegistryApi } from "./registry.js";
import { agentBreadcrumb, formatNavigatorRun, formatWorkflowPhaseDashboard, navigatorAttentionSort, navigatorRunLabels } from "./host-view.js";
import { type WorkflowRecoveryContext, type createWorkflowRecovery } from "./host-recovery.js";
import { type WorkflowRunRecord } from "./host-runtime.js";
import { getTrajectoryHost, type TrajectoryPublisherProvider } from "./trajectory-host-handle.js";
import { type AgentRecord, type HardTerminalRunState, type JsonValue, type LiveSessionHandoff, type PreparedAgentSession, type WorkflowAgentSession } from "./types.js";
import { agentActionOptions, createWorkflowActionProvider, deleteBulkRuns, loadWorkflowRunView, loadWorkflowStores, manageAliases, runAgentAction, runWorkflowRunAction, visibleAgentAttemptActions, type ReportBlocked, type WorkflowStoredRun } from "./workflow-actions.js";
import { createPiActionUi } from "./pi-action-ui.js";

export type WorkflowNavigatorDependencies = {
  pi: Pick<ExtensionAPI, "registerCommand">;
  home: string | undefined;
  clipboard: (value: string) => Promise<void>;
  extensionAgentDir: string;
  runs: Map<string, WorkflowRunRecord>;
  terminalRunStates: Map<string, HardTerminalRunState>;
  hardTerminalRunStates: ReadonlySet<string>;
  ensureSessionLease: (cwd: string, sessionId: string) => Promise<void>;
  answerCheckpoint: (runId: string, name: string, approved: boolean, silent?: boolean) => Promise<boolean>;
  recovery: ReturnType<typeof createWorkflowRecovery>;
  stopWorkflowRun: (runId: string) => Promise<{ runId: string; state: string; stopped: boolean; reason?: "unknown_run" | "already_terminal" }>;
  moveForegroundToBackground: (runId: string) => Promise<{ runId: string; state: "running"; detached: true }>;
  isForegroundAttached: (runId: string) => boolean;
  liveAgents: {
    get(runId: string, agentId: string): Readonly<{ session?: WorkflowAgentSession; prepared?: Readonly<PreparedAgentSession>; handoff?: LiveSessionHandoff }> | undefined;
    overlay(run: PersistedRun): PersistedRun;
  };
  registry: WorkflowRegistryApi;
  projectTrusted: (context: unknown) => boolean;
  resumeHostContext: (context: unknown) => WorkflowRecoveryContext;
  resumeSelectedWorkflow: (runId: string, foreground: boolean, context: unknown, budgetPatch?: unknown) => Promise<{ workflowName: string; state: "running" | "completed" | "awaiting_approval"; attached: boolean; value?: JsonValue }>;
  reportBlocked?: ReportBlocked;
  trajectoryProvider: TrajectoryPublisherProvider;
  coordinateRunMutation?: <T>(task: () => Promise<T>) => Promise<T>;
  /**
   * The /agents workspace loop over this Pi session's runs (session source scope "workflows") with Pi's transcripts, dialogs and
   * external editor; src/host.ts builds it as /agents. In Pi's TUI, /workflow opens it with the workflow actions.
   */
  openWorkflowsWorkspace: (ctx: ExtensionCommandContext, loop: Pick<AgentsWorkspaceLoop, "providers" | "initialKey" | "hasContent" | "onEmpty">) => Promise<void>;
};
export function registerWorkflowNavigator(deps: WorkflowNavigatorDependencies): void {
  const { pi, ensureSessionLease, reportBlocked, trajectoryProvider, openWorkflowsWorkspace } = deps;
  const command = {
    description: "Open this session's workflow runs (the agents workspace in Pi's TUI, else the picker); workflow actions are available contextually",
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
      const loadStores = (): Promise<WorkflowStoredRun[]> => loadWorkflowStores(deps, ctx, true);
      let stores = await loadStores();
      const ui = createPiActionUi(ctx, { reportBlocked });
      if (!command) {
        // The workspace closed because it had no run left to show: the picker shows next, whatever the stores still hold.
        let emptied = false;
        for (;;) {
          if (!ctx.hasUI) {
            if (!stores.length) { ctx.ui.notify("No workflow runs in this session. Mutations are available through workflow tools.", "info"); return; }
            const sorted = navigatorAttentionSort(stores);
            const details = await Promise.all(sorted.map(async ({ store, loaded }) => formatNavigatorRun(loaded, await store.awaitingCheckpoints(), await store.worktrees())));
            ctx.ui.notify(`${details.join("\n\n")}\n\nMutations are available through workflow tools.`, "info"); return;
          }
          // In Pi's TUI the runs and their actions are in the agents workspace; leaving it ends the command.
          if (ctx.mode === "tui" && stores.length > 0 && !emptied) {
            const workspace = { empty: false };
            // As the old dashboard opened on a run's root: its run actions (Pause, Move to background, ...) are one key away.
            const first = navigatorAttentionSort(stores)[0];
            await openWorkflowsWorkspace(ctx, { providers: [createWorkflowActionProvider(deps, ctx)], ...(first ? { initialKey: `run:${first.store.runId}` } : {}), hasContent: (nodes) => nodes.some((node) => node.kind === "run"), onEmpty: () => { workspace.empty = true; } });
            if (!workspace.empty) return;
            emptied = true;
            stores = await loadStores();
            continue;
          }
          emptied = false;
          const sorted = navigatorAttentionSort(stores);
          // The TUI picker lists no run: the workspace shows them.
          const labels = ctx.mode === "tui" ? [] : navigatorRunLabels(sorted);
          const hasCompleted = sorted.some(({ loaded: { run } }) => run.state === "completed");
          const hasFailed = sorted.some(({ loaded: { run } }) => run.state === "failed");
          const pickerOptions = [...labels, "Model aliases", "Close", ...(hasCompleted ? ["Delete all completed"] : []), ...(hasFailed ? ["Delete all failed"] : [])];
          const runChoice = await ctx.ui.select("Workflows\n", pickerOptions);
          if (!runChoice || runChoice === "Close") return;
          if (runChoice === "Model aliases") { await manageAliases(deps, ctx, ui); stores = await loadStores(); continue; }
          if (runChoice === "Delete all completed") {
            await deleteBulkRuns(deps, ctx, ui, "completed");
            stores = await loadStores();
            continue;
          }
          if (runChoice === "Delete all failed") {
            await deleteBulkRuns(deps, ctx, ui, "failed");
            stores = await loadStores();
            continue;
          }
          const runIndex = labels.indexOf(runChoice);
          if (runIndex < 0) return;
          const selected = sorted[runIndex];
          if (!selected) return;
          const { store } = selected;
          const loadDashboard = async () => {
            const view = await loadWorkflowRunView(deps, ctx, store);
            return { ...view, dashboard: formatWorkflowPhaseDashboard(view.run, view.snapshot, process.stdout.columns || 80).join("\n"), agents: view.run.agents };
          };
          const selectAgent = async (dashboard: Awaited<ReturnType<typeof loadDashboard>>): Promise<void> => {
            const byId = new Map(dashboard.agents.map((agent) => [agent.id, agent]));
            const title = (agent: AgentRecord): string => agentBreadcrumb(agent, byId, true);
            const labels = dashboard.agents.map((agent, index) => `#${String(index + 1)} ${title(agent)} [${agent.state}]`);
            const selectedLabel = await ctx.ui.select("Agents", [...labels, "Back"]);
            const selectedIndex = selectedLabel ? labels.indexOf(selectedLabel) : -1;
            const selected = selectedIndex >= 0 ? dashboard.agents[selectedIndex] : undefined;
            if (!selected) return;
            const actions = agentActionOptions(deps, ctx, dashboard, selected);
            for (;;) {
              const action = await ctx.ui.select(title(selected), actions);
              if (!action || action === "Back") return;
              const extensionAction = visibleAgentAttemptActions(deps, dashboard, selected).some(([, candidate]) => candidate.label === action);
              await runAgentAction(deps, ui, dashboard, selected, action);
              if (extensionAction) return;
            }
          };
          for (;;) {
            const view = await loadDashboard();
            const actionChoice = await ctx.ui.select(view.dashboard, [...view.actions.keys(), "Back"]);
            if (!actionChoice || actionChoice === "Back") { stores = await loadStores(); break; }
            if (actionChoice === "Agents...") { await selectAgent(view); continue; }
            if (actionChoice === "Refresh") continue;
            const outcome = await runWorkflowRunAction(deps, ctx, ui, view, actionChoice);
            if (outcome === "picker") { stores = await loadStores(); break; }
          }
        }
      }
    },
  } satisfies Parameters<ExtensionAPI["registerCommand"]>[1];
  pi.registerCommand("workflow", command);
}
