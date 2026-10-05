import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { WorkflowError } from "./types.js";
import { isNodeError } from "./utils.js";

const execute = promisify(execFile);
// ponytail: retry window is capped at 1.585s; use durable lock coordination if holders outlive it.
const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100, 200, 400, 800] as const;
const syncSleepBuffer = new Int32Array(new SharedArrayBuffer(4));
function retryableRenameError(error: unknown): boolean { return isNodeError(error, "EPERM") || isNodeError(error, "EBUSY") || isNodeError(error, "EACCES"); }
export async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try { await rename(from, to); return; }
    catch (error) {
      const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
      if (!retryableRenameError(error) || delayMs === undefined) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}
function renameSyncWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try { renameSync(from, to); return; }
    catch (error) {
      const delayMs = RENAME_RETRY_DELAYS_MS[attempt];
      if (!retryableRenameError(error) || delayMs === undefined) throw error;
      Atomics.wait(syncSleepBuffer, 0, 0, delayMs);
    }
  }
}
export const gitIdentity = {
  GIT_AUTHOR_NAME: "pi-extensible-workflows", GIT_AUTHOR_EMAIL: "pi-extensible-workflows@localhost", GIT_COMMITTER_NAME: "pi-extensible-workflows", GIT_COMMITTER_EMAIL: "pi-extensible-workflows@localhost",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
};

export function atomicWriteFile(path: string, content: string): Promise<void>;
export function atomicWriteFile(path: string, content: string, sync: true): void;
export function atomicWriteFile(path: string, content: string, sync = false): Promise<void> | void {
  const temporary = `${path}.${String(process.pid)}.${randomUUID()}.tmp`;
  if (sync) {
    try {
      writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
      renameSyncWithRetry(temporary, path);
    } catch (error) {
      try { rmSync(temporary, { force: true }); } catch { /* Preserve the original write error. */ }
      throw error;
    }
    return;
  }
  return writeFile(temporary, content, { encoding: "utf8", mode: 0o600 }).then(() => renameWithRetry(temporary, path)).catch(async (error: unknown) => {
    try { await rm(temporary, { force: true }); } catch { /* Preserve the original write error. */ }
    throw error;
  });
}

export async function atomicJson(path: string, value: unknown): Promise<void> {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new WorkflowError("INTERNAL_ERROR", `Cannot serialize JSON for ${path}`);
  await atomicWriteFile(path, `${serialized}\n`);
}

export async function atomicPrettyJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function json(path: string): Promise<unknown> { return JSON.parse(await readFile(path, "utf8")); }
export async function git(cwd: string, args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<string> {
  const { stdout } = await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgSign=false", ...args], { cwd, env: { ...process.env, ...extraEnv }, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 });
  return stdout;
}
