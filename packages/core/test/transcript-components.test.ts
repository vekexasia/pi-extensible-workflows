import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, type Terminal, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import type { TranscriptView } from "../src/agents-workspace-contract.js";
import { createTranscriptView } from "../src/transcript-components.js";
import type { TranscriptRecord } from "../src/transcript-source.js";

initTheme("dark", false);

class FakeTerminal implements Terminal {
  readonly columns = 120;
  readonly rows = 40;
  readonly kittyProtocolActive = false;
  readonly writes: string[] = [];
  start(): void { /* no input in tests */ }
  stop(): void { /* nothing to restore */ }
  drainInput(): Promise<void> { return Promise.resolve(); }
  write(data: string): void { this.writes.push(data); }
  moveBy(): void { /* captured writes only */ }
  hideCursor(): void { /* captured writes only */ }
  showCursor(): void { /* captured writes only */ }
  clearLine(): void { /* captured writes only */ }
  clearFromCursor(): void { /* captured writes only */ }
  clearScreen(): void { /* captured writes only */ }
  setTitle(): void { /* captured writes only */ }
  setProgress(): void { /* captured writes only */ }
}

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const C1_CSI = String.fromCharCode(0x9b);
const C1_OSC = String.fromCharCode(0x9d);
/** A title (OSC 0), a clipboard write (OSC 52), a window title report request (CSI 21 t), and C1 forms of CSI and OSC. */
const HOSTILE = `${ESC}]0;TITLE${BEL}${ESC}]52;c;Y2xpcA==${BEL}${ESC}[21t${C1_CSI}6n${C1_OSC}0;TITLE${BEL}`;
const MB = 1024 * 1024;

function setup(cwd = tmpdir()): { readonly view: TranscriptView; readonly ui: TuiAltScreen; readonly terminal: FakeTerminal; readonly raw: (width?: number) => string[]; readonly text: (width?: number) => string } {
  const terminal = new FakeTerminal();
  const ui = new TuiAltScreen(terminal);
  const view = createTranscriptView({ ui, cwd });
  const raw = (width = 80): string[] => {
    const lines = view.component.render(width);
    for (const line of lines) assert.ok(visibleWidth(line) <= width, `wider than ${String(width)}: ${JSON.stringify(stripTerminalSequences(line))}`);
    return lines;
  };
  return { view, ui, terminal, raw, text: (width = 80) => raw(width).map((line) => stripTerminalSequences(line)).join("\n") };
}
/** None of the sequences of HOSTILE, no BEL and no C1 control reach the screen. */
function assertInert(screen: string): void {
  for (const sequence of [`${ESC}]0;`, `${ESC}]52;`, `${ESC}[21t`]) assert.ok(!screen.includes(sequence), JSON.stringify(sequence));
  const controls = Array.from({ length: screen.length }, (_, index) => screen.charCodeAt(index)).filter((code) => code === 7 || (code >= 0x80 && code <= 0x9f));
  assert.deepEqual(controls, []);
}
function entry(offset: number, value: Readonly<Record<string, unknown>>): TranscriptRecord { return { kind: "entry", offset, bytes: 100, value }; }
function message(offset: number, value: Readonly<Record<string, unknown>>): TranscriptRecord { return entry(offset, { type: "message", message: value }); }
function user(offset: number, text: string): TranscriptRecord { return message(offset, { role: "user", content: text }); }
function call(offset: number, id: string, name: string, args: Readonly<Record<string, unknown>>): TranscriptRecord {
  return message(offset, { role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" });
}
function result(offset: number, id: string, name: string, output: string): TranscriptRecord {
  return message(offset, { role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: output }], isError: false });
}
function count(text: string, part: string): number { return text.split(part).length - 1; }
/** Each part appears, in this order. */
function assertOrder(text: string, parts: readonly string[]): void {
  let from = 0;
  for (const part of parts) {
    const index = text.indexOf(part, from);
    assert.ok(index >= 0, `missing or out of order: ${part}`);
    from = index + part.length;
  }
}
function lines(prefix: string, total: number): string { return Array.from({ length: total }, (_, index) => `${prefix}-${String(index + 1).padStart(2, "0")}`).join("\n"); }

