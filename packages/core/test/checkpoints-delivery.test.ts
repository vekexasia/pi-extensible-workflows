import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { testExtensionApi, waitForIssue105 } from "./support.js";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, RunStore, runWorkflow, validateCheckpoint, WorkflowError } from "../src/index.js";
import { listRunIds } from "../src/persistence.js";

const waitForTurn = async (): Promise<void> => { await new Promise<void>((resolve) => setImmediate(resolve)); };
void test("navigator reviews each pending checkpoint before answering", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-checkpoint-review-"));
  const cwd = join(home, "project");
  const runId = "checkpoint-review";
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'review',description:'review'}", args: null, metadata: { name: "review", description: "review" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  const store = new RunStore(cwd, "session", runId, home);
  await store.create({ id: runId, workflowName: "review", cwd, sessionId: "session", state: "awaiting_input", agents: [], agentSessions: [] }, snapshot);
  await store.awaitCheckpoint({ path: "checkpoint/first", name: "first", prompt: "Review the first artifact?", context: { artifact: "object", entries: Array.from({ length: 80 }, (_, index) => `entry-${String(index)}`), marker: "OBJECT_CONTEXT_END" } });
  await store.awaitCheckpoint({ path: "checkpoint/second", name: "second", prompt: "Review the second artifact?", context: null });

  type Component = { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void };
  type Factory = (tui: { terminal: { rows: number }; requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => Component;
  let start!: (event: unknown, ctx: unknown) => Promise<void>;
  let command!: (args: string, ctx: unknown) => Promise<void>;
  const notices: string[] = [];
  const pi = {
    registerTool() {},
    registerCommand(_name: string, options: { handler: NonNullable<typeof command> }) { command = options.handler; },
    on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; },
    getThinkingLevel: () => "medium" as const,
    getActiveTools: () => ["workflow"],
    sendMessage() {},
  };
  workflowExtension(testExtensionApi(pi), home);

  let selectCalls = 0;
  let customCalls = 0;
  let pendingAfterCancel = 0;
  const ctx = {
    cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify(message: string) { notices.push(message); },
      select: async (prompt: string, options: string[]) => { selectCalls += 1; return prompt === "Workflow actions" ? options.find((option) => option.startsWith("Review ")) ?? options[0] : prompt.includes("interrupted") ? "Skip" : selectCalls === 2 ? options[0] : "Close"; },
      custom: async (factory: Factory) => {
        customCalls += 1;
        let result: string | undefined;
        const tui = { terminal: { rows: 12 }, requestRender() {} };
        const component = factory(tui, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { result = value; });
        if (customCalls === 1) {
          const dashboard = component.render(80).join("\n");
          assert.match(dashboard, /Tree/);
          component.handleInput?.("a");
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.confirm");
        } else if (customCalls === 2) {
          const reviewLines = component.render(40);
          const initial = reviewLines.join("\n");
          assert.match(reviewLines[0] ?? "", /^─+$/);
          assert.match(reviewLines.at(-1) ?? "", /^─+$/);
          assert.ok(initial.split("\n").length <= 12);
          assert.match(initial, /Name: first/);
          assert.match(initial, /Review the first artifact\?/);
          assert.match(initial, /Context:/);
          assert.doesNotMatch(initial, /OBJECT_CONTEXT_END/);
          tui.terminal.rows = 7;
          const compact = component.render(40).join("\n");
          assert.ok(compact.split("\n").length <= 7);
          assert.match(compact, /Approve/);
          assert.match(compact, /Reject/);
          assert.match(compact, /Cancel/);
          tui.terminal.rows = 4;
          const tiny = component.render(40).join("\n");
          assert.ok(tiny.split("\n").length <= 4);
          assert.match(tiny, /Approve[\s\S]*Reject[\s\S]*Cancel/);
          tui.terminal.rows = 12;
          for (let index = 0; index < 100; index += 1) component.handleInput?.("tui.select.pageDown");
          const scrolled = component.render(40).join("\n");
          assert.ok(scrolled.split("\n").length <= 12);
          assert.match(scrolled, /OBJECT_CONTEXT_END/);
          component.handleInput?.("tui.select.confirm");
        } else if (customCalls === 3) {
          const dashboard = component.render(80).join("\n");
          assert.doesNotMatch(dashboard, /Review first/);
          assert.match(dashboard, /Tree/);
          component.handleInput?.("a");
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.confirm");
        } else if (customCalls === 4) {
          const review = component.render(80).join("\n");
          assert.match(review, /Name: second/);
          assert.match(review, /Review the second artifact\?/);
          assert.match(review, /Context:\s*null/);
          component.handleInput?.("j");
          component.handleInput?.("tui.select.confirm");
          pendingAfterCancel = (await store.awaitingCheckpoints()).length;
        } else if (customCalls === 5) {
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.confirm");
        } else if (customCalls === 6) {
          assert.match(component.render(80).join("\n"), /Name: second/);
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.confirm");
        } else {
          component.handleInput?.("tui.select.cancel");
        }
        component.dispose?.();
        return result;
      },
    },
  };
  await start({}, ctx);
  await command("", ctx);

  assert.equal(selectCalls, 3);
  assert.equal(customCalls, 5);
  assert.equal(pendingAfterCancel, 1);
  assert.deepEqual(await store.replay("checkpoint/first"), { path: "checkpoint/first", value: true });
  assert.deepEqual(await store.replay("checkpoint/second"), { path: "checkpoint/second", value: false });
  assert.deepEqual(await store.awaitingCheckpoints(), []);
  assert.deepEqual(notices, []);
});

