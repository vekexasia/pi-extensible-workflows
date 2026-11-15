import assert from "node:assert/strict";
import childProcess, { ChildProcess, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { syncBuiltinESMExports } from "node:module";
import { join } from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, message: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    assert.ok(Date.now() < deadline, message);
    await pause(20);
  }
}
function processes(): Array<{ pid: number; group: number; state: string; args: string }> {
  return execFileSync("ps", ["-axo", "pid=,pgid=,stat=,args="], { encoding: "utf8" }).trim().split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), group: Number(match[2]), state: match[3] ?? "", args: match[4] ?? "" }] : [];
  });
}

function shellContractCommand(fixture: string): string {
  return `"${process.execPath}" "${fixture}"`;
}
void test("executeShellCommand preserves nonzero, environment and UTF-8 output contracts", { timeout: 30_000 }, async () => {
  const { executeShellCommand } = await import("../src/execution.js");
  const directory = mkdtempSync(join(tmpdir(), "shell-contract-"));
  const fixture = join(directory, "contract.cjs");
  writeFileSync(fixture, `process.stdout.write("☃"); process.stderr.write(process.env.OWNED_PROCESS_TEST); process.exit(7);`);
  try {
    const value = await executeShellCommand(shellContractCommand(fixture), { env: { OWNED_PROCESS_TEST: "timeout is product evidence" } }, new AbortController().signal);
    assert.deepEqual(value, { exitCode: 7, stdout: "☃", stderr: "timeout is product evidence" });
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
void test("compatibility test uses a portable Node fixture command under Windows dispatch", { timeout: 30_000 }, async (t) => {
  const { executeShellCommand } = await import("../src/execution.js");
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  assert.ok(original);
  const child = new ChildProcess();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperties(child, { stdout: { value: stdout }, stderr: { value: stderr } });
  const launch = t.mock.method(childProcess, "spawn", (command: string) => {
    assert.ok(command.startsWith(`"${process.execPath}" `), "Windows contract must launch Node, not POSIX printf/env syntax");
    queueMicrotask(() => { child.emit("close", 7); });
    return child;
  });
  syncBuiltinESMExports();
  Object.defineProperty(process, "platform", { ...original, value: "win32" });
  try {
    assert.equal((await executeShellCommand(shellContractCommand("fixture.cjs"), {}, new AbortController().signal)).exitCode, 7);
  } finally {
    stdout.destroy(); stderr.destroy();
    Object.defineProperty(process, "platform", original);
    launch.mock.restore(); syncBuiltinESMExports();
  }
});

void test("executeShellCommand reports launch failure after its supervisor drains", { timeout: 30_000 }, async () => {
  const { executeShellCommand } = await import("../src/execution.js");
  const directory = mkdtempSync(join(tmpdir(), "owned-process-launch-"));
  try {
    await assert.rejects(executeShellCommand("printf must-not-run", {}, new AbortController().signal, join(directory, "missing")), (error: unknown) => error instanceof Error && "code" in error && error.code === "SHELL_FAILED");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

for (const platform of ["win32", "freebsd"]) {
  for (const cancel of [false, true]) {
    void test(`${platform === "win32" ? "Windows" : "FreeBSD"} dispatch retains legacy ordinary shell ${cancel ? "cancellation" : "results"} while owned commands fail closed`, { timeout: 30_000 }, async (t) => {
      const { executeShellCommand } = await import("../src/execution.js");
      const { executeOwnedCommand } = await import("../src/owned-process.js");
      const original = Object.getOwnPropertyDescriptor(process, "platform");
      assert.ok(original);
      const child = new ChildProcess();
      const stdout = new PassThrough();
      const stderr = new PassThrough();
      Object.defineProperties(child, { pid: { value: 12345 }, stdout: { value: stdout }, stderr: { value: stderr } });
      const calls: unknown[][] = [];
      const kills: unknown[][] = [];
      const kill = t.mock.method(process, "kill", (pid: number, signal?: number | NodeJS.Signals) => { kills.push([pid, signal]); return true; });
      const spawn = t.mock.method(childProcess, "spawn", (...args: unknown[]) => {
        calls.push(args);
        return args[0] === "taskkill" ? new ChildProcess() : child;
      });
      syncBuiltinESMExports();
      Object.defineProperty(process, "platform", { ...original, value: platform });
      try {
        await assert.rejects(executeOwnedCommand("must-not-spawn", {}, new AbortController().signal, process.cwd(), () => {}), /requires macOS or Linux/);
        assert.equal(calls.length, 0);
        const controller = new AbortController();
        const result = executeShellCommand("legacy", { env: { OWNED_WINDOWS_TEST: "preserved" } }, controller.signal);
        if (cancel) {
          controller.abort();
          await assert.rejects(result, (error: unknown) => error instanceof Error && "code" in error && error.code === "CANCELLED");
          if (platform === "win32") assert.deepEqual(calls[1]?.slice(0, 2), ["taskkill", ["/pid", "12345", "/t", "/f"]]);
          else assert.deepEqual(kills, [[-12345, "SIGTERM"]]);
        } else {
          stdout.write("☃");
          stderr.write("timeout is product evidence");
          child.emit("close", 7);
          assert.deepEqual(await result, { exitCode: 7, stdout: "☃", stderr: "timeout is product evidence" });
        }
        const options = calls[0]?.[1] as { detached: boolean; env: NodeJS.ProcessEnv; shell: boolean };
        assert.equal(options.detached, platform !== "win32");
        assert.equal(options.shell, true);
        assert.equal(options.env.OWNED_WINDOWS_TEST, "preserved");
      } finally {
        child.emit("close", null);
        stdout.destroy();
        stderr.destroy();
        Object.defineProperty(process, "platform", original);
        spawn.mock.restore();
        kill.mock.restore();
        syncBuiltinESMExports();
      }
    });
  }
}

void test("normal leader exit preserves inherited-stdio late output", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
  const { executeShellCommand } = await import("../src/execution.js");
  assert.deepEqual(await executeShellCommand("(sleep 0.2; printf late) & exit 0", { timeoutMs: 2000 }, new AbortController().signal), { exitCode: 0, stdout: "late", stderr: "" });
});
void test("normal leader exit keeps timeout active while inherited stdio remains open", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
  const { executeShellCommand } = await import("../src/execution.js");
  await assert.rejects(executeShellCommand("(sleep 1; printf late) & exit 0", { timeoutMs: 50 }, new AbortController().signal), /timed out/);
});

void test("host reporting deadline includes a suspended supervisor before command startup", { skip: process.platform !== "darwin" && process.platform !== "linux", timeout: 30_000 }, async (t) => {
  const { executeOwnedCommand } = await import("../src/owned-process.js");
  const originalFork = childProcess.fork;
  let owned: ChildProcess | undefined;
  let verified: ReturnType<typeof processes>[number] | undefined;
  let closed: Promise<void> | undefined;
  let helperFile: string | undefined;
  const directory = mkdtempSync(join(tmpdir(), "owned-startup-"));
  const marker = join(directory, "ran");
  const fixture = join(directory, "startup.cjs");
  writeFileSync(fixture, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
  const launch = t.mock.method(childProcess, "fork", (file: string, args?: readonly string[], options?: childProcess.ForkOptions) => {
    const child = originalFork(file, args ?? [], options ?? {});
    owned = child;
    helperFile = file;
    closed = new Promise((resolve) => child.once("close", () => { resolve(); }));
    verified = processes().find((p) => p.pid === child.pid && p.args.includes(file));
    assert.ok(verified, "fresh ChildProcess and helper argv must both authorize SIGSTOP");
    process.kill(verified.pid, "SIGSTOP");
    return child;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(executeOwnedCommand(shellContractCommand(fixture), { timeoutMs: 50 }, new AbortController().signal, directory, () => {}), (error: unknown) => error instanceof Error && "cleanupUnproven" in error && error.cleanupUnproven === true);
    assert.ok(helperFile && existsSync(helperFile), "startup watchdog must not remove still-owned helper resources");
    assert.ok(verified && processes().some((p) => p.pid === verified?.pid && p.args === verified.args && p.state.startsWith("T")));
    assert.equal(existsSync(marker), false, "configuration must still be queued before helper startup");
  } finally {
    launch.mock.restore(); syncBuiltinESMExports();
    const helper = verified;
    if (helper && processes().some((p) => p.pid === helper.pid && p.args === helper.args && !p.state.startsWith("Z"))) process.kill(helper.pid, "SIGCONT");
    try {
      if (owned) await until(() => owned?.exitCode !== null || owned.signalCode !== null, "resumed startup helper must finish real cleanup", 8000);
      await closed;
    } finally {
      if (helper && processes().some((p) => p.pid === helper.pid && p.args === helper.args && !p.state.startsWith("Z"))) process.kill(helper.pid, "SIGKILL");
      if (helper) await until(() => !processes().some((p) => p.pid === helper.pid && p.args === helper.args && !p.state.startsWith("Z")), "startup fault cleanup must leave no verified helper");
      rmSync(directory, { recursive: true, force: true });
    }
  }
});


function reportingClock() {
  let elapsed = 0;
  const timers: Array<{ callback: () => void; delayMs: number; cancelled: boolean }> = [];
  return {
    timers,
    advanceTo: (at: number) => { elapsed = at; },
    now: () => elapsed,
    schedule: (callback: () => void, delayMs: number) => {
      const timer = { callback, delayMs, cancelled: false };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
    timer: (index: number) => { const timer = timers[index]; assert.ok(timer); return timer; },
  };
}

void test("reporting deadline segments long bounds and rechecks remaining monotonic time", async () => {
  const { createOwnedCommandReportingDeadline } = await import("../src/owned-process.js");
  const clock = reportingClock();
  let expired = 0;
  const deadline = createOwnedCommandReportingDeadline(() => { expired += 1; }, clock);
  const max = 2_147_483_647;
  deadline.earlier(max + 8000);
  assert.equal(clock.timer(0).delayMs, max);
  clock.advanceTo(max);
  clock.timer(0).callback();
  assert.equal(expired, 0, "one maximum-size timer segment is not the whole deadline");
  assert.equal(clock.timer(1).delayMs, 8000);
  clock.advanceTo(max + 7999);
  clock.timer(1).callback();
  assert.equal(expired, 0, "early callback must recheck remaining time");
  assert.equal(clock.timer(2).delayMs, 1);
  clock.advanceTo(max + 8000);
  clock.timer(2).callback();
  assert.equal(expired, 1);
  deadline.earlier(0);
  clock.timer(2).callback();
  assert.equal(expired, 1, "expiry is latched");
});

void test("reporting deadline keeps an earlier cancellation bound across long timer replacement", async () => {
  const { createOwnedCommandReportingDeadline } = await import("../src/owned-process.js");
  const clock = reportingClock();
  let expired = 0;
  const deadline = createOwnedCommandReportingDeadline(() => { expired += 1; }, clock);
  deadline.earlier(2_147_483_647 + 8000);
  clock.advanceTo(50);
  deadline.earlier(clock.now() + 8000);
  assert.equal(clock.timer(0).cancelled, true);
  assert.equal(clock.timer(1).delayMs, 8000);
  deadline.earlier(clock.now() + 16000);
  clock.timer(0).callback();
  assert.equal(clock.timers.length, 2, "later requests and stale cancelled callbacks cannot replace the earlier timer");
  clock.advanceTo(8050);
  clock.timer(1).callback();
  assert.equal(expired, 1);
});

void test("reporting deadline cannot extend a shorter configured bound and disposal prevents rearming", async () => {
  const { createOwnedCommandReportingDeadline } = await import("../src/owned-process.js");
  const clock = reportingClock();
  let expired = 0;
  const deadline = createOwnedCommandReportingDeadline(() => { expired += 1; }, clock);
  deadline.earlier(100);
  clock.advanceTo(10);
  deadline.earlier(clock.now() + 8000);
  assert.equal(clock.timers.length, 1);
  deadline.dispose();
  assert.equal(clock.timer(0).cancelled, true);
  clock.advanceTo(100);
  clock.timer(0).callback();
  deadline.earlier(101);
  assert.equal(clock.timers.length, 1);
  assert.equal(expired, 0);
});
