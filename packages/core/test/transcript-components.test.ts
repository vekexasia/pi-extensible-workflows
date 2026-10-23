import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { initTheme, SettingsManager } from "@earendil-works/pi-coding-agent";
import { type Container, getCapabilities, setCapabilities, stripTerminalSequences, type Terminal, TuiAltScreen, visibleWidth } from "@earendil-works/pi-tui";
import type * as PiTui from "@earendil-works/pi-tui";
import type { WorkflowProgressStyles } from "../src/host-view.js";
import { createTranscriptView, type TranscriptView } from "../src/transcript-components.js";
import type { TranscriptRecord } from "../src/session-transcript.js";

initTheme("dark", false);

// Pi's components read the terminal capabilities of the pi-tui copy pi-coding-agent resolves, which npm may install apart from
// this package's copy; a test that turns images on sets both, or it passes only on a terminal that draws images itself.
const piTui = await import(pathToFileURL(createRequire(import.meta.resolve("@earendil-works/pi-coding-agent")).resolve("@earendil-works/pi-tui")).href) as typeof PiTui;
function withImages(run: () => void): void {
  const [ours, pis] = [getCapabilities(), piTui.getCapabilities()];
  setCapabilities({ ...ours, images: "kitty" });
  piTui.setCapabilities({ ...pis, images: "kitty" });
  try { run(); } finally { setCapabilities(ours); piTui.setCapabilities(pis); }
}

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
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
/** A colour of its own for each style the theme gives, none of them the terminal's yellow or dim. */
const THEME_COLOURS: Readonly<Record<keyof WorkflowProgressStyles, string>> = { accent: `${ESC}[38;5;201m`, success: `${ESC}[38;5;202m`, error: `${ESC}[38;5;203m`, warning: `${ESC}[38;5;204m`, muted: `${ESC}[38;5;205m`, dim: `${ESC}[38;5;206m`, bold: `${ESC}[38;5;207m` };
const paintWith = (key: keyof WorkflowProgressStyles) => (text: string): string => `${THEME_COLOURS[key]}${text}${ESC}[39m`;
const STYLES: WorkflowProgressStyles = { accent: paintWith("accent"), success: paintWith("success"), error: paintWith("error"), warning: paintWith("warning"), muted: paintWith("muted"), dim: paintWith("dim"), bold: paintWith("bold") };

