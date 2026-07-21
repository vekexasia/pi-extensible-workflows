import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import workflowExtension, { createLaunchSnapshot, FairAgentScheduler, formatNavigatorDashboard, formatNavigatorRun, persistActiveAgentAttempt, persistAgentAttempts, registerWorkflowExtension, runWorkflow, structuralPath, WorkflowAgentExecutor, WorkflowError, type JsonValue, type WorkflowExtension } from "../src/index.js";
import { createNativeAgentSession } from "../src/agent-execution.js";
import { listRunIds, RunStore } from "../src/persistence.js";
import type { NativeSession, SessionInput } from "../src/agent-execution.js";
function sessionStats(cost = 0.25) { return { tokens: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, total: 14 }, cost }; }
let acceptanceFunctionCalls = 0;
let acceptanceVariableCalls = 0;
let variableSiblingAborted = false;
let variableContext: unknown;
let markStopVariableStarted: (() => void) | undefined;
let stopVariableAborted = false;
let coldVariableCalls = 0;
const acceptanceExtension: WorkflowExtension = {
  version: "1.0.0", headline: "Acceptance", description: "Acceptance globals",
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
  variables: {
    resolvedValue: { description: "Resolved value", schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, resolve(run) { acceptanceVariableCalls += 1; return { value: run.workflow.name }; } },
    contextValue: { description: "Context probe", schema: { type: "string" }, resolve(run) { if (run.workflow.name === "variable-context") variableContext = run; return "ok"; } },
    bindingValue: { description: "Immutable binding", schema: { type: "object", properties: { nested: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } }, required: ["nested"], additionalProperties: false }, resolve: () => ({ nested: { value: "original" } }) },
    failureVariable: { description: "Primary failure", schema: { type: "string" }, resolve(run) { if (run.workflow.name === "variable-failure") throw new Error("primary variable failure"); return "ok"; } },
    siblingVariable: { description: "Sibling failure", schema: { type: "string" }, resolve(run) { if (run.workflow.name !== "variable-failure") return "ok"; return new Promise<string>((resolve) => { if (run.signal.aborted) { variableSiblingAborted = true; resolve("aborted"); return; } run.signal.addEventListener("abort", () => { variableSiblingAborted = true; resolve("aborted"); }, { once: true }); }); } },
    invalidVariable: { description: "Invalid output", schema: { type: "string" }, resolve(run) { return run.workflow.name === "invalid-variable" ? 3 : "ok"; } },
    nonJsonVariable: { description: "Non JSON output", schema: { type: "string" }, resolve(run) { return run.workflow.name === "non-json-variable" ? undefined as unknown as JsonValue : "ok"; } },
    coldVariable: { description: "Cold value", schema: { type: "string" }, resolve(run) { return run.workflow.name === "cold-variable" ? `cold-${String(++coldVariableCalls)}` : "unused"; } },
    resumeFailureVariable: { description: "Resume failure", schema: { type: "string" }, resolve(run) { if (run.workflow.name === "resume-variable-failure") throw new Error("resume variable failure"); return "ok"; } },
    stopVariable: { description: "Stop race", schema: { type: "string" }, resolve(run) { if (run.workflow.name !== "cold-stop") return "ok"; markStopVariableStarted?.(); return new Promise<string>((resolve) => { if (run.signal.aborted) { stopVariableAborted = true; resolve("aborted"); return; } run.signal.addEventListener("abort", () => { stopVariableAborted = true; resolve("aborted"); }, { once: true }); }); } },
  }
};
function registerAcceptanceExtension(): void { registerWorkflowExtension(acceptanceExtension); }

