import assert from "node:assert/strict";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, FairAgentScheduler, formatNavigatorRun, formatWorkflowProgress, loadSettings, preflight, RPC_LIMIT_BYTES, RunLifecycle, RunStore, runWorkflow, validateCheckpoint, WorkflowDslRegistry, WorkflowError, type JsonValue } from "../src/index.js";

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
  assert.deepEqual(tools.map(({ name }) => name), ["workflow_respond", "workflow"]);
  assert.deepEqual(commands.map(({ name }) => name), ["workflow"]);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool);
  await assert.rejects(tool.execute("id", { script: "" }, undefined, undefined, { model: undefined }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL");
});

void test("streams foreground workflow progress into its tool card", async () => {
  type Update = { content: Array<{ type: string; text: string }>; details: { run: { state: string; phase?: string } } };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-progress-"));
  workflowExtension({
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
    registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {},
  } as never, home);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool);
  const updates: Update[] = [];
  const result = await tool.execute("id", { script: `export const meta={name:'progress',description:'progress',phases:['work']}; phase('work'); return true;`, foreground: true }, new AbortController().signal, (update: Update) => { updates.push(update); }, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }) as { details: { run: Parameters<typeof formatWorkflowProgress>[0] } };
  assert.ok(updates.some(({ details }) => details.run.phase === "work"));
  assert.equal(updates.at(-1)?.details.run.state, "completed");
  assert.match(formatWorkflowProgress(result.details.run), /✓ Workflow: progress/);
});

void test("workflow progress surfaces model, thinking, tokens, and tool calls", () => {
  const run = { id: "run", workflowName: "live", cwd: "/repo", sessionId: "session", state: "running", phase: "work", agents: [{ id: "run:1", name: "review", path: "run:1", state: "running", model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" }, tools: ["read"], attempts: 1, accounting: { input: 120, output: 30, cacheRead: 40, cacheWrite: 0, cost: 0.01 }, toolCalls: [{ id: "call", name: "read", state: "running" }] }], nativeSessions: [] } as Parameters<typeof formatWorkflowProgress>[0];
  const rendered = formatWorkflowProgress(run);
  assert.match(rendered, /#1 ◇ review \[running\]/);
  assert.match(rendered, /Model: openai-codex\/gpt-5\.6-sol:high/);
  assert.match(rendered, /Tokens: 150 \(in 120, out 30, cache 40\)/);
  assert.match(rendered, /◇ read/);
  assert.match(formatWorkflowProgress(run, "⠙"), /⠙ Workflow:[\s\S]*#1 ⠙ review[\s\S]*⠙ read/);
});

void test("session-scoped navigator shows metadata and confirms terminal deletion", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-navigator-"));
  const cwd = join(home, "project");
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'nav',description:'nav'}", args: null, metadata: { name: "nav", description: "nav" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: ["read"], agentTypes: [], extensions: {}, schemas: [] });
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "nav", cwd, sessionId: "session-a", state: "completed", phase: "review", agents: [{ id: "run-a:1", name: "reviewer", path: "run-a:1", state: "failed", model: { provider: "openai", model: "gpt", thinking: "medium" }, tools: ["read"], attempts: 2, attemptDetails: [{ attempt: 2, sessionId: "native-a", sessionFile: "/pi/native-a.jsonl", error: { code: "AGENT_FAILED", message: "boom" }, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }], accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }], nativeSessions: [{ sessionId: "native-a", sessionFile: "/pi/native-a.jsonl" }] }, snapshot);
  const same = new RunStore(cwd, "session-a", "run-c", home);
  await same.create({ id: "run-c", workflowName: "nav", cwd, sessionId: "session-a", state: "awaiting_input", agents: [], nativeSessions: [] }, snapshot);
  await same.awaitCheckpoint({ path: "checkpoint/ship", name: "ship", prompt: "Ship?", context: null });
  const other = new RunStore(cwd, "session-b", "run-b", home);
  await other.create({ id: "run-b", workflowName: "other", cwd, sessionId: "session-b", state: "completed", agents: [], nativeSessions: [] }, snapshot);
  const rendered = formatNavigatorRun(await store.load(), [], [{ owner: "reviewer", branch: "pi-workflows/run-a/tree", path: "/worktree", cwd: "/worktree/project", base: "abc" }]);
  assert.match(rendered, /Phase: review/);
  assert.match(rendered, /parent=root model=openai\/gpt:medium attempts=2 retries=1/);
  assert.match(rendered, /error=AGENT_FAILED: boom/);
  assert.match(rendered, /branch=pi-workflows\/run-a\/tree path=\/worktree/);
  assert.match(rendered, /native-a: \/pi\/native-a\.jsonl/);

  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  const prompts: string[] = [];
  const selections: string[][] = [];
  let deleteConfirmed = false;
  const pi = { registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["read", "workflow"] };
  workflowExtension(pi as never, home);
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {}, select: async (prompt: string, options: string[]) => { prompts.push(prompt); selections.push(options); return "Close"; }, confirm: async () => deleteConfirmed } };
  const command = commands[0]?.handler;
  assert.ok(command);
  await command("", ctx as never);
  const actions = selections[0]?.join("\n") ?? "";
  assert.match(actions, /nav \(run-a\): Delete/);
  assert.match(actions, /nav \(run-c\): Stop/);
  assert.match(actions, /nav \(run-c\): Approve ship/);
  assert.match(actions, /nav \(run-c\): Reject ship/);
  assert.doesNotMatch(`${prompts.join("\n")}\n${selections.flat().join("\n")}`, /other/);
  assert.match(prompts[0] ?? "", /Native Pi transcript paths/);
  await command("delete run-a", ctx as never);
  assert.equal(existsSync(store.directory), true);
  deleteConfirmed = true;
  await command("delete run-a", ctx as never);
  assert.equal(existsSync(store.directory), false);
});

