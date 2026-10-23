import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentManager, SubagentStatus } from "../subagents/src/contracts.js";
import { attemptValue, latestAttempt, managerContext, safeSubagentId, shortSubagentId, statusValue, SUBAGENT_ATTENTION_ORDER } from "../subagents/src/decode.js";
import type { AgentsActionTarget, SubagentPresentation, SubagentPresenter } from "./agents-actions-contract.js";
import { formatCost, formatTokens } from "./background-widget.js";
import { buildWorkflowPhaseModel, buildWorkflowPhaseTree, workflowPhaseTreeInitialExpanded, workflowPhaseTreeVisibleNodes, type WorkflowPhaseTreeNode } from "./host-phases.js";
import { agentActivityLabel, formatWorkflowNodeDetails, formatWorkflowRuntime, formatWorkflowTreeLine, navigatorAttentionSort, navigatorAttentionSortByState, progressStyleForState, runStateGlyph, type WorkflowProgressStyles } from "./host-view.js";
import { sameFilesystemPath } from "./paths.js";
import { listRunIds, RunStore, type PersistedRun } from "./persistence.js";
import { isHardTerminalRunState, SETTLED_AGENT_STATES, type AgentAccounting, type AgentAttemptError, type AgentAttemptSummary, type AgentRecord, type LaunchSnapshot, type ModelSpec, type WorkflowAgentSession, type WorkflowAgentSessionReference } from "./types.js";
import { budgetUsage } from "./budget.js";
import { errorText, isObject, sanitizeDisplayText } from "./utils.js";

/** An agent of the sidebar tree: what the workspace needs to show its transcript. */
export interface SessionAgent {
  /** Stable across refreshes: `run:<runId>:<agentId>` or `subagent:<id>`. */
  readonly key: string;
  readonly name: string;
  readonly state: string;
  /** Model, tokens and cost as the dashboards show them; the workspace adds "#position/count" and the name. */
  readonly summary: string;
  /** Working directory of the attempt; tool renderers resolve paths against it. */
  readonly cwd: string;
  /** Latest attempt number; a change shows a fresh transcript. */
  readonly attempt: number | undefined;
  /** The record belongs to this Pi session (and project); when false the session file is never opened. */
  readonly owned: boolean;
  readonly session: WorkflowAgentSessionReference | undefined;
  /** The in-process session of the shown attempt, only when its reference matches `session`. */
  readonly live: Pick<WorkflowAgentSession, "subscribe"> | undefined;
  /** One line of current activity while running. */
  readonly activity: string | undefined;
  readonly running: boolean;
}

/**
 * One node of the sidebar tree: each workflow run's /workflow tree (run root, phases,
 * operation scopes, shells, agents), then a "Subagents" group with one child per standalone subagent.
 */
export interface SessionTreeNode {
  /** Stable across refreshes: `run:<runId>` for a run root, `run:<runId>:node:<WorkflowPhaseTree node id>` for its other nodes, the agent's key for an agent, `subagents` for the group. */
  readonly key: string;
  /** Undefined for a run root and the group. */
  readonly parentKey: string | undefined;
  /** 0 for a run root and the group; a run's other nodes one level below their /workflow tree depth (where the phases share the root's 0); the subagents at 1. */
  readonly depth: number;
  readonly kind: "run" | "phase" | "operation" | "shell" | "agent" | "group";
  /**
   * The expansion a node takes the first time a list contains it: a run root while its run is not in a hard terminal state, its
   * other nodes workflowPhaseTreeInitialExpanded of the run; the group while one of its subagents runs.
   */
  readonly initiallyExpanded: boolean;
  /**
   * The node's row, its ▾/▸ icon (when it has children) at display column 2 + 2 * depth. A run root and the group are headers:
   * selection arrow, icon, bold label, two spaces, a summary (the run's state glyph, done/total agents, cost and runtime; the
   * group's counts and cost). Every other node is its /workflow tree row at `depth`: arrow, indent, ▾/▸/•/◇ icon, label, " · ", state glyph.
   */
  line(styles: WorkflowProgressStyles, selected: boolean, expanded: boolean): string;
  /**
   * What the right pane shows for a node that is not an agent, as /workflow details it without its enter hints. For an
   * agent, what `d` shows instead of its transcript (/workflow's agent details, the /subagents detail rows); empty when
   * there is nothing to show.
   */
  details(styles: WorkflowProgressStyles, now: number): readonly string[];
  /** The title row of a node that is not an agent: its label and state. */
  title(styles: WorkflowProgressStyles): string;
  /** Set only for kind "agent". */
  readonly agent: SessionAgent | undefined;
  /** What the node's actions apply to; a node without one has no action menu. */
  readonly target?: AgentsActionTarget;
}

