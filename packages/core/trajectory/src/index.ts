import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { clearTrajectoryHost, setTrajectoryHost, type TrajectoryHost, type TrajectoryPublisherProvider } from "../../src/trajectory-host-handle.js";
import { atomicJson } from "../../src/io.js";
import { errorText, isNodeError, object, positiveInteger } from "../../src/utils.js";
import { isTimingTranscriptEntry, isTrajectoryAction, isTrajectoryTarget, trajectoryActionError, TRAJECTORY_MAX_TRANSCRIPT_BYTES, type TrajectoryPublisherInput, type TrajectoryPublisherMetadata, type TrajectoryTranscriptRequest, type TrajectoryTranscriptResult } from "../../src/trajectory.js";
import { shareTrajectoryRun } from "./export.js";
import { SEMANTIC_MAP_BUILD_STAMP } from "./semantic-map-assets.js";
import { identityOf, processConfirmed, processLive, processStart, recordStartupServer, releaseStartupMutex, tryAcquireStartupMutex } from "./startup-mutex.js";

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

type TrajectoryLock = { pid: number; port: number; fingerprint?: string; startedAt?: number; start?: string };
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
  const serverBytes = await readFile(serverPath);
  return `${createHash("sha256").update(serverBytes).digest("hex")}:${SEMANTIC_MAP_BUILD_STAMP}`;
}
function publisherId(cwd: string, sessionId: string): string { return createHash("sha256").update(`${cwd}\n${sessionId}`).digest("hex").slice(0, 16); }
function trajectoryPort(value: unknown): number { return positiveInteger(value) && value <= 65535 ? value : DEFAULT_TRAJECTORY_PORT; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

type ServerHealth = { pid?: number; fingerprint?: string; startedAt?: number };
// Servers older than the identity fields answer `{ ok: true }` alone, so every field is optional.
async function serverHealth(port: number): Promise<ServerHealth | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(300) });
    if (!response.ok) return undefined;
    const body: unknown = await response.json().catch(() => undefined);
    if (!object(body)) return {};
    return { ...(positiveInteger(body.pid) ? { pid: body.pid } : {}), ...(typeof body.fingerprint === "string" ? { fingerprint: body.fingerprint } : {}), ...(positiveInteger(body.startedAt) ? { startedAt: body.startedAt } : {}) };
  } catch { return undefined; }
}
async function serverHealthy(port: number): Promise<boolean> { return await serverHealth(port) !== undefined; }

function signalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch (error) {
    if (!isNodeError(error, "ESRCH")) throw error;
  }
}
// Called right after /health named this pid; its start, read now, tells a later reuse of the pid apart before SIGKILL.
// Returns only once the server is gone: a server that may still serve keeps its lock and port, so nothing replaces it.
async function stopStaleServer(pid: number, port: number): Promise<void> {
  const server = identityOf(pid);
  if (!processLive(server)) return;
  signalProcess(pid, "SIGTERM");
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (!await serverHealthy(port)) break;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(50, remaining));
  }
  // Without a confirmed identity the pid may now be an unrelated process, so SIGTERM is never escalated.
  if (processConfirmed(server)) signalProcess(pid, "SIGKILL");
  for (let attempt = 0; attempt < 50 && processLive(server); attempt += 1) await delay(20);
  if (processLive(server)) throw new Error(`Stale Trajectory server ${String(pid)} on port ${String(port)} did not stop; stop it and retry`);
}

// Only a missing or malformed lock reads as absent; any other read error leaves its owner unknown, so it is thrown.
async function readLock(path: string): Promise<TrajectoryLock | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) { if (isNodeError(error, "ENOENT")) return undefined; throw error; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return undefined; }
  if (!object(parsed) || !positiveInteger(parsed.pid) || !positiveInteger(parsed.port) || parsed.port > 65535) return undefined;
  const fingerprint = typeof parsed.fingerprint === "string" ? parsed.fingerprint : undefined;
  const startedAt = positiveInteger(parsed.startedAt) ? parsed.startedAt : undefined;
  const start = typeof parsed.start === "string" ? parsed.start : undefined;
  return { pid: parsed.pid, port: parsed.port, ...(fingerprint === undefined ? {} : { fingerprint }), ...(startedAt === undefined ? {} : { startedAt }), ...(start === undefined ? {} : { start }) };
}

