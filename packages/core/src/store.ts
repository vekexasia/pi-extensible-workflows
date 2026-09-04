import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { WorkflowError, type JsonValue, type LaunchSnapshot, type WorkflowBudgetUsage, type WorkflowErrorCode, type WorkflowRunEvent } from "./types.js";
import { coerceWorkflowError, errorText, isNodeError, loadLaunchSnapshot, object, SerialLane } from "./utils.js";
import {
  decodeBooleanCheckpointResult, decodeBorrowedWorktreeBindings, decodeJournal, decodeLaunchSnapshot,
  decodeOwnershipRecords, decodePersistedRun, decodeSummaryProjection, decodeSystemPromptArtifact,
  decodeWorktreeReferences, positiveInteger,
  type AwaitingCheckpoint, type BorrowedWorktreeBinding, type CompletedOperation, type EffectiveSystemPrompt,
  type Journal, type PendingWorkflowDecision, type PersistedOwnershipNode,
  type PersistedRun, type RunSummary, type RunSummaryArtifacts, type WorktreeReference,
} from "./decoders.js";
import { atomicJson, atomicPrettyJson, atomicWriteFile, git, gitIdentity, json } from "./io.js";
import { runsDirectory, safePart, structuralPath } from "./paths.js";

const TERMINAL_SUMMARY_STATES = new Set(["completed", "failed", "stopped"]);
const EMPTY_USAGE: WorkflowBudgetUsage = { tokens: 0, costUsd: 0, durationMs: 0, agentLaunches: 0 };
const SYSTEM_PROMPT_STORAGE = ".system-prompts";
const SYSTEM_PROMPT_RECORDS = "records";
const SYSTEM_PROMPT_BODIES = "bodies";
const SYSTEM_PROMPT_SEQUENCE = "sequence";
const SYSTEM_PROMPT_ARTIFACT = { version: 2 as const, format: "append-only" as const, storage: SYSTEM_PROMPT_STORAGE };
function summaryArtifacts(directory: string): RunSummaryArtifacts { return { runDirectory: directory, statePath: join(directory, "state.json"), journalPath: join(directory, "journal.json"), snapshotPath: join(directory, "snapshot.json"), workflowPath: join(directory, "workflow.js"), resultPath: join(directory, "result.json"), summaryPath: join(directory, "summary.json") }; }
function summaryFromRun(run: PersistedRun, directory: string, journal: Journal, previous: Partial<RunSummary> | undefined, fallbackCreatedAt: string, now = new Date().toISOString()): RunSummary {
  const createdAt = typeof previous?.createdAt === "string" ? previous.createdAt : fallbackCreatedAt;
  const failedAt = run.failedAt ?? run.error?.failedAt;
  const replayablePaths = [...new Set([...(run.retry?.completedPaths ?? []), ...Object.keys(journal.completed)])];
  const incompletePaths = [...new Set([...(run.retry?.incompletePaths ?? []), ...(failedAt ? [failedAt] : [])])];
  return { schemaVersion: 1, runId: run.id, sessionId: run.sessionId, workflowName: run.workflowName, state: run.state, createdAt, updatedAt: now, ...(previous?.terminalAt || TERMINAL_SUMMARY_STATES.has(run.state) ? { terminalAt: previous?.terminalAt ?? now } : {}), usage: { ...EMPTY_USAGE, ...(run.usage ?? {}) }, agents: run.agents.map(({ id, name, label, state, role, attempts }) => ({ id, name, ...(label ? { label } : {}), state, ...(role ? { role } : {}), attempts })), ...(run.error ? { error: run.error } : {}), ...(failedAt ? { failedAt } : {}), replayablePaths, incompletePaths, artifacts: summaryArtifacts(directory) };
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
  private worktreeLane = new SerialLane();
  private borrowedWorktreeLane = new SerialLane();
  private snapshotLane = new SerialLane();
  private launchSnapshotLane = new SerialLane();
  // ponytail: the session lease prevents concurrent RunStore writers for one run.
  private systemPromptLane = new SerialLane();
  constructor(readonly cwd: string, readonly sessionId: string, readonly runId: string, readonly home = homedir()) {
    this.cwd = resolve(cwd);
    this.directory = join(runsDirectory(this.cwd, sessionId, home), safePart(runId));
  }
  #assertRunIdentity(run: PersistedRun, code: WorkflowErrorCode, message: string): void {
    if (resolve(run.cwd) !== this.cwd || run.sessionId !== this.sessionId || run.id !== this.runId) throw new WorkflowError(code, message);
  }

  async create(run: PersistedRun, snapshot: Readonly<LaunchSnapshot>): Promise<void> {
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

  private async updateJournal<T>(update: (journal: Journal) => T | Promise<T>): Promise<T> {
    const write = this.journalLane.run(async () => {
      const journalPath = join(this.directory, "journal.json");
      const journal = decodeJournal(await json(journalPath));
      if (!journal) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted journal is invalid");
      journal.awaiting ??= {};
      const result = await update(journal);
      await atomicJson(journalPath, journal);
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
    const operations = await this.replayableOperations();
    return operations.find((operation) => operation.path === path);
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
    await this.journalLane.run(async () => undefined);
    const journal = decodeJournal(await json(join(this.directory, "journal.json")));
    if (!journal) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted journal is invalid");
    for (const agent of loaded.run.agents) {
      // Only a journaled operation completed: an attempt a dying host left running records no error either.
      if (!agent.resultPath || !journal.completed[agent.resultPath]) continue;
      // Failed attempts of that operation also record a session; their partial transcript must never be the source.
      const locator = agent.attemptDetails?.filter((detail) => !detail.error).at(-1)?.session?.locator;
      files.set(agent.resultPath, object(locator) && typeof locator.sessionFile === "string" ? locator.sessionFile : undefined);
    }
    return files;
  }

  private async replayableOperationsFrom(seen: Set<string>): Promise<readonly CompletedOperation[]> {
    if (seen.has(this.runId)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Retry provenance contains a cycle");
    const nextSeen = new Set(seen);
    nextSeen.add(this.runId);
    await this.journalLane.run(async () => undefined);
    const loaded = await this.load();
    const operations = new Map<string, CompletedOperation>();
    if (loaded.run.retry?.sourceRunId) {
      const source = await this.sourceRun(loaded.run.retry.sourceRunId);
      for (const operation of await source.replayableOperationsFrom(nextSeen)) operations.set(operation.path, operation);
    }
    const journal = decodeJournal(await json(join(this.directory, "journal.json")));
    if (!journal) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted journal is invalid");
    for (const operation of Object.values(journal.completed)) operations.set(operation.path, operation);
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
    await this.journalLane.run(async () => undefined);
    const journal = decodeJournal(await json(join(this.directory, "journal.json")));
    if (!journal) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted journal is invalid");
    return Object.values(journal.awaiting ?? {});
  }
  async requestWorkflowDecision(request: PendingWorkflowDecision): Promise<void> {
    await this.updateJournal((journal) => { journal.decisions ??= {}; journal.decisions[request.proposalId] = request; });
  }
  async pendingWorkflowDecisions(): Promise<readonly PendingWorkflowDecision[]> {
    await this.journalLane.run(async () => undefined);
    const journal = decodeJournal(await json(join(this.directory, "journal.json")));
    if (!journal) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted journal is invalid");
    return Object.values(journal.decisions ?? {});
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

  private expectedWorktree(owner: string): Pick<WorktreeReference, "path" | "branch"> {
    const key = createHash("sha256").update(`${this.sessionId}\0${this.runId}\0${owner}`).digest("hex").slice(0, 16);
    return { path: join(this.directory, "worktrees", key), branch: `pi-extensible-workflows/${safePart(this.runId)}/${key}` };
  }

  private markerPath(owner: string): string {
    const key = createHash("sha256").update(`${this.sessionId}\0${this.runId}\0${owner}`).digest("hex").slice(0, 16);
    return join(this.directory, `worktree-${key}.creating`);
  }

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

  private async borrowedWorktreeRecords(wait = true): Promise<readonly BorrowedWorktreeBinding[]> {
    if (wait) await this.borrowedWorktreeLane.run(async () => undefined);
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
      if (!["completed", "failed", "stopped"].includes(loaded.run.state)) throw new Error(`Source run ${sourceRunId} is not terminal`);
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
      if (typeof retry.sourceRunId !== "string" || !retry.sourceRunId || retry.sourceRunId === current.runId || typeof retry.lineageRootRunId !== "string" || !retry.lineageRootRunId || !Array.isArray(retry.completedPaths) || retry.completedPaths.some((path) => typeof path !== "string") || !Array.isArray(retry.incompletePaths) || retry.incompletePaths.some((path) => typeof path !== "string") || !Array.isArray(retry.namedWorktrees) || retry.namedWorktrees.some((name) => typeof name !== "string")) throw new WorkflowError("RESUME_INCOMPATIBLE", "Retry provenance is incomplete");
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

  private async ownedWorktree(owner: string, cwd?: string): Promise<WorktreeReference> {
    const records = await this.#loadWorktreeRecords(false);
    const matches = records.filter((candidate) => candidate.owner === owner);
    if (matches.length !== 1) throw new Error(`Missing or duplicate worktree record for ${owner}`);
    const record = matches[0];
    if (!record) throw new Error(`Missing or duplicate worktree record for ${owner}`);
    const validated = this.structuralWorktree(owner, record);
    if (cwd !== undefined && resolve(cwd) !== resolve(validated.cwd)) throw new Error(`Invalid worktree record for ${owner}`);
    await access(validated.cwd);
    return validated;
  }

  private async resolveBorrowedWorktree(binding: BorrowedWorktreeBinding, seen: Set<string>): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string }> {
    try {
      const source = await this.sourceRun(binding.sourceRunId);
      const resolved = await source.findNamedWorktree(binding.name, seen);
      if (!resolved) throw new Error(`Missing named worktree ${binding.name} in source run ${binding.sourceRunId}`);
      if (resolved.owner !== binding.owner) throw new Error(`Borrowed worktree binding does not match source owner for ${binding.name}`);
      return resolved;
    } catch (error) {
      throw coerceWorkflowError("WORKTREE_FAILED", error);
    }
  }

  private async findNamedWorktree(name: string, seen: Set<string> = new Set()): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string } | undefined> {
    const owner = this.namedWorktreeOwner(name);
    if (seen.has(this.runId)) throw new WorkflowError("WORKTREE_FAILED", "Borrowed worktree bindings contain a cycle");
    const nextSeen = new Set(seen);
    nextSeen.add(this.runId);
    const binding = await this.borrowedWorktree(name);
    if (binding) {
      const loaded = await this.load();
      if (loaded.run.parentRunId === undefined) throw new WorkflowError("WORKTREE_FAILED", `Borrowed worktree ${name} has no parent run`);
      const parent = await this.sourceRun(loaded.run.parentRunId);
      const resolved = await parent.findNamedWorktree(name, nextSeen);
      if (!resolved || resolved.sourceRunId !== binding.sourceRunId || resolved.owner !== binding.owner) throw new WorkflowError("WORKTREE_FAILED", `Borrowed worktree binding for ${name} is not inherited from its parent run`);
      return resolved;
    }
    const records = await this.#loadWorktreeRecords(false);
    const matches = records.filter((candidate) => candidate.owner === owner);
    if (matches.length === 0) {
      const loaded = await this.load();
      if (loaded.run.parentRunId === undefined) return undefined;
      const parent = await this.sourceRun(loaded.run.parentRunId);
      return parent.findNamedWorktree(name, nextSeen);
    }
    try {
      const reference = await this.ownedWorktree(owner);
      return { reference, sourceRunId: this.runId, owner };
    } catch (error) {
      throw coerceWorkflowError("WORKTREE_FAILED", error);
    }
  }

  async resolveNamedWorktree(name: string, seen: Set<string> = new Set()): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string }> {
    const resolved = await this.findNamedWorktree(name, seen);
    if (!resolved) throw new WorkflowError("WORKTREE_FAILED", `Missing named worktree ${name}`);
    return resolved;
  }
  async validateDeletionWorktrees(): Promise<void> {
    try {
      const records = await this.#loadWorktreeRecords(false);
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
    } catch (error) {
      throw coerceWorkflowError("WORKTREE_FAILED", error);
    }
  }


  async validateBorrowedWorktrees(): Promise<void> {
    try {
      const loaded = await this.load();
      if (loaded.run.parentRunId !== undefined) await this.validateParentRun(loaded.run.parentRunId);
      for (const binding of await this.borrowedWorktreeRecords()) await this.resolveBorrowedWorktree(binding, new Set([this.runId]));
    } catch (error) {
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
      throw coerceWorkflowError("WORKTREE_FAILED", error);
    }
  }

  async ownsWorktree(owner: string): Promise<boolean> {
    const records = await this.#loadWorktreeRecords(false);
    return records.filter((candidate) => candidate.owner === owner).length === 1;
  }

  private async cleanupMarker(markerPath: string): Promise<void> {
    let marker: Record<string, unknown>;
    try {
      const parsed = await json(markerPath);
      if (!object(parsed)) return;
      marker = parsed;
    } catch { return; }
    if (typeof marker.owner !== "string" || typeof marker.base !== "string") return;
    const expected = this.expectedWorktree(marker.owner);
    if (marker.path !== expected.path || marker.branch !== expected.branch) return;
    const root = await git(this.cwd, ["rev-parse", "--show-toplevel"]).then((value) => value.trim()).catch(() => "");
    if (!root) return;
    const branchBase = await git(root, ["rev-parse", "--verify", `${expected.branch}^{commit}`]).then((value) => value.trim()).catch(() => "");
    if (branchBase !== marker.base) return;
    await git(root, ["worktree", "remove", "--force", expected.path]).catch(() => undefined);
    await git(root, ["branch", "-D", expected.branch]).catch(() => undefined);
    await rm(expected.path, { recursive: true, force: true });
    await rm(markerPath, { force: true });
  }

  private async cleanupOrphanWorktrees(): Promise<void> {
    const entries = await readdir(this.directory).catch(() => [] as string[]);
    for (const entry of entries.filter((name) => name.endsWith(".creating"))) await this.cleanupMarker(join(this.directory, entry));
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
      throw coerceWorkflowError("WORKTREE_FAILED", error);
    }
  }

  async worktree(owner: string): Promise<WorktreeReference> {
    const write = this.worktreeLane.run(async () => {
      const loaded = await this.load();
      const recordsPath = resolve(this.directory, "worktrees.json");
      let records = await this.#loadWorktreeRecords();
      const name = this.worktreeName(owner);
      const binding = name ? await this.borrowedWorktree(name) : undefined;
      if (binding) return (await this.resolveBorrowedWorktree(binding, new Set([this.runId]))).reference;
      if (name && loaded.run.parentRunId !== undefined) {
        const resolved = await this.resolveNamedWorktreeFromParent(name, loaded.run.parentRunId);
        if (resolved) {
          await this.bindBorrowedWorktree({ name, sourceRunId: resolved.sourceRunId, owner: resolved.owner });
          return resolved.reference;
        }
      }
      if (name && Array.isArray(loaded.run.retry?.namedWorktrees) && loaded.run.retry.namedWorktrees.includes(name)) throw new WorkflowError("WORKTREE_FAILED", `Missing inherited named worktree ${name}`);
      const existing = records.find((record) => record.owner === owner);
      if (existing) return this.validateWorktree(owner);
      const { path, branch } = this.expectedWorktree(owner);
      const index = join(this.directory, `index-${basename(path)}`);
      const markerPath = this.markerPath(owner);
      let branchCreated = false;
      let worktreeCreated = false;
      try {
        const root = (await git(this.cwd, ["rev-parse", "--show-toplevel"])).trim();
        const [canonicalRoot, canonicalCwd] = await Promise.all([realpath(root), realpath(this.cwd)]);
        const launchRelative = relative(canonicalRoot, canonicalCwd);
        if (launchRelative === ".." || launchRelative.startsWith(`..${sep}`)) throw new Error("launch cwd is outside the repository");
        await this.cleanupMarker(markerPath);
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await git(root, ["read-tree", "HEAD"], { GIT_INDEX_FILE: index });
        await git(root, ["add", "-A"], { GIT_INDEX_FILE: index });
        const tree = (await git(root, ["write-tree"], { GIT_INDEX_FILE: index })).trim();
        const commit = (await git(root, ["commit-tree", tree, "-p", "HEAD", "-m", "pi-extensible-workflows runtime snapshot"], { GIT_INDEX_FILE: index, ...gitIdentity })).trim();
        const record = { owner, path, branch, cwd: join(path, launchRelative), base: commit };
        await atomicJson(markerPath, { owner, path, branch, base: commit });
        await git(root, ["branch", branch, commit]);
        branchCreated = true;
        await git(root, ["worktree", "add", "--no-checkout", path, branch]);
        worktreeCreated = true;
        await git(path, ["checkout", "--force", branch]);
        await rm(index, { force: true });
        await atomicJson(recordsPath, [...records, record]);
        await rm(markerPath, { force: true });
        return record;
      } catch (error) {
        await rm(index, { force: true });
        if (worktreeCreated) await git(this.cwd, ["worktree", "remove", "--force", path]).catch(() => undefined);
        if (branchCreated) await git(this.cwd, ["branch", "-D", branch]).catch(() => undefined);
        await rm(markerPath, { force: true });
        try {
          const persisted = await this.#loadWorktreeRecords();
          const match = persisted.filter((candidate) => candidate.owner === owner);
          const candidate = match.length === 1 ? match[0] : undefined;
          if (candidate) { this.structuralWorktree(owner, candidate); records = persisted.filter((current) => current !== candidate); await atomicJson(recordsPath, records); }
        } catch { /* Ownership changed or disappeared: do not delete anything. */ }
        throw new WorkflowError("WORKTREE_FAILED", errorText(error));
      }
    });
    return write;
  }

  private async resolveNamedWorktreeFromParent(name: string, parentRunId: string): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string } | undefined> {
    const source = await this.sourceRun(parentRunId);
    return source.findNamedWorktree(name, new Set([this.runId]));
  }

  private async bindBorrowedWorktree(binding: BorrowedWorktreeBinding): Promise<void> {
    const write = this.borrowedWorktreeLane.run(async () => {
      const records = [...await this.borrowedWorktreeRecords(false)];
      const existing = records.find((candidate) => candidate.name === binding.name);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(binding)) throw new WorkflowError("WORKTREE_FAILED", `Borrowed worktree binding for ${binding.name} changed`);
        return;
      }
      records.push(binding);
      await atomicJson(join(this.directory, "borrowed-worktrees.json"), records);
    });
    await write;
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

  async delete(confirmed: boolean): Promise<void> {
    if (!confirmed) throw new WorkflowError("CANCELLED", "Run deletion requires confirmation");
    const records = await this.#loadWorktreeRecords();
    const validated = records.map((record) => {
      try { return this.structuralWorktree(record.owner, record); }
      catch (error) { throw new WorkflowError("WORKTREE_FAILED", errorText(error)); }
    });
    await this.cleanupOrphanWorktrees();
    for (const record of validated) {
      await git(this.cwd, ["worktree", "remove", "--force", record.path]).catch(() => undefined);
      await git(this.cwd, ["branch", "-D", record.branch]).catch(() => undefined);
    }
    await rm(this.directory, { recursive: true, force: true });
  }
}
