import assert from "node:assert/strict";
import childProcess, { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalPath } from "../src/paths.js";
import { RunStore } from "../src/persistence.js";
import { createLaunchSnapshot } from "../src/validation.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { WorkflowOwnership } from "../src/ownership.js";
import { executeShellCommand } from "../src/execution.js";
import { worktreeLeaseIdentity, worktreeOwnerDirectory } from "../src/worktree-lease.js";

const barrier = () => { let release!: () => void; const reached = new Promise<void>((resolve) => { release = resolve; }); return { reached, release }; };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "cleanup-exclusion-")), cwd = join(home, "repo");
  git(home, "init", "-q", cwd); git(cwd, "config", "user.name", "Fixture"); git(cwd, "config", "user.email", "fixture@example.invalid"); git(cwd, "commit", "--allow-empty", "-qm", "initial");
  const store = new RunStore(cwd, "s", "r", home);
  await store.create({ id: "r", sessionId: "s", cwd, workflowName: "exclusion", state: "failed", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return null;", args: null, metadata: { name: "exclusion" }, settings: DEFAULT_SETTINGS, models: [], tools: [], agentConfigurations: {}, schemas: [] }));
  const gate = await store.worktree("gate", { setup: "none" });
  return { home, cwd, store, gate };
}

void test("execution wins after RunStore deletion precheck and cleanup cannot delete its root or owner", { timeout: 15_000 }, async (t) => {
  const f = await fixture(), blocked = barrier(), release = barrier();
  const readdir = fsPromises.readdir.bind(fsPromises);
  t.mock.method(fsPromises, "readdir", (async (...args: Parameters<typeof fsPromises.readdir>) => {
    const entries = await readdir(...args);
    if (args[0] === f.store.directory) { blocked.release(); await release.reached; }
    return entries;
  }) as typeof fsPromises.readdir);
  syncBuiltinESMExports();
  const controller = new AbortController(), owner = new WorkflowOwnership(f.gate.path, "execution", "s", controller.signal, executeShellCommand);
  let work: Promise<unknown> | undefined, deletion: Promise<void> | undefined;
  try {
    deletion = f.store.delete(true); void deletion.catch(() => undefined);
    await blocked.reached;
    const reference = await owner.enter(f.gate.path, undefined, controller.signal);
    const identity = await worktreeLeaseIdentity(f.gate.path);
    const ownerFile = join(worktreeOwnerDirectory(identity), "owner.json");
    const ready = join(f.home, "ready"), finish = join(f.home, "finish");
    const script = `const fs=require("node:fs");fs.writeFileSync(${JSON.stringify(ready)},"ready");const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(finish)})){clearInterval(t);process.exit(0)}},10);`;
    work = owner.shell(reference.scope, `exec ${quote(process.execPath)} -e ${quote(script)}`, { timeoutMs: 5000 }); void work.catch(() => undefined);
    const deadline = Date.now() + 4000;
    while (!existsSync(ready)) { assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 10)); }
    const before = readFileSync(ownerFile, "utf8");
    release.release();
    await assert.rejects(deletion, /physical owner/);
    assert.equal(existsSync(f.gate.path), true); assert.equal(readFileSync(ownerFile, "utf8"), before);
    writeFileSync(finish, "finish"); await work;
    await owner.leave(reference.scope); await owner.finalize();
    t.mock.restoreAll(); syncBuiltinESMExports();
    await new RunStore(f.cwd, "s", "r", f.home).delete(true);
    assert.equal(existsSync(f.gate.path), false);
  } finally {
    controller.abort(); await work?.catch(() => undefined); await owner.finalize().catch(() => undefined);
    release.release(); await deletion?.catch(() => undefined);
    t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.home, { recursive: true, force: true });
  }
});

