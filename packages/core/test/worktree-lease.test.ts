import { initializeGitFixture, fixtureGitSync } from "./git-fixture.js";
import { physicalOwnerDirectory } from "./worktree-owner-fixture.js";
import { canonicalPath } from "../src/paths.js";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import workflowExtension, { registerWorkflowExtension } from "../src/index.js";
import { testExtensionApi } from "./support.js";

function repository(): string {
  const directory = mkdtempSync(join(tmpdir(), "worktree-lease-"));
  initializeGitFixture(directory);
  fixtureGitSync(["-C", directory, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-qm", "initial"]);
  return directory;
}

for (const mode of ["native", "registered"] as const) {
  for (const request of ["subdirectory", "root", "alias"] as const) {
    void test(`production subdirectory launch admits ${mode} lease requested through ${request}`, { timeout: 30_000 }, async () => {
      const { PhysicalWorktreeLease, worktreeLeaseIdentity } = await import("../src/worktree-lease.js");
      const cwd = repository(), home = mkdtempSync(join(tmpdir(), "subdirectory-lease-home-"));
      const subdirectory = join(cwd, "tracked"), alias = `${cwd}-alias`;
      mkdirSync(subdirectory);
      writeFileSync(join(subdirectory, "input"), "tracked fixture\n");
      fixtureGitSync(["-C", cwd, "add", "tracked/input"]);
      fixtureGitSync(["-C", cwd, "commit", "-qm", "tracked subdirectory"]);
      symlinkSync(cwd, alias);
      const requested = request === "subdirectory" ? subdirectory : request === "root" ? cwd : join(alias, "tracked");
      const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { value?: unknown } }> }> = [];
      workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, undefined, undefined, home);
      let entered = 0;
      const observe = async (path: string, stdout: string) => {
        entered += 1;
        assert.equal(path, canonicalPath(cwd));
        assert.equal(stdout.trim(), canonicalPath(cwd), "lease.shell runs at the documented worktree root, not the launch subdirectory");
        assert.equal(existsSync(join(await physicalOwnerDirectory(cwd), "owner.json")), true);
        await assert.rejects(PhysicalWorktreeLease.acquire(await worktreeLeaseIdentity(cwd), { runId: "competitor", sessionId: "same", executionId: "other" }), /physical owner/);
        return { path, stdout };
      };
      const observeName = `subdirectoryLeaseObserve_${mode}_${request}`, registeredName = `subdirectoryLeaseRegistered_${mode}_${request}`;
      registerWorkflowExtension({ version: "1.0.0", headline: "Subdirectory launch fixture", functions: {
        [observeName]: { description: "Observe real native lease ownership", input: { type: "object" }, output: { type: "object" }, run: async (input) => {
          assert.ok(typeof input.path === "string" && typeof input.stdout === "string");
          return observe(input.path, input.stdout);
        } },
        [registeredName]: { description: "Lease the registered run cwd or an explicit root", input: { type: "object" }, output: { type: "object" }, run: async (input, ctx) => {
          assert.equal(ctx.run.cwd, subdirectory);
          assert.ok(typeof input.path === "string");
          return ctx.withWorktreeLease(request === "subdirectory" ? ctx.run.cwd : input.path, async (lease) => {
            assert.equal(Object.isFrozen(lease), true);
            return observe(lease.path, (await lease.shell("pwd -P")).stdout);
          });
        } },
      } });
      const workflow = tools.find(({ name }) => name === "workflow"); assert.ok(workflow);
      const context = { cwd: subdirectory, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "subdirectory" } };
      try {
        const script = mode === "registered" ? `return await ${registeredName}(args);` : `return await withWorktreeLease(args.path, async lease => { if (!Object.isFrozen(lease)) throw new Error('lease not frozen'); return await ${observeName}({path:lease.path,stdout:(await lease.shell('pwd -P')).stdout}); });`;
        const result = await workflow.execute("start", { name: "subdirectory-lease", script, args: { path: requested }, foreground: true }, new AbortController().signal, undefined, context);
        assert.deepEqual(result.details.value, { path: canonicalPath(cwd), stdout: `${canonicalPath(cwd)}\n` });
        assert.equal(entered, 1, "the lease callback executes exactly once");
        assert.equal(existsSync(await physicalOwnerDirectory(cwd)), false, "foreground completion waits for physical release");
        const next = await PhysicalWorktreeLease.acquire(await worktreeLeaseIdentity(cwd), { runId: "next", sessionId: "same", executionId: "next" });
        await next.verify();
        await next.release();
      } finally { rmSync(alias, { force: true }); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
    });
  }

  for (const target of ["other repository", "linked sibling"] as const) {
    void test(`production subdirectory launch rejects ${mode} lease in ${target} before writer`, { timeout: 30_000 }, async () => {
      const cwd = repository(), other = target === "other repository" ? repository() : `${cwd}-linked`;
      const home = mkdtempSync(join(tmpdir(), "subdirectory-restriction-home-")), subdirectory = join(cwd, "tracked");
      mkdirSync(subdirectory);
      writeFileSync(join(subdirectory, "input"), "tracked fixture\n");
      fixtureGitSync(["-C", cwd, "add", "tracked/input"]);
      fixtureGitSync(["-C", cwd, "commit", "-qm", "tracked subdirectory"]);
      if (target === "linked sibling") fixtureGitSync(["-C", cwd, "worktree", "add", "-qb", "sibling", other]);
      const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
      workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, undefined, undefined, home);
      let entered = 0;
      const writerName = `subdirectoryForbiddenWriter_${mode}_${target.replaceAll(" ", "_")}`, registeredName = `subdirectoryForbiddenLease_${mode}_${target.replaceAll(" ", "_")}`;
      registerWorkflowExtension({ version: "1.0.0", headline: "Subdirectory restriction fixture", functions: {
        [writerName]: { description: "Must never enter", input: { type: "object" }, output: { type: "null" }, run: async () => { entered += 1; return null; } },
        [registeredName]: { description: "Reject an unrelated worktree", input: { type: "object" }, output: { type: "null" }, run: async (_input, ctx) => ctx.withWorktreeLease(other, async (lease) => { entered += 1; await lease.shell("touch forbidden"); return null; }) },
      } });
      const workflow = tools.find(({ name }) => name === "workflow"); assert.ok(workflow);
      const context = { cwd: subdirectory, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "restriction" } };
      try {
        const script = mode === "registered" ? `return await ${registeredName}({});` : `return await withWorktreeLease(args, async lease => { await ${writerName}({}); await lease.shell('touch forbidden'); return null; });`;
        await assert.rejects(workflow.execute("start", { name: "subdirectory-restriction", script, args: other, foreground: true }, new AbortController().signal, undefined, context), /launch root or active managed worktree/);
        assert.equal(entered, 0);
        assert.equal(existsSync(join(other, "forbidden")), false);
        assert.equal(existsSync(await physicalOwnerDirectory(other)), false, "rejection must precede ownership acquisition");
      } finally { rmSync(other, { recursive: true, force: true }); rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
    });
  }
}

