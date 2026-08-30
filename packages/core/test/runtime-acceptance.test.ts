import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callUnchecked, contextualWorkflowAction, executeTool, executeToolCall, testExtensionContext, testExtensionContextFor, testExtensionApi } from "./support.js";
import { Type } from "@earendil-works/pi-ai";
import workflowExtension, { createLaunchSnapshot, FairAgentScheduler, formatNavigatorDashboard, formatNavigatorRun, loadingRegistry, localAgentTransport, persistActiveAgentAttempt, persistAgentAttempts, registerWorkflowExtension, runWorkflow, shellIdentityPath, structuralPath, WorkflowAgentExecutor, WorkflowError, type JsonValue, type WorkflowExtension } from "../src/index.js";
import { createLocalPiSession } from "../src/agent-execution.js";
import { listRunIds, runsDirectory, RunStore } from "../src/persistence.js";
import type { SessionInput } from "../src/agent-execution.js";
function sessionStats(cost = 0.25) { return { tokens: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, total: 14 }, cost }; }
async function waitForRunState(store: RunStore, state: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let current: string | undefined;
  while (Date.now() < deadline) {
    current = (await store.load()).run.state;
    if (current === state) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out waiting for run state ${state}; last observed state was ${current ?? "unknown"}`);
}
let acceptanceFunctionCalls = 0;
const acceptanceExtension: WorkflowExtension = {
  version: "1.0.0", headline: "Acceptance",
  functions: {
    echo: { description: "Echo once", input: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, output: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, run(input, context) { acceptanceFunctionCalls += 1; return { value: context.prompt("{value}", { value: input.value as string }) }; } },
    orchestrate: {
      description: "Exercise host combinators", input: { type: "object", additionalProperties: false }, output: { type: "object" },
      async run(_input, context) {
        const parallel = await context.parallel("host-parallel", { first: () => 1, second: () => 2 });
        const pipeline = await context.pipeline("host-pipeline", { first: 1, second: 2 }, { double: (value: number) => value * 2 });
        let parallelWaited = false;
        let parallelFailure!: WorkflowError;
        try { await context.parallel("host-failure", { first: () => { throw new WorkflowError("AGENT_FAILED", "host parallel failed"); }, second: async () => { await Promise.resolve(); parallelWaited = true; return 2; } }); }
        catch (error) { parallelFailure = error as WorkflowError; }
        let pipelineWaited = false;
        try { await context.pipeline("host-pipeline-failure", { first: 1, second: 2 }, { fail: (value: number) => { if (value === 1) throw new WorkflowError("RESULT_INVALID", "host pipeline failed"); return value; }, finish: async (value: number) => { await Promise.resolve(); pipelineWaited = true; return value; } }); }
        catch (error) { return { parallel, pipeline, parallelWaited, parallelCode: parallelFailure.code, pipelineWaited, pipelineCode: (error as WorkflowError).code }; }
        throw new Error("expected host pipeline failure");
      },
    },
  },
};
function registerAcceptanceExtension(): void { registerWorkflowExtension(acceptanceExtension); }
import { testTransport, type TestPiSession } from "./test-transport.js";
void test("production session_start cold-restores ownership and /workflow stop cascades", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-acceptance-"));
  const cwd = join(home, "project");
  const sessionId = "session-a";
  const runId = "run-a";
  const store = new RunStore(cwd, sessionId, runId, home);
  const settings = { concurrency: 1 };
  await store.create({ id: runId, workflowName: "cold", cwd, sessionId, state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "export const meta={name:'cold',description:'cold'}", args: null, metadata: { name: "cold", description: "cold" }, settings, models: ["openai-codex/gpt-5.6-sol"], tools: ["agent"], agentTypes: [], roles: {}, schemas: [] }));
  const parentOptions = { label: "parent", cwd, tools: ["agent"], model: "runtime/runtime-model" };
  await store.saveOwnership([{ id: `${runId}:1`, label: "parent", state: "waiting_for_child", options: parentOptions }, { id: `${runId}:2`, parentId: `${runId}:1`, label: "child", state: "running", options: { label: "child", cwd, tools: [], model: "runtime/runtime-model" } }]);

  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const notices: string[] = [];
  const ctx = { cwd, model: { provider: "openai-codex", id: "gpt-5.6-sol" }, sessionManager: { getSessionId: () => sessionId }, ui: { notify: (message: string) => { notices.push(message); } } };
  workflowExtension(testExtensionApi({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  assert.ok(start && command && shutdown);
  await start({}, ctx);
  await contextualWorkflowAction(command, ctx, runId, "Stop");
  assert.equal((await store.load()).run.state, "stopped");
  assert.deepEqual((await store.loadOwnership()).map(({ state }) => state), ["cancelled", "cancelled"]);
  assert.deepEqual((await store.load()).run.agents.map(({ state }) => state), ["cancelled", "cancelled"]);
  assert.deepEqual((await store.load()).run.agents.map(({ model, tools }) => ({ model, tools })), [{ model: { provider: "runtime", model: "runtime-model", thinking: "medium" }, tools: ["agent"] }, { model: { provider: "runtime", model: "runtime-model", thinking: "medium" }, tools: [] }]);
  assert.deepEqual(notices, [`Stopped workflow ${runId}.`]);
  await shutdown();
});
void test("failed session_start releases workflow registry ownership", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-session-start-failure-"));
  const cwd = join(home, "project");
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  assert.ok(start);
  const failingContext = { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => { throw new Error("startup failed"); } }, ui: { notify() {} } };
  await assert.rejects(start({}, failingContext), /startup failed/);
  let recoveredStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let recoveredShutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") recoveredStart = handler as typeof recoveredStart; if (name === "session_shutdown") recoveredShutdown = handler as typeof recoveredShutdown; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  registerWorkflowExtension({ version: "1.0.0", headline: "Recovery", functions: { afterFailure: { description: "Verify recovery", input: { type: "object", additionalProperties: false }, output: { type: "string" }, run: () => "recovered" } } });
  assert.ok(recoveredStart && recoveredShutdown);
  const recoveredContext = { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
  await recoveredStart({}, recoveredContext);
  assert.ok(loadingRegistry().function("afterFailure"));
  await recoveredShutdown();
});

void test("session recovery skips a partial run without hiding a valid /workflow resume", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-partial-recovery-"));
  const cwd = join(home, "project");
  const sessionId = "session-a";
  const runId = "valid-run";
  const store = new RunStore(cwd, sessionId, runId, home);
  await store.create({ id: runId, workflowName: "valid", cwd, sessionId, state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return await agent('resume me');", args: null, metadata: { name: "valid" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: ["agent"], agentTypes: [], roles: {}, schemas: [] }));
  const corruptId = "partial-run";
  const corruptDirectory = join(runsDirectory(cwd, sessionId, home), corruptId);
  mkdirSync(corruptDirectory, { recursive: true });
  writeFileSync(join(corruptDirectory, "state.json"), "{");

  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const notices: string[] = [];
  const ctx = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => sessionId }, ui: { notify: (message: string) => { notices.push(message); } } };
  const createSession = async (input: SessionInput): Promise<TestPiSession> => ({ sessionId: `resume-${input.sessionLabel}`, sessionFile: `/sessions/${input.sessionLabel}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "resumed" }] }], getSessionStats: sessionStats, prompt: async () => {}, dispose() {} });
  workflowExtension(testExtensionApi({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["agent", "workflow"] }), home, async () => {}, testTransport(createSession));
  assert.ok(start && command && shutdown);
  try {
    await start({}, ctx);
    assert.deepEqual(await listRunIds(cwd, sessionId, home), [runId]);
    await command("", ctx);
    assert.ok(notices.some((message) => message.includes("Workflow: valid") && message.includes("Status: interrupted")));
    await contextualWorkflowAction(command, ctx, runId, "Resume");
    await waitForRunState(store, "completed");
  } finally {
    await shutdown();
  }
});
void test("cold resume keeps active shell in persisted phase occurrence", { timeout: 10_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-phase-shell-resume-"));
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  const sessionId = "session-a";
  const runId = "run-a";
  const store = new RunStore(cwd, sessionId, runId, home);
  const command = `${process.execPath} -e ${JSON.stringify("setTimeout(() => {}, 2000)")}`;
  const script = `phase("build"); await shell(${JSON.stringify(command)}); return true;`;
  await store.create({ id: runId, workflowName: "phase-shell-resume", cwd, sessionId, state: "interrupted", phase: "build", phaseHistory: [{ phase: "build", afterAgent: 0 }, { phase: "verify", afterAgent: 0 }, { phase: "build", afterAgent: 0 }], phaseHistoryIndex: 0, agents: [], agentSessions: [] }, createLaunchSnapshot({ script, args: null, metadata: { name: "phase-shell-resume" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let commandHandler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => sessionId }, ui: { notify() {} } };
  workflowExtension(testExtensionApi({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof commandHandler> }) { commandHandler = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  assert.ok(start && commandHandler && shutdown);
  try {
    await start({}, context);
    const resuming = contextualWorkflowAction(commandHandler, context, runId, "Resume", "Background");
    let active: Awaited<ReturnType<typeof store.load>>["run"] | undefined;
    for (let attempt = 0; attempt < 200 && !active; attempt += 1) {
      const current = (await store.load()).run;
      if (current.activeShellsByPhase?.length) active = current; else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(active);
    assert.deepEqual(active.activeShellsByPhase?.map(({ phaseIndex, active: count }) => [phaseIndex, count]), [[0, 1]]);
    assert.equal(active.phaseHistoryIndex, 0);
    await resuming;
    await waitForRunState(store, "completed");
  } finally {
    await shutdown();
  }
});
void test("cold resume persists effective role, fallback, nested, retry, and explicit policies", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-policy-reporting-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  const script = "const role = await agent(\"top role\", { role: \"reviewer\" }); const named = await agent(\"named\", { label: \"API inspection\" }); const parent = await agent(\"nested policies\"); return { role, named, parent };";
  const role = { prompt: "Review role", model: "role-provider/role-model:high", tools: ["!*", "read"], skills: ["role-only"], extensions: [join(home, "role-only.ts")] };
  const snapshot = createLaunchSnapshot({ script, args: null, metadata: { name: "policy-reporting" }, settings: { concurrency: 2 }, models: ["root-provider/root-model", "role-provider/role-model", "case-provider/model-only", "case-provider/model-and-thinking"], tools: ["agent", "read"], agentTypes: ["reviewer"], roles: { reviewer: role }, schemas: [] });
  await store.create({ id: "run-a", workflowName: "policy-reporting", cwd, sessionId: "session-a", state: "interrupted", agents: [], agentSessions: [] }, snapshot);
  await store.saveOwnership([]);
  const inputs = new Map<string, SessionInput>();
  let nextSession = 0;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    const sessionId = `native-${String(++nextSession)}`;
    inputs.set(sessionId, input);
    const invokeTool = async (name: string, params: Record<string, unknown>): Promise<unknown> => {
      const tool = input.customTools?.find(({ name: candidate }) => candidate === name);
      assert.ok(tool);
      return executeTool(tool, sessionId, params, testExtensionContext);
    };
    const collectChild = async (options: Record<string, unknown>): Promise<void> => {
      const spawned = await invokeTool("agent", options) as { content?: Array<{ text?: string }> };
      const childId = (JSON.parse(spawned.content?.[0]?.text ?? "{}") as { id?: string }).id;
      assert.ok(childId);
      await invokeTool("get_subagent_result", { id: childId });
    };
    return {
      sessionId,
      sessionFile: `/sessions/${sessionId}.jsonl`,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: sessionStats,
      prompt: async () => {
        if (input.sessionLabel.includes(":nested-role:attempt-1")) throw new Error("retry nested role");
        if (input.sessionLabel.endsWith(":root-model:attempt-1")) {
          await collectChild({ prompt: "nested role", label: "nested-role", role: "reviewer", retries: 1 });
          for (const options of [
            { prompt: "model only", label: "model-only", model: "case-provider/model-only:medium" },
            { prompt: "thinking only", label: "thinking-only", model: "root-provider/root-model:low" },
            { prompt: "tools only", label: "tools-only", tools: ["!*", "read"] },
            { prompt: "combined", label: "combined", model: "case-provider/model-and-thinking:high", tools: ["!*", "read"] },
          ]) await collectChild(options);
        }
      },
      steer: async () => {},
      dispose() {},
    };
  };
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const ctx = { cwd, hasUI: false, model: { provider: "root-provider", id: "root-model" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {} } };
  workflowExtension(testExtensionApi({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["agent", "read", "workflow"] }), home, async () => {}, testTransport(createSession));
  assert.ok(start && command && shutdown);
  await start({}, ctx);
  await contextualWorkflowAction(command, ctx, "run-a", "Resume");
  await waitForRunState(store, "completed");
  const loaded = await store.load();
  assert.equal(loaded.run.state, "completed");
  assert.deepEqual(loaded.snapshot.roles?.reviewer?.skills, role.skills);
  const attempts = loaded.run.agents.flatMap((agent) => (agent.attemptDetails ?? []).map((attempt) => ({ agent, attempt })));
  assert.equal(inputs.size, 9);
  assert.equal(attempts.length, inputs.size);
  for (const { agent, attempt } of attempts) {
    const input = inputs.get(attempt.session?.sessionId ?? "");
    assert.ok(input);
    assert.deepEqual({ provider: input.model.provider, model: input.model.model, thinking: input.model.thinking, tools: input.tools }, { provider: agent.model.provider, model: agent.model.model, thinking: agent.model.thinking, tools: agent.tools });
  }
  const roleInputs = [...inputs.values()].filter(({ model }) => model.provider === "role-provider");
  assert.equal(roleInputs.length, 3);
  assert.ok(roleInputs.every((input) => input.resourcePolicy?.effective.skills.includes("role-only")));
  const unroledInput = [...inputs.values()].find(({ model, sessionLabel }) => model.provider === "root-provider" && sessionLabel.includes("API inspection"));
  assert.ok(unroledInput);
  assert.equal(unroledInput.resourcePolicy?.effective.skills.includes("role-only"), false);
  const topRole = loaded.run.agents.find((agent) => agent.name === "reviewer" && !agent.parentId);
  const nestedRole = loaded.run.agents.find((agent) => agent.name === "nested-role");
  const named = loaded.run.agents.find((agent) => agent.name === "API inspection");
  assert.ok(topRole && nestedRole && named);
  assert.equal(topRole.role, "reviewer");
  assert.equal(nestedRole.role, "reviewer");
  assert.equal(named.role, undefined);
  assert.equal(named.label, "API inspection");
  assert.deepEqual(named.model, { provider: "root-provider", model: "root-model", thinking: "medium" });
  assert.deepEqual(named.tools, ["agent", "read"]);
  assert.equal(loaded.run.agents.find((agent) => agent.name === "root-model")?.label, undefined);
  assert.equal(nestedRole.parentId, loaded.run.agents.find((agent) => agent.name === "root-model")?.id);
  assert.deepEqual(loaded.run.agents.find((agent) => agent.name === "root-model")?.model, { provider: "root-provider", model: "root-model", thinking: "medium" });
  assert.deepEqual(loaded.run.agents.find((agent) => agent.name === "root-model")?.tools, ["agent", "read"]);
  for (const policy of [
    { name: "model-only", model: { provider: "case-provider", model: "model-only", thinking: "medium" }, tools: ["agent", "read"] },
    { name: "thinking-only", model: { provider: "root-provider", model: "root-model", thinking: "low" }, tools: ["agent", "read"] },
    { name: "tools-only", model: { provider: "root-provider", model: "root-model", thinking: "medium" }, tools: ["read"] },
    { name: "combined", model: { provider: "case-provider", model: "model-and-thinking", thinking: "high" }, tools: ["read"] },
  ]) {
    const agent = loaded.run.agents.find((candidate) => candidate.name === policy.name);
    assert.ok(agent);
    assert.equal(agent.role, undefined);
    assert.deepEqual(agent.model, policy.model);
    assert.deepEqual(agent.tools, policy.tools);
  }
  const dashboard = formatNavigatorDashboard(loaded.run, [], []);
  const detail = formatNavigatorRun(loaded, [], []);
  assert.match(dashboard, /root-model/);
  assert.match(dashboard, /root-model > nested-role/);
  assert.doesNotMatch(dashboard, /model=|requested=|tools=|role=/);
  assert.match(dashboard, /API inspection/);
  assert.doesNotMatch(dashboard, /role=custom/);
  assert.match(detail, /nested-role .*model=role-provider\/role-model:high role=reviewer tools=read/);
  assert.match(detail, /model-only .*model=case-provider\/model-only:medium tools=agent,read/);
  assert.match(detail, /combined .*model=case-provider\/model-and-thinking:high tools=read/);
  assert.match(detail, /thinking-only .*model=root-provider\/root-model:low tools=agent,read/);
  assert.match(detail, /tools-only .*model=root-provider\/root-model:medium tools=read/);
  assert.match(detail, /API inspection .*model=root-provider\/root-model:medium/);
  await shutdown();
});

void test("cold resume rejects obsolete identity snapshots", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-old-snapshot-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "old", cwd, sessionId: "session-a", state: "interrupted", agents: [], agentSessions: [] }, callUnchecked(createLaunchSnapshot, undefined, [{ identityVersion: 3, script: "return true", args: null, metadata: { name: "old" }, settings: { concurrency: 1, maxAgentLaunches: 5 }, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] }]));
  assert.equal((await store.load()).snapshot.identityVersion, 3);
  await callUnchecked(store.saveOwnership.bind(store), undefined, [[{ id: "run-a:1", label: "legacy", state: "running", options: { label: "legacy", cwd, tools: [], isolation: "worktree" } }]]);
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const notices: string[] = [];
  const ctx = { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify(message: string) { notices.push(message); } } };
  workflowExtension(testExtensionApi({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  assert.ok(start && shutdown && command);
  await start({}, ctx);
  await contextualWorkflowAction(command, ctx, "run-a", "Resume");
  assert.ok(notices.some((message) => /identity version/.test(message)));
  await shutdown();
});

void test("cold resume rejects removed stateful workflow primitives", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-removed-primitive-resume-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "legacy", cwd, sessionId: "session-a", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return conversation('developer');", args: null, metadata: { name: "legacy" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const notices: string[] = [];
  const ctx = { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify(message: string) { notices.push(message); } } };
  workflowExtension(testExtensionApi({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  assert.ok(start && command && shutdown);
  await start({}, ctx);
  await contextualWorkflowAction(command, ctx, "run-a", "Resume");
  assert.ok(notices.some((message) => /removed/.test(message)));
  await shutdown();
});

void test("cold resume rejects project roles after trust is revoked", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-untrusted-resume-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "untrusted", cwd, sessionId: "session-a", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: `return agent("review", {role:"reviewer"});`, args: null, metadata: { name: "untrusted" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: ["reviewer"], roles: { reviewer: { prompt: "project role" } }, projectRoles: ["reviewer"], schemas: [] }));
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const notices: string[] = [];
  const ctx = { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session-a" }, isProjectTrusted: () => false, ui: { notify(message: string) { notices.push(message); } } };
  workflowExtension(testExtensionApi({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  assert.ok(start && command && shutdown);
  await start({}, ctx);
  await contextualWorkflowAction(command, ctx, "run-a", "Resume");
  assert.ok(notices.some((message) => /untrusted project/.test(message)));
  await shutdown();
});

void test("cold resume replays completed agents by hidden structural identity", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-agent-replay-"));
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "test"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  writeFileSync(join(cwd, "tracked.txt"), "initial");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "initial"]);
  const script = `return withWorktree("recovery", async () => agent("must replay"));`;
  let replayPath = "";
  assert.equal(await runWorkflow(script, null, { agent: async (_prompt, _options, _signal, identity) => { replayPath = structuralPath("agent", ...identity.structuralPath, `callsite:${identity.callSite}`, `occurrence:${String(identity.occurrence)}`); return "original"; }, worktree: async () => ({ path: "/worktrees/recovery", branch: "recovery-branch" }) }).result, "original");
  assert.ok(replayPath);
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "agent-replay", cwd, sessionId: "session-a", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script, args: null, metadata: { name: "agent-replay" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  await store.complete(replayPath, "replayed");
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const ctx = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {} } };
  workflowExtension(testExtensionApi({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  assert.ok(start && command && shutdown);
  await start({}, ctx);
  await contextualWorkflowAction(command, ctx, "run-a", "Resume");
  await waitForRunState(store, "completed");
  assert.equal((await store.load()).run.state, "completed");
  assert.deepEqual(await store.replay(replayPath), { path: replayPath, value: "replayed" });
  await shutdown();
});

void test("cold recovery delivers a persisted checkpoint only once before replay", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-checkpoint-recovery-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  const script = `export const meta={name:'cold-gate',description:'cold gate'}; return checkpoint({name:'ship',prompt:'Ship?',context:{sha:'abc'}});`;
  await store.create({ id: "run-a", workflowName: "cold-gate", cwd, sessionId: "session-a", state: "interrupted", agents: [], agentSessions: [], error: { code: "CANCELLED", message: "interrupted" } }, createLaunchSnapshot({ script, args: null, metadata: { name: "cold-gate", description: "cold gate" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  await store.awaitCheckpoint({ path: "checkpoint/ship", name: "ship", prompt: "Ship?", context: { sha: "abc" } });
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { accepted: boolean } }> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const messages: string[] = [];
  const ctx = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {} } };
  workflowExtension(testExtensionApi({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_respond"], sendMessage(message: { content: string }) { messages.push(message.content); } }), home);
  assert.ok(start && command && shutdown);
  await start({}, ctx);
  assert.match(messages[0] ?? "", /Ship\?/);
  await contextualWorkflowAction(command, ctx, "run-a", "Resume", "Background");
  await waitForRunState(store, "awaiting_input");
  assert.equal(messages.length, 1);
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(respond);
  const response = await executeToolCall(respond, "respond", { runId: "run-a", name: "ship", approved: true }, testExtensionContextFor(ctx)) as { details: { accepted: boolean } };
  assert.equal(response.details.accepted, true);
  await waitForRunState(store, "completed");
  assert.equal((await store.load()).run.state, "completed");
  assert.equal((await store.load()).run.error, undefined);
  assert.deepEqual(await store.replay("checkpoint/ship"), { path: "checkpoint/ship", value: true });
  await shutdown();
});


void test("production restart recovery and graceful shutdown persist durable completion", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-lifecycle-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "life", cwd, sessionId: "session-a", state: "running", agents: [], agentSessions: [], activeShells: 3 }, createLaunchSnapshot({ script: "export const meta={name:'life',description:'life'}", args: null, metadata: { name: "life", description: "life" }, settings: { concurrency: 1 }, models: ["openai-codex/gpt-5.6-sol"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const ctx = { cwd, model: { provider: "openai-codex", id: "gpt-5.6-sol" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {} } };
  workflowExtension(testExtensionApi({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  assert.ok(start && shutdown && command);
  await start({}, ctx);
  assert.equal((await store.load()).run.state, "interrupted");
  assert.equal((await store.load()).run.activeShells, undefined);
  await shutdown();
  assert.equal((await store.load()).run.state, "interrupted");
  await contextualWorkflowAction(command, ctx, "run-a", "Resume");
  await waitForRunState(store, "completed");
  assert.equal((await store.load()).run.state, "completed");
  assert.equal(JSON.parse(readFileSync(join(store.directory, "result.json"), "utf8")), null);
});
void test("production shell timeout clears active shell progress", { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shell-timeout-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const command = `${process.execPath} -e ${JSON.stringify("setTimeout(() => {}, 1000)")}`;
  const updates: Array<{ id: string; activeShells?: number }> = [];
  let runId: string | undefined;
  await assert.rejects(workflow.execute("id", { name: "shell-timeout", script: `await shell(${JSON.stringify(command)}, {timeoutMs:25});`, foreground: true }, new AbortController().signal, (update: unknown) => { const run = (update as { details?: { run?: { id: string; activeShells?: number } } }).details?.run; if (run) { updates.push(run); runId ??= run.id; } }, context), (error: unknown) => error instanceof WorkflowError && error.code === "SHELL_FAILED");
  assert.ok(runId);
  const run = await new RunStore(home, "session", runId, home).load();
  assert.equal(run.run.activeShells, undefined);
  assert.ok(updates.some(({ activeShells }) => activeShells === 1));
});
void test("production replayed shells do not report active progress", { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shell-replay-"));
  const script = `await agent("gate"); return (await shell("printf replayed")).stdout;`;
  let replayPath = "";
  const probe = runWorkflow(script, null, { agent: async () => "done", shell: async (_command, _options, _signal, identity) => { replayPath = shellIdentityPath(identity); return { exitCode: 0, stdout: "probe", stderr: "" }; } });
  await probe.result;
  assert.ok(replayPath);
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  let markAgentStarted!: () => void;
  const agentStarted = new Promise<void>((resolve) => { markAgentStarted = resolve; });
  const createSession = async (): Promise<TestPiSession> => ({ transport: "local", session: { transport: "local", sessionId: "shell-replay-agent", locator: { sessionFile: "/sessions/shell-replay-agent.jsonl" } }, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: sessionStats, prompt: async () => { markAgentStarted(); await promptGate; }, steer: async () => {}, dispose() {} });
  const updates: number[] = [];
  let resolveRun!: (run: { id: string }) => void;
  const initialRun = new Promise<{ id: string }>((resolve) => { resolveRun = resolve; });
  const onUpdate = (update: unknown) => { const run = (update as { details?: { run?: { id: string; activeShells?: number } } }).details?.run; if (run) { updates.push(run.activeShells ?? 0); resolveRun(run); } };
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const execution = workflow.execute("id", { name: "shell-replay", script, foreground: true }, new AbortController().signal, onUpdate, context);
  await agentStarted;
  const run = await initialRun;
  await new RunStore(home, "session", run.id, home).complete(replayPath, { exitCode: 0, stdout: "replayed", stderr: "" });
  releasePrompt();
  const result = await execution as { details: { value: unknown } };
  assert.equal(result.details.value, "replayed");
  assert.equal(updates.includes(1), false);
});
void test("a real paused run survives shutdown, replays completed shell work, and cold-resumes", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-paused-restart-"));
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  const marker = join(home, "completed-shell");
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const commands: Array<{ handler: (args: string, ctx: unknown) => Promise<void> }> = [];
  let shutdown: (() => Promise<void>) | undefined;
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
  let releasePrompt!: () => void;
  const promptGate = new Promise<void>((resolve) => { releasePrompt = resolve; });
  const createFirstSession = async (): Promise<TestPiSession> => ({ transport: "local", session: { transport: "local", sessionId: "first", locator: { sessionFile: "/sessions/first.jsonl" } }, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: sessionStats, prompt: async () => { resolveStarted(); await promptGate; }, abort: async () => { releasePrompt(); }, steer: async () => {}, dispose() {} });
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, sendMessage() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createFirstSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const command = commands[0]?.handler;
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
  assert.ok(workflow && command && shutdown);
  const firstRun = workflow.execute("id", { name: "paused-restart", script: `await shell("printf x >> ${marker}"); await agent("pause here", {label:"pause-agent"}); await shell("printf y >> ${marker}"); return true;`, foreground: true }, new AbortController().signal, undefined, context);
  void firstRun.catch(() => undefined);
  await started;
  const runId = (await listRunIds(cwd, "session", home))[0];
  assert.ok(runId);
  const store = new RunStore(cwd, "session", runId, home);
  await contextualWorkflowAction(command, context, runId, "Pause");
  assert.equal((await store.load()).run.state, "pausing");
  releasePrompt();
  await waitForRunState(store, "paused");
  const paused = await store.load();
  assert.equal(paused.run.state, "paused");
  assert.equal(paused.run.agents[0]?.state, "completed");
  assert.equal(readFileSync(marker, "utf8"), "x");
  await shutdown();
  assert.equal((await store.load()).run.state, "interrupted");
  assert.equal(readFileSync(marker, "utf8"), "x");
  const resumedTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let resumeCommand: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let resumeShutdown: (() => Promise<void>) | undefined;
  let secondSessions = 0;
  const createSecondSession = async (): Promise<TestPiSession> => ({ sessionId: `second-${String(++secondSessions)}`, sessionFile: `/sessions/second-${String(secondSessions)}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: sessionStats, prompt: async () => {}, steer: async () => {}, dispose() {} });
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof resumedTools)[number]) { resumedTools.push(tool); }, registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) { resumeCommand = options.handler; }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") resumeShutdown = handler as typeof resumeShutdown; }, sendMessage() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSecondSession));
  assert.ok(start && resumeCommand && resumeShutdown);
  await start({}, context);
  await contextualWorkflowAction(resumeCommand, context, runId, "Resume");
  await waitForRunState(store, "completed");
  assert.equal((await store.load()).run.state, "completed");
  assert.equal(readFileSync(marker, "utf8"), "xy");
  assert.equal(secondSessions, 0);
  await resumeShutdown();
});

void test("production Pi seam installs child tools and registers native steering", async () => {
  const childTool = { name: "agent", label: "Child", description: "child", parameters: Type.Object({}), async execute() { return { content: [{ type: "text" as const, text: "ok" }], details: {} }; } };
  const session = await createLocalPiSession({ cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], customTools: [childTool], sessionLabel: "issue-9-acceptance" });
  assert.ok(session.agent?.state.tools.some(({ name }) => name === "agent"));
  await session.dispose();
  let steer: ((message: string) => void | Promise<void>) | undefined;
  const received: string[] = [];
  const executor = new WorkflowAgentExecutor({ cwd: "/repo", model: { provider: "openai", model: "gpt" }, tools: new Set() }, testTransport(async () => ({ transport: "local", session: { transport: "local", sessionId: "s", locator: { sessionFile: "/s" } }, messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }], getSessionStats: sessionStats, prompt: async () => {}, steer: async (message) => { received.push(message); }, dispose() {} })));
  await executor.execute("work", { label: "worker", workflowName: "flow" }, undefined, [], (handler) => { steer = handler; });
  assert.ok(steer); await steer("redirect"); assert.deepEqual(received, ["redirect"]);
});


void test("concurrency-1 cancellation and nested containment retain accounting and retry separation", async () => {
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
  scheduler.addRun("nested", 1);
  const parent = scheduler.spawn("nested", "parent", { label: "parent", cwd: "/repo", tools: [] });
  assert.equal((await parent.result).ok, true);
  assert.deepEqual(scheduler.snapshot().slice(-2).map(({ state }) => state), ["completed", "failed"]);

  let attempt = 0;
  let cleaned = 0;
  const executor = new WorkflowAgentExecutor({ cwd: "/repo", model: { provider: "openai", model: "gpt" }, tools: new Set() }, testTransport(async () => { const current = ++attempt; return { sessionId: `s${String(current)}`, sessionFile: `/s${String(current)}`, messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } } }], getSessionStats: () => sessionStats(0.5), prompt: async () => { if (current === 1) throw new Error("retry"); }, dispose() {} }; }));
  const retried = await executor.execute("retry", { label: "retry", workflowName: "flow", retries: 1, timeoutMs: 100 }, undefined, [], undefined, () => { cleaned += 1; });
  assert.equal(cleaned, 1); assert.equal(retried.attempts.length, 2); assert.deepEqual(retried.attempts.map(({ accounting }) => accounting.cost), [0.5, 0.5]);
});

void test("production worker returns bare combinator values and waits before typed failure", async () => {
  assert.deepEqual(await runWorkflow(`return pipeline('pipe',{first:1,second:2},{double:value=>value*2});`).result, { first: 2, second: 4 });

  let releaseParallel!: () => void;
  const parallelWait = new Promise<JsonValue>((resolve) => { releaseParallel = () => { resolve("done"); }; });
  let settled = false;
  const parallelCalls: string[] = [];
  const parallelRun = runWorkflow(`return parallel('batch',{failure:()=>{throw Object.assign(new Error('branch failed'),{code:'AGENT_FAILED'})},waiting:()=>agent('wait')});`, null, {
    agent: async (prompt) => { parallelCalls.push(prompt); return parallelWait; },
  });
  void parallelRun.result.finally(() => { settled = true; }).catch(() => undefined);
  while (parallelCalls.length < 1) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseParallel();
  await assert.rejects(parallelRun.result, (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === "branch failed" && (error as WorkflowError & { failedAt?: string }).failedAt === "batch/failure");

  // A plain (non-agent) throw inside a nested scope reports the absolute path, so sibling scopes
  // with identical inner names stay distinguishable in diagnostics and retry provenance.
  const nestedRun = runWorkflow(`return parallel('outer',{a:()=>parallel('inner',{x:async()=>'ok'}),b:()=>parallel('inner',{x:()=>{throw Object.assign(new Error('nested failed'),{code:'AGENT_FAILED'})}})});`);
  await assert.rejects(nestedRun.result, (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === "nested failed" && (error as WorkflowError & { failedAt?: string }).failedAt === "outer/b/inner/x");

  let releasePipeline!: () => void;
  const pipelineWait = new Promise<JsonValue>((resolve) => { releasePipeline = () => { resolve(2); }; });
  settled = false;
  const pipelineCalls: string[] = [];
  const pipelineRun = runWorkflow(`return pipeline('pipe',{first:1,second:2},{run:value=>agent(String(value))});`, null, {
    agent: async (prompt) => { pipelineCalls.push(prompt); if (prompt === "1") throw new WorkflowError("RESULT_INVALID", "invalid first"); return pipelineWait; },
  });
  void pipelineRun.result.finally(() => { settled = true; }).catch(() => undefined);
  while (pipelineCalls.length < 2) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releasePipeline();
  // A nested failure reports the failing operation's own journal path, not a re-encoded copy of it.
  await assert.rejects(pipelineRun.result, (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID" && error.message === "invalid first" && (error as WorkflowError & { failedAt?: string }).failedAt?.startsWith("agent/pipe/first/run/callsite%3A") === true);

  const controller = new AbortController();
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const cancelled = runWorkflow(`return parallel('cancel',{waiting:()=>agent('wait'),failure:()=>{throw Object.assign(new Error('failed'),{code:'AGENT_FAILED'})}});`, null, {
    agent: async (_prompt, _options, signal) => { markStarted(); await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); }); throw new WorkflowError("CANCELLED", "cancelled"); },
  }, controller.signal);
  await started;
  controller.abort();
  await assert.rejects(cancelled.result, (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
});
void test("worker rejects concurrent same-callsite agents but permits sequential reuse", async () => {
  const concurrent = runWorkflow(`const launch = () => agent("same"); return Promise.all([launch(), launch()]);`, null, { agent: async () => "done" });
  await assert.rejects(concurrent.result, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA" && /parallel|pipeline/.test(error.message));
  const calls: string[] = [];
  const sequential = await runWorkflow(`const launch = () => agent("same"); return [await launch(), await launch()];`, null, { agent: async (prompt) => { calls.push(prompt); return prompt; } }).result;
  assert.deepEqual(sequential, ["same", "same"]);
  assert.deepEqual(calls, ["same", "same"]);
  const scoped = await runWorkflow(`const launch = () => agent("same"); return parallel("batch", { one: () => launch(), two: () => launch() });`, null, { agent: async (prompt) => prompt }).result;
  assert.deepEqual(scoped, { one: "same", two: "same" });
});
void test("registered function bridge carries explicit occurrences", async () => {
  const identities: unknown[] = [];
  await runWorkflow(`for (const value of ["one", "two", "three"]) await repeated({ value });`, null, {
    functions: { repeated: { name: "repeated" } },
    function: async (_name, _input, _signal, identity) => { identities.push(identity); return null; },
  }).result;
  assert.deepEqual(identities.map((value) => {
    const identity = value as { path?: unknown; structuralPath?: unknown; occurrence?: unknown };
    return { path: identity.path, structuralPath: identity.structuralPath, occurrence: identity.occurrence };
  }), [
    { path: "function/repeated/1", structuralPath: [], occurrence: 1 },
    { path: "function/repeated/2", structuralPath: [], occurrence: 2 },
    { path: "function/repeated/3", structuralPath: [], occurrence: 3 },
  ]);
});

void test("terminal failed attempts remain persisted", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-attempts-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "failed", cwd, sessionId: "session-a", state: "running", agents: [{ id: "run-a:1", name: "agent", path: "run-a:1", state: "running", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 0 }], agentSessions: [] }, createLaunchSnapshot({ script: "export const meta={name:'failed',description:'failed'}", args: null, metadata: { name: "failed" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] }));
  await persistActiveAgentAttempt(store, "run-a:1", { attempt: 1, transport: "local", session: { transport: "local", sessionId: "failed-session", locator: { sessionFile: "/sessions/failed.jsonl" } }, setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } });
  const active = (await store.load()).run;
  assert.equal(active.agents[0]?.attemptDetails?.[0]?.session?.locator && typeof active.agents[0].attemptDetails[0].session.locator === "object" && !Array.isArray(active.agents[0].attemptDetails[0].session.locator) ? active.agents[0].attemptDetails[0].session.locator.sessionFile : undefined, "/sessions/failed.jsonl");
  assert.deepEqual(active.agentSessions, [{ transport: "local", sessionId: "failed-session", locator: { sessionFile: "/sessions/failed.jsonl" } }]);
  await persistAgentAttempts(store, "run-a:1", [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: "failed-session", locator: { sessionFile: "/sessions/failed.jsonl" } }, setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd: "/repo" }, error: { code: "AGENT_FAILED", message: "failed" }, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }]);
  const persisted = (await store.load()).run;
  assert.deepEqual(persisted.agents.map(({ attempts, accounting }) => ({ attempts, accounting })), [{ attempts: 1, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }]);
  assert.deepEqual(persisted.agentSessions, [{ transport: "local", sessionId: "failed-session", locator: { sessionFile: "/sessions/failed.jsonl" } }]);
});

void test("registered extension agents persist structural scope for late siblings", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-issue69-identity-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { runId?: string; value?: unknown } }> }> = [];
  let nextSession = 0;
  const createSession = async (): Promise<TestPiSession> => ({
    sessionId: `issue69-${String(++nextSession)}`,
    sessionFile: `/sessions/${String(nextSession)}.jsonl`,
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: sessionStats,
    prompt: async () => {},
    steer: async () => {},
    dispose() {},
  });
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  registerWorkflowExtension({ version: "1.0.0", headline: "Identity", functions: { review: { description: "Review", input: { type: "object" }, output: { type: "string" }, run: (_input, context) => context.agent("developer", { label: "developer" }) } } });
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const result = await workflow.execute("id", { name: "issue69", script: `return parallel("issues", { "issue-65": async () => { const first = await review({}); await Promise.resolve(); const second = await review({}); return [first, second]; }, "issue-66": () => review({}) });`, foreground: true }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  const run = new RunStore(home, "session", result.details.runId ?? "", home);
  const loaded = await run.load();
  const issue65 = loaded.run.agents.filter((agent) => JSON.stringify(agent.structuralPath) === JSON.stringify(["issues", "issue-65"]));
  const issue66 = loaded.run.agents.filter((agent) => JSON.stringify(agent.structuralPath) === JSON.stringify(["issues", "issue-66"]));
  assert.equal(issue65.length, 2);
  assert.equal(issue66.length, 1);
  assert.deepEqual(issue65.map((agent) => agent.parentBreadcrumb).sort(), ["review", "review #2"]);
  assert.deepEqual(issue66.map((agent) => agent.parentBreadcrumb), ["review"]);
  assert.ok(loaded.run.agents.every((agent) => !agent.worktreeOwner));
  const rendered = formatNavigatorDashboard(loaded.run, [], []);
  assert.match(rendered, /issues > issue-65 > review/);
  assert.match(rendered, /issues > issue-66 > review/);
});
void test("production workflow exposes registered global functions and replays them structurally", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-global-acceptance-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { runId: string; value: unknown } }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_catalog"] }), home);
  registerAcceptanceExtension();
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const script = `phase('verify'); const first=await echo({value:'first'}); const replayed=await echo({value:'second'}); const parallelResults=await parallel('global-parallel',{first:()=>echo({value:'parallel-first'}),second:()=>echo({value:'parallel-second'})}); const pipelineResults=await pipeline('global-pipeline',{first:'pipeline-value'},{echo:value=>echo({value})}); const orchestrated=await orchestrate({}); return {first,replayed,parallelResults,pipelineResults,orchestrated};`;
  const result = await workflow.execute("id", { name: "global-e2e", script, foreground: true }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  assert.deepEqual(result.details.value, { first: { value: "first" }, replayed: { value: "second" }, parallelResults: { first: { value: "parallel-first" }, second: { value: "parallel-second" } }, pipelineResults: { first: { value: "pipeline-value" } }, orchestrated: { parallel: { first: 1, second: 2 }, pipeline: { first: 2, second: 4 }, parallelWaited: true, parallelCode: "AGENT_FAILED", pipelineWaited: true, pipelineCode: "RESULT_INVALID" } });
  assert.equal(acceptanceFunctionCalls, 5);
  const store = new RunStore(home, "session", result.details.runId, home);
  assert.equal((await store.load()).run.phase, "verify");
  assert.equal((await store.load()).snapshot.tools.includes("workflow_catalog"), false);
  assert.deepEqual(await store.replay("function/echo/1"), { path: "function/echo/1", value: { value: "first" } });
  assert.deepEqual(await store.replay("function/echo/2"), { path: "function/echo/2", value: { value: "second" } });
  assert.deepEqual(await store.replay("function/global-parallel/first/echo/1"), { path: "function/global-parallel/first/echo/1", value: { value: "parallel-first" } });
  assert.deepEqual(await store.replay("function/global-parallel/second/echo/1"), { path: "function/global-parallel/second/echo/1", value: { value: "parallel-second" } });
  assert.deepEqual(await store.replay("function/global-pipeline/first/echo/echo/1"), { path: "function/global-pipeline/first/echo/echo/1", value: { value: "pipeline-value" } });
});
void test("setup hooks conditionally install an inline Pi extension for one agent", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-setup-hooks-"));
  const inputs: SessionInput[] = [];
  const installed: string[] = [];
  const scopedAdvisorFactory = (pi: { registerTool(tool: { name: string }): void }) => { pi.registerTool({ name: "scoped-advisor" }); };
  function assertScopedAdvisorFactory(factory: NonNullable<SessionInput["extensionFactories"]>[number]): asserts factory is typeof scopedAdvisorFactory { assert.equal(factory, scopedAdvisorFactory); }
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    inputs.push(input);
    for (const factory of input.extensionFactories ?? []) {
      assertScopedAdvisorFactory(factory);
      factory({ registerTool(tool: { name: string }) { installed.push(tool.name); } });
    }
    return { sessionId: `setup-${String(inputs.length)}`, sessionFile: `/sessions/setup-${String(inputs.length)}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: sessionStats, prompt: async () => {}, steer: async () => {}, dispose() {} };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { value: unknown } }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["read", "workflow"] }), home, async () => {}, testTransport(createSession));
  registerWorkflowExtension({ version: "1.0.0", headline: "Setup hooks", agentSetupHooks: { advisor: { setup(agent) { if (agent.options.advisor !== true) return; agent.sessionInput.extensionFactories ??= []; agent.sessionInput.extensionFactories.push(scopedAdvisorFactory); } } } });
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const result = await workflow.execute("id", { name: "setup-hooks", script: `return parallel("agents", { marked: () => agent("marked", { advisor: true }), plain: () => agent("plain") });`, foreground: true }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  assert.deepEqual(result.details.value, { marked: "done", plain: "done" });
  assert.equal(inputs.filter(({ options }) => options?.advisor === true).length, 1);
  assert.equal(inputs.filter(({ options }) => options?.advisor !== true).length, 1);
  assert.deepEqual(installed, ["scoped-advisor"]);
});
void test("production child discovery does not replace the frozen parent workflow registry", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-registry-production-"));
  const childRoot = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-registry-child-"));
  try {
  const agentDir = join(childRoot, "agent");
  const cwd = join(childRoot, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const lifecycleFile = join(childRoot, "lifecycle.txt");
  const packageRoot = realpathSync(process.cwd());
  const hostEntry = realpathSync(join(packageRoot, "dist/src/index.js"));
  const benignExtension = join(childRoot, "benign-extension.mjs");
  writeFileSync(benignExtension, `import { appendFileSync } from "node:fs"; export default function(pi) { pi.on("session_start", (event) => appendFileSync(${JSON.stringify(lifecycleFile)}, "start:" + event.reason + "\\n")); pi.on("session_shutdown", (event) => appendFileSync(${JSON.stringify(lifecycleFile)}, "shutdown:" + event.reason + "\\n")); }`);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [packageRoot], extensions: [hostEntry, benignExtension] }));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: { value?: unknown } }> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_catalog"], on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; } } as never, home, async () => {});
  registerWorkflowExtension({
    version: "1.0.0", headline: "Registry probe",
    functions: { probe: { description: "Probe the parent registry", input: { type: "object", additionalProperties: false }, output: { type: "string" }, run: () => "probe" } },
  });
  assert.ok(start && shutdown);
  await start({}, { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "parent" } });
  const parentRegistry = loadingRegistry();
  const parentFunctions = Object.keys(parentRegistry.functions()).sort();
  const workflow = tools.find(({ name }) => name === "workflow");
  const catalog = tools.find(({ name }) => name === "workflow_catalog");
  assert.ok(workflow && catalog);
  const checkpoint = async () => ({
    registry: loadingRegistry(),
    frozen: loadingRegistry().frozen,
    functions: Object.keys(loadingRegistry().functions()).sort(),
    workflow: (await workflow.execute("id", { name: "registry-probe", script: "return probe({});", foreground: true }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "parent" } })).details.value,
    catalog: JSON.parse((await catalog.execute()).content[0]?.text ?? "null") as { functions: Array<{ name: string }> },
  });
  let child: Awaited<ReturnType<typeof localAgentTransport.createSession>> | undefined;
  let afterCreation: Awaited<ReturnType<typeof checkpoint>> | undefined;
  let afterDisposal: Awaited<ReturnType<typeof checkpoint>>;
  try {
    child = await localAgentTransport.createSession({ cwd, agentDir, model: { provider: "openai-codex", model: "gpt-5.6-sol" }, tools: [], sessionLabel: "registry-child", extensionFactories: [() => {}] }, {} as never);
    afterCreation = await checkpoint();
  } finally {
    await child?.dispose();
    afterDisposal = await checkpoint();
    await shutdown();
  }
  assert.ok(afterCreation);
  for (const observed of [afterCreation, afterDisposal]) {
    assert.equal(observed.registry, parentRegistry);
    assert.equal(observed.frozen, true);
    assert.deepEqual(observed.functions, parentFunctions);
    assert.equal(observed.functions.includes("probe"), true);
    assert.equal(observed.workflow, "probe");
    assert.equal(observed.catalog.functions.some(({ name }) => name === "probe"), true);
  }
  assert.deepEqual(readFileSync(lifecycleFile, "utf8").trim().split("\n"), ["start:startup", "shutdown:quit"]);
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(childRoot, { recursive: true, force: true });
  }
});
void test("nested workflow hosts preserve the parent registry and lifecycle", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-nested-registry-parent-"));
  const nestedHome = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-nested-registry-child-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { value?: unknown } }> }> = [];
  let parentStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let parentShutdown: (() => Promise<void>) | undefined;
  let parentStarts = 0;
  let parentShutdowns = 0;
  let nestedStarts = 0;
  let nestedShutdowns = 0;
  let parentStarted = false;
  let parentRegistry!: ReturnType<typeof loadingRegistry>;
  const parentContext = { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "parent" }, ui: { notify() {} } };
  const createSession = async (): Promise<TestPiSession> => ({
    sessionId: "nested-agent", sessionFile: "/sessions/nested-agent.jsonl", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: sessionStats,
    prompt: async () => {
      const nestedTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { value?: unknown } }> }> = [];
      let nestedStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
      let nestedShutdown: (() => Promise<void>) | undefined;
      workflowExtension(testExtensionApi({
        registerTool(tool: (typeof nestedTools)[number]) { nestedTools.push(tool); }, registerCommand() {}, getActiveTools: () => ["workflow"],
        on(name: string, handler: unknown) {
          if (name === "session_start") {
            const callback = handler as (event: unknown, ctx: unknown) => Promise<void>;
            nestedStart = async (event, ctx) => { nestedStarts += 1; await callback(event, ctx); };
          }
          if (name === "session_shutdown") {
            const callback = handler as () => Promise<void>;
            nestedShutdown = async () => { nestedShutdowns += 1; await callback(); };
          }
        },
      }), nestedHome);
      assert.ok(nestedStart && nestedShutdown);
      const nestedContext = { cwd: nestedHome, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "nested" }, ui: { notify() {} } };
      try {
        await nestedStart({}, nestedContext);
        const nestedWorkflow = nestedTools.find(({ name }) => name === "workflow");
        assert.ok(nestedWorkflow);
        const result = await nestedWorkflow.execute("nested", { name: "nested", script: "return true;", foreground: true }, new AbortController().signal, undefined, nestedContext);
        assert.equal(result.details.value, true);
      } finally {
        await nestedShutdown();
      }
      assert.equal(loadingRegistry(), parentRegistry);
      assert.ok(loadingRegistry().function("afterNested"));
    },
    steer: async () => {},
    dispose() {},
  });
  workflowExtension(testExtensionApi({
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getActiveTools: () => ["agent", "workflow"],
    on(name: string, handler: unknown) {
      if (name === "session_start") {
        const callback = handler as (event: unknown, ctx: unknown) => Promise<void>;
        parentStart = async (event, ctx) => { parentStarts += 1; await callback(event, ctx); };
      }
      if (name === "session_shutdown") {
        const callback = handler as () => Promise<void>;
        parentShutdown = async () => { parentShutdowns += 1; await callback(); };
      }
    },
  }), home, async () => {}, testTransport(createSession));
  registerWorkflowExtension({ version: "1.0.0", headline: "Nested registry", functions: { afterNested: { description: "Run after a nested session", input: { type: "object", additionalProperties: false }, output: { type: "string" }, run: () => "after" } } });
  assert.ok(parentStart && parentShutdown);
  try {
    await parentStart({}, parentContext);
    parentStarted = true;
    parentRegistry = loadingRegistry();
    const workflow = tools.find(({ name }) => name === "workflow");
    assert.ok(workflow);
    const result = await workflow.execute("parent", { name: "nested-parent", script: "await agent('nested'); return afterNested({});", foreground: true }, new AbortController().signal, undefined, parentContext);
    assert.equal(result.details.value, "after");
    assert.equal(parentStarts, 1);
    assert.equal(nestedStarts, 1);
    assert.equal(nestedShutdowns, 1);
    assert.equal(loadingRegistry(), parentRegistry);
    assert.ok(loadingRegistry().function("afterNested"));
  } finally {
    if (parentStarted) await parentShutdown();
  }
  assert.equal(parentShutdowns, 1);
});
void test("registered function context exposes callback worktree references", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-worktree-reference-"));
  const cwd = join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "test"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  writeFileSync(join(cwd, "tracked.txt"), "initial");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "initial"]);
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { value?: unknown } }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  registerWorkflowExtension({
    version: "1.0.0", headline: "Worktree reference",
    functions: {
      readReference: { description: "Read reference", input: { type: "object" }, output: { type: "object" }, async run(_input, context) { let frozen = false; const reference = await context.withWorktree("registered", async (value) => { frozen = Object.isFrozen(value); return { path: value.path, branch: value.branch }; }); return { reference, frozen, runName: context.run.workflow.name }; } }
    },
  });
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const result = await workflow.execute("id", { name: "read-reference", script: "return await readReference(args);", args: {}, foreground: true }, new AbortController().signal, undefined, { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  const value = result.details.value as { reference: { path: string; branch: string }; frozen: boolean; runName: string };
  assert.match(value.reference.path, /worktrees/);
  assert.match(value.reference.branch, /pi-extensible-workflows/);
  assert.deepEqual(Object.keys(value.reference), ["path", "branch"]);
  assert.equal(value.frozen, true);
  assert.equal(value.runName, "read-reference");
});

