import assert from "node:assert/strict";
import fs, { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import widget, { formatCost, mark, renderReceipt, __navigationForTests } from "../dist/src/background-widget.js";
import { RunStore } from "../dist/src/persistence.js";
import {
  WORKFLOW_AGENT_STATE_CHANGED_EVENT,
  WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT,
  WORKFLOW_RUN_COMPLETED_EVENT,
  WORKFLOW_RUN_FAILED_EVENT,
  WORKFLOW_RUN_STARTED_EVENT,
  WORKFLOW_RUN_STATE_CHANGED_EVENT,
} from "../dist/src/types.js";

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

/** Normalizes live animation and elapsed time so repeated row comparisons stay stable. */
const stableLine = (line) => plain(line).replace(/[⣷⣯⣟⡿⢿⣽⣻]/g, "⣷").replace(/\b\d{2}:\d{2}\b/g, "00:00");
void test("formats nonzero sub-cent costs with three decimals", () => {
  assert.equal(formatCost(undefined), "");
  assert.equal(formatCost(0), "");
  assert.equal(formatCost(0.001), "$0.001");
  assert.equal(formatCost(0.0099), "$0.010");
  assert.equal(formatCost(0.01), "$0.01");
  assert.equal(formatCost(1.234), "$1.23");
});

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
  let widgetComponent;
  let renderRequests = 0;

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

  tui.requestRender = () => {
    renderRequests += 1;
    if (widgetComponent) frames.push(widgetComponent.render(WIDTH));
  };

  const context = {
    hasUI: options.hasUI ?? true,
    mode: options.mode ?? "tui",
    cwd: options.cwd,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => sessionEntries },
    // The widget registers a factory so it is built at the width the TUI is
    // about to draw with. Render it the way the host does, at a fixed width.
    ui: {
      setWidget: (_key, value, options) => {
        widgets.push(value);
        placements.push(options?.placement);
        widgetComponent = typeof value === "function" ? value(tui, theme) : undefined;
        frames.push(widgetComponent ? widgetComponent.render(WIDTH) : value);
      },
      onTerminalInput: (handler) => {
        inputHandlers.push(handler);
        return () => { inputHandlers.splice(inputHandlers.indexOf(handler), 1); };
      },
      getEditorText: () => editorText,
    },
  };

  const controller = widget(pi, options.backgroundWidget ?? true, options.opener, options.subagents);
  return {
    context,
    controller,
    frames,
    widgets,
    placements,
    entries,
    tui,
    get renderRequests() { return renderRequests; },
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

void test("backgroundWidget false disables the live tree and receipts", () => {
  const host = harness("session-1", { backgroundWidget: false });
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: "/missing", sessionId: "session-1" });
  assert.deepEqual(host.widgets, []);
  assert.deepEqual(host.entries, []);
  assert.equal(host.renderer, undefined);
  assert.equal(host.shortcuts.size, 0);
});

void test("headless hosts do not draw or append background receipts", () => {
  const host = harness("session-1", { hasUI: false });
  host.start();
  host.emit(WORKFLOW_RUN_COMPLETED_EVENT, { runId: "run-1", runDirectory: "/missing", sessionId: "session-1" });
  assert.deepEqual(host.widgets, []);
  assert.deepEqual(host.entries, []);
  host.shutdown();
});
void test("non-TUI hosts do not draw or append background receipts", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-rpc-"));
  const directory = writeRun(join(root, "run-1"), runState({ state: "completed" }));
  const host = harness("session-1", { mode: "rpc" });
  host.start();
  host.emit(WORKFLOW_RUN_COMPLETED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  assert.deepEqual(host.widgets, []);
  assert.deepEqual(host.entries, []);
  host.shutdown();
  rmSync(root, { recursive: true, force: true });
});
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

void test("mounts once, repaints once a second while a run spins and not at all while it is paused", (t) => {
  const root = mkdtempSync(join(tmpdir(), "widget-lifecycle-"));
  const directory = writeRun(join(root, "run-1"), runState());
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const host = harness();
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

  const mountedCalls = host.widgets.length;
  const running = host.renderRequests;
  for (let step = 0; step < 24; step += 1) t.mock.timers.tick(125);
  assert.equal(host.widgets.length, mountedCalls, "the spinner does not remount the widget");
  assert.equal(host.renderRequests, running + 3, "the spinner turns once a second");

  const beforePause = host.renderRequests;
  writeRun(directory, runState({ state: "paused" }));
  host.emit(WORKFLOW_RUN_STATE_CHANGED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1", state: "paused" });
  assert.equal(host.renderRequests, beforePause + 1, "a state change requests one render");
  const pausedRenders = host.renderRequests;
  t.mock.timers.tick(3000);
  assert.equal(host.widgets.length, mountedCalls, "a paused run stays mounted");
  assert.equal(host.renderRequests, pausedRenders, "a paused run is not repainted");

  host.shutdown();
  rmSync(root, { recursive: true, force: true });
});

for (const state of ["awaiting_input", "pausing", "queued"]) {
  void test(`a run ${state} keeps its clock moving`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "widget-elapsed-"));
    const directory = writeRun(join(root, "run-1"), runState({ state }));
    // The clock starts half a second after the run directory's birth time, so one tick crosses exactly one second.
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Math.ceil(statSync(directory).birthtimeMs) + 500 });
    const host = harness();
    host.start();
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

    const header = () => host.frames.at(-1).map(plain).find((line) => line.includes(" smoke "));
    assert.match(header(), / 00:00 │$/);
    const renders = host.renderRequests;
    t.mock.timers.tick(1000);
    assert.equal(host.renderRequests, renders + 1, "one repaint for the second that passed");
    assert.match(header(), / 00:01 │$/, "the run's elapsed time keeps moving");

    host.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
}

for (const state of ["interrupted", "paused", "budget_exhausted"]) {
  void test(`a run ${state}, which nothing ticks, shows the runtime it recorded, as /agents does`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "widget-recorded-"));
    const directory = writeRun(join(root, "run-1"), runState({ state, usage: { tokens: 44_700, costUsd: 0.056, durationMs: 82_529 } }));
    // Ten minutes after the run directory's birth: the time since it started is not what the run recorded.
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Math.ceil(statSync(directory).birthtimeMs) + 600_000 });
    const host = harness();
    host.start();
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

    const header = () => drawAt(host, WIDTH).find((line) => line.includes(" smoke "));
    assert.match(header(), / 01:22 │$/);
    const renders = host.renderRequests;
    t.mock.timers.tick(5000);
    assert.equal(host.renderRequests, renders, "nothing ticks");
    assert.match(header(), / 01:22 │$/, "a frame drawn later shows the same time");

    host.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
}

for (const [state, live] of [["running", true], ["pausing", true], ["awaiting_input", true], ["paused", false], ["budget_exhausted", false], ["interrupted", false]]) {
  void test(`an agent recorded running in a ${state} run ${live ? "keeps its silence mark" : "shows no silence mark"}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "widget-agent-silence-"));
    const now = 10_000_000;
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
    const baseAgent = runState().agents[0];
    const directory = writeRun(join(root, "run-1"), runState({
      state,
      agents: [{ ...baseAgent, state: "running", startedAt: now - 600_000, lastEventAt: now - 4 * 60_000, attemptDetails: [] }],
    }));
    const host = harness();
    host.start();
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

    const frame = host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain).join("\n");
    assert.equal(/quiet 04:00/.test(frame), live);

    host.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
}

// The widget lists only runs that are not hard terminal, so no agent of these runs is drawn, with a mark or a clock.
for (const state of ["completed", "failed", "stopped"]) {
  void test(`a ${state} run draws no widget, so none of its agents shows a mark or a clock`, () => {
    const root = mkdtempSync(join(tmpdir(), "widget-agent-terminal-"));
    const directory = writeRun(join(root, "run-1"), runState({ state }));
    const host = harness();
    host.start();
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
    assert.equal(host.widgets.at(-1), undefined);
    host.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
}

for (const [state, live] of [["running", true], ["pausing", true], ["awaiting_input", true], ["paused", false], ["budget_exhausted", false], ["interrupted", false]]) {
  void test(`an agent recorded running in a ${state} run ${live ? "keeps its own clock" : "shows no clock, not the run's total"}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "widget-agent-clock-"));
    const now = 10_000_000;
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
    const baseAgent = runState().agents[0];
    const directory = writeRun(join(root, "run-1"), runState({
      state,
      usage: { tokens: 44_700, costUsd: 0.056, durationMs: 82_529 },
      agents: [{ ...baseAgent, state: "running", startedAt: now - 600_000, lastEventAt: now, attemptDetails: [] }],
    }));
    const host = harness();
    host.start();
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

    const row = host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain).find((line) => line.includes("fixture-model"));
    assert.equal(/ 10:00/.test(row), live);
    assert.doesNotMatch(row, /01:22|00:00/);

    host.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
}

