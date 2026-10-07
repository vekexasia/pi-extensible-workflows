import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DEFAULT_MAX_BYTES } from "@earendil-works/pi-coding-agent";
import { completionDelivery, completionDeliveryFromStore } from "../src/host-delivery.js";
import { createLaunchSnapshot, DEFAULT_SETTINGS, RunStore } from "../src/index.js";

const context = (tokens: number | null, contextWindow = 100_000) => ({
  getContextUsage: () => ({ tokens, contextWindow }),
  model: { contextWindow, maxTokens: 1_000 },
});

void test("completion delivery shares inline and descriptor policy", () => {
  const value = { answer: "😀" } as const;
  const options = { name: "review", runId: "run-1", value, resultPath: "/tmp/run-1/result.json", resultBytes: 32, worktrees: [], context: context(0) };
  assert.deepEqual(completionDelivery({ ...options, mode: "foreground" }), { content: JSON.stringify(value), inlined: true });
  assert.deepEqual(completionDelivery({ ...options, mode: "background" }), { content: `Workflow review completed: ${JSON.stringify(value)}`, inlined: true });
  assert.equal(completionDelivery({ ...options, mode: "foreground", resultBytes: DEFAULT_MAX_BYTES }).inlined, true);

  const fallback = completionDelivery({ ...options, mode: "foreground", resultBytes: DEFAULT_MAX_BYTES + 1 });
  assert.deepEqual(JSON.parse(fallback.content), { state: "completed", runId: "run-1", resultPath: "/tmp/run-1/result.json", resultBytes: DEFAULT_MAX_BYTES + 1, inlined: false });
  assert.equal(fallback.inlined, false);
  assert.equal(completionDelivery({ ...options, mode: "background", context: context(null) }).inlined, false);
  const contextFallback = completionDelivery({ ...options, mode: "foreground", context: context(99_000) });
  assert.deepEqual(JSON.parse(contextFallback.content), { state: "completed", runId: "run-1", resultPath: "/tmp/run-1/result.json", resultBytes: 32, inlined: false });
});

void test("completion fit reads active context and model values", () => {
  let tokens = 0;
  let contextWindow = 100_000;
  const options = { mode: "background" as const, name: "review", runId: "run-1", value: { answer: true }, resultPath: "/tmp/run-1/result.json", resultBytes: 32, worktrees: [], context: { getContextUsage: () => ({ tokens, contextWindow }), getModel: () => ({ contextWindow, maxTokens: 1_000 }) } };
  assert.equal(completionDelivery(options).inlined, true);
  tokens = 99_000;
  assert.equal(completionDelivery(options).inlined, false);
  tokens = 0;
  contextWindow = 500;
  assert.equal(completionDelivery(options).inlined, false);
});

void test("completion delivery bounds the complete background message", () => {
  const value = { answer: "x".repeat(DEFAULT_MAX_BYTES) };
  const result = completionDelivery({ mode: "background", name: "review", runId: "run-1", value, resultPath: "/tmp/run-1/result.json", resultBytes: DEFAULT_MAX_BYTES, worktrees: [], context: context(0) });
  assert.equal(result.inlined, false);
  assert.deepEqual(JSON.parse(result.content), { state: "completed", runId: "run-1", resultPath: "/tmp/run-1/result.json", resultBytes: DEFAULT_MAX_BYTES, inlined: false });
  assert.doesNotMatch(result.content, /x{100}/);
});

void test("completion delivery falls back when worktree inspection fails", async () => {
  const result = await completionDeliveryFromStore({ mode: "background", name: "review", runId: "run-1", value: { answer: true }, resultPath: "/tmp/run-1/result.json", resultBytes: 32, context: context(0), store: { changedWorktrees: async () => { throw new Error("worktree unavailable"); } } });
  assert.deepEqual(JSON.parse(result.content), { state: "completed", runId: "run-1", resultPath: "/tmp/run-1/result.json", resultBytes: 32, inlined: false });
  assert.equal(result.inlined, false);
});

void test("RunStore persists pretty UTF-8 result bytes", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-completion-artifact-"));
  const store = new RunStore(home, "session", "run", home);
  await store.create({ id: "run", workflowName: "artifact", cwd: home, sessionId: "session", state: "running", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "artifact" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [] }));
  const path = await store.saveResult({ answer: "😀" });
  assert.equal(await readFile(path, "utf8"), '{\n  "answer": "😀"\n}\n');
  assert.equal(await store.resultBytes(), Buffer.byteLength('{\n  "answer": "😀"\n}\n', "utf8"));
});
