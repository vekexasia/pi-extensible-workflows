import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import type { ActionUi, AgentsAction, AgentsActionProvider, AgentsActionTarget } from "../src/agents-actions-contract.js";
import { formatWorkflowPhaseDashboard, PLAIN_WORKFLOW_PROGRESS_STYLES, type AgentRecord, type PersistedRun, type RunState } from "../src/index.js";
import { openAgentsWorkspace, type AgentsWorkspaceState } from "../src/agents-workspace.js";
import { FakeTerminal } from "./agents-workspace-harness.js";
import { navigatorSidebarWidth } from "../src/host-view.js";
import { createSessionAgentsSource, type SessionTreeNode } from "../src/session-agents.js";
import type { SubagentManager } from "../subagents/src/contracts.js";
import { advance, agent, createRun, KEYBINDINGS, launch, click, entries, entry, ESC, escapes, FakeLive, KEY, leave, menu, MENU_HEADING, menuRows, nodesOf, open, opened, paste, polled, polls, rowOf, rule, settle, sidebarColumn, sidebarRows, statusRow as status, timers, title as titleRow, topRow, project, temporary, tree, until, type FakePi, type Listed, type Spec } from "./agents-workspace-harness.js";

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

/** The title row without the session totals at its right end. */
function title(pi: FakePi): string { return titleRow(pi).replace(/ {2,}\d+\/\d+ running.*$/, ""); }

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

void test("the title shows the persisted average of an agent, else nothing", async (t) => {
  timers(t);
  const speed = { messages: 2, outputTokens: 100, generationMs: 4_000, firstTokenMs: 600 };
  const cases: readonly [Listed, RegExp][] = [
    [agent("alpha", { speed }), /^#1\/1 alpha running gpt-5 1\.2k tok 25\.0 tok\/s avg/],
    [agent("alpha", { speed, state: "completed", running: false }), /^#1\/1 alpha completed gpt-5 1\.2k tok 25\.0 tok\/s avg/],
    [agent("alpha"), /^#1\/1 alpha running gpt-5 1\.2k tok\s*$/],
  ];
  for (const [listed, expected] of cases) {
    const harness = await open([listed], { columns: 120, setup: (source) => { source.polls.push(polled(entries(0, 1))); } });
    assert.match(title(harness).replace(/\s+\d+\/\d+ running.*$/, ""), expected);
    await leave(harness);
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
  assert.equal((lines.at(-1) ?? "").trimEnd(), "left/right fold · escape/ctrl+c back · f follow · [ ] agent · / filter · tab focus · ctrl+shift+f search · s sidebar · …", "at 120 columns the hint loses only ctrl+o tools, Pi's own key");
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
  wide.send("/");
  const filtered = wide.screen();
  assert.ok(filtered[2 + Math.floor((50 - 3) / 3)]?.startsWith("a0 record"), "with the filter row open the tree takes a third of the smaller body");
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
  assert.equal(harness.exit, undefined);
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
  assert.equal((lines[0] ?? "").replace(/ {2,}\d+\/\d+ running.*$/, ""), "O running", "the title is the node's label and state");
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

void test("with the sidebar focused the hint names the fold, agent and filter keys; with the transcript focused it is as before", async (t) => {
  timers(t);
  const harness = await open(AGENTS(), { columns: 200 });
  const hint = (): string => (harness.screen().at(-1) ?? "").trimEnd();
  // alpha runs, so f is named before follow is on.
  assert.equal(hint(), "left/right fold · escape/ctrl+c back · f follow · [ ] agent · / filter · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools");
  harness.send(KEY.tab);
  assert.equal(hint(), "up/down scroll · escape/ctrl+c back · f follow · [ ] agent · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools");
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
  assert.deepEqual(sidebarRows(harness), ["  ▾ review flow run  ⠦ 2/4", ...rows.slice(1).map((row) => `${row.slice(0, 2)}  ${row.slice(2)}`)]);
  harness.send(KEY.down);
  await settle();
  const lines = harness.screen();
  assert.equal((lines[0] ?? "").replace(/ {2,}\d+\/\d+ running.*$/, ""), "review running");
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

void test("the run's, a phase's and the Subagents group's timelines are laid out at the pane's width: at 48 and 120 columns no timeline row wraps", async (t) => {
  timers(t);
  const { home, cwd } = project("agents-workspace");
  const now = Date.now();
  const model = { provider: "openai", model: "gpt" };
  const record = (id: string, state: AgentRecord["state"], extra: Partial<AgentRecord> = {}): AgentRecord => ({ id, name: id, path: id, state, model, tools: [], attempts: 1, ...extra });
  await createRun({ home, cwd }, "run", "running", { workflowName: "wide", phase: "review", phaseHistory: [{ phase: "plan", afterAgent: 0 }, { phase: "review", afterAgent: 1 }], agents: [
    record("planner-with-a-long-name", "completed", { startedAt: now - 60_000, durationMs: 20_000 }),
    record("reviewer", "running", { startedAt: now - 30_000 }),
    record("helper", "queued"),
  ] }, launch({ phases: ["plan", "review"] }));
  const statuses = [{ id: "sub-a", sessionId: "session", state: "completed", startedAt: now - 50_000, finishedAt: now - 10_000 }, { id: "sub-b", sessionId: "session", state: "running", startedAt: now - 20_000 }];
  const manager: SubagentManager = {
    inspect: async (request) => request.id === undefined ? statuses : statuses.find(({ id }) => id === request.id),
    run: async () => { throw new Error("unexpected"); }, steer: async () => { throw new Error("unexpected"); }, stop: async () => { throw new Error("unexpected"); }, retry: async () => { throw new Error("unexpected"); },
  };
  const context = { cwd, sessionManager: { getSessionId: () => "session" } } as unknown as ExtensionCommandContext;
  const source = createSessionAgentsSource(context, { home, overlayRun: (run) => run, liveAgent: () => undefined, subagents: () => manager });
  const phase = (await source.list()).find((node) => node.kind === "phase" && node.title(PLAIN_WORKFLOW_PROGRESS_STYLES).startsWith("review"))?.key;
  assert.ok(phase);
  // Each timeline row ends with its glyph or "queued"; a row laid out wider than the pane would wrap into a part without one.
  const timelineRows = (screen: readonly string[], count: number): string[] => {
    const pane = screen.map((line) => (line.includes(" │ ") ? line.slice(line.indexOf(" │ ") + 3) : line).replace(/[\s┃█]+$/, ""));
    const start = pane.findIndex((line) => line.startsWith("Timeline"));
    assert.ok(start >= 0, screen.join("\n"));
    return pane.slice(start + 1, start + 1 + count);
  };
  for (const [columns, rows] of [[48, 70], [120, 40]] as const) {
    for (const [key, count] of [["run:run", 3], [phase, 2], ["subagents", 2]] as const) {
      const harness = await open([], { source, columns, rows, initialKey: key });
      for (let tries = 0; !harness.screen().some((line) => line.includes("Timeline")) && tries < 200; tries++) await new Promise((resolve) => setTimeout(resolve, 25));
      const screen = harness.screen();
      for (const row of timelineRows(screen, count)) assert.match(row, /(?:[✓⠦]|queued)$/, `${key} at ${String(columns)}: ${screen.join("\n")}`);
      await leave(harness);
    }
  }
});

function describeTarget(target: AgentsActionTarget): string {
  switch (target.kind) {
    case "run": return `run:${target.runId}`;
    case "workflow-agent": return `agent:${target.runId}/${target.agentId}`;
    case "subagent": return `subagent:${target.id}`;
    case "subagents": return "subagents";
  }
}
/** A provider whose labels the test sets by target kind; it records each run as "<target> <label>" and runs `onRun` for it. */
class FakeProvider implements AgentsActionProvider {
  readonly runs: string[] = [];
  /** The actions() calls so far. */
  reads = 0;
  /** The next actions() call waits for it, then reads the labels. */
  hold: Promise<void> | undefined;
  /** Every actions() call rejects with it while set. */
  failure: Error | undefined;
  constructor(public labels: Partial<Record<AgentsActionTarget["kind"], readonly AgentsAction[]>>, readonly onRun: (label: string, ui: ActionUi) => Promise<void> | void = () => undefined) {}
  async actions(target: AgentsActionTarget): Promise<readonly AgentsAction[]> {
    this.reads += 1;
    const hold = this.hold;
    if (hold) await hold;
    if (this.failure) throw this.failure;
    return this.labels[target.kind] ?? [];
  }
  async run(target: AgentsActionTarget, label: string, ui: ActionUi): Promise<{ readonly select?: string }> {
    this.runs.push(`${describeTarget(target)} ${label}`);
    await this.onRun(label, ui);
    return {};
  }
}
function steps(...labels: string[]): AgentsAction[] { return labels.map((label) => ({ label })); }
function inPlace(...labels: string[]): AgentsAction[] { return labels.map((label) => ({ label, inPlace: true })); }
const RUN: AgentsActionTarget = { kind: "run", runId: "R" };
/** TREE with the targets the session source gives: the run's nodes the run, its agents themselves, the group and its subagent. */
const TARGETED = (): Spec[] => TREE().map((spec): Spec => ({ ...spec, target: spec.key === "subagents" ? { kind: "subagents" } : spec.key === "s" ? { kind: "subagent", id: "s" } : spec.agent ? { kind: "workflow-agent", runId: "R", agentId: spec.key } : RUN }));
/** TARGETED with the run's nodes on run `runId`: the target their menu reads changes. */
const RETARGETED = (runId: string): SessionTreeNode[] => tree(TARGETED().map((spec): Spec => spec.target?.kind === "run" ? { ...spec, target: { kind: "run", runId } } : spec));

void test("a opens the action menu on every node with a target, titled by its kind, with every provider's labels in provider order", async (t) => {
  timers(t);
  const first = new FakeProvider({ run: steps("Pause", "Stop"), "workflow-agent": inPlace("Copy agent ID"), subagent: steps("Steer"), subagents: steps("Delete all completed") });
  const second = new FakeProvider({ run: steps("Model aliases"), subagent: inPlace("Copy branch") });
  const specs = TARGETED().map((spec) => spec.key === "c" ? { key: spec.key, parent: "P", agent: agent("c") } : spec);
  const harness = await open([], { nodes: tree(specs), actions: [first, second] });
  const opened = async (keys: readonly string[]): Promise<string[]> => {
    harness.send(...keys, "a");
    await settle();
    const rows = menuRows(harness);
    harness.send(KEY.escape);
    await settle();
    assert.deepEqual(menu(harness), [], "esc closed the menu");
    return rows;
  };
  assert.deepEqual(await opened([]), ["Agent actions", "→ Copy agent ID"], "on a workflow agent");
  assert.equal(harness.left, false, "esc closed only the menu");
  assert.deepEqual(await opened([KEY.up]), ["Run actions", "→ Pause", "  Stop", "  Model aliases"], "on an operation scope");
  assert.deepEqual(await opened([KEY.up]), ["Run actions", "→ Pause", "  Stop", "  Model aliases"], "on a phase");
  assert.deepEqual(await opened([KEY.up]), ["Run actions", "→ Pause", "  Stop", "  Model aliases"], "on the run header");
  assert.equal(title(harness).trimEnd(), "Workflow running");
  harness.send(KEY.down, KEY.down, KEY.down, KEY.down, KEY.down);
  await settle();
  assert.match(title(harness), /^#3\/4 c/);
  harness.send("a");
  await settle();
  assert.deepEqual(menu(harness), [], "no menu on a node without a target");
  assert.equal(harness.alt().hasOverlay(), false);
  assert.deepEqual(await opened([KEY.down]), ["Subagents", "→ Delete all completed"], "on the group");
  assert.deepEqual(await opened([KEY.down, KEY.tab]), ["Subagent actions", "→ Steer", "  Copy branch"], "on a subagent, with the transcript focused");
  assert.deepEqual([...first.runs, ...second.runs], []);
  await leave(harness);
});

void test("the menu shows loading… until the labels come and no actions when there are none", async (t) => {
  timers(t);
  let release = (): void => undefined;
  const provider = new FakeProvider({ run: steps("Pause") });
  provider.hold = new Promise<void>((resolve) => { release = resolve; });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider] });
  harness.send("a");
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "loading…"]);
  harness.send(KEY.enter);
  await settle();
  assert.equal(harness.left, false, "enter does nothing while the labels load");
  provider.hold = undefined;
  release();
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Pause"]);
  harness.send(KEY.escape, KEY.down, KEY.down, KEY.down, KEY.down, "a");
  await settle();
  assert.equal(title(harness).trimEnd(), "Subagents running");
  assert.deepEqual(menuRows(harness), ["Subagents", "no actions"]);
  harness.send(KEY.enter);
  await settle();
  assert.equal(harness.left, false);
  await leave(harness);
});

void test("labels that cannot be read show actions unavailable and take no key; they are read again once the node's target or state changes", async (t) => {
  timers(t);
  const provider = new FakeProvider({ run: steps("Pause", "Stop") });
  provider.failure = new Error("store locked");
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider] });
  harness.send("a");
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "actions unavailable: store locked"], "at the first read");
  harness.send(KEY.enter);
  await settle();
  assert.equal(harness.left, false, "enter runs nothing");
  provider.failure = undefined;
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "actions unavailable: store locked"], "a refresh with the same target reads nothing");
  harness.nodes = tree(TARGETED().map((spec): Spec => spec.key === "O" ? { ...spec, state: "paused" } : spec));
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Pause", "  Stop"], "the labels of the node's new state");
  harness.send(KEY.down);
  provider.failure = new Error("store gone");
  harness.nodes = RETARGETED("R3");
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "actions unavailable: store gone"], "a failed read shows its error instead of the labels it read before");
  harness.send(KEY.up, KEY.enter);
  await settle();
  assert.equal(harness.left, false, "enter runs nothing");
  provider.failure = undefined;
  harness.nodes = RETARGETED("R4");
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "  Pause", "→ Stop"], "the next read keeps the label selected before");
  assert.deepEqual(provider.runs, []);
  await leave(harness);
});

