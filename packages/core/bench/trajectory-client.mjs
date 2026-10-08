// Bench for Trajectory browser CPU: serves a synthetic live run, drives the real
// server and page in headless Chromium, and reports a CPU profile by self time.
// Run with: node packages/core/bench/trajectory-client.mjs
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { createTrajectoryServer } from "../dist/trajectory/src/server.js";

const RUNS = Number(process.env.BENCH_RUNS ?? 1);
const AGENTS = Number(process.env.BENCH_AGENTS ?? 12);
const TIMINGS = Number(process.env.BENCH_TIMINGS ?? 120);
const LOGS = Number(process.env.BENCH_LOGS ?? 120);
const SECONDS = Number(process.env.BENCH_SECONDS ?? 20);
const VIEW = process.env.BENCH_VIEW ?? "run";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const startedAt = Date.now() - 600_000;

function agentRecord(index, live) {
  const running = live && index >= AGENTS - 2;
  return {
    id: `run:${index}`,
    name: `agent-${index}`,
    label: `worker ${index}`,
    path: `run:${index}`,
    role: index % 3 === 0 ? "developer" : "reviewer",
    state: running ? "running" : "completed",
    model: { provider: "anthropic", model: "claude-sonnet-4-5", thinking: "medium" },
    tools: ["read", "write", "edit", "bash", "grep", "find", "ls", "agent", "shell", "workflow"],
    attempts: 1,
    startedAt: startedAt + index * 1000,
    durationMs: running ? undefined : 120_000 + index * 1000,
    lastEventAt: running ? Date.now() : startedAt + index * 1000 + 500,
    accounting: { input: 120_000 + index, output: 8_000, cacheRead: 400_000, cacheWrite: 30_000, cost: 1.25 },
    systemPrompt: `You are agent ${index}.\n`.repeat(40),
    toolCalls: [{ id: `call-${index}`, name: "read", state: running ? "running" : "completed" }],
    attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: `session-${index}`, locator: { sessionFile: `/sessions/${index}.jsonl` } }, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.1 } }],
    output: { status: "available", value: `result ${index}`, bytes: 64 },
  };
}

function timingEntries(agentIndex, extra) {
  const entries = [];
  for (let index = 0; index < TIMINGS + extra; index += 1) {
    const start = startedAt + agentIndex * 1000 + index * 700;
    entries.push({ type: "custom", customType: "pi-workflows:tool-timing", data: { toolCallId: `call-${String(agentIndex)}-${String(index)}`, toolName: index % 3 === 0 ? "bash" : "read", startedAt: start, completedAt: start + 450, durationMs: 450, isError: index % 17 === 0 } });
  }
  return entries;
}