export interface SessionAgentsSource {
  /** The sidebar tree of the current Pi session in sidebar order (a parent before its children); called when the workspace opens and on every refresh tick. */
  list(): Promise<readonly SessionTreeNode[]>;
}

export interface SessionAgentsDependencies {
  readonly home: string | undefined;
  /** The host's live view of a run (activity, in-flight tools) over its persisted state. */
  overlayRun(run: PersistedRun): PersistedRun;
  /** The in-process session of a workflow agent, whatever attempt it runs. */
  liveAgent(runId: string, agentId: string): WorkflowAgentSession | undefined;
  subagents(): SubagentManager | undefined;
  /** Names and details of the subagents, from the subagents extension when it publishes them. */
  readonly subagentPresenter?: () => SubagentPresenter | undefined;
}

/** What a source lists: /agents both, /workflow its runs, /subagents its group. */
export type SessionAgentsScope = "all" | "workflows" | "subagents";

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
/** An agent id as the last part of its key: one that starts like a tree node's part ("node:") or like this escape ("~") gets a "~" first, so no agent key equals a node key and no two ids share a key. */
function agentKeyPart(id: string): string { return id.startsWith("node:") || id.startsWith("~") ? `~${id}` : id; }
/** The tree kind of each /workflow tree node kind. */
const RUN_NODE_KIND: Readonly<Record<WorkflowPhaseTreeNode["kind"], SessionTreeNode["kind"]>> = { workflow: "run", phase: "phase", operation: "operation", shell: "shell", agent: "agent" };
/** The title row of a node: its label and state. */
function nodeTitle(label: string, state: string, styles: WorkflowProgressStyles): string {
  return `${styles.bold(label)} ${progressStyleForState(state, styles)(state)}`;
}
function displayError(error: AgentAttemptError): AgentAttemptError { return { code: sanitizeDisplayText(error.code), message: sanitizeDisplayText(error.message) }; }
/** The strings an agent's /workflow details show, as display text; its states and numbers stay as they are. */
function displayAgent(agent: AgentRecord): AgentRecord {
  return {
    ...agent,
    model: { ...agent.model, provider: sanitizeDisplayText(agent.model.provider), model: sanitizeDisplayText(agent.model.model) },
    tools: agent.tools.map(sanitizeDisplayText),
    ...(agent.structuralPath ? { structuralPath: agent.structuralPath.map(sanitizeDisplayText) } : {}),
    ...(agent.activity ? { activity: { ...agent.activity, text: sanitizeDisplayText(agent.activity.text) } } : {}),
    ...(agent.attemptDetails ? { attemptDetails: agent.attemptDetails.map((attempt) => attempt.error ? { ...attempt, error: displayError(attempt.error) } : attempt) } : {}),
  };
}
/** The text a /workflow tree node shows, as display text; its id, and so its key, stays the run's own. */
function displayNode(node: WorkflowPhaseTreeNode): WorkflowPhaseTreeNode {
  return { ...node, label: sanitizeDisplayText(node.label), phaseId: sanitizeDisplayText(node.phaseId), operationPath: node.operationPath.map(sanitizeDisplayText), ...(node.phase ? { phase: { ...node.phase, name: sanitizeDisplayText(node.phase.name) } } : {}), ...(node.agent ? { agent: displayAgent(node.agent) } : {}) };
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
  return [progressStyleForState(run.state, styles)(runStateGlyph(run.state, "⠦")), `${String(done)}/${String(run.agents.length)} agents`, cost, run.usage && (run.state !== "running" || run.usage.durationMs >= 1000) ? formatWorkflowRuntime(run.usage.durationMs) : ""].filter(Boolean).join(" ");
}
/** The row of a run root or the group: arrow and ▾/▸ in the columns of a depth-0 /workflow row, the bold label, two spaces, the summary. */
function headerLine(label: string, summary: string, selected: boolean, expanded: boolean, expandable: boolean, styles: WorkflowProgressStyles): string {
  return `${selected ? "→" : " "} ${expandable ? expanded ? "▾" : "▸" : " "} ${styles.bold(label)}  ${summary}`;
}

