/* global setTimeout, setImmediate */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { WORKFLOW_AGENT_STALL_THRESHOLD_MS, WorkflowError, registerWorkflowExtension, resetWorkflowRegistry } from "pi-extensible-workflows";
import extension, {
  createSubagentManager,
  createSubagentTools,
  normalizeSubagentRunRequest,
  registerSubagentsExtension,
  SUBAGENTS_ID_PARAMETERS,
  SUBAGENTS_INSPECT_PARAMETERS,
  SUBAGENTS_RETRY_PARAMETERS,
  SUBAGENTS_RUN_PARAMETERS,
  SUBAGENTS_STEER_PARAMETERS,
  SUBAGENTS_STOP_PARAMETERS,
} from "../../dist/subagents/index.js";
import { getSubagentManager } from "../../dist/src/subagent-manager-handle.js";

const toolNames = [
  "subagents_run",
  "subagents_inspect",
  "subagents_steer",
  "subagents_stop",
  "subagents_retry",
];

function testContext() {
  return {};
}

test("registers five namespaced subagent tools and delegates to an injected manager", async () => {
  const calls = [];
  const manager = {
    async run(params) { calls.push(["run", params]); return { id: "agent-1", state: "queued" }; },
    async inspect(params) { calls.push(["inspect", params]); return { id: params.id, state: "running" }; },
    async steer(params) { calls.push(["steer", params]); return { id: params.id, accepted: true }; },
    async stop(params) { calls.push(["stop", params]); return { id: params.id, state: "stopped" }; },
    async retry(params) { calls.push(["retry", params]); return { id: params.id, state: "queued" }; },
  };
  const tools = [];
  extension({ registerTool(tool) { tools.push(tool); } }, { manager });
  assert.equal(Object.isFrozen(SUBAGENTS_RUN_PARAMETERS), false);
  assert.deepEqual(tools.map(({ name }) => name), toolNames);
  const result = await tools[0].execute("call-1", { prompt: "inspect" }, undefined, undefined, testContext());
  assert.deepEqual(result, { content: [{ type: "text", text: '{"id":"agent-1","state":"queued"}' }], details: { id: "agent-1", state: "queued" } });
  assert.deepEqual(calls[0], ["run", { prompt: "inspect", mode: "background" }]);
});
test("publishes the manager handle for a session and clears it on shutdown", async () => {
  const manager = { async run() {}, async inspect() {}, async steer() {}, async stop() {}, async retry() {} };
  let shutdown;
  registerSubagentsExtension({ registerTool() {}, on(name, handler) { if (name === "session_shutdown") shutdown = handler; } }, { manager });
  assert.equal(getSubagentManager(), manager);
  await shutdown?.();
  assert.equal(getSubagentManager(), undefined);
});

test("keeps top-level model as a call option with a role", () => {
  assert.deepEqual(normalizeSubagentRunRequest({ prompt: "x", role: "reviewer", model: "fable-5:high" }), {
    prompt: "x",
    mode: "background",
    role: "reviewer",
    model: "fable-5:high",
  });
  assert.throws(() => normalizeSubagentRunRequest({ prompt: "x", role: "reviewer", thinking: "high" }));
  assert.throws(() => normalizeSubagentRunRequest({ prompt: "x", role: { name: "reviewer" }, model: "new" }));
});
test("renders subagent calls and background or foreground progress consistently", () => {
  const manager = { async run() {}, async inspect() {}, async steer() {}, async stop() {}, async retry() {} };
  const tools = createSubagentTools(manager);
  const run = tools.find(({ name }) => name === "subagents_run");
  assert.ok(run?.renderCall && run.renderResult);
  assert.ok(tools.every(({ renderCall, renderResult }) => renderCall && renderResult));
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const args = { prompt: "Check docs drift", label: "scout", mode: "foreground", role: "reviewer" };
  const call = run.renderCall(args, theme, {}).render(80).join("\n");
  assert.equal(call, "subagent scout mode=foreground role=reviewer");
  assert.doesNotMatch(call, /Check docs drift/);
  assert.equal(run.renderCall({ prompt: "partial", label: "scout", role: null }, theme, {}).render(80).join("\n"), "subagent scout mode=background role=none");
  const narrowCall = run.renderCall({ prompt: "a long prompt", label: "a very long label", mode: "foreground", role: "reviewer" }, theme, {}).render(12);
  assert.equal(narrowCall.length, 1);
  assert.match(narrowCall[0], /…/);

  const backgroundState = {};
  const background = run.renderResult(
    { content: [{ type: "text", text: '{"id":"background","state":"running"}' }], details: { id: "background", state: "running" } },
    { expanded: false, isPartial: false },
    theme,
    { args: { ...args, mode: "background" }, state: backgroundState, invalidate() {} },
  ).render(80).join("\n");
  assert.match(background, /^✓ Subagent: scout.*\[launched\].*mode=background role=reviewer/);
  assert.equal(backgroundState.subagentSpinner, undefined);

  const foregroundState = {};
  const context = { args, state: foregroundState, invalidate() {} };
  const partial = run.renderResult(
    { content: [], details: { id: "foreground", state: "running", startedAt: Date.now() - 1000, progress: { accounting: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.001 }, toolCalls: [], activity: { kind: "reasoning", text: "thinking" }, lastEventAt: Date.now() } } },
    { expanded: false, isPartial: true },
    theme,
    context,
  ).render(80).join("\n");
  assert.match(partial, /Subagent: scout.*\[running\].*mode=foreground role=reviewer.*runtime=1s/);
  assert.match(partial, /reasoning · thinking/);
  assert.equal(run.renderCall(args, theme, { state: foregroundState }).render(80).length, 0);
  assert.doesNotMatch(partial, /stalled\?/);
  const staleForeground = run.renderResult(
    { content: [], details: { id: "foreground", state: "running", startedAt: Date.now() - 1000, progress: { accounting: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.001 }, toolCalls: [], activity: { kind: "reasoning", text: "thinking" }, lastEventAt: Date.now() - WORKFLOW_AGENT_STALL_THRESHOLD_MS - 1 } } },
    { expanded: false, isPartial: true },
    theme,
    context,
  ).render(80).join("\n");
  assert.match(staleForeground, /reasoning · thinking - stalled\? 10m/);
  assert.ok(foregroundState.subagentSpinner);

  const completed = run.renderResult(
    { content: [{ type: "text", text: '{"id":"foreground","state":"completed","value":"done"}' }], details: { id: "foreground", state: "completed", value: "done" } },
    { expanded: true, isPartial: false },
    theme,
    context,
  ).render(80).join("\n");
  assert.match(completed, /Subagent: scout.*\[completed\]/);
  assert.match(completed, /id=foreground/);
  assert.match(completed, /tokens=14 cost=\$0\.001/);
  assert.equal(foregroundState.subagentSpinner, undefined);

  const retry = tools.find(({ name }) => name === "subagents_retry");
  assert.ok(retry?.renderResult);
  const retryState = {};
  const retryContext = { args: { id: "source-subagent-id" }, state: retryState, invalidate() {} };
  const retryPartial = retry.renderResult(
    { content: [], details: { id: "retried", state: "running", progress: { accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, toolCalls: [], activity: { kind: "tool", text: "read" } } } },
    { expanded: false, isPartial: true },
    theme,
    retryContext,
  ).render(80).join("\n");
  assert.match(retryPartial, /Subagent: retried.*\[running\]/);
  assert.doesNotMatch(retryPartial, /role=/);
  assert.match(retryPartial, /read/);
  assert.ok(retryState.subagentSpinner);
  retry.renderResult(
    { content: [{ type: "text", text: '{"id":"retried","state":"completed","value":"done"}' }], details: { id: "retried", state: "completed", value: "done" } },
    { expanded: false, isPartial: false },
    theme,
    retryContext,
  );
  assert.equal(retryState.subagentSpinner, undefined);

  const inspect = tools.find(({ name }) => name === "subagents_inspect");
  assert.ok(inspect?.renderResult);
  const inspectComponent = inspect.renderResult(
    { content: [], details: { id: "inspected", state: "running" } },
    { expanded: false, isPartial: false },
    theme,
    { args: { id: "inspected" }, state: {}, invalidate() {} },
  );
  const inspected = inspectComponent.render(80).join("\n");
  assert.match(inspected, /^◇ Subagent: inspecte.*\[running\]/);
  assert.equal(inspectComponent.render(80).join("\n"), inspected);
  assert.doesNotMatch(inspected, /role=/);
  const inspection = inspect.renderResult(
    {
      content: [],
      details: {
        id: "inspected",
        state: "completed",
        startedAt: 0,
        finishedAt: 1000,
        lastEventAt: 900,
        progress: { state: { model: { provider: "fixture", model: "reviewer", thinking: "high" } }, activity: { kind: "tool", text: "read" }, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 }, toolCalls: [{ id: "tool-1", name: "read", state: "completed" }], lastEventAt: 900 },
        worktree: { path: "/tmp/worktree", branch: "subagent/inspect" },
        value: { answer: 42 },
      },
    },
    { expanded: true, isPartial: false },
    theme,
    { args: { id: "inspected" }, state: {}, invalidate() {} },
  ).render(120).join("\n");
  assert.match(inspection, /startedAt=1970-01-01T00:00:00\.000Z/);
  assert.match(inspection, /model=fixture\/reviewer:high/);
  assert.match(inspection, /activity=tool read/);
  assert.match(inspection, /accounting=input=1 output=2 cacheRead=3 cacheWrite=4 cost=\$0\.50/);
  assert.match(inspection, /toolCalls=1.*read \[completed\]/s);
  assert.match(inspection, /value:.*"answer": 42/s);
});

