import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportTrajectoryRunHtml } from "../index.js";
import { createTrajectoryServer } from "../src/server.js";
import { SEMANTIC_MAP_BUILD_STAMP } from "../src/semantic-map-assets.js";
import { RunStore } from "../../src/persistence.js";
import { createLaunchSnapshot } from "../../src/utils.js";
import type { PersistedRun } from "../../src/persistence.js";

type CdpRecord = Record<string, unknown>;
type CdpMessage = CdpRecord & { id?: number; method?: string };
type RouteBody = string | Buffer;

function textValue(value: unknown, fallback: string): string { return typeof value === "string" ? value : fallback; }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function waitFor(page: Devtools, expression: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await page.evaluate(expression)) return;
    await delay(25);
  }
  throw new Error(`Chrome condition did not become true: ${expression}`);
}
function findBrowser(): string | undefined {
  const configured = process.env.PI_TRAJECTORY_CHROME;
  if (configured && existsSync(configured)) return configured;
  const candidates = [configured, "/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"];
  try {
    for (const version of readdirSync(join(homedir(), ".cache", "ms-playwright"))) candidates.push(join(homedir(), ".cache", "ms-playwright", version, "chrome-linux64", "chrome"));
  } catch { /* The browser cache is optional. */ }
  for (const name of ["chromium", "google-chrome", "chromium-browser"]) {
    try { candidates.push(execFileSync("which", [name], { encoding: "utf8" }).trim()); } catch { /* Try the next browser location. */ }
  }
  const found = candidates.find((candidate) => typeof candidate === "string" && Boolean(candidate) && existsSync(candidate));
  return typeof found === "string" ? found : undefined;
}

class Devtools {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (message: CdpMessage) => void; reject: (error: Error) => void }>();
  private readonly eventListeners = new Map<string, Set<(params: CdpRecord) => void>>();
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      let message: CdpMessage;
      try { message = JSON.parse(String(event.data)) as CdpMessage; } catch { return; }
      if (typeof message.method === "string") {
        const params = message.params && typeof message.params === "object" ? message.params as CdpRecord : {};
        const eventParams = typeof message.sessionId === "string" ? { ...params, __cdpSessionId: message.sessionId } : params;
        for (const listener of this.eventListeners.get(message.method) || []) listener(eventParams);
      }
      if (typeof message.id !== "number") return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      request.resolve(message);
    });
  }
  on(method: string, listener: (params: CdpRecord) => void): void {
    const listeners = this.eventListeners.get(method) || new Set<(params: CdpRecord) => void>();
    listeners.add(listener);
    this.eventListeners.set(method, listeners);
  }
  command(method: string, params: CdpRecord = {}, sessionId?: string): Promise<CdpMessage> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); });
  }
  async evaluate(expression: string): Promise<unknown> {
    const message = await this.command("Runtime.evaluate", { expression, returnByValue: true });
    if (message.error) throw new Error(textValue((message.error as CdpRecord).message, "Chrome evaluation failed"));
    const result = message.result as CdpRecord | undefined;
    const exception = result?.exceptionDetails as CdpRecord | undefined;
    if (exception) throw new Error(textValue(exception.description, textValue(exception.text, "Chrome evaluation failed")));
    return (result?.result as CdpRecord | undefined)?.value;
  }
  async evaluateInContext(contextId: number, expression: string, sessionId?: string): Promise<unknown> {
    const message = await this.command("Runtime.evaluate", { expression, contextId, returnByValue: true }, sessionId);
    if (message.error) throw new Error(textValue((message.error as CdpRecord).message, "Chrome frame evaluation failed"));
    const result = message.result as CdpRecord | undefined;
    const exception = result?.exceptionDetails as CdpRecord | undefined;
    if (exception) throw new Error(textValue(exception.description, textValue(exception.text, "Chrome frame evaluation failed")));
    return (result?.result as CdpRecord | undefined)?.value;
  }
  close(): void {
    for (const request of this.pending.values()) request.reject(new Error("Chrome DevTools connection closed"));
    this.pending.clear();
    this.socket.close();
  }
}

async function connectDevtools(url: string): Promise<Devtools> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => { resolve(); });
    socket.addEventListener("error", () => { reject(new Error("Chrome DevTools connection failed")); });
  });
  return new Devtools(socket);
}

async function waitForDevtools(port: number, child: ReturnType<typeof spawn>, stderr: () => string): Promise<string> {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Chrome exited before DevTools started (code ${String(child.exitCode)}, signal ${String(child.signalCode)}${stderr() ? `): ${stderr().trim()}` : ")"}`);
    try {
      const response = await fetch(`http://127.0.0.1:${String(port)}/json`);
      const pages = await response.json() as Array<{ type?: unknown; webSocketDebuggerUrl?: unknown }>;
      const page = pages.find((candidate) => candidate.type === "page" && typeof candidate.webSocketDebuggerUrl === "string");
      const websocketUrl = page?.webSocketDebuggerUrl;
      if (typeof websocketUrl === "string") return websocketUrl;
    } catch { /* Chrome is still starting. */ }
    await delay(50);
  }
  throw new Error(`Chrome DevTools did not start${stderr() ? `: ${stderr().trim()}` : ""}`);
}

async function serve(routes: ReadonlyMap<string, RouteBody>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const body = routes.get(path);
    if (body === undefined) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : path.endsWith(".css") ? "text/css" : "text/html" });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${String(address.port)}`, close: () => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); }) };
}

async function withChrome(url: string, callback: (page: Devtools, browser: Devtools) => Promise<void>): Promise<void> {
  const browserExecutable = findBrowser();
  assert.ok(browserExecutable, "Chromium is required for Trajectory browser verification");
  const portServer = createServer();
  await new Promise<void>((resolve, reject) => { portServer.once("error", reject); portServer.listen(0, "127.0.0.1", resolve); });
  const address = portServer.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve, reject) => { portServer.close((error) => { if (error) reject(error); else resolve(); }); });
  const profile = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-chrome-"));
  const child = spawn(browserExecutable, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${String(port)}`, `--user-data-dir=${profile}`, url], { stdio: ["ignore", "ignore", "pipe"] });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr.push(chunk); });
  const childExited = new Promise<void>((resolve) => { child.once("close", () => { resolve(); }); });
  let page: Devtools | undefined;
  let browser: Devtools | undefined;
  try {
    page = await connectDevtools(await waitForDevtools(port, child, () => stderr.join("")));
    const versionResponse = await fetch(`http://127.0.0.1:${String(port)}/json/version`);
    const versionInfo = await versionResponse.json() as { webSocketDebuggerUrl?: unknown };
    assert.equal(typeof versionInfo.webSocketDebuggerUrl, "string", "Chrome exposes a browser-level DevTools endpoint");
    browser = await connectDevtools(String(versionInfo.webSocketDebuggerUrl));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await page.evaluate("document.readyState === 'complete'")) break;
      await delay(25);
    }
    await callback(page, browser);
  } finally {
    page?.close(); browser?.close();
    child.kill("SIGTERM");
    await Promise.race([childExited, delay(2000)]);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { rmSync(profile, { recursive: true, force: true }); break; } catch { await delay(50); }
    }
  }
}

function makeState(output: Record<string, unknown>, state: "running" | "completed"): Record<string, unknown> {
  const agent = { id: "agent", name: "fixture-agent", label: "fixture-agent", state, attempts: 1, startedAt: 1, durationMs: state === "completed" ? 10 : undefined, model: { provider: "fixture", model: "model" }, requestedModel: "fixture/request", role: "reviewer", tools: ["read"], skills: ["review"], extensions: ["fixture"], prompt: "Inspect the fixture", systemPrompt: "System prompt", output, attemptDetails: [{ attempt: 1, transport: "local", setup: { cwd: "/project", model: { provider: "fixture", model: "model" }, tools: ["read"] } }] };
  const run = { id: "run", workflowName: "fixture", cwd: "/project", sessionId: "session", state, agents: [agent], transcripts: { agent: [{ type: "message", timestamp: "2025-01-01T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "transcript" }] } }] }, snapshot: { script: "return true;" } };
  return { type: "state", publishers: [{ id: "publisher", title: "fixture", cwd: "/project", sessionId: "session", connected: true, runs: [{ run }], subagents: [] }], updatedAt: 1 };
}

function clickExpression(selector: string): string { return `document.querySelector(${JSON.stringify(selector)}).click()`; }
function outputTabClickExpression(): string { return "Array.from(document.querySelectorAll('#sys-tabs span')).find((tab) => tab.dataset.pane === 'output').click()"; }

const browserPath = findBrowser();
void test("Trajectory static export opens Agent details and its Output tab in Chromium", { skip: !browserPath, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-browser-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const sessionFile = join(root, "session.jsonl");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "transcript" }] } })}\n`);
  const store = new RunStore(cwd, "session", "run", home);
  const model = { provider: "fixture", model: "model" };
  const run = { id: "run", workflowName: "fixture", cwd, sessionId: "session", state: "completed", agentSessions: [], agents: [{ id: "agent", name: "fixture-agent", path: "agent", state: "completed", resultPath: "agent/call:1", attempts: 1, model, requestedModel: "fixture/request", role: "reviewer", tools: ["read"], attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: "native", locator: { sessionFile } }, setup: { cwd, hookNames: [], model, tools: ["read"] }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }] } as unknown as PersistedRun;
  try {
    await store.create(run, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "fixture" }, settings: { concurrency: 1 }, models: ["fixture/model"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
    await store.complete("agent/call:1", { answer: false });
    const html = await exportTrajectoryRunHtml({ cwd, sessionId: "session", runId: "run", home });
    const server = await serve(new Map([["/report.html", html]]));
    try {
      await withChrome(`${server.url}/report.html`, async (page) => {
        await waitFor(page, "Boolean(document.querySelector('.agent-grid-row'))");
        await page.evaluate(clickExpression(".agent-grid-row"));
        assert.equal(await page.evaluate("Boolean(document.querySelector('[data-agent-details]'))"), true);
        await page.evaluate(clickExpression("[data-agent-details]"));
        assert.match(String(await page.evaluate("document.getElementById('sys-tabs').textContent")), /PromptToolsSkillsExtensionsEnvironmentOutput/);
        await page.evaluate(outputTabClickExpression());
        assert.match(String(await page.evaluate("document.getElementById('sys-pane').textContent")), /answer.*false/);
      });
    } finally { await server.close(); }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void test("Trajectory Chromium view preserves the selected Output tab across live publisher updates", { skip: !browserPath, timeout: 120_000 }, async () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const marked = readFileSync(new URL("../src/assets/marked.min.js", import.meta.url));
  const morphdom = readFileSync(new URL("../src/assets/morphdom.min.js", import.meta.url));
  const bootstrap = `<script>(function(){class FakeSocket{constructor(){this.readyState=1;this.listeners={};window.__trajectorySocket=this;}addEventListener(type,listener){(this.listeners[type] ||= []).push(listener);}send(){}close(){}emit(type,data){for(const listener of this.listeners[type] || []) listener({data});}}window.WebSocket=FakeSocket;})();</script>`;
  const html = source.replace("  <script>\n    const defaultRunLayout", `  ${bootstrap}\n  <script>\n    const defaultRunLayout`);
  assert.notEqual(html, source);
  const server = await serve(new Map<string, RouteBody>([["/index.html", html], ["/marked.min.js", marked], ["/morphdom.min.js", morphdom]]));
  try {
    await withChrome(`${server.url}/index.html`, async (page) => {
      await waitFor(page, "Boolean(window.__trajectorySocket)");
      const pending = JSON.stringify(makeState({ status: "pending" }, "running"));
      await page.evaluate(`window.__trajectorySocket.emit('message', ${JSON.stringify(pending)})`);
      await waitFor(page, "Boolean(document.querySelector('.agent-grid-row'))");
      await page.evaluate(clickExpression(".agent-grid-row"));
      await page.evaluate(clickExpression("[data-agent-details]"));
      await page.evaluate(outputTabClickExpression());
      assert.match(String(await page.evaluate("document.getElementById('sys-pane').textContent")), /not yet available/);
      const available = JSON.stringify(makeState({ status: "available", value: { answer: "done" }, bytes: 18 }, "completed"));
      await page.evaluate(`window.__trajectorySocket.emit('message', ${JSON.stringify(available)})`);
      await waitFor(page, "document.getElementById('sys-pane').textContent.includes('done')");
      assert.equal(await page.evaluate("document.querySelector('#sys-tabs [data-pane=output]').classList.contains('on')"), true);
      assert.match(String(await page.evaluate("document.getElementById('sys-pane').textContent")), /answer.*done/);
    });
  } finally { await server.close(); }
});

function toolTiming(id: string, startedAt: number, durationMs: number, isError = false): Record<string, unknown> {
  return { type: "custom", customType: "pi-workflows:tool-timing", data: { toolCallId: id, toolName: "read", startedAt, completedAt: startedAt + durationMs, durationMs, isError } };
}

void test("Trajectory live gantt keeps cached timing, merges dense calls, and pauses while hidden", { skip: !browserPath, timeout: 120_000 }, async () => {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => { probe.close(() => { resolve(); }); });
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-live-"));
  const server = createTrajectoryServer(port, join(root, "lock.json"));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const start = Date.now() - 600_000;
  // Sparse calls stay separate bars; the dense burst collapses into one; the failure must survive merging.
  const baseline = [...Array.from({ length: 20 }, (_, index) => toolTiming(`sparse-${String(index)}`, start + index * 20_000, 3_000, index === 7)), ...Array.from({ length: 50 }, (_, index) => toolTiming(`burst-${String(index)}`, start + 500_000 + index * 20, 15))];
  let tick = 0;
  const agent = (id: string, running: boolean) => ({ id, name: id, label: id, path: id, state: running ? "running" : "completed", attempts: 1, startedAt: start, durationMs: running ? undefined : 550_000, lastEventAt: Date.now(), model: { provider: "fixture", model: "model" }, tools: ["read"] });
  const publisherId = "livepublisher1";
  const publisher = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  await new Promise((resolve) => { publisher.addEventListener("open", resolve, { once: true }); });
  publisher.send(JSON.stringify({ type: "publisher:attach", publisherId }));
  const publish = () => {
    // Only the running agent gains calls, so the done agent's timing is omitted after its first delivery.
    const live = Array.from({ length: tick }, (_, index) => toolTiming(`live-${String(index)}`, start + 560_000 + index * 15_000, 4_000));
    const run = { id: "live", workflowName: "live-workflow", cwd: "/project", sessionId: "session", state: "running", agents: [agent("done", false), agent("busy", true)], agentSessions: [], events: [] };
    publisher.send(JSON.stringify({ type: "publisher:state", publisher: { id: publisherId, title: "live", cwd: "/project", sessionId: "session", connected: true }, runs: [{ run, snapshot: { script: "return true;" }, transcripts: { done: { revision: 1, status: "available", timing: baseline }, busy: { revision: 100 + tick, status: "available", timing: [...baseline, ...live] } } }], subagents: [] }));
    tick += 1;
  };
  publish();
  const timer = setInterval(publish, 250);
  const bars = (lane: string, selector = ".bar.tool") => `document.querySelectorAll('#swim-content .lane[data-agent="${lane}"] ${selector}').length`;
  try {
    await withChrome(`http://127.0.0.1:${String(port)}/?view=run&run=${publisherId}:live`, async (page) => {
      await waitFor(page, `${bars("done")} > 0 && ${bars("busy")} > 0`);
      const done = Number(await page.evaluate(bars("done")));
      assert.ok(done > 1 && done < baseline.length, `dense calls merge into fewer bars, got ${String(done)}`);
      assert.ok(Number(await page.evaluate(bars("done", ".bar.tool.fail"))) > 0, "failed call keeps its styling after merging");
      assert.equal(Number(await page.evaluate("document.querySelectorAll('#swim-content .bar.tool[title*=\"tool calls\"]').length")) > 0, true);
      const busy = Number(await page.evaluate(bars("busy")));
      await delay(1_500);
      assert.equal(Number(await page.evaluate(bars("done"))), done, "timing omitted by the server is carried forward from cache");
      assert.ok(Number(await page.evaluate(bars("busy"))) > busy, "new live timing reaches the gantt");
      await page.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'))");
      const hidden = Number(await page.evaluate(bars("busy")));
      await delay(1_000);
      assert.equal(Number(await page.evaluate(bars("busy"))), hidden, "hidden tab does not render");
      await page.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange'))");
      await waitFor(page, `${bars("busy")} > ${String(hidden)}`);
      assert.equal(Number(await page.evaluate(bars("done"))), done, "timing is restored after the tab returns");
    });
  } finally {
    clearInterval(timer);
    publisher.close();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    rmSync(root, { recursive: true, force: true });
  }
});

