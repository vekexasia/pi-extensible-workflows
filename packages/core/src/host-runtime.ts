import { AsyncLocalStorage } from "node:async_hooks";
import { type AgentProviderFailure, type AgentProviderRecovery, WorkflowAgentExecutor } from "./agent-execution.js";
import { type PersistedRun, type RunStore, type WorktreeReference } from "./persistence.js";
import { deepFreeze, errorCode, errorText, fail, isWorkflowErrorCode, jsonValue, object } from "./utils.js";
import { validateAgentOptions, validateShellOptions, workflowPrompt } from "./validation.js";
import { type WorkflowRegistryApi } from "./registry.js";
import { HARD_TERMINAL_RUN_STATES, WORKFLOW_AGENT_STATE_CHANGED_EVENT, WORKFLOW_BUDGET_EVENT, WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, WORKFLOW_PHASE_CHANGED_EVENT, WORKFLOW_RUN_COMPLETED_EVENT, WORKFLOW_RUN_FAILED_EVENT, WORKFLOW_RUN_RESUMED_EVENT, WORKFLOW_RUN_STARTED_EVENT, WORKFLOW_RUN_STATE_CHANGED_EVENT, WORKFLOW_WORKTREE_CREATED_EVENT, WorkflowError, type AgentOptions, type AgentRecord, type BudgetEvent, type FunctionIdentity, type JsonValue, type ModelSpec, type ParallelResult, type ParallelTasks, type PipelineItems, type PipelineResult, type PipelineStages, type RunState, type WorkflowBridge, type WorkflowCheckpointState, type WorkflowErrorShape, type WorkflowEventBase, type WorkflowExecution, type WorkflowFunctionContext, type WorkflowMetadata, type WorkflowRunContext, type WorkflowWorktreeCallback, type WorkflowWorktreeReference } from "./types.js";
import { structuralPath as operationPath } from "./persistence.js";

type WorkflowEventSink = { emit: (name: string, payload: unknown) => unknown };
const inheritedHostAgentPath = new AsyncLocalStorage<readonly string[]>();
const inheritedHostWorktreeOwner = new AsyncLocalStorage<string>();

export type WorkflowToolUpdate = { content: [{ type: "text"; text: string }]; details: { runId: string; run: import("./persistence.js").PersistedRun } };
export type WorkflowRunRecord = {
  executor: WorkflowAgentExecutor;
  store: RunStore;
  metadata: WorkflowMetadata;
  model: ModelSpec;
  lifecycle: RunLifecycle;
  budget: import("./budget.js").WorkflowBudgetRuntime;
  abortController: AbortController;
  projectTrusted: () => boolean;
  providerErrorRecovery?: (failure: AgentProviderFailure) => Promise<AgentProviderRecovery>;
  execution?: WorkflowExecution;
  completion?: Promise<unknown>;
  foreground?: boolean;
  checkpointResolvers: Map<string, (value: boolean) => void>;
  update?: (result: WorkflowToolUpdate) => void;
};

export class RunLifecycle {
  #state: RunState;
  #active = 0;
  #waiters: Array<() => void> = [];

