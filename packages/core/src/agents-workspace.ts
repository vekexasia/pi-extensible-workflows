import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import { HStack, isKeyRelease, matchesKey, ScrollView, Text, truncateToWidth, TuiAltScreen, VStack, wrapTextWithAnsi, type Component, type Keybinding, type TuiInputListenerResult, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { AgentsWorkspaceOptions, OpenAgentsWorkspace, SessionAgent, SessionTreeNode, TranscriptView } from "./agents-workspace-contract.js";
import { navigateWorkflowPhaseTree, workflowPhaseTreeVisibleNodes, type WorkflowPhaseTree, type WorkflowPhaseTreeDirection, type WorkflowPhaseTreeNode } from "./host-phases.js";
import { progressStyleForState, themeWorkflowProgressStyles, type WorkflowProgressStyles } from "./host-view.js";
import type { TranscriptPoll, TranscriptSource, TranscriptSourceStatus } from "./transcript-source.js";
import { errorText, sanitizeDisplayText } from "./utils.js";

const SEPARATOR = " │ ";
/** Below this width the sidebar starts hidden; s still shows it. */
const SIDEBAR_MIN_COLUMNS = 80;
/** Title and hint: one row each above and below the body. */
const FIXED_ROWS = 2;

/** As the dashboards: 38% of the width less the separator, 24 to 42 columns, then the separator. */
function sidebarWidth(columns: number): number { return Math.min(42, Math.max(24, Math.floor((columns - SEPARATOR.length) * 0.38))) + SEPARATOR.length; }
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

/** The transcript's primary scroll view: reports each layout, and keeps the lines in view when an earlier chunk is placed above them. */
class TranscriptScroll extends ScrollView {
  private kept = 0;
  constructor(content: Component, private readonly laidOut: () => void) { super(content, { follow: "end", primary: true, scrollbar: "auto" }); }
  /** Rows added above the lines in view; applied at the next layout, once the content height counts them. */
  keep(rows: number): void { this.kept += rows; }
  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    const rows = this.kept;
    this.kept = 0;
    if (rows !== 0 && !this.isFollowingEnd) this.scrollTo(this.scrollTop + rows, { disableFollow: true });
    this.laidOut();
  }
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
  loadingEarlier: boolean;
  /** Set by a rejected loadEarlier: no retry on every frame; cleared by a reset or when the user scrolls away from the top. */
  earlierFailed: boolean;
  loadingRecord: boolean;
  status: TranscriptSourceStatus | undefined;
  reason: string | undefined;
  failure: string | undefined;
  atStart: boolean;
}

class Workspace {
  /** The sidebar tree in sidebar order, by key, and as the /workflow tree the navigation runs on. */
  private nodes: readonly SessionTreeNode[] = [];
  private byKey: ReadonlyMap<string, SessionTreeNode> = new Map();
  private tree: WorkflowPhaseTree = navigationTree([]);
  private selectedKey: string | undefined;
  /**
   * The expansion of every key a list contained: its initiallyExpanded the first time a list contains it, so a later list never
   * changes it (a run that finishes while shown does not collapse); then left/right, space, an icon click, and [, ] and the initial
   * key for the ancestors of the agent they selected.
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
  private expanded = false;
  private sidebarTop = 0;
  /** The node key of each sidebar row of the last frame, for clicks; undefined for a rule. */
  private sidebarKeys: (string | undefined)[] = [];
  private finished = false;
  private readonly styles: WorkflowProgressStyles;
  /** The refresh and poll ticks; started once the first list settled. */
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly title = row(() => this.titleText());
  private readonly hint = row(() => this.styles.dim(this.hintText()));
  private readonly status = row(() => this.statusText());
  private readonly sidebar: Component = { render: (width) => this.renderSidebar(width), handleMouse: (event) => this.sidebarMouse(event), invalidate() {} };
  private readonly placeholder = new TranscriptScroll(row(() => this.listed ? "no agents in this Pi session" : "loading agents…"), () => undefined);
  /** The selected node's details, read at every frame, wrapped to the width. */
  private readonly details: Component = { render: (width) => this.detailsLines(width), invalidate() {} };

