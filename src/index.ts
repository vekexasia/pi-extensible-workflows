import { AsyncLocalStorage } from "node:async_hooks";
import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";
import { Script } from "node:vm";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { parseFrontmatter, highlightCode, truncateToVisualLines, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FairAgentScheduler, WorkflowAgentExecutor, type AgentActivity, type AgentAttempt, type AgentContinuationLineage, type AgentContinuationSource, type AgentDefinition, type AgentProgress, type AgentSessionConfig } from "./agent-execution.js";
import { listRunIds, RunStore, structuralPath as operationPath } from "./persistence.js";
import type { AwaitingCheckpoint, PersistedRun, WorktreeReference } from "./persistence.js";

export const RUN_STATES = ["queued", "running", "pausing", "paused", "awaiting_input", "completed", "failed", "stopped", "interrupted"] as const;
export const AGENT_STATES = ["queued", "running", "waiting_for_child", "paused", "retrying", "completed", "failed", "cancelled"] as const;
export const WORKFLOW_ASYNC_STARTED_EVENT = "workflow:async-started";
export const WORKFLOW_ASYNC_COMPLETE_EVENT = "workflow:async-complete";
const SETTLED_AGENT_STATES: ReadonlySet<AgentState> = new Set(["completed", "failed", "cancelled"]);
export const ERROR_CODES = [
  "INVALID_SETTINGS", "INVALID_SYNTAX", "INVALID_METADATA", "DUPLICATE_NAME", "INVALID_SCHEMA",
  "MISSING_EXTENSION", "INCOMPATIBLE_EXTENSION", "UNKNOWN_MODEL", "UNKNOWN_TOOL", "UNKNOWN_AGENT_TYPE",
  "RUN_LIMIT_EXCEEDED", "RPC_LIMIT_EXCEEDED", "AGENT_TIMEOUT", "AGENT_FAILED", "RESULT_INVALID",
  "CANCELLED", "WORKER_UNRESPONSIVE", "WORKTREE_FAILED", "RESUME_INCOMPATIBLE", "INTERNAL_ERROR",
] as const;

export type RunState = (typeof RUN_STATES)[number];
export type AgentState = (typeof AGENT_STATES)[number];
export type WorkflowErrorCode = (typeof ERROR_CODES)[number];
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type JsonSchema = { [key: string]: JsonValue };

export interface WorkflowErrorShape { code: WorkflowErrorCode; message: string }
export interface ModelSpec { provider: string; model: string; thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }
export interface ExtensionRequirement { name: string; version: string }
export interface WorkflowMetadata { name: string; description?: string; extensions?: readonly ExtensionRequirement[] }
export interface WorkflowSettings { concurrency: number; maxAgents: number }
export interface AgentAttemptSummary { attempt: number; sessionId: string; sessionFile: string; error?: { code: string; message: string }; accounting: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }; sessionAccounting?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } }
export interface AgentRecord { id: string; name: string; path: string; state: AgentState; parentId?: string; model: ModelSpec; tools: readonly string[]; attempts: number; attemptDetails?: readonly AgentAttemptSummary[]; accounting?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }; toolCalls?: readonly { id: string; name: string; state: "running" | "completed" | "failed" }[]; activity?: AgentActivity | undefined; sessionConfig?: AgentSessionConfig; continuedFrom?: AgentContinuationLineage }
export interface RunRecord { id: string; workflowName: string; cwd: string; sessionId: string; state: RunState; phase?: string; agents: readonly AgentRecord[]; error?: WorkflowErrorShape }
export interface LaunchSnapshot { script: string; args: JsonValue; metadata: WorkflowMetadata; settings: WorkflowSettings; models: readonly string[]; tools: readonly string[]; agentTypes: readonly string[]; roles?: Readonly<Record<string, AgentDefinition>>; projectRoles?: readonly string[]; extensions: Readonly<Record<string, string>>; schemas: readonly JsonSchema[] }
export interface PreflightCapabilities { models: ReadonlySet<string>; tools: ReadonlySet<string>; agentTypes: ReadonlySet<string>; extensions: Readonly<Record<string, string>> }
export interface PreflightResult { metadata: WorkflowMetadata; referenced: { phases: readonly string[]; models: readonly string[]; tools: readonly string[]; agentTypes: readonly string[] }; schemas: readonly JsonSchema[]; dynamicAgentRoles: boolean }
export interface WorkflowOrchestrationContext {
  agent: (...args: readonly unknown[]) => Promise<JsonValue>;
  parallel: (...args: readonly unknown[]) => Promise<JsonValue>;
  pipeline: (...args: readonly unknown[]) => Promise<JsonValue>;
  checkpoint: (...args: readonly unknown[]) => Promise<boolean>;
  phase: (name: string) => void;
  log: (message: string) => void;
}
export interface WorkflowDslMethod { description: string; input: JsonSchema; output: JsonSchema; run: (input: Readonly<Record<string, JsonValue>>, context: Readonly<WorkflowOrchestrationContext>) => Promise<JsonValue> | JsonValue }
export interface WorkflowScriptDefinition { description: string; script: string; extensions?: readonly ExtensionRequirement[] }
export interface WorkflowDslExtension { name: string; version: string; headline: string; description: string; methods?: Readonly<Record<string, WorkflowDslMethod>>; workflows?: Readonly<Record<string, WorkflowScriptDefinition>> }
export interface WorkflowMacroJournal { get(path: string): JsonValue | undefined; put(path: string, value: JsonValue): void }

export class WorkflowError extends Error {
  constructor(public readonly code: WorkflowErrorCode, message: string) { super(message); this.name = "WorkflowError"; }
}

export class RunLifecycle {
  #state: RunState;
  #active = 0;
  #waiters: Array<() => void> = [];

