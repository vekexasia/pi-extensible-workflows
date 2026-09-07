import { BUDGET_DIMENSIONS, WorkflowError, type BudgetDimension, type BudgetEvent, type BudgetLimits, type WorkflowBudget, type WorkflowBudgetPatch, type WorkflowBudgetUsage, type AgentAccounting, type RunState } from "./types.js";
import { fail, object } from "./utils.js";
const BUDGET_LIMITS = ["soft", "hard"] as const;
type BudgetLimit = (typeof BUDGET_LIMITS)[number];
type BudgetPatchLimits = { soft?: number | null; hard?: number | null };

function isBudgetDimension(value: string): value is BudgetDimension { return BUDGET_DIMENSIONS.some((dimension) => dimension === value); }
function isBudgetLimit(value: string): value is BudgetLimit { return BUDGET_LIMITS.some((limit) => limit === value); }
function dimensionEntries(value: Record<string, unknown>): Array<[BudgetDimension, unknown]> {
  const entries: Array<[BudgetDimension, unknown]> = [];
  for (const [dimension, raw] of Object.entries(value)) {
    if (!isBudgetDimension(dimension)) fail("INVALID_METADATA", `Unknown budget dimension: ${dimension}`);
    entries.push([dimension, raw]);
  }
  return entries;
}
function limitEntries(value: Record<string, unknown>, message: string, ownOnly = false): Array<[BudgetLimit, unknown]> {
  if (Object.keys(value).some((key) => !isBudgetLimit(key))) fail("INVALID_METADATA", message);
  const entries: Array<[BudgetLimit, unknown]> = [];
  for (const key of BUDGET_LIMITS) {
    if (!ownOnly || Object.prototype.hasOwnProperty.call(value, key)) entries.push([key, value[key]]);
  }
  return entries;
}
function budgetEntries(value: WorkflowBudget): Array<[BudgetDimension, BudgetLimits]> {
  const entries: Array<[BudgetDimension, BudgetLimits]> = [];
  for (const [dimension, limits] of Object.entries(value)) {
    if (!isBudgetDimension(dimension)) continue;
    entries.push([dimension, limits]);
  }
  return entries;
}
function nonNegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isInteger(value) && value >= 0; }
function nonNegativeFinite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
function validatedLimit(value: unknown, dimension: BudgetDimension, key: BudgetLimit): number {
  const kind = dimension === "costUsd" ? "finite number" : "integer";
  if (dimension === "costUsd") {
    if (!nonNegativeFinite(value)) fail("INVALID_METADATA", `${dimension}.${key} must be a non-negative ${kind}`);
    return value;
  }
  if (!nonNegativeInteger(value)) fail("INVALID_METADATA", `${dimension}.${key} must be a non-negative ${kind}`);
  return value;
}
export function validateBudget(value: unknown): WorkflowBudget | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) fail("INVALID_METADATA", "budget must be an object");
  const result: WorkflowBudget = {};
  for (const [dimension, raw] of dimensionEntries(value)) {
    if (!object(raw)) fail("INVALID_METADATA", `${dimension} budget must be an object`);
    const limits: BudgetLimits = {};
    for (const [key, rawLimit] of limitEntries(raw, `${dimension} budget has an unknown limit`)) {
      if (rawLimit !== undefined) limits[key] = validatedLimit(rawLimit, dimension, key);
    }
    if (limits.soft !== undefined && limits.hard !== undefined && limits.soft >= limits.hard) fail("INVALID_METADATA", `${dimension}.soft must be less than hard`);
    if (Object.keys(limits).length) result[dimension] = limits;
  }
  return Object.freeze(result);
}
export function validateBudgetPatch(value: unknown): WorkflowBudgetPatch {
  if (!object(value)) fail("INVALID_METADATA", "budget patch must be an object");
  const result: WorkflowBudgetPatch = {};
  for (const [dimension, raw] of dimensionEntries(value)) {
    if (raw === null) { result[dimension] = null; continue; }
    if (!object(raw)) fail("INVALID_METADATA", `${dimension} budget patch must contain only soft and hard`);
    const limits: BudgetPatchLimits = {};
    for (const [key, rawLimit] of limitEntries(raw, `${dimension} budget patch must contain only soft and hard`, true)) {
      if (rawLimit === null) limits[key] = null;
      else if (rawLimit !== undefined) limits[key] = validatedLimit(rawLimit, dimension, key);
    }
    if (limits.soft !== null && limits.hard !== null && limits.soft !== undefined && limits.hard !== undefined && limits.soft >= limits.hard) fail("INVALID_METADATA", `${dimension}.soft must be less than hard`);
    result[dimension] = limits;
  }
  return result;
}
export function budgetUsage(value?: Partial<WorkflowBudgetUsage>): WorkflowBudgetUsage { return { tokens: value?.tokens ?? 0, costUsd: value?.costUsd ?? 0, durationMs: value?.durationMs ?? 0, agentLaunches: value?.agentLaunches ?? 0 }; }
export class WorkflowBudgetRuntime {
  readonly #now: () => number;
  readonly #onChange: (() => void) | undefined;
  readonly #injected = new Set<string>();
  readonly #seen = new Set<string>();
  #active: boolean;
  #activeSince: number | undefined;
  #usage: WorkflowBudgetUsage;
  #events: BudgetEvent[];
  #turnAccounting?: { input: number; output: number; cost: number };
  constructor(readonly budget: WorkflowBudget | undefined, readonly version = 1, usage?: Partial<WorkflowBudgetUsage>, events: readonly BudgetEvent[] = [], options: { now?: () => number; onChange?: () => void; active?: boolean } = {}) { this.#now = options.now ?? (() => Date.now()); this.#onChange = options.onChange; this.#active = options.active ?? true; this.#activeSince = this.#active ? this.#now() : undefined; this.#usage = budgetUsage(usage); this.#events = [...events]; for (const event of events) if (event.budgetVersion === version) this.#seen.add(event.type); }
  get usage(): WorkflowBudgetUsage { this.#syncDuration(); return { ...this.#usage }; }
  get events(): readonly BudgetEvent[] { return this.#events; }
  get hardExhausted(): boolean { return this.#events.some((event) => event.type === "hard_exhausted" && event.budgetVersion === this.version); }
  checkAgentLaunch(): void { this.#checkHard(["agentLaunches"]); }
  beforeAttempt(): void { this.#checkHard(["agentLaunches"]); this.#usage.agentLaunches += 1; this.#evaluate(); }
  beforeTurn(): void { this.#syncDuration(); this.#evaluate(); this.#checkHard(["tokens", "costUsd", "durationMs"]); }
  afterTurn(accounting: AgentAccounting, final: boolean): void { this.#syncDuration(); this.#applyTurn(accounting, final, this.#turnAccounting); this.#turnAccounting = { input: accounting.input, output: accounting.output, cost: accounting.cost }; }
  #applyTurn(accounting: AgentAccounting, final: boolean, previous = { input: 0, output: 0, cost: 0 }): void { this.#usage.tokens += Math.max(0, accounting.input - previous.input) + Math.max(0, accounting.output - previous.output); this.#usage.costUsd += Math.max(0, accounting.cost - previous.cost); this.#evaluate(); if (!final) this.#checkHard(["tokens", "costUsd", "durationMs"]); }
  instruction(agentId = "agent"): string | undefined { if (!this.#hasSoftCrossed() || this.#injected.has(agentId)) return undefined; this.#injected.add(agentId); return `The workflow budget soft limit has been reached. Finish the requested output now, preserving any required output schema. Current usage: ${JSON.stringify(this.usage)}. Do not start additional model work unless it is required to produce the final requested result.`; }
  forAgent(agentId: string) { let attempt = 0; let previous: { input: number; output: number; cost: number } | undefined; return { beforeAttempt: () => { attempt += 1; previous = undefined; this.beforeAttempt(); }, beforeTurn: () => { this.beforeTurn(); }, afterTurn: (accounting: AgentAccounting, final: boolean) => { this.#applyTurn(accounting, final, previous); previous = { input: accounting.input, output: accounting.output, cost: accounting.cost }; }, instruction: () => this.instruction(`${agentId}:${String(attempt + 1)}`) }; }
  transition(state: RunState): void { const active = state === "running"; if (active === this.#active) return; if (active) { this.#active = true; this.#activeSince = this.#now(); } else { this.#syncDuration(); this.#evaluate(); this.#active = false; this.#activeSince = undefined; } this.#onChange?.(); }
  #syncDuration(): void { if (this.#active && this.#activeSince !== undefined) { const now = this.#now(); this.#usage.durationMs += Math.max(0, now - this.#activeSince); this.#activeSince = now; } }
  #hasSoftCrossed(): boolean { return !!this.budget && budgetEntries(this.budget).some(([dimension, limits]) => limits.soft !== undefined && this.#usage[dimension] >= limits.soft); }
  #checkHard(dimensions: readonly BudgetDimension[]): void { const exhausted = dimensions.filter((dimension) => { const hard = this.budget?.[dimension]?.hard; return hard !== undefined && this.#usage[dimension] >= hard; }); if (!exhausted.length) return; this.#record("hard_exhausted", exhausted); const detail = exhausted.map((dimension) => `${dimension} usage=${String(this.#usage[dimension])} hard=${String(this.budget?.[dimension]?.hard)}`).join(", "); throw new WorkflowError("BUDGET_EXHAUSTED", `Budget version ${String(this.version)} exhausted: ${detail}`); }
  #evaluate(): void { const budget = this.budget; if (!budget) return; const entries = budgetEntries(budget); const soft = entries.filter(([dimension, limits]) => limits.soft !== undefined && this.#usage[dimension] >= limits.soft).map(([dimension]) => dimension); if (soft.length) this.#record("soft_crossed", soft); const overrun = entries.filter(([dimension, limits]) => limits.hard !== undefined && this.#usage[dimension] > limits.hard).map(([dimension]) => dimension); if (overrun.length) this.#record("hard_overrun", overrun); }
  #record(type: BudgetEvent["type"], dimensions: readonly BudgetDimension[]): void { if (this.#seen.has(type)) return; this.#seen.add(type); this.#events.push({ type, budgetVersion: this.version, dimensions: [...dimensions], usage: this.usage, limits: structuredClone(this.budget ?? {}), at: this.#now() }); this.#onChange?.(); }
  recordEvent(event: BudgetEvent): void { this.#events.push(structuredClone(event)); }
  snapshot(): { usage: WorkflowBudgetUsage; budgetEvents: readonly BudgetEvent[] } { return { usage: this.usage, budgetEvents: [...this.#events] }; }
}
export function mergeBudget(budget: WorkflowBudget | undefined, patch: WorkflowBudgetPatch): WorkflowBudget | undefined { const merged: WorkflowBudget = structuredClone(budget ?? {}); for (const dimension of BUDGET_DIMENSIONS) if (Object.prototype.hasOwnProperty.call(patch, dimension)) { const value = patch[dimension]; if (value === null) { Reflect.deleteProperty(merged, dimension); continue; } const next: BudgetLimits = { ...(merged[dimension] ?? {}) }; for (const key of BUDGET_LIMITS) if (value && Object.prototype.hasOwnProperty.call(value, key)) { const limit = value[key]; if (limit === null) Reflect.deleteProperty(next, key); else if (limit !== undefined) next[key] = limit; } if (Object.keys(next).length) merged[dimension] = next; else Reflect.deleteProperty(merged, dimension); } return validateBudget(merged); }
export function budgetRelaxed(previous: WorkflowBudget | undefined, next: WorkflowBudget | undefined): boolean { for (const dimension of BUDGET_DIMENSIONS) { const oldLimit = previous?.[dimension]; const newLimit = next?.[dimension]; for (const key of BUDGET_LIMITS) if ((oldLimit?.[key] !== undefined && newLimit?.[key] === undefined) || (oldLimit?.[key] !== undefined && newLimit?.[key] !== undefined && newLimit[key] > oldLimit[key])) return true; } return false; }
export function exhaustedBudgetDimensions(budget: WorkflowBudget | undefined, usage: WorkflowBudgetUsage): BudgetDimension[] { if (!budget) return []; return budgetEntries(budget).filter(([dimension, limits]) => limits.hard !== undefined && usage[dimension] >= limits.hard).map(([dimension]) => dimension); }
export function resumeBudgetAllowed(budget: WorkflowBudget | undefined, usage: WorkflowBudgetUsage): boolean { return exhaustedBudgetDimensions(budget, usage).length === 0; }