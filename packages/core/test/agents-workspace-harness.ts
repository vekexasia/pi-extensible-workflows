import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, type TestContext } from "node:test";
import { initTheme, type ExtensionCommandContext, type KeybindingsManager as PiKeybindings, type SettingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, setKeybindings, stripTerminalSequences, TUI_KEYBINDINGS, TuiAltScreen, truncateToWidth, visibleWidth, type Component, type Terminal, type TUI } from "@earendil-works/pi-tui";
import type { ActionUi, AgentsActionProvider, AgentsActionTarget } from "../src/agents-actions-contract.js";
import { runAgentsWorkspace } from "../src/agents-command.js";
import { createPiActionUi } from "../src/pi-action-ui.js";
import type { SessionAgent, SessionAgentsSource, SessionTreeNode } from "../src/session-agents.js";
import type { TranscriptView } from "../src/transcript-components.js";
import { openAgentsWorkspace, type AgentsWorkspaceExit, type AgentsWorkspaceOptions, type AgentsWorkspaceState } from "../src/agents-workspace.js";
import type { AwaitingCheckpoint } from "../src/decoders.js";
import type { WorkflowRunRecord } from "../src/host-runtime.js";
import { formatWorkflowTreeLine } from "../src/host-view.js";
import workflowExtension from "../src/host.js";
import { createLaunchSnapshot, DEFAULT_SETTINGS, RunStore, type AgentAttemptSummary, type AgentRecord, type HardTerminalRunState, type LaunchSnapshot, type PersistedRun, type PreparedAgentSession, type RunState } from "../src/index.js";
import type { TranscriptPoll, TranscriptRecord, TranscriptSource } from "../src/session-transcript.js";
import { HARD_TERMINAL_RUN_STATES, type WorkflowAgentSession, type WorkflowAgentSessionEvent } from "../src/types.js";
import type { WorkflowActionDependencies } from "../src/workflow-actions.js";
import type { SubagentAttemptActionData, SubagentManager, SubagentManagerContext } from "../subagents/src/contracts.js";
import { testExtensionApi } from "./support.js";

/**
 * The fake Pi and terminal the /agents workspace tests open it on (test/agents-workspace.test.ts), shared with the tests that
 * drive it through the action loop with the real providers (test/agents-workspace-actions.test.ts), the fixtures of those
 * providers' own tests (test/workflow-actions.test.ts, test/subagent-actions.test.ts), the host and run fixtures of
 * test/agents-command.test.ts, test/agents-loop.test.ts and test/session-agents.test.ts, and the screen scrapers of
 * subagents/test/index.test.mjs.
 */

export const ESC = "\x1b";
/** homeTmux and endTmux: home and end as tmux and screen send them. */
export const KEY = { up: `${ESC}[A`, down: `${ESC}[B`, left: `${ESC}[D`, right: `${ESC}[C`, home: `${ESC}[H`, homeTmux: `${ESC}[1~`, endTmux: `${ESC}[4~`, ctrlHome: `${ESC}[1;5H`, ctrlEnd: `${ESC}[1;5F`, pageUp: `${ESC}[5~`, pageDown: `${ESC}[6~`, tab: "\t", enter: "\r", escape: ESC, ctrlC: "\x03", ctrlO: "\x0f", search: `${ESC}[102;6u` };
/** A bracketed paste of `text`, as the terminal hands it on. */
export function paste(text: string): string { return `${ESC}[200~${text}${ESC}[201~`; }
export const THEME = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text, underline: (text: string) => text, inverse: (text: string) => text } as unknown as Theme;
export const KEYBINDINGS = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } }) as unknown as PiKeybindings;
// Pi's key hints, its select list and its input read Pi's theme and keybindings, which Pi sets up before any command runs.
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
 * A sidebar node: an agent when `agent` is set; nodes come in sidebar order, a parent before its children. `details` is what an
 * agent shows on d (none by default); `target` its action target (none by default).
 */
