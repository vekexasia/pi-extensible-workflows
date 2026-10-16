import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, BashExecutionComponent, BranchSummaryMessageComponent, CompactionSummaryMessageComponent, createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, CustomMessageComponent, getMarkdownTheme, keyText, ToolExecutionComponent, truncateTail, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Component, Container, Spacer, styleTextWithAnsi, Text } from "@earendil-works/pi-tui";
import type { CreateTranscriptView } from "./agents-workspace-contract.js";
import { TRANSCRIPT_FOLDED_RESULT_LINES, type TranscriptRecord } from "./transcript-source.js";
import { recordBlocks } from "./transcript-view.js";
import type { WorkflowAgentSessionEvent } from "./types.js";
import { finiteNumber, jsonObject, object, sanitizeDisplayText } from "./utils.js";

/**
 * The /agents transcript pane: each record of a pi session file drawn with the component Pi's own chat uses for it.
 * Entries Pi does not draw keep the dashboards' text (transcript-view.ts).
 */

type Fields = Readonly<Record<string, unknown>>;
type ToolRendering = ConstructorParameters<typeof ToolExecutionComponent>[4];
type ToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];
type Block = ReturnType<typeof recordBlocks>[number];
type Expandable = Component & { setExpanded(expanded: boolean): void };
/** A toolCall part; its block shows the stop of its message, or the result paired with it. */
type Call = { readonly id: string; readonly name: string; readonly args: Fields; readonly stopped: ToolResult | undefined; tool: ToolExecutionComponent; result: Result | undefined };
/** A toolResult message: drawn inside the block of the call paired with it, or in its own block (`tool`) while no call is. */
type Result = { readonly id: string; readonly name: string; readonly value: ToolResult; tool: ToolExecutionComponent | undefined };
/** The components of one record; empty for a record Pi does not draw and for a result drawn inside its call's block. */
type Item = { readonly record: TranscriptRecord; readonly child: Container; readonly calls: readonly Call[]; readonly result: Result | undefined };

