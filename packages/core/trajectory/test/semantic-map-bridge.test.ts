import assert from "node:assert/strict";
import test from "node:test";
import { isSemanticMapNodeId, isValidSemanticMapBridgeEnvelope } from "../src/semantic-map/bridge.js";
import { projectCurrentSemanticSnapshot } from "../src/semantic-map/index.js";
import { adaptSemanticSnapshot } from "../src/semantic-map/adapter.js";

void test("Semantic Map bridge accepts only bounded protocol envelopes and scoped node identifiers", () => {
  assert.equal(isValidSemanticMapBridgeEnvelope({ type: "ready", version: 1, nonce: "a".repeat(64), instance: "b".repeat(64) }), true);
  assert.equal(isValidSemanticMapBridgeEnvelope({ type: "ready", version: 1, build: "0123456789abcdef", nonce: "a".repeat(64), instance: "b".repeat(64) }), true);
  assert.equal(isValidSemanticMapBridgeEnvelope({ type: "ack", version: 1, build: "0123456789abcdef", nonce: "a".repeat(64), instance: "b".repeat(64) }), false, "only readiness carries the viewer build");
  assert.equal(isValidSemanticMapBridgeEnvelope({ type: "ready", version: 2, nonce: "a".repeat(64), instance: "b".repeat(64) }), false);
  assert.equal(isValidSemanticMapBridgeEnvelope({ type: "bootstrap", version: 1 }), false);
  assert.equal(isValidSemanticMapBridgeEnvelope({ type: "ack", version: 1, padding: "x".repeat(512 * 1024) }), false);
  assert.equal(isSemanticMapNodeId("sm-0102ff"), true);
  assert.equal(isSemanticMapNodeId("sm-xyz"), false);
  assert.equal(isSemanticMapNodeId("sm-01\n"), false);
});

void test("Semantic Map parent projection is bounded, explicit, and excludes prompts, arguments, and output values", () => {
  const secret = "private fixture payload";
  const found = {
    publisher: { id: "pub", generation: "publisher-generation", connected: true },
    target: { kind: "run" as const, publisherId: "pub", id: "run" },
    record: {
      run: {
        id: "run", workflowName: "Fixture workflow", state: "running", retry: { sourceRunId: "previous-run" },
        agents: [{
          id: "agent", name: "Worker", label: "Worker", state: "running", attempts: 2, structuralPath: ["phase"], parentId: undefined,
          prompt: secret, output: { status: "available", value: secret },
          attemptDetails: [{ attempt: 1, error: { code: "RETRY", message: secret }, setup: { cwd: secret } }, { attempt: 2 }],
          toolCalls: [{ id: "metadata-call", name: "read", state: "completed" }],
        }, { id: "other", name: "Other", state: "queued", output: { status: "pending" } }],
        relations: [{ kind: "dependency", fromAgentId: "agent", toAgentId: "other", evidence: "recorded" }],
        parentRunId: "unproven-parent",
      },
      transcripts: { agent: [{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "cached-call", name: "read", arguments: { path: secret } }] } }] },
      snapshot: { script: secret, args: { token: secret } },
    },
  };
  const context = {
    state: { transcripts: { "pub\trun\tagent": found.record.transcripts.agent } },
    selected: () => found,
    setView: () => undefined,
    staticExport: false,
  } as unknown as Parameters<typeof projectCurrentSemanticSnapshot>[0];
  const projection = projectCurrentSemanticSnapshot(context);
  assert.ok(projection);
  assert.equal(projection.identity, '["pub","publisher-generation","run","run"]');
  assert.equal(projection.snapshot.run?.retry?.sourceRunId, "previous-run");
  assert.equal(projection.snapshot.relations?.length, 1);
  const projectedRun = projection.snapshot.run;
  assert.ok(projectedRun);
  const projectedAgents = projectedRun.agents;
  assert.ok(projectedAgents);
  const projectedAgent = projectedAgents[0];
  assert.ok(projectedAgent);
  assert.deepEqual(projectedAgent.events?.map((event) => [event.kind, event.id ?? event.name]), [["assistant", "Assistant"], ["tool", "cached-call"]], "cached transcript becomes a kinds-only event sequence");
  assert.equal(projectedAgent.toolCalls?.length, 0, "recorded calls are only a fallback when no transcript is cached");
  assert.equal(projectedAgents[1]?.toolCalls?.length, 0);
  assert.equal(projectedAgent.attemptDetails?.[0]?.error?.code, "RETRY");
  const serialized = JSON.stringify(projection.snapshot);
  assert.ok(new TextEncoder().encode(serialized).byteLength <= 512 * 1024);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('"arguments":'), false);
  assert.equal(serialized.includes("parentRunId"), false);
  const graph = adaptSemanticSnapshot(projection.snapshot);
  const agentNode = graph.nodes.find((node) => node.kind === "agent" && node.sourceRef === "agent");
  assert.ok(agentNode);
  assert.deepEqual(projection.nodes.get(agentNode.id), { id: agentNode.id, kind: "agent", sourceRef: "agent" });
  assert.equal(graph.completeness.partial, true);
  assert.ok(graph.nodes.some((node) => node.kind === "tool-call"));
  assert.ok(graph.edges.some((edge) => edge.kind === "retry"));
  assert.equal(agentNode.attempts, 2); assert.equal(agentNode.failedAttempts, 1);
  assert.ok(!graph.nodes.some((node) => node.kind === "agent" && node.label.includes("attempt")), "retries are drawn on one card, never as copies");
  assert.equal(projectCurrentSemanticSnapshot({ ...context, selected: () => undefined }), undefined);
});

