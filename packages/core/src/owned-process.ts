import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import type { ShellOptions } from "./types.js";
import { WorkflowError } from "./types.js";
import { errorText, object } from "./utils.js";

// Embedded so source-loaded extensions, bundled entrypoints and npm packages use
// exactly the same builtin-only helper, including under a Bun-compiled host.
const supervisorSource = String.raw`
"use strict";
const { spawn } = require("node:child_process");
const { rmSync } = require("node:fs");
let child, group, exitCode = null, closed = false, stopping = false, finished = false;
let deadline, escalation, poll, cleanupDeadline;
let failure;
let groupGone = false;
const clearTimers = () => { clearTimeout(deadline); clearTimeout(escalation); clearInterval(poll); clearTimeout(cleanupDeadline); };
function finish(error) {
  if (finished) return;
  finished = true;
  clearTimers();
  rmSync(__dirname, {recursive:true, force:true});
  const message = {type:"done", exitCode, ...(error || failure ? {error:error || failure} : {})};
  const exit = () => {
    if (process.connected) process.disconnect();
    // An unkillable child/pipe must not prevent reporting cleanup uncertainty.
    if (error) process.exit(1);
  };
  if (process.connected) process.send(message, exit);
  else exit();
}
function exists() {
  if (!group || groupGone) return false;
  try { process.kill(-group, 0); return true; }
  catch (error) {
    if (error.code === "ESRCH") { groupGone = true; return false; }
    // Darwin can report EPERM while the last killed member is exiting. It is
    // not proof of absence: keep polling, and fail closed at the cleanup bound.
    if (error.code === "EPERM") return true;
    throw error;
  }
}
function signalGroup(signal) {
  if (!exists()) return;
  try { process.kill(-group, signal); }
  catch (error) { if (error.code === "ESRCH") groupGone = true; else if (error.code !== "EPERM") throw error; }
}
function check() {
  try { if (!exists() && closed) finish(); }
  catch (error) { finish({code:"SHELL_FAILED", message:"Shell cleanup unproven: " + error.message}); }
}
function stop(error) {
  if (finished) return;
  if (error && !failure) failure = error;
  if (stopping) return;
  stopping = true;
  clearTimeout(deadline);
  // Never clear escalation merely because the command leader or its stdio exits.
  try { signalGroup("SIGTERM"); }
  catch (error) { finish({code:"SHELL_FAILED", message:"Shell cleanup unproven: " + error.message}); return; }
  escalation = setTimeout(() => {
    try { signalGroup("SIGKILL"); check(); }
    catch (error) { finish({code:"SHELL_FAILED", message:"Shell cleanup unproven: " + error.message}); }
  }, 1000);
  poll = setInterval(check, 20);
  cleanupDeadline = setTimeout(() => finish({code:"SHELL_FAILED", message:"Shell cleanup unproven: owned process group did not disappear after SIGKILL"}), 6000);
  check();
}
process.on("disconnect", () => {
  if (!child) finish();
  else stop({code:"CANCELLED", message:"Shell parent disconnected"});
});
process.on("SIGTERM", () => stop({code:"CANCELLED", message:"Shell supervisor interrupted"}));
process.on("SIGINT", () => stop({code:"CANCELLED", message:"Shell supervisor interrupted"}));
// A dead host also closes its output pipes. EPIPE must not kill the deadline owner.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});
process.on("message", (message) => {
  if (!message || finished) return;
  if (message.type === "cancel") { stop({code:"CANCELLED", message:"Workflow cancelled"}); return; }
  if (message.type !== "start" || child || stopping) return;
  try {
    child = spawn(message.command, {shell:true, cwd:message.cwd, env:message.env, detached:true, stdio:["ignore","pipe","pipe"]});
    group = child.pid;
    child.stdout.pipe(process.stdout, {end:false});
    child.stderr.pipe(process.stderr, {end:false});
    child.once("error", (error) => stop({code:"SHELL_FAILED", message:error.message}));
    // Preserve inherited-stdio output after leader exit; the deadline remains live.
    // Stdio-independent descendants still reach close promptly and are drained there.
    child.once("exit", (code) => { exitCode = code; });
    child.once("close", () => { closed = true; if (!stopping) stop(); else check(); });
    if (message.timeoutMs !== undefined) deadline = setTimeout(() => stop({code:"SHELL_FAILED", message:"Shell command timed out after " + message.timeoutMs + "ms"}), message.timeoutMs);
    if (!process.connected) stop({code:"CANCELLED", message:"Shell parent disconnected"});
  } catch (error) { closed = true; stop({code:"SHELL_FAILED", message:error.message}); }
});
`;

// This exceeds the supervisor's six-second cleanup bound, including IPC/exit delivery.
const HOST_CLEANUP_GRACE_MS = 8000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Internal monotonic reporting clock. Node clamps oversized timers to 1ms, so
 * each bounded segment must recheck the deadline instead of declaring expiry.
 */
export function createOwnedCommandReportingDeadline(expire: () => void, clock: {
  now: () => number;
  schedule: (callback: () => void, delayMs: number) => () => void;
} = {
  now: () => performance.now(),
  schedule: (callback, delayMs) => { const timer = setTimeout(callback, delayMs); return () => { clearTimeout(timer); }; },
}): { earlier: (at: number) => void; dispose: () => void } {
  let deadline = Infinity;
  let cancelSegment: (() => void) | undefined;
  let generation = 0;
  let closed = false;
  const scheduleSegment = () => {
    const current = ++generation;
    cancelSegment = clock.schedule(() => {
      if (closed || current !== generation) return;
      cancelSegment = undefined;
      if (clock.now() < deadline) { scheduleSegment(); return; }
      closed = true;
      expire();
    }, Math.min(MAX_TIMER_DELAY_MS, Math.max(0, deadline - clock.now())));
  };
  return {
    earlier: (at) => {
      if (closed || at >= deadline) return;
      deadline = at;
      cancelSegment?.();
      scheduleSegment();
    },
    dispose: () => { closed = true; cancelSegment?.(); cancelSegment = undefined; },
  };
}

