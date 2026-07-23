import { lstat, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { RUN_STATES, type RunState } from "./types.js";
import { acquireSessionLease, hasLiveSessionLease, projectSessionsDirectory, RunStore, type PersistedRun, type SessionLease } from "./persistence.js";

const TERMINAL_STATES = new Set<RunState>(["completed", "failed", "stopped"]);
const DAY_MS = 24 * 60 * 60 * 1000;
const REQUIRED_RUN_FILES = ["state.json", "snapshot.json", "journal.json", "ownership.json", "worktrees.json", "borrowed-worktrees.json"] as const;

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
function stringList(value: unknown, label: string): void { if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error(`${label} is invalid`); }

function validateRunRecord(run: PersistedRun): void {
  if (!object(run) || typeof run.id !== "string" || !run.id || typeof run.workflowName !== "string" || typeof run.cwd !== "string" || typeof run.sessionId !== "string" || !run.sessionId || !RUN_STATES.includes(run.state) || !Array.isArray(run.agents) || !Array.isArray(run.nativeSessions)) throw new Error("Persisted run state is invalid");
  if (run.parentRunId !== undefined && (typeof run.parentRunId !== "string" || !run.parentRunId)) throw new Error("Persisted parent run is invalid");
  if (run.retry !== undefined) {
    if (!object(run.retry) || typeof run.retry.sourceRunId !== "string" || !run.retry.sourceRunId || typeof run.retry.lineageRootRunId !== "string" || !run.retry.lineageRootRunId) throw new Error("Persisted retry provenance is invalid");
    stringList(run.retry.completedPaths, "Persisted retry completed paths"); stringList(run.retry.incompletePaths, "Persisted retry incomplete paths"); stringList(run.retry.namedWorktrees, "Persisted retry named worktrees");
    if (run.parentRunId !== run.retry.sourceRunId) throw new Error("Persisted retry parent does not match its source");
  }
}

async function validateRunArtifacts(store: RunStore): Promise<readonly { name: string; sourceRunId: string }[]> {
  for (const name of REQUIRED_RUN_FILES) await requiredFile(join(store.directory, name));
  const journal = await jsonFile(join(store.directory, "journal.json"));
  if (!object(journal) || !object(journal.completed) || (journal.awaiting !== undefined && !object(journal.awaiting)) || (journal.decisions !== undefined && !object(journal.decisions))) throw new Error("Persisted workflow journal is invalid");
  const ownership = await jsonFile(join(store.directory, "ownership.json"));
  if (!Array.isArray(ownership)) throw new Error("Persisted ownership records are invalid");
  const worktrees = await jsonFile(join(store.directory, "worktrees.json"));
  if (!Array.isArray(worktrees)) throw new Error("Persisted worktree records are invalid");
  const borrowed = await store.borrowedWorktrees();
  return borrowed.map(({ sourceRunId }) => ({ name: sourceRunId, sourceRunId }));
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
      if (loaded.run.parentRunId !== undefined) await store.validateParentRun(loaded.run.parentRunId);
      if (loaded.run.retry) await store.validateRetrySource();
      const borrowed = await validateRunArtifacts(store);
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
        const ordered = deletionOrder(current, freshPlan.candidates);
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