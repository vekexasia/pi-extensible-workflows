import { initializeGitFixture, fixtureGitSync } from "./git-fixture.js";
import { physicalOwnerDirectory } from "./worktree-owner-fixture.js";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fsPromises from "node:fs/promises";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test, { type TestContext } from "node:test";
import { RunStore } from "../src/persistence.js";
import { retainTerminalRuns } from "../src/retention.js";
import { createLaunchSnapshot } from "../src/validation.js";
import { DEFAULT_SETTINGS, workflowSettingsPath } from "../src/settings.js";
import { runWorkflow, executeShellCommand } from "../src/execution.js";
import { WorkflowOwnership } from "../src/ownership.js";
import { worktreeOwnerDirectory } from "../src/worktree-lease.js";
import { WORKFLOW_CAPABILITIES } from "../src/types.js";

const git = (cwd: string, ...args: string[]) => fixtureGitSync(["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
async function fixture(setup: readonly string[] = ["exit 7"]) {
  const home = mkdtempSync(join(tmpdir(), "cleanup-uncertainty-")), cwd = join(home, "repo");
  initializeGitFixture(cwd); git(cwd, "config", "user.name", "Fixture"); git(cwd, "config", "user.email", "fixture@example.invalid");
  git(cwd, "commit", "--allow-empty", "-qm", "initial");
  const tip = git(cwd, "rev-parse", "HEAD"), store = new RunStore(cwd, "s", "r", home);
  await store.create({ id: "r", sessionId: "s", cwd, workflowName: "cleanup", state: "running", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return null;", args: null, metadata: { name: "cleanup" }, settings: { ...DEFAULT_SETTINGS, worktreeSetup: setup }, models: [], tools: [], agentConfigurations: {}, schemas: [] }));
  return { home, cwd, tip, store };
}
function cleanupFault(t: TestContext, operation: "remove" | "branch", benign = false) {
  const fork = childProcess.fork.bind(childProcess);
  let faults = 0;
  t.mock.method(childProcess, "fork", ((...args: Parameters<typeof childProcess.fork>) => {
    const child = fork(...args);
    if (String(args[0]).endsWith("/supervisor.cjs")) {
      const send = child.send.bind(child);
      child.send = ((message: unknown, ...rest: unknown[]) => {
        const start = message as { type?: string; command?: string };
        const matches = operation === "remove" ? start.command?.includes("'worktree' 'remove'") : start.command?.includes("'branch' '-D'");
        if (start.type === "start" && matches) {
          faults += 1;
          if (benign) return Reflect.apply(send, child, [{ ...start, command: "exit 7" }, ...rest]) as boolean;
          // Transport fault only: this fresh helper has NOT received a command or spawned Git.
          // Its real missing completion receipt produces the authoritative OwnedCommandCleanupError.
          child.kill("SIGKILL");
          return true;
        }
        return Reflect.apply(send, child, [message, ...rest]) as boolean;
      });
    }
    return child;
  }) as typeof childProcess.fork);
  syncBuiltinESMExports();
  return { count: () => faults, restore: () => { t.mock.restoreAll(); syncBuiltinESMExports(); } };
}
const unproven = (error: unknown) => error instanceof Error && "cleanupUnproven" in error && error.cleanupUnproven === true;
const marker = (store: RunStore) => {
  const name = readdirSync(store.directory).find((entry) => entry.endsWith(".creating"));
  assert.ok(name, "cleanup must retain a durable transaction marker");
  return join(store.directory, name);
};

for (const operation of ["remove", "branch"] as const) {
  void test(`worktree failure preserves ${operation} cleanup uncertainty above callback PASS`, { timeout: 15_000 }, async (t) => {
    const f = await fixture(), fault = cleanupFault(t, operation), controller = new AbortController();
    const ownership = new WorkflowOwnership(f.cwd, "r", "s", controller.signal, executeShellCommand);
    const bridge = ownership.decorate({ capabilities: WORKFLOW_CAPABILITIES, worktree: (owner, signal, options) => f.store.worktree(owner, options, signal) });
    try {
      const execution = runWorkflow('try { await withWorktreeLease(args.cwd, async () => withWorktree("gate", () => "writer", {expectedTip:args.tip})); } catch {} return "PASS";', { cwd: f.cwd, tip: f.tip }, bridge, controller.signal);
      await assert.rejects(execution.result, unproven);
      assert.equal(fault.count(), 1);
      assert.equal(existsSync(join(await physicalOwnerDirectory(f.cwd), "owner.json")), true);
      const record = JSON.parse(readFileSync(marker(f.store), "utf8")) as { owner: string; cleanupUnproven?: boolean; failureCode?: string };
      assert.equal(record.cleanupUnproven, true); assert.equal(record.failureCode, "WORKTREE_FAILED");
      const reloaded = new RunStore(f.cwd, "s", "r", f.home);
      await assert.rejects(reloaded.worktree(record.owner), /cleanup.*unproven|incomplete|attempted/);
      await assert.rejects(reloaded.delete(true), /cleanup.*unproven|incomplete/);
      assert.equal(fault.count(), 1, "uncertain cleanup cannot be retried implicitly");
    } finally { fault.restore(); controller.abort(); await ownership.finalize().catch(() => undefined); rmSync(f.home, { recursive: true, force: true }); }
  });

  void test(`controlled recorded deletion persists intent before ${operation} cleanup uncertainty`, { timeout: 15_000 }, async (t) => {
    const f = await fixture([]), gate = await f.store.worktree("gate", { expectedTip: f.tip, setup: "none" });
    const fault = cleanupFault(t, operation);
    try {
      await assert.rejects(f.store.delete(true), unproven);
      assert.ok(gate.resourceIdentity);
      assert.equal(existsSync(join(worktreeOwnerDirectory(gate.resourceIdentity), "owner.json")), true, "external cleanup authority survives even when Git metadata is gone");
      const file = marker(f.store), bytes = readFileSync(file, "utf8");
      await assert.rejects(new RunStore(f.cwd, "s", "r", f.home).worktree(gate.owner), unproven);
      assert.equal((JSON.parse(bytes) as { cleanupUnproven?: boolean }).cleanupUnproven, true);
      await assert.rejects(new RunStore(f.cwd, "s", "r", f.home).delete(true), /cleanup.*unproven|incomplete/);
      assert.equal(readFileSync(file, "utf8"), bytes);
      if (operation === "remove") assert.equal(existsSync(gate.path), true);
      await f.store.updateState((run) => ({ ...run, state: "failed" }));
      await assert.rejects(retainTerminalRuns({ cwd: f.cwd, home: f.home, sessionId: "s", retention: { olderThanDays: 1 }, now: Date.now() + 100 * 86_400_000 }), /Run inventory contains an unrecognized artifact: .*\.creating/);
      assert.equal(existsSync(file), true, "automatic retention cannot erase cleanup uncertainty");
    } finally { fault.restore(); rmSync(f.home, { recursive: true, force: true }); }
  });
}

void test("incomplete controlled marker deletion never starts cleanup or removes root", async (t) => {
  const f = await fixture([]), gate = await f.store.worktree("gate", { expectedTip: f.tip, setup: "none" });
  const file = join(f.store.directory, `worktree-${basename(gate.path)}.creating`);
  writeFileSync(file, JSON.stringify({ ...gate, controlled: true }));
  writeFileSync(join(f.store.directory, "worktrees.json"), "[]\n");
  const fault = cleanupFault(t, "remove");
  try {
    await assert.rejects(f.store.delete(true), /cleanup.*unproven|incomplete/);
    assert.equal(fault.count(), 0); assert.equal(existsSync(gate.path), true); assert.equal(existsSync(file), true);
  } finally { fault.restore(); rmSync(f.home, { recursive: true, force: true }); }
});

for (const operation of ["remove", "branch"] as const) void test(`failed uncertainty update keeps typed error, poison and durable incomplete marker${operation === "branch" ? " after metadata removal" : ""}`, { timeout: 15_000 }, async (t) => {
  const f = await fixture(), fault = cleanupFault(t, operation);
  const controller = new AbortController(), ownership = new WorkflowOwnership(f.cwd, "r", "s", controller.signal, executeShellCommand);
  const scope = await ownership.enter(f.cwd, undefined, controller.signal);
  const rename = fsPromises.rename.bind(fsPromises);
  let failedWrites = 0;
  t.mock.method(fsPromises, "rename", async (from: Parameters<typeof fsPromises.rename>[0], to: Parameters<typeof fsPromises.rename>[1]) => {
    if (String(to).endsWith(".creating") && readFileSync(String(from), "utf8").includes('"cleanupUnproven":true')) { failedWrites += 1; throw new Error("injected marker update failure"); }
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(ownership.associate(scope.scope, () => f.store.worktree("gate", { expectedTip: f.tip }, controller.signal)), unproven);
    await assert.rejects(ownership.leave(scope.scope), unproven);
    assert.equal(existsSync(join(await physicalOwnerDirectory(f.cwd), "owner.json")), true);
    assert.equal(failedWrites, 1);
    const initial = JSON.parse(readFileSync(marker(f.store), "utf8")) as { resourceIdentity: import("../src/worktree-lease.js").WorktreeLeaseIdentity };
    assert.equal(existsSync(join(worktreeOwnerDirectory(initial.resourceIdentity), "owner.json")), true);
    if (operation === "branch") { assert.equal(existsSync(initial.resourceIdentity.path), false); assert.equal(existsSync(initial.resourceIdentity.gitDirectory), false); }
    assert.equal(existsSync(marker(f.store)), true);
    await assert.rejects(f.store.delete(true), unproven);
    const reloaded = new RunStore(f.cwd, "s", "r", f.home);
    await assert.rejects(reloaded.delete(true), /cleanup.*unproven|incomplete/);
    await assert.rejects(reloaded.worktree("gate"), /attempted|incomplete|unproven/);
    assert.equal(fault.count(), 1);
  } finally { fault.restore(); controller.abort(); await ownership.finalize().catch(() => undefined); rmSync(f.home, { recursive: true, force: true }); }
});

void test("legacy benign cleanup nonzero preserves the original ordinary failure", { timeout: 15_000 }, async (t) => {
  const f = await fixture(), fault = cleanupFault(t, "remove", true);
  try {
    await assert.rejects(f.store.worktree("gate", undefined, new AbortController().signal), (error: unknown) => error instanceof Error && /exited with 7/.test(error.message) && !unproven(error));
    assert.equal(fault.count(), 1);
    assert.equal(readdirSync(f.store.directory).some((entry) => entry.endsWith(".creating")), false);
  } finally { fault.restore(); rmSync(f.home, { recursive: true, force: true }); }
});

void test("production stop rejects uncertain cleanup after proven setup cancellation and retains ownership", { timeout: 15_000 }, async (t) => {
  const { default: workflowExtension, RunStore: HostRunStore } = await import("../src/index.js");
  const { testExtensionApi } = await import("./support.js");
  const f = await fixture([]), ready = join(f.home, "ready"), setup = join(f.home, "setup.cjs");
  writeFileSync(setup, `const fs=require("node:fs");process.on("SIGTERM",()=>process.exit(1));fs.writeFileSync(${JSON.stringify(ready)},process.cwd());setInterval(()=>{},1000);`);
  mkdirSync(join(f.home, "pi-extensible-workflows"));
  writeFileSync(workflowSettingsPath(f.home), JSON.stringify({ worktreeSetup: [`exec ${quote(process.execPath)} ${quote(setup)}`] }));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { runId?: string } }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), f.home, undefined, undefined, f.home);
  const workflow = tools.find(({ name }) => name === "workflow"), stop = tools.find(({ name }) => name === "workflow_stop"); assert.ok(workflow && stop);
  const context = { cwd: f.cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "host" } };
  const fault = cleanupFault(t, "remove"); let stopping: Promise<unknown> | undefined;
  try {
    const launched = await workflow.execute("start", { name: "cleanup-stop", script: 'await withWorktreeLease(args.cwd, async () => withWorktree("gate", () => "writer", {expectedTip:args.tip}));', args: { cwd: f.cwd, tip: f.tip } }, new AbortController().signal, undefined, context);
    const id = launched.details.runId; assert.ok(id);
    const deadline = Date.now() + 5000;
    while (!existsSync(ready)) { assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 10)); }
    const root = readFileSync(ready, "utf8");
    let acknowledged = false;
    stopping = stop.execute("stop", { runId: id }, new AbortController().signal, undefined, context);
    void stopping.then(() => { acknowledged = true; }, () => undefined);
    await assert.rejects(stopping, unproven);
    assert.equal(acknowledged, false); assert.equal(fault.count(), 1);
    const owner = join(await physicalOwnerDirectory(f.cwd), "owner.json");
    assert.equal(existsSync(owner), true); assert.equal(existsSync(root), true);
    const store = new HostRunStore(f.cwd, "host", id, f.home), file = marker(store);
    assert.equal((JSON.parse(readFileSync(file, "utf8")) as { failureCode?: string }).failureCode, "CANCELLED");
    await assert.rejects(store.delete(true), /cleanup.*unproven|incomplete/);
    fault.restore();
    const branch = git(root, "branch", "--show-current"); git(f.cwd, "worktree", "remove", "--force", root); git(f.cwd, "branch", "-D", branch);
    await assert.rejects(new HostRunStore(f.cwd, "host", id, f.home).delete(true), /cleanup.*unproven|incomplete/);
    assert.equal(existsSync(owner), true, "late cleanup does not clear retention");
  } finally { fault.restore(); await stopping?.catch(() => undefined); rmSync(f.home, { recursive: true, force: true }); }
});

