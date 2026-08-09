/**
 * Live workflow widget: a tree of the runs happening right now, drawn below the
 * editor, and a durable receipt in the transcript once each one reaches a
 * terminal state.
 *
 * The split is deliberate. The widget answers "what is happening" and holds
 * nothing that has reached a final state — resumable interruptions remain visible.
 * The transcript entry answers "what did that cost and who did it", and keeps the
 * answer for the life of the session rather than for a minute.
 *
 * Run state arrives as workflow events; the numbers behind it (tokens, cost,
 * per-agent accounting) live only in the run's state.json, so an event is a
 * signal to re-read rather than the data itself. The repaint timer checks for
 * changed state files without reparsing unchanged runs.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord, AgentState, RunRecord, RunState } from "pi-extensible-workflows";
import { listRunIds, RunStore } from "pi-extensible-workflows/persistence";
import {
  WORKFLOW_AGENT_STALL_THRESHOLD_MS,
  WORKFLOW_AGENT_STATE_CHANGED_EVENT,
  WORKFLOW_BUDGET_EVENT,
  WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT,
  WORKFLOW_PHASE_CHANGED_EVENT,
  WORKFLOW_RUN_COMPLETED_EVENT,
  WORKFLOW_RUN_FAILED_EVENT,
  WORKFLOW_RUN_STARTED_EVENT,
  WORKFLOW_RUN_STATE_CHANGED_EVENT,
  object,
} from "pi-extensible-workflows";

const KEY = "piewf-widget";
const ENTRY_TYPE = "piewf-run-receipt";

/**
 * Repaint interval. Fast enough that the spinner reads as motion rather than a
 * stutter; the underlying data is only re-read when an event says it changed.
 */
const REPAINT_MS = 125;

/**
 * Rows the whole frame may occupy, border included.
 *
 * Pi's ten-line widget cap applies to string arrays, not to a rendered
 * component, so this is a choice about how much screen a status line deserves
 * rather than a limit imposed from outside. What does not fit is folded away by
 * rank, so live work survives and finished work is dropped first.
 */
/**
 * Rows the widget will occupy, border included.
 *
 * Ten is a deliberate ceiling rather than a technical one: the widget sits
 * under the editor, and anything taller pushes the conversation off the top of
 * a normal terminal to report on work that is, by definition, happening
 * elsewhere. Deeper detail is a keypress away rather than always on screen.
 */
const MAX_ROWS = 10;

/**
 * Key matching belongs to Pi, not here.
 *
 * A terminal has several ways to spell an arrow — the bare `\x1b[B`, the kitty
 * protocol's parameterised form with press/release/repeat, xterm's
 * modifyOtherKeys — and which one arrives depends on the terminal and on what
 * Pi negotiated with it. `matchesKey` already knows them all, including the
 * per-terminal quirks; a hand-rolled comparison would be a worse copy that
 * silently matches nothing the day a terminal changes its mind.
 */

/**
 * How long an agent may go without an event before the widget says so. Taken
 * from the core so the widget and the runtime agree on what "stuck" means.
 */
/**
 * How long an agent may go without an event before the widget says so.
 *
 * Deliberately shorter than the core's own stall threshold. That one answers
 * "is this agent dead"; this one answers "should you go and look". An agent
 * asking a question in its own pane produces exactly this signature — no tool
 * calls, no events, waiting on a person — and the core cannot see it, since the
 * pane is a separate process. Three minutes is longer than any single stretch
 * of thinking and far shorter than the ten minutes it takes to be declared
 * stalled.
 */
const QUIET_MS = 3 * 60 * 1000;

/** The core's own threshold for calling an agent stalled outright. */
const STALL_MS = WORKFLOW_AGENT_STALL_THRESHOLD_MS;

/**
 * How long a phase's shell commands must run before they are worth a row. A
 * phase built entirely of short commands would otherwise flicker a line in and
 * out; one that sits on a build or a test suite is exactly what you want to see.
 */
const SHELL_VISIBLE_MS = 5000;

/**
 * The shortcut that focuses the widget.
 *
 * `↓` from an empty editor is the comfortable way in, but an empty editor is
 * also what every picker and dialog leaves behind while it waits for arrows, so
 * that gesture has to defer to whatever else is on screen. This one never has
 * to — and being registered through Pi, it can be rebound in `keybindings.json`
 * like any other shortcut.
 */
const FOCUS_SHORTCUT = "alt+o";

/**
 * Whether the widget accepts the keyboard.
 *
 * Scrolling earns its keys: ten rows cannot hold five runs three phases deep,
 * and what gets folded away at rest is the widget's choice rather than the
 * reader's. The shortcut is the only way in — `↓` on an empty editor belongs
 * to whichever picker opens next.
 */
const NAVIGATION_ENABLED = true;

/**
 * Overrides the switch above, for the tests that cover navigation.
 *
 * The behaviour is finished and tested; only its exposure is withheld. Letting
 * the tests turn it on keeps that coverage alive rather than letting it rot
 * while the feature waits.
 */
export const __navigationForTests = { enabled: NAVIGATION_ENABLED };

/**
 * Colours come from the active theme, never from here.
 *
 * A widget that spelled out its own 24-bit escapes would look right on the
 * author's terminal and wrong on a 256-colour or light theme, and would ignore
 * whatever the reader chose. `Theme.fg` resolves a named role against the
 * theme in force, so the widget follows it.
 *
 * These names are the roles used, kept in one place so a colour decision is
 * visible as a decision rather than scattered through the drawing code.
 */
const ROLE = {
  live: "accent",
  done: "success",
  failed: "error",
  warn: "warning",
  quiet: "muted",
} as const satisfies Record<string, Parameters<Theme["fg"]>[0]>;
const RESET = "\x1b[0m";

/**
 * Paints text in a themed colour role. Falls back to the bare text when no
 * theme is available, so a frame rendered outside the TUI is still legible.
 */
type Paint = (role: Parameters<Theme["fg"]>[0], text: string) => string;

/**
 * States that mean work is still happening, derived from the core's own lists
 * rather than restated here: a state the widget does not recognise reads as
 * finished, and the whole frame vanishes mid-run. Naming what is *over* rather
 * than what is live means a state added upstream is treated as live by default
 * — the safe direction, since drawing a finished run costs a stale row while
 * missing a live one loses the display entirely.
 */
const TERMINAL_RUN = new Set<RunState>(["completed", "failed", "stopped"]);
const DONE_AGENT = new Set<AgentState>(["completed", "failed", "cancelled"]);

const isRunTerminal = (state: string | undefined): boolean =>
  state !== undefined && TERMINAL_RUN.has(state as RunState);
const isRunLive = (state: string | undefined): boolean =>
  state !== undefined && !isRunTerminal(state);
const isAgentLive = (state: string | undefined): boolean =>
  state !== undefined && !DONE_AGENT.has(state as AgentState);

/**
 * Braille wheel, one glyph per repaint.
 *
 * No repeated glyph at the ends: with the first and last the same, the wheel
 * stalls for a frame on every turn and reads as a stutter.
 */
const SPINNER = ["⣷", "⣯", "⣟", "⡿", "⢿", "⣽", "⣻"] as const;

