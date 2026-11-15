import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { RunStore } from "../src/store.js";
import { RunWorktreeCoordinator, legacyWorktreeAdmission } from "../src/run-worktree-coordinator.js";
import { PhysicalWorktreeLease, worktreeLeaseIdentity, worktreeOwnerDirectory, type WorktreeLeaseIdentity } from "../src/worktree-lease.js";
import { createLaunchSnapshot } from "../src/validation.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { fixtureGit, initializeGitFixture } from "./git-fixture.js";
import { structuralPath } from "../src/paths.js";

function barrier() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
async function fixture(setup: readonly string[] = []) {
  const home = mkdtempSync(join(tmpdir(), "store-transaction-")), cwd = join(home, "repo");
  initializeGitFixture(cwd); fixtureGit(cwd, "commit", "--allow-empty", "-qm", "initial");
  const store = new RunStore(cwd, "s", "r", home);
  await store.create({ id: "r", sessionId: "s", cwd, workflowName: "transaction", state: "running", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return null;", args: null, metadata: { name: "transaction" }, settings: { ...DEFAULT_SETTINGS, worktreeSetup: setup }, models: [], tools: [], agentConfigurations: {}, schemas: [] }));
  return { home, cwd, store, second: () => new RunStore(cwd, "s", "r", home) };
}
const unproven = (error: unknown) => error instanceof Error && "cleanupUnproven" in error && error.cleanupUnproven === true;

for (const count of [0, 1, 2]) for (const separate of [false, true]) void test(`delete fences ${count === 0 ? "empty inventory" : count === 1 ? "after last resource" : "mid-resource inventory"} against ${separate ? "another" : "same"} store creator`, async (t) => {
  const f = await fixture(), stopped = barrier(), resume = barrier();
  for (let i = 0; i < count; i += 1) await f.store.worktree(`seed-${String(i)}`, { setup: "none" });
  const originalRm = fs.rm.bind(fs), originalRename = fs.rename.bind(fs);
  let paused = false;
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (count < 2 && args[0] === f.store.directory && !paused) { paused = true; stopped.release(); await resume.promise; }
    return originalRm(...args);
  });
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (count === 2 && args[1] === join(f.store.directory, "worktrees.json") && !paused) { paused = true; stopped.release(); await resume.promise; }
    return originalRename(...args);
  }); syncBuiltinESMExports();
  const deletion = f.store.delete(true);
  try {
    await stopped.promise;
    let entered = false;
    const creator = (separate ? f.second() : f.store).worktree("queued", { setup: "none" }).then((reference) => { entered = true; return reference; });
    const rejected = assert.rejects(creator);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(entered, false);
    resume.release(); await deletion; await rejected;
    assert.equal(existsSync(f.store.directory), false, "queued creation must not resurrect a deleted run");
    assert.doesNotMatch(fixtureGit(f.cwd, "worktree", "list", "--porcelain"), /worktrees\//);
    assert.deepEqual(readdirSync(join(dirname(f.store.directory), ".worktree-transactions")), []);
  } finally { resume.release(); await deletion.catch(() => undefined); t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.home, { recursive: true, force: true }); }
});

for (const separate of [false, true]) void test(`delete never removes a live physical root through ${separate ? "another" : "same"} store`, async () => {
  const f = await fixture(), reference = await f.store.worktree("live", { setup: "none" });
  writeFileSync(join(reference.path, "live.txt"), "must survive");
  const identity = await worktreeLeaseIdentity(reference.path), holder = await PhysicalWorktreeLease.acquire(identity, { runId: "live", sessionId: "s", executionId: "execution" });
  const owner = join(worktreeOwnerDirectory(identity), "owner.json"), bytes = readFileSync(owner), inode = statSync(owner).ino;
  const records = readFileSync(join(f.store.directory, "worktrees.json"));
  try {
    await assert.rejects((separate ? f.second() : f.store).delete(true));
    assert.equal(readFileSync(join(reference.path, "live.txt"), "utf8"), "must survive");
    assert.deepEqual(readFileSync(owner), bytes); assert.equal(statSync(owner).ino, inode);
    assert.deepEqual(readFileSync(join(f.store.directory, "worktrees.json")), records);
    assert.ok(fixtureGit(f.cwd, "worktree", "list", "--porcelain").includes(reference.path));
  } finally { await holder.release(); rmSync(f.home, { recursive: true, force: true }); }
});

