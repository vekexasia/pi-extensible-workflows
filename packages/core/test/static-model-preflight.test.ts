import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import workflowExtension from "../src/index.js";
import { loadingRegistry, registerWorkflowExtension } from "../src/registry.js";
import { FairAgentScheduler, type SessionInput } from "../src/agent-execution.js";
import { listRunIds } from "../src/persistence.js";
import { WorkflowError, type AgentPreparationHook, type JsonValue } from "../src/types.js";
import { testExtensionApi } from "./support.js";
import { testTransport, type TestPiSession } from "./test-transport.js";

type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
type ChildOutcome = { ok: boolean; value?: JsonValue; error?: { code: string; message: string } };
const MARKER = 'await shell("printf effect > marker");';

/** A foreign error class with a core code, as an optional plugin built against its own copy of the error types throws. */
class ForeignPluginError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "ForeignPluginError"; }
}

async function launch(t: TestContext, script: string, setup: { hooks?: Record<string, AgentPreparationHook>; schemaHooks?: Record<string, AgentPreparationHook>; schemaSource?: string; functions?: Record<string, { description: string; input: JsonValue; output: JsonValue; run: (...args: never[]) => unknown }>; aliases?: Record<string, string>; parentNested?: Record<string, JsonValue>; controller?: AbortController; context?: Record<string, unknown> } = {}) {
  const home = mkdtempSync(join(tmpdir(), "workflow-static-model-preflight-"));
  const cwd = join(home, "project");
  const agentDir = join(home, "agent");
  mkdirSync(cwd);
  mkdirSync(agentDir);
  if (setup.aliases) {
    mkdirSync(join(agentDir, "pi-extensible-workflows"));
    writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ modelAliases: setup.aliases }));
  }
  t.after(() => { rmSync(home, { recursive: true, force: true }); });
  const sessions: SessionInput["model"][] = [];
  const children: ChildOutcome[] = [];
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    sessions.push(input.model);
    const messages = [{ role: "assistant", content: [{ type: "text", text: "done" }] }];
    return {
      sessionId: `session-${String(sessions.length)}`, messages, getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      async prompt() {
        if (!setup.parentNested || !input.sessionLabel.includes(":parent:")) return;
        const spawn = input.customTools?.find(({ name }) => name === "agent");
        const collect = input.customTools?.find(({ name }) => name === "get_subagent_result");
        assert.ok(spawn && collect);
        const started = await spawn.execute("spawn", { prompt: "child", label: "child", ...setup.parentNested }, new AbortController().signal, undefined, undefined as never);
        const collected = await collect.execute("collect", started.details, new AbortController().signal, undefined, undefined as never);
        children.push(collected.details as ChildOutcome);
      },
      dispose() {},
    };
  };
  const tools: Tool[] = [];
  workflowExtension(testExtensionApi({ registerTool(tool: Tool) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "off", getActiveTools: () => ["agent", "read"] }), home, async () => {}, testTransport(createSession), agentDir);
  if (setup.hooks) registerWorkflowExtension({ version: "1.0.0", headline: "Generic preparation plugin", agentPreparationHooks: setup.hooks });
  if (setup.schemaHooks) registerWorkflowExtension({ version: "1.0.0", headline: "Schema-declaring preparation plugin", ...(setup.schemaSource ? { source: setup.schemaSource } : {}), agentPreparationHooks: setup.schemaHooks });
  if (setup.functions) registerWorkflowExtension({ version: "1.0.0", headline: "Function plugin", functions: setup.functions as never });
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd, hasUI: false, model: { provider: "test", id: "model" }, modelRegistry: { getAll: () => [{ provider: "test", id: "model" }, { provider: "test", id: "other" }], getAvailable: () => [{ provider: "test", id: "model" }] }, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "session" }, ...setup.context };
  let error: unknown;
  let value: unknown;
  try { value = await workflow.execute("call", { name: "static-model", script, foreground: true }, (setup.controller ?? new AbortController()).signal, undefined, context); } catch (caught) { error = caught; }
  // Freezing lets the next launch start from a fresh registry without this launch's plugin.
  loadingRegistry().freeze();
  return { error, value, sessions, children, runs: await listRunIds(cwd, "session", home), marker: existsSync(join(cwd, "marker")) };
}
function assertFailedBeforeEffects(outcome: Awaited<ReturnType<typeof launch>>, code: string, message?: RegExp): void {
  assert.ok(outcome.error instanceof WorkflowError, `expected a WorkflowError, got ${String(outcome.error)}`);
  assert.equal(outcome.error.code, code, outcome.error.message);
  if (message) assert.match(outcome.error.message, message);
  assert.equal(outcome.marker, false, "shell side effect ran before the static model failure");
  assert.deepEqual(outcome.runs, [], "run was persisted before the static model failure");
  assert.deepEqual(outcome.sessions, []);
}
const selectModel: AgentPreparationHook = {
  prepare(configuration, context) {
    if (context.options.model === "shared") configuration.model = "test/model:off";
    if (context.options.model === "shared-unavailable") configuration.model = "test/other:off";
    if (context.options.persona === "slow") configuration.model = "test/other:off";
  },
};

