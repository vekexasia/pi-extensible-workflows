import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, renameSync, rmSync, utimesSync, writeFileSync, existsSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createLaunchSnapshot, DEFAULT_SETTINGS, type RunState } from "pi-extensible-workflows";
import { acquireSessionLease, RunStore, structuralPath } from "pi-extensible-workflows/persistence";
import { doctorCleanup } from "../src/doctor-cleanup.js";
import { runCli } from "../src/cli.js";
import { hasFileSymlinkCapability, readCliTestPersistedRun, readCliTestSessionOwner } from "./support.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const snapshot = createLaunchSnapshot({ script: "export const meta={name:'cleanup'}", args: {}, metadata: { name: "cleanup" }, settings: DEFAULT_SETTINGS, models: [], tools: [], agentTypes: [], schemas: [] });

const temporaryTrees = new Set<string>();
function fixture(): { home: string; cwd: string } { const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-cleanup-")); const cwd = join(home, "project"); mkdirSync(cwd, { recursive: true }); temporaryTrees.add(home); return { home, cwd }; }
test.afterEach(() => { for (const home of temporaryTrees) rmSync(home, { recursive: true, force: true }); temporaryTrees.clear(); });
async function withHomeAndCwd<T>(home: string, cwd: string, action: () => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const previousUserProfile = process.env.USERPROFILE;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.chdir(cwd);
  try { return await action(); }
  finally {
    process.chdir(previousCwd);
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousUserProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousUserProfile;
  }
}
async function makeRun(paths: { home: string; cwd: string }, runId: string, state: RunState, now: number, extra: Record<string, unknown> = {}, sessionId = "session-a"): Promise<RunStore> {
  const store = new RunStore(paths.cwd, sessionId, runId, paths.home);
  await store.create({ id: runId, workflowName: "cleanup", cwd: paths.cwd, sessionId, state, agents: [], agentSessions: [], ...extra }, snapshot);
  if (state === "completed") await store.saveResult(null);
  const old = now - 100 * DAY_MS;
  utimesSync(join(store.directory, "state.json"), old / 1000, old / 1000);
  return store;
}

void test("piewf doctor cleanup --yes deletes a clean inventory and formats its report", async () => {
  const paths = fixture();
  const old = await makeRun(paths, "old", "completed", Date.now());
  const userFile = join(paths.home, "keep.txt");
  writeFileSync(userFile, "preserve me\n");
  let output = "";
  const exit = await withHomeAndCwd(paths.home, paths.cwd, () => runCli(["doctor", "cleanup", "--yes"], { cwd: paths.cwd }, (text) => { output += text; }));
  assert.equal(exit, 0);
  assert.match(output, /^# pi-extensible-workflows doctor cleanup/);
  assert.match(output, /Mode: confirmed deletion/);
  assert.match(output, /## Deleted[\s\S]*run=old/);
  assert.match(output, /0 failure\(s\)/);
  assert.equal(existsSync(old.directory), false);
  assert.equal(readFileSync(userFile, "utf8"), "preserve me\n");
});

void test("piewf doctor cleanup --yes returns failure and preserves a corrupt inventory", async () => {
  const paths = fixture();
  const corrupt = await makeRun(paths, "corrupt", "completed", Date.now());
  const sibling = await makeRun(paths, "sibling", "completed", Date.now());
  writeFileSync(join(corrupt.directory, "journal.json"), "{\n");
  let output = "";
  const exit = await withHomeAndCwd(paths.home, paths.cwd, () => runCli(["doctor", "cleanup", "--yes"], { cwd: paths.cwd }, (text) => { output += text; }));
  assert.equal(exit, 1);
  assert.match(output, /^# pi-extensible-workflows doctor cleanup/);
  assert.match(output, /Mode: confirmed deletion/);
  assert.match(output, /## Failures[\s\S]*corrupt/);
  assert.match(output, /1 failure\(s\)/);
  assert.equal(existsSync(corrupt.directory), true);
  assert.equal(existsSync(sibling.directory), true);
});

void test("doctor cleanup previews only old terminal runs with a strict cutoff", async () => {
  const paths = fixture(); const now = 1_000_000_000_000;
  const old = await makeRun(paths, "old", "completed", now);
  const boundary = await makeRun(paths, "boundary", "failed", now);
  await makeRun(paths, "active", "running", now);
  const cutoff = now - 90 * DAY_MS;
  utimesSync(join(boundary.directory, "state.json"), cutoff / 1000, cutoff / 1000);
  const report = await doctorCleanup({ ...paths, olderThanDays: 90, now });
  assert.deepEqual(report.candidates.map(({ runId }) => runId), ["old"]);
  assert.ok(report.skipped.some(({ runId, reason }) => runId === "boundary" && reason?.includes("not older")));
  assert.ok(report.skipped.some(({ runId, reason }) => runId === "active" && reason?.includes("active or resumable")));
  assert.equal(existsSync(old.directory), true);
});

void test("doctor cleanup protects retained ancestors and deletes eligible chains dependents first", async () => {
  const paths = fixture(); const now = 1_000_000_000_000;
  const parent = await makeRun(paths, "parent", "completed", now);
  const child = await makeRun(paths, "child", "completed", now, { parentRunId: "parent" });
  const deleted = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now });
  assert.deepEqual(deleted.deleted.map(({ runId }) => runId), ["child", "parent"]);
  assert.equal(existsSync(parent.directory), false); assert.equal(existsSync(child.directory), false);

  const retainedPaths = fixture();
  const ancestor = await makeRun(retainedPaths, "ancestor", "completed", now);
  const retained = await makeRun(retainedPaths, "retained", "completed", now, { parentRunId: "ancestor" });
  utimesSync(join(retained.directory, "state.json"), (now - 1 * DAY_MS) / 1000, (now - 1 * DAY_MS) / 1000);
  const protectedReport = await doctorCleanup({ ...retainedPaths, olderThanDays: 90, now });
  assert.deepEqual(protectedReport.candidates.map(({ runId }) => runId), []);
  assert.ok(protectedReport.skipped.some(({ runId, reason }) => runId === "ancestor" && reason?.includes("depends")));
  assert.equal(existsSync(ancestor.directory), true);
});

void test("doctor cleanup fails closed for corrupt inventories and live leases", async () => {
  const paths = fixture(); const now = 1_000_000_000_000;
  const corrupt = await makeRun(paths, "corrupt", "completed", now);
  const sibling = await makeRun(paths, "sibling", "completed", now);
  writeFileSync(join(corrupt.directory, "journal.json"), "{\n");
  const corruptReport = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now });
  assert.equal(corruptReport.failures.length, 1); assert.equal(existsSync(sibling.directory), true);
  const leasePaths = fixture(); const leased = await makeRun(leasePaths, "leased", "completed", now);
  const lease = await acquireSessionLease(leasePaths.cwd, "session-a", leasePaths.home);
  try {
    const leasedReport = await doctorCleanup({ ...leasePaths, olderThanDays: 90, yes: true, now });
    assert.equal(leasedReport.failures.length, 0); assert.equal(leasedReport.candidates.length, 0); assert.equal(existsSync(leased.directory), true);
  } finally { await lease.release(); }
});

void test("doctor cleanup preserves a real borrowed worktree when deleting its borrower", async () => {
  const paths = fixture(); const now = 1_000_000_000_000;
  const repo = join(paths.home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "initial");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  const repoPaths = { home: paths.home, cwd: repo };
  const source = await makeRun(repoPaths, "source", "completed", now);
  const owner = structuralPath("worktree", "named", "shared");
  const original = await source.worktree(owner);
  utimesSync(join(source.directory, "state.json"), (now - DAY_MS) / 1000, (now - DAY_MS) / 1000);
  const child = await makeRun(repoPaths, "child", "completed", now, { parentRunId: "source" });
  assert.deepEqual(await child.worktree(owner), original);
  const report = await doctorCleanup({ ...repoPaths, olderThanDays: 90, yes: true, now });
  assert.deepEqual(report.deleted.map(({ runId }) => runId), ["child"]);
  assert.equal(existsSync(child.directory), false);
  assert.equal(existsSync(source.directory), true);
  assert.equal(existsSync(original.path), true);
});

void test("doctor cleanup rejects malformed nested records before deleting any sibling", async () => {
  const now = 1_000_000_000_000;
  const corruptions: readonly [string, string][] = [
    ["ownership.json", JSON.stringify([null])],
    ["worktrees.json", JSON.stringify([null])],
    ["journal.json", JSON.stringify({ completed: { broken: null } })],
    ["snapshot.json", JSON.stringify({ ...snapshot, settings: { concurrency: "broken" } })],
    ["state.json", JSON.stringify({ id: "corrupt-record", workflowName: "cleanup", cwd: "PLACEHOLDER", sessionId: "session-a", state: "completed", agents: [null], agentSessions: [] })],
  ];
  for (const [file, contents] of corruptions) {
    const paths = fixture();
    const corrupt = await makeRun(paths, "corrupt-record", "completed", now);
    const sibling = await makeRun(paths, "sibling", "completed", now);
    writeFileSync(join(corrupt.directory, file), contents.replace("PLACEHOLDER", paths.cwd));
    const report = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now });
    assert.equal(report.failures.length, 1, file);
    assert.equal(existsSync(corrupt.directory), true, file);
    assert.equal(existsSync(sibling.directory), true, file);
  }
});

