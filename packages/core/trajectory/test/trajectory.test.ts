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
    loadRunLayout: () => { swimHeight: number; ganttCollapsed: boolean; topologyCollapsed: boolean; agentTopologyCollapsed: boolean; agentsCollapsed: boolean; logsCollapsed: boolean };
    loadSidebarCollapsed: () => Set<string>;
    saveRunLayout: () => void;
    saveSidebarCollapsed: () => void;
  };
  assert.deepEqual({ ...helpers.loadRunLayout() }, { swimHeight: 220, ganttCollapsed: false, topologyCollapsed: false, agentTopologyCollapsed: false, agentsCollapsed: false, logsCollapsed: false });
  assert.deepEqual([...helpers.loadSidebarCollapsed()], []);
  assert.doesNotThrow(() => { helpers.saveRunLayout(); });
  assert.doesNotThrow(() => { helpers.saveSidebarCollapsed(); });
});

void test("Trajectory old run layouts gain independent topology defaults and ARIA regions", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    const defaultRunLayout");
  const helperEnd = source.indexOf("    const agentColumnOrder", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const layout = runInNewContext(`(() => { ${source.slice(helperStart, helperEnd)}; return loadRunLayout(); })()`, {
    localStorage: { getItem: () => JSON.stringify({ swimHeight: 300, ganttCollapsed: true, agentsCollapsed: true, logsCollapsed: true }) },
  }) as { swimHeight: number; ganttCollapsed: boolean; topologyCollapsed: boolean; agentTopologyCollapsed: boolean; agentsCollapsed: boolean; logsCollapsed: boolean };
  assert.deepEqual({ ...layout }, { swimHeight: 300, ganttCollapsed: true, topologyCollapsed: false, agentTopologyCollapsed: false, agentsCollapsed: true, logsCollapsed: true });
  assert.match(source, /id="toggle-gantt"[^>]*aria-controls="swim"/);
  assert.match(source, /id="swim"[^>]*role="region"[^>]*aria-labelledby="toggle-gantt"/);
  assert.match(source, /id="toggle-topology"[^>]*aria-controls="run-topology-content"/);
  assert.match(source, /id="run-topology-content"[^>]*role="region"[^>]*aria-labelledby="toggle-topology"/);
  assert.match(source, /id="toggle-agent-topology"[^>]*aria-controls="agent-topology-content"/);
  assert.match(source, /id="agent-topology-content"[^>]*role="region"[^>]*aria-labelledby="toggle-agent-topology"/);
  assert.match(source, /id="logs-content" role="region" aria-labelledby="toggle-logs"/);
  assert.match(source, /id="agents-content" role="region" aria-labelledby="toggle-agents"/);
});

void test("Trajectory agent column widths load, clamp, save, and reset independently", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    const agentColumnOrder");
  const helperEnd = source.indexOf("    const state =", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const stored: Record<string, string> = { "traj-agent-columns": JSON.stringify({ model: 20, role: 9999, cost: 88 }) };
  const document = { documentElement: { style: { values: new Map<string, string>(), setProperty(name: string, value: string) { this.values.set(name, value); } } } };
  const helpers = runInNewContext(`(() => { let state; ${source.slice(helperStart, helperEnd)}; state = { agentColumns: loadAgentColumnWidths() }; return { agentColumnDefaults, loadAgentColumnWidths, saveAgentColumnWidths, resetAgentColumnWidth, applyAgentColumnWidths, state }; })()`, { localStorage: { getItem: (key: string) => stored[key] || null, setItem: (key: string, value: string) => { stored[key] = value; } }, document }) as { agentColumnDefaults: Record<string, number>; loadAgentColumnWidths: () => Record<string, number>; saveAgentColumnWidths: () => void; resetAgentColumnWidth: (name: string) => void; applyAgentColumnWidths: () => void; state: { agentColumns: Record<string, number> } };
  assert.equal(helpers.loadAgentColumnWidths().model, 140);
  assert.equal(helpers.loadAgentColumnWidths().role, 800);
  helpers.state.agentColumns.model = 300;
  helpers.saveAgentColumnWidths();
  const saved = JSON.parse(stored["traj-agent-columns"] || "{}") as { model?: number };
  assert.equal(saved.model, 300);
  helpers.resetAgentColumnWidth("model");
  assert.equal(helpers.state.agentColumns.model, helpers.agentColumnDefaults.model);
  const reset = JSON.parse(stored["traj-agent-columns"] || "{}") as { model?: number };
  assert.equal(reset.model, helpers.agentColumnDefaults.model);
  helpers.applyAgentColumnWidths();
  assert.equal(document.documentElement.style.values.get("--agent-col-model"), "190px");
});

