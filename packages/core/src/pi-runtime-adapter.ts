import type { RuntimeAgentHandoff, RuntimeAgentProgress, RuntimeAgentState, RuntimeHandoffState, RuntimeToolCallProgress } from "./runtime/agent-runner.js";
import type { AgentProgress } from "./agent-execution.js";
import type { LiveSessionHandoff, WorkflowAgentMessage, WorkflowAgentSession, WorkflowAgentSessionEvent, WorkflowAgentSessionState } from "./types.js";
import { THINKING_LEVELS } from "./types.js";
import { sanitizeDisplayText } from "./utils.js";
const TURN_START_EVENTS = new Set(["turn_start", "turn_started", "turnStarted"]);
const MAX_ACTIVITY_TEXT_CHARS = 200;
const AGENT_START_EVENTS = new Set(["agent_start"]);
const TURN_END_EVENTS = new Set(["turn_end", "turnEnded", "agent_end", "agent_settled"]);
type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : undefined; }
function stringValue(value: unknown): string | undefined { return typeof value === "string" ? value : undefined; }
function isThinking(value: unknown): value is NonNullable<WorkflowAgentSessionState["thinking"]> { return THINKING_LEVELS.some((level) => level === value); }
function finiteNumber(value: unknown): number | undefined { return typeof value === "number" && Number.isFinite(value) ? value : undefined; }

function normalizeMessage(value: unknown): WorkflowAgentMessage | undefined {
  const candidate = record(value);
  const role = stringValue(candidate?.role);
  if (!candidate || role === undefined) return undefined;
  const usage = record(candidate.usage);
  const cost = record(usage?.cost);
  const input = finiteNumber(usage?.input);
  const output = finiteNumber(usage?.output);
  const cacheRead = finiteNumber(usage?.cacheRead);
  const cacheWrite = finiteNumber(usage?.cacheWrite);
  const totalCost = finiteNumber(cost?.total);
  const normalizedUsage = input === undefined || output === undefined || cacheRead === undefined || cacheWrite === undefined || totalCost === undefined ? undefined : { input, output, cacheRead, cacheWrite, cost: { total: totalCost } };
  const stopReason = stringValue(candidate.stopReason);
  const errorMessage = stringValue(candidate.errorMessage);
  return {
    role,
    ...(candidate.content === undefined ? {} : { content: candidate.content }),
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(normalizedUsage === undefined ? {} : { usage: normalizedUsage }),
  };
}

export function normalizePiMessage(value: unknown): WorkflowAgentMessage | undefined { return normalizeMessage(value); }

function normalizeState(value: unknown): WorkflowAgentSessionState | undefined {
  const candidate = record(value);
  const model = record(candidate?.model);
  const provider = stringValue(model?.provider);
  const modelName = stringValue(model?.model);
  const rawTools = candidate?.tools;
  const tools = Array.isArray(rawTools) ? rawTools.filter((tool): tool is string => typeof tool === "string") : undefined;
  if (!candidate || !model || provider === undefined || modelName === undefined || tools === undefined || !Array.isArray(rawTools) || tools.length !== rawTools.length) return undefined;
  const thinking = candidate.thinking === undefined ? model.thinking : candidate.thinking;
  if (thinking !== undefined && !isThinking(thinking)) return undefined;
  const systemPrompt = candidate.systemPrompt;
  if (systemPrompt !== undefined && typeof systemPrompt !== "string") return undefined;
  return {
    model: { provider, model: modelName, ...(thinking === undefined ? {} : { thinking }) },
    ...(thinking === undefined ? {} : { thinking }),
    tools: [...tools],
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
  };
}

