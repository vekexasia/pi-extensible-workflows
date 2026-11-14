import test from "node:test";
import { assertGitFixturesIsolated } from "./git-fixture-isolation.js";

void test("direct Core and standalone fixtures ignore a synthetic hostile HOME and signing policy", { timeout: 120_000 }, () => {
  assertGitFixturesIsolated([
    { url: new URL("./worktree-cleanup-exclusion.test.js", import.meta.url), pattern: "external owner survives linked", count: 1 },
    { url: new URL("./worktree-lease.test.js", import.meta.url), pattern: "physical leases collide through symlinks", count: 1 },
    { url: new URL("./managed-worktree-controls.test.js", import.meta.url), pattern: "controlled checkout preserves configured Git hooks and signing policy", count: 1 },
    { url: new URL("./persistence.test.js", import.meta.url), pattern: "creates worktrees from clean HEAD", count: 1 },
    { url: new URL("../../subagents/test/index.test.mjs", import.meta.url), pattern: "subagent worktrees receive|uses RunStore worktrees|standalone worktree preparation sees|isolates concurrent real-git", count: 4 },
  ]);
});
