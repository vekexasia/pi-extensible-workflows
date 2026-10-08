import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import workflowExtension, { createLaunchSnapshot, registerWorkflowExtension, RunStore, type AgentIdentity, type AgentPreparationContext } from "../src/index.js";
import { agentIdentityPath } from "../src/execution.js";
import { FairAgentScheduler } from "../src/agent-execution.js";
import type { JsonValue } from "../src/types.js";
import { listRunIds } from "../src/persistence.js";
import { loadingRegistry } from "../src/registry.js";
import type { SessionInput } from "../src/agent-execution.js";
import { contextualWorkflowAction, testExtensionApi } from "./support.js";
import { testTransport } from "./test-transport.js";

type ToolLike = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
type PreparationView = { label: string; cwd: string; projectCwd: AgentPreparationContext["projectCwd"]; dynamicModelAliasNames: AgentPreparationContext["defaults"]["dynamicModelAliasNames"]; modelAliases: Readonly<Record<string, string>> };
const models = [{ provider: "test", id: "model" }, { provider: "test", id: "alt" }];

function fixture(t: TestContext, git: boolean): { home: string; cwd: string; agentDir: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "workflow-context-identity-")));
  const cwd = join(home, "project");
  const agentDir = join(home, "agent");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  mkdirSync(cwd);
  if (git) {
    writeFileSync(join(cwd, "README.md"), "base\n");
    execFileSync("git", ["init", "-q"], { cwd });
    execFileSync("git", ["add", "README.md"], { cwd });
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"], { cwd });
  }
  t.after(() => { rmSync(home, { recursive: true, force: true }); loadingRegistry().freeze(); });
  return { home, cwd, agentDir };
}
function hostContext(cwd: string) {
  return { cwd, hasUI: false, model: { provider: "test", id: "model" }, modelRegistry: { getAll: () => models, getAvailable: () => models }, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
}
function observePreparation(observed: PreparationView[]): void {
  registerWorkflowExtension({ version: "1.0.0", headline: "Context observer", agentPreparationHooks: { observe: { prepare(_configuration, context) {
    // Launch inspection of static calls is covered by static-model-preflight; these views describe executed agents.
    if (context.mode === "execution") observed.push({ label: String(context.options.label), cwd: context.cwd, projectCwd: context.projectCwd, dynamicModelAliasNames: context.defaults.dynamicModelAliasNames, modelAliases: context.defaults.modelAliases });
  } } } });
}

void test("nested children keep the parent's structural scope while preparing their own configuration", async (t) => {
  const { home, cwd, agentDir } = fixture(t, true);
  const tools: ToolLike[] = [];
  const sessions: SessionInput[] = [];
  const setups: Array<{ label: string; structuralPath: readonly string[]; worktreeOwner: string | undefined }> = [];
  const identities: AgentIdentity[] = [];
  const observed: PreparationView[] = [];
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({
    registerTool(tool: ToolLike) { tools.push(tool); },
    on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; },
    getActiveTools: () => ["agent", "read"],
    getThinkingLevel: () => "off",
  }), home, async () => {}, testTransport(async (input) => {
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
        for (const params of [{ prompt: "first", label: "first", model: "test/alt:off" }, { prompt: "second", label: "second" }]) {
          const spawned = await agent.execute(params.label, { ...params, label: params.label }, new AbortController().signal, undefined, undefined as never);
          const collected: { details: unknown } = await result.execute(params.label, spawned.details, new AbortController().signal, undefined, undefined as never);
          assert.equal((collected.details as { ok: boolean }).ok, true);
        }
      },
      dispose() {},
    };
  }), agentDir);
  t.after(async () => { await shutdown?.(); });
  observePreparation(observed);
  registerWorkflowExtension({ version: "1.0.0", headline: "Identity observer", agentSetupHooks: { observe: { setup(setup, context) {
    setups.push({ label: setup.sessionInput.sessionLabel.split(":")[1] ?? "", structuralPath: [...context.identity.structuralPath], worktreeOwner: context.identity.worktreeOwner });
    identities.push(structuredClone(context.identity));
  } } } });
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const script = 'return await withWorktree("wt", () => parallel("branch", { left: () => agent("parent", { label: "parent" }) }));';
  await workflow.execute("call", { name: "nested-scope", script, foreground: true }, new AbortController().signal, undefined, hostContext(cwd));

  assert.deepEqual(sessions.map(({ sessionLabel, model }) => [sessionLabel.split(":")[1], `${model.provider}/${model.model}`]), [["parent", "test/model"], ["first", "test/alt"], ["second", "test/model"]], "siblings must not reuse the parent's or each other's configuration");
  const worktreeCwd = sessions[0]?.cwd;
  assert.ok(worktreeCwd && worktreeCwd !== cwd);
  assert.deepEqual(sessions.map((input) => input.cwd), [worktreeCwd, worktreeCwd, worktreeCwd]);
  const owner = setups[0]?.worktreeOwner;
  assert.ok(owner);
  assert.deepEqual(setups, ["parent", "first", "second"].map((label) => ({ label, structuralPath: ["branch", "left"], worktreeOwner: owner })));

  const runId = (await listRunIds(cwd, "session", home))[0];
  assert.ok(runId);
  const loaded = await new RunStore(cwd, "session", runId, home).load();
  const [parentIdentity, ...childIdentities] = identities;
  assert.ok(parentIdentity);
  const parentNode = loaded.run.agents.find(({ parentId }) => parentId === undefined)?.id ?? "";
  const generation = parentNode.slice(parentNode.lastIndexOf(":") + 1);
  assert.deepEqual(childIdentities, ["first", "second"].map((label) => ({ structuralPath: ["branch", "left"], callSite: `child:${agentIdentityPath(parentIdentity)}/spawn:${generation}/${label}`, occurrence: 1, worktreeOwner: owner })), "children own their call site under the parent instead of the parent's identity");
  assert.deepEqual(loaded.run.agents.map(({ name, parentId, structuralPath, worktreeOwner }) => ({ name, child: parentId !== undefined, structuralPath, worktreeOwner })), [
    { name: "parent", child: false, structuralPath: ["branch", "left"], worktreeOwner: owner },
    { name: "first", child: true, structuralPath: ["branch", "left"], worktreeOwner: owner },
    { name: "second", child: true, structuralPath: ["branch", "left"], worktreeOwner: owner },
  ]);
  const configurations = loaded.snapshot.agentConfigurations;
  assert.equal(Object.keys(configurations).length, 3, "each agent owns one frozen configuration key");
  const children = loaded.run.agents.filter(({ parentId }) => parentId !== undefined);
  assert.deepEqual(children.map(({ id }) => configurations[id]?.model), [{ provider: "test", model: "alt", thinking: "off" }, { provider: "test", model: "model", thinking: "off" }]);
  assert.deepEqual(observed.map(({ label, cwd: preparedCwd, projectCwd }) => ({ label, preparedCwd, projectCwd })), ["parent", "first", "second"].map((label) => ({ label, preparedCwd: worktreeCwd, projectCwd: cwd })));
});