void test("each record kind renders the text it carries, in file order and within the width", () => {
  const { view, text } = setup();
  view.append([
    entry(0, { type: "session", id: "session-1", cwd: "/project" }),
    user(100, "USER-TEXT"),
    message(200, { role: "assistant", content: [{ type: "thinking", thinking: "THINKING-TEXT" }, { type: "text", text: "ASSISTANT-TEXT" }], stopReason: "stop" }),
    call(300, "c1", "bash", { command: "echo BASH-CALL" }),
    result(400, "c1", "bash", "BASH-RESULT"),
    message(500, { role: "bashExecution", command: "echo USER-BASH", output: "USER-BASH-OUTPUT", exitCode: 2, cancelled: false, truncated: false }),
    message(600, { role: "custom", customType: "note", content: "CUSTOM-MESSAGE", display: true }),
    entry(700, { type: "custom_message", customType: "entry-note", content: [{ type: "text", text: "CUSTOM-ENTRY" }], display: true }),
    entry(800, { type: "custom_message", customType: "hidden-note", content: "CUSTOM-HIDDEN", display: false }),
    entry(900, { type: "compaction", summary: "COMPACTION-SUMMARY", tokensBefore: 999, firstKeptEntryId: "a" }),
    message(1000, { role: "compactionSummary", summary: "COMPACTION-MESSAGE", tokensBefore: 99 }),
    entry(1100, { type: "branch_summary", summary: "BRANCH-SUMMARY", fromId: "b" }),
    message(1200, { role: "branchSummary", summary: "BRANCH-MESSAGE", fromId: "c" }),
    message(1300, { role: "system", content: "SYSTEM-PROMPT" }),
    entry(1400, { type: "model_change", provider: "openai", modelId: "gpt-x" }),
    entry(1500, { type: "thinking_level_change", thinkingLevel: "high" }),
    entry(1600, { type: "label", label: "LABEL-X", targetId: "t1" }),
    entry(1700, { type: "session_info", name: "SESSION-NAME" }),
    entry(1800, { type: "context_edit", targetId: "t2", replacement: null }),
    { kind: "large", offset: 1900, bytes: 2 * MB },
    { kind: "unreadable", offset: 2000, bytes: 512 },
  ]);
  text(40);
  assertOrder(text(), [
    "USER-TEXT", "THINKING-TEXT", "ASSISTANT-TEXT", "$ echo BASH-CALL", "BASH-RESULT", "$ echo USER-BASH", "USER-BASH-OUTPUT", "(exit 2)",
    "[note]", "CUSTOM-MESSAGE", "[entry-note]", "CUSTOM-ENTRY", "custom hidden-note (hidden in Pi)", "CUSTOM-HIDDEN",
    "[compaction]", "Compacted from 999 tokens", "[compaction]", "Compacted from 99 tokens", "[branch]", "Branch summary", "[branch]", "Branch summary",
    "system prompt", "SYSTEM-PROMPT", "model: openai/gpt-x", "thinking level: high", "label LABEL-X on t1", "session name: SESSION-NAME",
    "context edit: t2 left out of the model context", "large record · 2.0 MB · enter to load", "unreadable record · 512 B",
  ]);
  view.setExpanded(true);
  assertOrder(text(), ["COMPACTION-SUMMARY", "COMPACTION-MESSAGE", "BRANCH-SUMMARY", "BRANCH-MESSAGE"]);
  text(40);
});

