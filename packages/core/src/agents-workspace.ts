import { copyToClipboard, type ExtensionCommandContext, getAgentDir, getSelectListTheme, rawKeyHint, SettingsManager, type KeybindingsManager, type Theme } from "@earendil-works/pi-coding-agent";
import { getKeybindings, HStack, Input, isKeyRelease, matchesKey, parseKey, ScrollView, SelectList, Text, TUI_KEYBINDINGS, truncateToWidth, TuiAltScreen, visibleWidth, VStack, wrapTextWithAnsi, type Component, type Keybinding, type OverlayHandle, type OverlayOptions, type ScrollViewOptions, type SelectItem, type TuiInputListenerResult, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import type { ActionUi, AgentsAction, AgentsActionProvider, AgentsActionTarget } from "./agents-actions-contract.js";
import { formatCost, formatTokens } from "./background-widget.js";
import { speedTps } from "./agent-speed.js";
import { workflowKeyMatches } from "./pi-action-ui.js";
import { navigateWorkflowPhaseTree, workflowPhaseTreeVisibleNodes, type WorkflowPhaseTree, type WorkflowPhaseTreeDirection, type WorkflowPhaseTreeNode } from "./host-phases.js";
import { navigatorSidebarWidth, progressStyleForState, themeWorkflowProgressStyles, type WorkflowProgressStyles } from "./host-view.js";
import type { SessionAgent, SessionAgentsSource, SessionTreeNode } from "./session-agents.js";
import type { CreateTranscriptView, TranscriptView } from "./transcript-components.js";
import type { TranscriptPoll, TranscriptSource, TranscriptSourceStatus } from "./session-transcript.js";
import { errorText, sanitizeDisplayText } from "./utils.js";
import { openArtifactInEditor, type WorkflowTui } from "./workflow-artifacts.js";

export interface AgentsWorkspaceOptions {
  readonly agents: SessionAgentsSource;
  /** Opens the reader for an owned agent (openSessionTranscript); not called for an agent that is not owned. */
  readonly openSource: (agent: SessionAgent) => TranscriptSource;
  readonly createView: CreateTranscriptView;
  /** Node selected when the workspace opens, its ancestors expanded; wins over state.selectedKey. The first agent node in sidebar order otherwise, or the first node when there is no agent. */
  readonly initialKey?: string;
  /** Calls `listener` when something may have started to run; returns what stops the calls. While nothing runs a call lists at once, not at the slow tick. */
  readonly changes?: (listener: () => void) => () => void;
  /**
   * What a detached registered action reports while the workspace is open: its working message (undefined: none), given now and
   * at every change, stays in the status row whatever the keys until it is empty; its notices (a failure) show as an action's do.
   * Returns what stops the calls.
   */
  readonly detached?: (sink: DetachedSink) => () => void;
  readonly pollIntervalMs?: number;
  /** Aborted by the session_shutdown of the extension that opened the workspace, with its event as the reason: the workspace closes at once, Pi's screen restored; Pi's TUI stays stopped on a quit, as Pi's shutdown stops it. */
  readonly shutdown?: AbortSignal;
  /** The menu of a node with a target asks every provider; without providers there is no menu and `a` does nothing. */
  readonly actions?: readonly AgentsActionProvider[];
  /** A workspace that stepped aside for an action opens again as it was. */
  readonly state?: AgentsWorkspaceState;
  /** Shown in the status row when the workspace opens (the notices of the action it stepped aside for), until the next key. */
  readonly notices?: readonly string[];
  /** The external editor command (SettingsManager getExternalEditorCommand) for the in-place editor actions; undefined when none is configured. */
  readonly editorCommand?: () => string | undefined;
}

export interface DetachedSink {
  working(message: string | undefined): void;
  notice(message: string, level?: "info" | "warning" | "error"): void;
}

/** What the workspace keeps when it steps aside for an action. */
export interface AgentsWorkspaceState {
  readonly selectedKey: string | undefined;
  /** The selection's row among the visible nodes: a selected key that went away gives the selection to the node now at this row. */
  readonly row: number;
  /** Every expansion the workspace has recorded, by key. */
  readonly expansion: readonly (readonly [string, boolean])[];
  readonly focus: "sidebar" | "transcript";
  readonly sidebarVisible: boolean;
  /** Tool output expanded (ctrl+o). */
  readonly toolsExpanded: boolean;
  /** `d`: an agent's details shown instead of its transcript. */
  readonly detailsShown: boolean;
  /** `f`: follow mode, the selection moving to the agent with the newest activity. */
  readonly following?: boolean;
  /** `/`: the sidebar filter text, when one is set. */
  readonly filter?: string;
  /** Where the shown transcript was scrolled to, when it was not at its tail: the agent's identity and the rows below the lines in view. */
  readonly transcript?: TranscriptPlace;
}

/** Where a transcript was scrolled to when the workspace stepped aside. */
export interface TranscriptPlace { readonly identity: string; readonly fromEnd: number }

/** The workspace left for an action that needs Pi's dialogs: the caller runs it with `provider` and Pi's UI and opens the workspace again with `state`. */
export interface AgentsWorkspaceExit {
  readonly target: AgentsActionTarget;
  readonly label: string;
  /** The provider that offered the label in the menu. */
  readonly provider: AgentsActionProvider;
  readonly state: AgentsWorkspaceState;
}

const SEPARATOR = " │ ";
/** Below this width the sidebar does not fit beside the transcript: it goes above it on a portrait terminal, else it hides; s still shows it. */
const SIDEBAR_MIN_COLUMNS = 80;
/** The tick while no agent runs and the shown transcript is read to its end; it shows what no change reports (another Pi's subagents, a shell's progress). */
const IDLE_POLL_MS = 5000;
/** Title and hint: one row each above and below the body. */
const FIXED_ROWS = 2;
/** The sidebar filter's input row, under the title while it is open. */
const FILTER_ROWS = 1;
/** The action menu: half the width, 32 columns at least, centred a row and a column clear of the edges, so it never covers the title or the hint. */
const MENU_OVERLAY: OverlayOptions = { width: "50%", minWidth: 32, margin: 1 };
const MENU_TITLES: Readonly<Record<AgentsActionTarget["kind"], string>> = { run: "Run actions", "workflow-agent": "Agent actions", subagent: "Subagent actions", subagents: "Subagents" };

/** As the dashboards: 38% of the width less the separator, 24 to 42 columns, then the separator. */
function sidebarWidth(columns: number): number { return navigatorSidebarWidth(columns) + SEPARATOR.length; }
/** Where the sidebar fits: beside the transcript, above it on a portrait terminal (more rows than half the columns, a cell being about twice as tall as wide), or nowhere. */
function sidebarFit({ columns, rows }: { readonly columns: number; readonly rows: number }): "side" | "top" | undefined { return columns >= SIDEBAR_MIN_COLUMNS ? "side" : rows * 2 > columns ? "top" : undefined; }
function clean(text: string | undefined): string { return sanitizeDisplayText(text ?? "").replace(/\s+/g, " ").trim(); }
/** The foreground or intensity resets that end a dim. */
// eslint-disable-next-line no-control-regex
const DIM_ENDS = /\x1b\[(?:22;)?39m|\x1b\[22m/g;
/** An SGR mouse report: its 1-based column and row, M for a press or a motion, m for a release. */
// eslint-disable-next-line no-control-regex
const SGR_MOUSE = /^\x1b\[<\d+;(\d+);(\d+)([Mm])$/;
/** A whole bracketed paste and its body, as Pi's terminal hands one over. */
// eslint-disable-next-line no-control-regex
const BRACKETED_PASTE = /^\x1b\[200~([\s\S]*)\x1b\[201~$/;
/** A mouse report as the alt screen reads one: SGR, or the legacy six bytes. */
function isMouse(data: string): boolean { return SGR_MOUSE.test(data) || (data.length === 6 && data.startsWith("\x1b[M")); }
/** What a filter keeps: `direct` matches, `shown` adds their ancestors. */
interface MatchSets { readonly direct: ReadonlySet<string>; readonly shown: ReadonlySet<string> }
/** The alt screen's own scroll and search actions: it acts on them before any input listener. */
const ALT_SCREEN_ACTIONS = (Object.keys(TUI_KEYBINDINGS) as (keyof typeof TUI_KEYBINDINGS)[]).filter((id) => id.startsWith("tui.altScreen."));
/**
 * A keypress: what parseKey names, what the alt screen takes for one of its actions (with the keybindings it reads, so also the
 * legacy home and end \x1b[1~ and \x1b[4~ of tmux and screen), text without a control character (é), or a bracketed paste. What
 * else the terminal sends, a focus report or a query's answer, is not one.
 */
function isKey(data: string): boolean {
  if (parseKey(data) !== undefined || data.startsWith("\x1b[200~")) return true;
  const keybindings = getKeybindings();
  return ALT_SCREEN_ACTIONS.some((id) => keybindings.matches(data, id)) || isText(data);
}
function isText(data: string): boolean {
  if (data.length === 0) return false;
  for (const char of data) if (char < " " || char === "\x7f") return false;
  return true;
}
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

/** The transcript's primary scroll view: reports each layout, and restores the place a reopened workspace left. */
class TranscriptScroll extends ScrollView {
  private laidContent = 0;
  private pendingFromEnd: number | undefined;
  private restoredAt: string | undefined;
  private laidTop: number | undefined;
  private atStart = false;
  constructor(content: Component, scrollbar: Scrollbar) { super(content, { follow: "end", primary: true, ...scrollbar }); }
  /** How many rows lie below the lines in view; 0 at the tail. */
  get fromEnd(): number { return this.isFollowingEnd ? 0 : Math.max(0, this.laidContent - this.viewportHeight - this.scrollTop); }
  /** Scrolls to `rows` above the tail once the content reaches that far (the transcript loads after it opens). */
  restoreFromEnd(rows: number): void { if (rows > 0) { this.pendingFromEnd = rows; this.restoredAt = undefined; this.laidTop = undefined; } }
  /** All the content is read: a saved place beyond the laid-out content is dropped, the view stays clamped at the top. */
  giveUpRestore(): void {
    this.atStart = true;
    if (this.laidContent > 0) this.pendingFromEnd = undefined;
  }
  /** The content was replaced: a saved place no longer applies. */
  cancelRestore(): void { this.pendingFromEnd = undefined; this.restoredAt = undefined; this.laidTop = undefined; }
  override updateLayout(contentHeight: number, viewportHeight: number, requestRender: () => void): void {
    // A view that is not where the last layout left it was scrolled by the user: the saved place no longer applies.
    if (this.pendingFromEnd !== undefined && this.laidTop !== undefined && this.scrollTop !== this.laidTop) this.cancelRestore();
    super.updateLayout(contentHeight, viewportHeight, requestRender);
    this.laidContent = contentHeight;
    // A place beyond the content is applied once per content height: with nothing new to show, later layouts leave the user's scrolling alone.
    if (this.pendingFromEnd !== undefined && contentHeight > 0 && `${String(contentHeight)}x${String(viewportHeight)}` !== this.restoredAt) {
      const target = contentHeight - viewportHeight - this.pendingFromEnd;
      this.restoredAt = `${String(contentHeight)}x${String(viewportHeight)}`;
      this.scrollTo(Math.max(0, target), { disableFollow: true });
      if (target >= 0 || this.atStart) this.pendingFromEnd = undefined;
    }
    this.laidTop = this.scrollTop;
  }
}

/** A label of the menu with the provider that offered it. */
interface MenuEntry { readonly action: AgentsAction; readonly provider: AgentsActionProvider }
/** The action menu open on the node `key`, drawn as an overlay of the alternate screen. */
interface Menu {
  readonly key: string;
  /** The node's target, taken again from every list. */
  target: AgentsActionTarget;
  /** The target and the node's title (its state) the labels were read for: a list that changes neither reads nothing. */
  readFor: string;
  readonly handle: OverlayHandle;
  /** The labels the last read got, in provider order; undefined until the first answer. */
  entries: readonly MenuEntry[] | undefined;
  /** Pi's select list of the entries, its item values their indexes; undefined while there are none. */
  list: SelectList | undefined;
  /** The selected label: also kept while a read lacks it because a provider could not be read. */
  label: string | undefined;
  /** Counts the reads of the labels: only the latest one's answer is taken. */
  generation: number;
  /** The last read's errors, a line for every provider whose labels it could not read, shown under the labels it read; undefined without any. */
  failures: Text | undefined;
}
interface Notice { readonly text: string; readonly level: "info" | "warning" | "error" | undefined }

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
  /** options.state until a node was selected: its selection is taken after the initial key's. */
  private restore: AgentsWorkspaceState | undefined;
  /** Where the transcript was scrolled when the workspace stepped aside; taken by the next transcript opened. */
  private place: TranscriptPlace | undefined;
  private listing = false;
  /** A failed list, or a throw while no transcript is shown; in the title until the next list succeeds. */
  private failure: string | undefined;
  /** The transcript of the selected node when it is an agent. */
  private shown: Shown | undefined;
  /** The right pane of the selected node when it is not an agent, or an agent's on d; a new one for each selection. */
  private detailsScroll: ScrollView | undefined;
  private focus: "sidebar" | "transcript";
  private sidebarVisible: boolean;
  /** Where the sidebar fits (sidebarFit), as the last resize left the terminal. */
  private fit: "side" | "top" | undefined;
  /** s hid the sidebar while it fitted: a resize does not bring it back. */
  private sidebarHidden: boolean;
  private expanded: boolean;
  /** d: an agent with details shows them instead of its transcript, for every agent selected until d again. */
  private detailsShown: boolean;
  /** f: the selection stays on the followed agent while it runs, then moves to the running agent with the newest activity. */
  private following: boolean;
  /** Follow mode as the menu opened: opening a menu stops it, but a step-aside action hands it back through the state. */
  private followingBeforeMenu = false;
  /** The sidebar filter: the display text of what was typed into `filterInput`, the input row under the title while `filtering`. */
  private filter: string;
  private filtering = false;
  private readonly filterInput = new Input({ prompt: "/ " });
  private matchCache: { readonly nodes: readonly SessionTreeNode[]; readonly filter: string; readonly result: MatchSets } | undefined;
  private menu: Menu | undefined;
  /** The status row's notices (options.notices, an in-place action's), until the next key. */
  private notices: Notice[];
  /** An in-place action runs: every key but ctrl+c is dropped and the ticks wait. */
  private busy = false;
  /** The in-place editor stopped the alternate screen and has the terminal. */
  private editing = false;
  /** An abort arrived while the editor runs: the workspace is left when the editor exits, not before. */
  private leaveAfterEditor = false;
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
  /** The working message of a detached action, kept by options.detached; unlike the notices a key does not end it. */
  private working: string | undefined;
  private readonly unsubscribeWorking: (() => void) | undefined;
  /** An agent's first read is in flight: no other agent's starts until it settles, then only the agent shown then is read. */
  private firstReading = false;
  private readonly title: Component = { render: (width) => [this.titleRow(Math.max(1, width))], invalidate() {} };
  /** A click on the open input row places its cursor; the keys reach it through filterKey(). */
  private readonly filterRow: Component = { render: (width) => this.filtering ? this.filterInput.render(Math.max(1, width)) : [], handleMouse: (event) => this.filtering && this.filterInput.handleMouse(event) ? { handled: true } : undefined, invalidate() {} };
  private readonly hint = row(() => this.hintText());
  private readonly status = row(() => this.statusText());
  private readonly sidebar: Component = { render: (width) => this.renderSidebar(width), handleMouse: (event) => this.sidebarMouse(event), invalidate() {} };
  private readonly placeholder: TranscriptScroll;
  /** The selected node's details, read at every frame, wrapped to the width. */
  private readonly details: Component = { render: (width) => this.detailsLines(width), invalidate() {} };

  constructor(private readonly alt: TuiAltScreen, theme: Theme, private readonly keybindings: KeybindingsManager, private readonly options: AgentsWorkspaceOptions, private readonly leave: (exit?: AgentsWorkspaceExit, cause?: unknown) => void, toolsExpanded: boolean, private readonly scrollbar: Scrollbar, private readonly settings: SettingsManager) {
    this.styles = themeWorkflowProgressStyles(theme);
    this.placeholder = new TranscriptScroll(row(() => this.listed ? "no agents in this Pi session" : "loading agents…"), scrollbar);
    this.initialKey = options.initialKey;
    // A workspace that stepped aside for an action opens as it was; the sidebar still starts hidden where it does not fit.
    const state = options.state;
    this.restore = state;
    this.place = state?.transcript;
    for (const [key, expanded] of state?.expansion ?? []) this.expansion.set(key, expanded);
    this.fit = sidebarFit(alt.terminal);
    // A state's sidebar is the one the user wants (state()): hidden only when s hid it while it could show.
    this.sidebarHidden = state?.sidebarVisible === false;
    this.sidebarVisible = this.fit !== undefined && !this.sidebarHidden;
    this.focus = this.sidebarVisible ? state?.focus ?? "sidebar" : "transcript";
    this.expanded = state?.toolsExpanded ?? toolsExpanded;
    this.detailsShown = state?.detailsShown ?? false;
    this.following = state?.following ?? false;
    this.filter = state?.filter ?? "";
    // Input has no cursor setter: the restored filter goes in as a paste, which leaves the cursor after it.
    if (this.filter) this.filterInput.handleInput(`\x1b[200~${this.filter}\x1b[201~`);
    this.filterInput.onSubmit = () => { this.closeFilter(this.filter.trim()); };
    this.filterInput.onEscape = () => { this.closeFilter(""); };
    this.notices = (options.notices ?? []).map((text) => ({ text: clean(text), level: undefined }));
    // Runs after the alt screen's viewport listener (pgup/pgdn, search, the wheel): the terminal openAgentsWorkspace gives the alt screen puts gate() before both.
    alt.addInputListener((data) => this.input(data));
    this.unsubscribe = options.changes?.(() => { this.wake(); });
    this.unsubscribeWorking = options.detached?.({ working: (message) => { this.working = message === undefined ? undefined : clean(message); if (!this.finished) this.alt.requestRender(); }, notice: (message, level) => { this.notify(message, level); } });
    this.rebuild();
    this.refresh();
  }

  /** Leaves now, or once the editor exits when it has the terminal. */
  abort(): void {
    if (this.editing) this.leaveAfterEditor = true;
    else this.leave();
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
      this.unsubscribeWorking?.();
    } finally {
      // Last, so its throw skips nothing here; the caller restores Pi after it. Stopped already while the in-place editor runs.
      if (!this.editing) this.alt.stop({ preserveScreen: true });
    }
  }

  start(): void { this.alt.start(); }
  /**
   * The terminal's input before the alt screen sees it. While an in-place action runs the mouse goes nowhere; while the menu is
   * open only a report on it (and a release, which ends a press) reaches it. While either holds every key (isKey: a paste too) goes to the
   * workspace alone: ctrl+c leaves, the menu takes the rest, an action drops them. A key also ends the notices (not one dropped
   * while an action runs). Key releases and what is not a key (a focus report, the terminal's answer to a query) reach the alt
   * screen as they came.
   */
  gate(data: string, pass: (data: string) => void): void {
    const held = this.busy || this.menu !== undefined;
    this.lastListedRows = undefined;
    if (isMouse(data)) { if (!this.busy && (!this.menu || this.onMenu(data))) pass(data); return; }
    if (isKeyRelease(data) || !isKey(data)) { pass(data); return; }
    if (!this.busy && this.notices.length > 0) { this.notices = []; this.alt.requestRender(); }
    if (held) this.input(data);
    else pass(data);
  }
  private onMenu(data: string): boolean {
    // Only an SGR report reaches the menu: a legacy six-byte one, which pi-tui reads for the wheel alone, is dropped while it is open.
    const report = SGR_MOUSE.exec(data);
    const bounds = this.menu?.handle.getBounds();
    if (!report || !bounds) return false;
    const [column, row] = [Number(report[1]) - 1, Number(report[2]) - 1];
    return report[3] === "m" || (column >= bounds.col && column < bounds.col + bounds.width && row >= bounds.row && row < bounds.row + bounds.height);
  }
  private input(data: string): TuiInputListenerResult {
    // A throw from a view or a component ends as a status line, not in the alt screen's input dispatch.
    try { return this.key(data); } catch (error) { this.report(error); return { consume: true }; }
  }
  private key(data: string): TuiInputListenerResult {
    if (isKeyRelease(data)) return undefined;
    // The editor owns the terminal: no key is the workspace's meanwhile.
    if (this.editing) return { consume: true };
    // ctrl+c leaves at once, also while the search box or the menu is open or an in-place action runs.
    if (matchesKey(data, "ctrl+c")) { this.leave(); return { consume: true }; }
    if (this.busy) return { consume: true };
    const menu = this.menu;
    if (menu) { this.menuKey(menu, data); this.alt.requestRender(); return { consume: true }; }
    // While an overlay (the search box) is open, every other key is its input.
    if (this.alt.hasOverlay()) return undefined;
    if (this.filtering) { this.filterKey(data); this.alt.requestRender(); return { consume: true }; }
    const is = (keybinding: Keybinding): boolean => this.keybindings.matches(data, keybinding);
    // In the sidebar j, k, h and l move as the arrows do, as in /workflow.
    const sidebar = this.focus === "sidebar";
    const moves = (keybinding: Keybinding): boolean => sidebar ? workflowKeyMatches(this.keybindings, data, keybinding) : is(keybinding);
    if (is("tui.select.cancel")) {
      if (this.filter) this.setFilter("");
      else this.leave();
      this.alt.requestRender();
      return { consume: true };
    }
    if (is("tui.input.tab")) { if (this.sidebarVisible) this.focus = sidebar ? "transcript" : "sidebar"; }
    else if (moves("tui.select.up") || moves("tui.select.down")) {
      const up = moves("tui.select.up");
      if (sidebar) this.navigate(up ? "up" : "down");
      else { this.following = false; this.alt.scrollBy(up ? -1 : 1); }
    } else if (sidebar && (moves("tui.editor.cursorLeft") || moves("tui.editor.cursorRight"))) this.navigate(moves("tui.editor.cursorLeft") ? "left" : "right");
    else if (sidebar && matchesKey(data, "space")) { const node = this.selectedNode(); if (node) this.toggle(node); }
    else if (matchesKey(data, "[") || matchesKey(data, "]")) this.jump(matchesKey(data, "[") ? -1 : 1);
    else if (matchesKey(data, "n") || matchesKey(data, "shift+n")) this.jump(matchesKey(data, "n") ? 1 : -1, (node) => node.needsPerson !== undefined);
    // The alt screen binds its top/bottom actions to home/end only; ctrl+home/ctrl+end reach the transcript here.
    else if (matchesKey(data, "ctrl+home")) { this.following = false; this.alt.scrollToTop(); }
    else if (matchesKey(data, "ctrl+end")) { this.following = false; this.alt.scrollToBottom(); }
    else if (sidebar && matchesKey(data, "/")) this.filtering = this.filterInput.focused = true;
    else if (matchesKey(data, "f")) this.toggleFollow();
    else if (matchesKey(data, "s")) {
      this.sidebarVisible = !this.sidebarVisible;
      this.sidebarHidden = !this.sidebarVisible && this.fit !== undefined;
      this.focus = this.sidebarVisible ? "sidebar" : "transcript";
      this.rebuild();
    } else if (is("app.tools.expand")) {
      this.expanded = !this.expanded;
      this.shown?.view?.setExpanded(this.expanded);
    } else if (matchesKey(data, "a")) { const node = this.selectedNode(); if (node) this.openMenu(node); }
    else if (matchesKey(data, "d")) this.toggleDetails();
    else if (is("tui.select.confirm")) {
      // On a node that is not an agent enter opens the menu.
      const node = this.selectedNode();
      if (sidebar && node && !node.agent) this.openMenu(node);
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
    this.alt.setLayoutRoot(new VStack([{ component: this.title, shrink: 0 }, { component: this.filterRow, shrink: 0 }, { component: body, grow: 1, basis: 0 }, { component: this.hint, shrink: 0 }]));
    // Scroll keys and the wheel act on the primary view of the last frame: draw now, not on the next tick, so none reaches a stale layout.
    this.alt.renderNow();
  }

  private selectedNode(): SessionTreeNode | undefined { return this.selectedKey === undefined ? undefined : this.byKey.get(this.selectedKey); }
  private hasDetails(node: SessionTreeNode): boolean { return node.details(this.styles, Date.now()).length > 0; }
  /** The right pane of the selected node's details, scrolled from the top. */
  private detailsPane(): ScrollView { return new ScrollView(this.details, { primary: true, ...this.scrollbar }); }
  /**
   * What the workspace keeps when it steps aside for an action. The sidebar is the one the user wants: one hidden where it does not fit
   * is kept shown and focused, so that it opens again as a resize brings it back; hidden only when s hid it while it could show.
   */
  private state(): AgentsWorkspaceState {
    const shown = this.shown;
    const fromEnd = shown ? shown.scroll.fromEnd : 0;
    const state: AgentsWorkspaceState = {
      selectedKey: this.selectedKey,
      row: Math.max(0, this.visible().findIndex((node) => node.key === this.selectedKey)),
      expansion: [...this.expansion],
      focus: !this.sidebarVisible && !this.sidebarHidden ? "sidebar" : this.focus,
      sidebarVisible: !this.sidebarHidden,
      toolsExpanded: this.expanded,
      detailsShown: this.detailsShown,
      ...(this.following ? { following: true } : {}),
      ...(this.filter ? { filter: this.filter } : {}),
      ...(shown && fromEnd > 0 ? { transcript: { identity: shown.identity, fromEnd } } : {}),
    };
    return state;
  }
  private rawExpanded(node: SessionTreeNode): boolean { return this.expansion.get(node.key) ?? node.initiallyExpanded; }
  /** A filter shows every match under its ancestors, whatever the user collapsed. */
  private isExpanded(node: SessionTreeNode): boolean { return this.filterActive() || this.rawExpanded(node); }
  private expandedKeys(): ReadonlySet<string> { return new Set(this.nodes.filter((node) => this.isExpanded(node)).map(({ key }) => key)); }
  /** The nodes whose ancestors are all expanded, in sidebar order. */
  private visible(): SessionTreeNode[] {
    return workflowPhaseTreeVisibleNodes(this.navTree(), this.expandedKeys()).flatMap(({ id }) => this.byKey.get(id) ?? []);
  }
  private fixedRows(): number { return FIXED_ROWS + (this.filtering ? FILTER_ROWS : 0); }
  private filterActive(): boolean { return this.filter.trim() !== ""; }
  /**
   * The nodes the filter keeps: `direct` match (the node's label, which on a run root holds the run's name and short ID, or its
   * ID containing the text, case-insensitive, or its state named by a "state:" prefix), `shown` adds their ancestors. Undefined without a filter.
   */
  private matches(): MatchSets | undefined {
    if (!this.filterActive()) return undefined;
    const cached = this.matchCache;
    if (cached && cached.nodes === this.nodes && cached.filter === this.filter) return cached.result;
    const result = this.computeMatches();
    this.matchCache = { nodes: this.nodes, filter: this.filter, result };
    return result;
  }
  private computeMatches(): MatchSets {
    const text = this.filter.trim().replace(/\s+/g, " ").toLowerCase();
    const wantedState = text.startsWith("state:") ? text.slice("state:".length).trim() : undefined;
    const direct = new Set<string>();
    for (const node of this.nodes) {
      const label = clean(node.label);
      // The Subagents group's state summarizes its children and is not matched itself.
      const state = node.state.toLowerCase();
      const id = (node.id ?? "").toLowerCase();
      if (wantedState === undefined ? label.toLowerCase().includes(text) || id.includes(text) : node.kind !== "group" && (node.agent?.leftover === true ? wantedState === "interrupted" || (wantedState !== "running" && state === wantedState) : state === wantedState)) direct.add(node.key);
    }
    const shown = new Set(direct);
    for (const key of direct) {
      const seen = new Set<string>();
      for (let parent = this.byKey.get(key)?.parentKey; parent !== undefined && !seen.has(parent); parent = this.byKey.get(parent)?.parentKey) { seen.add(parent); shown.add(parent); }
    }
    return { direct, shown };
  }
  /** The /workflow tree navigation runs on: the whole sidebar, or only the nodes a filter keeps. */
  private navTree(): WorkflowPhaseTree {
    const shown = this.matches()?.shown;
    return shown === undefined ? this.tree : navigationTree(this.nodes.filter((node) => shown.has(node.key)));
  }
  /** The selection stays when its node still shows, else moves to the first match. No filter empties the input too. */
  private setFilter(text: string): void {
    this.filter = text;
    if (!text) this.filterInput.setValue("");
    this.keepSelectionShown();
  }
  private keepSelectionShown(): void {
    const matches = this.matches();
    if (!matches || !this.nodes.length || (matches.shown.has(this.selectedKey ?? "") && this.selectedNode())) return;
    const first = this.nodes.find((node) => matches.direct.has(node.key));
    if (first) this.select(first);
  }
  private filterKey(data: string): void {
    // Pi's terminal hands over a whole paste: its body goes in as display text, so the input row draws no escape sequence.
    const pasted = BRACKETED_PASTE.exec(data);
    this.filterInput.handleInput(pasted ? `\x1b[200~${sanitizeDisplayText(pasted[1] ?? "")}\x1b[201~` : data);
    // The filter is the input's text with each whitespace a space.
    if (this.filtering) this.setFilter(sanitizeDisplayText(this.filterInput.getValue()).replace(/\s/g, " "));
  }
  private closeFilter(text: string): void {
    this.filtering = this.filterInput.focused = false;
    this.setFilter(text);
  }
  /** f: follow mode on or off; on, the selection moves at once. With no running agent, as the hint offers no f, it stays off. */
  private toggleFollow(): void {
    if (!this.following && !this.nodes.some((node) => node.agent?.running === true)) return;
    this.following = !this.following;
    if (this.following) this.follow();
  }
  /** Moves the selection to the follow target and keeps its transcript at the tail. */
  private follow(): void {
    const target = this.followTarget();
    if (target && target.key !== this.selectedKey) { this.reveal(target); this.select(target); }
    this.shown?.scroll.scrollToEnd();
  }
  /** The running agent with the newest activity; a tie or none keeps the selection. */
  private followTarget(): SessionTreeNode | undefined {
    const shown = this.matches()?.shown;
    const running = this.nodes.filter((node) => node.agent?.running && node.agent.lastActivityAt !== undefined && (shown === undefined || shown.has(node.key)));
    const newest = Math.max(...running.map((node) => node.agent?.lastActivityAt ?? 0));
    const best = running.filter((node) => node.agent?.lastActivityAt === newest);
    return best.length === 1 ? best[0] : undefined;
  }
  /** Under a filter every shown node is open: left goes to the parent, right to the first shown child, and the expansion stays as it is. */
  private navigateShown(direction: "left" | "right"): void {
    this.following = false;
    const key = this.selectedKey;
    const next = key === undefined ? undefined : direction === "left" ? this.byKey.get(key)?.parentKey : this.navTree().byId.get(key)?.children[0];
    const node = next === undefined ? undefined : this.byKey.get(next);
    if (node) this.select(node);
  }
  /** Up, down, left and right as in /workflow: navigateWorkflowPhaseTree over the sidebar and its expansion; under a filter, over the nodes it keeps. */
  private navigate(direction: WorkflowPhaseTreeDirection): void {
    if (this.nodes.length === 0) return;
    if (this.filterActive() && (direction === "left" || direction === "right")) { this.navigateShown(direction); return; }
    const expanded = this.expandedKeys();
    this.following = false;
    const next = navigateWorkflowPhaseTree(this.navTree(), this.selectedKey, expanded, direction);
    for (const node of this.nodes) {
      if (next.expandedNodeIds.has(node.key) !== expanded.has(node.key)) this.expansion.set(node.key, next.expandedNodeIds.has(node.key));
    }
    const node = next.nodeId === undefined ? undefined : this.byKey.get(next.nodeId);
    if (node && node.key !== this.selectedKey) this.select(node);
  }
  /** [ and ]: the agent (n and N: the node that needs a person) before or after the selected node in sidebar order, collapsed ones included and under a filter only the nodes it keeps, round at both ends; its ancestors are expanded. */
  private jump(delta: number, wanted: (node: SessionTreeNode) => boolean = (node) => node.agent !== undefined): void {
    const index = this.nodes.findIndex((node) => node.key === this.selectedKey);
    this.following = false;
    const shown = this.matches()?.shown;
    const others = [...this.nodes.slice(index + 1), ...this.nodes.slice(0, Math.max(0, index))].filter((node) => (shown === undefined || shown.has(node.key)) && wanted(node));
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
    if (this.hasChildren(node) && !this.filterActive()) this.expansion.set(node.key, !this.rawExpanded(node));
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
      // An in-place action holds the screen (the editor stops it): nothing is read until it settles.
      if (this.busy) return;
      this.refresh();
      if (this.shown) this.poll(this.shown);
    }, idle ? IDLE_POLL_MS : this.options.pollIntervalMs ?? 1000);
    this.timer.unref();
  }
  /** options.changes called: while nothing runs the list is read now; while something runs the next tick reads it, while an in-place action runs its end does. */
  private wake(): void {
    //NOTE: a change reported while a list is in flight waits for the next tick.
    if (this.idle && !this.busy) this.refresh();
  }
  /**
   * A new list keeps the selection and the expansion by key; a removed node gives the selection to the node now at its row.
   * A key takes its initiallyExpanded the first time a list gives its node children. Until a node is selected, the initial key
   * (its ancestors expanded), else the state's selection, else the first agent node (its ancestors expanded), else the first node
   * is selected. An open menu reads its labels again when its node's target or state changed, or closes when its node or the target went away.
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
    // A transcript scrolled away from the tail (page keys, home, the wheel) ends follow mode; seen first, so a switch does not lose it.
    if (this.following && this.shown && !this.shown.scroll.isFollowingEnd) this.following = false;
    // Follow stays on its agent while it runs, as a switch reloads the transcript: only a settled or gone one gives way.
    const followed = this.following && this.selectedNode()?.agent?.running !== true ? this.followTarget() : undefined;
    if (followed) this.reveal(followed);
    let wanted = followed ?? this.selectedNode();
    if (!wanted && this.selectedKey !== undefined) {
      const visible = this.visible();
      wanted = visible[Math.min(Math.max(0, row), visible.length - 1)];
    } else if (!wanted) wanted = this.firstSelection(nodes);
    const matches = this.matches();
    if (matches && wanted && !matches.shown.has(wanted.key)) wanted = this.nodes.find((node) => matches.direct.has(node.key)) ?? wanted;
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
      // With d on, the pane follows the agent's details: emptied by a refresh it shows the transcript, back again the details.
      if (this.detailsShown && this.hasDetails(wanted) !== (this.detailsScroll !== undefined)) {
        this.detailsScroll = this.detailsScroll ? undefined : this.detailsPane();
        this.rebuild();
      }
    } else if (wanted?.key !== this.selectedKey || shown || agent) this.select(wanted);
    const menu = this.menu;
    const menuNode = menu && this.byKey.get(menu.key);
    const target = menuNode?.target;
    if (menu && !target) this.closeMenu();
    else if (menu && menuNode && target && this.readFor(menuNode) !== menu.readFor) {
      menu.target = target;
      menu.readFor = this.readFor(menuNode);
      this.loadMenu(menu);
    }
    if (this.following && this.shown) this.shown.scroll.scrollToEnd();
    const rows = this.listedRows();
    if (rows === this.lastListedRows) return;
    this.lastListedRows = rows;
    this.alt.requestRender();
  }
  /** Every row a list can change outside the transcript: the title, the hint, the status row, the sidebar and the details pane. */
  private listedRows(): string {
    const columns = Math.max(1, this.alt.terminal.columns);
    return [this.titleRow(columns), this.hintText(), this.statusText(), ...(this.sidebarVisible ? this.renderSidebar(columns) : []), ...(this.detailsScroll ? this.detailsLines(this.transcriptWidth()) : [])].join("\n");
  }
  private firstSelection(nodes: readonly SessionTreeNode[]): SessionTreeNode | undefined {
    const initial = this.initialKey === undefined ? undefined : this.byKey.get(this.initialKey);
    const restore = this.restore;
    if (!initial && restore) {
      const kept = restore.selectedKey === undefined ? undefined : this.byKey.get(restore.selectedKey);
      const visible = this.visible();
      const near = kept ?? visible[Math.min(Math.max(0, restore.row), visible.length - 1)];
      if (near) return near;
    }
    const wanted = initial ?? nodes.find((node) => node.agent !== undefined) ?? nodes[0];
    if (wanted) this.reveal(wanted);
    return wanted;
  }

  /** An agent opens its transcript, shown unless d shows its details; any other node shows its details and opens nothing. */
  private select(node: SessionTreeNode | undefined): void {
    const previous = this.shown;
    this.shown = undefined;
    if (previous) this.close(previous);
    this.selectedKey = node?.key;
    if (node) {
      this.initialKey = undefined;
      this.restore = undefined;
    }
    this.detailsScroll = node && (!node.agent || (this.detailsShown && this.hasDetails(node))) ? this.detailsPane() : undefined;
    if (node?.agent) this.shown = this.open(node.agent);
    this.rebuild();
  }
  /** d on an agent with details: its details instead of its transcript, or the transcript again; the transcript goes on polling. */
  private toggleDetails(): void {
    const node = this.selectedNode();
    if (!node?.agent || !this.hasDetails(node)) return;
    this.detailsShown = !this.detailsShown;
    this.detailsScroll = this.detailsShown ? this.detailsPane() : undefined;
    this.rebuild();
  }

  /** a, and enter on a node that is not an agent: the menu of the node's target, only with providers. */
  private openMenu(node: SessionTreeNode): void {
    const target = node.target;
    if (!target || (this.options.actions ?? []).length === 0 || this.menu) return;
    this.followingBeforeMenu = this.following;
    this.following = false;
    // The list draws under the heading row: a mouse report on the menu reaches it a row up.
    const component: Component = { render: (width) => this.menuLines(width), handleMouse: (event) => this.menu?.list?.handleMouse({ ...event, y: event.y - 1 }), invalidate() {} };
    const menu: Menu = { key: node.key, target, readFor: this.readFor(node), handle: this.alt.showOverlay(component, MENU_OVERLAY), entries: undefined, list: undefined, label: undefined, generation: 0, failures: undefined };
    this.menu = menu;
    this.loadMenu(menu);
  }
  /** What a node's labels depend on: its target, its state (which its title ends with) and what waits for a person. */
  private readFor(node: SessionTreeNode): string { return `${JSON.stringify(node.target ?? null)} ${node.title(this.styles)} ${node.needsPerson ?? ""}`; }
  private closeMenu(): void {
    const menu = this.menu;
    this.menu = undefined;
    menu?.handle.hide();
    this.alt.requestRender();
  }
  /**
   * Asks every provider for the target's labels; a later read wins, and the selected label stays selected, else the last one. A
   * provider that cannot be read costs only its own labels: the others show, then a line with its error.
   */
  private loadMenu(menu: Menu): void {
    const generation = ++menu.generation;
    const target = menu.target;
    const current = (): boolean => !this.finished && this.menu === menu && menu.generation === generation;
    void Promise.allSettled((this.options.actions ?? []).map(async (provider) => (await provider.actions(target)).map((action): MenuEntry => ({ action, provider })))).then((results) => {
      if (!current()) return;
      const entries = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
      const failures = results.flatMap((result) => result.status === "rejected" ? [this.styles.warning(`actions unavailable: ${clean(errorText(result.reason))}`)] : []);
      const kept = entries.findIndex((entry) => entry.action.label === menu.label);
      // The first label until one was selected; the last one when the selected label went away.
      const index = kept >= 0 ? kept : menu.label === undefined ? 0 : Math.max(0, entries.length - 1);
      // A label missing because its provider could not be read is still the one to select when the next read has it.
      if (kept >= 0 || failures.length === 0) menu.label = entries[index]?.action.label;
      menu.entries = entries;
      menu.failures = failures.length > 0 ? new Text(failures.join("\n"), 0, 0) : undefined;
      menu.list = entries.length > 0 ? this.menuList(menu, entries, index, failures.length) : undefined;
      this.alt.requestRender();
    });
  }
  /** Pi's select list of the labels, in the rows the terminal leaves under the heading for them, the errors and the closing rule. */
  private menuList(menu: Menu, entries: readonly MenuEntry[], index: number, failures: number): SelectList {
    //NOTE: a resize while the menu is open keeps its rows until the next read.
    const room = Math.max(1, this.alt.terminal.rows - this.fixedRows() - 2 - failures);
    const items = entries.map((entry, at): SelectItem => ({ value: String(at), label: clean(entry.action.label) }));
    // A list longer than its rows draws a "(n/m)" row under them.
    const list = new SelectList(items, entries.length > room ? Math.max(1, room - 1) : room, getSelectListTheme(), { truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, "…") });
    list.setSelectedIndex(index);
    const entryOf = (item: SelectItem): MenuEntry | undefined => entries[Number(item.value)];
    list.onSelectionChange = (item) => { menu.label = entryOf(item)?.action.label; };
    // A click runs it from pi-tui's mouse dispatch, outside input()'s try/catch.
    list.onSelect = (item) => { this.guard(() => { const entry = entryOf(item); if (entry && this.menu === menu) this.choose(menu, entry); }); };
    return list;
  }
  /** ↑↓ and j/k move round the labels read, enter runs the selected one, esc, ← and h close; every other key is dropped. */
  private menuKey(menu: Menu, data: string): void {
    const is = (keybinding: Keybinding): boolean => workflowKeyMatches(this.keybindings, data, keybinding);
    const entries = menu.entries ?? [];
    const list = menu.list;
    const index = Number(list?.getSelectedItem()?.value ?? 0);
    if (is("tui.select.cancel") || is("tui.editor.cursorLeft")) this.closeMenu();
    else if (list && (is("tui.select.up") || is("tui.select.down"))) {
      // The list's own keys are Pi's bindings, without j and k: the workspace moves it.
      const next = (index + (is("tui.select.up") ? -1 : 1) + entries.length) % entries.length;
      list.setSelectedIndex(next);
      menu.label = entries[next]?.action.label;
    } else if (list && is("tui.select.confirm")) {
      const entry = entries[index];
      if (entry) this.choose(menu, entry);
    }
  }
  /** An in-place label runs here; any other leaves the workspace for the caller to run it with Pi's dialogs. */
  private choose(menu: Menu, entry: MenuEntry): void {
    this.closeMenu();
    if (entry.action.inPlace) void this.runInPlace(menu.target, entry);
    else this.leave({ target: menu.target, label: entry.action.label, provider: entry.provider, state: { ...this.state(), ...(this.followingBeforeMenu ? { following: true } : {}) } });
  }
  /** Keys and ticks wait until it settles; what it reports, a failure too, is the status row's notice. */
  private async runInPlace(target: AgentsActionTarget, entry: MenuEntry): Promise<void> {
    const label = entry.action.label;
    this.busy = true;
    try {
      //NOTE: an in-place action (a copy, an editor) selects nothing afterwards.
      await entry.provider.run(target, label, this.inPlaceUi(label));
    } catch (error) {
      this.notify(errorText(error), "error");
    } finally {
      this.busy = false;
      if (!this.finished) this.alt.requestRender();
      // What the action changed shows now, not at a tick that may be five seconds away.
      this.refresh();
    }
  }
  private notify(message: string, level?: "info" | "warning" | "error"): void {
    if (this.finished) return;
    this.notices.push({ text: clean(message), level });
    this.alt.requestRender();
  }
  /** Only notify and openArtifact work in place; every other method needs Pi's dialogs and fails, naming the label. */
  private inPlaceUi(label: string): ActionUi {
    const refused = (method: string): Error => new Error(`${label}: ${method} needs Pi's dialogs, which the workspace cannot show`);
    return {
      notify: (message, level) => { this.notify(message, level); },
      confirm: () => Promise.reject(refused("confirm")),
      select: () => Promise.reject(refused("select")),
      input: () => Promise.reject(refused("input")),
      editText: () => Promise.reject(refused("editText")),
      reviewCheckpoint: () => Promise.reject(refused("reviewCheckpoint")),
      openArtifact: (artifact, artifactLabel) => openArtifactInEditor(this.editorTui(), this.options.editorCommand?.(), artifact, artifactLabel, (message, level) => { this.notify(message, level); }),
      status: () => { throw refused("status"); },
      setWorkingMessage: () => { throw refused("setWorkingMessage"); },
    };
  }
  /**
   * The external editor takes the terminal from the alternate screen, not from Pi: stopping keeps Pi's screen as it was (no frame
   * of the workspace written into it) and Pi's TUI stays stopped; starting enters the alternate screen again with a full frame.
   * An abort while the editor runs leaves Pi stopped and the terminal with the editor: the workspace is left when the editor
   * exits, so starting then does not enter the alternate screen again but disposes the workspace and gives Pi the terminal back.
   * Once the workspace is left both do nothing.
   */
  private editorTui(): WorkflowTui {
    return {
      stop: () => {
        if (this.finished || this.editing) return false;
        this.alt.stop({ preserveScreen: true });
        this.editing = true;
        return true;
      },
      start: () => {
        if (this.finished || !this.editing) return;
        if (this.leaveAfterEditor) { this.leave(); return; }
        this.editing = false;
        //NOTE: a terminal that cannot start again after the editor leaves Pi stopped and the workspace without keys until an abort.
        this.start();
        // The terminal reported no resize while the editor had it: this frame measures it again.
        this.alt.renderNow(true);
      },
      requestRender: (force) => { if (!this.finished && !this.editing) this.alt.requestRender(force); },
    };
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
      const place = this.place;
      this.place = undefined;
      if (place?.identity === shown.identity) shown.scroll.restoreFromEnd(place.fromEnd);
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
    shown.scroll.giveUpRestore();
    shown.failure = undefined;
    if (result.reset) {
      view.reset();
      shown.scroll.cancelRestore();
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
    const matches = this.matches();
    const parts = [
      this.baseTitle(),
      ...(this.following ? [this.styles.muted("following")] : []),
      ...(matches ? [this.styles.muted(`${String(matches.direct.size)} ${matches.direct.size === 1 ? "match" : "matches"}`)] : []),
    ];
    return parts.join(" · ");
  }
  private baseTitle(): string {
    const agent = this.shown?.agent;
    const failure = this.failure ? ` ${this.styles.warning(clean(this.failure))}` : "";
    const node = this.selectedNode();
    if (!agent) return node ? `${node.title(this.styles)}${failure}` : `${this.styles.bold(this.listed ? "no agents" : "agents")}${failure}`;
    const agents = this.nodes.filter((candidate) => candidate.agent !== undefined);
    const position = `#${String(agents.findIndex((candidate) => candidate.key === this.selectedKey) + 1)}/${String(agents.length)}`;
    // An agent a crash left active in a run that is not live is not running: no state, as the widget's mark draws none.
    const state = agent.leftover ? "" : clean(agent.state);
    return [position, this.styles.bold(clean(agent.name)), state && progressStyleForState(state, this.styles)(state), this.styles.muted(clean(agent.summary)), this.speedTitle(agent)].filter((part) => part).join(" ") + failure;
  }
  /** The persisted average rate, else nothing. */
  private speedTitle(agent: SessionAgent): string {
    const average = agent.speed === undefined ? undefined : speedTps(agent.speed);
    return average === undefined ? "" : this.styles.muted(`${average.toFixed(1)} tok/s avg`);
  }
  /** The session's totals over the listed agents: "running/total agents · tokens · cost"; parts without data are left out. */
  private totalsText(): string {
    const agents = this.nodes.flatMap((node) => node.agent ?? []);
    if (agents.length === 0) return "";
    const tokens = agents.reduce((sum, { tokens: value }) => sum + (value ?? 0), 0);
    const cost = agents.reduce((sum, { cost: value }) => sum + (value ?? 0), 0);
    return [`${String(agents.filter(({ running }) => running).length)}/${String(agents.length)} running`, formatTokens(tokens), formatCost(cost)].filter((part) => part).join(" · ");
  }
  /** The title, with the totals at the right end when they fit beside it; the title keeps its width first. */
  private titleRow(width: number): string {
    const title = this.titleText();
    const totals = this.totalsText();
    const gap = width - visibleWidth(title) - visibleWidth(totals);
    if (!totals || gap < 2) return truncateToWidth(title, width, "…");
    return `${title}${" ".repeat(gap)}${this.styles.muted(totals)}`;
  }
  /** The selected node's details as /workflow shows them, laid out at the pane's width and wrapped to it. */
  private detailsLines(width: number): string[] {
    const cell = Math.max(1, width);
    return (this.selectedNode()?.details(this.styles, Date.now(), cell) ?? []).flatMap((line) => wrapTextWithAnsi(line, cell).map((part) => truncateToWidth(part, cell, "")));
  }
  private hintText(): string {
    // Pi's keyHint over the keybindings Pi handed the workspace (Pi's own reads the keybindings of its own pi-tui).
    const keyHint = (keybinding: Keybinding, description: string): string => rawKeyHint(this.keybindings.getKeys(keybinding).join("/"), description);
    // A move names the first key of each direction; [ ] n a d s f / and space are fixed keys.
    const first = (keybinding: Keybinding): string => this.keybindings.getKeys(keybinding)[0] ?? "";
    const separator = this.styles.dim(" · ");
    const node = this.selectedNode();
    // ctrl+c leaves before the filter sees it (key()), so it is no clear key.
    //NOTE: a cancel bound only to ctrl+c names no clear key.
    const clear = rawKeyHint(this.keybindings.getKeys("tui.select.cancel").filter((key) => key !== "ctrl+c").join("/"), "clear");
    if (this.filtering) return [keyHint("tui.input.submit", "keep filter"), clear].join(separator);
    // back right after the move, so a narrow terminal keeps it.
    return [
      ...(this.filterActive() ? [rawKeyHint("/", `filter: ${clean(this.filter)}`), clear] : []),
      this.focus === "sidebar" ? rawKeyHint(`${first("tui.editor.cursorLeft")}/${first("tui.editor.cursorRight")}`, "fold") : rawKeyHint(`${first("tui.select.up")}/${first("tui.select.down")}`, "scroll"),
      keyHint("tui.select.cancel", "back"),
      // f and / are named before they are on: nothing else on screen tells that follow and the filter exist. Space also folds; left/right keep the fold hint short.
      ...(this.following ? [rawKeyHint("f", "stop following")] : this.nodes.some((candidate) => candidate.agent?.running === true) ? [rawKeyHint("f", "follow")] : []),
      rawKeyHint("[ ]", "agent"),
      ...(this.nodes.some((candidate) => candidate.needsPerson !== undefined) ? [rawKeyHint("n", "next")] : []),
      // Ahead of what 120 columns cut when every hint shows: search, sidebar and tools.
      ...(!this.filterActive() && this.focus === "sidebar" && this.sidebarVisible ? [rawKeyHint("/", "filter")] : []),
      ...((this.options.actions ?? []).length > 0 ? [rawKeyHint("a", "menu")] : []),
      ...(node?.agent && this.hasDetails(node) ? [rawKeyHint("d", "details")] : []),
      ...(this.sidebarVisible ? [keyHint("tui.input.tab", "focus")] : []),
      keyHint("tui.altScreen.search", "search"),
      rawKeyHint("s", "sidebar"),
      keyHint("app.tools.expand", "tools"),
    ].join(separator);
  }
  /** The notices first, until the next key; then the shown transcript's state. */
  private statusText(): string {
    const working = this.working ? this.styles.muted(this.working) : undefined;
    if (this.notices.length > 0) return [...(working ? [working] : []), ...this.notices.map(({ text, level }) => level === "warning" ? this.styles.warning(text) : level === "error" ? this.styles.error(text) : text)].join(" · ");
    if (working) return working;
    const shown = this.shown;
    // A failure first: also an agent whose transcript could not be opened has one, and no source.
    if (shown?.failure) return this.styles.warning(clean(shown.failure));
    if (!shown?.source) return "";
    if (shown.status === "waiting") return this.styles.muted(shown.agent.running ? "waiting for the first message" : "no transcript");
    if (shown.status === "unavailable") return this.styles.muted(shown.reason ? `transcript unavailable: ${clean(shown.reason)}` : "transcript unavailable");
    return shown.agent.running && shown.agent.activity ? this.styles.dim(clean(shown.agent.activity)) : "";
  }

  private nodeLine(node: SessionTreeNode, matches: MatchSets | undefined, cell: number): string {
    const selected = node.key === this.selectedKey;
    const line = node.line(this.styles, selected, this.isExpanded(node));
    if (matches === undefined) return this.marked(node, line, cell);
    if (!matches.direct.has(node.key)) return this.dimLine(this.marked(node, line, cell));
    return this.marked(node, line, cell);
  }
  /**
   * The row and its mark when the mark fits whole in `cell`: the row cut before it with "…" as rows are, if that keeps the
   * first character of the label (at display column 4 + 2 * depth); otherwise the row without the mark.
   */
  private marked(node: SessionTreeNode, line: string, cell: number): string {
    const mark = node.mark?.(this.styles) ?? "";
    const room = cell - visibleWidth(mark);
    if (!mark || visibleWidth(line) <= room) return `${line}${mark}`;
    return room >= 6 + 2 * node.depth ? `${truncateToWidth(line, room, "…")}${mark}` : line;
  }
  /** Dims a line whose inner colours would otherwise end the dim early: it is opened again after each foreground or intensity reset. */
  private dimLine(line: string): string {
    const probe = this.styles.dim("\u0000");
    const open = probe.slice(0, Math.max(0, probe.indexOf("\u0000")));
    return this.styles.dim(open === "" ? line : line.replace(DIM_ENDS, (reset) => `${reset}${open}`));
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
    const body = Math.max(1, this.alt.terminal.rows - this.fixedRows());
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
    const matches = this.matches();
    const lines = Array.from({ length: height }, (_, index) => {
      const shown = visible[index];
      const node = shown?.node;
      const text = node ? this.nodeLine(node, matches, cell) : shown ? this.styles.dim("─".repeat(cell)) : "";
      return truncateToWidth(`${truncateToWidth(text, cell, "…", true)}${top ? "" : this.styles.dim(SEPARATOR)}`, total, "", true);
    });
    return top && height > 0 ? [...lines, this.styles.dim("─".repeat(total))] : lines;
  }
  /**
   * The menu: a heading with the target's kind, the select list, the errors and a closing rule, in the rows under the title and
   * above the hint; an error that wraps past them is cut.
   */
  private menuLines(width: number): string[] {
    const menu = this.menu;
    if (!menu) return [];
    const cell = Math.max(1, width);
    const rows = [...(menu.list?.render(cell) ?? []), ...(menu.failures?.render(cell) ?? [])];
    if (rows.length === 0) rows.push(this.styles.muted(menu.entries ? "no actions" : "loading…"));
    //NOTE: below 5 rows the heading and the rule leave no row for the labels: the overlay is cut.
    const room = Math.max(1, this.alt.terminal.rows - this.fixedRows() - 2);
    const heading = truncateToWidth(`${this.styles.dim("─ ")}${this.styles.bold(MENU_TITLES[menu.target.kind])}${this.styles.dim(` ${"─".repeat(cell)}`)}`, cell, "");
    return [heading, ...rows.slice(0, room).map((line) => truncateToWidth(line, cell, "…")), this.styles.dim("─".repeat(cell))];
  }
  /**
   * A click on a row selects its node, and on its ▾/▸ icon also toggles it; a click on a rule does nothing; the wheel is left to the
   * transcript. While the menu is open or an in-place action runs gate() lets no mouse report on the sidebar through.
   */
  private sidebarMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (event.button !== "left" || (event.type !== "press" && event.type !== "release" && event.type !== "click")) return undefined;
    if (event.type === "click") {
      const key = this.sidebarKeys[event.y];
      const node = key === undefined ? undefined : this.byKey.get(key);
      if (node) {
        this.focus = "sidebar";
        this.following = false;
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

/** Resolves when the user leaves the workspace and Pi's own TUI is back: with the chosen action when it needs Pi's dialogs, without one when the user just left. */
export type OpenAgentsWorkspace = (ctx: ExtensionCommandContext, options: AgentsWorkspaceOptions) => Promise<AgentsWorkspaceExit | undefined>;

/**
 * Resolves once Pi's TUI is back: with the label the workspace left for, undefined when the user just left.
 * In Pi 1.1.0 a ctx.ui.custom overlay whose factory stops the parent TUI ({ preserveScreen: true }) and starts a TuiAltScreen
 * on parent.terminal owns the screen; parent.start() and parent.renderNow(false) give it back. The alt screen's primary
 * ScrollView takes pgup/pgdn and the tui.altScreen.* actions (search included) whatever has focus, and input listeners
 * added after its construction run after its viewport listener.
 */
export const openAgentsWorkspace: OpenAgentsWorkspace = async (ctx, options) => {
  // Awaited inside an async function: a custom that throws synchronously rejects this promise.
  return await ctx.ui.custom<AgentsWorkspaceExit | undefined>((parent, theme, keybindings, done) => {
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
    const abort = (): void => { if (workspace) workspace.abort(); else leave(); };
    /** `cause`: the error that closed the workspace (the terminal or the view failed to start), reported once. */
    const leave = (exit?: AgentsWorkspaceExit, cause?: unknown): void => {
      if (left) return;
      left = true;
      signal?.removeEventListener("abort", abort);
      shutdown?.removeEventListener("abort", shut);
      process.off("exit", exited);
      process.off("uncaughtExceptionMonitor", exited);
      //NOTE: a terminal that cannot stop or start (setRawMode on a closed TTY) throws out of leave and may leave Pi stopped.
      workspace?.dispose();
      if (stopped) { parent.start(); parent.renderNow(false); }
      done(exit);
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
        leave(undefined, error);
      }
    });
    return { render: (width) => [truncateToWidth("opening agents…", Math.max(1, width), "…")], invalidate() {} };
  }, { overlay: true });
};
