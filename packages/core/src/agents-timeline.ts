import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { formatWorkflowRuntime, progressStyleForState, runStateGlyph, type WorkflowProgressStyles } from "./host-view.js";
import { speedStats, speedTps, speedTtftMs } from "./agent-speed.js";
import type { AgentSpeed } from "./types.js";
import { sanitizeDisplayText } from "./utils.js";

/** One row of the timeline: times in ms; an entry without a start has not begun. */
export interface AgentsTimelineEntry {
  readonly label: string;
  readonly group?: string;
  readonly startedAt?: number | undefined;
  readonly endedAt?: number | undefined;
  readonly state: string;
  /** The agent's counted speed; its row shows it when there is room. */
  readonly speed?: AgentSpeed | undefined;
}

/** States that are still going: their bar grows to now. */
const ACTIVE = new Set(["running", "waiting_for_child", "retrying", "paused"]);
const SPINNER = "⠦";
const MIN_BAR = 10;
const MIN_LABEL = 6;
const MAX_GROUP = 14;
const AGENT_GLYPH: Readonly<Record<string, string>> = { queued: "○", waiting_for_child: "…", retrying: "↻", cancelled: "✗" };

function glyph(state: string): string { return state === "running" ? SPINNER : AGENT_GLYPH[state] ?? runStateGlyph(state, SPINNER); }
function pad(text: string, width: number): string { return truncateToWidth(text, width, "…", true); }
/** The bar of [start, end] on a scale of `span` ms over `columns` columns, in whole cells; a started entry draws at least one. */
function bar(start: number, end: number, span: number, columns: number): string {
  const first = Math.min(columns - 1, Math.round((start / span) * columns));
  const last = Math.max(first + 1, Math.min(columns, Math.round((end / span) * columns)));
  return `${" ".repeat(first)}${"█".repeat(last - first)}${" ".repeat(columns - last)}`;
}

/** The speed segments of one row, widest first: tok/s, TTFT and tokens in generation time; tok/s is left out under 250 ms of generation. */
function speedTiers(speed: AgentSpeed | undefined): readonly [string, string, string] {
  if (speed === undefined) return ["", "", ""];
  const tps = speedTps(speed), ttft = `TTFT ${String(Math.round(speedTtftMs(speed)))} ms`;
  const rate = tps === undefined ? [] : [`${tps.toFixed(1)} tok/s`];
  return [[...rate, ttft, speedStats(speed)].join(" · "), [...rate, ttft].join(" · "), rate.join(" · ")];
}

/** The Gantt rows of `entries` on one scale, each at most `width` columns wide. */
export function formatAgentsTimeline(entries: readonly AgentsTimelineEntry[], now: number, width: number, styles: WorkflowProgressStyles): string[] {
  // An entry without a finite start has not begun; a missing or non-finite end falls back to now (running) or the start.
  const startOf = (entry: AgentsTimelineEntry): number | undefined => entry.startedAt !== undefined && Number.isFinite(entry.startedAt) ? entry.startedAt : undefined;
  const endOf = (entry: AgentsTimelineEntry, start: number): number => entry.endedAt !== undefined && Number.isFinite(entry.endedAt) ? Math.max(start, entry.endedAt) : ACTIVE.has(entry.state) ? Math.max(start, now) : start;
  const spans = entries.flatMap((entry) => { const start = startOf(entry); return start === undefined ? [] : [{ start, end: endOf(entry, start) }]; });
  const origin = spans.reduce((least, { start }) => Math.min(least, start), Infinity);
  const span = spans.length === 0 ? 1 : Math.max(1, spans.reduce((most, { end }) => Math.max(most, end), -Infinity) - origin);
  const header = truncateToWidth(`${styles.bold("Timeline")}  ${styles.dim(`0s ── ${spans.length ? formatWorkflowRuntime(span) : "–"}`)}`, width, "");
  const rows = entries.map((entry, index) => {
    const started = startOf(entry);
    const bounds = started === undefined ? undefined : { started, end: endOf(entry, started) };
    return {
      label: sanitizeDisplayText(entry.label),
      group: entry.group !== undefined && entry.group !== entries[index - 1]?.group ? sanitizeDisplayText(entry.group) : "",
      bounds,
      duration: bounds === undefined ? "" : formatWorkflowRuntime(bounds.end - bounds.started),
      state: entry.state,
      speeds: speedTiers(entry.speed),
    };
  });
  const groupWidth = Math.min(MAX_GROUP, Math.max(0, ...rows.map((row) => visibleWidth(row.group))), Math.max(0, Math.floor(width / 4)));
  const groupColumn = groupWidth ? groupWidth + 1 : 0;
  const barsTail = Math.max(0, ...rows.map((row) => visibleWidth(row.duration))) + 2;
  const labelWidth = Math.max(0, ...rows.map((row) => visibleWidth(row.label)));
  const roomWith = (tail: number): number => width - groupColumn - tail - 1 - MIN_BAR - 1;
  const withBars = roomWith(barsTail) >= Math.min(labelWidth, MIN_LABEL);
  // One tier for the whole timeline: the widest whose column keeps the bars; none otherwise.
  const tierWidths = [0, 1, 2].map((tier) => Math.max(0, ...rows.map((row) => visibleWidth(row.speeds[tier] ?? ""))));
  const speedTier = tierWidths.findIndex((column) => column > 0 && roomWith(barsTail + column + 1) >= Math.min(labelWidth, MIN_LABEL));
  const speedWidth = tierWidths[speedTier] ?? 0;
  const speedColumn = withBars && speedWidth > 0 ? speedWidth + 1 : 0;
  const room = roomWith(barsTail + speedColumn);
  // A row without a start says so: "queued" only for a queued entry, "not started" for any other state (a cancelled pending agent).
  const unstarted = (state: string): string => state === "queued" ? "○ queued" : "not started";
  // Without bars that word takes the duration slot.
  if (!withBars) for (const row of rows) if (row.bounds === undefined) row.duration = unstarted(row.state);
  const durationWidth = Math.max(0, ...rows.map((row) => visibleWidth(row.duration)));
  const tail = durationWidth + 2 + speedColumn;
  const label = withBars ? Math.min(labelWidth, room) : Math.max(0, Math.min(labelWidth, width - groupColumn - tail - 1));
  const barWidth = width - groupColumn - label - 1 - tail - 1;
  return [header, ...rows.map((row) => {
    // A stopped agent's glyph is ✗: the dashboards draw a stopped run in the error style.
    const paint = row.state === "stopped" ? (text: string) => styles.error(text) : progressStyleForState(row.state, styles);
    const queued = row.state === "queued" && row.bounds === undefined;
    const middle = withBars ? ` ${row.bounds === undefined ? pad(paint(unstarted(row.state)), barWidth) : paint(bar(row.bounds.started - origin, row.bounds.end - origin, span, barWidth))}` : "";
    const head = `${groupColumn ? `${styles.dim(pad(row.group, groupWidth))} ` : ""}${pad(row.label, label)}${middle}`;
    const end = `${speedColumn ? ` ${styles.dim(pad(row.speeds[speedTier] ?? "", speedWidth))}` : ""} ${styles.dim(row.duration.padStart(durationWidth))} ${queued ? " " : paint(glyph(row.state))}`;
    // The label and bar give way first: the duration and glyph are cut only when they alone exceed the width.
    return truncateToWidth(`${pad(head, Math.max(0, width - visibleWidth(end)))}${end}`, width, "");
  })];
}
