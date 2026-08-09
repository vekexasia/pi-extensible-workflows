import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import widget, { renderReceipt, __navigationForTests } from "../dist/index.js";
import { RunStore } from "pi-extensible-workflows/persistence";
import {
  WORKFLOW_AGENT_STATE_CHANGED_EVENT,
  WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT,
  WORKFLOW_RUN_COMPLETED_EVENT,
  WORKFLOW_RUN_FAILED_EVENT,
  WORKFLOW_RUN_STARTED_EVENT,
  WORKFLOW_RUN_STATE_CHANGED_EVENT,
} from "pi-extensible-workflows";

// Stands in for Pi's theme. `bg` wraps rather than colours so a test can see
// which row was highlighted without matching escape codes.
const theme = {
  // Real themes emit a colour and a full reset; the reset is what used to eat
  // the selection background, so the stand-in reproduces it.
  fg: (_colour, text) => `\u001b[38;5;12m${text}\u001b[0m`,
  bold: (text) => text,
  bg: (_colour, text) => `\u0001${text}\u0001`,
};

/** Width the harness renders at, standing in for the terminal. */
const WIDTH = 78;

/** Strips ANSI colour codes so assertions read against plain text. */
// eslint-disable-next-line no-control-regex
const plain = (line) => line.replace(/\x1b\[[0-9;]*m/g, "");

function writeRun(directory, state) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "state.json"), JSON.stringify(state));
  return directory;
}

function runState(overrides = {}) {
  return {
    id: "run-1",
    workflowName: "smoke",
    sessionId: "session-1",
    state: "running",
    phase: "llm",
    phaseHistory: [{ phase: "shell", afterAgent: 0 }, { phase: "llm", afterAgent: 0 }],
    agents: [{
      name: "scout",
      role: "scout",
      requestedModel: "scout-model",
      state: "running",
      startedAt: Date.now() - 42_000,
      tools: ["read", "grep"],
      model: { model: "fixture-model", thinking: "medium" },
      accounting: { input: 44_000, output: 700, cacheRead: 200_000, cost: 0.056 },
    }],
    usage: { tokens: 44_700, costUsd: 0.056 },
    ...overrides,
  };
}

/** A stand-in for the extension host, capturing everything the widget draws. */
function harness(sessionId = "session-1", options = {}) {
  let sessionEntries = options.entries ?? [];
  const handlers = new Map();
  const events = new Map();
  const frames = [];
  const widgets = [];
  const entries = [];
  const placements = [];
  const shortcuts = new Map();
  // Stands in for Pi's TUI. At rest the editor holds focus; a picker moves it
  // and an overlay is flagged outright.
  // Recognised by what it can do, not by its class: a widget installed beside
  // Pi may hold a second copy of the TUI package, and `instanceof` then fails
  // for the very editor it is asked about.
  const editor = { getText: () => "", addToHistory: () => {} };
  const tui = {
    hasOverlay: () => tui.overlay,
    getFocusedComponent: () => tui.focus,
    overlay: false,
    focus: editor,
    openMenu: () => { tui.focus = { name: "picker" }; },
    closeMenu: () => { tui.focus = editor; },
  };
  const inputHandlers = [];
  let editorText = "";
  let renderer;

  const pi = {
    on: (name, handler) => { handlers.set(name, handler); },
    events: {
      on: (name, handler) => {
        events.set(name, [...(events.get(name) ?? []), handler]);
        return () => { events.set(name, (events.get(name) ?? []).filter((h) => h !== handler)); };
      },
    },
    appendEntry: (customType, data) => { entries.push({ customType, data }); },
    registerEntryRenderer: (customType, fn) => { renderer = { customType, fn }; },
    registerShortcut: (shortcut, options) => { shortcuts.set(shortcut, options); },
  };

  const context = {
    hasUI: true,
    cwd: options.cwd,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => sessionEntries },
    // The widget registers a factory so it is built at the width the TUI is
    // about to draw with. Render it the way the host does, at a fixed width.
    ui: {
      setWidget: (_key, value, options) => {
        widgets.push(value);
        placements.push(options?.placement);
        frames.push(typeof value === "function" ? value(tui, theme).render(WIDTH) : value);
      },
      onTerminalInput: (handler) => {
        inputHandlers.push(handler);
        return () => { inputHandlers.splice(inputHandlers.indexOf(handler), 1); };
      },
      getEditorText: () => editorText,
    },
  };

  widget(pi);
  return {
    context,
    frames,
    widgets,
    placements,
    entries,
    tui,
    shortcuts,
    setEditorText: (text) => { editorText = text; },
    // Feed a keystroke the way the host does: every handler sees it until one
    // claims it.
    key: (data) => {
      for (const handler of inputHandlers) {
        const result = handler(data);
        if (result?.consume) return true;
      }
      return false;
    },
    get renderer() { return renderer; },
    setEntries: (entries) => { sessionEntries = entries; },
    reload: () => handlers.get("session_start")(undefined, context),
    start: () => handlers.get("session_start")(undefined, context),
    shutdown: () => handlers.get("session_shutdown")(undefined, context),
    emit: (name, event) => { for (const handler of events.get(name) ?? []) handler(event); },
  };
}

void test("draws a tree for a live run and clears it once the run is over", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-live-"));
  const directory = writeRun(join(root, "run-1"), runState());
  const host = harness();
  host.start();

  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

  const frame = host.frames.at(-1);
  assert.ok(Array.isArray(frame), "a live run is drawn");
  const body = frame.map(plain).join("\n");
  assert.match(body, /smoke/);
  assert.match(body, /shell/);
  assert.match(body, /scout/);
  assert.match(body, /fixture-model:medium/);

  writeRun(directory, runState({ state: "completed", agents: [] }));
  host.emit(WORKFLOW_AGENT_STATE_CHANGED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  assert.equal(host.frames.at(-1), undefined, "a finished run leaves the widget at once");

  host.shutdown();
});

void test("isolates malformed state from healthy runs", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-malformed-state-"));
  const healthy = writeRun(join(root, "healthy"), runState({ id: "healthy", workflowName: "healthy" }));
  const malformed = writeRun(join(root, "malformed"), runState({ id: "malformed", workflowName: "malformed", agents: [null] }));
  const host = harness();
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "healthy", runDirectory: healthy, sessionId: "session-1" });
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "malformed", runDirectory: malformed, sessionId: "session-1" });

  assert.match(host.frames.at(-1).map(plain).join("\n"), /healthy/);
  assert.doesNotMatch(host.frames.at(-1).map(plain).join("\n"), /malformed/);
  host.shutdown();
});