void test("terminal sequences in the session file reach the screen as text only", () => {
  const { view, raw, text } = setup();
  view.append([
    user(100, `${ESC}]0;user title${BEL}USER ${ESC}[31mRED${ESC}[0m`),
    message(200, { role: "assistant", content: [{ type: "text", text: `ASSISTANT ${ESC}]52;c;Y2xpcA==${BEL}CLIP` }], stopReason: "stop" }),
    message(300, { role: "system", content: `SYSTEM ${ESC}[2J CLEAR` }),
  ]);
  const screen = raw().join("\n");
  for (const sequence of [`${ESC}]0;`, `${ESC}[31m`, `${ESC}]52;`, `${ESC}[2J`]) assert.ok(!screen.includes(sequence), JSON.stringify(sequence));
  assertOrder(text(), ["USER RED", "ASSISTANT CLIP", "SYSTEM", "CLEAR"]);
});

void test("terminal sequences in tool arguments and details reach the screen and the terminal as text only", () => {
  const { view, ui, terminal, raw, text } = setup();
  ui.addChild(view.component);
  view.append([
    call(100, "c1", "bash", { command: `echo BASH-ARG ${HOSTILE}` }),
    message(200, { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "BASH-OUTPUT" }], details: { truncation: { truncated: true }, fullOutputPath: `/tmp/FULL-PATH${HOSTILE}` }, isError: false }),
    call(300, "c2", "read", { path: `READ-PATH${HOSTILE}` }),
    call(400, "c3", "edit", { path: `EDIT-PATH${HOSTILE}`, edits: [{ oldText: `OLD${HOSTILE}`, newText: `NEW${HOSTILE}` }] }),
    message(500, { role: "toolResult", toolCallId: "c3", toolName: "edit", content: [{ type: "text", text: "EDITED" }], details: { diff: `+1 DIFF-LINE${HOSTILE}` }, isError: false }),
    call(600, "c4", "write", { path: `WRITE-PATH${HOSTILE}`, content: `WRITE-CONTENT${HOSTILE}` }),
    call(700, "c5", "grep", { pattern: `GREP-PATTERN${HOSTILE}`, path: "." }),
    call(800, "c6", "custom_tool", { query: `GENERIC-ARG${HOSTILE}`, [`GENERIC-KEY${HOSTILE}`]: `GENERIC-VALUE${C1_CSI}6n` }),
    message(900, { role: "bashExecution", command: `echo BANG-ARG ${HOSTILE}`, output: "BANG-OUTPUT", exitCode: 0, cancelled: false, truncated: true, fullOutputPath: `/tmp/BANG-PATH${HOSTILE}` }),
  ]);
  ui.start();
  try {
    for (const expanded of [false, true]) {
      view.setExpanded(expanded);
      assertInert(raw().join("\n"));
      ui.renderNow(true);
    }
  } finally {
    ui.stop();
  }
  // TuiAltScreen closes hyperlinks itself with an OSC 8 that ends in BEL.
  assertInert(terminal.writes.join("").split(`${ESC}]8;;${BEL}`).join(""));
  assertOrder(text(), [
    "$ echo BASH-ARG", "BASH-OUTPUT", "Full output: /tmp/FULL-PATH", "READ-PATH", "EDIT-PATH", "DIFF-LINE", "WRITE-PATH", "WRITE-CONTENT", "GREP-PATTERN",
    "custom_tool", "GENERIC-ARG", "GENERIC-KEY", "GENERIC-VALUE", "$ echo BANG-ARG", "BANG-OUTPUT", "Output truncated. Full output: /tmp/BANG-PATH",
  ]);
});