/** Pi's built-in renderers; every other tool gets ToolExecutionComponent's generic block. */
const BUILT_IN_TOOLS = new Map<string, (cwd: string) => ToolRendering>([["read", createReadToolDefinition], ["bash", createBashToolDefinition], ["edit", createEditToolDefinition], ["write", createWriteToolDefinition], ["grep", createGrepToolDefinition], ["find", createFindToolDefinition], ["ls", createLsToolDefinition]]);
/** AssistantMessageComponent draws only content, stopReason and errorMessage. */
const UNDRAWN = { api: "", provider: "", model: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0 } satisfies Omit<AssistantMessage, "role" | "content" | "stopReason">;

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function list(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
/** sanitizeDisplayText line by line, keeping the line breaks and tabs that Markdown and code need. */
function clean(value: string): string { return value.split(/\r\n|\r|\n/).map((line) => line.split("\t").map(sanitizeDisplayText).join("\t")).join("\n"); }
/** Message content as text: a string as it is, text parts one after another, images as "[image]". */
function contentText(content: unknown): string {
  if (typeof content === "string") return clean(content);
  return list(content).flatMap((part) => !object(part) ? [] : part.type === "text" ? [clean(text(part.text))] : part.type === "image" ? ["[image]"] : []).join("\n");
}
/** clean() on every string of a recorded value, keys included: Pi's tool renderers print arguments and details as they get them. */
function cleanValue(value: unknown): unknown {
  if (typeof value === "string") return clean(value);
  if (Array.isArray(value)) return value.map(cleanValue);
  return object(value) ? Object.fromEntries(Object.entries(value).map(([key, item]) => [clean(key), cleanValue(item)])) : value;
}
function cleanArguments(value: unknown): Fields { const cleaned = cleanValue(value); return object(cleaned) ? cleaned : {}; }
function resultContent(content: unknown): ToolResult["content"] {
  if (typeof content === "string") return [{ type: "text", text: clean(content) }];
  return list(content).flatMap((part): ToolResult["content"] => {
    if (!object(part)) return [];
    if (part.type === "text") return [{ type: "text", text: clean(text(part.text)) }];
    return part.type === "image" ? [{ type: "image", data: clean(text(part.data)), mimeType: clean(text(part.mimeType)) }] : [];
  });
}
/** What Pi's chat shows in each tool block of an assistant message that stopped on an error or an abort; undefined for any other stop. */
function stopResult(message: Fields): ToolResult | undefined {
  //NOTE: Pi says "Aborted after N retry attempts" while its own session retries; a file does not record that count.
  const reason = message.stopReason === "aborted" ? "Operation aborted" : message.stopReason === "error" ? text(message.errorMessage) || "Error" : undefined;
  return reason === undefined ? undefined : { content: [{ type: "text", text: clean(reason) }], isError: true };
}
function assistantMessage(message: Fields): AssistantMessage {
  const content = list(message.content).flatMap((part): AssistantMessage["content"] => {
    if (!object(part)) return [];
    if (part.type === "text") return [{ type: "text", text: clean(text(part.text)) }];
    if (part.type === "thinking") return [{ type: "thinking", thinking: clean(text(part.thinking)) }];
    return part.type === "toolCall" ? [{ type: "toolCall", id: text(part.id), name: text(part.name), arguments: jsonObject(part.arguments) ? part.arguments : {} }] : [];
  });
  const stopReason = message.stopReason;
  return { ...UNDRAWN, role: "assistant", content, stopReason: stopReason === "length" || stopReason === "aborted" || stopReason === "error" ? stopReason : "stop", ...(typeof message.errorMessage === "string" ? { errorMessage: clean(message.errorMessage) } : {}) };
}
/** A text or thinking delta extends the last part of its kind or starts one. */
function appendDelta(message: AssistantMessage, event: WorkflowAgentSessionEvent["assistantMessageEvent"]): void {
  const delta = clean(event?.delta ?? "");
  const last = message.content.at(-1);
  if (event?.type === "text_delta") {
    if (last?.type === "text") last.text += delta;
    else message.content.push({ type: "text", text: delta });
  } else if (event?.type === "thinking_delta") {
    if (last?.type === "thinking") last.thinking += delta;
    else message.content.push({ type: "thinking", thinking: delta });
  }
}
function expandable(component: Component): component is Expandable { return "setExpanded" in component && typeof component.setExpanded === "function"; }
/**
 * A recorded result completes its block with updateResult only, as Pi's restored history does: setArgsComplete would
 * have the edit renderer diff the file as it is on disk now, and markExecutionStarted would have the bash renderer
 * time the block with the clock, neither of which the records carry.
 */
function complete(tool: ToolExecutionComponent, result: ToolResult): void { tool.updateResult(result); }
/** Pi's theme is not reachable from here: bold stays bold and every other style of the dashboards is dim. */
function paint(line: string, style: Block["style"]): string { return style === undefined ? line : styleTextWithAnsi(line, undefined, undefined, style === "bold" ? { bold: true } : { dim: true }); }
function blocksText(blocks: readonly Block[], expanded: boolean): string {
  return blocks.flatMap((block) => {
    if (!block.text) return [];
    const lines = block.text.split(/\r\n|\r|\n/).map((line) => paint(sanitizeDisplayText(line), block.style));
    if (!block.folded || expanded || lines.length <= TRANSCRIPT_FOLDED_RESULT_LINES) return lines;
    return [...lines.slice(0, TRANSCRIPT_FOLDED_RESULT_LINES), paint(`... +${String(lines.length - TRANSCRIPT_FOLDED_RESULT_LINES)} lines (${keyText("app.tools.expand")} to expand)`, "dim")];
  }).join("\n");
}

/** A record Pi does not draw, as the dashboards' text; its folded blocks open with the tool output (app.tools.expand). */
class RecordText extends Container {
  private readonly body = new Text("", 1, 0);
  constructor(private readonly blocks: readonly Block[]) {
    super();
    this.addChild(new Spacer(1));
    this.addChild(this.body);
    this.setExpanded(false);
  }
  setExpanded(expanded: boolean): void { this.body.setText(blocksText(this.blocks, expanded)); }
}

export const createTranscriptView: CreateTranscriptView = ({ ui, cwd }) => {
  const root = new Container();
  const definitions = new Map([...BUILT_IN_TOOLS].map(([name, create]) => [name, create(cwd)] as const));
  let items: Item[] = [];
  let streaming: { readonly component: AssistantMessageComponent; message: AssistantMessage } | undefined;
  let expanded = false;

  function changed(): void {
    root.children = [...items.map((item) => item.child), ...(streaming ? [streaming.component] : [])];
    ui.requestRender();
  }
  function clear(): void {
    items = [];
    streaming = undefined;
  }
  /** Pi's renderers print the arguments and details they get without removing terminal sequences: they reach them cleaned. */
  function tool(name: string, id: string, args: Fields): ToolExecutionComponent { return new ToolExecutionComponent(sanitizeDisplayText(name), id, args, undefined, definitions.get(name), ui, cwd); }
  /** A tool block made after its record was built: completed with `result` when there is one, and opened as the others are. */
  function block(name: string, id: string, args: Fields, result: ToolResult | undefined): ToolExecutionComponent {
    const component = tool(name, id, args);
    if (result) complete(component, result);
    if (expanded) component.setExpanded(true);
    return component;
  }
  /**
   * Pairs calls and results by occurrence over every loaded record (`items` is in file order), so the blocks are the
   * same however the records arrived (appends, prepends, replace): a result goes to the nearest earlier call of its id
   * when that call has no result yet and no other call of that id comes between them. A call of a message that stopped
   * on an error or an abort shows that stop, as in Pi's chat, and takes no result. A result paired with no call has its
   * own block with empty args. A call whose result changes gets a new block; a result moves out of its own block or
   * back into one.
   */
  function pair(): void {
    const open = new Map<string, Call>();
    const paired = new Map<Call, Result>();
    for (const item of items) {
      for (const call of item.calls) if (call.stopped) open.delete(call.id); else open.set(call.id, call);
      const result = item.result;
      const owner = result ? open.get(result.id) : undefined;
      if (!result || !owner) continue;
      paired.set(owner, result);
      open.delete(owner.id);
    }
    const taken = new Set(paired.values());
    for (const item of items) {
      for (const call of item.calls) {
        const result = paired.get(call);
        if (result === call.result) continue;
        if (!call.result && result) complete(call.tool, result.value);
        else {
          const next = block(call.name, call.id, call.args, result?.value);
          item.child.children[item.child.children.indexOf(call.tool)] = next;
          call.tool = next;
        }
        call.result = result;
      }
      const result = item.result;
      if (result?.tool && taken.has(result)) {
        item.child.removeChild(result.tool);
        result.tool = undefined;
      } else if (result && !result.tool && !taken.has(result)) {
        result.tool = block(result.name, result.id, {}, result.value);
        item.child.addChild(result.tool);
      }
    }
  }
  function bashExecution(message: Fields): BashExecutionComponent {
    const component = new BashExecutionComponent(clean(text(message.command)), ui, message.excludeFromContext === true);
    const output = clean(text(message.output));
    if (output) component.appendOutput(output);
    const fullOutputPath = text(message.fullOutputPath);
    component.setComplete(finiteNumber(message.exitCode) ? message.exitCode : undefined, message.cancelled === true, message.truncated === true ? { ...truncateTail(output), truncated: true } : undefined, fullOutputPath ? clean(fullOutputPath) : undefined);
    return component;
  }
  function build(record: TranscriptRecord): Item {
    const child = new Container();
    const calls: Call[] = [];
    let result: Result | undefined;
    const value = record.kind === "entry" ? record.value : undefined;
    const message = value?.type === "message" && object(value.message) ? value.message : undefined;
    const custom = message?.role === "custom" ? message : value?.type === "custom_message" ? value : undefined;
    const compaction = message?.role === "compactionSummary" ? message : value?.type === "compaction" ? value : undefined;
    const branch = message?.role === "branchSummary" ? message : value?.type === "branch_summary" ? value : undefined;
    if (message?.role === "user") child.children.push(new Spacer(1), new UserMessageComponent(contentText(message.content), getMarkdownTheme()));
    else if (message?.role === "assistant") {
      child.addChild(new AssistantMessageComponent(assistantMessage(message), false, getMarkdownTheme()));
      const stopped = stopResult(message);
      for (const part of list(message.content)) {
        if (!object(part) || part.type !== "toolCall") continue;
        const [id, name, args] = [text(part.id), text(part.name), cleanArguments(part.arguments)];
        const call: Call = { id, name, args, stopped, tool: tool(name, id, args), result: undefined };
        if (stopped) complete(call.tool, stopped);
        child.addChild(call.tool);
        calls.push(call);
      }
    } else if (message?.role === "toolResult") result = { id: text(message.toolCallId), name: text(message.toolName), value: { content: resultContent(message.content), details: cleanValue(message.details), isError: message.isError === true }, tool: undefined };
    else if (message?.role === "bashExecution") child.addChild(bashExecution(message));
    else if (custom?.display === true) child.addChild(new CustomMessageComponent({ role: "custom", customType: clean(text(custom.customType)), content: contentText(custom.content), display: true, timestamp: 0 }, undefined, getMarkdownTheme()));
    else if (compaction) child.children.push(new Spacer(1), new CompactionSummaryMessageComponent({ role: "compactionSummary", summary: clean(text(compaction.summary)), tokensBefore: finiteNumber(compaction.tokensBefore) ? compaction.tokensBefore : 0, timestamp: 0 }, getMarkdownTheme()));
    else if (branch) child.children.push(new Spacer(1), new BranchSummaryMessageComponent({ role: "branchSummary", summary: clean(text(branch.summary)), fromId: null, timestamp: 0 }, getMarkdownTheme()));
    else {
      const blocks = recordBlocks(record);
      if (blocks.length > 0) child.addChild(new RecordText(blocks));
    }
    if (expanded) for (const component of child.children) if (expandable(component)) component.setExpanded(true);
    return { record, child, calls, result };
  }

  return {
    component: root,
    reset() {
      clear();
      changed();
    },
    append(records) {
      for (const record of records) items.push(build(record));
      pair();
      changed();
    },
    prepend(records) {
      items = [...records.map(build), ...items];
      pair();
      changed();
    },
    replace(record) {
      const index = items.findIndex((item) => item.record.offset === record.offset);
      if (items[index]?.record.kind !== "large") return;
      items[index] = build(record);
      pair();
      changed();
    },
    pendingLarge() { return items.flatMap(({ record }) => record.kind === "large" ? [{ offset: record.offset, bytes: record.bytes }] : []); },
    setExpanded(next) {
      if (next === expanded) return;
      expanded = next;
      for (const item of items) for (const component of item.child.children) if (expandable(component)) component.setExpanded(next);
      changed();
    },
    live(event) {
      if (event.type === "message_start") {
        if (event.message?.role !== "assistant") return;
        const message = assistantMessage({ ...event.message });
        const component = new AssistantMessageComponent(undefined, false, getMarkdownTheme());
        component.updateContent(message, true);
        streaming = { component, message };
      } else if (event.type === "message_update" && streaming) {
        if (event.message) streaming.message = assistantMessage({ ...event.message });
        else appendDelta(streaming.message, event.assistantMessageEvent);
        streaming.component.updateContent(streaming.message, true);
      } else if (event.type === "message_end" && streaming) streaming = undefined;
      else return;
      changed();
    },
    dispose() {
      clear();
      root.clear();
    },
  };
};
