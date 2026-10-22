import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, type TestContext } from "node:test";
import { initTheme, type ExtensionCommandContext, type KeybindingsManager as PiKeybindings, type SettingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, stripTerminalSequences, TUI_KEYBINDINGS, TuiAltScreen, truncateToWidth, visibleWidth, type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
import type { SessionAgent, SessionAgentsSource, SessionTreeNode } from "../src/session-agents.js";
import type { TranscriptView } from "../src/transcript-components.js";
import { openAgentsWorkspace, type AgentsWorkspaceOptions } from "../src/agents-workspace.js";
import { formatWorkflowTreeLine } from "../src/host-view.js";
import workflowExtension from "../src/host.js";
import { createLaunchSnapshot, DEFAULT_SETTINGS, RunStore, type AgentAttemptSummary, type AgentRecord, type LaunchSnapshot, type PersistedRun, type RunState } from "../src/index.js";
import type { TranscriptPoll, TranscriptRecord, TranscriptSource } from "../src/session-transcript.js";
import type { WorkflowAgentSession, WorkflowAgentSessionEvent } from "../src/types.js";
import { testExtensionApi } from "./support.js";

/**
 * The fake Pi and terminal the /agents workspace tests open it on (test/agents-workspace.test.ts), shared with the host and
 * run fixtures of test/agents-command.test.ts and test/session-agents.test.ts.
 */

export const ESC = "\x1b";
/** homeTmux and endTmux: home and end as tmux and screen send them. */
export const KEY = { up: `${ESC}[A`, down: `${ESC}[B`, left: `${ESC}[D`, right: `${ESC}[C`, home: `${ESC}[H`, homeTmux: `${ESC}[1~`, endTmux: `${ESC}[4~`, ctrlHome: `${ESC}[1;5H`, ctrlEnd: `${ESC}[1;5F`, pageUp: `${ESC}[5~`, pageDown: `${ESC}[6~`, tab: "\t", enter: "\r", escape: ESC, ctrlC: "\x03", ctrlO: "\x0f", search: `${ESC}[102;6u` };
export const THEME = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text, underline: (text: string) => text, inverse: (text: string) => text } as unknown as Theme;
export const KEYBINDINGS = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } }) as unknown as PiKeybindings;
// Pi's key hints read Pi's theme and keybindings, which Pi sets up before any command runs.
initTheme("dark", false);

