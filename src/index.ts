import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { Script } from "node:vm";
import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FairAgentScheduler, WorkflowAgentExecutor, type AgentAttempt } from "./agent-execution.js";
import { listRunIds, RunStore, structuralPath as operationPath } from "./persistence.js";
import type { AwaitingCheckpoint, PersistedRun, WorktreeReference } from "./persistence.js";

export const RUN_STATES = ["queued", "running", "pausing", "paused", "awaiting_input", "completed", "failed", "stopped", "interrupted"] as const;
export const AGENT_STATES = ["queued", "running", "waiting_for_child", "paused", "retrying", "completed", "failed", "cancelled"] as const;
export const ERROR_CODES = [
  "INVALID_SETTINGS", "INVALID_SYNTAX", "INVALID_METADATA", "DUPLICATE_NAME", "UNKNOWN_PHASE", "INVALID_SCHEMA",
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
export interface WorkSuccess<T extends JsonValue = JsonValue> { name: string; ok: true; value: T }
export interface WorkFailure { name: string; ok: false; failedAt: string; error: WorkflowErrorShape }
export type WorkResult<T extends JsonValue = JsonValue> = WorkSuccess<T> | WorkFailure;
export interface ModelSpec { provider: string; model: string; thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }
export interface ExtensionRequirement { name: string; version: string }
export interface WorkflowMetadata { name: string; description: string; phases?: readonly string[]; extensions?: readonly ExtensionRequirement[] }
export interface WorkflowSettings { concurrency: number; maxAgents: number; agentTimeoutMs: number | null }
export interface AgentAttemptSummary { attempt: number; sessionId: string; sessionFile: string; error?: { code: string; message: string }; accounting: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } }
export interface AgentRecord { id: string; name: string; path: string; state: AgentState; parentId?: string; model: ModelSpec; tools: readonly string[]; attempts: number; attemptDetails?: readonly AgentAttemptSummary[]; accounting?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number } }
export interface RunRecord { id: string; workflowName: string; cwd: string; sessionId: string; state: RunState; phase?: string; agents: readonly AgentRecord[]; error?: WorkflowErrorShape }
export interface LaunchSnapshot { script: string; args: JsonValue; metadata: WorkflowMetadata; settings: WorkflowSettings; models: readonly string[]; tools: readonly string[]; agentTypes: readonly string[]; extensions: Readonly<Record<string, string>>; schemas: readonly JsonSchema[] }
export interface PreflightCapabilities { models: ReadonlySet<string>; tools: ReadonlySet<string>; agentTypes: ReadonlySet<string>; extensions: Readonly<Record<string, string>> }
export interface PreflightResult { metadata: WorkflowMetadata; referenced: { phases: readonly string[]; models: readonly string[]; tools: readonly string[]; agentTypes: readonly string[] }; schemas: readonly JsonSchema[] }
export interface WorkflowOrchestrationContext {
  agent: (...args: readonly unknown[]) => Promise<JsonValue>;
  parallel: (...args: readonly unknown[]) => Promise<JsonValue>;
  pipeline: (...args: readonly unknown[]) => Promise<JsonValue>;
  checkpoint: (...args: readonly unknown[]) => Promise<boolean>;
  phase: (name: string) => void;
  log: (message: string) => void;
}
export interface WorkflowDslMethod { description: string; input: JsonSchema; output: JsonSchema; run: (input: Readonly<Record<string, JsonValue>>, context: Readonly<WorkflowOrchestrationContext>) => Promise<JsonValue> | JsonValue }
export interface WorkflowDslExtension { name: string; version: string; headline: string; description: string; methods: Readonly<Record<string, WorkflowDslMethod>> }
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

export const DEFAULT_SETTINGS: Readonly<WorkflowSettings> = Object.freeze({ concurrency: 8, maxAgents: 1000, agentTimeoutMs: null });

function fail(code: WorkflowErrorCode, message: string): never { throw new WorkflowError(code, message); }
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function positiveInteger(value: unknown): value is number { return Number.isInteger(value) && (value as number) > 0; }
function modelCapability(value: string): string {
  const slash = value.indexOf("/");
  const colon = value.lastIndexOf(":");
  if (colon <= slash) return value;
  if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.slice(colon + 1))) fail("UNKNOWN_MODEL", `Invalid thinking level: ${value.slice(colon + 1)}`);
  return value.slice(0, colon);
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
  const allowed = new Set(["concurrency", "maxAgents", "agentTimeoutMs"]);
  const unknown = Object.keys(parsed).find((key) => !allowed.has(key));
  if (unknown) fail("INVALID_SETTINGS", `Unknown workflow setting: ${unknown}`);
  const concurrency = parsed.concurrency === undefined ? DEFAULT_SETTINGS.concurrency : parsed.concurrency;
  const maxAgents = parsed.maxAgents === undefined ? DEFAULT_SETTINGS.maxAgents : parsed.maxAgents;
  const agentTimeoutMs = parsed.agentTimeoutMs === undefined ? DEFAULT_SETTINGS.agentTimeoutMs : parsed.agentTimeoutMs;
  if (!positiveInteger(concurrency) || concurrency > 16) fail("INVALID_SETTINGS", "concurrency must be an integer from 1 to 16");
  if (!positiveInteger(maxAgents)) fail("INVALID_SETTINGS", "maxAgents must be a positive integer");
  if (agentTimeoutMs !== null && !positiveInteger(agentTimeoutMs)) fail("INVALID_SETTINGS", "agentTimeoutMs must be null or a positive integer");
  return Object.freeze({ concurrency, maxAgents, agentTimeoutMs });
}

function extractObject(source: string, start: number): string {
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = start; i < source.length; i += 1) {
    const char = source[i] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === "\"" || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{") depth += 1;
    if (char === "}" && --depth === 0) return source.slice(start, i + 1);
  }
  fail("INVALID_METADATA", "Workflow metadata object is incomplete");
}

