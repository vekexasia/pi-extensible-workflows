import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SubagentManager, SubagentManagerContext, SubagentStatus } from "../subagents/src/contracts.js";
import { attemptValue, statusValue } from "../subagents/src/decode.js";
import type { SessionAgent, SessionAgentsSource, SessionTreeNode } from "./agents-workspace-contract.js";
import { formatCost, formatTokens } from "./background-widget.js";
import { buildWorkflowPhaseModel, buildWorkflowPhaseTree, workflowPhaseTreeInitialExpanded, workflowPhaseTreeVisibleNodes, type WorkflowPhaseTreeNode } from "./host-phases.js";
import { agentActivityLabel, formatWorkflowNodeDetails, formatWorkflowRuntime, formatWorkflowTreeLine, navigatorAttentionSort, navigatorAttentionSortByState, progressStyleForState, runStateGlyph, type WorkflowProgressStyles } from "./host-view.js";
import { sameFilesystemPath } from "./paths.js";
import { listRunIds, RunStore, type PersistedRun } from "./persistence.js";
import { isHardTerminalRunState, SETTLED_AGENT_STATES, type AgentAccounting, type AgentAttemptSummary, type AgentRecord, type LaunchSnapshot, type ModelSpec, type WorkflowAgentSession } from "./types.js";
import { isObject, sanitizeDisplayText } from "./utils.js";

export interface SessionAgentsDependencies {
  readonly home: string | undefined;
  /** The host's live view of a run (activity, in-flight tools) over its persisted state. */
  overlayRun(run: PersistedRun): PersistedRun;
  /** The in-process session of a workflow agent, whatever attempt it runs. */
  liveAgent(runId: string, agentId: string): WorkflowAgentSession | undefined;
  subagents(): SubagentManager | undefined;
}

/** The order of the /subagents dashboard (subagents/src/navigator.ts). */
const SUBAGENT_ATTENTION_ORDER: Readonly<Record<SubagentStatus["state"], number>> = { running: 0, failed: 1, stopped: 2, completed: 3 };

/** The /subagents dashboard's check before a run's files are read: not the manager's id format, which a custom manager need not share. */
function safeSubagentId(id: string): boolean { return id !== "." && id !== ".." && /^[A-Za-z0-9._-]+$/.test(id); }
/** The /subagents dashboard's manager context; per-agent inspections carry the attempt metadata and live activity. */
function managerContext(context: ExtensionCommandContext, includeAttemptMetadata: boolean): SubagentManagerContext {
  return { toolCallId: "agents-command", signal: undefined, onUpdate: undefined, ...(includeAttemptMetadata ? { includeAttemptMetadata: true, includeActivity: true } : {}), extensionContext: context };
}
function latestAttempt(attempts: readonly AgentAttemptSummary[] | undefined): AgentAttemptSummary | undefined {
  return (attempts ?? []).reduce<AgentAttemptSummary | undefined>((latest, candidate) => !latest || candidate.attempt > latest.attempt ? candidate : latest, undefined);
}
/** The in-process session, only when it runs `attempt` (same transport and session id). */
function attemptLiveSession(session: WorkflowAgentSession | undefined, attempt: AgentAttemptSummary | undefined): WorkflowAgentSession | undefined {
  const reference = attempt?.session;
  return session && reference && session.reference.transport === reference.transport && session.reference.sessionId === reference.sessionId ? session : undefined;
}
/** "<model>[:thinking] <tokens> <cost>", as the dashboards' transcript titles show it. */
function agentSummary(model: ModelSpec | undefined, accounting: AgentAccounting | undefined): string {
  return sanitizeDisplayText([
    model === undefined ? "" : `${model.model}${model.thinking ? `:${model.thinking}` : ""}`,
    formatTokens(accounting === undefined ? undefined : accounting.input + accounting.output),
    formatCost(accounting?.cost),
  ].filter(Boolean).join(" "));
}
function activityLabel(running: boolean, agent: Parameters<typeof agentActivityLabel>[0] | undefined): string | undefined {
  return running && agent !== undefined ? agentActivityLabel(agent) || undefined : undefined;
}
/** The tree kind of each /workflow tree node kind. */
const RUN_NODE_KIND: Readonly<Record<WorkflowPhaseTreeNode["kind"], SessionTreeNode["kind"]>> = { workflow: "run", phase: "phase", operation: "operation", shell: "shell", agent: "agent" };
/** The title row of a node: its label and state. */
function nodeTitle(label: string, state: string, styles: WorkflowProgressStyles): string {
  return `${styles.bold(label)} ${progressStyleForState(state, styles)(state)}`;
}
/** The text a /workflow tree node shows, as display text; its id, and so its key, stays the run's own. */
function displayNode(node: WorkflowPhaseTreeNode): WorkflowPhaseTreeNode {
  return { ...node, label: sanitizeDisplayText(node.label), phaseId: sanitizeDisplayText(node.phaseId), operationPath: node.operationPath.map(sanitizeDisplayText), ...(node.phase ? { phase: { ...node.phase, name: sanitizeDisplayText(node.phase.name) } } : {}) };
}
/** The /subagents dashboard's header counts (headerRows in subagents/src/navigator.ts): the count of each state and the total cost. */
function subagentsCounts(statuses: readonly SubagentStatus[]): string {
  const counts = (["running", "failed", "stopped", "completed"] as const).flatMap((state) => {
    const count = statuses.filter((status) => status.state === state).length;
    return count ? [`${String(count)} ${state}`] : [];
  });
  const cost = formatCost(statuses.reduce((sum, status) => sum + (status.progress?.accounting.cost ?? 0), 0));
  return [...counts, ...(cost ? [cost] : [])].join(" · ");
}
/** A run's styled state glyph, its done/total agents, their cost and its runtime: the pieces of the /workflow picker's run label (navigatorRunLabels). */
function runSummary(run: PersistedRun, styles: WorkflowProgressStyles): string {
  const done = run.agents.filter((agent) => SETTLED_AGENT_STATES.has(agent.state)).length;
  const cost = formatCost(run.agents.reduce((sum, agent) => sum + (agent.accounting?.cost ?? 0), 0));
  return [progressStyleForState(run.state, styles)(runStateGlyph(run.state, "⠦")), `${String(done)}/${String(run.agents.length)} agents`, cost, run.usage ? formatWorkflowRuntime(run.usage.durationMs) : ""].filter(Boolean).join(" ");
}
/** The row of a run root or the group: arrow and ▾/▸ in the columns of a depth-0 /workflow row, the bold label, two spaces, the summary. */
function headerLine(label: string, summary: string, selected: boolean, expanded: boolean, expandable: boolean, styles: WorkflowProgressStyles): string {
  return `${selected ? "→" : " "} ${expandable ? expanded ? "▾" : "▸" : " "} ${styles.bold(label)}  ${summary}`;
}

