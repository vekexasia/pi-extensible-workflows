import { WorkflowError, type BudgetDimension, type BudgetEvent, type BudgetLimits, type WorkflowBudget, type WorkflowBudgetPatch, type WorkflowBudgetUsage, type AgentAccounting, type RunState } from "./types.js";
import { fail, object } from "./utils.js";

function nonNegativeInteger(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 0; }
function nonNegativeFinite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value) && value >= 0; }
export function validateBudget(value: unknown): WorkflowBudget | undefined {
  if (value === undefined) return undefined;
  if (!object(value)) fail("INVALID_METADATA", "budget must be an object");
  const result: WorkflowBudget = {};
  for (const [dimension, raw] of Object.entries(value)) {
    if (!["tokens", "costUsd", "durationMs", "agentLaunches"].includes(dimension)) fail("INVALID_METADATA", `Unknown budget dimension: ${dimension}`);
    if (!object(raw)) fail("INVALID_METADATA", `${dimension} budget must be an object`);
    if (Object.keys(raw).some((key) => key !== "soft" && key !== "hard")) fail("INVALID_METADATA", `${dimension} budget has an unknown limit`);
    const isCost = dimension === "costUsd";
    for (const key of ["soft", "hard"] as const) if (raw[key] !== undefined && !(isCost ? nonNegativeFinite(raw[key]) : nonNegativeInteger(raw[key]))) fail("INVALID_METADATA", `${dimension}.${key} must be a non-negative ${isCost ? "finite number" : "integer"}`);
    if (raw.soft !== undefined && raw.soft !== null && raw.hard !== undefined && raw.hard !== null && raw.soft >= raw.hard) fail("INVALID_METADATA", `${dimension}.soft must be less than hard`);
    const limits: BudgetLimits = {};
    if (raw.soft !== undefined) limits.soft = raw.soft as number;
    if (raw.hard !== undefined) limits.hard = raw.hard as number;
    if (Object.keys(limits).length) (result as Record<string, BudgetLimits>)[dimension] = limits;
  }
  return Object.freeze(result);
}
export function validateBudgetPatch(value: unknown): WorkflowBudgetPatch {
  if (!object(value)) fail("INVALID_METADATA", "budget patch must be an object");
  const result: WorkflowBudgetPatch = {};
  for (const [dimension, raw] of Object.entries(value)) {
    if (!["tokens", "costUsd", "durationMs", "agentLaunches"].includes(dimension)) fail("INVALID_METADATA", `Unknown budget dimension: ${dimension}`);
    if (raw === null) { (result as Record<string, null>)[dimension] = null; continue; }
    if (!object(raw) || Object.keys(raw).some((key) => key !== "soft" && key !== "hard")) fail("INVALID_METADATA", `${dimension} budget patch must contain only soft and hard`);
    const limits: { soft?: number | null; hard?: number | null } = {};
    for (const key of ["soft", "hard"] as const) if (Object.prototype.hasOwnProperty.call(raw, key)) {
      if (raw[key] === null) limits[key] = null;
      else { const checked = validateBudget({ [dimension]: { [key]: raw[key] } })?.[dimension as BudgetDimension]; if (checked?.[key] !== undefined) limits[key] = checked[key]; }
    }
    if (limits.soft !== null && limits.hard !== null && limits.soft !== undefined && limits.hard !== undefined && limits.soft >= limits.hard) fail("INVALID_METADATA", `${dimension}.soft must be less than hard`);
    (result as Record<string, { soft?: number | null; hard?: number | null }>)[dimension] = limits;
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
  #hasSoftCrossed(): boolean { return !!this.budget && (Object.entries(this.budget) as [BudgetDimension, BudgetLimits][]).some(([dimension, limits]) => limits.soft !== undefined && this.#usage[dimension] >= limits.soft); }
  #checkHard(dimensions: readonly BudgetDimension[]): void { const exhausted = dimensions.filter((dimension) => { const hard = this.budget?.[dimension]?.hard; return hard !== undefined && this.#usage[dimension] >= hard; }); if (!exhausted.length) return; this.#record("hard_exhausted", exhausted); const detail = exhausted.map((dimension) => `${dimension} usage=${String(this.#usage[dimension])} hard=${String(this.budget?.[dimension]?.hard)}`).join(", "); throw new WorkflowError("BUDGET_EXHAUSTED", `Budget version ${String(this.version)} exhausted: ${detail}`); }
  #evaluate(): void { const budget = this.budget; if (!budget) return; const soft = (Object.keys(budget) as BudgetDimension[]).filter((dimension) => { const limits = budget[dimension]; return limits !== undefined && limits.soft !== undefined && this.#usage[dimension] >= limits.soft; }); if (soft.length) this.#record("soft_crossed", soft); const overrun = (Object.keys(budget) as BudgetDimension[]).filter((dimension) => { const limits = budget[dimension]; return limits !== undefined && limits.hard !== undefined && this.#usage[dimension] > limits.hard; }); if (overrun.length) this.#record("hard_overrun", overrun); }
  #record(type: BudgetEvent["type"], dimensions: readonly BudgetDimension[]): void { if (this.#seen.has(type)) return; this.#seen.add(type); this.#events.push({ type, budgetVersion: this.version, dimensions: [...dimensions], usage: this.usage, limits: structuredClone(this.budget ?? {}), at: this.#now() }); this.#onChange?.(); }
  recordEvent(event: BudgetEvent): void { this.#events.push(structuredClone(event)); }
  snapshot(): { usage: WorkflowBudgetUsage; budgetEvents: readonly BudgetEvent[] } { return { usage: this.usage, budgetEvents: [...this.#events] }; }
}
export function mergeBudget(budget: WorkflowBudget | undefined, patch: WorkflowBudgetPatch): WorkflowBudget | undefined { const merged: WorkflowBudget = structuredClone(budget ?? {}); for (const dimension of ["tokens", "costUsd", "durationMs", "agentLaunches"] as const) if (Object.prototype.hasOwnProperty.call(patch, dimension)) { const value = patch[dimension]; if (value === null) { Reflect.deleteProperty(merged, dimension); continue; } const next: BudgetLimits = { ...(merged[dimension] ?? {}) }; for (const key of ["soft", "hard"] as const) if (value && Object.prototype.hasOwnProperty.call(value, key)) { const limit = value[key]; if (limit === null) Reflect.deleteProperty(next, key); else if (limit !== undefined) next[key] = limit; } if (Object.keys(next).length) (merged as Record<string, BudgetLimits>)[dimension] = next; else Reflect.deleteProperty(merged, dimension); } return validateBudget(merged); }
export function budgetRelaxed(previous: WorkflowBudget | undefined, next: WorkflowBudget | undefined): boolean { for (const dimension of ["tokens", "costUsd", "durationMs", "agentLaunches"] as const) { const oldLimit = previous?.[dimension]; const newLimit = next?.[dimension]; for (const key of ["soft", "hard"] as const) if ((oldLimit?.[key] !== undefined && newLimit?.[key] === undefined) || (oldLimit?.[key] !== undefined && newLimit?.[key] !== undefined && newLimit[key] > oldLimit[key])) return true; } return false; }
export function exhaustedBudgetDimensions(budget: WorkflowBudget | undefined, usage: WorkflowBudgetUsage): BudgetDimension[] { if (!budget) return []; return (Object.keys(budget) as BudgetDimension[]).filter((dimension) => { const limits = budget[dimension]; return limits !== undefined && limits.hard !== undefined && usage[dimension] >= limits.hard; }); }
export function resumeBudgetAllowed(budget: WorkflowBudget | undefined, usage: WorkflowBudgetUsage): boolean { return exhaustedBudgetDimensions(budget, usage).length === 0; }