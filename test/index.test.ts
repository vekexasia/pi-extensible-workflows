import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, FairAgentScheduler, loadSettings, preflight, RPC_LIMIT_BYTES, RunLifecycle, runWorkflow, WorkflowDslRegistry, WorkflowError, type JsonValue } from "../src/index.js";

const capabilities = {
  models: new Set(["openai/gpt"]), tools: new Set(["read"]), agentTypes: new Set(["reviewer"]), extensions: { git: "1.2.3" },
};
const valid = `export const meta = { name: "review", description: "Review code", phases: ["check"], extensions: [{name:"git",version:"^1.0.0"}] };
phase("check"); agent("do it", { name: "reviewer", model: "openai/gpt", tools: ["read"], agentType: "reviewer" });`;

void test("registers the workflow tool and singular command", async () => {
  const tools: Array<{ name: string; execute: (id?: unknown, params?: unknown, signal?: unknown, update?: unknown, ctx?: unknown) => Promise<unknown> }> = [];
  const commands: Array<{ name: string; options: { handler: (args: string, ctx: unknown) => Promise<void> } }> = [];
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
    registerCommand(name: string, options: (typeof commands)[number]["options"]) { commands.push({ name, options }); },
    getThinkingLevel() { return "medium"; },
    getActiveTools() { return ["read", "workflow"]; },
    on() {},
  };
  workflowExtension(pi as never);
  assert.deepEqual(tools.map(({ name }) => name), ["workflow"]);
  assert.deepEqual(commands.map(({ name }) => name), ["workflow"]);
  const tool = tools[0];
  assert.ok(tool);
  await assert.rejects(tool.execute("id", { script: "" }, undefined, undefined, { model: undefined }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL");
});

void test("background delivery is minimal and capped while foreground stays inline", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-delivery-"));
  const tools: Array<{ execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  const messages: Array<{ message: { content: string }; options: { deliverAs: string; triggerTurn: boolean } }> = [];
  let markDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => { markDelivered = resolve; });
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {},
    getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"],
    sendMessage(message: { content: string }, options: { deliverAs: string; triggerTurn: boolean }) { messages.push({ message, options }); markDelivered(); }
  };
  workflowExtension(pi as never, home);
  const execute = tools[0]?.execute;
  assert.ok(execute);
  const ctx = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const background = await execute("id", { script: `export const meta={name:"large",description:"large"}; return "x".repeat(5000);` }, new AbortController().signal, undefined, ctx);
  assert.match(background.content[0]?.text ?? "", /"state":"running"/);
  await delivered;
  assert.equal(messages.length, 1);
  assert.equal(Buffer.byteLength(messages[0]?.message.content ?? ""), 4096);
  assert.match(messages[0]?.message.content ?? "", /^Workflow large completed:/);
  assert.match(messages[0]?.message.content ?? "", /Full result: .*result\.json/);
  assert.deepEqual(messages[0]?.options, { deliverAs: "followUp", triggerTurn: true });
  const foreground = await execute("id", { script: `export const meta={name:"inline",description:"inline"}; return {ok:true};`, foreground: true }, new AbortController().signal, undefined, ctx);
  assert.equal(foreground.content[0]?.text, `{"ok":true}`);
  assert.equal(messages.length, 1);
});

void test("run lifecycle pauses cooperatively, resumes waiters, and keeps terminal states irreversible", async () => {
  const states: string[] = [];
  const lifecycle = new RunLifecycle("running", (state) => { states.push(state); });
  await lifecycle.enter();
  await lifecycle.pause();
  assert.equal(lifecycle.state, "pausing");
  let continued = false;
  const waiting = lifecycle.enter().then(() => { continued = true; });
  await lifecycle.leave();
  assert.equal(lifecycle.state, "paused");
  assert.equal(continued, false);
  await lifecycle.resume();
  await waiting;
  assert.equal(continued, true);
  await lifecycle.leave();
  await lifecycle.terminal("stopped");
  await assert.rejects(lifecycle.resume(), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  assert.deepEqual(states, ["pausing", "paused", "running", "stopped"]);
});

void test("interrupted lifecycle can cold-resume while completed and failed cannot", async () => {
  const interrupted = new RunLifecycle("interrupted");
  await interrupted.resume();
  assert.equal(interrupted.state, "running");
  for (const state of ["completed", "failed"] as const) await assert.rejects(new RunLifecycle(state).resume(), /Cannot resume/);
});

void test("strict settings use defaults and reject unknown or unsafe values", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflows-"));
  assert.equal(loadSettings(join(dir, "missing.json")), DEFAULT_SETTINGS);
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({ concurrency: 4, maxAgents: 20, agentTimeoutMs: 500 }));
  assert.deepEqual(loadSettings(path), { concurrency: 4, maxAgents: 20, agentTimeoutMs: 500 });
  writeFileSync(path, JSON.stringify({ concurrency: 17 }));
  assert.throws(() => loadSettings(path), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SETTINGS");
  writeFileSync(path, JSON.stringify({ surprise: true }));
  assert.throws(() => loadSettings(path), /Unknown workflow setting/);
});