/** The Subagents group when the manager cannot list: its details say why, and it has no children. */
function unavailableGroup(reason: string): SessionTreeNode {
  const text = `subagents unavailable: ${sanitizeDisplayText(reason)}`;
  return {
    key: "subagents", parentKey: undefined, depth: 0, kind: "group", initiallyExpanded: false,
    line: (styles, selected, expanded) => headerLine("Subagents", styles.warning("unavailable"), selected, expanded, false, styles),
    details: (styles) => [styles.bold(styles.accent("Subagents")), text],
    title: (styles) => nodeTitle("Subagents", "failed", styles),
    agent: undefined,
    target: { kind: "subagents" },
  };
}

/**
 * The identity (modification time, size, inode) of the run files a listing reads: equal stamps mean none was written again.
 */
async function runStamp(directory: string): Promise<string | undefined> {
  const infos = await Promise.all(["state.json", "journal.json"].map((name) => stat(join(directory, name)).catch(() => undefined)));
  return infos[0] === undefined ? undefined : infos.map((info) => info === undefined ? "-" : `${String(info.mtimeMs)}:${String(info.size)}:${String(info.ino)}`).join("|");
}

/** Whether summary.json is written no earlier than state.json and journal.json: only then does the summary hold the time the run settled. */
async function summaryIsFresh(directory: string): Promise<boolean> {
  const times = await Promise.all(["summary.json", "state.json", "journal.json"].map(async (name) => (await stat(join(directory, name))).mtimeMs)).catch(() => undefined);
  return times !== undefined && times[0] !== undefined && times[0] >= Math.max(times[1] ?? 0, times[2] ?? 0);
}

/** What a listing reads of a run; createdAt is NaN without a readable summary. */
type ReadRun = { readonly loaded: { readonly run: PersistedRun; readonly snapshot: Readonly<LaunchSnapshot> }; readonly resolvedAt: number | undefined; readonly createdAt: number };

