import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTrajectoryServer } from "../src/server.js";

async function availablePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => { resolve(); });
  });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => { if (error) reject(error); else resolve(); }));
  return port;
}

async function listen(server: ReturnType<typeof createTrajectoryServer>, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
}

function maskedFrame(value: string): Buffer {
  const data = Buffer.from(value);
  const mask = Buffer.from([1, 2, 3, 4]);
  let header: Buffer;
  if (data.length < 126) header = Buffer.from([0x81, 0x80 | data.length]);
  else if (data.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(data.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(data.length), 2);
  }
  const body = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) body[index] = (data[index] ?? 0) ^ (mask[index % 4] ?? 0);
  return Buffer.concat([header, mask, body]);
}

function maskedCloseFrame(): Buffer {
  return Buffer.from([0x88, 0x80, 1, 2, 3, 4]);
}

function decodeTextFrame(buffer: Buffer): { payload: string } | undefined {
  if (buffer.length < 2) return undefined;
  const second = buffer[1] ?? 0;
  assert.equal(second & 0x80, 0);
  let offset = 2;
  let length = second & 0x7f;
  if (length === 126) {
    if (buffer.length < 4) return undefined;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return undefined;
    length = Number(buffer.readBigUInt64BE(2));
    offset = 10;
  }
  if (buffer.length < offset + length) return undefined;
  return { payload: buffer.subarray(offset, offset + length).toString("utf8") };
}

async function readJsonFrame(socket: Socket): Promise<unknown> {
  let buffer = Buffer.alloc(0);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error("timed out waiting for Trajectory frame")); }, 2000);
    const onData = (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const decoded = decodeTextFrame(buffer);
      if (!decoded) return;
      clearTimeout(timer);
      socket.off("data", onData);
      resolve(JSON.parse(decoded.payload));
    };
    socket.on("data", onData);
    socket.once("error", reject);
  });
}

function publisherState(id: string, blob: string, subagents: readonly unknown[] = [], title = ""): string {
  return JSON.stringify({
    type: "publisher:state",
    publisher: { id, ...(title ? { title } : {}) },
    runs: [{ run: { id, workflowName: id, agents: [], state: "completed" }, transcripts: { agent: [{ type: "message", text: blob }] }, snapshot: {}, awaiting: [] }],
    subagents,
  });
}

