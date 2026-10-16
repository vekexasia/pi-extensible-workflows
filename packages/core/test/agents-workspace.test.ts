import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after, type TestContext } from "node:test";
import type { ExtensionCommandContext, KeybindingsManager as PiKeybindings, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, TuiAltScreen, truncateToWidth, visibleWidth, type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
import type { SessionAgent, SessionAgentsSource, SessionTreeNode, TranscriptView } from "../src/agents-workspace-contract.js";
import { openAgentsWorkspace } from "../src/agents-workspace.js";
import { formatWorkflowTreeLine } from "../src/host-view.js";
import { createLaunchSnapshot, DEFAULT_SETTINGS, formatWorkflowPhaseDashboard, RunStore, type AgentRecord, type PersistedRun, type RunState } from "../src/index.js";
import { createSessionAgentsSource } from "../src/session-agents.js";
import type { TranscriptLiveStream, TranscriptPoll, TranscriptRecord, TranscriptSource } from "../src/transcript-source.js";
import type { WorkflowAgentSessionEvent } from "../src/types.js";

const ESC = "\x1b";
const KEY = { up: `${ESC}[A`, down: `${ESC}[B`, left: `${ESC}[D`, right: `${ESC}[C`, home: `${ESC}[H`, ctrlHome: `${ESC}[1;5H`, ctrlEnd: `${ESC}[1;5F`, pageUp: `${ESC}[5~`, pageDown: `${ESC}[6~`, tab: "\t", enter: "\r", escape: ESC, ctrlC: "\x03", ctrlO: "\x0f", search: `${ESC}[102;6u` };
const THEME = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as unknown as Theme;
const KEYBINDINGS = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } }) as unknown as PiKeybindings;

function tick(): Promise<void> { return new Promise((resolve) => { setImmediate(resolve); }); }
async function settle(): Promise<void> { for (let round = 0; round < 10; round += 1) await tick(); }

