import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { access, link, mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { BudgetApprovalRequest, JsonValue, LaunchSnapshot, RunRecord, WorkflowRunEvent } from "./index.js";
import type { OwnershipRecord } from "./agent-execution.js";
import { loadLaunchSnapshot, WorkflowError } from "./index.js";

export interface NativeSessionReference { sessionId: string; sessionFile: string }
export interface EffectiveSystemPrompt { sessionId: string; attempt: number; turn: number; sha256: string; prompt: string }
export interface ConversationHead { turn: number; sessionId: string; sessionFile: string; leafId: string; systemPrompt: string; systemPromptSha256: string; toolDefinitionsSha256: string }
export interface PersistedConversation { id: string; policy: JsonValue; head: ConversationHead }
type ConversationArtifact = { version: 1; conversations: Record<string, PersistedConversation> };
function isConversationArtifact(value: unknown): value is ConversationArtifact {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const artifact = value as { version?: unknown; conversations?: unknown };
  return artifact.version === 1 && Boolean(artifact.conversations) && typeof artifact.conversations === "object" && !Array.isArray(artifact.conversations);
}
export interface PersistedRun extends RunRecord { nativeSessions: readonly NativeSessionReference[] }
export interface CompletedOperation { path: string; value: JsonValue }
export interface AwaitingCheckpoint { path: string; name: string; prompt: string; context: JsonValue }
export type PendingWorkflowDecision = BudgetApprovalRequest
export type PersistedOwnershipNode = OwnershipRecord
type Journal = { completed: Record<string, CompletedOperation>; awaiting?: Record<string, AwaitingCheckpoint>; decisions?: Record<string, PendingWorkflowDecision> };
export interface WorktreeReference { owner: string; path: string; branch: string; cwd: string; base: string }
export interface BorrowedWorktreeBinding { name: string; sourceRunId: string; owner: string }

const execute = promisify(execFile);
const gitIdentity = {
  GIT_AUTHOR_NAME: "pi-extensible-workflows", GIT_AUTHOR_EMAIL: "pi-extensible-workflows@localhost", GIT_COMMITTER_NAME: "pi-extensible-workflows", GIT_COMMITTER_EMAIL: "pi-extensible-workflows@localhost",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

function safePart(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_"); }

export function projectStorageKey(cwd: string): string {
  const exact = resolve(cwd);
  const slug = safePart(basename(exact)) || "root";
  return `${slug}-${createHash("sha256").update(exact).digest("hex").slice(0, 12)}`;
}

export function runsDirectory(cwd: string, sessionId: string, home = homedir()): string {
  return join(home, ".pi", "workflows", "projects", projectStorageKey(cwd), "sessions", safePart(sessionId), "runs");
}

const SESSION_OWNER_FILE = "owner.json";
const SESSION_OWNER_WRITE_GRACE_MS = 30_000;
const RUN_CREATE_TEMP = /^\.([a-zA-Z0-9._-]+)\.(\d+)\.[0-9a-f-]+\.tmp$/;
type SessionOwner = { pid: number; token: string; startedAt: number };

async function processAlive(pid: number, startedAt?: number): Promise<boolean> {
  try { process.kill(pid, 0); } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
  if (startedAt !== undefined && process.platform === "linux") {
    try { if ((await stat(`/proc/${String(pid)}`)).ctimeMs > startedAt) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; }
  }
  return true;
}

function sameOwner(left: unknown, right: unknown): boolean {
  if (!left || typeof left !== "object" || !right || typeof right !== "object") return false;
  const first = left as Partial<SessionOwner>;
  const second = right as Partial<SessionOwner>;
  return first.pid === second.pid && first.token === second.token;
}

async function restoreLease(path: string, stale: string): Promise<void> {
  try { await link(stale, path); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST" && code !== "ENOENT") throw error;
  }
  await rm(stale, { force: true });
}

async function cleanupRunTemps(directory: string, entries: readonly { name: string; isDirectory(): boolean }[]): Promise<void> {
  await Promise.all(entries.map(async (entry) => {
    const match = entry.isDirectory() ? RUN_CREATE_TEMP.exec(entry.name) : undefined;
    const pid = match?.[2] ? Number(match[2]) : undefined;
    if (pid && !await processAlive(pid)) await rm(join(directory, entry.name), { recursive: true, force: true });
  }));
}

export class SessionLease {
  #released = false;
  constructor(readonly path: string, readonly token: string) {}
  get active(): boolean { return !this.#released; }
  async release(): Promise<void> {
    if (this.#released) return;
    this.#released = true;
    try {
      const owner = JSON.parse(await readFile(this.path, "utf8")) as Partial<SessionOwner>;
      if (owner.token === this.token) await rm(this.path, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

export async function acquireSessionLease(cwd: string, sessionId: string, home = homedir()): Promise<SessionLease> {
  const directory = runsDirectory(cwd, sessionId, home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, SESSION_OWNER_FILE);
  for (;;) {
    const token = randomUUID();
    const owner: SessionOwner = { pid: process.pid, token, startedAt: Date.now() };
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8"); } finally { await handle.close(); }
      return new SessionLease(path, token);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let existing: Partial<SessionOwner>;
      let existingText = "";
      try {
        existingText = await readFile(path, "utf8");
        existing = JSON.parse(existingText) as Partial<SessionOwner>;
        if (typeof existing.pid === "number" && existing.pid > 0 && await processAlive(existing.pid, existing.startedAt)) throw new WorkflowError("RUN_OWNED", `Pi session ${sessionId} is already owned by process ${String(existing.pid)}`);
      } catch (readError) {
        if (readError instanceof WorkflowError) throw readError;
        if ((readError as NodeJS.ErrnoException).code === "ENOENT") continue;
        const age = await stat(path).then((value) => Date.now() - value.mtimeMs).catch(() => 0);
        if (age < SESSION_OWNER_WRITE_GRACE_MS) throw new WorkflowError("RUN_OWNED", `Pi session ${sessionId} has an active ownership lease`);
        existing = {};
      }
      const stale = `${path}.${randomUUID()}.stale`;
      try {
        await rename(path, stale);
        const movedText = await readFile(stale, "utf8");
        let moved: unknown;
        try { moved = JSON.parse(movedText); }
        catch {
          if (movedText === existingText) await rm(stale, { force: true });
          else await restoreLease(path, stale);
          continue;
        }
        if (!sameOwner(existing, moved)) { await restoreLease(path, stale); continue; }
        await rm(stale, { force: true });
      }
      catch (reclaimError) { if ((reclaimError as NodeJS.ErrnoException).code === "ENOENT") continue; throw reclaimError; }
    }
  }
}

export async function listRunIds(cwd: string, sessionId: string, home = homedir()): Promise<string[]> {
  const directory = runsDirectory(cwd, sessionId, home);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    await cleanupRunTemps(directory, entries);
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map(({ name }) => name);
  }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export function structuralPath(...names: string[]): string {
  if (names.length === 0 || names.some((name) => name.trim() === "")) throw new WorkflowError("INVALID_METADATA", "Structural paths require non-empty explicit names");
  return names.map((name) => encodeURIComponent(name)).join("/");
}

export function atomicWriteFile(path: string, content: string): Promise<void>;
export function atomicWriteFile(path: string, content: string, sync: true): void;
export function atomicWriteFile(path: string, content: string, sync = false): Promise<void> | void {
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  if (sync) {
    try {
      writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
      renameSync(temporary, path);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch { /* Preserve the original write error. */ }
      throw error;
    }
    return;
  }
  return writeFile(temporary, content, { encoding: "utf8", mode: 0o600 }).then(() => rename(temporary, path)).catch(async (error: unknown) => {
    try { await rm(temporary, { force: true }); } catch { /* Preserve the original write error. */ }
    throw error;
  });
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value)}\n`);
}

async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }

export class RunStore {
  readonly directory: string;
  private journalWrite: Promise<void> = Promise.resolve();
  // ponytail: serializes one RunStore instance; cross-process run sharing remains unsupported.
  private stateWrite: Promise<void> = Promise.resolve();
  private worktreeWrite: Promise<void> = Promise.resolve();
  private borrowedWorktreeWrite: Promise<void> = Promise.resolve();
  private snapshotWrite: Promise<void> = Promise.resolve();
  private launchSnapshotWrite: Promise<void> = Promise.resolve();
  // ponytail: the session lease prevents concurrent RunStore writers for one run.
  private systemPromptWrite: Promise<void> = Promise.resolve();
  private conversationWrite: Promise<void> = Promise.resolve();
  constructor(readonly cwd: string, readonly sessionId: string, readonly runId: string, readonly home = homedir()) {
    this.cwd = resolve(cwd);
    this.directory = join(runsDirectory(this.cwd, sessionId, home), safePart(runId));
  }

  async create(run: PersistedRun, snapshot: Readonly<LaunchSnapshot>): Promise<void> {
    if (resolve(run.cwd) !== this.cwd || run.sessionId !== this.sessionId || run.id !== this.runId) throw new WorkflowError("INTERNAL_ERROR", "Run identity does not match its session-scoped store");
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
      await atomicJson(join(temporary, "system-prompts.json"), { version: 1, entries: [] });
      await atomicJson(join(temporary, "conversations.json"), { version: 1, conversations: {} });
      await rename(temporary, this.directory);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  async isComplete(): Promise<boolean> {
    try { await Promise.all([access(join(this.directory, "snapshot.json")), access(join(this.directory, "journal.json")), access(join(this.directory, "ownership.json")), access(join(this.directory, "state.json"))]); return true; }
    catch { return false; }
  }

  async load(): Promise<{ run: PersistedRun; snapshot: Readonly<LaunchSnapshot> }> {
    await this.stateWrite;
    const run = await json<PersistedRun>(join(this.directory, "state.json"));
    if (resolve(run.cwd) !== this.cwd || run.sessionId !== this.sessionId || run.id !== this.runId) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted run belongs to another cwd or Pi session");
    return { run, snapshot: loadLaunchSnapshot(await json<LaunchSnapshot>(join(this.directory, "snapshot.json"))) };
  }

  async saveState(run: PersistedRun): Promise<void> {
    const write = this.stateWrite.then(async () => {
      if (resolve(run.cwd) !== this.cwd || run.sessionId !== this.sessionId || run.id !== this.runId) throw new WorkflowError("INTERNAL_ERROR", "Run identity does not match its session-scoped store");
      await atomicJson(join(this.directory, "state.json"), run);
    });
    this.stateWrite = write.catch(() => undefined);
    await write;
  }

  async updateState(update: (run: PersistedRun) => PersistedRun | Promise<PersistedRun>): Promise<PersistedRun> {
    let result!: PersistedRun;
    const write = this.stateWrite.then(async () => {
      const current = await json<PersistedRun>(join(this.directory, "state.json"));
      if (resolve(current.cwd) !== this.cwd || current.sessionId !== this.sessionId || current.id !== this.runId) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted run belongs to another cwd or Pi session");
      result = await update(current);
      if (resolve(result.cwd) !== this.cwd || result.sessionId !== this.sessionId || result.id !== this.runId) throw new WorkflowError("INTERNAL_ERROR", "Run identity does not match its session-scoped store");
      await atomicJson(join(this.directory, "state.json"), result);
    });
    this.stateWrite = write.catch(() => undefined);
    await write;
    return result;
  }

  async saveSnapshot(snapshot: Readonly<LaunchSnapshot>): Promise<void> {
    const write = this.launchSnapshotWrite.then(() => atomicJson(join(this.directory, "snapshot.json"), snapshot));
    this.launchSnapshotWrite = write.catch(() => undefined);
    await write;
  }

  async appendEvent(event: WorkflowRunEvent): Promise<void> {
    await this.updateState((run) => ({ ...run, events: [...(run.events ?? []), ...(run.events?.some((current) => current.type === event.type && current.message === event.message) ? [] : [event])] }));
  }

  async saveOwnership(nodes: readonly PersistedOwnershipNode[]): Promise<void> {
    await atomicJson(join(this.directory, "ownership.json"), nodes);
  }

  async loadOwnership(): Promise<readonly PersistedOwnershipNode[]> {
    return json<readonly PersistedOwnershipNode[]>(join(this.directory, "ownership.json"));
  }

  systemPromptPath(): string { return join(this.directory, "system-prompts.json"); }

  async recordSystemPrompt(entry: Omit<EffectiveSystemPrompt, "sha256">): Promise<void> {
    const write = this.systemPromptWrite.then(async () => {
      const path = this.systemPromptPath();
      const artifact = await json<{ version: 1; entries: EffectiveSystemPrompt[] }>(path).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 as const, entries: [] as EffectiveSystemPrompt[] }; throw error; });
      artifact.entries.push({ ...entry, sha256: createHash("sha256").update(entry.prompt).digest("hex") });
      await atomicJson(path, artifact);
    });
    this.systemPromptWrite = write.catch(() => undefined);
    await write;
  }

  async systemPrompts(): Promise<readonly EffectiveSystemPrompt[]> {
    await this.systemPromptWrite;
    return (await json<{ version: 1; entries: EffectiveSystemPrompt[] }>(this.systemPromptPath()).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 as const, entries: [] }; throw error; })).entries;
  }

  conversationPath(): string { return join(this.directory, "conversations.json"); }
  async conversation(id: string): Promise<PersistedConversation | undefined> {
    await this.conversationWrite;
    let artifact: ConversationArtifact;
    try { const raw = await json<unknown>(this.conversationPath()); if (!isConversationArtifact(raw)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Conversation state is corrupt"); artifact = raw; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; if (error instanceof WorkflowError) throw error; throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot load conversation state: ${error instanceof Error ? error.message : String(error)}`); }
    return artifact.conversations[id];
  }
  async saveConversation(conversation: PersistedConversation): Promise<void> {
    const write = this.conversationWrite.then(async () => {
      const path = this.conversationPath();
      let artifact: ConversationArtifact;
      try { const raw = await json<unknown>(path); if (!isConversationArtifact(raw)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Conversation state is corrupt"); artifact = raw; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") artifact = { version: 1, conversations: {} }; else if (error instanceof WorkflowError) throw error; else throw new WorkflowError("RESUME_INCOMPATIBLE", `Cannot load conversation state: ${error instanceof Error ? error.message : String(error)}`); }
      const previous = artifact.conversations[conversation.id];
      if (previous && previous.head.turn + 1 !== conversation.head.turn) throw new WorkflowError("RESUME_INCOMPATIBLE", `Conversation head is not the previous turn: ${conversation.id}`);
      if (!previous && conversation.head.turn !== 1) throw new WorkflowError("RESUME_INCOMPATIBLE", `Conversation must start at turn one: ${conversation.id}`);
      artifact.conversations[conversation.id] = structuredClone(conversation);
      await atomicJson(path, artifact);
    });
    this.conversationWrite = write.catch(() => undefined);
    await write;
  }
  private async updateJournal<T>(update: (journal: Journal) => T | Promise<T>): Promise<T> {
    let result!: T;
    const write = this.journalWrite.then(async () => {
      const journalPath = join(this.directory, "journal.json");
      const journal = await json<Journal>(journalPath);
      journal.awaiting ??= {};
      result = await update(journal);
      await atomicJson(journalPath, journal);
    });
    this.journalWrite = write.catch(() => undefined);
    await write;
    return result;
  }

  async complete(path: string, value: JsonValue): Promise<void> {
    await this.updateJournal((journal) => {
      if (journal.completed[path]) throw new WorkflowError("DUPLICATE_NAME", `Completed structural path already exists: ${path}`);
      journal.completed[path] = { path, value };
    });
  }

  async replay(path: string): Promise<CompletedOperation | undefined> {
    await this.journalWrite;
    return (await json<Journal>(join(this.directory, "journal.json"))).completed[path];
  }

  async awaitCheckpoint(checkpoint: AwaitingCheckpoint): Promise<boolean | undefined> {
    return this.updateJournal((journal) => {
      const completed = journal.completed[checkpoint.path];
      if (completed) return completed.value as boolean;
      (journal.awaiting as Record<string, AwaitingCheckpoint>)[checkpoint.path] = checkpoint;
      return undefined;
    });
  }

  async awaitingCheckpoints(): Promise<readonly AwaitingCheckpoint[]> {
    await this.journalWrite;
    const journal = await json<Journal>(join(this.directory, "journal.json"));
    return Object.values(journal.awaiting ?? {});
  }
  async requestWorkflowDecision(request: PendingWorkflowDecision): Promise<void> {
    await this.updateJournal((journal) => { journal.decisions ??= {}; journal.decisions[request.proposalId] = request; });
  }
  async pendingWorkflowDecisions(): Promise<readonly PendingWorkflowDecision[]> {
    await this.journalWrite;
    const journal = await json<Journal>(join(this.directory, "journal.json"));
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

  private structuralWorktree(owner: string, record: unknown): WorktreeReference {
    if (!record || typeof record !== "object") throw new Error(`Invalid worktree record for ${owner}`);
    const candidate = record as Partial<WorktreeReference>;
    const expected = this.expectedWorktree(owner);
    const relativePath = typeof candidate.path === "string" ? relative(this.directory, candidate.path) : "..";
    const relativeCwd = typeof candidate.path === "string" && typeof candidate.cwd === "string" ? relative(candidate.path, candidate.cwd) : "..";
    if (candidate.owner !== owner || typeof candidate.path !== "string" || typeof candidate.branch !== "string" || typeof candidate.cwd !== "string" || typeof candidate.base !== "string" || resolve(candidate.path) !== expected.path || candidate.branch !== expected.branch || relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativeCwd === ".." || relativeCwd.startsWith(`..${sep}`)) throw new Error(`Invalid worktree record for ${owner}`);
    return candidate as WorktreeReference;
  }

  private async borrowedWorktreeRecords(wait = true): Promise<readonly BorrowedWorktreeBinding[]> {
    if (wait) await this.borrowedWorktreeWrite;
    const records = await json<unknown[]>(join(this.directory, "borrowed-worktrees.json")).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
    if (!Array.isArray(records)) throw new WorkflowError("WORKTREE_FAILED", "Borrowed worktree bindings are invalid");
    const seen = new Set<string>();
    return records.map((record) => {
      if (!record || typeof record !== "object") throw new WorkflowError("WORKTREE_FAILED", "Borrowed worktree binding is invalid");
      const candidate = record as Partial<BorrowedWorktreeBinding>;
      if (typeof candidate.name !== "string" || !candidate.name.trim() || typeof candidate.sourceRunId !== "string" || !candidate.sourceRunId || typeof candidate.owner !== "string" || candidate.owner !== this.namedWorktreeOwner(candidate.name)) throw new WorkflowError("WORKTREE_FAILED", "Borrowed worktree binding is invalid");
      if (seen.has(candidate.name)) throw new WorkflowError("WORKTREE_FAILED", `Duplicate borrowed worktree binding for ${candidate.name}`);
      seen.add(candidate.name);
      return { name: candidate.name, sourceRunId: candidate.sourceRunId, owner: candidate.owner };
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
      if (error instanceof WorkflowError && error.code === "WORKTREE_FAILED") throw error;
      throw new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  async validateParentRun(parentRunId: string): Promise<void> { await this.sourceRun(parentRunId); }

  private async ownedWorktree(owner: string, cwd?: string): Promise<WorktreeReference> {
    const records = await json<unknown[]>(join(this.directory, "worktrees.json"));
    const matches = records.filter((candidate) => candidate && typeof candidate === "object" && (candidate as Partial<WorktreeReference>).owner === owner);
    if (matches.length !== 1) throw new Error(`Missing or duplicate worktree record for ${owner}`);
    const record = this.structuralWorktree(owner, matches[0]);
    if (cwd !== undefined && resolve(cwd) !== resolve(record.cwd)) throw new Error(`Invalid worktree record for ${owner}`);
    await access(record.cwd);
    return record;
  }

  private async resolveBorrowedWorktree(binding: BorrowedWorktreeBinding, seen: Set<string>): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string }> {
    try {
      const source = await this.sourceRun(binding.sourceRunId);
      const resolved = await source.findNamedWorktree(binding.name, seen);
      if (!resolved) throw new Error(`Missing named worktree ${binding.name} in source run ${binding.sourceRunId}`);
      if (resolved.owner !== binding.owner) throw new Error(`Borrowed worktree binding does not match source owner for ${binding.name}`);
      return resolved;
    } catch (error) {
      throw error instanceof WorkflowError && error.code === "WORKTREE_FAILED" ? error : new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  private async findNamedWorktree(name: string, seen: Set<string> = new Set()): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string } | undefined> {
    const owner = this.namedWorktreeOwner(name);
    if (seen.has(this.runId)) throw new WorkflowError("WORKTREE_FAILED", "Borrowed worktree bindings contain a cycle");
    const nextSeen = new Set(seen);
    nextSeen.add(this.runId);
    const binding = await this.borrowedWorktree(name);
    if (binding) return this.resolveBorrowedWorktree(binding, nextSeen);
    const records = await json<unknown[]>(join(this.directory, "worktrees.json"));
    const matches = records.filter((candidate) => candidate && typeof candidate === "object" && (candidate as Partial<WorktreeReference>).owner === owner);
    if (matches.length === 0) return undefined;
    try {
      const reference = await this.ownedWorktree(owner);
      return { reference, sourceRunId: this.runId, owner };
    } catch (error) {
      throw new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  async resolveNamedWorktree(name: string, seen: Set<string> = new Set()): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string }> {
    const resolved = await this.findNamedWorktree(name, seen);
    if (!resolved) throw new WorkflowError("WORKTREE_FAILED", `Missing named worktree ${name}`);
    return resolved;
  }

  async validateBorrowedWorktrees(): Promise<void> {
    try {
      const loaded = await this.load();
      if (loaded.run.parentRunId !== undefined) await this.validateParentRun(loaded.run.parentRunId);
      for (const binding of await this.borrowedWorktreeRecords()) await this.resolveBorrowedWorktree(binding, new Set([this.runId]));
    } catch (error) {
      throw error instanceof WorkflowError && error.code === "WORKTREE_FAILED" ? error : new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  async ownsWorktree(owner: string): Promise<boolean> {
    const records = await json<unknown[]>(join(this.directory, "worktrees.json"));
    return records.filter((candidate) => candidate && typeof candidate === "object" && (candidate as Partial<WorktreeReference>).owner === owner).length === 1;
  }

  private async cleanupMarker(markerPath: string): Promise<void> {
    let marker: Partial<{ owner: string; path: string; branch: string; base: string }>;
    try { marker = await json(markerPath); } catch { return; }
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
      throw error instanceof WorkflowError && error.code === "WORKTREE_FAILED" ? error : new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  async worktree(owner: string): Promise<WorktreeReference> {
    const write = this.worktreeWrite.then(async () => {
      const loaded = await this.load();
      const recordsPath = join(this.directory, "worktrees.json");
      let records = await json<WorktreeReference[]>(recordsPath).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
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
      const existing = records.find((record) => record.owner === owner);
      if (existing) return this.validateWorktree(owner);
      const { path, branch } = this.expectedWorktree(owner);
      const index = join(this.directory, `index-${basename(path)}`);
      const markerPath = this.markerPath(owner);
      let branchCreated = false;
      let worktreeCreated = false;
      try {
        const root = (await git(this.cwd, ["rev-parse", "--show-toplevel"])).trim();
        const launchRelative = relative(root, this.cwd);
        if (launchRelative.startsWith("..")) throw new Error("launch cwd is outside the repository");
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
          const persisted = await json<unknown[]>(recordsPath);
          const matches = persisted.filter((candidate) => candidate && typeof candidate === "object" && (candidate as Partial<WorktreeReference>).owner === owner);
          if (matches.length === 1) { this.structuralWorktree(owner, matches[0]); records = persisted.filter((candidate) => candidate !== matches[0]) as WorktreeReference[]; await atomicJson(recordsPath, records); }
        } catch { /* Ownership changed or disappeared: do not delete anything. */ }
        throw new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
      }
    });
    this.worktreeWrite = write.then(() => undefined, () => undefined);
    return write;
  }

  private async resolveNamedWorktreeFromParent(name: string, parentRunId: string): Promise<{ reference: WorktreeReference; sourceRunId: string; owner: string } | undefined> {
    const source = await this.sourceRun(parentRunId);
    return source.findNamedWorktree(name, new Set([this.runId]));
  }

  private async bindBorrowedWorktree(binding: BorrowedWorktreeBinding): Promise<void> {
    const write = this.borrowedWorktreeWrite.then(async () => {
      const records = [...await this.borrowedWorktreeRecords(false)];
      const existing = records.find((candidate) => candidate.name === binding.name);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(binding)) throw new WorkflowError("WORKTREE_FAILED", `Borrowed worktree binding for ${binding.name} changed`);
        return;
      }
      records.push(binding);
      await atomicJson(join(this.directory, "borrowed-worktrees.json"), records);
    });
    this.borrowedWorktreeWrite = write.then(() => undefined, () => undefined);
    await write;
  }
  async snapshotWorktree(owner: string): Promise<string> {
    try {
      const write = this.snapshotWrite.then(async () => {
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
      this.snapshotWrite = write.then(() => undefined, () => undefined);
      return await write;
    } catch (error) {
      throw error instanceof WorkflowError && error.code === "WORKTREE_FAILED" ? error : new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }
  async worktrees(): Promise<readonly WorktreeReference[]> {
    const records = await json<WorktreeReference[]>(join(this.directory, "worktrees.json")).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
    const bindings = await this.borrowedWorktreeRecords();
    const boundOwners = new Set(bindings.map((binding) => binding.owner));
    const owned = await Promise.all(records.filter((record) => !boundOwners.has(record.owner)).map(async (record) => { try { return await this.validateWorktree(record.owner); } catch { return undefined; } }));
    const borrowed = await Promise.all(bindings.map(async (binding) => { try { return (await this.resolveBorrowedWorktree(binding, new Set([this.runId]))).reference; } catch { return undefined; } }));
    return [...owned.filter((record): record is WorktreeReference => record !== undefined), ...borrowed.filter((record): record is WorktreeReference => record !== undefined)];
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
    await atomicJson(path, value);
    return path;
  }

  async delete(confirmed: boolean): Promise<void> {
    if (!confirmed) throw new WorkflowError("CANCELLED", "Run deletion requires confirmation");
    const records = await json<unknown[]>(join(this.directory, "worktrees.json")).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
    const validated = records.map((record) => {
      try {
        if (!record || typeof record !== "object" || typeof (record as Partial<WorktreeReference>).owner !== "string") throw new Error("Invalid worktree record");
        return this.structuralWorktree((record as Partial<WorktreeReference>).owner as string, record);
      } catch (error) {
        throw new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
      }
    });
    await this.cleanupOrphanWorktrees();
    for (const record of validated) {
      await git(this.cwd, ["worktree", "remove", "--force", record.path]).catch(() => undefined);
      await git(this.cwd, ["branch", "-D", record.branch]).catch(() => undefined);
    }
    await rm(this.directory, { recursive: true, force: true });
  }
}

async function git(cwd: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, env: { ...process.env, ...extraEnv }, encoding: "utf8" });
  return stdout;
}
