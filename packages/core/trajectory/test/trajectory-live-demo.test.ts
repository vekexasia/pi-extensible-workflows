import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { availableLoopbackPort, LIVE_DEMO_EXPECTED, startLiveDemo, type LiveDemo } from "./live-demo-fixture.js";
import { findChrome, runLiveDemoWalkthrough } from "./live-demo-browser.js";

type JsonRecord = Record<string, unknown>;
const chrome = findChrome();
const requireChrome = process.env.PI_TRAJECTORY_REQUIRE_CHROME === "1";
const demoScript = fileURLToPath(new URL("../../../../../scripts/demo-trajectory-semantic-map.mjs", import.meta.url));

function isRecord(value: unknown): value is JsonRecord { return value !== null && typeof value === "object" && !Array.isArray(value); }
function delay(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function agentsOf(run: JsonRecord): JsonRecord[] { return Array.isArray(run.agents) ? run.agents.filter(isRecord) : []; }
function lastAttempt(agent: JsonRecord): JsonRecord | undefined { const details = Array.isArray(agent.attemptDetails) ? agent.attemptDetails.filter(isRecord) : []; return details.at(-1); }
async function healthPid(port: number): Promise<unknown> {
  try { const value: unknown = await (await fetch(`http://127.0.0.1:${String(port)}/health`, { signal: AbortSignal.timeout(500) })).json(); return isRecord(value) ? value.pid : undefined; } catch { return undefined; }
}
async function waitForAgent(demo: LiveDemo, name: string, state: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (agentsOf(await demo.loadRun(demo.runId)).some((agent) => agent.name === name && agent.state === state)) return;
    await delay(50);
  }
  throw new Error(`${name} did not become ${state}`);
}

void test("V0-D live demo runs a deterministic scenario through the real workflow runtime, Pi sessions, persistence and Trajectory server", { timeout: 180_000 }, async () => {
  const demo = await startLiveDemo({ paceMs: 20 });
  let stopped: { serverStopped: boolean; rootRemoved: boolean } | undefined;
  try {
    assert.notEqual(demo.port, 7432);
    const pid = demo.serverPid();
    assert.ok(pid !== undefined && pid !== process.pid, "the demo spawned its own detached Trajectory server under its isolated agent dir");
    assert.equal(await healthPid(demo.port), pid);
    await waitForAgent(demo, "synthesizer", "running");
    const running = await demo.loadRun(demo.runId);
    assert.equal(running.state, "running", "the gated reply keeps the run live for the browser");
    const auditor = agentsOf(running).find((agent) => agent.name === "auditor");
    assert.ok(auditor);
    assert.equal(auditor.state, "failed");
    assert.equal((lastAttempt(auditor)?.error as JsonRecord | undefined)?.code, "RESULT_INVALID", "the controlled error is the real missing-result failure after one repair");
    assert.equal(agentsOf(running).some((agent) => agent.name === "reviewer"), false, "phase two has not reached the reviewer before the update");
    demo.release();
    assert.equal(await demo.waitForRunState(demo.runId, ["completed", "failed"]), "completed");
    const run = await demo.loadRun(demo.runId);
    const agents = agentsOf(run);
    assert.deepEqual(agents.map((agent) => [agent.name, agent.state]), [["scout-docs", "completed"], ["scout-src", "completed"], ["auditor", "failed"], ["synthesizer", "completed"], ["reviewer", "completed"]]);
    assert.equal(agents.length, LIVE_DEMO_EXPECTED.agents);
    assert.deepEqual([...new Set(agents.flatMap((agent) => Array.isArray(agent.structuralPath) ? (agent.structuralPath as unknown[]).slice(0, 1).map(String) : []))], ["discover"]);
    let toolCalls = 0;
    let failedToolCalls = 0;
    for (const agent of agents) {
      const locator = (lastAttempt(agent)?.session as JsonRecord | undefined)?.locator as JsonRecord | undefined;
      assert.equal(typeof locator?.sessionFile, "string", `${String(agent.name)} has a real Pi session file`);
      for (const line of readFileSync(String(locator?.sessionFile), "utf8").split("\n")) {
        if (!line.trim()) continue;
        const entry: unknown = JSON.parse(line);
        if (!isRecord(entry) || entry.customType !== "pi-workflows:tool-timing" || !isRecord(entry.data) || entry.data.toolName === "workflow_result") continue;
        toolCalls += 1;
        if (entry.data.isError === true) failedToolCalls += 1;
      }
    }
    assert.equal(toolCalls, LIVE_DEMO_EXPECTED.toolCalls, "6-12 real tool executions recorded by the tool-timing extension");
    assert.equal(failedToolCalls, LIVE_DEMO_EXPECTED.failedToolCalls);
    assert.ok(demo.modelRequests.every((request) => !request.startsWith("unknown")), demo.modelRequests.join(" "));
  } finally { stopped = await demo.stop(); }
  assert.deepEqual(stopped, { serverStopped: true, rootRemoved: true });
  assert.equal(await healthPid(demo.port), undefined, "the owned server no longer answers after stop");
  assert.equal(existsSync(demo.root), false);
});