for (const [state, live] of [["running", true], ["pausing", true], ["awaiting_input", true], ["paused", false], ["budget_exhausted", false], ["interrupted", false]]) {
  void test(`the marks of an agent recorded running in a ${state} run ${live ? "spin" : "are the muted dot"}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "widget-agent-mark-"));
    const now = 10_000_000;
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
    const baseAgent = runState().agents[0];
    const directory = writeRun(join(root, "run-1"), runState({
      state,
      agents: [{ ...baseAgent, state: "running", startedAt: now - 600_000, lastEventAt: now, attemptDetails: [] }],
    }));
    const host = harness();
    host.start();
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

    const lines = host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain);
    const markOf = (row) => lines.find((line) => row.test(line))?.match(/[├╰]─ (\S) /)?.[1];
    assert.equal(markOf(/scout/) === "·", !live);
    if (live) assert.notEqual(markOf(/[├╰]─ \S llm\b/), "·");

    host.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
}

for (const [agentState, shown] of [["completed", "00:05"], ["failed", "00:05"]]) {
  void test(`a ${agentState} agent in a paused run shows its own durationMs, not the run's total`, () => {
    const root = mkdtempSync(join(tmpdir(), "widget-agent-duration-"));
    const baseAgent = runState().agents[0];
    const directory = writeRun(join(root, "run-1"), runState({
      state: "paused",
      usage: { tokens: 44_700, costUsd: 0.056, durationMs: 82_529 },
      agents: [{ ...baseAgent, state: agentState, durationMs: 5000 }],
    }));
    const host = harness();
    host.start();
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
    const row = host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain).find((line) => line.includes("fixture-model"));
    assert.match(row, new RegExp(` ${shown}`));
    assert.doesNotMatch(row, /01:22/);
    host.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
}

/** Three runs of three phases, each with twelve running agents writing their own transcripts. */
function largeRuns(root) {
  return [0, 1, 2].map((runIndex) => {
    const id = `big-${String(runIndex)}`;
    const agents = Array.from({ length: 12 }, (_, agentIndex) => {
      const sessionFile = join(root, `${id}-${String(agentIndex)}.jsonl`);
      writeFileSync(sessionFile, "{}\n");
      return { ...runState().agents[0], id: `${id}-${String(agentIndex)}`, name: `worker-${String(runIndex * 12 + agentIndex).padStart(2, "0")}`, attemptDetails: [{ session: { locator: { sessionFile } } }] };
    });
    const phaseHistory = [{ phase: "p0", afterAgent: 0 }, { phase: "p1", afterAgent: 4 }, { phase: "p2", afterAgent: 8 }];
    return { id, directory: writeRun(join(root, id), runState({ id, workflowName: id, phase: "p2", phaseHistory, agents })) };
  });
}

void test("a large run repaints at most once a second, and a render with nothing new reads no file", (t) => {
  const root = mkdtempSync(join(tmpdir(), "widget-large-"));
  const runs = largeRuns(root);
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const host = harness();
  host.start();
  for (const { id, directory } of runs) host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: id, runDirectory: directory, sessionId: "session-1" });

  const renders = host.renderRequests;
  for (let step = 0; step < 80; step += 1) t.mock.timers.tick(125);
  assert.ok(host.renderRequests - renders <= 10, `ten seconds ask for ten repaints at most, not ${String(host.renderRequests - renders)}`);
  assert.ok(host.renderRequests > renders, "the spinner still turns");

  const component = host.widgets.at(-1)(host.tui, theme);
  const stat = t.mock.method(fs, "statSync");
  syncBuiltinESMExports();
  try {
    const first = component.render(WIDTH);
    assert.ok(stat.mock.callCount() > 0, "a new frame looks at the transcripts");
    const calls = stat.mock.callCount();
    assert.deepEqual(component.render(WIDTH), first, "the kept frame is returned");
    assert.equal(stat.mock.callCount(), calls, "a render with nothing changed reads no file");
    assert.notDeepEqual(component.render(50), first, "a new width draws a new frame");
    // Only the clock moves: the tick does not fire, so nothing else changed.
    const requested = host.renderRequests;
    t.mock.timers.setTime(Date.now() + 1000);
    assert.equal(host.renderRequests, requested, "no tick fired");
    const next = stat.mock.callCount();
    component.render(50);
    assert.ok(stat.mock.callCount() > next, "a new second draws a new frame");
  } finally {
    stat.mock.restore();
    syncBuiltinESMExports();
  }

  host.shutdown();
  rmSync(root, { recursive: true, force: true });
});

void test("on a narrow terminal every row keeps its name and fits", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-narrow-"));
  // One run, so its agents are not folded into a count.
  const runs = largeRuns(root).slice(0, 1);
  const host = harness();
  host.start();
  for (const { id, directory } of runs) host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: id, runDirectory: directory, sessionId: "session-1" });

  for (const width of [50, 40]) {
    const lines = host.widgets.at(-1)(host.tui, theme).render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `${plain(line)} fits ${String(width)} columns`);
    const body = lines.slice(1, -1).map(plain);
    for (const line of body) assert.match(line, /│$/, `${line} keeps its right rule at ${String(width)} columns`);
    // Every line is clamped on the way out; the closing corners say the title row and the floor were drawn within the width, not cut.
    assert.match(plain(lines[0]), /^╭ Workflow ─+ Alt\+O to scroll ╮$/, `the title and its hint fit whole at ${String(width)} columns`);
    assert.match(plain(lines.at(-1)), /^╰─+╯$/, `the floor fits at ${String(width)} columns`);
    const agents = body.filter((line) => /[├╰]─ [⣷⣯⣟⡿⢿⣽⣻] w/.test(line));
    assert.ok(agents.length > 0, `agent rows are drawn at ${String(width)} columns`);
    for (const line of agents) assert.match(line, /worker-\d\d /, `${line} keeps the agent's whole name`);
    for (const line of body.filter((row) => /big-\d/.test(row))) assert.match(line, /big-\d /, `${line} keeps the run's whole name`);
  }

  host.shutdown();
  rmSync(root, { recursive: true, force: true });
});

void test("below 60 columns the title gives way to the hint: the counts are cut, the hint stays, and Alt+O is taken", () => {
  __navigationForTests.enabled = true;
  const root = mkdtempSync(join(tmpdir(), "widget-narrow-hint-"));
  const host = harness();
  host.start();
  for (const id of ["run-1", "run-2"]) {
    const directory = writeRun(join(root, id), { ...tallRun(id), workflowName: `flow-${id}`, agents: [silentAgent(`${id}-q`, "asker")] });
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: id, runDirectory: directory, sessionId: "session-1" });
  }
  host.emit(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, { runId: "run-1", runDirectory: join(root, "run-1"), sessionId: "session-1", name: "ok?", state: "awaiting" });
  for (const width of [50, 40]) {
    const frame = drawAt(host, width);
    assertFits(frame, width);
    assert.match(frame[0], /^╭ Workflows[^─]* ─+ Alt\+O to scroll ╮$/, `the hint stays whole at ${String(width)} columns`);
    host.key("\u001bo");
    assert.match(plain(drawAt(host, width)[0]), /esc exit/, `Alt+O is taken at ${String(width)} columns`);
    host.key("\u001b");
  }
  assert.match(drawAt(host, WIDTH)[0], /Alt\+O to scroll ╮$/);
  assert.equal(host.key("\u001bo"), true, "where the hint shows, Alt+O is taken");
  host.shutdown();
  rmSync(root, { recursive: true, force: true });
});

void test("in scroll mode at 40 columns and below the title row keeps the frame name and a way out", () => {
  __navigationForTests.enabled = true;
  const root = mkdtempSync(join(tmpdir(), "widget-narrow-scroll-"));
  const host = harness("session-1", { opener: { available: () => true, open: () => {} } });
  host.start();
  const directory = writeRun(join(root, "run-1"), tallRun());
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  for (const width of [40, 39, 35, 30]) {
    host.key("\u001bo");
    const frame = drawAt(host, width);
    assertFits(frame, width);
    assert.match(plain(frame[0]), /^╭ Workflow[^─]* ─+ .*esc exit ╮$/, `${plain(frame[0])} keeps the name and the way out at ${String(width)} columns`);
    host.key("\u001b");
  }
  host.shutdown();
  rmSync(root, { recursive: true, force: true });
});