void test("a provider whose labels cannot be read costs only its own: the others' labels show in provider order and take the keys, then a row with its error", async (t) => {
  timers(t);
  const first = new FakeProvider({ run: steps("Pause", "Stop") });
  const second = new FakeProvider({ run: steps("Model aliases") });
  const third = new FakeProvider({ run: steps("Delete all completed") });
  second.failure = new Error("aliases locked");
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [first, second, third] });
  harness.send("a");
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Pause", "  Stop", "  Delete all completed", "actions unavailable: aliases locked"], "the labels read, then the error");
  harness.send(KEY.up);
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "  Pause", "  Stop", "→ Delete all completed", "actions unavailable: aliases locked"], "↑ wraps over the labels, not onto the error row");
  second.failure = undefined;
  harness.nodes = RETARGETED("R2");
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "  Pause", "  Stop", "  Model aliases", "→ Delete all completed"], "a read that gets them puts them in provider order and keeps the selected label");
  harness.send(KEY.up);
  first.failure = new Error("store gone");
  harness.nodes = RETARGETED("R3");
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Model aliases", "  Delete all completed", "actions unavailable: store gone"], "the selected label of a provider still read stays selected");
  harness.send(KEY.enter);
  await harness.done;
  assert.deepEqual(harness.exit && { target: harness.exit.target, label: harness.exit.label }, { target: { kind: "run", runId: "R3" }, label: "Model aliases" }, "enter runs it");
  assert.deepEqual([...first.runs, ...second.runs, ...third.runs], []);
});

void test("enter with the sidebar focused opens the menu on a node that is not an agent; on an agent it opens none", async (t) => {
  timers(t);
  const provider = new FakeProvider({ run: steps("Pause"), "workflow-agent": steps("Stop") });
  const harness = await open([], { nodes: tree(TARGETED()), actions: [provider], setup: (source) => { source.polls.push(polled([entry(0)])); } });
  assert.match(title(harness), /^#1\/4 a/);
  harness.send(KEY.enter);
  await settle();
  assert.deepEqual(menu(harness), [], "no menu on an agent");
  harness.send(KEY.up, KEY.enter);
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Pause"], "enter on the operation scope");
  harness.send(KEY.escape, KEY.tab, KEY.enter);
  await settle();
  assert.deepEqual(menu(harness), [], "not with the transcript focused");
  harness.send("a");
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Pause"], "a still opens it there");
  await leave(harness);
});

void test("without providers a does nothing, enter on a node that is not an agent does nothing, and the hint names no menu", async (t) => {
  timers(t);
  for (const actions of [undefined, []]) {
    const harness = await open([], { nodes: tree(TARGETED()), ...(actions === undefined ? {} : { actions }) });
    harness.send("a");
    await settle();
    assert.equal(harness.alt().hasOverlay(), false);
    harness.send(KEY.up, KEY.enter, "a");
    await settle();
    assert.equal(harness.alt().hasOverlay(), false);
    assert.equal(title(harness).trimEnd(), "O running");
    assert.doesNotMatch(harness.screen().at(-1) ?? "", /a menu/);
    await leave(harness);
  }
});

void test("in the menu ↑↓ and j/k move round, other keys belong to it, esc, ← and h close it, and ctrl+c leaves with no action", async (t) => {
  timers(t);
  const provider = new FakeProvider({ run: steps("One", "Two", "Three") });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider] });
  const selected = (): string | undefined => menuRows(harness).find((line) => line.startsWith("→ "));
  harness.send("a");
  await settle();
  const moves: (string | undefined)[] = [];
  for (const key of [KEY.down, "j", "j", "k", KEY.up, KEY.up]) {
    harness.send(key);
    moves.push(selected());
  }
  assert.deepEqual(moves, ["→ Two", "→ Three", "→ One", "→ Three", "→ Two", "→ One"]);
  harness.send("s", "q", KEY.tab, "]", " ", KEY.right, "l", KEY.pageDown);
  await settle();
  assert.equal(selected(), "→ One", "the menu kept the keys");
  assert.ok(harness.screen().some((line) => line.startsWith("  ▾ Subagents")), "s did not hide the sidebar");
  assert.equal(title(harness).trimEnd(), "O running", "] selected nothing");
  for (const close of [KEY.escape, KEY.left, "h"]) {
    harness.send(close);
    await settle();
    assert.deepEqual(menu(harness), [], `${JSON.stringify(close)} closed the menu`);
    assert.equal(title(harness).trimEnd(), "O running", "and moved nothing");
    harness.send("a");
    await settle();
    assert.equal(selected(), "→ One", "the menu opens on the first label again");
  }
  harness.send(KEY.ctrlC);
  await harness.done;
  assert.equal(harness.exit, undefined, "ctrl+c leaves with no action");
  assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"]);
  assert.deepEqual(provider.runs, []);
});

/** A wheel step up (SGR) at the 0-based screen `column` and `row`. */
function wheelUp(column: number, row: number): string { return `${ESC}[<64;${String(column + 1)};${String(row + 1)}M`; }

void test("while the menu is open the search key, the page keys, home and end (also as tmux sends them), a paste and the wheel do nothing: no other overlay, the transcript stays where it was", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TARGETED()), actions: [new FakeProvider({ "workflow-agent": steps("One", "Two") })], setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  harness.screen();
  const end = harness.alt().viewportTop;
  assert.ok(end > 0, "the transcript is longer than the pane");
  harness.send("a");
  await settle();
  harness.send(KEY.search, "x", KEY.pageUp, KEY.pageUp, KEY.home, KEY.homeTmux, KEY.endTmux, paste("k"), "é", wheelUp(110, 5), wheelUp(5, 5), KEY.down);
  await settle();
  harness.screen();
  assert.equal(harness.alt().viewportTop, end, "the transcript did not scroll");
  assert.equal(harness.alt().isFollowingOutput, true);
  assert.deepEqual(menuRows(harness), ["Agent actions", "  One", "→ Two"], "the menu had the keys");
  harness.send(KEY.escape);
  await settle();
  assert.deepEqual(menu(harness), [], "esc closed the menu");
  assert.equal(harness.alt().hasOverlay(), false, "and no search box was left under it");
  assert.equal(harness.left, false);
  harness.send(KEY.pageUp);
  harness.screen();
  assert.ok(harness.alt().viewportTop < end, "the page keys scroll again once it closed");
  await leave(harness);
});

void test("Pi's terminal object keeps its own methods before, while and after the workspace has it, and the page keys still do nothing under the menu", async (t) => {
  timers(t);
  const prototype = FakeTerminal.prototype;
  const methods = Object.getOwnPropertyNames(prototype).filter((name) => name !== "constructor" && typeof Object.getOwnPropertyDescriptor(prototype, name)?.value === "function");
  const start = Object.getOwnPropertyDescriptor(prototype, "start");
  assert.ok(start);
  // What the terminal's start is while it runs: the alt screen starts the terminal from inside the workspace's opening.
  const starting: unknown[] = [];
  const spy = function (this: FakeTerminal, ...args: Parameters<FakeTerminal["start"]>): void { starting.push(Reflect.get(this, "start")); Reflect.apply(start.value as FakeTerminal["start"], this, args); };
  Object.defineProperty(prototype, "start", { ...start, value: spy });
  t.after(() => { Object.defineProperty(prototype, "start", start); });
  const own = (terminal: FakeTerminal): unknown[] => methods.map((name): unknown => Reflect.get(terminal, name));
  const expected = methods.map((name): unknown => Object.getOwnPropertyDescriptor(prototype, name)?.value);
  const harness = await open([], { nodes: tree(TARGETED()), actions: [new FakeProvider({ "workflow-agent": steps("One", "Two") })], setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  assert.deepEqual(starting, [spy], "its own start while it started");
  harness.screen();
  const end = harness.alt().viewportTop;
  assert.ok(end > 0, "the transcript is longer than the pane");
  harness.send("a");
  await settle();
  harness.send(KEY.pageUp, KEY.pageUp);
  harness.screen();
  assert.equal(harness.alt().viewportTop, end, "the page keys did not scroll under the menu");
  assert.deepEqual(own(harness.terminal), expected, "its own methods while the menu is open");
  assert.deepEqual(methods.filter((name) => Object.hasOwn(harness.terminal, name)), [], "none replaced on the object");
  harness.send(KEY.escape);
  await settle();
  harness.send(KEY.pageUp);
  harness.screen();
  assert.ok(harness.alt().viewportTop < end, "the page keys scroll once the menu closed");
  await leave(harness);
  assert.deepEqual(own(harness.terminal), expected, "and after the workspace closed");
  assert.deepEqual(methods.filter((name) => Object.hasOwn(harness.terminal, name)), []);
});

void test("the menu stays clear of the title and the hint at 120, 70 and 40 columns and 10 rows, with the selected row in view", async (t) => {
  timers(t);
  const labels = [...Array.from({ length: 11 }, (_, index) => `Label ${String(index + 1)}`), `Label 12 ${"with a very long description ".repeat(6)}`];
  for (const columns of [120, 70, 40]) {
    const harness = await open([], { columns, rows: 10, nodes: tree(TARGETED()), initialKey: "O", actions: [new FakeProvider({ run: steps(...labels) })] });
    const check = (selected: string): void => {
      const lines = harness.screen();
      assert.equal(lines.length, 10);
      const block = menu(harness);
      const top = lines.findIndex((line) => MENU_HEADING.test(line));
      assert.ok(top >= 1 && top + block.length <= 9, `at most rows - 2 rows, clear of the title and the hint (${String(columns)} columns):\n${lines.join("\n")}`);
      assert.ok(block.length <= 8);
      assert.ok(block.some((line) => line.startsWith(`→ ${selected}`)), `${selected} in view at ${String(columns)} columns:\n${block.join("\n")}`);
    };
    harness.send("a");
    await settle();
    check("Label 1");
    assert.equal(menu(harness).length, 8, "six labels between the heading and the closing rule");
    harness.send(KEY.up);
    check("Label 12");
    const long = menu(harness).find((line) => line.startsWith("→ Label 12")) ?? "";
    assert.ok(long.endsWith("…"), "a long label is cut at the width");
    harness.send(KEY.down);
    check("Label 1");
    for (let step = 0; step < 7; step += 1) harness.send("j");
    check("Label 8");
    await leave(harness);
  }
});

void test("a refresh reads the labels again only when the node's target or state changed, keeps the selected one, else the last; a late answer is dropped; clicks on the sidebar do nothing while it is open; it closes when its node goes away", async (t) => {
  timers(t);
  const provider = new FakeProvider({ run: steps("Pause", "Stop", "Delete") });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider] });
  harness.send("a");
  await settle();
  harness.send(KEY.down);
  assert.deepEqual(menuRows(harness), ["Run actions", "  Pause", "→ Stop", "  Delete"]);
  const reads = provider.reads;
  provider.labels = { run: steps("Resume", "Stop") };
  await advance(t, 2);
  assert.equal(provider.reads, reads, "refreshes with the same target and state read nothing");
  assert.deepEqual(menuRows(harness), ["Run actions", "  Pause", "→ Stop", "  Delete"]);
  harness.nodes = RETARGETED("R2");
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "  Resume", "→ Stop"], "Stop kept");
  provider.labels = { run: steps("Resume", "Approve", "Cancel") };
  harness.nodes = RETARGETED("R3");
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "  Resume", "  Approve", "→ Cancel"], "the last label once Stop went away");
  let release = (): void => undefined;
  provider.hold = new Promise<void>((resolve) => { release = resolve; });
  harness.nodes = RETARGETED("R4");
  await advance(t);
  provider.hold = undefined;
  provider.labels = { run: steps("Fresh") };
  harness.nodes = RETARGETED("R5");
  await advance(t);
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Fresh"]);
  provider.labels = { run: steps("Stale") };
  release();
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Fresh"], "the earlier tick's answer came late and was dropped");
  // The menu covers the middle of the screen; the start of each sidebar row stays in view.
  const row = rowOf(harness, "    • s · ");
  assert.ok(row > 0);
  click(harness, 6, row);
  click(harness, 2, rowOf(harness, "  ▾ Subagents"));
  await settle();
  assert.equal(title(harness).trimEnd(), "O running", "the clicks selected nothing");
  assert.ok(harness.screen().some((line) => line.startsWith("  ▾ Subagents · ⠦")), "and toggled nothing");
  assert.deepEqual(harness.opened, []);
  harness.nodes = tree(TARGETED().filter((spec) => !["O", "a", "b"].includes(spec.key)).map((spec): Spec => spec.target?.kind === "run" ? { ...spec, target: { kind: "run", runId: "R5" } } : spec));
  await advance(t);
  assert.deepEqual(menu(harness), [], "the menu closed with its node");
  assert.match(title(harness), /^#1\/2 c/, "the selection went to the node now at its row");
  harness.send("s");
  assert.ok(!harness.screen().some((line) => line.includes("Subagents")), "the workspace has the keys again");
  assert.deepEqual(provider.runs, []);
  await leave(harness);
});

