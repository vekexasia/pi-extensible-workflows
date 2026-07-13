import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import workflowExtension, { createLaunchSnapshot, FairAgentScheduler, persistAgentAttempts, registerWorkflowDslExtension, runWorkflow, WorkflowAgentExecutor, WorkflowError } from "../src/index.js";
import { createNativeAgentSession } from "../src/agent-execution.js";
import { RunStore } from "../src/persistence.js";

void test("production session_start cold-restores ownership and /workflow stop cascades", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-acceptance-"));
  const cwd = join(home, "project");
  const sessionId = "session-a";
  const runId = "run-a";
  const store = new RunStore(cwd, sessionId, runId, home);
  const settings = { concurrency: 1, maxAgents: 2, agentTimeoutMs: 25 };
  await store.create({ id: runId, workflowName: "cold", cwd, sessionId, state: "interrupted", agents: [], nativeSessions: [] }, createLaunchSnapshot({ script: "export const meta={name:'cold',description:'cold'}", args: null, metadata: { name: "cold", description: "cold" }, settings, models: ["openai-codex/gpt-5.6-sol"], tools: ["agent"], agentTypes: [], extensions: {}, schemas: [] }));
  const options = { label: "parent", cwd, tools: ["agent"] };
  await store.saveOwnership([{ id: `${runId}:1`, label: "parent", state: "waiting_for_child", options }, { id: `${runId}:2`, parentId: `${runId}:1`, label: "child", state: "running", options: { ...options, label: "child" } }]);

  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const notices: string[] = [];
  const ctx = { cwd, model: { provider: "openai-codex", id: "gpt-5.6-sol" }, sessionManager: { getSessionId: () => sessionId }, ui: { notify: (message: string) => { notices.push(message); } } };
  workflowExtension({ on(name: string, handler: typeof start) { if (name === "session_start") start = handler; }, registerTool() {}, registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["agent", "workflow"] } as never, home);
  assert.ok(start && command);
  await start({}, ctx);
  await command(`stop ${runId}`, ctx);
  assert.equal((await store.load()).run.state, "stopped");
  assert.deepEqual((await store.loadOwnership()).map(({ state }) => state), ["cancelled", "cancelled"]);
  assert.deepEqual((await store.load()).run.agents.map(({ state }) => state), ["cancelled", "cancelled"]);
  assert.deepEqual(notices, [`Stopped workflow ${runId}.`]);
});

void test("cold recovery delivers a persisted checkpoint only once before replay", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-checkpoint-recovery-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  const script = `export const meta={name:'cold-gate',description:'cold gate'}; return checkpoint({name:'ship',prompt:'Ship?',context:{sha:'abc'}});`;
  await store.create({ id: "run-a", workflowName: "cold-gate", cwd, sessionId: "session-a", state: "interrupted", agents: [], nativeSessions: [] }, createLaunchSnapshot({ script, args: null, metadata: { name: "cold-gate", description: "cold gate" }, settings: { concurrency: 1, maxAgents: 1, agentTimeoutMs: null }, models: ["openai/gpt"], tools: [], agentTypes: [], extensions: {}, schemas: [] }));
  await store.awaitCheckpoint({ path: "checkpoint/ship", name: "ship", prompt: "Ship?", context: { sha: "abc" } });
  const tools: Array<{ name: string; execute: (...args: never[]) => Promise<{ details: { accepted: boolean } }> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const messages: string[] = [];
  const ctx = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {} } };
  workflowExtension({ on(name: string, handler: never) { if (name === "session_start") start = handler; }, registerTool(tool: never) { tools.push(tool); }, registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_respond"], sendMessage(message: { content: string }) { messages.push(message.content); } } as never, home);
  assert.ok(start && command);
  await start({}, ctx);
  assert.match(messages[0] ?? "", /Ship\?/);
  await command("resume run-a", ctx);
  for (let attempt = 0; attempt < 100 && (await store.load()).run.state !== "awaiting_input"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(messages.length, 1);
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(respond);
  assert.equal((await respond.execute(undefined as never, { runId: "run-a", name: "ship", approved: true } as never)).details.accepted, true);
  for (let attempt = 0; attempt < 100 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await store.load()).run.state, "completed");
  assert.deepEqual(await store.replay("checkpoint/ship"), { path: "checkpoint/ship", value: true });
});

