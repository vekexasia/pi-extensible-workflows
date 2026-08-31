import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import test from "node:test";
import { testExtensionApi } from "./support.js";
import workflowExtension, { createLaunchSnapshot, loadAgentDefinitions, registerWorkflowExtension, RunStore, runWorkflow, structuralPath, WorkflowError, WorkflowRegistry, type JsonValue, type WorkflowFunctionContext } from "../src/index.js";
import { loadingRegistry } from "../src/registry.js";
import { withWorkflowFunctions, workflowRunContext } from "../src/host-runtime.js";
import type { SessionInput } from "../src/agent-execution.js";
import { listRunIds } from "../src/persistence.js";
import { testTransport, type TestPiSession } from "./test-transport.js";
import { reuseExtension } from "./support.js";
import { contextualWorkflowAction } from "./support.js";
void test("registered extension functions can run as script globals with args", async () => {
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {} }));
  registerWorkflowExtension(reuseExtension);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const result = await execute("id", { name: "hello-run", script: "return await hello(args);", args: { name: "Andrea" }, foreground: true }, new AbortController().signal, undefined, { cwd: mkdtempSync(join(tmpdir(), "pi-extensible-workflows-reuse-")), model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" } });
  assert.equal(result.content[0]?.text, '"Andrea"');
});
void test("registered function schemas remain enforced inside scripts", async () => {
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {} }));
  registerWorkflowExtension({ version: "1.0.0", headline: "Schema tests", functions: { needsValue: { description: "Needs a value", input: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, output: { type: "string" }, run: (input) => typeof input.value === "string" ? input.value : "" }, badResult: { description: "Bad result", input: { type: "object", additionalProperties: false }, output: { type: "string" }, run: () => 42 } } });
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const context = { cwd: mkdtempSync(join(tmpdir(), "pi-extensible-workflows-function-schema-")), model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" } };
  await assert.rejects(execute("id", { name: "missing-value", script: "return await needsValue(args);", args: {}, foreground: true }, new AbortController().signal, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID");
  await assert.rejects(execute("id", { name: " ", script: "return await needsValue(args);", args: { value: "ok" }, foreground: true }, new AbortController().signal, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  const named = await execute("id", { name: "needs-value", script: "return await needsValue(args);", args: { value: "ok" }, foreground: true }, new AbortController().signal, undefined, context) as { content: Array<{ text: string }>; details: { run: { workflowName: string } } };
  assert.equal(named.content[0]?.text, '"ok"');
  assert.equal(named.details.run.workflowName, "needs-value");
  await assert.rejects(execute("id", { name: "bad-result", script: "return await badResult(args);", args: {}, foreground: true }, new AbortController().signal, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID");
});
void test("registered globals preserve role definitions for agent calls across retries", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-registered-role-retry-"));
  const agentDir = mkdtempSync(join(home, "agent-"));
  mkdirSync(join(agentDir, "pi-extensible-workflows", "roles"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "roles", "developer.md"), "Developer role");
  let sessions = 0;
  const createSession = async (): Promise<TestPiSession> => {
    const attempt = ++sessions;
    return { sessionId: `registered-role-${String(attempt)}`, sessionFile: `/sessions/registered-role-${String(attempt)}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => { if (attempt === 1) throw new Error("source failure"); }, steer: async () => {}, dispose() {} };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession), agentDir);
  registerWorkflowExtension({ version: "1.0.0", headline: "Registered role retry", functions: { registeredRoleRetry: { description: "Run a developer role", input: { type: "object", additionalProperties: false }, output: { type: "string" }, run: async (_input, context) => { await context.agent("work", { role: "developer", retries: 0 }); return "done"; } } } });
  const workflow = tools.find(({ name }) => name === "workflow");
  const retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(workflow && retry);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await assert.rejects(workflow.execute("source", { name: "registered-role-retry", script: "return await registeredRoleRetry(args);", args: {}, foreground: true }, new AbortController().signal, undefined, context), WorkflowError);
  const sourceId = (await listRunIds(home, "session", home))[0];
  assert.ok(sourceId);
  const source = await new RunStore(home, "session", sourceId, home).load();
  assert.deepEqual(source.snapshot.roles, { developer: { prompt: "Developer role" } });
  rmSync(join(agentDir, "pi-extensible-workflows", "roles", "developer.md"));
  const started = await retry.execute("retry", { runId: sourceId, foreground: false }, undefined, undefined, context) as { content: Array<{ text: string }> };
  const childId = (JSON.parse(started.content[0]?.text ?? "null") as { runId: string }).runId;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const child = (await new RunStore(home, "session", childId, home).load()).run;
    if (child.state === "completed") return;
    if (child.state === "failed") throw new Error(JSON.stringify(child.error));
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${childId} to complete`);
});
void test("attributes dynamic alias availability failures to the exact extension", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-alias-provenance-"));
  const agentDir = join(home, "agent");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
    workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {} }), home, undefined, undefined, agentDir);
    registerWorkflowExtension({ version: "1.0.0", headline: "Review extension", modelAliases: { review: { resolve: () => "openai/gpt" } } });
    registerWorkflowExtension({ version: "1.0.0", headline: "Reviewer extension", modelAliases: { reviewer: { resolve: () => "missing/model" } } });
    const execute = tools.find(({ name }) => name === "workflow")?.execute;
    assert.ok(execute);
    const context = { cwd: join(home, "project"), model: { provider: "openai", id: "gpt" }, modelRegistry: { getAll: () => [{ provider: "openai", id: "gpt" }], getAvailable: () => [{ provider: "openai", id: "gpt" }] }, sessionManager: { getSessionId: () => "session" } };
    await assert.rejects(execute("id", { name: "provenance", script: "return true;", foreground: true }, new AbortController().signal, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL" && error.message.includes("Reviewer extension") && !error.message.includes("Review extension"));
    loadingRegistry().freeze();
});
void test("production launch cancellation aborts a dynamic alias resolver", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-dynamic-launch-cancel-"));
  const agentDir = join(home, "agent");
  const cwd = join(home, "project");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
    workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {} }), home, undefined, undefined, agentDir);
    registerWorkflowExtension({ version: "1.0.0", headline: "Cancellation policy", modelAliases: { "cancel-model": { resolve: ({ signal }) => new Promise<string>((_resolve, reject) => { markStarted(); signal.addEventListener("abort", () => { reject(new WorkflowError("CANCELLED", "cancelled")); }, { once: true }); }) } } });
    const execute = tools.find(({ name }) => name === "workflow")?.execute;
    assert.ok(execute);
    const controller = new AbortController();
    const context = { cwd, model: { provider: "openai", id: "gpt" }, modelRegistry: { getAll: () => [{ provider: "openai", id: "gpt" }], getAvailable: () => [{ provider: "openai", id: "gpt" }] }, sessionManager: { getSessionId: () => "session" } };
    const pending = execute("id", { name: "cancel-launch", script: "return true;", foreground: true }, controller.signal, undefined, context);
    await started;
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
    loadingRegistry().freeze();
});
void test("attributes colliding dynamic alias availability failures to the validating extension", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-alias-collision-provenance-"));
  const agentDir = join(home, "agent");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {} }), home, undefined, undefined, agentDir);
  registerWorkflowExtension({ version: "1.0.0", headline: "Target extension", modelAliases: { target: { resolve: () => "openai/gpt" } } });
  registerWorkflowExtension({ version: "1.0.0", headline: "Missing target extension", modelAliases: { x: { resolve: () => "missing/target" } } });
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const context = { cwd: join(home, "project"), model: { provider: "openai", id: "gpt" }, modelRegistry: { getAll: () => [{ provider: "openai", id: "gpt" }], getAvailable: () => [{ provider: "openai", id: "gpt" }] }, sessionManager: { getSessionId: () => "session" } };
  await assert.rejects(execute("id", { name: "collision-provenance", script: "return true;", foreground: true }, new AbortController().signal, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL" && error.message.includes("Missing target extension") && !error.message.includes("Target extension"));
  loadingRegistry().freeze();
});
void test("production launches dynamic aliases through role files with precedence and thinking overrides", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-dynamic-production-"));
  const agentDir = join(home, "agent");
  const cwd = join(home, "project");
  mkdirSync(join(agentDir, "pi-extensible-workflows", "roles"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ modelAliases: { "policy-model": "openai/gpt:low" } }));
  writeFileSync(join(agentDir, "pi-extensible-workflows", "roles", "reviewer.md"), "---\nmodel: policy-chain\n---\nReview the change.");
  const inputs: SessionInput[] = [];
  let shadowedCalls = 0;
  let shutdown: (() => Promise<void>) | undefined;
  try {
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
    const createSession = async (input: SessionInput): Promise<TestPiSession> => {
      inputs.push(input);
      return { sessionId: `dynamic-${String(inputs.length)}`, sessionFile: `/sessions/dynamic-${String(inputs.length)}`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {} };
    };
    workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; } }), home, async () => {}, testTransport(createSession), agentDir);
    registerWorkflowExtension({ version: "1.0.0", headline: "Production policy", modelAliases: { "policy-model": { resolve: () => { shadowedCalls += 1; return "anthropic/opus:high"; } }, "policy-chain": { resolve: () => "policy-model" }, "direct-model": { resolve: () => "anthropic/opus:high" } } });
    const execute = tools.find(({ name }) => name === "workflow")?.execute;
    assert.ok(execute);
    const context = { cwd, model: { provider: "openai", id: "gpt" }, modelRegistry: { getAll: () => [{ provider: "openai", id: "gpt" }, { provider: "anthropic", id: "opus" }], getAvailable: () => [{ provider: "openai", id: "gpt" }, { provider: "anthropic", id: "opus" }] }, sessionManager: { getSessionId: () => "session" } };
    await execute("id", { name: "dynamic-production", script: "return { role: await agent(\"role\", { role: \"reviewer\" }), direct: await agent(\"direct\", { model: \"direct-model:medium\" }) };", foreground: true }, new AbortController().signal, undefined, context);
    assert.equal(shadowedCalls, 0);
    assert.deepEqual(inputs.map(({ model }) => model), [{ provider: "openai", model: "gpt", thinking: "low" }, { provider: "anthropic", model: "opus", thinking: "medium" }]);
    loadingRegistry().freeze();
  } finally {
    await shutdown?.();
  }
});
void test("production resume reruns dynamic aliases, replays completed work, and records drift", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-dynamic-resume-"));
  const agentDir = join(home, "agent");
  const cwd = join(home, "project");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  const script = "const replayed = await agent(\"replayed\", { model: \"dynamic-model\" }); const fresh = await agent(\"fresh\", { model: \"dynamic-model\" }); return { replayed, fresh };";
  let replayPath = "";
  await runWorkflow(script, null, { agent: async (_prompt, _options, _signal, identity) => { replayPath = structuralPath("agent", ...identity.structuralPath, `callsite:${identity.callSite}`, `occurrence:${String(identity.occurrence)}`); return "historical"; } }).result;
  const store = new RunStore(cwd, "session", "run", home);
  await store.create({ id: "run", workflowName: "dynamic-resume", cwd, sessionId: "session", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script, args: null, metadata: { name: "dynamic-resume" }, settings: { concurrency: 1, modelAliases: { "dynamic-model": "old/model" } }, modelAliases: { "dynamic-model": "old/model" }, models: ["root/model", "old/model"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  await store.complete(replayPath, "historical");
  const inputs: SessionInput[] = [];
  let resolverCalls = 0;
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    const createSession = async (input: SessionInput): Promise<TestPiSession> => {
      inputs.push(input);
      return { sessionId: `resume-${String(inputs.length)}`, sessionFile: `/sessions/resume-${String(inputs.length)}`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {} };
    };
    workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, value: { handler: (args: string, ctx: unknown) => Promise<void> }) { command = value.handler; }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession), agentDir);
    registerWorkflowExtension({ version: "1.0.0", headline: "Resume policy", modelAliases: { "dynamic-model": { resolve: () => { resolverCalls += 1; return "new/model"; } } } });
    const context = { cwd, hasUI: false, model: { provider: "root", id: "model" }, modelRegistry: { getAll: () => [{ provider: "root", id: "model" }, { provider: "old", id: "model" }, { provider: "new", id: "model" }], getAvailable: () => [{ provider: "root", id: "model" }, { provider: "new", id: "model" }] }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
    assert.ok(start && command && shutdown);
    await start({}, context);
    await contextualWorkflowAction(command, context, "run", "Resume");
    for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    const loaded = await store.load();
    assert.equal(loaded.run.state, "completed");
    assert.equal(resolverCalls, 1);
    assert.deepEqual(inputs.map(({ model }) => ({ provider: model.provider, model: model.model })), [{ provider: "new", model: "model" }]);
    assert.deepEqual(loaded.snapshot.modelAliases, { "dynamic-model": "new/model" });
    assert.deepEqual(loaded.run.events, [{ type: "warning", message: "Model alias mappings changed on resume: dynamic-model: old/model -> new/model" }]);
    loadingRegistry().freeze();
    await shutdown();
});
void test("production budget resume cancellation aborts a dynamic alias resolver", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-dynamic-resume-cancel-"));
  const agentDir = join(home, "agent");
  const cwd = join(home, "project");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  const store = new RunStore(cwd, "session", "run", home);
  await store.create({ id: "run", workflowName: "cancel-resume", cwd, sessionId: "session", state: "budget_exhausted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "cancel-resume" }, settings: { concurrency: 1, modelAliases: { "cancel-model": "root/model" } }, modelAliases: { "cancel-model": "root/model" }, models: ["root/model"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  try {
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
    workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, undefined, undefined, agentDir);
    registerWorkflowExtension({ version: "1.0.0", headline: "Resume cancellation policy", modelAliases: { "cancel-model": { resolve: ({ signal }) => new Promise<string>((_resolve, reject) => { markStarted(); signal.addEventListener("abort", () => { reject(new WorkflowError("CANCELLED", "cancelled")); }, { once: true }); }) } } });
    const resume = tools.find(({ name }) => name === "workflow_resume")?.execute;
    assert.ok(resume);
    const context = { cwd, model: { provider: "root", id: "model" }, modelRegistry: { getAll: () => [{ provider: "root", id: "model" }], getAvailable: () => [{ provider: "root", id: "model" }] }, sessionManager: { getSessionId: () => "session" } };
    await start?.({}, context);
    const controller = new AbortController();
    const pending = resume("id", { runId: "run" }, controller.signal, undefined, context);
    await started;
    controller.abort();
    await assert.rejects(pending, (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
    loadingRegistry().freeze();
  } finally {
    await shutdown?.();
  }
});
void test("inline workflow args cross the production tool boundary and omitted args become null", async () => {
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-inline-home-"));
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {} }), home);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const context = { cwd: mkdtempSync(join(tmpdir(), "pi-extensible-workflows-inline-")), model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" } };
  const withArgs = await execute("id", { name: "with-args", script: "return args.answer;", args: { answer: 42 }, foreground: true }, new AbortController().signal, undefined, context);
  assert.equal(withArgs.content[0]?.text, "42");
  const omitted = await execute("id", { name: "without-args", script: "return args;", foreground: true }, new AbortController().signal, undefined, context);
  assert.equal(omitted.content[0]?.text, "null");
});
void test("registers global functions and replays each call as one validated operation", async () => {
  const registry = new WorkflowRegistry();
  let calls = 0;
  let receivedContext: unknown;
  registry.register({
    version: "1.2.3", headline: "Git operations",
    functions: {
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
  const run = Object.freeze({ cwd: "/repo", sessionId: "session", runId: "run", workflow: Object.freeze({ name: "test" }), args: null, signal: new AbortController().signal });
  const context = { run, invoke: async () => null, agent: async () => null, shell: async () => ({ exitCode: 0, stdout: "", stderr: "" }), prompt: (template: string) => template, parallel: async () => { throw new Error("unused"); }, pipeline: async () => { throw new Error("unused"); }, withWorktree: async () => { throw new Error("unused"); }, checkpoint: async () => true, phase: () => {}, log: () => {} };
  assert.deepEqual(await registry.invokeFunction("status", { short: true }, context, "function/status/1", journal), { clean: true });
  assert.deepEqual(await registry.invokeFunction("status", { short: false }, context, "function/status/1", journal), { clean: true });
  assert.equal(calls, 1);
  saved.set("function/status/invalid-replay", { clean: "not-a-boolean" });
  await assert.rejects(registry.invokeFunction("status", { short: true }, context, "function/status/invalid-replay", journal), (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID");
  assert.equal(calls, 1);
  assert.ok(Object.isFrozen((receivedContext as { run: object }).run));
  assert.deepEqual(Object.keys(receivedContext as object).sort(), ["agent", "checkpoint", "invoke", "log", "parallel", "phase", "pipeline", "prompt", "run", "shell", "withWorktree"]);
  assert.ok(Object.isFrozen((receivedContext as { run: { workflow: object } }).run.workflow));
});
void test("registered function context.invoke validates nested calls and replays completed children", async () => {
  const registry = new WorkflowRegistry();
  let leafCalls = 0;
  registry.register({
    version: "1.0.0", headline: "Composition",
    functions: {
      leaf: { description: "Leaf", input: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, output: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, run(input) { leafCalls += 1; return { value: `leaf:${input.value as string}` }; } },
      outer: { description: "Outer", input: { type: "object", properties: { value: { type: "string" }, fail: { type: "boolean" } }, required: ["value"], additionalProperties: false }, output: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, async run(input, context) { const result = await context.invoke("leaf", { value: input.value as string }); if (input.fail === true) throw new WorkflowError("AGENT_FAILED", "outer failed"); return result; } },
    },
  });
  const saved = new Map<string, JsonValue>();
  const journal = { get: (path: string) => saved.get(path), put: (path: string, value: JsonValue) => { saved.set(path, value); } };
  const run = Object.freeze({ cwd: "/repo", sessionId: "session", runId: "run", workflow: Object.freeze({ name: "composition" }), args: null, signal: new AbortController().signal });
  const parentPath = "function/outer/1";
  const occurrences = new Map<string, number>();
  const context: WorkflowFunctionContext = { run, invoke: async (name, input) => { const key = name; const occurrence = (occurrences.get(key) ?? 0) + 1; occurrences.set(key, occurrence); return registry.invokeFunction(name, input, context, `function/nested/${name}/${String(occurrence)}`, journal); }, agent: async () => null, shell: async () => ({ exitCode: 0, stdout: "", stderr: "" }), prompt: (template: string) => template, parallel: async () => { throw new Error("unused"); }, pipeline: async () => { throw new Error("unused"); }, withWorktree: async () => { throw new Error("unused"); }, checkpoint: async () => true, phase: () => {}, log: () => {} };
  await assert.rejects(registry.invokeFunction("outer", { value: "one", fail: true }, context, parentPath, journal), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED");
  assert.equal(leafCalls, 1);
  occurrences.clear();
  await assert.rejects(registry.invokeFunction("outer", { value: "one", fail: true }, context, parentPath, journal), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED");
  assert.equal(leafCalls, 1);
  assert.deepEqual(saved.get("function/nested/leaf/1"), { value: "leaf:one" });
  await assert.rejects(context.invoke("leaf", { value: 1 }), (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID");
  await assert.rejects(context.invoke("missing", {}), (error: unknown) => error instanceof WorkflowError && error.code === "MISSING_WORKFLOW");
});
void test("host owns phase and log rejections while registered functions continue", async () => {
  const registry = new WorkflowRegistry();
  let markStarted!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const continueFunction = new Promise<void>((resolve) => { release = resolve; });
  const phaseError = new Error("phase failed");
  const logError = new Error("log failed");
  let resolvePhase!: () => void;
  let rejectPhase!: (error: unknown) => void;
  const phaseRejection = new Promise<void>((resolve, reject) => { resolvePhase = resolve; rejectPhase = reject; });
  let resolveLog!: () => void;
  let rejectLog!: (error: unknown) => void;
  const logRejection = new Promise<void>((resolve, reject) => { resolveLog = resolve; rejectLog = reject; });
  registry.register({ version: "1.0.0", headline: "Side effects", functions: {
    sideEffects: { description: "Side effects", input: { type: "object", additionalProperties: false }, output: { type: "object", additionalProperties: false }, run: async (_input, context) => { context.phase("phase"); context.log("message"); markStarted(); await continueFunction; return {}; } },
  } });
  const store = { replay: async () => undefined, complete: async () => {} } as unknown as RunStore;
  const controller = new AbortController();
  const wrapped = withWorkflowFunctions({ phase: () => phaseRejection, log: () => logRejection }, store, workflowRunContext("/repo", "session", "run", { name: "side-effects" }, null, controller.signal), registry);
  if (!wrapped.function) throw new Error("Missing function bridge");
  const events: string[] = [];
  const onUnhandled = () => { events.push("unhandledRejection"); };
  const onHandled = () => { events.push("rejectionHandled"); };
  const drainEventLoop = async (): Promise<void> => {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  };
  process.on("unhandledRejection", onUnhandled);
  process.on("rejectionHandled", onHandled);
  try {
    const invocation = wrapped.function("sideEffects", {}, controller.signal, { path: "function/sideEffects/1", structuralPath: [], occurrence: 1 });
    const rejection = assert.rejects(invocation, (error: unknown) => error === phaseError);
    await started;
    rejectPhase(phaseError);
    rejectLog(logError);
    await drainEventLoop();
    assert.deepEqual(events, []);
    release();
    await rejection;
    await drainEventLoop();
    assert.deepEqual(events, []);
  } finally {
    markStarted();
    release();
    resolvePhase();
    resolveLog();
    process.off("unhandledRejection", onUnhandled);
    process.off("rejectionHandled", onHandled);
  }
});
void test("host owns phase and log rejections when registered functions throw", async () => {
  const registry = new WorkflowRegistry();
  let markThrown!: () => void;
  const thrown = new Promise<void>((resolve) => { markThrown = resolve; });
  const phaseError = new Error("phase failed");
  const logError = new Error("log failed");
  const functionError = new Error("function failed");
  let resolvePhase!: () => void;
  let rejectPhase!: (error: unknown) => void;
  const phaseRejection = new Promise<void>((resolve, reject) => { resolvePhase = resolve; rejectPhase = reject; });
  let resolveLog!: () => void;
  let rejectLog!: (error: unknown) => void;
  const logRejection = new Promise<void>((resolve, reject) => { resolveLog = resolve; rejectLog = reject; });
  registry.register({ version: "1.0.0", headline: "Throwing side effects", functions: {
    failed: { description: "Failed function", input: { type: "object", additionalProperties: false }, output: { type: "object", additionalProperties: false }, run: (_input, context) => { context.phase("phase"); context.log("message"); try { throw functionError; } finally { markThrown(); } } },
  } });
  const store = { replay: async () => undefined, complete: async () => {} } as unknown as RunStore;
  const controller = new AbortController();
  const wrapped = withWorkflowFunctions({ phase: () => phaseRejection, log: () => logRejection }, store, workflowRunContext("/repo", "session", "run", { name: "throwing-side-effects" }, null, controller.signal), registry);
  if (!wrapped.function) throw new Error("Missing function bridge");
  const events: string[] = [];
  const onUnhandled = () => { events.push("unhandledRejection"); };
  const onHandled = () => { events.push("rejectionHandled"); };
  const drainEventLoop = async (): Promise<void> => {
    await new Promise<void>((resolve) => { setImmediate(resolve); });
    await new Promise<void>((resolve) => { setImmediate(resolve); });
  };
  process.on("unhandledRejection", onUnhandled);
  process.on("rejectionHandled", onHandled);
  try {
    const invocation = wrapped.function("failed", {}, controller.signal, { path: "function/failed/1", structuralPath: [], occurrence: 1 });
    const rejection = assert.rejects(invocation, (error: unknown) => error === functionError);
    await thrown;
    rejectPhase(phaseError);
    rejectLog(logError);
    await rejection;
    await drainEventLoop();
    assert.deepEqual(events, []);
    await drainEventLoop();
    assert.deepEqual(events, []);
  } finally {
    markThrown();
    resolvePhase();
    resolveLog();
    process.off("unhandledRejection", onUnhandled);
    process.off("rejectionHandled", onHandled);
  }
});
void test("host composes occurrence-aware nested function breadcrumbs", async () => {
  const registry = new WorkflowRegistry();
  registry.register({
    version: "1.0.0", headline: "Nested occurrence labels",
    functions: {
      inner: { description: "Inner", input: { type: "object", additionalProperties: false }, output: { type: "object", additionalProperties: false }, async run(_input, context) { await context.agent("inner"); return {}; } },
      outer: { description: "Outer", input: { type: "object", additionalProperties: false }, output: { type: "object", additionalProperties: false }, async run(_input, context) { await context.invoke("inner", {}); await context.invoke("inner", {}); return {}; } },
    },
  });
  const completed = new Map<string, JsonValue>();
  const store = {
    replay: async (path: string) => { const value = completed.get(path); return value === undefined ? undefined : { path, value }; },
    complete: async (path: string, value: JsonValue) => { completed.set(path, value); },
  } as unknown as RunStore;
  const breadcrumbs: string[] = [];
  const controller = new AbortController();
  const bridge = { agent: async (_prompt: string, _options: Readonly<Record<string, JsonValue>>, _signal: AbortSignal, identity: import("../src/types.js").AgentIdentity) => { breadcrumbs.push(identity.parentBreadcrumb ?? ""); return null; } };
  const wrapped = withWorkflowFunctions(bridge, store, workflowRunContext("/repo", "session", "run", { name: "nested" }, null, controller.signal), registry);
  if (!wrapped.function) throw new Error("Missing function bridge");
  await wrapped.function("outer", {}, controller.signal, { path: "function/outer/1", structuralPath: [], occurrence: 1 });
  await wrapped.function("outer", {}, controller.signal, { path: "function/outer/2", structuralPath: [], occurrence: 2 });
  assert.deepEqual(breadcrumbs, ["outer > inner", "outer > inner #2", "outer #2 > inner", "outer #2 > inner #2"]);
});
void test("host uses optional labels for nested function breadcrumbs", async () => {
  const registry = new WorkflowRegistry();
  registry.register({
    version: "1.0.0", headline: "Nested explicit labels",
    functions: {
      inner: { description: "Inner", input: { type: "object", additionalProperties: false }, output: { type: "object", additionalProperties: false }, async run(_input, context) { await context.agent("inner"); return {}; } },
      parent: { description: "Parent", input: { type: "object", additionalProperties: false }, output: { type: "object", additionalProperties: false }, async run(_input, context) {
        await context.invoke("inner", {}, "alpha");
        await context.invoke("inner", {}, "beta");
        await context.invoke("inner", {}, "alpha");
        await context.invoke("inner", {});
        await assert.rejects(context.invoke("inner", {}, " "), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
        return {};
      } },
    },
  });
  const completed = new Map<string, JsonValue>();
  const store = {
    replay: async (path: string) => { const value = completed.get(path); return value === undefined ? undefined : { path, value }; },
    complete: async (path: string, value: JsonValue) => { completed.set(path, value); },
  } as unknown as RunStore;
  const breadcrumbs: string[] = [];
  const controller = new AbortController();
  const bridge = { agent: async (_prompt: string, _options: Readonly<Record<string, JsonValue>>, _signal: AbortSignal, identity: import("../src/types.js").AgentIdentity) => { breadcrumbs.push(identity.parentBreadcrumb ?? ""); return null; } };
  const wrapped = withWorkflowFunctions(bridge, store, workflowRunContext("/repo", "session", "run", { name: "nested-labels" }, null, controller.signal), registry);
  if (!wrapped.function) throw new Error("Missing function bridge");
  await wrapped.function("parent", {}, controller.signal, { path: "function/parent/1", structuralPath: [], occurrence: 1 });
  assert.deepEqual(breadcrumbs, ["parent > alpha", "parent > beta", "parent > alpha #2", "parent > inner"]);
  assert.equal(completed.has("function/nested/function%2Fparent%2F1/inner/occurrence%3A5"), false);
});
void test("registered function resume keeps occurrence breadcrumbs deterministic", async () => {
  const registry = new WorkflowRegistry();
  let interrupt = true;
  registry.register({ version: "1.0.0", headline: "Resume occurrence labels", functions: {
    review: { description: "Review", input: { type: "object", additionalProperties: false }, output: { type: "string" }, async run(_input, context) {
      const result = await context.agent("developer");
      if (interrupt) { interrupt = false; throw new WorkflowError("AGENT_FAILED", "interrupt"); }
      return result;
    } },
  } });
  const journal = new Map<string, JsonValue>();
  const completedAgents = new Map<string, JsonValue>();
  const store = {
    replay: async (path: string) => { const value = journal.get(path); return value === undefined ? undefined : { path, value }; },
    complete: async (path: string, value: JsonValue) => { journal.set(path, value); },
  } as unknown as RunStore;
  const createdBreadcrumbs: string[] = [];
  const bridge = { agent: async (_prompt: string, _options: Readonly<Record<string, JsonValue>>, _signal: AbortSignal, identity: import("../src/types.js").AgentIdentity) => {
    const key = JSON.stringify([identity.structuralPath, identity.callSite, identity.occurrence]);
    const replayed = completedAgents.get(key);
    if (replayed !== undefined) return replayed;
    completedAgents.set(key, "done");
    createdBreadcrumbs.push(identity.parentBreadcrumb ?? "");
    return "done";
  } };
  const controller = new AbortController();
  const run = workflowRunContext("/repo", "session", "run", { name: "resume" }, null, controller.signal);
  const first = withWorkflowFunctions(bridge, store, run, registry);
  if (!first.function) throw new Error("Missing function bridge");
  const identity = { path: "function/review/1", structuralPath: [], occurrence: 1 } as const;
  await assert.rejects(first.function("review", {}, controller.signal, identity), (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED");
  const resumed = withWorkflowFunctions(bridge, store, run, registry);
  if (!resumed.function) throw new Error("Missing function bridge");
  await resumed.function("review", {}, controller.signal, identity);
  await resumed.function("review", {}, controller.signal, { path: "function/review/2", structuralPath: [], occurrence: 2 });
  assert.deepEqual(createdBreadcrumbs, ["review", "review #2"]);
});
void test("freezes registries and produces a deterministic flat catalog", () => {
  const registry = new WorkflowRegistry();
  const second = new WorkflowRegistry();
  assert.equal(registry.frozen, false);
  registry.register({
    version: "1.0.0", headline: "Catalog",
    functions: { inspect: { description: "Inspect", input: { type: "object" }, output: { type: "string" }, run: () => "ok" }, release: { description: "Release", input: { type: "object" }, output: { type: "string" }, run: () => "release" } },
  });
  second.register({ version: "1.0.0", headline: "Catalog", functions: { another: { description: "Release", input: { type: "object" }, output: { type: "string" }, run: () => "another" } } });
  assert.deepEqual(registry.catalog().functions.map(({ name }) => ({ name })), [{ name: "inspect" }, { name: "release" }]);
  const index = registry.catalogIndex();
  assert.deepEqual(index.functions.map(({ name, description }) => ({ name, description })), [{ name: "inspect", description: "Inspect" }, { name: "release", description: "Release" }]);
  assert.deepEqual(Object.keys(index.functions[0] ?? {}).sort(), ["description", "input", "name"]);
  assert.deepEqual(registry.catalogDetail("release"), { name: "release", version: "1.0.0", headline: "Catalog", description: "Release", input: { type: "object" }, output: { type: "string" } });
  assert.deepEqual(registry.catalogDetail("missing"), { error: { code: "NOT_FOUND", name: "missing", message: "No registered workflow function is available: missing" } });
  assert.throws(() => { registry.register({ version: "1.0.0", headline: "Duplicate", functions: { inspect: { description: "Duplicate", input: { type: "object" }, output: { type: "string" }, run: () => "duplicate" } } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "GLOBAL_COLLISION");
  registry.freeze();
  assert.equal(registry.frozen, true);
  assert.throws(() => { registry.register({ version: "1.0.0", headline: "Late", functions: { x: { description: "x", input: { type: "object" }, output: { type: "string" }, run: () => "x" } } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "REGISTRY_FROZEN");
  assert.throws(() => registry.function("release.check"), (error: unknown) => error instanceof WorkflowError && error.code === "MISSING_WORKFLOW");
});
void test("loads extension role directories as defaults beneath standard roles", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-extension-roles-"));
  const cwd = join(home, "project");
  const agentDir = join(home, "agent");
  const extensionDirectory = join(home, "extension-roles");
  const secondExtensionDirectory = join(home, "second-extension-roles");
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
  mkdirSync(join(agentDir, "pi-extensible-workflows", "roles"), { recursive: true });
  mkdirSync(extensionDirectory);
  mkdirSync(secondExtensionDirectory);
  writeFileSync(join(extensionDirectory, "packaged.md"), "---\ndescription: Packaged role\n---\nPackaged body");
  writeFileSync(join(secondExtensionDirectory, "packaged.md"), "---\ndescription: Later packaged role\n---\nLater packaged body");
  writeFileSync(join(secondExtensionDirectory, "extension-only.md"), "Extension-only body");
  writeFileSync(join(agentDir, "pi-extensible-workflows", "roles", "packaged.md"), "Global override body");
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "packaged.md"), "Project override body");
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Roles", roleDirectories: [extensionDirectory, pathToFileURL(secondExtensionDirectory)] });
  assert.deepEqual(registry.roleDirectories(), [extensionDirectory, secondExtensionDirectory]);
  assert.throws(() => loadAgentDefinitions(cwd, agentDir, true, registry.roleDirectories()), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA" && error.message.includes(extensionDirectory) && error.message.includes(secondExtensionDirectory));
  const reversed = new WorkflowRegistry();
  reversed.register({ version: "1.0.0", headline: "Roles", roleDirectories: [secondExtensionDirectory, extensionDirectory] });
  assert.throws(() => loadAgentDefinitions(cwd, agentDir, true, reversed.roleDirectories()), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA" && error.message.includes(extensionDirectory) && error.message.includes(secondExtensionDirectory));
  const roles = loadAgentDefinitions(cwd, agentDir, true, [secondExtensionDirectory]);
  assert.equal(roles["extension-only"]?.prompt, "Extension-only body");
  assert.equal(roles.packaged?.prompt, "Project override body");
  assert.throws(() => { registry.register({ version: "1.0.0", headline: "Invalid", roleDirectories: ["relative/roles"] }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => { registry.register({ version: "1.0.0", headline: "Invalid", roleDirectories: [new URL("https://example.com/roles")] }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => { registry.register({ version: "1.0.0", headline: "Invalid", roleDirectories: Array(1) }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});
void test("starter roles are fallback defaults beneath extension, global, and project roles", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-starter-role-precedence-"));
  const cwd = join(home, "project");
  const agentDir = join(home, "agent");
  const extensionDirectory = join(home, "extension-roles");
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
  mkdirSync(join(agentDir, "pi-extensible-workflows", "roles"), { recursive: true });
  mkdirSync(extensionDirectory);
  writeFileSync(join(extensionDirectory, "developer.md"), "Extension developer role");
  writeFileSync(join(agentDir, "pi-extensible-workflows", "roles", "reviewer.md"), "Global reviewer role");
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "scout.md"), "Project scout role");
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Starter roles", roleDirectories: [new URL("../starter/roles/", import.meta.url), extensionDirectory] });
  const registrations = registry.roleDirectoryRegistrations();
  assert.equal(registrations.filter(({ builtin }) => builtin === true).length, 1);
  const roles = loadAgentDefinitions(cwd, agentDir, true, registrations);
  assert.equal(roles.developer?.prompt, "Extension developer role");
  assert.equal(roles.reviewer?.prompt, "Global reviewer role");
  assert.equal(roles.scout?.prompt, "Project scout role");
});
void test("extension roles flow through host guidance, preflight, launch snapshots, and agent setup", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-extension-role-host-"));
  const cwd = join(home, "project");
  const agentDir = join(home, "agent");
  const roleDirectory = join(home, "roles");
  const roleExtension = join(home, "role-extension.ts");
  mkdirSync(roleDirectory, { recursive: true });
  writeFileSync(join(roleDirectory, "extension-reviewer.md"), `---\ndescription: Packaged review role\nmodel: anthropic/opus:high\ntools: [read, grep]\nskills: [role-skill]\nextensions: ["${roleExtension}"]\n---\nExtension prompt`);
  const inputs: SessionInput[] = [];
  const prompts: string[] = [];
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details?: unknown }> }> = [];
  let guidanceHandler: ((event: { systemPrompt: string }, ctx: { cwd: string; isProjectTrusted?: () => boolean }) => { systemPrompt?: string } | undefined) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    inputs.push(input);
    return { sessionId: input.sessionLabel, sessionFile: `/sessions/${input.sessionLabel}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async (text) => { prompts.push(text); }, steer: async () => {}, dispose() {} };
  };
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["read", "grep", "workflow"], on(name: string, candidate: unknown) { if (name === "before_agent_start") guidanceHandler = candidate as typeof guidanceHandler; if (name === "session_shutdown") shutdown = candidate as typeof shutdown; } }), home, async () => {}, testTransport(createSession), agentDir);
  registerWorkflowExtension({ version: "1.0.0", headline: "Packaged roles", roleDirectories: [pathToFileURL(roleDirectory)] });
  assert.ok(guidanceHandler);
  const guidance = guidanceHandler({ systemPrompt: "BASE SYSTEM" }, { cwd, isProjectTrusted: () => true })?.systemPrompt ?? "";
  assert.match(guidance, /`extension-reviewer`: Packaged review role/);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const result = await workflow.execute("role-launch", { name: "extension-role-launch", script: `return await agent("delegate", { role: "extension-reviewer" });`, foreground: true }, new AbortController().signal, undefined, { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, modelRegistry: { getAll: () => [{ provider: "openai", id: "gpt" }, { provider: "anthropic", id: "opus" }] }, sessionManager: { getSessionId: () => "session" } });
  const runId = (result.details as { runId?: string } | undefined)?.runId;
  assert.ok(runId);
  assert.equal(inputs.length, 1);
  const input = inputs[0];
  assert.ok(input);
  assert.deepEqual(input.model, { provider: "anthropic", model: "opus", thinking: "high" });
  assert.deepEqual(input.tools, ["read", "grep"]);
  assert.equal(input.systemPromptAppend, "Extension prompt");
  assert.deepEqual(input.resourcePolicy?.effective, { skills: ["role-skill"], extensions: [roleExtension], tools: ["read", "grep"] });
  const prompt = prompts[0];
  assert.ok(prompt);
  assert.match(prompt, /Task:\ndelegate/);
  const loaded = await new RunStore(cwd, "session", runId, home).load();
  assert.deepEqual(loaded.snapshot.agentTypes, ["extension-reviewer"]);
  assert.deepEqual(loaded.snapshot.models, ["openai/gpt", "anthropic/opus"]);
  assert.deepEqual(loaded.snapshot.tools, ["read", "grep"]);
  assert.deepEqual(loaded.snapshot.projectRoles, []);
  assert.deepEqual(loaded.snapshot.roles, { "extension-reviewer": { prompt: "Extension prompt", description: "Packaged review role", model: "anthropic/opus:high", tools: ["read", "grep"], skills: ["role-skill"], extensions: [roleExtension] } });
  await shutdown?.();
});
void test("labels standard role directory scan failures as standard roles", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-standard-role-scan-"));
  const cwd = join(home, "project");
  const agentDir = join(home, "agent");
  const roleDirectory = join(agentDir, "pi-extensible-workflows", "roles");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(roleDirectory, "not a directory");
  assert.throws(() => loadAgentDefinitions(cwd, agentDir, true, []), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA" && error.message.includes("Standard workflow role directory") && !error.message.includes("extension"));
});
void test("registers setup hooks by priority and stable name", () => {
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Hooks", agentSetupHooks: { z: { setup() {} }, a: { priority: 10, setup() {} }, early: { priority: 1, setup() {} } } });
  assert.deepEqual(registry.agentSetupHooks().map(({ name, priority }) => ({ name, priority })), [{ name: "early", priority: 1 }, { name: "a", priority: 10 }, { name: "z", priority: 10 }]);
  assert.throws(() => { registry.register({ version: "1.0.0", headline: "Duplicate", agentSetupHooks: { early: { setup() {} } } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "DUPLICATE_NAME");
  assert.throws(() => { registry.register({ version: "1.0.0", headline: "Hooks", agentSetupHooks: { bad: { priority: Number.NaN, setup() {} } } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});
void test("requires standalone agent action visibility and execution together", () => {
  for (const action of [
    { label: "Standalone", visible: () => true, run() {}, visibleStandalone: () => true },
    { label: "Standalone", visible: () => true, run() {}, runStandalone() {} },
  ]) {
    assert.throws(() => { new WorkflowRegistry().register({ version: "1.0.0", headline: "Invalid action", agentAttemptActions: { standalone: action } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  }
});
void test("shares the registry between package imports and Pi's jiti loader", () => {
  const script = `
import { createRequire } from "node:module";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { createJiti } = require(${JSON.stringify(join(process.cwd(), "../../node_modules/@earendil-works/pi-coding-agent/node_modules/jiti"))});
const native = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/src/index.js")).href)});
const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const source = await jiti.import(${JSON.stringify(join(process.cwd(), "src/index.ts"))});
native.registerWorkflowExtension({ version: "1.0.0", headline: "Loader", functions: { verify: { description: "Verify", input: { type: "object" }, output: { type: "number" }, run: () => 1 } } });
const catalog = source.workflowCatalog();
if (catalog.functions.length !== 1 || catalog.functions[0]?.name !== "verify") throw new Error(JSON.stringify(catalog));
`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), stdio: "pipe" });
});
void test("keeps workflow_catalog active after Pi session replacement", () => {
  const script = `
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
const cwd = process.cwd();
const agentDir = mkdtempSync(join(tmpdir(), "pi-workflow-catalog-reload-"));
mkdirSync(join(agentDir, "extensions"));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [cwd] }));
writeFileSync(join(agentDir, "extensions", "catalog.ts"), \`import { registerWorkflowExtension } from \${JSON.stringify(join(cwd, "dist/src/index.js"))};\\nconst extension = { version: "1.0.0", headline: "Reload", functions: { ping: { description: "Ping", input: { type: "object" }, output: { type: "string" }, run: () => "pong" } } };\\nexport default function() { registerWorkflowExtension(extension); }\`);
process.env.PI_OFFLINE = "1";
const credentials = new InMemoryCredentialStore();
const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: join(agentDir, "models.json") });
  const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime, resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }, resourceLoaderReloadOptions: { resolveProjectTrust: async () => true } });
  return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: modelRuntime.getModels()[0] }), services, diagnostics: [] };
};
const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd), sessionStartEvent: { type: "session_start", reason: "startup" } });
runtime.setRebindSession((session) => session.bindExtensions({ mode: "print" }));
await runtime.session.bindExtensions({ mode: "print" });
const catalogActive = () => runtime.session.agent.state.tools.some(({ name }) => name === "workflow_catalog");
assert.equal(catalogActive(), true);
await runtime.newSession();
assert.equal(catalogActive(), true);
await runtime.dispose();
`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), stdio: "pipe" });
});
