import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearTrajectoryHost, setTrajectoryHost, type TrajectoryHost, type TrajectoryPublisherProvider } from "../../src/trajectory-host-handle.js";
import { errorText, isNodeError, object, positiveInteger } from "../../src/utils.js";
import { isTrajectoryAction, isTrajectoryTarget, trajectoryActionError, type TrajectoryPublisherInput } from "../../src/trajectory.js";
import { shareTrajectoryRun } from "./export.js";

const DEFAULT_TRAJECTORY_PORT = 7432;
const TRAJECTORY_IDLE_EXIT_MS = 5 * 60 * 1000;
const TRAJECTORY_LOCK_NAME = "trajectory.lock";

type TrajectoryPublisherClient = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "close" | "error" | "message", listener: (event: unknown) => void): void;
};

type TrajectoryPublisherConstructor = new (url: string) => TrajectoryPublisherClient;

type TrajectoryLock = { pid: number; port: number; fingerprint?: string };
export type TrajectoryController = {
  open(input: TrajectoryPublisherInput): Promise<{ port: number }>;
  close(): Promise<void>;
};
function trajectoryLockPath(agentDir: string): string { return join(agentDir, "pi-extensible-workflows", TRAJECTORY_LOCK_NAME); }
export function trajectoryServerPath(moduleDirectory = dirname(fileURLToPath(import.meta.url))): string {
  // A spawned bare node runs the compiled server beside this extension entry.
  const candidates = [join(moduleDirectory, "server.js"), join(moduleDirectory, "../../dist/trajectory/src/server.js")];
  const path = candidates.find((candidate) => existsSync(candidate));
  if (!path) throw new Error("Trajectory server implementation is unavailable");
  return path;
}
async function trajectoryFingerprint(serverPath: string): Promise<string> {
  const [serverBytes, htmlBytes] = await Promise.all([readFile(serverPath), readFile(join(dirname(serverPath), "assets/index.html"))]);
  return `${createHash("sha256").update(serverBytes).digest("hex")}:${createHash("sha256").update(htmlBytes).digest("hex")}`;
}
function publisherId(cwd: string, sessionId: string): string { return createHash("sha256").update(`${cwd}\n${sessionId}`).digest("hex").slice(0, 16); }
function trajectoryPort(value: unknown): number { return positiveInteger(value) && value <= 65535 ? value : DEFAULT_TRAJECTORY_PORT; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function serverHealthy(port: number): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(300) });
    return response.ok;
  } catch { return false; }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isNodeError(error, "ESRCH")) return false;
    throw error;
  }
}
function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isNodeError(error, "ESRCH")) throw error;
  }
}
async function stopStaleServer(lock: TrajectoryLock): Promise<void> {
  // During startup, the lock can name the current Pi process rather than the detached server.
  if (lock.pid === process.pid) return;
  signalProcess(lock.pid, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!await serverHealthy(lock.port)) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(50, remaining));
  }
  if (processAlive(lock.pid)) signalProcess(lock.pid, "SIGKILL");
}

async function readLock(path: string): Promise<TrajectoryLock | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
    if (!object(parsed) || !positiveInteger(parsed.pid) || !positiveInteger(parsed.port) || parsed.port > 65535) return undefined;
    const fingerprint = typeof parsed.fingerprint === "string" ? parsed.fingerprint : undefined;
    return { pid: parsed.pid, port: parsed.port, ...(fingerprint === undefined ? {} : { fingerprint }) };
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    return undefined;
  }
}

async function waitForServer(port: number): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (await serverHealthy(port)) return;
    await delay(50);
  }
  throw new Error(`Trajectory server did not start on port ${String(port)}`);
}
async function resolveExistingServer(lockPath: string, existing: TrajectoryLock, fingerprint: string): Promise<TrajectoryLock | undefined> {
  if (await serverHealthy(existing.port)) {
    if (existing.fingerprint === fingerprint) return existing;
    await stopStaleServer(existing);
    await rm(lockPath, { force: true });
    return undefined;
  }
  if (processAlive(existing.pid)) {
    try {
      await waitForServer(existing.port);
      return existing;
    } catch {
      // A live lock can still name the attaching process during startup; after the bounded wait, replace the unrecoverable startup owner and retry normally.
      await stopStaleServer(existing);
      await rm(lockPath, { force: true });
      return undefined;
    }
  }
  await rm(lockPath, { force: true });
  return undefined;
}