void test("on a narrow terminal a subagent whose one figure is a long model keeps its whole label", () => {
  const model = { provider: "p", model: "a-very-long-model-name-for-the-row" };
  const { host } = subagentHost([], [backgroundSubagent("s1", "reviewer-of-the-diff", { status: { startedAt: undefined, progress: { lastEventAt: Date.now(), toolCalls: [], state: { model } } } })]);
  for (const width of [50, 40]) {
    const frame = drawAt(host, width);
    assertFits(frame, width);
    const line = frame.map(plain).find((item) => item.includes("reviewer"));
    assert.match(line ?? "", /reviewer-of-the-diff /, `${frame.map(plain).join("\n")}\nkeeps the label at ${String(width)} columns`);
  }
  host.shutdown();
});

void test("on a narrow terminal long names with several figures beside them stay whole", () => {
  const figures = { model: { model: "fixture-model", thinking: "medium" }, accounting: { input: 44_000, output: 700, cacheRead: 0, cost: 0.056 } };
  const { host } = subagentHost(
    [{ id: "run-1", workflowName: "a-long-workflow-name", usage: { tokens: 44_700, costUsd: 0.056 }, agents: [agent("a1", "implementer-of-it", "running", figures)] }],
    [backgroundSubagent("s1", "reviewer-of-the-diff")],
  );
  for (const width of [50, 40]) {
    const frame = drawAt(host, width);
    assertFits(frame, width);
    const text = frame.map(plain).join("\n");
    for (const name of ["a-long-workflow-name", "implementer-of-it", "reviewer-of-the-diff"]) {
      assert.match(text, new RegExp(`${name}( |$)`, "m"), `${text}\nkeeps ${name} whole at ${String(width)} columns`);
    }
  }
  host.shutdown();
});

void test("while an agents workspace is open (/agents, /workflow or /subagents) the widget paints nothing, its tick rescans nothing, and it is back on the tick after it closes", (t) => {
  const root = mkdtempSync(join(tmpdir(), "widget-workspace-"));
  const directory = writeRun(join(root, "run-1"), runState());
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const live = new Map([["s1", backgroundSubagent("s1", "alpha")]]);
  const host = harness("session-1", { subagents: () => live.values() });
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  assert.equal(typeof host.widgets.at(-1), "function");

  // The flag the workspace loop sets in every bundle while a workspace or its actions' dialogs are up.
  Reflect.set(globalThis, Symbol.for("pi-extensible-workflows.agents-workspace-loop"), true);
  const stat = t.mock.method(fs, "statSync");
  syncBuiltinESMExports();
  try {
    t.mock.timers.tick(1000);
    assert.equal(host.widgets.at(-1), undefined, "the tick under the workspace takes the frame away");
    const calls = host.widgets.length;
    const renders = host.renderRequests;
    t.mock.timers.tick(3000);
    stat.mock.resetCalls();
    host.emit(WORKFLOW_AGENT_STATE_CHANGED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
    assert.ok(stat.mock.calls.length > 0 && stat.mock.calls.every(({ arguments: [path] }) => String(path).startsWith(directory)), "a run event reads only its own run, which a receipt needs");
    live.set("s2", backgroundSubagent("s2", "beta"));
    host.controller.subagentsChanged();
    assert.equal(host.widgets.length, calls, "ticks, run events and subagent events draw nothing");
    assert.equal(host.renderRequests, renders, "nothing repaints");
    stat.mock.resetCalls();
    t.mock.timers.tick(3000);
    assert.equal(stat.mock.callCount(), 0, "the tick rescans no state file");
  } finally {
    stat.mock.restore();
    syncBuiltinESMExports();
    Reflect.deleteProperty(globalThis, Symbol.for("pi-extensible-workflows.agents-workspace-loop"));
  }

  t.mock.timers.tick(1000);
  assert.equal(typeof host.widgets.at(-1), "function", "the tick after the workspace closed draws the widget again");
  assert.ok(drawAt(host, WIDTH).some((line) => line.includes("beta")), "with what changed while it was open");

  host.shutdown();
  rmSync(root, { recursive: true, force: true });
});

void test("a frame mounted for a paused run, which nothing ticks, draws empty while an agents workspace is open", (t) => {
  const root = mkdtempSync(join(tmpdir(), "widget-workspace-paused-"));
  const directory = writeRun(join(root, "run-1"), runState({ state: "paused" }));
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const host = harness();
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  assert.ok(drawAt(host, WIDTH).length > 0, "the paused run is drawn");
  Reflect.set(globalThis, Symbol.for("pi-extensible-workflows.agents-workspace-loop"), true);
  try {
    assert.deepEqual(drawAt(host, WIDTH), [], "the mounted frame draws nothing under the workspace");
  } finally {
    Reflect.deleteProperty(globalThis, Symbol.for("pi-extensible-workflows.agents-workspace-loop"));
  }
  assert.ok(drawAt(host, WIDTH).length > 0, "the frame is back once the workspace closed");
  host.shutdown();
  rmSync(root, { recursive: true, force: true });
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

void test("actionable non-running run states are explicit in the header", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-status-glyphs-"));
  const host = harness();
  const workflowName = "distinct-workflow";
  const states = ["paused", "awaiting_input", "interrupted", "budget_exhausted"];
  host.start();
  for (const state of states) {
    const directory = writeRun(join(root, state), runState({ id: state, workflowName, state }));
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: state, runDirectory: directory, sessionId: "session-1" });
    const header = host.frames.at(-1).map(plain).find((line) => line.includes(`[${state}]`));
    assert.ok(header);
    const expected = state === "budget_exhausted" ? "✗" : "·";
    assert.match(header, new RegExp(`${expected} \\[${state}\\] ${workflowName}`), `${state} is explicit`);
    assert.doesNotMatch(header, /[⣷⣯⣟⡿⢿⣽⣻]/, `${state} does not spin`);
  }

  const factory = host.widgets.at(-1);
  assert.equal(typeof factory, "function");
  const narrow = factory().render(50).map(plain).join("\n");
  for (const state of states) {
    assert.match(narrow, new RegExp(`\\[${state}\\]`), `${state} survives a narrow render`);
  }

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

void test("the receipt stays compact until expanded, then shows full run details", () => {
  const receipt = {
    runId: "run-1",
    workflow: "deliver",
    state: "failed",
    costUsd: 0.4,
    tokens: 128_000,
    durationMs: 96_000,
    phases: ["scout", "review"],
    phaseBoundaries: [0, 1],
    agents: [
      { name: "scout", state: "completed", model: "fixture-model:high", requestedModel: "scout-model", toolCalls: 31, input: 30_000, output: 900, cacheRead: 80_000, costUsd: 0.09, durationMs: 31_000, attempts: 1 },
      { name: "reviewer", state: "failed", model: "fixture-model:xhigh", toolCalls: 1, input: 50_000, output: 200, cacheRead: 120_000, costUsd: 0.31, durationMs: 15_000, attempts: 3 },
    ],
    error: "reviewer was interrupted before it answered",
  };

  const collapsed = renderReceipt(receipt, false, theme).join("\n");
  assert.match(collapsed, /deliver/);
  assert.doesNotMatch(collapsed, /scout|reviewer|run-1/);

  const body = renderReceipt(receipt, true, theme).join("\n");
  assert.match(body, /scout/);
  assert.match(body, /review/);
  assert.match(body, /via scout-model · 31 calls/);
  assert.match(body, /1 call/, "one call is not pluralised");
  assert.match(body, /in 30kt · out 900t · cache 80kt/);
  assert.match(body, /3 attempts/, "a retried agent says so");
  assert.match(body, /interrupted before it answered/);
  assert.match(body, /run run-1/);
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
  const body = renderReceipt(receipt, true, theme).map(plain).join("\n");
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
      mode: "tui",
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

void test("a phase whose only live work is a running shell is drawn running, not done", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-shell-phase-"));
  const host = harness();
  host.start();
  const directory = writeRun(join(root, "run-1"), {
    ...runState(),
    agents: [],
    activeShellsByPhase: [{ phaseIndex: 0, active: 1, startedAt: Date.now() - 20_000 }],
  });
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  const text = host.frames.at(-1).map(plain).join("\n");
  assert.match(text, /1 command/, text);
  assert.match(text, /[├╰]─ [⣷⣯⣟⡿⢿⣽⣻] shell/, text);
  assert.doesNotMatch(text, /✓ shell/, text);
  host.shutdown();
});

for (const [state, live] of [["running", true], ["pausing", true], ["awaiting_input", true], ["paused", false], ["budget_exhausted", false], ["interrupted", false]]) {
  void test(`a running shell in a ${state} run ${live ? "spins and keeps its phase running" : "draws the quiet dot and its phase shows the run state"}`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "widget-shell-mark-"));
    const now = 10_000_000;
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
    const directory = writeRun(join(root, "run-1"), runState({
      state,
      agents: [],
      activeShellsByPhase: [{ phaseIndex: 0, active: 1, startedAt: now - 20_000 }],
    }));
    const host = harness();
    host.start();
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

    const lines = host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain);
    const markOf = (row) => lines.find((line) => row.test(line))?.match(/[├╰]─ (\S) /)?.[1];
    const spins = (glyph) => "⣷⣯⣟⡿⢿⣽⣻".includes(glyph);
    assert.equal(spins(markOf(/1 command/)), live, lines.join("\n"));
    assert.equal(spins(markOf(/[├╰]─ \S shell/)), live, lines.join("\n"));
    if (!live) {
      assert.equal(markOf(/1 command/), "·");
      assert.equal(markOf(/[├╰]─ \S shell/), state === "budget_exhausted" ? "✗" : "·");
    }

    host.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
}

for (const [state, glyph] of [["running", "✓"], ["pausing", "✓"], ["awaiting_input", "✓"], ["paused", "·"], ["interrupted", "·"], ["budget_exhausted", "✗"]]) {
  void test(`a phase whose agents are all settled draws ${glyph} in a ${state} run: the check where agents count as running, else the run's own state mark`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "widget-phase-mark-"));
    const now = 10_000_000;
    t.mock.timers.enable({ apis: ["Date", "setInterval"], now });
    const baseAgent = runState().agents[0];
    const directory = writeRun(join(root, "run-1"), runState({
      state,
      phase: "work",
      phaseHistory: [{ phase: "work", afterAgent: 0 }],
      agents: [{ ...baseAgent, state: "completed", startedAt: now - 600_000, durationMs: 60_000, attemptDetails: [] }],
    }));
    const host = harness();
    host.start();
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });

    const lines = host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain);
    assert.equal(lines.find((line) => /[├╰]─ \S work/.test(line))?.match(/[├╰]─ (\S) work/)?.[1], glyph, lines.join("\n"));

    host.shutdown();
    rmSync(root, { recursive: true, force: true });
  });
}

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
    true,
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

  // Wait past the separate filesystem rescan without emitting anything.
  await new Promise((resolve) => globalThis.setTimeout(resolve, 1200));

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
    { expanded: true },
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

