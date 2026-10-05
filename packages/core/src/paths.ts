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
 * The operating system's resolver is authoritative so Windows drive-letter, case,
 * and junction aliases converge on one physical spelling; the portable resolver
 * only covers volumes where the native resolver cannot open the object.
 * A missing path safely falls back to its absolute lexical spelling rather than
 * guessing at the identity of an object that does not exist.
 */
export function canonicalPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync.native(absolute); } catch (error) {
    if (isNodeError(error, "ENOENT") || isNodeError(error, "ENOTDIR")) return absolute;
  }
  try { return realpathSync(absolute); } catch { return absolute; }
}

/** Pi names built-in extensions `builtin:<name>` instead of by a path; other extensions are files. */
export function extensionIdentity(path: string): string { return path.startsWith("builtin:") ? path : canonicalPath(path); }

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