// One holder runs at most two bounded health waits (60 × (300 + 50) ms each) and one stop (3 s, its final health check, and 1 s for its exit).
const STARTUP_MUTEX_WAIT_MS = 2 * 60 * (300 + 50) + 3_000 + 1_000 + 1_000;
async function acquireStartupMutex(lockPath: string): Promise<string> {
  const deadline = Date.now() + STARTUP_MUTEX_WAIT_MS;
  for (;;) {
    const token = await tryAcquireStartupMutex(lockPath);
    if (token !== undefined) return token;
    if (Date.now() >= deadline) throw new Error("Another Pi is still starting Trajectory; retry");
    // Contenders that saw each other both back off; a random delay keeps them from retrying in step.
    await delay(25 + Math.floor(Math.random() * 50));
  }
}
type IdentifiedHealth = ServerHealth & { pid: number; fingerprint: string };
// Only a Trajectory server reports a fingerprint; any other service answering /health is never signalled.
function isTrajectoryServer(health: ServerHealth | undefined): health is IdentifiedHealth { return health?.pid !== undefined && health.fingerprint !== undefined; }
// A lock proves which process serves its port only when that process reports the same identity.
function ownsLock(health: ServerHealth | undefined, lock: TrajectoryLock): health is IdentifiedHealth {
  return isTrajectoryServer(health) && health.pid === lock.pid && (lock.startedAt === undefined || lock.startedAt === health.startedAt);
}
async function awaitHealth(port: number, accept: (health: ServerHealth) => boolean, stopped: () => boolean = () => false): Promise<ServerHealth | undefined> {
  for (let attempt = 0; attempt < 60 && !stopped(); attempt += 1) {
    const health = await serverHealth(port);
    if (health !== undefined && accept(health)) return health;
    await delay(50);
  }
  return undefined;
}

async function startServer(lockPath: string, serverPath: string, fingerprint: string, port: number, startupToken: string): Promise<{ port: number }> {
  // NOTE: under a Bun-compiled pi binary process.execPath is the pi CLI, and Bun's node:http never writes the WebSocket 101 upgrade (oven-sh/bun#28157), so the server must run on a real node from PATH.
  const child = spawn(process.versions.bun ? "node" : process.execPath, [serverPath, "--port", String(port), "--lock", lockPath, "--fingerprint", fingerprint, "--startup", startupToken], { detached: true, stdio: "ignore" });
  const startup: { ended: boolean; error?: Error } = { ended: false };
  const exited = new Promise<void>((resolve) => {
    child.once("error", (error) => { startup.error = error; startup.ended = true; resolve(); });
    child.once("exit", () => { startup.ended = true; resolve(); });
  });
  try {
    if (child.pid !== undefined) recordStartupServer(lockPath, startupToken, child.pid);
    const health = await awaitHealth(port, (candidate) => candidate.pid === child.pid && candidate.fingerprint === fingerprint, () => startup.ended);
    if (startup.error !== undefined) throw startup.error;
    // The server publishes its lock before it answers, so readiness is reported only once both agree.
    const lock = health === undefined ? undefined : await readLock(lockPath);
    // The detached server outlives this Pi only once it is ready; until then this Pi keeps waiting for its exit.
    if (lock !== undefined && ownsLock(health, lock) && lock.port === port && lock.fingerprint === fingerprint) { child.unref(); return { port }; }
    throw new Error(`Trajectory server did not start on port ${String(port)}`);
  } catch (error) {
    // A server outliving its startup could later publish over another owner's lock, so it is stopped before the mutex is released.
    if (!startup.ended) { child.kill("SIGKILL"); await exited; }
    if ((await readLock(lockPath))?.pid === child.pid) await rm(lockPath, { force: true });
    throw error;
  }
}

