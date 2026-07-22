#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { chmodSync, linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ProjectTrustStore, SessionManager, SettingsManager, createAgentSessionFromServices, createAgentSessionServices, getAgentDir, hasTrustRequiringProjectResources, type LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { doctor, doctorExitCode, formatDoctorReport, type DoctorOptions } from "./doctor.js";
import workflowExtension, { formatWorkflowProgress, workflowCatalog, type JsonSchema, type JsonValue } from "./index.js";
import { runSessionInspector, transcriptFileLines } from "./session-inspector.js";
import type { PersistedRun } from "./persistence.js";
import type { WorkflowCatalogFunction } from "./index.js";

export interface CliOptions extends DoctorOptions { inspect?: (sessionId?: string) => Promise<void>; transcript?: (sessionFile: string) => Promise<void>; stderr?: (text: string) => void; signal?: AbortSignal; trustOverride?: boolean; isTTY?: boolean }

type CliScalar = "string" | "integer" | "number" | "boolean";
type CliField = { name: string; option: string; schema: Record<string, unknown>; type: CliScalar | "array"; itemType?: CliScalar; required: boolean };
type CliSchemaPlan = { fields: readonly CliField[]; positional?: CliField };

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function has(value: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function clone(value: unknown): JsonValue { return structuredClone(value) as JsonValue; }
function kebabCase(value: string): string { return value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/([A-Z]+)([A-Z][a-z])/g, "$1-$2").replace(/[_\s]+/g, "-").toLowerCase(); }
export { kebabCase as camelToKebab };

function scalarType(schema: unknown): CliScalar | undefined {
  if (!object(schema) || typeof schema.type !== "string") return undefined;
  return ["string", "integer", "number", "boolean"].includes(schema.type) ? schema.type as CliScalar : undefined;
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
function scalarFieldType(field: CliField): CliScalar { return field.type === "array" ? field.itemType as CliScalar : field.type; }
function fieldLabel(field: CliField): string { return field.type === "array" ? `${field.option} <${scalarLabel(field.itemType as CliScalar)}>` : `${field.option}${field.type === "boolean" ? "" : ` <${scalarLabel(field.type)}>`}`; }
function fieldDescription(field: CliField): string {
  const description = typeof field.schema.description === "string" ? field.schema.description.trim() : "";
  const required = field.required ? "required" : "optional";
  const defaultValue = has(field.schema, "default") ? ` default=${JSON.stringify(field.schema.default)}` : "";
  const enumSchema = field.type === "array" && object(field.schema.items) ? field.schema.items : field.schema;
  const enumValue = Array.isArray(enumSchema.enum) ? ` enum=${enumSchema.enum.map((value) => JSON.stringify(value)).join(",")}` : "";
  return [description, required, defaultValue, enumValue].filter(Boolean).join("; ");
}

export function formatWorkflowCliHelp(fn: WorkflowCatalogFunction, command = "pi-extensible-workflows"): string {
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
  lines.push("  --input <json>".padEnd(28) + "JSON input escape hatch for complex schemas", "  -h, --help".padEnd(28) + "Show this help");
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
    if (field.type === "array") { const values = Array.isArray(result[field.name]) ? result[field.name] as JsonValue[] : []; values.push(coerce(raw, field.itemType as CliScalar, field.schema.items as Record<string, unknown>)); result[field.name] = values; }
    else result[field.name] = coerce(raw, field.type, field.schema);
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const token = rawArgs[index] as string;
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
        else if (rawArgs[index + 1] === "true" || rawArgs[index + 1] === "false") assign(field, rawArgs[++index] as string);
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
    return input;
  }
  for (const field of plan.fields) if (!has(result, field.name) && has(field.schema, "default")) result[field.name] = clone(field.schema.default);
  for (const field of plan.fields) if (field.required && !has(result, field.name)) throw new Error(`Missing required argument: ${field.name}`);
  return result;
}