test("pins live background subagents below the editor until they settle", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-widget-"));
  await mkdir(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  await writeFile(join(cwd, ".pi", "pi-extensible-workflows", "settings.json"), JSON.stringify({ concurrency: 16 }));
  const pending = deferred();
  const started = deferred();
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  const executionOptions = [];
  const tools = [];
  const handlers = new Map();
  const widgetCalls = [];
  let widgetComponent;
  let renders = 0;
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const pi = {
    registerTool(tool) { tools.push(tool); },
    on(name, handler) { handlers.set(name, handler); },
  };
  registerSubagentsExtension(pi, {
    managerDependencies: {
      storageDir: join(cwd, "subagents-storage"),
      worktreeAdapter: {
        async create(input) {
          return {
            path: join(cwd, "worktree"),
            branch: `subagent/${input.runId}`,
            cwd,
            runStore: {},
            async cleanup() { cleanupStarted.resolve(); await releaseCleanup.promise; },
          };
        },
      },
      createExecutor() {
        return {
          async execute(_prompt, options) {
            executionOptions.push(options);
            started.resolve();
            return pending.promise;
          },
        };
      },
    },
  });
  const context = {
    ...(await executionContext(cwd)),
    mode: "tui",
    hasUI: true,
    ui: {
      setWidget(key, value, options) {
        widgetCalls.push({ key, value, options });
        widgetComponent = typeof value === "function" ? value({ requestRender() { renders += 1; } }, theme) : undefined;
      },
    },
  };

  try {
    handlers.get("session_start")({}, context);
    const run = tools.find(({ name }) => name === "subagents_run");
    const launch = await run.execute("widget-call", { prompt: "watch", label: "scout", mode: "background", worktree: "widget" }, undefined, undefined, context);
    await started.promise;
    assert.equal(launch.details.state, "running");
    assert.deepEqual(widgetCalls[0].options, { placement: "belowEditor" });
    assert.match(widgetComponent.render(80).join("\n"), /Subagents \(1 running\).*Subagent: scout.*\[running\].*mode=background role=none/s);
    for (let index = 1; index < 16; index += 1) {
      const additional = await run.execute(`widget-call-${String(index)}`, { prompt: `watch ${String(index)}`, label: `scout-${String(index)}`, mode: "background" }, undefined, undefined, context);
      assert.equal(additional.details.state, "running");
    }
    for (const [index, options] of executionOptions.entries()) {
      await options.onProgress({ accounting: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 }, toolCalls: [], activity: { kind: "tool", text: `read-${String(index)}` }, lastEventAt: Date.now(), persist: false });
    }
    const freshFrame = widgetComponent.render(80).join("\n");
    assert.doesNotMatch(freshFrame, /stalled\?/);
    await executionOptions[0].onProgress({ accounting: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 }, toolCalls: [], activity: { kind: "tool", text: "read-0" }, lastEventAt: Date.now() - WORKFLOW_AGENT_STALL_THRESHOLD_MS - 1, persist: false });
    const staleFrame = widgetComponent.render(80).join("\n");
    assert.match(staleFrame, /read-0 - stalled\? 10m/);
    const frame = widgetComponent.render(80);
    assert.equal(frame.length, 10);
    assert.match(frame[0], /Subagents \(16 running\)/);
    assert.match(frame[1], /Subagent: scout /);
    assert.match(frame[7], /Subagent: scout-3 /);
    assert.match(frame[8], /read-3/);
    assert.equal(frame[9], "… 12 more");
    const narrowFrame = widgetComponent.render(24);
    assert.equal(narrowFrame.length, 10);
    assert.match(narrowFrame[1], /…/);

    assert.ok(renders > 0);

    pending.resolve({ value: "done", attempts: [], cwd });
    await cleanupStarted.promise;
    releaseCleanup.resolve();
    await waitFor(() => widgetCalls.at(-1)?.value === undefined);
    assert.equal(widgetCalls.at(-1)?.value, undefined);
  } finally {
    releaseCleanup.resolve();
    await handlers.get("session_shutdown")({}, context);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("opens the /subagents picker and inspects durable status without an agent call", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-command-"));
  const storageDir = join(cwd, "subagents-storage");
  const firstId = "run-1";
  const secondId = "run-2";
  const newestId = "run-3";
  const otherSessionId = "run-other";
  const malformed = { id: "run-malformed", sessionId: "session-1", state: "completed", startedAt: 1, attempts: 1, attemptDetails: [{}], systemPrompt: 42 };
  await mkdir(join(storageDir, firstId), { recursive: true });
  await mkdir(join(storageDir, secondId), { recursive: true });
  await mkdir(join(storageDir, newestId), { recursive: true });
  await writeFile(join(storageDir, firstId, "request.json"), JSON.stringify({ prompt: "review", label: "reviewer", role: "critic", mode: "background" }));
  await writeFile(join(storageDir, secondId, "request.json"), JSON.stringify({ prompt: "summarize", mode: "background" }));
  await writeFile(join(storageDir, newestId, "request.json"), JSON.stringify({ prompt: "newest", label: "newest", mode: "background" }));
  const inspectCalls = [];
  const manager = {
    async run() { throw new Error("/subagents must not launch a run"); },
    async inspect(params, context) {
      inspectCalls.push({ params, context });
      if (params.id === secondId) return { id: secondId, sessionId: "session-1", state: "completed", startedAt: 10, finishedAt: 20, value: "done" };
      if (params.id === firstId) return { id: firstId, sessionId: "session-1", state: "running", startedAt: 10, activity: { kind: "tool", text: "read" } };
      return [
        malformed,
        { id: secondId, sessionId: "session-1", state: "completed", startedAt: 20, finishedAt: 30 },
        { id: otherSessionId, sessionId: "session-2", state: "running", startedAt: 50 },
        { id: firstId, sessionId: "session-1", state: "running", startedAt: 10 },
        { id: newestId, sessionId: "session-1", state: "completed", startedAt: 30, finishedAt: 40 },
      ];
    },
    async steer() {},
    async stop() {},
    async retry() {},
  };
  const commands = [];
  const pickerOptions = [];
  const detailScreens = [];
  let pickerCount = 0;
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  const pi = {
    registerTool() {},
    registerCommand(name, options) { commands.push({ name, options }); },
  };
  registerSubagentsExtension(pi, { manager, managerDependencies: { storageDir } });
  const command = commands.find(({ name }) => name === "subagents");
  assert.ok(command);
  const context = {
    ...(await executionContext(cwd)),
    mode: "tui",
    hasUI: true,
    ui: {
      select(title, options) {
        assert.match(title, /Subagents/);
        pickerOptions.push([...options]);
        pickerCount += 1;
        return Promise.resolve(pickerCount === 1 ? options[2] : "Close");
      },
      async custom(factory) {
        const component = factory({ terminal: { rows: 20 }, requestRender() {} }, theme, { matches(data, binding) { return data === "escape" && binding === "tui.select.cancel"; } }, () => undefined);
        detailScreens.push(component.render(120).join("\n"));
      },
      notify() {},
    },
  };
  try {
    await command.options.handler("", context);
    assert.ok(inspectCalls.length >= 2);
    assert.equal(inspectCalls[0].params.id, undefined);
    assert.equal(inspectCalls[1].params.id, secondId);
    assert.equal(inspectCalls.every(({ context: callContext }) => callContext.extensionContext === context), true);
    assert.equal(inspectCalls[0].context.includeAttemptMetadata, undefined);
    assert.equal(inspectCalls[1].context.includeAttemptMetadata, true);
    assert.match(pickerOptions[0][0], /label=reviewer.*\[running\].*run-1/);
    assert.match(pickerOptions[0][1], /label=newest.*\[completed\].*run-3/);
    assert.match(pickerOptions[0][2], /label=none.*\[completed\].*run-2/);
    assert.doesNotMatch(pickerOptions[0].join("\n"), /run-other/);
    assert.doesNotMatch(pickerOptions[0].join("\n"), /run-malformed/);
    assert.match(pickerOptions[0].join("\n"), /label=reviewer.*role=critic/);
    assert.match(pickerOptions[0].join("\n"), /label=none.*role=none/);
    assert.match(detailScreens[0], /label=none/);
    assert.match(detailScreens[0], /role=none/);
    assert.match(detailScreens[0], /done/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("emits terminal status before cleanup and a cleaned status after worktree cleanup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-terminal-status-order-"));
  const storageDir = join(cwd, "storage");
  const pending = deferred();
  const started = deferred();
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  const statuses = [];
  const manager = createSubagentManager({
    storageDir,
    onStatus(status) { statuses.push(status); },
    worktreeAdapter: {
      async create(input) {
        return {
          path: join(cwd, "worktree"),
          branch: `subagent/${input.runId}`,
          cwd,
          runStore: {},
          async cleanup() { cleanupStarted.resolve(); await releaseCleanup.promise; },
        };
      },
    },
    createExecutor() {
      return {
        async execute() { started.resolve(); return pending.promise; },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const launch = await manager.run({ prompt: "status order", mode: "background", worktree: "status-order" }, context);
    await started.promise;
    pending.resolve({ value: "done", attempts: [], cwd });
    await cleanupStarted.promise;
    const terminalBeforeCleanup = statuses.filter((status) => status.id === launch.id && status.state === "completed").at(-1);
    assert.equal(terminalBeforeCleanup?.worktree?.path, join(cwd, "worktree"));
    releaseCleanup.resolve();
    await waitFor(() => statuses.some((status) => status.id === launch.id && status.state === "completed" && status.worktree === undefined));
    const terminalAfterCleanup = statuses.filter((status) => status.id === launch.id && status.state === "completed").at(-1);
    assert.equal(terminalAfterCleanup?.worktree, undefined);
  } finally {
    releaseCleanup.resolve();
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("refreshes an open running subagent detail without overlap and stops at terminal state", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timerCallbacks = [];
  const clearedTimers = [];
  globalThis.setInterval = (callback, delay) => {
    assert.equal(delay, 1000);
    timerCallbacks.push(callback);
    return { unref() {} };
  };
  globalThis.clearInterval = (timer) => { clearedTimers.push(timer); };
  const cwd = await mkdtemp(join(tmpdir(), "subagents-navigator-refresh-"));
  const storageDir = join(cwd, "storage");
  const id = "run-refresh";
  const refresh = deferred();
  let detailCalls = 0;
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "refresh", label: "refresh", mode: "background" }));
  const running = { id, sessionId: "session-1", state: "running", startedAt: 1, progress: { accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, toolCalls: [], activity: { kind: "tool", text: "before" } } };
  const manager = {
    async run() { throw new Error("unexpected run"); },
    async inspect(params) {
      if (!params.id) return [running];
      detailCalls += 1;
      if (detailCalls === 1) return running;
      if (detailCalls === 2) return refresh.promise;
      return { id, sessionId: "session-1", state: "completed", startedAt: 1, finishedAt: 2, activity: { kind: "text", text: "done" } };
    },
    async steer() {},
    async stop() {},
    async retry() {},
  };
  const commands = [];
  registerSubagentsExtension({ registerTool() {}, registerCommand(name, options) { commands.push({ name, options }); } }, { manager, managerDependencies: { storageDir } });
  const command = commands.find(({ name }) => name === "subagents");
  assert.ok(command);
  let pickerCount = 0;
  const flush = async () => { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const context = {
    ...(await executionContext(cwd)),
    mode: "tui",
    hasUI: true,
    ui: {
      async select(_title, options) { pickerCount += 1; return pickerCount === 1 ? options[0] : "Close"; },
      async custom(factory) {
        let finish;
        const completed = new Promise((resolve) => { finish = resolve; });
        let renders = 0;
        const component = factory({ terminal: { rows: 20 }, requestRender() { renders += 1; } }, { fg: (_color, text) => text, bold: (text) => text }, { matches(data, binding) { return data === binding || data === "escape" && binding === "tui.select.cancel"; } }, (value) => finish(value));
        assert.equal(timerCallbacks.length, 1);
        assert.match(component.render(120).join("\n"), /before/);
        timerCallbacks[0]();
        timerCallbacks[0]();
        assert.equal(detailCalls, 2);
        refresh.resolve({ ...running, state: "completed", finishedAt: 2, progress: { ...running.progress, activity: { kind: "text", text: "done" } } });
        await flush();
        assert.equal(detailCalls, 2);
        assert.match(component.render(120).join("\n"), /done/);
        assert.equal(clearedTimers.length, 1);
        const rendersAtTerminal = renders;
        timerCallbacks[0]();
        await flush();
        assert.equal(detailCalls, 2);
        assert.equal(renders, rendersAtTerminal);
        component.handleInput("escape");
        await completed;
        return completed;
      },
      notify(message) { throw new Error(message); },
    },
  };
  try {
    await command.options.handler("", context);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("ignores an in-flight detail refresh after the panel closes", async () => {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timerCallbacks = [];
  const clearedTimers = [];
  globalThis.setInterval = (callback, delay) => { assert.equal(delay, 1000); timerCallbacks.push(callback); return {}; };
  globalThis.clearInterval = (timer) => { clearedTimers.push(timer); };
  const cwd = await mkdtemp(join(tmpdir(), "subagents-navigator-refresh-close-"));
  const storageDir = join(cwd, "storage");
  const id = "run-refresh-close";
  const refresh = deferred();
  let detailCalls = 0;
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "refresh close", mode: "background" }));
  const running = { id, sessionId: "session-1", state: "running", startedAt: 1 };
  const manager = {
    async run() { throw new Error("unexpected run"); },
    async inspect(params) {
      if (!params.id) return [running];
      detailCalls += 1;
      if (detailCalls === 1) return running;
      return refresh.promise;
    },
    async steer() {},
    async stop() {},
    async retry() {},
  };
  const commands = [];
  registerSubagentsExtension({ registerTool() {}, registerCommand(name, options) { commands.push({ name, options }); } }, { manager, managerDependencies: { storageDir } });
  const command = commands.find(({ name }) => name === "subagents");
  assert.ok(command);
  let pickerCount = 0;
  const flush = async () => { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
  const context = {
    ...(await executionContext(cwd)),
    mode: "tui",
    hasUI: true,
    ui: {
      async select(_title, options) { pickerCount += 1; return pickerCount === 1 ? options[0] : "Close"; },
      async custom(factory) {
        let finish;
        const completed = new Promise((resolve) => { finish = resolve; });
        let renders = 0;
        const component = factory({ terminal: { rows: 20 }, requestRender() { renders += 1; } }, { fg: (_color, text) => text, bold: (text) => text }, { matches(data, binding) { return data === binding || data === "escape" && binding === "tui.select.cancel"; } }, (value) => finish(value));
        assert.equal(timerCallbacks.length, 1);
        timerCallbacks[0]();
        component.handleInput("escape");
        await completed;
        refresh.resolve({ ...running, state: "completed", finishedAt: 2 });
        await flush();
        assert.equal(detailCalls, 2);
        assert.equal(renders, 0);
        assert.equal(clearedTimers.length, 1);
        return completed;
      },
      notify(message) { throw new Error(message); },
    },
  };
  try {
    await command.options.handler("", context);
  } finally {
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
    await rm(cwd, { recursive: true, force: true });
  }
});

test("matches workflow agent detail fields and runs standalone registered and copy actions with live context", async () => {
  resetWorkflowRegistry();
  const cwd = await mkdtemp(join(tmpdir(), "subagents-agent-actions-"));
  const storageDir = join(cwd, "storage");
  await mkdir(join(storageDir, "run-agent-actions"), { recursive: true });
  await writeFile(join(storageDir, "run-agent-actions", "request.json"), JSON.stringify({ prompt: "Review", label: "scout", role: "scout", mode: "background" }));
  const attempt = {
    attempt: 2,
    transport: "fixture",
    session: { transport: "fixture", sessionId: "agent-session", locator: { sessionFile: join(cwd, "session.jsonl") } },
    setup: { hookNames: ["setup"], model: { provider: "fixture", model: "model" }, tools: ["read"], cwd },
    accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 },
  };
  const liveSession = { reference: attempt.session };
  const prepared = { cwd, model: { provider: "fixture", model: "model" }, tools: ["read"], sessionLabel: "scout" };
  const handoff = { state: "local-running", transferred: false };
  const status = {
    id: "run-agent-actions",
    sessionId: "session-1",
    state: "running",
    startedAt: Date.now() - 601_000,
    lastEventAt: Date.now() - 601_000,
    attempts: 2,
    attemptDetails: [attempt],
    progress: { accounting: attempt.accounting, toolCalls: [{ id: "tool", name: "read", state: "completed" }], state: { model: { provider: "fixture", model: "model" }, tools: ["read"] }, activity: { kind: "tool", text: "read" }, lastEventAt: attempt.startedAt },
    worktree: { path: join(cwd, "worktree"), branch: "subagent/run-agent-actions" },
  };
  let actionContext;
  let stopped = false;
  const manager = {
    async run() { throw new Error("unexpected run"); },
    async inspect(params) { return params.id ? { ...status, state: stopped ? "stopped" : "running" } : [{ ...status, state: stopped ? "stopped" : "running" }]; },
    async steer() { return { id: status.id, accepted: true }; },
    async stop() { stopped = true; return { ...status, state: "stopped" }; },
    async retry() { return { id: "retry-agent-actions", state: "running" }; },
    getAttemptActionData() { return { attempt, session: attempt.session, liveSession, prepared, handoff, signal: new AbortController().signal }; },
  };
  registerWorkflowExtension({ version: "1.0.0", headline: "Standalone action fixture", agentAttemptActions: {
    standaloneFixture: {
      label: "Standalone fixture action",
      visible() { return false; },
      run() {},
      visibleStandalone(context) { return context.agent.name === "scout" && context.attempt.attempt === 2 && context.liveSession === liveSession && context.prepared === prepared && context.handoff === handoff; },
      runStandalone(context) { actionContext = context; },
    },
  } });
  const commands = [];
  const copied = [];
  const renders = [];
  const pi = {
    registerTool() {},
    registerCommand(name, options) { commands.push({ name, options }); },
  };
  registerSubagentsExtension(pi, { manager, managerDependencies: { storageDir }, clipboard: async (value) => { copied.push(value); } });
  const command = commands.find(({ name }) => name === "subagents");
  assert.ok(command);
  const theme = { fg: (_color, text) => text, bold: (text) => text };
  let pickerCount = 0;
  const context = {
    ...(await executionContext(cwd)),
    mode: "tui",
    hasUI: true,
    ui: {
      async select(_title, options) { pickerCount += 1; return pickerCount === 1 ? options[0] : "Close"; },
      async custom(factory) {
        let component;
        let finish;
        const completed = new Promise((resolve) => { finish = resolve; });
        component = factory({ terminal: { rows: 30 }, requestRender() {} }, theme, { matches(data, binding) { return (data === "escape" && binding === "tui.select.cancel") || data === binding; } }, (value) => finish(value));
        renders.push(component.render(140).join("\n"));
        assert.match(renders.at(-1), /Activity: read/);
        assert.match(renders.at(-1), /stalled\? 10m/);
        assert.match(renders.at(-1), /Model: fixture\/model/);
        assert.match(renders.at(-1), /Role: scout/);
        assert.match(renders.at(-1), /Tools: read/);
        assert.match(renders.at(-1), /Attempts: 2/);
        assert.match(renders.at(-1), /Duration: 10m/);
        assert.match(renders.at(-1), /Tokens: ∑10/);
        component.handleInput("a");
        const actionScreen = component.render(140).join("\n");
        assert.match(actionScreen, /Standalone fixture action/);
        assert.match(actionScreen, /Copy branch/);
        assert.match(actionScreen, /Copy worktree path/);
        assert.match(actionScreen, /Open prompt in editor/);
        assert.match(actionScreen, /Open system prompt in editor/);
        assert.match(actionScreen, /Steer/);
        assert.match(actionScreen, /Stop/);
        assert.match(actionScreen, /Copy agent ID/);
        component.handleInput("tui.select.confirm");
        await waitFor(() => actionContext !== undefined);
        assert.equal(actionContext.liveSession, liveSession);
        assert.equal(actionContext.prepared, prepared);
        assert.equal(actionContext.handoff, handoff);
        assert.equal(actionContext.session.sessionId, "agent-session");
        await waitFor(() => !component.render(140).join("\n").includes("Agent actions"));
        component.handleInput("a");
        for (let index = 0; index < 7; index += 1) component.handleInput("tui.select.down");
        component.handleInput("tui.select.confirm");
        await waitFor(() => copied.length === 1);
        assert.equal(copied[0], status.id);
        await waitFor(() => !component.render(140).join("\n").includes("Agent actions"));
        component.handleInput("escape");
        return completed;
      },
      notify() {},
    },
  };
  try {
    await command.options.handler("", context);
  } finally {
    resetWorkflowRegistry();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("captures steering text inside the detail panel without nesting UI prompts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-navigator-steer-focus-"));
  const storageDir = join(cwd, "storage");
  const id = "run-steer-focus";
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "control", label: "control", mode: "background" }));
  const steers = [];
  const status = { id, sessionId: "session-1", state: "running", startedAt: 1 };
  const manager = {
    async run() { throw new Error("unexpected run"); },
    async inspect(params) { return params.id ? status : [status]; },
    async steer(request) { steers.push(request.message); return { id, accepted: true }; },
    async stop() {},
    async retry() {},
  };
  const commands = [];
  registerSubagentsExtension({ registerTool() {}, registerCommand(name, options) { commands.push({ name, options }); } }, { manager, managerDependencies: { storageDir } });
  const command = commands.find(({ name }) => name === "subagents");
  assert.ok(command);
  let pickerCount = 0;
  let customCount = 0;
  const context = {
    ...(await executionContext(cwd)),
    mode: "tui",
    hasUI: true,
    ui: {
      async select(_title, options) { pickerCount += 1; return pickerCount === 1 ? options[0] : "Close"; },
      async custom(factory) {
        customCount += 1;
        let finish;
        const completed = new Promise((resolve) => { finish = resolve; });
        const component = factory({ terminal: { rows: 30 }, requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, { matches(data, binding) { return data === binding || data === "escape" && binding === "tui.select.cancel"; } }, (value) => finish(value));
        if (customCount === 1) {
          component.handleInput("a");
          for (let index = 0; index < 10 && !component.render(140).join("\n").includes("→ Steer"); index += 1) component.handleInput("tui.select.down");
          assert.match(component.render(140).join("\n"), /→ Steer/);
          component.handleInput("tui.select.confirm");
          assert.match(component.render(140).join("\n"), /Steer subagent/);
          for (const character of "continue inside the panel") component.handleInput(character);
          component.handleInput("\r");
        } else {
          component.handleInput("escape");
        }
        const result = await completed;
        return result;
      },
      async input() { throw new Error("nested input must not be used"); },
      notify() {},
    },
  };
  try {
    await command.options.handler("", context);
    assert.deepEqual(steers, ["continue inside the panel"]);
    assert.equal(customCount, 1);
    assert.equal(pickerCount, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bounds every narrow detail-panel row while preserving scrolling and action selection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-navigator-narrow-"));
  const storageDir = join(cwd, "storage");
  const id = "run-narrow";
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "narrow", label: "narrow", mode: "background" }));
  const status = { id, sessionId: "session-1", state: "running", startedAt: 1 };
  const manager = {
    async run() { throw new Error("unexpected run"); },
    async inspect(params) { return params.id ? status : [status]; },
    async steer() {},
    async stop() {},
    async retry() {},
  };
  const commands = [];
  registerSubagentsExtension({ registerTool() {}, registerCommand(name, options) { commands.push({ name, options }); } }, { manager, managerDependencies: { storageDir } });
  const command = commands.find(({ name }) => name === "subagents");
  assert.ok(command);
  const width = 12;
  let pickerCount = 0;
  const context = {
    ...(await executionContext(cwd)),
    mode: "tui",
    hasUI: true,
    ui: {
      async select(_title, options) { pickerCount += 1; return pickerCount === 1 ? options[0] : "Close"; },
      async custom(factory) {
        let closed = false;
        const tui = { terminal: { rows: 5 }, requestRender() {} };
        const component = factory(tui, { fg: (_color, text) => text, bold: (text) => text }, { matches(data, binding) { return data === binding || data === "escape" && binding === "tui.select.cancel"; } }, () => { closed = true; });
        const assertNarrowRows = (rows) => assert.ok(rows.every((row) => visibleWidth(row) <= width), rows.join("\n"));
        assertNarrowRows(component.render(width));
        component.handleInput("tui.select.down");
        assertNarrowRows(component.render(width));
        component.handleInput("a");
        assertNarrowRows(component.render(width));
        let sawActionSection = false;
        let sawActionRow = false;
        for (let index = 0; index < 4; index += 1) {
          component.handleInput("tui.select.pageDown");
          const frame = component.render(width);
          assertNarrowRows(frame);
          sawActionSection ||= frame.some((row) => row.includes("Agent"));
          sawActionRow ||= frame.some((row) => row.includes("Steer"));
        }
        assert.equal(sawActionSection, true);
        assert.equal(sawActionRow, true);
        tui.terminal.rows = 30;
        for (let index = 0; index < 10 && !component.render(80).join("\n").includes("→ Steer"); index += 1) component.handleInput("tui.select.down");
        assert.match(component.render(80).join("\n"), /→ Steer/);
        component.handleInput("tui.select.confirm");
        assertNarrowRows(component.render(width));
        assert.match(component.render(width).join("\n"), /Steer/);
        component.handleInput("escape");
        component.handleInput("escape");
        component.handleInput("escape");
        assert.equal(closed, true);
        return undefined;
      },
      notify(message) { throw new Error(message); },
    },
  };
  try {
    await command.options.handler("", context);
    assert.equal(pickerCount, 2);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("runs navigator steer, stop, and non-blocking retry actions with state revalidation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-navigator-controls-"));
  const storageDir = join(cwd, "storage");
  const id = "run-controls";
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "control", label: "control", mode: "foreground" }));
  let state = "running";
  const steers = [];
  const retryContexts = [];
  const selectedOptions = [];
  const manager = {
    async run() { throw new Error("unexpected run"); },
    async inspect(params) {
      const status = { id, sessionId: "session-1", state, startedAt: 1, ...(state === "running" ? { lastEventAt: 1 } : { finishedAt: 2, error: state === "failed" ? { code: "AGENT_FAILED", message: "failed" } : undefined }) };
      return params.id ? status : [status];
    },
    async steer(request) { steers.push(request.message); return { id, accepted: true }; },
    async stop() { state = "stopped"; return { id, state }; },
    async retry(_request, context) { retryContexts.push(context); return { id: "retried-controls", state: "running" }; },
  };
  const commands = [];
  registerSubagentsExtension({ registerTool() {}, registerCommand(name, options) { commands.push({ name, options }); } }, { manager, managerDependencies: { storageDir } });
  const command = commands.find(({ name }) => name === "subagents");
  assert.ok(command);
  let pickerCount = 0;
  const context = {
    ...(await executionContext(cwd)),
    mode: "rpc",
    hasUI: true,
    ui: {
      async select(_title, options) {
        selectedOptions.push([...options]);
        if (!options.includes("Steer") && !options.includes("Stop") && !options.includes("Retry")) {
          pickerCount += 1;
          return pickerCount === 1 ? options[0] : "Close";
        }
        if (options.includes("Steer") && steers.length === 0) return "Steer";
        if (options.includes("Stop")) return "Stop";
        return "Retry";
      },
      async input() { return "continue with the checklist"; },
      notify() {},
    },
  };
  try {
    await command.options.handler("", context);
    assert.deepEqual(steers, ["continue with the checklist"]);
    assert.equal(state, "stopped");
    assert.equal(retryContexts.length, 1);
    assert.equal(retryContexts[0].waitForForeground, false);
    assert.equal(selectedOptions.some((options) => options.includes("Steer") && options.includes("Stop") && !options.includes("Retry")), true);
    assert.equal(selectedOptions.some((options) => options.includes("Retry") && !options.includes("Steer") && !options.includes("Stop")), true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("reports an invalid navigator retry result without leaving the picker", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-navigator-invalid-retry-"));
  const storageDir = join(cwd, "storage");
  const id = "run-invalid-retry";
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "retry", mode: "background" }));
  let retryCalled = false;
  const notices = [];
  const manager = {
    async run() { throw new Error("unexpected run"); },
    async inspect(params) { const status = { id, sessionId: "session-1", state: "stopped", startedAt: 1, finishedAt: 2 }; return params.id ? status : [status]; },
    async steer() {},
    async stop() {},
    async retry() { retryCalled = true; return { id, state: "stopped" }; },
  };
  const commands = [];
  registerSubagentsExtension({ registerTool() {}, registerCommand(name, options) { commands.push({ name, options }); } }, { manager, managerDependencies: { storageDir } });
  const command = commands.find(({ name }) => name === "subagents");
  assert.ok(command);
  let pickerCount = 0;
  const context = {
    ...(await executionContext(cwd)),
    mode: "rpc",
    hasUI: true,
    ui: {
      async select(_title, options) {
        if (!options.includes("Retry")) { pickerCount += 1; return pickerCount === 1 ? options[0] : "Close"; }
        return retryCalled ? "Back" : "Retry";
      },
      notify(message) { notices.push(message); },
    },
  };
  try {
    await command.options.handler("", context);
    assert.equal(retryCalled, true);
    assert.match(notices.join("\n"), /invalid subagent result/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("opens bounded prompt and result artifacts while terminal runs hide system prompts", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-navigator-editors-"));
  const storageDir = join(cwd, "storage");
  const id = "run-editors";
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "PROMPT_START", label: "editor", mode: "background" }));
  const attempt = { attempt: 1, transport: "fixture", setup: { hookNames: [], model: { provider: "fixture", model: "model" }, tools: [], cwd }, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } };
  const status = { id, sessionId: "session-1", state: "completed", startedAt: 1, finishedAt: 2, attempts: 1, attemptDetails: [attempt] };
  const manager = {
    async run() { throw new Error("unexpected run"); },
    async inspect(params) { return params.id ? { ...status, value: { answer: 42 } } : [status]; },
    async steer() {},
    async stop() {},
    async retry() {},
  };
  const editorPath = join(cwd, "fake-editor.sh");
  const editedPath = join(cwd, "edited-content");
  const openedPath = join(cwd, "opened-path");
  await writeFile(editorPath, "#!/bin/sh\ncat \"$3\" > \"$1\"\nprintf '%s' \"$3\" > \"$2\"\n", { mode: 0o755 });
  const previous = { VISUAL: process.env.VISUAL, EDITOR: process.env.EDITOR, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR };
  process.env.VISUAL = `${editorPath} ${editedPath} ${openedPath}`;
  process.env.EDITOR = process.env.VISUAL;
  process.env.PI_CODING_AGENT_DIR = cwd;
  const commands = [];
  registerSubagentsExtension({ registerTool() {}, registerCommand(name, options) { commands.push({ name, options }); } }, { manager, managerDependencies: { storageDir } });
  const command = commands.find(({ name }) => name === "subagents");
  assert.ok(command);
  let pickerCount = 0;
  const context = {
    ...(await executionContext(cwd)),
    mode: "tui",
    hasUI: true,
    ui: {
      async select(_title, options) { pickerCount += 1; return pickerCount === 1 ? options[0] : "Close"; },
      async custom(factory) {
        let finish;
        const completed = new Promise((resolve) => { finish = resolve; });
        const component = factory({ terminal: { rows: 30 }, stop() {}, start() {}, requestRender() {} }, { fg: (_color, text) => text, bold: (text) => text }, { matches(data, binding) { return data === binding || data === "escape" && binding === "tui.select.cancel"; } }, (value) => finish(value));
        const waitForArtifact = async (label, marker) => {
          for (let step = 0; step < 100; step += 1) {
            if (component.render(140).join("\n").includes(`→ ${label}`)) { component.handleInput("tui.select.confirm"); break; }
            component.handleInput("tui.select.down");
            await new Promise((resolve) => setTimeout(resolve, 1));
          }
          await waitFor(async () => { try { return (await readFile(editedPath, "utf8")).includes(marker); } catch { return false; } });
          assert.match(await readFile(openedPath, "utf8"), /artifact\.(md|json)$/);
          await waitFor(() => !component.render(140).join("\n").includes("Agent actions"));
          component.handleInput("a");
        };
        component.handleInput("a");
        assert.doesNotMatch(component.render(140).join("\n"), /Open system prompt in editor/);
        await waitForArtifact("Open prompt in editor", "PROMPT_START");
        await waitForArtifact("Open result in editor", '"answer": 42');
        component.handleInput("escape");
        component.handleInput("escape");
        return completed;
      },
      notify() {},
    },
  };
  try {
    await command.options.handler("", context);
    assert.equal(pickerCount, 2);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
    await rm(cwd, { recursive: true, force: true });
  }
});
test("exposes closed tool schemas and minimal prompt guidance", () => {
  assert.deepEqual(Object.keys(SUBAGENTS_RUN_PARAMETERS.properties), ["prompt", "mode", "label", "model", "tools", "skills", "extensions", "contextFiles", "role", "worktree", "outputSchema", "retries", "timeoutMs"]);
  assert.deepEqual(SUBAGENTS_RUN_PARAMETERS.required, ["prompt"]);
  assert.equal(SUBAGENTS_RUN_PARAMETERS.additionalProperties, false);
  assert.deepEqual(SUBAGENTS_RUN_PARAMETERS.properties.mode.anyOf.map(({ const: value }) => value), ["background", "foreground"]);

  assert.deepEqual(Object.keys(SUBAGENTS_INSPECT_PARAMETERS.properties), ["id"]);
  assert.equal(SUBAGENTS_INSPECT_PARAMETERS.additionalProperties, false);
  assert.equal(SUBAGENTS_INSPECT_PARAMETERS.required, undefined);
  for (const schema of [SUBAGENTS_ID_PARAMETERS, SUBAGENTS_STOP_PARAMETERS, SUBAGENTS_RETRY_PARAMETERS]) {
    assert.deepEqual(Object.keys(schema.properties), ["id"]);
    assert.deepEqual(schema.required, ["id"]);
    assert.equal(schema.additionalProperties, false);
  }
  assert.deepEqual(Object.keys(SUBAGENTS_STEER_PARAMETERS.properties), ["id", "message"]);
  assert.deepEqual(SUBAGENTS_STEER_PARAMETERS.required, ["id", "message"]);
  assert.equal(SUBAGENTS_STEER_PARAMETERS.additionalProperties, false);
});
async function executionContext(cwd, signal) {
  const models = [
    { provider: "fixture", id: "model" },
    { provider: "fixture", id: "cheap" },
    { provider: "fixture", id: "role-model" },
  ];
  return {
    cwd,
    model: { provider: "fixture", id: "model" },
    thinkingLevel: "medium",
    modelRegistry: { getAll: () => models, getAvailable: () => models },
    sessionManager: { getSessionId: () => "session-1" },
    isProjectTrusted: () => true,
    signal,
  };
}