void test("checkpoint contract is boolean-only and enforces UTF-8 limits", async () => {
  const accepted: unknown[] = [];
  assert.deepEqual(await runWorkflow(`export const meta={name:'gate',description:'gate'}; return checkpoint({name:'ship',prompt:'Ship?',context:{sha:'abc'}});`, null, { checkpoint(input) { accepted.push(input); return false; } }).result, { name: "ship", ok: true, value: "rejected", __workResult: true });
  assert.deepEqual(accepted, [{ name: "ship", prompt: "Ship?", context: { sha: "abc" } }]);
  assert.throws(() => validateCheckpoint({ name: "x", prompt: "😀".repeat(257), context: null }), /1024/);
  assert.throws(() => validateCheckpoint({ name: "x", prompt: "ok", context: "😀".repeat(1025) }), /4096/);
  assert.throws(() => validateCheckpoint({ name: "x", prompt: "ok", context: null, default: true }), /only name/);
});

void test("production checkpoints resolve in foreground navigator and background tool paths", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-checkpoint-runtime-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {},
    getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_respond"],
    sendMessage() {},
  };
  workflowExtension(pi as never, home);
  const workflow = tools.find(({ name }) => name === "workflow");
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(workflow && respond);
  const base = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const script = `export const meta={name:'gate',description:'gate'}; return checkpoint({name:'ship',prompt:'Ship?',context:{sha:'abc'}});`;
  let selections = 0;
  const foreground = await workflow.execute("id", { script, foreground: true }, new AbortController().signal, undefined, { ...base, mode: "rpc", hasUI: true, ui: { select: async () => ++selections === 1 ? undefined : "Approve" } }) as { content: Array<{ text: string }> };
  assert.deepEqual(JSON.parse(foreground.content[0]?.text ?? ""), { name: "ship", ok: true, value: "approved", __workResult: true });
  assert.equal(selections, 2);
  await assert.rejects(workflow.execute("id", { script, foreground: true }, new AbortController().signal, undefined, { ...base, hasUI: false }), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  const teardown = new AbortController();
  await assert.rejects(workflow.execute("id", { script, foreground: true }, teardown.signal, undefined, { ...base, hasUI: true, ui: { select: async () => { teardown.abort(); throw new Error("UI closed"); } } }), (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  const duplicateScript = `export const meta={name:'duplicate-gate',description:'duplicate'}; return Promise.all([checkpoint({name:'first',prompt:'?',context:null,...{name:args.name}}),checkpoint({name:'second',prompt:'?',context:null,...{name:args.name}})]);`;
  await assert.rejects(workflow.execute("id", { script: duplicateScript, args: { name: "same" }, foreground: true }, new AbortController().signal, undefined, { ...base, hasUI: true, ui: { select: async () => new Promise<string | undefined>(() => {}) } }), (error: unknown) => error instanceof WorkflowError && error.code === "DUPLICATE_NAME");
  const background = await workflow.execute("id", { script }, new AbortController().signal, undefined, base) as { content: Array<{ text: string }> };
  const { runId } = JSON.parse(background.content[0]?.text ?? "") as { runId: string };
  let first: { details: { accepted: boolean } } | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    first = await respond.execute("id", { runId, name: "ship", approved: false }) as { details: { accepted: boolean } };
    if (first.details.accepted) break;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(first?.details.accepted, true);
  const second = await respond.execute("id", { runId, name: "ship", approved: true }) as { details: { accepted: boolean } };
  assert.equal(second.details.accepted, false);
});

void test("two concurrent checkpoints keep the run awaiting until both are answered", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-concurrent-checkpoints-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const pi = { registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_respond"], sendMessage() {} };
  workflowExtension(pi as never, home);
  const workflow = tools.find(({ name }) => name === "workflow");
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(workflow && respond);
  const script = `export const meta={name:'gates',description:'gates'}; return Promise.all([checkpoint({name:'one',prompt:'One?',context:null}),checkpoint({name:'two',prompt:'Two?',context:null})]);`;
  const launched = await workflow.execute("id", { script }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }) as { details: { runId: string } };
  const store = new RunStore(home, "session", launched.details.runId, home);
  for (let attempt = 0; attempt < 100 && (await store.awaitingCheckpoints()).length < 2; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  for (let attempt = 0; attempt < 100 && (await store.load()).run.state !== "awaiting_input"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await store.awaitingCheckpoints()).length, 2);
  assert.equal((await respond.execute("id", { runId: launched.details.runId, name: "one", approved: true }) as { details: { accepted: boolean } }).details.accepted, true);
  assert.equal((await store.load()).run.state, "awaiting_input");
  assert.equal((await respond.execute("id", { runId: launched.details.runId, name: "two", approved: false }) as { details: { accepted: boolean } }).details.accepted, true);
  for (let attempt = 0; attempt < 100 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await store.load()).run.state, "completed");
});