void test("Alt+O scrolls the widget through a tree too tall to show", () => {
  // Ten rows do not stretch to five runs three phases deep, and what is folded
  // away at rest is chosen by the widget, not the reader. Scrolling is how the
  // rest is reached — entered by Alt+O alone, since `↓` on an empty editor
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
  assert.equal(host.shortcuts.size, 0, "Alt+O is no Pi shortcut: Pi's editor would take it with or without the hint");

  const resting = draw();
  assert.ok(resting.length <= 10, `the frame keeps its budget, got ${resting.length}`);
  assert.ok(resting.some((line) => /more|… \d+ phases?/.test(line)), "and says how much is hidden");

  // `↓` is left alone until Alt+O says otherwise.
  host.setEditorText("");
  assert.equal(host.key("\u001b[1;1:1B"), false, "↓ is not claimed at rest");

  const beforeFocus = host.renderRequests;
  assert.equal(host.key("\u001bo"), true, "Alt+O is taken while its hint shows");
  assert.equal(host.renderRequests, beforeFocus + 1, "entering scroll mode repaints immediately");
  assert.equal(host.key("\u001b[1;1:1B"), true, "and is claimed while scrolling");
  assert.equal(host.renderRequests, beforeFocus + 2, "scrolling repaints immediately");
  const scrolled = draw();
  assert.notDeepEqual(scrolled, resting, "the window moved");
  assert.ok(scrolled.length <= 10, "still within budget");
  assert.match(scrolled[0], /↑↓ move · esc exit/, "the keys are named while scrolling");

  // Escape gives the keyboard back, and the arrow with it.
  assert.equal(host.key("\u001b"), true, "escape is taken");
  assert.equal(host.key("\u001b[1;1:1B"), false, "and ↓ is free again");

  host.shutdown();
});

void test("Alt+O is hidden and does not enter scrolling when the tree fits", () => {
  __navigationForTests.enabled = true;
  const root = mkdtempSync(join(tmpdir(), "widget-fit-scroll-"));
  const host = harness();
  host.start();
  const directory = writeRun(join(root, "run-1"), runState({
    agents: [],
    phaseHistory: Array.from({ length: 7 }, (_, index) => ({ phase: `phase-${String(index)}`, afterAgent: 0 })),
  }));
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  const before = host.widgets.at(-1)(host.tui, theme).render(WIDTH);
  assert.doesNotMatch(plain(before[0]), /alt\+o to scroll/i);
  assert.equal(host.key("\u001bo"), false, "Alt+O passes through");
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
  host.key("\u001bo");
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
  assert.match(plain(resting[0]), /Alt\+O to scroll/, "and the way in is named");
  assert.ok(!resting.some((line) => line.includes("█")), "no scrollbar until it means something");

  host.key("\u001bo");
  const scrolling = draw();
  assert.ok(scrolling[0].startsWith("\u001b[33m╭"), "scrolling recolours the rules");
  assert.match(plain(scrolling[0]), /↑↓ move · esc exit/, "and names the way out");
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
  const draw = () => host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(stableLine);
  host.key("\u001bo");

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
  const draw = () => host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(stableLine);

  // Contiguity is the point: the resting view drops rows silently, so a window
  // that merely starts at the top is not enough — the rows after it must be
  // the ones that really follow. Scrolling to the end collects every row of
  // the tree in order; entering must show that sequence's first rows exactly.
  host.key("\u001bo");
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
  host.key("\u001bo");

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
  const body = () => host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(stableLine).slice(1, -1).join("\n");
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

/** Draws the current widget at a given width, colours stripped. */
const drawAt = (host, width) => host.widgets.at(-1)(host.tui, theme).render(width).map(plain);

function agent(id, name, state, extra = {}) {
  return {
    id,
    name,
    state,
    attempts: 1,
    startedAt: Date.now() - 5_000,
    durationMs: 1_000,
    tools: [],
    model: { model: "m" },
    accounting: { input: 1, output: 1, cacheRead: 0, cost: 0.001 },
    ...extra,
  };
}

function startRuns(runs, options = {}) {
  const root = mkdtempSync(join(tmpdir(), "widget-attention-"));
  const host = harness("session-1", options);
  host.start();
  for (const run of runs) {
    const directory = writeRun(join(root, run.id), runState(run));
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: run.id, runDirectory: directory, sessionId: "session-1" });
  }
  return host;
}

function silentAgent(id, name) {
  return agent(id, name, "running", { lastEventAt: Date.now() - 4 * 60_000, attemptDetails: [] });
}

void test("the title names runs, checkpoints waiting and quiet agents, only the non-zero parts", () => {
  const host = startRuns([
    { id: "run-1", workflowName: "one", agents: [silentAgent("q1", "asker")] },
    { id: "run-2", workflowName: "two", agents: [] },
  ]);
  host.emit(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, {
    runId: "run-2", runDirectory: undefined, sessionId: "session-1", name: "ok?", state: "awaiting",
  });
  assert.match(drawAt(host, 120)[0], /^╭ Workflows · 2 runs · ⚠ 1 quiet /, "invalid event leaves waiting out");
  host.shutdown();
});

void test("waiting checkpoints are counted in the title", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-waiting-"));
  const host = harness();
  host.start();
  const directory = writeRun(join(root, "run-1"), runState({ agents: [silentAgent("q1", "asker")] }));
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  host.emit(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, {
    runId: "run-1", runDirectory: directory, sessionId: "session-1", name: "ok?", state: "awaiting",
  });
  assert.match(drawAt(host, 120)[0], /^╭ Workflow · ◆ 1 waiting · ⚠ 1 quiet /);
  host.shutdown();
});

void test("the run row drops the running tag, keeps other tags, and shows phase and progress", () => {
  const host = startRuns([{
    id: "run-1",
    workflowName: "build",
    phase: "review",
    agents: [agent("a", "x", "completed"), agent("b", "y", "completed"), agent("c", "z", "completed"), agent("d", "w", "running"), agent("e", "v", "queued")],
  }]);
  const header = drawAt(host, 120).find((line) => line.includes("build"));
  assert.ok(header);
  assert.doesNotMatch(header, /\[running\]/);
  assert.match(header, /build · review · 3\/5/);
  host.shutdown();

  const paused = startRuns([{ id: "run-1", workflowName: "build", state: "paused", agents: [] }]);
  assert.match(drawAt(paused, 120).find((line) => line.includes("build")), /\[paused\] build/);
  paused.shutdown();
});