function setup(cwd = tmpdir(), settings = SettingsManager.inMemory()): { readonly view: TranscriptView; readonly ui: TuiAltScreen; readonly terminal: FakeTerminal; readonly raw: (width?: number) => string[]; readonly text: (width?: number) => string } {
  const terminal = new FakeTerminal();
  const ui = new TuiAltScreen(terminal);
  const view = createTranscriptView({ ui, cwd, styles: STYLES, settings });
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
function entry(value: Readonly<Record<string, unknown>>): TranscriptRecord { return { kind: "entry", bytes: 100, value }; }
function message(value: Readonly<Record<string, unknown>>): TranscriptRecord { return entry({ type: "message", message: value }); }
function user(text: string): TranscriptRecord { return message({ role: "user", content: text }); }
function call(id: string, name: string, args: Readonly<Record<string, unknown>>): TranscriptRecord {
  return message({ role: "assistant", content: [{ type: "toolCall", id, name, arguments: args }], stopReason: "toolUse" });
}
function result(id: string, name: string, output: string): TranscriptRecord {
  return message({ role: "toolResult", toolCallId: id, toolName: name, content: [{ type: "text", text: output }], isError: false });
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
    entry({ type: "session", id: "session-1", cwd: "/project" }),
    user("USER-TEXT"),
    message({ role: "assistant", content: [{ type: "thinking", thinking: "THINKING-TEXT" }, { type: "text", text: "ASSISTANT-TEXT" }], stopReason: "stop" }),
    call("c1", "bash", { command: "echo BASH-CALL" }),
    result("c1", "bash", "BASH-RESULT"),
    message({ role: "bashExecution", command: "echo USER-BASH", output: "USER-BASH-OUTPUT", exitCode: 2, cancelled: false, truncated: false }),
    message({ role: "custom", customType: "note", content: "CUSTOM-MESSAGE", display: true }),
    entry({ type: "custom_message", customType: "entry-note", content: [{ type: "text", text: "CUSTOM-ENTRY" }], display: true }),
    entry({ type: "custom_message", customType: "hidden-note", content: "CUSTOM-HIDDEN", display: false }),
    entry({ type: "compaction", summary: "COMPACTION-SUMMARY", tokensBefore: 999, firstKeptEntryId: "a", systemMessage: { role: "system", content: "COMPACTED-SYSTEM" } }),
    message({ role: "compactionSummary", summary: "COMPACTION-MESSAGE", tokensBefore: 99 }),
    entry({ type: "branch_summary", summary: "BRANCH-SUMMARY", fromId: "b" }),
    message({ role: "branchSummary", summary: "BRANCH-MESSAGE", fromId: "c" }),
    message({ role: "system", content: "SYSTEM-PROMPT" }),
    entry({ type: "model_change", provider: "openai", modelId: "gpt-x" }),
    entry({ type: "thinking_level_change", thinkingLevel: "high" }),
    entry({ type: "label", label: "LABEL-X", targetId: "t1" }),
    entry({ type: "session_info", name: "SESSION-NAME" }),
    entry({ type: "context_edit", targetId: "t2", replacement: null }),
    { kind: "unreadable", bytes: 512 },
  ]);
  text(40);
  assertOrder(text(), [
    "USER-TEXT", "THINKING-TEXT", "ASSISTANT-TEXT", "$ echo BASH-CALL", "BASH-RESULT", "$ echo USER-BASH", "USER-BASH-OUTPUT", "(exit 2)",
    "[note]", "CUSTOM-MESSAGE", "[entry-note]", "CUSTOM-ENTRY", "custom hidden-note (hidden in Pi)", "CUSTOM-HIDDEN",
    "system prompt", "COMPACTED-SYSTEM", "[compaction]", "Compacted from 999 tokens", "[compaction]", "Compacted from 99 tokens", "[branch]", "Branch summary", "[branch]", "Branch summary",
    "system prompt", "SYSTEM-PROMPT", "model: openai/gpt-x", "thinking level: high", "label LABEL-X on t1", "session name: SESSION-NAME",
    "context edit: t2 left out of the model context", "unreadable record · 512B",
  ]);
  view.setExpanded(true);
  assertOrder(text(), ["COMPACTION-SUMMARY", "COMPACTION-MESSAGE", "BRANCH-SUMMARY", "BRANCH-MESSAGE"]);
  text(40);
});

void test("a branch summary without text draws nothing, as in Pi's chat; one with text draws Pi's block", () => {
  const { view, text } = setup();
  view.append([entry({ type: "branch_summary", summary: "", fromId: "a" })]);
  assert.equal(text().trim(), "");
  view.append([entry({ type: "branch_summary", summary: "BRANCH-SUMMARY", fromId: "b" })]);
  assert.equal(count(text(), "[branch]"), 1);
  assert.ok(!text().includes("branch_summary"));
});

