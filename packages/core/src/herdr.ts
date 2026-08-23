import { execFile } from "node:child_process";
import { isObject } from "./utils.js";

export type HerdrPaneAction = "live";
export type HerdrAgentState = "idle" | "working" | "blocked" | "unknown";
export type HerdrAgentStatus = HerdrAgentState | "done";
export interface HerdrPaneStatus { state: HerdrAgentStatus }
export interface HerdrPaneRequest { action: HerdrPaneAction; cwd: string; command: string; paneId?: string }
export interface HerdrWorkspacePaneRequest { cwd: string; workspaceLabel?: string; workspaceId?: string; tabLabel: string; command: string }
export interface HerdrWorkspacePane { workspaceId: string; tabId: string; paneId: string }
export type HerdrCommandRunner = (args: readonly string[]) => Promise<string>;

export const herdrCommandRunner: HerdrCommandRunner = (args) => new Promise<string>((resolve, reject) => {
  execFile("herdr", [...args], { encoding: "utf8", maxBuffer: 1024 * 1024 }, (error, stdout) => {
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

function resourceId(value: unknown, resource: string, field: string): string {
  const result = record(record(value)?.result);
  const item = record(result?.[resource]);
  const id = item?.[field];
  if (typeof id !== "string" || !id) throw new Error(`Herdr returned an invalid ${resource} ID.`);
  return id;
}

export async function openHerdrWorkspacePane(request: HerdrWorkspacePaneRequest, runner: HerdrCommandRunner = herdrCommandRunner): Promise<HerdrWorkspacePane> {
  if (!request.cwd || !request.tabLabel || !request.command || !request.workspaceId && !request.workspaceLabel) throw new Error("Herdr workspace pane is missing required data.");
  const created = json(await runner(request.workspaceId
    ? ["tab", "create", "--workspace", request.workspaceId, "--cwd", request.cwd, "--label", request.tabLabel, "--no-focus"]
    : ["workspace", "create", "--cwd", request.cwd, "--label", request.workspaceLabel ?? "", "--no-focus"]));
  const workspaceId = request.workspaceId ?? resourceId(created, "workspace", "workspace_id");
  let tabId = resourceId(created, "tab", "tab_id");
  let paneId = resourceId(created, "root_pane", "pane_id");
  try {
    if (!request.workspaceId) {
      await runner(["tab", "rename", tabId, request.workspaceLabel ?? ""]);
      const tab = json(await runner(["tab", "create", "--workspace", workspaceId, "--cwd", request.cwd, "--label", request.tabLabel, "--no-focus"]));
      tabId = resourceId(tab, "tab", "tab_id");
      paneId = resourceId(tab, "root_pane", "pane_id");
    }
    await runner(["pane", "run", paneId, commandFor({ action: "live", cwd: request.cwd, command: request.command })]);
    return { workspaceId, tabId, paneId };
  } catch (error) {
    await runner(request.workspaceId ? ["tab", "close", tabId] : ["workspace", "close", workspaceId]).catch(() => undefined);
    throw error;
  }
}

export async function openHerdrLivePane(request: HerdrPaneRequest | HerdrWorkspacePaneRequest, runner: HerdrCommandRunner = herdrCommandRunner): Promise<string | HerdrWorkspacePane> {
  if ("workspaceLabel" in request || "workspaceId" in request) return openHerdrWorkspacePane(request, runner);
  return openHerdrPane({ ...request, action: "live" }, runner);
}

function hasPiProcess(value: unknown, originatingEntrypoint?: string): boolean {
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
      return name === "pi" || argv0 === "pi" || Array.isArray(argv) && argv[0] === "pi";
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
export async function waitForHerdrPane(paneId: string, runner: HerdrCommandRunner = herdrCommandRunner, options: { signal?: AbortSignal; intervalMs?: number; startupTimeoutMs?: number; exitGraceMs?: number; originatingEntrypoint?: string; onStatus?: (state: HerdrAgentStatus) => void | Promise<void> } = {}): Promise<"closed" | "exited" | "idle" | "aborted"> {
  const intervalMs = options.intervalMs ?? 250;
  const startupTimeoutMs = options.startupTimeoutMs ?? 10000;
  const exitGraceMs = options.exitGraceMs ?? 5000;
  const startedAt = Date.now();
  let sawPi = false;
  let sawWorking = false;
  let missingSince: number | undefined;
  for (;;) {
    if (options.signal?.aborted) return "aborted";
    let piRunning: boolean;
    try {
      const output = await runner(["pane", "process-info", "--pane", paneId]);
      piRunning = hasPiProcess(json(output), options.originatingEntrypoint);
    } catch { return "closed"; }
    if (!piRunning) {
      if (sawPi) {
        missingSince ??= Date.now();
        if (Date.now() - missingSince >= exitGraceMs) return "exited";
      }
    } else {
      missingSince = undefined;
      if (!sawPi) { sawPi = true; }
      try {
        const status = herdrAgentStatus(json(await runner(["agent", "get", paneId])));
        if (status) {
          if (status.state === "working") sawWorking = true;
          const shouldHandBack = sawWorking && (status.state === "idle" || status.state === "done");
          try { await options.onStatus?.(status.state); } catch { /* Status notifications must not suppress pane handback. */ }
          if (shouldHandBack) return "idle";
        }
      } catch { /* The process monitor remains authoritative when no agent report is available. */ }
    }
    if (!piRunning && !sawPi && Date.now() - startedAt >= startupTimeoutMs) throw new Error("Herdr pane did not start Pi.");
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
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