void test("static unavailable model references fail before shell effects or run persistence", async (t) => {
  const cases: Array<[string, RegExp?]> = [
    ['agent("x", { model: "nosuchalias" })', /nosuchalias/],
    ['agent("x", { model: "test/missing:off" })'],
    ['agent("x", { model: "test/other:off" })', /^The workflow requested the unavailable model test\/other\.$/],
    ['agent("x", { model: "core" })'],
    ['agent.create({ name: "handle", model: "test/other:off" }).send("x")'],
  ];
  for (const [call, message] of cases) assertFailedBeforeEffects(await launch(t, `${MARKER} return await ${call};`, { aliases: { core: "test/other:off" } }), "UNKNOWN_MODEL", message);
});

void test("static model inspection asks preparation plugins without freezing or duplicating effects", async (t) => {
  const modes: string[] = [];
  const recording: AgentPreparationHook = { prepare(configuration, context) { modes.push(context.mode); return selectModel.prepare(configuration, context); } };
  const accepted = await launch(t, `${MARKER} return await agent("x", { model: "shared" });`, { hooks: { select: recording } });
  assert.equal(accepted.error, undefined, String(accepted.error));
  assert.equal(accepted.marker, true);
  assert.deepEqual(accepted.sessions, [{ provider: "test", model: "model", thinking: "off" }]);
  assert.deepEqual(modes, ["inspection", "execution"]);
  assertFailedBeforeEffects(await launch(t, `${MARKER} return await agent("x", { model: "shared" });`), "UNKNOWN_MODEL", /shared/);
  assertFailedBeforeEffects(await launch(t, `${MARKER} return await agent("x", { model: "shared-unavailable" });`, { hooks: { select: selectModel } }), "UNKNOWN_MODEL", /test\/other/);
  assertFailedBeforeEffects(await launch(t, `${MARKER} return await agent.create({ name: "slow", persona: "slow" }).send("x");`, { hooks: { select: selectModel } }), "UNKNOWN_MODEL", /test\/other/);
});

void test("dynamic model references remain runtime failures after earlier effects", async (t) => {
  // Any dynamic option, including one only a hook reads, leaves the whole call to runtime.
  for (const [hooks, call] of [[undefined, 'agent("x", { model })'], [{ select: selectModel }, 'agent("x", { model })'], [undefined, 'agent("x", { model: "test/other:off", label: ["dynamic", "label"].join("-") })']] as const) {
    const outcome = await launch(t, `const model = ["test", "other:off"].join("/"); ${MARKER} return await ${call};`, hooks ? { hooks } : {});
    assert.ok(outcome.error instanceof WorkflowError);
    assert.equal(outcome.error.code, "UNKNOWN_MODEL");
    assert.equal(outcome.marker, true);
    assert.equal(outcome.runs.length, 1);
    assert.deepEqual(outcome.sessions, []);
  }
});

