#!/usr/bin/env node
// W5 / G5 browser acceptance for the Trajectory Semantic Map on the current working-tree build (serial, headless Chrome).
//
//   PI_TRAJECTORY_CHROME=<chrome> node scripts/trajectory-semantic-map-acceptance.mjs [--out <dir>] [--phases a,b,...]
//        [--warmups 10] [--opens 50] [--ordinary-seconds 600] [--heap-cycles 50] [--heap-warmups 10]
//
// --heap-warmups defaults to 10, the original G5 heap protocol. Another value (for example 50) is an explicit, declared
// diagnostic deviation only and cannot close the original criterion. The tolerance formula is the same for every value.
//
// Phases (default all, in this order): security, races, opens, burst, limits, renderer, heap, ordinary.
// It drives the real built Trajectory server (packages/core/dist), a loopback publisher WebSocket, the production parent UI,
// the private MessagePort bridge and the opaque viewer. Instrumentation is injected only through CDP (never into shipped
// bytes). Raw samples, criteria and the candidate fingerprint go to --out. Exit 0 only when every required criterion passes.
// This is not part of `npm run check`: the ordinary phase alone runs ten real minutes. Chrome always gets a temporary profile.
import { execFileSync, spawn } from "node:child_process";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform, release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { URL, fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "packages", "core", "dist", "trajectory", "src");
const ALL_PHASES = ["security", "races", "opens", "burst", "limits", "renderer", "heap", "ordinary"];
const PERSONAL_PORT = 7432;
const out = (text) => { process.stdout.write(`${text}\n`); };

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write("Usage: PI_TRAJECTORY_CHROME=<chrome> node scripts/trajectory-semantic-map-acceptance.mjs [--out <dir>] [--phases list] [--warmups n] [--opens n] [--ordinary-seconds n] [--heap-cycles n] [--heap-warmups n (default 10; other values are diagnostic)]\n");
  process.exit(2);
}
/** Original G5 heap protocol: 10 open/close warm-up cycles before the control and candidate samples. */
export const ORIGINAL_HEAP_WARMUPS = 10;
export function parseArgs(argv) {
  const options = { out: undefined, phases: ALL_PHASES, warmups: 10, opens: 50, ordinarySeconds: 600, heapCycles: 50, heapWarmups: ORIGINAL_HEAP_WARMUPS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => { const next = argv[index + 1]; if (next === undefined) usage(`${arg} requires a value`); index += 1; return next; };
    const count = (name, min, max) => { const parsed = Number(value()); if (!Number.isInteger(parsed) || parsed < min || parsed > max) usage(`${name} must be an integer in ${String(min)}..${String(max)}`); return parsed; };
    if (arg === "--out") options.out = resolve(value());
    else if (arg === "--phases") { const phases = value().split(",").filter(Boolean); if (phases.some((phase) => !ALL_PHASES.includes(phase))) usage(`--phases accepts ${ALL_PHASES.join(",")}`); options.phases = ALL_PHASES.filter((phase) => phases.includes(phase)); }
    else if (arg === "--warmups") options.warmups = count("--warmups", 0, 100);
    else if (arg === "--opens") options.opens = count("--opens", 1, 500);
    else if (arg === "--ordinary-seconds") options.ordinarySeconds = count("--ordinary-seconds", 5, 3600);
    else if (arg === "--heap-cycles") options.heapCycles = count("--heap-cycles", 10, 500);
    else if (arg === "--heap-warmups") options.heapWarmups = count("--heap-warmups", 0, 500);
    else usage(`Unknown option ${arg}`);
  }
  return options;
}

function git(args) { try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 }); } catch { return undefined; } }
/** Same identity as scripts/demo-trajectory-semantic-map.mjs: HEAD plus the bytes of every dirty or untracked file. */
function candidateIdentity() {
  const head = git(["rev-parse", "HEAD"])?.trim() ?? "no-git";
  const entries = (git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]) ?? "").split("\0").filter(Boolean);
  const hash = createHash("sha256").update(`${head}\n`);
  const files = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.includes("R") || code.includes("C")) index += 1;
    let digest = "missing";
    try { digest = createHash("sha256").update(readFileSync(join(root, path))).digest("hex"); } catch { /* Deleted or a directory. */ }
    files.push({ code, path, sha256: digest });
    hash.update(`${code} ${path} ${digest}\n`);
  }
  const fingerprint = hash.digest("hex");
  return { head, dirtyEntries: files.length, fingerprint, id: `${head.slice(0, 7)}-${fingerprint.slice(0, 12)}`, files };
}

// ---------------------------------------------------------------------------------------------------------------------
// Statistics
const percentile = (values, p) => { if (!values.length) return Number.NaN; const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]; };
const stats = (values) => ({ n: values.length, min: Math.min(...values), p50: percentile(values, 50), p95: percentile(values, 95), p99: percentile(values, 99), max: Math.max(...values), mean: values.reduce((a, b) => a + b, 0) / (values.length || 1) });
const round = (value) => Math.round(value * 100) / 100;
const roundStats = (value) => Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "number" ? round(item) : item]));

// ---------------------------------------------------------------------------------------------------------------------
// CDP-injected probes. Counters and bounded arrays only: the harness never keeps references to app objects.
const PROBE = String.raw`(() => {
  if (window.__accProbe) return;
  const now = () => performance.now();
  const cap = (array, size) => { if (array.length > size) array.splice(0, array.length - size); };
  const tickOf = (text) => { const match = /Tick (\d{6})/.exec(text); return match ? Number(match[1]) : -1; };
  if (location.pathname.endsWith("/semantic-map.html")) {
    const probe = window.__accProbe = { kind: "child", origin: performance.timeOrigin, renders: [], slowMs: 0, count: 0 };
    let api;
    Object.defineProperty(window, "SemanticMap", { configurable: true, enumerable: true, get() { return api; }, set(value) {
      if (value && typeof value.render === "function" && !value.__accWrapped) {
        const original = value.render;
        value.render = function (snapshot) {
          const start = now();
          if (probe.slowMs > 0) { const until = start + probe.slowMs; while (now() < until) { /* Simulated slow render: delays the ACK. */ } }
          let tick = -1;
          try { for (const agent of (snapshot && snapshot.run && snapshot.run.agents) || []) { const found = tickOf(String(agent.name || "")); if (found >= 0) { tick = found; break; } } } catch { /* Probe only. */ }
          const graph = original.call(this, snapshot);
          const entry = { n: ++probe.count, tick, start, end: now(), nodes: graph && graph.nodes ? graph.nodes.length : -1, edges: graph && graph.edges ? graph.edges.length : -1, paint: -1 };
          probe.renders.push(entry); cap(probe.renders, 4000);
          requestAnimationFrame(() => requestAnimationFrame(() => { entry.paint = now(); }));
          return graph;
        };
        Object.defineProperty(value, "__accWrapped", { value: true });
      }
      api = value;
    } });
    return;
  }
  if (window !== window.top) return;
  const probe = window.__accProbe = { kind: "parent", origin: performance.timeOrigin, ws: [], sends: [], acks: [], readies: [], childRequests: [], channels: 0, portCloses: 0, pending: new Map(), intervals: 0 };
  const addListener = WebSocket.prototype.addEventListener;
  WebSocket.prototype.addEventListener = function (type, listener, options) {
    if (type !== "message" || typeof listener !== "function") return addListener.call(this, type, listener, options);
    return addListener.call(this, type, function (event) {
      const t = now();
      const text = typeof event.data === "string" ? event.data : "";
      probe.ws.push({ t, tick: tickOf(text), bytes: text.length }); cap(probe.ws, 5000);
      return listener.call(this, event);
    }, options);
  };
  const NativeChannel = window.MessageChannel;
  window.MessageChannel = class extends NativeChannel { constructor() { super(); probe.channels += 1; } };
  const nativeClose = MessagePort.prototype.close;
  MessagePort.prototype.close = function () { probe.portCloses += 1; return nativeClose.call(this); };
  const nativePost = MessagePort.prototype.postMessage;
  MessagePort.prototype.postMessage = function (message, ...rest) {
    if (message && message.type === "snapshot") {
      const text = JSON.stringify(message.snapshot);
      probe.sends.push({ t: now(), seq: message.sequence, epoch: message.epoch, instance: String(message.instance).slice(0, 12), tick: tickOf(text), bytes: text.length, leak: /ACC-PRIVATE/.test(text) }); cap(probe.sends, 5000);
    }
    return nativePost.call(this, message, ...rest);
  };
  const onmessage = Object.getOwnPropertyDescriptor(MessagePort.prototype, "onmessage");
  Object.defineProperty(MessagePort.prototype, "onmessage", { configurable: true, get() { return onmessage.get.call(this); }, set(callback) {
    onmessage.set.call(this, typeof callback !== "function" ? callback : function (event) {
      const data = event.data;
      if (data && typeof data === "object") {
        if (data.type === "ack") { probe.acks.push({ t: now(), seq: data.sequence, epoch: data.epoch, nodes: Array.isArray(data.nodeIds) ? data.nodeIds.length : -1, error: typeof data.error === "string" }); cap(probe.acks, 5000); }
        else if (data.type === "ready") probe.readies.push({ t: now() });
        else if (data.type === "select" || data.type === "detail") { probe.childRequests.push({ t: now(), type: data.type }); cap(probe.childRequests, 1000); }
      }
      return callback.call(this, event);
    });
  } });
  const nativeSetTimeout = window.setTimeout, nativeClearTimeout = window.clearTimeout;
  window.setTimeout = function (callback, ms, ...args) {
    if (typeof callback !== "function") return nativeSetTimeout.call(window, callback, ms, ...args);
    let id = 0;
    id = nativeSetTimeout.call(window, function () { probe.pending.delete(id); return callback.apply(this, arguments); }, ms, ...args);
    probe.pending.set(id, Number(ms) || 0);
    return id;
  };
  window.clearTimeout = function (id) { probe.pending.delete(id); return nativeClearTimeout.call(window, id); };
  probe.summary = () => ({ channels: probe.channels, portCloses: probe.portCloses, openPorts: probe.channels - probe.portCloses, watchdogs: [...probe.pending.values()].filter((ms) => ms === 10000).length, shortTimers: [...probe.pending.values()].filter((ms) => ms > 0 && ms <= 250).length, pendingTimers: probe.pending.size, iframes: document.querySelectorAll("#semantic-map-host iframe").length, status: document.getElementById("semantic-map-status")?.textContent || "" });
})();`;

