#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ProjectTrustStore, SessionManager, SettingsManager, createAgentSessionFromServices, createAgentSessionServices, getAgentDir, hasTrustRequiringProjectResources, type ExtensionAPI, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { doctor, doctorExitCode, formatDoctorReport, type DoctorOptions } from "./doctor.js";
import { doctorCleanup, doctorCleanupExitCode, formatDoctorCleanupReport, type DoctorCleanupOptions } from "./doctor-cleanup.js";
import workflowExtension, { errorText, formatWorkflowProgress, isNodeError, jsonValue, loadAgentDefinitions, registeredWorkflowFunctions, truncateWorkflowProgress, workflowCatalog, workflowSettingsPath, type JsonSchema, type JsonValue, type WorkflowExtensionAPI, type WorkflowProgressStyles } from "pi-extensible-workflows";
import { portableEngineVersion, portablePiVersion, writePortableWorkflowBundle } from "./bundles.js";
import { runSessionInspector, transcriptFileLines, type InspectMode } from "./session-inspector.js";
import { isPersistedRun, listPersistedSessionIds, listRunIds, type PersistedRun } from "pi-extensible-workflows/persistence";
import { shareTrajectoryRun } from "pi-extensible-workflows/trajectory";
import type { WorkflowCatalogFunction } from "pi-extensible-workflows";

export interface CliOptions extends DoctorOptions { inspect?: (sessionId?: string, mode?: InspectMode, failedOnly?: boolean) => Promise<void>; transcript?: (sessionFile: string) => Promise<void>; stderr?: (text: string) => void; signal?: AbortSignal; trustOverride?: boolean; isTTY?: boolean; skillPaths?: readonly string[] }

type CliScalar = "string" | "integer" | "number" | "boolean";
type CliField = { name: string; option: string; schema: Record<string, unknown>; type: CliScalar | "array"; itemType?: CliScalar; required: boolean };
type CliSchemaPlan = { fields: readonly CliField[]; positional?: CliField };

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function has(value: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function requiredArg(args: readonly string[], index: number): string {
  const value = args[index];
  if (value === undefined) throw new Error("Missing argument");
  return value;
}
function typedOptionKey<T extends object>(options: T, key: string): key is Extract<keyof T, string> { return Object.prototype.hasOwnProperty.call(options, key); }
function clone(value: unknown): JsonValue { const cloned = structuredClone(value); if (!jsonValue(cloned)) throw new Error("Invalid JSON passed to --input"); return cloned; }
function kebabCase(value: string): string { return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/[_\s]+/g, "-").toLowerCase(); }

function isCliScalar(value: unknown): value is CliScalar { return value === "string" || value === "integer" || value === "number" || value === "boolean"; }
function scalarType(schema: unknown): CliScalar | undefined {
  if (!object(schema) || typeof schema.type !== "string") return undefined;
  return isCliScalar(schema.type) ? schema.type : undefined;
}

function schemaPlan(schema: JsonSchema): CliSchemaPlan {
  if (!object(schema) || schema.type !== "object") return { fields: [] };
  const properties = object(schema.properties) ? schema.properties : {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((name): name is string => typeof name === "string") : []);
  const fields: CliField[] = [];
  for (const [name, property] of Object.entries(properties)) {
    if (!object(property)) continue;
    const directType = scalarType(property);
    const itemType = object(property.items) ? scalarType(property.items) : undefined;
    const type = directType ?? itemType ? directType ?? "array" : undefined;
    if (!type) continue;
    fields.push({ name, option: `--${kebabCase(name)}`, schema: property, type, ...(itemType ? { itemType } : {}), required: required.has(name) });
  }
  const requiredScalars = fields.filter((field) => field.required && field.type !== "array");
  return { fields, ...(requiredScalars.length === 1 ? { positional: requiredScalars[0] } : {}) };
}

function scalarLabel(type: CliScalar): string { return type === "integer" ? "integer" : type; }
function scalarFieldType(field: CliField): CliScalar {
  if (field.type !== "array") return field.type;
  if (!isCliScalar(field.itemType)) throw new Error("Invalid array field");
  return field.itemType;
}
function fieldLabel(field: CliField): string { return field.type === "array" ? `${field.option} <${scalarLabel(scalarFieldType(field))}>` : `${field.option}${field.type === "boolean" ? "" : ` <${scalarLabel(field.type)}>`}`; }
function fieldDescription(field: CliField): string {
  const description = typeof field.schema.description === "string" ? field.schema.description.trim() : "";
  const required = field.required ? "required" : "optional";
  const defaultValue = has(field.schema, "default") ? ` default=${JSON.stringify(field.schema.default)}` : "";
  const enumSchema = field.type === "array" && object(field.schema.items) ? field.schema.items : field.schema;
  const enumValue = Array.isArray(enumSchema.enum) ? ` enum=${enumSchema.enum.map((value) => JSON.stringify(value)).join(",")}` : "";
  return [description, required, defaultValue, enumValue].filter(Boolean).join("; ");
}

export function formatWorkflowCliHelp(fn: WorkflowCatalogFunction, command = "piewf"): string {
  const plan = schemaPlan(fn.input);
  const lines = [`Usage: ${command} run ${fn.name}${plan.positional ? ` <${plan.positional.name}>` : ""} [options]`, "", fn.description];
  if (plan.positional) {
    lines.push("", "Arguments:", `  <${plan.positional.name}>  ${scalarLabel(scalarFieldType(plan.positional))}; ${fieldDescription(plan.positional)}`);
  }
  lines.push("", "Options:");
  for (const field of plan.fields) {
    const label = field === plan.positional ? `${field.option} <${scalarLabel(scalarFieldType(field))}>` : fieldLabel(field);
    lines.push(`  ${label.padEnd(24)}${fieldDescription(field)}`);
  }
  lines.push("  --input <json>".padEnd(28) + "JSON input escape hatch for complex schemas", ...launcherHelpLines(), "  -h, --help".padEnd(28) + "Show this help");
  return `${lines.join("\n")}\n`;
}

