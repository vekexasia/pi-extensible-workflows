import assert from "node:assert/strict";
import childProcess, { ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
type Record = { pid: number; parent: number; group: number };
function record(path: string): Record { return JSON.parse(readFileSync(path, "utf8")) as Record; }
const execution = new URL("../src/execution.js", import.meta.url).href;
const runtimes = [{ name: "Node", executable: process.execPath }];
try {
  const bun = execFileSync("which", ["bun"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  if (bun !== process.execPath) runtimes.push({ name: "Bun", executable: bun });
} catch { /* Bun is optional; Node is required. */ }

for (const runtime of runtimes) {
  for (const scenario of ["cancellation", "timeout", "leader exit", "leader TERM", "leader KILL", "host KILL", "supervisor STOP cancellation", "supervisor STOP deadline", "supervisor STOP output"] as const) {
    void test(`executeShellCommand ${runtime.name}: ${scenario} drains a TERM-resistant stdio-independent descendant`, { skip: process.platform !== "darwin" && process.platform !== "linux", timeout: 30_000 }, async (t) => {
      const directory = mkdtempSync(join(tmpdir(), "owned-process-"));
      const fixture = join(directory, "fixture.cjs");
      const descendant = join(directory, "descendant.json");
      const leader = join(directory, "leader.json");
      const result = join(directory, "result.json");
      const cancel = join(directory, "cancel");
      const exit = join(directory, "exit");
      const output = join(directory, "output");
      const hostFile = join(directory, "host.mjs");
      writeFileSync(fixture, `
const fs = require("node:fs");
const cp = require("node:child_process");
const group = Number(cp.execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], {encoding:"utf8"}).trim());
const data = {pid:process.pid,parent:process.ppid,group};
if (process.argv[2] === "descendant") {
  process.on("SIGTERM", () => {});
  fs.writeFileSync(${JSON.stringify(descendant)}, JSON.stringify(data));
} else {
  fs.writeFileSync(${JSON.stringify(leader)}, JSON.stringify(data));
  cp.spawn(${JSON.stringify(process.execPath)}, [__filename, "descendant"], {stdio:"ignore"});
  setInterval(() => {
    if (fs.existsSync(${JSON.stringify(exit)})) process.exit(7);
    if (fs.existsSync(${JSON.stringify(output)})) { fs.unlinkSync(${JSON.stringify(output)}); process.stdout.write("trigger output failure"); }
  }, 10);
}
setInterval(() => {}, 1000);
`);
      const command = `exec '${process.execPath.replaceAll("'", "'\\''")}' '${fixture.replaceAll("'", "'\\''")}'`;
      writeFileSync(hostFile, `
import { executeShellCommand } from ${JSON.stringify(execution)};
import { executeOwnedCommand } from ${JSON.stringify(new URL("../src/owned-process.js", import.meta.url).href)};
import { execFileSync } from "node:child_process";
import fs from "node:fs";
const controller = new AbortController();
const poll = setInterval(() => { if (fs.existsSync(${JSON.stringify(cancel)})) controller.abort(); }, 10);
try {
  const command = ${JSON.stringify(command)};
  const cwd = ${JSON.stringify(directory)};
  const options = ${JSON.stringify(scenario === "timeout" || scenario === "supervisor STOP deadline" ? { timeoutMs: 1500 } : { timeoutMs: 10000 })};
  const value = ${JSON.stringify(scenario)} === "supervisor STOP output"
    ? await executeOwnedCommand(command, options, controller.signal, cwd, () => {
        const { parent } = JSON.parse(fs.readFileSync(${JSON.stringify(leader)}, "utf8"));
        const args = execFileSync("ps", ["-o", "args=", "-p", String(parent)], {encoding:"utf8"});
        if (!args.includes("/pi-owned-") || !args.includes("/supervisor.cjs")) throw new Error("unverified helper");
        process.kill(parent, "SIGSTOP");
        throw Object.assign(new Error("injected output boundary failure"), {code:"RPC_LIMIT_EXCEEDED"});
      })
    : await executeShellCommand(command, options, controller.signal, cwd);
  fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ok:true,value}));
} catch(error) {
  fs.writeFileSync(${JSON.stringify(result)}, JSON.stringify({ok:false,code:error.code,message:error.message,cleanupUnproven:error.cleanupUnproven === true}));
} finally { clearInterval(poll); }
`);
      let host: ChildProcess | undefined;
      let hostClosed: Promise<void> | undefined;
      let owned: Record | undefined;
      let ownedSupervisor: ReturnType<typeof processes>[number] | undefined;
      try {
        host = spawn(runtime.executable, [hostFile], { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, ...(runtime.name === "Bun" ? { BUN_BE_BUN: "1" } : {}) } });
        let diagnostics = "";
        host.stderr?.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
        const launched = host;
        hostClosed = new Promise((resolve) => launched.once("close", () => { resolve(); }));
        await until(() => existsSync(descendant), `descendant must become ready: ${diagnostics}`);
        owned = record(leader);
        const child = record(descendant);
        const group = owned.group;
        assert.equal(child.group, group);
        const supervisor = processes().find((p) => p.pid === owned?.parent && p.args.includes("pi-owned-") && p.args.includes("supervisor.cjs"));
        ownedSupervisor = supervisor;
        assert.ok(processes().some((p) => p.pid === child.pid && p.group === group && p.args.includes(fixture)), "fresh process record proves ownership");
        t.diagnostic(JSON.stringify({ host: launched.pid, supervisor: supervisor?.pid, leader: owned.pid, descendant: child.pid, group, ready: true }));
        if (scenario === "cancellation") writeFileSync(cancel, "cancel");
        if (scenario === "leader exit") writeFileSync(exit, "exit");
        if (scenario === "leader TERM" || scenario === "leader KILL") process.kill(owned.pid, scenario === "leader TERM" ? "SIGTERM" : "SIGKILL");
        if (scenario.startsWith("supervisor STOP")) {
          assert.ok(supervisor);
          const helperFile = / (\/.*\/supervisor\.cjs)$/.exec(supervisor.args)?.[1];
          assert.ok(helperFile);
          if (scenario === "supervisor STOP output") writeFileSync(output, "output");
          else process.kill(supervisor.pid, "SIGSTOP");
          await until(() => processes().some((p) => p.pid === supervisor.pid && p.args === supervisor.args && p.state.startsWith("T")), "fresh supervisor must be suspended");
          if (scenario === "supervisor STOP cancellation") writeFileSync(cancel, "cancel");
          await until(() => existsSync(result), "host must bound unresponsive-supervisor reporting", 10_000);
          const receipt = JSON.parse(readFileSync(result, "utf8")) as { code?: string; message?: string; cleanupUnproven?: boolean };
          assert.equal(receipt.code, "SHELL_FAILED");
          assert.match(receipt.message ?? "", /cleanup unproven/);
          assert.equal(receipt.cleanupUnproven, true);
          assert.ok(existsSync(helperFile), "watchdog must retain private helper resources");
          assert.ok(processes().some((p) => p.pid === supervisor.pid && p.args === supervisor.args && p.state.startsWith("T")), "watchdog must not kill or forget the still-live supervisor");
          assert.ok(processes().some((p) => p.pid === launched.pid), "host lifeline must stay live after reporting uncertainty");
          t.diagnostic(JSON.stringify({ group, supervisor: supervisor.pid, cleanupUnproven: true, helperRetained: true }));
        } else if (scenario === "host KILL") {
          host.kill("SIGKILL");
          await hostClosed;
          await until(() => !processes().some((p) => p.group === group && !p.state.startsWith("Z")), "host death must drain owned command group");
          assert.ok(supervisor, "deadline owner must be independent of host and command leader");
          assert.notEqual(supervisor.pid, launched.pid);
          await until(() => !processes().some((p) => p.pid === supervisor.pid && p.args === supervisor.args && !p.state.startsWith("Z")), "independent supervisor must also finish");
          assert.equal(existsSync(result), false, "host death must not fabricate a completion receipt");
          t.diagnostic(JSON.stringify({ group, quiescentAfterHostDeath: true, supervisorStopped: true }));
        } else {
          await until(() => existsSync(result), `operation must settle: ${diagnostics}`, 10_000);
          const remaining = processes().filter((p) => p.group === group && !p.state.startsWith("Z"));
          assert.deepEqual(remaining, [], "no owned process may still run at settlement");
          t.diagnostic(JSON.stringify({ group, quiescentAtSettlement: true }));
          assert.ok(supervisor, "deadline owner must be independent of host and command leader");
          assert.notEqual(supervisor.pid, launched.pid);
          const receipt = JSON.parse(readFileSync(result, "utf8")) as { ok: boolean; code?: string; message?: string; value?: { exitCode: number | null } };
          if (scenario === "cancellation") assert.equal(receipt.code, "CANCELLED");
          else if (scenario === "timeout") { assert.equal(receipt.code, "SHELL_FAILED"); assert.match(receipt.message ?? "", /timed out/); }
          else {
            assert.equal(receipt.ok, true, JSON.stringify(receipt));
            if (scenario === "leader exit") assert.equal(receipt.value?.exitCode, 7);
          }
        }
      } finally {
        try {
          const supervisor = ownedSupervisor;
          if (scenario.startsWith("supervisor STOP") && supervisor && processes().some((p) => p.pid === supervisor.pid && p.args === supervisor.args && !p.state.startsWith("Z"))) {
            process.kill(supervisor.pid, "SIGCONT");
            await until(() => !processes().some((p) => (p.group === owned?.group || p.pid === supervisor.pid && p.args === supervisor.args) && !p.state.startsWith("Z")), "resumed supervisor must actually clean its group and exit");
            if (existsSync(result)) assert.equal((JSON.parse(readFileSync(result, "utf8")) as { cleanupUnproven?: boolean }).cleanupUnproven, true, "later cleanup must not erase the reported uncertainty");
            t.diagnostic(JSON.stringify({ supervisor: supervisor.pid, resumedCleanupComplete: true }));
          }
        } finally {
          // Only fresh members carrying this unique fixture path can authorize cleanup.
          // Never signal a PID/group merely because a file with that number exists.
          const fresh = processes().filter((p) => p.args.includes(fixture) && !p.state.startsWith("Z"));
          for (const group of new Set(fresh.map((p) => p.group))) {
            try { process.kill(-group, "SIGKILL"); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); }
          }
          await until(() => !processes().some((p) => p.args.includes(fixture) && !p.state.startsWith("Z")), "test cleanup must drain verified fixture processes");
          if (host && host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
          await hostClosed;
          // A failed assertion must not leave the independent deadline owner behind.
          const supervisor = ownedSupervisor;
          if (supervisor && processes().some((p) => p.pid === supervisor.pid && p.args === supervisor.args && !p.state.startsWith("Z"))) {
            try { process.kill(supervisor.pid, "SIGKILL"); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); }
            await until(() => !processes().some((p) => p.pid === supervisor.pid && p.args === supervisor.args && !p.state.startsWith("Z")), "test cleanup must drain verified supervisor");
          }
          rmSync(directory, { recursive: true, force: true });
        }
      }
    });
  }
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

for (const runtime of runtimes) {
  void test(`${runtime.name} maximum supported timeout preserves a finite ordinary command`, { skip: process.platform !== "darwin" && process.platform !== "linux", timeout: 30_000 }, () => {
    const directory = mkdtempSync(join(tmpdir(), "owned-timer-boundary-"));
    const host = join(directory, "host.mjs");
    writeFileSync(host, `import { executeShellCommand } from ${JSON.stringify(execution)}; const result = await executeShellCommand("sleep 0.2; printf boundary", { timeoutMs: 2147483647 }, new AbortController().signal); process.stdout.write(JSON.stringify(result));`);
    try {
      const output = execFileSync(runtime.executable, [host], { encoding: "utf8", timeout: 10_000, env: { ...process.env, ...(runtime.name === "Bun" ? { BUN_BE_BUN: "1" } : {}) } });
      assert.deepEqual(JSON.parse(output), { exitCode: 0, stdout: "boundary", stderr: "" });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}

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
