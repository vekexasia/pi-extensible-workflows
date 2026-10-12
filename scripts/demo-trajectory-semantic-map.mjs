#!/usr/bin/env node
// V0-D live demo of the Trajectory Semantic Map on the current working-tree build.
//
//   node scripts/demo-trajectory-semantic-map.mjs            manual: print a loopback URL and keep running until Ctrl+C (or a "stop" line on stdin)
//   node scripts/demo-trajectory-semantic-map.mjs --auto     automatic: headless Chrome walkthrough, screenshots, walkthrough.md, then full cleanup
//
// Options: --port <n> (never 7432), --release-after <seconds> (manual; default 30), --pace <ms>, --no-overflow,
//          --evidence <dir> (auto; default .tmp/archify/current-demo/<candidate-id>), --keep-root.
// Requires a built core (`npm run build -w packages/core`). The model is a local deterministic script; no provider is contacted.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { arch, platform, release } from "node:os";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distTest = join(root, "packages", "core", "dist", "trajectory", "test");

function usage(message) {
  if (message) process.stderr.write(`${message}\n`);
  process.stderr.write("Usage: node scripts/demo-trajectory-semantic-map.mjs [--auto] [--port <n>] [--release-after <s>] [--pace <ms>] [--no-overflow] [--evidence <dir>] [--keep-root]\n");
  process.exit(2);
}

function parseArgs(argv) {
  const options = { auto: false, port: undefined, releaseAfter: 30, pace: undefined, overflow: true, evidence: undefined, keepRoot: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const value = () => { const next = argv[index + 1]; if (next === undefined) usage(`${arg} requires a value`); index += 1; return next; };
    if (arg === "--auto") options.auto = true;
    else if (arg === "--manual") options.auto = false;
    else if (arg === "--port") { const port = Number(value()); if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 7432) usage("--port must be a free port other than 7432"); options.port = port; }
    else if (arg === "--release-after") { const seconds = Number(value()); if (!Number.isFinite(seconds) || seconds < 0) usage("--release-after must be a non-negative number"); options.releaseAfter = seconds; }
    else if (arg === "--pace") { const pace = Number(value()); if (!Number.isInteger(pace) || pace < 0 || pace > 10_000) usage("--pace must be 0..10000 ms"); options.pace = pace; }
    else if (arg === "--no-overflow") options.overflow = false;
    else if (arg === "--evidence") options.evidence = resolve(value());
    else if (arg === "--keep-root") options.keepRoot = true;
    else if (arg === "--help" || arg === "-h") usage();
    else usage(`Unknown argument: ${arg}`);
  }
  return options;
}

function git(args) {
  try { return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], windowsHide: true, maxBuffer: 64 * 1024 * 1024 }); } catch { return undefined; }
}

/** Candidate identity: HEAD plus a digest of every dirty or untracked file's current bytes. */
function candidateIdentity() {
  const head = git(["rev-parse", "HEAD"])?.trim() ?? "no-git";
  const status = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"]) ?? "";
  const entries = status.split("\0").filter(Boolean);
  const hash = createHash("sha256").update(`${head}\n`);
  const files = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    const code = entry.slice(0, 2);
    const path = entry.slice(3);
    if (code.includes("R") || code.includes("C")) index += 1;
    const absolute = join(root, path);
    let digest = "missing";
    try { digest = createHash("sha256").update(readFileSync(absolute)).digest("hex"); } catch { /* Deleted or a directory. */ }
    files.push({ code, path, sha256: digest });
    hash.update(`${code} ${path} ${digest}\n`);
  }
  const fingerprint = hash.digest("hex");
  return { head, dirtyEntries: files.length, fingerprint, id: `${head.slice(0, 7)}-${fingerprint.slice(0, 12)}`, files };
}

async function loadModules() {
  const fixture = join(distTest, "live-demo-fixture.js");
  if (!existsSync(fixture)) {
    process.stderr.write(`Missing ${relative(root, fixture)}. Build the core first: npm run build -w packages/core\n`);
    process.exit(2);
  }
  const demo = await import(pathToFileURL(fixture).href);
  const browser = await import(pathToFileURL(join(distTest, "live-demo-browser.js")).href);
  const assets = await import(pathToFileURL(join(root, "packages", "core", "dist", "trajectory", "src", "semantic-map-assets.js")).href);
  return { demo, browser, stamp: assets.SEMANTIC_MAP_BUILD_STAMP };
}

function print(line) { process.stdout.write(`${line}\n`); }