void test("paused and resumable run states use non-running glyphs", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-status-glyphs-"));
  const host = harness();
  host.start();
  for (const state of ["paused", "awaiting_input", "interrupted", "budget_exhausted"]) {
    const directory = writeRun(join(root, state), runState({ id: state, workflowName: state, state }));
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: state, runDirectory: directory, sessionId: "session-1" });
    const header = host.frames.at(-1).map(plain).find((line) => line.includes(` ${state} `));
    assert.ok(header);
    const expected = state === "budget_exhausted" ? "✗" : "·";
    assert.match(header, new RegExp(`${expected} ${state} `), `${state} is not active`);
    assert.doesNotMatch(header, /[⣷⣯⣟⡿⢿⣽⣻]/, `${state} does not spin`);
  }

  const budgetHeader = host.frames.at(-1).map(plain).find((line) => line.includes(" budget_exhausted "));
  assert.match(budgetHeader, /✗ budget_exhausted /);
  host.shutdown();
});

void test("live per-agent totals exclude cache-write tokens", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-token-total-"));
  const directory = writeRun(join(root, "run-1"), runState({
    agents: [{ ...runState().agents[0], accounting: { input: 10, output: 5, cacheRead: 20, cacheWrite: 10_000, cost: 0.01 } }],
    usage: { tokens: 15, costUsd: 0.01 },
  }));
  const host = harness();
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

  const body = host.frames.at(-1).map(plain).join("\n");
  assert.match(body, /fixture-model:medium · 15t/);
  assert.doesNotMatch(body, /fixture-model:medium · 10\.0kt/);
  host.shutdown();
});

void test("ignores checkpoint events from another session and refreshes missing runs", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-checkpoint-scope-"));
  const directory = writeRun(join(root, "run-1"), runState());
  const host = harness();
  host.start();
  host.emit(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "other", name: "foreign", state: "awaiting" });
  assert.ok(host.frames.every((frame) => frame === undefined));

  host.emit(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1", name: "local", state: "awaiting" });
  assert.match(host.frames.at(-1).map(plain).join("\n"), /waiting: local/);
  host.shutdown();
});

void test("a render failure is cleared on the next tick", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-render-cleanup-"));
  const directory = writeRun(join(root, "run-1"), runState());
  const host = harness();
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  const factory = host.widgets.at(-1);
  const broken = factory(host.tui, { ...theme, fg: () => { throw new Error("render failed"); } });
  assert.deepEqual(broken.render(WIDTH), []);

  host.emit(WORKFLOW_AGENT_STATE_CHANGED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  assert.equal(host.widgets.at(-1), undefined, "the empty factory is unregistered");
  host.shutdown();
});

void test("ignores runs belonging to another session", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-scope-"));
  const directory = writeRun(join(root, "run-1"), runState({ sessionId: "other" }));
  const host = harness("session-1");
  host.start();

  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "other" });
  assert.ok(host.frames.every((frame) => frame === undefined), "another session's run is not drawn");

  host.shutdown();
});

void test("writes one receipt per run, however many events arrive", async () => {
  const root = mkdtempSync(join(tmpdir(), "widget-receipt-"));
  const directory = writeRun(join(root, "run-1"), runState({
    state: "completed",
    agents: [{ ...runState().agents[0], state: "completed", durationMs: 62_000 }],
    usage: { tokens: 61_229, costUsd: 0.0857, durationMs: 82_529 },
  }));
  const host = harness();
  host.start();

  host.emit(WORKFLOW_RUN_COMPLETED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  host.emit(WORKFLOW_RUN_COMPLETED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  await new Promise((resolve) => globalThis.setTimeout(resolve, 250));

  assert.equal(host.entries.length, 1, "the run is recorded once");
  assert.equal(host.entries[0].data.runId, "run-1");
  assert.equal(host.entries[0].data.tokens, 61_229);
  assert.equal(host.entries[0].data.agents[0].cacheRead, 200_000);

  host.shutdown();
});

void test("the receipt shows phases, per-agent models, effort and the token split", () => {
  const lines = renderReceipt({
    runId: "run-1",
    workflow: "deliver",
    state: "failed",
    costUsd: 0.4,
    tokens: 128_000,
    durationMs: 96_000,
    phases: ["scout", "review"],
    phaseBoundaries: [0, 1],
    agents: [
      { name: "scout", state: "completed", model: "fixture-model:high", role: "scout", requestedModel: "scout-model", toolCalls: 31, input: 30_000, output: 900, cacheRead: 80_000, costUsd: 0.09, durationMs: 31_000, attempts: 1 },
      { name: "reviewer", state: "failed", model: "fixture-model:xhigh", role: "reviewer", toolCalls: 1, input: 50_000, output: 200, cacheRead: 120_000, costUsd: 0.31, durationMs: 15_000, attempts: 3 },
    ],
    error: "reviewer was interrupted before it answered",
  }, false, theme);

  const body = lines.join("\n");
  assert.match(body, /deliver/);
  assert.match(body, /scout/);
  assert.match(body, /review/);
  assert.match(body, /role scout · via scout-model · 31 calls/);
  assert.match(body, /role reviewer · 1 call/, "one call is not pluralised");
  assert.match(body, /in 30kt · out 900t · cache 80kt/);
  assert.match(body, /3 attempts/, "a retried agent says so");
  assert.match(body, /interrupted before it answered/);
  assert.doesNotMatch(body, /run-1/, "the run id stays hidden until expanded");

  assert.match(renderReceipt({
    runId: "run-1", workflow: "smoke", state: "completed", costUsd: 0, tokens: 0, durationMs: 0,
    phases: [], phaseBoundaries: [], agents: [],
  }, true, theme).join("\n"), /run run-1/);
});

void test("resumable runs stay visible until a later terminal state", async () => {
  const root = mkdtempSync(join(tmpdir(), "widget-resumable-"));
  const host = harness();
  host.start();
  const directories = new Map();
  for (const [index, state] of ["interrupted", "budget_exhausted"].entries()) {
    const id = `run-${String(index)}`;
    const directory = writeRun(join(root, id), runState({ id, state, workflowName: state }));
    directories.set(id, directory);
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: id, runDirectory: directory, sessionId: "session-1" });
  }
  await new Promise((resolve) => globalThis.setTimeout(resolve, 150));
  assert.equal(host.entries.length, 0);
  assert.match(host.frames.at(-1).map(plain).join("\n"), /interrupted|budget_exhausted/);

  const directory = directories.get("run-0");
  writeRun(directory, runState({ id: "run-0", state: "completed", workflowName: "interrupted" }));
  host.emit(WORKFLOW_RUN_STATE_CHANGED_EVENT, { runId: "run-0", runDirectory: directory, sessionId: "session-1", state: "completed" });
  assert.equal(host.entries.length, 0, "the state event alone is not the completion receipt");
  host.emit(WORKFLOW_RUN_COMPLETED_EVENT, { runId: "run-0", runDirectory: directory, sessionId: "session-1" });
  await new Promise((resolve) => globalThis.setImmediate(resolve));
  assert.equal(host.entries.length, 1);
  assert.equal(host.entries[0].data.state, "completed");
  host.shutdown();
});

