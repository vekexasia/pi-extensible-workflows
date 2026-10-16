import assert from "node:assert/strict";
import test from "node:test";
import { agentActionLabels } from "../src/host-view.js";
import { TRANSCRIPT_LARGE_RECORD_BYTES, type TranscriptRecord } from "../src/transcript-source.js";
import { recordBlocks } from "../src/transcript-view.js";

function entry(offset: number, value: Readonly<Record<string, unknown>>): TranscriptRecord { return { kind: "entry", offset, bytes: 100, value }; }
function message(offset: number, value: Readonly<Record<string, unknown>>): TranscriptRecord { return entry(offset, { type: "message", message: value }); }

void test("every record kind turns into the blocks the transcript describes", () => {
  assert.deepEqual(recordBlocks(entry(0, { type: "session", id: "session-1", cwd: "/private/cwd" })), [], "the session header stays hidden");
  assert.deepEqual(recordBlocks(message(10, { role: "user", content: "hello there" })), [{ text: "user", style: "bold" }, { text: "hello there" }]);
  assert.deepEqual(recordBlocks(message(20, { role: "assistant", content: [{ type: "thinking", thinking: "pondering" }, { type: "text", text: "answer text" }, { type: "toolCall", id: "c1", name: "read", arguments: { path: "a.ts" } }] })), [
    { text: "assistant", style: "bold" },
    { text: "thinking", style: "dim" },
    { text: "pondering", style: "dim" },
    { text: "answer text" },
    { text: "> read", style: "accent" },
    { text: "{\n  \"path\": \"a.ts\"\n}" },
  ]);
  assert.deepEqual(recordBlocks(message(30, { role: "toolResult", toolCallId: "c1", toolName: "read", isError: false, content: [{ type: "text", text: "file body" }, { type: "image", data: "AAAA", mimeType: "image/png" }] })), [{ text: "read ok", style: "success" }, { text: "file body\n[image]", folded: true }]);
  assert.deepEqual(recordBlocks(message(40, { role: "toolResult", toolCallId: "c2", toolName: "bash", isError: true, content: [{ type: "text", text: "command not found" }] })), [{ text: "bash FAIL", style: "error" }, { text: "command not found", folded: true }]);
  assert.deepEqual(recordBlocks(message(50, { role: "system", content: "You are a secret system prompt" })), [{ text: "system prompt", style: "dim" }, { text: "You are a secret system prompt", style: "dim", folded: true }]);
  assert.deepEqual(recordBlocks(entry(60, { type: "compaction", summary: "summary of earlier work", firstKeptEntryId: "x", tokensBefore: 10 })), [{ text: "compaction", style: "dim" }, { text: "summary of earlier work" }]);
  assert.deepEqual(recordBlocks(entry(70, { type: "custom", customType: "pi-workflows:tool-timing", data: { toolName: "hidden-timing" } })), [], "tool timing entries stay hidden");
  assert.deepEqual(recordBlocks(entry(80, { type: "custom", customType: "other-ext", data: {} })), [{ text: "custom other-ext", style: "dim" }]);
  assert.deepEqual(recordBlocks(entry(90, { type: "model_change", provider: "p", modelId: "m" })), [{ text: "model: p/m", style: "dim" }]);
  assert.ok(2 * 1024 * 1024 > TRANSCRIPT_LARGE_RECORD_BYTES);
  assert.deepEqual(recordBlocks({ kind: "large", offset: 100, bytes: 2 * 1024 * 1024 }), [{ text: "large record · 2.0 MB · enter to load", style: "dim" }]);
  assert.deepEqual(recordBlocks({ kind: "unreadable", offset: 200, bytes: 512 }), [{ text: "unreadable record · 512 B", style: "warning" }]);
});