async function manual(options, modules) {
  const demo = await modules.demo.startLiveDemo({ ...(options.port === undefined ? {} : { port: options.port }), paceMs: options.pace ?? 600, overflow: options.overflow });
  let stopping = false;
  let releaseTimer;
  const stop = async (reason) => {
    if (stopping) return;
    stopping = true;
    clearTimeout(releaseTimer);
    print(`Stopping (${reason})...`);
    const result = await demo.stop({ keepRoot: options.keepRoot });
    print(`Stopped: Trajectory server stopped=${String(result.serverStopped)}; demo root removed=${String(result.rootRemoved)}${options.keepRoot ? ` (kept ${demo.root})` : ""}.`);
    process.exit(result.serverStopped ? 0 : 1);
  };
  process.on("SIGINT", () => { void stop("Ctrl+C"); });
  process.on("SIGTERM", () => { void stop("SIGTERM"); });
  if (process.platform === "win32") process.on("SIGBREAK", () => { void stop("Ctrl+Break"); });
  // A literal "stop" line is an explicit stop for non-console callers; end of stdin is ignored so the URL stays alive.
  createInterface({ input: process.stdin }).on("line", (line) => { if (line.trim() === "stop") void stop("stop requested on stdin"); });
  print("Trajectory Semantic Map live demo (V0-D) - deterministic local simulation");
  print(`Build stamp: ${modules.stamp}`);
  print(`Demo root (isolated HOME/agent dir, removed on stop): ${demo.root}`);
  print(`Main run: ${demo.runId}${demo.overflowRunId ? `; overflow run (${String(modules.demo.LIVE_DEMO_OVERFLOW_AGENTS)} agents): ${demo.overflowRunId}` : ""}`);
  print(`URL: ${demo.url}`);
  print("Open the URL yourself in a browser (nothing is opened automatically):");
  print(`  PowerShell:  Start-Process "${demo.url}"`);
  print(`  cmd:         start "" "${demo.url}"`);
  print(`  Linux/macOS: xdg-open "${demo.url}"  /  open "${demo.url}"`);
  print(`Walkthrough: select "${modules.demo.LIVE_DEMO_WORKFLOW}", Gantt is the first view; open the "Semantic Map" tab; the synthesizer stays running until the scripted update ${options.releaseAfter > 0 ? `in ${String(options.releaseAfter)} s` : "now"}.`);
  print("Stop: press Ctrl+C (or type stop and Enter). The demo keeps running until then.");
  releaseTimer = setTimeout(() => { demo.release(); print("Scripted runtime update released: synthesizer and reviewer will now complete."); }, options.releaseAfter * 1000);
  await demo.waitForRunState(demo.runId, ["completed", "failed"], 24 * 60 * 60 * 1000).then((state) => { print(`Main run is now ${state}. Still serving ${demo.url} until stopped.`); }, () => undefined);
  await new Promise(() => undefined);
}

function walkthroughMarkdown({ identity, stamp, chrome, command, demo, observation, expected, runRecord, cleanup }) {
  const agents = (runRecord.agents ?? []).map((agent) => `| ${agent.name} | ${agent.state} | ${(agent.structuralPath ?? []).join(" / ") || "(top level)"} | ${agent.attemptDetails?.at(-1)?.error?.code ?? ""} |`).join("\n");
  const nodeLine = (nodes) => nodes.filter((node) => node.kind === "agent" && !node.label.includes(" · attempt ")).map((node) => `${node.label}=${node.status}`).join(", ");
  const kinds = (nodes) => Object.entries(nodes.reduce((counts, node) => { counts[node.kind] = (counts[node.kind] ?? 0) + 1; return counts; }, {})).map(([kind, count]) => `${kind}:${String(count)}`).join(", ");
  return `# Trajectory Semantic Map V0-D walkthrough

Status: **V0-D preview executed locally** (not E4 closure, not deployed, owner feedback pending).

- Candidate: \`${identity.id}\` (HEAD ${identity.head}, ${String(identity.dirtyEntries)} dirty/untracked entries, fingerprint ${identity.fingerprint})
- Semantic Map build stamp: \`${stamp}\`
- Toolchain: Node ${process.version}, ${platform()} ${release()} ${arch()}; browser: headless Chrome at \`${chrome}\` with a temporary profile
- Command: \`${command}\`
- Session: \`${demo.sessionId}\`; main run \`${demo.runId}\`${demo.overflowRunId ? `; overflow run \`${demo.overflowRunId}\`` : ""}

## What is real and what is simulated