void test("the short run id shows only when two shown runs share a name", () => {
  const same = startRuns([
    { id: "aaaaaaaa-1111", workflowName: "twin", agents: [] },
    { id: "bbbbbbbb-2222", workflowName: "twin", agents: [] },
  ]);
  const frame = drawAt(same, 120).join("\n");
  assert.match(frame, /twin aaaaaaaa/);
  assert.match(frame, /twin bbbbbbbb/);
  assert.doesNotMatch(frame, /aaaaaaaa-/);
  same.shutdown();

  const distinct = startRuns([
    { id: "aaaaaaaa-1111", workflowName: "one", agents: [] },
    { id: "bbbbbbbb-2222", workflowName: "two", agents: [] },
  ]);
  assert.doesNotMatch(drawAt(distinct, 120).join("\n"), /aaaaaaaa|bbbbbbbb/);
  distinct.shutdown();
});

void test("nested agents draw their prefix with aligned stems at every depth", () => {
  const host = startRuns([{
    id: "run-1",
    phaseHistory: [{ phase: "p", afterAgent: 0 }, { phase: "q", afterAgent: 5 }],
    agents: [
      agent("a", "root", "running"),
      agent("b", "child", "running", { parentId: "a" }),
      agent("c", "grand", "running", { parentId: "b" }),
      agent("d", "sibling", "running", { parentId: "a" }),
      agent("e", "other", "running"),
    ],
  }]);
  const lines = drawAt(host, 120).map((line) => line.slice(2));
  const at = (name) => lines.find((line) => line.includes(name));
  assert.match(at("root"), /^ {2}│ ├─ /);
  assert.match(at("child"), /^ {2}│ │ ├─ /);
  assert.match(at("grand"), /^ {2}│ │ │ ╰─ /);
  assert.match(at("sibling"), /^ {2}│ │ ╰─ /);
  host.shutdown();
});

const many2 = (prefix, count, state) => Array.from({ length: count }, (_, i) => agent(`${prefix}${String(i)}`, `${prefix}-${String(i)}`, state));

void test("children and grandchildren of a last root draw blank stems", () => {
  const host = startRuns([{
    id: "run-1",
    agents: [
      agent("a", "first", "running"),
      agent("b", "root", "running"),
      agent("c", "kid", "running", { parentId: "b" }),
      agent("d", "grand", "running", { parentId: "c" }),
      agent("e", "grand2", "running", { parentId: "c" }),
    ],
  }]);
  const lines = drawAt(host, 120).map((line) => line.slice(2));
  const at = (name) => lines.find((line) => line.includes(name));
  assert.match(at("root"), /^ {4}╰─ .*root/);
  assert.match(at("kid"), /^ {6}╰─ .*kid/);
  assert.match(at("grand "), /^ {8}├─ .*grand/);
  assert.match(at("grand2"), /^ {8}╰─ .*grand2/);
  host.shutdown();
});

void test("a quiet grandchild keeps the agents that spawned it", () => {
  const host = startRuns([{
    id: "run-1",
    workflowName: "flow",
    agents: [
      agent("r", "root", "running"),
      ...Array.from({ length: 8 }, (_, i) => agent(`k${String(i)}`, `kid${String(i)}`, "completed", { parentId: "r" })),
      agent("p", "parentx", "completed", { parentId: "r" }),
      { ...silentAgent("q", "quietkid"), parentId: "p" },
      ...Array.from({ length: 6 }, (_, i) => agent(`s${String(i)}`, `after${String(i)}`, "completed", { parentId: "r" })),
    ],
  }]);
  const frame = drawAt(host, 120);
  const text = frame.join("\n");
  const p = frame.findIndex((line) => line.includes("parentx"));
  const q = frame.findIndex((line) => line.includes("quietkid"));
  assert.ok(p >= 0 && q > p, text);
  assert.ok(frame.some((line) => line.includes("root")), text);
  host.shutdown();
});

void test("the run row counts every settled agent, and an empty run shows 0/0", () => {
  const host = startRuns([{
    id: "run-1",
    workflowName: "mix",
    agents: [agent("a", "x", "completed"), agent("b", "y", "failed"), agent("c", "z", "cancelled"), agent("d", "w", "running")],
  }]);
  assert.match(drawAt(host, 120).find((line) => line.includes("mix")), /mix · (.* · )?3\/4/);
  host.shutdown();
  const empty = startRuns([{ id: "run-1", workflowName: "none", agents: [] }]);
  assert.match(drawAt(empty, 120).find((line) => line.includes("none")), /none · (.* · )?0\/0/);
  empty.shutdown();
});

void test("four runs keep every header within the rows and count the detail that does not fit", () => {
  const runs = Array.from({ length: 4 }, (_, r) => ({
    id: `run-${String(r)}`,
    workflowName: `flow${String(r)}`,
    agents: [
      agent(`a${String(r)}`, "first", "completed"),
      agent(`b${String(r)}`, "second", "running"),
      agent(`c${String(r)}`, "third", "completed"),
      agent(`d${String(r)}`, "fourth", "completed"),
    ],
  }));
  const host = startRuns(runs);
  const frame = drawAt(host, 120);
  const text = frame.join("\n");
  assertFits(frame, 120);
  for (let r = 0; r < 4; r += 1) assert.match(text, new RegExp(`flow${String(r)}`), text);
  assert.match(frame.at(-2), /│ … \d+ more +│$/, text);
  host.shutdown();
});

function assertFits(frame, width, label = "") {
  const text = frame.join("\n");
  assert.ok(frame.length <= 10, `${label}${String(width)}: ${String(frame.length)} lines\n${text}`);
  assert.ok(frame.every((line) => visibleWidth(line) <= width), `${label}fits ${String(width)}`);
}

void test("rows collapse in one ordered pass: headers, then what needs a person, then live and failed work, then the rest, and one row counts the others", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-one-pass-"));
  const host = harness();
  host.start();
  const work = [{ phase: "work", afterAgent: 0 }];
  const alpha = writeRun(join(root, "run-1"), runState({
    workflowName: "alpha",
    phaseHistory: work,
    agents: [...many2("done-a", 3, "completed"), agent("l", "live-a", "running"), agent("f", "broke", "failed"), silentAgent("q", "asker")],
  }));
  const beta = writeRun(join(root, "run-2"), runState({ id: "run-2", workflowName: "beta", phaseHistory: work, agents: many2("done-b", 3, "completed") }));
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: alpha, sessionId: "session-1" });
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-2", runDirectory: beta, sessionId: "session-1" });
  host.emit(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, { runId: "run-1", runDirectory: alpha, sessionId: "session-1", name: "ok?", state: "awaiting" });
  const frame = drawAt(host, 120);
  assert.equal(frame.length, 10, frame.join("\n"));
  const body = frame.slice(1, -1);
  // Fourteen rows: the seven kept are drawn in tree order, the other seven are counted.
  const expected = [/ alpha · /, /waiting: ok\?/, /╰─ \S work/, /live-a/, /broke/, /⚠ asker/, / beta · /, /^│ … 7 more +│$/];
  assert.equal(body.length, expected.length, frame.join("\n"));
  expected.forEach((pattern, index) => assert.match(body[index], pattern, frame.join("\n")));
  host.shutdown();
});

void test("quiet agents among completed ones take the rows, and no completed agent shows while one is hidden", () => {
  for (const phaseHistory of [undefined, [{ phase: "work", afterAgent: 0 }]]) {
    const agents = Array.from({ length: 11 }, (_, i) => i % 2 === 0 ? silentAgent(`q${String(i)}`, `q${String(i)}`) : agent(`x${String(i)}`, `x${String(i)}`, "completed"));
    const host = startRuns([{ id: "run-1", workflowName: "mix", ...(phaseHistory ? { phaseHistory } : {}), agents }]);
    const frame = drawAt(host, 120);
    assertFits(frame, 120);
    const text = frame.map(plain).join("\n");
    // The header and the phase leave five rows to quiet agents, above the count of the rest.
    for (let i = 0; i < 10; i += 2) assert.match(text, new RegExp(`q${String(i)}\\b`), text);
    assert.match(frame.at(-2), /… \d+ more/, text);
    assert.doesNotMatch(text, /✓ x\d/, text);
    host.shutdown();
  }
});