void test("Semantic Map parent projection bounds dense metadata and indexes at most 500 visible IDs", () => {
  const agents = Array.from({ length: 60 }, (_, index) => ({
    id: `agent-${String(index).padStart(3, "0")}`, name: "N".repeat(120), label: "L".repeat(120), state: "running", attempts: 8,
    structuralPath: Array.from({ length: 8 }, () => "P".repeat(80)),
    attemptDetails: Array.from({ length: 8 }, (_, attempt) => ({ attempt: attempt + 1, error: { code: "RETRY" } })),
    output: { status: "pending" }
  }));
  const calls = Array.from({ length: 100 }, (_, index) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `${"c".repeat(120)}-${String(index).padStart(3, "0")}`, name: `${"T".repeat(118)}${String(index % 2)}`, arguments: { secret: "not projected" } }] } }));
  const relations = Array.from({ length: 100 }, (_, index) => ({ kind: "fork" as const, fromAgentId: "agent-000", toAgentId: "agent-001", id: `relation-${String(index)}`, evidence: "recorded" as const }));
  const found = {
    publisher: { id: "pub", generation: 4, connected: true },
    target: { kind: "run" as const, publisherId: "pub", id: "run" },
    record: { run: { id: "run", workflowName: "dense", state: "running", agents, relations } }
  };
  const context = {
    state: { transcripts: { "pub\trun\tagent-000": calls } },
    selected: () => found,
    setView: () => undefined,
    staticExport: false
  } as unknown as Parameters<typeof projectCurrentSemanticSnapshot>[0];
  const projection = projectCurrentSemanticSnapshot(context);
  assert.ok(projection);
  const denseRun = projection.snapshot.run;
  assert.ok(denseRun);
  const denseAgents = denseRun.agents;
  assert.ok(denseAgents);
  assert.ok(denseAgents.length > 0 && denseAgents.length <= 16);
  assert.ok((projection.snapshot.relations?.length ?? 0) <= 8);
  assert.equal(projection.snapshot.run?.agents?.[0]?.events?.length, 48);
  assert.ok(projection.nodes.size <= 500);
  assert.equal(projection.nodeCount, projection.nodes.size);
  const graph = adaptSemanticSnapshot(projection.snapshot);
  assert.equal(graph.nodes.length, projection.nodeCount, JSON.stringify({ inputBytes: new TextEncoder().encode(JSON.stringify(projection.snapshot)).byteLength, projectedAgents: denseAgents.length, graphNodes: graph.nodes.length, nodeIndex: projection.nodeCount, partial: graph.completeness.reasons }));
  for (const node of graph.nodes) assert.deepEqual(projection.nodes.get(node.id), { id: node.id, kind: node.kind, sourceRef: node.sourceRef });
  assert.ok(new TextEncoder().encode(JSON.stringify(projection.snapshot)).byteLength <= 512 * 1024);
  assert.ok(projection.snapshot.partial?.reasons?.includes("Transcript event projection bounded"));
  assert.ok(projection.snapshot.partial?.reasons?.includes("Recorded relation list bounded"));
});

