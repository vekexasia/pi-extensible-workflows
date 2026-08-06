/**
 * Live workflow widget: a tree of the runs happening right now, drawn above the
 * editor, and a durable receipt in the transcript once each one finishes.
 *
 * The split is deliberate. The widget answers "what is happening" and holds
 * nothing that has already happened — a finished run disappears from it at
 * once. The transcript entry answers "what did that cost and who did it", and
 * keeps the answer for the life of the session rather than for a minute.
 *
 * Run state arrives as workflow events; the numbers behind it (tokens, cost,
 * per-agent accounting) live only in the run's state.json, so an event is a
 * signal to re-read rather than the data itself. Between events nothing is
 * read: the repaint timer only turns the spinner and advances the clocks.
 */

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, Key, matchesKey } from "@earendil-works/pi-tui";
import type { AgentRecord, AgentState, RunRecord, RunState } from "pi-extensible-workflows";
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
const MAX_ROWS = 20;

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

const BLUE = "\x1b[38;2;77;163;255m";
const RED = "\x1b[38;2;235;87;87m";
const GREEN = "\x1b[38;2;95;186;125m";
const AMBER = "\x1b[38;2;222;158;65m";
const DIM = "\x1b[38;2;120;120;120m";
const RESET = "\x1b[0m";

/**
 * States that mean work is still happening, derived from the core's own lists
 * rather than restated here: a state the widget does not recognise reads as
 * finished, and the whole frame vanishes mid-run. Naming what is *over* rather
 * than what is live means a state added upstream is treated as live by default
 * — the safe direction, since drawing a finished run costs a stale row while
 * missing a live one loses the display entirely.
 */
const DONE_RUN = new Set<RunState>([
  "completed",
  "failed",
  "stopped",
  "interrupted",
  "budget_exhausted",
]);
const DONE_AGENT = new Set<AgentState>(["completed", "failed", "cancelled"]);

const isRunLive = (state: string | undefined): boolean =>
  state !== undefined && !DONE_RUN.has(state as RunState);
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
  name: string;
  state: string;
  model?: string;
  role?: string;
  requestedModel?: string;
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
function mark(state: string | undefined, now: number): string {
  if (isAgentLive(state) && isRunLive(state)) return `${BLUE}${spinner(now)}${RESET}`;
  if (state === "completed") return `${GREEN}✓${RESET}`;
  if (state === "failed" || state === "budget_exhausted") return `${RED}✗${RESET}`;
  return `${DIM}·${RESET}`;
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

/** Visible width, ignoring ANSI colour codes, so the border lines up. */
function visibleLength(text: string): number {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;]*m/g, "").length;
}

/**
 * Cuts a coloured line down to a visible width.
 *
 * Walks the string rather than slicing it: an escape sequence costs no columns
 * but plenty of characters, so a plain slice either cuts mid-escape — bleeding
 * colour into the border — or stops far short of the width it was given.
 */
