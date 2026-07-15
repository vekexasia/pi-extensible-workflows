import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, FairAgentScheduler, formatNavigatorDashboard, formatNavigatorRun, formatWorkflowPreview, formatWorkflowProgress, loadAgentDefinitions, loadSettings, parseRoleMarkdown, preflight, registerWorkflowDslExtension, RPC_LIMIT_BYTES, RunLifecycle, RunStore, runWorkflow, validateCheckpoint, WORKFLOW_ASYNC_COMPLETE_EVENT, WORKFLOW_ASYNC_STARTED_EVENT, WorkflowDslRegistry, WorkflowError, type JsonValue } from "../src/index.js";
import { listRunIds } from "../src/persistence.js";

const capabilities = {
  models: new Set(["openai/gpt"]), tools: new Set(["read"]), agentTypes: new Set(["reviewer"]), extensions: { git: "1.2.3" },
};
const valid = `phase("check"); agent("do it", { name: "reviewer", model: "openai/gpt", tools: ["read"], role: "reviewer" });`;

void test("workflow call preview summarizes inline and registered workflows safely", () => {
  const preview = formatWorkflowPreview({ script: valid, name: "review", description: "Review code" });
  assert.match(preview, /^workflow review\nReview code/m);
  assert.doesNotMatch(preview, /^(Phases|Steps|Agents|Models|Roles|Tools|Extensions):/m);
  assert.equal(formatWorkflowPreview({ workflow: "example.audit" }), "workflow example.audit\nRegistered workflow");
  assert.equal(formatWorkflowPreview({ script: "", workflow: "example.audit" }), "workflow example.audit\nRegistered workflow");
  assert.equal(formatWorkflowPreview({ script: "not javascript", name: "review" }), "workflow review");
});

void test("registers the workflow tool, command, and conditional skill", async () => {
  const tools: Array<{ name: string; promptGuidelines?: string[]; execute: (id?: unknown, params?: unknown, signal?: unknown, update?: unknown, ctx?: unknown) => Promise<unknown> }> = [];
  const commands: Array<{ name: string; options: { handler: (args: string, ctx: unknown) => Promise<void> } }> = [];
  let discover: (() => { skillPaths?: string[] } | undefined) | undefined;
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
    registerCommand(name: string, options: (typeof commands)[number]["options"]) { commands.push({ name, options }); },
    getThinkingLevel() { return "medium"; },
    getActiveTools() { return ["read", "workflow"]; },
    on(name: string, candidate: unknown) { if (name === "resources_discover") discover = candidate as typeof discover; },
  };
  workflowExtension(pi as never);
  assert.deepEqual(tools.map(({ name }) => name), ["workflow_respond", "workflow"]);
  assert.deepEqual(commands.map(({ name }) => name), ["workflow"]);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool);
  assert.equal(tool.promptGuidelines, undefined);
  assert.ok(discover);
  assert.ok(discover()?.skillPaths?.some((path) => existsSync(path)));
  await assert.rejects(tool.execute("id", { script: "return true" }, new AbortController().signal, undefined, { model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  await assert.rejects(tool.execute("id", { script: "return true", workflow: "missing" }, new AbortController().signal, undefined, { model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  await assert.rejects(tool.execute("id", { script: "" }, undefined, undefined, { model: undefined }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL");
});

void test("advertises only described effective roles in the system prompt while workflow is active", () => {
  type StartHandler = (event: { systemPrompt: string }, ctx: { cwd: string; isProjectTrusted?: () => boolean }) => { systemPrompt?: string } | undefined;
  let handler: StartHandler | undefined;
  const activeTools = ["workflow"];
  const cwd = mkdtempSync(join(tmpdir(), "pi-workflows-role-guidance-"));
  mkdirSync(join(cwd, ".pi", "piworkflows", "roles"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "piworkflows", "roles", "reviewer.md"), "---\ndescription: Reviews correctness\nmodel: private/model\ntools: [private-tool]\n---\nPRIVATE ROLE BODY");
  writeFileSync(join(cwd, ".pi", "piworkflows", "roles", "hidden.md"), "UNDESCRIBED ROLE BODY");
  workflowExtension({ registerTool() {}, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => activeTools, on(name: string, candidate: StartHandler) { if (name === "before_agent_start") handler = candidate; } } as never);
  assert.ok(handler);
  const result = handler({ systemPrompt: "BASE SYSTEM" }, { cwd });
  const guidance = result?.systemPrompt ?? "";
  assert.match(guidance, /^BASE SYSTEM\n\nWorkflow role descriptions:/);
  assert.match(guidance, /`reviewer`: Reviews correctness/);
  assert.doesNotMatch(guidance, /PRIVATE ROLE BODY|UNDESCRIBED ROLE BODY|private\/model|private-tool/);
  assert.equal(handler({ systemPrompt: "BASE SYSTEM" }, { cwd, isProjectTrusted: () => false }), undefined);
});

void test("background workflows emit compatible lifecycle events", async () => {
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  const events: Array<{ channel: string; data: Record<string, unknown> }> = [];
  let completed!: () => void;
  const done = new Promise<void>((resolve) => { completed = resolve; });
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-events-"));
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, sendMessage() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], events: { emit(channel: string, data: unknown) { events.push({ channel, data: data as Record<string, unknown> }); if (channel === WORKFLOW_ASYNC_COMPLETE_EVENT) completed(); } } } as never, home);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const result = await execute("id", { name: "events", script: `return true;` }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  await done;
  const runId = (JSON.parse(result.content[0]?.text ?? "{}") as { runId?: string }).runId;
  assert.ok(runId);
  assert.deepEqual(events.map(({ channel }) => channel), [WORKFLOW_ASYNC_STARTED_EVENT, WORKFLOW_ASYNC_COMPLETE_EVENT]);
});

void test("/workflow doctor formats the shared doctor report with active session tools", async () => {
  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  workflowExtension({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, getThinkingLevel: () => "medium", getActiveTools: () => ["read", "workflow"], on() {} } as never);
  let output = "";
  await commands[0]?.handler("doctor", { cwd: mkdtempSync(join(tmpdir(), "pi-workflows-slash-doctor-")), ui: { notify(text: string) { output = text; } } } as never);
  assert.match(output, /^# pi-workflows doctor/m);
  assert.match(output, /## Active tools\n- `read`/);
  assert.doesNotMatch(output, /- `workflow`/);
});

void test("registered extension workflows can run by name", async () => {
  registerWorkflowDslExtension({
    name: "reuseTest", version: "1.0.0", headline: "Reusable", description: "Reusable test workflows", methods: {},
    workflows: { hello: { description: "Say hello", script: `return args.name;` } },
  });
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {} } as never);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const result = await execute("id", { workflow: "reuseTest.hello", args: { name: "Andrea" }, foreground: true }, new AbortController().signal, undefined, { cwd: mkdtempSync(join(tmpdir(), "pi-workflows-reuse-")), model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  assert.equal(result.content[0]?.text, '"Andrea"');
});

void test("streams foreground workflow progress into its tool card", async () => {
  type Update = { content: Array<{ type: string; text: string }>; details: { run: { state: string; phase?: string } } };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-progress-"));
  workflowExtension({
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
    registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {},
  } as never, home);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool);
  const updates: Update[] = [];
  const result = await tool.execute("id", { name: "progress", script: `phase('work'); return true;`, foreground: true }, new AbortController().signal, (update: Update) => { updates.push(update); }, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }) as { details: { run: Parameters<typeof formatWorkflowProgress>[0] } };
  assert.ok(updates.some(({ details }) => details.run.phase === "work"));
  assert.equal(updates.at(-1)?.details.run.state, "completed");
  assert.match(formatWorkflowProgress(result.details.run), /✓ Workflow: progress/);
});

void test("workflow progress keeps each agent to one line with latest tool", () => {
  const run = { id: "run", workflowName: "live", cwd: "/repo", sessionId: "session", state: "running", phase: "work", agents: [{ id: "run:1", name: "review", path: "run:1", state: "running", model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "high" }, tools: ["read"], attempts: 1, accounting: { input: 120, output: 30, cacheRead: 40, cacheWrite: 0, cost: 0.01 }, toolCalls: [{ id: "call-1", name: "ls", state: "completed" }, { id: "call-2", name: "read", state: "running" }] }], nativeSessions: [] } as Parameters<typeof formatWorkflowProgress>[0];
  const rendered = formatWorkflowProgress(run);
  assert.match(rendered, /#1 ◇ review \[running\] ◇ read/);
  assert.doesNotMatch(rendered, /Model:/);
  assert.doesNotMatch(rendered, /Tokens:/);
  assert.doesNotMatch(rendered, /✓ ls/);
  assert.match(formatWorkflowProgress(run, "⠙"), /⠙ Workflow:[\s\S]*#1 ⠙ review \[running\] ⠙ read/);
  const agent = run.agents[0];
  assert.ok(agent);
  const reasoning = { ...run, agents: [{ ...agent, activity: { kind: "reasoning" as const, text: "checking cache" } }] };
  assert.match(formatWorkflowProgress(reasoning), /reasoning: checking cache/);
  const text = { ...run, agents: [{ ...agent, activity: { kind: "text" as const, text: "streaming answer" } }] };
  assert.match(formatWorkflowProgress(text), /> streaming answer/);
});

void test("session-scoped navigator shows metadata and confirms terminal deletion", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-navigator-"));
  const cwd = join(home, "project");
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'nav',description:'nav'}", args: null, metadata: { name: "nav", description: "nav" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: ["read"], agentTypes: [], extensions: {}, schemas: [] });
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "nav", cwd, sessionId: "session-a", state: "completed", phase: "review", agents: [{ id: "run-a:1", name: "reviewer", path: "run-a:1", state: "failed", model: { provider: "openai", model: "gpt", thinking: "medium" }, tools: ["read"], attempts: 2, attemptDetails: [{ attempt: 2, sessionId: "native-a", sessionFile: "/pi/native-a.jsonl", error: { code: "AGENT_FAILED", message: "boom" }, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }], accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }], nativeSessions: [{ sessionId: "native-a", sessionFile: "/pi/native-a.jsonl" }] }, snapshot);
  const same = new RunStore(cwd, "session-a", "run-c", home);
  await same.create({ id: "run-c", workflowName: "nav", cwd, sessionId: "session-a", state: "awaiting_input", agents: [], nativeSessions: [] }, snapshot);
  await same.awaitCheckpoint({ path: "checkpoint/ship", name: "ship", prompt: "Ship?", context: null });
  const other = new RunStore(cwd, "session-b", "run-b", home);
  await other.create({ id: "run-b", workflowName: "other", cwd, sessionId: "session-b", state: "completed", agents: [], nativeSessions: [] }, snapshot);
  const rendered = formatNavigatorRun(await store.load(), [], [{ owner: "reviewer", branch: "pi-workflows/run-a/tree", path: "/worktree", cwd: "/worktree/project", base: "abc" }]);
  assert.match(rendered, /Phase: review/);
  assert.match(rendered, /parent=root model=openai\/gpt:medium attempts=2 retries=1/);
  assert.match(rendered, /error=AGENT_FAILED: boom/);
  assert.match(rendered, /branch=pi-workflows\/run-a\/tree path=\/worktree/);
  assert.match(rendered, /native-a: \/pi\/native-a\.jsonl/);

  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  const prompts: string[] = [];
  const selections: string[][] = [];
  let deleteConfirmed = false;
  const pi = { registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["read", "workflow"] };
  workflowExtension(pi as never, home);
  let selectCall = 0;
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {}, select: async (prompt: string, options: string[]) => { prompts.push(prompt); selections.push(options); selectCall += 1; if (selectCall === 1) return options.find((option) => option.includes("completed")); if (selectCall === 2) return "Transcript paths"; if (selectCall === 3) return "Back"; return "Close"; }, confirm: async () => deleteConfirmed } };
  const command = commands[0]?.handler;
  assert.ok(command);
  await command("", ctx as never);
  assert.ok(selections.length >= 2);
  const runList = selections[0]?.join("\n") ?? "";
  assert.match(runList, /nav/);
  assert.match(runList, /Close/);
  const dashActions = selections[1]?.join("\n") ?? "";
  assert.match(dashActions, /Delete|Stop|Approve|Reject/);
  assert.match(dashActions, /Transcript paths/);
  assert.doesNotMatch(dashActions, /View script/);
  assert.ok(selections.some((options) => options.includes("/pi/native-a.jsonl")));
  assert.doesNotMatch(`${prompts.join("\n")}\n${selections.flat().join("\n")}`, /other/);
  await command("delete run-a", ctx as never);
  assert.equal(existsSync(store.directory), true);
  deleteConfirmed = true;
  await command("delete run-a", ctx as never);
  assert.equal(existsSync(store.directory), false);
});