/** A wheel step down (SGR) at the 0-based screen `column` and `row`. */
function wheelDown(column: number, row: number): string { return `${ESC}[<65;${String(column + 1)};${String(row + 1)}M`; }

void test("the menu is Pi's select list: the wheel on it moves the selection, a click on a label runs it, a click or the wheel off it does nothing", async (t) => {
  timers(t);
  const provider = new FakeProvider({ run: steps("Pause", "Stop", "Delete") });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider] });
  harness.send("a");
  await settle();
  const at = (label: string): [number, number] => { const lines = harness.screen(); const row = lines.findIndex((line) => line.includes(` ${label}`)); return [lines[row]?.indexOf(label) ?? -1, row]; };
  harness.send(wheelDown(...at("Pause")));
  assert.deepEqual(menuRows(harness), ["Run actions", "  Pause", "→ Stop", "  Delete"], "the wheel on the menu moved the selection");
  harness.send(wheelDown(2, at("Pause")[1]));
  click(harness, 2, rowOf(harness, "  ▾ Subagents"));
  await settle();
  assert.deepEqual(menuRows(harness), ["Run actions", "  Pause", "→ Stop", "  Delete"], "the wheel and a click off the menu did nothing");
  assert.match(titleRow(harness), /^O running /, "and selected nothing");
  click(harness, ...at("Delete"));
  await harness.done;
  assert.deepEqual(harness.exit && { target: harness.exit.target, label: harness.exit.label }, { target: RUN, label: "Delete" }, "the click ran the label");
});

void test("a provider's error is a Text under the list, wrapped to the menu's width", async (t) => {
  timers(t);
  const first = new FakeProvider({ run: steps("Pause") });
  const second = new FakeProvider({ run: steps("Model aliases") });
  second.failure = new Error(`aliases locked${" by another process".repeat(6)}`);
  const harness = await open([], { columns: 70, nodes: tree(TARGETED()), initialKey: "O", actions: [first, second] });
  harness.send("a");
  await settle();
  const rows = menuRows(harness);
  assert.deepEqual(rows.slice(0, 2), ["Run actions", "→ Pause"]);
  assert.ok(rows.length > 3, "the error wraps over more than one row");
  assert.equal(rows.slice(2).join(" ").replace(/\s+/g, " "), `actions unavailable: aliases locked${" by another process".repeat(6)}`);
  await leave(harness);
});

void test("a label that needs Pi's dialogs leaves the workspace as esc does and resolves with the target, the label, its provider and the state once Pi is back", async (t) => {
  timers(t);
  const provider = new FakeProvider({ run: steps("Pause", "Stop") });
  const harness = await open([], { nodes: tree(TARGETED()), actions: [provider] });
  harness.send(KEY.up, "a");
  await settle();
  harness.send(KEY.down, KEY.enter);
  await harness.done;
  assert.deepEqual(harness.parentAtExit, ["stop:true", "start", "renderNow:false"], "Pi restarted before the promise resolved");
  assert.deepEqual(harness.exit && { ...harness.exit, state: { ...harness.exit.state, expansion: Object.fromEntries(harness.exit.state.expansion) } }, {
    target: RUN, label: "Stop", provider,
    state: { selectedKey: "O", row: 2, expansion: { "run:R": true, P: true, O: true, subagents: true }, focus: "sidebar", sidebarVisible: true, toolsExpanded: false, detailsShown: false },
  });
  assert.deepEqual(provider.runs, [], "the caller runs it with Pi's dialogs");
  assert.equal(harness.source("a").calls.at(-1), "close");
  assert.ok(harness.terminal.written.endsWith(`${ESC}[?1049l${ESC}[?25h${ESC}[?2026l`));
  const lists = harness.listCalls;
  await advance(t, 2);
  assert.equal(harness.listCalls, lists, "nothing runs after leaving");
});

void test("an in-place label runs inside the workspace: other keys are ignored and the ticks pause until it settles, then its notice shows until the next key", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const gates: (() => void)[] = [];
  const provider = new FakeProvider({ "workflow-agent": inPlace("Copy agent ID") }, async (_label, ui) => {
    await new Promise<void>((resolve) => { gates.push(resolve); });
    ui.notify("Copied agent ID.");
  });
  const harness = await open([], { nodes: tree(TARGETED()), actions: [provider], setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await settle();
  assert.deepEqual(provider.runs, ["agent:R/a Copy agent ID"]);
  assert.deepEqual(menu(harness), [], "the menu closed");
  const before = harness.screen();
  const end = harness.alt().viewportTop;
  assert.ok(end > 0, "the transcript is longer than the pane");
  const lists = harness.listCalls;
  const pollCount = polls(harness);
  harness.send(KEY.down, "s", "a", KEY.escape, KEY.tab, "]", KEY.enter, "d", KEY.pageUp, KEY.pageUp, KEY.search, "x", KEY.home, KEY.homeTmux, KEY.endTmux, paste("s"), "é", wheelUp(110, 5), wheelUp(5, 5));
  await settle();
  assert.deepEqual(harness.screen(), before, "every key was ignored");
  assert.equal(harness.alt().viewportTop, end, "the page keys, home and end (also as tmux sends them) and the wheel did not scroll the transcript");
  assert.equal(harness.alt().hasOverlay(), false, "the search key opened no search box");
  assert.equal(harness.left, false);
  await advance(t, 2);
  assert.equal(harness.listCalls, lists, "no refresh while it runs");
  assert.equal(polls(harness), pollCount, "no poll while it runs");
  gates.shift()?.();
  await settle();
  assert.equal(harness.listCalls, lists + 1, "once it settled a list shows what it changed at once");
  assert.equal(status(harness), "Copied agent ID.");
  assert.equal(harness.alt().hasOverlay(), false, "and none opens once it settled");
  await advance(t);
  assert.ok(harness.listCalls > lists && polls(harness) > pollCount, "the ticks go on");
  assert.equal(status(harness), "Copied agent ID.", "the notice outlasts a refresh");
  harness.send(KEY.pageUp);
  assert.equal(status(harness), "", "the next key clears it, also one the alt screen takes");
  assert.ok(harness.alt().viewportTop < end, "and the page keys scroll again");
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await settle();
  harness.send(KEY.ctrlC);
  await harness.done;
  assert.equal(harness.exit, undefined, "ctrl+c still leaves while it runs");
  gates.shift()?.();
  await settle();
  assert.deepEqual(harness.notified, []);
  assert.deepEqual(escaped, []);
});

void test("while nothing runs a change during an in-place action lists nothing, and the action's end lists at once", async (t) => {
  timers(t);
  const listeners = new Set<() => void>();
  const change = async (): Promise<void> => { for (const listener of listeners) listener(); await settle(); };
  let release = (): void => undefined;
  const provider = new FakeProvider({ "workflow-agent": inPlace("Copy agent ID") }, () => new Promise<void>((resolve) => { release = resolve; }));
  const settled = TARGETED().map((spec): Spec => spec.agent ? { ...spec, agent: { ...spec.agent, state: "completed", running: false } } : spec);
  const harness = await open([], { nodes: tree(settled), actions: [provider], changes: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; } });
  await advance(t, 6);
  const lists = harness.listCalls;
  await change();
  assert.equal(harness.listCalls, lists + 1, "nothing runs: a change lists at once");
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await settle();
  assert.deepEqual(provider.runs, ["agent:R/a Copy agent ID"]);
  await change();
  assert.equal(harness.listCalls, lists + 1, "a change while the action runs lists nothing");
  release();
  await settle();
  assert.equal(harness.listCalls, lists + 2, "the action's end lists at once");
  await leave(harness);
  assert.equal(listeners.size, 0, "leaving stops listening");
});

