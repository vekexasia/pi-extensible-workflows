import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createTrajectoryRunLoader, createTrajectoryRunMetadataLoader, createTrajectorySubagentLoader, createTrajectoryTranscriptLoader, applySystemPrompts, applyToolDescriptions, TRAJECTORY_MAX_TRANSCRIPT_BYTES } from "../../src/trajectory.js";
import { trajectoryUrl } from "../src/index.js";
import { RunStore } from "../../src/persistence.js";
import { createLaunchSnapshot } from "../../src/utils.js";
import type { PersistedRun } from "../../src/persistence.js";

void test("applySystemPrompts fills missing prompts from session records", () => {
  const run = { agents: [{ id: "a", attemptDetails: [{ session: { transport: "local", sessionId: "s1" } }] }, { id: "b", systemPrompt: "keep", attemptDetails: [{ session: { transport: "local", sessionId: "s2" } }] }] } as unknown as PersistedRun;
  const next = applySystemPrompts(run, [{ sessionId: "s1", attempt: 1, turn: 1, sha256: "x", prompt: "hello" }, { sessionId: "s2", attempt: 1, turn: 1, sha256: "y", prompt: "ignored" }]);
  assert.equal(next.agents[0]?.systemPrompt, "hello");
  assert.equal(next.agents[1]?.systemPrompt, "keep");
});

void test("applyToolDescriptions fills missing Pi tool descriptions", () => {
  const run = { agents: [{ tools: ["bash", "view_image"], toolDefinitions: [{ name: "keep", description: "kept" }] }, { tools: ["bash", "view_image"] }] } as unknown as PersistedRun;
  const next = applyToolDescriptions(run, new Map([["bash", "Execute a bash command"]]));
  assert.deepEqual(next.agents[0]?.toolDefinitions, [{ name: "keep", description: "kept" }]);
  assert.deepEqual(next.agents[1]?.toolDefinitions, [{ name: "bash", description: "Execute a bash command" }]);
});

