import { Value } from "typebox/value";
import type { JsonValue, RegisteredAgentSetupHook, WorkflowCatalog, WorkflowCatalogError, WorkflowCatalogFunction, WorkflowCatalogIndex, WorkflowCatalogVariable, WorkflowExtension, WorkflowFunction, WorkflowFunctionContext, WorkflowJournal, WorkflowVariable } from "./types.js";
import { deepFreeze, fail, jsonValue, object } from "./utils.js";
import { loadSettings, validateSchema } from "./validation.js";

const RESERVED_GLOBALS = new Set(["agent", "shell", "prompt", "checkpoint", "parallel", "pipeline", "phase", "withWorktree", "log", "args", "Promise", "JSON", "Math", "Date", "eval", "Function", "WebAssembly", "process", "require", "module", "exports", "console", "fetch", "XMLHttpRequest", "WebSocket", "performance", "crypto", "setTimeout", "setInterval", "setImmediate", "queueMicrotask", "Intl", "SharedArrayBuffer", "Atomics", "globalThis", "global", "undefined", "NaN", "Infinity", "extensions", "workflow_catalog"]);
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export class WorkflowRegistry {
  readonly #extensions = new Set<Readonly<WorkflowExtension>>();
  readonly #globals = new Map<string, string>();
  readonly #hooks = new Map<string, RegisteredAgentSetupHook>();
  #frozen = false;

  get frozen(): boolean { return this.#frozen; }
  freeze(): void { this.#frozen = true; }

  register(extension: WorkflowExtension): void {
    if (this.#frozen) fail("REGISTRY_FROZEN", "Workflow extension registration is closed after session_start");
    if (object(extension) && Object.prototype.hasOwnProperty.call(extension, "workflows")) fail("INVALID_METADATA", "Separate registered workflow definitions were removed; register a function with input and output schemas instead");
    if (!object(extension) || Object.keys(extension).some((key) => !["version", "headline", "description", "functions", "variables", "agentSetupHooks"].includes(key)) || typeof extension.version !== "string" || !SEMVER.test(extension.version) || typeof extension.headline !== "string" || !extension.headline.trim() || typeof extension.description !== "string" || !extension.description.trim()) fail("INVALID_METADATA", "Workflow extensions require a semantic version, headline, and description");
    const functions = extension.functions ?? {};
    const variables = extension.variables ?? {};
    const agentSetupHooks = extension.agentSetupHooks ?? {};
    if (!object(functions) || !object(variables) || !object(agentSetupHooks) || (Object.keys(functions).length === 0 && Object.keys(variables).length === 0 && Object.keys(agentSetupHooks).length === 0)) fail("INVALID_METADATA", "Workflow extensions require functions, variables, or agent setup hooks");
    const names = [...Object.keys(functions), ...Object.keys(variables)];
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
    for (const [name, variable] of Object.entries(variables)) {
      if (!object(variable) || Object.keys(variable).some((key) => !["description", "schema", "resolve"].includes(key)) || typeof variable.description !== "string" || !variable.description.trim() || typeof variable.resolve !== "function") fail("INVALID_METADATA", `Invalid workflow variable: ${name}`);
      validateSchema(variable.schema, `${name} schema`);
    }
    for (const [name, hook] of Object.entries(agentSetupHooks)) {
      if (!IDENTIFIER.test(name) || !object(hook) || Object.keys(hook).some((key) => !["priority", "setup"].includes(key)) || typeof hook.setup !== "function" || hook.priority !== undefined && (typeof hook.priority !== "number" || !Number.isFinite(hook.priority))) fail("INVALID_METADATA", `Invalid agent setup hook: ${name}`);
      if (this.#hooks.has(name)) fail("DUPLICATE_NAME", `Agent setup hook already registered: ${name}`);
    }
    const stored = deepFreeze({ ...extension, functions, variables, agentSetupHooks });
    this.#extensions.add(stored);
    for (const name of names) this.#globals.set(name, name);
    for (const [name, hook] of Object.entries(agentSetupHooks)) this.#hooks.set(name, { name, priority: hook.priority ?? 10, setup: hook.setup });
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

  catalog(): WorkflowCatalog {
    const functions: WorkflowCatalogFunction[] = [];
    const variables: WorkflowCatalogVariable[] = [];
    for (const extension of this.#extensions) {
      for (const [name, fn] of Object.entries(extension.functions ?? {})) functions.push({ name, version: extension.version, headline: extension.headline, extensionDescription: extension.description, description: fn.description, input: structuredClone(fn.input), output: structuredClone(fn.output) });
      for (const [name, variable] of Object.entries(extension.variables ?? {})) variables.push({ name, version: extension.version, headline: extension.headline, extensionDescription: extension.description, description: variable.description, schema: structuredClone(variable.schema) });
    }
    let aliases: Readonly<Record<string, string>> | undefined;
    try { aliases = loadSettings().modelAliases; } catch { aliases = undefined; }
    const sort = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name);
    return deepFreeze({ functions: functions.sort(sort), variables: variables.sort(sort), ...(aliases ? { modelAliases: structuredClone(aliases) } : {}) });
  }

  catalogIndex(): WorkflowCatalogIndex {
    const catalog = this.catalog();
    return deepFreeze({
      functions: catalog.functions.map(({ name, description, input }) => ({ name, description, input: structuredClone(input) })),
      variables: catalog.variables.map(({ name, description, schema }) => ({ name, description, schema: structuredClone(schema) })),
      ...(catalog.modelAliases ? { modelAliases: structuredClone(catalog.modelAliases) } : {}),
    });
  }

  catalogDetail(name: string): WorkflowCatalogFunction | WorkflowCatalogVariable | WorkflowCatalogError {
    const catalog = this.catalog();
    const entry = catalog.functions.find((candidate) => candidate.name === name) ?? catalog.variables.find((candidate) => candidate.name === name);
    if (entry) return entry;
    return deepFreeze({ error: { code: "NOT_FOUND", name, message: `No registered workflow function or variable is available: ${name}` } });
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

  variables(): readonly { name: string; variable: WorkflowVariable }[] {
    return [...this.#extensions].flatMap((extension) => Object.entries(extension.variables ?? {}).map(([name, variable]) => ({ name, variable })));
  }
  agentSetupHooks(): readonly RegisteredAgentSetupHook[] {
    return [...this.#hooks.values()].sort((left, right) => left.priority - right.priority || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  }
}
export type WorkflowRegistryApi = Pick<WorkflowRegistry, "frozen" | "freeze" | "register" | "function" | "functions" | "catalog" | "catalogIndex" | "catalogDetail" | "globals" | "invokeFunction" | "variables" | "agentSetupHooks">;
interface WorkflowRegistryHost { api: WorkflowRegistryApi }
const WORKFLOW_REGISTRY_KEY = Symbol.for("pi-extensible-workflows.workflow-registry");
const globalRegistry = globalThis as typeof globalThis & Record<symbol, WorkflowRegistryHost | undefined>;
function createWorkflowRegistryApi(registry: WorkflowRegistry): WorkflowRegistryApi {
  return {
    get frozen() { return registry.frozen; },
    freeze: () => { registry.freeze(); },
    register: (extension) => { registry.register(extension); },
    function: (name) => registry.function(name),
    functions: () => registry.functions(),
    catalog: () => registry.catalog(),
    catalogIndex: () => registry.catalogIndex(),
    catalogDetail: (name) => registry.catalogDetail(name),
    globals: () => registry.globals(),
    invokeFunction: (...args) => registry.invokeFunction(...args),
    variables: () => registry.variables(),
    agentSetupHooks: () => registry.agentSetupHooks(),
  };
}
function workflowRegistryHost(): WorkflowRegistryHost {
  return globalRegistry[WORKFLOW_REGISTRY_KEY] ??= { api: createWorkflowRegistryApi(new WorkflowRegistry()) };
}
export function resetWorkflowRegistry(): void {
  workflowRegistryHost().api = createWorkflowRegistryApi(new WorkflowRegistry());
}
export function beginWorkflowExtensionLoading(): void {
  if (workflowRegistryHost().api.frozen) resetWorkflowRegistry();
}
export function loadingRegistry(): WorkflowRegistryApi { return workflowRegistryHost().api; }
beginWorkflowExtensionLoading();
export function registerWorkflowExtension(extension: WorkflowExtension): void { loadingRegistry().register(extension); }
export function workflowCatalog(): WorkflowCatalog { return loadingRegistry().catalog(); }
export function workflowCatalogIndex(): WorkflowCatalogIndex { return loadingRegistry().catalogIndex(); }
export function workflowCatalogDetail(name: string): WorkflowCatalogFunction | WorkflowCatalogVariable | WorkflowCatalogError { return loadingRegistry().catalogDetail(name); }
export function registeredWorkflowFunctions(): Readonly<Record<string, WorkflowFunction>> { return loadingRegistry().functions(); }

export type { WorkflowCatalog, WorkflowCatalogError, WorkflowCatalogFunction, WorkflowCatalogIndex, WorkflowCatalogIndexFunction, WorkflowCatalogIndexVariable, WorkflowCatalogVariable } from "./types.js";
