import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, RunStore, type PersistedRun } from "../../src/index.js";
import type { TrajectoryPublisherInput } from "../../src/trajectory.js";
import { registerTrajectoryExtension } from "../src/index.js";
import { loadingRegistry } from "../../src/registry.js";
import { registerSubagentsExtension } from "../../subagents/src/index.js";
import { testExtensionApi } from "../../test/support.js";

type TestTool = { name: string; execute?: (...args: unknown[]) => Promise<unknown> };
type WorkflowHandler = (args: string, context: unknown) => Promise<void>;
type SessionStartHandler = (event: unknown, context: unknown) => Promise<void>;
type TrajectoryProbe = {
  inputs: TrajectoryPublisherInput[];
  urls: string[];
  waiters: Array<() => void>;
  controller: {
    open(input: TrajectoryPublisherInput): Promise<{ port: number }>;
    close(): Promise<void>;
  };
};

const SESSION_ID = "session";

function trajectoryProbe(): TrajectoryProbe {
  const inputs: TrajectoryPublisherInput[] = [];
  const urls: string[] = [];
  const waiters: Array<() => void> = [];
  return {
    inputs,
    urls,
    waiters,
    controller: {
      async open(input) {
        inputs.push(input);
        for (const resolve of waiters.splice(0)) resolve();
        return { port: 9876 };
      },
      async close() {},
    },
  };
}

function install(home: string, probe: TrajectoryProbe, agentDir?: string): { workflow: TestTool; command: WorkflowHandler; start: SessionStartHandler; shutdown: () => Promise<void> } {
  const tools: TestTool[] = [];
  let command: WorkflowHandler | undefined;
  let start: SessionStartHandler | undefined;
  const shutdowns: Array<() => Promise<void>> = [];
  const api = testExtensionApi({
    registerTool(tool) { tools.push(tool); },
    registerCommand(_name, options) { command = options.handler as WorkflowHandler; },
    on(name, handler) {
      if (name === "session_start") start = handler as SessionStartHandler;
      if (name === "session_shutdown") shutdowns.push(handler as () => Promise<void>);
    },
    getThinkingLevel: () => "medium",
    getActiveTools: () => ["workflow"],
  });
  workflowExtension(api, home, undefined, undefined, agentDir);
  registerTrajectoryExtension(api, { controller: probe.controller, openUrl: (url) => { probe.urls.push(url); }, ...(agentDir === undefined ? {} : { agentDir }) });
  assert.ok(tools.find(({ name }) => name === "workflow"));
  assert.ok(command && start && shutdowns.length);
  return { workflow: tools.find(({ name }) => name === "workflow") as TestTool, command, start, shutdown: async () => { for (const shutdown of shutdowns) await shutdown(); } };
}

function context(cwd: string, hasUI: boolean, select: (prompt: string, options: string[]) => Promise<string | undefined> = async () => undefined): Record<string, unknown> {
  return {
    cwd,
    mode: "rpc",
    hasUI,
    model: { provider: "openai", id: "gpt" },
    modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt" }] },
    sessionManager: { getSessionId: () => SESSION_ID },
    ui: { notify() {}, select },
  };
}

function snapshot(name: string) {
  return createLaunchSnapshot({
    script: "return true;",
    args: null,
    metadata: { name, description: name },
    settings: DEFAULT_SETTINGS,
    models: ["openai/gpt"],
    tools: [],
    agentTypes: [],
    schemas: [],
  });
}

async function persistRun(cwd: string, home: string, state: PersistedRun["state"], runId: string): Promise<void> {
  const store = new RunStore(cwd, SESSION_ID, runId, home);
  await store.create({ id: runId, workflowName: runId, cwd, sessionId: SESSION_ID, state, agents: [], agentSessions: [] }, snapshot(runId));
}

async function waitForOpen(probe: TrajectoryProbe, count: number): Promise<void> {
  if (probe.inputs.length < count) await new Promise<void>((resolve) => { probe.waiters.push(resolve); });
  assert.equal(probe.inputs.length, count);
}