void test("tool calls of a message that stopped on an error or an abort show that stop and take no later result", () => {
  const stopped = [
    message(100, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "alpha", arguments: { query: "FAILED-ARGS" } }], stopReason: "error", errorMessage: `UPSTREAM-FAILED ${ESC}]0;x${BEL}` }),
    message(200, { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "beta", arguments: { query: "ABORTED-ARGS" } }], stopReason: "aborted", errorMessage: "Request was aborted" }),
    message(300, { role: "assistant", content: [{ type: "toolCall", id: "c3", name: "gamma", arguments: { query: "BARE-ARGS" } }], stopReason: "error" }),
  ];
  const late = result(400, "c1", "alpha", "LATE-OUTPUT");
  const { view, raw, text } = setup();
  view.append([...stopped, late]);
  const rendered = text();
  assertOrder(rendered, ["alpha", "FAILED-ARGS", "UPSTREAM-FAILED", "beta", "ABORTED-ARGS", "Operation aborted", "gamma", "BARE-ARGS", "Error", "alpha", "{}", "LATE-OUTPUT"]);
  assert.equal(count(rendered, "UPSTREAM-FAILED"), 1);
  assert.equal(count(rendered, "alpha"), 2);
  assert.ok(!rendered.includes("Request was aborted"));
  assertInert(raw().join("\n"));
  const prepended = setup();
  prepended.view.append([late]);
  prepended.view.prepend(stopped);
  assert.equal(prepended.text(), rendered);
});

void test("an earlier call prepended with the id of a later call leaves that call its results", () => {
  const older = [user(100, "OLDER"), call(200, "c1", "alpha", { query: "OLDER-ARGS" })];
  const newer = call(300, "c1", "beta", { query: "NEWER-ARGS" });
  const results = [result(400, "c1", "beta", "NEWER-OUTPUT"), result(500, "c1", "beta", "REPEATED-OUTPUT")];
  const { view, text } = setup();
  view.append([newer]);
  view.prepend(older);
  view.append(results);
  const rendered = text();
  assertOrder(rendered, ["OLDER", "alpha", "OLDER-ARGS", "beta", "NEWER-ARGS", "NEWER-OUTPUT", "beta", "{}", "REPEATED-OUTPUT"]);
  assert.equal(count(rendered, "NEWER-OUTPUT"), 1);
  const loaded = setup();
  loaded.view.append([newer, ...results]);
  loaded.view.prepend(older);
  assert.equal(loaded.text(), rendered);
  const whole = setup();
  whole.view.append([...older, newer, ...results]);
  assert.equal(whole.text(), rendered);
});

void test("a tool call and its result form one block, also when the result comes in a later append", () => {
  const records = [user(100, "BEFORE"), call(200, "c1", "alpha", { query: "CALL-ARGS" }), result(300, "c1", "alpha", "PAIRED-OUTPUT"), user(400, "AFTER")];
  const whole = setup();
  whole.view.append(records);
  const text = whole.text();
  assert.equal(count(text, "alpha"), 1);
  assert.equal(count(text, "PAIRED-OUTPUT"), 1);
  assertOrder(text, ["BEFORE", "alpha", "CALL-ARGS", "PAIRED-OUTPUT", "AFTER"]);
  const later = setup();
  later.view.append(records.slice(0, 2));
  assertOrder(later.text(), ["BEFORE", "alpha", "CALL-ARGS"]);
  assert.ok(!later.text().includes("PAIRED-OUTPUT"));
  later.view.append(records.slice(2));
  assert.equal(later.text(), text);
});

void test("a result whose call is not loaded renders on its own", () => {
  const { view, text } = setup();
  view.append([result(100, "c9", "alpha", "ORPHAN-OUTPUT"), user(200, "AFTER")]);
  assertOrder(text(), ["alpha", "{}", "ORPHAN-OUTPUT", "AFTER"]);
});