// ---------------------------------------------------------------------------------------------------------------------
// Minimal flattened CDP client over one browser-level WebSocket.
class Cdp {
  constructor(socket) {
    this.socket = socket; this.nextId = 1; this.pending = new Map(); this.listeners = new Map();
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (typeof message.id === "number") {
        const request = this.pending.get(message.id);
        if (!request) return;
        this.pending.delete(message.id);
        if (message.error) request.reject(new Error(`${request.method}: ${String(message.error.message)}`)); else request.resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners.get(message.method) ?? []) listener(message.params ?? {}, message.sessionId);
    });
    socket.addEventListener("close", () => { for (const request of this.pending.values()) request.reject(new Error("CDP closed")); this.pending.clear(); });
  }
  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const promise = new Promise((resolveRequest, reject) => { this.pending.set(id, { method, resolve: resolveRequest, reject }); });
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return promise;
  }
  on(method, listener) { const set = this.listeners.get(method) ?? new Set(); set.add(listener); this.listeners.set(method, set); return () => { set.delete(listener); }; }
  close() { try { this.socket.close(); } catch { /* Already closed. */ } }
}

async function launchChrome(executable, stateDir) {
  const profile = mkdtempSync(join(stateDir, "chrome-"));
  const child = spawn(executable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.setEncoding("utf8"); child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-4000); });
  const exited = new Promise((resolveExit) => { child.once("close", () => { resolveExit(); }); });
  const activePort = join(profile, "DevToolsActivePort");
  let endpoint;
  for (let attempt = 0; attempt < 300 && !endpoint; attempt += 1) {
    if (child.exitCode !== null) break;
    try { const [port, path] = readFileSync(activePort, "utf8").split(/\r?\n/); if (port && path) endpoint = `ws://127.0.0.1:${port}${path}`; } catch { await delay(50); }
  }
  const stop = async () => {
    if (child.exitCode === null) child.kill();
    await Promise.race([exited, delay(5000)]);
    for (let attempt = 0; attempt < 20; attempt += 1) { try { rmSync(profile, { recursive: true, force: true }); break; } catch { await delay(100); } }
    return { pid: child.pid, exited: child.exitCode !== null || child.signalCode !== null, profileRemoved: !existsSync(profile) };
  };
  if (!endpoint) { await stop(); throw new Error(`Chrome DevTools did not start: ${stderr.trim()}`); }
  const socket = new globalThis.WebSocket(endpoint);
  await new Promise((resolveOpen, reject) => { socket.addEventListener("open", () => { resolveOpen(); }, { once: true }); socket.addEventListener("error", () => { reject(new Error("CDP connection failed")); }, { once: true }); });
  return { cdp: new Cdp(socket), pid: child.pid, stop };
}

/** One page target with probes, flattened auto-attach to (possibly out-of-process) viewer frames, and bounded network capture. */
async function openPage(cdp, url, { network = false } = {}) {
  const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
  const page = { targetId, sessionId, frames: new Map(), frameUrls: new Map(), contexts: new Map(), network, networkEvents: [], media: undefined, disposers: [] };
  const child = (params, parent) => parent === sessionId || page.frames.has(parent);
  page.disposers.push(cdp.on("Target.attachedToTarget", (params, parent) => {
    if (parent !== sessionId) return;
    const info = params.targetInfo ?? {};
    const attached = params.sessionId;
    const setup = [];
    if (info.type === "iframe") {
      page.frames.set(attached, { targetId: info.targetId, url: info.url, attachedAt: performance.now() });
      setup.push(cdp.send("Runtime.enable", {}, attached), cdp.send("Page.enable", {}, attached), cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE }, attached));
      if (page.network) setup.push(cdp.send("Network.enable", {}, attached));
      if (page.media) setup.push(cdp.send("Emulation.setEmulatedMedia", page.media, attached));
    }
    void Promise.allSettled(setup).then(() => cdp.send("Runtime.runIfWaitingForDebugger", {}, attached)).catch(() => { /* Target went away. */ });
  }));
  page.disposers.push(cdp.on("Target.detachedFromTarget", (params, parent) => { if (parent === sessionId) page.frames.delete(params.sessionId); }));
  page.disposers.push(cdp.on("Target.targetInfoChanged", (params) => { for (const frame of page.frames.values()) if (frame.targetId === params.targetInfo?.targetId) frame.url = params.targetInfo.url; }));
  page.disposers.push(cdp.on("Page.frameNavigated", (params, parent) => { if (parent === sessionId && params.frame) page.frameUrls.set(params.frame.id, params.frame.url); }));
  page.disposers.push(cdp.on("Runtime.executionContextCreated", (params, parent) => { const aux = params.context?.auxData; if (parent === sessionId && aux?.isDefault) page.contexts.set(aux.frameId, params.context.id); }));
  const record = (kind) => (params, parent) => {
    if (!child(params, parent)) return;
    const url = params.request?.url ?? params.response?.url;
    if (kind === "request" && !String(url).includes("/semantic-map.")) return;
    if (page.networkEvents.length >= 20_000) return;
    page.networkEvents.push({ kind, session: parent === sessionId ? "page" : "frame", requestId: params.requestId, ...(url ? { url: String(url).replace(/^https?:\/\/[^/]+/, "") } : {}), timestamp: params.timestamp,
      ...(kind === "request" ? { initiator: params.initiator?.type, initiatorUrl: String(params.initiator?.url ?? "").replace(/^https?:\/\/[^/]+/, ""), resourceType: params.type } : {}),
      ...(kind === "response" ? { status: params.response?.status, cacheControl: params.response?.headers?.["cache-control"] ?? params.response?.headers?.["Cache-Control"], fromDiskCache: params.response?.fromDiskCache, fromPrefetchCache: params.response?.fromPrefetchCache } : {}),
      ...(kind === "finished" ? { encodedDataLength: params.encodedDataLength } : {}),
      ...(kind === "failed" ? { errorText: params.errorText, canceled: params.canceled } : {}) });
  };
  page.disposers.push(cdp.on("Network.requestWillBeSent", record("request")), cdp.on("Network.responseReceived", record("response")), cdp.on("Network.loadingFinished", record("finished")), cdp.on("Network.loadingFailed", record("failed")));
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: PROBE }, sessionId);
  await cdp.send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
  if (network) await cdp.send("Network.enable", {}, sessionId);
  await cdp.send("Page.navigate", { url }, sessionId);
  page.eval = async (expression, contextSession = sessionId, contextId) => {
    const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(contextId ? { contextId } : {}) }, contextSession);
    if (result.exceptionDetails) throw new Error(`Evaluation failed: ${String(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)}`);
    return result.result?.value;
  };
  /** Evaluates in the current viewer frame: out-of-process target session first, in-process execution context otherwise. */
  page.childEval = async (expression) => {
    for (const frameSession of [...page.frames.keys()].reverse()) {
      try { return await page.eval(expression, frameSession); } catch { /* Try another route. */ }
    }
    const frameId = [...page.frameUrls].reverse().find(([, frameUrl]) => String(frameUrl).includes("/semantic-map.html"))?.[0];
    if (frameId && page.contexts.has(frameId)) return page.eval(expression, sessionId, page.contexts.get(frameId));
    throw new Error("No Semantic Map viewer context");
  };
  page.frameSession = () => [...page.frames.keys()].at(-1);
  page.setNetwork = async (enabled) => {
    page.network = enabled;
    const method = enabled ? "Network.enable" : "Network.disable";
    await cdp.send(method, {}, sessionId);
    for (const frameSession of page.frames.keys()) await cdp.send(method, {}, frameSession).catch(() => undefined);
  };
  page.close = async () => { for (const dispose of page.disposers) dispose(); await cdp.send("Target.closeTarget", { targetId }).catch(() => undefined); };
  return page;
}

