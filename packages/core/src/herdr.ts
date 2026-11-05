import { execFile } from "node:child_process";
import { errorText, isObject } from "./utils.js";

export type HerdrPaneAction = "live";
export type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";
export type HerdrAgentStatus = HerdrAgentState | "done";
export interface HerdrPaneStatus { state: HerdrAgentStatus }
export interface HerdrPaneRequest { action: HerdrPaneAction; cwd: string; command: string; paneId?: string }
export interface HerdrWorktreeRequest { cwd: string; branch: string; base: string; label?: string }
export interface HerdrWorktree { workspaceId: string; path: string; branch: string }
export interface HerdrListedWorktree { workspaceId: string; path: string; branch: string }
export interface HerdrWorktreeList { repoKey: string; worktrees: readonly HerdrListedWorktree[] }
export type HerdrCommandRunner = (args: readonly string[]) => Promise<string>;
export class HerdrCommandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HerdrCommandError";
  }
}
export const herdrCommandRunner: HerdrCommandRunner = (args) => new Promise<string>((resolve, reject) => {
  execFile("herdr", [...args], { encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 10_000 }, (error, stdout) => {
    if (error) { reject(new Error(error.message)); return; }
    resolve(stdout);
  });
});

export function herdrPaneId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.HERDR_ENV !== "1") return undefined;
  const paneId = env.HERDR_PANE_ID?.trim();
  return paneId || undefined;
}
export function herdrAvailable(env: NodeJS.ProcessEnv = process.env): boolean { return Boolean(herdrPaneId(env) && env.HERDR_SOCKET_PATH); }

function shellQuote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function json(value: string): unknown { return JSON.parse(value) as unknown; }
function record(value: unknown): Record<string, unknown> | undefined { return isObject(value) ? value : undefined; }
function paneLayout(value: unknown, targetPane: string): { width: number; height: number } {
  const root = record(value);
  const result = record(root?.result);
  const layout = record(result?.layout);
  const rawPanes = layout?.panes;
  if (!Array.isArray(rawPanes)) throw new Error("Herdr returned an invalid pane layout.");
  const panes: unknown[] = rawPanes;
  const pane = panes.find((candidate: unknown) => record(candidate)?.pane_id === targetPane);
  const rect = record(record(pane)?.rect);
  const width = rect?.width;
  const height = rect?.height;
  if (width === undefined || height === undefined || typeof width !== "number" || typeof height !== "number") throw new Error("Herdr returned an invalid target pane geometry.");
  return { width, height };
}
function splitPaneId(value: unknown): string {
  const pane = record(record(record(value)?.result)?.pane);
  const paneId = pane?.pane_id;
  if (typeof paneId !== "string" || !paneId) throw new Error("Herdr returned an invalid created pane ID.");
  return paneId;
}

function commandFor(request: HerdrPaneRequest): string {
  const environment = ["PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"].flatMap((name) => process.env[name] === undefined ? [] : [`${name}=${shellQuote(process.env[name] ?? "")}`]);
  return `cd ${shellQuote(request.cwd)} && ${environment.length ? `${environment.join(" ")} ` : ""}${request.command}`;
}

export function herdrPaneCommand(request: HerdrPaneRequest): string { return commandFor(request); }

export async function openHerdrPane(request: HerdrPaneRequest, runner: HerdrCommandRunner = herdrCommandRunner): Promise<string> {
  const targetPane = request.paneId ?? herdrPaneId();
  if (!targetPane) throw new Error("Pane actions require a Herdr-managed session with HERDR_PANE_ID.");
  if (!request.cwd) throw new Error("Pane actions require a working directory.");
  if (!request.command) throw new Error("Pane action is missing its command.");
  const layout = paneLayout(json(await runner(["pane", "layout", "--pane", targetPane])), targetPane);
  const direction = layout.width > layout.height ? "right" : "down";
  const paneId = splitPaneId(json(await runner(["pane", "split", targetPane, "--direction", direction, "--no-focus"])));
  try {
    await runner(["pane", "run", paneId, commandFor(request)]);
    return paneId;
  } catch (error) {
    await runner(["pane", "close", paneId]).catch(() => undefined);
    throw error;
  }
}

export function herdrWorkspaceEnvironment(env: NodeJS.ProcessEnv = process.env): boolean { return env.HERDR_ENV === "1" && Boolean(env.HERDR_SOCKET_PATH); }

export async function createHerdrWorktree(request: HerdrWorktreeRequest, runner: HerdrCommandRunner = herdrCommandRunner): Promise<HerdrWorktree> {
  if (!herdrWorkspaceEnvironment() || !request.cwd || !request.branch || !request.base) throw new Error("Herdr worktree creation is unavailable or missing required data.");
  let output: string;
  try {
    output = await runner(["worktree", "create", "--cwd", request.cwd, "--branch", request.branch, "--base", request.base, "--no-focus", ...(request.label ? ["--label", request.label] : [])]);
  } catch (error) {
    throw new HerdrCommandError(errorText(error));
  }
  const parsed = json(output);
  const result = record(record(parsed)?.result);
  const workspace = record(result?.workspace);
  const worktree = record(result?.worktree);
  const workspaceId = workspace?.workspace_id;
  const path = worktree?.path;
  const branch = worktree?.branch;
  if (typeof workspaceId !== "string" || !workspaceId || typeof path !== "string" || !path) throw new Error("Herdr returned an invalid worktree.");
  return { workspaceId, path, branch: typeof branch === "string" && branch ? branch : request.branch };
}