void test("production session_start cold-restores ownership and /workflow stop cascades", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-acceptance-"));
  const cwd = join(home, "project");
  const sessionId = "session-a";
  const runId = "run-a";
  const store = new RunStore(cwd, sessionId, runId, home);
  const settings = { concurrency: 1 };
  await store.create({ id: runId, workflowName: "cold", cwd, sessionId, state: "interrupted", agents: [], nativeSessions: [] }, createLaunchSnapshot({ script: "export const meta={name:'cold',description:'cold'}", args: null, metadata: { name: "cold", description: "cold" }, settings, models: ["openai-codex/gpt-5.6-sol"], tools: ["agent"], agentTypes: [], roles: {}, schemas: [] }));
  const parentOptions = { label: "parent", cwd, tools: ["agent"], model: "runtime/runtime-model" };
  await store.saveOwnership([{ id: `${runId}:1`, label: "parent", state: "waiting_for_child", options: parentOptions }, { id: `${runId}:2`, parentId: `${runId}:1`, label: "child", state: "running", options: { label: "child", cwd, tools: [], model: "runtime/runtime-model" } }]);

  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const notices: string[] = [];
  const ctx = { cwd, model: { provider: "openai-codex", id: "gpt-5.6-sol" }, sessionManager: { getSessionId: () => sessionId }, ui: { notify: (message: string) => { notices.push(message); } } };
  workflowExtension({ on(name: string, handler: typeof start) { if (name === "session_start") start = handler; }, registerTool() {}, registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  assert.ok(start && command);
  await start({}, ctx);
  await command(`stop ${runId}`, ctx);
  assert.equal((await store.load()).run.state, "stopped");
  assert.deepEqual((await store.loadOwnership()).map(({ state }) => state), ["cancelled", "cancelled"]);
  assert.deepEqual((await store.load()).run.agents.map(({ state }) => state), ["cancelled", "cancelled"]);
  assert.deepEqual((await store.load()).run.agents.map(({ model, tools }) => ({ model, tools })), [{ model: { provider: "runtime", model: "runtime-model", thinking: "medium" }, tools: ["agent"] }, { model: { provider: "runtime", model: "runtime-model", thinking: "medium" }, tools: [] }]);
  assert.deepEqual(notices, [`Stopped workflow ${runId}.`]);
});

void test("cold resume persists effective role, fallback, nested, retry, and explicit policies", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-policy-reporting-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  const script = "const role = await agent(\"top role\", { role: \"reviewer\" }); const named = await agent(\"named\", { label: \"API inspection\" }); const parent = await agent(\"nested policies\"); return { role, named, parent };";
  const role = { prompt: "Review role", model: "role-provider/role-model", thinking: "high" as const, tools: ["read"], disabledAgentResources: { skills: ["role-only"], extensions: [join(home, "role-only.ts")] } };
  const snapshot = createLaunchSnapshot({ script, args: null, metadata: { name: "policy-reporting" }, settings: { concurrency: 2 }, models: ["root-provider/root-model", "role-provider/role-model", "case-provider/model-only", "case-provider/model-and-thinking"], tools: ["agent", "read"], agentTypes: ["reviewer"], roles: { reviewer: role }, schemas: [] });
  await store.create({ id: "run-a", workflowName: "policy-reporting", cwd, sessionId: "session-a", state: "interrupted", agents: [], nativeSessions: [] }, snapshot);
  await store.saveOwnership([]);
  const inputs = new Map<string, SessionInput>();
  let nextSession = 0;
  const createSession = async (input: SessionInput): Promise<NativeSession> => {
    const sessionId = `native-${String(++nextSession)}`;
    inputs.set(sessionId, input);
    const executeTool = async (name: string, params: Record<string, unknown>): Promise<unknown> => {
      const tool = input.customTools?.find(({ name: candidate }) => candidate === name);
      assert.ok(tool);
      return tool.execute(sessionId, params, undefined, undefined, undefined as never);
    };
    const collectChild = async (options: Record<string, unknown>): Promise<void> => {
      const spawned = await executeTool("agent", options) as { content?: Array<{ text?: string }> };
      const childId = (JSON.parse(spawned.content?.[0]?.text ?? "{}") as { id?: string }).id;
      assert.ok(childId);
      await executeTool("get_subagent_result", { id: childId });
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
            { prompt: "model only", label: "model-only", model: "case-provider/model-only" },
            { prompt: "thinking only", label: "thinking-only", thinking: "low" },
            { prompt: "tools only", label: "tools-only", tools: ["read"] },
            { prompt: "combined", label: "combined", model: "case-provider/model-and-thinking", thinking: "high", tools: ["read"] },
          ]) await collectChild(options);
        }
      },
      steer: async () => {},
      dispose() {},
    };
  };
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const ctx = { cwd, hasUI: false, model: { provider: "root-provider", id: "root-model" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {} } };
  workflowExtension({ on(name: string, handler: typeof start) { if (name === "session_start") start = handler; }, registerTool() {}, registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["agent", "read", "workflow"] } as never, home, async () => {}, createSession);
  assert.ok(start && command);
  await start({}, ctx);
  await command("resume run-a", ctx);
  for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  const loaded = await store.load();
  assert.equal(loaded.run.state, "completed");
  assert.deepEqual(loaded.snapshot.roles?.reviewer?.disabledAgentResources, role.disabledAgentResources);
  const attempts = loaded.run.agents.flatMap((agent) => (agent.attemptDetails ?? []).map((attempt) => ({ agent, attempt })));
  assert.equal(inputs.size, 9);
  assert.equal(attempts.length, inputs.size);
  for (const { agent, attempt } of attempts) {
    const input = inputs.get(attempt.sessionId);
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
});

