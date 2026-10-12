import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import fs from "node:fs";
import fsPromises, { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import test from "node:test";
import { createTrajectoryController, trajectoryServerPath, type TrajectoryController } from "../src/index.js";
import { SEMANTIC_MAP_BUILD_STAMP } from "../src/semantic-map-assets.js";
import { tryAcquireStartupMutex } from "../src/startup-mutex.js";
import { isNodeError } from "../../src/utils.js";

type TrajectoryLock = { pid: number; port: number; fingerprint?: string };

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { resolve(); });
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(); }));
  return port;
}

function lockPath(home: string): string { return join(home, "pi-extensible-workflows", "trajectory.lock"); }
async function readLock(home: string): Promise<TrajectoryLock> { return JSON.parse(await readFile(lockPath(home), "utf8")) as TrajectoryLock; }
function input(home: string, port: number) {
  return { cwd: home, sessionId: "trajectory-lock-test", port, loadRuns: async () => [], loadSubagents: async () => [], loadMetadata: async () => ({ runs: [], subagents: [] }), handleAction: async () => {} };
}
async function currentFingerprint(): Promise<string> {
  const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));
  const serverBytes = await readFile(serverPath);
  return `${createHash("sha256").update(serverBytes).digest("hex")}:${SEMANTIC_MAP_BUILD_STAMP}`;
}
function kill(pid: number): void {
  try { process.kill(pid, "SIGKILL"); }
  catch (error) { if (!isNodeError(error, "ESRCH")) throw error; }
}
async function cleanup(home: string, controllers: readonly TrajectoryController[], pids: readonly number[]): Promise<void> {
  for (const controller of controllers) {
    try { await controller.close(); } catch { /* Test cleanup is best effort. */ }
  }
  // A broken lock can name this test process, which must survive its own cleanup.
  for (const pid of pids) if (pid !== process.pid) kill(pid);
  await rm(home, { recursive: true, force: true });
}

void test("healthy matching Trajectory lock reuses the same process and port", async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-match-"));
  const port = await availablePort();
  const controllers: TrajectoryController[] = [];
  const pids: number[] = [];
  try {
    const first = createTrajectoryController(home);
    controllers.push(first);
    await first.open(input(home, port));
    await first.close();
    const firstLock = await readLock(home);
    pids.push(firstLock.pid);

    const second = createTrajectoryController(home);
    controllers.push(second);
    await second.open(input(home, port));
    await second.close();
    const secondLock = await readLock(home);
    pids.push(secondLock.pid);

    assert.equal(secondLock.pid, firstLock.pid);
    assert.equal(secondLock.port, firstLock.port);
    assert.equal(secondLock.fingerprint, firstLock.fingerprint);
  } finally {
    await cleanup(home, controllers, pids);
  }
});

async function staleLockIsReplaced(missingFingerprint: boolean): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), missingFingerprint ? "trajectory-lock-missing-" : "trajectory-lock-mismatch-"));
  const port = await availablePort();
  const controllers: TrajectoryController[] = [];
  const pids: number[] = [];
  try {
    const first = createTrajectoryController(home);
    controllers.push(first);
    await first.open(input(home, port));
    await first.close();
    const firstLock = await readLock(home);
    pids.push(firstLock.pid);
    const staleLock = { ...firstLock, ...(missingFingerprint ? {} : { fingerprint: "different" }) };
    if (missingFingerprint) delete staleLock.fingerprint;
    await writeFile(lockPath(home), `${JSON.stringify(staleLock)}\n`, "utf8");

    const replacement = createTrajectoryController(home);
    controllers.push(replacement);
    await replacement.open(input(home, port));
    await replacement.close();
    const replacementLock = await readLock(home);
    pids.push(replacementLock.pid);

    assert.notEqual(replacementLock.pid, firstLock.pid);
    assert.equal(replacementLock.port, port);
    assert.equal(replacementLock.fingerprint, await currentFingerprint());
  } finally {
    await cleanup(home, controllers, pids);
  }
}

void test("healthy Trajectory lock with a different fingerprint is replaced", async () => { await staleLockIsReplaced(false); });
void test("healthy Trajectory lock without a fingerprint is replaced", async () => { await staleLockIsReplaced(true); });

async function serverIdentity(port: number): Promise<{ pid?: number; fingerprint?: string } | undefined> {
  try { return await (await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(300) })).json() as { pid?: number; fingerprint?: string }; } catch { return undefined; }
}

// A stale server that ignores SIGTERM is replaced only once it is confirmed stopped; while it may still serve, its lock stays and no server starts beside it.
async function stubbornStaleServer(port: "same" | "other", identity: "confirmed" | "unreadable"): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), `trajectory-lock-stubborn-${port}-${identity}-`));
  const stalePort = await availablePort();
  const openPort = port === "same" ? stalePort : await availablePort();
  const controllers: TrajectoryController[] = [];
  const pids: number[] = [];
  const realReadFileSync = fs.readFileSync;
  const mutableFs = fs as unknown as { readFileSync: unknown };
  try {
    await mkdir(dirname(lockPath(home)), { recursive: true, mode: 0o700 });
    const script = `process.on("SIGTERM", () => {}); const { createTrajectoryServer } = await import(${JSON.stringify(new URL("../src/server.js", import.meta.url).href)}); createTrajectoryServer(${String(stalePort)}, ${JSON.stringify(lockPath(home))}, { fingerprint: "older" }).listen(${String(stalePort)}, "127.0.0.1"); setInterval(() => {}, 1000);`;
    const stale = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: "ignore" });
    assert.ok(stale.pid);
    pids.push(stale.pid);
    await waitForServedPid(stalePort, stale.pid);
    const before = await readFile(lockPath(home), "utf8");
    if (identity === "unreadable") {
      const statPath = `/proc/${String(stale.pid)}/stat`;
      mutableFs.readFileSync = (...args: Parameters<typeof realReadFileSync>): unknown => {
        if (String(args[0]) === statPath) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
        return realReadFileSync(...args);
      };
      syncBuiltinESMExports();
    }

    const controller = createTrajectoryController(home);
    controllers.push(controller);
    if (identity === "confirmed") {
      assert.deepEqual(await controller.open(input(home, openPort)), { port: openPort });
      await controller.close();
      const lock = await readLock(home);
      pids.push(lock.pid);
      assert.equal(stale.signalCode ?? await exitCode(stale).then(() => stale.signalCode), "SIGKILL");
      assert.equal((await serverIdentity(openPort))?.pid, lock.pid);
      return;
    }
    await assert.rejects(controller.open(input(home, openPort)), /did not stop/);
    mutableFs.readFileSync = realReadFileSync;
    syncBuiltinESMExports();

    assert.equal(await readFile(lockPath(home), "utf8"), before);
    assert.equal((await serverIdentity(stalePort))?.pid, stale.pid);
    assert.equal(stale.signalCode, null, "an unconfirmed pid was killed");
    if (port === "other") assert.equal(await serverIdentity(openPort), undefined, "a second server was started beside the stale one");
    assert.deepEqual(await fsPromises.readdir(`${lockPath(home)}.startup`), []);
  } finally {
    mutableFs.readFileSync = realReadFileSync;
    syncBuiltinESMExports();
    const leaked = port === "other" ? await serverIdentity(openPort) : undefined;
    if (leaked?.pid !== undefined) pids.push(leaked.pid);
    await cleanup(home, controllers, pids);
  }
}

