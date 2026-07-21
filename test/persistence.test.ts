import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { acquireSessionLease, createLaunchSnapshot, DEFAULT_SETTINGS, FairAgentScheduler, WorkflowError } from "../src/index.js";
import { listRunIds, projectStorageKey, RunStore, runsDirectory, structuralPath } from "../src/persistence.js";

const snapshot = createLaunchSnapshot({ script: "export const meta={name:'x',description:'x'}", args: { answer: 42 }, metadata: { name: "x", description: "x" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: ["read"], agentTypes: [], schemas: [] });

function run(cwd: string, sessionId = "session-a") {
  return { id: "run-a", workflowName: "x", cwd, sessionId, state: "running" as const, agents: [], nativeSessions: [{ sessionId: "native-a", sessionFile: "/pi/sessions/native-a.jsonl" }] };
}

void test("session leases reject live owners and reclaim dead owners", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-lease-"));
  const cwd = join(home, "project");
  const lease = await acquireSessionLease(cwd, "session-a", home);
  await assert.rejects(acquireSessionLease(cwd, "session-a", home), (error: unknown) => error instanceof WorkflowError && error.code === "RUN_OWNED");
  await lease.release();
  writeFileSync(join(runsDirectory(cwd, "session-a", home), "owner.json"), JSON.stringify({ pid: 2147483647, token: "dead", startedAt: 0 }));
  const reclaimed = await acquireSessionLease(cwd, "session-a", home);
  await reclaimed.release();
  if (process.platform === "linux") {
    writeFileSync(join(runsDirectory(cwd, "session-a", home), "owner.json"), JSON.stringify({ pid: process.pid, token: "reused", startedAt: 0 }));
    const pidReused = await acquireSessionLease(cwd, "session-a", home);
    await pidReused.release();
  }
  writeFileSync(join(runsDirectory(cwd, "session-a", home), "owner.json"), "{");
  utimesSync(join(runsDirectory(cwd, "session-a", home), "owner.json"), new Date(0), new Date(0));
  const invalidReclaimed = await acquireSessionLease(cwd, "session-a", home);
  await invalidReclaimed.release();
});
void test("cleans orphaned run creation directories without listing them as runs", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-run-temp-"));
  const cwd = join(home, "project");
  const directory = runsDirectory(cwd, "session-a", home);
  mkdirSync(directory, { recursive: true });
  const orphan = join(directory, ".run-a.2147483647.00000000-0000-0000-0000-000000000000.tmp");
  mkdirSync(orphan);
  assert.deepEqual(await listRunIds(cwd, "session-a", home), []);
  assert.equal(existsSync(orphan), false);
});

void test("partial run directories do not block sibling loading or deletion", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-partial-"));
  const cwd = join(home, "project");
  const partial = new RunStore(cwd, "session-a", "partial", home);
  mkdirSync(partial.directory, { recursive: true });
  writeFileSync(join(partial.directory, "state.json"), "{}\n");
  const sibling = new RunStore(cwd, "session-a", "sibling", home);
  await sibling.create({ id: "sibling", workflowName: "x", cwd, sessionId: "session-a", state: "running", agents: [], nativeSessions: [] }, snapshot);
  assert.deepEqual((await listRunIds(cwd, "session-a", home)).sort(), ["partial", "sibling"]);
  assert.equal((await sibling.load()).run.id, "sibling");
  await partial.delete(true);
  assert.equal(existsSync(partial.directory), false);
});

