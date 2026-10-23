import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import workflowExtension, { widgetAgentsOpener } from "../src/host.js";
import { createLaunchSnapshot, DEFAULT_SETTINGS, RunStore } from "../src/index.js";
import { WORKFLOW_AGENT_STATE_CHANGED_EVENT, WORKFLOW_PHASE_CHANGED_EVENT, WORKFLOW_RUN_STARTED_EVENT, WORKFLOW_RUN_STATE_CHANGED_EVENT } from "../src/types.js";
import { executeCommand, testExtensionApi } from "./support.js";
import { leave, open as openHarness, settle, sidebarRows, title } from "./agents-workspace-harness.js";
import { loadingRegistry } from "../src/registry.js";
import { clearSubagentManager, setSubagentManager } from "../src/subagent-manager-handle.js";
import type { SessionAgentsSource } from "../src/session-agents.js";
import type { SubagentManager, SubagentStatus } from "../subagents/src/contracts.js";

// The opener runs on a later tick (a session lease on disk first): wait for its call, not for a fixed time.
function openerCall(): { call: () => void; wait: (message: string) => Promise<void> } {
  let call = (): void => {};
  const called = new Promise<void>((resolve) => { call = resolve; });
  const wait = (message: string): Promise<void> => Promise.race([called, new Promise<never>((_, reject) => { setTimeout(() => { reject(new Error(message)); }, 10_000).unref(); })]);
  return { call, wait };
}

void test("the widget's opener opens the workspace on the node key with the widget's own session context, in the TUI only", () => {
  const seen: Array<[ExtensionContext, string]> = [];
  // A session_start context: no command ran, so it has none of a command context's session controls.
  const plain = { mode: "tui", hasUI: true } as unknown as ExtensionContext;
  const opener = widgetAgentsOpener(async (ctx, key) => { seen.push([ctx, key]); });
  assert.equal(opener.available(plain), true);
  opener.open(plain, "run:r1:node:phase/p%231");
  assert.deepEqual(seen, [[plain, "run:r1:node:phase/p%231"]]);
  assert.equal(opener.available({ mode: "print", hasUI: false } as unknown as ExtensionContext), false, "nothing opens outside the TUI");
});

void test("in a session where no command ran, Enter in the widget opens the workspace on the row", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-widget-opener-"));
  try {
    const cwd = join(home, "project");
    mkdirSync(cwd);
    const model = { provider: "openai", model: "gpt" };
    const agents = [{ id: "a1", name: "scout", path: "a1", state: "running", model, tools: [], attempts: 1, attemptDetails: [] }];
    const phaseHistory = Array.from({ length: 10 }, (_, index) => ({ phase: `p${String(index)}`, afterAgent: index === 0 ? 0 : 1 }));
    const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "widget" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [] });
    const store = new RunStore(cwd, "session", "run", home);
    await store.create({ id: "run", workflowName: "widget", cwd, sessionId: "session", state: "running", agents, agentSessions: [], phaseHistory } as never, snapshot);

    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const listeners = new Map<string, Array<(event: unknown) => void>>();
    const opened: Array<[unknown, string | undefined]> = [];
    const opener = openerCall();
    workflowExtension(testExtensionApi({
      registerCommand() {},
      registerTool() {},
      on(name: string, handler: unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler as (event: unknown, ctx: unknown) => unknown]); },
      registerEntryRenderer() {},
      registerShortcut() {},
      events: {
        on: ((name: string, listener: (event: unknown) => void) => { listeners.set(name, [...(listeners.get(name) ?? []), listener]); return () => {}; }),
        emit: ((name: string, event: unknown) => { for (const listener of listeners.get(name) ?? []) listener(event); }),
      },
    }), home, undefined, undefined, join(home, "agent"), [], async (ctx, options) => { opened.push([ctx, options.initialKey]); opener.call(); return undefined; });

    const inputs: Array<(data: string) => { consume?: boolean } | undefined> = [];
    const ui = {
      notify() {},
      // Pi draws a widget factory when it paints and again on each render request; the widget learns its rows from those draws.
      setWidget(_key: string, value: unknown) {
        if (typeof value !== "function") return;
        const tui = { requestRender: () => { component.render(100); } };
        const component = (value as (tui: object, theme: object) => { render(width: number): string[] })(tui, { fg: (_c: string, t: string) => t, bold: (t: string) => t, bg: (_c: string, t: string) => t });
        component.render(100);
      },
      onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => { inputs.push(handler); return () => {}; },
    };
    // The context Pi hands session_start: no waitForIdle or other command-only member.
    const session = { cwd, mode: "tui", hasUI: true, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "session", getEntries: () => [] }, ui };
    const key = (data: string): boolean => inputs.some((handler) => handler(data)?.consume === true);
    for (const handler of handlers.get("session_start") ?? []) await handler(undefined, session);
    for (const listener of listeners.get(WORKFLOW_RUN_STARTED_EVENT) ?? []) listener({ runId: "run", runDirectory: store.directory, sessionId: "session" });

    assert.equal(key("\u001bo"), true, "the widget scrolls");
    assert.equal(key("\r"), true);
    await opener.wait("the workspace opens on the row with the widget's own context");
    assert.deepEqual(opened, [[session, "run:run"]], "the workspace opens on the row with the widget's own context");
    for (const handler of handlers.get("session_shutdown") ?? []) await handler(undefined, session);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

