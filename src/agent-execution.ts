import { Type } from "@earendil-works/pi-ai";
import { Value } from "typebox/value";
import { AuthStorage, createAgentSession, ModelRegistry, SessionManager, type ToolDefinition } from "@earendil-works/pi-coding-agent";
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
type AgentMessage = { role: string; content?: unknown; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } } };
import type { JsonSchema, JsonValue, ModelSpec } from "./index.js";
import { WorkflowError } from "./index.js";

export interface AgentDefinition { prompt?: string; model?: string; thinking?: ThinkingLevel; tools?: readonly string[] }
export interface AgentExecutionOptions {
  label: string;
  workflowName: string;
  workflowDescription: string;
  phase?: string;
  parent?: string;
  model?: string;
  thinking?: ThinkingLevel;
  tools?: readonly string[];
  agentType?: string;
  schema?: JsonSchema;
  retries?: number;
  timeoutMs?: number | null;
  retryState?: string;
}
export interface AgentExecutionRoot {
  cwd: string;
  model: ModelSpec;
  tools: ReadonlySet<string>;
  agentDefinitions?: Readonly<Record<string, AgentDefinition>>;
}
export interface AgentAccounting { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export interface AgentAttempt { attempt: number; sessionId: string; sessionFile: string; result?: JsonValue; error?: { code: string; message: string }; accounting: AgentAccounting }
export interface AgentExecutionResult { value: JsonValue; attempts: readonly AgentAttempt[] }

interface NativeSession {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly messages: readonly AgentMessage[];
  prompt(text: string): Promise<void>;
  abort?(): Promise<void>;
  dispose(): void;
}
interface SessionInput { cwd: string; model: ModelSpec; tools: readonly string[]; sessionLabel: string; customTools?: readonly ToolDefinition[]; resultTool?: ToolDefinition }
type SessionFactory = (input: SessionInput) => Promise<NativeSession>;

function parseModel(value: string | undefined, fallback: ModelSpec, thinking?: ThinkingLevel): ModelSpec {
  if (!value) return { ...fallback, ...(thinking ? { thinking } : {}) };
  const slash = value.indexOf("/");
  if (slash < 1 || slash === value.length - 1) throw new WorkflowError("UNKNOWN_MODEL", `Invalid model spec: ${value}`);
  const colon = value.lastIndexOf(":");
  const hasThinking = colon > slash;
  const level = thinking ?? (hasThinking ? value.slice(colon + 1) : undefined);
  if (level && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) throw new WorkflowError("UNKNOWN_MODEL", `Invalid thinking level: ${level}`);
  return { provider: value.slice(0, slash), model: value.slice(slash + 1, hasThinking ? colon : undefined), ...(level ? { thinking: level as ThinkingLevel } : {}) };
}

function text(messages: readonly AgentMessage[]): string {
  const message = [...messages].reverse().find((item) => item.role === "assistant");
  if (!message || !Array.isArray(message.content)) return "";
  return message.content.filter((part: unknown): part is { type: "text"; text: string } => typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string").map((part) => part.text).join("");
}

function accounting(messages: readonly AgentMessage[]): AgentAccounting {
  const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  for (const message of messages) if (message.role === "assistant" && message.usage) {
    total.input += message.usage.input;
    total.output += message.usage.output;
    total.cacheRead += message.usage.cacheRead;
    total.cacheWrite += message.usage.cacheWrite;
    total.cost += message.usage.cost.total;
  }
  return total;
}

async function nativeSession(input: SessionInput): Promise<NativeSession> {
  const manager = SessionManager.create(input.cwd);
  manager.appendSessionInfo(input.sessionLabel);
  const registry = ModelRegistry.create(AuthStorage.create());
  const model = registry.find(input.model.provider, input.model.model);
  if (!model) throw new WorkflowError("UNKNOWN_MODEL", `Unknown model: ${input.model.provider}/${input.model.model}`);
  const customTools = [...(input.customTools ?? []), ...(input.resultTool ? [input.resultTool] : [])];
  const tools = [...new Set([...input.tools, ...customTools.map(({ name }) => name)])];
  const { session } = await createAgentSession({ cwd: input.cwd, model, ...(input.model.thinking ? { thinkingLevel: input.model.thinking } : {}), tools, ...(customTools.length ? { customTools } : {}), sessionManager: manager });
  return session;
}

export class WorkflowAgentExecutor {
  constructor(private readonly root: AgentExecutionRoot, private readonly createSession: SessionFactory = nativeSession) {}

  resolve(options: AgentExecutionOptions): { model: ModelSpec; tools: readonly string[]; rolePrompt: string } {
    const definition = options.agentType ? this.root.agentDefinitions?.[options.agentType] : undefined;
    if (options.agentType && !definition) throw new WorkflowError("UNKNOWN_AGENT_TYPE", `Unknown agent type: ${options.agentType}`);
    const requested = options.tools ?? definition?.tools ?? [...this.root.tools];
    const forbidden = requested.find((tool) => !this.root.tools.has(tool));
    if (forbidden) throw new WorkflowError("UNKNOWN_TOOL", `Tool is outside the launching session boundary: ${forbidden}`);
    return { model: parseModel(options.model ?? definition?.model, this.root.model, options.thinking ?? definition?.thinking), tools: [...requested], rolePrompt: definition?.prompt ?? "" };
  }

  async execute(task: string, options: AgentExecutionOptions, signal?: AbortSignal, customTools: readonly ToolDefinition[] = []): Promise<AgentExecutionResult> {
    if (!Number.isInteger(options.retries ?? 0) || (options.retries ?? 0) < 0) throw new WorkflowError("INVALID_METADATA", "retries must be a non-negative integer");
    if (options.timeoutMs !== undefined && options.timeoutMs !== null && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)) throw new WorkflowError("INVALID_METADATA", "timeoutMs must be null or a positive integer");
    const resolved = this.resolve(options);
    const attempts: AgentAttempt[] = [];
    const maxAttempts = (options.retries ?? 0) + 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const started = Date.now();
      let accepted = false;
      let schemaResult: JsonValue | undefined;
      const hasSchemaResult = () => schemaResult !== undefined;
      const resultTool = options.schema ? {
        name: "workflow_result", label: "Workflow Result", description: "Submit the terminal structured workflow result", parameters: Type.Unsafe(options.schema),
        async execute(_id: string, value: unknown) {
          if (!accepted) return { content: [{ type: "text" as const, text: "Result acceptance is not enabled yet." }], details: {}, isError: true };
          if (!Value.Check(options.schema as object, value)) return { content: [{ type: "text" as const, text: "Result does not match the required schema." }], details: {}, isError: true };
          schemaResult = structuredClone(value) as JsonValue;
          void session?.abort?.();
          return { content: [{ type: "text" as const, text: "Result accepted." }], details: {} };
        },
      } as ToolDefinition : undefined;
      let session: NativeSession | undefined;
      try {
        session = await this.createSession({ cwd: this.root.cwd, model: resolved.model, tools: resolved.tools, sessionLabel: `${options.workflowName}:${options.label}:attempt-${String(attempt)}`, ...(customTools.length ? { customTools } : {}), ...(resultTool ? { resultTool } : {}) });
        const context = [`Workflow: ${options.workflowName} - ${options.workflowDescription}`, `Agent: ${options.label}`, options.phase ? `Phase: ${options.phase}` : "", options.parent ? `Parent: ${options.parent}` : "", "You own this task and any direct child agents you create. Return child results to your parent; do not leave descendants running.", resolved.rolePrompt, attempt > 1 ? `Retry attempt ${String(attempt)}. Previous state: ${options.retryState ?? attempts.at(-1)?.error?.message ?? "failed attempt"}` : ""].filter(Boolean).join("\n");
        await withTimeout(session.prompt(`${context}\n\nTask:\n${task}`), remaining(options.timeoutMs, started), signal, session);
        if (options.schema) {
          accepted = true;
          try { await withTimeout(session.prompt("Submit the final result now by calling workflow_result exactly once. Do not return prose."), remaining(options.timeoutMs, started), signal, session); }
          catch (error) { if (!hasSchemaResult()) throw error; }
          if (!hasSchemaResult()) {
            try { await withTimeout(session.prompt("Your result was missing or invalid. Repair it by calling workflow_result exactly once with a schema-valid value."), remaining(options.timeoutMs, started), signal, session); }
            catch (error) { if (!hasSchemaResult()) throw error; }
          }
          if (schemaResult === undefined) throw new WorkflowError("RESULT_INVALID", "Agent did not submit a valid workflow_result after one repair");
        }
        const value = options.schema ? schemaResult as JsonValue : text(session.messages);
        attempts.push({ attempt, sessionId: session.sessionId, sessionFile: requiredFile(session.sessionFile), result: value, accounting: accounting(session.messages) });
        session.dispose();
        return { value, attempts };
      } catch (error) {
        const typed = error instanceof WorkflowError ? error : new WorkflowError("AGENT_FAILED", error instanceof Error ? error.message : String(error));
        if (session) {
          attempts.push({ attempt, sessionId: session.sessionId, sessionFile: requiredFile(session.sessionFile), error: { code: typed.code, message: typed.message }, accounting: accounting(session.messages) });
          session.dispose();
        }
        if (attempt === maxAttempts || typed.code === "CANCELLED") throw Object.assign(typed, { attempts });
      }
    }
    throw new WorkflowError("AGENT_FAILED", "Agent execution failed");
  }
}