void test("V0-D isolated runtime can launch an additional trusted workflow without a paid provider", { timeout: 180_000 }, async () => {
  const demo = await startLiveDemo({ paceMs: 20 });
  try {
    const runId = await demo.launchWorkflow("archify-custom-test", 'phase("review"); return await agent("[demo:reviewer] Review the test project.", { label: "custom-reviewer" });', 2);
    assert.notEqual(runId, demo.runId);
    assert.equal(await demo.waitForRunState(runId, ["completed", "failed"]), "completed");
    const run = await demo.loadRun(runId);
    assert.equal(run.workflowName, "archify-custom-test");
    assert.deepEqual(agentsOf(run).map((agent) => [agent.name, agent.state]), [["custom-reviewer", "completed"]]);
    assert.ok(demo.modelRequests.some((request) => request.startsWith("reviewer#")));
  } finally { assert.deepEqual(await demo.stop(), { serverStopped: true, rootRemoved: true }); }
  await assert.rejects(demo.launchWorkflow("after-stop", 'return "no";'), /runtime is stopped/);
});

void test("V0-D live demo walkthrough in real headless Chrome: Gantt first, lazy map, runtime update, detail/back, close/reopen and >16-agent partial view", { skip: chrome || requireChrome ? false : "PI_TRAJECTORY_CHROME is not set to a Chrome/Chromium executable (PI_TRAJECTORY_REQUIRE_CHROME=1 turns this into a failure)", timeout: 240_000 }, async (t) => {
  assert.ok(chrome, "PI_TRAJECTORY_REQUIRE_CHROME=1 requires a Chrome/Chromium executable");
  const evidenceDir = process.env.PI_TRAJECTORY_DEMO_EVIDENCE ?? mkdtempSync(join(tmpdir(), "piewf-demo-evidence-"));
  const demo = await startLiveDemo({ paceMs: 100, overflow: true });
  let stopped: { serverStopped: boolean; rootRemoved: boolean } | undefined;
  try {
    await waitForAgent(demo, "synthesizer", "running");
    const observed = await runLiveDemoWalkthrough({ demo, chrome, evidenceDir });
    assert.equal(observed.initialTab, "timeline-tab", "the Gantt timeline is the initial view");
    assert.equal(observed.mapRequestsBeforeClick, 0, "no map asset is requested before the Map tab is clicked");
    assert.equal(observed.iframesBeforeClick, 0);
    assert.equal(observed.sandbox, "allow-scripts");
    assert.match(observed.statusBeforeTranscript, /^Partial graph · \d+ nodes$/);
    const agentStatus = (nodes: typeof observed.nodesBeforeTranscript, label: string) => nodes.find((node) => node.kind === "agent" && node.label === label)?.status;
    assert.equal(agentStatus(observed.nodesBeforeTranscript, "synthesizer"), "running");
    assert.equal(agentStatus(observed.nodesBeforeTranscript, "auditor"), "failure");
    assert.equal(agentStatus(observed.nodesBeforeTranscript, "reviewer"), undefined);
    assert.ok(observed.releaseToVisibleMs >= 0, "the runtime update reached the open map");
    assert.equal(agentStatus(observed.nodesAfterUpdate, "synthesizer"), "success");
    assert.equal(agentStatus(observed.nodesAfterUpdate, "reviewer"), "success");
    assert.equal(observed.failedDetail.crumb, "auditor");
    assert.ok(observed.failedDetail.transcriptRequested, "the auditor transcript with its failed read loads on demand");
    assert.equal(observed.resultDetail.crumb, "synthesizer");
    assert.match(observed.resultDetail.outputText, /bounds check/, "the recorded synthesizer result is visible in the inspector");
    assert.ok(observed.nodesAfterTranscript.length >= observed.nodesBeforeTranscript.length);
    assert.equal(observed.mapRequestsAfterCloseDelay, observed.mapRequestsAtClose, "a closed map makes no later request");
    assert.match(observed.reopenStatus, /^Partial graph/);
    assert.equal(observed.runStateAfterReopen, "completed", "closing and reopening the map does not act on the run");
    assert.ok(observed.overflow, "the >16-agent run was inspected");
    assert.equal(observed.overflow.persistedAgents, 18);
    assert.ok(observed.overflow.visibleAgentNodes <= 16 && observed.overflow.visibleAgentNodes < observed.overflow.persistedAgents, JSON.stringify(observed.overflow));
    assert.match(observed.overflow.completeness, /^Partial graph/);
    assert.equal(observed.overflow.pagerLabel, "Agents 1–16 of 18");
    assert.equal(observed.overflow.secondPageLabel, "Agents 17–18 of 18");
    assert.equal(observed.overflow.secondPageAgentNodes, 2, "the second page draws the remaining agents");
    const firstPage = observed.overflow.firstPageIds ?? [];
    assert.ok((observed.overflow.secondPageIds ?? []).every((id) => !firstPage.includes(id)), "pages do not overlap");
    assert.equal(observed.webSockets, 1, "the page opens exactly one WebSocket; the viewer adds none");
    assert.deepEqual(observed.externalRequests, []);
    assert.deepEqual(observed.consoleErrors, []);
    assert.equal(observed.screenshots.length, 8, "seven walkthrough steps plus the second agent page");
    for (const file of observed.screenshots) assert.ok(statSync(file).size > 10_000 && readFileSync(file).subarray(1, 4).toString("latin1") === "PNG", file);
    t.diagnostic(`live demo: tab-to-ready=${observed.tabToReadyMs.toFixed(1)} ms; release-to-visible=${String(observed.releaseToVisibleMs)} ms (includes scripted model pace); nodes before/after transcripts=${String(observed.nodesBeforeTranscript.length)}/${String(observed.nodesAfterTranscript.length)}; overflow ${String(observed.overflow.visibleAgentNodes)}/${String(observed.overflow.persistedAgents)} agents drawn; evidence=${evidenceDir}`);
  } finally {
    stopped = await demo.stop();
    if (process.env.PI_TRAJECTORY_DEMO_EVIDENCE === undefined) rmSync(evidenceDir, { recursive: true, force: true });
  }
  assert.deepEqual(stopped, { serverStopped: true, rootRemoved: true });
  assert.equal(await healthPid(demo.port), undefined);
});