void test("cleanup wins and blocks execution admission before any callback or command", { timeout: 15_000 }, async (t) => {
  const f = await fixture(), blocked = barrier(), release = barrier();
  const fork = childProcess.fork.bind(childProcess);
  t.mock.method(childProcess, "fork", ((...args: Parameters<typeof childProcess.fork>) => {
    const child = fork(...args);
    if (String(args[0]).endsWith("/supervisor.cjs")) {
      const send = child.send.bind(child);
      child.send = (message: unknown, ...rest: unknown[]) => {
        const start = message as { type?: string; command?: string };
        if (start.type === "start" && start.command?.includes("'worktree' 'remove'")) {
          blocked.release(); void release.reached.then(() => { Reflect.apply(send, child, [message, ...rest]); }); return true;
        }
        return Reflect.apply(send, child, [message, ...rest]) as boolean;
      };
    }
    return child;
  }) as typeof childProcess.fork);
  syncBuiltinESMExports();
  const controller = new AbortController(), contender = new WorkflowOwnership(f.gate.path, "contender", "s", controller.signal, executeShellCommand);
  let scope: string | undefined, deletion: Promise<void> | undefined;
  try {
    deletion = f.store.delete(true); void deletion.catch(() => undefined); await blocked.reached;
    const admission = contender.enter(f.gate.path, undefined, controller.signal);
    void admission.then((reference) => { scope = reference.scope; }, () => undefined);
    await assert.rejects(admission, /physical owner/);
    assert.equal(scope, undefined);
    release.release(); await deletion;
    assert.equal(existsSync(f.gate.path), false);
  } finally {
    if (scope) await contender.leave(scope).catch(() => undefined);
    controller.abort(); await contender.finalize().catch(() => undefined);
    release.release(); await deletion?.catch(() => undefined);
    t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.home, { recursive: true, force: true });
  }
});

void test("external owner survives linked root/metadata removal and stale pre-cleanup identity cannot admit", async () => {
  const { PhysicalWorktreeLease } = await import("../src/worktree-lease.js");
  const f = await fixture(), identity = await worktreeLeaseIdentity(f.gate.path);
  const owner = await PhysicalWorktreeLease.acquire(identity, { runId: "cleanup", sessionId: "s", executionId: "e" }, "cleanup");
  try {
    git(f.cwd, "worktree", "remove", "--force", f.gate.path);
    assert.equal(existsSync(identity.gitDirectory), false);
    assert.equal(existsSync(owner.directory), true); await owner.verify();
    await assert.rejects(PhysicalWorktreeLease.acquire(identity, { runId: "racer", sessionId: "s", executionId: "e" }), /physical owner/);
    await owner.release();
    await assert.rejects(PhysicalWorktreeLease.acquire(identity, { runId: "stale", sessionId: "s", executionId: "e" }), /corroborated/);
    assert.equal(existsSync(owner.directory), false, "a proven pre-admission rejection removes only its own fresh claim");
    await assert.rejects(new RunStore(f.cwd, "s", "r", f.home).delete(true), /corroborated/);
    assert.equal(existsSync(f.store.directory), true, "a fresh store cannot guess dead-resource identity or delete its transaction");
  } finally { await owner.release().catch(() => undefined); rmSync(f.home, { recursive: true, force: true }); }
});

