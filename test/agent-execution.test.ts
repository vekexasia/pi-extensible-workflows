import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import { createNativeAgentSession, FairAgentScheduler, WorkflowAgentExecutor, type AgentExecutionRoot, type AgentProgress, type SessionFactory } from "../src/agent-execution.js";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { WorkflowError } from "../src/index.js";
import type { RunStore } from "../src/persistence.js";

const root: AgentExecutionRoot = { cwd: "/repo", model: { provider: "openai", model: "gpt", thinking: "medium" }, availableModels: new Set(["openai/gpt", "anthropic/opus", "google/gemini"]), tools: new Set(["read", "grep", "find", "bash"]), agentDefinitions: { reviewer: { prompt: "Review carefully", model: "anthropic/opus", thinking: "high", tools: ["read"] }, scout: { prompt: "Inspect broadly", model: "google/gemini", thinking: "low", tools: ["read", "grep"] } } };
const usage = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.25 } };
function assistant(text: string) { return { role: "assistant", content: [{ type: "text", text }], usage }; }
function terminalAssistant(errorMessage: string) { return { ...assistant(""), stopReason: "error", errorMessage }; }
function sessionStats(cost = usage.cost.total) { return { tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite }, cost }; }

void test("resolves explicit capabilities without widening least privilege", () => {
  const executor = new WorkflowAgentExecutor(root, async () => { throw new Error("unused"); });
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", role: "reviewer" }), { model: { provider: "anthropic", model: "opus", thinking: "high" }, tools: ["read"], systemPromptAppend: "Review carefully" });
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", role: "scout" }).tools, ["read", "grep"]);
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", model: "google/gemini" }), { model: { provider: "google", model: "gemini", thinking: "medium" }, tools: ["read", "grep", "find", "bash"], systemPromptAppend: "" });
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", model: "google/gemini", tools: [] }).tools, []);
  assert.deepEqual(executor.resolve({ label: "a", workflowName: "w", tools: ["read", "grep"] }).tools, ["read", "grep"]);
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", tools: ["read", "write"] }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", model: "missing/model" }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", role: "missing" }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_AGENT_TYPE");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", role: "reviewer", model: "google/gemini" }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", role: "reviewer", thinking: "low" }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => executor.resolve({ label: "a", workflowName: "w", role: "reviewer", tools: [] }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  const broken = new WorkflowAgentExecutor({ ...root, agentDefinitions: { broken: { tools: ["write"] } } }, async () => { throw new Error("must not launch"); });
  assert.throws(() => broken.resolve({ label: "a", workflowName: "w", role: "broken" }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
});

void test("passes role prompt as system append, not task text", async () => {
  let input: unknown;
  let prompt = "";
  const executor = new WorkflowAgentExecutor(root, async (sessionInput) => { input = sessionInput; return { sessionId: "role", sessionFile: "/sessions/role.jsonl", messages: [assistant("done")], getSessionStats: sessionStats, prompt: async (text) => { prompt = text; }, dispose() {} }; });
  await executor.execute("Do work", { label: "worker", workflowName: "flow", role: "reviewer", effectiveTools: ["read", "grep"] });
  assert.equal((input as { systemPromptAppend?: string }).systemPromptAppend, "Review carefully");
  assert.deepEqual((input as { tools?: readonly string[] }).tools, ["read"]);
  assert.doesNotMatch(prompt, /Review carefully/);
  assert.match(prompt, /Task:\nDo work/);
});

void test("persists the effective role system prompt emitted for the native turn", async () => {
  const saved: Array<{ sessionId: string; attempt: number; turn: number; prompt: string }> = [];
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const runStore = { recordSystemPrompt: async (entry: (typeof saved)[number]) => { saved.push(entry); } } as unknown as RunStore;
  const executor = new WorkflowAgentExecutor({ ...root, runStore }, async (input) => ({
    sessionId: "role", sessionFile: "/sessions/role.jsonl", messages: [assistant("done")], getSessionStats: sessionStats,
    systemPrompt: `BASE\n\n${input.systemPromptAppend ?? ""}`,
    subscribe(candidate) { listener = candidate; return () => {}; },
    async prompt() { listener?.({ type: "agent_start" }); },
    dispose() {},
  }));
  await executor.execute("Do work", { label: "worker", workflowName: "flow", role: "reviewer" });
  assert.deepEqual(saved, [{ sessionId: "role", attempt: 1, turn: 1, prompt: "BASE\n\nReview carefully" }]);
});

void test("does not mask agent failures when system prompt persistence also fails", async () => {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const runStore = { recordSystemPrompt: async () => { throw new Error("disk full"); } } as unknown as RunStore;
  const executor = new WorkflowAgentExecutor({ ...root, runStore }, async () => ({
    sessionId: "failed", sessionFile: "/sessions/failed.jsonl", messages: [], getSessionStats: sessionStats, systemPrompt: "effective",
    subscribe(candidate) { listener = candidate; return () => {}; },
    async prompt() { listener?.({ type: "agent_start" }); throw new Error("provider failed"); },
    dispose() {},
  }));
  await assert.rejects(executor.execute("Do work", { label: "worker", workflowName: "flow" }), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === "provider failed");
});


void test("runs prioritized setup hooks with fresh retry baselines and safe attempt summaries", async () => {
  const order: string[] = [];
  const inputs: Array<{ prompt: string; options: Record<string, unknown>; tools: readonly string[]; cwd: string }> = [];
  const hooks = [
    { name: "z-last", priority: 10, async setup(agent: { prompt: string; options: Record<string, unknown>; sessionInput: { tools: readonly string[]; cwd: string } }, context: { attempt: number }) { order.push(`${String(context.attempt)}:z-last`); agent.prompt += " z"; agent.sessionInput.tools = ["bash"]; } },
    { name: "a-first", priority: 10, setup(agent: { prompt: string; options: Record<string, unknown>; sessionInput: { tools: readonly string[]; cwd: string } }, context: { attempt: number }) { order.push(`${String(context.attempt)}:a-first`); assert.equal(Object.hasOwn(agent.options, "transient"), false); agent.prompt += " a"; agent.options.transient = context.attempt === 1 ? "discard" : "fresh"; agent.sessionInput.tools = ["grep"]; agent.sessionInput.cwd = "/hooked"; } },
    { name: "early", priority: 1, setup(agent: { prompt: string; options: Record<string, unknown>; sessionInput: { tools: readonly string[]; cwd: string } }, context: { attempt: number }) { order.push(`${String(context.attempt)}:early`); agent.options.seen = true; } },
  ];
  let created = 0;
  const executor = new WorkflowAgentExecutor({ ...root, agentSetupHooks: hooks }, async (input) => {
    inputs.push({ prompt: input.options?.transient === "fresh" ? "fresh" : "baseline", options: input.options ?? {}, tools: input.tools, cwd: input.cwd });
    const attempt = ++created;
    return { sessionId: `hook-${String(attempt)}`, sessionFile: `/sessions/hook-${String(attempt)}.jsonl`, messages: [assistant("done")], getSessionStats: sessionStats, async prompt(text) { if (attempt === 1) throw new Error(text); }, dispose() {} };
  });
  const result = await executor.execute("original", { label: "hooked", workflowName: "flow", retries: 1, timeoutMs: 5, agentOptions: { advisor: true } });
  assert.equal(result.value, "done");
  assert.deepEqual(order, ["1:early", "1:a-first", "1:z-last", "2:early", "2:a-first", "2:z-last"]);
  assert.deepEqual(inputs.map(({ tools, cwd }) => ({ tools, cwd })), [{ tools: ["bash"], cwd: "/hooked" }, { tools: ["bash"], cwd: "/hooked" }]);
  assert.deepEqual(result.attempts.map(({ setup }) => setup?.hookNames), [["early", "a-first", "z-last"], ["early", "a-first", "z-last"]]);
  assert.equal(result.attempts[1]?.setup?.model.provider, "openai");
});

void test("provider limits pause and retry the same native session", async () => {
  let prompts = 0;
  let pauses = 0;
  const executor = new WorkflowAgentExecutor({ ...root, providerPause: async () => { pauses += 1; } }, async () => ({ sessionId: "same", sessionFile: "/sessions/same.jsonl", messages: [assistant("continued")], getSessionStats: sessionStats, prompt: async () => { prompts += 1; if (prompts === 1) throw Object.assign(new Error("limited"), { status: 429 }); }, dispose() {} }));
  assert.equal((await executor.execute("work", { label: "worker", workflowName: "flow" })).value, "continued");
  assert.equal(prompts, 2);
  assert.equal(pauses, 1);
});

void test("returns final text and captures persisted native session accounting", async () => {
  const prompts: string[] = [];
  const executor = new WorkflowAgentExecutor(root, async () => ({ sessionId: "s1", sessionFile: "/sessions/s1.jsonl", messages: [assistant("done")], getSessionStats: sessionStats, prompt: async (prompt) => { prompts.push(prompt); }, dispose() {} }));
  const result = await executor.execute("Do work", { label: "worker", workflowName: "flow", phase: "build", parent: "root", cwd: root.cwd });
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
  const executor = new WorkflowAgentExecutor(root, async () => ({ sessionId: "active", sessionFile: "/sessions/active.jsonl", messages: [assistant("done")], getSessionStats: sessionStats, prompt: () => new Promise<void>((resolve) => { finish = resolve; promptStarted(); }), dispose() {} }));
  const running = executor.execute("work", { label: "worker", workflowName: "flow", onAttempt: (attempt) => { exposed(attempt); } });
  assert.deepEqual(await exposure, { attempt: 1, sessionId: "active", sessionFile: "/sessions/active.jsonl" });
  await started;
  finish();
  await running;
});

void test("streams non-content and tool-call progress", async () => {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const messages = [assistant("")];
  const updates: AgentProgress[] = [];
  const executor = new WorkflowAgentExecutor(root, async () => ({
    sessionId: "progress", sessionFile: "/sessions/progress.jsonl", messages, getSessionStats: sessionStats,
    subscribe(next) { listener = next; return () => { listener = undefined; }; },
    async prompt() {
      listener?.({ type: "message_start", message: messages[0] } as AgentSessionEvent);
      listener?.({ type: "message_update", message: messages[0], assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: messages[0] } } as AgentSessionEvent);
      listener?.({ type: "message_update", message: messages[0], assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "REASONING_ONE", partial: messages[0] } } as AgentSessionEvent);
      listener?.({ type: "message_update", message: messages[0], assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "REASONING_TWO", partial: messages[0] } } as AgentSessionEvent);
      listener?.({ type: "tool_execution_start", toolCallId: "call-1", toolName: "read", args: {} });
      messages[0] = assistant("done");
      listener?.({ type: "message_update", message: messages[0], assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: messages[0] } } as AgentSessionEvent);
      listener?.({ type: "message_update", message: messages[0], assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "RESPONSE_ONE", partial: messages[0] } } as AgentSessionEvent);
      listener?.({ type: "message_update", message: messages[0], assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "RESPONSE_TWO", partial: messages[0] } } as AgentSessionEvent);
      listener?.({ type: "tool_execution_end", toolCallId: "call-1", toolName: "read", result: {}, isError: false });
      listener?.({ type: "message_end", message: messages[0] } as AgentSessionEvent);
    },
    dispose() {},
  }));
  const result = await executor.execute("work", { label: "worker", workflowName: "flow", onProgress: (update) => { updates.push(update); } });
  assert.equal(result.value, "done");
  assert.equal(updates.length, 6);
  assert.doesNotMatch(JSON.stringify(updates), /REASONING_ONE|REASONING_TWO|RESPONSE_ONE|RESPONSE_TWO/);
  assert.ok(updates.some(({ activity }) => activity?.kind === "text" && activity.text === "responding"));
  assert.ok(updates.some(({ toolCalls, activity }) => activity?.kind === "tool" && toolCalls.some(({ name, state }) => name === "read" && state === "running")));
  assert.deepEqual(updates.at(-1), { accounting: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25 }, toolCalls: [{ id: "call-1", name: "read", state: "completed" }], persist: true });
});
void test("uses cumulative session stats after compaction for progress, budget, and attempts", async () => {
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  const updates: AgentProgress[] = [];
  const budgetAccounting: AgentProgress["accounting"][] = [];
  const activeMessages = [assistant("compacted response")];
  const cumulative = { tokens: { input: 100, output: 50, cacheRead: 25, cacheWrite: 10, total: 185 }, cost: 9 };
  const executor = new WorkflowAgentExecutor(root, async () => ({
    sessionId: "compaction-safe", sessionFile: "/sessions/compaction-safe.jsonl", messages: activeMessages, getSessionStats: () => cumulative,
    subscribe(next) { listener = next; return () => {}; },
    async prompt() {
      listener?.({ type: "message_start", message: activeMessages[0] } as AgentSessionEvent);
      listener?.({ type: "message_end", message: activeMessages[0] } as AgentSessionEvent);
    },
    dispose() {},
  }));
  const budget = { beforeAttempt() {}, beforeTurn() {}, afterTurn(accounting: AgentProgress["accounting"]) { budgetAccounting.push(accounting); }, instruction() { return undefined; } };
  const result = await executor.execute("work", { label: "worker", workflowName: "flow", onProgress: (update) => { updates.push(update); }, budget });
  const expected = { input: 100, output: 50, cacheRead: 25, cacheWrite: 10, cost: 9 };
  assert.ok(updates.some(({ accounting }) => JSON.stringify(accounting) === JSON.stringify(expected)));
  assert.ok(budgetAccounting.length > 0 && budgetAccounting.every((accounting) => JSON.stringify(accounting) === JSON.stringify(expected)));
  assert.deepEqual(result.attempts[0]?.accounting, expected);
});

