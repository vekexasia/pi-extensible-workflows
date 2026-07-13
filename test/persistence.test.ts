import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLaunchSnapshot, DEFAULT_SETTINGS, FairAgentScheduler, WorkflowError } from "../src/index.js";
import { projectStorageKey, RunStore, structuralPath } from "../src/persistence.js";

const snapshot = createLaunchSnapshot({ script: "export const meta={name:'x',description:'x'}", args: { answer: 42 }, metadata: { name: "x", description: "x" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: ["read"], agentTypes: [], extensions: {}, schemas: [] });

function run(cwd: string, sessionId = "session-a") {
  return { id: "run-a", workflowName: "x", cwd, sessionId, state: "running" as const, agents: [], nativeSessions: [{ sessionId: "native-a", sessionFile: "/pi/sessions/native-a.jsonl" }] };
}

void test("stores exact cwd and Pi session snapshots atomically and rejects cross-session loading", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-store-"));
  const cwd = join(home, "same-name");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const loaded = await store.load();
  assert.deepEqual(loaded.snapshot.args, { answer: 42 });
  assert.equal(Object.isFrozen(loaded.snapshot.args), true);
  assert.equal(loaded.run.nativeSessions[0]?.sessionFile, "/pi/sessions/native-a.jsonl");
  await assert.rejects(new RunStore(cwd, "session-b", "run-a", home).load());
  assert.notEqual(projectStorageKey(join(home, "a", "same-name")), projectStorageKey(join(home, "b", "same-name")));
  assert.deepEqual(readFileSync(join(store.directory, "state.json"), "utf8").trim().startsWith("{"), true);
});

void test("cold reload restores persisted ownership for cascading cancellation", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-ownership-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const first = new FairAgentScheduler(async ({ signal }) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => { reject(new WorkflowError("CANCELLED", "cancelled")); }, { once: true }); }), 1, (_runId, ownership) => store.saveOwnership(ownership));
  first.restoreRun("run-a", 1, 10, [{ id: "run-a:1", label: "parent", state: "waiting_for_child", options: { label: "parent", cwd, tools: ["agent"] } }]);
  const child = first.spawn("run-a", "child", { label: "child", cwd, tools: [] }, "run-a:1");
  await first.flush();

  const reloaded = await new RunStore(cwd, "session-a", "run-a", home).loadOwnership();
  const second = new FairAgentScheduler(async () => "unused", 1);
  second.restoreRun("run-a", 1, 10, reloaded);
  second.cancel("run-a:1");
  assert.deepEqual(second.snapshot().map(({ state }) => state), ["cancelled", "cancelled"]);

  first.cancel("run-a:1");
  await child.result;
});

void test("journals stable structural paths and replays only completed operations", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-journal-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const path = structuralPath("phase/review", "parallel", "task one");
  const sibling = structuralPath("phase/review", "parallel", "task two");
  await Promise.all([store.complete(path, { result: "done" }), store.complete(sibling, 2)]);
  assert.deepEqual(await store.replay(path), { path, value: { result: "done" } });
  assert.deepEqual(await store.replay(sibling), { path: sibling, value: 2 });
  assert.equal(await store.replay(structuralPath("interrupted-parent")), undefined);
  await assert.rejects(store.complete(path, null), (error: unknown) => error instanceof WorkflowError && error.code === "DUPLICATE_NAME");
});

void test("creates deterministic snapshot worktrees, preserves launch subdirectories, and cleans up only on confirmed deletion", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-worktree-"));
  const repo = join(home, "repo");
  const cwd = join(repo, "packages", "app");
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(cwd, "tracked.txt"), "initial");
  writeFileSync(join(cwd, "deleted.txt"), "remove before launch");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(cwd, "tracked.txt"), "changed");
  rmSync(join(cwd, "deleted.txt"));
  writeFileSync(join(cwd, "untracked.txt"), "new");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const first = await store.worktree("agent/path");
  const second = await store.worktree("agent/path");
  assert.deepEqual(second, first);
  assert.equal(readFileSync(join(first.cwd, "tracked.txt"), "utf8"), "changed");
  assert.equal(readFileSync(join(first.cwd, "untracked.txt"), "utf8"), "new");
  assert.equal(existsSync(join(first.cwd, "deleted.txt")), false);
  assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), head);
  assert.equal(execFileSync("git", ["-C", first.path, "log", "-1", "--format=%an|%ae|%s"], { encoding: "utf8" }).trim(), "pi-workflows|pi-workflows@localhost|pi-workflows runtime snapshot");
  writeFileSync(join(first.cwd, "agent.txt"), "post-creation");
  await store.snapshotWorktree("agent/path");
  assert.equal(execFileSync("git", ["-C", first.path, "show", "HEAD:packages/app/agent.txt"], { encoding: "utf8" }), "post-creation");
  assert.equal(execFileSync("git", ["-C", first.path, "log", "-1", "--format=%an|%ae|%cn|%ce|%aI|%cI|%s"], { encoding: "utf8" }).trim(), "pi-workflows|pi-workflows@localhost|pi-workflows|pi-workflows@localhost|2000-01-01T00:00:00+00:00|2000-01-01T00:00:00+00:00|pi-workflows runtime snapshot");
  assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), head);
  await assert.rejects(store.delete(false), (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  assert.equal(existsSync(first.path), true);
  await store.delete(true);
  assert.equal(existsSync(first.path), false);
  assert.throws(() => execFileSync("git", ["-C", repo, "rev-parse", "--verify", first.branch], { stdio: "ignore" }));
});

