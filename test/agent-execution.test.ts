import assert from "node:assert/strict";
import test from "node:test";
import { WorkflowAgentExecutor, type AgentExecutionRoot } from "../src/agent-execution.js";
import { WorkflowError } from "../src/index.js";
import type { RunStore } from "../src/persistence.js";

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
  const result = await executor.execute("Do work", { label: "worker", workflowName: "flow", workflowDescription: "desc", phase: "build", parent: "root", cwd: root.cwd });
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

void test("top-level worktree cwd is inherited and reused by retries", async () => {
  const cwds: string[] = [];
  const snapshots: string[] = [];
  const isolatedRoot = { ...root, runStore: { worktree: async () => ({ owner: "worker", path: "/runs/worktree", branch: "pi-workflows/run/key", cwd: "/runs/worktree/subdir" }), validateWorktree: async () => ({ owner: "worker", path: "/runs/worktree", branch: "pi-workflows/run/key", cwd: "/runs/worktree/subdir" }), snapshotWorktree: async (owner: string) => { snapshots.push(owner); return "commit"; } } as unknown as RunStore };
  let attempt = 0;
  const executor = new WorkflowAgentExecutor(isolatedRoot, async (input) => {
    cwds.push(input.cwd);
    const current = ++attempt;
    return { sessionId: `s${String(current)}`, sessionFile: `/sessions/s${String(current)}.jsonl`, messages: [assistant("ok")], async prompt() { if (current === 1) throw new Error("retry"); }, dispose() {} };
  });
  const result = await executor.execute("isolated", { label: "worker", workflowName: "flow", workflowDescription: "desc", isolation: "worktree", retries: 1 });
  assert.deepEqual(cwds, ["/runs/worktree/subdir", "/runs/worktree/subdir"]);
  assert.deepEqual(snapshots, ["worker", "worker"]);
  assert.equal(result.cwd, "/runs/worktree/subdir");
  await executor.execute("child", { label: "child", workflowName: "flow", workflowDescription: "desc", parent: "worker", parentIsolation: "worktree", cwd: result.cwd });
  assert.equal(cwds.at(-1), result.cwd);
  await assert.rejects(executor.execute("child", { label: "child", workflowName: "flow", workflowDescription: "desc", parent: "worker", isolation: "worktree" }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});

void test("concurrent siblings keep their own cwd and non-isolated top-level calls use root cwd", async () => {
  const cwds: Record<string, string> = {};
  const isolatedRoot = { ...root, runStore: { worktree: async (owner: string) => ({ owner, path: `/runs/${owner}`, branch: `branch/${owner}`, cwd: `/runs/${owner}/repo` }), validateWorktree: async (owner: string, cwd: string) => ({ owner, path: `/runs/${owner}`, branch: `branch/${owner}`, cwd }), snapshotWorktree: async () => "commit" } as unknown as RunStore };
  const executor = new WorkflowAgentExecutor(isolatedRoot, async (input) => ({ sessionId: input.sessionLabel, sessionFile: `/sessions/${input.sessionLabel}.jsonl`, messages: [assistant("ok")], async prompt() { cwds[input.sessionLabel] = input.cwd; await Promise.resolve(); }, dispose() {} }));
  const [left, right] = await Promise.all([
    executor.execute("left", { label: "left", workflowName: "flow", workflowDescription: "desc", isolation: "worktree" }),
    executor.execute("right", { label: "right", workflowName: "flow", workflowDescription: "desc", isolation: "worktree" }),
  ]);
  await Promise.all([
    executor.execute("left child", { label: "child-left", workflowName: "flow", workflowDescription: "desc", parent: "left", parentIsolation: "worktree", cwd: left.cwd }),
    executor.execute("right child", { label: "child-right", workflowName: "flow", workflowDescription: "desc", parent: "right", parentIsolation: "worktree", cwd: right.cwd }),
  ]);
  const plain = await executor.execute("plain", { label: "plain", workflowName: "flow", workflowDescription: "desc" });
  assert.equal(cwds["flow:left:attempt-1"], "/runs/left/repo");
  assert.equal(cwds["flow:right:attempt-1"], "/runs/right/repo");
  assert.equal(cwds["flow:child-left:attempt-1"], left.cwd);
  assert.equal(cwds["flow:child-right:attempt-1"], right.cwd);
  assert.equal(plain.cwd, root.cwd);
});

void test("rejects arbitrary child cwd before launching a session", async () => {
  const executor = new WorkflowAgentExecutor(root, async () => { throw new Error("must not launch"); });
  await assert.rejects(executor.execute("child", { label: "child", workflowName: "flow", workflowDescription: "desc", parent: "root", cwd: "/tmp/arbitrary" }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});

void test("stale isolated parent cwd fails before launching a session", async () => {
  const isolatedRoot = { ...root, runStore: { validateWorktree: async () => { throw new WorkflowError("WORKTREE_FAILED", "stale"); } } as unknown as RunStore };
  const executor = new WorkflowAgentExecutor(isolatedRoot, async () => { throw new Error("must not launch"); });
  await assert.rejects(executor.execute("child", { label: "child", workflowName: "flow", workflowDescription: "desc", parent: "worker", parentIsolation: "worktree", cwd: "/runs/stale" }), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
});

void test("worktree isolation without persisted ownership fails without launching a session", async () => {
  const executor = new WorkflowAgentExecutor(root, async () => { throw new Error("must not launch"); });
  await assert.rejects(executor.execute("isolated", { label: "worker", workflowName: "flow", workflowDescription: "desc", isolation: "worktree" }), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
});

void test("snapshot failures stay WORKTREE_FAILED without a second snapshot", async () => {
  let snapshots = 0;
  const isolatedRoot = { ...root, runStore: { worktree: async () => ({ owner: "worker", path: "/runs/worker", branch: "branch/worker", cwd: "/runs/worker/repo" }), snapshotWorktree: async () => { snapshots += 1; throw new WorkflowError("WORKTREE_FAILED", "snapshot failed"); } } as unknown as RunStore };
  const executor = new WorkflowAgentExecutor(isolatedRoot, async () => ({ sessionId: "s", sessionFile: "/sessions/s.jsonl", messages: [assistant("ok")], async prompt() {}, dispose() {} }));
  await assert.rejects(executor.execute("isolated", { label: "worker", workflowName: "flow", workflowDescription: "desc", isolation: "worktree" }), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED" && error.message === "snapshot failed");
  assert.equal(snapshots, 1);
});

void test("failed best-effort snapshots do not mask agent failures", async () => {
  const isolatedRoot = { ...root, runStore: { worktree: async () => ({ owner: "worker", path: "/runs/worker", branch: "branch/worker", cwd: "/runs/worker/repo" }), snapshotWorktree: async () => { throw new WorkflowError("WORKTREE_FAILED", "snapshot failed"); } } as unknown as RunStore };
  const executor = new WorkflowAgentExecutor(isolatedRoot, async () => ({ sessionId: "s", sessionFile: "/sessions/s.jsonl", messages: [assistant("bad")], async prompt() { throw new Error("agent failed"); }, dispose() {} }));
  await assert.rejects(executor.execute("isolated", { label: "worker", workflowName: "flow", workflowDescription: "desc", isolation: "worktree" }), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === "agent failed");
});

void test("per-attempt timeout is typed and terminal", async () => {
  const executor = new WorkflowAgentExecutor(root, async () => ({ sessionId: "slow", sessionFile: "/sessions/slow.jsonl", messages: [], prompt: () => new Promise(() => {}), dispose() {} }));
  await assert.rejects(executor.execute("slow", { label: "slow", workflowName: "flow", workflowDescription: "desc", timeoutMs: 10 }), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_TIMEOUT" && Array.isArray((error as WorkflowError & { attempts: unknown[] }).attempts));
});
