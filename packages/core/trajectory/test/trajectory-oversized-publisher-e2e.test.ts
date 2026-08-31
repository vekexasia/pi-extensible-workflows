import assert from "node:assert/strict";
import { createServer, createConnection, type Socket } from "node:net";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import { createLaunchSnapshot } from "../../src/utils.js";
import { RunStore, type PersistedRun } from "../../src/persistence.js";
import { createTrajectoryRunLoader, createTrajectoryRunMetadataLoader, createTrajectoryTranscriptLoader, type TrajectoryPublisherInput, type TrajectoryPublisherMetadata, type TrajectorySubagent, type TrajectoryTranscriptRequest, type TrajectoryTranscriptResult } from "../../src/trajectory.js";
import { createTrajectoryController, type TrajectoryController } from "../src/index.js";
import { exportTrajectoryRunHtml } from "../src/export.js";

const MAX_FRAME_BYTES = 32 * 1024 * 1024;
const INCIDENT_PAYLOAD_BYTES = 54_332_442;
const SESSION_ID = "oversized-publisher-session";
const RUN_COUNT = 7;
const AGENT_COUNT = 51;
const TRANSCRIPT_BYTES = 1_100_000;
const BODY_MARKER = "oversized-publisher-original-body";
const UPDATED_BODY_MARKER = "oversized-publisher-revised-body";

type JsonRecord = Record<string, unknown>;
type RawBrowser = {
  socket: Socket;
  send(value: unknown): void;
  next(): Promise<JsonRecord>;
  close(): void;
};
type TrajectoryLock = { pid: number; port: number; fingerprint?: string };

function publisherId(cwd: string): string {
  return createHash("sha256").update(`${cwd}\n${SESSION_ID}`).digest("hex").slice(0, 16);
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => { if (error) reject(error); else resolve(); }));
  return port;
}

function maskedFrame(value: string): Buffer {
  const data = Buffer.from(value);
  const mask = Buffer.from([11, 29, 47, 61]);
  let header: Buffer;
  if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
  else if (data.length <= 0xffff) { header = Buffer.alloc(4); header[0] = 0x81; header[1] = 0x80 | 126; header.writeUInt16BE(data.length, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x81; header[1] = 0x80 | 127; header.writeBigUInt64BE(BigInt(data.length), 2); }
  const body = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) body[index] = (data[index] ?? 0) ^ (mask[index % 4] ?? 0);
  return Buffer.concat([header, mask, body]);
}

type FrameState = { buffer: Buffer; queue: JsonRecord[]; wake: (() => void) | undefined };

