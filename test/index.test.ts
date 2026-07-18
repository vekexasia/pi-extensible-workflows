import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import test from "node:test";
import workflowExtension, { budgetRelaxed, createLaunchSnapshot, DEFAULT_SETTINGS, ERROR_CODES, FairAgentScheduler, formatNavigatorDashboard, formatNavigatorRun, formatWorkflowFailure, formatWorkflowPreview, formatWorkflowProgress, inspectWorkflowScript, loadAgentDefinitions, loadSettings, mergeBudget, parseRoleMarkdown, preflight, registerWorkflowExtension, resolveModelReference, resumeBudgetAllowed, RPC_LIMIT_BYTES, RunLifecycle, RunStore, runWorkflow, saveModelAliases, validateBudget, validateBudgetPatch, validateCheckpoint, validateModelAliases, WorkflowAgentExecutor, WorkflowBudgetRuntime, WORKFLOW_ASYNC_COMPLETE_EVENT, WORKFLOW_ASYNC_STARTED_EVENT, WorkflowError, WorkflowRegistry, type JsonValue } from "../src/index.js";
import type { NativeSession, SessionInput } from "../src/agent-execution.js";
import { listRunIds } from "../src/persistence.js";

void test("validates aggregate budgets and patches", () => {
  const budget = validateBudget({ tokens: { soft: 5, hard: 10 }, costUsd: { soft: 1, hard: 2.5 }, durationMs: { hard: 100 }, agentLaunches: { soft: 0, hard: 1 } });
  assert.deepEqual(budget, { tokens: { soft: 5, hard: 10 }, costUsd: { soft: 1, hard: 2.5 }, durationMs: { hard: 100 }, agentLaunches: { soft: 0, hard: 1 } });
  assert.throws(() => validateBudget({ tokens: { soft: -1 } }), /non-negative/);
  assert.throws(() => validateBudget({ tokens: { soft: 2, hard: 2 } }), /less than hard/);
  assert.deepEqual(validateBudgetPatch({ tokens: null, costUsd: { hard: 3 } }), { tokens: null, costUsd: { hard: 3 } });
  assert.deepEqual(mergeBudget(budget, { tokens: null }), { costUsd: { soft: 1, hard: 2.5 }, durationMs: { hard: 100 }, agentLaunches: { soft: 0, hard: 1 } });
  assert.equal(budgetRelaxed(budget, mergeBudget(budget, { costUsd: { hard: 4 } })), true);
  assert.equal(resumeBudgetAllowed({ tokens: { hard: 5 } }, { tokens: 5, costUsd: 0, durationMs: 0, agentLaunches: 0 }), false);
});
void test("budget runtime excludes cache tokens, records soft crossings, and tracks active duration", () => {
  let now = 0;
  const runtime = new WorkflowBudgetRuntime({ tokens: { soft: 5, hard: 10 }, costUsd: { hard: 1 }, durationMs: { hard: 20 }, agentLaunches: { hard: 1 } }, 1, undefined, [], { now: () => now });
  const agent = runtime.forAgent("agent");
  agent.beforeAttempt();
  agent.afterTurn({ input: 2, output: 3, cacheRead: 100, cacheWrite: 100, cost: 0.5 }, true);
  assert.deepEqual(runtime.usage, { tokens: 5, costUsd: 0.5, durationMs: 0, agentLaunches: 1 });
  assert.equal(runtime.events[0]?.type, "soft_crossed");
  assert.match(agent.instruction() ?? "", /Finish the requested output/);
  now = 21;
  assert.throws(() => { agent.beforeTurn(); }, (error: unknown) => error instanceof WorkflowError && error.code === "BUDGET_EXHAUSTED");
});
type OwnershipNodes = Parameters<RunStore["saveOwnership"]>[0];
const delayedOwnership = new Map<string, { start: () => void; cleanup: Promise<void> }>();
const failedOwnership = new Set<string>();
const nativeSaveOwnership = Reflect.get(RunStore.prototype, "saveOwnership");
RunStore.prototype.saveOwnership = async function (nodes: OwnershipNodes) {
  const delayed = delayedOwnership.get(this.directory);
  if (delayed) { delayed.start(); await delayed.cleanup; }
  if (failedOwnership.has(this.directory)) throw new Error("scheduler cleanup failed");
  await nativeSaveOwnership.call(this, nodes);
};
const capabilities = {
  models: new Set(["openai/gpt"]), tools: new Set(["read"]), agentTypes: new Set(["reviewer"]),
};
const reuseExtension = { namespace: "reuseTest", version: "1.0.0", headline: "Reusable", description: "Reusable test workflows", functions: { inspect: { description: "Inspect", input: { type: "object", additionalProperties: false }, output: { type: "string" }, run: () => "ok" } }, variables: { branch: { description: "Branch", schema: { type: "string" }, resolve: () => "main" } }, workflows: { hello: { description: "Say hello", script: `return args.name;` } } };
const valid = `phase("check"); agent("review", { role: "reviewer" }); agent("custom", { model: "openai/gpt", tools: ["read"] });`;

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
  assert.deepEqual(tools.map(({ name }) => name), ["workflow_respond", "workflow_resume", "workflow"]);
  assert.deepEqual(commands.map(({ name }) => name), ["workflow"]);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool);
  assert.equal(tool.promptGuidelines, undefined);
  assert.ok(discover);
  assert.ok(discover()?.skillPaths?.some((path) => existsSync(path)));
  const skillPath = discover()?.skillPaths?.find((path) => existsSync(path));
  assert.ok(skillPath);
  assert.match(readFileSync(join(skillPath, "pi-extensible-workflows", "SKILL.md"), "utf8"), /If `workflow_catalog` is available, call it once before creating the first workflow for a task/);
  await assert.rejects(tool.execute("id", { script: "return true" }, new AbortController().signal, undefined, { model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  await assert.rejects(tool.execute("id", { script: "return true", workflow: "missing" }, new AbortController().signal, undefined, { model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  await assert.rejects(tool.execute("id", { script: "" }, undefined, undefined, { model: undefined }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL");
});
void test("registers workflow_catalog only for active non-empty registries", async () => {
  const empty = new WorkflowRegistry();
  assert.deepEqual(empty.catalog(), { functions: [], variables: [], workflows: [] });
  const inactiveHome = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-catalog-inactive-"));
  const inactiveTools: Array<{ name: string }> = [];
  let inactiveStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let inactiveShutdown: (() => Promise<void>) | undefined;
  workflowExtension({ registerTool(tool: { name: string }) { inactiveTools.push(tool); }, registerCommand() {}, getActiveTools: () => ["read"], on(name: string, handler: unknown) { if (name === "session_start") inactiveStart = handler as typeof inactiveStart; if (name === "session_shutdown") inactiveShutdown = handler as typeof inactiveShutdown; } } as never, inactiveHome);
  assert.ok(inactiveStart && inactiveShutdown);
  await inactiveStart({}, { cwd: inactiveHome, sessionManager: { getSessionId: () => "inactive" } });
  assert.equal(inactiveTools.some(({ name }) => name === "workflow_catalog"), false);
  await inactiveShutdown();
  const activeHome = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-catalog-active-"));
  const activeTools: Array<{ name: string; execute?: (...args: never[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  let activeStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let activeShutdown: (() => Promise<void>) | undefined;
  workflowExtension({ registerTool(tool: (typeof activeTools)[number]) { activeTools.push(tool); }, registerCommand() {}, getActiveTools: () => ["workflow"], on(name: string, handler: unknown) { if (name === "session_start") activeStart = handler as typeof activeStart; if (name === "session_shutdown") activeShutdown = handler as typeof activeShutdown; } } as never, activeHome);
  registerWorkflowExtension(reuseExtension);
  assert.ok(activeStart && activeShutdown);
  assert.equal(activeTools.filter(({ name }) => name === "workflow_catalog").length, 0);
  const activeContext = { cwd: activeHome, sessionManager: { getSessionId: () => "active" } };
  await activeStart({}, activeContext);
  await activeStart({}, activeContext);
  assert.equal(activeTools.filter(({ name }) => name === "workflow_catalog").length, 1);
  assert.throws(() => { registerWorkflowExtension({ namespace: "lateCatalog", version: "1.0.0", headline: "Late", description: "Late", workflows: { x: { description: "x", script: "return 1;" } } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "REGISTRY_FROZEN");
  const catalogTool = activeTools.find(({ name }) => name === "workflow_catalog");
  assert.ok(catalogTool?.execute);
  const catalog = JSON.parse((await catalogTool.execute()).content[0]?.text ?? "null") as { functions: Array<Record<string, unknown>>; variables: Array<Record<string, unknown>>; workflows: Array<Record<string, unknown>> };
  assert.deepEqual(catalog.functions.map(({ name, namespace }) => ({ name, namespace })), [{ name: "inspect", namespace: "reuseTest" }]);
  assert.deepEqual(catalog.variables.map(({ name, namespace }) => ({ name, namespace })), [{ name: "branch", namespace: "reuseTest" }]);
  assert.deepEqual(catalog.workflows.map(({ name, namespace }) => ({ name, namespace })), [{ name: "reuseTest.hello", namespace: "reuseTest" }]);
  assert.deepEqual(Object.keys(catalog.functions[0] ?? {}).sort(), ["description", "extensionDescription", "headline", "input", "name", "namespace", "output", "version"]);
  assert.deepEqual(Object.keys(catalog.variables[0] ?? {}).sort(), ["description", "extensionDescription", "headline", "name", "namespace", "schema", "version"]);
  assert.doesNotMatch(JSON.stringify(catalog), /"script"|"run"|"resolve"|"source"|"main"|"ok"/);
  await activeShutdown();
});

void test("advertises only described effective roles in the system prompt while workflow is active", () => {
  type StartHandler = (event: { systemPrompt: string }, ctx: { cwd: string; isProjectTrusted?: () => boolean }) => { systemPrompt?: string } | undefined;
  let handler: StartHandler | undefined;
  const activeTools = ["workflow"];
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-role-guidance-"));
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "project-reviewer.md"), "---\ndescription: Reviews correctness\nmodel: private/model\ntools: [private-tool]\n---\nPRIVATE ROLE BODY");
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "hidden.md"), "UNDESCRIBED ROLE BODY");
  workflowExtension({ registerTool() {}, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => activeTools, on(name: string, candidate: StartHandler) { if (name === "before_agent_start") handler = candidate; } } as never);
  assert.ok(handler);
  const result = handler({ systemPrompt: "BASE SYSTEM" }, { cwd });
  const guidance = result?.systemPrompt ?? "";
  assert.match(guidance, /^BASE SYSTEM\n\nWorkflow role descriptions:/);
  assert.match(guidance, /`project-reviewer`: Reviews correctness/);
  assert.doesNotMatch(guidance, /PRIVATE ROLE BODY|UNDESCRIBED ROLE BODY|private\/model|private-tool|reuseTest|workflow_catalog/);
  const untrustedGuidance = handler({ systemPrompt: "BASE SYSTEM" }, { cwd, isProjectTrusted: () => false })?.systemPrompt ?? "";
  assert.doesNotMatch(untrustedGuidance, /project-reviewer|Reviews correctness/);
});

void test("background workflows emit compatible lifecycle events", async () => {
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  const events: Array<{ channel: string; data: Record<string, unknown> }> = [];
  let completed!: () => void;
  const done = new Promise<void>((resolve) => { completed = resolve; });
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-events-"));
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, sendMessage() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], events: { emit(channel: string, data: unknown) { events.push({ channel, data: data as Record<string, unknown> }); if (channel === WORKFLOW_ASYNC_COMPLETE_EVENT) completed(); } } } as never, home);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const result = await execute("id", { name: "events", script: `return true;` }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  await done;
  const runId = (JSON.parse(result.content[0]?.text ?? "{}") as { runId?: string }).runId;
  assert.ok(runId);
  const stored = new RunStore(home, "session", runId, home);
  assert.equal(JSON.parse(readFileSync(join(stored.directory, "result.json"), "utf8")), true);
  assert.deepEqual(events.map(({ channel }) => channel), [WORKFLOW_ASYNC_STARTED_EVENT, WORKFLOW_ASYNC_COMPLETE_EVENT]);
});

void test("/workflow doctor formats the shared doctor report with active session tools", async () => {
  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  workflowExtension({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, getThinkingLevel: () => "medium", getActiveTools: () => ["read", "workflow"], on() {} } as never);
  let output = "";
  await commands[0]?.handler("doctor", { cwd: mkdtempSync(join(tmpdir(), "pi-extensible-workflows-slash-doctor-")), ui: { notify(text: string) { output = text; } } } as never);
  assert.match(output, /^# pi-extensible-workflows doctor/m);
  assert.match(output, /## Active tools\n- `read`/);
  assert.doesNotMatch(output, /- `workflow`/);
});

void test("registered extension workflows can run by name", async () => {
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {} } as never);
  registerWorkflowExtension(reuseExtension);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const result = await execute("id", { workflow: "reuseTest.hello", args: { name: "Andrea" }, foreground: true }, new AbortController().signal, undefined, { cwd: mkdtempSync(join(tmpdir(), "pi-extensible-workflows-reuse-")), model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  assert.equal(result.content[0]?.text, '"Andrea"');
});
void test("inline workflow args cross the production tool boundary and omitted args become null", async () => {
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-inline-home-"));
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {} } as never, home);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const context = { cwd: mkdtempSync(join(tmpdir(), "pi-extensible-workflows-inline-")), model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const withArgs = await execute("id", { name: "with-args", script: "return args.answer;", args: { answer: 42 }, foreground: true }, new AbortController().signal, undefined, context);
  assert.equal(withArgs.content[0]?.text, "42");
  const omitted = await execute("id", { name: "without-args", script: "return args;", foreground: true }, new AbortController().signal, undefined, context);
  assert.equal(omitted.content[0]?.text, "null");
});
void test("navigator renders effective agent policy separately from launch metadata", () => {
  const run = { id: "run", workflowName: "policy", cwd: "/repo", sessionId: "session", state: "running", agents: [{ id: "run:1", name: "review", path: "run:1", state: "running", role: "reviewer", model: { provider: "anthropic", model: "opus", thinking: "high" }, tools: ["read", "grep"], attempts: 1 }], nativeSessions: [] } as Parameters<typeof formatWorkflowProgress>[0];
  const dashboard = formatNavigatorDashboard(run, [], []);
  assert.match(dashboard, /model=anthropic\/opus:high/);
  assert.match(dashboard, /tools=read,grep/);
  assert.match(dashboard, /role=reviewer/);
  assert.doesNotMatch(dashboard, /Launch models/);
});
void test("navigator uses persisted labels and model fallbacks across views", () => {
  const run = { id: "run", workflowName: "labels", cwd: "/repo", sessionId: "session", state: "running", agents: [
    { id: "run:1", name: "stale-name", label: "explicit label", path: "run:1", state: "running", model: { provider: "provider", model: "worker" }, tools: [], attempts: 1 },
    { id: "run:2", name: "worker", path: "run:2", state: "completed", parentId: "run:1", model: { provider: "provider", model: "worker" }, tools: [], attempts: 1 },
  ], nativeSessions: [] } as Parameters<typeof formatWorkflowProgress>[0];
  const dashboard = formatNavigatorDashboard(run, [], []);
  const progress = formatWorkflowProgress(run);
  const detail = formatNavigatorRun({ run, snapshot: createLaunchSnapshot({ script: "return 1;", args: null, metadata: { name: "labels" }, settings: DEFAULT_SETTINGS, models: ["provider/worker"], tools: [], agentTypes: [], schemas: [] }) }, [], []);
  assert.match(dashboard, /explicit label > worker/);
  assert.match(progress, /explicit label/);
  assert.match(detail, /explicit label .*model=provider\/worker/);
  assert.match(detail, /worker .*model=provider\/worker/);
  assert.doesNotMatch(`${dashboard}\n${detail}`, /role=custom/);
});

void test("streams foreground workflow progress into its tool card", async () => {
  type Update = { content: Array<{ type: string; text: string }>; details: { run: { state: string; phase?: string } } };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-progress-"));
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
  const reasoning = { ...run, agents: [{ ...agent, activity: { kind: "reasoning" as const, text: "checking cache" } }] } as Parameters<typeof formatWorkflowProgress>[0];
  assert.match(formatWorkflowProgress(reasoning), /reasoning/);
  assert.doesNotMatch(formatWorkflowProgress(reasoning), /checking cache/);
  const text = { ...run, agents: [{ ...agent, activity: { kind: "text" as const, text: "streaming answer" } }] } as Parameters<typeof formatWorkflowProgress>[0];
  assert.match(formatWorkflowProgress(text), /responding/);
  assert.doesNotMatch(formatWorkflowProgress(text), /streaming answer/);
  const settled = { ...run, agents: [{ ...agent, state: "completed" as const, activity: { kind: "text" as const, text: "stale output" } }] } as Parameters<typeof formatWorkflowProgress>[0];
  assert.doesNotMatch(formatWorkflowProgress(settled), /stale output|◇ read/);
});
void test("workflow cards group structural scopes with stable creation order", () => {
  const run = { id: "run", workflowName: "grouped", cwd: "/repo", sessionId: "session", state: "running", agents: [
    { id: "run:1", name: "developer", path: "run:1", state: "completed", structuralPath: ["issues", "issue-65"], parentBreadcrumb: "reviewLoop.developUntilApproved", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
    { id: "run:2", name: "developer", path: "run:2", state: "running", structuralPath: ["issues", "issue-66"], parentBreadcrumb: "reviewLoop.developUntilApproved", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
    { id: "run:3", name: "reviewer", path: "run:3", state: "running", structuralPath: ["issues", "issue-65"], parentBreadcrumb: "reviewLoop.developUntilApproved", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
    { id: "run:4", name: "child", path: "run:4", state: "running", parentId: "run:3", structuralPath: ["issues", "issue-65"], parentBreadcrumb: "reviewLoop.developUntilApproved", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 },
  ], nativeSessions: [] } as Parameters<typeof formatWorkflowProgress>[0];
  const progress = formatWorkflowProgress(run);
  const dashboard = formatNavigatorDashboard(run, [], [{ owner: "worktree/named/issue-65", branch: "hidden", path: "/hidden", cwd: "/hidden", base: "base" }]);
  assert.match(progress, /issues > issue-65 > reviewLoop\.developUntilApproved/);
  assert.match(dashboard, /issues > issue-65 > reviewLoop\.developUntilApproved/);
  assert.doesNotMatch(dashboard, /worktree\/named|hidden|\/hidden/);
  assert.ok(progress.indexOf("#1") < progress.indexOf("#3"));
  assert.ok(progress.indexOf("#3") < progress.indexOf("#4"));
  assert.ok(progress.indexOf("#3") < progress.indexOf("#2"));
  assert.match(progress, /#4 ◇ child/);
});

void test("session-scoped navigator shows metadata and confirms terminal deletion", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-navigator-"));
  const cwd = join(home, "project");
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'nav',description:'nav'}", args: null, metadata: { name: "nav", description: "nav" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: ["read"], agentTypes: [], schemas: [] });
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create({ id: "run-a", workflowName: "nav", cwd, sessionId: "session-a", state: "completed", phase: "review", agents: [{ id: "run-a:1", name: "reviewer", path: "run-a:1", state: "failed", role: "reviewer", model: { provider: "openai", model: "gpt", thinking: "medium" }, tools: ["read"], attempts: 2, attemptDetails: [{ attempt: 2, sessionId: "native-a", sessionFile: "/pi/native-a.jsonl", error: { code: "AGENT_FAILED", message: "boom" }, accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }], accounting: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 } }], nativeSessions: [{ sessionId: "native-a", sessionFile: "/pi/native-a.jsonl" }] }, snapshot);
  const same = new RunStore(cwd, "session-a", "run-c", home);
  await same.create({ id: "run-c", workflowName: "nav", cwd, sessionId: "session-a", state: "awaiting_input", agents: [], nativeSessions: [] }, snapshot);
  await same.awaitCheckpoint({ path: "checkpoint/ship", name: "ship", prompt: "Ship?", context: null });
  const other = new RunStore(cwd, "session-b", "run-b", home);
  await other.create({ id: "run-b", workflowName: "other", cwd, sessionId: "session-b", state: "completed", agents: [], nativeSessions: [] }, snapshot);
  const rendered = formatNavigatorRun(await store.load(), [], [{ owner: "worktree/named/reviewer", branch: "pi-extensible-workflows/run-a/tree", path: "/worktree", cwd: "/worktree/project", base: "abc" }]);
  assert.match(rendered, /Phase: review/);
  assert.match(rendered, /reviewer state=failed model=openai\/gpt:medium role=reviewer tools=read attempts=2 retries=1/);
  assert.match(rendered, /error=AGENT_FAILED: boom/);
  assert.match(rendered, /Worktrees: 1/);
  assert.match(rendered, /Native Pi transcripts: 1/);
  assert.doesNotMatch(rendered, /worktree\/named|branch=|native-a: \/pi\/native-a|\/worktree/);

  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  const prompts: string[] = [];
  const selections: string[][] = [];
  let deleteConfirmed = false;
  const copied: string[] = [];
  const pi = { registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["read", "workflow"] };
  workflowExtension(pi as never, home, async (value) => { copied.push(value); });
  let selectCall = 0;
  const ctx = { cwd, mode: "rpc", hasUI: true, sessionManager: { getSessionId: () => "session-a" }, ui: { notify() {}, select: async (prompt: string, options: string[]) => { prompts.push(prompt); selections.push(options); selectCall += 1; if (selectCall === 1) return options.find((option) => option.includes("completed")); if (selectCall === 2) return "Agents..."; if (selectCall === 3) return options.find((option) => option.includes("#1")); if (selectCall === 4) return "Back"; return "Close"; }, confirm: async () => deleteConfirmed } };
  const command = commands[0]?.handler;
  assert.ok(command);
  await command("", ctx as never);
  assert.ok(selections.length >= 2);
  const runList = selections[0]?.join("\n") ?? "";
  assert.match(runList, /nav/);
  assert.match(runList, /Close/);
  const dashActions = selections[1]?.join("\n") ?? "";
  assert.match(dashActions, /Delete|Stop|Approve|Reject/);
  assert.match(dashActions, /Agents\.\.\./);
  assert.doesNotMatch(dashActions, /Transcript paths|View transcript|Copy run path|Copy run ID|Copy branch|Copy worktree path/);
  assert.doesNotMatch(`${prompts.join("\n")}\n${selections.flat().join("\n")}`, /other|\/pi\/native-a/);
  assert.deepEqual(copied, []);
  assert.doesNotMatch(`${prompts.join("\n")}\n${selections.flat().join("\n")}`, /other/);
  await command("delete run-a", ctx as never);
  assert.equal(existsSync(store.directory), true);
  deleteConfirmed = true;
  await command("delete run-a", ctx as never);
  assert.equal(existsSync(store.directory), false);
});
void test("TUI navigator exposes agent-scoped transcript and worktree actions", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-agent-actions-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "tracked\n");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  const runId = `run-${"x".repeat(40)}`;
  const transcriptA = join(home, "transcript-a.jsonl");
  const transcriptB = join(home, "transcript-b.jsonl");
  const store = new RunStore(repo, "session", runId, home);
  const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "copy" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: runId, workflowName: "copy", cwd: repo, sessionId: "session", state: "completed", agents: [{ id: "agent", name: "agent", path: "agent", state: "completed", structuralPath: ["issues", "issue-65"], parentBreadcrumb: "reviewLoop.developUntilApproved", worktreeOwner: "copy-owner", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 2, attemptDetails: [{ attempt: 1, sessionId: "native-a", sessionFile: transcriptA, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }, { attempt: 2, sessionId: "native-b", sessionFile: transcriptB, accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }], nativeSessions: [] }, snapshot);
  const worktree = await store.worktree("copy-owner");
  const copied: string[] = [];
  const notifications: Array<{ message: string; type: string | undefined }> = [];
  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  const pi = { registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] };
  workflowExtension(pi as never, home, async (value) => { copied.push(value); });
  let customCalls = 0;
  let detailActions = 0;
  const ctx = {
    cwd: repo, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify(message: string, type?: string) { notifications.push({ message, type }); },
      confirm: async () => false,
      select: async (prompt: string, options: string[]) => {
        if (prompt === "Workflows\n") return options.find((option) => option.includes("copy")) ?? "Close";
        if (prompt === "Agents") return options.find((option) => option.includes("#1")) ?? "Back";
        if (prompt === "Transcript attempts") return "Attempt 2";
        if (prompt.includes("issue-65")) { const action = ["Copy branch", "Copy worktree path", "Copy transcript path", "Copy agent ID", "Back"][detailActions] ?? "Back"; detailActions += 1; return options.includes(action) ? action : "Back"; }
        return "Back";
      },
      custom: async (factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; dispose?(): void }) => {
        customCalls += 1;
        const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, { matches: () => false }, () => {});
        const rendered = component.render(80).join("\n");
        assert.match(rendered, /Agents\.\.\./);
        assert.doesNotMatch(rendered, /copy-owner|Copy branch|Copy worktree path/);
        component.dispose?.();
        return ["Copy run path", "Copy run ID", "Agents...", "Close"][customCalls - 1] ?? "Close";
      },
    },
  };
  const command = commands[0]?.handler;
  assert.ok(command);
  await command("", ctx as never);
  assert.deepEqual(copied, [store.directory, runId, worktree.branch, worktree.path, transcriptB, "agent"]);
  assert.ok(notifications.some(({ message }) => message === "Copied branch."));
  assert.ok(notifications.some(({ message }) => message === "Copied worktree path."));
  assert.ok(notifications.some(({ message }) => message === "Copied transcript path."));
  assert.ok(notifications.some(({ message }) => message === "Copied agent ID."));
  assert.equal(customCalls, 4);
  await store.delete(true);
});

void test("navigator stop asks for confirmation before cancelling", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-stop-confirm-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'live',description:'live'}", args: null, metadata: { name: "live", description: "live" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "live", cwd, sessionId: "session", state: "running", agents: [], nativeSessions: [] }, snapshot);
  await store.saveOwnership([{ id: "run:1", label: "worker", state: "running", options: { label: "worker", cwd, tools: [] } }]);
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  const confirmations: string[] = [];
  let customCalls = 0;
  let disposed = false;
  let closeNavigator = () => {};
  workflowExtension({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on(name: string, handler: typeof start) { if (name === "session_start") start = handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  assert.ok(start && commands[0]);
  const ctx = {
    cwd, mode: "tui", hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify() {}, setStatus() {}, confirm: async (_title: string, message: string) => { confirmations.push(message); return false; },
      select: async (_prompt: string, options: string[]) => options[0] ?? "Close",
      custom: async (factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }, options?: { overlay?: boolean }) => {
        customCalls += 1;
        assert.equal(options?.overlay, true);
        let result: string | undefined;
        let resolveCustom!: (value: string | undefined) => void;
        const completed = new Promise<string | undefined>((resolve) => { resolveCustom = resolve; });
        const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { disposed = true; result = value; resolveCustom(value); });
        closeNavigator = () => component.handleInput?.("tui.select.cancel");
        assert.match(component.render(200).join("\n"), /Stop/);
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.confirm");
        await completed;
        component.dispose?.();
        return result;
      },
    },
  };
  const command = commands[0];
  assert.ok(command);
  await start({}, ctx);
  const pending = command.handler("", ctx as never);
  for (let attempt = 0; attempt < 100 && confirmations.length === 0; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(confirmations.length, 1);
  assert.match(confirmations[0] ?? "", /live|run/);
  assert.equal(disposed, false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  closeNavigator();
  await pending;
  assert.equal(customCalls, 1);
  assert.equal((await store.load()).run.state, "interrupted");
  assert.deepEqual((await store.loadOwnership()).map(({ state }) => state), ["running"]);
});

void test("navigator stop stays visible through cleanup and ignores repeated input", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-stop-progress-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'live',description:'live'}", args: null, metadata: { name: "live", description: "live" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "live", cwd, sessionId: "session", state: "running", agents: [], nativeSessions: [] }, snapshot);
  await store.saveOwnership([{ id: "run:1", label: "worker", state: "running", options: { label: "worker", cwd, tools: [] } }]);
  let releaseCleanup = () => {};
  let cleanupStarted = false;
  const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
  delayedOwnership.set(store.directory, { start: () => { cleanupStarted = true; }, cleanup });
  const isCleanupStarted = () => cleanupStarted;
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  const confirmations: string[] = [];
  const statuses: Array<string | undefined> = [];
  const notices: string[] = [];
  let componentDisposed = false;
  let rendered = "";
  let closeNavigator = () => {};
  workflowExtension({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on(name: string, handler: typeof start) { if (name === "session_start") start = handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  assert.ok(start && commands[0]);
  const ctx = {
    cwd, mode: "tui", hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify(message: string) { notices.push(message); }, setStatus(_key: string, text: string | undefined) { statuses.push(text); }, confirm: async (_title: string, message: string) => { confirmations.push(message); return true; },
      select: async (_prompt: string, options: string[]) => options[0] ?? "Close",
      custom: async (factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }, options?: { overlay?: boolean }) => {
        assert.equal(options?.overlay, true);
        let result: string | undefined;
        let resolveCustom!: (value: string | undefined) => void;
        const completed = new Promise<string | undefined>((resolve) => { resolveCustom = resolve; });
        const component = factory({ requestRender() { rendered = component.render(200).join("\n"); } }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { componentDisposed = true; result = value; resolveCustom(value); });
        closeNavigator = () => component.handleInput?.("tui.select.cancel");
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.confirm");
        component.handleInput?.("tui.select.confirm");
        await completed;
        component.dispose?.();
        return result;
      },
    },
  };
  const command = commands[0];
  assert.ok(command);
  await start({}, ctx);
  const pending = command.handler("", ctx as never);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (isCleanupStarted()) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(isCleanupStarted(), true);
  assert.equal(componentDisposed, false);
  assert.match(rendered, /Stopping workflow live/);
  assert.equal(confirmations.length, 1);
  assert.equal((await store.load()).run.state, "stopped");
  releaseCleanup();
  for (let attempt = 0; attempt < 100 && !rendered.includes("Workflow run stopped."); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.match(rendered, /Workflow run stopped\.|state=stopped/);
  assert.equal(componentDisposed, false);
  await new Promise((resolve) => setTimeout(resolve, 10));
  closeNavigator();
  await pending;
  delayedOwnership.delete(store.directory);
  assert.equal(componentDisposed, true);
  assert.deepEqual((await store.loadOwnership()).map(({ state }) => state), ["cancelled"]);
  assert.ok(statuses.some((status) => status?.includes("Stopping workflow")));
  assert.ok(statuses.some((status) => status?.includes("Workflow run stopped")));
  assert.equal(statuses.at(-1), undefined);
  assert.ok(notices.some((notice) => notice.includes("Stopped workflow run.")));
});
void test("non-TUI navigator Stop confirms before cancelling", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-stop-select-confirm-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "select-stop" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "select-stop", cwd, sessionId: "session", state: "running", agents: [], nativeSessions: [] }, snapshot);
  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let selectCalls = 0;
  let confirmations = 0;
  const notices: string[] = [];
  workflowExtension({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  const ctx = {
    cwd, mode: "rpc", hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify(message: string) { notices.push(message); },
      confirm: async () => { confirmations += 1; return true; },
      select: async (_prompt: string, options: string[]) => {
        selectCalls += 1;
        if (selectCalls === 1) return "Skip";
        if (selectCalls === 2) return options.find((option) => option.includes("select-stop")) ?? "Close";
        if (selectCalls === 3) return options.find((option) => option === "Stop") ?? "Close";
        return "Close";
      },
    },
  };
  assert.ok(start && commands[0]);
  await start({}, ctx);
  await commands[0].handler("", ctx as never);
  assert.equal(confirmations, 1);
  assert.equal((await store.load()).run.state, "stopped");
  assert.ok(notices.some((notice) => notice.includes("Stopped workflow run.")));
});

