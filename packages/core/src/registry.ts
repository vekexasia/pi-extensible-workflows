import { readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import type { AgentAttemptAction, JsonSchema, JsonValue, RegisteredAgentSetupHook, WorkflowCatalog, WorkflowCatalogContext, WorkflowCatalogError, WorkflowCatalogFunction, WorkflowCatalogIndex, WorkflowCatalogModelAlias, WorkflowExtension, WorkflowFunction, WorkflowFunctionContext, WorkflowFunctionSource, WorkflowJournal, WorkflowModelAlias, WorkflowModelAliasResolverContext, WorkflowRoleDirectoryRegistration } from "./types.js";
import type { SubagentRunRequest, SubagentStatus } from "../subagents/src/contracts.js";
import { deepFreeze, errorCode, errorText, fail, jsonValue, object } from "./utils.js";
import { loadSettings, resolveWorkflowSettings, validateSchema } from "./validation.js";

const RESERVED_GLOBALS = new Set(["agent", "shell", "prompt", "checkpoint", "parallel", "pipeline", "phase", "withWorktree", "log", "args", "Promise", "JSON", "Math", "Date", "eval", "Function", "WebAssembly", "process", "require", "module", "exports", "console", "fetch", "XMLHttpRequest", "WebSocket", "performance", "crypto", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "Intl", "SharedArrayBuffer", "Atomics", "globalThis", "global", "undefined", "NaN", "Infinity", "extensions", "workflow_catalog"]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
type BundleExtensionCapture = (extension: WorkflowExtension) => void;
const bundleGlobals = globalThis as typeof globalThis & { __pi_bundle_capture?: BundleExtensionCapture };
export type SubagentStatusObserver = (status: Readonly<SubagentStatus>, request: Readonly<SubagentRunRequest>) => void;

function normalizeRoleDirectory(value: unknown): string {
  try {
    if (value instanceof URL) {
      if (value.protocol !== "file:") fail("INVALID_METADATA", "Workflow role directories require file URLs or absolute filesystem paths");
      return fileURLToPath(value);
    }
    if (typeof value === "string") {
      if (value.startsWith("file:")) return fileURLToPath(value);
      if (isAbsolute(value)) return value;
    }
  } catch (error) {
    fail("INVALID_METADATA", `Invalid workflow role directory: ${errorText(error)}`);
  }
  fail("INVALID_METADATA", "Workflow role directories require file URLs or absolute filesystem paths");
}
function canonicalRoleDirectory(path: string): string { try { return realpathSync(path); } catch { return resolve(path); } }
function isBuiltinRoleDirectory(path: string): boolean {
  const canonical = canonicalRoleDirectory(path);
  const starterDirectory = dirname(canonical);
  if (basename(canonical) !== "roles" || basename(starterDirectory) !== "starter") return false;
  const distributionDirectory = dirname(starterDirectory);
  const packageRoot = basename(distributionDirectory) === "dist" ? dirname(distributionDirectory) : distributionDirectory;
  try {
    const metadata: unknown = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
    return object(metadata) && metadata.name === "pi-extensible-workflows";
  } catch { return false; }
}

function catalogSchema(schema: unknown, at: string): JsonSchema {
  validateSchema(schema, at);
  return structuredClone(schema);
}
export class WorkflowRegistry {
  readonly #extensions = new Set<Readonly<WorkflowExtension>>();
  readonly #functionSources = new Map<string, WorkflowFunctionSource>();
  readonly #globals = new Map<string, string>();
  readonly #hooks = new Map<string, RegisteredAgentSetupHook>();
  readonly #agentAttemptActions = new Map<string, AgentAttemptAction>();
  readonly #roleDirectories = new Map<string, WorkflowRoleDirectoryRegistration>();
  readonly #modelAliases = new Map<string, { name: string; version: string; headline: string; resolve: WorkflowModelAlias["resolve"] }>();
  #frozen = false;
  #subagentStatusObserver: SubagentStatusObserver | undefined;

  get frozen(): boolean { return this.#frozen; }
  freeze(): void { this.#frozen = true; }
  setSubagentStatusObserver(observer: SubagentStatusObserver | undefined): void { this.#subagentStatusObserver = observer; }
  observeSubagentStatus(status: Readonly<SubagentStatus>, request: Readonly<SubagentRunRequest>): void { this.#subagentStatusObserver?.(status, request); }

  register(extension: WorkflowExtension): void {
    if (this.#frozen) fail("REGISTRY_FROZEN", "Workflow extension registration is closed after session_start");
    if (object(extension) && Object.prototype.hasOwnProperty.call(extension, "workflows")) fail("INVALID_METADATA", "Separate registered workflow definitions were removed; register a function with input and output schemas instead");
    if (!object(extension) || Object.keys(extension).some((key) => !["version", "headline", "description", "source", "dependencies", "functions", "modelAliases", "agentSetupHooks", "agentAttemptActions", "roleDirectories"].includes(key)) || typeof extension.version !== "string" || !SEMVER.test(extension.version) || typeof extension.headline !== "string" || !extension.headline.trim()) fail("INVALID_METADATA", "Workflow extensions require a semantic version and non-empty headline");
    const functions = extension.functions ?? {};
    const modelAliases = extension.modelAliases ?? {};
    const agentSetupHooks = extension.agentSetupHooks ?? {};
    const agentAttemptActions = extension.agentAttemptActions ?? {};
    const source = extension.source;
    const dependencyValues = extension.dependencies;
    const dependencies: readonly string[] = dependencyValues ?? [];
    if (source !== undefined && (typeof source !== "string" || !source.trim())) fail("INVALID_METADATA", "Workflow extension source must be a non-empty module URL");
    if (dependencyValues !== undefined && (!Array.isArray(dependencyValues) || dependencyValues.some((dependency) => typeof dependency !== "string" || dependency.trim() !== dependency || !PACKAGE_NAME.test(dependency)) || new Set(dependencyValues).size !== dependencyValues.length)) fail("INVALID_METADATA", "Workflow extension dependencies must be unique, non-empty package names");
    const roleDirectoryValues = extension.roleDirectories === undefined ? [] : extension.roleDirectories;
    if (!Array.isArray(roleDirectoryValues)) fail("INVALID_METADATA", "Workflow extension roleDirectories must be an array");
    const roleDirectories = [...new Set(Array.from(roleDirectoryValues, (value) => normalizeRoleDirectory(value)))];
    if (!object(functions) || !object(modelAliases) || !object(agentSetupHooks) || !object(agentAttemptActions) || (Object.keys(functions).length === 0 && Object.keys(modelAliases).length === 0 && Object.keys(agentSetupHooks).length === 0 && Object.keys(agentAttemptActions).length === 0 && roleDirectories.length === 0)) fail("INVALID_METADATA", "Workflow extensions require functions, model aliases, agent setup hooks, agent attempt actions, or role directories");
    const names = Object.keys(functions);
    if (new Set(names).size !== names.length) fail("GLOBAL_COLLISION", "Global name collision inside extension");
    for (const name of names) {
      if (!IDENTIFIER.test(name) || name.startsWith("__pi_extensible_workflows_")) fail("INVALID_METADATA", `Invalid global name: ${name}`);
      if (RESERVED_GLOBALS.has(name)) fail("GLOBAL_COLLISION", `Global name is reserved: ${name}`);
      if (this.#globals.has(name)) fail("GLOBAL_COLLISION", `Global name is already registered: ${name}`);
    }
    for (const [name, fn] of Object.entries(functions)) {
      if (!object(fn) || Object.keys(fn).some((key) => !["description", "input", "output", "run"].includes(key)) || typeof fn.description !== "string" || !fn.description.trim() || typeof fn.run !== "function") fail("INVALID_METADATA", `Invalid workflow function: ${name}`);
      validateSchema(fn.input, `${name} input`);
      validateSchema(fn.output, `${name} output`);
      if (fn.input.type !== "object") fail("INVALID_SCHEMA", `${name} input must describe one object`);
    }
    for (const [name, alias] of Object.entries(modelAliases)) {
      if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(name)) fail("INVALID_METADATA", `Invalid model alias name: ${name}`);
      if (!object(alias) || Object.keys(alias).some((key) => key !== "resolve") || typeof alias.resolve !== "function") fail("INVALID_METADATA", `Invalid model alias resolver: ${name}`);
      if (this.#modelAliases.has(name)) fail("DUPLICATE_NAME", `Model alias already registered: ${name}`);
    }
    for (const [name, hook] of Object.entries(agentSetupHooks)) {
      if (!IDENTIFIER.test(name) || !object(hook) || Object.keys(hook).some((key) => !["priority", "setup"].includes(key)) || typeof hook.setup !== "function" || hook.priority !== undefined && (typeof hook.priority !== "number" || !Number.isFinite(hook.priority))) fail("INVALID_METADATA", `Invalid agent setup hook: ${name}`);
      if (this.#hooks.has(name)) fail("DUPLICATE_NAME", `Agent setup hook already registered: ${name}`);
    }
    for (const [name, action] of Object.entries(agentAttemptActions)) {
      if (!IDENTIFIER.test(name) || !object(action) || Object.keys(action).some((key) => !["label", "visible", "run", "visibleStandalone", "runStandalone"].includes(key)) || typeof action.label !== "string" || !action.label.trim() || typeof action.visible !== "function" || typeof action.run !== "function" || action.visibleStandalone !== undefined && typeof action.visibleStandalone !== "function" || action.runStandalone !== undefined && typeof action.runStandalone !== "function") fail("INVALID_METADATA", `Invalid agent attempt action: ${name}`);
      if ((action.visibleStandalone !== undefined) !== (action.runStandalone !== undefined)) fail("INVALID_METADATA", `Standalone agent attempt actions require visibleStandalone and runStandalone: ${name}`);
      if (this.#agentAttemptActions.has(name)) fail("DUPLICATE_NAME", `Agent attempt action already registered: ${name}`);
    }
    const stored = deepFreeze({ ...extension, functions, modelAliases, agentSetupHooks, agentAttemptActions, ...(roleDirectories.length ? { roleDirectories } : {}) });
    if (source !== undefined) for (const name of names) this.#functionSources.set(name, Object.freeze({ module: source, export: "default", dependencies: Object.freeze([...dependencies]) }));
    this.#extensions.add(stored);
    for (const directory of roleDirectories) if (!this.#roleDirectories.has(directory)) this.#roleDirectories.set(directory, deepFreeze({ path: directory, extension: { version: extension.version, headline: extension.headline }, ...(isBuiltinRoleDirectory(directory) ? { builtin: true as const } : {}) }));
    for (const name of names) this.#globals.set(name, name);
    for (const [name, alias] of Object.entries(modelAliases)) this.#modelAliases.set(name, { name, version: extension.version, headline: extension.headline, resolve: alias.resolve });
    for (const [name, hook] of Object.entries(agentSetupHooks)) this.#hooks.set(name, { name, priority: hook.priority ?? 10, setup: hook.setup });
    for (const [name, action] of Object.entries(agentAttemptActions)) this.#agentAttemptActions.set(name, action);
  }

  function(name: string): WorkflowFunction {
    if (!IDENTIFIER.test(name)) fail("MISSING_WORKFLOW", `Registered functions require an unqualified name: ${name}`);
    const fn = [...this.#extensions].find((extension) => extension.functions?.[name])?.functions?.[name];
    if (!fn) fail("MISSING_WORKFLOW", `Registered function is unavailable: ${name}; the separate registered-workflow format was removed`);
    return fn;
  }

  functions(): Readonly<Record<string, WorkflowFunction>> {
    return Object.freeze(Object.fromEntries([...this.#extensions].flatMap((extension) => Object.entries(extension.functions ?? {}))));
  }
  functionSources(): Readonly<Record<string, WorkflowFunctionSource>> {
    return Object.freeze(Object.fromEntries([...this.#functionSources].map(([name, source]) => [name, source])));
  }

  catalog(context?: WorkflowCatalogContext): WorkflowCatalog {
    const functions: WorkflowCatalogFunction[] = [];
    for (const extension of this.#extensions) {
      for (const [name, fn] of Object.entries(extension.functions ?? {})) functions.push({ name, version: extension.version, headline: extension.headline, description: fn.description, input: catalogSchema(fn.input, `${name} input`), output: catalogSchema(fn.output, `${name} output`) });
    }
    let aliases: Readonly<Record<string, string>> | undefined;
    let settings: WorkflowCatalog["settings"];
    let source = "global settings";
    try {
      const resolved = context ? resolveWorkflowSettings(context.cwd, context.projectTrusted, context.globalSettingsPath) : undefined;
      aliases = resolved?.effective.modelAliases ?? loadSettings().modelAliases;
      if (resolved) { source = resolved.projectTrusted && [resolved.sources.modelAliases, resolved.sources.skills, resolved.sources.extensions, resolved.sources.tools, resolved.sources.extensionSettings].some((path) => path === resolved.projectSettingsPath) ? "trusted project settings" : "global settings"; settings = { concurrency: resolved.effective.concurrency, backgroundWidget: resolved.effective.backgroundWidget ?? true, modelAliases: resolved.effective.modelAliases ?? {}, skills: resolved.effective.skills ?? [], extensions: Array.isArray(resolved.effective.extensions) ? resolved.effective.extensions : [], ...(resolved.effective.extensionSettings === undefined ? {} : { extensionSettings: resolved.effective.extensionSettings }), tools: resolved.effective.tools ?? [], globalSettingsPath: resolved.globalSettingsPath, projectSettingsPath: resolved.projectSettingsPath, projectTrusted: resolved.projectTrusted, sources: resolved.sources }; }
    } catch { aliases = undefined; }
    const staticEntries: WorkflowCatalogModelAlias[] = Object.keys(aliases ?? {}).map((name) => ({ name, kind: "static", provenance: source }));
    const dynamicEntries: WorkflowCatalogModelAlias[] = [...this.#modelAliases.values()].map(({ name, version, headline }) => ({ name, kind: "dynamic", provenance: `extension: ${headline}`, version, headline }));
    const modelAliasEntries = [...staticEntries, ...dynamicEntries].sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind) || left.provenance.localeCompare(right.provenance));
    const sort = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name);
    const catalog: WorkflowCatalog = { functions: functions.sort(sort), ...(modelAliasEntries.length ? { modelAliasEntries } : {}) };
    if (aliases && Object.keys(aliases).length) Object.defineProperty(catalog, "modelAliases", { value: Object.freeze(structuredClone(aliases)), enumerable: false });
    if (settings) { const publicSettings = { ...settings, modelAliases: Object.keys(aliases ?? {}).length ? {} : settings.modelAliases }; Object.defineProperty(catalog, "settings", { value: deepFreeze(publicSettings), enumerable: true }); }
    return deepFreeze(catalog);
  }
  catalogIndex(context?: WorkflowCatalogContext): WorkflowCatalogIndex {
    const catalog = this.catalog(context);
    let modelAliasEntries: WorkflowCatalogModelAlias[] | undefined;
    if (catalog.modelAliasEntries !== undefined) {
      const winningEntries = new Map<string, WorkflowCatalogModelAlias>();
      for (const entry of catalog.modelAliasEntries) {
        if (!winningEntries.has(entry.name) || entry.kind === "static") winningEntries.set(entry.name, entry);
      }
      modelAliasEntries = [...winningEntries.values()];
    }
    const index: WorkflowCatalogIndex = {
      functions: catalog.functions.map(({ name, description, input }) => ({ name, description, input: structuredClone(input) })),
      ...(modelAliasEntries ? { modelAliasEntries: structuredClone(modelAliasEntries) } : {}),
    };
    if (catalog.modelAliases) Object.defineProperty(index, "modelAliases", { value: Object.freeze(structuredClone(catalog.modelAliases)), enumerable: false });
    if (catalog.settings) Object.defineProperty(index, "settings", { value: deepFreeze(structuredClone(catalog.settings)), enumerable: true });
    return deepFreeze(index);
  }
  catalogDetail(name: string, context?: WorkflowCatalogContext): WorkflowCatalogFunction | WorkflowCatalogModelAlias | WorkflowCatalogError {
    const catalog = this.catalog(context);
    const entry = catalog.functions.find((candidate) => candidate.name === name);
    if (entry) return entry;
    const alias = catalog.modelAliasEntries?.find((candidate) => candidate.name === name && candidate.kind === "static")
      ?? catalog.modelAliasEntries?.find((candidate) => candidate.name === name);
    if (alias) return alias;
    return deepFreeze({ error: { code: "NOT_FOUND", name, message: `No registered workflow function is available: ${name}` } });
  }

  globals(): Readonly<Record<string, { name: string }>> {
    return Object.freeze(Object.fromEntries([...this.#extensions].flatMap((extension) => Object.keys(extension.functions ?? {}).map((name) => [name, { name }]))));
  }

  async invokeFunction(name: string, input: unknown, context: Readonly<WorkflowFunctionContext>, path: string, journal: WorkflowJournal): Promise<JsonValue> {
    const fn = this.function(name);
    if (!object(input) || !jsonValue(input) || !Value.Check(fn.input, input)) fail("RESULT_INVALID", `Invalid input for ${name}`);
    const replayed = journal.get(path);
    if (replayed !== undefined) {
      if (!jsonValue(replayed) || !Value.Check(fn.output, replayed)) fail("RESULT_INVALID", `Invalid replay for ${name}`);
      return structuredClone(replayed);
    }
    const result: unknown = await fn.run(deepFreeze(structuredClone(input)), Object.freeze({ run: context.run, invoke: context.invoke, agent: context.agent, shell: context.shell, prompt: context.prompt, parallel: context.parallel, pipeline: context.pipeline, withWorktree: context.withWorktree, checkpoint: context.checkpoint, phase: context.phase, log: context.log }));
    if (!jsonValue(result) || !Value.Check(fn.output, result)) fail("RESULT_INVALID", `Invalid output from ${name}`);
    const stored = structuredClone(result);
    journal.put(path, stored);
    return structuredClone(stored);
  }

  agentSetupHooks(): readonly RegisteredAgentSetupHook[] {
    return [...this.#hooks.values()].sort((left, right) => left.priority - right.priority || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  }
  agentAttemptActions(): Readonly<Record<string, AgentAttemptAction>> { return Object.freeze(Object.fromEntries(this.#agentAttemptActions.entries())); }
  roleDirectories(): readonly string[] {
    return [...this.#roleDirectories.keys()];
  }
  roleDirectoryRegistrations(): readonly WorkflowRoleDirectoryRegistration[] {
    return [...this.#roleDirectories.values()];
  }
  modelAliases(): readonly { name: string; version: string; headline: string; resolve: WorkflowModelAlias["resolve"] }[] { return [...this.#modelAliases.values()].sort((left, right) => left.name.localeCompare(right.name)); }
  async resolveModelAliases(context: Readonly<WorkflowModelAliasResolverContext>, shadowed: ReadonlySet<string> = new Set()): Promise<Readonly<Record<string, string>>> {
    const resolved: Record<string, string> = {};
    const isAborted = (): boolean => context.signal.aborted;
    for (const alias of this.modelAliases()) {
      if (shadowed.has(alias.name)) continue;
      if (isAborted()) fail("CANCELLED", `Model alias resolver cancelled: ${alias.name} (${alias.headline})`);
      let target: unknown;
      try { target = await alias.resolve(Object.freeze({ cwd: context.cwd, projectTrusted: context.projectTrusted, rootModel: Object.freeze({ ...context.rootModel }), knownModels: new Set(context.knownModels), availableModels: new Set(context.availableModels), signal: context.signal })); }
      catch (error) {
        if (isAborted() || error instanceof Error && error.name === "AbortError" || errorCode(error) === "CANCELLED") fail("CANCELLED", `Model alias resolver cancelled: ${alias.name} (${alias.headline})`);
        fail("CONFIG_ERROR", `Model alias resolver failed for ${alias.name} (${alias.headline}): ${errorText(error)}`);
      }
      if (isAborted()) fail("CANCELLED", `Model alias resolver cancelled: ${alias.name} (${alias.headline})`);
      if (typeof target !== "string" || !target.trim()) fail("CONFIG_ERROR", `Model alias resolver returned an invalid target for ${alias.name} (${alias.headline})`);
      resolved[alias.name] = target.trim();
    }
    return Object.freeze(resolved);
  }
}
export type WorkflowRegistryApi = Pick<WorkflowRegistry, "frozen" | "freeze" | "register" | "function" | "functions" | "functionSources" | "catalog" | "catalogIndex" | "catalogDetail" | "globals" | "invokeFunction" | "modelAliases" | "resolveModelAliases" | "agentSetupHooks" | "agentAttemptActions" | "roleDirectories" | "roleDirectoryRegistrations" | "setSubagentStatusObserver" | "observeSubagentStatus">;
interface WorkflowRegistryHost { api: WorkflowRegistryApi; activeHosts: number }
const WORKFLOW_REGISTRY_KEY = Symbol.for("pi-extensible-workflows.workflow-registry");
const globalRegistry = globalThis as typeof globalThis & Record<symbol, WorkflowRegistryHost | undefined>;
function createWorkflowRegistryApi(registry: WorkflowRegistry): WorkflowRegistryApi {
  return {
    get frozen() { return registry.frozen; },
    freeze: () => { registry.freeze(); },
    setSubagentStatusObserver: (observer) => { registry.setSubagentStatusObserver(observer); },
    observeSubagentStatus: (status, request) => { registry.observeSubagentStatus(status, request); },
    register: (extension) => { registry.register(extension); },
    function: (name) => registry.function(name),
    functions: () => registry.functions(),
    functionSources: () => registry.functionSources(),
    catalog: (context) => registry.catalog(context),
    catalogIndex: (context) => registry.catalogIndex(context),
    catalogDetail: (name, context) => registry.catalogDetail(name, context),
    globals: () => registry.globals(),
    invokeFunction: (...args) => registry.invokeFunction(...args),
    modelAliases: () => registry.modelAliases(),
    resolveModelAliases: (...args) => registry.resolveModelAliases(...args),
    roleDirectories: () => registry.roleDirectories(),
    roleDirectoryRegistrations: () => registry.roleDirectoryRegistrations(),
    agentSetupHooks: () => registry.agentSetupHooks(),
    agentAttemptActions: () => registry.agentAttemptActions(),
  };
}
function workflowRegistryHost(): WorkflowRegistryHost {
  return globalRegistry[WORKFLOW_REGISTRY_KEY] ??= { api: createWorkflowRegistryApi(new WorkflowRegistry()), activeHosts: 0 };
}
export function resetWorkflowRegistry(): void {
  workflowRegistryHost().api = createWorkflowRegistryApi(new WorkflowRegistry());
}
export function resetWorkflowRegistryIfIdle(): void {
  if (workflowRegistryHost().activeHosts === 0) resetWorkflowRegistry();
}
export function beginWorkflowExtensionLoading(): void {
  const host = workflowRegistryHost();
  if (host.api.frozen && host.activeHosts === 0) resetWorkflowRegistry();
}
export function retainWorkflowRegistry(): () => void {
  const host = workflowRegistryHost();
  host.activeHosts += 1;
  let retained = true;
  return () => {
    if (!retained) return;
    retained = false;
    host.activeHosts -= 1;
    if (host.activeHosts === 0) resetWorkflowRegistry();
  };
}
export function loadingRegistry(): WorkflowRegistryApi { return workflowRegistryHost().api; }
beginWorkflowExtensionLoading();
export function registerWorkflowExtension(extension: WorkflowExtension): void {
  if (bundleGlobals.__pi_bundle_capture) { bundleGlobals.__pi_bundle_capture(extension); return; }
  loadingRegistry().register(extension);
}
export function workflowCatalog(context?: WorkflowCatalogContext): WorkflowCatalog { return loadingRegistry().catalog(context); }
export function workflowCatalogIndex(context?: WorkflowCatalogContext): WorkflowCatalogIndex { return loadingRegistry().catalogIndex(context); }
export function workflowCatalogDetail(name: string, context?: WorkflowCatalogContext): WorkflowCatalogFunction | WorkflowCatalogModelAlias | WorkflowCatalogError { return loadingRegistry().catalogDetail(name, context); }
export function registeredWorkflowFunctions(): Readonly<Record<string, WorkflowFunction>> { return loadingRegistry().functions(); }
export function registeredWorkflowFunctionSources(): Readonly<Record<string, WorkflowFunctionSource>> {
  const sources = loadingRegistry().functionSources;
  return typeof sources === "function" ? sources() : {};
}
export function registeredWorkflowRoleDirectories(): readonly string[] {
  const directories = loadingRegistry().roleDirectories;
  return typeof directories === "function" ? directories() : [];
}
export function registeredWorkflowRoleDirectoryRegistrations(): readonly WorkflowRoleDirectoryRegistration[] {
  const registrations = loadingRegistry().roleDirectoryRegistrations;
  return typeof registrations === "function" ? registrations() : [];
}

export type { WorkflowCatalog, WorkflowCatalogContext, WorkflowCatalogError, WorkflowCatalogFunction, WorkflowCatalogIndex, WorkflowCatalogIndexFunction, WorkflowCatalogModelAlias, WorkflowCatalogSettings, WorkflowRoleDirectoryRegistration } from "./types.js";