function consumeFrames(state: FrameState, chunk: Buffer): void {
  state.buffer = Buffer.concat([state.buffer, chunk]);
  while (state.buffer.length >= 2) {
    const first = state.buffer[0] ?? 0;
    const second = state.buffer[1] ?? 0;
    if ((first & 0x80) === 0 || (first & 0x0f) !== 1 || (second & 0x80) !== 0) throw new Error("Unexpected browser WebSocket frame");
    let offset = 2;
    let length = second & 0x7f;
    if (length === 126) { if (state.buffer.length < 4) return; length = state.buffer.readUInt16BE(2); offset = 4; }
    else if (length === 127) { if (state.buffer.length < 10) return; const longLength = state.buffer.readBigUInt64BE(2); if (longLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("Browser frame is too large"); length = Number(longLength); offset = 10; }
    if (state.buffer.length < offset + length) return;
    const payload = state.buffer.subarray(offset, offset + length).toString("utf8");
    state.buffer = state.buffer.subarray(offset + length);
    const value: unknown = JSON.parse(payload);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Trajectory browser frame is not an object");
    state.queue.push(value as JsonRecord);
    state.wake?.();
    state.wake = undefined;
  }
}

async function browserSocket(port: number): Promise<RawBrowser> {
  const socket = await new Promise<Socket>((resolve, reject) => {
    const candidate = createConnection(port, "127.0.0.1");
    let response = "";
    const onData = (chunk: Buffer) => {
      response += chunk.toString("latin1");
      if (!response.includes("\r\n\r\n")) return;
      candidate.off("data", onData);
      if (!/^HTTP\/1\.1 101 Switching Protocols/m.test(response)) { candidate.destroy(); reject(new Error(`Trajectory WebSocket handshake failed: ${response}`)); return; }
      resolve(candidate);
    };
    candidate.on("data", onData);
    candidate.once("error", reject);
    candidate.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:${String(port)}\r\n\r\n`);
  });
  const state = { buffer: Buffer.alloc(0), queue: [] as JsonRecord[], wake: undefined as (() => void) | undefined };
  socket.on("data", (chunk: Buffer) => { try { consumeFrames(state, chunk); } catch { socket.destroy(); } });
  socket.on("error", () => { state.wake?.(); state.wake = undefined; });
  return {
    socket,
    send(value) { socket.write(maskedFrame(JSON.stringify(value))); },
    async next() {
      const deadline = Date.now() + 10_000;
      while (!state.queue.length) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error("Timed out waiting for browser WebSocket frame");
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, remaining);
          state.wake = () => { clearTimeout(timer); resolve(); };
        });
      }
      return state.queue.shift() as JsonRecord;
    },
    close() { socket.destroy(); },
  };
}

async function waitForHealth(port: number, healthy: boolean, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const result = (await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(300) })).ok;
      if (result === healthy) return;
    } catch { if (!healthy) return; }
    await delay(50);
  }
  throw new Error(`Trajectory health did not become ${String(healthy)}`);
}

async function readLock(path: string): Promise<TrajectoryLock> { return JSON.parse(await readFile(path, "utf8")) as TrajectoryLock; }

async function waitForState(browser: RawBrowser, predicate: (state: JsonRecord) => boolean): Promise<JsonRecord> {
  for (;;) {
    const value = await browser.next();
    if (value.type === "state" && predicate(value)) return value;
  }
}

async function transcriptRequest(browser: RawBrowser, request: JsonRecord): Promise<JsonRecord> {
  browser.send(request);
  for (;;) {
    const value = await browser.next();
    if (value.type === "transcript" && value.requestId === request.requestId) return value;
  }
}

function transcriptBody(marker: string, runIndex: number, agentIndex: number): string {
  const prefix = `${marker}:${String(runIndex)}:${String(agentIndex)}:`;
  return `${prefix}${"x".repeat(Math.max(0, TRANSCRIPT_BYTES - prefix.length))}`;
}

function transcriptFileBody(marker: string, runIndex: number, agentIndex: number): string {
  const toolCallId = `tool-${String(runIndex)}-${String(agentIndex)}`;
  return `${JSON.stringify({ type: "message", message: { role: "assistant", toolCallId, content: [{ type: "text", text: transcriptBody(marker, runIndex, agentIndex) }] } })}\n${JSON.stringify({ type: "custom", customType: "pi-workflows:tool-timing", data: { toolCallId, toolName: "bash", startedAt: runIndex + agentIndex, completedAt: runIndex + agentIndex + 7, durationMs: 7, isError: false } })}\n`;
}

async function createFixture(root: string): Promise<{ cwd: string; home: string; agentDir: string; paths: string[]; loadRuns: ReturnType<typeof createTrajectoryRunLoader>; loadMetadata: NonNullable<TrajectoryPublisherInput["loadMetadata"]>; loadTranscript: NonNullable<TrajectoryPublisherInput["loadTranscript"]>; subagents: readonly TrajectorySubagent[] }> {
  const cwd = join(root, "project");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  await mkdir(cwd, { recursive: true });
  const paths: string[] = [];
  const stores: Array<{ store: RunStore; run: PersistedRun }> = [];
  let agentNumber = 0;
  for (let runIndex = 0; runIndex < RUN_COUNT; runIndex += 1) {
    const count = runIndex < 2 ? 8 : 7;
    const agents = [];
    for (let agentIndex = 0; agentIndex < count; agentIndex += 1) {
      const path = join(root, `transcript-${String(agentNumber)}.jsonl`);
      paths.push(path);
      await writeFile(path, transcriptFileBody(BODY_MARKER, runIndex, agentIndex), "utf8");
      const model = { provider: "fixture", model: "fixture-model" };
      agents.push({
        id: `agent-${String(runIndex)}-${String(agentIndex)}`,
        name: `agent-${String(runIndex)}-${String(agentIndex)}`,
        path,
        systemPrompt: `system-prompt-${String(runIndex)}-${String(agentIndex)}`,
        prompt: `prompt-${String(runIndex)}-${String(agentIndex)}`,
        parentId: agentIndex > 0 ? `agent-${String(runIndex)}-${String(agentIndex - 1)}` : undefined,
        structuralPath: [`phase-${String(runIndex)}`, `agent-${String(agentIndex)}`],
        parentBreadcrumb: `run-${String(runIndex)} / parent-${String(agentIndex)}`,
        worktreeOwner: `owner-${String(agentIndex)}`,
        requestedModel: `fixture/requested-${String(agentIndex)}`,
        state: runIndex === 0 ? "running" : runIndex === 1 ? "failed" : "completed",
        attempts: runIndex === 1 ? 2 : 1,
        model,
        durationMs: 7,
        toolDefinitions: [{ name: "bash", description: "Execute fixture bash" }],
        outcome: { kind: "result", value: `outcome-${String(agentIndex)}` },
        tools: ["bash"],
        attemptDetails: [{
          attempt: 1,
          transport: "local",
          session: { transport: "local", sessionId: `native-${String(agentNumber)}`, locator: { sessionFile: path } },
          setup: { cwd, hookNames: [], model, tools: ["bash"] },
          accounting: { input: 11, output: 13, cacheRead: 17, cacheWrite: 19, cost: 0.01 },
        }],
        accounting: { input: 11, output: 13, cacheRead: 17, cacheWrite: 19, cost: 0.01 },
      });
      agentNumber += 1;
    }
    const run = {
      id: `run-${String(runIndex)}`,
      workflowName: `trajectory-oversized-${String(runIndex)}`,
      cwd,
      sessionId: SESSION_ID,
      state: runIndex === 0 ? "running" : runIndex === 1 ? "failed" : "completed",
      agentSessions: [],
      agents,
      usage: { tokens: 24, costUsd: 0.01, durationMs: 7, agentLaunches: count },
    } as unknown as PersistedRun;
    stores.push({ store: new RunStore(cwd, SESSION_ID, run.id, home), run });
  }
  assert.equal(paths.length, AGENT_COUNT);
  const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "trajectory-oversized" }, settings: { concurrency: 4 }, models: ["fixture/fixture-model"], tools: ["bash"], agentTypes: [], roles: {}, schemas: [] });
  await Promise.all(stores.map(({ store, run }) => store.create(run, snapshot)));
  const loadRuns = createTrajectoryRunLoader(cwd, SESSION_ID, home);
  const loadRunMetadata = createTrajectoryRunMetadataLoader(cwd, SESSION_ID, home);
  const subagents = [{
    id: "live-subagent",
    sessionId: SESSION_ID,
    cwd,
    mode: "background",
    state: "running",
    request: { prompt: "Inspect the live trajectory", mode: "background" },
    tools: ["bash"],
    toolDefinitions: [{ name: "bash", description: "Execute bash" }], result: { summary: "subagent-result" },
    transcript: [{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "subagent-on-demand" }] } }, { type: "custom", customType: "pi-workflows:tool-timing", data: { toolCallId: "subagent-call", toolName: "bash", startedAt: 1, completedAt: 2, durationMs: 1, isError: false } }],
  }, {
    id: "empty-subagent",
    sessionId: SESSION_ID,
    cwd,
    mode: "background",
    state: "completed",
    request: { prompt: "No transcript", mode: "background" },
    tools: [],
    transcript: [],
  }] as unknown as readonly TrajectorySubagent[];
  const loadMetadata: NonNullable<TrajectoryPublisherInput["loadMetadata"]> = async () => ({
    runs: (await loadRunMetadata()).map((value) => ({ ...value, run: { ...value.run, agents: value.run.agents.map((agent) => ({ ...agent, outcome: { kind: "result", value: "outcome-0" } })) } })) as unknown as TrajectoryPublisherMetadata["runs"],
    subagents: subagents.map((value) => ({ ...value, transcript: { revision: 1, status: value.transcript.length ? "available" : "empty", timing: value.transcript.slice(1) } })) as unknown as TrajectoryPublisherMetadata["subagents"],
  });
  const loadPersistedTranscript = createTrajectoryTranscriptLoader(cwd, SESSION_ID, home, agentDir);
  const loadTranscript: NonNullable<TrajectoryPublisherInput["loadTranscript"]> = async (request: TrajectoryTranscriptRequest): Promise<TrajectoryTranscriptResult> => {
    if (request.subagentId !== undefined) {
      const value = subagents.find((candidate) => candidate.id === request.subagentId);
      if (!value) return { status: "missing", revision: 0, entries: [], error: "Transcript not found" };
      return { status: value.transcript.length ? "available" : "empty", revision: 1, entries: value.transcript };
    }
    return loadPersistedTranscript(request);
  };
  return { cwd, home, agentDir, paths, loadRuns, loadMetadata, loadTranscript, subagents };
}

function closeProcess(pid: number): void { try { process.kill(pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
async function waitForDead(pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw error; }
    await delay(50);
  }
  throw new Error(`Trajectory server process ${String(pid)} did not exit`);
}

async function closeController(controller: TrajectoryController | undefined): Promise<void> { if (controller) await controller.close().catch(() => undefined); }

void test("Trajectory keeps a real oversized publisher alive and reconnects its detached server", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-oversized-publisher-e2e-"));
  const port = await availablePort();
  const lockPath = join(root, "agent", "pi-extensible-workflows", "trajectory.lock");
  let controller: TrajectoryController | undefined;
  let browser: RawBrowser | undefined;
  let reconnectBrowser: RawBrowser | undefined;
  const serverPids: number[] = [];
  try {
    const fixture = await createFixture(root);
    const loaded = await fixture.loadRuns();
    const subagents = fixture.subagents;
    const fullPublisherPayload = JSON.stringify({ type: "publisher:state", publisher: { id: publisherId(fixture.cwd), cwd: fixture.cwd, sessionId: SESSION_ID, title: "oversized" }, runs: loaded, subagents });
    assert.ok(Buffer.byteLength(fullPublisherPayload) >= INCIDENT_PAYLOAD_BYTES, `fixture publisher payload was only ${String(Buffer.byteLength(fullPublisherPayload))} bytes`);
    const actions: JsonRecord[] = [];
    const input: TrajectoryPublisherInput = { cwd: fixture.cwd, sessionId: SESSION_ID, port, themes: false, loadRuns: fixture.loadRuns, loadSubagents: async () => subagents, loadMetadata: fixture.loadMetadata, loadTranscript: fixture.loadTranscript, handleAction: async (request) => { actions.push(request); return { id: "action-result", state: "running" }; } };
    controller = createTrajectoryController(fixture.agentDir);
    await controller.open(input);
    await waitForHealth(port, true);
    const firstLock = await readLock(lockPath);
    serverPids.push(firstLock.pid);
    await delay(500);

    browser = await browserSocket(port);
    browser.send({ type: "ui:attach" });
    const initial = await waitForState(browser, () => true);
    assert.equal((await fetch(`http://127.0.0.1:${String(port)}/health`)).ok, true);
    const publishers = Array.isArray(initial.publishers) ? initial.publishers : [];
    assert.equal(publishers.length, 1, "publisher disappeared after oversized publisher:state send while the detached server stayed healthy");
    assert.ok(Buffer.byteLength(JSON.stringify(initial)) < MAX_FRAME_BYTES);
    const livePublisher = publishers[0] as JsonRecord;
    assert.equal(livePublisher.id, publisherId(fixture.cwd));
    assert.equal(livePublisher.connected, true);
    const liveRuns = Array.isArray(livePublisher.runs) ? livePublisher.runs as JsonRecord[] : [];
    assert.equal(liveRuns.length, RUN_COUNT);
    const liveAgentCount = liveRuns.reduce((total, run) => {
      const runValue = run.run;
      if (!runValue || typeof runValue !== "object" || Array.isArray(runValue)) return total;
      const agents = (runValue as JsonRecord).agents;
      return total + (Array.isArray(agents) ? agents.length : 0);
    }, 0);
    assert.equal(liveAgentCount, AGENT_COUNT);
    assert.equal(JSON.stringify(initial).includes(BODY_MARKER), false);
    assert.ok(Array.isArray(livePublisher.subagents));
    const liveSubagents = livePublisher.subagents as JsonRecord[];
    assert.ok(liveSubagents.some((subagent) => subagent.id === "live-subagent" && subagent.state === "running" && JSON.stringify(subagent.result) === JSON.stringify({ summary: "subagent-result" })));
    await controller.close();
    const disconnected = await waitForState(browser, (state) => Array.isArray(state.publishers) && state.publishers.length === 0);
    assert.deepEqual(disconnected.publishers, []);
    await controller.open(input);
    const reopened = await waitForState(browser, (state) => Array.isArray(state.publishers) && state.publishers.length === 1);
    assert.equal((reopened.publishers as JsonRecord[])[0]?.connected, true);

    const firstRun = liveRuns[0] as JsonRecord;
    const firstRunBody = firstRun.run as JsonRecord;
    const firstAgent = (firstRunBody.agents as JsonRecord[])[0];
    assert.ok(firstAgent);
    assert.equal(firstAgent.state, "running");
    assert.equal(firstAgent.systemPrompt, "system-prompt-0-0");
    assert.equal(firstAgent.prompt, "prompt-0-0");
    assert.deepEqual(firstAgent.structuralPath, ["phase-0", "agent-0"]);
    assert.equal(firstAgent.parentBreadcrumb, "run-0 / parent-0");
    assert.equal(firstAgent.worktreeOwner, "owner-0");
    assert.equal(firstAgent.requestedModel, "fixture/requested-0");
    assert.equal(firstAgent.durationMs, 7);
    assert.equal((firstAgent.toolDefinitions as JsonRecord[])[0]?.name, "bash");
    assert.equal(typeof (firstAgent.toolDefinitions as JsonRecord[])[0]?.description, "string");
    assert.deepEqual(firstAgent.outcome, { kind: "result", value: "outcome-0" });
    assert.deepEqual(firstAgent.tools, ["bash"]);
    assert.ok(firstAgent.attemptDetails);
    const firstAttempt = (firstAgent.attemptDetails as JsonRecord[])[0];
    assert.ok(firstAttempt);
    const accounting = firstAttempt.accounting;
    assert.ok(accounting && typeof accounting === "object");
    assert.equal((accounting as JsonRecord).input, 11);
    const transcriptMetadata = (firstRun.transcripts as JsonRecord)[String(firstAgent.id)];
    assert.ok(transcriptMetadata && !Array.isArray(transcriptMetadata));
    assert.equal(typeof (transcriptMetadata as JsonRecord).revision, "number");
    const revision = (transcriptMetadata as JsonRecord).revision as number;

    const runReply = await transcriptRequest(browser, { type: "ui:transcript", requestId: "run-transcript-1", publisherId: publisherId(fixture.cwd), runId: "run-0", agentId: firstAgent.id, revision });
    assert.equal(runReply.ok, true);
    assert.equal(runReply.revision, revision);
    const runEntries = runReply.entries as unknown[];
    assert.ok(runEntries.some((entry) => entry && typeof entry === "object" && (entry as JsonRecord).customType === "pi-workflows:tool-timing"));
    assert.ok(JSON.stringify(runEntries).includes(BODY_MARKER));
    const subagentReply = await transcriptRequest(browser, { type: "ui:transcript", requestId: "subagent-transcript-1", publisherId: publisherId(fixture.cwd), subagentId: "live-subagent", revision: 1 });
    assert.equal(subagentReply.ok, true);
    const subagentEntries = subagentReply.entries as unknown[];
    assert.ok(subagentEntries.some((entry) => entry && typeof entry === "object" && (entry as JsonRecord).customType === "pi-workflows:tool-timing"));
    assert.ok(JSON.stringify(subagentEntries).includes("subagent-on-demand"));
    const emptyReply = await transcriptRequest(browser, { type: "ui:transcript", requestId: "empty-transcript-1", publisherId: publisherId(fixture.cwd), subagentId: "empty-subagent", revision: 1 });
    assert.equal(emptyReply.ok, true);
    assert.deepEqual(emptyReply.entries, []);
    const missingReply = await transcriptRequest(browser, { type: "ui:transcript", requestId: "missing-transcript-1", publisherId: publisherId(fixture.cwd), runId: "missing-run", agentId: "missing-agent", revision: 1 });
    assert.equal(missingReply.ok, false);
    assert.equal(missingReply.error, "Transcript not found");
    browser.send({ type: "ui:action", requestId: "action-1", publisherId: publisherId(fixture.cwd), action: "retry", target: { kind: "run", id: "run-0" } });
    let actionReply: JsonRecord | undefined;
    while (actionReply === undefined) {
      const value = await browser.next();
      if ((value.type === "publisher:action-result" || value.type === "action-result") && value.requestId === "action-1") actionReply = value;
    }
    assert.equal(actionReply.ok, true);
    assert.equal(actions[0]?.action, "retry");

    await delay(25);
    await writeFile(fixture.paths[0] as string, transcriptFileBody(UPDATED_BODY_MARKER, 0, 0), "utf8");
    await delay(1_100);
    browser.send({ type: "ui:attach" });
    const refreshed = await waitForState(browser, (state) => {
      const publisher = (state.publishers as JsonRecord[] | undefined)?.[0];
      const runs: unknown = publisher?.runs;
      const run: unknown = Array.isArray(runs) ? runs[0] : undefined;
      const transcripts = run && typeof run === "object" ? (run as JsonRecord).transcripts : undefined;
      const metadata = transcripts && typeof transcripts === "object" && !Array.isArray(transcripts) ? (transcripts as JsonRecord)[String(firstAgent.id)] : undefined;
      if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
      const metadataRecord = metadata as JsonRecord;
      return typeof metadataRecord.revision === "number" && metadataRecord.revision !== revision;
    });
    const refreshedPublisher = (refreshed.publishers as JsonRecord[])[0];
    assert.ok(refreshedPublisher);
    const refreshedRuns = refreshedPublisher.runs as JsonRecord[];
    const refreshedRun = refreshedRuns[0];
    assert.ok(refreshedRun);
    const refreshedTranscripts = refreshedRun.transcripts as JsonRecord;
    const refreshedMetadata = refreshedTranscripts[String(firstAgent.id)] as JsonRecord;
    const refreshedRevision = refreshedMetadata.revision as number;
    const refreshedReply = await transcriptRequest(browser, { type: "ui:transcript", requestId: "run-transcript-2", publisherId: publisherId(fixture.cwd), runId: "run-0", agentId: firstAgent.id, revision: refreshedRevision });
    assert.equal(refreshedReply.ok, true);
    assert.ok(JSON.stringify(refreshedReply.entries).includes(UPDATED_BODY_MARKER));
    const staleReply = await transcriptRequest(browser, { type: "ui:transcript", requestId: "run-transcript-stale", publisherId: publisherId(fixture.cwd), runId: "run-0", agentId: firstAgent.id, revision });
    assert.equal(staleReply.ok, false);
    assert.equal(staleReply.error, "Transcript revision is stale");

    const html = await exportTrajectoryRunHtml({ cwd: fixture.cwd, sessionId: SESSION_ID, runId: "run-0", home: fixture.home });
    assert.ok(html.includes(BODY_MARKER));
    assert.ok(html.includes("window.__PIEWF_STATIC__"));

    const oldPid = firstLock.pid;
    closeProcess(oldPid);
    await waitForDead(oldPid);
    await waitForHealth(port, false);
    await waitForHealth(port, true, 20_000);
    const reattachedLock = await readLock(lockPath);
    serverPids.push(reattachedLock.pid);
    assert.notEqual(reattachedLock.pid, oldPid);
    reconnectBrowser = await browserSocket(port);
    reconnectBrowser.send({ type: "ui:attach" });
    const reattachedState = await waitForState(reconnectBrowser, (state) => Array.isArray(state.publishers) && state.publishers.length === 1);
    assert.equal((reattachedState.publishers as JsonRecord[])[0]?.id, publisherId(fixture.cwd));
    assert.equal((reattachedState.publishers as JsonRecord[])[0]?.connected, true);

    await closeController(controller);
    controller = undefined;
    const disconnectedState = await waitForState(reconnectBrowser, (state) => Array.isArray(state.publishers) && state.publishers.length === 0);
    assert.deepEqual(disconnectedState.publishers, []);
    closeProcess(reattachedLock.pid);
    await waitForHealth(port, false);
    await delay(1_500);
    await assert.rejects(fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(300) }));
  } finally {
    browser?.close();
    reconnectBrowser?.close();
    await closeController(controller);
    for (const pid of serverPids) closeProcess(pid);
    await rm(root, { recursive: true, force: true });
  }
});