async function managerContext(cwd) {
  return { toolCallId: "background", signal: undefined, extensionContext: await executionContext(cwd) };
}

test("runs one background subagent with context-derived setup and execution options", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-run-success-"));
  const agentDir = join(cwd, "agent");
  await mkdir(join(agentDir, "pi-extensible-workflows", "roles"), { recursive: true });
  await writeFile(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ modelAliases: { cheap: "fixture/cheap" }, skills: ["global-skill"], extensions: ["global-extension"] }));
  await mkdir(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  await writeFile(join(cwd, ".pi", "pi-extensible-workflows", "settings.json"), JSON.stringify({ skills: ["project-skill"], extensions: ["project-extension"] }));
  await writeFile(join(agentDir, "pi-extensible-workflows", "roles", "reviewer.md"), "---\nmodel: fixture/role-model:high\ntools: [read]\ndescription: Review work\n---\nReview carefully.");
  const sessionTransport = { id: "test", async createSession() { throw new Error("session should be supplied to the injected executor"); } };
  const controller = new AbortController();
  let root;
  let transport;
  let execution;
  const manager = createSubagentManager({
    agentDir,
    storageDir: join(cwd, "subagents-storage"),
    transport: sessionTransport,
    getActiveTools: () => ["read", "grep", "subagents_run"],
    createExecutor(nextRoot, nextTransport) {
      root = nextRoot;
      transport = nextTransport;
      return {
        async execute(task, options, signal) {
          execution = { task, options, signal };
          return { value: { answer: "ok" }, attempts: [], cwd: nextRoot.cwd };
        },
      };
    },
  });
  const runTool = createSubagentTools(manager)[0];
  const outputSchema = { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] };
  const context = await executionContext(cwd, controller.signal);
  const launch = await runTool.execute("call-1", { prompt: "inspect", label: "review", model: "cheap:high", tools: ["read"], outputSchema, retries: 2, timeoutMs: 500 }, controller.signal, undefined, context);
  assert.equal(launch.details.state, "running");
  await waitFor(() => execution !== undefined);
  assert.equal(transport, sessionTransport);
  assert.equal(root.cwd, cwd);
  assert.deepEqual(root.model, { provider: "fixture", model: "model", thinking: "medium" });
  assert.deepEqual([...root.tools], ["read", "grep"]);
  assert.equal(root.modelAliases.cheap, "fixture/cheap");
  assert.deepEqual(root.agentResourcePolicy().global, { skills: ["global-skill"], extensions: [join(agentDir, "pi-extensible-workflows", "global-extension")] });
  assert.deepEqual(root.agentResourcePolicy().project, { skills: ["project-skill"], extensions: [join(cwd, ".pi", "pi-extensible-workflows", "project-extension")] });
  assert.deepEqual(root.agentResourcePolicy().effective, { skills: ["global-skill", "project-skill"], extensions: [join(agentDir, "pi-extensible-workflows", "global-extension"), join(cwd, ".pi", "pi-extensible-workflows", "project-extension")] });
  assert.equal(root.agentDefinitions.reviewer.model, "fixture/role-model:high");
  assert.equal(execution.task, "inspect");
  const { onAttempt, onProgress, ...options } = execution.options;
  assert.equal(typeof onAttempt, "function");
  assert.equal(typeof onProgress, "function");
  assert.deepEqual(options, { label: "review", workflowName: "subagents", model: "cheap:high", tools: ["read"], schema: outputSchema, retries: 2, timeoutMs: 500 });
  assert.notEqual(execution.signal, controller.signal);
  assert.equal(root.runContext.runId, launch.details.id);
  await waitFor(async () => (await manager.inspect({ id: launch.details.id }, { toolCallId: "lookup", signal: undefined, extensionContext: context })).state === "completed");
  assert.equal((await manager.inspect({ id: launch.details.id }, { toolCallId: "lookup", signal: undefined, extensionContext: context })).sessionId, "session-1");
  assert.equal(JSON.parse(await readFile(join(cwd, "subagents-storage", launch.details.id, "status.json"), "utf8")).sessionId, "session-1");
  const roleLaunch = await runTool.execute("call-role", { prompt: "review", label: "role", role: "reviewer" }, controller.signal, undefined, context);
  await waitFor(() => execution?.task === "review");
  assert.equal(roleLaunch.details.state, "running");
  const { onAttempt: roleOnAttempt, onProgress: roleOnProgress, ...roleOptions } = execution.options;
  assert.equal(typeof roleOnAttempt, "function");
  assert.equal(typeof roleOnProgress, "function");
  assert.deepEqual(roleOptions, { label: "role", workflowName: "subagents", role: "reviewer" });
  await rm(cwd, { recursive: true, force: true });
});