void test("the other pi session entries and message roles show their text; usage stays hidden", () => {
  const parameters = { type: "object", properties: { path: { type: "string" } } };
  assert.deepEqual(recordBlocks(message(0, { role: "system", content: "", sections: { preamble: "rule 0\nrule 1", skills: null }, toolsAdded: [{ name: "read", description: "Read a file", parameters }], toolsRemoved: [{ name: "write" }, { name: "edit" }] })), [
    { text: "system prompt", style: "dim" },
    { text: ["[preamble]", "rule 0", "rule 1", "[skills] removed", "[tool read]", "Read a file", JSON.stringify(parameters, null, 2), "tools removed: write, edit"].join("\n"), style: "dim", folded: true },
  ]);
  assert.deepEqual(recordBlocks(message(10, { role: "bashExecution", command: "ls -la", output: "total 0", exitCode: 2, cancelled: false, truncated: true })), [{ text: "! ls -la", style: "accent" }, { text: "exit 2", style: "error" }, { text: "total 0\n[output truncated]", folded: true }]);
  assert.deepEqual(recordBlocks(message(20, { role: "bashExecution", command: "sleep 9", output: "", cancelled: true, truncated: false })), [{ text: "! sleep 9", style: "accent" }, { text: "cancelled", style: "error" }, { text: "", folded: true }]);
  assert.deepEqual(recordBlocks(message(25, { role: "bashExecution", command: "true", output: "fine", exitCode: 0, cancelled: false, truncated: false })), [{ text: "! true", style: "accent" }, { text: "exit 0", style: "dim" }, { text: "fine", folded: true }]);
  assert.deepEqual(recordBlocks(message(30, { role: "custom", customType: "steer", content: [{ type: "text", text: "steered text" }], display: true })), [{ text: "custom steer", style: "dim" }, { text: "steered text", folded: true }]);
  assert.deepEqual(recordBlocks(message(40, { role: "branchSummary", summary: "left branch summary", fromId: "x" })), [{ text: "branch summary", style: "dim" }, { text: "left branch summary", folded: true }]);
  assert.deepEqual(recordBlocks(message(50, { role: "compactionSummary", summary: "compacted summary", tokensBefore: 10 })), [{ text: "compaction summary", style: "dim" }, { text: "compacted summary", folded: true }]);
  assert.deepEqual(recordBlocks(message(55, { role: "reviewer", content: "?" })), [{ text: "reviewer message", style: "dim" }]);
  assert.deepEqual(recordBlocks(entry(60, { type: "branch_summary", fromId: "y", summary: "branch entry summary" })), [{ text: "branch summary", style: "dim" }, { text: "branch entry summary", folded: true }]);
  assert.deepEqual(recordBlocks(entry(70, { type: "custom_message", customType: "ctx", content: "injected context", display: false })), [{ text: "custom ctx (hidden in Pi)", style: "dim" }, { text: "injected context", folded: true }]);
  assert.deepEqual(recordBlocks(entry(80, { type: "thinking_level_change", thinkingLevel: "high" })), [{ text: "thinking level: high", style: "dim" }]);
  assert.deepEqual(recordBlocks(entry(90, { type: "usage", kind: "cache_warm", provider: "p", model: "m", usage: {} })), [], "usage entries stay hidden");
  assert.deepEqual(recordBlocks(entry(100, { type: "context_edit", targetId: "t1", replacement: null })), [{ text: "context edit: t1 left out of the model context", style: "dim" }]);
  assert.deepEqual(recordBlocks(entry(110, { type: "context_edit", targetId: "t2", replacement: [{ type: "text", text: "replacement text" }] })), [{ text: "context edit: t2 replaced in the model context", style: "dim" }, { text: "replacement text", folded: true }]);
  assert.deepEqual(recordBlocks(entry(120, { type: "label", targetId: "t3", label: "checkpoint-1" })), [{ text: "label checkpoint-1 on t3", style: "dim" }]);
  assert.deepEqual(recordBlocks(entry(130, { type: "label", targetId: "t4" })), [{ text: "label cleared on t4", style: "dim" }]);
  assert.deepEqual(recordBlocks(entry(140, { type: "session_info", name: "Refactor auth" })), [{ text: "session name: Refactor auth", style: "dim" }]);
  assert.deepEqual(recordBlocks(entry(150, { type: "future_entry" })), [{ text: "future_entry", style: "dim" }]);
});

void test("agentActionLabels puts View transcript first only when asked", () => {
  const options = { extensionLabels: ["Ext"], hasWorktree: false, openPrompt: true, openSystemPrompt: false, openResult: false };
  const without = agentActionLabels(options);
  assert.deepEqual(without, ["Ext", "Open prompt in editor", "Copy agent ID", "Back"]);
  assert.deepEqual(agentActionLabels({ ...options, viewTranscript: false }), without);
  assert.deepEqual(agentActionLabels({ ...options, viewTranscript: true }), ["View transcript", ...without]);
});