void test("an earlier chunk prepended before a loaded result pairs it with its call", () => {
  const earlier = [user(100, "EARLIER"), call(200, "c1", "alpha", { query: "PREPENDED-ARGS" }), call(300, "c2", "beta", { query: "CHUNK-ARGS" }), result(400, "c2", "beta", "CHUNK-OUTPUT")];
  const loaded = [result(500, "c1", "alpha", "PAIRED-OUTPUT"), user(600, "LATER")];
  const { view, text } = setup();
  view.append(loaded);
  assertOrder(text(), ["alpha", "{}", "PAIRED-OUTPUT", "LATER"]);
  view.prepend(earlier);
  const prepended = text();
  assertOrder(prepended, ["EARLIER", "alpha", "PREPENDED-ARGS", "PAIRED-OUTPUT", "beta", "CHUNK-ARGS", "CHUNK-OUTPUT", "LATER"]);
  assert.equal(count(prepended, "alpha"), 1);
  assert.equal(count(prepended, "PAIRED-OUTPUT"), 1);
  assert.ok(!prepended.includes("{}"));
  const whole = setup();
  whole.view.append([...earlier, ...loaded]);
  assert.equal(prepended, whole.text());
});

void test("an older call and its result prepended before a loaded call of the same id and its result pair by occurrence", () => {
  const older = [call(100, "c1", "alpha", { query: "OLDER-ARGS" }), result(200, "c1", "alpha", "OLDER-OUTPUT")];
  const newer = [call(300, "c1", "beta", { query: "NEWER-ARGS" }), result(400, "c1", "beta", "NEWER-OUTPUT")];
  const { view, text } = setup();
  view.append(newer);
  view.prepend(older);
  const prepended = text();
  assertOrder(prepended, ["alpha", "OLDER-ARGS", "OLDER-OUTPUT", "beta", "NEWER-ARGS", "NEWER-OUTPUT"]);
  assert.equal(count(prepended, "alpha"), 1);
  assert.equal(count(prepended, "beta"), 1);
  assert.ok(!prepended.includes("{}"));
  const whole = setup();
  whole.view.append([...older, ...newer]);
  assert.equal(prepended, whole.text());
});

void test("a large record replaced by the result of the first of two calls of one id completes that call", () => {
  const first = call(100, "c1", "alpha", { query: "FIRST-ARGS" });
  const firstResult = { ...result(200, "c1", "alpha", "FIRST-OUTPUT"), bytes: 2 * MB };
  const second = [call(300, "c1", "beta", { query: "SECOND-ARGS" }), result(400, "c1", "beta", "SECOND-OUTPUT")];
  const { view, text } = setup();
  view.append([first, { kind: "large", offset: 200, bytes: 2 * MB }, ...second]);
  view.replace(firstResult);
  const replaced = text();
  assertOrder(replaced, ["alpha", "FIRST-ARGS", "FIRST-OUTPUT", "beta", "SECOND-ARGS", "SECOND-OUTPUT"]);
  assert.equal(count(replaced, "alpha"), 1);
  assert.ok(!replaced.includes("{}"));
  const whole = setup();
  whole.view.append([first, firstResult, ...second]);
  assert.equal(replaced, whole.text());
});

void test("a call prepended before two loaded results of its id takes the first and leaves the second without a call", () => {
  const results = [result(400, "c1", "alpha", "FIRST-OUTPUT"), result(500, "c1", "alpha", "SECOND-OUTPUT")];
  const earlier = call(300, "c1", "alpha", { query: "CALL-ARGS" });
  const { view, text } = setup();
  view.append(results);
  view.prepend([earlier]);
  const prepended = text();
  assertOrder(prepended, ["alpha", "CALL-ARGS", "FIRST-OUTPUT", "alpha", "{}", "SECOND-OUTPUT"]);
  assert.equal(count(prepended, "alpha"), 2);
  assert.equal(count(prepended, "FIRST-OUTPUT"), 1);
  const whole = setup();
  whole.view.append([earlier, ...results]);
  assert.equal(prepended, whole.text());
});