void test("session start delivers stale terminal runs once", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-stale-terminal-delivery-"));
  const snapshot = (name: string, launchMode: "foreground" | "background" = "foreground") => createLaunchSnapshot({ script: "return true;", args: null, metadata: { name }, launchMode, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] });
  const completed = new RunStore(home, "session", "stale-completed", home);
  const failed = new RunStore(home, "session", "stale-failed", home);
  const stopped = new RunStore(home, "session", "stale-stopped", home);
  const backgroundCompleted = new RunStore(home, "session", "stale-background-completed", home);
  const backgroundFailed = new RunStore(home, "session", "stale-background-failed", home);
  await completed.create({ id: completed.runId, workflowName: "stale-completed", cwd: home, sessionId: "session", state: "completed", agents: [], agentSessions: [], delivery: { mode: "foreground", state: "attached", toolCallId: "completed-call" } }, snapshot("stale-completed"));
  await completed.saveResult({ ok: true });
  await failed.create({ id: failed.runId, workflowName: "stale-failed", cwd: home, sessionId: "session", state: "failed", agents: [], agentSessions: [], error: { code: "AGENT_FAILED", message: "stale provider failure" }, delivery: { mode: "foreground", state: "attached", toolCallId: "failed-call" } }, snapshot("stale-failed"));
  await stopped.create({ id: stopped.runId, workflowName: "stale-stopped", cwd: home, sessionId: "session", state: "stopped", agents: [], agentSessions: [], delivery: { mode: "foreground", state: "attached", toolCallId: "stopped-call" } }, snapshot("stale-stopped"));
  const stoppedError = new RunStore(home, "session", "stale-stopped-error", home);
  await stoppedError.create({ id: stoppedError.runId, workflowName: "stale-stopped-error", cwd: home, sessionId: "session", state: "stopped", agents: [], agentSessions: [], error: { code: "AGENT_FAILED", message: "stale stopped failure" }, delivery: { mode: "foreground", state: "attached", toolCallId: "stopped-error-call" } }, snapshot("stale-stopped-error"));
  await backgroundCompleted.create({ id: backgroundCompleted.runId, workflowName: "stale-background-completed", cwd: home, sessionId: "session", state: "completed", agents: [], agentSessions: [], delivery: { mode: "background", state: "pending" } }, snapshot("stale-background-completed", "background"));
  await backgroundCompleted.saveResult({ ok: true });
  await backgroundFailed.create({ id: backgroundFailed.runId, workflowName: "stale-background-failed", cwd: home, sessionId: "session", state: "failed", agents: [], agentSessions: [], error: { code: "AGENT_FAILED", message: "stale background failure" }, delivery: { mode: "background", state: "pending" } }, snapshot("stale-background-failed", "background"));
  const messages: string[] = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, sendMessage(message: { content: string }) { messages.push(message.content); }, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  try {
    assert.ok(start);
    await start({}, context);
    assert.equal(messages.length, 6);
    assert.ok(messages.some((message) => message.includes('"state":"completed"') && message.includes("stale-completed")));
    assert.match(messages.find((message) => message.startsWith("Workflow stale-failed failed")) ?? "", /error=AGENT_FAILED: .*stale provider failure/);
    assert.match(messages.find((message) => message.startsWith("Workflow stale-failed failed")) ?? "", /workflow_retry/);
    assert.ok(messages.some((message) => message.includes('"state":"completed"') && message.includes("stale-background-completed")));
    assert.match(messages.find((message) => message.startsWith("Workflow stale-background-failed failed")) ?? "", /error=AGENT_FAILED: .*stale background failure/);
    assert.match(messages.find((message) => message.startsWith("Workflow stale-background-failed failed")) ?? "", /workflow_retry/);
    const stoppedMessage = messages.find((message) => message.startsWith("Workflow stale-stopped failed")) ?? "";
    assert.match(stoppedMessage, /error=CANCELLED:/);
    assert.doesNotMatch(stoppedMessage, /INTERNAL_ERROR|workflow_retry/);
    const stoppedErrorMessage = messages.find((message) => message.startsWith("Workflow stale-stopped-error failed")) ?? "";
    assert.match(stoppedErrorMessage, /error=AGENT_FAILED: .*stale stopped failure/);
    assert.doesNotMatch(stoppedErrorMessage, /workflow_retry/);
    for (const [store, toolCallId] of [[completed, "completed-call"], [failed, "failed-call"], [stopped, "stopped-call"], [stoppedError, "stopped-error-call"]] as const) assert.deepEqual((await store.load()).run.delivery, { mode: "background", state: "delivered", toolCallId });
    assert.deepEqual((await backgroundCompleted.load()).run.delivery, { mode: "background", state: "delivered" });
    assert.deepEqual((await backgroundFailed.load()).run.delivery, { mode: "background", state: "delivered" });
    await shutdown?.();
    let start2: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    let shutdown2: (() => Promise<void>) | undefined;
    workflowExtension(testExtensionApi({ registerTool() {}, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start2 = handler as typeof start; if (name === "session_shutdown") shutdown2 = handler as typeof shutdown; }, sendMessage(message: { content: string }) { messages.push(message.content); }, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
    assert.ok(start2);
    await start2({}, context);
    assert.equal(messages.length, 6);
    await shutdown2?.();
    shutdown = shutdown2;
  } finally {
    await shutdown?.();
  }
});