function parseMetadata(source: string): WorkflowMetadata {
  const match = /^\s*export\s+const\s+meta\s*=\s*/.exec(source);
  if (!match) fail("INVALID_METADATA", "First statement must export const meta");
  const start = match[0].length;
  if (source[start] !== "{") fail("INVALID_METADATA", "Workflow metadata must be an object literal");
  let value: unknown;
  try { value = new Script(`(${extractObject(source, start)})`).runInNewContext({}, { timeout: 50 }) as unknown; }
  catch (error) { fail("INVALID_METADATA", `Invalid workflow metadata: ${(error as Error).message}`); }
  if (!object(value) || typeof value.name !== "string" || value.name.trim() === "" || typeof value.description !== "string" || value.description.trim() === "") fail("INVALID_METADATA", "Workflow metadata requires non-empty name and description");
  const allowed = new Set(["name", "description", "phases", "extensions"]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) fail("INVALID_METADATA", `Unknown workflow metadata: ${unknown}`);
  const phases: unknown = value.phases ?? [];
  if (!Array.isArray(phases) || phases.some((phase: unknown) => typeof phase !== "string" || phase.trim() === "")) fail("INVALID_METADATA", "phases must contain non-empty strings");
  const validPhases = phases as string[];
  if (new Set(validPhases).size !== validPhases.length) fail("DUPLICATE_NAME", "Workflow phases must be unique");
  const extensions: unknown = value.extensions ?? [];
  if (!Array.isArray(extensions) || extensions.some((item: unknown) => !object(item) || typeof item.name !== "string" || item.name === "" || typeof item.version !== "string" || item.version === "" || Object.keys(item).some((key) => key !== "name" && key !== "version"))) fail("INVALID_METADATA", "extensions must contain name/version objects");
  const validExtensions = extensions as Array<{ name: string; version: string }>;
  if (new Set(validExtensions.map(({ name }) => name)).size !== validExtensions.length) fail("DUPLICATE_NAME", "Workflow extension requirements must be unique");
  return { name: value.name.trim(), description: value.description.trim(), phases: Object.freeze([...validPhases]), extensions: Object.freeze(validExtensions.map(({ name, version }) => Object.freeze({ name, version }))) };
}

function stringsFor(source: string, key: string): string[] {
  const values: string[] = [];
  const pattern = new RegExp(`\\b${key}\\s*:\\s*(["'])((?:\\\\.|(?!\\1).)*)\\1`, "g");
  for (const match of source.matchAll(pattern)) if (match[2] !== undefined) values.push(match[2]);
  return values;
}

