import { SEMANTIC_MAP_LIMITS } from "../semantic-map-build.js";

export type SemanticNodeKind = "workflow" | "task" | "agent" | "system" | "user" | "assistant" | "tool-call" | "result";
/** `sequence`: recorded transcript order inside one agent; `phase`: agents of one recorded workflow phase precede the next phase. */
export type SemanticRelationKind = "contains" | "invokes" | "produces" | "sequence" | "phase" | "dependency" | "fork" | "merge" | "retry";
export type SemanticState = "running" | "success" | "failure" | "queued" | "waiting" | "paused" | "retrying" | "cancelled" | "interrupted" | "unknown";
export type SemanticNode = { id: string; kind: SemanticNodeKind; label: string; state: SemanticState; rawStatus: string; evidence: "recorded" | "structural" | "unavailable"; sourceRef: string; agentId?: string; attempt?: number;
  /** Transcript position inside the agent box (events and tool calls). */
  order?: number;
  /** Agent cards only: total attempts and how many of them failed (retries are drawn on one card, never as copies). */
  attempts?: number; failedAttempts?: number;
  /** Agent cards only: recorded workflow phase index/name and launch position. */
  stage?: number; stageLabel?: string; phaseNumber?: number; launch?: number;
  /** Tool cards only: consecutive calls to the same tool drawn as one stacked card, and how many of them failed. */
  count?: number; failedCount?: number };
/** Transcript event kinds only; never message text, prompts, tool arguments or results. */
export type SemanticEvent = { kind: "system" | "user" | "assistant" | "tool"; id?: string; name?: string; state?: string; count?: number; failed?: number };
/** Whole-workflow figures computed by the parent over every recorded agent, including agents on other map pages. */
export type SemanticRunSummary = { agents: number; running: number; completed: number; failed: number; toolCalls: number; toolCallsPartial?: boolean; retries: number; page: number; pages: number; usage?: SemanticUsage };
export type SemanticEdge = { id: string; from: string; to: string; kind: SemanticRelationKind; evidence: "recorded" | "structural" };
export type SemanticGraph = {
  schemaVersion: 1;
  scope: { publisherId: string; targetKind: "run" | "subagent"; targetId: string; agentId?: string };
  nodes: SemanticNode[];
  edges: SemanticEdge[];
  completeness: { partial: boolean; reasons: string[]; omittedNodes: number; omittedEdges: number };
  /** Recorded token accounting only; context is the latest recorded assistant turn when its transcript is cached. */
  usage?: { total: SemanticUsage; agents: { agentId: string; usage: SemanticUsage }[] };
  summary?: SemanticRunSummary;
};
export type SemanticUsage = { input: number; output: number; cacheRead: number; cacheWrite: number; context?: number; cost?: number };
export type SemanticToolCall = { id: string; name: string; state: string };
export type SemanticAttempt = { attempt: number; error?: { code?: string } };
export type SemanticOutput = { status: string };
export type SemanticAgent = {
  id: string; name?: string; label?: string; state: string; parentId?: string;
  structuralPath?: readonly string[]; attempts?: number; attemptDetails?: readonly SemanticAttempt[];
  toolCalls?: readonly SemanticToolCall[]; output?: SemanticOutput; usage?: SemanticUsage;
  events?: readonly SemanticEvent[]; phase?: string; phaseIndex?: number; launch?: number;
};
export type SemanticSnapshot = {
  scope: { publisherId: string; targetKind: "run" | "subagent"; targetId: string; agentId?: string };
  run?: { id: string; workflowName?: string; state: string; retry?: { sourceRunId?: string }; agents?: readonly SemanticAgent[]; summary?: SemanticRunSummary };
  subagent?: { id: string; label?: string; state: string; attempts?: number; attemptDetails?: readonly SemanticAttempt[]; output?: SemanticOutput; progress?: { toolCalls?: readonly SemanticToolCall[] }; usage?: SemanticUsage; events?: readonly SemanticEvent[] };
  relations?: readonly { kind: "dependency" | "fork" | "merge"; fromAgentId: string; toAgentId: string; id?: string; evidence: "recorded" }[];
  partial?: { reasons?: readonly string[]; omittedNodes?: number; omittedEdges?: number };
};