void test("an in-place label that asks for one of Pi's dialogs is reported in the status row with its label", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const provider = new FakeProvider({ run: inPlace("Copy run ID", "Open script in editor") }, async (label, ui) => {
    if (label === "Copy run ID") await ui.confirm("Copy?", "Copy the run ID?");
    else ui.status("opening");
  });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider] });
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await settle();
  assert.match(status(harness), /^Copy run ID: confirm needs Pi's dialogs/);
  harness.send("a");
  await settle();
  harness.send(KEY.down, KEY.enter);
  await settle();
  assert.match(status(harness), /^Open script in editor: status needs Pi's dialogs/);
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#1\/4 a/, "the workspace goes on");
  await leave(harness);
  assert.deepEqual(escaped, []);
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

const EDITOR_SCRIPT = `import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
const [opened, release, code, file] = process.argv.slice(2);
writeFileSync(\`\${opened}.part\`, readFileSync(file, "utf8"));
renameSync(\`\${opened}.part\`, opened);
const wait = () => { if (existsSync(release)) process.exit(Number(code)); else setTimeout(wait, 10); };
wait();
`;
/** An external editor that notes the artifact in `opened-<round>` and exits with `code` once `release-<round>` exists. */
function editor(): { readonly dir: string; command(round: number, code: number): string; opened(round: number): string; release(round: number): void } {
  const dir = temporary("agents-editor");
  const script = join(dir, "editor.mjs");
  writeFileSync(script, EDITOR_SCRIPT);
  return {
    dir,
    command: (round, code) => `${process.execPath} ${script} ${join(dir, `opened-${String(round)}`)} ${join(dir, `release-${String(round)}`)} ${String(code)}`,
    opened: (round) => join(dir, `opened-${String(round)}`),
    release: (round) => { writeFileSync(join(dir, `release-${String(round)}`), ""); },
  };
}

void test("an in-place editor leaves the alternate screen without writing the workspace into Pi's screen, comes back with a full redraw, and never starts Pi's TUI", async (t) => {
  timers(t);
  const external = editor();
  let round = 0;
  let code = 0;
  let finished = 0;
  const provider = new FakeProvider({ run: inPlace("Open script in editor") }, async (_label, ui) => {
    await ui.openArtifact({ extension: ".js", content: "return 1;" }, "script");
    finished += 1;
  });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider], editorCommand: () => external.command(round, code) });
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await until(() => existsSync(external.opened(0)), "the editor started");
  assert.equal(readFileSync(external.opened(0), "utf8"), "return 1;");
  const stopped = harness.terminal.written;
  assert.ok(stopped.endsWith(`${ESC}[?1049l${ESC}[?25h${ESC}[?2026l`), "left the alternate screen keeping Pi's screen, with nothing written after it");
  assert.equal(harness.terminal.input, undefined, "the editor has the terminal");
  assert.deepEqual(harness.parent, ["stop:true"], "Pi's TUI stays stopped");
  external.release(0);
  await until(() => finished === 1, "the editor exited");
  await settle();
  const restarted = harness.terminal.written.slice(stopped.length);
  assert.ok(restarted.includes(`${ESC}[?1049h`), "entered the alternate screen again");
  assert.ok(stripTerminalSequences(restarted).includes("O running"), "and drew the whole frame");
  assert.ok(harness.terminal.input, "the workspace reads the terminal again");
  assert.equal(Object.hasOwn(harness.terminal, "start"), false, "through its own start");
  assert.deepEqual(harness.parent, ["stop:true"]);
  assert.equal(status(harness), "", "nothing to report");
  harness.send("a");
  await settle();
  harness.send(KEY.search, "x");
  await settle();
  assert.ok(!harness.screen().some((line) => line.includes("Find in transcript")), "the workspace still reads the keys first: the search key opened no box over the menu");
  assert.deepEqual(menuRows(harness), ["Run actions", "→ Open script in editor"], "the menu kept the keys");
  harness.send(KEY.escape);
  await settle();
  assert.deepEqual(menu(harness), []);
  assert.equal(harness.alt().hasOverlay(), false);
  round = 1;
  code = 3;
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await until(() => existsSync(external.opened(1)), "the editor started again");
  external.release(1);
  await until(() => finished === 2, "the editor exited again");
  await settle();
  assert.equal(status(harness), "Cannot open script: external editor exited with code 3.");
  await leave(harness);
  assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"]);
});

void test("a resize across 80 columns while the in-place editor has the terminal hides or shows the sidebar, with its focus, when the workspace comes back", async (t) => {
  timers(t);
  const external = editor();
  let round = 0;
  let finished = 0;
  const provider = new FakeProvider({ run: inPlace("Open script in editor") }, async (_label, ui) => {
    await ui.openArtifact({ extension: ".js", content: "return 1;" }, "script");
    finished += 1;
  });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider], editorCommand: () => external.command(round, 0) });
  for (const [columns, shown] of [[70, false], [120, true]] as const) {
    harness.send("a");
    await settle();
    harness.send(KEY.enter);
    await until(() => existsSync(external.opened(round)), "the editor started");
    assert.equal(harness.terminal.onResize, undefined, "no resize reaches the workspace while the editor has the terminal");
    harness.terminal.columns = columns;
    external.release(round);
    await until(() => finished === round + 1, "the editor exited");
    await settle();
    assert.ok(harness.terminal.input, "the workspace is back");
    assert.equal(sidebarShown(harness), shown, `${String(columns)} columns`);
    assert.match(harness.screen().at(-1) ?? "", shown ? /^left\/right fold/ : /^up\/down scroll/, shown ? "the sidebar has the focus" : "the transcript has the focus");
    assert.match(title(harness), /^O running/, "on the same node");
    round += 1;
  }
  await leave(harness);
});

void test("an in-place editor without a configured editor reports it in the status row", async (t) => {
  timers(t);
  for (const editorCommand of [undefined, () => undefined]) {
    const provider = new FakeProvider({ run: inPlace("Open script in editor") }, (_label, ui) => ui.openArtifact({ extension: ".js", content: "return 1;" }, "script"));
    const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider], ...(editorCommand === undefined ? {} : { editorCommand }) });
    harness.send("a");
    await settle();
    harness.send(KEY.enter);
    await settle();
    assert.equal(status(harness), "Cannot open script: no external editor is configured.");
    assert.deepEqual(harness.parent, ["stop:true"]);
    await leave(harness);
  }
});

void test("an abort while the artifact is written starts no editor and gives Pi the terminal back once", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const external = editor();
  const controller = new AbortController();
  const provider = new FakeProvider({ run: inPlace("Open script in editor") }, async (_label, ui) => {
    const opening = ui.openArtifact({ extension: ".js", content: "return 1;" }, "script");
    controller.abort();
    await opening;
  });
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider], signal: controller.signal, editorCommand: () => external.command(0, 0) });
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await harness.done;
  await settle();
  assert.equal(existsSync(external.opened(0)), false, "no editor started");
  assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], "Pi was restored once");
  assert.equal(harness.terminal.stops, 1);
  assert.deepEqual(escaped, []);
});

void test("a transcript scrolled up comes back at the same place after a step-aside action; one at the tail stays at the tail", async (t) => {
  timers(t);
  const setup = (source: Parameters<NonNullable<Parameters<typeof open>[1]>["setup"] & object>[0]): void => { source.polls.push(polled(entries(0, 100))); };
  const provider = new FakeProvider({ "workflow-agent": steps("Stop") });
  const nodes = tree(TARGETED());
  for (const up of [true, false]) {
    const first = await open([], { nodes, initialKey: "a", actions: [provider], setup });
    first.screen();
    const end = first.alt().viewportTop;
    assert.equal(end, 100 - 18);
    if (up) { first.send(KEY.pageUp); first.screen(); }
    const top = first.alt().viewportTop;
    assert.equal(top < end, up);
    first.send("a");
    await settle();
    first.send(KEY.enter);
    await first.done;
    assert.ok(first.exit);
    const second = await open([], { nodes, actions: [provider], setup, state: first.exit.state });
    second.screen();
    await settle();
    second.screen();
    assert.equal(second.alt().viewportTop, top, up ? "the same place" : "the tail");
    await leave(second);
  }
});

void test("a saved place beyond the reopened content is clamped to the top and the view can still scroll", async (t) => {
  timers(t);
  const provider = new FakeProvider({ "workflow-agent": steps("Stop") });
  const nodes = tree(TARGETED());
  const first = await open([], { nodes, initialKey: "a", actions: [provider], setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  first.screen();
  first.send(KEY.pageUp);
  first.send(KEY.pageUp);
  first.screen();
  first.send("a");
  await settle();
  first.send(KEY.enter);
  await first.done;
  assert.ok(first.exit);
  const second = await open([], { nodes, actions: [provider], setup: (source) => { source.polls.push(polled(entries(0, 30))); }, state: first.exit.state });
  for (let round = 0; round < 3; round += 1) { second.screen(); await settle(); }
  second.screen();
  assert.equal(second.alt().viewportTop, 0, "clamped to the top");
  second.send(KEY.pageDown);
  second.screen();
  assert.ok(second.alt().viewportTop > 0, "page down moves the view");
  second.send(KEY.ctrlEnd);
  second.screen();
  assert.equal(second.alt().viewportTop, 30 - 18, "end reaches the tail");
  await leave(second);
});

void test("a place above the tail comes back on reopening", async (t) => {
  timers(t);
  const setup = (source: Parameters<NonNullable<Parameters<typeof open>[1]>["setup"] & object>[0]): void => {
    source.polls.push(polled(entries(0, 120)));
  };
  const provider = new FakeProvider({ "workflow-agent": steps("Stop") });
  const nodes = tree(TARGETED());
  const first = await open([], { nodes, initialKey: "a", actions: [provider], setup });
  first.screen();
  await settle();
  first.screen();
  first.send(KEY.pageUp);
  first.screen();
  const top = first.alt().viewportTop;
  assert.ok(top > 0, "not at the start");
  assert.ok(top < 120 - 18, "not at the tail");
  assert.ok(new RegExp(`record ${String(top)}\\b`).test(first.screen()[1] ?? ""), "the first line in view is the record at the top row");
  const seen = first.screen().slice(1, 4).join("\n");
  first.send("a");
  await settle();
  first.send(KEY.enter);
  await first.done;
  assert.ok(first.exit);
  const second = await open([], { nodes, actions: [provider], setup, state: first.exit.state });
  for (let round = 0; round < 4; round += 1) { second.screen(); await settle(); }
  second.screen();
  assert.equal(second.alt().viewportTop, top, "the same place");
  assert.equal(second.screen().slice(1, 4).join("\n"), seen, "the same lines");
  await leave(second);
});

type PlaceSource = Parameters<NonNullable<Parameters<typeof open>[1]>["setup"] & object>[0];

/** Opens a long transcript, scrolls up, steps aside, and returns what the reopened workspace needs. */
async function savedPlace(): Promise<{ provider: FakeProvider; nodes: ReturnType<typeof tree>; state: NonNullable<Awaited<ReturnType<typeof open>>["exit"]>["state"]; top: number }> {
  const setup = (source: PlaceSource): void => { source.polls.push(polled(entries(0, 120))); };
  const provider = new FakeProvider({ "workflow-agent": steps("Stop") });
  const nodes = tree(TARGETED());
  const first = await open([], { nodes, initialKey: "a", actions: [provider], setup });
  first.screen();
  await settle();
  first.screen();
  first.send(KEY.pageUp);
  first.screen();
  const top = first.alt().viewportTop;
  assert.ok(top > 0 && top < 120 - 18, "a place above the tail");
  first.send("a");
  await settle();
  first.send(KEY.enter);
  await first.done;
  assert.ok(first.exit);
  return { provider, nodes, state: first.exit.state, top };
}

void test("a transcript reset while a restore is pending drops the saved place and stays at the tail", async (t) => {
  timers(t);
  const saved = await savedPlace();
  const second = await open([], { nodes: saved.nodes, actions: [saved.provider], state: saved.state, setup: (source) => {
    source.polls.push(polled(entries(500, 40), { reset: true }));
  } });
  for (let round = 0; round < 5; round += 1) { second.screen(); await advance(t); }
  second.screen();
  assert.equal(second.alt().viewportTop, 40 - 18, "at the tail of the new content");
  for (let round = 0; round < 3; round += 1) { second.screen(); await advance(t); }
  second.screen();
  assert.equal(second.alt().viewportTop, 40 - 18, "no later layout jumps back to the old offset");
  await leave(second);
});

void test("a poll that is not available gives up a pending restore: later content does not bring the saved place back", async (t) => {
  timers(t);
  const saved = await savedPlace();
  const second = await open([], { nodes: saved.nodes, actions: [saved.provider], state: saved.state, setup: (source) => {
    source.polls.push(polled(entries(100, 20), { status: "unavailable" }), polled(entries(120, 200)));
  } });
  for (let round = 0; round < 6; round += 1) { second.screen(); await advance(t); }
  second.screen();
  assert.equal(second.alt().viewportTop, 0, "the saved place is not applied once the content is long enough");
  second.send(KEY.pageDown);
  second.screen();
  assert.ok(second.alt().viewportTop > 0, "page down moves the view");
  await leave(second);
});

void test("an abort while the editor runs leaves when the editor exits: Pi is started once and the workspace does not come back", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const external = editor();
  let finished = 0;
  const provider = new FakeProvider({ run: inPlace("Open script in editor") }, async (_label, ui) => {
    await ui.openArtifact({ extension: ".js", content: "return 1;" }, "script");
    finished += 1;
  });
  const controller = new AbortController();
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider], signal: controller.signal, editorCommand: () => external.command(0, 3) });
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await until(() => existsSync(external.opened(0)), "the editor started");
  const stopped = harness.terminal.written.length;
  assert.equal(harness.terminal.stops, 1, "the editor stopped the terminal");
  const cursorShown = harness.terminal.written.split(`${ESC}[?25h`).length;
  let resolved = false;
  void harness.done.then(() => { resolved = true; });
  controller.abort();
  await settle();
  assert.equal(harness.terminal.input, undefined, "no key reaches the workspace while the editor runs");
  assert.deepEqual(harness.parent, ["stop:true"], "Pi stays stopped while the editor has the terminal");
  assert.equal(resolved, false, "the workspace is not left while the editor runs");
  external.release(0);
  await until(() => finished === 1, "the editor exited");
  await harness.done;
  assert.equal(harness.exit, undefined);
  assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], "Pi is back");
  assert.equal(harness.terminal.stops, 1, "leaving stops the terminal no second time");
  assert.equal(harness.terminal.written.split(`${ESC}[?25h`).length, cursorShown, "nor shows the cursor again");
  await settle();
  assert.ok(!harness.terminal.written.slice(stopped).includes(`${ESC}[?1049h`), "the alternate screen was not entered again");
  assert.equal(harness.terminal.input, undefined);
  assert.deepEqual(harness.parent, ["stop:true", "start", "renderNow:false"], "Pi was started once");
  assert.equal(harness.terminal.stops, 1, "the terminal was stopped once");
  assert.deepEqual(harness.notified, [], "the editor's exit code goes nowhere once the workspace is left");
  assert.deepEqual(escaped, []);
});

