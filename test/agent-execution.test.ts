import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowAgentExecutor, type AgentExecutionRoot } from "../src/agent-execution.js";
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
