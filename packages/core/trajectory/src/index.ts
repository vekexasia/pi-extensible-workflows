import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearTrajectoryHost, setTrajectoryHost, type TrajectoryHost, type TrajectoryPublisherProvider } from "../../src/trajectory-host-handle.js";
import { errorText, isNodeError, object, positiveInteger } from "../../src/utils.js";
import { isTrajectoryAction, isTrajectoryTarget, trajectoryActionError, TRAJECTORY_MAX_TRANSCRIPT_BYTES, type TrajectoryPublisherInput, type TrajectoryPublisherMetadata, type TrajectoryTranscriptRequest, type TrajectoryTranscriptResult } from "../../src/trajectory.js";
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

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const MAX_LIVE_STATE_BYTES = MAX_FRAME_BYTES - 1024;
const MAX_TRANSCRIPT_REQUESTS = 64;
const TRANSCRIPT_REQUEST_TIMEOUT_MS = 10_000;
const RECONNECT_INITIAL_DELAY_MS = 100;
const RECONNECT_MAX_DELAY_MS = 5_000;
type LiveStateRecord = Record<string, unknown>;
type TranscriptRevision = { signature: string; revision: number };
type PendingTranscript = { generation: number; timer: ReturnType<typeof setTimeout>; publisherId: string; runId?: string; agentId?: string; subagentId?: string; revision?: number };
function isTimingEntry(value: unknown): boolean { return object(value) && value.type === "custom" && value.customType === "pi-workflows:tool-timing"; }
function boundedString(value: unknown, maxLength = 1024): unknown {
  if (typeof value !== "string") return value;
  const bytes = Buffer.from(value);
  return bytes.length > maxLength ? bytes.subarray(0, maxLength).toString("utf8") : value;
}
const MAX_LIVE_STRING_BYTES = 64 * 1024;
const MAX_LIVE_ARRAY_ENTRIES = 256;
const MAX_LIVE_OBJECT_KEYS = 64;
const LIVE_METADATA_ARRAY_KEYS = new Set(["agents", "runs", "subagents"]);
const LIVE_TRUNCATABLE_ARRAY_KEYS = new Set(["events", "phaseHistory"]);
const LIVE_METADATA_OBJECT_KEYS = new Set(["transcripts"]);
function boundedTiming(value: unknown): unknown[] {
  const entries = Array.isArray(value) ? value.filter(isTimingEntry) : [];
  const retained: unknown[] = [];
  let bytes = 2;
  for (const entry of entries) {
    let serialized: string;
    try { serialized = JSON.stringify(entry); } catch { continue; }
    const nextBytes = bytes + (retained.length ? 1 : 0) + Buffer.byteLength(serialized);
    if (nextBytes >= 64 * 1024) break;
    retained.push(entry);
    bytes = nextBytes;
  }
  return retained;
}
function boundedLiveValue(value: unknown, key = "", depth = 0): unknown {
  if (typeof value === "string") return boundedString(value, MAX_LIVE_STRING_BYTES);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (depth >= 12) return undefined;
  if (key === "timing") return boundedTiming(value);
  if (Array.isArray(value)) {
    const array = value as readonly unknown[];
    const maxEntries = LIVE_TRUNCATABLE_ARRAY_KEYS.has(key) ? MAX_LIVE_ARRAY_ENTRIES - 1 : MAX_LIVE_ARRAY_ENTRIES;
    const entries = key === "attemptDetails" ? array.slice(-8) : LIVE_METADATA_ARRAY_KEYS.has(key) ? array : array.length <= maxEntries ? array : [...array.slice(0, 32), ...array.slice(-maxEntries + 32)];
    const bounded = entries.map((entry) => boundedLiveValue(entry, "", depth + 1));
    if (entries.length !== array.length && LIVE_TRUNCATABLE_ARRAY_KEYS.has(key)) bounded.push({ type: "trajectory:truncated", field: key, omitted: array.length - entries.length });
    return bounded;
  }
  if (object(value)) {
    const result: LiveStateRecord = {};
    const properties = LIVE_METADATA_OBJECT_KEYS.has(key) ? Object.keys(value).sort() : Object.keys(value).sort().slice(0, MAX_LIVE_OBJECT_KEYS);
    for (const property of properties) result[property] = boundedLiveValue(value[property], property, depth + 1);
    return result;
  }
  return undefined;
}
function transcriptRevisionProjection(value: unknown, depth = 0): unknown {
  if (depth >= 8) return typeof value === "string" ? boundedString(value, 1024) : typeof value === "number" || typeof value === "boolean" || value === null ? value : undefined;
  if (Array.isArray(value)) {
    const entries = value as readonly unknown[];
    const sample = entries.length <= 16 ? entries : [...entries.slice(0, 8), ...entries.slice(-8)];
    return { length: entries.length, values: sample.map((entry) => transcriptRevisionProjection(entry, depth + 1)) };
  }
  if (object(value)) {
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort().slice(0, 32)) result[key] = transcriptRevisionProjection(value[key], depth + 1);
    return result;
  }
  return value;
}
function sourceMetadata(value: unknown, key: string, revisions: Map<string, TranscriptRevision>): LiveStateRecord {
  if (object(value) && !Array.isArray(value) && typeof value.revision === "number" && typeof value.status === "string") return { ...value, timing: boundedTiming(value.timing) };
  const entries = Array.isArray(value) ? value : [];
  const signature = createHash("sha256").update(JSON.stringify(transcriptRevisionProjection(entries))).digest("hex");
  const previous = revisions.get(key);
  const revision = previous?.signature === signature ? previous.revision : (previous?.revision ?? 0) + 1;
  revisions.set(key, { signature, revision });
  return { revision, status: entries.length ? "available" : "empty", timing: boundedTiming(entries) };
}
function projectRun(value: LiveStateRecord, key: string, revisions: Map<string, TranscriptRevision>): LiveStateRecord {
  const run = object(value.run) && !Array.isArray(value.run) ? value.run : {};
  const rawAgents: unknown[] = Array.isArray(run.agents) ? run.agents : [];
  const agents = rawAgents.map((agent: unknown): unknown => {
    if (!object(agent)) return agent;
    if (agent.activity === undefined) return agent;
    const activity = object(agent.activity) ? agent.activity : {};
    return { ...agent, activity: { ...activity, text: boundedString(activity.text) } };
  });
  const transcripts: LiveStateRecord = {};
  const source = object(value.transcripts) && !Array.isArray(value.transcripts) ? value.transcripts : {};
  for (const [agentId, transcript] of Object.entries(source)) transcripts[agentId] = sourceMetadata(transcript, `${key}\t${agentId}`, revisions);
  return { ...value, run: { ...run, agents }, transcripts };
}
function projectSubagent(value: LiveStateRecord, key: string, revisions: Map<string, TranscriptRevision>): LiveStateRecord {
  return { ...value, transcript: sourceMetadata(value.transcript, key, revisions) };
}
function projectPublisher(metadata: TrajectoryPublisherMetadata, publisher: LiveStateRecord, revisions: Map<string, TranscriptRevision>): LiveStateRecord {
  const publisherId = typeof publisher.id === "string" ? publisher.id : "";
  return { ...publisher, runs: metadata.runs.map((run) => projectRun(run as unknown as LiveStateRecord, `${publisherId}\t${run.run.id}`, revisions)), subagents: metadata.subagents.map((subagent) => projectSubagent(subagent as unknown as LiveStateRecord, `${publisherId}\tsubagent\t${subagent.id}`, revisions)) };
}
function minimalStatePublisher(publisher: LiveStateRecord): LiveStateRecord {
  return (boundedLiveValue(publisher) as LiveStateRecord | undefined) ?? {};
}
function publisherStateFrame(publisher: LiveStateRecord, runs: readonly unknown[], subagents: readonly unknown[], truncated = false): LiveStateRecord {
  const publisherSummary = { ...publisher };
  delete publisherSummary.runs;
  delete publisherSummary.subagents;
  return { type: "publisher:state", publisher: { ...publisherSummary, ...(truncated ? { truncated: true } : {}) }, runs, subagents, ...(truncated ? { truncated: true } : {}) };
}
function encodeLiveState(publisher: LiveStateRecord): string {
  const projected = minimalStatePublisher(publisher);
  const publisherJson = JSON.stringify(publisherStateFrame(projected, [], []).publisher);
  const runs: readonly unknown[] = Array.isArray(projected.runs) ? projected.runs : [];
  const subagents: readonly unknown[] = Array.isArray(projected.subagents) ? projected.subagents : [];
  const prefix = `{"type":"publisher:state","publisher":${publisherJson},"runs":[`;
  const baseBytes = Buffer.byteLength(`${prefix}],"subagents":[]}`);
  const truncatedBytes = Buffer.byteLength(',"truncated":true');
  const selectedRuns: string[] = [];
  const selectedSubagents: string[] = [];
  let bytes = baseBytes;
  const state = { truncated: false };
  const add = (serialized: string, target: string[]): boolean => {
    const nextBytes = bytes + Buffer.byteLength(serialized) + (target.length ? 1 : 0);
    if (nextBytes + truncatedBytes >= MAX_LIVE_STATE_BYTES) return false;
    target.push(serialized);
    bytes = nextBytes;
    return true;
  };
  const addValue = (value: unknown, target: string[]): void => {
    if (bytes + truncatedBytes >= MAX_LIVE_STATE_BYTES) { state.truncated = true; return; }
    let serializedValue: unknown;
    try { serializedValue = JSON.stringify(value); } catch { state.truncated = true; return; }
    if (typeof serializedValue !== "string" || !add(serializedValue, target)) state.truncated = true;
  };
  for (let index = 0; index < Math.max(runs.length, subagents.length); index += 1) {
    const run = runs[index];
    if (run !== undefined) addValue(run, selectedRuns);
    const subagent = subagents[index];
    if (subagent !== undefined) addValue(subagent, selectedSubagents);
  }
  return `${prefix}${selectedRuns.join(",")}],"subagents":[${selectedSubagents.join(",")}]${state.truncated ? ',"truncated":true' : ""}}`;
}
export function createTrajectoryController(agentDir: string): TrajectoryController {
  let socket: TrajectoryPublisherClient | undefined;
  let connectionGeneration = 0;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectLoop: Promise<void> | undefined;
  let currentInput: TrajectoryPublisherInput | undefined;
  let configuredPort: number | undefined;
  let closing = false;
  const transcriptRevisions = new Map<string, TranscriptRevision>();
  const pendingTranscripts = new Map<string, PendingTranscript>();
  const stopPolling = () => { if (pollTimer !== undefined) { clearInterval(pollTimer); pollTimer = undefined; } };
  const clearTranscriptRequests = () => { for (const request of pendingTranscripts.values()) clearTimeout(request.timer); pendingTranscripts.clear(); };
  const startPolling = () => { stopPolling(); pollTimer = setInterval(() => { void sendState().catch((error: unknown) => { if (!closing) console.error(`Trajectory state publish failed: ${errorText(error)}`); }); }, 1000); pollTimer.unref(); };
  let stateLoad: { socket: TrajectoryPublisherClient; task: Promise<void> } | undefined;
  let lastState: string | undefined;
  const publisherValue = (input: TrajectoryPublisherInput): LiveStateRecord => ({ id: publisherId(input.cwd, input.sessionId), title: `session ${input.sessionId.slice(0, 8)}`, cwd: input.cwd, sessionId: input.sessionId, themes: input.themes, connected: true });
  const sendState = async (): Promise<void> => {
    const activeSocket = socket;
    if (activeSocket !== undefined && stateLoad?.socket === activeSocket) return stateLoad.task;
    const task = (async () => {
      const input = currentInput;
      if (!activeSocket || !input || activeSocket.readyState !== 1) return;
      const metadata = await input.loadMetadata();
      if (closing || socket !== activeSocket) return;
      const publisher = projectPublisher(metadata, publisherValue(input), transcriptRevisions);
      const serialized = encodeLiveState(publisher);
      if (serialized === lastState) return;
      lastState = serialized;
      activeSocket.send(serialized);
    })();
    if (activeSocket !== undefined) stateLoad = { socket: activeSocket, task };
    try { await task; }
    finally { if (stateLoad?.task === task) stateLoad = undefined; }
  };
  const abandonSocket = (candidate: TrajectoryPublisherClient): void => {
    if (socket !== candidate) return;
    socket = undefined;
    lastState = undefined;
    stopPolling();
    clearTranscriptRequests();
    candidate.close();
  };
  const publishConnectedState = async (next: TrajectoryPublisherClient, input: TrajectoryPublisherInput): Promise<void> => {
    startPolling();
    try {
      await sendState();
      if (closing || currentInput !== input) return;
      if (socket !== next || next.readyState !== 1) throw new Error("Trajectory connection closed before state publish");
    }
    catch (error) {
      if (!closing && socket === next && currentInput === input) abandonSocket(next);
      throw error;
    }
  };
  const transcriptFromFallback = async (input: TrajectoryPublisherInput, request: TrajectoryTranscriptRequest): Promise<TrajectoryTranscriptResult> => {
    const boundedTranscriptResult = (result: TrajectoryTranscriptResult): TrajectoryTranscriptResult => {
      try { if (result.status === "available" && Buffer.byteLength(JSON.stringify(result.entries)) > TRAJECTORY_MAX_TRANSCRIPT_BYTES) return { status: "oversized", revision: result.revision, entries: [], error: "Transcript is too large" }; } catch { return { status: "failed", revision: result.revision, entries: [], error: "Transcript failed" }; }
      return result;
    };
    const boundedResult = (entries: readonly unknown[], revision: number): TrajectoryTranscriptResult => { try { if (Buffer.byteLength(JSON.stringify(entries)) > TRAJECTORY_MAX_TRANSCRIPT_BYTES) return { status: "oversized", revision, entries: [], error: "Transcript is too large" }; } catch { return { status: "failed", revision, entries: [], error: "Transcript failed" }; } return { status: entries.length ? "available" : "empty", revision, entries }; };
    if (input.loadTranscript) {
      const result = await input.loadTranscript(request);
      const revisionChanged = request.revision !== undefined && result.revision !== request.revision && result.status !== "missing" && result.status !== "failed" && result.status !== "oversized" && result.status !== "disconnected";
      return boundedTranscriptResult(revisionChanged ? { ...result, status: "available", entries: [], error: "Transcript revision is stale" } : result);
    }
    if (request.runId !== undefined && request.agentId !== undefined && request.subagentId === undefined) {
      const runs = await input.loadRuns();
      const run = runs.find((candidate) => candidate.run.id === request.runId);
      const entries = run?.transcripts[request.agentId];
      const metadata = sourceMetadata(entries, `${publisherId(input.cwd, input.sessionId)}\t${request.runId}\t${request.agentId}`, transcriptRevisions);
      if (request.revision !== undefined && request.revision !== metadata.revision) return { status: "available", revision: Number(metadata.revision), entries: [], error: "Transcript revision is stale" };
      if (run === undefined || entries === undefined) return { status: "missing", revision: Number(metadata.revision), entries: [], error: "Transcript not found" };
      return boundedResult(entries, Number(metadata.revision));
    }
    if (request.subagentId !== undefined && request.runId === undefined && request.agentId === undefined) {
      const subagents = await input.loadSubagents();
      const subagent = subagents.find((candidate) => candidate.id === request.subagentId);
      const entries = subagent?.transcript;
      const metadata = sourceMetadata(entries, `${publisherId(input.cwd, input.sessionId)}\tsubagent\t${request.subagentId}`, transcriptRevisions);
      if (request.revision !== undefined && request.revision !== metadata.revision) return { status: "available", revision: Number(metadata.revision), entries: [], error: "Transcript revision is stale" };
      if (subagent === undefined || entries === undefined) return { status: "missing", revision: Number(metadata.revision), entries: [], error: "Transcript not found" };
      return boundedResult(entries, Number(metadata.revision));
    }
    return { status: "missing", revision: 0, entries: [], error: "Transcript not found" };
  };
  const sendTranscriptResult = (next: TrajectoryPublisherClient, generation: number, message: LiveStateRecord, result: TrajectoryTranscriptResult): void => {
    const requestId = String(message.requestId);
    const pending = pendingTranscripts.get(requestId);
    if (!pending || pending.generation !== generation || socket !== next || closing || pending.publisherId !== message.publisherId || pending.runId !== message.runId || pending.agentId !== message.agentId || pending.subagentId !== message.subagentId || pending.revision !== message.revision) return;
    clearTimeout(pending.timer);
    pendingTranscripts.delete(requestId);
    const failed = result.error !== undefined || result.status === "missing" || result.status === "failed" || result.status === "oversized" || result.status === "disconnected";
    let safeResult = result;
    try { if (!failed && Buffer.byteLength(JSON.stringify(result.entries)) > TRAJECTORY_MAX_TRANSCRIPT_BYTES) safeResult = { status: "oversized", revision: result.revision, entries: [], error: "Transcript is too large" }; } catch { safeResult = { status: "failed", revision: result.revision, entries: [], error: "Transcript failed" }; }
    const safeFailed = safeResult.error !== undefined || safeResult.status === "missing" || safeResult.status === "failed" || safeResult.status === "oversized" || safeResult.status === "disconnected";
    const error = typeof safeResult.error === "string" ? safeResult.error.slice(0, 1024) : safeResult.status;
    next.send(JSON.stringify({ type: "publisher:transcript-result", requestId: message.requestId, publisherId: message.publisherId, ...(message.runId === undefined ? {} : { runId: message.runId }), ...(message.agentId === undefined ? {} : { agentId: message.agentId }), ...(message.subagentId === undefined ? {} : { subagentId: message.subagentId }), ...(message.revision === undefined ? {} : { requestedRevision: message.revision }), ok: !safeFailed, status: safeResult.status, revision: safeResult.revision, ...(safeFailed ? { error } : { entries: safeResult.entries }) }));
  };
  const handleTranscriptRequest = (next: TrajectoryPublisherClient, generation: number, message: LiveStateRecord, input: TrajectoryPublisherInput): void => {
    const requestId = typeof message.requestId === "string" ? message.requestId : "";
    const revision = typeof message.revision === "number" && Number.isSafeInteger(message.revision) && message.revision >= 0 ? message.revision : undefined;
    const target = { ...(typeof message.runId === "string" ? { runId: message.runId } : {}), ...(typeof message.agentId === "string" ? { agentId: message.agentId } : {}), ...(typeof message.subagentId === "string" ? { subagentId: message.subagentId } : {}), ...(revision === undefined ? {} : { requestedRevision: revision }) };
    const existing = pendingTranscripts.get(requestId);
    if (!requestId || (existing === undefined && pendingTranscripts.size >= MAX_TRANSCRIPT_REQUESTS)) { next.send(JSON.stringify({ type: "publisher:transcript-result", requestId, publisherId: message.publisherId, ...target, ok: false, status: "failed", revision: revision ?? 0, error: "Too many transcript requests" })); return; }
    if (existing !== undefined) {
      const original: LiveStateRecord = { requestId, publisherId: existing.publisherId, ...(existing.runId === undefined ? {} : { runId: existing.runId }), ...(existing.agentId === undefined ? {} : { agentId: existing.agentId }), ...(existing.subagentId === undefined ? {} : { subagentId: existing.subagentId }), ...(existing.revision === undefined ? {} : { revision: existing.revision }) };
      sendTranscriptResult(next, generation, original, { status: "failed", revision: existing.revision ?? 0, entries: [], error: "Duplicate transcript request" });
      return;
    }
    const timer = setTimeout(() => {
      const pending = pendingTranscripts.get(requestId);
      if (!pending || pending.timer !== timer) return;
      pendingTranscripts.delete(requestId);
      if (socket === next && !closing && next.readyState === 1) next.send(JSON.stringify({ type: "publisher:transcript-result", requestId, publisherId: pending.publisherId, ...(pending.runId === undefined ? {} : { runId: pending.runId }), ...(pending.agentId === undefined ? {} : { agentId: pending.agentId }), ...(pending.subagentId === undefined ? {} : { subagentId: pending.subagentId }), ...(pending.revision === undefined ? {} : { requestedRevision: pending.revision }), ok: false, status: "failed", revision: pending.revision ?? 0, error: "Transcript request timed out" }));
    }, TRANSCRIPT_REQUEST_TIMEOUT_MS);
    const pending: PendingTranscript = { generation, timer, publisherId: message.publisherId as string, ...(typeof message.runId === "string" ? { runId: message.runId } : {}), ...(typeof message.agentId === "string" ? { agentId: message.agentId } : {}), ...(typeof message.subagentId === "string" ? { subagentId: message.subagentId } : {}), ...(revision === undefined ? {} : { revision }) };
    pendingTranscripts.set(requestId, pending);
    const request = { ...(typeof message.runId === "string" ? { runId: message.runId } : {}), ...(typeof message.agentId === "string" ? { agentId: message.agentId } : {}), ...(typeof message.subagentId === "string" ? { subagentId: message.subagentId } : {}), ...(revision === undefined ? {} : { revision }) };
    const requestMessage: LiveStateRecord = { ...message, revision };
    void transcriptFromFallback(input, request).then((result) => { sendTranscriptResult(next, generation, requestMessage, result); }, (error: unknown) => { sendTranscriptResult(next, generation, requestMessage, { status: "failed", revision: 0, entries: [], error: errorText(error) }); }).catch(() => undefined);
  };
  const connect = async (port: number, input: TrajectoryPublisherInput): Promise<void> => {
    const Constructor = trajectoryWebSocket();
    if (!Constructor) throw new Error("Trajectory requires a WebSocket-capable Node runtime");
    const next = new Constructor(`ws://127.0.0.1:${String(port)}/ws`);
    const generation = connectionGeneration + 1;
    let established = false;
    connectionGeneration = generation;
    socket = next;
    const onClose = () => {
      if (socket !== next) return;
      socket = undefined;
      lastState = undefined;
      stopPolling();
      clearTranscriptRequests();
      if (established && !closing) scheduleReconnect();
    };
    next.addEventListener("close", onClose);
    next.addEventListener("error", onClose);
    next.addEventListener("message", (event) => {
      try {
        const message: unknown = JSON.parse(typeof event === "object" && event !== null && "data" in event ? String(event.data) : "");
        if (!object(message)) return;
        if (message.type === "publisher:replaced") { established = false; return; }
        if (message.type === "publisher:transcript" && typeof message.requestId === "string" && typeof message.publisherId === "string" && (typeof message.runId === "string" && typeof message.agentId === "string" || typeof message.subagentId === "string")) { handleTranscriptRequest(next, generation, message, input); return; }
        if (message.type !== "publisher:action" || typeof message.requestId !== "string") return;
        const sendActionResponse = (response: LiveStateRecord): void => { if (socket !== next || closing || next.readyState !== 1) return; let serialized: string; try { serialized = JSON.stringify(response); } catch { serialized = JSON.stringify({ type: "publisher:action-result", requestId: response.requestId, publisherId: response.publisherId, ok: false, error: "Trajectory action result is invalid" }); } if (Buffer.byteLength(serialized) >= MAX_FRAME_BYTES) serialized = JSON.stringify({ type: "publisher:action-result", requestId: response.requestId, publisherId: response.publisherId, ok: false, error: "Trajectory action result is too large" }); next.send(serialized); };
        const sendActionResult = (value: unknown): void => { sendActionResponse({ type: "publisher:action-result", requestId: message.requestId, publisherId: publisherId(input.cwd, input.sessionId), ...object(value) ? { ok: true, result: value } : { ok: true } }); };
        if (!isTrajectoryAction(message.action)) { sendActionResponse({ type: "publisher:action-result", requestId: message.requestId, publisherId: publisherId(input.cwd, input.sessionId), ok: false, error: "Unsupported Trajectory action" }); return; }
        if (!isTrajectoryTarget(message.target)) { sendActionResponse({ type: "publisher:action-result", requestId: message.requestId, publisherId: publisherId(input.cwd, input.sessionId), ok: false, error: "Invalid Trajectory action target" }); return; }
        const target = message.target;
        const actionError = trajectoryActionError(message.action, target);
        if (actionError !== undefined) { sendActionResponse({ type: "publisher:action-result", requestId: message.requestId, publisherId: publisherId(input.cwd, input.sessionId), ok: false, error: actionError }); return; }
        if (message.action === "share") {
          void shareTrajectoryRun({ cwd: input.cwd, sessionId: input.sessionId, runId: target.id }).then((result) => { sendActionResult(result); }, (error: unknown) => { sendActionResponse({ type: "publisher:action-result", requestId: message.requestId, publisherId: publisherId(input.cwd, input.sessionId), ok: false, error: errorText(error).slice(0, 1024) }); }).catch(() => undefined);
          return;
        }
        void input.handleAction({ action: message.action, target, ...(typeof message.name === "string" ? { name: message.name } : {}), ...(message.payload === undefined ? {} : { payload: message.payload }) }).then((result) => { sendActionResult(result); }, (error: unknown) => { sendActionResponse({ type: "publisher:action-result", requestId: message.requestId, publisherId: publisherId(input.cwd, input.sessionId), ok: false, error: errorText(error).slice(0, 1024) }); }).catch(() => undefined);
      } catch { /* Ignore malformed local browser messages. */ }
    });
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => { if (settled) return; settled = true; if (error) reject(error); else resolve(); };
      next.addEventListener("open", () => { finish(); });
      next.addEventListener("error", () => { finish(new Error("Could not connect to Trajectory server")); });
      next.addEventListener("close", () => { finish(new Error("Could not connect to Trajectory server")); });
    });
    if (closing || currentInput !== input || socket !== next || next.readyState !== 1) { next.close(); throw new Error("Trajectory connection was replaced"); }
    established = true;
    next.send(JSON.stringify({ type: "publisher:attach", publisherId: publisherId(input.cwd, input.sessionId) }));
  };
  let reconnectCancel: (() => void) | undefined;
  const waitReconnect = (ms: number): Promise<void> => new Promise((resolve) => { const timer = setTimeout(() => { if (reconnectTimer === timer) reconnectTimer = undefined; reconnectCancel = undefined; resolve(); }, ms); timer.unref(); reconnectTimer = timer; reconnectCancel = () => { clearTimeout(timer); if (reconnectTimer === timer) reconnectTimer = undefined; reconnectCancel = undefined; resolve(); }; });
  const scheduleReconnect = (): void => {
    if (closing || reconnectLoop !== undefined || configuredPort === undefined) return;
    const reconnectInput = (): { port: number; input: TrajectoryPublisherInput } | undefined => closing || socket !== undefined || currentInput === undefined || configuredPort === undefined ? undefined : { port: configuredPort, input: currentInput };
    reconnectLoop = (async () => {
      let backoff = RECONNECT_INITIAL_DELAY_MS;
      while (reconnectInput() !== undefined) {
        await waitReconnect(backoff);
        const active = reconnectInput();
        if (active === undefined) return;
        const { port, input } = active;
        const isCurrent = (): boolean => !closing && currentInput === input && configuredPort === port;
        try {
          const server = await ensureTrajectoryServer(agentDir, port);
          if (!isCurrent()) return;
          await connect(server.port, input);
          if (!isCurrent()) return;
          const activeSocket = socket;
          if (!activeSocket) throw new Error("Trajectory connection closed before state publish");
          await publishConnectedState(activeSocket, input);
          return;
        } catch (error) { console.error(`Trajectory reconnect failed: ${errorText(error)}`); backoff = Math.min(RECONNECT_MAX_DELAY_MS, backoff * 2); }
      }
    })().finally(() => { reconnectLoop = undefined; if (!closing && socket === undefined && currentInput !== undefined && configuredPort !== undefined) scheduleReconnect(); });
  };
  return {
    async open(input) {
      closing = false;
      currentInput = input;
      const envPort = process.env.PI_WORKFLOW_TRAJECTORY_PORT;
      configuredPort = envPort !== undefined && /^\d+$/.test(envPort) ? trajectoryPort(Number(envPort)) : trajectoryPort(input.port);
      const server = await ensureTrajectoryServer(agentDir, configuredPort);
      if (!socket || socket.readyState !== 1) await connect(server.port, input);
      stopPolling();
      const activeSocket = socket;
      if (!activeSocket) throw new Error("Trajectory connection closed before state publish");
      await publishConnectedState(activeSocket, input);
      return server;
    },
    async close() {
      closing = true;
      const input = currentInput;
      const reconnect = reconnectLoop;
      currentInput = undefined;
      configuredPort = undefined;
      reconnectCancel?.();
      stopPolling();
      clearTranscriptRequests();
      lastState = undefined;
      connectionGeneration += 1;
      const activeSocket = socket;
      if (activeSocket?.readyState === 1 && input) activeSocket.send(JSON.stringify({ type: "publisher:detach", publisherId: publisherId(input.cwd, input.sessionId) }));
      socket = undefined;
      activeSocket?.close();
      if (reconnect) await reconnect;
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