void test("two independent creators serialize publication and preserve both latest inventory records", async (t) => {
  const f = await fixture(), stopped = barrier(), resume = barrier(), original = fs.rename.bind(fs);
  let publications = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === join(f.store.directory, "worktrees.json") && ++publications === 1) { stopped.release(); await resume.promise; }
    return original(...args);
  }); syncBuiltinESMExports();
  const first = f.store.worktree("one", { setup: "none" });
  try {
    await stopped.promise;
    const second = f.second().worktree("two", { setup: "none" });
    await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(publications, 1);
    resume.release(); const references = await Promise.all([first, second]);
    assert.equal(publications, 2);
    const records = JSON.parse(readFileSync(join(f.store.directory, "worktrees.json"), "utf8")) as { owner: string }[];
    assert.deepEqual(records.map((record) => record.owner).sort(), ["one", "two"]);
    for (const reference of references) { assert.equal(existsSync(reference.path), true); assert.ok(fixtureGit(f.cwd, "worktree", "list", "--porcelain").includes(reference.path)); }
  } finally { resume.release(); await first.catch(() => undefined); t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.home, { recursive: true, force: true }); }
});

void test("independent processes use public RunStore worktree to preserve two real Git roots and records", async (t) => {
  const f = await fixture();
  const source = new URL("../src/store.js", import.meta.url).href;
  const children: { child: ReturnType<typeof spawn>; closed: Promise<void> }[] = [];
  const start = (owner: string) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `
      import fs from 'node:fs/promises';
      import {syncBuiltinESMExports} from 'node:module';
      const rename = fs.rename.bind(fs), mkdir = fs.mkdir.bind(fs);
      const resumed = new Promise(resolve => process.once('message', resolve));
      fs.rename = async (...args) => {if (${JSON.stringify(owner)} === 'one' && args[1] === ${JSON.stringify(join(f.store.directory, "worktrees.json"))}) {process.send('publishing'); await resumed;} return rename(...args);};
      fs.mkdir = async (...args) => {try {return await mkdir(...args);} catch(error) {if (${JSON.stringify(owner)} === 'two' && error.code === 'EEXIST' && String(args[0]).includes('/.worktree-transactions/')) process.send('contended'); throw error;}};
      syncBuiltinESMExports();
      const {RunStore} = await import(${JSON.stringify(source)});
      const reference = await new RunStore(${JSON.stringify(f.cwd)}, 's', 'r', ${JSON.stringify(f.home)}).worktree(${JSON.stringify(owner)}, {setup:'none'});
      process.send({reference}); process.disconnect();
    `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
    t.diagnostic(`owned RunStore child pid=${String(child.pid)} owner=${owner} command=${process.execPath} --input-type=module -e`);
    let stderr = ""; child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const seen = new Set<string>(), listeners = new Map<string, () => void>();
    child.on("message", (message) => { if (typeof message === "string") { seen.add(message); listeners.get(message)?.(); } });
    const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => { if (code === 0) resolve(); else reject(new Error(`RunStore ${owner} exited ${String(code)}: ${stderr}`)); }); });
    children.push({ child, closed });
    return { child, closed, message: (name: string) => Promise.race([seen.has(name) ? Promise.resolve() : new Promise<void>((resolve) => { listeners.set(name, resolve); }), closed.then(() => { throw new Error(`${owner} exited before ${name}`); })]) };
  };
  try {
    const first = start("one"); await first.message("publishing");
    const second = start("two"); await second.message("contended");
    assert.deepEqual(JSON.parse(readFileSync(join(f.store.directory, "worktrees.json"), "utf8")), []);
    first.child.send("resume"); await Promise.all([first.closed, second.closed]);
    const records = JSON.parse(readFileSync(join(f.store.directory, "worktrees.json"), "utf8")) as { owner: string; path: string }[];
    assert.deepEqual(records.map((record) => record.owner).sort(), ["one", "two"]);
    assert.equal(new Set(records.map((record) => record.path)).size, 2);
    assert.equal((await f.store.worktrees()).length, 2);
    for (const record of records) { assert.equal(existsSync(record.path), true); assert.ok(fixtureGit(f.cwd, "worktree", "list", "--porcelain").includes(record.path)); }
  } finally {
    for (const { child } of children) if (child.connected) child.send("resume");
    await Promise.all(children.map(({ closed }) => closed)); rmSync(f.home, { recursive: true, force: true });
  }
});

