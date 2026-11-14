import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gitFixtureEnvironment } from "./git-fixture.js";

const redirects = ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_NAMESPACE", "GIT_SHALLOW_FILE", "GIT_GRAFT_FILE", "GIT_REPLACE_REF_BASE"];

for (const mode of ["native", "registered", "native-managed", "registered-managed", "cleanup", "missing-cleanup", "policy", "legacy"] as const) {
  void test(`worktree Git environment: ${mode} ${mode === "policy" || mode === "legacy" ? "preserves operator policy" : "rejects resource redirects before mutation"}`, { timeout: 60_000 }, () => {
    const root = mkdtempSync(join(tmpdir(), "worktree-git-environment-"));
    try {
      const env = { ...gitFixtureEnvironment(), PI_CODING_AGENT_DIR: join(root, "agent"), GIT_SSH_COMMAND: "/usr/bin/false" };
      const child = spawnSync(process.execPath, [new URL("./worktree-git-environment.fixture.js", import.meta.url).pathname, root, mode, JSON.stringify(redirects)], { env, encoding: "utf8", timeout: 55_000 });
      assert.equal(child.status, 0, `${child.stdout}\n${child.stderr}`);
      assert.match(child.stdout, /verified/);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
