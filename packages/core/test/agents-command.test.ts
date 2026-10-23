import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentsActionProvider, SubagentPresenter, SubagentsHandle } from "../src/agents-actions-contract.js";
import type { AgentsWorkspaceState } from "../src/agents-workspace.js";
import { acquireSessionLease, type AgentAttemptSummary } from "../src/index.js";
import { hasLiveSessionLease } from "../src/persistence.js";
import { clearSubagentsHandle, setSubagentsHandle } from "../src/subagent-actions-handle.js";
import { clearSubagentManager, setSubagentManager } from "../src/subagent-manager-handle.js";
import { createTranscriptView } from "../src/transcript-components.js";
import type { SubagentManager } from "../subagents/src/contracts.js";
import { agentRecord, createRun, host, launch, project } from "./agents-workspace-harness.js";
import { executeCommand } from "./support.js";

const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
/** The attempt of an agent whose session is a real pi session file with one user message. */
function piSession(home: string, text: string): AgentAttemptSummary {
  const manager = SessionManager.create("/repo", join(home, "sessions"));
  manager.appendMessage({ role: "user", content: [{ type: "text", text }], timestamp: Date.now() });
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  return { attempt: 1, transport: "local", session: { transport: "local", sessionId: manager.getSessionId(), locator: { sessionFile } }, setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd: "/repo" }, accounting: ZERO };
}
function context(cwd: string, mode: string, notices: string[]): object {
  return { cwd, mode, hasUI: true, sessionManager: { getSessionId: () => "session" }, ui: { notify(message: string) { notices.push(message); }, setStatus() {} } };
}
/** A manager that lists one completed subagent of this Pi session. */
function subagentManager(id: string): SubagentManager {
  const row = { id, sessionId: "session", state: "completed", startedAt: 1, finishedAt: 2, attempts: 1, progress: { accounting: ZERO, toolCalls: [] } };
  return {
    async run() { throw new Error("unexpected run"); },
    async inspect(request) { return request.id === undefined ? [row] : row; },
    async steer() { throw new Error("unexpected steer"); },
    async stop() { throw new Error("unexpected stop"); },
    async retry() { throw new Error("unexpected retry"); },
  };
}

