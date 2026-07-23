import assert from "node:assert/strict";
import { mkdtempSync, utimesSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createLaunchSnapshot, DEFAULT_SETTINGS, type RunState } from "../src/index.js";
import { acquireSessionLease, RunStore, runsDirectory } from "../src/persistence.js";
import { doctorCleanup } from "../src/doctor-cleanup.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const snapshot = createLaunchSnapshot({ script: "export const meta={name:'cleanup'}", args: {}, metadata: { name: "cleanup" }, settings: DEFAULT_SETTINGS, models: [], tools: [], agentTypes: [], schemas: [] });

function fixture(): { home: string; cwd: string } { const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-cleanup-")); return { home, cwd: join(home, "project") }; }
async function makeRun(paths: { home: string; cwd: string }, runId: string, state: RunState, now: number, extra: Record<string, unknown> = {}): Promise<RunStore> {
  const store = new RunStore(paths.cwd, "session-a", runId, paths.home);
  await store.create({ id: runId, workflowName: "cleanup", cwd: paths.cwd, sessionId: "session-a", state, agents: [], nativeSessions: [], ...extra }, snapshot);
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

void test("doctor cleanup treats borrowed worktree bindings as dependencies", async () => {
  const paths = fixture(); const now = 1_000_000_000_000;
  await makeRun(paths, "source", "completed", now);
  const child = await makeRun(paths, "child", "completed", now, { parentRunId: "source" });
  writeFileSync(join(child.directory, "borrowed-worktrees.json"), JSON.stringify([{ name: "shared", sourceRunId: "source", owner: "worktree/named/shared" }]));
  const report = await doctorCleanup({ ...paths, olderThanDays: 90, yes: true, now });
  assert.deepEqual(report.deleted.map(({ runId }) => runId), ["child", "source"]);
  assert.equal(existsSync(runsDirectory(paths.cwd, "session-a", paths.home)), true);
});