void test("nested child failures keep known core codes from any error class and AGENT_FAILED otherwise", async (t) => {
  const parent = 'return await agent("parent", { label: "parent" });';
  const throwing = (error: unknown): Record<string, AgentPreparationHook> => ({ fail: { prepare(_configuration, context) { if (context.options.label === "child") throw error; } } });
  const core = await launch(t, parent, { parentNested: { model: "test/missing:off" } });
  assert.equal(core.children[0]?.error?.code, "UNKNOWN_MODEL");
  const foreign = await launch(t, parent, { parentNested: {}, hooks: throwing(new ForeignPluginError("UNKNOWN_MODEL", "Unknown model plugin-alias resolved to test/other")) });
  assert.deepEqual(foreign.children[0]?.error, { code: "UNKNOWN_MODEL", message: "Unknown model plugin-alias resolved to test/other" });
  const plain = await launch(t, parent, { parentNested: {}, hooks: throwing(new Error("plain failure")) });
  assert.deepEqual(plain.children[0]?.error, { code: "AGENT_FAILED", message: "plain failure" });
  const unknownCode = await launch(t, parent, { parentNested: {}, hooks: throwing(new ForeignPluginError("NOT_A_WORKFLOW_CODE", "unknown code")) });
  assert.deepEqual(unknownCode.children[0]?.error, { code: "AGENT_FAILED", message: "unknown code" });
  // Only core drives cancellation and budget state: foreign claims of those codes are ordinary failures that the parent collects.
  for (const code of ["CANCELLED", "BUDGET_EXHAUSTED"]) {
    const control = await launch(t, parent, { parentNested: {}, hooks: throwing(new ForeignPluginError(code, `foreign ${code}`)) });
    assert.equal(control.error, undefined, `${code}: ${String(control.error)}`);
    assert.deepEqual(control.children[0]?.error, { code: "AGENT_FAILED", message: `foreign ${code}` });
  }
});

void test("scheduler launch admission keeps core codes but never adopts foreign control codes", async () => {
  for (const [error, code] of [[new WorkflowError("BUDGET_EXHAUSTED", "core budget"), "BUDGET_EXHAUSTED"], [new ForeignPluginError("BUDGET_EXHAUSTED", "foreign budget"), "AGENT_FAILED"], [new ForeignPluginError("CANCELLED", "foreign cancel"), "AGENT_FAILED"], [new ForeignPluginError("UNKNOWN_MODEL", "foreign model"), "UNKNOWN_MODEL"], [new Error("plain admission"), "AGENT_FAILED"]] as const) {
    const scheduler = new FairAgentScheduler(async () => "never");
    scheduler.addRun("run", 1, () => { throw error; });
    const spawned = scheduler.spawn("run", "task", { label: "task", cwd: tmpdir(), tools: [] });
    const result = await spawned.result;
    assert.deepEqual(result, { id: spawned.id, ok: false, error: { code, message: error.message } });
  }
});

void test("unreachable static calls are inspected too, as before 6.0, and identical option objects only once", async (t) => {
  assertFailedBeforeEffects(await launch(t, `${MARKER} if (args === "never") await agent("x", { model: "test/other:off" }); return null;`), "UNKNOWN_MODEL", /test\/other/);
  const modes: string[] = [];
  const counting: AgentPreparationHook = { prepare(_configuration, context) { modes.push(context.mode); } };
  const outcome = await launch(t, 'await agent("a", { model: "test/model:off" }); await agent("b", { model: "test/model:off" }); return await agent("c", { model: "test/model:off", label: "other" });', { hooks: { counting } });
  assert.equal(outcome.error, undefined, String(outcome.error));
  assert.deepEqual(modes, ["inspection", "inspection", "execution", "execution", "execution"], "two distinct static option objects, three executions");
});

