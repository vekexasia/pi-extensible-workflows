import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createConnection, createServer as createNetServer, type Socket } from "node:net";
import { watch } from "node:fs";
import { copyFile, lstat, mkdir, mkdtemp, readFile, rm, truncate, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SEMANTIC_MAP_ASSET_MANIFEST, SEMANTIC_MAP_BUILD_STAMP } from "../src/semantic-map-assets.js";
import { createTrajectoryServer } from "../src/server.js";
import { identityOf, releaseStartupMutex, tryAcquireStartupMutex } from "../src/startup-mutex.js";

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

function decodeTextFrame(buffer: Buffer): { payload: string; consumed: number } | undefined {
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
  return { payload: buffer.subarray(offset, offset + length).toString("utf8"), consumed: offset + length };
}

const frameLeftovers = new WeakMap<Socket, Buffer>();
function isViewerFrame(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { type?: unknown }).type === "publisher:viewers";
}
/** Reads one frame, keeping unread bytes so coalesced frames stay available to the next read. */
async function readJsonFrame(socket: Socket, accept: (value: unknown) => boolean = (value) => !isViewerFrame(value)): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let buffer = frameLeftovers.get(socket) ?? Buffer.alloc(0);
    const timer = setTimeout(() => { reject(new Error("timed out waiting for Trajectory frame")); }, 2000);
    const drain = (): boolean => {
      for (;;) {
        const decoded = decodeTextFrame(buffer);
        if (!decoded) { frameLeftovers.set(socket, buffer); return false; }
        buffer = buffer.subarray(decoded.consumed);
        const value: unknown = JSON.parse(decoded.payload);
        if (!accept(value)) continue;
        frameLeftovers.set(socket, buffer);
        clearTimeout(timer);
        socket.off("data", onData);
        resolve(value);
        return true;
      }
    };
    const onData = (chunk: Buffer) => { buffer = Buffer.concat([buffer, chunk]); drain(); };
    if (drain()) return;
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
    const lock: unknown = JSON.parse(await readFile(join(root, "trajectory.lock"), "utf8"));
    assert.ok(typeof lock === "object" && lock !== null && "startedAt" in lock && typeof lock.startedAt === "number" && lock.startedAt <= Date.now());
    assert.deepEqual({ ...lock, startedAt: undefined }, { ...identityOf(process.pid), port, fingerprint, startedAt: undefined });
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
    assert.equal((await fetch(`${base}/semantic-map.html`, { headers: { origin: "http://evil.test" } })).status, 403);
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

