import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { atomicWriteFile } from "../../src/io.js";
import { isNodeError, object, positiveInteger } from "../../src/utils.js";

// Every change to the Trajectory lock happens while holding this mutex: a Pi checking, replacing, or starting a server, and a server publishing or removing its lock.
// Each contender writes its own holder file, then looks for any other live holder and backs off if it finds one. Of two contenders at least one sees the other, so both never proceed,
// and a dead holder's file is unique to it, so removing it needs no compare-and-delete.
type ProcessIdentity = { pid: number; start?: string };
type StartupHolder = ProcessIdentity & { token: string; server?: ProcessIdentity };

let bootId: string | undefined;
// The boot id and the start time in clock ticks never change for a process and differ for any later process reusing its pid.
// The /proc/<pid> ctime does not qualify: it records when that entry was looked up, and the kernel can recreate the entry.
export function processStart(pid: number): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    bootId ??= readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    const stat = readFileSync(`/proc/${String(pid)}/stat`, "utf8");
    // The command name can contain spaces and parentheses, so fields are counted after its last closing parenthesis: field 22 is the start time.
    const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    return startTicks === undefined || !/^\d+$/.test(startTicks) ? undefined : `${bootId}:${startTicks}`;
  } catch { return undefined; }
}
// Unverified is not dead: an existing pid whose start was never recorded or cannot be read counts as alive.
//NOTE: without /proc (macOS, Windows) only the pid is checked, so a pid reused by an unrelated process keeps blocking until that process exits.
export function processLive(identity: ProcessIdentity): boolean {
  try { process.kill(identity.pid, 0); } catch (error) { if (isNodeError(error, "ESRCH")) return false; }
  if (identity.start === undefined) return true;
  const current = processStart(identity.pid);
  return current === undefined || current === identity.start;
}
// Only a recorded start that still matches proves the pid is that process; nothing less authorises a signal.
export function processConfirmed(identity: ProcessIdentity): boolean {
  return identity.start !== undefined && processStart(identity.pid) === identity.start;
}

function holderDirectory(lockPath: string): string { return `${lockPath}.startup`; }
function holderPath(lockPath: string, token: string): string { return join(holderDirectory(lockPath), `${token}.json`); }
export function identityOf(pid: number): ProcessIdentity {
  const start = processStart(pid);
  return start === undefined ? { pid } : { pid, start };
}
function processIdentity(value: unknown): ProcessIdentity | undefined {
  if (!object(value) || !positiveInteger(value.pid)) return undefined;
  return typeof value.start === "string" ? { pid: value.pid, start: value.start } : { pid: value.pid };
}
function decodeHolder(text: string): StartupHolder | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    const holder = processIdentity(parsed);
    if (holder === undefined || !object(parsed) || typeof parsed.token !== "string") return undefined;
    const server = processIdentity(parsed.server);
    return { ...holder, token: parsed.token, ...(server === undefined ? {} : { server }) };
  } catch { return undefined; }
}

export function readStartupHolder(lockPath: string, token: string): StartupHolder | undefined {
  try { return decodeHolder(readFileSync(holderPath(lockPath, token), "utf8")); }
  catch (error) { if (isNodeError(error, "ENOENT")) return undefined; throw error; }
}

// A holder's server can still publish its lock until it has done so or exited; a lock that cannot be read leaves that unknown, so the error is thrown.
async function serverPending(lockPath: string, server: ProcessIdentity): Promise<boolean> {
  if (!processLive(server)) return false;
  let text: string;
  try { text = await readFile(lockPath, "utf8"); }
  catch (error) { if (isNodeError(error, "ENOENT")) return true; throw error; }
  try {
    const lock: unknown = JSON.parse(text);
    return !(object(lock) && lock.pid === server.pid);
  } catch { return true; }
}
async function holderLive(lockPath: string, path: string, read: StartupHolder): Promise<boolean> {
  if (processLive(read)) return true;
  // The holder may have recorded its server after it was read; once its Pi is dead the file can no longer change, so this read is final.
  let holder: StartupHolder | undefined;
  try { holder = decodeHolder(await readFile(path, "utf8")); }
  catch (error) { if (isNodeError(error, "ENOENT")) return false; throw error; }
  if (holder?.server === undefined || !await serverPending(lockPath, holder.server)) return false;
  // Its Pi died mid-startup; the server it recorded is stopped so it can never publish over the next holder's lock.
  // An unconfirmed pid may now be an unrelated process, so it is left alone and the holder stays held until that pid exits.
  if (!processConfirmed(holder.server)) return true;
  try { process.kill(holder.server.pid, "SIGKILL"); }
  catch (error) { if (!isNodeError(error, "ESRCH")) throw error; }
  return true;
}

export async function tryAcquireStartupMutex(lockPath: string): Promise<string | undefined> {
  const directory = holderDirectory(lockPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const own = `${token}.json`;
  await atomicWriteFile(join(directory, own), `${JSON.stringify({ ...identityOf(process.pid), token })}\n`);
  let contended = false;
  try {
    for (const name of await readdir(directory)) {
      if (name === own || !name.endsWith(".json")) continue;
      const path = join(directory, name);
      let holder: StartupHolder | undefined;
      try { holder = decodeHolder(await readFile(path, "utf8")); }
      catch (error) { if (isNodeError(error, "ENOENT")) continue; throw error; }
      if (holder !== undefined && await holderLive(lockPath, path, holder)) contended = true;
      else await rm(path, { force: true });
    }
  } catch (error) {
    // A holder file left by a failed attempt would block every later start until this Pi exits.
    await rm(join(directory, own), { force: true });
    throw error;
  }
  if (!contended) return token;
  await rm(join(directory, own), { force: true });
  return undefined;
}

// Called right after spawning, so the mutex stays held while that server can still publish, even if this Pi dies.
export function recordStartupServer(lockPath: string, token: string, pid: number): void {
  const holder = readStartupHolder(lockPath, token);
  if (holder === undefined) throw new Error("Trajectory startup mutex was lost");
  atomicWriteFile(holderPath(lockPath, token), `${JSON.stringify({ ...holder, server: identityOf(pid) })}\n`, true);
}

export async function releaseStartupMutex(lockPath: string, token: string): Promise<void> {
  await rm(holderPath(lockPath, token), { force: true });
}