void test("session start omits resultPath for stale completed runs without a result artifact", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-stale-missing-result-"));
  const store = new RunStore(home, "session", "stale-missing-result", home);
  await store.create({ id: store.runId, workflowName: "stale-missing-result", cwd: home, sessionId: "session", state: "completed", agents: [], agentSessions: [], delivery: { mode: "foreground", state: "attached", toolCallId: "missing-result-call" } }, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "stale-missing-result" }, launchMode: "foreground", settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  const messages: string[] = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, sendMessage(message: { content: string }) { messages.push(message.content); }, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  try {
    assert.ok(start);
    await start({}, { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
    assert.equal(messages.length, 1);
    const descriptor = JSON.parse(messages[0] ?? "null") as { state: string; runId: string; resultPath?: string; resultBytes: number; inlined: boolean };
    assert.equal(descriptor.state, "completed");
    assert.equal(descriptor.runId, "stale-missing-result");
    assert.equal(descriptor.resultBytes, 0);
    assert.equal(descriptor.inlined, false);
    assert.ok(!("resultPath" in descriptor));
  } finally {
    await shutdown?.();
  }
});

void test("foreground setup failure leaves a live delivery attached", async () => {
  let failUpdate = true;
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-foreground-setup-failure-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  try {
    await assert.rejects(execute("foreground-setup-failure", { name: "foreground-setup-failure", script: "return true;", foreground: true }, new AbortController().signal, () => { if (failUpdate) throw new Error("setup update failed"); }, context), /setup update failed/);
    const runId = (await listRunIds(home, "session", home))[0];
    assert.ok(runId);
    assert.deepEqual((await new RunStore(home, "session", runId, home).load()).run.delivery, { mode: "foreground", state: "attached", toolCallId: "foreground-setup-failure" });
    assert.equal((await new RunStore(home, "session", runId, home).load()).run.state, "running");
  } finally {
    failUpdate = false;
    await shutdown?.().catch(() => {});
  }
});

void test("checkpoint contract is boolean-only and enforces UTF-8 limits", async () => {
  const accepted: unknown[] = [];
  assert.equal(await runWorkflow(`export const meta={name:'gate',description:'gate'}; return checkpoint({name:'ship',prompt:'Ship?',context:{sha:'abc'}});`, null, { checkpoint(input) { accepted.push(input); return false; } }).result, "rejected");
  assert.deepEqual(accepted, [{ name: "ship", prompt: "Ship?", context: { sha: "abc" } }]);
  assert.throws(() => validateCheckpoint({ name: "x", prompt: "😀".repeat(257), context: null }), /1024/);
  assert.throws(() => validateCheckpoint({ name: "x", prompt: "ok", context: "😀".repeat(1025) }), /4096/);
  assert.throws(() => validateCheckpoint({ name: "x", prompt: "ok", context: null, default: true }), /only name/);
  for (const value of [null, "checkpoint", { name: "x", prompt: "ok" }, { name: "", prompt: "ok", context: null }]) assert.throws(() => validateCheckpoint(value), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});

void test("production checkpoints resolve in foreground navigator and background tool paths", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-checkpoint-runtime-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const messages: string[] = [];
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {},
    getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow", "workflow_respond"],
    sendMessage(message: { content: string }) { messages.push(message.content); },
  };
  workflowExtension(testExtensionApi(pi), home);
  const workflow = tools.find(({ name }) => name === "workflow");
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(workflow && respond);
  const base = { cwd: home, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" } };
  const script = `export const meta={name:'gate',description:'gate'}; return checkpoint({name:'ship',prompt:'Ship?',context:{sha:'abc'}});`;
  let selections = 0;
  const foreground = await workflow.execute("id", { name: "gate", script, foreground: true }, new AbortController().signal, undefined, { ...base, mode: "rpc", hasUI: true, ui: { select: async () => ++selections === 1 ? undefined : "Approve" } }) as { content: Array<{ text: string }>; details: { runId: string } };
  assert.equal(JSON.parse(foreground.content[0]?.text ?? ""), "approved");
  assert.equal(selections, 2);
  await waitForTurn();
  await waitForTurn();
  assert.deepEqual(messages, []);
  assert.deepEqual((await new RunStore(home, "session", foreground.details.runId, home).load()).run.delivery, { mode: "foreground", state: "delivered", toolCallId: "id" });
  await assert.rejects(workflow.execute("id-no-ui", { name: "gate", script, foreground: true }, new AbortController().signal, undefined, { ...base, hasUI: false }), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  const teardown = new AbortController();
  await assert.rejects(workflow.execute("id-cancel", { name: "gate", script, foreground: true }, teardown.signal, undefined, { ...base, hasUI: true, ui: { select: async () => { teardown.abort(); throw new Error("UI closed"); } } }), (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  const duplicateScript = `export const meta={name:'duplicate-gate',description:'duplicate'}; return Promise.all([checkpoint({name:'first',prompt:'?',context:null,...{name:args.name}}),checkpoint({name:'second',prompt:'?',context:null,...{name:args.name}})]);`;
  const duplicate = await workflow.execute("id", { name: "duplicate-gate", script: duplicateScript, args: { name: "same" } }, new AbortController().signal, undefined, base) as { details: { runId: string } };
  const duplicateStore = new RunStore(home, "session", duplicate.details.runId, home);
  for (let attempt = 0; attempt < 1000 && (await duplicateStore.awaitingCheckpoints()).length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual((await duplicateStore.awaitingCheckpoints()).map((checkpoint) => checkpoint.name).sort(), ["same", "same#2"]);
  assert.equal((await respond.execute("id", { runId: duplicate.details.runId, name: "same", approved: true }) as { details: { accepted: boolean } }).details.accepted, true);
  assert.equal((await respond.execute("id", { runId: duplicate.details.runId, name: "same#2", approved: false }) as { details: { accepted: boolean } }).details.accepted, true);
  const background = await workflow.execute("id", { name: "gate", script }, new AbortController().signal, undefined, base) as { details: { runId: string } };
  const { runId } = background.details;
  let first: { details: { accepted: boolean } } | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    first = await respond.execute("id", { runId, name: "ship", approved: false }) as { details: { accepted: boolean } };
    if (first.details.accepted) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(first?.details.accepted, true);
  const second = await respond.execute("id", { runId, name: "ship", approved: true }) as { details: { accepted: boolean } };
  assert.equal(second.details.accepted, false);
});

void test("two concurrent checkpoints keep the run awaiting until both are answered", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-concurrent-checkpoints-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const pi = { registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow", "workflow_respond"], sendMessage() {} };
  workflowExtension(testExtensionApi(pi), home);
  const workflow = tools.find(({ name }) => name === "workflow");
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(workflow && respond);
  const script = `export const meta={name:'gates',description:'gates'}; return Promise.all([checkpoint({name:'one',prompt:'One?',context:null}),checkpoint({name:'two',prompt:'Two?',context:null})]);`;
  const launched = await workflow.execute("id", { name: "gates", script }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }) as { details: { runId: string } };
  const store = new RunStore(home, "session", launched.details.runId, home);
  for (let attempt = 0; attempt < 1000 && (await store.awaitingCheckpoints()).length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "awaiting_input"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await store.awaitingCheckpoints()).length, 2);
  assert.equal((await respond.execute("id", { runId: launched.details.runId, name: "one", approved: true }) as { details: { accepted: boolean } }).details.accepted, true);
  assert.equal((await store.load()).run.state, "awaiting_input");
  assert.equal((await respond.execute("id", { runId: launched.details.runId, name: "two", approved: false }) as { details: { accepted: boolean } }).details.accepted, true);
  for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await store.load()).run.state, "completed");
});

void test("a checkpoint answer persisted before resolver registration cannot hang", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-checkpoint-race-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let completed!: () => void;
  const completion = new Promise<void>((resolve) => { completed = resolve; });
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {},
    getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow", "workflow_respond"],
    sendMessage(message: { content: string }) { if (message.content.startsWith("Workflow race-gate completed:")) completed(); },
  };
  workflowExtension(testExtensionApi(pi), home);
  const workflow = tools.find(({ name }) => name === "workflow");
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(workflow && respond);
  let releaseRunId!: (runId: string) => void;
  const runIdReady = new Promise<string>((resolve) => { releaseRunId = resolve; });
  const updateState = Object.getOwnPropertyDescriptor(RunStore.prototype, "updateState")?.value as RunStore["updateState"];
  const restoreUpdateState = () => { RunStore.prototype.updateState = updateState; };
  let answered = false;
  RunStore.prototype.updateState = async function (update) {
    const run = await updateState.call(this, update);
    if (!answered && run.state === "awaiting_input" && this.cwd === home) {
      answered = true;
      const response = await respond.execute("id", { runId: await runIdReady, name: "ship", approved: false }) as { details: { accepted: boolean } };
      assert.equal(response.details.accepted, true);
    }
    return run;
  };
  const timeout = setTimeout(() => { completed(); }, 2000);
  try {
    const result = await workflow.execute("id", { name: "race-gate", script: `return checkpoint({name:'ship',prompt:'Ship?',context:null});` }, new AbortController().signal, undefined, { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }) as { details: { runId: string } };
    releaseRunId(result.details.runId);
    await completion;
    assert.equal(answered, true);
    assert.equal((await new RunStore(home, "session", result.details.runId, home).load()).run.state, "completed");
  } finally {
    clearTimeout(timeout);
    restoreUpdateState();
  }
});