void test("Trajectory agent column handles support keyboard and double-click reset", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    function bindAgentColumnResize");
  const helperEnd = source.indexOf("    function bindSplit", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const listeners: Record<string, (event: Record<string, unknown>) => void> = {};
  const handle = { dataset: { columnResizer: "model" }, closest: (selector: string) => selector === "[data-column-resizer]" || selector === ".agent-header-cell" ? handle : undefined, classList: { add: () => {}, remove: () => {} } };
  const app = { dataset: {} as Record<string, string>, addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => { listeners[type] = listener; } };
  const state: { agentColumns: Record<string, number> } = { agentColumns: { model: 200 } };
  let saves = 0;
  const updates: number[] = [];
  const document = { querySelector: () => app };
  const window = { addEventListener: () => {}, removeEventListener: () => {} };
  runInNewContext(`(() => { ${source.slice(helperStart, helperEnd)}; bindAgentColumnResize(); listeners.keydown?.({ target: handle, key: "ArrowRight", preventDefault: () => {} }); listeners.keydown?.({ target: handle, key: "Home", preventDefault: () => {} }); listeners.dblclick?.({ target: handle, preventDefault: () => {}, stopPropagation: () => {} }); return state; })()`, {
    document, window, handle, app, listeners, state,
    clampAgentColumnWidth: (_name: string, value: number) => Math.max(140, Math.min(800, Math.round(value))),
    applyAgentColumnWidths: () => { updates.push(state.agentColumns.model ?? 0); },
    saveAgentColumnWidths: () => { saves += 1; },
    resetAgentColumnWidth: (name: string) => { state.agentColumns[name] = 190; updates.push(state.agentColumns.model ?? 0); },
  });
  assert.deepEqual(updates, [210, 190, 190]);
  assert.equal(state.agentColumns.model, 190);
  assert.equal(saves, 1);
  assert.match(source, /width: max-content/);
  assert.match(source, /min-width: max-content/);
  assert.match(source, /aria-valuemin=/);
  assert.match(source, /aria-valuemax=/);
  assert.match(source, /title="Resize \$\{label\} column; use arrow keys, double-click to reset"/);
  assert.match(source, /event\.stopPropagation\(\)/);
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

void test("Trajectory theme changes rerender the active run, agent, and subagent topology", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    function rerenderActiveTopology");
  const helperEnd = source.indexOf("    const subagentAccounting", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const renderForView = (view: "run" | "agent" | "subagent") => {
    const calls: string[] = [];
    const handlers: { current?: () => void } = {};
    const button = { dataset: { theme: "paper" }, addEventListener: (_type: string, handler: () => void) => { handlers.current = handler; }, classList: { toggle: () => {} } };
    const themeButtons = { innerHTML: "", classList: { toggle: () => {} }, querySelectorAll: () => [button] };
    const document = { body: { dataset: { view } }, documentElement: { dataset: { theme: "tty" } } };
    const state = { publishers: [{ themes: true }] };
    const selected = () => ({ target: { kind: "run" }, record: { run: { id: "run" } } });
    const elements = new Map([["theme-buttons", themeButtons]]);
    const $ = (id: string) => elements.get(id);
    const patch = (root: { innerHTML: string }, html: string) => { root.innerHTML = html; };
    const renderRunTopology = () => { calls.push("run"); };
    const renderAgent = () => { calls.push("agent"); };
    const result = runInNewContext(`(() => { ${source.slice(helperStart, helperEnd)}; renderThemeButtons(); handlers.current?.(); return { theme: document.documentElement.dataset.theme }; })()`, { document, state, selected, $, patch, renderRunTopology, renderAgent, handlers, localStorage: { getItem: () => null, setItem: () => {} } }) as { theme: string };
    return { theme: result.theme, calls };
  };
  assert.deepEqual(renderForView("run"), { theme: "paper", calls: ["run"] });
  assert.deepEqual(renderForView("agent"), { theme: "paper", calls: ["agent"] });
  assert.deepEqual(renderForView("subagent"), { theme: "paper", calls: ["agent"] });
  assert.match(source, /signature = `run:\$\{record\.run\.id\}:\$\{json\(data\.nodes\)\}:\$\{json\(data\.edges\)\}:\$\{document\.documentElement\.dataset\.theme/);
  assert.match(source, /signature = `agent:\$\{targetSignature\}:\$\{json\(data\.nodes\)\}:\$\{json\(data\.edges\)\}:\$\{document\.documentElement\.dataset\.theme/);
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
  renderAgentTimeline: (entries: readonly unknown[]) => string;
};

function loadTrajectoryPreviewHelpers(source: string): TrajectoryPreviewHelpers {
  const helperStart = source.indexOf("    const esc");
  const helperEnd = source.indexOf("    function renderToolPane", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  return runInNewContext(`(() => { ${source.slice(helperStart, helperEnd)}; return { compactSkillReadPreview, eventPreview, eventPreviewParts, toolPreviewHtml, eventSearchText, eventLabel, entryDetails, isDisplayableTranscriptEntry, renderAgentTimeline }; })()`) as TrajectoryPreviewHelpers;
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
    const state = { currentRun: "publisher:agent", currentTarget: { kind: "subagent", publisherId: "publisher", id: "agent" }, pendingTarget: { kind: "subagent" }, currentPub: "publisher", currentAgent: "agent", agentRange: {}, agentRangeAgent: "agent", selectedEvent: 1, timelineHighlight: null, eventsSig: "events", subagentEventSig: "events" };
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
    const clearEventHighlight = () => { state.timelineHighlight = null; };
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
  const helperEnd = source.indexOf("    const topologyLabel", helperStart);
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

void test("Trajectory keeps native Gantt separate from Mermaid topology panels", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  assert.match(source, /function renderGantt\(record, timingsByAgent\)/);
  assert.match(source, /class="swim" id="swim"/);
  assert.match(source, /id="run-topology-content"/);
  assert.match(source, /TOOL TOPOLOGY/);
  assert.match(source, /function buildTopologyData\(record, timingsByAgent\)/);
  assert.match(source, /data-column-resizer/);
  assert.match(source, /traj-agent-columns/);
  assert.match(source, /ArrowLeft|ArrowRight/);
  assert.doesNotMatch(source, /renderMermaidGantt/);
  assert.doesNotMatch(source, /gantt-panel/);
});

type TrajectoryTopologyCall = Record<string, unknown> & {
  id?: string;
  callEventIndex?: number;
  resultEventIndex?: number;
  navigationEventIndex?: number;
  interactive?: boolean;
};
type TrajectoryTopologyHelpers = {
  topologyLabel: (value: unknown, fallback?: string) => string;
  topologyToolInvocations: (entries: readonly Record<string, unknown>[], fallbackAgent?: Record<string, unknown>) => readonly TrajectoryTopologyCall[];
  buildAgentTopologyData: (entries: readonly Record<string, unknown>[], agent?: Record<string, unknown>) => { source: string; nodes: readonly Record<string, unknown>[]; edges: readonly Record<string, unknown>[]; calls: readonly TrajectoryTopologyCall[] };
};

function loadTrajectoryTopologyHelpers(source: string): TrajectoryTopologyHelpers {
  const helperStart = source.indexOf("    const topologyLabel");
  const helperEnd = source.indexOf("    function mermaidTheme", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  return runInNewContext(`(() => { const toolPreviewValue = (value) => ({ row: String(value ?? "") }); const toolCallsOf = (entry) => Array.isArray(entry.message?.content) ? entry.message.content.filter((part) => part?.type === "toolCall") : []; const toolCallIdOf = (entry) => entry.toolCallId || entry.message?.toolCallId; const isToolResult = (entry) => entry.type === "tool_result" || entry.message?.role === "toolResult"; const timingData = (entry) => entry?.data?.toolCallId ? entry.data : undefined; ${source.slice(helperStart, helperEnd)}; return { topologyLabel, topologyToolInvocations, buildAgentTopologyData }; })()`) as TrajectoryTopologyHelpers;
}

void test("Trajectory topology preserves parallel branches and transcript sequencing", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryTopologyHelpers(source);
  const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
  const entries = [
    { type: "message", message: { role: "assistant", content: [call("a", "read", { path: "a" }), call("b", "bash", { command: "b" })] } },
    { type: "message", message: { role: "toolResult", toolCallId: "a", content: [] } },
    { type: "message", message: { role: "toolResult", toolCallId: "b", content: [] } },
    { type: "message", message: { role: "assistant", content: [call("c", "write", { path: "c" })] } },
  ];
  const data = helpers.buildAgentTopologyData(entries, { id: "agent", state: "completed" });
  assert.equal(data.calls.length, 3);
  assert.equal(data.edges.filter((edge) => edge.from === "operation-0" || edge.from === "operation-1").length, 2);
  assert.match(data.source, /flowchart LR/);
  assert.match(data.source, /read 1 · completed/);
  assert.match(data.source, /write 1 · completed/);
  assert.ok(data.nodes.some((node) => node.id === "turn-0-branch" && node.label === "Turn 1 · branch"));
  assert.ok(data.nodes.some((node) => node.id === "turn-0-join" && node.label === "Turn 1 · join"));
  assert.equal(helpers.topologyLabel('bad [label] --> "value"'), "bad label value");
});

void test("Trajectory detail topology uses only transcript evidence for branches and joins", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryTopologyHelpers(source);
  const call = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
  const entries = [
    { type: "message", timestamp: "2099-01-01T00:00:00Z", message: { role: "assistant", content: [call("left", "read", { path: "left" }), call("right", "bash", { command: "right" })] } },
    { type: "message", timestamp: "2000-01-01T00:00:00Z", message: { role: "toolResult", toolCallId: "right", content: [] } },
    { type: "message", timestamp: "1999-01-01T00:00:00Z", message: { role: "toolResult", toolCallId: "left", content: [] } },
    { type: "message", timestamp: "1900-01-01T00:00:00Z", message: { role: "assistant", content: [call("join", "write", { path: "join" })] } },
  ];
  const data = helpers.buildAgentTopologyData(entries, { id: "agent", state: "completed" });
  assert.ok(data.edges.some((edge) => edge.from === "agent-root" && edge.to === "turn-0-branch"));
  assert.ok(data.edges.some((edge) => edge.from === "turn-0-branch" && edge.to === "operation-0"));
  assert.ok(data.edges.some((edge) => edge.from === "turn-0-branch" && edge.to === "operation-1"));
  assert.ok(data.edges.some((edge) => edge.from === "operation-0" && edge.to === "turn-0-join"));
  assert.ok(data.edges.some((edge) => edge.from === "operation-1" && edge.to === "turn-0-join"));
  assert.ok(data.edges.some((edge) => edge.from === "turn-0-join" && edge.to === "turn-1-branch"));
  assert.ok(data.edges.some((edge) => edge.from === "turn-1-branch" && edge.to === "operation-2"));
  assert.equal(data.edges.some((edge) => String(edge.from).startsWith("operation-") && String(edge.to).startsWith("operation-")), false);
  // Deliberately changed timestamps must not affect graph structure.
  const retimed = entries.map((entry, index) => ({ ...entry, timestamp: `19${String(index)}-01-01T00:00:00Z` }));
  const retimedData = helpers.buildAgentTopologyData(retimed, { id: "agent", state: "completed" });
  assert.equal(retimedData.source, data.source);
  assert.match(source, /const branch = `turn-\$\{index\}-branch`/);
  assert.match(source, /const join = `turn-\$\{index\}-join`/);
  assert.doesNotMatch(source.slice(source.indexOf("function buildAgentTopologyData"), source.indexOf("function validTopologyParent")), /timestamp|eventTime|startedAt|completedAt/);
});

void test("Trajectory detail topology correlates only unique non-empty call/result IDs", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryTopologyHelpers(source);
  const call = (id: string | undefined, name = "read", args: Record<string, unknown> = { path: name }) => ({ type: "toolCall", ...(id === undefined ? {} : { id }), name, arguments: args });
  const assistant = (...calls: Record<string, unknown>[]) => ({ type: "message", message: { role: "assistant", content: calls } });
  const result = (id: string) => ({ type: "message", message: { role: "toolResult", toolCallId: id, content: [] } });
  const calls = (entries: Record<string, unknown>[], agent: Record<string, unknown> = { id: "agent", state: "running" }) => Array.from(helpers.topologyToolInvocations(entries, agent), (value) => ({
    call: value.callEventIndex,
    result: value.resultEventIndex,
    selected: value.navigationEventIndex,
    interactive: value.interactive,
  }));

  assert.deepEqual(calls([assistant(call("unique")), result("unique")]), [{ call: 0, result: 1, selected: 1, interactive: true }]);
  assert.deepEqual(calls([assistant(call("duplicate", "grep"), call("duplicate", "write")), result("duplicate")]), [
    { call: 0, result: undefined, selected: undefined, interactive: false },
    { call: 0, result: undefined, selected: undefined, interactive: false },
  ]);
  assert.deepEqual(calls([assistant(call("duplicate-result")), result("duplicate-result"), result("duplicate-result")]), [{ call: 0, result: undefined, selected: 0, interactive: true }]);
  assert.deepEqual(calls([assistant(call("known")), result("unknown")]), [{ call: 0, result: undefined, selected: 0, interactive: true }]);
  // A single missing-ID invocation can conservatively select its own assistant row, but never a result by position.
  assert.deepEqual(calls([assistant(call(undefined, "bash"))]), [{ call: 0, result: undefined, selected: 0, interactive: true }]);
  assert.deepEqual(calls([assistant(call(undefined, "read"), call(undefined, "bash"))]), [
    { call: 0, result: undefined, selected: undefined, interactive: false },
    { call: 0, result: undefined, selected: undefined, interactive: false },
  ]);
  assert.deepEqual(calls([], { id: "fallback", state: "running", toolCalls: [{ toolCallId: "fallback-id", toolName: "read", input: { path: "x" } }] }), [{ call: undefined, result: undefined, selected: undefined, interactive: false }]);

  const data = helpers.buildAgentTopologyData([assistant(call("matched")), result("matched")], { id: "agent", state: "running" });
  assert.match(data.source, /read 1 · completed/);
  assert.equal(data.calls.length, 1);
  const operation = data.nodes.find((node) => node.id === "operation-0") as TrajectoryTopologyCall | undefined;
  assert.ok(operation);
  assert.equal(operation.callEventIndex, 0);
  assert.equal(operation.resultEventIndex, 1);
  assert.equal(operation.navigationEventIndex, 1);
  assert.equal(operation.interactive, true);
  assert.equal(data.nodes.find((node) => node.id === "agent-root")?.interactive, false);
  assert.equal(data.nodes.find((node) => node.id === "turn-0-branch")?.interactive, false);
  assert.match(source, /callEventIndex/);
  assert.match(source, /resultEventIndex/);
  assert.match(source, /navigationEventIndex/);
  assert.doesNotMatch(source.slice(source.indexOf("function topologyToolInvocations"), source.indexOf("function topologyGraphSource")), /timestamp|eventTime|startedAt|completedAt/);
});

void test("Trajectory invocation nodes bind accessible activation without making branch connectors interactive", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const bindStart = source.indexOf("    function bindTopologyNodes");
  const bindEnd = source.indexOf("    function ", bindStart + 10);
  assert.ok(bindStart >= 0 && bindEnd > bindStart);
  const binding = source.slice(bindStart, bindEnd);
  assert.match(binding, /operation-/);
  assert.match(binding, /setAttribute\("role", "button"\)/);
  assert.match(binding, /setAttribute\("tabindex", "0"\)/);
  assert.match(binding, /setAttribute\("aria-label"/);
  assert.match(binding, /setAttribute\("aria-pressed"/);
  assert.match(binding, /addEventListener\("click"/);
  assert.match(binding, /addEventListener\("keydown"/);
  assert.match(binding, /event\.key === "Enter"/);
  assert.match(binding, /event\.key === " "/);
  assert.match(binding, /preventDefault\(\)/);
  assert.match(binding, /interactive/);
  assert.match(binding, /classList\.toggle\("selected"/);
  assert.doesNotMatch(binding, /turn-|agent-root/);

  const selectionStart = source.indexOf("    function selectAgentEvent");
  const selectionEnd = source.indexOf("    function ", selectionStart + 10);
  assert.ok(selectionStart >= 0 && selectionEnd > selectionStart);
  const selection = source.slice(selectionStart, selectionEnd);
  assert.match(selection, /state\.selectedEvent/);
  assert.match(selection, /entryDetails/);
  assert.match(selection, /revealEventRow/);
  assert.match(selection, /renderInspector/);
  assert.match(selection, /renderAgent/);
  assert.match(selection, /classList\.add\("on"\)/);
  assert.match(source, /events\.scrollTop/);
  assert.match(source, /data-pane="payload"/);
  assert.match(source, /data-pane="result"/);
  assert.match(source, /data-pane="schema"/);
  assert.match(source, /data-pane="timing"/);
  assert.doesNotMatch(selection, /scrollIntoView/);

  const revealStart = source.indexOf("    function revealEventRow");
  const revealEnd = source.indexOf("    function ", revealStart + 10);
  assert.ok(revealStart >= 0 && revealEnd > revealStart);
  const reveal = source.slice(revealStart, revealEnd);
  const row = { offsetTop: 220, offsetHeight: 20 };
  const events = { scrollTop: 40, clientHeight: 100 };
  const helpers = runInNewContext(`(() => { ${reveal}; return { revealEventRow }; })()`) as { revealEventRow: (events: Record<string, unknown>, row: Record<string, unknown>) => void };
  helpers.revealEventRow(events, row);
  assert.equal(events.scrollTop, 140);
  const displacedEvents = { scrollTop: 610, clientHeight: 350, clientTop: 0, getBoundingClientRect: () => ({ top: 554, bottom: 904 }) };
  const displacedRow = { offsetTop: 610, offsetHeight: 28, getBoundingClientRect: () => ({ top: 0, bottom: 28 }) };
  helpers.revealEventRow(displacedEvents, displacedRow);
  assert.equal(displacedEvents.scrollTop, 56);
  assert.match(source, /role="region" aria-label="\$\{esc\(title\)\} graph viewport"/);
});

void test("Trajectory overview topology uses persisted phases, scopes, and parent edges", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    const topologyLabel");
  const helperEnd = source.indexOf("    function mermaidTheme", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helpers = runInNewContext(`(() => { const state = {}; const toolPreviewValue = (value) => ({ row: String(value ?? "") }); const toolCallsOf = () => []; const toolCallIdOf = () => undefined; const isToolResult = () => false; const timingData = () => undefined; const transcriptSource = () => []; const agentTimingMap = () => new Map(); const phases = (record) => [{ name: "parallel", agents: record.run.agents.map((agent) => agent.id) }]; ${source.slice(helperStart, helperEnd)}; return { buildTopologyData }; })()`) as { buildTopologyData: (record: Record<string, unknown>, timings: Map<string, unknown[]>) => { source: string; nodes: Array<{ id: string; label: string }>; edges: Array<{ from: string; to: string }> } };
  const record = { run: { workflowName: "pipeline", agents: [
    { id: "parent", name: "parent", state: "completed", structuralPath: ["pipeline", "parallel-a"] },
    { id: "branch", name: "branch", state: "completed", parentId: "parent", structuralPath: ["pipeline", "parallel-a"] },
    { id: "other", name: "other", state: "running", structuralPath: ["pipeline", "parallel-b"], startedAt: 999999 },
  ] } };
  const data = helpers.buildTopologyData(record, new Map());
  assert.match(data.source, /flowchart LR/);
  assert.match(data.source, /Scope pipeline parallel-a/);
  assert.match(data.source, /Scope pipeline parallel-b/);
  const parent = data.nodes.find((node) => node.label.startsWith("parent"));
  const branch = data.nodes.find((node) => node.label.startsWith("branch"));
  assert.ok(parent && branch);
  assert.ok(data.edges.some((edge) => edge.from === parent.id && edge.to === branch.id));
  assert.doesNotMatch(data.source, /999999/);
});

void test("Trajectory overview topology qualifies repeated scopes and degrades without structure", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    const topologyLabel");
  const helperEnd = source.indexOf("    function mermaidTheme", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helpers = runInNewContext(`(() => { const state = {}; const toolPreviewValue = (value) => ({ row: String(value ?? "") }); const toolCallsOf = () => []; const toolCallIdOf = () => undefined; const isToolResult = () => false; const timingData = () => undefined; const transcriptSource = () => []; const agentTimingMap = () => new Map(); const phases = () => [{ name: "first", agents: ["first-agent"] }, { name: "second", agents: ["second-agent"] }, { name: "fallback", agents: ["cycle-a", "cycle-b", "unknown"] }]; ${source.slice(helperStart, helperEnd)}; return { buildTopologyData }; })()`) as { buildTopologyData: (record: Record<string, unknown>, timings: Map<string, unknown[]>) => { source: string; nodes: Array<{ id: string; label: string }>; edges: Array<{ from: string; to: string }> } };
  const repeatedPath = ["pipeline", "parallel"];
  const record = { run: { workflowName: "evidence-only", agents: [
    { id: "first-agent", name: "first", state: "completed", structuralPath: repeatedPath },
    { id: "second-agent", name: "second", state: "completed", structuralPath: repeatedPath },
    { id: "cycle-a", name: "cycle-a", state: "running", parentId: "cycle-b" },
    { id: "cycle-b", name: "cycle-b", state: "running", parentId: "cycle-a" },
    { id: "unknown", name: "unknown", state: "running", parentId: "missing" },
  ] } };
  const data = helpers.buildTopologyData(record, new Map());
  const scopes = data.nodes.filter((node) => node.label === "Scope: pipeline > parallel");
  assert.equal(scopes.length, 2);
  assert.notEqual(scopes[0]?.id, scopes[1]?.id);
  const agent = (name: string) => data.nodes.find((node) => node.label.startsWith(`${name} ·`))?.id;
  const ids = [agent("first"), agent("second"), agent("cycle-a"), agent("cycle-b"), agent("unknown")];
  assert.ok(ids.every((id): id is string => Boolean(id)));
  assert.equal(data.edges.some((edge) => ids.includes(edge.from) && ids.includes(edge.to)), false);
  assert.match(data.source, /Phase first/);
  assert.doesNotMatch(data.source, /missing/);
  assert.match(source, /validTopologyParent\(agent, byId\)/);
  assert.match(source, /if \(parent && agentNodes\.has\(parent\.id\)\) addEdge/);
});

void test("Trajectory topology represents failed, live, and safely bounded calls", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryTopologyHelpers(source);
  const entries = [
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "bad", name: "bash", arguments: { command: "boom" } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "bad", isError: true, content: [] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "live", name: "read", arguments: { path: "partial" } }] } },
  ];
  const data = helpers.buildAgentTopologyData(entries, { id: "agent", state: "running" });
  assert.match(data.source, /bash 1 · failed/);
  assert.match(data.source, /read 1 · running/);
  assert.ok(data.source.length < 2000);
});

void test("Trajectory topology sanitizes labels and bounds partial invocation data", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryTopologyHelpers(source);
  const hostile = { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "hostile", name: `evil"] --> %%init <script>`, arguments: { value: `</script><img src=x onerror=alert(1)> & "quoted"` } }] } };
  const failed = { type: "message", message: { role: "toolResult", toolCallId: "hostile", isError: true, content: [] } };
  const data = helpers.buildAgentTopologyData([hostile, failed], { id: "agent", state: "running" });
  assert.equal(helpers.topologyLabel("%%init: html <script> \"quoted\" [x] --> y"), "init html script quoted x y");
  assert.doesNotMatch(data.source, /<script|%%init|onerror|<img/);
  assert.match(data.source, /evil/);
  assert.match(data.source, /failed/);
  const calls = Array.from({ length: 250 }, (_, index) => ({ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: `call-${String(index)}`, name: "read", arguments: { path: `file-${String(index)}` } }] } }));
  const bounded = helpers.buildAgentTopologyData(calls, { id: "agent", state: "running" });
  assert.equal(bounded.calls.length, 200);
  assert.ok(bounded.edges.length <= 2000);
  assert.equal(bounded.source, helpers.buildAgentTopologyData(calls, { id: "agent", state: "running" }).source);
  assert.match(source, /securityLevel: "strict"/);
  assert.match(source, /deterministicIds: true/);
});