function normalizedEvent(value: unknown): WorkflowAgentSessionEvent | undefined {
  const candidate = record(value);
  const type = stringValue(candidate?.type);
  if (!candidate || type === undefined) return undefined;
  const state = normalizeState(candidate.state);
  const message = normalizeMessage(candidate.message);
  const assistantMessageEvent = record(candidate.assistantMessageEvent);
  const assistantType = stringValue(assistantMessageEvent?.type);
  const assistantDelta = stringValue(assistantMessageEvent?.delta);
  const toolCallId = stringValue(candidate.toolCallId);
  const toolName = stringValue(candidate.toolName);
  const isError = candidate.isError;
  return {
    type,
    ...(state === undefined ? {} : { state }),
    ...(message === undefined ? {} : { message }),
    ...(assistantType === undefined ? {} : { assistantMessageEvent: { type: assistantType, ...(assistantDelta === undefined ? {} : { delta: assistantDelta }) } }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    ...(toolName === undefined ? {} : { toolName }),
    ...(typeof isError === "boolean" ? { isError } : {}),
  };
}

export function normalizePiSessionEvent(value: unknown): WorkflowAgentSessionEvent | undefined { return normalizedEvent(value); }

function stateFromSession(session: WorkflowAgentSession): RuntimeAgentState {
  const current = session.getState();
  return {
    model: { ...current.model },
    ...(current.thinking === undefined ? {} : { thinking: current.thinking }),
    tools: [...current.tools],
    ...(current.systemPrompt === undefined ? {} : { systemPrompt: current.systemPrompt }),
  };
}

function runtimeState(state: WorkflowAgentSessionState): RuntimeAgentState { return { model: { ...state.model }, ...(state.thinking === undefined ? {} : { thinking: state.thinking }), tools: [...state.tools], ...(state.systemPrompt === undefined ? {} : { systemPrompt: state.systemPrompt }) }; }

function runtimeUsage(session: WorkflowAgentSession): RuntimeAgentProgress["usage"] {
  const stats = session.getSessionStats();
  const values = [stats.tokens.input, stats.tokens.output, stats.tokens.cacheRead, stats.tokens.cacheWrite, stats.cost];
  if (values.some((value) => !Number.isFinite(value))) return { availability: "unavailable" };
  return { availability: "complete", input: stats.tokens.input, output: stats.tokens.output, cacheRead: stats.tokens.cacheRead, cacheWrite: stats.tokens.cacheWrite, costUsd: stats.cost };
}

function sameActivity(left: RuntimeAgentProgress["activity"], right: RuntimeAgentProgress["activity"]): boolean { return left?.kind === right?.kind && left?.text === right?.text; }

function runtimeHandoffState(state: LiveSessionHandoff["state"]): RuntimeHandoffState {
  if (state === "handoff-pending") return "takeover-pending";
  if (state === "herdr-running") return "remote-running";
  return state;
}

export function isTurnBoundaryStart(type: string): boolean { return TURN_START_EVENTS.has(type); }
export function isTurnBoundaryEnd(type: string): boolean { return TURN_END_EVENTS.has(type); }
export function isTurnEnd(type: string): boolean { return type === "turn_end" || type === "turnEnded"; }

function boundaryEvent(type: string): "turn_started" | "turn_end" | undefined {
  if (isTurnBoundaryStart(type) || AGENT_START_EVENTS.has(type)) return "turn_started";
  if (isTurnBoundaryEnd(type)) return "turn_end";
  return undefined;
}

export function createRuntimeHandoffAdapter(handoff: LiveSessionHandoff): RuntimeAgentHandoff {
  return {
    get state() { return runtimeHandoffState(handoff.state); },
    get transferred() { return handoff.transferred; },
    observe(event) {
      const type = boundaryEvent(event.type);
      if (type !== undefined) handoff.observe({ type });
    },
    request: (launch) => handoff.request(launch),
    waitForTakeover: () => handoff.waitForTakeover(),
    takeover: () => { handoff.takeover(); },
    waitForResume: () => handoff.waitForResume(),
    release: (reason?: string) => { handoff.release(reason); },
  };
}

export interface PiRuntimeProgressObservation {
  readonly event: WorkflowAgentSessionEvent;
  readonly progress: RuntimeAgentProgress;
  readonly report: boolean;
  readonly persist: boolean;
}

export interface PiRuntimeSessionAdapter {
  readonly handoff: RuntimeAgentHandoff;
  observe(event: WorkflowAgentSessionEvent): PiRuntimeProgressObservation | undefined;
  snapshot(persist: boolean): RuntimeAgentProgress;
  dispose(): void;
}

export function createPiRuntimeSessionAdapter(session: WorkflowAgentSession, handoff: LiveSessionHandoff, clock: () => number = Date.now): PiRuntimeSessionAdapter {
  const neutralHandoff = createRuntimeHandoffAdapter(handoff);
  const toolCalls = new Map<string, RuntimeToolCallProgress>();
  let activity: RuntimeAgentProgress["activity"];
  let streamText = "";
  let lastEventAt: number | undefined;
  let lastReportedEventAt: number | undefined;
  let disposed = false;

  let toolCallsView: readonly RuntimeToolCallProgress[] = [];
  const progressAt = (persist: boolean, stateOverride: RuntimeAgentState | undefined, toolCallsValue: readonly RuntimeToolCallProgress[], activityValue: RuntimeAgentProgress["activity"], eventAtValue: number | undefined): RuntimeAgentProgress => ({ usage: runtimeUsage(session), toolCalls: toolCallsValue, state: stateOverride ?? stateFromSession(session), ...(activityValue === undefined ? {} : { activity: activityValue }), ...(eventAtValue === undefined ? {} : { lastEventAt: eventAtValue }), persist });
  const snapshot = (persist: boolean): RuntimeAgentProgress => progressAt(persist, undefined, [...toolCalls.values()], activity, lastEventAt);
  return {
    handoff: neutralHandoff,
    observe(event) {
      if (disposed) return undefined;
      neutralHandoff.observe(event);
      const eventAt = clock();
      lastEventAt = eventAt;
      const eventState = event.state === undefined ? undefined : runtimeState(event.state);
      let report = false;
      let persist = false;
      const previousActivity = activity;
      let eventToolCalls = toolCallsView;
      if (event.type === "state_changed") { report = true; persist = true; }
      if (event.type === "message_start" && event.message?.role === "assistant") { streamText = ""; activity = { kind: "text", text: "" }; report = true; }
      if (event.type === "message_update") {
        const updateType = event.assistantMessageEvent?.type;
        if (updateType === "thinking_start" || updateType === "text_start") streamText = "";
        const delta = event.assistantMessageEvent?.delta;
        if ((updateType === "thinking_delta" || updateType === "text_delta") && delta) streamText = `${streamText}${delta}`.replace(/\s+/g, " ").slice(-MAX_ACTIVITY_TEXT_CHARS);
        if (updateType && ["thinking_start", "thinking_delta", "thinking_end"].includes(updateType)) activity = { kind: "reasoning", text: streamText };
        else if (updateType && ["text_start", "text_delta", "text_end", "toolcall_start", "toolcall_delta", "toolcall_end"].includes(updateType)) activity = { kind: "text", text: streamText };
        report = previousActivity?.kind !== activity?.kind;
      }
      if (event.type === "message_end") {
        streamText = "";
        activity = undefined;
        report = !sameActivity(previousActivity, activity);
        if (event.message?.role === "assistant") { persist = true; report = true; }
      }
      if (event.type === "tool_execution_start" && event.toolCallId && event.toolName) {
        toolCalls.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, state: "running" });
        toolCallsView = [...toolCalls.values()];
        activity = { kind: "tool", text: event.toolName };
        report = true;
      }
      if (event.type === "tool_execution_update" && event.toolName) {
        activity = { kind: "tool", text: event.toolName };
        report = !sameActivity(previousActivity, activity);
      }
      let removeToolCallId: string | undefined;
      if (event.type === "tool_execution_end" && event.toolCallId && event.toolName) {
        toolCalls.set(event.toolCallId, { id: event.toolCallId, name: event.toolName, state: event.isError ? "failed" : "completed" });
        eventToolCalls = [...toolCalls.values()];
        if (activity?.kind === "tool" && activity.text === event.toolName) activity = undefined;
        report = true;
        removeToolCallId = event.toolCallId;
      }
      if (removeToolCallId === undefined) eventToolCalls = toolCallsView;
      if (!report && (lastReportedEventAt === undefined || eventAt - lastReportedEventAt >= 1000)) report = true;
      const eventActivity = activity;
      let materialized: RuntimeAgentProgress | undefined;
      const result = { event, get progress() { return materialized ??= progressAt(persist, eventState, eventToolCalls, eventActivity, eventAt); }, report, persist };
      if (report) lastReportedEventAt = eventAt;
      if (removeToolCallId !== undefined) {
        toolCalls.delete(removeToolCallId);
        toolCallsView = [...toolCalls.values()];
      }
      return result;
    },
    snapshot,
    dispose() { disposed = true; toolCalls.clear(); toolCallsView = []; activity = undefined; },
  };
}