void test("a stale server ignoring SIGTERM is killed and replaced when its identity is confirmed", { skip: process.platform === "linux" ? false : "needs /proc" }, async () => { await stubbornStaleServer("same", "confirmed"); });
void test("an unconfirmed stale server that keeps serving keeps its lock on the same port", { skip: process.platform === "linux" ? false : "needs /proc" }, async () => { await stubbornStaleServer("same", "unreadable"); });
void test("an unconfirmed stale server that keeps serving gets no second server on another port", { skip: process.platform === "linux" ? false : "needs /proc" }, async () => { await stubbornStaleServer("other", "unreadable"); });

void test("an orphan Trajectory server missing from the lock is replaced instead of adopted", async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-orphan-"));
  const port = await availablePort();
  const controllers: TrajectoryController[] = [];
  const pids: number[] = [];
  try {
    // An older server keeps the port while its lock is gone, as after a lost or overwritten lock file.
    const orphanLock = join(home, "orphan.lock");
    const childScript = `const { createTrajectoryServer } = await import(${JSON.stringify(new URL("../src/server.js", import.meta.url).href)}); createTrajectoryServer(${String(port)}, ${JSON.stringify(orphanLock)}, { fingerprint: "older" }).listen(${String(port)}, "127.0.0.1"); setInterval(() => {}, 1000);`;
    const orphan = spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: "ignore" });
    assert.ok(orphan.pid);
    pids.push(orphan.pid);
    for (let attempt = 0; attempt < 100 && (await serverIdentity(port))?.fingerprint !== "older"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await serverIdentity(port))?.pid, orphan.pid);

    const controller = createTrajectoryController(home);
    controllers.push(controller);
    await controller.open(input(home, port));
    await controller.close();
    const lock = await readLock(home);
    pids.push(lock.pid);

    const served = await serverIdentity(port);
    assert.equal(served?.fingerprint, await currentFingerprint());
    assert.notEqual(served.pid, orphan.pid);
    assert.equal(lock.pid, served.pid);
  } finally {
    await cleanup(home, controllers, pids);
  }
});

void test("a server without an identity on the Trajectory port is reported instead of adopted", async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-legacy-"));
  const port = await availablePort();
  const { createServer: createHttpServer } = await import("node:http");
  const legacy = createHttpServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); });
  await new Promise<void>((resolve) => { legacy.listen(port, "127.0.0.1", resolve); });
  const controller = createTrajectoryController(home);
  try {
    await assert.rejects(controller.open(input(home, port)), /held by another Trajectory server/);
  } finally {
    try { await controller.close(); } catch { /* Test cleanup is best effort. */ }
    await new Promise<void>((resolve) => { legacy.close(() => { resolve(); }); });
    await rm(home, { recursive: true, force: true });
  }
});

