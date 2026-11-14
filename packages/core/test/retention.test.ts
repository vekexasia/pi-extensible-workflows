import { initializeGitFixture, fixtureGitSync } from "./git-fixture.js";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, loadSettings, retainTerminalRuns, RunStore, structuralPath, type RunState } from "../src/index.js";
import { runDependencyIds } from "../src/retention.js";
import { testExtensionApi } from "./support.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = 1_000_000_000_000;
const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "retention" }, settings: DEFAULT_SETTINGS, models: [], tools: [], agentConfigurations: {}, schemas: [] });
const roots = new Set<string>();

test.afterEach(() => { for (const root of roots) rmSync(root, { recursive: true, force: true }); roots.clear(); });

function fixture(): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-retention-"));
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  roots.add(home);
  return { home, cwd };
}

async function makeRun(paths: { home: string; cwd: string }, runId: string, state: RunState, mtime: number, extra: Record<string, unknown> = {}, sessionId = "session"): Promise<RunStore> {
  const store = new RunStore(paths.cwd, sessionId, runId, paths.home);
  await store.create({ id: runId, workflowName: "retention", cwd: paths.cwd, sessionId, state, agents: [], agentSessions: [], ...extra }, snapshot);
  if (state === "completed") await store.saveResult(null);
  utimesSync(join(store.directory, "state.json"), mtime / 1000, mtime / 1000);
  return store;
}

void test("retention removes old hard-terminal runs and leaves resumable states", async () => {
  const paths = fixture();
  const old = NOW - 100 * DAY_MS;
  const completed = await makeRun(paths, "completed", "completed", old);
  const failed = await makeRun(paths, "failed", "failed", old);
  const stopped = await makeRun(paths, "stopped", "stopped", old);
  const running = await makeRun(paths, "running", "running", old);
  const interrupted = await makeRun(paths, "interrupted", "interrupted", old);
  const report = await retainTerminalRuns({ ...paths, sessionId: "session", retention: { olderThanDays: 30 }, now: NOW });
  assert.deepEqual([...report.deleted].sort(), ["completed", "failed", "stopped"]);
  assert.equal(existsSync(completed.directory), false);
  assert.equal(existsSync(failed.directory), false);
  assert.equal(existsSync(stopped.directory), false);
  assert.equal(existsSync(running.directory), true);
  assert.equal(existsSync(interrupted.directory), true);
});

void test("maxTerminalRuns keeps the newest terminal runs", async () => {
  const paths = fixture();
  const oldest = await makeRun(paths, "oldest", "failed", NOW - 3 * DAY_MS);
  const middle = await makeRun(paths, "middle", "completed", NOW - 2 * DAY_MS);
  const newest = await makeRun(paths, "newest", "stopped", NOW - DAY_MS);
  const report = await retainTerminalRuns({ ...paths, sessionId: "session", retention: { maxTerminalRuns: 2 }, now: NOW });
  assert.deepEqual(report.deleted, ["oldest"]);
  assert.equal(existsSync(oldest.directory), false);
  assert.equal(existsSync(middle.directory), true);
  assert.equal(existsSync(newest.directory), true);
});

void test("retention protects ancestors of retained non-terminal runs", async () => {
  const paths = fixture();
  const parent = await makeRun(paths, "parent", "completed", NOW - 100 * DAY_MS);
  const child = await makeRun(paths, "child", "running", NOW - 100 * DAY_MS, { parentRunId: parent.runId });
  const report = await retainTerminalRuns({ ...paths, sessionId: "session", retention: { olderThanDays: 30 }, now: NOW });
  assert.deepEqual(report.deleted, []);
  assert.equal(existsSync(parent.directory), true);
  assert.equal(existsSync(child.directory), true);
});

void test("retention settings require positive integer limits", () => {
  const paths = fixture();
  const settingsPath = join(paths.home, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ retention: { olderThanDays: 30, maxTerminalRuns: 200 } }));
  assert.deepEqual(loadSettings(settingsPath).retention, { olderThanDays: 30, maxTerminalRuns: 200 });
  for (const retention of [{ olderThanDays: 0 }, { maxTerminalRuns: -1 }, { olderThanDays: 1.5 }, { extra: 1 }]) {
    writeFileSync(settingsPath, JSON.stringify({ retention }));
    assert.throws(() => loadSettings(settingsPath), /retention|Unknown/);
  }
});

void test("session_start applies retention without blocking startup", async () => {
  const paths = fixture();
  const agentDir = join(paths.home, "agent");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ retention: { olderThanDays: 30 } }));
  const old = await makeRun(paths, "automatic", "completed", NOW - 100 * DAY_MS);
  let start: ((event: unknown, context: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool() {}, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getActiveTools: () => ["workflow"] }), paths.home, undefined, undefined, agentDir);
  assert.ok(start);
  assert.ok(shutdown);
  try {
    await start({}, { cwd: paths.cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
    for (let attempt = 0; attempt < 100 && existsSync(old.directory); attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 5));
    assert.equal(existsSync(old.directory), false);
  } finally {
    await shutdown();
  }
});

