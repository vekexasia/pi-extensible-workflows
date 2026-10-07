import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { testExtensionApi } from "./support.js";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, RunStore } from "../src/index.js";
import type { PersistedRun } from "../src/persistence.js";
import type { RunState } from "../src/types.js";

type TestTool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
type TestSetup = { start: ((event: unknown, context: unknown) => Promise<void>) | undefined; command: (args: string, context: unknown) => Promise<void>; context: { cwd: string; hasUI: boolean; model: { provider: string; id: string }; sessionManager: { getSessionId: () => string }; ui: { notify(message: string): void; select(prompt: string, options: string[]): Promise<string | undefined>; input?: (prompt: string, placeholder?: string) => Promise<string | undefined> } }; tools: TestTool[]; notices: string[]; shutdown: (() => Promise<void>) | undefined };

async function createRun(home: string, cwd: string, id: string, state: RunState, extra: Partial<PersistedRun> = {}, script = `return ${JSON.stringify(id)};`): Promise<RunStore> {
  const store = new RunStore(cwd, "session", id, home);
  await store.create({ id, workflowName: id, cwd, sessionId: "session", state, agents: [], agentSessions: [], ...extra }, createLaunchSnapshot({ script, args: null, metadata: { name: id }, launchMode: "background", settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [] }));
  return store;
}

function setup(home: string, cwd: string, input?: string): TestSetup {
  let command!: TestSetup["command"];
  let start: TestSetup["start"];
  let shutdown: TestSetup["shutdown"];
  const tools: TestTool[] = [];
  const notices: string[] = [];
  const context = { cwd, hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify(message: string) { notices.push(message); }, select: async (_prompt: string, options: string[]) => options.find((option) => option === "Skip") ?? "Close", ...(input === undefined ? {} : { input: async () => input }) } };
  workflowExtension(testExtensionApi({
    registerCommand(_name: string, options: { handler: (args: string, context: unknown) => Promise<void> }) { command = options.handler; },
    registerTool(tool: TestTool) { tools.push(tool); },
    on(name: string, handler: unknown) { if (name === "session_start") start = handler as TestSetup["start"]; if (name === "session_shutdown") shutdown = handler as TestSetup["shutdown"]; },
    getThinkingLevel: () => "medium",
    getActiveTools: () => ["workflow"],
  }), home);
  assert.ok(command);
  return { start, command, context, tools, notices, shutdown };
}

async function dashboardAction(testSetup: TestSetup, runId: string, action: string | ((options: string[]) => string | undefined), confirm: boolean | undefined = true, mode: "Foreground" | "Background" = "Foreground"): Promise<void> {
  let picked = false;
  let actionUsed = false;
  const context = { ...testSetup.context, mode: "rpc", ui: { ...testSetup.context.ui, select: async (prompt: string, options: string[]) => {
    if (options.includes("Skip")) return "Skip";
    if (prompt === "Workflows\n") { if (picked) return "Close"; picked = true; return options.find((option) => option.includes(runId)) ?? "Close"; }
    if (prompt.startsWith("Resume ")) return mode;
    if (typeof action === "function") return action(options);
    if (options.includes(action)) { if (actionUsed) return "Back"; actionUsed = true; return action; }
    return "Back";
  }, confirm: async () => confirm } };
  await testSetup.start?.({}, testSetup.context);
  await testSetup.command("", context);
}

void test("the workflow dashboard resumes interrupted runs with an explicit execution mode", async () => {
  for (const mode of ["Foreground", "Background"] as const) {
    const home = mkdtempSync(join(tmpdir(), `pi-extensible-workflows-contextual-resume-${mode.toLowerCase()}-`));
    const cwd = join(home, "project");
    const store = await createRun(home, cwd, `resume-${mode.toLowerCase()}`, "interrupted");
    const testSetup = setup(home, cwd);
    await dashboardAction(testSetup, store.runId, "Resume", true, mode);
    for (let attempt = 0; attempt < 100 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal((await store.load()).run.state, "completed");
    assert.equal((await store.load()).run.delivery?.mode, mode === "Foreground" ? "foreground" : "background");
    await testSetup.shutdown?.();
  }
});

void test("budget adjustments and decisions remain reachable from the workflow root", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-contextual-budget-"));
  const cwd = join(home, "project");
  const store = await createRun(home, cwd, "budget-run", "budget_exhausted", { budget: { tokens: { hard: 1 } }, budgetVersion: 1, usage: { tokens: 1, costUsd: 0, durationMs: 0, agentLaunches: 0 } });
  const testSetup = setup(home, cwd, "{\"tokens\":{\"hard\":2}}");
  let adjusted = false;
  await dashboardAction(testSetup, store.runId, (options) => { if (!adjusted && options.includes("Adjust budget")) { adjusted = true; return "Adjust budget"; } return options.find((option) => option.startsWith("Approve budget ")) ?? "Back"; });
  assert.ok((await store.pendingWorkflowDecisions()).length === 0 || testSetup.notices.some((message) => message.includes("Budget")));
  for (let attempt = 0; attempt < 1_000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await store.load()).run.state, "completed");
  await testSetup.shutdown?.();
});

void test("stop and delete dashboard actions retain confirmation", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-contextual-confirm-"));
  const cwd = join(home, "project");
  const stopStore = await createRun(home, cwd, "stop-run", "interrupted");
  const stopSetup = setup(home, cwd);
  await dashboardAction(stopSetup, stopStore.runId, "Stop", false);
  assert.equal((await stopStore.load()).run.state, "interrupted");
  await dashboardAction(stopSetup, stopStore.runId, "Stop", true);
  assert.equal((await stopStore.load()).run.state, "stopped");
  assert.ok(stopSetup.notices.some((message) => message.includes("Stopped workflow stop-run")));
  await stopSetup.shutdown?.();

  const deleteStore = await createRun(home, cwd, "delete-run", "completed");
  const deleteSetup = setup(home, cwd);
  await dashboardAction(deleteSetup, deleteStore.runId, "Delete", true);
  await assert.rejects(deleteStore.load());
  assert.ok(deleteSetup.notices.some((message) => message.includes("Deleted workflow delete-run")));
  await deleteSetup.shutdown?.();
});