async function waitUntil(check, timeoutMs, label, intervalMs = 10) {
  const deadline = performance.now() + timeoutMs;
  let last;
  while (performance.now() < deadline) {
    try { last = await check(); if (last) return last; } catch (error) { last = error; }
    await delay(intervalMs);
  }
  throw new Error(`Timed out after ${String(timeoutMs)} ms waiting for ${label}${last instanceof Error ? ` (${last.message})` : ""}`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Publisher state (the real server relays it to the real UI). Private strings must never reach the viewer.
const pad = (value) => String(value).padStart(6, "0");
function agent(id, name, state = "running", extra = {}) {
  return {
    id, name, label: name, state, attempts: 1, startedAt: Date.now() - 60_000, durationMs: state === "running" ? undefined : 20, structuralPath: ["acceptance"],
    attemptDetails: [{ attempt: 1, transport: "local", setup: { cwd: "ACC-PRIVATE-CWD", systemPrompt: "ACC-PRIVATE-PROMPT" } }],
    prompt: "ACC-PRIVATE-PROMPT", systemPrompt: "ACC-PRIVATE-SYSTEM", args: { secret: "ACC-PRIVATE-ARGS" },
    output: { status: state === "completed" ? "available" : "pending", value: "ACC-PRIVATE-RESULT" }, tools: ["read"], ...extra
  };
}
function run(id, name, agents, relations = []) {
  return { id, workflowName: name, cwd: "ACC-PRIVATE-CWD", sessionId: "acc-session", state: "running", startedAt: Date.now() - 60_000, agents, relations, events: [], script: "ACC-PRIVATE-SCRIPT", args: { secret: "ACC-PRIVATE-ARGS" } };
}
/** Ordinary scenario: label change every tick, a status flip every 5th, insert at tick%20==10, removal at tick%20==0. */
function ordinaryRun(tick) {
  const agents = [agent("ticker", `Tick ${pad(tick)}`), ...[1, 2, 3, 4].map((index) => agent(`worker-${String(index)}`, `Worker ${String(index)}`, Math.floor(tick / 5) % 4 === index - 1 ? "completed" : "running"))];
  if (tick % 20 >= 10) agents.push(agent(`late-${String(Math.floor(tick / 20))}`, `Late ${String(Math.floor(tick / 20))}`));
  return run("acc-run", "Acceptance run", agents, [{ id: "rel-1", kind: "dependency", fromAgentId: "worker-1", toAgentId: "worker-2" }]);
}
const tickKind = (tick) => tick % 20 === 10 ? "insert" : tick % 20 === 0 ? "remove" : tick % 5 === 0 ? "status" : "label";
function limitsRun() {
  const agents = Array.from({ length: 18 }, (_, index) => agent(`agent-${String(index).padStart(2, "0")}`, `Agent ${String(index).padStart(2, "0")}`));
  const relations = Array.from({ length: 9 }, (_, index) => ({ id: `relation-${String(index)}`, kind: index % 2 ? "dependency" : "fork", fromAgentId: `agent-${String(index).padStart(2, "0")}`, toAgentId: `agent-${String(index + 1).padStart(2, "0")}` }));
  return run("limits-run", "Parent limits run", agents, relations);
}
const XSS_NAME = `<img src=x onerror="window.__xss=1;parent.__xss=1"></script><script>window.__xss=2</script>`;
function xssRun() { return run("xss-run", `<svg onload="window.__xss=3">`, [agent("xss-agent", XSS_NAME), agent("plain-agent", "Plain agent")]); }

class Publisher {
  constructor(port, id) { this.port = port; this.id = id; this.runs = new Map(); this.sent = 0; }
  async connect() {
    this.socket = new globalThis.WebSocket(`ws://127.0.0.1:${String(this.port)}/ws`);
    await new Promise((resolveOpen, reject) => { this.socket.addEventListener("open", () => { resolveOpen(); }, { once: true }); this.socket.addEventListener("error", () => { reject(new Error("publisher connect failed")); }, { once: true }); });
    this.socket.send(JSON.stringify({ type: "publisher:attach", publisherId: this.id }));
  }
  set(value) { this.runs.set(value.id, value); }
  publish() {
    this.sent += 1;
    this.socket.send(JSON.stringify({ type: "publisher:state", publisher: { id: this.id, title: "Acceptance publisher", cwd: "/acceptance", sessionId: "acc-session", connected: true },
      runs: [...this.runs.values()].map((item) => ({ run: item, snapshot: { script: "ACC-PRIVATE-SCRIPT", args: { secret: "ACC-PRIVATE-ARGS" } }, transcripts: {} })), subagents: [] }));
  }
  close() { try { this.socket?.close(); } catch { /* Closed. */ } }
}

async function freePort() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const probe = createServer();
    await new Promise((resolveListen, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolveListen); });
    const { port } = probe.address();
    await new Promise((resolveClose) => { probe.close(() => { resolveClose(); }); });
    if (port !== PERSONAL_PORT) return port;
  }
  throw new Error("no free loopback port");
}

// ---------------------------------------------------------------------------------------------------------------------
// Shared UI helpers
const PARENT = {
  open: "(()=>{const t=performance.now();document.getElementById('semantic-map-tab').click();return t})()",
  close: "(()=>{const t=performance.now();document.getElementById('timeline-tab').click();return t})()",
  summary: "window.__accProbe.summary()",
  counts: "({ws:window.__accProbe.ws.length,sends:window.__accProbe.sends.length,acks:window.__accProbe.acks.length,readies:window.__accProbe.readies.length,childRequests:window.__accProbe.childRequests.length})",
  hide: "Object.defineProperty(document,'hidden',{configurable:true,get:()=>true});document.dispatchEvent(new Event('visibilitychange'))",
  show: "Object.defineProperty(document,'hidden',{configurable:true,get:()=>false});document.dispatchEvent(new Event('visibilitychange'))"
};
const slice = (page, name, from) => page.eval(`window.__accProbe.${name}.slice(${String(from)})`);
async function childRenders(page) { return page.childEval("({origin:window.__accProbe.origin,renders:window.__accProbe.renders.slice(-4000)})"); }
async function mapTargets(cdp) { const { targetInfos } = await cdp.send("Target.getTargets"); return targetInfos.filter((info) => String(info.url).includes("/semantic-map.html")).length; }

/** Conservative first-visible / accepted-to-visible latency: parent clock up to the ACK plus the child's own render-to-paint time, cross-checked with the absolute clocks. */
function visibleLatency(parentOrigin, parentStart, ackT, childOrigin, render) {
  const sameClock = ackT - parentStart + (render.paint - render.end);
  const crossClock = childOrigin + render.paint - (parentOrigin + parentStart);
  return { sameClock, crossClock, value: Math.max(sameClock, crossClock) };
}

