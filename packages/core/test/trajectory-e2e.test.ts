import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TestHarness } from "./harness.js";

const enabled = process.env.HERDR_ENV === "1";
const coreRoot = resolve(fileURLToPath(new URL("..", import.meta.url)), "..");
const repositoryRoot = resolve(coreRoot, "..", "..");

function installPackage(root: string, agentDir: string): void {
  const tarballs = join(root, "tarballs");
  const npmRoot = join(root, "npm");
  mkdirSync(tarballs, { recursive: true, mode: 0o700 });
  execFileSync("npm", ["pack", "--workspace=packages/core", "--pack-destination", tarballs], { cwd: repositoryRoot, stdio: "pipe", timeout: 120_000 });
  const tarball = readdirSync(tarballs).find((name) => name.endsWith(".tgz"));
  assert.ok(tarball, "npm pack did not produce a package tarball");
  execFileSync("npm", ["install", "--prefix", npmRoot, "--ignore-scripts", "--omit=dev", "--legacy-peer-deps", join(tarballs, tarball)], { stdio: "pipe", timeout: 120_000 });
  const packagePath = join(npmRoot, "node_modules", "pi-extensible-workflows");
  assert.ok(existsSync(join(packagePath, "package.json")), "npm did not install pi-extensible-workflows");
  execFileSync("pi", ["install", packagePath], {
    cwd: root,
    env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    stdio: "pipe",
    timeout: 30_000,
  });
}

function stopTrajectoryServer(agentDir: string): void {
  try {
    const lock = JSON.parse(readFileSync(join(agentDir, "pi-extensible-workflows", "trajectory.lock"), "utf8")) as { pid?: unknown };
    if (typeof lock.pid === "number") process.kill(lock.pid, "SIGTERM");
  } catch { /* The server may not have created its lock or may already be gone. */ }
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "could not reserve a Trajectory port");
  await new Promise<void>((resolve, reject) => server.close((error) => {
    if (error) reject(error);
    else resolve();
  }));
  return address.port;
}

void test("an npm-installed package opens Trajectory from the real Pi TUI", { skip: !enabled, timeout: 180_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-trajectory-e2e-"));
  const agentDir = join(root, "agent");
  const trajectoryPort = String(await availablePort());
  const h = TestHarness.create({ prefix: "trajectory-e2e", agentDir, homeDir: root, environment: { PI_WORKFLOW_TRAJECTORY_PORT: trajectoryPort } });
  try {
    installPackage(root, agentDir);
    await h.addRun({ workflowName: "trajectory-fixture", state: "completed" });
    await h.launch({ installedExtensions: true });

    h.send("/workflow trajectory");
    try {
      await h.waitFor("Trajectory opened at http://127.0.0.1:", 15_000);
    } catch (error) {
      assert.fail(`${error instanceof Error ? error.message : String(error)}\nPi screen:\n${h.readPane()}`);
    }
    const screen = h.readPane();
    const url = /Trajectory opened at (http:\/\/127\.0\.0\.1:\d+\/)/.exec(screen)?.[1];
    assert.ok(url, `Trajectory URL was not rendered by Pi:\n${screen}`);

    const response = await fetch(url);
    assert.equal(response.ok, true, `Trajectory returned HTTP ${String(response.status)}`);
    assert.match(await response.text(), /<title>Trajectory<\/title>/);
  } finally {
    await h.close();
    stopTrajectoryServer(agentDir);
    rmSync(h.cwd, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  }
});
