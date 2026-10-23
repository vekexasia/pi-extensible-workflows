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
 * signal to re-read rather than the data itself. A slower rescan timer checks for
 * changed state files without reparsing unchanged runs.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { AgentRecord, RunRecord, RunState } from "./types.js";
import { listRunIds, RunStore } from "./persistence.js";
import { buildWorkflowPhaseModel, workflowPhaseTreePath } from "./host-phases.js";
import { agentIsLive, agentLastActivity, agentSilence } from "./agent-activity.js";
import type { SubagentRunRequest, SubagentStatus } from "../subagents/src/contracts.js";
import {
  BUDGET_DIMENSIONS,
  HARD_TERMINAL_RUN_STATES,
  SETTLED_AGENT_STATES,
  WORKFLOW_AGENT_STATE_CHANGED_EVENT,
  WORKFLOW_BUDGET_EVENT,
  WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT,
  WORKFLOW_PHASE_CHANGED_EVENT,
  WORKFLOW_RUN_COMPLETED_EVENT,
  WORKFLOW_RUN_FAILED_EVENT,
  WORKFLOW_RUN_STARTED_EVENT,
  WORKFLOW_RUN_STATE_CHANGED_EVENT,
} from "./types.js";
import { finiteNumber, object, sanitizeDisplayText } from "./utils.js";

export type BackgroundWidgetAPI = Pick<ExtensionAPI, "appendEntry" | "on"> & {
  events?: { on?: (name: string, handler: (event: unknown) => void) => () => void; emit?: ExtensionAPI["events"]["emit"] };
  registerEntryRenderer?: ExtensionAPI["registerEntryRenderer"];
  registerShortcut?: ExtensionAPI["registerShortcut"];
};

const KEY = "piewf-widget";
const ENTRY_TYPE = "piewf-run-receipt";

/**
 * The one tick: rescans the run files (shell-only activity has no event) and
 * turns the spinner and the clocks, while something is running or waiting.
 */
const TICK_MS = 1000;

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
 * How long a phase's shell commands must run before they are worth a row. A
 * phase built entirely of short commands would otherwise flicker a line in and
 * out; one that sits on a build or a test suite is exactly what you want to see.
 */
const SHELL_VISIBLE_MS = 5000;

/** Set on globalThis by the agents workspace loop (agents-command.ts) of any bundle while a workspace or its actions' dialogs are up. */
const AGENTS_WORKSPACE_LOOP = Symbol.for("pi-extensible-workflows.agents-workspace-loop");
/** The title row's hint at rest; Alt+O is the widget's only while a frame shows it. */
const SCROLL_HINT = "Alt+O to scroll";

/**
 * Whether the widget accepts the keyboard.
 *
 * Scrolling earns its keys: ten rows cannot hold five runs three phases deep,
 * and what gets folded away at rest is the widget's choice rather than the
 * reader's. `Alt+O` is the only way in — `↓` on an empty editor belongs
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
const isRunTerminal = (state: string | undefined): boolean =>
  state !== undefined && HARD_TERMINAL_RUN_STATES.has(state as RunState);
const isRunLive = (state: string | undefined): boolean =>
  state !== undefined && !isRunTerminal(state);

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
  // One glyph per tick: the widget repaints once a second, and so does the wheel.
  return SPINNER[Math.floor(now / TICK_MS) % SPINNER.length] ?? SPINNER[0];
}

/** Status mark for a finished-or-running unit of work. */
export function mark(state: string | undefined, now: number, paint: Paint, live = true): string {
  if (state === "running" && live) return paint(ROLE.live, spinner(now));
  if (state === "completed") return paint(ROLE.done, "✓");
  if (state === "failed" || state === "budget_exhausted") return paint(ROLE.failed, "✗");
  return paint(ROLE.quiet, "·");
}

export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

export function formatTokens(tokens: number | undefined): string {
  if (!tokens) return "";
  if (tokens < 1000) return `${String(tokens)}t`;
  const thousands = tokens / 1000;
  return `${thousands < 10 ? thousands.toFixed(1) : String(Math.round(thousands))}kt`;
}

export function formatCost(cost: number | undefined): string {
  if (!cost) return "";
  // Three decimals below a cent: at two, every cheap agent reads as $0.00 and
  // the per-agent column becomes a row of zeroes.
  return cost < 0.01 ? `$${cost.toFixed(3)}` : `$${cost.toFixed(2)}`;
}

/** A background subagent as the core host observes it: its latest status and the request that started it. */
export interface BackgroundSubagent { readonly status: Readonly<SubagentStatus>; readonly request: Readonly<SubagentRunRequest> }

/** Key of the Subagents group row, which is also the /agents workspace node it opens. */
const SUBAGENTS_KEY = "subagents";

/** A subagent's label as the subagents extension names it: the request's label, else the short id. */
export function subagentLabel(request: Readonly<Partial<SubagentRunRequest>>, id: string | undefined): string {
  if (typeof request.label === "string" && request.label.trim()) return request.label.trim();
  if (typeof id === "string" && id) return id.slice(0, 8);
  return "subagent";
}

/** The model a subagent runs on, with its thinking level. */
export function subagentModel(status: Readonly<SubagentStatus>): string {
  const model = status.progress?.state?.model ?? status.attemptDetails?.at(-1)?.setup.model;
  return model ? `${model.model}${model.thinking ? `:${model.thinking}` : ""}` : "";
}