async function launch(workflow: TestTool, ctx: Record<string, unknown>, name: string): Promise<void> {
  assert.ok(workflow.execute);
  await workflow.execute("call", { name, script: "return true;", foreground: true }, new AbortController().signal, undefined, ctx);
}

void test("headless sessions never auto-attach Trajectory", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-headless-"));
  const cwd = join(home, "project");
  await persistRun(cwd, home, "completed", "completed");
  const probe = trajectoryProbe();
  const host = install(home, probe);
  const ctx = context(cwd, false);
  await host.start({}, ctx);
  await launch(host.workflow, ctx, "headless-launch");
  assert.equal(probe.inputs.length, 0);
  assert.equal(probe.urls.length, 0);
  await host.shutdown();
});

void test("empty interactive sessions auto-attach once after the first successful launch", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-first-launch-"));
  const cwd = join(home, "project");
  const probe = trajectoryProbe();
  const host = install(home, probe);
  const ctx = context(cwd, true);
  await host.start({}, ctx);
  assert.equal(probe.inputs.length, 0);
  await launch(host.workflow, ctx, "first-launch");
  await waitForOpen(probe, 1);
  const attached = probe.inputs[0];
  assert.ok(attached);
  assert.equal(attached.cwd, cwd);
  assert.equal(attached.sessionId, SESSION_ID);
  assert.deepEqual(probe.urls, []);
  await launch(host.workflow, ctx, "second-launch");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(probe.inputs.length, 1);
  await host.shutdown();
});

void test("completed sessions auto-attach on session_start without a resume picker", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-completed-"));
  const cwd = join(home, "project");
  await persistRun(cwd, home, "completed", "completed");
  const probe = trajectoryProbe();
  const host = install(home, probe);
  await host.start({}, context(cwd, true));
  await waitForOpen(probe, 1);
  assert.deepEqual(probe.urls, []);
  await host.shutdown();
});

void test("interrupted sessions auto-attach before the resume picker and keep one attachment", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-interrupted-"));
  const cwd = join(home, "project");
  await persistRun(cwd, home, "interrupted", "interrupted");
  const probe = trajectoryProbe();
  const host = install(home, probe);
  let resolvePicker!: (value: string | undefined) => void;
  const picker = new Promise<string | undefined>((resolve) => { resolvePicker = resolve; });
  const ctx = context(cwd, true, async () => picker);
  const starting = host.start({}, ctx);
  await waitForOpen(probe, 1);
  assert.deepEqual(probe.urls, []);
  resolvePicker(undefined);
  await starting;
  await launch(host.workflow, ctx, "after-resume-picker");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(probe.inputs.length, 1);
  await host.shutdown();
});