void test("records and the live message follow Pi's display settings: thinking, output padding, code block indent and images", () => {
  withImages(() => {
    const settings = SettingsManager.inMemory({ hideThinkingBlock: true, outputPad: 0, markdown: { codeBlockIndent: "»» " }, terminal: { showImages: false } });
    const { view, text } = setup(tmpdir(), settings);
    view.append([
      message({ role: "assistant", content: [{ type: "thinking", thinking: "THINKING-TEXT" }, { type: "text", text: "```\nCODE-LINE\n```" }], stopReason: "stop" }),
      call("c1", "alpha", {}),
      message({ role: "toolResult", toolCallId: "c1", toolName: "alpha", content: [{ type: "image", data: PNG, mimeType: "image/png" }], isError: false }),
    ]);
    view.live({ type: "message_start", message: { role: "assistant", content: [{ type: "thinking", thinking: "LIVE-THINKING" }] } });
    const screen = text();
    assert.ok(!screen.includes("THINKING-TEXT") && !screen.includes("LIVE-THINKING"), screen);
    assert.equal(count(screen, "Thinking..."), 2);
    assert.match(screen, /^»» CODE-LINE/m);
    assert.match(screen, /\[Image: /, "the image as text, not drawn");
  });
});

void test("a tool block draws its image as wide as Pi's image width setting", () => {
  withImages(() => {
    const { view, raw } = setup(tmpdir(), SettingsManager.inMemory({ terminal: { showImages: true, imageWidthCells: 7 } }));
    view.append([
      call("c1", "alpha", {}),
      message({ role: "toolResult", toolCallId: "c1", toolName: "alpha", content: [{ type: "image", data: PNG, mimeType: "image/png" }], isError: false }),
    ]);
    const screen = raw().join("\n");
    // A 1x1 image scales up to the widest it may be, so its Kitty sequence names exactly the setting's columns.
    assert.match(screen, new RegExp(`${ESC}_Ga=T[^;]*,c=7,`), JSON.stringify(stripTerminalSequences(screen)));
    assert.ok(!stripTerminalSequences(screen).includes("[Image: "), "drawn, not as text");
  });
});

void test("a skill invocation is drawn as Pi draws it: the skill folded, then the user's own text", () => {
  const { view, text } = setup();
  view.append([user('<skill name="review" location="/skills/review/SKILL.md">\nSKILL-BODY\n</skill>\n\nUSER-ASK')]);
  assertOrder(text(), ["[skill] review", "USER-ASK"]);
  assert.ok(!text().includes("SKILL-BODY") && !text().includes("<skill"));
  view.setExpanded(true);
  assertOrder(text(), ["[skill]", "review", "SKILL-BODY", "USER-ASK"]);
  text(20);
});

void test("terminal sequences in the session file reach the screen as text only", () => {
  const { view, raw, text } = setup();
  view.append([
    user(`${ESC}]0;user title${BEL}USER ${ESC}[31mRED${ESC}[0m`),
    message({ role: "assistant", content: [{ type: "text", text: `ASSISTANT ${ESC}]52;c;Y2xpcA==${BEL}CLIP` }], stopReason: "stop" }),
    message({ role: "system", content: `SYSTEM ${ESC}[2J CLEAR` }),
  ]);
  const screen = raw().join("\n");
  for (const sequence of [`${ESC}]0;`, `${ESC}[31m`, `${ESC}]52;`, `${ESC}[2J`]) assert.ok(!screen.includes(sequence), JSON.stringify(sequence));
  assertOrder(text(), ["USER RED", "ASSISTANT CLIP", "SYSTEM", "CLEAR"]);
});

void test("terminal sequences in tool arguments and details reach the screen and the terminal as text only", () => {
  const { view, ui, terminal, raw, text } = setup();
  ui.addChild(view.component);
  view.append([
    call("c1", "bash", { command: `echo BASH-ARG ${HOSTILE}` }),
    message({ role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "BASH-OUTPUT" }], details: { truncation: { truncated: true }, fullOutputPath: `/tmp/FULL-PATH${HOSTILE}` }, isError: false }),
    call("c2", "read", { path: `READ-PATH${HOSTILE}` }),
    call("c3", "edit", { path: `EDIT-PATH${HOSTILE}`, edits: [{ oldText: `OLD${HOSTILE}`, newText: `NEW${HOSTILE}` }] }),
    message({ role: "toolResult", toolCallId: "c3", toolName: "edit", content: [{ type: "text", text: "EDITED" }], details: { diff: `+1 DIFF-LINE${HOSTILE}` }, isError: false }),
    call("c4", "write", { path: `WRITE-PATH${HOSTILE}`, content: `WRITE-CONTENT${HOSTILE}` }),
    call("c5", "grep", { pattern: `GREP-PATTERN${HOSTILE}`, path: "." }),
    call("c6", "custom_tool", { query: `GENERIC-ARG${HOSTILE}`, [`GENERIC-KEY${HOSTILE}`]: `GENERIC-VALUE${C1_CSI}6n` }),
    message({ role: "bashExecution", command: `echo BANG-ARG ${HOSTILE}`, output: "BANG-OUTPUT", exitCode: 0, cancelled: false, truncated: true, fullOutputPath: `/tmp/BANG-PATH${HOSTILE}` }),
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

void test("tool calls of a message that stopped on an error or an abort show that stop and take no later result, which is dropped", () => {
  const stopped = [
    message({ role: "assistant", content: [{ type: "toolCall", id: "c1", name: "alpha", arguments: { query: "FAILED-ARGS" } }], stopReason: "error", errorMessage: `UPSTREAM-FAILED ${ESC}]0;x${BEL}` }),
    message({ role: "assistant", content: [{ type: "toolCall", id: "c2", name: "beta", arguments: { query: "ABORTED-ARGS" } }], stopReason: "aborted", errorMessage: "Request was aborted" }),
    message({ role: "assistant", content: [{ type: "toolCall", id: "c3", name: "gamma", arguments: { query: "BARE-ARGS" } }], stopReason: "error" }),
  ];
  const late = result("c1", "alpha", "LATE-OUTPUT");
  const { view, raw, text } = setup();
  view.append([...stopped, late]);
  const rendered = text();
  assertOrder(rendered, ["alpha", "FAILED-ARGS", "UPSTREAM-FAILED", "beta", "ABORTED-ARGS", "Operation aborted", "gamma", "BARE-ARGS", "Error"]);
  assert.equal(count(rendered, "UPSTREAM-FAILED"), 1);
  assert.equal(count(rendered, "alpha"), 1);
  assert.ok(!rendered.includes("LATE-OUTPUT"));
  assert.ok(!rendered.includes("Request was aborted"));
  assertInert(raw().join("\n"));
});

void test("the empty message an accepted workflow_result leaves when it ends the session is not drawn; any other stop is", () => {
  const closing = (): TranscriptRecord => message({ role: "assistant", content: [], stopReason: "error", errorMessage: "This operation was aborted" });
  const { view, text } = setup();
  view.append([
    call("w1", "workflow_result", { result: "DONE-VALUE" }),
    entry({ type: "custom", customType: "pi-workflows:tool-timing", data: {} }),
    result("w1", "workflow_result", "Result accepted."),
    closing(),
    user("NEXT-MESSAGE"),
    closing(),
    call("w2", "workflow_result", { result: "BAD" }),
    message({ role: "toolResult", toolCallId: "w2", toolName: "workflow_result", content: [{ type: "text", text: "Result does not match the required schema." }], isError: true }),
    closing(),
  ]);
  const rendered = text();
  assertOrder(rendered, ["DONE-VALUE", "Result accepted.", "NEXT-MESSAGE", "This operation was aborted", "Result does not match", "This operation was aborted"]);
  assert.equal(count(rendered, "This operation was aborted"), 2);
});

void test("a tool call and its result form one block, also when the result comes in a later append", () => {
  const records = [user("BEFORE"), call("c1", "alpha", { query: "CALL-ARGS" }), result("c1", "alpha", "PAIRED-OUTPUT"), user("AFTER")];
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

void test("setExpanded reaches tool results and bash executions, also those appended later", () => {
  const { view, text } = setup();
  view.append([
    call("c1", "bash", { command: "seq 30" }),
    result("c1", "bash", lines("tool", 30)),
    message({ role: "bashExecution", command: "seq 40", output: lines("bang", 40), exitCode: 0, cancelled: false, truncated: false }),
  ]);
  const collapsed = text();
  assert.ok(collapsed.includes("tool-30") && collapsed.includes("bang-40"));
  assert.ok(!collapsed.includes("tool-01") && !collapsed.includes("bang-01"));
  view.setExpanded(true);
  assert.ok(text().includes("tool-01") && text().includes("bang-01"));
  view.append([call("c2", "bash", { command: "seq 30" }), result("c2", "bash", lines("next", 30))]);
  assert.ok(text().includes("next-01"));
  view.setExpanded(false);
  const recollapsed = text();
  assert.ok(recollapsed.startsWith(collapsed));
  assert.ok(!recollapsed.includes("next-01") && recollapsed.includes("next-30"));
});

void test("a result that comes in a later append opens as the others when the view is expanded", () => {
  const cases: readonly { readonly name: string; readonly load: (view: TranscriptView) => void; readonly whole: readonly TranscriptRecord[]; readonly shown: readonly string[] }[] = [
    { name: "a result after its call", load: (view) => { view.append([call("c9", "bash", {})]); view.append([result("c9", "bash", lines("late", 30))]); }, whole: [call("c9", "bash", {}), result("c9", "bash", lines("late", 30))], shown: ["late-01"] },
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

void test("the live message streams after the last record and, after message_end, stays until its record is appended", () => {
  const { view, raw, text } = setup();
  view.append([user("QUESTION")]);
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
  view.live({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "PARTIAL ANSWER GROWS MORE" }] } });
  assert.ok(text().includes("PARTIAL ANSWER GROWS MORE"));
  view.append([user("LATER")]);
  assertOrder(text(), ["QUESTION", "LATER", "PARTIAL ANSWER GROWS MORE"]);
  view.live({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "PARTIAL ANSWER GROWS MORE" }] } });
  assertOrder(text(), ["QUESTION", "LATER", "PARTIAL ANSWER GROWS MORE"]);
  view.append([message({ role: "assistant", content: [{ type: "text", text: "THE RECORDED ANSWER" }] })]);
  assert.ok(!text().includes("PARTIAL ANSWER"), "the record takes the finished message's place");
  assertOrder(text(), ["QUESTION", "LATER", "THE RECORDED ANSWER"]);
  assert.equal(count(text(), "THE RECORDED ANSWER"), 1);
});

void test("a finished message keeps its height until its own record arrives, past tool results and the next message", () => {
  const { view, text, raw } = setup();
  view.append([user("QUESTION"), call("c1", "bash", {})]);
  const stream = (body: string): void => {
    view.live({ type: "message_start", message: { role: "assistant", content: [] } });
    view.live({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: body }] } });
  };
  stream("FIRST-LIVE");
  const height = raw().length;
  view.live({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "FIRST-LIVE" }] } });
  assert.equal(raw().length, height, "message_end does not shrink the content");
  view.live({ type: "message_start", message: { role: "toolResult", content: [] } });
  view.live({ type: "message_end", message: { role: "toolResult", content: [] } });
  view.append([result("c1", "bash", "TOOL-OUTPUT")]);
  assert.ok(text().includes("FIRST-LIVE"), "a tool result is not the message's record");
  stream("SECOND-LIVE");
  assertOrder(text(), ["QUESTION", "TOOL-OUTPUT", "FIRST-LIVE", "SECOND-LIVE"]);
  view.append([message({ role: "assistant", content: [{ type: "text", text: "FIRST-RECORD" }] })]);
  assert.ok(!text().includes("FIRST-LIVE"));
  assertOrder(text(), ["FIRST-RECORD", "SECOND-LIVE"]);
  view.live({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "SECOND-LIVE" }] } });
  view.reset();
  assert.equal(text(), "", "reset drops a finished message too");
});