export interface Spec { readonly key: string; readonly parent?: string; readonly kind?: SessionTreeNode["kind"]; readonly label?: string; readonly state?: RunState; readonly expanded?: boolean; readonly agent?: SessionAgent; readonly details?: readonly string[]; readonly target?: AgentsActionTarget }
/** Nodes drawn with the /workflow row formatter, as the source draws them; a node that is not an agent details itself as "details of <label>" and "state <state>"; an agent's ID is its key. */
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
      label, state: spec.agent?.state ?? state, ...(spec.agent ? { id: spec.key } : {}),
      line: (styles, selected, expanded) => formatWorkflowTreeLine({ kind, label, depth, state, children }, selected, expanded, styles),
      details: () => spec.agent ? spec.details ?? [] : [`details of ${label}`, `state ${state}`],
      title: () => `${label} ${state}`,
      ...(spec.target === undefined ? {} : { target: spec.target }),
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

/** What Pi's confirm, select, input and editor answer; unset: false, undefined, undefined and undefined, as when the person cancels. */
export interface PiAnswers {
  confirm?: (title: string, message: string) => boolean | Promise<boolean>;
  select?: (title: string, options: readonly string[]) => string | undefined | Promise<string | undefined>;
  input?: (title: string, placeholder: string | undefined) => string | undefined | Promise<string | undefined>;
  editor?: (title: string) => string | undefined | Promise<string | undefined>;
}
/** A custom component Pi shows and has not closed yet, with the options it was shown with. */
export interface PendingCustom {
  readonly component: Component;
  readonly options: { readonly overlay?: boolean; readonly overlayOptions?: unknown } | undefined;
  /** Closes it with no result, as Pi does when the session ends. */
  close(): void;
}

/**
 * Pi as the workspace sees it: a parent TUI that records its calls, on a fake terminal, and a command context whose dialogs,
 * custom, notify, status and working message are recorded. As Pi, it shows one custom component at a time: its confirm, select,
 * input or custom called while another custom is pending would replace that component and leave its promise pending forever
 * (the invariant on createPiActionUi in src/pi-action-ui.ts), so such a call is noted in `violations` and throws.
 */