void test("preparation separates root-resolved dynamic aliases from static settings on launch and resume", async (t) => {
  const { home, cwd, agentDir } = fixture(t, false);
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ modelAliases: { fixed: "test/model", shared: "test/model" } }));
  const tools: ToolLike[] = [];
  const observed: PreparationView[] = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({
    registerTool(tool: ToolLike) { tools.push(tool); },
    registerCommand(_name: string, value: { handler: (args: string, ctx: unknown) => Promise<void> }) { command = value.handler; },
    on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; },
    getActiveTools: () => ["read"],
    getThinkingLevel: () => "off",
  }), home, async () => {}, testTransport(async () => ({ sessionId: "session-alias", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, dispose() {} })), agentDir);
  t.after(async () => { await shutdown?.(); });
  registerWorkflowExtension({ version: "1.0.0", headline: "Dynamic aliases", modelAliases: { dynamic: { resolve: () => "test/alt" }, shared: { resolve: () => "test/alt" } } });
  observePreparation(observed);
  const context = hostContext(cwd);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  await workflow.execute("call", { name: "aliases", script: 'return await agent("launch", { label: "launch" });', foreground: true }, new AbortController().signal, undefined, context);

  const script = 'return await agent("resumed", { label: "resumed" });';
  const store = new RunStore(cwd, "session", "resume-run", home);
  await store.create({ id: "resume-run", workflowName: "aliases-resume", cwd, sessionId: "session", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script, args: null, metadata: { name: "aliases-resume" }, settings: { concurrency: 1 }, models: ["test/model"], tools: [], agentConfigurations: {}, schemas: [] }));
  assert.ok(start && command);
  await start({}, context);
  await contextualWorkflowAction(command, context, "resume-run", "Resume");
  for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await store.load()).run.state, "completed");

  const expected = { dynamicModelAliasNames: ["dynamic"], modelAliases: { dynamic: "test/alt", fixed: "test/model", shared: "test/model" } };
  assert.deepEqual(observed.map(({ label, dynamicModelAliasNames, modelAliases }) => ({ label, dynamicModelAliasNames, modelAliases: { ...modelAliases } })), [{ label: "launch", ...expected }, { label: "resumed", ...expected }]);
});

