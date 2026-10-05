import { spawn, spawnSync, type ChildProcess, type SpawnOptions, type SpawnSyncOptions } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, extname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * How a command is launched. Every kind passes argv literally except `shell`, whose command text is trusted host code.
 * - `auto` (default, historical behavior): Node entrypoints (`.js`/`.mjs`/`.cjs`) and npm cmd-shims run on
 *   `process.execPath`; other files run directly. Non-shim `.cmd`/`.bat` files are rejected unless `allowBatchFile`.
 * - `node`: `command` is a Node entrypoint resolved against the child cwd; it always runs on `process.execPath`.
 * - `executable`: PATH/PATHEXT resolution without converting `.js` files to Node; npm cmd-shims still use Node.
 * - `shell`: `command` is an intentional shell command line (`cmd.exe` or `/bin/sh`); `args` are appended literally.
 */
export type LaunchKind = "auto" | "node" | "executable" | "shell";
export interface LaunchOptions {
  kind?: LaunchKind;
  /** Windows: run a non-shim `.cmd`/`.bat` through `cmd.exe` with per-argument escaping. Never enables a global shell. */
  allowBatchFile?: boolean;
}
export interface ResolveOptions extends LaunchOptions {
  /** Child working directory; relative commands and relative PATH entries resolve against it. */
  cwd?: string | URL | undefined;
}
export interface ExecutableInvocation {
  command: string;
  args: string[];
  /** How the invocation runs; absent only on objects created by older callers. */
  via?: "node" | "executable" | "batch" | "shell" | "unresolved";
  /** Set for `cmd.exe` invocations whose command line is already escaped. */
  windowsVerbatimArguments?: boolean;
}

const isWindows = process.platform === "win32";

/** Reads an environment variable with the platform semantics used by `child_process`. */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (!isWindows) return env[name];
  // Node keeps the lexicographically first key among case-insensitive duplicates on Windows.
  const key = Object.keys(env).sort().find((candidate) => candidate.toUpperCase() === name.toUpperCase());
  return key === undefined ? undefined : env[key];
}

function launchError(code: string, message: string, path: string): NodeJS.ErrnoException {
  const error: NodeJS.ErrnoException = new Error(`spawn ${code}: ${message}`);
  error.code = code;
  error.syscall = "spawn";
  error.path = path;
  return error;
}

function childCwd(cwd: string | URL | undefined): string {
  if (cwd === undefined) return process.cwd();
  return resolve(typeof cwd === "string" ? cwd : fileURLToPath(cwd));
}

function isFile(path: string): boolean {
  try { return statSync(path).isFile(); }
  catch { return false; }
}

function hasPathSeparator(command: string): boolean { return command.includes("/") || (isWindows && command.includes("\\")) || isAbsolute(command); }

function nodeScriptShim(path: string): string | undefined {
  try {
    const contents = readFileSync(path, "utf8");
    const npmCli = /SET\s+"NPM_CLI_JS=%~dp0[\\/]([^"\r\n]+\.js)"/i.exec(contents);
    if (npmCli?.[1]) {
      const script = resolve(path, "..", npmCli[1].replace(/[\\/]/g, sep));
      if (isFile(script)) return script;
    }
    if (/SET\s+"script=%~dp0%~n0"/i.test(contents) && /"%script%"/i.test(contents)) {
      const script = path.slice(0, -extname(path).length);
      return isFile(script) ? script : undefined;
    }
    const match = /["']%dp0%[\\/]([^"']+\.(?:m?js|cjs))["']/i.exec(contents);
    if (!match?.[1]) return undefined;
    const script = resolve(path, "..", match[1].replace(/[\\/]/g, sep));
    return isFile(script) ? script : undefined;
  } catch { return undefined; }
}

const nodeScriptPattern = /\.(?:m?js|cjs)$/i;

/** Splits a Windows PATH value; entries may be quoted to contain `;`. */
export function splitWindowsPath(value: string): string[] {
  const entries: string[] = [];
  let current = "";
  let quoted = false;
  for (const character of value) {
    if (character === "\"") quoted = !quoted;
    else if (character === ";" && !quoted) { entries.push(current); current = ""; }
    else current += character;
  }
  entries.push(current);
  return entries.filter((entry) => entry.trim() !== "");
}

