import assert from "node:assert/strict";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { createNativeAgentSession, FairAgentScheduler, WorkflowAgentExecutor, type AgentExecutionRoot, type AgentProgress } from "../src/agent-execution.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { WorkflowError } from "../src/index.js";
import type { RunStore } from "../src/persistence.js";

const root: AgentExecutionRoot = { cwd: "/repo", model: { provider: "openai", model: "gpt", thinking: "medium" }, availableModels: new Set(["openai/gpt", "anthropic/opus", "google/gemini"]), tools: new Set(["read", "grep", "find", "bash"]), agentDefinitions: { reviewer: { prompt: "Review carefully", model: "anthropic/opus", thinking: "high", tools: ["read"] }, scout: { prompt: "Inspect broadly", model: "google/gemini", thinking: "low", tools: ["read", "grep"] } } };
const usage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.25 } };
function assistant(text: string) { return { role: "assistant", content: [{ type: "text", text }], usage }; }

void test("resolves explicit capabilities without widening least privilege", () => {
  const executor = new WorkflowAgentExecutor(root, async () => { throw new Error("unused"); });
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", workflowDescription: "d", role: "reviewer" }), { model: { provider: "anthropic", model: "opus", thinking: "high" }, tools: ["read"], systemPromptAppend: "Review carefully" });
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", workflowDescription: "d", role: "scout" }).tools, ["read", "grep"]);
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", workflowDescription: "d", model: "google/gemini" }), { model: { provider: "google", model: "gemini", thinking: "medium" }, tools: ["read", "grep", "find", "bash"], systemPromptAppend: "" });
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", workflowDescription: "d", model: "google/gemini", tools: [] }).tools, []);
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", workflowDescription: "d", tools: ["read", "grep"] }).tools, ["read", "grep"]);
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", workflowDescription: "d", tools: ["read", "write"] }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", workflowDescription: "d", model: "missing/model" }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", workflowDescription: "d", role: "missing" }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_AGENT_TYPE");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", workflowDescription: "d", role: "reviewer", model: "google/gemini" }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", workflowDescription: "d", role: "reviewer", thinking: "low" }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", workflowDescription: "d", role: "reviewer", tools: [] }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  const broken = new WorkflowAgentExecutor({ ...root, agentDefinitions: { broken: { tools: ["write"] } } }, async () => { throw new Error("must not launch"); });
  assert.throws(() => broken.resolve({ label: "a", workflowName: "w", workflowDescription: "d", role: "broken" }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
});

void test("passes role prompt as system append, not task text", async () => {
  let input: unknown;
  let prompt = "";
  const executor = new WorkflowAgentExecutor(root, async (sessionInput) => { input = sessionInput; return { sessionId: "role", sessionFile: "/sessions/role.jsonl", messages: [assistant("done")], prompt: async (text) => { prompt = text; }, dispose() {} }; });
  await executor.execute("Do work", { label: "worker", workflowName: "flow", workflowDescription: "desc", role: "reviewer" });
  assert.equal((input as { systemPromptAppend?: string }).systemPromptAppend, "Review carefully");
  assert.deepEqual((input as { tools?: readonly string[] }).tools, ["read"]);
  assert.doesNotMatch(prompt, /Review carefully/);
  assert.doesNotMatch(prompt, /Workflow: flow - desc/);
  assert.match(prompt, /Task:\nDo work/);
});


void test("provider limits pause and retry the same native session", async () => {
  let prompts = 0;
  let pauses = 0;
  const executor = new WorkflowAgentExecutor({ ...root, providerPause: async () => { pauses += 1; } }, async () => ({ sessionId: "same", sessionFile: "/sessions/same.jsonl", messages: [assistant("continued")], prompt: async () => { prompts += 1; if (prompts === 1) throw Object.assign(new Error("limited"), { status: 429 }); }, dispose() {} }));
  assert.equal((await executor.execute("work", { label: "worker", workflowName: "flow", workflowDescription: "desc" })).value, "continued");
  assert.equal(prompts, 2);
  assert.equal(pauses, 1);
});