export function createSessionAgentsSource(context: ExtensionContext, deps: SessionAgentsDependencies, scope: SessionAgentsScope = "all"): SessionAgentsSource {
  /** Every run read: its state, snapshot and summary are read again only when its stamp changes. */
  const runs = new Map<string, ReadRun & { readonly stamp: string }>();
  /** Every subagent inspected and described: a settled one is inspected and described again only when its listed state or finishedAt changes. */
  const subagentsSeen = new Map<string, { readonly state: SubagentStatus["state"]; readonly finishedAt: number | undefined; readonly record: unknown; readonly described: boolean; readonly presentation: SubagentPresentation | undefined }>();
  const runAgent = (run: PersistedRun, agent: AgentRecord): SessionAgent => {
    const attempt = latestAttempt(agent.attemptDetails);
    const running = !SETTLED_AGENT_STATES.has(agent.state);
    return {
      key: `run:${run.id}:${agentKeyPart(agent.id)}`,
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
    const model = buildWorkflowPhaseModel(run, snapshot);
    const tree = buildWorkflowPhaseTree(model);
    const expanded = workflowPhaseTreeInitialExpanded(tree);
    const key = (node: WorkflowPhaseTreeNode): string => node.kind === "workflow" ? `run:${run.id}` : node.kind === "agent" && node.agent ? `run:${run.id}:${agentKeyPart(node.agent.id)}` : `run:${run.id}:node:${node.id}`;
    const shownRun = { workflowName: sanitizeDisplayText(run.workflowName), id: sanitizeDisplayText(run.id) };
    const runTarget: AgentsActionTarget = { kind: "run", runId: run.id };
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
        details: (styles, now) => formatWorkflowNodeDetails(shownRun, tree, shown, styles, now, false),
        title: (styles) => nodeTitle(shown.label, node.state, styles),
        agent: agent && runAgent(run, agent),
        target: agent ? { kind: "workflow-agent", runId: run.id, agentId: agent.id } : runTarget,
      };
    });
  };
  const workflowNodes = async (now: number): Promise<SessionTreeNode[]> => {
    const sessionId = context.sessionManager.getSessionId();
    // A display refresh: leave the cleanup of abandoned run temps to the /workflow picker.
    const runIds = await listRunIds(context.cwd, sessionId, deps.home, false);
    for (const id of [...runs.keys()]) if (!runIds.includes(id)) runs.delete(id);
    /** The run with the host's live overlay; a running run records its runtime only when it settles, so it shows the time since it was created. */
    const shown = ({ loaded, resolvedAt, createdAt }: ReadRun): Omit<ReadRun, "createdAt"> => {
      const overlaid = deps.overlayRun(loaded.run);
      const run = overlaid.state === "running" && Number.isFinite(createdAt)
        ? { ...overlaid, usage: { ...budgetUsage(overlaid.usage), durationMs: Math.max(overlaid.usage?.durationMs ?? 0, now - createdAt) } }
        : overlaid;
      return { loaded: { ...loaded, run }, resolvedAt };
    };
    const loaded = await Promise.all(runIds.map(async (runId) => {
      const store = new RunStore(context.cwd, sessionId, runId, deps.home);
      // Another Pi can run or resume the run: a changed file is read in full again.
      const stamp = await runStamp(store.directory);
      const cached = runs.get(runId);
      if (cached !== undefined && cached.stamp === stamp) return shown(cached);
      runs.delete(runId);
      try {
        const { run, snapshot } = await store.load();
        // As the /workflow picker: a settled run sorts by the time it settled.
        const summary = await store.loadSummary().catch(() => undefined);
        const terminalAt = summary?.terminalAt;
        const parsed = terminalAt === undefined ? Number.NaN : Date.parse(terminalAt);
        const resolvedAt = Number.isFinite(parsed) ? parsed : undefined;
        const entry = { loaded: { run, snapshot }, resolvedAt, createdAt: summary === undefined ? Number.NaN : Date.parse(summary.createdAt) };
        // A settled run is kept only once summary.json has caught up with it: until then the time it settled may be stale.
        if (stamp !== undefined && (!isHardTerminalRunState(run.state) || await summaryIsFresh(store.directory))) runs.set(runId, { ...entry, stamp });
        return shown(entry);
      } catch { return undefined; }
    }));
    return navigatorAttentionSort(loaded.filter((entry) => entry !== undefined)).flatMap(({ loaded: { run, snapshot } }) => runNodes(run, snapshot));
  };
  /** The row of the listed subagent `id`: its key, name and target address that id; `status` gives its state and attempt. */
  const subagent = (manager: SubagentManager, id: string, status: SubagentStatus, owned: boolean, presentation: SubagentPresentation | undefined): SessionTreeNode => {
    const liveData = manager.getAttemptActionData?.(id);
    const attempt = attemptValue(liveData?.attempt) ?? latestAttempt(status.attemptDetails);
    const running = status.state === "running";
    // The label lives in the run's request.json under the manager's storage directory: only the subagents extension's presenter reads it.
    // A presentation name that is blank after sanitizing (empty, controls, whitespace or an escape only) keeps the short id, as /subagents does with a blank label.
    const name = sanitizeDisplayText(presentation?.name ?? "").trim() || sanitizeDisplayText(shortSubagentId(id));
    const agent: SessionAgent = {
      key: `subagent:${id}`,
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
      details: (styles, now) => {
        // A presenter that throws while drawing must not break the pane.
        try { return presentation?.details(styles, now) ?? []; } catch { return []; }
      },
      title: (styles) => nodeTitle(name, status.state, styles),
      agent,
      target: { kind: "subagent", id },
    };
  };
  const subagentNodes = async (): Promise<SessionTreeNode[]> => {
    const manager = deps.subagents();
    if (manager === undefined) return [];
    const sessionId = context.sessionManager.getSessionId();
    // managerContext types its context as a command's but only hands it on as the manager's ExtensionContext.
    const command = context as ExtensionCommandContext;
    let listed: unknown;
    try { listed = await manager.inspect({}, managerContext("agents-command", command)); } catch (error) { return [unavailableGroup(errorText(error))]; }
    if (!Array.isArray(listed)) return [];
    const statuses = listed.map((value) => statusValue(value)).filter((status): status is SubagentStatus => status?.sessionId === sessionId);
    // A row kept without a presentation (no presenter, or describe() failed) is described again from its cached record.
    let changed = [...subagentsSeen.values()].some(({ described }) => !described);
    for (const id of [...subagentsSeen.keys()]) if (!statuses.some((status) => status.id === id)) { subagentsSeen.delete(id); changed = true; }
    const entries = await Promise.all(statuses.map(async (row) => {
      const seen = subagentsSeen.get(row.id);
      const fresh = seen === undefined || row.state === "running" || seen.state !== row.state || seen.finishedAt !== row.finishedAt;
      if (fresh) changed = true;
      const record = fresh ? await manager.inspect({ id: row.id }, managerContext("agents-command", command, true)).catch(() => undefined) : seen.record;
      //NOTE: an inspection names the id it was asked for: one naming another id is not checked for here.
      const own = statusValue(record);
      // The inspected record, not the list row, proves the owner; the storage directory proves nothing (it may be a custom storageDir).
      const cwd = isObject(record) ? record.cwd : undefined;
      const owned = own !== undefined && own.sessionId === sessionId && safeSubagentId(row.id) && (typeof cwd !== "string" || sameFilesystemPath(cwd, context.cwd));
      return { id: row.id, row, status: own ?? row, owned, record };
    }));
    // As /subagents names its rows (loadEntries): every subagent this Pi session lists with a safe id, whatever its
    // inspection shows; owned decides only the transcript and the live stream. The presenter gets what was read here.
    const requested = new Map(entries.filter(({ id }) => safeSubagentId(id)).map(({ id, record }) => [id, record]));
    // Without presentations (no presenter, or a getter or describe() that fails) every subagent keeps its short id.
    // All are described again on any change: a twin name depends on the other subagents.
    // null: no presenter, or describe() failed.
    const presentations = !changed ? new Map([...subagentsSeen].map(([id, { presentation }]) => [id, presentation]))
      : requested.size > 0 ? await Promise.resolve().then(() => deps.subagentPresenter?.()?.describe([...requested.keys()], statuses, requested) ?? null).catch(() => null) : undefined;
    // A failed inspection is kept as one: it is inspected again only when its listed state or finishedAt changes.
    if (changed) for (const { id, row, record } of entries) subagentsSeen.set(id, { state: row.state, finishedAt: row.finishedAt, record, described: presentations !== null, presentation: requested.has(id) ? presentations?.get(id) : undefined });
    const sorted = navigatorAttentionSortByState(entries, ({ status }) => status.state, ({ status }) => status.finishedAt, SUBAGENT_ATTENTION_ORDER);
    if (sorted.length === 0) return [];
    // Each row is its listed id: its key, name, presentation and target; a presentation for an id not asked for is ignored.
    const children = sorted.map(({ id, status, owned }) => subagent(manager, id, status, owned, requested.has(id) ? presentations?.get(id) : undefined));
    // The group summarizes its subagents: running while one runs, else failed if one failed, else done.
    const states = sorted.map(({ status }) => status.state);
    const state = states.includes("running") ? "running" : states.includes("failed") ? "failed" : states.every((value) => value === "stopped") ? "stopped" : "completed";
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
      target: { kind: "subagents" },
    };
    return [group, ...children];
  };
  return {
    list: async () => {
      const now = Date.now();
      const [workflows, subagents] = await Promise.all([scope === "subagents" ? [] : workflowNodes(now), scope === "workflows" ? [] : subagentNodes()]);
      return [...workflows, ...subagents];
    },
  };
}
