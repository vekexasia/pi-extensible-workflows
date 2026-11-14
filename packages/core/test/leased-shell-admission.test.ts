import { physicalOwnerDirectory } from "./worktree-owner-fixture.js";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workflowExtension, { registerWorkflowExtension, RunLifecycle, RunStore, WorkflowError } from "../src/index.js";
import { contextualWorkflowAction, testExtensionApi } from "./support.js";

const barrier = () => {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release };
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

void test("production leased recorded shell cannot self-deadlock pause behind phase persistence", { timeout: 15_000 }, async (t) => {
  const home = mkdtempSync(join(tmpdir(), "leased-shell-admission-")), cwd = join(home, "repo");
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-qm", "initial"]);
  const marker = join(home, "forbidden-command"), phaseBlocked = barrier(), releasePhase = barrier();
  const verifiedShell = barrier(), shellSettled = barrier(), releaseCallback = barrier();
  const callbackSettled = barrier(), shellWaiting = barrier();
  let shellAdmissionSignal: AbortSignal | undefined;
  let phaseIssued = false, heldPhase = false, admissions = 0, shellError: unknown;
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details: { runId?: string; stopped?: boolean } }> }> = [];
  let command: ((args: string, context: unknown) => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand(name: string, options: unknown) { if (name === "workflow") command = (options as { handler: NonNullable<typeof command> }).handler; }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, undefined, undefined, home);
  registerWorkflowExtension({ version: "1.0.0", headline: "Leased shell admission fixture", functions: { leasedAdmissionProbe: {
    description: "Start a recorded shell after an asynchronous phase", input: { type: "object" }, output: { type: "number" },
    run: async (_input, context) => context.withWorktreeLease(cwd, async () => {
      try {
        context.phase("verify"); phaseIssued = true;
        return (await context.shell(`${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)},"forbidden")`)}`, { timeoutMs: 100 })).exitCode ?? -1;
      } catch (error) { shellError = error; throw error; }
      finally { shellSettled.release(); await releaseCallback.reached; callbackSettled.release(); }
    }),
  } } });
  // The production bundled host's actual store/class, not a map journal or a separate persistence module.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- original receiver supplied below.
  const updateState = RunStore.prototype.updateState;
  t.mock.method(RunStore.prototype, "updateState", async function(this: RunStore, update: Parameters<RunStore["updateState"]>[0]) {
    const run = await updateState.call(this, update);
    if (this.cwd === cwd && run.phase === "verify" && !heldPhase) {
      heldPhase = true; phaseBlocked.release(); await releasePhase.reached;
    }
    return run;
  });
  // eslint-disable-next-line @typescript-eslint/unbound-method -- original receiver supplied below.
  const enter = RunLifecycle.prototype.enter;
  t.mock.method(RunLifecycle.prototype, "enter", async function(this: RunLifecycle, signal?: AbortSignal) {
    if (heldPhase && (this.state === "pausing" || this.state === "paused")) { shellAdmissionSignal = signal; shellWaiting.release(); }
    await enter.call(this, signal); admissions += 1;
  });
  const readFile = fsPromises.readFile.bind(fsPromises);
  t.mock.method(fsPromises, "readFile", (async (...args: Parameters<typeof fsPromises.readFile>) => {
    const result = await readFile(...args);
    if (phaseIssued && typeof args[0] === "string" && args[0].includes("/pi-worktree-owners/") && args[0].endsWith("/owner.json")) verifiedShell.release();
    return result;
  }) as typeof fsPromises.readFile);
  syncBuiltinESMExports();
  const workflow = tools.find(({ name }) => name === "workflow"), stop = tools.find(({ name }) => name === "workflow_stop");
  assert.ok(workflow && stop && command);
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "admission" }, ui: { notify() {} } };
  let id: string | undefined, stopping: ReturnType<typeof stop.execute> | undefined;
  try {
    const launched = await workflow.execute("start", { name: "leased-admission", script: "return await leasedAdmissionProbe({});" }, new AbortController().signal, undefined, context);
    id = launched.details.runId; assert.ok(id);
    const store = new RunStore(cwd, "admission", id, home);
    await phaseBlocked.reached; await verifiedShell.reached;
    // After the actual owner read, only promise continuations remain before shellForRun waits for phase.
    await turn();
    t.diagnostic(`successful lifecycle admissions before pause: ${String(admissions)}`);
    await contextualWorkflowAction(command, context, id, "Pause");
    assert.equal((await store.load()).run.state, "pausing");
    releasePhase.release();
    const deadline = Date.now() + 2000;
    while ((await store.load()).run.state !== "paused" && Date.now() < deadline) await turn();
    assert.equal((await store.load()).run.state, "paused", "phase must drain to paused without resume/stop or a shell timeout");
    await shellWaiting.reached;
    assert.ok(shellAdmissionSignal instanceof AbortSignal); assert.equal(shellAdmissionSignal.aborted, false);
    assert.equal(admissions, 1, "only phase entered; recorded shell waits for its existing bridge's sole admission");
    assert.equal(existsSync(marker), false);
    const owner = join(await physicalOwnerDirectory(cwd), "owner.json");
    assert.equal(existsSync(owner), true, "successfully paused scope intentionally retains ownership");
    let acknowledged = false;
    stopping = stop.execute("stop", { runId: id }, new AbortController().signal, undefined, context);
    void stopping.then(() => { acknowledged = true; }, () => undefined);
    await shellSettled.reached; await turn();
    assert.ok(shellError instanceof WorkflowError); assert.equal(shellError.code, "CANCELLED");
    assert.equal(shellAdmissionSignal.aborted, true, "the sole recorded-shell admission receives the combined scope signal");
    assert.equal(acknowledged, false, "stop must still drain callback cleanup");
    assert.equal(existsSync(owner), true);
    releaseCallback.release(); await callbackSettled.reached;
    assert.equal((await stopping).details.stopped, true);
    assert.equal(existsSync(await physicalOwnerDirectory(cwd)), false);
    assert.equal(existsSync(marker), false);
    assert.equal((await store.replayableOperations()).some(({ path }) => path.startsWith("shell/")), false, "unadmitted shell must not become a journaled execution");
  } finally {
    releasePhase.release(); releaseCallback.release();
    if (id && !stopping) { stopping = stop.execute("cleanup-stop", { runId: id }, new AbortController().signal, undefined, context); void stopping.catch(() => undefined); }
    await stopping?.catch(() => undefined);
    t.mock.restoreAll(); syncBuiltinESMExports();
    rmSync(home, { recursive: true, force: true });
  }
});

for (const mode of ["live", "broker"] as const) {
  void test(`${mode} command keeps its own admission and scope-abort-aware paused waiter`, { timeout: 10_000 }, async () => {
    const { WorkflowOwnership } = await import("../src/ownership.js");
    const { executeShellCommand } = await import("../src/execution.js");
    const { spawn } = await import("node:child_process");
    const home = mkdtempSync(join(tmpdir(), "leased-live-admission-")), marker = join(home, "forbidden");
    execFileSync("git", ["init", "-q", home]);
    const lifecycle = new RunLifecycle(), attempted = barrier(), controller = new AbortController();
    const ownership = new WorkflowOwnership(home, "paused", "s", controller.signal, executeShellCommand, undefined, {
      enter: (signal) => { attempted.release(); return lifecycle.enter(signal); },
      leave: () => lifecycle.leave(),
    });
    const reference = await ownership.enter(home, undefined, controller.signal);
    let pending: Promise<unknown> | undefined;
    try {
      await lifecycle.pause(); assert.equal(lifecycle.state, "paused");
      const command = `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`require("node:fs").writeFileSync(${JSON.stringify(marker)},"forbidden")`)}`;
      if (mode === "live") pending = ownership.shell(reference.scope, command, { timeoutMs: 100 });
      else {
        const ticket = await ownership.command(reference.scope, command, { timeoutMs: 100, reuse: "sequential" });
        const child = spawn("/bin/sh", ["-c", ticket], { stdio: "ignore" });
        pending = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      }
      void pending.catch(() => undefined);
      await attempted.reached; await turn();
      assert.equal(existsSync(marker), false, "live/ticket command must not bypass its gate");
      assert.equal(existsSync(join(await physicalOwnerDirectory(home), "owner.json")), true);
      await assert.rejects(ownership.leave(reference.scope), (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
      if (mode === "live") await assert.rejects(pending, (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
      else assert.notEqual(await pending, 0);
      assert.equal(lifecycle.state, "paused", "scope cancellation does not require resume/stop");
      assert.equal(existsSync(marker), false);
      assert.equal(existsSync(await physicalOwnerDirectory(home)), false);
    } finally {
      controller.abort(); await pending?.catch(() => undefined); await ownership.finalize().catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  });
}