void test("a large record replaced by a call between a call and its result moves that result", () => {
  const before = call(100, "c1", "alpha", { query: "BEFORE-ARGS" });
  const output = result(300, "c1", "alpha", "MOVED-OUTPUT");
  const between = { ...call(200, "c1", "beta", { query: "BETWEEN-ARGS" }), bytes: 2 * MB };
  const stopped = { ...message(200, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "gamma", arguments: { query: "STOPPED-ARGS" } }], stopReason: "aborted" }), bytes: 2 * MB };
  for (const [record, parts] of [[between, ["alpha", "BEFORE-ARGS", "beta", "BETWEEN-ARGS", "MOVED-OUTPUT"]], [stopped, ["alpha", "BEFORE-ARGS", "gamma", "STOPPED-ARGS", "Operation aborted", "alpha", "{}", "MOVED-OUTPUT"]]] as const) {
    const { view, text } = setup();
    view.append([before, { kind: "large", offset: 200, bytes: 2 * MB }, output]);
    assertOrder(text(), ["alpha", "BEFORE-ARGS", "MOVED-OUTPUT"]);
    view.replace(record);
    const replaced = text();
    assertOrder(replaced, parts);
    assert.equal(count(replaced, "MOVED-OUTPUT"), 1);
    const whole = setup();
    whole.view.append([before, record, output]);
    assert.equal(replaced, whole.text());
  }
});

void test("replace swaps a large record in place and pendingLarge lists the ones left", () => {
  const { view, text } = setup();
  view.append([user(100, "FIRST"), { kind: "large", offset: 200, bytes: 3 * MB }, call(300, "c1", "alpha", { query: "CALL-ARGS" }), { kind: "large", offset: 400, bytes: 2 * MB }, user(500, "LAST")]);
  assert.deepEqual(view.pendingLarge(), [{ offset: 200, bytes: 3 * MB }, { offset: 400, bytes: 2 * MB }]);
  assertOrder(text(), ["FIRST", "large record · 3.0 MB · enter to load", "alpha", "large record · 2.0 MB · enter to load", "LAST"]);
  view.replace({ kind: "entry", offset: 200, bytes: 3 * MB, value: { type: "message", message: { role: "user", content: "LOADED-USER" } } });
  assert.deepEqual(view.pendingLarge(), [{ offset: 400, bytes: 2 * MB }]);
  assertOrder(text(), ["FIRST", "LOADED-USER", "alpha", "large record · 2.0 MB · enter to load", "LAST"]);
  assert.ok(!text().includes("3.0 MB"));
  view.replace({ ...result(400, "c1", "alpha", "LOADED-RESULT"), bytes: 2 * MB });
  assert.deepEqual(view.pendingLarge(), []);
  const replaced = text();
  assertOrder(replaced, ["FIRST", "LOADED-USER", "alpha", "CALL-ARGS", "LOADED-RESULT", "LAST"]);
  assert.equal(count(replaced, "alpha"), 1);
  assert.ok(!replaced.includes("large record"));
});

void test("setExpanded reaches tool results and bash executions, also those appended later", () => {
  const { view, text } = setup();
  view.append([
    call(100, "c1", "bash", { command: "seq 30" }),
    result(200, "c1", "bash", lines("tool", 30)),
    message(300, { role: "bashExecution", command: "seq 40", output: lines("bang", 40), exitCode: 0, cancelled: false, truncated: false }),
  ]);
  const collapsed = text();
  assert.ok(collapsed.includes("tool-30") && collapsed.includes("bang-40"));
  assert.ok(!collapsed.includes("tool-01") && !collapsed.includes("bang-01"));
  view.setExpanded(true);
  assert.ok(text().includes("tool-01") && text().includes("bang-01"));
  view.append([call(400, "c2", "bash", { command: "seq 30" }), result(500, "c2", "bash", lines("next", 30))]);
  assert.ok(text().includes("next-01"));
  view.setExpanded(false);
  const recollapsed = text();
  assert.ok(recollapsed.startsWith(collapsed));
  assert.ok(!recollapsed.includes("next-01") && recollapsed.includes("next-30"));
});