/**
 * A run as the widget sees it: the core's own record, plus where it was read
 * from and when it started.
 *
 * The shape is imported rather than restated. Restating it means the widget's
 * idea of a run silently drifts from the runtime's — which is exactly how a
 * live state ends up unrecognised and the whole frame disappears.
 */
interface Run extends Partial<RunRecord> {
  directory: string;
  startedAt: number;
  /** A checkpoint waiting for an answer, learned from events rather than disk. */
  waiting?: { name: string; since: number };
}

interface ReceiptAgent {
  id?: string;
  parentId?: string;
  name: string;
  state: string;
  model?: string;
  role?: string;
  requestedModel?: string;
  tools?: readonly string[];
  /** Accepted for rendering older receipt entries; new receipts persist granted tools. */
  toolCalls?: number;
  input: number;
  output: number;
  cacheRead: number;
  costUsd: number;
  durationMs: number;
  attempts: number;
}

interface Receipt {
  runId: string;
  workflow: string;
  state: string;
  costUsd: number;
  tokens: number;
  durationMs: number;
  phases: readonly string[];
  phaseBoundaries: readonly number[];
  agents: readonly ReceiptAgent[];
  error?: string;
}

function spinner(now: number): string {
  // Tied to the repaint interval rather than a period of its own: a wheel that
  // advances faster than the screen redraws skips glyphs and reads as jitter.
  return SPINNER[Math.floor(now / REPAINT_MS) % SPINNER.length] ?? SPINNER[0];
}