  constructor(private readonly alt: TuiAltScreen, theme: Theme, private readonly keybindings: KeybindingsManager, private readonly options: AgentsWorkspaceOptions, private readonly leave: () => void) {
    this.styles = themeWorkflowProgressStyles(theme);
    this.initialKey = options.initialKey;
    this.sidebarVisible = alt.terminal.columns >= SIDEBAR_MIN_COLUMNS;
    this.focus = this.sidebarVisible ? "sidebar" : "transcript";
    // Runs after the viewport listener the constructor registered: pgup/pgdn, search and the wheel never reach it.
    alt.addInputListener((data) => this.input(data));
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
    } finally {
      // Last, so its throw skips nothing here; the caller restores Pi after it.
      this.alt.stop({ preserveScreen: true });
    }
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
    if (is("tui.select.cancel")) { this.leave(); return { consume: true }; }
    if (is("tui.input.tab")) { if (this.sidebarVisible) this.focus = this.focus === "sidebar" ? "transcript" : "sidebar"; }
    else if (is("tui.select.up") || is("tui.select.down")) {
      const up = is("tui.select.up");
      if (this.focus === "sidebar") this.navigate(up ? "up" : "down");
      else this.alt.scrollBy(up ? -1 : 1);
    } else if (this.focus === "sidebar" && (is("tui.editor.cursorLeft") || is("tui.editor.cursorRight"))) this.navigate(is("tui.editor.cursorLeft") ? "left" : "right");
    else if (this.focus === "sidebar" && matchesKey(data, "space")) { const node = this.selectedNode(); if (node) this.toggle(node); }
    else if (matchesKey(data, "[") || matchesKey(data, "]")) this.jump(matchesKey(data, "[") ? -1 : 1);
    // The alt screen binds its top/bottom actions to home/end only; ctrl+home/ctrl+end reach the transcript here.
    else if (matchesKey(data, "ctrl+home")) this.alt.scrollToTop();
    else if (matchesKey(data, "ctrl+end")) this.alt.scrollToBottom();
    else if (matchesKey(data, "s")) {
      this.sidebarVisible = !this.sidebarVisible;
      this.focus = this.sidebarVisible ? "sidebar" : "transcript";
      this.rebuild();
    } else if (is("app.tools.expand")) {
      this.expanded = !this.expanded;
      this.shown?.view?.setExpanded(this.expanded);
    } else if (is("tui.select.confirm")) this.loadLarge();
    else return undefined;
    this.alt.requestRender();
    return { consume: true };
  }

  private rebuild(): void {
    const transcript = new VStack([{ component: this.shown?.scroll ?? this.detailsScroll ?? this.placeholder, grow: 1, basis: 0 }, { component: this.status, shrink: 0 }]);
    // The sidebar sizes itself from the terminal width (basis auto); stack entries shrink by default, so fixed parts need shrink 0.
    const body = new HStack(this.sidebarVisible ? [{ component: this.sidebar, shrink: 0 }, { component: transcript, grow: 1, basis: 0 }] : [{ component: transcript, grow: 1, basis: 0 }]);
    this.alt.setLayoutRoot(new VStack([{ component: this.title, shrink: 0 }, { component: body, grow: 1, basis: 0 }, { component: this.hint, shrink: 0 }]));
    // Scroll keys and the wheel act on the primary view of the last frame: draw now, not on the next tick, so none reaches a stale layout.
    this.alt.renderNow();
  }

  private selectedNode(): SessionTreeNode | undefined { return this.selectedKey === undefined ? undefined : this.byKey.get(this.selectedKey); }
  private isExpanded(node: SessionTreeNode): boolean { return this.expansion.get(node.key) ?? node.initiallyExpanded; }
  private expandedKeys(): ReadonlySet<string> { return new Set(this.nodes.filter((node) => this.isExpanded(node)).map(({ key }) => key)); }
  /** The nodes whose ancestors are all expanded, in sidebar order. */
  private visible(): SessionTreeNode[] {
    return workflowPhaseTreeVisibleNodes(this.tree, this.expandedKeys()).flatMap(({ id }) => this.byKey.get(id) ?? []);
  }
  /** Up, down, left and right exactly as in /workflow: navigateWorkflowPhaseTree over the sidebar and its expansion. */
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
  /** [ and ]: the agent before or after the selected node in sidebar order, hidden ones included, round at both ends; its ancestors are expanded. */
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
    if ((this.tree.byId.get(node.key)?.children.length ?? 0) > 0) this.expansion.set(node.key, !this.isExpanded(node));
  }

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
      this.failure = `agents unavailable: ${errorText(error)}`;
      this.alt.requestRender();
      this.startTicks();
    });
  }
  /** Refresh and poll every pollIntervalMs from the first settled list on; called again by later lists, it keeps the running interval. */
  private startTicks(): void {
    if (this.timer || this.finished) return;
    this.timer = setInterval(() => { this.refresh(); if (this.shown) this.poll(this.shown); }, this.options.pollIntervalMs ?? 1000);
    this.timer.unref();
  }
  /**
   * A new list keeps the selection and the expansion by key; a removed node gives the selection to the node now at its row.
   * A key listed for the first time takes its initiallyExpanded. Until a node is selected, the initial key or else the first
   * agent node is selected, with its ancestors expanded.
   */
  private apply(nodes: readonly SessionTreeNode[]): void {
    const row = this.visible().findIndex((node) => node.key === this.selectedKey);
    this.listed = true;
    this.nodes = nodes;
    this.byKey = new Map(nodes.map((node) => [node.key, node]));
    this.tree = navigationTree(nodes);
    for (const node of nodes) if (!this.expansion.has(node.key)) this.expansion.set(node.key, node.initiallyExpanded);
    let wanted = this.selectedNode();
    if (!wanted && this.selectedKey !== undefined) {
      const visible = this.visible();
      wanted = visible[Math.min(Math.max(0, row), visible.length - 1)];
    } else if (!wanted) {
      wanted = (this.initialKey === undefined ? undefined : this.byKey.get(this.initialKey)) ?? nodes.find((node) => node.agent !== undefined);
      if (wanted) this.reveal(wanted);
    }
    //NOTE: a refresh that moves the selected node under a node the user collapsed leaves it selected but hidden.
    const shown = this.shown;
    const agent = wanted?.agent;
    if (shown && agent && wanted?.key === this.selectedKey && identity(agent) === shown.identity) {
      // A live session registered after the agent was opened, or another one, needs its own subscription.
      if (agent.live !== shown.agent.live) {
        shown.unsubscribe?.();
        shown.unsubscribe = shown.view ? this.subscribe(agent, shown.view) : undefined;
      }
      shown.agent = agent;
      if (agent.running) shown.polling = true;
    } else if (wanted?.key !== this.selectedKey || shown || agent) this.select(wanted);
    this.alt.requestRender();
  }

  /** An agent opens its transcript; any other node shows its details and opens nothing. */
  private select(node: SessionTreeNode | undefined): void {
    const previous = this.shown;
    this.shown = undefined;
    if (previous) this.close(previous);
    this.selectedKey = node?.key;
    if (node) this.initialKey = undefined;
    this.detailsScroll = node && !node.agent ? new ScrollView(this.details, { primary: true, scrollbar: "auto" }) : undefined;
    if (node?.agent) this.shown = this.open(node.agent);
    this.rebuild();
  }
  private open(agent: SessionAgent): Shown {
    const base = { agent, identity: identity(agent), queue: Promise.resolve(), polling: true, pollInFlight: false, loadingEarlier: false, earlierFailed: false, loadingRecord: false, status: undefined, reason: undefined, failure: undefined, atStart: false };
    // The session file of an agent that is not owned is never opened.
    if (!agent.owned) return { ...base, source: undefined, view: undefined, unsubscribe: undefined, scroll: new TranscriptScroll(new Text("transcript unavailable", 0, 0), () => undefined) };
    let source: TranscriptSource | undefined;
    let view: TranscriptView | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      source = this.options.openSource(agent);
      view = this.options.createView({ ui: this.alt, cwd: agent.cwd });
      view.setExpanded(this.expanded);
      unsubscribe = this.subscribe(agent, view);
      const shown: Shown = { ...base, source, view, unsubscribe, scroll: new TranscriptScroll(view.component, () => { this.laidOut(); }) };
      this.poll(shown);
      return shown;
    } catch (error) {
      // What opened before the throw is closed; the agent stays selected with the error as its status line until another attempt or selection.
      this.close({ source, view, unsubscribe, queue: base.queue });
      return { ...base, source: undefined, view: undefined, unsubscribe: undefined, scroll: new TranscriptScroll(row(() => ""), () => undefined), failure: `transcript unavailable: ${errorText(error)}` };
    }
  }
  /** Forwards the message being generated to the view while it is the one shown. */
  private subscribe(agent: SessionAgent, view: TranscriptView): (() => void) | undefined {
    // The listener runs in the agent session's event emitter: a throw from the view must stay here.
    return agent.live?.subscribe((event) => {
      if (this.shown?.view === view) this.guard(() => { view.live(event); this.alt.requestRender(); });
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
    this.alt.requestRender();
  }
  private poll(shown: Shown): void {
    const { source, view } = shown;
    if (!source || !view || !shown.polling || shown.pollInFlight) return;
    shown.pollInFlight = true;
    let last = false;
    void this.call(shown, () => { last = !shown.agent.running; return source.poll(); }).then((result) => {
      shown.pollInFlight = false;
      if (last) shown.polling = false;
      if (this.shown === shown) this.guard(() => { this.applyPoll(shown, view, result); });
    }, (error: unknown) => {
      shown.pollInFlight = false;
      if (last) shown.polling = false;
      this.failed(shown, error);
    });
  }
  /** The source's state is taken first: a view that throws leaves its error as the status line, and the next poll goes on from the source. */
  private applyPoll(shown: Shown, view: TranscriptView, result: TranscriptPoll): void {
    shown.status = result.status;
    shown.reason = result.reason;
    shown.atStart = result.atStart;
    shown.failure = undefined;
    if (result.reset) {
      shown.earlierFailed = false;
      view.reset();
      shown.scroll.scrollToEnd();
    }
    if (result.appended.length > 0) view.append(result.appended);
    this.alt.requestRender();
  }
  /** At the top of the transcript, the chunk before the earliest record is loaded once and placed above it; after a failed load, again only once the user left the top and came back. */
  private laidOut(): void {
    const shown = this.shown;
    const { source, view } = shown ?? {};
    if (!shown || !source || !view) return;
    if (shown.scroll.scrollTop !== 0) { shown.earlierFailed = false; return; }
    if (shown.loadingEarlier || shown.earlierFailed || shown.atStart || shown.status !== "available") return;
    shown.loadingEarlier = true;
    void this.call(shown, () => source.loadEarlier()).then((result) => {
      shown.loadingEarlier = false;
      if (this.shown !== shown) return;
      shown.atStart = result.atStart;
      // A chunk the view could not take is not loaded again on every frame either.
      shown.earlierFailed = !this.guard(() => {
        if (result.records.length > 0) {
          const width = this.transcriptWidth();
          const before = view.component.render(width).length;
          view.prepend(result.records);
          shown.scroll.keep(view.component.render(width).length - before);
        }
        this.alt.requestRender();
      });
    }, (error: unknown) => {
      shown.loadingEarlier = false;
      shown.earlierFailed = true;
      this.failed(shown, error);
    });
  }
  private loadLarge(): void {
    const shown = this.shown;
    const { source, view } = shown ?? {};
    const record = view?.pendingLarge().at(-1);
    if (!shown || !source || !view || !record || shown.loadingRecord) return;
    shown.loadingRecord = true;
    void this.call(shown, () => source.loadRecord(record)).then((full) => {
      shown.loadingRecord = false;
      if (this.shown === shown) this.guard(() => { view.replace(full); this.alt.requestRender(); });
    }, (error: unknown) => {
      shown.loadingRecord = false;
      this.failed(shown, error);
    });
  }

  /** The width the layout gives the transcript: the terminal less the sidebar (scrollbar "auto" takes no column). */
  private transcriptWidth(): number {
    const columns = Math.max(1, this.alt.terminal.columns);
    //NOTE: a sidebar wider than the terminal leaves the transcript no column; the measure then uses one.
    return this.sidebarVisible ? Math.max(1, columns - sidebarWidth(columns)) : columns;
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
    const key = (keybinding: Keybinding, fallback: string): string => this.keybindings.getKeys(keybinding)[0] ?? fallback;
    const pending = (this.shown?.view?.pendingLarge().length ?? 0) > 0;
    return [
      ...(this.focus === "sidebar" ? ["←→/space fold · [ ] agent"] : ["↑↓ scroll", "[ ] agent"]),
      ...(this.sidebarVisible ? [`${key("tui.input.tab", "tab")} ${this.focus === "sidebar" ? "transcript" : "agents"}`] : []),
      ...(pending ? [`${key("tui.select.confirm", "enter")} load`] : []),
      "pgup/pgdn",
      `${key("tui.altScreen.search", "ctrl+shift+f")} search`,
      "s sidebar",
      `${key("app.tools.expand", "ctrl+o")} tools`,
      "esc back",
    ].join(" · ");
  }
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
   * The visible nodes as their rows, as wide as sidebarWidth of the terminal, scrolled to keep the selection in view; a dim rule
   * above every top-level node but the first row shows where one run (or the group) ends and the next begins.
   */
  private renderSidebar(width: number): string[] {
    const total = Math.min(Math.max(1, width), sidebarWidth(Math.max(1, this.alt.terminal.columns)));
    const cell = Math.max(0, total - SEPARATOR.length);
    const height = Math.max(1, this.alt.terminal.rows - FIXED_ROWS);
    // A rule is a row without a node: nothing selects it, and the scroll counts it.
    const rows = this.visible().flatMap((node, index): { readonly node: SessionTreeNode | undefined }[] => index > 0 && node.parentKey === undefined ? [{ node: undefined }, { node }] : [{ node }]);
    const selectedRow = rows.findIndex(({ node }) => node !== undefined && node.key === this.selectedKey);
    if (selectedRow >= 0 && selectedRow < this.sidebarTop) this.sidebarTop = selectedRow;
    else if (selectedRow >= this.sidebarTop + height) this.sidebarTop = selectedRow - height + 1;
    this.sidebarTop = Math.max(0, Math.min(this.sidebarTop, rows.length - height));
    const visible = rows.slice(this.sidebarTop, this.sidebarTop + height);
    this.sidebarKeys = visible.map(({ node }) => node?.key);
    return Array.from({ length: height }, (_, index) => {
      const shown = visible[index];
      const node = shown?.node;
      const text = node ? node.line(this.styles, node.key === this.selectedKey, this.isExpanded(node)) : shown ? this.styles.dim("─".repeat(cell)) : "";
      return truncateToWidth(`${truncateToWidth(text, cell, "…", true)}${this.styles.dim(SEPARATOR)}`, total, "", true);
    });
  }
  /** A click on a row selects its node, and on its ▾/▸ icon also toggles it; a click on a rule does nothing; the wheel is left to the transcript. */
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

export const openAgentsWorkspace: OpenAgentsWorkspace = async (ctx, options) => {
  await ctx.ui.custom<undefined>((parent, theme, keybindings, done) => {
    const signal = ctx.signal;
    let workspace: Workspace | undefined;
    /** Set before parent.stop(): from then on leaving restarts Pi, exactly once. */
    let stopped = false;
    let left = false;
    const leave = (): void => {
      if (left) return;
      left = true;
      signal?.removeEventListener("abort", leave);
      // Each step runs even when one before it throws (a terminal that cannot stop: setRawMode on a closed TTY), and nothing
      // escapes to the key or abort listener: Pi is started again, the command settles, and the first error is reported once.
      let failure: string | undefined;
      const step = (run: () => void): void => { try { run(); } catch (error) { failure ??= errorText(error); } };
      step(() => { workspace?.dispose(); });
      if (stopped) step(() => { parent.start(); parent.renderNow(false); });
      done(undefined);
      if (failure !== undefined) ctx.ui.notify(`agents workspace failed: ${failure}`, "error");
    };
    signal?.addEventListener("abort", leave, { once: true });
    queueMicrotask(() => {
      if (left) return;
      if (signal?.aborted) { leave(); return; }
      let alt: TuiAltScreen | undefined;
      try {
        stopped = true;
        parent.stop({ preserveScreen: true });
        alt = new TuiAltScreen(parent.terminal, parent.getShowHardwareCursor(), undefined, { mouse: true, copyOnSelect: true, scrollToEndIndicator: () => " ↓ latest " });
        workspace = new Workspace(alt, theme, keybindings, options, leave);
        alt.start();
        alt.renderNow();
      } catch (error) {
        // Pi must not stay stopped: drop what started, then leave gives the terminal back to Pi and settles.
        const started = workspace;
        workspace = undefined;
        try { if (started) started.dispose(); else alt?.stop({ preserveScreen: true }); } catch { /* the terminal goes back to Pi in leave */ }
        leave();
        ctx.ui.notify(`agents workspace failed: ${errorText(error)}`, "error");
      }
    });
    return { render: (width) => [truncateToWidth("opening agents…", Math.max(1, width), "…")], invalidate() {} };
  }, { overlay: true });
};