async function ensureTrajectoryServer(agentDir: string, configuredPort: number): Promise<{ port: number }> {
  const lockPath = trajectoryLockPath(agentDir);
  const serverPath = trajectoryServerPath();
  const fingerprint = await trajectoryFingerprint(serverPath);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const existing = await readLock(lockPath);
  if (existing) {
    const reused = await resolveExistingServer(lockPath, existing, fingerprint);
    if (reused) return reused;
  }
  let lockHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    lockHandle = await open(lockPath, "wx", 0o600);
    await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, port: configuredPort, fingerprint })}\n`, "utf8");
  } catch (error) {
    if (isNodeError(error, "EEXIST")) {
      const raced = await readLock(lockPath);
      if (raced) {
        const reused = await resolveExistingServer(lockPath, raced, fingerprint);
        if (reused) return reused;
      }
      await rm(lockPath, { force: true });
      lockHandle = await open(lockPath, "wx", 0o600);
      await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, port: configuredPort, fingerprint })}\n`, "utf8");
    } else {
      throw error;
    }
  } finally { await lockHandle?.close(); }
  try {
    const child = spawn(process.execPath, [serverPath, "--port", String(configuredPort), "--lock", lockPath, "--fingerprint", fingerprint], { detached: true, stdio: "ignore" });
    const startupError = new Promise<never>((_resolve, reject) => { child.once("error", reject); });
    child.unref();
    await Promise.race([waitForServer(configuredPort), startupError]);
    return { port: configuredPort };
  } catch (error) {
    await rm(lockPath, { force: true });
    throw error;
  }
}

function trajectoryWebSocket(): TrajectoryPublisherConstructor | undefined {
  const candidate = (globalThis as unknown as { WebSocket?: TrajectoryPublisherConstructor }).WebSocket;
  return typeof candidate === "function" ? candidate : undefined;
}

function openBrowser(url: string): void {
  const command = process.platform === "win32" ? "rundll32" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try {
    const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => undefined);
    child.unref();
  } catch { /* Browser launch is best effort; the URL remains in the notification. */ }
}

export function trajectoryUrl(port: number): string { return `http://127.0.0.1:${String(port)}/`; }
export function openTrajectoryUrl(url: string): void { openBrowser(url); }

export function createTrajectoryController(agentDir: string): TrajectoryController {
  let socket: TrajectoryPublisherClient | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let currentInput: TrajectoryPublisherInput | undefined;
  let closing = false;
  const stopPolling = () => { if (pollTimer !== undefined) { clearInterval(pollTimer); pollTimer = undefined; } };
  let stateLoad: Promise<void> | undefined;
  let lastState: string | undefined;
  const sendState = async (): Promise<void> => {
    if (stateLoad) return stateLoad;
    const task = (async () => {
      const activeSocket = socket;
      const input = currentInput;
      if (!activeSocket || !input || activeSocket.readyState !== 1) return;
      const runs = await input.loadRuns();
      const subagents = await input.loadSubagents();
      if (closing || socket !== activeSocket) return;
      const state = { type: "publisher:state", publisher: { id: publisherId(input.cwd, input.sessionId), title: `session ${input.sessionId.slice(0, 8)}`, cwd: input.cwd, sessionId: input.sessionId, themes: input.themes }, runs, subagents };
      const serialized = JSON.stringify(state);
      if (serialized === lastState) return;
      lastState = serialized;
      activeSocket.send(serialized);
    })();
    stateLoad = task;
    try { await task; }
    finally { if (stateLoad === task) stateLoad = undefined; }
  };
  const connect = async (port: number, input: TrajectoryPublisherInput): Promise<void> => {
    const Constructor = trajectoryWebSocket();
    if (!Constructor) throw new Error("Trajectory requires a WebSocket-capable Node runtime");
    const next = new Constructor(`ws://127.0.0.1:${String(port)}/ws`);
    socket = next;
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error); else resolve();
      };
      next.addEventListener("open", () => { finish(); });
      next.addEventListener("error", () => { finish(new Error("Could not connect to Trajectory server")); });
    });
    next.addEventListener("close", () => { if (socket === next) { socket = undefined; lastState = undefined; stopPolling(); } });
    next.addEventListener("message", (event) => {
      try {
        const message: unknown = JSON.parse(typeof event === "object" && event !== null && "data" in event ? String(event.data) : "");
        if (!object(message) || message.type !== "publisher:action" || typeof message.requestId !== "string") return;
        if (!isTrajectoryAction(message.action)) { next.send(JSON.stringify({ type: "publisher:action-result", requestId: message.requestId, ok: false, error: "Unsupported Trajectory action" })); return; }
        if (!isTrajectoryTarget(message.target)) { next.send(JSON.stringify({ type: "publisher:action-result", requestId: message.requestId, ok: false, error: "Invalid Trajectory action target" })); return; }
        const target = message.target;
        const actionError = trajectoryActionError(message.action, target);
        if (actionError !== undefined) { next.send(JSON.stringify({ type: "publisher:action-result", requestId: message.requestId, ok: false, error: actionError })); return; }
        if (message.action === "share") {
          // Share is served by the extension itself: it reads persisted state and needs no live host context.
          void shareTrajectoryRun({ cwd: input.cwd, sessionId: input.sessionId, runId: target.id }).then((result) => { next.send(JSON.stringify({ type: "publisher:action-result", requestId: message.requestId, ok: true, result })); }, (error: unknown) => { next.send(JSON.stringify({ type: "publisher:action-result", requestId: message.requestId, ok: false, error: errorText(error) })); }).catch(() => undefined);
          return;
        }
        void input.handleAction({ action: message.action, target, ...(typeof message.name === "string" ? { name: message.name } : {}), ...(message.payload === undefined ? {} : { payload: message.payload }) }).then((result) => { next.send(JSON.stringify({ type: "publisher:action-result", requestId: message.requestId, ok: true, ...(result === undefined ? {} : { result }) })); }, (error: unknown) => { next.send(JSON.stringify({ type: "publisher:action-result", requestId: message.requestId, ok: false, error: errorText(error) })); }).catch(() => undefined);
      } catch { /* Ignore malformed local browser messages. */ }
    });
    next.send(JSON.stringify({ type: "publisher:attach", publisherId: publisherId(input.cwd, input.sessionId) }));
  };
  return {
    async open(input) {
      closing = false;
      currentInput = input;
      const envPort = process.env.PI_WORKFLOW_TRAJECTORY_PORT;
      const configured = envPort !== undefined && /^\d+$/.test(envPort) ? trajectoryPort(Number(envPort)) : trajectoryPort(input.port);
      const server = await ensureTrajectoryServer(agentDir, configured);
      if (!socket || socket.readyState !== 1) await connect(server.port, input);
      stopPolling();
      await sendState();
      pollTimer = setInterval(() => { void sendState().catch(() => undefined); }, 1000);
      pollTimer.unref();
      return server;
    },
    async close() {
      closing = true;
      currentInput = undefined;
      stopPolling();
      const activeSocket = socket;
      socket = undefined;
      activeSocket?.close();
    },
  };
}