/** Status mark for a finished-or-running unit of work. */
function mark(state: string | undefined, now: number, paint: Paint, runState?: string): string {
  if (state === "running" && (runState === undefined || runState === "running")) return paint(ROLE.live, spinner(now));
  if (state === "completed") return paint(ROLE.done, "✓");
  if (state === "failed" || state === "budget_exhausted") return paint(ROLE.failed, "✗");
  return paint(ROLE.quiet, "·");
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatTokens(tokens: number | undefined): string {
  if (!tokens) return "";
  if (tokens < 1000) return `${String(tokens)}t`;
  const thousands = tokens / 1000;
  return `${thousands < 10 ? thousands.toFixed(1) : String(Math.round(thousands))}kt`;
}

function formatCost(cost: number | undefined): string {
  if (!cost) return "";
  // Three decimals below a cent: at two, every cheap agent reads as $0.00 and
  // the per-agent column becomes a row of zeroes.
  return cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
}

/**
 * Visible width, measured the way the terminal measures it.
 *
 * Not the string's length: a CJK ideograph is one JavaScript character and two
 * terminal cells, an emoji is often two characters and two cells, and a
 * combining accent is a character that takes none. Pi-tui rejects a line wider
 * than the width it handed out — it does not wrap, it throws — so the widget
 * has to agree with it exactly, and the only way to agree exactly is to use
 * its own measure.
 */
function visibleLength(text: string): number {
  return visibleWidth(text);
}

/**
 * Cuts a coloured line down to a visible width.
 *
 * Pi-tui's own truncation, for the same reason: it counts cells, keeps escape
 * sequences whole rather than slicing through one and bleeding colour into the
 * border, and never cuts a character in half.
 */
function truncate(text: string, limit: number): string {
  return `${truncateToWidth(text, limit, "…")}${RESET}`;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function optionalNumber(value: unknown): boolean {
  return value === undefined || finiteNumber(value);
}

function renderableAgent(value: unknown): boolean {
  if (!object(value) || typeof value.name !== "string" || typeof value.state !== "string" || !object(value.model) || typeof value.model.model !== "string" || !Array.isArray(value.tools) || !value.tools.every((tool) => typeof tool === "string")) return false;
  if (value.model.thinking !== undefined && typeof value.model.thinking !== "string") return false;
  for (const key of ["id", "label", "parentId", "role", "requestedModel"] as const) if (value[key] !== undefined && typeof value[key] !== "string") return false;
  for (const key of ["attempts", "startedAt", "durationMs", "lastEventAt"] as const) if (!optionalNumber(value[key])) return false;
  const accounting = value.accounting;
  if (accounting !== undefined && (!object(accounting) || !["input", "output", "cacheRead", "cacheWrite", "cost"].every((key) => optionalNumber(accounting[key])))) return false;
  const attemptDetails = value.attemptDetails;
  if (attemptDetails !== undefined && (!Array.isArray(attemptDetails) || attemptDetails.some((detail) => !object(detail)))) return false;
  return true;
}

function renderableRun(value: unknown): value is Partial<RunRecord> {
  if (!object(value) || typeof value.state !== "string") return false;
  if (value.workflowName !== undefined && typeof value.workflowName !== "string") return false;
  if (value.id !== undefined && typeof value.id !== "string") return false;
  if (value.sessionId !== undefined && typeof value.sessionId !== "string") return false;
  if (value.agents !== undefined && (!Array.isArray(value.agents) || value.agents.some((agent) => !renderableAgent(agent)))) return false;
  const history = value.phaseHistory;
  if (history !== undefined && (!Array.isArray(history) || history.some((entry) => !object(entry) || typeof entry.phase !== "string" || !finiteNumber(entry.afterAgent)))) return false;
  const usage = value.usage;
  if (usage !== undefined && (!object(usage) || !["tokens", "costUsd", "durationMs", "agentLaunches"].every((key) => optionalNumber(usage[key])))) return false;
  const delivery = value.delivery;
  if (delivery !== undefined && (!object(delivery) || typeof delivery.mode !== "string" || typeof delivery.state !== "string")) return false;
  const budgetEvents = value.budgetEvents;
  if (budgetEvents !== undefined && (!Array.isArray(budgetEvents) || budgetEvents.some((event) => !object(event) || typeof event.type !== "string" || !Array.isArray(event.dimensions) || !event.dimensions.every((dimension) => typeof dimension === "string")))) return false;
  const shellActivity = value.activeShellsByPhase;
  if (shellActivity !== undefined && (!Array.isArray(shellActivity) || shellActivity.some((entry) => !object(entry) || !finiteNumber(entry.phaseIndex) || !finiteNumber(entry.active) || !optionalNumber(entry.startedAt)))) return false;
  return true;
}

/**
 * Reads one run's state.json.
 *
 * The run carries no start time of its own and state.json is rewritten whole on
 * every step, so its birth time keeps moving. The directory is created once and
 * never touched again — that is the start. Taking it from the file made the
 * clock restart on every phase.
 */
function readRun(directory: string): Run | undefined {
  try {
    const state: unknown = JSON.parse(readFileSync(join(directory, "state.json"), "utf8"));
    if (!renderableRun(state)) return undefined;
    const startedAt = statSync(directory).birthtimeMs;
    return { ...state, directory, startedAt };
  } catch {
    // A run mid-write, or a directory without state yet.
    return undefined;
  }
}

/**
 * When this run's agent sessions last grew, by the transcript files themselves.
 *
 * The run state's own `lastEventAt` is not a sign of life: the core keeps it in
 * memory and only writes it out when it persists, so a perfectly busy agent
 * looks silent for minutes at a time. The agent's transcript, on the other
 * hand, is appended to on every turn — if that file is growing, work is
 * happening, whatever the run state says.
 */
/**
 * When an agent's own transcript was last written.
 *
 * The agent record carries the session for each attempt, so the file belongs
 * to this agent alone. Taking the newest write across every session in the run
 * — as a whole-run reading does — lets one busy agent vouch for a silent one:
 * the pair look equally alive while only one of them is.
 *
 * Stat results are cached for the life of a frame. Without that the check is
 * one stat per agent per repaint, several times a second, for a number that
 * cannot have changed between two rows of the same frame.
 */
function lastTranscriptWrite(agent: AgentRecord, cache: Map<string, number | undefined>): number | undefined {
  const details = agent.attemptDetails ?? [];
  let newest: number | undefined;
  // Only this agent's attempts: a retry writes a new transcript, and the
  // latest one is what says whether it is still moving.
  for (const detail of details) {
    const locator = detail.session?.locator as { sessionFile?: string } | undefined;
    const file = locator?.sessionFile;
    if (!file) continue;
    if (!cache.has(file)) {
      try {
        cache.set(file, statSync(file).mtimeMs);
      } catch {
        // The transcript moved or was cleaned up; another attempt may answer.
        cache.set(file, undefined);
      }
    }
    const mtime = cache.get(file);
    if (mtime !== undefined && (newest === undefined || mtime > newest)) newest = mtime;
  }
  return newest;
}

/**
 * How long an agent has been silent, once that crosses the quiet threshold.
 *
 * An agent thinking hard looks exactly like an agent whose transport died: both
 * are a spinner that does not stop. Silence separates them — but it has to be
 * measured against the transcript, not the run state.
 */
function agentSilentFor(agent: AgentRecord, now: number, cache: Map<string, number | undefined>): number | undefined {
  if (agent.state !== "running") return undefined;
  const last = Math.max(agent.lastEventAt ?? 0, lastTranscriptWrite(agent, cache) ?? 0);
  if (last === 0) return undefined;
  const silent = now - last;
  return silent >= QUIET_MS ? silent : undefined;
}

/**
 * Shell activity for one phase, when it has been running long enough to matter.
 *
 * A phase of pure shell work has no agents, so without this it draws as a bare
 * name with nothing under it and reads as stalled.
 */
function phaseShellRow(run: Run, phaseIndex: number, now: number): { label: string; elapsed: string } | undefined {
  const entry = run.activeShellsByPhase?.find((item) => item.phaseIndex === phaseIndex);
  const active = entry?.active ?? 0;
  if (active <= 0) return undefined;
  const startedAt = entry?.startedAt;
  if (startedAt === undefined || now - startedAt < SHELL_VISIBLE_MS) return undefined;
  const label = active === 1 ? "1 command" : `${String(active)} commands`;
  // The elapsed time is returned apart from the label so it can join the other
  // figures against the right-hand rule instead of trailing the text.
  return { label, elapsed: formatElapsed(now - startedAt) };
}

/** The worst budget threshold a run has crossed, and on which dimensions. */
function budgetWarning(run: Run): string | undefined {
  const events = run.budgetEvents ?? [];
  if (events.length === 0) return undefined;
  const worst = ["hard_exhausted", "hard_overrun", "soft_crossed"].find((type) =>
    events.some((event) => event.type === type),
  );
  if (!worst) return undefined;
  const dimensions = [
    ...new Set(
      events.filter((event) => event.type === worst).flatMap((event) => event.dimensions),
    ),
  ];
  const what = dimensions.length > 0 ? ` (${dimensions.join(", ")})` : "";
  if (worst === "soft_crossed") return `near budget${what}`;
  return worst === "hard_overrun" ? `over budget${what}` : `budget exhausted${what}`;
}

function agentTokens(agent: AgentRecord): number {
  const accounting = agent.accounting;
  if (!accounting) return 0;
  return accounting.input + accounting.output;
}

/** Phase names in the order they opened, with the agents that ran in each. */
type PhaseSlice = { phase: string; agents: readonly AgentRecord[]; phaseIndex?: number };

function phaseSlices(run: Run): PhaseSlice[] {
  const history = run.phaseHistory ?? [];
  const agents = run.agents ?? [];
  if (history.length === 0) return agents.length === 0 ? [] : [{ phase: "unphased", agents }];

  const bound = (value: number): number => Math.max(0, Math.min(value, agents.length));
  const slices: PhaseSlice[] = [];
  const first = bound(history[0]?.afterAgent ?? 0);
  if (first > 0) slices.push({ phase: "unphased", agents: agents.slice(0, first) });
  history.forEach((entry, index) => {
    const from = bound(entry.afterAgent);
    const next = history[index + 1];
    const to = next === undefined ? agents.length : bound(next.afterAgent);
    slices.push({ phase: entry.phase, phaseIndex: index, agents: agents.slice(from, to) });
  });
  return slices;
}

/**
 * The slice of Pi's TUI this widget needs: who holds the keyboard.
 *
 * Declared structurally rather than imported, so an older host missing either
 * accessor degrades to "nothing else is focused" instead of failing to load.
 */
interface TuiHandle {
  hasOverlay?: () => boolean;
  getFocusedComponent?: () => unknown;
}

interface Row {
  text: string;
  /**
   * Numbers to set against the right-hand rule rather than trailing the name.
   *
   * Names are ragged — a phase called `plan` beside one called `refactor-2` —
   * so numbers that follow them are ragged too, and comparing the cost of one
   * agent against another means reading across a gap that moves on every row.
   * Held to the right edge, they form a column.
   */
  right?: string;
  /** 2 = a run header or something needing an answer, 1 = live or failed work, 0 = finished detail. */
  rank: number;
  /**
   * Set on the one row that stands for a whole run.
   *
   * Rank alone cannot protect it: a checkpoint needs an answer and so shares
   * the top rank, and enough of them would spend the budget before a later
   * run's header is reached. A run missing its header is not a terse run, it
   * is an invisible one.
   */
  header?: boolean;
  /**
   * A stable name for a row that can be folded shut, and the key of the row it
   * hangs from. Together they let the cursor walk a tree rather than a list:
   * collapsing a phase hides its agents, collapsing a run hides everything
   * under it, and the choice survives the repaint that follows.
   */
  key?: string;
  parent?: string;
}

/**
 * Folds the least interesting rows away once the tree outgrows its budget,
 * leaving a marker in their place. Run headers are prioritized so every visible
 * run retains its title without exceeding the frame budget.
 */
/**
 * The furthest the window may travel: the offset whose window ends on the last
 * row of the tree.
 *
 * One number, used by the window, by the scrollbar and by the key handler
 * alike. Three separate clamps is how the thumb reaches the bottom while the
 * content still has rows to give, and how presses past the end pile up an
 * offset nothing can see — paid back later as arrow presses that do nothing.
 */
function maxOffset(total: number, budget: number): number {
  if (total <= budget) return 0;
  return Math.max(0, total - (budget - 1));
}

function collapse(rows: readonly Row[], budget: number, paint: Paint, offset: number, scrolling: boolean): Row[] {
  if (rows.length <= budget) return [...rows];

  // Scrolling: a window onto the tree, with the count of what lies past the
  // bottom edge. Reading it is a matter of moving the window rather than
  // deciding for the reader which rows deserve the space.
  if (scrolling) {
    const start = Math.min(offset, maxOffset(rows.length, budget));
    const window = rows.slice(start, start + budget - 1);
    const below = rows.length - start - window.length;
    return [
      ...window,
      { rank: 0, text: paint(ROLE.quiet, below > 0 ? `… ${String(below)} more` : `… ${String(start)} above`) },
    ];
  }

  // At rest: keep the rows that say most, since nobody is steering. Reserve
  // one body row for the marker unless headers alone fill the budget.
  const keep = new Set<number>();
  const headerCount = rows.filter((row) => row.rank === 2 && row.header === true).length;
  const reserveMarker = headerCount !== budget;
  const capacity = reserveMarker ? Math.max(0, budget - 1) : budget;
  for (const [index, row] of rows.entries()) {
    if (row.rank === 2 && row.header === true && keep.size < capacity) keep.add(index);
  }
  for (const rank of [2, 1, 0]) {
    for (const [index, row] of rows.entries()) {
      if (row.rank === rank && keep.size < capacity) keep.add(index);
    }
  }

  const out: Row[] = [];
  let hidden = 0;
  for (const [index, row] of rows.entries()) {
    if (keep.has(index)) out.push(row);
    else hidden += 1;
  }
  if (hidden > 0 && reserveMarker) out.push({ rank: 0, text: paint(ROLE.quiet, `… ${String(hidden)} more`) });
  return out.slice(0, budget);
}



/** The whole widget frame, or undefined when nothing is running. */
function renderFrame(runs: readonly Run[], now: number, width: number, offset = 0, theme?: Theme, scrolling = false, sizeOut: { rows: number } = { rows: 0 }): string[] | undefined {
  // Only live background runs.
  //
  // A finished run leaves its own receipt in the transcript, so holding it
  // above the editor afterwards says the same thing twice — and the transcript
  // keeps it for good, where the widget only kept it for a minute.
  //
  // A foreground run is already drawn by the workflow tool's own output, in
  // more detail than this can offer: it has the live activity and token counts
  // that never reach the run state on disk. Drawing it here too would be two
  // views of one run disagreeing with each other. Background runs have no such
  // view — the tool call returned the moment they started.
  const live = runs.filter((run) => isRunLive(run.state) && run.delivery?.mode !== "foreground");
  if (live.length === 0) return undefined;

  const paint: Paint = (role, text) => (theme ? theme.fg(role, text) : text);
  // One stat per transcript per frame, not per agent per repaint.
  const mtimes = new Map<string, number | undefined>();

  const rows: Row[] = [];
  for (const run of live) {
    const stats = [formatTokens(run.usage?.tokens), formatCost(run.usage?.costUsd)]
      .filter(Boolean)
      .join(" · ");
    const budget = budgetWarning(run);
    const runKey = `run:${run.id ?? ""}`;
    rows.push({
      rank: 2,
      header: true,
      key: runKey,
      text: `${mark(run.state, now, paint, run.state)} ${run.workflowName ?? "workflow"}${
        budget ? `  ${paint(ROLE.warn, budget)}` : ""
      }`,
      right: `${stats ? `${stats} · ` : ""}${formatElapsed(now - run.startedAt)}`,
    });

    // A checkpoint is the one thing here that a person has to act on, and it
    // only exists as an event: the run state on disk never mentions it.
    if (run.waiting) {
      rows.push({
        rank: 2,
        parent: runKey,
        text: `  ${paint(ROLE.warn, "◆")} waiting: ${run.waiting.name}`,
        right: formatElapsed(now - run.waiting.since),
      });
    }

    const slices = phaseSlices(run);
    slices.forEach((slice, index) => {
      const last = index === slices.length - 1;
      const liveAgents = slice.agents.some(
        (agent) => isAgentLive(agent.state),
      );
      const failed = slice.agents.some((agent) => agent.state === "failed");
      const phaseState = failed ? "failed" : liveAgents && run.state === "running" ? "running" : run.state === "running" ? "completed" : run.state;

      let cost = 0;
      let tokens = 0;
      for (const agent of slice.agents) {
        cost += agent.accounting?.cost ?? 0;
        tokens += agentTokens(agent);
      }
      const phaseStats = [formatTokens(tokens), formatCost(cost)].filter(Boolean).join(" · ");

      const phaseKey = `${runKey}/phase:${String(index)}`;
      rows.push({
        rank: liveAgents || failed ? 1 : 0,
        key: phaseKey,
        parent: runKey,
        text: `  ${last ? "╰─" : "├─"} ${mark(phaseState, now, paint, run.state)} ${slice.phase}`,
        ...(phaseStats ? { right: phaseStats } : {}),
      });

      const stem = last ? "   " : "  │";

      // A phase running only shell commands has no agents under it, so without
      // this it reads as a name with nothing happening beneath it.
      const shell = slice.phaseIndex === undefined ? undefined : phaseShellRow(run, slice.phaseIndex, now);
      if (shell) {
        rows.push({
          rank: 1,
          parent: phaseKey,
          text: `${stem} ${slice.agents.length === 0 ? "╰─" : "├─"} ${mark("running", now, paint, run.state)} ${shell.label}`,
          right: shell.elapsed,
        });
      }

      // Agents nest: one may spawn another, and drawing them as siblings hides
      // who asked for what — a child's cost then reads as a peer's rather than
      // part of the parent's total.
      const children = new Map<string, AgentRecord[]>();
      const roots: AgentRecord[] = [];
      const inSlice = new Set(slice.agents.map((agent) => agent.id));
      for (const agent of slice.agents) {
        const parent = agent.parentId;
        if (parent !== undefined && inSlice.has(parent)) {
          children.set(parent, [...(children.get(parent) ?? []), agent]);
        } else {
          roots.push(agent);
        }
      }

      const drawAgent = (agent: AgentRecord, prefix: string, lastAgent: boolean, parentKey: string): void => {
        const agentLive = isAgentLive(agent.state);
        const attempts = agent.attempts;
        const detail = [
          `${agent.model.model}${agent.model.thinking ? `:${agent.model.thinking}` : ""}`,
          formatTokens(agentTokens(agent)),
          formatCost(agent.accounting?.cost),
          formatElapsed(
            agentLive && agent.startedAt ? now - agent.startedAt : (agent.durationMs ?? 0),
          ),
          // A retry doubles what the agent costs, and only the latest attempt
          // shows in the numbers beside it.
          attempts > 1 ? `attempt ${String(attempts)}` : "",
        ]
          .filter(Boolean)
          .join(" · ");

        const silent = agentSilentFor(agent, now, mtimes);
        const kids = children.get(agent.id) ?? [];
        const agentKey = `${parentKey}/agent:${agent.id}`;

        rows.push({
          rank: agentLive || agent.state === "failed" ? 1 : 0,
          parent: parentKey,
          ...(kids.length > 0 ? { key: agentKey } : {}),
          text: `${prefix}${lastAgent ? "╰─" : "├─"} ${

            silent === undefined
              ? mark(agent.state, now, paint, run.state)
              : paint(silent >= STALL_MS ? ROLE.failed : ROLE.warn, "⚠")
          } ${
            // The label is what the workflow called this agent — `reviewer #2`,
            // `scout (api)` — where the name is the role it was built from. Two
            // agents of one role are otherwise indistinguishable.
            agent.label ?? agent.name
          }${
            silent === undefined
              ? ""
              : `  ${paint(
                  silent >= STALL_MS ? ROLE.failed : ROLE.warn,
                  `${silent >= STALL_MS ? "stalled" : "quiet"} ${formatElapsed(silent)}`,
                )}`
          }`,
          right: detail,
        });

        kids.forEach((child, childIndex) => {
          drawAgent(child, `${prefix}${lastAgent ? "   " : "  │"}`, childIndex === kids.length - 1, agentKey);
        });
      };

      roots.forEach((agent, agentIndex) => {
        drawAgent(agent, `${stem} `, agentIndex === roots.length - 1, phaseKey);
      });
    });
  }

  // The rules change colour while scrolling, so it is obvious at a glance that
  // the arrows are going here and not to the editor.
  const accent = (text: string): string => paint(scrolling ? ROLE.warn : ROLE.live, text);
  const title = live.length === 1 ? "Workflow" : `Workflows · ${String(live.length)} runs`;
  sizeOut.rows = rows.length;
  const body = collapse(rows, MAX_ROWS - 2, paint, offset, scrolling);

  // Width budget: the rule takes a column and a space on each side, so the
  // text has four fewer than the widget is given. Every piece is measured
  // against `inner` so the right-hand rule lands in one column on every row.
  const inner = Math.max(20, width - 4);


  // Side rules below the lid, and no floor: the box opens downward into the
  // editor rather than closing on itself, which is one more line kept for the
  // run.
  // A scrollbar on the right rule, drawn only when there is more tree than
  // frame. Without it the window's position is a guess: three rows of a
  // twenty-row tree look the same near the top as near the bottom.
  const total = rows.length;
  const shown = body.length;
  const scrollbar = (index: number): string | undefined => {
    if (!scrolling || total <= shown) return undefined;
    // The thumb is positioned against how far the window can travel, not
    // against the height of the tree. Dividing by the tree instead puts the
    // thumb at the bottom while the window still has a row to give, which is
    // the one thing a scrollbar must never say.
    // The window shows `shown - 1` rows of the tree: the last line of the
    // frame is the marker counting what is out of sight, which belongs to the
    // scrollbar's question rather than to the tree it measures.
    const visible = shown - 1;
    const limit = maxOffset(total, MAX_ROWS - 2);
    const start = Math.min(offset, limit);
    // The thumb spans the visible share of the tree, at least one row, and
    // never the whole track while rows remain out of sight.
    const size = Math.min(shown - 1, Math.max(1, Math.round((visible / total) * shown)));
    // Floor, not round: rounding up on the second-to-last step parks the thumb
    // at the bottom while the window still has a row to travel. The bottom is
    // reserved for the bottom, and reached only by landing on the limit.
    const top = limit === 0 ? 0 : start >= limit ? shown - size : Math.floor((start / limit) * (shown - size));
    return index >= top && index < top + size ? "█" : "░";
  };

  const lines = body.map((row, index) => {
    // The numbers hold the right edge; the name gives way when the two would
    // meet. A truncated workflow name is still recognisable, where a truncated
    // cost is a different number.
    const right = row.right ?? "";
    const rightWidth = right === "" ? 0 : visibleLength(right) + 2;
    const room = Math.max(0, inner - rightWidth);
    const left = visibleLength(row.text) > room ? truncate(row.text, room) : row.text;
    const gap = Math.max(0, inner - visibleLength(left) - (right === "" ? 0 : visibleLength(right)));
    const text = right === "" ? left + " ".repeat(gap) : `${left}${" ".repeat(gap)}${paint(ROLE.quiet, right)}`;
    const rule = accent("│");
    const bar = scrollbar(index);
    return `${rule} ${text} ${bar === undefined ? rule : accent(bar)}`;
  });

  // A lid that costs no line of its own.
  //
  // The title row carries the top rule through it — `╭─ Workflow ─── hint ─╮` —
  // rather than sitting under a separate run of dashes. In ten rows a line
  // spent on decoration is a line not spent on the run, and the box still
  // reads as closed at the top.
  // Nothing is promised while navigation is switched off: a hint for keys
  // that do nothing is worse than no hint.
  const hint = !__navigationForTests.enabled ? "" : scrolling ? "↑↓ scroll · esc to exit" : `${FOCUS_SHORTCUT} to scroll`;
  const label = ` ${title} `;
  const tail = hint === "" ? "" : ` ${hint} `;
  const spare = inner + 2 - visibleLength(label) - visibleLength(tail);
  const heading =
    spare >= 2
      ? accent(`╭${label}${"─".repeat(spare)}${tail}╮`)
      : accent(`╭${label}${"─".repeat(Math.max(0, inner + 2 - visibleLength(label)))}╮`);
  // A floor to close the box.
  //
  // Without it the side rules simply stop, and a frame that shrinks — a phase
  // folded away, a run finished — leaves the tail of the taller one behind on
  // screen, since Pi redraws differentially and the rows below are no longer
  // its business. The closing rule gives the eye somewhere to stop and the
  // redraw something to overwrite.
  const foot = accent(`╰${"─".repeat(inner + 2)}╯`);
  return [heading, ...lines, foot];
}

/** Everything worth keeping about a run once it is over. */
function receiptError(run: Run, fallback: { message?: string } | undefined): string | undefined {
  if (run.error?.message) return run.error.message;
  if (run.state !== "failed") return undefined;
  if (fallback?.message) return fallback.message;
  for (const agent of run.agents ?? []) {
    for (const detail of [...(agent.attemptDetails ?? [])].reverse()) {
      if (detail.error?.message) return detail.error.message;
    }
  }
  return undefined;
}
function receiptFor(run: Run, fallback?: { message?: string }): Receipt {
  const slices = phaseSlices(run);
  const agents = slices.flatMap((slice) => slice.agents);
  let boundary = 0;
  const phaseBoundaries = slices.map((slice) => {
    const current = boundary;
    boundary += slice.agents.length;
    return current;
  });
  const error = receiptError(run, fallback);
  return {
    runId: run.id ?? "",
    workflow: run.workflowName ?? "workflow",
    state: run.state ?? "completed",
    costUsd: run.usage?.costUsd ?? 0,
    tokens: run.usage?.tokens ?? 0,
    durationMs: run.usage?.durationMs ?? 0,
    phases: slices.map(({ phase }) => phase),
    phaseBoundaries,
    agents: agents.map((agent) => ({
      id: agent.id,
      ...(agent.parentId === undefined ? {} : { parentId: agent.parentId }),
      // What the workflow called it, falling back to the role it was built
      // from. Two agents of one role are otherwise indistinguishable.
      name: agent.label ?? agent.name,
      state: agent.state,
      // Model and thinking level together: a role picks both, and the model
      // name alone does not say whether it reasoned cheaply or deeply.
      ...(agent.model.model
        ? {
            model: `${agent.model.model}${agent.model.thinking ? `:${agent.model.thinking}` : ""}`,
          }
        : {}),
      ...(agent.role ? { role: agent.role } : {}),
      ...(agent.requestedModel ? { requestedModel: agent.requestedModel } : {}),
      tools: [...agent.tools],
      // Cache reads dwarf real input and cost almost nothing, so the split is
      // what explains a cheap run that looks enormous.
      input: agent.accounting?.input ?? 0,
      output: agent.accounting?.output ?? 0,
      cacheRead: agent.accounting?.cacheRead ?? 0,
      costUsd: agent.accounting?.cost ?? 0,
      durationMs: agent.durationMs ?? 0,
      attempts: agent.attempts,
    })),
    ...(error === undefined ? {} : { error }),
  };
}

/** The receipt as transcript lines: the widget's tree, one level deeper. */
export function renderReceipt(data: Receipt, expanded: boolean, theme: Theme): string[] {
  const glyph = (state: string): string =>
    state === "completed"
      ? theme.fg("success", "✓")
      : state === "failed" || state === "budget_exhausted"
        ? theme.fg("error", "✗")
        : theme.fg("muted", "·");

  const headline = [
    formatTokens(data.tokens),
    formatCost(data.costUsd) || "$0.00",
    formatElapsed(data.durationMs),
    data.state,
  ]
    .filter(Boolean)
    .join(" · ");

  const lines = [`${glyph(data.state)} ${theme.bold(data.workflow)} ${theme.fg("muted", headline)}`];

  data.phases.forEach((phase, index) => {
    const from = data.phaseBoundaries[index] ?? 0;
    const to =
      index + 1 < data.phaseBoundaries.length
        ? (data.phaseBoundaries[index + 1] ?? data.agents.length)
        : data.agents.length;
    const agents = data.agents.slice(from, to);
    const last = index === data.phases.length - 1;

    let cost = 0;
    let tokens = 0;
    for (const agent of agents) {
      cost += agent.costUsd;
      tokens += agent.input + agent.output;
    }
    const state = agents.some((agent) => agent.state === "failed") ? "failed" : "completed";
    const stats = [formatTokens(tokens), formatCost(cost)].filter(Boolean).join(" · ");

    lines.push(
      `${last ? "╰─" : "├─"} ${glyph(state)} ${phase}${stats ? theme.fg("muted", `  ${stats}`) : ""}`,
    );

    const stem = last ? "  " : "│ ";
    const inPhase = new Set(agents.flatMap((agent) => agent.id === undefined ? [] : [agent.id]));
    const children = new Map<string, ReceiptAgent[]>();
    const roots: ReceiptAgent[] = [];
    for (const agent of agents) {
      if (agent.parentId !== undefined && inPhase.has(agent.parentId)) {
        children.set(agent.parentId, [...(children.get(agent.parentId) ?? []), agent]);
      } else {
        roots.push(agent);
      }
    }

    const drawAgent = (agent: ReceiptAgent, prefix: string, lastAgent: boolean): void => {
      const detail = [
        agent.model ?? "",
        formatCost(agent.costUsd),
        formatElapsed(agent.durationMs),
        // A run that only succeeded on the third try cost three times what its
        // final attempt suggests.
        agent.attempts > 1 ? `${String(agent.attempts)} attempts` : "",
      ]
        .filter(Boolean)
        .join(" · ");

      lines.push(
        `${prefix}${lastAgent ? "╰─" : "├─"} ${glyph(agent.state)} ${agent.name} ${theme.fg("muted", detail)}`,
      );

      const under = `${prefix}${lastAgent ? "  " : "│ "}   `;
      const meta = [
        agent.role ? `role ${agent.role}` : "",
        agent.requestedModel && agent.requestedModel !== agent.model
          ? `via ${agent.requestedModel}`
          : "",
        agent.tools?.length
          ? agent.tools.join(" ")
          : agent.toolCalls === undefined
            ? ""
            : `${String(agent.toolCalls)} ${agent.toolCalls === 1 ? "call" : "calls"}`,
      ].filter(Boolean);
      if (meta.length > 0) lines.push(theme.fg("muted", `${under}${meta.join(" · ")}`));

      const split = [
        agent.input ? `in ${formatTokens(agent.input)}` : "",
        agent.output ? `out ${formatTokens(agent.output)}` : "",
        agent.cacheRead ? `cache ${formatTokens(agent.cacheRead)}` : "",
      ].filter(Boolean);
      if (split.length > 0) lines.push(theme.fg("muted", `${under}${split.join(" · ")}`));

      const kids = agent.id === undefined ? [] : children.get(agent.id) ?? [];
      kids.forEach((child, childIndex) => {
        drawAgent(child, under, childIndex === kids.length - 1);
      });
    };

    roots.forEach((agent, agentIndex) => {
      drawAgent(agent, `${stem} `, agentIndex === roots.length - 1);
    });
  });

  if (data.error !== undefined) lines.push(theme.fg("error", `   ${data.error}`));

  // The run id is only useful when acting on it (resuming, digging through the
  // run directory), so it stays out of the way until the entry is expanded.
  if (expanded && data.runId) lines.push(theme.fg("muted", `   run ${data.runId}`));

  return lines;
}

export default function widget(pi: ExtensionAPI): void {
  let context: ExtensionContext | undefined;
  let timer: NodeJS.Timeout | undefined;
  /** True while a frame is on screen, so it is only cleared when there is one. */
  let showing = false;
  let renderFailed = false;

  /**
   * Whether the widget holds the keyboard, and which row is under the cursor.
   *
   * Focus is only taken deliberately — `↓` on an empty editor — and given back
   * the moment anything is typed. A widget that swallowed keys the rest of the
   * time would be a widget you had to fight to write past.
   */
  let focused = false;
  /** Rows in the last frame, so the cursor cannot leave it. */
  let rowCount = 0;
  /** Keys of rows the reader has folded shut, kept across repaints. */
  /** How far the window has been scrolled down the tree. */
  let offset = 0;
  /** Rows the tree had in the last frame, so scrolling cannot run off its end. */
  const size = { rows: 0 };
  /**
   * The TUI the widget was last built against, kept only to ask whether
   * something else currently owns the keyboard.
   */
  let host: TuiHandle | undefined;
  let inputUnsubscribe: (() => void) | undefined;
  /**
   * Whether some other component is holding the keyboard.
   *
   * `↓` from an empty editor is the comfortable way in, but an empty editor is
   * also what every picker and dialog leaves behind while it waits for arrows.
   * Claiming the key regardless meant `/workflow` opened a menu that could not
   * be moved through.
   *
   * The editor holds focus whenever nothing special is open, so the question is
   * whether focus is still on an editor — recognised by what it can do, not by
   * `instanceof`. A widget is installed beside Pi rather than inside it, and npm
   * may well give it a second copy of the TUI package: the classes then differ
   * by identity even though they are the same class, and `instanceof` answers
   * "not an editor" for the editor itself. Duck typing survives that.
   */
  const somethingElseHasTheKeyboard = (): boolean => {
    try {
      if (host?.hasOverlay?.()) return true;
      const focus = host?.getFocusedComponent?.() as { getText?: unknown; addToHistory?: unknown } | null | undefined;
      if (focus === undefined) return false;
      if (focus === null) return false;
      return typeof focus.getText !== "function" || typeof focus.addToHistory !== "function";
    } catch {
      // An older TUI without these accessors: assume the coast is clear rather
      // than disabling navigation outright.
      return false;
    }
  };

  /** Run directories seen this session, and the parsed state of each. */
  const runs = new Map<string, Run>();
  /** Last-seen mtime per run, so an unchanged state file is never re-parsed. */
  const seen = new Map<string, number>();
  /** Runs already written to the transcript, so each is recorded once. */
  const receipted = new Set<string>();
  /** Terminal completed/failed state events wait for their dedicated event. */
  const awaitingDedicatedReceipt = new Set<string>();
  const failureEvents = new Map<string, { message: string }>();
  let sessionGeneration = 0;

  const sessionId = (): string | undefined => context?.sessionManager.getSessionId();
  const resetNavigation = (): void => {
    focused = false;
    offset = 0;
    rowCount = 0;
    size.rows = 0;
    host = undefined;
  };
  const hide = (): void => {
    if (showing) {
      try { context?.ui.setWidget(KEY, undefined); } catch { /* A failed repaint is already being cleared. */ }
    }
    showing = false;
    renderFailed = false;
    inputUnsubscribe?.();
    inputUnsubscribe = undefined;
    resetNavigation();
  };
  const handleInput = (data: string): { consume?: boolean } | undefined => {
    if (!showing || !focused) return undefined;
    if (somethingElseHasTheKeyboard()) {
      focused = false;
      offset = 0;
      return undefined;
    }
    if (maxOffset(rowCount, MAX_ROWS - 2) === 0) {
      focused = false;
      offset = 0;
      return undefined;
    }
    if (isKeyRelease(data)) return { consume: true };
    if (matchesKey(data, Key.up)) {
      offset = Math.max(0, offset - 1);
      return { consume: true };
    }
    if (matchesKey(data, Key.down)) {
      offset = Math.min(maxOffset(rowCount, MAX_ROWS - 2), offset + 1);
      return { consume: true };
    }
    if (matchesKey(data, Key.escape) || data === "q") {
      focused = false;
      offset = 0;
      return { consume: true };
    }
    focused = false;
    offset = 0;
    return undefined;
  };
  const installInput = (): void => {
    if (!showing || !__navigationForTests.enabled || inputUnsubscribe || !context?.hasUI) return;
    inputUnsubscribe = context.ui.onTerminalInput(handleInput);
  };


  /** Re-read one run's state. Called on events, never on the repaint timer. */
  const refresh = (runId: string, directory: string, runSessionId: string): void => {
    // A run filed under another session belongs to another window's widget.
    if (runSessionId !== sessionId() || receipted.has(runId)) return;
    const run = readRun(directory);
    if (!run) return;
    // A pending checkpoint is known only from events, so it has to survive a
    // re-read of the state file that knows nothing about it.
    const waiting = runs.get(runId)?.waiting;
    runs.set(runId, waiting ? { ...run, waiting } : run);
  };

  const receipt = (runId: string): void => {
    if (receipted.has(runId)) return;
    const current = runs.get(runId);
    if (!current) return;
    // Events are signals, not the receipt's data. Read the final atomic state
    // again so a completion event cannot capture the preceding running state.
    const persisted = readRun(current.directory);
    if (!persisted || !isRunTerminal(persisted.state)) return;
    const run = current.waiting ? { ...persisted, waiting: current.waiting } : persisted;
    receipted.add(runId);
    runs.delete(runId);
    seen.delete(runId);
    const failure = failureEvents.get(runId);
    failureEvents.delete(runId);
    // A foreground run already left its own summary in the transcript, put
    // there by the workflow tool call that waited for it. A second account of
    // the same run directly beneath the first is noise.
    if (run.delivery?.mode === "foreground") return;
    pi.appendEntry<Receipt>(ENTRY_TYPE, receiptFor(run, failure));
  };


  const paint = (): void => {
    if (!context?.hasUI) {
      hide();
      return;
    }
    if (renderFailed) {
      hide();
      return;
    }
    if (![...runs.values()].some((run) => isRunLive(run.state) && run.delivery?.mode !== "foreground")) {
      hide();
      return;
    }

    // Registered as a factory so the frame is built at the width the TUI is
    // about to draw with, read in the same pass that validates it. Reading the
    // terminal separately races a pane split: the frame is built at one width
    // and checked against another, and Pi treats an over-wide line as fatal
    // rather than wrapping it. Every row is clamped again on the way out, so
    // the worst case is a clipped row instead of a crashed session.
    // Below the editor, where a running job belongs: it is something to
    // glance down at, not something standing between the conversation and
    // the place you type.
    showing = true;
    context.ui.setWidget(
      KEY,
      (tui: TuiHandle, theme: Theme) => {
        // Held so the input handler can ask who owns the keyboard right now.
        host = tui;
        return {
          render: (width: number): string[] => {
            try {
              // The layout is composed against a floor of twenty columns, because
              // a tree drawn narrower than that is unreadable anyway — but what
              // leaves this function is measured against the width Pi actually
              // gave. A pane narrower than the floor gets a cut frame; it does
              // not get a crash, and pi-tui treats an over-wide line as fatal.
              const usable = Math.max(20, width);
              const frame = renderFrame([...runs.values()], Date.now(), usable, focused ? offset : 0, theme, focused, size);
              if (frame === undefined) {
                renderFailed = true;
                inputUnsubscribe?.();
                inputUnsubscribe = undefined;
                resetNavigation();
                return [];
              }
              // The keys track the body rows exactly, so they say how far the
              // cursor may travel — the lid and the floor are not rows to land on.
              rowCount = size.rows;
              offset = Math.min(offset, maxOffset(rowCount, MAX_ROWS - 2));
              return frame.map((line) =>
                visibleLength(line) > width ? truncate(line, width) : line,
              );
            } catch {
              renderFailed = true;
              inputUnsubscribe?.();
              inputUnsubscribe = undefined;
              resetNavigation();
              return [];
            }
          },
          invalidate: (): void => {
            // Nothing is cached between frames; every render reads current state.
          },
        };
      },
      { placement: "belowEditor" },
    );
    installInput();
  };

  /**
   * Re-read any run whose state file changed since the last look.
   *
   * Events cover agents and phases, but shell activity is written to the state
   * file without one: a phase running nothing but `shell` would sit unchanged
   * on screen until some unrelated event happened to arrive. A stat per live
   * run is cheap next to parsing one — the check costs a few microseconds and
   * only the changed file is read.
   */
  const rescan = (): void => {
    for (const [runId, run] of runs) {
      if (receipted.has(runId)) {
        runs.delete(runId);
        seen.delete(runId);
        continue;
      }
      try {
        const mtime = statSync(join(run.directory, "state.json")).mtimeMs;
        if (mtime === seen.get(runId)) continue;
        seen.set(runId, mtime);
        const fresh = readRun(run.directory);
        if (fresh) {
          runs.set(runId, run.waiting ? { ...fresh, waiting: run.waiting } : fresh);
          if (isRunTerminal(fresh.state) && !awaitingDedicatedReceipt.has(runId)) receipt(runId);
        }
      } catch {
        // The run's directory went away, or is mid-write. Keep what we have.
      }
    }
  };

  function tick(): void {
    try {
      rescan();
      paint();
    } catch {
      // A failed repaint is a skipped frame, never fatal: a widget that dies
      // quietly is indistinguishable from one that was never drawn.
      hide();
    }
  }

  // The transcript entry: appendEntry carries the data, this renders it. It
  // returns a plain component rather than importing pi-tui's Text, because
  // @earendil-works/pi-tui only resolves inside Pi's own module tree.
  pi.registerEntryRenderer<Receipt>(ENTRY_TYPE, (entry, options, theme) => {
    if (!entry.data) return undefined;
    const lines = renderReceipt(entry.data, options.expanded, theme);
    return {
      // The width has to be honoured here as much as in the widget: Pi treats
      // an over-wide line as fatal rather than wrapping it, and a receipt can
      // carry a long line — a toolbox listing, a failure message — that no
      // amount of care at build time can bound.
      render: (width: number): string[] =>
        lines.map((line) => (visibleLength(line) > width ? truncate(line, width) : line)),
      invalidate: (): undefined => undefined,
    };
  });

  const onRunEvent = (event: unknown, terminal = false, deferReceipt = false): void => {
    const { runId, runDirectory, sessionId: eventSession, error } = event as {
      runId?: string;
      runDirectory?: string;
      sessionId?: string;
      error?: { message?: unknown };
    };
    if (!runId || !runDirectory || !eventSession || eventSession !== sessionId()) return;
    if (receipted.has(runId)) return;
    if (deferReceipt) awaitingDedicatedReceipt.add(runId);
    if (terminal) awaitingDedicatedReceipt.delete(runId);
    if (typeof error?.message === "string") failureEvents.set(runId, { message: error.message });
    refresh(runId, runDirectory, eventSession);
    if (terminal) receipt(runId);
    tick();
  };

  /** Unsubscribe callbacks, so this instance can leave the bus as it found it. */
  const unsubscribes: (() => void)[] = [];

  for (const name of [
    WORKFLOW_RUN_STARTED_EVENT,
    WORKFLOW_AGENT_STATE_CHANGED_EVENT,
    WORKFLOW_PHASE_CHANGED_EVENT,
    WORKFLOW_BUDGET_EVENT,
  ]) {
    unsubscribes.push(pi.events.on(name, onRunEvent));
  }

  unsubscribes.push(pi.events.on(WORKFLOW_RUN_STATE_CHANGED_EVENT, (event: unknown) => {
    const state = (event as { state?: unknown }).state;
    onRunEvent(event, state === "stopped", state === "completed" || state === "failed");
  }));
  for (const name of [WORKFLOW_RUN_COMPLETED_EVENT, WORKFLOW_RUN_FAILED_EVENT]) {
    unsubscribes.push(pi.events.on(name, (event: unknown) => {
      onRunEvent(event, true);
    }));
  }
  unsubscribes.push(
    pi.events.on(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, (event: unknown) => {
      const { runId, runDirectory, sessionId: eventSession, name, state } = event as {
        runId?: string;
        runDirectory?: string;
        sessionId?: string;
        name?: string;
        state?: string;
      };
      if (!runId || !runDirectory || !eventSession || eventSession !== sessionId()) return;
      refresh(runId, runDirectory, eventSession);
      const run = runs.get(runId);
      if (!run) return;
      if (state === "awaiting") {
        runs.set(runId, { ...run, waiting: { name: name ?? "checkpoint", since: Date.now() } });
      } else {
        // Drop the key entirely rather than setting it undefined: the package
        // builds with exactOptionalPropertyTypes.
        const answered = { ...run };
        delete answered.waiting;
        runs.set(runId, answered);
      }
      tick();
    }),
  );


  const stop = (): void => {
    sessionGeneration += 1;
    if (timer) clearInterval(timer);
    timer = undefined;
    failureEvents.clear();
    hide();
    runs.clear();
    seen.clear();
    receipted.clear();
    awaitingDedicatedReceipt.clear();
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  };

  const reconcile = async (sessionContext: ExtensionContext, generation: number): Promise<void> => {
    if (typeof sessionContext.cwd !== "string" || !sessionContext.cwd) {
      if (generation === sessionGeneration) tick();
      return;
    }
    const currentSessionId = sessionContext.sessionManager.getSessionId();
    const runIds = await listRunIds(sessionContext.cwd, currentSessionId);
    if (generation !== sessionGeneration || context !== sessionContext) return;
    for (const runId of runIds) {
      if (generation !== sessionGeneration || context !== sessionContext) return;
      if (receipted.has(runId)) continue;
      const directory = new RunStore(sessionContext.cwd, currentSessionId, runId).directory;
      const run = readRun(directory);
      if (!run || run.sessionId !== currentSessionId || run.delivery?.mode === "foreground") continue;
      const waiting = runs.get(runId)?.waiting;
      runs.set(runId, waiting ? { ...run, waiting } : run);
      try { seen.set(runId, statSync(join(directory, "state.json")).mtimeMs); } catch { /* Retry on the next event if the state is mid-write. */ }
      if (isRunTerminal(run.state) && !awaitingDedicatedReceipt.has(runId)) receipt(runId);
    }
    if (generation === sessionGeneration) tick();
  };

  pi.on("session_start", (_event, sessionContext) => {
    context = sessionContext;
    const generation = ++sessionGeneration;
    hide();
    failureEvents.clear();
    runs.clear();
    seen.clear();
    receipted.clear();
    awaitingDedicatedReceipt.clear();
    try {
      for (const entry of sessionContext.sessionManager.getEntries()) {
        const custom = entry as { type?: string; customType?: string; data?: { runId?: string } };
        if (custom.type !== "custom" || custom.customType !== ENTRY_TYPE) continue;
        if (custom.data?.runId) receipted.add(custom.data.runId);
      }
    } catch {
      // No history to read; runs from this session on are recorded anyway.
    }

    if (!timer) {
      timer = setInterval(tick, REPAINT_MS);
      timer.unref();
    }

    tick();
    void reconcile(sessionContext, generation).catch(() => {
      if (generation === sessionGeneration) tick();
    });
  });

  // A way in that never competes. `↓` is the comfortable gesture but it is
  // shared with every picker; the shortcut answers whatever else is on screen,
  // and Pi lets it be rebound in `keybindings.json` like any other.
  if (__navigationForTests.enabled) pi.registerShortcut(FOCUS_SHORTCUT, {
    description: "Scroll the workflow widget",
    handler: () => {
      if (!showing || maxOffset(rowCount, MAX_ROWS - 2) === 0) {
        focused = false;
        offset = 0;
        return;
      }
      focused = !focused;
      offset = 0;
    },
  });

  pi.on("session_shutdown", stop);
}
