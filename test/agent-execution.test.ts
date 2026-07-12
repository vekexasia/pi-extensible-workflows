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

void test("scoped tools reject sibling access and parent completion cancels orphan descendants", async () => {
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
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: ["read"] });
  await parent.result;
  await Promise.resolve();
  assert.equal(scheduler.snapshot().find(({ id }) => id === orphanId)?.state, "cancelled");
  const outsider = scheduler.spawn("run", "outsider", { label: "outsider", cwd: "/repo", tools: ["read"] });
  const resultTool = scheduler.toolsFor(outsider.id)[1];
  assert.ok(resultTool);
  await assert.rejects(resultTool.execute("x", { id: orphanId }, undefined, undefined, {} as never), /direct children/);
  scheduler.cancel(outsider.id);
  await outsider.result;
});