void test("a hook reading a dynamic label sees the same options whether the object is literal or a variable", async (t) => {
  const byLabel: AgentPreparationHook = { prepare(configuration, context) { configuration.model = context.options.label === "cheap" ? "test/model:off" : "test/other:off"; } };
  for (const script of ['const label = "cheap"; return await agent("x", { label });', 'const options = { label: "cheap" }; return await agent("x", options);', 'return await agent("x", { label: "cheap" });']) {
    const outcome = await launch(t, script, { hooks: { byLabel } });
    assert.equal(outcome.error, undefined, `${script}: ${String(outcome.error)}`);
    assert.deepEqual(outcome.sessions, [{ provider: "test", model: "model", thinking: "off" }], script);
    assert.equal(outcome.runs.length, 1, script);
  }
});

void test("every preparation failure of a static call stops launch before effects, keeping the failure's code and diagnostics", async (t) => {
  const failing: AgentPreparationHook = { prepare(_configuration, context) {
    if (context.options.persona === "missing") throw new ForeignPluginError("INVALID_METADATA", "Unknown agent role: reviwer");
    if (context.options.persona === "foreign") throw new ForeignPluginError("PLUGIN_ONLY_CODE", "plugin diagnostic survives");
    if (context.options.persona === "plain") throw new Error("plain plugin failure");
  } };
  assertFailedBeforeEffects(await launch(t, `${MARKER} return await agent("x", { persona: "missing" });`, { hooks: { failing } }), "INVALID_METADATA", /Unknown agent role: reviwer/);
  assertFailedBeforeEffects(await launch(t, `${MARKER} return await agent("x", { persona: "foreign" });`, { hooks: { failing } }), "INTERNAL_ERROR", /plugin diagnostic survives/);
  assertFailedBeforeEffects(await launch(t, `${MARKER} return await agent("x", { persona: "plain" });`, { hooks: { failing } }), "INTERNAL_ERROR", /plain plugin failure/);
  assertFailedBeforeEffects(await launch(t, `${MARKER} return await agent("x", { tools: ["!*", "nosuchtool"] });`), "UNKNOWN_TOOL", /nosuchtool/);
  assertFailedBeforeEffects(await launch(t, `${MARKER} return await agent("x", { excludeTools: ["workflow_result"] });`), "INVALID_METADATA", /workflow_result/);
});

void test("cancelling launch during inspection stops remaining inspections before any lease, run or effect", async (t) => {
  const controller = new AbortController();
  const inspected: string[] = [];
  const aborting: AgentPreparationHook = { prepare(_configuration, context) {
    if (context.mode !== "inspection") return;
    inspected.push(JSON.stringify(context.options.persona));
    controller.abort();
  } };
  const outcome = await launch(t, `${MARKER} await agent("x", { persona: "first" }); return await agent("y", { persona: "second" });`, { hooks: { aborting }, controller });
  assertFailedBeforeEffects(outcome, "CANCELLED");
  assert.deepEqual(inspected, ['"first"'], "the second static configuration was still inspected after cancellation");
});

void test("after an extension load failure, agent options without a schema proven to have loaded fail closed", async (t) => {
  const loadedPath = join(tmpdir(), "persona-extension.mjs");
  const context = { extensionLoadErrors: ["/extensions/broken.mjs: E2E_BROKEN"], loadedExtensionPaths: [loadedPath] };
  const failed = await launch(t, `${MARKER} return await agent("x", { persona: "auditor" });`, { context });
  assertFailedBeforeEffects(failed, "INVALID_METADATA", /persona[\s\S]*broken\.mjs: E2E_BROKEN/);
  const declared: AgentPreparationHook = { optionsSchema: { type: "object", properties: { persona: { type: "string" } }, additionalProperties: true }, prepare() {} };
  const owned = await launch(t, `${MARKER} return await agent("x", { persona: "auditor" });`, { context, schemaHooks: { declared }, schemaSource: pathToFileURL(loadedPath).href });
  assert.equal(owned.error, undefined, String(owned.error));
  assert.equal(owned.marker, true);
  // A factory that registered its hook and then failed leaves an orphaned registration: it proves nothing.
  for (const schemaSource of [undefined, pathToFileURL("/extensions/broken.mjs").href]) {
    const orphan = await launch(t, `${MARKER} return await agent("x", { persona: "auditor" });`, { context, schemaHooks: { declared }, ...(schemaSource ? { schemaSource } : {}) });
    assertFailedBeforeEffects(orphan, "INVALID_METADATA", /persona has no owner proven to have loaded/);
  }
  const coreOnly = await launch(t, `${MARKER} return await agent("x", { label: "core", model: "test/model:off", excludeTools: ["read"] });`, { context });
  assert.equal(coreOnly.error, undefined, String(coreOnly.error));
  // Without a load failure an option without an owner is ignored, as with an intentionally absent plugin.
  const absent = await launch(t, `${MARKER} return await agent("x", { persona: "auditor" });`);
  assert.equal(absent.error, undefined, String(absent.error));
  const dynamic = await launch(t, `const persona = ["aud", "itor"].join(""); ${MARKER} return await agent("x", { persona });`, { context });
  assert.ok(dynamic.error instanceof WorkflowError && dynamic.error.code === "INVALID_METADATA", String(dynamic.error));
  assert.equal(dynamic.marker, true, "dynamic options fail closed at runtime");
  assert.deepEqual(dynamic.sessions, []);
});