void test("Trajectory overview topology aggregates mixed tool outcomes without losing counts", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    const topologyLabel");
  const helperEnd = source.indexOf("    function mermaidTheme", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const helpers = runInNewContext(`(() => { const state = {}; const toolPreviewValue = (value) => ({ row: String(value ?? "") }); const toolCallsOf = (entry) => Array.isArray(entry.message?.content) ? entry.message.content.filter((part) => part?.type === "toolCall") : []; const toolCallIdOf = (entry) => entry.toolCallId || entry.message?.toolCallId; const isToolResult = (entry) => entry.type === "tool_result" || entry.message?.role === "toolResult"; const timingData = (entry) => entry?.data?.toolCallId ? entry.data : undefined; const transcriptSource = (_record, agent) => agent.transcript || []; const phases = (record) => [{ name: "workflow", agents: record.run.agents.map((agent) => agent.id) }]; ${source.slice(helperStart, helperEnd)}; return { buildTopologyData }; })()`) as { buildTopologyData: (record: Record<string, unknown>, timings: Map<string, unknown[]>) => { source: string } };
  const call = (id: string) => ({ type: "toolCall", id, name: "bash", arguments: { command: id } });
  const record = { run: { workflowName: "mixed", agents: [{ id: "agent", name: "agent", state: "failed", transcript: [
    { type: "message", message: { role: "assistant", content: [call("done")] } },
    { type: "message", message: { role: "toolResult", toolCallId: "done", content: [] } },
    { type: "message", message: { role: "assistant", content: [call("bad")] } },
    { type: "message", message: { role: "toolResult", toolCallId: "bad", isError: true, content: [] } },
  ] }] } };
  assert.match(helpers.buildTopologyData(record, new Map()).source, /bash · failed · 2/);
});

