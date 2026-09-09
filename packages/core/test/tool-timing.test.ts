import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { localAgentTransport, type AgentTransportContext } from "../src/agent-execution.js";
import type { PreparedAgentSession } from "../src/types.js";
import { createToolTimingExtension, TOOL_TIMING_ENTRY_TYPE, type ToolTimingEntry } from "../src/tool-timing.js";

type JsonRecord = Record<string, unknown>;
function isRecord(value: unknown): value is JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value); }
function timingEntry(value: unknown): ToolTimingEntry | undefined {
  if (!isRecord(value) || value.type !== "custom" || value.customType !== TOOL_TIMING_ENTRY_TYPE || !isRecord(value.data)) return undefined;
  const data = value.data;
  if (typeof data.toolCallId !== "string" || typeof data.toolName !== "string" || typeof data.startedAt !== "number" || typeof data.completedAt !== "number" || typeof data.durationMs !== "number" || typeof data.isError !== "boolean") return undefined;
  return { toolCallId: data.toolCallId, toolName: data.toolName, startedAt: data.startedAt, completedAt: data.completedAt, durationMs: data.durationMs, isError: data.isError };
}
function streamResponse(response: import("node:http").ServerResponse, choices: readonly JsonRecord[]): void {
  const chunk = (choice: JsonRecord) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [choice] })}`;
  response.writeHead(200, { Connection: "close", "Content-Type": "text/event-stream" });
  response.end([...choices.map(chunk), "data: [DONE]", ""].join("\n\n"));
}
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not open a TCP port");
  return address.port;
}

void test("records real parallel tool execution timing in the workflow session JSONL", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-tool-timing-"));
  const agentDir = join(rootDir, "agent");
  const cwd = join(rootDir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  const requests: unknown[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const parsed: unknown = JSON.parse(body);
      requests.push(parsed);
      if (requests.length === 1) {
        streamResponse(response, [{ index: 0, delta: { role: "assistant", tool_calls: [
          { index: 0, id: "call-first", type: "function", function: { name: "timed", arguments: JSON.stringify({ label: "first" }) } },
          { index: 1, id: "call-second", type: "function", function: { name: "timed", arguments: JSON.stringify({ label: "second" }) } },
        ] }, finish_reason: "tool_calls" }]);
      } else {
        streamResponse(response, [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }, { index: 0, delta: {}, finish_reason: "stop" }]);
      }
    });
  });
  const port = await listen(server);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${String(port)}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id: "fixture-model", name: "Fixture model", reasoning: false, input: ["text"], contextWindow: 1_024, maxTokens: 128 }] } } }));
  writeFileSync(join(agentDir, "auth.json"), "{}");
  const tool = {
    name: "timed",
    label: "Timed",
    description: "A tool for timing tests",
    parameters: Type.Object({ label: Type.String() }),
    async execute(_toolCallId: string, params: unknown) {
      const label = isRecord(params) && typeof params.label === "string" ? params.label : "unknown";
      await new Promise<void>((resolve) => setTimeout(resolve, label === "first" ? 10 : 1));
      return { content: [{ type: "text" as const, text: label }], details: {} };
    },
  } satisfies ToolDefinition;
  const controller = new AbortController();
  const prepared = { cwd, agentDir, model: { provider: "fixture", model: "fixture-model" }, tools: [], customTools: [tool], sessionLabel: "tool-timing" } satisfies PreparedAgentSession;
  const context = { run: { cwd, sessionId: "run-session", runId: "run", workflow: { name: "timing" }, args: null, signal: controller.signal }, identity: { structuralPath: [], callSite: "test", occurrence: 1 }, attempt: 1, signal: controller.signal, settings: {} } satisfies AgentTransportContext;
  let session: Awaited<ReturnType<typeof localAgentTransport.createSession>> | undefined;
  try {
    session = await localAgentTransport.createSession(prepared, context);
    await session.prompt("run the tools");
    const locator = session.reference.locator;
    if (!isRecord(locator) || typeof locator.sessionFile !== "string") throw new Error("workflow session file was not created");
    const records: JsonRecord[] = [];
    for (const line of readFileSync(locator.sessionFile, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) records.push(value);
    }
    const timings = records.map(timingEntry).filter((entry): entry is ToolTimingEntry => entry !== undefined);
    assert.equal(timings.length, 2);
    assert.deepEqual(new Set(timings.map(({ toolCallId }) => toolCallId)), new Set(["call-first", "call-second"]));
    for (const timing of timings) {
      assert.equal(timing.toolName, "timed");
      assert.equal(timing.completedAt - timing.startedAt, timing.durationMs);
      assert.equal(timing.isError, false);
      assert.ok(timing.durationMs >= 0);
    }
    assert.ok(requests.length >= 2);
    assert.equal(requests.some((request) => JSON.stringify(request).includes(TOOL_TIMING_ENTRY_TYPE)), false);
  } finally {
    await session?.dispose();
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    rmSync(rootDir, { recursive: true, force: true });
  }
});

void test("tool timing extension supports a deterministic clock", () => {
  assert.doesNotMatch(Function.prototype.toString.call(createToolTimingExtension()), /TOOL_TIMING_ENTRY_TYPE|toolTimingExtension/);
  let now = 100;
  const entries: Array<{ type: string; data: unknown }> = [];
  const handlers = new Map<string, (event: unknown) => void>();
  const pi = {
    on(name: string, handler: (event: unknown) => void) { handlers.set(name, handler); },
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
  } as unknown as ExtensionAPI;
  void createToolTimingExtension(() => now)(pi);
  handlers.get("tool_execution_start")?.({ toolCallId: "call", toolName: "bash" });
  now = 250;
  handlers.get("tool_execution_end")?.({ toolCallId: "call", toolName: "bash", isError: true });
  assert.deepEqual(entries, [{ type: TOOL_TIMING_ENTRY_TYPE, data: { toolCallId: "call", toolName: "bash", startedAt: 100, completedAt: 250, durationMs: 150, isError: true } }]);
});

void test("serialized tool timing extension runs in the Herdr bridge", async () => {
  const rootDir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-tool-timing-bridge-"));
  const extensionPath = join(rootDir, "extensions.mjs");
  const factorySource = Function.prototype.toString.call(createToolTimingExtension());
  writeFileSync(extensionPath, `const factories = [${factorySource}];\nexport default async function(pi) { for (const factory of factories) await factory(pi); }\n`);
  const entries: Array<{ type: string; data: unknown }> = [];
  const handlers = new Map<string, (event: unknown) => void>();
  const pi = {
    on(name: string, handler: (event: unknown) => void) { handlers.set(name, handler); },
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
  } as unknown as ExtensionAPI;
  try {
    const bridge = await import(pathToFileURL(extensionPath).href) as { default: (pi: ExtensionAPI) => Promise<void> };
    await bridge.default(pi);
    handlers.get("tool_execution_start")?.({ toolCallId: "bridge-call", toolName: "bash" });
    handlers.get("tool_execution_end")?.({ toolCallId: "bridge-call", toolName: "bash", isError: false });
    assert.equal(entries.length, 1);
    const entry = entries[0];
    assert.ok(entry);
    assert.equal(entry.type, TOOL_TIMING_ENTRY_TYPE);
    assert.ok(isRecord(entry.data));
    const { toolCallId, toolName, startedAt, completedAt, durationMs, isError } = entry.data;
    assert.equal(toolCallId, "bridge-call");
    assert.equal(toolName, "bash");
    assert.equal(isError, false);
    assert.equal(typeof startedAt, "number");
    assert.equal(typeof completedAt, "number");
    assert.equal(typeof durationMs, "number");
    if (typeof startedAt !== "number" || typeof completedAt !== "number" || typeof durationMs !== "number") throw new Error("bridge timing entry has invalid numeric fields");
    assert.equal(completedAt - startedAt, durationMs);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

void test("bounds unfinished tool timing state", () => {
  let now = 100;
  const entries: Array<{ type: string; data: unknown }> = [];
  const handlers = new Map<string, (event: unknown) => void>();
  const pi = {
    on(name: string, handler: (event: unknown) => void) { handlers.set(name, handler); },
    appendEntry(type: string, data: unknown) { entries.push({ type, data }); },
  } as unknown as ExtensionAPI;
  void createToolTimingExtension(() => now)(pi);
  for (let index = 0; index < 401; index += 1) handlers.get("tool_execution_start")?.({ toolCallId: `call-${String(index)}`, toolName: "bash" });
  now = 200;
  for (let index = 0; index < 401; index += 1) handlers.get("tool_execution_end")?.({ toolCallId: `call-${String(index)}`, toolName: "bash", isError: false });
  assert.equal(entries.length, 400);
});
