// Deterministic Trajectory Semantic Map demo scenario (V0-D).
// It drives the real workflow host, the real local Pi transport and session JSONL, the real run persistence,
// the real Trajectory publisher/loaders and the real detached Trajectory server. Only the model endpoint is
// simulated: a loopback OpenAI-compatible server replays a fixed script of tool calls and results.
// Shared by `scripts/demo-trajectory-semantic-map.mjs` and `trajectory-live-demo.test.ts`.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createExtensionRuntime, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import workflowExtension, { type WorkflowExtensionAPI } from "../../src/host.js";
import { localAgentTransport } from "../../src/agent-execution.js";
import { RunStore } from "../../src/persistence.js";
import { registerTrajectoryExtension, trajectoryUrl } from "../src/index.js";

type JsonRecord = Record<string, unknown>;
type ToolStep = { tool: string; args: JsonRecord };
type TextStep = { text: string };
type ResultStep = { result: string; gated?: boolean };
type Step = ToolStep | TextStep | ResultStep;
type RegisteredTool = { name: string; execute: (toolCallId: string, params: unknown, signal: AbortSignal | undefined, onUpdate: unknown, context: ExtensionCommandContext) => Promise<unknown> };
type ShutdownHandler = (event: unknown, context: unknown) => unknown;

export const LIVE_DEMO_SESSION_ID = "0199d3c0-7e57-7000-8000-00000000d3e0";
export const LIVE_DEMO_WORKFLOW = "semantic-map-demo";
export const LIVE_DEMO_OVERFLOW_WORKFLOW = "semantic-map-overflow-demo";
export const LIVE_DEMO_OVERFLOW_AGENTS = 18;

/** The scripted model replies, keyed by the `[demo:<role>]` marker in each agent prompt. Indexed by the number of prior assistant turns. */
export const LIVE_DEMO_SCRIPT: Readonly<Record<string, readonly Step[]>> = Object.freeze({
  "scout-docs": [{ tool: "ls", args: { path: "." } }, { tool: "read", args: { path: "README.md" } }, { result: "README describes a two-module inventory service; docs are current." }],
  "scout-src": [{ tool: "ls", args: { path: "src" } }, { tool: "read", args: { path: "src/inventory.js" } }, { result: "src/inventory.js exports reserve() and release(); release() lacks a bounds check." }],
  auditor: [{ tool: "read", args: { path: "audit/policy.md" } }, { text: "The audit policy file is missing, so I cannot produce a result." }, { text: "Still no audit policy; stopping without a result." }],
  synthesizer: [{ tool: "read", args: { path: "src/inventory.js" } }, { tool: "read", args: { path: "README.md" } }, { result: "Plan: add a bounds check to release() and document it in README.", gated: true }],
  reviewer: [{ tool: "ls", args: { path: "src" } }, { tool: "read", args: { path: "src/inventory.js" } }, { result: "Review: the proposed bounds check is safe; no other callers found." }],
  overflow: [{ result: "overflow item done" }],
  // Mixed-load simulation: many repeated calls (grouped on the map), a failing read, few calls, no calls, retries.
  heavy: [
    { tool: "ls", args: { path: "." } }, { tool: "ls", args: { path: "src" } },
    { tool: "read", args: { path: "README.md" } }, { tool: "read", args: { path: "src/inventory.js" } }, { tool: "read", args: { path: "src/index.js" } }, { tool: "read", args: { path: "README.md" } }, { tool: "read", args: { path: "src/inventory.js" } }, { tool: "read", args: { path: "src/index.js" } },
    { text: "Six reads done; the policy file is next." },
    { tool: "read", args: { path: "audit/policy.md" } },
    { tool: "ls", args: { path: "src" } },
    { tool: "read", args: { path: "src/inventory.js" } }, { tool: "read", args: { path: "src/index.js" } },
    { result: "Deep inspection complete: release() lacks a bounds check; policy file missing." }
  ],
  medium: [{ tool: "ls", args: { path: "src" } }, { tool: "read", args: { path: "src/inventory.js" } }, { result: "Checked src/inventory.js." }],
  light: [{ result: "Nothing to inspect; acknowledged." }],
  flaky: [{ tool: "read", args: { path: "missing/config.json" } }, { text: "The config file does not exist." }, { text: "Still missing; giving up." }],
});
/** Expected persisted outcome, used by the automatic test and the walkthrough to compare expected and observed state. */
export const LIVE_DEMO_EXPECTED = Object.freeze({ agents: 5, phases: ["discover", "synthesize"], toolCalls: 9, failedAgents: ["auditor"], failedToolCalls: 1 });

