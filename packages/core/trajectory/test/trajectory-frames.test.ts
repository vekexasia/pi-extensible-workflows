import assert from "node:assert/strict";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as serverModule from "../src/server.js";

const { createTrajectoryServer } = serverModule;
type DecodedFrame = { opcode: number; payload: Buffer };
type FrameDecoder = { buffered: number; needed: number };
type DecoderApi = { createFrameDecoder: () => FrameDecoder; decodeFrames: (decoder: FrameDecoder, chunk: Buffer, maxBytes: number) => Iterable<DecodedFrame> };
/** Resolved lazily so the socket-level cases still run against a build that predates the decoder export. */
function decoderApi(): DecoderApi {
  const api = serverModule as unknown as Partial<DecoderApi>;
  assert.equal(typeof api.createFrameDecoder, "function", "server.ts must export createFrameDecoder");
  assert.equal(typeof api.decodeFrames, "function", "server.ts must export decodeFrames");
  return api as DecoderApi;
}

const MASK = Buffer.from([0x37, 0xfa, 0x21, 0x3d]);

function header(first: number, length: number): Buffer {
  if (length < 126) return Buffer.from([first, 0x80 | length]);
  if (length <= 0xffff) { const value = Buffer.from([first, 0x80 | 126, 0, 0]); value.writeUInt16BE(length, 2); return value; }
  const value = Buffer.alloc(10); value[0] = first; value[1] = 0x80 | 127; value.writeBigUInt64BE(BigInt(length), 2); return value;
}

function maskedFrame(value: string | Buffer, first = 0x81): Buffer {
  const data = typeof value === "string" ? Buffer.from(value) : value;
  const body = Buffer.alloc(data.length);
  for (let index = 0; index < data.length; index += 1) body[index] = (data[index] ?? 0) ^ (MASK[index % 4] ?? 0);
  return Buffer.concat([header(first, data.length), MASK, body]);
}

function texts(frames: readonly DecodedFrame[]): string[] {
  return frames.map((frame) => { assert.equal(frame.opcode, 0x1); return frame.payload.toString("utf8"); });
}

function decodeAll(decoder: FrameDecoder, chunk: Buffer, maxBytes: number): DecodedFrame[] {
  return [...decoderApi().decodeFrames(decoder, chunk, maxBytes)];
}

/** Collects frames one by one so frames decoded before a protocol error stay observable. */
function decodeUntilError(decoder: FrameDecoder, chunk: Buffer, maxBytes: number): { frames: DecodedFrame[]; error: unknown } {
  const frames: DecodedFrame[] = [];
  try { for (const frame of decoderApi().decodeFrames(decoder, chunk, maxBytes)) frames.push(frame); } catch (error) { return { frames, error }; }
  return { frames, error: undefined };
}

function feed(decoder: FrameDecoder, bytes: Buffer, cuts: readonly number[], maxBytes: number): DecodedFrame[] {
  const frames: DecodedFrame[] = [];
  let start = 0;
  for (const cut of [...cuts, bytes.length]) {
    frames.push(...decodeAll(decoder, bytes.subarray(start, cut), maxBytes));
    assert.ok(decoder.buffered < maxBytes + 14, `residual ${String(decoder.buffered)} must stay below one maximal frame`);
    start = cut;
  }
  return frames;
}

void test("Trajectory frame decoder delivers every valid coalesced frame even when their sum exceeds the frame cap", () => {
  const { createFrameDecoder } = decoderApi();
  const maxBytes = 1000;
  const payloads = [JSON.stringify({ type: "publisher:attach", publisherId: "one" }), "a".repeat(990), "b".repeat(999 - 1), "c".repeat(125), "d".repeat(126), "é".repeat(300)];
  for (const payload of payloads) assert.ok(Buffer.byteLength(payload) < maxBytes);
  const wire = Buffer.concat(payloads.map((payload) => maskedFrame(payload)));
  assert.ok(wire.length > 2 * maxBytes);
  const decoder = createFrameDecoder();
  assert.deepEqual(texts(decodeAll(decoder, wire, maxBytes)), payloads);
  assert.equal(decoder.buffered, 0);
});

