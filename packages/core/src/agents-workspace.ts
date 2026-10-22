import { copyToClipboard, type ExtensionCommandContext, getAgentDir, rawKeyHint, SettingsManager, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { HStack, isKeyRelease, matchesKey, ScrollView, Text, truncateToWidth, TuiAltScreen, VStack, wrapTextWithAnsi, type Component, type Keybinding, type ScrollViewOptions, type TuiInputListenerResult, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { workflowKeyMatches } from "./host-navigator.js";
import { navigateWorkflowPhaseTree, workflowPhaseTreeVisibleNodes, type WorkflowPhaseTree, type WorkflowPhaseTreeDirection, type WorkflowPhaseTreeNode } from "./host-phases.js";
import { navigatorSidebarWidth, progressStyleForState, themeWorkflowProgressStyles, type WorkflowProgressStyles } from "./host-view.js";
import type { SessionAgent, SessionAgentsSource, SessionTreeNode } from "./session-agents.js";
import type { CreateTranscriptView, TranscriptView } from "./transcript-components.js";
import type { TranscriptPoll, TranscriptSource, TranscriptSourceStatus } from "./session-transcript.js";
import { errorText, sanitizeDisplayText } from "./utils.js";

export interface AgentsWorkspaceOptions {
  readonly agents: SessionAgentsSource;
  /** Opens the reader for an owned agent (openSessionTranscript); not called for an agent that is not owned. */
  readonly openSource: (agent: SessionAgent) => TranscriptSource;
  readonly createView: CreateTranscriptView;
  /** Node selected when the workspace opens, its ancestors expanded. The first agent node in sidebar order otherwise, or the first node when there is no agent. */
  readonly initialKey?: string;
  /** Calls `listener` when something may have started to run; returns what stops the calls. While nothing runs a call lists at once, not at the slow tick. */
  readonly changes?: (listener: () => void) => () => void;
  readonly pollIntervalMs?: number;
  /** Aborted by the session_shutdown of the extension that opened the workspace, with its event as the reason: the workspace closes at once, Pi's screen restored; Pi's TUI stays stopped on a quit, as Pi's shutdown stops it. */
  readonly shutdown?: AbortSignal;
}

const SEPARATOR = " │ ";
/** Below this width the sidebar does not fit beside the transcript: it goes above it on a portrait terminal, else it hides; s still shows it. */
const SIDEBAR_MIN_COLUMNS = 80;
/** The tick while no agent runs and the shown transcript is read to its end; it shows what no change reports (another Pi's subagents, a shell's progress). */
const IDLE_POLL_MS = 5000;
/** Title and hint: one row each above and below the body. */
const FIXED_ROWS = 2;

/** As the dashboards: 38% of the width less the separator, 24 to 42 columns, then the separator. */
function sidebarWidth(columns: number): number { return navigatorSidebarWidth(columns) + SEPARATOR.length; }
/** Where the sidebar fits: beside the transcript, above it on a portrait terminal (more rows than half the columns, a cell being about twice as tall as wide), or nowhere. */
function sidebarFit({ columns, rows }: { readonly columns: number; readonly rows: number }): "side" | "top" | undefined { return columns >= SIDEBAR_MIN_COLUMNS ? "side" : rows * 2 > columns ? "top" : undefined; }
function clean(text: string | undefined): string { return sanitizeDisplayText(text ?? "").replace(/\s+/g, " ").trim(); }
/** What makes a fresh transcript: another attempt, another session reference or another owner verdict. */
function identity(agent: SessionAgent): string { return JSON.stringify([agent.attempt ?? null, agent.owned, agent.session ?? null]); }
/** A component of one row, truncated to the width; nothing when the text is empty. */
function row(text: () => string): Component {
  return { render: (width) => { const value = text(); return value ? [truncateToWidth(value, Math.max(1, width), "…")] : []; }, invalidate() {} };
}
/**
 * The sidebar as a /workflow tree whose ids are the node keys, so that /workflow's visibility and navigation
 * (workflowPhaseTreeVisibleNodes, navigateWorkflowPhaseTree) apply to it unchanged; they read only ids, parents and children.
 */
function navigationTree(nodes: readonly SessionTreeNode[]): WorkflowPhaseTree {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (node.parentKey === undefined) continue;
    const siblings = children.get(node.parentKey) ?? [];
    siblings.push(node.key);
    children.set(node.parentKey, siblings);
  }
  // The other fields are placeholders: nothing reads them.
  const treeNodes = nodes.map((node): WorkflowPhaseTreeNode => ({ id: node.key, kind: "phase", label: "", depth: node.depth, phaseId: "", operationPath: [], ...(node.parentKey === undefined ? {} : { parentId: node.parentKey }), children: children.get(node.key) ?? [], state: "running" }));
  //NOTE: a node whose parent is not listed is in no root's subtree, so it never shows.
  return { roots: nodes.filter((node) => node.parentKey === undefined).map(({ key }) => key), nodes: treeNodes, byId: new Map(treeNodes.map((node) => [node.id, node])) };
}

/** Pi's fullscreen scrollbar setting and the theme's scrollbar colours, for every pane that scrolls. */
type Scrollbar = Pick<ScrollViewOptions, "scrollbar" | "scrollbarTrackStyle" | "scrollbarThumbStyle">;

/** The transcript's primary scroll view. */
class TranscriptScroll extends ScrollView {
  constructor(content: Component, scrollbar: Scrollbar) { super(content, { follow: "end", primary: true, ...scrollbar }); }
}


/** The selected agent's transcript; replaced as a whole when another agent, attempt or session is selected. */
interface Shown {
  agent: SessionAgent;
  readonly identity: string;
  /** Both undefined when the agent is not owned. */
  readonly source: TranscriptSource | undefined;
  readonly view: TranscriptView | undefined;
  readonly scroll: TranscriptScroll;
  /** Ends the subscription to agent.live; replaced when a refresh brings another stream. */
  unsubscribe: (() => void) | undefined;
  /** The source's calls in order: a call starts after the previous one settled. */
  queue: Promise<unknown>;
  /** Poll on every tick; cleared by the first poll that started with the agent stopped. */
  polling: boolean;
  pollInFlight: boolean;
  /** No read started yet: the first waits while another agent's first read is in flight. */
  unread: boolean;
  status: TranscriptSourceStatus | undefined;
  reason: string | undefined;
  failure: string | undefined;
}

class Workspace {
  /** The sidebar tree in sidebar order, by key, and as the /workflow tree the navigation runs on. */
  private nodes: readonly SessionTreeNode[] = [];
  private byKey: ReadonlyMap<string, SessionTreeNode> = new Map();
  private tree: WorkflowPhaseTree = navigationTree([]);
  private selectedKey: string | undefined;
  /**
   * The expansion of every key recorded: its initiallyExpanded the first time a list gives its node children (a phase listed
   * before its first agent then expands as /workflow expands it), so a later list never changes it (a run that finishes while
   * shown does not collapse); then left/right, space, an icon click, and [, ] and the initial key for the ancestors of the agent
   * they selected.
   */
  private readonly expansion = new Map<string, boolean>();
  private listed = false;
  /** options.initialKey until a node was selected. */
  private initialKey: string | undefined;
  private listing = false;
  /** A failed list, or a throw while no transcript is shown; in the title until the next list succeeds. */
  private failure: string | undefined;
  /** The transcript of the selected node when it is an agent. */
  private shown: Shown | undefined;
  /** The right pane of the selected node when it is not an agent; a new one for each selection. */
  private detailsScroll: ScrollView | undefined;
  private focus: "sidebar" | "transcript";
  private sidebarVisible: boolean;
  /** Where the sidebar fits (sidebarFit), as the last resize left the terminal. */
  private fit: "side" | "top" | undefined;
  /** s hid the sidebar while it fitted: a resize does not bring it back. */
  private sidebarHidden: boolean;
  private expanded: boolean;
  private sidebarTop = 0;
  /** The node key of each sidebar row of the last frame, for clicks; undefined for a rule. */
  private sidebarKeys: (string | undefined)[] = [];
  private finished = false;
  private readonly styles: WorkflowProgressStyles;
  /** What the last list showed outside the transcript (listedRows); undefined after a key or a failure drew something else. */
  private lastListedRows: string | undefined;
  /** The refresh and poll ticks; started once the first list settled. */
  private timer: ReturnType<typeof setInterval> | undefined;
  /** The ticks run IDLE_POLL_MS apart: the last list showed no agent running and the shown transcript was read to its end. */
  private idle = false;
  /** Stops options.changes calling the workspace. */
  private readonly unsubscribe: (() => void) | undefined;
  /** An agent's first read is in flight: no other agent's starts until it settles, then only the agent shown then is read. */
  private firstReading = false;
  private readonly title = row(() => this.titleText());
  private readonly hint = row(() => this.hintText());
  private readonly status = row(() => this.statusText());
  private readonly sidebar: Component = { render: (width) => this.renderSidebar(width), handleMouse: (event) => this.sidebarMouse(event), invalidate() {} };
  private readonly placeholder: TranscriptScroll;
  /** The selected node's details, read at every frame, wrapped to the width. */
  private readonly details: Component = { render: (width) => this.detailsLines(width), invalidate() {} };

  constructor(private readonly alt: TuiAltScreen, theme: Theme, private readonly keybindings: KeybindingsManager, private readonly options: AgentsWorkspaceOptions, private readonly leave: (cause?: unknown) => void, toolsExpanded: boolean, private readonly scrollbar: Scrollbar, private readonly settings: SettingsManager) {
    this.styles = themeWorkflowProgressStyles(theme);
    this.placeholder = new TranscriptScroll(row(() => this.listed ? "no agents in this Pi session" : "loading agents…"), scrollbar);
    this.initialKey = options.initialKey;
    this.fit = sidebarFit(alt.terminal);
    this.sidebarHidden = false;
    this.sidebarVisible = this.fit !== undefined && !this.sidebarHidden;
    this.focus = this.sidebarVisible ? "sidebar" : "transcript";
    this.expanded = toolsExpanded;
    // Runs after the alt screen's viewport listener (pgup/pgdn, search, the wheel): the terminal openAgentsWorkspace gives the alt screen puts gate() before both.
    alt.addInputListener((data) => this.input(data));
    this.unsubscribe = options.changes?.(() => { this.wake(); });
    this.rebuild();
    this.refresh();
  }

  /** Throws only what the alt screen's stop threw (a terminal that cannot stop), and only after everything else was let go. */
  dispose(): void {
    this.finished = true;
    try {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
      const shown = this.shown;
      this.shown = undefined;
      if (shown) this.close(shown);
      this.unsubscribe?.();
    } finally {
      // Last, so its throw skips nothing here; the caller restores Pi after it.
      this.alt.stop({ preserveScreen: true });
    }
  }

  start(): void { this.alt.start(); }
  /** The terminal's input before the alt screen sees it, which it reaches as it came. */
  gate(data: string, pass: (data: string) => void): void {
    this.lastListedRows = undefined;
    pass(data);
  }
  private input(data: string): TuiInputListenerResult {
    // A throw from a view or a component ends as a status line, not in the alt screen's input dispatch.
    try { return this.key(data); } catch (error) { this.report(error); return { consume: true }; }
  }
  private key(data: string): TuiInputListenerResult {
    if (isKeyRelease(data)) return undefined;
    // ctrl+c leaves at once, also while the search box is open.
    if (matchesKey(data, "ctrl+c")) { this.leave(); return { consume: true }; }
    // While an overlay (the search box) is open, every other key is its input.
    if (this.alt.hasOverlay()) return undefined;
    const is = (keybinding: Keybinding): boolean => this.keybindings.matches(data, keybinding);
    // In the sidebar j, k, h and l move as the arrows do, as in /workflow.
    const sidebar = this.focus === "sidebar";
    const moves = (keybinding: Keybinding): boolean => sidebar ? workflowKeyMatches(this.keybindings, data, keybinding) : is(keybinding);
    if (is("tui.select.cancel")) { this.leave(); return { consume: true }; }
    if (is("tui.input.tab")) { if (this.sidebarVisible) this.focus = sidebar ? "transcript" : "sidebar"; }
    else if (moves("tui.select.up") || moves("tui.select.down")) {
      const up = moves("tui.select.up");
      if (sidebar) this.navigate(up ? "up" : "down");
      else this.alt.scrollBy(up ? -1 : 1);
    } else if (sidebar && (moves("tui.editor.cursorLeft") || moves("tui.editor.cursorRight"))) this.navigate(moves("tui.editor.cursorLeft") ? "left" : "right");
    else if (sidebar && matchesKey(data, "space")) { const node = this.selectedNode(); if (node) this.toggle(node); }
    else if (matchesKey(data, "[") || matchesKey(data, "]")) this.jump(matchesKey(data, "[") ? -1 : 1);
    // The alt screen binds its top/bottom actions to home/end only; ctrl+home/ctrl+end reach the transcript here.
    else if (matchesKey(data, "ctrl+home")) this.alt.scrollToTop();
    else if (matchesKey(data, "ctrl+end")) this.alt.scrollToBottom();
    else if (matchesKey(data, "s")) {
      this.sidebarVisible = !this.sidebarVisible;
      this.sidebarHidden = !this.sidebarVisible && this.fit !== undefined;
      this.focus = this.sidebarVisible ? "sidebar" : "transcript";
      this.rebuild();
    } else if (is("app.tools.expand")) {
      this.expanded = !this.expanded;
      this.shown?.view?.setExpanded(this.expanded);
    } else return undefined;
    this.alt.requestRender();
    return { consume: true };
  }

  /**
   * Run by the terminal wrapper in openAgentsWorkspace, before the alt screen sees a resize or starts again (a resize while the editor had the terminal reaches no one). A resize
   * that changes where the sidebar fits: where it does not it hides; where it does it shows again, focused, unless s hid it while it
   * could show, and stands beside or above the transcript; a resize that keeps the fit changes nothing, so s still decides there.
   */
  resized(): void {
    const fit = sidebarFit(this.alt.terminal);
    if (fit === this.fit) return;
    this.fit = fit;
    const visible = fit !== undefined && !this.sidebarHidden;
    if (visible !== this.sidebarVisible) {
      this.sidebarVisible = visible;
      this.focus = visible ? "sidebar" : "transcript";
    }
  }

  private rebuild(): void {
    const transcript = new VStack([{ component: this.detailsScroll ?? this.shown?.scroll ?? this.placeholder, grow: 1, basis: 0 }, { component: this.status, shrink: 0 }]);
    // The sidebar sizes itself (basis auto); stack entries shrink by default, so fixed parts need shrink 0. It shows above or beside the transcript as the last resized() left it; visible() only reads.
    const sidebar = (top: boolean) => ({ component: this.sidebar, shrink: 0, visible: () => this.sidebarVisible && (this.fit === "top") === top });
    const body = new VStack([sidebar(true), { component: new HStack([sidebar(false), { component: transcript, grow: 1, basis: 0 }]), grow: 1, basis: 0 }]);
    this.alt.setLayoutRoot(new VStack([{ component: this.title, shrink: 0 }, { component: body, grow: 1, basis: 0 }, { component: this.hint, shrink: 0 }]));
    // Scroll keys and the wheel act on the primary view of the last frame: draw now, not on the next tick, so none reaches a stale layout.
    this.alt.renderNow();
  }

  private selectedNode(): SessionTreeNode | undefined { return this.selectedKey === undefined ? undefined : this.byKey.get(this.selectedKey); }
  /** The right pane of the selected node's details, scrolled from the top. */
  private detailsPane(): ScrollView { return new ScrollView(this.details, { primary: true, ...this.scrollbar }); }
  private isExpanded(node: SessionTreeNode): boolean { return this.expansion.get(node.key) ?? node.initiallyExpanded; }
  private expandedKeys(): ReadonlySet<string> { return new Set(this.nodes.filter((node) => this.isExpanded(node)).map(({ key }) => key)); }
  /** The nodes whose ancestors are all expanded, in sidebar order. */
  private visible(): SessionTreeNode[] {
    return workflowPhaseTreeVisibleNodes(this.tree, this.expandedKeys()).flatMap(({ id }) => this.byKey.get(id) ?? []);
  }
  /** Up, down, left and right as in /workflow: navigateWorkflowPhaseTree over the sidebar and its expansion. */
  private navigate(direction: WorkflowPhaseTreeDirection): void {
    if (this.nodes.length === 0) return;
    const expanded = this.expandedKeys();
    const next = navigateWorkflowPhaseTree(this.tree, this.selectedKey, expanded, direction);
    for (const node of this.nodes) {
      if (next.expandedNodeIds.has(node.key) !== expanded.has(node.key)) this.expansion.set(node.key, next.expandedNodeIds.has(node.key));
    }
    const node = next.nodeId === undefined ? undefined : this.byKey.get(next.nodeId);
    if (node && node.key !== this.selectedKey) this.select(node);
  }
  /** [ and ]: the agent before or after the selected node in sidebar order, collapsed ones included, round at both ends; its ancestors are expanded. */
  private jump(delta: number): void {
    const index = this.nodes.findIndex((node) => node.key === this.selectedKey);
    const others = [...this.nodes.slice(index + 1), ...this.nodes.slice(0, Math.max(0, index))].filter((node) => node.agent !== undefined);
    const next = delta > 0 ? others[0] : others.at(-1);
    if (!next) return;
    this.reveal(next);
    this.select(next);
  }
  private reveal(node: SessionTreeNode): void {
    const seen = new Set<string>();
    for (let key = node.parentKey; key !== undefined && !seen.has(key); key = this.byKey.get(key)?.parentKey) {
      seen.add(key);
      this.expansion.set(key, true);
    }
  }
  /** Space and a click on the ▾/▸ icon: a node with children collapses or expands; any other node stays as it is. */
  private toggle(node: SessionTreeNode): void {
    if (this.hasChildren(node)) this.expansion.set(node.key, !this.isExpanded(node));
  }
  private hasChildren(node: SessionTreeNode): boolean { return (this.tree.byId.get(node.key)?.children.length ?? 0) > 0; }

  private refresh(): void {
    if (this.listing || this.finished) return;
    this.listing = true;
    // A list() that throws synchronously rejects this promise, as one that returns a rejected promise does.
    void new Promise<readonly SessionTreeNode[]>((resolve) => { resolve(this.options.agents.list()); }).then((nodes) => {
      this.listing = false;
      if (this.finished) return;
      this.failure = undefined;
      this.guard(() => { this.apply(nodes); });
      this.startTicks();
    }, (error: unknown) => {
      this.listing = false;
      if (this.finished) return;
      const failure = `agents unavailable: ${errorText(error)}`;
      if (failure !== this.failure) {
        this.failure = failure;
        this.lastListedRows = undefined;
        this.alt.requestRender();
      }
      this.startTicks();
    });
  }
  /**
   * Refresh and poll from the first settled list on: every pollIntervalMs while the last list shows an agent running or the shown
   * transcript is still read, else every IDLE_POLL_MS; called again by later lists, it starts the interval again only when that changes.
   */
  private startTicks(): void {
    const shown = this.shown;
    const idle = !this.nodes.some((node) => node.agent?.running === true) && !(shown?.source !== undefined && shown.polling);
    if ((this.timer && idle === this.idle) || this.finished) return;
    if (this.timer) clearInterval(this.timer);
    this.idle = idle;
    this.timer = setInterval(() => {
      this.refresh();
      if (this.shown) this.poll(this.shown);
    }, idle ? IDLE_POLL_MS : this.options.pollIntervalMs ?? 1000);
    this.timer.unref();
  }
  /** options.changes called: while nothing runs the list is read now; while something runs the next tick reads it. */
  private wake(): void {
    //NOTE: a change reported while a list is in flight waits for the next tick.
    if (this.idle) this.refresh();
  }
  /**
   * A new list keeps the selection and the expansion by key; a removed node gives the selection to the node now at its row.
   * A key takes its initiallyExpanded the first time a list gives its node children. Until a node is selected, the initial key
   * (its ancestors expanded), else the first agent node (its ancestors expanded), else the first node is selected.
   * A frame is drawn only when what the list shows outside the transcript changed (listedRows); the selection's own changes draw theirs.
   */
  private apply(nodes: readonly SessionTreeNode[]): void {
    const row = this.visible().findIndex((node) => node.key === this.selectedKey);
    this.listed = true;
    this.nodes = nodes;
    this.byKey = new Map(nodes.map((node) => [node.key, node]));
    this.tree = navigationTree(nodes);
    // A node without children yet (a phase before its first agent) is not recorded: it takes its initiallyExpanded once it has some.
    for (const node of nodes) if (!this.expansion.has(node.key) && this.hasChildren(node)) this.expansion.set(node.key, node.initiallyExpanded);
    let wanted = this.selectedNode();
    if (!wanted && this.selectedKey !== undefined) {
      const visible = this.visible();
      wanted = visible[Math.min(Math.max(0, row), visible.length - 1)];
    } else if (!wanted) wanted = this.firstSelection(nodes);
    //NOTE: a refresh that moves the selected node under a node the user collapsed leaves it selected but hidden.
    const shown = this.shown;
    const agent = wanted?.agent;
    if (wanted && shown && agent && wanted.key === this.selectedKey && identity(agent) === shown.identity) {
      // A live session registered after the agent was opened, or another one, needs its own subscription.
      if (agent.live !== shown.agent.live) {
        shown.unsubscribe?.();
        shown.unsubscribe = shown.view ? this.subscribe(agent, shown.view) : undefined;
      }
      shown.agent = agent;
      if (agent.running) shown.polling = true;
    } else if (wanted?.key !== this.selectedKey || shown || agent) this.select(wanted);
    const rows = this.listedRows();
    if (rows === this.lastListedRows) return;
    this.lastListedRows = rows;
    this.alt.requestRender();
  }
  /** Every row a list can change outside the transcript: the title, the hint, the status row, the sidebar and the details pane. */
  private listedRows(): string {
    const columns = Math.max(1, this.alt.terminal.columns);
    return [this.titleText(), this.hintText(), this.statusText(), ...(this.sidebarVisible ? this.renderSidebar(columns) : []), ...(this.detailsScroll ? this.detailsLines(this.transcriptWidth()) : [])].join("\n");
  }
  private firstSelection(nodes: readonly SessionTreeNode[]): SessionTreeNode | undefined {
    const initial = this.initialKey === undefined ? undefined : this.byKey.get(this.initialKey);
    const wanted = initial ?? nodes.find((node) => node.agent !== undefined) ?? nodes[0];
    if (wanted) this.reveal(wanted);
    return wanted;
  }

  /** An agent opens its transcript; any other node shows its details and opens nothing. */
  private select(node: SessionTreeNode | undefined): void {
    const previous = this.shown;
    this.shown = undefined;
    if (previous) this.close(previous);
    this.selectedKey = node?.key;
    if (node) this.initialKey = undefined;
    this.detailsScroll = node && !node.agent ? this.detailsPane() : undefined;
    if (node?.agent) this.shown = this.open(node.agent);
    this.rebuild();
  }
  private open(agent: SessionAgent): Shown {
    const base = { agent, identity: identity(agent), queue: Promise.resolve(), polling: true, pollInFlight: false, unread: true, status: undefined, reason: undefined, failure: undefined };
    // The session file of an agent that is not owned is never opened.
    if (!agent.owned) return { ...base, source: undefined, view: undefined, unsubscribe: undefined, scroll: new TranscriptScroll(new Text("transcript unavailable", 0, 0), this.scrollbar) };
    let source: TranscriptSource | undefined;
    let view: TranscriptView | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      source = this.options.openSource(agent);
      view = this.options.createView({ ui: this.alt, cwd: agent.cwd, styles: this.styles, settings: this.settings });
      view.setExpanded(this.expanded);
      unsubscribe = this.subscribe(agent, view);
      const shown: Shown = { ...base, source, view, unsubscribe, scroll: new TranscriptScroll(view.component, this.scrollbar) };
      // The first read waits a turn: keys that move on before it (ten in one stdin event) leave it unread; poll() holds it while
      // another agent's first read is in flight (a held ↓, each repeat in its own turn).
      setImmediate(() => { if (this.shown === shown) this.poll(shown); });
      return shown;
    } catch (error) {
      // What opened before the throw is closed; the agent stays selected with the error as its status line until another attempt or selection.
      this.close({ source, view, unsubscribe, queue: base.queue });
      return { ...base, source: undefined, view: undefined, unsubscribe: undefined, scroll: new TranscriptScroll(row(() => ""), this.scrollbar), failure: `transcript unavailable: ${errorText(error)}` };
    }
  }
  /** Forwards the message being generated to the view while it is the one shown; the view asks for its own frames. */
  private subscribe(agent: SessionAgent, view: TranscriptView): (() => void) | undefined {
    // The listener runs in the agent session's event emitter: a throw from the view must stay here.
    return agent.live?.subscribe((event) => {
      //NOTE: an event the stream replays while it subscribes reaches the view before `shown` holds it; a throw then is reported in the title.
      if (this.shown === undefined || this.shown.view === view) this.guard(() => { view.live(event); });
    });
  }
  /** Every step runs even when an earlier one throws: a view that fails to dispose still lets the source close. */
  private close(shown: Pick<Shown, "source" | "view" | "unsubscribe" | "queue">): void {
    this.guard(() => { shown.unsubscribe?.(); });
    this.guard(() => { shown.view?.dispose(); });
    const source = shown.source;
    // Closing waits for the call in flight: the descriptor must not close under a read.
    if (source) void this.call(shown, () => source.close()).catch(() => undefined);
  }

  private call<T>(shown: Pick<Shown, "queue">, operation: () => Promise<T>): Promise<T> {
    const result = shown.queue.then(operation);
    shown.queue = result.catch(() => undefined);
    return result;
  }
  private failed(shown: Shown, error: unknown): void {
    if (this.shown !== shown) return;
    shown.failure = `transcript read failed: ${errorText(error)}`;
    this.alt.requestRender();
  }
  /** Runs work done after a result, a key or a live event; a throw ends as a status line, never as an uncaught exception or unhandled rejection. */
  private guard(step: () => void): boolean {
    try {
      step();
      return true;
    } catch (error) {
      this.report(error);
      return false;
    }
  }
  /** The shown transcript's status line, or the title while none is shown; nothing once the workspace is left. */
  private report(error: unknown): void {
    if (this.finished) return;
    if (this.shown) this.shown.failure = `transcript failed: ${errorText(error)}`;
    else this.failure = `agents workspace failed: ${errorText(error)}`;
    this.lastListedRows = undefined;
    this.alt.requestRender();
  }
  private poll(shown: Shown): void {
    const { source, view } = shown;
    if (!source || !view || !shown.polling || shown.pollInFlight) return;
    const first = shown.unread;
    //NOTE: a first read that never settles holds the first read of every agent shown after it.
    if (first && this.firstReading) return;
    shown.unread = false;
    if (first) this.firstReading = true;
    shown.pollInFlight = true;
    let last = false;
    void this.call(shown, () => { last = !shown.agent.running; return source.poll(); }).then((result) => {
      shown.pollInFlight = false;
      if (last) shown.polling = false;
      if (first) this.firstSettled();
      if (this.shown === shown) this.guard(() => { this.applyPoll(shown, view, result); });
    }, (error: unknown) => {
      shown.pollInFlight = false;
      if (last) shown.polling = false;
      if (first) this.firstSettled();
      this.failed(shown, error);
    });
  }
  /** The first read in flight settled: the agent shown now is read if it was not; the ones passed over meanwhile never are. */
  private firstSettled(): void {
    this.firstReading = false;
    if (this.shown?.unread) this.poll(this.shown);
  }
  /**
   * The source's state is taken first: a view that throws leaves its error as the status line, and the next poll goes on from the
   * source. A frame is drawn only for a reset, appended records or a change of what the status row and the scroll read.
   */
  private applyPoll(shown: Shown, view: TranscriptView, result: TranscriptPoll): void {
    const before = JSON.stringify([shown.status, shown.reason, shown.failure]);
    shown.status = result.status;
    shown.reason = result.reason;
    shown.failure = undefined;
    if (result.reset) {
      view.reset();
      shown.scroll.scrollToEnd();
    }
    if (result.appended.length > 0) view.append(result.appended);
    if (result.reset || result.appended.length > 0 || JSON.stringify([shown.status, shown.reason, shown.failure]) !== before) this.alt.requestRender();
  }

  /** The width the layout gives the transcript pane: the terminal less a sidebar beside it. */
  private transcriptWidth(): number {
    const columns = Math.max(1, this.alt.terminal.columns);
    //NOTE: a sidebar wider than the terminal leaves the transcript no column; the measure then uses one.
    return this.sidebarVisible && this.fit !== "top" ? Math.max(1, columns - sidebarWidth(columns)) : columns;
  }

  /** "#<position>/<count>" among the agent nodes, the name, state and summary for an agent; the label and state for any other node. */
  private titleText(): string {
    const agent = this.shown?.agent;
    const failure = this.failure ? ` ${this.styles.warning(clean(this.failure))}` : "";
    const node = this.selectedNode();
    if (!agent) return node ? `${node.title(this.styles)}${failure}` : `${this.styles.bold(this.listed ? "no agents" : "agents")}${failure}`;
    const agents = this.nodes.filter((candidate) => candidate.agent !== undefined);
    const position = `#${String(agents.findIndex((candidate) => candidate.key === this.selectedKey) + 1)}/${String(agents.length)}`;
    const state = clean(agent.state);
    return [position, this.styles.bold(clean(agent.name)), progressStyleForState(state, this.styles)(state), this.styles.muted(clean(agent.summary))].filter((part) => part).join(" ") + failure;
  }
  /** The selected node's details as /workflow shows them, wrapped to the pane. */
  private detailsLines(width: number): string[] {
    const cell = Math.max(1, width);
    return (this.selectedNode()?.details(this.styles, Date.now()) ?? []).flatMap((line) => wrapTextWithAnsi(line, cell).map((part) => truncateToWidth(part, cell, "")));
  }
  private hintText(): string {
    // Pi's keyHint over the keybindings Pi handed the workspace (Pi's own reads the keybindings of its own pi-tui).
    const keyHint = (keybinding: Keybinding, description: string): string => rawKeyHint(this.keybindings.getKeys(keybinding).join("/"), description);
    // A move names the first key of each direction; [ ] s and space are fixed keys.
    const first = (keybinding: Keybinding): string => this.keybindings.getKeys(keybinding)[0] ?? "";
    const separator = this.styles.dim(" · ");
    // back right after the move, so a narrow terminal keeps it.
    return [
      this.focus === "sidebar" ? rawKeyHint(`${first("tui.editor.cursorLeft")}/${first("tui.editor.cursorRight")}`, "fold") : rawKeyHint(`${first("tui.select.up")}/${first("tui.select.down")}`, "scroll"),
      keyHint("tui.select.cancel", "back"),
      rawKeyHint("[ ]", "agent"),
      ...(this.sidebarVisible ? [keyHint("tui.input.tab", "focus")] : []),
      keyHint("tui.altScreen.search", "search"),
      rawKeyHint("s", "sidebar"),
      keyHint("app.tools.expand", "tools"),
    ].join(separator);
  }
  /** The shown transcript's state. */
  private statusText(): string {
    const shown = this.shown;
    // A failure first: also an agent whose transcript could not be opened has one, and no source.
    if (shown?.failure) return this.styles.warning(clean(shown.failure));
    if (!shown?.source) return "";
    if (shown.status === "waiting") return this.styles.muted(shown.agent.running ? "waiting for the first message" : "no transcript");
    if (shown.status === "unavailable") return this.styles.muted(shown.reason ? `transcript unavailable: ${clean(shown.reason)}` : "transcript unavailable");
    return shown.agent.running && shown.agent.activity ? this.styles.dim(clean(shown.agent.activity)) : "";
  }

  /**
   * The visible nodes as their rows, scrolled to keep the selection in view: beside the transcript as wide as sidebarWidth of the
   * terminal and as tall as the body; above it as wide as the terminal and at most a third of the body. A dim rule
   * above every top-level node but the first row shows where one run (or the group) ends and the next begins.
   */
  private renderSidebar(width: number): string[] {
    const top = this.fit === "top";
    const total = top ? Math.max(1, width) : Math.min(Math.max(1, width), sidebarWidth(Math.max(1, this.alt.terminal.columns)));
    const cell = top ? total : Math.max(0, total - SEPARATOR.length);
    const body = Math.max(1, this.alt.terminal.rows - FIXED_ROWS);
    // A rule is a row without a node: nothing selects it, and the scroll counts it.
    const rows = this.visible().flatMap((node, index): { readonly node: SessionTreeNode | undefined }[] => index > 0 && node.parentKey === undefined ? [{ node: undefined }, { node }] : [{ node }]);
    // Above the transcript the last row of the tree's third is a rule, so the tree's end shows where the side-by-side layout has " │ ".
    const height = top ? Math.min(rows.length, Math.max(0, Math.floor(body / 3) - 1)) : body;
    const selectedRow = rows.findIndex(({ node }) => node !== undefined && node.key === this.selectedKey);
    if (selectedRow >= 0 && selectedRow < this.sidebarTop) this.sidebarTop = selectedRow;
    else if (selectedRow >= this.sidebarTop + height) this.sidebarTop = selectedRow - height + 1;
    this.sidebarTop = Math.max(0, Math.min(this.sidebarTop, rows.length - height));
    const visible = rows.slice(this.sidebarTop, this.sidebarTop + height);
    this.sidebarKeys = visible.map(({ node }) => node?.key);
    const lines = Array.from({ length: height }, (_, index) => {
      const shown = visible[index];
      const node = shown?.node;
      const text = node ? node.line(this.styles, node.key === this.selectedKey, this.isExpanded(node)) : shown ? this.styles.dim("─".repeat(cell)) : "";
      return truncateToWidth(`${truncateToWidth(text, cell, "…", true)}${top ? "" : this.styles.dim(SEPARATOR)}`, total, "", true);
    });
    return top && height > 0 ? [...lines, this.styles.dim("─".repeat(total))] : lines;
  }
  /**
   * A click on a row selects its node, and on its ▾/▸ icon also toggles it; a click on a rule does nothing; the wheel is left to the
   * transcript.
   */
  private sidebarMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== "left" || (event.type !== "press" && event.type !== "release" && event.type !== "click")) return undefined;
    if (event.type === "click") {
      const key = this.sidebarKeys[event.y];
      const node = key === undefined ? undefined : this.byKey.get(key);
      if (node) {
        this.focus = "sidebar";
        // Runs from pi-tui's mouse dispatch, outside input()'s try/catch: a throw here would escape uncaught.
        try {
          // Every row, a header too, draws its icon at column 2 + 2 * depth (SessionTreeNode.line).
          if (event.x === 2 + 2 * node.depth) this.toggle(node);
          if (node.key !== this.selectedKey) this.select(node);
        } catch (error) { this.report(error); }
      }
    }
    // A handled press makes the release a click on this component.
    return { handled: true };
  }
}

