import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createInitialSystemMessage, getCurrentTools } from "@earendil-works/pi-ai";
import { SessionManager, defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { assertPreparedTools, createLocalPiSession, WorkflowAgentExecutor, type AgentExecutionRoot, type PiSession, type ToolLoadoutPolicy } from "../src/agent-execution.js";
import { createPiRuntimeAgentRunner } from "../src/pi-runtime-runner.js";
import { createLiveSessionHandoff } from "../src/session-handoff.js";
import { WorkflowError, type AgentTransportContext, type PreparedAgentSession } from "../src/types.js";
import { testTransport } from "./test-transport.js";

const NATIVE_TOOLS = ["exec_command", "write_stdin"] as const;
const RESULT_TOOL = "workflow_result";
const AUTHORIZED_TOOLS = [...NATIVE_TOOLS, RESULT_TOOL];
type ProviderRequest = { readonly messages: readonly { role: string }[] };
type SentinelAgent = { streamFunction: (model: unknown, context: ProviderRequest) => never };
const sentinelContext = { label: "loadout-child", model: { provider: "fixture", model: "fixture-model" }, extensions: ["/fixtures/strip-tools.mjs"] } as const;
const resultTool = defineTool({ name: RESULT_TOOL, label: "Workflow Result", description: "Submit the terminal workflow result", parameters: Type.Object({ result: Type.String() }), async execute(_id, value) { return { content: [{ type: "text" as const, text: `Result accepted: ${JSON.stringify(value)}` }], details: {} }; } });

/** A native Pi session backed by an unreachable provider: every test stops at the counting sentinel. */
function loadoutFixture(options: { strip?: readonly string[]; during?: "session_start" | "before_agent_start" } = {}) {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-loadout-"));
  const agentDir = join(rootDir, "agent");
  const cwd = join(rootDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", apiKey: "fixture", models: [{ id: "fixture-model", name: "Fixture model", reasoning: false, input: ["text"], contextWindow: 1024, maxTokens: 128 }] } } }));
  writeFileSync(join(agentDir, "auth.json"), "{}");
  const executed: string[] = [];
  const inert = (name: string) => defineTool({ name, label: name, description: `Inert ${name} fixture`, parameters: Type.Object({}), async execute() { executed.push(name); return { content: [{ type: "text" as const, text: "Inert fixture tool ran" }], details: {} }; } });
  const extension = (pi: ExtensionAPI): void => {
    for (const name of NATIVE_TOOLS) pi.registerTool(inert(name));
    const strip = options.strip;
    if (strip === undefined) return;
    const applySelection = (): void => { pi.setActiveTools(AUTHORIZED_TOOLS.filter((name) => !strip.includes(name))); };
    if (options.during === "before_agent_start") pi.on("before_agent_start", applySelection);
    else pi.on("session_start", applySelection);
  };
  return { rootDir, agentDir, cwd, extension, executed, close(): void { rmSync(rootDir, { recursive: true, force: true }); } };
}

async function openFixtureSession(fixture: ReturnType<typeof loadoutFixture>, tools: readonly string[] = AUTHORIZED_TOOLS): Promise<PiSession> {
  return createLocalPiSession({ cwd: fixture.cwd, agentDir: fixture.agentDir, model: { provider: "fixture", model: "fixture-model" }, tools: [...tools], resultTool, sessionLabel: "loadout-child", extensionFactories: [fixture.extension], sessionManager: SessionManager.inMemory(fixture.cwd) });
}

/** Replaces the provider stream with a counter: the session must never reach a model. */
function installSentinel(session: PiSession): { calls: number; declarations: string[][] } {
  const observed = { calls: 0, declarations: [] as string[][] };
  assert.ok(session.agent);
  (session.agent as unknown as SentinelAgent).streamFunction = (_model, context) => {
    observed.calls += 1;
    observed.declarations.push(getCurrentTools(context.messages).map(({ name }) => name));
    throw new Error("counting sentinel: the session must not reach a provider");
  };
  return observed;
}

function isLoadoutMismatch(error: unknown): boolean { return error instanceof WorkflowError && error.code === "TOOL_LOADOUT_MISMATCH"; }

void test("a provider request that drops an authorized tool rejects the prompt before any model call", async () => {
  const fixture = loadoutFixture({ strip: NATIVE_TOOLS });
  let observed: ReturnType<typeof installSentinel> | undefined;
  try {
    const session = await openFixtureSession(fixture);
    observed = installSentinel(session);
    await assert.rejects(session.prompt("work"), (error: unknown) => isLoadoutMismatch(error) && /actual workflow_result, missing exec_command, write_stdin/.test(error instanceof Error ? error.message : ""));
    assert.equal(observed.calls, 0);
    assert.deepEqual(observed.declarations, []);
    assert.deepEqual(fixture.executed, []);
    await session.dispose();
  } finally {
    fixture.close();
  }
});

void test("one missing authorized tool fails the prompt instead of only an empty declaration set", async () => {
  const fixture = loadoutFixture({ strip: ["write_stdin"] });
  try {
    const session = await openFixtureSession(fixture);
    installSentinel(session);
    await assert.rejects(session.prompt("work"), (error: unknown) => isLoadoutMismatch(error) && /missing write_stdin,/.test(error instanceof Error ? error.message : "") && !/missing exec_command/.test(error instanceof Error ? error.message : ""));
    await session.dispose();
  } finally {
    fixture.close();
  }
});

void test("a before_agent_start selection fails the prompt like a startup selection does", async () => {
  const fixture = loadoutFixture({ strip: NATIVE_TOOLS, during: "before_agent_start" });
  try {
    const session = await openFixtureSession(fixture);
    const observed = installSentinel(session);
    await assert.rejects(session.prompt("work"), isLoadoutMismatch);
    assert.equal(observed.calls, 0);
    await session.dispose();
  } finally {
    fixture.close();
  }
});

void test("an intact loadout hands both native declarations to the provider request", async () => {
  const fixture = loadoutFixture();
  try {
    const session = await openFixtureSession(fixture);
    const observed = installSentinel(session);
    await session.prompt("work");
    assert.equal(observed.calls, 1);
    assert.deepEqual([...(observed.declarations[0] ?? [])].sort(), [...AUTHORIZED_TOOLS].sort());
    await session.dispose();
  } finally {
    fixture.close();
  }
});

void test("a poisoned child leaves a sibling session's loadout untouched", async () => {
  const poisonedFixture = loadoutFixture({ strip: NATIVE_TOOLS });
  const healthyFixture = loadoutFixture();
  try {
    const poisoned = await openFixtureSession(poisonedFixture);
    await assert.rejects(poisoned.prompt("work"), isLoadoutMismatch);
    await assert.rejects(poisoned.prompt("again"), isLoadoutMismatch);
    await poisoned.dispose();
    const healthy = await openFixtureSession(healthyFixture);
    const observed = installSentinel(healthy);
    await healthy.prompt("work");
    assert.equal(observed.calls, 1);
    await healthy.dispose();
  } finally {
    poisonedFixture.close();
    healthyFixture.close();
  }
});

void test("the loadout check rejects forged declarations and never lets helpers stand in for requirements", () => {
  const declaration = (names: readonly string[]) => {
    const message = createInitialSystemMessage("prompt", names.map((name) => ({ name, description: `${name} fixture`, parameters: Type.Object({}) })));
    assert.ok(message);
    return [message];
  };
  assert.doesNotThrow(() => { assertPreparedTools({ required: [], allowed: [RESULT_TOOL] }, declaration([RESULT_TOOL]), sentinelContext); });
  const helperOnly = { required: ["exec_command"], allowed: [...NATIVE_TOOLS, RESULT_TOOL] } satisfies ToolLoadoutPolicy;
  assert.throws(() => { assertPreparedTools(helperOnly, declaration([RESULT_TOOL]), sentinelContext); }, isLoadoutMismatch);
  const forged = { required: [], allowed: [RESULT_TOOL] } satisfies ToolLoadoutPolicy;
  assert.throws(() => { assertPreparedTools(forged, declaration([RESULT_TOOL, "bash"]), sentinelContext); }, (error: unknown) => isLoadoutMismatch(error) && /unexpected bash/.test(error instanceof Error ? error.message : ""));
  const reordered = { required: ["write_stdin", "exec_command", "exec_command"], allowed: AUTHORIZED_TOOLS } satisfies ToolLoadoutPolicy;
  assert.doesNotThrow(() => { assertPreparedTools(reordered, declaration(["exec_command", "workflow_result", "write_stdin"]), sentinelContext); });
});

void test("the runtime runner ends a mismatched attempt without provider recovery or a leaked session", async () => {
  const fixture = loadoutFixture({ strip: NATIVE_TOOLS });
  let recoveries = 0;
  let disposals = 0;
  let observed: ReturnType<typeof installSentinel> | undefined;
  const transport = testTransport(async () => {
    const session = await openFixtureSession(fixture);
    observed = installSentinel(session);
    const dispose = session.dispose.bind(session);
    session.dispose = async () => { disposals += 1; await dispose(); };
    return { sessionId: "loadout-runner", messages: [], getSessionStats: () => session.getSessionStats(), async prompt(text: string) { await session.prompt(text); }, async dispose() { await session.dispose(); } };
  });
  const prepared: PreparedAgentSession = { cwd: fixture.cwd, model: { provider: "fixture", model: "fixture-model" }, tools: [...NATIVE_TOOLS], resultTool, sessionLabel: "loadout-runner" };
  const controller = new AbortController();
  const run = { cwd: fixture.cwd, sessionId: "host", runId: "run", workflow: { name: "flow" }, args: null, signal: controller.signal } as const;
  const context: AgentTransportContext = { run, identity: { structuralPath: ["worker"], callSite: "worker", occurrence: 1 }, attempt: 1, signal: controller.signal, settings: {} };
  const runner = createPiRuntimeAgentRunner({ transport, prepared, context, handoff: createLiveSessionHandoff() });
  try {
    await assert.rejects(runner.run({ task: "work", cwd: fixture.cwd, model: { provider: "fixture", model: "fixture-model" }, enabledTools: [...NATIVE_TOOLS], customTools: [], run: { id: "run", namespaceId: "host", workflowName: "flow" }, agent: { id: "worker", structuralPath: ["worker"] }, signal: controller.signal, onProviderError: async () => { recoveries += 1; return "retry"; } }), isLoadoutMismatch);
    assert.equal(observed?.calls, 0);
    assert.equal(recoveries, 0);
    assert.equal(disposals, 1);
  } finally {
    fixture.close();
  }
});

void test("a prepared-declaration mismatch is terminal for the attempt loop", async () => {
  let sessions = 0;
  const stats = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 };
  const root: AgentExecutionRoot = { cwd: "/repo", model: { provider: "test", model: "model" }, availableModels: new Set(["test/model"]), tools: new Set(AUTHORIZED_TOOLS) };
  const executor = new WorkflowAgentExecutor(root, testTransport(async () => {
    sessions += 1;
    return { sessionId: `loadout-${String(sessions)}`, messages: [], getSessionStats: () => stats, async prompt() { throw new WorkflowError("TOOL_LOADOUT_MISMATCH", "missing exec_command"); }, dispose() {} };
  }));
  await assert.rejects(executor.execute("work", { label: "worker", workflowName: "flow", retries: 1 }), isLoadoutMismatch);
  assert.equal(sessions, 1);
});