function runMetadata(tick, runIndex = 0) {
  const live = runIndex === 0;
  const agents = Array.from({ length: AGENTS }, (_, index) => agentRecord(index, live));
  const transcripts = {};
  // Only the live run's running agents accumulate new tool timings, the way a real session behaves.
  for (let index = 0; index < AGENTS; index += 1) transcripts[`run:${index}`] = { revision: 1000 + (live && index >= AGENTS - 2 ? tick : 0), status: "available", bytes: 120_000, timing: timingEntries(index, live && index >= AGENTS - 2 ? tick : 0) };
  const events = Array.from({ length: LOGS }, (_, index) => ({ type: "log", timestamp: new Date(startedAt + index * 2000).toISOString(), message: `phase ${String(index)} progressed with a reasonably long log line` }));
  return {
    run: {
      id: runIndex === 0 ? "bench-run" : `bench-run-${String(runIndex)}`, workflowName: `bench-workflow-${String(runIndex)}`, cwd: "/repo", sessionId: "bench-session", state: live ? "running" : "completed",
      phase: "work", agents, agentSessions: [], events,
      usage: { tokens: 1_500_000, costUsd: 12.5, durationMs: live ? Date.now() - startedAt : 600_000, agentLaunches: AGENTS },
      budget: { tokens: { hard: 10_000_000 }, costUsd: { hard: 100 } },
      phaseHistory: [{ phase: "plan", afterAgent: 0 }, { phase: "work", afterAgent: 2 }],
    },
    snapshot: { script: "return await parallel('batch', {});\n".repeat(30), args: null, metadata: { name: "bench-workflow" }, models: ["anthropic/claude-sonnet-4-5"], tools: ["read"], agentConfigurations: {}, schemas: [] },
    awaiting: [],
    createdAt: new Date(startedAt).toISOString(),
    transcripts,
  };
}

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function findBrowser() {
  const candidates = [process.env.PI_TRAJECTORY_CHROME, "/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chromium-browser"];
  try {
    for (const version of readdirSync(join(homedir(), ".cache", "ms-playwright"))) candidates.push(join(homedir(), ".cache", "ms-playwright", version, "chrome-linux64", "chrome"));
  } catch { /* optional */ }
  for (const name of ["chromium", "google-chrome", "chromium-browser"]) {
    try { candidates.push(execFileSync("which", [name], { encoding: "utf8" }).trim()); } catch { /* optional */ }
  }
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

class Devtools {
  #next = 1;
  #pending = new Map();
  constructor(socket) {
    this.socket = socket;
    socket.addEventListener("message", (event) => {
      let message;
      try { message = JSON.parse(String(event.data)); } catch { return; }
      if (typeof message.id !== "number") return;
      const request = this.#pending.get(message.id);
      if (!request) return;
      this.#pending.delete(message.id);
      request(message);
    });
  }
  command(method, params = {}) {
    const id = this.#next++;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve) => this.#pending.set(id, resolve));
  }
  async evaluate(expression) {
    const message = await this.command("Runtime.evaluate", { expression, returnByValue: true });
    return message.result?.result?.value;
  }
}

async function devtoolsUrl(port) {
  for (let attempt = 0; attempt < 600; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${String(port)}/json`)).json();
      const page = pages.find((candidate) => candidate.type === "page" && typeof candidate.webSocketDebuggerUrl === "string");
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* still starting */ }
    await delay(50);
  }
  throw new Error("Chrome DevTools did not start");
}

function summarize(profile) {
  const byId = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  let total = 0;
  for (let index = 0; index < profile.samples.length; index += 1) {
    const delta = profile.timeDeltas[index] ?? 0;
    if (delta <= 0) continue;
    total += delta;
    const node = byId.get(profile.samples[index]);
    if (!node) continue;
    const frame = node.callFrame;
    const name = `${frame.functionName || "(anonymous)"} ${frame.url.split("/").pop() || ""}:${String(frame.lineNumber + 1)}`;
    self.set(name, (self.get(name) ?? 0) + delta);
  }
  const ranked = [...self.entries()].sort((left, right) => right[1] - left[1]).slice(0, 20);
  // Inclusive time per function: sum self time of every node whose ancestor chain contains it.
  const parents = new Map();
  for (const node of profile.nodes) for (const child of node.children ?? []) parents.set(child, node.id);
  const selfById = new Map();
  for (let index = 0; index < profile.samples.length; index += 1) {
    const delta = profile.timeDeltas[index] ?? 0;
    if (delta > 0) selfById.set(profile.samples[index], (selfById.get(profile.samples[index]) ?? 0) + delta);
  }
  const inclusive = new Map();
  for (const [id, micros] of selfById) {
    const seen = new Set();
    for (let current = id; current !== undefined; current = parents.get(current)) {
      const node = byId.get(current);
      if (!node) break;
      const name = node.callFrame.functionName || "(anonymous)";
      if (!seen.has(name)) { inclusive.set(name, (inclusive.get(name) ?? 0) + micros); seen.add(name); }
    }
  }
  const inclusiveRanked = [...inclusive.entries()].filter(([name]) => !name.startsWith("(")).sort((left, right) => right[1] - left[1]).slice(0, 12);
  return {
    totalMs: total / 1000,
    ranked: ranked.map(([name, micros]) => ({ name, ms: Number((micros / 1000).toFixed(1)), percent: Number((micros / total * 100).toFixed(1)) })),
    inclusive: inclusiveRanked.map(([name, micros]) => ({ name, ms: Number((micros / 1000).toFixed(1)) })),
  };
}

const port = await availablePort();
const lockPath = join(mkdtempSync(join(tmpdir(), "pi-workflows-traj-bench-")), "lock.json");
const server = createTrajectoryServer(port, lockPath);
await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });

const publisher = new WebSocket(`ws://127.0.0.1:${String(port)}/ws`);
await new Promise((resolve) => publisher.addEventListener("open", resolve, { once: true }));
const publisherId = "benchpublisher01";
publisher.send(JSON.stringify({ type: "publisher:attach", publisherId }));
let tick = 0;
let frameBytes = 0;
const sendState = () => {
  const frame = JSON.stringify({
    type: "publisher:state",
    publisher: { id: publisherId, title: "bench session", cwd: "/repo", sessionId: "bench-session", connected: true },
    runs: Array.from({ length: RUNS }, (_, index) => runMetadata(tick, index)),
    subagents: [],
  });
  frameBytes = Buffer.byteLength(frame);
  publisher.send(frame);
  tick += 1;
};
sendState();

const browser = findBrowser();
if (!browser) throw new Error("Chromium is required");
const debugPort = await availablePort();
const profileDir = mkdtempSync(join(tmpdir(), "pi-workflows-traj-chrome-"));
const focusRun = process.env.BENCH_FOCUS_RUN ?? "bench-run";
const url = `http://127.0.0.1:${String(port)}/?view=${VIEW}&run=${publisherId}:${focusRun}${VIEW === "run" ? "" : "&agent=run:0"}`;
const child = spawn(browser, ["--headless=new", "--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--window-size=1600,1000", `--remote-debugging-port=${String(debugPort)}`, `--user-data-dir=${profileDir}`, url], { stdio: ["ignore", "ignore", "ignore"] });
const page = new Devtools(await new WebSocket(await devtoolsUrl(debugPort)));
await new Promise((resolve) => page.socket.addEventListener("open", resolve, { once: true }));
for (let attempt = 0; attempt < 200; attempt += 1) {
  if (await page.evaluate("document.readyState === 'complete'")) break;
  await delay(25);
}
await delay(Number(process.env.BENCH_SETTLE_MS ?? 1500));

await page.evaluate("(() => { const original = JSON.parse; window.__parsedBytes = 0; JSON.parse = (text, reviver) => { if (typeof text === 'string') window.__parsedBytes += text.length; return original(text, reviver); }; return true; })()");
if (process.env.BENCH_HIDDEN === "1") {
  await page.evaluate("(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); return true; })()");
  await delay(1500);
}
await page.command("Profiler.enable");
await page.command("Profiler.setSamplingInterval", { interval: 200 });
await page.command("Profiler.start");
const publishTimer = setInterval(sendState, 1000);
await delay(SECONDS * 1000);
clearInterval(publishTimer);
const stopped = await page.command("Profiler.stop");
const parsedBytes = await page.evaluate("window.__parsedBytes");
const summary = summarize(stopped.result.profile);
const renders = await page.evaluate("document.querySelectorAll('#swim-content .bar').length");
const toolBars = await page.evaluate("document.querySelectorAll('#swim-content .bar.tool').length");
const runningBarWidth = await page.evaluate("document.querySelector('#swim-content .bar.spin')?.style.width ?? null");
const spinner = await page.evaluate("(() => { const node = document.querySelector('#swim-content .g-run.spin'); if (!node) return null; const style = getComputedStyle(node, '::before'); return `${style.content} ${style.animationName} ${style.animationDuration}`; })()");
const axisLabels = await page.evaluate("[...document.querySelectorAll('#swim-content .axis .ticks span')].map((node) => node.textContent).join(' | ')");
let switchedToolBars;
if (process.env.BENCH_SWITCH === "1" && RUNS > 1) {
  await page.evaluate(`selectRun(${JSON.stringify(`${publisherId}:bench-run-1`)})`);
  await delay(1500);
  switchedToolBars = await page.evaluate("document.querySelectorAll('#swim-content .bar.tool').length");
}

console.log(JSON.stringify({
  config: { runs: RUNS, agents: AGENTS, timingEntriesPerAgent: TIMINGS, logs: LOGS, seconds: SECONDS, view: VIEW, focusRun, ganttBars: renders, ganttToolBars: toolBars, runningBarWidth, axisLabels, spinner, ...(switchedToolBars === undefined ? {} : { toolBarsAfterRunSwitch: switchedToolBars }) },
  parsedKBPerSecond: Number((Number(parsedBytes ?? 0) / 1024 / SECONDS).toFixed(0)),
  statePayloadKB: Number((frameBytes / 1024).toFixed(0)),
  busyMsPerSecond: Number(((summary.totalMs - (summary.ranked.find(({ name }) => name.startsWith("(idle)"))?.ms ?? 0)) / SECONDS).toFixed(1)),
  jsCpuMs: Number(summary.totalMs.toFixed(0)),
  jsCpuPercentOfWall: Number((summary.totalMs / (SECONDS * 1000) * 100).toFixed(1)),
  top: summary.ranked,
  inclusive: summary.inclusive,
}, null, 2));

child.kill("SIGKILL");
publisher.close();
server.close();
rmSync(profileDir, { recursive: true, force: true });
process.exit(0);