void test("cancellation after the last inspection, while the session lease is pending, creates no run", async (t) => {
  const controller = new AbortController();
  const delayed: AgentPreparationHook = { prepare(_configuration, context) { if (context.mode === "inspection") setImmediate(() => { controller.abort(); }); } };
  assertFailedBeforeEffects(await launch(t, `${MARKER} return await agent("x", { persona: "only" });`, { hooks: { delayed }, controller }), "CANCELLED");
});

void test("handle inspection uses the create options only when no send can add preparation options", async (t) => {
  const byTimeout: AgentPreparationHook = { prepare(configuration, context) { configuration.model = context.options.timeoutMs === 60000 ? "test/model:off" : "test/other:off"; } };
  for (const script of [
    'const h = agent.create({ name: "h" }); return await h.send("task", { timeoutMs: 60000 });',
    'const h = agent.create({ name: "h", timeoutMs: 60000 }); return await h.send("task");',
    // Indirect sends cannot be proven option-free, so the handle is left to runtime.
    'const h = agent.create({ name: "h" }); const method = "send"; return await h[method]("task", { timeoutMs: 60000 });',
    'const { send } = agent.create({ name: "h" }); return await send("task", { timeoutMs: 60000 });',
    'const h = agent.create({ name: "h" }); const alias = h; return await alias.send("task", { timeoutMs: 60000 });',
  ]) {
    const outcome = await launch(t, script, { hooks: { byTimeout } });
    assert.equal(outcome.error, undefined, `${script}: ${String(outcome.error)}`);
    assert.deepEqual(outcome.sessions, [{ provider: "test", model: "model", thinking: "off" }], script);
  }
  assertFailedBeforeEffects(await launch(t, `${MARKER} const h = agent.create({ name: "h" }); return await h.send("task");`, { hooks: { byTimeout } }), "UNKNOWN_MODEL", /test\/other/);
  assertFailedBeforeEffects(await launch(t, `${MARKER} return await agent.create({ name: "h" }).send("task");`, { hooks: { byTimeout } }), "UNKNOWN_MODEL", /test\/other/);
});

void test("agents inside called registered functions are inspected before launch, even with a computed outputSchema", async (t) => {
  const byRole: AgentPreparationHook = { prepare(configuration, context) { if (context.options.role === "reviewer") configuration.model = "test/other:off"; } };
  const reviewLoop = { description: "loop", input: { type: "object", additionalProperties: false }, output: { type: "null" }, async run(_input: unknown, { agent }: { agent: (prompt: string, options: Record<string, unknown>) => Promise<unknown> }) {
    const schema = { type: "object" };
    await agent("dev", { role: "developer" });
    await agent("review", { role: "reviewer", outputSchema: schema });
    return null;
  } };
  assertFailedBeforeEffects(await launch(t, `${MARKER} return await reviewLoop({});`, { hooks: { byRole }, functions: { reviewLoop } }), "UNKNOWN_MODEL", /test\/other/);
});
