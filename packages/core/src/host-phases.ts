import { type PersistedRun } from "./persistence.js";
import { type AgentRecord, type LaunchSnapshot, type RunState, type WorkflowPhaseShellActivity } from "./types.js";
import { object } from "./utils.js";

export const WORKFLOW_PHASE_STATES = ["not started", "running", "completed", "failed", "cancelled", "interrupted", "budget_exhausted"] as const;
export type WorkflowPhaseState = (typeof WORKFLOW_PHASE_STATES)[number];
export interface WorkflowPhaseAgentCounts { total: number; completed: number; running: number; failed: number; cancelled: number; pending: number }
export interface WorkflowPhaseView { id: string; name: string; occurrence: number; state: WorkflowPhaseState; observed: boolean; afterAgent?: number; agents: readonly AgentRecord[]; counts: WorkflowPhaseAgentCounts; shellActivity?: WorkflowPhaseShellActivity }
export interface WorkflowPhaseModel { runState: RunState; declaredPhases: readonly string[]; phases: readonly WorkflowPhaseView[]; currentPhaseIndex?: number; currentPhaseId?: string; counts: Readonly<Partial<Record<WorkflowPhaseState, number>>>; unassignedAgents?: readonly AgentRecord[] }
type WorkflowPhaseSource = readonly string[] | Pick<LaunchSnapshot, "phases"> | undefined;
function phaseNames(source: WorkflowPhaseSource): string[] {
  const phases: readonly unknown[] = source === undefined ? [] : Array.isArray(source) ? source : object(source) ? source.phases ?? [] : [];
  return phases.filter((phase): phase is string => typeof phase === "string" && phase.trim() !== "").map((phase) => phase.trim());
}
export function phaseAgentCounts(agents: readonly AgentRecord[]): WorkflowPhaseAgentCounts {
  const counts: WorkflowPhaseAgentCounts = { total: agents.length, completed: 0, running: 0, failed: 0, cancelled: 0, pending: 0 };
  for (const agent of agents) {
    if (agent.state === "completed") counts.completed += 1;
    else if (agent.state === "running") counts.running += 1;
    else if (agent.state === "failed") counts.failed += 1;
    else if (agent.state === "cancelled") counts.cancelled += 1;
    else counts.pending += 1;
  }
  return counts;
}
/** The live shell activity recorded for one phase index; `-1` is the preflight scope before any phase. */
export function shellActivityFor(run: Pick<PersistedRun, "activeShellsByPhase">, phaseIndex: number): WorkflowPhaseShellActivity | undefined {
  return run.activeShellsByPhase?.find((activity) => activity.phaseIndex === phaseIndex && activity.active > 0);
}
function phaseState(runState: RunState, counts: WorkflowPhaseAgentCounts, isLatest: boolean, shellActive = false): WorkflowPhaseState {
  if (!isLatest && !shellActive) return "completed";
  if (runState === "failed") return "failed";
  if (runState === "stopped") return "cancelled";
  if (runState === "interrupted") return "interrupted";
  if (runState === "budget_exhausted") return "budget_exhausted";
  if (counts.failed > 0) return "failed";
  if (shellActive) return "running";
  if (counts.cancelled > 0) return "cancelled";
  if (counts.running > 0 || counts.pending > 0) return "running";
  return runState === "completed" ? "completed" : "running";
}
type WorkflowPhaseRun = Omit<Pick<PersistedRun, "state" | "phase" | "phaseHistory" | "agents" | "activeShellsByPhase">, "phaseHistory"> & { phaseHistory?: unknown };
export function buildWorkflowPhaseModel(run: WorkflowPhaseRun, source?: WorkflowPhaseSource): WorkflowPhaseModel {
  const declaredPhases = phaseNames(source);
  const rawHistory: readonly unknown[] = Array.isArray(run.phaseHistory) ? run.phaseHistory : [];
  const observed: Array<{ name: string; afterAgent: number }> = [];
  let boundary = 0;
  for (const record of rawHistory) {
    if (!object(record) || typeof record.phase !== "string" || !record.phase.trim() || typeof record.afterAgent !== "number" || !Number.isSafeInteger(record.afterAgent)) continue;
    boundary = Math.max(boundary, Math.min(run.agents.length, Math.max(0, record.afterAgent)));
    observed.push({ name: record.phase.trim(), afterAgent: boundary });
  }
  if (!observed.length && typeof run.phase === "string" && run.phase.trim()) observed.push({ name: run.phase.trim(), afterAgent: 0 });
  const observedEntries = observed.map((entry, index) => ({ ...entry, index, agents: run.agents.slice(entry.afterAgent, observed[index + 1]?.afterAgent ?? run.agents.length) }));
  const matchedDeclarations = new Set<number>();
  const declarationIndices = observedEntries.map((entry) => {
    const index = declaredPhases.findIndex((name, candidate) => !matchedDeclarations.has(candidate) && name === entry.name);
    if (index >= 0) matchedDeclarations.add(index);
    return index >= 0 ? index : undefined;
  });
  const entries: Array<{ name: string; observedIndex?: number; declarationIndex?: number }> = observedEntries.map((entry, index) => ({ name: entry.name, observedIndex: index, ...(declarationIndices[index] === undefined ? {} : { declarationIndex: declarationIndices[index] }) }));
  for (const [declarationIndex, name] of declaredPhases.entries()) {
    if (matchedDeclarations.has(declarationIndex)) continue;
    const insertion = entries.findIndex((entry) => entry.declarationIndex !== undefined && entry.declarationIndex > declarationIndex);
    const pending = { name };
    if (insertion < 0) entries.push(pending); else entries.splice(insertion, 0, pending);
  }
  const occurrences = new Map<string, number>();
  const phases = entries.map((entry) => {
    const occurrence = (occurrences.get(entry.name) ?? 0) + 1;
    occurrences.set(entry.name, occurrence);
    const observation = entry.observedIndex === undefined ? undefined : observedEntries[entry.observedIndex];
    const agents = observation?.agents ?? [];
    const shellActivity = observation ? shellActivityFor(run, observation.index) : undefined;
    const counts = phaseAgentCounts(agents);
    const state = observation ? phaseState(run.state, counts, entry.observedIndex === observedEntries.length - 1, shellActivity !== undefined) : "not started";
    return { id: `${entry.name}#${String(occurrence)}`, name: entry.name, occurrence, state, observed: observation !== undefined, ...(observation ? { afterAgent: observation.afterAgent } : {}), agents, counts, ...(shellActivity ? { shellActivity } : {}) };
  });
  const preflightActivity = shellActivityFor(run, -1);
  const phasesWithPreflight = preflightActivity ? [{ id: "preflight", name: "Preflight", occurrence: 1, state: phaseState(run.state, phaseAgentCounts([]), true, true), observed: true, afterAgent: 0, agents: [], counts: phaseAgentCounts([]), shellActivity: preflightActivity }, ...phases] : phases;
  let currentPhaseIndex: number | undefined;
  for (let index = phasesWithPreflight.length - 1; index >= 0; index -= 1) { if (phasesWithPreflight[index]?.observed) { currentPhaseIndex = index; break; } }
  const counts: Partial<Record<WorkflowPhaseState, number>> = {};
  for (const phase of phasesWithPreflight) counts[phase.state] = (counts[phase.state] ?? 0) + 1;
  const current = currentPhaseIndex === undefined ? undefined : phasesWithPreflight[currentPhaseIndex];
  const assigned = new Set(observedEntries.flatMap(({ agents }) => agents.map((agent) => agent.id)));
  const unassignedAgents = run.agents.filter((agent) => !assigned.has(agent.id));
  const result: WorkflowPhaseModel = { runState: run.state, declaredPhases, phases: phasesWithPreflight, counts };
  if (current !== undefined && currentPhaseIndex !== undefined) { result.currentPhaseIndex = currentPhaseIndex; result.currentPhaseId = current.id; }
  if (unassignedAgents.length) result.unassignedAgents = unassignedAgents;
  return result;
}
export interface WorkflowPhaseSelection { phaseId?: string | undefined; agentId?: string | undefined; nodeId?: string | undefined; expandedNodeIds?: readonly string[] | undefined; treeOnly?: boolean | undefined; detailsOnly?: boolean | undefined; actions?: { title: string; options: readonly string[]; index: number } | undefined }
export type WorkflowPhaseTreeNodeKind = "workflow" | "phase" | "operation" | "agent" | "shell";
export interface WorkflowPhaseTreeNode { id: string; kind: WorkflowPhaseTreeNodeKind; label: string; depth: number; phaseId: string; operationPath: readonly string[]; parentId?: string; children: readonly string[]; state: WorkflowPhaseState | RunState | AgentRecord["state"]; agentId?: string; agent?: AgentRecord; phase?: WorkflowPhaseView; shellActivity?: WorkflowPhaseShellActivity }
export interface WorkflowPhaseTree { roots: readonly string[]; nodes: readonly WorkflowPhaseTreeNode[]; byId: ReadonlyMap<string, WorkflowPhaseTreeNode> }
export interface WorkflowPhaseTreeSelection { nodeId?: string | undefined }
export type WorkflowPhaseTreeDirection = "up" | "down" | "left" | "right";
export function workflowPhaseTreePath(kind: WorkflowPhaseTreeNodeKind, phaseId: string, operationPath: readonly string[], agentId?: string): string {
  if (kind === "workflow") return "workflow";
  const root = `phase/${encodeURIComponent(phaseId)}`;
  if (kind === "phase") return root;
  if (kind === "shell") return `${root}/shell`;
  const operation = operationPath.map((part) => encodeURIComponent(part)).join("/");
  if (kind === "operation") return `${root}/operation/${operation}`;
  return operation ? `${root}/operation/${operation}/agent/${encodeURIComponent(agentId ?? "")}` : `${root}/agent/${encodeURIComponent(agentId ?? "")}`;
}
function workflowPhaseTreeAggregateState(states: readonly AgentRecord["state"][]): AgentRecord["state"] {
  if (!states.length || states.every((state) => state === "completed")) return "completed";
  if (states.some((state) => state === "failed")) return "failed";
  if (states.some((state) => state === "cancelled")) return "cancelled";
  if (states.some((state) => state === "running")) return "running";
  return "queued";
}
export function buildWorkflowPhaseTree(model: WorkflowPhaseModel): WorkflowPhaseTree {
  type Draft = Omit<WorkflowPhaseTreeNode, "children"> & { children: string[] };
  type AgentEntry = { agent: AgentRecord; node?: Draft; structuralPath: readonly string[]; operationPath: readonly string[]; defaultParentId: string };
  const drafts = new Map<string, Draft>();
  const roots: string[] = [];
  const add = (node: Omit<Draft, "children">, parentId?: string): Draft => {
    const existing = drafts.get(node.id);
    if (existing) return existing;
    const draft: Draft = { ...node, ...(parentId === undefined ? {} : { parentId }), children: [] };
    drafts.set(draft.id, draft);
    if (parentId === undefined) roots.push(draft.id); else drafts.get(parentId)?.children.push(draft.id);
    return draft;
  };
  const samePath = (left: readonly string[], right: readonly string[]): boolean => left.length === right.length && left.every((part, index) => part === right[index]);
  const addPhase = (phaseId: string, label: string, agents: readonly AgentRecord[], phase?: WorkflowPhaseView): void => {
    const phaseNode = add({ id: workflowPhaseTreePath("phase", phaseId, []), kind: "phase", label, depth: 0, phaseId, operationPath: [], state: phase?.state ?? workflowPhaseTreeAggregateState(agents.map((agent) => agent.state)), ...(phase ? { phase } : {}) }, workflowNode.id);
    if (phase?.shellActivity) add({ id: workflowPhaseTreePath("shell", phaseId, []), kind: "shell", label: `shell [running] (${String(phase.shellActivity.active)} active)`, depth: 0, phaseId, operationPath: [], state: "running", phase, shellActivity: phase.shellActivity }, phaseNode.id);
    const operationNodes = new Map<string, Draft>();
    const entries: AgentEntry[] = agents.map((agent) => {
      const structuralPath = [...(agent.structuralPath ?? [])];
      return { agent, structuralPath, operationPath: [...structuralPath, ...(agent.parentBreadcrumb ? [agent.parentBreadcrumb] : [])], defaultParentId: phaseNode.id };
    });
    const agentEntries = new Map(entries.map((entry) => [entry.agent.id, entry]));
    const acceptedParents = new Map<string, string>();
    const wouldCycle = (childId: string, parentId: string): boolean => {
      const seen = new Set<string>([childId]);
      let current: string | undefined = parentId;
      while (current) {
        if (seen.has(current)) return true;
        seen.add(current);
        current = acceptedParents.get(current);
      }
      return false;
    };
    for (const entry of entries) {
      const parent = entry.agent.parentId ? agentEntries.get(entry.agent.parentId) : undefined;
      if (parent && !wouldCycle(entry.agent.id, parent.agent.id)) acceptedParents.set(entry.agent.id, parent.agent.id);
    }
    const operationChain = (path: readonly string[], owner: Draft, startIndex = 0): Draft => {
      let parent = owner;
      for (let index = startIndex; index < path.length; index += 1) {
        const prefix = path.slice(0, index + 1);
        const key = `${owner.id}:${JSON.stringify(prefix)}`;
        const existing = operationNodes.get(key);
        if (existing) { parent = existing; continue; }
        const suffix = path.slice(startIndex, index + 1).map((part) => encodeURIComponent(part)).join("/");
        const id = owner.id === phaseNode.id ? workflowPhaseTreePath("operation", phaseId, prefix) : `${owner.id}/operation/${suffix}`;
        const operation = add({ id, kind: "operation", label: prefix.at(-1) ?? "", depth: 0, phaseId, operationPath: prefix, state: "queued", ...(phase ? { phase } : {}) }, parent.id);
        operationNodes.set(key, operation);
        parent = operation;
      }
      return parent;
    };
    for (const entry of entries) {
      if (!acceptedParents.has(entry.agent.id)) entry.defaultParentId = operationChain(entry.operationPath, phaseNode).id;
    }
    for (const entry of entries) {
      entry.node = add({ id: workflowPhaseTreePath("agent", phaseId, entry.structuralPath, entry.agent.id), kind: "agent", label: entry.agent.label ?? entry.agent.name, depth: 0, phaseId, operationPath: entry.structuralPath, state: entry.agent.state, agentId: entry.agent.id, agent: entry.agent }, phaseNode.id);
    }
    const attach = (node: Draft, parentId: string): void => {
      const previous = node.parentId ? drafts.get(node.parentId) : undefined;
      if (previous) previous.children = previous.children.filter((childId) => childId !== node.id);
      node.parentId = parentId;
      const parent = drafts.get(parentId);
      if (parent && !parent.children.includes(node.id)) parent.children.push(node.id);
    };
    for (const entry of entries) {
      const node = entry.node;
      if (!node) continue;
      const parentId = acceptedParents.get(entry.agent.id);
      const parent = parentId ? agentEntries.get(parentId) : undefined;
      const parentNode = parent?.node;
      if (parent && parentNode) {
        if (samePath(entry.operationPath, parent.operationPath)) entry.defaultParentId = parentNode.id;
        else {
          const commonLength = entry.operationPath.findIndex((part, index) => parent.operationPath[index] !== part);
          const startIndex = commonLength < 0 ? Math.min(entry.operationPath.length, parent.operationPath.length) : commonLength;
          entry.defaultParentId = operationChain(entry.operationPath, parentNode, startIndex).id;
        }
      }
      attach(node, entry.defaultParentId);
    }
    const setDepth = (node: Draft, depth: number, seen = new Set<string>()): void => {
      if (seen.has(node.id)) return;
      seen.add(node.id);
      node.depth = depth;
      for (const childId of node.children) { const child = drafts.get(childId); if (child) setDepth(child, depth + 1, seen); }
    };
    setDepth(phaseNode, 0);
    const statesFor = (node: Draft, seen = new Set<string>()): AgentRecord["state"][] => {
      if (seen.has(node.id)) return [];
      const nextSeen = new Set(seen).add(node.id);
      return node.children.flatMap((childId) => {
        const child = drafts.get(childId);
        return child?.kind === "agent" ? [child.agent?.state ?? "queued", ...statesFor(child, nextSeen)] : child ? statesFor(child, nextSeen) : [];
      });
    };
    for (const operation of operationNodes.values()) operation.state = workflowPhaseTreeAggregateState(statesFor(operation));
  };
  const workflowNode = add({ id: "workflow", kind: "workflow", label: "Workflow", depth: 0, phaseId: "", operationPath: [], state: model.runState });
  for (const phase of model.phases) addPhase(phase.id, `${phase.name}${phase.occurrence > 1 ? ` #${String(phase.occurrence)}` : ""}`, phase.agents, phase);
  if (model.unassignedAgents?.length) addPhase("unassigned", "Unassigned", model.unassignedAgents);
  const nodes = [...drafts.values()].map((node) => ({ ...node, children: [...node.children] }));
  return { roots, nodes, byId: new Map(nodes.map((node) => [node.id, node])) };
}
export function workflowPhaseTreeVisibleNodes(tree: WorkflowPhaseTree, expanded: ReadonlySet<string> = new Set()): readonly WorkflowPhaseTreeNode[] {
  const visible: WorkflowPhaseTreeNode[] = [];
  const visit = (id: string): void => {
    const node = tree.byId.get(id);
    if (!node) return;
    visible.push(node);
    if (expanded.has(node.id)) for (const childId of node.children) visit(childId);
  };
  for (const root of tree.roots) visit(root);
  return visible;
}
export function workflowPhaseTreeInitialExpanded(tree: WorkflowPhaseTree): ReadonlySet<string> {
  return new Set(tree.nodes.filter((node) => node.children.length > 0).map((node) => node.id));
}
export function preserveWorkflowPhaseTreeSelection(tree: WorkflowPhaseTree, selection: WorkflowPhaseTreeSelection): WorkflowPhaseTreeSelection {
  const node = (selection.nodeId ? tree.byId.get(selection.nodeId) : undefined) ?? tree.nodes[0];
  return node ? { nodeId: node.id } : {};
}
export function navigateWorkflowPhaseTree(tree: WorkflowPhaseTree, selectedNodeId: string | undefined, expandedNodeIds: ReadonlySet<string>, direction: WorkflowPhaseTreeDirection): { nodeId?: string; expandedNodeIds: ReadonlySet<string> } {
  const expanded = new Set(expandedNodeIds);
  const current = (selectedNodeId ? tree.byId.get(selectedNodeId) : undefined) ?? tree.nodes[0];
  if (!current) return { expandedNodeIds: expanded };
  if (direction === "left") {
    if (current.children.length && expanded.delete(current.id)) return { nodeId: current.id, expandedNodeIds: expanded };
    return { nodeId: current.parentId ?? current.id, expandedNodeIds: expanded };
  }
  if (direction === "right") {
    if (current.children.length && !expanded.has(current.id)) { expanded.add(current.id); return { nodeId: current.id, expandedNodeIds: expanded }; }
    return { nodeId: current.children[0] ?? current.id, expandedNodeIds: expanded };
  }
  const visible = workflowPhaseTreeVisibleNodes(tree, expanded);
  const index = Math.max(0, visible.findIndex((node) => node.id === current.id));
  const next = visible[(index + (direction === "up" ? visible.length - 1 : 1)) % visible.length];
  return { nodeId: next?.id ?? current.id, expandedNodeIds: expanded };
}
export function preserveWorkflowPhaseSelection(model: WorkflowPhaseModel, selection: WorkflowPhaseSelection): WorkflowPhaseSelection {
  const phase = model.phases.find((candidate) => candidate.id === selection.phaseId) ?? (model.currentPhaseIndex === undefined ? undefined : model.phases[model.currentPhaseIndex]) ?? model.phases[0];
  if (!phase) return model.unassignedAgents?.length ? { nodeId: workflowPhaseTreePath("phase", "unassigned", []) } : {};
  const tree = buildWorkflowPhaseTree(model);
  const selectedAgent = selection.agentId ? phase.agents.find((candidate) => candidate.id === selection.agentId) : undefined;
  const selectedCandidate = selection.nodeId ? tree.byId.get(selection.nodeId) : undefined;
  const selected = selectedCandidate?.phaseId === phase.id ? selectedCandidate : selectedAgent ? tree.byId.get(workflowPhaseTreePath("agent", phase.id, selectedAgent.structuralPath ?? [], selectedAgent.id)) : undefined;
  const nodeId = selected?.id ?? tree.byId.get(workflowPhaseTreePath("phase", phase.id, []))?.id;
  return { phaseId: phase.id, ...(selection.agentId && phase.agents.some((agent) => agent.id === selection.agentId) ? { agentId: selection.agentId } : phase.agents[0] ? { agentId: phase.agents[0].id } : {}), ...(nodeId ? { nodeId } : {}), ...(selection.expandedNodeIds ? { expandedNodeIds: selection.expandedNodeIds } : {}) };
}
