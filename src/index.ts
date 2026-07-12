import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Script } from "node:vm";
import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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
export interface AgentRecord { id: string; name: string; path: string; state: AgentState; parentId?: string; model: ModelSpec; tools: readonly string[]; attempts: number }
export interface RunRecord { id: string; workflowName: string; cwd: string; sessionId: string; state: RunState; phase?: string; agents: readonly AgentRecord[]; error?: WorkflowErrorShape }
export interface LaunchSnapshot { script: string; args: JsonValue; metadata: WorkflowMetadata; settings: WorkflowSettings; models: readonly string[]; tools: readonly string[]; agentTypes: readonly string[]; extensions: Readonly<Record<string, string>>; schemas: readonly JsonSchema[] }
export interface PreflightCapabilities { models: ReadonlySet<string>; tools: ReadonlySet<string>; agentTypes: ReadonlySet<string>; extensions: Readonly<Record<string, string>> }
export interface PreflightResult { metadata: WorkflowMetadata; referenced: { phases: readonly string[]; models: readonly string[]; tools: readonly string[]; agentTypes: readonly string[] }; schemas: readonly JsonSchema[] }

export class WorkflowError extends Error {
  constructor(public readonly code: WorkflowErrorCode, message: string) { super(message); this.name = "WorkflowError"; }
}

export const DEFAULT_SETTINGS: Readonly<WorkflowSettings> = Object.freeze({ concurrency: 8, maxAgents: 1000, agentTimeoutMs: null });

function fail(code: WorkflowErrorCode, message: string): never { throw new WorkflowError(code, message); }
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function positiveInteger(value: unknown): value is number { return Number.isInteger(value) && (value as number) > 0; }

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

function validateSchema(schema: unknown, at = "schema"): asserts schema is JsonSchema {
  if (!object(schema)) fail("INVALID_SCHEMA", `${at} must be a plain JSON Schema object`);
  try { JSON.stringify(schema); } catch { fail("INVALID_SCHEMA", `${at} must be JSON-compatible`); }
  if (typeof schema.type !== "string" && !Array.isArray(schema.type) && schema.$ref === undefined && schema.anyOf === undefined && schema.oneOf === undefined && schema.allOf === undefined && schema.const === undefined && schema.enum === undefined) fail("INVALID_SCHEMA", `${at} has no JSON Schema shape`);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) fail("INVALID_SCHEMA", `${at}.required must be an array of strings`);
  if (schema.properties !== undefined && !object(schema.properties)) fail("INVALID_SCHEMA", `${at}.properties must be an object`);
}

function versionCompatible(required: string, actual: string): boolean {
  if (required === actual) return true;
  if (/^\d+\.x$/.test(required)) return actual.startsWith(`${required.split(".")[0] ?? ""}.`);
  if (/^\^\d+\.\d+\.\d+$/.test(required)) return actual.split(".")[0] === required.slice(1).split(".")[0];
  return false;
}

export function preflight(script: string, capabilities: PreflightCapabilities, schemas: readonly unknown[] = []): PreflightResult {
  if (typeof script !== "string" || script.trim() === "") fail("INVALID_SYNTAX", "Workflow script must be non-empty");
  try { new Script(script.replace(/^\s*export\s+const\s+meta/, "const meta")); }
  catch (error) { fail("INVALID_SYNTAX", `Invalid workflow syntax: ${(error as Error).message}`); }
  const metadata = parseMetadata(script);
  for (const [index, schema] of schemas.entries()) validateSchema(schema, `schema[${String(index)}]`);
  const phases = phaseCalls(script);
  const declared = new Set(metadata.phases);
  const unknownPhase = phases.find((phase) => !declared.has(phase));
  if (unknownPhase) fail("UNKNOWN_PHASE", `Undeclared phase: ${unknownPhase}`);
  const namedCalls = [...script.matchAll(/\b(agent|parallel|pipeline|checkpoint)\s*\(([^;]*)\)/g)];
  const unnamed = namedCalls.find((match) => !/\b(?:name|label)\s*:\s*["'][^"']+["']/.test(match[2] ?? ""));
  if (unnamed) fail("INVALID_METADATA", `${unnamed[1] ?? "Operation"} requires a stable explicit name`);
  const names = namedCalls.flatMap((match) => stringsFor(match[2] ?? "", "name").concat(stringsFor(match[2] ?? "", "label")));
  const duplicate = names.find((name, index) => names.indexOf(name) !== index);
  if (duplicate) fail("DUPLICATE_NAME", `Duplicate stable name: ${duplicate}`);
  const models = stringsFor(script, "model");
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

export default function workflowExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: "Run a deterministic JavaScript workflow",
    parameters: Type.Object({
      script: Type.String({ description: "Immutable JavaScript workflow source" }),
      args: Type.Optional(Type.Unknown({ description: "JSON-compatible workflow arguments" })),
      foreground: Type.Optional(Type.Boolean({ description: "Wait for completion instead of running in the background" })),
    }),
    async execute() { throw new Error("Workflow execution is not implemented yet"); },
  });
  pi.registerCommand("workflow", {
    description: "Inspect and control workflows for this Pi session",
    handler: async (_args, ctx) => { ctx.ui.notify("No workflow runs in this session.", "info"); },
  });
}