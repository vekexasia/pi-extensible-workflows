import type { SemanticAgent, SemanticEvent, SemanticRunSummary, SemanticSnapshot, SemanticUsage } from "./adapter.js";
import { SemanticMapBridge, type ParentSemanticNode } from "./bridge.js";

const MAX_CACHED_CALLS = 32;
const MAX_SOURCE_AGENTS = 16;
const MAX_SOURCE_RELATIONS = 8;
const MAX_STRUCTURAL_PATH = 8;
const MAX_RUN_TOOL_CALLS = 16;
const MAX_SNAPSHOT_BYTES = 384 * 1024;
const MAX_AGENT_EVENTS = 48;
const MAX_RUN_EVENTS = 320;
/** Agents per map page: the projection and viewer bounds stay the same however many agents a run has. */
export const MAP_PAGE_AGENTS = 16;
const MAX_SUMMARY_AGENTS = 4096;
/** Tool-call IDs behind each grouped tool card (`agent/firstCallId` → all call IDs), from the latest projection only. */
const groupedCalls = new Map<string, readonly string[]>();
const encoder = new TextEncoder();
declare const __SEMANTIC_MAP_BUILD_STAMP__: string;
type SemanticProjection = { snapshot: SemanticSnapshot; identity: string; nodes: ReadonlyMap<string, ParentSemanticNode>; nodeCount: number; page: number; pages: number; totalAgents: number };
type TargetKind = "run" | "subagent";
type Target = { kind: TargetKind; publisherId: string; id: string };
type FoundTarget = { publisher: Record<string, unknown>; record: Record<string, unknown>; target: Target };
type AppState = { transcripts: Record<string, unknown> };
type AppContext = {
  state: AppState;
  selected: () => FoundTarget | undefined;
  setView: (view: string) => void;
  inspect?: (selection: { agentId: string; kind: ParentSemanticNode["kind"]; callId?: string; callIds?: readonly string[]; ordinal?: number } | null) => void;
  /** Requests the existing transcript RPC for an agent (run) or the selected subagent (no id); content stays in the parent. */
  requestTranscript?: (agentId?: string) => void;
  staticExport: boolean;
};
type UiWindow = Window & { __PIEWF_SEMANTIC_MAP_CONTEXT__?: AppContext; __PIEWF_SEMANTIC_MAP_REFRESH__?: () => void; __PIEWF_SEMANTIC_MAP_VISIBILITY__?: (visible: boolean) => void; __PIEWF_SEMANTIC_MAP_THEME__?: () => void };