void test("Trajectory Mermaid topology rendering is strict, stable for identical signatures, and ignores stale results", async () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    function mermaidTheme");
  const helperEnd = source.indexOf("    function phases", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const status = { textContent: "", isConnected: true, classList: { error: false, add(name: string) { this.error = name === "error"; } } };
  const chart = { innerHTML: "", isConnected: true, querySelector: (selector: string) => selector === "svg" && chart.innerHTML ? {} : null };
  const document = { documentElement: { dataset: { theme: "tty" } } };
  const state = { topologyRender: { overview: { generation: 0, signature: "old", target: "" }, detail: { generation: 0, signature: "", target: "" } } };
  const pending: Array<(value: { svg: string }) => void> = [];
  const renderIds: string[] = [];
  const configs: Array<Record<string, unknown>> = [];
  const mermaid = { initialize: (config: Record<string, unknown>) => configs.push(config), render: (id: string) => { renderIds.push(id); return new Promise<{ svg: string }>((resolve) => pending.push(resolve)); } };
  const data = { source: "flowchart LR\n  a[\"A\"]", nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [] };
  const helpers = runInNewContext(`(() => { const $ = (id) => id === "topology-status" ? status : chart; ${source.slice(helperStart, helperEnd)}; return { renderMermaidTopology, topologyRenderId }; })()`, { document, state, status, chart, mermaid, window: { mermaid } }) as { renderMermaidTopology: (value: { source: string; nodes: readonly Record<string, unknown>[]; edges: readonly Record<string, unknown>[] }, title: string, signature: string, chartId: string, statusId: string) => Promise<void>; topologyRenderId: (signature: string) => string };
  const first = helpers.renderMermaidTopology(data, "Tool topology", "old", "topology-chart", "topology-status");
  pending[0]?.({ svg: "<svg>first</svg>" });
  await first;
  const second = helpers.renderMermaidTopology(data, "Tool topology", "old", "topology-chart", "topology-status");
  await second;
  assert.equal(renderIds.length, 1, "a connected rendered chart is a same-signature no-op");
  assert.equal(renderIds[0], helpers.topologyRenderId("old"));
  assert.equal(configs[0]?.securityLevel, "strict");
  state.topologyRender.overview.signature = "pending";
  const pendingRender = helpers.renderMermaidTopology(data, "Tool topology", "pending", "topology-chart", "topology-status");
  const duplicatePending = helpers.renderMermaidTopology(data, "Tool topology", "pending", "topology-chart", "topology-status");
  assert.equal(renderIds.length, 2, "same-signature pending work is coalesced");
  pending[1]?.({ svg: "<svg>pending</svg>" });
  await Promise.all([pendingRender, duplicatePending]);
  assert.equal(chart.innerHTML, "<svg>pending</svg>");
  const stale = helpers.renderMermaidTopology(data, "Tool topology", "stale", "topology-chart", "topology-status");
  const current = helpers.renderMermaidTopology(data, "Tool topology", "current", "topology-chart", "topology-status");
  assert.equal(renderIds.length, 4);
  pending[2]?.({ svg: "<svg>stale</svg>" });
  await stale;
  assert.equal(chart.innerHTML, "<svg>pending</svg>");
  pending[3]?.({ svg: "<svg>current</svg>" });
  await current;
  assert.equal(chart.innerHTML, "<svg>current</svg>");
});
void test("Trajectory overview and detail topology renders keep independent generations", async () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    function mermaidTheme");
  const helperEnd = source.indexOf("    function phases", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const charts = { overview: { innerHTML: "", isConnected: true }, detail: { innerHTML: "", isConnected: true } };
  const statuses = { overview: { textContent: "", isConnected: true, classList: { add: () => {} } }, detail: { textContent: "", isConnected: true, classList: { add: () => {} } } };
  const document = { documentElement: { dataset: { theme: "paper" } }, body: { dataset: { view: "run" } } };
  const state = { topologyRender: { overview: { generation: 0, signature: "", target: "" }, detail: { generation: 0, signature: "", target: "" } } };
  const pending: Array<(value: { svg: string }) => void> = [];
  const mermaid = { initialize: () => {}, render: () => new Promise<{ svg: string }>((resolve) => pending.push(resolve)) };
  const data = { source: 'flowchart LR\n  a["A"]', nodes: [{ id: "a", label: "A" }, { id: "b", label: "B" }], edges: [] };
  const $ = (id: string) => id === "overview-status" ? statuses.overview : id === "overview-chart" ? charts.overview : id === "detail-status" ? statuses.detail : charts.detail;
  const helpers = runInNewContext(`(() => { ${source.slice(helperStart, helperEnd)}; return { renderMermaidTopology }; })()`, { document, state, $, mermaid, window: { mermaid } }) as { renderMermaidTopology: (value: typeof data, title: string, signature: string, chartId: string, statusId: string, level: "overview" | "detail") => Promise<void> };
  const overview = helpers.renderMermaidTopology(data, "Overview", "overview-a", "overview-chart", "overview-status", "overview");
  const detail = helpers.renderMermaidTopology(data, "Detail", "detail-b", "detail-chart", "detail-status", "detail");
  assert.equal(state.topologyRender.overview.generation, 1);
  assert.equal(state.topologyRender.detail.generation, 1);
  assert.equal(state.topologyRender.overview.signature, "overview-a");
  assert.equal(state.topologyRender.detail.signature, "detail-b");
  pending[0]?.({ svg: "<svg>overview</svg>" });
  await overview;
  assert.equal(charts.overview.innerHTML, "<svg>overview</svg>");
  assert.equal(charts.detail.innerHTML, "");
  pending[1]?.({ svg: "<svg>detail</svg>" });
  await detail;
  assert.equal(charts.detail.innerHTML, "<svg>detail</svg>");
  const stale = helpers.renderMermaidTopology(data, "Detail", "detail-old", "detail-chart", "detail-status", "detail");
  const current = helpers.renderMermaidTopology(data, "Detail", "detail-new", "detail-chart", "detail-status", "detail");
  assert.equal(state.topologyRender.overview.generation, 1);
  assert.equal(state.topologyRender.detail.generation, 3);
  assert.equal(state.topologyRender.detail.signature, "detail-new");
  pending[2]?.({ svg: "<svg>stale</svg>" });
  await stale;
  assert.equal(charts.detail.innerHTML, "<svg>detail</svg>");
  pending[3]?.({ svg: "<svg>current</svg>" });
  await current;
  assert.equal(charts.detail.innerHTML, "<svg>current</svg>");
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

void test("Trajectory timeline clicks highlight the matching transcript event", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryPreviewHelpers(source);
  const html = helpers.renderAgentTimeline([{ type: "message", timestamp: 1000, message: { role: "user", content: "hello" } }]);
  assert.match(html, /<i class="tick in" data-event="0" style="left:0%;" title="user"><\/i>/);
  assert.doesNotMatch(html, /title="[^"]*><\/i>/);
  assert.match(source, /\.evt\.timeline-highlight/);
  assert.match(source, /function highlightEvent\(index\)/);
  assert.match(source, /scrollIntoView\(\{ block: "nearest" \}\)/);
  assert.match(source, /\$\("agent-timeline"\)\.addEventListener\("click"/);
});

void test("Trajectory clears timeline highlights when leaving the view", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const start = source.indexOf("    function clearEventHighlight()");
  const end = source.indexOf("    function nearestTimelineEvent", start);
  assert.ok(start >= 0 && end > start);
  const result = runInNewContext(`(() => {
    const classes = new Set();
    const item = { dataset: { event: "0" }, offsetWidth: 0, classList: { add: (name) => classes.add(name), remove: (name) => classes.delete(name) }, scrollIntoView: () => {} };
    const events = { querySelectorAll: (selector) => selector === "[data-event]" ? [item] : classes.has("timeline-highlight") ? [item] : [] };
    const state = { timelineHighlight: null };
    let eventHighlightTimer;
    let timeoutCleared = false;
    const $ = (id) => id === "events" ? events : undefined;
    const setTimeout = () => "timer";
    const clearTimeout = () => { timeoutCleared = true; };
    const applyEventSearch = () => {};
    ${source.slice(start, end)}
    highlightEvent(0);
    const highlighted = classes.has("timeline-highlight");
    const stateAfterHighlight = state.timelineHighlight;
    clearEventHighlight();
    return { highlighted, stateAfterHighlight, timeoutCleared, removed: !classes.has("timeline-highlight"), stateAfterClear: state.timelineHighlight };
  })()`) as { highlighted: boolean; stateAfterHighlight: number; timeoutCleared: boolean; removed: boolean; stateAfterClear: null };
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { highlighted: true, stateAfterHighlight: 0, timeoutCleared: true, removed: true, stateAfterClear: null });
});

