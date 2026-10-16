import type { WorkflowProgressStyles } from "./host-view.js";
import { TOOL_TIMING_ENTRY_TYPE } from "./tool-timing.js";
import type { TranscriptRecord } from "./transcript-source.js";
import { object } from "./utils.js";

type StyleKey = keyof WorkflowProgressStyles;
/** A piece of a record before wrapping; `folded` marks a tool result body. */
type Block = { readonly text: string; readonly style?: StyleKey; readonly folded?: true };

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  return bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function list(value: unknown): readonly unknown[] { return Array.isArray(value) ? value : []; }
/** Message content as text: a string as it is, text parts one after another, images as "[image]". */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  return list(content).flatMap((part) => !object(part) ? [] : part.type === "text" ? [text(part.text)] : part.type === "image" ? ["[image]"] : []).join("\n");
}
function assistantBlocks(content: unknown): Block[] {
  return list(content).flatMap((part): Block[] => {
    if (!object(part)) return [];
    if (part.type === "text") return [{ text: text(part.text) }];
    if (part.type === "thinking") return [{ text: "thinking", style: "dim" }, { text: text(part.thinking), style: "dim" }];
    if (part.type === "toolCall") return [{ text: `> ${text(part.name)}`, style: "accent" }, { text: JSON.stringify(part.arguments ?? {}, null, 2) }];
    return [];
  });
}
function toolNames(value: unknown): string { return list(value).flatMap((tool) => object(tool) && typeof tool.name === "string" ? [tool.name] : []).join(", "); }
/** A system message: its content, each section it sets or removes, the tools it declares in full and the tools it removes; folded like tool results. */
function systemBlocks(message: Readonly<Record<string, unknown>>): Block[] {
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
function customBlocks(value: Readonly<Record<string, unknown>>): Block[] {
  return [{ text: `custom ${text(value.customType)}${value.display === false ? " (hidden in Pi)" : ""}`, style: "dim" }, { text: contentText(value.content), folded: true }];
}
function messageBlocks(message: unknown): Block[] {
  const role = object(message) ? text(message.role) : "";
  if (!object(message) || !role) return [{ text: "message", style: "dim" }];
  if (role === "user") return [{ text: "user", style: "bold" }, { text: contentText(message.content) }];
  if (role === "assistant") return [{ text: "assistant", style: "bold" }, ...assistantBlocks(message.content)];
  if (role === "toolResult") {
    const failed = message.isError === true;
    return [{ text: `${text(message.toolName) || "tool"} ${failed ? "FAIL" : "ok"}`, style: failed ? "error" : "success" }, { text: contentText(message.content), folded: true }];
  }
  if (role === "system") return systemBlocks(message);
  if (role === "bashExecution") {
    const exitCode = typeof message.exitCode === "number" ? message.exitCode : undefined;
    const failed = message.cancelled === true || (exitCode !== undefined && exitCode !== 0);
    const state = message.cancelled === true ? "cancelled" : exitCode === undefined ? "" : `exit ${String(exitCode)}`;
    const output = [text(message.output), message.truncated === true ? "[output truncated]" : ""].filter(Boolean).join("\n");
    return [{ text: `! ${text(message.command)}`, style: "accent" }, ...(state ? [{ text: state, style: failed ? "error" : "dim" } satisfies Block] : []), { text: output, folded: true }];
  }
  if (role === "custom") return customBlocks(message);
  if (role === "branchSummary" || role === "compactionSummary") return [{ text: role === "branchSummary" ? "branch summary" : "compaction summary", style: "dim" }, { text: text(message.summary), folded: true }];
  return [{ text: `${role} message`, style: "dim" }];
}
/** Pi session entry types (docs/session-format.md); usage entries stay hidden as in Pi's own tree. */
export function recordBlocks(record: TranscriptRecord): Block[] {
  if (record.kind === "large") return [{ text: `large record · ${formatBytes(record.bytes)} · enter to load`, style: "dim" }];
  if (record.kind === "unreadable") return [{ text: `unreadable record · ${formatBytes(record.bytes)}`, style: "warning" }];
  const value = record.value;
  const type = text(value.type);
  if (type === "session" || type === "usage" || (type === "custom" && value.customType === TOOL_TIMING_ENTRY_TYPE)) return [];
  if (type === "message") return messageBlocks(value.message);
  if (type === "compaction") return [{ text: "compaction", style: "dim" }, { text: text(value.summary) }];
  if (type === "branch_summary") return [{ text: "branch summary", style: "dim" }, { text: text(value.summary), folded: true }];
  if (type === "custom_message") return customBlocks(value);
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