function enumAllows(schema: Record<string, unknown>, value: unknown): boolean {
  return !Array.isArray(schema.enum) || schema.enum.some((candidate) => JSON.stringify(candidate) === JSON.stringify(value));
}

function coerce(raw: string, type: CliScalar, schema: Record<string, unknown>): JsonValue {
  let value: JsonValue;
  if (type === "string") value = raw;
  else if (type === "integer") { if (!/^-?(?:0|[1-9]\d*)$/.test(raw)) throw new Error(`Invalid integer: ${raw}`); value = Number(raw); if (!Number.isSafeInteger(value)) throw new Error(`Invalid integer: ${raw}`); }
  else if (type === "number") { value = Number(raw); if (!Number.isFinite(value)) throw new Error(`Invalid number: ${raw}`); }
  else { if (raw !== "true" && raw !== "false") throw new Error(`Invalid boolean: ${raw}`); value = raw === "true"; }
  if (!enumAllows(schema, value)) throw new Error(`Invalid value for enum: ${raw}`);
  return value;
}

function parseJsonInput(value: string): JsonValue {
  try { return clone(JSON.parse(value)); } catch { throw new Error("Invalid JSON passed to --input"); }
}

export function parseWorkflowCliArgs(schema: JsonSchema, rawArgs: readonly string[]): Record<string, JsonValue> {
  const plan = schemaPlan(schema);
  const fields = new Map(plan.fields.map((field) => [field.option, field]));
  const result: Record<string, JsonValue> = {};
  let input: JsonValue | undefined;
  let positionalUsed = false;
  let endOptions = false;
  const assign = (field: CliField, raw: string) => {
    if (field.type === "array") {
      const current = result[field.name];
      const values: JsonValue[] = Array.isArray(current) ? current : [];
      const itemSchema = field.schema.items;
      if (!object(itemSchema)) throw new Error("Invalid array field");
      values.push(coerce(raw, scalarFieldType(field), itemSchema));
      result[field.name] = values;
    }
    else result[field.name] = coerce(raw, field.type, field.schema);
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = requiredArg(rawArgs, index);
    if (token === "--") { endOptions = true; continue; }
    if (!endOptions && (token === "--input" || token.startsWith("--input="))) {
      if (input !== undefined) throw new Error("--input may only be provided once");
      const raw = token.startsWith("--input=") ? token.slice("--input=".length) : rawArgs[++index];
      if (raw === undefined) throw new Error("Missing value for --input");
      input = parseJsonInput(raw);
      continue;
    }
    if (!endOptions && token.startsWith("--")) {
      const equals = token.indexOf("=");
      const option = equals >= 0 ? token.slice(0, equals) : token;
      const negated = equals < 0 && option.startsWith("--no-");
      const field = fields.get(negated ? `--${option.slice("--no-".length)}` : option);
      if (!field) throw new Error(`Unknown option: ${option}`);
      if (negated) {
        if (field.type !== "boolean") throw new Error(`Invalid boolean option: ${option}`);
        result[field.name] = false;
      } else if (field.type === "boolean") {
        if (equals >= 0) assign(field, token.slice(equals + 1));
        else if (rawArgs[index + 1] === "true" || rawArgs[index + 1] === "false") assign(field, requiredArg(rawArgs, ++index));
        else result[field.name] = true;
      } else {
        const raw = equals >= 0 ? token.slice(equals + 1) : rawArgs[++index];
        if (raw === undefined || raw.startsWith("--")) throw new Error(`Missing value for ${option}`);
        assign(field, raw);
      }
      continue;
    }
    const positional = plan.positional;
    const numericNegative = positional && (positional.type === "integer" || positional.type === "number") && /^-\d/.test(token);
    if (!endOptions && token.startsWith("-") && !numericNegative) throw new Error(`Unknown option: ${token}`);
    if (!positional || positionalUsed) throw new Error(`Unexpected argument: ${token}`);
    assign(positional, token);
    positionalUsed = true;
  }
  if (input !== undefined) {
    if (Object.keys(result).length || positionalUsed) throw new Error("--input cannot be combined with CLI arguments");
    if (!object(input)) throw new Error("Workflow input must be a JSON object");
    for (const field of plan.fields) if (!has(input, field.name) && has(field.schema, "default")) input[field.name] = clone(field.schema.default);
    return input;
  }
  for (const field of plan.fields) if (!has(result, field.name) && has(field.schema, "default")) result[field.name] = clone(field.schema.default);
  for (const field of plan.fields) if (field.required && !has(result, field.name)) throw new Error(`Missing required argument: ${field.name}`);
  return result;
}

function launcherHelpLines(): string[] {
  return [
    "  --approve".padEnd(28) + "Trust project resources for this launch",
    "  --no-approve".padEnd(28) + "Do not trust project resources for this launch",
    "  --".padEnd(28) + "End launcher option parsing; pass later tokens to workflow input",
  ];
}
function workflowUsage(): string { return [`Usage: piewf run <workflow-name> [workflow arguments] | run --script <path> [--name <workflow-name>] [--input <json>] | export <workflow-name> [--name <command>] [--output <path>] [--force]`, "", "Launcher options:", ...launcherHelpLines()].join("\n") + "\n"; }
function scriptWorkflowUsage(): string { return [`Usage: piewf run --script <path> [--name <workflow-name>] [--input <json>]`, "", "Options:", ...launcherHelpLines().slice(0, 2), "  -h, --help".padEnd(28) + "Show this help"].join("\n") + "\n"; }
type ScriptWorkflowCliArgs = { help: true } | { help: false; scriptPath: string; name: string; args: JsonValue };
function scriptWorkflowName(scriptPath: string): string {
  const filename = basename(scriptPath);
  const extension = extname(filename);
  return extension ? filename.slice(0, -extension.length) : filename;
}

