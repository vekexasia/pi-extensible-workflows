import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { formatAgentsTimeline, type AgentsTimelineEntry } from "../src/agents-timeline.js";
import { PLAIN_WORKFLOW_PROGRESS_STYLES as PLAIN } from "../src/index.js";

const entries: AgentsTimelineEntry[] = [
  { label: "alpha", group: "build", startedAt: 0, endedAt: 10_000, state: "completed" },
  { label: "beta-with-a-long-label", group: "build", startedAt: 5_000, endedAt: 20_000, state: "failed" },
  { label: "gamma", group: "ship", startedAt: 10_000, state: "running" },
  { label: "delta", group: "ship", state: "queued" },
];

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");

void test("one scale, header, group on its first row", () => {
  const rows = formatAgentsTimeline(entries, 40_000, 100, PLAIN);
  assert.equal(rows[0], "Timeline  0s ── 40s");
  assert.match(rows[1] ?? "", /^build\s+alpha/);
  assert.doesNotMatch(rows[2] ?? "", /build/);
  assert.match(rows[3] ?? "", /^ship\s+gamma/);
  assert.doesNotMatch(rows[4] ?? "", /ship/);
  assert.match(rows[4] ?? "", /○ queued/);
  assert.doesNotMatch(rows[4] ?? "", /█/);
  assert.match(rows[1] ?? "", /10s ✓$/);
  assert.match(rows[2] ?? "", /15s ✗$/);
});

void test("a short agent still draws one cell", () => {
  const [, row, full] = formatAgentsTimeline([{ label: "a", startedAt: 0, endedAt: 1, state: "completed" }, { label: "b", startedAt: 0, endedAt: 80, state: "completed" }], 80, 40, PLAIN);
  assert.match(row ?? "", /^a █ +\S/);
  assert.match(full ?? "", /^b █{10,} \S/);
});

void test("a bar covers the cells from its start to its end", () => {
  const [, late, full] = formatAgentsTimeline([{ label: "a", startedAt: 40, endedAt: 80, state: "completed" }, { label: "b", startedAt: 0, endedAt: 80, state: "completed" }], 80, 40, PLAIN);
  const cells = (row: string | undefined): number => (row?.match(/█/g) ?? []).length;
  assert.match(late ?? "", /^a {5,}█{5,} \S/);
  assert.ok(Math.abs(2 * cells(late) - cells(full)) <= 1);
});

void test("running entries grow with now", () => {
  // The finished entry shrinks against a scale that follows the running one.
  const count = (now: number): number => (formatAgentsTimeline([{ label: "a", startedAt: 0, state: "running" }, { label: "b", startedAt: 0, endedAt: 100, state: "completed" }], now, 80, PLAIN)[2]?.match(/█/g) ?? []).length;
  assert.ok(count(400) < count(200));
  assert.equal(formatAgentsTimeline([{ label: "a", startedAt: 0, state: "running" }], 5000, 60, PLAIN)[0], "Timeline  0s ── 5s");
  assert.match(formatAgentsTimeline([{ label: "a", startedAt: 0, state: "running" }], 3000, 60, PLAIN)[1] ?? "", /3s ⠦$/);
});

void test("all queued has no scale and no bars", () => {
  const rows = formatAgentsTimeline([{ label: "a", state: "queued" }], 5, 60, PLAIN);
  assert.equal(rows[0], "Timeline  0s ── –");
  assert.match(rows[1] ?? "", /○ queued/);
});

void test("every row fits at 120, 70 and 40 columns", () => {
  for (const width of [120, 70, 40, 20]) {
    const rows = formatAgentsTimeline(entries, 40_000, width, PLAIN);
    for (const row of rows) assert.ok(visibleWidth(row) <= width, `${String(width)}: ${row}`);
    assert.ok(rows.slice(1, 3).every((row) => /\d+s [✓✗]$/.test(row)), `${String(width)} keeps duration and glyph`);
  }
  const beta = (width: number): string => formatAgentsTimeline(entries, 40_000, width, PLAIN)[2] ?? "";
  // The bar is what lies between the label and " <duration> <glyph>", less the two separating spaces.
  const barOf = (row: string, label: string): number => {
    const plain = row.replace(ANSI, "");
    return plain.slice(plain.indexOf(label) + label.length, plain.search(/ \d+s [✓✗]$/)).length - 1;
  };
  assert.ok(beta(40).includes("…"), "the label truncates first");
  assert.ok(barOf(beta(40), "…") >= 10, "the bar keeps ten columns");
  for (const width of [70, 120]) assert.ok(beta(width).includes("beta-with-a-long-label"), String(width));
  assert.ok(barOf(beta(70), "beta-with-a-long-label") > 10 && barOf(beta(120), "beta-with-a-long-label") > barOf(beta(70), "beta-with-a-long-label"));
});