void test("Trajectory keeps a subagent transcript when a refresh races a newer revision", { skip: !browserPath, timeout: 120_000 }, async () => {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address();
  assert.ok(address && typeof address !== "string");
  const port = address.port;
  await new Promise<void>((resolve) => { probe.close(() => { resolve(); }); });
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-stale-"));
  const server = createTrajectoryServer(port, join(root, "lock.json"));
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const publisherId = "stalepublisher1";
  const subagentId = "11111111-1111-4111-8111-111111111111";
  const call = (index: number) => [
    { type: "message", timestamp: new Date(1_000 + index).toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: `call-${String(index)}`, name: "read", arguments: { path: `f${String(index)}` } }] } },
    { type: "message", timestamp: new Date(1_001 + index).toISOString(), message: { role: "toolResult", toolCallId: `call-${String(index)}`, toolName: "read", content: [{ type: "text", text: "ok" }], isError: false } },
  ];
  let revision = 1;
  const publisher = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  await new Promise((resolve) => { publisher.addEventListener("open", resolve, { once: true }); });
  publisher.send(JSON.stringify({ type: "publisher:attach", publisherId }));
  const publish = () => { publisher.send(JSON.stringify({ type: "publisher:state", publisher: { id: publisherId, title: "stale", cwd: "/project", sessionId: "session", connected: true }, runs: [], subagents: [{ id: subagentId, label: "live-sub", state: "running", role: "scout", startedAt: 1_000, model: { provider: "fixture", model: "model" }, request: { prompt: "go", model: "fixture/model" }, attempts: 1, transcript: { revision, status: "available", timing: [] } }] })); };
  // Revision 2 is answered as stale, as a publisher does when the session file grew between its state poll and the read.
  publisher.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { type?: string; requestId?: string; revision?: number };
    if (message.type !== "publisher:transcript") return;
    const base = { type: "publisher:transcript-result", requestId: message.requestId, publisherId, subagentId, requestedRevision: message.revision };
    if (message.revision === 2) { publisher.send(JSON.stringify({ ...base, ok: false, status: "available", revision: 3, error: "Transcript revision is stale" })); return; }
    const calls = message.revision === 3 ? 3 : 2;
    publisher.send(JSON.stringify({ ...base, ok: true, status: "available", revision: message.revision, entries: [{ type: "message", timestamp: new Date(1_000).toISOString(), message: { role: "user", content: "go" } }, ...Array.from({ length: calls }, (_, index) => call(index)).flat()] }));
  });
  publish();
  const toolRows = "[...document.querySelectorAll('#events .evt .pill')].filter((pill) => pill.textContent === 'TOOL').length";
  try {
    await withChrome(`http://127.0.0.1:${String(port)}/?view=subagent&subagent=${publisherId}:${subagentId}`, async (page) => {
      await waitFor(page, `${toolRows} === 2`);
      revision = 2; publish();
      await delay(500);
      assert.equal(Number(await page.evaluate(toolRows)), 2, "a stale refresh keeps the cached tool calls");
      revision = 3; publish();
      await waitFor(page, `${toolRows} === 3`);
    });
  } finally {
    publisher.close();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    rmSync(root, { recursive: true, force: true });
  }
});

function applyFeasibilityFinderPatch(template: string): string {
  const patches: unknown = JSON.parse(readFileSync(new URL("../../../trajectory/test/fixtures/semantic-map-feasibility/finder-live.patch.json", import.meta.url), "utf8"));
  assert.ok(Array.isArray(patches));
  let output = template;
  for (const patch of patches as { find: string; replacement: string }[]) {
    assert.equal(typeof patch.find, "string");
    assert.equal(typeof patch.replacement, "string");
    assert.equal(output.split(patch.find).length, 2, "pinned Finder patch anchor must match exactly once");
    output = output.replace(patch.find, () => patch.replacement);
  }
  return output;
}