void test("keeps workflow_result present, delays acceptance, and allows one repair", async () => {
  const responses: Array<unknown> = [{ answer: 7 }, { wrong: true }, { answer: 9 }];
  const calls: Array<{ prompt: string; result: unknown }> = [];
  const executor = new WorkflowAgentExecutor(root, async ({ resultTool }) => {
    assert.ok(resultTool);
    return { sessionId: "schema", sessionFile: "/sessions/schema.jsonl", messages: [assistant("ignored")], getSessionStats: sessionStats, async prompt(prompt) {
      const result = responses.shift();
      if (result !== undefined) { calls.push({ prompt, result }); await resultTool.execute("id", result, new AbortController().signal, () => {}, {} as never); }
    }, dispose() {} };
  });
  const result = await executor.execute("structured", { label: "schema", workflowName: "flow", role: "reviewer", schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false } });
  assert.deepEqual(result.value, { answer: 9 });
  assert.equal(calls.length, 3);
  assert.match(calls[1]?.prompt ?? "", /Submit the final result/);
  assert.match(calls[2]?.prompt ?? "", /Repair/);
});

void test("fails native terminal provider errors before structured finalization", async () => {
  const errorMessage = "OAuth refresh failed for anthropic";
  const messages = [terminalAssistant(errorMessage)];
  const prompts: string[] = [];
  const executor = new WorkflowAgentExecutor(root, async () => ({ sessionId: "terminal", sessionFile: "/sessions/terminal.jsonl", messages, getSessionStats: sessionStats, async prompt(prompt) { prompts.push(prompt); }, dispose() {} }));
  let attempts: readonly { sessionFile: string; error?: { code: string; message: string } }[] | undefined;
  await assert.rejects(executor.execute("structured", { label: "schema", workflowName: "flow", schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false } }), (error: unknown) => {
    if (!(error instanceof WorkflowError)) return false;
    attempts = (error as WorkflowError & { attempts?: typeof attempts }).attempts;
    return error.code === "AGENT_FAILED" && error.message === errorMessage;
  });
  assert.equal(prompts.length, 1);
  assert.equal(attempts?.[0]?.sessionFile, "/sessions/terminal.jsonl");
  const failedAttempt = attempts[0];
  assert.ok(failedAttempt);
  assert.deepEqual(failedAttempt.error, { code: "AGENT_FAILED", message: errorMessage });
});
void test("falls back when a terminal provider error omits errorMessage", async () => {
  const messages = [{ ...assistant(""), stopReason: "error" }];
  const executor = new WorkflowAgentExecutor(root, async () => ({ sessionId: "terminal-without-message", sessionFile: "/sessions/terminal-without-message.jsonl", messages, getSessionStats: sessionStats, async prompt() {}, dispose() {} }));
  let attempts: readonly { error?: { code: string; message: string } }[] | undefined;
  await assert.rejects(executor.execute("work", { label: "worker", workflowName: "flow" }), (error: unknown) => {
    if (!(error instanceof WorkflowError)) return false;
    attempts = (error as WorkflowError & { attempts?: typeof attempts }).attempts;
    return error.code === "AGENT_FAILED" && error.message === "Native Pi assistant ended with a terminal provider error";
  });
  assert.deepEqual(attempts?.[0]?.error, { code: "AGENT_FAILED", message: "Native Pi assistant ended with a terminal provider error" });
});