export const LIVE_DEMO_WORKFLOW_SCRIPT = `
phase("discover");
const found = await parallel("discover", {
  docs: () => agent("[demo:scout-docs] List the project root and summarise README.md.", { label: "scout-docs" }),
  source: () => agent("[demo:scout-src] List src and summarise src/inventory.js.", { label: "scout-src" }),
  audit: async () => {
    try { return await agent("[demo:auditor] Read audit/policy.md and report policy violations.", { label: "auditor" }); }
    catch (error) { log("auditor failed as scripted"); return "auditor failed: " + String(error && error.code ? error.code : error); }
  },
});
phase("synthesize");
const plan = await agent(prompt("[demo:synthesizer] Combine the findings into a plan: {found}", { found: JSON.stringify(found) }), { label: "synthesizer" });
const review = await agent(prompt("[demo:reviewer] Review this plan: {plan}", { plan: JSON.stringify(plan) }), { label: "reviewer" });
return { found, plan, review };
`;
// Workflow validation requires a literal tasks record, so the overflow branches are spelled out.
export const LIVE_DEMO_OVERFLOW_SCRIPT = `
return await parallel("fanout", {
${Array.from({ length: LIVE_DEMO_OVERFLOW_AGENTS }, (_value, index) => `  item${String(index)}: () => agent("[demo:overflow] Finish item ${String(index)}.", { label: "item-${String(index)}" }),`).join("\n")}
});
`;

function isRecord(value: unknown): value is JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }

export async function availableLoopbackPort(): Promise<number> {
  const server = createNetServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not reserve a loopback port");
  const port = address.port;
  await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  return port;
}

function messageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => isRecord(part) && typeof part.text === "string" ? part.text : "").join("\n");
  return "";
}

/** Synthetic, deterministic token usage so the demo exercises recorded accounting; no provider is billed. */
function demoUsage(body: string, turn: number): JsonRecord {
  const prompt = 400 + Math.ceil(body.length / 4);
  const cached = turn === 0 ? 0 : Math.floor(prompt * 0.6);
  return { prompt_tokens: prompt, completion_tokens: 48 + turn * 21, total_tokens: prompt + 48 + turn * 21, prompt_tokens_details: { cached_tokens: cached } };
}
function stream(response: ServerResponse, choices: readonly JsonRecord[], usage?: JsonRecord): void {
  const chunk = (choice: JsonRecord) => `data: ${JSON.stringify({ id: "demo", object: "chat.completion.chunk", model: "demo-model", choices: [choice] })}`;
  const usageChunk = usage ? [`data: ${JSON.stringify({ id: "demo", object: "chat.completion.chunk", model: "demo-model", choices: [], usage })}`] : [];
  response.writeHead(200, { Connection: "close", "Content-Type": "text/event-stream" });
  response.end([...choices.map(chunk), ...usageChunk, "data: [DONE]", ""].join("\n\n"));
}

type ModelServer = { port: number; requests: string[]; release(): void; released: boolean; close(): Promise<void> };