void test("unhealthy live Trajectory lock waits without killing the startup process", async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-startup-"));
  const port = await availablePort();
  const controllers: TrajectoryController[] = [];
  const pids: number[] = [];
  try {
    const fingerprint = await currentFingerprint();
    const childScript = `const { createTrajectoryServer } = await import(${JSON.stringify(new URL("../src/server.js", import.meta.url).href)}); setTimeout(() => { const server = createTrajectoryServer(${String(port)}, ${JSON.stringify(lockPath(home))}, { fingerprint: ${JSON.stringify(fingerprint)} }); server.listen(${String(port)}, "127.0.0.1"); }, 100); setInterval(() => {}, 1000);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: "ignore" });
    assert.ok(child.pid);
    pids.push(child.pid);
    await mkdir(dirname(lockPath(home)), { recursive: true, mode: 0o700 });
    await writeFile(lockPath(home), `${JSON.stringify({ pid: child.pid, port, fingerprint: "different" })}\n`, "utf8");

    const controller = createTrajectoryController(home);
    controllers.push(controller);
    await controller.open(input(home, port));
    await controller.close();
    const lock = await readLock(home);

    assert.equal(lock.pid, child.pid);
    assert.equal(lock.port, port);
    assert.equal(lock.fingerprint, fingerprint);
  } finally {
    await cleanup(home, controllers, pids);
  }
});

void test("unhealthy live Trajectory lock is kept and reported after the startup budget expires", async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-timeout-"));
  const port = await availablePort();
  const controllers: TrajectoryController[] = [];
  const pids: number[] = [];
  try {
    const fingerprint = await currentFingerprint();
    const child = spawn(process.execPath, ["--input-type=module", "-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    assert.ok(child.pid);
    pids.push(child.pid);
    await mkdir(dirname(lockPath(home)), { recursive: true, mode: 0o700 });
    const written = `${JSON.stringify({ pid: child.pid, port, fingerprint })}\n`;
    await writeFile(lockPath(home), written, "utf8");

    const controller = createTrajectoryController(home);
    controllers.push(controller);
    await assert.rejects(controller.open(input(home, port)), /is alive but not answering/);

    // A live owner that never answered is unidentified, not dead: its lock stays and nothing replaces it.
    assert.equal(await readFile(lockPath(home), "utf8"), written);
    assert.equal(await serverIdentity(port), undefined);
    assert.equal(child.signalCode, null);
    assert.equal(child.exitCode, null);
  } finally {
    await cleanup(home, controllers, pids);
  }
});

// The kernel recreates a /proc/<pid> entry with a new ctime, e.g. after reclaiming it; a live process keeps its pid and start time.
function recreateProcEntries(): () => void {
  const realStat = fsPromises.stat;
  const realStatSync = fs.statSync;
  const procEntry = (path: unknown): boolean => /^\/proc\/\d+$/.test(String(path));
  const later = <T,>(stats: T): T => { if (stats !== undefined && stats !== null && typeof stats === "object" && "ctimeMs" in stats && typeof stats.ctimeMs === "number") stats.ctimeMs += 60_000; return stats; };
  const recreatedStat = async (...args: Parameters<typeof realStat>): Promise<unknown> => { const stats = await realStat(...args); return procEntry(args[0]) ? later(stats) : stats; };
  const recreatedStatSync = (...args: Parameters<typeof realStatSync>): unknown => { const stats = realStatSync(...args); return procEntry(args[0]) ? later(stats) : stats; };
  const mutableFs = fs as unknown as { statSync: unknown };
  fsPromises.stat = recreatedStat as typeof realStat;
  mutableFs.statSync = recreatedStatSync;
  syncBuiltinESMExports();
  return () => { fsPromises.stat = realStat; mutableFs.statSync = realStatSync; syncBuiltinESMExports(); };
}

// A ready server whose ownership cannot be verified keeps its lock: nothing is signalled, removed, or started beside it, and it is reused once verifiable again.
async function unverifiedOwnerKeepsLock(fault: "suspended" | "recreated-proc-entry" | "lock-read-error"): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), `trajectory-lock-${fault}-`));
  const firstPort = await availablePort();
  const secondPort = await availablePort();
  const controllers: TrajectoryController[] = [];
  const pids: number[] = [];
  let suspended: number | undefined;
  let restore: () => void = () => undefined;
  try {
    const first = createTrajectoryController(home);
    controllers.push(first);
    assert.deepEqual(await first.open(input(home, firstPort)), { port: firstPort });
    await first.close();
    const lock = await readLock(home);
    pids.push(lock.pid);
    const directory = dirname(lockPath(home));
    const snapshot = async () => ({ entries: (await fsPromises.readdir(directory, { recursive: true })).sort(), lock: await readFile(lockPath(home), "utf8"), stat: await fsPromises.stat(lockPath(home)) });
    const before = await snapshot();

    if (fault !== "lock-read-error") {
      // A real, ready server stops answering while staying alive, as a descheduled or debugged process does.
      process.kill(lock.pid, "SIGSTOP");
      suspended = lock.pid;
    }
    if (fault === "recreated-proc-entry") restore = recreateProcEntries();
    if (fault === "lock-read-error") {
      const realReadFile = fsPromises.readFile;
      let failures = 1;
      const failingReadFile = async (...args: Parameters<typeof realReadFile>): Promise<unknown> => {
        if (args[0] === lockPath(home) && failures-- > 0) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
        return realReadFile(...args);
      };
      fsPromises.readFile = failingReadFile as typeof realReadFile;
      syncBuiltinESMExports();
      restore = () => { fsPromises.readFile = realReadFile; syncBuiltinESMExports(); };
    }
    const second = createTrajectoryController(home);
    controllers.push(second);
    await assert.rejects(second.open(input(home, secondPort)), fault === "lock-read-error" ? { code: "EIO" } : /is alive but not answering/);
    restore();
    restore = () => undefined;

    // The second Pi released its startup holder and changed nothing else.
    const after = await snapshot();
    assert.deepEqual(after.entries, before.entries);
    assert.equal(after.lock, before.lock);
    assert.equal(after.stat.ino, before.stat.ino);
    assert.equal(after.stat.mtimeMs, before.stat.mtimeMs);
    assert.equal(await serverIdentity(secondPort), undefined, "a second server was started beside the unverified one");
    assert.equal(processExists(lock.pid), true);

    if (suspended !== undefined) process.kill(suspended, "SIGCONT");
    suspended = undefined;
    await waitForServedPid(firstPort, lock.pid);
    const third = createTrajectoryController(home);
    controllers.push(third);
    assert.deepEqual(await third.open(input(home, secondPort)), { port: firstPort });
    await third.close();

    assert.equal(await readFile(lockPath(home), "utf8"), before.lock);
    assert.equal(await serverIdentity(secondPort), undefined);
  } finally {
    restore();
    if (suspended !== undefined) process.kill(suspended, "SIGCONT");
    // A regression would leave a second server behind.
    const leaked = await serverIdentity(secondPort);
    if (leaked?.pid !== undefined) pids.push(leaked.pid);
    await cleanup(home, controllers, pids);
  }
}

void test("a suspended Trajectory server keeps its lock and is reused once it resumes", { skip: process.platform === "win32" ? "needs SIGSTOP" : false }, async () => { await unverifiedOwnerKeepsLock("suspended"); });
void test("a suspended Trajectory server keeps its lock when its /proc entry is recreated", { skip: process.platform === "linux" ? false : "needs /proc" }, async () => { await unverifiedOwnerKeepsLock("recreated-proc-entry"); });
void test("a lock read error keeps the lock and starts no second server", async () => { await unverifiedOwnerKeepsLock("lock-read-error"); });

void test("a stale Trajectory server is replaced without signalling the Pi named by its lock", async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-reservation-"));
  const port = await availablePort();
  const controllers: TrajectoryController[] = [];
  const pids: number[] = [];
  try {
    const olderScript = `const { createTrajectoryServer } = await import(${JSON.stringify(new URL("../src/server.js", import.meta.url).href)}); createTrajectoryServer(${String(port)}, ${JSON.stringify(join(home, "older.lock"))}, { fingerprint: "older" }).listen(${String(port)}, "127.0.0.1"); setInterval(() => {}, 1000);`;
    const older = spawn(process.execPath, ["--input-type=module", "-e", olderScript], { stdio: "ignore" });
    assert.ok(older.pid);
    pids.push(older.pid);
    for (let attempt = 0; attempt < 100 && (await serverIdentity(port))?.fingerprint !== "older"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal((await serverIdentity(port))?.pid, older.pid);
    // The lock still holds the reservation of the older Pi that launched that server.
    const olderPi = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    assert.ok(olderPi.pid);
    pids.push(olderPi.pid);
    await mkdir(dirname(lockPath(home)), { recursive: true, mode: 0o700 });
    await writeFile(lockPath(home), `${JSON.stringify({ pid: olderPi.pid, port, fingerprint: "older" })}\n`, "utf8");

    const controller = createTrajectoryController(home);
    controllers.push(controller);
    await controller.open(input(home, port));
    await controller.close();
    const lock = await readLock(home);
    pids.push(lock.pid);
    const served = await serverIdentity(port);

    assert.equal(olderPi.signalCode, null);
    assert.equal(olderPi.exitCode, null);
    assert.equal(served?.fingerprint, await currentFingerprint());
    assert.notEqual(served.pid, older.pid);
    assert.equal(lock.pid, served.pid);
  } finally {
    await cleanup(home, controllers, pids);
  }
});

void test("concurrent Pi processes share one Trajectory server whose lock matches /health", async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-concurrent-"));
  const port = await availablePort();
  const pids: number[] = [];
  try {
    const trajectoryModule = new URL("../src/index.js", import.meta.url).href;
    const childScript = `const { createTrajectoryController } = await import(${JSON.stringify(trajectoryModule)}); const controller = createTrajectoryController(${JSON.stringify(home)}); await controller.open({ cwd: ${JSON.stringify(home)}, sessionId: "trajectory-lock-concurrent-" + String(process.pid), port: ${String(port)}, loadRuns: async () => [], loadSubagents: async () => [], loadMetadata: async () => ({ runs: [], subagents: [] }), handleAction: async () => {} }); const health = await (await fetch("http://127.0.0.1:${String(port)}/health")).json(); await controller.close(); process.stdout.write(JSON.stringify(health));`;
    const children = Array.from({ length: 4 }, () => spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: ["ignore", "pipe", "inherit"] }));
    const results = await Promise.all(children.map(async (child) => {
      assert.ok(child.pid);
      pids.push(child.pid);
      let stdout = "";
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => { stdout += chunk; });
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", (exitCode) => { resolve(exitCode); }); });
      return { code, health: JSON.parse(stdout) as { pid: number; startedAt: number } };
    }));
    const served = await serverIdentity(port);
    assert.ok(served?.pid);
    pids.push(served.pid);
    const lock = await readLock(home);

    for (const result of results) {
      assert.equal(result.code, 0);
      assert.equal(result.health.pid, served.pid);
    }
    assert.equal(lock.pid, served.pid);
    assert.equal(lock.fingerprint, served.fingerprint);
  } finally {
    await cleanup(home, [], pids);
  }
});

function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (isNodeError(error, "ESRCH")) return false; throw error; }
}
async function waitForServedPid(port: number, pid: number | undefined): Promise<void> {
  for (let attempt = 0; attempt < 200 && (await serverIdentity(port))?.pid !== pid; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal((await serverIdentity(port))?.pid, pid);
}

async function foreignServiceIsNotSignalled(locked: boolean): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-foreign-"));
  const port = await availablePort();
  const pids: number[] = [];
  const controller = createTrajectoryController(home);
  try {
    // Any HTTP service can answer /health with a pid; without a Trajectory identity it is never signalled.
    const script = `require("node:http").createServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true, pid: process.pid })); }).listen(${String(port)}, "127.0.0.1");`;
    const foreign = spawn(process.execPath, ["-e", script], { stdio: "ignore" });
    assert.ok(foreign.pid);
    pids.push(foreign.pid);
    await waitForServedPid(port, foreign.pid);
    if (locked) {
      await mkdir(dirname(lockPath(home)), { recursive: true, mode: 0o700 });
      await writeFile(lockPath(home), `${JSON.stringify({ pid: foreign.pid, port, fingerprint: "older" })}\n`, "utf8");
    }

    await assert.rejects(controller.open(input(home, port)), /held by another Trajectory server/);

    assert.equal(foreign.signalCode, null);
    assert.equal(foreign.exitCode, null);
    assert.equal((await serverIdentity(port))?.pid, foreign.pid);
  } finally {
    await cleanup(home, [controller], pids);
  }
}

void test("a non-Trajectory service named by the lock is reported instead of signalled", async () => { await foreignServiceIsNotSignalled(true); });
void test("a non-Trajectory service on the Trajectory port is reported instead of signalled", async () => { await foreignServiceIsNotSignalled(false); });

void test("a Pi that read a stale lock cannot remove the lock another Pi published meanwhile", async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-interleaved-"));
  const port = await availablePort();
  const controllers: TrajectoryController[] = [];
  const pids: number[] = [];
  const realReadFile = fsPromises.readFile;
  let releaseRead: () => void = () => undefined;
  const readReleased = new Promise<void>((resolve) => { releaseRead = resolve; });
  try {
    const dead = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    assert.ok(dead.pid);
    await new Promise((resolve) => dead.once("exit", resolve));
    const fingerprint = await currentFingerprint();
    const stale = `${JSON.stringify({ pid: dead.pid, port, fingerprint })}\n`;
    await mkdir(dirname(lockPath(home)), { recursive: true, mode: 0o700 });
    await writeFile(lockPath(home), stale, "utf8");
    // Only this process is held: its second read of the stale lock returns once the other Pi has finished starting a server.
    let staleReads = 0;
    const heldReadFile = async (...args: Parameters<typeof realReadFile>): Promise<unknown> => {
      const content = await realReadFile(...args);
      if (args[0] === lockPath(home) && String(content) === stale && ++staleReads === 2) await readReleased;
      return content;
    };
    fsPromises.readFile = heldReadFile as typeof realReadFile;
    syncBuiltinESMExports();
    const controller = createTrajectoryController(home);
    controllers.push(controller);
    const opened = controller.open(input(home, port));
    const trajectoryModule = new URL("../src/index.js", import.meta.url).href;
    const otherScript = `const { createTrajectoryController } = await import(${JSON.stringify(trajectoryModule)}); const controller = createTrajectoryController(${JSON.stringify(home)}); await controller.open({ cwd: ${JSON.stringify(home)}, sessionId: "trajectory-lock-interleaved-other", port: ${String(port)}, loadRuns: async () => [], loadSubagents: async () => [], loadMetadata: async () => ({ runs: [], subagents: [] }), handleAction: async () => {} }); await controller.close();`;
    const other = spawn(process.execPath, ["--input-type=module", "-e", otherScript], { stdio: "ignore" });
    assert.ok(other.pid);
    pids.push(other.pid);
    assert.equal(await new Promise((resolve, reject) => { other.once("error", reject); other.once("close", resolve); }), 0);
    releaseRead();

    assert.deepEqual(await opened, { port });
    await controller.close();
    const served = await serverIdentity(port);
    assert.ok(served?.pid);
    pids.push(served.pid);
    const lock = await readLock(home);
    pids.push(lock.pid);
    assert.equal(lock.pid, served.pid);
    assert.equal(lock.fingerprint, served.fingerprint);
  } finally {
    releaseRead();
    fsPromises.readFile = realReadFile;
    syncBuiltinESMExports();
    await cleanup(home, controllers, pids);
  }
});

void test("a server that misses its startup is stopped before the startup is released", { skip: process.platform === "win32" ? "needs SIGSTOP" : false }, async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-missed-startup-"));
  const port = await availablePort();
  const pids: number[] = [];
  try {
    // The preload suspends only the spawned server, before it can listen, as a stalled or descheduled startup would.
    const pidFile = join(home, "server.pid");
    const preload = join(home, "suspend-server.mjs");
    await writeFile(preload, `import { writeFileSync } from "node:fs"; if (process.argv[1]?.endsWith("server.js")) { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.kill(process.pid, "SIGSTOP"); }\n`, "utf8");
    const trajectoryModule = new URL("../src/index.js", import.meta.url).href;
    const childScript = `const { createTrajectoryController } = await import(${JSON.stringify(trajectoryModule)}); const controller = createTrajectoryController(${JSON.stringify(home)}); try { await controller.open({ cwd: ${JSON.stringify(home)}, sessionId: "trajectory-lock-missed-startup", port: ${String(port)}, loadRuns: async () => [], loadSubagents: async () => [], loadMetadata: async () => ({ runs: [], subagents: [] }), handleAction: async () => {} }); process.stdout.write("opened"); } catch (error) { process.stdout.write("rejected: " + String(error)); } finally { await controller.close(); }`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
    assert.ok(child.pid);
    pids.push(child.pid);
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout += chunk; });
    assert.equal(await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }), 0);
    const serverPid = Number(await readFile(pidFile, "utf8"));
    pids.push(serverPid);

    assert.match(stdout, /^rejected: /);
    assert.equal(processExists(serverPid), false, "the suspended server outlived the failed startup");
    await assert.rejects(readFile(lockPath(home)), { code: "ENOENT" });
  } finally {
    await cleanup(home, [], pids);
  }
});

async function exitCode(child: ReturnType<typeof spawn>): Promise<number | null> {
  if (child.exitCode !== null || child.signalCode !== null) return child.exitCode;
  return new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", resolve); });
}
// Waits for a step another process reports through a marker file; the bound only turns a hang into a failure.
async function waitForFile(path: string, done: () => boolean = () => false): Promise<boolean> {
  for (let attempt = 0; attempt < 1500; attempt += 1) {
    if (await access(path).then(() => true, () => false)) return true;
    if (done()) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${path} never appeared`);
}