export interface FakePi {
  readonly terminal: FakeTerminal;
  /** Calls on the fake parent TUI, in order. */
  readonly parent: string[];
  readonly overlays: (boolean | undefined)[];
  readonly notified: string[];
  /**
   * Everything the command asked of Pi's UI, in order: "custom" and "done" around each custom component, "confirm <title> | <message>",
   * "select <title> | <option>, <option>", "input <title> | <placeholder>", "editor <title>", "status <key> <text>" ("status <key> -" clears it),
   * "working <message>" and "notify <level>: <message>".
   */
  readonly events: string[];
  /** The dialogs and customs called while another custom was pending; Pi would have left that custom's promise pending. */
  readonly violations: string[];
  /** The custom components Pi shows now, the latest last. */
  readonly customs: PendingCustom[];
  answers: PiAnswers;
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
export function fakePi(options: { columns?: number | undefined; rows?: number | undefined; signal?: AbortSignal | undefined; fail?: "cursor" | "start" | undefined; keybindings?: PiKeybindings | undefined; theme?: Theme | undefined; toolsExpanded?: boolean | undefined; context?: Readonly<Record<string, unknown>> | undefined } = {}): FakePi {
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
  const events: string[] = [];
  const violations: string[] = [];
  const customs: PendingCustom[] = [];
  /** Throws, after noting it, when `call` would replace a pending custom component. */
  const shown = (call: string): void => {
    events.push(call);
    if (customs.length === 0) return;
    violations.push(call);
    throw new Error(`Pi's ${call.split(" ")[0] ?? call} would replace a pending custom component`);
  };
  const ctx = {
    cwd: "/project",
    isProjectTrusted: () => true,
    ...options.context,
    signal: options.signal,
    ui: {
      custom: <T>(factory: (tui: TUI, theme: Theme, keybindings: PiKeybindings, done: (result: T) => void) => Component, customOptions?: { overlay?: boolean; overlayOptions?: unknown }) => {
        shown("custom");
        return new Promise<T>((resolve) => {
          overlays.push(customOptions?.overlay);
          let entry: PendingCustom | undefined;
          const state = { closed: false };
          const done = (result: T): void => {
            if (state.closed) return;
            state.closed = true;
            const index = entry === undefined ? -1 : customs.indexOf(entry);
            if (index >= 0) customs.splice(index, 1);
            events.push("done");
            resolve(result);
          };
          // Pi hands a custom component the keybindings it installed as pi-tui's.
          const keybindings = options.keybindings ?? KEYBINDINGS;
          setKeybindings(keybindings);
          const component = factory(parentTui, options.theme ?? THEME, keybindings, done);
          assert.ok(component.render(40).every((line) => visibleWidth(line) <= 40));
          // A component closed while it was built is not shown.
          if (!state.closed) { entry = { component, options: customOptions, close: () => { done(undefined as T); } }; customs.push(entry); }
        });
      },
      confirm: (title: string, message: string): Promise<boolean> => { shown(`confirm ${title} | ${message}`); return Promise.resolve(pi.answers.confirm?.(title, message) ?? false); },
      select: (title: string, choices: string[]): Promise<string | undefined> => { shown(`select ${title} | ${choices.join(", ")}`); return Promise.resolve(pi.answers.select?.(title, choices)); },
      input: (title: string, placeholder?: string): Promise<string | undefined> => { shown(`input ${title} | ${placeholder ?? ""}`); return Promise.resolve(pi.answers.input?.(title, placeholder)); },
      editor: (title: string): Promise<string | undefined> => { shown(`editor ${title}`); return Promise.resolve(pi.answers.editor?.(title)); },
      notify: (message: string, type?: string) => { notified.push(`${type ?? "info"}: ${message}`); events.push(`notify ${type ?? "info"}: ${message}`); },
      setStatus: (key: string, text?: string) => { events.push(`status ${key} ${text ?? "-"}`); },
      setWorkingMessage: (message?: string) => { events.push(`working ${message ?? "-"}`); },
      getToolsExpanded: () => options.toolsExpanded ?? false,
    },
  } as unknown as ExtensionCommandContext;
  const pi: FakePi = {
    terminal, parent, overlays, notified, events, violations, customs, answers: {}, parentStartError: undefined, ctx,
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
  /** What openAgentsWorkspace resolved with, once it did. */
  exit: AgentsWorkspaceExit | undefined;
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
  actions?: readonly AgentsActionProvider[];
  state?: AgentsWorkspaceState;
  notices?: readonly string[];
  editorCommand?: () => string | undefined;
  keybindings?: PiKeybindings;
  /** Pi's theme; the default draws text as it is. */
  theme?: Theme;
  /** What Pi's ctx.ui.getToolsExpanded answers; false by default. */
  toolsExpanded?: boolean;
  /** Fields added to the command context (cwd, ...). */
  context?: Readonly<Record<string, unknown>>;
}

/**
 * Opens the workspace with fake Pi pieces; `setup` runs for each source before its first poll settles; `wrap` makes views that wrap;
 * `fail` makes opening fail before the workspace exists (the cursor query) or after it was built (the terminal's start);
 * `listThrow` sets harness.listThrow from the start; `listGate` holds every list() until it resolves; createView throws for `failView`;
 * the view of `failRender` throws from its first render; `nodes` sets harness.nodes; `source` lists instead of the harness;
 * `actions`, `state`, `notices` and `editorCommand` go to the workspace as they are.
 */
export async function open(agents: Listed[], options: OpenOptions = {}): Promise<Harness> {
  const pi = fakePi({ columns: options.columns, rows: options.rows, signal: options.signal, fail: options.fail, keybindings: options.keybindings, theme: options.theme, toolsExpanded: options.toolsExpanded, context: options.context });
  const harness: Harness = Object.assign(pi, {
    agents, nodes: options.nodes, listError: undefined, listThrow: options.listThrow, listCalls: 0, opened: [], sources: [], views: [], left: false,
    done: Promise.resolve(), exit: undefined, parentAtExit: undefined,
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
    ...(options.actions === undefined ? {} : { actions: options.actions }),
    ...(options.state === undefined ? {} : { state: options.state }),
    ...(options.notices === undefined ? {} : { notices: options.notices }),
    ...(options.editorCommand === undefined ? {} : { editorCommand: options.editorCommand }),
  });
  Object.assign(harness, { done: done.then((exit) => { harness.exit = exit; harness.parentAtExit = [...pi.parent]; harness.left = true; }) });
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
export const MENU_HEADING = /─ (Run actions|Agent actions|Subagent actions|Subagents) ─/;
/**
 * The open action menu cut out of the screen as the workspace lays it out (half the width, 32 columns at least, a column clear
 * of each side): heading, the select list's rows, closing rule; [] while none is open.
 */
export function menu(pi: FakePi): string[] {
  const lines = pi.screen();
  const top = lines.findIndex((line) => MENU_HEADING.test(line));
  if (top < 0) return [];
  const columns = pi.terminal.columns;
  const width = Math.min(Math.max(Math.floor(columns / 2), 32), columns - 2);
  const column = (lines[top] ?? "").search(MENU_HEADING);
  const block: string[] = [];
  for (const line of lines.slice(top)) {
    const cell = line.slice(column, column + width).trimEnd();
    block.push(cell);
    if (block.length > 1 && /^─+$/.test(cell)) break;
  }
  return block;
}
/** The menu's heading text and its rows without the closing rule. */
export function menuRows(pi: FakePi): string[] {
  const block = menu(pi);
  return block.length === 0 ? [] : [(block[0] ?? "").replace(/─/g, "").trim(), ...block.slice(1, -1)];
}
/** Polls of 5 ms a case on the real source and providers waits at most: they read the disk. */
export const POLLS = 2000;
/** The workspace is Pi's custom component, drawn as its placeholder, and reads the terminal: not stepped aside, not in its external editor. */
export function workspaceOpen(pi: FakePi): boolean { return pi.terminal.input !== undefined && pi.customs.some(({ component }) => component.render(40)[0] === "opening agents…"); }
/** The title row without the session totals the workspace right-aligns after two or more spaces. */
export function titleOf(pi: FakePi): string { return (pi.screen()[0] ?? "").replace(/ {2,}\S.*$/, "").trimEnd(); }
/** Waits until the workspace is open, listed, with `title` in its title row. */
export async function shown(pi: FakePi, title: RegExp): Promise<void> {
  await until(() => workspaceOpen(pi) && title.test(titleOf(pi)), () => `the workspace open on ${String(title)}; it shows:\n${workspaceOpen(pi) ? pi.screen().join("\n") : "nothing"}\nPi saw:\n${pi.events.join("\n")}`, POLLS);
}
/** a (or `key`) on the selected node: the menu once its labels came. */
export async function menuOf(pi: FakePi, key = "a"): Promise<string[]> {
  pi.send(key);
  await until(() => { const rows = menuRows(pi); return rows.length > 1 && rows[1] !== "loading…"; }, () => `the menu's labels:\n${pi.screen().join("\n")}`, POLLS);
  return menuRows(pi);
}
/** The labels of menuRows without the heading and the selection mark. */
export function labelsOf(rows: readonly string[]): string[] { return rows.slice(1).map((row) => row.replace(/^(→ | {2})/, "")); }
/** Opens the menu of the selected node and runs `label`. */
export async function choose(pi: FakePi, label: string): Promise<void> {
  const labels = labelsOf(await menuOf(pi));
  const index = labels.indexOf(label);
  assert.ok(index >= 0, `${label} offered: ${labels.join(", ")}`);
  pi.send(...Array.from({ length: index }, () => KEY.down), KEY.enter);
}
/** Waits until the workspace takes keys again, an in-place action settled: a opens the menu, esc closes it. Ends the notices. */
export async function idle(pi: FakePi): Promise<void> {
  await until(() => {
    if (!workspaceOpen(pi)) return false;
    if (menu(pi).length === 0) pi.send("a");
    return menu(pi).length > 0;
  }, "the workspace takes keys again", POLLS);
  pi.send(KEY.escape);
}
/** Waits (bounded) for the first agent's view: a real source reads the disk, which takes more than a few turns of the event loop. */
export async function opened(harness: Harness): Promise<void> {
  await until(() => harness.views.length > 0, "the first agent was opened", 400);
}

/**
 * The ActionUi of the provider tests: records every call in `calls` as the method's name, then its arguments (a checkpoint by
 * its name), and answers from `answers`; an unset answer is what a cancel answers.
 */
export function recordingUi(answers: {
  readonly confirm?: (title: string, message: string) => boolean;
  readonly select?: (title: string, options: readonly string[]) => string | undefined;
  readonly input?: (title: string, placeholder: string | undefined) => string | undefined;
  readonly editText?: (title: string, prefill?: string) => string | undefined;
  readonly review?: (checkpoint: AwaitingCheckpoint) => "Approve" | "Reject" | undefined;
} = {}): ActionUi & { readonly calls: (readonly [string, ...unknown[]])[]; of(method: string): unknown[][] } {
  const calls: (readonly [string, ...unknown[]])[] = [];
  return {
    calls,
    of: (method) => calls.filter(([name]) => name === method).map(([, ...args]) => args),
    notify(message, level) { calls.push(["notify", message, level]); },
    async confirm(title, message) { calls.push(["confirm", title, message]); return answers.confirm?.(title, message) ?? false; },
    async select(title, options) { calls.push(["select", title, options]); return answers.select?.(title, options); },
    async input(title, placeholder) { calls.push(["input", title, placeholder]); return answers.input?.(title, placeholder); },
    async editText(title, prefill) { calls.push(prefill === undefined ? ["editText", title] : ["editText", title, prefill]); return answers.editText?.(title, prefill); },
    async reviewCheckpoint(checkpoint) { calls.push(["reviewCheckpoint", checkpoint.name]); return answers.review?.(checkpoint); },
    async openArtifact(artifact, label) { calls.push(["openArtifact", artifact, label]); },
    status(text) { calls.push(["status", text]); },
    setWorkingMessage(message) { calls.push(["setWorkingMessage", message]); },
  };
}

/** The Pi session the fixtures' runs and subagents belong to. */
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
/**
 * The workflow extension over `home` with a fake workspace opener that records each open and resolves it with the next of `exits`
 * (a function is awaited first); its /agents command and its session_shutdown handler.
 */
export function host(home: string, exits: (AgentsWorkspaceExit | undefined | (() => Promise<AgentsWorkspaceExit | undefined>))[] = []): { agents: Command | undefined; shutdown: (() => Promise<void>) | undefined; opened: Opened[] } {
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
    const next = exits.shift();
    return typeof next === "function" ? next() : next;
  });
  return { agents: commands.get("agents"), shutdown, opened };
}

/** The workflow provider's dependencies over a fresh home: `copied` records the clipboard, `calls` the host calls. */
export function workflowFixture(overrides: Partial<WorkflowActionDependencies> = {}): { readonly home: string; readonly cwd: string; readonly deps: WorkflowActionDependencies; readonly copied: string[]; readonly calls: unknown[][] } {
  const { home, cwd } = project("workflow");
  const copied: string[] = [];
  const calls: unknown[][] = [];
  const deps: WorkflowActionDependencies = {
    home,
    clipboard: async (value: string) => { copied.push(value); },
    extensionAgentDir: join(home, "agent"),
    runs: new Map<string, WorkflowRunRecord>(),
    terminalRunStates: new Map<string, HardTerminalRunState>(),
    hardTerminalRunStates: HARD_TERMINAL_RUN_STATES,
    answerCheckpoint: async (...args: unknown[]) => { calls.push(["answerCheckpoint", ...args]); return true; },
    recovery: { answerBudgetDecision: async (...args: unknown[]) => { calls.push(["answerBudgetDecision", ...args]); return { approved: args[2] === true }; } } as unknown as WorkflowActionDependencies["recovery"],
    stopWorkflowRun: async (runId: string) => { calls.push(["stopWorkflowRun", runId]); return { runId, state: "stopped", stopped: true }; },
    moveForegroundToBackground: async (runId: string) => { calls.push(["moveForegroundToBackground", runId]); return { runId, state: "running" as const, detached: true as const }; },
    isForegroundAttached: () => false,
    liveAgents: { get: () => undefined, overlay: (run: PersistedRun) => run },
    registry: { agentAttemptActions: () => ({}) } as unknown as WorkflowActionDependencies["registry"],
    projectTrusted: () => false,
    resumeHostContext: () => ({ model: undefined, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt" }] } }) as unknown as ReturnType<WorkflowActionDependencies["resumeHostContext"]>,
    resumeSelectedWorkflow: async (...args: unknown[]) => { calls.push(["resumeSelectedWorkflow", ...args]); return { workflowName: "wf", state: "running" as const, attached: false }; },
    ...overrides,
  };
  return { home, cwd, deps, copied, calls };
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
/** The run's live record in `state` with the lifecycle the run actions drive; a pause leaves it `onPause`. */
export function liveRun(f: { readonly deps: WorkflowActionDependencies }, store: RunStore, state = "running", onPause: "pausing" | "paused" = "pausing"): { state: string } {
  const lifecycle = { state, async pause() { lifecycle.state = onPause; }, async resume() { lifecycle.state = "running"; } };
  f.deps.runs.set(store.runId, { store, metadata: { name: `${store.runId}-name` }, lifecycle, budget: { usage: { tokens: 0, costUsd: 0, durationMs: 0, agentLaunches: 0 } }, abortController: new AbortController() } as unknown as WorkflowRunRecord);
  return lifecycle;
}
const ATTEMPT: AgentAttemptSummary = { attempt: 1, transport: "local", session: { transport: "local", sessionId: "native", locator: { sessionFile: "/sessions/native.jsonl" } }, setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd: "/repo" }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
/** A completed agent `id`, named so, with one attempt. */
export function agentRecord(id: string, extra: Partial<AgentRecord> = {}): AgentRecord {
  return { id, name: id, path: id, state: "completed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1, attemptDetails: [ATTEMPT], ...extra };
}

export const SUBAGENT_ATTEMPT: AgentAttemptSummary = { attempt: 1, transport: "fixture", setup: { hookNames: [], model: { provider: "fixture", model: "model" }, tools: ["read"], cwd: "/repo" }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } };
const PREPARED = { cwd: "/repo", model: { provider: "fixture", model: "model" }, tools: ["read"], sessionLabel: "scout", systemPrompt: "SYSTEM" } as unknown as PreparedAgentSession;
/**
 * The session's subagents: run-a running (label scout, a worktree, a live system prompt), run-b completed (label scout, a result),
 * run-c failed (no request file), and a run of another session that is never listed; `directory` holds their request files.
 * An `unreadable` id is listed (completed, if new) but cannot be inspected; `delete: false` leaves manager.delete out; `failDelete` cannot be
 * deleted; a retry returns `retry`, or by default adds run-d running to the session and returns it; the clipboard fails with
 * `clipboardError`. `calls` records the manager's controls with their context, `copied` the clipboard.
 */
export function subagentFixture(options: { readonly delete?: boolean; readonly retry?: unknown; readonly failDelete?: string; readonly clipboardError?: string; readonly unreadable?: readonly string[] } = {}) {
  const { home, cwd } = project("subagents");
  const directory = join(home, "subagents");
  for (const [id, request] of Object.entries({ "run-a": { prompt: "PROMPT A", label: "scout", mode: "background" }, "run-b": { prompt: "PROMPT B", label: "scout", mode: "background" } })) {
    mkdirSync(join(directory, id), { recursive: true });
    writeFileSync(join(directory, id, "request.json"), JSON.stringify(request));
  }
  const statuses = new Map<string, Record<string, unknown>>([
    ["run-a", { id: "run-a", sessionId: SESSION, state: "running", startedAt: 1_000, attempts: 1, attemptDetails: [SUBAGENT_ATTEMPT], worktree: { path: "/repo/worktree-a", branch: "subagent/run-a" } }],
    ["run-b", { id: "run-b", sessionId: SESSION, state: "completed", startedAt: 1_000, finishedAt: 2_000, value: { answer: 42 } }],
    ["run-c", { id: "run-c", sessionId: SESSION, state: "failed", startedAt: 1_000, finishedAt: 3_000, error: { code: "AGENT_FAILED", message: "boom" } }],
    ["run-other", { id: "run-other", sessionId: "session-2", state: "completed", startedAt: 1_000, finishedAt: 2_000 }],
  ]);
  for (const id of options.unreadable ?? []) if (!statuses.has(id)) statuses.set(id, { id, sessionId: SESSION, state: "completed", startedAt: 1_000, finishedAt: 1_500 });
  const calls: (readonly [string, unknown, SubagentManagerContext, unknown?])[] = [];
  const copied: string[] = [];
  const known = (id: string): Record<string, unknown> => {
    const status = statuses.get(id);
    if (status === undefined) throw new Error(`Unknown subagent ${id}`);
    return status;
  };
  const manager: SubagentManager = {
    async run() { throw new Error("unexpected run"); },
    async inspect(request) {
      if (request.id === undefined) return [...statuses.values()];
      if (options.unreadable?.includes(request.id)) throw new Error(`inspection of ${request.id} failed`);
      return known(request.id);
    },
    async steer(request, context) { calls.push(["steer", request, context]); return { id: request.id, accepted: true }; },
    async stop(request, context) { calls.push(["stop", request, context]); statuses.set(request.id, { ...known(request.id), state: "stopped", finishedAt: 4_000 }); return {}; },
    async retry(request, context, edits) {
      calls.push(["retry", request, context, edits]);
      if (options.retry !== undefined) return options.retry;
      statuses.set("run-d", { id: "run-d", sessionId: SESSION, state: "running", startedAt: 5_000, attempts: 1 });
      return { id: "run-d", state: "running" };
    },
    ...(options.delete === false ? {} : {
      async delete(request: { readonly id: string }, context: SubagentManagerContext) {
        calls.push(["delete", request, context]);
        if (request.id === options.failDelete) throw new Error("locked");
        statuses.delete(request.id);
        return {};
      },
    }),
    getAttemptActionData(id): SubagentAttemptActionData | undefined { return id === "run-a" && statuses.get(id)?.state === "running" ? { attempt: SUBAGENT_ATTEMPT, prepared: PREPARED, signal: new AbortController().signal } : undefined; },
  };
  const clipboard = async (value: string): Promise<void> => {
    if (options.clipboardError !== undefined) throw new Error(options.clipboardError);
    copied.push(value);
  };
  return { cwd, directory, statuses, calls, copied, clipboard, manager };
}

/**
 * Runs `label` of `provider` through the real loop and Pi action ui, closes the workspace, then makes Pi's context stale and
 * aborts the shutdown (/reload, /new) before `settleAction` lets the detached action finish; what reached Pi's ui and what escaped.
 */
export async function settleAfterShutdown(provider: AgentsActionProvider, target: AgentsActionTarget, label: string, reason: "reload" | "new", settleAction: () => void): Promise<{ readonly touched: string[]; readonly escaped: unknown[] }> {
  const shutdown = new AbortController();
  const touched: string[] = [];
  const escaped: unknown[] = [];
  let stale = false;
  const ctx = { mode: "tui", get ui() { if (stale) throw new Error("This extension ctx is stale after session replacement or reload."); return { notify(message: string) { touched.push(message); }, setWorkingMessage(message?: string) { touched.push(`working ${String(message)}`); } }; } } as unknown as ExtensionCommandContext;
  const exits = [{ target, label, provider, state: { selectedKey: "n", row: 0, expansion: [], focus: "sidebar", sidebarVisible: true, toolsExpanded: false, detailsShown: false } } as AgentsWorkspaceExit, undefined];
  const node = { key: "n", parentKey: undefined, depth: 0, kind: "run", label: "n", state: "running", initiallyExpanded: true, line: () => "n", details: () => [], title: () => "n", agent: undefined, target } as SessionTreeNode;
  const record = (error: unknown): void => { escaped.push(error); };
  process.on("unhandledRejection", record);
  try {
    await runAgentsWorkspace(ctx, {
      open: async () => exits.shift(),
      options: { agents: { list: async () => [node] }, openSource: () => { throw new Error("unexpected"); }, createView: () => { throw new Error("unexpected"); }, shutdown: shutdown.signal },
      providers: [provider],
      actionUi: (onNotify) => createPiActionUi(ctx, { onNotify }),
      hasContent: () => true,
      onEmpty: () => undefined,
    });
    touched.length = 0;
    stale = true;
    shutdown.abort({ type: "session_shutdown", reason });
    settleAction();
    await settle();
    await new Promise((resolve) => setImmediate(resolve));
  } finally { process.off("unhandledRejection", record); Reflect.deleteProperty(globalThis, Symbol.for("pi-extensible-workflows.agents-detached-ui")); }
  return { touched, escaped };
}