void test("Trajectory serves only versioned Semantic Map artifacts with restrictive policies and exact routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-semantic-map-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { fingerprint: "server:semantic-map-stamp" });
  await listen(server, port);
  try {
    const base = `http://127.0.0.1:${String(port)}`;
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.equal(page.headers.get("x-content-type-options"), "nosniff");
    assert.match(page.headers.get("content-security-policy") ?? "", /frame-src 'self'/);
    assert.match(page.headers.get("content-security-policy") ?? "", new RegExp(`ws://127\\.0\\.0\\.1:${String(port)}`));
    const paths = [
      [`/semantic-map.html?v=${SEMANTIC_MAP_BUILD_STAMP}&embed=1&theme=dark`, "text/html; charset=utf-8", "semantic-map.html"],
      [`/semantic-map.js?v=${SEMANTIC_MAP_BUILD_STAMP}`, "application/javascript; charset=utf-8", "semantic-map.js"],
      [`/semantic-map.css?v=${SEMANTIC_MAP_BUILD_STAMP}`, "text/css; charset=utf-8", "semantic-map.css"]
    ] as const;
    for (const [route, mime, asset] of paths) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200, route);
      assert.equal(response.headers.get("content-type"), mime);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), await readFile(new URL(`../assets/${asset}`, import.meta.url)));
      if (asset === "semantic-map.html") {
        const csp = response.headers.get("content-security-policy") ?? "";
        assert.match(csp, /default-src 'none'/);
        assert.match(csp, /connect-src 'none'/);
        assert.match(csp, /object-src 'none'/);
        assert.match(csp, /script-src 'self' 'unsafe-inline'/);
        assert.match(csp, /style-src 'self' 'unsafe-inline'/);
      } else assert.equal(response.headers.has("content-security-policy"), false);
    }
    for (const path of ["/semantic-map.json", "/semantic-map/semantic-map.js", "/%252e%252e/semantic-map.js", `/semantic-map.json?v=${SEMANTIC_MAP_BUILD_STAMP}`, `/semantic-map/semantic-map.js?v=${SEMANTIC_MAP_BUILD_STAMP}`]) assert.equal((await fetch(`${base}${path}`)).status, 404, path);
    // The version is mandatory and must name this build: never fall back to the current bytes.
    const stale = "0000000000000000";
    const rejectedQueries = ["", "?build=ignored", "?embed=1&theme=dark", "?v=", "?v", `?V=${SEMANTIC_MAP_BUILD_STAMP}`, `?v=${SEMANTIC_MAP_BUILD_STAMP}&v=${SEMANTIC_MAP_BUILD_STAMP}`, `?v=${SEMANTIC_MAP_BUILD_STAMP}&v=${stale}`, `?v=${SEMANTIC_MAP_BUILD_STAMP.toUpperCase()}`, `?v=${SEMANTIC_MAP_BUILD_STAMP}0`, `?v=${SEMANTIC_MAP_BUILD_STAMP.slice(1)}`, "?v=not-a-build-stamp", `?v=${stale}`, `?v=${stale}&embed=1&theme=dark`];
    for (const name of ["semantic-map.html", "semantic-map.js", "semantic-map.css"]) {
      for (const query of rejectedQueries) {
        const response = await fetch(`${base}/${name}${query}`);
        assert.equal(response.status, 404, `${name}${query}`);
        assert.equal(response.headers.get("cache-control"), "no-store", `${name}${query}`);
        assert.equal(response.headers.get("x-content-type-options"), "nosniff");
        assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
        assert.deepEqual(await response.json(), { error: "Not found" });
      }
      for (const method of ["POST", "PUT", "DELETE", "HEAD"]) assert.equal((await fetch(`${base}/${name}?v=${SEMANTIC_MAP_BUILD_STAMP}`, { method })).status, 404, `${method} ${name}`);
      assert.equal((await fetch(`${base}/${name}?v=${SEMANTIC_MAP_BUILD_STAMP}`, { headers: { origin: "http://evil.test" } })).status, 403);
    }
  } finally {
    server.closeAllConnections(); server.closeIdleConnections(); server.close(); server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

/** Copies the bundled server with its build files into `root`, laid out like the installed package. */
async function installBuild(root: string): Promise<{ server: string; parent: string; asset: (name: string) => string }> {
  const server = join(root, "trajectory", "src", "server.js");
  const parent = join(root, "trajectory", "src", "assets", "index.html");
  const asset = (name: string) => join(root, "trajectory", "assets", name);
  await mkdir(join(root, "trajectory", "src", "assets"), { recursive: true });
  await mkdir(join(root, "trajectory", "assets"), { recursive: true });
  await copyFile(new URL("../src/server.js", import.meta.url), server);
  await copyFile(new URL("../src/assets/index.html", import.meta.url), parent);
  for (const name of ["semantic-map.html", "semantic-map.js", "semantic-map.css"]) await copyFile(new URL(`../assets/${name}`, import.meta.url), asset(name));
  return { server, parent, asset };
}

void test("Trajectory server A never serves build B, partial or truncated files, and never reads the viewer at attach", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-ab-"));
  const port = await availablePort();
  const build = await installBuild(root);
  const originals = new Map<string, Buffer>();
  for (const name of ["semantic-map.html", "semantic-map.js", "semantic-map.css"]) originals.set(name, await readFile(build.asset(name)));
  const parentA = await readFile(build.parent);
  // Start without the 800 KB viewer: attach and state must not depend on reading or hashing it.
  await unlink(build.asset("semantic-map.html"));
  const child = spawn(process.execPath, [build.server, "--port", String(port), "--lock", join(root, "trajectory.lock"), "--fingerprint", "server-a"], { stdio: "ignore", windowsHide: true });
  let socket: Socket | undefined;
  const base = `http://127.0.0.1:${String(port)}`;
  const route = (name: string, version = SEMANTIC_MAP_BUILD_STAMP) => `${base}/${name}?v=${version}${name === "semantic-map.html" ? "&embed=1&theme=dark" : ""}`;
  const expectIncoherent = async (url: string, label: string) => {
    const response = await fetch(url);
    assert.equal(response.status, 503, label);
    assert.equal(response.headers.get("cache-control"), "no-store", label);
    assert.equal(response.headers.get("x-content-type-options"), "nosniff", label);
    assert.match(response.headers.get("content-type") ?? "", /^application\/json/, label);
    assert.equal(response.headers.has("content-security-policy"), false, label);
    assert.deepEqual(await response.json(), { error: "Trajectory build files do not match the running server" }, label);
  };
  const expectServed = async (name: string) => {
    const response = await fetch(route(name));
    assert.equal(response.status, 200, name);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), originals.get(name), `${name} is build A's exact bytes`);
  };
  try {
    const connected = await handshakeWhenReady(port, base);
    socket = connected.socket;
    assert.match(connected.response, /^HTTP\/1\.1 101 Switching Protocols/);
    socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    assert.equal((await readJsonFrame(socket) as { type?: unknown }).type, "state", "attach works while the viewer file is absent");
    // Missing viewer: every member of the incomplete set fails closed, including siblings whose own bytes are intact.
    for (const name of ["semantic-map.html", "semantic-map.js", "semantic-map.css"]) await expectIncoherent(route(name), `missing viewer: ${name}`);
    await writeFile(build.asset("semantic-map.html"), originals.get("semantic-map.html") ?? Buffer.alloc(0));
    for (const name of ["semantic-map.html", "semantic-map.js", "semantic-map.css"]) await expectServed(name);
    assert.equal((await fetch(`${base}/`)).status, 200);
    // Old URL (other build) against this server stays 404 even though coherent bytes exist.
    for (const name of ["semantic-map.html", "semantic-map.js", "semantic-map.css"]) assert.equal((await fetch(route(name, "0123456789abcdef"))).status, 404);

    // Same-size in-place replacement that keeps A's stamp marker text: only the bytes tell.
    const js = originals.get("semantic-map.js") ?? Buffer.alloc(0);
    assert.ok(js.toString("utf8").includes(`build ${SEMANTIC_MAP_BUILD_STAMP}`));
    const replaced = Buffer.from(js);
    replaced[replaced.length - 2] = replaced[replaced.length - 2] === 0x3b ? 0x20 : 0x3b;
    assert.equal(replaced.length, SEMANTIC_MAP_ASSET_MANIFEST.assets["semantic-map.js"].bytes);
    await writeFile(build.asset("semantic-map.js"), replaced);
    await expectIncoherent(route("semantic-map.js"), "same-size B js with retained marker");
    await expectServed("semantic-map.html");
    // Truncated file that still starts with A's marker: the requested file and its siblings refuse to serve.
    await writeFile(build.asset("semantic-map.js"), js);
    await truncate(build.asset("semantic-map.js"), 200);
    assert.ok((await readFile(build.asset("semantic-map.js"), "utf8")).includes(`build ${SEMANTIC_MAP_BUILD_STAMP}`));
    for (const name of ["semantic-map.html", "semantic-map.js", "semantic-map.css"]) await expectIncoherent(route(name), `truncated js: ${name}`);
    await writeFile(build.asset("semantic-map.js"), js);
    // Missing stylesheet and a build-B stylesheet carrying A's header.
    await unlink(build.asset("semantic-map.css"));
    for (const name of ["semantic-map.html", "semantic-map.js", "semantic-map.css"]) await expectIncoherent(route(name), `missing css: ${name}`);
    await writeFile(build.asset("semantic-map.css"), `/* Semantic Map ${SEMANTIC_MAP_BUILD_STAMP} */\n.b-build { color: red; }\n`);
    await expectIncoherent(route("semantic-map.css"), "css B with retained header");
    await writeFile(build.asset("semantic-map.css"), originals.get("semantic-map.css") ?? Buffer.alloc(0));
    // Viewer HTML replaced by a longer build-B file that keeps A's references.
    await writeFile(build.asset("semantic-map.html"), Buffer.concat([originals.get("semantic-map.html") ?? Buffer.alloc(0), Buffer.from("<!-- build B -->\n")]));
    for (const name of ["semantic-map.html", "semantic-map.js", "semantic-map.css"]) await expectIncoherent(route(name), `longer html B: ${name}`);
    await writeFile(build.asset("semantic-map.html"), originals.get("semantic-map.html") ?? Buffer.alloc(0));
    // Parent shell B with a different stamp beside server A: the parent is not served either.
    await writeFile(build.parent, parentA.toString("utf8").replaceAll(SEMANTIC_MAP_BUILD_STAMP, "0123456789abcdef"));
    for (const path of ["/", "/index.html"]) await expectIncoherent(`${base}${path}`, `parent B ${path}`);
    await unlink(build.parent);
    await expectIncoherent(`${base}/`, "missing parent");
    await writeFile(build.parent, parentA);

    // Restored build A is served again: checks are per request, not a sticky startup verdict.
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.deepEqual(Buffer.from(await page.arrayBuffer()), parentA);
    for (const name of ["semantic-map.html", "semantic-map.js", "semantic-map.css"]) await expectServed(name);
  } finally {
    socket?.destroy();
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await waitForExit(child, 5000).catch(() => undefined); }
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