void test("startup mutex recovery never lets two contenders hold it", async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-mutex-recovery-"));
  const pids: number[] = [];
  try {
    const lock = lockPath(home);
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
    const mutexModule = JSON.stringify(new URL("../src/startup-mutex.js", import.meta.url).href);
    // A holder that died without releasing the mutex.
    const dead = spawn(process.execPath, ["--input-type=module", "-e", `const { tryAcquireStartupMutex } = await import(${mutexModule}); if (!await tryAcquireStartupMutex(${JSON.stringify(lock)})) process.exit(1);`], { stdio: "ignore" });
    assert.equal(await exitCode(dead), 0);
    // The contender's first two reads of mutex state each wait for this test, which acquires in between.
    const preload = join(home, "pause-reads.mjs");
    await writeFile(preload, `import fs, { existsSync, writeFileSync } from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const realReadFile = fs.promises.readFile; let reads = 0; fs.promises.readFile = async (path, ...args) => { const content = await realReadFile(path, ...args); if (String(path).includes(".startup") && reads < 2) { reads += 1; writeFileSync(${JSON.stringify(join(home, "held"))} + String(reads), ""); while (!existsSync(${JSON.stringify(join(home, "go"))} + String(reads))) await new Promise((resolve) => setTimeout(resolve, 10)); } return content; }; syncBuiltinESMExports();\n`, "utf8");
    const contender = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "--input-type=module", "-e", `import { existsSync } from "node:fs"; const { tryAcquireStartupMutex } = await import(${mutexModule}); process.stdout.write((await tryAcquireStartupMutex(${JSON.stringify(lock)})) ?? "none"); while (!existsSync(${JSON.stringify(join(home, "finish"))})) await new Promise((resolve) => setTimeout(resolve, 10));`], { stdio: ["ignore", "pipe", "inherit"] });
    assert.ok(contender.pid);
    pids.push(contender.pid);
    let contenderToken = "";
    contender.stdout.setEncoding("utf8");
    contender.stdout.on("data", (chunk: string) => { contenderToken += chunk; });
    const held: string[] = [];

    await waitForFile(join(home, "held1"));
    const second = await tryAcquireStartupMutex(lock);
    if (second !== undefined) held.push(second);
    await writeFile(join(home, "go1"), "");
    await waitForFile(join(home, "held2"), () => contenderToken !== "");
    const third = await tryAcquireStartupMutex(lock);
    if (third !== undefined) held.push(third);
    await writeFile(join(home, "go2"), "");
    await waitForFile(join(home, "never"), () => contenderToken !== "").catch(() => false);
    if (contenderToken !== "none") held.push(contenderToken);

    assert.equal(held.length, 1, `holders: ${held.join(", ")}`);
    await writeFile(join(home, "finish"), "");
    assert.equal(await exitCode(contender), 0);
  } finally {
    await cleanup(home, [], pids);
  }
});