Real: workflow host and sandboxed script, scheduler, local Pi agent sessions and their JSONL transcripts, the built-in \`read\`/\`ls\` tools on a generated project, run persistence, the Trajectory publisher and loaders, the detached Trajectory server (own port, own lock in the isolated agent dir), WebSocket, production UI, private bridge and opaque viewer.
Simulated: the model. A loopback OpenAI-compatible endpoint replays a fixed script (tool calls, one text-only agent that never submits a result, final \`workflow_result\` calls) and holds the synthesizer's final reply until released. No provider or network service is contacted.

## Expected vs observed

| Item | Expected | Observed |
| --- | --- | --- |
| Agents / phases | ${String(expected.agents)} agents, phases ${expected.phases.join(" -> ")} | ${String(runRecord.agents?.length ?? 0)} agents, final run state ${runRecord.state} |
| Controlled error | auditor fails (no workflow_result after one repair) | ${(runRecord.agents ?? []).filter((agent) => agent.state === "failed").map((agent) => `${agent.name}: ${agent.attemptDetails?.at(-1)?.error?.code ?? "?"}`).join("; ") || "none"} |
| First view | Gantt tab, no map assets requested | tab \`${observation.initialTab}\`, ${String(observation.mapRequestsBeforeClick)} map requests, ${String(observation.iframesBeforeClick)} iframes |
| Map open | opaque viewer, sandbox allow-scripts | sandbox \`${observation.sandbox}\`, ready in ${observation.tabToReadyMs.toFixed(1)} ms, status "${observation.statusBeforeTranscript}" |
| Runtime update | synthesizer running -> completed, reviewer appears | visible ${String(observation.releaseToVisibleMs)} ms after release (includes the scripted model pace and reviewer turns) |
| Close / reopen | no revive, no late requests, run unchanged | viewer document requests seen by the parent page: ${String(observation.mapRequestsAtClose)} at close, ${String(observation.mapRequestsAfterCloseDelay)} 400 ms later; reopen "${observation.reopenStatus}"; run ${observation.runStateAfterReopen} |
| Error and result in the inspector | auditor transcript shows the failed read; synthesizer Output shows its recorded result | auditor failed read shown: ${String(observation.failedDetail.transcriptRequested)}; synthesizer output contains "bounds check": ${String(observation.resultDetail.outputText.includes("bounds check"))} |
| Connections | one UI WebSocket, no external requests, no console errors | ${String(observation.webSockets)} WebSocket(s); ${String(observation.externalRequests.length)} external; ${String(observation.consoleErrors.length)} console errors |
${observation.overflow ? `| >16 agents | view limited, explicitly partial, data kept on disk | ${String(observation.overflow.visibleAgentNodes)} of ${String(observation.overflow.persistedAgents)} persisted agents drawn; "${observation.overflow.completeness}" |\n` : ""}
Persisted agents (source of truth, read back through RunStore):

| Agent | State | Structural path | Error |
| --- | --- | --- | --- |
${agents}

## Walkthrough

1. \`01-gantt-running.png\` - Gantt is the initial view while the synthesizer is still running; the map has not loaded any asset.
2. \`02-map-before-transcript.png\` - Map opened before any transcript was viewed. Agents: ${nodeLine(observation.nodesBeforeTranscript)}. Node kinds: ${kinds(observation.nodesBeforeTranscript)}. Notice: "${observation.completenessBeforeTranscript}".
3. \`03-map-after-runtime-update.png\` - after the scripted runtime update: ${nodeLine(observation.nodesAfterUpdate)}.
4. \`04-detail-controlled-error.png\` - map double-click opens the auditor's detail/transcript (controlled failure).
5. \`05-detail-recorded-result.png\` - synthesizer detail with its recorded result.
6. \`06-map-after-transcripts.png\` - back on the map after opening transcripts. Node kinds: ${kinds(observation.nodesAfterTranscript)} (before transcripts: ${kinds(observation.nodesBeforeTranscript)}).
${observation.overflow ? `7. \`07-overflow-partial-map.png\` - ${String(observation.overflow.persistedAgents)}-agent run: the map draws ${String(observation.overflow.visibleAgentNodes)} agent nodes and says "${observation.overflow.completeness}". The map pages agents 16 at a time (bounded projection per page), not data loss: all agents stay in the persisted run and the Gantt.
8. \`08-overflow-second-page.png\` - the same run after the \`›\` page button: ${String(observation.overflow.secondPageLabel ?? "")}, ${String(observation.overflow.secondPageAgentNodes ?? 0)} agent boxes; the workflow totals still cover all ${String(observation.overflow.persistedAgents)} agents.\n` : ""}
## V0 limits (explicit)