void test("Trajectory topology uses linear turn hubs and retiming cannot alter the graph", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryTopologyHelpers(source);
  const callsInTurn = [4, 3, 2, 1];
  const entries: Array<Record<string, unknown>> = [];
  let callNumber = 0;
  callsInTurn.forEach((count, turn) => {
    entries.push({ type: "message", timestamp: `2024-01-${String(turn + 1).padStart(2, "0")}`, message: { role: "assistant", content: Array.from({ length: count }, () => { const id = `call-${String(callNumber)}`; callNumber += 1; return { type: "toolCall", id, name: turn % 2 ? "bash" : "read", arguments: { command: `private-command-${id}` } }; }) } });
  });
  const data = helpers.buildAgentTopologyData(entries, { id: "agent", label: "agent", state: "running" });
  const calls = callsInTurn.reduce((sum, count) => sum + count, 0);
  const turns = callsInTurn.length;
  assert.equal(data.calls.length, calls);
  assert.ok(data.nodes.some((node) => node.id === "turn-0-branch"));
  assert.ok(data.nodes.some((node) => node.id === "turn-3-join"));
  assert.ok(data.edges.length <= 2 * calls + 2 * turns - 1, "turn hubs keep edge growth linear");
  assert.equal(data.edges.some((edge) => String(edge.from).startsWith("operation-") && String(edge.to).startsWith("operation-")), false);
  assert.equal(data.edges.filter((edge) => String(edge.from).startsWith("turn-") && String(edge.from).endsWith("-branch")).length, calls);
  const retimed = entries.map((entry, index) => ({ ...entry, timestamp: `2099-12-${String(31 - index).padStart(2, "0")}` }));
  assert.equal(helpers.buildAgentTopologyData(retimed, { id: "agent", label: "agent", state: "running" }).source, data.source);
});