void test("eight run headers and a waiting checkpoint: the waiting row or its mark stays with the header", () => {
  const root = mkdtempSync(join(tmpdir(), "widget-waiting-eight-"));
  const host = harness();
  host.start();
  for (let index = 0; index < 8; index += 1) {
    const id = `run-${String(index)}`;
    const directory = writeRun(join(root, id), { ...runState(), id, workflowName: `flow-${String(index)}` });
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: id, runDirectory: directory, sessionId: "session-1" });
  }
  host.emit(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, { runId: "run-3", runDirectory: join(root, "run-3"), sessionId: "session-1", state: "awaiting", name: "ok?" });
  const frame = drawAt(host, 120);
  assertFits(frame, 120);
  assert.match(frame[0], /◆ 1 waiting/);
  const line = frame.map(plain).find((item) => item.includes("flow-3"));
  assert.ok(line !== undefined, "run-3 header is shown");
  assert.match(line, /◆ waiting/, frame.join("\n"));
  host.shutdown();
});

void test("quiet agents of several runs keep the phase they hang from, and the more-runs count has its own row", () => {
  const mix = (prefix, count) => Array.from({ length: count }, (_, i) => i % 2 === 0
    ? silentAgent(`${prefix}q${String(i)}`, `${prefix}q${String(i)}`)
    : agent(`${prefix}x${String(i)}`, `${prefix}x${String(i)}`, "completed"));
  for (const [runs, size] of [[3, 7], [5, 3], [4, 5]]) {
    const host = startRuns(Array.from({ length: runs }, (_, r) => ({ id: `run-${String(r)}`, workflowName: `m${String(r)}`, agents: mix(`r${String(r)}`, size) })));
    const frame = drawAt(host, 120);
    assertFits(frame, 120, `${String(runs)} runs: `);
    const body = frame.slice(1, -1);
    const text = body.join("\n");
    assert.doesNotMatch(text, /✓ r\dx/, text);
    assert.match(text, /… \d+ more/, text);
    // Every shown agent sits under a shown phase of its own run.
    let phase = false;
    for (const line of body) {
      if (/^│ \S/.test(line)) phase = false;
      else if (/^│ {3}[├╰]─/.test(line)) phase = true;
      else if (/⚠ r\dq/.test(line)) assert.ok(phase, `${line} has its phase\n${text}`);
    }
    host.shutdown();
  }
});

function tallRun(id = "run-1") {
  return runState({
    id,
    agents: [{
      id: "a1", name: "scout", state: "running", startedAt: Date.now(), tools: [],
      model: { model: "fixture-model" }, accounting: { input: 1, output: 1, cacheRead: 0, cost: 0 },
    }],
    phaseHistory: Array.from({ length: 10 }, (_, index) => ({ phase: `p${String(index)}`, afterAgent: index === 0 ? 0 : 1 })),
  });
}

function scrollHost(opener) {
  __navigationForTests.enabled = true;
  const root = mkdtempSync(join(tmpdir(), "widget-cursor-"));
  const host = harness("session-1", { opener: opener ?? { available: () => true, open: () => {} } });
  host.start();
  const directory = writeRun(join(root, "run-1"), tallRun());
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  const draw = () => host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain);
  // The row on the theme's selection background.
  const cursorLine = () => host.widgets.at(-1)(host.tui, { ...theme, fg: (_c, text) => text }).render(WIDTH).find((line) => line.includes("\u0001"))?.replaceAll("\u0001", "") ?? "";
  return { host, draw, cursorLine };
}

void test("Alt+O reaches the widget before an editor that binds it, in both encodings, only while the hint shows", () => {
  const { host, draw } = scrollHost();
  assert.match(draw()[0], /Alt\+O to scroll/);
  // The harness runs terminal-input listeners first, as Pi does; an editor like
  // pi-vim's would only see what they leave.
  assert.equal(host.key("\u001bo"), true, "legacy Alt+O is taken");
  assert.match(draw()[0], /enter open/);
  assert.equal(host.key("\u001b"), true);
  assert.equal(host.key("\u001b[111;3u"), true, "and so is the kitty form");
  assert.match(draw()[0], /enter open/);
  // Alt+O leaves scroll mode and is consumed, as esc and q are.
  assert.equal(host.key("\u001bo"), true, "Alt+O in scroll mode is taken");
  assert.match(draw()[0], /Alt\+O to scroll/, "and scroll mode is left");
  host.shutdown();

  const fits = harness();
  fits.start();
  const root = mkdtempSync(join(tmpdir(), "widget-alt-o-fit-"));
  fits.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: writeRun(join(root, "run-1"), runState()), sessionId: "session-1" });
  const renders = fits.renderRequests;
  assert.equal(fits.key("\u001bo"), false, "without the hint the key passes through");
  assert.equal(fits.renderRequests, renders, "and does nothing");
  fits.shutdown();
});

void test("the cursor moves with j/k and the arrows and the window follows it", () => {
  const { host, draw, cursorLine } = scrollHost();
  host.key("\u001bo");
  assert.match(cursorLine(), /smoke/, "starts on the run row");
  host.key("j");
  assert.match(cursorLine(), /p0/);
  host.key("\u001b[1;1:1B");
  assert.match(cursorLine(), /scout/);
  host.key("k");
  assert.match(cursorLine(), /p0/);
  for (let press = 0; press < 30; press += 1) host.key("j");
  assert.match(cursorLine(), /p9/, "stops on the last row");
  assert.ok(draw().some((line) => /p9/.test(line)), "and the window shows it");
  for (let press = 0; press < 30; press += 1) host.key("k");
  assert.match(cursorLine(), /smoke/);
  for (const line of draw()) assert.ok(visibleWidth(line) <= WIDTH);
  host.shutdown();
});

void test("enter opens the workspace on the node under the cursor and leaves scroll mode", () => {
  const opened = [];
  const { host, draw } = scrollHost({ available: () => true, open: (_context, key) => { opened.push(key); } });
  host.key("\u001bo");
  host.key("\r");
  assert.deepEqual(opened, ["run:run-1"]);
  assert.match(draw()[0], /Alt\+O to scroll/, "scroll mode is left");
  host.key("\u001bo");
  host.key("j");
  host.key("\r");
  host.key("\u001bo");
  host.key("j");
  host.key("j");
  host.key("\r");
  assert.deepEqual(opened, ["run:run-1", "run:run-1:node:phase/p0%231", "run:run-1:a1"]);
  host.shutdown();
});

void test("enter does nothing when the context cannot open the workspace", () => {
  const opened = [];
  const { host, draw } = scrollHost({ available: () => false, open: (_context, key) => { opened.push(key); } });
  host.key("\u001bo");
  assert.equal(host.key("\r"), true);
  assert.deepEqual(opened, []);
  assert.match(draw()[0], /esc exit/, "still in scroll mode");
  assert.doesNotMatch(draw()[0], /enter open/, "and the hint does not promise what cannot happen");
  host.shutdown();
});

const ALT_O = "\u001bo";
const JUMPS = [
  { name: "a repeated phase name opens the occurrence the workspace numbers, declared phases included",
    names: ["p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7", "p8", "p0"], declared: ["p0", "p0", "p0"],
    steps: [[[ALT_O, ...Array(30).fill("j"), "\r"], ["run:run-1:node:phase/p0%232"]], [[ALT_O, "j", "\r"], ["run:run-1:node:phase/p0%232", "run:run-1:node:phase/p0%231"]]] },
  { name: "a blank phase name in the history has no target and does not shift the next phase's node",
    names: [" ", "q0", "q1", "q2", "q3", "q4", "q5", "q6", "q7", "q8"],
    steps: [[[ALT_O, "j", "\r"], []], [["j", "\r"], ["run:run-1:node:phase/q0%231"]]] },
  { name: "a fractional afterAgent in the history does not shift the next phases' targets",
    names: Array.from({ length: 10 }, (_, index) => `p${String(index)}`), fraction: 1,
    steps: [[[ALT_O, "j", "j", "\r"], []], [["j", "\r"], ["run:run-1:node:phase/p2%231"]]] },
];
for (const { name, names, declared, fraction, steps } of JUMPS) {
  void test(name, () => {
    const opened = [];
    __navigationForTests.enabled = true;
    const root = mkdtempSync(join(tmpdir(), "widget-jump-"));
    const host = harness("session-1", { opener: { available: () => true, open: (_context, key) => { opened.push(key); } } });
    host.start();
    const phaseHistory = names.map((phase, index) => ({ phase, afterAgent: index === fraction ? 0.5 : 0 }));
    const directory = writeRun(join(root, "run-1"), runState({ agents: [], phaseHistory }));
    // Declared at launch: a phase that never ran counts toward the numbering.
    if (declared) writeFileSync(join(directory, "snapshot.json"), JSON.stringify({ phases: declared }));
    host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
    for (const [keys, expected] of steps) {
      for (const key of keys) host.key(key);
      assert.deepEqual(opened, expected);
    }
    host.shutdown();
  });
}