function truncate(text: string, limit: number): string {
  let out = "";
  let visible = 0;
  let index = 0;
  while (index < text.length) {
    // eslint-disable-next-line no-control-regex
    const escape = /^\x1b\[[0-9;]*m/.exec(text.slice(index));
    if (escape?.[0]) {
      out += escape[0];
      index += escape[0].length;
      continue;
    }
    if (visible >= limit - 1) break;
    const character = text[index];
    if (character === undefined) break;
    out += character;
    visible += 1;
    index += 1;
  }
  return `${out}…${RESET}`;
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
    const state = JSON.parse(readFileSync(join(directory, "state.json"), "utf8")) as Partial<RunRecord>;
    return { ...state, directory, startedAt: statSync(directory).birthtimeMs };
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
function lastTranscriptWrite(run: Run): number | undefined {
  let newest: number | undefined;
  for (const session of run.agentSessions ?? []) {
    const locator = session.locator as { sessionFile?: string } | undefined;
    const file = locator?.sessionFile;
    if (!file) continue;
    try {
      const { mtimeMs } = statSync(file);
      if (newest === undefined || mtimeMs > newest) newest = mtimeMs;
    } catch {
      // The transcript moved or was cleaned up; other sessions may still answer.
    }
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
function agentSilentFor(agent: AgentRecord, run: Run, now: number): number | undefined {
  if (!isAgentLive(agent.state)) return undefined;
  const last = Math.max(agent.lastEventAt ?? 0, lastTranscriptWrite(run) ?? 0);
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
function phaseShellRow(run: Run, phaseIndex: number, now: number): string | undefined {
  const entry = run.activeShellsByPhase?.find((item) => item.phaseIndex === phaseIndex);
  const active = entry?.active ?? 0;
  if (active <= 0) return undefined;
  const startedAt = entry?.startedAt;
  if (startedAt === undefined || now - startedAt < SHELL_VISIBLE_MS) return undefined;
  const label = active === 1 ? "1 command" : `${String(active)} commands`;
  return `${label}${DIM} · ${formatElapsed(now - startedAt)}${RESET}`;
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
  return accounting.input + accounting.output + accounting.cacheWrite;
}

/** Phase names in the order they opened, with the agents that ran in each. */
function phaseSlices(run: Run): { phase: string; agents: readonly AgentRecord[] }[] {
  const history = run.phaseHistory ?? [];
  const agents = run.agents ?? [];
  return history.map((entry, index) => {
    const from = entry.afterAgent;
    const next = history[index + 1];
    const to = next ? next.afterAgent : agents.length;
    return { phase: entry.phase, agents: agents.slice(from, to) };
  });
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
  /** 2 = run header (never folded), 1 = live or failed, 0 = finished detail. */
  rank: number;
}

/**
 * Folds the least interesting rows away once the tree outgrows its budget,
 * leaving a marker in their place. Run headers always survive: losing one hides
 * a whole run rather than a detail of it.
 */
function collapse(rows: readonly Row[], budget: number): Row[] {
  if (rows.length <= budget) return [...rows];

  const keep = new Set<number>();
  for (const rank of [2, 1, 0]) {
    for (const [index, row] of rows.entries()) {
      if (row.rank === rank && keep.size < budget - 1) keep.add(index);
    }
  }

  const out: Row[] = [];
  let hidden = 0;
  for (const [index, row] of rows.entries()) {
    if (keep.has(index)) {
      out.push(row);
    } else {
      hidden += 1;
    }
  }
  if (hidden > 0) out.push({ rank: 0, text: `${DIM}… ${String(hidden)} more${RESET}` });
  return out;
}

/** The whole widget frame, or undefined when nothing is running. */
function renderFrame(runs: readonly Run[], now: number, width: number, cursor?: number, theme?: Theme): string[] | undefined {
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

  const rows: Row[] = [];
  for (const run of live) {
    const stats = [formatTokens(run.usage?.tokens), formatCost(run.usage?.costUsd)]
      .filter(Boolean)
      .join(" · ");
    const budget = budgetWarning(run);
    rows.push({
      rank: 2,
      text: `${mark(run.state, now)} ${run.workflowName ?? "workflow"}${
        budget ? `${AMBER}  ${budget}${RESET}` : ""
      }`,
      right: `${stats ? `${stats} · ` : ""}${formatElapsed(now - run.startedAt)}`,
    });

    // A checkpoint is the one thing here that a person has to act on, and it
    // only exists as an event: the run state on disk never mentions it.
    if (run.waiting) {
      rows.push({
        rank: 2,
        text: `  ${AMBER}◆${RESET} waiting: ${run.waiting.name}`,
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
      const phaseState = liveAgents ? "running" : failed ? "failed" : "completed";

      let cost = 0;
      let tokens = 0;
      for (const agent of slice.agents) {
        cost += agent.accounting?.cost ?? 0;
        tokens += agentTokens(agent);
      }
      const phaseStats = [formatTokens(tokens), formatCost(cost)].filter(Boolean).join(" · ");

      rows.push({
        rank: liveAgents || failed ? 1 : 0,
        text: `  ${last ? "╰─" : "├─"} ${mark(phaseState, now)} ${slice.phase}`,
        ...(phaseStats ? { right: phaseStats } : {}),
      });

      const stem = last ? "   " : "  │";

      // A phase running only shell commands has no agents under it, so without
      // this it reads as a name with nothing happening beneath it.
      const shell = phaseShellRow(run, index, now);
      if (shell) {
        rows.push({
          rank: 1,
          text: `${stem} ${slice.agents.length === 0 ? "╰─" : "├─"} ${mark("running", now)} ${shell}`,
        });
      }

      slice.agents.forEach((agent, agentIndex) => {
        const lastAgent = agentIndex === slice.agents.length - 1;
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

        const silent = agentSilentFor(agent, run, now);

        rows.push({
          rank: agentLive || agent.state === "failed" ? 1 : 0,
          text: `${stem} ${lastAgent ? "╰─" : "├─"} ${
            silent === undefined
              ? mark(agent.state, now)
              : `${silent >= STALL_MS ? RED : AMBER}⚠${RESET}`
          } ${agent.name}${
            silent === undefined
              ? ""
              : `${silent >= STALL_MS ? RED : AMBER}  ${
                  silent >= STALL_MS ? "stalled" : "quiet"
                } ${formatElapsed(silent)}${RESET}`
          }`,
          right: detail,
        });
      });
    });
  }

  const accent = BLUE;
  const title = live.length === 1 ? "Workflow" : `Workflows · ${String(live.length)} runs`;
  const body = collapse(rows, MAX_ROWS - 2);

  // Width budget: the rule takes a column and a space on each side, so the
  // text has four fewer than the widget is given. Every piece is measured
  // against `inner` so the right-hand rule lands in one column on every row.
  const inner = Math.max(20, width - 4);

  // The selected row is lit the way the rest of Pi lights a selection, from
  // the active theme rather than a colour picked here — a widget that invented
  // its own highlight would look wrong the moment the theme changed.
  //
  // The row is assembled from coloured pieces, each ending in a full reset, and
  // a full reset clears the background along with the foreground. Painted
  // naïvely, the highlight therefore survives only on the stretches with no
  // colour in them — the indent and the tree stem — and dies behind every piece
  // of text. Swapping the inner resets for a foreground-only reset keeps the
  // background alive across the whole row.
  const FG_RESET = "\u001b[39m";
  const highlight = (text: string): string =>
    theme ? theme.bg("selectedBg", text.replaceAll(RESET, FG_RESET)) : text;

  // Side rules only, no lid and no floor.
  //
  // The box is not a thing in its own right — it is a margin note against the
  // conversation, and two horizontal rules spend two of the few lines it is
  // worth to say so. The title rides the first row instead, where it is read
  // in the same glance as the run beneath it.
  const lines = body.map((row, index) => {
    const selected = index === cursor;
    // The numbers hold the right edge; the name gives way when the two would
    // meet. A truncated workflow name is still recognisable, where a truncated
    // cost is a different number.
    const right = row.right ?? "";
    const rightWidth = right === "" ? 0 : visibleLength(right) + 2;
    const room = Math.max(0, inner - rightWidth);
    const left = visibleLength(row.text) > room ? truncate(row.text, room) : row.text;
    const gap = Math.max(0, inner - visibleLength(left) - (right === "" ? 0 : visibleLength(right)));
    const text = right === "" ? left + " ".repeat(gap) : `${left}${" ".repeat(gap)}${DIM}${right}${RESET}`;
    const rule = `${accent}│${RESET}`;
    return selected ? `${rule}${highlight(` ${text} `)}${rule}` : `${rule} ${text} ${rule}`;
  });

  // The title carries the same colour as the rules it sits between: one mark
  // in the margin, not a heading competing with the runs under it. The way in
  // rides with it — a shortcut nobody can see is a shortcut nobody uses — and
  // gives way to the title if the terminal is too narrow for both.
  const hint = cursor === undefined ? `↓ or ${FOCUS_SHORTCUT}` : "↑↓ move · esc back";
  const room = inner - visibleLength(title);
  const withHint =
    room >= visibleLength(hint) + 2
      ? `${title}${" ".repeat(room - visibleLength(hint))}${hint}`
      : `${title}${" ".repeat(Math.max(0, room))}`;
  const heading = `${accent}│ ${withHint} │${RESET}`;
  return [heading, ...lines];
}

/** Everything worth keeping about a run once it is over. */
/**
 * How many tool calls an agent made, counted from its transcript.
 *
 * `toolCalls` on the agent record is empty on disk — it is filled in memory and
 * only persisted at moments that have usually passed by the time a run ends.
 * The transcript is the durable record: every turn is appended as it happens.
 */
function countToolCalls(run: Run, index: number): number | undefined {
  const session = (run.agentSessions ?? [])[index];
  const locator = session?.locator as { sessionFile?: string } | undefined;
  const file = locator?.sessionFile;
  if (!file) return undefined;
  try {
    let calls = 0;
    for (const line of readFileSync(file, "utf8").split("\n")) {
      if (line === "") continue;
      const entry = JSON.parse(line) as { type?: string; message?: { content?: readonly { type?: string }[] } };
      if (entry.type !== "message") continue;
      for (const part of entry.message?.content ?? []) if (part.type === "toolCall") calls += 1;
    }
    return calls;
  } catch {
    // The transcript was cleaned up, or is mid-write. A missing count is
    // better than a wrong one.
    return undefined;
  }
}

function receiptFor(run: Run): Receipt {
  const agents = run.agents ?? [];
  return {
    runId: run.id ?? "",
    workflow: run.workflowName ?? "workflow",
    state: run.state ?? "completed",
    costUsd: run.usage?.costUsd ?? 0,
    tokens: run.usage?.tokens ?? 0,
    durationMs: run.usage?.durationMs ?? 0,
    phases: (run.phaseHistory ?? []).map((entry) => entry.phase),
    // Agents carry no phase of their own; phaseHistory records how many had
    // finished when each phase opened, so these offsets are what tie them.
    phaseBoundaries: (run.phaseHistory ?? []).map((entry) => entry.afterAgent),
    agents: agents.map((agent, index) => {
      const calls = countToolCalls(run, index);
      return {
        name: agent.name,
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
        // What the agent actually did, not what it was allowed to do. The
        // permitted toolbox is a property of the role and says nothing about
        // this particular run; the number of calls says how hard it worked.
        ...(calls === undefined ? {} : { toolCalls: calls }),
        // Cache reads dwarf real input and cost almost nothing, so the split is
        // what explains a cheap run that looks enormous.
        input: agent.accounting?.input ?? 0,
        output: agent.accounting?.output ?? 0,
        cacheRead: agent.accounting?.cacheRead ?? 0,
        costUsd: agent.accounting?.cost ?? 0,
        durationMs: agent.durationMs ?? 0,
        attempts: agent.attempts,
      };
    }),
    ...(run.error?.message ? { error: run.error.message } : {}),
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
    agents.forEach((agent, agentIndex) => {
      const lastAgent = agentIndex === agents.length - 1;
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
        `${stem} ${lastAgent ? "╰─" : "├─"} ${glyph(agent.state)} ${agent.name} ${theme.fg("muted", detail)}`,
      );

      const under = `${stem} ${lastAgent ? "  " : "│ "}   `;
      const meta = [
        agent.role ? `role ${agent.role}` : "",
        agent.requestedModel && agent.requestedModel !== agent.model
          ? `via ${agent.requestedModel}`
          : "",
        agent.toolCalls === undefined
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

  /**
   * Whether the widget holds the keyboard, and which row is under the cursor.
   *
   * Focus is only taken deliberately — `↓` on an empty editor — and given back
   * the moment anything is typed. A widget that swallowed keys the rest of the
   * time would be a widget you had to fight to write past.
   */
  let focused = false;
  let cursor = 0;
  /** Rows in the last frame, so the cursor cannot leave it. */
  let rowCount = 0;
  /**
   * The TUI the widget was last built against, kept only to ask whether
   * something else currently owns the keyboard.
   */
  let host: TuiHandle | undefined;

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

  const sessionId = (): string | undefined => context?.sessionManager.getSessionId();

  /** Re-read one run's state. Called on events, never on the repaint timer. */
  const refresh = (runId: string, directory: string, runSessionId: string): void => {
    // A run filed under another session belongs to another window's widget.
    if (runSessionId !== sessionId()) return;
    const run = readRun(directory);
    if (!run) return;
    // A pending checkpoint is known only from events, so it has to survive a
    // re-read of the state file that knows nothing about it.
    const waiting = runs.get(runId)?.waiting;
    runs.set(runId, waiting ? { ...run, waiting } : run);
  };

  const receipt = (runId: string): void => {
    if (receipted.has(runId)) return;
    const run = runs.get(runId);
    if (!run) return;
    receipted.add(runId);
    runs.delete(runId);
    // A foreground run already left its own summary in the transcript, put
    // there by the workflow tool call that waited for it. A second account of
    // the same run directly beneath the first is noise.
    if (run.delivery?.mode === "foreground") return;
    pi.appendEntry<Receipt>(ENTRY_TYPE, receiptFor(run));
  };

  const paint = (): void => {
    if (!context?.hasUI) return;
    if (!renderFrame([...runs.values()], Date.now(), 80)) {
      if (showing) {
        context.ui.setWidget(KEY, undefined);
        showing = false;
      }
      return;
    }

    // Registered as a factory so the frame is built at the width the TUI is
    // about to draw with, read in the same pass that validates it. Reading the
    // terminal separately races a pane split: the frame is built at one width
    // and checked against another, and Pi treats an over-wide line as fatal
    // rather than wrapping it. Every row is clamped again on the way out, so
    // the worst case is a clipped row instead of a crashed session.
    context.ui.setWidget(
      KEY,
      (tui: TuiHandle, theme: Theme) => {
        // Held so the input handler can ask who owns the keyboard right now.
        host = tui;
        return {
          render: (width: number): string[] => {
            const usable = Math.max(20, width);
            const frame = renderFrame([...runs.values()], Date.now(), usable, focused ? cursor : undefined, theme) ?? [];
            rowCount = frame.length - 1;
            return frame.map((line) =>
              visibleLength(line) > usable ? truncate(line, usable) : line,
            );
          },
          invalidate: (): void => {
            // Nothing is cached between frames; every render reads current state.
          },
        };
      },
      // Below the editor, where a running job belongs: it is something to
      // glance down at, not something standing between the conversation and
      // the place you type.
      { placement: "belowEditor" },
    );
    showing = true;
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
      try {
        const mtime = statSync(join(run.directory, "state.json")).mtimeMs;
        if (mtime === seen.get(runId)) continue;
        seen.set(runId, mtime);
        const fresh = readRun(run.directory);
        if (fresh) runs.set(runId, run.waiting ? { ...fresh, waiting: run.waiting } : fresh);
      } catch {
        // The run's directory went away, or is mid-write. Keep what we have.
      }
    }
  };

  const tick = (): void => {
    try {
      rescan();
      paint();
    } catch {
      // A failed repaint is a skipped frame, never fatal: a widget that dies
      // quietly is indistinguishable from one that was never drawn.
      showing = false;
    }
  };

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

  const onRunEvent = (event: unknown): void => {
    const { runId, runDirectory, sessionId: eventSession } = event as {
      runId?: string;
      runDirectory?: string;
      sessionId?: string;
    };
    if (!runId || !runDirectory || !eventSession) return;
    refresh(runId, runDirectory, eventSession);
    tick();
  };

  /** Unsubscribe callbacks, so this instance can leave the bus as it found it. */
  const unsubscribes: (() => void)[] = [];

  for (const name of [
    WORKFLOW_RUN_STARTED_EVENT,
    WORKFLOW_RUN_STATE_CHANGED_EVENT,
    WORKFLOW_AGENT_STATE_CHANGED_EVENT,
    WORKFLOW_PHASE_CHANGED_EVENT,
    WORKFLOW_BUDGET_EVENT,
  ]) {
    unsubscribes.push(pi.events.on(name, onRunEvent));
  }

  unsubscribes.push(
    pi.events.on(WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, (event: unknown) => {
      const { runId, name, state } = event as {
        runId?: string;
        name?: string;
        state?: string;
      };
      if (!runId) return;
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

  for (const name of [WORKFLOW_RUN_COMPLETED_EVENT, WORKFLOW_RUN_FAILED_EVENT]) {
    unsubscribes.push(
      pi.events.on(name, (event: unknown) => {
        const { runId } = event as { runId?: string };
        onRunEvent(event);
        // The terminal state lands in state.json just after the event, so the
        // receipt is taken on the next tick rather than this one.
        if (runId) setTimeout(() => { receipt(runId); tick(); }, 100).unref();
      }),
    );
  }

  const stop = (): void => {
    if (timer) clearInterval(timer);
    timer = undefined;
    if (showing) context?.ui.setWidget(KEY, undefined);
    showing = false;
    focused = false;
    for (const unsubscribe of unsubscribes.splice(0)) unsubscribe();
  };


  pi.on("session_start", (_event, sessionContext) => {
    context = sessionContext;
    // The core drops every extension widget when a session starts or reloads,
    // so nothing of this instance is on screen at this point.
    showing = false;

    // Replay what the session already recorded so a reload cannot write the
    // same run into the transcript twice.
    receipted.clear();
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
      // Never hold the process open for the sake of a status line.
      timer.unref();
    }

    // Keyboard access, taken as lightly as possible.
    //
    // Keyboard access, taken as lightly as possible.
    //
    // The handler sees every keystroke before the editor does, so it declines
    // all but a few. `↓` on an empty editor is the natural way in — the same
    // gesture Claude Code uses for its agent dock — but an empty editor is also
    // what every picker and dialog leaves behind while it waits for arrows, so
    // the key is only claimed once the TUI confirms nothing else is focused.
    // The shortcut is the way in that never has to share.
    unsubscribes.push(
      sessionContext.ui.onTerminalInput((data: string) => {
        if (!showing) return undefined;

        if (focused) {
          // Something opened over the widget while it held the keyboard — a
          // command picker, a dialog. It has the better claim.
          if (somethingElseHasTheKeyboard()) {
            focused = false;
            return undefined;
          }
          // The tail of a keystroke already acted on. Swallow it so it cannot
          // reach the editor, but do not move twice for one press.
          if (isKeyRelease(data)) return { consume: true };
          if (matchesKey(data, Key.up)) {
            cursor = Math.max(0, cursor - 1);
            return { consume: true };
          }
          if (matchesKey(data, Key.down)) {
            cursor = Math.min(Math.max(0, rowCount - 1), cursor + 1);
            return { consume: true };
          }
          if (matchesKey(data, Key.escape) || data === "q") {
            focused = false;
            return { consume: true };
          }
          // Anything else is someone typing: hand the keyboard back and let
          // the keystroke through, so a thought is never lost to a panel.
          focused = false;
          return undefined;
        }

        if (isKeyRelease(data)) return undefined;
        if (!matchesKey(data, Key.down)) return undefined;
        // A menu is open, or focus has left the editor: the arrows are not
        // ours to take.
        if (somethingElseHasTheKeyboard()) return undefined;
        let empty = false;
        try {
          empty = sessionContext.ui.getEditorText().trim() === "";
        } catch {
          // No editor to consult; leave the key alone.
        }
        if (!empty) return undefined;
        focused = true;
        cursor = 0;
        return { consume: true };
      }),
    );

    tick();
  });

  // A way in that never competes. `↓` is the comfortable gesture but it is
  // shared with every picker; the shortcut answers whatever else is on screen,
  // and Pi lets it be rebound in `keybindings.json` like any other.
  pi.registerShortcut(FOCUS_SHORTCUT, {
    description: "Focus the workflow widget",
    handler: () => {
      if (!showing) return;
      focused = !focused;
      cursor = 0;
    },
  });

  pi.on("session_shutdown", stop);
}
