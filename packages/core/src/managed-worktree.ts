import { executeOwnedCommand } from "./owned-process.js";
import { WorkflowError, type ShellOptions } from "./types.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function managedGitCommand(args: readonly string[]): string { return ["git", ...args].map(quote).join(" "); }

/** Materialization and setup use the same quiescent process boundary as leased commands, without Git policy overrides. */
export async function runManagedWorktreeCommand(command: string, cwd: string, signal: AbortSignal, env?: Record<string, string>): Promise<string> {
  const stdout: Buffer[] = [], stderr: Buffer[] = [];
  let bytes = 0;
  const options: ShellOptions = { timeoutMs: 10 * 60 * 1000, ...(env ? { env } : {}) };
  const code = await executeOwnedCommand(command, options, signal, cwd, (target, chunk) => {
    bytes += chunk.byteLength;
    if (bytes > 10 * 1024 * 1024) throw new WorkflowError("WORKTREE_FAILED", "Managed worktree command output exceeds 10 MB");
    if (target === "stdout") stdout.push(chunk); else stderr.push(chunk);
  });
  if (code === null) throw new WorkflowError("SHELL_FAILED", "Managed worktree command terminated by signal");
  const diagnostic = Buffer.concat(stderr).toString("utf8").trim();
  if (code !== 0) throw new WorkflowError("WORKTREE_FAILED", `Managed worktree command exited with ${String(code)}${diagnostic ? `: ${diagnostic.slice(-2000)}` : ""}`);
  return Buffer.concat(stdout).toString("utf8");
}