void test("a message_update without a message leaves the live message as it was, with no frame", () => {
  const { view, ui, text } = setup();
  view.live({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "STARTED" }] } });
  const before = text();
  let frames = 0;
  ui.requestRender = () => { frames += 1; };
  for (const [type, delta] of [["thinking_delta", "THINK"], ["text_delta", "DELTA"]] as const) view.live({ type: "message_update", assistantMessageEvent: { type, delta } });
  assert.equal(text(), before);
  assert.ok(before.includes("STARTED"));
  assert.equal(frames, 0);
});

void test("a bash call uses Pi's built-in renderer and an unknown tool the generic block", () => {
  const { view, text } = setup();
  view.append([call("c1", "bash", { command: "ls -la BUILTIN" }), call("c2", "custom_tool", { query: "GENERIC-ARG", limit: 3 })]);
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
      call("c1", "edit", { path: "target.txt", edits: [{ oldText: "OLD-LINE", newText: "NEW-LINE" }] }),
      message({ role: "toolResult", toolCallId: "c1", toolName: "edit", content: [{ type: "text", text: "EDIT-FAILED" }], isError: true }),
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
    call("c1", "bash", { command: "echo DONE" }),
    result("c1", "bash", "DONE-OUTPUT"),
    message({ role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "echo STOPPED" } }], stopReason: "aborted" }),
  ]);
  const rendered = text();
  assertOrder(rendered, ["$ echo DONE", "DONE-OUTPUT", "$ echo STOPPED", "Operation aborted"]);
  assert.ok(!rendered.includes("Took") && !rendered.includes("Elapsed"));
});

