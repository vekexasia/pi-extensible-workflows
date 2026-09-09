import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { WorkflowError } from "./types.js";
import { isNodeError } from "./utils.js";

export function safePart(value: string): string { return value.replace(/[^a-zA-Z0-9._-]/g, "_"); }

/**
 * Resolves a path to its filesystem spelling, including symlink and platform aliases.
 * A missing path safely falls back to its absolute lexical spelling rather than
 * guessing at the identity of an object that does not exist.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

export function sameFilesystemPath(left: string, right: string): boolean { return canonicalPath(left) === canonicalPath(right); }

export function projectStorageKey(cwd: string): string {
  const exact = resolve(cwd);
  const slug = safePart(basename(exact)) || "root";
  return `${slug}-${createHash("sha256").update(exact).digest("hex").slice(0, 12)}`;
}

export function projectSessionsDirectory(cwd: string, home = homedir()): string {
  return join(home, ".pi", "workflows", "projects", projectStorageKey(cwd), "sessions");
}
export function runsDirectory(cwd: string, sessionId: string, home = homedir()): string {
  return join(projectSessionsDirectory(cwd, home), safePart(sessionId), "runs");
}
export async function listPersistedSessionIds(cwd: string, home = homedir()): Promise<string[]> {
  try {
    const entries = await readdir(projectSessionsDirectory(cwd, home), { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map(({ name }) => name);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return [];
    throw error;
  }
}

export function structuralPath(...names: string[]): string {
  if (names.length === 0 || names.some((name) => name.trim() === "")) throw new WorkflowError("INVALID_METADATA", "Structural paths require non-empty explicit names");
  return names.map((name) => encodeURIComponent(name)).join("/");
}
