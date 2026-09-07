import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { HARD_TERMINAL_RUN_STATES, WorkflowError, type LaunchSnapshot, type WorkflowRetentionSettings } from "./types.js";
import { acquireSessionLease, listPersistedSessionIds, listRunIds, RunStore, type BorrowedWorktreeBinding, type PersistedRun, type SessionLease } from "./persistence.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REQUIRED_FILES = new Set(["workflow.js", "state.json", "snapshot.json", "journal.json", "ownership.json", "worktrees.json", "borrowed-worktrees.json", "system-prompts.json"]);
const OPTIONAL_FILES = new Set(["result.json", "summary.json"]);
const REQUIRED_DIRECTORIES = new Set(["worktrees", ".system-prompts"]);

type StoredRun = { sessionId: string; runId: string; store: RunStore; run: PersistedRun; stateMtimeMs: number; dependencies: readonly string[] };

export interface RetentionCleanupOptions {
  cwd: string;
  sessionId: string;
  home?: string;
  allSessions?: boolean;
  retention: Readonly<WorkflowRetentionSettings>;
  now?: number;
}

export interface RetentionCleanupReport {
  candidates: readonly string[];
  deleted: readonly string[];
}

async function validateInventory(store: RunStore, loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> }): Promise<void> {
  const entries = await readdir(store.directory, { withFileTypes: true });
  for (const entry of entries) {
    if (REQUIRED_DIRECTORIES.has(entry.name)) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Run artifact is not a regular directory: ${join(store.directory, entry.name)}`);
      continue;
    }
    if (!REQUIRED_FILES.has(entry.name) && !OPTIONAL_FILES.has(entry.name)) throw new Error(`Run inventory contains an unrecognized artifact: ${join(store.directory, entry.name)}`);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Run artifact is not a regular file: ${join(store.directory, entry.name)}`);
  }
  for (const name of REQUIRED_FILES) {
    const entry = await lstat(join(store.directory, name));
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Run artifact is not a regular file: ${join(store.directory, name)}`);
  }
  if (loaded.run.state === "completed") {
    const result = await lstat(join(store.directory, "result.json"));
    if (!result.isFile() || result.isSymbolicLink()) throw new Error(`Run artifact is not a regular file: ${join(store.directory, "result.json")}`);
  }
  if (await readFile(join(store.directory, "workflow.js"), "utf8") !== loaded.snapshot.script) throw new Error("Persisted workflow source does not match its launch snapshot");
}

/** The runs this run cannot outlive: its parent, its retry lineage, and every run it borrows a named worktree from. */
export function runDependencyIds(run: Pick<PersistedRun, "parentRunId" | "retry">, borrowed: readonly BorrowedWorktreeBinding[]): string[] {
  const dependencies = new Set<string>();
  if (run.parentRunId !== undefined) dependencies.add(run.parentRunId);
  if (run.retry) {
    dependencies.add(run.retry.sourceRunId);
    dependencies.add(run.retry.lineageRootRunId);
  }
  for (const binding of borrowed) dependencies.add(binding.sourceRunId);
  return [...dependencies];
}

async function scanRun(cwd: string, sessionId: string, runId: string, home: string): Promise<StoredRun> {
  const store = new RunStore(cwd, sessionId, runId, home);
  const loaded = await store.load();
  await validateInventory(store, loaded);
  await store.loadSummary();
  await store.loadOwnership();
  await store.systemPrompts();
  await store.validateDeletionWorktrees();
  await store.validateBorrowedWorktrees();
  if (loaded.run.retry) await store.validateRetrySource();
  const stateMtimeMs = (await stat(join(store.directory, "state.json"))).mtimeMs;
  const dependencies = runDependencyIds(loaded.run, await store.borrowedWorktrees());
  if (dependencies.includes(runId)) throw new Error(`Run ${runId} depends on itself`);
  return { sessionId, runId, store, run: loaded.run, stateMtimeMs, dependencies };
}

async function scanSession(cwd: string, sessionId: string, home: string): Promise<StoredRun[]> {
  const runs: StoredRun[] = [];
  for (const runId of await listRunIds(cwd, sessionId, home)) runs.push(await scanRun(cwd, sessionId, runId, home));
  return runs;
}

function runKey(sessionId: string, runId: string): string { return `${sessionId}\0${runId}`; }

function validateDependencies(runs: readonly StoredRun[]): void {
  const byKey = new Map(runs.map((run) => [runKey(run.sessionId, run.runId), run]));
  for (const run of runs) for (const dependency of run.dependencies) if (!byKey.has(runKey(run.sessionId, dependency))) throw new Error(`Run ${run.runId} depends on missing run ${dependency}`);
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (sessionId: string, runId: string): void => {
    const key = runKey(sessionId, runId);
    if (visiting.has(key)) throw new Error("Persisted run dependency cycle prevents safe cleanup");
    if (visited.has(key)) return;
    visiting.add(key);
    for (const dependency of byKey.get(key)?.dependencies ?? []) visit(sessionId, dependency);
    visiting.delete(key);
    visited.add(key);
  };
  for (const run of runs) visit(run.sessionId, run.runId);
}

function eligibleRuns(runs: readonly StoredRun[], retention: Readonly<WorkflowRetentionSettings>, now: number): Set<string> {
  const terminal = runs.filter(({ run }) => HARD_TERMINAL_RUN_STATES.has(run.state));
  const eligible = new Set<string>();
  if (retention.olderThanDays !== undefined) {
    const cutoffMs = now - retention.olderThanDays * DAY_MS;
    if (!Number.isFinite(cutoffMs)) throw new Error("Retention olderThanDays produces an unrepresentable cutoff");
    for (const run of terminal) if (run.stateMtimeMs < cutoffMs) eligible.add(runKey(run.sessionId, run.runId));
  }
  if (retention.maxTerminalRuns !== undefined) {
    const newest = [...terminal].sort((left, right) => right.stateMtimeMs - left.stateMtimeMs || right.runId.localeCompare(left.runId));
    for (const run of newest.slice(retention.maxTerminalRuns)) eligible.add(runKey(run.sessionId, run.runId));
  }
  return eligible;
}

function cleanupOrder(runs: readonly StoredRun[], candidates: ReadonlySet<string>): readonly StoredRun[] {
  const remaining = new Set(candidates);
  const ordered: StoredRun[] = [];
  while (remaining.size) {
    const next = runs.find((run) => remaining.has(runKey(run.sessionId, run.runId)) && !runs.some((child) => remaining.has(runKey(child.sessionId, child.runId)) && child.sessionId === run.sessionId && child.dependencies.includes(run.runId)));
    if (!next) throw new Error("Dependency cycle prevents safe cleanup");
    ordered.push(next);
    remaining.delete(runKey(next.sessionId, next.runId));
  }
  return ordered;
}

async function recheck(run: StoredRun): Promise<void> {
  const before = await stat(join(run.store.directory, "state.json"));
  const loaded = await run.store.load();
  const after = await stat(join(run.store.directory, "state.json"));
  if (loaded.run.id !== run.runId || !HARD_TERMINAL_RUN_STATES.has(loaded.run.state) || before.mtimeMs !== after.mtimeMs || after.mtimeMs !== run.stateMtimeMs) throw new Error(`Retention candidate ${run.runId} changed before deletion`);
}
async function releaseLeases(leases: SessionLease[]): Promise<void> {
  const releases = await Promise.allSettled(leases.reverse().map((lease) => lease.release()));
  for (const release of releases) if (release.status === "rejected") throw release.reason;
}

export async function retainTerminalRuns(options: RetentionCleanupOptions): Promise<RetentionCleanupReport> {
  const home = resolve(options.home ?? homedir());
  const cwd = resolve(options.cwd);
  const now = options.now ?? Date.now();
  if (!Number.isFinite(now)) throw new Error("Retention start time is invalid");
  if (options.retention.olderThanDays === undefined && options.retention.maxTerminalRuns === undefined) return { candidates: [], deleted: [] };
  const sessionIds = options.allSessions ? [...new Set([...(await listPersistedSessionIds(cwd, home)), options.sessionId])] : [options.sessionId];
  const leases: SessionLease[] = [];
  const cleanableSessions: string[] = [];
  try {
    for (const sessionId of sessionIds) {
      if (sessionId === options.sessionId) { cleanableSessions.push(sessionId); continue; }
      try { leases.push(await acquireSessionLease(cwd, sessionId, home)); cleanableSessions.push(sessionId); }
      catch (error) { if (error instanceof WorkflowError && error.code === "RUN_OWNED") continue; throw error; }
    }
    const runs: StoredRun[] = [];
    for (const sessionId of cleanableSessions) runs.push(...await scanSession(cwd, sessionId, home));
    validateDependencies(runs);
    const eligible = eligibleRuns(runs, options.retention, now);
    const protectedRuns = new Set<string>();
    const protect = (sessionId: string, runId: string): void => {
      const key = runKey(sessionId, runId);
      if (protectedRuns.has(key)) return;
      protectedRuns.add(key);
      for (const dependency of runs.find((run) => run.sessionId === sessionId && run.runId === runId)?.dependencies ?? []) protect(sessionId, dependency);
    };
    for (const run of runs) if (!eligible.has(runKey(run.sessionId, run.runId))) protect(run.sessionId, run.runId);
    const candidates = new Set([...eligible].filter((key) => !protectedRuns.has(key)));
    const deleted: string[] = [];
    for (const run of cleanupOrder(runs, candidates)) {
      await recheck(run);
      await run.store.delete(true);
      deleted.push(run.runId);
    }
    return { candidates: [...candidates].map((key) => key.slice(key.indexOf("\0") + 1)), deleted };
  } finally {
    await releaseLeases(leases);
  }
}