void test("failed receipts fall back to a failed attempt error", async () => {
  const root = mkdtempSync(join(tmpdir(), "widget-attempt-error-"));
  const host = harness();
  host.start();
  const base = runState().agents[0];
  const directory = writeRun(join(root, "run-1"), runState({
    state: "failed",
    agents: [{
      ...base,
      state: "failed",
      attemptDetails: [{
        attempt: 1,
        transport: "local",
        accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        setup: { model: { provider: "fixture", model: "model" }, tools: [], hookNames: [], cwd: root },
        error: { code: "AGENT_FAILED", message: "attempt error" },
      }],
    }],
  }));
  host.emit(WORKFLOW_RUN_FAILED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  await new Promise((resolve) => globalThis.setTimeout(resolve, 150));
  assert.equal(host.entries[0].data.error, "attempt error");
  host.shutdown();
});

void test("failed receipts use stable persisted and attempt errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "widget-failure-"));
  const host = harness();
  host.start();
  const directory = writeRun(join(root, "run-1"), runState());
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  writeRun(directory, runState({
    state: "failed",
    error: { code: "AGENT_FAILED", message: "persisted error" },
    agents: [{ ...runState().agents[0], state: "failed", attemptDetails: [{ attempt: 1, setup: { model: { provider: "fixture", model: "model" }, tools: [], hookNames: [], cwd: root }, transport: "local", accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, error: { code: "AGENT_FAILED", message: "attempt error" } }] }],
  }));
  host.emit(WORKFLOW_RUN_FAILED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1", error: { code: "AGENT_FAILED", message: "event error" } });
  assert.equal(host.entries.length, 1);
  assert.equal(host.entries[0].data.error, "persisted error");
  host.shutdown();
});

void test("receipts retain unphased nested agents and granted tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "widget-unphased-"));
  const base = runState().agents[0];
  const directory = writeRun(join(root, "run-1"), runState({
    state: "completed",
    phaseHistory: [],
    agents: [
      { ...base, id: "parent", name: "parent", state: "completed", tools: ["read", "grep"] },
      { ...base, id: "child", name: "child", parentId: "parent", state: "completed", tools: ["find"], attemptDetails: [{ session: { locator: { sessionFile: join(root, "missing.jsonl") } }, error: { code: "AGENT_FAILED", message: "attempt error" } }] },
    ],
  }));
  const host = harness();
  host.start();
  host.emit(WORKFLOW_RUN_COMPLETED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  await new Promise((resolve) => globalThis.setTimeout(resolve, 150));
  const receipt = host.entries[0].data;
  assert.deepEqual(receipt.phases, ["unphased"]);
  assert.deepEqual(receipt.phaseBoundaries, [0]);
  assert.deepEqual(receipt.agents.map(({ name, parentId, tools, toolCalls }) => ({ name, parentId, tools, toolCalls })), [
    { name: "parent", parentId: undefined, tools: ["read", "grep"], toolCalls: undefined },
    { name: "child", parentId: "parent", tools: ["find"], toolCalls: undefined },
  ]);
  const body = renderReceipt(receipt, false, theme).map(plain).join("\n");
  assert.ok(body.indexOf("parent") < body.indexOf("child"));
  assert.match(body, /read grep/);
  assert.match(body, /find/);
  host.shutdown();
});

void test("reload reconciles on-disk runs and recovers missed receipts", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "widget-reload-cwd-"));
  const background = new RunStore(cwd, "session-1", "reload-background");
  const foreground = new RunStore(cwd, "session-1", "reload-foreground");
  writeRun(background.directory, runState({ id: "reload-background", workflowName: "recovered", cwd, delivery: { mode: "background", state: "pending" } }));
  writeRun(foreground.directory, runState({ id: "reload-foreground", workflowName: "foreground", cwd, delivery: { mode: "foreground", state: "attached" } }));
  const host = harness("session-1", { cwd });
  host.start();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 150));
  assert.match(host.frames.at(-1).map(plain).join("\n"), /recovered/);
  assert.doesNotMatch(host.frames.at(-1).map(plain).join("\n"), /foreground/);

  writeRun(background.directory, runState({ id: "reload-background", workflowName: "recovered", cwd, state: "completed", delivery: { mode: "background", state: "pending" } }));
  host.reload();
  await new Promise((resolve) => globalThis.setTimeout(resolve, 150));
  assert.equal(host.entries.length, 1);
  assert.equal(host.entries[0].data.runId, "reload-background");
  host.shutdown();
  rmSync(background.directory, { recursive: true, force: true });
  rmSync(foreground.directory, { recursive: true, force: true });
});

void test("the border lines up at every width the TUI asks for", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-width-"));
  const directory = writeRun(join(root, "run-1"), runState());
  const host = harness();
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

  const factory = host.widgets.at(-1);
  assert.equal(typeof factory, "function", "the widget is registered as a factory");

  // The frame is built at whatever width the TUI is about to draw with, which
  // is the only number that agrees with the check Pi runs on the result.
  const component = factory();
  for (const width of [40, 60, 81, 110, 165]) {
    const widths = new Set(component.render(width).map((line) => plain(line).length));
    assert.deepEqual([...widths], [width], `a ${width}-column draw produces ${width}-wide rows`);
  }

  host.shutdown();
});


