import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { JsonValue, LaunchSnapshot, RunRecord } from "./index.js";
import type { OwnershipRecord } from "./agent-execution.js";
import { createLaunchSnapshot, WorkflowError } from "./index.js";

export interface NativeSessionReference { sessionId: string; sessionFile: string }
export interface PersistedRun extends RunRecord { nativeSessions: readonly NativeSessionReference[] }
export interface CompletedOperation { path: string; value: JsonValue }
export interface AwaitingCheckpoint { path: string; name: string; prompt: string; context: JsonValue }
export type PersistedOwnershipNode = OwnershipRecord
type Journal = { completed: Record<string, CompletedOperation>; awaiting?: Record<string, AwaitingCheckpoint> };
export interface WorktreeReference { owner: string; path: string; branch: string; cwd: string; base: string }

const execute = promisify(execFile);
const gitIdentity = {
  GIT_AUTHOR_NAME: "pi-workflows", GIT_AUTHOR_EMAIL: "pi-workflows@localhost", GIT_COMMITTER_NAME: "pi-workflows", GIT_COMMITTER_EMAIL: "pi-workflows@localhost",
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

export async function listRunIds(cwd: string, sessionId: string, home = homedir()): Promise<string[]> {
  try { return (await readdir(runsDirectory(cwd, sessionId, home), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map(({ name }) => name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

export function structuralPath(...names: string[]): string {
  if (names.length === 0 || names.some((name) => name.trim() === "")) throw new WorkflowError("INVALID_METADATA", "Structural paths require non-empty explicit names");
  return names.map((name) => encodeURIComponent(name)).join("/");
}

async function atomicJson(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function json<T>(path: string): Promise<T> { return JSON.parse(await readFile(path, "utf8")) as T; }

export class RunStore {
  readonly directory: string;
  private journalWrite: Promise<void> = Promise.resolve();
  private worktreeWrite: Promise<void> = Promise.resolve();

  constructor(readonly cwd: string, readonly sessionId: string, readonly runId: string, home = homedir()) {
    this.cwd = resolve(cwd);
    this.directory = join(runsDirectory(this.cwd, sessionId, home), safePart(runId));
  }

  async create(run: PersistedRun, snapshot: Readonly<LaunchSnapshot>): Promise<void> {
    if (resolve(run.cwd) !== this.cwd || run.sessionId !== this.sessionId || run.id !== this.runId) throw new WorkflowError("INTERNAL_ERROR", "Run identity does not match its session-scoped store");
    await mkdir(dirname(this.directory), { recursive: true, mode: 0o700 });
    await mkdir(this.directory, { mode: 0o700 });
    await atomicJson(join(this.directory, "snapshot.json"), snapshot);
    await atomicJson(join(this.directory, "journal.json"), { completed: {}, awaiting: {} });
    await atomicJson(join(this.directory, "ownership.json"), []);
    await atomicJson(join(this.directory, "state.json"), run);
  }

  async load(): Promise<{ run: PersistedRun; snapshot: Readonly<LaunchSnapshot> }> {
    const run = await json<PersistedRun>(join(this.directory, "state.json"));
    if (resolve(run.cwd) !== this.cwd || run.sessionId !== this.sessionId || run.id !== this.runId) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted run belongs to another cwd or Pi session");
    return { run, snapshot: createLaunchSnapshot(await json<LaunchSnapshot>(join(this.directory, "snapshot.json"))) };
  }

  async saveState(run: PersistedRun): Promise<void> {
    if (resolve(run.cwd) !== this.cwd || run.sessionId !== this.sessionId || run.id !== this.runId) throw new WorkflowError("INTERNAL_ERROR", "Run identity does not match its session-scoped store");
    await atomicJson(join(this.directory, "state.json"), run);
  }

  async saveOwnership(nodes: readonly PersistedOwnershipNode[]): Promise<void> {
    await atomicJson(join(this.directory, "ownership.json"), nodes);
  }

  async loadOwnership(): Promise<readonly PersistedOwnershipNode[]> {
    return json<readonly PersistedOwnershipNode[]>(join(this.directory, "ownership.json"));
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

  async answerCheckpoint(name: string, approved: boolean): Promise<AwaitingCheckpoint | undefined> {
    return this.updateJournal((journal) => {
      const checkpoint = Object.values(journal.awaiting as Record<string, AwaitingCheckpoint>).find((item) => item.name === name);
      if (!checkpoint || journal.completed[checkpoint.path]) return undefined;
      journal.completed[checkpoint.path] = { path: checkpoint.path, value: approved };
      journal.awaiting = Object.fromEntries(Object.entries(journal.awaiting as Record<string, AwaitingCheckpoint>).filter(([path]) => path !== checkpoint.path));
      return checkpoint;
    });
  }

  private expectedWorktree(owner: string): Pick<WorktreeReference, "path" | "branch"> {
    const key = createHash("sha256").update(`${this.sessionId}\0${this.runId}\0${owner}`).digest("hex").slice(0, 16);
    return { path: join(this.directory, "worktrees", key), branch: `pi-workflows/${safePart(this.runId)}/${key}` };
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

  async validateWorktree(owner: string, cwd?: string): Promise<WorktreeReference> {
    try {
      await this.load();
      const records = await json<unknown[]>(join(this.directory, "worktrees.json"));
      const matches = records.filter((candidate) => candidate && typeof candidate === "object" && (candidate as Partial<WorktreeReference>).owner === owner);
      if (matches.length !== 1) throw new Error(`Missing or duplicate worktree record for ${owner}`);
      const record = this.structuralWorktree(owner, matches[0]);
      if (cwd !== undefined && resolve(cwd) !== resolve(record.cwd)) throw new Error(`Invalid worktree record for ${owner}`);
      await access(record.cwd);
      return record;
    } catch (error) {
      throw error instanceof WorkflowError && error.code === "WORKTREE_FAILED" ? error : new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  async worktree(owner: string): Promise<WorktreeReference> {
    const write = this.worktreeWrite.then(async () => {
      await this.load();
      const recordsPath = join(this.directory, "worktrees.json");
      let records = await json<WorktreeReference[]>(recordsPath).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
      const existing = records.find((record) => record.owner === owner);
      if (existing) return this.validateWorktree(owner);
      const { path, branch } = this.expectedWorktree(owner);
      const index = join(this.directory, `index-${basename(path)}`);
      let branchCreated = false;
      let worktreeCreated = false;
      try {
        const root = (await git(this.cwd, ["rev-parse", "--show-toplevel"])).trim();
        const launchRelative = relative(root, this.cwd);
        if (launchRelative.startsWith("..")) throw new Error("launch cwd is outside the repository");
        await mkdir(dirname(path), { recursive: true, mode: 0o700 });
        await git(root, ["read-tree", "HEAD"], { GIT_INDEX_FILE: index });
        await git(root, ["add", "-A"], { GIT_INDEX_FILE: index });
        const tree = (await git(root, ["write-tree"], { GIT_INDEX_FILE: index })).trim();
        const commit = (await git(root, ["commit-tree", tree, "-p", "HEAD", "-m", "pi-workflows runtime snapshot"], { GIT_INDEX_FILE: index, ...gitIdentity })).trim();
        const record = { owner, path, branch, cwd: join(path, launchRelative), base: commit };
        await atomicJson(recordsPath, [...records, record]);
        await git(root, ["branch", branch, commit]);
        branchCreated = true;
        await git(root, ["worktree", "add", "--no-checkout", path, branch]);
        worktreeCreated = true;
        await git(path, ["checkout", "--force", branch]);
        await rm(index, { force: true });
        return record;
      } catch (error) {
        try {
          const persisted = await json<unknown[]>(recordsPath);
          const matches = persisted.filter((candidate) => candidate && typeof candidate === "object" && (candidate as Partial<WorktreeReference>).owner === owner);
          if (matches.length !== 1) throw new Error(`Missing or duplicate worktree record for ${owner}`, { cause: error });
          this.structuralWorktree(owner, matches[0]);
          await rm(index, { force: true });
          if (worktreeCreated) await git(this.cwd, ["worktree", "remove", "--force", path]).catch(() => undefined);
          if (branchCreated) await git(this.cwd, ["branch", "-D", branch]).catch(() => undefined);
          records = persisted.filter((candidate) => candidate !== matches[0]) as WorktreeReference[];
          await atomicJson(recordsPath, records);
        } catch { /* Ownership changed or disappeared: do not delete anything. */ }
        throw new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
      }
    });
    this.worktreeWrite = write.then(() => undefined, () => undefined);
    return write;
  }

  async snapshotWorktree(owner: string): Promise<string> {
    try {
      const record = await this.worktree(owner);
      const write = this.worktreeWrite.then(async () => {
        await git(record.path, ["add", "-A"]);
        if ((await git(record.path, ["status", "--porcelain"])).trim()) await git(record.path, ["commit", "-m", "pi-workflows runtime snapshot"], gitIdentity);
        return (await git(record.path, ["rev-parse", "HEAD"])).trim();
      });
      this.worktreeWrite = write.then(() => undefined, () => undefined);
      return await write;
    } catch (error) {
      throw error instanceof WorkflowError && error.code === "WORKTREE_FAILED" ? error : new WorkflowError("WORKTREE_FAILED", error instanceof Error ? error.message : String(error));
    }
  }

  async changedWorktrees(): Promise<readonly WorktreeReference[]> {
    const records = await json<WorktreeReference[]>(join(this.directory, "worktrees.json")).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
    const changed: WorktreeReference[] = [];
    for (const record of records) {
      const valid = await this.validateWorktree(record.owner);
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
    await this.load();
    const records = await json<WorktreeReference[]>(join(this.directory, "worktrees.json")).catch((error: unknown) => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; });
    const validated = await Promise.all(records.map((record) => this.validateWorktree(record.owner)));
    for (const record of validated) {
      await git(this.cwd, ["worktree", "remove", "--force", record.path]);
      await git(this.cwd, ["branch", "-D", record.branch]);
    }
    await rm(this.directory, { recursive: true, force: false });
  }
}

async function git(cwd: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, env: { ...process.env, ...extraEnv }, encoding: "utf8" });
  return stdout;
}