class FakeTerminal implements Terminal {
  input: ((data: string) => void) | undefined;
  written = "";
  /** Thrown by start() while set. */
  failStart: Error | undefined;
  /** Thrown by stop() while set, before it lets the input go, as a setRawMode on a closed TTY. */
  failStop: Error | undefined;
  constructor(public columns: number, public rows: number) {}
  start(onInput: (data: string) => void): void { if (this.failStart) throw this.failStart; this.input = onInput; }
  stop(): void { if (this.failStop) throw this.failStop; this.input = undefined; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.written += data; }
  get kittyProtocolActive(): boolean { return false; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

function entry(offset: number, text = `record ${String(offset)}`): TranscriptRecord { return { kind: "entry", offset, bytes: 10, value: { type: "message", text } }; }
function entries(from: number, count: number): TranscriptRecord[] { return Array.from({ length: count }, (_, index) => entry(from + index)); }
function large(offset: number): TranscriptRecord { return { kind: "large", offset, bytes: 2_000_000 }; }
function polled(appended: readonly TranscriptRecord[], options: Partial<TranscriptPoll> = {}): TranscriptPoll { return { status: "available", reset: false, atStart: false, appended, ...options }; }
function label(record: TranscriptRecord): string { return record.kind === "entry" ? typeof record.value.text === "string" ? record.value.text : "" : `${record.kind} ${String(record.offset)}`; }

type Earlier = { readonly records: readonly TranscriptRecord[]; readonly atStart: boolean };
class FakeSource implements TranscriptSource {
  readonly calls: string[] = [];
  /** Results of the next polls; an error rejects that poll. */
  readonly polls: (TranscriptPoll | Error)[] = [];
  readonly earlier: Earlier[] = [];
  /** Rejects every loadEarlier while set. */
  failEarlier: Error | undefined;
  overlapped = false;
  private active = 0;
  constructor(readonly key: string) {}
  poll(): Promise<TranscriptPoll> { return this.run("poll", () => { const next = this.polls.shift(); if (next instanceof Error) throw next; return next ?? polled([]); }); }
  loadEarlier(): Promise<Earlier> { return this.run("loadEarlier", () => { if (this.failEarlier) throw this.failEarlier; return this.earlier.shift() ?? { records: [], atStart: true }; }); }
  loadRecord(record: { readonly offset: number; readonly bytes: number }): Promise<TranscriptRecord> { return this.run(`loadRecord:${String(record.offset)}`, () => entry(record.offset, `full ${String(record.offset)}`)); }
  close(): Promise<void> { return this.run("close", () => undefined); }
  count(name: string): number { return this.calls.filter((call) => call === name).length; }
  /** Every call settles a turn of the event loop later, so overlapping calls would be seen. */
  private async run<T>(name: string, result: () => T): Promise<T> {
    this.calls.push(name);
    this.active += 1;
    if (this.active > 1) this.overlapped = true;
    await tick();
    this.active -= 1;
    return result();
  }
}

class FakeView implements TranscriptView {
  readonly calls: string[] = [];
  items: TranscriptRecord[] = [];
  readonly component: Component;
  /** append and live throw while set; render throws once. */
  readonly fail: { append?: Error | undefined; live?: Error | undefined; render?: Error | undefined } = {};
  /** `wrap` gives each record a line of `wrap` columns broken at the width, so its height depends on the width. */
  constructor(readonly key: string, readonly ui: TUI, readonly cwd: string, wrap?: number) {
    this.component = { render: (width) => {
      const error = this.fail.render;
      if (error) { this.fail.render = undefined; throw error; }
      return this.lines(width, wrap);
    }, invalidate() {} };
  }
  private lines(width: number, wrap: number | undefined): string[] {
    return this.items.flatMap((item) => {
      const text = `${this.key} ${label(item)}`;
      if (wrap === undefined) return [truncateToWidth(text, width)];
      const line = text.padEnd(wrap, ".");
      return Array.from({ length: Math.ceil(line.length / width) }, (_, index) => line.slice(index * width, (index + 1) * width));
    });
  }
  reset(): void { this.calls.push("reset"); this.items = []; }
  append(records: readonly TranscriptRecord[]): void { this.calls.push(`append:${String(records.length)}`); if (this.fail.append) throw this.fail.append; this.items.push(...records); }
  prepend(records: readonly TranscriptRecord[]): void { this.calls.push(`prepend:${String(records.length)}`); this.items.unshift(...records); }
  replace(record: TranscriptRecord): void { this.calls.push(`replace:${String(record.offset)}`); this.items = this.items.map((item) => item.offset === record.offset ? record : item); }
  pendingLarge(): readonly { readonly offset: number; readonly bytes: number }[] { return this.items.filter((item) => item.kind === "large").map(({ offset, bytes }) => ({ offset, bytes })); }
  setExpanded(expanded: boolean): void { this.calls.push(`expanded:${String(expanded)}`); }
  live(event: WorkflowAgentSessionEvent): void { this.calls.push(`live:${event.type}`); if (this.fail.live) throw this.fail.live; }
  dispose(): void { this.calls.push("dispose"); }
}

class FakeLive implements TranscriptLiveStream {
  readonly listeners = new Set<(event: WorkflowAgentSessionEvent) => void>();
  unsubscribed = 0;
  subscribe(listener: (event: WorkflowAgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => { this.unsubscribed += 1; this.listeners.delete(listener); };
  }
  emit(event: WorkflowAgentSessionEvent): void { for (const listener of this.listeners) listener(event); }
}

/** A sidebar node: an agent when `agent` is set; nodes come in sidebar order, a parent before its children. */
interface Spec { readonly key: string; readonly parent?: string; readonly kind?: SessionTreeNode["kind"]; readonly label?: string; readonly state?: RunState; readonly expanded?: boolean; readonly agent?: SessionAgent }
/** Nodes drawn with the /workflow row formatter, as the source draws them; a node that is not an agent details itself as "details of <label>" and "state <state>". */
function tree(specs: readonly Spec[]): SessionTreeNode[] {
  const depths = new Map<string, number>();
  return specs.map((spec) => {
    const depth = spec.parent === undefined ? 0 : (depths.get(spec.parent) ?? 0) + 1;
    depths.set(spec.key, depth);
    const label = spec.agent?.name ?? spec.label ?? spec.key;
    const state = spec.agent ? spec.agent.state === "completed" || spec.agent.state === "failed" ? spec.agent.state : "running" : spec.state ?? "running";
    const kind = spec.kind ?? (spec.agent ? "agent" : "phase");
    const children = specs.filter((child) => child.parent === spec.key).map(({ key }) => key);
    return {
      key: spec.key, parentKey: spec.parent, depth, kind, initiallyExpanded: spec.expanded ?? children.length > 0, agent: spec.agent,
      line: (styles, selected, expanded) => formatWorkflowTreeLine({ kind, label, depth, state, children }, selected, expanded, styles),
      details: () => spec.agent ? [] : [`details of ${label}`, `state ${state}`],
      title: () => `${label} ${state}`,
    };
  });
}
/** An agent as the tests list it: in `group` (a run, or "Subagents"), `depth` agents below the group's first level. */
type Listed = SessionAgent & { readonly group?: string; readonly depth?: number };
function agent(key: string, options: Partial<Listed> = {}): Listed {
  return { key, name: key, state: "running", summary: "gpt-5 1.2k tok", cwd: `/project/${key}`, attempt: 1, owned: true, session: { transport: "pi", sessionId: `${key}-1` }, live: undefined, activity: undefined, running: true, ...options };
}
/** The tree of listed agents: a run node per group ("build a1b2" by default; "Subagents" gives the group node), each agent under the agent before it with a smaller depth. */
function nodesOf(agents: readonly Listed[]): SessionTreeNode[] {
  const specs: Spec[] = [];
  let group: string | undefined;
  let chain: string[] = [];
  for (const listed of agents) {
    const name = listed.group ?? "build a1b2";
    if (name !== group) {
      group = name;
      const key = name === "Subagents" ? "subagents" : `run:${name}`;
      specs.push({ key, kind: name === "Subagents" ? "group" : "run", label: name });
      chain = [key];
    }
    chain = chain.slice(0, (listed.depth ?? 0) + 1);
    const parent = chain.at(-1);
    specs.push(parent === undefined ? { key: listed.key, agent: listed } : { key: listed.key, parent, agent: listed });
    chain.push(listed.key);
  }
  return tree(specs);
}
const AGENTS = (): Listed[] => [agent("alpha"), agent("beta", { depth: 1, state: "completed", running: false }), agent("scout", { group: "Subagents", state: "failed", running: false })];
/**
 * run:R
 *   P (phase)
 *     O (operation): a, b
 *     c
 * subagents: s
 */
const TREE = (): Spec[] => [
  { key: "run:R", kind: "run", label: "Workflow" },
  { key: "P", parent: "run:R" },
  { key: "O", parent: "P", kind: "operation" },
  { key: "a", parent: "O", agent: agent("a") },
  { key: "b", parent: "O", agent: agent("b", { state: "completed", running: false }) },
  { key: "c", parent: "P", agent: agent("c") },
  { key: "subagents", kind: "group", label: "Subagents" },
  { key: "s", parent: "subagents", agent: agent("s") },
];

interface Harness {
  readonly terminal: FakeTerminal;
  /** Calls on the fake parent TUI, in order. */
  readonly parent: string[];
  readonly overlays: (boolean | undefined)[];
  agents: Listed[];
  /** Listed instead of the agents' tree while set. */
  nodes: SessionTreeNode[] | undefined;
  /** Rejects every list() while set. */
  listError: Error | undefined;
  /** Thrown synchronously by every list() while set. */
  listThrow: Error | undefined;
  /** Thrown by the fake parent TUI's start() while set, after it was recorded. */
  parentStartError: Error | undefined;
  listCalls: number;
  readonly notified: string[];
  readonly opened: string[];
  readonly sources: FakeSource[];
  readonly views: FakeView[];
  readonly done: Promise<void>;
  left: boolean;
  alt(): TuiAltScreen;
  /** Renders a frame now and returns its rows without escape sequences. */
  screen(): string[];
  send(...keys: string[]): void;
  source(key: string): FakeSource;
  view(key: string): FakeView;
}

/**
 * Opens the workspace with fake Pi pieces; `setup` runs for each source before its first poll settles; `wrap` makes views that wrap;
 * `fail` makes opening fail before the workspace exists (the cursor query) or after it was built (the terminal's start);
 * `listThrow` sets harness.listThrow from the start; `listGate` holds every list() until it resolves; createView throws for `failView`;
 * the view of `failRender` throws from its first render; `nodes` sets harness.nodes; `source` lists instead of the harness.
 */
async function open(agents: Listed[], options: { columns?: number; rows?: number; initialKey?: string; signal?: AbortSignal; wrap?: number; fail?: "cursor" | "start"; listThrow?: Error; listGate?: Promise<void>; failView?: string; failRender?: string; setup?: (source: FakeSource) => void; nodes?: SessionTreeNode[]; source?: SessionAgentsSource } = {}): Promise<Harness> {
  const terminal = new FakeTerminal(options.columns ?? 120, options.rows ?? 20);
  if (options.fail === "start") terminal.failStart = new Error("terminal unavailable");
  const parent: string[] = [];
  const parentTui = {
    terminal,
    getShowHardwareCursor: () => { if (options.fail === "cursor") throw new Error("no cursor"); return false; },
    stop(stopOptions?: { preserveScreen?: boolean }) { parent.push(`stop:${String(stopOptions?.preserveScreen)}`); },
    start() { parent.push("start"); if (harness.parentStartError) throw harness.parentStartError; },
    renderNow(force?: boolean) { parent.push(`renderNow:${String(force)}`); },
  } as unknown as TUI;
  const overlays: (boolean | undefined)[] = [];
  let ui: TUI | undefined;
  const ctx = {
    cwd: "/project",
    signal: options.signal,
    ui: {
      custom: (factory: (tui: TUI, theme: Theme, keybindings: PiKeybindings, done: (result: undefined) => void) => Component, customOptions?: { overlay?: boolean }) => new Promise<undefined>((resolve) => {
        overlays.push(customOptions?.overlay);
        const placeholder = factory(parentTui, THEME, KEYBINDINGS, resolve);
        assert.ok(placeholder.render(40).every((line) => visibleWidth(line) <= 40));
      }),
      notify: (message: string, type?: string) => { harness.notified.push(`${type ?? "info"}: ${message}`); },
    },
  } as unknown as ExtensionCommandContext;
  const harness: Harness = {
    terminal, parent, overlays, agents, nodes: options.nodes, listError: undefined, listThrow: options.listThrow, parentStartError: undefined, listCalls: 0, notified: [], opened: [], sources: [], views: [], left: false,
    done: Promise.resolve(),
    alt() { assert.ok(ui instanceof TuiAltScreen, "a view was created on the alt screen"); return ui; },
    screen() { const alt = harness.alt(); alt.renderNow(); return alt.getScreenLines().map((line) => stripTerminalSequences(line)); },
    send(...keys) { for (const key of keys) { assert.ok(terminal.input, "the alt screen reads the terminal"); terminal.input(key); } },
    source(key) { const source = harness.sources.filter((candidate) => candidate.key === key).at(-1); assert.ok(source, `a source for ${key}`); return source; },
    view(key) { const view = harness.views.filter((candidate) => candidate.key === key).at(-1); assert.ok(view, `a view for ${key}`); return view; },
  };
  const done = openAgentsWorkspace(ctx, {
    // Not async: a listThrow leaves list() synchronously, as a plain function's throw would.
    agents: { list: () => {
      harness.listCalls += 1;
      if (harness.listThrow) throw harness.listThrow;
      if (options.source) return options.source.list();
      return (options.listGate ?? Promise.resolve()).then(() => { if (harness.listError) throw harness.listError; return harness.nodes ?? nodesOf(harness.agents); });
    } },
    openSource: (selected) => {
      harness.opened.push(selected.key);
      const source = new FakeSource(selected.key);
      options.setup?.(source);
      harness.sources.push(source);
      return source;
    },
    createView: ({ ui: viewUi, cwd }) => {
      ui = viewUi;
      const key = harness.opened.at(-1) ?? "";
      if (key === options.failView) throw new Error("no view");
      const view = new FakeView(key, viewUi, cwd, options.wrap);
      if (key === options.failRender) view.fail.render = new Error("render failed");
      harness.views.push(view);
      return view;
    },
    ...(options.initialKey === undefined ? {} : { initialKey: options.initialKey }),
  });
  Object.assign(harness, { done: done.then(() => { harness.left = true; }) });
  await settle();
  return harness;
}
async function leave(harness: Harness, key = KEY.ctrlC): Promise<void> {
  harness.send(key);
  await harness.done;
}
function timers(t: TestContext): void { t.mock.timers.enable({ apis: ["setInterval"] }); }
/** The uncaught exceptions and unhandled rejections seen while the test runs (Pi handles neither). */
function escapes(t: TestContext): unknown[] {
  const seen: unknown[] = [];
  const record = (error: unknown): void => { seen.push(error); };
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  t.after(() => { process.off("uncaughtException", record); process.off("unhandledRejection", record); });
  return seen;
}
function polls(harness: Harness): number { return harness.sources.reduce((total, source) => total + source.count("poll"), 0); }
async function advance(t: TestContext, times = 1): Promise<void> {
  for (let round = 0; round < times; round += 1) {
    t.mock.timers.tick(1000);
    await settle();
  }
}
function title(harness: Harness): string { return harness.screen()[0] ?? ""; }
function rowOf(harness: Harness, text: string): number { return harness.screen().findIndex((line) => line.includes(text)); }
/** A left click (SGR press and release) on the 0-based screen `column` and `row`. */
function click(harness: Harness, column: number, row: number): void { harness.send(`${ESC}[<0;${String(column + 1)};${String(row + 1)}M`, `${ESC}[<0;${String(column + 1)};${String(row + 1)}m`); }
/** The first body row without the transient scrollbar ("auto") drawn in its last column. */
function topRow(harness: Harness): string { return (harness.screen()[1] ?? "").replace(/[\s┃█│]+$/, ""); }

void test("the workspace opens over Pi on the alternate screen and restores Pi on esc, ctrl+c and abort", async (t) => {
  timers(t);
  for (const exit of ["esc", "ctrl+c", "abort"] as const) {
    const controller = new AbortController();
    const live = new FakeLive();
    const harness = await open([agent("alpha", { live })], { signal: controller.signal });
    assert.deepEqual(harness.overlays, [true]);
    assert.deepEqual(harness.parent, ["stop:true"], exit);
    assert.ok(harness.terminal.written.includes(`${ESC}[?1049h`), "entered the alternate screen");
    assert.equal(harness.left, false);
    if (exit === "abort") controller.abort();
    else harness.send(exit === "esc" ? KEY.escape : KEY.ctrlC);
    await harness.done;
    await settle();
    assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], exit);
    assert.ok(harness.terminal.written.endsWith(`${ESC}[?1049l${ESC}[?25h${ESC}[?2026l`), "left the alternate screen with Pi's screen kept");
    assert.equal(harness.source("alpha").calls.at(-1), "close");
    assert.equal(harness.view("alpha").calls.at(-1), "dispose");
    assert.equal(live.unsubscribed, 1);
    const polls = harness.source("alpha").count("poll");
    const lists = harness.listCalls;
    await advance(t, 2);
    assert.equal(harness.source("alpha").count("poll"), polls, "no poll after leaving");
    assert.equal(harness.listCalls, lists, "no refresh after leaving");
  }
});

void test("the layout shows the title, the sidebar tree and the transcript at 120 columns, and starts without the sidebar below 80", async (t) => {
  timers(t);
  const wide = await open(AGENTS(), { columns: 120, setup: (source) => { source.polls.push(polled(entries(0, 5))); } });
  const lines = wide.screen();
  assert.equal(lines.length, 20);
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
  assert.match(lines[0] ?? "", /^#1\/3 alpha running gpt-5 1\.2k tok/);
  assert.deepEqual(sidebarColumn(wide).slice(0, 6), ["  ▾ build a1b2 · ⠦", "→   ▾ alpha · ⠦", "      • beta · ✓", rule(42), "  ▾ Subagents · ⠦", "    • scout · ✗"], "the first agent selected, every row in the /workflow format, a rule above the group");
  assert.match(lines[1] ?? "", /│ alpha record 0/);
  assert.equal((lines.at(-1) ?? "").trimEnd(), "←→/space fold · [ ] agent · tab transcript · pgup/pgdn · ctrl+shift+f search · s sidebar · ctrl+o tools · esc back", "the whole hint fits 120 columns");
  await leave(wide);

  const narrow = await open(AGENTS(), { columns: 70, setup: (source) => { source.polls.push(polled(entries(0, 5))); } });
  const narrowLines = narrow.screen();
  assert.ok(narrowLines.every((line) => visibleWidth(line) <= 70));
  assert.equal(narrowLines[1], "alpha record 0");
  assert.ok(!narrowLines.some((line) => line.includes("Subagents")), "sidebar hidden");
  narrow.send("s");
  const shown = narrow.screen();
  assert.ok(shown.some((line) => line.startsWith("  ▾ Subagents")), "s shows the sidebar");
  assert.ok(shown.every((line) => visibleWidth(line) <= 70));
  await leave(narrow);
});

void test("pgup and pgdn scroll the transcript while the sidebar has focus", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  harness.screen();
  const end = harness.alt().viewportTop;
  assert.equal(end, 100 - 18);
  harness.send(KEY.pageUp);
  harness.screen();
  assert.ok(harness.alt().viewportTop < end);
  harness.send(KEY.pageDown);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end);
  harness.send("s", KEY.pageUp);
  harness.screen();
  assert.ok(harness.alt().viewportTop < end, "a key right after the layout changed scrolls the transcript, not a stale view");
  harness.send("s", KEY.pageDown);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end);
  harness.send(KEY.ctrlHome);
  harness.screen();
  assert.equal(harness.alt().viewportTop, 0, "ctrl+home goes to the top of the transcript");
  assert.equal(harness.alt().isFollowingOutput, false);
  await settle();
  harness.send(KEY.ctrlEnd);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end, "ctrl+end goes back to the end");
  assert.equal(harness.alt().isFollowingOutput, true, "and follows new output again");
  assert.match(title(harness), /^#1\/3 alpha/);
  harness.send(KEY.down);
  assert.match(title(harness), /^#2\/3 beta/, "up/down still select agents");
  await leave(harness);
});