void test("startup mutex recovery rereads a holder whose Pi recorded its server and died after being read", { skip: process.platform === "win32" ? "needs SIGSTOP" : false }, async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-mutex-record-"));
  const pids: number[] = [];
  try {
    const lock = lockPath(home);
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
    const port = await availablePort();
    const marker = (name: string) => JSON.stringify(join(home, name));
    const mutexModule = JSON.stringify(new URL("../src/startup-mutex.js", import.meta.url).href);
    // The server stops in the middle of publishing its lock.
    const suspendPublish = join(home, "suspend-publish.mjs");
    await writeFile(suspendPublish, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const realRename = fs.renameSync; fs.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(lock)}) { fs.writeFileSync(${marker("server.pid")}, String(process.pid)); process.kill(process.pid, "SIGSTOP"); } return realRename(from, to); }; syncBuiltinESMExports();\n`, "utf8");
    // This process plays the starting Pi: it holds the mutex, then spawns and records its server when told to.
    const parentScript = `import { existsSync, writeFileSync } from "node:fs"; import { spawn } from "node:child_process"; const { tryAcquireStartupMutex, recordStartupServer } = await import(${mutexModule}); const token = await tryAcquireStartupMutex(${JSON.stringify(lock)}); if (!token) process.exit(1); writeFileSync(${marker("acquired")}, ""); while (!existsSync(${marker("record")})) await new Promise((resolve) => setTimeout(resolve, 10)); const child = spawn(process.execPath, ["--import", ${JSON.stringify(pathToFileURL(suspendPublish).href)}, ${JSON.stringify(fileURLToPath(new URL("../src/server.js", import.meta.url)))}, "--port", "${String(port)}", "--lock", ${JSON.stringify(lock)}, "--fingerprint", "orphan", "--startup", token], { detached: true, stdio: "ignore" }); recordStartupServer(${JSON.stringify(lock)}, token, child.pid); child.unref(); setInterval(() => {}, 1000);`;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", parentScript], { stdio: "ignore" });
    assert.ok(parent.pid);
    pids.push(parent.pid);
    await waitForFile(join(home, "acquired"));
    // The contender's first read of a holder returns the holder from before the server was recorded, after its Pi is gone.
    const pauseRead = join(home, "pause-read.mjs");
    await writeFile(pauseRead, `import fs, { existsSync, writeFileSync } from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const realReadFile = fs.promises.readFile; let reads = 0; fs.promises.readFile = async (path, ...args) => { const content = await realReadFile(path, ...args); if (String(path).includes(".startup") && reads++ === 0) { writeFileSync(${marker("held")}, ""); while (!existsSync(${marker("go")})) await new Promise((resolve) => setTimeout(resolve, 10)); } return content; }; syncBuiltinESMExports();\n`, "utf8");
    const contender = spawn(process.execPath, ["--import", pathToFileURL(pauseRead).href, "--input-type=module", "-e", `const { tryAcquireStartupMutex } = await import(${mutexModule}); process.stdout.write((await tryAcquireStartupMutex(${JSON.stringify(lock)})) === undefined ? "none" : "acquired");`], { stdio: ["ignore", "pipe", "inherit"] });
    assert.ok(contender.pid);
    pids.push(contender.pid);
    let outcome = "";
    contender.stdout.setEncoding("utf8");
    contender.stdout.on("data", (chunk: string) => { outcome += chunk; });
    await waitForFile(join(home, "held"));
    await writeFile(join(home, "record"), "");
    await waitForFile(join(home, "server.pid"));
    const orphan = Number(await readFile(join(home, "server.pid"), "utf8"));
    pids.push(orphan);
    parent.kill("SIGKILL");
    await exitCode(parent);
    await writeFile(join(home, "go"), "");
    assert.equal(await exitCode(contender), 0);

    assert.equal(outcome, "none", "the mutex was granted while the recorded server could still publish");
    let token: string | undefined;
    for (let attempt = 0; attempt < 200 && token === undefined; attempt += 1) {
      token = await tryAcquireStartupMutex(lock);
      if (token === undefined) await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.ok(token);
    assert.equal(processExists(orphan), false, "the recorded server survived the mutex recovery");
  } finally {
    await cleanup(home, [], pids);
  }
});

void test("a failed startup mutex attempt leaves no holder behind", async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-mutex-failure-"));
  const realReaddir = fsPromises.readdir;
  try {
    const lock = lockPath(home);
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
    let failures = 1;
    const failingReaddir = async (...args: Parameters<typeof realReaddir>): Promise<unknown> => {
      if (String(args[0]).includes(".startup") && failures-- > 0) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
      return realReaddir(...args);
    };
    fsPromises.readdir = failingReaddir as typeof realReaddir;
    syncBuiltinESMExports();
    await assert.rejects(tryAcquireStartupMutex(lock), { code: "EIO" });
    fsPromises.readdir = realReaddir;
    syncBuiltinESMExports();

    assert.ok(await tryAcquireStartupMutex(lock), "a transient I/O error kept the mutex held");
  } finally {
    fsPromises.readdir = realReaddir;
    syncBuiltinESMExports();
    await rm(home, { recursive: true, force: true });
  }
});

// A dead Pi's holder records a server pid that now belongs to an unrelated live process, and nothing confirms otherwise.
async function unconfirmedServerIsNotSignalled(identity: "absent" | "unreadable"): Promise<void> {
  const home = await mkdtemp(join(tmpdir(), `trajectory-lock-unconfirmed-${identity}-`));
  const pids: number[] = [];
  const realReadFileSync = fs.readFileSync;
  const mutableFs = fs as unknown as { readFileSync: unknown };
  try {
    const lock = lockPath(home);
    await mkdir(`${lock}.startup`, { recursive: true, mode: 0o700 });
    const deadPi = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    assert.ok(deadPi.pid);
    await exitCode(deadPi);
    const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], { stdio: "ignore" });
    assert.ok(unrelated.pid);
    pids.push(unrelated.pid);
    const server = identity === "absent" ? { pid: unrelated.pid } : { pid: unrelated.pid, start: "previous-boot:1" };
    const holder = join(`${lock}.startup`, "dead-pi.json");
    const written = `${JSON.stringify({ pid: deadPi.pid, token: "dead-pi", server })}\n`;
    await writeFile(holder, written, "utf8");
    if (identity === "unreadable") {
      const statPath = `/proc/${String(unrelated.pid)}/stat`;
      mutableFs.readFileSync = (...args: Parameters<typeof realReadFileSync>): unknown => {
        if (String(args[0]) === statPath) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
        return realReadFileSync(...args);
      };
      syncBuiltinESMExports();
    }

    assert.equal(await tryAcquireStartupMutex(lock), undefined, "the mutex was granted while the recorded server could still publish");
    mutableFs.readFileSync = realReadFileSync;
    syncBuiltinESMExports();

    // A SIGKILL is only observable once the child is reaped, so the check waits a bounded time for an exit.
    const exited = await Promise.race([exitCode(unrelated).then(() => true), new Promise<boolean>((resolve) => setTimeout(() => { resolve(false); }, 1000))]);
    assert.equal(exited, false, `an unconfirmed pid was signalled (${String(unrelated.signalCode)})`);
    assert.equal(await readFile(holder, "utf8"), written);
    assert.deepEqual(await fsPromises.readdir(`${lock}.startup`), ["dead-pi.json"]);
  } finally {
    mutableFs.readFileSync = realReadFileSync;
    syncBuiltinESMExports();
    await cleanup(home, [], pids);
  }
}

void test("a recorded server without an identity is never signalled by mutex recovery", async () => { await unconfirmedServerIsNotSignalled("absent"); });
void test("a recorded server whose identity cannot be read is never signalled by mutex recovery", { skip: process.platform === "linux" ? false : "needs /proc" }, async () => { await unconfirmedServerIsNotSignalled("unreadable"); });

void test("a lock read error during mutex recovery keeps a published server and its holder", { skip: process.platform === "win32" ? "needs SIGKILL" : false }, async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-recovery-eio-"));
  const firstPort = await availablePort();
  const secondPort = await availablePort();
  const controllers: TrajectoryController[] = [];
  const pids: number[] = [];
  const realReadFile = fsPromises.readFile;
  try {
    // The first Pi publishes its server, then dies before releasing the startup mutex.
    const releasing = join(home, "releasing");
    const preload = join(home, "hold-release.mjs");
    await writeFile(preload, `import fs, { writeFileSync } from "node:fs"; import { syncBuiltinESMExports } from "node:module"; const realRm = fs.promises.rm; fs.promises.rm = async (path, ...args) => { if (String(path).includes(".startup")) { writeFileSync(${JSON.stringify(releasing)}, ""); await new Promise(() => {}); } return realRm(path, ...args); }; syncBuiltinESMExports();\n`, "utf8");
    const trajectoryModule = new URL("../src/index.js", import.meta.url).href;
    const piScript = `const { createTrajectoryController } = await import(${JSON.stringify(trajectoryModule)}); await createTrajectoryController(${JSON.stringify(home)}).open({ cwd: ${JSON.stringify(home)}, sessionId: "trajectory-lock-recovery-eio", port: ${String(firstPort)}, loadRuns: async () => [], loadSubagents: async () => [], loadMetadata: async () => ({ runs: [], subagents: [] }), handleAction: async () => {} });`;
    const pi = spawn(process.execPath, ["--import", pathToFileURL(preload).href, "--input-type=module", "-e", piScript], { stdio: "ignore" });
    assert.ok(pi.pid);
    pids.push(pi.pid);
    await waitForFile(releasing);
    const lock = await readLock(home);
    pids.push(lock.pid);
    assert.equal((await serverIdentity(firstPort))?.pid, lock.pid);
    pi.kill("SIGKILL");
    await exitCode(pi);
    const directory = dirname(lockPath(home));
    const snapshot = async () => ({ entries: (await fsPromises.readdir(directory, { recursive: true })).sort(), lock: await realReadFile(lockPath(home), "utf8") });
    const before = await snapshot();

    let failures = 1;
    const failingReadFile = async (...args: Parameters<typeof realReadFile>): Promise<unknown> => {
      if (args[0] === lockPath(home) && failures-- > 0) throw Object.assign(new Error("injected EIO"), { code: "EIO" });
      return realReadFile(...args);
    };
    fsPromises.readFile = failingReadFile as typeof realReadFile;
    syncBuiltinESMExports();
    const second = createTrajectoryController(home);
    controllers.push(second);
    await assert.rejects(second.open(input(home, secondPort)), { code: "EIO" });
    fsPromises.readFile = realReadFile;
    syncBuiltinESMExports();

    assert.deepEqual(await snapshot(), before, "the failed attempt changed the lock or the dead Pi's holder");
    assert.equal((await serverIdentity(firstPort))?.pid, lock.pid, "the published server was stopped");
    assert.equal(await serverIdentity(secondPort), undefined, "a second server was started");

    const third = createTrajectoryController(home);
    controllers.push(third);
    assert.deepEqual(await third.open(input(home, secondPort)), { port: firstPort });
    await third.close();
    assert.equal(await readFile(lockPath(home), "utf8"), before.lock);
  } finally {
    fsPromises.readFile = realReadFile;
    syncBuiltinESMExports();
    const leaked = await serverIdentity(secondPort);
    if (leaked?.pid !== undefined) pids.push(leaked.pid);
    await cleanup(home, controllers, pids);
  }
});

void test("a startup mutex holder stays held when its /proc entry is recreated", { skip: process.platform === "linux" ? false : "needs /proc" }, async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-mutex-proc-"));
  let restore: () => void = () => undefined;
  try {
    const lock = lockPath(home);
    await mkdir(dirname(lock), { recursive: true, mode: 0o700 });
    const first = await tryAcquireStartupMutex(lock);
    assert.ok(first);
    restore = recreateProcEntries();

    const second = await tryAcquireStartupMutex(lock);
    assert.equal(second, undefined, "a second holder was granted while the first still held the mutex");
  } finally {
    restore();
    await rm(home, { recursive: true, force: true });
  }
});

void test("a server whose Pi died mid-startup cannot publish over the next Pi's lock", { skip: process.platform === "win32" ? "needs SIGSTOP" : false }, async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-orphan-publish-"));
  const firstPort = await availablePort();
  const secondPort = await availablePort();
  const controllers: TrajectoryController[] = [];
  const pids: number[] = [];
  try {
    // The preload suspends the spawned server in the middle of publishing its lock.
    const pidFile = join(home, "server.pid");
    const preload = join(home, "suspend-publish.mjs");
    await writeFile(preload, `import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; if (process.argv[1]?.endsWith("server.js")) { const realRename = fs.renameSync; fs.renameSync = (from, to) => { if (String(to) === ${JSON.stringify(lockPath(home))}) { fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.kill(process.pid, "SIGSTOP"); } return realRename(from, to); }; syncBuiltinESMExports(); }\n`, "utf8");
    const trajectoryModule = new URL("../src/index.js", import.meta.url).href;
    const parentScript = `const { createTrajectoryController } = await import(${JSON.stringify(trajectoryModule)}); await createTrajectoryController(${JSON.stringify(home)}).open({ cwd: ${JSON.stringify(home)}, sessionId: "trajectory-lock-orphan-publish", port: ${String(firstPort)}, loadRuns: async () => [], loadSubagents: async () => [], loadMetadata: async () => ({ runs: [], subagents: [] }), handleAction: async () => {} });`;
    const parent = spawn(process.execPath, ["--input-type=module", "-e", parentScript], { stdio: "ignore", env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` } });
    assert.ok(parent.pid);
    pids.push(parent.pid);
    await waitForFile(pidFile);
    const orphan = Number(await readFile(pidFile, "utf8"));
    pids.push(orphan);
    parent.kill("SIGKILL");
    await exitCode(parent);

    const controller = createTrajectoryController(home);
    controllers.push(controller);
    assert.deepEqual(await controller.open(input(home, secondPort)), { port: secondPort });
    await controller.close();
    const served = await serverIdentity(secondPort);
    assert.ok(served?.pid);
    pids.push(served.pid);
    try { process.kill(orphan, "SIGCONT"); } catch (error) { if (!isNodeError(error, "ESRCH")) throw error; }
    // A resumed orphan finishes its rename at once; either it is gone or the lock shows it.
    for (let attempt = 0; attempt < 200 && processExists(orphan) && (await readLock(home)).pid !== orphan; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));

    assert.equal((await readLock(home)).pid, served.pid);
    assert.equal(processExists(orphan), false, "the orphaned server survived the next Pi's startup");
  } finally {
    await cleanup(home, controllers, pids);
  }
});

