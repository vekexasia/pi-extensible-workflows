/**
 * Portable real-process fixtures for launcher and caller tests.
 *
 * Every helper creates or drives genuine child processes: argv, cwd and env are
 * captured by the child itself, never inferred from arrays built in memory.
 * Children receive an isolated HOME/USERPROFILE/APPDATA/PI_CODING_AGENT_DIR and
 * temporary directories under the fixture root, so no personal profile is read.
 */
import { copyFileSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { spawn } from "node:child_process";
import { spawnExecutable, stopProcessTree, type LaunchOptions } from "../src/process-launcher.js";

export interface ProcessCapture { args: string[]; cwd: string; env: Record<string, string | undefined>; pid: number; ppid: number }
export interface LaunchOutcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  /** Launch failure (thrown by the launcher or emitted as `error`); never set for a process that exited nonzero. */
  error?: NodeJS.ErrnoException;
  child?: ChildProcess;
  /** Set when the fixture deadline or abort signal stopped the owned process tree; reported only after close. */
  stopped?: "timeout" | "cancelled";
}
export interface LaunchControl { timeoutMs?: number; signal?: AbortSignal }

/** Source of the capture child. It writes one JSON record to stdout and optionally to CAPTURE_FILE. */
export const CAPTURE_SOURCE = `
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
const names = (process.env.CAPTURE_ENV_KEYS ?? "").split(",").filter(Boolean);
const env = Object.fromEntries(names.map((name) => [name, process.env[name]]));
const record = { args: process.argv.slice(2), cwd: process.cwd(), env, pid: process.pid, ppid: process.ppid };
const text = JSON.stringify(record);
if (process.env.CAPTURE_FILE) writeFileSync(process.env.CAPTURE_FILE, text);
if (process.env.CAPTURE_STDERR) process.stderr.write(process.env.CAPTURE_STDERR);
process.stdout.write(text);
if (process.env.CAPTURE_GRANDCHILD_PID_FILE) {
  const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore", windowsHide: true });
  writeFileSync(process.env.CAPTURE_GRANDCHILD_PID_FILE, String(grandchild.pid));
}
if (process.env.CAPTURE_HANG === "1") setInterval(() => {}, 1000);
else process.exitCode = Number(process.env.CAPTURE_EXIT ?? "0");
`;

export interface ProcessFixture {
  /** Fixture root; its name contains spaces and non-ASCII characters. */
  root: string;
  /** A directory distinct from the parent process cwd, to be used as child cwd. */
  project: string;
  /** Isolated environment (inherits PATH/SystemRoot only as needed by the platform). */
  env: NodeJS.ProcessEnv;
  /** Writes the capture entrypoint at `relative` inside `base` (default: project). */
  writeCapture(relative: string, base?: string): string;
  /** Writes an npm cmd-shim style `.cmd` in `directory` forwarding to `entry` through `%dp0%`. */
  writeNpmShim(directory: string, name: string, entry: string): string;
  /**
   * Writes a plain (non npm-shim) batch file forwarding `%*` to `"%PIEWF_FORWARD_NODE%" "%~dp0<entry>"`.
   * `entry` must live under `directory`; the batch body stays ASCII when the relative entry name is ASCII.
   */
  writeBatchForwarder(directory: string, name: string, entry: string): string;
  /** Hard links (or copies) the running Node executable to `directory/name` to obtain a real native executable. */
  linkNodeExecutable(directory: string, name: string): string;
  cleanup(): void;
}

/** Keys removed from the inherited environment so children cannot observe a personal profile. */
const PROFILE_KEYS = new Set(["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PI_CODING_AGENT_DIR", "TEMP", "TMP", "TMPDIR", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"]);

export function isolatedEnv(root: string, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const home = join(root, "home");
  const temp = join(root, "temp");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  mkdirSync(join(home, "AppData", "Roaming"), { recursive: true });
  mkdirSync(join(home, "AppData", "Local"), { recursive: true });
  mkdirSync(temp, { recursive: true });
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) if (!PROFILE_KEYS.has(key.toUpperCase()) && !key.toLowerCase().startsWith("npm_")) env[key] = value;
  return {
    ...env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    PI_CODING_AGENT_DIR: join(home, ".pi", "agent"),
    TEMP: temp,
    TMP: temp,
    TMPDIR: temp,
    PIEWF_FORWARD_NODE: process.execPath,
  };
}

/** Returns a copy of `env` without any case variant of `name`. */
export function withoutEnvKey(env: NodeJS.ProcessEnv, name: string): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key]) => key.toUpperCase() !== name.toUpperCase()));
}