void test("reset drops every record and the live message", () => {
  const { view, text } = setup();
  view.append([user("GONE"), call("c1", "alpha", {})]);
  view.live({ type: "message_start", message: { role: "assistant", content: [{ type: "text", text: "LIVE-GONE" }] } });
  view.reset();
  assert.equal(text(), "");
  view.append([result("c1", "alpha", "NO-CALL")]);
  assert.equal(text(), "", "the call waiting for its result is gone too");
  view.append([call("c1", "alpha", {}), result("c1", "alpha", "FRESH")]);
  assertOrder(text(), ["alpha", "FRESH"]);
  view.dispose();
});

void test("user text joins its text parts with nothing and leaves images out, as Pi's chat does", () => {
  const { view, text } = setup();
  view.append([message({ role: "user", content: [{ type: "text", text: "FIRST-" }, { type: "image", data: "AAAA", mimeType: "image/png" }, { type: "text", text: "SECOND" }] })]);
  assert.ok(text().includes("FIRST-SECOND"), text());
  assert.ok(!text().includes("[image]"));
});

void test("fallback lines take the theme's colours", () => {
  const { view, raw } = setup();
  view.append([{ kind: "unreadable", bytes: 5 }, entry({ type: "model_change", provider: "p", modelId: "m" }), message({ role: "system", content: "SYSTEM" })]);
  const lines = raw();
  const line = (needle: string): string => lines.find((candidate) => stripTerminalSequences(candidate).includes(needle)) ?? "";
  assert.ok(line("unreadable").includes(THEME_COLOURS.warning) && !line("unreadable").includes(`${ESC}[33m`), JSON.stringify(line("unreadable")));
  assert.ok(line("model: p/m").includes(THEME_COLOURS.dim) && !line("model: p/m").includes(`${ESC}[2m`), JSON.stringify(line("model: p/m")));
});

