import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { WorkflowError } from "./types.js";
import { isNodeError } from "./utils.js";
import { decodeSessionOwner, type SessionOwner } from "./decoders.js";
import { json } from "./io.js";
import { runsDirectory } from "./paths.js";

const SESSION_OWNER_FILE = "owner.json";
const SESSION_OWNER_WRITE_GRACE_MS = 30_000;
const RUN_CREATE_TEMP = /^\.([a-zA-Z0-9._-]+)\.(\d+)\.[0-9a-f-]+\.tmp$/;

export async function processAlive(pid: number, startedAt?: number): Promise<boolean> {
  try { process.kill(pid, 0); } catch (error) { return !isNodeError(error, "ESRCH"); }
  if (startedAt !== undefined && process.platform === "linux") {
    try { if ((await stat(`/proc/${String(pid)}`)).ctimeMs > startedAt) return false; }
    catch (error) { if (isNodeError(error, "ENOENT")) return false; }
  }
  return true;
}
export async function hasLiveSessionLease(cwd: string, sessionId: string, home = homedir()): Promise<boolean> {
  const path = join(runsDirectory(cwd, sessionId, home), SESSION_OWNER_FILE);
  let owner: unknown;
  try { owner = await json(path); }
  catch (error) { if (isNodeError(error, "ENOENT")) return false; throw error; }
  const candidate = decodeSessionOwner(owner);
  if (!candidate) throw new WorkflowError("RUN_OWNED", `Pi session ${sessionId} has an invalid ownership lease`);
  return processAlive(candidate.pid, candidate.startedAt);
}

function sameOwner(left: SessionOwner | undefined, right: SessionOwner | undefined): boolean {
  if (left === undefined || right === undefined) return false;
  return left.pid === right.pid && left.token === right.token;
}

async function restoreLease(path: string, stale: string): Promise<void> {
  try { await link(stale, path); }
  catch (error) {
    if (!isNodeError(error, "EEXIST") && !isNodeError(error, "ENOENT")) throw error;
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
      const owner = decodeSessionOwner(await json(this.path));
      if (owner?.token === this.token) await rm(this.path, { force: true });
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
}

export async function acquireSessionLease(cwd: string, sessionId: string, home = homedir()): Promise<SessionLease> {
  const directory = runsDirectory(cwd, sessionId, home);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, SESSION_OWNER_FILE);
  for (;;) {
    const token = randomUUID();
    const owner: SessionOwner = { pid: process.pid, token, startedAt: process.platform === "linux" ? (await stat(`/proc/${String(process.pid)}`)).ctimeMs : Date.now() };
    try {
      const handle = await open(path, "wx", 0o600);
      try { await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8"); } finally { await handle.close(); }
      return new SessionLease(path, token);
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
      let existingOwner: SessionOwner | undefined;
      let existingText = "";
      try {
        existingText = await readFile(path, "utf8");
        existingOwner = decodeSessionOwner(JSON.parse(existingText));
        if (existingOwner && await processAlive(existingOwner.pid, existingOwner.startedAt)) throw new WorkflowError("RUN_OWNED", `Pi session ${sessionId} is already owned by process ${String(existingOwner.pid)}`);
      } catch (readError) {
        if (readError instanceof WorkflowError) throw readError;
        if (isNodeError(readError, "ENOENT")) continue;
        existingOwner = undefined;
      }
      if (existingOwner === undefined) {
        const age = await stat(path).then((value) => Date.now() - value.mtimeMs).catch(() => 0);
        if (age < SESSION_OWNER_WRITE_GRACE_MS) throw new WorkflowError("RUN_OWNED", `Pi session ${sessionId} has an active ownership lease`);
      }
      const stale = `${path}.${randomUUID()}.stale`;
      try {
        await rename(path, stale);
        const movedText = await readFile(stale, "utf8");
        let movedOwner: SessionOwner | undefined;
        try { movedOwner = decodeSessionOwner(JSON.parse(movedText)); } catch { movedOwner = undefined; }
        if (movedOwner === undefined) {
          if (movedText === existingText) await rm(stale, { force: true });
          else await restoreLease(path, stale);
          continue;
        }
        if (!sameOwner(existingOwner, movedOwner)) { await restoreLease(path, stale); continue; }
        await rm(stale, { force: true });
      }
      catch (reclaimError) { if (isNodeError(reclaimError, "ENOENT")) continue; throw reclaimError; }
    }
  }
}

export async function listRunIds(cwd: string, sessionId: string, home = homedir(), cleanTemps = true): Promise<string[]> {
  const directory = runsDirectory(cwd, sessionId, home);
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    if (cleanTemps) await cleanupRunTemps(directory, entries);
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map(({ name }) => name);
  }
  catch (error) { if (isNodeError(error, "ENOENT")) return []; throw error; }
}