void test("manual Trajectory re-open uses the same path after auto-attach", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-manual-"));
  const cwd = join(home, "project");
  const probe = trajectoryProbe();
  const host = install(home, probe);
  const ctx = context(cwd, true);
  await host.start({}, ctx);
  await launch(host.workflow, ctx, "manual-reopen");
  await waitForOpen(probe, 1);
  await host.command("trajectory", ctx);
  assert.equal(probe.inputs.length, 2);
  assert.deepEqual(probe.urls, ["http://127.0.0.1:9876/"]);
  await host.shutdown();
});
void test("Trajectory overlays live subagent status observed by the workflow registry", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-subagent-overlay-"));
  const cwd = join(home, "project");
  const agentDir = join(home, "agent");
  const directory = join(agentDir, "subagents", "live");
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "request.json"), JSON.stringify({ prompt: "stale", mode: "background", model: "old/model:medium", tools: ["old"] }));
  writeFileSync(join(directory, "status.json"), JSON.stringify({ id: "live", sessionId: SESSION_ID, state: "completed", startedAt: 1, finishedAt: 4, attempts: 1, progress: { accounting: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 }, toolCalls: [], state: { model: { provider: "old", model: "model" }, tools: ["old"] }, lastEventAt: 2 } }));
  const probe = trajectoryProbe();
  const host = install(home, probe, agentDir);
  let shutdown: (() => Promise<void>) | undefined;
  const manager = { async run() {}, async inspect() {}, async steer() {}, async stop() {}, async retry() {} };
  const ctx = context(cwd, true);
  try {
    await host.start({}, ctx);
    registerSubagentsExtension({ registerTool() {}, on(name, handler) { if (name === "session_shutdown") shutdown = handler as () => Promise<void>; } }, { manager });
    await host.command("trajectory", ctx);
    const input = probe.inputs.at(-1);
    assert.ok(input);
    const persisted = await input.loadSubagents();
    assert.equal(persisted[0]?.state, "completed");
    loadingRegistry().observeSubagentStatus({ id: "live", sessionId: SESSION_ID, state: "running", startedAt: 1, attempts: 2, progress: { accounting: { input: 9, output: 8, cacheRead: 0, cacheWrite: 0, cost: 0 }, toolCalls: [], state: { model: { provider: "fresh", model: "model" }, tools: ["fresh"] }, activity: { kind: "tool", text: "fresh" }, lastEventAt: 10 } }, { prompt: "fresh", mode: "background", model: "fresh/request:medium", tools: ["request"] });
    const overlay = await input.loadSubagents();
    const current = overlay[0];
    assert.ok(current);
    assert.equal(current.state, "running");
    assert.equal(current.request.prompt, "fresh");
    assert.deepEqual(current.tools, ["fresh"]);
    assert.deepEqual(current.model, { provider: "fresh", model: "model" });
    assert.equal(current.progress?.activity?.text, "fresh");
  } finally {
    await host.shutdown();
    await shutdown?.();
  }
});

void test("Trajectory routes subagent actions through the registered manager", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-subagent-actions-"));
  const cwd = join(home, "project");
  const probe = trajectoryProbe();
  const host = install(home, probe);
  const calls: Array<{ action: string; request: unknown; context: unknown }> = [];
  let shutdown: (() => Promise<void>) | undefined;
  const manager = {
    async run() {},
    async inspect() {},
    async steer(request: unknown, context: unknown) { calls.push({ action: "steer", request, context }); return { id: "old", accepted: true }; },
    async stop(request: unknown, context: unknown) { calls.push({ action: "stop", request, context }); return { id: "old", state: "stopped" }; },
    async retry(request: unknown, context: unknown) { calls.push({ action: "retry", request, context }); return { id: "new", state: "running" }; },
  };
  registerSubagentsExtension({ registerTool() {}, on(name, handler) { if (name === "session_shutdown") shutdown = handler as () => Promise<void>; } }, { manager });
  const ctx = context(cwd, true);
  try {
    await host.start({}, ctx);
    await host.command("trajectory", ctx);
    const input = probe.inputs.at(-1);
    assert.ok(input);
    await input.handleAction({ action: "steer", target: { kind: "subagent", id: "old" }, payload: { message: "continue" } });
    await input.handleAction({ action: "stop", target: { kind: "subagent", id: "old" } });
    const retry = await input.handleAction({ action: "retry", target: { kind: "subagent", id: "old" } });
    assert.deepEqual(retry, { id: "new", state: "running" });
    assert.deepEqual(calls.map(({ action, request }) => ({ action, request })), [
      { action: "steer", request: { id: "old", message: "continue" } },
      { action: "stop", request: { id: "old" } },
      { action: "retry", request: { id: "old" } },
    ]);
    const routed = calls[0]?.context as { toolCallId?: unknown; signal?: unknown; onUpdate?: unknown; extensionContext?: unknown } | undefined;
    assert.ok(routed);
    assert.equal(routed.toolCallId, "trajectory");
    assert.equal(routed.signal, undefined);
    assert.equal(routed.onUpdate, undefined);
    assert.equal(routed.extensionContext, ctx);
    await shutdown?.();
    await assert.rejects(input.handleAction({ action: "stop", target: { kind: "subagent", id: "old" } }), /subagents extension/);
  } finally {
    await host.shutdown();
    await shutdown?.();
  }
});
