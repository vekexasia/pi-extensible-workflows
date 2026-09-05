import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { acquireSessionLease, createLaunchSnapshot, DEFAULT_SETTINGS, FairAgentScheduler, WorkflowError } from "../src/index.js";
import { hasLiveSessionLease, listRunIds, projectStorageKey, RunStore, runsDirectory, structuralPath } from "../src/persistence.js";
import { decodeTestJsonRecord, isTestRecord } from "./support.js";

const snapshot = createLaunchSnapshot({ script: "export const meta={name:'x',description:'x'}", args: { answer: 42 }, metadata: { name: "x", description: "x" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: ["read"], agentTypes: [], schemas: [] });

function run(cwd: string, sessionId = "session-a") {
  return { id: "run-a", workflowName: "x", cwd, sessionId, state: "running" as const, agents: [], agentSessions: [{ transport: "local", sessionId: "native-a", locator: { sessionFile: "/pi/sessions/native-a.jsonl" } }] };
}
function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> { return new Promise((resolve) => { const timer = setTimeout(() => { resolve(false); }, timeoutMs); promise.then(() => { clearTimeout(timer); resolve(true); }, () => { clearTimeout(timer); resolve(true); }); }); }

void test("session leases reject live owners, reclaim malformed or dead owners, and release only their own token", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-lease-"));
  const cwd = join(home, "project");
  const ownerPath = join(runsDirectory(cwd, "session-a", home), "owner.json");
  const lease = await acquireSessionLease(cwd, "session-a", home);
  await assert.rejects(acquireSessionLease(cwd, "session-a", home), (error: unknown) => error instanceof WorkflowError && error.code === "RUN_OWNED");
  writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token: "newer", startedAt: 0 }));
  await lease.release();
  assert.equal((JSON.parse(readFileSync(ownerPath, "utf8")) as { token: string }).token, "newer");
  writeFileSync(ownerPath, JSON.stringify({ pid: 2147483647, token: "dead", startedAt: 0 }));
  const reclaimed = await acquireSessionLease(cwd, "session-a", home);
  await reclaimed.release();
  if (process.platform === "linux") {
    writeFileSync(ownerPath, JSON.stringify({ pid: process.pid, token: "reused", startedAt: 0 }));
    const pidReused = await acquireSessionLease(cwd, "session-a", home);
    await pidReused.release();
  }
  writeFileSync(ownerPath, JSON.stringify({ pid: "bad", token: "", startedAt: "bad" }));
  await assert.rejects(hasLiveSessionLease(cwd, "session-a", home), (error: unknown) => error instanceof WorkflowError && error.code === "RUN_OWNED");
  utimesSync(ownerPath, new Date(0), new Date(0));
  const malformedReclaimed = await acquireSessionLease(cwd, "session-a", home);
  await malformedReclaimed.release();
  writeFileSync(ownerPath, "{");
  utimesSync(ownerPath, new Date(0), new Date(0));
  const invalidReclaimed = await acquireSessionLease(cwd, "session-a", home);
  await invalidReclaimed.release();
});
void test("reclaims stale valid but undecodable session leases", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-invalid-lease-"));
  const cwd = join(home, "project");
  const directory = runsDirectory(cwd, "session-a", home);
  const ownerPath = join(directory, "owner.json");
  mkdirSync(directory, { recursive: true });
  writeFileSync(ownerPath, "null\n");
  const recentAcquisition = acquireSessionLease(cwd, "session-a", home);
  assert.equal(await settlesWithin(recentAcquisition, 1_000), true);
  await assert.rejects(recentAcquisition, (error: unknown) => error instanceof WorkflowError && error.code === "RUN_OWNED");
  utimesSync(ownerPath, new Date(0), new Date(0));
  const acquisition = acquireSessionLease(cwd, "session-a", home);
  assert.equal(await settlesWithin(acquisition, 1_000), true);
  const lease = await acquisition;
  await lease.release();
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
  await sibling.create({ id: "sibling", workflowName: "x", cwd, sessionId: "session-a", state: "running", agents: [], agentSessions: [] }, snapshot);
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
void test("stores exact cwd and Pi session snapshots and rejects cross-session loading", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-store-"));
  const cwd = join(home, "same-name");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const loaded = await store.load();
  assert.deepEqual(loaded.snapshot.args, { answer: 42 });
  assert.equal(Object.isFrozen(loaded.snapshot.args), true);
  assert.equal(((loaded.run.agentSessions[0]?.locator as { sessionFile?: string } | undefined)?.sessionFile), "/pi/sessions/native-a.jsonl");
  const otherSession = new RunStore(cwd, "session-b", "run-a", home);
  mkdirSync(otherSession.directory, { recursive: true });
  for (const artifact of ["state.json", "snapshot.json"]) writeFileSync(join(otherSession.directory, artifact), readFileSync(join(store.directory, artifact)));
  await assert.rejects(otherSession.load(), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  assert.notEqual(projectStorageKey(join(home, "a", "same-name")), projectStorageKey(join(home, "b", "same-name")));
});
void test("enforces run identity for every state access and mutation", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-store-identity-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  const persisted = run(relative(process.cwd(), cwd));
  const mismatches = [
    { name: "cwd", value: { ...persisted, cwd: join(home, "other-project") } },
    { name: "session", value: { ...persisted, sessionId: "session-b" } },
    { name: "run", value: { ...persisted, id: "run-b" } },
  ];
  const internalIdentityError = (error: unknown) => error instanceof WorkflowError && error.code === "INTERNAL_ERROR" && error.message === "Run identity does not match its session-scoped store";
  const persistedIdentityError = (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE" && error.message === "Persisted run belongs to another cwd or Pi session";

  for (const mismatch of mismatches) await assert.rejects(store.create(mismatch.value, snapshot), internalIdentityError, mismatch.name);
  await store.create(persisted, snapshot);

  for (const mismatch of mismatches) {
    writeFileSync(join(store.directory, "state.json"), `${JSON.stringify(mismatch.value)}\n`);
    await assert.rejects(store.load(), persistedIdentityError, `${mismatch.name} load`);
    await assert.rejects(store.updateState((current) => current), persistedIdentityError, `${mismatch.name} update current`);
    await assert.rejects(store.loadStatus(), (error: unknown) => error instanceof WorkflowError && error.code === "RUN_NOT_FOUND" && error.message === "Persisted run does not belong to this project", `${mismatch.name} status`);
  }

  for (const mismatch of mismatches) await assert.rejects(store.saveState(mismatch.value), internalIdentityError, `${mismatch.name} save`);
  writeFileSync(join(store.directory, "state.json"), `${JSON.stringify(persisted)}\n`);
  const resultMismatch = mismatches[2];
  assert.ok(resultMismatch);
  await assert.rejects(store.updateState(() => resultMismatch.value), internalIdentityError, "update result");
  assert.deepEqual((await store.load()).run, persisted);
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
  const prompts = ["BASE\n\nROLE: α", "BASE\n\nROLE: β", "BASE\n\nROLE: α"];
  await Promise.all(prompts.map((prompt, index) => store.recordSystemPrompt({ sessionId: "native-a", attempt: 1, turn: index + 1, prompt })));
  const saved = await new RunStore(cwd, "session-a", "run-a", home).systemPrompts();
  assert.deepEqual(saved, prompts.map((prompt, index) => ({ sessionId: "native-a", attempt: 1, turn: index + 1, sha256: createHash("sha256").update(prompt).digest("hex"), prompt })));
  assert.equal(statSync(store.systemPromptPath()).mode & 0o777, 0o600);
  assert.equal(readdirSync(join(store.directory, ".system-prompts", "bodies")).filter((name) => /^[0-9a-f]{64}$/.test(name)).length, 2);
});
void test("rejects tampered system-prompt bodies and malformed record names", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-system-prompts-invalid-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const prompt = "private prompt";
  const sha256 = createHash("sha256").update(prompt).digest("hex");
  await store.recordSystemPrompt({ sessionId: "native-a", attempt: 1, turn: 1, prompt });
  const bodyPath = join(store.directory, ".system-prompts", "bodies", sha256);
  writeFileSync(bodyPath, "tampered prompt");
  await assert.rejects(store.systemPrompts(), /Persisted system-prompt body is invalid/);
  writeFileSync(bodyPath, prompt);
  writeFileSync(join(store.directory, ".system-prompts", "records", "malformed.json"), "{}\n");
  await assert.rejects(store.systemPrompts(), /Persisted system-prompt records are invalid/);
});
void test("keeps long repeated system-prompt histories append-only", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-system-prompts-long-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const prompt = "long prompt\n" + "x".repeat(8192);
  const records = Array.from({ length: 16 }, (_, index) => ({ sessionId: "native-a", attempt: Math.floor(index / 4) + 1, turn: (index % 4) + 1, prompt }));
  const artifact = readFileSync(store.systemPromptPath(), "utf8");
  await Promise.all(records.map((entry) => store.recordSystemPrompt(entry)));
  assert.equal(readFileSync(store.systemPromptPath(), "utf8"), artifact);
  assert.equal(readdirSync(join(store.directory, ".system-prompts", "records")).filter((name) => name.endsWith(".json")).length, records.length);
  assert.equal(readdirSync(join(store.directory, ".system-prompts", "bodies")).filter((name) => /^[0-9a-f]{64}$/.test(name)).length, 1);
  assert.deepEqual(await new RunStore(cwd, "session-a", "run-a", home).systemPrompts(), records.map((entry) => ({ ...entry, sha256: createHash("sha256").update(prompt).digest("hex") })));
});
void test("migrates version-1 system-prompt artifacts when appending", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-system-prompts-v1-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const legacyPrompt = "legacy prompt";
  writeFileSync(store.systemPromptPath(), JSON.stringify({ version: 1, entries: [{ sessionId: "native-a", attempt: 1, turn: 1, sha256: createHash("sha256").update(legacyPrompt).digest("hex"), prompt: legacyPrompt }] }));
  await store.recordSystemPrompt({ sessionId: "native-a", attempt: 1, turn: 2, prompt: "new prompt" });
  assert.deepEqual(await store.systemPrompts(), [
    { sessionId: "native-a", attempt: 1, turn: 1, sha256: createHash("sha256").update(legacyPrompt).digest("hex"), prompt: legacyPrompt },
    { sessionId: "native-a", attempt: 1, turn: 2, sha256: createHash("sha256").update("new prompt").digest("hex"), prompt: "new prompt" },
  ]);
});
void test("serializes concurrent state updates in call order without losing fields", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-state-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const order: string[] = [];
  const first = store.updateState(async (current) => {
    order.push("phase:start");
    markFirstStarted();
    await firstGate;
    order.push("phase:end");
    return { ...current, phase: "review" };
  });
  const second = store.updateState((current) => { order.push("error"); return { ...current, error: { code: "AGENT_FAILED", message: "boom" } }; });
  await firstStarted;
  assert.deepEqual(order, ["phase:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["phase:start", "phase:end", "error"]);
  const saved = (await store.load()).run;
  assert.equal(saved.phase, "review");
  assert.deepEqual(saved.error, { code: "AGENT_FAILED", message: "boom" });
});
void test("a failed state write does not block later writes", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-state-failure-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  await assert.rejects(store.updateState(() => { throw new Error("update failed"); }), /update failed/);
  await store.updateState((current) => ({ ...current, phase: "recovered" }));
  assert.equal((await store.load()).run.phase, "recovered");
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
void test("replays completed agent, shell, and checkpoint operations across restart and retry chains", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-retry-journal-"));
  const cwd = join(home, "project");
  const source = new RunStore(cwd, "session-a", "run-a", home);
  await source.create({ ...run(cwd), state: "failed" }, snapshot);
  const agentPath = structuralPath("agent", "parallel", "good");
  const shellPath = structuralPath("shell", "setup");
  await source.complete(agentPath, "done");
  await source.complete(shellPath, { exitCode: 0, stdout: "ok", stderr: "" });
  const checkpoint = { path: structuralPath("checkpoint", "ship"), name: "ship", prompt: "Ship?", context: null };
  await source.awaitCheckpoint(checkpoint);
  await source.answerCheckpoint("ship", true);
  const pending = { path: structuralPath("checkpoint", "pending"), name: "pending", prompt: "Pending?", context: null };
  await source.awaitCheckpoint(pending);
  const child = new RunStore(cwd, "session-a", "run-b", home);
  await child.create({ id: "run-b", workflowName: "x", cwd, sessionId: "session-a", state: "failed", parentRunId: "run-a", retry: { sourceRunId: "run-a", lineageRootRunId: "run-a", completedPaths: [agentPath, shellPath, checkpoint.path], incompletePaths: ["agent/parallel/bad"], namedWorktrees: [] }, agents: [], agentSessions: [] }, snapshot);
  const reloadedChild = new RunStore(cwd, "session-a", "run-b", home);
  const inherited = [
    [agentPath, "done"],
    [shellPath, { exitCode: 0, stdout: "ok", stderr: "" }],
    [checkpoint.path, true],
  ] as const;
  for (const [path, value] of inherited) assert.deepEqual(await reloadedChild.replay(path), { path, value });
  assert.equal(await reloadedChild.replay(pending.path), undefined);
  assert.equal((await reloadedChild.awaitingCheckpoints()).length, 0);
  assert.equal(await reloadedChild.awaitCheckpoint(checkpoint), true);
  assert.deepEqual(await reloadedChild.awaitingCheckpoints(), []);
  const grandchild = new RunStore(cwd, "session-a", "run-c", home);
  const newPath = structuralPath("agent", "retry-only");
  await grandchild.create({ id: "run-c", workflowName: "x", cwd, sessionId: "session-a", state: "interrupted", parentRunId: "run-b", retry: { sourceRunId: "run-b", lineageRootRunId: "run-a", completedPaths: [agentPath, shellPath, checkpoint.path], incompletePaths: ["agent/parallel/bad"], namedWorktrees: [] }, agents: [], agentSessions: [] }, snapshot);
  await grandchild.complete(newPath, "new");
  const restartedGrandchild = new RunStore(cwd, "session-a", "run-c", home);
  for (const [path, value] of inherited) assert.deepEqual(await restartedGrandchild.replay(path), { path, value });
  assert.deepEqual(await restartedGrandchild.replay(newPath), { path: newPath, value: "new" });
  for (const replayStore of [reloadedChild, restartedGrandchild]) assert.equal(await replayStore.replay(structuralPath("agent", "parallel", "bad")), undefined);
  assert.equal((await source.load()).run.state, "failed");
});
void test("rejects malformed retry provenance before replay or resume", async (t) => {
  const cases = [
    { name: "malformed shape", sourceState: "failed" as const, mutate: (state: Record<string, unknown>) => { state.retry = { sourceRunId: "source" }; }, cycle: false },
    { name: "parent mismatch", sourceState: "failed" as const, mutate: (state: Record<string, unknown>) => { state.parentRunId = "other"; }, cycle: false },
    { name: "source is not failed", sourceState: "completed" as const, mutate: () => undefined, cycle: false },
    { name: "lineage-root mismatch", sourceState: "failed" as const, mutate: (state: Record<string, unknown>) => { (state.retry as Record<string, unknown>).lineageRootRunId = "wrong-root"; }, cycle: false },
    { name: "cycle", sourceState: "failed" as const, mutate: () => undefined, cycle: true },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const home = mkdtempSync(join(tmpdir(), `pi-extensible-workflows-retry-invalid-${scenario.name}-`));
      const cwd = join(home, "project");
      const source = new RunStore(cwd, "session-a", "source", home);
      await source.create({ ...run(cwd), id: "source", state: scenario.sourceState }, snapshot);
      const child = new RunStore(cwd, "session-a", "child", home);
      await child.create({ ...run(cwd), id: "child", state: "failed", parentRunId: "source", retry: { sourceRunId: "source", lineageRootRunId: "source", completedPaths: [], incompletePaths: [], namedWorktrees: [] } }, snapshot);
      const statePath = join(child.directory, "state.json");
      const childState = decodeTestJsonRecord(readFileSync(statePath, "utf8"));
      scenario.mutate(childState);
      writeFileSync(statePath, `${JSON.stringify(childState)}\n`);
      if (scenario.cycle) await source.updateState((current) => ({ ...current, parentRunId: "child", retry: { sourceRunId: "child", lineageRootRunId: "source", completedPaths: [], incompletePaths: [], namedWorktrees: [] } }));
      await assert.rejects(child.validateRetrySource(), (error: unknown) => {
        if (!(error instanceof WorkflowError) || error.code !== "RESUME_INCOMPATIBLE") return false;
        if (scenario.cycle) assert.match(error.message, /cycle/);
        return true;
      });
      if (scenario.cycle) await assert.rejects(child.replay("agent/cycle"), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
    });
  }
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

void test("creates worktrees from clean HEAD, preserves launch subdirectories, and cleans up only on confirmed deletion", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-worktree-"));
  const repo = join(home, "repo");
  const cwd = join(repo, "packages", "app");
  mkdirSync(cwd, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(cwd, "tracked.txt"), "initial");
  writeFileSync(join(repo, ".gitignore"), "ignored.txt\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  writeFileSync(join(cwd, "ignored.txt"), "local only");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const first = await store.worktree("agent/path");
  const second = await store.worktree("agent/path");
  assert.deepEqual(second, first);
  assert.equal(first.base, head);
  assert.equal(readFileSync(join(first.cwd, "tracked.txt"), "utf8"), "initial");
  assert.equal(existsSync(join(first.cwd, "ignored.txt")), false);
  assert.equal(execFileSync("git", ["-C", first.path, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(), head);
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
void test("rejects worktree creation when the launch working tree has tracked or untracked changes", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-dirty-worktree-"));
  const repo = join(home, "repo");
  mkdirSync(repo, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "initial");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  const head = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const store = new RunStore(repo, "session-a", "run-a", home);
  await store.create(run(repo), snapshot);
  const isDirtyFailure = (error: unknown): error is WorkflowError => error instanceof WorkflowError && error.code === "WORKTREE_FAILED" && error.message.includes("uncommitted changes");
  writeFileSync(join(repo, "tracked.txt"), "changed");
  await assert.rejects(store.worktree("agent"), isDirtyFailure);
  execFileSync("git", ["-C", repo, "checkout", "--", "tracked.txt"]);
  execFileSync("git", ["-C", repo, "config", "status.showUntrackedFiles", "no"]);
  const untracked = Array.from({ length: 12 }, (_, index) => join(repo, `untracked-${String(index)}.txt`));
  for (const path of untracked) writeFileSync(path, "new");
  let dirtyMessage = "";
  await assert.rejects(store.worktree("agent"), (error: unknown) => {
    if (!isDirtyFailure(error)) return false;
    dirtyMessage = error.message;
    return true;
  });
  assert.match(dirtyMessage, /repository .* has uncommitted changes at worktree creation; commit or stash them first:/);
  assert.equal((dirtyMessage.match(/untracked-\d+\.txt/g) ?? []).length, 10);
  assert.match(dirtyMessage, /, and 2 more$/);
  for (const path of untracked) rmSync(path);
  assert.equal(execFileSync("git", ["-C", repo, "branch", "--list", "pi-extensible-workflows/run-a/*"], { encoding: "utf8" }).trim(), "");
  assert.deepEqual(readdirSync(store.directory).filter((name) => name.startsWith("worktree-") && name.endsWith(".creating")), []);
  const reference = await store.worktree("agent");
  assert.equal(existsSync(join(reference.path, "tracked.txt")), true);
  writeFileSync(join(repo, "tracked.txt"), "changed after creation");
  assert.deepEqual(await store.worktree("agent"), reference);
  assert.deepEqual(await new RunStore(repo, "session-a", "run-a", home).worktree("agent"), reference);
  await assert.rejects(store.worktree("new-agent"), isDirtyFailure);
  execFileSync("git", ["-C", repo, "checkout", "--", "tracked.txt"]);
  const staleOwner = "stale-agent";
  const staleKey = createHash("sha256").update(`session-a\0run-a\0${staleOwner}`).digest("hex").slice(0, 16);
  const stalePath = join(store.directory, "worktrees", staleKey);
  const staleBranch = `pi-extensible-workflows/run-a/${staleKey}`;
  const staleMarker = join(store.directory, `worktree-${staleKey}.creating`);
  execFileSync("git", ["-C", repo, "branch", staleBranch, head]);
  writeFileSync(staleMarker, JSON.stringify({ owner: staleOwner, path: stalePath, branch: staleBranch, base: head }));
  writeFileSync(join(repo, "tracked.txt"), "changed with stale marker");
  await assert.rejects(store.worktree(staleOwner), isDirtyFailure);
  assert.equal(execFileSync("git", ["-C", repo, "branch", "--list", staleBranch], { encoding: "utf8" }).trim(), "");
  assert.equal(existsSync(staleMarker), false);
  execFileSync("git", ["-C", repo, "checkout", "--", "tracked.txt"]);
  const staleReference = await store.worktree(staleOwner);
  assert.equal(staleReference.base, head);
});
void test("rejects worktree creation for an empty repository", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-empty-repository-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const store = new RunStore(repo, "session-a", "run-a", home);
  await store.create(run(repo), snapshot);
  await assert.rejects(store.worktree("agent"), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED" && error.message === "repository has no commits");
});
void test("creates worktrees from a symlinked repository cwd without rewriting the persisted cwd", { skip: process.platform === "win32" }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-symlinked-worktree-"));
  const repo = join(home, "repo");
  const alias = join(home, "repo-alias");
  const repoCwd = join(repo, "packages", "app");
  const cwd = join(alias, "packages", "app");
  mkdirSync(repoCwd, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repoCwd, "tracked.txt"), "initial");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  symlinkSync(repo, alias, "dir");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const worktree = await store.worktree("agent");
  assert.equal(worktree.cwd, join(worktree.path, "packages", "app"));
  assert.equal((await store.load()).run.cwd, cwd);
});
void test("rejects a launch cwd outside the repository without rejecting dotted directory names", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-outside-worktree-"));
  const repo = join(home, "repo");
  const dotted = join(repo, "..foo");
  mkdirSync(dotted, { recursive: true });
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(dotted, "tracked.txt"), "initial");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  const dottedStore = new RunStore(dotted, "session-a", "run-a", home);
  await dottedStore.create(run(dotted), snapshot);
  const dottedWorktree = await dottedStore.worktree("agent");
  assert.equal(dottedWorktree.cwd, join(dottedWorktree.path, "..foo"));
  const outside = join(home, "elsewhere");
  mkdirSync(outside);
  const outsideStore = new RunStore(outside, "session-b", "run-b", home);
  await outsideStore.create({ ...run(outside, "session-b"), id: "run-b" }, snapshot);
  const previousGitDir = process.env.GIT_DIR;
  const previousWorkTree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = join(repo, ".git");
  process.env.GIT_WORK_TREE = repo;
  try {
    await assert.rejects(outsideStore.worktree("agent"), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED" && error.message.includes("launch cwd is outside the repository"));
  } finally {
    if (previousGitDir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previousGitDir;
    if (previousWorkTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = previousWorkTree;
  }
});
void test("does not advertise non-canonical named worktree owners", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-non-canonical-named-worktree-"));
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
  const owner = "worktree/named/%62anana";
  await store.worktree(owner);
  assert.deepEqual(await store.validNamedWorktrees(), []);
  await assert.rejects(store.resolveNamedWorktree("banana"), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
});
void test("does not advertise owned named worktrees when borrowed bindings are malformed", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-invalid-borrowed-bindings-"));
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
  await store.worktree(structuralPath("worktree", "named", "banana"));
  writeFileSync(join(store.directory, "borrowed-worktrees.json"), JSON.stringify({ invalid: true }));
  assert.deepEqual(await store.validNamedWorktrees(), []);
  await assert.rejects(store.resolveNamedWorktree("banana"), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
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
  const retrySource = new RunStore(repo, "session-a", "retry-source", home);
  await retrySource.create({ ...run(repo), id: "retry-source", state: "failed", parentRunId: "source", retry: { sourceRunId: "source", lineageRootRunId: "source", completedPaths: [], incompletePaths: [], namedWorktrees: ["banana"] } }, snapshot);
  const retryChild = new RunStore(repo, "session-a", "retry-child", home);
  await retryChild.create({ ...run(repo), id: "retry-child", state: "failed", parentRunId: "retry-source", retry: { sourceRunId: "retry-source", lineageRootRunId: "source", completedPaths: [], incompletePaths: [], namedWorktrees: ["banana"] } }, snapshot);
  assert.deepEqual(await retryChild.worktree(owner), original);
  assert.deepEqual(await retryChild.borrowedWorktrees(), [{ name: "banana", sourceRunId: "source", owner }]);
  await retryChild.delete(true);
  await retrySource.delete(true);
  const unrelated = new RunStore(repo, "session-a", "unrelated", home);
  await unrelated.create({ ...run(repo), id: "unrelated", state: "completed" }, snapshot);
  writeFileSync(join(first.directory, "borrowed-worktrees.json"), JSON.stringify([{ name: "banana", sourceRunId: "unrelated", owner }]));
  await assert.rejects(first.validateBorrowedWorktrees(), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
  await unrelated.delete(true);
  writeFileSync(join(first.directory, "borrowed-worktrees.json"), JSON.stringify([{ name: " banana ", sourceRunId: "source", owner }]));
  await assert.rejects(first.validateBorrowedWorktrees(), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
  await first.delete(true);
  assert.equal(existsSync(original.path), true);
  await source.delete(true);
  await assert.rejects(second.worktrees(), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
  await assert.rejects(second.validateBorrowedWorktrees(), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
  await second.delete(true);
});

void test("retry named worktrees fail closed when an inherited record disappears", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-retry-stale-worktree-"));
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
  await source.create({ ...run(repo), id: "source", state: "failed" }, snapshot);
  const worktree = await source.worktree(owner);
  rmSync(worktree.path, { recursive: true });
  await assert.rejects(source.validateNamedWorktrees(), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
  writeFileSync(join(source.directory, "worktrees.json"), "[]\n");
  const child = new RunStore(repo, "session-a", "child", home);
  await child.create({ ...run(repo), id: "child", state: "failed", parentRunId: "source", retry: { sourceRunId: "source", lineageRootRunId: "source", completedPaths: [], incompletePaths: [], namedWorktrees: ["banana"] } }, snapshot);
  await assert.rejects(child.worktree(owner), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
  assert.deepEqual(JSON.parse(readFileSync(join(child.directory, "worktrees.json"), "utf8")), []);
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
void test("maintains an atomic compact summary and derives legacy summaries", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-summary-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const initial = await store.loadSummary();
  assert.equal(initial.schemaVersion, 1);
  assert.equal(initial.runId, "run-a");
  assert.equal(initial.sessionId, "session-a");
  assert.equal(initial.workflowName, "x");
  assert.equal(initial.state, "running");
  assert.equal(initial.agents.length, 0);
  assert.equal(initial.artifacts.statePath, join(store.directory, "state.json"));
  assert.equal(initial.artifacts.journalPath, join(store.directory, "journal.json"));
  assert.equal(initial.artifacts.summaryPath, join(store.directory, "summary.json"));
  assert.equal(Object.keys(decodeTestJsonRecord(readFileSync(join(store.directory, "summary.json"), "utf8"))).includes("script"), false);
  await store.complete("agent/one", "done");
  await store.updateState((current) => ({ ...current, state: "failed", error: { code: "AGENT_FAILED", message: "boom" }, failedAt: "agent/two" }));
  const failed = await store.loadSummary();
  assert.equal(failed.state, "failed");
  assert.deepEqual(failed.replayablePaths, ["agent/one"]);
  assert.deepEqual(failed.incompletePaths, ["agent/two"]);
  assert.ok(failed.terminalAt);
  assert.ok(failed.updatedAt >= initial.updatedAt);
  rmSync(join(store.directory, "summary.json"));
  const legacy = await store.loadSummary();
  assert.equal(legacy.runId, "run-a");
  assert.equal(legacy.state, "failed");
  assert.deepEqual(legacy.replayablePaths, ["agent/one"]);
});

void test("loadSummary derives from authoritative state and journal when the projection is stale", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-summary-authority-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  const stale = await store.loadSummary();
  await store.updateState((current) => ({ ...current, usage: { tokens: 42, costUsd: 1, durationMs: 2, agentLaunches: 3 } }));
  await store.complete("agent/one", "done");
  const later = new Date(Date.now() + 2000);
  utimesSync(join(store.directory, "journal.json"), later, later);
  writeFileSync(join(store.directory, "summary.json"), `${JSON.stringify(stale)}\n`);
  const current = await store.loadSummary();
  assert.deepEqual(current.usage, { tokens: 42, costUsd: 1, durationMs: 2, agentLaunches: 3 });
  assert.deepEqual(current.replayablePaths, ["agent/one"]);
  assert.ok(Date.parse(current.updatedAt) >= later.getTime() - 2);
});
void test("authoritative state writes survive summary projection failures", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-summary-best-effort-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(run(cwd), snapshot);
  writeFileSync(join(store.directory, "journal.json"), "{\n");
  await assert.doesNotReject(store.updateState((current) => ({ ...current, phase: "completed" })));
  const state = decodeTestJsonRecord(readFileSync(join(store.directory, "state.json"), "utf8"));
  if (typeof state.phase !== "string") throw new Error("Persisted state phase was malformed");
  assert.equal(state.phase, "completed");
  const journalHome = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-summary-journal-best-effort-"));
  const journalCwd = join(journalHome, "project");
  const journalStore = new RunStore(journalCwd, "session-a", "run-a", journalHome);
  await journalStore.create(run(journalCwd), snapshot);
  writeFileSync(join(journalStore.directory, "state.json"), "{\n");
  await assert.doesNotReject(journalStore.complete("agent/one", "done"));
  const journal = decodeTestJsonRecord(readFileSync(join(journalStore.directory, "journal.json"), "utf8"));
  if (!isTestRecord(journal.completed)) throw new Error("Persisted journal completed entries were malformed");
  assert.deepEqual(journal.completed["agent/one"], { path: "agent/one", value: "done" });
});