void test("up/down move over every node with the sidebar focused and scroll with the transcript focused; tab, s, [ and ] work with any focus", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/3 beta/);
  harness.send(KEY.down);
  await settle();
  assert.equal(title(harness).trimEnd(), "Subagents running", "the group is a node too");
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#3\/3 scout/);
  harness.send(KEY.down);
  await settle();
  assert.equal(title(harness).trimEnd(), "build a1b2 running", "wraps around to the first node");
  harness.send(KEY.up);
  await settle();
  assert.match(title(harness), /^#3\/3 scout/);
  harness.send(KEY.down, KEY.down);
  await settle();
  assert.match(title(harness), /^#1\/3 alpha/);
  const end = harness.alt().viewportTop;
  harness.send(KEY.tab, KEY.up);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end - 1, "up scrolls by a line");
  assert.match(title(harness), /^#1\/3 alpha/);
  harness.send(KEY.down);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end);
  harness.send("]");
  await settle();
  assert.match(title(harness), /^#2\/3 beta/, "] selects the next agent with the transcript focused");
  harness.send("[");
  await settle();
  assert.match(title(harness), /^#1\/3 alpha/);
  harness.send(KEY.tab, KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/3 beta/, "tab gave the focus back to the sidebar");
  harness.send("[");
  await settle();
  harness.send("s");
  const hidden = harness.screen();
  assert.ok(!hidden.some((line) => line.includes("Subagents")), "s hides the sidebar");
  assert.equal((hidden[1] ?? "").replace(/[\s┃█│]+$/, ""), `alpha record ${String(100 - 18)}`, "the transcript takes the whole width");
  harness.send(KEY.up);
  harness.screen();
  assert.equal(harness.alt().viewportTop, 100 - 18 - 1, "without the sidebar up/down scroll");
  assert.match(title(harness), /^#1\/3 alpha/);
  harness.send("]");
  await settle();
  assert.match(title(harness), /^#2\/3 beta/);
  harness.send("s");
  assert.ok(harness.screen().some((line) => line.startsWith("  ▾ Subagents")));
  harness.send(KEY.ctrlO);
  assert.deepEqual(harness.view("beta").calls.filter((call) => call.startsWith("expanded")), ["expanded:false", "expanded:true"]);
  harness.send("[");
  await settle();
  assert.ok(harness.view("alpha").calls.includes("expanded:true"), "a new view keeps tool output expanded");
  await leave(harness);
});

void test("while the search box is open s and q reach it and ctrl+c still leaves", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { setup: (source) => { source.polls.push(polled(entries(0, 30))); } });
  harness.send(KEY.search);
  assert.equal(harness.alt().hasOverlay(), true);
  harness.send("s", "q");
  const lines = harness.screen();
  assert.ok(lines.some((line) => line.includes("sq")), "the search box got the keys");
  assert.ok(lines.some((line) => line.startsWith("  ▾ Subagents")), "s did not hide the sidebar");
  harness.send(KEY.escape);
  assert.equal(harness.alt().hasOverlay(), false, "esc closes the search box first");
  assert.equal(harness.left, false);
  harness.send(KEY.search, KEY.ctrlC);
  await harness.done;
  assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"]);
});

void test("a click on a sidebar row selects that agent and the wheel over the sidebar scrolls the transcript", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  const row = rowOf(harness, "scout");
  assert.ok(row > 0);
  harness.send(`${ESC}[<0;5;${String(row + 1)}M`, `${ESC}[<0;5;${String(row + 1)}m`);
  await settle();
  assert.match(title(harness), /^#3\/3 scout/);
  assert.deepEqual(harness.opened, ["alpha", "scout"]);
  harness.send("[", "[");
  await settle();
  assert.match(title(harness), /^#1\/3 alpha/);
  const end = harness.alt().viewportTop;
  harness.send(`${ESC}[<64;5;${String(row + 1)}M`);
  harness.screen();
  assert.ok(harness.alt().viewportTop < end, "the wheel scrolls the transcript");
  assert.match(title(harness), /^#1\/3 alpha/);
  await leave(harness);
});

void test("a click whose new view throws while drawing shows the error instead of throwing out of the mouse dispatch", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { failRender: "scout" });
  const row = rowOf(harness, "scout");
  assert.ok(row > 0);
  assert.doesNotThrow(() => { harness.send(`${ESC}[<0;5;${String(row + 1)}M`, `${ESC}[<0;5;${String(row + 1)}m`); });
  // Until the next successful poll replaces it, the failure is the status line.
  assert.match(harness.screen().join("\n"), /render failed/);
  await settle();
  harness.send("[");
  await settle();
  assert.match(title(harness), /^#2\/3/, "the workspace still takes keys after the failed click");
  await leave(harness);
});

void test("selecting another agent closes the previous source, unsubscribes its live stream and disposes its view", async (t) => {
  timers(t);
  const live = new FakeLive();
  const harness = await open([agent("alpha", { live }), agent("beta")]);
  live.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
  assert.ok(harness.view("alpha").calls.includes("live:message_update"));
  assert.equal(harness.view("alpha").ui, harness.alt());
  assert.equal(harness.view("alpha").cwd, "/project/alpha");
  harness.send(KEY.down);
  await settle();
  assert.equal(harness.source("alpha").calls.at(-1), "close");
  assert.equal(live.unsubscribed, 1);
  assert.equal(live.listeners.size, 0);
  assert.equal(harness.view("alpha").calls.at(-1), "dispose");
  assert.deepEqual(harness.opened, ["alpha", "beta"]);
  assert.equal(harness.source("beta").count("poll"), 1);
  assert.equal(harness.source("alpha").overlapped, false);
  await leave(harness);
});

void test("an agent that is not owned shows transcript unavailable and its source is never opened", async (t) => {
  timers(t);
  const harness = await open([agent("alpha"), agent("beta", { owned: false })]);
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/2 beta/);
  assert.deepEqual(harness.opened, ["alpha"]);
  assert.equal(harness.views.length, 1);
  assert.ok(harness.screen().some((line) => line.includes("│ transcript unavailable")));
  await advance(t, 2);
  assert.deepEqual(harness.opened, ["alpha"]);
  await leave(harness);
});

void test("polling appends and resets while the agent runs, shows waiting, and stops one poll after the agent stops", async (t) => {
  timers(t);
  const harness = await open([agent("alpha")], { columns: 70, setup: (source) => { source.polls.push(polled([], { status: "waiting" }), polled(entries(0, 3)), polled(entries(3, 2)), polled(entries(100, 4), { reset: true })); } });
  const source = harness.source("alpha");
  const view = harness.view("alpha");
  assert.equal(source.count("poll"), 1, "an immediate poll");
  assert.ok(harness.screen().some((line) => line.includes("waiting for the first message")));
  await advance(t);
  assert.deepEqual(view.calls.filter((call) => call !== "expanded:false"), ["append:3"]);
  assert.ok(!harness.screen().some((line) => line.includes("waiting")));
  await advance(t);
  await advance(t);
  assert.deepEqual(view.calls.filter((call) => call !== "expanded:false"), ["append:3", "append:2", "reset", "append:4"]);
  assert.equal(topRow(harness), "alpha record 100");
  const running = source.count("poll");
  harness.agents = [agent("alpha", { running: false, state: "completed" })];
  await advance(t, 4);
  assert.equal(source.count("poll"), running + 1, "one more poll after the agent stopped");
  assert.match(title(harness), /^#1\/1 alpha completed/);
  assert.equal(harness.listCalls >= 6, true, "the agents are listed on every tick");
  assert.equal(source.overlapped, false);
  await leave(harness);
});

void test("reaching the top loads the earlier chunk once and keeps the lines in view where they were, with the sidebar shown", async (t) => {
  timers(t);
  // Each record is a 95-column line: two rows beside the sidebar at 120 and 100 columns, where the whole width would give one.
  for (const columns of [120, 100]) {
    const harness = await open([agent("alpha", { running: false })], { columns, wrap: 95, setup: (source) => {
      source.polls.push(polled(entries(1000, 40)));
      source.earlier.push({ records: entries(900, 30), atStart: false }, { records: entries(880, 20), atStart: true });
    } });
    const source = harness.source("alpha");
    const top = (): string => harness.screen()[1] ?? "";
    // The frame that shows the last chunk; the scroll view learns the content height when it is drawn.
    assert.ok(harness.screen().every((line) => visibleWidth(line) <= columns));
    harness.send(KEY.home);
    assert.ok(top().includes("│ alpha record 1000"), String(columns));
    // The call starts once the source's queue moves on; a frame drawn while it is in flight does not call again.
    await Promise.resolve();
    assert.equal(source.count("loadEarlier"), 1);
    harness.screen();
    await Promise.resolve();
    assert.equal(source.count("loadEarlier"), 1, "loaded once while the chunk is in flight");
    await settle();
    assert.deepEqual(harness.view("alpha").calls.at(-1), "prepend:30");
    assert.ok(top().includes("│ alpha record 1000"), `the lines in view stay where they were at ${String(columns)} columns`);
    assert.equal(harness.alt().viewportTop, 60);
    harness.send(KEY.home);
    assert.ok(top().includes("│ alpha record 900"));
    await settle();
    assert.ok(top().includes("│ alpha record 900"));
    assert.equal(source.count("loadEarlier"), 2);
    harness.send(KEY.home);
    harness.screen();
    await settle();
    assert.equal(source.count("loadEarlier"), 2, "no load at the start of the file");
    assert.equal(source.overlapped, false);
    await leave(harness);
  }
});

void test("enter loads the last large record not loaded yet", async (t) => {
  timers(t);
  const harness = await open([agent("alpha", { running: false })], { setup: (source) => { source.polls.push(polled([entry(0), large(10), entry(20), large(30)])); } });
  const hint = harness.screen().at(-1) ?? "";
  assert.ok(hint.includes("enter load"), "the hint names enter while a record is pending");
  assert.match(hint, /^←→\/space fold · \[ \] agent · tab transcript · enter load · /, "the sidebar keys come first while the sidebar has the focus");
  assert.ok(visibleWidth(hint) <= 120);
  harness.send(KEY.enter);
  await settle();
  assert.ok(harness.source("alpha").calls.includes("loadRecord:30"));
  assert.equal(harness.view("alpha").calls.at(-1), "replace:30");
  harness.send(KEY.enter);
  await settle();
  assert.ok(harness.source("alpha").calls.includes("loadRecord:10"));
  assert.equal(harness.view("alpha").calls.at(-1), "replace:10");
  assert.ok(harness.screen().some((line) => line.includes("full 10")));
  assert.equal(harness.source("alpha").overlapped, false);
  await leave(harness);
});

void test("the selection survives a refresh that reorders the agents, and the initial key is selected first", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { initialKey: "beta" });
  assert.deepEqual(harness.opened, ["beta"]);
  assert.match(title(harness), /^#2\/3 beta/);
  const [alpha, beta, scout] = harness.agents;
  assert.ok(alpha && beta && scout);
  harness.agents = [scout, beta, alpha];
  await advance(t);
  assert.match(title(harness), /^#2\/3 beta/);
  harness.agents = [beta, alpha, scout];
  await advance(t);
  assert.match(title(harness), /^#1\/3 beta/);
  assert.deepEqual(harness.opened, ["beta"]);
  assert.ok(!harness.source("beta").calls.includes("close"));
  harness.agents = [alpha, scout];
  await advance(t);
  assert.match(title(harness), /^#1\/2 alpha/, "a removed agent gives the selection to its neighbour");
  assert.equal(harness.source("beta").calls.at(-1), "close");
  await leave(harness);
});

void test("a new attempt or session reference of the selected agent reopens it", async (t) => {
  timers(t);
  const harness = await open([agent("alpha")]);
  harness.agents = [agent("alpha", { attempt: 2, session: { transport: "pi", sessionId: "alpha-2" } })];
  await advance(t);
  assert.deepEqual(harness.opened, ["alpha", "alpha"]);
  assert.equal(harness.sources[0]?.calls.at(-1), "close");
  assert.equal(harness.views[0]?.calls.at(-1), "dispose");
  assert.equal(harness.views.length, 2);
  harness.agents = [agent("alpha", { attempt: 2, session: { transport: "pi", sessionId: "alpha-2", locator: { sessionFile: "/sessions/alpha-2.jsonl" } } })];
  await advance(t);
  assert.deepEqual(harness.opened, ["alpha", "alpha", "alpha"]);
  await advance(t);
  assert.equal(harness.opened.length, 3, "the same attempt is not reopened");
  await leave(harness);
});

void test("a live stream registered after the agent was opened is subscribed without reopening it", async (t) => {
  timers(t);
  const harness = await open([agent("alpha")]);
  const live = new FakeLive();
  harness.agents = [agent("alpha", { live })];
  await advance(t);
  assert.equal(live.listeners.size, 1, "the new stream is subscribed");
  assert.deepEqual(harness.opened, ["alpha"], "the source is not reopened");
  assert.equal(harness.views.length, 1, "the view is kept");
  live.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
  assert.ok(harness.view("alpha").calls.includes("live:message_update"), "its events reach the view");
  const next = new FakeLive();
  harness.agents = [agent("alpha", { live: next })];
  await advance(t);
  assert.equal(live.unsubscribed, 1, "a replaced stream is unsubscribed");
  assert.equal(next.listeners.size, 1);
  harness.agents = [agent("alpha")];
  await advance(t);
  assert.equal(next.unsubscribed, 1, "a stream that went away is unsubscribed");
  assert.equal(harness.views.length, 1);
  await leave(harness);
});

void test("a rejected loadEarlier is tried once until the user comes back to the top", async (t) => {
  timers(t);
  const harness = await open([agent("alpha")], { columns: 70, setup: (source) => {
    source.polls.push(polled(entries(1000, 40)));
    source.failEarlier = new Error("disk read failed");
  } });
  const source = harness.source("alpha");
  harness.screen();
  harness.send(KEY.home);
  harness.screen();
  await settle();
  assert.equal(source.count("loadEarlier"), 1);
  assert.ok(harness.screen().some((line) => line.includes("transcript read failed: disk read failed")));
  for (let frame = 0; frame < 5; frame += 1) {
    harness.screen();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  await advance(t, 3);
  harness.screen();
  await settle();
  assert.equal(source.count("loadEarlier"), 1, "no retry on every frame or poll");
  harness.send(KEY.pageDown);
  harness.screen();
  harness.send(KEY.home);
  harness.screen();
  await settle();
  assert.equal(source.count("loadEarlier"), 2, "coming back to the top tries again");
  assert.equal(source.overlapped, false);
  await leave(harness);
});

void test("the sidebar keeps the selected row in view, and clicks select rows after it scrolled", async (t) => {
  timers(t);
  const many = Array.from({ length: 30 }, (_, index) => agent(`a${String(index).padStart(2, "0")}`, { group: index < 15 ? "g1" : "g2" }));
  const harness = await open(many, { rows: 10 });
  assert.ok((harness.screen()[1] ?? "").startsWith("  ▾ g1 · ⠦"));
  assert.ok((harness.screen()[2] ?? "").startsWith("→   • a00 · ⠦"));
  harness.send("[");
  await settle();
  let lines = harness.screen();
  assert.match(title(harness), /^#30\/30 a29/, "[ goes round to the last agent");
  assert.ok(lines.some((line) => line.startsWith("→   • a29 · ⠦")), "the selected row is in view");
  assert.ok(!lines.some((line) => line.includes(" a00")), "the sidebar scrolled");
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
  const row = rowOf(harness, " a25");
  assert.ok(row > 0);
  harness.send(`${ESC}[<0;5;${String(row + 1)}M`, `${ESC}[<0;5;${String(row + 1)}m`);
  await settle();
  assert.match(title(harness), /^#26\/30 a25/, "the click resolved the scrolled row");
  harness.send(KEY.down, KEY.down, KEY.down, KEY.down, KEY.down);
  await settle();
  lines = harness.screen();
  assert.equal(title(harness).trimEnd(), "g1 running", "down goes round to the first node");
  assert.ok((lines[1] ?? "").startsWith("→ ▾ g1 · ⠦"), "the sidebar scrolled back to the top");
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#1\/30 a00/);
  assert.ok((harness.screen()[2] ?? "").startsWith("→   • a00 · ⠦"));
  await leave(harness);
});

void test("the status line shows an unavailable transcript with its reason, a failed read, then the agent's activity", async (t) => {
  timers(t);
  const harness = await open([agent("alpha", { activity: "running bash: npm test" })], { setup: (source) => {
    source.polls.push(polled([], { status: "unavailable", reason: "session file was replaced" }), new Error("permission denied"), polled(entries(0, 2)));
  } });
  const status = (): string => (harness.screen().at(-2) ?? "").trimEnd();
  assert.match(status(), /│ transcript unavailable: session file was replaced$/);
  await advance(t);
  assert.match(status(), /│ transcript read failed: permission denied$/);
  await advance(t);
  assert.match(status(), /│ running bash: npm test$/);
  assert.ok(harness.screen().some((line) => line.includes("alpha record 1")));
  await leave(harness);
});

void test("a failed list keeps the previous agents and shows the error in the title", async (t) => {
  timers(t);
  const harness = await open(AGENTS());
  harness.listError = new Error("store locked");
  await advance(t);
  assert.match(title(harness), /^#1\/3 alpha .*agents unavailable: store locked/);
  assert.ok(harness.screen().some((line) => line.includes("scout")), "the previous agents stay");
  assert.ok(!harness.source("alpha").calls.includes("close"));
  harness.listError = undefined;
  await advance(t);
  assert.doesNotMatch(title(harness), /agents unavailable/);
  await leave(harness);
});

void test("the initial key is selected by the first list that contains it", async (t) => {
  timers(t);
  const harness = await open([], { initialKey: "beta" });
  assert.equal(harness.listCalls, 1, "the first list was empty");
  assert.deepEqual(harness.opened, []);
  harness.agents = AGENTS();
  await advance(t);
  assert.match(title(harness), /^#2\/3 beta/);
  assert.deepEqual(harness.opened, ["beta"]);
  await leave(harness);
});

void test("a signal aborted before opening never stops Pi", async () => {
  const controller = new AbortController();
  controller.abort();
  const harness = await open(AGENTS(), { signal: controller.signal });
  await harness.done;
  assert.deepEqual(harness.parent, []);
  assert.equal(harness.listCalls, 0);
  assert.deepEqual(harness.opened, []);
});

void test("opening that fails before or after the workspace is built restores Pi, reports once and leaves nothing running", async (t) => {
  timers(t);
  const escaped = escapes(t);
  for (const fail of ["cursor", "start"] as const) {
    const harness = await open(AGENTS(), { fail });
    await harness.done;
    assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], fail);
    assert.deepEqual(harness.notified, [`error: agents workspace failed: ${fail === "cursor" ? "no cursor" : "terminal unavailable"}`]);
    if (fail === "start") {
      const entered = harness.terminal.written.indexOf(`${ESC}[?1049h`);
      assert.ok(entered >= 0, "the alt screen was entered before the terminal failed");
      assert.ok(harness.terminal.written.indexOf(`${ESC}[?1049l`) > entered, "and left again");
    }
    const lists = harness.listCalls;
    assert.ok(lists <= 1, "at most the first list, called while the workspace was built");
    await advance(t, 3);
    assert.equal(harness.listCalls, lists, `no refresh after opening failed (${fail})`);
    assert.equal(polls(harness), 0, "no poll after opening failed");
    assert.deepEqual(harness.opened, []);
  }
  assert.deepEqual(escaped, []);
});

void test("a terminal that cannot stop on esc, ctrl+c or abort still restores Pi, settles, reports once and leaves nothing running", async (t) => {
  timers(t);
  const escaped = escapes(t);
  for (const exit of ["esc", "ctrl+c", "abort"] as const) {
    const controller = new AbortController();
    const live = new FakeLive();
    const harness = await open([agent("alpha", { live })], { signal: controller.signal });
    harness.terminal.failStop = new Error("setRawMode EBADF");
    if (exit === "abort") controller.abort();
    else harness.send(exit === "esc" ? KEY.escape : KEY.ctrlC);
    await settle();
    assert.equal(harness.left, true, `the command settled (${exit})`);
    assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], exit);
    assert.deepEqual(harness.notified, ["error: agents workspace failed: setRawMode EBADF"], exit);
    assert.equal(harness.source("alpha").calls.at(-1), "close", "the transcript was closed before the terminal failed");
    assert.equal(harness.view("alpha").calls.at(-1), "dispose");
    assert.equal(live.unsubscribed, 1);
    // The failed stop kept the input wired: leaving again does nothing.
    harness.send(KEY.escape, KEY.ctrlC);
    controller.abort();
    await settle();
    assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], `left once (${exit})`);
    assert.equal(harness.notified.length, 1);
    const lists = harness.listCalls;
    const pollCount = polls(harness);
    await advance(t, 3);
    assert.equal(harness.listCalls, lists, `no refresh after leaving (${exit})`);
    assert.equal(polls(harness), pollCount, `no poll after leaving (${exit})`);
  }
  assert.deepEqual(escaped, []);
});

void test("Pi's TUI failing to start again after leaving still settles the command and reports the first error once", async (t) => {
  timers(t);
  const escaped = escapes(t);
  for (const exit of ["ctrl+c", "abort", "esc with a terminal that cannot stop"] as const) {
    const controller = new AbortController();
    const harness = await open([agent("alpha")], { signal: controller.signal });
    harness.parentStartError = new Error("tty gone");
    if (exit === "abort") controller.abort();
    else if (exit === "ctrl+c") harness.send(KEY.ctrlC);
    else {
      harness.terminal.failStop = new Error("setRawMode EBADF");
      harness.send(KEY.escape);
    }
    await settle();
    assert.equal(harness.left, true, `the command settled (${exit})`);
    assert.deepEqual(harness.parent, ["stop:true", "start"], exit);
    assert.deepEqual(harness.notified, [`error: agents workspace failed: ${exit === "esc with a terminal that cannot stop" ? "setRawMode EBADF" : "tty gone"}`], exit);
    assert.equal(harness.source("alpha").calls.at(-1), "close");
  }
  assert.deepEqual(escaped, []);
});

void test("the refresh interval starts once the first list settled", async (t) => {
  timers(t);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const harness = await open(AGENTS(), { listGate: gate });
  assert.equal(harness.listCalls, 1);
  t.mock.timers.tick(1500);
  await settle();
  release();
  await settle();
  assert.match(title(harness), /^#1\/3 alpha/);
  t.mock.timers.tick(600);
  await settle();
  assert.equal(harness.listCalls, 1, "no tick 1000 ms after open, before the first list settled");
  t.mock.timers.tick(400);
  await settle();
  assert.equal(harness.listCalls, 2, "the first tick comes 1000 ms after the first list settled");
  await leave(harness);
});

void test("a list() that throws synchronously, at open or on a later tick, ends in the title and refreshing goes on", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const harness = await open(AGENTS(), { listThrow: new Error("index corrupt") });
  assert.equal(harness.listCalls, 1);
  assert.deepEqual(harness.opened, []);
  // No view yet, so no alt screen handle: wait (bounded) for the throttled frame the alt screen drew on the terminal.
  const drawn = (): boolean => stripTerminalSequences(harness.terminal.written).includes("agents unavailable: index corrupt");
  for (let wait = 0; wait < 100 && !drawn(); wait += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.ok(drawn(), "the title shows the throw");
  harness.listThrow = undefined;
  await advance(t);
  assert.equal(harness.listCalls, 2, "the interval started after the throw");
  assert.match(title(harness), /^#1\/3 alpha/);
  assert.deepEqual(harness.opened, ["alpha"]);
  harness.listThrow = new Error("index moved");
  await advance(t);
  assert.match(title(harness), /^#1\/3 alpha .*agents unavailable: index moved/);
  assert.ok(harness.screen().some((line) => line.includes("scout")), "the previous agents stay");
  await advance(t);
  assert.equal(harness.listCalls, 4, "a throw does not stop refreshing");
  harness.listThrow = undefined;
  await advance(t);
  assert.doesNotMatch(title(harness), /agents unavailable/);
  assert.equal(harness.source("alpha").calls.includes("close"), false);
  await leave(harness);
  assert.deepEqual(escaped, []);
});

void test("a view whose append or live throws shows the error as the status line and polling goes on", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const live = new FakeLive();
  const harness = await open([agent("alpha", { live })], { setup: (source) => { source.polls.push(polled(entries(0, 2)), polled(entries(2, 2)), polled(entries(4, 2)), polled(entries(6, 2))); } });
  const source = harness.source("alpha");
  const view = harness.view("alpha");
  const status = (): string => (harness.screen().at(-2) ?? "").trimEnd();
  view.fail.append = new Error("append threw");
  await advance(t);
  assert.match(status(), /│ transcript failed: append threw$/);
  await advance(t);
  assert.equal(source.count("poll"), 3, "polling goes on");
  assert.equal(harness.listCalls, 3, "refreshing goes on");
  view.fail.append = undefined;
  await advance(t);
  assert.ok(!harness.screen().some((line) => line.includes("transcript failed")), "a poll the view took clears the error");
  assert.ok(harness.screen().some((line) => line.includes("alpha record 6")));
  view.fail.live = new Error("live threw");
  live.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
  assert.match(status(), /│ transcript failed: live threw$/);
  await settle();
  assert.equal(source.overlapped, false);
  await leave(harness);
  assert.deepEqual(escaped, []);
});

void test("an agent whose view cannot be created stays selected with the error, closes its source and is not reopened every tick", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const harness = await open(AGENTS(), { failView: "beta" });
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/3 beta/);
  assert.deepEqual(harness.opened, ["alpha", "beta"]);
  assert.equal(harness.source("beta").calls.at(-1), "close");
  assert.match((harness.screen().at(-2) ?? "").trimEnd(), /│ transcript unavailable: no view$/);
  await advance(t, 2);
  assert.deepEqual(harness.opened, ["alpha", "beta"], "the same attempt is not reopened");
  assert.equal(harness.source("beta").count("poll"), 0);
  harness.send("[");
  await settle();
  assert.match(title(harness), /^#1\/3 alpha/);
  assert.equal(harness.view("alpha").calls.includes("dispose"), false);
  await leave(harness);
  assert.deepEqual(escaped, []);
});

/** The sidebar column of every body row, without the vertical separator: rows, rules, and the empty rows below them. */
function sidebarColumn(harness: Harness): string[] {
  return harness.screen().slice(1, -1).map((line) => line.includes("│") ? line.slice(0, line.indexOf("│")).trimEnd() : "");
}
/** The rule the sidebar draws above a top-level node, `cell` columns wide. */
function rule(cell: number): string { return "─".repeat(cell); }
/** The node rows of the sidebar column: no rules, no empty rows. */
function sidebarRows(harness: Harness): string[] {
  return sidebarColumn(harness).filter((line) => line && !/^─+$/.test(line));
}

void test("left and right collapse, expand and move to the parent or the first child as in /workflow", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TREE()) });
  assert.match(title(harness), /^#1\/4 a running/, "the first agent node is selected");
  assert.deepEqual(sidebarRows(harness), ["  ▾ Workflow · ⠦", "    ▾ P · ⠦", "      ▾ O · ⠦", "→       • a · ⠦", "        • b · ✓", "      • c · ⠦", "  ▾ Subagents · ⠦", "    • s · ⠦"]);
  harness.send(KEY.right);
  await settle();
  assert.match(title(harness), /^#1\/4 a/, "right on a leaf stays");
  harness.send(KEY.left);
  await settle();
  assert.equal(title(harness).trimEnd(), "O running", "left on a leaf goes to the parent");
  harness.send(KEY.left);
  await settle();
  assert.deepEqual(sidebarRows(harness).slice(2, 4), ["→     ▸ O · ⠦", "      • c · ⠦"], "left on an expanded node collapses it and stays");
  harness.send(KEY.left);
  await settle();
  assert.equal(title(harness).trimEnd(), "P running", "left on a collapsed node goes to the parent");
  harness.send(KEY.right);
  await settle();
  assert.equal(title(harness).trimEnd(), "O running", "right on an expanded node goes to its first child");
  harness.send(KEY.right);
  await settle();
  assert.deepEqual(sidebarRows(harness).slice(2, 4), ["→     ▾ O · ⠦", "        • a · ⠦"], "right on a collapsed node expands it and stays");
  harness.send(KEY.right);
  await settle();
  assert.match(title(harness), /^#1\/4 a/);
  harness.send(KEY.tab, KEY.left);
  await settle();
  assert.match(title(harness), /^#1\/4 a/, "left and right act on the tree only while it has the focus");
  harness.send(KEY.tab, KEY.up, KEY.up, KEY.up, KEY.left);
  await settle();
  assert.deepEqual(sidebarRows(harness), ["→ ▸ Workflow · ⠦", "  ▾ Subagents · ⠦", "    • s · ⠦"], "up from a reached the run root, left collapsed it");
  harness.send(KEY.left);
  await settle();
  assert.equal(title(harness).trimEnd(), "Workflow running", "left on a collapsed root stays");
  await leave(harness);
});

void test("[ and ] jump over the nodes that are not agents and expand the ancestors of the agent they land on", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TREE()) });
  harness.send(KEY.left, KEY.left, KEY.left, KEY.left);
  await settle();
  assert.deepEqual(sidebarRows(harness).slice(0, 2), ["  ▾ Workflow · ⠦", "→   ▸ P · ⠦"], "P and O collapsed");
  harness.send("]");
  await settle();
  assert.match(title(harness), /^#1\/4 a/, "the next agent after P, hidden under it");
  assert.deepEqual(sidebarRows(harness).slice(1, 4), ["    ▾ P · ⠦", "      ▾ O · ⠦", "→       • a · ⠦"], "its ancestors expanded");
  const keys: string[] = [];
  for (const key of ["]", "]", "]", "]", "[", "["]) {
    harness.send(key);
    await settle();
    keys.push(title(harness).split(" ").slice(0, 2).join(" "));
  }
  assert.deepEqual(keys, ["#2/4 b", "#3/4 c", "#4/4 s", "#1/4 a", "#4/4 s", "#3/4 c"], "agents only, in sidebar order, round at both ends");
  harness.send(KEY.down, KEY.left);
  await settle();
  assert.deepEqual(sidebarRows(harness).slice(-1), ["→ ▸ Subagents · ⠦"], "the group collapsed");
  harness.send("]");
  await settle();
  assert.match(title(harness), /^#4\/4 s/);
  assert.deepEqual(sidebarRows(harness).slice(-2), ["  ▾ Subagents · ⠦", "→   • s · ⠦"]);
  await leave(harness);
});

void test("a node that is not an agent shows its details: no source, no polling, no live stream", async (t) => {
  timers(t);
  const live = new FakeLive();
  const specs = TREE().map((spec) => spec.key === "a" ? { ...spec, agent: agent("a", { live }) } : spec);
  const harness = await open([], { nodes: tree(specs) });
  assert.deepEqual(harness.opened, ["a"]);
  assert.equal(live.listeners.size, 1);
  harness.send(KEY.up);
  await settle();
  const lines = harness.screen();
  assert.equal((lines[0] ?? "").trimEnd(), "O running", "the title is the node's label and state");
  assert.match(lines[1] ?? "", /│ details of O\s*$/);
  assert.match(lines[2] ?? "", /│ state running\s*$/);
  assert.equal((lines.at(-2) ?? "").replace(/^.*│/, "").trim(), "", "no status line");
  assert.equal(harness.source("a").calls.at(-1), "close");
  assert.equal(live.listeners.size, 0, "the agent's stream is let go");
  const polled = polls(harness);
  await advance(t, 3);
  assert.deepEqual(harness.opened, ["a"], "no source for the node");
  assert.equal(polls(harness), polled, "no polling");
  assert.equal(live.listeners.size, 0);
  assert.doesNotMatch(lines.at(-1) ?? "", /enter load/);
  harness.send(KEY.enter, KEY.ctrlO);
  await settle();
  assert.deepEqual(harness.opened, ["a"]);
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#1\/4 a/);
  assert.deepEqual(harness.opened, ["a", "a"], "the agent opens again");
  assert.ok(harness.view("a").calls.includes("expanded:true"), "ctrl+o still toggled the tool output");
  await leave(harness);
});

void test("expansion and selection survive a refresh that adds nodes; new nodes take their initial expansion", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TREE()) });
  harness.send(KEY.left, KEY.left);
  await settle();
  assert.equal(title(harness).trimEnd(), "O running");
  harness.nodes = tree([
    { key: "new-run", kind: "run", label: "Fresh" },
    { key: "new-agent", parent: "new-run", agent: agent("n") },
    ...TREE().flatMap((spec) => spec.key === "c" ? [{ key: "d", parent: "O", agent: agent("d") }, { key: "Q", parent: "P", kind: "operation" as const }, { key: "e", parent: "Q", agent: agent("e") }, spec] : [spec]),
  ]);
  await advance(t);
  assert.equal(title(harness).trimEnd(), "O running", "the selection kept by key");
  assert.deepEqual(sidebarRows(harness), [
    "  ▾ Fresh · ⠦",
    "    • n · ⠦",
    "  ▾ Workflow · ⠦",
    "    ▾ P · ⠦",
    "→     ▸ O · ⠦",
    "      ▾ Q · ⠦",
    "        • e · ⠦",
    "      • c · ⠦",
    "  ▾ Subagents · ⠦",
    "    • s · ⠦",
  ], "O stays collapsed (its new child d hidden), the new run and Q come expanded");
  harness.send("]");
  await settle();
  assert.match(title(harness), /^#2\/7 a/, "the next agent in sidebar order, the new run's agent first");
  assert.deepEqual(sidebarRows(harness).slice(4, 8), ["      ▾ O · ⠦", "→       • a · ⠦", "        • b · ✓", "        • d · ⠦"], "O expanded again, with its new child");
  await advance(t);
  assert.match(title(harness), /^#2\/7 a/);
  assert.deepEqual(harness.opened, ["a", "a"], "the selected agent is not reopened by a refresh");
  await leave(harness);
});

