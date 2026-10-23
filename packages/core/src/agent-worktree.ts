import { git as runGit } from "./io.js";
import type { WorktreeReference } from "./persistence.js";

const GIT_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 64 * 1024 * 1024;

// The agent may be running `git add -A` in this worktree: a read neither takes index.lock nor refreshes the index.
function git(path: string, args: readonly string[]): Promise<string> {
  return runGit(path, ["--no-optional-locks", "-c", "diff.autoRefreshIndex=false", ...args], {}, { timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BUFFER });
}

/** The full `git diff` of the worktree against its base. */
export function worktreeDiff(reference: Pick<WorktreeReference, "path" | "base">): Promise<string> {
  return git(reference.path, ["diff", "--no-ext-diff", "--no-color", reference.base, "--"]);
}

/** Whether the worktree holds files git does not track and does not ignore; `git diff` leaves them out. */
export async function worktreeHasUntracked(reference: Pick<WorktreeReference, "path">): Promise<boolean> {
  return (await git(reference.path, ["ls-files", "--others", "--exclude-standard"])).trim() !== "";
}