void test("trajectoryUrl does not include an auth token", () => {
  assert.equal(trajectoryUrl(7432), "http://127.0.0.1:7432/");
});
function writeSubagentFixture(agentDir: string, id: string, sessionId: string, state: "running" | "failed" | "stopped" | "completed", sessionFile?: string, finishedAt?: number): void {
  const directory = join(agentDir, "subagents", id);
  mkdirSync(directory, { recursive: true });
  const request = { prompt: `prompt-${id}`, mode: "background", label: `label-${id}`, role: "reviewer", model: "fixture/model:medium", tools: ["read"], skills: [], extensions: [], contextFiles: ["cwd"], retries: 1, timeoutMs: 1000 };
  const status = { id, sessionId, state, startedAt: 1, ...(finishedAt === undefined ? {} : { finishedAt }), attempts: 1, ...(sessionFile === undefined ? {} : { attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: `${id}-session`, locator: { sessionFile } }, setup: { hookNames: [], model: { provider: "fixture", model: "model" }, tools: ["read"], cwd: "/project" }, accounting: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }), progress: { accounting: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0 }, toolCalls: [], activity: { kind: "tool", text: "read" }, lastEventAt: 2 } };
  writeFileSync(join(directory, "request.json"), JSON.stringify(request));
  writeFileSync(join(directory, "status.json"), JSON.stringify(status));
  if (state === "completed") writeFileSync(join(directory, "result.json"), JSON.stringify({ id }));
  if (state === "failed") writeFileSync(join(directory, "failure.json"), JSON.stringify({ code: "AGENT_FAILED", message: `failure-${id}` }));
}
void test("trajectory loads first-class subagents with filtering, ordering, transcripts, and corrupt-entry isolation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-subagents-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const transcriptPath = join(root, "subagent.jsonl");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(transcriptPath, `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "hello" }] } })}\n`);
  writeSubagentFixture(agentDir, "running", "session", "running");
  writeSubagentFixture(agentDir, "failed", "session", "failed", undefined, 4);
  writeSubagentFixture(agentDir, "stopped", "session", "stopped", undefined, 3);
  writeSubagentFixture(agentDir, "completed", "session", "completed", undefined, 2);
  writeSubagentFixture(agentDir, "with-transcript", "session", "completed", transcriptPath, 5);
  writeSubagentFixture(agentDir, "oversized-result", "session", "completed", undefined, 6);
  writeFileSync(join(agentDir, "subagents", "oversized-result", "result.json"), JSON.stringify("x".repeat(2 * 1024 * 1024)));
  writeSubagentFixture(agentDir, "oversized-failure", "session", "failed", undefined, 7);
  writeFileSync(join(agentDir, "subagents", "oversized-failure", "failure.json"), JSON.stringify({ code: "AGENT_FAILED", message: "x".repeat(2 * 1024 * 1024) }));
  writeSubagentFixture(agentDir, "other-session", "other", "running");
  mkdirSync(join(agentDir, "subagents", "corrupt"), { recursive: true });
  writeFileSync(join(agentDir, "subagents", "corrupt", "status.json"), "{");
  try {
    const subagents = await createTrajectorySubagentLoader(cwd, "session", agentDir)();
    assert.deepEqual(subagents.map((subagent) => subagent.id), ["running", "oversized-failure", "failed", "stopped", "oversized-result", "with-transcript", "completed"]);
    const current = subagents.find((subagent) => subagent.id === "with-transcript");
    assert.ok(current);
    assert.equal(current.progress?.activity, undefined);
    assert.equal(current.sessionId, "session");
    assert.equal(current.request.prompt, "prompt-with-transcript");
    assert.deepEqual(current.tools, ["read"]);
    assert.deepEqual(current.toolDefinitions?.map((tool) => tool.name), ["read"]);
    const locator = current.attempt?.session?.locator;
    assert.equal(typeof locator === "object" && locator !== null && !Array.isArray(locator) && "sessionFile" in locator ? locator.sessionFile : undefined, transcriptPath);
    assert.equal(current.transcript.length, 1);
    assert.deepEqual(current.result, { id: "with-transcript" });
    const failed = subagents.find((subagent) => subagent.id === "failed");
    assert.deepEqual(failed?.failure, { code: "AGENT_FAILED", message: "failure-failed" });
    const oversizedResult = subagents.find((subagent) => subagent.id === "oversized-result");
    assert.deepEqual(oversizedResult?.result, { truncated: true, path: join(agentDir, "subagents", "oversized-result", "result.json"), bytes: 2 * 1024 * 1024 + 2 });
    const oversizedFailure = subagents.find((subagent) => subagent.id === "oversized-failure");
    assert.deepEqual(oversizedFailure?.failure, { truncated: true, path: join(agentDir, "subagents", "oversized-failure", "failure.json"), bytes: 2 * 1024 * 1024 + 36 });
    assert.equal(subagents.some((subagent) => subagent.id === "other-session"), false);
    assert.equal(subagents.some((subagent) => subagent.id === "corrupt"), false);
    const foreignTranscript = await createTrajectoryTranscriptLoader("/project", "session", "/home", agentDir)({ subagentId: "other-session" });
    assert.equal(foreignTranscript.status, "missing");
    assert.deepEqual(foreignTranscript.entries, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
void test("Trajectory overlays live subagent status over stale persisted status", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-subagent-overlay-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  writeSubagentFixture(agentDir, "live", "session", "completed", undefined, 4);
  let live = false;
  const loader = createTrajectorySubagentLoader(cwd, "session", agentDir, (subagent) => live ? { ...subagent, request: { ...subagent.request, prompt: "live" }, state: "running", progress: { accounting: { input: 9, output: 8, cacheRead: 0, cacheWrite: 0, cost: 0 }, toolCalls: [], activity: { kind: "tool", text: "fresh" }, lastEventAt: 10 } } : subagent);
  try {
    const persisted = await loader();
    assert.equal(persisted[0]?.state, "completed");
    live = true;
    const overlay = await loader();
    assert.equal(overlay[0]?.state, "running");
    const current = overlay[0];
    assert.ok(current);
    assert.equal(current.request.prompt, "live");
    assert.equal(current.progress?.activity?.text, "fresh");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
void test("Trajectory transcript loader follows the live subagent attempt", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-subagent-transcript-overlay-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  const persistedPath = join(root, "persisted.jsonl");
  const livePath = join(root, "live.jsonl");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(persistedPath, `${JSON.stringify({ type: "message", text: "persisted" })}\n`);
  writeFileSync(livePath, `${JSON.stringify({ type: "message", text: "live" })}\n`);
  writeSubagentFixture(agentDir, "live", "session", "running", persistedPath);
  try {
    const loader = createTrajectoryTranscriptLoader(cwd, "session", join(root, "home"), agentDir, () => ({ transport: "local", sessionId: "live-session", locator: { sessionFile: livePath } }));
    const result = await loader({ subagentId: "live" });
    assert.equal(result.status, "available");
    assert.equal((result.entries[0] as { text?: unknown }).text, "live");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void test("Trajectory preference storage failures preserve defaults", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    const defaultRunLayout");
  const helperEnd = source.indexOf("    const state", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const storage = {
    getItem: () => { throw new Error("storage unavailable"); },
    setItem: () => { throw new Error("storage unavailable"); },
  };
  const helpers = runInNewContext(`(() => { ${source.slice(helperStart, helperEnd)}; const state = { runLayout: defaultRunLayout(), sidebarCollapsed: new Set() }; return { loadRunLayout, loadSidebarCollapsed, saveRunLayout, saveSidebarCollapsed }; })()`, { localStorage: storage }) as {
    loadRunLayout: () => { swimHeight: number; ganttCollapsed: boolean; agentsCollapsed: boolean; logsCollapsed: boolean };
    loadSidebarCollapsed: () => Set<string>;
    saveRunLayout: () => void;
    saveSidebarCollapsed: () => void;
  };
  assert.deepEqual({ ...helpers.loadRunLayout() }, { swimHeight: 220, ganttCollapsed: false, agentsCollapsed: false, logsCollapsed: false });
  assert.deepEqual([...helpers.loadSidebarCollapsed()], []);
  assert.doesNotThrow(() => { helpers.saveRunLayout(); });
  assert.doesNotThrow(() => { helpers.saveSidebarCollapsed(); });
});

void test("Trajectory theme preference storage failures preserve the default", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    function renderThemeButtons");
  const helperEnd = source.indexOf("    function renderSidebar", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  let clickHandler: (() => void) | undefined;
  const button = { dataset: { theme: "harness" }, addEventListener: (_type: string, handler: () => void) => { clickHandler = handler; }, classList: { toggle: () => {} } };
  const themeButtons = { innerHTML: "", classList: { toggle: () => {} }, querySelectorAll: () => [button] };
  const document = { documentElement: { dataset: {} as Record<string, string> } };
  const helpers = runInNewContext(`(() => { const state = { publishers: [{ themes: true }] }; const $ = () => themeButtons; const patch = (root, html) => { root.innerHTML = html; }; ${source.slice(helperStart, helperEnd)}; return { document, renderThemeButtons }; })()`, { document, localStorage: { getItem: () => { throw new Error("storage unavailable"); }, setItem: () => { throw new Error("storage unavailable"); } }, themeButtons }) as { document: typeof document; renderThemeButtons: () => void };
  helpers.renderThemeButtons();
  assert.equal(helpers.document.documentElement.dataset.theme, "tty");
  assert.doesNotThrow(() => { clickHandler?.(); });
});

void test("Trajectory agent grid groups persisted agent scopes", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  assert.match(source, /function agentGridGroups\(agents\)/);
  assert.match(source, /JSON\.stringify\(\[agent\.structuralPath \?\? \[\], agent\.parentBreadcrumb \?\? null\]\)/);
  assert.match(source, /agentGridGroups\(phaseAgents\)/);
  assert.match(source, /class="agent-grid-scope"/);
  assert.match(source, /class="agent-cell" title="\$\{esc\(toolSummary\)\}"/);
  assert.doesNotMatch(source, /const path = \[\.\.\.\(agent\.parentBreadcrumb/);
});

void test("Trajectory run view renders the complete persisted log stream", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  assert.match(source, /function renderLogs\(record\)/);
  assert.match(source, /filter\(\(event\) => event\.type === "log"\)/);
  assert.match(source, /fmtClock\(event\.timestamp\)/);
  assert.match(source, /class="logs-list"/);
  assert.match(source, /renderLogs\(record\)/);
  assert.match(source, /\.logs-list \{[^}]*overflow: auto/);
  assert.match(source, /\.log-message \{[^}]*white-space: pre-wrap/);
  assert.doesNotMatch(source, /slice\(-5\)/);
});

void test("Trajectory agent view requests a compacted transcript on demand", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  assert.match(source, /function requestTranscript\(/);
  assert.match(source, /type: "ui:transcript"/);
  assert.match(source, /message\.type === "transcript"/);
  assert.match(source, /requestTranscript\(found, agent\.id\)/);
  assert.match(source, /publisherId: found\.publisher\.id, runId: found\.record\.run\.id, agentId, \.\.\.\(revision === undefined \? \{\} : \{ revision \}\)/);
});

void test("Trajectory timelines keep cursors and agent-only range selection", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  assert.match(source, /bindTimeCursor\(\$\("swim"\), "\.axis \.ticks"\)/);
  assert.match(source, /bindTimeCursor\(\$\("agent-timeline"\), "\.axis \.ticks", \$\("events"\)\)/);
  assert.match(source, /bindBrush\(\$\("agent-timeline"\), "\.axis \.ticks", setAgentRange\)/);
  assert.doesNotMatch(source, /bindBrush\(\$\("swim"\)/);
  assert.doesNotMatch(source, /runRange/);
  assert.match(source, /id="reset-agent-range"/);
  assert.match(source, /\.swim \.lane \{ grid-template-columns: 16px 56px 1fr; \}/);
  assert.match(source, /\.swim \.axis \{ grid-template-columns: 80px 1fr; \}/);
  assert.match(source, /const middle = hasTime \? `\+\$\{fmtRuntime\(span \/ 2\)\}` : "—"/);
  assert.match(source, /if \(!hasTime\) state\.agentRange = null/);
  assert.match(source, /root\.dataset\.timelineHasTime !== "true"/);
  assert.doesNotMatch(source, /paintBrush\(root, selector, range\); callback\(range\)/);
  assert.doesNotMatch(source, /\.range-edge\.end\.stacked \{ top: -31px; \}/);
  assert.match(source, /function renderGantt\(record, timingsByAgent\)/);
  assert.doesNotMatch(source, /summary !== "—"/);
  assert.doesNotMatch(source, /agent-path/);
});
void test("Trajectory transcript hover positions the agent timeline cursor", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    function bindTimeCursor");
  const helperEnd = source.indexOf("    function openScript", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const result = runInNewContext(`(() => {
    const classes = new Set(["hidden"]);
    const label = { textContent: "" };
    const cursor = { style: {}, classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) }, querySelector: () => label };
    const track = { getBoundingClientRect: () => ({ left: 100, width: 200 }) };
    const root = { dataset: { timelineHasTime: "true", timelineStart: "1000", timelineSpan: "1000" }, scrollTop: 0, handlers: {}, querySelector: (selector) => selector === ":scope > .now" ? cursor : track, getBoundingClientRect: () => ({ left: 90 }), addEventListener: (name, handler) => { root.handlers[name] = handler; } };
    const events = { handlers: {}, addEventListener: (name, handler) => { events.handlers[name] = handler; } };
    const fmtClock = (stamp) => String(stamp);
    ${source.slice(helperStart, helperEnd)}
    bindTimeCursor(root, ".axis .ticks", events);
    events.handlers.mouseover({ target: { closest: () => ({ dataset: { t: "25" } }) } });
    const hiddenAfterHover = classes.has("hidden");
    events.handlers.mouseleave();
    return { left: cursor.style.left, label: label.textContent, hiddenAfterHover, hiddenAfterLeave: classes.has("hidden") };
  })()`) as { left: string; label: string; hiddenAfterHover: boolean; hiddenAfterLeave: boolean };
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { left: "60px", label: "1250", hiddenAfterHover: false, hiddenAfterLeave: true });
  assert.match(source, /bindTimeCursor\(\$\("agent-timeline"\), "\.axis \.ticks", \$\("events"\)\)/);
});

void test("Trajectory run layout supports bounded Gantt resizing and persisted section toggles", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  assert.match(source, /--swim: 220px/);
  assert.match(source, /\.swim \{[^}]*height: var\(--swim\)[^}]*overflow-y: auto/);
  assert.match(source, /\.swim \.axis \{ position: sticky; top: 0; z-index: 4; background: var\(--bg-2\); \}/);
  assert.match(source, /\.swim > \.now \{ top: 22px; bottom: 8px; z-index: 5; \}/);
  assert.match(source, /#toggle-gantt \{ padding: 0 14px; \}/);
  assert.match(source, /\.section-toggle \{[^}]*font: inherit;[^}]*cursor: pointer;/);
  assert.match(source, /id="split-swim"/);
  assert.match(source, /bindSplit\(\$\("split-swim"\), "--swim", 72, maxSwimHeight, \{ axis: "y"/);
  assert.match(source, /const start = axis === "y" \? event\.clientY : event\.clientX;/);
  assert.match(source, /const delta = axis === "y" \? coordinate - start : options\.direction === "left" \? coordinate - start : start - coordinate;/);
  assert.match(source, /translateY\(\$\{root\.scrollTop\}px\)/);
  assert.match(source, /root\.addEventListener\("scroll", syncCursor\)/);
  assert.match(source, /window\.addEventListener\("resize", clampSwimHeight\)/);
  assert.match(source, /data-toggle="gantt"/);
  assert.match(source, /data-toggle="agents"/);
  assert.match(source, /data-toggle="logs"/);
  assert.match(source, /ganttCollapsed/);
  assert.match(source, /agentsCollapsed/);
  assert.match(source, /logsCollapsed/);
  assert.match(source, /localStorage\.getItem\("traj-run-layout"\)/);
  assert.match(source, /localStorage\.setItem\("traj-run-layout"/);
  assert.match(source, /splitSwim\.classList\.toggle\("hidden", ganttCollapsed\)/);
  assert.match(source, /function clampSwimHeight\(\) \{ renderRunLayout\(\); \}/);
  assert.match(source, /swimHeight: Number\.isFinite\(value\.swimHeight\) && value\.swimHeight >= 72 \? value\.swimHeight : fallback\.swimHeight/);
  assert.match(source, /const swimHeight = Math\.min\(state\.runLayout\.swimHeight, maxSwimHeight\(\)\)/);
  assert.match(source, /<div class="timeline" id="agent-timeline"><div id="agent-ticks"><\/div><div class="now hidden"><span><\/span><\/div><\/div>/);
  assert.match(source, /\.timeline \{ position: relative; \}/);
  assert.match(source, /\.timeline \.axis \{ grid-template-columns: 44px 1fr; gap: 8px; margin-bottom: 2px; \}/);
});

void test("Trajectory sidebar groups live publishers by full project folder", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const trajectorySourceUrl = [new URL("../src/index.ts", import.meta.url), new URL("../src/index.js", import.meta.url), new URL("../../src/trajectory.ts", import.meta.url), new URL("../../src/trajectory.js", import.meta.url)].find((url) => existsSync(url));
  assert.ok(trajectorySourceUrl);
  const trajectorySource = readFileSync(trajectorySourceUrl, "utf8");
  const helpers = loadTrajectorySidebarHelpers(source);
  const publisher = (id: string, cwd?: string) => cwd === undefined ? { id } : { id, cwd };
  const sameFolder = helpers.sidebarGroups([publisher("a", "/work/pi-workflows"), publisher("b", "/work/pi-workflows")]);
  assert.equal(sameFolder.length, 1);
  assert.deepEqual(Array.from(sameFolder[0]?.publishers || [], (value) => value.id), ["a", "b"]);
  const sharedBasename = helpers.sidebarGroups([publisher("a", "/tmp/pi-workflows"), publisher("b", "/work/pi-workflows")]);
  assert.equal(sharedBasename.length, 2);
  assert.deepEqual(Array.from(sharedBasename, (group) => group.key), ["/tmp/pi-workflows", "/work/pi-workflows"]);
  const unknown = helpers.sidebarGroups([publisher("a"), publisher("b", "")]);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0]?.label, "unknown");
  assert.deepEqual(Array.from(unknown[0].publishers, (value) => value.id), ["a", "b"]);
  assert.match(trajectorySource, /cwd: input\.cwd/);
  assert.doesNotMatch(trajectorySource, /cwd: basename\(input\.cwd\)/);
  const sidebarStart = source.indexOf("    function renderSidebar");
  const sidebarEnd = source.indexOf("    function renderGantt", sidebarStart);
  assert.ok(sidebarStart >= 0 && sidebarEnd > sidebarStart);
  const sidebarSource = source.slice(sidebarStart, sidebarEnd);
  assert.match(sidebarSource, /sidebarGroups\(livePublishers\(\)\)/);
  assert.doesNotMatch(sidebarSource, /livePublishers\(\)\.map/);
  assert.match(source, /data-sidebar-group/);
  assert.match(source, /localStorage\.getItem\("traj-sidebar-collapsed"\)/);
  assert.match(source, /localStorage\.setItem\("traj-sidebar-collapsed"/);
  assert.match(source, /type="button" class="folder/);
  assert.match(source, /\.run-item \{[^}]*display: flex/);
  assert.doesNotMatch(source, /\.run-item \{[^}]*display: grid/);
  assert.doesNotMatch(sidebarSource, /publisher\.cwd|connected|offline|class="meta"/);
});

void test("Trajectory returns to an empty home when a publisher disappears", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  assert.match(source, /const livePublishers = \(\) => state\.publishers\.filter\(\(publisher\) => publisher\.connected === true\)/);
  assert.match(source, /function renderSidebar\(\)/);
  assert.match(source, /sidebarGroups\(livePublishers\(\)\)/);
  assert.match(source, /function renderHome\(\)/);
  assert.match(source, /Select a run\./);
  assert.match(source, /function selectHome\(mode = "replace"\)/);
  assert.match(source, /let hasAcceptedState = false/);
  assert.match(source, /call\(history, \{ view: document\.body\.dataset\.view, run: target\?\.kind === "run" \? state\.currentRun : null, subagent:/);
  assert.match(source, /if \(value\.truncated === true && value\.publishers\.length === 0 && state\.publishers\.length > 0\) return/);
  assert.match(source, /value\.initial === true && hasAcceptedState/);
  assert.match(source, /setView\("run", mode\)/);
  assert.doesNotMatch(source, /if \(!selected\(\) && allRuns\(\)\[0\]/);
  assert.doesNotMatch(source, /state\.transcripts = \{\}; state\.transcriptPending = \{\};/);
  assert.doesNotMatch(source, /localStorage\.removeItem\("traj-theme"\)/);
});
void test("Trajectory drops transcript cache when a publisher generation changes", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const shareStart = source.indexOf("    function sharePublishers");
  const shareEnd = source.indexOf("    const livePublishers", shareStart);
  const invalidateStart = source.indexOf("    function invalidatePublisherTranscripts");
  const invalidateEnd = source.indexOf("    const transcriptEmptyMessage", invalidateStart);
  assert.ok(shareStart >= 0 && shareEnd > shareStart && invalidateStart > shareEnd && invalidateEnd > invalidateStart);
  const state = JSON.parse(JSON.stringify(runInNewContext(`(() => { const state = { transcripts: { "same\\trun\\tagent": [1] }, transcriptPending: { "same\\trun\\tagent": { requestId: "old" } }, transcriptSources: { "same\\trun\\tagent": "old" }, transcriptRefresh: { "same\\trun\\tagent": true }, transcriptRevision: { "same\\trun\\tagent": 1 }, transcriptStatus: { "same\\trun\\tagent": "disconnected" }, transcriptCacheOrder: ["same\\trun\\tagent"] }; const sharePublisher = (_previous, incoming) => incoming; ${source.slice(shareStart, shareEnd)} ${source.slice(invalidateStart, invalidateEnd)}; sharePublishers([{ id: "same", generation: 1 }], [{ id: "same", generation: 2 }]); return state; })()`) as unknown)) as unknown;
  assert.deepEqual(state, { transcripts: {}, transcriptPending: {}, transcriptSources: {}, transcriptRefresh: {}, transcriptRevision: {}, transcriptStatus: {}, transcriptCacheOrder: [] });
});

type TrajectorySidebarPublisher = { id: string; cwd?: string };
type TrajectorySidebarGroup = { key: string; label: string; publishers: readonly TrajectorySidebarPublisher[] };
type TrajectorySidebarHelpers = {
  sidebarGroupKey: (publisher: TrajectorySidebarPublisher) => string;
  sidebarGroupLabel: (key: string) => string;
  sidebarGroups: (publishers: readonly TrajectorySidebarPublisher[]) => readonly TrajectorySidebarGroup[];
};

function loadTrajectorySidebarHelpers(source: string): TrajectorySidebarHelpers {
  const helperStart = source.indexOf("    const sidebarGroupKey");
  const helperEnd = source.indexOf("    function renderSidebar", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  return runInNewContext(`(() => { ${source.slice(helperStart, helperEnd)}; return { sidebarGroupKey, sidebarGroupLabel, sidebarGroups }; })()`) as TrajectorySidebarHelpers;
}

type TrajectoryPreview = { text: string; names: string[]; overflow: number };
type TrajectoryPreviewHelpers = {
  compactSkillReadPreview: (entry: unknown, entries?: readonly unknown[]) => string | undefined;
  eventPreview: (entry: unknown, entries?: readonly unknown[]) => string;
  toolPreviewHtml: (entry: unknown, entries?: readonly unknown[]) => string;
  eventPreviewParts: (entry: unknown, entries?: readonly unknown[]) => TrajectoryPreview;
  eventSearchText: (entry: unknown, entries?: readonly unknown[]) => string;
  eventLabel: (kind: string) => string;
  entryDetails: (entry: unknown, agent: unknown, entries?: readonly unknown[]) => { kind: string; entry: unknown; agent: unknown };
  isDisplayableTranscriptEntry: (entry: { type?: unknown }) => boolean;
};

function loadTrajectoryPreviewHelpers(source: string): TrajectoryPreviewHelpers {
  const helperStart = source.indexOf("    const esc");
  const helperEnd = source.indexOf("    function renderToolPane", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  return runInNewContext(`(() => { ${source.slice(helperStart, helperEnd)}; return { compactSkillReadPreview, eventPreview, eventPreviewParts, toolPreviewHtml, eventSearchText, eventLabel, entryDetails, isDisplayableTranscriptEntry }; })()`) as TrajectoryPreviewHelpers;
}

type TrajectoryMarkdownHelpers = { sanitizeMarkdown: (html: string) => string };
type MarkdownAttribute = { name: string; value: string };
const voidMarkdownTags = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);

class FakeMarkdownElement {
  public removed = false;
  public text = "";
  constructor(public readonly tagName: string, public readonly attributes: MarkdownAttribute[] = [], public readonly children: FakeMarkdownElement[] = []) {}
  remove(): void { this.removed = true; }
  removeAttribute(name: string): void { const index = this.attributes.findIndex((attribute) => attribute.name === name); if (index >= 0) this.attributes.splice(index, 1); }
  querySelectorAll(selector: string): FakeMarkdownElement[] {
    assert.equal(selector, "*");
    return this.children.flatMap((child) => [child, ...child.querySelectorAll(selector)]);
  }
  get innerHTML(): string { return this.children.filter((child) => !child.removed).map(renderFakeMarkdownElement).join(""); }
}

function renderFakeMarkdownElement(element: FakeMarkdownElement): string {
  if (element.removed) return "";
  const attributes = element.attributes.map((attribute) => ` ${attribute.name}="${attribute.value}"`).join("");
  const tag = element.tagName.toLowerCase();
  if (voidMarkdownTags.has(tag)) return `<${tag}${attributes}>`;
  return `<${tag}${attributes}>${element.text}${element.children.map(renderFakeMarkdownElement).join("")}</${tag}>`;
}

function decodeMarkdownEntities(value: string): string {
  return value.replace(/&#x([0-9a-f]+);?/gi, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 16))).replace(/&#([0-9]+);?/g, (_match, code: string) => String.fromCodePoint(Number.parseInt(code, 10)));
}

function parseMarkdownAttributes(source: string): MarkdownAttribute[] {
  const attributes: MarkdownAttribute[] = [];
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const [, name, doubleQuoted, singleQuoted, bare] of source.matchAll(pattern)) {
    if (!name) continue;
    attributes.push({ name, value: decodeMarkdownEntities(doubleQuoted ?? singleQuoted ?? bare ?? "") });
  }
  return attributes;
}

class FakeDOMParser {
  parseFromString(input: string, mimeType: string): { body: FakeMarkdownElement } {
    assert.equal(mimeType, "text/html");
    const body = new FakeMarkdownElement("body");
    const stack = [body];
    const tokens = /<!--[\s\S]*?-->|<\/?([a-z][\w-]*)([^>]*)>|([^<]+)/gi;
    for (const match of input.matchAll(tokens)) {
      if (match[0].startsWith("<!--")) continue;
      const tag = match[1];
      const parent = stack.at(-1);
      assert.ok(parent);
      if (!tag) { parent.text += match[3] || ""; continue; }
      if (match[0].startsWith("</")) { stack.pop(); continue; }
      const element = new FakeMarkdownElement(tag, parseMarkdownAttributes(match[2] || ""));
      parent.children.push(element);
      if (!voidMarkdownTags.has(tag.toLowerCase()) && !/\/\s*>$/.test(match[0])) stack.push(element);
    }
    return { body };
  }
}

function loadTrajectoryMarkdownHelpers(source: string): TrajectoryMarkdownHelpers {
  const helperStart = source.indexOf("    const markdownAllowedTags");
  const helperEnd = source.indexOf("    const timingEntryType", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  return runInNewContext(`(() => { ${source.slice(helperStart, helperEnd)}; return { sanitizeMarkdown }; })()`, { DOMParser: FakeDOMParser }) as TrajectoryMarkdownHelpers;
}

void test("Trajectory sanitizes markdown before rendering transcript and system prompt content", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryMarkdownHelpers(source);
  const markdown = '<p onclick="alert(1)"><strong>Normal</strong><a href="https://example.com">link</a></p><pre><code class="language-js">code</code></pre><script>alert(1)</script><a href="javascript:alert(1)">blocked</a><a href="java&#9;script:alert(1)">tab</a><img src="data:text/html,alert(1)" alt="image"><ul><li>done <input checked="" disabled="" type="checkbox"></li></ul>';
  assert.equal(helpers.sanitizeMarkdown(markdown), '<p><strong>Normal</strong><a href="https://example.com">link</a></p><pre><code class="language-js">code</code></pre><a>blocked</a><a>tab</a><img alt="image"><ul><li>done <input checked="" disabled="" type="checkbox"></li></ul>');
  assert.match(source, /sanitizeMarkdown\(marked\.parse\(prompt, \{ mangle: false, headerIds: false \}\)\)/);
  assert.match(source, /sanitizeMarkdown\(marked\.parse\(body\)\)/);
});


void test("Trajectory excludes non-message session records from agent events", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryPreviewHelpers(source);
  assert.equal(helpers.isDisplayableTranscriptEntry({ type: "message" }), true);
  assert.equal(helpers.isDisplayableTranscriptEntry({ type: "tool_result" }), true);
  assert.equal(helpers.isDisplayableTranscriptEntry({ type: "model_change" }), false);
  assert.equal(helpers.isDisplayableTranscriptEntry({ type: "thinking_level_change" }), false);
  assert.equal(helpers.isDisplayableTranscriptEntry({ type: "compaction" }), true);
  assert.equal(helpers.isDisplayableTranscriptEntry({ type: "custom_message" }), true);
  assert.match(source, /source\.filter\(\(entry\) => isDisplayableTranscriptEntry\(entry\)/);
});

void test("Trajectory compacts canonical skill reads without losing event details", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryPreviewHelpers(source);
  assert.match(source, /\.pill\.skill/);
  assert.match(source, /html\[data-theme="paper"\] \.pill\.skill/);
  assert.match(source, /html\[data-theme="tty"\] \.pill\.skill/);
  assert.match(source, /if \(detail\.kind === "tool" \|\| detail\.kind === "skill"\)/);
  assert.match(source, /<span class="pill \$\{detail\.kind\}">\$\{eventLabel\(detail\.kind\)\}<\/span>/);
  const readCall = (id: string, args: Record<string, unknown>) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: "read", arguments: args }] } });
  const toolResult = (id: string, toolName = "read") => ({ type: "message", _toolTiming: { durationMs: 12, isError: false }, message: { role: "toolResult", toolCallId: id, toolName, content: [] } });
  const skillArgs = { path: "/home/andrea/.pi/agent/skills/tigerstyle/SKILL.md", offset: 1, limit: 400 };
  const call = readCall("skill-read", skillArgs);
  const result = toolResult("skill-read");
  const entries = [call, result];
  assert.equal(helpers.compactSkillReadPreview(call, entries), "[skill] tigerstyle:1-400");
  assert.equal(helpers.compactSkillReadPreview(result, entries), "[skill] tigerstyle:1-400");
  assert.equal(helpers.eventPreview(call, entries), "[skill] tigerstyle:1-400");
  assert.equal(helpers.eventPreview(result, entries), "[skill] tigerstyle:1-400");
  assert.equal(helpers.entryDetails(call, {}, entries).kind, "skill");
  assert.equal(helpers.entryDetails(result, {}, entries).kind, "skill");
  assert.equal(helpers.eventLabel(helpers.entryDetails(call, {}, entries).kind), "SKILL");
  assert.equal(helpers.eventLabel(helpers.entryDetails(result, {}, entries).kind), "SKILL");
  assert.match(helpers.eventSearchText(call, entries), /read/);
  assert.match(helpers.eventSearchText(call, entries), /tigerstyle\/SKILL\.md/);

  const nestedArgs = { path: "/home/andrea/.pi/agent/skills/tigerstyle/scripts/check.ts", offset: 2, limit: 3 };
  const nestedCall = readCall("nested-read", nestedArgs);
  assert.equal(helpers.compactSkillReadPreview(nestedCall, [nestedCall]), undefined);
  assert.equal(helpers.eventPreview(nestedCall, [nestedCall]), "read");
  assert.equal(helpers.eventPreview(toolResult("nested-read"), [nestedCall, toolResult("nested-read")]), `read  path ${nestedArgs.path} · offset 2 · limit 3 · 12ms`);
  const nestedHtml = helpers.toolPreviewHtml(toolResult("nested-read"), [nestedCall, toolResult("nested-read")]);
  assert.match(nestedHtml, /class="tool-key">path<\/span>/);
  assert.match(nestedHtml, /class="tool-key">offset<\/span>/);
  assert.match(nestedHtml, /class="tool-key">limit<\/span>/);
  assert.match(nestedHtml, /class="tool-timing"> · 12ms<\/span>/);
  const nestedResult = toolResult("nested-read");
  assert.equal(helpers.entryDetails(nestedResult, {}, [nestedCall, nestedResult]).kind, "tool");
  assert.equal(helpers.eventLabel(helpers.entryDetails(nestedResult, {}, [nestedCall, nestedResult]).kind), "TOOL");
  const simpleBashCall = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "simple-bash-call", name: "bash", arguments: { command: "git status --short" } }] } };
  const simpleBashResult = toolResult("simple-bash-call", "bash");
  assert.equal(helpers.entryDetails(simpleBashResult, {}, [simpleBashCall, simpleBashResult]).kind, "tool");
  assert.equal(helpers.eventLabel(helpers.entryDetails(simpleBashResult, {}, [simpleBashCall, simpleBashResult]).kind), "TOOL");

  const longCommand = "npm run build --workspace=packages/core && TEST_FILES='dist/test/agent-execution.test.js' npm run test:run --workspace=packages/core";
  const bashCall = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "bash-call", name: "bash", arguments: { command: longCommand, timeout: 180 } }] } };
  const bashResult = { type: "message", message: { role: "toolResult", toolCallId: "bash-call", toolName: "bash", content: [] } };
  const bashHtml = helpers.toolPreviewHtml(bashResult, [bashCall, bashResult]);
  assert.match(bashHtml, /class="tool-key">command<\/span>/);
  assert.match(bashHtml, /class="tool-key">timeout<\/span>/);
  assert.match(bashHtml, new RegExp(`class="tool-value" title="${longCommand.replaceAll("&", "&amp;")}"[^>]*>${longCommand.slice(0, 80).replaceAll("&", "&amp;")}…<\\/span>`));
  assert.match(bashHtml, /class="tool-value" title="180">180<\/span>/);
  assert.match(helpers.eventSearchText(bashResult, [bashCall, bashResult]), /agent-execution\.test\.js/);
  assert.match(helpers.eventSearchText(bashResult, [bashCall, bashResult]), /timeout/);

  const emptyCall = readCall("empty", {});
  const emptyResult = { type: "message", message: { role: "toolResult", toolCallId: "empty", toolName: "bash", content: [] } };
  assert.equal(helpers.eventPreview(emptyResult, [emptyCall, emptyResult]), "bash");

  const nullResult = { type: "message", message: { role: "toolResult", toolName: "bash", arguments: null, content: [] } };
  assert.equal(helpers.eventPreview(nullResult, [nullResult]), "bash: null");
  assert.match(helpers.toolPreviewHtml(nullResult, [nullResult]), /class="tool-value" title="null">null<\/span>/);
  const scalarResult = { type: "message", message: { role: "toolResult", toolName: "bash", arguments: "echo hello", content: [] } };
  assert.doesNotThrow(() => helpers.toolPreviewHtml(scalarResult, [scalarResult]));
  assert.match(helpers.toolPreviewHtml(scalarResult, [scalarResult]), /bash.*echo hello/);
  const textCall = { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Loading the skill now" }, { type: "toolCall", id: "text-read", name: "read", arguments: skillArgs }] } };
  assert.equal(helpers.compactSkillReadPreview(textCall, [textCall]), "[skill] tigerstyle:1-400");
  assert.equal(helpers.eventPreview(textCall, [textCall]), "[skill] tigerstyle:1-400");

  const multiCall = { type: "message", message: { role: "assistant", content: [
    { type: "toolCall", id: "multi-skill", name: "read", arguments: skillArgs },
    { type: "toolCall", id: "multi-other", name: "read", arguments: nestedArgs },
    { type: "toolCall", id: "multi-bash", name: "bash", arguments: {} },
  ] } };
  assert.equal(helpers.compactSkillReadPreview(multiCall, [multiCall]), undefined);
  assert.equal(helpers.eventPreview(multiCall, [multiCall]), "read read bash");
  assert.equal(helpers.compactSkillReadPreview(toolResult("multi-skill"), [multiCall]), "[skill] tigerstyle:1-400");

  const filePathArgs = { file_path: "/tmp/other-skill/SKILL.md", offset: 2, limit: 1 };
  const filePathCall = readCall("file-path-read", filePathArgs);
  assert.equal(helpers.compactSkillReadPreview(filePathCall, [filePathCall]), "[skill] other-skill:2-2");
});