void test("a shutdown while the editor runs closes the workspace at once, writes nothing over the editor and leaves Pi stopped; the editor's exit brings nothing back", async (t) => {
  timers(t);
  const escaped = escapes(t);
  const external = editor();
  let finished = 0;
  const provider = new FakeProvider({ run: inPlace("Open script in editor") }, async (_label, ui) => {
    await ui.openArtifact({ extension: ".js", content: "return 1;" }, "script");
    finished += 1;
  });
  const shutdown = new AbortController();
  const harness = await open([], { nodes: tree(TARGETED()), initialKey: "O", actions: [provider], shutdown: shutdown.signal, editorCommand: () => external.command(0, 3) });
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await until(() => existsSync(external.opened(0)), "the editor started");
  const stopped = harness.terminal.written.length;
  shutdown.abort({ type: "session_shutdown", reason: "quit" });
  await until(() => harness.left, "the command settled while the editor runs");
  assert.equal(harness.exit, undefined);
  assert.equal(harness.terminal.written.length, stopped, "the editor left the alternate screen already: nothing written over it");
  external.release(0);
  await until(() => finished === 1, "the editor exited");
  await settle();
  assert.equal(harness.terminal.written.length, stopped, "the alternate screen was not entered again");
  assert.equal(harness.terminal.input, undefined);
  assert.equal(harness.terminal.stops, 1, "the terminal was stopped once, by the editor");
  assert.deepEqual(harness.parent, ["stop:true"], "Pi left stopped for its shutdown");
  assert.deepEqual(harness.notified, [], "the editor's exit code goes nowhere");
  assert.deepEqual(escaped, []);
});

/** The state of a workspace that stepped aside with the agent b selected. */
function stateOf(overrides: Partial<AgentsWorkspaceState> = {}): AgentsWorkspaceState {
  return { selectedKey: "b", row: 4, expansion: [], focus: "sidebar", sidebarVisible: true, toolsExpanded: false, detailsShown: false, ...overrides };
}

void test("a state restores the selection by key, the expansion, the focus, the tools and the notices until the next key; the initial key wins over it", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TREE()), state: stateOf({ expansion: [["subagents", false], ["O", true]], focus: "transcript", toolsExpanded: true }), notices: ["Paused workflow Workflow.", "Moved to background."] });
  assert.match(title(harness), /^#2\/4 b/);
  assert.deepEqual(harness.opened, ["b"]);
  assert.deepEqual(sidebarRows(harness), ["  ▾ Workflow · ⠦", "    ▾ P · ⠦", "      ▾ O · ⠦", "        • a · ⠦", "→       • b · ✓", "      • c · ⠦", "  ▸ Subagents · ⠦"], "the recorded collapse kept, the keys not recorded as they come");
  assert.match(harness.screen().at(-1) ?? "", /^up\/down scroll/, "the transcript has the focus");
  assert.ok(harness.view("b").calls.includes("expanded:true"), "tool output expanded");
  assert.equal(status(harness), "Paused workflow Workflow. · Moved to background.");
  await advance(t);
  assert.equal(status(harness), "Paused workflow Workflow. · Moved to background.", "until the next key");
  harness.send(KEY.down);
  assert.equal(status(harness), "");
  await leave(harness);

  const keyed = await open([], { nodes: tree(TREE()), initialKey: "s", state: stateOf({ expansion: [["subagents", false]] }) });
  assert.match(title(keyed), /^#4\/4 s/);
  assert.deepEqual(sidebarRows(keyed).slice(-2), ["  ▾ Subagents · ⠦", "→   • s · ⠦"], "the initial key's ancestors expanded");
  await leave(keyed);
});

void test("the notices end at any key: one parseKey does not name (é), home and end as tmux sends them, a paste; a focus report or a query's answer leaves them", async (t) => {
  timers(t);
  for (const key of ["é", KEY.homeTmux, KEY.endTmux, paste("x")]) {
    const harness = await open([], { nodes: tree(TREE()), notices: ["Paused workflow Workflow."] });
    harness.send(`${ESC}[I`, `${ESC}[O`, `${ESC}[?62;22c`);
    assert.equal(status(harness), "Paused workflow Workflow.", "not keys");
    harness.send(key);
    assert.equal(status(harness), "", JSON.stringify(key));
    await leave(harness);
  }
});

