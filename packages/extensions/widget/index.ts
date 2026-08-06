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
  tools?: readonly string[];
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
 * The tools a role granted, as a line rather than a wall.
 *
 * A narrow role grants a handful and naming them is the point: it proves the
 * agent that was meant to only read could only read. An agent with no role
 * inherits the whole toolbox — sixty-odd names that say nothing and bury the
 * rest of the receipt under themselves.
 */
function toolSummary(tools: readonly string[]): string {
  const LISTED = 8;
  if (tools.length <= LISTED) return tools.join(" ");
  return `${tools.slice(0, LISTED).join(" ")} +${String(tools.length - LISTED)} more`;
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

interface Row {
  text: string;
  /** 2 = run header (never folded), 1 = live or failed, 0 = finished detail. */
  rank: number;
}

/**
 * Folds the least interesting rows away once the tree outgrows its budget,
 * leaving a marker in their place. Run headers always survive: losing one hides
 * a whole run rather than a detail of it.
 */
function collapse(rows: readonly Row[], budget: number): string[] {
  if (rows.length <= budget) return rows.map((row) => row.text);

  const keep = new Set<number>();
  for (const rank of [2, 1, 0]) {
    for (const [index, row] of rows.entries()) {
      if (row.rank === rank && keep.size < budget - 1) keep.add(index);
    }
  }

  const out: string[] = [];
  let hidden = 0;
  for (const [index, row] of rows.entries()) {
    if (keep.has(index)) {
      out.push(row.text);
    } else {
      hidden += 1;
    }
  }
  if (hidden > 0) out.push(`${DIM}… ${String(hidden)} more${RESET}`);
  return out;
}

/** The whole widget frame, or undefined when nothing is running. */
function renderFrame(runs: readonly Run[], now: number, width: number): string[] | undefined {
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
        stats ? `${DIM}  ${stats}${RESET}` : ""
      }${DIM} · ${formatElapsed(now - run.startedAt)}${RESET}${
        budget ? `${AMBER}  ${budget}${RESET}` : ""
      }`,
    });

    // A checkpoint is the one thing here that a person has to act on, and it
    // only exists as an event: the run state on disk never mentions it.
    if (run.waiting) {
      rows.push({
        rank: 2,
        text: `  ${AMBER}◆${RESET} waiting: ${run.waiting.name}${DIM} · ${formatElapsed(
          now - run.waiting.since,
        )}${RESET}`,
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
        text: `  ${last ? "╰─" : "├─"} ${mark(phaseState, now)} ${slice.phase}${
          phaseStats ? `${DIM}  ${phaseStats}${RESET}` : ""
        }`,
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
          } ${agent.name}${DIM}  ${detail}${RESET}${
            silent === undefined
              ? ""
              : `${silent >= STALL_MS ? RED : AMBER}  ${
                  silent >= STALL_MS ? "stalled" : "quiet"
                } ${formatElapsed(silent)}${RESET}`
          }`,
        });
      });
    });
  }

  const accent = BLUE;
  const title = live.length === 1 ? "Workflow" : `Workflows · ${String(live.length)} runs`;
  const body = collapse(rows, MAX_ROWS - 2);

  // Width budget: the border takes a column and a space on each side, so the
  // text has four fewer than the widget is given. Every piece is measured
  // against `inner` so the right-hand rule lands in one column on every row.
  const inner = Math.max(20, width - 4);
  const heading = ` ${title} `;
  const head = `${accent}╭${heading}${"─".repeat(Math.max(0, inner + 2 - heading.length))}╮${RESET}`;
  const foot = `${accent}╰${"─".repeat(inner + 2)}╯${RESET}`;
  const lines = body.map((text) => {
    const trimmed = visibleLength(text) > inner ? truncate(text, inner) : text;
    const pad = Math.max(0, inner - visibleLength(trimmed));
    return `${accent}│${RESET} ${trimmed}${" ".repeat(pad)} ${accent}│${RESET}`;
  });
  return [head, ...lines, foot];
}

/** Everything worth keeping about a run once it is over. */
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
    agents: agents.map((agent) => ({
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
      ...(agent.tools.length > 0 ? { tools: [...agent.tools] } : {}),
      // Cache reads dwarf real input and cost almost nothing, so the split is
      // what explains a cheap run that looks enormous.
      input: agent.accounting?.input ?? 0,
      output: agent.accounting?.output ?? 0,
      cacheRead: agent.accounting?.cacheRead ?? 0,
      costUsd: agent.accounting?.cost ?? 0,
      durationMs: agent.durationMs ?? 0,
      attempts: agent.attempts,
    })),
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
        agent.tools?.length ? toolSummary(agent.tools) : "",
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
      () => ({
        render: (width: number): string[] => {
          const usable = Math.max(20, width);
          const frame = renderFrame([...runs.values()], Date.now(), usable) ?? [];
          return frame.map((line) =>
            visibleLength(line) > usable ? truncate(line, usable) : line,
          );
        },
        invalidate: (): void => {
          // Nothing is cached between frames; every render reads current state.
        },
      }),
      { placement: "aboveEditor" },
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
    tick();
  });

  pi.on("session_shutdown", stop);
}