void test("doctor cleanup classifies every persisted run state", async () => {
  const paths = fixture(); const now = 1_000_000_000_000;
  const states: RunState[] = ["queued", "running", "pausing", "paused", "awaiting_input", "completed", "failed", "stopped", "interrupted", "budget_exhausted"];
  for (const state of states) await makeRun(paths, state, state, now);
  const report = await doctorCleanup({ ...paths, olderThanDays: 90, now });
  assert.deepEqual(report.candidates.map(({ runId }) => runId), ["completed", "failed", "stopped"]);
  for (const state of states.filter((value) => !["completed", "failed", "stopped"].includes(value))) assert.ok(report.skipped.some(({ runId, reason }) => runId === state && reason?.includes("active or resumable")));
});

void test("doctor cleanup covers every session in one project but not another project", async () => {
  const paths = fixture(); const now = 1_000_000_000_000;
  const second = await makeRun(paths, "second-session", "completed", now, {}, "session-b");
  const first = await makeRun(paths, "first-session", "completed", now);
  const other = { home: paths.home, cwd: join(paths.home, "other-project") };
  const foreign = await makeRun(other, "foreign", "completed", now);
  const report = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now });
  assert.deepEqual(report.deleted.map(({ runId }) => runId), [first.runId, second.runId]);
  assert.equal(existsSync(foreign.directory), true);
});