void test("fails terminal provider errors during finalization without repair", async () => {
  const errorMessage = "OAuth refresh failed during finalization";
  const messages = [assistant("ready")];
  const prompts: string[] = [];
  let promptCount = 0;
  const executor = new WorkflowAgentExecutor(root, async () => ({ sessionId: "finalization-terminal", sessionFile: "/sessions/finalization-terminal.jsonl", messages, getSessionStats: sessionStats, async prompt(prompt) { prompts.push(prompt); promptCount += 1; if (promptCount === 2) messages.push(terminalAssistant(errorMessage)); }, dispose() {} }));
  await assert.rejects(executor.execute("structured", { label: "schema", workflowName: "flow", schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false } }), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === errorMessage);
  assert.equal(prompts.length, 2);
  assert.match(prompts[1] ?? "", /Submit the final result/);
  assert.doesNotMatch(prompts.join("\n"), /Repair/);
});

void test("retries native terminal errors as fresh workflow attempts", async () => {
  const errorMessage = "OAuth refresh failed for retry";
  const promptsByAttempt: string[][] = [];
  let created = 0;
  const executor = new WorkflowAgentExecutor(root, async ({ resultTool }) => {
    const attempt = ++created;
    const prompts: string[] = [];
    promptsByAttempt.push(prompts);
    const messages = attempt === 1 ? [terminalAssistant(errorMessage)] : [assistant("ready")];
    return { sessionId: `terminal-retry-${String(attempt)}`, sessionFile: `/sessions/terminal-retry-${String(attempt)}.jsonl`, messages, getSessionStats: sessionStats, async prompt(prompt) { prompts.push(prompt); if (attempt === 2 && prompt.includes("Submit the final result")) { assert.ok(resultTool); await resultTool.execute("id", { answer: 42 }, new AbortController().signal, () => {}, {} as never); } }, dispose() {} };
  });
  const result = await executor.execute("structured", { label: "schema", workflowName: "flow", retries: 1, schema: { type: "object", properties: { answer: { type: "number" } }, required: ["answer"], additionalProperties: false } });
  assert.deepEqual(result.value, { answer: 42 });
  assert.deepEqual(promptsByAttempt.map((prompts) => prompts.length), [1, 2]);
  assert.deepEqual(result.attempts.map(({ sessionId }) => sessionId), ["terminal-retry-1", "terminal-retry-2"]);
  assert.deepEqual(result.attempts[0]?.error, { code: "AGENT_FAILED", message: errorMessage });
  assert.deepEqual(result.attempts[1]?.result, { answer: 42 });
});