for (const operation of ["remove", "branch"] as const) {
  void test(`proven controlled marker retains ${operation} cleanup uncertainty before filesystem removal`, { timeout: 15_000 }, async (t) => {
    const f = await fixture();
    let fault = cleanupFault(t, "remove", true);
    try {
      // Both real cleanup processes settle nonzero: quiescence is affirmatively persisted,
      // but the failed remove leaves a real checkout/branch for explicit deletion to handle.
      await assert.rejects(f.store.worktree("gate", { expectedTip: f.tip, fresh: true }), /exited with 7/);
      const file = marker(f.store), state = JSON.parse(readFileSync(file, "utf8")) as { path: string; cleanupProven?: boolean };
      assert.equal(state.cleanupProven, true); assert.equal(existsSync(state.path), true);
      fault.restore(); fault = cleanupFault(t, operation);
      await assert.rejects(new RunStore(f.cwd, "s", "r", f.home).delete(true), unproven);
      assert.equal(fault.count(), 1);
      assert.equal((JSON.parse(readFileSync(file, "utf8")) as { cleanupUnproven?: boolean }).cleanupUnproven, true);
      if (operation === "remove") assert.equal(existsSync(state.path), true, "rm must not follow an unproven Git remove");
    } finally { fault.restore(); rmSync(f.home, { recursive: true, force: true }); }
  });
}

void test("controlled deletion does not start destructive cleanup when intent persistence fails", async (t) => {
  const f = await fixture([]), gate = await f.store.worktree("gate", { expectedTip: f.tip, setup: "none" });
  const fault = cleanupFault(t, "remove"), rename = fsPromises.rename.bind(fsPromises);
  t.mock.method(fsPromises, "rename", async (from: Parameters<typeof fsPromises.rename>[0], to: Parameters<typeof fsPromises.rename>[1]) => {
    if (String(to).endsWith(".creating")) throw new Error("injected intent persistence failure");
    return rename(from, to);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(f.store.delete(true), /intent persistence failure/);
    assert.equal(fault.count(), 0); assert.equal(existsSync(gate.path), true);
    assert.equal((await new RunStore(f.cwd, "s", "r", f.home).worktree("gate")).path, gate.path);
  } finally { fault.restore(); rmSync(f.home, { recursive: true, force: true }); }
});