void test("Trajectory frame decoder keeps order across every header/body split and bounds the residual", () => {
  const { createFrameDecoder } = decoderApi();
  const maxBytes = 1000;
  const attach = JSON.stringify({ type: "publisher:attach", publisherId: "one" });
  const state = JSON.stringify({ type: "publisher:state", publisher: { id: "one" }, runs: [], subagents: [], pad: "x".repeat(700) });
  const wire = Buffer.concat([maskedFrame(attach), maskedFrame(state), maskedFrame("tail")]);
  for (let cut = 0; cut <= wire.length; cut += 1) {
    const decoder = createFrameDecoder();
    assert.deepEqual(texts(feed(decoder, wire, [cut], maxBytes)), [attach, state, "tail"], `split at ${String(cut)}`);
    assert.equal(decoder.buffered, 0);
  }
  const decoder = createFrameDecoder();
  assert.deepEqual(texts(feed(decoder, wire, Array.from({ length: wire.length - 1 }, (_, index) => index + 1), maxBytes)), [attach, state, "tail"]);
  const large = "L".repeat(70_000);
  const largeWire = Buffer.concat([maskedFrame(large), maskedFrame(attach)]);
  const largeDecoder = createFrameDecoder();
  assert.deepEqual(texts(feed(largeDecoder, largeWire, [1, 5, 9, 13, 14, 40_000, 70_014, 70_020], 100_000)), [large, attach]);
});

void test("Trajectory frame decoder rejects malicious lengths from the header before buffering the body", () => {
  const { createFrameDecoder } = decoderApi();
  const maxBytes = 1000;
  const cases: Buffer[] = [header(0x81, 1000), header(0x81, 5000), header(0x81, 70_000), Buffer.from([0x81, 0xff, 0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), Buffer.from([0x81, 0xff, 0x00, 0x20, 0x00, 0x00, 0x00, 0x00, 0x00, 0x01])];
  for (const bytes of cases) assert.throws(() => decodeAll(createFrameDecoder(), bytes, maxBytes), /too large/);
  const split = createFrameDecoder();
  assert.deepEqual(decodeAll(split, Buffer.from([0x81, 0xff, 0x7f, 0xff]), maxBytes), []);
  assert.ok(split.buffered <= 10);
  assert.throws(() => decodeAll(split, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), maxBytes), /too large/);
  const mixed = decodeUntilError(createFrameDecoder(), Buffer.concat([maskedFrame("ok"), header(0x81, 1_000_000)]), maxBytes);
  assert.deepEqual(texts(mixed.frames), ["ok"], "frames before the malicious header are still delivered in order");
  assert.match(String(mixed.error), /too large/);
});

void test("Trajectory frame decoder preserves mask, RSV, FIN, opcode, and control-frame checks", () => {
  const { createFrameDecoder } = decoderApi();
  const maxBytes = 1000;
  const invalid: [string, Buffer][] = [
    ["unmasked", Buffer.from([0x81, 0x02, 0x6f, 0x6b])],
    ["rsv1", maskedFrame("ok", 0xc1)],
    ["rsv3", maskedFrame("ok", 0x91)],
    ["no FIN / fragmented text", maskedFrame("ok", 0x01)],
    ["continuation", maskedFrame("ok", 0x80)],
    ["binary", maskedFrame("ok", 0x82)],
    ["reserved data opcode", maskedFrame("ok", 0x83)],
    ["reserved control opcode", maskedFrame("ok", 0x8b)],
    ["long ping", maskedFrame("p".repeat(126), 0x89)],
    ["fragmented ping", maskedFrame("p", 0x09)],
  ];
  for (const [name, bytes] of invalid) assert.throws(() => decodeAll(createFrameDecoder(), bytes, maxBytes), /Trajectory WebSocket/, name);
  const control = createFrameDecoder();
  const frames = decodeAll(control, Buffer.concat([maskedFrame("ping", 0x89), maskedFrame("", 0x8a), maskedFrame("text"), maskedFrame(Buffer.from([0x03, 0xe8]), 0x88)]), maxBytes);
  assert.deepEqual(frames.map((frame) => frame.opcode), [0x9, 0xa, 0x1, 0x8]);
  assert.equal(frames[0]?.payload.toString("utf8"), "ping");
  assert.equal(frames[2]?.payload.toString("utf8"), "text");
});