void test("Trajectory renders structured tool previews in event rows", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  assert.match(source, /const toolPreviewHtml =/);
  assert.match(source, /class="tool-key"/);
  assert.match(source, /class="tool-value"/);
  assert.match(source, /const compact = compactSkillReadPreview\(entry, entries\)/);
  assert.match(source, /toolPreviewHtml\(entry, entries\)/);
  assert.doesNotMatch(source, /<div class="preview">\$\{esc\(eventPreview\(entry, entries\)\)\}<\/div>/);
});

void test("Trajectory summarizes assistant tool calls without dropping searchable arguments", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryPreviewHelpers(source);
  const previewParts = (entry: unknown, entries: readonly unknown[] = []) => JSON.parse(JSON.stringify(helpers.eventPreviewParts(entry, entries))) as TrajectoryPreview;
  const call = (name: string, id: string, args: Record<string, unknown>) => ({ type: "toolCall", name, id, arguments: args });
  const assistant = (content: unknown[]) => ({ type: "message", message: { role: "assistant", content } });

  const thinkingAndTools = assistant([
    { type: "thinking", thinking: "Inspecting repo status and files" },
    call("read", "read-1", { path: "a" }),
    call("bash", "bash-1", { command: "git status" }),
    call("grep", "grep-1", { pattern: "tigerstyle" }),
    call("read", "read-2", { path: "b" }),
    call("read", "read-3", { path: "c" }),
  ]);
  assert.deepEqual(previewParts(thinkingAndTools, [thinkingAndTools]), {
    text: "",
    names: ["read", "bash", "grep", "read", "read"],
    overflow: 2,
  });
  assert.match(helpers.eventSearchText(thinkingAndTools, [thinkingAndTools]), /git status/);
  assert.match(helpers.eventSearchText(thinkingAndTools, [thinkingAndTools]), /tigerstyle/);

  const textAndTools = assistant([{ type: "text", text: "I'll inspect" }, call("read", "read-1", { path: "a" }), call("bash", "bash-1", { command: "ls" })]);
  assert.deepEqual(previewParts(textAndTools, [textAndTools]), { text: "I'll inspect", names: ["read", "bash"], overflow: 0 });

  const textOnly = assistant([{ type: "text", text: "Done" }]);
  assert.deepEqual(previewParts(textOnly, [textOnly]), { text: "Done", names: [], overflow: 0 });

  const thinkingAndText = assistant([{ type: "thinking", thinking: "hidden" }, { type: "text", text: "Visible" }]);
  assert.deepEqual(previewParts(thinkingAndText, [thinkingAndText]), { text: "Visible", names: [], overflow: 0 });
  const threeTools = assistant([call("read", "read-1", {}), call("bash", "bash-1", {}), call("grep", "grep-1", {})]);
  assert.deepEqual(previewParts(threeTools, [threeTools]), { text: "", names: ["read", "bash", "grep"], overflow: 0 });

  const contextToolCall = { type: "custom", message: { content: [call("bash", "context-bash", { command: "git status" })] } };
  assert.match(helpers.eventSearchText(contextToolCall, [contextToolCall]), /git status/);

  assert.match(source, /\.pill\.tool/);
  assert.match(source, /\.preview \.pill\.tool \{[^}]*margin-right: 4px/);
  assert.match(source, /\.preview \.preview-tool \{[^}]*font-size: 9px[^}]*padding: 1px 4px/);
  assert.match(source, /renderAssistantToolCalls/);
  assert.match(source, /toolCalls\.map\(\(call\)/);
  assert.match(source, /toolArgsOf\(call, entries\)/);
  assert.match(source, /esc\(preview\.text\)/);
  assert.match(source, /renderAssistantPreview\(eventPreviewParts\(entry, entries\)\)/);
});