// ---------------------------------------------------------------------------------------------------------------------
async function main() {
  const options = parseArgs(process.argv.slice(2));
  const chrome = process.env.PI_TRAJECTORY_CHROME;
  if (!chrome || !existsSync(chrome)) usage("PI_TRAJECTORY_CHROME must name a Chrome/Chromium executable; it is required for acceptance");
  const serverModule = join(dist, "server.js");
  if (!existsSync(serverModule)) usage("Build core first: node scripts/workspace-build.mjs core");
  const { createTrajectoryServer } = await import(pathToFileURL(serverModule).href);
  const { SEMANTIC_MAP_BUILD_STAMP, SEMANTIC_MAP_ASSET_MANIFEST } = await import(pathToFileURL(join(dist, "semantic-map-assets.js")).href);
  const identity = candidateIdentity();
  const outDir = options.out ?? join(root, ".tmp", "archify", "smart2-completion", "BROWSER_ACCEPTANCE", `run-${identity.id}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(outDir, { recursive: true });
  const write = (name, value) => { writeFileSync(join(outDir, name), `${JSON.stringify(value, null, 1)}\n`); };
  const stateDir = mkdtempSync(join(tmpdir(), "piewf-acc-"));
  const criteria = [];
  const criterion = (phase, name, pass, evidence) => { criteria.push({ phase, name, pass: Boolean(pass), evidence }); out(`${pass ? "PASS" : "FAIL"} [${phase}] ${name}: ${typeof evidence === "string" ? evidence : JSON.stringify(evidence)}`); };
  const environment = { node: process.version, platform: platform(), release: release(), arch: arch(), chrome, stamp: SEMANTIC_MAP_BUILD_STAMP, manifest: SEMANTIC_MAP_ASSET_MANIFEST.assets, startedAt: new Date().toISOString(), options };
  write("fingerprint.json", identity);
  out(`Candidate ${identity.id} (${String(identity.dirtyEntries)} dirty/untracked entries), stamp ${SEMANTIC_MAP_BUILD_STAMP}, out ${outDir}`);

  const port = await freePort();
  const server = createTrajectoryServer(port, join(stateDir, "trajectory.lock"), { fingerprint: "semantic-map-acceptance" });
  const requests = [];
  server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${String(port)}`);
    if (!url.pathname.startsWith("/semantic-map.")) return;
    const entry = { t: performance.now(), method: request.method, path: url.pathname, query: url.search, status: 0, bytes: 0 };
    if (requests.length < 50_000) requests.push(entry);
    const end = response.end.bind(response);
    response.end = (chunk, ...rest) => { entry.bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk?.byteLength ?? 0; return end(chunk, ...rest); };
    response.once("finish", () => { entry.status = response.statusCode; entry.finishedAt = performance.now(); });
  });
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolveListen); });
  const base = `http://127.0.0.1:${String(port)}`;
  const publisher = new Publisher(port, "accpublisher");
  await publisher.connect();
  let tick = 1;
  publisher.set(ordinaryRun(tick)); publisher.set(limitsRun()); publisher.set(xssRun());
  publisher.publish();
  const runUrl = (id) => `${base}/?view=run&run=${encodeURIComponent(`accpublisher:${id}`)}`;
  const browser = await launchChrome(chrome, stateDir);
  const { cdp } = browser;
  const results = { environment };
  let page;
  const newPage = async (network = false, id = "acc-run") => {
    const created = await openPage(cdp, runUrl(id), { network });
    await waitUntil(() => created.eval("Boolean(document.querySelector('.workflow-head')) && document.body.dataset.view==='run' && Boolean(window.__accProbe)"), 15_000, "parent UI");
    return created;
  };
  const openMap = async (target) => {
    const before = await target.eval(PARENT.counts);
    const t0 = await target.eval(PARENT.open);
    await waitUntil(async () => (await target.eval(`window.__accProbe.acks.length>${String(before.acks)} && document.getElementById('semantic-map-status').textContent.startsWith('Partial graph')`)) === true, 15_000, "first ACK");
    const render = await waitUntil(async () => { const child = await childRenders(target); const first = child.renders[0]; return first && first.paint > 0 ? { origin: child.origin, first } : undefined; }, 5_000, "first viewer paint");
    const [ack] = await slice(target, "acks", before.acks);
    const origin = await target.eval("window.__accProbe.origin");
    return { t0, ack, render, latency: visibleLatency(origin, t0, ack.t, render.origin, render.first) };
  };
  const closeMap = async (target) => {
    const t = await target.eval(PARENT.close);
    await waitUntil(async () => (await target.eval("document.querySelectorAll('#semantic-map-host iframe').length===0")) === true, 5_000, "map closed");
    return t;
  };
  const publishTick = (next) => { tick = next; publisher.set(ordinaryRun(tick)); publisher.publish(); };
  const waitVisibleTick = async (target, wanted, timeoutMs = 5_000) => waitUntil(async () => (await target.childEval(`[...document.querySelectorAll('.semantic-map-node')].some(n=>n.getAttribute('data-node-label')==='Tick ${pad(wanted)}')`)) === true, timeoutMs, `visible tick ${String(wanted)}`, 20);

  try {
    page = await newPage(false);
    for (const phase of options.phases) {
      const phaseStart = performance.now();
      out(`--- phase ${phase}`);
      if (phase === "security") {
        // Live-path XSS and privacy through publisher -> server -> parent -> bridge -> viewer, plus a keyboard-only path.
        await page.eval(`[...document.querySelectorAll('#sidebar [data-run]')].find(b=>b.dataset.run==='accpublisher:xss-run').click()`);
        await waitUntil(async () => (await page.eval("document.body.dataset.view")) === "run", 5_000, "xss run view");
        const opened = await openMap(page);
        const xss = await page.childEval(`(()=>{const node=[...document.querySelectorAll('.semantic-map-node')].find(n=>n.getAttribute('data-node-label')===${JSON.stringify(XSS_NAME)});return {found:Boolean(node),text:node?node.querySelector('text').textContent:null,markup:document.querySelectorAll('.diagram-container svg img,.diagram-container svg script,.diagram-container svg foreignObject').length,childXss:window.__xss??null,origin:self.origin}})()`);
        const parentXss = await page.eval("({xss:window.__xss??null,injected:document.querySelectorAll('img[src=\"x\"],svg[onload]').length})");
        criterion("security", "live-path XSS label renders as inert text in parent and opaque viewer", xss.found && xss.text === XSS_NAME && xss.markup === 0 && xss.childXss === null && parentXss.xss === null && parentXss.injected === 0 && xss.origin === "null", { ...xss, parent: parentXss, firstVisibleMs: round(opened.latency.value) });
        await delay(300);
        const sends = await slice(page, "sends", 0);
        criterion("security", "no private prompt/script/args/cwd/result string in any snapshot posted to the viewer", sends.length > 0 && sends.every((send) => !send.leak), { snapshots: sends.length, leaks: sends.filter((send) => send.leak).length });
        const sandbox = await page.eval("(()=>{const f=document.querySelector('#semantic-map-host iframe');return {sandbox:f.getAttribute('sandbox'),referrer:f.getAttribute('referrerpolicy'),src:new URL(f.src).search}})()");
        criterion("security", "iframe stays opaque: sandbox=allow-scripts only, no-referrer, versioned URL", sandbox.sandbox === "allow-scripts" && sandbox.referrer === "no-referrer" && sandbox.src.includes(`v=${SEMANTIC_MAP_BUILD_STAMP}`), sandbox);
        // Keyboard: node selection with Enter, detail with Shift+Enter inside the opaque viewer, then tabs with arrows.
        const reqBefore = (await page.eval(PARENT.counts)).childRequests;
        await page.eval("document.querySelector('#semantic-map-host iframe').focus()");
        const focused = await page.childEval("(()=>{const n=[...document.querySelectorAll('.semantic-map-node')].find(x=>x.getAttribute('data-node-label')==='Plain agent');n.focus();return document.activeElement===n})()");
        const key = async (keyName, code, keyCode, modifiers = 0) => {
          await cdp.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers }, page.sessionId);
          await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: keyName, code, windowsVirtualKeyCode: keyCode, modifiers }, page.sessionId);
        };
        await key("Enter", "Enter", 13);
        await waitUntil(async () => (await slice(page, "childRequests", reqBefore)).some((item) => item.type === "select"), 3_000, "keyboard select");
        await key("Enter", "Enter", 13, 8);
        await waitUntil(async () => (await page.eval("document.body.dataset.view")) === "agent", 3_000, "keyboard detail");
        const detailCrumb = await page.eval("document.getElementById('agent-crumb').textContent");
        criterion("security", "keyboard-only node select (Enter) and detail (Shift+Enter) in the opaque viewer reach the parent", focused === true && detailCrumb === "Plain agent", { focused, detailCrumb });
        await page.eval("document.getElementById('run-crumb').click()");
        await waitUntil(async () => (await page.eval("document.body.dataset.view")) === "run", 3_000, "back to run");
        await page.eval("document.getElementById('semantic-map-tab').focus()");
        await key("ArrowLeft", "ArrowLeft", 37);
        await waitUntil(async () => (await page.eval(PARENT.summary)).iframes === 0, 3_000, "arrow closes map");
        await key("ArrowRight", "ArrowRight", 39);
        await waitUntil(async () => (await page.eval("document.getElementById('semantic-map-status').textContent")).startsWith("Partial graph"), 5_000, "arrow reopens map");
        const tabState = await page.eval("({selected:document.getElementById('semantic-map-tab').getAttribute('aria-selected'),active:document.activeElement&&document.activeElement.id})");
        criterion("security", "tabs are keyboard operable (ArrowLeft closes, ArrowRight reopens with focus on the Map tab)", tabState.selected === "true" && tabState.active === "semantic-map-tab", tabState);
        // Theme and reduced motion reach the opaque viewer only through the private port and its own media query.
        await page.eval("document.documentElement.dataset.theme='light';window.__PIEWF_SEMANTIC_MAP_THEME__()");
        await waitUntil(async () => (await page.childEval("document.documentElement.getAttribute('data-theme')")) === "light", 3_000, "light theme in viewer");
        await page.eval("document.documentElement.dataset.theme='dark';window.__PIEWF_SEMANTIC_MAP_THEME__()");
        await waitUntil(async () => (await page.childEval("document.documentElement.getAttribute('data-theme')")) === "dark", 3_000, "dark theme in viewer");
        page.media = { features: [{ name: "prefers-reduced-motion", value: "reduce" }] };
        await cdp.send("Emulation.setEmulatedMedia", page.media, page.sessionId);
        const frameSession = page.frameSession();
        if (frameSession) await cdp.send("Emulation.setEmulatedMedia", page.media, frameSession);
        const reduced = await page.childEval("matchMedia('(prefers-reduced-motion: reduce)').matches");
        criterion("security", "theme (light/dark) and reduced-motion reach the opaque viewer", reduced === true, { reducedMotion: reduced, outOfProcessViewer: Boolean(frameSession) });
        await closeMap(page);
        await page.eval(`[...document.querySelectorAll('#sidebar [data-run]')].find(b=>b.dataset.run==='accpublisher:acc-run').click()`);
        await waitUntil(async () => (await page.eval("document.body.dataset.view")) === "run", 5_000, "acc run view");
      }
      if (phase === "races") {
        const quiet = async (label, action, extra = async () => ({})) => {
          await action();
          const closedAt = requests.length;
          const summaryAtClose = await page.eval(PARENT.summary);
          const acksAtClose = (await page.eval(PARENT.counts)).acks;
          for (const next of [1, 2, 3]) { publishTick(tick + 1); await delay(next === 3 ? 0 : 300); }
          await delay(11_000);
          const after = await page.eval(PARENT.summary);
          const lateRequests = requests.slice(closedAt).map(({ path, status }) => ({ path, status }));
          const lateAcks = (await page.eval(PARENT.counts)).acks - acksAtClose;
          const targets = await mapTargets(cdp);
          const evidence = { atClose: summaryAtClose, after11s: after, lateRequests, lateAcks, viewerTargets: targets, ...(await extra()) };
          criterion("races", `${label}: no frame/port/timer/request/stale effect after close`, after.iframes === 0 && after.openPorts === 0 && after.watchdogs === 0 && after.shortTimers === 0 && lateRequests.length === 0 && lateAcks === 0 && targets === 0 && !after.status.startsWith("Partial") && !after.status.includes("did not") && !after.status.includes("responding"), evidence);
        };
        await quiet("close before ready", async () => { await page.eval("document.getElementById('semantic-map-tab').click();document.getElementById('timeline-tab').click()"); });
        await quiet("close after frame load started (before ACK)", async () => {
          await page.eval(PARENT.open);
          await waitUntil(async () => requests.length > 0 && requests.at(-1).path === "/semantic-map.html", 3_000, "viewer navigation", 1);
          await closeMap(page);
        });
        await quiet("close during slow ACK/render", async () => {
          await openMap(page);
          await page.childEval("window.__accProbe.slowMs=1500");
          const sendsBefore = (await page.eval(PARENT.counts)).sends;
          publishTick(tick + 1);
          await waitUntil(async () => (await page.eval(PARENT.counts)).sends > sendsBefore, 3_000, "in-flight snapshot", 2);
          await delay(200);
          await closeMap(page);
        });
        // Hidden while a snapshot is in flight: no timers or sends while hidden; visible resyncs only current state.
        await openMap(page);
        await page.childEval("window.__accProbe.slowMs=600");
        const beforeHidden = await page.eval(PARENT.counts);
        publishTick(tick + 1);
        await waitUntil(async () => (await page.eval(PARENT.counts)).sends > beforeHidden.sends, 3_000, "in-flight before hide", 2);
        await page.eval(PARENT.hide);
        const hiddenSummary = await page.eval(PARENT.summary);
        const hiddenSends = (await page.eval(PARENT.counts)).sends;
        for (let index = 0; index < 4; index += 1) { publishTick(tick + 1); await delay(400); }
        await delay(1_000);
        const sendsWhileHidden = (await page.eval(PARENT.counts)).sends - hiddenSends;
        const hiddenAfter = await page.eval(PARENT.summary);
        await page.childEval("window.__accProbe.slowMs=0");
        await page.eval(PARENT.show);
        const shownAt = (await page.eval(PARENT.counts)).sends;
        await waitVisibleTick(page, tick, 5_000);
        await delay(600);
        const sendsAfterShow = (await page.eval(PARENT.counts)).sends - shownAt;
        criterion("races", "hidden during in-flight ACK: no watchdog/send timers or sends while hidden; visible sends only the current state", hiddenSummary.watchdogs === 0 && hiddenSummary.shortTimers === 0 && hiddenAfter.watchdogs === 0 && sendsWhileHidden === 0 && sendsAfterShow >= 1 && sendsAfterShow <= 2 && hiddenAfter.iframes === 1, { hiddenSummary, hiddenAfter, sendsWhileHidden, sendsAfterShow, visibleTick: tick });
        // Resize keeps the same viewer instance, stays rendered and requests nothing.
        const resizeRequests = requests.length;
        const channelsBefore = (await page.eval(PARENT.summary)).channels;
        const widths = [];
        for (const [width, height] of [[800, 600], [1600, 1000], [420, 700]]) {
          await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false }, page.sessionId);
          await delay(400);
          widths.push({ width, frame: await page.childEval("({w:innerWidth,h:innerHeight,nodes:document.querySelectorAll('.semantic-map-node').length})") });
        }
        await cdp.send("Emulation.clearDeviceMetricsOverride", {}, page.sessionId);
        await delay(300);
        const resizeSummary = await page.eval(PARENT.summary);
        criterion("races", "resize keeps one rendered viewer instance with no reopen and no request", requests.length === resizeRequests && resizeSummary.channels === channelsBefore && resizeSummary.iframes === 1 && widths.every((item) => item.frame.nodes > 0) && new Set(widths.map((item) => item.frame.w)).size === 3, { widths, requests: requests.length - resizeRequests, channels: resizeSummary.channels - channelsBefore });
        await quiet("plain close after ACK", async () => { await closeMap(page); });
      }
      if (phase === "opens") {
        await page.setNetwork(true);
        page.networkEvents.length = 0;
        const cycles = [];
        for (let index = 0; index < options.warmups + options.opens; index += 1) {
          const requestStart = requests.length;
          const networkStart = page.networkEvents.length;
          const opened = await openMap(page);
          await closeMap(page);
          await delay(60);
          const cycleRequests = requests.slice(requestStart);
          const lateAfterClose = requests.length - requestStart - cycleRequests.filter((item) => item.finishedAt !== undefined).length;
          cycles.push({ index, warmup: index < options.warmups, firstVisibleMs: round(opened.latency.value), sameClockMs: round(opened.latency.sameClock), crossClockMs: round(opened.latency.crossClock), ackMs: round(opened.ack.t - opened.t0), renderMs: round(opened.render.first.end - opened.render.first.start), nodes: opened.ack.nodes,
            requests: cycleRequests.map(({ path, status, bytes, query }) => ({ path, status, bytes, v: query.includes(`v=${SEMANTIC_MAP_BUILD_STAMP}`) })), unfinished: lateAfterClose, network: page.networkEvents.slice(networkStart) });
          await delay(40);
        }
        await page.setNetwork(false);
        const measured = cycles.filter((cycle) => !cycle.warmup);
        const firstVisible = stats(measured.map((cycle) => cycle.firstVisibleMs));
        results.opens = { firstVisible: roundStats(firstVisible), sameClock: roundStats(stats(measured.map((cycle) => cycle.sameClockMs))), crossClock: roundStats(stats(measured.map((cycle) => cycle.crossClockMs))), warmup: roundStats(stats(cycles.filter((cycle) => cycle.warmup).map((cycle) => cycle.firstVisibleMs))) };
        write("opens.json", { summary: results.opens, cycles });
        criterion("opens", `${String(options.warmups)} warm-ups then ${String(options.opens)} complete opens: click -> first snapshot visible p95 <= 1000 ms`, measured.length === options.opens && firstVisible.p95 <= 1000, results.opens.firstVisible);
        const everyThree = measured.every((cycle) => ["/semantic-map.html", "/semantic-map.js", "/semantic-map.css"].every((path) => cycle.requests.filter((item) => item.path === path && item.status === 200 && item.v).length >= 1 && cycle.network.some((event) => event.kind === "response" && event.url?.startsWith(path)) && cycle.network.filter((event) => event.kind === "response" && event.url?.startsWith(path)).every((event) => event.cacheControl === "no-store" && event.status === 200)));
        const bytes = measured.map((cycle) => cycle.requests.reduce((total, item) => total + item.bytes, 0));
        const manifestBytes = ["semantic-map.html", "semantic-map.js", "semantic-map.css"].reduce((total, name) => total + SEMANTIC_MAP_ASSET_MANIFEST.assets[name].bytes, 0);
        criterion("opens", "every open fetched all three versioned no-store assets fresh (no HTTP cache reuse)", everyThree && measured.every((cycle) => !cycle.network.some((event) => event.fromDiskCache || event.fromPrefetchCache)), { opens: measured.length, rawManifestBytes: manifestBytes, httpBodyBytesPerOpen: roundStats(stats(bytes)) });
        // CSS/duplicate investigation from server log plus CDP initiator/timing/body bytes, not a blanket ">= 3".
        const duplicates = [];
        for (const cycle of cycles) for (const path of ["/semantic-map.html", "/semantic-map.js", "/semantic-map.css"]) {
          const served = cycle.requests.filter((item) => item.path === path);
          const sent = cycle.network.filter((event) => event.kind === "request" && event.url?.startsWith(path));
          if (served.length > 1 || sent.length > 1) duplicates.push({ cycle: cycle.index, path, served: served.map(({ status, bytes: size }) => ({ status, bytes: size })), cdp: cycle.network.filter((event) => event.url?.startsWith(path) || sent.some((request) => request.requestId === event.requestId)) });
        }
        const initiators = {};
        for (const cycle of measured) for (const event of cycle.network) if (event.kind === "request") { const key = `${event.url.split("?")[0]} <- ${event.session}:${String(event.initiator)}${event.initiatorUrl ? `:${event.initiatorUrl.split("?")[0]}` : ""}`; initiators[key] = (initiators[key] ?? 0) + 1; }
        const cdpBytes = {};
        for (const cycle of measured) for (const event of cycle.network) if (event.kind === "finished") { const request = cycle.network.find((item) => item.kind === "request" && item.requestId === event.requestId); if (request) { const key = request.url.split("?")[0]; (cdpBytes[key] ??= []).push(event.encodedDataLength); } }
        const css = { duplicates, initiators, cdpEncodedBytes: Object.fromEntries(Object.entries(cdpBytes).map(([key, values]) => [key, roundStats(stats(values))])), serverRequestsPerPath: Object.fromEntries(["/semantic-map.html", "/semantic-map.js", "/semantic-map.css"].map((path) => [path, measured.reduce((total, cycle) => total + cycle.requests.filter((item) => item.path === path).length, 0)])) };
        results.css = css;
        write("css-investigation.json", css);
        criterion("opens", "CSS/asset duplicate investigation: exactly one request per asset per open (server log and CDP initiators agree)", duplicates.length === 0 && Object.values(css.serverRequestsPerPath).every((count) => count === measured.length), { duplicates: duplicates.length, serverRequestsPerPath: css.serverRequestsPerPath, initiators });
      }
      if (phase === "burst") {
        await openMap(page);
        const runBurst = async (slowMs, count, rateHz) => {
          await page.childEval(`window.__accProbe.slowMs=${String(slowMs)}`);
          const before = await page.eval(PARENT.counts);
          const first = tick + 1;
          const started = performance.now();
          for (let index = 0; index < count; index += 1) {
            publishTick(tick + 1);
            const wait = started + ((index + 1) * 1000) / rateHz - performance.now();
            if (wait > 0) await delay(wait);
          }
          const last = tick;
          await waitVisibleTick(page, last, 15_000);
          await delay(Math.max(1_000, slowMs * 2));
          await page.childEval("window.__accProbe.slowMs=0");
          const ws = (await slice(page, "ws", before.ws)).filter((item) => item.tick >= first);
          const sends = (await slice(page, "sends", before.sends)).filter((item) => item.tick >= first);
          const acks = await slice(page, "acks", before.acks);
          const child = await childRenders(page);
          const origin = await page.eval("window.__accProbe.origin");
          const events = [...sends.map((send) => ({ t: send.t, d: 1 })), ...acks.map((ack) => ({ t: ack.t, d: -1 }))].sort((a, b) => a.t - b.t || a.d - b.d);
          let inFlight = 0, maxInFlight = 0;
          for (const event of events) { inFlight = Math.max(0, inFlight + event.d); maxInFlight = Math.max(maxInFlight, inFlight); }
          let maxPerSecond = 0;
          for (const send of sends) maxPerSecond = Math.max(maxPerSecond, sends.filter((other) => other.t >= send.t && other.t < send.t + 1000).length);
          const lastAccepted = ws.filter((item) => item.tick === last).at(0);
          const lastRender = child.renders.find((item) => item.tick === last);
          const lastSend = sends.find((send) => send.tick === last);
          const lastAck = acks.find((ack) => ack.seq === lastSend?.seq);
          const convergence = lastAccepted && lastRender && lastAck ? visibleLatency(origin, lastAccepted.t, lastAck.t, child.origin, lastRender) : undefined;
          const sendsAfterLastAccepted = lastAccepted ? sends.filter((send) => send.t >= lastAccepted.t).length : -1;
          return { slowMs, published: count, rateHz, accepted: ws.length, sent: sends.length, replaced: ws.length - sends.length, maxSendsPerSecond: maxPerSecond, maxInFlight, sendsAfterLastAccepted, lastTick: last, convergenceMs: convergence ? round(convergence.value) : null, minGapMs: round(Math.min(...sends.slice(1).map((send, index) => send.t - sends[index].t))) };
        };
        const fast = await runBurst(0, 100, 20);
        const slow = await runBurst(400, 60, 20);
        results.burst = { fast, slow };
        write("burst.json", results.burst);
        for (const item of [fast, slow]) criterion("burst", `20 Hz burst with ${String(item.slowMs)} ms render: <= 4 sends/s, one active + one replaceable pending, last state converges`, item.maxSendsPerSecond <= 4 && item.maxInFlight <= 1 && item.replaced > 0 && item.sendsAfterLastAccepted <= 2 && item.convergenceMs !== null && item.minGapMs >= 245, item);
        await closeMap(page);
      }
      if (phase === "limits") {
        await page.eval(`[...document.querySelectorAll('#sidebar [data-run]')].find(b=>b.dataset.run==='accpublisher:limits-run').click()`);
        await waitUntil(async () => (await page.eval("document.body.dataset.view")) === "run", 5_000, "limits run view");
        await openMap(page);
        const graph = await page.childEval("(()=>{const nodes=[...document.querySelectorAll('.semantic-map-node')];const labels=new Set(nodes.filter(n=>/^Agent \\d\\d$/.test(n.getAttribute('data-node-label'))).map(n=>n.getAttribute('data-node-label')));return {nodes:nodes.length,agents:labels.size,relations:[...document.querySelectorAll('.semantic-map-edge')].filter(e=>['dependency','fork','merge'].includes(e.getAttribute('data-edge-type'))).length,notice:document.getElementById('semantic-map-completeness')?.textContent||''}})()");
        results.limits = { source: { agents: 18, relations: 9 }, parentLimits: { agents: 16, relations: 8, toolCalls: 16 }, drawn: graph };
        write("limits.json", results.limits);
        criterion("limits", "parent projection honours 16 agents / 8 recorded relations and says so (source 18/9)", graph.agents === 16 && graph.relations <= 8 && graph.notice.includes("Source agent list bounded") && graph.notice.includes("Recorded relation list bounded"), graph);
        await closeMap(page);
        await page.eval(`[...document.querySelectorAll('#sidebar [data-run]')].find(b=>b.dataset.run==='accpublisher:acc-run').click()`);
        await waitUntil(async () => (await page.eval("document.body.dataset.view")) === "run", 5_000, "acc run view");
      }
      if (phase === "renderer") {
        // Adapter/renderer limit, separately from the parent: the real served viewer rendering 600 agents / 1797 relations.
        const viewer = await openPage(cdp, `${base}/semantic-map.html?v=${SEMANTIC_MAP_BUILD_STAMP}&embed=1`);
        await waitUntil(() => viewer.eval("Boolean(window.SemanticMap && window.__accProbe)"), 10_000, "standalone viewer");
        // Size sweep: each size renders once fresh (new scope) and then three in-place updates. The largest input is CPU-profiled.
        const sweep = async (agentsCount, relationsPerAgent) => viewer.eval(String.raw`(async()=>{
          const frame=()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));
          const n=${String(agentsCount)},per=${String(relationsPerAgent)};
          const make=(offset)=>{const agents=Array.from({length:n},(_,i)=>({id:'a'+i,name:'Agent '+i,state:(i+offset)%7===0?'completed':'running',attempts:1,output:{status:'pending'}}));const relations=[];for(let i=0;i<n;i++)for(let d=1;d<=per;d++)if(i+d<n)relations.push({kind:d===2?'fork':'dependency',fromAgentId:agents[i].id,toAgentId:agents[i+d].id,evidence:'recorded'});return {scope:{publisherId:'p',targetKind:'run',targetId:'t'+n},run:{id:'t'+n,workflowName:'Renderer limit',state:'running',agents},relations};};
          const out=[];
          for(let k=0;k<4;k++){const s=make(k);const t=performance.now();const g=window.SemanticMap.render(s);const r=performance.now();await frame();out.push({agents:n,relationsIn:s.relations.length,kind:k===0?'initial':'update',renderMs:r-t,visibleMs:performance.now()-t,nodes:g.nodes.length,edges:g.edges.length,domNodes:document.querySelectorAll('.semantic-map-node').length,domEdges:document.querySelectorAll('.semantic-map-edge').length,partial:g.completeness.partial,reasons:g.completeness.reasons,payloadBytes:new TextEncoder().encode(JSON.stringify(g)).byteLength});}
          return out;})()`);
        const samples = [];
        for (const [count, per] of [[20, 3], [60, 3], [120, 3], [200, 3], [240, 6], [300, 3]]) samples.push(...await sweep(count, per));
        await cdp.send("Profiler.enable", {}, viewer.sessionId);
        await cdp.send("Profiler.start", {}, viewer.sessionId);
        samples.push(...await sweep(600, 3));
        const { profile } = await cdp.send("Profiler.stop", {}, viewer.sessionId);
        const selfTime = {};
        const byId = new Map(profile.nodes.map((node) => [node.id, node]));
        const intervals = profile.timeDeltas ?? [];
        profile.samples.forEach((id, index) => { const node = byId.get(id); const name = `${node.callFrame.functionName || "(anonymous)"}@${String(node.callFrame.url).split("/").pop().split("?")[0]}:${String(node.callFrame.lineNumber)}:${String(node.callFrame.columnNumber)}`; selfTime[name] = (selfTime[name] ?? 0) + (intervals[index] ?? 0) / 1000; });
        const hot = Object.entries(selfTime).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, ms]) => ({ name, ms: round(ms) }));
        await viewer.close();
        results.renderer = { samples: samples.map((item) => ({ ...item, renderMs: round(item.renderMs), visibleMs: round(item.visibleMs) })), profileLargestHotSelfTime: hot };
        write("renderer.json", results.renderer);
        const largest = samples.filter((item) => item.agents === 600);
        const reachedNodes = Math.max(...samples.map((item) => item.nodes));
        const reachedEdges = Math.max(...samples.map((item) => item.edges));
        criterion("renderer", "adapter/renderer never exceed 500 nodes / 1500 edges / 512 KiB, DOM equals the graph, and truncation is explicit", samples.every((item) => item.nodes <= 500 && item.edges <= 1500 && item.payloadBytes <= 512 * 1024 && item.domNodes === item.nodes && item.domEdges === item.edges && (item.agents * 2 + 1 <= 500 || item.partial)), { reachedNodes, reachedEdges, largest: largest.map(({ nodes, edges, payloadBytes, reasons }) => ({ nodes, edges, payloadBytes, reasons })).at(0) });
        criterion("renderer", "largest-input render (600 agents / 1797 relations, truncated) stays within 1000 ms per render", largest.every((item) => item.visibleMs <= 1000), { visibleMs: largest.map((item) => round(item.visibleMs)), hot: hot.slice(0, 5) });
      }
      if (phase === "heap") {
        // Symmetric control without the map first; its noise fixes the tolerance before any candidate sample exists.
        const heapRun = async (label, withMap) => {
          const target = await newPage(false);
          const gc = async (session) => { await cdp.send("HeapProfiler.collectGarbage", {}, session); await cdp.send("HeapProfiler.collectGarbage", {}, session); };
          await cdp.send("HeapProfiler.enable", {}, target.sessionId);
          await cdp.send("Memory.getDOMCounters", {}, target.sessionId).catch(() => undefined);
          const samples = [];
          const iframe = [];
          const sample = async (cycle) => {
            await gc(target.sessionId);
            const heap = await cdp.send("Runtime.getHeapUsage", {}, target.sessionId);
            const dom = await cdp.send("Memory.getDOMCounters", {}, target.sessionId).catch(() => ({}));
            // Harness records are bounded the same way in control and candidate: counted, then cleared. Resource Timing is not read
            // here (reading it creates wrappers that live as long as the browser's entries); it is counted once after the last sample.
            const extra = await target.eval("(()=>{const p=window.__accProbe,r={probeWs:p.ws.length,probeSends:p.sends.length,probeAcks:p.acks.length,summary:p.summary()};p.ws.length=0;p.sends.length=0;p.acks.length=0;p.readies.length=0;p.childRequests.length=0;return r})()");
            samples.push({ cycle, usedSize: heap.usedSize, totalSize: heap.totalSize, documents: dom.documents, domNodes: dom.nodes, listeners: dom.jsEventListeners, ...extra });
          };
          const warm = options.heapWarmups;
          const total = warm + options.heapCycles;
          for (let index = 1; index <= total; index += 1) {
            publishTick(tick + 1);
            if (withMap) {
              await openMap(target);
              if (index > warm && (index - warm) % 10 === 0) {
                const frameSession = target.frameSession();
                if (frameSession) { await gc(frameSession); const heap = await cdp.send("Runtime.getHeapUsage", {}, frameSession); iframe.push({ cycle: index - warm, usedSize: heap.usedSize, totalSize: heap.totalSize }); }
              }
              await delay(150);
              await closeMap(target);
            } else {
              await target.eval(PARENT.close);
              await delay(300);
              await target.eval(PARENT.close);
            }
            await delay(100);
            if (index === warm || index > warm && (index - warm) % 10 === 0) await sample(index - warm);
          }
          await delay(500);
          const snapshot = await heapSnapshotCounts(cdp, target.sessionId);
          const resourceEntries = await target.eval("performance.getEntriesByType('resource').length");
          await target.close();
          const used = samples.map((item) => item.usedSize);
          const deltas = used.slice(1).map((value, index) => value - used[index]);
          return { label, withMap, samples, iframe, resourceEntries, growth: used.at(-1) - used[0], spread: Math.max(...used) - Math.min(...used), deltas, snapshot };
        };
        const controls = [await heapRun("control-1", false), await heapRun("control-2", false)];
        const noise = Math.max(...controls.map((control) => control.spread), ...controls.map((control) => Math.abs(control.growth)));
        const tolerance = { heapWarmups: options.heapWarmups, measuredCycles: options.heapCycles, rule: "tolerance = 1.5 x max(spread, |growth|) over two identical no-map control runs after the same warm-up; fixed and written before the candidate run; never widened afterwards", retainedRule: "after the last close: 0 detached iframes, 0 root-reachable HTMLIFrameElement instances and root-reachable MessagePort instances <= the no-map control (per-realm interface objects held by V8PerContextData wrapper-type tables are not instances), documents back to the baseline sample", controlSpreads: controls.map((control) => control.spread), controlGrowths: controls.map((control) => control.growth), tolerance: Math.ceil(1.5 * noise), fixedAt: new Date().toISOString() };
        write("heap-control.json", controls);
        write("heap-tolerance.json", tolerance);
        out(`heap tolerance fixed at ${String(tolerance.tolerance)} B from controls`);
        const candidate = await heapRun("candidate", true);
        write("heap-candidate.json", candidate);
        const controlGrowth = [...controls.map((control) => control.growth)].sort((a, b) => a - b)[0];
        const persistentTrend = candidate.deltas.length > 0 && candidate.deltas.every((delta) => delta > 0) && candidate.growth > tolerance.tolerance;
        const excess = candidate.growth - controlGrowth;
        const docsBack = candidate.samples.at(-1).documents === candidate.samples[0].documents;
        const retained = candidate.snapshot.counts;
        const controlRetained = controls[1].snapshot.counts;
        const diagnosis = Object.entries(candidate.snapshot.byName).map(([name, count]) => ({ name, delta: count - (controls[1].snapshot.byName[name] ?? 0) })).filter((item) => item.delta !== 0).sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta)).slice(0, 25);
        results.heap = { tolerance, controlGrowths: tolerance.controlGrowths, candidateGrowth: candidate.growth, excessOverControl: excess, persistentTrend, candidateDeltas: candidate.deltas, iframe: candidate.iframe, documents: candidate.samples.map((item) => item.documents), retained, controlRetained, resourceEntries: candidate.resourceEntries, controlResourceEntries: controls[1].resourceEntries, diagnosisTopNameDeltas: diagnosis, selfSizeByTypeDelta: Object.fromEntries(Object.keys({ ...candidate.snapshot.typeSizes, ...controls[1].snapshot.typeSizes }).map((type) => [type, (candidate.snapshot.typeSizes[type] ?? 0) - (controls[1].snapshot.typeSizes[type] ?? 0)])), heapWarmups: options.heapWarmups, heapProtocol: options.heapWarmups === ORIGINAL_HEAP_WARMUPS ? "original" : "diagnostic deviation: does not close the original G5 heap criterion" };
        write("heap-summary.json", results.heap);
        criterion("heap", "parent heap: candidate growth minus control growth within the pre-fixed control tolerance and no persistent rising trend", excess <= tolerance.tolerance && !persistentTrend, { tolerance: tolerance.tolerance, controlGrowths: tolerance.controlGrowths, candidateGrowth: candidate.growth, excess, deltas: candidate.deltas, heapWarmups: options.heapWarmups, heapProtocol: results.heap.heapProtocol });
        const reachable = (snapshot, pattern) => snapshot.instances.filter((item) => pattern.test(item.name) && !item.interfaceObject && !item.retainingPath.startsWith("unreachable")).length;
        const retainedEvidence = { documents: results.heap.documents, reachableIframes: reachable(candidate.snapshot, /HTMLIFrameElement|<iframe>/), reachablePorts: reachable(candidate.snapshot, /^MessagePort/), controlReachablePorts: reachable(controls[1].snapshot, /^MessagePort/), retained, controlRetained, instances: candidate.snapshot.instances, controlInstances: controls[1].snapshot.instances };
        criterion("heap", "no retained viewer after close: documents back to baseline, no detached or reachable iframe, MessagePorts not above the no-map control", docsBack && retained.detachedIframes === 0 && retainedEvidence.reachableIframes === 0 && retainedEvidence.reachablePorts <= retainedEvidence.controlReachablePorts, retainedEvidence);
        const iframeUsed = candidate.iframe.map((item) => item.usedSize);
        const iframeTrend = iframeUsed.length >= 3 && iframeUsed.slice(1).every((value, index) => value > iframeUsed[index]) && iframeUsed.at(-1) - iframeUsed[0] > tolerance.tolerance;
        criterion("heap", "iframe heap samples of successive fresh viewers show no rising trend", iframeUsed.length >= 3 && !iframeTrend, { iframe: candidate.iframe });
      }
      if (phase === "ordinary") {
        await openMap(page);
        // Start after the 250 ms send floor of the opening snapshot has elapsed: this phase measures the ordinary cadence.
        await delay(1_000);
        const channels = (await page.eval(PARENT.summary)).channels;
        const requestStart = requests.length;
        const first = tick + 1;
        const started = performance.now();
        const total = options.ordinarySeconds;
        for (let index = 0; index < total; index += 1) {
          publishTick(tick + 1);
          if (index % 60 === 59) out(`ordinary: ${String(index + 1)}/${String(total)} s`);
          const wait = started + (index + 1) * 1000 - performance.now();
          if (wait > 0) await delay(wait);
        }
        const last = tick;
        await waitVisibleTick(page, last, 5_000);
        await delay(1_000);
        const ws = (await slice(page, "ws", 0)).filter((item) => item.tick >= first);
        const sends = (await slice(page, "sends", 0)).filter((item) => item.tick >= first);
        const acks = await slice(page, "acks", 0);
        const child = await childRenders(page);
        const origin = await page.eval("window.__accProbe.origin");
        const summary = await page.eval(PARENT.summary);
        const samples = [];
        const missing = [];
        for (let value = first; value <= last; value += 1) {
          const accepted = ws.find((item) => item.tick === value);
          const send = sends.find((item) => item.tick === value);
          const ack = send ? acks.find((item) => item.seq === send.seq) : undefined;
          const render = child.renders.find((item) => item.tick === value && item.paint > 0);
          if (!accepted || !send || !ack || !render) { missing.push({ tick: value, accepted: Boolean(accepted), sent: Boolean(send), acked: Boolean(ack), rendered: Boolean(render) }); continue; }
          const latency = visibleLatency(origin, accepted.t, ack.t, child.origin, render);
          samples.push({ tick: value, kind: tickKind(value), atS: round((accepted.t - ws[0].t) / 1000), acceptedToSendMs: round(send.t - accepted.t), sendToAckMs: round(ack.t - send.t), renderMs: round(render.end - render.start), renderToPaintMs: round(render.paint - render.end), sameClockMs: round(latency.sameClock), crossClockMs: round(latency.crossClock), visibleMs: round(latency.value), nodes: render.nodes });
        }
        const elapsedS = round((performance.now() - started) / 1000);
        const all = stats(samples.map((item) => item.visibleMs));
        const byKind = Object.fromEntries(["label", "status", "insert", "remove"].map((kind) => [kind, roundStats(stats(samples.filter((item) => item.kind === kind).map((item) => item.visibleMs)))]));
        results.ordinary = { elapsedS, published: last - first + 1, samples: samples.length, missing: missing.length, visible: roundStats(all), sameClock: roundStats(stats(samples.map((item) => item.sameClockMs))), crossClock: roundStats(stats(samples.map((item) => item.crossClockMs))), acceptedToSend: roundStats(stats(samples.map((item) => item.acceptedToSendMs))), byKind, reopened: summary.channels - channels, assetRequests: requests.length - requestStart, leaks: sends.filter((send) => send.leak).length };
        write("ordinary.json", { summary: results.ordinary, missing, samples });
        criterion("ordinary", `${String(total)} real seconds at ~1 Hz: parent accepted -> visible p95 <= 100 ms (projection + bridge + render + paint)`, elapsedS >= total && missing.length === 0 && samples.length === total && all.p95 <= 100, { elapsedS, samples: samples.length, missing: missing.length, p95: round(all.p95), p50: round(all.p50), max: round(all.max) });
        criterion("ordinary", "inserts and removals measured separately and visible within the same budget; one viewer instance, no asset request", byKind.insert.n > 0 && byKind.remove.n > 0 && byKind.insert.p95 <= 100 && byKind.remove.p95 <= 100 && results.ordinary.reopened === 0 && results.ordinary.assetRequests === 0 && results.ordinary.leaks === 0, { byKind, reopened: results.ordinary.reopened, assetRequests: results.ordinary.assetRequests });
        await closeMap(page);
      }
      out(`--- phase ${phase} done in ${String(round((performance.now() - phaseStart) / 1000))} s`);
    }
  } catch (error) {
    criterion("harness", "acceptance harness completed without error", false, error instanceof Error ? error.stack ?? error.message : String(error));
  } finally {
    await page?.close().catch(() => undefined);
    browser.cdp.close();
    const chromeStop = await browser.stop();
    publisher.close();
    server.closeAllConnections(); server.close();
    await delay(200);
    let stateRemoved = false;
    for (let attempt = 0; attempt < 20 && !stateRemoved; attempt += 1) { try { rmSync(stateDir, { recursive: true, force: true }); stateRemoved = !existsSync(stateDir); } catch { await delay(100); } }
    results.cleanup = { chrome: chromeStop, stateDirRemoved: stateRemoved, serverPort: port };
  }
  results.criteria = criteria;
  results.finishedAt = new Date().toISOString();
  const passed = criteria.length > 0 && criteria.every((item) => item.pass);
  results.status = passed ? "passed" : "failed";
  write("summary.json", results);
  const lines = [`# Semantic Map browser acceptance ${passed ? "PASSED" : "FAILED"}`, "", `- Candidate: \`${identity.id}\` (HEAD ${identity.head}, ${String(identity.dirtyEntries)} dirty/untracked entries)`, `- Build stamp: ${SEMANTIC_MAP_BUILD_STAMP}; Node ${process.version}; ${platform()} ${release()} ${arch()}; Chrome ${chrome} (headless, temporary profile)`, `- Phases: ${options.phases.join(", ")}`, "", "| Phase | Criterion | Result |", "| --- | --- | --- |", ...criteria.map((item) => `| ${item.phase} | ${item.name} | ${item.pass ? "pass" : "**FAIL**"} |`), "", `Cleanup: Chrome exited=${String(results.cleanup.chrome.exited)}, profile removed=${String(results.cleanup.chrome.profileRemoved)}, state dir removed=${String(results.cleanup.stateDirRemoved)}.`];
  writeFileSync(join(outDir, "summary.md"), `${lines.join("\n")}\n`);
  out(`RESULT ${results.status} (${String(criteria.filter((item) => item.pass).length)}/${String(criteria.length)} criteria) -> ${outDir}`);
  process.exitCode = passed ? 0 : 1;
}