  constructor(state: RunState = "running", private readonly changed?: (state: RunState) => void | Promise<void>) { this.#state = state; }
  get state(): RunState { return this.#state; }

  async enter(): Promise<void> {
    while (this.#state === "pausing" || this.#state === "paused" || this.#state === "awaiting_input") await new Promise<void>((resolve) => { this.#waiters.push(resolve); });
    if (this.#state !== "running") throw new WorkflowError("CANCELLED", `Run is ${this.#state}`);
    this.#active += 1;
  }

  async leave(): Promise<void> {
    if (this.#active > 0) this.#active -= 1;
    if (this.#state === "pausing" && this.#active === 0) await this.#set("paused");
  }

  async enterAwaitingInput(): Promise<void> {
    while (this.#state === "pausing" || this.#state === "paused") await new Promise<void>((resolve) => { this.#waiters.push(resolve); });
    if (this.#state === "awaiting_input") return;
    if (this.#state !== "running") throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot await input for ${this.#state} run`);
    await this.#set("awaiting_input");
  }

  async resolveAwaitingInput(): Promise<void> {
    if (this.#state !== "awaiting_input") return;
    await this.#set("running");
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async pause(): Promise<void> {
    if (this.#state !== "running") throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot pause ${this.#state} run`);
    await this.#set("pausing");
    if (this.#active === 0) await this.#set("paused");
  }

  async resume(): Promise<void> {
    if (this.#state !== "paused" && this.#state !== "interrupted") throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot resume ${this.#state} run`);
    await this.#set("running");
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async providerPause(): Promise<void> {
    await this.leave();
    if (this.#state === "running") await this.pause();
    await this.enter();
  }

  async terminal(state: "completed" | "failed" | "stopped" | "interrupted"): Promise<void> {
    if (["completed", "failed", "stopped"].includes(this.#state)) throw new WorkflowError("RESUME_INCOMPATIBLE", `${this.#state} runs are terminal`);
    await this.#set(state);
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async #set(state: RunState): Promise<void> { this.#state = state; await this.changed?.(state); }
}

export const DEFAULT_SETTINGS: Readonly<WorkflowSettings> = Object.freeze({ concurrency: 8, maxAgents: 1000 });

function fail(code: WorkflowErrorCode, message: string): never { throw new WorkflowError(code, message); }
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function positiveInteger(value: unknown): value is number { return Number.isInteger(value) && (value as number) > 0; }
export function parseModelReference(value: string): ModelSpec {
  const match = /^([^/:\s]+)\/([^:\s]+)(?::([^:\s]+))?$/.exec(value);
  if (!match?.[1] || !match[2]) fail("UNKNOWN_MODEL", `Invalid model spec: ${value}`);
  const thinking = match[3];
  if (thinking && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) fail("UNKNOWN_MODEL", `Invalid thinking level: ${thinking}`);
  return { provider: match[1], model: match[2], ...(thinking ? { thinking: thinking as NonNullable<ModelSpec["thinking"]> } : {}) };
}

function modelCapability(value: string): string {
  const parsed = parseModelReference(value);
  return `${parsed.provider}/${parsed.model}`;
}

export interface CheckpointInput { name: string; prompt: string; context: JsonValue }
export function validateCheckpoint(value: unknown): CheckpointInput {
  if (!object(value) || Object.keys(value).some((key) => !["name", "prompt", "context"].includes(key)) || typeof value.name !== "string" || value.name.trim() === "" || typeof value.prompt !== "string" || !jsonValue(value.context)) fail("INVALID_METADATA", "checkpoint requires only name, prompt, and JSON context");
  if (Buffer.byteLength(value.prompt) > 1024) fail("INVALID_METADATA", "checkpoint prompt exceeds 1024 UTF-8 bytes");
  if (Buffer.byteLength(JSON.stringify(value.context)) > 4096) fail("INVALID_METADATA", "checkpoint context exceeds 4096 UTF-8 bytes");
  return { name: value.name, prompt: value.prompt, context: value.context };
}

export function loadSettings(path = join(homedir(), ".pi", "workflows", "settings.json")): Readonly<WorkflowSettings> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SETTINGS;
    fail("INVALID_SETTINGS", `Invalid workflow settings: ${(error as Error).message}`);
  }
  if (!object(parsed)) fail("INVALID_SETTINGS", "Workflow settings must be an object");
  const allowed = new Set(["concurrency", "maxAgents"]);
  const unknown = Object.keys(parsed).find((key) => !allowed.has(key));
  if (unknown) fail("INVALID_SETTINGS", `Unknown workflow setting: ${unknown}`);
  const concurrency = parsed.concurrency === undefined ? DEFAULT_SETTINGS.concurrency : parsed.concurrency;
  const maxAgents = parsed.maxAgents === undefined ? DEFAULT_SETTINGS.maxAgents : parsed.maxAgents;
  if (!positiveInteger(concurrency) || concurrency > 16) fail("INVALID_SETTINGS", "concurrency must be an integer from 1 to 16");
  if (!positiveInteger(maxAgents)) fail("INVALID_SETTINGS", "maxAgents must be a positive integer");
  return Object.freeze({ concurrency, maxAgents });
}

export function parseRoleMarkdown(content: string, strict = false): AgentDefinition {
  if (!strict) {
    if (!content.startsWith("---\n")) return { prompt: content };
    const end = content.indexOf("\n---", 4);
    if (end < 0) return { prompt: content };
    const meta: Record<string, string> = {};
    for (const line of content.slice(4, end).split("\n")) {
      const match = /^(model|thinking|tools|description)\s*:\s*(.+)$/.exec(line.trim());
      if (match?.[1] && match[2]) meta[match[1]] = match[2].trim();
    }
    const tools = meta.tools ? meta.tools.replace(/^\[|\]$/g, "").split(",").map((tool) => tool.trim().replace(/^[']|[']$/g, "").replace(/^["]|["]$/g, "")).filter(Boolean) : undefined;
    const thinking = meta.thinking?.replace(/^[']|[']$/g, "").replace(/^["]|["]$/g, "");
    if (thinking && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) fail("INVALID_METADATA", `Invalid role thinking level: ${thinking}`);
    const definition: AgentDefinition = { prompt: content.slice(end + 4).replace(/^\n/, "") };
    if (meta.model) definition.model = meta.model.replace(/^[']|[']$/g, "").replace(/^["]|["]$/g, "");
    if (meta.description) definition.description = meta.description.replace(/^[']|[']$/g, "").replace(/^["]|["]$/g, "");
    if (thinking) definition.thinking = thinking as NonNullable<AgentDefinition["thinking"]>;
    if (tools) definition.tools = tools;
    return definition;
  }
  const normalized = content.replace(/\r\n?/g, "\n");
  if (normalized.startsWith("---\n") && normalized.indexOf("\n---", 3) < 0) fail("INVALID_METADATA", "Role frontmatter is missing its closing delimiter");
  let parsed: ReturnType<typeof parseFrontmatter>;
  try { parsed = parseFrontmatter(content); }
  catch (error) { fail("INVALID_METADATA", `Invalid role frontmatter: ${(error as Error).message}`); }
  if (!object(parsed.frontmatter)) fail("INVALID_METADATA", "Role frontmatter must be an object");
  const { model, thinking, tools, description } = parsed.frontmatter;
  if (model !== undefined && (typeof model !== "string" || model.trim() === "")) fail("INVALID_METADATA", "Role model must be a non-empty string");
  if (thinking !== undefined && (typeof thinking !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking))) fail("INVALID_METADATA", `Invalid role thinking level: ${typeof thinking === "string" ? thinking : typeof thinking}`);
  if (description !== undefined && (typeof description !== "string" || description.trim() === "" || description.length > 1024 || /[\r\n]/.test(description))) fail("INVALID_METADATA", "Role description must be a non-empty single-line string of at most 1024 characters");
  if (tools !== undefined && (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || tool.trim() === ""))) fail("INVALID_METADATA", "Role tools must be an array of non-empty strings");
  return { prompt: parsed.body, ...(typeof description === "string" ? { description: description.trim() } : {}), ...(typeof model === "string" ? { model: model.trim() } : {}), ...(typeof thinking === "string" ? { thinking: thinking as NonNullable<AgentDefinition["thinking"]> } : {}), ...(Array.isArray(tools) ? { tools: tools.map((tool) => (tool as string).trim()) } : {}) };
}

function readAgentDefinitions(dir: string): Record<string, AgentDefinition> {
  try {
    return Object.fromEntries(readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name) === ".md")
      .map((entry) => [basename(entry.name, ".md"), parseRoleMarkdown(readFileSync(join(dir, entry.name), "utf8"), true)]));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export function loadAgentDefinitions(cwd: string, piHome = join(homedir(), ".pi"), projectTrusted = true): Readonly<Record<string, AgentDefinition>> {
  return deepFreeze({ ...readAgentDefinitions(join(piHome, "piworkflows", "roles")), ...(projectTrusted ? readAgentDefinitions(join(cwd, ".pi", "piworkflows", "roles")) : {}) });
}
function validateRolePolicies(definitions: Readonly<Record<string, AgentDefinition>>, roles: readonly string[], availableModels: ReadonlySet<string>, rootTools: ReadonlySet<string>): void {
  for (const role of roles) {
    const definition = definitions[role];
    if (!definition) continue;
    if (definition.model !== undefined && !availableModels.has(modelCapability(definition.model))) fail("UNKNOWN_MODEL", `Unknown model for role ${role}: ${definition.model}`);
    const missingTool = (definition.tools ?? [...rootTools]).find((tool) => !rootTools.has(tool));
    if (missingTool) fail("UNKNOWN_TOOL", `Unknown tool for role ${role}: ${missingTool}`);
  }
}

function extensionRequirements(value: unknown): readonly ExtensionRequirement[] {
  const extensions = value ?? [];
  if (!Array.isArray(extensions) || extensions.some((item: unknown) => !object(item) || typeof item.name !== "string" || item.name.trim() === "" || typeof item.version !== "string" || item.version.trim() === "" || Object.keys(item).some((key) => key !== "name" && key !== "version"))) fail("INVALID_METADATA", "extensions must contain name/version objects");
  const valid = extensions as Array<{ name: string; version: string }>;
  if (new Set(valid.map(({ name }) => name)).size !== valid.length) fail("DUPLICATE_NAME", "Workflow extension requirements must be unique");
  return Object.freeze(valid.map(({ name, version }) => Object.freeze({ name: name.trim(), version: version.trim() })));
}

function validateWorkflowMetadata(value: unknown): WorkflowMetadata {
  if (!object(value) || typeof value.name !== "string" || value.name.trim() === "") fail("INVALID_METADATA", "Workflow metadata requires a non-empty name");
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.trim() === "")) fail("INVALID_METADATA", "Workflow description must be a non-empty string when provided");
  if (Object.keys(value).some((key) => !["name", "description", "extensions"].includes(key))) fail("INVALID_METADATA", "Unknown workflow metadata");
  return Object.freeze({ name: value.name.trim(), ...(typeof value.description === "string" ? { description: value.description.trim() } : {}), extensions: extensionRequirements(value.extensions) });
}

function workflowBody(script: string): string {
  if (typeof script !== "string" || script.trim() === "") fail("INVALID_SYNTAX", "Workflow script must be non-empty");
  try {
    const program = acorn.parse(script, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true });
    const first = program.body[0];
    if (first?.type === "ExportNamedDeclaration" && first.declaration?.type === "VariableDeclaration") {
      const declarator = first.declaration.declarations[0];
      if (declarator?.id.type === "Identifier" && declarator.id.name === "meta") return script.slice(first.end).replace(/^\s*/, "");
    }
    return script;
  } catch (error) { fail("INVALID_SYNTAX", `Invalid workflow syntax: ${(error as Error).message}`); }
}

function parseWorkflow(script: string): acorn.Program {
  const body = workflowBody(script);
  try {
    new Script(`(async()=>{${body}\n})`);
    return acorn.parse(body, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true });
  } catch (error) { fail("INVALID_SYNTAX", `Invalid workflow syntax: ${(error as Error).message}`); }
}

type WorkflowCall = acorn.CallExpression & { callee: acorn.Identifier };

function astNode(value: unknown): value is acorn.AnyNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}
function workflowCalls(program: acorn.Program): WorkflowCall[] {
  const calls: WorkflowCall[] = [];
  const visit = (node: acorn.AnyNode): void => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && ["agent", "parallel", "pipeline", "checkpoint", "phase"].includes(node.callee.name)) calls.push(node as WorkflowCall);
    for (const value of Object.values(node) as unknown[]) {
      if (Array.isArray(value)) {
        for (const child of value as unknown[]) if (astNode(child)) visit(child);
      } else if (astNode(value)) visit(value);
    }
  };
  visit(program);
  return calls.sort((left, right) => left.start - right.start);
}

function literalString(node: acorn.AnyNode | undefined): string | undefined {
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function propertyNode(node: acorn.AnyNode | undefined, name: string): acorn.AnyNode | undefined {
  if (node?.type !== "ObjectExpression") return undefined;
  for (let index = node.properties.length - 1; index >= 0; index -= 1) {
    const property = node.properties[index];
    if (!property || property.type === "SpreadElement" || property.computed) return undefined;
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
    if (key === name) return property.value;
  }
  return undefined;
}

function stableName(node: acorn.AnyNode | undefined): boolean | undefined {
  if (!node) return false;
  if (node.type !== "ObjectExpression") {
    if (["Literal", "ArrayExpression", "ArrowFunctionExpression", "FunctionExpression", "ClassExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "BinaryExpression"].includes(node.type)) return false;
    return undefined;
  }
  let result: boolean | undefined = false;
  for (const property of node.properties) {
    if (property.type === "SpreadElement" || property.computed) { result = undefined; continue; }
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
    if (key !== "name") continue;
    const value = literalString(property.value);
    result = value === undefined ? property.value.type === "Literal" ? false : undefined : value.trim() !== "";
  }
  return result;
}

function inheritedAgentRanges(program: acorn.Program): Array<readonly [number, number]> {
  const ranges: Array<readonly [number, number]> = [];
  for (const call of workflowCalls(program)) {
    const record = call.callee.name === "parallel" ? call.arguments[1] : call.callee.name === "pipeline" ? call.arguments[2] : undefined;
    if (record?.type !== "ObjectExpression") continue;
    for (const property of record.properties) {
      if (property.type === "Property" && (property.value.type === "ArrowFunctionExpression" || property.value.type === "FunctionExpression")) ranges.push([property.value.start, property.value.end]);
    }
  }
  return ranges;
}

function jsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  seen.add(value);
  const values = Array.isArray(value) ? Array.from(value) : keys.map((key) => (value as Record<string, unknown>)[key as string]);
  const valid = values.every((item) => jsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function validateSchema(schema: unknown, at = "schema"): asserts schema is JsonSchema {
  if (!object(schema) || Object.getPrototypeOf(schema) !== Object.prototype || !jsonValue(schema)) fail("INVALID_SCHEMA", `${at} must be a plain JSON-compatible Schema object`);
  if (typeof schema.type !== "string" && !Array.isArray(schema.type) && schema.$ref === undefined && schema.anyOf === undefined && schema.oneOf === undefined && schema.allOf === undefined && schema.const === undefined && schema.enum === undefined) fail("INVALID_SCHEMA", `${at} has no JSON Schema shape`);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) fail("INVALID_SCHEMA", `${at}.required must be an array of strings`);
  if (schema.properties !== undefined && !object(schema.properties)) fail("INVALID_SCHEMA", `${at}.properties must be an object`);
}

const AGENT_OPTION_KEYS = new Set(["name", "model", "thinking", "tools", "role", "outputSchema", "continueFrom", "retries", "timeoutMs", "isolation"]);

function validateAgentOption(key: string, value: unknown): void {
  switch (key) {
    case "name":
      if (typeof value !== "string" || !value.trim()) fail("INVALID_METADATA", "agent requires a stable explicit name");
      break;
    case "model":
      if (typeof value !== "string") fail("INVALID_METADATA", "agent model must be a string");
      parseModelReference(value);
      break;
    case "thinking":
      if (typeof value !== "string" || !parseThinking(value)) fail("INVALID_METADATA", "agent thinking must be off, minimal, low, medium, high, xhigh, or max");
      break;
    case "tools":
      if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string")) fail("INVALID_METADATA", "agent tools must be an array of strings");
      break;
    case "role":
      if (typeof value !== "string" || !value.trim()) fail("INVALID_METADATA", "agent role must be a non-empty string");
      break;
    case "outputSchema":
      validateSchema(value, "agent outputSchema");
      break;
    case "continueFrom":
      if (typeof value !== "string" || !value.trim()) fail("INVALID_METADATA", "agent continueFrom must be a non-empty string");
      break;
    case "retries":
      if (!Number.isInteger(value) || (value as number) < 0) fail("INVALID_METADATA", "agent retries must be a non-negative integer");
      break;
    case "timeoutMs":
      if (value !== null && !positiveInteger(value)) fail("INVALID_METADATA", "agent timeoutMs must be null or a positive integer");
      break;
    case "isolation":
      if (value !== "worktree") fail("INVALID_METADATA", "agent isolation must be worktree");
      break;
  }
}

function validateAgentOptions(value: unknown, requireName = true): Readonly<Record<string, JsonValue>> {
  if (!object(value) || !jsonValue(value)) fail("INVALID_METADATA", "agent options must be a JSON object");
  const unknown = Object.keys(value).find((key) => !AGENT_OPTION_KEYS.has(key));
  if (unknown) fail("INVALID_METADATA", `Unknown agent option: ${unknown}`);
  if (requireName && value.name === undefined) fail("INVALID_METADATA", "agent requires a stable explicit name");
  for (const [key, option] of Object.entries(value)) validateAgentOption(key, option);
  return value;
}

type StaticValue = { known: true; value: unknown } | { known: false };

function staticValue(node: acorn.AnyNode | undefined): StaticValue {
  if (!node) return { known: false };
  if (node.type === "Literal") return { known: true, value: node.value };
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    const argument = staticValue(node.argument);
    return argument.known && typeof argument.value === "number" ? { known: true, value: node.operator === "-" ? -argument.value : argument.value } : { known: false };
  }
  if (node.type === "ArrayExpression") {
    const values: unknown[] = [];
    for (const element of node.elements) {
      if (!element || element.type === "SpreadElement") return { known: false };
      const value = staticValue(element);
      if (!value.known) return { known: false };
      values.push(value.value);
    }
    return { known: true, value: values };
  }
  if (node.type === "ObjectExpression") {
    const value: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (property.type === "SpreadElement" || property.computed) return { known: false };
      const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
      const child = staticValue(property.value);
      if (!key || !child.known) return { known: false };
      value[key] = child.value;
    }
    return { known: true, value };
  }
  return { known: false };
}

function validateStaticAgentOptions(node: acorn.AnyNode | undefined): void {
  if (node?.type !== "ObjectExpression") return;
  for (const property of node.properties) {
    if (property.type === "SpreadElement" || property.computed) continue;
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
    if (key && !AGENT_OPTION_KEYS.has(key)) fail("INVALID_METADATA", `Unknown agent option: ${key}`);
  }
  for (const key of AGENT_OPTION_KEYS) {
    const value = staticValue(propertyNode(node, key));
    if (value.known) validateAgentOption(key, value.value);
  }
}

export class WorkflowDslRegistry {
  readonly #extensions = new Map<string, Readonly<WorkflowDslExtension>>();

  register(extension: WorkflowDslExtension): void {
    if (!object(extension) || !/^[A-Za-z_$][\w$]*$/.test(extension.name) || !/^\d+\.\d+\.\d+$/.test(extension.version) || !extension.headline.trim() || !extension.description.trim()) fail("INVALID_METADATA", "Workflow DSL extensions require a name, semantic version, headline, and description");
    const methods = extension.methods ?? {};
    const workflows = extension.workflows ?? {};
    if (!object(methods) || !object(workflows) || (Object.keys(methods).length === 0 && Object.keys(workflows).length === 0)) fail("INVALID_METADATA", "Workflow DSL extensions require methods or workflows");
    if (this.#extensions.has(extension.name)) fail("DUPLICATE_NAME", `Workflow DSL extension already registered: ${extension.name}`);
    for (const [name, method] of Object.entries(methods)) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name) || !object(method) || typeof method.description !== "string" || method.description.trim() === "" || typeof method.run !== "function") fail("INVALID_METADATA", `Invalid workflow DSL method: ${extension.name}.${name}`);
      validateSchema(method.input, `${extension.name}.${name} input`);
      validateSchema(method.output, `${extension.name}.${name} output`);
      if (method.input.type !== "object") fail("INVALID_SCHEMA", `${extension.name}.${name} input must describe one object`);
    }
    for (const [name, workflow] of Object.entries(workflows)) {
      if (!/^[A-Za-z0-9][\w.-]*$/.test(name) || !object(workflow) || typeof workflow.description !== "string" || workflow.description.trim() === "" || typeof workflow.script !== "string" || workflow.script.trim() === "") fail("INVALID_METADATA", `Invalid workflow script: ${extension.name}.${name}`);
      parseWorkflow(workflow.script);
      extensionRequirements(workflow.extensions);
    }
    this.#extensions.set(extension.name, deepFreeze({ ...extension, methods, workflows }));
  }

  workflows(): Readonly<Record<string, WorkflowScriptDefinition>> {
    return Object.freeze(Object.fromEntries([...this.#extensions].flatMap(([extensionName, extension]) => Object.entries(extension.workflows ?? {}).map(([name, workflow]) => [`${extensionName}.${name}`, workflow]))));
  }

  workflow(name: string): WorkflowScriptDefinition {
    const workflow = this.workflows()[name];
    if (!workflow) fail("MISSING_EXTENSION", `Workflow script is unavailable: ${name}`);
    return workflow;
  }

  versions(): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries([...this.#extensions].map(([name, extension]) => [name, extension.version])));
  }

  namespaces(): Readonly<Record<string, Readonly<Record<string, WorkflowDslMethod>>>> {
    return Object.freeze(Object.fromEntries([...this.#extensions].map(([name, extension]) => [name, extension.methods ?? {}])));
  }

  async invoke(extensionName: string, methodName: string, input: unknown, context: WorkflowOrchestrationContext, path: string, journal: WorkflowMacroJournal): Promise<JsonValue> {
    const extension = this.#extensions.get(extensionName);
    const method = extension?.methods?.[methodName];
    if (!method) fail("MISSING_EXTENSION", `Workflow DSL method is unavailable: ${extensionName}.${methodName}`);
    if (!object(input) || !jsonValue(input) || !Value.Check(method.input, input)) fail("RESULT_INVALID", `Invalid input for ${extensionName}.${methodName}`);
    const replayed = journal.get(path);
    if (replayed !== undefined) {
      if (!jsonValue(replayed) || !Value.Check(method.output, replayed)) fail("RESULT_INVALID", `Invalid replay for ${extensionName}.${methodName}`);
      return structuredClone(replayed);
    }
    const publicContext = Object.freeze({ agent: context.agent, parallel: context.parallel, pipeline: context.pipeline, checkpoint: context.checkpoint, phase: context.phase, log: context.log });
    const result: unknown = await method.run(deepFreeze(structuredClone(input)), publicContext);
    if (!jsonValue(result) || !Value.Check(method.output, result)) fail("RESULT_INVALID", `Invalid output from ${extensionName}.${methodName}`);
    const stored = structuredClone(result);
    journal.put(path, stored);
    return structuredClone(stored);
  }
}

export const workflowDslRegistry = new WorkflowDslRegistry();
export function registerWorkflowDslExtension(extension: WorkflowDslExtension): void { workflowDslRegistry.register(extension); }

function versionCompatible(required: string, actual: string): boolean {
  const parse = (version: string) => /^(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number);
  const installed = parse(actual);
  if (!installed) return false;
  if (/^\d+\.x$/.test(required)) return installed[0] === Number(required.split(".")[0]);
  const wanted = parse(required.startsWith("^") ? required.slice(1) : required);
  if (!wanted) return false;
  if (!required.startsWith("^")) return installed.every((part, index) => part === wanted[index]);
  const compare = (left: number[], right: number[]) => left.findIndex((part, index) => part !== right[index]);
  const changed = compare(installed, wanted);
  if (changed >= 0 && (installed[changed] ?? 0) < (wanted[changed] ?? 0)) return false;
  const [major = 0, minor = 0, patch = 0] = wanted;
  const upper = major ? [major + 1, 0, 0] : minor ? [0, minor + 1, 0] : [0, 0, patch + 1];
  const upperChanged = compare(installed, upper);
  return upperChanged >= 0 && (installed[upperChanged] ?? 0) < (upper[upperChanged] ?? 0);
}

export function formatWorkflowPreview(args: { script?: unknown; workflow?: unknown; name?: unknown; description?: unknown }): string {
  const name = typeof args.name === "string" && args.name.trim() ? args.name.trim() : typeof args.workflow === "string" && args.workflow.trim() ? args.workflow : "workflow";
  if (typeof args.script !== "string" || !args.script.trim()) return `workflow ${name}${typeof args.workflow === "string" ? "\nRegistered workflow" : ""}`;
  return [`workflow ${name}`, typeof args.description === "string" && args.description.trim() ? args.description.trim() : ""].filter(Boolean).join("\n");
}

function hasDynamicAgentRole(node: acorn.AnyNode | undefined): boolean {
  if (!node) return false;
  if (node.type !== "ObjectExpression") return true;
  for (let index = node.properties.length - 1; index >= 0; index -= 1) {
    const property = node.properties[index];
    if (!property || property.type === "SpreadElement" || property.computed) return true;
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
    if (key === "role") return literalString(property.value) === undefined;
  }
  return false;
}

export function preflight(script: string, capabilities: PreflightCapabilities, schemas: readonly unknown[] = [], metadata: WorkflowMetadata = { name: "workflow" }): PreflightResult {
  const checkedMetadata = validateWorkflowMetadata(metadata);
  const program = parseWorkflow(script);
  for (const [index, schema] of schemas.entries()) validateSchema(schema, `schema[${String(index)}]`);
  const calls = workflowCalls(program);
  const inheritedRanges = inheritedAgentRanges(program);
  const phases = calls.filter((call) => call.callee.name === "phase").map((call) => literalString(call.arguments[0])).filter((phase): phase is string => phase !== undefined);
  for (const call of calls) {
    const operation = call.callee.name;
    if (operation === "agent") validateStaticAgentOptions(call.arguments[1]);
    if ((operation === "parallel" || operation === "pipeline") && call.arguments.some((argument) => argument.type === "SpreadElement")) continue;
    const inheritsName = operation === "agent" && inheritedRanges.some(([start, end]) => call.start >= start && call.end <= end);
    if ((operation === "agent" && !inheritsName && stableName(call.arguments[1]) === false) || (operation === "checkpoint" && stableName(call.arguments[0]) === false)) fail("INVALID_METADATA", `${operation} requires a stable explicit name`);
    if (operation === "parallel" && (call.arguments.length !== 2 || !literalString(call.arguments[0])?.trim() || call.arguments[1]?.type !== "ObjectExpression")) fail("INVALID_METADATA", "parallel requires an operation name string and tasks record");
    if (operation === "pipeline" && (call.arguments.length !== 3 || !literalString(call.arguments[0])?.trim() || call.arguments[1]?.type !== "ObjectExpression" || call.arguments[2]?.type !== "ObjectExpression")) fail("INVALID_METADATA", "pipeline requires an operation name string, items record, and stages record");
  }
  const agentCalls = calls.filter((call) => call.callee.name === "agent");
  const dynamicAgentRoles = agentCalls.some((call) => hasDynamicAgentRole(call.arguments[1]));
  const staticSchemas = agentCalls.flatMap((call) => { const value = staticValue(propertyNode(call.arguments[1], "outputSchema")); return value.known ? [value.value] : []; });
  for (const [index, schema] of staticSchemas.entries()) validateSchema(schema, `agent outputSchema[${String(index)}]`);
  const checkedSchemas = [...schemas, ...staticSchemas];
  const models = agentCalls.flatMap((call) => { const value = literalString(propertyNode(call.arguments[1], "model")); return value === undefined ? [] : [modelCapability(value)]; });
  const tools = agentCalls.flatMap((call) => {
    const value = propertyNode(call.arguments[1], "tools");
    return value?.type === "ArrayExpression" ? value.elements.flatMap((element) => { const tool = element && element.type !== "SpreadElement" ? literalString(element) : undefined; return tool === undefined ? [] : [tool]; }) : [];
  });
  const agentTypes = agentCalls.flatMap((call) => { const value = literalString(propertyNode(call.arguments[1], "role")); return value === undefined ? [] : [value]; });
  const missingModel = models.find((model) => !capabilities.models.has(model));
  if (missingModel) fail("UNKNOWN_MODEL", `Unknown model: ${missingModel}`);
  const missingTool = tools.find((tool) => !capabilities.tools.has(tool));
  if (missingTool) fail("UNKNOWN_TOOL", `Unknown tool: ${missingTool}`);
  const missingType = agentTypes.find((type) => !capabilities.agentTypes.has(type));
  if (missingType) fail("UNKNOWN_AGENT_TYPE", `Unknown agent type: ${missingType}`);
  for (const requirement of checkedMetadata.extensions ?? []) {
    const actual = capabilities.extensions[requirement.name];
    if (!actual) fail("MISSING_EXTENSION", `Required extension is unavailable: ${requirement.name}`);
    if (!versionCompatible(requirement.version, actual)) fail("INCOMPATIBLE_EXTENSION", `Extension ${requirement.name} requires ${requirement.version}, found ${actual}`);
  }
  return Object.freeze({ metadata: deepFreeze(checkedMetadata), referenced: deepFreeze({ phases, models, tools, agentTypes }), schemas: deepFreeze(checkedSchemas) as readonly JsonSchema[], dynamicAgentRoles });
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export function createLaunchSnapshot(input: LaunchSnapshot): Readonly<LaunchSnapshot> {
  return deepFreeze(structuredClone(input));
}

export const RPC_LIMIT_BYTES = 10 * 1024 * 1024;
export const HEARTBEAT_TIMEOUT_MS = 5000;

export interface WorkflowBridge {
  agent?: (prompt: string, options: Readonly<Record<string, JsonValue>>, signal: AbortSignal, structuralName?: string) => Promise<JsonValue>;
  checkpoint?: (input: Readonly<Record<string, JsonValue>>, signal: AbortSignal) => boolean | Promise<boolean>;
  extension?: (extension: string, method: string, input: Readonly<Record<string, JsonValue>>, path: string, signal: AbortSignal) => Promise<JsonValue>;
  extensions?: Readonly<Record<string, readonly string[]>>;
  phase?: (name: string) => void | Promise<void>;
  log?: (message: string) => void | Promise<void>;
}

export interface WorkflowExecution { result: Promise<JsonValue>; cancel: () => void }

const OUTCOME_ERRORS = new Set<string>(["AGENT_TIMEOUT", "AGENT_FAILED", "RESULT_INVALID"]);
const WORK_RESULT_BRAND = "__workResult";

const childSource = String.raw`
"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const vm = require("node:vm");
const LIMIT = parseInt(process.argv[2], 10);
const config = JSON.parse(process.argv[3]);
for (const key of ["getBuiltinModule","binding","_linkedBinding","dlopen","kill","abort","exit","reallyExit","_kill","umask","chdir","setuid","setgid","seteuid","setegid","setgroups","initgroups"]) {
  if (key in process) process[key] = undefined;
}
let nextId = 0;
let cancelled = false;
const pending = new Map();
const inflight = new Set();
function send(value) {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > LIMIT) throw Object.assign(new Error("RPC value exceeds the 10 MB JSON boundary"), { code: "RPC_LIMIT_EXCEEDED" });
  process.send(json);
}
function rpc(method, args) {
  if (cancelled) throw Object.assign(new Error("Workflow cancelled"), { code: "CANCELLED" });
  const id = ++nextId;
  send({ type: "rpc", id, method, args });
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  inflight.add(promise);
  void promise.then(() => inflight.delete(promise), () => inflight.delete(promise));
  return promise;
}
process.on("message", raw => {
  let message;
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > LIMIT) throw Object.assign(new Error("RPC value exceeds the 10 MB JSON boundary"), { code: "RPC_LIMIT_EXCEEDED" });
    message = JSON.parse(raw);
  } catch (error) { send({ type: "error", error: { code: error.code || "INTERNAL_ERROR", message: error.message } }); return; }
  if (message.type === "cancel") { cancelled = true; for (const { reject } of pending.values()) reject(Object.assign(new Error("Workflow cancelled"), { code: "CANCELLED" })); pending.clear(); return; }
  if (message.type !== "rpcResult") return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.ok) request.resolve(message.value);
  else request.reject(Object.assign(new Error(message.error.message), { code: message.error.code }));
});
const heartbeat = setInterval(() => send({ type: "heartbeat" }), 1000);
send({ type: "heartbeat" });
const BRAND = "${WORK_RESULT_BRAND}";
const workError = (code, message) => Object.assign(new Error(message), { code });
const isBranded = value => value && typeof value === "object" && value[BRAND] === true;
const unwrap = result => {
  if (!isBranded(result)) return result;
  if (result.ok) return result.value;
  throw Object.assign(new Error(result.error.message), { code: result.error.code, failedAt: result.failedAt });
};
const named = (value, kind) => { if (typeof value !== "string" || !value.trim()) throw workError("INVALID_METADATA", kind + " requires a stable explicit name"); return value; };
const path = (...names) => names.map(encodeURIComponent).join("/");
const inheritedAgentPath = new AsyncLocalStorage();
const agent = (prompt, options = {}) => {
  if (!options || typeof options !== "object" || Array.isArray(options)) throw workError("INVALID_METADATA", "agent options must be an object");
  const inherited = inheritedAgentPath.getStore();
  const explicitName = options.name;
  const name = named(explicitName === undefined && inherited ? inherited.at(-1) : explicitName, "agent");
  const structuralName = explicitName === undefined && inherited ? path(...inherited) : name;
  const result = rpc("agent", [prompt, { ...options, name }, structuralName]).then(unwrap);
  Object.defineProperties(result, {
    toJSON: { value() { throw workError("INVALID_METADATA", "Workflow agent result is a Promise; await it before serialization"); } },
    toString: { value() { throw workError("INVALID_METADATA", "Workflow agent result is a Promise; await it before interpolation"); } },
    [Symbol.toPrimitive]: { value() { throw workError("INVALID_METADATA", "Workflow agent result is a Promise; await it before interpolation"); } },
  });
  return result;
};
const promptPath = (at, key) => /^[A-Za-z_$][\w$]*$/.test(key) ? at + "." + key : at + "[" + JSON.stringify(key) + "]";
const plainPromptObject = value => {
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null && Object.prototype.hasOwnProperty.call(proto, "constructor") && typeof proto.constructor === "function" && Function.prototype.toString.call(proto.constructor) === Function.prototype.toString.call(Object);
};
const promptValue = (value, at, seen) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" must be a finite number"); return; }
  if (typeof value !== "object") throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" cannot be " + typeof value);
  if (typeof value.then === "function") throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" is a Promise or thenable; await it before calling prompt()");
  if (!Array.isArray(value) && !plainPromptObject(value)) throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" must be a plain object");
  if (seen.has(value)) throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" contains a cycle");
  const keys = Reflect.ownKeys(value);
  const symbol = keys.find(key => typeof key === "symbol");
  if (symbol) throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" contains a symbol key");
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) promptProperty(value, String(index), at + "[" + index + "]", seen);
    for (const key of keys) {
      const index = Number(key);
      if (key !== "length" && !(Number.isInteger(index) && index >= 0 && index < value.length && String(index) === key)) promptProperty(value, key, promptPath(at, key), seen);
    }
  } else for (const key of keys) promptProperty(value, key, promptPath(at, key), seen);
  seen.delete(value);
};
const promptProperty = (value, key, at, seen) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && (descriptor.get || descriptor.set)) throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" cannot use getters or setters");
  promptValue(descriptor && descriptor.value, at, seen);
};
const prompt = (template, values) => {
  if (typeof template !== "string") throw workError("INVALID_METADATA", "prompt() template must be a string");
  if (!values || typeof values !== "object" || Array.isArray(values) || !plainPromptObject(values)) throw workError("INVALID_METADATA", "prompt() values must be a plain object");
  const placeholders = [...template.matchAll(/{{|}}|{([A-Za-z_$][\w$]*)}/g)].flatMap(match => match[1] === undefined ? [] : [match[1]]);
  const used = new Set(placeholders);
  const keys = Reflect.ownKeys(values);
  const symbol = keys.find(key => typeof key === "symbol");
  if (symbol) throw workError("INVALID_METADATA", "prompt() values must use string keys");
  const missing = placeholders.find(key => !Object.prototype.hasOwnProperty.call(values, key));
  if (missing) throw workError("INVALID_METADATA", "Missing prompt value \"" + missing + "\"");
  const unused = keys.find(key => !used.has(key));
  if (unused !== undefined) throw workError("INVALID_METADATA", "Unused prompt value \"" + unused + "\"");
  for (const key of keys) promptProperty(values, key, key, new Set());
  return template.replace(/{{|}}|{([A-Za-z_$][\w$]*)}/g, (match, key) => match === "{{" ? "{" : match === "}}" ? "}" : typeof values[key] === "string" ? values[key] : JSON.stringify(values[key], null, 2));
};
const checkpoint = input => rpc("checkpoint", [input]).then(unwrap);
const phase = name => rpc("phase", [name]);
const log = message => rpc("log", [message]);
const extensionOccurrences = new Map();
const extensionPath = (extension, method) => {
  const key = path(extension, method);
  const occurrence = (extensionOccurrences.get(key) || 0) + 1;
  extensionOccurrences.set(key, occurrence);
  return occurrence === 1 ? path("extension", extension, method) : path("extension", extension, method, String(occurrence));
};
const extensions = Object.freeze(Object.fromEntries(Object.entries(config.extensions).map(([extension, methods]) => [extension, Object.freeze(Object.fromEntries(methods.map(method => [method, input => rpc("extension", [extension, method, input, extensionPath(extension, method)]).then(unwrap)])))])));
const recordEntries = (value, kind) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw workError("INVALID_METADATA", kind + " must be a record");
  return Object.entries(value);
};
const parallel = async (operationName, tasks) => {
  named(operationName, "parallel");
  const entries = recordEntries(tasks, "parallel tasks");
  for (const [name, run] of entries) {
    named(name, "parallel task");
    if (typeof run !== "function") throw workError("INVALID_METADATA", "parallel task values must be run functions");
  }
  const results = await Promise.all(entries.map(async ([name, run]) => {
    try {
      const parent = inheritedAgentPath.getStore() || [];
      return { name, ok: true, value: await inheritedAgentPath.run([...parent, operationName, name], run) };
    } catch (error) {
      if (error.code === "CANCELLED") throw error;
      return { name, ok: false, failedAt: error.failedAt ? path(operationName, name, error.failedAt) : path(operationName, name), error: { code: error.code || "INTERNAL_ERROR", message: error.message } };
    }
  }));
  const failure = results.find(result => !result.ok);
  if (failure) throw Object.assign(new Error(failure.error.message), { code: failure.error.code, failedAt: failure.failedAt });
  return Object.fromEntries(results.map(result => [result.name, result.value]));
};
const pipeline = async (operationName, items, stages) => {
  named(operationName, "pipeline");
  const itemEntries = recordEntries(items, "pipeline items");
  const stageEntries = recordEntries(stages, "pipeline stages");
  if (!stageEntries.length) throw workError("INVALID_METADATA", "pipeline requires at least one stage");
  for (const [name] of itemEntries) named(name, "pipeline item");
  for (const [stageName, run] of stageEntries) {
    named(stageName, "pipeline stage");
    if (typeof run !== "function") throw workError("INVALID_METADATA", "pipeline stage values must be run functions");
  }
  const results = await Promise.all(itemEntries.map(async ([name, initial]) => {
    let value = initial;
    let failedAt = path(operationName, name);
    try {
      for (const [stageName, run] of stageEntries) {
        failedAt = path(operationName, name, stageName);
        const parent = inheritedAgentPath.getStore() || [];
        value = await inheritedAgentPath.run([...parent, operationName, name, stageName], () => run(value));
      }
      return { name, ok: true, value };
    } catch (error) {
      if (error.code === "CANCELLED") throw error;
      return { name, ok: false, failedAt: error.failedAt ? path(failedAt, error.failedAt) : failedAt, error: { code: error.code || "INTERNAL_ERROR", message: error.message } };
    }
  }));
  const failure = results.find(result => !result.ok);
  if (failure) throw Object.assign(new Error(failure.error.message), { code: failure.error.code, failedAt: failure.failedAt });
  return Object.fromEntries(results.map(result => [result.name, result.value]));
};
const safeMath = Object.fromEntries(Object.getOwnPropertyNames(Math).filter(name => name !== "random").map(name => [name, Math[name]]));
const sandbox = { agent, prompt, checkpoint, parallel, pipeline, phase, log, extensions, args: config.args, Promise, JSON, Math: Object.freeze(safeMath) };
for (const name of ["Date","eval","Function","WebAssembly","process","require","module","exports","console","fetch","XMLHttpRequest","WebSocket","performance","crypto","setTimeout","setInterval","setImmediate","queueMicrotask","Intl","SharedArrayBuffer","Atomics"]) sandbox[name] = undefined;
const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
const body = config.script;
Promise.resolve().then(() => new vm.Script("(async()=>{" + body + "\n})()", { filename: "workflow.js" }).runInContext(context))
  .then(async value => { await Promise.all(inflight); send({ type: "result", value: value === undefined ? null : value }); })
  .catch(error => send({ type: "error", error: { code: error.code || "INTERNAL_ERROR", message: error.message } }))
  .finally(() => clearInterval(heartbeat));
`;

function encoded(value: unknown): string {
  if (!jsonValue(value)) fail("RPC_LIMIT_EXCEEDED", "RPC values must be JSON-compatible");
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > RPC_LIMIT_BYTES) fail("RPC_LIMIT_EXCEEDED", "RPC value exceeds the 10 MB JSON boundary");
  return json;
}

export function runWorkflow(script: string, args: JsonValue = null, bridge: WorkflowBridge = {}, signal?: AbortSignal): WorkflowExecution {
  encoded(args);
  const body = workflowBody(script);
  const config = JSON.stringify({ script: body, args: structuredClone(args), extensions: bridge.extensions ?? {} });
  const childDir = mkdtempSync(join(tmpdir(), "pi-wf-"));
  const childFile = join(childDir, "child.cjs");
  writeFileSync(childFile, childSource);
  const child: ChildProcess = fork(childFile, [String(RPC_LIMIT_BYTES), config], {
    execArgv: (() => {
      const filtered: string[] = [];
      const skip = new Set(["--input-type", "-e", "--eval", "-p", "--print"]);
      let skipNext = false;
      for (const arg of process.execArgv) {
        if (skipNext) { skipNext = false; continue; }
        if (skip.has(arg) || skip.has(arg.split("=")[0] ?? "")) { if (!arg.includes("=")) skipNext = true; continue; }
        filtered.push(arg);
      }
      return [...filtered, "--max-old-space-size=128", "--permission", `--allow-fs-read=${childDir}`];
    })(),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
  const controller = new AbortController();
  let settled = false;
  let rejectResult: (error: WorkflowError) => void = () => undefined;
  let watchdog = setTimeout(() => { stop("WORKER_UNRESPONSIVE", "Workflow worker missed its five-second heartbeat"); }, HEARTBEAT_TIMEOUT_MS);
  const result = new Promise<JsonValue>((resolve, reject) => {
    rejectResult = reject;
    child.on("message", (raw: unknown) => {
      try {
        if (typeof raw !== "string" || Buffer.byteLength(raw) > RPC_LIMIT_BYTES) fail("RPC_LIMIT_EXCEEDED", "RPC value exceeds the 10 MB JSON boundary");
        const message = JSON.parse(raw) as { type?: string; id?: number; method?: string; args?: JsonValue[]; ok?: boolean; value?: JsonValue; error?: WorkflowErrorShape };
        if (!jsonValue(message)) fail("RPC_LIMIT_EXCEEDED", "Worker RPC must contain JSON-compatible values");
        if (message.type === "heartbeat") { clearTimeout(watchdog); watchdog = setTimeout(() => { stop("WORKER_UNRESPONSIVE", "Workflow worker missed its five-second heartbeat"); }, HEARTBEAT_TIMEOUT_MS); return; }
        if (message.type === "result") { encoded(message.value); finish(); resolve(message.value ?? null); return; }
        if (message.type === "error") { finish(); reject(new WorkflowError(message.error?.code ?? "INTERNAL_ERROR", message.error?.message ?? "Worker failed")); return; }
        if (message.type === "rpc" && message.id !== undefined) void handleRpc(message.id, message.method ?? "", message.args ?? []);
      } catch (error) { stop(error instanceof WorkflowError ? error.code : "INTERNAL_ERROR", error instanceof Error ? error.message : String(error)); }
    });
    child.on("error", (error: Error) => { stop("INTERNAL_ERROR", error.message); });
    child.on("exit", (code) => { if (!settled && code !== 0) stop("INTERNAL_ERROR", `Workflow child exited with code ${String(code)}`); });
  });
  function killChild() {
    if (!child.killed) {
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 1000).unref();
    }
  }
  function finish() { settled = true; clearTimeout(watchdog); signal?.removeEventListener("abort", cancel); killChild(); rmSync(childDir, { recursive: true, force: true }); }
  function stop(code: WorkflowErrorCode, message: string) { if (settled) return; controller.abort(); finish(); rejectResult(new WorkflowError(code, message)); }
  function branded(result: Record<string, JsonValue>): JsonValue { return { ...result, [WORK_RESULT_BRAND]: true }; }
  async function handleRpc(id: number, method: string, values: JsonValue[]) {
    try {
      encoded(values);
      let value: JsonValue = null;
      if (method === "agent") {
        if (!bridge.agent) fail("AGENT_FAILED", "No agent bridge is available");
        if (typeof values[0] !== "string") fail("INTERNAL_ERROR", "agent prompt must be a string");
        const opts = validateAgentOptions(values[1]);
        const name = typeof opts.name === "string" && opts.name.trim() ? opts.name : fail("INVALID_METADATA", "agent requires a stable explicit name");
        try {
          const result = await bridge.agent(values[0], opts, controller.signal, typeof values[2] === "string" ? values[2] : name);
          value = branded({ name, ok: true, value: result ?? null });
        } catch (error) {
          const code = (error instanceof WorkflowError ? error.code : typeof (error as Record<string, unknown>).code === "string" ? (error as Record<string, unknown>).code as string : "INTERNAL_ERROR") as WorkflowErrorCode;
          const typed = new WorkflowError(code, (error as Error).message);
          if (!OUTCOME_ERRORS.has(typed.code)) throw typed;
          value = branded({ name, ok: false, failedAt: name, error: { code: typed.code, message: typed.message } });
        }
      } else if (method === "checkpoint") {
        if (!bridge.checkpoint || !object(values[0])) fail("INTERNAL_ERROR", "checkpoint requires an available bridge and object input");
        const name = typeof values[0].name === "string" ? values[0].name : "checkpoint";
        try {
          const result = await bridge.checkpoint(values[0], controller.signal);
          if (typeof result !== "boolean") fail("INTERNAL_ERROR", "checkpoint must return a boolean");
          value = branded({ name, ok: true, value: result ? "approved" : "rejected" });
        } catch (error) {
          const code = (error instanceof WorkflowError ? error.code : typeof (error as Record<string, unknown>).code === "string" ? (error as Record<string, unknown>).code as string : "INTERNAL_ERROR") as WorkflowErrorCode;
          const typed = new WorkflowError(code, (error as Error).message);
          if (!OUTCOME_ERRORS.has(typed.code)) throw typed;
          value = branded({ name, ok: false, failedAt: name, error: { code: typed.code, message: typed.message } });
        }
      } else if (method === "extension") {
        if (!bridge.extension || typeof values[0] !== "string" || typeof values[1] !== "string" || !object(values[2]) || typeof values[3] !== "string") fail("INTERNAL_ERROR", "extension requires an available bridge, names, object input, and path");
        const name = `${values[0]}.${values[1]}`;
        try {
          const result = await bridge.extension(values[0], values[1], values[2], values[3], controller.signal);
          value = branded({ name, ok: true, value: result ?? null });
        } catch (error) {
          const code = (error instanceof WorkflowError ? error.code : typeof (error as Record<string, unknown>).code === "string" ? (error as Record<string, unknown>).code as string : "INTERNAL_ERROR") as WorkflowErrorCode;
          const typed = new WorkflowError(code, (error as Error).message);
          if (!OUTCOME_ERRORS.has(typed.code)) throw typed;
          value = branded({ name, ok: false, failedAt: name, error: { code: typed.code, message: typed.message } });
        }
      } else if (method === "phase") {
        if (typeof values[0] !== "string") fail("INTERNAL_ERROR", "phase name must be a string");
        await bridge.phase?.(values[0]);
      } else if (method === "log") {
        if (typeof values[0] !== "string") fail("INTERNAL_ERROR", "log message must be a string");
        await bridge.log?.(values[0]);
      }
      else fail("INTERNAL_ERROR", `Unknown worker RPC method: ${method}`);
      encoded(value);
      child.send(encoded({ type: "rpcResult", id, ok: true, value }));
    } catch (error) {
      const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", (error as Error).message);
      child.send(encoded({ type: "rpcResult", id, ok: false, error: { code: typed.code, message: typed.message } }));
    }
  }
  function cancel() {
    if (settled) return;
    controller.abort();
    child.send(encoded({ type: "cancel" }));
    stop("CANCELLED", "Workflow cancelled");
  }
  if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
  return { result, cancel };
}
function nativeSessionReference(attempt: Pick<AgentAttempt, "sessionId" | "sessionFile">, lineage?: AgentContinuationLineage): { sessionId: string; sessionFile: string; parentSessionId?: string; parentSessionFile?: string } {
  return { sessionId: attempt.sessionId, sessionFile: attempt.sessionFile, ...(lineage ? { parentSessionId: lineage.sessionId, parentSessionFile: lineage.sessionFile } : {}) };
}

export async function persistAgentConfig(store: RunStore, id: string, config: AgentSessionConfig): Promise<void> {
  await store.updateState((run) => {
    if (!run.agents.some((agent) => agent.id === id)) throw new WorkflowError("INTERNAL_ERROR", `Missing production ownership record: ${id}`);
    return { ...run, agents: run.agents.map((agent) => agent.id === id ? { ...agent, sessionConfig: structuredClone(config) } : agent) };
  });
}

export async function persistActiveAgentAttempt(store: RunStore, id: string, active: Pick<AgentAttempt, "attempt" | "sessionId" | "sessionFile">): Promise<void> {
  await store.updateState((run) => {
    const agent = run.agents.find((candidate) => candidate.id === id);
    if (!agent) throw new WorkflowError("INTERNAL_ERROR", `Missing production ownership record: ${id}`);
    const accounting = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
    const reference = nativeSessionReference(active, agent.continuedFrom);
    const nativeSessions = run.nativeSessions.some(({ sessionId }) => sessionId === active.sessionId) ? run.nativeSessions : [...run.nativeSessions, reference];
    return { ...run, agents: run.agents.map((candidate) => candidate.id === id ? { ...candidate, attempts: active.attempt, attemptDetails: [{ ...active, accounting }] } : candidate), nativeSessions };
  });
}

export async function persistAgentAttempts(store: RunStore, id: string, attempts: readonly AgentAttempt[]): Promise<void> {
  await store.updateState((run) => {
    const agent = run.agents.find((candidate) => candidate.id === id);
    if (!agent) throw new WorkflowError("INTERNAL_ERROR", `Missing production ownership record: ${id}`);
    const total = attempts.reduce((sum, attempt) => ({ input: sum.input + attempt.accounting.input, output: sum.output + attempt.accounting.output, cacheRead: sum.cacheRead + attempt.accounting.cacheRead, cacheWrite: sum.cacheWrite + attempt.accounting.cacheWrite, cost: sum.cost + attempt.accounting.cost }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
    const attemptDetails = attempts.map(({ attempt, sessionId, sessionFile, error, accounting, sessionAccounting }) => ({ attempt, sessionId, sessionFile, ...(error ? { error } : {}), accounting, ...(sessionAccounting ? { sessionAccounting } : {}) }));
    const sessionIds = new Set(attempts.map(({ sessionId }) => sessionId));
    return { ...run, agents: run.agents.map((candidate) => candidate.id === id ? { ...candidate, attempts: attempts.length, attemptDetails, accounting: total } : candidate), nativeSessions: [...run.nativeSessions.filter(({ sessionId }) => !sessionIds.has(sessionId)), ...attempts.map((attempt) => nativeSessionReference(attempt, agent.continuedFrom))] };
  });
}

type WorkflowToolUpdate = { content: [{ type: "text"; text: string }]; details: { runId: string; run: PersistedRun } };

export function formatWorkflowProgress(run: PersistedRun, spinner = "◇"): string {
  const done = run.agents.filter((agent) => SETTLED_AGENT_STATES.has(agent.state)).length;
  const lines = [`${run.state === "completed" ? "✓" : run.state === "failed" || run.state === "stopped" ? "✗" : run.state === "running" ? spinner : "◆"} Workflow: ${run.workflowName} (${String(done)}/${String(run.agents.length)} done)`];
  if (run.phase) lines.push(`  Phase: ${run.phase}`);
  const byId = new Map(run.agents.map((agent) => [agent.id, agent]));
  for (const [index, agent] of run.agents.entries()) {
    let depth = 0;
    for (let parent = agent.parentId; parent && byId.has(parent); parent = byId.get(parent)?.parentId) depth += 1;
    const icon = agent.state === "completed" ? "✓" : agent.state === "failed" || agent.state === "cancelled" ? "✗" : agent.state === "running" ? spinner : "○";
    const indent = "  ".repeat(depth + 1);
    const activity = formatAgentActivity(agent, spinner);
    lines.push(`${indent}#${String(index + 1)} ${icon} ${agent.name} [${agent.state}]${activity ? ` ${activity}` : ""}`);
  }
  return lines.join("\n");
}

function workflowToolUpdate(run: PersistedRun): WorkflowToolUpdate {
  return { content: [{ type: "text", text: formatWorkflowProgress(run) }], details: { runId: run.id, run } };
}

const workflowSpinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function textBlock(text: string) {
  return {
    render(width: number) {
      return text.split("\n").map((line) => line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`);
    },
    invalidate() {},
  };
}

function workflowProgressBlock(run: PersistedRun) {
  return {
    render(width: number) {
      const frame = workflowSpinner[Math.floor(Date.now() / 80) % workflowSpinner.length] ?? "◇";
      return formatWorkflowProgress(run, frame).split("\n").map((line) => line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`);
    },
    invalidate() {},
  };
}

const ATTENTION_ORDER: Record<string, number> = { awaiting_input: 0, running: 1, pausing: 2, paused: 3, interrupted: 4, failed: 5, queued: 6, stopped: 7, completed: 8 };

function navigatorAttentionSort<T extends { loaded: { run: PersistedRun } }>(entries: readonly T[]): T[] {
  return [...entries].sort((a, b) => (ATTENTION_ORDER[a.loaded.run.state] ?? 9) - (ATTENTION_ORDER[b.loaded.run.state] ?? 9));
}

function navigatorRunLabels(entries: readonly { store: RunStore; loaded: { run: PersistedRun } }[]): string[] {
  const nameCount = new Map<string, number>();
  for (const { loaded: { run } } of entries) nameCount.set(run.workflowName, (nameCount.get(run.workflowName) ?? 0) + 1);
  return entries.map(({ store, loaded: { run } }) => {
    const done = run.agents.filter((a) => SETTLED_AGENT_STATES.has(a.state)).length;
    const glyph = run.state === "completed" ? "✓" : run.state === "failed" || run.state === "stopped" ? "✗" : run.state === "running" ? "⠦" : run.state === "awaiting_input" ? "●" : "◆";
    const suffix = (nameCount.get(run.workflowName) ?? 0) > 1 ? ` ${store.runId.slice(0, 8)}` : "";
    const cost = run.agents.reduce((sum, a) => sum + (a.accounting?.cost ?? 0), 0);
    const costStr = cost > 0 ? ` $${cost.toFixed(2)}` : "";
    return `${glyph} ${run.workflowName}${suffix}  ${run.state}  ${run.phase ?? ""}  ${String(done)}/${String(run.agents.length)} agents${costStr}`;
  });
}

function agentBreadcrumb(agent: AgentRecord, byId: Map<string, AgentRecord>): string {
  const parts: string[] = [agent.name];
  const seen = new Set<string>([agent.id]);
  for (let parentId = agent.parentId; parentId; parentId = byId.get(parentId)?.parentId) {
    if (seen.has(parentId)) break; // ponytail: cycle guard for corrupt data
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (parent) parts.unshift(parent.name);
    else break;
  }
  return parts.length > 1 ? parts.join(" > ") : agent.name;
}

function formatAgentActivity(agent: AgentRecord, spinner: string): string {
  if (agent.activity?.kind === "reasoning") return `… reasoning: ${agent.activity.text}`;
  if (agent.activity?.kind === "text") return `> ${agent.activity.text}`;
  if (agent.activity?.kind === "tool") return `${spinner} ${agent.activity.text}`;
  const tool = [...(agent.toolCalls ?? [])].reverse().find(({ state }) => state === "running");
  return tool ? `${spinner} ${tool.name}` : "";
}

function formatAccounting(accounting: NonNullable<AgentRecord["accounting"]>): string {
  const total = accounting.input + accounting.output + accounting.cacheRead + accounting.cacheWrite;
  return `${new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 }).format(total).toLowerCase()} tok`;
}

export function formatNavigatorDashboard(run: PersistedRun, checkpoints: readonly AwaitingCheckpoint[], worktrees: readonly WorktreeReference[]): string {
  const done = run.agents.filter((a) => SETTLED_AGENT_STATES.has(a.state)).length;
  const totalAccounting = run.agents.reduce((sum, a) => ({ input: sum.input + (a.accounting?.input ?? 0), output: sum.output + (a.accounting?.output ?? 0), cacheRead: sum.cacheRead + (a.accounting?.cacheRead ?? 0), cacheWrite: sum.cacheWrite + (a.accounting?.cacheWrite ?? 0), cost: sum.cost + (a.accounting?.cost ?? 0) }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const hasAccounting = run.agents.some((a) => a.accounting);
  const glyph = run.state === "completed" ? "✓" : run.state === "failed" || run.state === "stopped" ? "✗" : run.state === "running" ? "⠦" : run.state === "awaiting_input" ? "●" : "◆";
  const header = `${glyph} ${run.workflowName}`;
  const meta = [run.state, run.phase ? `phase: ${run.phase}` : "", `${String(done)}/${String(run.agents.length)} agents`, hasAccounting ? formatAccounting(totalAccounting) : "", totalAccounting.cost > 0 ? `$${totalAccounting.cost.toFixed(2)}` : ""].filter(Boolean).join(" · ");
  const lines = [header, meta];
  if (run.error) lines.push(`Error: ${run.error.code}: ${run.error.message}`);
  lines.push("");
  const byId = new Map(run.agents.map((a) => [a.id, a]));
  const activeStates = new Set(["running", "waiting_for_child", "queued", "retrying", "paused"]);
  const prioritised = [...run.agents].sort((a, b) => {
    const aActive = activeStates.has(a.state) || a.state === "failed" ? 0 : 1;
    const bActive = activeStates.has(b.state) || b.state === "failed" ? 0 : 1;
    return aActive - bActive;
  });
  for (const agent of prioritised) {
    const icon = agent.state === "completed" ? "✓" : agent.state === "failed" || agent.state === "cancelled" ? "✗" : agent.state === "running" ? "⠦" : "○";
    const breadcrumb = agentBreadcrumb(agent, byId);
    const model = `${agent.model.model}${agent.model.thinking ? `:${agent.model.thinking}` : ""}`;
    const tokens = agent.accounting ? formatAccounting(agent.accounting) : "";
    const parts = [`${icon} ${breadcrumb}`, agent.state, model, tokens].filter(Boolean);
    lines.push(parts.join(" · "));
    if (agent.state === "failed" && agent.attemptDetails?.length) {
      const last = agent.attemptDetails[agent.attemptDetails.length - 1];
      if (last?.error) lines.push(`  error: ${last.error.code}: ${last.error.message}`);
    }
    const activity = !SETTLED_AGENT_STATES.has(agent.state) ? formatAgentActivity(agent, "⠦") : "";
    if (activity) lines.push(`  ${activity}`);
  }
  if (checkpoints.length) { lines.push(""); for (const cp of checkpoints) lines.push(`● checkpoint ${cp.name}: ${cp.prompt}`); }
  if (worktrees.length) { lines.push(""); for (const wt of worktrees) lines.push(`branch ${wt.branch} (${wt.path})`); }
  return lines.join("\n");
}

export function formatNavigatorRun(loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> }, checkpoints: readonly AwaitingCheckpoint[], worktrees: readonly WorktreeReference[]): string {
  const { run, snapshot } = loaded;
  const lines = [
    `Workflow: ${run.workflowName}`,
    `Run: ${run.id}`,
    `Status: ${run.state}`,
    `Phase: ${run.phase ?? "(none)"}`,
    `Launch cwd: ${run.cwd}`,
    `Launch models: ${snapshot.models.join(", ") || "(none)"}`,
  ];
  if (run.error) lines.push(`Run error: ${run.error.code}: ${run.error.message}`);
  lines.push("Agents / ownership:");
  if (!run.agents.length) lines.push("  (none)");
  for (const agent of run.agents) {
    const model = `${agent.model.provider}/${agent.model.model}${agent.model.thinking ? `:${agent.model.thinking}` : ""}`;
    const accounting = agent.accounting ? ` input=${String(agent.accounting.input)} output=${String(agent.accounting.output)} cache-read=${String(agent.accounting.cacheRead)} cache-write=${String(agent.accounting.cacheWrite)} cost=${String(agent.accounting.cost)}` : "";
    lines.push(`  ${agent.name} (${agent.id}) state=${agent.state} parent=${agent.parentId ?? "root"} model=${model} attempts=${String(agent.attempts)} retries=${String(Math.max(0, agent.attempts - 1))}${accounting}`);
    for (const attempt of agent.attemptDetails ?? []) lines.push(`    attempt ${String(attempt.attempt)} transcript=${attempt.sessionFile}${attempt.error ? ` error=${attempt.error.code}: ${attempt.error.message}` : ""}`);
    for (const call of agent.toolCalls ?? []) lines.push(`    tool ${call.name} state=${call.state}`);
  }
  lines.push("Checkpoints:");
  if (!checkpoints.length) lines.push("  (none)");
  for (const checkpoint of checkpoints) lines.push(`  ${checkpoint.name}: ${checkpoint.prompt} context=${JSON.stringify(checkpoint.context)}`);
  lines.push("Worktrees / branches:");
  if (!worktrees.length) lines.push("  (none)");
  for (const worktree of worktrees) lines.push(`  ${worktree.owner}: branch=${worktree.branch} path=${worktree.path} cwd=${worktree.cwd}`);
  lines.push("Native Pi transcript paths:");
  if (!run.nativeSessions.length) lines.push("  (none)");
  for (const session of run.nativeSessions) lines.push(`  ${session.sessionId}: ${session.sessionFile}`);
  return lines.join("\n");
}

const DELIVERY_LIMIT_BYTES = 4 * 1024;

function completionDelivery(name: string, value: JsonValue, resultPath: string, worktrees: readonly { branch: string; path: string }[]): string {
  const locations = worktrees.length ? ` Changes: ${worktrees.map(({ branch, path }) => `${branch} (${path})`).join(", ")}.` : "";
  const message = `Workflow ${name} completed: ${JSON.stringify(value)}${locations}`;
  if (Buffer.byteLength(message) <= DELIVERY_LIMIT_BYTES) return message;
  const suffix = `... Full result: ${resultPath}${locations}`;
  const suffixBytes = Buffer.byteLength(suffix);
  if (suffixBytes >= DELIVERY_LIMIT_BYTES) return utf8Prefix(suffix, DELIVERY_LIMIT_BYTES);
  return utf8Prefix(message, DELIVERY_LIMIT_BYTES - suffixBytes) + suffix;
}

function utf8Prefix(value: string, maxBytes: number): string {
  const bytes = Buffer.from(value);
  let end = Math.min(bytes.length, maxBytes);
  while (end < bytes.length && end > 0 && ((bytes[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return bytes.subarray(0, end).toString("utf8");
}

function deliver(pi: ExtensionAPI, content: string): void {
  pi.sendMessage({ customType: "workflow", content, display: true }, { deliverAs: "followUp", triggerTurn: true });
}
const inheritedHostAgentPath = new AsyncLocalStorage<readonly string[]>();


function namedRecord(value: unknown, kind: string): Array<[string, unknown]> {
  if (!object(value)) fail("INVALID_METADATA", `${kind} must be a record`);
  return Object.entries(value);
}

async function hostParallel(rawOperation: unknown, rawTasks: unknown): Promise<JsonValue> {
  if (typeof rawOperation !== "string" || !rawOperation.trim()) fail("INVALID_METADATA", "parallel requires a stable explicit name");
  const tasks = namedRecord(rawTasks, "parallel tasks");
  for (const [name, run] of tasks) {
    if (!name.trim()) fail("INVALID_METADATA", "parallel task requires a stable explicit name");
    if (typeof run !== "function") fail("INVALID_METADATA", "parallel task values must be run functions");
  }
  const results = await Promise.all(tasks.map(async ([name, run]) => {
    try {
      const parent = inheritedHostAgentPath.getStore() ?? [];
      return { name, value: await inheritedHostAgentPath.run([...parent, rawOperation, name], run as () => unknown) as JsonValue };
    } catch (error) {
      const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
      if (typed.code === "CANCELLED") throw typed;
      return { name, error: typed };
    }
  }));
  const failure = results.find((result) => result.error);
  if (failure?.error) throw failure.error;
  return Object.fromEntries(results.map((result) => [result.name, result.value as JsonValue]));
}

async function hostPipeline(rawOperation: unknown, rawItems: unknown, rawStages: unknown): Promise<JsonValue> {
  if (typeof rawOperation !== "string" || !rawOperation.trim()) fail("INVALID_METADATA", "pipeline requires a stable explicit name");
  const items = namedRecord(rawItems, "pipeline items");
  const stages = namedRecord(rawStages, "pipeline stages");
  if (!stages.length) fail("INVALID_METADATA", "pipeline requires at least one stage");
  for (const [name] of items) if (!name.trim()) fail("INVALID_METADATA", "pipeline item requires a stable explicit name");
  for (const [stageName, run] of stages) {
    if (!stageName.trim()) fail("INVALID_METADATA", "pipeline stage requires a stable explicit name");
    if (typeof run !== "function") fail("INVALID_METADATA", "pipeline stage values must be run functions");
  }
  const results = await Promise.all(items.map(async ([name, initial]) => {
    let current = initial;
    try {
      for (const [stageName, run] of stages) {
        const parent = inheritedHostAgentPath.getStore() ?? [];
        current = await inheritedHostAgentPath.run([...parent, rawOperation, name, stageName], () => (run as (value: unknown) => unknown)(current));
      }
      return { name, value: current as JsonValue };
    } catch (error) {
      const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
      if (typed.code === "CANCELLED") throw typed;
      return { name, error: typed };
    }
  }));
  const failure = results.find((result) => result.error);
  if (failure?.error) throw failure.error;
  return Object.fromEntries(results.map((result) => [result.name, result.value as JsonValue]));
}

function nextStructuralLabel(counters: Map<string, number>, label: string): string {
  const count = (counters.get(label) ?? 0) + 1;
  counters.set(label, count);
  return count === 1 ? label : `${label}#${String(count)}`;
}

interface PreparedAgentOptions { source?: AgentContinuationSource; tools: readonly string[]; model?: string; thinking?: ModelSpec["thinking"]; role?: string; schema?: JsonSchema; isolation?: "worktree"; worktreeOwner?: string; cwd?: string }
function parseThinking(value: unknown): ModelSpec["thinking"] | undefined {
  switch (value) {
    case "off": case "minimal": case "low": case "medium": case "high": case "xhigh": case "max": return value;
    default: return undefined;
  }
}

function modelReference(model: ModelSpec): string { return `${model.provider}/${model.model}${model.thinking ? `:${model.thinking}` : ""}`; }

function continuationSource(run: PersistedRun, reference: unknown): AgentContinuationSource {
  if (typeof reference !== "string" || !reference.trim()) fail("RESUME_INCOMPATIBLE", "Continuation source must be a workflow agent name or path");
  const matches = run.agents.filter((agent) => agent.name === reference || agent.path === reference || agent.id === reference || operationPath("agent", agent.path) === reference);
  if (matches.length !== 1) fail("RESUME_INCOMPATIBLE", matches.length > 1 ? `Continuation source is ambiguous: ${reference}` : `Continuation source is missing from this workflow run: ${reference}`);
  const agent = matches[0] as AgentRecord;
  if (agent.state !== "completed") fail("RESUME_INCOMPATIBLE", `Continuation source is not completed: ${reference}`);
  const config = agent.sessionConfig;
  if (!config) fail("RESUME_INCOMPATIBLE", `Continuation source is unavailable or incomplete: ${reference}`);
  const parent = agent.parentId ? run.agents.find((candidate) => candidate.id === agent.parentId) : undefined;
  const unprovenNestedWorktree = Boolean(agent.parentId) && config.cwd !== run.cwd && config.isolation !== "worktree";
  if ((config.isolation === "worktree" && !config.worktreeOwner) || unprovenNestedWorktree || (parent?.sessionConfig?.isolation === "worktree" && (config.isolation !== "worktree" || !config.worktreeOwner || config.worktreeOwner !== parent.sessionConfig.worktreeOwner || config.cwd !== parent.sessionConfig.cwd))) fail("RESUME_INCOMPATIBLE", `Cannot continue ${reference}: persisted worktree identity is unavailable`);
  const attempt = agent.attemptDetails?.at(-1);
  const native = attempt ? run.nativeSessions.find((session) => session.sessionId === attempt.sessionId && session.sessionFile === attempt.sessionFile) : undefined;
  if (!attempt || attempt.error || !native || !existsSync(native.sessionFile)) fail("RESUME_INCOMPATIBLE", `Continuation source is unavailable or incomplete: ${reference}`);
  return { agentId: agent.id, agentPath: agent.path, sessionId: attempt.sessionId, sessionFile: attempt.sessionFile, accounting: attempt.sessionAccounting ?? attempt.accounting, config };
}

function preparedAgentOptions(run: PersistedRun, options: Readonly<Record<string, JsonValue>>): PreparedAgentOptions | undefined {
  if (options.continueFrom === undefined) return undefined;
  const source = continuationSource(run, options.continueFrom);
  const rawTools = options.tools;
  if (rawTools !== undefined && (!Array.isArray(rawTools) || rawTools.some((tool) => typeof tool !== "string"))) fail("RESUME_INCOMPATIBLE", "Continuation tools must match the completed source");
  const tools = rawTools === undefined ? source.config.tools : rawTools as string[];
  const rawModel = options.model;
  if (rawModel !== undefined && typeof rawModel !== "string") fail("RESUME_INCOMPATIBLE", "Continuation model must match the completed source");
  const rawThinking = options.thinking;
  const thinking = parseThinking(rawThinking);
  if (rawThinking !== undefined && !thinking) fail("RESUME_INCOMPATIBLE", "Continuation thinking level must match the completed source");
  const rawRole = options.role;
  if (rawRole !== undefined && typeof rawRole !== "string") fail("RESUME_INCOMPATIBLE", "Continuation role must match the completed source");
  const rawSchema = options.outputSchema;
  if (rawSchema !== undefined && !object(rawSchema)) fail("RESUME_INCOMPATIBLE", "Continuation structured output must match the completed source");
  const rawIsolation = options.isolation;
  if (rawIsolation !== undefined && rawIsolation !== "worktree") fail("RESUME_INCOMPATIBLE", "Continuation worktree isolation must match the completed source");
  const rawCwd = options.cwd;
  if (rawCwd !== undefined && (typeof rawCwd !== "string" || rawCwd !== source.config.cwd)) fail("RESUME_INCOMPATIBLE", "Continuation cwd must match the completed source");
  const rawOwner = options.worktreeOwner;
  if (rawOwner !== undefined && (typeof rawOwner !== "string" || rawOwner !== source.config.worktreeOwner)) fail("RESUME_INCOMPATIBLE", "Continuation worktree must match the completed source");
  if (rawIsolation !== undefined && !source.config.isolation) fail("RESUME_INCOMPATIBLE", "Continuation worktree isolation must match the completed source");
  return { source, tools, model: rawModel ?? modelReference(source.config.model), ...(thinking ? { thinking } : {}), ...(rawRole !== undefined ? { role: rawRole } : source.config.role ? { role: source.config.role } : {}), ...(rawSchema !== undefined ? { schema: rawSchema } : source.config.schema ? { schema: source.config.schema } : {}), ...(source.config.isolation ? { isolation: source.config.isolation, ...(source.config.worktreeOwner ? { worktreeOwner: source.config.worktreeOwner } : {}), cwd: source.config.cwd } : { cwd: source.config.cwd }) };
}

function withExtensions(bridge: WorkflowBridge, store: RunStore): WorkflowBridge {
  const namespaces = workflowDslRegistry.namespaces();
  return { ...bridge, extensions: Object.fromEntries(Object.entries(namespaces).map(([name, methods]) => [name, Object.keys(methods)])), extension: async (extension, method, input, path, signal) => {
    const replayed = await store.replay(path);
    let stored: JsonValue | undefined;
    const sideEffects: Promise<void>[] = [];
    const context: WorkflowOrchestrationContext = Object.freeze({
      agent: async (...args: readonly unknown[]) => {
        if (!bridge.agent || typeof args[0] !== "string") fail("AGENT_FAILED", "No agent bridge is available");
        const options = validateAgentOptions(args[1] === undefined ? {} : args[1], false);
        const inherited = inheritedHostAgentPath.getStore();
        const explicitName = options.name;
        const name = explicitName === undefined && inherited ? inherited.at(-1) : explicitName;
        if (typeof name !== "string" || !name.trim()) fail("INVALID_METADATA", "agent requires a stable explicit name");
        const structuralName = explicitName === undefined && inherited ? operationPath(...inherited) : name;
        return bridge.agent(args[0], { ...options, name }, signal, structuralName);
      },
      parallel: (...args: readonly unknown[]) => hostParallel(args[0], args[1]),
      pipeline: (...args: readonly unknown[]) => hostPipeline(args[0], args[1], args[2]),
      checkpoint: async (...args: readonly unknown[]) => {
        if (!bridge.checkpoint || !object(args[0]) || !jsonValue(args[0])) fail("INTERNAL_ERROR", "No checkpoint bridge is available");
        return bridge.checkpoint(args[0], signal);
      },
      phase: (name: string) => { sideEffects.push(Promise.resolve(bridge.phase?.(name))); },
      log: (message: string) => { sideEffects.push(Promise.resolve(bridge.log?.(message))); },
    });
    const result = await workflowDslRegistry.invoke(extension, method, input, context, path, { get: () => replayed?.value, put: (_path, value) => { stored = value; } });
    await Promise.all(sideEffects);
    if (!replayed) await store.complete(path, stored ?? result);
    return result;
  } };
}

function projectTrusted(ctx: unknown): boolean {
  const check = object(ctx) ? ctx.isProjectTrusted : undefined;
  return typeof check === "function" ? Boolean(Reflect.apply(check, ctx, [])) : true;
}

export default function workflowExtension(pi: ExtensionAPI, home?: string) {
  const events = (pi as unknown as { events?: ExtensionAPI["events"] }).events;
  pi.on("resources_discover", () => {
    if (!pi.getActiveTools().includes("workflow")) return;
    const extensionDir = dirname(fileURLToPath(import.meta.url));
    const skillPath = [join(extensionDir, "../skills"), join(extensionDir, "../../skills")].find((path) => existsSync(path));
    return skillPath ? { skillPaths: [skillPath] } : undefined;
  });
  const emitAsyncStarted = (store: RunStore, metadata: WorkflowMetadata) => {
    events?.emit(WORKFLOW_ASYNC_STARTED_EVENT, { id: store.runId, runId: store.runId, pid: process.pid, sessionId: store.sessionId, asyncDir: store.directory, agent: metadata.name });
  };
  const emitAsyncComplete = (store: RunStore, state: "complete" | "failed" | "stopped", error?: Error) => {
    events?.emit(WORKFLOW_ASYNC_COMPLETE_EVENT, { id: store.runId, runId: store.runId, sessionId: store.sessionId, asyncDir: store.directory, success: state === "complete", state, ...(state === "stopped" ? { stopped: true } : {}), ...(error ? { error: error.message } : {}) });
  };
  const runs = new Map<string, { executor: WorkflowAgentExecutor; store: RunStore; metadata: WorkflowMetadata; model: ModelSpec; lifecycle: RunLifecycle; execution?: WorkflowExecution; checkpointResolvers: Map<string, (value: boolean) => void>; update?: (result: WorkflowToolUpdate) => void }>();
  const lifecycleFor = (store: RunStore, state: RunState) => new RunLifecycle(state, async (next) => {
    const run = await store.updateState((current) => {
      const nextRun = { ...current, state: next };
      if (next === "running" || next === "completed") delete nextRun.error;
      return nextRun;
    });
    runs.get(store.runId)?.update?.(workflowToolUpdate(run));
  });
  const scheduler = new FairAgentScheduler(async ({ id, runId, parentId, prompt, options, signal, setSteer }) => {
    const run = runs.get(runId);
    if (!run) throw new WorkflowError("INTERNAL_ERROR", `Unknown production run: ${runId}`);
    try {
      const onProgress = async (progress: AgentProgress) => {
        let runState: PersistedRun;
        if (progress.persist) {
          runState = await run.store.updateState((current) => current.agents.some((agent) => agent.id === id) ? { ...current, agents: current.agents.map((agent) => agent.id === id ? { ...agent, accounting: progress.accounting, toolCalls: progress.toolCalls, activity: progress.activity } : agent) } : current);
        } else {
          const loaded = await run.store.load();
          if (!loaded.run.agents.some((agent) => agent.id === id)) return;
          runState = { ...loaded.run, agents: loaded.run.agents.map((agent) => agent.id === id ? { ...agent, accounting: progress.accounting, toolCalls: progress.toolCalls, activity: progress.activity } : agent) };
        }
        if (!runState.agents.some((agent) => agent.id === id)) return;
        run.update?.(workflowToolUpdate(runState));
      };
      const onConfig = async (config: AgentSessionConfig) => { await scheduler.flush(); await persistAgentConfig(run.store, id, config); run.update?.(workflowToolUpdate((await run.store.load()).run)); };
      const onAttempt = async (attempt: Pick<AgentAttempt, "attempt" | "sessionId" | "sessionFile">) => {
        await scheduler.flush();
        await persistActiveAgentAttempt(run.store, id, attempt);
        run.update?.(workflowToolUpdate((await run.store.load()).run));
      };
      const result = await run.executor.execute(prompt, { label: options.label, workflowName: run.metadata.name, onConfig, onProgress, onAttempt, ...(parentId ? { parent: parentId, cwd: options.cwd, ...(options.isolation ? { parentIsolation: "worktree" as const, worktreeOwner: options.worktreeOwner ?? options.label } : {}) } : options.isolation ? { isolation: options.isolation, worktreeOwner: options.worktreeOwner ?? options.label } : {}), ...(options.model ? { model: options.model } : {}), ...(options.thinking ? { thinking: options.thinking } : {}), ...(options.role ? { role: options.role } : {}), tools: options.tools, ...(options.schema ? { schema: options.schema } : {}), ...(options.continueFrom ? { continueFrom: options.continueFrom } : {}), ...(options.retries === undefined ? {} : { retries: options.retries }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }, signal, scheduler.toolsFor(id, (role, tools, model, inheritedTools) => run.executor.resolve({ label: "child", workflowName: run.metadata.name, ...(model ? { model } : {}), ...(role ? { role } : {}), ...(tools !== undefined ? { tools } : {}) }, inheritedTools).tools), setSteer, () => { scheduler.cancelChildren(id); });
      await persistAgentAttempts(run.store, id, result.attempts);
      return result.value;
    } catch (error) {
      const attempts = (error as WorkflowError & { attempts?: readonly AgentAttempt[] }).attempts;
      if (attempts?.length) await persistAgentAttempts(run.store, id, attempts);
      throw error;
    }
  }, 16, async (runId, ownership) => {
    const run = runs.get(runId);
    if (!run) return;
    await run.store.saveOwnership(ownership);
    const runState = await run.store.updateState((current) => {
      const existing = new Map(current.agents.map((agent) => [agent.id, agent]));
      const agents = ownership.map((node) => {
        const previous = existing.get(node.id);
        return { id: node.id, name: node.label, path: node.id, state: node.state, ...(node.parentId ? { parentId: node.parentId } : {}), model: { ...(node.options.model ? modelSpec(node.options.model, run.model) : run.model), ...(node.options.thinking ? { thinking: node.options.thinking } : {}) }, tools: node.options.tools, attempts: previous?.attempts ?? 0, ...(node.options.continueFrom ? { continuedFrom: { agentId: node.options.continueFrom.agentId, agentPath: node.options.continueFrom.agentPath, sessionId: node.options.continueFrom.sessionId, sessionFile: node.options.continueFrom.sessionFile } } : previous?.continuedFrom ? { continuedFrom: previous.continuedFrom } : {}), ...(previous?.sessionConfig ? { sessionConfig: previous.sessionConfig } : {}), ...(previous?.attemptDetails ? { attemptDetails: previous.attemptDetails } : {}), ...(previous?.accounting ? { accounting: previous.accounting } : {}), ...(previous?.toolCalls ? { toolCalls: previous.toolCalls } : {}), ...(previous?.activity ? { activity: previous.activity } : {}) };
      });
      return { ...current, agents };
    });
    run.update?.(workflowToolUpdate(runState));
  });
  const answerCheckpoint = async (runId: string, name: string, approved: boolean, silent = false) => {
    const run = runs.get(runId);
    if (!run) return false;
    const checkpoint = await run.store.answerCheckpoint(name, approved);
    if (!checkpoint) return false;
    if ((await run.store.awaitingCheckpoints()).length === 0) await run.lifecycle.resolveAwaitingInput();
    run.checkpointResolvers.get(checkpoint.path)?.(approved);
    run.checkpointResolvers.delete(checkpoint.path);
    if (!silent) deliver(pi, `Workflow ${run.metadata.name} checkpoint ${name}: ${approved ? "Approved" : "Rejected"}.`);
    return true;
  };
  const checkpointBridge = (runId: string, store: RunStore, metadata: WorkflowMetadata, foreground: boolean, ui?: { select?: (prompt: string, options: string[]) => Promise<string | undefined> }) => {
    const checkpointCounters = new Map<string, number>();
    return async (raw: Readonly<Record<string, JsonValue>>, signal: AbortSignal): Promise<boolean> => {
    const input = validateCheckpoint(raw);
    const label = nextStructuralLabel(checkpointCounters, input.name);
    const path = operationPath("checkpoint", label);
    if (foreground && !ui?.select) fail("RESUME_INCOMPATIBLE", "Foreground checkpoints require UI");
    const alreadyAwaiting = (await store.awaitingCheckpoints()).some((checkpoint) => checkpoint.path === path);
    const replayed = await store.awaitCheckpoint({ ...input, name: label, path });
    if (replayed !== undefined) return replayed;
    const run = runs.get(runId);
    await run?.lifecycle.enterAwaitingInput();
    if (!alreadyAwaiting && !ui?.select) deliver(pi, `Workflow ${metadata.name} checkpoint ${label}: ${input.prompt}\nContext: ${JSON.stringify(input.context)}\nRespond with workflow_respond.`);
    const decision = new Promise<boolean>((resolve, reject) => {
      run?.checkpointResolvers.set(path, resolve);
      if (signal.aborted) reject(new WorkflowError("CANCELLED", "Workflow cancelled"));
      else signal.addEventListener("abort", () => { run?.checkpointResolvers.delete(path); reject(new WorkflowError("CANCELLED", "Workflow cancelled")); }, { once: true });
    });
    const answered = await store.awaitCheckpoint({ ...input, name: label, path });
    if (answered !== undefined) {
      if ((await store.awaitingCheckpoints()).length === 0) await run?.lifecycle.resolveAwaitingInput();
      run?.checkpointResolvers.get(path)?.(answered);
      run?.checkpointResolvers.delete(path);
    }
    if (ui?.select) void (async () => {
      while (!signal.aborted && run?.checkpointResolvers.has(path)) {
        const choice = await ui.select?.(input.prompt, ["Approve", "Reject"]);
        if (!choice) {
          if (foreground) continue; // foreground: retry until answered
          // Background resume: user dismissed UI, fall back to LLM
          deliver(pi, `Workflow ${metadata.name} checkpoint ${label}: ${input.prompt}\nContext: ${JSON.stringify(input.context)}\nRespond with workflow_respond.`);
          return;
        }
        if (await answerCheckpoint(runId, label, choice === "Approve", true)) return;
      }
    })().catch(() => undefined);
    return decision;
  };
  };

  pi.registerTool({
    name: "workflow_respond",
    label: "Workflow Respond",
    description: "Approve or reject one pending workflow checkpoint",
    parameters: Type.Object({ runId: Type.String(), name: Type.String(), approved: Type.Boolean() }, { additionalProperties: false }),
    async execute(_id, params) {
      const accepted = await answerCheckpoint(params.runId, params.name, params.approved);
      return { content: [{ type: "text" as const, text: accepted ? "Checkpoint response accepted." : "Checkpoint is not awaiting a response." }], details: { accepted } };
    },
  });

  const coldResumeRun = async (run: NonNullable<ReturnType<typeof runs.get>>, hasUI: boolean, ui: { select?: (prompt: string, options: string[]) => Promise<string | undefined> }) => {
    const loaded = await run.store.load();
    const active = new Set(pi.getActiveTools().filter((tool) => tool !== "workflow" && tool !== "workflow_respond"));
    const missing = loaded.snapshot.tools.find((tool) => !active.has(tool));
    if (missing) throw new WorkflowError("RESUME_INCOMPATIBLE", `Required tool is unavailable: ${missing}`);
    preflight(loaded.snapshot.script, { models: new Set(loaded.snapshot.models), tools: active, agentTypes: new Set(loaded.snapshot.agentTypes), extensions: workflowDslRegistry.versions() }, loaded.snapshot.schemas, loaded.snapshot.metadata);
    await scheduler.cancelRun(run.store.runId);
    await run.lifecycle.resume();
    const agentCounters = new Map<string, number>();
    const execution = runWorkflow(loaded.snapshot.script, loaded.snapshot.args, withExtensions({ agent: async (prompt, options, signal, structuralName) => {
      await run.lifecycle.enter();
      try {
        const label = typeof options.name === "string" && options.name.trim() ? options.name : fail("INVALID_METADATA", "agent requires a stable explicit name");
        const structuralLabel = nextStructuralLabel(agentCounters, structuralName ?? label);
        const path = operationPath("agent", structuralLabel);
        const replayed = await run.store.replay(path);
        if (replayed) return replayed.value;
        if (options.continueFrom !== undefined) await scheduler.flush();
        const current = await run.store.load();
        const prepared = preparedAgentOptions(current.run, options);
        const explicitTools = prepared?.tools ?? (Array.isArray(options.tools) && options.tools.every((tool) => typeof tool === "string") ? options.tools : undefined);
        const isolation = prepared?.isolation ?? (options.isolation === "worktree" ? "worktree" as const : undefined);
        const worktreeOwner = prepared?.worktreeOwner ?? structuralLabel;
        const cwd = isolation ? (prepared?.source ? (await run.store.validateWorktree(worktreeOwner, prepared.cwd)).cwd : (await run.store.worktree(worktreeOwner)).cwd) : prepared?.cwd ?? run.store.cwd;
        const role = typeof options.role === "string" ? options.role : prepared?.role;
        const model = prepared?.model ?? (typeof options.model === "string" ? options.model : undefined);
        const thinking = prepared?.thinking ?? parseThinking(options.thinking);
        const tools = run.executor.resolve({ label, workflowName: run.metadata.name, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(explicitTools !== undefined ? { tools: explicitTools } : {}) }).tools;
        const schema = prepared?.schema ?? (object(options.outputSchema) ? options.outputSchema : undefined);
        const spawned = scheduler.spawn(run.store.runId, prompt, { label, cwd, tools, ...(isolation ? { isolation, worktreeOwner } : {}), ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(schema ? { schema } : {}), ...(prepared?.source ? { continueFrom: prepared.source } : {}), ...(typeof options.retries === "number" ? { retries: options.retries } : {}), ...(positiveInteger(options.timeoutMs) || options.timeoutMs === null ? { timeoutMs: options.timeoutMs } : {}) });
        const cancel = () => { scheduler.cancel(spawned.id); };
        signal.addEventListener("abort", cancel, { once: true });
        const outcome = await spawned.result.finally(() => { signal.removeEventListener("abort", cancel); });
        if (!outcome.ok) throw new WorkflowError(outcome.error.code as WorkflowErrorCode, outcome.error.message);
        await run.store.complete(path, outcome.value);
        return outcome.value;
      } finally { await run.lifecycle.leave(); }
    }, checkpoint: checkpointBridge(run.store.runId, run.store, run.metadata, false, hasUI ? ui : undefined), phase: async (phase) => { await run.lifecycle.enter(); try { await run.store.updateState((current) => ({ ...current, phase })); } finally { await run.lifecycle.leave(); } }, log: async () => { await run.lifecycle.enter(); await run.lifecycle.leave(); } }, run.store));
    run.execution = execution;
    emitAsyncStarted(run.store, run.metadata);
    void execution.result.then(async () => { await scheduler.flush(); await run.lifecycle.terminal("completed"); emitAsyncComplete(run.store, "complete"); }, async (error: unknown) => { await scheduler.flush(); if (run.lifecycle.state !== "stopped" && run.lifecycle.state !== "interrupted") await run.lifecycle.terminal("failed"); const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", String(error)); await run.store.updateState((current) => ({ ...current, error: { code: typed.code, message: typed.message } })); emitAsyncComplete(run.store, run.lifecycle.state === "stopped" ? "stopped" : "failed", typed); });
  };
  pi.on("session_start", async (_event, ctx) => {
    for (const runId of await listRunIds(ctx.cwd, ctx.sessionManager.getSessionId(), home)) {
      if (runs.has(runId)) continue;
      const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
      const loaded = await store.load();
      if (["completed", "failed", "stopped"].includes(loaded.run.state)) continue;
      const model = modelSpec(loaded.snapshot.models[0] ?? "", { provider: ctx.model?.provider ?? "", model: ctx.model?.id ?? "", thinking: pi.getThinkingLevel() });
      const lifecycle = lifecycleFor(store, loaded.run.state);
      const providerPause = async () => { deliver(pi, `Workflow ${loaded.snapshot.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      if (loaded.snapshot.roles === undefined) throw new WorkflowError("RESUME_INCOMPATIBLE", "Interrupted workflows created before 0.3.0 must be relaunched");
      const roleDefinitions = loaded.snapshot.roles;
      if ((loaded.snapshot.projectRoles?.length ?? 0) > 0 && !projectTrusted(ctx)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Cannot restore project roles in an untrusted project");
      const missingRole = loaded.snapshot.agentTypes.find((role) => !roleDefinitions[role]);
      if (missingRole) throw new WorkflowError("RESUME_INCOMPATIBLE", `Role definition is missing from the launch snapshot: ${missingRole}`);
      runs.set(runId, { executor: new WorkflowAgentExecutor({ cwd: ctx.cwd, model, tools: new Set(loaded.snapshot.tools.filter((tool) => pi.getActiveTools().includes(tool))), agentDefinitions: roleDefinitions, runStore: store, providerPause }), store, metadata: loaded.snapshot.metadata, model, lifecycle, checkpointResolvers: new Map() });
      for (const checkpoint of await store.awaitingCheckpoints()) deliver(pi, `Workflow ${loaded.snapshot.metadata.name} checkpoint ${checkpoint.name}: ${checkpoint.prompt}\nContext: ${JSON.stringify(checkpoint.context)}\nRespond with workflow_respond.`);
      scheduler.restoreRun(runId, loaded.snapshot.settings.concurrency, loaded.snapshot.settings.maxAgents, await store.loadOwnership());
    }
    if (ctx.hasUI) {
      const interrupted = [...runs.values()].filter((r) => r.lifecycle.state === "interrupted");
      if (interrupted.length > 0) {
        const labels = interrupted.map((r) => `Resume: ${r.metadata.name} (${r.store.runId.slice(0, 8)})`);
        const options = [...labels, ...(interrupted.length > 1 ? ["Resume all"] : []), "Skip"];
        const choice = await ctx.ui.select(`${String(interrupted.length)} interrupted workflow${interrupted.length > 1 ? "s" : ""} found`, options);
        if (choice && choice !== "Skip") {
          const toResume = choice === "Resume all" ? interrupted : interrupted.filter((_, i) => labels[i] === choice);
          for (const run of toResume) {
            try { await coldResumeRun(run, true, ctx.ui); ctx.ui.notify(`Resumed workflow ${run.metadata.name}.`, "info"); }
            catch (err) { ctx.ui.notify(`Cannot resume ${run.metadata.name}: ${err instanceof Error ? err.message : String(err)}`, "warning"); }
          }
        }
      }
    }
  });
  pi.on("before_agent_start", (event, ctx) => {
    if (!pi.getActiveTools().includes("workflow")) return;
    const roles = Object.entries(loadAgentDefinitions(ctx.cwd, undefined, projectTrusted(ctx))).filter(([, definition]) => definition.description);
    if (!roles.length) return;
    const content = `Workflow role descriptions:\n${roles.map(([name, definition]) => `- \`${name}\`: ${String(definition.description)}`).join("\n")}`;
    return { systemPrompt: `${event.systemPrompt}\n\n${content}` };
  });
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: "Run a deterministic JavaScript workflow",
    promptSnippet:
      "Run a deterministic, resumable JavaScript workflow that orchestrates subagents. Inline scripts require a name; registered workflows use their workflow name. Runs in the background by default; completion arrives as a follow-up message.",
    parameters: Type.Object({
      name: Type.Optional(Type.String({ description: "Workflow name for inline scripts" })),
      description: Type.Optional(Type.String({ description: "Optional human-readable workflow description" })),
      extensions: Type.Optional(Type.Array(Type.Object({ name: Type.String(), version: Type.String() }, { additionalProperties: false }))),
      script: Type.Optional(Type.String({ description: "Immutable workflow source without metadata" })),
      workflow: Type.Optional(Type.String({ description: "Registered reusable workflow as namespace.name" })),
      args: Type.Optional(Type.Unknown({ description: "JSON-compatible workflow arguments" })),
      foreground: Type.Optional(Type.Boolean({ description: "Wait for completion instead of running in the background" })),
      concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
      maxAgents: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!ctx.model) throw new WorkflowError("UNKNOWN_MODEL", "A launching model is required");
      const defaults = loadSettings();
      const settings = Object.freeze({ concurrency: params.concurrency ?? defaults.concurrency, maxAgents: params.maxAgents ?? defaults.maxAgents });
      const rootModel: ModelSpec = { provider: ctx.model.provider, model: ctx.model.id, thinking: pi.getThinkingLevel() };
      const rootModelName = `${rootModel.provider}/${rootModel.model}`;
      const modelRegistry = (ctx as unknown as { modelRegistry?: { getAvailable(): Array<{ provider: string; id: string }> } }).modelRegistry;
      const availableModels = new Set((modelRegistry?.getAvailable() ?? [ctx.model]).map((model) => `${model.provider}/${model.id}`));
      availableModels.add(rootModelName);
      const rootTools = pi.getActiveTools().filter((name) => name !== "workflow" && name !== "workflow_respond");
      if (params.script !== undefined && params.workflow !== undefined) throw new WorkflowError("INVALID_METADATA", "Provide either script or workflow, not both");
      const definition = typeof params.workflow === "string" ? workflowDslRegistry.workflow(params.workflow) : undefined;
      const script = typeof params.script === "string" && params.script.trim() ? params.script : definition?.script ?? "";
      if (!script) throw new WorkflowError("INVALID_SYNTAX", "Provide script or registered workflow");
      const workflowName = typeof params.name === "string" && params.name.trim() ? params.name.trim() : typeof params.workflow === "string" ? params.workflow : "";
      if (!workflowName) throw new WorkflowError("INVALID_METADATA", "Inline workflows require name");
      const metadata = validateWorkflowMetadata({ name: workflowName, ...(typeof params.description === "string" ? { description: params.description } : definition?.description ? { description: definition.description } : {}), extensions: params.extensions ?? definition?.extensions });
      const trustedProject = projectTrusted(ctx);
      const globalAgentDefinitions = loadAgentDefinitions(ctx.cwd, undefined, false);
      const projectAgentDefinitions = trustedProject ? readAgentDefinitions(join(ctx.cwd, ".pi", "piworkflows", "roles")) : {};
      const agentDefinitions = deepFreeze({ ...globalAgentDefinitions, ...projectAgentDefinitions });
      const checked = preflight(script, { models: availableModels, tools: new Set(rootTools), agentTypes: new Set(Object.keys(agentDefinitions)), extensions: workflowDslRegistry.versions() }, [], metadata);
      const roleNames = checked.dynamicAgentRoles ? Object.keys(agentDefinitions) : checked.referenced.agentTypes;
      validateRolePolicies(agentDefinitions, roleNames, availableModels, new Set(rootTools));
      const runId = randomUUID();
      const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
      const roles = Object.fromEntries(roleNames.map((role) => [role, agentDefinitions[role]])) as Record<string, AgentDefinition>;
      const projectRoles = roleNames.filter((role) => projectAgentDefinitions[role] !== undefined);
      const snapshot = createLaunchSnapshot({ script, args: (params.args ?? null) as JsonValue, metadata: checked.metadata, settings, models: [rootModelName, ...checked.referenced.models.filter((model) => model !== rootModelName)], tools: rootTools, agentTypes: checked.referenced.agentTypes, roles, projectRoles, extensions: workflowDslRegistry.versions(), schemas: checked.schemas });
      await store.create({ id: runId, workflowName: checked.metadata.name, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), state: "running", agents: [], nativeSessions: [] }, snapshot);
      const lifecycle = lifecycleFor(store, "running");
      const background = !params.foreground;
      const providerPause = async () => { if (background) deliver(pi, `Workflow ${checked.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      const executor = new WorkflowAgentExecutor({ cwd: ctx.cwd, model: rootModel, tools: new Set(rootTools), agentDefinitions, runStore: store, providerPause });
      runs.set(runId, { executor, store, metadata: checked.metadata, model: rootModel, lifecycle, checkpointResolvers: new Map(), ...(params.foreground && onUpdate ? { update: onUpdate } : {}) });
      if (params.foreground && onUpdate) onUpdate(workflowToolUpdate((await store.load()).run));
      scheduler.addRun(runId, settings.concurrency, settings.maxAgents);
      const agentCounters = new Map<string, number>();
      const execution = runWorkflow(script, (params.args ?? null) as JsonValue, withExtensions({ agent: async (prompt, options, agentSignal, structuralName) => {
        await lifecycle.enter();
        try {
          const label = typeof options.name === "string" && options.name.trim() ? options.name : fail("INVALID_METADATA", "agent requires a stable explicit name");
          const structuralLabel = nextStructuralLabel(agentCounters, structuralName ?? label);
          const path = operationPath("agent", structuralLabel);
          const replayed = await store.replay(path);
          if (replayed) return replayed.value;
          if (options.continueFrom !== undefined) await scheduler.flush();
          const loaded = await store.load();
          const prepared = preparedAgentOptions(loaded.run, options);
          const explicitTools = prepared?.tools ?? (Array.isArray(options.tools) && options.tools.every((tool) => typeof tool === "string") ? options.tools : undefined);
          const isolation = prepared?.isolation ?? (options.isolation === "worktree" ? "worktree" as const : undefined);
          const worktreeOwner = prepared?.worktreeOwner ?? structuralLabel;
          const cwd = isolation ? (prepared?.source ? (await store.validateWorktree(worktreeOwner, prepared.cwd)).cwd : (await store.worktree(worktreeOwner)).cwd) : prepared?.cwd ?? ctx.cwd;
          const role = prepared?.role ?? (typeof options.role === "string" ? options.role : undefined);
          const model = prepared?.model ?? (typeof options.model === "string" ? options.model : undefined);
          const thinking = prepared?.thinking ?? parseThinking(options.thinking);
          const tools = executor.resolve({ label, workflowName: checked.metadata.name, ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(explicitTools !== undefined ? { tools: explicitTools } : {}) }).tools;
          const schema = prepared?.schema ?? (object(options.outputSchema) ? options.outputSchema : undefined);
          const spawned = scheduler.spawn(runId, prompt, { label, cwd, tools, ...(isolation ? { isolation, worktreeOwner } : {}), ...(model ? { model } : {}), ...(thinking ? { thinking } : {}), ...(role ? { role } : {}), ...(schema ? { schema } : {}), ...(prepared?.source ? { continueFrom: prepared.source } : {}), ...(typeof options.retries === "number" && Number.isInteger(options.retries) && options.retries >= 0 ? { retries: options.retries } : {}), ...(positiveInteger(options.timeoutMs) || options.timeoutMs === null ? { timeoutMs: options.timeoutMs } : {}) });
          const cancel = () => { scheduler.cancel(spawned.id); };
          if (agentSignal.aborted) cancel(); else agentSignal.addEventListener("abort", cancel, { once: true });
          const outcome = await spawned.result.finally(() => { agentSignal.removeEventListener("abort", cancel); });
          if (!outcome.ok) throw new WorkflowError(outcome.error.code as WorkflowErrorCode, outcome.error.message);
          await store.complete(path, outcome.value);
          return outcome.value;
        } finally { await lifecycle.leave(); }
      }, checkpoint: checkpointBridge(runId, store, checked.metadata, Boolean(params.foreground), params.foreground && ctx.hasUI ? ctx.ui : undefined), phase: async (phase) => {
        await lifecycle.enter();
        try {
          const run = await store.updateState((current) => ({ ...current, phase }));
          runs.get(runId)?.update?.(workflowToolUpdate(run));
        } finally { await lifecycle.leave(); }
      }, log: async () => { await lifecycle.enter(); await lifecycle.leave(); } }, store), signal);
      (runs.get(runId) as NonNullable<ReturnType<typeof runs.get>>).execution = execution;
      if (background) emitAsyncStarted(store, checked.metadata);
      const finish = execution.result.then(async (value) => { await scheduler.flush(); await lifecycle.terminal("completed"); return value; }, async (error: unknown) => { await scheduler.flush(); const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", String(error)); if (lifecycle.state !== "stopped" && lifecycle.state !== "interrupted") await lifecycle.terminal(typed.code === "CANCELLED" ? "stopped" : "failed"); await store.updateState((current) => ({ ...current, error: { code: typed.code, message: typed.message } })); throw typed; });
      if (background) {
        void finish.then(async (value) => {
          const resultPath = await store.saveResult(value);
          emitAsyncComplete(store, "complete");
          deliver(pi, completionDelivery(checked.metadata.name, value, resultPath, await store.changedWorktrees()));
        }, (error: unknown) => { emitAsyncComplete(store, lifecycle.state === "stopped" ? "stopped" : "failed", error as Error); deliver(pi, `Workflow ${checked.metadata.name} failed: ${error instanceof Error ? error.message : String(error)}`); });
        return { content: [{ type: "text" as const, text: JSON.stringify({ runId, state: "running" }) }], details: { runId, preview: `Started workflow ${runId}.` } };
      }
      const value = await finish;
      const run = (await store.load()).run;
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: { runId, value, run } };
    },
    renderCall(args) {
      return textBlock(formatWorkflowPreview(args));
    },
    renderResult(result, { isPartial }, _theme, context) {
      const details = result.details as { run?: PersistedRun; value?: JsonValue; preview?: string } | undefined;
      const state = context.state as { workflowSpinner?: ReturnType<typeof setInterval> };
      if (details?.run && isPartial && details.run.state === "running" && !state.workflowSpinner) {
        state.workflowSpinner = setInterval(context.invalidate, 80);
        state.workflowSpinner.unref();
      } else if ((!isPartial || details?.run?.state !== "running") && state.workflowSpinner) {
        clearInterval(state.workflowSpinner);
        delete state.workflowSpinner;
      }
      if (details?.run) return workflowProgressBlock(details.run);
      const content = result.content[0];
      return textBlock(isPartial ? "Workflow starting..." : details?.preview ?? (content?.type === "text" ? content.text : "Workflow finished"));
    },
  });
  pi.registerCommand("workflow", {
    description: "Inspect and control workflows for this Pi session",
    handler: async (args, ctx) => {
      let command = args.trim();
      if (command === "doctor") {
        const { doctor, doctorExitCode, formatDoctorReport } = await import("./doctor.js");
        const report = await doctor({ cwd: ctx.cwd, activeTools: pi.getActiveTools().filter((tool) => tool !== "workflow" && tool !== "workflow_respond") });
        ctx.ui.notify(formatDoctorReport(report), doctorExitCode(report) ? "warning" : "info");
        return;
      }
      const stores = await Promise.all((await listRunIds(ctx.cwd, ctx.sessionManager.getSessionId(), home)).map(async (runId) => {
        const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
        return { store, loaded: await store.load() };
      }));
      if (!command) {
        if (!stores.length) { ctx.ui.notify("No workflow runs in this session.", "info"); return; }
        if (!ctx.hasUI) {
          const details = await Promise.all(stores.map(async ({ store, loaded }) => formatNavigatorRun(loaded, await store.awaitingCheckpoints(), await store.worktrees())));
          ctx.ui.notify(details.join("\n\n"), "info"); return;
        }
        const sorted = navigatorAttentionSort(stores);
        const labels = navigatorRunLabels(sorted);
        const terminalStates = new Set(["completed", "failed", "stopped"]);
        const hasCompleted = sorted.some(({ loaded: { run } }) => run.state === "completed");
        const pickerOptions = [...labels, ...(hasCompleted ? ["Delete all completed"] : []), "Close"];
        const runChoice = await ctx.ui.select("Workflows\n", pickerOptions);
        if (!runChoice || runChoice === "Close") return;
        if (runChoice === "Delete all completed") {
          if (!await ctx.ui.confirm("Delete completed runs?", "Delete all completed workflow runs and their artifacts? This cannot be undone.")) return;
          for (const entry of sorted) {
            if (entry.loaded.run.state === "completed") { await entry.store.delete(true); runs.delete(entry.store.runId); }
          }
          ctx.ui.notify("Deleted all completed workflow runs.", "info"); return;
        }
        const runIndex = labels.indexOf(runChoice);
        if (runIndex < 0) return;
        const selected = sorted[runIndex];
        if (!selected) return;
        const { store } = selected;
        const loadDashboard = async () => {
          const loaded = await store.load();
          const checkpoints = await store.awaitingCheckpoints();
          const actions = new Map<string, string>();
          const add = (label: string, value: string) => { actions.set(label, `${value} ${store.runId}`); };
          if (loaded.run.state === "running") add("Pause", "pause");
          if (["paused", "interrupted"].includes(loaded.run.state)) add("Resume", "resume");
          if (!terminalStates.has(loaded.run.state)) add("Stop", "stop");
          for (const cp of checkpoints) {
            actions.set(`Approve ${cp.name}`, `approve ${store.runId} ${cp.name}`);
            actions.set(`Reject ${cp.name}`, `reject ${store.runId} ${cp.name}`);
          }
          if (ctx.mode !== "tui") actions.set("Refresh", "refresh");
          else actions.set("View script", "view-script");
          const transcripts = [...new Set([...loaded.run.agents.flatMap((agent) => (agent.attemptDetails ?? []).map((attempt) => attempt.sessionFile)), ...loaded.run.nativeSessions.map(({ sessionFile }) => sessionFile)])];
          if (transcripts.length) actions.set("Transcript paths", "transcripts");
          if (terminalStates.has(loaded.run.state)) add("Delete", "delete");
          return { dashboard: formatNavigatorDashboard(loaded.run, checkpoints, await store.worktrees()), actions, transcripts, script: loaded.snapshot.script };
        };
        for (;;) {
          let view = await loadDashboard();
          const actionChoice = ctx.mode === "tui"
            ? await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
                let options = [...view.actions.keys(), "Close"];
                let selectedIndex = 0;
                let refreshing = false;
                let disposed = false;
                const timer = setInterval(() => {
                  if (refreshing) return;
                  refreshing = true;
                  const selectedOption = options[selectedIndex];
                  void loadDashboard().then((next) => {
                    if (disposed) return;
                    view = next;
                    options = [...view.actions.keys(), "Close"];
                    selectedIndex = Math.max(0, options.indexOf(selectedOption ?? ""));
                    tui.requestRender();
                  }).catch(() => undefined).finally(() => { refreshing = false; });
                }, 1000);
                timer.unref();
                return {
                  render(width: number) {
                    const dashboard = truncateToVisualLines(theme.fg("accent", view.dashboard), Number.MAX_SAFE_INTEGER, width, 1).visualLines;
                    const rows = options.map((option, index) => truncateToVisualLines(`${index === selectedIndex ? "→ " : "  "}${option}`, Number.MAX_SAFE_INTEGER, width, 1).visualLines[0] ?? "");
                    const hint = truncateToVisualLines(theme.fg("dim", "↑↓ navigate · enter select · esc close · auto-refresh 1s"), Number.MAX_SAFE_INTEGER, width, 1).visualLines[0] ?? "";
                    return [...dashboard, "", ...rows, "", hint];
                  },
                  invalidate() {},
                  handleInput(data: string) {
                    if (keybindings.matches(data, "tui.select.up")) selectedIndex = (selectedIndex + options.length - 1) % options.length;
                    else if (keybindings.matches(data, "tui.select.down")) selectedIndex = (selectedIndex + 1) % options.length;
                    else if (keybindings.matches(data, "tui.select.confirm")) done(options[selectedIndex]);
                    else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
                    tui.requestRender();
                  },
                  dispose() { disposed = true; clearInterval(timer); },
                };
              })
            : await ctx.ui.select(view.dashboard, [...view.actions.keys(), "Close"]);
          if (!actionChoice || actionChoice === "Close") return;
          if (actionChoice === "Refresh") continue;
          if (actionChoice === "View script") {
            await ctx.ui.custom<string | undefined>((tui, theme, keybindings, done) => {
              const highlighted = highlightCode(view.script, "javascript");
              let offset = 0;
              let renderedLines: string[] = [];
              const viewport = () => Math.max(1, tui.terminal.rows - 3);
              const move = (delta: number) => {
                const maxOffset = Math.max(0, renderedLines.length - viewport());
                offset = Math.max(0, Math.min(maxOffset, offset + delta));
              };
              return {
                render(width: number) {
                  renderedLines = highlighted.flatMap((line) => line ? truncateToVisualLines(line, Number.MAX_SAFE_INTEGER, width, 0).visualLines : [""]);
                  const maxOffset = Math.max(0, renderedLines.length - viewport());
                  offset = Math.min(offset, maxOffset);
                  return [
                    theme.fg("accent", "Workflow script"),
                    ...renderedLines.slice(offset, offset + viewport()),
                    "",
                    theme.fg("dim", "↑↓/pgup/pgdn scroll · esc close"),
                  ];
                },
                invalidate() {},
                handleInput(data: string) {
                  if (keybindings.matches(data, "tui.select.up")) move(-1);
                  else if (keybindings.matches(data, "tui.select.down")) move(1);
                  else if (keybindings.matches(data, "tui.select.pageUp")) move(-viewport());
                  else if (keybindings.matches(data, "tui.select.pageDown")) move(viewport());
                  else if (keybindings.matches(data, "tui.select.cancel")) done(undefined);
                  tui.requestRender();
                },
              };
            });
            continue;
          }
          if (actionChoice === "Transcript paths") { await ctx.ui.select("Native Pi transcript paths", [...view.transcripts, "Back"]); continue; }
          command = view.actions.get(actionChoice) ?? "";
          break;
        }
      }
      const [action, runId, ...rest] = command.split(/\s+/);
      const run = runId ? runs.get(runId) : undefined;
      const storedEntry = runId ? stores.find(({ store }) => store.runId === runId) : undefined;
      const stored = storedEntry ? { store: storedEntry.store, loaded: await storedEntry.store.load() } : undefined;
      if ((action === "approve" || action === "reject") && runId && rest.length) {
        const accepted = await answerCheckpoint(runId, rest.join(" "), action === "approve", true);
        ctx.ui.notify(accepted ? `${action === "approve" ? "Approved" : "Rejected"} checkpoint ${rest.join(" ")}.` : "Checkpoint is not awaiting a response.", accepted ? "info" : "warning"); return;
      }
      if (action === "delete" && stored) {
        if (!["completed", "failed", "stopped"].includes(stored.loaded.run.state)) { ctx.ui.notify("Stop the workflow before deleting it.", "warning"); return; }
        if (!await ctx.ui.confirm("Delete workflow?", `Delete ${stored.loaded.run.workflowName} (${stored.store.runId}) and all owned artifacts? This cannot be undone.`)) return;
        await stored.store.delete(true); runs.delete(stored.store.runId); ctx.ui.notify(`Deleted workflow ${stored.store.runId}.`, "info"); return;
      }
      if (action === "pause" && run) { await run.lifecycle.pause(); ctx.ui.notify(`Paused workflow ${run.store.runId}.`, "info"); return; }
      if (action === "resume" && run) {
        if (run.lifecycle.state === "interrupted") {
          await coldResumeRun(run, ctx.hasUI, ctx.ui);
        } else await run.lifecycle.resume();
        ctx.ui.notify(`Resumed workflow ${run.store.runId}.`, "info"); return;
      }
      if (action === "stop" && run) {
        await run.lifecycle.terminal("stopped"); run.execution?.cancel(); await scheduler.cancelRun(run.store.runId); await scheduler.flush();
        ctx.ui.notify(`Stopped workflow ${run.store.runId}.`, "info"); return;
      }
      ctx.ui.notify("Usage: /workflow [doctor], or /workflow pause|resume|stop|approve|reject|delete <run-id> [checkpoint]", "warning");
    },
  });
  pi.on("session_shutdown", async () => {
    await Promise.all([...runs.entries()].map(async ([runId, run]) => {
      if (["completed", "failed", "stopped"].includes(run.lifecycle.state)) return;
      await run.lifecycle.terminal("interrupted");
      run.execution?.cancel();
      await scheduler.cancelRun(runId);
    }));
    await scheduler.flush();
  });
}

function modelSpec(value: string, fallback: ModelSpec): ModelSpec {
  try {
    const parsed = parseModelReference(value);
    return { ...parsed, ...(parsed.thinking || !fallback.thinking ? {} : { thinking: fallback.thinking }) };
  } catch {
    return fallback;
  }
}

export { projectStorageKey, RunStore, runsDirectory, structuralPath } from "./persistence.js";
export type { AwaitingCheckpoint, CompletedOperation, NativeSessionReference, PersistedOwnershipNode, PersistedRun, WorktreeReference } from "./persistence.js";
export { FairAgentScheduler, WorkflowAgentExecutor } from "./agent-execution.js";
export type { AgentAccounting, AgentAttempt, AgentContinuationLineage, AgentContinuationSource, AgentDefinition, AgentExecutionOptions, AgentExecutionResult, AgentExecutionRoot, AgentProgress, AgentSessionConfig, AgentToolCallProgress } from "./agent-execution.js";
export { doctor, doctorExitCode, formatDoctorReport } from "./doctor.js";
export type { DoctorDiagnostic, DoctorOptions, DoctorPiState, DoctorReport, DoctorRole, DoctorSeverity, DoctorTrust, DoctorWorkflow } from "./doctor.js";