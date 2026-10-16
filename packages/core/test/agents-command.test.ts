import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentsWorkspaceOptions } from "../src/agents-workspace-contract.js";
import { getAgentsWorkspaceOpener, registerWorkflowNavigator, type WorkflowNavigatorDependencies } from "../src/host-navigator.js";
import workflowExtension from "../src/host.js";
import { createLaunchSnapshot, DEFAULT_SETTINGS, HARD_TERMINAL_RUN_STATES, RunStore, type AgentRecord, type PersistedRun } from "../src/index.js";
import { clearSubagentManager, setSubagentManager } from "../src/subagent-manager-handle.js";
import { createTranscriptView } from "../src/transcript-components.js";
import type { SubagentManager } from "../subagents/src/contracts.js";
import { executeCommand, testExtensionApi } from "./support.js";

type Command = (args: string, ctx: unknown) => Promise<void>;
type Opened = { readonly cwd: string; readonly options: AgentsWorkspaceOptions };
type Dashboard = { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void };
type DashboardFactory = (tui: { terminal: { rows: number }; requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => Dashboard;

const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "agents" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [] });
const homes: string[] = [];
after(() => { for (const home of homes) rmSync(home, { recursive: true, force: true }); });

function fixture(): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-agents-command-"));
  homes.push(home);
  const cwd = join(home, "project");
  mkdirSync(cwd);
  return { home, cwd };
}
/** A real pi session file with one user message. */
function piSession(home: string, text: string): { sessionId: string; file: string } {
  const manager = SessionManager.create("/repo", join(home, "sessions"));
  manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  const file = manager.getSessionFile();
  assert.ok(file);
  return { sessionId: manager.getSessionId(), file };
}
function agent(id: string, name: string, session?: { sessionId: string; file: string }): AgentRecord {
  const model = { provider: "openai", model: "gpt" };
  return { id, name, path: id, state: "completed", model, tools: [], attempts: 1, attemptDetails: session ? [{ attempt: 1, transport: "local", session: { transport: "local", sessionId: session.sessionId, locator: { sessionFile: session.file } }, setup: { hookNames: [], model, tools: [], cwd: "/repo" }, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }] : [] };
}
async function createRun(home: string, cwd: string, agents: readonly AgentRecord[], runId = "run", phases?: readonly string[]): Promise<void> {
  const launch = phases === undefined ? snapshot : createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "agents" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, phases, schemas: [] });
  await new RunStore(cwd, "session", runId, home).create({ id: runId, workflowName: "agents", cwd, sessionId: "session", state: "completed", agents: [...agents], agentSessions: [] }, launch);
}
/** The workflow extension with a fake workspace opener (it records each call, then runs `open`); the commands and the session_shutdown handler it registered. */
function host(home: string, open: () => Promise<void> = async () => {}): { agents: Command | undefined; workflow: Command | undefined; shutdown: (() => Promise<void>) | undefined; opened: Opened[] } {
  const commands = new Map<string, Command>();
  let shutdown: (() => Promise<void>) | undefined;
  const opened: Opened[] = [];
  workflowExtension(testExtensionApi({
    registerCommand(name: string, options: { handler: Command }) { commands.set(name, options.handler); },
    registerTool() {},
    on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; },
    getThinkingLevel: () => "medium",
    getActiveTools: () => ["workflow"],
  }), home, undefined, undefined, join(home, "agent"), [], async (ctx, options) => { opened.push({ cwd: ctx.cwd, options }); await open(); });
  return { agents: commands.get("agents"), workflow: commands.get("workflow"), shutdown, opened };
}
function context(cwd: string, mode: string, notices: string[]): object {
  return { cwd, mode, hasUI: true, sessionManager: { getSessionId: () => "session" }, ui: { notify(message: string) { notices.push(message); } } };
}

void test("/agents needs the TUI, says when the session has no agents, and opens the workspace on this session's agents", async () => {
  const { home, cwd } = fixture();
  const { agents, opened } = host(home);
  assert.ok(agents, "the host registers /agents");
  const notices: string[] = [];
  await executeCommand(agents, "", context(cwd, "rpc", notices));
  assert.deepEqual(notices, ["/agents needs the TUI."]);
  await executeCommand(agents, "", context(cwd, "tui", notices));
  assert.deepEqual(notices.slice(1), ["No agents in this session."]);
  assert.equal(opened.length, 0, "no agents: the workspace does not open");
  // A run whose tree has no agent yet (its root and declared phases only) is no agent either.
  await createRun(home, cwd, [], "run-empty", ["plan"]);
  await executeCommand(agents, "", context(cwd, "tui", notices));
  assert.deepEqual(notices.slice(2), ["No agents in this session."]);
  assert.equal(opened.length, 0, "a tree without agents: the workspace does not open");

  const alpha = piSession(home, "ALPHA PROMPT");
  await createRun(home, cwd, [agent("alpha-id", "alpha", alpha)]);
  await executeCommand(agents, "", context(cwd, "tui", notices));
  assert.equal(notices.length, 3);
  assert.equal(opened.length, 1);
  const options = opened[0]?.options;
  assert.ok(options);
  assert.equal(opened[0]?.cwd, cwd);
  assert.equal("initialKey" in options, false, "/agents selects the first agent");
  assert.equal(options.createView, createTranscriptView);
  const listed = await options.agents.list();
  assert.ok(listed.map((entry) => entry.key).includes("run:run-empty"));
  assert.deepEqual(listed.filter((entry) => entry.key.startsWith("run:run:") || entry.key === "run:run").map((entry) => [entry.key, entry.kind]), [["run:run", "run"], ["run:run:node:phase/unassigned", "phase"], ["run:run:alpha-id", "agent"]]);
  const first = listed.find((entry) => entry.key === "run:run:alpha-id")?.agent;
  assert.ok(first);
  const source = options.openSource(first);
  try {
    const poll = await source.poll();
    assert.equal(poll.status, "available");
    assert.match(JSON.stringify(poll.appended), /ALPHA PROMPT/, "openSource reads the agent's session file");
  } finally { await source.close(); }
});