void test("old inner live stale malformed and partial owners block both new execution and cleanup unchanged", async () => {
  const { mkdirSync } = await import("node:fs");
  const { PhysicalWorktreeLease } = await import("../src/worktree-lease.js");
  const f = await fixture(), identity = await worktreeLeaseIdentity(f.gate.path), inner = join(identity.gitDirectory, "pi-worktree-lease");
  try {
    for (const contents of [undefined, "malformed", JSON.stringify({ pid: process.pid, nonce: "live" }), JSON.stringify({ pid: 99999999, nonce: "stale" })]) {
      mkdirSync(inner); if (contents !== undefined) writeFileSync(join(inner, "owner.json"), contents);
      await assert.rejects(PhysicalWorktreeLease.acquire(identity, { runId: "new", sessionId: "s", executionId: "e" }), /old-format physical owner/);
      await assert.rejects(f.store.delete(true), /old-format physical owner/);
      assert.equal(existsSync(f.gate.path), true); assert.equal(existsSync(inner), true);
      if (contents !== undefined) assert.equal(readFileSync(join(inner, "owner.json"), "utf8"), contents);
      assert.equal(existsSync(worktreeOwnerDirectory(identity)), false);
      rmSync(inner, { recursive: true });
    }
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

void test("failed external owner write leaves a blocking partial claim without a cleanup fallback", async (t) => {
  const { PhysicalWorktreeLease } = await import("../src/worktree-lease.js");
  const f = await fixture(), identity = await worktreeLeaseIdentity(f.gate.path), directory = worktreeOwnerDirectory(identity);
  const open = fsPromises.open.bind(fsPromises);
  t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
    if (args[0] === join(directory, "owner.json")) throw new Error("injected owner write fault");
    return open(...args);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(PhysicalWorktreeLease.acquire(identity, { runId: "partial", sessionId: "s", executionId: "e" }), (error: unknown) => error instanceof Error && "cleanupUnproven" in error && error.cleanupUnproven === true);
    assert.equal(existsSync(directory), true);
    t.mock.restoreAll(); syncBuiltinESMExports();
    await assert.rejects(f.store.delete(true), /physical owner/);
    assert.equal(existsSync(f.gate.path), true); assert.equal(existsSync(directory), true);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.home, { recursive: true, force: true }); }
});

void test("corrupt persisted resource identity cannot authorize another common directory or sibling", async () => {
  const f = await fixture(), sibling = await f.store.worktree("sibling", { setup: "none" });
  const identity = await worktreeLeaseIdentity(f.gate.path), siblingIdentity = await worktreeLeaseIdentity(sibling.path);
  try {
    const records = await f.store.worktrees();
    for (const bad of [{ ...identity, commonGitDirectory: f.home }, { ...identity, gitDirectory: siblingIdentity.gitDirectory }]) {
      writeFileSync(join(f.store.directory, "worktrees.json"), JSON.stringify(records.map((record) => record.owner === f.gate.owner ? { ...record, resourceIdentity: bad } : record)));
      await assert.rejects(new RunStore(f.cwd, "s", "r", f.home).delete(true), /identity|resource/);
      assert.equal(existsSync(f.gate.path), true); assert.equal(existsSync(sibling.path), true);
    }
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

void test("creator loses shared admission after Git materialization and cannot set up or roll back winner", { timeout: 15_000 }, async (t) => {
  const f = await fixture(), blocked = barrier(), release = barrier(), setupMarker = join(f.home, "forbidden-setup");
  const loaded = await f.store.load();
  await f.store.saveSnapshot({ ...loaded.snapshot, settings: { ...loaded.snapshot.settings, worktreeSetup: [`printf forbidden > ${quote(setupMarker)}`] } });
  const mkdir = fsPromises.mkdir.bind(fsPromises); let held = false;
  t.mock.method(fsPromises, "mkdir", (async (...args: Parameters<typeof fsPromises.mkdir>) => {
    if (!held && typeof args[0] === "string" && /\/pi-worktree-owners\/[0-9a-f]{64}$/.test(args[0])) { held = true; blocked.release(); await release.reached; }
    return mkdir(...args);
  }) as typeof fsPromises.mkdir);
  syncBuiltinESMExports();
  const controller = new AbortController(); let creating: ReturnType<RunStore["worktree"]> | undefined, winner: WorkflowOwnership | undefined, scope: string | undefined;
  try {
    creating = f.store.worktree("contested", { fresh: true }); void creating.catch(() => undefined); await blocked.reached;
    const paths = git(f.cwd, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).map((line) => line.slice(9));
    const root = paths.find((path) => path.startsWith(canonicalPath(join(f.store.directory, "worktrees"))) && canonicalPath(path) !== canonicalPath(f.gate.path)); assert.ok(root);
    winner = new WorkflowOwnership(root, "winner", "s", controller.signal, executeShellCommand);
    scope = (await winner.enter(root, undefined, controller.signal)).scope;
    assert.equal((await winner.shell(scope, "printf winner", {})).stdout, "winner");
    release.release(); await assert.rejects(creating, /physical owner/);
    assert.equal(existsSync(root), true); assert.equal(existsSync(setupMarker), false);
    assert.equal(existsSync(join(worktreeOwnerDirectory(await worktreeLeaseIdentity(root)), "owner.json")), true);
  } finally {
    if (scope) await winner?.leave(scope).catch(() => undefined);
    controller.abort(); await winner?.finalize().catch(() => undefined); release.release(); await creating?.catch(() => undefined);
    t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.home, { recursive: true, force: true });
  }
});

void test("rollback holds the same cleanup owner until branch cleanup and proven marker completion", { timeout: 15_000 }, async (t) => {
  const { PhysicalWorktreeLease } = await import("../src/worktree-lease.js");
  const { readdirSync } = await import("node:fs");
  const f = await fixture(), blocked = barrier(), release = barrier();
  const loaded = await f.store.load(); await f.store.saveSnapshot({ ...loaded.snapshot, settings: { ...loaded.snapshot.settings, worktreeSetup: ["exit 7"] } });
  const fork = childProcess.fork.bind(childProcess);
  t.mock.method(childProcess, "fork", ((...args: Parameters<typeof childProcess.fork>) => {
    const child = fork(...args); if (String(args[0]).endsWith("/supervisor.cjs")) {
      const send = child.send.bind(child);
      child.send = (message: unknown, ...rest: unknown[]) => {
        const start = message as { type?: string; command?: string };
        if (start.type === "start" && start.command?.includes("'worktree' 'remove'")) { blocked.release(); void release.reached.then(() => { Reflect.apply(send, child, [message, ...rest]); }); return true; }
        return Reflect.apply(send, child, [message, ...rest]) as boolean;
      };
    } return child;
  }) as typeof childProcess.fork); syncBuiltinESMExports();
  let creating: ReturnType<RunStore["worktree"]> | undefined;
  try {
    creating = f.store.worktree("rollback", { fresh: true }); void creating.catch(() => undefined); await blocked.reached;
    const file = readdirSync(f.store.directory).find((name) => name.endsWith(".creating")); assert.ok(file);
    const state = JSON.parse(readFileSync(join(f.store.directory, file), "utf8")) as { resourceIdentity: Awaited<ReturnType<typeof worktreeLeaseIdentity>> };
    await assert.rejects(PhysicalWorktreeLease.acquire(state.resourceIdentity, { runId: "racer", sessionId: "s", executionId: "e" }), /physical owner/);
    assert.equal(existsSync(state.resourceIdentity.path), true);
    release.release(); await assert.rejects(creating, /exited with 7/);
    assert.equal(existsSync(state.resourceIdentity.path), false);
    assert.equal(existsSync(worktreeOwnerDirectory(state.resourceIdentity)), false);
    assert.equal((JSON.parse(readFileSync(join(f.store.directory, file), "utf8")) as { cleanupProven?: boolean }).cleanupProven, true);
    await f.store.delete(true); // proven dead marker permits only local bookkeeping; no guessed Git cleanup
  } finally { release.release(); await creating?.catch(() => undefined); t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.home, { recursive: true, force: true }); }
});

void test("unrecorded linked resource blocks final recursive run-directory removal", async () => {
  const f = await fixture();
  try {
    writeFileSync(join(f.store.directory, "worktrees.json"), "[]\n");
    await assert.rejects(f.store.delete(true), /Unrecorded worktree artifact/);
    assert.equal(existsSync(f.gate.path), true);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

void test("legacy dead-resource bookkeeping never removes an external claim or orphan branch", async () => {
  const { PhysicalWorktreeLease } = await import("../src/worktree-lease.js");
  const f = await fixture(), legacy = await f.store.worktree("legacy");
  const identity = await worktreeLeaseIdentity(legacy.path), owner = await PhysicalWorktreeLease.acquire(identity, { runId: "cleanup", sessionId: "s", executionId: "e" }, "cleanup");
  try {
    git(f.cwd, "worktree", "remove", "--force", legacy.path);
    await assert.rejects(new RunStore(f.cwd, "s", "r", f.home).delete(true), /physical owner/);
    await owner.verify();
    await owner.release();
    await new RunStore(f.cwd, "s", "r", f.home).delete(true);
    assert.equal(existsSync(f.store.directory), false);
    assert.equal(git(f.cwd, "rev-parse", "--verify", legacy.branch), legacy.base, "run bookkeeping cleanup must not mutate Git branches");
  } finally { await owner.release().catch(() => undefined); rmSync(f.home, { recursive: true, force: true }); }
});

void test("controlled marker cleanup cannot remove a lease acquired after the orphan scan", { timeout: 15_000 }, async (t) => {
  const { readdirSync } = await import("node:fs");
  const f = await fixture();
  const loaded = await f.store.load(); await f.store.saveSnapshot({ ...loaded.snapshot, settings: { ...loaded.snapshot.settings, worktreeSetup: ["exit 7"] } });
  const fork = childProcess.fork.bind(childProcess);
  // A real ordinary nonzero cleanup leaves a checkout but establishes quiescence;
  // the existing fresh marker is affirmatively proven, not a fabricated proof record.
  t.mock.method(childProcess, "fork", ((...args: Parameters<typeof childProcess.fork>) => {
    const child = fork(...args); if (String(args[0]).endsWith("/supervisor.cjs")) {
      const send = child.send.bind(child);
      child.send = (message: unknown, ...rest: unknown[]) => {
        const start = message as { type?: string; command?: string };
        return Reflect.apply(send, child, [start.type === "start" && start.command?.includes("'worktree' 'remove'") ? { ...start, command: "exit 7" } : message, ...rest]) as boolean;
      };
    } return child;
  }) as typeof childProcess.fork); syncBuiltinESMExports();
  await assert.rejects(f.store.worktree("marker", { fresh: true }), /exited with 7/);
  t.mock.restoreAll(); syncBuiltinESMExports();
  const file = readdirSync(f.store.directory).find((entry) => entry.endsWith(".creating")); assert.ok(file);
  const state = JSON.parse(readFileSync(join(f.store.directory, file), "utf8")) as { path: string; cleanupProven?: boolean; resourceIdentity: Awaited<ReturnType<typeof worktreeLeaseIdentity>> };
  assert.equal(state.cleanupProven, true); assert.equal(existsSync(state.path), true);
  const blocked = barrier(), release = barrier(), readdir = fsPromises.readdir.bind(fsPromises);
  t.mock.method(fsPromises, "readdir", (async (...args: Parameters<typeof fsPromises.readdir>) => {
    const entries = await readdir(...args); if (args[0] === f.store.directory) { blocked.release(); await release.reached; } return entries;
  }) as typeof fsPromises.readdir); syncBuiltinESMExports();
  const controller = new AbortController(), manager = new WorkflowOwnership(state.path, "execution", "s", controller.signal, executeShellCommand);
  let scope: string | undefined, deletion: Promise<void> | undefined;
  try {
    deletion = f.store.delete(true); void deletion.catch(() => undefined); await blocked.reached;
    scope = (await manager.enter(state.path, undefined, controller.signal)).scope;
    assert.equal((await manager.shell(scope, "printf live", {})).stdout, "live");
    const bytes = readFileSync(join(worktreeOwnerDirectory(state.resourceIdentity), "owner.json"), "utf8");
    release.release(); await assert.rejects(deletion, /physical owner/);
    assert.equal(existsSync(state.path), true); assert.equal(readFileSync(join(worktreeOwnerDirectory(state.resourceIdentity), "owner.json"), "utf8"), bytes);
  } finally {
    if (scope) await manager.leave(scope).catch(() => undefined);
    controller.abort(); await manager.finalize().catch(() => undefined); release.release(); await deletion?.catch(() => undefined);
    t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.home, { recursive: true, force: true });
  }
});

void test("external release checks directory inode even when replacement copies nonce and identity", async () => {
  const { PhysicalWorktreeLease } = await import("../src/worktree-lease.js");
  const f = await fixture(), identity = await worktreeLeaseIdentity(f.gate.path);
  const owner = await PhysicalWorktreeLease.acquire(identity, { runId: "original", sessionId: "s", executionId: "e" });
  const moved = `${owner.directory}-original`, bytes = readFileSync(join(owner.directory, "owner.json"), "utf8");
  try {
    renameSync(owner.directory, moved); mkdirSync(owner.directory); writeFileSync(join(owner.directory, "owner.json"), bytes);
    await assert.rejects(owner.release(), /missing or mismatched/);
    assert.equal(readFileSync(join(owner.directory, "owner.json"), "utf8"), bytes);
    await assert.rejects(PhysicalWorktreeLease.acquire(identity, { runId: "new", sessionId: "s", executionId: "e" }), /physical owner/);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

void test("legacy pre-claim dispatch stays direct while controlled and genuinely scoped creation stay supervised", async (t) => {
  const f = await fixture(), fork = childProcess.fork.bind(childProcess), commands: string[] = [];
  t.mock.method(childProcess, "fork", ((...args: Parameters<typeof childProcess.fork>) => {
    const child = fork(...args); if (String(args[0]).endsWith("/supervisor.cjs")) {
      const send = child.send.bind(child);
      child.send = (message: unknown, ...rest: unknown[]) => {
        const start = message as { type?: string; command?: string };
        if (start.type === "start" && start.command) commands.push(start.command);
        return Reflect.apply(send, child, [message, ...rest]) as boolean;
      };
    } return child;
  }) as typeof childProcess.fork); syncBuiltinESMExports();
  const controller = new AbortController(), manager = new WorkflowOwnership(f.cwd, "outer", "s", controller.signal, executeShellCommand);
  let scope: string | undefined;
  try {
    await f.store.worktree("legacy-dispatch");
    assert.ok(commands[0]?.includes("'checkout'"), "legacy pre-claim Git stays on its prior direct path; checkout is owned after actual claim");
    commands.length = 0;
    await f.store.worktree("controlled-dispatch", { setup: "none" });
    assert.ok(commands[0]?.includes("'rev-parse'"), "controlled creation is supervised from entry");
    commands.length = 0;
    scope = (await manager.enter(f.cwd, undefined, controller.signal)).scope;
    const bridge = manager.decorate({ worktree: (owner, signal, options) => f.store.worktree(owner, options, signal) });
    const worktree = bridge.worktree; assert.ok(worktree);
    await manager.within(scope, () => worktree("scoped-dispatch", controller.signal));
    assert.ok(commands[0]?.includes("'rev-parse'"), "an actual outer lease keeps pre-claim supervision");
  } finally {
    if (scope) await manager.leave(scope).catch(() => undefined);
    controller.abort(); await manager.finalize().catch(() => undefined); t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.home, { recursive: true, force: true });
  }
});

for (const earlier of ["ordinary", "uncertain"] as const) {
  void test(`acquisition uncertainty remains authoritative after ${earlier} admission failure`, async (t) => {
    const { OwnedCommandCleanupError } = await import("../src/owned-process.js");
    const { WorkflowError } = await import("../src/types.js");
    const f = await fixture(), identity = await worktreeLeaseIdentity(f.gate.path), directory = worktreeOwnerDirectory(identity);
    const holderController = new AbortController(), testedController = new AbortController();
    const holder = new WorkflowOwnership(f.gate.path, "holder", "s", holderController.signal, executeShellCommand);
    const tested = new WorkflowOwnership(f.gate.path, "tested", "s", testedController.signal, executeShellCommand);
    let held: string | undefined, uncertainty: unknown;
    try {
      if (earlier === "ordinary") {
        held = (await holder.enter(f.gate.path, undefined, holderController.signal)).scope;
        await assert.rejects(tested.enter(f.gate.path, undefined, testedController.signal), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED" && !("cleanupUnproven" in error));
        await holder.leave(held); held = undefined; await holder.finalize();
      }
      const open = fsPromises.open.bind(fsPromises);
      t.mock.method(fsPromises, "open", async (...args: Parameters<typeof fsPromises.open>) => {
        if (args[0] === join(directory, "owner.json")) throw new Error("injected acquisition owner-file I/O failure");
        return open(...args);
      });
      syncBuiltinESMExports();
      const authoredResult = await (async () => {
        try { await tested.enter(f.gate.path, undefined, testedController.signal); }
        catch (error) { uncertainty = error; }
        return "PASS";
      })();
      assert.equal(authoredResult, "PASS", "authored error handling is not the cleanup verdict");
      assert.ok(uncertainty instanceof OwnedCommandCleanupError);
      assert.equal(uncertainty.cleanupUnproven, true);
      assert.equal(existsSync(directory), true, "the actual atomic external claim remains blocking");
      assert.equal(existsSync(join(directory, "owner.json")), false, "fault occurred at the real owner-file open boundary");
      t.mock.restoreAll(); syncBuiltinESMExports();
      if (earlier === "uncertain") {
        await assert.rejects(tested.enter(f.gate.path, undefined, testedController.signal), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED" && !("cleanupUnproven" in error));
      }
      await assert.rejects(tested.finalize(), (error: unknown) => {
        assert.ok(error instanceof OwnedCommandCleanupError);
        assert.equal(error.cleanupUnproven, true);
        return error === uncertainty;
      });
      assert.equal(existsSync(directory), true, "finalization must not remove a partial acquisition claim");
    } finally {
      t.mock.restoreAll(); syncBuiltinESMExports();
      if (held) await holder.leave(held).catch(() => undefined);
      holderController.abort(); testedController.abort();
      await holder.finalize().catch(() => undefined); await tested.finalize().catch(() => undefined);
      rmSync(f.home, { recursive: true, force: true });
    }
  });
}
