// Real headless-Chrome walkthrough of the V0-D live demo. It drives the production Trajectory UI served by the
// demo's own Trajectory server over CDP, never the user's browser or profile: the executable comes from
// PI_TRAJECTORY_CHROME (or a known install path) and always runs with a temporary --user-data-dir.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { availableLoopbackPort, LIVE_DEMO_OVERFLOW_WORKFLOW, LIVE_DEMO_WORKFLOW, type LiveDemo } from "./live-demo-fixture.js";

type CdpRecord = Record<string, unknown>;
type CdpMessage = CdpRecord & { id?: number; method?: string; sessionId?: string };
type MapNode = { id: string; label: string; kind: string; status: string };
type FrameContext = { contextId: number; sessionId?: string };

/** Only an explicitly configured browser is used (PI_TRAJECTORY_CHROME), so a test or demo never picks up a personal browser implicitly. */
export function findChrome(): string | undefined {
  const configured = process.env.PI_TRAJECTORY_CHROME;
  return typeof configured === "string" && configured.length > 0 && existsSync(configured) ? configured : undefined;
}

function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function text(value: unknown, fallback = ""): string { return typeof value === "string" ? value : fallback; }

class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, (message: CdpMessage) => void>();
  private readonly listeners = new Map<string, Set<(params: CdpRecord, sessionId?: string) => void>>();
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener("message", (event) => {
      let message: CdpMessage;
      try { message = JSON.parse(String(event.data)) as CdpMessage; } catch { return; }
      if (typeof message.method === "string") for (const listener of this.listeners.get(message.method) ?? []) listener((message.params ?? {}) as CdpRecord, message.sessionId);
      if (typeof message.id === "number") { const resolve = this.pending.get(message.id); this.pending.delete(message.id); resolve?.(message); }
    });
  }
  on(method: string, listener: (params: CdpRecord, sessionId?: string) => void): void { const set = this.listeners.get(method) ?? new Set(); set.add(listener); this.listeners.set(method, set); }
  command(method: string, params: CdpRecord = {}, sessionId?: string, timeoutMs = 15_000): Promise<CdpMessage> {
    const id = this.nextId++;
    this.socket.send(JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeoutMs);
      this.pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
    });
  }
  async evaluate(expression: string, context?: FrameContext): Promise<unknown> {
    const message = await this.command("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true, ...(context ? { contextId: context.contextId } : {}) }, context?.sessionId);
    if (message.error) throw new Error(text((message.error as CdpRecord).message, "Chrome evaluation failed"));
    const result = message.result as CdpRecord | undefined;
    const exception = result?.exceptionDetails as CdpRecord | undefined;
    if (exception) throw new Error(text((exception.exception as CdpRecord | undefined)?.description, text(exception.text, "Chrome evaluation failed")));
    return (result?.result as CdpRecord | undefined)?.value;
  }
  close(): void { this.socket.close(); }
}

async function connect(url: string): Promise<Cdp> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => { resolve(); }, { once: true }); socket.addEventListener("error", () => { reject(new Error("Chrome DevTools connection failed")); }, { once: true }); });
  return new Cdp(socket);
}

export type WalkthroughObservation = {
  chrome: string;
  runRef: string;
  overflowRunRef?: string;
  initialTab: string;
  mapRequestsBeforeClick: number;
  iframesBeforeClick: number;
  tabToReadyMs: number;
  sandbox: string;
  statusBeforeTranscript: string;
  completenessBeforeTranscript: string;
  nodesBeforeTranscript: MapNode[];
  releaseToVisibleMs: number;
  nodesAfterUpdate: MapNode[];
  failedDetail: { crumb: string; text: string; transcriptRequested: boolean };
  resultDetail: { crumb: string; outputText: string };
  nodesAfterTranscript: MapNode[];
  mapRequestsAfterCloseDelay: number;
  mapRequestsAtClose: number;
  reopenStatus: string;
  runStateAfterReopen: string;
  overflow?: { status: string; completeness: string; visibleAgentNodes: number; persistedAgents: number; pagerLabel?: string; secondPageAgentNodes?: number; secondPageLabel?: string; firstPageIds?: string[]; secondPageIds?: string[] };
  webSockets: number;
  mapAssetRequests: string[];
  externalRequests: string[];
  consoleErrors: string[];
  screenshots: string[];
};

export type WalkthroughOptions = { demo: LiveDemo; chrome: string; evidenceDir: string; log?: (line: string) => void };