export function parseScriptWorkflowCliArgs(rawArgs: readonly string[]): ScriptWorkflowCliArgs {
  let scriptPath: string | undefined;
  let name: string | undefined;
  let input: JsonValue | undefined;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = requiredArg(rawArgs, index);
    if (token === "--help" || token === "-h") return { help: true };
    const equals = token.indexOf("=");
    const option = equals >= 0 ? token.slice(0, equals) : token;
    if (option === "--script" || option === "--name" || option === "--input") {
      const value = equals >= 0 ? token.slice(equals + 1) : rawArgs[++index];
      if (!value?.trim()) throw new Error(`Missing value for ${option}`);
      if (option === "--script") {
        if (scriptPath !== undefined) throw new Error("--script may only be provided once");
        scriptPath = value;
      } else if (option === "--name") {
        if (name !== undefined) throw new Error("--name may only be provided once");
        name = value;
      } else {
        if (input !== undefined) throw new Error("--input may only be provided once");
        input = parseJsonInput(value);
      }
      continue;
    }
    throw new Error(`Unknown option: ${token}`);
  }
  if (scriptPath === undefined) throw new Error("Missing required option: --script");
  const workflowName = name === undefined ? scriptWorkflowName(scriptPath) : name.trim();
  if (!workflowName) throw new Error("Workflow name must be non-empty");
  return { help: false, scriptPath, name: workflowName, args: input ?? null };
}
function exportUsage(): string { return [`Usage: piewf export <workflow-name> [--name <command>] [--output <path>] [--force] [--bundle]`, "", "Launcher options:", ...launcherHelpLines()].join("\n") + "\n"; }
function bundleUsage(): string { return [`Usage: piewf bundle <workflow-name> [--name <command>] [--output <directory>] [--force]`, "", "The bundle contains a launcher, manifest, workflow payload, and external-runtime setup instructions.", "Repeat --role, --alias, --tool, --command, or --environment to declare recipient requirements.", "Use --extension, --skill, --resource, and --dependency to copy selected payload resources."].join("\n") + "\n"; }
function parseInspectArgs(rawArgs: readonly string[]): { sessionId?: string; mode: InspectMode; failedOnly: boolean } {
  let sessionId: string | undefined;
  let mode: InspectMode = "tui";
  let failedOnly = false;
  for (const arg of rawArgs) {
    if (arg === "--json" || arg === "--summary") {
      const next: InspectMode = arg === "--json" ? "json" : "summary";
      if (mode !== "tui" && mode !== next) throw new Error("inspect accepts only one output mode");
      mode = next;
    } else if (arg === "--failed") failedOnly = true;
    else if (arg.startsWith("--")) throw new Error(`Unknown inspect option: ${arg}`);
    else if (sessionId !== undefined) throw new Error(`Unexpected argument: ${arg}`);
    else sessionId = arg;
  }
  return { ...(sessionId ? { sessionId } : {}), mode: failedOnly && mode === "tui" ? "summary" : mode, failedOnly };
}
export function parseDoctorArgs(rawArgs: readonly string[]): { role?: string; prompt?: string; json?: boolean } {
  let role: string | undefined;
  let prompt: string | undefined;
  let json = false;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = requiredArg(rawArgs, index);
    const equals = token.indexOf("=");
    const option = equals >= 0 ? token.slice(0, equals) : token;
    if (option === "--json" && equals < 0) { json = true; continue; }
    if (option === "--role" || option === "--prompt") {
      const value = equals >= 0 ? token.slice(equals + 1) : rawArgs[++index];
      if (!value) throw new Error(`Missing value for ${option}`);
      if (option === "--role") { if (role !== undefined) throw new Error("--role may only be provided once"); role = value; }
      else { if (prompt !== undefined) throw new Error("--prompt may only be provided once"); prompt = value; }
      continue;
    }
    if (token === "--help" || token === "-h") throw new Error("help");
    if (token.startsWith("--")) throw new Error(`Unknown doctor option: ${token}`);
    if (role !== undefined) throw new Error(`Unexpected argument: ${token}`);
    role = token;
  }
  if (prompt !== undefined && role === undefined) throw new Error("--prompt requires --role");
  return { ...(role === undefined ? {} : { role }), ...(prompt === undefined ? {} : { prompt }), ...(json ? { json: true } : {}) };
}