void test("concurrent inherited resolutions preserve latest borrowed-binding RMW across store instances", async (t) => {
  const f = await fixture();
  const owners = [structuralPath("worktree", "named", "one"), structuralPath("worktree", "named", "two")];
  const references = await Promise.all(owners.map((owner) => f.store.worktree(owner, { setup: "none" })));
  await f.store.updateState((current) => ({ ...current, state: "completed" }));
  const child = new RunStore(f.cwd, "s", "child", f.home), { snapshot } = await f.store.load();
  await child.create({ id: "child", sessionId: "s", cwd: f.cwd, workflowName: "transaction", state: "running", parentRunId: "r", agents: [], agentSessions: [] }, snapshot);
  const stopped = barrier(), resume = barrier(), original = fs.rename.bind(fs); let publications = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (args[1] === join(child.directory, "borrowed-worktrees.json") && ++publications === 1) { stopped.release(); await resume.promise; }
    return original(...args);
  }); syncBuiltinESMExports();
  const first = child.worktree(owners[0] ?? "");
  try {
    await stopped.promise;
    const second = new RunStore(f.cwd, "s", "child", f.home).worktree(owners[1] ?? "");
    await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(publications, 1);
    resume.release(); assert.deepEqual(await Promise.all([first, second]), references);
    assert.equal(publications, 2); assert.deepEqual((await child.borrowedWorktrees()).map((binding) => binding.name).sort(), ["one", "two"]);
    assert.deepEqual(JSON.parse(readFileSync(join(child.directory, "worktrees.json"), "utf8")), []);
    for (const reference of references) assert.equal(existsSync(reference.path), true);
  } finally { resume.release(); await first.catch(() => undefined); t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.home, { recursive: true, force: true }); }
});

void test("marker receipt CAS rejects same-byte inode replacement before any update", async (t) => {
  const f = await fixture(), original = fs.lstat.bind(fs), originalRename = fs.rename.bind(fs);
  let observations = 0, updates = 0, marker = "", bytes = "", inode = 0;
  t.mock.method(fs, "lstat", (async (...args: Parameters<typeof fs.lstat>) => {
    if (String(args[0]).endsWith(".creating") && existsSync(String(args[0])) && ++observations === 2) {
      marker = String(args[0]); bytes = readFileSync(marker, "utf8"); renameSync(marker, `${marker}.original`); writeFileSync(marker, bytes); inode = statSync(marker).ino;
    }
    return original(...args);
  }) as typeof fs.lstat);
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { if (String(args[1]).endsWith(".creating")) updates += 1; return originalRename(...args); }); syncBuiltinESMExports();
  try {
    await assert.rejects(f.store.worktree("cas", { setup: "none" }), unproven);
    assert.ok(marker); assert.equal(updates, 0); assert.equal(readFileSync(marker, "utf8"), bytes); assert.equal(statSync(marker).ino, inode);
    await assert.rejects(f.second().worktree("sibling", { setup: "none" }), unproven);
    assert.equal(readFileSync(marker, "utf8"), bytes); assert.equal(statSync(marker).ino, inode);
    assert.deepEqual(JSON.parse(readFileSync(join(f.store.directory, "worktrees.json"), "utf8")), []);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.home, { recursive: true, force: true }); }
});