void test("foreground and background completion delivery share bounded results", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-delivery-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details?: { runId: string; value?: unknown } }> }> = [];
  const messages: Array<{ message: { content: string }; options: { deliverAs: string; triggerTurn: boolean } }> = [];
  let markDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => { markDelivered = resolve; });
  let toolResultHandler: ((event: { toolName: string; toolCallId: string; isError: boolean }) => Promise<unknown>) | undefined;
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "tool_result") toolResultHandler = handler as typeof toolResultHandler; },
    getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"],
    sendMessage(message: { content: string }, options: { deliverAs: string; triggerTurn: boolean }) { messages.push({ message, options }); markDelivered(); }
  };
  workflowExtension(testExtensionApi(pi), home);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const ctx = { cwd: home, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" } };
  const background = await execute("id", { name: "large", script: `return "😀".repeat(13000);` }, new AbortController().signal, undefined, ctx);
  assert.match(background.content[0]?.text ?? "", /"state":"running"/);
  await delivered;
  assert.equal(messages.length, 1);
  const descriptor = JSON.parse(messages[0]?.message.content ?? "null") as { state: string; runId: string; resultPath: string; resultBytes: number; inlined: boolean };
  assert.deepEqual({ state: descriptor.state, inlined: descriptor.inlined }, { state: "completed", inlined: false });
  assert.ok(descriptor.runId && descriptor.resultPath.endsWith("result.json") && descriptor.resultBytes > 50 * 1024);
  assert.doesNotMatch(messages[0]?.message.content ?? "", /😀/);
  assert.deepEqual(messages[0]?.options, { deliverAs: "followUp", triggerTurn: true });

  const foreground = await execute("foreground", { name: "inline", script: "return {ok:true};", foreground: true }, new AbortController().signal, undefined, ctx);
  assert.equal(foreground.content[0]?.text, "{\"ok\":true}");
  assert.deepEqual(foreground.details?.value, { ok: true });
  const foregroundRunId = foreground.details.runId;
  assert.ok(foregroundRunId);
  await waitForTurn();
  await waitForTurn();
  assert.equal(messages.length, 1);
  assert.deepEqual((await new RunStore(home, "session", foregroundRunId, home).load()).run.delivery, { mode: "foreground", state: "delivered", toolCallId: "foreground" });
  await toolResultHandler?.({ toolName: "workflow", toolCallId: "foreground", isError: false });
  assert.equal(messages.length, 1);

  const constrained = await execute("foreground-descriptor", { name: "constrained", script: `return "x".repeat(5000);`, foreground: true }, new AbortController().signal, undefined, { ...ctx, model: { ...ctx.model, contextWindow: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000 }) });
  const constrainedDescriptor = JSON.parse(constrained.content[0]?.text ?? "null") as { state: string; runId: string; resultPath: string; resultBytes: number; inlined: boolean };
  assert.equal(constrainedDescriptor.state, "completed");
  assert.equal(constrainedDescriptor.inlined, false);
  assert.ok(constrainedDescriptor.resultBytes > 5_000 && constrainedDescriptor.resultBytes <= 50 * 1024);
  assert.doesNotMatch(constrained.content[0]?.text ?? "", /x{100}/);
  await waitForTurn();
  await waitForTurn();
  assert.equal(messages.length, 1);
  assert.deepEqual((await new RunStore(home, "session", constrainedDescriptor.runId, home).load()).run.delivery, { mode: "foreground", state: "delivered", toolCallId: "foreground-descriptor" });
  await toolResultHandler?.({ toolName: "workflow", toolCallId: "foreground-descriptor", isError: false });
  assert.equal(messages.length, 1);
});