void test("a background subagent status the host observes reaches the widget; enter on its row opens /agents on it, and that workspace selects its node", async (t) => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-widget-subagents-"));
  const ids = Array.from({ length: 9 }, (_, index) => `sub-${String(index)}`);
  const status = (id: string): SubagentStatus => ({ id, sessionId: "session", state: "running", startedAt: Date.now() - 1_000, progress: { lastEventAt: Date.now(), toolCalls: [], accounting: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 } } });
  const manager = { inspect: async (params: { id?: string }) => params.id === undefined ? ids.map(status) : status(params.id) } as unknown as SubagentManager;
  setSubagentManager(manager);
  try {
    const cwd = join(home, "project");
    mkdirSync(cwd);
    const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
    const opened: Array<{ initialKey: string | undefined; agents: SessionAgentsSource }> = [];
    const opener = openerCall();
    workflowExtension(testExtensionApi({
      registerCommand() {},
      registerTool() {},
      on(name: string, handler: unknown) { handlers.set(name, [...(handlers.get(name) ?? []), handler as (event: unknown, ctx: unknown) => unknown]); },
      registerEntryRenderer() {},
      registerShortcut() {},
      events: { on: () => () => {}, emit: () => {} },
    }), home, undefined, undefined, join(home, "agent"), [], async (_ctx, options) => { opened.push({ initialKey: options.initialKey, agents: options.agents }); opener.call(); return undefined; });
    const inputs: Array<(data: string) => { consume?: boolean } | undefined> = [];
    const drawn = { lines: [] as string[] };
    const ui = {
      notify() {},
      setWidget(_key: string, value: unknown) {
        if (typeof value !== "function") { drawn.lines = []; return; }
        const tui = { requestRender: () => { drawn.lines = component.render(100); } };
        const component = (value as (tui: object, theme: object) => { render(width: number): string[] })(tui, { fg: (_c: string, text: string) => text, bold: (text: string) => text, bg: (_c: string, text: string) => text });
        drawn.lines = component.render(100);
      },
      onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined) => { inputs.push(handler); return () => {}; },
    };
    const session = { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session", getEntries: () => [] }, ui };
    const key = (data: string): boolean => inputs.some((handler) => handler(data)?.consume === true);
    for (const handler of handlers.get("session_start") ?? []) await handler(undefined, session);
    assert.equal(drawn.lines.length, 0, "nothing runs yet");

    loadingRegistry().observeSubagentStatus(status("sub-0"), { prompt: "work", mode: "background", label: "alpha" });
    assert.ok(drawn.lines.some((line) => line.includes("Subagents")) && drawn.lines.some((line) => line.includes("alpha")), drawn.lines.join("\n"));
    loadingRegistry().observeSubagentStatus(status("fg"), { prompt: "work", mode: "foreground", label: "fore" });
    assert.ok(!drawn.lines.some((line) => line.includes("fore")), "a foreground subagent stays out of the widget");
    for (const id of ids.slice(1)) loadingRegistry().observeSubagentStatus(status(id), { prompt: "work", mode: "background", label: id });

    assert.equal(key("\u001bo"), true, "the tree is taller than the frame, so the widget scrolls");
    for (let press = 0; press < 20; press += 1) key("j");
    key("\r");
    await opener.wait("enter on the row opens the workspace");
    assert.deepEqual(opened.map((entry) => entry.initialKey), ["subagent:sub-8"]);

    const reopened = opened[0];
    assert.ok(reopened?.initialKey);
    t.mock.timers.enable({ apis: ["setInterval"] });
    const workspace = await openHarness([], { source: reopened.agents, initialKey: reopened.initialKey });
    await settle();
    assert.match(title(workspace), /sub-8/, workspace.screen().join("\n"));
    assert.ok(sidebarRows(workspace).some((row) => row.startsWith("→") && row.includes("sub-8")), sidebarRows(workspace).join("\n"));
    await leave(workspace);
    for (const handler of handlers.get("session_shutdown") ?? []) await handler(undefined, session);
  } finally {
    clearSubagentManager(manager);
    rmSync(home, { recursive: true, force: true });
  }
});

