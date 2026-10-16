import assert from "node:assert/strict";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTrajectoryController } from "../src/index.js";
import { isNodeError } from "../../src/utils.js";

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { resolve(); }); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(); }));
  return port;
}
function input(home: string, port: number) {
  return { cwd: home, sessionId: "trajectory-reconnect-test", port, loadRuns: async () => [], loadSubagents: async () => [], loadMetadata: async () => ({ runs: [], subagents: [] }), handleAction: async () => {} };
}
async function serverPid(home: string): Promise<number> {
  return (JSON.parse(await readFile(join(home, "pi-extensible-workflows", "trajectory.lock"), "utf8")) as { pid: number }).pid;
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return !isNodeError(error, "ESRCH"); }
}
async function until(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!await check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
/** Kills the Trajectory server and holds its port with a service that is not one, so every reconnect fails. */
async function breakServer(home: string, port: number): Promise<Server> {
  const pid = await serverPid(home);
  process.kill(pid, "SIGKILL");
  await until(() => !alive(pid), "the server to exit");
  const holder = createHttpServer((_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"ok":true}'); });
  await until(() => new Promise<boolean>((resolve) => {
    holder.once("error", () => { resolve(false); });
    holder.listen(port, "127.0.0.1", () => { resolve(true); });
  }), "the port to be free");
  return holder;
}
const closeServer = (server: Server): Promise<void> => new Promise((resolve) => { server.close(() => { resolve(); }); });

void test("a reconnect outage is reported once through the session's reporter, never written to the console, and again after a recovery", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-reconnect-"));
  const port = await availablePort();
  const controller = createTrajectoryController(home);
  const reports: string[] = [];
  const consoleError = t.mock.method(console, "error", () => {});
  let holder: Server | undefined;
  try {
    await controller.open(input(home, port), (message) => { reports.push(message); });
    const first = await serverPid(home);
    holder = await breakServer(home, port);
    await until(() => reports.length > 0, "the first report");
    // Backoff 100, 200, 400, 800 ms: several more attempts fail while the port is held.
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(reports.length, 1, `one report for the outage: ${JSON.stringify(reports)}`);
    assert.match(reports[0] ?? "", /^Trajectory disconnected/);
    await closeServer(holder);
    holder = undefined;
    await until(async () => { const pid = await serverPid(home).catch(() => first); return pid !== first && alive(pid); }, "a new server after the port was freed");
    // The new server is up; give the controller a moment to attach to it before the next outage.
    await new Promise((resolve) => setTimeout(resolve, 500));
    holder = await breakServer(home, port);
    await until(() => reports.length > 1, "the report for the second outage");
    assert.equal(reports.length, 2);
    assert.equal(consoleError.mock.calls.filter((call) => String(call.arguments[0]).includes("Trajectory")).length, 0, "nothing reaches the terminal");
  } finally {
    try { await controller.close(); } catch { /* Test cleanup is best effort. */ }
    if (holder) await closeServer(holder);
    const pid = await serverPid(home).catch(() => undefined);
    if (pid !== undefined && pid !== process.pid && alive(pid)) process.kill(pid, "SIGKILL");
    await rm(home, { recursive: true, force: true });
  }
});

void test("without a reporter an outage still writes a single console line", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "trajectory-reconnect-console-"));
  const port = await availablePort();
  const controller = createTrajectoryController(home);
  const consoleError = t.mock.method(console, "error", () => {});
  let holder: Server | undefined;
  try {
    await controller.open(input(home, port));
    holder = await breakServer(home, port);
    const lines = (): number => consoleError.mock.calls.filter((call) => String(call.arguments[0]).startsWith("Trajectory disconnected")).length;
    await until(() => lines() > 0, "the console line");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    assert.equal(lines(), 1);
  } finally {
    try { await controller.close(); } catch { /* Test cleanup is best effort. */ }
    if (holder) await closeServer(holder);
    await rm(home, { recursive: true, force: true });
  }
});