/** Name families whose count differed between the no-map control and the candidate in development runs; sampled for retaining paths. */
const DIAGNOSTIC_NAMES = new Set(["system / WeakArrayList", "system / FunctionTemplateInfo", "system / AccessorPair", "PerformanceResourceTiming"]);
/**
 * Streams a heap snapshot; counts DOM iframe / MessagePort *instances* (interface prototypes and V8 internal caches are
 * per-realm singletons, not viewer state) and gives the shortest strong retaining path from the root for each instance.
 */
async function heapSnapshotCounts(cdp, sessionId) {
  const chunks = [];
  const dispose = cdp.on("HeapProfiler.addHeapSnapshotChunk", (params, session) => { if (session === sessionId) chunks.push(params.chunk); });
  try { await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false, captureNumericValue: false }, sessionId); } finally { dispose(); }
  const snapshot = JSON.parse(chunks.join(""));
  chunks.length = 0;
  const meta = snapshot.snapshot.meta;
  const fields = meta.node_fields;
  const width = fields.length;
  const nameIndex = fields.indexOf("name");
  const typeIndex = fields.indexOf("type");
  const edgeCountIndex = fields.indexOf("edge_count");
  const sizeIndex = fields.indexOf("self_size");
  const detachedIndex = fields.indexOf("detachedness");
  const types = meta.node_types[0];
  const edgeFields = meta.edge_fields;
  const edgeWidth = edgeFields.length;
  const edgeTypes = meta.edge_types[0];
  const nodeCount = snapshot.nodes.length / width;
  const firstEdge = new Uint32Array(nodeCount + 1);
  for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) firstEdge[ordinal + 1] = firstEdge[ordinal] + snapshot.nodes[ordinal * width + edgeCountIndex] * edgeWidth;
  const nameOf = (ordinal) => { const name = snapshot.strings[snapshot.nodes[ordinal * width + nameIndex]]; return name.length > 80 ? name.slice(0, 80) : name; };
  const typeOf = (ordinal) => types[snapshot.nodes[ordinal * width + typeIndex]];
  const byName = {};
  const counts = { iframeInstances: 0, detachedIframes: 0, messagePortInstances: 0, messageChannelInstances: 0, detachedNodes: 0, interfaceObjects: 0 };
  const instances = [];
  const diagnosticSeen = {};
  const diagnostics = [];
  const typeSizes = {};
  for (let ordinal = 0; ordinal < nodeCount; ordinal += 1) {
    const type = typeOf(ordinal);
    typeSizes[type] = (typeSizes[type] ?? 0) + snapshot.nodes[ordinal * width + sizeIndex];
    if (type !== "object" && type !== "native") continue;
    const name = nameOf(ordinal);
    const detached = detachedIndex >= 0 && snapshot.nodes[ordinal * width + detachedIndex] === 2;
    byName[name] = (byName[name] ?? 0) + 1;
    if (detached) counts.detachedNodes += 1;
    if (DIAGNOSTIC_NAMES.has(name) && (diagnosticSeen[name] = (diagnosticSeen[name] ?? 0) + 1) % 16 === 0 && diagnostics.length < 40) diagnostics.push({ ordinal, type, name, detached, selfSize: snapshot.nodes[ordinal * width + sizeIndex], diagnostic: true });
    if (!/HTMLIFrameElement|<iframe>|^MessagePort|^MessageChannel/.test(name)) continue;
    if (/\((prototype|internal cache)\)/.test(name)) { counts.interfaceObjects += 1; continue; }
    if (/HTMLIFrameElement|<iframe>/.test(name)) { counts.iframeInstances += 1; if (detached || name.startsWith("Detached")) counts.detachedIframes += 1; }
    else if (name.startsWith("MessagePort")) counts.messagePortInstances += 1;
    else counts.messageChannelInstances += 1;
    if (instances.length < 20) instances.push({ ordinal, type, name, detached, selfSize: snapshot.nodes[ordinal * width + sizeIndex] });
  }
  // Shortest strong path from the synthetic root (ordinal 0) to each instance.
  const targets = new Set([...instances, ...diagnostics].map((item) => item.ordinal));
  const parent = new Int32Array(nodeCount).fill(-1);
  const via = new Int32Array(nodeCount).fill(-1);
  parent[0] = 0;
  const queue = [0];
  for (let head = 0; head < queue.length && targets.size; head += 1) {
    const current = queue[head];
    for (let edge = firstEdge[current]; edge < firstEdge[current + 1]; edge += edgeWidth) {
      if (edgeTypes[snapshot.edges[edge]] === "weak") continue;
      const next = snapshot.edges[edge + 2] / width;
      if (parent[next] !== -1) continue;
      parent[next] = current; via[next] = edge; queue.push(next);
      targets.delete(next);
    }
  }
  const edgeName = (edge) => { const type = edgeTypes[snapshot.edges[edge]]; const value = snapshot.edges[edge + 1]; return type === "element" || type === "hidden" ? `[${String(value)}]` : String(snapshot.strings[value]).slice(0, 60); };
  for (const item of [...instances, ...diagnostics]) {
    const path = [];
    for (let ordinal = item.ordinal; ordinal !== 0 && parent[ordinal] !== -1 && path.length < 16; ordinal = parent[ordinal]) path.unshift(`${edgeName(via[ordinal])} -> ${nameOf(ordinal)} (${typeOf(ordinal)})`);
    item.retainingPath = parent[item.ordinal] === -1 ? "unreachable from root (garbage awaiting collection)" : path.join(" / ");
    // Blink's per-context wrapper-type table holds one interface object per DOM type once a realm uses it: not an element or port.
    item.interfaceObject = /V8PerContextData/.test(item.retainingPath) && /WrapperTypeInfo/.test(item.retainingPath);
    delete item.ordinal;
  }
  const top = Object.fromEntries(Object.entries(byName).filter(([, count]) => count >= 5).sort((a, b) => b[1] - a[1]).slice(0, 400));
  return { counts, typeSizes, instances, diagnostics, byName: top, totalNodes: nodeCount };
}

// Importing the module (scripts/workspace-tools.test.mjs) must not start Chrome.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
