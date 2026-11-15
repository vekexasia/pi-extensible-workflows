import { createHash, randomUUID } from "node:crypto";
import { access, lstat, mkdir, open, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { HARD_TERMINAL_RUN_STATES, WorkflowError, type PreparedAgentConfiguration, type JsonValue, type LaunchSnapshot, type WorkflowErrorCode, type WorkflowLaunchMode, type WorkflowRunEvent, type WorkflowWorktreeOptions } from "./types.js";
import { coerceWorkflowError, errorText, isNodeError, jsonValue, loadLaunchSnapshot, object, positiveInteger, SerialLane } from "./utils.js";
import { budgetUsage } from "./budget.js";
import {
  decodeBooleanCheckpointResult, decodeBorrowedWorktreeBindings, decodeJournal, decodeLaunchSnapshot,
  decodeOwnershipRecords, decodePersistedRun, decodeSummaryProjection, decodeSystemPromptArtifact,
  decodeWorktreeReferences,
  type AwaitingCheckpoint, type BorrowedWorktreeBinding, type CompletedOperation, type EffectiveSystemPrompt,
  type Journal, type PendingWorkflowDecision, type PersistedOwnershipNode,
  type PersistedRun, type RunSummary, type RunSummaryArtifacts, type WorktreeReference, type EvidenceRecord,
} from "./decoders.js";
import { atomicJson, atomicPrettyJson, atomicWriteFile, git, gitIdentity, json, runWorktreeSetup } from "./io.js";
import { OwnedCommandCleanupError } from "./owned-process.js";
import { managedGitCommand, runManagedWorktreeCommand } from "./managed-worktree.js";
import { assertWorktreeGitEnvironment } from "./worktree-git-environment.js";
import { validateWorktreeOptions } from "./validation.js";
import { PhysicalWorktreeLease, sameWorktreeLeaseIdentity, worktreeLeaseIdentity, worktreeOwnerDirectory, type WorktreeLeaseIdentity } from "./worktree-lease.js";
import { runsDirectory, canonicalPath, canonicalDescendantPath, safePart, structuralPath } from "./paths.js";

import { legacyWorktreeAdmission, RunWorktreeCoordinator, type RunWorktreeGuard } from "./run-worktree-coordinator.js";

type MarkerReceipt = { path: string; dev: number; ino: number; bytes: string };
async function pathExists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if (isNodeError(error, "ENOENT")) return false; throw error; }
}
function isCleanupUnproven(error: unknown): error is Error & { cleanupUnproven: true } {
  return error instanceof Error && "cleanupUnproven" in error && error.cleanupUnproven === true;
}
function assertCleanupProven(marker: Record<string, unknown>): boolean {
  if (marker.cleanupUnproven === true) throw new OwnedCommandCleanupError("Managed worktree cleanup is unproven; physical resource retained");
  const tracked = marker.controlled === true || typeof marker.cleanupProven === "boolean";
  if (tracked && marker.cleanupProven !== true) throw new OwnedCommandCleanupError("Managed worktree cleanup is incomplete; controlled or supervised resource retained");
  return tracked;
}
const SYSTEM_PROMPT_STORAGE = ".system-prompts";
const SYSTEM_PROMPT_RECORDS = "records";
const SYSTEM_PROMPT_BODIES = "bodies";
const SYSTEM_PROMPT_SEQUENCE = "sequence";
const SYSTEM_PROMPT_ARTIFACT = { version: 2 as const, format: "append-only" as const, storage: SYSTEM_PROMPT_STORAGE };
function assertEvidenceIntegrity(content: Buffer, sha256: string, path: string): void {
  if (createHash("sha256").update(content).digest("hex") !== sha256) throw new WorkflowError("RESULT_INVALID", `Evidence artifact content does not match its checksum: ${path}`);
}
function summaryArtifacts(directory: string): RunSummaryArtifacts { return { runDirectory: directory, statePath: join(directory, "state.json"), journalPath: join(directory, "journal.json"), snapshotPath: join(directory, "snapshot.json"), workflowPath: join(directory, "workflow.js"), resultPath: join(directory, "result.json"), summaryPath: join(directory, "summary.json"), evidenceDirectory: join(directory, "evidence") }; }
function summaryFromRun(run: PersistedRun, directory: string, journal: Journal, previous: Partial<RunSummary> | undefined, fallbackCreatedAt: string, now = new Date().toISOString()): RunSummary {
  const createdAt = typeof previous?.createdAt === "string" ? previous.createdAt : fallbackCreatedAt;
  const failedAt = run.failedAt ?? run.error?.failedAt;
  const replayablePaths = [...new Set([...(run.retry?.completedPaths ?? []), ...Object.keys(journal.completed)])];
  const incompletePaths = [...new Set([...(run.retry?.incompletePaths ?? []), ...(failedAt ? [failedAt] : [])])];
  return { schemaVersion: 1, runId: run.id, sessionId: run.sessionId, workflowName: run.workflowName, state: run.state, createdAt, updatedAt: now, ...(previous?.terminalAt || HARD_TERMINAL_RUN_STATES.has(run.state) ? { terminalAt: previous?.terminalAt ?? now } : {}), usage: budgetUsage(run.usage), agents: run.agents.map(({ id, name, label, state, attempts }) => ({ id, name, ...(label ? { label } : {}), state, attempts })), ...(run.error ? { error: run.error } : {}), ...(failedAt ? { failedAt } : {}), replayablePaths, incompletePaths, artifacts: summaryArtifacts(directory) };
}
function systemPromptStoragePath(directory: string): string { return join(directory, SYSTEM_PROMPT_STORAGE); }
function systemPromptRecordsPath(directory: string): string { return join(systemPromptStoragePath(directory), SYSTEM_PROMPT_RECORDS); }
function systemPromptBodiesPath(directory: string): string { return join(systemPromptStoragePath(directory), SYSTEM_PROMPT_BODIES); }
function systemPromptSequencePath(directory: string): string { return join(systemPromptStoragePath(directory), SYSTEM_PROMPT_SEQUENCE); }
function systemPromptRecordName(sequence: number): string { return `${String(sequence).padStart(20, "0")}.json`; }
async function createSystemPromptStorage(directory: string, writeArtifact: boolean): Promise<void> {
  const storage = systemPromptStoragePath(directory);
  await mkdir(join(storage, SYSTEM_PROMPT_RECORDS), { recursive: true, mode: 0o700 });
  await mkdir(join(storage, SYSTEM_PROMPT_BODIES), { recursive: true, mode: 0o700 });
  await atomicWriteFile(systemPromptSequencePath(directory), "0\n");
  if (writeArtifact) await atomicJson(join(directory, "system-prompts.json"), SYSTEM_PROMPT_ARTIFACT);
}