void test("a second instance starting and stopping leaves the first one working", async () => {
  const root = mkdtempSync(join(tmpdir(), "widget-coexist-"));
  const directory = writeRun(join(root, "run-1"), runState({
    state: "completed",
    agents: [{ ...runState().agents[0], state: "completed", durationMs: 1_000 }],
    usage: { tokens: 100, costUsd: 0.01, durationMs: 1_000 },
  }));

  // An agent pane boots its own extension host inside the same process: a
  // second instance loads, runs a whole session, and shuts down again while
  // the first one is still driving the visible widget.
  const bus = new Map();
  const entries = [];
  const load = () => {
    const handlers = new Map();
    widget({
      on: (name, handler) => { handlers.set(name, handler); },
      events: {
        on: (name, handler) => {
          bus.set(name, [...(bus.get(name) ?? []), handler]);
          return () => { bus.set(name, (bus.get(name) ?? []).filter((h) => h !== handler)); };
        },
      },
      appendEntry: (customType, data) => { entries.push({ customType, data }); },
      registerEntryRenderer: () => {},
      registerShortcut: () => {},
    });
    handlers.get("session_start")(undefined, {
      hasUI: true,
      sessionManager: { getSessionId: () => "session-1", getEntries: () => [] },
      ui: { setWidget: () => {}, onTerminalInput: () => () => {}, getEditorText: () => "" },
    });
    return handlers;
  };

  load();
  const pane = load();
  // The pane closes; the session that owns the widget is still open.
  pane.get("session_shutdown")(undefined, undefined);

  for (const handler of bus.get(WORKFLOW_RUN_COMPLETED_EVENT) ?? []) {
    handler({ runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  }
  await new Promise((resolve) => globalThis.setTimeout(resolve, 250));

  assert.equal(entries.length, 1, "the surviving instance still writes its receipt");
});


void test("a quiet agent is flagged early, a stalled one more loudly", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-stall-"));
  const state = runState();
  const host = harness();
  host.start();

  // Four minutes of silence: too long to be thinking, and the signature of an
  // agent asking a question in its own pane — which the core cannot see.
  // Both the run state and the transcript are stale: nothing has moved.
  const oldTranscript = join(root, "old.jsonl");
  writeFileSync(oldTranscript, "{}\n");
  utimesSync(oldTranscript, new Date(Date.now() - 4 * 60_000), new Date(Date.now() - 4 * 60_000));
  const session = { transport: "local", sessionId: "s", locator: { sessionFile: oldTranscript } };

  const quiet = writeRun(join(root, "run-1"), {
    ...state,
    agents: [{
      ...state.agents[0],
      lastEventAt: Date.now() - 4 * 60_000,
      attemptDetails: [{ attempt: 1, transport: "local", session }],
    }],
  });
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: quiet, sessionId: "session-1" });
  assert.match(host.frames.at(-1).map(plain).join("\n"), /quiet 04:0\d/, "the silence is shown with its length");

  // Past the core's own stall threshold it stops being merely quiet.
  const deadTranscript = join(root, "dead.jsonl");
  writeFileSync(deadTranscript, "{}\n");
  utimesSync(deadTranscript, new Date(Date.now() - 11 * 60_000), new Date(Date.now() - 11 * 60_000));

  const stalled = writeRun(join(root, "run-2"), {
    ...state,
    agents: [{
      ...state.agents[0],
      lastEventAt: Date.now() - 11 * 60_000,
      attemptDetails: [{
        attempt: 1,
        transport: "local",
        session: { transport: "local", sessionId: "s2", locator: { sessionFile: deadTranscript } },
      }],
    }],
  });
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-2", runDirectory: stalled, sessionId: "session-1" });
  assert.match(host.frames.at(-1).map(plain).join("\n"), /stalled 11:0\d/, "a stalled agent says so");

  host.shutdown();
});

void test("only running agents can become quiet", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-quiet-states-"));
  const state = runState();
  const oldTranscript = join(root, "old.jsonl");
  writeFileSync(oldTranscript, "{}\n");
  utimesSync(oldTranscript, new Date(Date.now() - 5 * 60_000), new Date(Date.now() - 5 * 60_000));
  const attemptDetails = [{ attempt: 1, transport: "local", session: { locator: { sessionFile: oldTranscript } } }];
  const agents = ["queued", "paused", "retrying", "waiting_for_child"].map((agentState, index) => ({
    ...state.agents[0], id: `agent-${String(index)}`, name: agentState, state: agentState, lastEventAt: Date.now() - 5 * 60_000, attemptDetails,
  }));
  const directory = writeRun(join(root, "run-1"), { ...state, phaseHistory: [{ phase: "work", afterAgent: 0 }], agents });
  const host = harness();
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  const body = host.frames.at(-1).map(plain).join("\n");
  assert.doesNotMatch(body, /quiet|stalled/);
  host.shutdown();
});

void test("a retry is visible while it is happening, not only in the receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-retry-"));
  const state = runState();
  const directory = writeRun(join(root, "run-1"), {
    ...state,
    agents: [{ ...state.agents[0], attempts: 2 }],
  });
  const host = harness();
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

  assert.match(host.frames.at(-1).map(plain).join("\n"), /attempt 2/, "the attempt count is shown");

  host.shutdown();
});

void test("a phase of shell work shows its commands once they have run a while", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-shell-"));
  const state = runState();
  const base = { ...state, agents: [] };
  const host = harness();
  host.start();

  // A command that just started stays quiet; the phase would otherwise flicker.
  const brief = writeRun(join(root, "run-1"), {
    ...base,
    activeShellsByPhase: [{ phaseIndex: 0, active: 1, startedAt: Date.now() - 500 }],
  });
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: brief, sessionId: "session-1" });
  assert.doesNotMatch(host.frames.at(-1).map(plain).join("\n"), /command/, "a brief command is not worth a row");

  const settled = writeRun(join(root, "run-2"), {
    ...base,
    activeShellsByPhase: [{ phaseIndex: 0, active: 2, startedAt: Date.now() - 20_000 }],
  });
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-2", runDirectory: settled, sessionId: "session-1" });
  assert.match(host.frames.at(-1).map(plain).join("\n"), /2 commands/, "a long-running phase says how many");

  host.shutdown();
});

void test("crossing a budget threshold shows on the run line", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-budget-"));
  const directory = writeRun(join(root, "run-1"), {
    ...runState(),
    budgetEvents: [{ type: "soft_crossed", dimensions: ["costUsd"] }],
  });
  const host = harness();
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

  assert.match(host.frames.at(-1).map(plain).join("\n"), /near budget \(costUsd\)/, "the crossed dimension is named");

  host.shutdown();
});