void test("attached foreground failure stays inline with diagnostics and sends no follow-up", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-attached-failure-delivery-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const messages: string[] = [];
  let toolResultHandler: ((event: { toolName: string; toolCallId: string; isError: boolean }) => Promise<unknown>) | undefined;
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {},
    on(name: string, handler: unknown) { if (name === "tool_result") toolResultHandler = handler as typeof toolResultHandler; },
    getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"],
    sendMessage(message: { content: string }) { messages.push(message.content); },
  };
  workflowExtension(testExtensionApi(pi), home);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };

  await assert.rejects(execute("attached-failure", { name: "attached-failure", script: `throw new Error("attached failure");`, foreground: true }, new AbortController().signal, undefined, context), WorkflowError);
  await waitForTurn();
  await waitForTurn();
  assert.deepEqual(messages, []);

  assert.ok(toolResultHandler);
  const patched = await toolResultHandler({ toolName: "workflow", toolCallId: "attached-failure", isError: true }) as { content: Array<{ text: string }>; details: { error?: { code: string; message: string }; run?: { delivery?: unknown } }; isError?: boolean };
  assert.equal(patched.isError, true);
  const diagnostic = JSON.parse(patched.content[0]?.text ?? "null") as { error: { code: string; message: string } };
  assert.equal(diagnostic.error.code, "INTERNAL_ERROR");
  assert.equal(diagnostic.error.message, "attached failure");
  assert.equal(patched.details.error?.code, "INTERNAL_ERROR");
  assert.deepEqual(patched.details.run?.delivery, { mode: "foreground", state: "delivered", toolCallId: "attached-failure" });
  assert.deepEqual(messages, []);
});