test("keeps top-level model with a role and persists a background execution failure", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-run-failure-"));
  const controller = new AbortController();
  let launches = 0;
  let execution;
  const manager = createSubagentManager({
    agentDir: join(cwd, "agent"),
    storageDir: join(cwd, "subagents-storage"),
    getActiveTools: () => ["read"],
    createExecutor() {
      return {
        async execute(_task, options) {
          execution = options;
          launches += 1;
          throw new Error("agent failed");
        },
      };
    },
  });
  const runTool = createSubagentTools(manager)[0];
  const extensionContext = await executionContext(cwd, controller.signal);
  const launched = await runTool.execute("call-2", { prompt: "inspect", role: "reviewer", model: "fixture/cheap:high" }, controller.signal, undefined, extensionContext);
  await waitFor(async () => (await manager.inspect({ id: launched.details.id }, { toolCallId: "lookup", signal: undefined, extensionContext })).state === "failed");
  assert.equal(launches, 1);
  const { onAttempt, onProgress, ...options } = execution;
  assert.equal(typeof onAttempt, "function");
  assert.equal(typeof onProgress, "function");
  assert.deepEqual(options, { label: "reviewer", workflowName: "subagents", role: "reviewer", model: "fixture/cheap:high" });
  assert.deepEqual((await manager.inspect({ id: launched.details.id }, { toolCallId: "lookup", signal: undefined, extensionContext })).error, { code: "AGENT_FAILED", message: "agent failed" });
  await rm(cwd, { recursive: true, force: true });
});
test("returns foreground terminal envelopes, preserves mode for retry, and suppresses follow-ups", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-foreground-terminal-"));
  const storageDir = join(cwd, "subagents-storage");
  const notifications = [];
  const updates = [];
  let failed = false;
  let timeoutMs;
  const manager = createSubagentManager({
    storageDir,
    notify(notification) { notifications.push(notification); },
    createExecutor() {
      return {
        async execute(prompt, options) {
          timeoutMs = options.timeoutMs;
          if (prompt === "failure" && !failed) {
            failed = true;
            throw new Error("foreground failure");
          }
          if (prompt === "timeout") throw new WorkflowError("AGENT_TIMEOUT", "foreground timeout");
          return { value: { prompt }, attempts: [], cwd };
        },
      };
    },
  });
  const context = await managerContext(cwd);
  context.onUpdate = (status) => { updates.push(status); };
  try {
    const success = await manager.run({ prompt: "success", mode: "foreground" }, context);
    assert.equal(success.state, "completed");
    assert.deepEqual(success.value, { prompt: "success" });
    assert.deepEqual(JSON.parse(await readFile(join(storageDir, success.id, "request.json"), "utf8")), { prompt: "success", mode: "foreground" });
    assert.deepEqual((await manager.inspect({ id: success.id }, context)).value, { prompt: "success" });

    const failure = await manager.run({ prompt: "failure", mode: "foreground" }, context);
    assert.deepEqual(failure.error, { code: "AGENT_FAILED", message: "foreground failure" });
    assert.equal(failure.state, "failed");
    const retry = await manager.retry({ id: failure.id }, context);
    assert.equal(retry.state, "completed");
    assert.deepEqual(retry.value, { prompt: "failure" });
    assert.notEqual(retry.id, failure.id);
    assert.deepEqual(JSON.parse(await readFile(join(storageDir, retry.id, "request.json"), "utf8")), { prompt: "failure", mode: "foreground" });

    const timedOut = await manager.run({ prompt: "timeout", mode: "foreground", timeoutMs: 1 }, context);
    assert.equal(timeoutMs, 1);
    assert.equal(timedOut.state, "failed");
    assert.deepEqual(timedOut.error, { code: "AGENT_TIMEOUT", message: "foreground timeout" });
    assert.deepEqual((await manager.inspect({ id: timedOut.id }, context)).error, { code: "AGENT_TIMEOUT", message: "foreground timeout" });
    assert.deepEqual(updates.filter(({ id }) => id === success.id).map(({ state }) => state), ["running", "completed", "completed"]);
    assert.deepEqual(updates.filter(({ id }) => id === failure.id).map(({ state }) => state), ["running", "failed", "failed"]);
    assert.deepEqual(updates.filter(({ id }) => id === retry.id).map(({ state }) => state), ["running", "completed", "completed"]);
    assert.deepEqual(notifications, []);
    await assert.rejects(manager.inspect({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" }, context), (error) => error?.code === "RUN_NOT_FOUND");
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cancelling a foreground run aborts its native session and persists CANCELLED", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-foreground-cancel-"));
  const controller = new AbortController();
  const started = deferred();
  const lifecycle = { abort: 0, dispose: 0 };
  const manager = createSubagentManager({
    storageDir: join(cwd, "subagents-storage"),
    createExecutor() {
      return {
        async execute(_prompt, options, signal) {
          const session = {
            async abort() { lifecycle.abort += 1; },
            async dispose() { lifecycle.dispose += 1; },
          };
          await options.onAttempt?.({ attempt: 1, transport: "test", liveSession: session, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, setup: {} });
          started.resolve();
          return new Promise((resolve, reject) => {
            void resolve;
            signal?.addEventListener("abort", () => reject(new Error("native cancelled")), { once: true });
          });
        },
      };
    },
  });
  const context = await managerContext(cwd);
  context.signal = controller.signal;
  try {
    const pending = manager.run({ prompt: "cancel", mode: "foreground" }, context);
    await started.promise;
    controller.abort();
    const result = await pending;
    assert.deepEqual(result.error, { code: "CANCELLED", message: "Subagent cancelled" });
    assert.equal(result.state, "failed");
    assert.equal(lifecycle.abort, 1);
    assert.equal(lifecycle.dispose, 1);
    assert.deepEqual((await manager.inspect({ id: result.id }, context)).error, { code: "CANCELLED", message: "Subagent cancelled" });
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stopping an injected executor disposes its session after delayed rejection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-stop-injected-session-"));
  const started = deferred();
  const settlement = deferred();
  const lifecycle = { abort: 0, dispose: 0 };
  const manager = createSubagentManager({
    storageDir: join(cwd, "subagents-storage"),
    createExecutor() {
      return {
        async execute(_prompt, options) {
          const session = {
            async abort() { lifecycle.abort += 1; },
            async dispose() { lifecycle.dispose += 1; },
          };
          await options.onAttempt?.({ liveSession: session });
          started.resolve();
          return settlement.promise;
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const run = await manager.run({ prompt: "stop", mode: "background" }, context);
    await started.promise;
    const stopped = await manager.stop({ id: run.id }, context);
    assert.equal(stopped.state, "stopped");
    assert.equal(lifecycle.abort, 1);
    assert.equal(lifecycle.dispose, 0);
    settlement.reject(new Error("delayed executor rejection"));
    await waitFor(() => lifecycle.dispose === 1);
    assert.equal(lifecycle.abort, 1);
    assert.equal(lifecycle.dispose, 1);
  } finally {
    settlement.resolve({ value: "cleanup", attempts: [], cwd });
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("disposes each replaced injected session once after a stopped run settles", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-stop-replaced-sessions-"));
  const started = deferred();
  const releaseReplacement = deferred();
  const replacementSent = deferred();
  const settlement = deferred();
  const lifecycle = { first: { abort: 0, dispose: 0 }, second: { abort: 0, dispose: 0 } };
  const session = (counts) => ({
    async abort() { counts.abort += 1; },
    async dispose() { counts.dispose += 1; },
  });
  const manager = createSubagentManager({
    storageDir: join(cwd, "subagents-storage"),
    createExecutor() {
      return {
        async execute(_prompt, options) {
          await options.onAttempt?.({ liveSession: session(lifecycle.first) });
          started.resolve();
          await releaseReplacement.promise;
          await options.onAttempt?.({ liveSession: session(lifecycle.second) });
          replacementSent.resolve();
          return settlement.promise;
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const run = await manager.run({ prompt: "replace", mode: "background" }, context);
    await started.promise;
    await manager.stop({ id: run.id }, context);
    assert.deepEqual(lifecycle.first, { abort: 1, dispose: 0 });
    releaseReplacement.resolve();
    await replacementSent.promise;
    settlement.reject(new Error("delayed replacement rejection"));
    await waitFor(() => lifecycle.first.dispose === 1 && lifecycle.second.abort === 1 && lifecycle.second.dispose === 1);
    assert.deepEqual(lifecycle.first, { abort: 1, dispose: 1 });
    assert.deepEqual(lifecycle.second, { abort: 1, dispose: 1 });
  } finally {
    releaseReplacement.resolve();
    settlement.resolve({ value: "cleanup", attempts: [], cwd });
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

async function waitFor(predicate, onTimeout) {
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await onTimeout?.();
  throw new Error("Timed out waiting for subagent state");
}

function deferredExecution(prompt, pending, started) {
  started.push(prompt);
  return new Promise((resolve, reject) => {
    pending.set(prompt, { resolve, reject });
  });
}

test("runs simultaneous background subagents and settles them independently", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-background-concurrent-"));
  const storageDir = join(cwd, "subagents-storage");
  const pending = new Map();
  const started = [];
  const worktreeInputs = [];
  const manager = createSubagentManager({
    storageDir,
    worktreeAdapter: {
      async create(input) {
        worktreeInputs.push(input);
        return {
          path: join(cwd, `${input.name}-${input.runId}`),
          branch: `subagent/${input.name}-${input.runId}`,
          cwd,
          runStore: { async recordSystemPrompt() {}, async validateWorktree() { throw new Error("unused"); }, async worktree() { throw new Error("unused"); }, async snapshotWorktree() { throw new Error("unused"); } },
          async cleanup() {},
        };
      },
    },
    createExecutor() {
      return {
        execute(prompt) {
          return deferredExecution(prompt, pending, started);
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const first = await manager.run({ prompt: "first", worktree: "one" }, context);
    const second = await manager.run({ prompt: "second", worktree: "two" }, context);
    assert.equal(first.state, "running");
    assert.equal(second.state, "running");
    await waitFor(() => started.length === 2);
    assert.deepEqual(new Set(started), new Set(["first", "second"]));
    await waitFor(() => worktreeInputs.length === 2);
    assert.deepEqual(worktreeInputs.map(({ name }) => name), ["one", "two"]);
    assert.notEqual(worktreeInputs[0].owner, worktreeInputs[1].owner);
    assert.equal((await manager.inspect({ id: first.id }, context)).state, "running");
    assert.equal((await manager.inspect({ id: second.id }, context)).state, "running");

    pending.get("first").resolve({ value: { answer: "one" }, attempts: [], cwd });
    await waitFor(async () => (await manager.inspect({ id: first.id }, context)).state === "completed");
    assert.equal((await manager.inspect({ id: second.id }, context)).state, "running");
    assert.deepEqual((await manager.inspect({ id: first.id }, context)).value, { answer: "one" });

    pending.get("second").resolve({ value: { answer: "two" }, attempts: [], cwd });
    await waitFor(async () => (await manager.inspect({ id: second.id }, context)).state === "completed");
    const listed = (await manager.inspect({}, context)).map(({ id, state }) => ({ id, state }));
    const expected = await Promise.all([first, second].map(async ({ id }) => ({ id, state: "completed", startedAt: JSON.parse(await readFile(join(storageDir, id, "status.json"), "utf8")).startedAt })));
    expected.sort((left, right) => left.startedAt - right.startedAt || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    assert.deepEqual(listed, expected.map(({ id, state }) => ({ id, state })));
    const restarted = createSubagentManager({ storageDir });
    assert.equal((await restarted.inspect({ id: first.id }, context)).state, "completed");
    assert.deepEqual((await restarted.inspect({ id: first.id }, context)).value, { answer: "one" });
  } finally {
    for (const run of pending.values()) run.reject(new Error("test cleanup"));
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bounds standalone launches by effective workflow concurrency without a queue", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-concurrency-bound-"));
  const agentDir = join(cwd, "agent");
  const storageDir = join(cwd, "subagents-storage");
  await mkdir(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  await writeFile(join(cwd, ".pi", "pi-extensible-workflows", "settings.json"), JSON.stringify({ concurrency: 1 }));
  const pending = new Map();
  const started = [];
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  const manager = createSubagentManager({
    agentDir,
    storageDir,
    worktreeAdapter: {
      async create(input) {
        return { path: join(cwd, `worktree-${input.runId}`), branch: `subagent/${input.runId}`, cwd, runStore: {}, async cleanup() { cleanupStarted.resolve(); await releaseCleanup.promise; } };
      },
    },
    createExecutor() {
      return {
        async execute(prompt) {
          started.push(prompt);
          return new Promise((resolve, reject) => { pending.set(prompt, { resolve, reject }); });
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const results = await Promise.allSettled([
      manager.run({ prompt: "first", worktree: "first" }, context),
      manager.run({ prompt: "second" }, context),
    ]);
    assert.equal(results[0].status, "fulfilled");
    assert.equal(results[1].status, "rejected");
    assert.ok(results[1].reason instanceof WorkflowError);
    assert.equal(results[1].reason.code, "AGENT_FAILED");
    assert.match(results[1].reason.message, /concurrency|no queue|settles/i);
    await waitFor(() => started.length === 1);

    const first = results[0].value;
    pending.get("first").resolve({ value: "first", attempts: [], cwd });
    await waitFor(async () => (await manager.inspect({ id: first.id }, context)).state === "completed");
    await cleanupStarted.promise;

    const second = await manager.run({ prompt: "second" }, context);
    await waitFor(() => started.length === 2);
    pending.get("second").resolve({ value: "second", attempts: [], cwd });
    await waitFor(async () => (await manager.inspect({ id: second.id }, context)).state === "completed");
    releaseCleanup.resolve();
  } finally {
    releaseCleanup.resolve();
    for (const run of pending.values()) run.reject(new Error("test cleanup"));
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("releases a stopped subagent concurrency slot before worktree cleanup settles", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-concurrency-stop-"));
  const agentDir = join(cwd, "agent");
  const storageDir = join(cwd, "subagents-storage");
  await mkdir(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  await writeFile(join(cwd, ".pi", "pi-extensible-workflows", "settings.json"), JSON.stringify({ concurrency: 1 }));
  const pending = new Map();
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  let creates = 0;
  const manager = createSubagentManager({
    agentDir,
    storageDir,
    worktreeAdapter: {
      async create(input) {
        const cleanup = creates++ === 0 ? async () => { cleanupStarted.resolve(); await releaseCleanup.promise; } : async () => {};
        return {
          path: join(cwd, `worktree-${input.runId}`),
          branch: `subagent/${input.runId}`,
          cwd,
          runStore: {},
          cleanup,
        };
      },
    },
    createExecutor() {
      return {
        execute(prompt, _options, signal) {
          return new Promise((resolve, reject) => {
            pending.set(prompt, { resolve, reject });
            signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      };
    },
  });
  const context = await managerContext(cwd);
  let stopping;
  try {
    const first = await manager.run({ prompt: "first", worktree: "first" }, context);
    await waitFor(() => pending.has("first"));
    stopping = manager.stop({ id: first.id }, context);
    await waitFor(async () => (await manager.inspect({ id: first.id }, context)).state === "stopped");
    await cleanupStarted.promise;

    const second = await manager.run({ prompt: "second" }, context);
    assert.equal(second.state, "running");
    await waitFor(() => pending.has("second"));
    await assert.rejects(manager.run({ prompt: "third" }, context), (error) => error instanceof WorkflowError && error.code === "AGENT_FAILED");

    releaseCleanup.resolve();
    await stopping;
    const persisted = JSON.parse(await readFile(join(storageDir, first.id, "status.json"), "utf8"));
    assert.equal(persisted.worktree, undefined);
    assert.equal(persisted.worktreeContext, undefined);
    pending.get("second").resolve({ value: "second", attempts: [], cwd });
    await waitFor(async () => (await manager.inspect({ id: second.id }, context)).state === "completed");
  } finally {
    releaseCleanup.resolve();
    for (const run of pending.values()) run.reject(new Error("test cleanup"));
    await stopping?.catch(() => undefined);
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bounds failed and retried standalone launches before failed worktree cleanup settles", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-concurrency-failure-"));
  const agentDir = join(cwd, "agent");
  const storageDir = join(cwd, "subagents-storage");
  await mkdir(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  await writeFile(join(cwd, ".pi", "pi-extensible-workflows", "settings.json"), JSON.stringify({ concurrency: 1 }));
  const pending = new Map();
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  let creates = 0;
  let executions = 0;
  const manager = createSubagentManager({
    agentDir,
    storageDir,
    worktreeAdapter: {
      async create(input) {
        const cleanup = creates++ === 0 ? async () => { cleanupStarted.resolve(); await releaseCleanup.promise; throw new Error("cleanup failed"); } : async () => {};
        return {
          path: join(cwd, `worktree-${input.runId}`),
          branch: `subagent/${input.runId}`,
          cwd,
          runStore: {},
          cleanup,
        };
      },
    },
    createExecutor() {
      return {
        async execute(prompt) {
          executions += 1;
          if (executions === 1) throw new Error("first attempt failed");
          return new Promise((resolve, reject) => { pending.set(prompt, { resolve, reject }); });
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const first = await manager.run({ prompt: "retry", worktree: "retry" }, context);
    await waitFor(async () => (await manager.inspect({ id: first.id }, context)).state === "failed");
    await cleanupStarted.promise;
    const retried = await manager.retry({ id: first.id }, context);
    await waitFor(() => pending.has("retry"));
    await assert.rejects(manager.run({ prompt: "third" }, context), (error) => error instanceof WorkflowError && error.code === "AGENT_FAILED");

    releaseCleanup.resolve();
    await waitFor(async () => {
      const persisted = JSON.parse(await readFile(join(storageDir, first.id, "status.json"), "utf8"));
      return persisted.state === "failed" && persisted.worktree !== undefined && persisted.worktreeContext !== undefined;
    });
    pending.get("retry").resolve({ value: "retried", attempts: [], cwd });
    await waitFor(async () => (await manager.inspect({ id: retried.id }, context)).state === "completed");
  } finally {
    releaseCleanup.resolve();
    for (const run of pending.values()) run.reject(new Error("test cleanup"));
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stopping one background subagent leaves another running", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-background-stop-"));
  const pending = new Map();
  const manager = createSubagentManager({
    storageDir: join(cwd, "subagents-storage"),
    createExecutor() {
      return {
        execute(prompt, _options, signal) {
          return new Promise((resolve, reject) => {
            pending.set(prompt, { resolve, reject });
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const first = await manager.run({ prompt: "first" }, context);
    const second = await manager.run({ prompt: "second" }, context);
    assert.equal((await manager.stop({ id: first.id }, context)).state, "stopped");
    await waitFor(async () => (await manager.inspect({ id: first.id }, context)).state === "stopped");
    assert.equal((await manager.inspect({ id: second.id }, context)).state, "running");
    pending.get("second").resolve({ value: "second result", attempts: [], cwd });
    await waitFor(async () => (await manager.inspect({ id: second.id }, context)).state === "completed");
    assert.equal((await manager.inspect({ id: second.id }, context)).value, "second result");
  } finally {
    for (const run of pending.values()) run.reject(new Error("test cleanup"));
    await rm(cwd, { recursive: true, force: true });
  }
});

test("persists failed background subagents for repeatable lookup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-background-failure-"));
  const storageDir = join(cwd, "subagents-storage");
  const managerDependencies = {
    storageDir,
    createExecutor() {
      return {
        async execute() {
          throw new Error("agent failed");
        },
      };
    },
  };
  const context = await managerContext(cwd);
  try {
    const manager = createSubagentManager(managerDependencies);
    const launched = await manager.run({ prompt: "fail me", mode: "background", label: "failure" }, context);
    await waitFor(async () => (await manager.inspect({ id: launched.id }, context)).state === "failed");
    const expectedFailure = { code: "AGENT_FAILED", message: "agent failed" };
    assert.deepEqual((await manager.inspect({ id: launched.id }, context)).error, expectedFailure);
    assert.deepEqual((await manager.inspect({ id: launched.id }, context)).error, expectedFailure);

    const runDirectory = join(storageDir, launched.id);
    assert.equal((await stat(storageDir)).mode & 0o777, 0o700);
    assert.equal((await stat(runDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(runDirectory, "request.json"))).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(await readFile(join(runDirectory, "request.json"), "utf8")), { prompt: "fail me", mode: "background", label: "failure" });
    assert.deepEqual(JSON.parse(await readFile(join(runDirectory, "failure.json"), "utf8")), expectedFailure);

    const restarted = createSubagentManager(managerDependencies);
    assert.equal((await restarted.inspect({ id: launched.id }, context)).state, "failed");
    assert.deepEqual((await restarted.inspect({ id: launched.id }, context)).error, expectedFailure);
    assert.deepEqual((await restarted.inspect({}, context)).map(({ id, state }) => ({ id, state })), [{ id: launched.id, state: "failed" }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
test("reconciles orphaned running records after a manager restart", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-background-orphan-"));
  const storageDir = join(cwd, "subagents-storage");
  const id = "11111111-1111-4111-8111-111111111111";
  const runDirectory = join(storageDir, id);
  const startedAt = Date.now() - 1000;
  await mkdir(runDirectory, { recursive: true });
  await writeFile(join(runDirectory, "request.json"), JSON.stringify({ prompt: "orphan" }));
  await writeFile(join(runDirectory, "status.json"), JSON.stringify({ id, state: "running", startedAt }));
  const manager = createSubagentManager({ storageDir });
  const context = await managerContext(cwd);
  try {
    const status = await manager.inspect({ id }, context);
    assert.equal(status.state, "failed");
    assert.deepEqual(status.error, { code: "INTERNAL_ERROR", message: "Subagent run was interrupted before completion" });
    assert.deepEqual((await manager.inspect({ id }, context)).error, { code: "INTERNAL_ERROR", message: "Subagent run was interrupted before completion" });
    assert.deepEqual((await manager.inspect({}, context)).map(({ id: listedId, state }) => ({ id: listedId, state })), [{ id, state: "failed" }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("queues steering until the executor registers its handler and flushes in order", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-steering-before-handler-"));
  const started = deferred();
  const pending = deferred();
  let register;
  const delivered = [];
  const manager = createSubagentManager({
    storageDir: join(cwd, "subagents-storage"),
    createExecutor() {
      return {
        execute(_prompt, _options, _signal, setSteer) {
          register = setSteer;
          started.resolve();
          return pending.promise;
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const run = await manager.run({ prompt: "steer me" }, context);
    await started.promise;
    await manager.steer({ id: run.id, message: "first" }, context);
    await manager.steer({ id: run.id, message: "second" }, context);
    await manager.steer({ id: run.id, message: "third" }, context);
    assert.deepEqual(delivered, []);
    register((message) => { delivered.push(message); });
    await waitFor(() => delivered.length === 3);
    assert.deepEqual(delivered, ["first", "second", "third"]);
    pending.resolve({ value: "done", attempts: [], cwd });
    await waitFor(async () => (await manager.inspect({ id: run.id }, context)).state === "completed");
  } finally {
    pending.resolve({ value: "cleanup", attempts: [], cwd });
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects steering after settlement", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-steering-settled-"));
  const manager = createSubagentManager({
    storageDir: join(cwd, "subagents-storage"),
    createExecutor() { return { async execute() { return { value: "done", attempts: [], cwd }; } }; },
  });
  const context = await managerContext(cwd);
  try {
    const run = await manager.run({ prompt: "finish" }, context);
    await waitFor(async () => (await manager.inspect({ id: run.id }, context)).state === "completed");
    await assert.rejects(manager.steer({ id: run.id, message: "late" }, context));
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("stop and steer race without affecting a sibling run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-stop-steer-race-"));
  const pending = new Map();
  const delivered = [];
  const manager = createSubagentManager({
    storageDir: join(cwd, "subagents-storage"),
    createExecutor() {
      return {
        execute(prompt, _options, signal, setSteer) {
          setSteer((message) => { delivered.push([prompt, message]); });
          return new Promise((resolve, reject) => {
            pending.set(prompt, { resolve, reject });
            signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          });
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const first = await manager.run({ prompt: "first" }, context);
    const second = await manager.run({ prompt: "second" }, context);
    await waitFor(() => pending.has("first") && pending.has("second"));
    await Promise.all([manager.steer({ id: first.id, message: "before-stop" }, context), manager.stop({ id: first.id }, context)]);
    await assert.rejects(manager.steer({ id: first.id, message: "after-stop" }, context));
    assert.equal((await manager.inspect({ id: first.id }, context)).state, "stopped");
    assert.equal((await manager.inspect({ id: second.id }, context)).state, "running");
    pending.get("second").resolve({ value: "second", attempts: [], cwd });
    await waitFor(async () => (await manager.inspect({ id: second.id }, context)).state === "completed");
    assert.equal(delivered.some(([prompt, message]) => prompt === "first" && message === "after-stop"), false);
  } finally {
    for (const item of pending.values()) item.reject(new Error("test cleanup"));
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("persists progress under one snapshot without duplicate accounting fields", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-progress-"));
  const storageDir = join(cwd, "subagents-storage");
  const pending = deferred();
  const accounting = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25 };
  const toolCalls = [{ id: "tool-1", name: "read", state: "running" }];
  const manager = createSubagentManager({
    storageDir,
    createExecutor() {
      return {
        async execute(_prompt, options) {
          await options.onProgress?.({ accounting, toolCalls, activity: { kind: "tool", text: "read" }, lastEventAt: 123, persist: true });
          return pending.promise;
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const run = await manager.run({ prompt: "progress" }, context);
    const status = await (async () => { await waitFor(async () => Boolean((await manager.inspect({ id: run.id }, context)).progress)); return manager.inspect({ id: run.id }, context); })();
    assert.deepEqual(status.progress, { accounting, toolCalls, activity: { kind: "tool", text: "read" }, lastEventAt: 123 });
    for (const field of ["usage", "accounting", "toolCalls", "activity", "lastEventAt"]) assert.equal(status[field], undefined);
    assert.equal(JSON.stringify(status).includes("systemPrompt"), false);
    await waitFor(async () => { try { return JSON.parse(await readFile(join(storageDir, run.id, "status.json"), "utf8")).progress !== undefined; } catch { return false; } });
    const persisted = JSON.parse(await readFile(join(storageDir, run.id, "status.json"), "utf8"));
    assert.deepEqual(persisted.progress, status.progress);
    assert.equal(JSON.stringify(persisted).includes("systemPrompt"), false);
    for (const field of ["usage", "accounting", "toolCalls", "activity", "lastEventAt"]) assert.equal(persisted[field], undefined);
    pending.resolve({ value: "done", attempts: [], cwd });
    await waitFor(async () => (await manager.inspect({ id: run.id }, context)).state === "completed");
    const restarted = createSubagentManager({ storageDir });
    assert.deepEqual((await restarted.inspect({ id: run.id }, context)).progress?.accounting, accounting);
    await restarted.dispose();
  } finally {
    pending.resolve({ value: "cleanup", attempts: [], cwd });
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("keeps retry accounting cumulative while live and at success or failure settlement", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-retry-accounting-"));
  const storageDir = join(cwd, "subagents-storage");
  const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const first = { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: 0.25 };
  const secondLive = { input: 7, output: 8, cacheRead: 9, cacheWrite: 10, cost: 0.75 };
  const secondFinal = { input: 11, output: 12, cacheRead: 13, cacheWrite: 14, cost: 1.25 };
  const setup = { hookNames: [], model: { provider: "fixture", model: "model" }, tools: [], cwd };
  const ready = { success: deferred(), failure: deferred() };
  const release = { success: deferred(), failure: deferred() };
  const add = (left, right) => ({ input: left.input + right.input, output: left.output + right.output, cacheRead: left.cacheRead + right.cacheRead, cacheWrite: left.cacheWrite + right.cacheWrite, cost: left.cost + right.cost });
  const manager = createSubagentManager({
    storageDir,
    createExecutor() {
      return {
        async execute(prompt, options) {
          const firstFailure = { attempt: 1, transport: "fixture", setup, accounting: first, error: { code: "AGENT_FAILED", message: "first attempt" } };
          const final = { attempt: 2, transport: "fixture", setup, accounting: secondFinal, result: "done" };
          await options.onAttempt?.({ attempt: 1, transport: "fixture", setup, accounting: zero });
          await options.onProgress?.({ accounting: first, toolCalls: [], persist: false });
          await options.onAttempt?.(firstFailure);
          await options.onProgress?.({ accounting: { input: 99, output: 99, cacheRead: 99, cacheWrite: 99, cost: 99 }, toolCalls: [], persist: false });
          await options.onAttempt?.({ attempt: 2, transport: "fixture", setup, accounting: zero });
          await options.onProgress?.({ accounting: secondLive, toolCalls: [], persist: false });
          ready[prompt].resolve();
          await release[prompt].promise;
          if (prompt === "failure") {
            const error = new Error("second attempt failed");
            error.attempts = [firstFailure, { ...final, result: undefined, error: { code: "AGENT_FAILED", message: "second attempt" } }];
            throw error;
          }
          return { value: "done", attempts: [firstFailure, final], cwd };
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const success = await manager.run({ prompt: "success" }, context);
    const failure = await manager.run({ prompt: "failure" }, context);
    await Promise.all([ready.success.promise, ready.failure.promise]);
    const runningAccounting = add(first, secondLive);
    assert.deepEqual((await manager.inspect({ id: success.id }, context)).progress?.accounting, runningAccounting);
    assert.deepEqual((await manager.inspect({ id: failure.id }, context)).progress?.accounting, runningAccounting);
    release.success.resolve();
    release.failure.resolve();
    await waitFor(async () => (await manager.inspect({ id: success.id }, context)).state === "completed");
    await waitFor(async () => (await manager.inspect({ id: failure.id }, context)).state === "failed");
    const terminalAccounting = add(first, secondFinal);
    assert.deepEqual((await manager.inspect({ id: success.id }, context)).progress?.accounting, terminalAccounting);
    assert.deepEqual((await manager.inspect({ id: failure.id }, context)).progress?.accounting, terminalAccounting);
  } finally {
    release.success.resolve();
    release.failure.resolve();
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

// Mirrors the host's delivery semantics, verified in pi-agent-core dist/agent-loop.js: the steering
// queue is drained at run start and after every turn_end, so a steering message reaches the parent at
// its next turn boundary; the follow-up queue is only read at the stop point, after the parent's run
// would otherwise end. Both queues survive an undrained run end (agent.js PendingMessageQueue), so
// endRun drains steering too; the modes differ in WHEN delivery happens, never in whether it happens.
function streamingParent(events) {
  const steering = [];
  const followUps = [];
  const deliver = (queue) => { for (const message of queue.splice(0)) events.push(["delivered", message.details.id]); };
  return {
    sendMessage(message, options) { (options.deliverAs === "followUp" ? followUps : steering).push(message); },
    pending() { return steering.length + followUps.length; },
    boundary() { deliver(steering); },
    endRun() { deliver(steering); deliver(followUps); },
  };
}
test("delivers completion and failure through steering messages while the parent is working", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-notifications-"));
  const messages = [];
  const events = [];
  const parent = streamingParent(events);
  const managerDependencies = {
    storageDir: join(cwd, "subagents-storage"),
    createExecutor() {
      return {
        async execute(prompt) {
          if (prompt === "failure") throw new Error("failed background work");
          return { value: "done", attempts: [], cwd };
        },
      };
    },
  };
  let shutdown;
  const registered = registerSubagentsExtension({
    registerTool() {},
    sendMessage(message, options) { messages.push({ message, options }); parent.sendMessage(message, options); },
    on(name, handler) { if (name === "session_shutdown") shutdown = handler; },
  }, { managerDependencies });
  const context = await managerContext(cwd);
  try {
    const success = await registered.manager.run({ prompt: "success", label: "docs-check", role: "scout" }, context);
    const failure = await registered.manager.run({ prompt: "failure", label: "tests-check", role: "reviewer" }, context);
    await waitFor(() => parent.pending() === 2);
    // The parent keeps working: its next inner-loop boundary happens before it collects the results.
    parent.boundary();
    await waitFor(async () => {
      const result = await registered.manager.inspect({ id: success.id }, context);
      if (result.state === "completed") events.push(["inspect", success.id]);
      return result.state === "completed";
    });
    await waitFor(async () => {
      const result = await registered.manager.inspect({ id: failure.id }, context);
      if (result.state === "failed") events.push(["inspect", failure.id]);
      return result.state === "failed";
    });
    parent.endRun();
    assert.deepEqual(messages.map(({ options }) => options), [{ deliverAs: "steer", triggerTurn: true }, { deliverAs: "steer", triggerTurn: true }]);
    assert.deepEqual(messages.map(({ message }) => ({ customType: message.customType, display: message.display, details: message.details })), [
      { customType: "subagents", display: true, details: { id: success.id, label: "docs-check", role: "scout", state: "completed" } },
      { customType: "subagents", display: true, details: { id: failure.id, label: "tests-check", role: "reviewer", state: "failed", error: { code: "AGENT_FAILED", message: "failed background work" } } },
    ]);
    assert.match(messages[0].message.content, /Subagent docs-check role=scout \([^)]+\) completed/);
    assert.match(messages[1].message.content, /Subagent tests-check role=reviewer \([^)]+\) failed/);
    // A follow-up would only be delivered by endRun, that is after the parent already collected both
    // results, which is the staleness this delivery mode exists to avoid.
    const delivered = (id) => events.findIndex(([kind, value]) => kind === "delivered" && value === id);
    const collected = (id) => events.findIndex(([kind, value]) => kind === "inspect" && value === id);
    for (const id of [success.id, failure.id]) {
      assert.notEqual(delivered(id), -1);
      assert.ok(delivered(id) < collected(id), `notification for ${id} was delivered after the parent collected the result`);
    }
  } finally {
    await shutdown?.({ type: "session_shutdown", reason: "quit" }, context);
    await rm(cwd, { recursive: true, force: true });
  }
});

test("session shutdown disposes active subagent sessions and rejects controls", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-shutdown-"));
  const storageDir = join(cwd, "subagents-storage");
  const pending = deferred();
  const sessionReady = deferred();
  const lifecycle = { abort: 0, dispose: 0 };
  let shutdown;
  const manager = createSubagentManager({
    storageDir,
    createExecutor() {
      return {
        async execute(_prompt, options, signal) {
          const session = {
            reference: { transport: "test", sessionId: "shutdown" },
            getState: () => ({ model: { provider: "fixture", model: "model" }, tools: [] }),
            getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
            getLastAssistant: () => undefined,
            subscribe: () => () => {},
            prompt: async () => {},
            steer: async () => {},
            async abort() { lifecycle.abort += 1; },
            async dispose() { lifecycle.dispose += 1; },
          };
          await options.onAttempt?.({ attempt: 1, transport: "test", liveSession: session, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 }, setup: { hookNames: [], model: { provider: "fixture", model: "model" }, tools: [], cwd } });
          sessionReady.resolve();
          signal.addEventListener("abort", () => pending.reject(new Error("aborted")), { once: true });
          return pending.promise;
        },
      };
    },
  });
  const registered = registerSubagentsExtension({ registerTool() {}, on(name, handler) { if (name === "session_shutdown") shutdown = handler; } }, { manager });
  const context = await managerContext(cwd);
  try {
    const run = await registered.manager.run({ prompt: "shutdown" }, context);
    await sessionReady.promise;
    await shutdown?.({ type: "session_shutdown", reason: "quit" }, context);
    assert.equal(lifecycle.abort, 1);
    assert.equal(lifecycle.dispose, 1);
    assert.equal((await registered.manager.inspect({ id: run.id }, context)).state, "stopped");
    await assert.rejects(registered.manager.steer({ id: run.id, message: "late" }, context));
  } finally {
    pending.resolve({ value: "cleanup", attempts: [], cwd });
    await registered.manager.dispose?.();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("uses RunStore worktrees and removes them after a standalone run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-runstore-worktree-"));
  await writeFile(join(cwd, "README.md"), "base\n");
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["add", "README.md"], { cwd });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"], { cwd });
  let worktreePath;
  let branch;
  const manager = createSubagentManager({
    storageDir: join(cwd, "subagents-storage"),
    createExecutor(root) {
      return {
        async execute(_task, options) {
          const reference = await root.runStore.validateWorktree(options.worktreeOwner);
          worktreePath = reference.cwd;
          branch = reference.branch;
          return { value: { cwd: reference.cwd }, attempts: [], cwd: reference.cwd };
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const launched = await manager.run({ prompt: "work", worktree: "actual" }, context);
    await waitFor(async () => (await manager.inspect({ id: launched.id }, context)).state === "completed");
    assert.equal(typeof worktreePath, "string");
    await waitFor(async () => typeof worktreePath === "string" && !(await stat(worktreePath).then(() => true, () => false)));
    await waitFor(() => typeof branch === "string" && execFileSync("git", ["branch", "--list", branch], { cwd, encoding: "utf8" }).trim() === "");
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("isolates concurrent real-git worktrees with the same name", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-runstore-worktree-concurrent-"));
  await writeFile(join(cwd, "README.md"), "base\n");
  execFileSync("git", ["init", "-q"], { cwd });
  execFileSync("git", ["add", "README.md"], { cwd });
  execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "base"], { cwd });
  const storageDir = join(cwd, "subagents-storage");
  const pending = deferred();
  const references = [];
  const manager = createSubagentManager({
    storageDir,
    createExecutor(root) {
      return {
        async execute(_task, options) {
          references.push(await root.runStore.validateWorktree(options.worktreeOwner));
          return pending.promise;
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    let first;
    let second;
    const originalDateNow = Date.now;
    Date.now = () => 1234;
    try {
      first = await manager.run({ prompt: "first", worktree: "shared" }, context);
      second = await manager.run({ prompt: "second", worktree: "shared" }, context);
    } finally {
      Date.now = originalDateNow;
    }
    await waitFor(() => references.length === 2, async () => {
      const diagnostics = await Promise.all([first, second].map(async ({ id }) => {
        const status = await manager.inspect({ id }, context);
        const failure = await readFile(join(storageDir, id, "failure.json"), "utf8").catch((error) => `unavailable: ${error.message}`);
        return { id, status, failure };
      }));
      process.stderr.write(`Concurrent worktree diagnostics: ${JSON.stringify(diagnostics)}\n`);
      process.stderr.write(`Concurrent git worktrees:\n${execFileSync("git", ["worktree", "list", "--porcelain"], { cwd, encoding: "utf8" })}`);
    });
    assert.notEqual(references[0].cwd, references[1].cwd);
    assert.notEqual(references[0].branch, references[1].branch);
    pending.resolve({ value: "done", attempts: [], cwd });
    await waitFor(async () => (await manager.inspect({ id: first.id }, context)).state === "completed" && (await manager.inspect({ id: second.id }, context)).state === "completed");
    await waitFor(async () => (await Promise.all(references.map(({ cwd: worktreeCwd }) => stat(worktreeCwd).then(() => true, () => false)))).every((exists) => !exists));
    await waitFor(() => references.every(({ branch }) => execFileSync("git", ["branch", "--list", branch], { cwd, encoding: "utf8" }).trim() === ""));
  } finally {
    pending.resolve({ value: "cleanup", attempts: [], cwd });
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("creates and cleans an injected named worktree for a subagent", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-worktree-adapter-"));
  const storageDir = join(cwd, "subagents-storage");
  const created = [];
  let cleaned = 0;
  let capturedRoot;
  let capturedOptions;
  const adapter = {
    async create(input) {
      created.push(input);
      return {
        path: join(cwd, "worktree"),
        branch: "subagent/review",
        cwd: join(cwd, "worktree"),
        runStore: {
          async recordSystemPrompt() {},
          async validateWorktree() { return { path: join(cwd, "worktree"), branch: "subagent/review", cwd: join(cwd, "worktree"), owner: input.owner, base: "base" }; },
          async worktree() { return { path: join(cwd, "worktree"), branch: "subagent/review", cwd: join(cwd, "worktree"), owner: input.owner, base: "base" }; },
          async snapshotWorktree() { return "base"; },
        },
        async cleanup() { cleaned += 1; },
      };
    },
  };
  const manager = createSubagentManager({
    storageDir,
    worktreeAdapter: adapter,
    createExecutor(root) {
      capturedRoot = root;
      return {
        async execute(_task, options) {
          capturedOptions = options;
          return { value: "done", attempts: [], cwd };
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const launched = await manager.run({ prompt: "work", worktree: "review" }, context);
    await waitFor(async () => (await manager.inspect({ id: launched.id }, context)).state === "completed");
    await waitFor(async () => JSON.parse(await readFile(join(storageDir, launched.id, "status.json"), "utf8")).worktreeContext === undefined);
    const persisted = JSON.parse(await readFile(join(storageDir, launched.id, "status.json"), "utf8"));
    assert.equal(persisted.worktreeContext, undefined);
    assert.equal(persisted.worktree, undefined);
    assert.equal(created.length, 1);
    assert.deepEqual(created[0], { cwd, sessionId: "session-1", runId: launched.id, name: "review", owner: "worktree/named/review" });
    assert.equal(capturedOptions.worktreeOwner, "worktree/named/review");
    assert.ok(capturedRoot.runStore);
    assert.equal((await manager.inspect({ id: launched.id }, context)).worktree, undefined);
    assert.equal(cleaned, 1);
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("persists worktree recovery context before adapter creation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-worktree-precreate-"));
  const storageDir = join(cwd, "storage");
  const createStarted = deferred();
  const releaseCreate = deferred();
  const manager = createSubagentManager({
    storageDir,
    worktreeAdapter: {
      async create(input) {
        createStarted.resolve(input);
        await releaseCreate.promise;
        return { path: join(cwd, "created-worktree"), branch: "subagent/created", cwd, runStore: { async recordSystemPrompt() {}, async validateWorktree() { throw new Error("unused"); }, async worktree() { throw new Error("unused"); }, async snapshotWorktree() { throw new Error("unused"); } }, async cleanup() {} };
      },
    },
    createExecutor() { return { async execute() { return { value: "done", attempts: [], cwd }; } }; },
  });
  const context = await managerContext(cwd);
  try {
    const launched = await manager.run({ prompt: "precreate", worktree: "precreate" }, context);
    const worktreeContext = await createStarted.promise;
    const persisted = JSON.parse(await readFile(join(storageDir, launched.id, "status.json"), "utf8"));
    assert.deepEqual(persisted.worktreeContext, worktreeContext);
    assert.equal(persisted.worktree, undefined);
    releaseCreate.resolve();
    await waitFor(async () => (await manager.inspect({ id: launched.id }, context)).state === "completed");
  } finally {
    releaseCreate.resolve();
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("rejects empty standalone worktree names", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-worktree-name-"));
  const manager = createSubagentManager({ storageDir: join(cwd, "storage"), worktreeAdapter: { async create() { throw new Error("should not create"); } } });
  try {
    await assert.rejects(manager.run({ prompt: "work", worktree: "   " }, await managerContext(cwd)), (error) => error?.code === "INVALID_METADATA");
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("encodes standalone worktree names before persistence", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-worktree-name-encoded-"));
  const names = ["nested/name", "..", "control\u0000name"];
  const created = [];
  const manager = createSubagentManager({
    storageDir: join(cwd, "storage"),
    worktreeAdapter: {
      async create(input) {
        created.push(input);
        return {
          path: join(cwd, `worktree-${created.length}`),
          branch: `subagent/${created.length}`,
          cwd,
          runStore: { async recordSystemPrompt() {}, async validateWorktree() { throw new Error("unused"); }, async worktree() { throw new Error("unused"); }, async snapshotWorktree() { throw new Error("unused"); } },
          async cleanup() {},
        };
      },
    },
    createExecutor() { return { async execute() { return { value: "done", attempts: [], cwd }; } }; },
  });
  const context = await managerContext(cwd);
  try {
    for (const name of names) {
      const run = await manager.run({ prompt: name, worktree: name }, context);
      await waitFor(async () => (await manager.inspect({ id: run.id }, context)).state === "completed");
    }
    assert.deepEqual(created.map(({ name, owner }) => ({ name, owner })), [
      { name: "nested/name", owner: "worktree/named/nested%2Fname" },
      { name: "..", owner: "worktree/named/.." },
      { name: "control\u0000name", owner: "worktree/named/control%00name" },
    ]);
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("retries a failed subagent from its persisted request with a new ID", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-retry-"));
  let launches = 0;
  const manager = createSubagentManager({
    storageDir: join(cwd, "storage"),
    createExecutor() {
      return {
        async execute() {
          launches += 1;
          if (launches === 1) throw new Error("first attempt failed");
          return { value: { retry: true }, attempts: [], cwd };
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const original = await manager.run({ prompt: "retry me", mode: "background", label: "retryable" }, context);
    await waitFor(async () => (await manager.inspect({ id: original.id }, context)).state === "failed");
    const retried = await manager.retry({ id: original.id }, context);
    assert.notEqual(retried.id, original.id);
    assert.equal(retried.state, "running");
    await waitFor(async () => (await manager.inspect({ id: retried.id }, context)).state === "completed");
    assert.deepEqual((await manager.inspect({ id: retried.id }, context)).value, { retry: true });
    assert.equal(launches, 2);
    assert.deepEqual(JSON.parse(await readFile(join(cwd, "storage", retried.id, "request.json"), "utf8")), { prompt: "retry me", mode: "background", label: "retryable" });
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("retries an interrupted persisted subagent as a new run", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-interrupted-retry-"));
  const storageDir = join(cwd, "storage");
  const id = "22222222-2222-4222-8222-222222222222";
  await mkdir(join(storageDir, id), { recursive: true });
  const cleanupCalls = [];
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "interrupted", worktree: "scope" }));
  await writeFile(join(storageDir, id, "status.json"), JSON.stringify({ id, state: "running", startedAt: Date.now() - 10, worktreeContext: { cwd, sessionId: "session-1", runId: id, name: "scope", owner: "worktree/named/scope" } }));
  const manager = createSubagentManager({
    storageDir,
    worktreeAdapter: {
      async create() { return { path: join(cwd, "new-worktree"), branch: "new-branch", cwd, runStore: { async recordSystemPrompt() {}, async validateWorktree() { throw new Error("unused"); }, async worktree() { throw new Error("unused"); }, async snapshotWorktree() { throw new Error("unused"); } }, async cleanup() {}, }; },
      async cleanup(input) { cleanupCalls.push(input); },
    },
    createExecutor() { return { async execute() { return { value: "recovered", attempts: [], cwd }; } }; },
  });
  const context = await managerContext(cwd);
  try {
    assert.equal((await manager.inspect({ id }, context)).state, "failed");
    assert.deepEqual(cleanupCalls, [{ cwd, sessionId: "session-1", runId: id, name: "scope", owner: "worktree/named/scope" }]);
    const retried = await manager.retry({ id }, context);
    assert.notEqual(retried.id, id);
    await waitFor(async () => (await manager.inspect({ id: retried.id }, context)).state === "completed");
    assert.equal((await manager.inspect({ id: retried.id }, context)).value, "recovered");
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("removes legacy persisted worktree metadata without cleanup context", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-legacy-worktree-metadata-"));
  const storageDir = join(cwd, "storage");
  const id = "99999999-9999-4999-8999-999999999999";
  const worktree = { path: join(cwd, "legacy-worktree"), branch: "legacy-branch" };
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "legacy" }));
  await writeFile(join(storageDir, id, "status.json"), JSON.stringify({ id, state: "stopped", startedAt: Date.now() - 10, finishedAt: Date.now(), worktree }));
  const manager = createSubagentManager({ storageDir });
  const context = await managerContext(cwd);
  try {
    assert.equal((await manager.inspect({ id }, context)).state, "stopped");
    const persisted = JSON.parse(await readFile(join(storageDir, id, "status.json"), "utf8"));
    assert.equal(persisted.worktree, undefined);
    assert.equal(persisted.worktreeContext, undefined);
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("cleans a stopped persisted worktree during manager restart", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-stopped-worktree-recovery-"));
  const storageDir = join(cwd, "storage");
  const id = "66666666-6666-4666-8666-666666666666";
  const worktreeContext = { cwd, sessionId: "session-1", runId: id, name: "stopped", owner: "worktree/named/stopped" };
  const worktree = { path: join(cwd, "stale-worktree"), branch: "stale-branch" };
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "stopped", worktree: "stopped" }));
  await writeFile(join(storageDir, id, "status.json"), JSON.stringify({ id, state: "stopped", startedAt: Date.now() - 10, finishedAt: Date.now(), worktree, worktreeContext }));
  const cleanupCalls = [];
  const manager = createSubagentManager({
    storageDir,
    worktreeAdapter: {
      async create() { throw new Error("unused"); },
      async cleanup(input) { cleanupCalls.push(input); },
    },
  });
  const context = await managerContext(cwd);
  try {
    assert.equal((await manager.inspect({ id }, context)).state, "stopped");
    assert.deepEqual(cleanupCalls, [worktreeContext]);
    const persisted = JSON.parse(await readFile(join(storageDir, id, "status.json"), "utf8"));
    assert.equal(persisted.worktree, undefined);
    assert.equal(persisted.worktreeContext, undefined);
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("isolates failures while reconciling interrupted runs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-reconcile-isolation-"));
  const storageDir = join(cwd, "storage");
  const malformedId = "33333333-3333-4333-8333-333333333333";
  const cleanupId = "44444444-4444-4444-8444-444444444444";
  const healthyId = "55555555-5555-4555-8555-555555555555";
  const startedAt = Date.now() - 100;
  for (const id of [malformedId, cleanupId, healthyId]) await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, malformedId, "request.json"), JSON.stringify({ prompt: 42 }));
  await writeFile(join(storageDir, malformedId, "status.json"), JSON.stringify({ id: malformedId, state: "running", startedAt, attemptDetails: [{}], systemPrompt: "x".repeat(70_000), worktreeContext: { cwd, sessionId: "session-1", runId: malformedId, name: "malformed", owner: "worktree/named/malformed" } }));
  await writeFile(join(storageDir, cleanupId, "request.json"), JSON.stringify({ prompt: "cleanup", worktree: "cleanup" }));
  await writeFile(join(storageDir, cleanupId, "status.json"), JSON.stringify({ id: cleanupId, state: "running", startedAt: startedAt + 1, worktreeContext: { cwd, sessionId: "session-1", runId: cleanupId, name: "cleanup", owner: "worktree/named/cleanup" } }));
  await writeFile(join(storageDir, healthyId, "request.json"), JSON.stringify({ prompt: "healthy" }));
  await writeFile(join(storageDir, healthyId, "status.json"), JSON.stringify({ id: healthyId, state: "running", startedAt: startedAt + 2 }));
  const cleanupCalls = [];
  let cleanupFailures = 0;
  const managerDependencies = {
    storageDir,
    worktreeAdapter: {
      async create() { throw new Error("unused"); },
      async cleanup(input) {
        cleanupCalls.push(input.runId);
        if (input.runId === cleanupId && cleanupFailures++ === 0) throw new Error("cleanup failed");
      },
    },
  };
  const manager = createSubagentManager(managerDependencies);
  const context = await managerContext(cwd);
  try {
    assert.equal((await manager.inspect({ id: malformedId }, context)).state, "failed");
    assert.equal((await manager.inspect({ id: cleanupId }, context)).state, "failed");
    assert.equal((await manager.inspect({ id: healthyId }, context)).state, "failed");
    assert.deepEqual(new Set(cleanupCalls), new Set([malformedId, cleanupId]));
    assert.equal(cleanupCalls.length, 2);
    const restarted = createSubagentManager(managerDependencies);
    assert.equal((await restarted.inspect({ id: malformedId }, context)).state, "failed");
    assert.equal(cleanupCalls.filter((id) => id === malformedId).length, 1);
    assert.equal(cleanupCalls.filter((id) => id === cleanupId).length, 1);
    await restarted.dispose();
    assert.deepEqual((await manager.inspect({}, context)).map(({ id, state }) => ({ id, state })), [
      { id: malformedId, state: "failed" },
      { id: cleanupId, state: "failed" },
      { id: healthyId, state: "failed" },
    ]);
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("keeps healthy persisted rows available when another status has an I/O error", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-reconcile-storage-error-"));
  const storageDir = join(cwd, "storage");
  const healthyId = "66666666-6666-4666-8666-666666666666";
  const unreadableId = "77777777-7777-4777-8777-777777777777";
  await mkdir(join(storageDir, healthyId), { recursive: true });
  await mkdir(join(storageDir, unreadableId, "status.json"), { recursive: true });
  await writeFile(join(storageDir, healthyId, "status.json"), JSON.stringify({ id: healthyId, state: "stopped", startedAt: 1, finishedAt: 2 }));
  const manager = createSubagentManager({ storageDir });
  const context = await managerContext(cwd);
  try {
    assert.deepEqual((await manager.inspect({}, context)).map(({ id }) => id), [healthyId]);
    assert.equal((await manager.inspect({ id: healthyId }, context)).state, "stopped");
    await assert.rejects(manager.inspect({ id: unreadableId }, context), (error) => error instanceof WorkflowError && error.code === "INTERNAL_ERROR" && /Unable to read subagent/.test(error.message));
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("preserves completed results when persisted worktree cleanup fails", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-reconcile-completed-cleanup-failure-"));
  const storageDir = join(cwd, "storage");
  const id = "77777777-7777-4777-8777-777777777777";
  const worktreeContext = { cwd, sessionId: "session-1", runId: id, name: "completed", owner: "worktree/named/completed" };
  const worktree = { path: join(cwd, "completed-worktree"), branch: "completed-branch" };
  const status = { id, state: "completed", startedAt: Date.now() - 100, finishedAt: Date.now(), worktree, worktreeContext };
  const value = { preserved: true };
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "completed" }));
  await writeFile(join(storageDir, id, "status.json"), JSON.stringify(status));
  await writeFile(join(storageDir, id, "result.json"), JSON.stringify(value));
  const manager = createSubagentManager({ storageDir, worktreeAdapter: { async create() { throw new Error("unused"); }, async cleanup() { throw new Error("cleanup failed"); } } });
  const context = await managerContext(cwd);
  try {
    assert.deepEqual((await manager.inspect({ id }, context)).worktree, worktree);
    assert.deepEqual((await manager.inspect({ id }, context)).value, value);
    assert.deepEqual(JSON.parse(await readFile(join(storageDir, id, "status.json"), "utf8")), status);
    assert.deepEqual(JSON.parse(await readFile(join(storageDir, id, "result.json"), "utf8")), value);
    await assert.rejects(stat(join(storageDir, id, "failure.json")));
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reconciles a running persisted result before throwing worktree cleanup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-reconcile-running-result-"));
  const storageDir = join(cwd, "storage");
  const id = "12121212-1212-4121-8121-121212121212";
  const worktreeContext = { cwd, sessionId: "session-1", runId: id, name: "running-result", owner: "worktree/named/running-result" };
  const worktree = { path: join(cwd, "running-result-worktree"), branch: "running-result-branch" };
  const status = { id, state: "running", startedAt: Date.now() - 100, worktree, worktreeContext };
  const value = { preserved: true };
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "running-result", worktree: "running-result" }));
  await writeFile(join(storageDir, id, "status.json"), JSON.stringify(status));
  await writeFile(join(storageDir, id, "result.json"), JSON.stringify(value));
  const manager = createSubagentManager({ storageDir, liveness: { isLive: () => false }, worktreeAdapter: { async create() { throw new Error("unused"); }, async cleanup() { throw new Error("cleanup failed"); } } });
  const context = await managerContext(cwd);
  try {
    assert.deepEqual((await manager.inspect({ id }, context)).worktree, worktree);
    assert.deepEqual((await manager.inspect({ id }, context)).value, value);
    const persisted = JSON.parse(await readFile(join(storageDir, id, "status.json"), "utf8"));
    assert.equal(persisted.state, "completed");
    assert.deepEqual(persisted.worktree, worktree);
    assert.deepEqual(persisted.worktreeContext, worktreeContext);
    await assert.rejects(stat(join(storageDir, id, "failure.json")));
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("clears persisted worktree metadata after cleanup and retries failed cleanup", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-reconcile-context-"));
  const storageDir = join(cwd, "storage");
  const id = "88888888-8888-4888-8888-888888888888";
  const worktreeContext = { cwd, sessionId: "session-1", runId: id, name: "retry-cleanup", owner: "worktree/named/retry-cleanup" };
  const worktree = { path: join(cwd, "retry-worktree"), branch: "retry-branch" };
  const owner = { pid: 123, processStart: 1, sessionId: "live-session", token: "live-token", acquiredAt: Date.now() };
  const status = { id, state: "stopped", startedAt: Date.now() - 100, finishedAt: Date.now(), owner, worktree, worktreeContext };
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "retry-cleanup", worktree: "retry-cleanup" }));
  await writeFile(join(storageDir, id, "status.json"), JSON.stringify(status));
  let cleanupCalls = 0;
  const adapter = {
    async create() { throw new Error("unused"); },
    async cleanup() { cleanupCalls += 1; if (cleanupCalls === 1) throw new Error("try again"); },
  };
  const context = await managerContext(cwd);
  const first = createSubagentManager({ storageDir, liveness: { isLive: () => true }, worktreeAdapter: adapter });
  try {
    assert.equal((await first.inspect({ id }, context)).state, "stopped");
    const firstPersisted = JSON.parse(await readFile(join(storageDir, id, "status.json"), "utf8"));
    assert.deepEqual(firstPersisted.worktree, worktree);
    assert.deepEqual(firstPersisted.worktreeContext, worktreeContext);
  } finally {
    await first.dispose();
  }
  const second = createSubagentManager({ storageDir, liveness: { isLive: () => true }, worktreeAdapter: adapter });
  try {
    assert.equal((await second.inspect({ id }, context)).state, "stopped");
    const secondPersisted = JSON.parse(await readFile(join(storageDir, id, "status.json"), "utf8"));
    assert.equal(secondPersisted.worktree, undefined);
    assert.equal(secondPersisted.worktreeContext, undefined);
    assert.equal(cleanupCalls, 2);
  } finally {
    await second.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("reclaims a stale storage owner before reconciling persisted runs", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-reconcile-stale-owner-"));
  const storageDir = join(cwd, "storage");
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const worktreeContext = { cwd, sessionId: "session-1", runId: id, name: "stale-owner", owner: "worktree/named/stale-owner" };
  const staleOwner = { pid: 123, processStart: 1, sessionId: "stale-session", token: "stale-token", acquiredAt: Date.now() - 1000 };
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, "owner.json"), JSON.stringify(staleOwner));
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "stale-owner", worktree: "stale-owner" }));
  await writeFile(join(storageDir, id, "status.json"), JSON.stringify({ id, state: "running", startedAt: Date.now() - 100, owner: staleOwner, worktreeContext }));
  const cleanupCalls = [];
  const manager = createSubagentManager({
    storageDir,
    liveness: { pid: 456, processStart: 2, sessionId: "new-session", isLive: () => false },
    worktreeAdapter: {
      async create() { throw new Error("unused"); },
      async cleanup(input) { cleanupCalls.push(input); },
    },
  });
  const context = await managerContext(cwd);
  try {
    assert.equal((await manager.inspect({ id }, context)).state, "failed");
    assert.deepEqual(cleanupCalls, [worktreeContext]);
    const owner = JSON.parse(await readFile(join(storageDir, "owner.json"), "utf8"));
    assert.notEqual(owner.token, staleOwner.token);
    assert.equal(owner.sessionId, "new-session");
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("bounds storage-owner acquisition under owner-file churn", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-owner-acquisition-bound-"));
  const storageDir = join(cwd, "storage");
  const ownerPath = join(storageDir, "owner.json");
  const initialOwner = { pid: 301, processStart: 1, sessionId: "churn-owner", token: "initial", acquiredAt: Date.now() - 1000 };
  await mkdir(storageDir, { recursive: true });
  await writeFile(ownerPath, JSON.stringify(initialOwner));
  let probes = 0;
  const manager = createSubagentManager({
    storageDir,
    liveness: { pid: 302, processStart: 2, sessionId: "bounded", token: "bounded", async isLive(owner) {
      probes += 1;
      await writeFile(ownerPath, JSON.stringify({ ...owner, token: `churn-${probes}` }));
      return false;
    } },
    createExecutor() { return { async execute() { return { value: "done", attempts: [], cwd }; } }; },
  });
  const context = await managerContext(cwd);
  try {
    const launched = await manager.run({ prompt: "bounded" }, context);
    assert.equal(launched.state, "running");
    assert.equal(probes, 8);
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("a second live owner skips persisted-run reconciliation", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-reconcile-live-owner-"));
  const storageDir = join(cwd, "storage");
  const id = "99999999-9999-4999-8999-999999999999";
  const worktreeContext = { cwd, sessionId: "session-1", runId: id, name: "live-owner", owner: "worktree/named/live-owner" };
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "live-owner", worktree: "live-owner" }));
  await writeFile(join(storageDir, id, "status.json"), JSON.stringify({ id, state: "running", startedAt: Date.now() - 100, worktreeContext }));
  const cleanupStarted = deferred();
  const releaseCleanup = deferred();
  let cleanupCalls = 0;
  const liveness = { pid: 123, processStart: 1, sessionId: "test-session", isLive: () => true };
  const adapter = {
    async create() { throw new Error("unused"); },
    async cleanup() { cleanupCalls += 1; cleanupStarted.resolve(); await releaseCleanup.promise; },
  };
  const first = createSubagentManager({ storageDir, liveness, worktreeAdapter: adapter });
  const context = await managerContext(cwd);
  try {
    await cleanupStarted.promise;
    const second = createSubagentManager({ storageDir, liveness, worktreeAdapter: adapter });
    try {
      assert.equal((await second.inspect({ id }, context)).state, "running");
      assert.equal(cleanupCalls, 1);
    } finally {
      await second.dispose();
    }
    releaseCleanup.resolve();
    assert.equal((await first.inspect({ id }, context)).state, "failed");
  } finally {
    releaseCleanup.resolve();
    await first.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("protects a run started without the storage lease from another manager", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-run-owner-protection-"));
  const storageDir = join(cwd, "storage");
  const sharedOwner = { pid: 900, processStart: 1, sessionId: "lease-owner", token: "shared-owner", acquiredAt: Date.now() };
  await mkdir(storageDir, { recursive: true });
  await writeFile(join(storageDir, "owner.json"), JSON.stringify(sharedOwner));
  const pending = deferred();
  const cleanupCalls = [];
  const adapter = {
    async create(input) {
      return {
        path: join(cwd, "worktree"),
        branch: "subagent/protected",
        cwd,
        runStore: { async recordSystemPrompt() {}, async validateWorktree() { throw new Error("unused"); }, async worktree() { throw new Error("unused"); }, async snapshotWorktree() { throw new Error("unused"); } },
        async cleanup() { cleanupCalls.push(["run", input.runId]); },
      };
    },
    async cleanup(input) { cleanupCalls.push(["recovery", input.runId]); },
  };
  const manager = createSubagentManager({
    storageDir,
    liveness: { pid: 101, processStart: 2, sessionId: "manager-a", token: "manager-a", isLive: (owner) => owner.token === "shared-owner" },
    worktreeAdapter: adapter,
    createExecutor() { return { async execute() { return pending.promise; } }; },
  });
  const context = await managerContext(cwd);
  let second;
  try {
    const launched = await manager.run({ prompt: "protected", worktree: "protected" }, context);
    const statusFile = join(storageDir, launched.id, "status.json");
    await waitFor(async () => JSON.parse(await readFile(statusFile, "utf8")).worktreeContext !== undefined);
    const persisted = JSON.parse(await readFile(statusFile, "utf8"));
    assert.deepEqual(persisted.owner, { pid: 101, processStart: 2, sessionId: "manager-a", token: "manager-a", acquiredAt: persisted.owner.acquiredAt });
    await rm(join(storageDir, "owner.json"));
    second = createSubagentManager({
      storageDir,
      liveness: { pid: 202, processStart: 3, sessionId: "manager-b", token: "manager-b", isLive: (owner) => owner.token === "manager-a" },
      worktreeAdapter: adapter,
    });
    assert.equal((await second.inspect({ id: launched.id }, context)).state, "running");
    assert.deepEqual(cleanupCalls, []);
    pending.resolve({ value: "done", attempts: [], cwd });
    await waitFor(async () => (await manager.inspect({ id: launched.id }, context)).state === "completed");
  } finally {
    pending.resolve({ value: "cleanup", attempts: [], cwd });
    await second?.dispose();
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("backgrounds a foreground retry when the caller does not wait", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-nonblocking-retry-"));
  const pending = deferred();
  const retryStarted = deferred();
  let executions = 0;
  const manager = createSubagentManager({
    storageDir: join(cwd, "storage"),
    createExecutor() {
      return {
        async execute() {
          executions += 1;
          if (executions === 1) throw new Error("first failure");
          retryStarted.resolve();
          return pending.promise;
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const failed = await manager.run({ prompt: "retry me", mode: "foreground" }, context);
    assert.equal(failed.state, "failed");
    const retried = await manager.retry({ id: failed.id }, { ...context, waitForForeground: false });
    assert.equal(retried.state, "running");
    await retryStarted.promise;
    pending.resolve({ value: "retried", attempts: [], cwd });
    await waitFor(async () => (await manager.inspect({ id: retried.id }, context)).state === "completed");
  } finally {
    pending.resolve({ value: "cleanup", attempts: [], cwd });
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
test("tolerates malformed injected attempt setup while retaining valid accounting", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-malformed-injected-attempt-"));
  const storageDir = join(cwd, "storage");
  const accounting = { input: 4, output: 5, cacheRead: 6, cacheWrite: 7, cost: 0.75 };
  const manager = createSubagentManager({
    storageDir,
    createExecutor() {
      return {
        async execute() {
          return { value: { answer: "ok" }, attempts: [{ attempt: 1, transport: "fixture", setup: {}, accounting }], cwd };
        },
      };
    },
  });
  const context = await managerContext(cwd);
  try {
    const result = await manager.run({ prompt: "tolerate malformed metadata", mode: "foreground" }, context);
    assert.equal(result.state, "completed");
    const status = await manager.inspect({ id: result.id }, context);
    assert.deepEqual(status.progress?.accounting, accounting);
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("excludes the system prompt from every inspection projection", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-system-prompt-refresh-"));
  const attemptsReady = deferred();
  const continueAfterSecond = deferred();
  const cleared = deferred();
  const release = deferred();
  const accounting = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 };
  const setup = { hookNames: [], model: { provider: "fixture", model: "model" }, tools: [], cwd };
  const prepared = (systemPrompt) => ({ cwd, model: { provider: "fixture", model: "model" }, tools: [], sessionLabel: "subagent", systemPrompt });
  const manager = createSubagentManager({
    storageDir: join(cwd, "subagents-storage"),
    createExecutor() {
      return {
        async execute(_prompt, options) {
          const session = {
            async abort() {},
            async dispose() {},
          };
          await options.onAttempt?.({ attempt: 1, transport: "fixture", setup, accounting });
          await options.onAttempt?.({ attempt: 1, transport: "fixture", liveSession: session, prepared: prepared("FIRST"), setup, accounting });
          await options.onAttempt?.({ attempt: 2, transport: "fixture", liveSession: session, prepared: prepared("SECOND"), setup: {}, accounting });
          await options.onAttempt?.({ attempt: 2, transport: "fixture", session: { transport: "fixture", sessionId: "session-2" }, setup, accounting });
          attemptsReady.resolve();
          await continueAfterSecond.promise;
          await options.onAttempt?.({ attempt: 3, transport: "fixture", liveSession: session, prepared: { ...prepared("THIRD"), systemPrompt: 42 }, setup: {}, accounting });
          cleared.resolve();
          await release.promise;
          await options.onAttempt?.({ attempt: 4, transport: "fixture", liveSession: session, prepared: prepared("FINAL"), setup, accounting });
          await options.onAttempt?.({ attempt: 4, transport: "fixture", session: { transport: "fixture", sessionId: "session-4" }, setup, accounting });
          return { value: "done", attempts: [], cwd };
        },
      };
    },
  });
  const context = await managerContext(cwd);
  const detailContext = { ...context, includeAttemptMetadata: true };
  try {
    const run = await manager.run({ prompt: "system prompt", mode: "background" }, context);
    await attemptsReady.promise;
    assert.equal((await manager.inspect({ id: run.id }, detailContext)).progress?.state?.systemPrompt, undefined);
    continueAfterSecond.resolve();
    await cleared.promise;
    assert.equal((await manager.inspect({ id: run.id }, detailContext)).progress?.state?.systemPrompt, undefined);
    release.resolve();
    await waitFor(async () => (await manager.inspect({ id: run.id }, context)).state === "completed");
    assert.equal((await manager.inspect({ id: run.id }, detailContext)).progress?.state?.systemPrompt, undefined);
  } finally {
    continueAfterSecond.resolve();
    release.resolve();
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("loads legacy oversized progress metadata without breaking the picker list", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-legacy-progress-"));
  const storageDir = join(cwd, "storage");
  const goodId = "11111111-1111-4111-8111-111111111111";
  const legacyId = "22222222-2222-4222-8222-222222222222";
  const legacyTopLevelId = "44444444-4444-4444-8444-444444444444";
  const invalidId = "33333333-3333-4333-8333-333333333333";
  const accounting = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 };
  await mkdir(join(storageDir, goodId), { recursive: true });
  await mkdir(join(storageDir, legacyId), { recursive: true });
  await mkdir(join(storageDir, legacyTopLevelId), { recursive: true });
  await mkdir(join(storageDir, invalidId), { recursive: true });
  await writeFile(join(storageDir, goodId, "status.json"), JSON.stringify({ id: goodId, state: "completed", startedAt: 1 }));
  await writeFile(join(storageDir, legacyId, "status.json"), JSON.stringify({
    id: legacyId,
    state: "completed",
    startedAt: 2,
    progress: { accounting, toolCalls: [], state: { model: { provider: "fixture", model: "model" }, tools: [], systemPrompt: "x".repeat(70_000) } },
  }));
  await writeFile(join(storageDir, legacyTopLevelId, "status.json"), JSON.stringify({
    id: legacyTopLevelId,
    state: "completed",
    startedAt: 3,
    accounting,
    usage: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10 }, cost: 0.5 },
    systemPrompt: "legacy system prompt",
  }));
  await writeFile(join(storageDir, invalidId, "status.json"), JSON.stringify({ id: invalidId, state: "completed", startedAt: "invalid" }));
  const manager = createSubagentManager({ storageDir });
  const context = await managerContext(cwd);
  try {
    const statuses = await manager.inspect({}, context);
    assert.deepEqual(statuses.map(({ id }) => id), [goodId, legacyId, legacyTopLevelId]);
    const legacy = statuses.find(({ id }) => id === legacyId);
    assert.equal(legacy?.progress?.state?.systemPrompt, undefined);
    assert.equal(legacy?.attemptDetails, undefined);
    assert.equal(legacy?.systemPrompt, undefined);
    const legacyTopLevel = statuses.find(({ id }) => id === legacyTopLevelId);
    assert.deepEqual(legacyTopLevel?.progress, { accounting, toolCalls: [] });
    assert.equal(legacyTopLevel?.usage, undefined);
    assert.equal(legacyTopLevel?.accounting, undefined);
    assert.equal(legacyTopLevel?.toolCalls, undefined);
    assert.equal(JSON.stringify(legacyTopLevel).includes("systemPrompt"), false);
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("rejects malformed persisted attempt metadata at the manager boundary", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "subagents-malformed-attempt-metadata-"));
  const storageDir = join(cwd, "storage");
  const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await mkdir(join(storageDir, id), { recursive: true });
  await writeFile(join(storageDir, id, "request.json"), JSON.stringify({ prompt: "malformed" }));
  const manager = createSubagentManager({ storageDir });
  const context = await managerContext(cwd);
  try {
    for (const [field, value] of [["sessionId", 42], ["attempts", 0], ["attemptDetails", [{}]]]) {
      await writeFile(join(storageDir, id, "status.json"), JSON.stringify({ id, state: "completed", startedAt: 1, [field]: value }));
      await assert.rejects(manager.inspect({ id }, context), (error) => error instanceof WorkflowError && error.code === "INTERNAL_ERROR");
    }
  } finally {
    await manager.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