void test("a checkpoint waiting on a person is shown, and clears when answered", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-checkpoint-"));
  const directory = writeRun(join(root, "run-1"), runState());
  const host = harness();
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

  host.emit(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1", name: "merge the MR?", state: "awaiting" });
  assert.match(host.frames.at(-1).map(plain).join("\n"), /waiting: merge the MR\?/, "the question is shown");

  // A re-read of the state file must not lose it: disk knows nothing of checkpoints.
  host.emit(WORKFLOW_RUN_STATE_CHANGED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  assert.match(host.frames.at(-1).map(plain).join("\n"), /waiting: merge the MR\?/, "it survives a state re-read");

  host.emit(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1", name: "merge the MR?", state: "approved" });
  assert.doesNotMatch(host.frames.at(-1).map(plain).join("\n"), /waiting/, "answering clears it");

  host.shutdown();
});

void test("older receipts still render their tool-call counts", () => {
  // Receipts written before granted tools were persisted contain only a call
  // count; keep those transcript entries readable.
  const lines = renderReceipt(
    {
      runId: "run-1",
      workflow: "gate",
      state: "completed",
      tokens: 100,
      costUsd: 0.01,
      durationMs: 1_000,
      phases: ["after"],
      phaseBoundaries: [0],
      agents: [{ name: "scout", state: "completed", toolCalls: 31, input: 10, output: 5, cacheRead: 0, costUsd: 0.01, durationMs: 1_000, attempts: 1 }],
    },
    false,
    theme,
  ).map(plain);

  const body = lines.join("\n");
  assert.match(body, /31 calls/, "the effort is reported");
  assert.doesNotMatch(body, /tool0|read grep/, "the toolbox is not listed");
});

void test("shell activity appears without an event to announce it", async () => {
  // A phase running nothing but shell commands produces no events at all: the
  // core writes activeShells into the state file quietly. Without noticing that
  // the file changed, such a phase sits on screen looking like nothing happens.
  const root = mkdtempSync(join(tmpdir(), "widget-rescan-"));
  const directory = join(root, "run-1");
  const base = {
    ...runState(),
    agents: [],
    phaseHistory: [{ phase: "build", afterAgent: 0 }],
  };
  writeRun(directory, base);

  const host = harness();
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  assert.doesNotMatch(host.frames.at(-1).map(plain).join("\n"), /command/, "nothing to report yet");

  // The shell has now been running a while, and only the file says so.
  writeRun(directory, {
    ...base,
    activeShellsByPhase: [{ phaseIndex: 0, active: 1, startedAt: Date.now() - 30_000 }],
  });

  // Wait past one repaint without emitting anything.
  await new Promise((resolve) => globalThis.setTimeout(resolve, 400));

  assert.match(host.frames.at(-1).map(plain).join("\n"), /1 command/, "the widget noticed on its own");

  host.shutdown();
});

void test("a busy agent is not called quiet just because the run state is stale", () => {
  // The run state's lastEventAt is written only when the core persists, so a
  // perfectly busy agent can look silent for minutes. The agent's transcript is
  // appended to on every turn — that is the signal that it is alive.
  const root = mkdtempSync(join(tmpdir(), "widget-busy-"));
  const transcript = join(root, "agent.jsonl");
  writeFileSync(transcript, "{}\n");

  const state = runState();
  const stale = {
    ...state,
    agents: [{
      ...state.agents[0],
      lastEventAt: Date.now() - 8 * 60_000,
      attemptDetails: [{
        attempt: 1,
        transport: "local",
        session: { transport: "local", sessionId: "s", locator: { sessionFile: transcript } },
      }],
    }],
  };
  const directory = writeRun(join(root, "run-1"), stale);

  const host = harness();
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

  assert.doesNotMatch(
    host.frames.at(-1).map(plain).join("\n"),
    /quiet|stalled/,
    "a transcript written moments ago outweighs a stale run state",
  );

  host.shutdown();
});

void test("a busy screen still produces a frame Pi will not truncate", () => {
  // Pi cuts a widget at MAX_WIDGET_LINES (10) and appends its own notice. A
  // frame cut there loses its closing border, the box never closes, and the
  // leftovers pile up — which is what several concurrent runs used to do.
  const root = mkdtempSync(join(tmpdir(), "widget-busy-screen-"));
  const host = harness();
  host.start();

  const agent = (name, state) => ({
    name,
    role: "ops",
    state,
    startedAt: Date.now() - 60_000,
    tools: ["read"],
    model: { model: "fixture-model", thinking: "low" },
    accounting: { input: 1_000, output: 10, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
  });

  // Two runs, each several phases deep: eleven rows before folding.
  for (const [index, id] of ["run-1", "run-2"].entries()) {
    const directory = writeRun(join(root, id), {
      ...runState(),
      id,
      workflowName: `flow-${String(index)}`,
      phaseHistory: [
        { phase: "worktree", afterAgent: 0 },
        { phase: "discover", afterAgent: 0 },
        { phase: "plan", afterAgent: 1 },
      ],
      agents: [agent("scout", "completed"), agent("planner", "running")],
    });
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: id, runDirectory: directory, sessionId: "session-1" });
  }

  const frame = host.frames.at(-1);
  assert.ok(frame.length <= 10, `the frame stays within its row budget, got ${frame.length}`);
  // A lid on the title row, side rules between, a floor to close it.
  assert.match(plain(frame[0]), /^╭.*╮$/, `the lid rides the title row, got: ${plain(frame[0])}`);
  assert.match(plain(frame.at(-1)), /^╰─+╯$/, `the box closes, got: ${plain(frame.at(-1))}`);
  for (const line of frame.slice(1, -1)) assert.match(plain(line), /^│.*│$/, `a rule on both edges, got: ${plain(line)}`);

  // Folding must not hide the work that is actually happening.
  const text = frame.map(plain).join("\n");
  assert.match(text, /planner/, "a running agent survives the fold");

  host.shutdown();
});

void test("a receipt line longer than the terminal is cut, not fatal", () => {
  // Taken from a real crash: a role with ten tools produced a 110-column line
  // in a 72-column terminal. Pi treats an over-wide line as fatal rather than
  // wrapping it, so the session died drawing its own receipt.
  const host = harness();
  host.start();

  const component = host.renderer.fn(
    {
      data: {
        runId: "run-1",
        workflowName: "act-document",
        state: "completed",
        tokens: 131_000,
        cost: 1.62,
        durationMs: 899_000,
        phases: [{ name: "plan", state: "completed" }],
        phaseBoundaries: [0],
        agents: [{
          name: "planner-deep",
          state: "completed",
          model: "claude-opus-5:xhigh",
          role: "planner-deep",
          requestedModel: "planner-model",
          tools: ["read", "grep", "find", "ls", "symbol_search", "module_report", "read_symbol", "bash"],
          input: 28,
          output: 17_000,
          cacheRead: 875_000,
          cost: 1.4,
          durationMs: 457_000,
          attempts: 1,
        }],
      },
    },
    { expanded: false },
    theme,
  );

  for (const width of [40, 72, 110]) {
    const tooWide = component.render(width).filter((line) => plain(line).length > width);
    assert.deepEqual(tooWide, [], `nothing exceeds ${width} columns`);
  }

  host.shutdown();
});

void test("a foreground run is left to the workflow tool that is already drawing it", () => {
  // A foreground run is rendered by the tool call that waited for it, in more
  // detail than the run state on disk allows — it has the live activity and
  // token counts that are never persisted. Drawing it again here would be two
  // views of one run, disagreeing.
  const root = mkdtempSync(join(tmpdir(), "widget-foreground-"));
  const host = harness();
  host.start();

  const directory = writeRun(join(root, "run-1"), {
    ...runState(),
    delivery: { mode: "foreground", state: "attached" },
  });
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

  assert.equal(host.frames.at(-1), undefined, "no widget for a foreground run");

  host.shutdown();
});

void test("a foreground run leaves no receipt either", async () => {
  const root = mkdtempSync(join(tmpdir(), "widget-foreground-receipt-"));
  const host = harness();
  host.start();

  const directory = writeRun(join(root, "run-1"), {
    ...runState(),
    state: "completed",
    delivery: { mode: "foreground", state: "delivered" },
    agents: [{ ...runState().agents[0], state: "completed", durationMs: 1_000 }],
  });
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  host.emit(WORKFLOW_RUN_COMPLETED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  await new Promise((resolve) => globalThis.setTimeout(resolve, 250));

  assert.deepEqual(host.entries, [], "the tool call already summarised it");

  host.shutdown();
});









void test("every colour comes from the theme", () => {
  // Hardcoded 24-bit escapes look right on one terminal and wrong on a
  // 256-colour or light theme, and ignore whatever the reader chose. Rendering
  // with a theme that paints nothing must therefore produce no colour at all.
  const root = mkdtempSync(join(tmpdir(), "widget-theme-"));
  const host = harness();
  host.start();

  const directory = writeRun(join(root, "run-1"), runState());
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

  const colourless = { fg: (_colour, text) => text, bold: (text) => text, bg: (_colour, text) => text };
  const frame = host.widgets.at(-1)(host.tui, colourless).render(WIDTH);

  const coloured = frame.filter((line) => line.includes("\u001b["));
  assert.deepEqual(coloured, [], "a theme that paints nothing leaves no escapes behind");

  host.shutdown();
});

void test("one busy agent does not vouch for a silent one", () => {
  // Silence used to be measured across every session in the run, so the newest
  // write anywhere made every agent look alive. Two agents, one working and one
  // that stopped, then read identically — and the one that stopped is the whole
  // reason to look.
  const root = mkdtempSync(join(tmpdir(), "widget-per-agent-"));

  const busy = join(root, "busy.jsonl");
  const silent = join(root, "silent.jsonl");
  writeFileSync(busy, "{}\n");
  writeFileSync(silent, "{}\n");
  const longAgo = new Date(Date.now() - 5 * 60_000);
  utimesSync(silent, longAgo, longAgo);

  const state = runState();
  const attempt = (file) => [{
    attempt: 1,
    transport: "local",
    session: { transport: "local", sessionId: file, locator: { sessionFile: file } },
  }];

  const directory = writeRun(join(root, "run-1"), {
    ...state,
    phaseHistory: [{ phase: "work", afterAgent: 0 }],
    agents: [
      { ...state.agents[0], id: "a1", name: "worker", lastEventAt: Date.now(), attemptDetails: attempt(busy) },
      { ...state.agents[0], id: "a2", name: "waiter", lastEventAt: Date.now() - 5 * 60_000, attemptDetails: attempt(silent) },
    ],
  });

  const host = harness();
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

  const frame = host.frames.at(-1).map(plain);
  const worker = frame.find((line) => line.includes("worker"));
  const waiter = frame.find((line) => line.includes("waiter"));
  assert.ok(!worker.includes("quiet"), "the working agent is not flagged");
  assert.match(waiter, /quiet 05:0\d/, "the silent one is, on its own transcript");

  host.shutdown();
});

void test("agents nest under their parent, by the label the workflow gave them", () => {
  // A spawned agent drawn as a sibling hides who asked for it, and its cost
  // reads as a peer's rather than part of the parent's. The label is what the
  // workflow called this one; the name is the role it was built from, which
  // two agents can share.
  const root = mkdtempSync(join(tmpdir(), "widget-nest-"));
  const state = runState();
  const base = state.agents[0];

  const directory = writeRun(join(root, "run-1"), {
    ...state,
    phaseHistory: [{ phase: "work", afterAgent: 0 }],
    agents: [
      { ...base, id: "p", name: "developer", label: "developer (api)", state: "running" },
      { ...base, id: "c", name: "reviewer", parentId: "p", state: "running" },
    ],
  });

  const host = harness();
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

  const frame = host.frames.at(-1).map(plain);
  const parent = frame.findIndex((line) => line.includes("developer (api)"));
  const child = frame.findIndex((line) => line.includes("reviewer"));

  assert.ok(parent >= 0, "the label is used, not the bare role name");
  assert.ok(child > parent, "the child is drawn under its parent");

  const indent = (line) => line.length - line.replace(/^│\s+/, "").length;
  assert.ok(indent(frame[child]) > indent(frame[parent]), "and indented beneath it");

  host.shutdown();
});

void test("with scrolling off the widget claims no keys at all", () => {
  // The behaviour is finished but withheld until there is something to do
  // once inside. While it is off, `↓` and the shortcut must reach whatever
  // else wants them — a widget that swallows keys to offer nothing back is
  // worse than one that stays out of the way.
  __navigationForTests.enabled = false;

  const root = mkdtempSync(join(tmpdir(), "widget-off-"));
  const host = harness();
  host.start();

  const directory = writeRun(join(root, "run-1"), runState());
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

  assert.equal(host.shortcuts.size, 0, "no shortcut is registered");

  host.setEditorText("");
  assert.equal(host.key("\u001b[1;1:1B"), false, "↓ passes through untouched");

  const frame = host.frames.at(-1).map(plain);
  assert.ok(!frame[0].includes("alt+o"), "and nothing is promised in the title");

  host.shutdown();
});

void test("the shortcut scrolls the widget through a tree too tall to show", () => {
  // Ten rows do not stretch to five runs three phases deep, and what is folded
  // away at rest is chosen by the widget, not the reader. Scrolling is how the
  // rest is reached — entered by shortcut alone, since `↓` on an empty editor
  // belongs to whichever picker opens next.
  __navigationForTests.enabled = true;
  const root = mkdtempSync(join(tmpdir(), "widget-scroll-"));
  const host = harness();
  host.start();

  const state = runState();
  for (const id of ["run-1", "run-2", "run-3", "run-4", "run-5"]) {
    const directory = writeRun(join(root, id), {
      ...state,
      id,
      workflowName: `flow-${id}`,
      phaseHistory: [
        { phase: "fetch", afterAgent: 0 },
        { phase: "build", afterAgent: 0 },
        { phase: "verify", afterAgent: 0 },
      ],
    });
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: id, runDirectory: directory, sessionId: "session-1" });
  }

  const draw = () => host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain);
  const shortcut = [...host.shortcuts.values()][0];
  assert.ok(shortcut, "the shortcut is registered");

  const resting = draw();
  assert.ok(resting.length <= 10, `the frame keeps its budget, got ${resting.length}`);
  assert.ok(resting.some((line) => line.includes("more")), "and says how much is hidden");

  // `↓` is left alone until the shortcut says otherwise.
  host.setEditorText("");
  assert.equal(host.key("\u001b[1;1:1B"), false, "↓ is not claimed at rest");

  shortcut.handler();
  assert.equal(host.key("\u001b[1;1:1B"), true, "and is claimed while scrolling");
  const scrolled = draw();
  assert.notDeepEqual(scrolled, resting, "the window moved");
  assert.ok(scrolled.length <= 10, "still within budget");
  assert.match(scrolled[0], /↑↓ scroll · esc/, "the keys are named while scrolling");

  // Escape gives the keyboard back, and the arrow with it.
  assert.equal(host.key("\u001b"), true, "escape is taken");
  assert.equal(host.key("\u001b[1;1:1B"), false, "and ↓ is free again");

  host.shutdown();
});