// Runs under the startup mutex, so no other Pi or idle server changes the lock meanwhile.
async function startOrReuseServer(lockPath: string, serverPath: string, fingerprint: string, configuredPort: number, startupToken: string): Promise<{ port: number }> {
  const existing = await readLock(lockPath);
  if (existing) {
    let health = await serverHealth(existing.port);
    // A live lock owner can be a server still starting or one too loaded to answer in time.
    if (health === undefined && processLive(existing)) health = await awaitHealth(existing.port, (candidate) => candidate.pid === existing.pid);
    const lock = health === undefined ? existing : await readLock(lockPath) ?? existing;
    if (ownsLock(health, lock)) {
      if (lock.fingerprint === fingerprint && health.fingerprint === fingerprint) return { port: lock.port };
      await stopStaleServer(health.pid, lock.port);
    } else if (!isTrajectoryServer(health) && lock.pid !== process.pid && processLive(lock)) {
      // Unidentified is not dead: a suspended or overloaded owner can resume serving, so its lock stays and no second server is started beside it.
      // Only a lock naming this Pi, left by an older release's startup reservation, is known not to name a server.
      throw new Error(health === undefined ? `Trajectory server ${String(lock.pid)} named by ${lockPath} is alive but not answering on port ${String(lock.port)}; retry once it answers, or remove the lock if that process is not a Trajectory server` : `Trajectory port ${String(lock.port)} is held by another Trajectory server; stop it and retry`);
    }
    // Any other owner is dead, or another Trajectory server holds its port, so it is never signalled.
    await rm(lockPath, { force: true });
  }
  const occupant = await serverHealth(configuredPort);
  if (occupant !== undefined) {
    if (!isTrajectoryServer(occupant)) throw new Error(`Trajectory port ${String(configuredPort)} is held by another Trajectory server; stop it and retry`);
    if (occupant.fingerprint === fingerprint && occupant.startedAt !== undefined) {
      // This server lost its lock; restoring it keeps every healthy server named by the lock.
      //NOTE: its start is read just after /health named the pid; a reuse of that pid in between is not excluded.
      await atomicJson(lockPath, { pid: occupant.pid, port: configuredPort, fingerprint, startedAt: occupant.startedAt, start: processStart(occupant.pid) });
      return { port: configuredPort };
    }
    await stopStaleServer(occupant.pid, configuredPort);
  }
  return startServer(lockPath, serverPath, fingerprint, configuredPort, startupToken);
}