void test("h/j/k/l/q work when the terminal reports them as escape sequences", () => {
  const { host, draw, cursorLine } = scrollHost();
  const kitty = (letter) => `\u001b[${String(letter.charCodeAt(0))}u`;
  host.key("\u001bo");
  assert.equal(host.key(kitty("j")), true, "j is taken");
  assert.match(cursorLine(), /p0/);
  host.key(kitty("j"));
  assert.match(cursorLine(), /scout/);
  host.key(kitty("k"));
  assert.match(cursorLine(), /p0/);
  assert.equal(host.key(kitty("q")), true, "q is taken");
  assert.match(draw()[0], /Alt\+O to scroll/, "and leaves scroll mode");
  host.shutdown();
});

void test("in scroll mode a waiting run's header keeps its figures while its checkpoint row is just below the window", () => {
  __navigationForTests.enabled = true;
  const root = mkdtempSync(join(tmpdir(), "widget-scroll-waiting-"));
  const host = harness();
  host.start();
  const phases = (prefix) => Array.from({ length: 5 }, (_, index) => ({ phase: `${prefix}${String(index)}`, afterAgent: 0 }));
  const first = writeRun(join(root, "run-1"), runState({ workflowName: "alpha", agents: [], phaseHistory: phases("a") }));
  const second = writeRun(join(root, "run-2"), runState({ id: "run-2", workflowName: "beta", agents: [], phaseHistory: phases("b") }));
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: first, sessionId: "session-1" });
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-2", runDirectory: second, sessionId: "session-1" });
  host.emit(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, { runId: "run-2", runDirectory: second, sessionId: "session-1", name: "ok?", state: "awaiting" });
  const draw = () => host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain);
  assert.equal(host.key("\u001bo"), true);
  const frame = draw();
  const header = frame.find((line) => /beta/.test(line));
  assert.ok(header, frame.join("\n"));
  assert.ok(!frame.some((line) => /waiting: ok\?/.test(line)), `the checkpoint row is below the window\n${frame.join("\n")}`);
  assert.doesNotMatch(header, /◆ waiting/, frame.join("\n"));
  host.key("q");
  const rest = draw();
  assert.ok(rest.slice(1).some((line) => /◆ waiting/.test(line)), `at rest the frame still says it\n${rest.join("\n")}`);
  host.shutdown();
});

void test("agents before the first phase open the unassigned node, and a lone current phase opens that phase", () => {
  __navigationForTests.enabled = true;
  const root = mkdtempSync(join(tmpdir(), "widget-unphased-"));
  const names = Array.from({ length: 9 }, (_, index) => `p${String(index)}`);
  const opened = [];
  const first = harness("session-1", { opener: { available: () => true, open: (_context, key) => { opened.push(key); } } });
  first.start();
  const agentRecord = { id: "a1", name: "scout", state: "running", startedAt: Date.now(), tools: [], model: { model: "fixture-model" }, accounting: { input: 1, output: 1, cacheRead: 0, cost: 0 } };
  const before = writeRun(join(root, "run-1"), runState({ agents: [agentRecord], phaseHistory: names.map((phase) => ({ phase, afterAgent: 1 })) }));
  first.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: before, sessionId: "session-1" });
  first.key("\u001bo");
  first.key("j");
  first.key("\r");
  assert.deepEqual(opened, ["run:run-1:node:phase/unassigned"]);
  first.shutdown();

  const second = harness("session-1", { opener: { available: () => true, open: (_context, key) => { opened.push(key); } } });
  second.start();
  const only = writeRun(join(root, "run-2"), runState({ id: "run-2", phase: "llm", phaseHistory: [], agents: Array.from({ length: 12 }, (_, index) => ({ ...agentRecord, id: `b${String(index)}`, name: `w${String(index)}` })) }));
  second.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-2", runDirectory: only, sessionId: "session-1" });
  second.key("\u001bo");
  second.key("j");
  second.key("\r");
  assert.equal(opened[1], "run:run-2:node:phase/llm%231");
  second.shutdown();
});

void test("Alt+O in scroll mode is consumed also when the tree has shrunk to fit meanwhile", () => {
  __navigationForTests.enabled = true;
  const root = mkdtempSync(join(tmpdir(), "widget-alt-o-shrunk-"));
  const host = harness("session-1", { opener: { available: () => true, open: () => {} } });
  host.start();
  const directory = writeRun(join(root, "run-1"), tallRun());
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  assert.equal(host.key("\u001bo"), true);
  writeRun(directory, runState());
  host.emit(WORKFLOW_RUN_STATE_CHANGED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  assert.equal(host.key("\u001bo"), true, "leaving scroll mode keeps the key from the editor");
  assert.doesNotMatch(drawAt(host, WIDTH)[0], /esc exit/);
  host.shutdown();
  rmSync(root, { recursive: true, force: true });
});

void test("a pi-vim-like editor that swallows Alt+O never sees it while the hint shows", () => {
  const { host, draw } = scrollHost();
  const seen = [];
  const editorKey = (data) => { if (data === "\u001bo") { seen.push(data); return true; } return false; };
  const press = (data) => host.key(data) || editorKey(data);
  press("\u001bo");
  assert.deepEqual(seen, [], "the editor never saw the key");
  assert.match(draw()[0], /esc exit/);
  press("q");
  host.shutdown();
  // Without the hint the key belongs to the editor.
  const fits = harness();
  fits.start();
  const root = mkdtempSync(join(tmpdir(), "widget-vim-fit-"));
  fits.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: writeRun(join(root, "run-1"), runState()), sessionId: "session-1" });
  const reached = [];
  assert.equal(fits.key("\u001bo") || (reached.push("o"), editorKey("\u001bo")), true);
  assert.deepEqual(reached, ["o"]);
  fits.shutdown();
});

const lane = (id, name, state, structuralPath, extra = {}) => agent(id, name, state, { structuralPath, ...extra });

function lanesRun(extra = {}) {
  return {
    id: "run-1",
    workflowName: "agents-followups",
    phase: undefined,
    phaseHistory: [],
    agents: [
      lane("s1", "scout", "completed", ["lanes", "source"]),
      lane("s2", "impl", "completed", ["lanes", "source"]),
      lane("w1", "widget-impl", "running", ["lanes", "widget"]),
      lane("k1", "ws-impl", "running", ["lanes", "workspace"]),
      lane("k2", "ws-review", "running", ["lanes", "workspace", "verify", "review"]),
    ],
    ...extra,
  };
}

/** A background subagent as the core host observes it: its latest status and the request that started it. */
function backgroundSubagent(id, label, extra = {}) {
  const now = Date.now();
  return {
    status: {
      id,
      sessionId: "session-1",
      state: "running",
      startedAt: now - 5_000,
      progress: { lastEventAt: now, toolCalls: [], accounting: { input: 1_000, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.01 }, state: { model: { provider: "p", model: "sub-model" } } },
      ...extra.status,
    },
    request: { prompt: "work", mode: "background", label, ...extra.request },
  };
}

function quietSubagent(id, label, silentMs = 4 * 60_000) {
  const entry = backgroundSubagent(id, label);
  return { ...entry, status: { ...entry.status, progress: { ...entry.status.progress, lastEventAt: Date.now() - silentMs } } };
}

/** Runs and background subagents in one widget; `set` changes a subagent and tells the widget, as the host's observer does. */
function subagentHost(runs, subagents, options = {}) {
  const live = new Map(subagents.map((entry) => [entry.status.id, entry]));
  const host = startRuns(runs, { ...options, subagents: () => live.values() });
  host.controller.subagentsChanged();
  return { host, live, set: (entry) => { live.set(entry.status.id, entry); host.controller.subagentsChanged(); } };
}