void test("with thousands of records a live message_update redraws the message without rebuilding the transcript's children, one frame each", () => {
  const { view, ui, text } = setup();
  view.append(Array.from({ length: 3000 }, (_, index) => user(`RECORD-${String(index)}`)));
  const root = view.component as Container;
  let frames = 0;
  ui.requestRender = () => { frames += 1; };
  view.live({ type: "message_start", message: { role: "assistant", content: [] } });
  const children = root.children;
  assert.equal(children.length, 3001, "every record and the live message");
  for (let token = 1; token <= 50; token += 1) view.live({ type: "message_update", message: { role: "assistant", content: [{ type: "text", text: "TOKEN ".repeat(token) }] } });
  assert.equal(root.children, children, "the children were not rebuilt");
  assert.equal(frames, 51, "one frame for the start and one for each update");
  assert.ok(text().includes("TOKEN TOKEN"), "the live message shows its tokens");
});

void test("a streaming tool call has a tool block before the message ends, and its arguments grow in place", () => {
  const { view, text } = setup();
  const streamed = (args: Readonly<Record<string, unknown>>) => ({ type: "message_update" as const, message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: args }] } });
  view.live({ type: "message_start", message: { role: "assistant", content: [] } });
  view.live(streamed({ command: "ls STREAMED" }));
  assert.ok(text().includes("$ ls STREAMED"), text());
  view.live(streamed({ command: "ls STREAMED-MORE" }));
  assert.equal(count(text(), "$ ls"), 1);
  assert.ok(text().includes("ls STREAMED-MORE"));
  view.live({ type: "message_end", message: { role: "assistant", content: [] } });
  assert.ok(text().includes("ls STREAMED-MORE"), "the finished message keeps its tool block until its record arrives");
  view.append([call("c1", "bash", { command: "ls RECORDED" })]);
  assert.ok(!text().includes("STREAMED"));
  assert.equal(count(text(), "$ ls"), 1);
});

void test("a tool without a built-in definition (workflow_result) renders Pi's generic block once, with its arguments and result", () => {
  const { view, text } = setup();
  view.append([call("w1", "workflow_result", { result: "DONE-VALUE" }), result("w1", "workflow_result", "accepted-text")]);
  const rendered = text();
  assertOrder(rendered, ["workflow_result", "DONE-VALUE", "accepted-text"]);
  assert.ok(!rendered.includes("Workflow Result Workflow Result"));
});