async function availablePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", () => { resolve(); }); });
  const address = probe.address();
  assert.ok(address && typeof address === "object");
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => { if (error) reject(error); else resolve(); }));
  return port;
}

type Harness = { port: number; origin: string; sockets: Socket[]; close(): Promise<void> };
async function startServer(maxFrameBytes: number): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "trajectory-frames-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { maxFrameBytes });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const sockets: Socket[] = [];
  return {
    port, origin: `http://127.0.0.1:${String(port)}`, sockets,
    async close() {
      for (const socket of sockets) socket.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      await rm(root, { recursive: true, force: true });
    },
  };
}

function upgradeRequest(port: number): string {
  return `GET /ws HTTP/1.1\r\nHost: 127.0.0.1:${String(port)}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nOrigin: http://127.0.0.1:${String(port)}\r\n\r\n`;
}

async function within<T>(promise: Promise<T>, label: string, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new Error(`timed out: ${label}`)); }, ms); })]); }
  finally { if (timer !== undefined) clearTimeout(timer); }
}

type Peer = { socket: Socket; next(accept?: (value: Record<string, unknown>) => boolean): Promise<Record<string, unknown>>; closed: Promise<void> };
/** Connects and writes the upgrade request plus any first frames in one write, so they arrive in the upgrade head. */
async function connect(harness: Harness, firstFrames: readonly Buffer[] = []): Promise<Peer> {
  const socket = createConnection(harness.port, "127.0.0.1");
  harness.sockets.push(socket);
  socket.setNoDelay(true);
  const closed = new Promise<void>((resolve) => { socket.once("close", () => { resolve(); }); });
  let buffer = Buffer.alloc(0);
  let upgraded = false;
  let markUpgraded: () => void = () => undefined;
  const upgradedPromise = new Promise<void>((resolve) => { markUpgraded = resolve; });
  const queue: Record<string, unknown>[] = [];
  const waiters: (() => void)[] = [];
  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!upgraded) {
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      assert.match(buffer.subarray(0, end).toString("latin1"), /^HTTP\/1\.1 101 /);
      buffer = buffer.subarray(end + 4);
      upgraded = true;
      markUpgraded();
    }
    for (;;) {
      if (buffer.length < 2) break;
      let offset = 2;
      let length = (buffer[1] ?? 0) & 0x7f;
      if (length === 126) { if (buffer.length < 4) break; length = buffer.readUInt16BE(2); offset = 4; }
      else if (length === 127) { if (buffer.length < 10) break; length = Number(buffer.readBigUInt64BE(2)); offset = 10; }
      if (buffer.length < offset + length) break;
      if (((buffer[0] ?? 0) & 0x0f) === 0x1) queue.push(JSON.parse(buffer.subarray(offset, offset + length).toString("utf8")) as Record<string, unknown>);
      buffer = buffer.subarray(offset + length);
    }
    for (const wake of waiters.splice(0)) wake();
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.once("connect", () => { socket.write(Buffer.concat([Buffer.from(upgradeRequest(harness.port), "latin1"), ...firstFrames])); resolve(); });
  });
  await within(upgradedPromise, "WebSocket upgrade");
  const next = async (accept: (value: Record<string, unknown>) => boolean = (value) => value.type !== "publisher:viewers"): Promise<Record<string, unknown>> => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const index = queue.findIndex(accept);
      if (index >= 0) return queue.splice(index, 1)[0] as Record<string, unknown>;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("timed out waiting for Trajectory frame");
      await Promise.race([new Promise<void>((resolve) => waiters.push(resolve)), closed.then(() => { throw new Error("socket closed while waiting for Trajectory frame"); }), new Promise((resolve) => setTimeout(resolve, remaining))]);
    }
  };
  return { socket, next, closed };
}

