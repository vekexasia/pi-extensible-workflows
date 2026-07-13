import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