void test("same-owner fresh loser before first physical claim cannot alter leased winner metadata", async () => {
  const f = await fixture(), reference = await f.store.worktree("same", { setup: "none" });
  const identity = await worktreeLeaseIdentity(reference.path), holder = await PhysicalWorktreeLease.acquire(identity, { runId: "live", sessionId: "s", executionId: "execution" });
  const inventory = join(f.store.directory, "worktrees.json"), bytes = readFileSync(inventory), owner = join(holder.directory, "owner.json"), ownerBytes = readFileSync(owner), inode = statSync(owner).ino;
  writeFileSync(join(reference.path, "winner.txt"), "winner");
  try {
    await assert.rejects(f.second().worktree("same", { setup: "none", fresh: true }), /Fresh worktree/);
    assert.deepEqual(readFileSync(inventory), bytes); assert.deepEqual(readFileSync(owner), ownerBytes); assert.equal(statSync(owner).ino, inode);
    assert.equal(readFileSync(join(reference.path, "winner.txt"), "utf8"), "winner");
    assert.equal(readdirSync(f.store.directory).some((entry) => entry.endsWith(".creating")), false);
  } finally { await holder.release(); rmSync(f.home, { recursive: true, force: true }); }
});

void test("unpublished branch failure never writes or removes an unrelated inventory record", async (t) => {
  const f = await fixture(), winner = await f.store.worktree("winner", { setup: "none" });
  const inventory = join(f.store.directory, "worktrees.json"), before = readFileSync(inventory), original = fs.rename.bind(fs);
  let writes = 0;
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => { if (args[1] === inventory) writes += 1; return original(...args); }); syncBuiltinESMExports();
  // A pre-existing branch causes failure after exclusive marker creation, before a materialization claim exists.
  const hash = (await import("node:crypto")).createHash("sha256").update("s\0r\0loser").digest("hex").slice(0, 16);
  fixtureGit(f.cwd, "branch", `pi-extensible-workflows/r/${hash}`);
  try {
    await assert.rejects(f.second().worktree("loser", { setup: "none" }));
    assert.equal(writes, 0); assert.deepEqual(readFileSync(inventory), before); assert.equal(existsSync(winner.path), true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.home, { recursive: true, force: true }); }
});

for (const fault of ["partial", "replacement", "publication"] as const) void test(`creation ${fault} uncertainty retains attempt and blocks sibling instances`, async (t) => {
  const f = await fixture(), originalOpen = fs.open.bind(fs), originalRename = fs.rename.bind(fs);
  let marker = "", expected = "", expectedInode = 0;
  if (fault === "partial") t.mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
    const file = await originalOpen(...args);
    if (String(args[0]).endsWith(".creating")) {
      marker = String(args[0]); const write = file.writeFile.bind(file);
      file.writeFile = (async () => { await write("{"); throw new Error("partial marker write"); });
    }
    return file;
  }) as typeof fs.open);
  t.mock.method(fs, "rename", async (...args: Parameters<typeof fs.rename>) => {
    if (fault === "publication" && args[1] === join(f.store.directory, "worktrees.json")) { await originalRename(...args); throw new Error("publication write then reject"); }
    if (fault === "replacement" && String(args[1]).endsWith(".creating")) {
      marker = String(args[1]); renameSync(marker, `${marker}.old`); writeFileSync(marker, "replacement"); expected = readFileSync(marker, "utf8"); expectedInode = statSync(marker).ino;
      throw new Error("marker inode replaced");
    }
    return originalRename(...args);
  }); syncBuiltinESMExports();
  try {
    await assert.rejects(f.store.worktree("gate", { setup: "none" }), unproven);
    if (fault === "partial") assert.equal(readFileSync(marker, "utf8"), "{");
    if (fault === "replacement") { assert.equal(readFileSync(marker, "utf8"), expected); assert.equal(statSync(marker).ino, expectedInode); }
    await assert.rejects(f.second().worktree("other", { setup: "none" }), unproven);
    await assert.rejects(f.second().delete(true), unproven);
    if (fault === "publication") assert.equal((JSON.parse(readFileSync(join(f.store.directory, "worktrees.json"), "utf8")) as unknown[]).length, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.home, { recursive: true, force: true }); }
});