function workflowUsage(): string { return "Usage: pi-extensible-workflows run <workflow-name> [workflow arguments] | export <workflow-name> [--name <command>] [--output <path>] [--force]\n"; }
function exportUsage(): string { return "Usage: pi-extensible-workflows export <workflow-name> [--name <command>] [--output <path>] [--force]\n"; }
function stripTrustOptions(rawArgs: readonly string[]): { args: string[]; trustOverride?: boolean } {
  const args: string[] = [];
  let trustOverride: boolean | undefined;
  for (const arg of rawArgs) {
    if (arg === "--approve" || arg === "--no-approve") {
      const next = arg === "--approve";
      if (trustOverride !== undefined && trustOverride !== next) throw new Error("--approve and --no-approve cannot be combined");
      trustOverride = next;
    } else args.push(arg);
  }
  return { args, ...(trustOverride !== undefined ? { trustOverride } : {}) };
}
type WorkflowIo = { write: (text: string) => void; stderr: (text: string) => void; cwd?: string; agentDir?: string; trustOverride?: boolean; isTTY?: boolean; signal?: AbortSignal };

type HeadlessWorkflowTool = { execute: (toolCallId: string, params: Record<string, JsonValue>, signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined, context: unknown) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }> };
type ShutdownHandler = (event: unknown, context: unknown) => Promise<void> | void;
type WorkflowRuntime = { catalog: ReturnType<typeof workflowCatalog>; services: Awaited<ReturnType<typeof createAgentSessionServices>>; extensions: ReturnType<Awaited<ReturnType<typeof createAgentSessionServices>>["resourceLoader"]["getExtensions"]>; workflowTool: HeadlessWorkflowTool; shutdownHandlers: ShutdownHandler[] };

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
          const result = await handler({ type: "project_trust", cwd }, projectTrustContext) as { trusted?: unknown; remember?: unknown };
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
    resourceLoaderOptions: {},
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
  };
  workflowExtension(headlessPi as never, homedir(), undefined, undefined, agentDir);
  const workflowTool = tools.find((tool) => object(tool) && tool.name === "workflow") as HeadlessWorkflowTool | undefined;
  if (!workflowTool) throw new Error("The workflow runtime could not be initialized");
  return { catalog: workflowCatalog(), services, extensions, workflowTool, shutdownHandlers };
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

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function commandName(value: string): string { return value.trim() && !value.includes("/") && !value.includes("\\") ? value.trim() : ""; }

