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
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-inspector-"));
  const cwd = join(home, "project");
  const parentPath = join(home, "parent.jsonl");
  const childPath = join(home, "child.jsonl");
  const sessionId = "019f65db-57e5-7df3-b3fb-91cbbcca948c";
  const runId = "run-a";
  const script = `const report = await agent("Inspect code", { role: "scout" });\nreturn report;`;
  writeJsonl(childPath, [
    { type: "session", version: 3, id: "child-session", timestamp: "2026-01-01T00:00:00.000Z", cwd },
    { type: "model_change", id: "model-change", parentId: null, timestamp: "2026-01-01T00:00:00.500Z", provider: "openai-codex", modelId: "gpt-5.6-luna" },
    { type: "thinking_level_change", id: "thinking-change", parentId: "model-change", timestamp: "2026-01-01T00:00:00.750Z", thinkingLevel: "high" },
    { type: "message", id: "11111111", parentId: "thinking-change", timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "Workflow: audit\nAgent: scout\n\nTask:\nInspect code", timestamp: 1 } },
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
    agents: [{ id: `${runId}:1`, name: "scout", path: "scout", state: "completed", role: "scout", model: { provider: "openai-codex", model: "gpt-5.6-luna", thinking: "high" }, tools: ["read"], attempts: 1, attemptDetails: [{ attempt: 1, sessionId: "child-session", sessionFile: childPath, accounting: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.25 } }], accounting: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.25 } }],
    nativeSessions: [{ sessionId: "child-session", sessionFile: childPath }],
  }, createLaunchSnapshot({ script, args: null, metadata: { name: "audit", description: "Audit code" }, settings: { concurrency: 1, maxAgentLaunches: 1 }, models: ["openai-codex/gpt-5.6-luna"], tools: ["read"], agentTypes: ["scout"], schemas: [] }));

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
  const runtimeAttempt = runtimeAgent.attempts[0];
  assert.ok(runtimeAttempt);
  assert.equal(runtimeAttempt.prompt, "Inspect code");
  assert.equal(runtimeAttempt.model, "openai-codex/gpt-5.6-luna");
  assert.equal(runtimeAttempt.thinking, "high");
  assert.equal(runtimeAgent.role, "scout");
  const broken = report.workflows[1];
  assert.ok(broken);
  assert.equal(broken.status, "failed");
  assert.equal(broken.script, "const =");
  assert.deepEqual(broken.calls, []);
  assert.match(broken.parseError ?? "", /Invalid workflow syntax/);
  assert.deepEqual(report.totalModels.map(({ model, cost }) => [model, cost]), [["openai-codex/gpt-5.6-luna", 0.25], ["openai-codex/gpt-5.6-sol", 0.1]]);
});