void test("blocks made after their records were built open as the others when the view is expanded", () => {
  const cases: readonly { readonly name: string; readonly load: (view: TranscriptView) => void; readonly whole: readonly TranscriptRecord[]; readonly shown: readonly string[] }[] = [
    { name: "a result without its call", load: (view) => { view.append([result(100, "c9", "bash", lines("orphan", 30))]); }, whole: [result(100, "c9", "bash", lines("orphan", 30))], shown: ["orphan-01"] },
    {
      name: "a call prepended before two results of its id",
      load: (view) => { view.append([result(200, "c1", "bash", lines("first", 30)), result(300, "c1", "bash", lines("second", 30))]); view.prepend([call(100, "c1", "bash", { command: "seq 30" })]); },
      whole: [call(100, "c1", "bash", { command: "seq 30" }), result(200, "c1", "bash", lines("first", 30)), result(300, "c1", "bash", lines("second", 30))],
      shown: ["first-01", "second-01"],
    },
    {
      name: "a result moved out of its call by a replaced stopped call",
      load: (view) => {
        view.append([call(100, "c1", "bash", { command: "seq 30" }), { kind: "large", offset: 200, bytes: 2 * MB }, result(300, "c1", "bash", lines("moved", 30))]);
        view.replace({ ...message(200, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "false" } }], stopReason: "aborted" }), bytes: 2 * MB });
      },
      whole: [call(100, "c1", "bash", { command: "seq 30" }), message(200, { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "false" } }], stopReason: "aborted" }), result(300, "c1", "bash", lines("moved", 30))],
      shown: ["moved-01"],
    },
    {
      name: "a call whose result changes by replace",
      load: (view) => {
        view.append([call(100, "c1", "bash", { command: "seq 30" }), { kind: "large", offset: 200, bytes: 2 * MB }, result(300, "c1", "bash", lines("later", 30))]);
        view.replace({ ...result(200, "c1", "bash", lines("loaded", 30)), bytes: 2 * MB });
      },
      whole: [call(100, "c1", "bash", { command: "seq 30" }), result(200, "c1", "bash", lines("loaded", 30)), result(300, "c1", "bash", lines("later", 30))],
      shown: ["loaded-01", "later-01"],
    },
  ];
  for (const { name, load, whole, shown } of cases) {
    const { view, text } = setup();
    view.setExpanded(true);
    load(view);
    const rendered = text();
    for (const line of shown) assert.ok(rendered.includes(line), `${name}: ${line}`);
    const loaded = setup();
    loaded.view.setExpanded(true);
    loaded.view.append(whole);
    assert.equal(rendered, loaded.text(), name);
  }
});

void test("the live message streams after the last record and leaves at message_end", () => {
  const { view, raw, text } = setup();
  view.append([user(100, "QUESTION")]);
  view.live({ type: "message_start", message: { role: "user", content: "NOT-STREAMED" } });
  view.live({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "IGNORED" } });
  assert.ok(!text().includes("NOT-STREAMED") && !text().includes("IGNORED"));
  view.live({ type: "message_start", message: { role: "assistant", content: [] } });
  view.live({ type: "message_update", message: { role: "assistant", content: [{ type: "thinking", thinking: "LIVE-THINKING" }, { type: "text", text: "PARTIAL ANSWER" }] }, assistantMessageEvent: { type: "text_delta", delta: "ANSWER" } });
  assertOrder(text(), ["QUESTION", "LIVE-THINKING", "PARTIAL ANSWER"]);
  view.live({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: `PARTIAL ANSWER GROWS ${ESC}[2J` }] }, assistantMessageEvent: { type: "text_delta", delta: " GROWS" } });
  assert.equal(count(text(), "PARTIAL ANSWER"), 1);
  assert.ok(!raw().join("\n").includes(`${ESC}[2J`));
  assert.ok(!text().includes("LIVE-THINKING"));
  view.live({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "MORE" } });
  assert.ok(text().includes("PARTIAL ANSWER GROWS MORE"));
  view.append([user(200, "LATER")]);
  assertOrder(text(), ["QUESTION", "LATER", "PARTIAL ANSWER GROWS MORE"]);
  view.live({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "PARTIAL ANSWER GROWS MORE" }] } });
  assert.ok(!text().includes("PARTIAL ANSWER"));
  assertOrder(text(), ["QUESTION", "LATER"]);
});