async function serveSemanticMapFeasibilityFixture(template: string, refreshFinder = false): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const childProbe = `<script>
    (function () {
      const nonce = "semantic-map-e0-fixture";
      let accepted = false;
      window.addEventListener("message", function (event) {
        if (accepted || event.source !== parent || event.data?.channel !== "semantic-map-e0-bootstrap" || event.data?.nonce !== nonce || event.ports.length !== 1) return;
        accepted = true;
        const port = event.ports[0];
        port.onmessage = function (message) {
          if (message.data?.type === "mutate") {
            const finder = Archify.finder;
            const svg = document.querySelector(".diagram-container svg");
            const initialCount = finder.count;
            const cameraBefore = Archify.view.state();
            const node = document.createElementNS("http://www.w3.org/2000/svg", "g");
            node.setAttribute("data-node-id", "e0-live-node");
            node.setAttribute("data-node-label", "E0 Live Node");
            node.setAttribute("data-animate", "node");
            node.setAttribute("tabindex", "0");
            const shape = document.createElementNS("http://www.w3.org/2000/svg", "rect");
            shape.setAttribute("x", "100");
            shape.setAttribute("y", "100");
            shape.setAttribute("width", "160");
            shape.setAttribute("height", "60");
            node.appendChild(shape);
            const label = document.createElementNS("http://www.w3.org/2000/svg", "text");
            label.textContent = "E0 Live Node";
            node.appendChild(label);
            svg.appendChild(node);
            const inserted = Boolean(svg.querySelector('[data-node-id="e0-live-node"]'));
            node.setAttribute("data-node-status", "running");
            const statusUpdated = node.getAttribute("data-node-status") === "running";
            const cameraAfterStatus = Archify.view.state();
            const probeFinder = function () {
              if (${JSON.stringify(refreshFinder)}) finder.refresh();
              finder.open();
              const input = document.getElementById("node-finder-input");
              input.value = "e0-live-node";
              input.dispatchEvent(new Event("input", { bubbles: true }));
              return {
                nodePresent: Boolean(svg.querySelector('[data-node-id="e0-live-node"]')),
                count: finder.count,
                searchResults: document.querySelectorAll("#node-finder-results .node-finder-result").length,
                selected: finder.select("e0-live-node"),
                activeFocus: Archify.focus.active()
              };
            };
            // Probe while attached: failure after removal alone cannot demonstrate a stale index.
            const whileInserted = probeFinder();
            node.remove();
            const afterRemoval = probeFinder();
            port.postMessage({ type: "mutation-result", origin: self.origin, sandboxOrigin: location.origin, initialCount, inserted, statusUpdated, whileInserted, afterRemoval, cameraBefore, cameraAfterStatus, cameraAfter: Archify.view.state(), frameWidth: document.querySelector(".diagram-container").clientWidth });
          } else if (message.data?.type === "measure") {
            port.postMessage({ type: "measure-result", camera: Archify.view.state(), frameWidth: document.querySelector(".diagram-container").clientWidth });
          }
        };
        port.start();
        port.postMessage({ type: "ready", origin: self.origin, sandboxOrigin: location.origin, finderCount: Archify.finder.count, initialNodeCount: document.querySelectorAll(".diagram-container svg [data-node-id]").length });
      }, { once: true });
    })();
  </script>`;
  const childHtml = template.replace("</body>", `${childProbe}</body>`);
  assert.notEqual(childHtml, template, "fixture shim must be appended without changing the pinned input");
  const parentHtml = `<!doctype html><meta charset="utf-8"><div id="map-host"></div><script>
    window.__mapMessages = [];
    window.mountSemanticMap = function () {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.src = "/archify.html";
      frame.addEventListener("load", function () {
        const channel = new MessageChannel();
        window.__semanticMapPort = channel.port1;
        channel.port1.onmessage = function (event) { window.__mapMessages.push(event.data); };
        channel.port1.start();
        frame.contentWindow.postMessage({ channel: "semantic-map-e0-bootstrap", nonce: "semantic-map-e0-fixture" }, "*", [channel.port2]);
      }, { once: true });
      window.__semanticMapFrame = frame;
      document.getElementById("map-host").appendChild(frame);
    };
    window.unmountSemanticMap = function () {
      window.__semanticMapPort?.close();
      window.__semanticMapPort = null;
      window.__semanticMapFrame?.remove();
      window.__semanticMapFrame = null;
    };
    window.mountSemanticMap();
  </script>`;
  const server = createServer((request, response) => {
    const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
    requests.push(path);
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" });
      response.end(parentHtml);
      return;
    }
    if (path === "/archify.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'" });
      response.end(childHtml);
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${String(address.port)}`, requests, close: () => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); }) };
}

for (const refreshFinder of [false, true]) {
void test(`Pinned Archify E0 sandbox spike ${refreshFinder ? "refreshes Finder with a localized patch" : "demonstrates the unpatched static Finder index"}`, { skip: !browserPath, timeout: 120_000 }, async () => {
  const fixture = readFileSync(new URL("../../../trajectory/test/fixtures/semantic-map-feasibility/archify-template.html", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  assert.equal(Buffer.byteLength(fixture), 774_866);
  const { createHash } = await import("node:crypto");
  assert.equal(createHash("sha256").update(fixture).digest("hex"), "505f1c6baa9c2454475c048aa75df8abd867e680e7b3b794b9218a95a56fc370");
  const server = await serveSemanticMapFeasibilityFixture(refreshFinder ? applyFeasibilityFinderPatch(fixture) : fixture, refreshFinder);
  try {
    await withChrome(`${server.url}/`, async (page) => {
      await waitFor(page, `location.origin === ${JSON.stringify(server.url)}`);
      await page.command("Network.enable");
      const browserRequests: string[] = [];
      page.on("Network.requestWillBeSent", (params) => { if (typeof params.request === "object" && params.request !== null && typeof (params.request as CdpRecord).url === "string") browserRequests.push(String((params.request as CdpRecord).url)); });
      const parentDiagnostics = await page.evaluate("JSON.stringify({href: location.href, state: document.readyState, mapMessages: typeof window.__mapMessages, body: document.body.textContent})");
      assert.equal(await page.evaluate("Array.isArray(window.__mapMessages)"), true, `test page setup failed: ${String(parentDiagnostics)}`);
      await waitFor(page, "window.__mapMessages.some((message) => message.type === 'ready')");
      const ready = await page.evaluate("window.__mapMessages.find((message) => message.type === 'ready')");
      assert.equal((ready as CdpRecord).origin, "null", "the viewer must run in an opaque-origin allow-scripts sandbox");
      assert.equal(await page.evaluate("document.querySelector('iframe').getAttribute('sandbox')"), "allow-scripts");
      await page.evaluate("window.__semanticMapPort.postMessage({ type: 'mutate' })");
      await waitFor(page, "window.__mapMessages?.some((message) => message.type === 'mutation-result')");
      const result = await page.evaluate("window.__mapMessages.find((message) => message.type === 'mutation-result')") as CdpRecord;
      assert.equal(Number((ready as CdpRecord).finderCount), 0, "the pinned template ships an empty static SVG shell, not live graph data");
      assert.equal(Number((ready as CdpRecord).initialNodeCount), 0);
      assert.equal(result.inserted, true);
      assert.equal(result.statusUpdated, true);
      const whileInserted = result.whileInserted as CdpRecord;
      assert.equal(whileInserted.nodePresent, true, "search and selection must be probed BEFORE the inserted node is removed");
      assert.equal(whileInserted.count, refreshFinder ? 1 : result.initialCount, "the localized refresh must index the attached node");
      assert.equal(whileInserted.searchResults, refreshFinder ? 1 : 0, "search must see the attached node only after explicit refresh");
      assert.equal(whileInserted.selected, refreshFinder, "the patched public selection API must accept the attached live node");
      if (refreshFinder) assert.equal(whileInserted.activeFocus, "e0-live-node", "successful selection must actually focus the inserted graph node");
      const afterRemoval = result.afterRemoval as CdpRecord;
      assert.equal(afterRemoval.nodePresent, false, "removal is a separate observation after the live-node probe");
      assert.equal(afterRemoval.count, result.initialCount);
      assert.equal(afterRemoval.searchResults, 0);
      assert.equal(afterRemoval.selected, false);
      assert.deepEqual(result.cameraAfterStatus, result.cameraBefore, "insertion/status mutation does not move the camera before explicit selection");
      await page.command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await page.evaluate("window.__semanticMapPort.postMessage({ type: 'measure' })");
      await waitFor(page, "window.__mapMessages?.some((message) => message.type === 'measure-result')");
      const measured = await page.evaluate("window.__mapMessages.find((message) => message.type === 'measure-result')") as CdpRecord;
      assert.ok(Number(measured.frameWidth) > 0, "opaque sandbox renders its local SVG after resize");
      assert.ok(Number.isFinite(Number((measured.camera as CdpRecord).scale)), "camera remains usable after graph mutation and resize");
      assert.deepEqual(server.requests.filter((path) => path.startsWith("/")), ["/", "/archify.html"], "the self-contained viewer makes no additional local requests or socket connections");
      assert.equal(browserRequests.some((url) => /^wss?:/i.test(url)), false, "the isolated viewer opens no WebSocket");
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await page.evaluate("window.__mapMessages = []; window.unmountSemanticMap(); window.mountSemanticMap()");
        await waitFor(page, "window.__mapMessages?.some((message) => message.type === 'ready')");
        assert.equal(await page.evaluate("document.querySelectorAll('#map-host iframe').length"), 1, "dispose removes the previous browsing context before reopen");
      }
    });
  } finally { await server.close(); }
});
}


function applySemanticProfilePatch(template: string): string {
  assert.equal(Buffer.byteLength(template), 774_866);
  assert.equal(createHash("sha256").update(template).digest("hex"), "505f1c6baa9c2454475c048aa75df8abd867e680e7b3b794b9218a95a56fc370");
  const recipe = readFileSync(new URL("../../../trajectory/test/fixtures/semantic-map-feasibility/live-profile.patch.json", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const patches: unknown = JSON.parse(recipe);
  assert.ok(Array.isArray(patches));
  let output = template;
  for (const patch of patches as { find: string; replacement: string }[]) {
    assert.equal(typeof patch.find, "string");
    assert.equal(typeof patch.replacement, "string");
    assert.equal(output.split(patch.find).length, 2, "pinned live-profile patch anchor must match exactly once");
    output = output.replace(patch.find, () => patch.replacement);
  }
  return output;
}

async function serveSemanticMapLiveProfile(html: string, js: string, css: string): Promise<{ url: string; requests: string[]; close: () => Promise<void> }> {
  const requests: string[] = [];
  const parentHtml = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><div id="map-host" style="width:100vw;height:100vh"></div><script>
    window.__mapMessages = [];
    window.mountSemanticMap = function () {
      const frame = document.createElement("iframe");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.setAttribute("referrerpolicy", "no-referrer");
      frame.style.cssText = "width:100%;height:100%;border:0";
      frame.src = "/archify.html?embed=1";
      frame.addEventListener("load", function () {
        const channel = new MessageChannel();
        window.__semanticMapPort = channel.port1;
        channel.port1.onmessage = function (event) { window.__mapMessages.push(event.data); };
        channel.port1.start();
        frame.contentWindow.postMessage({ channel: "semantic-map-e0-profile", nonce: "semantic-map-e0-profile-fixture" }, "*", [channel.port2]);
      }, { once: true });
      window.__semanticMapFrame = frame;
      document.getElementById("map-host").appendChild(frame);
    };
    window.unmountSemanticMap = function () {
      window.__semanticMapPort?.close();
      window.__semanticMapPort = null;
      window.__semanticMapFrame?.remove();
      window.__semanticMapFrame = null;
    };
  </script>`;
  const csp = "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; worker-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'";
  const server = createServer((request, response) => {
    const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
    requests.push(path);
    if (path === "/") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" });
      response.end(parentHtml);
    } else if (path === "/archify.html") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": csp, "cache-control": "no-store", "x-content-type-options": "nosniff" });
      response.end(html);
    } else if (path === "/live-profile.js") {
      response.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "x-content-type-options": "nosniff" }); response.end(js);
    } else if (path === "/live-profile.css") {
      response.writeHead(200, { "content-type": "text/css; charset=utf-8", "x-content-type-options": "nosniff" }); response.end(css);
    } else if (path === "/favicon.ico") { response.writeHead(204); response.end(); }
    else { response.writeHead(404); response.end(); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${String(address.port)}`, requests, close: () => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }) } ) };
}

void test("Pinned Archify E0 sandbox spike bounded profile proves external assets, live geometry, relations, camera, and cleanup", { skip: !browserPath, timeout: 120_000 }, async () => {
  const base = new URL("../../../trajectory/test/fixtures/semantic-map-feasibility/", import.meta.url);
  const fixture = readFileSync(new URL("archify-template.html", base), "utf8").replace(/\r\n/g, "\n");
  const html = applySemanticProfilePatch(fixture);
  const js = readFileSync(new URL("live-profile.js", base), "utf8").replace(/\r\n/g, "\n");
  const css = readFileSync(new URL("live-profile.css", base), "utf8").replace(/\r\n/g, "\n");
  const recipe = readFileSync(new URL("live-profile.patch.json", base), "utf8").replace(/\r\n/g, "\n");
  const patchBytes = Buffer.byteLength(recipe);
  const htmlBytes = Buffer.byteLength(html), jsBytes = Buffer.byteLength(js), cssBytes = Buffer.byteLength(css);
  assert.equal(htmlBytes, 775_134);
  assert.equal(createHash("sha256").update(html).digest("hex"), "f18ad0819a3e8413c5d9e0ad6f4bf73680f37ce374c3eaa82a8441803baf768f");
  assert.equal(jsBytes, 11_594);
  assert.equal(createHash("sha256").update(js).digest("hex"), "2065e1d6d647e030189ee8d639a4a84228c06f815c2f6b192cc3ef7cfe195983");
  assert.equal(cssBytes, 606);
  assert.equal(createHash("sha256").update(css).digest("hex"), "840e950479da0a335add60341ee5a3e4b9b51069135e5e388b3c5e0253d34e05");
  assert.equal(patchBytes, 1_000);
  assert.equal(createHash("sha256").update(recipe).digest("hex"), "cc830d7796d76fde7019d4553d244f8febd43cecb0219afad3ceca23137b6f2c");
  assert.equal(htmlBytes + jsBytes + cssBytes, 787_334);
  const server = await serveSemanticMapLiveProfile(html, js, css);
  try {
    await withChrome(`${server.url}/`, async (page) => {
      await waitFor(page, `location.origin === ${JSON.stringify(server.url)}`);
      await waitFor(page, "document.readyState === 'complete'");
      await page.command("Network.enable");
      const browserRequests: string[] = [];
      const viewerResponses: CdpRecord[] = [];
      page.on("Network.requestWillBeSent", (params) => {
        if (typeof params.request === "object" && params.request !== null && typeof (params.request as CdpRecord).url === "string") browserRequests.push(String((params.request as CdpRecord).url));
      });
      page.on("Network.responseReceived", (params) => {
        if (typeof params.response === "object" && params.response !== null && String((params.response as CdpRecord).url).includes("/archify.html")) viewerResponses.push(params.response as CdpRecord);
      });
      assert.equal(await page.evaluate("typeof window.mountSemanticMap"), "function", "parent bootstrap must be available before iframe navigation");
      await page.evaluate("window.mountSemanticMap()");
      await waitFor(page, "window.__mapMessages.some((message) => message.type === 'ready') && window.__mapMessages.some((message) => message.type === 'initial')");
      const ready = await page.evaluate("window.__mapMessages.find((message) => message.type === 'ready')") as CdpRecord;
      assert.equal(ready.origin, "null");
      assert.equal(ready.externalScript, true);
      assert.equal(ready.externalStyle, true);
      assert.deepEqual(ready.cspViolations, [], "no blocked resource or external request is attempted during viewer startup");
      assert.equal(await page.evaluate("document.querySelector('iframe').getAttribute('sandbox')"), "allow-scripts");
      await page.evaluate("window.__semanticMapPort.postMessage({action:'metrics'})");
      await waitFor(page, "window.__mapMessages.some((message) => message.type === 'metrics')");
      const initial = await page.evaluate("window.__mapMessages.find((message) => message.type === 'metrics')") as CdpRecord;
      assert.equal(initial.nodeCount, 6, "first rendered graph is nonempty");
      assert.equal(initial.edgeCount, 6);
      assert.equal(initial.nodeGeometry, true, "real SVG shape/text geometry is present");
      assert.equal(initial.edgeGeometry, true, "every explicit relation has finite nonzero SVG path geometry");
      assert.deepEqual(initial.relationTypes, ["dependency", "invokes", "produces"]);
      assert.equal(initial.routeDisabledInEmbed, true, "unsupported Route Probe remains disabled by Archify's embed boundary");
      const initialSlots = initial.slots as Record<string, unknown>;
      const initialViewBox = initial.viewBox;

      await page.evaluate("window.__semanticMapPort.postMessage({action:'pan-zoom'})");
      await waitFor(page, "window.__mapMessages.some((message) => message.type === 'pan-zoom')");
      const panZoom = await page.evaluate("window.__mapMessages.find((message) => message.type === 'pan-zoom')") as CdpRecord;
      const zoomCamera = panZoom.afterZoom as CdpRecord;
      const pannedCamera = panZoom.afterPan as CdpRecord;
      assert.ok(Number(zoomCamera.scale) > 1, "Archify public zoom API changes the real camera");
      assert.ok(Number(pannedCamera.scale) > 1 && (Number(pannedCamera.x) < 0 || Number(pannedCamera.y) < 0), "Archify centerAt pans and zooms the live viewport");
      await page.command("Emulation.setDeviceMetricsOverride", { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
      await delay(150);
      await page.evaluate("window.__semanticMapPort.postMessage({action:'metrics'})");
      await waitFor(page, "window.__mapMessages.filter((message) => message.type === 'metrics').length >= 2");
      const resized = await page.evaluate("window.__mapMessages.filter((message) => message.type === 'metrics').at(-1)") as CdpRecord;
      assert.equal(resized.viewBox, initialViewBox);
      assert.deepEqual(resized.slots, initialSlots, "resize preserves stable semantic slots");
      assert.equal((resized.camera as CdpRecord).scale, pannedCamera.scale);
      assert.ok(Number.isFinite(Number((resized.camera as CdpRecord).x)) && Number.isFinite(Number((resized.camera as CdpRecord).y)));

      await page.evaluate("window.__semanticMapPort.postMessage({action:'status'})");
      await waitFor(page, "window.__mapMessages.some((message) => message.type === 'status')");
      const status = await page.evaluate("window.__mapMessages.find((message) => message.type === 'status')") as CdpRecord;
      assert.equal(status.statusText, "completed");
      assert.notEqual(status.oldStroke, status.newStroke, "status is visibly represented on the node shape");
      assert.deepEqual((status.before as CdpRecord).camera, (status.after as CdpRecord).camera, "status-only update leaves the camera unchanged");
      assert.deepEqual((status.before as CdpRecord).slots, (status.after as CdpRecord).slots, "status-only update does not re-layout nodes");

      await page.evaluate("window.__semanticMapPort.postMessage({action:'insert'})");
      await waitFor(page, "window.__mapMessages.some((message) => message.type === 'insert')");
      const inserted = await page.evaluate("window.__mapMessages.find((message) => message.type === 'insert')") as CdpRecord;
      assert.deepEqual(inserted.previousView, inserted.currentView, "structural update preserves camera state");
      const insertedSlots = (inserted.metrics as CdpRecord).slots as Record<string, unknown>;
      for (const id of Object.keys(initialSlots)) assert.deepEqual(insertedSlots[id], initialSlots[id], `existing node slot stays fixed: ${id}`);
      await page.evaluate("window.__semanticMapPort.postMessage({action:'select'})");
      await waitFor(page, "window.__mapMessages.some((message) => message.type === 'select')");
      const selected = await page.evaluate("window.__mapMessages.find((message) => message.type === 'select')") as CdpRecord;
      assert.equal(selected.count, 1, "Finder finds the inserted, still-attached node");
      assert.equal(selected.selected, true);
      assert.equal(selected.focus, "new-task", "Archify.focus.active() contains the selected stable ID");
      assert.ok(Number(selected.focusMatches) >= 2, "real relation neighbors are highlighted");

      await page.evaluate("window.__semanticMapPort.postMessage({action:'remove-selected'})");
      await waitFor(page, "window.__mapMessages.some((message) => message.type === 'remove-selected')");
      const removed = await page.evaluate("window.__mapMessages.find((message) => message.type === 'remove-selected')") as CdpRecord;
      assert.equal(removed.active, null, "selected-node removal explicitly clears retained focus");
      assert.equal(removed.focusMarkers, 0);
      assert.equal(removed.chipHidden, true);
      assert.equal(removed.finderCount, 6);
      assert.equal(removed.searchCount, 0, "detached node no longer appears in Finder search");
      assert.equal(removed.hash, "", "removed stable ID is removed from the focus route");
      assert.equal(removed.route, null);
      assert.deepEqual(removed.previousView, removed.currentView, "focus invalidation preserves the camera");
      assert.equal((removed.after as CdpRecord).nodeCount, 6);

      const allowed = new Set(["/", "/archify.html", "/live-profile.js", "/live-profile.css", "/favicon.ico"]);
      for (const request of browserRequests) {
        const url = new URL(request);
        assert.equal(url.origin, server.url, `remote/external request is prohibited: ${request}`);
        assert.ok(allowed.has(url.pathname), `unapproved local request: ${request}`);
      }
      assert.ok(browserRequests.some((request) => request.endsWith("/archify.html?embed=1")));
      assert.ok(viewerResponses.length > 0);
      const viewerHeaders = viewerResponses[0]?.headers as CdpRecord | undefined;
      assert.ok(viewerHeaders);
      const csp = String(viewerHeaders["content-security-policy"]);
      assert.match(csp, /default-src 'none'/);
      assert.match(csp, /connect-src 'none'/);
      assert.match(csp, /object-src 'none'/);
      assert.match(csp, /script-src 'self' 'unsafe-inline'/, "unsafe-inline is retained only for pinned template inline code");
      assert.deepEqual(server.requests.filter((path) => path !== "/favicon.ico").slice(0, 4), ["/", "/archify.html", "/live-profile.css", "/live-profile.js"]);
      await page.evaluate("window.__stalePort = window.__semanticMapPort; window.__semanticMapPort.postMessage({action:'metrics'}); window.unmountSemanticMap(); window.__mapMessages = []");
      await delay(100);
      assert.equal(await page.evaluate("document.querySelectorAll('#map-host iframe').length"), 0);
      assert.equal(await page.evaluate("window.__mapMessages.length"), 0, "pending work cannot reply through a disposed browsing context");
      for (let cycle = 0; cycle < 3; cycle += 1) {
        await page.evaluate("window.mountSemanticMap()");
        await waitFor(page, "window.__mapMessages.some((message) => message.type === 'ready') && window.__mapMessages.some((message) => message.type === 'initial')");
        await page.evaluate("window.__semanticMapPort.postMessage({action:'metrics'})");
        await waitFor(page, "window.__mapMessages.some((message) => message.type === 'metrics')");
        const reopened = await page.evaluate("window.__mapMessages.find((message) => message.type === 'metrics')") as CdpRecord;
        assert.equal(reopened.nodeCount, 6, "reopen renders current profile data in a fresh context");
        assert.equal(await page.evaluate("document.querySelectorAll('#map-host iframe').length"), 1);
        await page.evaluate("window.unmountSemanticMap(); window.__mapMessages = []");
        assert.equal(await page.evaluate("document.querySelectorAll('#map-host iframe').length"), 0);
      }
    });
  } finally { await server.close(); }
});


void test("Trajectory lazy Semantic Map uses an opaque private bridge and existing transcript RPC", { skip: !browserPath, timeout: 120_000 }, async () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const bootstrap = `<script>(function(){const C=window.MessageChannel,addWindowListener=window.addEventListener,get=crypto.getRandomValues.bind(crypto),send=MessagePort.prototype.postMessage,handler=Object.getOwnPropertyDescriptor(MessagePort.prototype,'onmessage');window.__NativeMessageChannel=C;window.__holdMapBootstrap=true;window.addEventListener=function(type,listener,options){if(type==='message'&&window.__holdMapBootstrap){return Reflect.apply(addWindowListener,this,[type,event=>{if(event.data?.type==='viewer-listening'){window.__deferredMapLoad={frame:document.querySelector('#semantic-map-host iframe'),callback:listener};window.__deferredMapEvent=event;if(window.__holdMapBootstrap)return}listener(event)},options])}return Reflect.apply(addWindowListener,this,[type,listener,options])};window.__channels=0;window.__mapTokens=[];window.__themes=[];window.__mapSnapshots=[];window.__heldAcks=[];window.__holdMapAck=true;crypto.getRandomValues=function(bytes){get(bytes);window.__mapTokens.push(Array.from(bytes,value=>value.toString(16).padStart(2,'0')).join(''));return bytes};MessagePort.prototype.postMessage=function(data,...transfer){if(data&&data.type==='theme')window.__themes.push(data.theme);if(data&&data.type==='snapshot')window.__mapSnapshots.push(data);return Reflect.apply(send,this,[data,...transfer])};window.MessageChannel=function(){window.__channels++;const channel=new C(),port=channel.port1;Object.defineProperty(port,'onmessage',{configurable:true,get(){return handler.get.call(this)},set(callback){handler.set.call(this,event=>{if(window.__holdMapAck&&event.data&&event.data.type==='ack'){window.__heldAcks.push(event);return}callback(event)})}});return window.__mapChannel=channel};window.__sockets=[];class S{constructor(){this.readyState=1;this.listeners={};this.sent=[];window.__sockets.push(this);window.__socket=this;setTimeout(()=>this.emit('open',{}),0)}addEventListener(t,f){(this.listeners[t] ||= []).push(f)}send(v){this.sent.push(JSON.parse(v))}close(){this.readyState=3}emit(t,e){for(const f of this.listeners[t]||[])f(e)}}window.WebSocket=S})();</script>`;
  const html = source.replace(/\x20{2}<script>\r?\n\x20{4}const defaultRunLayout/, `${bootstrap}\n  <script>\n    const defaultRunLayout`);
  assert.notEqual(html, source);
  const paths = ["/index.html", "/marked.min.js", "/morphdom.min.js", "/prism.min.js", "/semantic-map.html", "/semantic-map.js", "/semantic-map.css"];
  const files = [html, ...["marked.min.js", "morphdom.min.js", "prism.min.js", "semantic-map.html", "semantic-map.js", "semantic-map.css"].map((name) => readFileSync(new URL(`../src/assets/${name}`, import.meta.url)))];
  const routes = new Map(paths.map((path, index) => [path, files[index] as RouteBody]));
  const requests: { path: string; referrer: string }[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1"); requests.push({ path: url.pathname, referrer: request.headers.referer || "" });
    const body = routes.get(url.pathname); if (body === undefined) { response.writeHead(404); response.end(); return; }
    const child = url.pathname.startsWith("/semantic-map.");
    response.setHeader("content-security-policy", child ? "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" : "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
    response.setHeader("content-type", url.pathname.endsWith(".js") ? "text/javascript" : url.pathname.endsWith(".css") ? "text/css" : "text/html"); response.end(body);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    await withChrome(`http://127.0.0.1:${String(address.port)}/index.html`, async (page) => {
      await waitFor(page, "Boolean(window.__socket)");
      const fixture = makeState({ status: "pending" }, "running");
      const record = ((fixture.publishers as CdpRecord[])[0]?.runs as CdpRecord[])[0]?.run as CdpRecord;
      record.transcripts = { agent: { revision: 1, status: "available", timing: [] } };
      await page.evaluate(`window.__socket.emit('message',{data:${JSON.stringify(JSON.stringify(fixture))}})`);
      await waitFor(page, "Boolean(document.querySelector('.workflow-head'))");
      assert.equal(await page.evaluate("document.querySelectorAll('#semantic-map-host iframe').length"), 0);
      assert.equal(await page.evaluate("window.__channels"), 0);
      assert.equal(requests.some((item) => item.path.startsWith("/semantic-map.")), false);
      assert.equal(await page.evaluate("window.__sockets.length"), 1);
      await page.evaluate(clickExpression("#semantic-map-tab"));
      await waitFor(page, "document.querySelector('#semantic-map-host iframe') && window.__deferredMapLoad");
      await delay(120);
      const wrongSourceScript = "const channel=new MessageChannel();parent.__attackPort=channel.port1;parent.__attackMessages=[];channel.port1.onmessage=event=>parent.__attackMessages.push(event.data);const pending=parent.__deferredMapLoad;const [nonce,instance]=parent.__mapTokens;pending.frame.contentWindow.postMessage({channel:'pi-workflows-semantic-map',type:'bootstrap',version:1,build:'" + SEMANTIC_MAP_BUILD_STAMP + "',nonce,instance},'*',[channel.port2]);";
      await page.evaluate(`(()=>{const attacker=document.createElement('iframe');document.body.append(attacker);const script=attacker.contentDocument.createElement('script');script.textContent=${JSON.stringify(wrongSourceScript)};attacker.contentDocument.body.append(script);window.__attackFrame=attacker})()`);
      await waitFor(page, "Boolean(window.__attackPort)");
      await delay(100);
      assert.equal(await page.evaluate("window.__attackMessages.length"), 0, "the child rejects a valid-looking bootstrap from a different source window");
      await page.evaluate("window.__holdMapBootstrap=false;const pending=window.__deferredMapLoad;pending.callback.call(pending.frame,window.__deferredMapEvent)");
      await waitFor(page, "window.__mapSnapshots.length===1 && window.__heldAcks.length===1");
      assert.deepEqual(await page.evaluate("(()=>{const f=document.querySelector('#semantic-map-host iframe');return [f.getAttribute('sandbox'),f.getAttribute('referrerpolicy'),f.sandbox.contains('allow-same-origin')]})()"), ["allow-scripts", "no-referrer", false]);
      assert.equal(await page.evaluate("window.__channels"), 1);
      await waitFor(page, "window.__mapSnapshots.length===1 && window.__heldAcks.length===1");
      for (const state of ["completed", "running", "completed", "running", "completed", "running", "completed", "completed"] as const) {
        const update = makeState({ status: state === "completed" ? "available" : "pending" }, state);
        const run = ((update.publishers as CdpRecord[])[0]?.runs as CdpRecord[])[0]?.run as CdpRecord;
        run.transcripts = { agent: { revision: 1, status: "available", timing: [] } };
        await page.evaluate(`window.__socket.emit('message',{data:${JSON.stringify(JSON.stringify(update))}})`);
        await delay(35);
      }
      assert.equal(await page.evaluate("window.__mapSnapshots.length"), 1, "slow acknowledgement keeps only one active snapshot while newer updates replace the pending one");
      await page.evaluate("window.__holdMapAck=false;window.__mapChannel.port1.onmessage(window.__heldAcks.shift())");
      await waitFor(page, "window.__mapSnapshots.length===2");
      assert.equal(await page.evaluate("window.__mapSnapshots[1].snapshot.run.agents[0].state"), "completed", "only the newest pending state is sent after acknowledgement");
      assert.ok(await page.evaluate("window.__themes.length >= 1"), "the active iframe receives the selected parent theme over its private port");
      await page.evaluate("document.querySelector('[data-theme-toggle]').click()");
      await waitFor(page, "window.__themes.length >= 2");
      assert.ok(["light", "dark"].includes(String(await page.evaluate("window.__themes.at(-1)"))));
      assert.ok(requests.some((item) => item.path === "/semantic-map.html" && !item.referrer));
      assert.ok(requests.some((item) => item.path === "/semantic-map.js") && requests.some((item) => item.path === "/semantic-map.css"));
      await page.evaluate(`(()=>{const duplicate=new window.__NativeMessageChannel();window.__duplicateMessages=[];duplicate.port1.onmessage=event=>window.__duplicateMessages.push(event.data);duplicate.port1.start();const [nonce,instance]=window.__mapTokens;document.querySelector('#semantic-map-host iframe').contentWindow.postMessage({channel:'pi-workflows-semantic-map',type:'bootstrap',version:1,build:'${SEMANTIC_MAP_BUILD_STAMP}',nonce,instance},'*',[duplicate.port2]);window.__duplicatePort=duplicate.port1})()`);
      await delay(100);
      assert.equal(await page.evaluate("window.__duplicateMessages.length"), 0, "duplicate bootstrap cannot initialize a second private port");
      const nodeId = `sm-${Buffer.from(JSON.stringify(["publisher", "run", "run", "", "agent", "agent"]), "utf8").toString("hex")}`;
      assert.deepEqual(await page.evaluate("[window.__mapTokens.length,typeof window.__mapChannel.port1.onmessage]"), [2, "function"]);
      const transcriptBaseline = Number(await page.evaluate("window.__socket.sent.filter((item)=>item.type==='ui:transcript').length"));
      await page.evaluate(`(()=>{const p=window.__mapChannel.port1.onmessage,[nonce,instance]=window.__mapTokens;const base={type:'detail',version:1,nonce,instance,epoch:1,nodeId:${JSON.stringify(nodeId)}};for(const attack of [{...base,nonce:'0'.repeat(64)},{...base,version:99},{...base,instance:'0'.repeat(64)},{...base,nodeId:'sm-00'},{...base,type:'action'},{...base,padding:'x'.repeat(512*1024)}])p({data:attack});return window.__socket.sent.filter((item)=>item.type==='ui:transcript').length})()`);
      // The open map prefetches the bounded transcripts it draws (kinds only) through the same RPC; attacks add nothing.
      assert.equal(await page.evaluate("window.__socket.sent.filter((item)=>item.type==='ui:transcript').length"), transcriptBaseline, "invalid, out-of-scope, control, and oversized requests are rejected");
      assert.ok(await page.evaluate("window.__socket.sent.filter((item)=>item.type==='ui:transcript').every((item)=>item.agentId==='agent')"), "map transcript requests stay inside the selected run");
      await page.evaluate(`(()=>{const [nonce,instance]=window.__mapTokens;window.__mapChannel.port1.onmessage({data:{type:'detail',version:1,nonce,instance,epoch:1,nodeId:${JSON.stringify(nodeId)}}})})()`);
      await waitFor(page, "document.body.dataset.view==='agent' && window.__socket.sent.some((item)=>item.type==='ui:transcript')");
      assert.ok(Number(await page.evaluate("window.__socket.sent.filter((item)=>item.type==='ui:transcript').length")) >= Math.max(1, transcriptBaseline));
      assert.equal(await page.evaluate("window.__sockets.length"), 1);
      await page.evaluate("document.getElementById('run-crumb').click()"); await waitFor(page, "document.body.dataset.view==='run'");
      await page.evaluate(clickExpression("#timeline-tab")); await waitFor(page, "document.querySelectorAll('#semantic-map-host iframe').length===0");
      const channelsBeforeCancel = await page.evaluate("window.__channels");
      await page.evaluate("document.getElementById('semantic-map-tab').click();document.getElementById('timeline-tab').click()");
      await delay(300);
      assert.equal(await page.evaluate("document.querySelectorAll('#semantic-map-host iframe').length"), 0, "closing before load prevents a stale callback from reviving the frame");
      assert.equal(await page.evaluate("window.__channels"), channelsBeforeCancel, "no port is retained for a frame closed before readiness");
      await page.evaluate("document.getElementById('timeline-tab').focus();document.getElementById('projection-tabs').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))");
      await waitFor(page, "document.querySelector('#semantic-map-host iframe') && document.getElementById('semantic-map-tab').getAttribute('aria-selected')==='true'");
      await page.evaluate(clickExpression("#semantic-map-close")); await waitFor(page, "document.querySelectorAll('#semantic-map-host iframe').length===0 && document.getElementById('timeline-tab').getAttribute('aria-selected')==='true'");
      assert.ok(requests.filter((item) => item.path.startsWith("/semantic-map.")).every((item) => ["/semantic-map.html", "/semantic-map.js", "/semantic-map.css"].includes(item.path)));

      const snapshotsBeforeRenderClose = Number(await page.evaluate("window.__mapSnapshots.length"));
      await page.evaluate("window.__holdMapAck=true;document.getElementById('semantic-map-tab').click()");
      await waitFor(page, `window.__mapSnapshots.length===${String(snapshotsBeforeRenderClose + 1)} && window.__heldAcks.length===1`);
      await page.evaluate("document.getElementById('timeline-tab').click()");
      await waitFor(page, "document.querySelectorAll('#semantic-map-host iframe').length===0");
      await page.evaluate("window.__holdMapAck=false;window.__mapChannel.port1.onmessage(window.__heldAcks.shift())");
      await delay(300);
      assert.equal(await page.evaluate("document.querySelectorAll('#semantic-map-host iframe').length"), 0, "closing with a rendered snapshot awaiting acknowledgement cannot revive the frame");
      assert.equal(await page.evaluate("window.__mapSnapshots.length"), snapshotsBeforeRenderClose + 1, "a closed viewer receives no further snapshot");
      assert.equal(await page.evaluate("document.getElementById('semantic-map-status').textContent"), "", "a delayed acknowledgement cannot update the closed map status");
      const mapRequestsAtClose = requests.filter((item) => item.path.startsWith("/semantic-map.")).length;
      await delay(150);
      assert.equal(requests.filter((item) => item.path.startsWith("/semantic-map.")).length, mapRequestsAtClose, "a closed frame cannot initiate later asset requests");
    });
  } finally { await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); }
});