/** Irrevocable uncertainty evidence, not a cancellation acknowledgement. A future
 * ownership scope must retain/taint its owner even if a callback catches this or
 * the still-tracked supervisor subsequently completes cleanup.
 */
export class OwnedCommandCleanupError extends WorkflowError {
  readonly cleanupUnproven = true;
  constructor(message: string) { super("SHELL_FAILED", `Shell cleanup unproven: ${message}`); }
}

type Completion = { exitCode: number | null; error?: { code: "SHELL_FAILED" | "CANCELLED"; message: string } };
function completion(value: unknown): Completion | undefined {
  if (!object(value) || value.type !== "done" || value.exitCode !== null && !Number.isInteger(value.exitCode)) return;
  if (value.error !== undefined && (!object(value.error) || value.error.code !== "SHELL_FAILED" && value.error.code !== "CANCELLED" || typeof value.error.message !== "string")) return;
  return value as Completion;
}

/** Owns one fresh process group. No persisted PID is ever authority to signal.
 * POSIX group disappearance is the cleanup proof; Node only reaps direct children.
 * Deliberately escaped daemons and killing the supervisor itself are not covered.
 */
export function executeOwnedCommand(command: string, options: ShellOptions, signal: AbortSignal, cwd: string, capture: (target: "stdout" | "stderr", chunk: Buffer) => void): Promise<number | null> {
  if (signal.aborted) return Promise.reject(new WorkflowError("CANCELLED", "Workflow cancelled"));
  if (process.platform !== "darwin" && process.platform !== "linux") return Promise.reject(new WorkflowError("SHELL_FAILED", "Owned shell supervision requires macOS or Linux process groups"));
  const startedAt = performance.now();
  return new Promise((resolve, reject) => {
    let directory: string | undefined;
    let supervisor: ChildProcess;
    try {
      directory = mkdtempSync(join(tmpdir(), "pi-owned-"));
      const file = join(directory, "supervisor.cjs");
      writeFileSync(file, supervisorSource, { mode: 0o600 });
      supervisor = fork(file, [], {
        execArgv: [],
        env: process.versions.bun ? { ...process.env, BUN_BE_BUN: "1" } : process.env,
        detached: true,
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
    } catch (error) {
      if (directory) rmSync(directory, { recursive: true, force: true });
      reject(new WorkflowError("SHELL_FAILED", errorText(error)));
      return;
    }
    let result: Completion | undefined;
    let failure: Error | undefined;
    let uncertainty: OwnedCommandCleanupError | undefined;
    const sendCancel = () => {
      if (supervisor.connected) supervisor.send({ type: "cancel" }, () => { /* close reports a lost supervisor */ });
    };
    const reportingDeadline = createOwnedCommandReportingDeadline(() => {
      uncertainty = new OwnedCommandCleanupError("supervisor did not finish within the host reporting bound");
      sendCancel();
      // Reporting is NOT disposal: keep IPC, streams, abort/close listeners and
      // private resources owned until the helper actually closes. No unref/kill.
      reject(uncertainty);
    });
    const boundReporting = reportingDeadline.earlier;
    const cancel = () => {
      boundReporting(performance.now() + HOST_CLEANUP_GRACE_MS);
      sendCancel();
    };
    const onAbort = () => { cancel(); };
    const onData = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (failure || uncertainty) return;
      try { capture(target, chunk); } catch (error) { failure = error instanceof Error ? error : new WorkflowError("SHELL_FAILED", errorText(error)); cancel(); }
    };
    supervisor.stdout?.on("data", (chunk: Buffer) => { onData("stdout", chunk); });
    supervisor.stderr?.on("data", (chunk: Buffer) => { onData("stderr", chunk); });
    supervisor.on("message", (message: unknown) => { result = completion(message); });
    supervisor.once("error", (error) => { failure ??= new OwnedCommandCleanupError(errorText(error)); boundReporting(performance.now() + HOST_CLEANUP_GRACE_MS); });
    supervisor.once("close", () => {
      signal.removeEventListener("abort", onAbort);
      reportingDeadline.dispose();
      rmSync(directory, { recursive: true, force: true });
      if (uncertainty) { reject(uncertainty); return; }
      // Cleanup uncertainty must not be hidden by cancellation or output overflow.
      if (!result) { reject(new OwnedCommandCleanupError("supervisor exited without a completion receipt")); return; }
      if (result.error?.message.startsWith("Shell cleanup unproven:")) { reject(new OwnedCommandCleanupError(result.error.message.slice("Shell cleanup unproven: ".length))); return; }
      if (failure) { reject(failure); return; }
      if (signal.aborted) { reject(new WorkflowError("CANCELLED", "Workflow cancelled")); return; }
      if (result.error) { reject(new WorkflowError(result.error.code, result.error.message)); return; }
      resolve(result.exitCode);
    });
    signal.addEventListener("abort", onAbort, { once: true });
    // Includes helper startup; a suspended helper cannot own the only clock.
    if (options.timeoutMs !== undefined) boundReporting(startedAt + options.timeoutMs + HOST_CLEANUP_GRACE_MS);
    supervisor.send({ type: "start", command, cwd, env: { ...process.env, ...(options.env ?? {}) }, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }, (error) => {
      if (error) { failure ??= new OwnedCommandCleanupError(error.message); boundReporting(performance.now() + HOST_CLEANUP_GRACE_MS); }
    });
    if (signal.aborted) onAbort();
  });
}