void test("Trajectory topology invocation labels are compact, bounded, and keep payloads in the inspector", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helpers = loadTrajectoryTopologyHelpers(source);
  const command = "C:/private/secret/project && " + "argument ".repeat(80);
  const entries = [{ type: "message", message: { role: "assistant", content: [
    { type: "toolCall", id: "one", name: "read", arguments: { path: command } },
    { type: "toolCall", id: "two", name: "read", arguments: { path: command } },
  ] } }];
  const data = helpers.buildAgentTopologyData(entries, { id: "agent", state: "running" });
  const labels = data.nodes.filter((node) => String(node.id).startsWith("operation-")).map((node) => String(node.label));
  assert.equal(JSON.stringify(labels), JSON.stringify(["read #1 · running", "read #2 · running"]));
  assert.ok(labels.every((label) => label.length <= 100));
  assert.equal(data.source.includes(command), false);
  assert.equal(data.source.includes("argument argument"), false);
  assert.match(source, /renderToolPane/);
  assert.match(source, /data-pane="payload"/);
});

void test("Trajectory patch preserves document scroll and async topology replacement preserves both viewport axes", async () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  assert.match(source, /focused\.focus\(\{ preventScroll: true \}\)/);
  const patchStart = source.indexOf("    function pageScrollPosition()");
  const patchEnd = source.indexOf("    const esc", patchStart);
  assert.ok(patchStart >= 0 && patchEnd > patchStart);
  const root = { nodeName: "DIV", innerHTML: "old" };
  const target = { insertAdjacentHTML: (_position: string, html: string) => { target.html = html; }, html: "" };
  const document = { documentElement: { scrollLeft: 17, scrollTop: 29 }, body: { scrollLeft: 17, scrollTop: 29 }, activeElement: undefined, createElement: () => target };
  const window = { scrollX: 17, scrollY: 29, scrollTo: (left: number, top: number) => { window.scrollX = left; window.scrollY = top; } };
  const result = runInNewContext(`(() => { ${source.slice(patchStart, patchEnd)}; patch(root, "new"); return { html: root.innerHTML, left: document.documentElement.scrollLeft, top: document.documentElement.scrollTop }; })()`, { document, window, root, morphdom: (value: typeof root, replacement: typeof target) => { value.innerHTML = replacement.html; document.documentElement.scrollLeft = 0; document.documentElement.scrollTop = 0; } }) as { html: string; left: number; top: number };
  assert.equal(result.html, "new");
  assert.equal(result.left, 17);
  assert.equal(result.top, 29);

  const helperStart = source.indexOf("    function mermaidTheme");
  const helperEnd = source.indexOf("    function phases", helperStart);
  const pageStart = source.indexOf("    function pageScrollPosition()");
  assert.ok(helperStart >= 0 && helperEnd > helperStart && pageStart >= 0 && pageStart < helperStart);
  const status = { textContent: "", isConnected: true, classList: { add: () => {} } };
  const chart = { innerHTML: "", isConnected: true, style: {} as Record<string, string>, dataset: {} as Record<string, string>, querySelector: (selector: string) => selector === "svg" && chart.innerHTML ? {} : null };
  const viewport = { scrollLeft: 120, scrollTop: 80, scrollWidth: 1000, scrollHeight: 900, clientWidth: 200, clientHeight: 200, dataset: {} as Record<string, string>, querySelector: (selector: string) => selector === ".topology-chart" ? chart : null, addEventListener: () => {} };
  const scrollToCalls: Array<[number, number]> = [];
  const renderDocument = { documentElement: { dataset: { theme: "tty" }, scrollLeft: 17, scrollTop: 29 }, body: { dataset: { view: "run" }, scrollLeft: 17, scrollTop: 29 }, querySelector: (selector: string) => selector === '[data-topology-viewport="overview"]' ? viewport : null, querySelectorAll: () => [] };
  const renderWindow = { scrollX: 17, scrollY: 29, scrollTo: (left: number, top: number) => { scrollToCalls.push([left, top]); } };
  const renderState = { topologyRender: { overview: { generation: 0, signature: "", target: "" }, detail: { generation: 0, signature: "", target: "" } } };
  let resolveRender: ((value: { svg: string }) => void) | undefined;
  const mermaid = { initialize: () => {}, render: () => new Promise<{ svg: string }>((resolve) => { resolveRender = resolve; }) };
  const renderResult = runInNewContext(`(() => { ${source.slice(pageStart, helperStart)} ${source.slice(helperStart, helperEnd)}; return renderMermaidTopology(data, "Overview", "sig", "topology-chart", "topology-status", "overview", ""); })()`, { document: renderDocument, window: { ...renderWindow, mermaid }, state: renderState, mermaid, data: { source: "flowchart LR", nodes: [{ id: "a" }, { id: "b" }], edges: [] }, $: (id: string) => id === "topology-status" ? status : chart, morphdom: () => {} }) as Promise<void>;
  viewport.scrollLeft = 120;
  viewport.scrollTop = 80;
  resolveRender?.({ svg: "<svg>new</svg>" });
  await renderResult;
  assert.equal(chart.innerHTML, "<svg>new</svg>");
  assert.equal(viewport.scrollLeft, 120);
  assert.equal(viewport.scrollTop, 80);
  assert.deepEqual(scrollToCalls.at(-1), [17, 29]);
});