/** One background subagent as a workflow agent row: a quiet or stalled warning on the left, model and figures against the right rule. */
function subagentRow({ status, request }: BackgroundSubagent, now: number, paint: Paint): { text: string; right: string; silent: boolean } {
  const silence = agentSilence(status.progress?.lastEventAt, now);
  const role = silence?.kind === "stalled" ? ROLE.failed : ROLE.warn;
  const icon = silence === undefined ? mark(status.state, now, paint) : paint(role, "⚠");
  const warning = silence === undefined ? "" : `  ${paint(role, `${silence.kind} ${formatElapsed(silence.ms)}`)}`;
  const accounting = status.progress?.accounting;
  const attempts = status.attempts ?? 1;
  const right = [
    subagentModel(status),
    formatTokens(accounting === undefined ? undefined : accounting.input + accounting.output),
    formatCost(accounting?.cost),
    status.startedAt === undefined ? "" : formatElapsed(now - status.startedAt),
    attempts > 1 ? `attempt ${String(attempts)}` : "",
  ].filter(Boolean).join(" · ");
  return { text: `${icon} ${sanitizeDisplayText(subagentLabel(request, status.id))}${warning}`, right, silent: silence !== undefined };
}

/** The subagents the widget draws: background ones of this session still running. A status without a session is kept. */
function backgroundSubagents(source: Iterable<BackgroundSubagent>, sessionId: string | undefined): BackgroundSubagent[] {
  return [...source].filter(({ status, request }) => request.mode === "background" && status.state === "running" && (status.sessionId === undefined || status.sessionId === sessionId));
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

function optionalNumber(value: unknown): boolean {
  return value === undefined || finiteNumber(value);
}

function renderableAgent(value: unknown): boolean {
  if (!object(value) || typeof value.name !== "string" || typeof value.state !== "string" || !object(value.model) || typeof value.model.model !== "string" || !Array.isArray(value.tools) || !value.tools.every((tool) => typeof tool === "string")) return false;
  if (value.model.thinking !== undefined && typeof value.model.thinking !== "string") return false;
  for (const key of ["id", "label", "parentId", "requestedModel"] as const) if (value[key] !== undefined && typeof value[key] !== "string") return false;
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
  if (usage !== undefined && (!object(usage) || !BUDGET_DIMENSIONS.every((key) => optionalNumber(usage[key])))) return false;
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

/** The phases a run declared at launch, read once per run directory. */
const declaredPhases = new Map<string, readonly string[]>();
function launchPhases(directory: string): readonly string[] {
  const known = declaredPhases.get(directory);
  if (known) return known;
  let phases: readonly string[] = [];
  try {
    const snapshot: unknown = JSON.parse(readFileSync(join(directory, "snapshot.json"), "utf8"));
    if (object(snapshot) && Array.isArray(snapshot.phases)) phases = snapshot.phases.filter((phase): phase is string => typeof phase === "string");
  } catch {
    // A run without a readable snapshot has no declared phases to number against.
  }
  declaredPhases.set(directory, phases);
  return phases;
}

/**
 * The workspace's tree-node id of each observed phase, in the order the run
 * entered them: the same model and path the /workflow tree is built from, so
 * a phase is named exactly as the workspace names it.
 */
function phaseNodeIds(run: Run): { history: (string | undefined)[]; unphased?: string } | undefined {
  try {
    const model = buildWorkflowPhaseModel({ state: run.state ?? "running", agents: run.agents ?? [], ...(run.phase === undefined ? {} : { phase: run.phase }), ...(run.phaseHistory === undefined ? {} : { phaseHistory: run.phaseHistory }), ...(run.activeShellsByPhase === undefined ? {} : { activeShellsByPhase: run.activeShellsByPhase }) }, launchPhases(run.directory));
    const ids = model.phases.filter((phase) => phase.observed && phase.id !== "preflight").map((phase) => workflowPhaseTreePath("phase", phase.id, []));
    // The model skips blank names and non-integer positions; the history index of each entry keeps its place, a skipped one has no node.
    let next = 0;
    const history = (run.phaseHistory ?? []).map((entry) => entry.phase.trim() === "" || !Number.isSafeInteger(entry.afterAgent) ? undefined : ids[next++]);
    // Agents before the first phase hang from the workspace's unassigned node; with no history the model files them under the current phase.
    const unphased = model.unassignedAgents?.length ? workflowPhaseTreePath("phase", "unassigned", []) : (run.phaseHistory ?? []).length === 0 ? ids[0] : undefined;
    return { history, ...(unphased === undefined ? {} : { unphased }) };
  } catch {
    return undefined;
  }
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
  requestRender?: () => void;
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
  /** The order rows are kept in at rest: 3 = a run header, 2 = something waiting on a person, 1 = live or failed work, 0 = finished detail. */
  rank: number;
  /** On a run header: its name, and the text it takes when another shown run shares the name. */
  named?: { name: string; withId: string };
  /** On the header of a run with a waiting checkpoint: its right-hand text when the checkpoint's own row is not drawn. */
  flagged?: string;
  /**
   * A stable name for a row, and the key of the row it hangs from. The cursor
   * walks the rows by key across repaints, and the rows kept at rest bring the
   * rows they hang from.
   */
  key?: string;
  parent?: string;
  /** The key of the /agents workspace node this row stands for; Enter opens the workspace there. */
  open?: string;
}

/** Cursor of scroll mode, as the frame needs it. */
interface Navigation {
  cursor: string | undefined;
  /** Where the cursor was, for when its row is gone. */
  index: number;
}

/** What the frame reports back to the key handler. */
interface FrameReport {
  /** Rows of the whole tree: what the scroll gate is measured against. */
  total: number;
  /** The rows drawn in scroll mode, in order. */
  list: { key: string | undefined; open: string | undefined }[];
  cursor: number;
  offset: number;
}

/**
 * Opens the /agents workspace from the widget. `available` says whether the
 * widget's context can (the TUI); `open` does it on
 * the node with the given key.
 */
export interface AgentsOpener {
  available(context: ExtensionContext): boolean;
  open(context: ExtensionContext, key: string): void;
}

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

/**
 * Fits the tree in the budget. Scrolling shows a window onto it. At rest one
 * pass by rank keeps run headers, then what waits on a person, then live and
 * failed work, then the rest, each row with the rows it hangs from; they are
 * drawn in tree order above one row counting what did not fit.
 */
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

  const indexOfKey = new Map<string, number>();
  for (const [index, row] of rows.entries()) if (row.key !== undefined) indexOfKey.set(row.key, index);
  const parentOf = (index: number): number | undefined => {
    const parent = rows[index]?.parent;
    return parent === undefined ? undefined : indexOfKey.get(parent);
  };
  // One row is left for the count.
  //NOTE: with more run headers than rows, the later runs are counted with the rest.
  const capacity = budget - 1;
  const keep = new Set<number>();
  // The sort is stable, so rows of one rank stay in tree order.
  const order = rows.map((row, index) => ({ rank: row.rank, index })).sort((a, b) => b.rank - a.rank);
  for (const { index } of order) {
    if (keep.size === capacity) break;
    if (keep.has(index)) continue;
    // A row comes with the rows it hangs from or not at all; those of a kept row are kept already.
    //NOTE: parent keys come from rows drawn earlier, so the chain cannot loop.
    const chain = [index];
    for (let at = parentOf(index); at !== undefined && !keep.has(at); at = parentOf(at)) chain.push(at);
    if (keep.size + chain.length > capacity) continue;
    for (const item of chain) keep.add(item);
  }
  // A header whose checkpoint row (the row after it) did not fit says the run is waiting, as the title counts it.
  const shown = rows.flatMap((row, index) => !keep.has(index) ? [] : row.flagged !== undefined && !keep.has(index + 1) ? [{ ...row, right: row.flagged }] : [row]);
  return [...shown, { rank: 0, text: paint(ROLE.quiet, `… ${String(rows.length - shown.length)} more`) }];
}

/**
 * Whether the tick turns a run: a spinner, a clock, or a state file a shell may write without an event. A paused run moves on its next event.
 * Any other run's clock is the runtime it recorded, as /agents shows it, so nothing in it waits for a tick.
 */
const runTicks = (run: Run): boolean =>
  run.state === "running" || run.state === "pausing" || run.state === "queued" || run.state === "awaiting_input" || run.waiting !== undefined;

/** The whole widget frame, or undefined when nothing is running. */
function renderFrame(runs: readonly Run[], now: number, width: number, startOffset = 0, theme?: Theme, scrolling = false, sizeOut: FrameReport = { total: 0, list: [], cursor: 0, offset: 0 }, nav: Navigation = { cursor: undefined, index: 0 }, canOpen = false, subagents: readonly BackgroundSubagent[] = []): string[] | undefined {
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
  if (live.length === 0 && subagents.length === 0) return undefined;

  const paint: Paint = (role, text) => (theme ? theme.fg(role, text) : text);
  // One stat per transcript per frame, not per agent per repaint.
  const mtimes = new Map<string, number | undefined>();

  const rows: Row[] = [];
  let waiting = 0;
  let quiet = 0;
  for (const run of live) {
    const stats = [formatTokens(run.usage?.tokens), formatCost(run.usage?.costUsd)]
      .filter(Boolean)
      .join(" · ");
    const budget = budgetWarning(run);
    const state = run.state ?? "unknown";
    const runKey = `run:${run.id ?? ""}`;
    // The spinner already says "running"; every other state needs its tag.
    const tag = state === "running" ? "" : `${paint(ROLE.quiet, `[${state}]`)} `;
    const name = sanitizeDisplayText(run.workflowName ?? "workflow");
    const agentList = run.agents ?? [];
    const headingWith = (label: string): string => [
      label,
      ...(run.phase ? [paint(ROLE.quiet, sanitizeDisplayText(run.phase))] : []),
      paint(ROLE.quiet, `${String(agentList.filter((agent) => SETTLED_AGENT_STATES.has(agent.state)).length)}/${String(agentList.length)}`),
    ].join(paint(ROLE.quiet, " · "));
    const headerText = (heading: string): string => `${mark(state, now, paint)} ${tag}${heading}${budget ? `  ${paint(ROLE.warn, budget)}` : ""}`;
    const elapsed = formatElapsed((runTicks(run) ? undefined : run.usage?.durationMs) ?? now - run.startedAt);
    rows.push({
      rank: 3,
      key: runKey,
      text: headerText(headingWith(name)),
      // The short id is added once the frame knows which runs are shown.
      ...(run.id ? { named: { name, withId: headerText(headingWith(`${name} ${paint(ROLE.quiet, run.id.slice(0, 8))}`)) } } : {}),
      // The right edge is never cut, so the mark goes there, in place of the
      // tokens and cost: the name still says which run, however narrow the frame.
      ...(run.waiting ? { flagged: `${paint(ROLE.warn, "◆ waiting")} · ${elapsed}` } : {}),
      right: `${stats ? `${stats} · ` : ""}${elapsed}`,
      open: runKey,
    });

    // A checkpoint is the one thing here that a person has to act on, and it
    // only exists as an event: the run state on disk never mentions it.
    if (run.waiting) {
      waiting += 1;
      rows.push({
        rank: 2,
        key: `${runKey}/waiting`,
        open: runKey,
        parent: runKey,
        text: `  ${paint(ROLE.warn, "◆")} waiting: ${run.waiting.name}`,
        right: formatElapsed(now - run.waiting.since),
      });
    }

    const slices = phaseSlices(run);
    // Targets are only followed while scrolling, so the phase model is not rebuilt on every repaint.
    const phaseIds = scrolling ? phaseNodeIds(run) : undefined;
    slices.forEach((slice, index) => {
      // A phase the workspace has no node for has no target; unphased agents fall back to the run when the model has no node for them.
      const nodeId = slice.phaseIndex === undefined ? phaseIds?.unphased : phaseIds?.history[slice.phaseIndex];
      const target = nodeId !== undefined ? `${runKey}:node:${nodeId}` : slice.phaseIndex === undefined ? runKey : undefined;
      const last = index === slices.length - 1;
      const liveAgents = slice.agents.some((agent) => agentIsLive(agent.state, run.state));
      const failed = slice.agents.some((agent) => agent.state === "failed");
      // A running shell keeps its phase running with no agent live, however briefly it has run.
      const phaseShells = slice.phaseIndex !== undefined && run.activeShellsByPhase?.some((entry) => entry.phaseIndex === slice.phaseIndex && entry.active > 0) === true;
      const phaseState = failed ? "failed" : liveAgents || (phaseShells && agentIsLive("running", run.state)) ? "running" : agentIsLive("running", run.state) ? "completed" : run.state;

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
        ...(target === undefined ? {} : { open: target }),
        parent: runKey,
        text: `  ${last ? "╰─" : "├─"} ${mark(phaseState, now, paint)} ${slice.phase}`,
        ...(phaseStats ? { right: phaseStats } : {}),
      });

      const stem = last ? "   " : "  │";

      // A phase running only shell commands has no agents under it, so without
      // this it reads as a name with nothing happening beneath it.
      const shell = slice.phaseIndex === undefined ? undefined : phaseShellRow(run, slice.phaseIndex, now);
      if (shell) {
        rows.push({
          rank: 1,
          key: `${phaseKey}/shell`,
          ...(target === undefined ? {} : { open: target }),
          parent: phaseKey,
          text: `${stem} ${slice.agents.length === 0 ? "╰─" : "├─"} ${mark("running", now, paint, agentIsLive("running", run.state))} ${shell.label}`,
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
        const agentLive = agentIsLive(agent.state, run.state);
        const attempts = agent.attempts;
        const detail = [
          `${agent.model.model}${agent.model.thinking ? `:${agent.model.thinking}` : ""}`,
          formatTokens(agentTokens(agent)),
          formatCost(agent.accounting?.cost),
          agentLive && agent.startedAt
            ? formatElapsed(now - agent.startedAt)
            : agent.durationMs === undefined ? "" : formatElapsed(agent.durationMs),
          // A retry doubles what the agent costs, and only the latest attempt
          // shows in the numbers beside it.
          attempts > 1 ? `attempt ${String(attempts)}` : "",
        ]
          .filter(Boolean)
          .join(" · ");

        const silence = agent.state === "running" && agentLive ? agentSilence(agentLastActivity(agent, mtimes), now) : undefined;
        const role = silence?.kind === "stalled" ? ROLE.failed : ROLE.warn;
        const kids = children.get(agent.id) ?? [];
        const agentKey = `${parentKey}/agent:${agent.id}`;

        if (silence !== undefined) quiet += 1;
        rows.push({
          rank: silence !== undefined ? 2 : agentLive || agent.state === "failed" ? 1 : 0,
          parent: parentKey,
          key: agentKey,
          open: `${runKey}:${agent.id}`,
          text: `${prefix}${lastAgent ? "╰─" : "├─"} ${

            silence === undefined
              ? mark(agent.state, now, paint, agentLive)
              : paint(role, "⚠")
          } ${
            // The label is what the workflow called this agent — `reviewer #2`,
            // `scout (api)` — preserving an explicit label when supplied.
            agent.label ?? agent.name
          }${
            silence === undefined
              ? ""
              : `  ${paint(role, `${silence.kind} ${formatElapsed(silence.ms)}`)}`
          }`,
          right: detail,
        });

        kids.forEach((child, childIndex) => {
          drawAgent(child, `${prefix}${lastAgent ? "  " : "│ "}`, childIndex === kids.length - 1, agentKey);
        });
      };

      roots.forEach((agent, agentIndex) => {
        drawAgent(agent, `${stem} `, agentIndex === roots.length - 1, phaseKey);
      });
    });
  }

  // Background subagents follow the runs as one group: its row stands for them as a run header does for its run, and
  // each subagent hangs from it like an agent from its phase.
  if (subagents.length > 0) {
    rows.push({
      rank: 3,
      key: SUBAGENTS_KEY,
      text: `${mark("running", now, paint)} Subagents`,
      open: SUBAGENTS_KEY,
    });
    subagents.forEach((entry, index) => {
      const last = index === subagents.length - 1;
      const row = subagentRow(entry, now, paint);
      if (row.silent) quiet += 1;
      const key = `subagent:${entry.status.id}`;
      rows.push({
        rank: row.silent ? 2 : 1,
        parent: SUBAGENTS_KEY,
        key,
        open: key,
        text: `  ${last ? "╰─" : "├─"} ${row.text}`,
        ...(row.right ? { right: row.right } : {}),
      });
    });
  }

  // The rules change colour while scrolling, so it is obvious at a glance that
  // the arrows are going here and not to the editor.
  let offset = startOffset;
  if (scrolling) {
    sizeOut.list = rows.map((row) => ({ key: row.key, open: row.open }));
    const found = sizeOut.list.findIndex((item) => item.key === nav.cursor && nav.cursor !== undefined);
    const at = Math.max(0, Math.min(found >= 0 ? found : nav.index, rows.length - 1));
    sizeOut.cursor = at;
    // The window follows the cursor: one row of it is the count of what lies past.
    const span = MAX_ROWS - 3;
    const limit = maxOffset(rows.length, MAX_ROWS - 2);
    offset = limit === 0 ? 0 : Math.min(limit, Math.max(0, Math.min(Math.max(offset, at - span + 1), at)));
    sizeOut.offset = offset;
  }
  const accent = (text: string): string => paint(scrolling ? ROLE.warn : ROLE.live, text);
  const attention = [
    ...(waiting > 0 ? [`◆ ${String(waiting)} waiting`] : []),
    ...(quiet > 0 ? [`⚠ ${String(quiet)} quiet`] : []),
  ];
  const heading = live.length === 1 && subagents.length === 0 ? "Workflow" : "Workflows";
  // Beside subagents a single run is counted too, so the title says what each part of the frame holds.
  const counts = [
    ...(live.length > 1 || (live.length === 1 && subagents.length > 0) ? [`${String(live.length)} ${live.length === 1 ? "run" : "runs"}`] : []),
    ...(subagents.length > 0 ? [`${String(subagents.length)} ${subagents.length === 1 ? "subagent" : "subagents"}`] : []),
  ];
  const withCount = [heading, ...counts, ...attention].join(" · ");
  // When the title is too long the run count goes before the counts that need a person.
  const withoutCount = [heading, ...attention].join(" · ");
  // Only advertise navigation when it can reveal hidden rows: a hint for keys
  // that do nothing is worse than no hint.
  const scrollHint = `↑↓ move · ${canOpen ? "enter open · " : ""}esc exit`;
  const hint = !__navigationForTests.enabled || (!scrolling && maxOffset(rows.length, MAX_ROWS - 2) === 0)
    ? ""
    // On a narrow pane the long hint would cost the frame name; the way out alone stays.
    : scrolling ? (width - 8 - visibleLength(scrollHint) >= visibleLength(heading) ? scrollHint : "esc exit") : SCROLL_HINT;
  // The hint's width is reserved before the counts: the title is cut to leave it.
  const room = Math.max(1, width - 8 - visibleLength(hint));
  const fullTitle = visibleLength(withCount) <= room ? withCount : withoutCount;
  const title = visibleLength(fullTitle) > room ? truncate(fullTitle, room) : fullTitle;
  sizeOut.total = rows.length;
  const collapsed = collapse(rows, MAX_ROWS - 2, paint, offset, scrolling);
  const shownNames = new Map<string, number>();
  for (const row of collapsed) if (row.named) shownNames.set(row.named.name, (shownNames.get(row.named.name) ?? 0) + 1);
  const cursorKey = scrolling ? sizeOut.list[sizeOut.cursor]?.key : undefined;
  // The row under the cursor is drawn on the theme's selection background.
  // Resets inside the row's own colours would end the background early, so it is set again after each.
  const cursorText = (text: string): string => {
    if (!theme) return text;
    const [open = "", close = ""] = theme.bg("selectedBg", "\u0000").split("\u0000");
    const kept = text.replaceAll("\u001b[0m", `\u001b[0m${open}`).replaceAll("\u001b[49m", `\u001b[49m${open}`);
    return `${open}${kept}${close}`;
  };
  const body = collapsed.map((row) => {
    const named = row.named && (shownNames.get(row.named.name) ?? 0) > 1 ? { ...row, text: row.named.withId } : row;
    return cursorKey !== undefined && row.key === cursorKey ? { ...named, text: cursorText(named.text) } : named;
  });

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

  return drawFrame(title, hint, body, width, paint, accent, scrollbar);
}

/** The box around the live rows under the editor. */
function drawFrame(title: string, hint: string, body: readonly Pick<Row, "text" | "right">[], width: number, paint: Paint, accent: (text: string) => string, scrollbar: (index: number) => string | undefined = () => undefined): string[] {
  // Width budget: the rule takes a column and a space on each side, so the
  // text has four fewer than the widget is given. Every piece is measured
  // against `inner` so the right-hand rule lands in one column on every row.
  const inner = Math.max(20, width - 4);

  // Side rules below the lid, and no floor: the box opens downward into the
  // editor rather than closing on itself, which is one more line kept for the
  // run.
  const lines = body.map((row, index) => {
    // The right text drops its leading fields whole until it fits beside the
    // whole name: a truncated cost is a different number, and a row of numbers
    // without a name does not say whose they are. The last field goes too when
    // it does not fit, so the name is cut only when it alone is wider than the
    // row. The waiting flag outlasts the clock after it, being the one thing
    // to act on.
    const flag = paint(ROLE.warn, "◆ waiting");
    const beside = inner - visibleLength(row.text) - 2;
    let fields = (row.right ?? "").split(" · ");
    while (fields.length > 1 && visibleLength(fields.join(" · ")) > beside) fields.splice(fields[0] === flag ? 1 : 0, 1);
    if (fields.length === 1 && fields[0] !== flag && visibleLength(fields.join(" · ")) > beside) fields = [];
    const right = fields.join(" · ");
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
      // Preserve explicit display labels.
      name: agent.label ?? agent.name,
      state: agent.state,
      // Show both model and thinking level.
      ...(agent.model.model
        ? {
            model: `${agent.model.model}${agent.model.thinking ? `:${agent.model.thinking}` : ""}`,
          }
        : {}),
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
  if (!expanded) return lines;
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
  if (data.runId) lines.push(theme.fg("muted", `   run ${data.runId}`));

  return lines;
}

export interface BackgroundWidgetController {
  /** A subagent status changed: the frame is drawn again when the background subagents shown changed. */
  subagentsChanged(): void;
}

/**
 * `subagents` reads the subagents the host observes; given it, the widget draws the background ones of the session as a
 * group after the runs.
 */
export default function widget(pi: BackgroundWidgetAPI, enabled = true, opener?: AgentsOpener, subagents?: () => Iterable<BackgroundSubagent>): BackgroundWidgetController {
  if (!enabled || typeof pi.registerEntryRenderer !== "function" || !pi.events || typeof pi.events.on !== "function") return { subagentsChanged() {} };
  const eventBus = pi.events;
  const subscribe = (name: string, handler: (event: unknown) => void): (() => void) => eventBus.on?.(name, handler) ?? (() => {});
  const registerEntryRenderer = pi.registerEntryRenderer;
  let context: ExtensionContext | undefined;
  const isTuiContext = (): boolean => context?.hasUI === true && context.mode === "tui";
  let rescanTimer: NodeJS.Timeout | undefined;
  let requestRender: (() => void) | undefined;
  /** Bumped by every change of data or navigation, so a render with nothing new returns the lines it kept. */
  let version = 0;
  /** True while a frame is on screen, so it is only cleared when there is one. */
  let showing = false;
  /** Whether the last frame drawn shows `Alt+O to scroll` whole: Alt+O is taken only then. */
  let hintShown = false;
  let renderFailed = false;

  /**
   * Whether the widget holds the keyboard, and which row is under the cursor.
   *
   * Focus is only taken deliberately — `↓` on an empty editor — and given back
   * the moment anything is typed. A widget that swallowed keys the rest of the
   * time would be a widget you had to fight to write past.
   */
  let focused = false;
  /** How far the window has been scrolled down the tree. */
  let offset = 0;
  /** Rows the tree had in the last frame, so scrolling cannot run off its end. */
  const size: FrameReport = { total: 0, list: [], cursor: 0, offset: 0 };
  /** The row under the cursor in scroll mode. */
  let cursorKey: string | undefined;
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
  /** The subagents drawn now; none without a reader. */
  const liveSubagents = (): BackgroundSubagent[] => subagents === undefined ? [] : backgroundSubagents(subagents(), sessionId());
  /** Scroll mode on or off, at the top of the tree; the next render draws it. */
  const setScroll = (on: boolean): void => {
    version += 1;
    focused = on;
    offset = 0;
    cursorKey = undefined;
    size.cursor = 0;
  };
  const resetNavigation = (): void => {
    setScroll(false);
    size.total = 0;
    size.list = [];
    host = undefined;
    hintShown = false;
  };
  const stopRescanTimer = (): void => {
    if (rescanTimer !== undefined) clearInterval(rescanTimer);
    rescanTimer = undefined;
  };
  const hide = (): void => {
    stopRescanTimer();
    requestRender = undefined;
    if (showing) {
      try { context?.ui.setWidget(KEY, undefined); } catch { /* A failed repaint is already being cleared. */ }
    }
    showing = false;
    renderFailed = false;
    inputUnsubscribe?.();
    inputUnsubscribe = undefined;
    resetNavigation();
  };
  /** Whether scroll mode has rows to reveal: the tree is taller than the frame and navigation is on. */
  const canScroll = (): boolean => showing && __navigationForTests.enabled && maxOffset(size.total, MAX_ROWS - 2) > 0;
  const moveCursor = (delta: number): void => {
    const next = Math.max(0, Math.min(size.list.length - 1, size.cursor + delta));
    cursorKey = size.list[next]?.key;
    size.cursor = next;
    requestRender?.();
  };
  const handleInput = (data: string): { consume?: boolean } | undefined => {
    if (!showing) return undefined;
    if (!focused) {
      // Taken here, ahead of the editor, because an editor that binds Alt+O itself
      // never hands it on; only while the hint promises it. It is no Pi shortcut,
      // which Pi's editor would take whether the hint shows or not.
      if (!matchesKey(data, "alt+o") || isKeyRelease(data) || !hintShown || somethingElseHasTheKeyboard()) return undefined;
      setScroll(true);
      requestRender?.();
      return { consume: true };
    }
    if (somethingElseHasTheKeyboard() || !canScroll()) {
      const other = somethingElseHasTheKeyboard();
      setScroll(false);
      // Alt+O says leave, and leaving is done here, so the editor never sees it; but it goes on to whatever else holds the keyboard, and so does any other key.
      return !other && matchesKey(data, "alt+o") && !isKeyRelease(data) ? { consume: true } : undefined;
    }
    if (isKeyRelease(data)) return { consume: true };
    const item = size.list[size.cursor];
    if (matchesKey(data, Key.up) || matchesKey(data, "k")) { moveCursor(-1); return { consume: true }; }
    if (matchesKey(data, Key.down) || matchesKey(data, "j")) { moveCursor(1); return { consume: true }; }
    if (matchesKey(data, Key.enter)) {
      // Nothing to open here: the key does nothing and the cursor stays.
      if (context === undefined || item?.open === undefined || !opener?.available(context)) return { consume: true };
      const target = context;
      setScroll(false);
      requestRender?.();
      opener.open(target, item.open);
      return { consume: true };
    }
    if (matchesKey(data, Key.escape) || matchesKey(data, "q") || matchesKey(data, "alt+o")) {
      setScroll(false);
      requestRender?.();
      return { consume: true };
    }
    setScroll(false);
    return undefined;
  };
  const installInput = (): void => {
    if (!showing || !__navigationForTests.enabled || inputUnsubscribe || !isTuiContext()) return;
    inputUnsubscribe = context?.ui.onTerminalInput(handleInput);
  };


  /** Re-read one run's state. Called on events; the tick only re-reads a file whose mtime moved. */
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
    if (!isTuiContext() || receipted.has(runId)) return;
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


  const hasVisibleRun = (): boolean => {
    for (const run of runs.values()) {
      if (isRunLive(run.state) && run.delivery?.mode !== "foreground") return true;
    }
    return liveSubagents().length > 0;
  };
  /** Whether the tick has anything to turn: a run runTicks turns, or a live subagent. */
  const needsTick = (): boolean => {
    for (const run of runs.values()) {
      if (run.delivery?.mode === "foreground") continue;
      if (runTicks(run)) return true;
    }
    return liveSubagents().length > 0;
  };
  const startTimer = (): void => {
    if (rescanTimer !== undefined) return;
    rescanTimer = setInterval(() => { tick(true); }, TICK_MS);
    rescanTimer.unref();
  };
  const startTimers = (): void => {
    if (!showing || !isTuiContext()) return;
    if (!needsTick()) {
      stopRescanTimer();
      return;
    }
    startTimer();
  };
  /**
   * Whether an agents workspace (/agents, /workflow or /subagents, from any bundle) holds the screen or its actions' dialogs:
   * the widget then takes its frame away, draws nothing, rescans nothing on the tick, and the tick looks again once a second.
   * A run event still reads its own run, so a run that settles meanwhile keeps its receipt.
   */
  const workspaceOpen = (): boolean => (globalThis as typeof globalThis & Record<symbol, true | undefined>)[AGENTS_WORKSPACE_LOOP] === true;
  const quietForWorkspace = (): boolean => {
    if (!workspaceOpen()) return false;
    if (showing) hide();
    if (isTuiContext()) startTimer();
    return true;
  };
  const paint = (stateChanged = false): void => {
    if (quietForWorkspace()) return;
    version += 1;
    if (!isTuiContext()) {
      hide();
      return;
    }
    if (renderFailed || !hasVisibleRun()) {
      hide();
      return;
    }
    if (showing) {
      startTimers();
      if (stateChanged) requestRender?.();
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
    try {
      context?.ui.setWidget(
        KEY,
        (tui: TuiHandle, theme: Theme) => {
          // Held so the input handler can ask who owns the keyboard right now.
          host = tui;
          requestRender = () => { version += 1; tui.requestRender?.(); };
          // Pi renders on every keystroke and streamed token; the frame only changes with the width, the data and the second its spinner and clocks show.
          let kept: { key: string; lines: string[] } | undefined;
          return {
            render: (width: number): string[] => {
              try {
                // A frame mounted before a workspace opened stays empty while it is up, even when nothing ticks.
                if (workspaceOpen()) return [];
                const now = Date.now();
                const canOpen = context !== undefined && opener?.available(context) === true;
                const key = `${String(width)}:${String(Math.floor(now / TICK_MS))}:${String(version)}:${String(canOpen)}`;
                if (kept?.key === key) return kept.lines;
                // The layout is composed against a floor of twenty columns, because
                // a tree drawn narrower than that is unreadable anyway — but what
                // leaves this function is measured against the width Pi actually
                // gave. A pane narrower than the floor gets a cut frame; it does
                // not get a crash, and pi-tui treats an over-wide line as fatal.
                const usable = Math.max(20, width);
                const frame = renderFrame([...runs.values()], now, usable, focused ? offset : 0, theme, focused, size, { cursor: cursorKey, index: size.cursor }, canOpen, liveSubagents());
                if (frame === undefined) {
                  renderFailed = true;
                  inputUnsubscribe?.();
                  inputUnsubscribe = undefined;
                  resetNavigation();
                  return [];
                }
                if (focused) { offset = size.offset; cursorKey = size.list[size.cursor]?.key; }
                const lines = frame.map((line) =>
                  visibleLength(line) > width ? truncate(line, width) : line,
                );
                // The title row leaves the hint out when it has no room for it, and a pane narrower than the frame cuts it.
                hintShown = lines[0]?.includes(SCROLL_HINT) === true;
                kept = { key, lines };
                return lines;
              } catch {
                renderFailed = true;
                inputUnsubscribe?.();
                inputUnsubscribe = undefined;
                resetNavigation();
                return [];
              }
            },
            invalidate: (): void => {
              // A new theme draws the next frame afresh.
              kept = undefined;
            },
          };
        },
        { placement: "belowEditor" },
      );
      installInput();
      startTimers();
    } catch {
      hide();
    }
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
  const rescan = (): boolean => {
    let changed = false;
    for (const [runId, run] of runs) {
      if (receipted.has(runId)) {
        runs.delete(runId);
        seen.delete(runId);
        changed = true;
        continue;
      }
      try {
        const mtime = statSync(join(run.directory, "state.json")).mtimeMs;
        if (mtime === seen.get(runId)) continue;
        seen.set(runId, mtime);
        const fresh = readRun(run.directory);
        if (fresh) {
          runs.set(runId, run.waiting ? { ...fresh, waiting: run.waiting } : fresh);
          changed = true;
          if (isRunTerminal(fresh.state) && !awaitingDedicatedReceipt.has(runId)) receipt(runId);
        }
      } catch {
        // The run's directory went away, or is mid-write. Keep what we have.
      }
    }
    return changed;
  };

  function tick(stateChanged = false): void {
    try {
      if (quietForWorkspace()) return;
      const rescanned = rescan();
      paint(stateChanged || rescanned);
    } catch {
      // A failed repaint is a skipped frame, never fatal: a widget that dies
      // quietly is indistinguishable from one that was never drawn.
      hide();
    }
  }

  // The transcript entry: appendEntry carries the data, this renders it. It
  // returns a plain component rather than importing pi-tui's Text, because
  // @earendil-works/pi-tui only resolves inside Pi's own module tree.
  registerEntryRenderer<Receipt>(ENTRY_TYPE, (entry, options, theme) => {
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
    if (!isTuiContext() || !runId || !runDirectory || !eventSession || eventSession !== sessionId()) return;
    if (receipted.has(runId)) return;
    if (deferReceipt) awaitingDedicatedReceipt.add(runId);
    if (terminal) awaitingDedicatedReceipt.delete(runId);
    if (typeof error?.message === "string") failureEvents.set(runId, { message: error.message });
    refresh(runId, runDirectory, eventSession);
    if (terminal) receipt(runId);
    tick(true);
  };

  /** Unsubscribe callbacks, so this instance can leave the bus as it found it. */
  const unsubscribes: (() => void)[] = [];

  for (const name of [
    WORKFLOW_RUN_STARTED_EVENT,
    WORKFLOW_AGENT_STATE_CHANGED_EVENT,
    WORKFLOW_PHASE_CHANGED_EVENT,
    WORKFLOW_BUDGET_EVENT,
  ]) {
    unsubscribes.push(subscribe(name, onRunEvent));
  }

  unsubscribes.push(subscribe(WORKFLOW_RUN_STATE_CHANGED_EVENT, (event: unknown) => {
    const state = (event as { state?: unknown }).state;
    onRunEvent(event, state === "stopped", state === "completed" || state === "failed");
  }));
  for (const name of [WORKFLOW_RUN_COMPLETED_EVENT, WORKFLOW_RUN_FAILED_EVENT]) {
    unsubscribes.push(subscribe(name, (event: unknown) => {
      onRunEvent(event, true);
    }));
  }
  unsubscribes.push(
    subscribe(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, (event: unknown) => {
      const { runId, runDirectory, sessionId: eventSession, name, state } = event as {
        runId?: string;
        runDirectory?: string;
        sessionId?: string;
        name?: string;
        state?: string;
      };
      if (!isTuiContext() || !runId || !runDirectory || !eventSession || eventSession !== sessionId()) return;
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
      tick(true);
    }),
  );

  const stop = (): void => {
    sessionGeneration += 1;
    failureEvents.clear();
    hide();
    context = undefined;
    runs.clear();
    declaredPhases.clear();
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
    declaredPhases.clear();
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
    if (!isTuiContext()) return;
    tick();
    void reconcile(sessionContext, generation).catch(() => {
      if (generation === sessionGeneration) tick();
    });
  });

  pi.on("session_shutdown", stop);
  /** Id and state of this session's background subagents last drawn: progress repaints nothing, the tick moves their clocks and counts. */
  let subagentSignature = "";
  // A subagent change needs no rescan of the run files, only a repaint when the subagents shown changed.
  const subagentsChanged = (): void => {
    const signature = liveSubagents().map(({ status }) => `${status.id}:${status.state}`).join("\n");
    if (showing && signature === subagentSignature) return;
    subagentSignature = signature;
    try { paint(true); } catch { hide(); }
  };
  return { subagentsChanged };
}