void test("automatic retention covers inactive sessions", async () => {
  const paths = fixture();
  const old = await makeRun(paths, "other-session-run", "failed", NOW - 100 * DAY_MS, {}, "other-session");
  const report = await retainTerminalRuns({ ...paths, sessionId: "session", allSessions: true, retention: { olderThanDays: 30 }, now: NOW });
  assert.deepEqual(report.deleted, ["other-session-run"]);
  assert.equal(existsSync(old.directory), false);
});

void test("retention deletes a borrower and its source after the borrowed worktree was removed by hand", async () => {
  const paths = fixture();
  const repo = join(paths.home, "repo");
  mkdirSync(repo);
  initializeGitFixture(repo);
  fixtureGitSync(["-C", repo, "-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "--allow-empty", "-m", "initial"]);
  const repoPaths = { home: paths.home, cwd: repo };
  const owner = structuralPath("worktree", "named", "shared");
  const source = await makeRun(repoPaths, "source", "completed", NOW - 100 * DAY_MS);
  const original = await source.worktree(owner);
  const child = await makeRun(repoPaths, "child", "completed", NOW - 100 * DAY_MS, { parentRunId: source.runId });
  assert.deepEqual(await child.worktree(owner), original);
  fixtureGitSync(["-C", repo, "worktree", "remove", "--force", original.path]);
  const report = await retainTerminalRuns({ ...repoPaths, sessionId: "session", retention: { olderThanDays: 30 }, now: NOW });
  assert.deepEqual([...report.deleted].sort(), ["child", "source"]);
  assert.equal(existsSync(source.directory), false);
  assert.equal(existsSync(child.directory), false);
});

void test("runDependencyIds lists the parent, retry lineage, and borrowed worktree sources once each", () => {
  assert.deepEqual(runDependencyIds({}, []), []);
  assert.deepEqual(runDependencyIds({ parentRunId: "parent" }, []), ["parent"]);
  assert.deepEqual(runDependencyIds({ parentRunId: "source", retry: { sourceRunId: "source", lineageRootRunId: "root", completedPaths: [], incompletePaths: [], namedWorktrees: [] } }, [{ name: "shared", sourceRunId: "lender", owner: "worktree/named/shared" }]), ["source", "root", "lender"]);
});

async function evidenceFixture(): Promise<{ paths: { home: string; cwd: string }; old: RunStore; sibling: RunStore; dir: string }> {
  const paths = fixture();
  const old = await makeRun(paths, "old", "failed", NOW - 100 * DAY_MS);
  const sibling = await makeRun(paths, "sibling", "failed", NOW - 100 * DAY_MS);
  await old.saveEvidence("legitimate");
  return { paths, old, sibling, dir: old.evidenceDirectory() };
}
const retain = (paths: { home: string; cwd: string }) => retainTerminalRuns({ ...paths, sessionId: "session", retention: { olderThanDays: 30 }, now: NOW });

void test("retention deletes runs with valid evidence and runs without an evidence directory", async () => {
  const { paths, old, sibling } = await evidenceFixture();
  assert.equal(existsSync(sibling.evidenceDirectory()), false);
  assert.deepEqual([...(await retain(paths)).deleted].sort(), ["old", "sibling"]);
  assert.equal(existsSync(old.directory), false);
  assert.equal(existsSync(sibling.directory), false);
});

void test("retention accepts only the exact in-flight summary write beside a run", async () => {
  const { paths, old, sibling } = await evidenceFixture();
  writeFileSync(join(old.directory, "summary.json.4242.0b2f6c1e-5d7a-4c3b-9e8f-1a2b3c4d5e6f.tmp"), "{}");
  writeFileSync(join(sibling.directory, "summary.json.4242.not-a-uuid.tmp"), "{}");
  await assert.rejects(retain(paths), /unrecognized artifact/);
  assert.equal(existsSync(old.directory), true);
  assert.equal(existsSync(sibling.directory), true);
  rmSync(join(sibling.directory, "summary.json.4242.not-a-uuid.tmp"));
  assert.deepEqual([...(await retain(paths)).deleted].sort(), ["old", "sibling"]);
});

for (const [name, tamper, message] of [
  ["invalid file name", (dir: string) => { writeFileSync(join(dir, "notes.txt"), "user content"); }, /Evidence file name is invalid/],
  ["symlink", (dir: string) => { symlinkSync("/etc/hostname", join(dir, `${"a".repeat(64)}.txt`)); }, /not a regular file/],
  ["non-regular entry", (dir: string) => { mkdirSync(join(dir, `${"b".repeat(64)}.txt`)); }, /not a regular file/],
  ["checksum tampering", (dir: string) => { writeFileSync(join(dir, readdirSync(dir)[0] ?? ""), "tampered"); }, /does not match checksum/],
] as const) {
  void test(`retention preserves every candidate when evidence has ${name}`, async () => {
    const { paths, old, sibling, dir } = await evidenceFixture();
    tamper(dir);
    await assert.rejects(retain(paths), message);
    assert.equal(existsSync(old.directory), true);
    assert.equal(existsSync(sibling.directory), true);
  });
}