async function waitLong(page: Devtools, expression: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.evaluate(expression)) return;
    await delay(50);
  }
  throw new Error(`Chrome condition did not become true within ${String(timeoutMs)} ms: ${expression}`);
}
async function pressEnter(page: Devtools): Promise<void> {
  await page.command("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: "\r" });
  await page.command("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
}
const MAP_PORT_HARNESS = "<script>(function(){const send=MessagePort.prototype.postMessage;window.__mapSnapshots=[];window.__themes=[];MessagePort.prototype.postMessage=function(data,...rest){if(data&&data.type==='snapshot')window.__mapSnapshots.push(data);if(data&&data.type==='theme')window.__themes.push(data.theme);return Reflect.apply(send,this,[data,...rest])};window.__sockets=[];class S{constructor(){this.readyState=1;this.listeners={};this.sent=[];window.__sockets.push(this);window.__socket=this;setTimeout(()=>this.emit('open',{}),0)}addEventListener(t,f){(this.listeners[t] ||= []).push(f)}send(v){this.sent.push(JSON.parse(v))}close(){this.readyState=3}emit(t,e){for(const f of this.listeners[t]||[])f(e)}}window.WebSocket=S})();</script>";

void test("Semantic Map initializes session data when opaque child subresources are blocked and fails explicitly when parent assets are unavailable", { skip: !browserPath, timeout: 120_000 }, async () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const html = source.replace(/\x20{2}<script>\r?\n\x20{4}const defaultRunLayout/, `${MAP_PORT_HARNESS}\n  <script>\n    const defaultRunLayout`);
  const viewerHtml = readFileSync(new URL("../src/assets/semantic-map.html", import.meta.url), "utf8");
  const files = new Map<string, RouteBody>([["/index.html", html], ...["marked.min.js", "morphdom.min.js", "prism.min.js", "semantic-map.js", "semantic-map.css"].map((name) => [`/${name}`, readFileSync(new URL(`../src/assets/${name}`, import.meta.url))] as [string, RouteBody])]);
  let blockParentAsset = true;
  const requested: { path: string; destination: string }[] = [];
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const destination = request.headers["sec-fetch-dest"] ?? "";
    requested.push({ path, destination });
    response.setHeader("cache-control", "no-store");
    const child = path === "/semantic-map.html";
    response.setHeader("content-security-policy", child ? "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" : "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-src 'self'; connect-src 'self'; object-src 'none'");
    // Deterministically reproduce an opaque-frame resource blocker. Parent-origin fetch remains allowed.
    if (path.startsWith("/semantic-map.") && !child && (destination === "script" || destination === "style" || blockParentAsset)) { response.writeHead(403).end("blocked resource"); return; }
    const body = child ? viewerHtml : files.get(path);
    if (body === undefined) { response.writeHead(404).end(); return; }
    response.setHeader("content-type", path.endsWith(".js") ? "application/javascript" : path.endsWith(".css") ? "text/css" : "text/html");
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    await withChrome(`http://127.0.0.1:${String(address.port)}/index.html`, async (page, browser) => {
      await waitFor(page, "Boolean(window.__socket)");
      await page.evaluate(`window.__socket.emit('message',{data:${JSON.stringify(JSON.stringify(makeState({ status: "pending" }, "running")))}})`);
      await waitFor(page, "Boolean(document.querySelector('.workflow-head'))");
      await page.evaluate(clickExpression("#semantic-map-tab"));
      await waitFor(page, "/assets could not load/.test(document.getElementById('semantic-map-status').textContent)");
      assert.equal(await page.evaluate("document.querySelectorAll('#semantic-map-host iframe').length"), 0);
      assert.equal(await page.evaluate("window.__mapSnapshots.length"), 0, "no session data before readiness");
      assert.doesNotMatch(viewerHtml.slice(viewerHtml.indexOf("<!-- ARCHIFY:SVG_SLOT_START -->"), viewerHtml.indexOf("<!-- ARCHIFY:SVG_SLOT_END -->")), /AWS Region|CloudFront|Auth Provider/);
      blockParentAsset = false;
      await page.evaluate(clickExpression("#semantic-map-retry"));
      await waitFor(page, "document.getElementById('semantic-map-status').textContent.startsWith('Partial graph')");
      const context = await semanticMapContext(page, browser);
      const evaluate = (expression: string): Promise<unknown> => context.connection.evaluateInContext(context.contextId, expression, context.sessionId);
      assert.equal(await evaluate("Boolean(window.SemanticMap)"), true);
      assert.equal(await evaluate("document.getElementById('semantic-map-loading').hidden"), true);
      assert.match(String(await evaluate("document.getElementById('semantic-map-target').textContent")), /run/);
      assert.ok(Number(await evaluate("document.querySelectorAll('.semantic-map-node').length")) > 0);
      assert.equal(await page.evaluate("document.querySelector('#semantic-map-host iframe').getAttribute('sandbox')"), "allow-scripts");
      assert.equal(requested.some((request) => request.path.startsWith("/semantic-map.") && ["script", "style"].includes(request.destination)), false, "opaque child makes no external asset requests");
      await page.evaluate(clickExpression("#timeline-tab"));
      assert.equal(await page.evaluate("document.querySelectorAll('#semantic-map-host iframe').length"), 0);
    });
  } finally { await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); }
});