export function createProcessFixture(prefix = "piewf launcher café fixture "): ProcessFixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const project = join(root, "child project ü");
  mkdirSync(project, { recursive: true });
  const env = isolatedEnv(root);
  return {
    root,
    project,
    env,
    writeCapture(relative, base = project) {
      const path = join(base, relative);
      mkdirSync(join(path, ".."), { recursive: true });
      writeFileSync(path, CAPTURE_SOURCE);
      return path;
    },
    writeNpmShim(directory, name, entry) {
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${name}.cmd`);
      const relative = entry.startsWith(directory) ? entry.slice(directory.length).replace(/^[\\/]+/, "") : entry;
      writeFileSync(path, `@ECHO off\r\nGOTO start\r\n:find_dp0\r\nSET dp0=%~dp0\r\nEXIT /b\r\n:start\r\nSETLOCAL\r\nCALL :find_dp0\r\nIF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")\r\n"%_prog%" "%dp0%\\${relative}" %*\r\n`);
      return path;
    },
    writeBatchForwarder(directory, name, entry) {
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${name}.cmd`);
      if (!entry.startsWith(directory)) throw new Error("Batch forwarder entry must live under its directory");
      const relative = entry.slice(directory.length).replace(/^[\\/]+/, "");
      writeFileSync(path, `@ECHO off\r\n"%PIEWF_FORWARD_NODE%" "%~dp0${relative}" %*\r\n`);
      return path;
    },
    linkNodeExecutable(directory, name) {
      mkdirSync(directory, { recursive: true });
      const path = join(directory, name);
      try { linkSync(process.execPath, path); } catch { copyFileSync(process.execPath, path); }
      return path;
    },
    cleanup() { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); },
  };
}

/**
 * Launches through `spawnExecutable` and resolves after the child closed, with exit data or the launch error.
 * `control.timeoutMs`/`control.signal` stop only the owned tree via `stopProcessTree` and still wait for close.
 * Children lead their own process group on Unix so the owned tree can be signalled.
 */
export function launch(command: string, args: readonly string[], options: SpawnOptions = {}, launchOptions?: LaunchOptions, control: LaunchControl = {}): Promise<LaunchOutcome> {
  return new Promise((resolve) => {
    let child: ChildProcess;
    try { child = spawnExecutable(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32", ...options }, launchOptions); }
    catch (error) { resolve({ code: null, signal: null, stdout: "", stderr: "", error: error as NodeJS.ErrnoException }); return; }
    let stdout = "";
    let stderr = "";
    let launchError: NodeJS.ErrnoException | undefined;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    let stopped: LaunchOutcome["stopped"];
    const stop = (reason: NonNullable<LaunchOutcome["stopped"]>) => { if (stopped) return; stopped = reason; void stopProcessTree(child); };
    const timer = control.timeoutMs === undefined ? undefined : setTimeout(() => { stop("timeout"); }, control.timeoutMs);
    const onAbort = () => { stop("cancelled"); };
    if (control.signal?.aborted) onAbort(); else control.signal?.addEventListener("abort", onAbort, { once: true });
    child.once("error", (error) => { launchError = error; });
    child.once("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      control.signal?.removeEventListener("abort", onAbort);
      resolve({ code, signal, stdout, stderr, child, ...(launchError ? { error: launchError } : {}), ...(stopped ? { stopped } : {}) });
    });
  });
}

export function parseCapture(outcome: { stdout: string; stderr: string }): ProcessCapture {
  try { return JSON.parse(outcome.stdout) as ProcessCapture; }
  catch { throw new Error(`Child did not emit a capture record. stdout=${JSON.stringify(outcome.stdout)} stderr=${JSON.stringify(outcome.stderr)}`); }
}

export function readPid(path: string): number { return Number(readFileSync(path, "utf8")); }

/** Starts an unrelated idle Node process (not spawned through the launcher) to prove cleanup never reaches it. */
export function spawnSentinel(env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { env, stdio: "ignore", windowsHide: true });
}

/** True while `pid` is alive. Signal 0 performs only an existence/permission probe. */
export function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

export async function waitFor(predicate: () => boolean, timeoutMs = 10_000, intervalMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return predicate();
}

/** Literal argv values exercised at process boundaries: empty, spaces, Unicode, quotes and shell metacharacters. */
export const LITERAL_ARGUMENTS: readonly string[] = [
  "",
  "space value",
  "café ünïcødé 日本",
  "& | < > ^ ( ) ; , * ?",
  "%PATH% !USERNAME! $HOME `whoami`",
  "quote\"inside",
  "'single'",
  "trailing backslash\\",
  "back\\\\\"slash quote",
  "--flag=value with space",
];