void test("retries in fresh persisted sessions and reports terminal attempt history", async () => {
  let created = 0;
  const executor = new WorkflowAgentExecutor(root, async () => {
    const attempt = ++created;
    return { sessionId: `s${String(attempt)}`, sessionFile: `/sessions/s${String(attempt)}.jsonl`, messages: [assistant(attempt === 2 ? "ok" : "bad")], getSessionStats: sessionStats, async prompt() { if (attempt === 1) throw new Error("provider failed"); }, dispose() {} };
  });
  const result = await executor.execute("retry", { label: "retry", workflowName: "flow", retries: 1 });
  assert.equal(result.value, "ok");
  assert.deepEqual(result.attempts.map(({ sessionId }) => sessionId), ["s1", "s2"]);
  assert.equal(result.attempts[0]?.error?.code, "AGENT_FAILED");
});

void test("top-level worktree cwd is inherited and reused by retries", async () => {
  const cwds: string[] = [];
  const snapshots: string[] = [];
  const worktreeRoot = { ...root, runStore: { worktree: async () => ({ owner: "worker", path: "/runs/worktree", branch: "pi-extensible-workflows/run/key", cwd: "/runs/worktree/subdir" }), validateWorktree: async () => ({ owner: "worker", path: "/runs/worktree", branch: "pi-extensible-workflows/run/key", cwd: "/runs/worktree/subdir" }), snapshotWorktree: async (owner: string) => { snapshots.push(owner); return "commit"; } } as unknown as RunStore };
  let attempt = 0;
  const executor = new WorkflowAgentExecutor(worktreeRoot, async (input) => {
    cwds.push(input.cwd);
    const current = ++attempt;
    return { sessionId: `s${String(current)}`, sessionFile: `/sessions/s${String(current)}.jsonl`, messages: [assistant("ok")], getSessionStats: sessionStats, async prompt() { if (current === 1) throw new Error("retry"); }, dispose() {} };
  });
  const result = await executor.execute("worktree", { label: "worker", workflowName: "flow", worktreeOwner: "worker", retries: 1 });
  assert.deepEqual(cwds, ["/runs/worktree/subdir", "/runs/worktree/subdir"]);
  assert.deepEqual(snapshots, ["worker", "worker"]);
  assert.equal(result.cwd, "/runs/worktree/subdir");
  await executor.execute("child", { label: "child", workflowName: "flow", parent: "worker", worktreeOwner: "worker", cwd: result.cwd });
  assert.equal(cwds.at(-1), result.cwd);
});