/** Resolves when the user leaves the workspace and Pi's own TUI is back. */
export type OpenAgentsWorkspace = (ctx: ExtensionCommandContext, options: AgentsWorkspaceOptions) => Promise<void>;

/**
 * Resolves once Pi's TUI is back.
 * In Pi 1.1.0 a ctx.ui.custom overlay whose factory stops the parent TUI ({ preserveScreen: true }) and starts a TuiAltScreen
 * on parent.terminal owns the screen; parent.start() and parent.renderNow(false) give it back. The alt screen's primary
 * ScrollView takes pgup/pgdn and the tui.altScreen.* actions (search included) whatever has focus, and input listeners
 * added after its construction run after its viewport listener.
 */
export const openAgentsWorkspace: OpenAgentsWorkspace = async (ctx, options) => {
  // Awaited inside an async function: a custom that throws synchronously rejects this promise.
  await ctx.ui.custom<undefined>((parent, theme, keybindings, done) => {
    const signal = ctx.signal;
    const shutdown = options.shutdown;
    let workspace: Workspace | undefined;
    /** Set before parent.stop(): from then on leaving restarts Pi, exactly once. */
    let stopped = false;
    // A quit stops Pi's TUI (before session_shutdown, or after it on a signal): the workspace leaves now, whatever it is doing, and
    // does not start Pi's TUI again. A session replaced in a Pi that goes on leaves as an abort does.
    const shut = (): void => { if ((shutdown?.reason as { readonly reason?: unknown } | undefined)?.reason === "quit") { stopped = false; leave(); } else abort(); };
    let left = false;
    // An uncaught exception emits no session_shutdown. Node runs 'uncaughtExceptionMonitor' listeners before Pi's 'uncaughtException'
    // handler prints the crash and calls process.exit(1), so the terminal is restored there, before the crash is printed; 'exit'
    // restores it on a process.exit() without an exception. It is restored once, by whichever comes first.
    //NOTE: Pi's interactive mode, the only one that draws a custom, exits from its first 'uncaughtException' listener; a host whose
    // listeners let the process go on keeps a disposed workspace and a stopped Pi.
    const exited = (): void => {
      process.off("exit", exited);
      process.off("uncaughtExceptionMonitor", exited);
      try { workspace?.dispose(); } catch { /* A throwing monitor makes Node exit with code 7 before Pi restores its terminal and reports the crash. */ }
    };
    const abort = (): void => { leave(); };
    /** `cause`: the error that closed the workspace (the terminal or the view failed to start), reported once. */
    const leave = (cause?: unknown): void => {
      if (left) return;
      left = true;
      signal?.removeEventListener("abort", abort);
      shutdown?.removeEventListener("abort", shut);
      process.off("exit", exited);
      process.off("uncaughtExceptionMonitor", exited);
      //NOTE: a terminal that cannot stop or start (setRawMode on a closed TTY) throws out of leave and may leave Pi stopped.
      workspace?.dispose();
      if (stopped) { parent.start(); parent.renderNow(false); }
      done(undefined);
      if (cause !== undefined) ctx.ui.notify(`agents workspace failed: ${errorText(cause)}`, "error");
    };
    signal?.addEventListener("abort", abort, { once: true });
    shutdown?.addEventListener("abort", shut, { once: true });
    queueMicrotask(() => {
      if (left) return;
      if (signal?.aborted || shutdown?.aborted) { leave(); return; }
      let alt: TuiAltScreen | undefined;
      try {
        // Pi's fullscreen and display settings, as Pi's own fullscreen renderer and chat take them.
        const settings = SettingsManager.create(ctx.cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() });
        const match = (text: string): string => theme.bg("searchMatchBg", theme.fg("searchMatchText", text));
        stopped = true;
        parent.stop({ preserveScreen: true });
        // pi-tui hands the terminal's input to the input listeners in the order they were added, and TuiAltScreen adds its own (the page
        // keys, search, the wheel) in its constructor: no listener or option runs before it. So the alt screen gets Pi's terminal behind
        // a wrapper, Pi's own object left as it is, whose start puts gate() in front of the input handler the alt screen gives it.
        const terminal = new Proxy(parent.terminal, {
          get: (target, key) => {
            if (key === "start") return (onInput: (data: string) => void, onResize: () => void): void => { workspace?.resized(); target.start((data) => { if (workspace) workspace.gate(data, onInput); else onInput(data); }, () => { workspace?.resized(); onResize(); }); };
            const value: unknown = Reflect.get(target, key);
            return typeof value === "function" ? (...args: unknown[]): unknown => Reflect.apply(value, target, args) : value;
          },
        });
        alt = new TuiAltScreen(terminal, parent.getShowHardwareCursor(), undefined, {
          mouse: true,
          copyOnSelect: settings.getFullscreenCopyOnSelect(),
          wheelScrollLines: settings.getFullscreenWheelScrollLines(),
          copySelection: async (text) => { try { await copyToClipboard(text); return true; } catch (error) { return errorText(error); } },
          searchMatchStyle: (text) => theme.underline(match(text)),
          searchCurrentMatchStyle: (text) => theme.bold(theme.inverse(match(text))),
          searchNavigationButtonStyle: (text, hovered) => hovered ? theme.underline(text) : text,
          scrollToEndIndicator: () => " ↓ latest ",
        });
        const scrollbar: Scrollbar = { scrollbar: settings.getFullscreenScrollbar(), scrollbarTrackStyle: (text) => theme.fg("scrollbarTrack", text), scrollbarThumbStyle: (text) => theme.fg("scrollbarThumb", text) };
        workspace = new Workspace(alt, theme, keybindings, options, leave, ctx.ui.getToolsExpanded(), scrollbar, settings);
        workspace.start();
        process.on("exit", exited);
        process.on("uncaughtExceptionMonitor", exited);
        alt.renderNow();
      } catch (error) {
        // Pi must not stay stopped: drop what started, then leave gives the terminal back to Pi, settles and reports this error first, once.
        const started = workspace;
        workspace = undefined;
        //NOTE: a dispose or stop that throws here replaces this error and skips leave.
        if (started) started.dispose(); else alt?.stop({ preserveScreen: true });
        leave(error);
      }
    });
    return { render: (width) => [truncateToWidth("opening agents…", Math.max(1, width), "…")], invalidate() {} };
  }, { overlay: true });
};
