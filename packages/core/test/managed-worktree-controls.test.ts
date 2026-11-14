import { physicalOwnerDirectory } from "./worktree-owner-fixture.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { RunStore, structuralPath } from "../src/persistence.js";
import { createLaunchSnapshot } from "../src/validation.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { PhysicalWorktreeLease, worktreeLeaseIdentity } from "../src/worktree-lease.js";

type Controls = import("../src/types.js").WorkflowWorktreeOptions;
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
async function fixture(setup: readonly string[] = []) {
  const home = mkdtempSync(join(tmpdir(), "managed-controls-")), cwd = join(home, "repo");
  git(home, "init", "-q", cwd);
  git(cwd, "config", "user.name", "Fixture"); git(cwd, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(cwd, ".gitignore"), ".env\nsetup-head\n"); writeFileSync(join(cwd, "input"), "A");
  git(cwd, "add", "."); git(cwd, "commit", "-qm", "A"); const a = git(cwd, "rev-parse", "HEAD");
  writeFileSync(join(cwd, "input"), "B"); git(cwd, "commit", "-qam", "B"); const b = git(cwd, "rev-parse", "HEAD");
  git(cwd, "checkout", "--detach", a); writeFileSync(join(cwd, ".env"), "implementation-only");
  const snapshot = createLaunchSnapshot({ script: "return null;", args: null, metadata: { name: "controls" }, settings: { ...DEFAULT_SETTINGS, worktreeSetup: setup }, models: [], tools: [], agentConfigurations: {}, schemas: [] });
  const makeStore = async (id: string, parentRunId?: string) => {
    const store = new RunStore(cwd, "session", id, home);
    await store.create({ id, cwd, sessionId: "session", workflowName: "controls", state: "running", agents: [], agentSessions: [], ...(parentRunId ? { parentRunId } : {}) }, snapshot);
    return store;
  };
  const store = await makeStore("first");
  const worktree = (owner: string, options?: Controls) => store.worktree(owner, options);
  return { home, cwd, a, b, store, worktree, makeStore };
}

