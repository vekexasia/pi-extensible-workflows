import { worktreeLeaseIdentity, worktreeOwnerDirectory } from "../src/worktree-lease.js";

/** Private protocol locator shared by tests; not a public lease capability. */
export async function physicalOwnerDirectory(path: string): Promise<string> {
  return worktreeOwnerDirectory(await worktreeLeaseIdentity(path));
}
