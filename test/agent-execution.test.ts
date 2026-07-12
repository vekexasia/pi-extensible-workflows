import assert from "node:assert/strict";
import test from "node:test";
import { FairAgentScheduler, WorkflowAgentExecutor, type AgentExecutionRoot } from "../src/agent-execution.js";
import { WorkflowError } from "../src/index.js";

const root: AgentExecutionRoot = { cwd: "/repo", model: { provider: "openai", model: "gpt", thinking: "medium" }, tools: new Set(["read", "bash"]), agentDefinitions: { reviewer: { prompt: "Review carefully", tools: ["read"] } } };
const usage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.25 } };
function assistant(text: string) { return { role: "assistant", content: [{ type: "text", text }], usage }; }

void test("resolves root-bounded definitions and model specs", () => {
  const executor = new WorkflowAgentExecutor(root, async () => { throw new Error("unused"); });
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", workflowDescription: "d", agentType: "reviewer", model: "anthropic/opus:high" }), { model: { provider: "anthropic", model: "opus", thinking: "high" }, tools: ["read"], rolePrompt: "Review carefully" });
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", workflowDescription: "d", tools: ["write"] }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", workflowDescription: "d", agentType: "missing" }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_AGENT_TYPE");
});

void test("returns final text and captures persisted native session accounting", async () => {
  const prompts: string[] = [];
  const executor = new WorkflowAgentExecutor(root, async () => ({ sessionId: "s1", sessionFile: "/sessions/s1.jsonl", messages: [assistant("done")], prompt: async (prompt) => { prompts.push(prompt); }, dispose() {} }));
  const result = await executor.execute("Do work", { label: "worker", workflowName: "flow", workflowDescription: "desc", phase: "build", parent: "root" });
  assert.equal(result.value, "done");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /Workflow: flow - desc[\s\S]*Phase: build[\s\S]*Parent: root[\s\S]*Task:\nDo work/);
  assert.deepEqual(result.attempts[0], { attempt: 1, sessionId: "s1", sessionFile: "/sessions/s1.jsonl", result: "done", accounting: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25 } });
});

void test("keeps workflow_result present, delays acceptance, and allows one repair", async () => {
  const responses: Array<unknown> = [{ answer: 7 }, { wrong: true }, { answer: 9 }];
  const calls: Array<{ prompt: string; result: unknown }> = [];
  const executor = new WorkflowAgentExecutor(root, async ({ resultTool }) => {
    assert.ok(resultTool);
    return { sessionId: "schema", sessionFile: "/sessions/schema.jsonl", messages: [assistant("ignored")], async prompt(prompt) {
      const result = responses.shift();
      if (result !== undefined) { calls.push({ prompt, result }); await resultTool.execute("id", result, new AbortController().signal, () => {}, {} as never); }
    }, dispose() {} };
  });
  const result = await executor.execute("structured", { label: "schema", workflowName: "flow", workflowDescription: "desc", schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false } });
  assert.deepEqual(result.value, { answer: 9 });
  assert.equal(calls.length, 3);
  assert.match(calls[1]?.prompt ?? "", /Submit the final result/);
  assert.match(calls[2]?.prompt ?? "", /Repair/);
});

void test("retries in fresh persisted sessions and reports terminal attempt history", async () => {
  let created = 0;
  const executor = new WorkflowAgentExecutor(root, async () => {
    const attempt = ++created;
    return { sessionId: `s${String(attempt)}`, sessionFile: `/sessions/s${String(attempt)}.jsonl`, messages: [assistant(attempt === 2 ? "ok" : "bad")], async prompt() { if (attempt === 1) throw new Error("provider failed"); }, dispose() {} };
  });
  const result = await executor.execute("retry", { label: "retry", workflowName: "flow", workflowDescription: "desc", retries: 1 });
  assert.equal(result.value, "ok");
  assert.deepEqual(result.attempts.map(({ sessionId }) => sessionId), ["s1", "s2"]);
  assert.equal(result.attempts[0]?.error?.code, "AGENT_FAILED");
});