void test("Trajectory Semantic Map rejects an incompatible viewer protocol or build before run data, retries only explicitly, suspends while hidden, and is keyboard-reachable from agent and subagent focus", { skip: !browserPath, timeout: 180_000 }, async () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const html = source.replace(/\x20{2}<script>\r?\n\x20{4}const defaultRunLayout/, `${MAP_PORT_HARNESS}\n  <script>\n    const defaultRunLayout`);
  assert.notEqual(html, source);
  const viewerJs = readFileSync(new URL("../src/assets/semantic-map.js", import.meta.url), "utf8");
  const viewerHtml = readFileSync(new URL("../src/assets/semantic-map.html", import.meta.url), "utf8");
  const childSend = "port.postMessage({...value,version:1,nonce,instance})";
  const viewerBuild = `build:"${SEMANTIC_MAP_BUILD_STAMP}"`;
  assert.equal(viewerHtml.split(childSend).length, 2, "the deployed inline child bridge has one private-port sender");
  assert.equal(viewerJs.split(viewerBuild).length, 2, "the deployed viewer reports one build stamp");
  // A child speaking protocol 2 and a viewer of another build are refused before any run data.
  const variants = { protocol: viewerJs, build: viewerJs.replace(viewerBuild, 'build:"0123456789abcdef"'), ok: viewerJs };
  let variant: keyof typeof variants = "protocol";
  const statics = new Map<string, RouteBody>([["/index.html", html], ...["marked.min.js", "morphdom.min.js", "prism.min.js", "semantic-map.html", "semantic-map.css"].map((name) => [`/${name}`, readFileSync(new URL(`../src/assets/${name}`, import.meta.url))] as [string, RouteBody])]);
  const requests: string[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url || "/", "http://127.0.0.1"); requests.push(url.pathname + url.search);
    const body = url.pathname === "/semantic-map.js" ? variants[variant] : url.pathname === "/semantic-map.html" && variant === "protocol" ? viewerHtml.replace(childSend, "port.postMessage({...value,version:2,nonce,instance})") : statics.get(url.pathname);
    if (body === undefined) { response.writeHead(404); response.end(); return; }
    const child = url.pathname.startsWith("/semantic-map.");
    response.setHeader("content-security-policy", child ? "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'" : "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'; frame-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'");
    response.setHeader("content-type", url.pathname.endsWith(".js") ? "text/javascript" : url.pathname.endsWith(".css") ? "text/css" : "text/html"); response.end(body);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const mapRequests = (): string[] => requests.filter((path) => path.startsWith("/semantic-map."));
  const stateWith = (agentState: "running" | "completed"): string => {
    const state = makeState({ status: agentState === "completed" ? "available" : "pending" }, agentState);
    const publisher = (state.publishers as CdpRecord[])[0] as CdpRecord;
    publisher.subagents = [{ id: "sub-1", label: "Sub One", state: "running", attempts: 1, startedAt: 1, progress: { toolCalls: [{ id: "call-1", name: "read", state: "completed" }] } }];
    return JSON.stringify(JSON.stringify(state));
  };
  const emit = (agentState: "running" | "completed"): string => `window.__socket.emit('message',{data:${stateWith(agentState)}})`;
  try {
    await withChrome(`http://127.0.0.1:${String(address.port)}/index.html`, async (page, browser) => {
      await waitFor(page, "Boolean(window.__socket)");
      await page.evaluate(emit("running"));
      await waitFor(page, "Boolean(document.querySelector('.workflow-head'))");
      assert.equal(await page.evaluate("document.getElementById('semantic-map-retry').hidden"), true);

      // Protocol mismatch: visible reason, frame and port disposed, no snapshot ever sent.
      await page.evaluate(clickExpression("#semantic-map-tab"));
      await waitFor(page, "/protocol mismatch/.test(document.getElementById('semantic-map-status').textContent)");
      assert.equal(await page.evaluate("document.querySelectorAll('#semantic-map-host iframe').length"), 0);
      assert.equal(await page.evaluate("document.getElementById('semantic-map-retry').hidden"), false, "an explicit Retry is offered");
      assert.equal(await page.evaluate("window.__mapSnapshots.length"), 0, "no run data reaches a viewer with another protocol");
      const requestsAfterFailure = mapRequests().length;
      assert.ok(mapRequests().every((path) => path.includes(`v=${SEMANTIC_MAP_BUILD_STAMP}`)), JSON.stringify(mapRequests()));
      for (const agentState of ["completed", "running", "completed"] as const) { await page.evaluate(emit(agentState)); await delay(60); }
      await delay(400);
      assert.equal(await page.evaluate("document.querySelectorAll('#semantic-map-host iframe').length"), 0, "live updates never reopen a failed map");
      assert.equal(mapRequests().length, requestsAfterFailure, "no asset request without an explicit retry");
      assert.match(String(await page.evaluate("document.getElementById('semantic-map-status').textContent")), /protocol mismatch/);
      await page.evaluate(clickExpression("#semantic-map-tab"));
      await delay(200);
      assert.equal(mapRequests().length, requestsAfterFailure, "re-selecting the already selected tab is not a hidden retry");

      // Explicit Retry against a viewer of another build: refused again before data.
      variant = "build";
      await page.evaluate(clickExpression("#semantic-map-retry"));
      await waitFor(page, "/build mismatch/.test(document.getElementById('semantic-map-status').textContent)");
      assert.ok(mapRequests().length > requestsAfterFailure, "Retry loads a fresh viewer");
      assert.equal(await page.evaluate("window.__mapSnapshots.length"), 0, "no run data reaches a viewer of another build");
      assert.equal(await page.evaluate("document.querySelectorAll('#semantic-map-host iframe').length"), 0);
      // Closing and reopening the tab is also explicit and gets a fresh instance, still refused.
      await page.evaluate(clickExpression("#timeline-tab"));
      assert.equal(await page.evaluate("document.getElementById('semantic-map-retry').hidden"), true);
      await page.evaluate(clickExpression("#semantic-map-tab"));
      await waitFor(page, "/build mismatch/.test(document.getElementById('semantic-map-status').textContent) && document.querySelectorAll('#semantic-map-host iframe').length===0");
      assert.equal(await page.evaluate("window.__mapSnapshots.length"), 0);

      // Recovery: the compatible viewer receives data only after an explicit Retry.
      variant = "ok";
      await page.evaluate(clickExpression("#semantic-map-retry"));
      await waitFor(page, "document.getElementById('semantic-map-status').textContent.startsWith('Partial graph') && window.__mapSnapshots.length>=1");
      assert.equal(await page.evaluate("document.getElementById('semantic-map-retry').hidden"), true);
      assert.deepEqual(await page.evaluate("(()=>{const f=document.querySelector('#semantic-map-host iframe');return [f.getAttribute('sandbox'),f.sandbox.contains('allow-same-origin'),f.getAttribute('referrerpolicy')]})()"), ["allow-scripts", false, "no-referrer"]);

      // Hidden page: no sends while hidden, however many updates arrive; visible again resyncs only the current state.
      await delay(300);
      const sentBeforeHide = Number(await page.evaluate("window.__mapSnapshots.length"));
      await page.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange'))");
      for (const agentState of ["running", "completed", "running"] as const) { await page.evaluate(emit(agentState)); await delay(120); }
      await delay(400);
      assert.equal(Number(await page.evaluate("window.__mapSnapshots.length")), sentBeforeHide, "a hidden page sends nothing to the viewer");
      await page.evaluate("Object.defineProperty(document, 'hidden', { configurable: true, get: () => false }); document.dispatchEvent(new Event('visibilitychange'))");
      await waitFor(page, `window.__mapSnapshots.length===${String(sentBeforeHide + 1)}`);
      await delay(400);
      assert.equal(Number(await page.evaluate("window.__mapSnapshots.length")), sentBeforeHide + 1, "visibility resyncs once with the current state, not the queued history");
      assert.equal(await page.evaluate("window.__mapSnapshots.at(-1).snapshot.run.agents[0].state"), "running");

      // Theme and reduced motion reach the opaque viewer only through its own media query and the private port.
      const frame = await semanticMapContext(page, browser);
      const reducedMotion = { features: [{ name: "prefers-reduced-motion", value: "reduce" }] };
      await page.command("Emulation.setEmulatedMedia", reducedMotion);
      // An out-of-process opaque frame is its own CDP target; the OS preference reaches it like any frame, emulation must be applied per target.
      if (frame.sessionId) await browser.command("Emulation.setEmulatedMedia", reducedMotion, frame.sessionId);
      const themesBefore = Number(await page.evaluate("window.__themes.length"));
      await page.evaluate("document.querySelector('[data-theme-toggle]').click()");
      await waitFor(page, `window.__themes.length>${String(themesBefore)}`);
      const parentTheme = await page.evaluate("document.documentElement.dataset.theme");
      assert.equal(await page.evaluate("window.__themes.at(-1)"), parentTheme);
      const inFrame = (expression: string): Promise<unknown> => frame.connection.evaluateInContext(frame.contextId, expression, frame.sessionId);
      for (let attempt = 0; attempt < 40 && await inFrame("document.documentElement.getAttribute('data-theme')") !== parentTheme; attempt += 1) await delay(25);
      assert.equal(await inFrame("document.documentElement.getAttribute('data-theme')"), parentTheme, "the viewer applies the parent theme");
      assert.equal(await inFrame("matchMedia('(prefers-reduced-motion: reduce)').matches"), true, "the viewer sees the reduced-motion preference");

      // Keyboard: the focused agent's run map and the focused subagent's map are one Enter away from the detail view.
      await page.evaluate("setView('agent')");
      await waitFor(page, "document.body.dataset.view==='agent' && document.querySelectorAll('#semantic-map-host iframe').length>=0");
      assert.equal(await page.evaluate("(()=>{const b=document.getElementById('focus-semantic-map');return b.tabIndex>=0 && b.offsetParent!==null})()"), true, "the focused-agent map control is keyboard focusable and visible");
      await page.evaluate("document.getElementById('focus-semantic-map').focus()");
      await pressEnter(page);
      await waitFor(page, "document.body.dataset.view==='run' && document.getElementById('semantic-map-tab').getAttribute('aria-selected')==='true' && document.activeElement && document.activeElement.id==='semantic-map-tab' && document.getElementById('semantic-map-status').textContent.startsWith('Partial graph')");
      assert.equal(await page.evaluate("window.__mapSnapshots.at(-1).snapshot.scope.targetKind"), "run");
      await page.evaluate("document.querySelector('#sidebar [data-subagent]').click()");
      await waitFor(page, "document.body.dataset.view==='subagent'");
      await page.evaluate("document.getElementById('focus-semantic-map').focus()");
      await pressEnter(page);
      await waitLong(page, "document.body.dataset.view==='run' && document.activeElement && document.activeElement.id==='semantic-map-tab' && window.__mapSnapshots.at(-1).snapshot.scope.targetKind==='subagent' && document.getElementById('semantic-map-status').textContent.startsWith('Partial graph')", 5000);
      assert.equal(await page.evaluate("window.__mapSnapshots.at(-1).snapshot.subagent.id"), "sub-1");
      assert.equal(await page.evaluate("JSON.stringify(window.__mapSnapshots).includes('Inspect the fixture')"), false, "the subagent projection carries no prompt");

      // Close before readiness and with a late callback: nothing is revived and no request follows.
      await page.evaluate(clickExpression("#timeline-tab"));
      await waitFor(page, "document.querySelectorAll('#semantic-map-host iframe').length===0");
      await page.evaluate("document.getElementById('semantic-map-tab').click();document.getElementById('timeline-tab').click()");
      const requestsAtClose = mapRequests().length;
      await page.evaluate(emit("running"));
      await delay(400);
      assert.equal(await page.evaluate("document.querySelectorAll('#semantic-map-host iframe').length"), 0);
      assert.equal(mapRequests().length, requestsAtClose, "a map closed before readiness makes no later request");
      assert.equal(await page.evaluate("document.getElementById('semantic-map-status').textContent"), "");
      assert.equal(await page.evaluate("window.__sockets.length"), 1, "the viewer never adds a socket");
    });
  } finally { await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); }
});