void test("reclaims an orphaned worktree transaction before retrying", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-worktree-recovery-"));
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
  const branch = `pi-extensible-workflows/run-a/${key}`;
  const base = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  execFileSync("git", ["-C", repo, "branch", branch, base]);
  writeFileSync(join(store.directory, `worktree-${key}.creating`), JSON.stringify({ owner: "agent", path, branch, base }));
  const worktree = await store.worktree("agent");
  assert.equal(worktree.path, path);
  const records = JSON.parse(readFileSync(join(store.directory, "worktrees.json"), "utf8")) as Array<{ owner: string }>;
  assert.equal(records[0]?.owner, "agent");
});
void test("worktreeState reads fresh Git state from validated named and unnamed worktrees", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-worktree-state-"));
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
  const namedOwner = "worktree/named/issue-83";
  const named = await store.worktree(namedOwner);
  const clean = await store.worktreeState(namedOwner);
  assert.deepEqual(clean, { name: "issue-83", path: named.path, branch: named.branch, base: named.base, head: named.base, dirty: false });
  writeFileSync(join(named.cwd, "untracked.txt"), "untracked");
  const dirty = await store.worktreeState(namedOwner);
  assert.equal(dirty.head, named.base);
  assert.equal(dirty.dirty, true);
  const unnamedOwner = "worktree/unnamed/scope";
  const unnamed = await store.worktree(unnamedOwner);
  const unnamedState = await store.worktreeState(unnamedOwner);
  assert.equal(unnamedState.name, undefined);
  assert.equal(unnamedState.path, unnamed.path);
  assert.equal(unnamedState.branch, unnamed.branch);
  assert.equal(unnamedState.base, unnamed.base);
});
void test("stores exact cwd and Pi session snapshots atomically and rejects cross-session loading", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-store-"));
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
void test("persists exact multiline Unicode workflow source without rewriting it", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-workflow-source-"));
  const cwd = join(home, "project");
  const script = "const message = 'café 日本語 👩‍💻';\r\n\nreturn message;\r\n";
  const launch = createLaunchSnapshot({ ...snapshot, script });
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), launch);
  const workflowPath = join(store.directory, "workflow.js");
  assert.equal(readFileSync(workflowPath, "utf8"), script);
  await store.updateState((current) => ({ ...current, phase: "paused" }));
  await store.awaitCheckpoint({ path: "checkpoint/ship", name: "ship", prompt: "Ship?", context: null });
  assert.equal(readFileSync(workflowPath, "utf8"), script);
});
void test("loads and resumes legacy runs without workflow.js", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-legacy-run-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ ...run(cwd), state: "interrupted" }, snapshot);
  rmSync(join(store.directory, "workflow.js"));
  assert.equal(await store.isComplete(), true);
  const loaded = await new RunStore(cwd, "session-a", "run-a", home).load();
  assert.equal(loaded.run.state, "interrupted");
  assert.equal(loaded.snapshot.script, snapshot.script);
  await store.updateState((current) => ({ ...current, state: "running" }));
  const resumed = await store.load();
  assert.equal(resumed.run.state, "running");
  assert.equal(resumed.snapshot.script, snapshot.script);
});
void test("persists exact effective system prompts as private run artifacts", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-system-prompts-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const prompts = ["BASE\n\nROLE: α", "BASE\n\nROLE: β"];
  await Promise.all(prompts.map((prompt, index) => store.recordSystemPrompt({ sessionId: "native-a", attempt: 1, turn: index + 1, prompt })));
  const saved = await new RunStore(cwd, "session-a", "run-a", home).systemPrompts();
  assert.deepEqual(saved, prompts.map((prompt, index) => ({ sessionId: "native-a", attempt: 1, turn: index + 1, sha256: createHash("sha256").update(prompt).digest("hex"), prompt })));
  assert.equal(statSync(store.systemPromptPath()).mode & 0o777, 0o600);
});
void test("persists conversation heads and rejects non-sequential continuation", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-conversations-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const head = { turn: 1, sessionId: "native-a", sessionFile: "/pi/sessions/native-a.jsonl", leafId: "leaf-1", systemPrompt: "SYSTEM", systemPromptSha256: createHash("sha256").update("SYSTEM").digest("hex"), toolDefinitionsSha256: "tools" };
  await store.saveConversation({ id: "developer", policy: { model: "openai/gpt", tools: ["read"] }, head });
  assert.deepEqual(await new RunStore(cwd, "session-a", "run-a", home).conversation("developer"), { id: "developer", policy: { model: "openai/gpt", tools: ["read"] }, head });
  await assert.rejects(store.saveConversation({ id: "developer", policy: { model: "openai/gpt", tools: ["read"] }, head: { ...head, turn: 3, leafId: "leaf-3" } }), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
});
void test("serializes concurrent state updates without losing fields", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-state-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  await Promise.all([
    store.updateState((current) => ({ ...current, phase: "review" })),
    store.updateState((current) => ({ ...current, error: { code: "AGENT_FAILED", message: "boom" } })),
  ]);
  const saved = (await store.load()).run;
  assert.equal(saved.phase, "review");
  assert.deepEqual(saved.error, { code: "AGENT_FAILED", message: "boom" });
});
void test("deduplicates run events by type and message", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-event-dedup-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  await store.appendEvent({ type: "warning", message: "same message" });
  await store.appendEvent({ type: "info", message: "same message" });
  await store.appendEvent({ type: "warning", message: "same message" });
  assert.deepEqual((await store.load()).run.events, [{ type: "warning", message: "same message" }, { type: "info", message: "same message" }]);
});