void test("navigator dashboard auto-refreshes the selected run", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-refresh-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'live',description:'live'}", args: null, metadata: { name: "live", description: "live" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "live", cwd, sessionId: "session", state: "running", phase: "before", agents: [], nativeSessions: [] }, snapshot);
  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  workflowExtension({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  let selectCall = 0;
  const ctx = {
    cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify() {}, confirm: async () => false,
      select: async (_prompt: string, options: string[]) => { selectCall += 1; return selectCall === 1 ? options[0] : "Back"; },
      custom: async (factory: (tui: { terminal: { rows: number }; requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }) => {
        const component = factory({ terminal: { rows: 8 }, requestRender() {} }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, () => {});
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.down");
        const before = component.render(200);
        assert.ok(before.length <= 8);
        assert.match(before.join("\n"), /phase: before/);
        assert.match(before.join("\n"), /→ View script/);
        const loaded = await store.load();
        const agents = Array.from({ length: 12 }, (_, index) => ({ id: `agent-${String(index)}`, name: `agent-${String(index)}`, path: `agent-${String(index)}`, state: "running" as const, model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 }));
        await store.saveState({ ...loaded.run, phase: "after", agents });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const grown = component.render(200);
        assert.ok(grown.length <= 8);
        assert.match(grown.join("\n"), /phase: after/);
        assert.match(grown.join("\n"), /→ View script/);
        for (let index = 0; index < 10; index += 1) component.handleInput?.("tui.select.pageDown");
        const bottom = component.render(200);
        assert.ok(bottom.length <= 8);
        assert.match(bottom.join("\n"), /agent-11/);
        const shrunk = await store.load();
        await store.saveState({ ...shrunk.run, state: "completed", agents: [] });
        await new Promise((resolve) => setTimeout(resolve, 1100));
        const compact = component.render(200);
        assert.ok(compact.length <= 8);
        assert.match(compact.join("\n"), /→ View script/);
        assert.match(compact.join("\n"), /Delete/);
        assert.doesNotMatch(compact.join("\n"), /→ Stop/);
        component.dispose?.();
        return "Close";
      },
    },
  };
  await commands[0]?.handler("", ctx as never);
});
void test("navigator exposes recovered runs without making them inert", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-actions-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "actions" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "actions", cwd, sessionId: "session", state: "running", agents: [], nativeSessions: [] }, snapshot);
  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const notices: string[] = [];
  workflowExtension({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  const sessionContext = { cwd, hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify(message: string) { notices.push(message); } } };
  assert.ok(start);
  await start({}, sessionContext);
  let pickerCalls = 0;
  let customCalls = 0;
  const ctx = { ...sessionContext, mode: "tui", ui: {
    notify(message: string) { notices.push(message); }, confirm: async () => false,
    select: async (_prompt: string, options: string[]) => { pickerCalls += 1; return options[0]; },
    custom: async (factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }) => {
      customCalls += 1;
      let result: string | undefined;
      const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { result = value; });
      const dashboard = component.render(200).join("\n");
      assert.match(dashboard, /interrupted/);
      assert.match(dashboard, /Resume/);
      component.handleInput?.("tui.select.cancel");
      component.dispose?.();
      return result;
    },
  } };
  await commands[0]?.handler("", ctx as never);
  assert.equal(pickerCalls, 1);
  assert.equal(customCalls, 1);
  assert.equal((await store.load()).run.state, "interrupted");
});
void test("navigator keeps consecutive checkpoint decisions in the same dashboard", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-checkpoint-actions-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "checkpoints" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "checkpoints", cwd, sessionId: "session", state: "awaiting_input", agents: [], nativeSessions: [] }, snapshot);
  await store.awaitCheckpoint({ path: "checkpoint/ship", name: "ship", prompt: "Ship?", context: null });
  await store.awaitCheckpoint({ path: "checkpoint/deploy", name: "deploy", prompt: "Deploy?", context: null });
  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  workflowExtension({ registerTool() {}, registerCommand(_name: string, options: { handler: (args: string, ctx: never) => Promise<void> }) { commands.push(options); }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], sendMessage() {} } as never, home);
  const sessionContext = { cwd, hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, ui: { notify() {}, select: async () => "Skip" } };
  assert.ok(start);
  await start({}, sessionContext);
  let customCalls = 0;
  const ctx = { ...sessionContext, mode: "tui", ui: {
    notify() {}, confirm: async () => false, select: async (_prompt: string, options: string[]) => options[0],
    custom: async (factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }) => {
      customCalls += 1;
      let result: string | undefined;
      const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { result = value; });
      const dashboard = component.render(200).join("\n");
      if (customCalls === 1) {
        assert.match(dashboard, /Review ship/);
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.confirm");
      } else if (customCalls === 2) {
        assert.match(dashboard, /Name: ship/);
        component.handleInput?.("tui.select.confirm");
      } else if (customCalls === 3) {
        assert.match(dashboard, /Review deploy/);
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.confirm");
      } else if (customCalls === 4) {
        assert.match(dashboard, /Name: deploy/);
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.confirm");
      } else {
        assert.match(dashboard, /interrupted/);
        component.handleInput?.("tui.select.cancel");
      }
      component.dispose?.();
      return result;
    },
  } };
  await commands[0]?.handler("", ctx as never);
  assert.equal(customCalls, 5);
  assert.deepEqual(await store.replay("checkpoint/ship"), { path: "checkpoint/ship", value: true });
  assert.deepEqual(await store.replay("checkpoint/deploy"), { path: "checkpoint/deploy", value: false });
});
void test("navigator returns to the picker after deleting a run", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-delete-actions-"));
  const cwd = join(home, "project");
  const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "delete", }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  const oldStore = new RunStore(cwd, "session", "old", home);
  const keepStore = new RunStore(cwd, "session", "keep", home);
  await oldStore.create({ id: "old", workflowName: "old", cwd, sessionId: "session", state: "completed", agents: [], nativeSessions: [] }, snapshot);
  await keepStore.create({ id: "keep", workflowName: "keep", cwd, sessionId: "session", state: "completed", agents: [], nativeSessions: [] }, snapshot);
  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  const pickerOptions: string[][] = [];
  let pickerCalls = 0;
  let customCalls = 0;
  workflowExtension({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  const ctx = { cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" }, ui: { notify() {}, confirm: async () => true, select: async (_prompt: string, options: string[]) => { pickerCalls += 1; pickerOptions.push(options); return pickerCalls === 1 ? options.find((option) => option.includes("old")) : "Close"; }, custom: async (factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }) => {
      customCalls += 1;
      let result: string | undefined;
      const component = factory({ requestRender() {} }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { result = value; });
      assert.match(component.render(200).join("\n"), /Delete/);
      component.handleInput?.("tui.select.down");
      component.handleInput?.("tui.select.confirm");
      component.dispose?.();
      return result;
    } } };
  await commands[0]?.handler("", ctx as never);
  assert.equal(customCalls, 1);
  assert.equal(pickerCalls, 2);
  assert.ok(pickerOptions[1]?.some((option) => option.includes("keep")));
  assert.doesNotMatch(pickerOptions[1]?.join("\n") ?? "", /old/);
  assert.equal(existsSync(oldStore.directory), false);
  assert.equal(existsSync(keepStore.directory), true);
});
void test("navigator opens the complete workflow script in a scrollable TUI pane", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-script-viewer-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const script = ["// SCRIPT_START", ...Array.from({ length: 20 }, (_, index) => `const line${String(index)} = ${String(index)};`), "// SCRIPT_END"].join("\n");
  const snapshot = createLaunchSnapshot({ script, args: null, metadata: { name: "viewer", description: "viewer" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
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

void test("navigator opens a selected native transcript in a scrollable TUI overlay", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-transcript-viewer-"));
  const cwd = join(home, "project");
  const transcriptPath = join(home, "native.jsonl");
  const session = { type: "session", version: 3, id: "native", timestamp: "2026-01-01T00:00:00.000Z", cwd };
  const entries = [
    { type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "FIRST_USER", timestamp: 1 } },
    { type: "message", id: "assistant", parentId: "user", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/index.ts" } }], api: "openai-responses", provider: "openai", model: "gpt", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "toolUse", timestamp: 2 } },
    { type: "message", id: "tool", parentId: "assistant", timestamp: "2026-01-01T00:00:03.000Z", message: { role: "toolResult", toolCallId: "call-1", toolName: "read", content: [{ type: "text", text: "TOOL_OUTPUT" }], isError: false, timestamp: 3 } },
    ...Array.from({ length: 12 }, (_, index) => ({ type: "message", id: `message-${String(index)}`, parentId: index === 0 ? "tool" : `message-${String(index - 1)}`, timestamp: `2026-01-01T00:00:${String(index + 4).padStart(2, "0")}.000Z`, message: { role: index % 2 ? "assistant" : "user", content: `TRANSCRIPT_LINE_${String(index)}`, ...(index % 2 ? { api: "openai-responses", provider: "openai", model: "gpt", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop" } : {}), timestamp: index + 4 } })),
    { type: "message", id: "end", parentId: "message-11", timestamp: "2026-01-01T00:00:20.000Z", message: { role: "assistant", content: [{ type: "text", text: "TRANSCRIPT_END" }], api: "openai-responses", provider: "openai", model: "gpt", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 20 } },
  ];
  writeFileSync(transcriptPath, `${[session, ...entries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "viewer" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "viewer", cwd, sessionId: "session", state: "completed", agents: [], nativeSessions: [{ sessionId: "native", sessionFile: transcriptPath }] }, snapshot);
  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  workflowExtension({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  let customCalls = 0;
  const ctx = {
    cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify() {}, confirm: async () => false,
      select: async (prompt: string, options: string[]) => { if (prompt === "Workflows\n") return options[0] ?? "Close"; assert.equal(prompt, "Native Pi transcripts"); assert.ok(options.includes(transcriptPath)); return transcriptPath; },
      custom: async (factory: (tui: { terminal: { rows: number }; requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }) => {
        customCalls += 1;
        let result: string | undefined;
        const component = factory({ terminal: { rows: 8 }, requestRender() {} }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { result = value; });
        if (customCalls === 1) {
          const dashboard = component.render(80).join("\n");
          assert.match(dashboard, /View transcript/);
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.confirm");
        } else if (customCalls === 2) {
          const initial = component.render(80).join("\n");
          assert.match(initial, /TRANSCRIPT_END/);
          assert.doesNotMatch(initial, /FIRST_USER/);
          assert.match(initial, /Home\/End jump/);
          component.handleInput?.("tui.editor.cursorLineStart");
          const first = component.render(80).join("\n");
          assert.match(first, /\[user\]/);
          assert.match(first, /\[assistant\]/);
          assert.match(first, /Tool call: read/);
          assert.match(first, /FIRST_USER/);
          assert.doesNotMatch(first, /TRANSCRIPT_END/);
          for (let index = 0; index < 20; index += 1) component.handleInput?.("tui.select.pageDown");
          assert.match(component.render(80).join("\n"), /TRANSCRIPT_END/);
          component.handleInput?.("tui.editor.cursorLineStart");
          component.handleInput?.("tui.editor.cursorLineEnd");
          const last = component.render(80).join("\n");
          assert.match(last, /TRANSCRIPT_END/);
          assert.doesNotMatch(last, /FIRST_USER/);
          component.handleInput?.("tui.select.cancel");
        } else {
          assert.match(component.render(80).join("\n"), /View transcript/);
          component.handleInput?.("tui.select.cancel");
        }
        component.dispose?.();
        return result;
      },
    },
  };
  await commands[0]?.handler("", ctx as never);
  assert.equal(customCalls, 3);
  await store.delete(true);
});


void test("navigator attention-orders runs, disambiguates names, shows breadcrumbs and bulk delete", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-navigator-v2-"));
  const cwd = join(home, "project");
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'build',description:'b'}", args: null, metadata: { name: "build", description: "b" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: ["read"], agentTypes: [], schemas: [] });
  const storeA = new RunStore(cwd, "s", "aaaa-1111-2222-3333", home);
  await storeA.create({ id: "aaaa-1111-2222-3333", workflowName: "build", cwd, sessionId: "s", state: "completed", agents: [{ id: "a:1", name: "scout", path: "a:1", state: "completed", model: { provider: "openai", model: "gpt" }, tools: ["read"], attempts: 1, accounting: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 } }], nativeSessions: [] }, snapshot);
  const storeB = new RunStore(cwd, "s", "bbbb-1111-2222-3333", home);
  await storeB.create({ id: "bbbb-1111-2222-3333", workflowName: "build", cwd, sessionId: "s", state: "running", phase: "review", agents: [{ id: "b:1", name: "root", path: "b:1", state: "completed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1 }, { id: "b:2", name: "child", path: "b:2", state: "running", parentId: "b:1", role: "reviewer", model: { provider: "openai", model: "gpt", thinking: "high" }, tools: ["read"], attempts: 1, attemptDetails: [{ attempt: 1, sessionId: "active", sessionFile: "/sessions/active.jsonl", accounting: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }], accounting: { input: 10, output: 5, cacheRead: 20, cacheWrite: 2, cost: 0.04 }, toolCalls: [{ id: "tc1", name: "read", state: "running" }], activity: { kind: "reasoning", text: "checking source" } }], nativeSessions: [{ sessionId: "active", sessionFile: "/sessions/active.jsonl" }] }, snapshot);
  const storeC = new RunStore(cwd, "s", "cccc-1111-2222-3333", home);
  await storeC.create({ id: "cccc-1111-2222-3333", workflowName: "deploy", cwd, sessionId: "s", state: "failed", agents: [{ id: "c:1", name: "deployer", path: "c:1", state: "failed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 2, attemptDetails: [{ attempt: 2, sessionId: "n", sessionFile: "/n", error: { code: "AGENT_FAILED", message: "timeout" }, accounting: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0 } }] }], nativeSessions: [] }, snapshot);

  // Dashboard with breadcrumbs and inline errors
  const dashB = formatNavigatorDashboard((await storeB.load()).run, [], []);
  assert.match(dashB, /root > child/);
  assert.match(dashB, /phase: review/);
  assert.match(dashB, /1\/2 agents/);
  assert.match(dashB, /37 tok/);
  assert.match(dashB, /reasoning/);
  assert.doesNotMatch(dashB, /checking source/);
  assert.match(dashB, /model=openai\/gpt:high/);
  assert.match(dashB, /role=reviewer/);
  assert.match(dashB, /tools=read/);
  assert.doesNotMatch(dashB, /cache read|transcript attempt/);

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

void test("navigator reviews each pending checkpoint before answering", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-checkpoint-review-"));
  const cwd = join(home, "project");
  const runId = "checkpoint-review";
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'review',description:'review'}", args: null, metadata: { name: "review", description: "review" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  const store = new RunStore(cwd, "session", runId, home);
  await store.create({ id: runId, workflowName: "review", cwd, sessionId: "session", state: "awaiting_input", agents: [], nativeSessions: [] }, snapshot);
  await store.awaitCheckpoint({ path: "checkpoint/first", name: "first", prompt: "Review the first artifact?", context: { artifact: "object", entries: Array.from({ length: 80 }, (_, index) => `entry-${String(index)}`), marker: "OBJECT_CONTEXT_END" } });
  await store.awaitCheckpoint({ path: "checkpoint/second", name: "second", prompt: "Review the second artifact?", context: null });

  type Component = { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void };
  type Factory = (tui: { terminal: { rows: number }; requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => Component;
  let start!: (event: unknown, ctx: unknown) => Promise<void>;
  let command!: (args: string, ctx: unknown) => Promise<void>;
  const notices: string[] = [];
  const pi = {
    registerTool() {},
    registerCommand(_name: string, options: { handler: typeof command }) { command = options.handler; },
    on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; },
    getThinkingLevel: () => "medium",
    getActiveTools: () => ["workflow"],
    sendMessage() {},
  };
  workflowExtension(pi as never, home);

  let selectCalls = 0;
  let customCalls = 0;
  let pendingAfterCancel = 0;
  const ctx = {
    cwd, mode: "tui", hasUI: true, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify(message: string) { notices.push(message); },
      select: async (_prompt: string, options: string[]) => { selectCalls += 1; return _prompt.includes("interrupted") ? "Skip" : options[0]; },
      custom: async (factory: Factory) => {
        customCalls += 1;
        let result: string | undefined;
        const tui = { terminal: { rows: 12 }, requestRender() {} };
        const component = factory(tui, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { result = value; });
        if (customCalls === 1) {
          const dashboard = component.render(80).join("\n");
          assert.match(dashboard, /Review first/);
          assert.match(dashboard, /Review second/);
          assert.doesNotMatch(dashboard, /Approve first/);
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.confirm");
        } else if (customCalls === 2) {
          const initial = component.render(40).join("\n");
          assert.ok(initial.split("\n").length <= 12);
          assert.match(initial, /Name: first/);
          assert.match(initial, /Review the first artifact\?/);
          assert.match(initial, /Context:/);
          assert.doesNotMatch(initial, /OBJECT_CONTEXT_END/);
          tui.terminal.rows = 7;
          const compact = component.render(40).join("\n");
          assert.ok(compact.split("\n").length <= 7);
          assert.match(compact, /Approve/);
          assert.match(compact, /Reject/);
          assert.match(compact, /Cancel/);
          tui.terminal.rows = 4;
          const tiny = component.render(40).join("\n");
          assert.ok(tiny.split("\n").length <= 4);
          assert.match(tiny, /Approve[\s\S]*Reject[\s\S]*Cancel/);
          tui.terminal.rows = 12;
          for (let index = 0; index < 100; index += 1) component.handleInput?.("tui.select.pageDown");
          const scrolled = component.render(40).join("\n");
          assert.ok(scrolled.split("\n").length <= 12);
          assert.match(scrolled, /OBJECT_CONTEXT_END/);
          component.handleInput?.("tui.select.confirm");
        } else if (customCalls === 3) {
          const dashboard = component.render(80).join("\n");
          assert.doesNotMatch(dashboard, /Review first/);
          assert.match(dashboard, /Review second/);
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.confirm");
        } else if (customCalls === 4) {
          const review = component.render(80).join("\n");
          assert.match(review, /Name: second/);
          assert.match(review, /Review the second artifact\?/);
          assert.match(review, /Context:\s*null/);
          component.handleInput?.("tui.select.cancel");
          pendingAfterCancel = (await store.awaitingCheckpoints()).length;
        } else if (customCalls === 5) {
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.confirm");
        } else if (customCalls === 6) {
          assert.match(component.render(80).join("\n"), /Name: second/);
          component.handleInput?.("tui.select.down");
          component.handleInput?.("tui.select.confirm");
        } else {
          component.handleInput?.("tui.select.cancel");
        }
        component.dispose?.();
        return result;
      },
    },
  };
  await start({}, ctx);
  await command("", ctx);

  assert.equal(selectCalls, 2);
  assert.equal(customCalls, 7);
  assert.equal(pendingAfterCancel, 1);
  assert.deepEqual(await store.replay("checkpoint/first"), { path: "checkpoint/first", value: true });
  assert.deepEqual(await store.replay("checkpoint/second"), { path: "checkpoint/second", value: false });
  assert.deepEqual(await store.awaitingCheckpoints(), []);
  assert.deepEqual(notices, []);
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
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-checkpoint-runtime-"));
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
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-concurrent-checkpoints-"));
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
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-checkpoint-race-"));
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
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-delivery-"));
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

void test("workflow log appends capped TUI-only transcript entries", async () => {
  type LogData = { workflowName: string; message: string };
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-log-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const entries: Array<{ type: string; data: LogData }> = [];
  let renderer: ((entry: { data?: LogData }, options: unknown, theme: unknown) => { render(width: number): string[] }) | undefined;
  workflowExtension({
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {},
    registerEntryRenderer(type: string, candidate: NonNullable<typeof renderer>) { assert.equal(type, "workflow-log"); renderer = candidate; },
    appendEntry(type: string, data: LogData) { entries.push({ type, data }); },
    getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"],
  } as never, home);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  await execute("id", { name: "logger", script: `await log("working"); await log("😀".repeat(2000)); return true;`, foreground: true }, new AbortController().signal, undefined, { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } });
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], { type: "workflow-log", data: { workflowName: "logger", message: "working" } });
  const truncated = entries[1];
  assert.ok(truncated);
  assert.ok(Buffer.byteLength(truncated.data.message) <= 4096);
  assert.doesNotMatch(truncated.data.message, /�/);
  assert.ok(renderer);
  assert.equal(renderer({ data: entries[0].data }, {}, {}).render(100).join("\n"), "Workflow logger: working");
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

void test("loads markdown agent roles only from canonical global and project directories", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-roles-"));
  const cwd = join(home, "project");
  const defaultAgentDir = join(home, ".pi", "agent");
  const customAgentDir = join(home, "custom-agent");
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    mkdirSync(join(defaultAgentDir, "pi-extensible-workflows", "roles"), { recursive: true });
    mkdirSync(join(home, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
    mkdirSync(join(home, ".pi", "piworkflows", "roles"), { recursive: true });
    mkdirSync(join(cwd, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
    mkdirSync(join(cwd, ".pi", "piworkflows", "roles"), { recursive: true });
    writeFileSync(join(defaultAgentDir, "pi-extensible-workflows", "roles", "global.md"), "---\ndescription: Global review\nmodel: openai/gpt\nthinking: high\ntools: [read, grep]\n---\nGlobal role");
    writeFileSync(join(defaultAgentDir, "pi-extensible-workflows", "roles", "collision.md"), "Canonical collision");
    writeFileSync(join(defaultAgentDir, "pi-extensible-workflows", "roles", "multiline.md"), "---\ntools:\n  - read\n  - grep\n---\nMultiline role");
    writeFileSync(join(home, ".pi", "pi-extensible-workflows", "roles", "old-global.md"), "Ignored old global role");
    writeFileSync(join(home, ".pi", "piworkflows", "roles", "old-legacy.md"), "Ignored legacy role");
    writeFileSync(join(cwd, ".pi", "piworkflows", "roles", "old-project.md"), "Ignored old project role");
    writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "reviewer.md"), "Review role");
    writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "shadowed.md"), "Project shadowed role");
    const roles = loadAgentDefinitions(cwd);
    assert.deepEqual(roles.global, { prompt: "Global role", description: "Global review", model: "openai/gpt", thinking: "high", tools: ["read", "grep"] });
    assert.equal(roles.reviewer?.prompt, "Review role");
    assert.deepEqual(roles.collision, { prompt: "Canonical collision" });
    assert.deepEqual(roles.shadowed, { prompt: "Project shadowed role" });
    assert.deepEqual(roles.multiline, { prompt: "Multiline role", tools: ["read", "grep"] });
    assert.equal(roles["old-global"], undefined);
    assert.equal(roles["old-legacy"], undefined);
    assert.equal(roles["old-project"], undefined);
    const untrusted = loadAgentDefinitions(cwd, undefined, false);
    assert.equal(untrusted.reviewer, undefined);
    assert.deepEqual(untrusted.collision, { prompt: "Canonical collision" });
    process.env.PI_CODING_AGENT_DIR = customAgentDir;
    mkdirSync(join(customAgentDir, "pi-extensible-workflows", "roles"), { recursive: true });
    writeFileSync(join(customAgentDir, "pi-extensible-workflows", "roles", "custom.md"), "Custom role");
    writeFileSync(join(customAgentDir, "pi-extensible-workflows", "roles", "collision.md"), "Custom collision");
    const customRoles = loadAgentDefinitions(cwd);
    assert.deepEqual(customRoles.custom, { prompt: "Custom role" });
    assert.deepEqual(customRoles.collision, { prompt: "Custom collision" });
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
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
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-role-policy-"));
  const cwd = join(home, "project");
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "broken.md"), "---\ntools: [missing]\n---\nBroken role");
  const tools: Array<{ name: string; execute: (id?: unknown, params?: unknown, signal?: unknown, update?: unknown, ctx?: unknown) => Promise<unknown> }> = [];
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["read", "workflow"] } as never, home);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  await assert.rejects(workflow.execute("id", { name: "invalid-role", script: `return agent("inspect", { role: "broken" });` }, new AbortController().signal, undefined, { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
  assert.deepEqual(await listRunIds(cwd, "session", home), []);
  await assert.rejects(workflow.execute("id", { name: "invalid-schema", script: `return agent("inspect", { outputSchema: [] });` }, new AbortController().signal, undefined, { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SCHEMA");
  assert.deepEqual(await listRunIds(cwd, "session", home), []);
});

void test("production role policy rejects overrides before persistence and preserves effective policy", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-role-execution-"));
  const cwd = join(home, "project");
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "reviewer.md"), "---\nmodel: openai/gpt\nthinking: high\ntools: [read]\n---\nReview role");
  for (const role of Object.keys(loadAgentDefinitions(cwd, undefined, false))) {
    if (role !== "reviewer") writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", `${role}.md`), "---\nmodel: openai/gpt\ntools: [read]\n---\nTest role");
  }
  const inputs: SessionInput[] = [];
  const createSession = async (input: SessionInput): Promise<NativeSession> => {
    inputs.push(input);
    return { sessionId: `session-${String(inputs.length)}`, sessionFile: `/sessions/${String(inputs.length)}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {} };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["read", "agent", "workflow"] } as never, home, async () => {}, createSession);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  for (const [field, value] of [["model", "openai/gpt"], ["thinking", "low"], ["tools", ["read"]] ] as const) {
    await assert.rejects(workflow.execute("id", { name: `static-${field}`, script: `return agent("inspect", { role: "reviewer", ${field}: ${JSON.stringify(value)} });`, foreground: true }, new AbortController().signal, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  }
  assert.deepEqual(await listRunIds(cwd, "session", home), []);
  for (const [field, value] of [["model", "openai/gpt"], ["thinking", "low"], ["tools", ["read"]] ] as const) {
    await assert.rejects(workflow.execute("id", { name: `dynamic-${field}`, script: `const options = { role: args.role }; options.${field} = args.value; return agent("inspect", options);`, args: { role: "reviewer", value }, foreground: true }, new AbortController().signal, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  }
  const dynamicRuns = await listRunIds(cwd, "session", home);
  assert.equal(dynamicRuns.length, 3);
  for (const runId of dynamicRuns) assert.deepEqual((await new RunStore(cwd, "session", runId, home).load()).run.agents, []);
  const result = await workflow.execute("id", { name: "role-only", script: "return agent(\"inspect\", { role: \"reviewer\", retries: 1, timeoutMs: 100 });", foreground: true }, new AbortController().signal, undefined, context) as { content: Array<{ text?: string }> };
  assert.equal((JSON.parse(result.content[0]?.text ?? "null") as string), "done");
  assert.deepEqual(inputs[0] && { model: inputs[0].model, thinking: inputs[0].model.thinking, tools: inputs[0].tools, systemPromptAppend: inputs[0].systemPromptAppend }, { model: { provider: "openai", model: "gpt", thinking: "high" }, thinking: "high", tools: ["read"], systemPromptAppend: "Review role" });
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

void test("default settings follow the effective agent directory", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-settings-"));
  const agentDir = join(home, ".pi", "agent");
  const customAgentDir = join(home, "custom-agent");
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
    writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ concurrency: 4 }));
    assert.deepEqual(loadSettings(), { concurrency: 4 });
    process.env.PI_CODING_AGENT_DIR = customAgentDir;
    mkdirSync(join(customAgentDir, "pi-extensible-workflows"), { recursive: true });
    writeFileSync(join(customAgentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ concurrency: 6 }));
    assert.deepEqual(loadSettings(), { concurrency: 6 });
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

void test("strict settings use defaults and reject unknown or unsafe values", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-"));
  assert.equal(loadSettings(join(dir, "missing.json")), DEFAULT_SETTINGS);
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({ concurrency: 4 }));
  assert.deepEqual(loadSettings(path), { concurrency: 4 });
  writeFileSync(path, JSON.stringify({ agentTimeoutMs: 500 }));
  assert.throws(() => loadSettings(path), /Unknown workflow setting/);
  writeFileSync(path, JSON.stringify({ concurrency: 17 }));
  assert.throws(() => loadSettings(path), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SETTINGS");
  writeFileSync(path, JSON.stringify({ surprise: true }));
  assert.throws(() => loadSettings(path), /Unknown workflow setting/);
});
void test("validates and resolves portable model aliases", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-aliases-"));
  const path = join(dir, "settings.json");
  const aliases = { "reviewer-model": "anthropic/opus:high", opus: "openai/gpt" };
  writeFileSync(path, JSON.stringify({ concurrency: 4, modelAliases: aliases }));
  assert.deepEqual(loadSettings(path).modelAliases, aliases);
  assert.deepEqual(resolveModelReference("reviewer-model", aliases, new Set(["anthropic/opus"])), { provider: "anthropic", model: "opus", thinking: "high" });
  assert.deepEqual(resolveModelReference("opus", aliases, new Set(["openai/opus", "anthropic/opus"])), { provider: "openai", model: "gpt" });
  assert.throws(() => validateModelAliases({ "bad/name": "p/m" }, path), (error: unknown) => error instanceof WorkflowError && error.code === "CONFIG_ERROR");
  assert.throws(() => validateModelAliases({ chained: "reviewer-model" }, path), (error: unknown) => error instanceof WorkflowError && error.code === "CONFIG_ERROR");
  assert.throws(() => preflight('agent("x", { model: "reviewer-model" })', { models: new Set(["openai/gpt"]), knownModels: new Set(["openai/gpt"]), tools: new Set(), agentTypes: new Set(), modelAliases: { "reviewer-model": "anthropic/opus" }, settingsPath: path }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL" && error.message.includes("reviewer-model") && error.message.includes("anthropic/opus") && error.message.includes(path));
  const executor = new WorkflowAgentExecutor({ cwd: dir, model: { provider: "openai", model: "gpt", thinking: "medium" }, tools: new Set(), knownModels: new Set(["openai/gpt", "anthropic/opus"]), modelAliases: { "reviewer-model": "anthropic/opus:high" }, agentDefinitions: { reviewer: { model: "reviewer-model" } }, settingsPath: path });
  assert.equal(executor.resolve({ label: "direct", workflowName: "test", model: "reviewer-model", thinking: "low" }).model.thinking, "low");
  assert.equal(executor.resolve({ label: "role", workflowName: "test", role: "reviewer" }).model.thinking, "high");
  assert.throws(() => executor.resolve({ label: "missing", workflowName: "test", model: "missing-model" }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL");
  const blocked = new WorkflowAgentExecutor({ cwd: dir, model: { provider: "openai", model: "gpt", thinking: "medium" }, tools: new Set(), knownModels: new Set(["openai/gpt", "anthropic/opus"]), modelAliases: {}, blockedAliases: new Set(["reviewer-model"]), settingsPath: path });
  assert.throws(() => blocked.resolve({ label: "deleted", workflowName: "test", model: "reviewer-model" }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL" && error.message.includes("reviewer-model"));
  saveModelAliases(path, { "reviewer-model": "anthropic/opus:high" });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { concurrency: 4, modelAliases: { "reviewer-model": "anthropic/opus:high" } });
  writeFileSync(path, "{");
  assert.throws(() => loadSettings(path), (error: unknown) => error instanceof WorkflowError && error.code === "CONFIG_ERROR");
});
void test("persists resume snapshots and warning events", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-resume-snapshot-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const initial = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "resume" }, settings: { ...DEFAULT_SETTINGS, modelAliases: { reviewer: "openai/gpt" } }, modelAliases: { reviewer: "openai/gpt" }, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "resume", cwd, sessionId: "session", state: "interrupted", agents: [], nativeSessions: [] }, initial);
  const next = createLaunchSnapshot({ ...initial, settings: { ...initial.settings, modelAliases: { reviewer: "anthropic/opus" } }, modelAliases: { reviewer: "anthropic/opus" } });
  await store.saveSnapshot(next);
  await store.appendEvent({ type: "warning", message: "reviewer: openai/gpt -> anthropic/opus" });
  await store.appendEvent({ type: "warning", message: "reviewer: openai/gpt -> anthropic/opus" });
  const loaded = await store.load();
  assert.deepEqual(loaded.snapshot.modelAliases, { reviewer: "anthropic/opus" });
  assert.deepEqual(loaded.run.events, [{ type: "warning", message: "reviewer: openai/gpt -> anthropic/opus" }]);
  assert.match(formatNavigatorDashboard(loaded.run, [], []), /reviewer: openai\/gpt -> anthropic\/opus/);
});
void test("workflow catalog exposes aliases without guidance metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-catalog-aliases-"));
  const agentDir = join(dir, "agent");
  const path = join(agentDir, "pi-extensible-workflows", "settings.json");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(path, JSON.stringify({ modelAliases: { reviewer: "anthropic/opus:high" } }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try { assert.deepEqual(new WorkflowRegistry().catalog().modelAliases, { reviewer: "anthropic/opus:high" }); } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
});

void test("workflow catalog and session_start tolerate malformed settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-catalog-malformed-"));
  const agentDir = join(dir, "agent");
  const path = join(agentDir, "pi-extensible-workflows", "settings.json");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(path, "{");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    assert.deepEqual(new WorkflowRegistry().catalog(), { functions: [], variables: [], workflows: [] });
    const tools: Array<{ name: string }> = [];
    let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    let shutdown: (() => Promise<void>) | undefined;
    workflowExtension({ registerTool(tool: { name: string }) { tools.push(tool); }, registerCommand() {}, getActiveTools: () => ["workflow"], on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; } } as never, dir);
    registerWorkflowExtension({ namespace: "malformedCatalog", version: "1.0.0", headline: "Malformed settings", description: "Malformed settings test", workflows: { verify: { description: "Verify", script: "return true;" } } });
    assert.ok(start && shutdown);
    await start({}, { cwd: dir, sessionManager: { getSessionId: () => "malformed" } });
    assert.equal(tools.some(({ name }) => name === "workflow_catalog"), true);
    await shutdown();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

void test("preflight accepts the complete static contract", () => {
  const metadata = { name: "review", description: "Review code" };
  const result = preflight(valid, capabilities, [{ type: "object", properties: { value: { type: "string" } } }], metadata);
  assert.equal(result.metadata.name, "review");
  assert.equal(result.dynamicAgentRoles, false);
  assert.equal(preflight(`agent("x", { role: args.role })`, capabilities).dynamicAgentRoles, true);
  assert.deepEqual(result.referenced, { phases: ["check"], models: ["openai/gpt"], tools: ["read"], agentTypes: ["reviewer"] });
  assert.deepEqual(preflight(valid.replace("openai/gpt", "openai/gpt:high"), capabilities, [], metadata).referenced.models, ["openai/gpt"]);
  assert.ok(Object.isFrozen(result.metadata));
  const staticSchema = { type: "object", properties: { answer: { type: "number" } } };
  assert.deepEqual(preflight(`agent("x",{outputSchema:${JSON.stringify(staticSchema)}})`, capabilities).schemas, [staticSchema]);
  preflight(`agent("x",{timeoutMs:0,timeoutMs:10})`, capabilities);
  preflight(`agent("x",{timeoutMs:0,...{timeoutMs:10}})`, capabilities);
});

void test("preflight rejects every static boundary before run creation", () => {
  let created = 0;
  const createRun = (script: string) => { preflight(script, capabilities, [], { name: "test" }); created += 1; };
  const cases: Array<[string, string]> = [
    ["const x = ;", "INVALID_SYNTAX"],
    [`agent('a',{model:'missing'})`, "UNKNOWN_MODEL"],
    [`agent('a',{model:'openai/gpt:turbo'})`, "UNKNOWN_MODEL"],
    [`agent('a',{tools:['bash']})`, "UNKNOWN_TOOL"],
    [`agent('a',{role:'writer'})`, "UNKNOWN_AGENT_TYPE"],
    [`agent('a',{role:'reviewer',model:'openai/gpt'})`, "INVALID_METADATA"],
    [`agent('a',{role:'reviewer',thinking:'low'})`, "INVALID_METADATA"],
    [`agent('a',{role:'reviewer',tools:[]})`, "INVALID_METADATA"],
    [`agent('a',{outputSchema:[]})`, "INVALID_SCHEMA"],
    [`agent('a',{label:' '})`, "INVALID_METADATA"],
    [`agent('a',{timeoutMs:0})`, "INVALID_METADATA"],
    [`agent('a',{retries:-1})`, "INVALID_METADATA"],
  ];
  for (const [script, code] of cases) assert.throws(() => { createRun(script); }, (error: unknown) => error instanceof WorkflowError && error.code === code);
  assert.equal(created, 0);
  assert.equal(preflight("phase('dynamic')", capabilities, [], { name: "minimal" }).metadata.name, "minimal");
  assert.throws(() => preflight("return 1", capabilities, [], { name: "" }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => preflight("return 1", capabilities, [{}]), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SCHEMA");
});

void test("host rejects malformed dynamic agent options before launching", async () => {
  let launched = false;
  for (const options of ["{label:' '}", "{tools:1}", "{timeoutMs:0}", "{retries:-1}", "{role:'reviewer',model:'openai/gpt'}", "{role:'reviewer',thinking:'low'}", "{role:'reviewer',tools:[]}"]) {
    await assert.rejects(runWorkflow(`return agent('a',${options});`, null, { agent: async () => { launched = true; return null; } }).result, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  }
  assert.equal(launched, false);
});
void test("passes explicit and extension agent options through the workflow boundary", async () => {
  let label: unknown;
  let received: unknown;
  const result = await runWorkflow("return agent('a', { label: 'API inspection', advisor: true, nested: { enabled: true } });", null, { agent: async (_prompt, options) => { label = options.label; received = options; return "done"; } }).result;
  assert.equal(result, "done");
  assert.equal(label, "API inspection");
  assert.deepEqual(received, { label: "API inspection", advisor: true, nested: { enabled: true } });
});
void test("preflight enforces object-key combinators without agent names", () => {
  const base = "return 1;";
  assert.throws(() => preflight(base, capabilities, [{ type: "object", properties: { bad: () => true } }]), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SCHEMA");
  assert.throws(() => preflight(`${base} parallel([{name:'task',run:()=>1}], {name:'batch'})`, capabilities), /operation name string and tasks record/);
  assert.throws(() => preflight(`${base} pipeline([{name:'item',value:1}], {name:'stage',run:value=>value}, {name:'pipe'})`, capabilities), /operation name string, items record, and stages record/);
  assert.doesNotThrow(() => preflight(`${base} agent('top-level')`, capabilities));
  preflight(`${base} parallel('batch',{task:()=>agent('inherited')}); pipeline('pipe',{item:1},{stage:value=>agent(String(value))})`, capabilities);
});

void test("AST preflight ignores DSL-looking non-executable text and member calls", () => {
  const script = `const text = "agent() checkpoint({}) phase('ghost') name: 'fake' model: 'missing' tools: ['bash'] role: 'writer'";
    const pattern = /agent() checkpoint({}) phase('ghost') model:'missing'/;
    const template = \`parallel() pipeline() agent() phase('ghost') model: 'missing'\`;
    // agent('comment') checkpoint({name:'comment'}) phase('ghost') model:'missing' tools:['bash'] role:'writer'
    object.agent('member'); object.checkpoint({}); object.phase('ghost'); object.parallel([]); object.pipeline([]);
    const unrelated = {model:'missing', tools:['bash'], role:'writer'};
    phase('real');
    agent("Explain agent() Promise behavior; name: 'fake'; model: 'missing'; tools: ['bash']; role: 'writer'", {model:'openai/gpt',tools:['read']});`;
  assert.deepEqual(preflight(script, capabilities).referenced, { phases: ["real"], models: ["openai/gpt"], tools: ["read"], agentTypes: [] });
});

void test("AST preflight distinguishes executable calls from prompt text", () => {
  const capabilitiesWithNames = capabilities;
  assert.doesNotThrow(() => preflight(`agent("name: 'fake'")`, capabilitiesWithNames));
  assert.throws(() => preflight(`checkpoint({prompt:"name: 'fake'",context:null})`, capabilitiesWithNames), /checkpoint requires a stable explicit name/);
  assert.doesNotThrow(() => preflight("const text = `${agent(\"name: 'fake'\")}`;", capabilitiesWithNames));
});

void test("AST preflight validates combinator signatures", () => {
  const base = "";
  assert.throws(() => preflight(`${base} parallel({task:()=>1}, 'batch')`, capabilities), /parallel requires/);
  assert.throws(() => preflight(`${base} pipeline('pipe', {item:1})`, capabilities), /pipeline requires/);
  preflight(`${base} agent('x', options); checkpoint(input); parallel(...batch); pipeline(...pipe);`, capabilities);
});

void test("launch snapshots are detached and deeply immutable", () => {
  const input = { script: `return withWorktree("snapshot", async () => true);`, args: { nested: [1] }, metadata: { name: "x", description: "x" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: ["read"], agentTypes: ["reviewer"], roles: { reviewer: { prompt: "original" } }, projectRoles: ["reviewer"], schemas: [{ type: "object" }] };
  const snapshot = createLaunchSnapshot(input);
  input.args.nested.push(2);
  input.roles.reviewer.prompt = "mutated";
  assert.deepEqual(snapshot.args, { nested: [1] });
  assert.equal(snapshot.identityVersion, 2);
  assert.equal(snapshot.roles?.reviewer?.prompt, "original");
  assert.ok(Object.isFrozen(snapshot.args));
  assert.ok(Object.isFrozen(snapshot.schemas[0]));
});

void test("worker exposes deterministic core globals and JSON RPC only", async () => {
  const phases: string[] = [];
  const script = `export const meta={name:'x',description:'x'};
    if (typeof process !== 'undefined' || typeof require !== 'undefined' || typeof console !== 'undefined' || typeof Date !== 'undefined' || typeof setTimeout !== 'undefined' || typeof Math.random !== 'undefined') throw new Error('unsafe global');
    await phase('build'); const decision = await checkpoint({name:'gate'}); if (decision !== 'approved') throw new Error('rejected'); return agent('echo');`
  const run = runWorkflow(script, { n: 2 }, {
    phase(name) { phases.push(name); },
    checkpoint() { return true; },
    agent(prompt, options) { return Promise.resolve({ prompt, options }); },
  });
  assert.deepEqual(await run.result, { prompt: "echo", options: {} });
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
    const first=agent('first'); const second=agent('second');
    let serialized; try{JSON.stringify(first)}catch(error){serialized=error.message}
    let interpolated; try{prompt('{report}',{report:first})}catch(error){interpolated=error.message}
    let stringified; try{first.toString()}catch(error){stringified=error.message}
    let coerced; try{'prefix '+first}catch(error){coerced=error.message}
    let agentInput; try{agent('prefix '+first)}catch(error){agentInput=error.message}
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

void test("agent and checkpoint calls expose bare values and typed failures", async () => {
  assert.equal(await runWorkflow(`return agent('direct');`, null, { agent: async () => "value" }).result, "value");
  for (const [code, message] of [["AGENT_FAILED", "failed"], ["AGENT_TIMEOUT", "timed out"], ["RESULT_INVALID", "invalid"]] as const) {
    await assert.rejects(runWorkflow(`return agent('direct');`, null, { agent: async () => { throw new WorkflowError(code, message); } }).result,
      (error: unknown) => error instanceof WorkflowError && error.code === code && error.message === message);
  }
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
  const parallelRun = runWorkflow(`return parallel('batch',{first:()=>agent('fail'),second:()=>agent('slow')});`, null, {
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
void test("direct workflow agents use call-site and occurrence identity", async () => {
  const source = `let values=[]; for(let index=0;index<2;index+=1) values.push(await agent("loop")); values.push(await agent("once")); return values;`;
  let launched = false;
  await assert.rejects(runWorkflow("return agent()", null, { agent: async () => { launched = true; return null; } }).result, /agent prompt must be a string/);
  assert.equal(launched, false);
  const identities: Array<{ structuralPath: string[]; callSite: string; occurrence: number }> = [];
  const run = runWorkflow(source, null, { agent: async (prompt, _options, _signal, identity) => { identities.push(identity as typeof identities[number]); return prompt; } });
  assert.deepEqual(await run.result, ["loop", "loop", "once"]);
  const [firstIdentity, secondIdentity, thirdIdentity] = identities;
  assert.ok(firstIdentity && secondIdentity && thirdIdentity);
  assert.equal(firstIdentity.occurrence, 1);
  assert.equal(secondIdentity.occurrence, 2);
  assert.notEqual(firstIdentity.callSite, thirdIdentity.callSite);
});

void test("withWorktree returns bare values and propagates one owner through parallel and pipeline", async () => {
  const identities: Array<{ prompt: string; worktreeOwner?: string }> = [];
  const result = await runWorkflow(`const shared = await withWorktree("shared", async () => ({
    parallel: await parallel("batch", { first: () => agent("first"), second: () => agent("second") }),
    pipeline: await pipeline("pipe", { one: 1, two: 2 }, { review: value => agent(String(value)) }),
  })); return { shared, outside: await agent("outside") };`, null, { agent: async (prompt, _options, _signal, identity) => { identities.push({ prompt, ...(identity.worktreeOwner ? { worktreeOwner: identity.worktreeOwner } : {}) }); return prompt; } }).result;
  assert.deepEqual(result, { shared: { parallel: { first: "first", second: "second" }, pipeline: { one: "1", two: "2" } }, outside: "outside" });
  const scoped = identities.filter(({ prompt }) => prompt !== "outside");
  assert.equal(new Set(scoped.map(({ worktreeOwner }) => worktreeOwner)).size, 1);
  assert.ok(scoped[0]?.worktreeOwner);
  assert.equal(identities.find(({ prompt }) => prompt === "outside")?.worktreeOwner, undefined);
});

void test("withWorktree validates calls, keeps empty scopes empty, and replays unnamed identity", async () => {
  const emptyOwners: string[] = [];
  assert.deepEqual(await runWorkflow(`return await withWorktree("empty", async () => ({ ok: true }));`, null, { agent: async (_prompt, _options, _signal, identity) => { emptyOwners.push(identity.worktreeOwner ?? ""); return null; } }).result, { ok: true });
  assert.deepEqual(emptyOwners, []);
  const namedOwners: string[] = [];
  await runWorkflow(`return await Promise.all([withWorktree("same", async () => agent("one")), withWorktree("same", async () => agent("two")), withWorktree("other", async () => agent("three"))]);`, null, { agent: async (_prompt, _options, _signal, identity) => { namedOwners.push(identity.worktreeOwner ?? ""); return "done"; } }).result;
  assert.equal(namedOwners[0], namedOwners[1]);
  assert.notEqual(namedOwners[0], namedOwners[2]);
  const script = `return await withWorktree(async () => agent("same"));`;
  const owner = async () => { let value = ""; await runWorkflow(script, null, { agent: async (_prompt, _options, _signal, identity) => { value = identity.worktreeOwner ?? ""; return "done"; } }).result; return value; };
  assert.equal(await owner(), await owner());
  assert.deepEqual(inspectWorkflowScript(`withWorktree("shared", async () => agent("x"));`).map(({ kind, name }) => ({ kind, name })), [{ kind: "withWorktree", name: "shared" }, { kind: "agent", name: null }]);
  for (const source of [`withWorktree("", () => 1)`, `withWorktree("shared", 1)`, `withWorktree("shared", () => 1, 2)`]) assert.throws(() => preflight(source, capabilities), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => preflight(`const alias = withWorktree; alias(() => 1);`, capabilities), /direct withWorktree.*aliases.*unsupported/i);
  await assert.rejects(runWorkflow(`const alias = withWorktree; return alias(() => 1);`).result, /direct withWorktree.*aliases.*unsupported/i);
});
void test("parallel identities do not depend on completion order", async () => {
  const resolvers = new Map<string, () => void>();
  const identities: Array<{ structuralPath: string[]; callSite: string; occurrence: number }> = [];
  const run = runWorkflow(`return parallel("batch",{first:()=>agent("first"),second:()=>agent("second")});`, null, {
    agent: async (prompt, _options, _signal, identity) => {
      identities.push(identity as typeof identities[number]);
      return new Promise<string>((resolve) => { resolvers.set(prompt, () => { resolve(prompt); }); });
    },
  });
  while (resolvers.size < 2) await new Promise((resolve) => setImmediate(resolve));
  const second = resolvers.get("second");
  const first = resolvers.get("first");
  assert.ok(second && first);
  second(); first();
  assert.deepEqual(await run.result, { first: "first", second: "second" });
  assert.deepEqual(identities.map(({ structuralPath, occurrence }) => ({ structuralPath, occurrence })).sort((left, right) => left.structuralPath.join("/").localeCompare(right.structuralPath.join("/"))), [{ structuralPath: ["batch", "first"], occurrence: 1 }, { structuralPath: ["batch", "second"], occurrence: 1 }]);
});

void test("aliases and reserved internals are rejected before the agent bridge while extension options pass through", async () => {
  let launched = false;
  await assert.rejects(runWorkflow(`const alias=agent; return alias("no");`, null, { agent: async () => { launched = true; return null; } }).result, /direct agent.*aliases.*unsupported/i);
  assert.equal(launched, false);
  assert.throws(() => preflight(`__pi_extensible_workflows_agent("x", {}, "0:1")`, capabilities), /reserved for workflow agent instrumentation/);
  assert.throws(() => runWorkflow(`return __pi_extensible_workflows_agent("x", {}, "0:1")`, null, { agent: async () => { launched = true; return null; } }), /reserved for workflow agent instrumentation/);
  await assert.rejects(runWorkflow(`const internal=globalThis["__pi_extensible_workflows"+"_agent"]; return internal("x", {}, "0:1");`, null, { agent: async () => { launched = true; return null; } }).result, /not a function/);
  assert.equal(launched, false);
  assert.doesNotThrow(() => preflight(`agent("x",{name:"old",continueFrom:"old"})`, capabilities));
  assert.equal(await runWorkflow(`return agent("x",{[args.key]:"old"});`, { key: "name" }, { agent: async () => { launched = true; return "ok"; } }).result, "ok");
  assert.equal(launched, true);
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
  const run = runWorkflow(`export const meta={name:'x',description:'x'}; return await agent('wait');`, null, {
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
  const rendered = runWorkflow(`export const meta={name:'x',description:'x'}; return agent(prompt('{text}',{text:'x'.repeat(${String(RPC_LIMIT_BYTES)})}));`, null, { agent: async () => { called = true; return null; } });
  await assert.rejects(rendered.result, (error: unknown) => error instanceof WorkflowError && error.code === "RPC_LIMIT_EXCEEDED");
  assert.equal(called, false);
});

void test("registers global functions and replays each call as one validated operation", async () => {
  const registry = new WorkflowRegistry();
  let calls = 0;
  let receivedContext: unknown;
  registry.register({
    namespace: "git", version: "1.2.3", headline: "Git operations", description: "Orchestrate Git work",
    functions: {
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
  const run = Object.freeze({ cwd: "/repo", sessionId: "session", runId: "run", workflow: Object.freeze({ name: "test" }), args: null, signal: new AbortController().signal });
  const context = { run, agent: async () => null, prompt: (template: string) => template, parallel: async () => null, pipeline: async () => null, withWorktree: async () => null, checkpoint: async () => true, phase: () => {}, log: () => {} };
  assert.deepEqual(await registry.invokeFunction("git", "status", { short: true }, context, "function/git/status/1", journal), { clean: true });
  assert.deepEqual(await registry.invokeFunction("git", "status", { short: false }, context, "function/git/status/1", journal), { clean: true });
  assert.equal(calls, 1);
  assert.ok(Object.isFrozen((receivedContext as { run: object }).run));
  assert.deepEqual(Object.keys(receivedContext as object).sort(), ["agent", "checkpoint", "log", "parallel", "phase", "pipeline", "prompt", "run", "withWorktree"]);
  assert.ok(Object.isFrozen((receivedContext as { run: { workflow: object } }).run.workflow));
});
void test("freezes registries and produces a deterministic flat catalog", () => {
  const registry = new WorkflowRegistry();
  const second = new WorkflowRegistry();
  assert.equal(registry.frozen, false);
  registry.register({
    namespace: "catalog", version: "1.0.0", headline: "Catalog", description: "Catalog test",
    functions: { inspect: { description: "Inspect", input: { type: "object" }, output: { type: "string" }, run: () => "ok" } },
    variables: { branch: { description: "Branch", schema: { type: "string" }, resolve: () => "main" } },
    workflows: { release: { description: "Release", script: "return branch;" } },
  });
  second.register({ namespace: "catalog", version: "1.0.0", headline: "Catalog", description: "Catalog test", workflows: { release: { description: "Release", script: "return 1;" } } });
  assert.deepEqual(registry.catalog().functions.map(({ name, namespace }) => ({ name, namespace })), [{ name: "inspect", namespace: "catalog" }]);
  assert.deepEqual(registry.catalog().variables.map(({ name, namespace }) => ({ name, namespace })), [{ name: "branch", namespace: "catalog" }]);
  assert.deepEqual(registry.catalog().workflows.map(({ name }) => name), ["catalog.release"]);
  registry.freeze();
  assert.equal(registry.frozen, true);
  assert.throws(() => { registry.register({ namespace: "late", version: "1.0.0", headline: "Late", description: "Late", workflows: { x: { description: "x", script: "return 1;" } } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "REGISTRY_FROZEN");
  assert.throws(() => registry.workflow("release"), (error: unknown) => error instanceof WorkflowError && error.code === "MISSING_WORKFLOW");
});
void test("registers setup hooks by priority and stable qualified name", () => {
  const registry = new WorkflowRegistry();
  registry.register({ namespace: "hooks", version: "1.0.0", headline: "Hooks", description: "Hooks", agentSetupHooks: { z: { setup() {} }, a: { priority: 10, setup() {} }, early: { priority: 1, setup() {} } } });
  assert.deepEqual(registry.agentSetupHooks().map(({ name, priority }) => ({ name, priority })), [{ name: "hooks.early", priority: 1 }, { name: "hooks.a", priority: 10 }, { name: "hooks.z", priority: 10 }]);
  assert.throws(() => { registry.register({ namespace: "badHooks", version: "1.0.0", headline: "Hooks", description: "Hooks", agentSetupHooks: { bad: { priority: Number.NaN, setup() {} } } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});
void test("shares the registry between package imports and Pi's jiti loader", () => {
  const script = `
import { createRequire } from "node:module";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { createJiti } = require(${JSON.stringify(join(process.cwd(), "node_modules/@earendil-works/pi-coding-agent/node_modules/jiti"))});
const native = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "dist/src/index.js")).href)});
const jiti = createJiti(import.meta.url, { moduleCache: false, tryNative: false });
const source = await jiti.import(${JSON.stringify(join(process.cwd(), "src/index.ts"))});
native.registerWorkflowExtension({ namespace: "loaderBoundary", version: "1.0.0", headline: "Loader", description: "Loader boundary", workflows: { verify: { description: "Verify", script: "return 1;" } } });
const catalog = source.workflowCatalog();
if (catalog.workflows.length !== 1 || catalog.workflows[0]?.name !== "loaderBoundary.verify") throw new Error(JSON.stringify(catalog));
`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), stdio: "pipe" });
});
void test("keeps workflow_catalog active after Pi session replacement", () => {
  const script = `
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime, createAgentSessionFromServices, createAgentSessionRuntime, createAgentSessionServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
const cwd = process.cwd();
const agentDir = mkdtempSync(join(tmpdir(), "pi-workflow-catalog-reload-"));
mkdirSync(join(agentDir, "extensions"));
writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [cwd] }));
writeFileSync(join(agentDir, "extensions", "catalog.ts"), \`import { registerWorkflowExtension } from \${JSON.stringify(join(cwd, "dist/src/index.js"))};\nconst extension = { namespace: "reloadCatalog", version: "1.0.0", headline: "Reload", description: "Reload test", functions: { ping: { description: "Ping", input: { type: "object" }, output: { type: "string" }, run: () => "pong" } } };\nexport default function() { registerWorkflowExtension(extension); }\`);
process.env.PI_OFFLINE = "1";
const credentials = new InMemoryCredentialStore();
const createRuntime = async ({ cwd, agentDir, sessionManager, sessionStartEvent }) => {
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: join(agentDir, "models.json") });
  const services = await createAgentSessionServices({ cwd, agentDir, settingsManager, modelRuntime, resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true }, resourceLoaderReloadOptions: { resolveProjectTrust: async () => true } });
  return { ...await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent, model: modelRuntime.getModels()[0] }), services, diagnostics: [] };
};
const runtime = await createAgentSessionRuntime(createRuntime, { cwd, agentDir, sessionManager: SessionManager.inMemory(cwd), sessionStartEvent: { type: "session_start", reason: "startup" } });
runtime.setRebindSession((session) => session.bindExtensions({ mode: "print" }));
await runtime.session.bindExtensions({ mode: "print" });
const catalogActive = () => runtime.session.agent.state.tools.some(({ name }) => name === "workflow_catalog");
assert.equal(catalogActive(), true);
await runtime.newSession();
assert.equal(catalogActive(), true);
await runtime.dispose();
`;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(), stdio: "pipe" });
});

void test("navigator stop reports cleanup failures without closing unexpectedly", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-stop-failure-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const snapshot = createLaunchSnapshot({ script: "export const meta={name:'broken',description:'broken'}", args: null, metadata: { name: "broken", description: "broken" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "broken", cwd, sessionId: "session", state: "running", agents: [], nativeSessions: [] }, snapshot);
  await store.saveOwnership([{ id: "run:1", label: "worker", state: "running", options: { label: "worker", cwd, tools: [] } }]);
  failedOwnership.add(store.directory);
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  const commands: Array<{ handler: (args: string, ctx: never) => Promise<void> }> = [];
  const notices: string[] = [];
  const statuses: Array<string | undefined> = [];
  let customCalls = 0;
  let componentDisposed = false;
  let rendered = "";
  let closeNavigator = () => {};
  workflowExtension({ registerTool() {}, registerCommand(_name: string, options: (typeof commands)[number]) { commands.push(options); }, on(name: string, handler: typeof start) { if (name === "session_start") start = handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  assert.ok(start && commands[0]);
  const ctx = {
    cwd, mode: "tui", hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" },
    ui: {
      notify(message: string) { notices.push(message); }, setStatus(_key: string, text: string | undefined) { statuses.push(text); }, confirm: async () => true,
      select: async (_prompt: string, options: string[]) => options[0] ?? "Close",
      custom: async (factory: (tui: { requestRender(): void }, theme: { fg(color: string, text: string): string }, keybindings: { matches(data: string, binding: string): boolean }, done: (value?: string) => void) => { render(width: number): string[]; handleInput?(data: string): void; dispose?(): void }, options?: { overlay?: boolean }) => {
        customCalls += 1;
        assert.equal(options?.overlay, true);
        let result: string | undefined;
        let resolveCustom!: (value: string | undefined) => void;
        const completed = new Promise<string | undefined>((resolve) => { resolveCustom = resolve; });
        const component = factory({ requestRender() { rendered = component.render(200).join("\n"); } }, { fg: (_color, text) => text }, { matches: (data, binding) => data === binding }, (value) => { componentDisposed = true; result = value; resolveCustom(value); });
        closeNavigator = () => component.handleInput?.("tui.select.cancel");
        component.handleInput?.("tui.select.down");
        component.handleInput?.("tui.select.confirm");
        await completed;
        component.dispose?.();
        return result;
      },
    },
  };
  const command = commands[0];
  assert.ok(command);
  await start({}, ctx);
  const pending = command.handler("", ctx as never);
  for (let attempt = 0; attempt < 100 && !statuses.some((status) => status?.includes("Could not stop workflow")); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(statuses.some((status) => status?.includes("Could not stop workflow")));
  assert.equal(componentDisposed, false);
  assert.match(rendered, /scheduler cleanup failed/);
  failedOwnership.delete(store.directory);
  await new Promise((resolve) => setTimeout(resolve, 10));
  closeNavigator();
  await pending;
  assert.equal(customCalls, 1);
  assert.ok(notices.some((notice) => notice.includes("scheduler cleanup failed")));
});

void test("rejects global collisions, invalid metadata, schemas, input, and output", async () => {
  const registry = new WorkflowRegistry();
  const extension = { namespace: "demo", version: "1.0.0", headline: "Demo", description: "Demo functions", functions: { run: { description: "Run", input: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, output: { type: "string" }, run: () => 1 } } };
  registry.register(extension);
  assert.throws(() => { registry.register(extension); }, (error: unknown) => error instanceof WorkflowError && error.code === "DUPLICATE_NAME");
  assert.throws(() => { registry.register({ ...extension, namespace: "other" }); }, (error: unknown) => error instanceof WorkflowError && error.code === "GLOBAL_COLLISION" && /demo\.run.*other\.run/.test(error.message));
  const crossType = new WorkflowRegistry();
  crossType.register(extension);
  const variableExtension = { namespace: "variables", version: "1.0.0", headline: "Variables", description: "Variable globals", variables: { run: { description: "Run", schema: { type: "string" }, resolve: () => "ok" } } };
  assert.throws(() => { crossType.register(variableExtension); }, (error: unknown) => error instanceof WorkflowError && error.code === "GLOBAL_COLLISION" && /demo\.run.*variables\.run/.test(error.message));
  for (const name of ["agent", "Date", "process", "extensions"]) {
    assert.throws(() => { new WorkflowRegistry().register({ ...extension, functions: { [name]: extension.functions.run } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "GLOBAL_COLLISION");
  }
  assert.throws(() => { new WorkflowRegistry().register({ ...extension, functions: { __pi_extensible_workflows_internal: extension.functions.run } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => { new WorkflowRegistry().register({ ...extension, namespace: undefined as never }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => { new WorkflowRegistry().register({ ...extension, version: undefined as never }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => { new WorkflowRegistry().register({ ...extension, workflows: { "release.check": { description: "Release", script: "return 1;" } } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => { new WorkflowRegistry().register({ ...extension, namespace: "bad-name" }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => { new WorkflowRegistry().register({ ...extension, version: "v1" }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => { new WorkflowRegistry().register({ ...extension, functions: { run: { ...extension.functions.run, description: "", input: { type: "string" } } } }); }, WorkflowError);
  const journal = { get: () => undefined, put: () => {} };
  const context = { run: Object.freeze({ cwd: "/repo", sessionId: "session", runId: "run", workflow: Object.freeze({ name: "test" }), args: null, signal: new AbortController().signal }), agent: async () => null, prompt: (template: string) => template, parallel: async () => null, pipeline: async () => null, withWorktree: async () => null, checkpoint: async () => true, phase: () => {}, log: () => {} };
  await assert.rejects(registry.invokeFunction("demo", "run", { value: 1 }, context, "bad-input", journal), (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID");
  await assert.rejects(registry.invokeFunction("demo", "run", { value: "x" }, context, "bad-output", journal), (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID");
});
void test("presents every workflow error code as factual prose", () => {
  for (const code of ERROR_CODES) {
    const prose = formatWorkflowFailure(new WorkflowError(code, `${code}: model-or-role detail 123e4567-e89b-12d3-a456-426614174000\n    at internal-callsite-id`));
    assert.match(prose, /model-or-role detail/);
    assert.doesNotMatch(prose, new RegExp(`\\b${code}\\b`));
    assert.doesNotMatch(prose, /123e4567-e89b-12d3-a456-426614174000|internal-callsite-id/);
  }
  assert.equal(formatWorkflowFailure(new Error("The release was rejected by the approval gate.")), "The release was rejected by the approval gate.");
  assert.equal(formatWorkflowFailure("plain thrown value"), "The workflow failed with value plain thrown value.");
  const owned = formatWorkflowFailure(new WorkflowError("RUN_OWNED", "Pi session session-a is already owned by process 42"));
  assert.doesNotMatch(owned, /session-a|process 42/);
  const composed = formatWorkflowFailure(new WorkflowError("INTERNAL_ERROR", "Nested UNKNOWN_MODEL: missing/provider"));
  assert.match(composed, /missing\/provider/);
  assert.doesNotMatch(composed, /UNKNOWN_MODEL/);
});
void test("foreground workflow failures preserve codes while returning main-agent prose", async () => {
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };
  const tools: Tool[] = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-foreground-failure-"));
  workflowExtension({ registerTool(tool: Tool) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] } as never, home);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await assert.rejects(tool.execute("id", { name: "custom", script: "throw new Error('The release was rejected by the approval gate.');", foreground: true }, new AbortController().signal, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "INTERNAL_ERROR" && error.message === "The release was rejected by the approval gate.");
  await assert.rejects(tool.execute("id", { name: "value", script: "throw 'plain thrown value';", foreground: true }, new AbortController().signal, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "INTERNAL_ERROR" && error.message === "The workflow encountered an internal error: plain thrown value.");
});
void test("background failures and workflow responses deliver prose to the main agent", async () => {
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details?: { runId?: string; accepted?: boolean } }> };
  const tools: Tool[] = [];
  const delivered: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-background-failure-"));
  workflowExtension({ registerTool(tool: Tool) { tools.push(tool); }, registerCommand() {}, on() {}, sendMessage(message: { content: string }) { delivered.push(message.content); }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_respond"] } as never, home);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await tool.execute("id", { name: "custom-background", script: "throw Object.assign(new Error('The approval gate rejected the release.'), {code:'ENOSPC'});" }, new AbortController().signal, undefined, context);
  await tool.execute("id", { name: "value-background", script: "throw 'background value';" }, new AbortController().signal, undefined, context);
  for (let attempt = 0; attempt < 100 && delivered.filter((message) => message.includes("failed:")).length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(delivered.some((message) => message.includes("The approval gate rejected the release.")));
  assert.ok(delivered.some((message) => message.includes("background value")));
  assert.ok(delivered.filter((message) => message.includes("failed:")).every((message) => !ERROR_CODES.some((code) => message.includes(code))));
});
void test("workflow_respond keeps asynchronous failures on the prose delivery path", async () => {
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details?: { runId?: string; accepted?: boolean } }> };
  const tools: Tool[] = [];
  const delivered: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-respond-failure-"));
  workflowExtension({ registerTool(tool: Tool) { tools.push(tool); }, registerCommand() {}, on() {}, sendMessage(message: { content: string }) { delivered.push(message.content); }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_respond"] } as never, home);
  const workflow = tools.find(({ name }) => name === "workflow");
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(workflow && respond);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const started = await workflow.execute("id", { name: "respond-failure", script: "const approved = await checkpoint({name:'ship', prompt:'Ship?', context:null}); if (approved) throw new Error('The release was rejected after approval.'); return approved;" }, new AbortController().signal, undefined, context);
  const runId = (JSON.parse(started.content[0]?.text ?? "{}") as { runId?: string }).runId;
  assert.ok(runId);
  for (let attempt = 0; attempt < 100 && !delivered.some((message) => message.includes("Ship?")); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const response = await respond.execute("id", { runId, name: "ship", approved: true }, undefined, undefined, context);
  assert.equal(response.details?.accepted, true);
  for (let attempt = 0; attempt < 100 && !delivered.some((message) => message.includes("The release was rejected after approval.")); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(delivered.some((message) => message.includes("The release was rejected after approval.")));
  assert.ok(delivered.every((message) => !message.includes("INTERNAL_ERROR")));
});

type BudgetMessage = { role: string; content: unknown; usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: { total: number } } };
type BudgetResponse = { content: unknown; usage?: BudgetMessage["usage"] };

function budgetUsage(input: number, output: number, cost = 0): NonNullable<BudgetMessage["usage"]> { return { input, output, cacheRead: 100, cacheWrite: 200, cost: { total: cost } }; }

function budgetSession(responses: readonly BudgetResponse[], steered: string[] = [], aborted = { value: false }): NativeSession {
  let listener: ((event: never) => void) | undefined;
  let responseIndex = 0;
  const messages: BudgetMessage[] = [];
  return {
    sessionId: `budget-session-${String(Math.random())}`,
    sessionFile: "/sessions/budget.jsonl",
    messages,
    getSessionStats() {
      const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      let cost = 0;
      for (const message of messages) {
        const usage = message.usage;
        if (!usage) continue;
        tokens.input += usage.input; tokens.output += usage.output; tokens.cacheRead += usage.cacheRead; tokens.cacheWrite += usage.cacheWrite; cost += usage.cost.total;
      }
      return { tokens: { ...tokens, total: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheWrite }, cost };
    },
    subscribe(candidate) { listener = candidate; return () => { listener = undefined; }; },
    async prompt() {
      while (responseIndex < responses.length && !aborted.value) {
        const response = responses[responseIndex++];
        if (!response) throw new Error("No mock response");
        const start = { role: "assistant", content: response.content };
        listener?.({ type: "message_start", message: start } as never);
        const message = { ...start, ...(response.usage ? { usage: response.usage } : {}) };
        messages.push(message);
        listener?.({ type: "message_end", message } as never);
      }
    },
    async steer(message) { steered.push(message); },
    async abort() { aborted.value = true; },
    dispose() {},
  };
}

function budgetExecutor(session: NativeSession): WorkflowAgentExecutor {
  return new WorkflowAgentExecutor({ cwd: "/repo", model: { provider: "openai", model: "gpt" }, tools: new Set() }, async () => session);
}

void test("budget validation covers zero, all dimensions, and invalid patches", () => {
  assert.deepEqual(validateBudget({ tokens: { soft: 0, hard: 1 }, costUsd: { soft: 0, hard: 0.5 }, durationMs: { soft: 0, hard: 1 }, agentLaunches: { soft: 0, hard: 1 } }), { tokens: { soft: 0, hard: 1 }, costUsd: { soft: 0, hard: 0.5 }, durationMs: { soft: 0, hard: 1 }, agentLaunches: { soft: 0, hard: 1 } });
  for (const dimension of ["tokens", "durationMs", "agentLaunches"] as const) {
    assert.throws(() => validateBudget({ [dimension]: { hard: 1.5 } }), /integer/);
  }
  assert.throws(() => validateBudget({ costUsd: { hard: Infinity } }), /finite/);
  assert.throws(() => validateBudget({ tokens: { soft: null } }), /non-negative/);
  assert.throws(() => validateBudget({ tokens: { hard: 1 }, extra: { hard: 2 } }), /Unknown budget dimension/);
  assert.throws(() => validateBudgetPatch({ tokens: { soft: 2, hard: 2 } }), /less than hard/);
  assert.throws(() => validateBudgetPatch({ tokens: { hard: "later" } }), /integer/);
});

void test("budget runtime aggregates nested attempts, retries, cache exclusion, and versioned soft events", () => {
  let now = 0;
  const limits = { tokens: { soft: 3, hard: 100 }, costUsd: { soft: 0.5, hard: 100 }, durationMs: { soft: 4, hard: 100 }, agentLaunches: { soft: 1, hard: 10 } };
  const runtime = new WorkflowBudgetRuntime(limits, 1, undefined, [], { now: () => now });
  const parent = runtime.forAgent("parent");
  parent.beforeAttempt();
  parent.afterTurn({ input: 1, output: 1, cacheRead: 50, cacheWrite: 50, cost: 0.25 }, true);
  parent.beforeAttempt();
  parent.afterTurn({ input: 2, output: 2, cacheRead: 500, cacheWrite: 500, cost: 0.75 }, true);
  const child = runtime.forAgent("parent:child");
  child.beforeAttempt();
  child.afterTurn({ input: 1, output: 0, cacheRead: 999, cacheWrite: 999, cost: 0.1 }, true);
  assert.deepEqual(runtime.usage, { tokens: 7, costUsd: 1.1, durationMs: 0, agentLaunches: 3 });
  assert.equal(runtime.events.filter((event) => event.budgetVersion === 1 && event.type === "soft_crossed").length, 1);
  assert.ok(parent.instruction());
  assert.equal(parent.instruction(), undefined);
  assert.ok(child.instruction());
  runtime.transition("paused");
  now = 100;
  assert.equal(runtime.usage.durationMs, 0);
  runtime.transition("running");
  now = 104;
  assert.equal(runtime.usage.durationMs, 4);
  const next = new WorkflowBudgetRuntime(limits, 2, runtime.usage, runtime.events, { now: () => now, active: false });
  assert.equal(next.events.filter((event) => event.budgetVersion === 2).length, 0);
  assert.ok(next.forAgent("later").instruction());
});

void test("agent launch budgets are checked at the concurrent dispatch boundary", async () => {
  const runtime = new WorkflowBudgetRuntime({ agentLaunches: { hard: 1 } });
  const scheduler = new FairAgentScheduler(async ({ id }) => { runtime.forAgent(id).beforeAttempt(); return id; }, 2);
  scheduler.addRun("budget", 2, () => { runtime.checkAgentLaunch(); });
  const first = scheduler.spawn("budget", "first", { label: "first", cwd: "/repo", tools: [] });
  const second = scheduler.spawn("budget", "second", { label: "second", cwd: "/repo", tools: [] });
  assert.equal((await first.result).ok, true);
  const rejected = await second.result;
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error.code, "BUDGET_EXHAUSTED");
  assert.equal(runtime.usage.agentLaunches, 1);
});

void test("agent executor injects soft guidance and preserves final overrun but cuts off non-final work", async () => {
  const guidance: string[] = [];
  const soft = new WorkflowBudgetRuntime({ tokens: { soft: 1, hard: 100 } });
  const softSession = budgetSession([
    { content: [{ type: "toolCall", id: "tool-1", name: "read", arguments: {} }], usage: budgetUsage(1, 1) },
    { content: [{ type: "text", text: "done" }], usage: budgetUsage(2, 2) },
  ], guidance);
  const softResult = await budgetExecutor(softSession).execute("soft", { label: "soft", workflowName: "budget", budget: soft.forAgent("soft") });
  assert.equal(softResult.value, "done");
  assert.equal(guidance.length, 1);
  assert.match(guidance[0] ?? "", /Finish the requested output/);

  const finalRuntime = new WorkflowBudgetRuntime({ tokens: { hard: 1 } });
  const final = await budgetExecutor(budgetSession([{ content: [{ type: "text", text: "accepted" }], usage: budgetUsage(2, 0) }])).execute("final", { label: "final", workflowName: "budget", budget: finalRuntime.forAgent("final") });
  assert.equal(final.value, "accepted");
  assert.equal(finalRuntime.events.at(-1)?.type, "hard_overrun");
  assert.equal(finalRuntime.hardExhausted, false);

  const aborted = { value: false };
  const nonFinalRuntime = new WorkflowBudgetRuntime({ tokens: { hard: 1 } });
  const nonFinalSession = budgetSession([{ content: [{ type: "toolCall", id: "tool-2", name: "read", arguments: {} }], usage: budgetUsage(2, 0) }], [], aborted);
  await assert.rejects(budgetExecutor(nonFinalSession).execute("non-final", { label: "non-final", workflowName: "budget", budget: nonFinalRuntime.forAgent("non-final") }), (error: unknown) => error instanceof WorkflowError && error.code === "BUDGET_EXHAUSTED");
  assert.equal(aborted.value, true);
  assert.equal(nonFinalRuntime.hardExhausted, true);
});

void test("budget persistence retains usage, versions, events, and replay history across reload", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-budget-persistence-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const budget = { tokens: { soft: 2, hard: 4 }, costUsd: { hard: 1 } };
  const usage = { tokens: 4, costUsd: 1.2, durationMs: 8, agentLaunches: 2 };
  const event = { type: "hard_exhausted" as const, budgetVersion: 1, dimensions: ["tokens"] as const, usage, limits: budget, at: 8 };
  const snapshot = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "budget" }, settings: DEFAULT_SETTINGS, budget, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] });
  await store.create({ id: "run", workflowName: "budget", cwd, sessionId: "session", state: "budget_exhausted", agents: [], nativeSessions: [], budget, budgetVersion: 1, usage, budgetEvents: [event] }, snapshot);
  await store.complete("agent/replayed", "historical");
  const reloaded = await new RunStore(cwd, "session", "run", home).load();
  assert.deepEqual(reloaded.run.usage, usage);
  assert.deepEqual(reloaded.run.budget, budget);
  assert.deepEqual(reloaded.run.budgetEvents, [event]);
  assert.deepEqual(await new RunStore(cwd, "session", "run", home).replay("agent/replayed"), { path: "agent/replayed", value: "historical" });
});

void test("completed final overruns complete, while later budgeted work reaches budget_exhausted", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-budget-boundaries-"));
  const cwd = join(home, "project");
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let sessionCount = 0;
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], } as never, home, async () => {}, async () => { sessionCount += 1; return budgetSession([{ content: [{ type: "text", text: "done" }], usage: budgetUsage(2, 0) }]); });
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const completed = await workflow.execute("id", { name: "final-overrun", script: "return await agent('one');", budget: { tokens: { hard: 1 } }, foreground: true }, new AbortController().signal, undefined, context);
  const completedRun = (await new RunStore(cwd, "session", (await listRunIds(cwd, "session", home))[0] ?? "", home).load()).run;
  assert.equal(completedRun.state, "completed");
  assert.equal(completedRun.budgetEvents?.filter(({ type }) => type === "hard_overrun").length, 1);
  assert.match(JSON.stringify(completed), /done/);
  const second = workflow.execute("id", { name: "exhausted", script: "return {one: await agent('one'), two: await agent('two')};", budget: { tokens: { hard: 1 } }, foreground: true }, new AbortController().signal, undefined, context);
  await assert.rejects(second, (error: unknown) => error instanceof WorkflowError && error.code === "BUDGET_EXHAUSTED");
  const states = await Promise.all((await listRunIds(cwd, "session", home)).map(async (id) => (await new RunStore(cwd, "session", id, home).load()).run));
  const exhausted = states.find((run) => run.state === "budget_exhausted");
  assert.ok(exhausted);
  assert.equal(exhausted.error?.code, "BUDGET_EXHAUSTED");
  assert.ok(sessionCount >= 2);
});

void test("workflow_resume persists exact proposals and approval or rejection controls exhausted runs", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-budget-resume-"));
  const cwd = join(home, "project");
  const runId = "budget-run";
  const budget = { tokens: { soft: 2, hard: 4 } };
  const usage = { tokens: 4, costUsd: 0, durationMs: 0, agentLaunches: 1 };
  const exhausted = { type: "hard_exhausted" as const, budgetVersion: 1, dimensions: ["tokens"] as const, usage, limits: budget, at: 0 };
  const store = new RunStore(cwd, "session", runId, home);
  await store.create({ id: runId, workflowName: "resume-budget", cwd, sessionId: "session", state: "budget_exhausted", agents: [], nativeSessions: [], budget, budgetVersion: 1, usage, budgetEvents: [exhausted] }, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "resume-budget" }, settings: { concurrency: 1 }, budget, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  workflowExtension({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; }, sendMessage() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_respond"] } as never, home);
  const context = { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  assert.ok(start);
  await start({}, context);
  const resume = tools.find(({ name }) => name === "workflow_resume");
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(resume && respond);
  await assert.rejects(resume.execute("id", { runId: "missing" }), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  await assert.rejects(resume.execute("id", { runId, budget: { tokens: { hard: 4 } } }), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE" && /exhausted hard budget/.test(error.message));
  const waitDecision = async () => { for (let attempt = 0; attempt < 100; attempt += 1) { const pending = await store.pendingWorkflowDecisions(); if (pending[0]) return pending[0]; await new Promise((resolve) => setImmediate(resolve)); } throw new Error("budget decision did not persist"); };
  const rejectedResume = resume.execute("id", { runId, budget: { tokens: { hard: 10 } } });
  const firstProposal = await waitDecision();
  const wrong = await respond.execute("id", { runId, proposalId: "wrong-proposal", approved: true });
  assert.deepEqual((wrong as { details: unknown }).details, { state: "budget_exhausted", approved: false, reason: "proposal_not_pending" });
  const rejected = await respond.execute("id", { runId, proposalId: firstProposal.proposalId, approved: false });
  assert.deepEqual((rejected as { details: unknown }).details, { state: "budget_exhausted", approved: false, reason: "rejected" });
  assert.deepEqual((await rejectedResume as { details: unknown }).details, { state: "budget_exhausted" });
  assert.equal((await store.load()).run.state, "budget_exhausted");
  const approvedResume = resume.execute("id", { runId, budget: { tokens: { hard: 10 } } });
  const secondProposal = await waitDecision();
  const approved = await respond.execute("id", { runId, proposalId: secondProposal.proposalId, approved: true });
  assert.deepEqual((approved as { details: unknown }).details, { state: "running", approved: true, reason: "approved" });
  assert.deepEqual((await approvedResume as { details: unknown }).details, { state: "running" });
  for (let attempt = 0; attempt < 1000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  const loaded = await store.load();
  assert.equal(loaded.run.state, "completed");
  assert.equal(loaded.run.budgetVersion, 2);
  assert.deepEqual(loaded.run.budget, { tokens: { soft: 2, hard: 10 } });
});
