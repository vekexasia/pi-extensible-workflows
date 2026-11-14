import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { OwnedCommandCleanupError } from "./owned-process.js";
import { assertWorktreeGitEnvironment } from "./worktree-git-environment.js";
import { canonicalPath } from "./paths.js";
import { WorkflowError } from "./types.js";
import { errorText, isNodeError, object } from "./utils.js";

const git = promisify(execFile);
const LEGACY_OWNER_DIRECTORY = "pi-worktree-lease";
const OWNER_FILE = "owner.json";
class AdmissionRejected extends WorkflowError { constructor(message: string) { super("WORKTREE_FAILED", message); } }
export interface WorktreeLeaseIdentity { path: string; gitDirectory: string; commonGitDirectory: string }
const options = { encoding: "utf8" as const, maxBuffer: 64 * 1024 };
export async function worktreeLeaseIdentity(path: string): Promise<WorktreeLeaseIdentity> {
  assertWorktreeGitEnvironment();
  try {
    const cwd = canonicalPath(path);
    const root = await git("git", ["-C", cwd, "rev-parse", "--show-toplevel"], options);
    const directory = await git("git", ["-C", cwd, "rev-parse", "--absolute-git-dir"], options);
    const common = await git("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"], options);
    return { path: canonicalPath(root.stdout.trim()), gitDirectory: canonicalPath(directory.stdout.trim()), commonGitDirectory: canonicalPath(common.stdout.trim()) };
  } catch { throw new WorkflowError("WORKTREE_FAILED", "Worktree lease requires an accessible Git worktree"); }
}
export function worktreeOwnerDirectory(identity: WorktreeLeaseIdentity): string {
  return join(identity.commonGitDirectory, "pi-worktree-owners", createHash("sha256").update(identity.gitDirectory).digest("hex"));
}
export function sameWorktreeLeaseIdentity(left: WorktreeLeaseIdentity, right: WorktreeLeaseIdentity): boolean {
  return left.path === right.path && left.gitDirectory === right.gitDirectory && left.commonGitDirectory === right.commonGitDirectory;
}
async function exists(path: string): Promise<boolean> {
  return lstat(path).then(() => true).catch((error: unknown) => { if (isNodeError(error, "ENOENT")) return false; throw error; });
}
/** Cleanup may corroborate a missing checkout through its still-existing Git backlink, never a guessed metadata name. */
export async function validateWorktreeLeaseIdentity(identity: WorktreeLeaseIdentity, purpose: "execution" | "cleanup"): Promise<void> {
  assertWorktreeGitEnvironment();
  if (await exists(identity.path)) {
    if (!sameWorktreeLeaseIdentity(await worktreeLeaseIdentity(identity.path), identity)) throw new AdmissionRejected("Worktree resource identity changed before admission");
  } else {
    if (purpose !== "cleanup" || !await exists(identity.gitDirectory)) throw new AdmissionRejected("Worktree resource identity can no longer be corroborated");
    const backlink = canonicalPath((await readFile(join(identity.gitDirectory, "gitdir"), "utf8")).trim());
    const common = await git("git", ["--git-dir", identity.gitDirectory, "rev-parse", "--path-format=absolute", "--git-common-dir"], options);
    if (backlink !== canonicalPath(join(identity.path, ".git")) || canonicalPath(common.stdout.trim()) !== identity.commonGitDirectory) throw new AdmissionRejected("Worktree Git backlink does not match the managed resource");
  }
  if (await exists(join(identity.gitDirectory, LEGACY_OWNER_DIRECTORY))) throw new AdmissionRejected("Git worktree already has an old-format physical owner; explicit operator recovery is required");
}

/** One external authority shared by execution and destructive cleanup; it survives linked-root/metadata removal. */
export class PhysicalWorktreeLease {
  #released = false;
  private constructor(readonly identity: WorktreeLeaseIdentity, readonly directory: string, private readonly nonce: string, private readonly inode: number) {}
  static async acquire(identity: WorktreeLeaseIdentity, diagnostics: { runId: string; sessionId: string; executionId: string }, purpose: "execution" | "cleanup" = "execution"): Promise<PhysicalWorktreeLease> {
    if (purpose === "execution" && process.platform !== "darwin" && process.platform !== "linux") throw new WorkflowError("WORKTREE_FAILED", "Worktree ownership requires macOS or Linux supervision");
    assertWorktreeGitEnvironment();
    const namespace = join(identity.commonGitDirectory, "pi-worktree-owners");
    await mkdir(namespace, { recursive: true, mode: 0o700 });
    if (canonicalPath(namespace) !== namespace || !(await lstat(namespace)).isDirectory()) throw new WorkflowError("WORKTREE_FAILED", "Worktree owner namespace is not a canonical directory");
    const directory = worktreeOwnerDirectory(identity);
    try { await mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if (isNodeError(error, "EEXIST")) throw new WorkflowError("WORKTREE_FAILED", "Git worktree already has a physical owner; explicit operator recovery is required for stale ownership");
      throw new WorkflowError("WORKTREE_FAILED", `Cannot acquire worktree ownership: ${errorText(error)}`);
    }
    let nonce: string, inode: number;
    // A failed/partial write deliberately leaves the external claim blocking.
    try {
      nonce = randomUUID();
      const claimed = await lstat(directory);
      if (!claimed.isDirectory() || claimed.isSymbolicLink()) throw new Error("claim directory changed");
      inode = claimed.ino;
      const handle = await open(join(directory, OWNER_FILE), "wx", 0o600);
      try {
        const bounded = Object.fromEntries(Object.entries(diagnostics).map(([key, value]) => [key, value.slice(0, 256)]));
        await handle.writeFile(JSON.stringify({ version: 2, nonce, pid: process.pid, purpose, identity, ...bounded }));
      } finally { await handle.close(); }
    } catch { throw new OwnedCommandCleanupError("Worktree owner record could not be durably written; external claim retained"); }
    const owner = new PhysicalWorktreeLease(identity, directory, nonce, inode);
    try { await validateWorktreeLeaseIdentity(identity, purpose); }
    catch (error) {
      // Only a proven rejection may undo this exact, fully written pre-admission claim.
      if (error instanceof AdmissionRejected) {
        try { await owner.release(); }
        catch { throw new OwnedCommandCleanupError("Rejected worktree claim could not be released; external owner retained"); }
        throw error;
      }
      throw new OwnedCommandCleanupError(`Worktree identity revalidation is unproven: ${errorText(error)}`);
    }
    return owner;
  }
  async verify(): Promise<void> {
    try {
      const directory = await lstat(this.directory), file = await lstat(join(this.directory, OWNER_FILE));
      if (!directory.isDirectory() || directory.isSymbolicLink() || directory.ino !== this.inode || !file.isFile() || file.isSymbolicLink() || file.size > 4096) throw new Error("ownership changed");
      const owner: unknown = JSON.parse(await readFile(join(this.directory, OWNER_FILE), "utf8"));
      if (!object(owner) || owner.nonce !== this.nonce || !object(owner.identity) || !sameWorktreeLeaseIdentity(owner.identity as unknown as WorktreeLeaseIdentity, this.identity)) throw new Error("ownership changed");
    } catch { throw new WorkflowError("WORKTREE_FAILED", "Worktree ownership is missing or mismatched; physical owner retained"); }
  }
  async release(): Promise<void> {
    if (this.#released) return;
    await this.verify();
    await unlink(join(this.directory, OWNER_FILE)); await rmdir(this.directory);
    this.#released = true;
  }
}