void test("the initial key selects its agent and expands its ancestors; without one the first agent node is selected and shown", async (t) => {
  timers(t);
  const collapsed = (): Spec[] => TREE().map((spec) => spec.key === "P" || spec.key === "subagents" ? { ...spec, expanded: false } : spec);
  const keyed = await open([], { nodes: tree(collapsed()), initialKey: "b" });
  assert.match(title(keyed), /^#2\/4 b/);
  assert.deepEqual(keyed.opened, ["b"]);
  assert.deepEqual(sidebarRows(keyed), ["  ▾ Workflow · ⠦", "    ▾ P · ⠦", "      ▾ O · ⠦", "        • a · ⠦", "→       • b · ✓", "      • c · ⠦", "  ▸ Subagents · ⠦"]);
  await leave(keyed);
  const subagent = await open([], { nodes: tree(collapsed()), initialKey: "s" });
  assert.match(title(subagent), /^#4\/4 s/);
  assert.deepEqual(sidebarRows(subagent).slice(-2), ["  ▾ Subagents · ⠦", "→   • s · ⠦"]);
  await leave(subagent);
  const first = await open([], { nodes: tree(collapsed()) });
  assert.match(title(first), /^#1\/4 a/);
  assert.ok(sidebarRows(first).includes("→       • a · ⠦"));
  await leave(first);
});

/** Two runs and the Subagents group: "build a1b2" with alpha over beta, "deploy c3d4" with gamma, then scout. */
const GROUPS = (): Listed[] => [agent("alpha"), agent("beta", { depth: 1 }), agent("gamma", { group: "deploy c3d4" }), agent("scout", { group: "Subagents" })];

void test("a rule above every top-level node but the first row; up, down and clicks never land on it; every line fits at 120 and 70 columns", async (t) => {
  timers(t);
  const rows = (cell: number): string[] => ["  ▾ build a1b2 · ⠦", "→   ▾ alpha · ⠦", "      • beta · ⠦", rule(cell), "  ▾ deploy c3d4 · ⠦", "    • gamma · ⠦", rule(cell), "  ▾ Subagents · ⠦", "    • scout · ⠦"];
  const harness = await open(GROUPS());
  const column = sidebarColumn(harness);
  assert.deepEqual(column.slice(0, 9), rows(42), "the rule fills the sidebar cell");
  assert.deepEqual(column.slice(9), column.slice(9).map(() => ""), "no rule elsewhere");
  assert.ok(harness.screen().every((line) => visibleWidth(line) <= 120));
  const steps: string[] = [];
  for (const key of [KEY.down, KEY.down, KEY.down, KEY.down, KEY.up, KEY.up, KEY.up]) {
    harness.send(key);
    await settle();
    steps.push(title(harness).split(" ").slice(0, 2).join(" "));
  }
  assert.deepEqual(steps, ["#2/4 beta", "deploy c3d4", "#3/4 gamma", "Subagents running", "#3/4 gamma", "deploy c3d4", "#2/4 beta"], "up and down go from node to node over the rules");
  // A click on a rule, in the icon column or further right, changes nothing: not the selection, not the expansion, not the focus.
  harness.send(KEY.tab);
  const before = harness.screen();
  const opened = [...harness.opened];
  assert.match(before.at(-1) ?? "", /^↑↓ scroll/);
  const ruleRow = before.findIndex((line) => line.startsWith("─"));
  assert.ok(ruleRow > 0);
  for (const column of [2, 4, 10]) {
    click(harness, column, ruleRow);
    await settle();
  }
  assert.deepEqual(harness.screen(), before);
  assert.deepEqual(harness.opened, opened);
  await leave(harness);

  const narrow = await open(GROUPS(), { columns: 70 });
  narrow.send("s");
  assert.deepEqual(sidebarColumn(narrow).slice(0, 9), rows(25), "the rule fills the narrower cell");
  for (const step of ["", KEY.down, KEY.down, KEY.down, KEY.down]) {
    if (step) narrow.send(step);
    await settle();
    const frame = narrow.screen();
    assert.ok(frame.every((line) => visibleWidth(line) <= 70), frame.join("\n"));
  }
  await leave(narrow);
});

void test("a click on a row's ▾/▸ icon toggles and selects its node, a click elsewhere on the row only selects; space toggles a node with children and nothing else", async (t) => {
  timers(t);
  const harness = await open(GROUPS());
  // The screen row in the sidebar column: the title and the details pane name a selected node that is not an agent too.
  const row = (text: string): number => sidebarColumn(harness).findIndex((line) => line.includes(text)) + 1;
  // A header's icon is in column 2, as on every depth-0 row.
  click(harness, 2, row("deploy c3d4"));
  await settle();
  assert.equal(title(harness).trimEnd(), "deploy c3d4 running", "the click selected the header");
  assert.deepEqual(sidebarRows(harness).slice(3), ["→ ▸ deploy c3d4 · ⠦", "  ▾ Subagents · ⠦", "    • scout · ⠦"], "and collapsed it");
  click(harness, 2, row("deploy c3d4"));
  await settle();
  assert.deepEqual(sidebarRows(harness).slice(3, 5), ["→ ▾ deploy c3d4 · ⠦", "    • gamma · ⠦"], "a second click expands it again");
  // alpha is at depth 1: its icon is in column 4, its label after it.
  click(harness, 8, row("alpha"));
  await settle();
  assert.match(title(harness), /^#1\/4 alpha/, "a click on the label selects");
  assert.ok(sidebarRows(harness).includes("      • beta · ⠦"), "and toggles nothing");
  click(harness, 3, row("deploy c3d4"));
  await settle();
  assert.equal(title(harness).trimEnd(), "deploy c3d4 running", "a click beside the icon selects");
  assert.ok(sidebarRows(harness).includes("    • gamma · ⠦"), "and toggles nothing");
  click(harness, 4, row("alpha"));
  await settle();
  assert.match(title(harness), /^#1\/4 alpha/, "a click on the icon selects");
  assert.ok(!sidebarRows(harness).some((line) => line.includes("beta")), "and collapses");
  harness.send(" ");
  await settle();
  assert.ok(sidebarRows(harness).includes("      • beta · ⠦"), "space expands the selected node");
  harness.send(" ");
  await settle();
  assert.ok(!sidebarRows(harness).some((line) => line.includes("beta")), "space collapses it");
  assert.match(title(harness), /^#1\/4 alpha/, "and keeps it selected");
  harness.send(" ", KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/4 beta/);
  const leaf = harness.screen();
  harness.send(" ");
  await settle();
  assert.deepEqual(harness.screen(), leaf, "space on a leaf does nothing");
  // The • of a leaf sits in the icon column: a click there only selects.
  click(harness, 4, row("gamma"));
  await settle();
  assert.match(title(harness), /^#3\/4 gamma/);
  assert.ok(sidebarRows(harness).includes("→   • gamma · ⠦"));
  harness.send(KEY.up, KEY.tab, " ");
  await settle();
  assert.equal(title(harness).trimEnd(), "deploy c3d4 running");
  assert.ok(sidebarRows(harness).includes("    • gamma · ⠦"), "space toggles only while the sidebar has the focus");
  await leave(harness);
});

void test("a node's initial expansion counts the first time a list contains it: a run that finishes stays expanded, a new finished run comes collapsed, a new running one expanded", async (t) => {
  timers(t);
  const run = (key: string, state: RunState, expanded: boolean): Spec[] => [
    { key: `run:${key}`, kind: "run", label: key, state, expanded },
    { key: key.toLowerCase(), parent: `run:${key}`, agent: agent(key.toLowerCase(), state === "running" ? {} : { state: "completed", running: false }) },
  ];
  // S holds the agent selected on open, so its expansion is the reveal's; A's is its own.
  const harness = await open([], { nodes: tree([...run("S", "running", true), ...run("A", "running", true)]) });
  assert.deepEqual(sidebarRows(harness), ["  ▾ S · ⠦", "→   • s · ⠦", "  ▾ A · ⠦", "    • a · ⠦"]);
  harness.nodes = tree([...run("S", "running", true), ...run("A", "completed", false), ...run("B", "completed", false), ...run("C", "running", true)]);
  await advance(t);
  assert.deepEqual(sidebarRows(harness), ["  ▾ S · ⠦", "→   • s · ⠦", "  ▾ A · ✓", "    • a · ✓", "  ▸ B · ✓", "  ▾ C · ⠦", "    • c · ⠦"], "A finished while shown and stays expanded");
  harness.nodes = tree([...run("S", "running", true), ...run("A", "completed", false), ...run("B", "running", true), ...run("C", "completed", false)]);
  await advance(t);
  assert.deepEqual(sidebarRows(harness), ["  ▾ S · ⠦", "→   • s · ⠦", "  ▾ A · ✓", "    • a · ✓", "  ▸ B · ⠦", "  ▾ C · ✓", "    • c · ✓"], "a later list changes the expansion of no node already seen");
  await leave(harness);
});

void test("the initial key on an agent of a finished, collapsed run expands its ancestors; the other finished runs stay collapsed", async (t) => {
  timers(t);
  const done = { state: "completed", running: false } as const;
  const harness = await open([], { initialKey: "b", nodes: tree([
    { key: "run:A", kind: "run", label: "A" },
    { key: "a", parent: "run:A", agent: agent("a") },
    { key: "run:B", kind: "run", label: "B", state: "completed", expanded: false },
    { key: "P", parent: "run:B", label: "plan", state: "completed", expanded: false },
    { key: "b", parent: "P", agent: agent("b", done) },
    { key: "run:C", kind: "run", label: "C", state: "completed", expanded: false },
    { key: "c", parent: "run:C", agent: agent("c", done) },
  ]) });
  assert.match(title(harness), /^#2\/3 b completed/);
  assert.deepEqual(harness.opened, ["b"]);
  assert.deepEqual(sidebarRows(harness), ["  ▾ A · ⠦", "    • a · ⠦", "  ▾ B · ✓", "    ▾ plan · ✓", "→     • b · ✓", "  ▸ C · ✓"]);
  await leave(harness);
});

void test("on a short terminal the sidebar keeps the selected row in view, rules counted", async (t) => {
  timers(t);
  const harness = await open(Array.from({ length: 6 }, (_, index) => agent(`a${String(index)}`, { group: `g${String(index)}` })), { rows: 7 });
  const selected = (): string | undefined => sidebarColumn(harness).find((line) => line.startsWith("→"));
  assert.deepEqual(sidebarColumn(harness), ["  ▾ g0 · ⠦", "→   • a0 · ⠦", rule(42), "  ▾ g1 · ⠦", "    • a1 · ⠦"]);
  const seen: string[][] = [];
  // Every node down to the last and round to the first, then back up, then ] and [ across the runs.
  for (const key of [...Array.from({ length: 12 }, () => KEY.down), ...Array.from({ length: 12 }, () => KEY.up), "]", "]", "]", "[", "[", "[", "[", "["]) {
    harness.send(key);
    await settle();
    const column = sidebarColumn(harness);
    seen.push(column);
    assert.ok(selected(), `the selected row is in view after ${String(seen.length)} keys:\n${column.join("\n")}`);
  }
  assert.ok(seen.some((column) => column.some((line) => /^─+$/.test(line))), "with rules in view");
  assert.equal(seen[9]?.at(-1), "→   • a5 · ⠦", "the last node at the bottom");
  assert.deepEqual(seen[10]?.slice(0, 2), ["→ ▾ g0 · ⠦", "    • a0 · ⠦"], "down went round to the first run, at the top without a rule");
  await leave(harness);
});

void test("with the sidebar focused the hint names the fold and agent keys; with the transcript focused it is as before", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { columns: 200 });
  const hint = (): string => (harness.screen().at(-1) ?? "").trimEnd();
  assert.equal(hint(), "←→/space fold · [ ] agent · tab transcript · pgup/pgdn · ctrl+shift+f search · s sidebar · ctrl+o tools · esc back");
  harness.send(KEY.tab);
  assert.equal(hint(), "↑↓ scroll · [ ] agent · tab agents · pgup/pgdn · ctrl+shift+f search · s sidebar · ctrl+o tools · esc back");
  await leave(harness);
});

/** Waits (bounded) for the first agent's view: a real source reads the disk, which takes more than a few turns of the event loop. */
async function opened(harness: Harness): Promise<void> {
  for (let wait = 0; wait < 400 && harness.views.length === 0; wait += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.ok(harness.views.length > 0, "the first agent was opened");
}
const homes: string[] = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

void test("a run's sidebar rows are its /workflow tree rows, its nodes show the /workflow details, and every line fits at 120 and 70 columns", async (t) => {
  timers(t);
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-agents-workspace-"));
  homes.push(home);
  const cwd = join(home, "project");
  mkdirSync(cwd);
  const now = Date.now();
  const model = { provider: "openai", model: "gpt" };
  const record = (id: string, state: AgentRecord["state"], extra: Partial<AgentRecord> = {}): AgentRecord => ({ id, name: id, path: id, state, model, tools: [], attempts: 1, attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: `${id}-1` }, setup: { hookNames: [], model, tools: [], cwd }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }], ...extra });
  const launch = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "review flow" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, phases: ["plan", "review", "ship"], schemas: [] });
  const store = new RunStore(cwd, "session", "run", home);
  await store.create({ id: "run", workflowName: "review flow", cwd, sessionId: "session", state: "running", agentSessions: [], phase: "review", phaseHistory: [{ phase: "plan", afterAgent: 0 }, { phase: "review", afterAgent: 1 }], agents: [
    record("planner", "completed", { label: "Planner", startedAt: now - 60_000, durationMs: 20_000 }),
    record("api", "running", { structuralPath: ["p", "a"], startedAt: now - 30_000 }),
    record("helper", "queued", { parentId: "api", structuralPath: ["p", "a"] }),
    record("ui", "completed", { structuralPath: ["p", "b"], startedAt: now - 25_000, durationMs: 10_000 }),
  ] }, launch);
  const overlayRun = (run: PersistedRun): PersistedRun => ({ ...run, activeShellsByPhase: [{ phaseIndex: 1, active: 2, startedAt: now - 3000 }] });
  const context = { cwd, sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionCommandContext;
  const source = createSessionAgentsSource(context, { home, overlayRun, liveAgent: () => undefined, subagents: () => undefined });
  const loaded = await store.load();
  const dashboard = formatWorkflowPhaseDashboard(overlayRun(loaded.run), loaded.snapshot, 70, { treeOnly: true, nodeId: "phase/plan%231/agent/planner" });
  const rows = dashboard.slice(dashboard.indexOf("Tree") + 1);
  const harness = await open([], { source, rows: 24 });
  await opened(harness);
  assert.match(title(harness), /^#1\/4 Planner completed/);
  // The /workflow rows one level deeper, the first agent selected; the root is a header that names the run, as the sidebar can hold several.
  assert.deepEqual(rows.slice(0, 3), ["  ▾ Workflow · ⠦", "  ▾ plan · ✓", "→   • Planner · ✓"]);
  assert.deepEqual(sidebarRows(harness), ["  ▾ review flow run  ⠦ 2/4 agents", ...rows.slice(1).map((row) => `${row.slice(0, 2)}  ${row.slice(2)}`)]);
  harness.send(KEY.down);
  await settle();
  const lines = harness.screen();
  assert.equal((lines[0] ?? "").trimEnd(), "review running");
  const details = lines.slice(1, 9).map((line) => line.slice(line.indexOf("│") + 1).trim());
  assert.deepEqual(details.slice(0, 4), ["Selected phase: review", "Status: running", "agents completed=1 running=1 failed=0 cancelled=0 pending=1", "Agents: 3"]);
  assert.ok(details.some((line) => line.startsWith("Elapsed:")), "the phase's usage");
  assert.ok(!lines.some((line) => line.includes("enter ")), "without the /workflow enter hints");
  assert.deepEqual(harness.opened, ["run:run:planner"]);
  assert.ok(lines.every((line) => visibleWidth(line) <= 120));
  await leave(harness);

  const narrow = await open([], { source, columns: 70, rows: 24 });
  await opened(narrow);
  narrow.send("s");
  for (const step of ["", KEY.down, KEY.up, KEY.up, KEY.up]) {
    if (step) narrow.send(step);
    await settle();
    const frame = narrow.screen();
    assert.ok(frame.every((line) => visibleWidth(line) <= 70), frame.join("\n"));
  }
  assert.equal(title(narrow).trimEnd(), "review flow run running");
  assert.ok(narrow.screen().some((line) => line.includes("Selected workflow: review")), "the details wrap beside the sidebar");
  await leave(narrow);
});
