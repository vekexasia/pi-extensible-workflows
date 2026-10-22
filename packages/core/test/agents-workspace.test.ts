import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { formatWorkflowPhaseDashboard, type AgentRecord, type PersistedRun, type RunState } from "../src/index.js";
import { openAgentsWorkspace } from "../src/agents-workspace.js";
import { navigatorSidebarWidth } from "../src/host-view.js";
import { createSessionAgentsSource } from "../src/session-agents.js";
import { advance, agent, createRun, KEYBINDINGS, launch, click, entries, entry, ESC, escapes, FakeLive, KEY, leave, open, opened, polled, polls, rowOf, rule, settle, sidebarColumn, sidebarRows, statusRow as status, timers, title, topRow, until, project, tree, type FakePi, type Listed, type Spec } from "./agents-workspace-harness.js";

const AGENTS = (): Listed[] => [agent("alpha"), agent("beta", { depth: 1, state: "completed", running: false }), agent("scout", { group: "Subagents", state: "failed", running: false })];
/**
 * run:R
 *   P (phase)
 *     O (operation): a, b
 *     c
 * subagents: s
 */
const TREE = (): Spec[] => [
  { key: "run:R", kind: "run", label: "Workflow" },
  { key: "P", parent: "run:R" },
  { key: "O", parent: "P", kind: "operation" },
  { key: "a", parent: "O", agent: agent("a") },
  { key: "b", parent: "O", agent: agent("b", { state: "completed", running: false }) },
  { key: "c", parent: "P", agent: agent("c") },
  { key: "subagents", kind: "group", label: "Subagents" },
  { key: "s", parent: "subagents", agent: agent("s") },
];

void test("the workspace opens over Pi on the alternate screen and restores Pi on esc, ctrl+c and abort", async (t) => {
  timers(t);
  for (const exit of ["esc", "ctrl+c", "abort"] as const) {
    const controller = new AbortController();
    const live = new FakeLive();
    const harness = await open([agent("alpha", { live })], { signal: controller.signal });
    assert.deepEqual(harness.overlays, [true]);
    assert.deepEqual(harness.parent, ["stop:true"], exit);
    assert.ok(harness.terminal.written.includes(`${ESC}[?1049h`), "entered the alternate screen");
    assert.equal(harness.left, false);
    if (exit === "abort") controller.abort();
    else harness.send(exit === "esc" ? KEY.escape : KEY.ctrlC);
    await harness.done;
    await settle();
    assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], exit);
    assert.ok(harness.terminal.written.endsWith(`${ESC}[?1049l${ESC}[?25h${ESC}[?2026l`), "left the alternate screen with Pi's screen kept");
    assert.equal(harness.source("alpha").calls.at(-1), "close");
    assert.equal(harness.view("alpha").calls.at(-1), "dispose");
    assert.equal(live.unsubscribed, 1);
    const polls = harness.source("alpha").count("poll");
    const lists = harness.listCalls;
    await advance(t, 2);
    assert.equal(harness.source("alpha").count("poll"), polls, "no poll after leaving");
    assert.equal(harness.listCalls, lists, "no refresh after leaving");
  }
});

void test("the layout shows the title, the sidebar tree and the transcript at 120 columns, and starts without the sidebar below 80", async (t) => {
  timers(t);
  const wide = await open(AGENTS(), { columns: 120, setup: (source) => { source.polls.push(polled(entries(0, 5))); } });
  const lines = wide.screen();
  assert.equal(lines.length, 20);
  assert.match(lines[0] ?? "", /^#1\/3 alpha running gpt-5 1\.2k tok/);
  assert.deepEqual(sidebarColumn(wide).slice(0, 6), ["  ▾ build a1b2 · ⠦", "→   ▾ alpha · ⠦", "      • beta · ✓", rule(42), "  ▾ Subagents · ⠦", "    • scout · ✗"], "the first agent selected, every row in the /workflow format, a rule above the group");
  assert.match(lines[1] ?? "", /│ alpha record 0/);
  assert.equal((lines.at(-1) ?? "").trimEnd(), "left/right fold · escape/ctrl+c back · [ ] agent · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools", "the whole hint fits 120 columns");
  await leave(wide);

  const narrow = await open(AGENTS(), { columns: 70, setup: (source) => { source.polls.push(polled(entries(0, 5))); } });
  const narrowLines = narrow.screen();
  assert.equal(narrowLines[1], "alpha record 0");
  assert.ok(!narrowLines.some((line) => line.includes("Subagents")), "sidebar hidden");
  narrow.send("s");
  const shown = narrow.screen();
  assert.ok(shown.some((line) => line.startsWith("  ▾ Subagents")), "s shows the sidebar");
  await leave(narrow);
});

/** The sidebar is drawn: its Subagents group header shows. */
function sidebarShown(pi: FakePi): boolean { return pi.screen().some((line) => line.includes("▾ Subagents")); }

void test("the sidebar hidden below 80 columns comes back focused when the terminal widens to 80 or more, and hides again when it narrows", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { columns: 70 });
  assert.equal(sidebarShown(harness), false);
  harness.terminal.resize(80);
  assert.equal(sidebarShown(harness), true, "back at 80 columns");
  assert.match(harness.screen().at(-1) ?? "", /^left\/right fold/, "with the sidebar focused");
  assert.deepEqual(sidebarRows(harness).slice(0, 2), ["  ▾ build a1b2 · ⠦", "→   ▾ alpha · ⠦"], "on the same node");
  harness.terminal.resize(79);
  assert.equal(sidebarShown(harness), false, "hidden again below 80 columns");
  assert.match(harness.screen().at(-1) ?? "", /^up\/down scroll/, "the transcript has the focus");
  harness.send("s", "s");
  assert.equal(sidebarShown(harness), false);
  harness.terminal.resize(120);
  assert.equal(sidebarShown(harness), true, "hidden with s while it could not show, it comes back");
  assert.match(harness.screen().at(-1) ?? "", /^left\/right fold/);
  await leave(harness);
});

/** Every visible() of the layout's stack entries, found through the stacks' entries (pi-tui does not export them). */
function visibles(component: unknown): ((viewport: { width: number; height: number }) => boolean)[] {
  const entries: unknown = Reflect.get(Object(component), "entries");
  if (!Array.isArray(entries)) return [];
  return entries.flatMap((item: { component: unknown; visible?: (viewport: { width: number; height: number }) => boolean }) => [...(item.visible ? [item.visible] : []), ...visibles(item.component)]);
}

void test("the layout's visible callbacks only read: called again and in any order they change neither the answers nor the workspace", async (t) => {
  timers(t);
  const harness = await open(AGENTS());
  const callbacks = visibles(Reflect.get(harness.alt(), "layoutRoot"));
  assert.ok(callbacks.length >= 2, "the two sidebar placements, above and beside the transcript");
  const viewport = { width: 70, height: 20 };
  const answers = (): boolean[] => callbacks.map((visible) => visible(viewport));
  const before = answers();
  const screen = harness.screen();
  harness.terminal.columns = 70;
  for (const order of [callbacks, [...callbacks].reverse(), callbacks]) for (const visible of order) visible(viewport);
  assert.deepEqual(answers(), before);
  harness.terminal.columns = 120;
  assert.deepEqual(harness.screen(), screen, "the sidebar and the focus are as before");
  await leave(harness);
});

void test("a sidebar hidden with s while it could show stays hidden across a resize; s still toggles it", async (t) => {
  timers(t);
  const harness = await open(AGENTS());
  harness.send("s");
  for (const columns of [70, 120]) {
    harness.terminal.resize(columns);
    assert.equal(sidebarShown(harness), false, `${String(columns)} columns`);
    assert.match(harness.screen().at(-1) ?? "", /^up\/down scroll/);
  }
  harness.send("s");
  assert.equal(sidebarShown(harness), true, "s shows it again");
  harness.terminal.resize(70);
  harness.terminal.resize(120);
  assert.equal(sidebarShown(harness), true, "shown with s, it comes back after the terminal narrowed and widened");
  await leave(harness);
});

void test("a resize that stays below 80 columns keeps a sidebar shown with s, and its focus", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { columns: 70 });
  harness.send("s");
  assert.equal(sidebarShown(harness), true);
  harness.terminal.resize(71);
  assert.equal(sidebarShown(harness), true, "still shown at 71 columns");
  assert.match(harness.screen().at(-1) ?? "", /^left\/right fold/, "the sidebar keeps the focus");
  harness.send(KEY.tab);
  harness.terminal.resize(75);
  assert.equal(sidebarShown(harness), true, "still shown at 75 columns");
  assert.match(harness.screen().at(-1) ?? "", /^up\/down scroll/, "the transcript keeps the focus");
  await leave(harness);
});