for (const markerBytes of ["{", "null", "{}"] ) void test(`malformed pre-existing marker ${markerBytes} cannot be adopted or erased`, async () => {
  const f = await fixture(), reference = await f.store.worktree("gate", { setup: "none" });
  const marker = join(f.store.directory, `worktree-${basename(reference.path)}.creating`);
  writeFileSync(marker, markerBytes); const inode = statSync(marker).ino;
  writeFileSync(join(f.store.directory, "worktrees.json"), "[]\n");
  try {
    await assert.rejects(f.second().worktree("gate", { setup: "none" })); await assert.rejects(f.second().delete(true));
    assert.equal(readFileSync(marker, "utf8"), markerBytes); assert.equal(statSync(marker).ino, inode); assert.equal(existsSync(reference.path), true);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

void test("host-only legacy admission cancels in run queue without invoking setup", async () => {
  const f = await fixture(["exit 9"]), entered = barrier(), release = barrier();
  const holder = new RunWorktreeCoordinator(f.store.directory).run(undefined, async () => { entered.release(); await release.promise; });
  await entered.promise; const controller = new AbortController();
  try {
    const pending = f.store[legacyWorktreeAdmission]("legacy", controller.signal), rejected = assert.rejects(pending, { code: "CANCELLED" });
    controller.abort(); await rejected;
    assert.deepEqual(JSON.parse(readFileSync(join(f.store.directory, "worktrees.json"), "utf8")), []);
  } finally { release.release(); await holder; rmSync(f.home, { recursive: true, force: true }); }
});

void test("setup cancellation drains the actual owned process before a queued public worktree is admitted", async () => {
  const command = `${JSON.stringify(process.execPath)} -e 'require("node:fs").writeFileSync(".setup-ready", String(process.pid)); setInterval(() => {}, 1000)'`;
  const f = await fixture([command]), ready = barrier(), controller = new AbortController();
  const watcher = watch(f.store.directory, { recursive: true }, (_event, filename) => { if (filename?.endsWith(".setup-ready")) ready.release(); });
  const first = f.store.worktree("cancel-setup", { setup: "configured" }, controller.signal);
  const rejected = assert.rejects(first, { code: "CANCELLED" });
  let next: ReturnType<RunStore["worktree"]> | undefined;
  try {
    await ready.promise;
    const markerName = readdirSync(f.store.directory).find((name) => name.endsWith(".creating")); assert.ok(markerName);
    const marker = JSON.parse(readFileSync(join(f.store.directory, markerName), "utf8")) as { path: string; resourceIdentity: WorktreeLeaseIdentity };
    const owner = join(worktreeOwnerDirectory(marker.resourceIdentity), "owner.json"); assert.equal(existsSync(owner), true);
    let admitted = false;
    next = f.second().worktree("after-cancel", { setup: "none" }).then((reference) => { admitted = true; return reference; });
    await new Promise<void>((resolve) => setImmediate(resolve)); assert.equal(admitted, false);
    controller.abort(); await rejected; const reference = await next;
    assert.equal(existsSync(owner), false); assert.equal(existsSync(marker.path), false); assert.equal(existsSync(reference.path), true);
    assert.deepEqual((await f.store.worktrees()).map((record) => record.owner), ["after-cancel"]);
    assert.deepEqual(readdirSync(join(dirname(f.store.directory), ".worktree-transactions")), []);
  } finally { watcher.close(); controller.abort(); await rejected; await next?.catch(() => undefined); rmSync(f.home, { recursive: true, force: true }); }
});

void test("partial final run removal retains external admission authority", async (t) => {
  const f = await fixture(), original = fs.rm.bind(fs);
  t.mock.method(fs, "rm", async (...args: Parameters<typeof fs.rm>) => {
    if (args[0] === f.store.directory) { await original(join(f.store.directory, "state.json")); throw new Error("partial final removal"); }
    return original(...args);
  }); syncBuiltinESMExports();
  try {
    await assert.rejects(f.store.delete(true), unproven);
    await assert.rejects(f.second().worktree("queued", { setup: "none" }), unproven);
    assert.equal(readdirSync(join(dirname(f.store.directory), ".worktree-transactions")).length, 1);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.home, { recursive: true, force: true }); }
});

void test("admission-only finalization cancels a coordinator-queued resolver while tracked cleanup retains its physical owner", async () => {
  const { WorkflowOwnership } = await import("../src/ownership.js");
  const { executeShellCommand } = await import("../src/execution.js");
  const f = await fixture(), gate = await f.store.worktree("gate", { setup: "none" });
  const entered = barrier(), release = barrier(), resolving = barrier(), cleanupStarted = barrier(), cleanupDrained = barrier();
  const controller = new AbortController();
  const ownership = new WorkflowOwnership(f.cwd, "r", "s", controller.signal, executeShellCommand, async (owner, signal) => {
    resolving.release(); return f.store.worktree(owner, undefined, signal);
  });
  const prior = await ownership.enter(f.cwd, undefined, controller.signal);
  const cleanup = ownership.associate(prior.scope, async () => { cleanupStarted.release(); await cleanupDrained.promise; });
  await cleanupStarted.promise;
  const holder = new RunWorktreeCoordinator(f.store.directory).run(undefined, async () => { entered.release(); await release.promise; });
  await entered.promise;
  const admission = ownership.enter(gate.path, "gate", controller.signal), rejected = assert.rejects(admission, { code: "CANCELLED" });
  let finalization: Promise<void> | undefined;
  try {
    await resolving.promise;
    finalization = ownership.finalize(); const failed = assert.rejects(finalization, { code: "CANCELLED" });
    await rejected;
    assert.equal(controller.signal.aborted, false);
    const identity = await worktreeLeaseIdentity(f.cwd);
    assert.equal(existsSync(join(worktreeOwnerDirectory(identity), "owner.json")), true);
    cleanupDrained.release(); await cleanup; await failed;
    assert.equal(existsSync(join(worktreeOwnerDirectory(identity), "owner.json")), false);
    // Finalization completes without releasing the unrelated run transaction or notifying lifecycle terminal.
  } finally { release.release(); cleanupDrained.release(); await holder; await cleanup; await rejected; await finalization?.catch(() => undefined); rmSync(f.home, { recursive: true, force: true }); }
});

void test("lost-record live-owned root blocks deletion unchanged on disk", async () => {
  const f = await fixture(), reference = await f.store.worktree("unknown", { setup: "none" });
  const holder = await PhysicalWorktreeLease.acquire(await worktreeLeaseIdentity(reference.path), { runId: "live", sessionId: "s", executionId: "execution" });
  const owner = join(holder.directory, "owner.json"), bytes = readFileSync(owner), inode = statSync(owner).ino;
  writeFileSync(join(reference.path, "live.txt"), "unknown-live-root"); writeFileSync(join(f.store.directory, "worktrees.json"), "[]\n");
  try {
    await assert.rejects(f.second().delete(true), /Unrecorded worktree artifact/);
    assert.equal(readFileSync(join(reference.path, "live.txt"), "utf8"), "unknown-live-root");
    assert.deepEqual(readFileSync(owner), bytes); assert.equal(statSync(owner).ino, inode);
    assert.ok(fixtureGit(f.cwd, "worktree", "list", "--porcelain").includes(reference.path));
  } finally { await holder.release(); rmSync(f.home, { recursive: true, force: true }); }
});