export { DEFAULT_TRAJECTORY_PORT, TRAJECTORY_IDLE_EXIT_MS, TRAJECTORY_LOCK_NAME };
export { exportTrajectoryRunHtml, shareTrajectoryRun, type TrajectoryExportOptions, type TrajectoryShareOptions, type TrajectoryShareResult } from "./export.js";

export type TrajectoryExtensionOptions = {
  controller?: TrajectoryController;
  openUrl?: (url: string) => void;
  agentDir?: string;
};

type TrajectoryExtensionAPI = Pick<ExtensionAPI, "on">;

export function registerTrajectoryExtension(pi: TrajectoryExtensionAPI, options: TrajectoryExtensionOptions = {}): TrajectoryHost {
  const controller = options.controller ?? createTrajectoryController(options.agentDir ?? getAgentDir());
  const openUrl = options.openUrl ?? openTrajectoryUrl;
  let autoAttached = false;
  const notify = (context: unknown, message: string, level: "info" | "error"): void => {
    const current = object(context) ? context : undefined;
    const ui = current && object(current.ui) ? current.ui : undefined;
    if (typeof ui?.notify === "function") Reflect.apply(ui.notify, ui, [message, level]);
  };
  const attach = async (provider: TrajectoryPublisherProvider, context: unknown): Promise<{ port: number } | undefined> => {
    try { return await controller.open(provider(context)); }
    catch (error) { notify(context, `Unable to attach Trajectory: ${errorText(error)}`, "error"); return undefined; }
  };
  const open = async (provider: TrajectoryPublisherProvider, context: unknown): Promise<void> => {
    const server = await attach(provider, context);
    if (server === undefined) return;
    const url = trajectoryUrl(server.port);
    openUrl(url);
    notify(context, `Trajectory opened at ${url}`, "info");
  };
  const host: TrajectoryHost = {
    open,
    autoAttach(provider, context) {
      if (autoAttached || !context.hasUI) return;
      autoAttached = true;
      void attach(provider, context);
    },
    close: () => controller.close(),
  };
  setTrajectoryHost(host);
  pi.on("session_shutdown", async () => {
    try { await host.close(); }
    finally { clearTrajectoryHost(host); }
  });
  return host;
}

export default function extension(pi: ExtensionAPI): void {
  registerTrajectoryExtension(pi);
}