void test("the records Pi has no component for show as the transcript describes them, expanded; the hidden ones show nothing", () => {
  const parameters = { type: "object", properties: { path: { type: "string" } } };
  // The rows each record draws, trimmed, and the theme style of its first row.
  const cases: readonly (readonly [TranscriptRecord, readonly string[], (keyof WorkflowProgressStyles)?])[] = [
    [entry({ type: "session", id: "session-1", cwd: "/private/cwd" }), []],
    [entry({ type: "custom", customType: "pi-workflows:tool-timing", data: { toolName: "hidden-timing" } }), []],
    [entry({ type: "usage", kind: "cache_warm", provider: "p", model: "m", usage: {} }), []],
    [message({ role: "system", content: "You are a secret system prompt" }), ["system prompt", "You are a secret system prompt"], "dim"],
    [message({ role: "system", content: "", sections: { preamble: "rule 0\nrule 1", skills: null }, toolsAdded: [{ name: "read", description: "Read a file", parameters }], toolsRemoved: [{ name: "write" }, { name: "edit" }] }),
      ["system prompt", "[preamble]", "rule 0", "rule 1", "[skills] removed", "[tool read]", "Read a file", ...JSON.stringify(parameters, null, 2).split("\n").map((line) => line.trim()), "tools removed: write, edit"], "dim"],
    [message({ role: "custom", customType: "steer", content: [{ type: "text", text: "steered text" }], display: false }), ["custom steer (hidden in Pi)", "steered text"], "dim"],
    [message({ role: "reviewer", content: "?" }), ["reviewer message"], "dim"],
    [entry({ type: "message", message: null }), ["message"], "dim"],
    [entry({ type: "custom_message", customType: "ctx", content: "injected context", display: false }), ["custom ctx (hidden in Pi)", "injected context"], "dim"],
    [entry({ type: "custom", customType: "other-ext", data: {} }), ["custom other-ext"], "dim"],
    [entry({ type: "model_change", provider: "p", modelId: "m" }), ["model: p/m"], "dim"],
    [entry({ type: "thinking_level_change", thinkingLevel: "high" }), ["thinking level: high"], "dim"],
    [entry({ type: "context_edit", targetId: "t1", replacement: null }), ["context edit: t1 left out of the model context"], "dim"],
    [entry({ type: "context_edit", targetId: "t2", replacement: [{ type: "text", text: "replacement text" }] }), ["context edit: t2 replaced in the model context", "replacement text"], "dim"],
    [entry({ type: "label", targetId: "t3", label: "checkpoint-1" }), ["label checkpoint-1 on t3"], "dim"],
    [entry({ type: "label", targetId: "t4" }), ["label cleared on t4"], "dim"],
    [entry({ type: "session_info", name: "Refactor auth" }), ["session name: Refactor auth"], "dim"],
    [entry({ type: "future_entry" }), ["future_entry"], "dim"],
    [{ kind: "unreadable", bytes: 512 }, ["unreadable record · 512B"], "warning"],
  ];
  for (const [record, rows, style] of cases) {
    const { view, raw, text } = setup();
    view.append([record]);
    view.setExpanded(true);
    const label = JSON.stringify(record);
    assert.deepEqual(text().split("\n").map((line) => line.trim()).filter(Boolean), rows, label);
    if (style !== undefined) assert.ok(raw().find((line) => stripTerminalSequences(line).trim())?.includes(THEME_COLOURS[style]), `${label} in ${style}`);
  }
  // Folded, a long body shows its first rows and a count of the rest.
  const folded = setup();
  folded.view.append([message({ role: "system", content: Array.from({ length: 15 }, (_, index) => `rule ${String(index)}`).join("\n") })]);
  const rows = folded.text().split("\n").map((line) => line.trim()).filter(Boolean);
  assert.deepEqual(rows.slice(0, 11), ["system prompt", ...Array.from({ length: 10 }, (_, index) => `rule ${String(index)}`)]);
  assert.match(rows.at(-1) ?? "", /^\.\.\. \+5 lines \(.* to expand\)$/);
  assert.equal(rows.length, 12);
});