void test("alt+o does not enter or bank scrolling when the tree fits", () => {
  __navigationForTests.enabled = true;
  const root = mkdtempSync(join(tmpdir(), "widget-fit-scroll-"));
  const host = harness();
  host.start();
  const directory = writeRun(join(root, "run-1"), runState({
    agents: [],
    phaseHistory: Array.from({ length: 7 }, (_, index) => ({ phase: `phase-${String(index)}`, afterAgent: 0 })),
  }));
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  const shortcut = [...host.shortcuts.values()][0];
  const before = host.widgets.at(-1)(host.tui, theme).render(WIDTH);
  shortcut.handler();
  assert.equal(host.key("\u001b[1;1:1B"), false);
  assert.deepEqual(host.widgets.at(-1)(host.tui, theme).render(WIDTH), before);
  host.shutdown();
});

void test("scroll mode yields arrows when a repaint leaves a fitting tree", () => {
  __navigationForTests.enabled = true;
  const root = mkdtempSync(join(tmpdir(), "widget-scroll-shrink-"));
  const host = harness();
  host.start();
  const directory = writeRun(join(root, "run-1"), runState({
    phaseHistory: Array.from({ length: 10 }, (_, index) => ({ phase: `phase-${String(index)}`, afterAgent: 0 })),
    agents: [],
  }));
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  [...host.shortcuts.values()][0].handler();
  assert.equal(host.key("\u001b[1;1:1B"), true);

  writeRun(directory, runState({ agents: [], phaseHistory: [{ phase: "phase-0", afterAgent: 0 }] }));
  host.emit(WORKFLOW_AGENT_STATE_CHANGED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  assert.equal(host.key("\u001b[1;1:1B"), false);
  host.shutdown();
});


void test("scrolling is visibly a mode: coloured rules, a scrollbar and a way out", () => {
  // Entering a mode that looks identical to not being in it is how a keypress
  // goes somewhere unexpected. The rules change colour, a scrollbar says where
  // the window sits, and the title names the key that leaves.
  __navigationForTests.enabled = true;
  const root = mkdtempSync(join(tmpdir(), "widget-mode-"));
  const host = harness();
  host.start();

  const state = runState();
  for (const id of ["run-1", "run-2", "run-3", "run-4", "run-5"]) {
    const directory = writeRun(join(root, id), {
      ...state,
      id,
      workflowName: `flow-${id}`,
      phaseHistory: [
        { phase: "fetch", afterAgent: 0 },
        { phase: "build", afterAgent: 0 },
        { phase: "verify", afterAgent: 0 },
      ],
    });
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: id, runDirectory: directory, sessionId: "session-1" });
  }

  // A theme that names the colour it was asked for, so the role is checkable.
  // Each role gets a distinct real colour code, so the choice is checkable
  // without adding width — an invented marker would push the line past the
  // terminal and be truncated, which is the stand-in's fault, not the widget's.
  const codes = { accent: "\u001b[34m", warning: "\u001b[33m" };
  const named = {
    fg: (colour, text) => `${codes[colour] ?? "\u001b[39m"}${text}\u001b[0m`,
    bold: (text) => text,
    bg: (_colour, text) => text,
  };
  // Wide enough for the title and the hint together; the hint gives way to the
  // title on a narrow terminal, which is its own behaviour.
  const draw = () => host.widgets.at(-1)(host.tui, named).render(100);

  const resting = draw();
  assert.ok(resting[0].startsWith("\u001b[34m╭"), "at rest the rules are the ordinary accent");
  assert.match(plain(resting[0]), /alt\+o to scroll/, "and the way in is named");
  assert.ok(!resting.some((line) => line.includes("█")), "no scrollbar until it means something");

  [...host.shortcuts.values()][0].handler();
  const scrolling = draw();
  assert.ok(scrolling[0].startsWith("\u001b[33m╭"), "scrolling recolours the rules");
  assert.match(plain(scrolling[0]), /esc to exit/, "and names the way out");
  assert.ok(scrolling.some((line) => line.includes("█")), "the thumb shows where the window sits");
  assert.ok(scrolling.some((line) => line.includes("░")), "against the track it moves along");

  host.shutdown();
});

