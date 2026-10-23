import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import workflowExtension, { createLaunchSnapshot, loadingRegistry, registerWorkflowExtension, RunStore, WorkflowError } from "../src/index.js";
import { RunLifecycle, evidenceBridge } from "../src/host-runtime.js";
import { contextualWorkflowAction, decodeTestRunStart, decodeTestToolResult, testExtensionApi } from "./support.js";
import { listRunIds } from "../src/persistence.js";
import { testTransport, type TestPiSession } from "./test-transport.js";

type Command = Parameters<typeof contextualWorkflowAction>[0];
type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail(`timed out waiting for ${what}`);
}
const evidenceFiles = (store: RunStore): string[] => existsSync(store.evidenceDirectory()) ? readdirSync(store.evidenceDirectory()) : [];

// Real production host. A registered function holds the run at a controlled gate so pause/stop land while it waits.
async function harness(t: TestContext, mode: "launch" | "cold", script: string) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "workflow-evidence-lifecycle-")));
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  const sessionId = "session";
  const tools: Tool[] = [];
  let command: Command | undefined;
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({
    registerTool(tool: Tool) { tools.push(tool); },
    registerCommand(name: string, value: { handler: Command }) { if (name === "workflow") command = value.handler; },
    on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; },
    getActiveTools: () => ["workflow"], getThinkingLevel: () => "off",
  }), home);
  let started: () => void = () => {};
  const gateStarted = new Promise<void>((resolve) => { started = resolve; });
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  registerWorkflowExtension({ version: "1.0.0", headline: "Evidence lifecycle", functions: {
    waitGate: { description: "Wait for the test gate", input: { type: "object", additionalProperties: false }, output: { type: "boolean" }, async run() { started(); await gate; return true; } },
    badEvidence: { description: "Write invalid evidence", input: { type: "object", additionalProperties: false }, output: { type: "string" }, async run(_input, context) { return (await context.evidence?.(Number.NaN))?.ref ?? ""; } },
  } });
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => sessionId }, ui: { notify() {} } };
  t.after(async () => { release(); await shutdown?.(); rmSync(home, { recursive: true, force: true }); loadingRegistry().freeze(); });
  assert.ok(command && start && shutdown);
  const handler = command;
  let store: RunStore;
  let outcome: Promise<unknown> = Promise.resolve();
  if (mode === "launch") {
    const workflow = tools.find(({ name }) => name === "workflow");
    assert.ok(workflow);
    const launched = workflow.execute("call", { name: "evidence-lifecycle", script, foreground: true }, new AbortController().signal, undefined, context);
    outcome = launched.catch((error: unknown) => error);
    await until(async () => { try { return (await new RunStore(cwd, sessionId, (await onlyRun(cwd, home)), home).load()).run.state === "running"; } catch { return false; } }, "the launched run");
    store = new RunStore(cwd, sessionId, await onlyRun(cwd, home), home);
  } else {
    store = new RunStore(cwd, sessionId, "run-cold", home);
    await store.create({ id: "run-cold", workflowName: "cold-evidence", cwd, sessionId, state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script, args: null, metadata: { name: "cold-evidence" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [] }));
    await start({}, context);
    outcome = contextualWorkflowAction(handler, context, "run-cold", "Resume", "Background");
  }
  await gateStarted;
  const runId = store.runId;
  return {
    store, gate: release, outcome: () => outcome,
    action: (name: string) => contextualWorkflowAction(handler, context, runId, name),
    state: async () => (await store.load()).run.state,
    settled: () => until(async () => ["completed", "failed", "stopped"].includes((await store.load()).run.state), "a terminal state"),
  };
}
async function onlyRun(cwd: string, home: string): Promise<string> {
  const { listRunIds } = await import("../src/persistence.js");
  const ids = await listRunIds(cwd, "session", home);
  assert.equal(ids.length, 1);
  return ids[0] as string;
}

for (const mode of ["launch", "cold"] as const) {
  void test(`evidence honours pause and resume on a ${mode} run`, async (t) => {
    const h = await harness(t, mode, 'await waitGate({}); return await evidence("written after pause");');
    await h.action("Pause");
    await until(async () => (await h.state()) === "paused", "the paused state");
    h.gate();
    // The gate function's journaled result proves the script moved on to evidence(); a completing run must not slip past the pause.
    await until(async () => (await h.store.replay("function/waitGate/1")) !== undefined, "the gate result");
    await Promise.race([h.settled(), new Promise((resolve) => setTimeout(resolve, 300))]);
    assert.deepEqual(evidenceFiles(h.store), [], "no evidence is written while paused");
    assert.equal(await h.state(), "paused");
    await h.action("Resume");
    await h.settled();
    assert.equal(await h.state(), "completed");
    const files = evidenceFiles(h.store);
    assert.equal(files.length, 1);
    assert.equal(readFileSync(join(h.store.evidenceDirectory(), files[0] as string), "utf8"), "written after pause");
    await h.outcome();
  });

  void test(`evidence is not written after a ${mode} run is stopped`, async (t) => {
    const h = await harness(t, mode, 'await waitGate({}); return await evidence("written after stop");');
    await h.action("Stop");
    h.gate();
    await h.outcome();
    await h.settled();
    assert.equal(await h.state(), "stopped");
    assert.deepEqual(evidenceFiles(h.store), []);
  });
}