void test("a checkpoint answer persisted before resolver registration cannot hang", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-checkpoint-race-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let completed!: () => void;
  const completion = new Promise<void>((resolve) => { completed = resolve; });
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {},
    getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_respond"],
    sendMessage(message: { content: string }) { if (message.content.startsWith("Workflow race-gate completed:")) completed(); },
  };
  workflowExtension(pi as never, home);
  const workflow = tools.find(({ name }) => name === "workflow");
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(workflow && respond);
  let releaseRunId!: (runId: string) => void;
  const runIdReady = new Promise<string>((resolve) => { releaseRunId = resolve; });
  const saveState = Object.getOwnPropertyDescriptor(RunStore.prototype, "saveState")?.value as RunStore["saveState"];
  let answered = false;
  RunStore.prototype.saveState = async function (run) {
    await saveState.call(this, run);
    if (!answered && run.state === "awaiting_input" && this.cwd === home) {
      answered = true;
      const response = await respond.execute("id", { runId: await runIdReady, name: "ship", approved: false }) as { details: { accepted: boolean } };
      assert.equal(response.details.accepted, true);
    }
  };
  const timeout = setTimeout(() => { completed(); }, 2000);
  try {
    const result = await workflow.execute("id", { script: `export const meta={name:'race-gate',description:'race gate'}; return checkpoint({name:'ship',prompt:'Ship?',context:null});` }, new AbortController().signal, undefined, { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }) as { details: { runId: string } };
    releaseRunId(result.details.runId);
    await completion;
    assert.equal(answered, true);
    assert.equal((await new RunStore(home, "session", result.details.runId, home).load()).run.state, "completed");
  } finally {
    clearTimeout(timeout);
    RunStore.prototype.saveState = saveState;
  }
});

void test("background delivery is minimal and capped while foreground stays inline", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-delivery-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  const messages: Array<{ message: { content: string }; options: { deliverAs: string; triggerTurn: boolean } }> = [];
  let markDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => { markDelivered = resolve; });
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {},
    getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"],
    sendMessage(message: { content: string }, options: { deliverAs: string; triggerTurn: boolean }) { messages.push({ message, options }); markDelivered(); }
  };
  workflowExtension(pi as never, home);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const ctx = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const background = await execute("id", { script: `export const meta={name:"large",description:"large"}; return "😀".repeat(5000);` }, new AbortController().signal, undefined, ctx);
  assert.match(background.content[0]?.text ?? "", /"state":"running"/);
  await delivered;
  assert.equal(messages.length, 1);
  assert.ok(Buffer.byteLength(messages[0]?.message.content ?? "") <= 4096);
  assert.doesNotMatch(messages[0]?.message.content ?? "", /�/);
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