void test("a current Trajectory server that lost its lock is adopted with its lock restored", async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-lost-"));
  const port = await availablePort();
  const controllers: TrajectoryController[] = [];
  const pids: number[] = [];
  try {
    const first = createTrajectoryController(home);
    controllers.push(first);
    await first.open(input(home, port));
    await first.close();
    const firstLock = await readLock(home);
    pids.push(firstLock.pid);
    await rm(lockPath(home));

    const second = createTrajectoryController(home);
    controllers.push(second);
    await second.open(input(home, port));
    await second.close();
    const lock = await readLock(home);
    pids.push(lock.pid);
    const served = await serverIdentity(port);

    assert.equal(served?.pid, firstLock.pid);
    assert.deepEqual(lock, firstLock);
  } finally {
    await cleanup(home, controllers, pids);
  }
});

void test("unhealthy Trajectory lock owned by the attacher is replaced without killing it", async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-lock-self-"));
  const port = await availablePort();
  const pids: number[] = [];
  try {
    const fingerprint = await currentFingerprint();
    const trajectoryModule = new URL("../src/index.js", import.meta.url).href;
    const childScript = `import { mkdir, writeFile } from "node:fs/promises"; import { dirname } from "node:path"; const { createTrajectoryController } = await import(${JSON.stringify(trajectoryModule)}); const home = ${JSON.stringify(home)}; const lockPath = ${JSON.stringify(lockPath(home))}; const port = ${String(port)}; await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 }); await writeFile(lockPath, JSON.stringify({ pid: process.pid, port, fingerprint: ${JSON.stringify(fingerprint)} }) + String.fromCharCode(10)); const controller = createTrajectoryController(home); await controller.open({ cwd: home, sessionId: "trajectory-lock-self-test", port, loadRuns: async () => [], loadSubagents: async () => [], loadMetadata: async () => ({ runs: [], subagents: [] }), handleAction: async () => {} }); await controller.close();`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: "ignore" });
    assert.ok(child.pid);
    pids.push(child.pid);
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => { resolve({ code, signal }); });
    });
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
    const lock = await readLock(home);
    pids.push(lock.pid);
    assert.notEqual(lock.pid, child.pid);
    assert.equal(lock.fingerprint, fingerprint);
    assert.equal((await fetch(`http://127.0.0.1:${String(port)}/health`)).ok, true);
  } finally {
    await cleanup(home, [], pids);
  }
});

void test("Trajectory resolves the runnable server in a source checkout", async () => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-server-path-"));
  try {
    // A source checkout has TypeScript under trajectory/src, while spawned bare node needs dist.
    await mkdir(join(home, "trajectory", "src"), { recursive: true });
    await mkdir(join(home, "dist", "trajectory", "src"), { recursive: true });
    await writeFile(join(home, "trajectory", "src", "server.ts"), "export {};\n", "utf8");
    await writeFile(join(home, "dist", "trajectory", "src", "server.js"), "export {};\n", "utf8");
    assert.equal(trajectoryServerPath(join(home, "trajectory", "src")), join(home, "dist", "trajectory", "src", "server.js"));
    await mkdir(join(home, "installed"), { recursive: true });
    await writeFile(join(home, "installed", "server.js"), "export {};\n", "utf8");
    assert.equal(trajectoryServerPath(join(home, "installed")), join(home, "installed", "server.js"));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
