import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { createLaunchSnapshot, inspectWorkflowScript } from "../src/index.js";
import { RunStore } from "../src/persistence.js";
import { loadSessionReport, matchSession, renderInspector, resolveSession, type InspectorViewState } from "../src/session-inspector.js";

const usage = (cost: number) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } });

function writeJsonl(path: string, rows: readonly unknown[]): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`);
}

void test("loads workflow scripts, runtime prompts, models, and costs from static artifacts", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-inspector-"));
  const cwd = join(home, "project");
  const parentPath = join(home, "parent.jsonl");
  const childPath = join(home, "child.jsonl");
  const sessionId = "019f65db-57e5-7df3-b3fb-91cbbcca948c";
  const runId = "run-a";
  const script = `const report = await agent("Inspect code", { role: "scout" });\nreturn report;`;
  writeJsonl(childPath, [
    { type: "session", version: 3, id: "child-session", timestamp: "2026-01-01T00:00:00.000Z", cwd },
    { type: "message", id: "11111111", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "Workflow: audit\nAgent: scout\n\nTask:\nInspect code", timestamp: 1 } },
    { type: "message", id: "22222222", parentId: "11111111", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-responses", provider: "openai-codex", model: "gpt-5.6-luna", usage: usage(0.25), stopReason: "stop", timestamp: 2 } },
  ]);
  writeJsonl(parentPath, [
    { type: "session", version: 3, id: sessionId, timestamp: "2026-01-01T00:00:00.000Z", cwd },
    { type: "message", id: "aaaaaaaa", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-a", name: "workflow", arguments: { name: "audit", description: "Audit code", script, foreground: true } }, { type: "toolCall", id: "call-b", name: "workflow", arguments: { name: "broken", script: "const =" } }], api: "openai-responses", provider: "openai-codex", model: "gpt-5.6-sol", usage: usage(0.1), stopReason: "toolUse", timestamp: 1 } },
    { type: "message", id: "bbbbbbbb", parentId: "aaaaaaaa", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolCallId: "call-a", toolName: "workflow", content: [{ type: "text", text: "done" }], details: { runId }, isError: false, timestamp: 2 } },
    { type: "message", id: "cccccccc", parentId: "bbbbbbbb", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "call-b", toolName: "workflow", content: [{ type: "text", text: "Invalid workflow" }], isError: true, timestamp: 3 } },
  ]);
  const store = new RunStore(cwd, sessionId, runId, home);
  await store.create({
    id: runId, workflowName: "audit", cwd, sessionId, state: "completed",
    agents: [{ id: `${runId}:1`, name: "scout", path: "scout", state: "completed", model: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" }, tools: ["read"], attempts: 1, attemptDetails: [{ attempt: 1, sessionId: "child-session", sessionFile: childPath, accounting: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.25 } }], accounting: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.25 } }],
    nativeSessions: [{ sessionId: "child-session", sessionFile: childPath }],
  }, createLaunchSnapshot({ script, args: null, metadata: { name: "audit", description: "Audit code" }, settings: { concurrency: 1, maxAgentLaunches: 1 }, models: ["openai-codex/gpt-5.6-luna"], tools: ["read"], agentTypes: ["scout"], extensions: {}, schemas: [] }));

  const report = await loadSessionReport(parentPath, home);
  assert.equal(report.cost, 0.1);
  assert.equal(report.totalCost, 0.35);
  const audit = report.workflows[0];
  assert.ok(audit);
  assert.equal(audit.script, script);
  const staticAgent = audit.calls[0];
  assert.ok(staticAgent);
  assert.equal(staticAgent.prompt, "Inspect code");
  assert.equal(staticAgent.role, "scout");
  const runtimeAgent = audit.agents[0];
  assert.ok(runtimeAgent);
  assert.equal(runtimeAgent.attempts[0]?.prompt, "Inspect code");
  const broken = report.workflows[1];
  assert.ok(broken);
  assert.equal(broken.status, "failed");
  assert.equal(broken.script, "const =");
  assert.deepEqual(broken.calls, []);
  assert.match(broken.parseError ?? "", /Invalid workflow syntax/);
  assert.deepEqual(report.totalModels.map(({ model, cost }) => [model, cost]), [["openai-codex/gpt-5.6-luna", 0.25], ["openai-codex/gpt-5.6-sol", 0.1]]);
});

void test("statically extracts agent, phase, parallel, pipeline, and checkpoint literals", () => {
  const calls = inspectWorkflowScript(`