void test("preserves a pre-existing deterministic branch when creation fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-branch-collision-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "initial");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  const store = new RunStore(repo, "session-a", "run-a", home);
  await store.create(run(repo), snapshot);
  const key = createHash("sha256").update("session-a\0run-a\0agent").digest("hex").slice(0, 16);
  const branch = `pi-workflows/run-a/${key}`;
  execFileSync("git", ["-C", repo, "branch", branch]);
  const commit = execFileSync("git", ["-C", repo, "rev-parse", branch], { encoding: "utf8" }).trim();
  await assert.rejects(store.worktree("agent"), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
  assert.equal(execFileSync("git", ["-C", repo, "rev-parse", branch], { encoding: "utf8" }).trim(), commit);
  assert.deepEqual(JSON.parse(readFileSync(join(store.directory, "worktrees.json"), "utf8")), []);
});

void test("cleans a created branch when worktree add fails before cwd exists", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-worktree-add-fail-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "initial");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  const store = new RunStore(repo, "session-a", "run-a", home);
  await store.create(run(repo), snapshot);
  const key = createHash("sha256").update("session-a\0run-a\0agent").digest("hex").slice(0, 16);
  const path = join(store.directory, "worktrees", key);
  const branch = `pi-workflows/run-a/${key}`;
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "block"), "worktree add");
  await assert.rejects(store.worktree("agent"), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
  assert.throws(() => execFileSync("git", ["-C", repo, "rev-parse", "--verify", branch], { stdio: "ignore" }));
  assert.deepEqual(JSON.parse(readFileSync(join(store.directory, "worktrees.json"), "utf8")), []);
});

void test("worktree creation failures are typed and never fall back", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-worktree-fail-"));
  const cwd = join(home, "not-a-repo");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  await assert.rejects(store.worktree("agent"), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
});

void test("stale persisted worktree records fail as WORKTREE_FAILED", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-stale-worktree-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "initial");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  const store = new RunStore(repo, "session-a", "run-a", home);
  await store.create(run(repo), snapshot);
  const worktree = await store.worktree("agent");
  rmSync(worktree.path, { recursive: true });
  await assert.rejects(store.worktree("agent"), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
});

void test("malicious worktree metadata cannot trigger deletion", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-malicious-worktree-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "initial");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  execFileSync("git", ["-C", repo, "branch", "keep-me"]);
  const store = new RunStore(repo, "session-a", "run-a", home);
  await store.create(run(repo), snapshot);
  const worktree = await store.worktree("agent");
  writeFileSync(join(store.directory, "worktrees.json"), `${JSON.stringify([{ ...worktree, path: repo, branch: "keep-me", cwd: repo }])}\n`);
  await assert.rejects(store.delete(true), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
  assert.equal(existsSync(repo), true);
  assert.doesNotThrow(() => execFileSync("git", ["-C", repo, "rev-parse", "--verify", "keep-me"], { stdio: "ignore" }));
  assert.equal(existsSync(worktree.path), true);
});

void test("snapshot git failures are typed as WORKTREE_FAILED", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-snapshot-fail-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "initial");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  const store = new RunStore(repo, "session-a", "run-a", home);
  await store.create(run(repo), snapshot);
  const worktree = await store.worktree("agent");
  rmSync(worktree.path, { recursive: true });
  await assert.rejects(store.snapshotWorktree("agent"), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
});

void test("deletion requires confirmation, verifies ownership, and removes only the run directory", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-delete-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const sibling = join(store.directory, "..", "not-owned.txt");
  writeFileSync(sibling, "keep");
  await assert.rejects(store.delete(false), (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  await store.delete(true);
  assert.equal(existsSync(store.directory), false);
  assert.equal(readFileSync(sibling, "utf8"), "keep");
});