const MAX_SOURCE_RECORDS = 2048;
const MAX_TOOL_CALLS = 512;
const MAX_ID_LENGTH = 128;
const MAX_LABEL_LENGTH = 120;
const MAX_AGENT_EVENTS = 48;
const MAX_PHASE_EDGES = 32;
const EVENT_KINDS = new Set(["system", "user", "assistant", "tool"]);
const encoder = new TextEncoder();
const allowedStates = new Set<SemanticState>(["running", "success", "failure", "queued", "waiting", "paused", "retrying", "cancelled", "interrupted", "unknown"]);

function boundedText(value: unknown, fallback: string, limit = MAX_LABEL_LENGTH): string {
  if (typeof value !== "string") return fallback;
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return clean ? Array.from(clean).slice(0, limit).join("") : fallback;
}
function boundedId(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > MAX_ID_LENGTH) throw new Error(`Invalid semantic map ${label}`);
  return value;
}
function targetKindOf(value: unknown): "run" | "subagent" {
  if (value === "run" || value === "subagent") return value;
  throw new Error("Invalid semantic map target kind");
}
function bytes(value: unknown): number { return encoder.encode(JSON.stringify(value)).byteLength; }
function positiveCount(value: unknown): number { return Number.isSafeInteger(value) && typeof value === "number" && value > 0 ? value : 0; }
function tokenCount(value: unknown): number { return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.min(Math.round(value), Number.MAX_SAFE_INTEGER) : 0; }
function usageOf(value: SemanticUsage | undefined): SemanticUsage | undefined {
  if (!value || typeof value !== "object") return undefined;
  const context = value.context === undefined ? undefined : tokenCount(value.context);
  const cost = typeof value.cost === "number" && Number.isFinite(value.cost) && value.cost >= 0 ? value.cost : undefined;
  return { input: tokenCount(value.input), output: tokenCount(value.output), cacheRead: tokenCount(value.cacheRead), cacheWrite: tokenCount(value.cacheWrite), ...(context === undefined ? {} : { context }), ...(cost === undefined ? {} : { cost }) };
}
function tupleId(parts: readonly (string | number)[]): string {
  const raw = JSON.stringify(parts);
  let hex = "";
  for (const byte of encoder.encode(raw)) hex += byte.toString(16).padStart(2, "0");
  return `sm-${hex}`;
}
function stateOf(rawValue: unknown): { state: SemanticState; rawStatus: string } {
  const rawStatus = boundedText(rawValue, "unknown", 40).toLowerCase();
  const mapped: Record<string, SemanticState> = {
    running: "running", completed: "success", success: "success", failed: "failure", failure: "failure",
    queued: "queued", waiting: "waiting", paused: "paused", retrying: "retrying", stopped: "cancelled",
    cancelled: "cancelled", interrupted: "interrupted", budget_exhausted: "failure", retried: "retrying"
  };
  return { state: mapped[rawStatus] ?? (allowedStates.has(rawStatus as SemanticState) ? rawStatus as SemanticState : "unknown"), rawStatus };
}
function addReason(reasons: Set<string>, reason: string): void { reasons.add(reason); }
const CAUSAL_KINDS: ReadonlySet<SemanticRelationKind> = new Set(["dependency", "fork", "merge", "retry"]);
/** Reachability over the causal adjacency index (dependency/fork/merge/retry edges only). */
function hasPath(from: string, to: string, causalOut: ReadonlyMap<string, readonly string[]>): boolean {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length) {
    const current = queue.pop();
    if (current === to) return true;
    if (!current || seen.has(current)) continue;
    seen.add(current);
    for (const next of causalOut.get(current) ?? []) queue.push(next);
  }
  return false;
}

