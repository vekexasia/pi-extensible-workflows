import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import widget, { renderReceipt } from "../dist/index.js";
import {
  WORKFLOW_AGENT_STATE_CHANGED_EVENT,
  WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT,
  WORKFLOW_RUN_COMPLETED_EVENT,
  WORKFLOW_RUN_STARTED_EVENT,
  WORKFLOW_RUN_STATE_CHANGED_EVENT,
} from "pi-extensible-workflows";

const theme = { fg: (_colour, text) => text, bold: (text) => text };

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
function harness(sessionId = "session-1") {
  const handlers = new Map();
  const events = new Map();
  const frames = [];
  const widgets = [];
  const entries = [];
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
  };

  const context = {
    hasUI: true,
    sessionManager: { getSessionId: () => sessionId, getEntries: () => [] },
    // The widget registers a factory so it is built at the width the TUI is
    // about to draw with. Render it the way the host does, at a fixed width.
    ui: {
      setWidget: (_key, value) => {
        widgets.push(value);
        frames.push(typeof value === "function" ? value().render(WIDTH) : value);
      },
    },
  };

  widget(pi);
  return {
    context,
    frames,
    widgets,
    entries,
    get renderer() { return renderer; },
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

void test("the receipt shows phases, per-agent models, tools and the token split", () => {
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
      { name: "scout", state: "completed", model: "fixture-model:high", role: "scout", requestedModel: "scout-model", tools: ["read", "grep"], input: 30_000, output: 900, cacheRead: 80_000, costUsd: 0.09, durationMs: 31_000, attempts: 1 },
      { name: "reviewer", state: "failed", model: "fixture-model:xhigh", role: "reviewer", tools: ["read"], input: 50_000, output: 200, cacheRead: 120_000, costUsd: 0.31, durationMs: 15_000, attempts: 3 },
    ],
    error: "reviewer was interrupted before it answered",
  }, false, theme);

  const body = lines.join("\n");
  assert.match(body, /deliver/);
  assert.match(body, /scout/);
  assert.match(body, /review/);
  assert.match(body, /role scout · via scout-model · read grep/);
  assert.match(body, /in 30kt · out 900t · cache 80kt/);
  assert.match(body, /3 attempts/, "a retried agent says so");
  assert.match(body, /interrupted before it answered/);
  assert.doesNotMatch(body, /run-1/, "the run id stays hidden until expanded");

  assert.match(renderReceipt({
    runId: "run-1", workflow: "smoke", state: "completed", costUsd: 0, tokens: 0, durationMs: 0,
    phases: [], phaseBoundaries: [], agents: [],
  }, true, theme).join("\n"), /run run-1/);
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
    });
    handlers.get("session_start")(undefined, {
      hasUI: true,
      sessionManager: { getSessionId: () => "session-1", getEntries: () => [] },
      ui: { setWidget: () => {} },
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
  const sessions = [{ transport: "local", sessionId: "s", locator: { sessionFile: oldTranscript } }];

  const quiet = writeRun(join(root, "run-1"), {
    ...state,
    agentSessions: sessions,
    agents: [{ ...state.agents[0], lastEventAt: Date.now() - 4 * 60_000 }],
  });
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-1", runDirectory: quiet, sessionId: "session-1" });
  assert.match(host.frames.at(-1).map(plain).join("\n"), /quiet 04:0\d/, "the silence is shown with its length");

  // Past the core's own stall threshold it stops being merely quiet.
  const deadTranscript = join(root, "dead.jsonl");
  writeFileSync(deadTranscript, "{}\n");
  utimesSync(deadTranscript, new Date(Date.now() - 11 * 60_000), new Date(Date.now() - 11 * 60_000));

  const stalled = writeRun(join(root, "run-2"), {
    ...state,
    agentSessions: [{ transport: "local", sessionId: "s2", locator: { sessionFile: deadTranscript } }],
    agents: [{ ...state.agents[0], lastEventAt: Date.now() - 11 * 60_000 }],
  });
  host.emit(WORKFLOW_RUN_STARTED_EVENT, { runId: "run-2", runDirectory: stalled, sessionId: "session-1" });
  assert.match(host.frames.at(-1).map(plain).join("\n"), /stalled 11:0\d/, "a stalled agent says so");

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

  host.emit(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, { runId: "run-1", name: "merge the MR?", state: "awaiting" });
  assert.match(host.frames.at(-1).map(plain).join("\n"), /waiting: merge the MR\?/, "the question is shown");

  // A re-read of the state file must not lose it: disk knows nothing of checkpoints.
  host.emit(WORKFLOW_RUN_STATE_CHANGED_EVENT, { runId: "run-1", runDirectory: directory, sessionId: "session-1" });
  assert.match(host.frames.at(-1).map(plain).join("\n"), /waiting: merge the MR\?/, "it survives a state re-read");

  host.emit(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, { runId: "run-1", name: "merge the MR?", state: "approved" });
  assert.doesNotMatch(host.frames.at(-1).map(plain).join("\n"), /waiting/, "answering clears it");

  host.shutdown();
});

void test("an agent with no role does not bury the receipt under its toolbox", () => {
  // A role grants a handful of tools and naming them is the point. An agent
  // without one inherits everything the host has, and sixty-odd names say
  // nothing while pushing the rest of the receipt off the screen.
  const many = Array.from({ length: 66 }, (_unused, index) => `tool${String(index)}`);
  const lines = renderReceipt(
    {
      runId: "run-1",
      workflowName: "gate",
      state: "completed",
      tokens: 100,
      cost: 0.01,
      durationMs: 1_000,
      phases: [{ name: "after", state: "completed" }],
      phaseBoundaries: [0],
      agents: [{ name: "scout", state: "completed", tools: many, input: 10, output: 5, cacheRead: 0, cost: 0.01, durationMs: 1_000, attempts: 1 }],
    },
    { expanded: false },
    theme,
  ).map(plain);

  const toolLine = lines.find((line) => line.includes("tool0"));
  assert.ok(toolLine, "the tools are still mentioned");
  assert.ok(toolLine.includes("+58 more"), `the tail is folded away, got: ${toolLine}`);
  assert.ok(!toolLine.includes("tool65"), "the last of sixty-six names is not printed");
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
    agentSessions: [{ transport: "local", sessionId: "s", locator: { sessionFile: transcript } }],
    agents: [{ ...state.agents[0], lastEventAt: Date.now() - 8 * 60_000 }],
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
  assert.ok(frame.length <= 20, `the frame stays within its row budget, got ${frame.length}`);
  assert.match(plain(frame.at(-1)), /^╰─+╯$/, "the border still closes");

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