export function createSessionAgentsSource(context: ExtensionCommandContext, deps: SessionAgentsDependencies): SessionAgentsSource {
  const runAgent = (run: PersistedRun, agent: AgentRecord): SessionAgent => {
    const attempt = latestAttempt(agent.attemptDetails);
    const running = !SETTLED_AGENT_STATES.has(agent.state);
    return {
      key: `run:${run.id}:${agent.id}`,
      name: sanitizeDisplayText(agent.label ?? agent.name),
      state: agent.state,
      summary: agentSummary(agent.model, agent.accounting),
      cwd: attempt?.setup.cwd ?? context.cwd,
      attempt: attempt?.attempt,
      // The run comes from this Pi session's RunStore, so its owner is confirmed; the reader checks the file.
      owned: true,
      session: attempt?.session,
      live: attemptLiveSession(deps.liveAgent(run.id, agent.id), attempt),
      activity: activityLabel(running, agent),
      running,
    };
  };
  /** The run's /workflow tree, every node in the order /workflow draws them, under a header row for the run. */
  const runNodes = (run: PersistedRun, snapshot: Readonly<LaunchSnapshot>): SessionTreeNode[] => {
    const tree = buildWorkflowPhaseTree(buildWorkflowPhaseModel(run, snapshot));
    const expanded = workflowPhaseTreeInitialExpanded(tree);
    const key = (node: WorkflowPhaseTreeNode): string => node.kind === "workflow" ? `run:${run.id}` : node.kind === "agent" && node.agent ? `run:${run.id}:${node.agent.id}` : `run:${run.id}:node:${node.id}`;
    const shownRun = { workflowName: sanitizeDisplayText(run.workflowName), id: sanitizeDisplayText(run.id) };
    // Every node expanded: the sidebar order, a parent before its children.
    return workflowPhaseTreeVisibleNodes(tree, new Set(tree.nodes.map(({ id }) => id))).map((node) => {
      const parent = node.parentId === undefined ? undefined : tree.byId.get(node.parentId);
      const root = node.kind === "workflow";
      // Below its header a run's nodes sit one level deeper than in /workflow, where the phases share the root's depth 0.
      const depth = root ? 0 : node.depth + 1;
      // The run root names its run: the sidebar holds several runs, and /workflow's "Workflow" would not tell them apart.
      const shown = root ? { ...displayNode(node), label: `${shownRun.workflowName} ${shownRun.id.slice(0, 8)}` } : { ...displayNode(node), depth };
      const agent = node.kind === "agent" ? node.agent : undefined;
      return {
        key: key(node),
        parentKey: parent && key(parent),
        depth,
        kind: RUN_NODE_KIND[node.kind],
        // A finished run starts collapsed; inside a run the nodes start as in /workflow.
        initiallyExpanded: root ? !isHardTerminalRunState(run.state) : expanded.has(node.id),
        line: (styles, selected, open) => root ? headerLine(shown.label, runSummary(run, styles), selected, open, node.children.length > 0, styles) : formatWorkflowTreeLine(shown, selected, open, styles),
        details: (styles, now) => agent ? [] : formatWorkflowNodeDetails(shownRun, tree, shown, styles, now, false),
        title: (styles) => nodeTitle(shown.label, node.state, styles),
        agent: agent && runAgent(run, agent),
      };
    });
  };
  const workflowNodes = async (): Promise<SessionTreeNode[]> => {
    const sessionId = context.sessionManager.getSessionId();
    // A display refresh: leave the cleanup of abandoned run temps to the /workflow picker.
    const runIds = await listRunIds(context.cwd, sessionId, deps.home, false);
    const loaded = await Promise.all(runIds.map(async (runId) => {
      const store = new RunStore(context.cwd, sessionId, runId, deps.home);
      try {
        const { run, snapshot } = await store.load();
        // As the /workflow picker: a settled run sorts by the time it settled.
        const terminalAt = (await store.loadSummary().catch(() => undefined))?.terminalAt;
        const resolvedAt = terminalAt === undefined ? undefined : Date.parse(terminalAt);
        return { loaded: { run: deps.overlayRun(run), snapshot }, resolvedAt: resolvedAt !== undefined && Number.isFinite(resolvedAt) ? resolvedAt : undefined };
      } catch { return undefined; }
    }));
    return navigatorAttentionSort(loaded.filter((entry) => entry !== undefined)).flatMap(({ loaded: { run, snapshot } }) => runNodes(run, snapshot));
  };
  const subagent = (manager: SubagentManager, status: SubagentStatus, owned: boolean): SessionTreeNode => {
    const liveData = manager.getAttemptActionData?.(status.id);
    const attempt = attemptValue(liveData?.attempt) ?? latestAttempt(status.attemptDetails);
    const running = status.state === "running";
    // The label lives in the run's request.json under the manager's storage directory, which this source does not read.
    const name = sanitizeDisplayText(status.id.length > 12 ? status.id.slice(0, 8) : status.id);
    const agent: SessionAgent = {
      key: `subagent:${status.id}`,
      name,
      state: status.state,
      summary: agentSummary(status.progress?.state?.model ?? attempt?.setup.model, status.progress?.accounting),
      cwd: attempt?.setup.cwd ?? context.cwd,
      attempt: attempt?.attempt,
      owned,
      session: attempt?.session,
      live: owned ? attemptLiveSession(liveData?.liveSession, attempt) : undefined,
      activity: activityLabel(running, status.progress),
      running,
    };
    return {
      key: agent.key,
      parentKey: "subagents",
      depth: 1,
      kind: "agent",
      initiallyExpanded: false,
      // The /subagents list row, one level down.
      line: (styles, selected, expanded) => formatWorkflowTreeLine({ kind: "agent", label: name, depth: 1, state: status.state, children: [] }, selected, expanded, styles),
      details: () => [],
      title: (styles) => nodeTitle(name, status.state, styles),
      agent,
    };
  };
  const subagentNodes = async (): Promise<SessionTreeNode[]> => {
    const manager = deps.subagents();
    if (manager === undefined) return [];
    const sessionId = context.sessionManager.getSessionId();
    const listed = await manager.inspect({}, managerContext(context, false));
    if (!Array.isArray(listed)) return [];
    const statuses = listed.map((value) => statusValue(value)).filter((status): status is SubagentStatus => status?.sessionId === sessionId);
    const entries = await Promise.all(statuses.map(async (row) => {
      const record = await manager.inspect({ id: row.id }, managerContext(context, true)).catch(() => undefined);
      const inspected = statusValue(record);
      // The inspected record, not the list row, proves the owner; the storage directory proves nothing (it may be a custom storageDir).
      const cwd = isObject(record) ? record.cwd : undefined;
      const owned = inspected !== undefined && inspected.sessionId === sessionId && safeSubagentId(inspected.id) && (typeof cwd !== "string" || sameFilesystemPath(cwd, context.cwd));
      return { status: inspected ?? row, owned };
    }));
    const sorted = navigatorAttentionSortByState(entries, ({ status }) => status.state, ({ status }) => status.finishedAt, SUBAGENT_ATTENTION_ORDER);
    const first = sorted[0];
    if (first === undefined) return [];
    const children = sorted.map(({ status, owned }) => subagent(manager, status, owned));
    // The group takes the state of its first subagent: the one the /subagents order puts first.
    const state = first.status.state;
    const counts = subagentsCounts(sorted.map(({ status }) => status));
    const group: SessionTreeNode = {
      key: "subagents",
      parentKey: undefined,
      depth: 0,
      kind: "group",
      // An idle group starts collapsed.
      initiallyExpanded: sorted.some(({ status }) => status.state === "running"),
      line: (styles, selected, expanded) => headerLine("Subagents", counts, selected, expanded, true, styles),
      details: (styles) => [styles.bold(styles.accent("Subagents")), counts],
      title: (styles) => nodeTitle("Subagents", state, styles),
      agent: undefined,
    };
    return [group, ...children];
  };
  return {
    list: async () => {
      const [workflows, subagents] = await Promise.all([workflowNodes(), subagentNodes()]);
      return [...workflows, ...subagents];
    },
  };
}