function asRecord(value: unknown): Record<string, unknown> | undefined { return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function safeText(value: unknown, max = 128): string | undefined { return typeof value === "string" && value.length > 0 && value.length <= max ? value : undefined; }
function safeArray(value: unknown, max: number): unknown[] { return Array.isArray(value) ? value.slice(0, max) : []; }
function safeOutput(value: unknown): { status: string } | undefined {
  const status = asRecord(value)?.status;
  return typeof status === "string" && status.length <= 40 ? { status } : undefined;
}
function tupleNodeId(scope: SemanticSnapshot["scope"], kind: ParentSemanticNode["kind"], key: readonly (string | number)[]): string {
  const parts = [scope.publisherId, scope.targetKind, scope.targetId, scope.agentId ?? "", kind, ...key];
  return `sm-${Array.from(encoder.encode(JSON.stringify(parts)), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
function normalizedPath(value: string): string {
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return clean ? Array.from(clean).slice(0, 80).join("") : "task";
}
function boundedSnapshot(input: SemanticSnapshot): SemanticSnapshot {
  let snapshot = input;
  const reasons = new Set(input.partial?.reasons ?? []);
  let omittedNodes = 0;
  let omittedEdges = 0;
  const updateReasons = (): void => {
    snapshot = { ...snapshot, partial: {
      ...snapshot.partial, reasons: [...reasons],
      omittedNodes: (input.partial?.omittedNodes ?? 0) + omittedNodes,
      omittedEdges: (input.partial?.omittedEdges ?? 0) + omittedEdges
    } };
  };
  while (encoder.encode(JSON.stringify(snapshot)).byteLength > MAX_SNAPSHOT_BYTES) {
    const run = snapshot.run;
    if (snapshot.relations?.length) {
      reasons.add("Recorded relations bounded to the bridge payload limit");
      omittedEdges += 1;
      snapshot = { ...snapshot, relations: snapshot.relations.slice(0, -1) };
    } else if (run?.agents?.length) {
      reasons.add("Source agents bounded to the bridge payload limit");
      omittedNodes += 1;
      snapshot = { ...snapshot, run: { ...run, agents: run.agents.slice(0, -1) } };
    } else if (snapshot.subagent?.progress?.toolCalls?.length) {
      reasons.add("Subagent tool calls bounded to the bridge payload limit");
      omittedNodes += 1;
      snapshot = { ...snapshot, subagent: { ...snapshot.subagent, progress: { toolCalls: snapshot.subagent.progress.toolCalls.slice(0, -1) } } };
    } else throw new Error("Semantic Map scope exceeds the 512 KiB bridge payload limit");
    updateReasons();
  }
  return snapshot;
}
function indexSemanticNodes(snapshot: SemanticSnapshot): { nodes: ReadonlyMap<string, ParentSemanticNode>; nodeCount: number } {
  const scope = snapshot.scope;
  const candidates = new Map<string, ParentSemanticNode>();
  const keys = new Set<string>();
  const add = (kind: ParentSemanticNode["kind"], key: readonly (string | number)[], sourceRef: string): string => {
    const id = tupleNodeId(scope, kind, key);
    const identity = JSON.stringify([kind, ...key]);
    if (!keys.has(identity)) {
      keys.add(identity);
      const cleanSourceRef = sourceRef.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
      candidates.set(id, { id, kind, sourceRef: Array.from(cleanSourceRef || "unavailable").slice(0, 256).join("") });
    }
    return id;
  };
  const addFlow = (owner: string, attempts: number, events: readonly SemanticEvent[] | undefined, calls: readonly { id: string }[] | undefined): void => {
    if (events?.length) {
      const ordinals = new Map<string, number>();
      events.forEach((event, index) => {
        const ordinal = ordinals.get(event.kind) ?? 0; ordinals.set(event.kind, ordinal + 1);
        if (event.kind === "tool") add("tool-call", [owner, attempts || 1, event.id ?? String(index)], `${owner}/${event.id ?? String(index)}`);
        else add(event.kind, [owner, "event", index], `${owner}#${event.kind}#${String(ordinal)}`);
      });
    } else for (const call of calls ?? []) add("tool-call", [owner, attempts || 1, call.id], `${owner}/${call.id}`);
  };
  const rootId = add("workflow", [scope.targetId], scope.targetId);
  if (snapshot.run) {
    const sortedAgents = [...(snapshot.run.agents ?? [])].sort((left, right) => left.id.localeCompare(right.id) || JSON.stringify(left).localeCompare(JSON.stringify(right)));
    const seenAgents = new Set<string>();
    for (const agent of sortedAgents) {
      if (seenAgents.has(agent.id)) continue;
      seenAgents.add(agent.id);
      add("agent", [agent.id], agent.id);
      let path: string[] = [];
      for (const part of agent.structuralPath ?? []) { path = [...path, normalizedPath(part)]; add("task", path, agent.id); }
      add("result", [agent.id, "output"], agent.id);
      addFlow(agent.id, agent.attempts || 1, agent.events, agent.toolCalls);
    }
    if (snapshot.run.retry?.sourceRunId) add("workflow", [snapshot.run.retry.sourceRunId], snapshot.run.retry.sourceRunId);
  } else if (snapshot.subagent) {
    const agent = snapshot.subagent;
    add("agent", [agent.id], agent.id);
    add("result", [agent.id, "output"], agent.id);
    addFlow(agent.id, agent.attempts ?? 0, agent.events, agent.progress?.toolCalls);
  }
  const visibleIds = [rootId, ...[...candidates.keys()].filter((id) => id !== rootId).sort().slice(0, 499)];
  return { nodes: new Map(visibleIds.flatMap((id) => candidates.has(id) ? [[id, candidates.get(id) as ParentSemanticNode] as const] : [])), nodeCount: visibleIds.length };
}

/**
 * Event kinds and tool names/states from a transcript the parent already cached (kinds only: no text, prompts,
 * arguments or results). Returns undefined while no transcript is cached, so the map falls back to recorded calls.
 */
type RawEvent = SemanticEvent & { toolOnly?: boolean };
/**
 * Consecutive calls to the same tool become one stacked card. Calls issued together, or separated only by assistant
 * turns that contain nothing but the next call to that tool, are folded; any text from the model breaks the group.
 */