function phaseCalls(source: string): string[] {
  return [...source.matchAll(/\bphase\s*\(\s*(["'])((?:\\.|(?!\1).)*)\1/g)].map((match) => match[2] ?? "");
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

export class WorkflowDslRegistry {
  readonly #extensions = new Map<string, Readonly<WorkflowDslExtension>>();

  register(extension: WorkflowDslExtension): void {
    if (!object(extension) || !/^[A-Za-z_$][\w$]*$/.test(extension.name) || !/^\d+\.\d+\.\d+$/.test(extension.version) || !extension.headline.trim() || !extension.description.trim() || !object(extension.methods) || Object.keys(extension.methods).length === 0) fail("INVALID_METADATA", "Workflow DSL extensions require a name, semantic version, headline, description, and methods");
    if (this.#extensions.has(extension.name)) fail("DUPLICATE_NAME", `Workflow DSL extension already registered: ${extension.name}`);
    for (const [name, method] of Object.entries(extension.methods)) {
      if (!/^[A-Za-z_$][\w$]*$/.test(name) || !object(method) || typeof method.description !== "string" || method.description.trim() === "" || typeof method.run !== "function") fail("INVALID_METADATA", `Invalid workflow DSL method: ${extension.name}.${name}`);
      validateSchema(method.input, `${extension.name}.${name} input`);
      validateSchema(method.output, `${extension.name}.${name} output`);
      if (method.input.type !== "object") fail("INVALID_SCHEMA", `${extension.name}.${name} input must describe one object`);
    }
    this.#extensions.set(extension.name, deepFreeze(extension));
  }

  versions(): Readonly<Record<string, string>> {
    return Object.freeze(Object.fromEntries([...this.#extensions].map(([name, extension]) => [name, extension.version])));
  }

  namespaces(): Readonly<Record<string, Readonly<Record<string, WorkflowDslMethod>>>> {
    return Object.freeze(Object.fromEntries([...this.#extensions].map(([name, extension]) => [name, extension.methods])));
  }

  async invoke(extensionName: string, methodName: string, input: unknown, context: WorkflowOrchestrationContext, path: string, journal: WorkflowMacroJournal): Promise<JsonValue> {
    const extension = this.#extensions.get(extensionName);
    const method = extension?.methods[methodName];
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
function callsFor(source: string, name: string): string[] {
  const calls: string[] = [];
  const pattern = new RegExp(`\\b${name}\\s*\\(`, "g");
  for (const match of source.matchAll(pattern)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let quote = "";
    let escaped = false;
    for (let index = start; index < source.length; index += 1) {
      const char = source[index] ?? "";
      if (quote) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === quote) quote = "";
      } else if (char === "\"" || char === "'" || char === "`") quote = char;
      else if (char === "(") depth += 1;
      else if (char === ")" && --depth === 0) { calls.push(source.slice(start, index)); break; }
    }
  }
  return calls;
}

function splitTopLevel(source: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index] ?? "";
    if (quote) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === quote) quote = "";
    } else if (char === "\"" || char === "'" || char === "`") quote = char;
    else if ("([{ ".includes(char) && char !== " ") depth += 1;
    else if (")] }".includes(char) && char !== " ") depth -= 1;
    else if (char === "," && depth === 0) { parts.push(source.slice(start, index)); start = index + 1; }
  }
  parts.push(source.slice(start));
  return parts.filter((part) => part.trim() !== "");
}

function named(part: string): boolean { return /\b(?:name|label)\s*:\s*["'][^"']+["']/.test(part); }
function namedArray(argument: string): boolean {
  const value = argument.trim();
  return value.startsWith("[") && value.endsWith("]") && splitTopLevel(value.slice(1, -1)).every(named);
}

export function preflight(script: string, capabilities: PreflightCapabilities, schemas: readonly unknown[] = []): PreflightResult {
  if (typeof script !== "string" || script.trim() === "") fail("INVALID_SYNTAX", "Workflow script must be non-empty");
  try { new Script(`(async()=>{${script.replace(/^\s*export\s+const\s+meta/, "const meta")}\n})`); }
  catch (error) { fail("INVALID_SYNTAX", `Invalid workflow syntax: ${(error as Error).message}`); }
  const metadata = parseMetadata(script);
  for (const [index, schema] of schemas.entries()) validateSchema(schema, `schema[${String(index)}]`);
  const phases = phaseCalls(script);
  const declared = new Set(metadata.phases);
  const unknownPhase = phases.find((phase) => !declared.has(phase));
  if (unknownPhase) fail("UNKNOWN_PHASE", `Undeclared phase: ${unknownPhase}`);
  const namedCalls = ["agent", "parallel", "pipeline", "checkpoint"].flatMap((operation) => callsFor(script, operation).map((body) => ({ operation, body })));
  const unnamed = namedCalls.filter(({ operation }) => operation === "agent" || operation === "checkpoint").find(({ body }) => !named(body));
  if (unnamed) fail("INVALID_METADATA", `${unnamed.operation} requires a stable explicit name`);
  for (const body of callsFor(script, "parallel")) {
    const [tasks = "", operation = "", ...extra] = splitTopLevel(body);
    if (!namedArray(tasks)) fail("INVALID_METADATA", "Every parallel task requires a stable explicit name");
    if (!named(operation) || extra.length > 0) fail("INVALID_METADATA", "parallel requires a stable explicit name");
  }
  for (const body of callsFor(script, "pipeline")) {
    const [items = "", ...stages] = splitTopLevel(body);
    const operation = stages.pop() ?? "";
    if (!namedArray(items)) fail("INVALID_METADATA", "Every pipeline item requires a stable explicit name");
    if (stages.length === 0 || stages.some((stage) => !named(stage))) fail("INVALID_METADATA", "Every pipeline stage requires a stable explicit name");
    if (!named(operation)) fail("INVALID_METADATA", "pipeline requires a stable explicit name");
  }
  const names = namedCalls.flatMap(({ body }) => stringsFor(body, "name").concat(stringsFor(body, "label")));
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) fail("DUPLICATE_NAME", `Duplicate stable name: ${duplicate}`);
  const models = stringsFor(script, "model").map(modelCapability);
  const tools = [...script.matchAll(/\btools\s*:\s*\[([^\]]*)\]/g)].flatMap((match) => [...((match[1] ?? "").matchAll(/(["'])((?:\\.|(?!\1).)*)\1/g))].map((item) => item[2] ?? ""));
  const agentTypes = stringsFor(script, "agentType");
  const missingModel = models.find((model) => !capabilities.models.has(model));
  if (missingModel) fail("UNKNOWN_MODEL", `Unknown model: ${missingModel}`);
  const missingTool = tools.find((tool) => !capabilities.tools.has(tool));
  if (missingTool) fail("UNKNOWN_TOOL", `Unknown tool: ${missingTool}`);
  const missingType = agentTypes.find((type) => !capabilities.agentTypes.has(type));
  if (missingType) fail("UNKNOWN_AGENT_TYPE", `Unknown agent type: ${missingType}`);
  for (const requirement of metadata.extensions ?? []) {
    const actual = capabilities.extensions[requirement.name];
    if (!actual) fail("MISSING_EXTENSION", `Required extension is unavailable: ${requirement.name}`);
    if (!versionCompatible(requirement.version, actual)) fail("INCOMPATIBLE_EXTENSION", `Extension ${requirement.name} requires ${requirement.version}, found ${actual}`);
  }
  return Object.freeze({ metadata: deepFreeze(metadata), referenced: deepFreeze({ phases, models, tools, agentTypes }), schemas: deepFreeze([...schemas]) as readonly JsonSchema[] });
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
  agent?: (prompt: string, options: Readonly<Record<string, JsonValue>>, signal: AbortSignal) => Promise<JsonValue>;
  checkpoint?: (input: Readonly<Record<string, JsonValue>>, signal: AbortSignal) => boolean | Promise<boolean>;
  extension?: (extension: string, method: string, input: Readonly<Record<string, JsonValue>>, path: string, signal: AbortSignal) => Promise<JsonValue>;
  extensions?: Readonly<Record<string, readonly string[]>>;
  phase?: (name: string) => void | Promise<void>;
  log?: (message: string) => void | Promise<void>;
}

export interface WorkflowExecution { result: Promise<JsonValue>; cancel: () => void }

const workerSource = String.raw`
const { parentPort, workerData } = require("node:worker_threads");
const vm = require("node:vm");
const LIMIT = workerData.limit;
let nextId = 0;
let cancelled = false;
const pending = new Map();
const inflight = new Set();
function send(value) {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > LIMIT) throw Object.assign(new Error("RPC value exceeds the 10 MB JSON boundary"), { code: "RPC_LIMIT_EXCEEDED" });
  parentPort.postMessage(json);
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
parentPort.on("message", raw => {
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
const workError = (code, message) => Object.assign(new Error(message), { code });
const failure = (name, failedAt, error) => ({ name, ok: false, failedAt, error: { code: error.code || "INTERNAL_ERROR", message: error.message } });
const named = (value, kind) => { if (!value || typeof value.name !== "string" || !value.name.trim()) throw workError("INVALID_METADATA", kind + " requires a stable explicit name"); return value.name; };
const unique = (values, kind) => { const names = values.map(value => named(value, kind)); if (new Set(names).size !== names.length) throw workError("DUPLICATE_NAME", "Duplicate " + kind + " name"); return names; };
const path = (...names) => names.map(encodeURIComponent).join("/");
const agent = (prompt, options = {}) => rpc("agent", [prompt, options]);
const checkpoint = input => rpc("checkpoint", [input]);
const phase = name => rpc("phase", [name]);
const log = message => rpc("log", [message]);
const extensions = Object.freeze(Object.fromEntries(Object.entries(workerData.extensions).map(([extension, methods]) => [extension, Object.freeze(Object.fromEntries(methods.map(method => [method, input => rpc("extension", [extension, method, input, path("extension", extension, method)])])))])));
const parallel = async (tasks, operation) => {
  const operationName = named(operation, "parallel");
  if (!Array.isArray(tasks)) throw workError("INVALID_METADATA", "parallel tasks must be an array");
  const taskNames = unique(tasks, "parallel task");
  return Promise.all(tasks.map(async (task, index) => {
    const name = taskNames[index];
    const failedAt = path(operationName, name);
    try { return { name, ok: true, value: await task.run() }; }
    catch (error) { if (error.code === "CANCELLED") throw error; return failure(name, failedAt, error); }
  }));
};
const pipeline = async (items, ...parts) => {
  const operation = parts.pop();
  const operationName = named(operation, "pipeline");
  if (!Array.isArray(items)) throw workError("INVALID_METADATA", "pipeline items must be an array");
  const itemNames = unique(items, "pipeline item");
  const stageNames = unique(parts, "pipeline stage");
  if (!stageNames.length) throw workError("INVALID_METADATA", "pipeline requires at least one named stage");
  return Promise.all(items.map(async (item, index) => {
    const name = itemNames[index];
    let value = item.value;
    let failedAt = path(operationName, name);
    try {
      for (let stageIndex = 0; stageIndex < parts.length; stageIndex += 1) {
        failedAt = path(operationName, name, stageNames[stageIndex]);
        value = await parts[stageIndex].run(value);
      }
      return { name, ok: true, value };
    } catch (error) { if (error.code === "CANCELLED") throw error; return failure(name, failedAt, error); }
  }));
};
const safeMath = Object.fromEntries(Object.getOwnPropertyNames(Math).filter(name => name !== "random").map(name => [name, Math[name]]));
const sandbox = { agent, checkpoint, parallel, pipeline, phase, log, extensions, args: workerData.args, Promise, JSON, Math: Object.freeze(safeMath) };
for (const name of ["Date","eval","Function","WebAssembly","process","require","module","exports","console","fetch","XMLHttpRequest","WebSocket","performance","crypto","setTimeout","setInterval","setImmediate","queueMicrotask","Intl","SharedArrayBuffer","Atomics"]) sandbox[name] = undefined;
const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
const body = workerData.script.replace(/^\s*export\s+const\s+meta/, "const meta");
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
  const worker = new Worker(workerSource, { eval: true, execArgv: process.execArgv.filter((argument) => !argument.startsWith("--input-type")), workerData: { script, args: structuredClone(args), extensions: bridge.extensions ?? {}, limit: RPC_LIMIT_BYTES } });
  const controller = new AbortController();
  let settled = false;
  let rejectResult: (error: WorkflowError) => void = () => undefined;
  let watchdog = setTimeout(() => { stop("WORKER_UNRESPONSIVE", "Workflow worker missed its five-second heartbeat"); }, HEARTBEAT_TIMEOUT_MS);
  const result = new Promise<JsonValue>((resolve, reject) => {
    rejectResult = reject;
    worker.on("message", (raw: unknown) => {
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
    worker.on("error", (error: Error) => { stop("INTERNAL_ERROR", error.message); });
    worker.on("exit", (code) => { if (!settled && code !== 0) stop("INTERNAL_ERROR", `Workflow worker exited with code ${String(code)}`); });
  });
  function finish() { settled = true; clearTimeout(watchdog); signal?.removeEventListener("abort", cancel); void worker.terminate(); }
  function stop(code: WorkflowErrorCode, message: string) { if (settled) return; controller.abort(); finish(); rejectResult(new WorkflowError(code, message)); }
  async function handleRpc(id: number, method: string, values: JsonValue[]) {
    try {
      encoded(values);
      let value: JsonValue = null;
      if (method === "agent") {
        if (!bridge.agent) fail("AGENT_FAILED", "No agent bridge is available");
        if (typeof values[0] !== "string") fail("INTERNAL_ERROR", "agent prompt must be a string");
        value = await bridge.agent(values[0], object(values[1]) ? values[1] : {}, controller.signal);
      } else if (method === "checkpoint") {
        if (!bridge.checkpoint || !object(values[0])) fail("INTERNAL_ERROR", "checkpoint requires an available bridge and object input");
        value = await bridge.checkpoint(values[0], controller.signal);
        if (typeof value !== "boolean") fail("INTERNAL_ERROR", "checkpoint must return a boolean");
      } else if (method === "extension") {
        if (!bridge.extension || typeof values[0] !== "string" || typeof values[1] !== "string" || !object(values[2]) || typeof values[3] !== "string") fail("INTERNAL_ERROR", "extension requires an available bridge, names, object input, and path");
        value = await bridge.extension(values[0], values[1], values[2], values[3], controller.signal);
      } else if (method === "phase") {
        if (typeof values[0] !== "string") fail("INTERNAL_ERROR", "phase name must be a string");
        await bridge.phase?.(values[0]);
      } else if (method === "log") {
        if (typeof values[0] !== "string") fail("INTERNAL_ERROR", "log message must be a string");
        await bridge.log?.(values[0]);
      }
      else fail("INTERNAL_ERROR", `Unknown worker RPC method: ${method}`);
      encoded(value);
      worker.postMessage(encoded({ type: "rpcResult", id, ok: true, value }));
    } catch (error) {
      const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", (error as Error).message);
      worker.postMessage(encoded({ type: "rpcResult", id, ok: false, error: { code: typed.code, message: typed.message } }));
    }
  }
  function cancel() {
    if (settled) return;
    controller.abort();
    worker.postMessage(encoded({ type: "cancel" }));
    stop("CANCELLED", "Workflow cancelled");
  }
  if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
  return { result, cancel };
}

export async function persistAgentAttempts(store: RunStore, id: string, attempts: readonly AgentAttempt[]): Promise<void> {
  const loaded = await store.load();
  if (!loaded.run.agents.some((agent) => agent.id === id)) throw new WorkflowError("INTERNAL_ERROR", `Missing production ownership record: ${id}`);
  const total = attempts.reduce((sum, attempt) => ({ input: sum.input + attempt.accounting.input, output: sum.output + attempt.accounting.output, cacheRead: sum.cacheRead + attempt.accounting.cacheRead, cacheWrite: sum.cacheWrite + attempt.accounting.cacheWrite, cost: sum.cost + attempt.accounting.cost }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
  const attemptDetails = attempts.map(({ attempt, sessionId, sessionFile, error, accounting }) => ({ attempt, sessionId, sessionFile, ...(error ? { error } : {}), accounting }));
  await store.saveState({ ...loaded.run, agents: loaded.run.agents.map((agent) => agent.id === id ? { ...agent, attempts: attempts.length, attemptDetails, accounting: total } : agent), nativeSessions: [...loaded.run.nativeSessions, ...attempts.map(({ sessionId, sessionFile }) => ({ sessionId, sessionFile }))] });
}

type WorkflowToolUpdate = { content: [{ type: "text"; text: string }]; details: { runId: string; run: PersistedRun } };

export function formatWorkflowProgress(run: PersistedRun): string {
  const settled = new Set(["completed", "failed", "cancelled"]);
  const done = run.agents.filter((agent) => settled.has(agent.state)).length;
  const lines = [`${run.state === "completed" ? "✓" : run.state === "failed" || run.state === "stopped" ? "✗" : "◆"} Workflow: ${run.workflowName} (${String(done)}/${String(run.agents.length)} done)`];
  if (run.phase) lines.push(`  Phase: ${run.phase}`);
  const byId = new Map(run.agents.map((agent) => [agent.id, agent]));
  for (const [index, agent] of run.agents.entries()) {
    let depth = 0;
    for (let parent = agent.parentId; parent && byId.has(parent); parent = byId.get(parent)?.parentId) depth += 1;
    const icon = agent.state === "completed" ? "✓" : agent.state === "failed" || agent.state === "cancelled" ? "✗" : agent.state === "running" ? "◇" : "○";
    lines.push(`${"  ".repeat(depth + 1)}#${String(index + 1)} ${icon} ${agent.name} [${agent.state}]`);
  }
  return lines.join("\n");
}

function workflowToolUpdate(run: PersistedRun): WorkflowToolUpdate {
  return { content: [{ type: "text", text: formatWorkflowProgress(run) }], details: { runId: run.id, run } };
}

function textBlock(text: string) {
  return {
    render(width: number) {
      return text.split("\n").map((line) => line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`);
    },
    invalidate() {},
  };
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

function namedHostOperation(value: unknown, kind: string): { name: string; run?: (value?: JsonValue) => JsonValue | Promise<JsonValue>; value?: JsonValue } {
  if (!object(value) || typeof value.name !== "string" || value.name.trim() === "") fail("INVALID_METADATA", `${kind} requires a stable explicit name`);
  return value as { name: string; run?: (value?: JsonValue) => JsonValue | Promise<JsonValue>; value?: JsonValue };
}

async function hostParallel(rawTasks: unknown, rawOperation: unknown): Promise<JsonValue> {
  if (!Array.isArray(rawTasks)) fail("INVALID_METADATA", "parallel tasks must be an array");
  const operation = namedHostOperation(rawOperation, "parallel");
  const tasks = rawTasks.map((task) => namedHostOperation(task, "parallel task"));
  if (new Set(tasks.map(({ name }) => name)).size !== tasks.length) fail("DUPLICATE_NAME", "Duplicate parallel task name");
  return Promise.all(tasks.map(async ({ name, run }) => {
    try {
      if (!run) fail("INVALID_METADATA", "parallel tasks require run functions");
      return { name, ok: true, value: await run() };
    } catch (error) {
      const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
      if (typed.code === "CANCELLED") throw typed;
      return { name, ok: false, failedAt: operationPath(operation.name, name), error: { code: typed.code, message: typed.message } };
    }
  }));
}

async function hostPipeline(rawItems: unknown, ...parts: unknown[]): Promise<JsonValue> {
  if (!Array.isArray(rawItems)) fail("INVALID_METADATA", "pipeline items must be an array");
  const operation = namedHostOperation(parts.pop(), "pipeline");
  const items = rawItems.map((item) => namedHostOperation(item, "pipeline item"));
  const stages = parts.map((stage) => namedHostOperation(stage, "pipeline stage"));
  if (!stages.length) fail("INVALID_METADATA", "pipeline requires at least one named stage");
  if (new Set(items.map(({ name }) => name)).size !== items.length || new Set(stages.map(({ name }) => name)).size !== stages.length) fail("DUPLICATE_NAME", "Duplicate pipeline item or stage name");
  return Promise.all(items.map(async ({ name, value }) => {
    let current = value ?? null;
    let failedAt = operationPath(operation.name, name);
    try {
      for (const stage of stages) {
        failedAt = operationPath(operation.name, name, stage.name);
        if (!stage.run) fail("INVALID_METADATA", "pipeline stages require run functions");
        current = await stage.run(current);
      }
      return { name, ok: true, value: current };
    } catch (error) {
      const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
      if (typed.code === "CANCELLED") throw typed;
      return { name, ok: false, failedAt, error: { code: typed.code, message: typed.message } };
    }
  }));
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
        const options = object(args[1]) && jsonValue(args[1]) ? args[1] as Readonly<Record<string, JsonValue>> : {};
        return bridge.agent(args[0], options, signal);
      },
      parallel: (...args: readonly unknown[]) => hostParallel(args[0], args[1]),
      pipeline: (...args: readonly unknown[]) => hostPipeline(args[0], ...args.slice(1)),
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

export default function workflowExtension(pi: ExtensionAPI, home?: string) {
  const runs = new Map<string, { executor: WorkflowAgentExecutor; store: RunStore; metadata: WorkflowMetadata; timeoutMs: number | null; model: ModelSpec; lifecycle: RunLifecycle; execution?: WorkflowExecution; checkpointResolvers: Map<string, (value: boolean) => void>; update?: (result: WorkflowToolUpdate) => void }>();
  const lifecycleFor = (store: RunStore, state: RunState) => new RunLifecycle(state, async (next) => {
    const loaded = await store.load();
    const run = { ...loaded.run, state: next };
    await store.saveState(run);
    runs.get(store.runId)?.update?.(workflowToolUpdate(run));
  });
  const scheduler = new FairAgentScheduler(async ({ id, runId, parentId, prompt, options, signal, setSteer }) => {
    const run = runs.get(runId);
    if (!run) throw new WorkflowError("INTERNAL_ERROR", `Unknown production run: ${runId}`);
    try {
      const result = await run.executor.execute(prompt, { label: options.label, workflowName: run.metadata.name, workflowDescription: run.metadata.description, ...(parentId ? { parent: parentId, cwd: options.cwd, ...(options.isolation ? { parentIsolation: "worktree" as const, worktreeOwner: options.worktreeOwner ?? options.label } : {}) } : options.isolation ? { isolation: options.isolation, worktreeOwner: options.worktreeOwner ?? options.label } : {}), ...(options.model ? { model: options.model } : {}), tools: options.tools, ...(options.schema ? { schema: options.schema } : {}), ...(options.retries === undefined ? {} : { retries: options.retries }), timeoutMs: options.timeoutMs === undefined ? run.timeoutMs : options.timeoutMs }, signal, scheduler.toolsFor(id), setSteer, () => { scheduler.cancelChildren(id); });
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
    const loaded = await run.store.load();
    const existing = new Map(loaded.run.agents.map((agent) => [agent.id, agent]));
    const agents = ownership.map((node) => {
      const previous = existing.get(node.id);
      return { id: node.id, name: node.label, path: node.id, state: node.state, ...(node.parentId ? { parentId: node.parentId } : {}), model: node.options.model ? modelSpec(node.options.model, run.model) : run.model, tools: node.options.tools, attempts: previous?.attempts ?? 0, ...(previous?.attemptDetails ? { attemptDetails: previous.attemptDetails } : {}), ...(previous?.accounting ? { accounting: previous.accounting } : {}) };
    });
    const runState = { ...loaded.run, agents };
    await run.store.saveState(runState);
    run.update?.(workflowToolUpdate(runState));
  });
  const answerCheckpoint = async (runId: string, name: string, approved: boolean) => {
    const run = runs.get(runId);
    if (!run) return false;
    const checkpoint = await run.store.answerCheckpoint(name, approved);
    if (!checkpoint) return false;
    if ((await run.store.awaitingCheckpoints()).length === 0) await run.lifecycle.resolveAwaitingInput();
    run.checkpointResolvers.get(checkpoint.path)?.(approved);
    run.checkpointResolvers.delete(checkpoint.path);
    deliver(pi, `Workflow ${run.metadata.name} checkpoint ${name}: ${approved ? "Approved" : "Rejected"}.`);
    return true;
  };
  const checkpointBridge = (runId: string, store: RunStore, metadata: WorkflowMetadata, foreground: boolean, ui?: { select?: (prompt: string, options: string[]) => Promise<string | undefined> }) => async (raw: Readonly<Record<string, JsonValue>>, signal: AbortSignal): Promise<boolean> => {
    const input = validateCheckpoint(raw);
    const path = operationPath("checkpoint", input.name);
    if (foreground && !ui?.select) fail("RESUME_INCOMPATIBLE", "Foreground checkpoints require UI");
    const alreadyAwaiting = (await store.awaitingCheckpoints()).some((checkpoint) => checkpoint.path === path);
    const replayed = await store.awaitCheckpoint({ path, ...input });
    if (replayed !== undefined) return replayed;
    const run = runs.get(runId);
    await run?.lifecycle.enterAwaitingInput();
    if (run?.checkpointResolvers.has(path)) fail("DUPLICATE_NAME", `Checkpoint ${input.name} is already active`);
    if (!alreadyAwaiting) deliver(pi, `Workflow ${metadata.name} checkpoint ${input.name}: ${input.prompt}\nContext: ${JSON.stringify(input.context)}\nRespond with workflow_respond.`);
    const decision = new Promise<boolean>((resolve, reject) => {
      run?.checkpointResolvers.set(path, resolve);
      if (signal.aborted) reject(new WorkflowError("CANCELLED", "Workflow cancelled"));
      else signal.addEventListener("abort", () => { run?.checkpointResolvers.delete(path); reject(new WorkflowError("CANCELLED", "Workflow cancelled")); }, { once: true });
    });
    const answered = await store.awaitCheckpoint({ path, ...input });
    if (answered !== undefined) {
      if ((await store.awaitingCheckpoints()).length === 0) await run?.lifecycle.resolveAwaitingInput();
      run?.checkpointResolvers.get(path)?.(answered);
      run?.checkpointResolvers.delete(path);
    }
    if (ui?.select) void (async () => {
      while (!signal.aborted && run?.checkpointResolvers.has(path)) {
        const choice = await ui.select?.(input.prompt, ["Approve", "Reject"]);
        if (choice && await answerCheckpoint(runId, input.name, choice === "Approve")) return;
      }
    })().catch(() => undefined);
    return decision;
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

  pi.on("session_start", async (_event, ctx) => {
    for (const runId of await listRunIds(ctx.cwd, ctx.sessionManager.getSessionId(), home)) {
      if (runs.has(runId)) continue;
      const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
      const loaded = await store.load();
      if (["completed", "failed", "stopped"].includes(loaded.run.state)) continue;
      const model = modelSpec(loaded.snapshot.models[0] ?? "", { provider: ctx.model?.provider ?? "", model: ctx.model?.id ?? "", thinking: pi.getThinkingLevel() });
      const lifecycle = lifecycleFor(store, loaded.run.state);
      const providerPause = async () => { deliver(pi, `Workflow ${loaded.snapshot.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      runs.set(runId, { executor: new WorkflowAgentExecutor({ cwd: ctx.cwd, model, tools: new Set(loaded.snapshot.tools.filter((tool) => pi.getActiveTools().includes(tool))), runStore: store, providerPause }), store, metadata: loaded.snapshot.metadata, timeoutMs: loaded.snapshot.settings.agentTimeoutMs, model, lifecycle, checkpointResolvers: new Map() });
      for (const checkpoint of await store.awaitingCheckpoints()) deliver(pi, `Workflow ${loaded.snapshot.metadata.name} checkpoint ${checkpoint.name}: ${checkpoint.prompt}\nContext: ${JSON.stringify(checkpoint.context)}\nRespond with workflow_respond.`);
      scheduler.restoreRun(runId, loaded.snapshot.settings.concurrency, loaded.snapshot.settings.maxAgents, await store.loadOwnership());
    }
  });

  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: "Run a deterministic JavaScript workflow",
    parameters: Type.Object({
      script: Type.String({ description: "Immutable JavaScript workflow source" }),
      args: Type.Optional(Type.Unknown({ description: "JSON-compatible workflow arguments" })),
      foreground: Type.Optional(Type.Boolean({ description: "Wait for completion instead of running in the background" })),
      concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 16 })),
      maxAgents: Type.Optional(Type.Integer({ minimum: 1 })),
      agentTimeoutMs: Type.Optional(Type.Union([Type.Integer({ minimum: 1 }), Type.Null()])),
    }),
    async execute(_id, params, signal, onUpdate, ctx) {
      if (!ctx.model) throw new WorkflowError("UNKNOWN_MODEL", "A launching model is required");
      const defaults = loadSettings();
      const settings = Object.freeze({ concurrency: params.concurrency ?? defaults.concurrency, maxAgents: params.maxAgents ?? defaults.maxAgents, agentTimeoutMs: params.agentTimeoutMs === undefined ? defaults.agentTimeoutMs : params.agentTimeoutMs });
      const rootModel: ModelSpec = { provider: ctx.model.provider, model: ctx.model.id, thinking: pi.getThinkingLevel() };
      const rootModelName = `${rootModel.provider}/${rootModel.model}`;
      const modelRegistry = (ctx as unknown as { modelRegistry?: { getAvailable(): Array<{ provider: string; id: string }> } }).modelRegistry;
      const availableModels = new Set((modelRegistry?.getAvailable() ?? [ctx.model]).map((model) => `${model.provider}/${model.id}`));
      availableModels.add(rootModelName);
      const rootTools = pi.getActiveTools().filter((name) => name !== "workflow" && name !== "workflow_respond");
      const checked = preflight(params.script, { models: availableModels, tools: new Set(rootTools), agentTypes: new Set(), extensions: workflowDslRegistry.versions() });
      const runId = randomUUID();
      const store = new RunStore(ctx.cwd, ctx.sessionManager.getSessionId(), runId, home);
      const snapshot = createLaunchSnapshot({ script: params.script, args: (params.args ?? null) as JsonValue, metadata: checked.metadata, settings, models: [rootModelName, ...checked.referenced.models.filter((model) => model !== rootModelName)], tools: rootTools, agentTypes: [], extensions: workflowDslRegistry.versions(), schemas: checked.schemas });
      await store.create({ id: runId, workflowName: checked.metadata.name, cwd: ctx.cwd, sessionId: ctx.sessionManager.getSessionId(), state: "running", agents: [], nativeSessions: [] }, snapshot);
      const lifecycle = lifecycleFor(store, "running");
      const background = !params.foreground;
      const providerPause = async () => { if (background) deliver(pi, `Workflow ${checked.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      const executor = new WorkflowAgentExecutor({ cwd: ctx.cwd, model: rootModel, tools: new Set(rootTools), runStore: store, providerPause });
      runs.set(runId, { executor, store, metadata: checked.metadata, timeoutMs: settings.agentTimeoutMs, model: rootModel, lifecycle, checkpointResolvers: new Map(), ...(params.foreground && onUpdate ? { update: onUpdate } : {}) });
      if (params.foreground && onUpdate) onUpdate(workflowToolUpdate((await store.load()).run));
      scheduler.addRun(runId, settings.concurrency, settings.maxAgents);
      const topLevel = new Set<Promise<unknown>>();
      const execution = runWorkflow(params.script, (params.args ?? null) as JsonValue, withExtensions({ agent: async (prompt, options, agentSignal) => {
        await lifecycle.enter();
        try {
        const requestedTools = Array.isArray(options.tools) && options.tools.every((tool) => typeof tool === "string") ? options.tools : rootTools;
        const label = typeof options.name === "string" ? options.name : "agent";
        const path = operationPath("agent", label);
        const replayed = await store.replay(path);
        if (replayed) return replayed.value;
        const isolation = options.isolation === "worktree" ? "worktree" as const : undefined;
        const cwd = isolation ? (await store.worktree(label)).cwd : ctx.cwd;
        const spawned = scheduler.spawn(runId, prompt, { label, cwd, tools: requestedTools, ...(isolation ? { isolation, worktreeOwner: label } : {}), ...(typeof options.model === "string" ? { model: options.model } : {}), ...(object(options.schema) ? { schema: options.schema } : {}), ...(typeof options.retries === "number" && Number.isInteger(options.retries) && options.retries >= 0 ? { retries: options.retries } : {}), ...(positiveInteger(options.timeoutMs) || options.timeoutMs === null ? { timeoutMs: options.timeoutMs } : {}) });
        topLevel.add(spawned.result);
        const cancel = () => { scheduler.cancel(spawned.id); };
        if (agentSignal.aborted) cancel(); else agentSignal.addEventListener("abort", cancel, { once: true });
          const outcome = await spawned.result.finally(() => { topLevel.delete(spawned.result); agentSignal.removeEventListener("abort", cancel); });
          if (!outcome.ok) throw new WorkflowError(outcome.error.code as WorkflowErrorCode, outcome.error.message);
          await store.complete(path, outcome.value);
          return outcome.value;
        } finally { await lifecycle.leave(); }
      }, checkpoint: checkpointBridge(runId, store, checked.metadata, Boolean(params.foreground), params.foreground && ctx.hasUI ? ctx.ui : undefined), phase: async (phase) => {
        await lifecycle.enter();
        try {
          const loaded = await store.load();
          const run = { ...loaded.run, phase };
          await store.saveState(run);
          runs.get(runId)?.update?.(workflowToolUpdate(run));
        } finally { await lifecycle.leave(); }
      }, log: async () => { await lifecycle.enter(); await lifecycle.leave(); } }, store), signal);
      (runs.get(runId) as NonNullable<ReturnType<typeof runs.get>>).execution = execution;
      const finish = execution.result.then(async (value) => { await scheduler.flush(); await lifecycle.terminal("completed"); return value; }, async (error: unknown) => { await Promise.allSettled(topLevel); await scheduler.flush(); const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", String(error)); if (lifecycle.state !== "stopped" && lifecycle.state !== "interrupted") await lifecycle.terminal(typed.code === "CANCELLED" ? "stopped" : "failed"); const loaded = await store.load(); await store.saveState({ ...loaded.run, error: { code: typed.code, message: typed.message } }); throw typed; });
      if (background) {
        void finish.then(async (value) => {
          const resultPath = await store.saveResult(value);
          deliver(pi, completionDelivery(checked.metadata.name, value, resultPath, await store.changedWorktrees()));
        }, (error: unknown) => { deliver(pi, `Workflow ${checked.metadata.name} failed: ${error instanceof Error ? error.message : String(error)}`); });
        const run = (await store.load()).run;
        return { content: [{ type: "text" as const, text: JSON.stringify({ runId, state: "running" }) }], details: { runId, run } };
      }
      const value = await finish;
      const run = (await store.load()).run;
      return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: { runId, value, run } };
    },
    renderCall(args) {
      let name: string;
      try { name = parseMetadata(args.script).name; } catch { name = "workflow"; }
      return textBlock(`workflow ${name}`);
    },
    renderResult(result, { isPartial }) {
      const details = result.details as { run?: PersistedRun; value?: JsonValue } | undefined;
      if (details?.run) return textBlock(formatWorkflowProgress(details.run));
      const content = result.content[0];
      return textBlock(isPartial ? "Workflow starting..." : content?.type === "text" ? content.text : "Workflow finished");
    },
  });
  pi.registerCommand("workflow", {
    description: "Inspect and control workflows for this Pi session",
    handler: async (args, ctx) => {
      let command = args.trim();
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
        const details: string[] = [];
        const actions = new Map<string, string>();
        for (const { store, loaded } of stores) {
          const checkpoints = await store.awaitingCheckpoints();
          details.push(formatNavigatorRun(loaded, checkpoints, await store.worktrees()));
          const add = (label: string, value: string) => { actions.set(`${loaded.run.workflowName} (${store.runId}): ${label}`, `${value} ${store.runId}`); };
          if (loaded.run.state === "running") add("Pause", "pause");
          if (["paused", "interrupted"].includes(loaded.run.state)) add("Resume", "resume");
          if (!["completed", "failed", "stopped"].includes(loaded.run.state)) add("Stop", "stop");
          for (const checkpoint of checkpoints) {
            actions.set(`${loaded.run.workflowName} (${store.runId}): Approve ${checkpoint.name}`, `approve ${store.runId} ${checkpoint.name}`);
            actions.set(`${loaded.run.workflowName} (${store.runId}): Reject ${checkpoint.name}`, `reject ${store.runId} ${checkpoint.name}`);
          }
          if (["completed", "failed", "stopped"].includes(loaded.run.state)) add("Delete", "delete");
        }
        const choice = await ctx.ui.select(`Workflow runs for this cwd and Pi session\n\n${details.join("\n\n")}`, [...actions.keys(), "Close"]);
        if (!choice || choice === "Close") return;
        command = actions.get(choice) ?? "";
      }
      const [action, runId, ...rest] = command.split(/\s+/);
      const run = runId ? runs.get(runId) : undefined;
      const stored = runId ? stores.find(({ store }) => store.runId === runId) : undefined;
      if ((action === "approve" || action === "reject") && runId && rest.length) {
        const accepted = await answerCheckpoint(runId, rest.join(" "), action === "approve");
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
          const loaded = await run.store.load();
          const active = new Set(pi.getActiveTools().filter((tool) => tool !== "workflow" && tool !== "workflow_respond"));
          const missing = loaded.snapshot.tools.find((tool) => !active.has(tool));
          if (missing) throw new WorkflowError("RESUME_INCOMPATIBLE", `Required tool is unavailable: ${missing}`);
          preflight(loaded.snapshot.script, { models: new Set(loaded.snapshot.models), tools: active, agentTypes: new Set(loaded.snapshot.agentTypes), extensions: workflowDslRegistry.versions() }, loaded.snapshot.schemas);
          await scheduler.cancelRun(run.store.runId);
          await run.lifecycle.resume();
          const execution = runWorkflow(loaded.snapshot.script, loaded.snapshot.args, withExtensions({ agent: async (prompt, options, signal) => {
            await run.lifecycle.enter();
            try {
              const label = typeof options.name === "string" ? options.name : "agent";
              const path = operationPath("agent", label);
              const replayed = await run.store.replay(path);
              if (replayed) return replayed.value;
              const tools = Array.isArray(options.tools) && options.tools.every((tool) => typeof tool === "string") ? options.tools : loaded.snapshot.tools;
              const isolation = options.isolation === "worktree" ? "worktree" as const : undefined;
              const cwd = isolation ? (await run.store.worktree(label)).cwd : run.store.cwd;
              const spawned = scheduler.spawn(run.store.runId, prompt, { label, cwd, tools, ...(isolation ? { isolation, worktreeOwner: label } : {}), ...(typeof options.model === "string" ? { model: options.model } : {}), ...(object(options.schema) ? { schema: options.schema } : {}), ...(typeof options.retries === "number" ? { retries: options.retries } : {}), ...(positiveInteger(options.timeoutMs) || options.timeoutMs === null ? { timeoutMs: options.timeoutMs } : {}) });
              const cancel = () => { scheduler.cancel(spawned.id); };
              signal.addEventListener("abort", cancel, { once: true });
              const outcome = await spawned.result.finally(() => { signal.removeEventListener("abort", cancel); });
              if (!outcome.ok) throw new WorkflowError(outcome.error.code as WorkflowErrorCode, outcome.error.message);
              await run.store.complete(path, outcome.value);
              return outcome.value;
            } finally { await run.lifecycle.leave(); }
          }, checkpoint: checkpointBridge(run.store.runId, run.store, run.metadata, false, ctx.hasUI ? ctx.ui : undefined), phase: async (phase) => { await run.lifecycle.enter(); try { const current = await run.store.load(); await run.store.saveState({ ...current.run, phase }); } finally { await run.lifecycle.leave(); } }, log: async () => { await run.lifecycle.enter(); await run.lifecycle.leave(); } }, run.store));
          run.execution = execution;
          void execution.result.then(async () => { await scheduler.flush(); await run.lifecycle.terminal("completed"); }, async (error: unknown) => { await scheduler.flush(); if (run.lifecycle.state !== "stopped" && run.lifecycle.state !== "interrupted") await run.lifecycle.terminal("failed"); const current = await run.store.load(); const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", String(error)); await run.store.saveState({ ...current.run, error: { code: typed.code, message: typed.message } }); });
        } else await run.lifecycle.resume();
        ctx.ui.notify(`Resumed workflow ${run.store.runId}.`, "info"); return;
      }
      if (action === "stop" && run) {
        await run.lifecycle.terminal("stopped"); run.execution?.cancel(); await scheduler.cancelRun(run.store.runId); await scheduler.flush();
        ctx.ui.notify(`Stopped workflow ${run.store.runId}.`, "info"); return;
      }
      ctx.ui.notify("Usage: /workflow, or /workflow pause|resume|stop|approve|reject|delete <run-id> [checkpoint]", "warning");
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
  const slash = value.indexOf("/");
  return slash > 0 ? { provider: value.slice(0, slash), model: value.slice(slash + 1), ...(fallback.thinking ? { thinking: fallback.thinking } : {}) } : fallback;
}

export { projectStorageKey, RunStore, runsDirectory, structuralPath } from "./persistence.js";
export type { AwaitingCheckpoint, CompletedOperation, NativeSessionReference, PersistedOwnershipNode, PersistedRun, WorktreeReference } from "./persistence.js";
export { FairAgentScheduler, WorkflowAgentExecutor } from "./agent-execution.js";
export type { AgentAccounting, AgentAttempt, AgentDefinition, AgentExecutionOptions, AgentExecutionResult, AgentExecutionRoot } from "./agent-execution.js";