export function parseDoctorCleanupArgs(rawArgs: readonly string[]): Required<Pick<DoctorCleanupOptions, "olderThanDays" | "yes">> {
  let olderThanDays = 90;
  let yes = false;
  let seenDays = false;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = requiredArg(rawArgs, index);
    if (token === "--yes") { yes = true; continue; }
    const inline = token.startsWith("--older-than-days=") ? token.slice("--older-than-days=".length) : undefined;
    if (token === "--older-than-days" || inline !== undefined) {
      if (seenDays) throw new Error("--older-than-days may only be provided once");
      const raw = inline ?? rawArgs[++index];
      if (raw === undefined || !/^[1-9]\d*$/.test(raw)) throw new Error("older-than-days must be a positive integer");
      const parsed = Number(raw);
      if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error("older-than-days must be a positive integer");
      olderThanDays = parsed; seenDays = true; continue;
    }
    throw new Error(`Unknown cleanup option: ${token}`);
  }
  return { olderThanDays, yes };
}
function stripTrustOptions(rawArgs: readonly string[]): { args: string[]; trustOverride?: boolean } {
  const args: string[] = [];
  let trustOverride: boolean | undefined;
  let endOptions = false;
  for (const arg of rawArgs) {
    if (arg === "--") { endOptions = true; args.push(arg); continue; }
    if (!endOptions && (arg === "--approve" || arg === "--no-approve")) {
      const next = arg === "--approve";
      if (trustOverride !== undefined && trustOverride !== next) throw new Error("--approve and --no-approve cannot be combined");
      trustOverride = next;
    } else args.push(arg);
  }
  return { args, ...(trustOverride !== undefined ? { trustOverride } : {}) };
}
type WorkflowIo = { write: (text: string) => void; stderr: (text: string) => void; cwd?: string; agentDir?: string; trustOverride?: boolean; isTTY?: boolean; signal?: AbortSignal; skillPaths?: readonly string[] };

type HeadlessExtensionAPI = WorkflowExtensionAPI & { events: Pick<ExtensionAPI["events"], "emit"> };
type HeadlessWorkflowResult = { content: Array<{ type: string; text: string }>; details?: unknown };
type HeadlessWorkflowTool = { name: "workflow"; execute: (toolCallId: string, params: Record<string, JsonValue>, signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined, context: unknown) => Promise<HeadlessWorkflowResult> };
function isHeadlessWorkflowResult(value: unknown): value is HeadlessWorkflowResult { return object(value) && Array.isArray(value.content) && value.content.every((entry) => object(entry) && typeof entry.type === "string" && typeof entry.text === "string"); }
function isHeadlessWorkflowTool(value: unknown): value is HeadlessWorkflowTool { return object(value) && value.name === "workflow" && typeof value.execute === "function"; }
type ShutdownHandler = (event: unknown, context: unknown) => Promise<void> | void;
type WorkflowRuntime = { catalog: ReturnType<typeof workflowCatalog>; services: Awaited<ReturnType<typeof createAgentSessionServices>>; workflowTool: HeadlessWorkflowTool; shutdownHandlers: ShutdownHandler[] };

async function createWorkflowRuntime(options: WorkflowIo, shutdownHandlers: ShutdownHandler[] = []): Promise<WorkflowRuntime> {
  const cwd = options.cwd ?? process.cwd();
  const agentDir = options.agentDir ?? getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const requiredTrust = hasTrustRequiringProjectResources(cwd);
  const trustStore = new ProjectTrustStore(agentDir);
  const defaultProjectTrust = settingsManager.getDefaultProjectTrust();
  const resolveProjectTrust = async ({ extensionsResult }: { extensionsResult: LoadExtensionsResult }): Promise<boolean> => {
    if (options.trustOverride !== undefined) return options.trustOverride;
    if (!requiredTrust) return true;
    const projectTrustContext = {
      cwd,
      mode: "print" as const,
      hasUI: false,
      ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify: () => {} },
    };
    for (const extension of extensionsResult.extensions) {
      for (const handler of extension.handlers.get("project_trust") ?? []) {
        try {
          const result: unknown = await handler({ type: "project_trust", cwd }, projectTrustContext);
          if (!object(result)) continue;
          if (result.trusted === "undecided") continue;
          if (result.trusted !== "yes" && result.trusted !== "no") continue;
          const trusted = result.trusted === "yes";
          if (result.remember === true) trustStore.set(cwd, trusted);
          return trusted;
        } catch { /* Project trust extensions are best effort, as in Pi. */ }
      }
    }
    const savedTrust = trustStore.get(cwd);
    if (savedTrust !== null) return savedTrust;
    return defaultProjectTrust === "always";
  };
  const services = await createAgentSessionServices({
    cwd,
    agentDir,
    settingsManager,
    resourceLoaderOptions: { ...(options.skillPaths?.length ? { additionalSkillPaths: [...options.skillPaths] } : {}) },
    resourceLoaderReloadOptions: { resolveProjectTrust },
  });
  const extensions = services.resourceLoader.getExtensions();
  const tools: unknown[] = [];
  const activeTools = [...new Set(["read", "bash", "edit", "write"].concat(extensions.extensions.flatMap((extension) => [...extension.tools.keys()]), ["workflow"]))];
  const headlessPi = {
    registerTool(tool: unknown) { tools.push(tool); },
    registerCommand() {},
    getThinkingLevel: () => services.settingsManager.getDefaultThinkingLevel() ?? "medium",
    getActiveTools: () => activeTools,
    on(name: string, handler: unknown) { if (name === "session_shutdown" && typeof handler === "function") shutdownHandlers.push(handler as ShutdownHandler); },
    appendEntry() {},
    sendMessage() {},
    events: { emit() {} },
  } satisfies HeadlessExtensionAPI;
  workflowExtension(headlessPi, homedir(), undefined, undefined, agentDir, options.skillPaths);
  const workflowTool = tools.find(isHeadlessWorkflowTool);
  if (!workflowTool) throw new Error("The workflow runtime could not be initialized");
  return { catalog: workflowCatalog({ cwd, projectTrusted: settingsManager.isProjectTrusted(), globalSettingsPath: workflowSettingsPath(agentDir) }), services, workflowTool, shutdownHandlers };
}

