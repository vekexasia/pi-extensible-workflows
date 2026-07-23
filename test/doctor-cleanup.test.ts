import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLaunchSnapshot, DEFAULT_SETTINGS, type RunState } from "../src/index.js";
import { acquireSessionLease, RunStore, structuralPath } from "../src/persistence.js";
import { doctorCleanup } from "../src/doctor-cleanup.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const snapshot = createLaunchSnapshot({ script: "export const meta={name:'cleanup'}", args: {}, metadata: { name: "cleanup" }, settings: DEFAULT_SETTINGS, models: [], tools: [], agentTypes: [], schemas: [] });

function fixture(): { home: string; cwd: string } { const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-cleanup-")); return { home, cwd: join(home, "project") }; }
async function makeRun(paths: { home: string; cwd: string }, runId: string, state: RunState, now: number, extra: Record<string, unknown> = {}, sessionId = "session-a"): Promise<RunStore> {
  const store = new RunStore(paths.cwd, sessionId, runId, paths.home);
  await store.create({ id: runId, workflowName: "cleanup", cwd: paths.cwd, sessionId, state, agents: [], nativeSessions: [], ...extra }, snapshot);
  if (state === "completed") await store.saveResult(null);
  const old = now - 100 * DAY_MS;
  utimesSync(join(store.directory, "state.json"), old / 1000, old / 1000);
  return store;
}

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
    ["state.json", JSON.stringify({ id: "corrupt-record", workflowName: "cleanup", cwd: "PLACEHOLDER", sessionId: "session-a", state: "completed", agents: [null], nativeSessions: [] })],
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