function groupRepeatedCalls(owner: string, events: readonly RawEvent[]): SemanticEvent[] {
  const out: SemanticEvent[] = [];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index] as RawEvent;
    if (event.kind !== "tool" || !event.id) { const { toolOnly: _toolOnly, ...plain } = event; void _toolOnly; out.push(plain); continue; }
    const calls = [event];
    let next = index + 1;
    for (;;) {
      const following = events[next]; const afterAssistant = events[next + 1];
      if (following?.kind === "tool" && following.name === event.name && following.id) { calls.push(following); next += 1; continue; }
      if (following?.kind === "assistant" && following.toolOnly === true && afterAssistant?.kind === "tool" && afterAssistant.name === event.name && afterAssistant.id) { calls.push(afterAssistant); next += 2; continue; }
      break;
    }
    index = next - 1;
    if (calls.length === 1) { out.push({ kind: "tool", id: event.id, ...(event.name ? { name: event.name } : {}), ...(event.state ? { state: event.state } : {}) }); continue; }
    const failed = calls.filter((call) => call.state === "failed").length;
    const state = calls.some((call) => call.state === "running") ? "running" : calls.at(-1)?.state ?? "completed";
    groupedCalls.set(`${owner}/${event.id}`, calls.flatMap((call) => call.id ? [call.id] : []));
    out.push({ kind: "tool", id: event.id, ...(event.name ? { name: event.name } : {}), state, count: calls.length, ...(failed ? { failed } : {}) });
  }
  return out;
}
function cachedEvents(entries: unknown, hasSystemPrompt: boolean, running: boolean, owner = ""): SemanticEvent[] | undefined {
  if (!Array.isArray(entries)) return undefined;
  const window = entries.slice(-4096);
  const results = new Map<string, boolean>();
  for (const rawEntry of window) {
    const entry = asRecord(rawEntry); const message = asRecord(entry?.message) ?? entry;
    const callId = safeText(message?.toolCallId, 128);
    if (entry && callId && (entry.type === "tool_result" || message?.role === "toolResult")) results.set(callId, message?.isError === true || entry.isError === true);
  }
  const events: RawEvent[] = hasSystemPrompt ? [{ kind: "system", name: "System prompt", state: "completed" }] : [];
  const seenCalls = new Set<string>();
  let users = 0;
  for (const rawEntry of window) {
    const entry = asRecord(rawEntry);
    if (!entry) continue;
    if ((entry.type === "system_prompt" || entry.type === "session") && !events.some((event) => event.kind === "system")) { events.unshift({ kind: "system", name: "System prompt", state: "completed" }); continue; }
    const message = asRecord(entry.message);
    if (entry.type !== "message" || !message) continue;
    if (message.role === "user") { events.push({ kind: "user", name: users === 0 ? "Prompt" : "User message", state: "completed" }); users += 1; continue; }
    if (message.role !== "assistant") continue;
    const parts = Array.isArray(message.content) ? message.content.map(asRecord) : [];
    const usage = asRecord(message.usage);
    // Host-synthesized closing turns (no content, zero usage, e.g. after workflow_result) are not model turns.
    if (!parts.some((part) => (part?.type === "text" && typeof part.text === "string" && part.text.trim()) || part?.type === "toolCall" || part?.type === "thinking") && numberOf(usage?.input) + numberOf(usage?.output) === 0) continue;
    const toolOnly = parts.some((part) => part?.type === "toolCall") && !parts.some((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim());
    events.push({ kind: "assistant", name: "Assistant", state: message.stopReason === "error" ? "failed" : message.stopReason === "aborted" ? "cancelled" : "completed", toolOnly });
    for (const rawPart of Array.isArray(message.content) ? message.content : []) {
      const part = asRecord(rawPart);
      const id = safeText(part?.id, 128); const name = safeText(part?.name, 120);
      if (part?.type !== "toolCall" || !id || !name || seenCalls.has(id)) continue;
      seenCalls.add(id);
      events.push({ kind: "tool", id, name, state: results.has(id) ? results.get(id) ? "failed" : "completed" : running ? "running" : "completed" });
    }
  }
  const last = events.at(-1);
  if (running && last && last.kind !== "tool") events[events.length - 1] = { ...last, state: "running" };
  return groupRepeatedCalls(owner, events);
}
/** Keeps the opening system/user turns and the most recent turns of a long transcript. */
function boundEvents(events: SemanticEvent[], limit: number): SemanticEvent[] {
  if (events.length <= limit) return events;
  return limit <= 2 ? events.slice(0, limit) : [...events.slice(0, 2), ...events.slice(-(limit - 2))];
}
/** Recorded phase boundaries: `phaseHistory[i].afterAgent` is the launch index where phase i starts. */
function phaseOf(run: Record<string, unknown>, launch: number): { phase: string; phaseIndex: number } | undefined {
  const history = safeArray(run.phaseHistory, 64).map(asRecord);
  let found: { phase: string; phaseIndex: number } | undefined;
  history.forEach((entry, index) => {
    const phase = safeText(entry?.phase, 80); const after = entry?.afterAgent;
    if (phase && typeof after === "number" && Number.isSafeInteger(after) && after <= launch) found = { phase, phaseIndex: index };
  });
  return found;
}

/** Whitelist current accepted metadata; never copies prompts, scripts, environment, args, or result values. */
/** Whole-workflow figures over every recorded agent (all pages), so totals never depend on what is drawn. */
function runSummary(allAgents: readonly unknown[], page: number, pages: number, transcriptOf: (agentId: string) => unknown): SemanticRunSummary {
  const usage: SemanticUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  let running = 0, completed = 0, failed = 0, toolCalls = 0, retries = 0, unknownCalls = false;
  for (const raw of allAgents.slice(0, MAX_SUMMARY_AGENTS)) {
    const agent = asRecord(raw); if (!agent) continue;
    if (agent.state === "running") running += 1; else if (agent.state === "completed") completed += 1; else if (agent.state === "failed" || agent.state === "budget_exhausted") failed += 1;
    // Completed agent records keep no call list: count cached transcripts, else the live list, and mark the rest unknown.
    const id = safeText(agent.id, 128);
    const transcript = id ? transcriptOf(id) : undefined;
    const live = Array.isArray(agent.toolCalls) ? agent.toolCalls.length : 0;
    if (Array.isArray(transcript)) toolCalls += Math.max(live, countToolCalls(transcript));
    else { toolCalls += live; if (agent.state !== "queued" && live === 0) unknownCalls = true; }
    retries += typeof agent.attempts === "number" && Number.isSafeInteger(agent.attempts) ? Math.max(0, agent.attempts - 1) : 0;
    const accounting = asRecord(agent.accounting);
    usage.input += numberOf(accounting?.input); usage.output += numberOf(accounting?.output); usage.cacheRead += numberOf(accounting?.cacheRead); usage.cacheWrite += numberOf(accounting?.cacheWrite); usage.cost = (usage.cost ?? 0) + numberOf(accounting?.cost);
  }
  return { agents: allAgents.length, running, completed, failed, toolCalls, ...(unknownCalls ? { toolCallsPartial: true } : {}), retries, page, pages, usage };
}
function countToolCalls(entries: readonly unknown[]): number {
  let calls = 0;
  for (const raw of entries.slice(-4096)) { const message = asRecord(asRecord(raw)?.message); if (message?.role === "assistant" && Array.isArray(message.content)) calls += message.content.filter((part) => asRecord(part)?.type === "toolCall").length; }
  return calls;
}

export function projectCurrentSemanticSnapshot(context: AppContext, requestedPage = 0): SemanticProjection | undefined {
  const found = context.selected();
  if (!found || found.publisher.connected !== true) return undefined;
  const publisherId = safeText(found.publisher.id, 128);
  const targetId = safeText(found.target.id, 128);
  if (!publisherId || !targetId) return undefined;
  const rawGeneration = found.publisher.generation;
  const generation = typeof rawGeneration === "string" && rawGeneration.length <= 128 || typeof rawGeneration === "number" && Number.isSafeInteger(rawGeneration) ? rawGeneration : null;
  const identity = JSON.stringify([publisherId, generation, found.target.kind, targetId]);
  if (found.target.kind === "run") {
    const run = asRecord(found.record.run);
    if (!run || safeText(run.id, 128) !== targetId) return undefined;
    const allAgents = Array.isArray(run.agents) ? run.agents : [];
    // Paging: each page projects at most MAP_PAGE_AGENTS agents, so the payload and node bounds hold for any run size.
    const pages = Math.max(1, Math.ceil(allAgents.length / MAP_PAGE_AGENTS));
    const page = Math.min(Math.max(0, Math.trunc(requestedPage)), pages - 1);
    const firstLaunch = page * MAP_PAGE_AGENTS;
    const rawAgents = allAgents.slice(firstLaunch, firstLaunch + MAX_SOURCE_AGENTS);
    groupedCalls.clear();
    let callsRemaining = MAX_RUN_TOOL_CALLS;
    let eventsRemaining = MAX_RUN_EVENTS;
    let omittedToolCalls = 0;
    let omittedStructure = 0;
    let invalidAgents = 0;
    const omittedReasons = new Set<string>();
    const agents = rawAgents.flatMap((raw, offset): SemanticAgent[] => {
      const launch = firstLaunch + offset;
      const agent = asRecord(raw);
      const id = safeText(agent?.id, 128);
      if (!agent || !id) { invalidAgents += 1; return []; }
      const sourceAttempts = Array.isArray(agent.attemptDetails) ? agent.attemptDetails : [];
      const attemptDetails = safeArray(sourceAttempts, 8).flatMap((rawAttempt) => {
        const detail = asRecord(rawAttempt);
        const attempt = detail?.attempt;
        if (!Number.isSafeInteger(attempt) || (attempt as number) < 1) return [];
        const error = asRecord(detail?.error);
        const code = safeText(error?.code, 40);
        return [{ attempt: attempt as number, ...(error ? { error: { ...(code ? { code } : {}) } } : {}) }];
      });
      const attempt = typeof agent.attempts === "number" && Number.isSafeInteger(agent.attempts) ? agent.attempts : attemptDetails.length;
      const allPath = Array.isArray(agent.structuralPath) ? agent.structuralPath : [];
      const structuralPath = allPath.slice(0, MAX_STRUCTURAL_PATH).flatMap((part) => typeof part === "string" && part.length <= 80 ? [part] : []);
      omittedStructure += Math.max(0, allPath.length - structuralPath.length) + Math.max(0, sourceAttempts.length - attemptDetails.length);
      if (allPath.length > structuralPath.length || sourceAttempts.length > 8) omittedReasons.add("Attempt and structural-path history bounded");
      const name = safeText(agent.name, 120);
      const label = safeText(agent.label, 120);
      const output = safeOutput(agent.output);
      const parentId = safeText(agent.parentId, 128);
      const transcript = context.state.transcripts[`${String(found.publisher.id)}\t${String(asRecord(found.record.run)?.id)}\t${id}`];
      const usage = usageProjection(agent.accounting, transcript);
      const allEvents = cachedEvents(transcript, typeof agent.systemPrompt === "string" && agent.systemPrompt.length > 0, agent.state === "running", id);
      const events = allEvents ? boundEvents(allEvents, Math.max(0, Math.min(MAX_AGENT_EVENTS, eventsRemaining))) : undefined;
      if (allEvents && events) { eventsRemaining -= events.length; omittedToolCalls += allEvents.length - events.length; if (events.length < allEvents.length) omittedReasons.add("Transcript event projection bounded"); }
      // Without a cached transcript, recorded live tool calls (bounded) still show what the agent is doing.
      const recorded = events ? [] : safeArray(agent.toolCalls, MAX_CACHED_CALLS).flatMap((rawCall) => { const call = asRecord(rawCall); const callId = safeText(call?.id, 128); const name = safeText(call?.name, 120); return callId && name ? [{ id: callId, name, state: safeText(call?.state, 40) ?? "unknown" }] : []; });
      const toolCalls = callsRemaining > 0 ? recorded.slice(0, callsRemaining) : [];
      callsRemaining -= toolCalls.length;
      omittedToolCalls += recorded.length - toolCalls.length;
      if (recorded.length > toolCalls.length) omittedReasons.add("Recorded tool-call projection bounded");
      const phase = phaseOf(run, launch);
      return [{
        id, ...(name ? { name } : {}), ...(label ? { label } : {}), state: safeText(agent.state, 40) ?? "unknown",
        ...(parentId ? { parentId } : {}), structuralPath,
        attempts: attempt, attemptDetails, toolCalls, ...(output ? { output } : {}),
        usage, ...(events ? { events } : {}), ...(phase ?? {}), launch
      }];
    });
    const allRelations = Array.isArray(run.relations) ? run.relations : [];
    const rawRelations = allRelations.slice(0, MAX_SOURCE_RELATIONS);
    const relations = rawRelations.flatMap((raw) => {
      const relation = asRecord(raw);
      const kind = relation?.kind;
      const fromAgentId = safeText(relation?.fromAgentId, 128);
      const toAgentId = safeText(relation?.toAgentId, 128);
      const id = safeText(relation?.id, 128);
      if (!relation || !["dependency", "fork", "merge"].includes(String(kind)) || !fromAgentId || !toAgentId) return [];
      return [{ kind: kind as "dependency" | "fork" | "merge", fromAgentId, toAgentId, ...(id ? { id } : {}), evidence: "recorded" as const }];
    });
    const retry = asRecord(run.retry);
    const sourceRunId = safeText(retry?.sourceRunId, 128);
    const workflowName = safeText(run.workflowName, 120);
    const snapshot = boundedSnapshot({
      scope: { publisherId, targetKind: "run", targetId },
      run: {
        id: targetId, ...(workflowName ? { workflowName } : {}), state: safeText(run.state, 40) ?? "unknown",
        ...(sourceRunId ? { retry: { sourceRunId } } : {}), agents, summary: runSummary(allAgents, page, pages, (agentId) => context.state.transcripts[`${String(found.publisher.id)}\t${targetId}\t${agentId}`])
      },
      ...(relations.length ? { relations } : {}),
      partial: {
        reasons: ["Live projection excludes prompts, scripts, environment, tool arguments, and result values", ...(pages > 1 ? [`Agents ${String(firstLaunch + 1)}–${String(firstLaunch + rawAgents.length)} of ${String(allAgents.length)} (page ${String(page + 1)} of ${String(pages)})`] : []), ...(allRelations.length > MAX_SOURCE_RELATIONS ? ["Recorded relation list bounded"] : []), ...omittedReasons],
        omittedNodes: invalidAgents + omittedStructure + omittedToolCalls,
        omittedEdges: Math.max(0, allRelations.length - relations.length)
      }
    });
    return { identity, snapshot, ...indexSemanticNodes(snapshot), page, pages, totalAgents: allAgents.length };
  }
  const output = safeOutput(found.record.output);
  const attempts = typeof found.record.attempts === "number" && Number.isSafeInteger(found.record.attempts) ? found.record.attempts : 0;
  const details = safeArray(found.record.attemptDetails, 8).flatMap((rawAttempt) => {
    const detail = asRecord(rawAttempt);
    if (!Number.isSafeInteger(detail?.attempt) || (detail?.attempt as number) < 1) return [];
    const error = asRecord(detail?.error);
    const code = safeText(error?.code, 40);
    return [{ attempt: detail?.attempt as number, ...(error ? { error: { ...(code ? { code } : {}) } } : {}) }];
  });
  const progress = asRecord(found.record.progress);
  const label = safeText(found.record.label, 120);
  const toolCalls = safeArray(progress?.toolCalls, MAX_CACHED_CALLS).flatMap((rawCall) => {
    const call = asRecord(rawCall);
    const id = safeText(call?.id, 128);
    const name = safeText(call?.name, 120);
    return call && id && name ? [{ id, name, state: safeText(call.state, 40) ?? "unknown" }] : [];
  });
  const allToolCalls = asRecord(found.record.progress)?.toolCalls;
  const allAttempts = found.record.attemptDetails;
  const omittedAttempts = Math.max(0, (Array.isArray(allAttempts) ? allAttempts.length : 0) - details.length);
  const omittedCalls = Math.max(0, (Array.isArray(allToolCalls) ? allToolCalls.length : 0) - toolCalls.length);
  const subagentTranscript = context.state.transcripts[`${publisherId}\tsubagent\t${targetId}`];
  const subagentUsage = usageProjection(progress?.accounting ?? asRecord(found.record.attempt)?.accounting, subagentTranscript);
  groupedCalls.clear();
  const allSubagentEvents = cachedEvents(subagentTranscript, false, found.record.state === "running", targetId);
  const subagentEvents = allSubagentEvents ? boundEvents(allSubagentEvents, MAX_AGENT_EVENTS) : undefined;
  const omittedEvents = (allSubagentEvents?.length ?? 0) - (subagentEvents?.length ?? 0);
  const snapshot = boundedSnapshot({
    scope: { publisherId, targetKind: "subagent", targetId },
    subagent: {
      id: targetId, ...(label ? { label } : {}), state: safeText(found.record.state, 40) ?? "unknown",
      attempts, attemptDetails: details, ...(output ? { output } : {}), progress: { toolCalls },
      usage: subagentUsage, ...(subagentEvents ? { events: subagentEvents } : {})
    },
    partial: {
      reasons: ["Live projection excludes prompts, scripts, environment, tool arguments, and result values", ...(omittedCalls ? ["Subagent tool-call list bounded"] : []), ...(omittedAttempts ? ["Subagent attempt history bounded"] : []), ...(omittedEvents ? ["Transcript event projection bounded"] : [])],
      omittedNodes: omittedCalls + omittedAttempts + omittedEvents
    }
  });
  return { identity, snapshot, ...indexSemanticNodes(snapshot), page: 0, pages: 1, totalAgents: 1 };
}

const numberOf = (value: unknown): number => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
/** Latest assistant usage in a transcript already cached by the parent; context is never estimated from prompts. */
function latestContext(entries: unknown): number | undefined {
  if (!Array.isArray(entries)) return undefined;
  for (let index = entries.length - 1; index >= Math.max(0, entries.length - 4096); index -= 1) {
    const entry = asRecord(entries[index]); const message = asRecord(entry?.message) ?? entry; const usage = asRecord(message?.usage);
    if (message?.role === "assistant" && usage) {
      // Host-synthesized assistant turns (for example structured-result completion) carry all-zero usage; skip them.
      const total = numberOf(usage.input) + numberOf(usage.output) + numberOf(usage.cacheRead) + numberOf(usage.cacheWrite);
      if (total > 0) return total;
    }
  }
  return undefined;
}
/** Recorded accounting only (token counts, no content) plus the cached-transcript context size when available. */
function usageProjection(accounting: unknown, transcript: unknown): SemanticUsage {
  const value = asRecord(accounting); const context = latestContext(transcript);
  // Agents that have not consumed anything yet show zeros rather than disappearing from the box.
  return { input: numberOf(value?.input), output: numberOf(value?.output), cacheRead: numberOf(value?.cacheRead), cacheWrite: numberOf(value?.cacheWrite), cost: numberOf(value?.cost), ...(context === undefined ? {} : { context }) };
}

/** Owns accessible tabs and explicit activation; static exports never create a browsing context. */
export function installSemanticMapUI(context: AppContext): void {
  const view = document.getElementById("view-run");
  const host = document.getElementById("semantic-map-host");
  const status = document.getElementById("semantic-map-status");
  const tabs = document.getElementById("projection-tabs");
  const timelinePanel = document.getElementById("timeline-panel");
  const mapPanel = document.getElementById("semantic-map-panel");
  const timelineTab = document.getElementById("timeline-tab");
  const mapTab = document.getElementById("semantic-map-tab");
  if (!view || !host || !status || !tabs || !timelinePanel || !mapPanel || !timelineTab || !mapTab) return;
  let selectedTab: "timeline" | "map" = "timeline";
  const theme = (): "light" | "dark" => document.documentElement.dataset.theme === "light" || document.documentElement.dataset.theme === "dark"
    ? document.documentElement.dataset.theme
    : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  // The generator replaces this placeholder with the same stamp as the viewer's JS/CSS references.
  const mapUrl = new URL("./semantic-map.html", location.href);
  mapUrl.searchParams.set("v", __SEMANTIC_MAP_BUILD_STAMP__);
  mapUrl.searchParams.set("embed", "1");
  mapUrl.searchParams.set("theme", theme());
  const retry = document.getElementById("semantic-map-retry");
  const bridge = new SemanticMapBridge({
    host,
    url: mapUrl.href,
    build: __SEMANTIC_MAP_BUILD_STAMP__,
    theme,
    onStatus(message) { status.textContent = message; },
    onRequest(node, detail) { handleNodeRequest(context, node, detail, page); },
    // A failed map stays closed with a visible reason; only the Retry button (or reopening the tab) starts it again.
    onFailure() { if (retry && selectedTab === "map") retry.hidden = false; }
  });
  // Agent page of the current map scope; reset whenever another workflow/session is selected.
  let page = 0;
  let pageIdentity = "";
  const pager = document.getElementById("semantic-map-pager");
  const pageLabel = document.getElementById("semantic-map-page");
  const previous = document.getElementById("semantic-map-prev");
  const next = document.getElementById("semantic-map-next");
  const showPager = (projection: SemanticProjection | undefined): void => {
    if (!pager || !pageLabel || !(previous instanceof HTMLButtonElement) || !(next instanceof HTMLButtonElement)) return;
    pager.hidden = !projection || projection.pages <= 1;
    if (!projection || projection.pages <= 1) return;
    const first = projection.page * MAP_PAGE_AGENTS + 1;
    pageLabel.textContent = `Agents ${String(first)}–${String(Math.min(projection.totalAgents, first + MAP_PAGE_AGENTS - 1))} of ${String(projection.totalAgents)}`;
    previous.disabled = projection.page === 0; next.disabled = projection.page >= projection.pages - 1;
  };
  const update = (): void => {
    if (selectedTab !== "map" || context.staticExport || document.body.dataset.view !== "run" || document.hidden || bridge.failedState) return;
    const found = context.selected();
    const identity = found ? `${String(found.publisher.id)}\t${found.target.kind}\t${found.target.id}` : "";
    if (identity !== pageIdentity) { pageIdentity = identity; page = 0; }
    requestMapTranscripts(context, page);
    const projection = projectCurrentSemanticSnapshot(context, page);
    page = projection?.page ?? 0;
    showPager(projection);
    if (!projection) {
      bridge.close();
      status.textContent = "No selected workflow or subagent. Select a target, then reopen the map.";
      return;
    }
    if (!host.querySelector("iframe")) bridge.open();
    bridge.update(projection.snapshot, projection.identity, projection.nodes, projection.nodeCount);
  };
  const activate = (tab: "timeline" | "map"): void => {
    selectedTab = tab;
    const isMap = tab === "map";
    timelineTab.setAttribute("aria-selected", String(!isMap)); mapTab.setAttribute("aria-selected", String(isMap));
    timelineTab.tabIndex = isMap ? -1 : 0; mapTab.tabIndex = isMap ? 0 : -1;
    timelinePanel.hidden = isMap; mapPanel.hidden = !isMap;
    if (!isMap) { bridge.close(); context.inspect?.(null); if (retry) retry.hidden = true; if (pager) pager.hidden = true; }
    else if (context.staticExport) status.textContent = "Semantic Map is available for live Trajectory sessions only; this is a static export.";
    else if (!context.selected()) status.textContent = "No selected workflow or subagent. Select a target, then reopen the map.";
    else { if (!host.querySelector("iframe")) bridge.open(); update(); }
  };
  tabs.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tab = target.closest<HTMLElement>("[data-semantic-tab]")?.dataset.semanticTab;
    if (tab === "timeline" || tab === "map") activate(tab);
  });
  tabs.addEventListener("keydown", (event) => {
    if (!(event instanceof KeyboardEvent) || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === "Home" || event.key === "ArrowLeft" ? "timeline" : "map";
    activate(next); (next === "timeline" ? timelineTab : mapTab).focus();
  });
  const close = document.getElementById("semantic-map-close");
  close?.addEventListener("click", () => { activate("timeline"); timelineTab.focus(); });
  // A new page shows other agents: the inspector selection from the previous page no longer has a card.
  previous?.addEventListener("click", () => { if (page > 0) { page -= 1; context.inspect?.(null); update(); } });
  next?.addEventListener("click", () => { page += 1; context.inspect?.(null); update(); });
  retry?.addEventListener("click", () => {
    if (selectedTab !== "map" || context.staticExport) return;
    retry.hidden = true;
    bridge.retry();
    update();
  });
  // The map of the focused run (agent view) or subagent is one keyboard-operable step away from its detail view.
  const focusMap = document.getElementById("focus-semantic-map");
  focusMap?.addEventListener("click", () => {
    if (!context.selected()) return;
    context.setView("run");
    activate("map");
    mapTab.focus();
  });
  const appWindow = window as UiWindow;
  appWindow.__PIEWF_SEMANTIC_MAP_REFRESH__ = update;
  appWindow.__PIEWF_SEMANTIC_MAP_VISIBILITY__ = (visible) => { bridge.setVisible(visible); };
  appWindow.__PIEWF_SEMANTIC_MAP_THEME__ = () => { bridge.setTheme(theme()); };
  void view;
}