type Health = { pid?: unknown; fingerprint?: unknown; startedAt?: unknown };
async function health(port: number): Promise<Health | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(300) });
    return response.ok ? await response.json() as Health : undefined;
  } catch { return undefined; }
}
function spawnServer(port: number, lockPath: string): ReturnType<typeof spawn> {
  return spawn(process.execPath, [fileURLToPath(new URL("../src/server.js", import.meta.url)), "--port", String(port), "--lock", lockPath, "--fingerprint", "test-fingerprint"], { stdio: "ignore" });
}

void test("Trajectory answers /health only after its lock names it", { skip: process.platform === "win32" ? "needs a POSIX FIFO" : false }, async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-publish-"));
  const port = await availablePort();
  const lockPath = join(root, "trajectory.lock");
  // A FIFO with no reader holds back any write into the existing lock file indefinitely.
  execFileSync("mkfifo", [lockPath]);
  const child = spawnServer(port, lockPath);
  try {
    let served: Health | undefined;
    for (let attempt = 0; attempt < 500 && served === undefined && child.exitCode === null; attempt += 1) {
      served = await health(port);
      if (served === undefined) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.ok(served, "Trajectory server never became healthy");
    assert.ok((await lstat(lockPath)).isFile(), "/health answered before the lock was published");
    const lock: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    assert.ok(child.pid);
    assert.deepEqual(lock, { ...identityOf(child.pid), port, fingerprint: "test-fingerprint", startedAt: served.startedAt });
    assert.equal(served.pid, child.pid);
  } finally {
    child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory server that cannot publish its lock exits without answering /health", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-publish-failure-"));
  const port = await availablePort();
  const child = spawnServer(port, join(root, "missing", "trajectory.lock"));
  const exited = waitForExit(child, 15000);
  try {
    let answered = false;
    while (child.exitCode === null && !answered) {
      answered = await health(port) !== undefined;
      if (!answered) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.equal(answered, false, "Trajectory reported ready without a lock");
    assert.equal(await exited, 1);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory server that cannot listen exits and leaves the current lock alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-port-taken-"));
  const occupant = createNetServer();
  await new Promise<void>((resolve, reject) => { occupant.once("error", reject); occupant.listen(0, "127.0.0.1", resolve); });
  const address = occupant.address();
  assert.ok(address && typeof address === "object");
  const lockPath = join(root, "trajectory.lock");
  const current = `${JSON.stringify({ pid: process.pid, port: address.port, fingerprint: "current", startedAt: Date.now() })}\n`;
  await writeFile(lockPath, current, "utf8");
  try {
    assert.equal(await waitForExit(spawnServer(address.port, lockPath), 15000), 1);
    assert.equal(await readFile(lockPath, "utf8"), current);
  } finally {
    await new Promise<void>((resolve) => { occupant.close(() => { resolve(); }); });
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory server whose startup was revoked exits without publishing its lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-revoked-"));
  const port = await availablePort();
  const lockPath = join(root, "trajectory.lock");
  // The Pi that launched it gave up and released the startup, so a later owner's lock must not be replaced.
  const current = `${JSON.stringify({ pid: process.pid, port, fingerprint: "current", startedAt: Date.now() })}\n`;
  await writeFile(lockPath, current, "utf8");
  const child = spawn(process.execPath, [fileURLToPath(new URL("../src/server.js", import.meta.url)), "--port", String(port), "--lock", lockPath, "--fingerprint", "test-fingerprint", "--startup", "revoked-token"], { stdio: "ignore" });
  try {
    assert.equal(await waitForExit(child, 15000), 1);
    assert.equal(await readFile(lockPath, "utf8"), current);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory idle exit keeps a lock another process published", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-idle-foreign-"));
  const port = await availablePort();
  const lockPath = join(root, "trajectory.lock");
  const moduleUrl = new URL("../src/server.js", import.meta.url).href;
  // Only the idle exit scheduled after the publisher detaches is shortened, so the lock is replaced before it can fire.
  const childScript = `const realSetTimeout = globalThis.setTimeout; let idleTimers = 0; globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 300000 && idleTimers++ > 0 ? 50 : delay, ...args); const { createTrajectoryServer } = await import(${JSON.stringify(moduleUrl)}); createTrajectoryServer(${String(port)}, ${JSON.stringify(lockPath)}, { fingerprint: "test-fingerprint" }).listen(${String(port)}, "127.0.0.1");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: "ignore" });
  const exited = waitForExit(child, 15000);
  let socket: Socket | undefined;
  try {
    socket = (await handshakeWhenReady(port, `http://127.0.0.1:${String(port)}`)).socket;
    const foreign = `${JSON.stringify({ pid: process.pid, port, fingerprint: "other", startedAt: Date.now() })}\n`;
    await writeFile(lockPath, foreign, "utf8");
    socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "idle" })));
    socket.write(maskedFrame(JSON.stringify({ type: "publisher:detach" })));
    assert.equal(await exited, 0);
    assert.equal(await readFile(lockPath, "utf8"), foreign);
  } finally {
    socket?.destroy();
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory idle exit waits while a Pi holds the startup mutex", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-idle-startup-"));
  const port = await availablePort();
  const lockPath = join(root, "trajectory.lock");
  const moduleUrl = new URL("../src/server.js", import.meta.url).href;
  const childScript = `const realSetTimeout = globalThis.setTimeout; let idleTimers = 0; globalThis.setTimeout = (callback, delay, ...args) => realSetTimeout(callback, delay === 300000 && idleTimers++ > 0 ? 50 : delay, ...args); const { createTrajectoryServer } = await import(${JSON.stringify(moduleUrl)}); createTrajectoryServer(${String(port)}, ${JSON.stringify(lockPath)}, { fingerprint: "test-fingerprint" }).listen(${String(port)}, "127.0.0.1");`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", childScript], { stdio: "ignore" });
  const exited = waitForExit(child, 15000);
  let socket: Socket | undefined;
  let watcher: ReturnType<typeof watch> | undefined;
  try {
    socket = (await handshakeWhenReady(port, `http://127.0.0.1:${String(port)}`)).socket;
    const token = await tryAcquireStartupMutex(lockPath);
    assert.ok(token);
    // The server's own acquisition attempt shows up as its temporary holder file in the mutex directory.
    const holders = watch(`${lockPath}.startup`);
    watcher = holders;
    const attempted = new Promise<void>((resolve) => { holders.on("change", (_event, name) => { if (String(name).includes(`.${String(child.pid)}.`)) resolve(); }); });
    socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "idle" })));
    socket.write(maskedFrame(JSON.stringify({ type: "publisher:detach" })));
    assert.equal(await Promise.race([attempted.then(() => "attempted"), exited.then(() => "exited")]), "attempted");
    assert.equal(child.exitCode, null);
    assert.equal((await health(port))?.pid, child.pid);

    await releaseStartupMutex(lockPath, token);
    assert.equal(await exited, 0);
    await assert.rejects(readFile(lockPath), { code: "ENOENT" });
  } finally {
    watcher?.close();
    socket?.destroy();
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited.catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

function timingState(id: string, revision: number, entries: number): string {
  const timing = Array.from({ length: entries }, (_, index) => ({ type: "custom", customType: "pi-workflows:tool-timing", data: { toolCallId: `call-${String(index)}`, toolName: "read", startedAt: 1_000 + index, completedAt: 1_100 + index, durationMs: 100, isError: false } }));
  return JSON.stringify({
    type: "publisher:state",
    publisher: { id },
    runs: [
      { run: { id: "focused", workflowName: "focused", agents: [], state: "running" }, transcripts: { agent: { revision, status: "available", timing } }, snapshot: {}, awaiting: [] },
      { run: { id: "other", workflowName: "other", agents: [], state: "completed" }, transcripts: { agent: { revision, status: "available", timing } }, snapshot: {}, awaiting: [] },
    ],
    subagents: [],
  });
}

type StateFrame = { publishers: { id: string; runs: { run: { id: string }; transcripts: { agent: { revision: number; timing?: unknown[] } } }[] }[] };
function stateFrame(value: unknown): StateFrame {
  assert.ok(value && typeof value === "object" && (value as { type?: unknown }).type === "state");
  return value as StateFrame;
}
function focusedTranscript(frame: StateFrame, runId: string): { revision: number; timing?: unknown[] } {
  const run = frame.publishers[0]?.runs.find((candidate) => candidate.run.id === runId);
  assert.ok(run);
  return run.transcripts.agent;
}

void test("Trajectory ships tool-timing once per revision to the focused browser", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-timing-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const origin = `http://127.0.0.1:${String(port)}`;
  const publisher = await handshake(port, origin);
  const browser = await handshake(port, origin);
  try {
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "pub" })));
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    await readJsonFrame(browser.socket);
    publisher.socket.write(maskedFrame(timingState("pub", 7, 3)));
    await readJsonFrame(browser.socket);

    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:focus", publisherId: "pub", runId: "focused" })));
    const first = stateFrame(await readJsonFrame(browser.socket));
    assert.equal(focusedTranscript(first, "focused").timing?.length, 3);
    assert.deepEqual(focusedTranscript(first, "other").timing, []);

    publisher.socket.write(maskedFrame(timingState("pub", 7, 3)));
    const repeated = stateFrame(await readJsonFrame(browser.socket));
    assert.equal(focusedTranscript(repeated, "focused").timing, undefined);

    publisher.socket.write(maskedFrame(timingState("pub", 8, 4)));
    const changed = stateFrame(await readJsonFrame(browser.socket));
    assert.equal(focusedTranscript(changed, "focused").timing?.length, 4);

    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:focus", publisherId: "pub", runId: "other" })));
    const switched = stateFrame(await readJsonFrame(browser.socket));
    assert.equal(focusedTranscript(switched, "other").timing?.length, 4);
    assert.deepEqual(focusedTranscript(switched, "focused").timing, []);
  } finally {
    publisher.socket.destroy();
    browser.socket.destroy();
    server.closeAllConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});