void test("cold resume rejects obsolete identity snapshots", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-old-snapshot-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "old", cwd, sessionId: "session-a", state: "interrupted", agents: [], nativeSessions: [] }, createLaunchSnapshot({ identityVersion: 0, script: "return true", args: null, metadata: { name: "old" }, settings: { concurrency: 1, maxAgentLaunches: 5 } as never, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] }));
  assert.equal((await store.load()).snapshot.identityVersion, 0);
  await store.saveOwnership([{ id: "run-a:1", label: "legacy", state: "running", options: { label: "legacy", cwd, tools: [], isolation: "worktree" } }] as never);
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const ctx = { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session-a" } };
  workflowExtension({ on(name: string, handler: never) { if (name === "session_start") start = handler; if (name === "session_shutdown") shutdown = handler; }, registerTool() {}, registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  assert.ok(start && shutdown && command);
  await start({}, ctx);
  await assert.rejects(command("resume run-a", ctx), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE" && /identity version/.test(error.message));
  await shutdown();
});

void test("cold resume rejects project roles after trust is revoked", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-untrusted-resume-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "untrusted", cwd, sessionId: "session-a", state: "interrupted", agents: [], nativeSessions: [] }, createLaunchSnapshot({ script: `return agent("review", {role:"reviewer"});`, args: null, metadata: { name: "untrusted" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: ["reviewer"], roles: { reviewer: { prompt: "project role" } }, projectRoles: ["reviewer"], schemas: [] }));
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const ctx = { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session-a" }, isProjectTrusted: () => false };
  workflowExtension({ on(name: string, handler: never) { if (name === "session_start") start = handler; }, registerTool() {}, registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  assert.ok(start && command);
  await start({}, ctx);
  await assert.rejects(command("resume run-a", ctx), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE" && /untrusted project/.test(error.message));
});

void test("cold resume replays completed agents by hidden structural identity", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-agent-replay-"));
  const cwd = join(home, "project");
  const script = `return withWorktree("recovery", async () => agent("must replay"));`;
  let replayPath = "";
  assert.equal(await runWorkflow(script, null, { agent: async (_prompt, _options, _signal, identity) => { replayPath = structuralPath("agent", ...identity.structuralPath, `callsite:${identity.callSite}`, `occurrence:${String(identity.occurrence)}`); return "original"; } }).result, "original");
  assert.ok(replayPath);
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "agent-replay", cwd, sessionId: "session-a", state: "interrupted", agents: [], nativeSessions: [] }, createLaunchSnapshot({ script, args: null, metadata: { name: "agent-replay" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  await store.complete(replayPath, "replayed");
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const ctx = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {} } };
  workflowExtension({ on(name: string, handler: never) { if (name === "session_start") start = handler; }, registerTool() {}, registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  assert.ok(start && command);
  await start({}, ctx);
  await command("resume run-a", ctx);
  for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await store.load()).run.state, "completed");
  assert.deepEqual(await store.replay(replayPath), { path: replayPath, value: "replayed" });
});

void test("cold recovery delivers a persisted checkpoint only once before replay", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-checkpoint-recovery-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  const script = `export const meta={name:'cold-gate',description:'cold gate'}; return checkpoint({name:'ship',prompt:'Ship?',context:{sha:'abc'}});`;
  await store.create({ id: "run-a", workflowName: "cold-gate", cwd, sessionId: "session-a", state: "interrupted", agents: [], nativeSessions: [], error: { code: "CANCELLED", message: "interrupted" } }, createLaunchSnapshot({ script, args: null, metadata: { name: "cold-gate", description: "cold gate" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
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
  assert.equal((await store.load()).run.error, undefined);
  assert.deepEqual(await store.replay("checkpoint/ship"), { path: "checkpoint/ship", value: true });
});


void test("production restart recovery and graceful shutdown persist durable completion", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-lifecycle-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "life", cwd, sessionId: "session-a", state: "running", agents: [], nativeSessions: [] }, createLaunchSnapshot({ script: "export const meta={name:'life',description:'life'}", args: null, metadata: { name: "life", description: "life" }, settings: { concurrency: 1 }, models: ["openai-codex/gpt-5.6-sol"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const ctx = { cwd, model: { provider: "openai-codex", id: "gpt-5.6-sol" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {} } };
  workflowExtension({ on(name: string, handler: never) { if (name === "session_start") start = handler; if (name === "session_shutdown") shutdown = handler; }, registerTool() {}, registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  assert.ok(start && shutdown && command);
  await start({}, ctx);
  assert.equal((await store.load()).run.state, "interrupted");
  await shutdown();
  assert.equal((await store.load()).run.state, "interrupted");
  await command("resume run-a", ctx);
  for (let attempt = 0; attempt < 100 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await store.load()).run.state, "completed");
  assert.equal(JSON.parse(readFileSync(join(store.directory, "result.json"), "utf8")), null);
});

void test("production Pi seam installs child tools and registers native steering", async () => {
  const childTool = { name: "agent", label: "Child", description: "child", parameters: Type.Object({}), async execute() { return { content: [{ type: "text" as const, text: "ok" }], details: {} }; } };
  const session = await createNativeAgentSession({ cwd: process.cwd(), model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "medium" }, tools: [], customTools: [childTool], sessionLabel: "issue-9-acceptance" });
  assert.ok(session.agent?.state.tools.some(({ name }) => name === "agent"));
  session.dispose();
  let steer: ((message: string) => void | Promise<void>) | undefined;
  const received: string[] = [];
  const executor = new WorkflowAgentExecutor({ cwd: "/repo", model: { provider: "openai", model: "gpt" }, tools: new Set() }, async () => ({ sessionId: "s", sessionFile: "/s", messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }] }], getSessionStats: sessionStats, prompt: async () => {}, steer: async (message) => { received.push(message); }, dispose() {} }));
  await executor.execute("work", { label: "worker", workflowName: "flow" }, undefined, [], (handler) => { steer = handler; });
  assert.ok(steer); await steer("redirect"); assert.deepEqual(received, ["redirect"]);
});

void test("production conversation turns reopen transcript and advance persisted head", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-conversation-acceptance-"));
  const inputs: SessionInput[] = [];
  const createSession = async (input: SessionInput): Promise<NativeSession> => {
    inputs.push(input);
    const continued = input.continuation !== undefined;
    let leafId = input.continuation?.leafId ?? "root";
    return {
      sessionId: "conversation-session",
      sessionFile: "/sessions/conversation.jsonl",
      model: { provider: "openai", model: "gpt" },
      messages: [{ role: "assistant", content: [{ type: "text", text: continued ? "second" : "first" }] }],
      getSessionStats: sessionStats,
      systemPrompt: "stable conversation prompt",
      getLeafId: () => leafId,
      getToolDefinitions: () => [],
      prompt: async () => { leafId = continued ? "leaf-2" : "leaf-1"; },
      steer: async () => {},
      dispose() {},
    };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { value?: unknown; runId: string } }> }> = [];
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home, async () => {}, createSession);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const result = await workflow.execute("id", { name: "conversation-acceptance", script: "const handle = conversation('developer'); return [await handle.run('first'), await handle.run('second')];", foreground: true }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  assert.deepEqual(result.details.value, ["first", "second"]);
  assert.equal(inputs.length, 2);
  assert.equal(inputs[0]?.continuation, undefined);
  assert.deepEqual(inputs[1]?.continuation, { sessionId: "conversation-session", sessionFile: "/sessions/conversation.jsonl", leafId: "leaf-1" });
  const store = new RunStore(home, "session", result.details.runId, home);
  const artifact = JSON.parse(readFileSync(store.conversationPath(), "utf8")) as { conversations: Record<string, { head: { turn: number; leafId: string } }> };
  const conversations = Object.values(artifact.conversations);
  assert.equal(conversations.length, 1);
  const conversation = conversations[0];
  assert.ok(conversation);
  assert.equal(conversation.head.turn, 2);
  assert.equal(conversation.head.leafId, "leaf-2");
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
  const executor = new WorkflowAgentExecutor({ cwd: "/repo", model: { provider: "openai", model: "gpt" }, tools: new Set() }, async () => { const current = ++attempt; return { sessionId: `s${String(current)}`, sessionFile: `/s${String(current)}`, messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: { total: 0.5 } } }], getSessionStats: () => sessionStats(0.5), prompt: async () => { if (current === 1) throw new Error("retry"); }, dispose() {} }; });
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
  await assert.rejects(pipelineRun.result, (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID" && error.message === "invalid first" && (error as WorkflowError & { failedAt?: string }).failedAt?.startsWith("pipe%2Ffirst%2Frun/agent%2F"));

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

void test("terminal failed attempts remain persisted", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-attempts-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "failed", cwd, sessionId: "session-a", state: "running", agents: [{ id: "run-a:1", name: "agent", path: "run-a:1", state: "running", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 0 }], nativeSessions: [] }, createLaunchSnapshot({ script: "export const meta={name:'failed',description:'failed'}", args: null, metadata: { name: "failed" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] }));
  await persistActiveAgentAttempt(store, "run-a:1", { attempt: 1, sessionId: "failed-session", sessionFile: "/sessions/failed.jsonl" });
  const active = (await store.load()).run;
  assert.equal(active.agents[0]?.attemptDetails?.[0]?.sessionFile, "/sessions/failed.jsonl");
  assert.deepEqual(active.nativeSessions, [{ sessionId: "failed-session", sessionFile: "/sessions/failed.jsonl" }]);
  await persistAgentAttempts(store, "run-a:1", [{ attempt: 1, sessionId: "failed-session", sessionFile: "/sessions/failed.jsonl", error: { code: "AGENT_FAILED", message: "failed" }, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }]);
  const persisted = (await store.load()).run;
  assert.deepEqual(persisted.agents.map(({ attempts, accounting }) => ({ attempts, accounting })), [{ attempts: 1, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }]);
  assert.deepEqual(persisted.nativeSessions, [{ sessionId: "failed-session", sessionFile: "/sessions/failed.jsonl" }]);
});