function availableModelInfo(services: WorkflowRuntime["services"], available = false): { provider: string; id: string }[] {
  const models = available ? services.modelRuntime.getAvailableSnapshot() : services.modelRuntime.getModels();
  return models.map(({ provider, id }) => ({ provider, id }));
}

async function selectedModel(services: WorkflowRuntime["services"]): Promise<{ provider: string; id: string } | undefined> {
  const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(), noTools: "all" });
  try {
    const model = session.model;
    return model ? { provider: model.provider, id: model.id } : undefined;
  } finally {
    session.dispose();
  }
}

function commandName(value: string): string { return value.trim() && !value.includes("/") && !value.includes("\\") ? value.trim() : ""; }

function writeLauncher(destination: string, workflowName: string, force: boolean): void {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const tempDir = mkdtempSync(join(parent, ".pi-extensible-workflows-"));
  const tempPath = join(tempDir, "launcher");
  try {
    const source = `#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
let cli;
try { cli = await import(pathToFileURL(join(process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"), "npm", "node_modules", "@piewf/cli", "dist", "src", "cli.js")).href); } catch {}
if (!cli) try { cli = await import(import.meta.resolve("@piewf/cli")); } catch {}
if (cli) process.exitCode = await cli.runCli(["run", ${JSON.stringify(workflowName)}, ...process.argv.slice(2)]);
else { const result = spawnSync("piewf", ["run", ${JSON.stringify(workflowName)}, ...process.argv.slice(2)], { stdio: "inherit" }); if (result.error) { console.error("Could not resolve @piewf/cli; install it or put piewf on PATH."); process.exitCode = 1; } else process.exitCode = result.status ?? 1; }
`;
    writeFileSync(tempPath, source, { mode: 0o755 });
    chmodSync(tempPath, 0o755);
    if (force) renameSync(tempPath, destination);
    else {
      try { linkSync(tempPath, destination); }
      catch (error) {
        if (isNodeError(error, "EEXIST")) throw new Error(`Destination already exists: ${destination}; use --force to replace it`, { cause: error });
        throw error;
      }
    }
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
}

function terminalProgressStyles(enabled: boolean): WorkflowProgressStyles {
  const style = (code: number) => enabled ? (text: string) => `\x1b[${String(code)}m${text}\x1b[0m` : (text: string) => text;
  return { accent: style(36), success: style(32), error: style(31), warning: style(33), muted: style(90), dim: style(2), bold: style(1) };
}
class CliProgress {
  #lastStable = "";
  #lines = 0;
  #frame = 0;
  #run: PersistedRun | undefined;
  #runId: string | undefined;
  #runtimeStartedAt = 0;
  #runtimeBaseMs = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #interactive: boolean;
  #styles: WorkflowProgressStyles;
  constructor(private readonly stderr: (text: string) => void, tty: boolean, private readonly onRunId: (runId: string) => void) {
    this.#interactive = tty && process.env.NO_COLOR === undefined && process.env.TERM !== "dumb";
    this.#styles = terminalProgressStyles(this.#interactive);
  }
  update(run: PersistedRun): void {
    if (this.#runId !== run.id) {
      this.#runId = run.id;
      this.onRunId(run.id);
      this.#runtimeStartedAt = Date.now();
      this.#runtimeBaseMs = run.usage?.durationMs ?? 0;
    } else if (this.#run && this.#run.state !== "running" && run.state === "running") {
      this.#runtimeStartedAt = Date.now();
      this.#runtimeBaseMs = run.usage?.durationMs ?? 0;
    }
    this.#run = run;
    if (!this.#interactive) {
      this.#timer ??= setInterval(() => { this.render(); }, 1000);
      this.#timer.unref();
      this.render();
      return;
    }
    this.#timer ??= setInterval(() => { this.render(); }, 80);
    this.#timer.unref();
    this.render();
  }
  render(): void {
    if (!this.#run) return;
    const run = this.#run.state !== "running" ? this.#run : { ...this.#run, usage: { ...(this.#run.usage ?? { tokens: 0, costUsd: 0, durationMs: 0, agentLaunches: 0 }), durationMs: Math.max(this.#run.usage?.durationMs ?? 0, this.#runtimeBaseMs + Date.now() - this.#runtimeStartedAt) } };
    if (!this.#interactive) {
      const stable = formatWorkflowProgress(run, "◇", this.#styles);
      if (stable !== this.#lastStable) { this.#lastStable = stable; this.stderr(`${stable}\n`); }
      return;
    }
    const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][this.#frame++ % 10] ?? "◇";
    const width = process.stderr.columns || 80;
    const text = truncateWorkflowProgress(formatWorkflowProgress(run, spinner, this.#styles), width).join("\n");
    this.stderr(`${this.#lines ? `\x1b[${String(this.#lines)}A` : ""}${this.#lines ? "" : "\x1b[?25l"}\x1b[0J${text}\n`);
    this.#lines = text.split("\n").length;
  }
  finish(): void {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = undefined; }
    if (this.#interactive && this.#lines) { this.stderr(`\x1b[${String(this.#lines)}A\x1b[0J\x1b[?25h`); this.#lines = 0; }
    this.#run = undefined;
  }
}

type CliWorkflowResult = { value: JsonValue; runId?: string };
type CliWorkflowLaunch = { name: string; args: JsonValue; fn?: WorkflowCatalogFunction; scriptPath?: string };
async function invokeWorkflow(launch: CliWorkflowLaunch, runtime: WorkflowRuntime, options: WorkflowIo, context: unknown): Promise<CliWorkflowResult> {
  if (launch.fn && (!object(launch.args) || !Value.Check(launch.fn.input, launch.args))) throw new Error(`Invalid input for ${launch.fn.name}`);
  if (!launch.fn && launch.scriptPath === undefined) throw new Error("Workflow launch has no source");
  let announcedRunId: string | undefined;
  const announceRunId = (runId: string) => { if (announcedRunId === runId) return; announcedRunId = runId; options.stderr(`Run ID: ${runId}\n`); };
  const progress = new CliProgress(options.stderr, options.isTTY ?? process.stderr.isTTY, announceRunId);
  try {
    const params = launch.scriptPath === undefined
      ? { name: launch.name, script: `return await ${launch.fn?.name ?? launch.name}(args);`, args: launch.args, foreground: true }
      : { name: launch.name, scriptPath: launch.scriptPath, args: launch.args, foreground: true };
    const result: unknown = await runtime.workflowTool.execute(randomUUID(), params, options.signal, (update: unknown) => { if (object(update) && object(update.details) && isPersistedRun(update.details.run)) progress.update(update.details.run); }, context);
    if (!isHeadlessWorkflowResult(result)) throw new Error("Workflow returned an invalid result");
    const details = object(result.details) ? result.details : {};
    const runId = typeof details.runId === "string" ? details.runId : undefined;
    if (runId) announceRunId(runId);
    if (has(details, "value") && jsonValue(details.value)) return { value: details.value, ...(runId ? { runId } : {}) };
    const first = result.content[0];
    if (!first || first.type !== "text") throw new Error("Workflow returned no result");
    try { return { value: parseJsonInput(first.text), ...(runId ? { runId } : {}) }; } catch { throw new Error("Workflow returned invalid JSON"); }
  } finally {
    progress.finish();
  }
}

async function createWorkflowContext(runtime: WorkflowRuntime, options: WorkflowIo): Promise<unknown> {
  const model = await selectedModel(runtime.services);
  const sessionManager = SessionManager.inMemory();
  const modelRegistry = { getAll: () => availableModelInfo(runtime.services), getAvailable: () => availableModelInfo(runtime.services, true) };
  return { cwd: options.cwd ?? process.cwd(), mode: "print" as const, hasUI: false, ...(model ? { model } : {}), modelRegistry, sessionManager, isProjectTrusted: () => runtime.services.settingsManager.isProjectTrusted(), ui: { select: async () => undefined, confirm: async () => false, input: async () => undefined, notify: () => {}, onTerminalInput: () => () => {}, setStatus: () => {}, setWorkingMessage: () => {}, setWorkingVisible: () => {}, setWorkingIndicator: () => {}, setHiddenThinkingLabel: () => {}, setWidget: () => {}, setFooter: () => {}, setHeader: () => {}, setTitle: () => {}, custom: async () => undefined, pasteToEditor: () => {}, setEditorText: () => {}, getEditorText: () => "", editor: async () => undefined, addAutocompleteProvider: () => {} }, headless: true };
}

async function shutdownWorkflowRuntime(handlers: readonly ShutdownHandler[], context: unknown): Promise<void> {
  for (const handler of handlers) {
    try { await handler({ type: "session_shutdown", reason: "quit" }, context); } catch { /* Shutdown is best effort. */ }
  }
}

async function withWorkflowRuntime<T>(options: WorkflowIo, action: (runtime: WorkflowRuntime, context: unknown) => Promise<T>): Promise<T> {
  const shutdownHandlers: ShutdownHandler[] = [];
  let context: unknown = { cwd: options.cwd ?? process.cwd(), mode: "print", hasUI: false, headless: true };
  try {
    const runtime = await createWorkflowRuntime(options, shutdownHandlers);
    context = await createWorkflowContext(runtime, options);
    return await action(runtime, context);
  } finally {
    await shutdownWorkflowRuntime(shutdownHandlers, context);
  }
}

async function runWorkflowCli(rawArgs: readonly string[], options: WorkflowIo): Promise<number> {
  const parsed = stripTrustOptions(rawArgs);
  const args = parsed.args;
  if (!args.length || args[0] === "--help" || args[0] === "-h") { options.write(workflowUsage()); return args.length ? 0 : 1; }
  const runtimeOptions = { ...options, ...(parsed.trustOverride !== undefined ? { trustOverride: parsed.trustOverride } : {}) };
  const scriptMode = args[0] === "--script" || args[0]?.startsWith("--script=") || args[0]?.startsWith("--") && args.some((arg) => arg === "--script" || arg.startsWith("--script="));
  if (scriptMode) {
    const script = parseScriptWorkflowCliArgs(args);
    if (script.help) { options.write(scriptWorkflowUsage()); return 0; }
    return withWorkflowRuntime(runtimeOptions, async (runtime, context) => {
      const result = await invokeWorkflow({ name: script.name, scriptPath: script.scriptPath, args: script.args }, runtime, options, context);
      options.write(`${JSON.stringify(result.value)}\n`);
      return 0;
    });
  }
  const name = requiredArg(args, 0);
  return withWorkflowRuntime(runtimeOptions, async (runtime, context) => {
    const help = args.slice(1).some((arg) => arg === "--help" || arg === "-h");
    const fn = runtime.catalog.functions.find((candidate) => candidate.name === name);
    if (!fn) throw new Error(`Unknown workflow function: ${name}`);
    if (help) { options.write(formatWorkflowCliHelp(fn)); return 0; }
    const input = parseWorkflowCliArgs(fn.input, args.slice(1));
    const result = await invokeWorkflow({ name: fn.name, fn, args: input }, runtime, options, context);
    options.write(`${JSON.stringify(result.value)}\n`);
    return 0;
  });
}

async function exportWorkflowCli(rawArgs: readonly string[], options: WorkflowIo): Promise<number> {
  const parsed = stripTrustOptions(rawArgs);
  const args = parsed.args;
  if (args.includes("--bundle")) return bundleWorkflowCli(args.filter((arg) => arg !== "--bundle"), { ...options, ...(parsed.trustOverride !== undefined ? { trustOverride: parsed.trustOverride } : {}) });
  if (!args.length || args[0] === "--help" || args[0] === "-h") { options.write(exportUsage()); return args.length ? 0 : 1; }
  const workflowName = requiredArg(args, 0);
  return withWorkflowRuntime({ ...options, ...(parsed.trustOverride !== undefined ? { trustOverride: parsed.trustOverride } : {}) }, async (runtime) => {
    let name: string | undefined;
    let output: string | undefined;
    let force = false;
    for (let index = 1; index < args.length; index += 1) {
      const arg = requiredArg(args, index);
      if (arg === "--force") { force = true; continue; }
      const equals = arg.indexOf("=");
      const option = equals >= 0 ? arg.slice(0, equals) : arg;
      if (option === "--name" || option === "--output") {
        const value = equals >= 0 ? arg.slice(equals + 1) : args[++index];
        if (!value) throw new Error(`Missing value for ${option}`);
        if (option === "--name") name = value; else output = value;
        continue;
      }
      if (arg === "--help" || arg === "-h") { options.write(exportUsage()); return 0; }
      throw new Error(`Unknown option: ${arg}`);
    }
    if (!runtime.catalog.functions.some((candidate) => candidate.name === workflowName)) throw new Error(`Unknown workflow function: ${workflowName}`);
    const command = commandName(name ?? kebabCase(workflowName));
    if (!command) throw new Error("Command name must be a non-empty name without path separators");
    const destination = output ? output : join(homedir(), ".local", "bin", command);
    writeLauncher(destination, workflowName, force);
    if (!output) {
      const binDir = join(homedir(), ".local", "bin");
      const pathEntries = (process.env.PATH ?? "").split(":").filter(Boolean).map((entry) => { try { return realpathSync(entry); } catch { return entry; } });
      if (!pathEntries.includes(binDir)) options.stderr(`Warning: ${binDir} is not in PATH\n`);
    }
    options.write(`Exported ${destination}\n`);
    return 0;
  });
}

async function bundleWorkflowCli(rawArgs: readonly string[], options: WorkflowIo): Promise<number> {
  const parsed = stripTrustOptions(rawArgs);
  const args = parsed.args;
  if (!args.length || args[0] === "--help" || args[0] === "-h") { options.write(bundleUsage()); return args.length ? 0 : 1; }
  const workflowName = requiredArg(args, 0);
  return withWorkflowRuntime({ ...options, ...(parsed.trustOverride !== undefined ? { trustOverride: parsed.trustOverride } : {}) }, async (runtime) => {
    let name: string | undefined;
    let output: string | undefined;
    let force = false;
    const requirements = { roles: [] as string[], aliases: [] as string[], tools: [] as string[], commands: [] as string[], environment: [] as string[] };
    const resources = { extensions: [] as string[], skills: [] as string[], static: [] as string[], dependencies: [] as string[] };
    for (let index = 1; index < args.length; index += 1) {
      const arg = requiredArg(args, index);
      if (arg === "--force") { force = true; continue; }
      const equals = arg.indexOf("=");
      const option = equals >= 0 ? arg.slice(0, equals) : arg;
      const requirementOptions = { "--role": "roles", "--alias": "aliases", "--tool": "tools", "--command": "commands", "--environment": "environment" } as const;
      const resourceOptions = { "--extension": "extensions", "--skill": "skills", "--resource": "static", "--dependency": "dependencies" } as const;
      if (option === "--name" || option === "--output" || typedOptionKey(requirementOptions, option) || typedOptionKey(resourceOptions, option)) {
        const value = equals >= 0 ? arg.slice(equals + 1) : args[++index];
        if (!value) throw new Error(`Missing value for ${option}`);
        if (option === "--name") name = value;
        else if (option === "--output") output = value;
        else if (typedOptionKey(requirementOptions, option)) requirements[requirementOptions[option]].push(value);
        else if (typedOptionKey(resourceOptions, option)) resources[resourceOptions[option]].push(value);
        continue;
      }
      if (arg === "--help" || arg === "-h") { options.write(bundleUsage()); return 0; }
      throw new Error(`Unknown option: ${arg}`);
    }
    const fn = runtime.catalog.functions.find((candidate) => candidate.name === workflowName);
    if (!fn) throw new Error(`Unknown workflow function: ${workflowName}`);
    const registered = registeredWorkflowFunctions()[workflowName];
    if (!registered) throw new Error(`Workflow ${workflowName} is not exportable because its registered implementation is unavailable`);
    const definitions = requirements.roles.length ? loadAgentDefinitions(options.cwd ?? process.cwd(), options.agentDir ?? getAgentDir(), runtime.services.settingsManager.isProjectTrusted()) : {};
    const roles = Object.fromEntries(requirements.roles.map((role) => {
      if (!role || role === "." || role === ".." || role.includes("/") || role.includes("\\")) throw new Error(`Invalid role name for bundle: ${role}`);
      const definition = definitions[role];
      if (!definition) throw new Error(`Unknown role for bundle: ${role}`);
      return [role, definition];
    }));
    const command = commandName(name ?? kebabCase(workflowName));
    if (!command) throw new Error("Command name must be a non-empty name without path separators");
    const destination = output ?? join(homedir(), ".local", "share", "pi-extensible-workflows", "bundles", command);
    const aliasTargets = Object.fromEntries(requirements.aliases.flatMap((name) => {
      const target = runtime.catalog.modelAliases?.[name];
      return typeof target === "string" ? [[name, target]] : [];
    }));
    const selectedResources = Object.values(resources).some((entries) => entries.length) ? resources : undefined;
    writePortableWorkflowBundle({ destination, command, workflow: fn, functionSource: registered.run.toString(), requirements, aliasTargets, roles, ...(selectedResources ? { resources: selectedResources } : {}), piVersion: portablePiVersion(), engineVersion: portableEngineVersion(), force });
    options.write(`Bundled ${workflowName} at ${destination}\n`);
    options.write(`Run ${join(destination, command)} setup before launching the workflow.\n`);
    return 0;
  });
}

export async function runCli(args: readonly string[], options: CliOptions = {}, write: (text: string) => void = (text) => { process.stdout.write(text); }): Promise<number> {
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  if (args[0] === "doctor" && args[1] !== "cleanup") {
    if (args.slice(1).some((arg) => arg === "--help" || arg === "-h")) { write("Usage: piewf doctor [role] [--role <role>] [--prompt <text>] [--json]\n"); return 0; }
    try {
      const { json, ...parsed } = parseDoctorArgs(args.slice(1));
      const report = await doctor({ ...options, ...parsed });
      write(json ? `${JSON.stringify(report)}\n` : formatDoctorReport(report));
      return doctorExitCode(report);
    } catch (error) { stderr(`Error: ${errorText(error)}\n`); return 1; }
  }
  if (args[0] === "doctor" && args[1] === "cleanup") {
    if (args.slice(2).some((arg) => arg === "--help" || arg === "-h")) { write("Usage: piewf doctor cleanup [--older-than-days <days>] [--yes]\n"); return 0; }
    try {
      const parsed = parseDoctorCleanupArgs(args.slice(2));
      const cleanupOptions: DoctorCleanupOptions = { ...parsed, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}) };
      const report = await doctorCleanup(cleanupOptions);
      write(formatDoctorCleanupReport(report));
      return doctorCleanupExitCode(report);
    } catch (error) { stderr(`Error: ${errorText(error)}\n`); return 1; }
  }
  if (args[0] === "inspect") {
    try {
      const parsed = parseInspectArgs(args.slice(1));
      if (options.inspect) await options.inspect(parsed.sessionId, parsed.mode, parsed.failedOnly);
      else await runSessionInspector(parsed.sessionId, parsed.mode, options.cwd ?? process.cwd(), undefined, write, parsed.failedOnly);
      return 0;
    }
    catch (error) { write(`Error: ${errorText(error)}\n`); return 1; }
  }
  if (args[0] === "transcript" && args.length === 2) {
    try {
      const transcript = requiredArg(args, 1);
      if (options.transcript) await options.transcript(transcript);
      else write(`${transcriptFileLines(transcript).join("\n")}\n`);
      return 0;
    } catch (error) { write(`Error: ${errorText(error)}\n`); return 1; }
  }
  if (args[0] === "share") {
    if (args.length !== 2 || args[1] === "--help" || args[1] === "-h") {
      write("Usage: piewf share <run-id>\n\nExports the run as a static Trajectory report and uploads it as a secret GitHub gist via the gh CLI.\nSecret gists are unlisted, not private: anyone with the link can read the full report.\n");
      return args.some((arg) => arg === "--help" || arg === "-h") ? 0 : 1;
    }
    try {
      const runId = requiredArg(args, 1);
      const cwd = options.cwd ?? process.cwd();
      let sessionId: string | undefined;
      for (const candidate of await listPersistedSessionIds(cwd)) {
        if ((await listRunIds(cwd, candidate, homedir(), false)).includes(runId)) { sessionId = candidate; break; }
      }
      if (!sessionId) { stderr(`Error: workflow run ${runId} was not found under ${cwd}\n`); return 1; }
      const result = await shareTrajectoryRun({ cwd, sessionId, runId });
      write(`Share URL: ${result.shareUrl}\nGist: ${result.gistUrl}\nSecret gist: anyone with the link can read the full report.\n`);
      return 0;
    } catch (error) { stderr(`Error: ${errorText(error)}\n`); return 1; }
  }
  if (args[0] === "bundle" || args[0] === "run" || args[0] === "export") {
    try {
      const workflowOptions: WorkflowIo = { write, stderr, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}), ...(options.signal ? { signal: options.signal } : {}), ...(options.trustOverride !== undefined ? { trustOverride: options.trustOverride } : {}), ...(options.isTTY !== undefined ? { isTTY: options.isTTY } : {}), ...(options.skillPaths?.length ? { skillPaths: [...options.skillPaths] } : {}) };
      if (args[0] === "bundle") return await bundleWorkflowCli(args.slice(1), workflowOptions);
      return args[0] === "run" ? await runWorkflowCli(args.slice(1), workflowOptions) : await exportWorkflowCli(args.slice(1), workflowOptions);
    } catch (error) { stderr(`Error: ${errorText(error)}\n`); return 1; }
  }
  write("Usage: piewf doctor [role] [--role <role>] [--prompt <text>] [--json] | inspect [session-id] [--json|--summary] [--failed] | transcript <session-file> | share <run-id> | bundle <workflow-name> [--name <command>] [--output <path>] [--force] | run <workflow-name> [workflow arguments] | run --script <path> [--name <workflow-name>] [--input <json>] | export <workflow-name> [--name <command>] [--output <path>] [--force] [--bundle]\n");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const controller = new AbortController();
  const onSignal = () => { controller.abort(); };
  process.once("SIGINT", onSignal);
  process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
}