void test("below ten bar columns the bars are dropped", () => {
  const rows = formatAgentsTimeline(entries, 40_000, 24, PLAIN);
  assert.ok(rows.slice(1).every((row) => !/█/.test(row)));
  assert.match(rows[1] ?? "", /alpha.*10s ✓$/);
});

void test("waiting and retrying entries grow with now", () => {
  for (const state of ["waiting_for_child", "retrying", "paused"]) {
    const rows = formatAgentsTimeline([{ label: "a", startedAt: 0, state }], 60_000, 60, PLAIN);
    assert.doesNotMatch(rows[0] ?? "", /── 0s$/);
    assert.match(rows[1] ?? "", /█{10,}/);
  }
});

void test("a queued row stays readable when the bars are dropped", () => {
  const rows = formatAgentsTimeline([{ label: "delta", state: "queued" }, { label: "alpha", startedAt: 0, endedAt: 10, state: "completed" }], 10, 20, PLAIN);
  assert.match((rows[1] ?? "").trimEnd(), /○ queued$/);
  assert.ok(rows.every((row) => row.length <= 20));
});

void test("an entry that never started reads as queued only when it is queued", () => {
  const never = [{ label: "never", state: "cancelled" }, { label: "lost", state: "failed" }, { label: "alpha", startedAt: 0, endedAt: 10_000, state: "completed" }];
  for (const width of [80, 20]) {
    const rows = formatAgentsTimeline(never, 10_000, width, PLAIN);
    for (const row of rows.slice(1, 3)) {
      assert.match(row, /not started/, `${String(width)}: ${row}`);
      assert.doesNotMatch(row, /queued/, `${String(width)}: ${row}`);
      assert.match(row, /✗$/, `${String(width)}: ${row}`);
      assert.ok(visibleWidth(row) <= width, `${String(width)}: ${row}`);
    }
  }
});

void test("a stopped entry is drawn in the error style of a stopped run", () => {
  const tagged = { ...PLAIN, error: (text: string) => `<error>${text}</error>`, muted: (text: string) => `<muted>${text}</muted>` };
  for (const width of [120, 70, 40]) {
    const rows = formatAgentsTimeline([{ label: "alpha", startedAt: 0, endedAt: 10_000, state: "stopped" }], 10_000, width, tagged);
    assert.match(rows[1] ?? "", /<error>✗<\/error>/, `${String(width)}: ${rows[1] ?? ""}`);
    assert.doesNotMatch(rows[1] ?? "", /<muted>/);
    assert.ok(visibleWidth(rows[1] ?? "") <= width);
  }
});

const FIGURES = { messages: 2, outputTokens: 12_345, generationMs: 291_000, firstTokenMs: 1_624 };
const withSpeed = (speed: AgentsTimelineEntry["speed"]): AgentsTimelineEntry[] => entries.map((entry, index) => index === 0 ? { ...entry, speed } : entry);

void test("without any speed the rows are unchanged", () => {
  assert.deepEqual(formatAgentsTimeline(withSpeed(undefined), 40_000, 100, PLAIN), formatAgentsTimeline(entries, 40_000, 100, PLAIN));
});

void test("the widest speed segment that keeps the bars goes between the bar and the duration, other rows pad blank", () => {
  const rows = formatAgentsTimeline(withSpeed(FIGURES), 40_000, 120, PLAIN);
  assert.match(rows[1] ?? "", /█ +42\.4 tok\/s · TTFT 812 ms · 12345 tok in 291\.0s +10s ✓$/);
  assert.match(rows[2] ?? "", /█ {40,}15s ✗$/);
  const mid = formatAgentsTimeline(withSpeed(FIGURES), 40_000, 70, PLAIN)[1] ?? "";
  assert.match(mid, /42\.4 tok\/s · TTFT 812 ms +10s ✓$/);
  assert.doesNotMatch(mid, / tok in /);
  const short = formatAgentsTimeline(withSpeed(FIGURES), 40_000, 50, PLAIN)[1] ?? "";
  assert.match(short, /█ +42\.4 tok\/s +10s ✓$/);
  assert.doesNotMatch(short, /TTFT/);
  assert.doesNotMatch(formatAgentsTimeline(withSpeed(FIGURES), 40_000, 30, PLAIN)[1] ?? "", /tok\/s/, "no room: no speed");
  for (const width of [30, 50, 70, 120]) for (const row of formatAgentsTimeline(withSpeed(FIGURES), 40_000, width, PLAIN)) assert.ok(visibleWidth(row) <= width);
});

void test("under 250 ms of generation the segment starts at TTFT", () => {
  const row = formatAgentsTimeline(withSpeed({ messages: 1, outputTokens: 5, generationMs: 200, firstTokenMs: 90 }), 40_000, 120, PLAIN)[1] ?? "";
  assert.match(row, /█ +TTFT 90 ms · 5 tok in 0\.2s +10s ✓$/);
});