void test("Trajectory static export gives a live-only explanation without map requests", { skip: !browserPath, timeout: 120_000 }, async () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const state = makeState({ status: "pending" }, "running");
  const html = source.replace(/\x20{2}<script>\r?\n\x20{4}const defaultRunLayout/, `<script>window.__PIEWF_STATIC__=${JSON.stringify(state)};</script>\n  <script>\n    const defaultRunLayout`);
  assert.notEqual(html, source);
  const requests: string[] = [];
  const routes = new Map<string, RouteBody>([["/index.html", html], ["/marked.min.js", readFileSync(new URL("../src/assets/marked.min.js", import.meta.url))], ["/morphdom.min.js", readFileSync(new URL("../src/assets/morphdom.min.js", import.meta.url))], ["/prism.min.js", readFileSync(new URL("../src/assets/prism.min.js", import.meta.url))]]);
  const server = createServer((request, response) => {
    const path = new URL(request.url || "/", "http://127.0.0.1").pathname; requests.push(path);
    const body = routes.get(path); response.setHeader("content-type", path.endsWith(".js") ? "text/javascript" : "text/html");
    if (body === undefined) { response.writeHead(404); response.end(); } else { response.writeHead(200); response.end(body); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  try {
    await withChrome(`http://127.0.0.1:${String(address.port)}/index.html`, async (page) => {
      await waitFor(page, "Boolean(document.querySelector('.workflow-head'))");
      await page.evaluate(clickExpression("#semantic-map-tab"));
      assert.match(String(await page.evaluate("document.getElementById('semantic-map-status').textContent")), /static export/i);
      assert.equal(await page.evaluate("document.querySelectorAll('#semantic-map-host iframe').length"), 0);
      assert.equal(requests.some((path) => path.startsWith("/semantic-map.")), false);
      assert.equal(requests.some((path) => path === "/ws"), false);
    });
  } finally { await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); }
});

void test("Trajectory production routes load all three Semantic Map assets in an opaque sandbox under served CSP", { skip: !browserPath, timeout: 120_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), "trajectory-production-map-browser-"));
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const probeAddress = probe.address(); assert.ok(probeAddress && typeof probeAddress !== "string");
  const port = probeAddress.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => { if (error) reject(error); else resolve(); }));
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { fingerprint: "production-route-browser-test" });
  const productionRequests: string[] = [];
  server.on("request", (request) => { productionRequests.push(request.url ?? "/"); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const base = `http://127.0.0.1:${String(port)}`;
  try {
    await withChrome(`${base}/`, async (page) => {
      await waitFor(page, "document.readyState === 'complete' && document.querySelector('.app') !== null && document.getElementById('semantic-map-host') !== null");
      await page.command("Network.enable");
      await page.command("Log.enable");
      const securityErrors: string[] = [];
      page.on("Log.entryAdded", (params) => {
        const entry = params.entry as CdpRecord | undefined;
        const text = typeof entry?.text === "string" ? entry.text : "";
        if (/content security policy|refused to load/i.test(text)) securityErrors.push(text);
      });
      assert.equal(await page.evaluate("performance.getEntriesByType('resource').some((entry) => entry.name.includes('semantic-map.'))"), false, "no map asset request occurs before activation");
      const nonce = "e".repeat(64), instance = "f".repeat(64);
      await page.evaluate(`(()=>{const frame=document.createElement('iframe');frame.title='production route probe';frame.setAttribute('sandbox','allow-scripts');frame.setAttribute('referrerpolicy','no-referrer');frame.src='/semantic-map.html?v=${SEMANTIC_MAP_BUILD_STAMP}&embed=1&theme=dark';const channel=new MessageChannel();window.__productionMapMessages=[];window.__productionMapPort=channel.port1;channel.port1.onmessage=event=>window.__productionMapMessages.push(event.data);channel.port1.start();const listen=async event=>{if(event.source!==frame.contentWindow||event.data?.type!=='viewer-listening')return;window.removeEventListener('message',listen);frame.contentWindow.postMessage({channel:'pi-workflows-semantic-map',type:'bootstrap',version:1,build:'${SEMANTIC_MAP_BUILD_STAMP}',nonce:${JSON.stringify(nonce)},instance:${JSON.stringify(instance)}},'*',[channel.port2]);const [script,style]=await Promise.all(['semantic-map.js','semantic-map.css'].map(name=>fetch('/'+name+'?v=${SEMANTIC_MAP_BUILD_STAMP}').then(response=>response.text())));channel.port1.postMessage({type:'initialize',version:1,build:'${SEMANTIC_MAP_BUILD_STAMP}',nonce:${JSON.stringify(nonce)},instance:${JSON.stringify(instance)},script,style})};window.addEventListener('message',listen);window.__productionMapFrame=frame;document.getElementById('semantic-map-host').append(frame)})()`);
      await waitFor(page, "window.__productionMapMessages.some((message) => message.type === 'ready')");
      assert.deepEqual(await page.evaluate("[window.__productionMapFrame.sandbox.contains('allow-scripts'),window.__productionMapFrame.sandbox.contains('allow-same-origin')]"), [true, false]);
      const snapshot = { scope: { publisherId: "publisher", targetKind: "run", targetId: "run" }, run: { id: "run", workflowName: "Production HTTP map", state: "running", agents: [{ id: "agent", name: "agent", state: "running", attempts: 1, attemptDetails: [], structuralPath: [], toolCalls: [] }] }, partial: { reasons: ["production route smoke"], omittedNodes: 0, omittedEdges: 0 } };
      await page.evaluate(`window.__productionMapPort.postMessage({type:'snapshot',version:1,nonce:${JSON.stringify(nonce)},instance:${JSON.stringify(instance)},sequence:1,epoch:1,snapshot:${JSON.stringify(snapshot)}})`);
      await waitFor(page, "window.__productionMapMessages.some((message) => message.type === 'ack' && Array.isArray(message.nodeIds) && message.nodeIds.length > 0)");
      assert.ok(Number(await page.evaluate("window.__productionMapMessages.find((message) => message.type === 'ack').nodeIds.length")) >= 1);
      const allowed = new Set(["/semantic-map.html", "/semantic-map.js", "/semantic-map.css"]);
      const mapRequests = productionRequests.map((path) => new URL(path, base)).filter((url) => url.pathname.startsWith("/semantic-map."));
      for (const request of mapRequests) {
        assert.equal(request.origin, base, `external request denied: ${request.href}`);
        assert.ok(allowed.has(request.pathname), `unexpected production request: ${request.href}`);
      }
      assert.deepEqual(new Set(mapRequests.map((request) => request.pathname)), allowed);
      assert.equal(mapRequests.length, allowed.size, `the viewer requested exactly one HTML, JS, and CSS response: ${JSON.stringify(mapRequests)}`);
      assert.equal(securityErrors.length, 0, securityErrors.join("\n"));
      await page.evaluate("window.__productionMapPort.close();window.__productionMapFrame.remove()");
    });
  } finally {
    server.closeAllConnections(); server.closeIdleConnections(); server.close(); server.unref();
    rmSync(root, { recursive: true, force: true });
  }
});

function semanticAgent(id: string, name: string, state: "running" | "completed" = "running"): Record<string, unknown> {
  return {
    id, name, label: name, state, attempts: 1, startedAt: Date.now(),
    durationMs: state === "completed" ? 20 : undefined, structuralPath: ["e4-live-scope"],
    attemptDetails: [{ attempt: 1, transport: "local", setup: { cwd: "E4-PRIVATE-CWD", systemPrompt: "E4-PRIVATE-PROMPT" } }],
    prompt: "E4-PRIVATE-PROMPT", systemPrompt: "E4-PRIVATE-SYSTEM", args: { secret: "E4-PRIVATE-ARGS" },
    output: { status: "available", value: "E4-PRIVATE-RESULT" }, tools: ["read"]
  };
}
function semanticRun(id: string, name: string, agents: readonly Record<string, unknown>[], relations: readonly Record<string, unknown>[] = []): Record<string, unknown> {
  return {
    id, workflowName: name, cwd: "E4-PRIVATE-CWD", sessionId: "e4-live-session", state: "running", startedAt: Date.now(),
    agents, relations, events: [], script: "E4-PRIVATE-SCRIPT", args: { secret: "E4-PRIVATE-ARGS" }
  };
}
function publisherState(publisherId: string, runs: readonly Record<string, unknown>[]): string {
  return JSON.stringify({
    type: "publisher:state", publisher: { id: publisherId, title: "E4 production browser", cwd: "/project", sessionId: "e4-live-session", connected: true },
    runs: runs.map((run) => ({ run, snapshot: { script: "E4-PRIVATE-SCRIPT", args: { secret: "E4-PRIVATE-ARGS" } }, transcripts: {} })), subagents: []
  });
}
async function availableLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const address = probe.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => probe.close((error) => { if (error) reject(error); else resolve(); }));
  return address.port;
}
async function connectLivePublisher(port: number, publisherId: string): Promise<WebSocket> {
  const publisher = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
  await new Promise<void>((resolve, reject) => {
    publisher.addEventListener("open", () => { resolve(); }, { once: true });
    publisher.addEventListener("error", () => { reject(new Error("Trajectory test publisher could not connect")); }, { once: true });
  });
  publisher.send(JSON.stringify({ type: "publisher:attach", publisherId }));
  return publisher;
}
type SemanticMapFrameContext = { connection: Devtools; contextId: number; sessionId?: string };
async function semanticMapHeap(browser: Devtools): Promise<{ targetId: string; usedSize: number; totalSize: number } | undefined> {
  const targets = ((await browser.command("Target.getTargets")).result as CdpRecord | undefined)?.targetInfos;
  if (!Array.isArray(targets)) return undefined;
  const target = targets.map((value) => value as CdpRecord).find((value) => typeof value.url === "string" && value.url.includes("/semantic-map.html"));
  if (typeof target?.targetId !== "string") return undefined;
  const attached = await browser.command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
  const sessionId = (attached.result as CdpRecord | undefined)?.sessionId;
  if (typeof sessionId !== "string") return undefined;
  try {
    await browser.command("HeapProfiler.enable", {}, sessionId);
    await browser.command("Runtime.enable", {}, sessionId);
    await browser.command("HeapProfiler.collectGarbage", {}, sessionId);
    const measured = ((await browser.command("Runtime.getHeapUsage", {}, sessionId)).result as CdpRecord | undefined);
    if (typeof measured?.usedSize !== "number" || typeof measured.totalSize !== "number") return undefined;
    return { targetId: target.targetId, usedSize: measured.usedSize, totalSize: measured.totalSize };
  } finally { await browser.command("Target.detachFromTarget", { sessionId }); }
}

async function semanticMapContext(page: Devtools, browser: Devtools): Promise<SemanticMapFrameContext> {
  const treeResponse = await page.command("Page.getFrameTree");
  const tree = (treeResponse.result as CdpRecord | undefined)?.frameTree as CdpRecord | undefined;
  const findFrame = (node: CdpRecord | undefined): string | undefined => {
    if (!node) return undefined;
    const frame = node.frame as CdpRecord | undefined;
    if (typeof frame?.url === "string" && frame.url.includes("/semantic-map.html")) return typeof frame.id === "string" ? frame.id : undefined;
    const children = Array.isArray(node.childFrames) ? node.childFrames : [];
    for (const child of children) { const found = findFrame(child as CdpRecord); if (found) return found; }
    return undefined;
  };
  const frameId = findFrame(tree);
  if (frameId) {
    let contextId: number | undefined;
    page.on("Runtime.executionContextCreated", (params) => {
      const context = params.context as CdpRecord | undefined;
      const auxiliary = context?.auxData as CdpRecord | undefined;
      if (auxiliary?.frameId === frameId && auxiliary.isDefault === true && typeof context?.id === "number") contextId = context.id;
    });
    await page.command("Runtime.enable");
    for (let attempt = 0; attempt < 100 && contextId === undefined; attempt += 1) await delay(20);
    assert.ok(contextId !== undefined, "CDP exposes the live iframe execution context");
    return { connection: page, contextId };
  }

  await browser.command("Target.setDiscoverTargets", { discover: true });
  let targetInfo: CdpRecord | undefined;
  for (let attempt = 0; attempt < 100 && !targetInfo; attempt += 1) {
    const targets = ((await browser.command("Target.getTargets")).result as CdpRecord | undefined)?.targetInfos;
    if (Array.isArray(targets)) targetInfo = targets.map((target) => target as CdpRecord).find((target) => typeof target.url === "string" && target.url.includes("/semantic-map.html"));
    if (!targetInfo) await delay(20);
  }
  const targetId = targetInfo && typeof targetInfo.targetId === "string" ? targetInfo.targetId : undefined;
  assert.ok(targetId, "Chrome discovers the opaque viewer as a separate frame target");
  const attached = await browser.command("Target.attachToTarget", { targetId, flatten: true });
  const rawSessionId = (attached.result as CdpRecord | undefined)?.sessionId;
  const sessionId = typeof rawSessionId === "string" ? rawSessionId : undefined;
  assert.ok(sessionId, "Chrome attaches a DevTools session to the opaque viewer target");
  let contextId: number | undefined;
  browser.on("Runtime.executionContextCreated", (params) => {
    const context = params.context as CdpRecord | undefined;
    const auxiliary = context?.auxData as CdpRecord | undefined;
    if (params.__cdpSessionId === sessionId && auxiliary?.isDefault === true && typeof context?.id === "number") contextId = context.id;
  });
  await browser.command("Runtime.enable", {}, sessionId);
  for (let attempt = 0; attempt < 100 && contextId === undefined; attempt += 1) await delay(20);
  assert.ok(contextId !== undefined, "CDP exposes the separately targeted opaque viewer execution context");
  return { connection: browser, contextId, sessionId };
}

