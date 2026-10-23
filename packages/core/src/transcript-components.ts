import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AssistantMessageComponent, BashExecutionComponent, BranchSummaryMessageComponent, CompactionSummaryMessageComponent, createBashToolDefinition, createEditToolDefinition, createFindToolDefinition, createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition, createWriteToolDefinition, CustomMessageComponent, formatSize, getMarkdownTheme, keyText, parseSkillBlock, type SessionEntry, sessionEntryToContextMessages, type SettingsManager, SkillInvocationMessageComponent, ToolExecutionComponent, truncateTail, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { type Component, Container, type MarkdownTheme, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import type { WorkflowProgressStyles } from "./host-view.js";
import { isTimingTranscriptEntry } from "./trajectory.js";
import type { TranscriptRecord } from "./session-transcript.js";
import type { WorkflowAgentSessionEvent } from "./types.js";
import { finiteNumber, jsonObject, object, sanitizeDisplayText } from "./utils.js";

/**
 * The /agents transcript pane: each record of a pi session file drawn with the component Pi's own chat uses for it.
 * Entries Pi does not draw keep the dashboards' text.
 */

/** Tool results are folded to this many lines until the reader expands them. */
const TRANSCRIPT_FOLDED_RESULT_LINES = 10;

/** The transcript pane's content: one Pi component per record, kept in file order. */
export interface TranscriptView {
  /** Mounted by the workspace inside its primary ScrollView. */
  readonly component: Component;
  /** Drops every record and the live message. */
  reset(): void;
  append(records: readonly TranscriptRecord[]): void;
  /** Tool output expanded or collapsed (Pi's app.tools.expand). */
  setExpanded(expanded: boolean): void;
  /** Session events of the live attempt: message_start/message_update/message_end draw the message being generated; an event that changes it asks `ui` for a frame. */
  live(event: WorkflowAgentSessionEvent): void;
  dispose(): void;
}

/** `ui` is the workspace's TuiAltScreen; `cwd` is the agent's attempt directory. */
/** `styles` are the theme's colours for the lines Pi has no component for; `settings` are Pi's display settings, read as Pi's chat reads them. */
export type CreateTranscriptView = (options: { readonly ui: TUI; readonly cwd: string; readonly styles: WorkflowProgressStyles; readonly settings: SettingsManager }) => TranscriptView;

type Fields = Readonly<Record<string, unknown>>;
type ToolRendering = ConstructorParameters<typeof ToolExecutionComponent>[4];
type ToolResult = Parameters<ToolExecutionComponent["updateResult"]>[0];
/** A piece of a record Pi does not draw, before wrapping; `folded` marks a body folded like a tool result. */
type Block = { readonly text: string; readonly style?: keyof WorkflowProgressStyles; readonly folded?: true };
type Expandable = Component & { setExpanded(expanded: boolean): void };
/** The components of one record; empty for a record Pi does not draw and for a result, which is drawn inside its call's block. */
type Item = { readonly record: TranscriptRecord; readonly child: Container };

/** Pi's built-in renderers; every other tool gets ToolExecutionComponent's generic block. */
const BUILT_IN_TOOLS = new Map<string, (cwd: string) => ToolRendering>([["read", createReadToolDefinition], ["bash", createBashToolDefinition], ["edit", createEditToolDefinition], ["write", createWriteToolDefinition], ["grep", createGrepToolDefinition], ["find", createFindToolDefinition], ["ls", createLsToolDefinition]]);
/** AssistantMessageComponent draws only content, stopReason and errorMessage. */
const UNDRAWN = { api: "", provider: "", model: "", usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, timestamp: 0 } satisfies Omit<AssistantMessage, "role" | "content" | "stopReason">;

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function list(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
/** sanitizeDisplayText line by line, keeping the line breaks and tabs that Markdown and code need. */
function clean(value: string): string { return value.split(/\r\n|\r|\n/).map((line) => line.split("\t").map(sanitizeDisplayText).join("\t")).join("\n"); }
/** A user message's text as Pi's own chat joins it: the text parts one after another, no images. */
function userText(content: unknown): string {
  if (typeof content === "string") return clean(content);
  return list(content).flatMap((part) => object(part) && part.type === "text" ? [clean(text(part.text))] : []).join("");
}
/** Message content as text: a string as it is, text parts one after another, images as "[image]". */
function contentText(content: unknown): string {
  if (typeof content === "string") return clean(content);
  return list(content).flatMap((part) => !object(part) ? [] : part.type === "text" ? [clean(text(part.text))] : part.type === "image" ? ["[image]"] : []).join("\n");
}
function toolNames(value: unknown): string { return list(value).flatMap((tool) => object(tool) && typeof tool.name === "string" ? [tool.name] : []).join(", "); }
/** A system message: its content, each section it sets or removes, the tools it declares in full and the tools it removes; folded like tool results. */
function systemBlocks(message: Fields): Block[] {
  const sections = object(message.sections) ? Object.entries(message.sections) : [];
  const added = list(message.toolsAdded).flatMap((tool) => object(tool) ? [`[tool ${text(tool.name)}]\n${text(tool.description)}\n${JSON.stringify(tool.parameters ?? {}, null, 2)}`] : []);
  const removed = toolNames(message.toolsRemoved);
  const body = [
    contentText(message.content),
    ...sections.map(([name, value]) => value === null ? `[${name}] removed` : `[${name}]\n${text(value)}`),
    ...added,
    removed ? `tools removed: ${removed}` : "",
  ].filter(Boolean).join("\n");
  return [{ text: "system prompt", style: "dim" }, { text: body, style: "dim", folded: true }];
}
function customBlocks(value: Fields): Block[] {
  return [{ text: `custom ${text(value.customType)}${value.display === false ? " (hidden in Pi)" : ""}`, style: "dim" }, { text: contentText(value.content), folded: true }];
}
function messageBlocks(message: unknown): Block[] {
  const role = object(message) ? text(message.role) : "";
  if (!object(message) || !role) return [{ text: "message", style: "dim" }];
  if (role === "system") return systemBlocks(message);
  if (role === "custom") return customBlocks(message);
  return [{ text: `${role} message`, style: "dim" }];
}
/** Pi session entry types (docs/session-format.md) that Pi has no component for; usage entries stay hidden as in Pi's own tree. */
function recordBlocks(record: TranscriptRecord): Block[] {
  if (record.kind === "unreadable") return [{ text: `unreadable record · ${formatSize(record.bytes)}`, style: "warning" }];
  const value = record.value;
  const type = text(value.type);
  if (type === "session" || type === "usage" || isTimingTranscriptEntry(value)) return [];
  // Pi turns a branch summary without text into no message, and its chat draws nothing for it.
  if (type === "branch_summary") return [];
  if (type === "message") return messageBlocks(value.message);
  if (type === "model_change") return [{ text: `model: ${text(value.provider)}/${text(value.modelId)}`, style: "dim" }];
  if (type === "thinking_level_change") return [{ text: `thinking level: ${text(value.thinkingLevel)}`, style: "dim" }];
  if (type === "context_edit") {
    if (value.replacement === null) return [{ text: `context edit: ${text(value.targetId)} left out of the model context`, style: "dim" }];
    return [{ text: `context edit: ${text(value.targetId)} replaced in the model context`, style: "dim" }, { text: contentText(value.replacement), folded: true }];
  }
  if (type === "label") return [{ text: typeof value.label === "string" ? `label ${value.label} on ${text(value.targetId)}` : `label cleared on ${text(value.targetId)}`, style: "dim" }];
  if (type === "session_info") return [{ text: `session name: ${text(value.name)}`, style: "dim" }];
  return [{ text: type === "custom" ? `custom ${text(value.customType)}` : type || "entry", style: "dim" }];
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
function expandable(component: Component): component is Expandable { return "setExpanded" in component && typeof component.setExpanded === "function"; }
/**
 * A recorded result completes its block with updateResult only, as Pi's restored history does: setArgsComplete would
 * have the edit renderer diff the file as it is on disk now, and markExecutionStarted would have the bash renderer
 * time the block with the clock, neither of which the records carry.
 */
function complete(tool: ToolExecutionComponent, result: ToolResult): void { tool.updateResult(result); }
function blocksText(blocks: readonly Block[], expanded: boolean, styles: WorkflowProgressStyles): string {
  const paint = (line: string, style: Block["style"]): string => style === undefined ? line : styles[style](line);
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
  constructor(private readonly blocks: readonly Block[], private readonly styles: WorkflowProgressStyles) {
    super();
    this.addChild(new Spacer(1));
    this.addChild(this.body);
    this.setExpanded(false);
  }
  setExpanded(expanded: boolean): void { this.body.setText(blocksText(this.blocks, expanded, this.styles)); }
}

export const createTranscriptView: CreateTranscriptView = ({ ui, cwd, styles, settings }) => {
  const root = new Container();
  const pad = settings.getOutputPad();
  const hideThinking = settings.getHideThinkingBlock();
  const toolOptions = { showImages: settings.getShowImages(), imageWidthCells: settings.getImageWidthCells(), outputPad: pad };
  const codeBlockIndent = settings.getCodeBlockIndent();
  const markdown = (): MarkdownTheme => ({ ...getMarkdownTheme(), codeBlockIndent });
  const definitions = new Map([...BUILT_IN_TOOLS].map(([name, create]) => [name, create(cwd)] as const));
  let items: Item[] = [];
  let streaming: { readonly component: AssistantMessageComponent; readonly box: Container; message: AssistantMessage; tools: { readonly id: string; readonly name: string; readonly tool: ToolExecutionComponent }[] } | undefined;
  /**
   * Assistant messages that ended but whose records were not appended yet (Pi writes the record after message_end). They stay drawn
   * until then, so the content does not shrink and spring back under a transcript scrolled up.
   */
  let finished: NonNullable<typeof streaming>[] = [];
  let expanded = false;
  /** Records left undrawn: the empty message Pi records when an accepted workflow_result aborts its session (agent-execution.ts), which Pi's components would draw as an error. */
  let hidden = new Set<Item>();
  /** The blocks of the calls still waiting for their result, by call id, as Pi's renderSessionItems keeps them. */
  let pending = new Map<string, ToolExecutionComponent>();
  /** The last appended record was an accepted workflow_result. */
  let accepted = false;

  function changed(): void {
    root.children = [...items.flatMap((item) => hidden.has(item) ? [] : [item.child]), ...finished.map(({ box }) => box), ...(streaming ? [streaming.box] : [])];
    ui.requestRender();
  }
  function clear(): void {
    items = [];
    streaming = undefined;
    finished = [];
    hidden = new Set();
    pending = new Map();
    accepted = false;
  }
  /** Pi's renderers print the arguments and details they get without removing terminal sequences: they reach them cleaned. */
  function tool(name: string, id: string, args: Fields): ToolExecutionComponent { return new ToolExecutionComponent(sanitizeDisplayText(name), id, args, toolOptions, definitions.get(name), ui, cwd); }
  /** A tool block made after its record was built: completed with `result` when there is one, and opened as the others are. */
  function block(name: string, id: string, args: Fields, result: ToolResult | undefined): ToolExecutionComponent {
    const component = tool(name, id, args);
    if (result) complete(component, result);
    if (expanded) component.setExpanded(true);
    return component;
  }
  /** The streamed message's tool blocks follow its calls: a call keeps its block while its arguments grow. */
  function streamTools(live: NonNullable<typeof streaming>): void {
    const calls = live.message.content.flatMap((part) => part.type === "toolCall" ? [part] : []);
    live.tools = calls.map((part, index) => {
      const [id, name, args] = [clean(part.id), part.name, cleanArguments(part.arguments)];
      const known = live.tools[index];
      if (known?.id === id && known.name === name) {
        known.tool.updateArgs(args);
        return known;
      }
      return { id, name, tool: block(name, id, args, undefined) };
    });
    live.box.children = [live.component, ...live.tools.map(({ tool: component }) => component)];
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
    const value = record.kind === "entry" ? record.value : undefined;
    // Pi's conversion reads the role of a message entry's message: an entry without a message object is left to recordBlocks.
    const messages: readonly unknown[] = value && (value.type !== "message" || object(value.message)) ? sessionEntryToContextMessages(value as unknown as SessionEntry) : [];
    for (const converted of messages) {
      const message: Fields = object(converted) ? converted : {};
      if (message.role === "user") {
        const said = userText(message.content);
        const skill = parseSkillBlock(said);
        if (!skill) child.children.push(new Spacer(1), new UserMessageComponent(said, markdown(), pad));
        else {
          child.children.push(new Spacer(1), new SkillInvocationMessageComponent(skill, markdown()));
          if (skill.userMessage) child.children.push(new Spacer(1), new UserMessageComponent(skill.userMessage, markdown(), pad));
        }
      } else if (message.role === "assistant") {
        child.addChild(new AssistantMessageComponent(assistantMessage(message), hideThinking, markdown(), undefined, pad));
        const stopped = stopResult(message);
        for (const part of list(message.content)) {
          if (!object(part) || part.type !== "toolCall") continue;
          const [id, name, args] = [text(part.id), text(part.name), cleanArguments(part.arguments)];
          const component = tool(name, id, args);
          if (stopped) complete(component, stopped);
          else pending.set(id, component);
          child.addChild(component);
        }
      } else if (message.role === "toolResult") {
        // A result with no pending call is dropped, as in Pi's chat.
        const id = text(message.toolCallId);
        const owner = pending.get(id);
        if (owner) complete(owner, { content: resultContent(message.content), details: cleanValue(message.details), isError: message.isError === true });
        pending.delete(id);
      }
      else if (message.role === "bashExecution") child.addChild(bashExecution(message));
      else if (message.role === "custom" && message.display === true) child.addChild(new CustomMessageComponent({ role: "custom", customType: clean(text(message.customType)), content: contentText(message.content), display: true, timestamp: 0 }, undefined, markdown(), pad));
      else if (message.role === "compactionSummary") child.children.push(new Spacer(1), new CompactionSummaryMessageComponent({ role: "compactionSummary", summary: clean(text(message.summary)), tokensBefore: finiteNumber(message.tokensBefore) ? message.tokensBefore : 0, timestamp: 0 }, markdown()));
      else if (message.role === "branchSummary") child.children.push(new Spacer(1), new BranchSummaryMessageComponent({ role: "branchSummary", summary: clean(text(message.summary)), fromId: null, timestamp: 0 }, markdown()));
      else child.addChild(new RecordText(messageBlocks(message), styles));
    }
    const blocks = messages.length === 0 ? recordBlocks(record) : [];
    if (blocks.length > 0) child.addChild(new RecordText(blocks, styles));
    if (expanded) for (const component of child.children) if (expandable(component)) component.setExpanded(true);
    return { record, child };
  }

  return {
    component: root,
    reset() {
      clear();
      changed();
    },
    append(records) {
      for (const record of records) {
        const item = build(record);
        items.push(item);
        const value = record.kind === "entry" ? record.value : undefined;
        if (value && value.type !== "message") continue;
        const message = object(value?.message) ? value.message : undefined;
        if (accepted && message?.role === "assistant" && list(message.content).length === 0 && stopResult(message)) hidden.add(item);
        accepted = message?.role === "toolResult" && message.toolName === "workflow_result" && message.isError !== true;
      }
      // Each assistant record takes the place of the oldest finished message, in the order Pi wrote them.
      const arrived = records.filter((record) => record.kind === "entry" && record.value.type === "message" && object(record.value.message) && record.value.message.role === "assistant").length;
      finished = finished.slice(arrived);
      changed();
    },
    setExpanded(next) {
      if (next === expanded) return;
      expanded = next;
      for (const item of items) for (const component of item.child.children) if (expandable(component)) component.setExpanded(next);
      for (const { tool: component } of [...finished, ...(streaming ? [streaming] : [])].flatMap((live) => live.tools)) component.setExpanded(next);
      changed();
    },
    live(event) {
      if (event.type === "message_start") {
        if (event.message?.role !== "assistant") return;
        const message = assistantMessage({ ...event.message });
        const component = new AssistantMessageComponent(undefined, hideThinking, markdown(), undefined, pad);
        component.updateContent(message, true);
        streaming = { component, box: new Container(), message, tools: [] };
        streamTools(streaming);
      } else if (event.type === "message_update" && streaming && event.message) {
        streaming.message = assistantMessage({ ...event.message });
        streaming.component.updateContent(streaming.message, true);
        streamTools(streaming);
        // The message's box is already a child of the root: only its own content changed.
        ui.requestRender();
        return;
      } else if (event.type === "message_end" && streaming) { finished.push(streaming); streaming = undefined; }
      else return;
      changed();
    },
    dispose() {
      clear();
      root.clear();
    },
  };
};