void test("preflight accepts the complete static contract", () => {
  const result = preflight(valid, capabilities, [{ type: "object", properties: { value: { type: "string" } } }]);
  assert.equal(result.metadata.name, "review");
  assert.deepEqual(result.referenced, { phases: ["check"], models: ["openai/gpt"], tools: ["read"], agentTypes: ["reviewer"] });
  assert.ok(Object.isFrozen(result.metadata));
});

void test("preflight rejects every static boundary before run creation", () => {
  let created = 0;
  const createRun = (script: string) => { preflight(script, capabilities); created += 1; };
  const cases: Array<[string, string]> = [
    ["const x = ;", "INVALID_SYNTAX"],
    ["export const meta = {name:'',description:'x'};", "INVALID_METADATA"],
    [`export const meta={name:'x',description:'x'}; agent('a')`, "INVALID_METADATA"],
    [`export const meta={name:'x',description:'x',phases:['a','a']};`, "DUPLICATE_NAME"],
    [`export const meta={name:'x',description:'x',phases:['a']}; phase('b')`, "UNKNOWN_PHASE"],
    [`export const meta={name:'x',description:'x'}; agent('a',{name:'n',model:'missing'})`, "UNKNOWN_MODEL"],
    [`export const meta={name:'x',description:'x'}; agent('a',{name:'n',tools:['bash']})`, "UNKNOWN_TOOL"],
    [`export const meta={name:'x',description:'x'}; agent('a',{name:'n',agentType:'writer'})`, "UNKNOWN_AGENT_TYPE"],
    [`export const meta={name:'x',description:'x',extensions:[{name:'nope',version:'1.0.0'}]};`, "MISSING_EXTENSION"],
    [`export const meta={name:'x',description:'x'}; agent('a',{name:'same'}); agent('b',{name:'same'})`, "DUPLICATE_NAME"],
  ];
  for (const [script, code] of cases) assert.throws(() => { createRun(script); }, (error: unknown) => error instanceof WorkflowError && error.code === code);
  assert.equal(created, 0);
  assert.throws(() => preflight(`export const meta={name:'x',description:'x'};`, capabilities, [{}]), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SCHEMA");
});

void test("preflight rejects non-JSON schemas, incompatible extension versions, and unnamed structured work", () => {
  const base = `export const meta={name:'x',description:'x'};`;
  assert.throws(() => preflight(base, capabilities, [{ type: "object", properties: { bad: () => true } }]), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SCHEMA");
  assert.throws(() => preflight(`export const meta={name:'x',description:'x',extensions:[{name:'git',version:'^1.2.3'}]};`, { ...capabilities, extensions: { git: "1.0.0" } }), (error: unknown) => error instanceof WorkflowError && error.code === "INCOMPATIBLE_EXTENSION");
  assert.throws(() => preflight(`${base} parallel([{run:()=>1}], {name:'batch'})`, capabilities), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA" && /Every parallel task/.test(error.message));
  assert.throws(() => preflight(`${base} parallel([{name:'task',run:()=>1}])`, capabilities), /parallel requires/);
  assert.throws(() => preflight(`${base} pipeline([{value:1}], {name:'stage',run:value=>value})`, capabilities), /Every pipeline item/);
  assert.throws(() => preflight(`${base} pipeline([{name:'item',value:1}], value=>value, {name:'pipe'})`, capabilities), /Every pipeline stage/);
  preflight(`${base} parallel([{name:'task',run:()=>1}], {name:'batch'}); pipeline([{name:'item',value:1}], {name:'stage',run:value=>value}, {name:'pipe'})`, capabilities);
});

void test("launch snapshots are detached and deeply immutable", () => {
  const input = { script: valid, args: { nested: [1] }, metadata: { name: "x", description: "x" }, settings: { concurrency: 1, maxAgents: 1, agentTimeoutMs: null }, models: ["openai/gpt"], tools: ["read"], agentTypes: ["reviewer"], extensions: { git: "1.2.3" }, schemas: [{ type: "object" }] };
  const snapshot = createLaunchSnapshot(input);
  input.args.nested.push(2);
  assert.deepEqual(snapshot.args, { nested: [1] });
  assert.ok(Object.isFrozen(snapshot.args));
  assert.ok(Object.isFrozen(snapshot.schemas[0]));
});

void test("worker exposes deterministic core globals and JSON RPC only", async () => {
  const phases: string[] = [];
  const script = `export const meta={name:'x',description:'x'};
    if (typeof process !== 'undefined' || typeof require !== 'undefined' || typeof console !== 'undefined' || typeof Date !== 'undefined' || typeof setTimeout !== 'undefined' || typeof Math.random !== 'undefined') throw new Error('unsafe global');
    await phase('build'); if (!await checkpoint({name:'gate'})) throw new Error('rejected'); return await agent('echo', {name:'echo', value: args});`;
  const run = runWorkflow(script, { n: 2 }, {
    phase(name) { phases.push(name); },
    checkpoint() { return true; },
    agent(prompt, options) { return Promise.resolve({ prompt, options }); },
  });
  assert.deepEqual(await run.result, { prompt: "echo", options: { name: "echo", value: { n: 2 } } });
  assert.deepEqual(phases, ["build"]);
});

void test("named parallel and pipeline preserve order, contain failures, and expose stable paths", async () => {
  const pending = new Map<string, (value: JsonValue) => void>();
  const started: string[] = [];
  const bridge = {
    agent(prompt: string) {
      started.push(prompt);
      if (prompt === "fail") throw new WorkflowError("AGENT_FAILED", "expected failure");
      return new Promise<JsonValue>((resolve) => { pending.set(prompt, resolve); });
    },
  };
  const parallelRun = runWorkflow(`export const meta={name:'x',description:'x'};
    return parallel([
      {name:'first/item',run:()=>agent('slow',{name:'slow'})},
      {name:'second',run:()=>agent('fast',{name:'fast'})},
      {name:'broken',run:()=>agent('fail',{name:'fail'})}
    ],{name:'batch'});`, null, bridge);
  while (started.length < 3) await new Promise((resolve) => setImmediate(resolve));
  pending.get("fast")?.(2); pending.get("slow")?.(1);
  assert.deepEqual(await parallelRun.result, [
    { name: "first/item", ok: true, value: 1 },
    { name: "second", ok: true, value: 2 },
    { name: "broken", ok: false, failedAt: "batch/broken", error: { code: "AGENT_FAILED", message: "expected failure" } },
  ]);

  const pipelineRun = runWorkflow(`export const meta={name:'x',description:'x'};
    return pipeline([{name:'one',value:1},{name:'two',value:2}],
      {name:'double',run:value=>value*2},
      {name:'reject odd',run:value=>{if(value===2)throw Object.assign(new Error('no'),{code:'AGENT_FAILED'});return value+1}},
      {name:'pipe/name'});`);
  assert.deepEqual(await pipelineRun.result, [
    { name: "one", ok: false, failedAt: "pipe%2Fname/one/reject%20odd", error: { code: "AGENT_FAILED", message: "no" } },
    { name: "two", ok: true, value: 5 },
  ]);

  const duplicate = runWorkflow(`export const meta={name:'x',description:'x'}; return parallel([{name:'same',run:()=>1},{name:'same',run:()=>2}],{name:'batch'});`);
  await assert.rejects(duplicate.result, (error: unknown) => error instanceof WorkflowError && error.code === "DUPLICATE_NAME");
});

void test("worker cancellation is immediate even for runaway synchronous code", async () => {
  const run = runWorkflow(`export const meta={name:'x',description:'x'}; while(true){}`);
  const started = performance.now();
  run.cancel();
  await assert.rejects(run.result, (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  assert.ok(performance.now() - started < 1000);
});

void test("workflow cancellation reaches an active top-level scheduler agent", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const scheduler = new FairAgentScheduler(async ({ signal }) => {
    markStarted();
    await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
    throw new WorkflowError("CANCELLED", "cancelled");
  }, 1);
  scheduler.addRun("run", 1);
  const run = runWorkflow(`export const meta={name:'x',description:'x'}; return await agent('wait',{name:'wait'});`, null, {
    agent: async (_prompt, _options, signal) => {
      const spawned = scheduler.spawn("run", "wait", { label: "wait", cwd: "/repo", tools: [] });
      const cancel = () => { scheduler.cancel(spawned.id); };
      signal.addEventListener("abort", cancel, { once: true });
      const outcome = await spawned.result.finally(() => { signal.removeEventListener("abort", cancel); });
      if (!outcome.ok) throw new WorkflowError("CANCELLED", outcome.error.message);
      return outcome.value;
    },
  });
  await started;
  run.cancel();
  await assert.rejects(run.result, (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  await scheduler.flush();
  assert.deepEqual(scheduler.snapshot().map(({ state }) => state), ["cancelled"]);
});

void test("worker watchdog terminates a synchronous heartbeat stall after five seconds", { timeout: 7000 }, async () => {
  const run = runWorkflow(`export const meta={name:'x',description:'x'}; while(true){}`);
  const started = performance.now();
  await assert.rejects(run.result, (error: unknown) => error instanceof WorkflowError && error.code === "WORKER_UNRESPONSIVE");
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 4900 && elapsed < 6500, `watchdog fired after ${String(elapsed)}ms`);
});

void test("worker enforces 10 MB boundaries on individual and final JSON values", async () => {
  const oversized = "x".repeat(RPC_LIMIT_BYTES);
  assert.throws(() => runWorkflow(`export const meta={name:'x',description:'x'};`, oversized), (error: unknown) => error instanceof WorkflowError && error.code === "RPC_LIMIT_EXCEEDED");
  const run = runWorkflow(`export const meta={name:'x',description:'x'}; return 'x'.repeat(${String(RPC_LIMIT_BYTES)});`);
  await assert.rejects(run.result, (error: unknown) => error instanceof WorkflowError && error.code === "RPC_LIMIT_EXCEEDED");
});

void test("registers namespaced DSL extensions and replays each call as one validated macro", async () => {
  const registry = new WorkflowDslRegistry();
  let calls = 0;
  let receivedContext: unknown;
  registry.register({
    name: "git", version: "1.2.3", headline: "Git operations", description: "Orchestrate Git work",
    methods: {
      status: {
        description: "Read status",
        input: { type: "object", properties: { short: { type: "boolean" } }, required: ["short"], additionalProperties: false },
        output: { type: "object", properties: { clean: { type: "boolean" } }, required: ["clean"], additionalProperties: false },
        run: (input, context) => { calls += 1; receivedContext = context; return { clean: input.short === true }; },
      },
    },
  });
  const saved = new Map<string, JsonValue>();
  const journal = { get: (path: string) => saved.get(path), put: (path: string, value: JsonValue) => { saved.set(path, value); } };
  const context = { agent: async () => null, parallel: async () => null, pipeline: async () => null, checkpoint: async () => true, phase: () => {}, log: () => {}, privateScheduler: true };
  assert.deepEqual(registry.versions(), { git: "1.2.3" });
  assert.deepEqual(Object.keys(registry.namespaces().git ?? {}), ["status"]);
  assert.deepEqual(await registry.invoke("git", "status", { short: true }, context, "root/git.status", journal), { clean: true });
  assert.deepEqual(await registry.invoke("git", "status", { short: false }, context, "root/git.status", journal), { clean: true });
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(receivedContext as object), ["agent", "parallel", "pipeline", "checkpoint", "phase", "log"]);
});

void test("rejects extension collisions, invalid metadata, schemas, input, and output", async () => {
  const registry = new WorkflowDslRegistry();
  const extension = { name: "demo", version: "1.0.0", headline: "Demo", description: "Demo methods", methods: { run: { description: "Run", input: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, output: { type: "string" }, run: () => 1 } } };
  registry.register(extension);
  assert.throws(() => { registry.register(extension); }, (error: unknown) => error instanceof WorkflowError && error.code === "DUPLICATE_NAME");
  assert.throws(() => { new WorkflowDslRegistry().register({ ...extension, version: "v1" }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => { new WorkflowDslRegistry().register({ ...extension, methods: { run: { ...extension.methods.run, description: "", input: { type: "string" } } } }); }, WorkflowError);
  const journal = { get: () => undefined, put: () => {} };
  const context = { agent: async () => null, parallel: async () => null, pipeline: async () => null, checkpoint: async () => true, phase: () => {}, log: () => {} };
  await assert.rejects(registry.invoke("demo", "run", { value: 1 }, context, "bad-input", journal), (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID");
  await assert.rejects(registry.invoke("demo", "run", { value: "x" }, context, "bad-output", journal), (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID");
});