void test("Trajectory live Semantic Map follows publisher WebSocket state through the production UI, bridge, and routes", { skip: !browserPath, timeout: 180_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "trajectory-live-semantic-map-"));
  const port = await availableLoopbackPort();
  const publisherId = "e4semanticpublisher";
  const relationAgents = Array.from({ length: 18 }, (_, index) => semanticAgent(`agent-${String(index).padStart(2, "0")}`, index === 1 ? "Agent Beta" : `Agent ${String(index).padStart(2, "0")}`));
  const relations = Array.from({ length: 9 }, (_, index) => ({ id: `relation-${String(index)}`, kind: index % 2 ? "dependency" : "fork", fromAgentId: `agent-${String(index).padStart(2, "0")}`, toAgentId: `agent-${String(index + 1).padStart(2, "0")}` }));
  const firstRun = semanticRun("run-first", "E4 live first target", relationAgents, relations);
  const secondRun = semanticRun("run-second", "E4 live second target", [semanticAgent("target-agent", "Agent Target")]);
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { fingerprint: "e4-live-semantic-map-browser" });
  const httpRequests: { method: string; path: string; status?: number; bytes?: number }[] = [];
  const socketConnections: { path: string; origin?: string }[] = [];
  let replacement: WebSocket | undefined;
  server.on("request", (request, response) => {
    const url = new URL(request.url ?? "/", `http://127.0.0.1:${String(port)}`);
    if (!url.pathname.startsWith("/semantic-map.")) return;
    const record: { method: string; path: string; status?: number; bytes?: number } = { method: request.method ?? "", path: url.pathname };
    httpRequests.push(record);
    const writable = response as unknown as { end: (chunk?: string | Buffer) => ServerResponse };
    const end = writable.end.bind(response);
    writable.end = (chunk?: string | Buffer): ServerResponse => {
      record.bytes = typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk?.byteLength ?? 0;
      return end(chunk);
    };
    response.once("finish", () => { record.status = response.statusCode; });
  });
  server.on("upgrade", (request) => { socketConnections.push({ path: request.url ?? "", ...(typeof request.headers.origin === "string" ? { origin: request.headers.origin } : {}) }); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const publisher = await connectLivePublisher(port, publisherId);
  publisher.send(publisherState(publisherId, [firstRun, secondRun]));
  const base = `http://127.0.0.1:${String(port)}`;
  const startRef = `${publisherId}:run-first`;
  const secondRef = `${publisherId}:run-second`;
  try {
    await withChrome(`${base}/?view=run&run=${encodeURIComponent(startRef)}`, async (page, browser) => {
      await waitFor(page, "Boolean(document.querySelector('.workflow-head')) && document.body.dataset.view==='run'");
      await page.command("Network.enable"); await page.command("Log.enable");
      const browserUrls: string[] = [];
      const cspErrors: string[] = [];
      page.on("Network.requestWillBeSent", (params) => { const request = params.request as CdpRecord | undefined; if (typeof request?.url === "string") browserUrls.push(request.url); });
      page.on("Log.entryAdded", (params) => {
        const entry = params.entry as CdpRecord | undefined;
        const text = typeof entry?.text === "string" ? entry.text : "";
        if (/content security policy|refused to load/i.test(text)) cspErrors.push(text);
      });
      page.on("Runtime.exceptionThrown", (params) => { const details = params.exceptionDetails as CdpRecord | undefined; cspErrors.push(textValue(details?.text, "uncaught browser exception")); });
      assert.equal(httpRequests.length, 0, "production UI does not eagerly request Semantic Map assets");
      await page.evaluate(`(()=>{const descriptor=Object.getOwnPropertyDescriptor(MessagePort.prototype,'onmessage');window.__semanticChildRequests=[];Object.defineProperty(MessagePort.prototype,'onmessage',{configurable:true,get(){return descriptor.get.call(this)},set(callback){descriptor.set.call(this,event=>{if(event.data&&['select','detail'].includes(event.data.type))window.__semanticChildRequests.push(event.data);callback(event)})}})})()`);
      assert.ok(await page.evaluate(`[...document.querySelectorAll('#sidebar [data-run]')].some((button) => button.dataset.run === ${JSON.stringify(secondRef)})`), "publisher exposes the alternate live run target");
      await page.evaluate("window.__semanticMapStarted=performance.now();document.getElementById('semantic-map-tab').click()");
      await waitFor(page, "document.querySelector('#semantic-map-host iframe') && document.getElementById('semantic-map-status').textContent.startsWith('Partial graph')");
      const firstReadyMs = Number(await page.evaluate("performance.now()-window.__semanticMapStarted"));
      assert.ok(firstReadyMs > 0 && Number.isFinite(firstReadyMs));
      assert.equal(await page.evaluate("document.querySelector('#semantic-map-host iframe').sandbox.contains('allow-scripts') && !document.querySelector('#semantic-map-host iframe').sandbox.contains('allow-same-origin')"), true);
      const frameContext = await semanticMapContext(page, browser);
      const evaluateMap = (expression: string): Promise<unknown> => frameContext.connection.evaluateInContext(frameContext.contextId, expression, frameContext.sessionId);
      const firstGraph = await evaluateMap(`(()=>({nodes:[...document.querySelectorAll('.semantic-map-node')].map(node=>({id:node.getAttribute('data-node-id'),label:node.getAttribute('data-node-label'),kind:node.getAttribute('data-node-kind')})),notice:document.getElementById('semantic-map-completeness')?.textContent||'',origin:self.origin,locationOrigin:location.origin,body:document.body.textContent||''}))()` ) as CdpRecord;
      const firstNodes = firstGraph.nodes as CdpRecord[];
      assert.ok(firstNodes.length >= 17 && firstNodes.length <= 500, `bounded live graph includes root and projected agents; got ${String(firstNodes.length)}`);
      assert.ok(firstNodes.every((node) => typeof node.id === "string" && /^sm-(?:[0-9a-f]{2})+$/.test(node.id)));
      assert.ok(String(firstGraph.notice).includes("Partial graph"), "the 18-agent/9-relation source remains explicitly partial under projection limits");
      assert.equal(String(firstGraph.origin), "null", "the production viewer has an opaque origin");
      assert.equal(String(firstGraph.body).includes("E4-PRIVATE"), false, "prompts, scripts, args, environment, and output values never reach the map");
      const selected = await evaluateMap(`(()=>{const node=[...document.querySelectorAll('.semantic-map-node')].find(candidate=>candidate.getAttribute('data-node-label')==='Agent Beta');if(!node)return null;node.dispatchEvent(new MouseEvent('click',{bubbles:true}));return {id:node.getAttribute('data-node-id')}})()` ) as CdpRecord | null;
      assert.ok(selected);
      await waitFor(page, `window.__semanticChildRequests.some(message=>message.type==='select'&&message.nodeId===${JSON.stringify(selected.id)})`);
      await evaluateMap(`(()=>{const node=[...document.querySelectorAll('.semantic-map-node')].find(candidate=>candidate.getAttribute('data-node-label')==='Agent Beta');node.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))})()`);
      await waitFor(page, "window.__semanticChildRequests.some(message=>message.type==='detail')");
      await waitFor(page, "document.body.dataset.view==='agent' && document.getElementById('agent-crumb').textContent==='Agent Beta'");
      await page.evaluate("document.getElementById('run-crumb').click()");
      await waitFor(page, "document.body.dataset.view==='run'");
      await page.evaluate(`[...document.querySelectorAll('#sidebar [data-run]')].find((button) => button.dataset.run === ${JSON.stringify(secondRef)}).click()`);
      let targetUpdated = false;
      for (let attempt = 0; attempt < 100 && !targetUpdated; attempt += 1) {
        targetUpdated = await evaluateMap("[...document.querySelectorAll('.semantic-map-node')].some(node=>node.getAttribute('data-node-label')==='Agent Target')") as boolean;
        if (!targetUpdated) await delay(25);
      }
      assert.equal(targetUpdated, true, "the currently selected run replaces prior target graph data");
      assert.equal(await evaluateMap("[...document.querySelectorAll('.semantic-map-node')].some(node=>node.getAttribute('data-node-label')==='Agent Beta')"), false, "nodes from the previous target are removed");
      replacement = await connectLivePublisher(port, publisherId);
      replacement.send(publisherState(publisherId, [firstRun, semanticRun("run-second", "E4 live second target", [semanticAgent("target-agent", "Agent Target", "completed")])]));
      publisher.close();
      await waitFor(page, "document.body.dataset.view==='run'");
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (await evaluateMap("[...document.querySelectorAll('.semantic-map-node')].some(node=>node.getAttribute('data-node-label')==='Agent Target'&&node.getAttribute('data-node-status')==='success')")) break;
        await delay(25);
      }
      assert.equal(await evaluateMap("[...document.querySelectorAll('.semantic-map-node')].some(node=>node.getAttribute('data-node-label')==='Agent Target'&&node.getAttribute('data-node-status')==='success')"), true, "publisher replacement generation and latest live status reach the selected scope");
      await evaluateMap(`(()=>{const node=[...document.querySelectorAll('.semantic-map-node')].find(candidate=>candidate.getAttribute('data-node-label')==='Agent Target');node.dispatchEvent(new MouseEvent('click',{bubbles:true}));node.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))})()`);
      await waitFor(page, "document.body.dataset.view==='agent' && document.getElementById('agent-crumb').textContent==='Agent Target'");
      await page.evaluate("document.getElementById('run-crumb').click();document.getElementById('timeline-tab').click()");
      await waitFor(page, "document.querySelectorAll('#semantic-map-host iframe').length===0");
      const requestsWhenClosed = httpRequests.length;
      await delay(350);
      assert.equal(httpRequests.length, requestsWhenClosed, "closing the live map produces no later map-asset HTTP request");
      assert.deepEqual(httpRequests.map((request) => request.path).slice(0, 3).sort(), ["/semantic-map.css", "/semantic-map.html", "/semantic-map.js"]);
      assert.equal(httpRequests.length, 3, "scope and publisher generation updates reuse the active map without extra asset fetches");
      assert.ok(httpRequests.every((request) => request.method === "GET" && request.status === 200 && (request.bytes ?? 0) > 0), JSON.stringify(httpRequests));
      const rawAssetBytes = httpRequests.reduce((total, request) => total + (request.bytes ?? 0), 0);
      const expectedAssetBytes = ["semantic-map.html", "semantic-map.js", "semantic-map.css"].reduce((total, name) => total + readFileSync(new URL(`../src/assets/${name}`, import.meta.url)).byteLength, 0);
      assert.equal(rawAssetBytes, expectedAssetBytes, "observed uncompressed HTTP body bytes match the served raw asset files");
      const mapUrls = browserUrls.filter((url) => url.includes("/semantic-map."));
      assert.ok(mapUrls.every((url) => url.startsWith(base)), "the child makes no external request");
      assert.equal(socketConnections.filter((connection) => connection.origin === base).length, 1, "the parent UI creates exactly one real WebSocket; viewer adds none");
      assert.equal(socketConnections.length, 3, "the only other connections are the initial and replacement live publishers");
      assert.ok(socketConnections.every((connection) => connection.path === "/ws"));
      assert.deepEqual(cspErrors, [], cspErrors.join("\n"));
      t.diagnostic(`Live map: tab-to-ready=${firstReadyMs.toFixed(1)} ms; raw HTTP asset bytes=${String(rawAssetBytes)}; requests=${JSON.stringify(httpRequests.map(({ path }) => path))}; external/CSP/console errors=0; map requests after close=0.`);
    });
  } finally {
    publisher.close(); replacement?.close();
    server.closeAllConnections(); server.closeIdleConnections(); server.close(); server.unref();
    rmSync(root, { recursive: true, force: true });
  }
});

