import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import { createTrajectoryController, trajectoryServerPath, type TrajectoryController } from "../src/index.js";
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
  return { cwd: home, sessionId: "trajectory-lock-test", port, themes: false, loadRuns: async () => [], loadSubagents: async () => [], loadMetadata: async () => ({ runs: [], subagents: [] }), handleAction: async () => {} };
}
async function currentFingerprint(): Promise<string> {
  const serverPath = fileURLToPath(new URL("../src/server.js", import.meta.url));
  const [serverBytes, htmlBytes, mermaidBytes] = await Promise.all([
    readFile(serverPath),
    readFile(join(dirname(serverPath), "assets/index.html")),
    readFile(join(dirname(serverPath), "assets/mermaid.min.js")),
  ]);
  return [serverBytes, htmlBytes, mermaidBytes].map((bytes) => createHash("sha256").update(bytes).digest("hex")).join(":");
}
function kill(pid: number): void {
  try { process.kill(pid, "SIGKILL"); }
  catch (error) { if (!isNodeError(error, "ESRCH")) throw error; }
}
async function cleanup(home: string, controllers: readonly TrajectoryController[], pids: readonly number[]): Promise<void> {
  for (const controller of controllers) {
    try { await controller.close(); } catch { /* Test cleanup is best effort. */ }
  }
  for (const pid of pids) kill(pid);
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
    const fingerprintParts = firstLock.fingerprint?.split(":") ?? [];
    assert.equal(fingerprintParts.length, 3);
    assert.equal(fingerprintParts[2], "9bd6ad2cd11ed29822ccf5e2f6954b3b1e858b8e93f7148c6ae0bddc4df3aed4");

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

void test("unhealthy live Trajectory lock is replaced after the startup budget expires", async () => {
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
    await writeFile(lockPath(home), `${JSON.stringify({ pid: child.pid, port, fingerprint })}\n`, "utf8");

    const controller = createTrajectoryController(home);
    controllers.push(controller);
    await controller.open(input(home, port));
    await controller.close();
    const lock = await readLock(home);
    pids.push(lock.pid);

    assert.notEqual(lock.pid, child.pid);
    assert.equal(lock.port, port);
    assert.equal(lock.fingerprint, fingerprint);
    assert.equal((await fetch(`http://127.0.0.1:${String(port)}/health`)).ok, true);
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
    const childScript = `import { mkdir, writeFile } from "node:fs/promises"; import { dirname } from "node:path"; const { createTrajectoryController } = await import(${JSON.stringify(trajectoryModule)}); const home = ${JSON.stringify(home)}; const lockPath = ${JSON.stringify(lockPath(home))}; const port = ${String(port)}; await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 }); await writeFile(lockPath, JSON.stringify({ pid: process.pid, port, fingerprint: ${JSON.stringify(fingerprint)} }) + String.fromCharCode(10)); const controller = createTrajectoryController(home); await controller.open({ cwd: home, sessionId: "trajectory-lock-self-test", port, themes: false, loadRuns: async () => [], loadSubagents: async () => [], loadMetadata: async () => ({ runs: [], subagents: [] }), handleAction: async () => {} }); await controller.close();`;
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