void test("background subagents draw as one Subagents group after the runs, a row each, and the title counts them", () => {
  const { host, set } = subagentHost([{ id: "run-1", workflowName: "flow", agents: [agent("a1", "scout", "running")] }], [
    backgroundSubagent("s1", "alpha"),
    backgroundSubagent("s2", "beta", { status: { attempts: 2 } }),
    backgroundSubagent("s3", "foreground", { request: { mode: "foreground" } }),
    backgroundSubagent("s4", "finished", { status: { state: "completed" } }),
  ]);
  for (const width of [120, 70, 40]) assertFits(drawAt(host, width), width);
  const frame = drawAt(host, 120).map(stableLine);
  const text = frame.join("\n");
  assert.match(frame[0], /^╭ Workflows · 1 run · 2 subagents ─/, text);
  const at = (pattern) => frame.findIndex((line) => pattern.test(line));
  assert.ok(at(/⣷ flow/) > 0 && at(/scout/) > at(/⣷ flow/), text);
  assert.ok(at(/Subagents/) > at(/scout/), `the group comes after the runs\n${text}`);
  assert.match(frame[at(/alpha/)], /^│ {3}├─ ⣷ alpha +sub-model · 1\.2kt · \$0\.01 · 00:00 │$/, text);
  assert.match(frame[at(/beta/)], /^│ {3}╰─ ⣷ beta +sub-model · 1\.2kt · \$0\.01 · 00:00 · attempt 2 │$/, text);
  assert.ok(at(/beta/) > at(/alpha/) && at(/alpha/) > at(/Subagents/), text);
  assert.ok(!/foreground|finished/.test(text), `foreground and settled subagents are not drawn\n${text}`);
  // A status the observer reports reaches the frame.
  set(backgroundSubagent("s5", "gamma"));
  assert.match(drawAt(host, 120)[0], /^╭ Workflows · 1 run · 3 subagents /);
  assert.ok(drawAt(host, 120).some((line) => /gamma/.test(line)));
  set(backgroundSubagent("s1", "alpha", { status: { state: "failed" } }));
  assert.ok(!drawAt(host, 120).some((line) => /alpha/.test(line)), "a settled subagent leaves the group");
  host.shutdown();
});

void test("with only subagents running the widget still shows, and clears when the last one settles", () => {
  const { host, set } = subagentHost([], [backgroundSubagent("s1", "alpha"), quietSubagent("s2", "beta")]);
  for (const width of [120, 70, 40]) assertFits(drawAt(host, width), width);
  const frame = drawAt(host, 120).map(stableLine);
  assert.match(frame[0], /^╭ Workflows · 2 subagents · ⚠ 1 quiet ─/, frame.join("\n"));
  assert.match(frame[1], /^│ ⣷ Subagents/);
  assert.ok(drawAt(host, 120).some((line) => /^│ {3}╰─ ⚠ beta {2}quiet 04:00 /.test(line)), frame.join("\n"));
  set(backgroundSubagent("s1", "alpha", { status: { state: "completed" } }));
  set(backgroundSubagent("s2", "beta", { status: { state: "stopped" } }));
  assert.equal(host.frames.at(-1), undefined, "the frame is cleared");
  host.shutdown();
});

void test("subagent progress repaints only when the background subagents shown change: twenty events in a second ask for one repaint at most", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: Date.now() });
  const { host, set } = subagentHost([], [backgroundSubagent("s1", "alpha")]);
  const mounts = host.widgets.length;
  const renders = host.renderRequests;
  for (let event = 0; event < 20; event += 1) {
    set(backgroundSubagent("s1", "alpha", { status: { progress: { lastEventAt: Date.now(), toolCalls: [], accounting: { input: 1_000 + event, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.01 } } } }));
    t.mock.timers.tick(50);
  }
  assert.equal(host.widgets.length, mounts, "progress does not remount the widget");
  assert.ok(host.renderRequests - renders <= 1, `twenty progress events in a second ask for ${String(host.renderRequests - renders)} repaints`);
  const before = host.renderRequests;
  set(backgroundSubagent("s2", "beta"));
  assert.equal(host.renderRequests, before + 1, "a new background subagent repaints at once");
  set(backgroundSubagent("s3", "fore", { request: { mode: "foreground" } }));
  assert.equal(host.renderRequests, before + 1, "a foreground subagent does not repaint");
  host.shutdown();
});

void test("a frame without subagents is byte-identical to one drawn without the subagent reader", () => {
  const runs = [lanesRun(), { id: "run-2", workflowName: "two", agents: [silentAgent("q1", "asker")] }];
  const without = startRuns(runs);
  const { host: empty } = subagentHost(runs, []);
  // Colours kept: only the spinner glyph and the clocks, which move between two draws, are normalized.
  const raw = (line) => line.replace(/[⣷⣯⣟⡿⢿⣽⣻]/g, "⣷").replace(/\b\d{2}:\d{2}\b/g, "00:00");
  for (const width of [120, 70, 40]) assert.deepEqual(empty.widgets.at(-1)(empty.tui, theme).render(width).map(raw), without.widgets.at(-1)(without.tui, theme).render(width).map(raw), `at ${String(width)}`);
  without.shutdown();
  empty.shutdown();
});

void test("many subagents and runs share the ten rows: headers stay and the rest is counted", () => {
  const runs = [0, 1, 2].map((index) => ({ id: `run-${String(index)}`, workflowName: `flow${String(index)}`, agents: many2(`r${String(index)}a`, 3, "running") }));
  const subagents = Array.from({ length: 10 }, (_, index) => backgroundSubagent(`s${String(index)}`, `sub-${String(index)}`));
  const { host } = subagentHost(runs, subagents);
  for (const width of [120, 70, 40]) {
    const frame = drawAt(host, width);
    assertFits(frame, width);
    const text = frame.join("\n");
    for (let index = 0; index < 3; index += 1) assert.match(text, new RegExp(`flow${String(index)}`), text);
    assert.match(text, /Subagents/, text);
    assert.doesNotMatch(text, /more runs?/, text);
  }
  const frame = drawAt(host, 120).map(stableLine);
  const text = frame.join("\n");
  assert.match(frame.at(-2), /│ … \d+ more +│$/, text);
  assert.match(frame[0], /^╭ Workflows · 3 runs · 10 subagents /, text);
  host.shutdown();
});

void test("a quiet subagent ranks like a quiet agent: it is kept when its siblings fold, and the title counts it", () => {
  const subagents = [...Array.from({ length: 11 }, (_, index) => backgroundSubagent(`s${String(index)}`, `sub-${String(index)}`)), quietSubagent("q", "asker", 11 * 60_000)];
  const { host } = subagentHost([{ id: "run-1", workflowName: "flow", agents: many2("d", 6, "completed") }], subagents);
  for (const width of [120, 70, 40]) assertFits(drawAt(host, width), width);
  const frame = drawAt(host, 120).map(stableLine);
  const text = frame.join("\n");
  assert.match(frame[0], /^╭ Workflows · 1 run · 12 subagents · ⚠ 1 quiet /, text);
  assert.ok(drawAt(host, 120).some((line) => /⚠ asker {2}stalled 11:00/.test(line)), text);
  assert.ok(frame.some((line) => /flow/.test(line)), text);
  host.shutdown();
});

void test("the scroll cursor walks the group and its rows; enter opens subagents or the subagent", () => {
  __navigationForTests.enabled = true;
  const opened = [];
  const root = mkdtempSync(join(tmpdir(), "widget-subagent-cursor-"));
  const live = new Map([backgroundSubagent("s1", "alpha"), backgroundSubagent("s2", "beta")].map((entry) => [entry.status.id, entry]));
  const host = harness("session-1", { opener: { available: () => true, open: (_context, key) => { opened.push(key); } }, subagents: () => live.values() });
  host.start();
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: writeRun(join(root, "run-1"), tallRun()), sessionId: "session-1" });
  const draw = () => host.widgets.at(-1)(host.tui, theme).render(WIDTH).map(plain);
  const cursorLine = () => host.widgets.at(-1)(host.tui, { ...theme, fg: (_c, text) => text }).render(WIDTH).find((line) => line.includes("\u0001"))?.replaceAll("\u0001", "") ?? "";
  assert.match(draw()[0], /Alt\+O to scroll/);
  host.key("\u001bo");
  for (let press = 0; press < 30; press += 1) host.key("j");
  assert.match(cursorLine(), /beta/, "the last row is the last subagent");
  host.key("\r");
  assert.deepEqual(opened, ["subagent:s2"]);
  host.key("\u001bo");
  for (let press = 0; press < 30; press += 1) host.key("j");
  host.key("k");
  assert.match(cursorLine(), /alpha/);
  host.key("k");
  assert.match(cursorLine(), /Subagents/);
  host.key("\r");
  assert.deepEqual(opened, ["subagent:s2", "subagents"]);
  for (const line of draw()) assert.ok(visibleWidth(line) <= WIDTH);
  host.shutdown();
});

void test("mark draws the spinner for a running unit only while it is live", () => {
  const paint = (_role, text) => text;
  assert.notEqual(mark("running", 0, paint), "·");
  assert.equal(mark("running", 0, paint, true), mark("running", 0, paint));
  assert.equal(mark("running", 0, paint, false), "·");
  assert.equal(mark("completed", 0, paint, false), "✓");
});