void test("on a portrait terminal the tree stands above the transcript in at most a third of the body, with the selection and the transcript tail in view", async (t) => {
  timers(t);
  const many = Array.from({ length: 30 }, (_, index) => agent(`a${String(index)}`));
  for (const [columns, rows] of [[60, 50], [40, 60]] as const) {
    const harness = await open(many, { columns, rows, initialKey: "a29", setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
    const lines = harness.screen();
    const third = Math.floor((rows - 2) / 3);
    assert.equal(lines.length, rows);
    const tree = lines.slice(1, 1 + third);
    assert.match(lines[third] ?? "", /^─+$/, "a rule ends the tree's third, above the transcript");
    assert.ok(tree.every((line) => !line.includes("│") && !line.includes("record")), "the tree spans the width above the transcript");
    assert.ok(tree.some((line) => line.startsWith("→") && line.includes("a29")), "the selected row is in view");
    assert.ok(lines[1 + third]?.startsWith("a29 record"), "the transcript starts right under a third of the body");
    assert.ok(lines.at(-2)?.startsWith("a29 record 99"), "the transcript tail is on screen, above the hint");
    // A click on a tree row selects its node: the mouse rows map to the panes as drawn.
    const row = lines.findIndex((line) => line.includes("• a28"));
    click(harness, 10, row);
    assert.equal(harness.opened.at(-1), "a28", "the clicked row's agent opens");
    harness.send("s");
    assert.ok(!harness.screen().some((line) => line.includes("• a28")), "s hides the tree");
    harness.send("s");
    assert.ok(harness.screen().slice(1, 1 + third).some((line) => line.startsWith("→") && line.includes("a28")), "s shows it again, the selection in view");
    await leave(harness);
  }
  const wide = await open(many, { columns: 120, rows: 50, setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  wide.terminal.resize(60);
  const resized = wide.screen();
  assert.ok(resized.slice(1, 1 + 16).every((line) => !line.includes("│")) && resized.slice(1, 1 + 16).some((line) => line.startsWith("→")), "a resize to a portrait shape moves the shown tree above the transcript");
  assert.ok(resized[1 + 16]?.startsWith("a0 record"), "the transcript starts right under the tree");
  assert.match(resized.at(-1) ?? "", /^left\/right fold/, "with its focus");
  await leave(wide);
  // Wider than twice its rows, a terminal under 80 columns is not portrait: the tree above hides, the transcript takes the body.
  const square = await open(many, { columns: 30, rows: 20, setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  assert.equal(square.screen().slice(1, 7).filter((line) => line.startsWith("→")).length, 1, "30x20 is portrait");
  square.terminal.resize(60);
  assert.ok(square.screen().slice(1, -1).every((line) => line.startsWith("a0 record")), "a resize to 60x20 hides the tree");
  await leave(square);
  // A body under three rows leaves the tree no third: the transcript keeps every row.
  const tiny = await open(many, { columns: 6, rows: 4, setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  const cramped = tiny.screen();
  assert.ok(!cramped.some((line) => line.startsWith("→")), "no tree row at 6x4");
  await leave(tiny);
  const landscape = await open(many, { columns: 120, rows: 34, setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  const body = landscape.screen().slice(1, -1);
  assert.equal(body.length, 32);
  assert.ok(body.every((line) => line.indexOf("│") === 43 && visibleWidth(line) === 120), "120x34 keeps the tree beside the transcript");
  assert.ok(body.at(-1)?.includes("│ a0 record 99"));
  await leave(landscape);
});

void test("pgup and pgdn scroll the transcript while the sidebar has focus", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  harness.screen();
  const end = harness.alt().viewportTop;
  assert.equal(end, 100 - 18);
  harness.send(KEY.pageUp);
  harness.screen();
  assert.ok(harness.alt().viewportTop < end);
  harness.send(KEY.pageDown);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end);
  harness.send("s", KEY.pageUp);
  harness.screen();
  assert.ok(harness.alt().viewportTop < end, "a key right after the layout changed scrolls the transcript, not a stale view");
  harness.send("s", KEY.pageDown);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end);
  harness.send(KEY.ctrlHome);
  harness.screen();
  assert.equal(harness.alt().viewportTop, 0, "ctrl+home goes to the top of the transcript");
  assert.equal(harness.alt().isFollowingOutput, false);
  await settle();
  harness.send(KEY.ctrlEnd);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end, "ctrl+end goes back to the end");
  assert.equal(harness.alt().isFollowingOutput, true, "and follows new output again");
  assert.match(title(harness), /^#1\/3 alpha/);
  harness.send(KEY.down);
  assert.match(title(harness), /^#2\/3 beta/, "up/down still select agents");
  await leave(harness);
});

void test("up/down move over every node with the sidebar focused and scroll with the transcript focused; tab, s, [ and ] work with any focus", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/3 beta/);
  harness.send(KEY.down);
  await settle();
  assert.equal(title(harness).trimEnd(), "Subagents running", "the group is a node too");
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#3\/3 scout/);
  harness.send(KEY.down);
  await settle();
  assert.equal(title(harness).trimEnd(), "build a1b2 running", "wraps around to the first node");
  harness.send(KEY.up);
  await settle();
  assert.match(title(harness), /^#3\/3 scout/);
  harness.send(KEY.down, KEY.down);
  await settle();
  assert.match(title(harness), /^#1\/3 alpha/);
  const end = harness.alt().viewportTop;
  harness.send(KEY.tab, KEY.up);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end - 1, "up scrolls by a line");
  assert.match(title(harness), /^#1\/3 alpha/);
  harness.send(KEY.down);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end);
  harness.send("]");
  await settle();
  assert.match(title(harness), /^#2\/3 beta/, "] selects the next agent with the transcript focused");
  harness.send("[");
  await settle();
  assert.match(title(harness), /^#1\/3 alpha/);
  harness.send(KEY.tab, KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/3 beta/, "tab gave the focus back to the sidebar");
  harness.send("[");
  await settle();
  harness.send("s");
  const hidden = harness.screen();
  assert.ok(!hidden.some((line) => line.includes("Subagents")), "s hides the sidebar");
  assert.equal((hidden[1] ?? "").replace(/[\s┃█│]+$/, ""), `alpha record ${String(100 - 18)}`, "the transcript takes the whole width");
  harness.send(KEY.up);
  harness.screen();
  assert.equal(harness.alt().viewportTop, 100 - 18 - 1, "without the sidebar ↑↓ scroll");
  assert.match(title(harness), /^#1\/3 alpha/);
  harness.send("]");
  await settle();
  assert.match(title(harness), /^#2\/3 beta/);
  harness.send("s");
  assert.ok(harness.screen().some((line) => line.startsWith("  ▾ Subagents")));
  harness.send(KEY.ctrlO);
  assert.deepEqual(harness.view("beta").calls.filter((call) => call.startsWith("expanded")), ["expanded:false", "expanded:true"]);
  harness.send("[");
  await settle();
  assert.ok(harness.view("alpha").calls.includes("expanded:true"), "a new view keeps tool output expanded");
  await leave(harness);
});

void test("while the search box is open s and q reach it and ctrl+c still leaves", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { setup: (source) => { source.polls.push(polled(entries(0, 30))); } });
  harness.send(KEY.search);
  assert.equal(harness.alt().hasOverlay(), true);
  harness.send("s", "q");
  const lines = harness.screen();
  assert.ok(lines.some((line) => line.includes("sq")), "the search box got the keys");
  assert.ok(lines.some((line) => line.startsWith("  ▾ Subagents")), "s did not hide the sidebar");
  harness.send(KEY.escape);
  assert.equal(harness.alt().hasOverlay(), false, "esc closes the search box first");
  assert.equal(harness.left, false);
  harness.send(KEY.search, KEY.ctrlC);
  await harness.done;
  assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"]);
});

void test("a click on a sidebar row selects that agent and the wheel over the sidebar scrolls the transcript", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  const row = rowOf(harness, "scout");
  assert.ok(row > 0);
  harness.send(`${ESC}[<0;5;${String(row + 1)}M`, `${ESC}[<0;5;${String(row + 1)}m`);
  await settle();
  assert.match(title(harness), /^#3\/3 scout/);
  assert.deepEqual(harness.opened, ["alpha", "scout"]);
  harness.send("[", "[");
  await settle();
  assert.match(title(harness), /^#1\/3 alpha/);
  const end = harness.alt().viewportTop;
  harness.send(`${ESC}[<64;5;${String(row + 1)}M`);
  harness.screen();
  assert.ok(harness.alt().viewportTop < end, "the wheel scrolls the transcript");
  assert.match(title(harness), /^#1\/3 alpha/);
  await leave(harness);
});

void test("a click whose new view throws while drawing shows the error instead of throwing out of the mouse dispatch", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { failRender: "scout" });
  const row = rowOf(harness, "scout");
  assert.ok(row > 0);
  assert.doesNotThrow(() => { harness.send(`${ESC}[<0;5;${String(row + 1)}M`, `${ESC}[<0;5;${String(row + 1)}m`); });
  // Until the next successful poll replaces it, the failure is the status line.
  assert.match(harness.screen().join("\n"), /render failed/);
  await settle();
  harness.send("[");
  await settle();
  assert.match(title(harness), /^#2\/3/, "the workspace still takes keys after the failed click");
  await leave(harness);
});

void test("a stream that replays synchronously while the view subscribes reaches the view", async (t) => {
  timers(t);
  const live = new FakeLive();
  live.replay.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "so far" } });
  const harness = await open([agent("alpha", { live })]);
  assert.ok(harness.view("alpha").calls.includes("live:message_update"), "the replayed event was not dropped");
  await leave(harness);
});

void test("selecting another agent closes the previous source, unsubscribes its live stream and disposes its view", async (t) => {
  timers(t);
  const live = new FakeLive();
  const harness = await open([agent("alpha", { live }), agent("beta")]);
  live.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
  assert.ok(harness.view("alpha").calls.includes("live:message_update"));
  assert.equal(harness.view("alpha").ui, harness.alt());
  assert.equal(harness.view("alpha").cwd, "/project/alpha");
  harness.send(KEY.down);
  await settle();
  assert.equal(harness.source("alpha").calls.at(-1), "close");
  assert.equal(live.unsubscribed, 1);
  assert.equal(live.listeners.size, 0);
  assert.equal(harness.view("alpha").calls.at(-1), "dispose");
  assert.deepEqual(harness.opened, ["alpha", "beta"]);
  assert.equal(harness.source("beta").count("poll"), 1);
  assert.equal(harness.source("alpha").overlapped, false);
  await leave(harness);
});

void test("an agent that is not owned shows transcript unavailable and its source is never opened", async (t) => {
  timers(t);
  const harness = await open([agent("alpha"), agent("beta", { owned: false })]);
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/2 beta/);
  assert.deepEqual(harness.opened, ["alpha"]);
  assert.equal(harness.views.length, 1);
  assert.ok(harness.screen().some((line) => line.includes("│ transcript unavailable")));
  await advance(t, 2);
  assert.deepEqual(harness.opened, ["alpha"]);
  await leave(harness);
});

void test("ten quick moves down the tree start one read, where the selection stops", async (t) => {
  timers(t);
  const harness = await open(Array.from({ length: 11 }, (_, index) => agent(`a${String(index)}`)));
  harness.send(...Array.from({ length: 10 }, () => KEY.down));
  await settle();
  assert.equal(harness.opened.length, 11);
  assert.deepEqual(harness.sources.slice(1).map((source) => source.count("poll")), [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
  assert.deepEqual(harness.sources.slice(0, -1).map((source) => source.calls.at(-1)), Array.from({ length: 10 }, () => "close"));
  await leave(harness);
});

void test("moves in separate turns while the first read is held start no read; the agent shown when it settles is read, none passed over", async (t) => {
  timers(t);
  let release = (): void => undefined;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const harness = await open(Array.from({ length: 21 }, (_, index) => agent(`a${String(index)}`)), { setup: (source) => { if (source.key === "a1") source.pollGate = held; } });
  harness.send(KEY.down);
  await settle();
  assert.equal(harness.source("a1").count("poll"), 1, "a single move reads at once");
  for (let move = 0; move < 19; move += 1) {
    harness.send(KEY.down);
    await settle();
  }
  assert.match(title(harness), /^#21\/21 a20/);
  assert.deepEqual(harness.sources.slice(2).map((source) => source.count("poll")), Array.from({ length: 19 }, () => 0), "no read while a1's is held");
  release();
  await settle();
  assert.deepEqual(harness.sources.map((source) => source.count("poll")), [1, 1, ...Array.from({ length: 18 }, () => 0), 1]);
  assert.deepEqual(harness.sources.slice(0, -1).map((source) => source.calls.at(-1)), Array.from({ length: 20 }, () => "close"));
  await leave(harness);
});

void test("polling appends and resets while the agent runs, shows waiting, and stops one poll after the agent stops", async (t) => {
  timers(t);
  const harness = await open([agent("alpha")], { columns: 70, setup: (source) => { source.polls.push(polled([], { status: "waiting" }), polled(entries(0, 3)), polled(entries(3, 2)), polled(entries(100, 4), { reset: true })); } });
  const source = harness.source("alpha");
  const view = harness.view("alpha");
  assert.equal(source.count("poll"), 1, "an immediate poll");
  assert.ok(harness.screen().some((line) => line.includes("waiting for the first message")));
  await advance(t);
  assert.deepEqual(view.calls.filter((call) => call !== "expanded:false"), ["append:3"]);
  assert.ok(!harness.screen().some((line) => line.includes("waiting")));
  await advance(t);
  await advance(t);
  assert.deepEqual(view.calls.filter((call) => call !== "expanded:false"), ["append:3", "append:2", "reset", "append:4"]);
  assert.equal(topRow(harness), "alpha record 100");
  harness.agents = [agent("alpha", { running: false, state: "completed" })];
  // The tick that learns the agent stopped has started its poll before the list came back.
  await advance(t);
  const running = source.count("poll");
  await advance(t, 3);
  assert.equal(source.count("poll"), running + 1, "one more poll after the agent stopped");
  assert.match(title(harness), /^#1\/1 alpha completed/);
  assert.equal(harness.listCalls >= 6, true, "the agents are listed on every tick");
  assert.equal(source.overlapped, false);
  await leave(harness);
});

void test("the selection survives a refresh that reorders the agents, and the initial key is selected first", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { initialKey: "beta" });
  assert.deepEqual(harness.opened, ["beta"]);
  assert.match(title(harness), /^#2\/3 beta/);
  const [alpha, beta, scout] = harness.agents;
  assert.ok(alpha && beta && scout);
  harness.agents = [scout, beta, alpha];
  await advance(t);
  assert.match(title(harness), /^#2\/3 beta/);
  harness.agents = [beta, alpha, scout];
  await advance(t);
  assert.match(title(harness), /^#1\/3 beta/);
  assert.deepEqual(harness.opened, ["beta"]);
  assert.ok(!harness.source("beta").calls.includes("close"));
  harness.agents = [alpha, scout];
  await advance(t);
  assert.match(title(harness), /^#1\/2 alpha/, "a removed agent gives the selection to its neighbour");
  assert.equal(harness.source("beta").calls.at(-1), "close");
  await leave(harness);
});

void test("a new attempt or session reference of the selected agent reopens it", async (t) => {
  timers(t);
  const harness = await open([agent("alpha")]);
  harness.agents = [agent("alpha", { attempt: 2, session: { transport: "pi", sessionId: "alpha-2" } })];
  await advance(t);
  assert.deepEqual(harness.opened, ["alpha", "alpha"]);
  assert.equal(harness.sources[0]?.calls.at(-1), "close");
  assert.equal(harness.views[0]?.calls.at(-1), "dispose");
  assert.equal(harness.views.length, 2);
  harness.agents = [agent("alpha", { attempt: 2, session: { transport: "pi", sessionId: "alpha-2", locator: { sessionFile: "/sessions/alpha-2.jsonl" } } })];
  await advance(t);
  assert.deepEqual(harness.opened, ["alpha", "alpha", "alpha"]);
  await advance(t);
  assert.equal(harness.opened.length, 3, "the same attempt is not reopened");
  await leave(harness);
});

void test("a live stream registered after the agent was opened is subscribed without reopening it", async (t) => {
  timers(t);
  const harness = await open([agent("alpha")]);
  const live = new FakeLive();
  harness.agents = [agent("alpha", { live })];
  await advance(t);
  assert.equal(live.listeners.size, 1, "the new stream is subscribed");
  assert.deepEqual(harness.opened, ["alpha"], "the source is not reopened");
  assert.equal(harness.views.length, 1, "the view is kept");
  live.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
  assert.ok(harness.view("alpha").calls.includes("live:message_update"), "its events reach the view");
  const next = new FakeLive();
  harness.agents = [agent("alpha", { live: next })];
  await advance(t);
  assert.equal(live.unsubscribed, 1, "a replaced stream is unsubscribed");
  assert.equal(next.listeners.size, 1);
  harness.agents = [agent("alpha")];
  await advance(t);
  assert.equal(next.unsubscribed, 1, "a stream that went away is unsubscribed");
  assert.equal(harness.views.length, 1);
  await leave(harness);
});

void test("the sidebar keeps the selected row in view, and clicks select rows after it scrolled", async (t) => {
  timers(t);
  const many = Array.from({ length: 30 }, (_, index) => agent(`a${String(index).padStart(2, "0")}`, { group: index < 15 ? "g1" : "g2" }));
  const harness = await open(many, { rows: 10 });
  assert.ok((harness.screen()[1] ?? "").startsWith("  ▾ g1 · ⠦"));
  assert.ok((harness.screen()[2] ?? "").startsWith("→   • a00 · ⠦"));
  harness.send("[");
  await settle();
  let lines = harness.screen();
  assert.match(title(harness), /^#30\/30 a29/, "[ goes round to the last agent");
  assert.ok(lines.some((line) => line.startsWith("→   • a29 · ⠦")), "the selected row is in view");
  assert.ok(!lines.some((line) => line.includes(" a00")), "the sidebar scrolled");
  const row = rowOf(harness, " a25");
  assert.ok(row > 0);
  harness.send(`${ESC}[<0;5;${String(row + 1)}M`, `${ESC}[<0;5;${String(row + 1)}m`);
  await settle();
  assert.match(title(harness), /^#26\/30 a25/, "the click resolved the scrolled row");
  harness.send(KEY.down, KEY.down, KEY.down, KEY.down, KEY.down);
  await settle();
  lines = harness.screen();
  assert.equal(title(harness).trimEnd(), "g1 running", "down goes round to the first node");
  assert.ok((lines[1] ?? "").startsWith("→ ▾ g1 · ⠦"), "the sidebar scrolled back to the top");
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#1\/30 a00/);
  assert.ok((harness.screen()[2] ?? "").startsWith("→   • a00 · ⠦"));
  await leave(harness);
});

void test("the status line shows an unavailable transcript with its reason, a failed read, then the agent's activity", async (t) => {
  timers(t);
  const harness = await open([agent("alpha", { activity: "running bash: npm test" })], { setup: (source) => {
    source.polls.push(polled([], { status: "unavailable", reason: "session file was replaced" }), new Error("permission denied"), polled(entries(0, 2)));
  } });
  const status = (): string => (harness.screen().at(-2) ?? "").trimEnd();
  assert.match(status(), /│ transcript unavailable: session file was replaced$/);
  await advance(t);
  assert.match(status(), /│ transcript read failed: permission denied$/);
  await advance(t);
  assert.match(status(), /│ running bash: npm test$/);
  assert.ok(harness.screen().some((line) => line.includes("alpha record 1")));
  await leave(harness);
});

void test("a failed list keeps the previous agents and shows the error in the title", async (t) => {
  timers(t);
  const harness = await open(AGENTS());
  harness.listError = new Error("store locked");
  await advance(t);
  assert.match(title(harness), /^#1\/3 alpha .*agents unavailable: store locked/);
  assert.ok(harness.screen().some((line) => line.includes("scout")), "the previous agents stay");
  assert.ok(!harness.source("alpha").calls.includes("close"));
  harness.listError = undefined;
  await advance(t);
  assert.doesNotMatch(title(harness), /agents unavailable/);
  await leave(harness);
});

void test("the initial key is selected by the first list that contains it", async (t) => {
  timers(t);
  const harness = await open([], { initialKey: "beta" });
  assert.equal(harness.listCalls, 1, "the first list was empty");
  assert.deepEqual(harness.opened, []);
  harness.agents = AGENTS();
  // Nothing runs: the next list comes at the five-second tick.
  await advance(t, 5);
  assert.match(title(harness), /^#2\/3 beta/);
  assert.deepEqual(harness.opened, ["beta"]);
  await leave(harness);
});

void test("a custom that throws synchronously rejects the workspace's promise instead of throwing out of the call", async () => {
  const ctx = { ui: { custom: () => { throw new Error("no custom"); }, notify() {} } } as unknown as ExtensionCommandContext;
  let opening: Promise<unknown> | undefined;
  assert.doesNotThrow(() => { opening = openAgentsWorkspace(ctx, { agents: { list: async () => [] }, openSource: () => { throw new Error("unexpected openSource"); }, createView: () => { throw new Error("unexpected createView"); } }); });
  assert.ok(opening);
  await assert.rejects(opening, /no custom/);
});

void test("a signal aborted before opening never stops Pi", async () => {
  const controller = new AbortController();
  controller.abort();
  const harness = await open(AGENTS(), { signal: controller.signal });
  await harness.done;
  assert.deepEqual(harness.parent, []);
  assert.equal(harness.listCalls, 0);
  assert.deepEqual(harness.opened, []);
});

void test("a shutdown closes the open workspace at once: Pi's screen back with mouse tracking off, Pi left stopped for its shutdown, the command settled", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const shutdown = new AbortController();
  const live = new FakeLive();
  const harness = await open([agent("alpha", { live })], { shutdown: shutdown.signal });
  assert.ok(harness.terminal.written.includes(`${ESC}[?1049h`) && harness.terminal.written.includes(`${ESC}[?1000h`), "the alternate screen with mouse tracking on");
  const opened = harness.terminal.written.length;
  shutdown.abort({ type: "session_shutdown", reason: "quit" });
  await until(() => harness.left, "the command settled");
  const closed = harness.terminal.written.slice(opened);
  assert.ok(closed.includes(`${ESC}[?1006l${ESC}[?1004l${ESC}[?1003l${ESC}[?1002l${ESC}[?1000l`), "mouse tracking off");
  assert.ok(closed.endsWith(`${ESC}[?1049l${ESC}[?25h${ESC}[?2026l`), "the alternate screen left with Pi's screen kept");
  assert.deepEqual(harness.parent, ["stop:true"], "Pi is not started again: a quit stopped it before session_shutdown, a signal stops it after");
  assert.equal(harness.source("alpha").calls.at(-1), "close");
  assert.equal(live.unsubscribed, 1);
  const pollCount = polls(harness);
  await advance(t, 2);
  assert.equal(polls(harness), pollCount, "no poll after the shutdown");
  assert.deepEqual(harness.notified, []);

  const early = await open(AGENTS(), { shutdown: AbortSignal.abort() });
  await until(() => early.left, "a shutdown before opening settles too");
  assert.deepEqual(early.parent, [], "and never stops Pi");

  // A session replaced in a Pi that goes on: the workspace leaves as an abort does and gives Pi its TUI back.
  const replaced = new AbortController();
  const reload = await open(AGENTS(), { shutdown: replaced.signal });
  replaced.abort({ type: "session_shutdown", reason: "reload" });
  await until(() => reload.left, "a reload settles the command");
  assert.deepEqual(reload.parent, ["stop:true", "start", "renderNow:false"], "and starts Pi again");
  assert.deepEqual(escaped, []);
});

void test("opening that fails before or after the workspace is built restores Pi, reports once and leaves nothing running", async (t) => {
  timers(t);
  const escaped = escapes(t);
  for (const fail of ["cursor", "start"] as const) {
    const harness = await open(AGENTS(), { fail });
    await harness.done;
    assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], fail);
    assert.deepEqual(harness.notified, [`error: agents workspace failed: ${fail === "cursor" ? "no cursor" : "terminal unavailable"}`]);
    if (fail === "start") {
      const entered = harness.terminal.written.indexOf(`${ESC}[?1049h`);
      assert.ok(entered >= 0, "the alt screen was entered before the terminal failed");
      assert.ok(harness.terminal.written.indexOf(`${ESC}[?1049l`) > entered, "and left again");
    }
    const lists = harness.listCalls;
    assert.ok(lists <= 1, "at most the first list, called while the workspace was built");
    await advance(t, 3);
    assert.equal(harness.listCalls, lists, `no refresh after opening failed (${fail})`);
    assert.equal(polls(harness), 0, "no poll after opening failed");
    assert.deepEqual(harness.opened, []);
  }
  assert.deepEqual(escaped, []);
});

void test("the refresh interval starts once the first list settled", async (t) => {
  timers(t);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const harness = await open(AGENTS(), { listGate: gate });
  assert.equal(harness.listCalls, 1);
  t.mock.timers.tick(1500);
  await settle();
  release();
  await settle();
  assert.match(title(harness), /^#1\/3 alpha/);
  t.mock.timers.tick(600);
  await settle();
  assert.equal(harness.listCalls, 1, "no tick 1000 ms after open, before the first list settled");
  t.mock.timers.tick(400);
  await settle();
  assert.equal(harness.listCalls, 2, "the first tick comes 1000 ms after the first list settled");
  await leave(harness);
});

/** Counts the frames the alternate screen is asked for from now on. */
function frames(pi: FakePi): { count: number } {
  const alt = pi.alt();
  const counted = { count: 0 };
  const request = alt.requestRender.bind(alt);
  const now = alt.renderNow.bind(alt);
  alt.requestRender = (force) => { counted.count += 1; request(force); };
  alt.renderNow = (force) => { counted.count += 1; now(force); };
  return counted;
}

void test("a tick with nothing new draws no frame: neither the list of a finished agent nor an empty poll of a running one", async (t) => {
  timers(t);
  const finished = await open([agent("alpha", { state: "completed", running: false })]);
  await advance(t);
  const idle = frames(finished);
  // The first tick read the finished agent to its end: from then on the ticks are five seconds apart.
  await advance(t, 10);
  assert.equal(finished.listCalls, 4, "the ticks listed");
  assert.equal(idle.count, 0, "two ticks on a finished agent drew nothing");
  await leave(finished);
  // Below 80 columns the sidebar hides: the running agent's polls are what could change the screen.
  const running = await open([agent("alpha")], { columns: 60 });
  await advance(t);
  const drawn = frames(running);
  await advance(t, 2);
  assert.equal(running.source("alpha").count("poll"), 4, "the ticks polled");
  assert.equal(drawn.count, 0, "two empty polls drew nothing");
  running.source("alpha").polls.push(polled([entry(1)]));
  await advance(t);
  assert.equal(drawn.count, 1, "an appended record draws a frame");
  running.source("alpha").polls.push(polled([], { status: "waiting" }));
  await advance(t);
  assert.equal(drawn.count, 2, "a change of status draws a frame");
  assert.ok(running.screen().some((line) => line.includes("waiting for the first message")));
  await leave(running);
});

void test("while no agent runs and the shown transcript is read to its end the ticks are five seconds apart; a change lists at once, a running agent brings back the second", async (t) => {
  timers(t);
  const listeners = new Set<() => void>();
  const change = async (): Promise<void> => { for (const listener of listeners) listener(); await settle(); };
  const [alpha, beta] = [agent("alpha", { state: "completed", running: false }), agent("beta", { state: "completed", running: false })];
  const harness = await open([alpha, beta], { changes: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } });
  assert.equal(listeners.size, 1, "the workspace listens for changes");
  const reads = (): number => harness.source("alpha").count("poll");
  /** The lists and the reads of alpha's transcript over the next `seconds`. */
  const over = async (seconds: number): Promise<[number, number]> => {
    const [lists, polled] = [harness.listCalls, reads()];
    await advance(t, seconds);
    return [harness.listCalls - lists, reads() - polled];
  };
  // Until its first read settles alpha's transcript is not read to its end: the ticks slow down within a few seconds.
  await advance(t, 6);
  assert.deepEqual(await over(10), [2, 0], "nothing runs: a list every five seconds and no transcript read");
  harness.agents = [alpha, agent("beta")];
  let lists = harness.listCalls;
  await change();
  assert.equal(harness.listCalls, lists + 1, "a change lists at once");
  assert.deepEqual(await over(3), [3, 0], "an agent runs: a list every second");
  lists = harness.listCalls;
  await change();
  assert.equal(harness.listCalls, lists, "while one runs a change waits for the tick");
  harness.agents = [alpha, beta];
  await advance(t, 6);
  assert.deepEqual(await over(10), [2, 0], "it stopped: five seconds apart again");
  // The shown agent is read every second while it runs, and once more after it stopped, so its transcript is read to its end.
  harness.agents = [agent("alpha"), beta];
  await change();
  assert.deepEqual(await over(3), [3, 3], "the shown agent runs: a list and a read every second");
  harness.agents = [alpha, beta];
  await advance(t, 6);
  assert.deepEqual(await over(10), [2, 0], "it stopped and was read to its end: five seconds apart, no read");
  await leave(harness);
  assert.equal(listeners.size, 0, "leaving stops listening");
});

void test("the alternate screen takes Pi's fullscreen settings: copy on select, wheel scroll lines and the scrollbar; the transcript gets the same settings", async (t) => {
  timers(t);
  const cwd = mkdtempSync(join(tmpdir(), "agents-settings-"));
  t.after(() => { rmSync(cwd, { recursive: true, force: true }); });
  mkdirSync(join(cwd, ".pi"));
  writeFileSync(join(cwd, ".pi", "settings.json"), JSON.stringify({ fullscreenCopyOnSelect: false, fullscreenWheelScrollLines: 5, fullscreenScrollbar: "always", hideThinkingBlock: true }));
  const harness = await open([agent("alpha")], { columns: 60, context: { cwd }, setup: (source) => { source.polls.push(polled(entries(1, 100))); } });
  await settle();
  assert.equal(harness.alt().getCopyOnSelect(), false);
  assert.equal(harness.view("alpha").settings?.getHideThinkingBlock(), true);
  assert.match(harness.screen()[1] ?? "", /^alpha record \d+ +│$/, "the scrollbar always shows, beside the text");
  harness.screen();
  const top = harness.alt().viewportTop;
  harness.send(`${ESC}[<64;10;5M`);
  harness.screen();
  assert.equal(harness.alt().viewportTop, top - 5, "a wheel notch scrolls five lines");
  await leave(harness);
});

void test("tool output starts as Pi has it (ctx.ui.getToolsExpanded), and ctrl+o toggles it from there", async (t) => {
  timers(t);
  const harness = await open([agent("alpha")], { toolsExpanded: true });
  assert.deepEqual(harness.view("alpha").calls.filter((call) => call.startsWith("expanded")), ["expanded:true"]);
  harness.send(KEY.ctrlO);
  assert.deepEqual(harness.view("alpha").calls.filter((call) => call.startsWith("expanded")), ["expanded:true", "expanded:false"]);
  await leave(harness);
});

void test("a list() that throws synchronously, at open or on a later tick, ends in the title and refreshing goes on", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const harness = await open(AGENTS(), { listThrow: new Error("index corrupt") });
  assert.equal(harness.listCalls, 1);
  assert.deepEqual(harness.opened, []);
  // No view yet, so no alt screen handle: wait (bounded) for the throttled frame the alt screen drew on the terminal.
  const drawn = (): boolean => stripTerminalSequences(harness.terminal.written).includes("agents unavailable: index corrupt");
  for (let wait = 0; wait < 100 && !drawn(); wait += 1) await new Promise((resolve) => { setTimeout(resolve, 5); });
  assert.ok(drawn(), "the title shows the throw");
  harness.listThrow = undefined;
  // Nothing listed runs: the next list comes at the five-second tick.
  await advance(t, 5);
  assert.equal(harness.listCalls, 2, "the interval started after the throw");
  assert.match(title(harness), /^#1\/3 alpha/);
  assert.deepEqual(harness.opened, ["alpha"]);
  harness.listThrow = new Error("index moved");
  await advance(t);
  assert.match(title(harness), /^#1\/3 alpha .*agents unavailable: index moved/);
  assert.ok(harness.screen().some((line) => line.includes("scout")), "the previous agents stay");
  await advance(t);
  assert.equal(harness.listCalls, 4, "a throw does not stop refreshing");
  harness.listThrow = undefined;
  await advance(t);
  assert.doesNotMatch(title(harness), /agents unavailable/);
  assert.equal(harness.source("alpha").calls.includes("close"), false);
  await leave(harness);
  assert.deepEqual(escaped, []);
});

void test("a view whose append or live throws shows the error as the status line and polling goes on", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const live = new FakeLive();
  const harness = await open([agent("alpha", { live })], { setup: (source) => { source.polls.push(polled(entries(0, 2)), polled(entries(2, 2)), polled(entries(4, 2)), polled(entries(6, 2))); } });
  const source = harness.source("alpha");
  const view = harness.view("alpha");
  const status = (): string => (harness.screen().at(-2) ?? "").trimEnd();
  view.fail.append = new Error("append threw");
  await advance(t);
  assert.match(status(), /│ transcript failed: append threw$/);
  await advance(t);
  assert.equal(source.count("poll"), 3, "polling goes on");
  assert.equal(harness.listCalls, 3, "refreshing goes on");
  view.fail.append = undefined;
  await advance(t);
  assert.ok(!harness.screen().some((line) => line.includes("transcript failed")), "a poll the view took clears the error");
  assert.ok(harness.screen().some((line) => line.includes("alpha record 6")));
  view.fail.live = new Error("live threw");
  live.emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } });
  assert.match(status(), /│ transcript failed: live threw$/);
  await settle();
  assert.equal(source.overlapped, false);
  await leave(harness);
  assert.deepEqual(escaped, []);
});

void test("an agent whose view cannot be created stays selected with the error, closes its source and is not reopened every tick", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const harness = await open(AGENTS(), { failView: "beta" });
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/3 beta/);
  assert.deepEqual(harness.opened, ["alpha", "beta"]);
  assert.equal(harness.source("beta").calls.at(-1), "close");
  assert.match((harness.screen().at(-2) ?? "").trimEnd(), /│ transcript unavailable: no view$/);
  await advance(t, 2);
  assert.deepEqual(harness.opened, ["alpha", "beta"], "the same attempt is not reopened");
  assert.equal(harness.source("beta").count("poll"), 0);
  harness.send("[");
  await settle();
  assert.match(title(harness), /^#1\/3 alpha/);
  assert.equal(harness.view("alpha").calls.includes("dispose"), false);
  await leave(harness);
  assert.deepEqual(escaped, []);
});

void test("left and right collapse, expand and move to the parent or the first child as in /workflow", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TREE()) });
  assert.match(title(harness), /^#1\/4 a running/, "the first agent node is selected");
  assert.deepEqual(sidebarRows(harness), ["  ▾ Workflow · ⠦", "    ▾ P · ⠦", "      ▾ O · ⠦", "→       • a · ⠦", "        • b · ✓", "      • c · ⠦", "  ▾ Subagents · ⠦", "    • s · ⠦"]);
  harness.send(KEY.right);
  await settle();
  assert.match(title(harness), /^#1\/4 a/, "right on a leaf stays");
  harness.send(KEY.left);
  await settle();
  assert.equal(title(harness).trimEnd(), "O running", "left on a leaf goes to the parent");
  harness.send(KEY.left);
  await settle();
  assert.deepEqual(sidebarRows(harness).slice(2, 4), ["→     ▸ O · ⠦", "      • c · ⠦"], "left on an expanded node collapses it and stays");
  harness.send(KEY.left);
  await settle();
  assert.equal(title(harness).trimEnd(), "P running", "left on a collapsed node goes to the parent");
  harness.send(KEY.right);
  await settle();
  assert.equal(title(harness).trimEnd(), "O running", "right on an expanded node goes to its first child");
  harness.send(KEY.right);
  await settle();
  assert.deepEqual(sidebarRows(harness).slice(2, 4), ["→     ▾ O · ⠦", "        • a · ⠦"], "right on a collapsed node expands it and stays");
  harness.send(KEY.right);
  await settle();
  assert.match(title(harness), /^#1\/4 a/);
  harness.send(KEY.tab, KEY.left);
  await settle();
  assert.match(title(harness), /^#1\/4 a/, "left and right act on the tree only while it has the focus");
  harness.send(KEY.tab, KEY.up, KEY.up, KEY.up, KEY.left);
  await settle();
  assert.deepEqual(sidebarRows(harness), ["→ ▸ Workflow · ⠦", "  ▾ Subagents · ⠦", "    • s · ⠦"], "up from a reached the run root, left collapsed it");
  harness.send(KEY.left);
  await settle();
  assert.equal(title(harness).trimEnd(), "Workflow running", "left on a collapsed root stays");
  await leave(harness);
});

void test("[ and ] jump over the nodes that are not agents and expand the ancestors of the agent they land on", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TREE()) });
  harness.send(KEY.left, KEY.left, KEY.left, KEY.left);
  await settle();
  assert.deepEqual(sidebarRows(harness).slice(0, 2), ["  ▾ Workflow · ⠦", "→   ▸ P · ⠦"], "P and O collapsed");
  harness.send("]");
  await settle();
  assert.match(title(harness), /^#1\/4 a/, "the next agent after P, hidden under it");
  assert.deepEqual(sidebarRows(harness).slice(1, 4), ["    ▾ P · ⠦", "      ▾ O · ⠦", "→       • a · ⠦"], "its ancestors expanded");
  const keys: string[] = [];
  for (const key of ["]", "]", "]", "]", "[", "["]) {
    harness.send(key);
    await settle();
    keys.push(title(harness).split(" ").slice(0, 2).join(" "));
  }
  assert.deepEqual(keys, ["#2/4 b", "#3/4 c", "#4/4 s", "#1/4 a", "#4/4 s", "#3/4 c"], "agents only, in sidebar order, round at both ends");
  harness.send(KEY.down, KEY.left);
  await settle();
  assert.deepEqual(sidebarRows(harness).slice(-1), ["→ ▸ Subagents · ⠦"], "the group collapsed");
  harness.send("]");
  await settle();
  assert.match(title(harness), /^#4\/4 s/);
  assert.deepEqual(sidebarRows(harness).slice(-2), ["  ▾ Subagents · ⠦", "→   • s · ⠦"]);
  await leave(harness);
});

void test("a node that is not an agent shows its details: no source, no polling, no live stream", async (t) => {
  timers(t);
  const live = new FakeLive();
  const specs = TREE().map((spec) => spec.key === "a" ? { ...spec, agent: agent("a", { live }) } : spec);
  const harness = await open([], { nodes: tree(specs) });
  assert.deepEqual(harness.opened, ["a"]);
  assert.equal(live.listeners.size, 1);
  harness.send(KEY.up);
  await settle();
  const lines = harness.screen();
  assert.equal((lines[0] ?? "").trimEnd(), "O running", "the title is the node's label and state");
  assert.match(lines[1] ?? "", /│ details of O\s*$/);
  assert.match(lines[2] ?? "", /│ state running\s*$/);
  assert.equal(status(harness), "", "no status line");
  assert.equal(harness.source("a").calls.at(-1), "close");
  assert.equal(live.listeners.size, 0, "the agent's stream is let go");
  const polled = polls(harness);
  await advance(t, 3);
  assert.deepEqual(harness.opened, ["a"], "no source for the node");
  assert.equal(polls(harness), polled, "no polling");
  assert.equal(live.listeners.size, 0);
  harness.send(KEY.enter, KEY.ctrlO);
  await settle();
  assert.deepEqual(harness.opened, ["a"]);
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#1\/4 a/);
  assert.deepEqual(harness.opened, ["a", "a"], "the agent opens again");
  assert.ok(harness.view("a").calls.includes("expanded:true"), "ctrl+o still toggled the tool output");
  await leave(harness);
});

void test("expansion and selection survive a refresh that adds nodes; new nodes take their initial expansion", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TREE()) });
  harness.send(KEY.left, KEY.left);
  await settle();
  assert.equal(title(harness).trimEnd(), "O running");
  harness.nodes = tree([
    { key: "new-run", kind: "run", label: "Fresh" },
    { key: "new-agent", parent: "new-run", agent: agent("n") },
    ...TREE().flatMap((spec) => spec.key === "c" ? [{ key: "d", parent: "O", agent: agent("d") }, { key: "Q", parent: "P", kind: "operation" as const }, { key: "e", parent: "Q", agent: agent("e") }, spec] : [spec]),
  ]);
  await advance(t);
  assert.equal(title(harness).trimEnd(), "O running", "the selection kept by key");
  assert.deepEqual(sidebarRows(harness), [
    "  ▾ Fresh · ⠦",
    "    • n · ⠦",
    "  ▾ Workflow · ⠦",
    "    ▾ P · ⠦",
    "→     ▸ O · ⠦",
    "      ▾ Q · ⠦",
    "        • e · ⠦",
    "      • c · ⠦",
    "  ▾ Subagents · ⠦",
    "    • s · ⠦",
  ], "O stays collapsed (its new child d hidden), the new run and Q come expanded");
  harness.send("]");
  await settle();
  assert.match(title(harness), /^#2\/7 a/, "the next agent in sidebar order, the new run's agent first");
  assert.deepEqual(sidebarRows(harness).slice(4, 8), ["      ▾ O · ⠦", "→       • a · ⠦", "        • b · ✓", "        • d · ⠦"], "O expanded again, with its new child");
  await advance(t);
  assert.match(title(harness), /^#2\/7 a/);
  assert.deepEqual(harness.opened, ["a", "a"], "the selected agent is not reopened by a refresh");
  await leave(harness);
});

void test("a phase listed before it has children is expanded once a later list gives it its first child, as /workflow expands it", async (t) => {
  timers(t);
  const root: Spec = { key: "run:R", kind: "run", label: "Workflow" };
  const plan: Spec = { key: "P", parent: "run:R", label: "plan" };
  const review: Spec = { key: "Q", parent: "run:R", label: "review" };
  const harness = await open([], { nodes: tree([root, plan]) });
  assert.deepEqual(sidebarRows(harness), ["→ ▾ Workflow · ⠦", "      plan · ⠦"], "the phase before its first agent has no icon");
  harness.nodes = tree([root, plan, { key: "a", parent: "P", agent: agent("a") }, review]);
  // Nothing ran: the next list comes at the five-second tick.
  await advance(t, 5);
  assert.deepEqual(sidebarRows(harness), ["→ ▾ Workflow · ⠦", "    ▾ plan · ⠦", "      • a · ⠦", "      review · ⠦"], "its first child comes in view");
  harness.nodes = tree([root, plan, { key: "a", parent: "P", agent: agent("a") }, review, { key: "b", parent: "Q", agent: agent("b") }]);
  await advance(t);
  assert.deepEqual(sidebarRows(harness), ["→ ▾ Workflow · ⠦", "    ▾ plan · ⠦", "      • a · ⠦", "    ▾ review · ⠦", "      • b · ⠦"], "also a phase first listed by a later list");
  await leave(harness);
});

void test("a node listed before it has children that comes collapsed stays collapsed when a later list gives it its first child", async (t) => {
  timers(t);
  const root: Spec = { key: "run:R", kind: "run", label: "Workflow", state: "completed", expanded: false };
  const harness = await open([], { nodes: tree([root]) });
  assert.deepEqual(sidebarRows(harness), ["→   Workflow · ✓"]);
  harness.nodes = tree([root, { key: "a", parent: "run:R", agent: agent("a", { state: "completed", running: false }) }]);
  await advance(t, 5);
  assert.deepEqual(sidebarRows(harness), ["→ ▸ Workflow · ✓"], "collapsed, its first child hidden");
  await leave(harness);
});

void test("a node the user collapsed stays collapsed through lists that take its children away and give them back", async (t) => {
  timers(t);
  const root: Spec = { key: "run:R", kind: "run", label: "Workflow" };
  const plan: Spec = { key: "P", parent: "run:R", label: "plan" };
  const harness = await open([], { nodes: tree([root, plan, { key: "a", parent: "P", agent: agent("a") }]) });
  harness.send(KEY.left, KEY.left);
  await settle();
  assert.deepEqual(sidebarRows(harness), ["  ▾ Workflow · ⠦", "→   ▸ plan · ⠦"]);
  harness.nodes = tree([root, plan]);
  await advance(t);
  assert.deepEqual(sidebarRows(harness), ["  ▾ Workflow · ⠦", "→     plan · ⠦"]);
  harness.nodes = tree([root, plan, { key: "a", parent: "P", agent: agent("a") }, { key: "b", parent: "P", agent: agent("b") }]);
  // The list before showed no agent: the next one comes at the five-second tick.
  await advance(t, 5);
  assert.deepEqual(sidebarRows(harness), ["  ▾ Workflow · ⠦", "→   ▸ plan · ⠦"], "its children back, it stays as the user left it");
  harness.send(" ");
  assert.deepEqual(sidebarRows(harness), ["  ▾ Workflow · ⠦", "→   ▾ plan · ⠦", "      • a · ⠦", "      • b · ⠦"]);
  await leave(harness);
});

void test("the initial key selects its agent and expands its ancestors; without one the first agent node is selected and shown", async (t) => {
  timers(t);
  const collapsed = (): Spec[] => TREE().map((spec) => spec.key === "P" || spec.key === "subagents" ? { ...spec, expanded: false } : spec);
  const keyed = await open([], { nodes: tree(collapsed()), initialKey: "b" });
  assert.match(title(keyed), /^#2\/4 b/);
  assert.deepEqual(keyed.opened, ["b"]);
  assert.deepEqual(sidebarRows(keyed), ["  ▾ Workflow · ⠦", "    ▾ P · ⠦", "      ▾ O · ⠦", "        • a · ⠦", "→       • b · ✓", "      • c · ⠦", "  ▸ Subagents · ⠦"]);
  await leave(keyed);
  const subagent = await open([], { nodes: tree(collapsed()), initialKey: "s" });
  assert.match(title(subagent), /^#4\/4 s/);
  assert.deepEqual(sidebarRows(subagent).slice(-2), ["  ▾ Subagents · ⠦", "→   • s · ⠦"]);
  await leave(subagent);
  const first = await open([], { nodes: tree(collapsed()) });
  assert.match(title(first), /^#1\/4 a/);
  assert.ok(sidebarRows(first).includes("→       • a · ⠦"));
  await leave(first);
});

/** Two runs and the Subagents group: "build a1b2" with alpha over beta, "deploy c3d4" with gamma, then scout. */
const GROUPS = (): Listed[] => [agent("alpha"), agent("beta", { depth: 1 }), agent("gamma", { group: "deploy c3d4" }), agent("scout", { group: "Subagents" })];

void test("a rule above every top-level node but the first row; up, down and clicks never land on it; the rule fills the cell at 120 and 70 columns", async (t) => {
  timers(t);
  const rows = (cell: number): string[] => ["  ▾ build a1b2 · ⠦", "→   ▾ alpha · ⠦", "      • beta · ⠦", rule(cell), "  ▾ deploy c3d4 · ⠦", "    • gamma · ⠦", rule(cell), "  ▾ Subagents · ⠦", "    • scout · ⠦"];
  const harness = await open(GROUPS());
  const column = sidebarColumn(harness);
  assert.deepEqual(column.slice(0, 9), rows(42), "the rule fills the sidebar cell");
  assert.deepEqual(column.slice(9), column.slice(9).map(() => ""), "no rule elsewhere");
  const steps: string[] = [];
  for (const key of [KEY.down, KEY.down, KEY.down, KEY.down, KEY.up, KEY.up, KEY.up]) {
    harness.send(key);
    await settle();
    steps.push(title(harness).split(" ").slice(0, 2).join(" "));
  }
  assert.deepEqual(steps, ["#2/4 beta", "deploy c3d4", "#3/4 gamma", "Subagents running", "#3/4 gamma", "deploy c3d4", "#2/4 beta"], "up and down go from node to node over the rules");
  // A click on a rule, in the icon column or further right, changes nothing: not the selection, not the expansion, not the focus.
  harness.send(KEY.tab);
  const before = harness.screen();
  const opened = [...harness.opened];
  assert.match(before.at(-1) ?? "", /^up\/down scroll/);
  const ruleRow = before.findIndex((line) => line.startsWith("─"));
  assert.ok(ruleRow > 0);
  for (const column of [2, 4, 10]) {
    click(harness, column, ruleRow);
    await settle();
  }
  assert.deepEqual(harness.screen(), before);
  assert.deepEqual(harness.opened, opened);
  await leave(harness);

  const narrow = await open(GROUPS(), { columns: 70 });
  narrow.send("s");
  assert.deepEqual(sidebarColumn(narrow).slice(0, 9), rows(25), "the rule fills the narrower cell");
  await leave(narrow);
});

void test("a click on a row's ▾/▸ icon toggles and selects its node, a click elsewhere on the row only selects; space toggles a node with children and nothing else", async (t) => {
  timers(t);
  const harness = await open(GROUPS());
  // The screen row in the sidebar column: the title and the details pane name a selected node that is not an agent too.
  const row = (text: string): number => sidebarColumn(harness).findIndex((line) => line.includes(text)) + 1;
  // A header's icon is in column 2, as on every depth-0 row.
  click(harness, 2, row("deploy c3d4"));
  await settle();
  assert.equal(title(harness).trimEnd(), "deploy c3d4 running", "the click selected the header");
  assert.deepEqual(sidebarRows(harness).slice(3), ["→ ▸ deploy c3d4 · ⠦", "  ▾ Subagents · ⠦", "    • scout · ⠦"], "and collapsed it");
  click(harness, 2, row("deploy c3d4"));
  await settle();
  assert.deepEqual(sidebarRows(harness).slice(3, 5), ["→ ▾ deploy c3d4 · ⠦", "    • gamma · ⠦"], "a second click expands it again");
  // alpha is at depth 1: its icon is in column 4, its label after it.
  click(harness, 8, row("alpha"));
  await settle();
  assert.match(title(harness), /^#1\/4 alpha/, "a click on the label selects");
  assert.ok(sidebarRows(harness).includes("      • beta · ⠦"), "and toggles nothing");
  click(harness, 3, row("deploy c3d4"));
  await settle();
  assert.equal(title(harness).trimEnd(), "deploy c3d4 running", "a click beside the icon selects");
  assert.ok(sidebarRows(harness).includes("    • gamma · ⠦"), "and toggles nothing");
  click(harness, 4, row("alpha"));
  await settle();
  assert.match(title(harness), /^#1\/4 alpha/, "a click on the icon selects");
  assert.ok(!sidebarRows(harness).some((line) => line.includes("beta")), "and collapses");
  harness.send(" ");
  await settle();
  assert.ok(sidebarRows(harness).includes("      • beta · ⠦"), "space expands the selected node");
  harness.send(" ");
  await settle();
  assert.ok(!sidebarRows(harness).some((line) => line.includes("beta")), "space collapses it");
  assert.match(title(harness), /^#1\/4 alpha/, "and keeps it selected");
  harness.send(" ", KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/4 beta/);
  const leaf = harness.screen();
  harness.send(" ");
  await settle();
  assert.deepEqual(harness.screen(), leaf, "space on a leaf does nothing");
  // The • of a leaf sits in the icon column: a click there only selects.
  click(harness, 4, row("gamma"));
  await settle();
  assert.match(title(harness), /^#3\/4 gamma/);
  assert.ok(sidebarRows(harness).includes("→   • gamma · ⠦"));
  harness.send(KEY.up, KEY.tab, " ");
  await settle();
  assert.equal(title(harness).trimEnd(), "deploy c3d4 running");
  assert.ok(sidebarRows(harness).includes("    • gamma · ⠦"), "space toggles only while the sidebar has the focus");
  await leave(harness);
});

void test("a node's initial expansion counts the first time a list contains it: a run that finishes stays expanded, a new finished run comes collapsed, a new running one expanded", async (t) => {
  timers(t);
  const run = (key: string, state: RunState, expanded: boolean): Spec[] => [
    { key: `run:${key}`, kind: "run", label: key, state, expanded },
    { key: key.toLowerCase(), parent: `run:${key}`, agent: agent(key.toLowerCase(), state === "running" ? {} : { state: "completed", running: false }) },
  ];
  // S holds the agent selected on open, so its expansion is the reveal's; A's is its own.
  const harness = await open([], { nodes: tree([...run("S", "running", true), ...run("A", "running", true)]) });
  assert.deepEqual(sidebarRows(harness), ["  ▾ S · ⠦", "→   • s · ⠦", "  ▾ A · ⠦", "    • a · ⠦"]);
  harness.nodes = tree([...run("S", "running", true), ...run("A", "completed", false), ...run("B", "completed", false), ...run("C", "running", true)]);
  await advance(t);
  assert.deepEqual(sidebarRows(harness), ["  ▾ S · ⠦", "→   • s · ⠦", "  ▾ A · ✓", "    • a · ✓", "  ▸ B · ✓", "  ▾ C · ⠦", "    • c · ⠦"], "A finished while shown and stays expanded");
  harness.nodes = tree([...run("S", "running", true), ...run("A", "completed", false), ...run("B", "running", true), ...run("C", "completed", false)]);
  await advance(t);
  assert.deepEqual(sidebarRows(harness), ["  ▾ S · ⠦", "→   • s · ⠦", "  ▾ A · ✓", "    • a · ✓", "  ▸ B · ⠦", "  ▾ C · ✓", "    • c · ✓"], "a later list changes the expansion of no node already seen");
  await leave(harness);
});

void test("the initial key on an agent of a finished, collapsed run expands its ancestors; the other finished runs stay collapsed", async (t) => {
  timers(t);
  const done = { state: "completed", running: false } as const;
  const harness = await open([], { initialKey: "b", nodes: tree([
    { key: "run:A", kind: "run", label: "A" },
    { key: "a", parent: "run:A", agent: agent("a") },
    { key: "run:B", kind: "run", label: "B", state: "completed", expanded: false },
    { key: "P", parent: "run:B", label: "plan", state: "completed", expanded: false },
    { key: "b", parent: "P", agent: agent("b", done) },
    { key: "run:C", kind: "run", label: "C", state: "completed", expanded: false },
    { key: "c", parent: "run:C", agent: agent("c", done) },
  ]) });
  assert.match(title(harness), /^#2\/3 b completed/);
  assert.deepEqual(harness.opened, ["b"]);
  assert.deepEqual(sidebarRows(harness), ["  ▾ A · ⠦", "    • a · ⠦", "  ▾ B · ✓", "    ▾ plan · ✓", "→     • b · ✓", "  ▸ C · ✓"]);
  await leave(harness);
});

void test("on a short terminal the sidebar keeps the selected row in view, rules counted", async (t) => {
  timers(t);
  const harness = await open(Array.from({ length: 6 }, (_, index) => agent(`a${String(index)}`, { group: `g${String(index)}` })), { rows: 7 });
  const selected = (): string | undefined => sidebarColumn(harness).find((line) => line.startsWith("→"));
  assert.deepEqual(sidebarColumn(harness), ["  ▾ g0 · ⠦", "→   • a0 · ⠦", rule(42), "  ▾ g1 · ⠦", "    • a1 · ⠦"]);
  const seen: string[][] = [];
  // Every node down to the last and round to the first, then back up, then ] and [ across the runs.
  for (const key of [...Array.from({ length: 12 }, () => KEY.down), ...Array.from({ length: 12 }, () => KEY.up), "]", "]", "]", "[", "[", "[", "[", "["]) {
    harness.send(key);
    await settle();
    const column = sidebarColumn(harness);
    seen.push(column);
    assert.ok(selected(), `the selected row is in view after ${String(seen.length)} keys:\n${column.join("\n")}`);
  }
  assert.ok(seen.some((column) => column.some((line) => /^─+$/.test(line))), "with rules in view");
  assert.equal(seen[9]?.at(-1), "→   • a5 · ⠦", "the last node at the bottom");
  assert.deepEqual(seen[10]?.slice(0, 2), ["→ ▾ g0 · ⠦", "    • a0 · ⠦"], "down went round to the first run, at the top without a rule");
  await leave(harness);
});

void test("with the sidebar focused the hint names the fold and agent keys; with the transcript focused it is as before", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { columns: 200 });
  const hint = (): string => (harness.screen().at(-1) ?? "").trimEnd();
  assert.equal(hint(), "left/right fold · escape/ctrl+c back · [ ] agent · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools");
  harness.send(KEY.tab);
  assert.equal(hint(), "up/down scroll · escape/ctrl+c back · [ ] agent · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools");
  await leave(harness);
});

void test("a run's sidebar rows are its /workflow tree rows, its nodes show the /workflow details, also beside the sidebar at 70 columns", async (t) => {
  timers(t);
  const { home, cwd } = project("agents-workspace");
  const now = Date.now();
  const model = { provider: "openai", model: "gpt" };
  const record = (id: string, state: AgentRecord["state"], extra: Partial<AgentRecord> = {}): AgentRecord => ({ id, name: id, path: id, state, model, tools: [], attempts: 1, attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: `${id}-1` }, setup: { hookNames: [], model, tools: [], cwd }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }], ...extra });
  const store = await createRun({ home, cwd }, "run", "running", { workflowName: "review flow", phase: "review", phaseHistory: [{ phase: "plan", afterAgent: 0 }, { phase: "review", afterAgent: 1 }], agents: [
    record("planner", "completed", { label: "Planner", startedAt: now - 60_000, durationMs: 20_000 }),
    record("api", "running", { structuralPath: ["p", "a"], startedAt: now - 30_000 }),
    record("helper", "queued", { parentId: "api", structuralPath: ["p", "a"] }),
    record("ui", "completed", { structuralPath: ["p", "b"], startedAt: now - 25_000, durationMs: 10_000 }),
  ] }, launch({ phases: ["plan", "review", "ship"] }));
  const overlayRun = (run: PersistedRun): PersistedRun => ({ ...run, activeShellsByPhase: [{ phaseIndex: 1, active: 2, startedAt: now - 3000 }] });
  // A running run's header shows its runtime once it has run a second: a creation time ahead of the clock keeps "1s" out under load.
  const summaryPath = join(store.directory, "summary.json");
  writeFileSync(summaryPath, JSON.stringify({ ...JSON.parse(readFileSync(summaryPath, "utf8")) as object, createdAt: new Date(now + 3_600_000).toISOString() }));
  const context = { cwd, sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionCommandContext;
  const source = createSessionAgentsSource(context, { home, overlayRun, liveAgent: () => undefined, subagents: () => undefined });
  const loaded = await store.load();
  const dashboard = formatWorkflowPhaseDashboard(overlayRun(loaded.run), loaded.snapshot, 70, { treeOnly: true, nodeId: "phase/plan%231/agent/planner" });
  const rows = dashboard.slice(dashboard.indexOf("Tree") + 1);
  const harness = await open([], { source, rows: 24 });
  await opened(harness);
  assert.match(title(harness), /^#1\/4 Planner completed/);
  // The /workflow rows one level deeper, the first agent selected; the root is a header that names the run, as the sidebar can hold several.
  assert.deepEqual(rows.slice(0, 3), ["  ▾ Workflow · ⠦", "  ▾ plan · ✓", "→   • Planner · ✓"]);
  assert.deepEqual(sidebarRows(harness), ["  ▾ review flow run  ⠦ 2/4 agents", ...rows.slice(1).map((row) => `${row.slice(0, 2)}  ${row.slice(2)}`)]);
  harness.send(KEY.down);
  await settle();
  const lines = harness.screen();
  assert.equal((lines[0] ?? "").trimEnd(), "review running");
  const details = lines.slice(1, 9).map((line) => line.slice(line.indexOf("│") + 1).trim());
  assert.deepEqual(details.slice(0, 4), ["Selected phase: review", "Status: running", "agents completed=1 running=1 failed=0 cancelled=0 pending=1", "Agents: 3"]);
  assert.ok(details.some((line) => line.startsWith("Elapsed:")), "the phase's usage");
  assert.ok(!lines.some((line) => line.includes("enter ")), "without the /workflow enter hints");
  assert.deepEqual(harness.opened, ["run:run:planner"]);
  await leave(harness);

  const narrow = await open([], { source, columns: 70, rows: 24 });
  await opened(narrow);
  narrow.send("s");
  for (const step of [KEY.down, KEY.up, KEY.up, KEY.up]) {
    narrow.send(step);
    await settle();
  }
  assert.equal(title(narrow).trimEnd(), "review flow run running");
  assert.ok(narrow.screen().some((line) => line.includes("Selected workflow: review")), "the details wrap beside the sidebar");
  await leave(narrow);
});

void test("an exit listener restores the terminal while the workspace is open, and is gone once it closes", async (t) => {
  timers(t);
  const known = process.listeners("exit");
  const added = (): NodeJS.ExitListener[] => process.listeners("exit").filter((listener) => !known.includes(listener));
  const closed = await open([agent("alpha")]);
  assert.equal(added().length, 1, "one listener while the workspace is open");
  await leave(closed);
  assert.deepEqual(added(), [], "removed when the workspace closes");
  const crashed = await open([agent("alpha")]);
  const [listener] = added();
  assert.ok(listener);
  // process.exit() after an uncaught exception runs the exit listeners; only this one is run here.
  listener(1);
  assert.ok(crashed.terminal.written.endsWith(`${ESC}[?1049l${ESC}[?25h${ESC}[?2026l`), "left the alternate screen with nothing written after it");
  process.off("exit", listener);
});

void test("an uncaughtExceptionMonitor listener restores the terminal before Pi prints the crash, takes the exit listener with it, cannot throw, and is gone once the workspace closes", async (t) => {
  timers(t);
  const knownExit = process.listeners("exit");
  const knownMonitor = process.listeners("uncaughtExceptionMonitor");
  const exits = (): NodeJS.ExitListener[] => process.listeners("exit").filter((listener) => !knownExit.includes(listener));
  const monitors = (): NodeJS.UncaughtExceptionListener[] => process.listeners("uncaughtExceptionMonitor").filter((listener) => !knownMonitor.includes(listener));
  const closed = await open([agent("alpha")]);
  assert.equal(monitors().length, 1, "one monitor while the workspace is open");
  await leave(closed);
  assert.deepEqual(monitors(), [], "removed when the workspace closes");
  const crashed = await open([agent("alpha")]);
  const [monitor] = monitors();
  assert.ok(monitor);
  // Node runs the monitors before Pi's 'uncaughtException' handler prints the crash and exits; only this one is run here.
  monitor(new Error("boom"), "uncaughtException");
  assert.ok(crashed.terminal.written.endsWith(`${ESC}[?1049l${ESC}[?25h${ESC}[?2026l`), "left the alternate screen with nothing written after it");
  assert.deepEqual([exits(), monitors()], [[], []], "the exit that follows the crash does not restore again");
  // A throw from a monitor would make Node exit with code 7 before Pi's handler restores Pi's terminal and prints the crash.
  const failing = await open([agent("alpha")]);
  const [unstoppable] = monitors();
  assert.ok(unstoppable);
  failing.terminal.failStop = new Error("setRawMode EIO");
  assert.doesNotThrow(() => { unstoppable(new Error("boom"), "uncaughtException"); });
  assert.deepEqual([exits(), monitors()], [[], []]);
});

void test("with no agent node the first node is selected", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree([{ key: "run:R", kind: "run", label: "Workflow" }, { key: "P", parent: "run:R" }, { key: "Q", parent: "P", kind: "operation" }]) });
  assert.equal(title(harness).trimEnd(), "Workflow running");
  assert.deepEqual(sidebarRows(harness), ["→ ▾ Workflow · ⠦", "    ▾ P · ⠦", "        Q · ⠦"]);
  assert.match(harness.screen()[1] ?? "", /│ details of Workflow\s*$/);
  assert.deepEqual(harness.opened, []);
  await leave(harness);
});

void test("j, k, h and l move in the sidebar as the arrows do, and only there", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TREE()) });
  const moves: string[] = [];
  for (const key of ["k", "k", "j", "h", "h", "l", "l", "j"]) {
    harness.send(key);
    await settle();
    moves.push(sidebarRows(harness).find((line) => line.startsWith("→")) ?? "");
  }
  assert.deepEqual(moves, ["→     ▾ O · ⠦", "→   ▾ P · ⠦", "→     ▾ O · ⠦", "→     ▸ O · ⠦", "→   ▾ P · ⠦", "→     ▸ O · ⠦", "→     ▾ O · ⠦", "→       • a · ⠦"]);
  harness.send(KEY.tab, "k", "h", "j", "l");
  await settle();
  assert.match(title(harness), /^#1\/4 a/, "with the transcript focused they move nothing");
  await leave(harness);
});

void test("the hint names tab focus while the sidebar shows", async (t) => {
  timers(t);
  const harness = await open([], { columns: 160, nodes: tree(TREE()) });
  const hint = (): string => (harness.screen().at(-1) ?? "").trimEnd();
  assert.equal(hint(), "left/right fold · escape/ctrl+c back · [ ] agent · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools");
  harness.send(KEY.tab);
  assert.equal(hint(), "up/down scroll · escape/ctrl+c back · [ ] agent · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools");
  harness.send("s");
  assert.equal(hint(), "up/down scroll · escape/ctrl+c back · [ ] agent · ctrl+shift+f search · s sidebar · ctrl+o tools", "no tab focus without the sidebar");
  await leave(harness);

});

void test("a live event replayed while an agent opens that throws is reported in the title", async (t) => {
  timers(t);
  const live = new FakeLive();
  live.replay.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
  const harness = await open([agent("alpha"), agent("beta", { live })], { failLive: "beta" });
  harness.send(KEY.down);
  assert.match(title(harness), /agents workspace failed: live failed/);
  await leave(harness);
});

void test("the hint names the keys the user's bindings resolve to", async (t) => {
  timers(t);
  const custom = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } }, { "tui.select.up": "u", "tui.select.down": "d", "tui.select.cancel": "ctrl+q", "tui.select.confirm": "ctrl+e", "tui.editor.cursorLeft": "h", "tui.editor.cursorRight": "l" }) as unknown as typeof KEYBINDINGS;
  const harness = await open([agent("alpha")], { keybindings: custom });
  const hint = (): string => (harness.screen().at(-1) ?? "").trimEnd();
  assert.match(hint(), /h\/l fold/, "the sidebar's fold pair follows the bindings");
  harness.send(KEY.tab);
  assert.equal(hint(), "u/d scroll · ctrl+q back · [ ] agent · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools");
  await leave(harness);
});

void test("the sidebar and transcript split at 80, 120 and 200 columns is the navigator's", async (t) => {
  timers(t);
  for (const [columns, sidebar] of [[80, 29], [120, 42], [200, 42]] as const) {
    assert.equal(navigatorSidebarWidth(columns), sidebar, "the shared helper");
    const harness = await open([agent("alpha")], { columns, setup: (source) => { source.polls.push(polled(entries(1, 3))); } });
    const line = harness.screen().find((row) => row.includes("alpha record 1")) ?? "";
    assert.equal(line.indexOf("│ alpha record 1"), sidebar + 1, `the separator follows ${String(sidebar)} sidebar columns at ${String(columns)}`);
    assert.equal(visibleWidth(line), columns);
    await leave(harness);
  }
});