async function parseHerdrWorktreeList(args: readonly string[], runner: HerdrCommandRunner): Promise<HerdrWorktreeList> {
  const output = json(await runner(args));
  const result = record(record(output)?.result);
  const source = record(result?.source);
  const worktrees = result?.worktrees;
  if (typeof source?.repo_key !== "string" || !source.repo_key || !Array.isArray(worktrees)) throw new Error("Herdr returned an invalid worktree list.");
  const listed = worktrees.map((candidate): HerdrListedWorktree => {
    const item = record(candidate);
    const listedWorkspaceId = item?.open_workspace_id;
    const path = item?.path;
    const branch = item?.branch;
    if (typeof listedWorkspaceId !== "string" || !listedWorkspaceId || typeof path !== "string" || !path || typeof branch !== "string" || !branch) throw new Error("Herdr returned an invalid worktree list.");
    return { workspaceId: listedWorkspaceId, path, branch };
  });
  return { repoKey: source.repo_key, worktrees: listed };
}
export async function listHerdrWorktrees(workspaceId: string, runner: HerdrCommandRunner = herdrCommandRunner): Promise<HerdrWorktreeList> {
  if (!workspaceId) throw new Error("Herdr worktree workspace ID is missing.");
  return parseHerdrWorktreeList(["worktree", "list", "--workspace", workspaceId], runner);
}
export async function listHerdrWorktreesByCwd(cwd: string, runner: HerdrCommandRunner = herdrCommandRunner): Promise<HerdrWorktreeList> {
  if (!cwd) throw new Error("Herdr worktree repository path is missing.");
  return parseHerdrWorktreeList(["worktree", "list", "--cwd", cwd], runner);
}

export async function removeHerdrWorktree(workspaceId: string, runner: HerdrCommandRunner = herdrCommandRunner): Promise<void> {
  if (!workspaceId) throw new Error("Herdr worktree workspace ID is missing.");
  await runner(["worktree", "remove", "--workspace", workspaceId]);
}

export async function openHerdrLivePane(request: HerdrPaneRequest, runner: HerdrCommandRunner = herdrCommandRunner): Promise<string> {
  return openHerdrPane({ ...request, action: "live" }, runner);
}