void test("returns final text and captures persisted native session accounting", async () => {
  const prompts: string[] = [];
  const executor = new WorkflowAgentExecutor(root, async () => ({ sessionId: "s1", sessionFile: "/sessions/s1.jsonl", messages: [assistant("done")], prompt: async (prompt) => { prompts.push(prompt); }, dispose() {} }));
  const result = await executor.execute("Do work", { label: "worker", workflowName: "flow", workflowDescription: "desc", phase: "build", parent: "root", cwd: root.cwd });
  assert.equal(result.value, "done");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0] ?? "", /Workflow: flow[\s\S]*Phase: build[\s\S]*Parent: root[\s\S]*Task:\nDo work/);
  assert.deepEqual(result.attempts[0], { attempt: 1, sessionId: "s1", sessionFile: "/sessions/s1.jsonl", result: "done", accounting: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25 } });
});

void test("exposes native attempt metadata before the prompt completes", async () => {
  let finish!: () => void;
  let promptStarted!: () => void;
  const started = new Promise<void>((resolve) => { promptStarted = resolve; });
  let exposed!: (value: { attempt: number; sessionId: string; sessionFile: string }) => void;
  const exposure = new Promise<{ attempt: number; sessionId: string; sessionFile: string }>((resolve) => { exposed = resolve; });
  const executor = new WorkflowAgentExecutor(root, async () => ({ sessionId: "active", sessionFile: "/sessions/active.jsonl", messages: [assistant("done")], prompt: () => new Promise<void>((resolve) => { finish = resolve; promptStarted(); }), dispose() {} }));
  const running = executor.execute("work", { label: "worker", workflowName: "flow", workflowDescription: "desc", onAttempt: (attempt) => { exposed(attempt); } });
  assert.deepEqual(await exposure, { attempt: 1, sessionId: "active", sessionFile: "/sessions/active.jsonl" });
  await started;
  finish();
  await running;
});

void test("streams live token and tool-call progress", async () => {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const messages = [assistant("")];
  const updates: AgentProgress[] = [];
  const executor = new WorkflowAgentExecutor(root, async () => ({
    sessionId: "progress", sessionFile: "/sessions/progress.jsonl", messages,
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    async prompt() {
      listener?.({ type: "message_update", message: messages[0], assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Checking state", partial: messages[0] } } as AgentSessionEvent);
      listener?.({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} });
      messages[0] = assistant("done");
      listener?.({ type: "message_update", message: messages[0], assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "done", partial: messages[0] } } as AgentSessionEvent);
      listener?.({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: {}, isError: false });
    },
    dispose() {},
  }));
  await executor.execute("work", { label: "worker", workflowName: "flow", workflowDescription: "desc", onProgress: (update) => { updates.push(update); } });
  assert.ok(updates.some(({ activity }) => activity?.kind === "reasoning" && activity.text === "Checking state"));
  assert.ok(updates.some(({ toolCalls, activity }) => activity?.kind === "tool" && toolCalls.some(({ name, state }) => name === "read" && state === "running")));
  assert.deepEqual(updates.at(-1), { accounting: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25 }, toolCalls: [{ id: "call-1", name: "read", state: "completed" }], activity: { kind: "text", text: "done" }, persist: true });
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
  const result = await executor.execute("structured", { label: "schema", workflowName: "flow", workflowDescription: "desc", role: "reviewer", schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false } });
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

void test("production native Pi session installs nested scheduler tools", async () => {
  const nestedTool = { name: "agent", label: "Child Agent", description: "Start child", parameters: Type.Object({}), async execute() { return { content: [{ type: "text" as const, text: "ok" }], details: {} }; } };
  const session = await createNativeAgentSession({ cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], customTools: [nestedTool], sessionLabel: "scheduler-production-seam" });
  assert.ok(session.agent?.state.tools.some(({ name }) => name === "agent"));
  session.dispose();
});