void test("doctor cleanup protects retry sources through retained provenance", async () => {
  const paths = fixture(); const now = 1_000_000_000_000;
  const source = await makeRun(paths, "retry-source", "failed", now);
  const retry = await makeRun(paths, "retry", "failed", now, { parentRunId: source.runId, retry: { sourceRunId: source.runId, lineageRootRunId: source.runId, completedPaths: [], incompletePaths: ["agent/1"], namedWorktrees: [] } });
  utimesSync(join(retry.directory, "state.json"), (now - DAY_MS) / 1000, (now - DAY_MS) / 1000);
  const report = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now });
  assert.deepEqual(report.candidates, []);
  assert.ok(report.skipped.some(({ runId, reason }) => runId === source.runId && reason?.includes("depends")));
  assert.equal(existsSync(source.directory), true);
});

void test("doctor cleanup stops when a candidate changes during confirmation", async () => {
  const paths = fixture(); const now = 1_000_000_000_000;
  const changing = await makeRun(paths, "changing", "completed", now);
  const originalLoad = Reflect.get(RunStore.prototype, "load");
  let loads = 0;
  RunStore.prototype.load = async function (this: RunStore) {
    const loaded = await originalLoad.call(this);
    if (this.runId === "changing" && loads++ >= 6) await this.saveState({ ...loaded.run, state: "running" });
    return loaded;
  };
  try {
    const report = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now });
    assert.equal(report.deleted.length, 0);
    assert.equal(existsSync(changing.directory), true);
    assert.equal(report.failures.length, 0);
    assert.ok(report.skipped.some(({ runId, reason }) => runId === changing.runId && reason?.includes("changed")));
  } finally { RunStore.prototype.load = originalLoad; }
});