function hasPiProcess(value: unknown, originatingEntrypoint?: string, allowNormalized = false): boolean {
  const result = record(record(value)?.result);
  const info = record(result?.process_info);
  const processes = info?.foreground_processes;
  if (!Array.isArray(processes)) return false;
  return processes.some((candidate) => {
    const process = record(candidate);
    const name = process?.name;
    const argv0 = process?.argv0;
    const argv = process?.argv;
    const commandLine = process?.cmdline;
    if (originatingEntrypoint) {
      if (Array.isArray(argv) && argv.some((value) => value === originatingEntrypoint) || typeof commandLine === "string" && commandLine.includes(originatingEntrypoint)) return true;
      return allowNormalized && (name === "pi" || argv0 === "pi" || Array.isArray(argv) && argv[0] === "pi");
    }
    return name === "pi" || argv0 === "pi" || Array.isArray(argv) && argv[0] === "pi" || typeof commandLine === "string" && commandLine.includes("/bin/pi");
  });
}
function isHerdrStatus(value: unknown): value is HerdrAgentStatus { return value === "idle" || value === "working" || value === "blocked" || value === "unknown" || value === "done"; }
function herdrAgentStatus(value: unknown): HerdrPaneStatus | undefined {
  const result = record(record(value)?.result);
  const agent = record(result?.agent);
  const rawState = agent?.agent_status;
  if (typeof rawState !== "string") return undefined;
  const state: HerdrAgentStatus = isHerdrStatus(rawState) ? rawState : "unknown";
  return { state };
}
export async function waitForHerdrPane(paneId: string, runner: HerdrCommandRunner = herdrCommandRunner, options: { signal?: AbortSignal; settled?: Promise<void>; intervalMs?: number; startupTimeoutMs?: number; exitGraceMs?: number; originatingEntrypoint?: string; onStatus?: (state: HerdrAgentStatus) => void | Promise<void> } = {}): Promise<"closed" | "exited" | "idle" | "settled" | "aborted"> {
  const intervalMs = options.intervalMs ?? 250;
  const startupTimeoutMs = options.startupTimeoutMs ?? 10000;
  const exitGraceMs = options.exitGraceMs ?? 5000;
  const startedAt = Date.now();
  const monitorController = new AbortController();
  const isAborted = (): boolean => monitorController.signal.aborted;
  let markAborted = (): void => {};
  const aborted = new Promise<"aborted">((resolve) => { markAborted = () => { resolve("aborted"); }; });
  const abortMonitor = (): void => { monitorController.abort(); markAborted(); };
  if (options.signal?.aborted) abortMonitor();
  else options.signal?.addEventListener("abort", abortMonitor, { once: true });
  const delay = (): Promise<void> => new Promise((resolve) => {
    if (isAborted()) { resolve(); return; }
    const timer = setTimeout(finish, intervalMs);
    function finish(): void { clearTimeout(timer); monitorController.signal.removeEventListener("abort", finish); resolve(); }
    monitorController.signal.addEventListener("abort", finish, { once: true });
  });
  const poll = async (): Promise<"closed" | "exited" | "idle" | "aborted"> => {
    let sawPi = false;
    let sawWorking = false;
    let missingSince: number | undefined;
    let processInfoFailedAt: number | undefined;
    for (;;) {
      if (isAborted()) return "aborted";
      let piRunning: boolean;
      try {
        const output = await runner(["pane", "process-info", "--pane", paneId]);
        if (isAborted()) return "aborted";
        piRunning = hasPiProcess(json(output), options.originatingEntrypoint, sawPi);
        processInfoFailedAt = undefined;
      } catch {
        if (isAborted()) return "aborted";
        processInfoFailedAt ??= Date.now();
        if (Date.now() - processInfoFailedAt >= exitGraceMs) return "closed";
        await delay();
        continue;
      }
      if (!piRunning) {
        if (sawPi) {
          missingSince ??= Date.now();
          if (Date.now() - missingSince >= exitGraceMs) return "exited";
        }
      } else {
        missingSince = undefined;
        if (!sawPi) { sawPi = true; }
        try {
          const output = await runner(["agent", "get", paneId]);
          if (isAborted()) return "aborted";
          const status = herdrAgentStatus(json(output));
          if (status) {
            if (status.state === "working") sawWorking = true;
            const shouldHandBack = options.settled === undefined && sawWorking && (status.state === "idle" || status.state === "done");
            try { await options.onStatus?.(status.state); } catch { /* Status notifications must not suppress pane handback. */ }
            if (isAborted()) return "aborted";
            if (shouldHandBack) return "idle";
          }
        } catch {
          if (isAborted()) return "aborted";
          /* The process monitor remains authoritative when no agent report is available. */
        }
      }
      if (!piRunning && !sawPi && Date.now() - startedAt >= startupTimeoutMs) throw new Error("Herdr pane did not start Pi.");
      await delay();
    }
  };
  const polling = poll();
  try {
    const result = await Promise.race(options.settled ? [polling, aborted, options.settled.then(() => "settled" as const)] : [polling, aborted]);
    if (result === "settled" || result === "aborted") monitorController.abort();
    return result;
  } finally {
    monitorController.abort();
    options.signal?.removeEventListener("abort", abortMonitor);
  }
}

export interface HerdrAgentReporter { reportSession(session: { sessionId?: string; sessionPath?: string }, sessionStartSource?: string): Promise<void>; reportState(state: HerdrAgentState, message?: string, session?: { sessionId?: string; sessionPath?: string }): Promise<void>; release(): Promise<void> }

export function createHerdrAgentReporter(paneId: string, agent: string, runner: HerdrCommandRunner = herdrCommandRunner): HerdrAgentReporter {
  const source = "herdr:pi-extensible-workflows";
  let sequence = Date.now() * 1000;
  let released = false;
  let queue = Promise.resolve();
  const next = () => ++sequence;
  const sessionArgs = (session?: { sessionId?: string; sessionPath?: string }): string[] => session?.sessionPath ? ["--agent-session-path", session.sessionPath] : session?.sessionId ? ["--agent-session-id", session.sessionId] : [];
  const retry = async (operation: () => Promise<string>) => {
    try { await operation(); } catch { try { await operation(); } catch { /* Herdr reporting must not stop the Pi session. */ } }
  };
  const enqueue = (operation: () => Promise<void>) => {
    const result = queue.then(operation);
    queue = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    async reportSession(session, sessionStartSource) {
      await enqueue(() => retry(() => runner(["pane", "report-agent-session", paneId, "--source", source, "--agent", agent, "--seq", String(next()), ...(sessionStartSource ? ["--session-start-source", sessionStartSource] : []), ...sessionArgs(session)])));
    },
    async reportState(state, message, session) {
      await enqueue(() => retry(() => runner(["pane", "report-agent", paneId, "--source", source, "--agent", agent, "--state", state, "--seq", String(next()), ...(message ? ["--message", message] : []), ...sessionArgs(session)])));
    },
    async release() {
      if (released) return;
      released = true;
      await enqueue(() => retry(() => runner(["pane", "release-agent", paneId, "--source", source, "--agent", agent, "--seq", String(next())])));
    },
  };
}