void test("a state whose key went away selects the node now at its row; a recorded collapse holds while new keys take their initial expansion", async (t) => {
  timers(t);
  const harness = await open([], { nodes: tree(TREE()), state: stateOf({ selectedKey: "gone", row: 2 }) });
  assert.equal(title(harness).trimEnd(), "O running");
  await leave(harness);
  const collapsed = await open([], { nodes: tree(TREE()), state: stateOf({ selectedKey: "s", row: 0, expansion: [["P", false], ["run:R", true]] }) });
  assert.deepEqual(sidebarRows(collapsed), ["  ▾ Workflow · ⠦", "    ▸ P · ⠦", "  ▾ Subagents · ⠦", "→   • s · ⠦"]);
  await leave(collapsed);
  const beyond = await open([], { nodes: tree(TREE()), state: stateOf({ selectedKey: "gone", row: 30 }) });
  assert.match(title(beyond), /^#4\/4 s/, "a row past the end gives the last visible node");
  await leave(beyond);
});

void test("a state's sidebar stays hidden below 80 columns; its tools and d hold", async (t) => {
  timers(t);
  const narrow = await open([], { columns: 70, nodes: tree(TREE()), state: stateOf({ sidebarVisible: true, focus: "sidebar" }) });
  assert.ok(!narrow.screen().some((line) => line.includes("Subagents")), "sidebar hidden");
  assert.match(narrow.screen().at(-1) ?? "", /^up\/down scroll · escape\/ctrl\+c back · f follow · \[ \] agent · ctrl\+shi/, "the transcript has the focus and tab moves nothing");
  await leave(narrow);
  const hidden = await open([], { nodes: tree(TREE()), state: stateOf({ sidebarVisible: false, focus: "sidebar" }) });
  assert.ok(!hidden.screen().some((line) => line.includes("Subagents")), "a hidden sidebar stays hidden");
  assert.match(hidden.screen().at(-1) ?? "", /^up\/down scroll/);
  await leave(hidden);
  const specs = TREE().map((spec) => spec.key === "b" ? { ...spec, details: ["Model: gpt-5", "Tokens: 1.2k"] } : spec);
  const details = await open([], { nodes: tree(specs), state: stateOf({ detailsShown: true }) });
  assert.match(details.screen()[1] ?? "", /│ Model: gpt-5\s*$/, "the agent's details shown");
  assert.equal(details.source("b").count("poll") > 0, true, "its transcript still opened");
  await leave(details);
});

/** Opens TARGETED at `columns`, presses `keys`, then steps aside for the selected agent's Stop: the state its exit keeps. */
async function steppedAside(columns: number, ...keys: string[]): Promise<AgentsWorkspaceState> {
  const harness = await open([], { columns, nodes: tree(TARGETED()), actions: [new FakeProvider({ "workflow-agent": steps("Stop") })] });
  harness.send(...keys, "a");
  await settle();
  harness.send(KEY.enter);
  await harness.done;
  const exit = harness.exit;
  assert.ok(exit);
  assert.equal(exit.label, "Stop");
  return exit.state;
}

void test("a sidebar hidden below 80 columns when the workspace stepped aside comes back focused when it opens again on a wide terminal", async (t) => {
  timers(t);
  const narrow = await steppedAside(70);
  for (const columns of [120, 70]) {
    const again = await open([], { columns, nodes: tree(TARGETED()), state: narrow });
    if (columns === 70) {
      assert.equal(sidebarShown(again), false, "still hidden below 80 columns");
      assert.match(again.screen().at(-1) ?? "", /^up\/down scroll/);
      again.terminal.resize(120);
    }
    assert.equal(sidebarShown(again), true, `opened at ${String(columns)} columns`);
    assert.match(again.screen().at(-1) ?? "", /^left\/right fold/, "with the sidebar focused");
    assert.match(title(again), /^#1\/4 a/, "on the same node");
    await leave(again);
  }
});

void test("a sidebar hidden with s while it could show stays hidden when the workspace stepped aside and opens again, also across a resize; s still shows it", async (t) => {
  timers(t);
  const hidden = await steppedAside(120, "s");
  for (const columns of [70, 120]) {
    const again = await open([], { columns, nodes: tree(TARGETED()), state: hidden });
    assert.equal(sidebarShown(again), false, `opened at ${String(columns)} columns`);
    if (columns === 120) again.terminal.resize(70);
    again.terminal.resize(120);
    assert.equal(sidebarShown(again), false, `opened at ${String(columns)} columns, then 120`);
    assert.match(again.screen().at(-1) ?? "", /^up\/down scroll/, "the transcript has the focus");
    again.send("s");
    assert.equal(sidebarShown(again), true, "s shows it");
    assert.match(title(again), /^#1\/4 a/, "on the same node");
    await leave(again);
  }
});

void test("the exit's state is the workspace's at that moment and opens it again as it was", async (t) => {
  timers(t);
  const specs = TARGETED().map((spec) => spec.key === "b" ? { ...spec, details: ["Model: gpt-5"] } : spec);
  const provider = new FakeProvider({ "workflow-agent": steps("Stop") });
  const harness = await open([], { nodes: tree(specs), actions: [provider] });
  harness.send(KEY.down, KEY.down, KEY.down, KEY.left, KEY.up, KEY.up, KEY.ctrlO, "d", KEY.tab);
  await settle();
  assert.match(title(harness), /^#2\/4 b/);
  const frame = harness.screen();
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await harness.done;
  const exit = harness.exit;
  assert.ok(exit);
  assert.deepEqual(exit.target, { kind: "workflow-agent", runId: "R", agentId: "b" });
  assert.deepEqual({ ...exit.state, expansion: Object.fromEntries(exit.state.expansion) }, { selectedKey: "b", row: 4, expansion: { "run:R": true, P: true, O: true, subagents: false }, focus: "transcript", sidebarVisible: true, toolsExpanded: true, detailsShown: true });
  const again = await open([], { nodes: tree(specs), actions: [provider], state: exit.state });
  assert.deepEqual(again.screen(), frame, "the same frame");
  assert.ok(again.view("b").calls.includes("expanded:true"));
  await leave(again);
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

void test("d shows an agent's details instead of its transcript, which keeps polling; the choice holds while the selection moves between agents", async (t) => {
  timers(t);
  const specs = TREE().map((spec) => spec.key === "a" ? { ...spec, details: ["Model: gpt-5", "Tokens: 1.2k"] } : spec.key === "b" ? { ...spec, details: ["Model: b-model"] } : spec);
  const harness = await open([], { nodes: tree(specs), setup: (source) => { source.polls.push(polled(entries(0, 3))); } });
  const pane = (): string => (harness.screen()[1] ?? "").replace(/^.*│ /, "").replace(/[\s┃█]+$/, "");
  assert.equal(pane(), "a record 0");
  assert.match(harness.screen().at(-1) ?? "", / · d details · /);
  harness.send("d");
  assert.equal(pane(), "Model: gpt-5");
  assert.match(harness.screen()[2] ?? "", /│ Tokens: 1\.2k\s*$/);
  assert.match(title(harness), /^#1\/4 a running/, "the title stays the agent's");
  const before = harness.source("a").count("poll");
  await advance(t, 2);
  assert.ok(harness.source("a").count("poll") > before, "the transcript keeps polling");
  harness.send("d");
  assert.equal(pane(), "a record 0", "d again shows the transcript");
  harness.send("d", KEY.down);
  await settle();
  assert.match(title(harness), /^#2\/4 b/);
  assert.equal(pane(), "Model: b-model", "the next agent shows its details too");
  harness.send(KEY.down);
  await settle();
  assert.match(title(harness), /^#3\/4 c/);
  assert.equal(pane(), "c record 0", "an agent without details shows its transcript");
  assert.doesNotMatch(harness.screen().at(-1) ?? "", /d details/);
  harness.send("d");
  assert.equal(pane(), "c record 0", "d does nothing there");
  harness.send(KEY.up);
  await settle();
  assert.equal(pane(), "Model: b-model", "and the choice still holds");
  harness.send(KEY.up, KEY.up, "d");
  await settle();
  assert.equal(title(harness).trimEnd(), "O running");
  assert.equal(pane(), "details of O", "d does nothing on a node that is not an agent");
  harness.send("]");
  await settle();
  assert.equal(pane(), "Model: gpt-5");
  await leave(harness);
});

void test("a refresh that leaves the selected agent without details while d is on shows its transcript, and its details again once they are back", async (t) => {
  timers(t);
  const withDetails = (): Spec[] => TREE().map((spec) => spec.key === "a" ? { ...spec, details: ["Model: gpt-5"] } : spec);
  const harness = await open([], { nodes: tree(withDetails()), setup: (source) => { source.polls.push(polled(entries(0, 3))); } });
  const pane = (): string => (harness.screen()[1] ?? "").replace(/^.*│ /, "").replace(/[\s┃█]+$/, "");
  harness.send("d");
  assert.equal(pane(), "Model: gpt-5");
  harness.nodes = tree(TREE());
  await advance(t);
  assert.equal(pane(), "a record 0", "no details: the transcript");
  assert.doesNotMatch(harness.screen().at(-1) ?? "", /d details/);
  assert.match(title(harness), /^#1\/4 a/, "the agent stays selected");
  assert.equal(harness.opened.filter((key) => key === "a").length, 1, "its transcript was not opened again");
  harness.nodes = tree(withDetails());
  await advance(t);
  assert.equal(pane(), "Model: gpt-5", "d still on: the details are back");
  harness.send("d");
  assert.equal(pane(), "a record 0", "d turns them off");
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

void test("the hint names a menu with providers, d details on an agent with details, and tab focus while the sidebar shows", async (t) => {
  timers(t);
  const specs = TARGETED().map((spec) => spec.key === "a" ? { ...spec, details: ["Model: gpt-5"] } : spec);
  const actions = [new FakeProvider({})];
  const harness = await open([], { columns: 160, nodes: tree(specs), actions });
  const hint = (): string => (harness.screen().at(-1) ?? "").trimEnd();
  assert.equal(hint(), "left/right fold · escape/ctrl+c back · f follow · [ ] agent · / filter · a menu · d details · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools");
  harness.send(KEY.tab);
  assert.equal(hint(), "up/down scroll · escape/ctrl+c back · f follow · [ ] agent · a menu · d details · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools");
  harness.send(KEY.tab, KEY.up);
  await settle();
  assert.equal(hint(), "left/right fold · escape/ctrl+c back · f follow · [ ] agent · / filter · a menu · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools", "no d details on a node that is not an agent");
  harness.send("s");
  assert.equal(hint(), "up/down scroll · escape/ctrl+c back · f follow · [ ] agent · a menu · ctrl+shift+f search · s sidebar · ctrl+o tools", "no tab focus without the sidebar");
  await leave(harness);

  const plain = await open([], { columns: 160, nodes: tree(specs) });
  assert.equal((plain.screen().at(-1) ?? "").trimEnd(), "left/right fold · escape/ctrl+c back · f follow · [ ] agent · / filter · d details · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools", "no a menu without providers");
  await leave(plain);
});

type Needs = NonNullable<SessionTreeNode["needsPerson"]>;
function needing(nodes: SessionTreeNode[], needs: Readonly<Record<string, Needs>>): SessionTreeNode[] {
  return nodes.map((node) => { const needsPerson = needs[node.key]; return needsPerson === undefined ? node : { ...node, needsPerson }; });
}
const NEEDY = (): Listed[] => [agent("a", { tokens: 1_000_000, cost: 3 }), agent("b", { depth: 1, running: false, state: "failed", tokens: 200_000, cost: 0.41 }), agent("c", { running: false, state: "completed" }), agent("d", { group: "Subagents" })];

void test("n and N visit the nodes that need a person, wrap, expand hidden ancestors and do nothing without any", async (t) => {
  timers(t);
  const nodes = needing(nodesOf(NEEDY()), { "run:build a1b2": "awaiting_input", b: "failed", d: "stalled" });
  const harness = await open([], { nodes, initialKey: "a" });
  harness.send("n");
  await settle();
  assert.match(title(harness), /^#2\/4 b/, "n goes to the next node that needs a person");
  harness.send("n");
  await settle();
  assert.match(title(harness), /^#4\/4 d/);
  harness.send("n");
  await settle();
  assert.match(title(harness), /^build a1b2 running/, "n wraps round to the first");
  harness.send("N");
  await settle();
  assert.match(title(harness), /^#4\/4 d/, "N wraps back");
  harness.send("N");
  await settle();
  assert.match(title(harness), /^#2\/4 b/, "N goes to the previous one");
  harness.send(KEY.tab, "n");
  await settle();
  assert.match(title(harness), /^#4\/4 d/, "works with the transcript focused");
  await leave(harness);

  const hidden = await open([], { nodes: needing(nodesOf(NEEDY()), { b: "failed" }), initialKey: "c", state: { selectedKey: "c", row: 0, expansion: [["a", false]], focus: "sidebar", sidebarVisible: true, toolsExpanded: false, detailsShown: false } });
  assert.equal(sidebarRows(hidden).some((row) => /\bb\b/.test(row)), false, "b is hidden under the collapsed a");
  hidden.send("n");
  await settle();
  assert.match(title(hidden), /^#2\/4 b/);
  assert.ok(sidebarRows(hidden).some((row) => /\bb\b/.test(row)), "its ancestors were expanded");
  await leave(hidden);

  const none = await open(NEEDY(), { initialKey: "a" });
  none.send("n", "N");
  await settle();
  assert.match(title(none), /^#1\/4 a/, "no node needs a person: n and N do nothing");
  assert.doesNotMatch((none.screen().at(-1) ?? ""), /n next/);
  await leave(none);
});

void test("at the narrowest sidebar a row mark shows whole: after the row, after the row cut with …, or not at all", async (t) => {
  timers(t);
  const marks: Readonly<Record<string, string>> = { "run:build a1b2": "  ◆ waiting: ship", b: "  ⚠ quiet 4m", "reviewer-of-the-api": "  ⚠ stalled 12m", "run:deploy c3d4": "  ◆ waiting: approve it!" };
  const nodes = nodesOf([agent("b"), agent("reviewer-of-the-api"), agent("x", { group: "deploy c3d4" })]).map((node) => { const mark = marks[node.key]; return mark === undefined ? node : { ...node, mark: () => mark }; });
  // 80 columns is the narrowest terminal with the sidebar beside the transcript: 29 columns of rows. Beside the 24 columns of deploy's mark the row would keep no character of its label.
  const harness = await open([], { nodes, initialKey: "x", columns: 80 });
  assert.deepEqual(sidebarRows(harness), [
    "  ▾ build a…  ◆ waiting: ship",
    "    • b · ⠦  ⚠ quiet 4m",
    "    • reviewe…  ⚠ stalled 12m",
    "  ▾ deploy c3d4 · ⠦",
    "→   • x · ⠦",
  ]);
  await leave(harness);
});

void test("the hint shows n next only while some node needs a person", async (t) => {
  timers(t);
  const harness = await open([], { nodes: needing(nodesOf(NEEDY()), { b: "failed" }) });
  assert.match(harness.screen().at(-1) ?? "", /\[ \] agent · n next · /);
  harness.nodes = nodesOf(NEEDY());
  await advance(t);
  await settle();
  assert.doesNotMatch(harness.screen().at(-1) ?? "", /n next/);
  await leave(harness);
});

void test("the title ends with the session totals and drops them first when narrow", async (t) => {
  timers(t);
  const listed = (): Listed[] => [agent("a", { tokens: 1000, cost: 3, summary: "s".repeat(40) }), agent("b", { depth: 1, running: false, state: "failed", tokens: 200, cost: 0.41 }), agent("c", { running: false, state: "completed" })];
  const totals = "1/3 running · 1.2kt · $3.41";
  for (const columns of [120, 70, 40]) {
    const harness = await open(listed(), { initialKey: "a", columns });
    const line = titleRow(harness);
    assert.match(line, /^#1\/3 a /);
    if (columns === 120) assert.ok(line.trimEnd().endsWith(totals), "the totals end the row");
    else assert.ok(!line.includes("running ·") && !line.includes("$3.41"), `no totals at ${String(columns)} columns`);
    await leave(harness);
  }
  const bare = await open([agent("a")], { initialKey: "a" });
  assert.ok(titleRow(bare).trimEnd().endsWith("1/1 running"), "parts without data are left out");
  await leave(bare);
});

const ACTIVE = (a: number, b: number, c: number): Listed[] => [agent("a", { lastActivityAt: a }), agent("b", { lastActivityAt: b }), agent("c", { lastActivityAt: c, running: false, state: "completed" })];
/** ACTIVE with b settled too: only a runs. */
const B_SETTLED = (a: number): Listed[] => [agent("a", { lastActivityAt: a }), agent("b", { running: false, state: "completed" }), agent("c", { running: false, state: "completed" })];

void test("f follows the running agent with the newest activity, stays on it while it runs and stops on navigation", async (t) => {
  timers(t);
  const harness = await open(ACTIVE(10, 20, 99), { initialKey: "a" });
  assert.doesNotMatch(title(harness), /following/);
  assert.match(harness.screen().at(-1) ?? "", / · f follow · /, "a running agent: the hint names f before it is on");
  harness.send("f");
  assert.match(title(harness), /^#2\/3 b .*following/);
  assert.match(harness.screen().at(-1) ?? "", /f stop following/);
  for (const [a, b] of [[30, 20], [30, 40], [50, 40]] as const) {
    harness.agents = ACTIVE(a, b, 99);
    await advance(t);
    assert.match(title(harness), /^#2\/3 b .*following/, `b runs: activity a ${String(a)}, b ${String(b)} keeps it`);
  }
  assert.deepEqual(harness.opened, ["a", "b"], "no other transcript was opened while b ran");
  harness.agents = B_SETTLED(50);
  await advance(t);
  assert.match(title(harness), /^#1\/3 a .*following/, "b settled: the running agent with the newest activity");
  harness.send(KEY.down);
  assert.doesNotMatch(title(harness), /following/, "an arrow stops it");
  for (const key of ["j", "[", "n", "]"]) {
    harness.send("f");
    assert.match(title(harness), /following/);
    harness.send(key);
    assert.doesNotMatch(title(harness), /following/, `${key} stops it`);
  }
  await leave(harness);
});

void test("f with no running agent does nothing, and a click stops it", async (t) => {
  timers(t);
  // b is left running in a run a crash interrupted: recorded as running, not running.
  const harness = await open([agent("a", { running: false, state: "completed", lastActivityAt: 5 }), agent("b", { running: false })], { initialKey: "b" });
  assert.doesNotMatch(harness.screen().at(-1) ?? "", /f follow/, "nothing runs: the hint does not offer follow");
  harness.send("f");
  assert.match(title(harness), /^#2\/2 b /);
  assert.doesNotMatch(title(harness), /following/, "nothing to follow: f stays off");
  assert.doesNotMatch(harness.screen().at(-1) ?? "", /f stop following/);
  await leave(harness);
  const two = await open(ACTIVE(10, 20, 1), { initialKey: "a" });
  two.send("f");
  click(two, 4, 2);
  assert.doesNotMatch(title(two), /following/);
  await leave(two);
});

void test("the title names no state for an agent recorded as running in a run that is not live", async (t) => {
  timers(t);
  const harness = await open([agent("a", { running: false, leftover: true }), agent("b")], { initialKey: "a" });
  assert.equal(title(harness), "#1/2 a gpt-5 1.2k tok", "a crash left a recorded as running in an interrupted run: no running in its title");
  harness.send("]");
  assert.equal(title(harness), "#2/2 b running gpt-5 1.2k tok", "b runs");
  await leave(harness);
  const themed = await open([agent("a", { running: false, leftover: true })], { initialKey: "a", theme: MARKED });
  assert.match(titleRow(themed), /^#1\/1 <bold:a> <muted:gpt-5 1\.2k tok>/, "no styled empty state between the name and the summary");
  await leave(themed);
});

void test("opening a menu stops follow mode; a state with following opens following", async (t) => {
  timers(t);
  const provider = new FakeProvider({ "workflow-agent": steps("Stop") });
  const specs = TARGETED().map((spec) => spec.agent ? { ...spec, agent: agent(spec.key, { lastActivityAt: spec.key === "c" ? 9 : 1 }) } : spec);
  const harness = await open([], { nodes: tree(specs), actions: [provider], initialKey: "a" });
  harness.send("f");
  assert.match(title(harness), /^#3\/4 c .*following/);
  harness.send("a");
  await settle();
  assert.doesNotMatch(title(harness), /following/);
  await leave(harness);
  const again = await open([], { nodes: tree(specs), actions: [provider], initialKey: "a", state: { selectedKey: "a", row: 0, expansion: [], focus: "sidebar", sidebarVisible: true, toolsExpanded: false, detailsShown: false, following: true } });
  assert.match(title(again), /^#3\/4 c .*following/);
  await leave(again);

  const aside = await open([], { nodes: tree(specs), actions: [provider], initialKey: "a" });
  aside.send("f");
  aside.send("a");
  await settle();
  assert.doesNotMatch(title(aside), /following/, "the open menu stops it");
  aside.send(KEY.enter);
  await aside.done;
  assert.equal(aside.exit?.state.following, true, "a step-aside hands follow mode back");
  const resumed = await open([], { nodes: tree(specs), actions: [provider], initialKey: "a", state: aside.exit.state });
  assert.match(title(resumed), /^#3\/4 c .*following/);
  await leave(resumed);

  const closed = await open([], { nodes: tree(specs), actions: [provider], initialKey: "a" });
  closed.send("f", "a");
  await settle();
  closed.send(KEY.escape);
  assert.doesNotMatch(title(closed), /following/, "closing the menu leaves it off");
  await leave(closed);
});

const FILTERED = (): Listed[] => [agent("alpha"), agent("beta", { depth: 1, state: "failed", running: false }), agent("gamma", { depth: 1 }), agent("scout", { group: "Subagents", state: "failed", running: false })];

void test("/ filters the sidebar by text with ancestors, shows the count and keeps or moves the selection", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { initialKey: "gamma" });
  harness.send("/");
  assert.ok((harness.screen()[1] ?? "").startsWith("/ "), "the input row opens under the title");
  assert.equal((harness.screen().at(-1) ?? "").trimEnd(), "enter keep filter · escape clear", "ctrl+c leaves, so the hint names it for no clear");
  harness.send("B", "E", "T");
  assert.deepEqual(sidebarRows(harness).map((line) => line.replace(/^[^\w]*/, "").split(" ")[0]), ["build", "alpha", "beta"], "ancestors kept, case-insensitive");
  assert.match(title(harness), /^build a1b2 .* 1 match$/, "the selection stays on the run, shown as an ancestor; the count has no ancestors");
  harness.send("\x7f", "\x7f", "\x7f");
  harness.send("g", "a", "m");
  assert.match(title(harness), /^build a1b2 .* 1 match$/, "the selection stays on the run: it still shows as an ancestor");
  harness.send(KEY.enter);
  assert.ok(!(harness.screen()[1] ?? "").startsWith("/ "), "the input row closes");
  assert.match(harness.screen().at(-1) ?? "", /^\/ filter: gam · escape clear/);
  harness.send(KEY.escape);
  assert.equal(sidebarRows(harness).length, 6, "esc cleared it");
  assert.doesNotMatch(harness.screen().at(-1) ?? "", /filter:/);
  await leave(harness);
});

void test("the filter is Pi's input: ← moves its cursor, backspace takes a whole emoji, a click places the cursor, a paste is filtered as text, a restored filter is edited at its end", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { initialKey: "gamma" });
  const hint = (): string => (harness.screen().at(-1) ?? "").trimEnd();
  harness.send("/", "g", "m", KEY.left, "a", "👩‍💻", "\x7f", KEY.enter);
  assert.match(hint(), /^\/ filter: gam · /, "a typed between g and m, the emoji taken back whole");
  harness.send("/");
  assert.ok((harness.screen()[1] ?? "").startsWith("/ gam"), "the input opens with the filter");
  click(harness, 2, 1);
  harness.send("x", KEY.enter);
  assert.match(hint(), /^\/ filter: xgam · /, "the click put the cursor before g");
  harness.send(KEY.escape, "/", paste(`al${ESC}[31mp`));
  assert.match(titleRow(harness), / · 1 match /);
  harness.alt().renderNow();
  assert.ok(!(harness.alt().getScreenLines()[1] ?? "").includes(`${ESC}[31m`), "the open input row draws the paste without its escape sequence");
  harness.send(KEY.enter);
  assert.match(hint(), /^\/ filter: alp · /, "the paste's escape sequence is not in the filter");
  await leave(harness);
  const state: AgentsWorkspaceState = { selectedKey: "gamma", row: 0, expansion: [], focus: "sidebar", sidebarVisible: true, toolsExpanded: false, detailsShown: false, filter: "ga" };
  const restored = await open(FILTERED(), { state });
  restored.send("/", "m", KEY.enter);
  assert.match((restored.screen().at(-1) ?? "").trimEnd(), /^\/ filter: gam · /, "typing goes after the restored text");
  await leave(restored);
});

void test("the filter takes a state: prefix, escapes with esc while open, and keeps the selection that still shows", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { initialKey: "scout" });
  harness.send("/");
  for (const char of "state:failed") harness.send(char);
  assert.equal(sidebarRows(harness).filter((line) => /alpha|beta|scout/.test(line)).length, 3, "failed agents and the ancestor of beta");
  assert.doesNotMatch(sidebarRows(harness).join("\n"), /gamma/);
  assert.match(title(harness), /^#4\/4 scout .*2 matches/, "the selection stays");
  harness.send(KEY.escape);
  assert.equal(sidebarRows(harness).filter((line) => /gamma/.test(line)).length, 1);
  assert.equal(harness.left, false, "esc closed the filter, not the workspace");
  await leave(harness);
});

/** A theme that wraps text in visible markers: <dim:...>, <accent:...> and <bold:...>. */
const MARKED = { fg: (color: string, text: string) => `<${color}:${text}>`, bold: (text: string) => `<bold:${text}>` } as unknown as Theme;

/** With `query` typed in the filter (none when empty), the first sidebar row holding `row` matches `expected` and not `absent`. */
const HIGHLIGHTS: readonly { readonly name: string; readonly agents: () => Listed[]; readonly initialKey?: string; readonly query: string; readonly row: string; readonly expected: RegExp; readonly absent?: RegExp }[] = [
  { name: "no filter dims nothing", agents: FILTERED, initialKey: "scout", query: "", row: "build", expected: /build/, absent: /<dim:/ },
  { name: "the run is dimmed as an ancestor", agents: FILTERED, initialKey: "scout", query: "Gam", row: "build", expected: /^<dim:.*build.*>/ },
  { name: "so is alpha", agents: FILTERED, initialKey: "scout", query: "Gam", row: "alpha", expected: /^<dim:.*alpha/ },
  { name: "the match is not dimmed and has no accent in its label", agents: FILTERED, initialKey: "scout", query: "Gam", row: "gam", expected: /gamma/, absent: /<dim:|<accent:gam/ },
  { name: "a bold header label is drawn whole", agents: FILTERED, query: "bui", row: "build", expected: /build/, absent: /<dim:|<accent:bui>/ },
  { name: "the Subagents group label is drawn whole", agents: FILTERED, query: "agen", row: "Subagents", expected: /Subagents/, absent: /<accent:agen>/ },
  { name: "a match in another case has no accent", agents: () => [agent("Gamma")], query: "gAm", row: "Gamma", expected: /Gamma/, absent: /<accent:Gam>/ },
  { name: "the dimmed selected ancestor keeps →", agents: FILTERED, initialKey: "alpha", query: "gam", row: "alpha", expected: /^<dim:→/ },
  { name: "the selected match keeps →", agents: FILTERED, initialKey: "gamma", query: "gam", row: "gamma", expected: /^→/, absent: /<dim:|<accent:gam>/ },
  { name: "a state: match keeps its line", agents: FILTERED, query: "state:failed", row: "scout", expected: /scout/, absent: /<dim:|<bold:(?:state|failed|scout)>|<accent:/ },
  { name: "a short id match keeps its line", agents: () => [agent("id77", { name: "delta" })], query: "id77", row: "delta", expected: /delta/, absent: /<bold:|<dim:|<accent:delta/ },
];

void test("a filter dims the ancestors and leaves the matching rows undimmed, with no accent inside a label", async (t) => {
  timers(t);
  for (const { name, agents, initialKey, query, row, expected, absent } of HIGHLIGHTS) {
    const harness = await open(agents(), { theme: MARKED, ...(initialKey === undefined ? {} : { initialKey }) });
    if (query) {
      harness.send("/");
      for (const char of query) harness.send(char);
    }
    // The sidebar row, not the title or the filter row, without the separator drawn after it.
    const line = harness.screen().find((candidate) => candidate.includes(row) && !/^[#/]/.test(candidate))?.replace(/\s+<di\S*\s*$/, "").trimEnd() ?? "";
    assert.match(line, expected, name);
    if (absent) assert.doesNotMatch(line, absent, name);
    await leave(harness);
  }
});

// eslint-disable-next-line no-control-regex
const ESCAPES = /\x1b\[[0-9;]*m/g;
// eslint-disable-next-line no-control-regex
const UNDIMMED_AFTER_RESET = /\x1b\[(?:22;)?39m(?!\x1b\[38;2;9;9;9m)[^\s\x1b]/;
const DIM_OPEN = "\x1b[38;2;9;9;9m";
const ANSI = {
  fg: (color: string, text: string) => `${color === "dim" ? DIM_OPEN : "\x1b[38;2;1;2;3m"}${text}\x1b[39m`,
  bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

void test("a dimmed ancestor stays dim after the coloured parts of its line", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { initialKey: "scout", theme: ANSI });
  harness.send("/", "g", "a", "m");
  const index = harness.screen().findIndex((line) => line.includes("build"));
  assert.ok(index >= 0, "the run header shows");
  const header = harness.alt().getScreenLines()[index] ?? "";
  assert.ok(header.includes(`${DIM_OPEN}  ▾ build`), "the run header opens dim before its text");
  assert.ok(header.includes(`\x1b[39m${DIM_OPEN}`), "the dim colour is back after the coloured state glyph");
  assert.ok((header.match(ESCAPES) ?? []).length > 4, "the header holds coloured parts of its own");
  assert.doesNotMatch(header, UNDIMMED_AFTER_RESET, "no text follows a reset without the dim colour");
  await leave(harness);
});

void test("the filter survives a step-aside at 120, 70 and 40 columns", async (t) => {
  timers(t);
  const provider = new FakeProvider({ "workflow-agent": steps("Stop") });
  const specs = TARGETED();
  const harness = await open([], { nodes: tree(specs), actions: [provider], initialKey: "c" });
  harness.send("/", "c", KEY.enter);
  harness.send("a");
  await settle();
  harness.send(KEY.enter);
  await harness.done;
  const state = harness.exit?.state;
  assert.equal(state?.filter, "c");
  for (const columns of [120, 70, 40]) {
    const again = await open([], { nodes: tree(specs), actions: [provider], state: state, columns });
    assert.match(again.screen().at(-1) ?? "", /filter: c/);
    assert.match(titleRow(again), /\d+ match/, "the count shows");
    assert.ok(sidebarRows(again).length < TARGETED().length, "the restored sidebar is filtered");
    await leave(again);
  }
});

void test("a tie keeps a selection that is not the first of the tied nodes", async (t) => {
  timers(t);
  const harness = await open(ACTIVE(30, 30, 1), { initialKey: "b" });
  harness.send("f");
  assert.match(title(harness), /^#2\/3 b .*following/);
  harness.agents = ACTIVE(40, 40, 1);
  await advance(t);
  assert.match(title(harness), /^#2\/3 b /, "still b");
  await leave(harness);
});

void test("scrolling the transcript away from the tail stops following and the view stays put", async (t) => {
  timers(t);
  const harness = await open(ACTIVE(10, 20, 1), { initialKey: "a", setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  harness.send("f");
  await settle();
  harness.screen();
  const end = harness.alt().viewportTop;
  assert.ok(end > 0, "a transcript to scroll");
  harness.send(KEY.pageUp);
  harness.screen();
  const top = harness.alt().viewportTop;
  assert.ok(top < end);
  await advance(t);
  harness.screen();
  assert.doesNotMatch(title(harness), /following/);
  assert.equal(harness.alt().viewportTop, top, "the tick does not jump back");
  harness.send("f", KEY.ctrlHome);
  await advance(t);
  assert.doesNotMatch(title(harness), /following/, "ctrl+home stops it");
  await leave(harness);
});

void test("a scroll-away seen on the refresh where the followed agent settles stops following without a switch", async (t) => {
  timers(t);
  const harness = await open(ACTIVE(10, 20, 1), { initialKey: "a", setup: (source) => { source.polls.push(polled(entries(0, 100))); } });
  harness.send("f");
  await settle();
  harness.screen();
  harness.send(KEY.pageUp);
  harness.screen();
  harness.agents = B_SETTLED(30);
  await advance(t);
  assert.doesNotMatch(title(harness), /following/);
  assert.match(title(harness), /^#2\/3 b /, "the selection stays on b");
  assert.deepEqual(harness.opened, ["a", "b"], "a's transcript was not opened");
  await leave(harness);
});

void test("a state word without the state: prefix does not match, and pasted whitespace is normalized", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { initialKey: "gamma" });
  harness.send("/");
  for (const char of "fail") harness.send(char);
  assert.doesNotMatch(sidebarRows(harness).join("\n"), /alpha|beta|scout/, "fail names no node");
  harness.send(KEY.escape);
  harness.send("/", paste("build \t\n  a1b2"));
  assert.match(sidebarRows(harness).join("\n"), /build a1b2/, "tabs, newlines and repeated spaces match single spaces");
  assert.doesNotMatch(sidebarRows(harness).join("\n"), /gamma/);
  await leave(harness);
});

void test("the filter matches a node's label, ID and state, not what its title adds to them: a glyph, counts and cost", async (t) => {
  timers(t);
  // The run root's title carries what its header row shows after the label.
  const nodes = nodesOf([agent("alpha"), agent("b7", { name: "beta", state: "failed", running: false })])
    .map((node) => node.agent ? node : { ...node, id: "R1d2", title: () => `${node.label} ⠦ 1/2 $0.12 ${node.state}` });
  const harness = await open([], { nodes, initialKey: "alpha" });
  const matches = (query: string): string => {
    harness.send("/", paste(query), KEY.enter);
    const count = / (\d+) match/.exec(titleRow(harness))?.[1] ?? "none";
    harness.send(KEY.escape);
    return count;
  };
  for (const query of ["⠦", "1/2", "$0.12"]) assert.equal(matches(query), "0", query);
  assert.deepEqual(["build", "a1b2", "r1d", "alp", "b7", "bet", "state:failed", "state:running"].map(matches), ["1", "1", "1", "1", "1", "1", "1", "2"]);
  await leave(harness);
});

void test("state:running does not match an agent a crash left active, state:interrupted does, and its recorded paused still matches state:paused", async (t) => {
  timers(t);
  const nodes = nodesOf([agent("alpha"), agent("b7", { name: "beta", state: "running", running: false, leftover: true }), agent("c9", { name: "gamma", state: "paused", running: false, leftover: true })]);
  const harness = await open([], { nodes, initialKey: "alpha" });
  const matches = (query: string): string => {
    harness.send("/", paste(query), KEY.enter);
    const count = / (\d+) match/.exec(titleRow(harness))?.[1] ?? "none";
    harness.send(KEY.escape);
    return count;
  };
  // The run root says running too.
  assert.deepEqual(["state:running", "state:paused", "state:interrupted"].map(matches), ["2", "1", "2"]);
  await leave(harness);
});

void test("under a filter left and right move to the parent and the first shown child and space leaves the expansion alone", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { initialKey: "gamma" });
  harness.send("/", "g", "a", "m", KEY.enter);
  harness.send(KEY.left);
  assert.match(title(harness), /^#1\/4 alpha/, "left goes to the parent");
  harness.send("l");
  assert.match(title(harness), /^#3\/4 gamma/, "l goes to the first shown child, skipping the hidden beta");
  harness.send("h", "h");
  assert.match(title(harness), /^build /, "h again reaches the run");
  harness.send("l", " ");
  assert.match(title(harness), /^#1\/4 alpha/);
  harness.send(KEY.escape);
  assert.equal(sidebarRows(harness).length, 6, "space changed nothing once the filter is cleared");
  await leave(harness);
});

void test("a refresh that takes the selected node out of the filter moves the selection to the first match", async (t) => {
  timers(t);
  const specs = (second: string): Spec[] => [{ key: "k1", agent: agent("one") }, { key: "k2", agent: agent(second) }, { key: "k3", agent: agent("other") }, { key: "k4", agent: agent("gamut") }];
  const harness = await open([], { nodes: tree(specs("gamma")), initialKey: "k2" });
  harness.send("/", paste("gam"), KEY.enter);
  assert.match(title(harness), /^#2\/4 gamma .*2 matches/);
  harness.nodes = tree(specs("delta"));
  await advance(t);
  assert.match(title(harness), /^#4\/4 gamut .*1 match$/, "the selected node stays listed but no longer matches: the first match is selected");
  assert.doesNotMatch(sidebarRows(harness).join("\n"), /other|delta/, "the sidebar stays filtered");
  await leave(harness);
});

void test("a filter of only spaces filters nothing and esc leaves the workspace", async (t) => {
  timers(t);
  const harness = await open(FILTERED(), { initialKey: "alpha" });
  const rows = sidebarRows(harness);
  harness.send("/", " ", KEY.enter);
  assert.deepEqual(sidebarRows(harness), rows, "every row stays");
  assert.doesNotMatch(titleRow(harness), /match/, "no match count");
  harness.send(KEY.escape);
  await harness.done;
  assert.equal(harness.left, true);
});

void test("under a filter ] and n visit only the shown nodes, and N goes back", async (t) => {
  timers(t);
  const nodes = needing(nodesOf(FILTERED()), { alpha: "failed", beta: "failed", gamma: "failed", scout: "failed" });
  for (const next of ["]", "n"]) {
    const harness = await open([], { nodes, initialKey: "alpha" });
    harness.send("/", paste("state:failed"), KEY.enter);
    harness.send(next);
    assert.match(title(harness), /^#2\/4 beta/, next);
    harness.send(next);
    assert.match(title(harness), /^#4\/4 scout/, `${next}: gamma is skipped`);
    if (next === "n") {
      harness.send("N");
      assert.match(title(harness), /^#2\/4 beta/);
    }
    await leave(harness);
  }
});

void test("state: does not match the Subagents group, whose state summarizes its children", async (t) => {
  timers(t);
  const nodes = tree([{ key: "subagents", kind: "group", label: "Subagents", state: "failed" }, { key: "scout", parent: "subagents", agent: agent("scout", { state: "failed", running: false }) }]);
  const harness = await open([], { nodes, initialKey: "scout" });
  harness.send("/", paste("state:failed"), KEY.enter);
  assert.match(titleRow(harness), / 1 match\b/);
  await leave(harness);
});

void test("a live event replayed while an agent opens that throws is reported in the title", async (t) => {
  timers(t);
  const live = new FakeLive();
  live.replay.push({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "x" } });
  const harness = await open([agent("alpha"), agent("beta", { live })], { failLive: "beta" });
  harness.send(KEY.down);
  assert.match(titleRow(harness), /agents workspace failed: live failed/);
  await leave(harness);
});

void test("follow only picks among the shown nodes of a filter", async (t) => {
  timers(t);
  const harness = await open(ACTIVE(10, 20, 1), { initialKey: "a" });
  harness.send("/", "a", KEY.enter);
  harness.send("f");
  assert.match(title(harness), /^#1\/3 a .*following/, "b is filtered out");
  await leave(harness);
});


void test("the hint names the keys the user's bindings resolve to", async (t) => {
  timers(t);
  const custom = new KeybindingsManager({ ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } }, { "tui.select.up": "u", "tui.select.down": "d", "tui.select.cancel": "ctrl+q", "tui.select.confirm": "ctrl+e", "tui.editor.cursorLeft": "h", "tui.editor.cursorRight": "l" }) as unknown as typeof KEYBINDINGS;
  const harness = await open([agent("alpha")], { keybindings: custom });
  const hint = (): string => (harness.screen().at(-1) ?? "").trimEnd();
  assert.match(hint(), /h\/l fold/, "the sidebar's fold pair follows the bindings");
  harness.send(KEY.tab);
  assert.equal(hint(), "u/d scroll · ctrl+q back · f follow · [ ] agent · tab focus · ctrl+shift+f search · s sidebar · ctrl+o tools");
  harness.send(KEY.tab, "/");
  assert.equal(hint(), "enter keep filter · ctrl+q clear", "the input submits with Pi's submit key");
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
