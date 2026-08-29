import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeTestJson, decodeTestJsonRecord, decodeTestRunDetails, decodeTestRunStart, decodeTestToolResult, executeTool, isTestRecord, testExtensionApi, testExtensionContext } from "./support.js";
import { Theme, type InlineExtension, type ThemeColor, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type Static, type TObject, type TOptional, type TString } from "typebox";
import { WORKFLOW_TOOL_DESCRIPTION, WORKFLOW_TOOL_PARAMETERS, WORKFLOW_TOOL_PROMPT_SNIPPET, navigatorAttentionSort } from "../src/host.js";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, defineWorkflowFunction, formatWorkflowPreview, preflight, registerWorkflowExtension, RunStore, structuralPath, WorkflowError, WorkflowRegistry, type AgentOptions, type PersistedRun, type WorkflowExtension, type WorkflowOrchestrationContext } from "../src/index.js";
import { loadingRegistry } from "../src/registry.js";
import type { SessionInput } from "../src/agent-execution.js";
import { listRunIds } from "../src/persistence.js";
import { testTransport, type TestPiSession } from "./test-transport.js";
import { reuseExtension } from "./support.js";

function makeRun(state: PersistedRun["state"]): PersistedRun {
  return { id: "run", workflowName: "test", cwd: "/repo", sessionId: "session", state, agents: [], agentSessions: [] };
}

type NamedCatalogRecord = Record<string, unknown> & { readonly name: string };
type CatalogIndex = { readonly functions: readonly NamedCatalogRecord[]; readonly modelAliasEntries?: readonly NamedCatalogRecord[] };
function isNamedCatalogRecord(value: unknown): value is NamedCatalogRecord {
  return isTestRecord(value) && typeof value.name === "string";
}
function isCatalogIndex(value: unknown): value is CatalogIndex {
  return isTestRecord(value) && Array.isArray(value.functions) && value.functions.every(isNamedCatalogRecord) && (value.modelAliasEntries === undefined || Array.isArray(value.modelAliasEntries) && value.modelAliasEntries.every(isNamedCatalogRecord));
}

void test("orders resolved navigator runs by resolution time descending", () => {
  const entries = [
    { id: "old", loaded: { run: makeRun("completed") }, resolvedAt: 100 },
    { id: "new", loaded: { run: makeRun("failed") }, resolvedAt: 200 },
  ];
  assert.deepEqual(navigatorAttentionSort(entries).map(({ id }) => id), ["new", "old"]);
});

const typeCheckAgentContext = (context: WorkflowOrchestrationContext): void => {
  void context.agent("prompt");
  void context.agent("prompt", { advisor: true, nested: { enabled: true } });
  void context.agent("prompt", { model: "openai/gpt:medium", tools: ["read"] });
  const outputSchema = Type.Object({ answer: Type.String(), count: Type.Integer() });
  const typedResult: Promise<Static<typeof outputSchema>> = context.agent("prompt", { outputSchema, advisor: true, nested: { enabled: true } });
  void typedResult;
  const worktreeResult: Promise<Static<typeof outputSchema>> = context.withWorktree("scope", () => context.agent("prompt", { outputSchema }));
  void worktreeResult;
  const parallelResult: Promise<{ first: Static<typeof outputSchema>; second: number }> = context.parallel("batch", { first: () => context.agent("prompt", { outputSchema }), second: () => 2 });
  void parallelResult;
  const checkpointResult: Promise<boolean> = context.checkpoint({ name: "ship", prompt: "Approve shipment", context: { artifact: "build" } });
  void checkpointResult;
  // @ts-expect-error checkpoint requires a CheckpointInput
  void context.checkpoint("ship");
  // @ts-expect-error checkpoint context must be JSON-compatible
  void context.checkpoint({ name: "ship", prompt: "Approve shipment", context: () => true });
  const pipelineResult: Promise<{ first: string; second: string }> = context.pipeline("format", { first: 1, second: 2 }, { stringify: async (value: number) => `item:${String(value)}` });
  void pipelineResult;
  // @ts-expect-error pipeline stages must accept the item value type
  void context.pipeline("format", { first: 1 }, { stringify: (value: string) => value });
  // @ts-expect-error pipeline stages must produce JSON-compatible values
  void context.pipeline("format", { first: 1 }, { invalid: () => new Date() });
  const pipelineKeyedResult: Promise<{ first: number; second: number }> = context.pipeline("double", { first: 1, second: 2 }, { double: (value: number) => value * 2 });
  void pipelineKeyedResult;
  const inputSchema = Type.Object({ value: Type.String() });
  const functionOutputSchema = Type.Object({ value: Type.String() });
  const typedFunction = defineWorkflowFunction({ description: "typed", input: inputSchema, output: functionOutputSchema, run: async (input) => ({ value: input.value }) });
  const exactRun: (input: Static<typeof inputSchema>) => Promise<Static<typeof functionOutputSchema>> = typedFunction.run;
  void exactRun;
  const typeCheckExtension: WorkflowExtension = { version: "1.0.0", headline: "Typed", functions: { typed: typedFunction } };
  void typeCheckExtension;
  void defineWorkflowFunction({
    description: "wrong output", input: inputSchema, output: functionOutputSchema,
    // @ts-expect-error function output must match its schema
    run: async (input) => ({ value: input.value.length }),
  });
  const options: Readonly<AgentOptions> = { advisor: true };
  void context.agent("prompt", options);
  // @ts-expect-error agent requires a prompt
  void context.agent();
  // @ts-expect-error agent prompt must be a string
  void context.agent(42);
  // @ts-expect-error core agent options must use their declared types
  void context.agent("prompt", { model: 42 });
  // @ts-expect-error extension agent options must be JSON-compatible
  void context.agent("prompt", { advisor: () => true });
  // @ts-expect-error outputSchema must not allow non-JSON extension options
  void context.agent("prompt", { outputSchema, advisor: () => true });
};
void typeCheckAgentContext;
const typeCheckAgentSetupHook: WorkflowExtension = {
  version: "1.0.0",
  headline: "Typed setup hook",
  agentSetupHooks: {
    typed: {
      setup(agent) {
        const model: string | undefined = agent.options.model;
        const tools: string[] | undefined = agent.options.tools;
        const extension: InlineExtension = () => {};
        agent.sessionInput.cwd = "/tmp";
        agent.sessionInput.tools.push("read");
        agent.sessionInput.extensionFactories ??= [];
        agent.sessionInput.extensionFactories.push(extension);
        const customTool: ToolDefinition = { name: "typed", label: "Typed", description: "Typed", parameters: { type: "object" }, async execute() { return { content: [], details: undefined }; } };
        agent.sessionInput.customTools ??= [];
        agent.sessionInput.customTools.push(customTool);
        agent.sessionInput.systemPromptAppend = "append";
        const transport = agent.transport;
        void transport;
        void model;
        void tools;
        // @ts-expect-error extension factories must use Pi's inline extension type
        agent.sessionInput.extensionFactories.push(123);
      },
    },
  },
};
void typeCheckAgentSetupHook;
const typeCheckWorktreeContext = (context: WorkflowOrchestrationContext): void => {
  void context.withWorktree("scope", () => "value");
  // @ts-expect-error withWorktree requires an explicit name
  void context.withWorktree(() => "value");
};
void typeCheckWorktreeContext;