async function handshake(port: number, origin: string): Promise<{ socket: Socket; response: string }> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(port, "127.0.0.1");
    let data = "";
    const onData = (chunk: Buffer) => {
      data += chunk.toString("latin1");
      if (!data.includes("\r\n\r\n")) return;
      socket.off("data", onData);
      resolve({ socket, response: data });
    };
    socket.on("data", onData);
    socket.once("error", reject);
    socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: ${origin}\r\n\r\n`);
  });
}

async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(300) })).ok) return;
    } catch { /* The child is still starting. */ }
    const remaining = deadline - Date.now();
    if (remaining > 0) await new Promise((resolve) => setTimeout(resolve, Math.min(50, remaining)));
  }
  throw new Error("Trajectory server did not become healthy");
}

async function handshakeWhenReady(port: number, origin: string): Promise<{ socket: Socket; response: string }> {
  await waitForHealth(port);
  return handshake(port, origin);
}

void test("Trajectory persists the server fingerprint in its listening lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-lock-"));
  const port = await availablePort();
  const fingerprint = "server-hash:html-hash";
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { fingerprint });
  await listen(server, port);
  try {
    assert.deepEqual(JSON.parse(await readFile(join(root, "trajectory.lock"), "utf8")), { pid: process.pid, port, fingerprint });
  } finally {
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory HTTP and WebSocket boundaries require localhost and origin", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  try {
    const base = `http://127.0.0.1:${String(port)}`;
    assert.equal((await fetch(`${base}/health`)).status, 200);
    assert.equal((await fetch(`${base}/health`, { headers: { host: `localhost:${String(port)}` } })).status, 200);
    assert.equal((await fetch(`${base}/health?token=ignored`)).status, 200);
    for (const path of ["/", "/index.html", "/marked.min.js"]) assert.equal((await fetch(`${base}${path}`)).status, 200);
    assert.equal((await fetch(`${base}/health`, { headers: { origin: "http://evil.test" } })).status, 403);
    const valid = await handshake(port, `http://127.0.0.1:${String(port)}`);
    assert.match(valid.response, /^HTTP\/1\.1 101 Switching Protocols/);
    const state = new Promise<Buffer>((resolve) => valid.socket.once("data", resolve));
    valid.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    assert.ok((await state).length > 2);
    valid.socket.destroy();
    const invalidOrigin = await new Promise<string>((resolve) => {
      const socket = createConnection(port, "127.0.0.1");
      let response = "";
      socket.on("data", (chunk) => { response += chunk.toString("latin1"); });
      socket.once("close", () => { resolve(response); });
      socket.write(`GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://evil.test\r\n\r\n`);
    });
    assert.doesNotMatch(invalidOrigin, /101 Switching Protocols/);
    const unmasked = await handshake(port, `http://127.0.0.1:${String(port)}`);
    const closed = new Promise<void>((resolve) => unmasked.socket.once("close", () => { resolve(); }));
    unmasked.socket.write(Buffer.from([0x81, 1, 0x78]));
    await closed;
  } finally {
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory keeps the browser socket when combined publisher state exceeds the frame cap", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-cap-"));
  const port = await availablePort();
  const maxFrameBytes = 1000;
  const blob = "x".repeat(400);
  const title = "x".repeat(300);
  const first = publisherState("one", blob, [], title);
  const second = publisherState("two", blob, [], title);
  assert.ok(Buffer.byteLength(first) < maxFrameBytes);
  assert.ok(Buffer.byteLength(second) < maxFrameBytes);
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { maxFrameBytes });
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisherOne = await handshake(port, origin);
    const publisherTwo = await handshake(port, origin);
    sockets.push(publisherOne.socket, publisherTwo.socket);
    publisherOne.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisherOne.socket.write(maskedFrame(first));
    publisherTwo.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "two" })));
    publisherTwo.socket.write(maskedFrame(second));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const closed = new Promise<string>((resolve) => browser.socket.once("close", () => { resolve("closed"); }));
    const state = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    const message = await Promise.race([state, closed.then((value) => { throw new Error(value); })]);
    assert.equal((message as { type?: unknown }).type, "state");
    assert.equal((message as { truncated?: unknown }).truncated, true);
    const publishers = (message as { publishers?: unknown[] }).publishers;
    assert.ok(Array.isArray(publishers));
    assert.equal(publishers.length, 2);
    for (const publisher of publishers) {
      assert.equal((publisher as { connected?: unknown }).connected, true);
      const runs = (publisher as { runs?: { transcripts?: { agent?: unknown[] } }[] }).runs;
      assert.deepEqual(runs?.[0]?.transcripts?.agent ?? [], []);
    }
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory tells a replaced publisher to stop reconnecting", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-replaced-publisher-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const first = await handshake(port, origin);
    const second = await handshake(port, origin);
    sockets.push(first.socket, second.socket);
    first.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "same" })));
    await new Promise((resolve) => setTimeout(resolve, 25));
    const replaced = readJsonFrame(first.socket);
    second.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "same" })));
    assert.deepEqual(await replaced, { type: "publisher:replaced" });
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});
void test("Trajectory invalidates an active transcript across same-id publisher replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-publisher-generation-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisherOne = await handshake(port, origin);
    const publisherTwo = await handshake(port, origin);
    const browser = await handshake(port, origin);
    sockets.push(publisherOne.socket, publisherTwo.socket, browser.socket);
    const initialState = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    assert.deepEqual((await initialState as { publishers?: unknown[] }).publishers, []);
    publisherOne.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "same" })));
    const attachedState = await readJsonFrame(browser.socket) as { publishers?: { generation?: unknown }[] };
    assert.equal(attachedState.publishers?.[0]?.generation, 1);
    publisherOne.socket.write(maskedFrame(JSON.stringify({ type: "publisher:state", publisher: { id: "same" }, runs: [{ run: { id: "run", agents: [] }, transcripts: { agent: { revision: 1, status: "available", timing: [] } } }], subagents: [] })));
    const firstState = await readJsonFrame(browser.socket) as { publishers?: { generation?: unknown }[] };
    assert.equal(firstState.publishers?.[0]?.generation, 1);
    const forwarded = readJsonFrame(publisherOne.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:transcript", requestId: "active", publisherId: "same", runId: "run", agentId: "agent", revision: 1 })));
    assert.equal((await forwarded as { type?: unknown }).type, "publisher:transcript");
    publisherTwo.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "same" })));
    const replacementBrowser = await handshake(port, origin);
    sockets.push(replacementBrowser.socket);
    const replacementState = readJsonFrame(replacementBrowser.socket);
    replacementBrowser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    assert.equal((await replacementState as { publishers?: { generation?: unknown }[] }).publishers?.[0]?.generation, 2);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory removes disconnected publishers from browser state", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-disconnect-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisherOne = await handshake(port, origin);
    const publisherTwo = await handshake(port, origin);
    sockets.push(publisherOne.socket, publisherTwo.socket);
    publisherOne.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisherOne.socket.write(maskedFrame(publisherState("one", "one")));
    publisherTwo.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "two" })));
    publisherTwo.socket.write(maskedFrame(publisherState("two", "two")));
    await new Promise((resolve) => setTimeout(resolve, 100));

    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const initial = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    const firstState = await initial as { publishers?: { id?: unknown }[] };
    assert.deepEqual(firstState.publishers?.map((publisher) => publisher.id), ["one", "two"]);

    const nextState = readJsonFrame(browser.socket);
    publisherOne.socket.write(maskedCloseFrame());
    const afterDisconnect = await nextState as { publishers: { id?: unknown; connected?: unknown }[] };
    assert.deepEqual(afterDisconnect.publishers.map((publisher) => publisher.id), ["two"]);
    assert.equal(afterDisconnect.publishers.some((publisher) => publisher.connected === false), false);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory fetches one agent transcript after compacting combined state", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-transcript-"));
  const port = await availablePort();
  const maxFrameBytes = 800;
  const blob = "x".repeat(400);
  const first = publisherState("one", blob);
  const second = publisherState("two", blob);
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { maxFrameBytes });
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisherOne = await handshake(port, origin);
    const publisherTwo = await handshake(port, origin);
    sockets.push(publisherOne.socket, publisherTwo.socket);
    publisherOne.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisherOne.socket.write(maskedFrame(first));
    publisherTwo.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "two" })));
    publisherTwo.socket.write(maskedFrame(second));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const state = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    const compact = await state as { publishers?: { runs?: { transcripts?: { agent?: unknown[] } }[] }[] };
    assert.deepEqual(compact.publishers?.[0]?.runs?.[0]?.transcripts?.agent ?? [], []);
    const reply = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:transcript", publisherId: "one", runId: "one", agentId: "agent" })));
    const transcript = await reply as { type?: unknown; agentId?: unknown; entries?: unknown };
    assert.equal(transcript.type, "transcript");
    assert.equal(transcript.agentId, "agent");
    assert.deepEqual(transcript.entries, [{ type: "message", text: blob }]);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory relays subagents and compacts only transcript bodies", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-subagent-state-"));
  const port = await availablePort();
  const maxFrameBytes = 1800;
  const timing = { type: "custom", customType: "pi-workflows:tool-timing", data: { toolCallId: "call", toolName: "bash", startedAt: 1, completedAt: 2, durationMs: 1, isError: false } };
  const subagent = { id: "subagent", state: "running", cwd: process.cwd(), worktree: { path: "/tmp/worktree", branch: "subagent" }, tools: ["bash"], toolDefinitions: [{ name: "bash", description: "Execute a bash command" }], attempt: { attempt: 1, setup: { tools: ["bash"], cwd: process.cwd() } }, transcript: [{ type: "message", text: "x".repeat(500) }, timing] };
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { maxFrameBytes });
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisher = await handshake(port, origin);
    sockets.push(publisher.socket);
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisher.socket.write(maskedFrame(publisherState("one", "run", [subagent])));
    const publisherTwo = await handshake(port, origin);
    sockets.push(publisherTwo.socket);
    publisherTwo.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "two" })));
    publisherTwo.socket.write(maskedFrame(publisherState("two", "x".repeat(1100))));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const state = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    const value = await state as { publishers?: { subagents?: { id?: unknown; worktree?: unknown; transcript?: unknown[]; toolDefinitions?: { name?: unknown }[] }[] }[] };
    const current = value.publishers?.[0]?.subagents?.[0];
    assert.ok(current);
    assert.equal(current.id, "subagent");
    assert.deepEqual(current.worktree, { path: "/tmp/worktree", branch: "subagent" });
    assert.deepEqual(current.transcript, [timing]);
    assert.equal(current.toolDefinitions?.[0]?.name, "bash");
    const reply = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:transcript", publisherId: "one", subagentId: "subagent" })));
    const transcript = await reply as { subagentId?: unknown; entries?: { text?: unknown }[] };
    assert.equal(transcript.subagentId, "subagent");
    assert.equal(transcript.entries?.[0]?.text, "x".repeat(500));
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory rejects an oversized subagent transcript reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-subagent-transcript-cap-"));
  const port = await availablePort();
  const maxFrameBytes = 1000;
  const transcript = Array.from({ length: 20 }, () => ({ type: "message", text: "x", value: 1e20 }));
  const publisherMessage = JSON.stringify({ type: "publisher:state", publisher: { id: "one" }, runs: [], subagents: [{ id: "subagent", state: "running", transcript }] }).replaceAll("100000000000000000000", "1e20");
  assert.ok(Buffer.byteLength(publisherMessage) <= maxFrameBytes);
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { maxFrameBytes });
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisher = await handshake(port, origin);
    sockets.push(publisher.socket);
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisher.socket.write(maskedFrame(publisherMessage));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const state = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    const value = await state as { publishers?: { subagents?: { id?: unknown; transcript?: unknown[] }[] }[] };
    const current = value.publishers?.[0]?.subagents?.[0];
    assert.ok(current);
    assert.equal(current.id, "subagent");
    assert.deepEqual(current.transcript, []);
    const reply = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:transcript", publisherId: "one", subagentId: "subagent" })));
    const transcriptReply = await reply as { subagentId?: unknown; ok?: unknown; error?: unknown };
    assert.equal(transcriptReply.subagentId, "subagent");
    assert.equal(transcriptReply.ok, false);
    assert.equal(transcriptReply.error, "Transcript is too large");
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory correlates duplicate browser request IDs to their requesting browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-request-correlation-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisher = await handshake(port, origin);
    sockets.push(publisher.socket);
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:state", publisher: { id: "one" }, runs: [{ run: { id: "one", agents: [] }, transcripts: { agent: { revision: 1, status: "available", timing: [] } } }], subagents: [] })));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const browserOne = await handshake(port, origin);
    const browserTwo = await handshake(port, origin);
    sockets.push(browserOne.socket, browserTwo.socket);
    const stateOne = readJsonFrame(browserOne.socket);
    browserOne.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    await stateOne;
    const stateTwo = readJsonFrame(browserTwo.socket);
    browserTwo.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    await stateTwo;
    const request = { type: "ui:transcript", requestId: "shared-request", publisherId: "one", runId: "one", agentId: "agent" };
    browserOne.socket.write(maskedFrame(JSON.stringify(request)));
    const forwardedOne = await readJsonFrame(publisher.socket) as { requestId?: unknown };
    browserTwo.socket.write(maskedFrame(JSON.stringify(request)));
    const forwardedTwo = await readJsonFrame(publisher.socket) as { requestId?: unknown };
    assert.notEqual(forwardedOne.requestId, forwardedTwo.requestId);
    for (const forwarded of [forwardedOne, forwardedTwo]) publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:transcript-result", requestId: forwarded.requestId, publisherId: "one", runId: "one", agentId: "agent", ok: true, status: "available", revision: 1, entries: [{ requestId: forwarded.requestId }] })));
    const responseOne = await readJsonFrame(browserOne.socket) as { entries?: { requestId?: unknown }[] };
    const responseTwo = await readJsonFrame(browserTwo.socket) as { entries?: { requestId?: unknown }[] };
    assert.equal(responseOne.entries?.[0]?.requestId, forwardedOne.requestId);
    assert.equal(responseTwo.entries?.[0]?.requestId, forwardedTwo.requestId);
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});
void test("Trajectory does not let transcript results settle action requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-request-kind-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisher = await handshake(port, origin);
    sockets.push(publisher.socket);
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisher.socket.write(maskedFrame(publisherState("one", "run")));
    await new Promise((resolve) => setTimeout(resolve, 50));
    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const state = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    await state;
    const forwarded = readJsonFrame(publisher.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:action", requestId: "same-request", publisherId: "one", action: "retry", target: { kind: "run", id: "run-id" } })));
    const action = await forwarded as { requestId?: unknown };
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:transcript-result", requestId: action.requestId, publisherId: "one", runId: "run-id", agentId: "agent", ok: true, status: "available", revision: 1, entries: [{ type: "message" }] })));
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:action-result", requestId: action.requestId, publisherId: "one", ok: true, result: { accepted: true } })));
    const result = await readJsonFrame(browser.socket) as { type?: unknown; result?: unknown };
    assert.deepEqual(result, { type: "action-result", requestId: "same-request", ok: true, result: { accepted: true } });
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});
void test("Trajectory relays target-addressed actions and rejects run-only subagent actions", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-actions-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const sockets: Socket[] = [];
  try {
    const origin = `http://127.0.0.1:${String(port)}`;
    const publisher = await handshake(port, origin);
    sockets.push(publisher.socket);
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "one" })));
    publisher.socket.write(maskedFrame(publisherState("one", "run")));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const browser = await handshake(port, origin);
    sockets.push(browser.socket);
    const state = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    await state;
    const runAction = readJsonFrame(publisher.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:action", requestId: "run-request", publisherId: "one", action: "retry", target: { kind: "run", id: "run-id" } })));
    assert.deepEqual(await runAction, { type: "publisher:action", requestId: "run-request", action: "retry", target: { kind: "run", id: "run-id" } });
    const subagentAction = readJsonFrame(publisher.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:action", requestId: "subagent-request", publisherId: "one", action: "steer", target: { kind: "subagent", id: "subagent" }, payload: { message: "continue" } })));
    assert.deepEqual(await subagentAction, { type: "publisher:action", requestId: "subagent-request", action: "steer", target: { kind: "subagent", id: "subagent" }, payload: { message: "continue" } });
    const rejection = readJsonFrame(browser.socket);
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:action", requestId: "rejection", publisherId: "one", action: "pause", target: { kind: "subagent", id: "subagent" } })));
    const value = await rejection as { requestId?: unknown; ok?: unknown; error?: unknown };
    assert.equal(value.requestId, "rejection");
    assert.equal(value.ok, false);
    assert.equal(value.error, "Trajectory action pause is not supported for subagent targets");
  } finally {
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    server.closeIdleConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("Trajectory server did not exit")); }, timeoutMs);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); resolve(code); });
  });
}