void test("the workspace /agents opens hears this Pi's run events and subagent statuses until it stops listening", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-widget-changes-"));
  try {
    const cwd = join(home, "project");
    mkdirSync(cwd);
    const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "done" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [] });
    await new RunStore(cwd, "session", "run", home).create({ id: "run", workflowName: "done", cwd, sessionId: "session", state: "completed", agents: [], agentSessions: [] } as never, snapshot);
    const bus = new Map<string, Set<(event: unknown) => void>>();
    const emit = (name: string): void => { for (const listener of bus.get(name) ?? []) listener({}); };
    let agents: ((args: string, ctx: unknown) => Promise<void>) | undefined;
    let changes: ((listener: () => void) => () => void) | undefined;
    workflowExtension(testExtensionApi({
      registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => Promise<void> }) { if (name === "agents") agents = options.handler; },
      registerTool() {},
      events: {
        on: ((name: string, listener: (event: unknown) => void) => { const listeners = bus.get(name) ?? new Set(); listeners.add(listener); bus.set(name, listeners); return () => { listeners.delete(listener); }; }),
        emit: ((name: string) => { emit(name); }),
      },
    }), home, undefined, undefined, join(home, "agent"), [], async (_ctx, options) => { changes = options.changes; return undefined; });
    await executeCommand(agents, "", { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" }, ui: { notify() {}, setStatus() {} } });
    assert.ok(changes, "the workspace gets the host's changes");
    let heard = 0;
    const stop = changes(() => { heard += 1; });
    const events = [WORKFLOW_RUN_STARTED_EVENT, WORKFLOW_RUN_STATE_CHANGED_EVENT, WORKFLOW_AGENT_STATE_CHANGED_EVENT, WORKFLOW_PHASE_CHANGED_EVENT];
    for (const name of events) emit(name);
    assert.equal(heard, 4, "a run started, a run state, an agent state and a phase");
    loadingRegistry().observeSubagentStatus({ id: "sub", sessionId: "session", state: "running", startedAt: Date.now() }, { prompt: "work", mode: "background" });
    assert.equal(heard, 5, "a subagent status");
    stop();
    for (const name of events) emit(name);
    loadingRegistry().observeSubagentStatus({ id: "sub", sessionId: "session", state: "completed", startedAt: Date.now() }, { prompt: "work", mode: "background" });
    assert.equal(heard, 5, "nothing once it stopped listening");
    assert.ok([...bus.values()].every((listeners) => listeners.size === 0), "and it left the bus as it found it");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