void test("cold reload restores persisted ownership for cascading cancellation", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-ownership-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const first = new FairAgentScheduler(async ({ signal }) => new Promise((_resolve, reject) => { signal.addEventListener("abort", () => { reject(new WorkflowError("CANCELLED", "cancelled")); }, { once: true }); }), 1, (_runId, ownership) => store.saveOwnership(ownership));
  first.restoreRun("run-a", 1, [{ id: "run-a:1", label: "parent", state: "waiting_for_child", options: { label: "parent", cwd, tools: ["agent"] } }]);
  const child = first.spawn("run-a", "child", { label: "child", cwd, tools: [] }, "run-a:1");
  await first.flush();

  const reloaded = await new RunStore(cwd, "session-a", "run-a", home).loadOwnership();
  const second = new FairAgentScheduler(async () => "unused", 1);
  second.restoreRun("run-a", 1, reloaded);
  second.cancel("run-a:1");
  assert.deepEqual(second.snapshot().map(({ state }) => state), ["cancelled", "cancelled"]);

  first.cancel("run-a:1");
  await child.result;
});

void test("journals stable structural paths and replays only completed operations", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-journal-"));
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

void test("persists awaiting checkpoints and atomically accepts only the first answer", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-checkpoint-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const checkpoint = { path: structuralPath("checkpoint", "ship"), name: "ship", prompt: "Ship?", context: { sha: "abc" } };
  assert.equal(await store.awaitCheckpoint(checkpoint), undefined);
  assert.deepEqual(await new RunStore(cwd, "session-a", "run-a", home).awaitingCheckpoints(), [checkpoint]);
  const answers = await Promise.all([store.answerCheckpoint("ship", true), store.answerCheckpoint("ship", false)]);
  assert.equal(answers.filter(Boolean).length, 1);
  assert.deepEqual(await store.replay(checkpoint.path), { path: checkpoint.path, value: true });
  assert.equal(await store.awaitCheckpoint(checkpoint), true);
  assert.deepEqual(await store.awaitingCheckpoints(), []);
});

