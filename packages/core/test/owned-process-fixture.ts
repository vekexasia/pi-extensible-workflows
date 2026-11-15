import assert from "node:assert/strict";
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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

// Each entry file registers one runtime so real watchdog waits have independent file budgets.
export function registerOwnedProcessRuntime(runtime: { name: string; executable: string }): void {
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