void test("accepts but ignores legacy top-level extension descriptions", () => {
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Legacy metadata", description: "Accepted for compatibility", modelAliases: { reviewer: { resolve: () => "openai/gpt" } } });
  assert.deepEqual(registry.catalog().modelAliasEntries, [{ name: "reviewer", kind: "dynamic", provenance: "extension: Legacy metadata", version: "1.0.0", headline: "Legacy metadata" }]);
});

void test("resolves dynamic model aliases against a launch inventory", async () => {
  const registry = new WorkflowRegistry();
  let calls = 0;
  registry.register({ version: "1.0.0", headline: "Dynamic aliases", modelAliases: { reviewer: { async resolve(context) { calls += 1; assert.equal(context.cwd, "/project"); assert.equal(context.projectTrusted, true); assert.equal(context.rootModel.provider, "openai"); assert.ok(context.availableModels.has("anthropic/opus")); return context.availableModels.has("anthropic/opus") ? "anthropic/opus:high" : "openai/gpt"; } } } });
  const resolved = await registry.resolveModelAliases({ cwd: "/project", projectTrusted: true, rootModel: { provider: "openai", model: "gpt", thinking: "medium" }, knownModels: new Set(["openai/gpt", "anthropic/opus"]), availableModels: new Set(["openai/gpt", "anthropic/opus"]), signal: new AbortController().signal });
  assert.deepEqual(resolved, { reviewer: "anthropic/opus:high" });
  assert.equal(calls, 1);
});
void test("validates Promise.all agent fan-out and allows explicit parallel or shell fan-out", () => {
  const capabilities = { models: new Set<string>(), tools: new Set<string>(), agentTypes: new Set<string>() };
  assert.throws(() => preflight("return Promise.all(items.map(() => agent('work')));", capabilities), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.doesNotThrow(() => preflight("return parallel('items', { first: () => agent('one'), second: () => agent('two') });", capabilities));
  assert.doesNotThrow(() => preflight("return Promise.all(items.map(() => shell('printf ok')));", capabilities));
});
void test("registers and collision-checks latest-attempt actions", () => {
  const registry = new WorkflowRegistry();
  const action = { label: "Inspect", visible: () => true, run: () => undefined };
  registry.register({ version: "1.0.0", headline: "Actions", agentAttemptActions: { inspect: action } });
  assert.equal(registry.agentAttemptActions().inspect, action);
  assert.throws(() => { registry.register({ version: "1.0.0", headline: "Duplicate actions", agentAttemptActions: { inspect: action } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "DUPLICATE_NAME");
});
void test("accepts dynamic aliases with the static hyphenated alias contract", async () => {
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Hyphenated aliases", modelAliases: { "reviewer-model": { resolve: () => "openai/gpt" } } });
  assert.deepEqual(await registry.resolveModelAliases({ cwd: "/project", projectTrusted: false, rootModel: { provider: "openai", model: "gpt" }, knownModels: new Set(["openai/gpt"]), availableModels: new Set(["openai/gpt"]), signal: new AbortController().signal }), { "reviewer-model": "openai/gpt" });
});
void test("catalogs dynamic aliases without executing them and honors settings shadowing", async () => {
  const registry = new WorkflowRegistry();
  let calls = 0;
  registry.register({ version: "1.0.0", headline: "Policy extension", modelAliases: { reviewer: { resolve: async () => { calls += 1; return "openai/gpt"; } } } });
  assert.deepEqual(registry.catalog().modelAliasEntries?.find(({ name, kind }) => name === "reviewer" && kind === "dynamic"), { name: "reviewer", kind: "dynamic", provenance: "extension: Policy extension", version: "1.0.0", headline: "Policy extension" });
  const context = { cwd: "/project", projectTrusted: true, rootModel: { provider: "openai", model: "gpt" }, knownModels: new Set(["openai/gpt"]), availableModels: new Set(["openai/gpt"]), signal: new AbortController().signal };
  assert.deepEqual(await registry.resolveModelAliases(context, new Set(["reviewer"])), {});
  assert.equal(calls, 0);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(registry.resolveModelAliases({ ...context, signal: controller.signal }), (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED" && error.message.includes("Policy extension"));
});
void test("collapses shadowed aliases in the catalog index while retaining full provenance", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-catalog-aliases-"));
  const settingsPath = join(home, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ modelAliases: { "reviewer-model": "static/model" } }));
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Dynamic policy", modelAliases: { "reviewer-model": { resolve: () => "dynamic/model" } } });
  const context = { cwd: home, projectTrusted: false, globalSettingsPath: settingsPath };
  assert.deepEqual(registry.catalog(context).modelAliasEntries, [
    { name: "reviewer-model", kind: "dynamic", provenance: "extension: Dynamic policy", version: "1.0.0", headline: "Dynamic policy" },
    { name: "reviewer-model", kind: "static", provenance: "global settings" },
  ]);
  assert.deepEqual(registry.catalogIndex(context).modelAliasEntries, [{ name: "reviewer-model", kind: "static", provenance: "global settings" }]);
  assert.deepEqual(registry.catalogDetail("reviewer-model", context), { name: "reviewer-model", kind: "static", provenance: "global settings" });
});
void test("rejects duplicate and invalid dynamic alias registrations with extension provenance", async () => {
  const duplicate = new WorkflowRegistry();
  duplicate.register({ version: "1.0.0", headline: "First policy", modelAliases: { reviewer: { resolve: () => "openai/gpt" } } });
  assert.throws(() => { duplicate.register({ version: "1.0.0", headline: "Second policy", modelAliases: { reviewer: { resolve: () => "openai/gpt" } } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "DUPLICATE_NAME");
  const invalid = new WorkflowRegistry();
  invalid.register({ version: "1.0.0", headline: "Invalid policy", modelAliases: { reviewer: { resolve: () => "" } } });
  await assert.rejects(invalid.resolveModelAliases({ cwd: "/project", projectTrusted: false, rootModel: { provider: "openai", model: "gpt" }, knownModels: new Set(["openai/gpt"]), availableModels: new Set(["openai/gpt"]), signal: new AbortController().signal }), (error: unknown) => error instanceof WorkflowError && error.code === "CONFIG_ERROR" && error.message.includes("Invalid policy"));
  const throwing = new WorkflowRegistry();
  throwing.register({ version: "1.0.0", headline: "Throwing policy", modelAliases: { reviewer: { resolve: () => { throw new Error("resolver exploded"); } } } });
  await assert.rejects(throwing.resolveModelAliases({ cwd: "/project", projectTrusted: false, rootModel: { provider: "openai", model: "gpt" }, knownModels: new Set(["openai/gpt"]), availableModels: new Set(["openai/gpt"]), signal: new AbortController().signal }), (error: unknown) => error instanceof WorkflowError && error.code === "CONFIG_ERROR" && error.message.includes("resolver exploded"));
});
void test("attributes dynamic alias cycles to the registering extension", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-alias-cycle-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  registerWorkflowExtension({ version: "1.0.0", headline: "Cycle policy", modelAliases: { first: { resolve: () => "second" }, second: { resolve: () => "first" } } });
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, modelRegistry: { getAll: () => [{ provider: "openai", id: "gpt" }], getAvailable: () => [{ provider: "openai", id: "gpt" }] }, sessionManager: { getSessionId: () => "session" } };
  await assert.rejects(execute("id", { name: "cycle", script: "return true;", foreground: true }, new AbortController().signal, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "CONFIG_ERROR" && error.message.includes("Cycle policy"));
  loadingRegistry().freeze();
});
void test("keeps unavailable role tool warnings out of model context", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-warning-entry-"));
  const agentDir = join(home, "agent");
  const roleDirectory = join(agentDir, "pi-extensible-workflows", "roles");
  mkdirSync(roleDirectory, { recursive: true });
  writeFileSync(join(roleDirectory, "developer.md"), `---\ntools: ["!*", missing_tool]\n---\n`);
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const messages: string[] = [];
  const entries: Array<{ type: string; data: unknown }> = [];
  const pi = testExtensionApi({
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {},
    getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "read"],
    sendMessage(message) { messages.push(message.content); },
  });
  workflowExtension({ ...pi, appendEntry(type, data) { entries.push({ type, data }); } }, home, async () => {}, testTransport(async (): Promise<TestPiSession> => ({
    sessionId: "warning-entry-agent", sessionFile: "/sessions/warning-entry-agent.jsonl",
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    prompt: async () => {}, steer: async () => {}, dispose() {},
  })), agentDir);
  const execute = tools.find(({ name }) => name === "workflow")?.execute;
  assert.ok(execute);
  await execute("warning-entry", { name: "warning-entry", script: `return await agent("work", { role: "developer" });`, foreground: true }, new AbortController().signal, undefined, { cwd: home, model: { provider: "openai", id: "gpt" }, modelRegistry: { getAll: () => [{ provider: "openai", id: "gpt" }], getAvailable: () => [{ provider: "openai", id: "gpt" }] }, sessionManager: { getSessionId: () => "session" } });
  assert.deepEqual(messages, []);
  assert.deepEqual(entries, [{ type: "workflow-warning", data: { message: "Tool not available in this session for role developer: missing_tool. The agent runs without it." } }]);
  loadingRegistry().freeze();
});
const valid = `phase("check"); agent("review", { role: "reviewer" }); agent("custom", { model: "openai/gpt:medium", tools: ["read"] });`;
void test("workflow call preview summarizes inline scripts safely", () => {
  const preview = formatWorkflowPreview({ script: valid, name: "review", description: "Review code" });
  assert.match(preview, /^workflow review\nReview code/m);
  assert.doesNotMatch(preview, /^(Phases|Steps|Agents|Models|Roles|Tools|Extensions):/m);
  assert.equal(formatWorkflowPreview({ scriptPath: "workflow.js", name: "nightly" }), "workflow nightly");
  assert.equal(formatWorkflowPreview({ script: "not javascript", name: "review" }), "workflow review");
});
void test("workflow guidance leads with the inline parallel-to-summary path", () => {
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /named inline/);
  assert.match(WORKFLOW_TOOL_DESCRIPTION, /parallel/);
  assert.match(WORKFLOW_TOOL_PROMPT_SNIPPET, /await.*results.*summarizing agent/);
  assert.match(WORKFLOW_TOOL_PROMPT_SNIPPET, /background by default/);
  assert.match(WORKFLOW_TOOL_PROMPT_SNIPPET, /foreground: true/);
  assert.match(WORKFLOW_TOOL_PROMPT_SNIPPET, /advanced/i);
});

void test("registers the workflow tool, command, and conditional skill", async () => {
  const tools: Array<{ name: string; promptGuidelines?: string[]; promptSnippet?: string; execute: (id?: unknown, params?: unknown, signal?: unknown, update?: unknown, ctx?: unknown) => Promise<unknown> }> = [];
  const commands: Array<{ name: string; options: { handler: (args: string, ctx: unknown) => Promise<void> } }> = [];
  let discover: (() => { skillPaths?: string[] } | undefined) | undefined;
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
    registerCommand(name: string, options: (typeof commands)[number]["options"]) { commands.push({ name, options }); },
    getThinkingLevel() { return "medium" as const; },
    getActiveTools() { return ["read", "workflow"]; },
    on(name: string, candidate: unknown) { if (name === "resources_discover") discover = candidate as typeof discover; },
  };
  workflowExtension(testExtensionApi(pi));
  assert.deepEqual(tools.map(({ name }) => name), ["workflow_respond", "workflow_stop", "workflow_status", "workflow_retry", "workflow_resume", "workflow"]);
  assert.deepEqual(commands.map(({ name }) => name), ["workflow"]);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool);
  assert.equal(tool.promptGuidelines, undefined);
  assert.match(tool.promptSnippet ?? "", /After failure follow-ups.*workflow_status\(\{ runId \}\).*before recovery or replacement work/);
  assert.match(tool.promptSnippet ?? "", /Recovery map: agent\(\.\.\., \{ retries \}\).*workflow_retry\(\{ runId, expectedState\?, foreground\? \}\).*workflow_resume\(\{ runId, expectedState\?, budget\?, foreground\? \}\).*parentRunId/);
  assert.ok(discover);
  assert.ok(discover()?.skillPaths?.some((path) => existsSync(path)));
  const skillPath = discover()?.skillPaths?.find((path) => existsSync(path));
  assert.ok(skillPath);
  assert.ok(existsSync(join(skillPath, "pi-extensible-workflows", "SKILL.md")));
  const skillSource = readFileSync(join(skillPath, "pi-extensible-workflows", "SKILL.md"), "utf8");
  assert.match(skillSource, /Inspect tool `workflow_catalog` result at least once before creating the first workflow for a task/);
  const shellExample = /Example use of `shell`:[\s\S]*?```js\n([\s\S]*?)\n```/.exec(skillSource)?.[1];
  assert.ok(shellExample);
  assert.match(skillSource, /return \{ ok: true \};/);
  assert.doesNotThrow(() => preflight(shellExample, { models: new Set(), tools: new Set(), agentTypes: new Set() }));
  await assert.rejects(tool.execute("id", { script: "return true" }, new AbortController().signal, undefined, { model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.equal("workflow" in WORKFLOW_TOOL_PARAMETERS.properties, false);
  assert.deepEqual(WORKFLOW_TOOL_PARAMETERS.required, ["name"]);
  assert.equal("args" in WORKFLOW_TOOL_PARAMETERS.properties, true);
  await assert.rejects(tool.execute("id", { name: "missing-source" }, new AbortController().signal, undefined, { model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SYNTAX");
  await assert.rejects(tool.execute("id", { name: "both", script: "return true", scriptPath: "missing.js" }, new AbortController().signal, undefined, { model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  await assert.rejects(tool.execute("id", { name: " ", script: "return true" }, new AbortController().signal, undefined, { model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  await assert.rejects(tool.execute("id", { script: "" }, undefined, undefined, { model: undefined }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL");
});
void test("workflow launches from a script file and snapshots its exact source", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-script-file-"));
  const script = "export const meta={name:'file-launch'}; return args.value;\r\n";
  const scriptPath = join(home, "workflow.js");
  writeFileSync(scriptPath, script);
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  await assert.rejects(workflow.execute("missing", { name: "missing-file", scriptPath: "missing.js", foreground: true }, new AbortController().signal, undefined, { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SYNTAX" && error.message.includes("Cannot read workflow script file missing.js"));
  const result = decodeTestToolResult(await workflow.execute("file", { name: "file-launch", scriptPath: "workflow.js", args: { value: "from-file" }, foreground: true }, new AbortController().signal, undefined, { cwd: home, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" } }));
  assert.equal(result.content[0]?.text, '"from-file"');
  writeFileSync(scriptPath, "return 'changed';\n");
  const store = new RunStore(home, "session", decodeTestRunDetails(result.details).runId, home);
  const loaded = await store.load();
  assert.equal(loaded.snapshot.script, script);
  assert.deepEqual(loaded.snapshot.args, { value: "from-file" });
  assert.equal(readFileSync(join(store.directory, "workflow.js"), "utf8"), script);
});
void test("workflow_retry links children, replays parallel branches, inherits budgets, and supports retry chains", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-retry-tool-"));
  let sessions = 0;
  let remainingFailures = 2;
  const createSession = async (): Promise<TestPiSession> => {
    const attempt = ++sessions;
    return { sessionId: `retry-session-${String(attempt)}`, sessionFile: `/sessions/retry-${String(attempt)}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }), prompt: async () => { if (attempt > 1 && remainingFailures > 0) { remainingFailures -= 1; throw new Error("retry source failure"); } }, steer: async () => {}, dispose() {} };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(workflow && retry);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await assert.rejects(workflow.execute("source", { name: "retry-source", script: `return parallel("branches", { good: () => agent("good"), bad: () => agent("bad") });`, budget: { tokens: { hard: 100 } }, foreground: true }, new AbortController().signal, undefined, context), WorkflowError);
  const sourceId = (await listRunIds(home, "session", home))[0];
  assert.ok(sourceId);
  const sourceStore = new RunStore(home, "session", sourceId, home);
  const source = await sourceStore.load();
  assert.equal(source.run.state, "failed");
  const sourceUsage = source.run.usage;
  const firstResult = decodeTestToolResult(await retry.execute("retry", { runId: sourceId, foreground: false }, undefined, undefined, context));
  const firstStarted = decodeTestRunStart(firstResult.content[0]?.text ?? "null");
  assert.equal(firstStarted.parentRunId, sourceId);
  assert.equal(firstStarted.state, "running");
  const loadUntil = async (runId: string, state: PersistedRun["state"]) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const current = (await new RunStore(home, "session", runId, home).load()).run;
      if (current.state === state) return current;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`Timed out waiting for ${runId} to become ${state}`);
  };
  const first = await loadUntil(firstStarted.runId, "failed");
  assert.equal(sessions, 3);
  assert.equal(first.parentRunId, sourceId);
  assert.ok(first.retry);
  assert.equal(first.retry.sourceRunId, sourceId);
  assert.equal(first.retry.lineageRootRunId, sourceId);
  assert.deepEqual(first.retry.completedPaths.length, 1);
  const secondResult = decodeTestToolResult(await retry.execute("retry-again", { runId: firstStarted.runId, foreground: false }, undefined, undefined, context));
  const secondStarted = decodeTestRunStart(secondResult.content[0]?.text ?? "null");
  assert.equal(secondStarted.parentRunId, firstStarted.runId);
  assert.equal(secondStarted.state, "running");
  const second = await loadUntil(secondStarted.runId, "completed");
  assert.equal(sessions, 4);
  assert.ok(second.retry);
  assert.equal(second.retry.sourceRunId, firstStarted.runId);
  assert.equal(second.retry.lineageRootRunId, sourceId);
  assert.deepEqual(second.retry.completedPaths.length, 1);
  assert.equal(second.usage?.agentLaunches, (sourceUsage?.agentLaunches ?? 0) + 2);
  assert.deepEqual(second.budget, source.run.budget);
  assert.deepEqual((await sourceStore.load()).run.usage, sourceUsage);
  assert.equal((await sourceStore.load()).run.state, "failed");
});
void test("failed retry children retain inherited and newly created named worktrees without duplicates", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-retry-named-union-"));
  const cwd = join(home, "repo");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "test"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  writeFileSync(join(cwd, "tracked.txt"), "tracked");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "initial"]);
  const script = `return parallel("named", { inherited: () => withWorktree("inherited", async () => agent("inherited")), fresh: () => withWorktree("fresh", async () => agent("fresh")) });`;
  const snapshot = createLaunchSnapshot({ script, args: null, metadata: { name: "named-retry", description: "named retry" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: ["agent"], agentTypes: [], roles: {}, schemas: [] });
  const root = new RunStore(cwd, "session", "root", home);
  await root.create({ id: "root", workflowName: "named-retry", cwd, sessionId: "session", state: "failed", agents: [], agentSessions: [] }, snapshot);
  const inheritedOwner = structuralPath("worktree", "named", "inherited");
  await root.worktree(inheritedOwner);
  const source = new RunStore(cwd, "session", "source", home);
  await source.create({ id: "source", workflowName: "named-retry", cwd, sessionId: "session", state: "failed", parentRunId: "root", retry: { sourceRunId: "root", lineageRootRunId: "root", completedPaths: [], incompletePaths: [], namedWorktrees: ["inherited"] }, agents: [], agentSessions: [] }, snapshot);
  await source.worktree(inheritedOwner);
  await source.worktree(structuralPath("worktree", "named", "fresh"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const createSession = async (input: SessionInput): Promise<TestPiSession> => ({
    sessionId: input.sessionLabel, sessionFile: `/sessions/${input.sessionLabel}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {},
  });
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["agent", "workflow"] }), home, async () => {}, testTransport(createSession));
  const retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(retry);
  const context = { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const started = decodeTestToolResult(await retry.execute("retry-named-union", { runId: "source", foreground: false }, undefined, undefined, context));
  const childId = decodeTestRunStart(started.content[0]?.text ?? "null").runId;
  let child: PersistedRun | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    child = (await new RunStore(cwd, "session", childId, home).load()).run;
    if (child.state === "completed" || child.state === "failed") break;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(child?.state, "completed");
  assert.deepEqual(child.retry?.namedWorktrees, ["inherited", "fresh"]);
});
void test("workflow_retry rejects concurrent children for one mutable retry lineage", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-retry-concurrency-"));
  let sessions = 0;
  let entered!: () => void;
  let release!: () => void;
  const childEntered = new Promise<void>((resolve) => { entered = resolve; });
  const childRelease = new Promise<void>((resolve) => { release = resolve; });
  const createSession = async (): Promise<TestPiSession> => {
    const attempt = ++sessions;
    return { sessionId: `retry-concurrent-${String(attempt)}`, sessionFile: `/sessions/retry-concurrent-${String(attempt)}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => { if (attempt === 1) throw new Error("source failure"); if (attempt === 2) { entered(); await childRelease; } }, steer: async () => {}, dispose() {} };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(workflow && retry);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await assert.rejects(workflow.execute("source", { name: "concurrent-source", script: `return agent("work");`, foreground: true }, new AbortController().signal, undefined, context), WorkflowError);
  const sourceId = (await listRunIds(home, "session", home))[0];
  assert.ok(sourceId);
  const started = decodeTestToolResult(await retry.execute("retry", { runId: sourceId, foreground: false }, undefined, undefined, context));
  const childId = decodeTestRunStart(started.content[0]?.text ?? "null").runId;
  await childEntered;
  await assert.rejects(retry.execute("retry-again", { runId: sourceId, foreground: false }, undefined, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  release();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const child = (await new RunStore(home, "session", childId, home).load()).run;
    if (child.state === "completed") return;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the retry child to complete");
});
void test("workflow_retry cleans up child startup when dynamic alias resolution fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-retry-alias-failure-"));
  let resolverCalls = 0;
  let sessions = 0;
  const createSession = async (): Promise<TestPiSession> => ({
    sessionId: `retry-alias-${String(++sessions)}`, sessionFile: `/sessions/retry-alias-${String(sessions)}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => { if (sessions === 1) throw new Error("source failure"); }, steer: async () => {}, dispose() {},
  });
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  registerWorkflowExtension({ version: "1.0.0", headline: "Retry policy", modelAliases: { "retry-model": { resolve: () => { resolverCalls += 1; if (resolverCalls === 2) throw new Error("retry resolver failure"); return "openai/gpt"; } } } });
  const workflow = tools.find(({ name }) => name === "workflow");
  const retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(workflow && retry);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await assert.rejects(workflow.execute("source", { name: "retry-alias-source", script: `return agent("work", { model: "retry-model" });`, foreground: true }, new AbortController().signal, undefined, context), WorkflowError);
  const sourceId = (await listRunIds(home, "session", home))[0];
  assert.ok(sourceId);
  await assert.rejects(retry.execute("retry-fails", { runId: sourceId, foreground: false }, undefined, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "CONFIG_ERROR");
  assert.equal(resolverCalls, 2);
  assert.deepEqual(await listRunIds(home, "session", home), [sourceId]);
  const started = decodeTestToolResult(await retry.execute("retry-succeeds", { runId: sourceId, foreground: false }, undefined, undefined, context));
  const childId = decodeTestRunStart(started.content[0]?.text ?? "null").runId;
  assert.equal(resolverCalls, 3);
  assert.notEqual(childId, sourceId);
  loadingRegistry().freeze();
});
void test("workflow_retry blocks removed dynamic aliases from native bare-model fallback", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-retry-removed-alias-"));
  const script = `return await agent("retry", { model: "gpt" });`;
  const aliases = { gpt: "openai/gpt" };
  const snapshot = createLaunchSnapshot({ script, args: null, metadata: { name: "removed-alias" }, settings: { concurrency: 1, modelAliases: aliases }, modelAliases: aliases, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] });
  const source = new RunStore(home, "session", "source", home);
  await source.create({ id: "source", workflowName: "removed-alias", cwd: home, sessionId: "session", state: "failed", agents: [], agentSessions: [], error: { code: "AGENT_FAILED", message: "source failure" } }, snapshot);
  let sessions = 0;
  const createSession = async (): Promise<TestPiSession> => {
    sessions += 1;
    return { sessionId: `retry-removed-${String(sessions)}`, sessionFile: `/sessions/retry-removed-${String(sessions)}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {} };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, undefined, testTransport(createSession));
  const retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(retry);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, modelRegistry: { getAll: () => [{ provider: "openai", id: "gpt" }], getAvailable: () => [{ provider: "openai", id: "gpt" }] }, sessionManager: { getSessionId: () => "session" } };
  const started = decodeTestToolResult(await retry.execute("retry", { runId: "source" }, new AbortController().signal, undefined, context));
  const childId = decodeTestRunStart(started.content[0]?.text ?? "null").runId;
  let child: PersistedRun | undefined;
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    child = (await new RunStore(home, "session", childId, home).load()).run;
    if (child.state === "failed" && child.error) break;
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  assert.ok(child);
  assert.ok(child.error);
  assert.equal(child.state, "failed");
  assert.equal(child.error.code, "UNKNOWN_MODEL");
  assert.match(child.error.message, /Unknown model alias gpt resolved to openai\/gpt/);
  loadingRegistry().freeze();
});
void test("workflow_retry rejects unsupported states, routes cross-wired recovery tools, and rejects incompatible snapshots", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-retry-compatibility-"));
  const launch = createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "retry-compatibility" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] });
  const createRun = async (id: string, state: PersistedRun["state"], cwd = home, sessionId = "session") => {
    mkdirSync(cwd, { recursive: true });
    const store = new RunStore(cwd, sessionId, id, home);
    await store.create({ id, workflowName: "retry-compatibility", cwd, sessionId, state, agents: [], agentSessions: [] }, launch);
    return store;
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  const retry = tools.find(({ name }) => name === "workflow_retry");
  const resume = tools.find(({ name }) => name === "workflow_resume");
  assert.ok(retry && resume);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await createRun("expected-retry-state", "completed");
  await assert.rejects(retry.execute("retry-expected-state", { runId: "expected-retry-state", expectedState: "failed" }, undefined, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE" && error.message.includes("expected state failed"));
  await createRun("expected-resume-state", "failed");
  await assert.rejects(resume.execute("resume-expected-state", { runId: "expected-resume-state", expectedState: "budget_exhausted" }, undefined, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE" && error.message.includes("expected state budget_exhausted"));
  for (const [index, state] of (["completed", "stopped", "interrupted", "running", "budget_exhausted"] as const).entries()) {
    await createRun(`unsupported-${String(index)}`, state);
    await assert.rejects(retry.execute("retry", { runId: `unsupported-${String(index)}` }, undefined, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE" && (state === "budget_exhausted" ? error.message.includes("workflow_resume({ runId, budget? })") : error.message.toLowerCase().includes(state.replace("_", "-"))));
  }
  await createRun("failed", "failed");
  await assert.rejects(resume.execute("resume-failed", { runId: "failed" }, undefined, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE" && error.message.includes("workflow_retry({ runId })"));
  await assert.rejects(retry.execute("missing", { runId: "missing" }, undefined, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  await createRun("foreign-session", "failed", home, "other-session");
  await assert.rejects(retry.execute("foreign-session", { runId: "foreign-session" }, undefined, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  await createRun("foreign-project", "failed", join(home, "other-project"));
  await assert.rejects(retry.execute("foreign-project", { runId: "foreign-project" }, undefined, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
  const incompatible = await createRun("incompatible", "failed");
  await incompatible.saveSnapshot({ ...launch, identityVersion: 999 });
  await assert.rejects(retry.execute("incompatible", { runId: "incompatible" }, undefined, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
});
void test("probes optional Pi host capabilities while preserving model registry fallbacks", async () => {
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-host-capabilities-"));
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {} }), home);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool);
  const result = await tool.execute("id", { name: "capabilities", script: "return true;", foreground: true }, new AbortController().signal, undefined, { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt" }] }, sessionManager: { getSessionId: () => "session" } });
  assert.equal(result.content[0]?.text, "true");
  assert.match(result.content[1]?.text ?? "", /^Workflow run ID: [0-9a-f-]+$/);
});
void test("registers workflow_catalog only for active non-empty registries", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-catalog-settings-"));
  try {
    const empty = new WorkflowRegistry();
    assert.deepEqual(empty.catalog(), { functions: [] });
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
  const inactiveHome = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-catalog-inactive-"));
  const inactiveTools: Array<{ name: string }> = [];
  let inactiveStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let inactiveShutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool(tool: { name: string }) { inactiveTools.push(tool); }, registerCommand() {}, getActiveTools: () => ["read"], on(name: string, handler: unknown) { if (name === "session_start") inactiveStart = handler as typeof inactiveStart; if (name === "session_shutdown") inactiveShutdown = handler as typeof inactiveShutdown; } }), inactiveHome);
  assert.ok(inactiveStart && inactiveShutdown);
  await inactiveStart({}, { cwd: inactiveHome, sessionManager: { getSessionId: () => "inactive" } });
  assert.equal(inactiveTools.some(({ name }) => name === "workflow_catalog"), false);
  await inactiveShutdown();
  const activeHome = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-catalog-active-"));
  mkdirSync(join(activeHome, ".pi", "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(activeHome, ".pi", "pi-extensible-workflows", "settings.json"), JSON.stringify({ modelAliases: { "project-only": "openai/gpt" } }));
  type CatalogParameters = TObject<{ name: TOptional<TString> }>;
  type CatalogTool = ToolDefinition<CatalogParameters>;
  type CatalogCallRenderer = NonNullable<CatalogTool["renderCall"]>;
  type CatalogResultRenderer = NonNullable<CatalogTool["renderResult"]>;
  type CatalogRenderResult = Parameters<CatalogResultRenderer>[0];
  type CatalogRenderOptions = Parameters<CatalogResultRenderer>[1];
  type CatalogCallContext = Parameters<CatalogCallRenderer>[2];
  const activeTools: CatalogTool[] = [];
  let activeStart: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let activeShutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof activeTools)[number]) { activeTools.push(tool); }, registerCommand() {}, getActiveTools: () => ["workflow"], on(name: string, handler: unknown) { if (name === "session_start") activeStart = handler as typeof activeStart; if (name === "session_shutdown") activeShutdown = handler as typeof activeShutdown; } }), activeHome);
  registerWorkflowExtension({ ...reuseExtension, modelAliases: { "project-only": { resolve: () => "dynamic/model" } } });
  assert.ok(activeStart && activeShutdown);
  assert.equal(activeTools.filter(({ name }) => name === "workflow_catalog").length, 0);
  const activeContext = { cwd: activeHome, sessionManager: { getSessionId: () => "active" } };
  await activeStart({}, activeContext);
  await activeStart({}, activeContext);
  assert.equal(activeTools.filter(({ name }) => name === "workflow_catalog").length, 1);
  assert.throws(() => { registerWorkflowExtension({ version: "1.0.0", headline: "Late", functions: { x: { description: "x", input: { type: "object" }, output: { type: "string" }, run: () => "x" } } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "REGISTRY_FROZEN");
  const catalogTool = activeTools.find(({ name }) => name === "workflow_catalog");
  assert.ok(catalogTool);
  const executeCatalog = async (name?: string) => decodeTestToolResult(await executeTool(catalogTool, "catalog", name === undefined ? {} : { name }, testExtensionContext));
  const catalog = decodeTestJson((await executeCatalog()).content[0]?.text ?? "null", isCatalogIndex);
  assert.deepEqual(catalog.functions.map(({ name }) => ({ name })), [{ name: "hello" }, { name: "inspect" }]);
  assert.deepEqual(catalog.modelAliasEntries?.find(({ name }) => name === "project-only"), { name: "project-only", kind: "static", provenance: "trusted project settings" });
  assert.doesNotMatch(JSON.stringify(catalog), /openai\/gpt/);
  assert.deepEqual(Object.keys(catalog.functions[0] ?? {}).sort(), ["description", "input", "name"]);
  assert.doesNotMatch(JSON.stringify(catalog), /"output"|"headline"|"version"|"script"|"run"|"resolve"|"source"|"main"|"ok"/);
  const functionDetail = decodeTestJsonRecord((await executeCatalog("hello")).content[0]?.text ?? "null");
  assert.deepEqual(Object.keys(functionDetail).sort(), ["description", "headline", "input", "name", "output", "version"]);
  assert.deepEqual(functionDetail.output, { type: "string" });
  const aliasDetail = decodeTestJsonRecord((await executeCatalog("project-only")).content[0]?.text ?? "null");
  assert.deepEqual(aliasDetail, { name: "project-only", kind: "static", provenance: "trusted project settings" });
  const missing = decodeTestJsonRecord((await executeCatalog("missing")).content[0]?.text ?? "null");
  if (!isTestRecord(missing.error) || typeof missing.error.code !== "string" || typeof missing.error.name !== "string" || typeof missing.error.message !== "string") throw new Error("Catalog error result was malformed");
  assert.deepEqual(missing.error, { code: "NOT_FOUND", name: "missing", message: "No registered workflow function is available: missing" });
  const makeCatalogResult = (value: unknown): CatalogRenderResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], details: value });
  const makeCatalogRenderOptions = (expanded: boolean): CatalogRenderOptions => ({ expanded, isPartial: false });
  const makeCatalogContext = (name: string | undefined, expanded: boolean): CatalogCallContext => ({
    args: name === undefined ? {} : { name },
    toolCallId: "catalog",
    invalidate: () => {},
    lastComponent: undefined,
    state: {},
    cwd: activeHome,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded,
    showImages: false,
    isError: false,
  });
  const themeColors = {
    accent: "", border: "", borderAccent: "", borderMuted: "", success: "", error: "", warning: "", muted: "", dim: "", text: "",
    thinkingText: "", userMessageText: "", customMessageText: "", customMessageLabel: "", toolTitle: "", toolOutput: "", mdHeading: "", mdLink: "",
    mdLinkUrl: "", mdCode: "", mdCodeBlock: "", mdCodeBlockBorder: "", mdQuote: "", mdQuoteBorder: "", mdHr: "", mdListBullet: "",
    toolDiffAdded: "", toolDiffRemoved: "", toolDiffContext: "", syntaxComment: "", syntaxKeyword: "", syntaxFunction: "", syntaxVariable: "",
    syntaxString: "", syntaxNumber: "", syntaxType: "", syntaxOperator: "", syntaxPunctuation: "", thinkingOff: "", thinkingMinimal: "",
    thinkingLow: "", thinkingMedium: "", thinkingHigh: "", thinkingXhigh: "", thinkingMax: "", bashMode: "",
  } satisfies Record<ThemeColor, string>;
  const themeBackgrounds = { selectedBg: "", userMessageBg: "", customMessageBg: "", toolPendingBg: "", toolSuccessBg: "", toolErrorBg: "" };
  const makeTheme = (fg: (color: ThemeColor, text: string) => string, bold: (text: string) => string): Parameters<CatalogCallRenderer>[1] => {
    const value = new Theme(themeColors, themeBackgrounds, "truecolor");
    value.fg = fg;
    value.bold = bold;
    return value;
  };
  const theme = makeTheme((color, text) => `[${color}]${text}[/${color}]`, (text) => `<bold>${text}</bold>`);
  const ansiTheme = makeTheme((color, text) => `\u001b[${color === "error" ? "31" : "36"}m${text}\u001b[0m`, (text) => `\u001b[1m${text}\u001b[0m`);
  const stripAnsi = (value: string): string => value.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g"), "");
  const renderCatalog = (value: unknown, expanded: boolean, name?: string, renderTheme = theme, width = 120) => {
    const renderResult = catalogTool.renderResult;
    assert.ok(renderResult);
    const component = renderResult(makeCatalogResult(value), makeCatalogRenderOptions(expanded), renderTheme, makeCatalogContext(name, expanded));
    return component.render(width).join("\n");
  };
  const indexView = renderCatalog(catalog, false);
  assert.match(indexView, /\[accent\].*Functions \(2\)/);
  assert.match(indexView, /hello.*Say hello/);
  assert.doesNotMatch(indexView, /"properties"/);
  const aliasIndexView = renderCatalog({ ...catalog, modelAliasEntries: [{ name: "developer-model", kind: "static", provenance: "settings" }] }, false);
  assert.match(aliasIndexView, /Model aliases \(1\)/);
  assert.match(aliasIndexView, /developer-model.*static · settings/);
  const compactDetail = renderCatalog(functionDetail, false, "hello");
  assert.match(compactDetail, /Function/);
  assert.match(compactDetail, /hello.*Say hello/);
  assert.match(compactDetail, /version.*1\.0\.0/);
  assert.match(compactDetail, /headline.*Reusable/);
  assert.doesNotMatch(compactDetail, /"properties"/);
  const expandedDetail = renderCatalog(functionDetail, true, "hello");
  assert.match(expandedDetail, /headline.*Reusable/);
  assert.match(expandedDetail, /"properties"/);
  assert.match(expandedDetail, /Output schema/);
  const missingView = renderCatalog(missing, false, "missing");
  assert.match(missingView, /No registered workflow function is available: missing/);
  const narrowFunctionDetail = {
    ...functionDetail,
    description: "A_DESCRIPTION_THAT_MUST_REMAIN_VISIBLE",
    headline: "A_HEADLINE_THAT_MUST_REMAIN_VISIBLE",
    input: { type: "object", properties: { detail: { type: "string", description: "THIS_TEXT_MUST_REMAIN_VISIBLE_WHEN_EXPANDED" } } },
    output: { type: "string", description: "OUTPUT_DESCRIPTION_MUST_REMAIN_VISIBLE" },
  };
  const narrowExpanded = renderCatalog(narrowFunctionDetail, true, "hello", ansiTheme, 24);
  const narrowVisible = stripAnsi(narrowExpanded).replace(/\s+/g, "");
  assert.match(narrowVisible, /THIS_TEXT_MUST_REMAIN_VISIBLE_WHEN_EXPANDED/);
  assert.match(narrowVisible, /A_HEADLINE_THAT_MUST_REMAIN_VISIBLE/);
  assert.match(narrowVisible, /OUTPUT_DESCRIPTION_MUST_REMAIN_VISIBLE/);
  for (const line of narrowExpanded.split("\n")) assert.ok(stripAnsi(line).length <= 24, `rendered line exceeds width: ${line}`);
  const renderCall = catalogTool.renderCall;
  assert.ok(renderCall);
  const narrowCall = renderCall({ name: "hello" }, makeTheme((color, text) => `\u001b[38;2;21;${color === "accent" ? "101" : "201"};${color === "toolTitle" ? "201" : "101"}m${text}\u001b[0m`, (text) => `\u001b[1m${text}\u001b[0m`), makeCatalogContext("hello", false)).render(10);
  assert.equal(narrowCall.length, 1);
  assert.ok(narrowCall[0]);
  assert.doesNotMatch(narrowCall[0], new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[^0-9;m]`));
  assert.ok(stripAnsi(narrowCall[0]).length <= 10);
  await activeShutdown();
});
void test("workflow control tools render styled calls and compact or expanded results", () => {
  type Rendered = { render: (width: number) => string[] };
  type ControlTool = { name: string; renderCall?: (args: unknown, theme: unknown, context: unknown) => Rendered; renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => Rendered };
  const tools: ControlTool[] = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }));
  const theme = { fg: (color: string, text: string) => `[${color}]${text}[/${color}]`, bold: (text: string) => `<bold>${text}</bold>` };
  const cases = [
    { name: "workflow_respond", args: { runId: "run-checkpoint", name: "approval", approved: true }, details: { accepted: true, state: "checkpoint_answered", approved: true, reason: "checkpoint" }, identifier: "approval", expectedAction: "approved" },
    { name: "workflow_stop", args: { runId: "run-stop" }, details: { runId: "run-stop", state: "stopped", stopped: true }, identifier: "run-stop", expectedAction: "stopped" },
    { name: "workflow_retry", args: { runId: "run-failed" }, details: { runId: "run-retry", parentRunId: "run-failed", state: "running" }, identifier: "run-retry", expectedAction: "started" },
    { name: "workflow_status", args: { runId: "run-status" }, details: { runId: "run-status", workflowName: "status", state: "failed", agents: [] }, identifier: "run-status", expectedAction: "failed" },
    { name: "workflow_retry", args: { runId: "run-failed" }, details: { runId: "run-retry", parentRunId: "run-failed", state: "completed", value: true }, identifier: "run-retry", expectedAction: "completed" },
    { name: "workflow_resume", args: { runId: "run-budget", budget: { tokens: { hard: 10 } } }, details: { state: "awaiting_approval", proposalId: "proposal-1" }, identifier: "proposal-1", expectedAction: "approval required" },
    { name: "workflow_resume", args: { runId: "run-budget" }, details: { state: "completed", value: true }, identifier: "run-budget", expectedAction: "completed" },
  ] as const;
  for (const entry of cases) {
    const tool = tools.find(({ name }) => name === entry.name);
    assert.ok(tool);
    assert.ok(tool.renderCall);
    assert.ok(tool.renderResult);
    const context = { args: entry.args, lastComponent: undefined, state: {}, cwd: "/project", expanded: false, isPartial: false };
    const call = tool.renderCall(entry.args, theme, context).render(120).join("\n");
    assert.match(call, new RegExp(entry.name));
    assert.match(call, new RegExp(entry.args.runId));
    const renderResult = (expanded: boolean): string => tool.renderResult?.({ content: [{ type: "text", text: JSON.stringify(entry.details) }], details: entry.details }, { expanded, isPartial: false }, theme, { ...context, expanded }).render(120).join("\n") ?? "";
    const compact = renderResult(false);
    const expanded = renderResult(true);
    assert.match(compact, new RegExp(entry.identifier));
    assert.match(expanded, new RegExp(entry.identifier));
    assert.match(compact, new RegExp(entry.expectedAction));
    assert.match(expanded, /Action|State|Run/);
    assert.doesNotMatch(compact, /"runId"|"proposalId"|"hard"/);
    if (entry.name === "workflow_resume" && "budget" in entry.args) {
      assert.match(call, /tokens hard=10/);
      assert.match(expanded, /Budget patch/);
    }
  }
});
void test("workflow control tools show error content for failed executions", () => {
  type Rendered = { render: (width: number) => string[] };
  type ControlTool = { name: string; renderResult?: (result: unknown, options: unknown, theme: unknown, context: unknown) => Rendered };
  const tools: ControlTool[] = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }));
  const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
  const errorText = "Control operation failed: unknown run";
  for (const name of ["workflow_respond", "workflow_stop", "workflow_status", "workflow_retry", "workflow_resume"]) {
    const tool = tools.find((candidate) => candidate.name === name);
    assert.ok(tool?.renderResult);
    const args = name === "workflow_respond" ? { runId: "run-error", name: "approval", approved: false } : { runId: "run-error" };
    const rendered = tool.renderResult({ content: [{ type: "text", text: errorText }], details: {} }, { expanded: false, isPartial: false }, theme, { args, lastComponent: undefined, state: {}, cwd: "/project", expanded: false, isPartial: false, isError: true }).render(120).join("\n");
    assert.match(rendered, new RegExp(errorText));
  }
});

void test("keeps the five workflow controls behind a private local registration factory", () => {
  const sourceUrl = [new URL("../src/host.ts", import.meta.url), new URL("../../src/host.ts", import.meta.url)].find((url) => existsSync(url));
  assert.ok(sourceUrl);
  const source = readFileSync(sourceUrl, "utf8");
  const extensionStart = source.indexOf("export default function workflowExtension");
  const factoryStart = source.indexOf("const registerControlTool");
  assert.ok(extensionStart >= 0 && factoryStart > extensionStart);
  assert.doesNotMatch(source, /export\s+(?:const|function)\s+registerControlTool/);
  assert.match(source, /const registerControlTool\s*=\s*<P extends TSchema>\s*\(/);
  assert.match(source, /run:\s*\(params: Static<P>, signal: AbortSignal, ctx: unknown\)/);

  const controlMatches = [...source.matchAll(/\bregisterControlTool\s*\(\s*["']([^"']+)["']/g)];
  const controlCalls = controlMatches.map((match) => match[1]);
  assert.deepEqual(controlCalls, ["workflow_respond", "workflow_stop", "workflow_status", "workflow_retry", "workflow_resume"]);

  const firstControlCall = controlMatches[0]?.index ?? -1;
  assert.ok(firstControlCall > factoryStart);
  const factory = source.slice(factoryStart, firstControlCall);
  assert.match(factory, /const result = await run\(params, signal, ctx\)/);
  assert.match(factory, /return \{ content: \[\{ type: "text" as const, text: result\.text \}\], details: result\.details \}/);
  assert.match(factory, /throw mainAgentError\(error\)/);
  assert.match(factory, /styledTextBlock\(workflowControlCall\(name, args, theme\)\)/);
  assert.match(factory, /workflowCatalogBlock\(workflowControlResult\(name, context.args, result, options.expanded, theme, context.isError\), options.expanded\)/);
});