export class RunStore {
  readonly directory: string;
  private journalLane = new SerialLane();
  // ponytail: serializes one RunStore instance; cross-process run sharing remains unsupported.
  private stateLane = new SerialLane();
  private summaryLane = new SerialLane();
  private cleanupPoison: Error | undefined;
  private readonly worktreeCoordinator: RunWorktreeCoordinator;
  private snapshotLane = new SerialLane();
  private launchSnapshotLane = new SerialLane();
  // ponytail: the session lease prevents concurrent RunStore writers for one run.
  private systemPromptLane = new SerialLane();
  constructor(readonly cwd: string, readonly sessionId: string, readonly runId: string, readonly home = homedir()) {
    this.cwd = resolve(cwd);
    this.directory = join(runsDirectory(this.cwd, sessionId, home), safePart(runId));
    this.worktreeCoordinator = new RunWorktreeCoordinator(this.directory);
  }
  #assertRunIdentity(run: PersistedRun, code: WorkflowErrorCode, message: string): void {
    if (resolve(run.cwd) !== this.cwd || run.sessionId !== this.sessionId || run.id !== this.runId) throw new WorkflowError(code, message);
  }

  async create(run: PersistedRun, snapshot: Readonly<LaunchSnapshot>): Promise<void> {
    await this.worktreeCoordinator.run(undefined, (guard) => this.#createUnderGuard(guard, run, snapshot));
  }
  #assertWorktreeGuard(guard: RunWorktreeGuard): void { guard.assertCurrent(canonicalDescendantPath(dirname(this.directory), this.directory)); }
  async #createUnderGuard(guard: RunWorktreeGuard, run: PersistedRun, snapshot: Readonly<LaunchSnapshot>): Promise<void> {
    this.#assertWorktreeGuard(guard);
    this.#assertRunIdentity(run, "INTERNAL_ERROR", "Run identity does not match its session-scoped store");
    const temporary = join(dirname(this.directory), `.${safePart(this.runId)}.${String(process.pid)}.${randomUUID()}.tmp`);
    await mkdir(dirname(this.directory), { recursive: true, mode: 0o700 });
    await mkdir(temporary, { mode: 0o700 });
    try {
      await writeFile(join(temporary, "workflow.js"), snapshot.script, { encoding: "utf8", mode: 0o600 });
      await atomicJson(join(temporary, "snapshot.json"), snapshot);
      await atomicJson(join(temporary, "journal.json"), { completed: {}, awaiting: {}, decisions: {} });
      await atomicJson(join(temporary, "ownership.json"), []);
      await atomicJson(join(temporary, "worktrees.json"), []);
      await atomicJson(join(temporary, "borrowed-worktrees.json"), []);
      await atomicJson(join(temporary, "state.json"), run);
      await createSystemPromptStorage(temporary, true);
      await atomicJson(join(temporary, "summary.json"), summaryFromRun(run, this.directory, { completed: {} }, undefined, new Date().toISOString()));
      await rename(temporary, this.directory);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }
  private async refreshSummary(): Promise<void> {
    const write = this.summaryLane.run(async () => {
      const run = decodePersistedRun(await json(join(this.directory, "state.json")), true);
      const journal = decodeJournal(await json(join(this.directory, "journal.json")));
      const previous = await json(join(this.directory, "summary.json")).then(decodeSummaryProjection).catch(() => undefined);
      if (!run || !journal) throw new Error("Persisted run or journal is invalid");
      const fallbackCreatedAt = await stat(join(this.directory, "state.json")).then((value) => new Date(value.mtimeMs).toISOString());
      await atomicJson(join(this.directory, "summary.json"), summaryFromRun(run, this.directory, journal, previous, fallbackCreatedAt));
    });
    await write;
  }
  //NOTE: summary.json is an optional derived cache (see OPTIONAL_RUN_FILES); a missed refresh self-heals because every reader (loadSummary, CLI inspector) recomputes from state/journal. Keep this best-effort so a cache hiccup never fails the primary write.
  private refreshSummaryBestEffort(): void { void this.refreshSummary().catch(() => undefined); }

  async isComplete(): Promise<boolean> {
    try { await Promise.all([access(join(this.directory, "snapshot.json")), access(join(this.directory, "journal.json")), access(join(this.directory, "ownership.json")), access(join(this.directory, "state.json"))]); return true; }
    catch { return false; }
  }

  async load(): Promise<{ run: PersistedRun; snapshot: Readonly<LaunchSnapshot> }> {
    await this.stateLane.run(async () => undefined);
    const rawRun = await json(join(this.directory, "state.json"));
    const run = decodePersistedRun(rawRun, true);
    if (!run) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted run is invalid");
    this.#assertRunIdentity(run, "RESUME_INCOMPATIBLE", "Persisted run belongs to another cwd or Pi session");
    if (!object(rawRun) || !Array.isArray(rawRun.agentSessions) || Object.hasOwn(rawRun, "nativeSessions")) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted run uses an unsupported agent session format");
    const snapshot = decodeLaunchSnapshot(await json(join(this.directory, "snapshot.json")));
    if (!snapshot) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted launch snapshot is invalid");
    return { run, snapshot: loadLaunchSnapshot(snapshot) };
  }
  async loadStatus(): Promise<PersistedRun> {
    await this.stateLane.run(async () => undefined);
    const run = decodePersistedRun(await json(join(this.directory, "state.json")), true);
    if (!run) throw new WorkflowError("RUN_NOT_FOUND", "Persisted run is invalid");
    this.#assertRunIdentity(run, "RUN_NOT_FOUND", "Persisted run does not belong to this project");
    return run;
  }
  async loadSummary(): Promise<RunSummary> {
    await this.stateLane.run(async () => undefined);
    await this.journalLane.run(async () => undefined);
    await this.summaryLane.run(async () => undefined);
    const run = decodePersistedRun(await json(join(this.directory, "state.json")), true);
    const journal = decodeJournal(await json(join(this.directory, "journal.json")));
    const previous = await json(join(this.directory, "summary.json")).then(decodeSummaryProjection).catch(() => undefined);
    if (!run || !journal) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted run or journal is invalid");
    const [stateStat, journalStat] = await Promise.all([stat(join(this.directory, "state.json")), stat(join(this.directory, "journal.json"))]);
    const fallbackCreatedAt = new Date(stateStat.mtimeMs).toISOString();
    const previousUpdatedAt = previous?.updatedAt === undefined ? Number.NaN : Date.parse(previous.updatedAt);
    const updatedAt = new Date(Math.max(stateStat.mtimeMs, journalStat.mtimeMs, Number.isNaN(previousUpdatedAt) ? 0 : previousUpdatedAt)).toISOString();
    return summaryFromRun(run, this.directory, journal, previous, fallbackCreatedAt, updatedAt);
  }

  async saveState(run: PersistedRun): Promise<void> {
    const write = this.stateLane.run(async () => {
      this.#assertRunIdentity(run, "INTERNAL_ERROR", "Run identity does not match its session-scoped store");
      await atomicJson(join(this.directory, "state.json"), run);
      this.refreshSummaryBestEffort();
    });
    await write;
  }

  async updateState(update: (run: PersistedRun) => PersistedRun | Promise<PersistedRun>): Promise<PersistedRun> {
    const write = this.stateLane.run(async () => {
      const current = decodePersistedRun(await json(join(this.directory, "state.json")));
      if (!current) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted run is invalid");
      this.#assertRunIdentity(current, "RESUME_INCOMPATIBLE", "Persisted run belongs to another cwd or Pi session");
      const result = await update(current);
      this.#assertRunIdentity(result, "INTERNAL_ERROR", "Run identity does not match its session-scoped store");
      await atomicJson(join(this.directory, "state.json"), result);
      this.refreshSummaryBestEffort();
      return result;
    });
    return write;
  }

  async saveAgentConfiguration(key: string, configuration: PreparedAgentConfiguration): Promise<void> {
    await this.launchSnapshotLane.run(async () => {
      const snapshot = decodeLaunchSnapshot(await json(join(this.directory, "snapshot.json")));
      if (!snapshot) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow launch snapshot identity version is incompatible");
      await atomicJson(join(this.directory, "snapshot.json"), { ...snapshot, agentConfigurations: { ...snapshot.agentConfigurations, [key]: configuration } });
    });
  }

  async setLaunchMode(launchMode: WorkflowLaunchMode): Promise<void> {
    await this.launchSnapshotLane.run(async () => {
      const snapshot = decodeLaunchSnapshot(await json(join(this.directory, "snapshot.json")));
      if (!snapshot) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow launch snapshot identity version is incompatible");
      await atomicJson(join(this.directory, "snapshot.json"), { ...snapshot, launchMode });
    });
  }

  async saveSnapshot(snapshot: Readonly<LaunchSnapshot>): Promise<void> {
    const write = this.launchSnapshotLane.run(() => atomicJson(join(this.directory, "snapshot.json"), snapshot));
    await write;
  }

  async appendEvent(event: WorkflowRunEvent): Promise<void> {
    await this.updateState((run) => ({ ...run, events: [...(run.events ?? []), ...(event.type !== "log" && run.events?.some((current) => current.type === event.type && current.message === event.message) ? [] : [event])] }));
  }

  async saveOwnership(nodes: readonly PersistedOwnershipNode[]): Promise<void> {
    await atomicJson(join(this.directory, "ownership.json"), nodes);
  }

  async loadOwnership(): Promise<readonly PersistedOwnershipNode[]> {
    const nodes = decodeOwnershipRecords(await json(join(this.directory, "ownership.json")));
    if (!nodes) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted ownership records are invalid");
    return nodes;
  }

  systemPromptPath(): string { return join(this.directory, "system-prompts.json"); }
  private async readSystemPromptArtifact(): Promise<{ version: number; format?: unknown; storage?: unknown; entries?: EffectiveSystemPrompt[] } | undefined> {
    try {
      const artifact = decodeSystemPromptArtifact(await json(this.systemPromptPath()));
      if (!artifact) throw new Error("Persisted system prompts are invalid");
      return artifact;
    } catch (error: unknown) {
      if (isNodeError(error, "ENOENT")) return undefined;
      throw error;
    }
  }

  private async appendSystemPromptV2(entry: Omit<EffectiveSystemPrompt, "sha256">): Promise<void> {
    const sha256 = createHash("sha256").update(entry.prompt).digest("hex");
    const bodyPath = join(systemPromptBodiesPath(this.directory), sha256);
    try { await access(bodyPath); }
    catch (error) { if (!isNodeError(error, "ENOENT")) throw error; await atomicWriteFile(bodyPath, entry.prompt); }
    const previous = Number(await readFile(systemPromptSequencePath(this.directory), "utf8"));
    if (!Number.isSafeInteger(previous) || previous < 0 || previous >= Number.MAX_SAFE_INTEGER) throw new Error("Persisted system-prompt sequence is invalid");
    const sequence = previous + 1;
    await atomicWriteFile(systemPromptSequencePath(this.directory), `${String(sequence)}\n`);
    await atomicJson(join(systemPromptRecordsPath(this.directory), systemPromptRecordName(sequence)), { sessionId: entry.sessionId, attempt: entry.attempt, turn: entry.turn, sha256 });
  }
  private async migrateSystemPrompts(legacy: { version: number; entries?: EffectiveSystemPrompt[] }): Promise<void> {
    await rm(systemPromptStoragePath(this.directory), { recursive: true, force: true });
    await createSystemPromptStorage(this.directory, false);
    for (const entry of legacy.entries ?? []) await this.appendSystemPromptV2(entry);
    await atomicJson(this.systemPromptPath(), SYSTEM_PROMPT_ARTIFACT);
  }
  private async prepareSystemPromptStorage(): Promise<void> {
    const artifact = await this.readSystemPromptArtifact();
    if (artifact === undefined) {
      await rm(systemPromptStoragePath(this.directory), { recursive: true, force: true });
      await createSystemPromptStorage(this.directory, true);
    } else if (artifact.version === 1) {
      if (!Array.isArray(artifact.entries)) throw new Error("Persisted system prompts are invalid");
      await this.migrateSystemPrompts(artifact);
    } else if (artifact.version !== SYSTEM_PROMPT_ARTIFACT.version || artifact.format !== SYSTEM_PROMPT_ARTIFACT.format || artifact.storage !== SYSTEM_PROMPT_ARTIFACT.storage) throw new Error("Persisted system prompts are invalid");
  }
  private async readSystemPromptsV2(): Promise<readonly EffectiveSystemPrompt[]> {
    const artifact = await this.readSystemPromptArtifact();
    if (!artifact || artifact.version !== SYSTEM_PROMPT_ARTIFACT.version || artifact.format !== SYSTEM_PROMPT_ARTIFACT.format || artifact.storage !== SYSTEM_PROMPT_ARTIFACT.storage) throw new Error("Persisted system prompts are invalid");
    const sequence = Number(await readFile(systemPromptSequencePath(this.directory), "utf8"));
    if (!Number.isSafeInteger(sequence) || sequence < 0) throw new Error("Persisted system-prompt sequence is invalid");
    const names = (await readdir(systemPromptRecordsPath(this.directory))).filter((name) => !name.endsWith(".tmp")).sort();
    const entries: EffectiveSystemPrompt[] = [];
    let highest = 0;
    for (const name of names) {
      const match = /^(\d{20})\.json$/.exec(name);
      if (!match) throw new Error("Persisted system-prompt records are invalid");
      const recordSequence = Number(match[1]);
      if (!Number.isSafeInteger(recordSequence) || recordSequence < 1) throw new Error("Persisted system-prompt records are invalid");
      highest = Math.max(highest, recordSequence);
      const record = await json(join(systemPromptRecordsPath(this.directory), name));
      if (!object(record)) throw new Error("Persisted system-prompt record is invalid");
      const sessionId = record.sessionId;
      const attempt = record.attempt;
      const turn = record.turn;
      const sha256 = record.sha256;
      if (typeof sessionId !== "string" || !sessionId || !positiveInteger(attempt) || !positiveInteger(turn) || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) throw new Error("Persisted system-prompt record is invalid");
      const prompt = await readFile(join(systemPromptBodiesPath(this.directory), sha256), "utf8");
      if (createHash("sha256").update(prompt).digest("hex") !== sha256) throw new Error("Persisted system-prompt body is invalid");
      entries.push({ sessionId, attempt, turn, sha256, prompt });
    }
    if (sequence < highest) throw new Error("Persisted system-prompt sequence is invalid");
    return entries;
  }
  async recordSystemPrompt(entry: Omit<EffectiveSystemPrompt, "sha256">): Promise<void> {
    const write = this.systemPromptLane.run(async () => {
      await this.prepareSystemPromptStorage();
      await this.appendSystemPromptV2(entry);
    });
    await write;
  }
  async systemPrompts(): Promise<readonly EffectiveSystemPrompt[]> {
    await this.systemPromptLane.run(async () => undefined);
    const artifact = await this.readSystemPromptArtifact();
    if (artifact === undefined) return [];
    if (artifact.version === 1) return artifact.entries ?? [];
    if (artifact.version === SYSTEM_PROMPT_ARTIFACT.version) return this.readSystemPromptsV2();
    throw new Error("Persisted system prompts are invalid");
  }

  async #decodeJournal(): Promise<Journal> {
    const journal = decodeJournal(await json(join(this.directory, "journal.json")));
    if (!journal) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted journal is invalid");
    return journal;
  }
  /** Reads the journal after every queued journal write has settled. */
  async #readJournal(): Promise<Journal> {
    await this.journalLane.run(async () => undefined);
    return this.#decodeJournal();
  }

  private async updateJournal<T>(update: (journal: Journal) => T | Promise<T>): Promise<T> {
    const write = this.journalLane.run(async () => {
      const journal = await this.#decodeJournal();
      journal.awaiting ??= {};
      const result = await update(journal);
      await atomicJson(join(this.directory, "journal.json"), journal);
      this.refreshSummaryBestEffort();
      return result;
    });
    return write;
  }

  async complete(path: string, value: JsonValue): Promise<void> {
    await this.updateJournal((journal) => {
      if (journal.completed[path]) throw new WorkflowError("DUPLICATE_NAME", `Completed structural path already exists: ${path}`);
      journal.completed[path] = { path, value };
    });
  }

  async replay(path: string): Promise<CompletedOperation | undefined> {
    const [operation] = await this.replayableOperationsFrom(new Set(), path);
    return operation;
  }

  async replayableOperations(): Promise<readonly CompletedOperation[]> {
    return this.replayableOperationsFrom(new Set());
  }

  /** Every journaled agent operation of the retry lineage, mapped to its session file when one was recorded. */
  async agentSessionFiles(): Promise<ReadonlyMap<string, string | undefined>> {
    return this.agentSessionFilesFrom(new Set());
  }

  private async agentSessionFilesFrom(seen: Set<string>): Promise<ReadonlyMap<string, string | undefined>> {
    if (seen.has(this.runId)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Retry provenance contains a cycle");
    const nextSeen = new Set(seen);
    nextSeen.add(this.runId);
    const loaded = await this.load();
    const files = new Map<string, string | undefined>();
    if (loaded.run.retry?.sourceRunId) {
      const source = await this.sourceRun(loaded.run.retry.sourceRunId);
      for (const [path, file] of await source.agentSessionFilesFrom(nextSeen)) files.set(path, file);
    }
    const journal = await this.#readJournal();
    for (const agent of loaded.run.agents) {
      // Only a journaled operation completed: an attempt a dying host left running records no error either.
      if (!agent.resultPath || !journal.completed[agent.resultPath]) continue;
      // Failed attempts of that operation also record a session; their partial transcript must never be the source.
      const locator = agent.attemptDetails?.filter((detail) => !detail.error).at(-1)?.session?.locator;
      files.set(agent.resultPath, object(locator) && typeof locator.sessionFile === "string" ? locator.sessionFile : undefined);
    }
    return files;
  }

  /** Source lineage first, own journal last (it overrides); `path` narrows to one operation without cloning the rest. */
  private async replayableOperationsFrom(seen: Set<string>, path?: string): Promise<readonly CompletedOperation[]> {
    if (seen.has(this.runId)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Retry provenance contains a cycle");
    const nextSeen = new Set(seen);
    nextSeen.add(this.runId);
    const loaded = await this.load();
    const operations = new Map<string, CompletedOperation>();
    if (loaded.run.retry?.sourceRunId) {
      const source = await this.sourceRun(loaded.run.retry.sourceRunId);
      for (const operation of await source.replayableOperationsFrom(nextSeen, path)) operations.set(operation.path, operation);
    }
    const journal = await this.#readJournal();
    for (const operation of Object.values(journal.completed)) if (path === undefined || operation.path === path) operations.set(operation.path, operation);
    return [...operations.values()].map((operation) => structuredClone(operation));
  }

  async awaitCheckpoint(checkpoint: AwaitingCheckpoint): Promise<boolean | undefined> {
    const replayed = await this.replay(checkpoint.path);
    if (replayed) {
      const result = decodeBooleanCheckpointResult(replayed.value);
      if (result === undefined) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted checkpoint result is invalid");
      return result;
    }
    return this.updateJournal((journal) => {
      const completed = journal.completed[checkpoint.path];
      if (completed) {
        const result = decodeBooleanCheckpointResult(completed.value);
        if (result === undefined) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted checkpoint result is invalid");
        return result;
      }
      const awaiting = journal.awaiting ?? (journal.awaiting = {});
      awaiting[checkpoint.path] = checkpoint;
      return undefined;
    });
  }

  async awaitingCheckpoints(): Promise<readonly AwaitingCheckpoint[]> {
    return Object.values((await this.#readJournal()).awaiting ?? {});
  }
  async requestWorkflowDecision(request: PendingWorkflowDecision): Promise<void> {
    await this.updateJournal((journal) => { journal.decisions ??= {}; journal.decisions[request.proposalId] = request; });
  }
  async pendingWorkflowDecisions(): Promise<readonly PendingWorkflowDecision[]> {
    return Object.values((await this.#readJournal()).decisions ?? {});
  }
  async answerWorkflowDecision(proposalId: string, approved: boolean): Promise<PendingWorkflowDecision | undefined> {
    return this.updateJournal((journal) => {
      const request = journal.decisions?.[proposalId];
      if (!request) return undefined;
      journal.completed[`decision/${proposalId}`] = { path: `decision/${proposalId}`, value: approved };
      delete journal.decisions?.[proposalId];
      return request;
    });
  }

  async answerCheckpoint(name: string, approved: boolean): Promise<AwaitingCheckpoint | undefined> {
    return this.updateJournal((journal) => {
      const checkpoint = Object.values(journal.awaiting ?? {}).find((item) => item.name === name);
      if (!checkpoint || journal.completed[checkpoint.path]) return undefined;
      journal.completed[checkpoint.path] = { path: checkpoint.path, value: approved };
      journal.awaiting = Object.fromEntries(Object.entries(journal.awaiting ?? {}).filter(([path]) => path !== checkpoint.path));
      return checkpoint;
    });
  }

  #worktreeKey(owner: string): string { return createHash("sha256").update(`${this.sessionId}\0${this.runId}\0${owner}`).digest("hex").slice(0, 16); }

  private expectedWorktree(owner: string): Pick<WorktreeReference, "path" | "branch"> {
    const key = this.#worktreeKey(owner);
    return { path: join(this.directory, "worktrees", key), branch: `pi-extensible-workflows/${safePart(this.runId)}/${key}` };
  }

  private markerPath(owner: string): string { return join(this.directory, `worktree-${this.#worktreeKey(owner)}.creating`); }

  private namedWorktreeOwner(name: string): string {
    if (!name.trim()) throw new WorkflowError("WORKTREE_FAILED", "Named worktree names must be non-empty");
    return structuralPath("worktree", "named", name.trim());
  }

  private worktreeName(owner: string): string | undefined {
    const prefix = `${structuralPath("worktree", "named")}/`;
    if (!owner.startsWith(prefix)) return undefined;
    const encoded = owner.slice(prefix.length);
    if (!encoded || encoded.includes("/")) return undefined;
    try {
      const name = decodeURIComponent(encoded);
      return name.trim() ? name : undefined;
    } catch {
      return undefined;
    }
  }

  private structuralWorktree(owner: string, record: WorktreeReference): WorktreeReference {
    const expected = this.expectedWorktree(owner);
    const relativePath = relative(this.directory, record.path);
    const relativeCwd = relative(record.path, record.cwd);
    if (record.owner !== owner || resolve(record.path) !== expected.path || record.branch !== expected.branch || relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`)) throw new Error(`Invalid worktree record for ${owner}`);
    return record;
  }

  async #loadWorktreeRecords(missingOk = true): Promise<WorktreeReference[]> {
    const rawRecords = await json(join(this.directory, "worktrees.json")).catch((error: unknown) => { if (missingOk && isNodeError(error, "ENOENT")) return []; throw error; });
    const records = decodeWorktreeReferences(rawRecords);
    if (!records) throw new WorkflowError("WORKTREE_FAILED", "Worktree records are invalid");
    return records;
  }

  async #updateWorktreeRecordsUnderGuard(guard: RunWorktreeGuard, update: (records: WorktreeReference[]) => readonly WorktreeReference[]): Promise<void> {
    this.#assertWorktreeGuard(guard);
    const records = await this.#loadWorktreeRecords(false);
    await atomicJson(join(this.directory, "worktrees.json"), update(records));
  }

  private async borrowedWorktreeRecords(): Promise<readonly BorrowedWorktreeBinding[]> {
    const rawRecords = await json(join(this.directory, "borrowed-worktrees.json")).catch((error: unknown) => { if (isNodeError(error, "ENOENT")) return []; throw error; });
    const records = decodeBorrowedWorktreeBindings(rawRecords);
    if (!records) throw new WorkflowError("WORKTREE_FAILED", "Borrowed worktree bindings are invalid");
    const seen = new Set<string>();
    return records.map((candidate) => {
      if (!candidate.name.trim() || candidate.name !== candidate.name.trim() || !candidate.sourceRunId || candidate.owner !== this.namedWorktreeOwner(candidate.name)) throw new WorkflowError("WORKTREE_FAILED", "Borrowed worktree binding is invalid");
      if (seen.has(candidate.name)) throw new WorkflowError("WORKTREE_FAILED", `Duplicate borrowed worktree binding for ${candidate.name}`);
      seen.add(candidate.name);
      return candidate;
    });
  }
  async borrowedWorktrees(): Promise<readonly BorrowedWorktreeBinding[]> { return this.borrowedWorktreeRecords(); }

  private async borrowedWorktree(name: string): Promise<BorrowedWorktreeBinding | undefined> {
    return (await this.borrowedWorktreeRecords()).find((binding) => binding.name === name);
  }

  private async sourceRun(sourceRunId: string): Promise<RunStore> {
    if (!sourceRunId || sourceRunId === this.runId) throw new WorkflowError("WORKTREE_FAILED", "Borrowed worktree source run is invalid");
    const source = new RunStore(this.cwd, this.sessionId, sourceRunId, this.home);
    try {
      const loaded = await source.load();
      if (!HARD_TERMINAL_RUN_STATES.has(loaded.run.state)) throw new Error(`Source run ${sourceRunId} is not terminal`);
      return source;
    } catch (error) {
      throw coerceWorkflowError("WORKTREE_FAILED", error);
    }
  }

  async validateParentRun(parentRunId: string): Promise<void> { await this.sourceRun(parentRunId); }
  async validateRetrySource(): Promise<void> {
    const validate = async (current: RunStore, seen: Set<string>): Promise<void> => {
      if (seen.has(current.runId)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Retry provenance contains a cycle");
      const nextSeen = new Set(seen);
      nextSeen.add(current.runId);
      const loaded = await current.load();
      const retry = loaded.run.retry;
      if (!retry) return;
      // decodeRetry() already guarantees the field shapes; only the semantic constraints remain to check here.
      if (!retry.sourceRunId || retry.sourceRunId === current.runId || !retry.lineageRootRunId) throw new WorkflowError("RESUME_INCOMPATIBLE", "Retry provenance is incomplete");
      const source = await current.sourceRun(retry.sourceRunId);
      const sourceRun = (await source.load()).run;
      if (loaded.run.parentRunId !== retry.sourceRunId) throw new WorkflowError("RESUME_INCOMPATIBLE", "Retry parent run does not match its source run");
      if (sourceRun.state !== "failed") throw new WorkflowError("RESUME_INCOMPATIBLE", `Retry source run ${retry.sourceRunId} is not failed`);
      const expectedLineageRoot = sourceRun.retry?.lineageRootRunId ?? sourceRun.id;
      if (retry.lineageRootRunId !== expectedLineageRoot) throw new WorkflowError("RESUME_INCOMPATIBLE", "Retry lineage root does not match its source run");
      await validate(source, nextSeen);
    };
    try { await validate(this, new Set()); }
    catch (error) { throw coerceWorkflowError("RESUME_INCOMPATIBLE", error); }
  }

  private async ownedWorktree(owner: string, cwd?: string, requireDirectory = true): Promise<WorktreeReference> {
    if (this.cleanupPoison) throw this.cleanupPoison;
    const records = await this.#loadWorktreeRecords(false);
    const matches = records.filter((candidate) => candidate.owner === owner);
    if (matches.length !== 1) throw new Error(`Missing or duplicate worktree record for ${owner}`);
    const record = matches[0];
    if (!record) throw new Error(`Missing or duplicate worktree record for ${owner}`);
    const validated = this.structuralWorktree(owner, record);
    const marker = await json(this.markerPath(owner)).catch((error: unknown) => { if (isNodeError(error, "ENOENT")) return undefined; throw error; });
    if (marker !== undefined) {
      if (!object(marker)) throw new WorkflowError("WORKTREE_FAILED", "Managed creation marker is malformed");
      assertCleanupProven(marker);
    }
    if (cwd !== undefined && resolve(cwd) !== resolve(validated.cwd)) throw new Error(`Invalid worktree record for ${owner}`);
    if (requireDirectory) await access(validated.cwd);
    return validated;
  }

  private async resolveBorrowedWorktree(binding: BorrowedWorktreeBinding, seen: Set<string>, requireDirectory = true): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string }> {
    try {
      const source = await this.sourceRun(binding.sourceRunId);
      const resolved = await source.findNamedWorktree(binding.name, seen, requireDirectory);
      if (!resolved) throw new Error(`Missing named worktree ${binding.name} in source run ${binding.sourceRunId}`);
      if (resolved.owner !== binding.owner) throw new Error(`Borrowed worktree binding does not match source owner for ${binding.name}`);
      return resolved;
    } catch (error) {
      if (isCleanupUnproven(error)) throw error;
      throw coerceWorkflowError("WORKTREE_FAILED", error);
    }
  }

  private async findNamedWorktree(name: string, seen: Set<string> = new Set(), requireDirectory = true): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string } | undefined> {
    const owner = this.namedWorktreeOwner(name);
    if (seen.has(this.runId)) throw new WorkflowError("WORKTREE_FAILED", "Borrowed worktree bindings contain a cycle");
    const nextSeen = new Set(seen);
    nextSeen.add(this.runId);
    const binding = await this.borrowedWorktree(name);
    if (binding) {
      const loaded = await this.load();
      if (loaded.run.parentRunId === undefined) throw new WorkflowError("WORKTREE_FAILED", `Borrowed worktree ${name} has no parent run`);
      const parent = await this.sourceRun(loaded.run.parentRunId);
      const resolved = await parent.findNamedWorktree(name, nextSeen, requireDirectory);
      if (!resolved || resolved.sourceRunId !== binding.sourceRunId || resolved.owner !== binding.owner) throw new WorkflowError("WORKTREE_FAILED", `Borrowed worktree binding for ${name} is not inherited from its parent run`);
      return resolved;
    }
    const records = await this.#loadWorktreeRecords(false);
    const matches = records.filter((candidate) => candidate.owner === owner);
    if (matches.length === 0) {
      const loaded = await this.load();
      if (loaded.run.parentRunId === undefined) return undefined;
      const parent = await this.sourceRun(loaded.run.parentRunId);
      return parent.findNamedWorktree(name, nextSeen, requireDirectory);
    }
    try {
      const reference = await this.ownedWorktree(owner, undefined, requireDirectory);
      return { reference, sourceRunId: this.runId, owner };
    } catch (error) {
      if (isCleanupUnproven(error)) throw error;
      throw coerceWorkflowError("WORKTREE_FAILED", error);
    }
  }

  async resolveNamedWorktree(name: string, seen: Set<string> = new Set()): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string }> {
    const resolved = await this.findNamedWorktree(name, seen);
    if (!resolved) throw new WorkflowError("WORKTREE_FAILED", `Missing named worktree ${name}`);
    return resolved;
  }
  async validateDeletionWorktrees(): Promise<void> {
    try { await this.validateWorktreeInventory(await this.#loadWorktreeRecords(false)); }
    catch (error) { throw coerceWorkflowError("WORKTREE_FAILED", error); }
  }

  private async validateWorktreeInventory(records: readonly WorktreeReference[]): Promise<void> {
    try {
      const owners = new Set<string>();
      const paths = new Set<string>();
      for (const record of records) {
        const owner = record.owner;
        if (owners.has(owner)) throw new Error(`Duplicate worktree record for ${owner}`);
        owners.add(owner);
        const reference = this.structuralWorktree(owner, record);
        paths.add(resolve(reference.path));
      }
      const entries = await readdir(join(this.directory, "worktrees"), { withFileTypes: true }).catch((error: unknown) => { if (isNodeError(error, "ENOENT")) return [] as import("node:fs").Dirent[]; throw error; });
      for (const entry of entries) if (!entry.isDirectory() || entry.isSymbolicLink() || !paths.has(resolve(join(this.directory, "worktrees", entry.name)))) throw new Error(`Unrecorded worktree artifact: ${join(this.directory, "worktrees", entry.name)}`);
    } catch (error) { throw coerceWorkflowError("WORKTREE_FAILED", error); }
  }

  /** With requireDirectory false only the bindings are checked: deletion treats a worktree directory removed by hand as already cleaned up. */
  async validateBorrowedWorktrees(requireDirectory = true): Promise<void> {
    try {
      const loaded = await this.load();
      if (loaded.run.parentRunId !== undefined) await this.validateParentRun(loaded.run.parentRunId);
      for (const binding of await this.borrowedWorktreeRecords()) await this.resolveBorrowedWorktree(binding, new Set([this.runId]), requireDirectory);
    } catch (error) {
      if (isCleanupUnproven(error)) throw error;
      throw coerceWorkflowError("WORKTREE_FAILED", error);
    }
  }
  async validateNamedWorktrees(): Promise<void> {
    try {
      const records = await this.#loadWorktreeRecords(false);
      for (const record of records) {
        const owner = record.owner;
        if (this.worktreeName(owner)) await this.validateWorktree(owner);
      }
    } catch (error) {
      if (isCleanupUnproven(error)) throw error;
      throw coerceWorkflowError("WORKTREE_FAILED", error);
    }
  }

  async ownsWorktree(owner: string): Promise<boolean> {
    const records = await this.#loadWorktreeRecords(false);
    return records.filter((candidate) => candidate.owner === owner).length === 1;
  }

  private async resourceIdentity(resource: { owner: string; path: string; branch: string; resourceIdentity?: WorktreeLeaseIdentity }): Promise<WorktreeLeaseIdentity> {
    const expected = this.expectedWorktree(resource.owner);
    if (resource.path !== expected.path || resource.branch !== expected.branch) throw new WorkflowError("WORKTREE_FAILED", "Managed resource binding changed");
    const project = await worktreeLeaseIdentity(this.cwd);
    const identity = resource.resourceIdentity ?? await worktreeLeaseIdentity(resource.path);
    const child = relative(join(project.commonGitDirectory, "worktrees"), identity.gitDirectory);
    if (identity.path !== canonicalDescendantPath(this.directory, expected.path) || identity.commonGitDirectory !== project.commonGitDirectory || canonicalPath(identity.gitDirectory) !== identity.gitDirectory || !child || child === ".." || child.includes(sep)) throw new WorkflowError("WORKTREE_FAILED", "Persisted managed resource identity does not match this project/worktree");
    return identity;
  }

  private async claimResource(resource: { owner: string; path: string; branch: string; resourceIdentity?: WorktreeLeaseIdentity }): Promise<PhysicalWorktreeLease> {
    const identity = await this.resourceIdentity(resource);
    return PhysicalWorktreeLease.acquire(identity, { runId: this.runId, sessionId: this.sessionId, executionId: randomUUID() }, "cleanup");
  }

  async #readMarker(guard: RunWorktreeGuard, path: string): Promise<MarkerReceipt> {
    this.#assertWorktreeGuard(guard);
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new WorkflowError("WORKTREE_FAILED", "Managed marker is not a regular file");
    const bytes = await readFile(path, "utf8");
    const receipt = { path, dev: info.dev, ino: info.ino, bytes };
    await this.#verifyMarker(guard, receipt);
    return receipt;
  }
  async #verifyMarker(guard: RunWorktreeGuard, receipt: MarkerReceipt): Promise<void> {
    this.#assertWorktreeGuard(guard);
    const info = await lstat(receipt.path);
    if (!info.isFile() || info.isSymbolicLink() || info.dev !== receipt.dev || info.ino !== receipt.ino || await readFile(receipt.path, "utf8") !== receipt.bytes) throw new OwnedCommandCleanupError("Managed marker attempt identity changed");
  }
  async #createMarker(guard: RunWorktreeGuard, path: string, marker: Record<string, unknown>): Promise<MarkerReceipt> {
    this.#assertWorktreeGuard(guard);
    const file = await open(path, "wx", 0o600);
    try {
      try {
        const info = await file.stat();
        const bytes = `${JSON.stringify(marker)}\n`;
        await file.writeFile(bytes);
        const receipt = { path, dev: info.dev, ino: info.ino, bytes };
        await this.#verifyMarker(guard, receipt);
        return receipt;
      } finally { await file.close(); }
    } catch (error) {
      const failure = Object.assign(new OwnedCommandCleanupError("Managed marker initial write is incomplete"), { cause: error });
      guard.retain(failure);
      throw failure;
    }
  }
  async #replaceMarker(guard: RunWorktreeGuard, receipt: MarkerReceipt, marker: Record<string, unknown>): Promise<void> {
    try {
      await this.#verifyMarker(guard, receipt);
      const bytes = `${JSON.stringify(marker)}\n`;
      await atomicWriteFile(receipt.path, bytes);
      const next = await this.#readMarker(guard, receipt.path);
      if (next.bytes !== bytes) throw new Error("Marker replacement readback changed");
      Object.assign(receipt, next);
    } catch (error) {
      // An unchanged receipt proves the replacement did not publish; the caller may settle its own reservation.
      try { await this.#verifyMarker(guard, receipt); }
      catch {
        const failure = Object.assign(new OwnedCommandCleanupError(`Managed marker replacement is unproven: ${errorText(error)}`), { cause: error });
        guard.retain(failure);
        throw failure;
      }
      throw error;
    }
  }
  async #removeMarker(guard: RunWorktreeGuard, receipt: MarkerReceipt): Promise<void> {
    await this.#verifyMarker(guard, receipt);
    await rm(receipt.path);
  }

  private async cleanupResource(guard: RunWorktreeGuard, resource: WorktreeReference, markerPath: string, source: "marker" | "record", work: () => Promise<void>, complete: () => Promise<void>): Promise<void> {
    this.#assertWorktreeGuard(guard);
    const owner = await this.claimResource(resource);
    const intent = { ...resource, resourceIdentity: owner.identity, controlled: resource.controls !== undefined, cleanupProven: false };
    let current: unknown;
    let receipt: MarkerReceipt | undefined;
    try {
      if (source === "marker") receipt = await this.#readMarker(guard, markerPath);
      current = source === "record" ? (await this.#loadWorktreeRecords(false)).find((record) => record.owner === resource.owner) : JSON.parse(receipt?.bytes ?? "null") as unknown;
    } catch { return this.retainCleanupUnproven(guard, receipt, intent, new OwnedCommandCleanupError("Managed cleanup record revalidation is unproven")); }
    if (!object(current) || current.owner !== resource.owner || current.path !== resource.path || current.branch !== resource.branch || current.base !== resource.base || current.resourceIdentity !== undefined && (!object(current.resourceIdentity) || !sameWorktreeLeaseIdentity(current.resourceIdentity as unknown as WorktreeLeaseIdentity, owner.identity))) {
      try { await owner.release(); }
      catch { return this.retainCleanupUnproven(guard, receipt, intent, new OwnedCommandCleanupError("Rejected cleanup claim could not be safely released")); }
      throw new WorkflowError("WORKTREE_FAILED", "Managed cleanup record changed before admission");
    }
    try {
      if (!receipt) receipt = await this.#createMarker(guard, markerPath, intent);
      await this.#replaceMarker(guard, receipt, intent);
    } catch (error) {
      if (isCleanupUnproven(error)) return this.retainCleanupUnproven(guard, receipt, intent, error);
      try {
        if (receipt) { await this.#verifyMarker(guard, receipt); if (source === "record") await this.#removeMarker(guard, receipt); }
        await owner.release();
      } catch { return this.retainCleanupUnproven(guard, receipt, intent, new OwnedCommandCleanupError("Rejected cleanup intent could not be safely rolled back")); }
      throw error;
    }
    try {
      await work();
      await this.proveCleanup(guard, receipt, intent);
      await complete();
      await this.#removeMarker(guard, receipt);
      await owner.release();
    } catch (error) {
      if (this.hasCleanupPoison(error)) throw error;
      const typed = isCleanupUnproven(error) ? error : new OwnedCommandCleanupError(`Managed cleanup transaction did not finish: ${errorText(error)}`);
      return this.retainCleanupUnproven(guard, receipt, intent, typed);
    }
  }

  private hasCleanupPoison(error: unknown): boolean { return this.cleanupPoison === error; }

  private async retainCleanupUnproven(guard: RunWorktreeGuard, receipt: MarkerReceipt | undefined, marker: Record<string, unknown>, error: Error): Promise<never> {
    this.cleanupPoison = error;
    guard.retain(error);
    try { if (receipt) await this.#replaceMarker(guard, receipt, { ...marker, cleanupProven: false, cleanupUnproven: true }); }
    catch { /* Never overwrite a marker whose receipt no longer proves this attempt. */ }
    throw error;
  }

  private async proveCleanup(guard: RunWorktreeGuard, receipt: MarkerReceipt, marker: Record<string, unknown>): Promise<void> {
    try { await this.#replaceMarker(guard, receipt, { ...marker, cleanupProven: true }); }
    catch { await this.retainCleanupUnproven(guard, receipt, marker, new OwnedCommandCleanupError("Managed worktree cleanup proof could not be persisted")); }
  }

  private async cleanupMarker(guard: RunWorktreeGuard, markerPath: string, deleting = false): Promise<void> {
    if (!await pathExists(markerPath)) return;
    const receipt = await this.#readMarker(guard, markerPath);
    const parsed: unknown = JSON.parse(receipt.bytes);
    if (!object(parsed) || typeof parsed.owner !== "string" || typeof parsed.base !== "string") throw new WorkflowError("WORKTREE_FAILED", "Managed creation marker is malformed");
    const marker = parsed;
    const expected = this.expectedWorktree(parsed.owner);
    if (marker.path !== expected.path || marker.branch !== expected.branch) throw new WorkflowError("WORKTREE_FAILED", "Managed creation marker binding changed");
    assertWorktreeGitEnvironment();
    assertCleanupProven(marker);
    if ((marker.fresh === true || marker.controlled === true) && !deleting) throw new WorkflowError("WORKTREE_FAILED", "Controlled or fresh worktree scope was already attempted; explicit recovery is required");
    const rootExists = await pathExists(expected.path);
    if (!rootExists && marker.resourceIdentity === undefined && marker.controlled !== true) {
      const entries = await git(this.cwd, ["worktree", "list", "--porcelain"]);
      if (entries.split("\n").some((line) => line.startsWith("worktree ") && canonicalPath(line.slice(9)) === canonicalPath(expected.path))) throw new WorkflowError("WORKTREE_FAILED", "Missing worktree resource identity requires explicit recovery");
      const base = (await git(this.cwd, ["rev-parse", "--verify", `${expected.branch}^{commit}`]).catch(() => "")).trim();
      if (base === marker.base) await git(this.cwd, ["branch", "-D", expected.branch]);
      await this.#removeMarker(guard, receipt);
      return;
    }
    const resource: WorktreeReference = { owner: parsed.owner, path: expected.path, branch: expected.branch, cwd: expected.path, base: parsed.base,
      ...(marker.controlled === true ? { controls: object(marker.controls) ? marker.controls : {} } : {}),
      ...(marker.resourceIdentity === undefined ? {} : { resourceIdentity: marker.resourceIdentity as WorktreeLeaseIdentity }) };
    // After proven completion, a missing root AND metadata allow only local bookkeeping, never Git or owner deletion.
    if (marker.cleanupProven === true && resource.resourceIdentity && !await pathExists(resource.path) && !await pathExists(resource.resourceIdentity.gitDirectory)) {
      const identity = await this.resourceIdentity(resource);
      const claimed = await pathExists(worktreeOwnerDirectory(identity));
      if (claimed) throw new WorkflowError("WORKTREE_FAILED", "Managed resource still has a physical owner");
      await this.#removeMarker(guard, receipt);
      return;
    }
    const cleanupGit = async (args: readonly string[]) => {
      try { return marker.controlled === true || process.platform === "darwin" || process.platform === "linux" ? await runManagedWorktreeCommand(managedGitCommand(marker.controlled === true ? args : ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args]), this.cwd, new AbortController().signal) : await git(this.cwd, args); }
      catch (error) { if (isCleanupUnproven(error)) throw error; return ""; }
    };
    await this.cleanupResource(guard, resource, markerPath, "marker", async () => {
      const branchBase = (await cleanupGit(["rev-parse", "--verify", `${resource.branch}^{commit}`])).trim();
      if (branchBase !== resource.base) throw new WorkflowError("WORKTREE_FAILED", "Managed cleanup branch identity changed");
      await cleanupGit(["worktree", "remove", "--force", resource.path]);
      await cleanupGit(["branch", "-D", resource.branch]);
      await rm(resource.path, { recursive: true, force: true });
    }, async () => undefined);
  }

  private async cleanupOrphanWorktrees(guard: RunWorktreeGuard): Promise<void> {
    const entries = await readdir(this.directory).catch((error: unknown) => { if (isNodeError(error, "ENOENT")) return []; throw error; });
    for (const entry of entries.filter((name) => name.endsWith(".creating"))) await this.cleanupMarker(guard, join(this.directory, entry), true);
  }

  async validateWorktree(owner: string, cwd?: string): Promise<WorktreeReference> {
    try {
      await this.load();
      const name = this.worktreeName(owner);
      const binding = name ? await this.borrowedWorktree(name) : undefined;
      if (binding) {
        const resolved = await this.resolveBorrowedWorktree(binding, new Set([this.runId]));
        if (cwd !== undefined && resolve(cwd) !== resolve(resolved.reference.cwd)) throw new Error(`Invalid worktree record for ${owner}`);
        return resolved.reference;
      }
      return await this.ownedWorktree(owner, cwd);
    } catch (error) {
      if (isCleanupUnproven(error)) throw error;
      throw coerceWorkflowError("WORKTREE_FAILED", error);
    }
  }

  async worktree(owner: string, rawOptions?: WorkflowWorktreeOptions, signal?: AbortSignal): Promise<WorktreeReference> {
    return this.worktreeCoordinator.run(signal, (guard) => this.#worktreeUnderGuard(guard, owner, rawOptions, signal, signal));
  }
  // Host-only legacy resolver admission: cancellation fences the queue without changing legacy setup policy.
  async [legacyWorktreeAdmission](owner: string, admissionSignal?: AbortSignal): Promise<WorktreeReference> {
    return this.worktreeCoordinator.run(admissionSignal, (guard) => this.#worktreeUnderGuard(guard, owner, undefined, admissionSignal, undefined));
  }
  async #worktreeUnderGuard(guard: RunWorktreeGuard, owner: string, rawOptions: WorkflowWorktreeOptions | undefined, admissionSignal: AbortSignal | undefined, signal: AbortSignal | undefined): Promise<WorktreeReference> {
    this.#assertWorktreeGuard(guard);
    if (this.cleanupPoison) throw this.cleanupPoison;
    const options = validateWorktreeOptions(rawOptions);
    const controlled = rawOptions !== undefined;
    if (controlled) assertWorktreeGitEnvironment();
    const ownedPlatform = process.platform === "darwin" || process.platform === "linux";
    // A signal requests conservative supervision, not ownership authority; only the external claim grants that.
    const supervised = controlled || signal !== undefined && ownedPlatform;
    let materializationClaimed = false;
    const runGit = (cwd: string, args: readonly string[], cleanup = false) => supervised || materializationClaimed && ownedPlatform
      ? runManagedWorktreeCommand(managedGitCommand(controlled ? args : ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args]), cwd, cleanup ? new AbortController().signal : signal ?? new AbortController().signal)
      : git(cwd, args);
    const verifyTip = async (reference: WorktreeReference) => {
      if (options.expectedTip && (await runGit(reference.path, ["rev-parse", "--verify", "HEAD^{commit}"])).trim() !== options.expectedTip) throw new WorkflowError("WORKTREE_FAILED", "Managed worktree HEAD does not equal expectedTip");
      return reference;
    };
    if (admissionSignal?.aborted) throw new WorkflowError("CANCELLED", "Worktree creation cancelled");
    const loaded = await this.load();
    const records = await this.#loadWorktreeRecords(false);
    const name = this.worktreeName(owner);
    const binding = name ? await this.borrowedWorktree(name) : undefined;
    if (binding) {
      if (options.fresh) throw new WorkflowError("WORKTREE_FAILED", "Fresh worktree rejects an existing borrowed scope");
      return verifyTip((await this.resolveBorrowedWorktree(binding, new Set([this.runId]))).reference);
    }
    if (name && loaded.run.parentRunId !== undefined) {
      const resolved = await this.resolveNamedWorktreeFromParent(name, loaded.run.parentRunId);
      if (resolved) {
        if (options.fresh) throw new WorkflowError("WORKTREE_FAILED", "Fresh worktree rejects an inherited scope");
        await this.bindBorrowedWorktree(guard, { name, sourceRunId: resolved.sourceRunId, owner: resolved.owner });
        return verifyTip(resolved.reference);
      }
    }
    if (name && Array.isArray(loaded.run.retry?.namedWorktrees) && loaded.run.retry.namedWorktrees.includes(name)) throw new WorkflowError("WORKTREE_FAILED", `Missing inherited named worktree ${name}`);
    const existing = records.find((record) => record.owner === owner);
    if (existing) {
      if (options.fresh) throw new WorkflowError("WORKTREE_FAILED", "Fresh worktree rejects an existing used scope");
      if (options.setup !== undefined && existing.controls?.setup !== undefined && options.setup !== existing.controls.setup) throw new WorkflowError("WORKTREE_FAILED", "Managed worktree setup policy cannot change");
      return verifyTip(await this.validateWorktree(owner));
    }
    const { path, branch } = this.expectedWorktree(owner);
    const markerPath = this.markerPath(owner);
    let branchCreated = false;
    let worktreeCreated = false;
    let pathExistedBeforeAdd = false;
    const attemptId = randomUUID();
    let markerReceipt: MarkerReceipt | undefined;
    let creation: Record<string, unknown> | undefined;
    let materializationOwner: PhysicalWorktreeLease | undefined;
    let resourceIdentity: WorktreeLeaseIdentity | undefined;
    try {
      const root = (await runGit(this.cwd, ["rev-parse", "--show-toplevel"])).trim();
      const [canonicalRoot, canonicalCwd] = [canonicalPath(root), canonicalPath(this.cwd)];
      const launchRelative = relative(canonicalRoot, canonicalCwd);
      if (launchRelative === ".." || launchRelative.startsWith(`..${sep}`)) throw new Error("launch cwd is outside the repository");
      if (options.fresh) {
        const used = await pathExists(markerPath);
        const artifact = await pathExists(path);
        const branchExists = await runGit(root, ["show-ref", "--verify", `refs/heads/${branch}`]).then(() => true).catch((error: unknown) => { if (!(error instanceof WorkflowError) || error.code !== "WORKTREE_FAILED") throw error; return false; });
        if (used || artifact || branchExists) throw new WorkflowError("WORKTREE_FAILED", "Fresh worktree rejects an existing or used scope");
      } else await this.cleanupMarker(guard, markerPath);
      const dirty = (await runGit(root, ["status", "--porcelain", "--untracked-files=normal"])).trim();
      if (dirty) {
        const dirtyPaths = dirty.split("\n").filter(Boolean).map((entry) => entry.slice(3));
        const shownPaths = dirtyPaths.slice(0, 10);
        const more = dirtyPaths.length > shownPaths.length ? `, and ${String(dirtyPaths.length - shownPaths.length)} more` : "";
        throw new Error(`repository ${root} has uncommitted changes at worktree creation; commit or stash them first: ${shownPaths.join(", ")}${more}`);
      }
      let commit: string;
      try {
        commit = (await runGit(root, ["rev-parse", "--verify", `${options.expectedTip ?? "HEAD"}^{commit}`])).trim();
        if (options.expectedTip && commit !== options.expectedTip) throw new Error("expectedTip does not identify the exact commit");
      } catch (error) {
        if (error instanceof WorkflowError && error.code !== "WORKTREE_FAILED") throw error;
        throw new Error(options.expectedTip ? "expectedTip commit is missing or invalid" : "repository has no commits", { cause: error });
      }
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const record: WorktreeReference = { owner, path, branch, cwd: join(path, launchRelative), base: commit, ...(controlled ? { controls: { ...options, setup: options.setup ?? "configured" as const } } : {}) };
      creation = { owner, path, branch, base: commit, controlled, ...(supervised ? { cleanupProven: false } : {}), ...(controlled ? { controls: record.controls } : {}), ...(options.fresh ? { fresh: true } : {}) };
      markerReceipt = await this.#createMarker(guard, markerPath, creation);
      await runGit(root, ["branch", branch, commit]);
      branchCreated = true;
      pathExistedBeforeAdd = await pathExists(path);
      await runGit(root, ["worktree", "add", "--no-checkout", path, branch]);
      worktreeCreated = true;
      resourceIdentity = await this.resourceIdentity(record);
      materializationOwner = await this.claimResource({ ...record, resourceIdentity });
      materializationClaimed = true;
      record.resourceIdentity = materializationOwner.identity;
      creation = { ...creation, resourceIdentity: materializationOwner.identity, cleanupProven: false };
      try { await this.#replaceMarker(guard, markerReceipt, creation); }
      catch { await this.retainCleanupUnproven(guard, markerReceipt, creation, new OwnedCommandCleanupError("Managed creation identity could not be persisted")); }
      await runGit(path, controlled ? ["checkout", branch] : ["checkout", "--force", branch]);
      await verifyTip(record);
      // Only a physically new worktree runs the launch's setup; existing, borrowed, and inherited worktrees returned above.
      const setup = loaded.snapshot.settings.worktreeSetup;
      if (options.setup !== "none" && setup?.length) {
        const env = { PIEWF_WORKTREE_PATH: path, PIEWF_SOURCE_ROOT: root, PIEWF_WORKTREE_BRANCH: branch };
        if (!supervised && !ownedPlatform) await runWorktreeSetup(setup, path, env);
        else for (const command of setup) {
          try { await runManagedWorktreeCommand(command, path, signal ?? new AbortController().signal, env); }
          catch (setupError) {
            if (isCleanupUnproven(setupError) || setupError instanceof WorkflowError && setupError.code !== "WORKTREE_FAILED") throw setupError;
            throw new WorkflowError("WORKTREE_FAILED", `worktreeSetup command ${JSON.stringify(command)} ${errorText(setupError).replace(/^Managed worktree command /, "")}`);
          }
        }
      }
      await verifyTip(record);
      if (admissionSignal?.aborted) throw new WorkflowError("CANCELLED", "Worktree creation cancelled");
      try {
        await this.#updateWorktreeRecordsUnderGuard(guard, (latest) => {
          if (latest.some((candidate) => candidate.owner === owner)) throw new WorkflowError("WORKTREE_FAILED", "Managed creation publication conflicts with an existing record");
          return [...latest, record];
        });
        await this.#removeMarker(guard, markerReceipt);
        await materializationOwner.release();
      } catch (transitionError) {
        return await this.retainCleanupUnproven(guard, markerReceipt, creation, isCleanupUnproven(transitionError) ? transitionError : new OwnedCommandCleanupError(`Managed creation completion is unproven: ${errorText(transitionError)}`));
      }
      return record;
    } catch (error) {
      const failureCode = error instanceof WorkflowError ? error.code : "WORKTREE_FAILED";
      const intent = { ...creation, ...(resourceIdentity ? { resourceIdentity } : {}), failureCode };
      // attemptId is diagnostic only; authority is the non-reconstructible inode/bytes receipt.
      const rollbackFailure = (message: string, cause: unknown = error) => {
        const failure = new OwnedCommandCleanupError(`${message} (attempt ${attemptId}): ${errorText(cause).slice(0, 2000)}`);
        Object.defineProperty(failure, "cause", { value: cause });
        return failure;
      };
      if (isCleanupUnproven(error)) {
        if (this.hasCleanupPoison(error)) throw error;
        this.cleanupPoison = error;
        guard.retain(error);
        if (markerReceipt) return this.retainCleanupUnproven(guard, markerReceipt, intent, error);
        throw error;
      }
      if (worktreeCreated && !materializationOwner) return this.retainCleanupUnproven(guard, markerReceipt, intent, rollbackFailure("Managed creation could not claim its materialized root")); // Never roll back a competing execution's root.
      if (!worktreeCreated && branchCreated && !pathExistedBeforeAdd && await pathExists(path)) {
        try {
          resourceIdentity = await this.resourceIdentity({ owner, path, branch });
          materializationOwner = await this.claimResource({ owner, path, branch, resourceIdentity });
          materializationClaimed = true;
          creation = { ...creation, resourceIdentity, cleanupProven: false };
          if (!markerReceipt) throw rollbackFailure("Partial creation has no marker receipt");
          await this.#replaceMarker(guard, markerReceipt, creation);
          worktreeCreated = true;
        } catch (claimError) {
          return this.retainCleanupUnproven(guard, markerReceipt, { ...intent, resourceIdentity }, isCleanupUnproven(claimError) ? claimError : rollbackFailure("Partial worktree creation could not be safely claimed"));
        }
      }
      if (materializationOwner) {
        try { await materializationOwner.verify(); }
        catch { return this.retainCleanupUnproven(guard, markerReceipt, intent, rollbackFailure("Managed creation lost its cleanup authority")); }
      }
      const cleanupGit = async (args: readonly string[]) => {
        try { await runGit(this.cwd, args, true); }
        catch (cleanupError) {
          if (isCleanupUnproven(cleanupError)) await this.retainCleanupUnproven(guard, markerReceipt, intent, cleanupError);
          // Proven ordinary nonzero cleanup remains best effort, as before.
        }
      };
      try {
        if (worktreeCreated) await cleanupGit(["worktree", "remove", "--force", path]);
        if (branchCreated) await cleanupGit(["branch", "-D", branch]);
        if (markerReceipt && (supervised || materializationOwner)) await this.proveCleanup(guard, markerReceipt, intent);
        // Publication is last; any uncertain publication retains above. Unpublished attempts own no inventory insertion.
        if (markerReceipt && !options.fresh) await this.#removeMarker(guard, markerReceipt);
        await materializationOwner?.release();
      } catch (cleanupError) {
        if (this.hasCleanupPoison(cleanupError)) throw cleanupError;
        return this.retainCleanupUnproven(guard, markerReceipt, intent, isCleanupUnproven(cleanupError) ? cleanupError : rollbackFailure(`Managed rollback did not finish: ${errorText(cleanupError)}`));
      }
      if (error instanceof WorkflowError && (markerReceipt || error.code === "CANCELLED" || error.code === "WORKTREE_FAILED")) throw error;
      throw new WorkflowError("WORKTREE_FAILED", errorText(error));
    }
  }

  private async resolveNamedWorktreeFromParent(name: string, parentRunId: string): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string } | undefined> {
    const source = await this.sourceRun(parentRunId);
    return source.findNamedWorktree(name, new Set([this.runId]));
  }

  private async bindBorrowedWorktree(guard: RunWorktreeGuard, binding: BorrowedWorktreeBinding): Promise<void> {
    this.#assertWorktreeGuard(guard);
    const records = [...await this.borrowedWorktreeRecords()];
    const existing = records.find((candidate) => candidate.name === binding.name);
    if (existing) {
      if (JSON.stringify(existing) !== JSON.stringify(binding)) throw new WorkflowError("WORKTREE_FAILED", `Borrowed worktree binding for ${binding.name} changed`);
      return;
    }
    records.push(binding);
    await atomicJson(join(this.directory, "borrowed-worktrees.json"), records);
  }
  async snapshotWorktree(owner: string): Promise<string> {
    try {
      const write = this.snapshotLane.run(async () => {
        const record = await this.worktree(owner);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await git(record.path, ["add", "-A"]);
          if (!(await git(record.path, ["status", "--porcelain"])).trim()) break;
          try {
            await git(record.path, ["commit", "-m", "pi-extensible-workflows runtime snapshot"], gitIdentity);
            break;
          } catch (error) {
            if (attempt === 2) throw error;
          }
        }
        return (await git(record.path, ["rev-parse", "HEAD"])).trim();
      });
      return await write;
    } catch (error) {
      throw coerceWorkflowError("WORKTREE_FAILED", error);
    }
  }
  async worktrees(): Promise<readonly WorktreeReference[]> {
    const records = await this.#loadWorktreeRecords();
    const bindings = await this.borrowedWorktreeRecords();
    const boundOwners = new Set(bindings.map((binding) => binding.owner));
    const owned = await Promise.all(records.filter((record) => !boundOwners.has(record.owner)).map(async (record) => { try { return await this.validateWorktree(record.owner); } catch { return undefined; } }));
    const borrowed = await Promise.all(bindings.map(async (binding) => (await this.resolveBorrowedWorktree(binding, new Set([this.runId]))).reference));
    return [...owned.filter((record): record is WorktreeReference => record !== undefined), ...borrowed];
  }
  async validNamedWorktrees(): Promise<readonly string[]> {
    const names = new Set<string>();
    const records = await this.#loadWorktreeRecords();
    let bindings: readonly BorrowedWorktreeBinding[];
    try { bindings = await this.borrowedWorktreeRecords(); }
    catch (error) { if (error instanceof WorkflowError && error.code === "WORKTREE_FAILED") return []; throw error; }
    const boundOwners = new Set(bindings.map((binding) => binding.owner));
    for (const record of records) {
      const owner = record.owner;
      const name = this.worktreeName(owner);
      if (!name || owner !== this.namedWorktreeOwner(name) || boundOwners.has(owner)) continue;
      try { await this.ownedWorktree(owner); names.add(name); } catch { /* Do not advertise stale or invalid records. */ }
    }
    for (const binding of bindings) {
      try { await this.resolveBorrowedWorktree(binding, new Set([this.runId])); names.add(binding.name); } catch { /* Do not advertise stale inherited records. */ }
    }
    return [...names];
  }
  async changedWorktrees(): Promise<readonly WorktreeReference[]> {
    const changed: WorktreeReference[] = [];
    for (const valid of await this.worktrees()) {
      try { await git(valid.path, ["diff", "--quiet", valid.base, "HEAD"]); }
      catch { changed.push(valid); }
    }
    return changed;
  }

  async saveResult(value: JsonValue): Promise<string> {
    const path = join(this.directory, "result.json");
    await atomicPrettyJson(path, value);
    return path;
  }

  async resultBytes(): Promise<number> {
    return (await stat(join(this.directory, "result.json"))).size;
  }

  evidenceDirectory(): string { return join(this.directory, "evidence"); }

  /** Content-addressed and journaled by digest, so a resumed or retried run gets back the record its lineage first stored. */
  async saveEvidence(content: string | JsonValue): Promise<EvidenceRecord> {
    if (typeof content !== "string" && !jsonValue(content)) throw new WorkflowError("INVALID_METADATA", "Evidence content must be a string or JSON-compatible value");
    const text = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
    const raw = Buffer.from(text, "utf8");
    const sha256 = createHash("sha256").update(raw).digest("hex");
    const ref = `ref:sha256:${sha256.slice(0, 16)}`;
    const operation = structuralPath("evidence", sha256);
    const replayed = await this.replay(operation);
    if (replayed) {
      const value = replayed.value;
      if (!object(value) || value.ref !== ref || value.sha256 !== sha256 || value.bytes !== raw.length || typeof value.path !== "string" || basename(value.path) !== `${sha256}.txt`) throw new WorkflowError("RESUME_INCOMPATIBLE", `Persisted evidence record is invalid: ${operation}`);
      assertEvidenceIntegrity(await readFile(value.path), sha256, value.path);
      return { ref, sha256, path: value.path, bytes: raw.length };
    }
    const dir = this.evidenceDirectory();
    const targetPath = join(dir, `${sha256}.txt`);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const existing = await readFile(targetPath).catch((error: unknown) => { if (isNodeError(error, "ENOENT")) return undefined; throw error; });
    if (existing === undefined) await atomicWriteFile(targetPath, text);
    else assertEvidenceIntegrity(existing, sha256, targetPath);
    const record = { ref, sha256, path: targetPath, bytes: raw.length };
    // Identical content stored concurrently journals once; every caller returns the same record.
    await this.updateJournal((journal) => { journal.completed[operation] ??= { path: operation, value: record }; });
    return record;
  }

  async listEvidence(): Promise<readonly EvidenceRecord[]> {
    const dir = this.evidenceDirectory();
    const names = await readdir(dir).catch(() => [] as string[]);
    const results: EvidenceRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".txt")) continue;
      const sha256 = name.slice(0, -4);
      if (!/^[0-9a-f]{64}$/.test(sha256)) continue;
      const targetPath = join(dir, name);
      try {
        const fileStat = await stat(targetPath);
        results.push({ ref: `ref:sha256:${sha256.slice(0, 16)}`, sha256, path: targetPath, bytes: fileStat.size });
      } catch { /* Ignore concurrently removed files. */ }
    }
    return results;
  }

  /**
   * Fails closed unless every evidence entry is a regular, correctly named file whose bytes match its SHA-256 name. A missing directory is valid.
   * `verified` maps paths to the file identity they were hashed at, so rescans rehash only new or changed artifacts.
   */
  async validateEvidence(verified?: Map<string, string>): Promise<void> {
    const dir = this.evidenceDirectory();
    const entries = await readdir(dir, { withFileTypes: true }).catch((error: unknown) => { if (isNodeError(error, "ENOENT")) return []; throw error; });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Evidence artifact is not a regular file: ${path}`);
      if (!/^[0-9a-f]{64}\.txt$/.test(entry.name)) throw new Error(`Evidence file name is invalid: ${path}`);
      // Taken before the read: a write during or after hashing changes ctime, so the next rescan rehashes.
      const info = await lstat(path, { bigint: true });
      const identity = `${String(info.dev)}:${String(info.ino)}:${String(info.size)}:${String(info.mtimeNs)}:${String(info.ctimeNs)}`;
      if (verified?.get(path) === identity) continue;
      if (createHash("sha256").update(await readFile(path)).digest("hex") !== entry.name.slice(0, 64)) throw new Error(`Evidence artifact content does not match checksum: ${path}`);
      verified?.set(path, identity);
    }
  }

  async delete(confirmed: boolean): Promise<void> {
    if (!confirmed) throw new WorkflowError("CANCELLED", "Run deletion requires confirmation");
    await this.worktreeCoordinator.run(undefined, (guard) => this.#deleteUnderGuard(guard));
  }
  async #deleteUnderGuard(guard: RunWorktreeGuard): Promise<void> {
    this.#assertWorktreeGuard(guard);
    if (this.cleanupPoison) throw this.cleanupPoison;
    const records = await this.#loadWorktreeRecords();
    const validated = records.map((record) => {
      try { return this.structuralWorktree(record.owner, record); }
      catch (error) { throw new WorkflowError("WORKTREE_FAILED", errorText(error)); }
    });
    await this.cleanupOrphanWorktrees(guard);
    await this.validateWorktreeInventory(validated);
    for (const record of validated) {
      if (!record.controls && record.resourceIdentity) {
        const identity = await this.resourceIdentity(record);
        if (!await pathExists(record.path) && !await pathExists(identity.gitDirectory)) {
          if (await pathExists(worktreeOwnerDirectory(identity))) throw new WorkflowError("WORKTREE_FAILED", "Dead managed resource still has a physical owner");
          // Legacy, independently missing root+metadata: remove only closed-inventory run bookkeeping.
          // No Git mutation, branch removal, root rm, guard removal or identity inference is permitted.
          await this.#updateWorktreeRecordsUnderGuard(guard, (current) => {
            const match = current.find((candidate) => candidate.owner === record.owner);
            if (!match || JSON.stringify(match) !== JSON.stringify(record)) throw new WorkflowError("WORKTREE_FAILED", "Legacy dead-resource record changed");
            return current.filter((candidate) => candidate !== match);
          });
          continue;
        }
      }
      const markerPath = this.markerPath(record.owner);
      const cleanupGit = async (args: readonly string[]) => {
        try {
          if (record.controls || process.platform === "darwin" || process.platform === "linux") await runManagedWorktreeCommand(managedGitCommand(record.controls ? args : ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args]), this.cwd, new AbortController().signal);
          else await git(this.cwd, args);
        }
        catch (error) { if (record.controls || isCleanupUnproven(error)) throw error; }
      };
      await this.cleanupResource(guard, record, markerPath, "record", async () => {
        await cleanupGit(["worktree", "remove", "--force", record.path]);
        await cleanupGit(["branch", "-D", record.branch]);
        await rm(record.path, { recursive: true, force: true });
      }, async () => {
        await this.#updateWorktreeRecordsUnderGuard(guard, (current) => {
          const match = current.find((candidate) => candidate.owner === record.owner);
          if (!match || JSON.stringify(match) !== JSON.stringify(record)) throw new WorkflowError("WORKTREE_FAILED", "Managed cleanup record changed");
          return current.filter((candidate) => candidate !== match);
        });
      });
    }
    const remaining = await this.#loadWorktreeRecords();
    if (remaining.length) throw new WorkflowError("WORKTREE_FAILED", "Managed worktree inventory is not empty");
    await this.validateWorktreeInventory(remaining);
    const entries = await readdir(this.directory).catch((error: unknown) => { if (isNodeError(error, "ENOENT")) return []; throw error; });
    if (entries.some((entry) => entry.endsWith(".creating"))) throw new WorkflowError("WORKTREE_FAILED", "Managed worktree markers remain");
    try { await rm(this.directory, { recursive: true, force: true }); }
    catch (error) {
      const failure = Object.assign(new OwnedCommandCleanupError("Run directory removal is unproven"), { cause: error });
      guard.retain(failure);
      throw failure;
    }
  }
}