phase("review");
await parallel("audits", { first: () => agent("Inspect API", { model: "openai/gpt", role: "scout" }) });
await pipeline("files", { api: "src/api.ts" }, { check: (file) => file });
await checkpoint({ name: "ship", prompt: "Ship it?", context: {} });
await agent(args.prompt);
  `);
  assert.deepEqual(calls.map(({ kind, name, prompt }) => ({ kind, name, prompt })), [
    { kind: "phase", name: "review", prompt: null },
    { kind: "parallel", name: "audits", prompt: null },
    { kind: "agent", name: null, prompt: "Inspect API" },
    { kind: "pipeline", name: "files", prompt: null },
    { kind: "checkpoint", name: "ship", prompt: "Ship it?" },
    { kind: "agent", name: null, prompt: null },
  ]);
  const literalAgent = calls[2];
  assert.ok(literalAgent);
  assert.equal(literalAgent.model, "openai/gpt");
  assert.equal(literalAgent.role, "scout");
});

void test("matches exact and unique partial session IDs", () => {
  const info = (id: string): SessionInfo => ({ path: `/${id}.jsonl`, id, cwd: "/repo", created: new Date(0), modified: new Date(0), messageCount: 0, firstMessage: "", allMessagesText: "" });
  const sessions = [info("abc-123"), info("abc-456")];
  assert.equal(matchSession("abc-123", sessions).id, "abc-123");
  assert.equal(matchSession("abc-4", sessions).id, "abc-456");
  assert.throws(() => matchSession("abc", sessions), /ambiguous/);
  assert.throws(() => matchSession("missing", sessions), /not found/);
});

void test("discovers sessions in PI_CODING_AGENT_SESSION_DIR", async () => {
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-workflows-custom-sessions-"));
  const id = "019f65db-57e5-7df3-b3fb-91cbbcca948c";
  writeJsonl(join(sessionDir, "custom.jsonl"), [{ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/custom" }]);
  const previous = process.env.PI_CODING_AGENT_SESSION_DIR;
  process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  try { assert.equal((await resolveSession(id)).path, join(sessionDir, "custom.jsonl")); }
  finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = previous;
  }
});

void test("renders interactive workflow, detail, and syntax-highlighted script views", () => {
  const report = {
    id: "session-a", cwd: "/repo", path: "/session.jsonl", cost: 0.1, totalCost: 0.3,
    models: [{ model: "openai/root", cost: 0.1 }], totalModels: [{ model: "openai/worker", cost: 0.2 }],
    workflows: [{ name: "audit", status: "completed", cost: 0.2, models: [{ model: "openai/worker", cost: 0.2 }], script: "return 1;", calls: [{ kind: "agent" as const, start: 0, end: 10, name: null, prompt: "Inspect code", model: "openai/worker", role: "scout" }], agents: [{ name: "scout", state: "completed", model: "openai/worker", cost: 0.2, attempts: [{ attempt: 1, prompt: "Inspect code", cost: 0.2, models: [{ model: "openai/worker", cost: 0.2 }] }] }] }],
  };
  const list: InspectorViewState = { view: "list", selected: 0, scroll: 0 };
  assert.match(renderInspector(report, list).join("\n"), /audit.*completed/);
  assert.match(renderInspector(report, { ...list, view: "detail" }).join("\n"), /agent.*prompt="Inspect code".*role=scout[\s\S]*Prompt: Inspect code/);
  assert.match(renderInspector(report, { ...list, view: "script" }, 80, 24, (script) => [`highlight:${script}`]).join("\n"), /highlight:return 1;/);
});