void test("repeated tool calls become one stacked card and the inspector keeps every call ID", () => {
  const call = (id: string, name: string, text = "") => ({ type: "message", message: { role: "assistant", content: [...(text ? [{ type: "text", text }] : []), { type: "toolCall", id, name, arguments: { secret: "x" } }] } });
  const result = (id: string, isError = false) => ({ type: "message", message: { role: "toolResult", toolCallId: id, isError, content: [] } });
  const transcript = [
    { type: "message", message: { role: "user", content: "go" } },
    call("r1", "read"), result("r1"), call("r2", "read"), result("r2", true), call("r3", "read"), result("r3"),
    call("l1", "ls", "now list"), result("l1"),
    call("r4", "read"), result("r4"),
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }
  ];
  const found = {
    publisher: { id: "pub", generation: 1, connected: true },
    target: { kind: "run" as const, publisherId: "pub", id: "run" },
    record: { run: { id: "run", workflowName: "grouped", state: "completed", agents: [{ id: "agent", name: "A", state: "completed", output: { status: "available" } }] } }
  };
  const context = { state: { transcripts: { "pub\trun\tagent": transcript } }, selected: () => found, setView: () => undefined, staticExport: false } as unknown as Parameters<typeof projectCurrentSemanticSnapshot>[0];
  const projection = projectCurrentSemanticSnapshot(context);
  assert.ok(projection);
  const events = projection.snapshot.run?.agents?.[0]?.events ?? [];
  assert.deepEqual(events.map((event) => [event.kind, event.name, event.count ?? 1, event.failed ?? 0]), [
    ["user", "Prompt", 1, 0], ["assistant", "Assistant", 1, 0], ["tool", "read", 3, 1], ["assistant", "Assistant", 1, 0], ["tool", "ls", 1, 0], ["assistant", "Assistant", 1, 0], ["tool", "read", 1, 0], ["assistant", "Assistant", 1, 0]
  ], "tool-only assistant turns between identical calls are folded; model text or another tool breaks the group");
  const graph = adaptSemanticSnapshot(projection.snapshot);
  const stacked = graph.nodes.find((node) => node.kind === "tool-call" && node.count === 3);
  assert.ok(stacked);
  assert.deepEqual([stacked.label, stacked.failedCount, stacked.sourceRef], ["read", 1, "agent/r1"]);
  assert.equal(graph.nodes.length, projection.nodeCount, "parent identity index mirrors grouped cards");
  assert.deepEqual(projection.nodes.get(stacked.id), { id: stacked.id, kind: "tool-call", sourceRef: "agent/r1" }, "the stacked card is addressable by its first call");
});

void test("more than 16 agents are paged; totals cover every agent on every page", () => {
  const agents = Array.from({ length: 40 }, (_, index) => ({ id: `a${String(index).padStart(2, "0")}`, name: `agent ${String(index)}`, state: index % 10 === 0 ? "failed" : "completed", attempts: index === 5 ? 3 : 1, toolCalls: [{ id: `c${String(index)}`, name: "read", state: "completed" }], accounting: { input: 10, output: 1, cacheRead: 2, cacheWrite: 0, cost: 0.01 }, output: { status: "available" } }));
  const found = { publisher: { id: "pub", generation: 1, connected: true }, target: { kind: "run" as const, publisherId: "pub", id: "run" }, record: { run: { id: "run", workflowName: "paged", state: "completed", agents } } };
  const context = { state: { transcripts: {} }, selected: () => found, setView: () => undefined, staticExport: false } as unknown as Parameters<typeof projectCurrentSemanticSnapshot>[0];
  const pages = [0, 1, 2, 9].map((page) => projectCurrentSemanticSnapshot(context, page));
  assert.deepEqual(pages.map((item) => [item?.page, item?.pages, item?.snapshot.run?.agents?.length, item?.snapshot.run?.agents?.[0]?.id]), [[0, 3, 16, "a00"], [1, 3, 16, "a16"], [2, 3, 8, "a32"], [2, 3, 8, "a32"]], "out-of-range pages clamp to the last page");
  const summary = pages[1]?.snapshot.run?.summary;
  assert.ok(summary);
  assert.deepEqual([summary.agents, summary.failed, summary.completed, summary.toolCalls, summary.retries, summary.usage?.input], [40, 4, 36, 40, 2, 400]);
  for (const item of pages) { assert.ok(item); assert.ok(item.nodes.size <= 500); const graph = adaptSemanticSnapshot(item.snapshot); assert.equal(graph.nodes.length, item.nodeCount); assert.equal(graph.summary?.agents, 40); }
  assert.ok(pages[1]?.snapshot.partial?.reasons?.includes("Agents 17–32 of 40 (page 2 of 3)"));
});