/** Loopback OpenAI-compatible endpoint that replays LIVE_DEMO_SCRIPT; nothing leaves the machine and no provider is contacted. */
async function startScriptedModel(paceMs: number): Promise<ModelServer> {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const requests: string[] = [];
  const sockets = new Set<{ destroy(): void }>();
  let calls = 0;
  const state = { released: false };
  const handle = async (request: IncomingMessage, response: ServerResponse, body: string): Promise<void> => {
    const parsed: unknown = JSON.parse(body);
    const messages = isRecord(parsed) && Array.isArray(parsed.messages) ? parsed.messages.filter(isRecord) : [];
    const firstUser = messages.find((message) => message.role === "user");
    const role = /\[demo:([a-z-]+)\]/.exec(messageText(firstUser?.content))?.[1] ?? "unknown";
    const turn = messages.filter((message) => message.role === "assistant").length;
    requests.push(`${role}#${String(turn)}`);
    const step = LIVE_DEMO_SCRIPT[role]?.[turn];
    await delay(paceMs);
    if (step !== undefined && "gated" in step && step.gated) await gate;
    if (response.destroyed || request.socket.destroyed) return;
    calls += 1;
    if (step === undefined) { stream(response, [{ index: 0, delta: { role: "assistant", content: "done" }, finish_reason: null }, { index: 0, delta: {}, finish_reason: "stop" }], demoUsage(body, turn)); return; }
    if ("text" in step) { stream(response, [{ index: 0, delta: { role: "assistant", content: step.text }, finish_reason: null }, { index: 0, delta: {}, finish_reason: "stop" }], demoUsage(body, turn)); return; }
    const name = "tool" in step ? step.tool : "workflow_result";
    const args = "tool" in step ? step.args : { result: step.result };
    stream(response, [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `demo-call-${role}-${String(turn)}-${String(calls)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }], demoUsage(body, turn));
  };
  const server: Server = createServer((request, response) => {
    if (request.method !== "POST" || !request.url?.endsWith("/chat/completions")) { response.writeHead(404).end(); return; }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => { handle(request, response, body).catch((error: unknown) => { if (!response.headersSent) response.writeHead(500).end(String(error)); }); });
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => { sockets.delete(socket); }); });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Scripted model server did not open a TCP port");
  return {
    port: address.port,
    requests,
    get released() { return state.released; },
    release() { state.released = true; release(); },
    async close() { state.released = true; release(); for (const socket of sockets) socket.destroy(); await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); },
  };
}

function writeProject(cwd: string): void {
  mkdirSync(join(cwd, "src"), { recursive: true });
  writeFileSync(join(cwd, "README.md"), "# Inventory service\n\nTwo modules: `src/inventory.js` (reserve/release) and `src/index.js` (wiring).\n");
  writeFileSync(join(cwd, "src", "inventory.js"), "export function reserve(stock, count) { if (count > stock) throw new Error(\"insufficient\"); return stock - count; }\nexport function release(stock, count) { return stock + count; }\n");
  writeFileSync(join(cwd, "src", "index.js"), "export * from \"./inventory.js\";\n");
}

export type LiveDemoOptions = {
  /** Parent directory for the isolated demo root; defaults to the OS temp directory. */
  parent?: string;
  /** Trajectory server port; defaults to a free loopback port. The personal default 7432 is refused. */
  port?: number;
  /** Delay before each scripted model reply, in milliseconds. */
  paceMs?: number;
  /** Also launch the >16-agent overflow run. */
  overflow?: boolean;
};

export type LiveDemo = {
  root: string;
  cwd: string;
  home: string;
  agentDir: string;
  port: number;
  url: string;
  sessionId: string;
  runId: string;
  overflowRunId: string | undefined;
  modelRequests: readonly string[];
  /** Releases the gated synthesizer reply so the runtime produces a visible state update. */
  release(): void;
  readonly released: boolean;
  /** Resolves once the persisted run reaches `state`. */
  waitForRunState(runId: string, states: readonly string[], timeoutMs?: number): Promise<string>;
  loadRun(runId: string): Promise<JsonRecord>;
  /** Launches another trusted workflow in this isolated test runtime, using only the scripted local model. */
  launchWorkflow(name: string, script: string, concurrency?: number): Promise<string>;
  serverPid(): number | undefined;
  /** The caller's environment before the demo isolated HOME/profile variables; used to launch an unrelated helper such as headless Chrome. */
  hostEnv: NodeJS.ProcessEnv;
  stop(options?: { keepRoot?: boolean }): Promise<{ serverStopped: boolean; rootRemoved: boolean }>;
};

const ENV_KEYS = ["PI_OFFLINE", "PI_CODING_AGENT_DIR", "PI_WORKFLOW_TRAJECTORY_PORT", "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME"] as const;

async function health(port: number): Promise<JsonRecord | undefined> {
  try {
    const response = await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(500) });
    if (!response.ok) return undefined;
    const value: unknown = await response.json();
    return isRecord(value) ? value : undefined;
  } catch { return undefined; }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Starts the scenario and returns once the Trajectory server is healthy and the main run is persisted. */
export async function startLiveDemo(options: LiveDemoOptions = {}): Promise<LiveDemo> {
  const port = options.port ?? await availableLoopbackPort();
  if (port === 7432) throw new Error("The live demo never uses the personal Trajectory port 7432; choose another port.");
  const root = mkdtempSync(join(options.parent ?? tmpdir(), "piewf-demo-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const agentDir = join(root, "agent");
  const appData = join(root, "appdata");
  // A .git marker bounds Pi's ancestor .agents/skills and context-file discovery to this isolated root.
  for (const directory of [join(root, ".git"), cwd, home, agentDir, join(appData, "Roaming"), join(appData, "Local")]) mkdirSync(directory, { recursive: true });
  writeProject(cwd);
  const hostEnv: NodeJS.ProcessEnv = { ...process.env };
  const previousEnv = new Map<string, string | undefined>(ENV_KEYS.map((key) => [key, process.env[key]]));
  const restoreEnv = () => { for (const [key, value] of previousEnv) { if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value; } };
  Object.assign(process.env, { PI_OFFLINE: "1", PI_CODING_AGENT_DIR: agentDir, PI_WORKFLOW_TRAJECTORY_PORT: String(port), HOME: home, USERPROFILE: home, APPDATA: join(appData, "Roaming"), LOCALAPPDATA: join(appData, "Local"), XDG_CONFIG_HOME: join(appData, "Roaming"), XDG_DATA_HOME: join(appData, "Local"), XDG_CACHE_HOME: join(appData, "Local") });
  const lockPath = join(agentDir, "pi-extensible-workflows", "trajectory.lock");
  const ownServerPid = (): number | undefined => {
    try { const lock: unknown = JSON.parse(readFileSync(lockPath, "utf8")); return isRecord(lock) && typeof lock.pid === "number" && lock.port === port ? lock.pid : undefined; } catch { return undefined; }
  };
  let model: ModelServer | undefined;
  const shutdownHandlers: ShutdownHandler[] = [];
  let stopped = false;
  const stop = async (stopOptions: { keepRoot?: boolean } = {}): Promise<{ serverStopped: boolean; rootRemoved: boolean }> => {
    if (stopped) return { serverStopped: true, rootRemoved: !existsSync(root) };
    stopped = true;
    model?.release();
    for (const handler of shutdownHandlers) { try { await Promise.race([Promise.resolve(handler({ type: "session_shutdown" }, context)), delay(10_000)]); } catch { /* Best-effort host shutdown; ownership cleanup follows. */ } }
    // Only signal the server this demo spawned: the lock lives in the demo's own agent dir and /health must report the same pid.
    let serverStopped = true;
    const pid = ownServerPid();
    if (pid !== undefined) {
      const reported = await health(port);
      if (reported?.pid === pid) { try { process.kill(pid, "SIGTERM"); } catch { /* Already gone. */ } }
      const deadline = Date.now() + 5_000;
      while (processAlive(pid) && (await health(port))?.pid === pid && Date.now() < deadline) await delay(50);
      if (processAlive(pid) && (await health(port))?.pid === pid) { try { process.kill(pid, "SIGKILL"); } catch { /* Already gone. */ } await delay(200); }
      serverStopped = (await health(port))?.pid !== pid;
    }
    await model?.close();
    restoreEnv();
    let rootRemoved = false;
    if (stopOptions.keepRoot !== true) {
      for (let attempt = 0; attempt < 20 && !rootRemoved; attempt += 1) {
        try { rmSync(root, { recursive: true, force: true }); rootRemoved = !existsSync(root); } catch { await delay(100); }
      }
    }
    return { serverStopped, rootRemoved };
  };
  let context!: ExtensionCommandContext;
  try {
    model = await startScriptedModel(options.paceMs ?? 250);
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { demo: { baseUrl: `http://127.0.0.1:${String(model.port)}/v1`, api: "openai-completions", apiKey: "demo-local-only", models: [{ id: "demo-model", name: "Deterministic demo model", reasoning: false, input: ["text"], contextWindow: 16_384, maxTokens: 1_024 }] } } }));
    writeFileSync(join(agentDir, "auth.json"), "{}");
    const tools = new Map<string, RegisteredTool>();
    const api: WorkflowExtensionAPI = {
      appendEntry() { /* Session log entries are not needed by the demo. */ },
      getActiveTools: () => ["read", "ls", "workflow"],
      getThinkingLevel: () => "off",
      on(name: string, handler: unknown) { if (name === "session_shutdown" && typeof handler === "function") shutdownHandlers.push(handler as ShutdownHandler); },
      registerCommand() { /* Commands are not used by the demo. */ },
      registerTool(tool: unknown) { if (isRecord(tool) && typeof tool.name === "string") tools.set(tool.name, tool as unknown as RegisteredTool); },
      sendMessage() { /* Completion follow-ups are observed through persistence instead. */ },
    } as unknown as WorkflowExtensionAPI;
    registerTrajectoryExtension(api, { agentDir, openUrl: () => { /* The demo never opens a browser by itself. */ } });
    workflowExtension(api, home, async () => { /* No clipboard. */ }, localAgentTransport, agentDir);
    const modelRegistry = new ModelRegistry(await ModelRuntime.create({ modelsPath: join(agentDir, "models.json") }));
    const demoModel = modelRegistry.find("demo", "demo-model");
    if (!demoModel) throw new Error("The deterministic demo model was not registered");
    const runner = new ExtensionRunner([], createExtensionRuntime(), cwd, SessionManager.inMemory(cwd, { id: LIVE_DEMO_SESSION_ID }), modelRegistry);
    context = runner.createCommandContext();
    for (const [key, value] of Object.entries({ hasUI: true, model: demoModel })) Object.defineProperty(context, key, { configurable: true, enumerable: true, writable: true, value });
    const workflow = tools.get("workflow");
    if (!workflow) throw new Error("The workflow tool was not registered");
    const launch = async (name: string, script: string, concurrency: number): Promise<string> => {
      const result = await workflow.execute(`demo-${name}`, { name, script, concurrency }, undefined, undefined, context);
      const text = isRecord(result) && Array.isArray(result.content) && isRecord(result.content[0]) && typeof result.content[0].text === "string" ? result.content[0].text : "";
      const parsed: unknown = JSON.parse(text);
      if (!isRecord(parsed) || typeof parsed.runId !== "string") throw new Error(`Workflow launch did not return a run ID: ${text}`);
      return parsed.runId;
    };
    const runId = await launch(LIVE_DEMO_WORKFLOW, LIVE_DEMO_WORKFLOW_SCRIPT, 3);
    const deadline = Date.now() + 30_000;
    while ((await health(port))?.pid === undefined) {
      if (Date.now() > deadline) throw new Error(`The Trajectory server did not become healthy on port ${String(port)}`);
      await delay(100);
    }
    const loadRun = async (id: string): Promise<JsonRecord> => (await new RunStore(cwd, LIVE_DEMO_SESSION_ID, id, home).load()).run as unknown as JsonRecord;
    const overflowRunId = options.overflow === true ? await launch(LIVE_DEMO_OVERFLOW_WORKFLOW, LIVE_DEMO_OVERFLOW_SCRIPT, 6) : undefined;
    const activeModel = model;
    return {
      hostEnv, root, cwd, home, agentDir, port, url: trajectoryUrl(port), sessionId: LIVE_DEMO_SESSION_ID, runId, overflowRunId,
      modelRequests: activeModel.requests,
      release() { activeModel.release(); },
      get released() { return activeModel.released; },
      loadRun,
      async launchWorkflow(name, script, concurrency = 3) {
        if (stopped) throw new Error("The isolated demo runtime is stopped");
        return await launch(name, script, concurrency);
      },
      async waitForRunState(id, states, timeoutMs = 60_000) {
        const until = Date.now() + timeoutMs;
        let current = "unknown";
        while (Date.now() < until) {
          try { current = String((await loadRun(id)).state); } catch { /* The run may still be written. */ }
          if (states.includes(current)) return current;
          await delay(100);
        }
        throw new Error(`Run ${id} stayed ${current}; expected ${states.join(" or ")}`);
      },
      serverPid: ownServerPid,
      stop,
    };
  } catch (error) {
    await stop().catch(() => undefined);
    throw error;
  }
}