void test("Trajectory topology zoom is independent, clamped, resettable, accessible, and excluded from signatures", () => {
  const source = readFileSync(new URL("../src/assets/index.html", import.meta.url), "utf8");
  const helperStart = source.indexOf("    function topologyLevelState");
  const helperEnd = source.indexOf("    function phases", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  const overviewStatus = { textContent: "" };
  const detailStatus = { textContent: "" };
  const overviewReset = { setAttribute: () => {} };
  const detailReset = { setAttribute: () => {} };
  const svgAttributes: Record<string, string> = { viewBox: "0 0 640 320", width: "100%", height: "100%" };
  const svg = { style: {} as Record<string, string>, getAttribute: (name: string) => svgAttributes[name] || null, setAttribute: (name: string, value: string) => { svgAttributes[name] = value; }, getBBox: () => ({ width: 640, height: 320 }) };
  const chart = { style: {} as Record<string, string>, dataset: {} as Record<string, string>, querySelector: (selector: string) => selector === "svg" ? svg : null };
  const viewport = { scrollLeft: 40, scrollTop: 30, scrollWidth: 1000, scrollHeight: 900, clientWidth: 200, clientHeight: 200, querySelector: (selector: string) => selector === ".topology-chart" ? chart : null, getBoundingClientRect: () => ({ left: 0, top: 0 }) };
  const document = { querySelector: () => viewport, querySelectorAll: (selector: string) => selector.includes("overview") ? selector.includes("zoom-status") ? [overviewStatus] : [overviewReset] : selector.includes("zoom-status") ? [detailStatus] : [detailReset] };
  const state = { topologyRender: { overview: { generation: 0, signature: "overview", target: "" }, detail: { generation: 0, signature: "detail", target: "" } } };
  const helpers = runInNewContext(`(() => { const topologyZoomMin = 50; const topologyZoomMax = 200; const topologyZoomStep = 25; const topologyZoomDefault = 100; ${source.slice(helperStart, helperEnd)}; return { topologyLevelState, topologyApplyZoom, topologyApplyDimensions, topologyNaturalDimensions }; })()`, { document, state }) as { topologyLevelState: (level: "overview" | "detail") => { zoom: number }; topologyApplyZoom: (level: "overview" | "detail", value: number) => void; topologyApplyDimensions: (chart: Record<string, unknown>, svg: Record<string, unknown>, zoom: number) => { width: number; height: number; baseWidth: number; baseHeight: number }; topologyNaturalDimensions: (svg: Record<string, unknown>) => { width: number; height: number } };
  assert.deepEqual(JSON.parse(JSON.stringify(helpers.topologyNaturalDimensions(svg))), { width: 640, height: 320 });
  const intrinsic = helpers.topologyApplyDimensions(chart, svg, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(intrinsic)), { width: 640, height: 320, baseWidth: 640, baseHeight: 320 });
  assert.equal(chart.style.width, "640px");
  assert.equal(chart.style.height, "320px");
  assert.equal(svg.style.width, "640px");
  assert.equal(svg.style.height, "320px");
  const zoom125 = helpers.topologyApplyDimensions(chart, svg, 125);
  assert.deepEqual(JSON.parse(JSON.stringify(zoom125)), { width: 800, height: 400, baseWidth: 640, baseHeight: 320 });
  const zoom200 = helpers.topologyApplyDimensions(chart, svg, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(zoom200)), { width: 1280, height: 640, baseWidth: 640, baseHeight: 320 });
  assert.notEqual(chart.style.width, "640px");
  assert.notEqual(chart.style.height, "320px");
  const reset = helpers.topologyApplyDimensions(chart, svg, 100);
  assert.deepEqual(JSON.parse(JSON.stringify(reset)), JSON.parse(JSON.stringify(intrinsic)));
  assert.equal(chart.style.width, "640px");
  assert.equal(chart.style.height, "320px");
  assert.equal(chart.style.zoom, undefined);
  assert.equal(svg.style.zoom, undefined);
  assert.equal(chart.style.transform, undefined);
  assert.equal(svg.style.transform, undefined);
  assert.doesNotMatch(source, /(?:^|[;{])\s*zoom\s*:/m);
  assert.doesNotMatch(source, /style\.zoom|transform\s*:\s*scale/);
  assert.match(source, /\.topology-chart \{[^}]*width: max-content/);
  assert.match(source, /\.topology-chart svg \{[^}]*width: auto; height: auto/);
  helpers.topologyApplyZoom("overview", 999);
  assert.equal(helpers.topologyLevelState("overview").zoom, 200);
  helpers.topologyApplyZoom("overview", -1);
  assert.equal(helpers.topologyLevelState("overview").zoom, 50);
  helpers.topologyApplyZoom("overview", 100);
  helpers.topologyApplyZoom("detail", 999);
  assert.equal(helpers.topologyLevelState("overview").zoom, 100);
  assert.equal(helpers.topologyLevelState("detail").zoom, 200);
  assert.equal(overviewStatus.textContent, "100%");
  assert.equal(detailStatus.textContent, "200%");
  const wheelStart = source.indexOf('document.querySelector(".app").addEventListener("wheel"');
  const clickStart = source.indexOf('document.querySelector(".app").addEventListener("click"', wheelStart);
  assert.ok(wheelStart >= 0 && clickStart > wheelStart);
  const wheelSource = source.slice(wheelStart, clickStart);
  assert.match(wheelSource, /!event\.ctrlKey && !event\.metaKey/);
  assert.match(wheelSource, /event\.preventDefault\(\)/);
  assert.match(wheelSource, /passive: false/);
  assert.match(source, /data-topology-zoom="out"/);
  assert.match(source, /data-topology-zoom="reset"/);
  assert.match(source, /data-topology-zoom="in"/);
  assert.match(source, /role="region" aria-label="\$\{esc\(title\)\} graph viewport"/);
  assert.match(source, /signature = `run:\$\{record\.run\.id\}:\$\{json\(data\.nodes\)\}:\$\{json\(data\.edges\)\}:\$\{document\.documentElement\.dataset\.theme/);
  const ganttSource = source.slice(source.indexOf("function renderGantt"), source.indexOf("function renderSubagentGantt"));
  assert.doesNotMatch(ganttSource, /topologyApplyZoom|topologyZoom/);
});
