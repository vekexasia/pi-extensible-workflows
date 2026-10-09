import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { exportTrajectoryRunHtml } from "../index.js";
import { createTrajectoryServer } from "../src/server.js";
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
  const candidates = [process.env.PI_TRAJECTORY_CHROME, "/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"];
  try {
    for (const version of readdirSync(join(homedir(), ".cache", "ms-playwright"))) candidates.push(join(homedir(), ".cache", "ms-playwright", version, "chrome-linux64", "chrome"));
  } catch { /* The browser cache is optional. */ }
  for (const name of ["chromium", "google-chrome", "chromium-browser"]) {
    try { candidates.push(execFileSync("which", [name], { encoding: "utf8" }).trim()); } catch { /* Try the next browser location. */ }
  }
  const found = candidates.find((candidate) => typeof candidate === "string" && Boolean(candidate) && existsSync(candidate));
  return typeof found === "string" ? found : undefined;
}

// Bounds Chrome startup and every DevTools round trip, so a stalled browser fails with its state instead of hanging until the test timeout.
const DEVTOOLS_WAIT_MS = 30_000;
class Devtools {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (message: CdpMessage) => void; reject: (error: Error) => void }>();
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      let message: CdpMessage;
      try { message = JSON.parse(String(event.data)) as CdpMessage; } catch { return; }
      if (typeof message.id !== "number") return;
      const request = this.pending.get(message.id);
      if (!request) return;
      this.pending.delete(message.id);
      request.resolve(message);
    });
  }
  command(method: string, params: CdpRecord = {}): Promise<CdpMessage> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Chrome DevTools ${method} did not answer within ${String(DEVTOOLS_WAIT_MS)} ms`)); }, DEVTOOLS_WAIT_MS);
      this.pending.set(id, { resolve: (message) => { clearTimeout(timer); resolve(message); }, reject: (error) => { clearTimeout(timer); reject(error); } });
    });
  }
  async evaluate(expression: string): Promise<unknown> {
    const message = await this.command("Runtime.evaluate", { expression, returnByValue: true });
    if (message.error) throw new Error(textValue((message.error as CdpRecord).message, "Chrome evaluation failed"));
    const result = message.result as CdpRecord | undefined;
    const exception = result?.exceptionDetails as CdpRecord | undefined;
    if (exception) throw new Error(textValue(exception.description, textValue(exception.text, "Chrome evaluation failed")));
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
    const timer = setTimeout(() => { socket.close(); reject(new Error(`Chrome DevTools connection did not open within ${String(DEVTOOLS_WAIT_MS)} ms`)); }, DEVTOOLS_WAIT_MS);
    socket.addEventListener("open", () => { clearTimeout(timer); resolve(); });
    socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Chrome DevTools connection failed")); });
  });
  return new Devtools(socket);
}

// Chrome picks its own DevTools port and announces it on stderr, so no port is reserved and released before Chrome binds it.
async function waitForDevtools(child: ReturnType<typeof spawn>, stderr: () => string): Promise<string> {
  const startedAt = Date.now();
  let endpoint: string | undefined;
  const failure = (reason: string): Error => new Error(`Chrome ${reason} after ${String(Date.now() - startedAt)} ms (pid ${String(child.pid)}, exit code ${String(child.exitCode)}, signal ${String(child.signalCode)}, DevTools endpoint ${endpoint ?? "not announced"})${stderr() ? `: ${stderr().trim()}` : ""}`);
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) throw failure("exited before DevTools started");
    endpoint ??= /DevTools listening on (ws:\/\/\S+)/.exec(stderr())?.[1];
    if (endpoint !== undefined) {
      try {
        const response = await fetch(`http://${new URL(endpoint).host}/json`, { signal: AbortSignal.timeout(Math.max(1, DEVTOOLS_WAIT_MS - (Date.now() - startedAt))) });
        const pages = await response.json() as Array<{ type?: unknown; webSocketDebuggerUrl?: unknown }>;
        const page = pages.find((candidate) => candidate.type === "page" && typeof candidate.webSocketDebuggerUrl === "string");
        const websocketUrl = page?.webSocketDebuggerUrl;
        if (typeof websocketUrl === "string") return websocketUrl;
      } catch { /* The page target is not listed yet. */ }
    }
    if (Date.now() - startedAt >= DEVTOOLS_WAIT_MS) throw failure("DevTools did not start");
    await delay(50);
  }
}