void test("navigator dashboard auto-refreshes the selected run", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-refresh-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'live',description:'live'}", args: null, metadata: { name: "live", description: "live" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], extensions: {}, schemas: [] });
  await store.create({ id: "run", workflowName: "live", cwd, sessionId: "session", state: "running", phase: "before", agents: [], nativeSessions: [] }, snapshot);
  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  workflowExtension({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  let selectCall = 0;
  const ctx = {
    cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify() {}, confirm: async () => false,
      select: async (_prompt: string, options: string[]) => { selectCall += 1; return selectCall === 1 ? options[0] : "Back"; },
      custom: async (factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(): boolean }, done: (value?: string) => void) => { render(width: number): string[]; dispose?(): void }) => {
        const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, { matches: () => false }, () => {});
        assert.match(component.render(200).join("\n"), /phase: before/);
        const loaded = await store.load();
        await store.saveState({ ...loaded.run, phase: "after" });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        assert.match(component.render(200).join("\n"), /phase: after/);
        component.dispose?.();
        return "Close";
      },
    },
  };
  await commands[0]?.handler("", ctx as never);
});
void test("navigator opens the complete workflow script in a scrollable TUI pane", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-script-viewer-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const script = ["// SCRIPT_START", ...Array.from({ length: 20 }, (_, index) => `const line${String(index)} = ${String(index)};`), "// SCRIPT_END"].join("\n");
  const snapshot = createLaunchSnapshot({ script, args: null, metadata: { name: "viewer", description: "viewer" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], extensions: {}, schemas: [] });
  await store.create({ id: "run", workflowName: "viewer", cwd, sessionId: "session", state: "running", phase: "view", agents: [], nativeSessions: [] }, snapshot);
  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  workflowExtension({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  let selectCalls = 0;
  let customCalls = 0;
  const ctx = {
    cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify() {}, confirm: async () => false, select: async (_prompt: string, options: string[]) => { selectCalls += 1; return selectCalls === 1 ? options[0] : "Close"; },
      custom: async (factory: (tui: { terminal: { rows: number }; requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }) => {
        customCalls += 1;
        let result: string | undefined;
        const component = factory({ terminal: { rows: 8 }, requestRender() {} }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { result = value; });
        if (customCalls === 1) {
          const dashboard = component.render(80).join("\n");
          assert.match(dashboard, /View script/);
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.confirm");
        } else if (customCalls === 2) {
          assert.match(component.render(80).join("\n"), /SCRIPT_START/);
          for (let index = 0; index < 10; index += 1) component.handleInput?.("tui.select.pageDown");
          assert.match(component.render(80).join("\n"), /SCRIPT_END/);
          component.handleInput?.("tui.select.cancel");
        } else {
          component.handleInput?.("tui.select.cancel");
        }
        component.dispose?.();
        return result;
      },
    },
  };
  await commands[0]?.handler("", ctx as never);
  assert.equal(customCalls, 3);
});


void test("navigator attention-orders runs, disambiguates names, shows breadcrumbs and bulk delete", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-navigator-v2-"));
  const cwd = join(home, "project");
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'build',description:'b'}", args: null, metadata: { name: "build", description: "b" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: ["read"], agentTypes: [], extensions: {}, schemas: [] });
  const storeA = new RunStore(cwd, "s", "aaaa-1111-2222-3333", home);
  await storeA.create({ id: "aaaa-1111-2222-3333", workflowName: "build", cwd, sessionId: "s", state: "completed", agents: [{ id: "a:1", name: "scout", path: "a:1", state: "completed", model: { provider: "openai", model: "gpt" }, tools: ["read"], attempts: 1, accounting: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 } }], nativeSessions: [] }, snapshot);
  const storeB = new RunStore(cwd, "s", "bbbb-1111-2222-3333", home);
  await storeB.create({ id: "bbbb-1111-2222-3333", workflowName: "build", cwd, sessionId: "s", state: "running", phase: "review", agents: [{ id: "b:1", name: "root", path: "b:1", state: "completed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 }, { id: "b:2", name: "child", path: "b:2", state: "running", parentId: "b:1", model: { provider: "openai", model: "gpt", thinking: "high" }, tools: ["read"], attempts: 1, attemptDetails: [{ attempt: 1, sessionId: "active", sessionFile: "/sessions/active.jsonl", accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }], accounting: { input: 10, output: 5, cacheRead: 20, cacheWrite: 2, cost: 0.04 }, toolCalls: [{ id: "tc1", name: "read", state: "running" }], activity: { kind: "reasoning", text: "checking source" } }], nativeSessions: [{ sessionId: "active", sessionFile: "/sessions/active.jsonl" }] }, snapshot);
  const storeC = new RunStore(cwd, "s", "cccc-1111-2222-3333", home);
  await storeC.create({ id: "cccc-1111-2222-3333", workflowName: "deploy", cwd, sessionId: "s", state: "failed", agents: [{ id: "c:1", name: "deployer", path: "c:1", state: "failed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 2, attemptDetails: [{ attempt: 2, sessionId: "n", sessionFile: "/n", error: { code: "AGENT_FAILED", message: "timeout" }, accounting: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }], nativeSessions: [] }, snapshot);

  // Dashboard with breadcrumbs and inline errors
  const dashB = formatNavigatorDashboard((await storeB.load()).run, [], []);
  assert.match(dashB, /root > child/);
  assert.match(dashB, /phase: review/);
  assert.match(dashB, /1\/2 agents/);
  assert.match(dashB, /37 tok/);
  assert.match(dashB, /reasoning: checking source/);
  assert.doesNotMatch(dashB, /cache read|transcript attempt|openai\//);

  const dashC = formatNavigatorDashboard((await storeC.load()).run, [], []);
  assert.match(dashC, /error: AGENT_FAILED: timeout/);

  // Interactive: attention order + name disambiguation + bulk delete
  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  const prompts: string[] = [];
  const selections: string[][] = [];
  const pi = { registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["read", "workflow"] };
  workflowExtension(pi as never, home);
  let selectCall = 0;
  const confirmResult = true;
  const notified: string[] = [];
  const ctx = { cwd, hasUI: true, sessionManager: { getSessionId: () => "s" }, ui: { notify(msg: string) { notified.push(msg); }, select: async (_prompt: string, options: string[]) => { prompts.push(_prompt); selections.push(options); selectCall += 1; if (selectCall === 1) return "Delete all completed"; return "Close"; }, confirm: async () => confirmResult } };
  const command = commands[0]?.handler;
  assert.ok(command);
  await command("", ctx as never);

  // Verify attention order: running (build bbbb) before failed (deploy) before completed (build aaaa)
  const pickerOptions = selections[0] ?? [];
  assert.ok(pickerOptions.length >= 4);
  const runningIdx = pickerOptions.findIndex((o) => o.includes("running"));
  const failedIdx = pickerOptions.findIndex((o) => o.includes("failed"));
  const completedIdx = pickerOptions.findIndex((o) => o.includes("completed"));
  assert.ok(runningIdx < failedIdx, `running (${String(runningIdx)}) should come before failed (${String(failedIdx)})`);
  assert.ok(failedIdx < completedIdx, `failed (${String(failedIdx)}) should come before completed (${String(completedIdx)})`);

  // Verify name disambiguation: both 'build' runs get 8-char suffix
  const buildRows = pickerOptions.filter((o) => o.includes("build"));
  assert.equal(buildRows.length, 2);
  assert.ok(buildRows.every((r) => r.includes("aaaa-111") || r.includes("bbbb-111")), `Build rows should have suffixes: ${buildRows.join("; ")}`);

  // Verify 'Delete all completed' was offered
  assert.ok(pickerOptions.includes("Delete all completed"));

  // Verify bulk delete removed the completed run
  assert.ok(notified.some((n) => n.includes("Deleted all completed")));
  assert.equal(existsSync(storeA.directory), false);
  assert.equal(existsSync(storeB.directory), true);
  assert.equal(existsSync(storeC.directory), true);
});

void test("checkpoint contract is boolean-only and enforces UTF-8 limits", async () => {
  const accepted: unknown[] = [];
  assert.equal(await runWorkflow(`export const meta={name:'gate',description:'gate'}; return checkpoint({name:'ship',prompt:'Ship?',context:{sha:'abc'}});`, null, { checkpoint(input) { accepted.push(input); return false; } }).result, "rejected");
  assert.deepEqual(accepted, [{ name: "ship", prompt: "Ship?", context: { sha: "abc" } }]);
  assert.throws(() => validateCheckpoint({ name: "x", prompt: "😀".repeat(257), context: null }), /1024/);
  assert.throws(() => validateCheckpoint({ name: "x", prompt: "ok", context: "😀".repeat(1025) }), /4096/);
  assert.throws(() => validateCheckpoint({ name: "x", prompt: "ok", context: null, default: true }), /only name/);
});

void test("production checkpoints resolve in foreground navigator and background tool paths", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-checkpoint-runtime-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {},
    getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_respond"],
    sendMessage() {},
  };
  workflowExtension(pi as never, home);
  const workflow = tools.find(({ name }) => name === "workflow");
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(workflow && respond);
  const base = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const script = `export const meta={name:'gate',description:'gate'}; return checkpoint({name:'ship',prompt:'Ship?',context:{sha:'abc'}});`;
  let selections = 0;
  const foreground = await workflow.execute("id", { name: "gate", script, foreground: true }, new AbortController().signal, undefined, { ...base, mode: "rpc", hasUI: true, ui: { select: async () => ++selections === 1 ? undefined : "Approve" } }) as { content: Array<{ text: string }> };
  assert.equal(JSON.parse(foreground.content[0]?.text ?? ""), "approved");
  assert.equal(selections, 2);
  await assert.rejects(workflow.execute("id", { name: "gate", script, foreground: true }, new AbortController().signal, undefined, { ...base, hasUI: false }), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  const teardown = new AbortController();
  await assert.rejects(workflow.execute("id", { name: "gate", script, foreground: true }, teardown.signal, undefined, { ...base, hasUI: true, ui: { select: async () => { teardown.abort(); throw new Error("UI closed"); } } }), (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  const duplicateScript = `export const meta={name:'duplicate-gate',description:'duplicate'}; return Promise.all([checkpoint({name:'first',prompt:'?',context:null,...{name:args.name}}),checkpoint({name:'second',prompt:'?',context:null,...{name:args.name}})]);`;
  const duplicate = await workflow.execute("id", { name: "duplicate-gate", script: duplicateScript, args: { name: "same" } }, new AbortController().signal, undefined, base) as { details: { runId: string } };
  const duplicateStore = new RunStore(home, "session", duplicate.details.runId, home);
  for (let attempt = 0; attempt < 1000 && (await duplicateStore.awaitingCheckpoints()).length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual((await duplicateStore.awaitingCheckpoints()).map((checkpoint) => checkpoint.name).sort(), ["same", "same#2"]);
  assert.equal((await respond.execute("id", { runId: duplicate.details.runId, name: "same", approved: true }) as { details: { accepted: boolean } }).details.accepted, true);
  assert.equal((await respond.execute("id", { runId: duplicate.details.runId, name: "same#2", approved: false }) as { details: { accepted: boolean } }).details.accepted, true);
  const background = await workflow.execute("id", { name: "gate", script }, new AbortController().signal, undefined, base) as { details: { runId: string } };
  const { runId } = background.details;
  let first: { details: { accepted: boolean } } | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    first = await respond.execute("id", { runId, name: "ship", approved: false }) as { details: { accepted: boolean } };
    if (first.details.accepted) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(first?.details.accepted, true);
  const second = await respond.execute("id", { runId, name: "ship", approved: true }) as { details: { accepted: boolean } };
  assert.equal(second.details.accepted, false);
});

void test("two concurrent checkpoints keep the run awaiting until both are answered", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-concurrent-checkpoints-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const pi = { registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_respond"], sendMessage() {} };
  workflowExtension(pi as never, home);
  const workflow = tools.find(({ name }) => name === "workflow");
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(workflow && respond);
  const script = `export const meta={name:'gates',description:'gates'}; return Promise.all([checkpoint({name:'one',prompt:'One?',context:null}),checkpoint({name:'two',prompt:'Two?',context:null})]);`;
  const launched = await workflow.execute("id", { name: "gates", script }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }) as { details: { runId: string } };
  const store = new RunStore(home, "session", launched.details.runId, home);
  for (let attempt = 0; attempt < 1000 && (await store.awaitingCheckpoints()).length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "awaiting_input"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await store.awaitingCheckpoints()).length, 2);
  assert.equal((await respond.execute("id", { runId: launched.details.runId, name: "one", approved: true }) as { details: { accepted: boolean } }).details.accepted, true);
  assert.equal((await store.load()).run.state, "awaiting_input");
  assert.equal((await respond.execute("id", { runId: launched.details.runId, name: "two", approved: false }) as { details: { accepted: boolean } }).details.accepted, true);
  for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal((await store.load()).run.state, "completed");
});

void test("a checkpoint answer persisted before resolver registration cannot hang", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-checkpoint-race-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let completed!: () => void;
  const completion = new Promise<void>((resolve) => { completed = resolve; });
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {},
    getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_respond"],
    sendMessage(message: { content: string }) { if (message.content.startsWith("Workflow race-gate completed:")) completed(); },
  };
  workflowExtension(pi as never, home);
  const workflow = tools.find(({ name }) => name === "workflow");
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(workflow && respond);
  let releaseRunId!: (runId: string) => void;
  const runIdReady = new Promise<string>((resolve) => { releaseRunId = resolve; });
  const updateState = Object.getOwnPropertyDescriptor(RunStore.prototype, "updateState")?.value as RunStore["updateState"];
  let answered = false;
  RunStore.prototype.updateState = async function (update) {
    const run = await updateState.call(this, update);
    if (!answered && run.state === "awaiting_input" && this.cwd === home) {
      answered = true;
      const response = await respond.execute("id", { runId: await runIdReady, name: "ship", approved: false }) as { details: { accepted: boolean } };
      assert.equal(response.details.accepted, true);
    }
    return run;
  };
  const timeout = setTimeout(() => { completed(); }, 2000);
  try {
    const result = await workflow.execute("id", { name: "race-gate", script: `return checkpoint({name:'ship',prompt:'Ship?',context:null});` }, new AbortController().signal, undefined, { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }) as { details: { runId: string } };
    releaseRunId(result.details.runId);
    await completion;
    assert.equal(answered, true);
    assert.equal((await new RunStore(home, "session", result.details.runId, home).load()).run.state, "completed");
  } finally {
    clearTimeout(timeout);
    RunStore.prototype.updateState = updateState;
  }
});

void test("background delivery is minimal and capped while foreground stays inline", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-delivery-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details?: { runId: string } }> }> = [];
  const messages: Array<{ message: { content: string }; options: { deliverAs: string; triggerTurn: boolean } }> = [];
  let markDelivered!: () => void;
  const delivered = new Promise<void>((resolve) => { markDelivered = resolve; });
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {},
    getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"],
    sendMessage(message: { content: string }, options: { deliverAs: string; triggerTurn: boolean }) { messages.push({ message, options }); markDelivered(); }
  };
  workflowExtension(pi as never, home);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const ctx = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const background = await execute("id", { name: "large", script: `return "😀".repeat(5000);` }, new AbortController().signal, undefined, ctx);
  assert.match(background.content[0]?.text ?? "", /"state":"running"/);
  await delivered;
  assert.equal(messages.length, 1);
  assert.ok(Buffer.byteLength(messages[0]?.message.content ?? "") <= 4096);
  assert.doesNotMatch(messages[0]?.message.content ?? "", /�/);
  assert.match(messages[0]?.message.content ?? "", /^Workflow large completed:/);
  assert.match(messages[0]?.message.content ?? "", /Full result: .*result\.json/);
  assert.deepEqual(messages[0]?.options, { deliverAs: "followUp", triggerTurn: true });
  const foreground = await execute("id", { name: "inline", script: `return {ok:true};`, foreground: true }, new AbortController().signal, undefined, ctx);
  assert.equal(foreground.content[0]?.text, `{"ok":true}`);
  assert.equal(messages.length, 1);
});

void test("run lifecycle pauses cooperatively, resumes waiters, and keeps terminal states irreversible", async () => {
  const states: string[] = [];
  const lifecycle = new RunLifecycle("running", (state) => { states.push(state); });
  await lifecycle.enter();
  await lifecycle.pause();
  assert.equal(lifecycle.state, "pausing");
  let continued = false;
  const waiting = lifecycle.enter().then(() => { continued = true; });
  await lifecycle.leave();
  assert.equal(lifecycle.state, "paused");
  assert.equal(continued, false);
  await lifecycle.resume();
  await waiting;
  assert.equal(continued, true);
  await lifecycle.leave();
  await lifecycle.terminal("stopped");
  await assert.rejects(lifecycle.resume(), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  assert.deepEqual(states, ["pausing", "paused", "running", "stopped"]);
});

void test("run lifecycle waits for resume before awaiting input and wakes on resolution", async () => {
  const pausedStates: string[] = [];
  const paused = new RunLifecycle("running", (state) => { pausedStates.push(state); });
  await paused.pause();
  let awaiting = false;
  const transition = paused.enterAwaitingInput().then(() => { awaiting = true; });
  assert.equal(awaiting, false);
  await paused.resume();
  await transition;
  assert.equal(paused.state, "awaiting_input");
  assert.deepEqual(pausedStates, ["pausing", "paused", "running", "awaiting_input"]);

  const states: string[] = [];
  const lifecycle = new RunLifecycle("running", (state) => { states.push(state); });
  await lifecycle.enterAwaitingInput();
  await lifecycle.enterAwaitingInput();
  let entered = false;
  const waiting = lifecycle.enter().then(() => { entered = true; });
  await assert.rejects(lifecycle.pause(), /Cannot pause awaiting_input/);
  assert.equal(entered, false);
  await lifecycle.resolveAwaitingInput();
  await waiting;
  await lifecycle.leave();
  assert.deepEqual(states, ["awaiting_input", "running"]);
});

void test("loads markdown agent roles with frontmatter from global and project directories", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-roles-"));
  const cwd = join(home, "project");
  mkdirSync(join(home, "piworkflows", "roles"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "piworkflows", "roles"), { recursive: true });
  writeFileSync(join(home, "piworkflows", "roles", "global.md"), "---\ndescription: Global review\nmodel: openai/gpt\nthinking: high\ntools: [read, grep]\n---\nGlobal role");
  writeFileSync(join(home, "piworkflows", "roles", "shadowed.md"), "---\ndescription: Hidden global\n---\nGlobal shadowed role");
  writeFileSync(join(home, "piworkflows", "roles", "multiline.md"), "---\ntools:\n  - read\n  - grep\n---\nMultiline role");
  writeFileSync(join(cwd, ".pi", "piworkflows", "roles", "reviewer.md"), "Review role");
  writeFileSync(join(cwd, ".pi", "piworkflows", "roles", "shadowed.md"), "Project shadowed role");
  const roles = loadAgentDefinitions(cwd, home);
  assert.deepEqual(roles.global, { prompt: "Global role", description: "Global review", model: "openai/gpt", thinking: "high", tools: ["read", "grep"] });
  assert.equal(roles.reviewer?.prompt, "Review role");
  assert.deepEqual(roles.shadowed, { prompt: "Project shadowed role" });
  assert.deepEqual(roles.multiline, { prompt: "Multiline role", tools: ["read", "grep"] });
  const untrusted = loadAgentDefinitions(cwd, home, false);
  assert.equal(untrusted.reviewer, undefined);
  assert.deepEqual(untrusted.shadowed, { prompt: "Global shadowed role", description: "Hidden global" });
});

void test("strict role frontmatter rejects malformed metadata", () => {
  const invalid = [
    "---\ntools: read\n---\nbody",
    "---\ntools: [read, 2]\n---\nbody",
    "---\ntools: [read, '']\n---\nbody",
    "---\ndescription: |\n  line one\n  line two\n---\nbody",
  ];
  for (const content of invalid) assert.throws(() => parseRoleMarkdown(content, true), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});

void test("rejects invalid role policy before persisting a run", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-workflows-role-policy-"));
  const cwd = join(home, "project");
  mkdirSync(join(cwd, ".pi", "piworkflows", "roles"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "piworkflows", "roles", "broken.md"), "---\ntools: [missing]\n---\nBroken role");
  const tools: Array<{ name: string; execute: (id?: unknown, params?: unknown, signal?: unknown, update?: unknown, ctx?: unknown) => Promise<unknown> }> = [];
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["read", "workflow"] } as never, home);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  await assert.rejects(workflow.execute("id", { name: "invalid-role", script: `return agent("inspect", { name: "inspect", role: "broken" });` }, new AbortController().signal, undefined, { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
  assert.deepEqual(await listRunIds(cwd, "session", home), []);
  await assert.rejects(workflow.execute("id", { name: "invalid-schema", script: `return agent("inspect", { name: "inspect", outputSchema: [] });` }, new AbortController().signal, undefined, { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SCHEMA");
  assert.deepEqual(await listRunIds(cwd, "session", home), []);
});

void test("interrupted resume path preserves workflow agent roles", () => {
  const source = readFileSync(join(process.cwd(), "src", "index.ts"), "utf8");
  const resumeBlock = source.slice(source.indexOf("runWorkflow(loaded.snapshot.script"), source.indexOf("checkpoint: checkpointBridge", source.indexOf("runWorkflow(loaded.snapshot.script")));
  assert.match(resumeBlock, /const role = typeof options\.role/);
  assert.match(resumeBlock, /\.\.\.\(role \? \{ role \}/);
});

void test("interrupted lifecycle can cold-resume while completed and failed cannot", async () => {
  const interrupted = new RunLifecycle("interrupted");
  await interrupted.resume();
  assert.equal(interrupted.state, "running");
  for (const state of ["completed", "failed"] as const) await assert.rejects(new RunLifecycle(state).resume(), /Cannot resume/);
});

void test("strict settings use defaults and reject unknown or unsafe values", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflows-"));
  assert.equal(loadSettings(join(dir, "missing.json")), DEFAULT_SETTINGS);
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({ concurrency: 4, maxAgents: 20 }));
  assert.deepEqual(loadSettings(path), { concurrency: 4, maxAgents: 20 });
  writeFileSync(path, JSON.stringify({ agentTimeoutMs: 500 }));
  assert.throws(() => loadSettings(path), /Unknown workflow setting/);
  writeFileSync(path, JSON.stringify({ concurrency: 17 }));
  assert.throws(() => loadSettings(path), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SETTINGS");
  writeFileSync(path, JSON.stringify({ surprise: true }));
  assert.throws(() => loadSettings(path), /Unknown workflow setting/);
});

void test("preflight accepts the complete static contract", () => {
  const metadata = { name: "review", description: "Review code", extensions: [{ name: "git", version: "^1.0.0" }] };
  const result = preflight(valid, capabilities, [{ type: "object", properties: { value: { type: "string" } } }], metadata);
  assert.equal(result.metadata.name, "review");
  assert.equal(result.dynamicAgentRoles, false);
  assert.equal(preflight(`agent("x", { name: "x", role: args.role })`, capabilities).dynamicAgentRoles, true);
  assert.deepEqual(result.referenced, { phases: ["check"], models: ["openai/gpt"], tools: ["read"], agentTypes: ["reviewer"] });
  assert.deepEqual(preflight(valid.replace("openai/gpt", "openai/gpt:high"), capabilities, [], metadata).referenced.models, ["openai/gpt"]);
  assert.ok(Object.isFrozen(result.metadata));
  const staticSchema = { type: "object", properties: { answer: { type: "number" } } };
  assert.deepEqual(preflight(`agent("x",{name:"n",outputSchema:${JSON.stringify(staticSchema)}})`, capabilities).schemas, [staticSchema]);
  preflight(`agent("x",{name:"n",timeoutMs:0,timeoutMs:10})`, capabilities);
  preflight(`agent("x",{name:"n",timeoutMs:0,...{timeoutMs:10}})`, capabilities);
});

void test("preflight rejects every static boundary before run creation", () => {
  let created = 0;
  const createRun = (script: string) => { preflight(script, capabilities, [], { name: "test" }); created += 1; };
  const cases: Array<[string, string]> = [
    ["const x = ;", "INVALID_SYNTAX"],
    [`agent('a')`, "INVALID_METADATA"],
    [`agent('a',{name:'n',model:'missing'})`, "UNKNOWN_MODEL"],
    [`agent('a',{name:'n',model:'openai/gpt:turbo'})`, "UNKNOWN_MODEL"],
    [`agent('a',{name:'n',tools:['bash']})`, "UNKNOWN_TOOL"],
    [`agent('a',{name:'n',role:'writer'})`, "UNKNOWN_AGENT_TYPE"],
    [`agent('a',{name:'n',outputSchema:[]})`, "INVALID_SCHEMA"],
    [`agent('a',{name:'n',timeoutMs:0})`, "INVALID_METADATA"],
    [`agent('a',{name:'n',retries:-1})`, "INVALID_METADATA"],
    [`agent('a',{name:'n',isolation:'typo'})`, "INVALID_METADATA"],
  ];
  for (const [script, code] of cases) assert.throws(() => { createRun(script); }, (error: unknown) => error instanceof WorkflowError && error.code === code);
  assert.equal(created, 0);
  assert.equal(preflight("phase('dynamic')", capabilities, [], { name: "minimal" }).metadata.name, "minimal");
  assert.throws(() => preflight("return 1", capabilities, [], { name: "" }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => preflight("return 1", capabilities, [{}]), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SCHEMA");
});

void test("host rejects malformed dynamic agent options before launching", async () => {
  let launched = false;
  for (const options of ["{name:'a',tools:1}", "{name:'a',timeoutMs:0}", "{name:'a',retries:-1}", "{name:'a',isolation:'typo'}"]) {
    await assert.rejects(runWorkflow(`return agent('a',${options});`, null, { agent: async () => { launched = true; return null; } }).result, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  }
  assert.equal(launched, false);
});
void test("preflight enforces object-key combinators and contextual agent names", () => {
  const base = "return 1;";
  assert.throws(() => preflight(base, capabilities, [{ type: "object", properties: { bad: () => true } }]), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SCHEMA");
  assert.throws(() => preflight("return 1", { ...capabilities, extensions: { git: "1.0.0" } }, [], { name: "x", extensions: [{ name: "git", version: "^1.2.3" }] }), (error: unknown) => error instanceof WorkflowError && error.code === "INCOMPATIBLE_EXTENSION");
  assert.throws(() => preflight(`${base} parallel([{name:'task',run:()=>1}], {name:'batch'})`, capabilities), /operation name string and tasks record/);
  assert.throws(() => preflight(`${base} pipeline([{name:'item',value:1}], {name:'stage',run:value=>value}, {name:'pipe'})`, capabilities), /operation name string, items record, and stages record/);
  assert.throws(() => preflight(`${base} agent('top-level')`, capabilities), /agent requires a stable explicit name/);
  preflight(`${base} parallel('batch',{task:()=>agent('inherited')}); pipeline('pipe',{item:1},{stage:value=>agent(String(value))})`, capabilities);
} );

void test("AST preflight ignores DSL-looking non-executable text and member calls", () => {
  const script = `const text = "agent() checkpoint({}) phase('ghost') name: 'fake' model: 'missing' tools: ['bash'] role: 'writer'";
    const pattern = /agent() checkpoint({}) phase('ghost') model:'missing'/;
    const template = \`parallel() pipeline() agent() phase('ghost') model: 'missing'\`;
    // agent('comment') checkpoint({name:'comment'}) phase('ghost') model:'missing' tools:['bash'] role:'writer'
    object.agent('member'); object.checkpoint({}); object.phase('ghost'); object.parallel([]); object.pipeline([]);
    const unrelated = {model:'missing', tools:['bash'], role:'writer'};
    phase('real');
    agent("Explain agent() Promise behavior; name: 'fake'; model: 'missing'; tools: ['bash']; role: 'writer'", {name:'actual',model:'openai/gpt',tools:['read'],role:'reviewer'});`;
  assert.deepEqual(preflight(script, capabilities).referenced, { phases: ["real"], models: ["openai/gpt"], tools: ["read"], agentTypes: ["reviewer"] });
});

void test("AST preflight detects executable template expressions and false prompt names", () => {
  const base = "";
  assert.throws(() => preflight(`${base} agent("name: 'fake'")`, capabilities), /agent requires a stable explicit name/);
  assert.throws(() => preflight(`${base} checkpoint({prompt:"name: 'fake'",context:null})`, capabilities), /checkpoint requires a stable explicit name/);
  assert.throws(() => preflight(`${base} const text = \`\${agent("name: 'fake'")}\`;`, capabilities), /agent requires a stable explicit name/);
});

void test("AST preflight validates combinator signatures", () => {
  const base = "";
  assert.throws(() => preflight(`${base} parallel({task:()=>1}, 'batch')`, capabilities), /parallel requires/);
  assert.throws(() => preflight(`${base} pipeline('pipe', {item:1})`, capabilities), /pipeline requires/);
  preflight(`${base} agent('x', options); checkpoint(input); parallel(...batch); pipeline(...pipe);`, capabilities);
});

void test("launch snapshots are detached and deeply immutable", () => {
  const input = { script: valid, args: { nested: [1] }, metadata: { name: "x", description: "x" }, settings: { concurrency: 1, maxAgents: 1 }, models: ["openai/gpt"], tools: ["read"], agentTypes: ["reviewer"], roles: { reviewer: { prompt: "original" } }, projectRoles: ["reviewer"], extensions: { git: "1.2.3" }, schemas: [{ type: "object" }] };
  const snapshot = createLaunchSnapshot(input);
  input.args.nested.push(2);
  input.roles.reviewer.prompt = "mutated";
  assert.deepEqual(snapshot.args, { nested: [1] });
  assert.equal(snapshot.roles?.reviewer?.prompt, "original");
  assert.ok(Object.isFrozen(snapshot.args));
  assert.ok(Object.isFrozen(snapshot.schemas[0]));
});

void test("worker exposes deterministic core globals and JSON RPC only", async () => {
  const phases: string[] = [];
  const script = `export const meta={name:'x',description:'x'};
    if (typeof process !== 'undefined' || typeof require !== 'undefined' || typeof console !== 'undefined' || typeof Date !== 'undefined' || typeof setTimeout !== 'undefined' || typeof Math.random !== 'undefined') throw new Error('unsafe global');
    await phase('build'); const decision = await checkpoint({name:'gate'}); if (decision !== 'approved') throw new Error('rejected'); return agent('echo', {name:'echo'});`
  const run = runWorkflow(script, { n: 2 }, {
    phase(name) { phases.push(name); },
    checkpoint() { return true; },
    agent(prompt, options) { return Promise.resolve({ prompt, options }); },
  });
  assert.deepEqual(await run.result, { prompt: "echo", options: { name: "echo" } });
  assert.deepEqual(phases, ["build"]);
});

void test("prompt interpolates exact values with JSON formatting and escaped braces", async () => {
  const run = runWorkflow(`export const meta={name:'prompt',description:'prompt'};
    return prompt('raw={raw}; again={raw}; number={number}; bool={bool}; nil={nil}; array={array}; object={object}; escaped={{raw}} }}', {
      raw: 'verbatim', number: 3, bool: false, nil: null, array: [1, {ok:true}], object: {nested:['x']}
    });`);
  assert.equal(await run.result, `raw=verbatim; again=verbatim; number=3; bool=false; nil=null; array=[
  1,
  {
    "ok": true
  }
]; object={
  "nested": [
    "x"
  ]
}; escaped={raw} }`);
});

void test("prompt validates array expando values without changing JSON array rendering", async () => {
  const run = runWorkflow(`export const meta={name:'array-expandos',description:'array expandos'};
    const safe=[1,{ok:true}]; safe.note='ignored';
    const withFunction=[]; withFunction.extra=()=>1;
    const withCycle=[]; withCycle.extra=withCycle;
    const message=value=>{try{prompt('{value}',{value});return 'no error'}catch(error){return error.message}};
    return {rendered:prompt('{value}',{value:safe}),functionError:message(withFunction),cycleError:message(withCycle)};`);
  const result = await run.result as { rendered: string; functionError: string; cycleError: string };
  assert.equal(result.rendered, `[
  1,
  {
    "ok": true
  }
]`);
  assert.match(result.functionError, /value\.extra.*function/i);
  assert.match(result.cycleError, /value\.extra.*cycle/i);
});

void test("prompt rejects missing, unused, and recursively unsafe values with key-aware errors", async () => {
  const run = runWorkflow(`export const meta={name:'invalid-prompt',description:'invalid prompt'};
    const cycle={}; cycle.self=cycle;
    const accessor={}; Object.defineProperty(accessor,'nested',{enumerable:true,get(){return 1}});
    const customPrototype=Object.create({constructor:Object}); customPrototype.nested=1;
    const invalidConstructorPrototype=Object.create(Object.create(null,{constructor:{value:42}}));
    const cases=[
      ['missing',()=>prompt('{value}',{})],
      ['unused',()=>prompt('plain',{value:1})],
      ['template',()=>prompt(42,{})],
      ['values',()=>prompt('plain',[])],
      ['promise',()=>prompt('{value}',{value:Promise.resolve(1)})],
      ['nested promise',()=>prompt('{value}',{value:{nested:Promise.resolve(1)}})],
      ['thenable',()=>prompt('{value}',{value:{nested:{then(){}}}})],
      ['function',()=>prompt('{value}',{value:()=>1})],
      ['undefined',()=>prompt('{value}',{value:undefined})],
      ['symbol',()=>prompt('{value}',{value:Symbol('x')})],
      ['bigint',()=>prompt('{value}',{value:1n})],
      ['cycle',()=>prompt('{value}',{value:cycle})],
      ['infinite',()=>prompt('{value}',{value:Infinity})],
      ['instance',()=>prompt('{value}',{value:new (class Example {})()})],
      ['accessor',()=>prompt('{value}',{value:accessor})],
      ['custom prototype',()=>prompt('{value}',{value:customPrototype})],
      ['invalid prototype constructor',()=>prompt('{value}',{value:invalidConstructorPrototype})],
    ];
    return Object.fromEntries(cases.map(([name,run])=>{try{run();return [name,'no error']}catch(error){return [name,error.message]}}));`);
  const errors = await run.result as Record<string, string>;
  assert.match(errors.missing ?? "", /Missing prompt value "value"/);
  assert.match(errors.unused ?? "", /Unused prompt value "value"/);
  assert.match(errors.template ?? "", /template must be a string/);
  assert.match(errors.values ?? "", /values must be a plain object/);
  assert.match(errors.promise ?? "", /value.*Promise.*await/i);
  assert.match(errors["nested promise"] ?? "", /value\.nested.*Promise.*await/i);
  assert.match(errors.thenable ?? "", /value\.nested.*thenable.*await/i);
  assert.match(errors.function ?? "", /value.*function/i);
  assert.match(errors.undefined ?? "", /value.*undefined/i);
  assert.match(errors.symbol ?? "", /value.*symbol/i);
  assert.match(errors.bigint ?? "", /value.*bigint/i);
  assert.match(errors.cycle ?? "", /value\.self.*cycle/i);
  assert.match(errors.infinite ?? "", /value.*finite/i);
  assert.match(errors.instance ?? "", /value.*plain object/i);
  assert.match(errors.accessor ?? "", /value\.nested.*getters or setters/i);
  assert.match(errors["custom prototype"] ?? "", /value.*plain object/i);
  assert.match(errors["invalid prototype constructor"] ?? "", /value.*plain object/i);
});

void test("agent Promises reject serialization and string coercion but retain await and concurrency", async () => {
  const started: string[] = [];
  const run = runWorkflow(`export const meta={name:'agent-promises',description:'agent promises'};
    const first=agent('first',{name:'first'}); const second=agent('second',{name:'second'});
    let serialized; try{JSON.stringify(first)}catch(error){serialized=error.message}
    let interpolated; try{prompt('{report}',{report:first})}catch(error){interpolated=error.message}
    let stringified; try{first.toString()}catch(error){stringified=error.message}
    let coerced; try{'prefix '+first}catch(error){coerced=error.message}
    let agentInput; try{agent('prefix '+first,{name:'third'})}catch(error){agentInput=error.message}
    let logInput; try{log('prefix '+first)}catch(error){logInput=error.message}
    let promptTemplate; try{prompt('prefix '+first,{})}catch(error){promptTemplate=error.message}
    const values=await Promise.all([first,second]);
    return {serialized,interpolated,stringified,coerced,agentInput,logInput,promptTemplate,awaited:JSON.stringify(values)};`, null, {
    async agent(text) { started.push(text); return text; },
  });
  const result = await run.result as { serialized: string; interpolated: string; stringified: string; coerced: string; agentInput: string; logInput: string; promptTemplate: string; awaited: string };
  assert.match(result.serialized, /agent result.*Promise.*await.*serialization/i);
  assert.match(result.interpolated, /report.*Promise.*await.*prompt/i);
  for (const error of [result.stringified, result.coerced, result.agentInput, result.logInput, result.promptTemplate]) assert.match(error, /agent result.*Promise.*await.*interpolation/i);
  assert.deepEqual(started, ["first", "second"]);
  assert.deepEqual(JSON.parse(result.awaited), ["first", "second"]);
});

void test("agent, checkpoint, and extension calls expose bare values and typed failures", async () => {
  assert.equal(await runWorkflow(`return agent('direct',{name:'direct'});`, null, { agent: async () => "value" }).result, "value");
  for (const [code, message] of [["AGENT_FAILED", "failed"], ["AGENT_TIMEOUT", "timed out"], ["RESULT_INVALID", "invalid"]] as const) {
    await assert.rejects(runWorkflow(`return agent('direct',{name:'direct'});`, null, { agent: async () => { throw new WorkflowError(code, message); } }).result,
      (error: unknown) => error instanceof WorkflowError && error.code === code && error.message === message);
  }
  assert.deepEqual(await runWorkflow(`return extensions.demo.run({});`, null, {
    extensions: { demo: ["run"] },
    extension: async () => ({ answer: 42 }),
  }).result, { answer: 42 });
});

void test("parallel and pipeline return keyed bare values in input order", async () => {
  assert.deepEqual(await runWorkflow(`return parallel('batch',{first:()=>1,second:()=>0,third:()=>null});`).result, { first: 1, second: 0, third: null });
  assert.deepEqual(await runWorkflow(`return pipeline('pipe',{first:1,second:2},{double:value=>value*2,increment:value=>value+1});`).result, { first: 3, second: 5 });
  assert.deepEqual(await runWorkflow(`const reports=await parallel('reports',{lint:()=>agent('lint'),tests:()=>agent('tests')}); return {reports,rendered:prompt('{reports}',{reports})};`, null, { agent: async (prompt) => prompt === "lint" ? "clean" : { passed: true } }).result, {
    reports: { lint: "clean", tests: { passed: true } },
    rendered: `{
  "lint": "clean",
  "tests": {
    "passed": true
  }
}`,
  });
  assert.deepEqual(await runWorkflow(`return {parallel:await parallel('empty',{}),pipeline:await pipeline('empty',{}, {pass:value=>value})};`).result, { parallel: {}, pipeline: {} });
  let launched = false;
  await assert.rejects(runWorkflow(`return parallel('invalid',{first:()=>agent('no launch'),broken:1});`, null, { agent: async () => { launched = true; return null; } }).result, /task values must be run functions/);
  await assert.rejects(runWorkflow(`return pipeline('invalid',{first:1},{start:value=>agent(String(value)),broken:1});`, null, { agent: async () => { launched = true; return null; } }).result, /stage values must be run functions/);
  assert.equal(launched, false);
});

void test("combinator failures wait for siblings and preserve deterministic typed errors", async () => {
  let releaseParallel!: () => void;
  const parallelSibling = new Promise<JsonValue>((resolve) => { releaseParallel = () => { resolve("done"); }; });
  let settled = false;
  const parallelCalls: string[] = [];
  const parallelRun = runWorkflow(`return parallel('batch',{first:()=>agent('fail',{name:'fail'}),second:()=>agent('slow',{name:'slow'})});`, null, {
    agent: async (prompt) => { parallelCalls.push(prompt); if (prompt === "fail") throw new WorkflowError("AGENT_FAILED", "first failed"); return parallelSibling; },
  });
  void parallelRun.result.finally(() => { settled = true; }).catch(() => undefined);
  while (parallelCalls.length < 2) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseParallel();
  await assert.rejects(parallelRun.result, (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === "first failed");

  let releasePipeline!: () => void;
  const pipelineSibling = new Promise<JsonValue>((resolve) => { releasePipeline = () => { resolve(2); }; });
  settled = false;
  const pipelineCalls: string[] = [];
  const pipelineRun = runWorkflow(`return pipeline('pipe',{first:1,second:2},{run:value=>agent(String(value))});`, null, {
    agent: async (prompt) => { pipelineCalls.push(prompt); if (prompt === "1") throw new WorkflowError("RESULT_INVALID", "bad item"); return pipelineSibling; },
  });
  void pipelineRun.result.finally(() => { settled = true; }).catch(() => undefined);
  while (pipelineCalls.length < 2) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releasePipeline();
  await assert.rejects(pipelineRun.result, (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID" && error.message === "bad item");

  await assert.rejects(runWorkflow(`return parallel('ordered',{first:()=>{throw Object.assign(new Error('first'),{code:'AGENT_TIMEOUT'})},second:()=>{throw Object.assign(new Error('second'),{code:'AGENT_FAILED'})}});`).result,
    (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_TIMEOUT" && error.message === "first");
  await assert.rejects(runWorkflow(`return parallel('outer',{nested:()=>pipeline('inner',{item:1},{fail:()=>{throw Object.assign(new Error('nested'),{code:'AGENT_FAILED'})}})});`).result,
    (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === "nested");
});

void test("parallel name inheritance is isolated across async branches and top-level agents stay named", async () => {
  const releases = new Map<string, () => void>();
  const seen: Array<[string, unknown, unknown]> = [];
  const result = runWorkflow(`return parallel('concurrent',{first:async()=>{await agent('gate-first');return agent('after-first')},second:async()=>{await agent('gate-second');return agent('after-second')}});`, null, {
    agent: async (prompt, options, _signal, structuralName) => {
      seen.push([prompt, options.name, structuralName]);
      if (prompt.startsWith("gate-")) await new Promise<void>((resolve) => { releases.set(prompt, resolve); });
      return prompt;
    },
  });
  while (releases.size < 2) await new Promise((resolve) => setImmediate(resolve));
  releases.get("gate-second")?.(); releases.get("gate-first")?.();
  await result.result;
  assert.deepEqual(seen, [["gate-first", "first", "concurrent/first"], ["gate-second", "second", "concurrent/second"], ["after-second", "second", "concurrent/second"], ["after-first", "first", "concurrent/first"]]);
  const pipelineNames: Array<[unknown, unknown]> = [];
  await runWorkflow(`return pipeline('named',{first:1,second:2},{transform:value=>agent(String(value))});`, null, { agent: async (_prompt, options, _signal, structuralName) => { pipelineNames.push([options.name, structuralName]); return null; } }).result;
  assert.deepEqual(pipelineNames, [["transform", "named/first/transform"], ["transform", "named/second/transform"]]);
  await assert.rejects(runWorkflow(`return agent('unnamed');`, null, { agent: async () => null }).result, /stable explicit name/);
});

void test("worker cancellation is immediate even for runaway synchronous code", async () => {
  const run = runWorkflow(`export const meta={name:'x',description:'x'}; while(true){}`);
  const started = performance.now();
  run.cancel();
  await assert.rejects(run.result, (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  assert.ok(performance.now() - started < 1000);
});

void test("permission-sandboxed child cannot read files, reach network, or spawn processes", async () => {
  const fsRead = runWorkflow(`export const meta={name:'x',description:'x'}; return 'leaked';`);
  assert.deepEqual(await fsRead.result, "leaked");
  const hostile = runWorkflow(`export const meta={name:'hostile',description:'hostile'}; try { const fs = globalThis.constructor.constructor('return require("node:fs")')(); return fs.readFileSync('/etc/hostname','utf8'); } catch(e) { return 'blocked:'+e.code; }`);
  const result = await hostile.result as string;
  assert.match(result, /blocked:/);
});

void test("workflow cancellation reaches an active top-level scheduler agent", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const scheduler = new FairAgentScheduler(async ({ signal }) => {
    markStarted();
    await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
    throw new WorkflowError("CANCELLED", "cancelled");
  }, 1);
  scheduler.addRun("run", 1);
  const run = runWorkflow(`export const meta={name:'x',description:'x'}; return await agent('wait',{name:'wait'});`, null, {
    agent: async (_prompt, _options, signal) => {
      const spawned = scheduler.spawn("run", "wait", { label: "wait", cwd: "/repo", tools: [] });
      const cancel = () => { scheduler.cancel(spawned.id); };
      signal.addEventListener("abort", cancel, { once: true });
      const outcome = await spawned.result.finally(() => { signal.removeEventListener("abort", cancel); });
      if (!outcome.ok) throw new WorkflowError("CANCELLED", outcome.error.message);
      return outcome.value;
    },
  });
  await started;
  run.cancel();
  await assert.rejects(run.result, (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  await scheduler.flush();
  assert.deepEqual(scheduler.snapshot().map(({ state }) => state), ["cancelled"]);
});

void test("worker watchdog terminates a synchronous heartbeat stall after five seconds", { timeout: 7000 }, async () => {
  const run = runWorkflow(`export const meta={name:'x',description:'x'}; while(true){}`);
  const started = performance.now();
  await assert.rejects(run.result, (error: unknown) => error instanceof WorkflowError && error.code === "WORKER_UNRESPONSIVE");
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 4900 && elapsed < 6500, `watchdog fired after ${String(elapsed)}ms`);
});

void test("worker enforces 10 MB boundaries on individual and final JSON values", async () => {
  const oversized = "x".repeat(RPC_LIMIT_BYTES);
  assert.throws(() => runWorkflow(`export const meta={name:'x',description:'x'};`, oversized), (error: unknown) => error instanceof WorkflowError && error.code === "RPC_LIMIT_EXCEEDED");
  const run = runWorkflow(`export const meta={name:'x',description:'x'}; return 'x'.repeat(${String(RPC_LIMIT_BYTES)});`);
  await assert.rejects(run.result, (error: unknown) => error instanceof WorkflowError && error.code === "RPC_LIMIT_EXCEEDED");
  let called = false;
  const rendered = runWorkflow(`export const meta={name:'x',description:'x'}; return agent(prompt('{text}',{text:'x'.repeat(${String(RPC_LIMIT_BYTES)})}),{name:'large'});`, null, { agent: async () => { called = true; return null; } });
  await assert.rejects(rendered.result, (error: unknown) => error instanceof WorkflowError && error.code === "RPC_LIMIT_EXCEEDED");
  assert.equal(called, false);
});

void test("registers namespaced DSL extensions and replays each call as one validated macro", async () => {
  const registry = new WorkflowDslRegistry();
  let calls = 0;
  let receivedContext: unknown;
  registry.register({
    name: "git", version: "1.2.3", headline: "Git operations", description: "Orchestrate Git work",
    methods: {
      status: {
        description: "Read status",
        input: { type: "object", properties: { short: { type: "boolean" } }, required: ["short"], additionalProperties: false },
        output: { type: "object", properties: { clean: { type: "boolean" } }, required: ["clean"], additionalProperties: false },
        run: (input, context) => { calls += 1; receivedContext = context; return { clean: input.short === true }; },
      },
    },
  });
  const saved = new Map<string, JsonValue>();
  const journal = { get: (path: string) => saved.get(path), put: (path: string, value: JsonValue) => { saved.set(path, value); } };
  const context = { agent: async () => null, parallel: async () => null, pipeline: async () => null, checkpoint: async () => true, phase: () => {}, log: () => {}, privateScheduler: true };
  assert.deepEqual(registry.versions(), { git: "1.2.3" });
  assert.deepEqual(Object.keys(registry.namespaces().git ?? {}), ["status"]);
  assert.deepEqual(await registry.invoke("git", "status", { short: true }, context, "root/git.status", journal), { clean: true });
  assert.deepEqual(await registry.invoke("git", "status", { short: false }, context, "root/git.status", journal), { clean: true });
  assert.equal(calls, 1);
  assert.deepEqual(Object.keys(receivedContext as object), ["agent", "parallel", "pipeline", "checkpoint", "phase", "log"]);
});

void test("rejects extension collisions, invalid metadata, schemas, input, and output", async () => {
  const registry = new WorkflowDslRegistry();
  const extension = { name: "demo", version: "1.0.0", headline: "Demo", description: "Demo methods", methods: { run: { description: "Run", input: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, output: { type: "string" }, run: () => 1 } } };
  registry.register(extension);
  assert.throws(() => { registry.register(extension); }, (error: unknown) => error instanceof WorkflowError && error.code === "DUPLICATE_NAME");
  assert.throws(() => { new WorkflowDslRegistry().register({ ...extension, version: "v1" }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => { new WorkflowDslRegistry().register({ ...extension, methods: { run: { ...extension.methods.run, description: "", input: { type: "string" } } } }); }, WorkflowError);
  const journal = { get: () => undefined, put: () => {} };
  const context = { agent: async () => null, parallel: async () => null, pipeline: async () => null, checkpoint: async () => true, phase: () => {}, log: () => {} };
  await assert.rejects(registry.invoke("demo", "run", { value: 1 }, context, "bad-input", journal), (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID");
  await assert.rejects(registry.invoke("demo", "run", { value: "x" }, context, "bad-output", journal), (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID");
});