  constructor(state: RunState = "running", private readonly changed?: (state: RunState, previousState: RunState, reason?: string) => void | Promise<void>) { this.#state = state; }
  get state(): RunState { return this.#state; }

  async enter(): Promise<void> {
    while (this.#state === "pausing" || this.#state === "paused" || this.#state === "awaiting_input") await new Promise<void>((resolve) => { this.#waiters.push(resolve); });
    if (this.#state !== "running") throw new WorkflowError("CANCELLED", `Run is ${this.#state}`);
    this.#active += 1;
  }

  async leave(): Promise<void> {
    if (this.#active > 0) this.#active -= 1;
    if (this.#state === "pausing" && this.#active === 0) await this.#set("paused", "pause");
  }

  async enterAwaitingInput(): Promise<void> {
    while (this.#state === "pausing" || this.#state === "paused") await new Promise<void>((resolve) => { this.#waiters.push(resolve); });
    if (this.#state === "awaiting_input") return;
    if (this.#state !== "running") throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot await input for ${this.#state} run`);
    await this.#set("awaiting_input", "awaiting_input");
  }

  async resolveAwaitingInput(): Promise<void> {
    if (this.#state !== "awaiting_input") return;
    await this.#set("running", "checkpoint_resolved");
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async pause(): Promise<void> {
    if (this.#state !== "running") throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot pause ${this.#state} run`);
    await this.#set("pausing", "pause");
    if (this.#active === 0 && this.state === "pausing") await this.#set("paused", "pause");
  }

  async resume(): Promise<void> {
    if (this.#state !== "paused" && this.#state !== "interrupted" && this.#state !== "budget_exhausted") throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot resume ${this.#state} run`);
    await this.#set("running", "resume");
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async providerPause(): Promise<void> {
    await this.leave();
    if (this.#state === "running") await this.pause();
    await this.enter();
  }

  async terminal(state: "completed" | "failed" | "stopped" | "interrupted" | "budget_exhausted", reason?: string): Promise<void> {
    if (HARD_TERMINAL_RUN_STATES.has(this.#state)) throw new WorkflowError("RESUME_INCOMPATIBLE", `${this.#state} runs are terminal`);
    await this.#set(state, reason ?? state);
    for (const resolve of this.#waiters.splice(0)) resolve();
  }

  async #set(state: RunState, reason?: string): Promise<void> {
    const previousState = this.#state;
    this.#state = state;
    await this.changed?.(state, previousState, reason);
  }
}

function safeEventError(error: unknown): WorkflowErrorShape {
  const code = errorCode(error) ?? "INTERNAL_ERROR";
  return { code, message: `Workflow execution failed (${code})` };
}

export class WorkflowEventPublisher {
  #queues = new Map<string, Promise<void>>();
  #budgetEvents = new Map<string, Set<string>>();
  #worktrees = new Map<string, Set<string>>();

  constructor(private readonly sink: WorkflowEventSink | undefined) {}

  removeRun(runId: string): void {
    this.#queues.delete(runId);
    this.#budgetEvents.delete(runId);
    this.#worktrees.delete(runId);
  }

  seedBudget(runId: string, events: readonly BudgetEvent[] | undefined): void {
    const seen = this.#budgetEvents.get(runId) ?? new Set<string>();
    for (const event of events ?? []) seen.add(this.budgetKey(event));
    this.#budgetEvents.set(runId, seen);
  }

  async runStarted(store: RunStore, metadata: WorkflowMetadata): Promise<void> { await this.#publish(store, metadata, WORKFLOW_RUN_STARTED_EVENT, {}); }
  async runResumed(store: RunStore, metadata: WorkflowMetadata): Promise<void> { await this.#publish(store, metadata, WORKFLOW_RUN_RESUMED_EVENT, {}); }

  async runState(store: RunStore, metadata: WorkflowMetadata, previousState: RunState, state: RunState, reason?: string): Promise<void> {
    await this.#publish(store, metadata, WORKFLOW_RUN_STATE_CHANGED_EVENT, { previousState, state, ...(reason ? { reason } : {}), ...(isWorkflowErrorCode(reason) ? { errorCode: reason } : {}) });
    if ((previousState === "paused" || previousState === "interrupted" || previousState === "budget_exhausted") && state === "running") await this.runResumed(store, metadata);
  }

  async runCompleted(store: RunStore, metadata: WorkflowMetadata, resultPath: string): Promise<void> { await this.#publish(store, metadata, WORKFLOW_RUN_COMPLETED_EVENT, { resultPath }); }
  async runFailed(store: RunStore, metadata: WorkflowMetadata, error: unknown, state: "failed" | "stopped" | "interrupted" | "budget_exhausted"): Promise<void> {
    if (state === "failed") await this.#publish(store, metadata, WORKFLOW_RUN_FAILED_EVENT, { error: safeEventError(error) });
  }

  async agentState(store: RunStore, metadata: WorkflowMetadata, previous: AgentRecord | undefined, agent: AgentRecord): Promise<void> {
    await this.#publish(store, metadata, WORKFLOW_AGENT_STATE_CHANGED_EVENT, { agentId: agent.id, displayLabel: agent.label ?? agent.name, ...(agent.role ? { role: agent.role } : {}), structuralPath: [...(agent.structuralPath ?? [])], ...(agent.parentId ? { parentId: agent.parentId } : {}), ...(agent.parentBreadcrumb ? { parentBreadcrumb: agent.parentBreadcrumb } : {}), ...(agent.worktreeOwner ? { worktreeOwner: agent.worktreeOwner } : {}), ...(previous ? { previousState: previous.state } : {}), state: agent.state, attempt: agent.attempts });
  }

  async agentStates(store: RunStore, metadata: WorkflowMetadata, previous: readonly AgentRecord[], current: readonly AgentRecord[]): Promise<void> {
    const previousById = new Map(previous.map((agent) => [agent.id, agent]));
    for (const agent of current) {
      const old = previousById.get(agent.id);
      if (!old || old.state !== agent.state || old.attempts !== agent.attempts) await this.agentState(store, metadata, old, agent);
    }
  }

  async phase(store: RunStore, metadata: WorkflowMetadata, previousPhase: string | undefined, phase: string): Promise<void> {
    if (previousPhase !== phase) await this.#publish(store, metadata, WORKFLOW_PHASE_CHANGED_EVENT, { ...(previousPhase !== undefined ? { previousPhase } : {}), phase });
  }

  async checkpoint(store: RunStore, metadata: WorkflowMetadata, name: string, state: WorkflowCheckpointState): Promise<void> { await this.#publish(store, metadata, WORKFLOW_CHECKPOINT_STATE_CHANGED_EVENT, { name, state }); }

  async budget(store: RunStore, metadata: WorkflowMetadata, run: Pick<PersistedRun, "budgetEvents">): Promise<void> {
    const seen = this.#budgetEvents.get(store.runId) ?? new Set<string>();
    this.#budgetEvents.set(store.runId, seen);
    for (const event of run.budgetEvents ?? []) {
      const key = this.budgetKey(event);
      if (seen.has(key)) continue;
      seen.add(key);
      await this.#publish(store, metadata, WORKFLOW_BUDGET_EVENT, { ...event, timestamp: event.at });
    }
  }

  async worktree(store: RunStore, metadata: WorkflowMetadata, worktree: WorktreeReference): Promise<void> {
    const seen = this.#worktrees.get(store.runId) ?? new Set<string>();
    this.#worktrees.set(store.runId, seen);
    if (seen.has(worktree.owner)) return;
    seen.add(worktree.owner);
    await this.#publish(store, metadata, WORKFLOW_WORKTREE_CREATED_EVENT, { owner: worktree.owner, branch: worktree.branch, path: worktree.path, base: worktree.base });
  }

  async #publish(store: RunStore, metadata: WorkflowMetadata, name: string, payload: Record<string, unknown>): Promise<void> {
    const base: WorkflowEventBase = { runId: store.runId, sessionId: store.sessionId, workflowName: metadata.name, cwd: store.cwd, runDirectory: store.directory, timestamp: Date.now() };
    const previous = this.#queues.get(store.runId) ?? Promise.resolve();
    const next = previous.then(() => {
      try { void Promise.resolve(this.sink?.emit(name, { ...base, ...payload })).catch(() => undefined); } catch { /* Best effort: listeners cannot affect a run. */ }
    });
    this.#queues.set(store.runId, next.catch(() => undefined));
    await next;
  }

  private budgetKey(event: BudgetEvent): string { return `${String(event.budgetVersion)}:${event.type}:${event.proposalId ?? ""}`; }
}

function namedRecord(value: unknown, kind: string): Array<[string, unknown]> {
  if (!object(value)) fail("INVALID_METADATA", `${kind} must be a record`);
  return Object.entries(value);
}
function publicWorktreeReference(reference: WorkflowWorktreeReference): Readonly<WorkflowWorktreeReference> {
  if (!object(reference) || typeof reference.path !== "string" || typeof reference.branch !== "string") fail("WORKTREE_FAILED", "Worktree reference is invalid");
  return Object.freeze({ path: reference.path, branch: reference.branch });
}
async function hostWithWorktree<Result extends JsonValue>(name: string, callback: WorkflowWorktreeCallback<Result>, resolveWorktree: ((owner: string, signal: AbortSignal) => Promise<Readonly<WorkflowWorktreeReference>>) | undefined, signal: AbortSignal): Promise<Result> {
  if (typeof name !== "string" || !name.trim()) fail("INVALID_METADATA", "withWorktree name must be a non-empty string");
  if (typeof callback !== "function") fail("INVALID_METADATA", "withWorktree callback must be a function");
  if (!resolveWorktree) fail("WORKTREE_FAILED", "No worktree bridge is available");
  const owner = operationPath("worktree", "named", name.trim());
  const reference = publicWorktreeReference(await resolveWorktree(owner, signal));
  return inheritedHostWorktreeOwner.run(owner, () => callback(reference));
}
export function workflowRunContext(cwd: string, sessionId: string, runId: string, workflow: WorkflowMetadata, args: JsonValue, signal: AbortSignal): Readonly<WorkflowRunContext> {
  return Object.freeze({ cwd, sessionId, runId, workflow: deepFreeze(structuredClone(workflow)), args: deepFreeze(structuredClone(args)), signal });
}
function keyedJsonResult<Tasks extends ParallelTasks = ParallelTasks>(entries: readonly (readonly [string, JsonValue])[]): ParallelResult<Tasks> {
  return Object.fromEntries(entries) as ParallelResult<Tasks>;
}

async function hostParallel<Tasks extends ParallelTasks>(rawOperation: unknown, rawTasks: unknown): Promise<ParallelResult<Tasks>> {
  if (typeof rawOperation !== "string" || !rawOperation.trim()) fail("INVALID_METADATA", "parallel requires a stable explicit name");
  const tasks = namedRecord(rawTasks, "parallel tasks");
  for (const [name, run] of tasks) {
    if (!name.trim()) fail("INVALID_METADATA", "parallel task requires a stable explicit name");
    if (typeof run !== "function") fail("INVALID_METADATA", "parallel task values must be run functions");
  }
  const results = await Promise.all(tasks.map(async ([name, run]) => {
    try {
      const parent = inheritedHostAgentPath.getStore() ?? [];
      const value = await inheritedHostAgentPath.run([...parent, rawOperation, name], run as () => unknown);
      if (!jsonValue(value)) fail("RESULT_INVALID", "parallel task result must be JSON-compatible");
      return { name, value };
    } catch (error) {
      const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", errorText(error));
      if (typed.code === "CANCELLED") throw typed;
      return { name, error: typed };
    }
  }));
  const failure = results.find((result) => result.error);
  if (failure?.error) throw failure.error;
  return keyedJsonResult<Tasks>(results.flatMap((result) => "value" in result ? [[result.name, result.value] as const] : []));
}

async function hostPipeline<Items extends PipelineItems, Output extends JsonValue>(rawOperation: unknown, rawItems: unknown, rawStages: unknown): Promise<PipelineResult<Items, Output>> {
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
        const value = await inheritedHostAgentPath.run([...parent, rawOperation, name, stageName], () => (run as (value: unknown) => unknown)(current));
        if (!jsonValue(value)) fail("RESULT_INVALID", "pipeline stage result must be JSON-compatible");
        current = value;
      }
      if (!jsonValue(current)) fail("RESULT_INVALID", "pipeline result must be JSON-compatible");
      return { name, value: current };
    } catch (error) {
      const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", errorText(error));
      if (typed.code === "CANCELLED") throw typed;
      return { name, error: typed };
    }
  }));
  const failure = results.find((result) => result.error);
  if (failure?.error) throw failure.error;
  return Object.fromEntries(results.flatMap((result) => "value" in result ? [[result.name, result.value] as const] : [])) as PipelineResult<Items, Output>;
}

export function nextNamedOccurrence(counters: Map<string, number>, label: string): string {
  const count = (counters.get(label) ?? 0) + 1;
  counters.set(label, count);
  return count === 1 ? label : `${label}#${String(count)}`;
}

function functionBreadcrumb(name: string, occurrence: number): string { return occurrence === 1 ? name : `${name} #${String(occurrence)}`; }

export function withWorkflowFunctions(bridge: WorkflowBridge, store: RunStore, runContext: Readonly<WorkflowRunContext>, registry: WorkflowRegistryApi): WorkflowBridge {
  const functionAgentOccurrences = new Map<string, number>();
  const functionShellOccurrences = new Map<string, number>();
  const functionInvokeOccurrences = new Map<string, number>();
  const functionInvokeBreadcrumbOccurrences = new Map<string, number>();
  const invokeFunction = async (name: string, input: Readonly<Record<string, JsonValue>>, signal: AbortSignal, identity: FunctionIdentity, breadcrumb?: string): Promise<JsonValue> => {
    const path = identity.path;
    const structuralPath = identity.structuralPath;
    const worktreeOwner = identity.worktreeOwner;
    const replayed = await store.replay(path);
    let stored: JsonValue | undefined;
    type SideEffectOutcome = { ok: true } | { ok: false; error: unknown };
    const sideEffects: Array<Promise<SideEffectOutcome>> = [];
    const ownSideEffect = (effect: () => void | Promise<void>): void => {
      try {
        sideEffects.push(Promise.resolve(effect()).then(() => ({ ok: true as const }), (error: unknown) => ({ ok: false as const, error })));
      } catch (error) {
        sideEffects.push(Promise.resolve({ ok: false as const, error }));
      }
    };
    const parentBreadcrumb = breadcrumb ?? functionBreadcrumb(name, identity.occurrence);
    const context: WorkflowFunctionContext = {
      run: runContext,
      invoke: async (targetName, targetInput, label) => {
        if (label !== undefined && (typeof label !== "string" || !label.trim())) fail("INVALID_METADATA", "invoke label must be a non-empty string");
        const inherited = inheritedHostAgentPath.getStore() ?? structuralPath;
        const scopedWorktreeOwner = inheritedHostWorktreeOwner.getStore() ?? worktreeOwner;
        const key = JSON.stringify([path, inherited, targetName]);
        const occurrence = (functionInvokeOccurrences.get(key) ?? 0) + 1;
        functionInvokeOccurrences.set(key, occurrence);
        const breadcrumbName = label === undefined ? targetName : label;
        const breadcrumbKey = JSON.stringify([path, inherited, breadcrumbName]);
        const breadcrumbOccurrence = (functionInvokeBreadcrumbOccurrences.get(breadcrumbKey) ?? 0) + 1;
        functionInvokeBreadcrumbOccurrences.set(breadcrumbKey, breadcrumbOccurrence);
        const nestedPath = operationPath("function", "nested", path, ...inherited, targetName, `occurrence:${String(occurrence)}`);
        const nestedIdentity: FunctionIdentity = { path: nestedPath, structuralPath: [...inherited], occurrence, ...(scopedWorktreeOwner ? { worktreeOwner: scopedWorktreeOwner } : {}) };
        return invokeFunction(targetName, targetInput, signal, nestedIdentity, `${parentBreadcrumb} > ${functionBreadcrumb(breadcrumbName, breadcrumbOccurrence)}`);
      },
      agent: async (prompt: string, options?: Readonly<AgentOptions>) => {
        if (!bridge.agent || typeof prompt !== "string") fail("AGENT_FAILED", "No agent bridge is available");
        const validatedOptions = validateAgentOptions(options === undefined ? {} : options);
        const scopedWorktreeOwner = inheritedHostWorktreeOwner.getStore() ?? worktreeOwner;
        const inherited = inheritedHostAgentPath.getStore() ?? [];
        const key = `${path}\0${JSON.stringify(inherited)}`;
        const occurrence = (functionAgentOccurrences.get(key) ?? 0) + 1;
        functionAgentOccurrences.set(key, occurrence);
        return bridge.agent(prompt, validatedOptions, signal, { structuralPath: [...inherited], callSite: `function:${path}`, occurrence, parentBreadcrumb, ...(scopedWorktreeOwner ? { worktreeOwner: scopedWorktreeOwner } : {}) });
      },
      shell: async (...args: readonly unknown[]) => {
        if (!bridge.shell) fail("SHELL_FAILED", "No shell bridge is available");
        if (typeof args[0] !== "string") fail("INVALID_METADATA", "shell command must be a string");
        const options = validateShellOptions(args[1] === undefined ? {} : args[1]);
        const scopedWorktreeOwner = inheritedHostWorktreeOwner.getStore() ?? worktreeOwner;
        const inherited = inheritedHostAgentPath.getStore() ?? [];
        const key = `${path}\0${JSON.stringify([inherited, scopedWorktreeOwner ?? null])}`;
        const occurrence = (functionShellOccurrences.get(key) ?? 0) + 1;
        functionShellOccurrences.set(key, occurrence);
        return bridge.shell(args[0], options, signal, { structuralPath: [...inherited], callSite: `function:${path}`, occurrence, ...(scopedWorktreeOwner ? { worktreeOwner: scopedWorktreeOwner } : {}) });
      },
      prompt: workflowPrompt,
      parallel: <Tasks extends ParallelTasks>(operationName: string, tasks: Tasks) => hostParallel<Tasks>(operationName, tasks),
      pipeline: <Items extends PipelineItems, Output extends JsonValue>(operationName: string, items: Items, stages: PipelineStages<Items[keyof Items], Output>) => hostPipeline<Items, Output>(operationName, items, stages),
      withWorktree: <Result extends JsonValue>(name: string, callback: WorkflowWorktreeCallback<Result>) => hostWithWorktree(name, callback, bridge.worktree, signal),
      checkpoint: async (...args: readonly unknown[]) => {
        if (!bridge.checkpoint || !object(args[0]) || !jsonValue(args[0])) fail("INTERNAL_ERROR", "No checkpoint bridge is available");
        return bridge.checkpoint(args[0], signal);
      },
      phase: (name: string) => { ownSideEffect(() => bridge.phase?.(name)); },
      log: (message: string) => { ownSideEffect(() => bridge.log?.(message)); },
    };
    const result = await inheritedHostAgentPath.run([...structuralPath], async () => registry.invokeFunction(name, input, context, path, { get: () => replayed?.value, put: (_path, value) => { stored = value; } }));
    const outcomes = await Promise.all(sideEffects);
    const sideEffectError = outcomes.find((outcome) => !outcome.ok);
    if (sideEffectError) throw sideEffectError.error;
    if (!replayed) await store.complete(path, stored ?? result);
    return result;
  };
  return { ...bridge, functions: registry.globals(), function: (name, input, signal, identity) => {
    const expectedPath = operationPath("function", ...identity.structuralPath, name, String(identity.occurrence));
    if (identity.path !== expectedPath) fail("INTERNAL_ERROR", "Workflow function identity path is inconsistent");
    return invokeFunction(name, input, signal, identity);
  }};
}