/** Builds a privacy-whitelisted, deterministic, bounded graph from Trajectory metadata only. */
export function adaptSemanticSnapshot(input: SemanticSnapshot): SemanticGraph {
  const inputScope: unknown = (input as unknown as { scope?: unknown }).scope;
  if (!inputScope || typeof inputScope !== "object") throw new Error("Invalid semantic map scope");
  const rawScope = inputScope as { publisherId?: unknown; targetKind?: unknown; targetId?: unknown; agentId?: unknown };
  const scope = {
    publisherId: boundedId(rawScope.publisherId, "publisher id"),
    targetKind: targetKindOf(rawScope.targetKind),
    targetId: boundedId(rawScope.targetId, "target id"),
    ...(rawScope.agentId === undefined ? {} : { agentId: boundedId(rawScope.agentId, "agent id") })
  };
  const reasonInput = input.partial?.reasons ?? [];
  const reasons = new Set<string>(reasonInput.slice(0, 32).map((item) => boundedText(item, "partial source", 100)).filter(Boolean));
  reasons.add("Causality is limited to explicitly recorded metadata");
  if (reasonInput.length > 32) reasons.add("Publisher completeness reasons bounded");
  let omittedSourceNodes = 0;
  let omittedSourceEdges = 0;
  const projectCalls = (calls: readonly SemanticToolCall[] = []) => {
    const sorted = calls.slice(0, MAX_SOURCE_RECORDS).map((call) => ({ id: boundedId(call.id, "tool call id"), name: boundedText(call.name, "Tool call"), state: boundedText(call.state, "unknown", 40) }))
      .sort((a, b) => a.id.localeCompare(b.id) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const unique = sorted.filter((call, index) => index === 0 || sorted[index - 1]?.id !== call.id);
    const retained = unique.slice(0, MAX_TOOL_CALLS);
    return { calls: retained, omitted: Math.max(0, calls.length - retained.length) };
  };
  const projectEvents = (events: readonly SemanticEvent[] | undefined): SemanticEvent[] | undefined => {
    if (!events) return undefined;
    const valid = events.slice(0, MAX_SOURCE_RECORDS).filter((event) => EVENT_KINDS.has(event.kind) && (event.kind !== "tool" || typeof event.id === "string"));
    // The opening system/user turns and the most recent turns are kept; the middle of very long transcripts is omitted.
    const kept = valid.length > MAX_AGENT_EVENTS ? [...valid.slice(0, 2), ...valid.slice(-(MAX_AGENT_EVENTS - 2))] : valid;
    if (kept.length < events.length) { omittedSourceNodes += events.length - kept.length; addReason(reasons, "Transcript events bounded"); }
    return kept.map((event) => {
      const count = event.kind === "tool" ? Math.min(positiveCount(event.count), 100_000) : 0;
      const failed = Math.min(positiveCount(event.failed), count);
      return { kind: event.kind, ...(event.kind === "tool" ? { id: boundedId(event.id, "tool call id") } : {}), name: boundedText(event.name, event.kind === "tool" ? "Tool call" : event.kind), state: boundedText(event.state, "completed", 40), ...(count > 1 ? { count, ...(failed ? { failed } : {}) } : {}) };
    });
  };
  const rawAgents = input.run?.agents ?? [];
  const projected = rawAgents.slice(0, MAX_SOURCE_RECORDS).map((agent) => {
    const tools = projectCalls(agent.toolCalls ?? []);
    const rawAttempts = agent.attemptDetails ?? [];
    if (rawAttempts.length > 32) { omittedSourceNodes += rawAttempts.length - 32; addReason(reasons, "Attempt history bounded"); }
    const rawPath = agent.structuralPath ?? [];
    if (rawPath.length > 16) { omittedSourceNodes += rawPath.length - 16; addReason(reasons, "Structural path bounded"); }
    const attempts = rawAttempts.slice(0, 32).map((attempt) => ({ attempt: attempt.attempt, failed: Boolean(attempt.error) }))
      .filter((attempt) => Number.isSafeInteger(attempt.attempt) && attempt.attempt > 0)
      .sort((a, b) => a.attempt - b.attempt || Number(a.failed) - Number(b.failed));
    return {
      id: boundedId(agent.id, "agent id"), name: boundedText(agent.label ?? agent.name, "Agent"), state: boundedText(agent.state, "unknown", 40),
      ...(agent.parentId === undefined ? {} : { parentId: boundedId(agent.parentId, "parent id") }),
      path: rawPath.slice(0, 16).map((part) => boundedText(part, "task", 80)),
      attempts: Number.isSafeInteger(agent.attempts) && (agent.attempts ?? 0) > 0 ? agent.attempts as number : 0,
      attemptsSeen: attempts.filter((attempt, index) => index === 0 || attempts[index - 1]?.attempt !== attempt.attempt),
      output: agent.output ? boundedText(agent.output.status, "unknown", 40) : "missing",
      tools: tools.calls, toolsOmitted: tools.omitted, usage: usageOf(agent.usage), events: projectEvents(agent.events),
      ...(Number.isSafeInteger(agent.phaseIndex) && (agent.phaseIndex ?? -1) >= 0 ? { phaseIndex: agent.phaseIndex as number, phase: boundedText(agent.phase, "phase", 80) } : {}),
      ...(Number.isSafeInteger(agent.launch) && (agent.launch ?? -1) >= 0 ? { launch: agent.launch as number } : {})
    };
  }).sort((a, b) => a.id.localeCompare(b.id) || JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const agents: typeof projected = [];
  for (const candidate of projected) {
    if (agents.at(-1)?.id === candidate.id) { omittedSourceNodes += 1; addReason(reasons, "Duplicate source agent identity omitted"); }
    else agents.push(candidate);
    omittedSourceNodes += candidate.toolsOmitted;
    if (candidate.toolsOmitted) addReason(reasons, "Source tool-call list bounded");
  }
  if (rawAgents.length > projected.length) { omittedSourceNodes += rawAgents.length - projected.length; addReason(reasons, "Source agent list truncated"); }
  const rawStandalone = input.subagent;
  const standaloneTools = projectCalls(rawStandalone?.progress?.toolCalls ?? []);
  if (standaloneTools.omitted) { omittedSourceNodes += standaloneTools.omitted; addReason(reasons, "Source tool-call list bounded"); }
  const rawStandaloneAttempts = rawStandalone?.attemptDetails ?? [];
  if (rawStandaloneAttempts.length > 32) { omittedSourceNodes += rawStandaloneAttempts.length - 32; addReason(reasons, "Attempt history bounded"); }
  const standaloneAttempts = rawStandaloneAttempts.slice(0, 32).map((attempt) => ({ attempt: attempt.attempt, failed: Boolean(attempt.error) }))
    .filter((attempt) => Number.isSafeInteger(attempt.attempt) && attempt.attempt > 0)
    .sort((a, b) => a.attempt - b.attempt || Number(a.failed) - Number(b.failed));
  let safeSnapshot = {
    scope,
    run: input.run ? { id: boundedId(input.run.id, "run id"), state: boundedText(input.run.state, "unknown", 40), agents } : undefined,
    subagent: rawStandalone ? {
      id: boundedId(rawStandalone.id, "subagent id"), label: boundedText(rawStandalone.label, "Subagent"), state: boundedText(rawStandalone.state, "unknown", 40),
      attempts: Number.isSafeInteger(rawStandalone.attempts) && (rawStandalone.attempts ?? 0) > 0 ? rawStandalone.attempts as number : 0,
      attemptsSeen: standaloneAttempts.filter((attempt, index) => index === 0 || standaloneAttempts[index - 1]?.attempt !== attempt.attempt),
      output: boundedText(rawStandalone.output?.status, "missing", 40), tools: standaloneTools.calls, events: projectEvents(rawStandalone.events)
    } : undefined
  };
  while (bytes(safeSnapshot) > SEMANTIC_MAP_LIMITS.payloadBytes && (agents.length || (safeSnapshot.subagent?.tools.length ?? 0) > 0)) {
    if (agents.length) { agents.pop(); omittedSourceNodes += 1; safeSnapshot = { ...safeSnapshot, run: safeSnapshot.run ? { ...safeSnapshot.run, agents } : undefined }; }
    else if (safeSnapshot.subagent) {
      const tools = safeSnapshot.subagent.tools.slice(0, -1);
      omittedSourceNodes += 1;
      safeSnapshot = { ...safeSnapshot, subagent: { ...safeSnapshot.subagent, tools } };
    }
    addReason(reasons, "Source metadata exceeds the bridge payload limit");
  }
  if (bytes(safeSnapshot) > SEMANTIC_MAP_LIMITS.payloadBytes) throw new Error("Semantic map scope exceeds the 512 KiB bridge payload limit");

  const nodes: SemanticNode[] = [];
  const edges: SemanticEdge[] = [];
  // Indexes over `edges` (append-only while building): duplicate keys and causal adjacency for cycle checks.
  const edgeKeys = new Set<string>();
  const causalOut = new Map<string, string[]>();
  const nodeByKey = new Map<string, string>();
  const sourcePrefix = [scope.publisherId, scope.targetKind, scope.targetId, scope.agentId ?? ""] as const;
  const node = (kind: SemanticNodeKind, key: readonly (string | number)[], label: string, raw: string, evidence: SemanticNode["evidence"], sourceRef: string, agentId?: string, extra: Partial<Pick<SemanticNode, "order" | "attempts" | "failedAttempts" | "stage" | "stageLabel" | "phaseNumber" | "launch" | "count" | "failedCount">> = {}): string => {
    const id = tupleId([...sourcePrefix, kind, ...key]);
    const mapKey = JSON.stringify([kind, ...key]);
    if (!nodeByKey.has(mapKey)) {
      const status = stateOf(raw);
      nodes.push({ id, kind, label: boundedText(label, kind), ...status, evidence, sourceRef: boundedText(sourceRef, "unavailable", 256), ...(agentId === undefined ? {} : { agentId }), ...extra });
      nodeByKey.set(mapKey, id);
    }
    return id;
  };
  const edge = (kind: SemanticRelationKind, from: string, to: string, relationKey: readonly (string | number)[], evidence: SemanticEdge["evidence"]): void => {
    const key = `${kind}\u0000${from}\u0000${to}`;
    if (from === to || edgeKeys.has(key)) return;
    const causal = CAUSAL_KINDS.has(kind);
    if (causal && hasPath(to, from, causalOut)) { addReason(reasons, "Cyclic causal relation omitted"); omittedSourceEdges += 1; return; }
    edgeKeys.add(key);
    if (causal) { const out = causalOut.get(from); if (out) out.push(to); else causalOut.set(from, [to]); }
    edges.push({ id: tupleId([...sourcePrefix, "edge", kind, ...relationKey, from, to]), from, to, kind, evidence });
  };
  const rootId = scope.targetKind === "run"
    ? node("workflow", [input.run?.id ?? scope.targetId], input.run?.workflowName ?? "Workflow", input.run?.state ?? "unknown", "recorded", input.run?.id ?? scope.targetId)
    : node("workflow", [input.subagent?.id ?? scope.targetId], "Standalone subagent", input.subagent?.state ?? "unknown", "structural", input.subagent?.id ?? scope.targetId);
  const agentBySource = new Map<string, { agent: typeof agents[number]; id: string }>();

  const attemptFields = (attempts: number, seen: readonly { attempt: number; failed: boolean }[]): Partial<Pick<SemanticNode, "attempts" | "failedAttempts">> => {
    const total = Math.max(attempts, ...seen.map((item) => item.attempt), 1);
    const failed = seen.filter((item) => item.failed).length;
    return { ...(total > 1 ? { attempts: total } : {}), ...(failed ? { failedAttempts: failed } : {}) };
  };
  /*
   * Execution waves from recorded metadata only: with launch order, consecutive launches inside the same parallel scope
   * (first structural path segment) of the same phase form one parallel wave, and every top-level call is a wave of its
   * own, so sequential agents follow each other. Without launch order, waves fall back to recorded phases.
   */
  const waveOf = new Map<string, number>();
  const waves: string[][] = [];
  const withLaunch = agents.length > 0 && agents.every((agent) => agent.launch !== undefined);
  if (withLaunch) {
    let previousKey: string | undefined;
    for (const agent of [...agents].filter((item) => !item.parentId).sort((a, b) => (a.launch ?? 0) - (b.launch ?? 0) || a.id.localeCompare(b.id))) {
      const scope = agent.path[0];
      const key = scope === undefined ? undefined : JSON.stringify([agent.phaseIndex ?? -1, scope]);
      if (key === undefined || key !== previousKey) waves.push([]);
      waves[waves.length - 1]?.push(agent.id); waveOf.set(agent.id, waves.length - 1);
      previousKey = key;
    }
  } else {
    const phases = [...new Set(agents.flatMap((agent) => agent.phaseIndex === undefined || agent.parentId ? [] : [agent.phaseIndex]))].sort((a, b) => a - b);
    for (const phase of phases) { waves.push(agents.filter((agent) => agent.phaseIndex === phase && !agent.parentId).map((agent) => agent.id).sort()); for (const id of waves[waves.length - 1] ?? []) waveOf.set(id, waves.length - 1); }
  }
  for (const agent of agents) {
    const wave = waveOf.get(agent.id);
    const id = node("agent", [agent.id], agent.name, agent.state, "recorded", agent.id, agent.id, {
      ...attemptFields(agent.attempts, agent.attemptsSeen),
      ...(wave === undefined ? agent.phaseIndex === undefined ? {} : { stage: agent.phaseIndex } : { stage: wave }),
      ...(agent.phaseIndex === undefined ? {} : { phaseNumber: agent.phaseIndex, ...(agent.phase === undefined ? {} : { stageLabel: agent.phase }) }),
      ...(agent.launch === undefined ? {} : { launch: agent.launch })
    });
    agentBySource.set(agent.id, { agent, id });
  }
  /** Agent card → transcript events in recorded order → result; without a transcript, agent → tool calls and result. */
  const agentFlow = (ownerId: string, owner: string, attempts: number, events: readonly SemanticEvent[] | undefined, tools: readonly { id: string; name: string; state: string }[], resultId: string): void => {
    if (events?.length) {
      let previous = ownerId; let previousKind = "agent";
      const ordinals = new Map<string, number>();
      events.forEach((event, index) => {
        const ordinal = ordinals.get(event.kind) ?? 0; ordinals.set(event.kind, ordinal + 1);
        const callKey = event.id ?? String(index);
        const current = event.kind === "tool"
          ? node("tool-call", [owner, attempts || 1, callKey], event.name ?? "Tool call", event.state ?? "completed", "recorded", `${owner}/${callKey}`, owner, { order: index + 1, ...(event.count ? { count: event.count } : {}), ...(event.failed ? { failedCount: event.failed } : {}) })
          : node(event.kind, [owner, "event", index], event.name ?? event.kind, event.state ?? "completed", "recorded", `${owner}#${event.kind}#${String(ordinal)}`, owner, { order: index + 1 });
        edge(event.kind === "tool" && previousKind === "assistant" ? "invokes" : "sequence", previous, current, [owner, "flow", index], "recorded");
        previous = current; previousKind = event.kind;
      });
      edge("produces", previous, resultId, [owner, "result"], "recorded");
      return;
    }
    edge("produces", ownerId, resultId, [owner, "result"], "recorded");
    tools.forEach((call, index) => {
      const callId = node("tool-call", [owner, attempts || 1, call.id], call.name, call.state, "recorded", `${owner}/${call.id}`, owner, { order: index + 1 });
      edge("invokes", ownerId, callId, [owner, call.id], "recorded");
    });
  };
  const parentWouldCycle = (childId: string, parentId: string): boolean => {
    const seen = new Set<string>([childId]);
    let current: string | undefined = parentId;
    while (current) {
      if (seen.has(current)) return true;
      seen.add(current);
      current = agentBySource.get(current)?.agent.parentId;
    }
    return false;
  };
  const taskStates = new Map<string, SemanticState[]>();
  for (const { agent, id } of agentBySource.values()) {
    let parent = rootId;
    let pathKey: string[] = [];
    const agentState = stateOf(agent.state).state;
    for (const segment of agent.path) {
      pathKey = [...pathKey, segment];
      const taskId = node("task", pathKey, segment, "unknown", "structural", agent.id);
      const contained = taskStates.get(taskId); if (contained) contained.push(agentState); else taskStates.set(taskId, [agentState]);
      edge("contains", parent, taskId, ["task", ...pathKey], "structural");
      parent = taskId;
    }
    if (agent.parentId) {
      const parentAgent = agentBySource.get(agent.parentId);
      if (!parentAgent) addReason(reasons, "Agent parent missing");
      else if (parentWouldCycle(agent.id, agent.parentId)) addReason(reasons, "Cyclic agent parent omitted");
      else edge("contains", parentAgent.id, id, ["parent", agent.parentId, agent.id], "recorded");
    } else edge("contains", parent, id, ["agent", agent.id], agent.path.length ? "structural" : "recorded");

    if (agent.attempts > agent.attemptsSeen.length && agent.attempts > 1) addReason(reasons, "Attempt history partial");
    const resultStatus = agent.output === "missing" ? "unavailable" : agent.output;
    const resultState = resultStatus === "failed" ? "failed" : resultStatus === "cancelled" ? "cancelled" : resultStatus === "pending" ? "running" : resultStatus === "available" ? "completed" : "unknown";
    const resultId = node("result", [agent.id, "output"], resultStatus === "missing" ? "Result unavailable" : `Result ${resultStatus}`, resultState, resultStatus === "missing" ? "unavailable" : "recorded", agent.id, agent.id, { order: 100_000 });
    agentFlow(id, agent.id, agent.attempts, agent.events, agent.tools, resultId);
  }
  // Hand-over between consecutive waves: every agent of one wave to every agent of the next (fan-out / fan-in).
  let phaseEdges = 0;
  for (let index = 1; index < waves.length; index += 1) {
    const before = waves[index - 1] ?? []; const after = waves[index] ?? [];
    for (const from of [...before].sort()) for (const to of [...after].sort()) {
      const resultId = nodeByKey.get(JSON.stringify(["result", from, "output"])); const target = agentBySource.get(to)?.id;
      if (!resultId || !target) continue;
      if (phaseEdges >= MAX_PHASE_EDGES) { omittedSourceEdges += 1; addReason(reasons, "Phase hand-over edges bounded"); continue; }
      edge("phase", resultId, target, [from, to], "structural"); phaseEdges += 1;
    }
  }
  // Workflow scopes (parallel/phase tasks) have no recorded status; derive it from the agents they contain.
  if (taskStates.size) for (const item of nodes) {
    const contained = item.kind === "task" ? taskStates.get(item.id) : undefined;
    if (!contained) continue;
    const has = (...states: SemanticState[]): boolean => contained.some((state) => states.includes(state));
    const rawStatus = has("running", "retrying") ? "running" : has("failure", "interrupted") ? "failed" : contained.every((state) => state === "success") ? "completed" : has("queued", "waiting", "paused") ? "queued" : has("cancelled") ? "cancelled" : "mixed";
    item.rawStatus = rawStatus; item.state = stateOf(rawStatus).state;
  }
  const standalone = safeSnapshot.subagent;
  if (standalone && scope.targetKind === "subagent") {
    const id = node("agent", [standalone.id], standalone.label, standalone.state, "recorded", standalone.id, standalone.id, attemptFields(standalone.attempts, standalone.attemptsSeen));
    edge("contains", rootId, id, ["subagent", standalone.id], "structural");
    const resultStatus = standalone.output;
    const resultState = resultStatus === "failed" ? "failed" : resultStatus === "cancelled" ? "cancelled" : resultStatus === "pending" ? "running" : resultStatus === "available" ? "completed" : "unknown";
    const resultId = node("result", [standalone.id, "output"], resultStatus === "missing" ? "Result unavailable" : `Result ${resultStatus}`, resultState, resultStatus === "missing" ? "unavailable" : "recorded", standalone.id, standalone.id, { order: 100_000 });
    if (standalone.attempts > standalone.attemptsSeen.length && standalone.attempts > 1) addReason(reasons, "Attempt history partial");
    agentFlow(id, standalone.id, standalone.attempts, standalone.events, standalone.tools, resultId);
  }
  const runId = input.run?.id ?? scope.targetId;
  const sourceRunId = input.run?.retry?.sourceRunId;
  if (sourceRunId) {
    const previousId = node("workflow", [boundedId(sourceRunId, "retry source id")], "Previous run", "unknown", "recorded", sourceRunId);
    edge("retry", previousId, rootId, [sourceRunId, runId], "recorded");
  }
  const relationInput = input.relations ?? [];
  const relationRecords = relationInput.slice(0, MAX_SOURCE_RECORDS).flatMap((relation) => {
    if (!["dependency", "fork", "merge"].includes(relation.kind)) { omittedSourceEdges += 1; return []; }
    return [{ kind: relation.kind, fromAgentId: boundedId(relation.fromAgentId, "relation source id"), toAgentId: boundedId(relation.toAgentId, "relation target id"), id: relation.id === undefined ? undefined : boundedId(relation.id, "relation id") }];
  }).sort((a, b) => a.kind.localeCompare(b.kind) || a.fromAgentId.localeCompare(b.fromAgentId) || a.toAgentId.localeCompare(b.toAgentId) || (a.id ?? "").localeCompare(b.id ?? ""));
  if (relationInput.length > MAX_SOURCE_RECORDS) { omittedSourceEdges += relationInput.length - MAX_SOURCE_RECORDS; addReason(reasons, "Recorded relations bounded"); }
  if (relationRecords.length < Math.min(relationInput.length, MAX_SOURCE_RECORDS)) addReason(reasons, "Recorded relations invalid");
  for (const relation of relationRecords) {
    const from = agentBySource.get(relation.fromAgentId)?.id;
    const to = agentBySource.get(relation.toAgentId)?.id;
    if (!from || !to) { addReason(reasons, "Recorded relation endpoint missing"); omittedSourceEdges += 1; continue; }
    edge(relation.kind, from, to, [relation.id ?? relation.fromAgentId, relation.toAgentId], "recorded");
  }
  const publisherOmittedNodes = positiveCount(input.partial?.omittedNodes);
  const publisherOmittedEdges = positiveCount(input.partial?.omittedEdges);
  if (publisherOmittedNodes) { omittedSourceNodes += publisherOmittedNodes; addReason(reasons, "Publisher omitted nodes"); }
  if (publisherOmittedEdges) { omittedSourceEdges += publisherOmittedEdges; addReason(reasons, "Publisher omitted edges"); }
  nodes.sort((a, b) => a.id.localeCompare(b.id));
  edges.sort((a, b) => a.id.localeCompare(b.id));
  const omittedNodes = Math.max(0, nodes.length - SEMANTIC_MAP_LIMITS.nodes);
  const omittedEdges = Math.max(0, edges.length - SEMANTIC_MAP_LIMITS.edges);
  const rootNode = nodes.find((item) => item.id === rootId);
  const visibleNodes = [rootNode, ...nodes.filter((item) => item.id !== rootId).slice(0, SEMANTIC_MAP_LIMITS.nodes - 1)].filter((item): item is SemanticNode => item !== undefined);
  const visibleIds = new Set(visibleNodes.map((item) => item.id));
  const visibleEdges = edges.filter((item) => visibleIds.has(item.from) && visibleIds.has(item.to)).slice(0, SEMANTIC_MAP_LIMITS.edges);
  const edgeOmission = Math.max(omittedEdges, edges.length - visibleEdges.length);
  if (omittedNodes || edgeOmission || omittedSourceNodes || omittedSourceEdges) addReason(reasons, "Graph data omitted by bounds or validation");
  const graph: SemanticGraph = {
    schemaVersion: 1, scope, nodes: visibleNodes, edges: visibleEdges,
    completeness: { partial: reasons.size > 0, reasons: [...reasons].sort(), omittedNodes: omittedNodes + omittedSourceNodes, omittedEdges: edgeOmission + omittedSourceEdges }
  };
  const usageEntries = scope.targetKind === "run"
    ? agents.flatMap((agent) => agent.usage ? [{ agentId: agent.id, usage: agent.usage }] : [])
    : safeSnapshot.subagent && rawStandalone?.usage ? [{ agentId: safeSnapshot.subagent.id, usage: usageOf(rawStandalone.usage) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] : [];
  if (usageEntries.length) {
    const total: SemanticUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const { usage } of usageEntries) { total.input += usage.input; total.output += usage.output; total.cacheRead += usage.cacheRead; total.cacheWrite += usage.cacheWrite; if (usage.cost !== undefined) total.cost = (total.cost ?? 0) + usage.cost; }
    graph.usage = { total, agents: usageEntries };
  }
  const summary = input.run?.summary;
  if (summary && scope.targetKind === "run") {
    const pages = Math.max(1, positiveCount(summary.pages));
    graph.summary = {
      agents: positiveCount(summary.agents), running: positiveCount(summary.running), completed: positiveCount(summary.completed), failed: positiveCount(summary.failed),
      toolCalls: positiveCount(summary.toolCalls), ...(summary.toolCallsPartial === true ? { toolCallsPartial: true } : {}), retries: positiveCount(summary.retries), page: Math.min(positiveCount(summary.page), pages - 1), pages,
      ...(summary.usage ? { usage: usageOf(summary.usage) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } : {})
    };
  }
  if (bytes(graph) > SEMANTIC_MAP_LIMITS.payloadBytes) {
    const initialEdges = graph.edges.length;
    addReason(reasons, "Rendered graph exceeds bridge payload limit");
    graph.completeness.partial = true;
    graph.completeness.reasons = [...reasons].sort();
    // Keep the longest node prefix (and the edges inside it) that fits. Serialized size only grows with the prefix, so a
    // binary search gives the same result as dropping trailing nodes one at a time, without one serialization per node.
    const allNodes = graph.nodes, allEdges = graph.edges, baseOmittedNodes = graph.completeness.omittedNodes;
    const prefix = (count: number): SemanticGraph => {
      const kept = new Set(allNodes.slice(0, count).map((item) => item.id));
      return { ...graph, nodes: allNodes.slice(0, count), edges: allEdges.filter((item) => kept.has(item.from) && kept.has(item.to)), completeness: { ...graph.completeness, omittedNodes: baseOmittedNodes + allNodes.length - count } };
    };
    let best = 0;
    for (let low = 0, high = allNodes.length - 1; low <= high;) {
      const middle = Math.floor((low + high) / 2);
      if (bytes(prefix(middle)) <= SEMANTIC_MAP_LIMITS.payloadBytes) { best = middle; low = middle + 1; } else high = middle - 1;
    }
    const fitted = prefix(best);
    graph.nodes = fitted.nodes;
    graph.edges = fitted.edges;
    graph.completeness.omittedNodes = fitted.completeness.omittedNodes;
    graph.completeness.omittedEdges += initialEdges - graph.edges.length;
  }
  return graph;
}