void test("Trajectory Semantic Map closes and reopens cleanly for 50 live browser cycles with controlled GC measurements", { skip: !browserPath, timeout: 240_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "trajectory-semantic-map-soak-"));
  const port = await availableLoopbackPort();
  const publisherId = "e4soakpublisher";
  const run = semanticRun("soak-run", "E4 live lifecycle soak", [semanticAgent("soak-agent", "Soak Agent")]);
  const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { fingerprint: "e4-semantic-map-soak" });
  const mapRequests: string[] = [];
  server.on("request", (request) => { const pathname = new URL(request.url ?? "/", `http://127.0.0.1:${String(port)}`).pathname; if (pathname.startsWith("/semantic-map.")) mapRequests.push(pathname); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const publisher = await connectLivePublisher(port, publisherId);
  publisher.send(publisherState(publisherId, [run]));
  const base = `http://127.0.0.1:${String(port)}`;
  const samples: { cycle: number; usedSize: number; totalSize: number; resourceEntries: number }[] = [];
  const iframeHeapSamples: { cycle: number; usedSize: number; totalSize: number }[] = [];
  const iframeTargets = new Set<string>();
  try {
    await withChrome(`${base}/?view=run&run=${encodeURIComponent(`${publisherId}:soak-run`)}`, async (page, browser) => {
      await waitFor(page, "Boolean(document.querySelector('.workflow-head'))");
      await page.command("Network.enable"); await page.command("HeapProfiler.enable"); await page.command("Runtime.enable");
      await browser.command("Target.setDiscoverTargets", { discover: true });
      const closedFrameRequests: number[] = [];
      const requestsPerCycle: string[][] = [];
      const beforePreReadyClose = mapRequests.length;
      await page.evaluate("document.getElementById('semantic-map-tab').click();document.getElementById('timeline-tab').click()");
      await waitFor(page, "document.querySelectorAll('#semantic-map-host iframe').length===0");
      const requestsAtPreReadyClose = mapRequests.length;
      await delay(150);
      assert.equal(mapRequests.length, requestsAtPreReadyClose, "closing before iframe readiness cannot initiate later asset requests");
      const cycle = async (measureIframe = false, cycleNumber = 0): Promise<void> => {
        const requestStart = mapRequests.length;
        await page.evaluate("document.getElementById('semantic-map-tab').click()");
        await waitFor(page, "document.querySelector('#semantic-map-host iframe') && document.getElementById('semantic-map-status').textContent.startsWith('Partial graph')");
        assert.equal(await page.evaluate("document.querySelectorAll('#semantic-map-host iframe').length"), 1);
        if (measureIframe) {
          const heap = await semanticMapHeap(browser);
          if (heap) { iframeTargets.add(heap.targetId); iframeHeapSamples.push({ cycle: cycleNumber, usedSize: heap.usedSize, totalSize: heap.totalSize }); }
        }
        await page.evaluate("document.getElementById('timeline-tab').click()");
        await waitFor(page, "document.querySelectorAll('#semantic-map-host iframe').length===0");
        const countAtClose = mapRequests.length;
        await delay(35);
        assert.equal(mapRequests.length, countAtClose, "closing an acknowledged viewer leaves no later asset request");
        closedFrameRequests.push(countAtClose);
        requestsPerCycle.push(mapRequests.slice(requestStart, countAtClose));
      };
      const warmupCycles = 10;
      const requestsBeforeWarmup = mapRequests.length;
      for (let warmup = 0; warmup < warmupCycles; warmup += 1) await cycle();
      await page.command("HeapProfiler.collectGarbage");
      const baselineResponse = await page.command("Runtime.getHeapUsage");
      const baseline = baselineResponse.result as CdpRecord | undefined;
      assert.ok(typeof baseline?.usedSize === "number" && typeof baseline.totalSize === "number");
      samples.push({ cycle: 0, usedSize: baseline.usedSize, totalSize: baseline.totalSize, resourceEntries: Number(await page.evaluate("performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/semantic-map.')).length")) });
      for (let completed = 1; completed <= 50; completed += 1) {
        await cycle(completed % 10 === 0, completed);
        if (completed % 10 === 0) {
          await page.command("HeapProfiler.collectGarbage");
          const measured = await page.command("Runtime.getHeapUsage");
          const heap = measured.result as CdpRecord | undefined;
          assert.ok(typeof heap?.usedSize === "number" && typeof heap.totalSize === "number");
          samples.push({ cycle: completed, usedSize: heap.usedSize, totalSize: heap.totalSize, resourceEntries: Number(await page.evaluate("performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/semantic-map.')).length")) });
        }
      }
      assert.equal(await page.evaluate("document.querySelectorAll('#semantic-map-host iframe').length"), 0);
      const postWarmupRequests = mapRequests.length - requestsBeforeWarmup;
      assert.ok(postWarmupRequests >= (warmupCycles + 50) * 3, "each completed open serves all three local assets");
      const allowedAssets = new Set(["/semantic-map.html", "/semantic-map.js", "/semantic-map.css"]);
      for (const [index, cycleRequests] of requestsPerCycle.entries()) {
        assert.ok(cycleRequests.length >= 3, `cycle ${String(index + 1)} served its three assets`);
        assert.deepEqual(new Set(cycleRequests), allowedAssets, `cycle ${String(index + 1)} requested only the three local viewer routes`);
      }
      assert.ok(closedFrameRequests.length === warmupCycles + 50 && closedFrameRequests.every((count, index) => count >= requestsBeforeWarmup + (index + 1) * 3));
      const duplicateRequests = requestsPerCycle.flatMap((cycleRequests, index) => [...allowedAssets].flatMap((path) => { const count = cycleRequests.filter((request) => request === path).length; return count > 1 ? [{ cycle: index + 1, path, count }] : []; }));
      let activeSemanticTargets = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const targetInfos = ((await browser.command("Target.getTargets")).result as CdpRecord | undefined)?.targetInfos;
        activeSemanticTargets = Array.isArray(targetInfos) ? targetInfos.map((target) => target as CdpRecord).filter((target) => typeof target.url === "string" && target.url.includes("/semantic-map.html")).length : 0;
        if (activeSemanticTargets === 0) break;
        await delay(20);
      }
      assert.equal(activeSemanticTargets, 0, "no separately targeted Semantic Map iframe remains after close");
      t.diagnostic(`Lifecycle soak: warmup=${String(warmupCycles)}; measuredCycles=50; finalFrames=0; preReadyCloseRequests=${String(requestsAtPreReadyClose - beforePreReadyClose)}; postWarmupRequests=${String(postWarmupRequests)}; duplicate routes during open=${JSON.stringify(duplicateRequests)}; separately measured iframe targets=${String(iframeTargets.size)}, activeTargetsAfterClose=${String(activeSemanticTargets)}; topTargetGC=${JSON.stringify(samples)}; iframeGC=${JSON.stringify(iframeHeapSamples)}; heap budget remains diagnostic pending ratification.`);
    });
  } finally {
    publisher.close();
    server.closeAllConnections(); server.closeIdleConnections(); server.close(); server.unref();
    rmSync(root, { recursive: true, force: true });
  }
});

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
/**
 * Lays out the bundled server with its parent shell, libraries and canonical viewer assets like the installed package.
 * With `stamp`, every file and the server's manifest are consistently re-stamped: a coherent build B of the same code.
 */
function installServerBuild(root: string, stamp?: string): string {
  const parentAssets = join(root, "trajectory", "src", "assets"), viewerAssets = join(root, "trajectory", "assets");
  mkdirSync(parentAssets, { recursive: true }); mkdirSync(viewerAssets, { recursive: true });
  let server = readFileSync(new URL("../src/server.js", import.meta.url), "utf8");
  const copy = (from: URL, to: string, restamp: boolean): void => {
    const original = readFileSync(from);
    if (!stamp || !restamp) { writeFileSync(to, original); return; }
    const bytes = Buffer.from(original.toString("utf8").replaceAll(SEMANTIC_MAP_BUILD_STAMP, stamp), "utf8");
    assert.equal(bytes.byteLength, original.byteLength, "re-stamping keeps each asset size");
    assert.equal(server.split(sha256(original)).length, 2, "the server manifest names each asset digest once");
    server = server.replace(sha256(original), sha256(bytes));
    writeFileSync(to, bytes);
  };
  for (const name of ["marked.min.js", "morphdom.min.js", "prism.min.js", "favicon.png"]) copy(new URL(`../src/assets/${name}`, import.meta.url), join(parentAssets, name), false);
  copy(new URL("../src/assets/index.html", import.meta.url), join(parentAssets, "index.html"), true);
  for (const name of ["semantic-map.html", "semantic-map.js", "semantic-map.css"]) copy(new URL(`../assets/${name}`, import.meta.url), join(viewerAssets, name), true);
  if (stamp) {
    assert.equal(server.split(`"${SEMANTIC_MAP_BUILD_STAMP}"`).length, 2, "the server bundles one build stamp");
    server = server.replace(`"${SEMANTIC_MAP_BUILD_STAMP}"`, `"${stamp}"`);
  }
  const serverPath = join(root, "trajectory", "src", "server.js");
  writeFileSync(serverPath, server);
  return serverPath;
}
async function startOwnedServer(serverPath: string, port: number, lock: string, fingerprint: string): Promise<ChildProcess> {
  const child = spawn(process.execPath, [serverPath, "--port", String(port), "--lock", lock, "--fingerprint", fingerprint], { stdio: "ignore", windowsHide: true });
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const health = await (await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(300) })).json() as { pid?: unknown; fingerprint?: unknown };
      if (health.pid === child.pid && health.fingerprint === fingerprint) return child;
    } catch { /* The owned server is still starting. */ }
    await delay(25);
  }
  child.kill();
  throw new Error(`Owned Trajectory test server ${fingerprint} did not start`);
}
/** Stops only a server this test spawned, through its own process handle. */
async function stopOwnedServer(child: ChildProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => { child.once("exit", () => { resolve(); }); });
  child.kill();
  await Promise.race([exited, delay(5000)]);
}

void test("Trajectory Semantic Map tab upgrade across real server builds fails visibly, never auto-reopens, and recovers explicitly", { skip: !browserPath, timeout: 240_000 }, async (t) => {
  const rootA = mkdtempSync(join(tmpdir(), "trajectory-map-build-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "trajectory-map-build-b-"));
  const stampB = "b0b1b2b3b4b5b6b7";
  assert.notEqual(stampB, SEMANTIC_MAP_BUILD_STAMP);
  const serverA = installServerBuild(rootA);
  const serverB = installServerBuild(rootB, stampB);
  const port = await availableLoopbackPort();
  const base = `http://127.0.0.1:${String(port)}`;
  const publisherId = "w4bridgeupgrade";
  const run = semanticRun("upgrade-run", "W4 bridge tab upgrade", [semanticAgent("upgrade-agent", "Upgrade Agent")]);
  const completedRun = semanticRun("upgrade-run", "W4 bridge tab upgrade", [semanticAgent("upgrade-agent", "Upgrade Agent", "completed")]);
  let owned: ChildProcess | undefined;
  let publisher: WebSocket | undefined;
  const timings: Record<string, number> = {};
  try {
    owned = await startOwnedServer(serverA, port, join(rootA, "trajectory.lock"), "w4-bridge-build-a");
    publisher = await connectLivePublisher(port, publisherId);
    publisher.send(publisherState(publisherId, [run]));
    await withChrome(`${base}/?view=run&run=${encodeURIComponent(`${publisherId}:upgrade-run`)}`, async (page) => {
      await waitFor(page, "Boolean(document.querySelector('.workflow-head')) && document.body.dataset.view==='run'");
      assert.equal(await page.evaluate("document.querySelector('meta[name=semantic-map-build]').content"), SEMANTIC_MAP_BUILD_STAMP);
      await page.evaluate("document.getElementById('semantic-map-tab').click()");
      await waitFor(page, "document.getElementById('semantic-map-status').textContent.startsWith('Partial graph')");

      // In-place update while the tab is open: the loaded viewer keeps working; a reopen gets 503 and fails visibly.
      const viewerJs = join(rootA, "trajectory", "assets", "semantic-map.js");
      const originalJs = readFileSync(viewerJs);
      const replacedJs = Buffer.from(originalJs);
      replacedJs[replacedJs.length - 2] = replacedJs[replacedJs.length - 2] === 0x3b ? 0x20 : 0x3b;
      writeFileSync(viewerJs, replacedJs);
      publisher?.send(publisherState(publisherId, [completedRun]));
      await delay(400);
      assert.ok(String(await page.evaluate("document.getElementById('semantic-map-status').textContent")).startsWith("Partial graph"), "the already loaded viewer keeps following live state");
      assert.equal((await fetch(`${base}/semantic-map.js?v=${SEMANTIC_MAP_BUILD_STAMP}`)).status, 503, "server A refuses its replaced viewer bytes");
      await page.evaluate("document.getElementById('timeline-tab').click();document.getElementById('semantic-map-tab').click()");
      let started = Date.now();
      await waitLong(page, "/did not complete its secure handshake|assets could not load/.test(document.getElementById('semantic-map-status').textContent)", 15_000);
      timings.inPlaceFailureMs = Date.now() - started;
      assert.equal(await page.evaluate("document.querySelectorAll('#semantic-map-host iframe').length"), 0);
      assert.equal(await page.evaluate("document.getElementById('semantic-map-retry').hidden"), false);
      publisher?.send(publisherState(publisherId, [run]));
      await delay(600);
      assert.equal(await page.evaluate("document.querySelectorAll('#semantic-map-host iframe').length"), 0, "live state does not reopen the failed map");
      writeFileSync(viewerJs, originalJs);
      await page.evaluate("document.getElementById('semantic-map-retry').click()");
      await waitFor(page, "document.getElementById('semantic-map-status').textContent.startsWith('Partial graph')");

      // Upgrade: the owned server A stops and a coherent build B takes the port while the old tab stays open.
      await stopOwnedServer(owned);
      publisher?.close();
      owned = await startOwnedServer(serverB, port, join(rootB, "trajectory.lock"), "w4-bridge-build-b");
      publisher = await connectLivePublisher(port, publisherId);
      publisher.send(publisherState(publisherId, [run]));
      assert.equal((await fetch(`${base}/semantic-map.html?v=${SEMANTIC_MAP_BUILD_STAMP}&embed=1&theme=dark`)).status, 404, "server B never serves the old build's URL");
      assert.equal((await fetch(`${base}/semantic-map.html?v=${stampB}&embed=1&theme=dark`)).status, 200);
      await waitLong(page, "Boolean(document.querySelector('.workflow-head')) && document.querySelector('#sidebar [data-run]')", 10_000);
      assert.equal(await page.evaluate("document.querySelector('meta[name=semantic-map-build]').content"), SEMANTIC_MAP_BUILD_STAMP, "the open tab still runs parent A");
      await page.evaluate("document.getElementById('timeline-tab').click();document.getElementById('semantic-map-tab').click()");
      started = Date.now();
      await waitLong(page, "/did not complete its secure handshake|assets could not load/.test(document.getElementById('semantic-map-status').textContent)", 15_000);
      timings.staleParentFailureMs = Date.now() - started;
      assert.equal(await page.evaluate("document.querySelectorAll('#semantic-map-host iframe').length"), 0, "parent A never embeds build B's viewer");
      // Retry is explicit and honest: the stale parent keeps failing instead of silently loading other bytes.
      await page.evaluate("document.getElementById('semantic-map-retry').click()");
      await waitFor(page, "document.getElementById('semantic-map-retry').hidden===true");
      await waitLong(page, "document.getElementById('semantic-map-retry').hidden===false && /did not complete its secure handshake|assets could not load/.test(document.getElementById('semantic-map-status').textContent)", 15_000);
      // Explicit reload upgrades the tab to parent B, whose map works with build B.
      await page.command("Page.reload", { ignoreCache: true });
      await waitLong(page, "document.readyState==='complete' && document.querySelector('meta[name=semantic-map-build]')?.content===" + JSON.stringify(stampB) + " && Boolean(document.querySelector('.workflow-head'))", 10_000);
      await page.evaluate("document.getElementById('semantic-map-tab').click()");
      await waitFor(page, "document.getElementById('semantic-map-status').textContent.startsWith('Partial graph')");
      assert.equal(await page.evaluate(`[...document.querySelectorAll('#semantic-map-host iframe')].every(frame=>frame.src.includes('v=${stampB}'))`), true);
      await page.evaluate("document.getElementById('timeline-tab').click()");
      await waitFor(page, "document.querySelectorAll('#semantic-map-host iframe').length===0");
    });
    t.diagnostic(`Tab upgrade: in-place replaced viewer failure visible after ${String(timings.inPlaceFailureMs)} ms; stale parent A against server B failure visible after ${String(timings.staleParentFailureMs)} ms; recovery by explicit Retry (A) and explicit reload (B).`);
  } finally {
    publisher?.close();
    await stopOwnedServer(owned);
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});