void test("Trajectory tells publishers how many browsers are watching", async () => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-server-viewers-"));
  const port = await availablePort();
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"));
  await listen(server, port);
  const origin = `http://127.0.0.1:${String(port)}`;
  const publisher = await handshake(port, origin);
  const browser = await handshake(port, origin);
  try {
    publisher.socket.write(maskedFrame(JSON.stringify({ type: "publisher:attach", publisherId: "pub" })));
    assert.deepEqual(await readJsonFrame(publisher.socket, isViewerFrame), { type: "publisher:viewers", count: 0 });
    browser.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    assert.deepEqual(await readJsonFrame(publisher.socket, isViewerFrame), { type: "publisher:viewers", count: 1 });
    browser.socket.write(maskedCloseFrame());
    assert.deepEqual(await readJsonFrame(publisher.socket, isViewerFrame), { type: "publisher:viewers", count: 0 });
    // A tab that dies sends FIN without a close frame, which must still drop the client.
    const dropped = await handshake(port, origin);
    dropped.socket.write(maskedFrame(JSON.stringify({ type: "ui:attach" })));
    assert.deepEqual(await readJsonFrame(publisher.socket, isViewerFrame), { type: "publisher:viewers", count: 1 });
    dropped.socket.end();
    assert.deepEqual(await readJsonFrame(publisher.socket, isViewerFrame), { type: "publisher:viewers", count: 0 });
  } finally {
    publisher.socket.destroy();
    browser.socket.destroy();
    server.closeAllConnections();
    server.close();
    server.unref();
    await rm(root, { recursive: true, force: true });
  }
});
