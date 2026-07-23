import { createHash } from "node:crypto";
import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { validateBudget } from "./budget.js";
import { RUN_STATES, type RunState } from "./types.js";
import { jsonValue, validateModelAliases } from "./utils.js";
import { validateSchema } from "./validation.js";
import { acquireSessionLease, hasLiveSessionLease, projectSessionsDirectory, RunStore, type PersistedRun, type SessionLease } from "./persistence.js";

const TERMINAL_STATES = new Set<RunState>(["completed", "failed", "stopped"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const REQUIRED_RUN_FILES = ["workflow.js", "state.json", "snapshot.json", "journal.json", "ownership.json", "worktrees.json", "borrowed-worktrees.json", "system-prompts.json"] as const;
const OPTIONAL_RUN_FILES = new Set(["result.json"]);
const RUN_DIRECTORIES = new Set(["worktrees"]);
const RUN_FILES = new Set<string>([...REQUIRED_RUN_FILES, ...OPTIONAL_RUN_FILES]);
const AGENT_STATES = new Set(["queued", "running", "waiting_for_child", "paused", "retrying", "completed", "failed", "cancelled"]);
const SCHEDULER_STATES = new Set(["queued", "running", "waiting_for_child", "paused", "retrying", "completed", "failed", "cancelled"]);
const BUDGET_DIMENSIONS = new Set(["tokens", "costUsd", "durationMs", "agentLaunches"]);
const BUDGET_EVENT_TYPES = new Set(["soft_crossed", "hard_overrun", "hard_exhausted", "adjustment_requested", "adjustment_approved", "adjustment_rejected"]);

export interface DoctorCleanupOptions { cwd?: string; home?: string; olderThanDays?: number; yes?: boolean; now?: number }
export interface CleanupRunResult { sessionId: string; runId: string; action: "candidate" | "skipped" | "deleted" | "failed"; state: string; stateMtimeMs: number; path: string; reason?: string }
export interface CleanupFailure { sessionId: string; runId?: string; message: string }
export interface CleanupSessionReport { sessionId: string; path: string; status: "preview" | "cleaned" | "skipped" | "failed"; reason?: string }
export interface DoctorCleanupReport { cwd: string; cutoffMs: number; olderThanDays: number; yes: boolean; sessions: readonly CleanupSessionReport[]; candidates: readonly CleanupRunResult[]; skipped: readonly CleanupRunResult[]; deleted: readonly CleanupRunResult[]; failures: readonly CleanupFailure[] }

type StoredRun = { sessionId: string; runId: string; store: RunStore; run: PersistedRun; stateMtimeMs: number; dependencies: readonly string[] };
type SessionScan = { sessionId: string; path: string; runs: readonly StoredRun[]; liveLease: boolean };
type SessionPlan = { candidates: readonly StoredRun[]; skipped: readonly CleanupRunResult[] };

function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function textError(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function positiveDays(value: number): number { if (!Number.isSafeInteger(value) || value < 1 || !Number.isFinite(value * DAY_MS)) throw new Error("older-than-days must be a positive integer"); return value; }
function runItem(entry: StoredRun, action: CleanupRunResult["action"], reason?: string): CleanupRunResult { return { sessionId: entry.sessionId, runId: entry.runId, action, state: entry.run.state, stateMtimeMs: entry.stateMtimeMs, path: entry.store.directory, ...(reason ? { reason } : {}) }; }
function sameNames(left: readonly string[], right: readonly string[]): boolean { return left.length === right.length && left.every((value, index) => value === right[index]); }
async function jsonFile(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")) as unknown; }
async function requiredFile(path: string): Promise<void> { const info = await lstat(path); if (!info.isFile()) throw new Error(`Required artifact is not a regular file: ${path}`); }
function stringList(value: unknown, label: string, nonEmpty = false): void { if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || (nonEmpty && !item))) throw new Error(`${label} is invalid`); }
function optionalString(value: unknown, label: string): void { if (value !== undefined && typeof value !== "string") throw new Error(`${label} is invalid`); }
function nonNegativeInteger(value: unknown, label: string): void { if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${label} is invalid`); }
function positiveInteger(value: unknown, label: string): void { if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error(`${label} is invalid`); }
function finiteNumber(value: unknown, label: string): void { if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`${label} is invalid`); }
function model(value: unknown, label: string): void { if (!object(value) || typeof value.provider !== "string" || !value.provider || typeof value.model !== "string" || !value.model || (value.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinking as string))) throw new Error(`${label} is invalid`); }
function accounting(value: unknown, label: string): void { if (!object(value)) throw new Error(`${label} is invalid`); for (const key of ["input", "output", "cacheRead", "cacheWrite", "cost"]) finiteNumber(value[key], `${label}.${key}`); }
function resourceExclusions(value: unknown, label: string): void { if (value === undefined) return; if (!object(value)) throw new Error(`${label} is invalid`); if (value.skills !== undefined) stringList(value.skills, `${label}.skills`); if (value.extensions !== undefined) stringList(value.extensions, `${label}.extensions`); }
function agentDefinition(value: unknown, label: string): void { if (!object(value)) throw new Error(`${label} is invalid`); optionalString(value.prompt, `${label}.prompt`); optionalString(value.description, `${label}.description`); optionalString(value.model, `${label}.model`); if (value.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinking as string)) throw new Error(`${label}.thinking is invalid`); if (value.tools !== undefined) stringList(value.tools, `${label}.tools`); resourceExclusions(value.disabledAgentResources, `${label}.disabledAgentResources`); }
function validateScheduledOptions(value: unknown, label: string): void { if (!object(value) || typeof value.label !== "string" || !value.label || typeof value.cwd !== "string" || !value.cwd) throw new Error(`${label} is invalid`); optionalString(value.requestedLabel, `${label}.requestedLabel`); optionalString(value.parentBreadcrumb, `${label}.parentBreadcrumb`); stringList(value.tools, `${label}.tools`); optionalString(value.worktreeOwner, `${label}.worktreeOwner`); optionalString(value.model, `${label}.model`); if (value.thinking !== undefined && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value.thinking as string)) throw new Error(`${label}.thinking is invalid`); optionalString(value.role, `${label}.role`); if (value.schema !== undefined) validateSchema(value.schema, `${label}.schema`); if (value.retries !== undefined) nonNegativeInteger(value.retries, `${label}.retries`); if (value.timeoutMs !== undefined && value.timeoutMs !== null) positiveInteger(value.timeoutMs, `${label}.timeoutMs`); if (value.agentOptions !== undefined && (!object(value.agentOptions) || !jsonValue(value.agentOptions))) throw new Error(`${label}.agentOptions is invalid`); if (value.agentIdentity !== undefined) { if (!object(value.agentIdentity) || !Array.isArray(value.agentIdentity.structuralPath) || value.agentIdentity.structuralPath.some((part) => typeof part !== "string") || typeof value.agentIdentity.callSite !== "string") throw new Error(`${label}.agentIdentity is invalid`); positiveInteger(value.agentIdentity.occurrence, `${label}.agentIdentity.occurrence`); optionalString(value.agentIdentity.parentBreadcrumb, `${label}.agentIdentity.parentBreadcrumb`); optionalString(value.agentIdentity.worktreeOwner, `${label}.agentIdentity.worktreeOwner`); } }
function validateAgent(value: unknown, label: string): void { if (!object(value) || typeof value.id !== "string" || !value.id || typeof value.name !== "string" || !value.name || typeof value.path !== "string" || !value.path || typeof value.state !== "string" || !AGENT_STATES.has(value.state)) throw new Error(`${label} is invalid`); optionalString(value.label, `${label}.label`); optionalString(value.parentId, `${label}.parentId`); if (value.structuralPath !== undefined) stringList(value.structuralPath, `${label}.structuralPath`); optionalString(value.parentBreadcrumb, `${label}.parentBreadcrumb`); optionalString(value.worktreeOwner, `${label}.worktreeOwner`); optionalString(value.role, `${label}.role`); optionalString(value.requestedModel, `${label}.requestedModel`); model(value.model, `${label}.model`); stringList(value.tools, `${label}.tools`); nonNegativeInteger(value.attempts, `${label}.attempts`); if (value.attemptDetails !== undefined) { if (!Array.isArray(value.attemptDetails)) throw new Error(`${label}.attemptDetails is invalid`); for (const [index, attempt] of value.attemptDetails.entries()) { const at = `${label}.attemptDetails[${String(index)}]`; if (!object(attempt) || !Number.isSafeInteger(attempt.attempt) || Number(attempt.attempt) < 1 || typeof attempt.sessionId !== "string" || !attempt.sessionId || typeof attempt.sessionFile !== "string" || !attempt.sessionFile) throw new Error(`${at} is invalid`); accounting(attempt.accounting, `${at}.accounting`); if (attempt.error !== undefined && (!object(attempt.error) || typeof attempt.error.code !== "string" || typeof attempt.error.message !== "string")) throw new Error(`${at}.error is invalid`); if (attempt.setup !== undefined) { if (!object(attempt.setup) || !Array.isArray(attempt.setup.hookNames) || attempt.setup.hookNames.some((name) => typeof name !== "string") || typeof attempt.setup.cwd !== "string") throw new Error(`${at}.setup is invalid`); model(attempt.setup.model, `${at}.setup.model`); stringList(attempt.setup.tools, `${at}.setup.tools`); resourceExclusions(attempt.setup.disabledAgentResources, `${at}.setup.disabledAgentResources`); } } } if (value.accounting !== undefined) accounting(value.accounting, `${label}.accounting`); if (value.toolCalls !== undefined) { if (!Array.isArray(value.toolCalls)) throw new Error(`${label}.toolCalls is invalid`); for (const call of value.toolCalls) if (!object(call) || typeof call.id !== "string" || typeof call.name !== "string" || !["running", "completed", "failed"].includes(call.state as string)) throw new Error(`${label}.toolCalls is invalid`); } if (value.activity !== undefined && (!object(value.activity) || !["reasoning", "tool", "text"].includes(value.activity.kind as string) || typeof value.activity.text !== "string")) throw new Error(`${label}.activity is invalid`); }
function validateUsage(value: unknown, label: string): void { if (!object(value)) throw new Error(`${label} is invalid`); for (const key of ["tokens", "costUsd", "durationMs", "agentLaunches"]) finiteNumber(value[key], `${label}.${key}`); }
function validateBudgetEvents(value: unknown): void { if (value === undefined) return; if (!Array.isArray(value)) throw new Error("Persisted budget events are invalid"); for (const [index, event] of value.entries()) { const label = `budgetEvents[${String(index)}]`; if (!object(event) || typeof event.type !== "string" || !BUDGET_EVENT_TYPES.has(event.type) || !Number.isSafeInteger(event.budgetVersion) || Number(event.budgetVersion) < 1 || !Array.isArray(event.dimensions) || event.dimensions.some((dimension) => typeof dimension !== "string" || !BUDGET_DIMENSIONS.has(dimension)) || typeof event.at !== "number" || !Number.isFinite(event.at) || event.limits === undefined) throw new Error(`${label} is invalid`); validateUsage(event.usage, `${label}.usage`); validateBudget(event.limits); } }
function validateRunRecord(run: PersistedRun): void {
  const value = run as unknown;
  if (!object(value) || typeof value.id !== "string" || !value.id || typeof value.workflowName !== "string" || !value.workflowName || typeof value.cwd !== "string" || !value.cwd || typeof value.sessionId !== "string" || !value.sessionId || !RUN_STATES.includes(value.state as RunState) || !Array.isArray(value.agents) || !Array.isArray(value.nativeSessions)) throw new Error("Persisted run state is invalid");
  const agents = value.agents as Record<string, unknown>[];
  agents.forEach((agent, index) => { validateAgent(agent, `agents[${String(index)}]`); });
  const agentIds = new Set<string>();
  for (const agent of agents) {
    const id = agent.id as string;
    if (agentIds.has(id)) throw new Error(`Duplicate persisted agent ${id}`);
    agentIds.add(id);
  }
  for (const agent of agents) {
    const parentId = agent.parentId;
    if (parentId !== undefined && (typeof parentId !== "string" || !agentIds.has(parentId))) throw new Error("Persisted agent has a missing parent");
    const seen = new Set<string>();
    let parent = typeof parentId === "string" ? parentId : undefined;
    while (parent) {
      if (seen.has(parent)) throw new Error("Persisted agent parent cycle");
      seen.add(parent);
      const parentAgent = agents.find((candidate) => candidate.id === parent);
      parent = typeof parentAgent?.parentId === "string" ? parentAgent.parentId : undefined;
    }
  }
  for (const [index, session] of (value.nativeSessions as unknown[]).entries()) if (!object(session) || typeof session.sessionId !== "string" || !session.sessionId || typeof session.sessionFile !== "string" || !session.sessionFile) throw new Error(`nativeSessions[${String(index)}] is invalid`);
  optionalString(value.parentRunId, "Persisted parent run");
  if (value.retry !== undefined) {
    if (!object(value.retry) || typeof value.retry.sourceRunId !== "string" || !value.retry.sourceRunId || typeof value.retry.lineageRootRunId !== "string" || !value.retry.lineageRootRunId) throw new Error("Persisted retry provenance is invalid");
    const sourceRunId = value.retry.sourceRunId;
    stringList(value.retry.completedPaths, "Persisted retry completed paths");
    stringList(value.retry.incompletePaths, "Persisted retry incomplete paths");
    stringList(value.retry.namedWorktrees, "Persisted retry named worktrees");
    if (value.parentRunId !== sourceRunId) throw new Error("Persisted retry parent does not match its source");
  }
  optionalString(value.phase, "Persisted phase");
  if (value.phaseHistory !== undefined) {
    if (!Array.isArray(value.phaseHistory)) throw new Error("Persisted phase history is invalid");
    for (const phase of value.phaseHistory) { if (!object(phase) || typeof phase.phase !== "string" || !phase.phase) throw new Error("Persisted phase history is invalid"); nonNegativeInteger(phase.afterAgent, "Persisted phase history afterAgent"); }
  }
  if (value.error !== undefined && (!object(value.error) || typeof value.error.code !== "string" || typeof value.error.message !== "string")) throw new Error("Persisted run error is invalid");
  validateBudget(value.budget);
  if (value.budgetVersion !== undefined) positiveInteger(value.budgetVersion, "Persisted budget version");
  if (value.usage !== undefined) validateUsage(value.usage, "Persisted usage");
  validateBudgetEvents(value.budgetEvents);
  if (value.events !== undefined) { if (!Array.isArray(value.events)) throw new Error("Persisted run events are invalid"); for (const event of value.events) if (!object(event) || typeof event.type !== "string" || typeof event.message !== "string") throw new Error("Persisted run event is invalid"); }
}
function validateSnapshot(snapshot: unknown): void {
  if (!object(snapshot) || typeof snapshot.script !== "string" || !snapshot.script || !jsonValue(snapshot.args) || !object(snapshot.metadata) || typeof snapshot.metadata.name !== "string" || !snapshot.metadata.name || (snapshot.metadata.description !== undefined && typeof snapshot.metadata.description !== "string") || !object(snapshot.settings) || !Number.isSafeInteger(snapshot.settings.concurrency) || Number(snapshot.settings.concurrency) < 1 || Number(snapshot.settings.concurrency) > 16 || !Array.isArray(snapshot.models) || snapshot.models.some((modelName) => typeof modelName !== "string") || !Array.isArray(snapshot.tools) || snapshot.tools.some((tool) => typeof tool !== "string") || !Array.isArray(snapshot.agentTypes) || snapshot.agentTypes.some((agentType) => typeof agentType !== "string") || !Array.isArray(snapshot.schemas)) throw new Error("Persisted launch snapshot is invalid");
  if (snapshot.identityVersion !== undefined) positiveInteger(snapshot.identityVersion, "Persisted snapshot identity version");
  if (snapshot.launchKind !== undefined && !["inline", "function"].includes(snapshot.launchKind as string)) throw new Error("Persisted snapshot launch kind is invalid");
  if (snapshot.launchKind === "function" && (typeof snapshot.functionName !== "string" || !snapshot.functionName)) throw new Error("Persisted snapshot function name is invalid");
  optionalString(snapshot.functionName, "Persisted snapshot function name");
  optionalString(snapshot.settingsPath, "Persisted snapshot settings path");
  validateBudget(snapshot.budget);
  if (snapshot.modelAliases !== undefined) validateModelAliases(snapshot.modelAliases);
  if (snapshot.settings.modelAliases !== undefined) validateModelAliases(snapshot.settings.modelAliases);
  resourceExclusions(snapshot.settings.disabledAgentResources, "Persisted snapshot disabled resources");
  if (snapshot.roles !== undefined) { if (!object(snapshot.roles)) throw new Error("Persisted snapshot roles are invalid"); for (const [name, definition] of Object.entries(snapshot.roles)) agentDefinition(definition, `Persisted snapshot role ${name}`); }
  if (snapshot.projectRoles !== undefined) stringList(snapshot.projectRoles, "Persisted snapshot project roles");
  for (const [index, schema] of snapshot.schemas.entries()) validateSchema(schema, `Persisted snapshot schema[${String(index)}]`);
}
function validateJournal(value: unknown): void { if (!object(value) || !object(value.completed) || (value.awaiting !== undefined && !object(value.awaiting)) || (value.decisions !== undefined && !object(value.decisions))) throw new Error("Persisted workflow journal is invalid"); for (const operation of Object.values(value.completed)) if (!object(operation) || typeof operation.path !== "string" || !operation.path || !jsonValue(operation.value)) throw new Error("Persisted completed operation is invalid"); for (const checkpoint of Object.values(value.awaiting ?? {})) if (!object(checkpoint) || typeof checkpoint.path !== "string" || !checkpoint.path || typeof checkpoint.name !== "string" || !checkpoint.name || typeof checkpoint.prompt !== "string" || !jsonValue(checkpoint.context)) throw new Error("Persisted awaiting checkpoint is invalid"); for (const decision of Object.values(value.decisions ?? {})) { if (!object(decision) || decision.kind !== "budget" || typeof decision.proposalId !== "string" || !decision.proposalId || typeof decision.runId !== "string" || !decision.runId || !object(decision.previous) || !object(decision.proposed) || !Number.isSafeInteger(decision.budgetVersion) || Number(decision.budgetVersion) < 1) throw new Error("Persisted budget decision is invalid"); validateUsage(decision.consumed, "Persisted budget decision usage"); validateBudget(decision.previous); validateBudget(decision.proposed); } }
function validateSystemPrompts(value: unknown): void {
  if (!object(value) || value.version !== 1 || !Array.isArray(value.entries)) throw new Error("Persisted system prompts are invalid");
  for (const [index, entry] of value.entries.entries()) {
    const label = `system-prompts.entries[${String(index)}]`;
    if (!object(entry) || typeof entry.sessionId !== "string" || !entry.sessionId || !Number.isSafeInteger(entry.attempt) || Number(entry.attempt) < 1 || !Number.isSafeInteger(entry.turn) || Number(entry.turn) < 1 || typeof entry.prompt !== "string" || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256) || createHash("sha256").update(entry.prompt).digest("hex") !== entry.sha256) throw new Error(`${label} is invalid`);
  }
}
async function validateRunDirectory(store: RunStore): Promise<void> {
  const entries = await readdir(store.directory, { withFileTypes: true });
  for (const entry of entries) {
    if (RUN_DIRECTORIES.has(entry.name)) { if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Run artifact is not a regular directory: ${join(store.directory, entry.name)}`); continue; }
    if (!RUN_FILES.has(entry.name)) throw new Error(`Run inventory contains an unrecognized artifact: ${join(store.directory, entry.name)}`);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Run artifact is not a regular file: ${join(store.directory, entry.name)}`);
  }
}
async function validateRunArtifacts(store: RunStore, workflowScript: string, state: RunState): Promise<readonly { sourceRunId: string }[]> {
  await validateRunDirectory(store);
  for (const name of REQUIRED_RUN_FILES) await requiredFile(join(store.directory, name));
  if (await readFile(join(store.directory, "workflow.js"), "utf8") !== workflowScript) throw new Error("Persisted workflow source does not match its launch snapshot");
  validateSystemPrompts(await jsonFile(join(store.directory, "system-prompts.json")));
  const result = await jsonFile(join(store.directory, "result.json")).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; });
  if (result === undefined && state === "completed") throw new Error("Completed run result is missing");
  if (result !== undefined && !jsonValue(result)) throw new Error("Persisted workflow result is invalid");
  validateJournal(await jsonFile(join(store.directory, "journal.json")));
  const rawOwnership = await jsonFile(join(store.directory, "ownership.json"));
  if (!Array.isArray(rawOwnership)) throw new Error("Persisted ownership records are invalid");
  const ownership = rawOwnership as unknown[];
  const ownershipIds = new Set<string>();
  for (const [index, record] of ownership.entries()) {
    const label = `ownership[${String(index)}]`;
    if (!object(record) || typeof record.id !== "string" || !record.id || ownershipIds.has(record.id) || typeof record.label !== "string" || !record.label || typeof record.state !== "string" || !SCHEDULER_STATES.has(record.state)) throw new Error(`${label} is invalid`);
    ownershipIds.add(record.id);
    optionalString(record.parentId, `${label}.parentId`);
    validateScheduledOptions(record.options, `${label}.options`);
  }
  for (const record of ownership) if (object(record) && record.parentId !== undefined && (typeof record.parentId !== "string" || !ownershipIds.has(record.parentId))) throw new Error("Persisted ownership parent is missing");
  await store.validateDeletionWorktrees();
  const borrowed = await store.borrowedWorktrees();
  await store.validateBorrowedWorktrees();
  return borrowed.map(({ sourceRunId }) => ({ sourceRunId }));
}

async function sessionEntries(path: string): Promise<readonly import("node:fs").Dirent[]> {
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error(`Session inventory is not a directory: ${path}`);
  return readdir(path, { withFileTypes: true });
}

async function scanSession(cwd: string, sessionId: string, home: string, expectedLease?: SessionLease): Promise<SessionScan> {
  const path = join(projectSessionsDirectory(cwd, home), sessionId);
  const rootEntries = await sessionEntries(path);
  const runsEntry = rootEntries.find((entry) => entry.name === "runs");
  if (!runsEntry || !runsEntry.isDirectory() || runsEntry.isSymbolicLink()) throw new Error(`Session inventory has no regular runs directory: ${path}`);
  if (rootEntries.some((entry) => entry.name !== "runs")) throw new Error(`Session inventory contains an unrecognized entry: ${path}`);
  const runsPath = join(path, "runs");
  const before = await sessionEntries(runsPath);
  const runEntries = before.filter((entry) => entry.name !== "owner.json");
  if (before.some((entry) => entry.name === "owner.json" && entry.isSymbolicLink())) throw new Error(`Session ownership lease is not a regular file: ${runsPath}`);
  for (const entry of runEntries) if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) throw new Error(`Session inventory contains an unrecognized entry: ${join(runsPath, entry.name)}`);
  const ownerPath = join(runsPath, "owner.json");
  let liveLease = false;
  if (expectedLease && expectedLease.path === ownerPath) {
    const owned = await jsonFile(ownerPath);
    if (!object(owned) || owned.token !== expectedLease.token) throw new Error("Session ownership lease changed before deletion");
  } else liveLease = await hasLiveSessionLease(cwd, sessionId, home);
  const runs: StoredRun[] = [];
  for (const entry of runEntries) {
    const runId = entry.name;
    const store = new RunStore(cwd, sessionId, runId, home);
    try {
      const beforeState = await stat(join(store.directory, "state.json"));
      const loaded = await store.load();
      validateRunRecord(loaded.run);
      validateSnapshot(loaded.snapshot);
      if (loaded.run.parentRunId !== undefined) await store.validateParentRun(loaded.run.parentRunId);
      if (loaded.run.retry) await store.validateRetrySource();
      const borrowed = await validateRunArtifacts(store, loaded.snapshot.script, loaded.run.state);
      const afterState = await stat(join(store.directory, "state.json"));
      if (beforeState.mtimeMs !== afterState.mtimeMs) throw new Error("Persisted state changed while scanning");
      const dependencies = new Set<string>();
      if (loaded.run.parentRunId !== undefined) dependencies.add(loaded.run.parentRunId);
      if (loaded.run.retry) { dependencies.add(loaded.run.retry.sourceRunId); dependencies.add(loaded.run.retry.lineageRootRunId); }
      for (const binding of borrowed) dependencies.add(binding.sourceRunId);
      if (dependencies.has(runId)) throw new Error("Persisted run depends on itself");
      runs.push({ sessionId, runId, store, run: loaded.run, stateMtimeMs: afterState.mtimeMs, dependencies: [...dependencies] });
    } catch (error) { throw new Error(`Run ${runId} is corrupt or incomplete: ${textError(error)}`, { cause: error }); }
  }
  const after = await sessionEntries(runsPath);
  const beforeNames = before.map(({ name }) => name).sort();
  const afterNames = after.map(({ name }) => name).sort();
  if (!sameNames(beforeNames, afterNames)) throw new Error("Session inventory changed while scanning");
  const known = new Set(runs.map(({ runId }) => runId));
  for (const run of runs) for (const dependency of run.dependencies) if (!known.has(dependency)) throw new Error(`Run ${run.runId} depends on missing run ${dependency}`);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (runId: string): void => {
    if (visiting.has(runId)) throw new Error("Persisted run dependency cycle prevents safe cleanup");
    if (visited.has(runId)) return;
    visiting.add(runId);
    const run = runs.find(({ runId: current }) => current === runId);
    for (const dependency of run?.dependencies ?? []) visit(dependency);
    visiting.delete(runId);
    visited.add(runId);
  };
  for (const run of runs) visit(run.runId);
  return { sessionId, path, runs, liveLease };
}

async function recheckCandidate(entry: StoredRun, cutoffMs: number): Promise<string | undefined> {
  const before = await stat(join(entry.store.directory, "state.json")).catch(() => undefined);
  if (!before) return "State record disappeared before deletion";
  const loaded = await entry.store.load().catch((error: unknown) => { throw new Error(`Candidate could not be reloaded: ${textError(error)}`); });
  validateRunRecord(loaded.run);
  if (loaded.run.id !== entry.runId || loaded.run.state !== entry.run.state || !TERMINAL_STATES.has(loaded.run.state)) return "Candidate state changed before deletion";
  const after = await stat(join(entry.store.directory, "state.json"));
  if (before.mtimeMs !== after.mtimeMs || after.mtimeMs !== entry.stateMtimeMs) return "Candidate state record changed before deletion";
  if (after.mtimeMs >= cutoffMs) return "Candidate is no longer older than the cutoff";
  return undefined;
}

function planSession(scan: SessionScan, cutoffMs: number): SessionPlan {
  if (scan.liveLease) return { candidates: [], skipped: scan.runs.map((entry) => runItem(entry, "skipped", "Session has a live ownership lease")) };
  const oldTerminal = new Set(scan.runs.filter(({ run, stateMtimeMs }) => TERMINAL_STATES.has(run.state) && stateMtimeMs < cutoffMs).map(({ runId }) => runId));
  const protectedRuns = new Set<string>();
  const visit = (runId: string) => { if (protectedRuns.has(runId)) return; protectedRuns.add(runId); const entry = scan.runs.find(({ runId: current }) => current === runId); for (const dependency of entry?.dependencies ?? []) visit(dependency); };
  for (const entry of scan.runs) if (!oldTerminal.has(entry.runId)) for (const dependency of entry.dependencies) visit(dependency);
  const skipped: CleanupRunResult[] = [];
  for (const entry of scan.runs) {
    if (!TERMINAL_STATES.has(entry.run.state)) skipped.push(runItem(entry, "skipped", `Run state ${entry.run.state} is active or resumable`));
    else if (entry.stateMtimeMs >= cutoffMs) skipped.push(runItem(entry, "skipped", "State record is not older than the cutoff"));
    else if (protectedRuns.has(entry.runId)) skipped.push(runItem(entry, "skipped", "A retained run depends on this run"));
  }
  return { candidates: scan.runs.filter(({ runId }) => oldTerminal.has(runId) && !protectedRuns.has(runId)), skipped };
}

function deletionOrder(scan: SessionScan, candidates: readonly StoredRun[]): readonly StoredRun[] {
  const candidateIds = new Set(candidates.map(({ runId }) => runId));
  const remaining = new Set(candidateIds);
  const ordered: StoredRun[] = [];
  while (remaining.size) {
    const next = candidates.find((entry) => remaining.has(entry.runId) && !candidates.some((child) => remaining.has(child.runId) && child.dependencies.includes(entry.runId)));
    if (!next) throw new Error("Dependency cycle prevents safe cleanup");
    ordered.push(next); remaining.delete(next.runId);
  }
  return ordered;
}

async function storedSessionIds(cwd: string, home: string): Promise<readonly string[]> {
  const path = projectSessionsDirectory(cwd, home);
  let entries: readonly import("node:fs").Dirent[];
  try { entries = await sessionEntries(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  if (entries.some((entry) => entry.isSymbolicLink())) throw new Error(`Project session inventory contains a symbolic link: ${path}`);
  const invalid = entries.find((entry) => !entry.isDirectory());
  if (invalid) throw new Error(`Project session inventory contains an unrecognized entry: ${join(path, invalid.name)}`);
  return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map(({ name }) => name).sort();
}

function addUnique(items: CleanupRunResult[], item: CleanupRunResult): void { if (!items.some((current) => current.sessionId === item.sessionId && current.runId === item.runId && current.action === item.action)) items.push(item); }
function addFailure(items: CleanupFailure[], sessionId: string, message: string, runId?: string): void { items.push({ sessionId, ...(runId ? { runId } : {}), message }); }

export async function doctorCleanup(options: DoctorCleanupOptions = {}): Promise<DoctorCleanupReport> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const home = resolve(options.home ?? homedir());
  const olderThanDays = positiveDays(options.olderThanDays ?? 90);
  const yes = options.yes === true;
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error("Cleanup command start time is invalid");
  const cutoffMs = now - olderThanDays * DAY_MS;
  const sessions: CleanupSessionReport[] = [];
  const candidates: CleanupRunResult[] = [];
  const skipped: CleanupRunResult[] = [];
  const deleted: CleanupRunResult[] = [];
  const failures: CleanupFailure[] = [];
  let sessionIds: readonly string[];
  try { sessionIds = await storedSessionIds(cwd, home); } catch (error) { addFailure(failures, "(project)", textError(error)); return { cwd, cutoffMs, olderThanDays, yes, sessions, candidates, skipped, deleted, failures }; }
  for (const sessionId of sessionIds) {
    let initial: SessionScan;
    try { initial = await scanSession(cwd, sessionId, home); } catch (error) { sessions.push({ sessionId, path: join(projectSessionsDirectory(cwd, home), sessionId), status: "failed", reason: textError(error) }); addFailure(failures, sessionId, textError(error)); continue; }
    const initialPlan = planSession(initial, cutoffMs);
    for (const item of initialPlan.candidates) addUnique(candidates, runItem(item, "candidate"));
    for (const item of initialPlan.skipped) addUnique(skipped, item);
    if (!yes || initial.liveLease) { sessions.push({ sessionId, path: initial.path, status: initial.liveLease ? "skipped" : "preview", ...(initial.liveLease ? { reason: "Session has a live ownership lease" } : {}) }); continue; }
    let lease: SessionLease;
    try { lease = await acquireSessionLease(cwd, sessionId, home); } catch (error) {
      const message = textError(error);
      if (/already owned|active ownership|RUN_OWNED/i.test(message)) { sessions.push({ sessionId, path: initial.path, status: "skipped", reason: "Session has a live ownership lease" }); continue; }
      sessions.push({ sessionId, path: initial.path, status: "failed", reason: message }); addFailure(failures, sessionId, message); continue;
    }
    try {
      let current: SessionScan;
      try { current = await scanSession(cwd, sessionId, home, lease); } catch (error) { const message = textError(error); sessions.push({ sessionId, path: initial.path, status: "failed", reason: message }); addFailure(failures, sessionId, message); continue; }
      let freshPlan = planSession(current, cutoffMs);
      for (const item of freshPlan.candidates) addUnique(candidates, runItem(item, "candidate"));
      const freshIds = new Set(freshPlan.candidates.map(({ runId }) => runId));
      for (const item of initialPlan.candidates) if (!freshIds.has(item.runId)) addUnique(skipped, runItem(item, "skipped", "Candidate changed or is no longer independently eligible"));
      let clean = true;
      while (freshPlan.candidates.length) {
        try { current = await scanSession(cwd, sessionId, home, lease); freshPlan = planSession(current, cutoffMs); for (const item of freshPlan.skipped) addUnique(skipped, item); } catch (error) { const message = textError(error); addFailure(failures, sessionId, message); clean = false; break; }
        if (!freshPlan.candidates.length) break;
        let ordered: readonly StoredRun[];
        try { ordered = deletionOrder(current, freshPlan.candidates); } catch (error) { const message = textError(error); addFailure(failures, sessionId, message); clean = false; break; }
        const target = ordered[0];
        if (!target) break;
        let changed: string | undefined;
        try { changed = await recheckCandidate(target, cutoffMs); } catch (error) { const message = textError(error); addFailure(failures, sessionId, message, target.runId); clean = false; break; }
        if (changed) { addUnique(skipped, runItem(target, "skipped", changed)); clean = false; break; }
        try { await target.store.delete(true); deleted.push(runItem(target, "deleted")); } catch (error) { const message = textError(error); addUnique(skipped, runItem(target, "failed", message)); addFailure(failures, sessionId, message, target.runId); clean = false; break; }
      }
      if (clean) sessions.push({ sessionId, path: initial.path, status: "cleaned" });
      else if (!sessions.some(({ sessionId: currentId }) => currentId === sessionId)) sessions.push({ sessionId, path: initial.path, status: "failed", reason: "Cleanup stopped after a safety recheck or deletion failure" });
    } finally { try { await lease.release(); } catch (error) { addFailure(failures, sessionId, textError(error)); } }
  }
  return { cwd, cutoffMs, olderThanDays, yes, sessions, candidates, skipped, deleted, failures };
}

export function doctorCleanupExitCode(report: DoctorCleanupReport): 0 | 1 { return report.failures.length ? 1 : 0; }
function runLine(item: CleanupRunResult): string { return `- [${item.action}] session=${item.sessionId} run=${item.runId} state=${item.state} state-mtime=${new Date(item.stateMtimeMs).toISOString()} path=\`${item.path}\`${item.reason ? `: ${item.reason}` : ""}`; }
export function formatDoctorCleanupReport(report: DoctorCleanupReport): string {
  const lines = ["# pi-extensible-workflows doctor cleanup", "", "## Cleanup", `- Project: \`${report.cwd}\``, `- Cutoff: \`${new Date(report.cutoffMs).toISOString()}\` (strictly older than ${String(report.olderThanDays)} day(s))`, `- Mode: ${report.yes ? "confirmed deletion" : "preview only"}`, "", "## Candidates", ...(report.candidates.length ? report.candidates.map(runLine) : ["- None"]), "", "## Skipped", ...(report.skipped.length ? report.skipped.map(runLine) : ["- None"]), "", "## Deleted", ...(report.deleted.length ? report.deleted.map(runLine) : ["- None"]), "", "## Session safety", ...(report.sessions.length ? report.sessions.map((session) => `- [${session.status}] session=${session.sessionId} path=\`${session.path}\`${session.reason ? `: ${session.reason}` : ""}`) : ["- None stored"]), "", "## Failures", ...(report.failures.length ? report.failures.map((failure) => `- session=${failure.sessionId}${failure.runId ? ` run=${failure.runId}` : ""}: ${failure.message}`) : ["- None"]), "", "## Summary", `- ${String(report.candidates.length)} candidate(s), ${String(report.deleted.length)} deleted, ${String(report.skipped.length)} skipped, ${String(report.failures.length)} failure(s)`];
  if (!report.yes) lines.push("", "No files were changed. Re-run with --yes to confirm deletion.");
  return `${lines.join("\n")}\n`;
}