void test("concurrent siblings keep their own cwd and plain top-level calls use root cwd", async () => {
  const cwds: Record<string, string> = {};
  const worktreeRoot = { ...root, runStore: { worktree: async (owner: string) => ({ owner, path: `/runs/${owner}`, branch: `branch/${owner}`, cwd: `/runs/${owner}/repo` }), validateWorktree: async (owner: string, cwd: string) => ({ owner, path: `/runs/${owner}`, branch: `branch/${owner}`, cwd }), snapshotWorktree: async () => "commit" } as unknown as RunStore };
  const executor = new WorkflowAgentExecutor(worktreeRoot, async (input) => ({ sessionId: input.sessionLabel, sessionFile: `/sessions/${input.sessionLabel}.jsonl`, messages: [assistant("ok")], getSessionStats: sessionStats, async prompt() { cwds[input.sessionLabel] = input.cwd; await Promise.resolve(); }, dispose() {} }));
  const [left, right] = await Promise.all([
    executor.execute("left", { label: "left", workflowName: "flow", worktreeOwner: "left" }),
    executor.execute("right", { label: "right", workflowName: "flow", worktreeOwner: "right" }),
  ]);
  await Promise.all([
    executor.execute("left child", { label: "child-left", workflowName: "flow", parent: "left", worktreeOwner: "left", cwd: left.cwd }),
    executor.execute("right child", { label: "child-right", workflowName: "flow", parent: "right", worktreeOwner: "right", cwd: right.cwd }),
  ]);
  const plain = await executor.execute("plain", { label: "plain", workflowName: "flow" });
  assert.equal(cwds["flow:left:attempt-1"], "/runs/left/repo");
  assert.equal(cwds["flow:right:attempt-1"], "/runs/right/repo");
  assert.equal(cwds["flow:child-left:attempt-1"], left.cwd);
  assert.equal(cwds["flow:child-right:attempt-1"], right.cwd);
  assert.equal(plain.cwd, root.cwd);
});