void test("V0-D manual demo prints a live loopback URL, stays up after the run settles, and stops only on an explicit stop", { timeout: 180_000 }, async () => {
  const port = await availableLoopbackPort();
  const child = spawn(process.execPath, [demoScript, "--port", String(port), "--release-after", "0", "--pace", "20", "--no-overflow"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => { stdout += chunk; });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => { stderr += chunk; });
  const exited = new Promise<number | null>((resolve) => { child.once("exit", (code) => { resolve(code); }); });
  const waitForOutput = async (pattern: RegExp, timeoutMs = 60_000): Promise<RegExpExecArray> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) { const match = pattern.exec(stdout); if (match) return match; if (child.exitCode !== null) break; await delay(50); }
    throw new Error(`Manual demo output did not match ${String(pattern)}:\n${stdout}\n${stderr}`);
  };
  try {
    const url = (await waitForOutput(/^URL: (http:\/\/127\.0\.0\.1:\d+\/)$/m))[1];
    assert.ok(url);
    assert.equal(url, `http://127.0.0.1:${String(port)}/`);
    assert.match(stdout, /nothing is opened automatically/);
    assert.match(stdout, /Stop: press Ctrl\+C/);
    const root = (await waitForOutput(/^Demo root \(isolated HOME\/agent dir, removed on stop\): (.+)$/m))[1]?.trim() ?? "";
    const page = await fetch(url, { signal: AbortSignal.timeout(5_000) });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type") ?? "", /text\/html/);
    await page.arrayBuffer();
    await waitForOutput(/^Main run is now completed\. Still serving/m);
    await delay(1_500);
    assert.equal(child.exitCode, null, "the manual demo keeps running after the scenario settles");
    assert.equal(typeof await healthPid(port), "number", "the URL is still live instead of already dead");
    if (process.platform === "win32") child.stdin.write("stop\n");
    else child.kill("SIGINT");
    const code = await Promise.race([exited, delay(30_000).then(() => "timeout" as const)]);
    assert.equal(code, 0, `${stdout}\n${stderr}`);
    assert.match(stdout, /Stopped: Trajectory server stopped=true; demo root removed=true/);
    assert.equal(await healthPid(port), undefined, "stop leaves no owned server behind");
    assert.equal(existsSync(root), false);
  } finally {
    if (child.exitCode === null) { child.kill(); await Promise.race([exited, delay(5_000)]); }
  }
});