void test("children of a handle turn keep the parent's scope without its handle, turn or identity key, and same-label siblings stay distinct", async (t) => {
  const { home, cwd, agentDir } = fixture(t, false);
  const tools: ToolLike[] = [];
  const identities: Array<{ label: string; identity: AgentIdentity }> = [];
  const transports: string[] = [];
  let shutdown: (() => Promise<void>) | undefined;
  let sessions = 0;
  workflowExtension(testExtensionApi({
    registerTool(tool: ToolLike) { tools.push(tool); },
    on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; },
    getActiveTools: () => ["agent", "read"],
    getThinkingLevel: () => "off",
  }), home, async () => {}, testTransport(async (input) => {
    sessions += 1;
    return {
      sessionId: `session-${String(sessions)}`,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      async prompt() {
        if (!input.sessionLabel.includes(":h:")) return;
        const agent = input.customTools?.find(({ name }) => name === "agent");
        const result = input.customTools?.find(({ name }) => name === "get_subagent_result");
        assert.ok(agent && result);
        for (const model of ["test/alt:off", "test/model:off"]) {
          const spawned = await agent.execute("spawn", { prompt: "child", label: "child", model }, new AbortController().signal, undefined, undefined as never);
          await result.execute("collect", spawned.details, new AbortController().signal, undefined, undefined as never);
        }
      },
      dispose() {},
    };
  }), agentDir);
  t.after(async () => { await shutdown?.(); });
  registerWorkflowExtension({ version: "1.0.0", headline: "Identity observer", agentSetupHooks: { observe: { setup(setup, context) {
    identities.push({ label: setup.sessionInput.sessionLabel.split(":")[1] ?? "", identity: structuredClone(context.identity) });
    const transport = setup.transport;
    setup.transport = { id: transport.id, createSession: async (prepared, transportContext) => { transports.push(agentIdentityPath(transportContext.identity)); return transport.createSession(prepared, transportContext); } };
  } } } });
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  await workflow.execute("call", { name: "handle-children", script: 'const h = agent.create({ name: "h", label: "h", tools: ["agent", "read"] }); return await h.send("turn");', foreground: true }, new AbortController().signal, undefined, hostContext(cwd));

  const parent = identities.find(({ label }) => label === "h")?.identity;
  assert.deepEqual(parent, { structuralPath: [], callSite: "handle:h", occurrence: 1, handle: "h", turn: 1 });
  const children = identities.filter(({ label }) => label === "child").map(({ identity }) => identity);
  assert.deepEqual(children, [1, 2].map((occurrence) => ({ structuralPath: [], callSite: "child:agent/handle/h/turn%3A1/spawn:1/child", occurrence })));
  const keys = [agentIdentityPath(parent), ...children.map(agentIdentityPath)];
  assert.equal(new Set(keys).size, 3, "parent and same-label siblings have distinct identity keys");
  assert.deepEqual(transports, keys, "transports see each agent's own identity");
  const runId = (await listRunIds(cwd, "session", home))[0];
  assert.ok(runId);
  const loaded = await new RunStore(cwd, "session", runId, home).load();
  assert.deepEqual(loaded.run.agents.map(({ name, parentId, handle, turn }) => ({ name, child: parentId !== undefined, handle, turn })), [
    { name: "h", child: false, handle: "h", turn: 1 },
    { name: "child", child: true, handle: undefined, turn: undefined },
    { name: "child", child: true, handle: undefined, turn: undefined },
  ]);
  const children2 = loaded.run.agents.filter(({ parentId }) => parentId !== undefined);
  assert.deepEqual(children2.map(({ id }) => loaded.snapshot.agentConfigurations[id]?.model.model), ["alt", "model"], "same-label siblings freeze independent configurations");
});

void test("a parent respawned after cold resume gives its children new identities, distinct from the pre-crash children", async () => {
  const parentIdentity = { structuralPath: ["branch"], callSite: "12:40", occurrence: 1 };
  const childPath = (scheduler: FairAgentScheduler) => {
    const child = scheduler.snapshot().find(({ parentId }) => parentId !== undefined);
    assert.ok(child?.options.agentIdentity);
    return agentIdentityPath(child.options.agentIdentity);
  };
  const first = new FairAgentScheduler(async () => new Promise<JsonValue>(() => undefined), 2);
  first.addRun("run", 2);
  const parent = first.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: ["agent"], agentIdentity: parentIdentity });
  first.spawn("run", "child", { label: "child", cwd: "/repo", tools: [] }, parent.id);
  const before = childPath(first);
  // Cold resume: the run's ownership is restored and cancelled, then the re-executed parent spawns the child again.
  const resumed = new FairAgentScheduler(async () => new Promise<JsonValue>(() => undefined), 2);
  resumed.restoreRun("run", 2, first.snapshot());
  await resumed.cancelRun("run");
  const respawned = resumed.spawn("run", "parent", { label: "parent", cwd: "/repo", tools: ["agent"], agentIdentity: parentIdentity });
  resumed.spawn("run", "child", { label: "child", cwd: "/repo", tools: [] }, respawned.id);
  const after = resumed.snapshot().filter(({ parentId }) => parentId === respawned.id).map(({ options }) => options.agentIdentity ? agentIdentityPath(options.agentIdentity) : "");
  assert.equal(after.length, 1);
  assert.notEqual(after[0], before, "the respawned child must not reuse the pre-crash child's identity");
  first.cancel(parent.id);
  resumed.cancel(respawned.id);
});
