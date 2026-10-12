import assert from "node:assert/strict";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { Publisher, waitForHeapTranscripts } from "./trajectory-semantic-map-acceptance.mjs";

void test("acceptance publisher answers transcript RPCs with the exact requested target and revision", async (t) => {
  class Socket extends globalThis.EventTarget {
    sent = [];
    constructor() { super(); globalThis.queueMicrotask(() => this.dispatchEvent(new globalThis.Event("open"))); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() {}
  }
  const originalWebSocket = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  t.after(() => { globalThis.WebSocket = originalWebSocket; });
  const publisher = new Publisher(12345, "fixture");
  await publisher.connect();
  t.after(() => publisher.close());
  const targets = [
    { runId: "run", agentId: "agent", revision: 7 },
    { subagentId: "subagent", revision: 0 },
    { runId: "run", agentId: "other" }
  ];
  for (const [index, target] of targets.entries()) {
    const request = { type: "publisher:transcript", requestId: `request-${index}`, publisherId: "fixture", ...target };
    publisher.socket.dispatchEvent(new globalThis.MessageEvent("message", { data: JSON.stringify(request) }));
    assert.deepEqual(publisher.socket.sent.at(-1), { ...request, type: "publisher:transcript-result", ok: true, status: "empty", revision: target.revision ?? 1, entries: [] });
  }
  const before = publisher.socket.sent.length;
  publisher.socket.dispatchEvent(new globalThis.MessageEvent("message", { data: JSON.stringify({ type: "publisher:action", requestId: "action" }) }));
  assert.equal(publisher.socket.sent.length, before);
});

function heapPage({ pending = {}, transcripts = { "fixture\trun\tagent": [] }, status = "empty" } = {}) {
  const state = { transcriptPending: pending, transcripts, transcriptStatus: { "fixture\trun\tagent": status } };
  const context = { state, selected: () => ({ publisher: { id: "fixture" }, record: { run: { id: "run", agents: [{ id: "agent", state: "running" }, { id: "queued", state: "queued" }] } } }) };
  return { state, eval: async (expression) => JSON.parse(JSON.stringify(runInNewContext(expression, { window: { __PIEWF_SEMANTIC_MAP_CONTEXT__: context } }))) };
}

void test("heap baseline waits for cached empty transcripts and no pending requests", async () => {
  const page = heapPage({ pending: { "fixture\trun\tagent": { requestId: "pending" } }, transcripts: {} });
  const evaluate = page.eval;
  let calls = 0;
  page.eval = async (expression) => {
    const result = await evaluate(expression);
    if (++calls === 1) { page.state.transcriptPending = {}; page.state.transcripts["fixture\trun\tagent"] = []; }
    return result;
  };
  assert.deepEqual(await waitForHeapTranscripts(page), { expected: 1, cached: 1, pending: 0 });
  assert.ok(calls >= 2);
});

void test("heap baseline rejects missing, failed or still-pending transcripts", async () => {
  for (const page of [heapPage({ transcripts: {} }), heapPage({ status: "failed" }), heapPage({ pending: { "fixture\trun\tagent": {} } })]) {
    await assert.rejects(waitForHeapTranscripts(page, 25), /heap baseline transcripts/);
  }
});