void test("does not undo a competing terminal failure delivery during stale suppression", async () => {
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
  const tools: Tool[] = [];
  const messages: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-competing-failure-delivery-"));
  workflowExtension(testExtensionApi({ registerTool(tool: Tool) { tools.push(tool); }, registerCommand() {}, on() {}, sendMessage(message: { content: string }) { messages.push(message.content); }, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const load = Object.getOwnPropertyDescriptor(RunStore.prototype, "load")?.value as RunStore["load"];
  const restoreLoad = () => { RunStore.prototype.load = load; };
  let injected = false;
  let markInjected!: () => void;
  const injection = new Promise<void>((resolve) => { markInjected = resolve; });
  RunStore.prototype.load = async function () {
    const loaded = await load.call(this);
    if (!injected && this.cwd === home && loaded.run.state === "failed" && loaded.run.delivery?.state === "delivered") {
      injected = true;
      markInjected();
      await new RunStore(this.cwd, this.sessionId, this.runId, this.home).updateState((current) => ({ ...current, state: "failed", ...(current.delivery ? { delivery: { ...current.delivery, state: "delivered" } } : {}) }));
      return { ...loaded, run: { ...loaded.run, state: "running" } };
    }
    return loaded;
  };
  try {
    const result = await workflow.execute("competing-failure", { name: "competing-failure", script: `throw new Error("competing failure");` }, new AbortController().signal, undefined, context) as { details: { runId: string } };
    await Promise.race([injection, new Promise((resolve) => setTimeout(resolve, 1000))]);
    assert.equal(injected, true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(messages, []);
    assert.equal((await new RunStore(home, "session", result.details.runId, home).load()).run.delivery?.state, "delivered");
  } finally {
    restoreLoad();
  }
});

void test("delivers a later cold-resume failure after an earlier failure follow-up", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-resumed-failure-delivery-"));
  const store = new RunStore(home, "session", "run", home);
  await store.create({ id: "run", workflowName: "resumed-failure", cwd: home, sessionId: "session", state: "budget_exhausted", agents: [], agentSessions: [], delivery: { mode: "background", state: "delivered" } }, createLaunchSnapshot({ script: `throw new Error("resumed failure");`, args: null, metadata: { name: "resumed-failure" }, launchMode: "background", settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const messages: string[] = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, sendMessage(message: { content: string }) { messages.push(message.content); }, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  const context = { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  try {
    assert.ok(start);
    await start({}, context);
    const resume = tools.find(({ name }) => name === "workflow_resume");
    assert.ok(resume);
    await resume.execute("id", { runId: "run" }, undefined, undefined, context);
    for (let attempt = 0; attempt < 100 && messages.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(messages.filter((message) => message.startsWith("Workflow resumed-failure failed")).length, 1);
  } finally {
    await shutdown?.();
  }
});
void test("human interrupted-run resume delivers a later failure", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-human-resume-failure-delivery-"));
  const store = new RunStore(home, "session", "run", home);
  await store.create({ id: "run", workflowName: "human-resume-failure", cwd: home, sessionId: "session", state: "interrupted", agents: [], agentSessions: [], delivery: { mode: "background", state: "delivered" } }, createLaunchSnapshot({ script: `throw new Error("human resumed failure");`, args: null, metadata: { name: "human-resume-failure" }, launchMode: "background", settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  const messages: string[] = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, sendMessage(message: { content: string }) { messages.push(message.content); }, getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"] }), home);
  const context = { cwd: home, hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { select: async (_prompt: string, options: string[]) => options[0], notify() {} } };
  try {
    assert.ok(start);
    await start({}, context);
    for (let attempt = 0; attempt < 100 && messages.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(messages.filter((message) => message.startsWith("Workflow human-resume-failure failed")).length, 1);
  } finally {
    await shutdown?.();
  }
});
void test("foreground workflow logs stay in the live workflow item", async () => {
  type LogData = { workflowName: string; message: string };
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-foreground-log-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const entries: Array<{ type: string; data: LogData }> = [];
  const updates: Array<{ details: { run: { events?: readonly { type: string; message: string; timestamp?: number }[] } } }> = [];
  workflowExtension(testExtensionApi({
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {},
    appendEntry(type: string, data: LogData) { entries.push({ type, data }); },
    getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"],
  }), home);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const result = await execute("id", { name: "logger", script: `await log("working"); await log("working"); return true;`, foreground: true }, new AbortController().signal, (update: (typeof updates)[number]) => { updates.push(update); }, { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }) as { details: { run: { events?: readonly { type: string; message: string; timestamp?: number }[] } } };
  assert.equal(entries.length, 0);
  const logs = result.details.run.events?.filter((event) => event.type === "log") ?? [];
  assert.equal(logs.length, 2);
  const firstLog = logs[0];
  const secondLog = logs[1];
  assert.ok(firstLog);
  assert.ok(secondLog);
  assert.equal(firstLog.message, "working");
  assert.equal(secondLog.message, "working");
  assert.equal(typeof firstLog.timestamp, "number");
  assert.ok(updates.some(({ details }) => details.run.events?.length === 2));
});
void test("foreground workflow failure keeps logs in the workflow item", async () => {
  type FailureResult = { details?: { run?: { events?: readonly { type: string; message: string }[] } } };
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-foreground-failure-log-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let toolResultHandler: ((event: { toolName: string; toolCallId: string; isError: boolean }) => Promise<unknown>) | undefined;
  workflowExtension(testExtensionApi({
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "tool_result") toolResultHandler = handler as typeof toolResultHandler; },
    getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"],
  }), home);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  await assert.rejects(execute("failure", { name: "failure", script: `await log("before failure"); throw new Error("failure");`, foreground: true }, new AbortController().signal, () => {}, { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }));
  assert.ok(toolResultHandler);
  const result = await toolResultHandler({ toolName: "workflow", toolCallId: "failure", isError: true }) as FailureResult;
  assert.deepEqual(result.details?.run?.events?.filter((event) => event.type === "log").map((event) => event.message), ["before failure"]);
});
void test("background workflow logs persist and append capped TUI transcript entries", async () => {
  type LogData = { workflowName: string; message: string };
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-log-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const entries: Array<{ type: string; data: LogData }> = [];
  let renderer: ((entry: { data?: LogData }, options: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
  workflowExtension(testExtensionApi({
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {},
    registerEntryRenderer(type: string, candidate: NonNullable<typeof renderer>) { if (type === "workflow-log") renderer = candidate; },
    appendEntry(type: string, data: LogData) { entries.push({ type, data }); },
    getThinkingLevel: () => "medium" as const, getActiveTools: () => ["workflow"],
  }), home);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  await execute("id", { name: "logger", script: `await log("working"); await log("😀".repeat(2000)); return true;`, foreground: false }, new AbortController().signal, undefined, { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  await waitForIssue105(() => entries.length >= 2);
  assert.equal(entries.length, 2);
  const runId = (await listRunIds(home, "session", home))[0];
  assert.ok(runId);
  const persisted = await new RunStore(home, "session", runId, home).loadStatus();
  const logs = persisted.events?.filter((event) => event.type === "log") ?? [];
  const firstLog = logs[0];
  assert.ok(firstLog);
  assert.equal(firstLog.message, "working");
  assert.equal(typeof firstLog.timestamp, "number");
  assert.equal(logs.length, 2);
  assert.deepEqual(entries[0], { type: "workflow-log", data: { workflowName: "logger", message: "working" } });
  const truncated = entries[1];
  assert.ok(truncated);
  assert.ok(Buffer.byteLength(truncated.data.message) <= 4096);
  assert.doesNotMatch(truncated.data.message, /�/);
  assert.ok(renderer);
  assert.equal(renderer({ data: entries[0].data }, {}, {}).render(100).join("\n"), "Workflow logger: working");
});