void test("Trajectory idle exit closes open clients and removes its lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-idle-exit-"));
  const port = await availablePort();
  const lockPath = join(root, "trajectory.lock");
  const moduleUrl = new URL("../src/server.js", import.meta.url).href;
  const childScript = `const realSetTimeout = globalThis.setTimeout; globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 300000 ? 10000 : delay, ...args); const { createTrajectoryServer } = await import(${JSON.stringify(moduleUrl)}); const server = createTrajectoryServer(${String(port)}, ${JSON.stringify(lockPath)}, { maxFrameBytes: 33554432, fingerprint: "test-fingerprint" }); server.listen(${String(port)}, "127.0.0.1");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: "ignore" });
  let socket: Socket | undefined;
  let pending: Socket | undefined;
  try {
    const connected = await handshakeWhenReady(port, `http://127.0.0.1:${String(port)}`);
    socket = connected.socket;
    const socketClosed = new Promise<void>((resolve) => socket?.once("close", () => { resolve(); }));
    assert.match(connected.response, /^HTTP\/1\.1 101 Switching Protocols/);
    // An unterminated request keeps a connection in flight, which is what actually blocks server.close().
    pending = createConnection(port, "127.0.0.1");
    await new Promise<void>((resolve, reject) => { pending?.once("connect", () => { resolve(); }); pending?.once("error", reject); });
    pending.write(`GET /health HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\n`);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(await waitForExit(child, 15000), 0);
    await socketClosed;
    await assert.rejects(readFile(lockPath), { code: "ENOENT" });
    await assert.rejects(fetch(`http://127.0.0.1:${String(port)}/health`));
  } finally {
    socket?.destroy();
    pending?.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