void test("/agents needs the TUI, says when the session has no agents, and opens the workspace on this session's agents", async () => {
  const { home, cwd } = project("agents-command");
  const { agents, opened } = host(home);
  assert.ok(agents, "the host registers /agents");
  const notices: string[] = [];
  await executeCommand(agents, "", context(cwd, "rpc", notices));
  assert.deepEqual(notices, ["/agents needs the TUI."]);
  await executeCommand(agents, "", context(cwd, "tui", notices));
  assert.deepEqual(notices.slice(1), ["No agents in this session."]);
  assert.equal(opened.length, 0, "no agents: the workspace does not open");
  // A run whose tree has no agent yet (its root and declared phases only) is shown, as /workflow shows it.
  await createRun({ home, cwd }, "run-empty", "completed", {}, launch({ phases: ["plan"] }));
  await executeCommand(agents, "", context(cwd, "tui", notices));
  assert.equal(notices.length, 2);
  assert.equal(opened.length, 1, "a run without agents: the workspace opens on it");

  await createRun({ home, cwd }, "run", "completed", { agents: [agentRecord("alpha-id", { attemptDetails: [piSession(home, "ALPHA PROMPT")] })] });
  await executeCommand(agents, "", context(cwd, "tui", notices));
  assert.equal(notices.length, 2);
  assert.equal(opened.length, 2);
  const options = opened[1]?.options;
  assert.ok(options);
  assert.equal(opened[1]?.ctx.cwd, cwd);
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

void test("/agents rejects arguments with a usage notice and opens nothing", async () => {
  const { home, cwd } = project("agents-command");
  await createRun({ home, cwd }, "run-empty", "completed", {}, launch({ phases: ["plan"] }));
  const { agents, opened } = host(home);
  assert.ok(agents);
  const notices: string[] = [];
  for (const mode of ["tui", "rpc"]) await executeCommand(agents, "  run-empty ", context(cwd, mode, notices));
  assert.deepEqual(notices, Array(2).fill("/agents takes no arguments. Use /agents to open the agents of this session."));
  assert.equal(opened.length, 0);
  await executeCommand(agents, "   ", context(cwd, "tui", notices));
  assert.equal(opened.length, 1, "blank arguments open the workspace as none do");
});

void test("/agents opens the workspace when the subagents cannot be listed, and the Subagents group says why", async () => {
  const { home, cwd } = project("agents-command");
  const { agents, opened } = host(home);
  assert.ok(agents);
  const manager = { inspect: async () => { throw new Error("inspect failed"); } } as unknown as SubagentManager;
  setSubagentManager(manager);
  try {
    const notices: string[] = [];
    await executeCommand(agents, "", context(cwd, "tui", notices));
    assert.deepEqual(notices, []);
    assert.equal(opened.length, 1);
    const listed = await opened[0]?.options.agents.list();
    const group = listed?.find((node) => node.key === "subagents");
    assert.ok(group, "the Subagents group is still listed");
    assert.deepEqual(listed?.filter((node) => node.parentKey === "subagents"), [], "with no subagent under it");
  } finally { clearSubagentManager(manager); }
});

void test("/agents takes this Pi session's lease before it lists anything, and opens nothing while another owner holds it", async () => {
  const { home, cwd } = project("agents-command");
  await createRun({ home, cwd }, "run", "completed", { agents: [agentRecord("alpha-id")] });
  const taken = await acquireSessionLease(cwd, "session", home);
  const blocked = host(home);
  assert.ok(blocked.agents);
  const notices: string[] = [];
  try {
    await executeCommand(blocked.agents, "", context(cwd, "tui", notices));
    assert.equal(notices.length, 1);
    assert.match(notices[0] ?? "", /^Cannot open the agents workspace: Pi session session is already owned/);
    assert.equal(blocked.opened.length, 0, "no workspace and no listing without the lease");
  } finally { await taken.release(); }

  assert.equal(await hasLiveSessionLease(cwd, "session", home), false);
  const { agents, opened, shutdown } = host(home);
  assert.ok(agents);
  await executeCommand(agents, "", context(cwd, "tui", notices));
  assert.equal(notices.length, 1, "nothing more to say");
  assert.equal(opened.length, 1);
  const closing = opened[0]?.options.shutdown;
  assert.ok(closing, "the workspace gets the host's shutdown signal");
  assert.equal(closing.aborted, false);
  assert.equal(await hasLiveSessionLease(cwd, "session", home), true, "the host holds the lease while the workspace is open");
  await shutdown?.();
  assert.equal(closing.aborted, true, "session_shutdown closes the workspace");
  assert.equal(await hasLiveSessionLease(cwd, "session", home), false, "session_shutdown releases it as before");
});

void test("/agents gives the workspace the workflow provider and the published subagent provider, runs a chosen action with Pi's dialogs and opens again", async () => {
  const { home, cwd } = project("agents-command");
  await createRun({ home, cwd }, "run", "completed", { agents: [agentRecord("alpha-id")] });
  const runs: string[] = [];
  const subagentProvider: AgentsActionProvider = {
    actions: async (target) => target.kind === "subagent" ? [{ label: "Steer" }] : [],
    run: async (target, label, ui) => { runs.push(`${target.kind}:${label}`); ui.notify("Steered subagent s."); return { select: "subagent:s" }; },
  };
  const presenter: SubagentPresenter = { describe: async (ids) => new Map(ids.map((id) => [id, { name: `named ${id}`, details: () => [`details of ${id}`] }])) };
  const handed: { readonly actions: unknown[]; readonly presenter: unknown[] } = { actions: [], presenter: [] };
  const handle: SubagentsHandle = {
    actions: (ctx) => { handed.actions.push(ctx); return subagentProvider; },
    presenter: (ctx) => { handed.presenter.push(ctx); return presenter; },
  };
  const manager = subagentManager("sub-1");
  setSubagentsHandle(handle);
  setSubagentManager(manager);
  try {
    const state: AgentsWorkspaceState = { selectedKey: "subagent:sub-1", row: 2, expansion: [["run:R", false]], focus: "transcript", sidebarVisible: true, toolsExpanded: true, detailsShown: true };
    const { agents, opened } = host(home, [{ target: { kind: "subagent", id: "s" }, label: "Steer", provider: subagentProvider, state }, undefined]);
    const notices: string[] = [];
    await executeCommand(agents, "", context(cwd, "tui", notices));
    assert.equal(opened.length, 2, "opened again after the action");
    const [first, second] = opened;
    assert.ok(first && second);
    const providers = first.options.actions ?? [];
    assert.equal(providers.length, 2);
    assert.equal(providers[1], subagentProvider, "the published provider second");
    assert.deepEqual(handed.actions, [first.ctx], "made for this command context");
    const workflowLabels = (await providers[0]?.actions({ kind: "run", runId: "run" }))?.map(({ label }) => label) ?? [];
    assert.ok(workflowLabels.includes("Model aliases") && workflowLabels.includes("Delete all completed"), `the workflow provider first: ${workflowLabels.join(", ")}`);
    assert.equal(typeof first.options.editorCommand, "function", "the editor command for the in-place editors");
    assert.deepEqual(runs, ["subagent:Steer"]);
    assert.deepEqual(notices, ["Steered subagent s."], "the action's notice through Pi");
    assert.deepEqual(second.options.notices, ["Steered subagent s."], "and in the status row");
    assert.deepEqual(second.options.state, state);
    assert.equal(second.options.initialKey, "subagent:s");
    const listed = await second.options.agents.list();
    assert.equal(listed.find((node) => node.key === "subagent:sub-1")?.agent?.name, "named sub-1", "the published presenter names the subagents");
    assert.ok(handed.presenter.every((ctx) => ctx === first.ctx) && handed.presenter.length > 0);
  } finally {
    clearSubagentManager(manager);
    clearSubagentsHandle(handle);
  }
});

void test("/agents without a published subagents handle gives the workspace the workflow provider only", async () => {
  const { home, cwd } = project("agents-command");
  await createRun({ home, cwd }, "run", "completed", { agents: [agentRecord("alpha-id")] });
  const { agents, opened } = host(home);
  const notices: string[] = [];
  await executeCommand(agents, "", context(cwd, "tui", notices));
  assert.equal(opened.length, 1);
  const providers = opened[0]?.options.actions ?? [];
  assert.equal(providers.length, 1);
  assert.ok((await providers[0]?.actions({ kind: "run", runId: "run" }))?.some(({ label }) => label === "Model aliases"));
  assert.deepEqual(await providers[0]?.actions({ kind: "subagent", id: "sub-1" }), [], "it owns no subagent");
  assert.deepEqual(notices, []);
});