void test("trajectory transcript retention stays bounded with timing entries", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-cap-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const sessionFile = join(root, "session.jsonl");
  mkdirSync(cwd, { recursive: true });
  const transcript = Array.from({ length: 401 }, (_, index) => {
    const toolCallId = `call-${String(index)}`;
    return [
      { type: "message", message: { role: "toolResult", toolCallId } },
      { type: "custom", customType: "pi-workflows:tool-timing", data: { toolCallId, toolName: "bash", startedAt: index, completedAt: index + 1, durationMs: 1, isError: false } },
    ];
  }).flat();
  writeFileSync(sessionFile, `${transcript.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const store = new RunStore(cwd, "session", "run", home);
  const model = { provider: "fixture", model: "fixture-model" };
  const run = {
    id: "run", workflowName: "trajectory", cwd, sessionId: "session", state: "completed", agentSessions: [],
    agents: [{ id: "agent", name: "agent", path: "agent", state: "completed", attempts: 1, model, tools: [], attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: "native", locator: { sessionFile } }, setup: { cwd, hookNames: [], model, tools: [] }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }],
  } as unknown as PersistedRun;
  try {
    await store.create(run, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "trajectory" }, settings: { concurrency: 1 }, models: ["fixture/fixture-model"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
    const [loaded] = await createTrajectoryRunLoader(cwd, "session", home)();
    const entries = loaded?.transcripts.agent ?? [];
    assert.equal(entries.length, 800);
    assert.equal(entries.filter((entry) => (entry as { type?: string }).type === "custom").length, 400);
    assert.equal(entries.some((entry) => JSON.stringify(entry).includes("call-0")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("trajectory metadata keeps large transcripts available through bounded tail reads", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-metadata-cap-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const sessionFile = join(root, "session.jsonl");
  mkdirSync(cwd, { recursive: true });
  const entries = Array.from({ length: 420 }, (_, index) => ({ type: "message", message: { role: "assistant", toolCallId: `call-${String(index)}`, content: [{ type: "text", text: index === 419 ? "large-transcript-tail-marker" : "x".repeat(6000) }] } }));
  entries.push({ type: "custom", customType: "pi-workflows:tool-timing", data: { toolCallId: "call-419", toolName: "bash", startedAt: 1, completedAt: 2, durationMs: 1, isError: false } } as unknown as (typeof entries)[number]);
  writeFileSync(sessionFile, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const store = new RunStore(cwd, "session", "run", home);
  const model = { provider: "fixture", model: "fixture-model" };
  const run = { id: "run", workflowName: "trajectory", cwd, sessionId: "session", state: "completed", agentSessions: [], agents: [{ id: "agent", name: "agent", path: "agent", state: "completed", attempts: 1, model, tools: [], attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: "native", locator: { sessionFile } }, setup: { cwd, hookNames: [], model, tools: [] }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }] } as unknown as PersistedRun;
  try {
    await store.create(run, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "trajectory" }, settings: { concurrency: 1 }, models: ["fixture/fixture-model"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
    assert.ok(readFileSync(sessionFile).byteLength > TRAJECTORY_MAX_TRANSCRIPT_BYTES);
    const metadataRun = (await createTrajectoryRunMetadataLoader(cwd, "session", home)())[0];
    assert.ok(metadataRun);
    const metadata = metadataRun.transcripts.agent;
    assert.ok(metadata);
    assert.equal(metadata.status, "available");
    assert.ok((metadata.bytes ?? 0) > TRAJECTORY_MAX_TRANSCRIPT_BYTES);
    assert.equal(metadata.timing?.length, 1);
    const result = await createTrajectoryTranscriptLoader(cwd, "session", home, join(root, "agent"))({ runId: "run", agentId: "agent", revision: metadata.revision });
    assert.equal(result.status, "available");
    assert.ok(result.entries.some((entry) => JSON.stringify(entry).includes("large-transcript-tail-marker")));
    assert.equal(result.entries.some((entry) => JSON.stringify(entry).includes("call-419")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("trajectory reports a single oversized JSONL record instead of an empty transcript", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trajectory-single-record-cap-"));
  const cwd = join(root, "project");
  const home = join(root, "home");
  const sessionFile = join(root, "session.jsonl");
  mkdirSync(cwd, { recursive: true });
  writeFileSync(sessionFile, `${JSON.stringify({ type: "message", text: "x".repeat(TRAJECTORY_MAX_TRANSCRIPT_BYTES) })}\n`);
  const store = new RunStore(cwd, "session", "run", home);
  const model = { provider: "fixture", model: "fixture-model" };
  const run = { id: "run", workflowName: "trajectory", cwd, sessionId: "session", state: "completed", agentSessions: [], agents: [{ id: "agent", name: "agent", path: "agent", state: "completed", attempts: 1, model, tools: [], attemptDetails: [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: "native", locator: { sessionFile } }, setup: { cwd, hookNames: [], model, tools: [] }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }] } as unknown as PersistedRun;
  try {
    await store.create(run, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "trajectory" }, settings: { concurrency: 1 }, models: ["fixture/fixture-model"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
    const metadataRun = (await createTrajectoryRunMetadataLoader(cwd, "session", home)())[0];
    assert.ok(metadataRun);
    const agentMetadata = metadataRun.transcripts.agent;
    assert.ok(agentMetadata);
    assert.equal(agentMetadata.status, "oversized");
    assert.ok((agentMetadata.bytes ?? 0) > TRAJECTORY_MAX_TRANSCRIPT_BYTES);
    const result = await createTrajectoryTranscriptLoader(cwd, "session", home, join(root, "agent"))({ runId: "run", agentId: "agent", revision: agentMetadata.revision });
    assert.equal(result.status, "oversized");
    assert.equal(result.error, "Transcript is too large");
    assert.deepEqual(result.entries, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

type TrajectoryInspectorHelpers = {
  messageTokenRows: (kind: string, message: Record<string, unknown>, body: string, entryUsage?: Record<string, unknown>) => string;
};

function loadTrajectoryInspectorHelpers(source: string): TrajectoryInspectorHelpers {
  const helperStart = source.indexOf("    const messageTokenRows");
  const helperEnd = source.indexOf("    const timingEntryType", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  return runInNewContext(`(() => { const esc = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); const estTokens = (text) => Math.ceil(String(text || "").length / 4); ${source.slice(helperStart, helperEnd)}; return { messageTokenRows }; })()`) as TrajectoryInspectorHelpers;
}

void test("Trajectory message inspector distinguishes provider usage from estimates", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryInspectorHelpers(source);
  const renderStart = source.indexOf("    function renderInspector");
  const messageStart = source.indexOf("const message =", renderStart);
  const headerStart = source.indexOf('<div class="ins-head">', messageStart);
  const bodyStart = source.indexOf('<div class="ins-body">', headerStart);
  assert.ok(renderStart >= 0 && messageStart > renderStart && headerStart > messageStart && bodyStart > headerStart);
  assert.doesNotMatch(source.slice(headerStart, bodyStart), /tok|token/i);
  const providerRows = helpers.messageTokenRows("assistant", { usage: { input: 0, output: 8, reasoning: 3, cacheRead: 2, cacheWrite: 0 } }, "displayed text");
  assert.match(providerRows, /Input.*0 tok/);
  assert.match(providerRows, /Output.*8 tok/);
  assert.match(providerRows, /Reasoning.*3 tok/);
  assert.match(providerRows, /Cache read.*2 tok/);
  assert.doesNotMatch(providerRows, /est\./);
  assert.doesNotMatch(providerRows, /Total/);
  const noReasoningRows = helpers.messageTokenRows("assistant", { usage: { input: 1, output: 2 } }, "displayed text");
  assert.doesNotMatch(noReasoningRows, /Reasoning/);
  assert.equal(helpers.messageTokenRows("assistant", {}, "1234567"), '<div class="k">Tokens</div><div>est. 2 tok</div>');
  const entryUsageWithoutMessageUsage = helpers.messageTokenRows("assistant", {}, "1234567", { input: 9, output: 1 });
  assert.equal(entryUsageWithoutMessageUsage, '<div class="k">Tokens</div><div>est. 2 tok</div>');
  assert.equal(helpers.messageTokenRows("user", { usage: { input: 1, output: 2 } }, "1234567"), "");
});

void test("Trajectory restores home, run, and agent views from the query on refresh", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  assert.match(source, /\$\("view-run"\)\.classList\.toggle\("hidden", document\.body\.dataset\.view !== "run"\)/);
  assert.match(source, /\$\("view-agent"\)\.classList\.toggle\("hidden", document\.body\.dataset\.view === "run"\)/);
  assert.match(source, /shouldAutoSelect = !hasAcceptedState && !state\.currentRun && !new URLSearchParams\(location\.search\)\.has\("view"\)/);
  assert.match(source, /const ref = view === "subagent" \? next\.subagent \|\| next\.run : next\.run; state\.currentRun = ref \|\| null; state\.currentAgent = next\.agent \|\| null;/);
  assert.match(source, /const initialRef = initialView === "subagent" \? query\.get\("subagent"\) \|\| query\.get\("run"\)/);
  assert.doesNotMatch(source, /if \(next\.run\) state\.currentRun = next\.run; if \(next\.agent\) state\.currentAgent = next\.agent;/);
});
void test("Trajectory subagent crumb returns home with a cleared target and URL", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const navigationStart = source.indexOf("    function setView");
  const navigationEnd = source.indexOf("    function selectRun", navigationStart);
  const handlerStart = source.indexOf('    $("q").addEventListener');
  const handlerEnd = source.indexOf('    $("events").addEventListener', handlerStart);
  assert.ok(navigationStart >= 0 && navigationEnd > navigationStart && handlerStart >= 0 && handlerEnd > handlerStart);
  const result = runInNewContext(`(() => {
    const state = { currentRun: "publisher:agent", currentTarget: { kind: "subagent", publisherId: "publisher", id: "agent" }, pendingTarget: { kind: "subagent" }, currentPub: "publisher", currentAgent: "agent", agentRange: {}, agentRangeAgent: "agent", selectedEvent: 1, eventsSig: "events", subagentEventSig: "events" };
    const elements = {
      q: { addEventListener: () => {} },
      events: { addEventListener: () => {} },
      "run-crumb": { addEventListener: (_type, handler) => { elements["run-crumb"].handler = handler; } },
      "view-run": { classList: { toggle: () => {} } },
      "view-agent": { classList: { toggle: () => {} } },
    };
    const $ = (id) => elements[id];
    const document = { body: { dataset: { view: "subagent" } } };
    const location = { href: "http://trajectory.test/?view=subagent&subagent=publisher%3Aagent", pathname: "/", search: "?view=subagent&subagent=publisher%3Aagent" };
    const history = { calls: [], pushState: (value, _title, url) => history.calls.push({ value, url }) };
    const currentTarget = () => state.currentTarget;
    const renderRun = () => {};
    const renderAgent = () => {};
    const closeScript = () => {};
    const renderSidebar = () => {};
    const applyEventSearch = () => {};
    ${source.slice(navigationStart, navigationEnd)}
    ${source.slice(handlerStart, handlerEnd)}
    elements["run-crumb"].handler();
    return { view: document.body.dataset.view, currentRun: state.currentRun, currentTarget: state.currentTarget, history: history.calls };
  })()`, { URL }) as { view: string; currentRun: string | null; currentTarget: unknown; history: Array<{ value: { view: string; target: unknown }; url: string }> };
  assert.equal(result.view, "run");
  assert.equal(result.currentRun, null);
  assert.equal(result.currentTarget, null);
  assert.deepEqual(JSON.parse(JSON.stringify(result.history)), [{ value: { view: "run", run: null, subagent: null, agent: null, target: null }, url: "/?view=run" }]);
});

void test("Trajectory target refs round-trip subagent selections", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    const targetRef");
  const helperEnd = source.indexOf("    const livePublishers", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helpers = runInNewContext(`(() => { ${source.slice(helperStart, helperEnd)}; return { targetKey, targetFromRef, transcriptKey }; })()`) as {
    targetKey: (target: { kind: string; publisherId: string; id: string }) => string;
    targetFromRef: (kind: string, ref: string) => { kind: string; publisherId: string; id: string } | undefined;
    transcriptKey: (publisherId: string, targetId: string, agentId?: string) => string;
  };
  const target = helpers.targetFromRef("subagent", "publisher:agent");
  assert.equal(JSON.stringify(target), JSON.stringify({ kind: "subagent", publisherId: "publisher", id: "agent" }));
  assert.equal(helpers.targetKey(target as { kind: string; publisherId: string; id: string }), "subagent:publisher:agent");
  assert.equal(helpers.transcriptKey("publisher", "agent"), "publisher\tsubagent\tagent");
  assert.match(source, /searchParams\.set\("subagent", state\.currentRun\)/);
  assert.match(source, /subagent: target\?\.kind === "subagent" \? state\.currentRun : null/);
  assert.match(source, /view === "subagent" \? next\.subagent \|\| next\.run : next\.run/);
  assert.doesNotMatch(source, /view === "subagent" \? next\.subagent \|\| next\.agent/);
});

void test("Trajectory renders a publisher subagent sidebar section", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const sidebarStart = source.indexOf("    function renderSidebar");
  const sidebarEnd = source.indexOf("    function renderGantt", sidebarStart);
  assert.ok(sidebarStart >= 0 && sidebarEnd > sidebarStart);
  const sidebar = source.slice(sidebarStart, sidebarEnd);
  assert.match(sidebar, /SUBAGENTS/);
  assert.match(sidebar, /data-subagent/);
  assert.match(sidebar, /subagents:\$\{publisher\.id\}/);
  assert.doesNotMatch(sidebar, /subagentModel\(subagent\)/);
  assert.match(sidebar, /subagentCost\(subagent\)/);
  assert.match(sidebar, /subagentRuntime\(subagent\)/);
});
void test("Trajectory sidebar subagent rows match the workflow run row shape", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    function renderSidebar");
  const helperEnd = source.indexOf("    function renderGantt", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const result = runInNewContext(`(() => {
    const subagent = { id: "11111111-1111-4111-8111-111111111111", label: "publisher audit", state: "running", model: { provider: "anthropic", model: "claude-sonnet-4-5" }, progress: { accounting: { cost: 0.24 } }, startedAt: Date.now() - 120000 };
    const state = { publishers: [{ id: "publisher", title: "publisher", connected: true, runs: [], subagents: [subagent] }], currentPub: null, currentTarget: null, sidebarCollapsed: new Set() };
    const sidebar = { innerHTML: "" };
    const $ = () => sidebar;
    const patch = (root, html) => { root.innerHTML = html; };
    const esc = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
    const livePublishers = () => state.publishers;
    const sidebarGroups = () => [{ key: "publisher", label: "publisher", publishers: state.publishers }];
    const currentTarget = () => state.currentTarget;
    const targetKey = (target) => String(target.kind || "") + ":" + String(target.publisherId || "") + ":" + String(target.id || "");
    const runKey = () => "publisher:run";
    const subagentKey = (_publisher, value) => "publisher:" + value.id;
    const attention = () => 0;
    const runCost = () => 0;
    const runState = () => "completed";
    const glyph = () => "*";
    const subagentAttention = () => 0;
    const fmtCost = (value) => "$" + Number(value || 0).toFixed(2);
    const fmtRuntime = () => "2m";
    const startOf = () => new Date();
    const age = () => "0m ago";
    const subagentStartOf = (value) => value.startedAt;
    const subagentLabel = (value) => value.label;
    const subagentCost = (value) => value.progress.accounting.cost;
    const subagentRuntime = () => 120000;
    const renderThemeButtons = () => {};
    ${source.slice(helperStart, helperEnd)}
    renderSidebar();
    return sidebar.innerHTML;
  })()`, { Date }) as string;
  assert.match(result, /class="run-item subagent/);
  assert.match(result, /title="running · \$0\.24 · 2m"/);
  // The glyph carries the state, so the visible telemetry stays as short as a workflow run row's.
  assert.match(result, />\*<span class="n"[^>]*>publisher audit<\/span><span class="tel"[^>]*>\$0\.24 · 2m<\/span>/);
  assert.doesNotMatch(result, /<span class="tel"[^>]*>running/);
});

void test("Trajectory subagent stats bar only exposes valid controls", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    const subagentAccounting");
  const helperEnd = source.indexOf("    function renderAgent()", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helpers = runInNewContext(`(() => { const esc = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); const json = (value) => JSON.stringify(value); const fmtClock = (value) => String(value); const fmtRuntime = (value) => String(value); const fmtCost = (value) => String(value); const fmtTokens = (value) => String(value); const accounting = (value) => value.accounting || { input: 0, output: 0, cost: 0 }; const stateClass = (value) => value === "running" ? "spin" : value === "completed" ? "ok" : "fail"; const glyph = (value) => value; ${source.slice(helperStart, helperEnd)}; return { renderAgentStats, subagentAgent }; })()`, { Date }) as {
    renderAgentStats: (found: Record<string, unknown>, agent: Record<string, unknown>, isSubagent: boolean) => string;
    subagentAgent: (subagent: Record<string, unknown>) => Record<string, unknown>;
  };
  const base = { mode: "background", role: "reviewer", attempts: 1, request: { prompt: "inspect" }, tools: ["read"], progress: { accounting: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: 0.1 } }, startedAt: 1, model: { provider: "fixture", model: "model" } };
  const stats = (subagent: Record<string, unknown>) => helpers.renderAgentStats({ publisher: { connected: true }, record: subagent }, helpers.subagentAgent(subagent), true);
  const running = stats({ ...base, id: "running", state: "running" });
  const failed = stats({ ...base, id: "failed", state: "failed", failure: { code: "FAILED", message: "no" } });
  const completed = stats({ ...base, id: "completed", state: "completed", result: { ok: true } });
  assert.match(running, />Stop</);
  assert.match(running, /Send/);
  assert.doesNotMatch(running, /Pause|Resume|Checkpoint/);
  assert.match(failed, />Retry</);
  assert.doesNotMatch(failed, /Send/);
  assert.doesNotMatch(completed, /Stop|Retry|Pause|Resume/);
  // A subagent carries its outcome as a trailing transcript event, exactly like the system prompt leads.
  assert.equal(JSON.stringify(helpers.subagentAgent({ ...base, id: "completed", state: "completed", result: { ok: true } }).outcome), '{"kind":"result","value":{"ok":true}}');
  assert.equal(JSON.stringify(helpers.subagentAgent({ ...base, id: "failed", state: "failed", failure: { code: "FAILED", message: "no" } }).outcome), '{"kind":"failure","value":{"code":"FAILED","message":"no"}}');
});

void test("Trajectory renders subagents through the same agent view as workflow agents", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  // One inspector path for both kinds: no dossier stacked above the event inspector, no nested panel.
  assert.doesNotMatch(source, /subagent-event-inspector/);
  assert.doesNotMatch(source, /renderSubagentDossier/);
  assert.match(source, /patch\(\$\("agent-stats"\), renderAgentStats\(found, agent, isSubagent\)\); if \(state\.inspSig !== sig\)/);
  assert.match(source, /if \(state\.eventsSig !== eventsSig\)/);
  assert.match(source, /events\.scrollTop = eventsScroll/);
  assert.match(source, /setInterval\(tickClocks, 1000\)/);
  assert.doesNotMatch(source, /setInterval\(\(\) => \{ if \(document\.body\.dataset\.view === "run"\) renderRun\(\); \}, 1000\)/);
});
void test("Trajectory subagent Gantt gives running and finished lanes tool geometry", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    const timingEntryType");
  const helperEnd = source.indexOf("    function phases", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helpers = runInNewContext(`(() => { const state = { publishers: [], transcripts: {} }; const transcriptKey = (publisherId, targetId) => publisherId + "\tsubagent\t" + targetId; const esc = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); const fmtClock = (value) => String(value); const fmtRuntime = (value) => String(value); const stateClass = (value) => value === "running" ? "spin" : value === "completed" ? "ok" : "fail"; const glyph = (value) => value; ${source.slice(helperStart, helperEnd)}; return { renderSubagentGantt, state }; })()`) as { renderSubagentGantt: (publisher: { subagents: readonly Record<string, unknown>[] }) => string; state: { publishers: { subagents: readonly Record<string, unknown>[] }[]; transcripts: Record<string, readonly Record<string, unknown>[]> } };
  const running = { id: "running", label: "live", state: "running", startedAt: 1000, transcript: [] };
  const finished = { id: "finished", label: "done", state: "completed", startedAt: 2000, finishedAt: 3000, transcript: [] };
  const publisher = { id: "publisher", subagents: [running, finished] };
  helpers.state.publishers.push(publisher);
  helpers.state.transcripts["publisher\tsubagent\trunning"] = [{ type: "custom", customType: "pi-workflows:tool-timing", data: { toolCallId: "tool", toolName: "bash", startedAt: 1100, completedAt: 1300, durationMs: 200, isError: false } }];
  const html = helpers.renderSubagentGantt(publisher);
  assert.match(html, /data-subagent="running"/);
  assert.match(html, /data-subagent="finished"/);
  assert.match(html, /class="bar tool ok"/);
  const widths = [...html.matchAll(/class="bar(?: tool)? [^"]+" style="left:[^;]+%;width:([^%]+)%/g)].map((match) => Number(match[1]));
  assert.ok(widths.length >= 3 && widths.every((width) => width > 0));
});

void test("Trajectory tool pane clicks record the selected pane", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const handlerStart = source.indexOf('if (target.dataset.pane)');
  const handlerEnd = source.indexOf('if (target.dataset.run)', handlerStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  const handler = source.slice(handlerStart, handlerEnd);
  const calls: string[] = [];
  const state = { toolPane: "summary", sysPane: "prompt", selectedEvent: 0 };
  const target = { dataset: { pane: "result" }, closest: (selector: string) => selector === "#tool-tabs" ? { id: "tool-tabs" } : undefined };
  runInNewContext(`(() => { ${handler} })()`, {
    target, state,
    selected: () => ({ target: { kind: "run" }, record: { run: { agents: [{ id: "agent-1" }] } } }),
    subagentAgent: () => ({ id: "agent-1" }),
    agentEntries: () => [{ type: "message" }],
    entryDetails: () => ({ kind: "tool" }),
    renderInspector: () => { calls.push("inspector"); },
    renderSystemPane: () => { calls.push("system"); },
  });
  assert.equal(state.toolPane, "result");
  assert.deepEqual(calls, ["inspector"]);
});

void test("Trajectory run rendering preserves the dossier scroll across re-renders", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const start = source.indexOf("    function renderRun()");
  const end = source.indexOf("    function renderAgent()", start);
  assert.ok(start >= 0 && end > start);
  const body = source.slice(start, end);
  // The dossier is rewritten on every state frame, so the scroll must be restored around the patch.
  assert.match(body, /const dossierBody = \$\("insp"\)\.querySelector\("\.ins-body"\); const dossierScroll = dossierBody \? dossierBody\.scrollTop : 0;/);
  assert.match(body, /patch\(\$\("insp"\), renderDossier\(publisher, record\)\); const nextDossierBody = \$\("insp"\)\.querySelector\("\.ins-body"\); if \(nextDossierBody && dossierScroll\) nextDossierBody\.scrollTop = dossierScroll;/);
});