void test("reports transcript policy per attempt and persisted fallback policy", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-inspector-policy-"));
  const cwd = join(home, "project");
  const parentPath = join(home, "parent.jsonl");
  const attemptOnePath = join(home, "attempt-one.jsonl");
  const attemptTwoPath = join(home, "attempt-two.jsonl");
  const missingPath = join(home, "missing.jsonl");
  const corruptPath = join(home, "corrupt.jsonl");
  const sessionId = "session-policy";
  const runId = "run-policy";
  const script = `const result = await agent("Inspect", { role: "shared" });\nreturn result;`;
  const session = (id: string) => ({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd });
  const policy = (id: string, provider: string, model: string, thinking: string) => [
    { type: "model_change", id: `${id}-model`, parentId: null, timestamp: "2026-01-01T00:00:00.100Z", provider, modelId: model },
    { type: "thinking_level_change", id: `${id}-thinking`, parentId: null, timestamp: "2026-01-01T00:00:00.200Z", thinkingLevel: thinking },
  ];
  const assistant = (id: string, provider: string, model: string, cost: number) => ({ type: "message", id, parentId: null, timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-responses", provider, model, usage: usage(cost), stopReason: "stop", timestamp: 2 } });
  const account = (cost: number) => ({ input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost });
  writeJsonl(attemptOnePath, [session("attempt-one"), ...policy("one", "provider-a", "model-a", "low"), { type: "message", id: "one-user", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "Retry one", timestamp: 1 } }, assistant("one-a", "provider-a", "model-a", 0.1), ...policy("two", "provider-b", "model-b", "high"), assistant("one-b", "provider-b", "model-b", 0.2)]);
  writeJsonl(attemptTwoPath, [session("attempt-two"), ...policy("three", "provider-c", "model-c", "medium"), { type: "message", id: "two-user", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "Retry two", timestamp: 1 } }, assistant("two-c", "provider-c", "model-c", 0.3)]);
  writeFileSync(corruptPath, "not json\n");
  writeJsonl(parentPath, [session(sessionId), { type: "message", id: "parent-assistant", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-policy", name: "workflow", arguments: { name: "policy", script, foreground: true } }], api: "openai-responses", provider: "provider-root", model: "model-root", usage: usage(0.05), stopReason: "toolUse", timestamp: 1 } }, { type: "message", id: "parent-result", parentId: "parent-assistant", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "toolResult", toolCallId: "call-policy", toolName: "workflow", content: [{ type: "text", text: "done" }], details: { runId }, isError: false, timestamp: 2 } }]);
  const store = new RunStore(cwd, sessionId, runId, home);
  await store.create({ id: runId, workflowName: "policy", cwd, sessionId, state: "completed", agents: [
    { id: `${runId}:1`, name: "top-label", path: "top", state: "completed", role: "shared", model: { provider: "persisted", model: "fallback", thinking: "max" }, tools: [], attempts: 2, attemptDetails: [{ attempt: 1, sessionId: "attempt-one", sessionFile: attemptOnePath, accounting: account(0.3), error: { code: "AGENT_FAILED", message: "retry" } }, { attempt: 2, sessionId: "attempt-two", sessionFile: attemptTwoPath, accounting: account(0.3) }], accounting: account(0.3) },
    { id: `${runId}:2`, name: "nested-label", path: "nested", parentId: `${runId}:1`, state: "completed", role: "shared", model: { provider: "persisted", model: "nested-fallback", thinking: "medium" }, tools: [], attempts: 1, attemptDetails: [{ attempt: 1, sessionId: "missing", sessionFile: missingPath, accounting: account(0.4) }], accounting: account(0.4) },
    { id: `${runId}:3`, name: "corrupt-label", path: "corrupt", state: "failed", model: { provider: "persisted", model: "corrupt-fallback", thinking: "low" }, tools: [], attempts: 1, attemptDetails: [{ attempt: 1, sessionId: "corrupt", sessionFile: corruptPath, accounting: account(0.5) }], accounting: account(0.5) },
    { id: `${runId}:4`, name: "default-label", path: "default", state: "completed", model: { provider: "persisted", model: "default-fallback", thinking: "off" }, tools: [], attempts: 0, accounting: account(0.6) },
  ], nativeSessions: [] }, createLaunchSnapshot({ script, args: null, metadata: { name: "policy" }, settings: { concurrency: 1, maxAgentLaunches: 4 }, models: ["persisted/fallback", "persisted/nested-fallback", "persisted/corrupt-fallback", "persisted/default-fallback"], tools: [], agentTypes: ["shared"], roles: {}, schemas: [] }));
  const report = await loadSessionReport(parentPath, home);
  const workflow = report.workflows[0];
  assert.ok(workflow);
  assert.deepEqual(workflow.agents.map(({ name, role }) => ({ name, role })), [{ name: "top-label", role: "shared" }, { name: "nested-label", role: "shared" }, { name: "corrupt-label", role: undefined }, { name: "default-label", role: undefined }]);
  const retry = workflow.agents[0];
  assert.ok(retry);
  assert.deepEqual(retry.attempts.map(({ attempt, model, thinking, cost, models }) => ({ attempt, model, thinking, cost, models })), [{ attempt: 1, model: "provider-b/model-b", thinking: "high", cost: 0.30000000000000004, models: [{ model: "provider-a/model-a", cost: 0.1 }, { model: "provider-b/model-b", cost: 0.2 }] }, { attempt: 2, model: "provider-c/model-c", thinking: "medium", cost: 0.3, models: [{ model: "provider-c/model-c", cost: 0.3 }] }]);
  assert.equal(retry.model, "provider-c/model-c");
  assert.equal(retry.thinking, "medium");
  assert.ok(Math.abs(retry.cost - 0.6) < 1e-9);
  const nested = workflow.agents[1];
  const corrupt = workflow.agents[2];
  const defaultAgent = workflow.agents[3];
  assert.ok(nested);
  assert.ok(corrupt);
  assert.ok(defaultAgent);
  const nestedAttempt = nested.attempts[0];
  const corruptAttempt = corrupt.attempts[0];
  const defaultAttempt = defaultAgent.attempts[0];
  assert.ok(nestedAttempt);
  assert.ok(corruptAttempt);
  assert.ok(defaultAttempt);
  assert.equal(nestedAttempt.model, "persisted/nested-fallback");
  assert.equal(nestedAttempt.thinking, "medium");
  assert.equal(corruptAttempt.model, "persisted/corrupt-fallback");
  assert.equal(corruptAttempt.thinking, "low");
  assert.equal(defaultAttempt.model, "persisted/default-fallback");
  assert.equal(defaultAttempt.thinking, "off");
  assert.equal(nestedAttempt.cost, 0.4);
  assert.equal(corruptAttempt.cost, 0.5);
  assert.equal(defaultAttempt.cost, 0.6);
  assert.deepEqual(workflow.models.map(({ model, cost }) => [model, cost]), [["persisted/default-fallback", 0.6], ["persisted/corrupt-fallback", 0.5], ["persisted/nested-fallback", 0.4], ["provider-c/model-c", 0.3], ["provider-b/model-b", 0.2], ["provider-a/model-a", 0.1]]);
  assert.deepEqual(report.totalModels.map(({ model, cost }) => [model, cost]), [["persisted/default-fallback", 0.6], ["persisted/corrupt-fallback", 0.5], ["persisted/nested-fallback", 0.4], ["provider-c/model-c", 0.3], ["provider-b/model-b", 0.2], ["provider-a/model-a", 0.1], ["provider-root/model-root", 0.05]]);
  assert.equal(report.cost, 0.05);
  assert.ok(Math.abs(report.totalCost - 2.15) < 1e-9);
});

void test("statically extracts agent, phase, parallel, pipeline, checkpoint, and withWorktree literals", () => {
  const calls = inspectWorkflowScript(`
phase("review");
await parallel("audits", { first: () => agent("Inspect API", { model: "openai/gpt", role: "scout" }) });
await pipeline("files", { api: "src/api.ts" }, { check: (file) => file });
await checkpoint({ name: "ship", prompt: "Ship it?", context: {} });
await agent(args.prompt);
await withWorktree("shared", async () => agent("scoped"));
  `);
  assert.deepEqual(calls.map(({ kind, name, prompt }) => ({ kind, name, prompt })), [
    { kind: "phase", name: "review", prompt: null },
    { kind: "parallel", name: "audits", prompt: null },
    { kind: "agent", name: null, prompt: "Inspect API" },
    { kind: "pipeline", name: "files", prompt: null },
    { kind: "checkpoint", name: "ship", prompt: "Ship it?" },
    { kind: "agent", name: null, prompt: null },
    { kind: "withWorktree", name: "shared", prompt: null },
    { kind: "agent", name: null, prompt: "scoped" },
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
  const sessionDir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-custom-sessions-"));
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
    workflows: [{ name: "audit", status: "completed", cost: 0.2, models: [{ model: "openai/worker", cost: 0.2 }], script: "return 1;", calls: [{ kind: "agent" as const, start: 0, end: 10, name: null, prompt: "Inspect code", model: "openai/worker", role: "scout" }], agents: [{ name: "scout", state: "completed", role: "scout", model: "openai/worker", thinking: "high" as const, cost: 0.2, attempts: [{ attempt: 1, prompt: "Inspect code", model: "openai/worker", thinking: "high" as const, cost: 0.2, models: [{ model: "openai/worker", cost: 0.2 }] }] }] }],
  };
  const list: InspectorViewState = { view: "list", selected: 0, scroll: 0 };
  assert.match(renderInspector(report, list).join("\n"), /audit.*completed/);
  assert.match(renderInspector(report, { ...list, view: "detail" }).join("\n"), /agent[\s\S]*role=scout[\s\S]*openai\/worker:high[\s\S]*Attempt 1 · openai\/worker:high[\s\S]*Prompt: Inspect code/);
  assert.match(renderInspector(report, { ...list, view: "script" }, 80, 24, (script) => [`highlight:${script}`]).join("\n"), /highlight:return 1;/);
});