export function tick(): Promise<void> { return new Promise((resolve) => { setImmediate(resolve); }); }
export async function settle(): Promise<void> { for (let round = 0; round < 10; round += 1) await tick(); }
/** Waits for `condition` at most `budget` polls 5 ms apart, then asserts it with `what`. */
export async function until(condition: () => boolean, what: string | (() => string), budget = 1000): Promise<void> {
  for (let wait = 0; wait < budget && !condition(); wait += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.ok(condition(), typeof what === "string" ? what : what());
}

export class FakeTerminal implements Terminal {
  input: ((data: string) => void) | undefined;
  written = "";
  /** Thrown by start() while set. */
  failStart: Error | undefined;
  /** Thrown by stop() while set, before it lets the input go, as a setRawMode on a closed TTY. */
  failStop: Error | undefined;
  /** Calls of stop(), a failing one too: the alt screen stops the terminal on each of its stops. */
  stops = 0;
  /** What the alt screen asked to hear about a resize; set by start(), cleared by stop(). */
  onResize: (() => void) | undefined;
  constructor(public columns: number, public rows: number) {}
  /** This terminal, also when read through a wrapper of it. */
  get self(): this { return this; }
  start(onInput: (data: string) => void, onResize: () => void): void { if (this.failStart) throw this.failStart; this.input = onInput; this.onResize = onResize; }
  stop(): void { this.stops += 1; if (this.failStop) throw this.failStop; this.input = undefined; this.onResize = undefined; }
  /** Takes the new size and reports it, as a terminal window resized by the person does. */
  resize(columns: number): void { this.columns = columns; this.onResize?.(); }
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

/**
 * The alternate screen last laid out on each terminal. The workspace keeps its TuiAltScreen to itself, and one that shows no
 * agent creates no view that would hand it over, so the harness notes it where the workspace lays it out.
 */
const screens = new WeakMap<Terminal, TuiAltScreen>();
const setLayoutRoot = Object.getOwnPropertyDescriptor(TuiAltScreen.prototype, "setLayoutRoot");
assert.ok(setLayoutRoot);
TuiAltScreen.prototype.setLayoutRoot = function (this: TuiAltScreen, component: Component | undefined): void {
  // The workspace hands its alt screen a wrapper of the fake terminal: the map takes the fake terminal behind it.
  screens.set((this.terminal as Partial<FakeTerminal>).self ?? this.terminal, this);
  Reflect.apply(setLayoutRoot.value as (this: TuiAltScreen, component: Component | undefined) => void, this, [component]);
};

export function entry(offset: number, text = `record ${String(offset)}`): TranscriptRecord { return { kind: "entry", bytes: 10, value: { type: "message", text } }; }
export function entries(from: number, count: number): TranscriptRecord[] { return Array.from({ length: count }, (_, index) => entry(from + index)); }
export function polled(appended: readonly TranscriptRecord[], options: Partial<TranscriptPoll> = {}): TranscriptPoll { return { status: "available", reset: false, appended, ...options }; }
function label(record: TranscriptRecord): string { return record.kind === "entry" ? typeof record.value.text === "string" ? record.value.text : "" : record.kind; }

export class FakeSource implements TranscriptSource {
  readonly calls: string[] = [];
  /** Results of the next polls; an error rejects that poll. */
  readonly polls: (TranscriptPoll | Error)[] = [];
  /** Holds every poll until it resolves. */
  pollGate: Promise<void> | undefined;
  overlapped = false;
  private active = 0;
  constructor(readonly key: string) {}
  async poll(): Promise<TranscriptPoll> { return await this.run("poll", async () => { if (this.pollGate) await this.pollGate; const next = this.polls.shift(); if (next instanceof Error) throw next; return next ?? polled([]); }); }
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

export class FakeView implements TranscriptView {
  readonly calls: string[] = [];
  items: TranscriptRecord[] = [];
  readonly component: Component;
  /** append and live throw while set; render throws once. */
  readonly fail: { append?: Error | undefined; live?: Error | undefined; render?: Error | undefined } = {};
  /** The Pi settings the workspace gave createView. */
  settings: SettingsManager | undefined;
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
  setExpanded(expanded: boolean): void { this.calls.push(`expanded:${String(expanded)}`); }
  live(event: WorkflowAgentSessionEvent): void { this.calls.push(`live:${event.type}`); if (this.fail.live) throw this.fail.live; }
  dispose(): void { this.calls.push("dispose"); }
}

export class FakeLive implements Pick<WorkflowAgentSession, "subscribe"> {
  readonly listeners = new Set<(event: WorkflowAgentSessionEvent) => void>();
  unsubscribed = 0;
  /** Events a subscriber gets synchronously while it subscribes, as a stream that replays the message being generated does. */
  readonly replay: WorkflowAgentSessionEvent[] = [];
  subscribe(listener: (event: WorkflowAgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    for (const event of this.replay) listener(event);
    return () => { this.unsubscribed += 1; this.listeners.delete(listener); };
  }
  emit(event: WorkflowAgentSessionEvent): void { for (const listener of this.listeners) listener(event); }
}

/**
 * A sidebar node: an agent when `agent` is set; nodes come in sidebar order, a parent before its children.
 */
export interface Spec { readonly key: string; readonly parent?: string; readonly kind?: SessionTreeNode["kind"]; readonly label?: string; readonly state?: RunState; readonly expanded?: boolean; readonly agent?: SessionAgent }
/** Nodes drawn with the /workflow row formatter, as the source draws them; a node that is not an agent details itself as "details of <label>" and "state <state>". */
export function tree(specs: readonly Spec[]): SessionTreeNode[] {
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
export type Listed = SessionAgent & { readonly group?: string; readonly depth?: number };
export function agent(key: string, options: Partial<Listed> = {}): Listed {
  return { key, name: key, state: "running", summary: "gpt-5 1.2k tok", cwd: `/project/${key}`, attempt: 1, owned: true, session: { transport: "pi", sessionId: `${key}-1` }, live: undefined, activity: undefined, running: true, ...options };
}
/** The tree of listed agents: a run node per group ("build a1b2" by default; "Subagents" gives the group node), each agent under the agent before it with a smaller depth. */
export function nodesOf(agents: readonly Listed[]): SessionTreeNode[] {
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


/**
 * Pi as the workspace sees it: a parent TUI that records its calls, on a fake terminal, and a command context whose custom
 * and notify are recorded.
 */
export interface FakePi {
  readonly terminal: FakeTerminal;
  /** Calls on the fake parent TUI, in order. */
  readonly parent: string[];
  readonly overlays: (boolean | undefined)[];
  readonly notified: string[];
  /** Thrown by the fake parent TUI's start() while set, after it was recorded. */
  parentStartError: Error | undefined;
  readonly ctx: ExtensionCommandContext;
  /** The alternate screen the workspace laid out last on this terminal. */
  alt(): TuiAltScreen;
  /** Renders a frame now and returns its rows without escape sequences. */
  screen(): string[];
  send(...keys: string[]): void;
}

/**
 * `fail` makes opening fail before the workspace exists (the cursor query) or after it was built (the terminal's start);
 * `context` adds fields to the command context (cwd, mode, sessionManager, ...).
 */
export function fakePi(options: { columns?: number | undefined; rows?: number | undefined; signal?: AbortSignal | undefined; fail?: "cursor" | "start" | undefined; keybindings?: PiKeybindings | undefined; toolsExpanded?: boolean | undefined; context?: Readonly<Record<string, unknown>> | undefined } = {}): FakePi {
  const terminal = new FakeTerminal(options.columns ?? 120, options.rows ?? 20);
  if (options.fail === "start") terminal.failStart = new Error("terminal unavailable");
  const parent: string[] = [];
  const parentTui = {
    terminal,
    getShowHardwareCursor: () => { if (options.fail === "cursor") throw new Error("no cursor"); return false; },
    stop(stopOptions?: { preserveScreen?: boolean }) { parent.push(`stop:${String(stopOptions?.preserveScreen)}`); },
    start() { parent.push("start"); if (pi.parentStartError) throw pi.parentStartError; },
    renderNow(force?: boolean) { parent.push(`renderNow:${String(force)}`); },
    // A custom component asks for a frame after each key; nothing to record.
    requestRender() {},
  } as unknown as TUI;
  const overlays: (boolean | undefined)[] = [];
  const notified: string[] = [];
  const ctx = {
    cwd: "/project",
    isProjectTrusted: () => true,
    ...options.context,
    signal: options.signal,
    ui: {
      custom: <T>(factory: (tui: TUI, theme: Theme, keybindings: PiKeybindings, done: (result: T) => void) => Component, customOptions?: { overlay?: boolean; overlayOptions?: unknown }) => {
        return new Promise<T>((resolve) => {
          overlays.push(customOptions?.overlay);
          // Pi hands a custom component the keybindings it installed as pi-tui's.
          const keybindings = options.keybindings ?? KEYBINDINGS;
          setKeybindings(keybindings);
          const component = factory(parentTui, THEME, keybindings, resolve);
          assert.ok(component.render(40).every((line) => visibleWidth(line) <= 40));
        });
      },
      notify: (message: string, type?: string) => { notified.push(`${type ?? "info"}: ${message}`); },
      getToolsExpanded: () => options.toolsExpanded ?? false,
    },
  } as unknown as ExtensionCommandContext;
  const pi: FakePi = {
    terminal, parent, overlays, notified, parentStartError: undefined, ctx,
    alt() { const alt = screens.get(terminal); assert.ok(alt, "the workspace laid out its alternate screen"); return alt; },
    screen() { const alt = pi.alt(); alt.renderNow(); return alt.getScreenLines().map((line) => stripTerminalSequences(line)); },
    send(...keys) { for (const key of keys) { assert.ok(terminal.input, "the alt screen reads the terminal"); terminal.input(key); } },
  };
  return pi;
}

export interface Harness extends FakePi {
  agents: Listed[];
  /** Listed instead of the agents' tree while set. */
  nodes: SessionTreeNode[] | undefined;
  /** Rejects every list() while set. */
  listError: Error | undefined;
  /** Thrown synchronously by every list() while set. */
  listThrow: Error | undefined;
  listCalls: number;
  readonly opened: string[];
  readonly sources: FakeSource[];
  readonly views: FakeView[];
  readonly done: Promise<void>;
  left: boolean;
  /** The parent TUI's calls when openAgentsWorkspace resolved. */
  parentAtExit: readonly string[] | undefined;
  source(key: string): FakeSource;
  view(key: string): FakeView;
}

export interface OpenOptions {
  columns?: number;
  rows?: number;
  initialKey?: string;
  signal?: AbortSignal;
  /** The workspace's shutdown signal (AgentsWorkspaceOptions.shutdown). */
  shutdown?: AbortSignal;
  wrap?: number;
  fail?: "cursor" | "start";
  listThrow?: Error;
  listGate?: Promise<void>;
  /** Goes to the workspace as options.changes. */
  changes?: (listener: () => void) => () => void;
  failView?: string;
  failRender?: string;
  failLive?: string;
  setup?: (source: FakeSource) => void;
  nodes?: SessionTreeNode[];
  source?: SessionAgentsSource;
  keybindings?: PiKeybindings;
  /** What Pi's ctx.ui.getToolsExpanded answers; false by default. */
  toolsExpanded?: boolean;
  /** Fields added to the command context (cwd, ...). */
  context?: Readonly<Record<string, unknown>>;
}

/**
 * Opens the workspace with fake Pi pieces; `setup` runs for each source before its first poll settles; `wrap` makes views that wrap;
 * `fail` makes opening fail before the workspace exists (the cursor query) or after it was built (the terminal's start);
 * `listThrow` sets harness.listThrow from the start; `listGate` holds every list() until it resolves; createView throws for `failView`;
 * the view of `failRender` throws from its first render; `nodes` sets harness.nodes; `source` lists instead of the harness.
 */
export async function open(agents: Listed[], options: OpenOptions = {}): Promise<Harness> {
  const pi = fakePi({ columns: options.columns, rows: options.rows, signal: options.signal, fail: options.fail, keybindings: options.keybindings, toolsExpanded: options.toolsExpanded, context: options.context });
  const harness: Harness = Object.assign(pi, {
    agents, nodes: options.nodes, listError: undefined, listThrow: options.listThrow, listCalls: 0, opened: [], sources: [], views: [], left: false,
    done: Promise.resolve(), parentAtExit: undefined,
    source(key: string) { const source = harness.sources.filter((candidate) => candidate.key === key).at(-1); assert.ok(source, `a source for ${key}`); return source; },
    view(key: string) { const view = harness.views.filter((candidate) => candidate.key === key).at(-1); assert.ok(view, `a view for ${key}`); return view; },
  });
  const done = openAgentsWorkspace(pi.ctx, {
    // Not async: a listThrow leaves list() synchronously, as a plain function's throw would.
    agents: { list: () => {
      harness.listCalls += 1;
      if (harness.listThrow) throw harness.listThrow;
      if (options.source) return options.source.list();
      return (options.listGate ?? Promise.resolve()).then(() => { if (harness.listError) throw harness.listError; return harness.nodes ?? nodesOf(harness.agents); });
    } },
    ...(options.changes === undefined ? {} : { changes: options.changes }),
    openSource: (selected) => {
      harness.opened.push(selected.key);
      const source = new FakeSource(selected.key);
      options.setup?.(source);
      harness.sources.push(source);
      return source;
    },
    createView: ({ ui: viewUi, cwd, settings }) => {
      const key = harness.opened.at(-1) ?? "";
      if (key === options.failView) throw new Error("no view");
      const view = new FakeView(key, viewUi, cwd, options.wrap);
      view.settings = settings;
      if (key === options.failRender) view.fail.render = new Error("render failed");
      if (key === options.failLive) view.fail.live = new Error("live failed");
      harness.views.push(view);
      return view;
    },
    ...(options.initialKey === undefined ? {} : { initialKey: options.initialKey }),
    ...(options.shutdown === undefined ? {} : { shutdown: options.shutdown }),
  });
  Object.assign(harness, { done: done.then(() => { harness.parentAtExit = [...pi.parent]; harness.left = true; }) });
  await settle();
  return harness;
}
export async function leave(harness: Harness, key = KEY.ctrlC): Promise<void> {
  harness.send(key);
  await harness.done;
}
export function timers(t: TestContext): void { t.mock.timers.enable({ apis: ["setInterval"] }); }
/** The uncaught exceptions and unhandled rejections seen while the test runs (Pi handles neither). */
export function escapes(t: TestContext): unknown[] {
  const seen: unknown[] = [];
  const record = (error: unknown): void => { seen.push(error); };
  process.on("uncaughtException", record);
  process.on("unhandledRejection", record);
  t.after(() => { process.off("uncaughtException", record); process.off("unhandledRejection", record); });
  return seen;
}
export function polls(harness: Harness): number { return harness.sources.reduce((total, source) => total + source.count("poll"), 0); }
export async function advance(t: TestContext, times = 1): Promise<void> {
  for (let round = 0; round < times; round += 1) {
    t.mock.timers.tick(1000);
    await settle();
  }
}
export function title(pi: FakePi): string { return pi.screen()[0] ?? ""; }
export function rowOf(pi: FakePi, text: string): number { return pi.screen().findIndex((line) => line.includes(text)); }
/** A left click (SGR press and release) on the 0-based screen `column` and `row`. */
export function click(pi: FakePi, column: number, row: number): void { pi.send(`${ESC}[<0;${String(column + 1)};${String(row + 1)}M`, `${ESC}[<0;${String(column + 1)};${String(row + 1)}m`); }
/** The first body row without the transient scrollbar ("auto") drawn in its last column. */
export function topRow(pi: FakePi): string { return (pi.screen()[1] ?? "").replace(/[\s┃█│]+$/, ""); }
/** The sidebar column of every body row, without the vertical separator: rows, rules, and the empty rows below them. */
export function sidebarColumn(pi: FakePi): string[] {
  return pi.screen().slice(1, -1).map((line) => line.includes("│") ? line.slice(0, line.indexOf("│")).trimEnd() : "");
}
/** The rule the sidebar draws above a top-level node, `cell` columns wide. */
export function rule(cell: number): string { return "─".repeat(cell); }
/** The node rows of the sidebar column: no rules, no empty rows. */
export function sidebarRows(pi: FakePi): string[] {
  return sidebarColumn(pi).filter((line) => line && !/^─+$/.test(line));
}
/** The status row under the right pane, without the sidebar. */
export function statusRow(pi: FakePi): string { return (pi.screen().at(-2) ?? "").replace(/^.*│/, "").trim(); }
/** Waits (bounded) for the first agent's view: a real source reads the disk, which takes more than a few turns of the event loop. */
export async function opened(harness: Harness): Promise<void> {
  await until(() => harness.views.length > 0, "the first agent was opened", 400);
}

/** The Pi session the fixtures' runs belong to. */
export const SESSION = "session";
const homes: string[] = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });
/** A directory under the system's temporary directory, removed once the file's tests ran. */
export function temporary(name: string): string {
  const directory = mkdtempSync(join(tmpdir(), `pi-extensible-workflows-${name}-`));
  homes.push(directory);
  return directory;
}
/** A temporary home with an empty `project` directory in it, the cwd of the fixtures' runs. */
export function project(name: string): { readonly home: string; readonly cwd: string } {
  const home = temporary(name);
  const cwd = join(home, "project");
  mkdirSync(cwd);
  return { home, cwd };
}

type Command = (args: string, ctx: unknown) => Promise<void>;
/** What the workflow extension's fake workspace opener was called with. */
export type Opened = { readonly ctx: ExtensionCommandContext; readonly options: AgentsWorkspaceOptions };
/** The workflow extension over `home` with a fake workspace opener that records each open; its /agents command and its session_shutdown handler. */
export function host(home: string): { agents: Command | undefined; shutdown: (() => Promise<void>) | undefined; opened: Opened[] } {
  const commands = new Map<string, Command>();
  let shutdown: (() => Promise<void>) | undefined;
  const opened: Opened[] = [];
  workflowExtension(testExtensionApi({
    registerCommand(name: string, options: { handler: Command }) { commands.set(name, options.handler); },
    registerTool() {},
    on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; },
    getThinkingLevel: () => "medium",
    getActiveTools: () => ["workflow"],
  }), home, undefined, undefined, join(home, "agent"), [], async (ctx, options) => {
    opened.push({ ctx, options });
  });
  return { agents: commands.get("agents"), shutdown, opened };
}

export function launch(options: { readonly phases?: readonly string[]; readonly script?: string } = {}): Readonly<LaunchSnapshot> {
  return createLaunchSnapshot({ script: options.script ?? "return true;", args: null, metadata: { name: "wf" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [], ...(options.phases === undefined ? {} : { phases: [...options.phases] }) });
}
/** A run `id` named `<id>-name`, of the session `extra.sessionId` (SESSION by default). */
export async function createRun(f: { readonly home: string; readonly cwd: string }, id: string, state: RunState, extra: Partial<PersistedRun> = {}, snapshot = launch()): Promise<RunStore> {
  const store = new RunStore(f.cwd, extra.sessionId ?? SESSION, id, f.home);
  await store.create({ id, workflowName: `${id}-name`, cwd: f.cwd, sessionId: SESSION, state, agents: [], agentSessions: [], ...extra }, snapshot);
  return store;
}
const ATTEMPT: AgentAttemptSummary = { attempt: 1, transport: "local", session: { transport: "local", sessionId: "native", locator: { sessionFile: "/sessions/native.jsonl" } }, setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd: "/repo" }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
/** A completed agent `id`, named so, with one attempt. */
export function agentRecord(id: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return { id, name: id, path: id, state: "completed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1, attemptDetails: [ATTEMPT], ...extra };
}
