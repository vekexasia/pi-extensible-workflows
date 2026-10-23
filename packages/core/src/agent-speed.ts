import type { AgentSpeed, WorkflowAgentSessionEvent } from "./types.js";

/** The shortest generation span a rate is reported over (pi-tps-status's minimum). */
export const MIN_RATE_SPAN_MS = 250;
const DELTAS = new Set(["text_delta", "thinking_delta", "toolcall_delta"]);
const UNFINISHED = new Set(["error", "aborted", "pending", "deferred"]);

function whole(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value); }
function span(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }

/** The counters when they hold at least one message and are consistent; undefined otherwise. */
export function validAgentSpeed(value: unknown): AgentSpeed | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const { messages, outputTokens, generationMs, firstTokenMs } = value as Record<string, unknown>;
  if (!whole(messages) || messages < 1 || !whole(outputTokens) || outputTokens < messages || !span(generationMs) || !span(firstTokenMs)) return undefined;
  return { messages, outputTokens, generationMs, firstTokenMs };
}

export function addSpeed(left: AgentSpeed | undefined, right: AgentSpeed | undefined): AgentSpeed | undefined {
  if (left === undefined || right === undefined) return left ?? right;
  return { messages: left.messages + right.messages, outputTokens: left.outputTokens + right.outputTokens, generationMs: left.generationMs + right.generationMs, firstTokenMs: left.firstTokenMs + right.firstTokenMs };
}

/** Output tokens per second over the generation time, once that is long enough to mean something. Never use accounting.output here: it includes errored and unobserved responses. */
export function speedTps(speed: AgentSpeed): number | undefined { return speed.generationMs >= MIN_RATE_SPAN_MS ? speed.outputTokens * 1000 / speed.generationMs : undefined; }
export function speedTtftMs(speed: AgentSpeed): number { return speed.firstTokenMs / speed.messages; }
export function speedStats(speed: AgentSpeed): string { return `${String(speed.outputTokens)} tok in ${(speed.generationMs / 1000).toFixed(1)}s`; }

/**
 * Counts assistant messages by the contract's rule.
 * The window opens at turn_start, which Pi emits before every request, and the first token is the first non-empty text,
 * thinking or tool-call delta: a provider (cliproxyapi) sends its *_start events together with message_start, so they mark
 * nothing. TTFT here is request start to first content, so it includes Pi's work and any provider queueing before the stream
 * starts; it differs from pi-tps-status, which measures from the user message_start.
 */
export class SpeedTracker {
  #total: AgentSpeed = { messages: 0, outputTokens: 0, generationMs: 0, firstTokenMs: 0 };
  #turnStartAt: number | undefined;
  #firstTokenAt: number | undefined;

  observe(event: WorkflowAgentSessionEvent, now: number): void {
    if (event.message?.role !== undefined && event.message.role !== "assistant") return;
    if (event.type === "turn_start") { this.#turnStartAt = now; this.#firstTokenAt = undefined; }
    else if (event.type === "message_update") this.#update(event, now);
    else if (event.type === "message_end" && event.message?.role === "assistant") this.#end(event, now);
  }

  /** The counters, absent while nothing was counted. */
  speed(): AgentSpeed | undefined { return this.#total.messages > 0 ? { ...this.#total } : undefined; }

  #update(event: WorkflowAgentSessionEvent, now: number): void {
    const type = event.assistantMessageEvent?.type, delta = event.assistantMessageEvent?.delta;
    if (this.#turnStartAt === undefined || this.#firstTokenAt !== undefined || type === undefined || !DELTAS.has(type) || typeof delta !== "string" || delta.length === 0) return;
    this.#firstTokenAt = now;
  }

  #end(event: WorkflowAgentSessionEvent, now: number): void {
    const start = this.#turnStartAt, firstToken = this.#firstTokenAt;
    const stopReason = event.message?.stopReason, output = event.message?.usage?.output;
    this.#turnStartAt = undefined; this.#firstTokenAt = undefined;
    if (start === undefined || firstToken === undefined || stopReason === undefined || UNFINISHED.has(stopReason) || output === undefined || !whole(output) || output <= 0) return;
    this.#total = { messages: this.#total.messages + 1, outputTokens: this.#total.outputTokens + output, generationMs: this.#total.generationMs + Math.max(0, now - firstToken), firstTokenMs: this.#total.firstTokenMs + Math.max(0, firstToken - start) };
  }
}