void test("managed controls pin candidate B before setup while launch remains A", async () => {
  const f = await fixture(["git rev-parse HEAD > setup-head"]);
  try {
    const gate = await f.worktree("gate", { expectedTip: f.b, fresh: true });
    assert.equal(gate.base, f.b);
    assert.equal(git(gate.path, "rev-parse", "HEAD"), f.b);
    assert.equal(readFileSync(join(gate.path, "setup-head"), "utf8").trim(), f.b);
    assert.equal(readFileSync(join(gate.path, "input"), "utf8"), "B");
    assert.equal(existsSync(join(gate.path, ".env")), false);
    assert.equal(git(f.cwd, "rev-parse", "HEAD"), f.a);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

void test("managed fresh rejects used dirty and inherited scopes without altering them", async () => {
  const f = await fixture(); const owner = structuralPath("worktree", "named", "gate");
  try {
    const gate = await f.worktree(owner);
    writeFileSync(join(gate.path, "dirty"), "keep");
    await assert.rejects(f.worktree(owner, { fresh: true }), /fresh|existing|used/);
    assert.equal(readFileSync(join(gate.path, "dirty"), "utf8"), "keep");
    await f.store.updateState((run) => ({ ...run, state: "failed" }));
    const child = await f.makeStore("child", "first");
    await assert.rejects(child.worktree(owner, { fresh: true }), /fresh|inherited|existing/);
    assert.deepEqual(await child.borrowedWorktrees(), []);
    await child.worktree(owner);
    assert.equal((await child.borrowedWorktrees()).length, 1);
    await assert.rejects(child.worktree(owner, { fresh: true }), /fresh|Fresh|borrowed/);
    assert.equal(readFileSync(join(gate.path, "dirty"), "utf8"), "keep");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

void test("managed setup none remains durable after real RunStore reload and implicit resolution", async () => {
  const f = await fixture(["printf forbidden > setup-head"]);
  try {
    const gate = await f.worktree("gate", { expectedTip: f.b, setup: "none", fresh: true });
    assert.equal(existsSync(join(gate.path, "setup-head")), false);
    const reloaded = new RunStore(f.cwd, "session", "first", f.home);
    assert.deepEqual(await reloaded.worktree("gate"), gate);
    assert.equal(existsSync(join(gate.path, "setup-head")), false);
    assert.equal((JSON.parse(readFileSync(join(f.store.directory, "worktrees.json"), "utf8")) as Array<{ controls?: Controls }>)[0]?.controls?.setup, "none");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

void test("managed expected tip validates full commits and rejects setup HEAD drift before callback", async () => {
  const f = await fixture(["git checkout --detach HEAD~1"]);
  try {
    for (const expectedTip of ["HEAD", f.b.slice(0, 12), "0".repeat(40), "not-a-commit"]) {
      await assert.rejects(f.worktree(`bad-${expectedTip}`, { expectedTip, fresh: true }), /commit|expectedTip/);
    }
    await assert.rejects(f.worktree("drift", { expectedTip: f.b, fresh: true }), /HEAD|tip/);
    await assert.rejects(f.worktree("drift", { expectedTip: f.b, fresh: true }), /fresh|used|existing/);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

void test("managed worktree deletion refuses retained physical ownership", async () => {
  const f = await fixture();
  try {
    const gate = await f.worktree("gate");
    const owner = await PhysicalWorktreeLease.acquire(await worktreeLeaseIdentity(gate.path), { runId: "uncertain", sessionId: "s", executionId: "e" });
    try {
      await assert.rejects(f.store.delete(true), /physical owner|ownership/);
      await owner.verify();
      assert.equal(existsSync(join(gate.path, "input")), true);
    } finally { await owner.release(); }
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

void test("native and registered managed controls agree, retain legacy calls and historical replay", { timeout: 20_000 }, async () => {
  const { WorkflowOwnership } = await import("../src/ownership.js");
  const { runWorkflow, executeShellCommand } = await import("../src/execution.js");
  const { withWorkflowFunctions, workflowRunContext } = await import("../src/host-runtime.js");
  const { WorkflowRegistry } = await import("../src/registry.js");
  const { WORKFLOW_CAPABILITIES } = await import("../src/types.js");
  const f = await fixture(["printf forbidden > setup-head"]);
  const controller = new AbortController();
  const ownership = new WorkflowOwnership(f.cwd, "first", "session", controller.signal, executeShellCommand, async (owner) => f.store.worktree(owner));
  let entries = 0;
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Managed agreement fixture", functions: { registeredGate: {
    description: "Use explicit gate controls", input: { type: "object" }, output: { type: "string" },
    run: async (_input, context) => {
      entries += 1;
      assert.equal(context.capabilities?.managedWorktreeControls, true);
      assert.equal(context.capabilities.sequentialLeaseCommands, true);
      assert.equal(Object.isFrozen(context.capabilities), true);
      return context.withWorktree("registered", async (gate) => context.withWorktreeLease(gate.path, async (lease) => {
        assert.equal(existsSync(join(gate.path, "setup-head")), false);
        return (await lease.shell("cat input")).stdout;
      }), { expectedTip: f.b, fresh: true, setup: "none" });
    },
  } } });
  const context = workflowRunContext(f.cwd, "session", "first", { name: "controls" }, null, controller.signal);
  const bridge = withWorkflowFunctions(ownership.decorate({ capabilities: WORKFLOW_CAPABILITIES, worktree: async (owner, signal, options) => f.store.worktree(owner, options, signal) }), f.store, context, registry);
  try {
    assert.equal(await runWorkflow("return await registeredGate({});", null, bridge, controller.signal).result, "B");
    // A new execution-local manager cannot turn completed replay into fresh verification.
    assert.equal(await runWorkflow("return await registeredGate({});", null, withWorkflowFunctions({}, f.store, context, registry)).result, "B");
    assert.equal(entries, 1);
    const nativeOwnership = new WorkflowOwnership(f.cwd, "native", "session", controller.signal, executeShellCommand, async (owner) => f.store.worktree(owner));
    const nativeBridge = nativeOwnership.decorate({ capabilities: WORKFLOW_CAPABILITIES, worktree: async (owner, signal, options) => f.store.worktree(owner, options, signal) });
    assert.deepEqual(await runWorkflow(`if (!workflowCapabilities.managedWorktreeControls || !Object.isFrozen(workflowCapabilities)) throw new Error("missing acknowledgement"); return await withWorktree("native", async gate => withWorktreeLease(gate.path, async lease => (await lease.shell("cat input")).stdout), {expectedTip:args,fresh:true,setup:"none"});`, f.b, nativeBridge).result, "B");
    assert.equal(typeof await runWorkflow('return await withWorktree("legacy", gate => gate.path);', null, { worktree: async (owner) => f.store.worktree(owner) }).result, "string");
    const legacy = await f.store.worktree(structuralPath("worktree", "named", "legacy"));
    assert.equal(readFileSync(join(legacy.path, "setup-head"), "utf8"), "forbidden");
  } finally { controller.abort(); rmSync(f.home, { recursive: true, force: true }); }
});

void test("partial native and registered bridges reject controls before old setup or writer entry", async () => {
  const { runWorkflow } = await import("../src/execution.js");
  const { withWorkflowFunctions, workflowRunContext } = await import("../src/host-runtime.js");
  const { WorkflowRegistry } = await import("../src/registry.js");
  const f = await fixture(); let entered = 0;
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Partial bridge fixture", functions: { unsupportedGate: {
    description: "Require controls before invoking a partial host", input: { type: "object" }, output: { type: "string" },
    run: async (_input, context) => context.withWorktree("partial", () => "forbidden", { setup: "none", fresh: true }),
  } } });
  const old = { worktree: async () => { entered += 1; return { path: "/old", branch: "old" }; } };
  try {
    await assert.rejects(runWorkflow('return withWorktree("partial", () => "forbidden", {setup:"none",fresh:true});', null, old).result, /controls are unavailable/);
    const bridge = withWorkflowFunctions(old, f.store, workflowRunContext(f.cwd, "session", "first", { name: "partial" }, null, new AbortController().signal), registry);
    await assert.rejects(runWorkflow("return unsupportedGate({});", null, bridge).result, /controls are unavailable/);
    assert.equal(entered, 0, "an old resolver may run setup before callback and must never be called");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

for (const uncertain of [false, true]) {
  void test(`production outer lease drains managed setup before stop acknowledgement: ${uncertain ? "uncertain" : "proven"}`, { timeout: 25_000 }, async () => {
    const { mkdirSync } = await import("node:fs");
    const { default: workflowExtension, workflowSettingsPath, RunStore: HostRunStore } = await import("../src/index.js");
    const { testExtensionApi } = await import("./support.js");
    const f = await fixture();
    const ready = join(f.home, "ready.json"), drained = join(f.home, "drained"), script = join(f.home, "setup.cjs");
    writeFileSync(script, `const fs=require("node:fs"); process.on("SIGTERM",()=>{setTimeout(()=>{fs.writeFileSync(${JSON.stringify(drained)},"drained");process.exit(1)},200)}); fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,parent:process.ppid,cwd:process.cwd()}));setInterval(()=>{},1000);`);
    const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const settings = workflowSettingsPath(f.home);
    mkdirSync(join(f.home, "pi-extensible-workflows"), { recursive: true });
    writeFileSync(settings, JSON.stringify({ worktreeSetup: [`exec ${quote(process.execPath)} ${quote(script)}`] }));
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { runId?: string; stopped?: boolean } }> }> = [];
    workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), f.home, undefined, undefined, f.home);
    const workflow = tools.find(({ name }) => name === "workflow"), stop = tools.find(({ name }) => name === "workflow_stop"); assert.ok(workflow && stop);
    const context = { cwd: f.cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "outer" } };
    const until = async (check: () => boolean, timeout = 5000) => { const deadline = Date.now() + timeout; while (!check()) { assert.ok(Date.now() < deadline, "fixture must settle"); await new Promise((resolve) => setTimeout(resolve, 20)); } };
    let helper: { pid: number; args: string } | undefined;
    let stopping: Promise<unknown> | undefined;
    let setup: { pid: number; parent: number; cwd: string } | undefined;
    const processes = () => execFileSync("ps", ["-axo", "pid=,args="], { encoding: "utf8" }).split("\n").flatMap((line) => { const match = /^\s*(\d+)\s+(.*)$/.exec(line); return match ? [{ pid: Number(match[1]), args: match[2] ?? "" }] : []; });
    try {
      const launched = await workflow.execute("start", { name: "outer-setup", script: 'await withWorktreeLease(args.cwd, async () => withWorktree("gate", () => { throw new Error("writer must not enter"); }, {expectedTip:args.tip,fresh:true}));', args: { cwd: f.cwd, tip: f.b } }, new AbortController().signal, undefined, context);
      const id = launched.details.runId; assert.ok(id);
      await until(() => existsSync(ready));
      setup = JSON.parse(readFileSync(ready, "utf8")) as typeof setup; assert.ok(setup);
      assert.equal(git(setup.cwd, "rev-parse", "HEAD"), f.b);
      if (uncertain) {
        helper = processes().find(({ pid, args }) => pid === setup?.parent && args.includes("/pi-owned-") && args.includes("/supervisor.cjs"));
        assert.ok(helper, "fresh setup PID parent must be the owned supervisor");
        process.kill(helper.pid, "SIGSTOP");
      }
      let acknowledged = false;
      stopping = stop.execute("stop", { runId: id }, new AbortController().signal, undefined, context);
      void stopping.then(() => { acknowledged = true; }, () => undefined);
      await new Promise((resolve) => setTimeout(resolve, 40));
      const ownerFile = join(await physicalOwnerDirectory(f.cwd), "owner.json");
      assert.equal(acknowledged, false); assert.equal(existsSync(ownerFile), true);
      if (uncertain) {
        await assert.rejects(stopping, /cleanup unproven|did not drain/);
        assert.equal(existsSync(ownerFile), true);
        assert.equal(existsSync(setup.cwd), true, "uncertain setup must not have its managed root removed");
        const store = new HostRunStore(f.cwd, "outer", id, f.home);
        await assert.rejects(store.delete(true), /cleanup.*unproven|physical owner/);
        assert.ok(helper); process.kill(helper.pid, "SIGCONT");
        await until(() => existsSync(drained));
        assert.equal(existsSync(ownerFile), true, "late quiescence cannot clear uncertainty");
        assert.equal(existsSync(setup.cwd), true);
      } else {
        await stopping;
        assert.equal(existsSync(drained), true);
        assert.equal(existsSync(ownerFile), false);
        assert.equal(existsSync(setup.cwd), false);
      }
    } finally {
      if (helper && processes().some(({ pid, args }) => pid === helper?.pid && args === helper.args)) process.kill(helper.pid, "SIGCONT");
      if (setup && processes().some(({ pid, args }) => pid === setup?.pid && args.includes(script))) { try { process.kill(setup.pid, "SIGTERM"); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); } }
      if (setup) await until(() => !processes().some(({ pid, args }) => pid === setup?.pid && args.includes(script)));
      await stopping?.catch(() => undefined);
      rmSync(f.home, { recursive: true, force: true });
    }
  });
}

void test("controlled checkout preserves configured Git hooks and signing policy", async () => {
  const { mkdirSync } = await import("node:fs");
  const f = await fixture();
  try {
    const hooks = join(f.home, "hooks"), observed = join(f.home, "hook-head"); mkdirSync(hooks);
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\ngit rev-parse HEAD > '${observed}'\ngit config --get commit.gpgsign >> '${observed}'\n`, { mode: 0o700 });
    git(f.cwd, "config", "core.hooksPath", hooks); git(f.cwd, "config", "commit.gpgsign", "true");
    const gate = await f.worktree("hooked", { expectedTip: f.b, setup: "none", fresh: true });
    assert.equal(readFileSync(observed, "utf8"), `${f.b}\ntrue\n`);
    assert.equal(git(gate.path, "config", "--get", "core.hooksPath"), hooks);
    assert.equal(git(gate.path, "config", "--get", "commit.gpgsign"), "true");
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});

void test("native and registered partial lease bridges reject sequential mode before command admission", async (t) => {
  const { WorkflowOwnership } = await import("../src/ownership.js");
  const { runWorkflow, executeShellCommand } = await import("../src/execution.js");
  const { withWorkflowFunctions, workflowRunContext } = await import("../src/host-runtime.js");
  const { WorkflowRegistry } = await import("../src/registry.js");
  const f = await fixture();
  const ownership = new WorkflowOwnership(f.cwd, "first", "s", new AbortController().signal, executeShellCommand);
  let admissions = 0;
  t.mock.method(ownership, "command", () => { admissions += 1; throw new Error("partial old command must not be invoked"); });
  const partial = { ...ownership.decorate({}), capabilities: Object.freeze({}) };
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Partial sequential fixture", functions: { partialSequential: {
    description: "Reject unsupported reuse", input: { type: "object" }, output: { type: "string" },
    run: async (_input, context) => context.withWorktreeLease(f.cwd, (lease) => lease.command("printf forbidden", { timeoutMs: 1000, reuse: "sequential" })),
  } } });
  try {
    await assert.rejects(runWorkflow('return await withWorktreeLease(args, lease => lease.command("printf forbidden", {timeoutMs:1000,reuse:"sequential"}));', f.cwd, partial).result, /Sequential lease commands are unavailable/);
    const freshOwnership = new WorkflowOwnership(f.cwd, "second", "s", new AbortController().signal, executeShellCommand);
    t.mock.method(freshOwnership, "command", () => { admissions += 1; throw new Error("partial old command must not be invoked"); });
    const bridge = withWorkflowFunctions({ ...freshOwnership.decorate({}), capabilities: Object.freeze({}) }, f.store, workflowRunContext(f.cwd, "session", "first", { name: "partial" }, null, new AbortController().signal), registry);
    await assert.rejects(runWorkflow("return partialSequential({});", null, bridge).result, /Sequential lease commands are unavailable/);
    assert.equal(admissions, 0);
  } finally { await ownership.finalize(); rmSync(f.home, { recursive: true, force: true }); }
});

void test("managed controls reject unknown and malformed options before materialization", async () => {
  const { validateWorktreeOptions, preflight } = await import("../src/validation.js");
  for (const value of [null, [], { fresh: 1 }, { setup: "later" }, { expectedTip: "HEAD" }, { reset: true }]) assert.throws(() => validateWorktreeOptions(value));
  assert.throws(() => preflight('return withWorktree("gate", () => 1, {reset:true});', { models: new Set(), tools: new Set() }), /Unknown withWorktree controls/);
});

void test("unfinished setup-none transaction blocks implicit bootstrap after a real persistence gap", async () => {
  const f = await fixture(["printf forbidden > setup-head"]);
  try {
    const gate = await f.worktree("gate", { expectedTip: f.b, setup: "none" });
    const marker = join(f.store.directory, `worktree-${basename(gate.path)}.creating`);
    writeFileSync(marker, JSON.stringify({ ...gate, controlled: true }));
    writeFileSync(join(f.store.directory, "worktrees.json"), "[]\n");
    const before = readFileSync(marker, "utf8");
    await assert.rejects(new RunStore(f.cwd, "session", "first", f.home).worktree("gate"), /controlled|Controlled|used|attempted/);
    assert.equal(existsSync(join(gate.path, "setup-head")), false);
    assert.equal(git(gate.path, "rev-parse", "HEAD"), f.b);
    assert.equal(readFileSync(marker, "utf8"), before);
  } finally { rmSync(f.home, { recursive: true, force: true }); }
});