/** Builds a host with `count` runs of three phases each — more tree than frame. */
function tallTree(count = 5) {
  const root = mkdtempSync(join(tmpdir(), "widget-tall-"));
  const host = harness();
  host.start();
  for (let index = 0; index < count; index += 1) {
    const id = `run-${String(index)}`;
    const directory = writeRun(join(root, id), {
      ...runState(),
      id,
      workflowName: `flow-${String(index)}`,
      phaseHistory: [
        { phase: "one", afterAgent: 0 },
        { phase: "two", afterAgent: 0 },
        { phase: "three", afterAgent: 0 },
      ],
    });
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: id, runDirectory: directory, sessionId: "session-1" });
  }
  return host;
}

void test("scrolling reaches the last row and stops there, with nothing banked past the end", () => {
  // The failure this guards is invisible rather than loud: presses past the end
  // raise an offset no row can show, and every one has to be paid back with an
  // ↑ that appears to do nothing. Overscroll far, then check that a single ↑
  // moves the screen.
  __navigationForTests.enabled = true;
  const host = tallTree();
  const draw = () => host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain);
  [...host.shortcuts.values()][0].handler();

  for (let press = 0; press < 40; press += 1) host.key("\u001b[1;1:1B");
  const bottom = draw();
  assert.ok(bottom.some((line) => line.includes("three")), "the last phase of the last run is reachable");
  assert.ok(bottom.some((line) => line.includes("above")), "and the marker counts what is behind, not ahead");

  host.key("\u001b[1;1:1A");
  assert.notDeepEqual(draw(), bottom, "one ↑ after overscrolling moves the window");

  host.shutdown();
});