void test("production lifecycle commands persist pause, resume, and Pi-close interruption", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-lifecycle-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "life", cwd, sessionId: "session-a", state: "running", agents: [], nativeSessions: [] }, createLaunchSnapshot({ script: "export const meta={name:'life',description:'life'}", args: null, metadata: { name: "life", description: "life" }, settings: { concurrency: 1, maxAgents: 1, agentTimeoutMs: null }, models: ["openai-codex/gpt-5.6-sol"], tools: [], agentTypes: [], extensions: {}, schemas: [] }));
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const ctx = { cwd, model: { provider: "openai-codex", id: "gpt-5.6-sol" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {} } };
  workflowExtension({ on(name: string, handler: never) { if (name === "session_start") start = handler; if (name === "session_shutdown") shutdown = handler; }, registerTool() {}, registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  assert.ok(start && shutdown && command);
  await start({}, ctx);
  await command("pause run-a", ctx);
  assert.equal((await store.load()).run.state, "paused");
  await command("resume run-a", ctx);
  assert.equal((await store.load()).run.state, "running");
  await shutdown();
  assert.equal((await store.load()).run.state, "interrupted");
  await command("resume run-a", ctx);
  for (let attempt = 0; attempt < 20 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await store.load()).run.state, "completed");
});

void test("production Pi seam installs child tools and registers native steering", async () => {
  const childTool = { name: "agent", label: "Child", description: "child", parameters: Type.Object({}), async execute() { return { content: [{ type: "text" as const, text: "ok" }], details: {} }; } };
  const session = await createNativeAgentSession({ cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], customTools: [childTool], sessionLabel: "issue-9-acceptance" });
  assert.ok(session.agent?.state.tools.some(({ name }) => name === "agent"));
  session.dispose();
  let steer: ((message: string) => void | Promise<void>) | undefined;
  const received: string[] = [];
  const executor = new WorkflowAgentExecutor({ cwd: "/repo", model: { provider: "openai", model: "gpt" }, tools: new Set() }, async () => ({ sessionId: "s", sessionFile: "/s", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }], prompt: async () => {}, steer: async (message) => { received.push(message); }, dispose() {} }));
  await executor.execute("work", { label: "worker", workflowName: "flow", workflowDescription: "flow" }, undefined, [], (handler) => { steer = handler; });
  assert.ok(steer); await steer("redirect"); assert.deepEqual(received, ["redirect"]);
});

void test("concurrency-1 cancellation and nested containment retain accounting and retry isolation", async () => {
  const started: string[] = [];
  let release!: () => void;
  let scheduler: FairAgentScheduler;
  // eslint-disable-next-line prefer-const
  scheduler = new FairAgentScheduler(async ({ id, prompt, options }) => {
    started.push(prompt);
    if (prompt === "r1") await new Promise<void>((resolve) => { release = resolve; });
    if (prompt === "parent") { const child = scheduler.spawn("nested", "child", { label: "child", cwd: options.cwd, tools: [] }, id); return scheduler.result(id, child.id); }
    if (prompt === "child") throw new WorkflowError("AGENT_FAILED", "child failed");
    return prompt;
  }, 1);
  scheduler.addRun("run", 1);
  const r1 = scheduler.spawn("run", "r1", { label: "r1", cwd: "/repo", tools: [] });
  const r2 = scheduler.spawn("run", "r2", { label: "r2", cwd: "/repo", tools: [] });
  const r3 = scheduler.spawn("run", "r3", { label: "r3", cwd: "/repo", tools: [] });
  scheduler.cancel(r2.id); release(); await Promise.all([r1.result, r2.result, r3.result]);
  assert.deepEqual(started, ["r1", "r3"]);
  scheduler.addRun("nested", 1, 2);
  const parent = scheduler.spawn("nested", "parent", { label: "parent", cwd: "/repo", tools: [] });
  assert.equal((await parent.result).ok, true);
  assert.deepEqual(scheduler.snapshot().slice(-2).map(({ state }) => state), ["completed", "failed"]);

  let attempt = 0;
  let cleaned = 0;
  const executor = new WorkflowAgentExecutor({ cwd: "/repo", model: { provider: "openai", model: "gpt" }, tools: new Set() }, async () => { const current = ++attempt; return { sessionId: `s${String(current)}`, sessionFile: `/s${String(current)}`, messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } } }], prompt: async () => { if (current === 1) throw new Error("retry"); }, dispose() {} }; });
  const retried = await executor.execute("retry", { label: "retry", workflowName: "flow", workflowDescription: "flow", retries: 1, timeoutMs: 100 }, undefined, [], undefined, () => { cleaned += 1; });
  assert.equal(cleaned, 1); assert.equal(retried.attempts.length, 2); assert.deepEqual(retried.attempts.map(({ accounting }) => accounting.cost), [0.5, 0.5]);
});