void test("rejects arbitrary child cwd before launching a session", async () => {
  const executor = new WorkflowAgentExecutor(root, async () => { throw new Error("must not launch"); });
  await assert.rejects(executor.execute("child", { label: "child", workflowName: "flow", parent: "root", cwd: "/tmp/arbitrary" }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});

void test("stale worktree parent cwd fails before launching a session", async () => {
  const worktreeRoot = { ...root, runStore: { validateWorktree: async () => { throw new WorkflowError("WORKTREE_FAILED", "stale"); } } as unknown as RunStore };
  const executor = new WorkflowAgentExecutor(worktreeRoot, async () => { throw new Error("must not launch"); });
  await assert.rejects(executor.execute("child", { label: "child", workflowName: "flow", parent: "worker", worktreeOwner: "worker", cwd: "/runs/stale" }), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
});

void test("worktree scope without persisted ownership fails without launching a session", async () => {
  const executor = new WorkflowAgentExecutor(root, async () => { throw new Error("must not launch"); });
  await assert.rejects(executor.execute("worktree", { label: "worker", workflowName: "flow", worktreeOwner: "worker" }), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
});

void test("snapshot failures stay WORKTREE_FAILED without a second snapshot", async () => {
  let snapshots = 0;
  const worktreeRoot = { ...root, runStore: { worktree: async () => ({ owner: "worker", path: "/runs/worker", branch: "branch/worker", cwd: "/runs/worker/repo" }), snapshotWorktree: async () => { snapshots += 1; throw new WorkflowError("WORKTREE_FAILED", "snapshot failed"); } } as unknown as RunStore };
  const executor = new WorkflowAgentExecutor(worktreeRoot, async () => ({ sessionId: "s", sessionFile: "/sessions/s.jsonl", messages: [assistant("ok")], getSessionStats: sessionStats, async prompt() {}, dispose() {} }));
  await assert.rejects(executor.execute("worktree", { label: "worker", workflowName: "flow", worktreeOwner: "worker" }), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED" && error.message === "snapshot failed");
  assert.equal(snapshots, 1);
});

void test("failed best-effort snapshots do not mask agent failures", async () => {
  const worktreeRoot = { ...root, runStore: { worktree: async () => ({ owner: "worker", path: "/runs/worker", branch: "branch/worker", cwd: "/runs/worker/repo" }), snapshotWorktree: async () => { throw new WorkflowError("WORKTREE_FAILED", "snapshot failed"); } } as unknown as RunStore };
  const executor = new WorkflowAgentExecutor(worktreeRoot, async () => ({ sessionId: "s", sessionFile: "/sessions/s.jsonl", messages: [assistant("bad")], getSessionStats: sessionStats, async prompt() { throw new Error("agent failed"); }, dispose() {} }));
  await assert.rejects(executor.execute("worktree", { label: "worker", workflowName: "flow", worktreeOwner: "worker" }), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === "agent failed");
});

void test("per-attempt timeout is typed and terminal", async () => {
  const executor = new WorkflowAgentExecutor(root, async () => ({ sessionId: "slow", sessionFile: "/sessions/slow.jsonl", messages: [], getSessionStats: sessionStats, prompt: () => new Promise(() => {}), dispose() {} }));
  await assert.rejects(executor.execute("slow", { label: "slow", workflowName: "flow", timeoutMs: 10 }), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_TIMEOUT" && Array.isArray((error as WorkflowError & { attempts: unknown[] }).attempts));
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
  const executor = new WorkflowAgentExecutor(root, async () => ({ sessionId: "steer", sessionFile: "/sessions/steer.jsonl", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: sessionStats, prompt: async () => undefined, steer: async (message) => { steered.push(message); }, dispose() {} }));
  await executor.execute("work", { label: "worker", workflowName: "flow" }, undefined, [], (handler) => { registered = handler; });
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
  scheduler.addRun("run", 1);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: ["read"] });
  const result = await parent.result;
  assert.equal(result.ok, true);
  assert.deepEqual((result as { ok: true; value: unknown }).value, { id: "run:2", ok: false, error: { code: "AGENT_FAILED", message: "child failed" } });
  assert.deepEqual(scheduler.snapshot().map(({ state }) => state), ["completed", "failed"]);
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
  scheduler.restoreRun("run", 1, persisted);
  assert.deepEqual(scheduler.toolsFor("run:1").map(({ name }) => name), ["agent", "get_subagent_result", "steer_subagent"]);
  scheduler.cancel("run:1");
  assert.deepEqual(scheduler.snapshot().map(({ state }) => state), ["cancelled", "cancelled"]);
});
void test("cold replacement does not consume restored logical agent slots", async () => {
  const scheduler = new FairAgentScheduler(async () => "replacement", 1);
  scheduler.restoreRun("run", 1, [{ id: "run:1", label: "restored", state: "running", options: { label: "restored", cwd: "/repo", tools: [] } }]);
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

void test("nested role policy conflicts fail before scheduler spawn", async () => {
  const scheduler = new FairAgentScheduler(async ({ signal }) => {
    await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
    throw new WorkflowError("CANCELLED", "cancelled");
  }, 1);
  scheduler.addRun("run", 1);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: ["agent", "read"] });
  const agentTool = scheduler.toolsFor(parent.id)[0];
  assert.ok(agentTool);
  for (const extra of [{ model: "openai/gpt" }, { thinking: "low" }, { tools: ["read"] }]) {
    await assert.rejects(agentTool.execute("call", { prompt: "child", label: "child", role: "reviewer", ...extra }, undefined, undefined, {} as never), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  }
  assert.equal(scheduler.snapshot().length, 1);
  scheduler.cancel(parent.id);
  await parent.result;
});
void test("child tool validates raw input and preserves extension options", async () => {
  const scheduler = new FairAgentScheduler(async () => "done", 1);
  scheduler.addRun("run", 1);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: ["agent", "read"] });
  const agentTool = scheduler.toolsFor(parent.id)[0];
  assert.ok(agentTool);
  for (const params of [{ prompt: "child", label: "child", thinking: "invalid" }, { prompt: "child", label: "child", providerOptions: () => undefined }]) {
    await assert.rejects(agentTool.execute("call", params, undefined, undefined, {} as never), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  }
  assert.equal(scheduler.snapshot().length, 1);
  const response = await agentTool.execute("call", { prompt: "child", label: "child", providerOptions: { temperature: 0.2 }, timeoutMs: null }, undefined, undefined, {} as never);
  const childId = (response.details as { id: string }).id;
  const child = scheduler.snapshot().find(({ id }) => id === childId);
  assert.deepEqual(child?.options.agentOptions, { label: "child", providerOptions: { temperature: 0.2 }, timeoutMs: null });
  scheduler.cancel(parent.id);
  await parent.result;
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
  await agentTool.execute("call", { prompt: "child", label: "child", role: "reviewer", retries: 1, timeoutMs: null }, undefined, undefined, {} as never);
  assert.deepEqual(scheduler.snapshot().find(({ options }) => options.label === "child")?.options.tools, ["read"]);
  scheduler.cancel(parent.id);
  await parent.result;
});

void test("explicit null timeout remains unlimited", async () => {
  const executor = new WorkflowAgentExecutor(root, async () => ({ sessionId: "unlimited", sessionFile: "/sessions/unlimited.jsonl", messages: [assistant("done")], getSessionStats: sessionStats, prompt: async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }, dispose() {} }));
  assert.equal((await executor.execute("work", { label: "worker", workflowName: "flow", timeoutMs: null })).value, "done");
});

void test("setup hook errors stop later hooks and session creation", async () => {
  let later = false;
  let launched = false;
  const executor = new WorkflowAgentExecutor({ ...root, agentSetupHooks: [
    { name: "fails", priority: 1, setup() { throw new Error("hook failed"); } },
    { name: "later", priority: 2, setup() { later = true; } },
  ] }, async () => { launched = true; throw new Error("must not launch"); });
  await assert.rejects(executor.execute("work", { label: "worker", workflowName: "flow", retries: 3 }), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === "hook failed");
  assert.equal(later, false);
  assert.equal(launched, false);
});

void test("setup cancellation prevents native session creation", async () => {
  const controller = new AbortController();
  let launched = false;
  const executor = new WorkflowAgentExecutor({ ...root, agentSetupHooks: [{ name: "cancel", priority: 10, setup() { controller.abort(); } }] }, async () => { launched = true; throw new Error("must not launch"); });
  await assert.rejects(executor.execute("work", { label: "worker", workflowName: "flow" }, controller.signal), (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  assert.equal(launched, false);
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
void test("refreshes resource exclusions for every fresh attempt and inspects the effective policy", async () => {
  let policyCalls = 0;
  let sessions = 0;
  const inputs: Array<NonNullable<Parameters<SessionFactory>[0]["resourcePolicy"]>> = [];
  const executor = new WorkflowAgentExecutor({ ...root, agentResourcePolicy: () => {
    policyCalls += 1;
    const skill = `skill-${String(policyCalls)}`;
    const extension = `/extensions/extension-${String(policyCalls)}.ts`;
    return { globalSettingsPath: "/global/settings.json", projectSettingsPath: "/project/settings.json", projectTrusted: true, global: { skills: [], extensions: [] }, project: { skills: [], extensions: [] }, effective: { skills: [skill], extensions: [extension] }, unmatchedSkills: [skill], unmatchedExtensions: [extension] };
  } }, async (input) => {
    assert.ok(input.resourcePolicy);
    inputs.push(input.resourcePolicy);
    sessions += 1;
    return { sessionId: `policy-${String(sessions)}`, sessionFile: `/sessions/policy-${String(sessions)}.jsonl`, messages: [assistant("done")], getSessionStats: sessionStats, async prompt() { if (sessions === 1) throw new Error("retry"); }, dispose() {} };
  });
  const result = await executor.execute("work", { label: "worker", workflowName: "flow", retries: 1 });
  assert.equal(result.value, "done");
  assert.equal(policyCalls, 2);
  assert.deepEqual(inputs.map(({ effective }) => effective), [{ skills: ["skill-1"], extensions: ["/extensions/extension-1.ts"] }, { skills: ["skill-2"], extensions: ["/extensions/extension-2.ts"] }]);
  assert.deepEqual(result.attempts.map(({ setup }) => setup?.disabledAgentResources?.skills), [["skill-1"], ["skill-2"]]);
});
void test("isolates role resource exclusions and reapplies them on retries", async () => {
  const roleExtension = "/role/extension.ts";
  const basePolicy = { globalSettingsPath: "/global/settings.json", projectSettingsPath: "/project/settings.json", projectTrusted: true, global: { skills: ["global"], extensions: ["/global.ts"] }, project: { skills: ["project"], extensions: ["/project.ts"] }, effective: { skills: ["global", "project"], extensions: ["/global.ts", "/project.ts"] }, unmatchedSkills: [], unmatchedExtensions: [] };
  const policies: Array<NonNullable<Parameters<SessionFactory>[0]["resourcePolicy"]>> = [];
  let sessions = 0;
  const executor = new WorkflowAgentExecutor({ ...root, agentDefinitions: { ...root.agentDefinitions, reviewer: { ...root.agentDefinitions?.reviewer, disabledAgentResources: { skills: ["role", "global"], extensions: [roleExtension, "/global.ts"] } }, scout: { ...root.agentDefinitions?.scout } }, agentResourcePolicy: () => structuredClone(basePolicy) }, async (input) => {
    assert.ok(input.resourcePolicy);
    policies.push(input.resourcePolicy);
    const session = ++sessions;
    return { sessionId: `role-policy-${String(session)}`, sessionFile: `/sessions/role-policy-${String(session)}.jsonl`, messages: [assistant("done")], getSessionStats: sessionStats, async prompt() { if (session === 1) throw new Error("retry"); }, dispose() {} };
  });
  await executor.execute("role", { label: "role", workflowName: "flow", role: "reviewer", retries: 1 });
  await executor.execute("other", { label: "other", workflowName: "flow", role: "scout" });
  await executor.execute("plain", { label: "plain", workflowName: "flow" });
  assert.deepEqual(policies.map(({ effective }) => effective), [
    { skills: ["global", "project", "role"], extensions: ["/global.ts", "/project.ts", roleExtension] },
    { skills: ["global", "project", "role"], extensions: ["/global.ts", "/project.ts", roleExtension] },
    { skills: ["global", "project"], extensions: ["/global.ts", "/project.ts"] },
    { skills: ["global", "project"], extensions: ["/global.ts", "/project.ts"] },
  ]);
  assert.deepEqual(basePolicy.effective, { skills: ["global", "project"], extensions: ["/global.ts", "/project.ts"] });
});
void test("filters disabled native extensions before factories and skills before session registration", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-resource-loader-"));
  const agentDir = join(rootDir, "agent");
  const cwd = join(rootDir, "project");
  const projectExtensions = join(cwd, ".pi", "extensions");
  const projectSkills = join(cwd, ".pi", "skills");
  mkdirSync(projectExtensions, { recursive: true });
  mkdirSync(projectSkills, { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: {} }));
  writeFileSync(join(agentDir, "auth.json"), "{}");
  const disabledExtension = join(agentDir, "extensions", "disabled.ts");
  const allowedExtension = join(agentDir, "extensions", "allowed.ts");
  const disabledMarker = join(rootDir, "disabled-extension-ran");
  const allowedMarker = join(rootDir, "allowed-extension-ran");
  const projectDisabledExtension = join(projectExtensions, "disabled.ts");
  const projectAllowedExtension = join(projectExtensions, "allowed.ts");
  const projectDisabledMarker = join(rootDir, "project-disabled-extension-ran");
  const projectAllowedMarker = join(rootDir, "project-allowed-extension-ran");
  writeFileSync(disabledExtension, `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(disabledMarker)}, "ran"); }`);
  writeFileSync(allowedExtension, `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(allowedMarker)}, "ran"); }`);
  writeFileSync(projectDisabledExtension, `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(projectDisabledMarker)}, "ran"); }`);
  writeFileSync(projectAllowedExtension, `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(projectAllowedMarker)}, "ran"); }`);
  const skillsDir = join(agentDir, "skills");
  mkdirSync(join(skillsDir, "disabled-skill"), { recursive: true });
  mkdirSync(join(skillsDir, "kept-skill"), { recursive: true });
  writeFileSync(join(skillsDir, "disabled-skill", "SKILL.md"), "---\nname: disabled-skill\ndescription: Disabled\n---\nDisabled");
  writeFileSync(join(skillsDir, "kept-skill", "SKILL.md"), "---\nname: kept-skill\ndescription: Kept\n---\nKept");
  mkdirSync(join(projectSkills, "project-disabled-skill"), { recursive: true });
  mkdirSync(join(projectSkills, "project-kept-skill"), { recursive: true });
  writeFileSync(join(projectSkills, "project-disabled-skill", "SKILL.md"), "---\nname: project-disabled-skill\ndescription: Disabled project skill\n---\nDisabled");
  writeFileSync(join(projectSkills, "project-kept-skill", "SKILL.md"), "---\nname: project-kept-skill\ndescription: Kept project skill\n---\nKept");
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [disabledExtension, allowedExtension], skills: [skillsDir] }));
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ extensions: [projectDisabledExtension, projectAllowedExtension], skills: [projectSkills] }));
  const resourcePolicy = { globalSettingsPath: "/workflow/settings.json", projectSettingsPath: "/project/.pi/pi-extensible-workflows/settings.json", projectTrusted: false, global: { skills: ["disabled-skill"], extensions: [resolve(disabledExtension)] }, project: { skills: [], extensions: [] }, effective: { skills: ["disabled-skill"], extensions: [resolve(disabledExtension)] }, unmatchedSkills: [], unmatchedExtensions: [] };
  const session = await createNativeAgentSession({ cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: ["read"], sessionLabel: "resource-filter", resourcePolicy });
  const loaded = (session as unknown as { resourceLoader: { getSkills(): { skills: Array<{ name: string }> }; getExtensions(): { extensions: Array<{ resolvedPath: string }> } } }).resourceLoader;
  assert.equal(existsSync(disabledMarker), false);
  assert.equal(existsSync(allowedMarker), true);
  assert.equal(existsSync(projectDisabledMarker), false);
  assert.equal(existsSync(projectAllowedMarker), false);
  const skillNames = loaded.getSkills().skills.map(({ name }) => name);
  assert.ok(skillNames.includes("kept-skill"));
  assert.equal(skillNames.includes("disabled-skill"), false);
  assert.equal(skillNames.includes("project-disabled-skill"), false);
  assert.equal(skillNames.includes("project-kept-skill"), false);
  assert.ok(loaded.getExtensions().extensions.every(({ resolvedPath }) => resolvedPath !== resolve(disabledExtension)));
  assert.match(session.systemPrompt ?? "", /kept-skill/);
  assert.doesNotMatch(session.systemPrompt ?? "", /disabled-skill/);
  const commands = (session as unknown as { _extensionRunner: { runtime: { getCommands(): Array<{ name: string }> } } })._extensionRunner.runtime.getCommands();
  assert.ok(commands.some(({ name }) => name === "skill:kept-skill"));
  assert.equal(commands.some(({ name }) => name === "skill:disabled-skill"), false);
  assert.deepEqual(resourcePolicy.unmatchedSkills, []);
  assert.deepEqual(resourcePolicy.unmatchedExtensions, []);
  session.dispose();
  const trustedPolicy = { globalSettingsPath: "/workflow/settings.json", projectSettingsPath: "/project/.pi/pi-extensible-workflows/settings.json", projectTrusted: true, global: { skills: ["disabled-skill"], extensions: [resolve(disabledExtension)] }, project: { skills: ["project-disabled-skill"], extensions: [resolve(projectDisabledExtension)] }, effective: { skills: ["disabled-skill", "project-disabled-skill"], extensions: [resolve(disabledExtension), resolve(projectDisabledExtension)] }, unmatchedSkills: [], unmatchedExtensions: [] };
  const trusted = await createNativeAgentSession({ cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: ["read"], sessionLabel: "resource-trusted", resourcePolicy: trustedPolicy });
  const trustedLoaded = (trusted as unknown as { resourceLoader: { getSkills(): { skills: Array<{ name: string }> }; getExtensions(): { extensions: Array<{ resolvedPath: string }> } } }).resourceLoader;
  assert.equal(existsSync(projectDisabledMarker), false);
  assert.equal(existsSync(projectAllowedMarker), true);
  const trustedSkillNames = trustedLoaded.getSkills().skills.map(({ name }) => name);
  assert.ok(trustedSkillNames.includes("project-kept-skill"));
  assert.equal(trustedSkillNames.includes("project-disabled-skill"), false);
  assert.ok(trustedLoaded.getExtensions().extensions.every(({ resolvedPath }) => resolvedPath !== resolve(projectDisabledExtension)));
  assert.deepEqual(trustedPolicy.unmatchedSkills, []);
  assert.deepEqual(trustedPolicy.unmatchedExtensions, []);
  trusted.dispose();
  const parent = await createNativeAgentSession({ cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: ["read"], sessionLabel: "resource-parent" });
  assert.match(parent.systemPrompt ?? "", /disabled-skill/);
  parent.dispose();
});
void test("continues a persisted conversation head and fails closed on execution-policy or prompt drift", async () => {
  const conversations = new Map<string, { id: string; policy: unknown; head: { turn: number; sessionId: string; sessionFile: string; leafId: string; systemPrompt: string; systemPromptSha256: string; toolDefinitionsSha256: string } }>();
  const inputs: Array<{ continuation?: { sessionId: string; sessionFile: string; leafId: string } }> = [];
  let created = 0;
  let promptDrift = false;
  const runStore = {
    conversation: async (id: string) => conversations.get(id),
    saveConversation: async (conversation: (typeof conversations extends Map<string, infer Value> ? Value : never)) => { conversations.set(conversation.id, conversation); },
    recordSystemPrompt: async () => {},
  } as unknown as RunStore;
  const executor = new WorkflowAgentExecutor({ ...root, runStore }, async (input) => {
    inputs.push({ ...(input.continuation ? { continuation: input.continuation } : {}) });
    const leafId = input.continuation?.leafId ?? `leaf-${String(++created)}`;
    const messages = [assistant("initial")];
    return {
      sessionId: "developer-session", sessionFile: "/sessions/developer.jsonl", messages, model: { provider: "openai", model: "gpt" }, getSessionStats: sessionStats, systemPrompt: promptDrift ? "CHANGED" : "SYSTEM", agent: { state: { tools: [] } },
      getLeafId: () => leafId, getToolDefinitions: () => [{ name: "read", description: "read", parameters: { type: "object" } }],
      async prompt(text) { messages[0] = assistant(text.includes("second") ? "second" : "first"); }, dispose() {},
    };
  });
  assert.equal((await executor.execute("first", { label: "developer", workflowName: "flow", conversation: { id: "developer", turn: 1 } })).value, "first");
  assert.equal((await executor.execute("second", { label: "developer", workflowName: "flow", conversation: { id: "developer", turn: 2 } })).value, "second");
  assert.deepEqual(inputs.map(({ continuation }) => continuation?.leafId), [undefined, "leaf-1"]);
  assert.equal(conversations.get("developer")?.head.turn, 2);
  promptDrift = true;
  await assert.rejects(executor.execute("third", { label: "developer", workflowName: "flow", conversation: { id: "developer", turn: 3 } }), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  assert.equal(conversations.get("developer")?.head.turn, 2);
  assert.equal(inputs.length, 3);
});