void test("entering scroll mode shows the top of the tree, not the resting selection", () => {
  // At rest the widget picks rows by rank, so what it shows is not contiguous
  // and the gaps are unmarked. Entering on that view makes the first press look
  // like a jump: the reader is not moving a window, they are swapping views.
  __navigationForTests.enabled = true;
  const host = tallTree();
  const draw = () => host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain);

  // Contiguity is the point: the resting view drops rows silently, so a window
  // that merely starts at the top is not enough — the rows after it must be
  // the ones that really follow. Scrolling to the end collects every row of
  // the tree in order; entering must show that sequence's first rows exactly.
  [...host.shortcuts.values()][0].handler();
  const entered = draw().slice(1, -1);

  const walked = [];
  for (let press = 0; press < 40; press += 1) {
    for (const line of draw().slice(1, -1)) if (!line.includes("…") && !walked.includes(line)) walked.push(line);
    host.key("\u001b[1;1:1B");
  }

  assert.deepEqual(
    entered.filter((line) => !line.includes("…")),
    walked.slice(0, entered.filter((line) => !line.includes("…")).length),
    "the window opens on the first rows of the tree, in the order it walks them",
  );

  host.shutdown();
});

void test("the scrollbar thumb tracks the window it describes", () => {
  // A thumb that reaches the bottom while rows remain, or lingers at the top
  // after the window moved, is worse than no thumb: it is a wrong answer to
  // the only question it is asked.
  __navigationForTests.enabled = true;
  const host = tallTree();
  const thumb = () => {
    const rows = host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain).slice(1, -1);
    const first = rows.findIndex((line) => line.endsWith("█"));
    const last = rows.map((line) => line.endsWith("█")).lastIndexOf(true);
    return { first, last, rows: rows.length };
  };
  [...host.shortcuts.values()][0].handler();

  const top = thumb();
  assert.equal(top.first, 0, "at the top of the tree the thumb starts at the top");
  assert.ok(top.last < top.rows - 1, "and does not already fill the track");

  for (let press = 0; press < 40; press += 1) host.key("\u001b[1;1:1B");
  const bottom = thumb();
  assert.equal(bottom.last, bottom.rows - 1, "at the end of the tree it reaches the bottom");
  assert.ok(bottom.first > top.first, "having travelled there");

  // And only there. A thumb clamped short of the window's own limit reaches
  // the bottom while the content still has a row to give — a wrong answer to
  // the one question it is asked. The track is coarser than a row, so the
  // check is that the thumb is still moving where the window still moves:
  // rewind to the top, then step down watching both.
  for (let press = 0; press < 60; press += 1) host.key("\u001b[1;1:1A");
  const body = () => host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain).slice(1, -1).join("\n");
  let previousBody = body();
  let previousThumb = thumb();
  let contentMovedAfterThumbStopped = false;
  for (let press = 0; press < 40; press += 1) {
    host.key("\u001b[1;1:1B");
    const nextBody = body();
    const nextThumb = thumb();
    if (nextBody !== previousBody && previousThumb.last === previousThumb.rows - 1) {
      contentMovedAfterThumbStopped = true;
    }
    previousBody = nextBody;
    previousThumb = nextThumb;
  }
  assert.ok(!contentMovedAfterThumbStopped, "the window never moves after the thumb claims the bottom");

  host.shutdown();
});

void test("lines are measured in terminal cells, not JavaScript characters", () => {
  // Pi-tui rejects a line wider than the width it handed out — it throws, it
  // does not wrap — and it counts display cells. A CJK ideograph is one
  // character and two cells, so measuring with `.length` under-counts by half
  // and hands the TUI a fatal line. Widths are checked with pi-tui's own
  // measure, because agreeing approximately is the same as not agreeing.
  const root = mkdtempSync(join(tmpdir(), "widget-cells-"));
  const host = harness();
  host.start();

  const names = ["数据处理工作流程测试用例名称很长", "deploy 🚀🚀🚀🚀🚀🚀🚀🚀 prod", "ノード・ビルド・検証"];
  names.forEach((workflowName, index) => {
    const id = `run-${String(index)}`;
    const directory = writeRun(join(root, id), {
      ...runState(),
      id,
      workflowName,
      phaseHistory: [{ phase: "検証", afterAgent: 0 }, { phase: "two", afterAgent: 0 }],
    });
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: id, runDirectory: directory, sessionId: "session-1" });
  });

  const widget = host.widgets.at(-1)(host.tui, theme);
  for (let width = 1; width <= 120; width += 1) {
    for (const line of widget.render(width)) {
      assert.ok(
        visibleWidth(line) <= width,
        `render(${String(width)}) returned a line ${String(visibleWidth(line))} cells wide`,
      );
    }
  }

  host.shutdown();
});

void test("a run header survives however many checkpoints are waiting", () => {
  // Checkpoints share the top rank because they need an answer, so ranking
  // alone lets a few early ones spend the budget before a later run's header
  // is reached. A run missing its detail is terse; a run missing its header is
  // invisible, and the widget exists to say what is running.
  const root = mkdtempSync(join(tmpdir(), "widget-headers-"));
  const host = harness();
  host.start();

  for (let index = 0; index < 8; index += 1) {
    const id = `run-${String(index)}`;
    const directory = writeRun(join(root, id), { ...runState(), id, workflowName: `flow-${String(index)}` });
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: id, runDirectory: directory, sessionId: "session-1" });
  }
  for (let index = 0; index < 7; index += 1) {
    host.emit(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, {
      runId: `run-${String(index)}`,
      runDirectory: join(root, `run-${String(index)}`),
      sessionId: "session-1",
      state: "awaiting",
      name: `approve-${String(index)}`,
    });
  }

  const frame = host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain);
  for (let index = 0; index < 8; index += 1) {
    assert.ok(frame.some((line) => line.includes(`flow-${String(index)}`)), `flow-${String(index)} is still on screen`);
  }

  host.shutdown();
});

void test("marks hidden rows when run headers exceed the body budget", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-header-budget-"));
  const host = harness();
  host.start();
  for (let index = 0; index < 9; index += 1) {
    const id = `run-${String(index)}`;
    const directory = writeRun(join(root, id), { ...runState(), id, workflowName: `flow-${String(index)}` });
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: id, runDirectory: directory, sessionId: "session-1" });
  }

  const frame = host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain);
  assert.ok(frame.length <= 10, "the strict frame budget still wins");
  assert.ok(frame.some((line) => line.includes("more")), "hidden headers are accounted for");
  assert.ok(!frame.some((line) => line.includes("flow-8")), "not every header is claimed to fit");
  host.shutdown();
});
