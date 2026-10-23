import assert from "node:assert/strict";
import test from "node:test";
import { createLiveSessionHandoff } from "../src/session-handoff.js";
import { createPiRuntimeSessionAdapter } from "../src/pi-runtime-adapter.js";
import type { WorkflowAgentMessage, WorkflowAgentSession, WorkflowAgentSessionEvent } from "../src/types.js";

const state = { model: { provider: "pi", model: "model" }, tools: ["read"] };
const stats = { tokens: { input: 2, output: 3, cacheRead: 5, cacheWrite: 7, total: 17 }, cost: 0.25 };
function session(): WorkflowAgentSession {
  return { reference: { transport: "local", sessionId: "s" }, getState: () => state, getSessionStats: () => stats, getLastAssistant: () => undefined, subscribe: () => () => undefined, prompt: async () => ({}), steer: async () => undefined, abort: async () => undefined, dispose: async () => undefined };
}
const usage = (output: number) => ({ input: 1, output, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } });
const partial = (output: number): WorkflowAgentMessage => ({ role: "assistant", content: [], usage: usage(output) });
const end = (stopReason: string, output: number): WorkflowAgentSessionEvent => ({ type: "message_end", message: { role: "assistant", content: [], stopReason, usage: usage(output) } });
const turn: WorkflowAgentSessionEvent = { type: "turn_start" };
const start: WorkflowAgentSessionEvent = { type: "message_start", message: partial(0) };
const update = (type: string, delta?: string, output?: number): WorkflowAgentSessionEvent => ({ type: "message_update", message: partial(output ?? 0), assistantMessageEvent: { type, ...(delta === undefined ? {} : { delta }) } });
function harness() {
  let now = 0;
  const adapter = createPiRuntimeSessionAdapter(session(), createLiveSessionHandoff(), () => now);
  const at = (time: number, event: WorkflowAgentSessionEvent) => { now = time; adapter.observe(event); };
  return { adapter, at };
}

void test("a normal message counts from the first content to its end, and its TTFT runs from turn_start", () => {
  const { adapter, at } = harness();
  at(0, turn);
  at(600, start);
  at(800, update("text_start"));
  at(1_000, update("text_delta", "x".repeat(40)));
  at(3_800, end("stop", 120));
  assert.deepEqual(adapter.snapshot(true).speed, { messages: 1, outputTokens: 120, generationMs: 2_800, firstTokenMs: 1_000 });
});

void test("*_start events and empty deltas do not start the first-token clock: the first non-empty delta does", () => {
  const { adapter, at } = harness();
  at(0, turn); at(0, start);
  at(0, update("thinking_start"));
  at(0, update("toolcall_start"));
  at(10, update("toolcall_delta", ""));
  at(5_000, update("toolcall_delta", "abcd"));
  at(30_000, end("toolUse", 100));
  assert.deepEqual(adapter.snapshot(true).speed, { messages: 1, outputTokens: 100, generationMs: 25_000, firstTokenMs: 5_000 });
});

void test("tool time between messages is in neither the generation time nor the TTFT of the next turn", () => {
  const { adapter, at } = harness();
  at(0, turn); at(0, start); at(800, update("text_start")); at(1_000, update("text_delta", "x".repeat(40))); at(3_800, end("toolUse", 120));
  at(13_800, turn); at(13_800, start); at(14_000, update("text_start")); at(14_200, update("text_delta", "x".repeat(40))); at(15_200, update("text_delta", "x".repeat(400)));
  at(17_000, end("stop", 120));
  assert.deepEqual(adapter.snapshot(true).speed, { messages: 2, outputTokens: 240, generationMs: 5_600, firstTokenMs: 1_400 });
});

void test("an errored Pi in-session retry counts only the retried message", () => {
  const { adapter, at } = harness();
  at(0, turn); at(0, start); at(500, update("text_start")); at(1_000, update("text_delta", "abcdefgh")); at(2_000, end("error", 30));
  assert.equal(adapter.snapshot(true).speed, undefined);
  at(2_100, { type: "agent_start" }); at(2_100, turn);
  at(2_200, start); at(2_400, update("text_start")); at(2_600, update("text_delta", "abcdefgh")); at(4_400, end("stop", 80));
  assert.deepEqual(adapter.snapshot(true).speed, { messages: 1, outputTokens: 80, generationMs: 1_800, firstTokenMs: 500 });
});

void test("an aborted message is not counted and earlier counts stay", () => {
  const { adapter, at } = harness();
  at(0, turn); at(0, start); at(100, update("text_start")); at(100, update("text_delta", "ab")); at(2_100, end("stop", 80));
  at(3_000, turn); at(3_000, start); at(3_100, update("text_start")); at(3_500, update("text_delta", "abcdefgh")); at(5_000, end("aborted", 40));
  assert.deepEqual(adapter.snapshot(true).speed, { messages: 1, outputTokens: 80, generationMs: 2_000, firstTokenMs: 100 });
});

void test("an unfinished message does not leak into the next turn", () => {
  const { adapter, at } = harness();
  at(0, turn); at(0, start); at(100, update("text_start")); at(100, update("text_delta", "ab"));
  at(5_000, turn); at(5_000, start); at(5_500, update("text_start")); at(5_500, update("text_delta", "ab")); at(6_500, end("stop", 50));
  assert.deepEqual(adapter.snapshot(true).speed, { messages: 1, outputTokens: 50, generationMs: 1_000, firstTokenMs: 500 });
});

void test("deferred and pending responses, empty windows and zero output are not counted", () => {
  const { adapter, at } = harness();
  at(0, turn); at(0, start); at(100, update("text_delta", "ab")); at(900, end("deferred", 10));
  at(1_000, turn); at(1_000, start); at(1_100, update("text_delta", "ab")); at(1_900, end("pending", 10));
  at(2_000, turn); at(2_000, start); at(2_100, update("text_start")); at(2_500, end("stop", 10));
  at(3_000, turn); at(3_000, start); at(3_100, update("text_delta", "ab")); at(4_000, end("stop", 0));
  assert.equal(adapter.snapshot(true).speed, undefined);
});