//NOTE: Pi releases without the startup mutex do not take it, so a concurrent start by one of them is not excluded.
async function ensureTrajectoryServer(agentDir: string, configuredPort: number): Promise<{ port: number }> {
  const lockPath = trajectoryLockPath(agentDir);
  const serverPath = trajectoryServerPath();
  const fingerprint = await trajectoryFingerprint(serverPath);
  await mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  const startupToken = await acquireStartupMutex(lockPath);
  try { return await startOrReuseServer(lockPath, serverPath, fingerprint, configuredPort, startupToken); }
  finally { await releaseStartupMutex(lockPath, startupToken); }
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
const ACTIVE_POLL_MS = 1_000;
// Nobody is watching, so the publisher stops reading run state every second.
const IDLE_POLL_MS = 10_000;
const RECONNECT_INITIAL_DELAY_MS = 100;
const RECONNECT_MAX_DELAY_MS = 5_000;
type LiveStateRecord = Record<string, unknown>;
type TranscriptRevision = { signature: string; revision: number };
type PendingTranscript = { generation: number; timer: ReturnType<typeof setTimeout>; publisherId: string; runId?: string; agentId?: string; subagentId?: string; revision?: number };
function boundedString(value: unknown, maxLength = 1024): unknown {
  if (typeof value !== "string") return value;
  const bytes = Buffer.from(value);
  return bytes.length > maxLength ? bytes.subarray(0, maxLength).toString("utf8") : value;
}
const MAX_LIVE_STRING_BYTES = 64 * 1024;
const MAX_LIVE_ARRAY_ENTRIES = 256;
const MAX_LIVE_OBJECT_KEYS = 64;
const LIVE_METADATA_ARRAY_KEYS = new Set(["agents", "runs", "subagents"]);
const LIVE_TRUNCATABLE_ARRAY_KEYS = new Set(["events", "phaseHistory", "scriptCalls"]);
const LIVE_METADATA_OBJECT_KEYS = new Set(["transcripts"]);
function liveValueWillBeBounded(value: unknown, key = "", depth = 0): boolean {
  if (typeof value === "string") return Buffer.byteLength(value) > MAX_LIVE_STRING_BYTES;
  if (typeof value !== "object" || value === null) return false;
  if (depth >= 12) return true;
  if (Array.isArray(value)) {
    const maxEntries = LIVE_TRUNCATABLE_ARRAY_KEYS.has(key) ? MAX_LIVE_ARRAY_ENTRIES - 1 : MAX_LIVE_ARRAY_ENTRIES;
    if (key === "attemptDetails" && value.length > 8 || !LIVE_METADATA_ARRAY_KEYS.has(key) && value.length > maxEntries) return true;
    return value.some((entry) => liveValueWillBeBounded(entry, "", depth + 1));
  }
  if (!object(value)) return false;
  const properties = LIVE_METADATA_OBJECT_KEYS.has(key) ? Object.keys(value) : Object.keys(value).sort().slice(0, MAX_LIVE_OBJECT_KEYS);
  if (!LIVE_METADATA_OBJECT_KEYS.has(key) && Object.keys(value).length > MAX_LIVE_OBJECT_KEYS) return true;
  return properties.some((property) => liveValueWillBeBounded(value[property], property, depth + 1));
}
const MAX_LIVE_TIMING_BYTES = 64 * 1024;
/** Keeps the newest timing entries: dropping the oldest leaves a live agent's gantt growing instead of frozen. */
function boundedTiming(value: unknown): unknown[] {
  const entries = Array.isArray(value) ? value.filter(isTimingTranscriptEntry) : [];
  const retained: unknown[] = [];
  let bytes = 2;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    let serialized: string;
    try { serialized = JSON.stringify(entries[index]); } catch { continue; }
    const nextBytes = bytes + (retained.length ? 1 : 0) + Buffer.byteLength(serialized);
    if (nextBytes >= MAX_LIVE_TIMING_BYTES) break;
    retained.push(entries[index]);
    bytes = nextBytes;
  }
  return retained.reverse();
}
type LiveBounds = { argsTruncatedRuns: Set<number>; path: string[]; runIndex: number | undefined };
function boundedLiveValue(value: unknown, key = "", depth = 0, bounds?: LiveBounds): unknown {
  const pathLength = bounds?.path.length ?? 0;
  if (bounds && key) bounds.path.push(key);
  const argsValue = bounds !== undefined && bounds.path.length >= 3 && bounds.path[0] === "runs" && bounds.path[1] === "snapshot" && bounds.path[2] === "args";
  const markArgsTruncated = () => { if (argsValue && bounds.runIndex !== undefined) bounds.argsTruncatedRuns.add(bounds.runIndex); };
  try {
    if (typeof value === "string") {
      if (argsValue && Buffer.byteLength(value) > MAX_LIVE_STRING_BYTES) markArgsTruncated();
      return boundedString(value, MAX_LIVE_STRING_BYTES);
    }
    if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
    if (depth >= 12) { markArgsTruncated(); return undefined; }
    if (key === "timing" && !argsValue) return boundedTiming(value);
    if (key === "output" && object(value) && value.status === "available") {
      const boundedOutput = boundedLiveValue(value.value, "value", depth + 1, bounds);
      return liveValueWillBeBounded(value.value, "value", depth + 1) ? { status: "truncated", kind: "result", bytes: value.bytes } : { ...value, value: boundedOutput };
    }
    if (Array.isArray(value)) {
      const array = value as readonly unknown[];
      const maxEntries = !argsValue && LIVE_TRUNCATABLE_ARRAY_KEYS.has(key) ? MAX_LIVE_ARRAY_ENTRIES - 1 : MAX_LIVE_ARRAY_ENTRIES;
      const entries = !argsValue && key === "attemptDetails" ? array.slice(-8) : !argsValue && LIVE_METADATA_ARRAY_KEYS.has(key) ? array : array.length <= maxEntries ? array : [...array.slice(0, 32), ...array.slice(-maxEntries + 32)];
      if (entries.length !== array.length) markArgsTruncated();
      const publisherRuns = bounds?.path.length === 1 && bounds.path[0] === "runs";
      const bounded = entries.map((entry, index) => {
        const previousRunIndex = bounds?.runIndex;
        if (publisherRuns) bounds.runIndex = index;
        const result = boundedLiveValue(entry, "", depth + 1, bounds);
        if (bounds) bounds.runIndex = previousRunIndex;
        return result;
      });
      if (entries.length !== array.length && LIVE_TRUNCATABLE_ARRAY_KEYS.has(key)) bounded.push({ type: "trajectory:truncated", field: key, omitted: array.length - entries.length });
      return bounded;
    }
    if (object(value)) {
      const result: LiveStateRecord = {};
      const keys = Object.keys(value).sort();
      const properties = !argsValue && LIVE_METADATA_OBJECT_KEYS.has(key) ? keys : keys.slice(0, MAX_LIVE_OBJECT_KEYS);
      if (properties.length !== keys.length) markArgsTruncated();
      for (const property of properties) result[property] = boundedLiveValue(value[property], property, depth + 1, bounds);
      return result;
    }
    return undefined;
  } finally {
    if (bounds) bounds.path.length = pathLength;
  }
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
export function minimalStatePublisher(publisher: LiveStateRecord): LiveStateRecord {
  const bounds: LiveBounds = { argsTruncatedRuns: new Set(), path: [], runIndex: undefined };
  const bounded = (boundedLiveValue(publisher, "", 0, bounds) as LiveStateRecord | undefined) ?? {};
  const sourceRuns: readonly unknown[] = Array.isArray(publisher.runs) ? publisher.runs : [];
  const boundedRuns: readonly unknown[] = Array.isArray(bounded.runs) ? bounded.runs : [];
  if (!sourceRuns.length || !boundedRuns.length) return bounded;
  const runs = boundedRuns.map((run, index) => {
    const sourceRun = sourceRuns[index];
    const sourceSnapshot = object(sourceRun) && object(sourceRun.snapshot) ? sourceRun.snapshot : undefined;
    const boundedSnapshot = object(run) && object(run.snapshot) ? run.snapshot : undefined;
    const argsUnavailable = sourceSnapshot !== undefined && sourceSnapshot.args !== undefined && sourceSnapshot.args !== null && (boundedSnapshot === undefined || !Object.prototype.hasOwnProperty.call(boundedSnapshot, "args"));
    return (bounds.argsTruncatedRuns.has(index) || argsUnavailable) && object(run) ? { ...run, snapshotArgsTruncated: true } : run;
  });
  return { ...bounded, runs };
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
  let viewers = 0;
  const startPolling = () => { stopPolling(); pollTimer = setInterval(() => { void sendState().catch((error: unknown) => { if (!closing) console.error(`Trajectory state publish failed: ${errorText(error)}`); }); }, viewers > 0 ? ACTIVE_POLL_MS : IDLE_POLL_MS); pollTimer.unref(); };
  let stateLoad: { socket: TrajectoryPublisherClient; task: Promise<void> } | undefined;
  let lastState: string | undefined;
  const publisherValue = (input: TrajectoryPublisherInput): LiveStateRecord => ({ id: publisherId(input.cwd, input.sessionId), title: `session ${input.sessionId.slice(0, 8)}`, cwd: input.cwd, sessionId: input.sessionId, connected: true });
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
    const oversized = (entries: readonly unknown[], revision: number): TrajectoryTranscriptResult | undefined => { try { return Buffer.byteLength(JSON.stringify(entries)) > TRAJECTORY_MAX_TRANSCRIPT_BYTES ? { status: "oversized", revision, entries: [], error: "Transcript is too large" } : undefined; } catch { return { status: "failed", revision, entries: [], error: "Transcript failed" }; } };
    const boundedTranscriptResult = (result: TrajectoryTranscriptResult): TrajectoryTranscriptResult => (result.status === "available" ? oversized(result.entries, result.revision) : undefined) ?? result;
    const boundedResult = (entries: readonly unknown[], revision: number): TrajectoryTranscriptResult => oversized(entries, revision) ?? { status: entries.length ? "available" : "empty", revision, entries };
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
        if (message.type === "publisher:viewers" && typeof message.count === "number") {
          const watched = viewers > 0;
          viewers = message.count;
          if (watched === viewers > 0) return;
          if (socket === next && !closing) startPolling();
          if (viewers > 0) void sendState().catch(() => undefined);
          return;
        }
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
