import { readFileSync } from "node:fs";
import { isPersistedRun, type PersistedRun } from "pi-extensible-workflows/persistence";

export type CliTestPackageMetadata = { version?: string; bin?: Record<string, string> };

export type CliTestManifest = {
  format: "pi-extensible-workflows-bundle";
  version: 1 | 2;
  command: string;
  workflow: { name: string; input: Record<string, unknown>; output: Record<string, unknown> };
  runtime: { pi: string; "@piewf/cli": string };
  requirements: { roles: string[]; aliases: string[]; tools: string[]; commands: string[]; environment: string[] };
  source?: { module: string; export: string };
  bundler?: { esbuild: string };
  dependencies?: string[];
  payload?: { extensions?: string[]; skills?: string[]; static?: string[]; dependencies?: string[] };
};

export type CliTestBundleState = {
  format: "pi-extensible-workflows-bundle";
  version: 1 | 2;
  pi: string;
  engine: string;
  checkedAt: string;
};

export type CliTestSessionOwner = Record<string, unknown> & { pid: number; token: string; startedAt: number };
export type CliTestBundleFunction = { run: (input: Record<string, unknown>) => unknown };
export type CliTestBundleExtension = { functions?: Record<string, CliTestBundleFunction> };
export type CliTestBundleModule = { register: (register: (extension: unknown) => void) => Promise<void> };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function stringMap(value: unknown): value is Record<string, string> {
  return record(value) && Object.values(value).every((entry) => typeof entry === "string");
}

function readJson(path: string): unknown {
  const value: unknown = JSON.parse(readFileSync(path, "utf8"));
  return value;
}

export function isCliTestPackageMetadata(value: unknown): value is CliTestPackageMetadata {
  return record(value) && (value.version === undefined || typeof value.version === "string") && (value.bin === undefined || stringMap(value.bin));
}

export function readCliTestPackageMetadata(path: string): CliTestPackageMetadata {
  const value: unknown = readJson(path);
  if (!isCliTestPackageMetadata(value)) throw new Error(`Invalid package metadata: ${path}`);
  return value;
}

function isPayload(value: unknown): value is NonNullable<CliTestManifest["payload"]> {
  return record(value) && (value.extensions === undefined || stringArray(value.extensions)) && (value.skills === undefined || stringArray(value.skills)) && (value.static === undefined || stringArray(value.static)) && (value.dependencies === undefined || stringArray(value.dependencies));
}

export function isCliTestManifest(value: unknown): value is CliTestManifest {
  if (!record(value) || value.format !== "pi-extensible-workflows-bundle" || (value.version !== 1 && value.version !== 2) || typeof value.command !== "string") return false;
  if (!record(value.workflow) || typeof value.workflow.name !== "string" || !record(value.workflow.input) || !record(value.workflow.output)) return false;
  if (!record(value.runtime) || typeof value.runtime.pi !== "string" || typeof value.runtime["@piewf/cli"] !== "string") return false;
  if (!record(value.requirements) || !stringArray(value.requirements.roles) || !stringArray(value.requirements.aliases) || !stringArray(value.requirements.tools) || !stringArray(value.requirements.commands) || !stringArray(value.requirements.environment)) return false;
  if (value.version === 2 && (!record(value.source) || typeof value.source.module !== "string" || typeof value.source.export !== "string" || !record(value.bundler) || typeof value.bundler.esbuild !== "string" || !stringArray(value.dependencies))) return false;
  return value.payload === undefined || isPayload(value.payload);
}

export function readCliTestManifest(path: string): CliTestManifest {
  const value: unknown = readJson(path);
  if (!isCliTestManifest(value)) throw new Error(`Invalid bundle manifest: ${path}`);
  return value;
}

export function isCliTestBundleState(value: unknown): value is CliTestBundleState {
  return record(value) && value.format === "pi-extensible-workflows-bundle" && (value.version === 1 || value.version === 2) && typeof value.pi === "string" && typeof value.engine === "string" && typeof value.checkedAt === "string";
}

export function readCliTestBundleState(path: string): CliTestBundleState {
  const value: unknown = readJson(path);
  if (!isCliTestBundleState(value)) throw new Error(`Invalid bundle state: ${path}`);
  return value;
}

export function readCliTestPersistedRun(path: string): PersistedRun {
  const value: unknown = readJson(path);
  if (!isPersistedRun(value)) throw new Error(`Invalid persisted run: ${path}`);
  return value;
}

export function isCliTestSessionOwner(value: unknown): value is CliTestSessionOwner {
  return record(value) && typeof value.pid === "number" && Number.isSafeInteger(value.pid) && value.pid > 0 && typeof value.token === "string" && value.token.length > 0 && typeof value.startedAt === "number" && Number.isFinite(value.startedAt);
}

export function readCliTestSessionOwner(path: string): CliTestSessionOwner {
  const value: unknown = readJson(path);
  if (!isCliTestSessionOwner(value)) throw new Error(`Invalid session owner: ${path}`);
  return value;
}

export function isCliTestBundleFunction(value: unknown): value is CliTestBundleFunction {
  return record(value) && typeof value.run === "function";
}

export function isCliTestBundleExtension(value: unknown): value is CliTestBundleExtension {
  if (!record(value) || value.functions === undefined) return record(value);
  return record(value.functions) && Object.values(value.functions).every(isCliTestBundleFunction);
}

export function isCliTestBundleModule(value: unknown): value is CliTestBundleModule {
  return record(value) && typeof value.register === "function";
}

function cliTestString(value: unknown): string {
  if (typeof value === "string" || value instanceof Error) return String(value);
  if (value === null || typeof value !== "object") return String(value);
  return JSON.stringify(value);
}

export function cliTestErrorOutput(error: unknown): string {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    const stderr: unknown = Reflect.get(error, "stderr");
    return cliTestString(stderr ?? error);
  }
  return cliTestString(error);
}
