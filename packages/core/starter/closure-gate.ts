import { createHash } from "node:crypto";
import { Type } from "typebox";
import { defineWorkflowFunction, errorText } from "../src/index.js";

const GIT_TIMEOUT_MS = 120_000;

function summarisePaths(paths: readonly string[]): string {
  return paths.length <= 10 ? paths.join(", ") : `${paths.slice(0, 10).join(", ")} (and ${String(paths.length - 10)} more)`;
}

export function closureDigest(head: string, diff: string): string {
  return createHash("sha256").update(head + diff).digest("hex");
}

export const closureGate = defineWorkflowFunction({
  description: "Verify that a worktree's Git state matches the tree that was verified",
  async run(input, context) {
    const worktree = input.worktree.trim();
    if (!worktree) return { ok: false, head: "", digest: "", problems: ["worktree must be non-empty."] };
    if (/[\\/]/.test(input.worktree)) return { ok: false, head: "", digest: "", problems: ["worktree must not contain path separators."] };
    if (worktree === "." || worktree === "..") return { ok: false, head: "", digest: "", problems: ["worktree must not be a dot segment."] };

    const baseRef = input.baseRef;
    if (baseRef !== undefined) {
      if (!baseRef) return { ok: false, head: "", digest: "", problems: ["baseRef must be non-empty when supplied."] };
      if (!/^[A-Za-z0-9]/.test(baseRef)) return { ok: false, head: "", digest: "", problems: ["baseRef must start with an alphanumeric character."] };
      if (!/^[A-Za-z0-9._/@^~-]*$/.test(baseRef)) return { ok: false, head: "", digest: "", problems: ["baseRef contains disallowed characters."] };
    }
    //NOTE: HEAD is a literal we own; a caller-supplied ref is single-quoted to prevent shell expansion.
    const baseRefArgument = baseRef === undefined ? "HEAD" : `'${baseRef}'`;
    if (input.expectedDigest !== undefined && !/^[0-9a-f]+$/.test(input.expectedDigest)) return { ok: false, head: "", digest: "", problems: ["expectedDigest must be lowercase hexadecimal."] };

    try {
      return await context.withWorktree(input.worktree, async () => {
        const runGit = async (command: string, label: string, head: string) => {
          try {
            const result = await context.shell(command, { timeoutMs: GIT_TIMEOUT_MS });
            if (result.exitCode !== 0) {
              return { ok: false, head, digest: "", problems: [`${label} failed with exit code ${String(result.exitCode)}${result.stderr ? `: ${result.stderr.trim()}` : "."}`] };
            }
            return result;
          } catch (error) {
            return { ok: false, head, digest: "", problems: [`${label} failed: ${errorText(error)}`] };
          }
        };

        const headResult = await runGit("git rev-parse HEAD", "git rev-parse HEAD", "");
        if ("ok" in headResult) return headResult;
        const head = headResult.stdout.trim();
        if (head.length < 4) return { ok: false, head, digest: "", problems: ["git rev-parse HEAD returned an empty or truncated commit id."] };

        const statusResult = await runGit("git status --porcelain=v1 --untracked-files=all", "git status", head);
        if ("ok" in statusResult) return statusResult;

        const diffResult = await runGit(`git diff --no-ext-diff --no-color ${baseRefArgument} --`, "git diff", head);
        if ("ok" in diffResult) return diffResult;

        const digest = closureDigest(head, diffResult.stdout);
        const allowedUntracked = input.allowedUntracked ?? [];
        const trackedChanges = statusResult.stdout
          .split(/\r?\n/)
          .filter((line) => line.length > 0 && !line.startsWith("?? "))
          .map((line) => line.slice(3));
        const problems: string[] = [];
        if (trackedChanges.length > 0 && diffResult.stdout.trim() === "") {
          problems.push(`git diff produced no output while git status lists tracked modifications: ${summarisePaths(trackedChanges)}`);
        }
        if (trackedChanges.length > 0 && input.expectedDigest === undefined) {
          problems.push(`Tracked modifications without a pinned expectedDigest cannot establish provenance: ${summarisePaths(trackedChanges)}`);
        }
        problems.push(
          ...statusResult.stdout
            .split(/\r?\n/)
            .filter((line) => line.startsWith("?? "))
            .map((line) => line.slice(3))
            .filter((path) => !allowedUntracked.includes(path))
            .map((path) => `Untracked path is not allowed: ${path}`),
        );
        if (input.expectedDigest !== undefined && input.expectedDigest !== digest) {
          problems.push(`Expected digest ${input.expectedDigest} does not match computed digest ${digest}.`);
        }
        return { ok: problems.length === 0, head, digest, problems };
      });
    } catch (error) {
      return { ok: false, head: "", digest: "", problems: [`withWorktree failed: ${errorText(error)}`] };
    }
  },
  input: Type.Object(
    {
      worktree: Type.String(),
      baseRef: Type.Optional(Type.String()),
      allowedUntracked: Type.Optional(Type.Array(Type.String())),
      expectedDigest: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      ok: Type.Boolean(),
      head: Type.String(),
      digest: Type.String(),
      problems: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
});
