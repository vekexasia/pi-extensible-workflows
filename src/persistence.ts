import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { homedir } from "node:os";
import type { JsonValue, LaunchSnapshot, RunRecord } from "./index.js";
import { createLaunchSnapshot, WorkflowError } from "./index.js";

export interface NativeSessionReference { sessionId: string; sessionFile: string }
export interface PersistedRun extends RunRecord { nativeSessions: readonly NativeSessionReference[] }
export interface CompletedOperation { path: string; value: JsonValue }
export interface PersistedOwnershipNode { id: string; parentId?: string; label: string; state: string }
type Journal = { completed: Record<string, CompletedOperation> };

function safePart(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_"); }

export function projectStorageKey(cwd: string): string {
  const exact = resolve(cwd);
  const slug = safePart(basename(exact)) || "root";
  return `${slug}-${createHash("sha256").update(exact).digest("hex").slice(0, 12)}`;
}

export function runsDirectory(cwd: string, sessionId: string, home = homedir()): string {
  return join(home, ".pi", "workflows", "projects", projectStorageKey(cwd), "sessions", safePart(sessionId), "runs");
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

  constructor(readonly cwd: string, readonly sessionId: string, readonly runId: string, home = homedir()) {
    this.cwd = resolve(cwd);
    this.directory = join(runsDirectory(this.cwd, sessionId, home), safePart(runId));
  }

  async create(run: PersistedRun, snapshot: Readonly<LaunchSnapshot>): Promise<void> {
    if (resolve(run.cwd) !== this.cwd || run.sessionId !== this.sessionId || run.id !== this.runId) throw new WorkflowError("INTERNAL_ERROR", "Run identity does not match its session-scoped store");
    await mkdir(dirname(this.directory), { recursive: true, mode: 0o700 });
    await mkdir(this.directory, { mode: 0o700 });
    await atomicJson(join(this.directory, "snapshot.json"), snapshot);
    await atomicJson(join(this.directory, "journal.json"), { completed: {} });
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

  async complete(path: string, value: JsonValue): Promise<void> {
    const write = this.journalWrite.then(async () => {
      const journalPath = join(this.directory, "journal.json");
      const journal = await json<Journal>(journalPath);
      if (journal.completed[path]) throw new WorkflowError("DUPLICATE_NAME", `Completed structural path already exists: ${path}`);
      journal.completed[path] = { path, value };
      await atomicJson(journalPath, journal);
    });
    this.journalWrite = write.catch(() => undefined);
    return write;
  }

  async replay(path: string): Promise<CompletedOperation | undefined> {
    return (await json<Journal>(join(this.directory, "journal.json"))).completed[path];
  }

  async delete(confirmed: boolean): Promise<void> {
    if (!confirmed) throw new WorkflowError("CANCELLED", "Run deletion requires confirmation");
    await this.load();
    await rm(this.directory, { recursive: true, force: false });
  }
}