void test("creates deterministic snapshot worktrees, preserves launch subdirectories, and cleans up only on confirmed deletion", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-worktree-"));
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
  assert.equal(execFileSync("git", ["-C", first.path, "log", "-1", "--format=%an|%ae|%s"], { encoding: "utf8" }).trim(), "pi-extensible-workflows|pi-extensible-workflows@localhost|pi-extensible-workflows runtime snapshot");
  assert.deepEqual(await store.changedWorktrees(), []);
  writeFileSync(join(first.cwd, "agent.txt"), "post-creation");
  await store.snapshotWorktree("agent/path");
  assert.deepEqual(await store.changedWorktrees(), [first]);
  assert.equal(execFileSync("git", ["-C", first.path, "show", "HEAD:packages/app/agent.txt"], { encoding: "utf8" }), "post-creation");
  assert.equal(execFileSync("git", ["-C", first.path, "log", "-1", "--format=%an|%ae|%cn|%ce|%at|%ct|%s"], { encoding: "utf8" }).trim(), "pi-extensible-workflows|pi-extensible-workflows@localhost|pi-extensible-workflows|pi-extensible-workflows@localhost|946684800|946684800|pi-extensible-workflows runtime snapshot");
  assert.equal(execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), head);
  await assert.rejects(store.delete(false), (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  assert.equal(existsSync(first.path), true);
  await store.delete(true);
  assert.equal(existsSync(first.path), false);
  assert.throws(() => execFileSync("git", ["-C", repo, "rev-parse", "--verify", first.branch], { stdio: "ignore" }));
});

void test("reuses named worktrees through durable follow-up bindings without deleting borrowed checkouts", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-borrowed-worktree-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "initial");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  const owner = structuralPath("worktree", "named", "banana");
  const source = new RunStore(repo, "session-a", "source", home);
  await source.create({ ...run(repo), id: "source", state: "completed" }, snapshot);
  const original = await source.worktree(owner);
  const first = new RunStore(repo, "session-a", "follow-up", home);
  await first.create({ ...run(repo), id: "follow-up", parentRunId: "source", state: "completed" }, snapshot);
  const reused = await first.worktree(owner);
  assert.deepEqual(reused, original);
  assert.equal(await first.ownsWorktree(owner), false);
  assert.deepEqual(await first.borrowedWorktrees(), [{ name: "banana", sourceRunId: "source", owner }]);
  const missing = await first.worktree(structuralPath("worktree", "named", "apple"));
  assert.notEqual(missing.path, original.path);
  assert.equal(await first.ownsWorktree(structuralPath("worktree", "named", "apple")), true);
  const second = new RunStore(repo, "session-a", "second-follow-up", home);
  await second.create({ ...run(repo), id: "second-follow-up", parentRunId: "follow-up", state: "completed" }, snapshot);
  assert.deepEqual(await second.worktree(owner), original);
  assert.equal(existsSync(original.path), true);
  await second.validateBorrowedWorktrees();
  await first.delete(true);
  assert.equal(existsSync(original.path), true);
  await source.delete(true);
  await assert.rejects(second.validateBorrowedWorktrees(), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
  await second.delete(true);
});

void test("preserves a pre-existing deterministic branch when creation fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-branch-collision-"));
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
  const branch = `pi-extensible-workflows/run-a/${key}`;
  execFileSync("git", ["-C", repo, "branch", branch]);
  const commit = execFileSync("git", ["-C", repo, "rev-parse", branch], { encoding: "utf8" }).trim();
  await assert.rejects(store.worktree("agent"), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
  assert.equal(execFileSync("git", ["-C", repo, "rev-parse", branch], { encoding: "utf8" }).trim(), commit);
  assert.deepEqual(JSON.parse(readFileSync(join(store.directory, "worktrees.json"), "utf8")), []);
});

void test("cleans a created branch when worktree add fails before cwd exists", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-worktree-add-fail-"));
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
  const branch = `pi-extensible-workflows/run-a/${key}`;
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "block"), "worktree add");
  await assert.rejects(store.worktree("agent"), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
  assert.throws(() => execFileSync("git", ["-C", repo, "rev-parse", "--verify", branch], { stdio: "ignore" }));
  assert.deepEqual(JSON.parse(readFileSync(join(store.directory, "worktrees.json"), "utf8")), []);
});

void test("worktree creation failures are typed and never fall back", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-worktree-fail-"));
  const cwd = join(home, "not-a-repo");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  await assert.rejects(store.worktree("agent"), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
});

void test("stale persisted worktree records fail as WORKTREE_FAILED", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-stale-worktree-"));
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
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-malicious-worktree-"));
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
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-snapshot-fail-"));
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
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-delete-"));
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