void test("registered-function evidence rejects non-JSON content before persistence", async (t) => {
  const h = await harness(t, "launch", 'await waitGate({}); return await badEvidence({});');
  h.gate();
  await h.settled();
  assert.equal(await h.state(), "failed");
  assert.deepEqual(evidenceFiles(h.store), []);
});

void test("the evidence bridge refuses aborted signals and non-running lifecycles before any write", async () => {
  const home = mkdtempSync(join(tmpdir(), "workflow-evidence-bridge-"));
  try {
    const store = new RunStore(join(home, "project"), "session", "run", home);
    await store.create({ id: "run", workflowName: "bridge", cwd: join(home, "project"), sessionId: "session", state: "running", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return 1", args: null, metadata: { name: "bridge" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [] }));
    const cancelled = (error: unknown): boolean => error instanceof WorkflowError && error.code === "CANCELLED";
    const controller = new AbortController();
    const lifecycle = new RunLifecycle("running");
    const bridge = evidenceBridge(store, lifecycle);
    controller.abort();
    await assert.rejects(bridge("aborted", controller.signal), cancelled);
    const stopped = new RunLifecycle("stopped");
    await assert.rejects(evidenceBridge(store, stopped)("stopped", new AbortController().signal), cancelled);
    assert.deepEqual(evidenceFiles(store), []);
    assert.equal((await evidenceBridge(store, lifecycle)("ok", new AbortController().signal)).bytes, 2);
    await lifecycle.pause();
    assert.equal(lifecycle.state, "paused", "the bridge leaves the lifecycle idle");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

void test("a retry without live tools replays direct evidence and the tools.read of its original artifact", async (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "workflow-evidence-retry-")));
  t.after(() => { rmSync(home, { recursive: true, force: true }); });
  let sessions = 0;
  const createSession = async (): Promise<TestPiSession> => {
    const attempt = ++sessions;
    return { sessionId: `evidence-retry-${String(attempt)}`, sessionFile: `/sessions/evidence-retry-${String(attempt)}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }), prompt: async () => { if (attempt === 1) throw new Error("source failure after the read"); }, steer: async () => {}, dispose() {} };
  };
  const tools: Tool[] = [];
  workflowExtension(testExtensionApi({ registerTool(tool: Tool) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(workflow && retry);
  let reads = 0;
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const toolContext = { ...context, tools: [{ name: "read" }], executeTool: async (_name: string, args: { path: string }) => { reads += 1; return { result: { content: [{ type: "text", text: readFileSync(args.path, "utf8") }] }, isError: false }; } };
  const script = 'const record = await evidence("full original log"); const text = await tools.read({ path: record.path }); await agent("gate"); return { record, text };';
  await assert.rejects(workflow.execute("source", { name: "evidence-retry", script, foreground: true }, new AbortController().signal, undefined, toolContext), WorkflowError);
  const [sourceId] = await listRunIds(home, "session", home);
  assert.ok(sourceId);
  const source = new RunStore(home, "session", sourceId, home);
  assert.equal((await source.load()).run.state, "failed");
  assert.equal(reads, 1);
  const [original] = await source.listEvidence();
  assert.ok(original);
  // No executeTool: the retry can only replay journaled tool calls, as from the navigator or session startup.
  const started = decodeTestRunStart(decodeTestToolResult(await retry.execute("retry", { runId: sourceId, foreground: true }, undefined, undefined, context)).content[0]?.text ?? "null");
  const child = new RunStore(home, "session", started.runId, home);
  const loaded = (await child.load()).run;
  assert.equal(loaded.state, "completed", JSON.stringify(loaded.error));
  assert.deepEqual(JSON.parse(readFileSync(join(child.directory, "result.json"), "utf8")), { record: original, text: "full original log" });
  assert.equal(reads, 1, "the read is replayed, not rerun");
  assert.deepEqual(evidenceFiles(child), [], "the original artifact is reused");
});