export interface ScheduledAgentOptions {
  label: string;
  cwd: string;
  tools: readonly string[];
  model?: string;
  schema?: JsonSchema;
}

export type ScheduledAgentResult =
  | { id: string; ok: true; value: JsonValue }
  | { id: string; ok: false; error: { code: string; message: string } };

export interface ScheduledAgentInput {
  id: string;
  runId: string;
  parentId?: string;
  prompt: string;
  options: Readonly<ScheduledAgentOptions>;
  signal: AbortSignal;
  setSteer(handler: (message: string) => void | Promise<void>): void;
}

export type ScheduledAgentRunner = (input: ScheduledAgentInput) => Promise<JsonValue>;

type ScheduledNode = {
  id: string;
  runId: string;
  parentId?: string;
  options: Readonly<ScheduledAgentOptions>;
  children: Set<string>;
  collected: boolean;
  state: "queued" | "running" | "waiting_for_child" | "completed" | "failed" | "cancelled";
  controller: AbortController;
  promise: Promise<ScheduledAgentResult>;
  resolve: (result: ScheduledAgentResult) => void;
  task: () => Promise<void>;
  steer?: (message: string) => void | Promise<void>;
};

type ScheduledRun = { limit: number; maxAgents: number; logical: number; active: number; queue: Array<() => void> };
type OwnershipRecord = { id: string; parentId?: string; label: string; state: ScheduledNode["state"] };
type OwnershipWriter = (runId: string, ownership: readonly OwnershipRecord[]) => void | Promise<void>;