async function serve(routes: ReadonlyMap<string, RouteBody>): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const path = new URL(request.url || "/", "http://127.0.0.1").pathname;
    const body = routes.get(path);
    if (body === undefined) { response.writeHead(404); response.end(); return; }
    response.writeHead(200, { "content-type": path.endsWith(".js") ? "text/javascript" : "text/html" });
    response.end(body);
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${String(address.port)}`, close: () => new Promise<void>((resolve, reject) => { server.close((error) => { if (error) reject(error); else resolve(); }); }) };
}

async function withChrome(url: string, signal: AbortSignal, callback: (page: Devtools) => Promise<void>): Promise<void> {
  const browser = findBrowser();
  assert.ok(browser, "Chromium is required for Trajectory browser verification");
  const profile = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-chrome-"));
  const child = spawn(browser, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, url], { stdio: ["ignore", "ignore", "pipe"] });
  const stderr: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr.push(chunk); });
  const childExited = new Promise<void>((resolve) => { child.once("close", () => { resolve(); }); });
  // A test timeout abandons this function without running its cleanup, so the browser is killed from the test's signal.
  const killOnAbort = (): void => { child.kill("SIGKILL"); };
  signal.addEventListener("abort", killOnAbort, { once: true });
  let page: Devtools | undefined;
  try {
    page = await connectDevtools(await waitForDevtools(child, () => stderr.join("")));
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (await page.evaluate("document.readyState === 'complete'")) break;
      await delay(25);
    }
    await callback(page);
  } finally {
    signal.removeEventListener("abort", killOnAbort);
    page?.close();
    child.kill("SIGTERM");
    await Promise.race([childExited, delay(2000)]);
    // A browser stuck in startup can ignore SIGTERM; it must not outlive the test.
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await Promise.race([childExited, delay(2000)]); }
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { rmSync(profile, { recursive: true, force: true }); break; } catch { await delay(50); }
    }
  }
}

function makeState(output: Record<string, unknown>, state: "running" | "completed"): Record<string, unknown> {
  const agent = { id: "agent", name: "fixture-agent", label: "fixture-agent", state, attempts: 1, startedAt: 1, durationMs: state === "completed" ? 10 : undefined, model: { provider: "fixture", model: "model" }, requestedModel: "fixture/request", tools: ["read"], skills: ["review"], extensions: ["fixture"], prompt: "Inspect the fixture", systemPrompt: "System prompt", output, attemptDetails: [{ attempt: 1, transport: "local", setup: { cwd: "/project", model: { provider: "fixture", model: "model" }, tools: ["read"] } }] };
  const run = { id: "run", workflowName: "fixture", cwd: "/project", sessionId: "session", state, agents: [agent], transcripts: { agent: [{ type: "message", timestamp: "2025-01-01T00:00:00.000Z", message: { role: "assistant", content: [{ type: "text", text: "transcript" }] } }] }, snapshot: { script: "return true;" } };
  return { type: "state", publishers: [{ id: "publisher", title: "fixture", cwd: "/project", sessionId: "session", connected: true, runs: [{ run }], subagents: [] }], updatedAt: 1 };
}

function clickExpression(selector: string): string { return `document.querySelector(${JSON.stringify(selector)}).click()`; }
function outputTabClickExpression(): string { return "Array.from(document.querySelectorAll('#sys-tabs span')).find((tab) => tab.dataset.pane === 'output').click()"; }

const browserPath = findBrowser();
void test("Trajectory static export opens Agent details and its Output tab in Chromium", { skip: !browserPath, timeout: 120_000 }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-browser-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const sessionFile = join(root, "session.jsonl");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "transcript" }] } })}\n`);
  const store = new RunStore(cwd, "session", "run", home);
  const model = { provider: "fixture", model: "model" };
  const run = { id: "run", workflowName: "fixture", cwd, sessionId: "session", state: "completed", agentSessions: [], agents: [{ id: "agent", name: "fixture-agent", path: "agent", state: "completed", resultPath: "agent/call:1", attempts: 1, model, requestedModel: "fixture/request", tools: ["read"], attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: "native", locator: { sessionFile } }, setup: { cwd, hookNames: [], model, tools: ["read"] }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }] } as unknown as PersistedRun;
  try {
    await store.create(run, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "fixture" }, settings: { concurrency: 1 }, models: ["fixture/model"], tools: [], agentConfigurations: {}, schemas: [] }));
    await store.complete("agent/call:1", { answer: false });
    const html = await exportTrajectoryRunHtml({ cwd, sessionId: "session", runId: "run", home });
    const server = await serve(new Map([["/report.html", html]]));
    try {
      await withChrome(`${server.url}/report.html`, t.signal, async (page) => {
        await waitFor(page, "Boolean(document.querySelector('.agent-grid-row'))");
        assert.doesNotMatch(String(await page.evaluate("document.querySelector('.agent-grid-head').textContent")), /ROLE/);
        assert.equal(await page.evaluate("document.querySelector('.agent-grid-row').children.length"), 6);
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

void test("Trajectory Chromium view preserves the selected Output tab across live publisher updates", { skip: !browserPath, timeout: 120_000 }, async (t) => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const marked = readFileSync(new URL("../src/assets/marked.min.js", import.meta.url));
  const morphdom = readFileSync(new URL("../src/assets/morphdom.min.js", import.meta.url));
  const bootstrap = `<script>(function(){class FakeSocket{constructor(){this.readyState=1;this.listeners={};window.__trajectorySocket=this;}addEventListener(type,listener){(this.listeners[type] ||= []).push(listener);}send(){}close(){}emit(type,data){for(const listener of this.listeners[type] || []) listener({data});}}window.WebSocket=FakeSocket;})();</script>`;
  const html = source.replace("  <script>\n    const defaultRunLayout", `  ${bootstrap}\n  <script>\n    const defaultRunLayout`);
  assert.notEqual(html, source);
  const server = await serve(new Map<string, RouteBody>([["/index.html", html], ["/marked.min.js", marked], ["/morphdom.min.js", morphdom]]));
  try {
    await withChrome(`${server.url}/index.html`, t.signal, async (page) => {
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

void test("Trajectory live gantt keeps cached timing, merges dense calls, and pauses while hidden", { skip: !browserPath, timeout: 120_000 }, async (t) => {
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
    await withChrome(`http://127.0.0.1:${String(port)}/?view=run&run=${publisherId}:live`, t.signal, async (page) => {
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

void test("Trajectory keeps a subagent transcript when a refresh races a newer revision", { skip: !browserPath, timeout: 120_000 }, async (t) => {
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
  const publish = () => { publisher.send(JSON.stringify({ type: "publisher:state", publisher: { id: publisherId, title: "stale", cwd: "/project", sessionId: "session", connected: true }, runs: [], subagents: [{ id: subagentId, label: "live-sub", state: "running", startedAt: 1_000, model: { provider: "fixture", model: "model" }, request: { prompt: "go", model: "fixture/model" }, attempts: 1, transcript: { revision, status: "available", timing: [] } }] })); };
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
    await withChrome(`http://127.0.0.1:${String(port)}/?view=subagent&subagent=${publisherId}:${subagentId}`, t.signal, async (page) => {
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