- Phases are not drawn as map nodes. They are visible in the Gantt agent table ("PHASE discover", "PHASE synthesize") and the inspector's Phase row. On the map, the \`parallel\` keys of phase one (discover, docs, source, audit) appear as task nodes; the top-level sequential synthesizer/reviewer have an empty structural path and V0 draws no recorded dependency edge between them.
- Tool calls on the map come from recorded tool timing plus the parent transcript cache; compare node kinds in steps 2 and 6. Nothing was preloaded.
- The map is live-only; the static export and these PNGs are not interactive map exports.
- Parent projection limits 16 agents / 8 relations / 16 structural segments; renderer limits 500 nodes / 1500 edges.

## Cleanup

${cleanup}

## Not covered here

Linux G5-G7 gates, the packaged/installed consumer, W9 public/personal deployment, performance/heap acceptance (BROWSER_ACCEPTANCE) and owner feedback (pending: the owner has not reviewed this material yet).
`;
}

async function automatic(options, modules) {
  const chrome = modules.browser.findChrome();
  if (!chrome) { process.stderr.write("Automatic mode needs Chrome/Chromium: set PI_TRAJECTORY_CHROME to its executable.\n"); process.exit(2); }
  const identity = candidateIdentity();
  const evidenceDir = options.evidence ?? join(root, ".tmp", "archify", "current-demo", identity.id);
  mkdirSync(evidenceDir, { recursive: true });
  const command = `node scripts/demo-trajectory-semantic-map.mjs ${process.argv.slice(2).join(" ")}`.trim();
  print(`Evidence directory: ${evidenceDir}`);
  const demo = await modules.demo.startLiveDemo({ ...(options.port === undefined ? {} : { port: options.port }), paceMs: options.pace ?? 150, overflow: options.overflow });
  let observation;
  let runRecord;
  let overflowRecord;
  let failure;
  try {
    print(`Live URL (owned by this run, closed at the end): ${demo.url}`);
    for (const deadline = Date.now() + 60_000; Date.now() < deadline;) {
      const run = await demo.loadRun(demo.runId);
      if ((run.agents ?? []).some((agent) => agent.name === "synthesizer" && agent.state === "running")) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    observation = await modules.browser.runLiveDemoWalkthrough({ demo, chrome, evidenceDir, log: print });
    await demo.waitForRunState(demo.runId, ["completed", "failed"], 60_000);
    runRecord = await demo.loadRun(demo.runId);
    if (demo.overflowRunId) overflowRecord = await demo.loadRun(demo.overflowRunId);
  } catch (error) { failure = error; }
  const cleanupResult = await demo.stop({ keepRoot: options.keepRoot });
  const cleanup = `Trajectory server stopped: ${String(cleanupResult.serverStopped)}; isolated demo root removed: ${String(cleanupResult.rootRemoved)}; headless Chrome and its temporary profile closed by the walkthrough.`;
  if (failure) { process.stderr.write(`${failure instanceof Error ? failure.stack ?? failure.message : String(failure)}\n${cleanup}\n`); process.exit(1); }
  const payload = { identity: { ...identity, files: undefined }, stamp: modules.stamp, node: process.version, os: `${platform()} ${release()} ${arch()}`, chrome, command, sessionId: demo.sessionId, runId: demo.runId, overflowRunId: demo.overflowRunId, modelRequests: demo.modelRequests, observation, run: { state: runRecord.state, agents: runRecord.agents.map((agent) => ({ name: agent.name, state: agent.state, structuralPath: agent.structuralPath, error: agent.attemptDetails?.at(-1)?.error })) }, overflow: overflowRecord ? { state: overflowRecord.state, agents: overflowRecord.agents.length } : undefined, cleanup: cleanupResult };
  writeFileSync(join(evidenceDir, "observations.json"), `${JSON.stringify(payload, null, 2)}\n`);
  writeFileSync(join(evidenceDir, "fingerprint.json"), `${JSON.stringify(identity, null, 2)}\n`);
  writeFileSync(join(evidenceDir, "walkthrough.md"), walkthroughMarkdown({ identity, stamp: modules.stamp, chrome, command, demo, observation, expected: modules.demo.LIVE_DEMO_EXPECTED, runRecord, cleanup }));
  print(`Walkthrough: ${join(evidenceDir, "walkthrough.md")}`);
  print(cleanup);
  process.exit(cleanupResult.serverStopped ? 0 : 1);
}

const options = parseArgs(process.argv.slice(2));
const modules = await loadModules();
if (options.auto) await automatic(options, modules);
else await manual(options, modules);