function publisherIds(state: Record<string, unknown>): string[] {
  const publishers = state.publishers;
  return Array.isArray(publishers) ? publishers.map((publisher) => String((publisher as { id?: unknown }).id)) : [];
}
function hasPublisher(id: string): (value: Record<string, unknown>) => boolean { return (value) => value.type === "state" && publisherIds(value).includes(id); }
function lacksPublisher(id: string): (value: Record<string, unknown>) => boolean { return (value) => value.type === "state" && !publisherIds(value).includes(id); }

function attachFrames(id: string, pad: number): Buffer[] {
  const state = JSON.stringify({ type: "publisher:state", publisher: { id, title: "t".repeat(pad) }, runs: [], subagents: [{ id: "subagent", state: "running" }] });
  return [maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: id })), maskedFrame(state)];
}

async function browser(harness: Harness): Promise<Peer> {
  const peer = await connect(harness, [maskedFrame(JSON.stringify({ type: "ui:attach" }))]);
  assert.equal((await peer.next()).type, "state");
  return peer;
}

void test("Trajectory server consumes coalesced attach and state frames whose sum exceeds the frame cap", async () => {
  const maxFrameBytes = 1000;
  const harness = await startServer(maxFrameBytes);
  try {
    const viewer = await browser(harness);
    const publisher = await connect(harness);
    const frames = [...attachFrames("coalesced", 800), maskedFrame("x".repeat(900))];
    assert.ok(Buffer.concat(frames).length > maxFrameBytes + 14);
    await new Promise<void>((resolve) => { publisher.socket.write(Buffer.concat(frames), () => { resolve(); }); });
    const state = await viewer.next(hasPublisher("coalesced"));
    assert.deepEqual(publisherIds(state), ["coalesced"]);
    assert.equal(publisher.socket.destroyed, false);
  } finally { await harness.close(); }
});

void test("Trajectory server decodes attach and state carried in the upgrade head", async () => {
  const harness = await startServer(1000);
  try {
    const viewer = await browser(harness);
    const publisher = await connect(harness, attachFrames("head", 800));
    assert.deepEqual(publisherIds(await viewer.next(hasPublisher("head"))), ["head"]);
    publisher.socket.destroy();
    await viewer.next(lacksPublisher("head"));
  } finally { await harness.close(); }
});

void test("Trajectory server applies close, invalid, and oversized frames from the upgrade head through the socket lifecycle", async () => {
  const harness = await startServer(1000);
  try {
    const viewer = await browser(harness);
    const cases: [string, Buffer][] = [["closing", maskedFrame(Buffer.alloc(0), 0x88)], ["invalid", maskedFrame("ok", 0x82)], ["oversized", header(0x81, 64 * 1024 * 1024)]];
    for (const [id, tail] of cases) {
      const peer = await connect(harness, [maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: id })), tail]);
      await viewer.next(hasPublisher(id));
      await viewer.next(lacksPublisher(id));
      await within(peer.closed, `${id} socket close`);
    }
    assert.equal(viewer.socket.destroyed, false);
  } finally { await harness.close(); }
});

void test("Trajectory server settles pending transcript requests when a head-attached publisher disconnects", async () => {
  const harness = await startServer(1000);
  try {
    const viewer = await browser(harness);
    const publisher = await connect(harness, attachFrames("pending", 10));
    await viewer.next(hasPublisher("pending"));
    viewer.socket.write(maskedFrame(JSON.stringify({ type: "ui:transcript", publisherId: "pending", subagentId: "subagent", requestId: "r1" })));
    const request = await publisher.next((value) => value.type === "publisher:transcript");
    assert.equal(request.subagentId, "subagent");
    publisher.socket.destroy();
    const reply = await viewer.next((value) => value.type === "transcript" && value.requestId === "r1");
    assert.equal(reply.ok, false);
    assert.equal(reply.status, "disconnected");
    await viewer.next(lacksPublisher("pending"));
  } finally { await harness.close(); }
});