/** The map shows each agent's recorded event sequence, so it asks for the (bounded, cached) transcripts it displays. */
function requestMapTranscripts(context: AppContext, page: number): void {
  const found = context.selected();
  if (!found || !context.requestTranscript) return;
  if (found.target.kind === "subagent") { context.requestTranscript(); return; }
  const all = Array.isArray(asRecord(found.record.run)?.agents) ? asRecord(found.record.run)?.agents as unknown[] : [];
  for (const raw of all.slice(page * MAP_PAGE_AGENTS, page * MAP_PAGE_AGENTS + MAP_PAGE_AGENTS)) {
    const agent = asRecord(raw); const id = safeText(agent?.id, 128);
    if (id && agent?.state !== "queued") context.requestTranscript(id);
  }
}

function handleNodeRequest(context: AppContext, node: ParentSemanticNode, detail: boolean, page: number): void {
  const found = context.selected();
  if (!found || found.publisher.connected !== true) return;
  const projection = projectCurrentSemanticSnapshot(context, page);
  if (!projection) return;
  const current = projection.nodes.get(node.id);
  if (!current || current.kind !== node.kind || current.sourceRef !== node.sourceRef) return;
  if (current.kind === "workflow") return;
  if (found.target.kind === "subagent") {
    if (current.sourceRef !== found.target.id) return;
    if (detail) context.setView("subagent");
    return;
  }
  const run = asRecord(found.record.run);
  const state = context.state as AppState & { currentAgent?: string; selectedEvent?: number; inspMode?: string };
  const agents = safeArray(run?.agents, MAX_SUMMARY_AGENTS).map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
  let agentId: string | undefined;
  const eventRef = /^(.*)#(system|user|assistant)#(\d+)$/.exec(current.sourceRef);
  if (current.kind === "system" || current.kind === "user" || current.kind === "assistant") agentId = safeText(eventRef?.[1], 128);
  else if (current.kind === "agent" || current.kind === "tool-call" || current.kind === "result") {
    if (current.kind === "tool-call") {
      const matching = agents.filter((agent) => typeof agent.id === "string" && current.sourceRef.startsWith(`${agent.id}/`)).sort((a, b) => String(b.id).length - String(a.id).length)[0];
      agentId = safeText(matching?.id, 128);
    } else agentId = safeText(current.sourceRef, 128);
  }
  if (!agentId || !agents.some((agent) => agent.id === agentId)) return;
  if (!detail) {
    // Single click: show the selected agent/tool in the run inspector, exactly as the Gantt event inspector does.
    const callIds = current.kind === "tool-call" ? groupedCalls.get(current.sourceRef) : undefined;
    context.inspect?.({ agentId, kind: current.kind, ...(current.kind === "tool-call" ? { callId: current.sourceRef.slice(agentId.length + 1) } : {}), ...(callIds ? { callIds } : {}), ...(eventRef ? { ordinal: Number(eventRef[3]) } : {}) });
    return;
  }
  context.inspect?.(null);
  state.currentAgent = agentId;
  if (current.kind === "tool-call") {
    const transcriptKey = `${String(found.publisher.id)}\t${String(run?.id)}\t${agentId}`;
    const entries = context.state.transcripts[transcriptKey];
    if (Array.isArray(entries)) {
      const callId = current.sourceRef.slice(agentId.length + 1);
      const eventIndex = entries.findIndex((raw) => {
        const entry = asRecord(raw);
        const message = asRecord(entry?.message);
        return Array.isArray(message?.content) && message.content.some((part) => asRecord(part)?.type === "toolCall" && asRecord(part)?.id === callId);
      });
      if (eventIndex >= 0) { state.selectedEvent = eventIndex; state.inspMode = "event"; }
    }
  }
  context.setView("agent");
}

if (typeof window !== "undefined") {
  const uiWindow = window as UiWindow;
  if (uiWindow.__PIEWF_SEMANTIC_MAP_CONTEXT__) installSemanticMapUI(uiWindow.__PIEWF_SEMANTIC_MAP_CONTEXT__);
}