void test("run lifecycle waits for resume before awaiting input and wakes on resolution", async () => {
  const pausedStates: string[] = [];
  const paused = new RunLifecycle("running", (state) => { pausedStates.push(state); });
  await paused.pause();
  let awaiting = false;
  const transition = paused.enterAwaitingInput().then(() => { awaiting = true; });
  assert.equal(awaiting, false);
  await paused.resume();
  await transition;
  assert.equal(paused.state, "awaiting_input");
  assert.deepEqual(pausedStates, ["pausing", "paused", "running", "awaiting_input"]);

  const states: string[] = [];
  const lifecycle = new RunLifecycle("running", (state) => { states.push(state); });
  await lifecycle.enterAwaitingInput();
  await lifecycle.enterAwaitingInput();
  let entered = false;
  const waiting = lifecycle.enter().then(() => { entered = true; });
  await assert.rejects(lifecycle.pause(), /Cannot pause awaiting_input/);
  assert.equal(entered, false);
  await lifecycle.resolveAwaitingInput();
  await waiting;
  await lifecycle.leave();
  assert.deepEqual(states, ["awaiting_input", "running"]);
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
  assert.deepEqual(preflight(valid.replace("openai/gpt", "openai/gpt:high"), capabilities).referenced.models, ["openai/gpt"]);
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
    [`export const meta={name:'x',description:'x'}; agent('a',{name:'n',model:'openai/gpt:turbo'})`, "UNKNOWN_MODEL"],
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

void test("AST meta parsing rejects non-literal constructs and accepts valid meta", () => {
  const valid = (s: string) => { preflight(s, capabilities); };
  const invalid = (s: string) => { assert.throws(() => preflight(s, capabilities), (e: unknown) => e instanceof WorkflowError && e.code === "INVALID_METADATA"); };
  valid(`export const meta = { name: 'ok', description: 'ok' };`);
  valid(`export const meta = { name: 'ok', description: 'ok', phases: ['a', 'b'] };`);
  valid(`export const meta = { name: 'ok', description: 'ok' }; return 1;`);
  invalid(`export const meta = { name: 'ok', description: 'ok', [Symbol()]: 1 };`);
  invalid(`export const meta = { name: 'ok', description: 'ok', ...defaults };`);
  invalid(`export const meta = { name: \`template\`, description: 'ok' };`);
  invalid(`export const meta = { name: getName(), description: 'ok' };`);
  invalid(`export const meta = { name: 'ok', description: 'ok', get phases() { return []; } };`);
  invalid(`export const meta = { name: 'ok', description: 'ok', run() {} };`);
  const deep = 'export const meta = { name: "ok", description: "ok", phases: ' + '['.repeat(10) + '1' + ']'.repeat(10) + ' };';
  invalid(deep);
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
    await phase('build'); const cp = await checkpoint({name:'gate'}); if (cp.value !== 'approved') throw new Error('rejected'); const r = await agent('echo', {name:'echo', value: args}); return r.value;`;
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
  const parallelResult = await parallelRun.result;
  assert.ok(Array.isArray(parallelResult));
  const [pFirst, pSecond, pBroken] = parallelResult as Array<{ name: string; ok: boolean; value?: JsonValue; failedAt?: string; error?: { code: string; message: string } }>;
  assert.ok(pFirst && pSecond && pBroken);
  assert.equal(pFirst.name, "first/item");
  assert.equal(pFirst.ok, true);
  assert.equal(pFirst.value, 1);
  assert.equal(pSecond.name, "second");
  assert.equal(pSecond.ok, true);
  assert.equal(pSecond.value, 2);
  assert.equal(pBroken.name, "broken");
  assert.equal(pBroken.ok, false);
  assert.ok(typeof pBroken.failedAt === "string" && /batch\/broken/.test(pBroken.failedAt));
  assert.equal(pBroken.error?.code, "AGENT_FAILED");

  const pipelineRun = runWorkflow(`export const meta={name:'x',description:'x'};
    return pipeline([{name:'one',value:1},{name:'two',value:2}],
      {name:'double',run:value=>value*2},
      {name:'reject odd',run:value=>{if(value===2)throw Object.assign(new Error('no'),{code:'AGENT_FAILED'});return value+1}},
      {name:'pipe/name'});`);
  const pipelineResult = await pipelineRun.result;
  assert.ok(Array.isArray(pipelineResult));
  const [ppOne, ppTwo] = pipelineResult as Array<{ name: string; ok: boolean; value?: JsonValue; failedAt?: string; error?: { code: string; message: string } }>;
  assert.ok(ppOne && ppTwo);
  assert.equal(ppOne.name, "one");
  assert.equal(ppOne.ok, false);
  assert.ok(typeof ppOne.failedAt === "string" && /pipe%2Fname\/one\/reject%20odd/.test(ppOne.failedAt));
  assert.equal(ppTwo.name, "two");
  assert.equal(ppTwo.ok, true);
  assert.equal(ppTwo.value, 5);

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

void test("permission-sandboxed child cannot read files, reach network, or spawn processes", async () => {
  const fsRead = runWorkflow(`export const meta={name:'x',description:'x'}; return 'leaked';`);
  assert.deepEqual(await fsRead.result, "leaked");
  const hostile = runWorkflow(`export const meta={name:'hostile',description:'hostile'}; try { const fs = globalThis.constructor.constructor('return require("node:fs")')(); return fs.readFileSync('/etc/hostname','utf8'); } catch(e) { return 'blocked:'+e.code; }`);
  const result = await hostile.result as string;
  assert.match(result, /blocked:/);
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