void test("executor registers the production native steering handler", async () => {
  const steered: string[] = [];
  let registered: ((message: string) => void | Promise<void>) | undefined;
  const executor = new WorkflowAgentExecutor(root, async () => ({ sessionId: "steer", sessionFile: "/sessions/steer.jsonl", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], prompt: async () => undefined, steer: async (message) => { steered.push(message); }, dispose() {} }));
  await executor.execute("work", { label: "worker", workflowName: "flow", workflowDescription: "desc" }, undefined, [], (handler) => { registered = handler; });
  assert.ok(registered);
  await registered("redirect");
  assert.deepEqual(steered, ["redirect"]);
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

void test("scheduler flush waits for terminal ownership persistence", async () => {
  let release!: () => void;
  const persisted = new Promise<void>((resolve) => { release = resolve; });
  const writes: Array<readonly unknown[]> = [];
  const scheduler = new FairAgentScheduler(async () => "done", 1, async (_run, ownership) => { await persisted; writes.push(ownership); });
  scheduler.addRun("run", 1);
  const agent = scheduler.spawn("run", "work", { label: "worker", cwd: "/repo", tools: [] });
  assert.equal((await agent.result).ok, true);
  assert.equal(writes.length, 0);
  release();
  await scheduler.flush();
  assert.equal((writes.at(-1)?.[0] as { state: string }).state, "completed");
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

void test("persisted ownership restores cancellation and scoped runtime state", async () => {
  const options = { label: "parent", cwd: "/repo", tools: ["agent"] };
  const persisted = [{ id: "run:1", label: "parent", state: "running" as const, options }, { id: "run:2", parentId: "run:1", label: "child", state: "waiting_for_child" as const, options: { ...options, label: "child" } }];
  const scheduler = new FairAgentScheduler(async () => "unused", 1);
  scheduler.restoreRun("run", 1, 10, persisted);
  assert.deepEqual(scheduler.toolsFor("run:1").map(({ name }) => name), ["agent", "get_subagent_result", "steer_subagent"]);
  scheduler.cancel("run:1");
  assert.deepEqual(scheduler.snapshot().map(({ state }) => state), ["cancelled", "cancelled"]);
});
void test("cold replacement does not consume restored logical agent slots", async () => {
  const scheduler = new FairAgentScheduler(async () => "replacement", 1);
  scheduler.restoreRun("run", 1, 1, [{ id: "run:1", label: "restored", state: "running", options: { label: "restored", cwd: "/repo", tools: [] } }]);
  await scheduler.cancelRun("run");
  const replacement = scheduler.spawn("run", "replacement", { label: "replacement", cwd: "/repo", tools: [] });
  assert.deepEqual(await replacement.result, { id: replacement.id, ok: true, value: "replacement" });
});

void test("scoped tools honor the root capability boundary and cancel orphan descendants", async () => {
  let scheduler: FairAgentScheduler;
  let orphanId = "";
  // eslint-disable-next-line prefer-const
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

void test("nested agent roles resolve tools before scheduler spawn", async () => {
  const scheduler = new FairAgentScheduler(async ({ signal }) => {
    await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
    throw new WorkflowError("CANCELLED", "cancelled");
  }, 1);
  scheduler.addRun("run", 1);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: ["agent", "read", "bash"] });
  const agentTool = scheduler.toolsFor(parent.id, (role, tools) => role === "reviewer" && tools === undefined ? ["read"] : tools ?? ["bash"])[0];
  assert.ok(agentTool);
  await agentTool.execute("call", { prompt: "child", label: "child", role: "reviewer" }, undefined, undefined, {} as never);
  assert.deepEqual(scheduler.snapshot().find(({ options }) => options.label === "child")?.options.tools, ["read"]);
  scheduler.cancel(parent.id);
  await parent.result;
});

void test("explicit null timeout remains unlimited", async () => {
  const executor = new WorkflowAgentExecutor(root, async () => ({ sessionId: "unlimited", sessionFile: "/sessions/unlimited.jsonl", messages: [assistant("done")], prompt: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }, dispose() {} }));
  assert.equal((await executor.execute("work", { label: "worker", workflowName: "flow", workflowDescription: "desc", timeoutMs: null })).value, "done");
});

void test("cancelRun waits for active agents to terminate", async () => {
  let terminated = false;
  const scheduler = new FairAgentScheduler(async ({ signal }) => {
    await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { setTimeout(() => { terminated = true; resolve(); }, 20); }, { once: true }); });
    throw new WorkflowError("CANCELLED", "cancelled");
  }, 1);
  scheduler.addRun("run", 1);
  const agent = scheduler.spawn("run", "active", { label: "active", cwd: "/repo", tools: [] });
  await Promise.resolve();
  await scheduler.cancelRun("run");
  assert.equal(terminated, true);
  assert.equal((await agent.result).ok, false);
});