void test("production worker runs named combinators with railway lifecycle semantics", async () => {
  const controller = new AbortController();
  let cancelStarted!: () => void;
  const started = new Promise<void>((resolve) => { cancelStarted = resolve; });
  const run = runWorkflow(`export const meta={name:'acceptance',description:'acceptance'};
    return parallel([{name:'waiting',run:()=>agent('wait',{name:'wait'})},{name:'failure',run:()=>{throw Object.assign(new Error('branch failed'),{code:'AGENT_FAILED'})}}],{name:'batch'});`, null, {
    agent: async (_prompt, _options, signal) => { cancelStarted(); await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); }); throw new WorkflowError("CANCELLED", "cancelled"); },
  }, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(run.result, (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");

  assert.deepEqual(await runWorkflow(`export const meta={name:'acceptance',description:'acceptance'};
    return pipeline([{name:'first',value:1},{name:'second',value:2}],{name:'double',run:value=>value*2},{name:'fail-two',run:value=>{if(value===4)throw Object.assign(new Error('no'),{code:'AGENT_FAILED'});return value}},{name:'pipe'});`).result,
  [{ name: "first", ok: true, value: 2 }, { name: "second", ok: false, failedAt: "pipe/second/fail-two", error: { code: "AGENT_FAILED", message: "no" } }]);
});

void test("terminal failed attempts remain persisted", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-attempts-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "failed", cwd, sessionId: "session-a", state: "running", agents: [{ id: "run-a:1", name: "agent", path: "run-a:1", state: "running", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 0 }], nativeSessions: [] }, createLaunchSnapshot({ script: "export const meta={name:'failed',description:'failed'}", args: null, metadata: { name: "failed", description: "failed" }, settings: { concurrency: 1, maxAgents: 1, agentTimeoutMs: null }, models: ["openai/gpt"], tools: [], agentTypes: [], extensions: {}, schemas: [] }));
  await persistAgentAttempts(store, "run-a:1", [{ attempt: 1, sessionId: "failed-session", sessionFile: "/sessions/failed.jsonl", error: { code: "AGENT_FAILED", message: "failed" }, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }]);
  const persisted = (await store.load()).run;
  assert.deepEqual(persisted.agents.map(({ attempts, accounting }) => ({ attempts, accounting })), [{ attempts: 1, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }]);
  assert.deepEqual(persisted.nativeSessions, [{ sessionId: "failed-session", sessionFile: "/sessions/failed.jsonl" }]);
});

void test("production workflow exposes registered extension macros and replays them structurally", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-extension-acceptance-"));
  let calls = 0;
  registerWorkflowDslExtension({
    name: "issue16Acceptance", version: "1.0.0", headline: "Acceptance", description: "Acceptance macro",
    methods: { echo: { description: "Echo once", input: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, output: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, run(input) { calls += 1; return { value: input.value as string }; } } },
  });
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { runId: string; value: unknown } }> }> = [];
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const script = `export const meta={name:'extension-e2e',description:'extension e2e',phases:['verify'],extensions:[{name:'issue16Acceptance',version:'^1.0.0'}]}; phase('verify'); const first=await extensions.issue16Acceptance.echo({value:'first'}); const replayed=await extensions.issue16Acceptance.echo({value:'second'}); return [first,replayed];`;
  const result = await workflow.execute("id", { script, foreground: true }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  assert.deepEqual(result.details.value, [{ value: "first" }, { value: "first" }]);
  assert.equal(calls, 1);
  const store = new RunStore(home, "session", result.details.runId, home);
  assert.equal((await store.load()).run.phase, "verify");
  assert.deepEqual(await store.replay("extension/issue16Acceptance/echo"), { path: "extension/issue16Acceptance/echo", value: { value: "first" } });
});