void test("production registered callbacks cannot overlap physical ownership in one session", { timeout: 30_000 }, async () => {
  const cwd = repository();
  const home = mkdtempSync(join(tmpdir(), "lease-host-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, undefined, undefined, home);
  let entered = 0;
  registerWorkflowExtension({ version: "1.0.0", headline: "Physical lease fixture", functions: { guarded: {
    description: "Attempt an exclusive callback", input: { type: "object" }, output: { type: "number" },
    run: async (_input, context) => {
      const writer = async () => { entered += 1; await context.shell("printf admitted"); await new Promise((resolve) => setTimeout(resolve, 300)); return 1; };
      return await context.withWorktreeLease(cwd, writer);
    },
  } } });
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd, model: { provider: "fixture", id: "model", contextWindow: 1_000_000, maxTokens: 1000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "same-session" } };
  try {
    const results = await Promise.allSettled([1, 2].map((id) => workflow.execute(String(id), { name: `lease-${String(id)}`, script: "return await guarded({});", foreground: true }, new AbortController().signal, undefined, context)));
    assert.equal(entered, 1, "the loser must not enter any writer/adapter callback");
    assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

void test("physical leases collide through symlinks but linked worktrees remain independent", { timeout: 30_000 }, async () => {
  const { PhysicalWorktreeLease, worktreeLeaseIdentity } = await import("../src/worktree-lease.js");
  const { symlinkSync } = await import("node:fs");
  const cwd = repository();
  const alias = `${cwd}-alias`;
  const sibling = `${cwd}-linked`;
  const diagnostics = { runId: "run", sessionId: "same", executionId: "execution" };
  try {
    symlinkSync(cwd, alias);
    fixtureGitSync(["-C", cwd, "worktree", "add", "-qb", "linked", sibling]);
    const owner = await PhysicalWorktreeLease.acquire(await worktreeLeaseIdentity(cwd), diagnostics);
    try {
      await assert.rejects(PhysicalWorktreeLease.acquire(await worktreeLeaseIdentity(alias), diagnostics), /physical owner/);
      const other = await PhysicalWorktreeLease.acquire(await worktreeLeaseIdentity(sibling), diagnostics);
      await other.release();
    } finally { await owner.release(); }
    const fresh = await PhysicalWorktreeLease.acquire(await worktreeLeaseIdentity(alias), diagnostics);
    await fresh.release();
  } finally { rmSync(alias, { force: true }); rmSync(cwd, { recursive: true, force: true }); rmSync(sibling, { recursive: true, force: true }); }
});

void test("physical stale, malformed and partial owners block without alteration", { timeout: 30_000 }, async () => {
  const { PhysicalWorktreeLease, worktreeLeaseIdentity } = await import("../src/worktree-lease.js");
  const { mkdirSync, writeFileSync, readFileSync } = await import("node:fs");
  const cwd = repository();
  const identity = await worktreeLeaseIdentity(cwd);
  const directory = await physicalOwnerDirectory(cwd);
  mkdirSync(join(identity.commonGitDirectory, "pi-worktree-owners"), { recursive: true });
  try {
    for (const contents of [undefined, "not-json", JSON.stringify({ nonce: "stale", pid: 99999999 })]) {
      mkdirSync(directory);
      if (contents !== undefined) writeFileSync(join(directory, "owner.json"), contents);
      await assert.rejects(PhysicalWorktreeLease.acquire(identity, { runId: "r", sessionId: "s", executionId: "e" }), /physical owner/);
      if (contents !== undefined) assert.equal(readFileSync(join(directory, "owner.json"), "utf8"), contents);
      rmSync(directory, { recursive: true });
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

void test("physical mismatched release never deletes replacement ownership", { timeout: 30_000 }, async () => {
  const { PhysicalWorktreeLease, worktreeLeaseIdentity } = await import("../src/worktree-lease.js");
  const { writeFileSync, readFileSync } = await import("node:fs");
  const cwd = repository();
  try {
    const owner = await PhysicalWorktreeLease.acquire(await worktreeLeaseIdentity(cwd), { runId: "r", sessionId: "s", executionId: "e" });
    const file = join(owner.directory, "owner.json");
    writeFileSync(file, '{"nonce":"replacement"}');
    await assert.rejects(owner.release(), /mismatched/);
    assert.equal(readFileSync(file, "utf8"), '{"nonce":"replacement"}');
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

void test("independent physical host processes admit exactly one owner", { timeout: 30_000 }, async () => {
  const { fork } = await import("node:child_process");
  const { writeFileSync } = await import("node:fs");
  const cwd = repository();
  const fixture = join(cwd, "host.mjs");
  writeFileSync(fixture, `import { PhysicalWorktreeLease, worktreeLeaseIdentity } from ${JSON.stringify(new URL("../src/worktree-lease.js", import.meta.url).href)}; let owner; try { owner = await PhysicalWorktreeLease.acquire(await worktreeLeaseIdentity(process.argv[2]), {runId:"r",sessionId:"s",executionId:String(process.pid)}); process.send({entered:true}); } catch { process.send({entered:false}); process.disconnect(); } process.on("message", async () => { await owner?.release(); process.disconnect(); });`);
  const children = [1, 2].map(() => fork(fixture, [cwd], { execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"] }));
  const closed = children.map((child) => new Promise<void>((resolve) => child.once("close", () => { resolve(); })));
  try {
    const outcomes = await Promise.all(children.map((child) => new Promise<{ entered: boolean }>((resolve, reject) => { child.once("message", (value) => { resolve(value as { entered: boolean }); }); child.once("error", reject); })));
    assert.equal(outcomes.filter(({ entered }) => entered).length, 1);
    for (const child of children) if (child.connected) child.send("release");
    await Promise.all(closed);
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.all(closed);
    rmSync(cwd, { recursive: true, force: true });
  }
});

async function nativeLease(cwd: string, script: string, args: import("../src/types.js").JsonValue = null, bridge: import("../src/types.js").WorkflowBridge = {}, controller = new AbortController()) {
  const { WorkflowOwnership } = await import("../src/ownership.js");
  const { runWorkflow, executeShellCommand } = await import("../src/execution.js");
  const ownership = new WorkflowOwnership(cwd, "native", "session", controller.signal, executeShellCommand);
  const execution = runWorkflow(script, args, ownership.decorate({ shell: (command, options, signal) => executeShellCommand(command, options, signal, cwd), ...bridge }), controller.signal);
  return { execution, ownership, controller };
}

void test("native lease live commands preserve nonzero output and reject realm/captured-method escapes", { timeout: 30_000 }, async () => {
  const cwd = repository();
  try {
    const { execution } = await nativeLease(cwd, `let captured; const result = await withWorktreeLease(args, async lease => { captured = lease.shell; let escape = false; try { lease.shell.constructor("return process")(); escape = true; } catch {} const result = await lease.shell("printf live; printf timeout >&2; exit 7"); return {path:lease.path, frozen:Object.isFrozen(lease), escape, result}; }); let closed; try { await captured("printf forbidden"); } catch(error) { closed = error.code; } return {result,closed};`, cwd);
    assert.deepEqual(await execution.result, { result: { path: canonicalPath(cwd), frozen: true, escape: false, result: { exitCode: 7, stdout: "live", stderr: "timeout" } }, closed: "WORKTREE_FAILED" });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

for (const command of ["kill -KILL $$", "sleep 5"]) {
  void test(`native lease cannot mask infrastructure taint with PASS: ${command}`, { timeout: 30_000 }, async () => {
    const cwd = repository();
    try {
      const { execution } = await nativeLease(cwd, `try { await withWorktreeLease(args.cwd, async lease => { try { await lease.shell(args.command, {timeoutMs:50}); } catch {} return "PASS"; }); } catch {} return "PASS";`, { cwd, command });
      await assert.rejects(execution.result, /signal|timed out/);
      const { existsSync } = await import("node:fs");
      assert.equal(existsSync(await physicalOwnerDirectory(cwd)), false, "proven cleanup can release even though the execution remains tainted");
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}

void test("native lease rejects nested ownership and roots outside launch scope before writers", { timeout: 30_000 }, async () => {
  const cwd = repository();
  const other = repository();
  try {
    for (const path of [cwd, other]) {
      const { execution } = await nativeLease(cwd, `await withWorktreeLease(args.cwd, async () => { try { await withWorktreeLease(args.path, async lease => lease.shell("touch forbidden")); } catch {} return "PASS"; }); return "PASS";`, { cwd, path });
      await assert.rejects(execution.result, /physical owner|launch root/);
    }
  } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(other, { recursive: true, force: true }); }
});

void test("normal return and callback throw both wait for scoped work before release", { timeout: 30_000 }, async () => {
  const cwd = repository();
  const { existsSync } = await import("node:fs");
  let disposed = false;
  try {
    const { execution } = await nativeLease(cwd, `await withWorktreeLease(args, async () => { await agent("tracked"); throw new Error("callback failed"); });`, cwd, {
      agent: async () => { assert.equal(existsSync(await physicalOwnerDirectory(cwd)), true); await new Promise((resolve) => setTimeout(resolve, 50)); disposed = true; return "done"; },
    });
    await assert.rejects(execution.result, /callback failed/);
    assert.equal(disposed, true);
    assert.equal(existsSync(await physicalOwnerDirectory(cwd)), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

void test("ticketed agent Bash command uses a private bound client and preserves product nonzero", { timeout: 30_000 }, async () => {
  const cwd = repository();
  const { spawn } = await import("node:child_process");
  try {
    const { execution } = await nativeLease(cwd, `return await withWorktreeLease(args, async lease => { const ticket = await lease.command("printf ticket; printf timeout >&2; exit 7", {timeoutMs:2000}); return await agent(ticket); });`, cwd, {
      agent: async (command) => new Promise((resolve, reject) => {
        const child = spawn("/bin/sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "", stderr = "";
        child.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
        child.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
        child.once("error", reject);
        child.once("close", (exitCode) => { resolve({ exitCode, stdout, stderr }); });
      }),
    });
    assert.deepEqual(await execution.result, { exitCode: 7, stdout: "ticket", stderr: "timeout" });
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

void test("real RunStore retry gap reacquires before a pending agent and live drift cannot replace frozen authority", { timeout: 30_000 }, async (t) => {
  const { writeFileSync, readFileSync, existsSync } = await import("node:fs");
  const { RunStore } = await import("../src/index.js");
  const { listRunIds } = await import("../src/persistence.js");
  const { PhysicalWorktreeLease, worktreeLeaseIdentity } = await import("../src/worktree-lease.js");
  const { testTransport } = await import("./test-transport.js");
  const cwd = repository();
  const home = mkdtempSync(join(tmpdir(), "lease-replay-home-"));
  const spec = join(cwd, "spec");
  writeFileSync(spec, "approved-v1");
  let agents = 0, liveGuards = 0, gap = true;
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "agent"] }), home, async () => {}, testTransport(async () => ({
    sessionId: `pending-${String(++agents)}`, sessionFile: join(home, `session-${String(agents)}.jsonl`), messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {},
  })));
  registerWorkflowExtension({ version: "1.0.0", headline: "Lease retry fixture", functions: {
    leaseProbeGuard: { description: "Fresh guard", input: { type: "object" }, output: { type: "string" }, run: async (input, context) => context.withWorktreeLease(cwd, async (lease) => {
      liveGuards += 1;
      const live = await lease.shell("cat spec");
      if (live.stdout !== input.expected) throw new Error("live spec drift");
      return live.stdout;
    }) },
    leaseControlled: { description: "Preserve original authority", input: { type: "object" }, output: { type: "string" }, run: async (_input, context) => {
      const frozen = await context.shell("cat spec");
      await context.invoke("leaseProbeGuard", { expected: frozen.stdout });
      return context.withWorktreeLease(cwd, async (lease) => {
        const live = await lease.shell("cat spec");
        if (live.stdout !== frozen.stdout) throw new Error("live spec drift");
        await context.agent("pending writer");
        return frozen.stdout;
      });
    } },
  } });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- saved prototype method is invoked with its original store receiver below.
  const complete = RunStore.prototype.complete;
  t.mock.method(RunStore.prototype, "complete", async function(this: InstanceType<typeof RunStore>, path: string, value: import("../src/types.js").JsonValue): Promise<void> {
    if (gap && path.includes("leaseProbeGuard")) { gap = false; assert.equal(existsSync(await physicalOwnerDirectory(cwd)), false); throw new Error("after-release persistence gap"); }
    return complete.call(this, path, value);
  });
  const workflow = tools.find(({ name }) => name === "workflow"), retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(workflow && retry);
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "replay" } };
  const retryFailed = async (source: string, pattern: RegExp) => {
    const before = new Set(await listRunIds(cwd, "replay", home));
    await assert.rejects(retry.execute("retry", { runId: source, foreground: true }, new AbortController().signal, undefined, context), pattern);
    const id = (await listRunIds(cwd, "replay", home)).find((id) => !before.has(id));
    assert.ok(id);
    return id;
  };
  try {
    await assert.rejects(workflow.execute("start", { name: "lease-gap", script: "return await leaseControlled({});", foreground: true }, new AbortController().signal, undefined, context), /persistence gap/);
    const [original] = await listRunIds(cwd, "replay", home);
    assert.ok(original);
    assert.equal(agents, 0);
    const holder = await PhysicalWorktreeLease.acquire(await worktreeLeaseIdentity(cwd), { runId: "competitor", sessionId: "same", executionId: "other" });
    let blocked: string;
    try { blocked = await retryFailed(original, /physical owner/); assert.equal(agents, 0); assert.equal(liveGuards, 1); }
    finally { await holder.release(); }
    writeFileSync(spec, "changed-v2");
    const drifted = await retryFailed(blocked, /live spec drift/);
    assert.equal(agents, 0);
    assert.equal(liveGuards, 2);
    const source = new RunStore(cwd, "replay", original, home);
    const shell = (await source.replayableOperations()).find(({ path }) => path.startsWith("shell/"));
    assert.ok(shell);
    assert.equal(((await source.replay(shell.path))?.value as { stdout: string }).stdout, "approved-v1");
    assert.equal(readFileSync(spec, "utf8"), "changed-v2", "recovery must not refreeze the changed input");
    writeFileSync(spec, "approved-v1");
    await retry.execute("retry-success", { runId: drifted, foreground: true }, new AbortController().signal, undefined, context);
    assert.equal(agents, 1);
    assert.equal(liveGuards, 3);
  } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

void test("production checkpoint retains its lease and workflow_stop drains before acknowledging cleanup", { timeout: 30_000 }, async () => {
  const { existsSync } = await import("node:fs");
  const { RunStore } = await import("../src/persistence.js");
  const cwd = repository(), home = mkdtempSync(join(tmpdir(), "lease-stop-home-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { runId?: string } }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, undefined, undefined, home);
  const workflow = tools.find(({ name }) => name === "workflow"), stop = tools.find(({ name }) => name === "workflow_stop");
  assert.ok(workflow && stop);
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "stop" } };
  try {
    const launched = await workflow.execute("start", { name: "lease-stop", script: "await withWorktreeLease(args, async lease => { await lease.shell('printf held'); await checkpoint({name:'hold',prompt:'hold',context:null}); });", args: cwd }, new AbortController().signal, undefined, context);
    const id = launched.details.runId; assert.ok(id);
    const store = new RunStore(cwd, "stop", id, home);
    const deadline = Date.now() + 5000;
    while ((await store.load()).run.state !== "awaiting_input") { assert.ok(Date.now() < deadline); await new Promise((resolve) => setTimeout(resolve, 10)); }
    assert.equal(existsSync(join(await physicalOwnerDirectory(cwd), "owner.json")), true);
    await stop.execute("stop", { runId: id }, new AbortController().signal, undefined, context);
    assert.equal(existsSync(await physicalOwnerDirectory(cwd)), false);
  } finally { rmSync(cwd, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

for (const leased of [true, false]) {
  void test(`production checkpoint cancellation during persistence owns rejection: ${leased ? "worktree lease" : "plain"}`, { timeout: 15_000 }, async (t) => {
    const { existsSync } = await import("node:fs");
    const { RunStore, WorkflowError } = await import("../src/index.js");
    const cwd = repository(), home = mkdtempSync(join(tmpdir(), "checkpoint-stop-race-"));
    const barrier = () => {
      let release!: () => void;
      const reached = new Promise<void>((resolve) => { release = resolve; });
      return { reached, release };
    };
    const persistenceBlocked = barrier(), releasePersistence = barrier(), aborted = barrier();
    const checkpointSettled = barrier(), releaseCallback = barrier(), callbackSettled = barrier();
    let checkpointError: unknown, checkpointCalls = 0, acknowledged = false;
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { runId?: string; state?: string; stopped?: boolean } }> }> = [];
    workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, undefined, undefined, home);
    const functionName = leased ? "checkpointStopLeased" : "checkpointStopPlain";
    registerWorkflowExtension({ version: "1.0.0", headline: "Checkpoint cancellation fixture", functions: { [functionName]: {
      description: "Observe checkpoint cancellation before scoped cleanup", input: { type: "object" }, output: { type: "boolean" },
      run: async (_input, context) => {
        context.run.signal.addEventListener("abort", aborted.release, { once: true });
        try { return await context.checkpoint({ name: "hold", prompt: "hold", context: null }); }
        catch (error) { checkpointError = error; throw error; }
        finally {
          checkpointSettled.release();
          await releaseCallback.reached;
          callbackSettled.release();
        }
      },
    } } });
    // Use the bundled host's exported RunStore, not a separate persistence-module instance.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- original receiver is restored with call below.
    const awaitCheckpoint = RunStore.prototype.awaitCheckpoint;
    t.mock.method(RunStore.prototype, "awaitCheckpoint", async function(this: InstanceType<typeof RunStore>, checkpoint: Parameters<InstanceType<typeof RunStore>["awaitCheckpoint"]>[0]) {
      const answer = await awaitCheckpoint.call(this, checkpoint);
      if (this.cwd === cwd && ++checkpointCalls === 2) {
        // The real second journal read has run; checkpointBridge has installed its abort listener,
        // but cannot adopt the decision promise until this I/O result is returned.
        persistenceBlocked.release();
        await releasePersistence.reached;
      }
      return answer;
    });
    const workflow = tools.find(({ name }) => name === "workflow"), stop = tools.find(({ name }) => name === "workflow_stop");
    assert.ok(workflow && stop);
    const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "checkpoint-race" } };
    let stopping: Promise<{ details: { runId?: string; state?: string; stopped?: boolean } }> | undefined;
    try {
      const script = leased ? `return await withWorktreeLease(args, async () => ${functionName}({}));` : `return await ${functionName}({});`;
      const launched = await workflow.execute("start", { name: "checkpoint-stop-race", script, args: cwd }, new AbortController().signal, undefined, context);
      const id = launched.details.runId; assert.ok(id);
      const store = new RunStore(cwd, "checkpoint-race", id, home);
      await persistenceBlocked.reached;
      assert.equal(checkpointCalls, 2);
      assert.equal((await store.load()).run.state, "awaiting_input");
      const owner = join(await physicalOwnerDirectory(cwd), "owner.json");
      assert.equal(existsSync(owner), leased);
      stopping = stop.execute("stop", { runId: id }, new AbortController().signal, undefined, context);
      // Own the control-tool promise immediately too; only checkpointBridge's decision is under test.
      void stopping.then(() => { acknowledged = true; }, () => undefined);
      await aborted.reached;
      await new Promise((resolve) => setTimeout(resolve, 20));
      if (leased) {
        assert.equal(acknowledged, false, "stop must wait while the scoped checkpoint is blocked");
        assert.equal(existsSync(owner), true);
      }
      releasePersistence.release();
      await checkpointSettled.reached;
      assert.ok(checkpointError instanceof WorkflowError);
      assert.equal(checkpointError.code, "CANCELLED", "the original decision must still reject, not return success");
      if (leased) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(acknowledged, false, "adopting the decision is not scope quiescence");
        assert.equal(existsSync(owner), true, "the callback is still doing tracked cleanup");
      }
      releaseCallback.release();
      await callbackSettled.reached;
      const stopped = await stopping;
      assert.equal(stopped.details.stopped, true);
      assert.equal(stopped.details.state, "stopped");
      assert.equal(existsSync(await physicalOwnerDirectory(cwd)), false);
      const deadline = Date.now() + 5000;
      while ((await store.load()).run.error?.code !== "CANCELLED") {
        assert.ok(Date.now() < deadline, "cancellation must reach persisted run failure");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.equal((await store.load()).run.state, "stopped");
      assert.equal(await store.replay("checkpoint/hold"), undefined, "cancellation is not a completed checkpoint decision");
    } finally {
      releasePersistence.release();
      releaseCallback.release();
      await stopping?.catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
}

function barrier() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release };
}

// A test-owned bundle exposes existing internal classes for fault observation only.
// The production host, registry, store and lifecycle still share one actual module graph.
async function admissionHost(directory: string) {
  const { build } = await import("esbuild");
  const built = await build({
    stdin: { contents: 'export {default, registerWorkflowExtension} from "./index.ts"; export {RunStore,listRunIds} from "./persistence.ts"; export {RunLifecycle} from "./host-runtime.ts";', resolveDir: fileURLToPath(new URL("../../src/", import.meta.url)), loader: "ts" },
    bundle: true, platform: "node", format: "esm", write: false,
    plugins: [{ name: "absolute-external-packages", setup(builder) {
      builder.onResolve({ filter: /^[a-z@]/ }, (args) => ({ path: import.meta.resolve(args.path), external: true }));
    } }],
  });
  const file = join(directory, "host-observation.mjs");
  const output = built.outputFiles[0];
  assert.ok(output);
  writeFileSync(file, output.contents);
  return await import(file) as typeof import("../src/index.js") & { RunLifecycle: typeof import("../src/host-runtime.js").RunLifecycle; listRunIds: typeof import("../src/persistence.js").listRunIds };
}

for (const mode of ["native", "registered"] as const) for (const recovery of [false, true]) for (const outcome of (mode === "registered" ? ["worker failure", "authored success"] : ["worker failure"])) {
  void test(`production managed admission cancels before terminal persistence: ${mode}, ${recovery ? "cold recovery" : "launch"}, ${outcome}`, { timeout: 20_000 }, async (t) => {
    const cwd = repository(), home = mkdtempSync(join(tmpdir(), "admission-host-"));
    const fixtureId = `admission_${mode}_${recovery ? "recovery" : "launch"}_${outcome === "authored success" ? "success" : "failure"}`;
    const names = { seed: `${fixtureId}Seed`, hold: `${fixtureId}Hold`, blocked: `${fixtureId}Blocked`, registered: `${fixtureId}Registered` };
    const host = await admissionHost(home);
    const gate = barrier(), failWorker = barrier();
    const state = recovery ? "awaiting_input" : "paused";
    let lifecycle: InstanceType<typeof host.RunLifecycle> | undefined;
    let admissionSignal: AbortSignal | undefined;
    let seed = recovery;
    // eslint-disable-next-line @typescript-eslint/unbound-method -- invoked below with the original lifecycle receiver.
    const enter = host.RunLifecycle.prototype.enter;
    const observeLifecycle = (current: InstanceType<typeof host.RunLifecycle>, signal?: AbortSignal) => {
      lifecycle = current;
      if (current.state === state) { admissionSignal = signal; gate.release(); }
    };
    t.mock.method(host.RunLifecycle.prototype, "enter", async function(this: InstanceType<typeof host.RunLifecycle>, signal?: AbortSignal) {
      observeLifecycle(this, signal);
      return enter.call(this, signal);
    });
    const hold = async () => {
      assert.ok(lifecycle);
      if (state === "paused") await lifecycle.pause(); else await lifecycle.enterAwaitingInput();
      return true;
    };
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { runId?: string } }> }> = [];
    host.default(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, undefined, undefined, home);
    host.registerWorkflowExtension({ version: "1.0.0", headline: "Actual host admission fault fixture", functions: {
      [names.seed]: { description: "Seed cold recovery", input: { type: "object" }, output: { type: "boolean" }, run: async () => { if (seed) { seed = false; throw new Error("seed failure"); } return true; } },
      [names.hold]: { description: "Persist a lifecycle barrier", input: { type: "object" }, output: { type: "boolean" }, run: hold },
      [names.blocked]: { description: "Wait for actual host resolver admission", input: { type: "object" }, output: { type: "boolean" }, run: async () => { await gate.reached; await failWorker.reached; return true; } },
      [names.registered]: { description: "Enter a registered managed lease", input: { type: "object" }, output: { type: "string" }, run: async (_input, ctx) => ctx.withWorktree("managed", async (tree) => {
        await hold();
        const pending = ctx.withWorktreeLease(tree.path, async () => "forbidden writer");
        if (outcome === "authored success") { void pending.catch(() => undefined); await gate.reached; await failWorker.reached; return "PASS"; }
        return pending;
      }) },
    } });
    const workflow = tools.find(({ name }) => name === "workflow"), retry = tools.find(({ name }) => name === "workflow_retry");
    assert.ok(workflow && retry);
    const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "admission-host" } };
    const body = mode === "native" ? `return await withWorktree("managed", async tree => { await ${names.hold}({}); const pending=withWorktreeLease(tree.path,async()=>"forbidden writer"); void pending.catch(()=>{}); await ${names.blocked}({}); throw new Error("original worker diagnostic"); });` : `const pending=${names.registered}({}); void pending.catch(()=>{}); await ${names.blocked}({}); throw new Error("original worker diagnostic");`;
    const script = `await ${names.seed}({}); ${outcome === "authored success" ? `return await ${names.registered}({});` : body}`;
    const controller = new AbortController();
    let running: Promise<unknown> | undefined;
    try {
      if (recovery) await assert.rejects(workflow.execute("seed", { name: "admission", script, foreground: true }, controller.signal, undefined, context), /seed failure/);
      const [source] = await host.listRunIds(cwd, "admission-host", home);
      running = recovery ? retry.execute("retry", { runId: source, foreground: true }, controller.signal, undefined, context) : workflow.execute("start", { name: "admission", script, foreground: true }, controller.signal, undefined, context);
      void running.catch(() => undefined);
      await gate.reached;
      const ids = await host.listRunIds(cwd, "admission-host", home);
      const active = await Promise.all(ids.map((id) => new host.RunStore(cwd, "admission-host", id, home).load()));
      assert.ok(active.some(({ run }) => run.state === state), "the real RunStore must persist the barrier before worker failure");
      assert.ok(admissionSignal instanceof AbortSignal, "the production adapter must forward the admission signal");
      assert.equal(admissionSignal.aborted, false);
      failWorker.release();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await assert.rejects(Promise.race([running, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error("host finalization deadlock")); }, 3000); })]), outcome === "authored success" ? { code: "CANCELLED" } : /original worker diagnostic/);
      } finally { if (timer) clearTimeout(timer); }
      assert.equal(admissionSignal.aborted, true);
      assert.ok(lifecycle);
      assert.equal(lifecycle.state, outcome === "authored success" && !recovery ? "stopped" : "failed");
      for (const id of ids) {
        const store = new host.RunStore(cwd, "admission-host", id, home);
        for (const tree of await store.worktrees()) assert.equal(existsSync(await physicalOwnerDirectory(tree.path)), false);
      }
    } finally {
      failWorker.release();
      controller.abort();
      await running?.catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
}

for (const state of ["paused", "awaiting_input"] as const) {
  void test(`finalization cancels managed admission at the real ${state} lifecycle gate`, { timeout: 10_000 }, async () => {
    const { WorkflowOwnership } = await import("../src/ownership.js");
    const { RunLifecycle } = await import("../src/host-runtime.js");
    const { executeShellCommand } = await import("../src/execution.js");
    const cwd = repository();
    let reached!: () => void;
    const blocked = new Promise<void>((resolve) => { reached = resolve; });
    const lifecycle = new RunLifecycle();
    if (state === "paused") await lifecycle.pause(); else await lifecycle.enterAwaitingInput();
    const controller = new AbortController();
    const ownership = new WorkflowOwnership(cwd, "finalizing", "s", controller.signal, executeShellCommand, async (_owner: string, signal?: AbortSignal) => {
      reached();
      await lifecycle.enter(signal);
      await lifecycle.leave();
      return { path: cwd, branch: "fixture" };
    });
    const admission = ownership.enter(cwd, "managed", controller.signal);
    const rejected = assert.rejects(admission, { code: "CANCELLED" });
    try {
      await blocked;
      const finalization = ownership.finalize();
      // This bound detects the wait cycle; it is not a supervisor performance claim.
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await assert.rejects(Promise.race([finalization, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new Error("finalizer deadlocked on managed admission")); }, 1500); })]), { code: "CANCELLED" });
      } finally { if (timer) clearTimeout(timer); }
      await rejected;
      assert.equal(controller.signal.aborted, false, "only the private admission controller must be cancelled");
      assert.equal(lifecycle.state, state, "terminal notification is not needed to wake admission");
      assert.equal(existsSync(await physicalOwnerDirectory(cwd)), false);
      await assert.rejects(ownership.finalize(), { code: "CANCELLED" });
    } finally {
      await lifecycle.terminal("failed");
      await rejected;
      await ownership.finalize().catch(() => undefined);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

void test("finalization owns a delayed physical acquisition receipt until proven release", { timeout: 10_000 }, async (t) => {
  const { WorkflowOwnership } = await import("../src/ownership.js");
  const { PhysicalWorktreeLease, worktreeLeaseIdentity } = await import("../src/worktree-lease.js");
  const { executeShellCommand } = await import("../src/execution.js");
  const cwd = repository(), acquired = barrier(), deliverReceipt = barrier();
  const controller = new AbortController();
  const ownership = new WorkflowOwnership(cwd, "delayed", "s", controller.signal, executeShellCommand);
  const acquire = PhysicalWorktreeLease.acquire.bind(PhysicalWorktreeLease);
  let delay = true;
  t.mock.method(PhysicalWorktreeLease, "acquire", async (...args: Parameters<typeof acquire>) => {
    const owner = await acquire(...args);
    if (delay) { delay = false; acquired.release(); await deliverReceipt.reached; }
    return owner;
  });
  const admission = ownership.enter(cwd, undefined, controller.signal);
  const rejected = assert.rejects(admission, { code: "CANCELLED" });
  let finalized: Promise<void> | undefined;
  try {
    await acquired.reached;
    finalized = ownership.finalize();
    const failure = assert.rejects(finalized, { code: "CANCELLED" });
    assert.equal(ownership.finalize(), finalized, "finalization is memoized");
    assert.equal(existsSync(await physicalOwnerDirectory(cwd)), true, "an undelivered receipt must not be abandoned");
    deliverReceipt.release();
    await rejected;
    await failure;
    assert.equal(existsSync(await physicalOwnerDirectory(cwd)), false);
    const next = await PhysicalWorktreeLease.acquire(await worktreeLeaseIdentity(cwd), { runId: "next", sessionId: "s", executionId: "next" });
    await next.release();
  } finally { deliverReceipt.release(); await rejected; await finalized?.catch(() => undefined); rmSync(cwd, { recursive: true, force: true }); }
});

void test("admission-only finalization cancellation still waits for previously tracked scope cleanup", { timeout: 10_000 }, async () => {
  const { WorkflowOwnership } = await import("../src/ownership.js");
  const { RunLifecycle } = await import("../src/host-runtime.js");
  const { executeShellCommand } = await import("../src/execution.js");
  const cwd = repository(), gate = barrier(), started = barrier(), drained = barrier();
  const controller = new AbortController(), lifecycle = new RunLifecycle();
  const ownership = new WorkflowOwnership(cwd, "draining", "s", controller.signal, executeShellCommand, async (_owner, signal) => {
    gate.release(); await lifecycle.enter(signal); await lifecycle.leave(); return { path: cwd, branch: "fixture" };
  });
  const prior = await ownership.enter(cwd, undefined, controller.signal);
  const pending = ownership.associate(prior.scope, async () => { started.release(); await drained.reached; });
  await started.reached;
  await lifecycle.pause();
  const admission = ownership.enter(cwd, "managed", controller.signal);
  const rejected = assert.rejects(admission, { code: "CANCELLED" });
  let finalization: Promise<void> | undefined;
  try {
    await gate.reached;
    finalization = ownership.finalize();
    const failure = assert.rejects(finalization, { code: "CANCELLED" });
    await rejected;
    assert.equal(existsSync(await physicalOwnerDirectory(cwd)), true, "pending scoped cleanup still holds the exact owner");
    assert.equal(controller.signal.aborted, false);
    drained.release();
    await pending;
    await failure;
    assert.equal(existsSync(await physicalOwnerDirectory(cwd)), false);
  } finally { drained.release(); await lifecycle.terminal("failed"); await pending; await rejected; await finalization?.catch(() => undefined); rmSync(cwd, { recursive: true, force: true }); }
});

void test("persistent handles keep lease affinity and cannot be used after closure", { timeout: 30_000 }, async () => {
  const cwd = repository();
  try {
    let agents = 0;
    const { execution } = await nativeLease(cwd, `let handle; await withWorktreeLease(args, async () => { handle = agent.create({name:'owned'}); await handle.send('first'); }); let rejected; try { await handle.send('outside'); } catch(error) { rejected = error.code; } return rejected;`, cwd, { agent: async () => { agents += 1; return "done"; } });
    assert.equal(await execution.result, "INVALID_METADATA");
    assert.equal(agents, 1);
  } finally { rmSync(cwd, { recursive: true, force: true }); }
});

void test("completed leased function replay is historical and performs no fresh physical work", { timeout: 30_000 }, async () => {
  const { listRunIds } = await import("../src/persistence.js");
  const { PhysicalWorktreeLease, worktreeLeaseIdentity } = await import("../src/worktree-lease.js");
  const cwd = repository(), home = mkdtempSync(join(tmpdir(), "lease-history-home-"));
  let entries = 0;
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, undefined, undefined, home);
  registerWorkflowExtension({version:"1.0.0",headline:"Historical lease fixture",functions:{ leaseHistorical:{ description:"Historical completion", input:{type:"object"},output:{type:"string"},run: async (_input,ctx)=>ctx.withWorktreeLease(cwd,async lease=>{entries+=1;return (await lease.shell("printf historical")).stdout;}) } }});
  const workflow=tools.find(({name})=>name==="workflow"), retry=tools.find(({name})=>name==="workflow_retry"); assert.ok(workflow && retry);
  const context={cwd,hasUI:false,model:{provider:"openai",id:"gpt"},sessionManager:{getSessionId:()=>"historical"}};
  try {
    await assert.rejects(workflow.execute("start",{name:"historical",script:'await leaseHistorical({}); throw new Error("after completion");',foreground:true},new AbortController().signal,undefined,context),/after completion/);
    const [id]=await listRunIds(cwd,"historical",home); assert.ok(id);
    const holder=await PhysicalWorktreeLease.acquire(await worktreeLeaseIdentity(cwd),{runId:"holder",sessionId:"same",executionId:"other"});
    try { await assert.rejects(retry.execute("retry",{runId:id,foreground:true},new AbortController().signal,undefined,context),/after completion/); await holder.verify(); assert.equal(entries,1); }
    finally { await holder.release(); }
  } finally { rmSync(cwd,{recursive:true,force:true});rmSync(home,{recursive:true,force:true}); }
});