void test("the host publishes its workspace for the /subagents dashboard until the session shuts down", async () => {
  const { home, cwd } = fixture();
  await createRun(home, cwd, [agent("alpha-id", "alpha")]);
  const { shutdown, opened } = host(home);
  const open = getAgentsWorkspaceOpener();
  assert.ok(open);
  const notices: string[] = [];
  await executeCommand((_args, ctx) => open(ctx, "subagent:run-1"), "", context(cwd, "tui", notices));
  assert.deepEqual(notices, []);
  assert.equal(opened[0]?.options.initialKey, "subagent:run-1");
  assert.ok(shutdown);
  await shutdown();
  assert.equal(getAgentsWorkspaceOpener(), undefined);
});

/** The /workflow command with this Pi session's run store and a fake workspace opener. */
function navigatorCommand(home: string, opened: { readonly cwd: string; readonly key: string }[], open?: (ctx: { cwd: string }, key: string) => Promise<void>): Command | undefined {
  let handler: Command | undefined;
  registerWorkflowNavigator({
    pi: { registerCommand(_name: string, options: { handler: Command }) { handler = options.handler; } },
    home, clipboard: async () => {}, extensionAgentDir: join(home, "agent"), runs: new Map(), terminalRunStates: new Map(), hardTerminalRunStates: HARD_TERMINAL_RUN_STATES,
    ensureSessionLease: async () => {}, isForegroundAttached: () => false, projectTrusted: () => false, registry: { agentAttemptActions: () => ({}) },
    liveAgents: { get: () => undefined, overlay: (run: PersistedRun) => run },
    openAgents: async (ctx: { cwd: string }, key: string) => { opened.push({ cwd: ctx.cwd, key }); await open?.(ctx, key); },
  } as unknown as WorkflowNavigatorDependencies);
  return handler;
}
/** Opens the run's dashboard in a TUI context of `rows` rows, runs `steps` against it, then closes it the way Pi does. */
async function drive(command: Command | undefined, cwd: string, steps: (dashboard: Dashboard, closed: () => boolean) => Promise<void>, rows = 40, notices: string[] = []): Promise<void> {
  assert.ok(command);
  let pickerCalls = 0;
  let closed = false;
  await executeCommand(command, "", {
    cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify(message: string, level?: string) { notices.push(`${level ?? "info"}: ${message}`); }, setStatus() {}, setWidget() {}, confirm: async () => false,
      select: async (_prompt: string, options: string[]) => { if (options.includes("Skip")) return "Skip"; pickerCalls += 1; return pickerCalls === 1 ? options[0] ?? "Close" : "Close"; },
      custom: async (factory: DashboardFactory) => {
        const dashboard = factory({ terminal: { rows }, requestRender() {} }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, () => { closed = true; });
        try { await steps(dashboard, () => closed); } finally { dashboard.dispose?.(); }
        return undefined;
      },
    },
  });
}
const screen = (dashboard: Dashboard): string => dashboard.render(130).join("\n");
const selectedRow = (dashboard: Dashboard): string => dashboard.render(130).find((line) => line.startsWith("→")) ?? "";
function selectAgent(dashboard: Dashboard, label: string): void {
  for (let step = 0; step < 30 && !selectedRow(dashboard).includes(`• ${label} ·`); step += 1) dashboard.handleInput?.("tui.select.down");
  assert.ok(selectedRow(dashboard).includes(`• ${label} ·`), screen(dashboard));
}
async function until(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() > deadline) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