void test("registered extension agents persist structural scope for late siblings", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-issue69-identity-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { runId?: string; value?: unknown } }> }> = [];
  let nextSession = 0;
  const createSession = async (): Promise<NativeSession> => ({
    sessionId: `issue69-${String(++nextSession)}`,
    sessionFile: `/sessions/${String(nextSession)}.jsonl`,
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: sessionStats,
    prompt: async () => {},
    steer: async () => {},
    dispose() {},
  });
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home, async () => {}, createSession);
  registerWorkflowExtension({ version: "1.0.0", headline: "Identity", description: "Identity acceptance", functions: { review: { description: "Review", input: { type: "object" }, output: { type: "string" }, run: (_input, context) => context.agent("developer", { label: "developer" }) } } });
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const result = await workflow.execute("id", { name: "issue69", script: `return parallel("issues", { "issue-65": async () => { const first = await review({}); await Promise.resolve(); const second = await review({}); return [first, second]; }, "issue-66": () => review({}) });`, foreground: true }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  const run = new RunStore(home, "session", result.details.runId ?? "", home);
  const loaded = await run.load();
  const issue65 = loaded.run.agents.filter((agent) => JSON.stringify(agent.structuralPath) === JSON.stringify(["issues", "issue-65"]));
  const issue66 = loaded.run.agents.filter((agent) => JSON.stringify(agent.structuralPath) === JSON.stringify(["issues", "issue-66"]));
  assert.equal(issue65.length, 2);
  assert.equal(issue66.length, 1);
  assert.ok(loaded.run.agents.every((agent) => agent.parentBreadcrumb === "review"));
  assert.ok(loaded.run.agents.every((agent) => !agent.worktreeOwner));
  const rendered = formatNavigatorDashboard(loaded.run, [], []);
  assert.match(rendered, /issues > issue-65 > review/);
  assert.match(rendered, /issues > issue-66 > review/);
});
void test("production workflow exposes registered global functions and replays them structurally", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-global-acceptance-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { runId: string; value: unknown } }> }> = [];
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_catalog"] } as never, home);
  registerAcceptanceExtension();
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const script = `phase('verify'); const resolved=resolvedValue.value; const first=await echo({value:'first'}); const replayed=await echo({value:'second'}); const parallelResults=await parallel('global-parallel',{first:()=>echo({value:'parallel-first'}),second:()=>echo({value:'parallel-second'})}); const pipelineResults=await pipeline('global-pipeline',{first:'pipeline-value'},{echo:value=>echo({value})}); const orchestrated=await orchestrate({}); return {resolved,first,replayed,parallelResults,pipelineResults,orchestrated};`;
  const result = await workflow.execute("id", { name: "global-e2e", script, foreground: true }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  assert.deepEqual(result.details.value, { resolved: "global-e2e", first: { value: "first" }, replayed: { value: "second" }, parallelResults: { first: { value: "parallel-first" }, second: { value: "parallel-second" } }, pipelineResults: { first: { value: "pipeline-value" } }, orchestrated: { parallel: { first: 1, second: 2 }, pipeline: { first: 2, second: 4 }, parallelWaited: true, parallelCode: "AGENT_FAILED", pipelineWaited: true, pipelineCode: "RESULT_INVALID" } });
  assert.equal(acceptanceFunctionCalls, 5);
  assert.ok(acceptanceVariableCalls >= 1);
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
  const createSession = async (input: SessionInput): Promise<NativeSession> => {
    inputs.push(input);
    for (const factory of input.extensionFactories ?? []) await (typeof factory === "function" ? factory({ registerTool(tool: { name: string }) { installed.push(tool.name); } } as never) : factory.factory({ registerTool(tool: { name: string }) { installed.push(tool.name); } } as never));
    return { sessionId: `setup-${String(inputs.length)}`, sessionFile: `/sessions/setup-${String(inputs.length)}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: sessionStats, prompt: async () => {}, steer: async () => {}, dispose() {} };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { value: unknown } }> }> = [];
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["read", "workflow"] } as never, home, async () => {}, createSession);
  registerWorkflowExtension({ version: "1.0.0", headline: "Setup hooks", description: "Setup hook fixture", agentSetupHooks: { advisor: { setup(agent) { if (agent.options.advisor !== true) return; agent.sessionInput.extensionFactories ??= []; agent.sessionInput.extensionFactories.push(scopedAdvisorFactory); } } } });
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const result = await workflow.execute("id", { name: "setup-hooks", script: `return parallel("agents", { marked: () => agent("marked", { advisor: true }), plain: () => agent("plain") });`, foreground: true }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  assert.deepEqual(result.details.value, { marked: "done", plain: "done" });
  assert.equal(inputs.filter(({ options }) => options?.advisor === true).length, 1);
  assert.equal(inputs.filter(({ options }) => options?.advisor !== true).length, 1);
  assert.deepEqual(installed, ["scoped-advisor"]);
});
void test("parent registry survives nested agent session lifecycle", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-registry-session-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details: { value?: unknown } }> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let nestedLifecycleRan = false;
  const createSession = async (): Promise<NativeSession> => ({
    sessionId: "nested", sessionFile: "/sessions/nested.jsonl", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: sessionStats,
    prompt: async () => {
      const nestedHome = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-nested-registry-"));
      let nestedStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
      let nestedShutdown: (() => Promise<void>) | undefined;
      workflowExtension({ registerTool() {}, registerCommand() {}, getActiveTools: () => ["workflow"], on(name: string, handler: unknown) { if (name === "session_start") nestedStart = handler as typeof nestedStart; if (name === "session_shutdown") nestedShutdown = handler as typeof nestedShutdown; } } as never, nestedHome);
      assert.ok(nestedStart && nestedShutdown);
      await nestedStart({}, { cwd: nestedHome, sessionManager: { getSessionId: () => "nested" } });
      await nestedShutdown();
      nestedLifecycleRan = true;
    },
    steer: async () => {}, dispose() {},
  });
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_catalog"], on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; } } as never, home, async () => {}, createSession);
  registerWorkflowExtension({
    version: "1.0.0", headline: "Registry session", description: "Registry session acceptance",
    functions: {
      afterNested: {
        description: "Run after a nested session",
        input: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
        output: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false },
        run: (input) => ({ value: input.value as string }),
      },
    },
  });
  assert.ok(start);
  await start({}, { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "parent" } });
  const workflow = tools.find(({ name }) => name === "workflow");
  const catalog = tools.find(({ name }) => name === "workflow_catalog");
  assert.ok(workflow && catalog);
  const result = await workflow.execute("id", { name: "registry-session", script: "await agent('nested'); return afterNested({value:'after'});", foreground: true }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "parent" } });
  assert.equal(nestedLifecycleRan, true);
  assert.deepEqual(result.details.value, { value: "after" });
  const listed = JSON.parse((await catalog.execute()).content[0]?.text ?? "null") as { functions: Array<{ name: string }> };
  assert.equal(listed.functions.some(({ name }) => name === "afterNested"), true);
  registerAcceptanceExtension();
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
    version: "1.0.0", headline: "Shared worktree", description: "Shared worktree acceptance",
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
  const createSession = async (input: SessionInput): Promise<NativeSession> => {
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
          const launched = await childTool.execute(sessionId, { prompt: "nested", label: "nested" }, undefined, undefined, undefined as never) as { content?: Array<{ text?: string }> };
          const parsed = JSON.parse(launched.content?.[0]?.text ?? "{}") as { id?: unknown };
          if (typeof parsed.id !== "string") throw new Error("Missing nested agent id");
          await resultTool.execute(sessionId, { id: parsed.id }, undefined, undefined, undefined as never);
        }
      },
      steer: async () => {}, dispose() {},
    };
  };
  const messages: string[] = [];
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { runId: string } }> }> = [];
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "agent"], sendMessage(message: { content: string }) { messages.push(message.content); } } as never, home, async () => {}, createSession);
  registerWorkflowExtension(extension);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const script = `const values = await withWorktree("shared", async () => parallel("top", { retry: () => agent("retry", { retries: 1 }), direct: () => agent("direct"), inherited: () => inherited({}), scoped: () => scoped({}), composed: () => composed({}) })); return { values, outside: await agent("outside") };`;
  const started = await workflow.execute("id", { name: "shared-worktree", script }, new AbortController().signal, undefined, { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  const runId = started.details.runId;
  const store = new RunStore(cwd, "session", runId, home);
  for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
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

void test("production variables resolve before persistence, freeze public bindings, and abort siblings", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-variable-acceptance-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details?: { value?: unknown } }> }> = [];
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const contextResult = await workflow.execute("id", { name: "variable-context", args: { nested: { value: 1 } }, script: "return true;", foreground: true }, new AbortController().signal, undefined, context);
  assert.equal(contextResult.details?.value, true);
  const run = variableContext as { cwd: string; sessionId: string; runId: string; workflow: object; args: object; signal: AbortSignal };
  assert.ok(run);
  assert.deepEqual(Object.keys(run).sort(), ["args", "cwd", "runId", "sessionId", "signal", "workflow"]);
  assert.ok(Object.isFrozen(run));
  assert.ok(Object.isFrozen(run.workflow));
  assert.ok(Object.isFrozen(run.args));
  const bindings = await workflow.execute("id", { name: "variable-bindings", script: "const descriptor=Object.getOwnPropertyDescriptor(globalThis,'bindingValue'); let rejected=false; try { bindingValue={nested:{value:'changed'}}; } catch { rejected=true; } try { bindingValue.nested.value='changed'; } catch {} return { writable: descriptor?.writable, configurable: descriptor?.configurable, rejected, value: bindingValue.nested.value, frozen: Object.isFrozen(bindingValue), nestedFrozen: Object.isFrozen(bindingValue.nested) };", foreground: true }, new AbortController().signal, undefined, context);
  assert.deepEqual(bindings.details?.value, { writable: false, configurable: false, rejected: false, value: "original", frozen: true, nestedFrozen: true });
  const beforeFailure = await listRunIds(home, "session", home);
  variableSiblingAborted = false;
  await assert.rejects(workflow.execute("id", { name: "variable-failure", script: "return 'worker started';", foreground: true }, new AbortController().signal, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "INTERNAL_ERROR");
  assert.equal(variableSiblingAborted, true);
  assert.deepEqual(await listRunIds(home, "session", home), beforeFailure);
  for (const name of ["invalid-variable", "non-json-variable"]) {
    const isolatedHome = mkdtempSync(join(tmpdir(), `pi-extensible-workflows-${name}-`));
    const isolatedTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
    workflowExtension({ registerTool(tool: (typeof isolatedTools)[number]) { isolatedTools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, isolatedHome);
    const isolatedWorkflow = isolatedTools.find(({ name: toolName }) => toolName === "workflow");
    assert.ok(isolatedWorkflow);
    await assert.rejects(isolatedWorkflow.execute("id", { name, script: "return 'worker started';", foreground: true }, new AbortController().signal, undefined, { ...context, cwd: isolatedHome, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID");
    assert.deepEqual(await listRunIds(isolatedHome, "session", isolatedHome), []);
  }
});
void test("workflow_catalog is excluded from child tools", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-catalog-child-"));
  const inputs: SessionInput[] = [];
  let nextSession = 0;
  const createSession = async (input: SessionInput): Promise<NativeSession> => {
    inputs.push(input);
    return { sessionId: `catalog-child-${String(++nextSession)}`, sessionFile: "/tmp/catalog-child.jsonl", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: sessionStats, prompt: async () => {}, steer: async () => {}, dispose() {} };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details?: { value?: unknown } }> }> = [];
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_catalog", "workflow_stop", "read"] } as never, home, async () => {}, createSession);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  await workflow.execute("id", { name: "catalog-child", script: "return await agent('child');", foreground: true }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  assert.equal(inputs[0]?.tools.includes("workflow_catalog"), false);
  assert.equal(inputs[0].tools.includes("workflow_stop"), false);
});
void test("cold resume recomputes variables and marks resolver failures", { timeout: 5000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-variable-resume-"));
  const cwd = join(home, "project");
  const cold = new RunStore(cwd, "session", "cold-run", home);
  const failed = new RunStore(cwd, "session", "failed-run", home);
  const snapshot = (name: string, script: string) => createLaunchSnapshot({ script, args: null, metadata: { name }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: ["workflow_catalog"], agentTypes: [], roles: {}, schemas: [] });
  await cold.create({ id: "cold-run", workflowName: "cold-variable", cwd, sessionId: "session", state: "interrupted", agents: [], nativeSessions: [] }, snapshot("cold-variable", "return coldVariable;"));
  await failed.create({ id: "failed-run", workflowName: "resume-variable-failure", cwd, sessionId: "session", state: "interrupted", agents: [], nativeSessions: [] }, snapshot("resume-variable-failure", "return true;"));
  const stopped = new RunStore(cwd, "session", "stop-run", home);
  await stopped.create({ id: "stop-run", workflowName: "cold-stop", cwd, sessionId: "session", state: "interrupted", agents: [], nativeSessions: [] }, snapshot("cold-stop", "return true;"));
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
  workflowExtension({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; }, registerTool() {}, registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  assert.ok(start && command);
  await start({}, context);
  await command("resume cold-run", context);
  for (let attempt = 0; attempt < 1000 && (await cold.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(JSON.parse(readFileSync(join(cold.directory, "result.json"), "utf8")), "cold-1");
  assert.equal(coldVariableCalls, 1);
  await assert.rejects(command("resume failed-run", context), (error: unknown) => error instanceof WorkflowError && error.code === "INTERNAL_ERROR");
  assert.deepEqual((await failed.load()).run.error, { code: "INTERNAL_ERROR", message: "resumeFailureVariable: resume variable failure" });
  assert.equal((await failed.load()).run.state, "failed");
  const started = new Promise<void>((resolve) => { markStopVariableStarted = resolve; });
  stopVariableAborted = false;
  const resuming = command("resume stop-run", context).catch(() => undefined);
  await started;
  await command("stop stop-run", context);
  await resuming;
  assert.equal(stopVariableAborted, true);
  assert.equal((await stopped.load()).run.state, "stopped");
});
void test("restart recovers every persisted nonterminal run state", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-recovery-states-"));
  const cwd = join(home, "project");
  const states = ["running", "pausing", "paused", "awaiting_input"] as const;
  const stores = states.map((state, index) => new RunStore(cwd, "session-a", `run-${String(index)}`, home));
  for (const [index, state] of states.entries()) {
    const id = `run-${String(index)}`;
    await stores[index]?.create({ id, workflowName: id, cwd, sessionId: "session-a", state, agents: [], nativeSessions: [] }, createLaunchSnapshot({ script: `return '${id}';`, args: null, metadata: { name: id }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  }
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const ctx = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {} } };
  workflowExtension({ on(name: string, handler: never) { if (name === "session_start") start = handler; }, registerTool() {}, registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  assert.ok(start && command);
  await start({}, ctx);
  for (const [index, store] of stores.entries()) {
    assert.equal((await store.load()).run.state, "interrupted");
    await command(`resume run-${String(index)}`, ctx);
  }
  for (const [index, store] of stores.entries()) {
    for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await store.load()).run.state, "completed");
    assert.equal(JSON.parse(readFileSync(join(store.directory, "result.json"), "utf8")), `run-${String(index)}`);
  }
});
void test("cold-resumed failures deliver custom errors as prose while persistence keeps codes", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-recovery-failure-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  const message = "The restored approval gate rejected the release.";
  await store.create({ id: "run-a", workflowName: "restored-failure", cwd, sessionId: "session-a", state: "interrupted", agents: [], nativeSessions: [] }, createLaunchSnapshot({ script: `throw new Error(${JSON.stringify(message)});`, args: null, metadata: { name: "restored-failure" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const messages: string[] = [];
  const ctx = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {} } };
  workflowExtension({ on(name: string, handler: never) { if (name === "session_start") start = handler; }, registerTool() {}, registerCommand(_name: string, value: { handler: typeof command }) { command = value.handler; }, sendMessage(value: { content: string }) { messages.push(value.content); }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  assert.ok(start && command);
  await start({}, ctx);
  await command("resume run-a", ctx);
  for (let attempt = 0; attempt < 100 && (await store.load()).run.state !== "failed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const loaded = await store.load();
  assert.equal(loaded.run.state, "failed");
  assert.deepEqual(loaded.run.error, { code: "INTERNAL_ERROR", message });
  assert.ok(messages.some((value) => value.includes(message)));
  assert.ok(messages.every((value) => !value.includes("INTERNAL_ERROR")));
});