function requiredUsage(value: number | undefined, name: string): number {
  if (value === undefined || !Number.isFinite(value)) throw new Error(`Pi runtime usage is missing ${name}`);
  return value;
}

export function runtimeProgressToAgentProgress(value: RuntimeAgentProgress): AgentProgress {
  if (value.usage.availability !== "complete") throw new Error(`Cannot convert ${value.usage.availability} runtime usage to Pi accounting`);
  return {
    accounting: { input: requiredUsage(value.usage.input, "input"), output: requiredUsage(value.usage.output, "output"), cacheRead: requiredUsage(value.usage.cacheRead, "cacheRead"), cacheWrite: requiredUsage(value.usage.cacheWrite, "cacheWrite"), cost: requiredUsage(value.usage.costUsd, "costUsd") },
    toolCalls: value.toolCalls.map(({ id, name, state }) => ({ id, name, state })),
    ...(value.state === undefined ? {} : { state: { model: { ...value.state.model }, ...(value.state.thinking === undefined ? {} : { thinking: value.state.thinking }), tools: [...value.state.tools], ...(value.state.systemPrompt === undefined ? {} : { systemPrompt: value.state.systemPrompt }) } }),
    ...(value.activity === undefined ? {} : { activity: { ...value.activity, text: sanitizeDisplayText(value.activity.text) } }),
    ...(value.lastEventAt === undefined ? {} : { lastEventAt: value.lastEventAt }),
    persist: value.persist,
  };
}