void test("/workflow: t and View transcript open the workspace on the selected agent", async () => {
  const { home, cwd } = fixture();
  await createRun(home, cwd, [agent("alpha-id", "alpha"), agent("beta-id", "beta")]);
  const opened: { readonly cwd: string; readonly key: string }[] = [];
  await drive(navigatorCommand(home, opened), cwd, async (dashboard, closed) => {
    dashboard.handleInput?.("t");
    assert.equal(opened.length, 0, "t on a node that is not an agent opens nothing");
    selectAgent(dashboard, "alpha");
    assert.match(dashboard.render(130).at(-1) ?? "", /t transcript/);
    dashboard.handleInput?.("t");
    assert.deepEqual(opened, [{ cwd, key: "run:run:alpha-id" }]);
    selectAgent(dashboard, "beta");
    dashboard.handleInput?.("a");
    assert.match(screen(dashboard), /Agent actions[\s\S]*→ View transcript/);
    dashboard.handleInput?.("tui.select.confirm");
    assert.deepEqual(opened.at(-1), { cwd, key: "run:run:beta-id" });
    assert.doesNotMatch(screen(dashboard), /Agent actions/, "the menu closes behind the workspace");
    assert.equal(closed(), false, "the dashboard stays open under the workspace");
  });
  assert.equal(opened.length, 2);
});

void test("/workflow: an opener that rejects reports the error and leaves the dashboard open", async () => {
  const { home, cwd } = fixture();
  await createRun(home, cwd, [agent("alpha-id", "alpha")]);
  const opened: { readonly cwd: string; readonly key: string }[] = [];
  const notices: string[] = [];
  await drive(navigatorCommand(home, opened, async () => { throw new Error("boom"); }), cwd, async (dashboard, closed) => {
    selectAgent(dashboard, "alpha");
    dashboard.handleInput?.("t");
    await until(() => notices.length > 0, "the failure notice");
    assert.deepEqual(notices, ["error: Cannot open the agents workspace: boom"]);
    assert.equal(closed(), false, "the dashboard stays open");
    assert.match(selectedRow(dashboard), /• alpha ·/);
  }, 40, notices);
});

void test("/workflow: t on an agent below the first screen keeps that agent in view", async () => {
  const { home, cwd } = fixture();
  const names = Array.from({ length: 14 }, (_, index) => `agent-${String(index + 1).padStart(2, "0")}`);
  await createRun(home, cwd, names.map((name) => agent(`${name}-id`, name)));
  const opened: { readonly cwd: string; readonly key: string }[] = [];
  await drive(navigatorCommand(home, opened), cwd, async (dashboard) => {
    selectAgent(dashboard, "agent-14");
    assert.doesNotMatch(screen(dashboard), /agent-01/, "the tree scrolled to the last agent");
    dashboard.handleInput?.("t");
    assert.deepEqual(opened, [{ cwd, key: "run:run:agent-14-id" }]);
    assert.match(selectedRow(dashboard), /• agent-14 ·/, `the selected agent stays in view:\n${screen(dashboard)}`);
  }, 10);
});

void test("/workflow: on a short terminal the agent action menu stays whole in view, also when a tree line holds an option's text", async () => {
  const { home, cwd } = fixture();
  // An agent named like the first action: a lookup over every row would take its tree line for the option.
  await createRun(home, cwd, [agent("odd-id", "View transcript", piSession(home, "ODD PROMPT"))]);
  await drive(navigatorCommand(home, []), cwd, async (dashboard) => {
    selectAgent(dashboard, "View transcript");
    dashboard.handleInput?.("a");
    const lines = dashboard.render(130);
    assert.ok(lines.some((line) => line.includes("Agent actions")), `menu title in view:\n${lines.join("\n")}`);
    assert.ok(lines.some((line) => line.includes("→ View transcript")), "the selected action in view");
    assert.ok(lines.some((line) => / {2}Back\s*$/.test(line)), `last action in view:\n${lines.join("\n")}`);
  }, 12);
});

void test("a second t while the workspace opens or is open does not open another one", async () => {
  const { home, cwd } = fixture();
  await createRun(home, cwd, [agent("alpha-id", "alpha")]);
  let leave = (): void => {};
  const { workflow, opened } = host(home, () => new Promise<void>((resolve) => { leave = resolve; }));
  await drive(workflow, cwd, async (dashboard) => {
    selectAgent(dashboard, "alpha");
    // The first t is still listing the agents when the second one comes (key autorepeat).
    dashboard.handleInput?.("t");
    dashboard.handleInput?.("t");
    await until(() => opened.length > 0, "the workspace to open");
    dashboard.handleInput?.("t");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(opened.length, 1, "one workspace while the first is open");
    leave();
    await new Promise((resolve) => setTimeout(resolve, 10));
    dashboard.handleInput?.("t");
    await until(() => opened.length === 2, "the workspace to open again after it closed");
    leave();
  });
});

void test("/agents opens the workspace when listing the agents fails, so its title can say why", async () => {
  const { home, cwd } = fixture();
  const { agents, opened } = host(home);
  assert.ok(agents);
  const manager = { inspect: async () => { throw new Error("inspect failed"); } } as unknown as SubagentManager;
  setSubagentManager(manager);
  try {
    const notices: string[] = [];
    await executeCommand(agents, "", context(cwd, "tui", notices));
    assert.deepEqual(notices, []);
    assert.equal(opened.length, 1);
    await assert.rejects(opened[0]?.options.agents.list() ?? Promise.resolve(), /inspect failed/);
  } finally { clearSubagentManager(manager); }
});