function windowsCandidates(command: string, env: NodeJS.ProcessEnv, cwd: string): string[] {
  const directories = hasPathSeparator(command) ? [""] : splitWindowsPath(envValue(env, "PATH") ?? "");
  const configuredExtensions = (envValue(env, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD").split(";").map((extension) => extension.trim()).filter(Boolean);
  const extension = extname(command).toLowerCase();
  const extensions = extension && configuredExtensions.some((candidate) => candidate.toLowerCase() === extension) ? [""] : [...configuredExtensions, ""];
  const candidates: string[] = [];
  for (const directory of directories) for (const suffix of extensions) candidates.push(resolve(cwd, directory, `${command}${suffix}`));
  return candidates;
}

// cmd.exe metacharacters, escaped with `^` outside of quote state (the escaped quotes never toggle it).
const cmdMetaCharacters = /([()\][%!^"`<>&|;, *?])/g;

/** Quotes one argument for the MSVCRT argv parser, then escapes it for `cmd.exe` (twice when a batch file re-parses `%*`). */
function escapeCmdArgument(value: string, doubleEscape: boolean): string {
  let escaped = value.replace(/(\\*)"/g, "$1$1\\\"").replace(/(\\*)$/, "$1$1");
  escaped = `"${escaped}"`.replace(cmdMetaCharacters, "^$1");
  return doubleEscape ? escaped.replace(cmdMetaCharacters, "^$1") : escaped;
}

function commandProcessor(env: NodeJS.ProcessEnv): string {
  const configured = envValue(env, "ComSpec");
  if (configured && isAbsolute(configured) && isFile(configured)) return configured;
  const systemRoot = envValue(env, "SystemRoot") ?? process.env.SystemRoot;
  return systemRoot ? join(systemRoot, "System32", "cmd.exe") : "cmd.exe";
}

function assertCmdSafeArguments(args: readonly string[], path: string): void {
  if (args.some((value) => /[\0\r\n]/.test(value))) throw launchError("EINVAL", "cmd.exe cannot pass NUL or newline characters literally", path);
}

function batchInvocation(path: string, args: readonly string[], env: NodeJS.ProcessEnv): ExecutableInvocation {
  if (/[%!"\0\r\n]/.test(path)) throw launchError("EINVAL", "batch file path contains characters cmd.exe would expand", path);
  assertCmdSafeArguments(args, path);
  const line = [`"${path}"`, ...args.map((value) => escapeCmdArgument(value, true))].join(" ");
  return { command: commandProcessor(env), args: ["/d", "/s", "/v:off", "/c", `"${line}"`], via: "batch", windowsVerbatimArguments: true };
}

function shellInvocation(command: string, args: readonly string[], env: NodeJS.ProcessEnv): ExecutableInvocation {
  if (isWindows) {
    const processor = commandProcessor(env);
    assertCmdSafeArguments(args, processor);
    const line = [command, ...args.map((value) => escapeCmdArgument(value, false))].join(" ");
    return { command: processor, args: ["/d", "/s", "/v:off", "/c", `"${line}"`], via: "shell", windowsVerbatimArguments: true };
  }
  return { command: "/bin/sh", args: args.length ? ["-c", `${command} "$@"`, "sh", ...args] : ["-c", command], via: "shell" };
}

function nodeInvocation(command: string, args: readonly string[], cwd: string): ExecutableInvocation {
  const script = resolve(cwd, command);
  if (!isFile(script)) throw launchError("ENOENT", "Node entrypoint does not exist", script);
  return { command: process.execPath, args: [script, ...args], via: "node" };
}

/**
 * Resolves a launch without a global shell. Node entrypoints and npm-style Windows shims run on `process.execPath`
 * with argv passed literally; relative commands and PATH entries resolve against the child cwd.
 * Throws `EINVAL`/`ENOENT` launch errors (never an exit status) when the contract cannot be honored.
 */
export function resolveExecutable(command: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env, options: ResolveOptions = {}): ExecutableInvocation {
  const kind = options.kind ?? "auto";
  const cwd = childCwd(options.cwd);
  if (kind === "shell") return shellInvocation(command, args, env);
  if (kind === "node") return nodeInvocation(command, args, cwd);
  const convertNodeScripts = kind === "auto";
  if (command.toLowerCase() === "npm") {
    const npmExecPath = envValue(env, "npm_execpath");
    if (npmExecPath && nodeScriptPattern.test(npmExecPath) && isFile(npmExecPath)) return { command: process.execPath, args: [npmExecPath, ...args], via: "node" };
  }
  if (isWindows) {
    for (const candidate of windowsCandidates(command, env, cwd)) {
      if (!isFile(candidate)) continue;
      const extension = extname(candidate).toLowerCase();
      if (extension === ".cmd" || extension === ".bat") {
        const script = nodeScriptShim(candidate);
        if (script) return { command: process.execPath, args: [script, ...args], via: "node" };
        if (options.allowBatchFile) return batchInvocation(candidate, args, env);
        throw launchError("EINVAL", "batch files require an explicit allowBatchFile launch", candidate);
      }
      if (convertNodeScripts && nodeScriptPattern.test(candidate)) return { command: process.execPath, args: [candidate, ...args], via: "node" };
      return { command: candidate, args: [...args], via: "executable" };
    }
    return { command, args: [...args], via: "unresolved" };
  }
  if (hasPathSeparator(command)) {
    const path = resolve(cwd, command);
    if (convertNodeScripts && nodeScriptPattern.test(path) && isFile(path)) return { command: process.execPath, args: [path, ...args], via: "node" };
    return { command: path, args: [...args], via: isFile(path) ? "executable" : "unresolved" };
  }
  const found = findExecutable(command, env);
  return { command, args: [...args], via: found ? "executable" : "unresolved" };
}

function applyInvocation<T extends SpawnOptions | SpawnSyncOptions>(invocation: ExecutableInvocation, options: T): T {
  return invocation.windowsVerbatimArguments ? { ...options, windowsVerbatimArguments: true } : options;
}

export function spawnExecutable(command: string, args: readonly string[], options: SpawnOptions = {}, launch: LaunchOptions = {}) {
  const invocation = resolveExecutable(command, args, options.env ?? process.env, { ...launch, cwd: options.cwd });
  return spawn(invocation.command, invocation.args, applyInvocation(invocation, options));
}

export function spawnSyncExecutable(command: string, args: readonly string[], options: SpawnSyncOptions = {}, launch: LaunchOptions = {}): ReturnType<typeof spawnSync> {
  let invocation: ExecutableInvocation;
  try { invocation = resolveExecutable(command, args, options.env ?? process.env, { ...launch, cwd: options.cwd }); }
  catch (error) {
    // Match spawnSync: launch failures are reported through `error`, never as an exit status.
    const empty = options.encoding && options.encoding !== "buffer" ? "" : Buffer.alloc(0);
    return { pid: 0, output: [null, empty, empty], stdout: empty, stderr: empty, status: null, signal: null, error: error as Error };
  }
  return spawnSync(invocation.command, invocation.args, applyInvocation(invocation, options));
}

function hasExited(child: ChildProcess): boolean { return child.exitCode !== null || child.signalCode !== null; }

export async function terminateProcessTree(child: ChildProcess, signal: NodeJS.Signals): Promise<boolean> {
  const pid = child.pid;
  if (!pid) return false;
  if (isWindows) {
    // An exited child's PID may already belong to an unrelated process; never walk its tree.
    if (hasExited(child)) return false;
    // Windows has no POSIX signal delivery; forcefully terminate only this owned PID tree.
    void signal;
    const systemRoot = process.env.SystemRoot;
    const taskkill = systemRoot && isFile(join(systemRoot, "System32", "taskkill.exe")) ? join(systemRoot, "System32", "taskkill.exe") : "taskkill";
    const args = ["/pid", String(pid), "/t", "/f"];
    return new Promise((resolvePromise) => {
      let killer: ReturnType<typeof spawnExecutable>;
      try { killer = spawnExecutable(taskkill, args, { stdio: "ignore", windowsHide: true }, { kind: "executable" }); }
      catch { resolvePromise(false); return; }
      killer.once("error", () => { resolvePromise(false); });
      killer.once("close", (code) => { resolvePromise(code === 0); });
    });
  }
  try { process.kill(-pid, signal); return true; }
  catch {
    try { child.kill(signal); return true; }
    catch { return false; }
  }
}

/** Resolves true once the child has exited, or false after `timeoutMs`. */
export function waitForProcessExit(child: ChildProcess, timeoutMs = 10_000): Promise<boolean> {
  if (hasExited(child) || !child.pid) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const timer = setTimeout(() => { child.off("exit", onExit); resolvePromise(hasExited(child)); }, timeoutMs);
    const onExit = () => { clearTimeout(timer); resolvePromise(true); };
    child.once("exit", onExit);
  });
}

/**
 * Terminates an owned child tree and waits for the child to exit, escalating to SIGKILL after `graceMs`.
 * Unix trees require `detached: true` so the child leads its own process group. Other processes are never signalled.
 */
export async function stopProcessTree(child: ChildProcess, options: { signal?: NodeJS.Signals; graceMs?: number; timeoutMs?: number } = {}): Promise<{ exited: boolean; terminated: boolean }> {
  if (hasExited(child)) return { exited: true, terminated: false };
  let terminated = await terminateProcessTree(child, options.signal ?? "SIGTERM");
  let exited = await waitForProcessExit(child, options.graceMs ?? 2_000);
  if (!exited) {
    terminated = await terminateProcessTree(child, "SIGKILL") || terminated;
    exited = await waitForProcessExit(child, options.timeoutMs ?? 10_000);
  }
  return { exited, terminated };
}

export function findExecutable(command: string, env: NodeJS.ProcessEnv = process.env, cwd?: string): string | undefined {
  const base = childCwd(cwd);
  if (isWindows) {
    for (const candidate of windowsCandidates(command, env, base)) if (isFile(candidate)) return candidate;
    return undefined;
  }
  if (command.includes("/") || isAbsolute(command)) { const path = resolve(base, command); return existsSync(path) ? path : undefined; }
  const pathValue = envValue(env, "PATH") ?? "";
  return pathValue.split(delimiter).filter(Boolean).map((directory) => resolve(base, join(directory, command))).find(isFile);
}