export class FairAgentScheduler {
  readonly #runs = new Map<string, ScheduledRun>();
  readonly #nodes = new Map<string, ScheduledNode>();
  #runOrder: string[] = [];
  #cursor = 0;
  #active = 0;
  #nextId = 0;
  #persistence = Promise.resolve();

  constructor(private readonly runner: ScheduledAgentRunner, readonly sessionLimit = 16, private readonly writeOwnership?: OwnershipWriter) {
    if (!Number.isInteger(sessionLimit) || sessionLimit < 1 || sessionLimit > 16) throw new WorkflowError("INVALID_SETTINGS", "Session concurrency must be an integer from 1 to 16");
  }

  addRun(runId: string, limit = 8, maxAgents = 1000): void {
    if (this.#runs.has(runId)) throw new WorkflowError("DUPLICATE_NAME", `Scheduler run already exists: ${runId}`);
    if (!Number.isInteger(limit) || limit < 1 || limit > this.sessionLimit || !Number.isInteger(maxAgents) || maxAgents < 1) throw new WorkflowError("INVALID_SETTINGS", "Invalid run concurrency or maxAgents");
    this.#runs.set(runId, { limit, maxAgents, logical: 0, active: 0, queue: [] });
    this.#runOrder.push(runId);
  }

  spawn(runId: string, prompt: string, options: ScheduledAgentOptions, parentId?: string): { id: string; result: Promise<ScheduledAgentResult> } {
    const run = this.#runs.get(runId);
    if (!run) throw new WorkflowError("INTERNAL_ERROR", `Unknown scheduler run: ${runId}`);
    const parent = parentId ? this.#nodes.get(parentId) : undefined;
    if (parentId && (!parent || parent.runId !== runId)) throw new WorkflowError("UNKNOWN_AGENT_TYPE", "Parent agent is not owned by this run");
    const effective = this.#inherit(parent, options);
    if (++run.logical > run.maxAgents) { run.logical -= 1; throw new WorkflowError("RUN_LIMIT_EXCEEDED", `Run ${runId} exceeded maxAgents`); }
    const id = `${runId}:${String(++this.#nextId)}`;
    let resolveResult: (result: ScheduledAgentResult) => void = () => undefined;
    const promise = new Promise<ScheduledAgentResult>((resolve) => { resolveResult = resolve; });
    const node: ScheduledNode = { id, runId, ...(parentId ? { parentId } : {}), options: effective, children: new Set<string>(), collected: false, state: "queued", controller: new AbortController(), promise, resolve: resolveResult, task: async () => undefined };
    node.task = async () => {
      if (node.controller.signal.aborted) { this.#release(node.runId); return; }
      node.state = "running";
      this.#persist(runId);
      try {
        const value = await this.runner({ id, runId, ...(parentId ? { parentId } : {}), prompt, options: effective, signal: node.controller.signal, setSteer: (handler) => { node.steer = handler; } });
        this.#settle(node, { id, ok: true, value });
      } catch (error) {
        const typed = error instanceof WorkflowError ? error : new WorkflowError("AGENT_FAILED", error instanceof Error ? error.message : String(error));
        this.#settle(node, { id, ok: false, error: { code: typed.code, message: typed.message } });
      }
    };
    this.#nodes.set(id, node);
    parent?.children.add(id);
    this.#persist(runId);
    this.#enqueue(runId, () => { void node.task(); });
    return { id, result: promise };
  }

  async result(parentId: string, childId: string): Promise<ScheduledAgentResult> {
    const parent = this.#node(parentId);
    const child = this.#node(childId);
    if (child.parentId !== parentId) throw new WorkflowError("UNKNOWN_AGENT_TYPE", "Results are scoped to direct children");
    child.collected = true;
    parent.state = "waiting_for_child";
    this.#persist(parent.runId);
    this.#release(parent.runId);
    const outcome = await child.promise;
    await new Promise<void>((resolve) => { this.#enqueue(parent.runId, () => { resolve(); }); });
    parent.state = "running";
    if (parent.controller.signal.aborted) throw new WorkflowError("CANCELLED", "Parent agent cancelled");
    this.#persist(parent.runId);
    return outcome;
  }

  async steer(parentId: string, childId: string, message: string): Promise<void> {
    const child = this.#node(childId);
    if (child.parentId !== parentId) throw new WorkflowError("UNKNOWN_AGENT_TYPE", "Steering is scoped to direct children");
    if (child.state !== "running" && child.state !== "waiting_for_child") throw new WorkflowError("AGENT_FAILED", "Child is not running");
    await child.steer?.(message);
  }

  cancel(id: string): void { this.#cancelTree(this.#node(id)); }

  /* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/restrict-template-expressions */
  toolsFor(parentId: string): ToolDefinition[] {
    const parent = this.#node(parentId);
    if (!parent.options.tools.includes("agent")) return [];
    const agentTool = {
      name: "agent", label: "Child Agent", description: "Start a direct child agent",
      parameters: Type.Object({ prompt: Type.String(), label: Type.String(), tools: Type.Optional(Type.Array(Type.String())), model: Type.Optional(Type.String()), schema: Type.Optional(Type.Unsafe<JsonSchema>({})) }),
      execute: async (_id: string, params: { prompt: string; label: string; tools?: string[]; model?: string; schema?: JsonSchema }) => {
        const options = { label: params.label, cwd: parent.options.cwd, tools: params.tools ?? parent.options.tools, ...(params.model ? { model: params.model } : {}), ...(params.schema ? { schema: params.schema } : {}) };
        const child = this.spawn(parent.runId, params.prompt, options, parentId);
        return { content: [{ type: "text" as const, text: JSON.stringify({ id: child.id }) }], details: { id: child.id } };
      },
    } as ToolDefinition;
    const resultTool = {
      name: "get_subagent_result", label: "Child Result", description: "Wait for a direct child and return its result",
      parameters: Type.Object({ id: Type.String() }),
      execute: async (_id: string, params: { id: string }) => { const value = await this.result(parentId, params.id); return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: value }; },
    } as ToolDefinition;
    const steerTool = {
      name: "steer_subagent", label: "Steer Child", description: "Steer a running direct child",
      parameters: Type.Object({ id: Type.String(), message: Type.String() }),
      execute: async (_id: string, params: { id: string; message: string }) => { await this.steer(parentId, params.id, params.message); return { content: [{ type: "text" as const, text: "Steering delivered." }], details: {} }; },
    } as ToolDefinition;
    return [agentTool, resultTool, steerTool];
  }

  snapshot(): readonly OwnershipRecord[] {
    return [...this.#nodes.values()].map(({ id, parentId, options, state }) => ({ id, ...(parentId ? { parentId } : {}), label: options.label, state }));
  }

  async flush(): Promise<void> { await this.#persistence; }

  #inherit(parent: ScheduledNode | undefined, options: ScheduledAgentOptions): Readonly<ScheduledAgentOptions> {
    const unknown = Object.keys(options).find((key) => !["label", "cwd", "tools", "model", "schema"].includes(key));
    if (unknown) throw new WorkflowError("INVALID_METADATA", `Unsupported child agent option: ${unknown}`);
    if (!options.label.trim() || !options.cwd || !Array.isArray(options.tools)) throw new WorkflowError("INVALID_METADATA", "Agents require label, cwd, and tools");
    if (!parent) return Object.freeze({ ...options, tools: Object.freeze([...options.tools]) });
    if (options.cwd !== parent.options.cwd) throw new WorkflowError("UNKNOWN_TOOL", "Child cwd cannot differ from its parent");
    const forbidden = options.tools.find((tool) => !parent.options.tools.includes(tool));
    if (forbidden) throw new WorkflowError("UNKNOWN_TOOL", `Child tool escalates parent boundary: ${forbidden}`);
    return Object.freeze({ ...options, cwd: parent.options.cwd, tools: Object.freeze([...options.tools]) });
  }
  /* eslint-enable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-argument, @typescript-eslint/restrict-template-expressions */

  #enqueue(runId: string, start: () => void): void { this.#runs.get(runId)?.queue.push(start); this.#dispatch(); }

  #dispatch(): void {
    while (this.#active < this.sessionLimit && this.#runOrder.length) {
      let selected: string | undefined;
      for (let checked = 0; checked < this.#runOrder.length; checked += 1) {
        const index = (this.#cursor + checked) % this.#runOrder.length;
        const id = this.#runOrder[index];
        const run = id ? this.#runs.get(id) : undefined;
        if (id && run && run.active < run.limit && run.queue.length) { selected = id; this.#cursor = (index + 1) % this.#runOrder.length; break; }
      }
      if (!selected) return;
      const run = this.#runs.get(selected) as ScheduledRun;
      const start = run.queue.shift() as () => void;
      run.active += 1; this.#active += 1; start();
    }
  }

  #release(runId: string): void {
    const run = this.#runs.get(runId);
    if (run && run.active > 0) { run.active -= 1; this.#active -= 1; this.#dispatch(); }
  }

  #settle(node: ScheduledNode, result: ScheduledAgentResult): void {
    if (["completed", "failed", "cancelled"].includes(node.state)) return;
    const heldPermit = node.state === "running";
    node.state = result.ok ? "completed" : result.error.code === "CANCELLED" ? "cancelled" : "failed";
    this.#persist(node.runId);
    if (heldPermit) this.#release(node.runId);
    for (const childId of node.children) { const child = this.#nodes.get(childId); if (child && !child.collected) this.#cancelTree(child); }
    node.resolve(result);
  }

  #cancelTree(node: ScheduledNode): void {
    if (["completed", "failed", "cancelled"].includes(node.state)) return;
    node.controller.abort();
    for (const childId of node.children) { const child = this.#nodes.get(childId); if (child) this.#cancelTree(child); }
    if (node.state === "queued") this.#settle(node, { id: node.id, ok: false, error: { code: "CANCELLED", message: "Agent cancelled" } });
  }

  #node(id: string): ScheduledNode {
    const node = this.#nodes.get(id);
    if (!node) throw new WorkflowError("UNKNOWN_AGENT_TYPE", `Unknown owned agent: ${id}`);
    return node;
  }

  #persist(runId: string): void {
    if (!this.writeOwnership) return;
    const ownership = this.snapshot().filter(({ id }) => id.startsWith(`${runId}:`));
    this.#persistence = this.#persistence.then(() => this.writeOwnership?.(runId, ownership)).then(() => undefined);
  }
}

function requiredFile(file: string | undefined): string {
  if (!file) throw new WorkflowError("INTERNAL_ERROR", "Workflow agents require persisted native Pi sessions");
  return file;
}

function remaining(timeoutMs: number | null | undefined, started: number): number | null | undefined {
  return timeoutMs === null || timeoutMs === undefined ? timeoutMs : Math.max(1, timeoutMs - (Date.now() - started));
}

async function withTimeout(work: Promise<void>, timeoutMs: number | null | undefined, signal: AbortSignal | undefined, session: NativeSession): Promise<void> {
  if (signal?.aborted) throw new WorkflowError("CANCELLED", "Agent cancelled");
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  const state = { interrupted: false };
  const timeout = timeoutMs ? new Promise<never>((_, reject) => { timer = setTimeout(() => { state.interrupted = true; reject(new WorkflowError("AGENT_TIMEOUT", "Agent attempt timed out")); }, timeoutMs); }) : new Promise<never>(() => {});
  const cancelled = signal ? new Promise<never>((_, reject) => { abort = () => { state.interrupted = true; reject(new WorkflowError("CANCELLED", "Agent cancelled")); }; signal.addEventListener("abort", abort, { once: true }); }) : new Promise<never>(() => {});
  try { await Promise.race([work, timeout, cancelled]); }
  finally { if (timer) clearTimeout(timer); if (abort) signal?.removeEventListener("abort", abort); if (state.interrupted) await session.abort?.(); }
}
