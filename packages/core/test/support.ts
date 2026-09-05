import assert from "node:assert/strict";
import { createExtensionRuntime, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, type ExtensionAPI, type ExtensionCommandContext, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { ERROR_CODES, RUN_STATES } from "../src/index.js";
import type { AgentTransportContext, JsonValue, WorkflowExtension, WorkflowFailureDiagnostics } from "../src/index.js";
import type { WorkflowExtensionAPI } from "../src/host.js";

export const reuseExtension: WorkflowExtension = { version: "1.0.0", headline: "Reusable", functions: { inspect: { description: "Inspect", input: { type: "object", additionalProperties: false }, output: { type: "string" }, run: () => "ok" }, hello: { description: "Say hello", input: { type: "object", properties: { name: { type: "string" } }, required: ["name"], additionalProperties: false }, output: { type: "string" }, run: (input) => typeof input.name === "string" ? input.name : "" } } };
export async function waitForIssue105(check: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await check()) return;
    if (attempt % 10 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 50));
    else await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.fail("Timed out waiting for issue #105 test gate");
}

type WorkflowCommand = (args: string, context: unknown) => Promise<void>;
export async function contextualWorkflowAction(command: WorkflowCommand, source: Record<string, unknown>, runId: string, action: string | ((options: string[]) => string | undefined), mode: "Foreground" | "Background" = "Foreground", confirm = true): Promise<void> {
  let picked = false;
  let used = false;
  const baseUi = source.ui as { notify: (message: string) => void };
  const select = async (prompt: string, options: string[]): Promise<string> => {
    if (options.includes("Skip")) return "Skip";
    if (prompt === "Workflows\n") {
      if (picked) return "Close";
      picked = true;
      return options.find((option) => option.includes(runId)) ?? options[0] ?? "Close";
    }
    if (prompt.startsWith("Resume ")) return mode;
    if (options.includes("Approve")) return "Approve";
    if (typeof action === "function") return action(options) ?? "Back";
    if (!used && options.includes(action)) { used = true; return action; }
    return "Back";
  };
  const ui = { ...baseUi, select, confirm: async () => confirm };
  await command("", { ...source, hasUI: true, mode: "rpc", ui });
}
type TestTool = {
  name: string;
  execute?(...args: unknown[]): Promise<unknown>;
  renderCall?(...args: unknown[]): unknown;
  renderResult?(...args: unknown[]): unknown;
  promptGuidelines?: string[];
  promptSnippet?: string;
};
type TestWorkflowMessage = { customType: string; content: string; display: boolean };
type TestWorkflowMessageOptions = NonNullable<Parameters<ExtensionAPI["sendMessage"]>[1]>;
type TestWorkflowLogEntry = { workflowName: string; message: string };
type TestExtensionApiOptions = {
  registerTool?(tool: TestTool): void;
  registerCommand?: ExtensionAPI["registerCommand"];
  on?: ExtensionAPI["on"];
  getThinkingLevel?: ExtensionAPI["getThinkingLevel"];
  getActiveTools?: ExtensionAPI["getActiveTools"];
  appendEntry?: (type: string, data: TestWorkflowLogEntry) => void;
  sendMessage?: (message: TestWorkflowMessage, options?: TestWorkflowMessageOptions) => void;
  registerEntryRenderer?(type: string, renderer: unknown): void;
  registerShortcut?: ExtensionAPI["registerShortcut"];
  events?: {
    emit?: ExtensionAPI["events"]["emit"];
    on?: ExtensionAPI["events"]["on"];
  };

};
function isTestWorkflowLogEntry(value: unknown): value is TestWorkflowLogEntry {
  return typeof value === "object" && value !== null && "workflowName" in value && typeof value.workflowName === "string" && "message" in value && typeof value.message === "string";
}
export function testExtensionApi(options: TestExtensionApiOptions = {}): WorkflowExtensionAPI {
  const api: WorkflowExtensionAPI = {
    appendEntry(type, data) {
      if (isTestWorkflowLogEntry(data)) options.appendEntry?.(type, data);
    },
    getActiveTools: options.getActiveTools ?? (() => []),
    getThinkingLevel: options.getThinkingLevel ?? (() => "medium"),
    on: options.on ?? (() => {}),
    registerCommand: options.registerCommand ?? (() => {}),
    registerTool(tool) { options.registerTool?.(tool); },
    sendMessage(message, deliveryOptions) {
      if (typeof message.content !== "string") return;
      const customType = typeof message.customType === "string" ? message.customType : "workflow";
      const display = message.display;
      options.sendMessage?.({ customType, content: message.content, display }, deliveryOptions);
    },
  };
  const registerEntryRenderer: ExtensionAPI["registerEntryRenderer"] = (type, renderer) => { options.registerEntryRenderer?.(type, renderer); };
  return { ...api, ...(options.registerEntryRenderer ? { registerEntryRenderer } : {}), ...(options.registerShortcut ? { registerShortcut: options.registerShortcut } : {}), ...(options.events ? { events: options.events } : {}) };
}
const testModelRegistry = new ModelRegistry(await ModelRuntime.create({ modelsPath: null }));
const testExtensionRunner = new ExtensionRunner([], createExtensionRuntime(), "/repo", SessionManager.inMemory("/repo", { id: "test-session" }), testModelRegistry);
export const testExtensionContext: ExtensionCommandContext = testExtensionRunner.createCommandContext();
const testTransportSignal = new AbortController().signal;
export const testTransportContext = {
  run: { cwd: "/repo", sessionId: "test-session", runId: "test-run", workflow: { name: "test" }, args: null, signal: testTransportSignal },
  identity: { structuralPath: [], callSite: "test", occurrence: 1 },
  attempt: 1,
  signal: testTransportSignal,
} satisfies AgentTransportContext;
export function testExtensionContextFor(overrides: object = {}): ExtensionCommandContext {
  const context = testExtensionRunner.createCommandContext();
  for (const [key, value] of Object.entries(overrides)) Object.defineProperty(context, key, { configurable: true, enumerable: true, writable: true, value });
  return context;
}
export function executeTool<T extends Pick<ToolDefinition, "execute">>(tool: T, toolCallId: Parameters<T["execute"]>[0], params: Parameters<T["execute"]>[1], context: ExtensionContext = testExtensionContext): Promise<unknown> {
  return tool.execute(toolCallId, params, undefined, undefined, context);
}
export function callUnchecked<T>(fn: (...args: never[]) => T, thisArg: unknown, args: readonly unknown[]): T {
  return Reflect.apply(fn, thisArg, args) as T;
}
type TestExecutableTool = { execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, context: ExtensionContext) => Promise<unknown> };
export function executeToolCall(tool: TestExecutableTool, toolCallId: string, params: unknown, context: ExtensionContext = testExtensionContext): Promise<unknown> {
  return tool.execute(toolCallId, params, undefined, undefined, context);
}
type UncheckedTool = Pick<ToolDefinition, "execute"> | TestExecutableTool;
export function executeToolUnchecked(tool: UncheckedTool, toolCallId: unknown, params: unknown, context: ExtensionContext = testExtensionContext): Promise<unknown> {
  return callUnchecked(tool.execute, tool, [toolCallId, params, undefined, undefined, context]);
}
type TestCommand = (args: string, context: ExtensionCommandContext) => Promise<void> | void;
export function executeCommand(command: TestCommand | undefined, args = "", overrides: object = {}): Promise<void> {
  return command === undefined ? Promise.resolve() : Promise.resolve(command(args, testExtensionContextFor(overrides)));
}

