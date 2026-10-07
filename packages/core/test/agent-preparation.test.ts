import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { WorkflowRegistry, registerWorkflowExtension } from "../src/registry.js";
import workflowExtension from "../src/index.js";
import { testExtensionApi } from "./support.js";
import { testTransport } from "./test-transport.js";
import { validateAgentOptions } from "../src/validation.js";
import { FairAgentScheduler, WorkflowAgentExecutor, createLocalPiSession, prepareAgentSetupForInspection, type AgentExecutionRoot } from "../src/agent-execution.js";
import { createLaunchSnapshot } from "../src/utils.js";
import { RunStore, listRunIds } from "../src/persistence.js";
import { WorkflowError, type AgentTransport, type JsonValue, type ModelSpec } from "../src/types.js";

const model: ModelSpec = { provider: "test", model: "model", thinking: "off" };
const options = (agentOptions: Record<string, JsonValue>) => ({ label: "test", workflowName: "test", agentOptions });
const transport: AgentTransport = { id: "test", async createSession() { throw new Error("inspection must not spawn"); } };
function fixture(t: TestContext): AgentExecutionRoot {
  const cwd = mkdtempSync(join(tmpdir(), "workflow-preparation-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(agentDir);
  t.after(() => { rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, agentDir, projectTrusted: false, model, tools: new Set(["read"]), knownModels: new Set(["test/model"]), availableModels: new Set(["test/model"]) };
}
void test("unknown extension options remain opaque JSON without a plugin", async (t) => {
  assert.deepEqual(validateAgentOptions({ role: 42 }), { role: 42 });
  const prepared = await prepareAgentSetupForInspection(fixture(t), "task", options({ role: 42 }), transport);
  assert.equal(prepared.failure, undefined);
  assert.deepEqual(prepared.setup.prepared.model, model);
});
void test("all loaded schemas validate before any preparation hook runs", async (t) => {
  const registry = new WorkflowRegistry();
  let calls = 0;
  registry.register({ version: "1.0.0", headline: "Test", agentPreparationHooks: {
    first: { priority: 1, prepare() { calls++; } },
    schema: { optionsSchema: { type: "object", properties: { role: { type: "string", minLength: 1 } }, additionalProperties: true }, prepare() { calls++; } },
  } });
  await assert.rejects(prepareAgentSetupForInspection({ ...fixture(t), agentPreparationHooks: registry.agentPreparationHooks() }, "task", options({ role: 42 }), transport), /schema/i);
  assert.equal(calls, 0);
});
void test("preparation precedes concrete resolution and setup, preserving append and original options", async (t) => {
  const registry = new WorkflowRegistry();
  const order: string[] = [];
  registry.register({ version: "1.0.0", headline: "Test", agentPreparationHooks: {
    second: { priority: 10, prepare(configuration) { order.push("second"); configuration.systemPromptAppend += " second"; } },
    first: { priority: 1, prepare(configuration, context) {
      order.push("first");
      assert.equal(context.mode, "inspection");
      assert.equal(context.projectTrusted, false);
      assert.ok(Object.isFrozen(context.options));
      assert.ok(Object.isFrozen(context.capabilities.tools));
      assert.deepEqual(context.options, { policy: "read" });
      configuration.model = "test/model:off";
      configuration.systemPromptAppend = "policy instructions";
      configuration.tools = ["!read", "read"];
    } },
  } });
  const prepared = await prepareAgentSetupForInspection({ ...fixture(t), agentPreparationHooks: registry.agentPreparationHooks(), agentSetupHooks: [{ name: "setup", priority: 0, setup(agent) { order.push("setup"); assert.equal(agent.sessionInput.systemPromptAppend, "policy instructions second"); } }] }, "task", options({ policy: "read" }), transport);
  assert.equal(prepared.failure, undefined);
  assert.deepEqual(order, ["first", "second", "setup"]);
  assert.equal(prepared.setup.prepared.systemPrompt, undefined);
  assert.equal(prepared.setup.prepared.systemPromptAppend, "policy instructions second");
  assert.deepEqual(prepared.setup.prepared.tools, ["read"]);
});
void test("prepared physical models need not add thinking to valid original aliases", async (t) => {
  const root = { ...fixture(t), modelAliases: { selected: "test/model" } };
  for (const agentOptions of [{ model: "selected" }, {}]) {
    const executor = new WorkflowAgentExecutor({ ...root, agentPreparationHooks: [{ name: "physical", priority: 0, prepare(configuration) { configuration.model = "test/model"; } }] });
    assert.deepEqual((await executor.prepare(options(agentOptions))).model, { provider: "test", model: "model" });
  }
  await assert.rejects(new WorkflowAgentExecutor(root).prepare(options({ model: "test/model" })), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  for (const model of [42, "", "test/model:invalid", "test/missing"]) {
    const executor = new WorkflowAgentExecutor({ ...root, agentPreparationHooks: [{ name: "invalid", priority: 0, prepare(configuration) { Object.assign(configuration, { model }); } }] });
    await assert.rejects(executor.prepare(options({})), (error: unknown) => error instanceof WorkflowError);
  }
});
void test("removed aliases are blocked before preparation for new identities, not frozen ones", async (t) => {
  const root = fixture(t);
  const store = new RunStore(root.cwd, "session", "run", root.cwd);
  await store.create({ id: "run", workflowName: "test", cwd: root.cwd, sessionId: "session", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return null", args: null, metadata: { name: "test" }, settings: { concurrency: 1 }, models: ["test/model"], tools: ["read"], schemas: [], agentConfigurations: {} }));
  const firstIdentity = { structuralPath: [], callSite: "first", occurrence: 1 };
  const first = await new WorkflowAgentExecutor({ ...root, runStore: store, modelAliases: { model: "test/model:off" } }).prepare({ ...options({ model: "model:off" }), agentIdentity: firstIdentity });
  let preparations = 0;
  const resumed = new WorkflowAgentExecutor({ ...root, runStore: store, blockedAliases: new Set(["model"]), blockedAliasTargets: { model: "test/model:off" }, agentPreparationHooks: [{ name: "physical", priority: 0, prepare(configuration) { preparations++; configuration.model = "test/model:off"; } }] });
  assert.deepEqual(await resumed.prepare({ ...options({ model: "model:off" }), agentIdentity: firstIdentity }), first);
  assert.equal(preparations, 0);
  await assert.rejects(resumed.prepare({ ...options({ model: "model:off" }), agentIdentity: { ...firstIdentity, callSite: "second" } }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL");
  assert.equal(preparations, 0);
  const pluginAlias = new WorkflowAgentExecutor({ ...root, blockedAliases: new Set(["model"]), agentPreparationHooks: [{ name: "alias", priority: 0, prepare(configuration) { configuration.model = "model:off"; } }] });
  await assert.rejects(pluginAlias.prepare(options({})), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL");
});
void test("invalid schema is rejected on registration", () => {
  const registry = new WorkflowRegistry();
  assert.throws(() => { registry.register({ version: "1.0.0", headline: "Test", agentPreparationHooks: { plugin: { optionsSchema: {}, prepare() {} } } }); }, /schema/i);
});
void test("preparation and setup cannot widen root or parent tool capabilities", async (t) => {
  const root = fixture(t);
  const warnings: string[] = [];
  const executor = new WorkflowAgentExecutor({ ...root, onResourceWarning(message) { warnings.push(message); }, agentPreparationHooks: [{ name: "policy", priority: 0, prepare(configuration) { configuration.tools = ["!*", "write"]; } }] });
  assert.deepEqual((await executor.prepare(options({}))).tools, []);
  assert.deepEqual(warnings, ["Tool selector currently matches no authorized tool: write"]);
  await assert.rejects(executor.prepare(options({ tools: ["write"] })), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
  await assert.rejects(new WorkflowAgentExecutor(root).prepare({ ...options({ tools: ["read"] }), capabilities: { tools: [], skills: [], extensions: [] } }), /prepared agent policy/);
  const prepared = await prepareAgentSetupForInspection({ ...root, agentSetupHooks: [{ name: "widen", priority: 0, setup(agent) { agent.sessionInput.tools = ["write"]; } }] }, "task", options({}), transport);
  assert.equal(prepared.failure?.error instanceof WorkflowError, true);
});
void test("consumer defaults are ordered selectors, not an authorization ceiling", async (t) => {
  const root = fixture(t);
  const agentDir = root.agentDir;
  assert.ok(agentDir);
  const extension = join(agentDir, "extensions", "authorized.js");
  mkdirSync(join(agentDir, "extensions"));
  writeFileSync(extension, "export default function() {};");
  const skill = join(agentDir, "skills", "authorized");
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, "SKILL.md"), "---\nname: authorized\ndescription: fixture\n---\nfixture");
  const executor = new WorkflowAgentExecutor({ ...root, tools: new Set(["read", "write"]), resourceSelectors: { tools: ["!*", "read"], skills: ["!*"], extensions: ["!*"] }, agentPreparationHooks: [{
    name: "inventory", priority: 0, prepare(_configuration, context) {
      assert.deepEqual(context.capabilities.tools, ["read", "write"]);
      assert.ok(context.capabilities.skills.includes("authorized"));
      assert.ok(context.capabilities.extensions.includes(extension));
    },
  }] });
  const defaults = await executor.prepare(options({}));
  assert.deepEqual(defaults.tools, ["read"]);
  assert.deepEqual(defaults.skills.slice(defaults.skills.lastIndexOf("!*") + 1), []);
  assert.deepEqual(defaults.extensions.slice(defaults.extensions.lastIndexOf("!*") + 1), []);
  const selected = await executor.prepare(options({ tools: ["write"], skills: ["authorized"], extensions: [extension] }));
  assert.deepEqual(selected.tools, ["read", "write"]);
  assert.deepEqual(selected.skills.slice(selected.skills.lastIndexOf("!*") + 1), ["authorized"]);
  assert.deepEqual(selected.extensions.slice(selected.extensions.lastIndexOf("!*") + 1), [extension]);
});

void test("frozen configurations replay without preparation hooks or alias resolution", async (t) => {
  const root = fixture(t);
  const store = new RunStore(root.cwd, "session", "run", root.cwd);
  await store.create({ id: "run", workflowName: "test", cwd: root.cwd, sessionId: "session", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return null", args: null, metadata: { name: "test" }, settings: { concurrency: 1 }, models: ["test/model"], tools: ["read"], schemas: [], agentConfigurations: {} }));
  let calls = 0;
  const executor = new WorkflowAgentExecutor({ ...root, runStore: store, modelAliases: { policy: "test/model" }, agentPreparationHooks: [{ name: "policy", priority: 0, prepare(configuration) { calls++; configuration.model = "policy:off"; configuration.systemPromptAppend = "frozen instructions"; } }] });
  const identity = { structuralPath: [], callSite: "site", occurrence: 1 };
  const first = await executor.prepare({ ...options({}), agentIdentity: identity });
  assert.equal(calls, 1);
  assert.deepEqual(Object.values((await store.load()).snapshot.agentConfigurations), [first]);
  const resumed = new WorkflowAgentExecutor({ ...root, runStore: store, modelAliases: {}, agentPreparationHooks: [{ name: "changed", priority: 0, prepare() { throw new Error("must not resolve old policy again"); } }] });
  assert.deepEqual(await resumed.prepare({ ...options({}), agentIdentity: identity }), first);
  const unavailable = new WorkflowAgentExecutor({ ...root, runStore: store, tools: new Set() });
  await assert.rejects(unavailable.prepare({ ...options({}), agentIdentity: identity }), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
});
void test("handles share a frozen configuration and inspection never persists", async (t) => {
  const root = fixture(t);
  const saved: string[] = [];
  const store = new RunStore(root.cwd, "session", "run", root.cwd);
  await store.create({ id: "run", workflowName: "test", cwd: root.cwd, sessionId: "session", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return null", args: null, metadata: { name: "test" }, settings: { concurrency: 1 }, models: ["test/model"], tools: ["read"], schemas: [], agentConfigurations: {} }));
  const save = store.saveAgentConfiguration.bind(store);
  store.saveAgentConfiguration = async (key, configuration) => { saved.push(key); await save(key, configuration); };
  const executor = new WorkflowAgentExecutor({ ...root, runStore: store });
  const identity = { structuralPath: [], callSite: "first", occurrence: 1, handle: "named" };
  await executor.prepare({ ...options({}), agentIdentity: identity });
  await executor.prepare({ ...options({}), agentIdentity: identity }, root.cwd, undefined, "inspection");
  assert.deepEqual(saved, ["handle:named"]);
});
void test("execution applies the generic prepared display label", async (t) => {
  const root = fixture(t);
  let inspected = false;
  const executor = new WorkflowAgentExecutor({ ...root, agentPreparationHooks: [{ name: "label", priority: 0, prepare(configuration) { configuration.label = "prepared-label"; } }] }, {
    id: "inspection",
    async createSession(prepared) {
      inspected = true;
      assert.equal(prepared.sessionLabel, "test:prepared-label:attempt-1");
      assert.match(prepared.initialPrompt ?? "", /Agent: prepared-label/);
      throw new Error("stopped after inspection");
    },
  });
  await assert.rejects(executor.execute("task", options({})), /stopped after inspection/);
  assert.equal(inspected, true);
});
void test("preparation can remove nested orchestration tools before session creation", async (t) => {
  const root = fixture(t);
  let inspected = false;
  const executor = new WorkflowAgentExecutor({ ...root, tools: new Set(["agent", "read"]), agentPreparationHooks: [{ name: "narrow", priority: 0, prepare(configuration) { configuration.tools = ["!*", "read"]; } }] }, {
    id: "inspection",
    async createSession(prepared) {
      inspected = true;
      assert.deepEqual(prepared.customTools, undefined);
      assert.deepEqual(prepared.tools, ["read"]);
      assert.equal(prepared.resultTool?.name, "workflow_result");
      throw new Error("stopped after inspection");
    },
  });
  const customTools = ["agent", "get_subagent_result", "steer_subagent"].map((name) => ({ name, label: name, description: name, parameters: Type.Object({}), async execute() { return { content: [], details: {} }; } }));
  await assert.rejects(executor.execute("task", options({}), undefined, customTools), /stopped after inspection/);
  assert.equal(inspected, true);
});
void test("nested nodes do not reuse their parent's logical configuration identity", async (t) => {
  const root = fixture(t);
  const scheduler = new FairAgentScheduler(async ({ signal }) => {
    await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
    throw new WorkflowError("CANCELLED", "cancelled");
  });
  scheduler.addRun("run", 1);
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: root.cwd, tools: ["agent", "read"], agentIdentity: { structuralPath: [], callSite: "parent-site", occurrence: 1 } });
  scheduler.spawn("run", "child", { label: "child", cwd: root.cwd, tools: ["read"], agentOptions: { policy: "child" } }, parent.id);
  const child = scheduler.snapshot().find(({ parentId }) => parentId === parent.id);
  assert.ok(child);
  assert.equal(child.options.agentIdentity, undefined);
  assert.deepEqual(child.options.agentOptions, { policy: "child" });
  scheduler.cancel(parent.id);
  await parent.result;
});
void test("untrusted project factories are excluded before policy discovery", async (t) => {
  const root = fixture(t);
  const extensions = join(root.cwd, ".pi", "extensions");
  mkdirSync(extensions, { recursive: true });
  const marker = join(root.cwd, "factory-loaded");
  writeFileSync(join(extensions, "project.js"), `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(marker)}, "loaded"); }`);
  const executor = new WorkflowAgentExecutor({ ...root, agentPreparationHooks: [{ name: "inventory", priority: 0, prepare(_configuration, context) { assert.ok(context.capabilities.extensions.every((path) => !path.includes("project.js"))); } }] });
  await executor.prepare(options({ extensions: ["**/*"] }));
  assert.equal(existsSync(marker), false);
});

void test("setup option overrides cannot change cwd or select an unavailable model", async (t) => {
  const root = fixture(t);
  for (const changed of [{ cwd: join(root.cwd, "outside") }, { model: "test/missing:off" }]) {
    const prepared = await prepareAgentSetupForInspection({ ...root, knownModels: new Set(["test/model", "test/missing"]), agentSetupHooks: [{ name: "override", priority: 0, setup(agent) { Object.assign(agent.options, changed); } }] }, "task", options({}), transport);
    assert.ok(prepared.failure?.error instanceof WorkflowError);
  }
});

void test("native nested calls cannot reach an excluded deferred tool", async (t) => {
  const root = fixture(t);
  let executed = false;
  const session = await createLocalPiSession({ cwd: root.cwd, agentDir: root.agentDir ?? join(root.cwd, "agent"), model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: ["bridge"], sessionLabel: "ceiling", extensionFactories: [(pi) => {
    pi.registerTool({ name: "excluded", label: "Excluded", description: "Excluded deferred fixture", exposure: "deferred", parameters: Type.Object({}), async execute() { executed = true; return { content: [{ type: "text", text: "must not execute" }], details: {} }; } });
    pi.registerTool({ name: "bridge", label: "Bridge", description: "Calls a deferred tool", parameters: Type.Object({}), async execute(_id, _params, _signal, _update, context) { const result = await context.executeTool("excluded", {}); return { content: result.result.content, details: { isError: result.isError } }; } });
  }] });
  t.after(async () => { await session.dispose(); });
  assert.deepEqual(session.getResourceInspection().diagnostics, []);
  const native = session as Omit<typeof session, "agent"> & Pick<AgentSession, "agent" | "getCallableToolNames" | "setActiveToolsByName" | "getActiveToolNames">;
  native.agent.state.messages = [{ role: "assistant", api: "openai-responses", provider: "openai-codex", model: "gpt-5.6-sol", content: [{ type: "text", text: "nested fixture" }], stopReason: "toolUse", timestamp: 0, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }];
  assert.equal(native.getCallableToolNames().includes("excluded"), false);
  native.setActiveToolsByName(["bridge", "excluded"]);
  assert.deepEqual(native.getActiveToolNames(), ["bridge"]);
  const bridge = native.agent.state.tools.find(({ name }) => name === "bridge");
  assert.ok(bridge);
  const result = await bridge.execute("bridge-call", {});
  assert.equal(executed, false);
  assert.deepEqual(result.details, { isError: true });
  assert.match(JSON.stringify(result.content), /Tool excluded not found/);
});

void test("nested agents inherit the parent's post-setup ceiling, not its frozen baseline", async (t) => {
  const root = fixture(t);
  const agentDir = root.agentDir;
  assert.ok(agentDir);
  const excludedExtension = join(agentDir, "extensions", "excluded.js");
  mkdirSync(join(agentDir, "extensions"));
  writeFileSync(excludedExtension, "export default function() {};");
  for (const name of ["kept", "secret"]) {
    const directory = join(agentDir, "skills", name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\nfixture`);
  }
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let shutdown: (() => Promise<void>) | undefined;
  const sessions: import("../src/types.js").SessionInput[] = [];
  const children: JsonValue[] = [];
  workflowExtension(testExtensionApi({
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
    on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; },
    getActiveTools: () => ["agent", "read", "write"],
  }), root.cwd, async () => {}, testTransport(async (input) => {
    sessions.push(input);
    return {
      sessionId: `session-${String(sessions.length)}`,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      async prompt() {
        if (!input.sessionLabel.includes(":parent:")) return;
        const agent = input.customTools?.find(({ name }) => name === "agent");
        const result = input.customTools?.find(({ name }) => name === "get_subagent_result");
        assert.ok(agent && result);
        for (const [label, requestedTools] of [["forbidden", ["!*", "write"]], ["allowed", ["!*", "read"]]] as const) {
          const spawned = await agent.execute(label, { prompt: label, label, tools: [...requestedTools], skills: ["*"], extensions: ["**/*"] }, new AbortController().signal, undefined, undefined as never);
          const collected = await result.execute(label, spawned.details, new AbortController().signal, undefined, undefined as never);
          children.push(collected.details as JsonValue);
        }
      },
      dispose() {},
    };
  }), agentDir);
  t.after(async () => { await shutdown?.(); });
  registerWorkflowExtension({ version: "1.0.0", headline: "Narrow parent", agentSetupHooks: {
    narrow: { setup(agent) {
      if (!agent.sessionInput.sessionLabel.includes(":parent:")) return;
      agent.sessionInput.tools = ["agent", "read"];
      const policy = agent.sessionInput.resourcePolicy;
      assert.ok(policy);
      policy.effective.skills = [...policy.effective.skills, "!secret"];
      policy.effective.extensions = [...policy.effective.extensions, `!${excludedExtension}`];
    } },
  } });
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  await workflow.execute("call", { name: "nested-ceiling", script: 'return agent("parent", {label:"parent"});', foreground: true }, new AbortController().signal, undefined, { cwd: root.cwd, hasUI: false, model: { provider: model.provider, id: model.model }, sessionManager: { getSessionId: () => "session" } });
  assert.equal(sessions.length, 2, "the forbidden child must fail before materialization");
  assert.deepEqual(sessions[0]?.tools, ["agent", "read"]);
  assert.deepEqual(sessions[1]?.tools, ["read"]);
  const childCapabilities = sessions[1].resourcePolicy?.capabilities;
  assert.ok(childCapabilities);
  assert.deepEqual(childCapabilities.skills, ["kept"]);
  assert.ok(!childCapabilities.extensions.includes(excludedExtension));
  assert.match(JSON.stringify(children[0]), /UNKNOWN_TOOL/);
  const runId = (await listRunIds(root.cwd, "session", root.cwd))[0];
  assert.ok(runId);
  const configurations = Object.values((await new RunStore(root.cwd, "session", runId, root.cwd).load()).snapshot.agentConfigurations);
  const baseline = configurations.find(({ tools }) => tools.includes("agent"));
  assert.ok(baseline);
  assert.deepEqual(baseline.tools, ["agent", "read", "write"]);
  assert.ok(baseline.skills.includes("secret"));
  assert.ok(baseline.extensions.includes(excludedExtension));
});

void test("launch-mode mutations preserve concurrent frozen preparation through resume", async (t) => {
  const root = fixture(t);
  const store = new RunStore(root.cwd, "session", "run", root.cwd);
  await store.create({ id: "run", workflowName: "test", cwd: root.cwd, sessionId: "session", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return null", args: null, metadata: { name: "test" }, launchMode: "foreground", settings: { concurrency: 1 }, models: ["test/model"], tools: ["read"], schemas: [], agentConfigurations: {} }));
  const executor = new WorkflowAgentExecutor(root);
  const configuration = await executor.prepare(options({}));
  for (const mode of ["background", "foreground"] as const) {
    await Promise.all([
      store.saveAgentConfiguration(mode, configuration),
      store.setLaunchMode(mode),
    ]);
    const loaded = await store.load();
    assert.equal(loaded.snapshot.launchMode, mode);
    assert.deepEqual(loaded.snapshot.agentConfigurations[mode], configuration);
  }
  const resumed = new WorkflowAgentExecutor({ ...root, runStore: store, agentPreparationHooks: [{ name: "changed", priority: 0, prepare() { throw new Error("must not re-resolve"); } }] });
  assert.deepEqual(await resumed.prepare({ ...options({}), agentNodeId: "background" }), configuration);
});

void test("nested preparation and SDK factories inherit setup-narrowed project trust", async (t) => {
  const root = fixture(t);
  const sdkModel: ModelSpec = { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "off" };
  const projectExtensions = join(root.cwd, ".pi", "extensions");
  const projectExtension = join(projectExtensions, "project.js");
  const marker = join(root.cwd, "project-factory-loaded");
  mkdirSync(projectExtensions, { recursive: true });
  writeFileSync(projectExtension, `import { writeFileSync } from "node:fs"; export default function() { writeFileSync(${JSON.stringify(marker)}, "loaded"); }`);
  const projectSkill = join(root.cwd, ".pi", "skills", "project-secret");
  mkdirSync(projectSkill, { recursive: true });
  writeFileSync(join(projectSkill, "SKILL.md"), "---\nname: project-secret\ndescription: fixture\n---\nsecret");
  const store = new RunStore(root.cwd, "session", "run", root.cwd);
  await store.create({ id: "run", workflowName: "test", cwd: root.cwd, sessionId: "session", state: "running", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return null", args: null, metadata: { name: "test" }, settings: { concurrency: 1 }, models: ["openai-codex/gpt-5.6-sol"], tools: ["agent", "read"], schemas: [], agentConfigurations: {} }));
  const sessions: import("../src/types.js").SessionInput[] = [];
  const preparations: Array<{ label: string; trusted: boolean }> = [];
  const observedTransport = testTransport(async (input) => {
    sessions.push(input);
    const native = await createLocalPiSession(input);
    return {
      sessionId: `session-${String(sessions.length)}`,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      getSessionStats: () => native.getSessionStats(),
      async prompt() {
        const label = input.sessionLabel.includes(":parent:") ? "child" : input.sessionLabel.includes(":child:") ? "grandchild" : undefined;
        if (!label) return;
        const agent = input.customTools?.find(({ name }) => name === "agent");
        const result = input.customTools?.find(({ name }) => name === "get_subagent_result");
        assert.ok(agent && result);
        const spawned = await agent.execute(label, { prompt: label, label, extensions: ["**/*"], skills: ["*"] }, new AbortController().signal, undefined, undefined as never);
        const collected = await result.execute(label, spawned.details, new AbortController().signal, undefined, undefined as never);
        assert.equal((collected.details as { ok: boolean }).ok, true);
      },
      async dispose() { await native.dispose(); },
    };
  });
  const executor = new WorkflowAgentExecutor({
    ...root, projectTrusted: true, model: sdkModel, tools: new Set(["agent", "read"]), knownModels: new Set(["openai-codex/gpt-5.6-sol"]), availableModels: new Set(["openai-codex/gpt-5.6-sol"]), runStore: store,
    agentPreparationHooks: [{ name: "observe", priority: 0, prepare(_configuration, context) { preparations.push({ label: String(context.options.label), trusted: context.projectTrusted }); } }],
    agentSetupHooks: [{ name: "narrow", priority: 0, setup(agent) {
      if (!agent.sessionInput.sessionLabel.includes(":parent:")) return;
      assert.ok(agent.sessionInput.resourcePolicy);
      agent.sessionInput.resourcePolicy.projectTrusted = false;
    } }],
    onAgentCapabilities: (...args) => { scheduler.setAttemptCapabilities(...args); },
  }, observedTransport);
  const scheduler = new FairAgentScheduler(async ({ id, prompt, options: { cwd, ...scheduled }, parentId, signal, setSteer }) => {
    const result = await executor.execute(prompt, { ...scheduled, workflowName: "test", agentNodeId: id, ...(parentId ? { parent: parentId, cwd } : {}), onConfiguration: (configuration) => scheduler.setConfiguration(id, configuration) }, signal, scheduler.toolsFor(id), setSteer);
    return result.value;
  }, 16, (_runId, ownership) => store.saveOwnership(ownership));
  scheduler.addRun("run", 1);
  t.after(async () => { await scheduler.cancelRun("run"); });
  const parent = scheduler.spawn("run", "parent", { label: "parent", cwd: root.cwd, tools: ["agent", "read"], agentOptions: { label: "parent" } });
  assert.equal((await parent.result).ok, true);
  assert.equal(sessions.length, 3);
  assert.equal(existsSync(marker), false, "project factory must never materialize after parent trust narrowing");
  assert.deepEqual(preparations, [{ label: "parent", trusted: true }, { label: "child", trusted: false }, { label: "grandchild", trusted: false }]);
  for (const input of sessions) {
    const policy = input.resourcePolicy;
    assert.ok(policy?.capabilities);
    assert.equal(policy.projectTrusted, false);
    assert.ok(!policy.capabilities.extensions.includes(projectExtension));
    assert.ok(!policy.capabilities.skills.includes("project-secret"));
  }
  await scheduler.flush("run");
  const configurations = Object.values((await store.load()).snapshot.agentConfigurations);
  assert.deepEqual(configurations.map(({ projectTrusted }) => projectTrusted), [true, false, false], "attempt narrowing must not mutate the parent's frozen configuration");
  const ownership = await store.loadOwnership();
  assert.deepEqual(ownership.filter(({ parentId }) => parentId !== undefined).map(({ options }) => options.projectTrusted), [false, false]);
  assert.ok(configurations[0] && configurations[1]);
  await assert.rejects(executor.prepare({ ...options({}), configuration: configurations[0], projectTrusted: false }), /lost project trust/);
  assert.deepEqual(await executor.prepare({ ...options({}), configuration: configurations[1], projectTrusted: false }), configurations[1]);
  assert.equal(preparations.length, 3, "frozen child configuration must resume without rerunning preparation");
});
