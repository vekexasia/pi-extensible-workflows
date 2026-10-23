import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { worktreeDiff, worktreeHasUntracked } from "../src/agent-worktree.js";

const roots: string[] = [];
after(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); });
const git = (cwd: string, ...args: string[]): string => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function repository(): { path: string; base: string } {
  const path = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-worktree-"));
  roots.push(path);
  git(path, "init", "-q");
  git(path, "config", "user.name", "test");
  git(path, "config", "user.email", "test@example.com");
  writeFileSync(join(path, "a.txt"), "one\n");
  writeFileSync(join(path, "b.txt"), "one\n");
  git(path, "add", ".");
  git(path, "commit", "-qm", "base");
  return { path, base: git(path, "rev-parse", "HEAD") };
}

void test("the diff holds committed and uncommitted changes; untracked files are only reported", async () => {
  const { path, base } = repository();
  writeFileSync(join(path, "a.txt"), "one\ntwo\n");
  git(path, "commit", "-qam", "change");
  writeFileSync(join(path, "b.txt"), "one\nthree\n");
  const diff = await worktreeDiff({ path, base });
  assert.match(diff, /\+two/);
  assert.match(diff, /\+three/);
  assert.equal(await worktreeHasUntracked({ path }), false);
  writeFileSync(join(path, "new.txt"), "x\n");
  assert.equal(await worktreeHasUntracked({ path }), true);
});

void test("reads leave the index untouched after files change and do not fail while another git holds index.lock", { timeout: 5_000 }, async () => {
  const { path, base } = repository();
  const index = join(path, ".git", "index");
  const snapshot = (): [bigint, string] => [statSync(index, { bigint: true }).mtimeNs, readFileSync(index, "hex")];
  // a.txt changes only its stat, b.txt its content: a read that refreshed the index would write it.
  utimesSync(join(path, "a.txt"), 1_000_000_000, 1_000_000_000);
  writeFileSync(join(path, "b.txt"), "one\nthree\n");
  const before = snapshot();
  const reads = async (): Promise<void> => {
    assert.match(await worktreeDiff({ path, base }), /\+three/);
    assert.equal(await worktreeHasUntracked({ path }), false);
  };
  await reads();
  assert.deepEqual(snapshot(), before);
  // The test's timeout is half the reads' git timeout: a read that waits for the lock fails it.
  writeFileSync(`${index}.lock`, "");
  await reads();
  assert.deepEqual(snapshot(), before);
});

void test("the diff for the editor ignores a configured external diff and color", async () => {
  const { path, base } = repository();
  git(path, "config", "diff.external", "false");
  git(path, "config", "color.ui", "always");
  writeFileSync(join(path, "a.txt"), "one\ntwo\n");
  const diff = await worktreeDiff({ path, base });
  assert.match(diff, /^diff --git /);
  assert.equal(diff.includes("\u001b"), false);
  assert.match(diff, /\+two/);
});