export type TestToolResult = { readonly content: readonly { readonly text: string }[]; readonly details?: unknown; readonly isError?: boolean };

export function isTestRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTestTextContent(value: unknown): value is { readonly text: string } {
  return isTestRecord(value) && typeof value.text === "string";
}

export function decodeTestToolResult(value: unknown): TestToolResult {
  if (!isTestRecord(value) || !Array.isArray(value.content)) throw new Error("Invalid test tool result");
  const content = value.content.filter(isTestTextContent);
  if (content.length !== value.content.length) throw new Error("Invalid test tool result content");
  if (value.isError !== undefined && typeof value.isError !== "boolean") throw new Error("Invalid test tool result error flag");
  return { content, ...(value.details === undefined ? {} : { details: value.details }), ...(value.isError === undefined ? {} : { isError: value.isError }) };
}

export function decodeTestJson<T>(text: string, predicate: (value: unknown) => value is T): T {
  const value: unknown = JSON.parse(text);
  if (!predicate(value)) throw new Error("Invalid test JSON");
  return value;
}

export function decodeTestJsonRecord(text: string): Record<string, unknown> {
  return decodeTestJson(text, isTestRecord);
}

function hasOptionalString(value: Record<string, unknown>, key: string): boolean {
  return !(key in value) || typeof value[key] === "string";
}

function isTestStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isTestJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isTestJsonValue);
  return isTestRecord(value) && Object.values(value).every(isTestJsonValue);
}

function isTestSessionReference(value: unknown): boolean {
  if (!isTestRecord(value) || typeof value.transport !== "string" || typeof value.sessionId !== "string") return false;
  return value.locator === undefined || isTestJsonValue(value.locator);
}

function isTestFailureAgent(value: unknown): boolean {
  if (!isTestRecord(value) || typeof value.id !== "string" || !isTestStringArray(value.structuralPath) || typeof value.attempt !== "number") return false;
  if (!hasOptionalString(value, "label") || !hasOptionalString(value, "role") || !hasOptionalString(value, "transport")) return false;
  return value.session === undefined || isTestSessionReference(value.session);
}

function isTestSiblingAgent(value: unknown): boolean {
  if (!isTestRecord(value) || typeof value.id !== "string" || !isTestStringArray(value.structuralPath)) return false;
  return hasOptionalString(value, "label") && hasOptionalString(value, "role");
}

function isTestRunState(value: unknown): value is WorkflowFailureDiagnostics["state"] {
  return typeof value === "string" && RUN_STATES.some((state) => state === value);
}

function isTestErrorCode(value: unknown): value is WorkflowFailureDiagnostics["error"]["code"] {
  return typeof value === "string" && ERROR_CODES.some((code) => code === value);
}

function isTestWorkflowFailureError(value: unknown): boolean {
  return isTestRecord(value) && isTestErrorCode(value.code) && typeof value.message === "string" && hasOptionalString(value, "failedAt");
}

function isTestWorkflowRetry(value: unknown): boolean {
  return isTestRecord(value) && typeof value.sourceRunId === "string" && typeof value.action === "string" && isTestStringArray(value.completedPaths) && isTestStringArray(value.incompletePaths) && isTestStringArray(value.namedWorktrees) && typeof value.warning === "string";
}

export function isTestWorkflowFailureDiagnostics(value: unknown): value is WorkflowFailureDiagnostics {
  if (!isTestRecord(value) || typeof value.runId !== "string" || typeof value.workflowName !== "string" || !isTestRunState(value.state) || typeof value.failedAt !== "string" && value.failedAt !== null || !isTestRecord(value.error) || !isTestWorkflowFailureError(value.error) || !Array.isArray(value.completedSiblingPaths) || !value.completedSiblingPaths.every(isTestStringArray) || !isTestRecord(value.artifacts)) return false;
  if (typeof value.artifacts.runDirectory !== "string" || typeof value.artifacts.statePath !== "string" || typeof value.artifacts.journalPath !== "string") return false;
  if (value.failedAgent !== undefined && !isTestFailureAgent(value.failedAgent)) return false;
  if (value.completedSiblingAgents !== undefined && (!Array.isArray(value.completedSiblingAgents) || !value.completedSiblingAgents.every(isTestSiblingAgent))) return false;
  return value.retry === undefined || isTestWorkflowRetry(value.retry);
}

type TestRunStart = { readonly runId: string; readonly parentRunId?: string; readonly state?: string };

function isTestRunStart(value: unknown): value is TestRunStart {
  return isTestRecord(value) && typeof value.runId === "string" && hasOptionalString(value, "parentRunId") && hasOptionalString(value, "state");
}

export function decodeTestRunStart(text: string): TestRunStart {
  return decodeTestJson(text, isTestRunStart);
}

export function decodeTestRunDetails(value: unknown): { readonly runId: string } {
  if (!isTestRecord(value) || typeof value.runId !== "string") throw new Error("Invalid test run details");
  return { runId: value.runId };
}