void test("shared worktree scopes persist one owner across production agents and functions", { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shared-worktree-"));
  const cwd = join(home, "repo");
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "test"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  writeFileSync(join(cwd, "tracked.txt"), "initial");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "initial"]);
  const extension: WorkflowExtension = {
    version: "1.0.0", headline: "Shared worktree",
    functions: {
      inherited: { description: "Use the inherited scope", input: { type: "object" }, output: { type: "object" }, async run(_input, context) { return context.parallel("function-agents", { left: () => context.agent("function-left"), right: () => context.agent("function-right") }); } },
      scoped: { description: "Use a named scope", input: { type: "object" }, output: { type: "string" }, async run(_input, context) { return context.withWorktree("shared", async () => context.agent("function-scoped")); } },
      middle: { description: "Compose one nested function", input: { type: "object" }, output: { type: "object" }, async run(_input, context) { return context.invoke("inherited", {}); } },
      composed: { description: "Compose nested functions", input: { type: "object" }, output: { type: "object" }, async run(_input, context) { return context.parallel("nested-functions", { left: () => context.invoke("middle", {}), right: () => context.invoke("middle", {}) }); } },
    },
  };
  const inputs: SessionInput[] = [];
  let nextSession = 0;
  let failRetry = true;
  let spawnedChild = false;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    const sessionId = `shared-worktree-${String(++nextSession)}`;
    inputs.push(input);
    return {
      sessionId, sessionFile: `/sessions/${sessionId}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: sessionStats,
      prompt: async (prompt) => {
        writeFileSync(join(input.cwd, `${sessionId}.txt`), sessionId);
        if (prompt.includes("Task:\nretry") && failRetry) { failRetry = false; throw new Error("retry once"); }
        const childTool = input.customTools?.find(({ name }) => name === "agent");
        const resultTool = input.customTools?.find(({ name }) => name === "get_subagent_result");
        if (!spawnedChild && childTool && resultTool) {
          spawnedChild = true;
          const launched = await executeTool(childTool, sessionId, { prompt: "nested", label: "nested" }, testExtensionContext) as { content?: Array<{ text?: string }> };
          const parsed = JSON.parse(launched.content?.[0]?.text ?? "{}") as { id?: unknown };
          if (typeof parsed.id !== "string") throw new Error("Missing nested agent id");
          await executeTool(resultTool, sessionId, { id: parsed.id }, testExtensionContext);
        }
      },
      steer: async () => {}, dispose() {},
    };
  };
  const messages: string[] = [];
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { runId: string } }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "agent"], sendMessage(message: { content: string }) { messages.push(message.content); } }), home, async () => {}, testTransport(createSession));
  registerWorkflowExtension(extension);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const script = `const values = await withWorktree("shared", async () => parallel("top", { retry: () => agent("retry", { retries: 1 }), direct: () => agent("direct"), inherited: () => inherited({}), scoped: () => scoped({}), composed: () => composed({}) })); return { values, outside: await agent("outside") };`;
  const started = await workflow.execute("id", { name: "shared-worktree", script }, new AbortController().signal, undefined, { cwd, hasUI: false, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" } });
  const runId = started.details.runId;
  const store = new RunStore(cwd, "session", runId, home);
  await waitForRunState(store, "completed");
  const loaded = await store.load();
  assert.equal(loaded.run.state, "completed", JSON.stringify(loaded.run.error));
  const worktrees = await store.worktrees();
  assert.equal(worktrees.length, 1);
  assert.equal(loaded.run.agents.filter((agent) => agent.state === "completed").length, 11);
  assert.equal(loaded.run.agents.filter((agent) => agent.parentBreadcrumb === "composed > middle > inherited").length, 4);
  assert.equal(loaded.run.agents.find((agent) => agent.attempts === 2)?.attempts, 2);
  const owners = (await store.loadOwnership()).map(({ options }) => options.worktreeOwner).filter((owner): owner is string => typeof owner === "string");
  assert.equal(new Set(owners).size, 1);
  assert.equal(owners.length, 10);
  const sharedCwds = new Set(inputs.slice(0, -1).map(({ cwd: inputCwd }) => inputCwd));
  assert.equal(sharedCwds.size, 1);
  assert.equal(inputs.at(-1)?.cwd, cwd);
  const detail = formatNavigatorRun(loaded, [], worktrees);
  assert.match(detail, /Worktrees: 1/);
  assert.doesNotMatch(detail, /branch=|worktree\/named|\/worktree/);
  for (let attempt = 0; attempt < 100 && !messages.length; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const branch = worktrees[0]?.branch;
  const completion = messages.find((message) => message.includes("Changes:"));
  assert.ok(branch && completion, JSON.stringify(messages));
  assert.equal(completion.split(branch).length - 1, 1);
});

void test("workflow_catalog is excluded from child tools", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-catalog-child-"));
  const inputs: SessionInput[] = [];
  let nextSession = 0;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    inputs.push(input);
    return { sessionId: `catalog-child-${String(++nextSession)}`, sessionFile: "/tmp/catalog-child.jsonl", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: sessionStats, prompt: async () => {}, steer: async () => {}, dispose() {} };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details?: { value?: unknown } }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_catalog", "workflow_stop", "read"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  await workflow.execute("id", { name: "catalog-child", script: "return await agent('child');", foreground: true }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  assert.equal(inputs[0]?.tools.includes("workflow_catalog"), false);
  assert.equal(inputs[0].tools.includes("workflow_stop"), false);
});
void test("restart recovers every persisted nonterminal run state", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-recovery-states-"));
  const cwd = join(home, "project");
  const states = ["running", "pausing", "paused", "awaiting_input"] as const;
  const stores = states.map((_state, index) => new RunStore(cwd, "session-a", `run-${String(index)}`, home));
  for (const [index, state] of states.entries()) {
    const id = `run-${String(index)}`;
    await stores[index]?.create({ id, workflowName: id, cwd, sessionId: "session-a", state, agents: [], agentSessions: [] }, createLaunchSnapshot({ script: `return '${id}';`, args: null, metadata: { name: id }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  }
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const ctx = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {} } };
  workflowExtension(testExtensionApi({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  assert.ok(start && command && shutdown);
  await start({}, ctx);
  for (const [index, store] of stores.entries()) {
    assert.equal((await store.load()).run.state, "interrupted");
    await contextualWorkflowAction(command, ctx, `run-${String(index)}`, "Resume");
  }
  for (const [index, store] of stores.entries()) {
    await waitForRunState(store, "completed");
    assert.equal((await store.load()).run.state, "completed");
    assert.equal(JSON.parse(readFileSync(join(store.directory, "result.json"), "utf8")), `run-${String(index)}`);
  }
  await shutdown();
});
void test("cold-resumed failures deliver human-readable diagnostics while persistence keeps codes", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-recovery-failure-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  const message = "The restored approval gate rejected the release.";
  await store.create({ id: "run-a", workflowName: "restored-failure", cwd, sessionId: "session-a", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: `throw new Error(${JSON.stringify(message)});`, args: null, metadata: { name: "restored-failure" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const messages: string[] = [];
  const ctx = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {} } };
  workflowExtension(testExtensionApi({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, sendMessage(value: { content: string }) { messages.push(value.content); }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  assert.ok(start && command && shutdown);
  await start({}, ctx);
  await contextualWorkflowAction(command, ctx, "run-a", "Resume", "Background");
  let loaded = await store.load();
  let diagnosticMessage: string | undefined;
  for (let attempt = 0; attempt < 100 && (loaded.run.state !== "failed" || !diagnosticMessage); attempt += 1) {
    loaded = await store.load();
    diagnosticMessage = messages.find((value) => value.includes(" failed (runId="));
    if (loaded.run.state !== "failed" || !diagnosticMessage) await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(loaded.run.state, "failed");
  assert.deepEqual(loaded.run.error, { code: "INTERNAL_ERROR", message });
  assert.ok(diagnosticMessage);
  assert.doesNotMatch(diagnosticMessage, /\n/);
  assert.match(diagnosticMessage, /Workflow restored-failure failed/);
  assert.match(diagnosticMessage, /runId=run-a/);
  assert.match(diagnosticMessage, /error=INTERNAL_ERROR: .*restored approval gate rejected the release\./);
  assert.match(diagnosticMessage, /statePath=.*state\.json/);
  assert.match(diagnosticMessage, /journalPath=.*journal\.json/);
  await shutdown();
});
void test("workflow_retry replays a journaled shell mutation while completing incomplete work", { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-partial-shell-retry-"));
  const marker = join(home, "mutation.log");
  const messages: string[] = [];
  let sessions = 0;
  const createSession = async (): Promise<TestPiSession> => {
    const session = ++sessions;
    return {
      sessionId: `partial-shell-${String(session)}`,
      sessionFile: `/sessions/partial-shell-${String(session)}.jsonl`,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      getSessionStats: sessionStats,
      prompt: async () => { if (session === 1) throw new Error("later failure"); },
      steer: async () => {},
      dispose() {},
    };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { runId?: string; parentRunId?: string } }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, sendMessage(message: { content: string }) { messages.push(message.content); }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "agent"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(workflow && retry);
  const context = { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const command = `printf x >> ${marker}`;
  const started = await workflow.execute("id", { name: "partial-shell-retry", script: `await shell(${JSON.stringify(command)}); await agent("later failure"); return true;` }, new AbortController().signal, undefined, context);
  const parentRunId = started.details.runId;
  assert.ok(parentRunId);
  const parent = new RunStore(home, "session", parentRunId, home);
  let diagnosticMessage: string | undefined;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    const loaded = await parent.load();
    diagnosticMessage = messages.find((message) => message.includes(" failed (runId="));
    if (loaded.run.state === "failed" && diagnosticMessage) break;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.equal((await parent.load()).run.state, "failed");
  assert.equal((await parent.load()).run.error?.message, "later failure");
  assert.equal(readFileSync(marker, "utf8"), "x");
  assert.ok(diagnosticMessage);
  const advertisedRunId = / failed \(runId=([^)]*)\):/.exec(diagnosticMessage)?.[1];
  assert.equal(advertisedRunId, parentRunId);
  assert.match(diagnosticMessage, /next action: workflow_retry\(\{ runId: "/);
  const journaled = await parent.replayableOperations();
  assert.ok(journaled.some(({ path }) => path.startsWith("shell/")));
  const retried = await retry.execute("retry", { runId: parentRunId, foreground: false }, undefined, undefined, context);
  const childRunId = retried.details.runId;
  assert.ok(childRunId && retried.details.parentRunId === parentRunId);
  const child = new RunStore(home, "session", childRunId, home);
  await waitForRunState(child, "completed");
  assert.equal((await child.load()).run.state, "completed", JSON.stringify((await child.load()).run.error));
  assert.equal(readFileSync(marker, "utf8"), "x");
  assert.equal(sessions, 2);
  assert.equal((await child.load()).run.agents.filter((agent) => agent.state === "completed").length, 1);
});

void test("recovery inherits persisted launch mode for resume and retry", { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-launch-mode-recovery-"));
  const cwd = join(home, "project");
  const sessionId = "session";
  const snapshot = (name: string, launchMode?: "foreground" | "background") => createLaunchSnapshot({ script: `return ${JSON.stringify(name)};`, args: null, metadata: { name }, ...(launchMode ? { launchMode } : {}), settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] });
  const foregroundResume = new RunStore(cwd, sessionId, "foreground-resume", home);
  const backgroundResume = new RunStore(cwd, sessionId, "background-resume", home);
  const legacyResume = new RunStore(cwd, sessionId, "legacy-resume", home);
  const foregroundRetry = new RunStore(cwd, sessionId, "foreground-retry", home);
  const backgroundRetry = new RunStore(cwd, sessionId, "background-retry", home);
  const overriddenResume = new RunStore(cwd, sessionId, "overridden-resume", home);
  await foregroundResume.create({ id: "foreground-resume", workflowName: "foreground-resume", cwd, sessionId, state: "budget_exhausted", agents: [], agentSessions: [], delivery: { mode: "background", state: "pending", toolCallId: "foreground-resume-call" } }, snapshot("foreground-resume", "foreground"));
  await backgroundResume.create({ id: "background-resume", workflowName: "background-resume", cwd, sessionId, state: "budget_exhausted", agents: [], agentSessions: [] }, snapshot("background-resume", "background"));
  await legacyResume.create({ id: "legacy-resume", workflowName: "legacy-resume", cwd, sessionId, state: "budget_exhausted", agents: [], agentSessions: [] }, snapshot("legacy-resume"));
  await foregroundRetry.create({ id: "foreground-retry", workflowName: "foreground-retry", cwd, sessionId, state: "failed", agents: [], agentSessions: [] }, snapshot("foreground-retry", "foreground"));
  await backgroundRetry.create({ id: "background-retry", workflowName: "background-retry", cwd, sessionId, state: "failed", agents: [], agentSessions: [] }, snapshot("background-retry", "background"));
  await overriddenResume.create({ id: "overridden-resume", workflowName: "overridden-resume", cwd, sessionId, state: "budget_exhausted", agents: [], agentSessions: [] }, snapshot("overridden-resume", "background"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: Record<string, unknown> }> }> = [];
  const messages: string[] = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, sendMessage(message: { content: string }) { messages.push(message.content); }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_resume", "workflow_retry"] }), home);
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => sessionId } };
  assert.ok(start && shutdown);
  await start({}, context);
  const resume = tools.find(({ name }) => name === "workflow_resume");
  const retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(resume && retry);
  const resumed = await resume.execute("resume", { runId: "foreground-resume" });
  assert.equal(resumed.details.state, "completed");
  assert.equal(resumed.details.value, "foreground-resume");
  const resumedContent = JSON.parse((resumed as unknown as { content: Array<{ text: string }> }).content[0]?.text ?? "null") as { state: string; runId: string; value: { runId: string; resultPath: string; resultBytes: number; inlined: boolean } };
  assert.equal(resumedContent.state, "completed");
  assert.equal(resumedContent.runId, "foreground-resume");
  assert.equal(resumedContent.value.runId, "foreground-resume");
  assert.match(resumedContent.value.resultPath, /result\.json$/);
  assert.equal(resumedContent.value.inlined, false);
  assert.equal((await foregroundResume.load()).run.state, "completed");
  const overridden = await resume.execute("resume-overridden", { runId: "overridden-resume", foreground: true }, undefined, undefined, context);
  assert.equal(overridden.details.state, "completed");
  assert.equal(overridden.details.value, "overridden-resume");
  const overriddenContent = JSON.parse((overridden as unknown as { content: Array<{ text: string }> }).content[0]?.text ?? "null") as { state: string; runId: string; value: string };
  assert.deepEqual(overriddenContent, { state: "completed", runId: "overridden-resume", value: "overridden-resume" });
  assert.equal((await overriddenResume.load()).snapshot.launchMode, "foreground");
  const legacy = await resume.execute("resume-legacy", { runId: "legacy-resume" }, undefined, undefined, context);
  assert.equal(legacy.details.state, "running");
  assert.equal((await legacyResume.load()).snapshot.launchMode, undefined);
  const background = await resume.execute("resume-background", { runId: "background-resume" }, undefined, undefined, context);
  assert.equal(background.details.state, "running");
  const retriedBackground = await retry.execute("retry-background", { runId: "background-retry" }, undefined, undefined, context);
  assert.equal(retriedBackground.details.state, "running");
  const backgroundChildRunId = retriedBackground.details.runId as string;
  assert.ok(backgroundChildRunId);
  for (let attempt = 0; attempt < 1000 && (!messages.some((message) => message.startsWith("Workflow background-resume completed:")) || !messages.some((message) => message.startsWith("Workflow legacy-resume completed:")) || !messages.some((message) => message.startsWith("Workflow background-retry completed:"))); attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 1));
  assert.equal(messages.some((message) => message.startsWith("Workflow background-resume completed:")), true);
  assert.equal(messages.some((message) => message.startsWith("Workflow legacy-resume completed:")), true);
  assert.equal(messages.some((message) => message.startsWith("Workflow background-retry completed:")), true);
  assert.equal((await new RunStore(cwd, sessionId, backgroundChildRunId, home).load()).snapshot.launchMode, "background");
  const retried = await retry.execute("retry", { runId: "foreground-retry" }, undefined, undefined, context);
  assert.equal(retried.details.state, "completed");
  assert.equal(retried.details.value, "foreground-retry");
  const retryContent = JSON.parse((retried as unknown as { content: Array<{ text: string }> }).content[0]?.text ?? "null") as { state: string; runId: string; parentRunId: string; value: string };
  assert.deepEqual(retryContent, { state: "completed", runId: retried.details.runId, parentRunId: "foreground-retry", value: "foreground-retry" });
  const childRunId = retried.details.runId as string;
  assert.ok(childRunId);
  const foregroundChild = await new RunStore(cwd, sessionId, childRunId, home).load();
  assert.equal(foregroundChild.run.state, "completed");
  assert.equal(foregroundChild.snapshot.launchMode, "foreground");
  await shutdown();
});

void test("session_start foreground recovery returns before completion and delivers terminal result", { timeout: 5000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-session-start-foreground-"));
  const cwd = join(home, "project");
  const sessionId = "session";
  const runId = "session-start-foreground";
  const store = new RunStore(cwd, sessionId, runId, home);
  await store.create({ id: runId, workflowName: runId, cwd, sessionId, state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return await checkpoint({ name: 'approval', prompt: 'Approve?', context: {} });", args: null, metadata: { name: runId }, launchMode: "foreground", settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  let releaseCheckpoint!: () => void;
  const checkpointGate = new Promise<void>((resolve) => { releaseCheckpoint = resolve; });
  let showCheckpoint!: () => void;
  const checkpointShown = new Promise<void>((resolve) => { showCheckpoint = resolve; });
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const messages: string[] = [];
  const context = { cwd, hasUI: true, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => sessionId }, ui: { select: async (prompt: string, options: string[]) => { if (prompt.startsWith("1 interrupted")) return options[0]; showCheckpoint(); await checkpointGate; return "Approve"; }, notify() {} } };
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, sendMessage(message: { content: string }) { messages.push(message.content); }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  assert.ok(start && shutdown);
  let startupReturned = false;
  const startup = start({}, context).then(() => { startupReturned = true; });
  await checkpointShown;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(startupReturned, true);
  assert.equal((await store.load()).run.state, "awaiting_input");
  assert.equal((await store.load()).snapshot.launchMode, "foreground");
  assert.deepEqual(messages, []);
  releaseCheckpoint();
  await startup;
  await waitForRunState(store, "completed");
  for (let attempt = 0; attempt < 100 && messages.length === 0; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 1));
  assert.deepEqual(messages, [`Workflow ${runId} completed: "approved"`]);
  await shutdown();
});

void test("interactive interrupted recovery stays detached from foreground completion", { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-interrupted-recovery-"));
  const cwd = join(home, "project");
  const sessionId = "session";
  const runId = "interrupted-foreground";
  const store = new RunStore(cwd, sessionId, runId, home);
  await store.create({ id: runId, workflowName: "interrupted-foreground", cwd, sessionId, state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return await checkpoint({ name: 'approval', prompt: 'Approve?', context: {} });", args: null, metadata: { name: "interrupted-foreground" }, launchMode: "foreground", settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => sessionId }, ui: { select: async () => { await new Promise<void>((resolve) => setTimeout(resolve, 1000)); return "Approve"; }, notify() {} } };
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) { command = options.handler; }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  assert.ok(start && command && shutdown);
  await start({}, context);
  const resumedAt = Date.now();
  await contextualWorkflowAction(command, context, runId, "Resume");
  assert.ok(Date.now() - resumedAt < 500);
  for (let attempt = 0; attempt < 2000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 2));
  const loaded = await store.load();
  assert.equal(loaded.run.state, "completed", JSON.stringify(loaded.run.error));
  await shutdown();
});

void test("interactive budget recovery stays detached from foreground completion", { timeout: 10000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-budget-recovery-"));
  const cwd = join(home, "project");
  const sessionId = "session";
  const snapshot = (name: string) => createLaunchSnapshot({ script: "return await checkpoint({ name: 'approval', prompt: 'Approve?', context: {} });", args: null, metadata: { name }, launchMode: "foreground", settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] });
  const resumeStore = new RunStore(cwd, sessionId, "budget-resume", home);
  const adjustStore = new RunStore(cwd, sessionId, "budget-adjust", home);
  const approveStore = new RunStore(cwd, sessionId, "budget-approve", home);
  await resumeStore.create({ id: "budget-resume", workflowName: "budget-resume", cwd, sessionId, state: "budget_exhausted", agents: [], agentSessions: [] }, snapshot("budget-resume"));
  await adjustStore.create({ id: "budget-adjust", workflowName: "budget-adjust", cwd, sessionId, state: "budget_exhausted", agents: [], agentSessions: [] }, snapshot("budget-adjust"));
  const budget = { tokens: { hard: 1 } };
  await approveStore.create({ id: "budget-approve", workflowName: "budget-approve", cwd, sessionId, state: "budget_exhausted", agents: [], agentSessions: [], budget, budgetVersion: 1, usage: { tokens: 1, costUsd: 0, durationMs: 0, agentLaunches: 0 } }, snapshot("budget-approve"));
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => sessionId }, ui: { select: async () => { await new Promise<void>((resolve) => setTimeout(resolve, 1000)); return "Approve"; }, input: async () => JSON.stringify({ tokens: { hard: 10 } }), notify() {} } };
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) { command = options.handler; }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  assert.ok(start && command && shutdown);
  await start({}, context);
  const assertDetached = async (action: string, store: RunStore) => {
    const handler = command;
    assert.ok(handler);
    const resumedAt = Date.now();
    await contextualWorkflowAction(handler, context, store.runId, action.startsWith("adjust") ? "Adjust budget" : "Resume unchanged");
    assert.ok(Date.now() - resumedAt < 500);
    for (let attempt = 0; attempt < 2000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 2));
    assert.equal((await store.load()).run.state, "completed");
  };
  await assertDetached("resume budget-resume", resumeStore);
  await assertDetached("adjust budget-adjust", adjustStore);
  let adjusted = false;
  await contextualWorkflowAction(command, context, approveStore.runId, (options: string[]) => { if (!adjusted && options.includes("Adjust budget")) { adjusted = true; return "Adjust budget"; } return options.find((option: string) => option.startsWith("Approve budget ")); });
  await waitForRunState(approveStore, "completed");
  await shutdown();
});
void test("workflow_status returns a safe current-project summary across sessions", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-status-"));
  const cwd = join(home, "project");
  const snapshot = (name: string) => createLaunchSnapshot({ script: "return true;", args: null, metadata: { name }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] });
  const agent = { id: "run-current:1", name: "private-name", label: "Review", path: "agent/review", state: "failed" as const, model: { provider: "openai", model: "gpt" }, tools: ["private-tool"], attempts: 2, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 }, activity: { kind: "text" as const, text: "P1_WORKFLOW_STREAM_SECRET\u001b[31m\u0007" }, lastEventAt: 1234, prompt: "PRIVATE PROMPT", systemPrompt: "PRIVATE SYSTEM PROMPT", attemptDetails: [{ attempt: 1, transport: "local", setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: ["private-tool"], cwd }, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 }, session: { transport: "local", sessionId: "private-session" } }] };
  const current = new RunStore(cwd, "current-session", "run-current", home);
  await current.create({ id: "run-current", workflowName: "status-check", cwd, sessionId: "current-session", state: "failed", error: { code: "AGENT_FAILED", message: "failed" }, failedAt: "agent/review", phase: "review", budget: { tokens: { hard: 100 } }, usage: { tokens: 10, costUsd: 0.5, durationMs: 20, agentLaunches: 1 }, delivery: { mode: "background", state: "pending", toolCallId: "private-call" }, agents: [agent], agentSessions: [{ transport: "local", sessionId: "private-session" }] }, snapshot("status-check"));
  const other = new RunStore(cwd, "other-session", "run-other", home);
  await other.create({ id: "run-other", workflowName: "other-status", cwd, sessionId: "other-session", state: "interrupted", agents: [], agentSessions: [] }, snapshot("other-status"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: Record<string, unknown> }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  const status = tools.find(({ name }) => name === "workflow_status");
  assert.ok(status);
  const context = { cwd, sessionManager: { getSessionId: () => "current-session" } };
  const result = await status.execute("status", { runId: "run-current" }, undefined, undefined, context);
  assert.deepEqual(result.details, { runId: "run-current", workflowName: "status-check", state: "failed", error: { code: "AGENT_FAILED", message: "failed" }, failedAt: "agent/review", budget: { tokens: { hard: 100 } }, usage: { tokens: 10, costUsd: 0.5, durationMs: 20, agentLaunches: 1 }, phase: "review", delivery: { mode: "background", state: "pending" }, agents: [{ id: "run-current:1", label: "Review", path: "agent/review", state: "failed", lastEventAt: 1234, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }] });
  const firstContent = result.content[0];
  assert.ok(firstContent);
  const resultText = firstContent.text;
  assert.equal(resultText.includes("P1_WORKFLOW_STREAM_SECRET"), false);
  assert.equal(resultText.includes(String.fromCharCode(27)), false);
  assert.equal(resultText.includes(String.fromCharCode(7)), false);
  const crossSession = await status.execute("status", { runId: "run-other" }, undefined, undefined, context);
  assert.deepEqual(crossSession.details, { runId: "run-other", workflowName: "other-status", state: "interrupted", agents: [] });
  const legacy = new RunStore(cwd, "legacy-session", "run-legacy", home);
  await legacy.create({ id: "run-legacy", workflowName: "legacy-status", cwd, sessionId: "legacy-session", state: "interrupted", agents: [], agentSessions: [] }, snapshot("legacy-status"));
  writeFileSync(join(legacy.directory, "state.json"), JSON.stringify({ id: "run-legacy", workflowName: "legacy-status", cwd, sessionId: "legacy-session", state: "interrupted", nativeSessions: [], agents: [] }));
  const legacyResult = await status.execute("status", { runId: "run-legacy" }, undefined, undefined, context);
  assert.deepEqual(legacyResult.details, { runId: "run-legacy", workflowName: "legacy-status", state: "interrupted", agents: [] });
  writeFileSync(join(legacy.directory, "state.json"), "{\n");
  await assert.rejects(status.execute("status", { runId: "run-legacy" }, undefined, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "RUN_NOT_FOUND");
  await assert.rejects(status.execute("status", { runId: "missing" }, undefined, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "RUN_NOT_FOUND");
});
