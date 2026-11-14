import { WorkflowError } from "./types.js";

const RESOURCE_REDIRECTS = [
  "GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_REPLACE_REF_BASE",
] as const;

/** Physical ownership must describe on-disk Git resources, not an ambient repository/index/object redirect. Git configuration remains operator policy. */
export function assertWorktreeGitEnvironment(env: NodeJS.ProcessEnv = process.env): void {
  const redirect = RESOURCE_REDIRECTS.find((key) => env[key] !== undefined);
  if (redirect) throw new WorkflowError("WORKTREE_FAILED", `Worktree ownership does not support Git resource redirect ${redirect}`);
}