void test("a live message without message snapshots appends the deltas", () => {
  const { view, text } = setup();
  view.live({ type: "message_start", message: { role: "assistant", content: [] } });
  for (const [type, delta] of [["thinking_delta", "THINK-"], ["thinking_delta", "ING"], ["text_delta", "DELTA-"], ["text_delta", "TEXT"], ["toolcall_delta", "{\"x\":"]] as const) view.live({ type: "message_update", assistantMessageEvent: { type, delta } });
  assertOrder(text(), ["THINK-ING", "DELTA-TEXT"]);
  assert.ok(!text().includes("\"x\""));
  view.reset();
  assert.equal(text(), "");
  view.live({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "AFTER-RESET" } });
  assert.equal(text(), "");
});

void test("a bash call uses Pi's built-in renderer and an unknown tool the generic block", () => {
  const { view, text } = setup();
  view.append([call(100, "c1", "bash", { command: "ls -la BUILTIN" }), call(200, "c2", "custom_tool", { query: "GENERIC-ARG", limit: 3 })]);
  const rendered = text();
  assertOrder(rendered, ["$ ls -la BUILTIN", "custom_tool", "\"query\": \"GENERIC-ARG\"", "\"limit\": 3"]);
  assert.ok(!rendered.includes("\"command\""));
});

void test("a failed edit shows only what its records carry, not a diff of the file on disk", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "transcript-components-edit-"));
  try {
    const target = join(cwd, "target.txt");
    await writeFile(target, "CONTEXT-BEFORE\nOLD-LINE\nCONTEXT-AFTER\n");
    const records = [
      call(100, "c1", "edit", { path: "target.txt", edits: [{ oldText: "OLD-LINE", newText: "NEW-LINE" }] }),
      message(200, { role: "toolResult", toolCallId: "c1", toolName: "edit", content: [{ type: "text", text: "EDIT-FAILED" }], isError: true }),
    ];
    const whole = setup(cwd);
    whole.view.append(records);
    await writeFile(target, "CHANGED-BEFORE\nOLD-LINE\nCHANGED-AFTER\n");
    const split = setup(cwd);
    split.view.append(records.slice(0, 1));
    split.view.append(records.slice(1));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const rendered = whole.text();
    assertOrder(rendered, ["edit", "target.txt", "EDIT-FAILED"]);
    for (const part of ["CONTEXT-BEFORE", "CHANGED-BEFORE", "OLD-LINE", "NEW-LINE"]) assert.ok(!rendered.includes(part), part);
    assert.equal(split.text(), rendered);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

void test("a bash call with its result, or stopped, shows no duration the records do not carry", () => {
  const { view, text } = setup();
  view.append([
    call(100, "c1", "bash", { command: "echo DONE" }),
    result(200, "c1", "bash", "DONE-OUTPUT"),
    message(300, { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "echo STOPPED" } }], stopReason: "aborted" }),
  ]);
  const rendered = text();
  assertOrder(rendered, ["$ echo DONE", "DONE-OUTPUT", "$ echo STOPPED", "Operation aborted"]);
  assert.ok(!rendered.includes("Took") && !rendered.includes("Elapsed"));
});

void test("reset drops every record and the live message", () => {
  const { view, text } = setup();
  view.append([user(100, "GONE"), { kind: "large", offset: 200, bytes: 2 * MB }]);
  view.live({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "LIVE-GONE" }] } });
  view.reset();
  assert.equal(text(), "");
  assert.deepEqual(view.pendingLarge(), []);
  view.append([result(300, "c1", "alpha", "FRESH")]);
  assertOrder(text(), ["alpha", "FRESH"]);
  view.dispose();
});