/** Runs the scripted V0-D walkthrough and saves screenshots; the caller owns and stops `demo`. */
export async function runLiveDemoWalkthrough(options: WalkthroughOptions): Promise<WalkthroughObservation> {
  const { demo, chrome, evidenceDir } = options;
  const log = options.log ?? (() => undefined);
  mkdirSync(evidenceDir, { recursive: true });
  const debugPort = await availableLoopbackPort();
  const profile = mkdtempSync(join(tmpdir(), "piewf-demo-chrome-"));
  const child = spawn(chrome, ["--headless=new", "--disable-gpu", "--disable-dev-shm-usage", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--disable-background-networking", "--disable-sync", "--window-size=1440,900", `--remote-debugging-port=${String(debugPort)}`, `--user-data-dir=${profile}`, "about:blank"], { stdio: "ignore", windowsHide: true, env: demo.hostEnv });
  const exited = new Promise<void>((resolve) => { child.once("close", () => { resolve(); }); });
  let page: Cdp | undefined;
  let browser: Cdp | undefined;
  try {
    let pageUrl: string | undefined;
    let browserUrl: string | undefined;
    for (let attempt = 0; attempt < 300 && (!pageUrl || !browserUrl); attempt += 1) {
      if (child.exitCode !== null) throw new Error(`Chrome exited early with ${String(child.exitCode)}`);
      try {
        const pages = await (await fetch(`http://127.0.0.1:${String(debugPort)}/json`)).json() as Array<{ type?: string; webSocketDebuggerUrl?: string }>;
        pageUrl = pages.find((candidate) => candidate.type === "page")?.webSocketDebuggerUrl;
        browserUrl = (await (await fetch(`http://127.0.0.1:${String(debugPort)}/json/version`)).json() as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl;
      } catch { /* Chrome is still starting. */ }
      if (!pageUrl || !browserUrl) await delay(50);
    }
    if (!pageUrl || !browserUrl) throw new Error("Chrome DevTools did not start");
    page = await connect(pageUrl);
    browser = await connect(browserUrl);
    const activePage = page;
    const activeBrowser = browser;
    const requests: string[] = [];
    const consoleErrors: string[] = [];
    let webSockets = 0;
    activePage.on("Network.requestWillBeSent", (params) => { const request = params.request as CdpRecord | undefined; if (typeof request?.url === "string") requests.push(request.url); });
    activePage.on("Network.webSocketCreated", () => { webSockets += 1; });
    activePage.on("Runtime.exceptionThrown", (params) => { consoleErrors.push(text((params.exceptionDetails as CdpRecord | undefined)?.text, "uncaught exception")); });
    activePage.on("Log.entryAdded", (params) => { const entry = params.entry as CdpRecord | undefined; if (entry?.level === "error" && !text(entry.url).endsWith("/favicon.ico")) consoleErrors.push(text(entry.text)); });
    await activePage.command("Network.enable");
    await activePage.command("Log.enable");
    await activePage.command("Page.enable");
    await activePage.command("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const evaluate = (expression: string): Promise<unknown> => activePage.evaluate(expression);
    const waitFor = async (expression: string, timeoutMs = 20_000): Promise<void> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { if (await evaluate(expression).catch(() => false)) return; await delay(25); }
      throw new Error(`Chrome condition did not become true within ${String(timeoutMs)} ms: ${expression}`);
    };
    const screenshots: string[] = [];
    const screenshot = async (name: string): Promise<void> => {
      await delay(300);
      const shot = await activePage.command("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const data = (shot.result as CdpRecord | undefined)?.data;
      if (typeof data !== "string") throw new Error(`Screenshot ${name} failed`);
      const file = join(evidenceDir, name);
      writeFileSync(file, Buffer.from(data, "base64"));
      screenshots.push(file);
      log(`screenshot ${file}`);
    };
    const mapRequests = () => requests.filter((url) => url.startsWith(demo.url) && new URL(url).pathname.startsWith("/semantic-map."));
    const frameContext = async (): Promise<FrameContext> => {
      // The opaque viewer is usually an out-of-process frame target; fall back to an in-process frame context.
      await activeBrowser.command("Target.setDiscoverTargets", { discover: true });
      for (let attempt = 0; attempt < 200; attempt += 1) {
        const targets = ((await activeBrowser.command("Target.getTargets")).result as CdpRecord | undefined)?.targetInfos;
        const target = Array.isArray(targets) ? (targets as CdpRecord[]).find((candidate) => text(candidate.url).includes("/semantic-map.html")) : undefined;
        if (typeof target?.targetId === "string") {
          const attached = await activeBrowser.command("Target.attachToTarget", { targetId: target.targetId, flatten: true });
          const sessionId = (attached.result as CdpRecord | undefined)?.sessionId;
          if (typeof sessionId !== "string") break;
          let contextId: number | undefined;
          activeBrowser.on("Runtime.executionContextCreated", (params, eventSession) => { const context = params.context as CdpRecord | undefined; if (eventSession === sessionId && (context?.auxData as CdpRecord | undefined)?.isDefault === true && typeof context?.id === "number") contextId = context.id; });
          await activeBrowser.command("Runtime.enable", {}, sessionId);
          for (let wait = 0; wait < 200 && contextId === undefined; wait += 1) await delay(10);
          if (contextId === undefined) break;
          return { contextId, sessionId };
        }
        const tree = ((await activePage.command("Page.getFrameTree")).result as CdpRecord | undefined)?.frameTree as CdpRecord | undefined;
        const children = Array.isArray(tree?.childFrames) ? tree.childFrames as CdpRecord[] : [];
        const frame = children.map((node) => node.frame as CdpRecord | undefined).find((candidate) => text(candidate?.url).includes("/semantic-map.html"));
        if (typeof frame?.id === "string") {
          const world = await activePage.command("Page.createIsolatedWorld", { frameId: frame.id, worldName: "piewf-demo-probe" });
          const contextId = (world.result as CdpRecord | undefined)?.executionContextId;
          if (typeof contextId === "number") return { contextId };
        }
        await delay(25);
      }
      throw new Error("The Semantic Map viewer frame was not found");
    };
    const mapEvaluate = (context: FrameContext, expression: string): Promise<unknown> => (context.sessionId === undefined ? activePage : activeBrowser).evaluate(expression, context);
    const waitForMap = async (context: FrameContext, expression: string, timeoutMs = 20_000): Promise<boolean> => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) { if (await mapEvaluate(context, expression).catch(() => false)) return true; await delay(50); }
      return false;
    };
    const mapNodes = async (context: FrameContext): Promise<MapNode[]> => await mapEvaluate(context, "[...document.querySelectorAll('.semantic-map-node')].map(node=>({id:node.getAttribute('data-node-id')||'',label:node.getAttribute('data-node-label')||'',kind:node.getAttribute('data-node-kind')||'',status:node.getAttribute('data-node-status')||''}))") as MapNode[];
    const selectRun = async (workflowName: string): Promise<string> => {
      await waitFor(`[...document.querySelectorAll('#sidebar [data-run]')].some(button=>button.querySelector('.n')?.textContent===${JSON.stringify(workflowName)})`, 30_000);
      return String(await evaluate(`(()=>{const button=[...document.querySelectorAll('#sidebar [data-run]')].find(candidate=>candidate.querySelector('.n')?.textContent===${JSON.stringify(workflowName)});button.click();return button.dataset.run})()`));
    };

    log(`opening ${demo.url} in headless Chrome (temporary profile)`);
    await activePage.command("Page.navigate", { url: demo.url });
    const runRef = await selectRun(LIVE_DEMO_WORKFLOW);
    await waitFor("document.body.dataset.view==='run' && Boolean(document.querySelector('.workflow-head'))");
    await waitFor("document.querySelectorAll('#swim-content [data-agent], #swim [data-agent]').length>=4", 30_000).catch(() => undefined);
    const initialTab = String(await evaluate("document.querySelector('#projection-tabs [aria-selected=\"true\"]')?.id||''"));
    const iframesBeforeClick = Number(await evaluate("document.querySelectorAll('#semantic-map-host iframe').length"));
    const mapRequestsBeforeClick = mapRequests().length;
    await screenshot("01-gantt-running.png");

    await evaluate("window.__demoMapStarted=performance.now();document.getElementById('semantic-map-tab').click()");
    await waitFor("Boolean(document.querySelector('#semantic-map-host iframe')) && document.getElementById('semantic-map-status').textContent.startsWith('Partial graph')", 20_000);
    const tabToReadyMs = Number(await evaluate("performance.now()-window.__demoMapStarted"));
    const sandbox = String(await evaluate("document.querySelector('#semantic-map-host iframe').getAttribute('sandbox')"));
    const context = await frameContext();
    if (!await waitForMap(context, "document.querySelectorAll('.semantic-map-node').length>0")) throw new Error("The Semantic Map rendered no nodes");
    const statusBeforeTranscript = String(await evaluate("document.getElementById('semantic-map-status').textContent"));
    const completenessBeforeTranscript = String(await mapEvaluate(context, "document.getElementById('semantic-map-completeness')?.textContent||''"));
    const nodesBeforeTranscript = await mapNodes(context);
    await screenshot("02-map-before-transcript.png");

    log("releasing the gated synthesizer reply (runtime state update)");
    const releasedAt = Date.now();
    demo.release();
    let releaseToVisibleMs = -1;
    for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
      const nodes = await mapNodes(context).catch(() => []);
      if (nodes.some((node) => node.label === "reviewer" && node.kind === "agent" && node.status === "success")) { releaseToVisibleMs = Date.now() - releasedAt; break; }
      await delay(50);
    }
    const nodesAfterUpdate = await mapNodes(context);
    await screenshot("03-map-after-runtime-update.png");

    const openDetail = async (label: string): Promise<void> => {
      await mapEvaluate(context, `(()=>{const node=[...document.querySelectorAll('.semantic-map-node')].find(candidate=>candidate.getAttribute('data-node-label')===${JSON.stringify(label)}&&candidate.getAttribute('data-node-kind')==='agent');node.dispatchEvent(new MouseEvent('click',{bubbles:true}));node.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))})()`);
      await waitFor(`document.body.dataset.view==='agent' && document.getElementById('agent-crumb').textContent===${JSON.stringify(label)}`, 20_000);
    };
    await openDetail("auditor");
    await waitFor("document.getElementById('view-agent').textContent.includes('workflow_result') || document.getElementById('view-agent').textContent.includes('RESULT_INVALID')", 20_000).catch(() => undefined);
    await delay(500);
    const failedDetail = { crumb: String(await evaluate("document.getElementById('agent-crumb').textContent")), text: String(await evaluate("document.getElementById('view-agent').innerText")).slice(0, 4000), transcriptRequested: false };
    failedDetail.transcriptRequested = /audit\/policy\.md|ENOENT|not found|no such file/i.test(failedDetail.text);
    await screenshot("04-detail-controlled-error.png");

    await evaluate("document.getElementById('run-crumb').click()");
    await waitFor("document.body.dataset.view==='run'");
    const contextAfterBack = await frameContext().catch(() => context);
    await waitForMap(contextAfterBack, "document.querySelectorAll('.semantic-map-node').length>0");
    const resultContext = contextAfterBack;
    await mapEvaluate(resultContext, "(()=>{const node=[...document.querySelectorAll('.semantic-map-node')].find(candidate=>candidate.getAttribute('data-node-label')==='synthesizer'&&candidate.getAttribute('data-node-kind')==='agent');node.dispatchEvent(new MouseEvent('click',{bubbles:true}));node.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))})()");
    await waitFor("document.body.dataset.view==='agent' && document.getElementById('agent-crumb').textContent==='synthesizer'", 20_000);
    await evaluate("(()=>{const details=document.querySelector('[data-agent-details]');if(details)details.click()})()");
    await waitFor("Boolean(document.querySelector('#sys-tabs [data-pane=output]'))", 20_000);
    await evaluate("document.querySelector('#sys-tabs [data-pane=output]').click()");
    await waitFor("document.getElementById('sys-pane').innerText.includes('bounds check')", 20_000).catch(() => undefined);
    const resultDetail = { crumb: String(await evaluate("document.getElementById('agent-crumb').textContent")), outputText: String(await evaluate("document.getElementById('sys-pane')?.innerText||''")).slice(0, 2000) };
    await screenshot("05-detail-recorded-result.png");

    await evaluate("document.getElementById('run-crumb').click()");
    await waitFor("document.body.dataset.view==='run'");
    const contextAfterTranscript = await frameContext().catch(() => resultContext);
    await delay(500);
    const nodesAfterTranscript = await mapNodes(contextAfterTranscript).catch(() => []);
    await screenshot("06-map-after-transcripts.png");

    await evaluate("document.getElementById('timeline-tab').click()");
    await waitFor("document.querySelectorAll('#semantic-map-host iframe').length===0");
    const mapRequestsAtClose = mapRequests().length;
    await delay(400);
    const mapRequestsAfterCloseDelay = mapRequests().length;
    await evaluate("document.getElementById('semantic-map-tab').click()");
    await waitFor("Boolean(document.querySelector('#semantic-map-host iframe')) && document.getElementById('semantic-map-status').textContent.startsWith('Partial graph')", 20_000);
    const reopenStatus = String(await evaluate("document.getElementById('semantic-map-status').textContent"));
    await evaluate("document.getElementById('semantic-map-close').click()");
    await waitFor("document.querySelectorAll('#semantic-map-host iframe').length===0 && document.getElementById('timeline-tab').getAttribute('aria-selected')==='true'");
    const runStateAfterReopen = String((await demo.loadRun(demo.runId)).state);

    let overflow: WalkthroughObservation["overflow"];
    let overflowRunRef: string | undefined;
    if (demo.overflowRunId !== undefined) {
      await demo.waitForRunState(demo.overflowRunId, ["completed", "failed"], 60_000);
      overflowRunRef = await selectRun(LIVE_DEMO_OVERFLOW_WORKFLOW);
      await waitFor("document.body.dataset.view==='run'");
      await evaluate("document.getElementById('semantic-map-tab').click()");
      await waitFor("Boolean(document.querySelector('#semantic-map-host iframe')) && document.getElementById('semantic-map-status').textContent.length>0", 20_000);
      const overflowContext = await frameContext();
      await waitForMap(overflowContext, "document.querySelectorAll('.semantic-map-node').length>0");
      const nodes = await mapNodes(overflowContext);
      const persisted = await demo.loadRun(demo.overflowRunId);
      overflow = { status: String(await evaluate("document.getElementById('semantic-map-status').textContent")), completeness: String(await mapEvaluate(overflowContext, "document.getElementById('semantic-map-completeness')?.textContent||''")), visibleAgentNodes: nodes.filter((node) => node.kind === "agent" && !node.label.includes(" · attempt ")).length, persistedAgents: Array.isArray(persisted.agents) ? persisted.agents.length : 0 };
      await screenshot("07-overflow-partial-map.png");
      // More than 16 agents: the map pages them 16 at a time; the next page shows the remaining agents only.
      const firstPageIds = nodes.filter((node) => node.kind === "agent").map((node) => node.id);
      const pagerLabel = String(await evaluate("document.getElementById('semantic-map-pager').hidden ? 'hidden' : document.getElementById('semantic-map-page').textContent"));
      await evaluate("document.getElementById('semantic-map-next').click()");
      await waitFor("/^Agents 17/.test(document.getElementById('semantic-map-page').textContent)", 10_000);
      await waitForMap(overflowContext, "document.querySelectorAll('.semantic-map-node[data-node-kind=agent]').length>0 && document.querySelectorAll('.semantic-map-node[data-node-kind=agent]').length<16");
      const secondPage = await mapNodes(overflowContext);
      const secondPageIds = secondPage.filter((node) => node.kind === "agent").map((node) => node.id);
      Object.assign(overflow, { pagerLabel, secondPageAgentNodes: secondPageIds.length, secondPageLabel: String(await evaluate("document.getElementById('semantic-map-page').textContent")), firstPageIds, secondPageIds });
      await screenshot("08-overflow-second-page.png");
      await evaluate("document.getElementById('timeline-tab').click()");
      await waitFor("document.querySelectorAll('#semantic-map-host iframe').length===0");
    }
    const mapAssetRequests = mapRequests().map((url) => new URL(url).pathname + new URL(url).search);
    const externalRequests = requests.filter((url) => !url.startsWith(demo.url) && !url.startsWith("ws://127.0.0.1") && url !== "about:blank" && !url.startsWith("data:"));
    return {
      chrome, runRef, ...(overflowRunRef === undefined ? {} : { overflowRunRef }), initialTab, mapRequestsBeforeClick, iframesBeforeClick, tabToReadyMs, sandbox,
      statusBeforeTranscript, completenessBeforeTranscript, nodesBeforeTranscript, releaseToVisibleMs, nodesAfterUpdate, failedDetail, resultDetail, nodesAfterTranscript,
      mapRequestsAtClose, mapRequestsAfterCloseDelay, reopenStatus, runStateAfterReopen, ...(overflow === undefined ? {} : { overflow }), webSockets, mapAssetRequests, externalRequests, consoleErrors, screenshots,
    };
  } finally {
    page?.close();
    browser?.close();
    child.kill();
    await Promise.race([exited, delay(5_000)]);
    for (let attempt = 0; attempt < 20; attempt += 1) { try { rmSync(profile, { recursive: true, force: true }); if (!existsSync(profile)) break; } catch { /* Chrome may still release profile files. */ } await delay(100); }
  }
}