function writeLauncher(destination: string, workflowName: string, force: boolean): void {
  const parent = dirname(destination);
  mkdirSync(parent, { recursive: true });
  const tempDir = mkdtempSync(join(parent, ".pi-extensible-workflows-"));
  const tempPath = join(tempDir, "launcher");
  try {
    writeFileSync(tempPath, `#!/bin/sh\nexec node ${shellQuote(fileURLToPath(import.meta.url))} run ${shellQuote(workflowName)} "$@"\n`, { mode: 0o755 });
    chmodSync(tempPath, 0o755);
    if (force) renameSync(tempPath, destination);
    else {
      try { linkSync(tempPath, destination); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Destination already exists: ${destination}; use --force to replace it`, { cause: error });
        throw error;
      }
    }
  } finally { rmSync(tempDir, { recursive: true, force: true }); }
}


class CliProgress {
  #lastStable = "";
  #lines = 0;
  #frame = 0;
  #run: PersistedRun | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  constructor(private readonly stderr: (text: string) => void, private readonly tty: boolean) {}
  update(run: PersistedRun): void {
    const stable = formatWorkflowProgress(run, "◇");
    if (!this.tty) { if (stable !== this.#lastStable) { this.#lastStable = stable; this.stderr(`${stable}\n`); } return; }
    this.#run = run;
    this.#timer ??= setInterval(() => { this.render(); }, 80);
    this.#timer.unref();
    this.render();
  }
  render(): void {
    if (!this.#run) return;
    const spinner = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][this.#frame++ % 10] ?? "◇";
    const width = process.stderr.columns || 80;
    const text = formatWorkflowProgress(this.#run, spinner).split("\n").map((line) => line.length <= width ? line : `${line.slice(0, Math.max(0, width - 1))}…`).join("\n");
    this.stderr(`${this.#lines ? `\x1b[${String(this.#lines)}A` : ""}${this.#lines ? "" : "\x1b[?25l"}\x1b[0J${text}\n`);
    this.#lines = text.split("\n").length;
  }
  finish(): void {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = undefined; }
    if (this.tty && this.#lines) { this.stderr(`\x1b[${String(this.#lines)}A\x1b[0J\x1b[?25h`); this.#lines = 0; }
    this.#run = undefined;
  }
}

async function invokeWorkflow(fn: WorkflowCatalogFunction, args: Record<string, JsonValue>, runtime: WorkflowRuntime, options: WorkflowIo, context: unknown): Promise<JsonValue> {
  if (!Value.Check(fn.input, args)) throw new Error(`Invalid input for ${fn.name}`);
  const progress = new CliProgress(options.stderr, options.isTTY ?? process.stderr.isTTY);
  try {
    const result = await runtime.workflowTool.execute(randomUUID(), { workflow: fn.name, args, foreground: true }, options.signal, (update: unknown) => { if (object(update) && object(update.details) && object(update.details.run)) progress.update(update.details.run as unknown as PersistedRun); }, context);
    const details = object(result.details) ? result.details : {};
    if (has(details, "value")) return details.value as JsonValue;
    const first = result.content[0];
    if (!first || first.type !== "text") throw new Error("Workflow returned no result");
    try { return parseJsonInput(first.text); } catch { throw new Error("Workflow returned invalid JSON"); }
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
  const name = args[0] as string;
  return withWorkflowRuntime({ ...options, ...(parsed.trustOverride !== undefined ? { trustOverride: parsed.trustOverride } : {}) }, async (runtime, context) => {
    const help = args.slice(1).some((arg) => arg === "--help" || arg === "-h");
    const fn = runtime.catalog.functions.find((candidate) => candidate.name === name);
    if (!fn) throw new Error(`Unknown workflow function: ${name}`);
    if (help) { options.write(formatWorkflowCliHelp(fn)); return 0; }
    const input = parseWorkflowCliArgs(fn.input, args.slice(1));
    const controller = new AbortController();
    if (options.signal?.aborted) controller.abort();
    const onAbort = () => { controller.abort(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const value = await invokeWorkflow(fn, input, runtime, { ...options, signal: controller.signal }, context);
      options.write(`${JSON.stringify(value)}\n`);
      return 0;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
  });
}

async function exportWorkflowCli(rawArgs: readonly string[], options: WorkflowIo): Promise<number> {
  const parsed = stripTrustOptions(rawArgs);
  const args = parsed.args;
  if (!args.length || args[0] === "--help" || args[0] === "-h") { options.write(exportUsage()); return args.length ? 0 : 1; }
  const workflowName = args[0] as string;
  return withWorkflowRuntime({ ...options, ...(parsed.trustOverride !== undefined ? { trustOverride: parsed.trustOverride } : {}) }, async (runtime) => {
    let name: string | undefined;
    let output: string | undefined;
    let force = false;
    for (let index = 1; index < args.length; index += 1) {
      const arg = args[index] as string;
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

export async function runCli(args: readonly string[], options: CliOptions = {}, write: (text: string) => void = (text) => { process.stdout.write(text); }): Promise<number> {
  const stderr = options.stderr ?? ((text: string) => { process.stderr.write(text); });
  if (args[0] === "doctor" && args.length === 1) {
    const report = await doctor(options);
    write(formatDoctorReport(report));
    return doctorExitCode(report);
  }
  if (args[0] === "inspect" && args.length <= 2) {
    try { await (options.inspect ?? runSessionInspector)(args[1]); return 0; }
    catch (error) { write(`Error: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
  }
  if (args[0] === "transcript" && args.length === 2) {
    try {
      if (options.transcript) await options.transcript(args[1] as string);
      else write(`${transcriptFileLines(args[1] as string).join("\n")}\n`);
      return 0;
    } catch (error) { write(`Error: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
  }
  if (args[0] === "run" || args[0] === "export") {
    try {
      const workflowOptions: WorkflowIo = { write, stderr, ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.agentDir !== undefined ? { agentDir: options.agentDir } : {}), ...(options.signal ? { signal: options.signal } : {}), ...(options.trustOverride !== undefined ? { trustOverride: options.trustOverride } : {}), ...(options.isTTY !== undefined ? { isTTY: options.isTTY } : {}) };
      return args[0] === "run" ? await runWorkflowCli(args.slice(1), workflowOptions) : await exportWorkflowCli(args.slice(1), workflowOptions);
    } catch (error) { stderr(`Error: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
  }
  write("Usage: pi-extensible-workflows doctor | inspect [session-id] | transcript <session-file>\n");
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const controller = new AbortController();
  const onSignal = () => { controller.abort(); };
  process.once("SIGINT", onSignal);
  process.exitCode = await runCli(process.argv.slice(2), { signal: controller.signal });
}