void test("doctor cleanup reports confirmed deletion failures", async () => {
  const paths = fixture(); const now = 1_000_000_000_000;
  const failed = await makeRun(paths, "delete-failure", "completed", now);
  const originalDelete = Reflect.get(RunStore.prototype, "delete");
  RunStore.prototype.delete = async function (confirmed: boolean): Promise<void> { void confirmed; throw new Error("simulated deletion failure"); };
  try {
    const report = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now });
    assert.equal(report.failures.length, 1);
    assert.equal(report.deleted.length, 0);
    assert.equal(existsSync(failed.directory), true);
  } finally { RunStore.prototype.delete = originalDelete; }
});

void test("doctor cleanup reports parent dependency cycles as session failures", async () => {
  const paths = fixture(); const now = 1_000_000_000_000;
  await makeRun(paths, "first", "completed", now, { parentRunId: "second" });
  await makeRun(paths, "second", "completed", now, { parentRunId: "first" });
  const report = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now });
  assert.equal(report.failures.length, 1);
  assert.match(report.failures[0]?.message ?? "", /cycle/i);
  assert.deepEqual(report.deleted, []);
});

void test("doctor cleanup fails closed for missing or corrupt persisted artifacts", async () => {
  const now = 1_000_000_000_000;
  const mutations: readonly { file: string; content?: string }[] = [
    { file: "snapshot.json", content: JSON.stringify({ ...snapshot, budget: "broken" }) },
    { file: "workflow.js" },
    { file: "system-prompts.json" },
    { file: "system-prompts.json", content: JSON.stringify({ version: 2, entries: [] }) },
    { file: "result.json" },
    { file: "result.json", content: "{" },
  ];
  for (const mutation of mutations) {
    const paths = fixture();
    const corrupt = await makeRun(paths, "corrupt-artifact", "completed", now);
    const sibling = await makeRun(paths, "sibling", "completed", now);
    const path = join(corrupt.directory, mutation.file);
    if (mutation.content === undefined) rmSync(path); else writeFileSync(path, mutation.content);
    const report = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now });
    assert.equal(report.failures.length, 1, mutation.file);
    assert.deepEqual(report.deleted, [], mutation.file);
    assert.equal(existsSync(corrupt.directory), true, mutation.file);
    assert.equal(existsSync(sibling.directory), true, mutation.file);
  }
});
void test("doctor cleanup fails closed for unsafe run mutations", async (t) => {
  const now = 1_000_000_000_000;
  const mutations = [
    { name: "symlinked state.json", message: /Run unsafe is corrupt or incomplete: Run artifact is not a regular file: .*state\.json/, mutate: (paths: { home: string; cwd: string }, store: RunStore) => { const state = join(store.directory, "state.json"); const target = join(paths.home, "state-target.json"); const contents = readFileSync(state, "utf8"); rmSync(state); writeFileSync(target, contents); symlinkSync(target, state); } },
    { name: "rewritten workflow.js", message: /Run unsafe is corrupt or incomplete: Persisted workflow source does not match its launch snapshot/, mutate: (_paths: { home: string; cwd: string }, store: RunStore) => { writeFileSync(join(store.directory, "workflow.js"), "rewritten workflow"); } },
    { name: "dangling ownership parent", message: /Run unsafe is corrupt or incomplete: Persisted ownership parent is missing/, mutate: (paths: { home: string; cwd: string }, store: RunStore) => { writeFileSync(join(store.directory, "ownership.json"), JSON.stringify([{ id: "owner", label: "owner", state: "completed", parentId: "missing", options: { label: "owner", cwd: paths.cwd, tools: [] } }])); } },
    { name: "legacy role override object", message: /ownership\[0\]\.options\.role is invalid/, mutate: (paths: { home: string; cwd: string }, store: RunStore) => { writeFileSync(join(store.directory, "ownership.json"), JSON.stringify([{ id: "owner", label: "owner", state: "completed", options: { label: "owner", cwd: paths.cwd, tools: [], role: { name: "reviewer", contextFiles: ["cwd"] } } }])); } },
    { name: "self parentRunId", message: /Run unsafe is corrupt or incomplete: Borrowed worktree source run is invalid/, mutate: (_paths: { home: string; cwd: string }, store: RunStore) => { const statePath = join(store.directory, "state.json"); const state = readCliTestPersistedRun(statePath); state.parentRunId = "unsafe"; writeFileSync(statePath, JSON.stringify(state)); } },
  ] as const;
  for (const mutation of mutations) await t.test(mutation.name, { skip: mutation.name.startsWith("symlink") && !hasFileSymlinkCapability() ? "File symlinks are unavailable without symlink capability on this runner; Linux CI exercises this regression." : false }, async () => {
    const paths = fixture();
    const corrupt = await makeRun(paths, "unsafe", "completed", now);
    const sibling = await makeRun(paths, "sibling", "completed", now);
    mutation.mutate(paths, corrupt);
    const report = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now });
    assert.equal(report.failures.length, 1, mutation.name);
    const failure = report.failures[0];
    assert.ok(failure);
    assert.deepEqual({ sessionId: failure.sessionId, runId: failure.runId }, { sessionId: "session-a", runId: undefined }, mutation.name);
    assert.match(failure.message, mutation.message, mutation.name);
    assert.deepEqual(report.deleted, [], mutation.name);
    assert.equal(existsSync(corrupt.directory), true, mutation.name);
    assert.equal(existsSync(sibling.directory), true, mutation.name);
  });
});
void test("doctor cleanup fails closed for unsafe session inventories", async (t) => {
  const now = 1_000_000_000_000;
  const mutations = [
    { name: "non-directory session root", mutate: (_paths: { home: string; cwd: string }, store: RunStore) => { const session = dirname(dirname(store.directory)); rmSync(session, { recursive: true }); writeFileSync(session, "preserve session root"); } },
    { name: "missing runs directory", mutate: (_paths: { home: string; cwd: string }, store: RunStore) => { rmSync(dirname(store.directory), { recursive: true }); } },
    { name: "symlinked runs directory", mutate: (paths: { home: string; cwd: string }, store: RunStore) => { const runs = dirname(store.directory); const target = join(paths.home, "runs-target"); renameSync(runs, target); symlinkSync(target, runs); } },
    { name: "extra session root entry", mutate: (_paths: { home: string; cwd: string }, store: RunStore) => { writeFileSync(join(dirname(dirname(store.directory)), "unexpected"), "preserve"); } },
    { name: "symlinked owner.json", mutate: (paths: { home: string; cwd: string }, store: RunStore) => { const owner = join(dirname(store.directory), "owner.json"); const target = join(paths.home, "owner-target.json"); writeFileSync(target, "{}"); symlinkSync(target, owner); } },
    { name: "hidden runs entry", mutate: (_paths: { home: string; cwd: string }, store: RunStore) => { mkdirSync(join(dirname(store.directory), ".hidden-run")); } },
  ] as const;
  for (const mutation of mutations) await t.test(mutation.name, { skip: mutation.name.startsWith("symlink") && !hasFileSymlinkCapability() ? "File symlinks are unavailable without symlink capability on this runner; Linux CI exercises this regression." : false }, async () => {
    const paths = fixture();
    const run = await makeRun(paths, "inventory-run", "completed", now);
    const artifact = join(paths.home, "preserve-artifact.txt");
    writeFileSync(artifact, mutation.name);
    mutation.mutate(paths, run);
    const report = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now });
    assert.deepEqual(report.deleted, [], mutation.name);
    assert.equal(report.failures.length, 1, mutation.name);
    assert.equal(readFileSync(artifact, "utf8"), mutation.name, mutation.name);
  });
});
void test("doctor cleanup stops when the session lease token changes during rescanning", async () => {
  const paths = fixture(); const now = 1_000_000_000_000;
  const run = await makeRun(paths, "lease-changed", "completed", now);
  const originalLoad = Reflect.get(RunStore.prototype, "load");
  let loads = 0;
  RunStore.prototype.load = async function (this: RunStore) {
    const loaded = await originalLoad.call(this);
    if (this.runId === run.runId && ++loads === 4) {
      const ownerPath = join(dirname(this.directory), "owner.json");
      const owner = readCliTestSessionOwner(ownerPath);
      writeFileSync(ownerPath, JSON.stringify({ ...owner, token: "changed-token" }));
    }
    return loaded;
  };
  try {
    const report = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now });
    assert.deepEqual(report.deleted, []);
    assert.equal(report.failures.length, 1);
    assert.match(report.failures[0]?.message ?? "", /lease changed|ownership lease/i);
    assert.equal(existsSync(run.directory), true);
  } finally { RunStore.prototype.load = originalLoad; }
});
void test("doctor cleanup rechecks deletion races and never deletes a changed candidate", async () => {
  const cases = [
    { name: "state disappears", kind: "failure", mutate: (store: RunStore) => { rmSync(join(store.directory, "state.json")); } },
    { name: "reload throws", kind: "failure", mutate: () => { throw new Error("reload race"); } },
    { name: "mtime-only change", kind: "skip", mutate: (store: RunStore) => { const mtime = (1_000_000_000_000 - 100 * DAY_MS + 1_000) / 1000; utimesSync(join(store.directory, "state.json"), mtime, mtime); } },
    { name: "mtime after cutoff", kind: "skip", mutate: (store: RunStore) => { const mtime = (1_000_000_000_000 - 90 * DAY_MS + 1_000) / 1000; utimesSync(join(store.directory, "state.json"), mtime, mtime); } },
  ] as const;
  for (const race of cases) {
    const paths = fixture();
    const run = await makeRun(paths, "recheck-race", "completed", 1_000_000_000_000);
    const originalLoad = Reflect.get(RunStore.prototype, "load");
    let loads = 0;
    RunStore.prototype.load = async function (this: RunStore) {
      if (this.runId === run.runId && ++loads === 7 && race.kind === "failure") race.mutate(this);
      const loaded = await originalLoad.call(this);
      if (this.runId === run.runId && loads === 7 && race.kind !== "failure") race.mutate(this);
      return loaded;
    };
    try {
      const report = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now: 1_000_000_000_000 });
      assert.deepEqual(report.deleted, [], race.name);
      if (race.kind === "failure") assert.equal(report.failures.length, 1, race.name);
      else { assert.equal(report.failures.length, 0, race.name); assert.ok(report.skipped.some(({ runId, reason }) => runId === run.runId && reason?.includes("changed")), race.name); }
      assert.equal(existsSync(run.directory), true, race.name);
    } finally { RunStore.prototype.load = originalLoad; }
  }
});
void test("doctor cleanup fails closed for unrecorded worktree directories", async () => {
  const paths = fixture(); const now = 1_000_000_000_000;
  const store = await makeRun(paths, "orphaned-worktree", "completed", now);
  const valuable = join(store.directory, "worktrees", "orphan", "valuable");
  mkdirSync(valuable, { recursive: true });
  const report = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now });
  assert.equal(report.failures.length, 1);
  assert.deepEqual(report.deleted, []);
  assert.equal(existsSync(valuable), true);
  assert.equal(existsSync(store.directory), true);
});
void test("doctor cleanup scans hidden session directories", async () => {
  const paths = fixture(); const now = 1_000_000_000_000;
  const hidden = await makeRun(paths, "hidden-run", "completed", now, {}, ".hidden-session");
  const report = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now });
  assert.deepEqual(report.deleted.map(({ sessionId, runId }) => ({ sessionId, runId })), [{ sessionId: ".hidden-session", runId: "hidden-run" }]);
  assert.equal(existsSync(hidden.directory), false);
});
void test("doctor cleanup rejects an unrepresentable cutoff", async () => {
  const paths = fixture();
  await assert.rejects(doctorCleanup({ ...paths, olderThanDays: Number.MAX_SAFE_INTEGER, now: 1_000_000_000_000 }), /representable cutoff/);
});