void test("per-attempt timeout is typed and terminal", async () => {
  const executor = new WorkflowAgentExecutor(root, async () => ({ sessionId: "slow", sessionFile: "/sessions/slow.jsonl", messages: [], prompt: () => new Promise(() => {}), dispose() {} }));
  await assert.rejects(executor.execute("slow", { label: "slow", workflowName: "flow", workflowDescription: "desc", timeoutMs: 10 }), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_TIMEOUT" && Array.isArray((error as WorkflowError & { attempts: unknown[] }).attempts));
});

void test("fair scheduler enforces session/run ceilings and round-robins runs", async () => {
  const order: string[] = [];
  const releases: Array<() => void> = [];
  const scheduler = new FairAgentScheduler(async ({ prompt }) => { order.push(prompt); await new Promise<void>((resolve) => releases.push(resolve)); return prompt; }, 1);
  scheduler.addRun("a", 1);
  scheduler.addRun("b", 1);
  const a1 = scheduler.spawn("a", "a1", { label: "a1", cwd: "/repo", tools: ["read"] });
  const a2 = scheduler.spawn("a", "a2", { label: "a2", cwd: "/repo", tools: ["read"] });
  const b1 = scheduler.spawn("b", "b1", { label: "b1", cwd: "/repo", tools: ["read"] });
  await Promise.resolve();
  assert.deepEqual(order, ["a1"]);
  releases.shift()?.(); await a1.result; await Promise.resolve();
  assert.deepEqual(order, ["a1", "b1"]);
  releases.shift()?.(); await b1.result; await Promise.resolve();
  assert.deepEqual(order, ["a1", "b1", "a2"]);
  releases.shift()?.(); await a2.result;
});

void test("cancelling a queued agent releases its eventual permit so later work starts", async () => {
  const started: string[] = [];
  let release!: () => void;
  const scheduler = new FairAgentScheduler(async ({ prompt }) => { started.push(prompt); if (prompt === "r1") await new Promise<void>((resolve) => { release = resolve; }); return prompt; }, 1);
  scheduler.addRun("r", 1);
  const r1 = scheduler.spawn("r", "r1", { label: "r1", cwd: "/repo", tools: [] });
  const r2 = scheduler.spawn("r", "r2", { label: "r2", cwd: "/repo", tools: [] });
  const r3 = scheduler.spawn("r", "r3", { label: "r3", cwd: "/repo", tools: [] });
  scheduler.cancel(r2.id);
  release();
  await r1.result;
  assert.equal((await r2.result).ok, false);
  assert.equal((await r3.result).ok, true);
  assert.deepEqual(started, ["r1", "r3"]);
});

void test("writes each ownership-tree transition to persistence", async () => {
  const writes: Array<readonly unknown[]> = [];
  const scheduler = new FairAgentScheduler(async () => "done", 1, (_run, ownership) => { writes.push(structuredClone(ownership)); });
  scheduler.addRun("r", 1);
  const child = scheduler.spawn("r", "work", { label: "worker", cwd: "/repo", tools: [] });
  await child.result;
  await scheduler.flush();
  assert.equal(writes.at(-1)?.[0] && (writes.at(-1)?.[0] as { state: string }).state, "completed");
  assert.equal((writes.at(-1)?.[0] as { label: string }).label, "worker");
});

void test("nested ownership releases permits, contains child failure, and blocks escalation", async () => {
  let scheduler: FairAgentScheduler;
  // eslint-disable-next-line prefer-const
  scheduler = new FairAgentScheduler(async ({ id, prompt, options }) => {
    if (prompt === "parent") {
      assert.throws(() => scheduler.spawn("run", "bad", { label: "bad", cwd: options.cwd, tools: ["bash"] }, id), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
      const child = scheduler.spawn("run", "child", { label: "child", cwd: options.cwd, tools: options.tools }, id);
      return scheduler.result(id, child.id);
    }
    throw new WorkflowError("AGENT_FAILED", "child failed");
  }, 1);
  scheduler.addRun("run", 1, 2);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: ["read"] });
  const result = await parent.result;
  assert.equal(result.ok, true);
  assert.deepEqual((result as { ok: true; value: unknown }).value, { id: "run:2", ok: false, error: { code: "AGENT_FAILED", message: "child failed" } });
  assert.deepEqual(scheduler.snapshot().map(({ state }) => state), ["completed", "failed"]);
  assert.throws(() => scheduler.spawn("run", "extra", { label: "extra", cwd: "/repo", tools: ["read"] }), (error: unknown) => error instanceof WorkflowError && error.code === "RUN_LIMIT_EXCEEDED");
});

void test("cancelling a parent waiting for a child releases its reacquired permit", async () => {
  let scheduler: FairAgentScheduler;
  let childStarted!: () => void;
  const started = new Promise<void>((resolve) => { childStarted = resolve; });
  // eslint-disable-next-line prefer-const
  scheduler = new FairAgentScheduler(async ({ id, prompt, options, signal }) => {
    if (prompt === "parent") {
      const child = scheduler.spawn("run", "child", { label: "child", cwd: options.cwd, tools: [] }, id);
      return scheduler.result(id, child.id);
    }
    if (prompt === "child") {
      childStarted();
      await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
      throw new WorkflowError("CANCELLED", "cancelled");
    }
    return "later completed";
  }, 1);
  scheduler.addRun("run", 1);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: [] });
  await started;
  scheduler.cancel(parent.id);
  assert.equal((await parent.result).ok, false);
  const later = scheduler.spawn("run", "later", { label: "later", cwd: "/repo", tools: [] });
  assert.deepEqual(await later.result, { id: later.id, ok: true, value: "later completed" });
  assert.deepEqual(scheduler.snapshot().map(({ state }) => state), ["cancelled", "cancelled", "completed"]);
});

void test("scoped tools honor the root capability boundary and cancel orphan descendants", async () => {
  let scheduler: FairAgentScheduler;
  let orphanId = "";
  // eslint-disable-next-line prefer-const, @typescript-eslint/unbound-method
  scheduler = new FairAgentScheduler(async ({ id, prompt, signal, setSteer, options }) => {
    if (prompt === "parent") {
      const orphan = scheduler.spawn("run", "orphan", { label: "orphan", cwd: options.cwd, tools: options.tools }, id);
      orphanId = orphan.id;
      return "done";
    }
    setSteer(() => {});
    await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
    throw new WorkflowError("CANCELLED", "cancelled");
  }, 2);
  scheduler.addRun("run", 2);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: ["agent"] });
  await parent.result;
  await Promise.resolve();
  assert.equal(scheduler.snapshot().find(({ id }) => id === orphanId)?.state, "cancelled");
  const denied = scheduler.spawn("run", "denied", { label: "denied", cwd: "/repo", tools: ["read"] });
  assert.deepEqual(scheduler.toolsFor(denied.id), []);
  scheduler.cancel(denied.id);
  await denied.result;
  const outsider = scheduler.spawn("run", "outsider", { label: "outsider", cwd: "/repo", tools: ["agent"] });
  const scopedTools = scheduler.toolsFor(outsider.id);
  assert.deepEqual(scopedTools.map(({ name }) => name), ["agent", "get_subagent_result", "steer_subagent"]);
  const resultTool = scopedTools[1];
  assert.ok(resultTool);
  await assert.rejects(resultTool.execute("x", { id: orphanId }, undefined, undefined, {} as never), /direct children/);
  scheduler.cancel(outsider.id);
  await outsider.result;
});
