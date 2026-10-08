import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import workflowExtension, { registerWorkflowExtension } from "../src/index.js";
import { loadingRegistry } from "../src/registry.js";
import { FairAgentScheduler, WorkflowAgentExecutor, createLocalPiSession, localAgentTransport, prepareAgentSetupForInspection, type AgentExecutionOptions, type AgentExecutionRoot, type SessionInput } from "../src/agent-execution.js";
import { extensionIdentity } from "../src/paths.js";
import { validateAgentOptions } from "../src/validation.js";
import { RunStore, decodePreparedAgentConfiguration, listRunIds } from "../src/persistence.js";
import { createLaunchSnapshot } from "../src/utils.js";
import { WorkflowError, type AgentTransport, type JsonValue } from "../src/types.js";
import { testExtensionApi } from "./support.js";
import { testTransport } from "./test-transport.js";

type ProviderRequest = { readonly task: string; readonly system: string; readonly tools: readonly string[] };
type Fixture = { readonly root: AgentExecutionRoot; readonly agentDir: string; readonly cwd: string; readonly dynamicExtension: string; readonly requests: ProviderRequest[] };
const inspectionTransport: AgentTransport = { id: "test", async createSession() { throw new Error("inspection must not spawn"); } };
const GENERATED = "GENERATED_SKILL_MARKER";
const STATIC = "STATIC_SKILL_MARKER";

function skill(directory: string, name: string, marker: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: ${marker}\n---\nfixture`);
}
function text(content: unknown): string { return typeof content === "string" ? content : JSON.stringify(content ?? ""); }
function sse(response: import("node:http").ServerResponse, delta: Record<string, unknown>, finish: string): void {
  response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
  const chunk = (choice: Record<string, unknown>) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture-model", choices: [choice] })}\n\n`;
  response.end(`${chunk({ index: 0, delta, finish_reason: null })}${chunk({ index: 0, delta: {}, finish_reason: finish })}data: [DONE]\n\n`);
}
let callId = 0;
function toolCall(response: import("node:http").ServerResponse, name: string, args: unknown): void {
  sse(response, { role: "assistant", tool_calls: [{ index: 0, id: `call-${String(++callId)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
}
/** Local OpenAI-compatible provider: records the system prompt Pi actually sends and drives parent/child tool calls. */
function provider(requests: ProviderRequest[], childOptions: () => Record<string, JsonValue>): Server {
  return createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body) as { messages: Array<{ role: string; content?: unknown; tool_calls?: Array<{ function: { name: string } }> }>; tools?: Array<{ function?: { name?: string } }> };
      const messages = payload.messages;
      const task = text(messages.find(({ role }) => role === "user")?.content);
      const last = messages.at(-1);
      if (last?.role === "user") {
        requests.push({ task, system: text(messages.find(({ role }) => role === "system" || role === "developer")?.content), tools: (payload.tools ?? []).map((tool) => tool.function?.name ?? "").sort() });
        if (task.includes("PARENT_TASK")) { toolCall(response, "agent", { prompt: "CHILD_TASK", label: "child", ...childOptions() }); return; }
        toolCall(response, "workflow_result", { result: "ok" }); return;
      }
      const previous = [...messages].reverse().find((message) => message.role === "assistant" && message.tool_calls)?.tool_calls?.at(-1)?.function.name;
      if (previous === "agent") { toolCall(response, "get_subagent_result", { id: /"id":"([^"]+)"/.exec(text(last?.content).replaceAll("\\\"", "\""))?.[1] ?? "" }); return; }
      if (previous === "get_subagent_result") { toolCall(response, "workflow_result", { result: text(last?.content).slice(0, 400) }); return; }
      sse(response, { role: "assistant", content: "done" }, "stop");
    });
  });
}
async function fixture(t: TestContext, childOptions: () => Record<string, JsonValue> = () => ({})): Promise<Fixture> {
  const directory = mkdtempSync(join(tmpdir(), "workflow-resource-parity-"));
  const cwd = join(directory, "project");
  const agentDir = join(directory, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(agentDir, "extensions"), { recursive: true });
  const generatedDirectory = join(directory, "generated", "generated-skill");
  skill(generatedDirectory, "generated-skill", GENERATED);
  skill(join(agentDir, "skills", "static-skill"), "static-skill", STATIC);
  const dynamicExtension = join(agentDir, "extensions", "dynamic.js");
  writeFileSync(dynamicExtension, `export default (pi) => { pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(generatedDirectory)}] })); };`);
  const requests: ProviderRequest[] = [];
  const server = provider(requests, childOptions);
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id: "fixture-model", name: "fixture", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1_000 }] } } }));
  writeFileSync(join(agentDir, "auth.json"), "{}");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  const root: AgentExecutionRoot = { cwd, agentDir, projectTrusted: false, model: { provider: "fixture", model: "fixture-model" }, tools: new Set(["read", "write"]), knownModels: new Set(["fixture/fixture-model"]), availableModels: new Set(["fixture/fixture-model"]) };
  return { root, agentDir, cwd, dynamicExtension, requests };
}
const run = (agentOptions: Record<string, JsonValue>, extra: Partial<AgentExecutionOptions> = {}): AgentExecutionOptions => ({ label: "root", workflowName: "parity", agentOptions, ...extra });

void test("excludeTools accepts only exact tool names and never the result tool", () => {
  assert.deepEqual(validateAgentOptions({ excludeTools: ["write"] }), { excludeTools: ["write"] });
  for (const excludeTools of ["write", [""], [" write"], ["!write"], ["wr*"], [42], ["workflow_result"]] as JsonValue[]) {
    assert.throws(() => validateAgentOptions({ excludeTools }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA", JSON.stringify(excludeTools));
  }
});

void test("excludeTools is a terminal negative layer after preparation hooks and setup cannot restore it", async (t) => {
  const { root } = await fixture(t);
  const restored: string[][] = [];
  const prepared = await prepareAgentSetupForInspection({ ...root, agentPreparationHooks: [{ name: "plugin", priority: 0, prepare(configuration) { configuration.tools = ["read", "write"]; } }], agentSetupHooks: [{ name: "restore", priority: 0, setup(agent) { restored.push([...agent.sessionInput.tools]); agent.sessionInput.tools = [...agent.sessionInput.tools, "write"]; } }] }, "task", run({ excludeTools: ["write"] }), inspectionTransport);
  assert.deepEqual(restored, [["read"]]);
  assert.ok(prepared.failure?.error instanceof WorkflowError && prepared.failure.error.code === "UNKNOWN_TOOL");
  const configuration = await new WorkflowAgentExecutor(root).prepare(run({ excludeTools: ["write", "missing"] }));
  assert.deepEqual(configuration.tools, ["read"]);
});

void test("a parent's excludeTools bounds nested children", async (t) => {
  const { root } = await fixture(t);
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let shutdown: (() => Promise<void>) | undefined;
  const sessions: string[][] = [];
  const children: unknown[] = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getActiveTools: () => ["agent", "read", "write"] }), root.cwd, async () => {}, testTransport(async (input) => {
    sessions.push([...input.tools]);
    return {
      sessionId: `session-${String(sessions.length)}`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      async prompt() {
        if (!input.sessionLabel.includes(":parent:")) return;
        const agent = input.customTools?.find(({ name }) => name === "agent");
        const result = input.customTools?.find(({ name }) => name === "get_subagent_result");
        assert.ok(agent && result);
        for (const requested of [["!*", "write"], ["!*", "read"]]) {
          const spawned = await agent.execute("spawn", { prompt: "child", label: `child-${requested.join()}`, tools: requested }, new AbortController().signal, undefined, undefined as never);
          children.push((await result.execute("collect", spawned.details, new AbortController().signal, undefined, undefined as never)).details);
        }
      },
      dispose() {},
    };
  }), root.agentDir);
  t.after(async () => { await shutdown?.(); });
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  await workflow.execute("call", { name: "exclude", script: 'return agent("parent", { label: "parent", excludeTools: ["write"] });', foreground: true }, new AbortController().signal, undefined, { cwd: root.cwd, hasUI: false, model: { provider: "fixture", id: "fixture-model" }, sessionManager: { getSessionId: () => "session" } });
  assert.deepEqual(sessions[0], ["agent", "read"]);
  assert.deepEqual(sessions.slice(1), [["read"]], "the write child must fail before a session is created");
  assert.match(JSON.stringify(children[0]), /UNKNOWN_TOOL/);
});

void test("authorized resources_discover skills reach the real system prompt under user and setup negations", async (t) => {
  const { root, requests, agentDir, dynamicExtension } = await fixture(t);
  const executor = new WorkflowAgentExecutor(root, localAgentTransport);
  const lateSkill = join(agentDir, "skills", "late-skill");
  const cases: Array<{ name: string; options: Record<string, JsonValue>; generated: boolean; root?: Partial<AgentExecutionRoot> }> = [
    { name: "default", options: {}, generated: true },
    { name: "selected", options: { skills: ["!*", "generated-skill"] }, generated: true },
    { name: "user negation", options: { skills: ["!generated-skill"] }, generated: false },
    { name: "excluded extension", options: { extensions: [`!${dynamicExtension}`] }, generated: false },
    { name: "setup negation", options: {}, generated: false, root: { agentSetupHooks: [{ name: "narrow", priority: 0, setup(agent) { const policy = agent.sessionInput.resourcePolicy; assert.ok(policy); policy.effective.skills = [...policy.effective.skills, "!generated-skill"]; } }] } },
    { name: "unauthorized static", options: {}, generated: true, root: { agentSetupHooks: [{ name: "late", priority: 0, setup() { skill(lateSkill, "late-skill", "LATE_SKILL_MARKER"); } }] } },
  ];
  for (const entry of cases) {
    requests.length = 0;
    const result = await (entry.root ? new WorkflowAgentExecutor({ ...root, ...entry.root }, localAgentTransport) : executor).execute("ROOT_TASK", run(entry.options));
    assert.equal(result.value, "ok", entry.name);
    const [request] = requests;
    assert.ok(request && requests.length === 1, entry.name);
    assert.equal(request.system.includes(GENERATED), entry.generated, entry.name);
    assert.equal(request.system.includes("LATE_SKILL_MARKER"), false, entry.name);
    assert.equal(request.system.includes(STATIC), entry.name !== "selected", entry.name);
  }
});

void test("parent skills bound resources_discover skills for nested agents", async (t) => {
  const { root, requests, dynamicExtension } = await fixture(t);
  const executor = new WorkflowAgentExecutor(root, localAgentTransport);
  const extensions = [extensionIdentity(dynamicExtension)];
  for (const [skills, generated] of [[["static-skill"], false], [["static-skill", "generated-skill"], true]] as const) {
    requests.length = 0;
    const result = await executor.execute("CHILD_LIKE_TASK", run({}, { parent: "parent", cwd: root.cwd, capabilities: { tools: ["read", "write"], skills, extensions } }));
    assert.equal(result.value, "ok");
    assert.equal(requests[0]?.system.includes(GENERATED), generated, skills.join());
  }
});

void test("nested agents inherit their parent's discovered skills through the real workflow lifecycle", async (t) => {
  let childOptions: Record<string, JsonValue> = {};
  const { root, requests } = await fixture(t, () => childOptions);
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details?: unknown }> }> = [];
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getActiveTools: () => ["agent", "read"], getThinkingLevel: () => "off" }), root.cwd, async () => {}, undefined, root.agentDir);
  t.after(async () => { await shutdown?.(); });
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const registry = { getAll: () => [{ provider: "fixture", id: "fixture-model" }], getAvailable: () => [{ provider: "fixture", id: "fixture-model" }] };
  const context = { cwd: root.cwd, hasUI: false, model: { provider: "fixture", id: "fixture-model" }, modelRegistry: registry, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "session" } };
  const cases: Array<{ parent: Record<string, JsonValue>; child: Record<string, JsonValue>; generated: [boolean, boolean] }> = [
    { parent: {}, child: {}, generated: [true, true] },
    { parent: {}, child: { skills: ["!generated-skill"] }, generated: [true, false] },
    { parent: { skills: ["!generated-skill"] }, child: { skills: ["generated-skill"] }, generated: [false, false] },
  ];
  for (const [index, entry] of cases.entries()) {
    requests.length = 0;
    childOptions = entry.child;
    await workflow.execute(`call-${String(index)}`, { name: `nested-${String(index)}`, script: `return await agent("PARENT_TASK", { label: "parent", ...${JSON.stringify(entry.parent)} });`, foreground: true }, new AbortController().signal, undefined, context);
    const parent = requests.find(({ task }) => task.includes("PARENT_TASK"));
    const child = requests.find(({ task }) => task.includes("CHILD_TASK"));
    assert.ok(parent && child, JSON.stringify(requests.map(({ task }) => task.slice(0, 80))));
    assert.deepEqual([parent.system.includes(GENERATED), child.system.includes(GENERATED)], entry.generated, JSON.stringify(entry));
  }
});

void test("setup hooks still cannot move an agent's cwd, even into a project subdirectory", async (t) => {
  const { root } = await fixture(t);
  const subdirectory = join(root.cwd, "packages", "app");
  mkdirSync(subdirectory, { recursive: true });
  for (const cwd of [subdirectory, join(root.cwd, "..")]) {
    // JavaScript hooks can still write the read-only field, so the runtime check stays authoritative.
    for (const setup of [(agent: import("../src/types.js").AgentSetup) => { (agent.sessionInput as { cwd: string }).cwd = cwd; }, (agent: import("../src/types.js").AgentSetup) => { agent.options.cwd = cwd; }]) {
      const prepared = await prepareAgentSetupForInspection({ ...root, agentSetupHooks: [{ name: "move", priority: 0, setup }] }, "task", run({}), inspectionTransport);
      assert.ok(prepared.failure?.error instanceof WorkflowError && prepared.failure.error.code === "INVALID_METADATA" && /cannot change cwd/.test(prepared.failure.error.message));
    }
  }
});

type ReloadableSession = Awaited<ReturnType<typeof createLocalPiSession>> & { reload(): Promise<void>; getResourceInspection(): { skills: readonly string[] }; dispose(): Promise<void> | void };
void test("resources_discover provenance belongs to one resource generation, so reload cannot let a later static skill bypass the frozen inventory", async (t) => {
  const { root, agentDir } = await fixture(t);
  const directory = dirname(root.cwd);
  const contributed = join(directory, "contributed");
  const flag = join(directory, "contribute");
  mkdirSync(contributed, { recursive: true });
  writeFileSync(flag, "");
  writeFileSync(join(agentDir, "extensions", "toggle.js"), `import { existsSync } from "node:fs"; export default (pi) => { pi.on("resources_discover", () => existsSync(${JSON.stringify(flag)}) ? { skillPaths: [${JSON.stringify(contributed)}] } : {}); };`);
  const staticRoot = { ...root, additionalSkillPaths: [contributed] };
  // The frozen inventory is taken while the statically configured directory is still empty.
  const prepared = await prepareAgentSetupForInspection(staticRoot, "task", run({}), inspectionTransport);
  assert.equal(prepared.failure, undefined);
  skill(join(contributed, "skill"), "first", "FIRST_MARKER");
  const session = await createLocalPiSession(prepared.setup.sessionInput) as ReloadableSession;
  t.after(async () => { await session.dispose(); });
  const loaded = () => [...session.getResourceInspection().skills].filter((name) => name !== "static-skill" && name !== "generated-skill").sort();
  assert.deepEqual(loaded(), ["first"], "the contributed skill is discovered");
  unlinkSync(flag);
  skill(join(contributed, "skill"), "late", "LATE_MARKER");
  await session.reload();
  assert.deepEqual(loaded(), [], "a withdrawn contribution reborn as a static path is bounded by the frozen inventory");
  const fresh = await createLocalPiSession(prepared.setup.sessionInput) as ReloadableSession;
  assert.deepEqual([...fresh.getResourceInspection().skills].filter((name) => name === "late"), [], "a fresh session agrees with the reloaded one");
  await fresh.dispose();
  writeFileSync(flag, "");
  const reborn = await createLocalPiSession(prepared.setup.sessionInput) as ReloadableSession;
  assert.deepEqual([...reborn.getResourceInspection().skills].filter((name) => name === "late"), ["late"], "a contribution in the current generation is discovered again");
  await reborn.dispose();
});

void test("resources_discover skills given as ~, file: URLs, padded, relative or symlinked paths reach a real session", async (t) => {
  const { root, agentDir } = await fixture(t);
  const directory = dirname(root.cwd);
  const home = process.env.HOME;
  t.after(() => { process.env.HOME = home; });
  process.env.HOME = join(directory, "home");
  skill(join(directory, "home", "tilde", "tilde-skill"), "tilde-skill", "TILDE");
  skill(join(directory, "url dir", "url-skill"), "url-skill", "URL");
  skill(join(directory, "padded", "padded-skill"), "padded-skill", "PADDED");
  skill(join(directory, "relative", "relative-skill"), "relative-skill", "RELATIVE");
  skill(join(directory, "target", "linked-skill"), "linked-skill", "LINKED");
  symlinkSync(join(directory, "target"), join(directory, "link"));
  const paths = ["~/tilde", pathToFileURL(join(directory, "url dir")).href, `  ${join(directory, "padded")}  `, relative(root.cwd, join(directory, "relative")), join(directory, "link")];
  writeFileSync(join(agentDir, "extensions", "forms.js"), `export default (pi) => { pi.on("resources_discover", () => ({ skillPaths: ${JSON.stringify(paths)} })); };`);
  const prepared = await prepareAgentSetupForInspection(root, "task", run({}), inspectionTransport);
  assert.equal(prepared.failure, undefined);
  const session = await createLocalPiSession(prepared.setup.sessionInput) as ReloadableSession;
  t.after(async () => { await session.dispose(); });
  assert.deepEqual([...session.getResourceInspection().skills].sort(), ["generated-skill", "linked-skill", "padded-skill", "relative-skill", "static-skill", "tilde-skill", "url-skill"]);
});

void test("a child's skill ceiling is what its parent session has loaded when the child spawns", async (t) => {
  const { root } = await fixture(t);
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let shutdown: (() => Promise<void>) | undefined;
  const childCeilings: Array<readonly string[] | undefined> = [];
  // The authorized static skill is already gone when the parent materializes; only the discovered one is loaded.
  let parentLoaded = ["generated-skill"];
  const base = testTransport(async (input: SessionInput) => {
    if (!input.sessionLabel.includes(":parent:")) childCeilings.push(input.resourcePolicy?.parentSkills);
    return {
      sessionId: `session-${String(childCeilings.length)}`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      async prompt() {
        if (!input.sessionLabel.includes(":parent:")) return;
        const agent = input.customTools?.find(({ name }) => name === "agent");
        const result = input.customTools?.find(({ name }) => name === "get_subagent_result");
        assert.ok(agent && result);
        for (const label of ["before", "after"]) {
          const spawned = await agent.execute(label, { prompt: label, label }, new AbortController().signal, undefined, undefined as never);
          await result.execute(label, spawned.details, new AbortController().signal, undefined, undefined as never);
          // A new resource generation withdraws the discovered skill too, as a reload or handoff resume of the parent would.
          parentLoaded = [];
        }
      },
      dispose() {},
    };
  });
  const transport = { id: "local", async createSession(...args: Parameters<typeof base.createSession>) { const session = await base.createSession(...args); return { ...session, getResourceInspection: () => ({ skills: [...parentLoaded], extensions: [] }) }; } };
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getActiveTools: () => ["agent", "read"], getThinkingLevel: () => "off" }), root.cwd, async () => {}, transport, root.agentDir);
  t.after(async () => { await shutdown?.(); });
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  await workflow.execute("call", { name: "ceiling", script: 'return await agent("parent", { label: "parent" });', foreground: true }, new AbortController().signal, undefined, { cwd: root.cwd, hasUI: false, model: { provider: "fixture", id: "fixture-model" }, sessionManager: { getSessionId: () => "session" } });
  assert.deepEqual(childCeilings.map((ceiling) => [...(ceiling ?? [])].sort()), [["generated-skill"], []], "withdrawn static and discovered skills leave the ceiling");
});

void test("the child agent tool schema shows excludeTools to the model", async () => {
  const scheduler = new FairAgentScheduler(async () => "done", 1);
  scheduler.addRun("run", 1);
  const parent = scheduler.spawn("run", "task", { label: "parent", cwd: tmpdir(), tools: ["agent"] });
  const agentTool = scheduler.toolsFor(parent.id).find(({ name }) => name === "agent");
  assert.ok(agentTool);
  const properties = (agentTool.parameters as unknown as { properties: Record<string, { type?: string; items?: { type?: string } }> }).properties;
  assert.deepEqual({ type: properties.excludeTools?.type, items: properties.excludeTools?.items?.type }, { type: "array", items: "string" });
  await parent.result;
});

void test("excluded or outside-ceiling tools cannot come back as same-named custom tools, at the root or in children", async (t) => {
  const { root, requests } = await fixture(t, () => ({}));
  const writeTool = { name: "write", label: "Custom write", description: "Custom write", parameters: { type: "object", properties: {} }, async execute() { return { content: [], details: undefined }; } } as unknown as import("@earendil-works/pi-coding-agent").ToolDefinition;
  const helperTool = { ...writeTool, name: "custom_helper" } as typeof writeTool;
  const adding = (tool: typeof writeTool): NonNullable<AgentExecutionRoot["agentSetupHooks"]> => [{ name: "add", priority: 0, setup(agent) { agent.sessionInput.customTools = [...(agent.sessionInput.customTools ?? []), tool]; } }];
  for (const options of [{ excludeTools: ["write"] }, { tools: ["!*", "read"] }] as Array<Record<string, JsonValue>>) {
    requests.length = 0;
    await assert.rejects(new WorkflowAgentExecutor({ ...root, agentSetupHooks: adding(writeTool) }, localAgentTransport).execute("ROOT_TASK", run(options)), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL" && /reintroduces a tool outside the prepared agent policy: write/.test(error.message), JSON.stringify(options));
    assert.equal(requests.length, 0, "rejected before any provider request");
  }
  // A child bounded by its parent's ceiling cannot take the excluded name back either.
  requests.length = 0;
  await assert.rejects(new WorkflowAgentExecutor({ ...root, agentSetupHooks: adding(writeTool) }, localAgentTransport).execute("CHILD_LIKE_TASK", run({}, { parent: "parent", cwd: root.cwd, capabilities: { tools: ["read"], skills: [], extensions: [] } })), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
  assert.equal(requests.length, 0);
  // Custom tools with names outside the root inventory remain available.
  requests.length = 0;
  const allowed = await new WorkflowAgentExecutor({ ...root, agentSetupHooks: adding(helperTool) }, localAgentTransport).execute("ROOT_TASK", run({ excludeTools: ["write"] }));
  assert.equal(allowed.value, "ok");
  assert.deepEqual(requests[0]?.tools, ["custom_helper", "read", "workflow_result"]);
});

void test("a setup hook's terminal !* in the selector sources still excludes a skill whose static path is also contributed", async (t) => {
  const { root, requests, agentDir } = await fixture(t);
  const directory = dirname(root.cwd);
  const overlapping = join(directory, "overlapping");
  skill(join(overlapping, "foo"), "foo", "EXCLUDED_FOO_SKILL");
  writeFileSync(join(agentDir, "extensions", "overlap.js"), `export default (pi) => { pi.on("resources_discover", () => ({ skillPaths: [${JSON.stringify(overlapping)}] })); };`);
  const staticRoot = { ...root, additionalSkillPaths: [overlapping] };
  const narrowings: Array<[string, (policy: NonNullable<import("../src/types.js").SessionInput["resourcePolicy"]>) => void]> = [
    ["selectorSources", (policy) => { policy.selectorSources.global.skills = [...(policy.selectorSources.global.skills ?? []), "!*"]; }],
    ["effective", (policy) => { policy.effective.skills = [...policy.effective.skills, "!*"]; }],
  ];
  for (const [name, narrow] of narrowings) {
    requests.length = 0;
    const executor = new WorkflowAgentExecutor({ ...staticRoot, agentSetupHooks: [{ name: "narrow", priority: 0, setup(agent) { const policy = agent.sessionInput.resourcePolicy; assert.ok(policy); narrow(policy); } }] }, localAgentTransport);
    const result = await executor.execute("ROOT_TASK", run({}));
    assert.equal(result.value, "ok", name);
    const system = requests[0]?.system ?? "EXCLUDED_FOO_SKILL";
    assert.equal(system.includes("EXCLUDED_FOO_SKILL"), false, `${name}: the terminal !* must exclude the overlapping skill`);
    assert.equal(system.includes(GENERATED), false, `${name}: and every discovered skill`);
  }
  requests.length = 0;
  await new WorkflowAgentExecutor(staticRoot, localAgentTransport).execute("ROOT_TASK", run({}));
  assert.equal(requests[0]?.system.includes("EXCLUDED_FOO_SKILL"), true, "control: the overlapping skill loads without the narrowing");
});

void test("excludeTools also removes same-named custom tools that setup hooks add, for the agent and its descendants", async (t) => {
  let childOptions: Record<string, JsonValue> = {};
  const { root, requests } = await fixture(t, () => childOptions);
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details?: unknown }> }> = [];
  let shutdown: (() => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getActiveTools: () => ["agent", "read"], getThinkingLevel: () => "off" }), root.cwd, async () => {}, undefined, root.agentDir);
  t.after(async () => { await shutdown?.(); loadingRegistry().freeze(); });
  const helper = { name: "custom_helper", label: "Helper", description: "Setup-provided helper", parameters: { type: "object", properties: {} }, async execute() { return { content: [], details: undefined }; } } as unknown as import("@earendil-works/pi-coding-agent").ToolDefinition;
  // Hooks may add the custom tool only, or also list it by name in the explicit tool list.
  let alsoListed = false;
  let failSetupOnce = false;
  let delegations = 0;
  registerWorkflowExtension({ version: "1.0.0", headline: "Helper", agentSetupHooks: { helper: { setup(agent) {
    if (failSetupOnce) { failSetupOnce = false; throw new Error("setup failed once"); }
    agent.sessionInput.customTools = [...(agent.sessionInput.customTools ?? []), helper];
    if (alsoListed) agent.sessionInput.tools = [...agent.sessionInput.tools, "custom_helper"];
  } } }, functions: { delegate: { description: "Delegates with exclusions that change when the function runs again", input: { type: "object" }, output: { type: "string" }, run: async (_input, context) => {
    delegations += 1;
    const value = await context.agent("PARENT_TASK", { label: "parent", excludeTools: delegations === 1 ? ["custom_helper"] : [] });
    return typeof value === "string" ? value : JSON.stringify(value);
  } } } });
  const workflow = tools.find(({ name }) => name === "workflow");
  const retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(workflow && retry);
  const registry = { getAll: () => [{ provider: "fixture", id: "fixture-model" }], getAvailable: () => [{ provider: "fixture", id: "fixture-model" }] };
  const context = { cwd: root.cwd, hasUI: false, model: { provider: "fixture", id: "fixture-model" }, modelRegistry: registry, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "session" } };
  const cases: Array<{ parent: Record<string, JsonValue>; child: Record<string, JsonValue>; parentTools: string[]; childTools: string[] }> = [
    { parent: {}, child: {}, parentTools: ["agent", "custom_helper", "get_subagent_result", "read", "steer_subagent", "workflow_result"], childTools: ["agent", "custom_helper", "get_subagent_result", "read", "steer_subagent", "workflow_result"] },
    { parent: { excludeTools: ["custom_helper"] }, child: {}, parentTools: ["agent", "get_subagent_result", "read", "steer_subagent", "workflow_result"], childTools: ["agent", "get_subagent_result", "read", "steer_subagent", "workflow_result"] },
    { parent: {}, child: { excludeTools: ["custom_helper"] }, parentTools: ["agent", "custom_helper", "get_subagent_result", "read", "steer_subagent", "workflow_result"], childTools: ["agent", "get_subagent_result", "read", "steer_subagent", "workflow_result"] },
    // Core's own custom tools follow the same rule, and descendants inherit the exclusion.
    { parent: { excludeTools: ["steer_subagent"] }, child: {}, parentTools: ["agent", "custom_helper", "get_subagent_result", "read", "workflow_result"], childTools: ["agent", "custom_helper", "get_subagent_result", "read", "workflow_result"] },
  ];
  for (const listed of [false, true]) for (const [index, entry] of cases.entries()) {
    alsoListed = listed;
    requests.length = 0;
    childOptions = entry.child;
    // A failed parent rejects here; a failed child sends no CHILD_TASK request.
    await workflow.execute(`call-${String(index)}-${String(listed)}`, { name: `exclude-custom-${String(index)}`, script: `return await agent("PARENT_TASK", { label: "parent", ...${JSON.stringify(entry.parent)} });`, foreground: true }, new AbortController().signal, undefined, context);
    const label = JSON.stringify({ listed, ...entry });
    const parent = requests.find(({ task }) => task.includes("PARENT_TASK"));
    const child = requests.find(({ task }) => task.includes("CHILD_TASK"));
    assert.ok(parent && child, label);
    assert.deepEqual({ parent: parent.tools, child: child.tools }, { parent: entry.parentTools, child: entry.childTools }, label);
  }
  // Exclusions are frozen with the logical identity's configuration: later turns of the same handle and their children keep
  // the first turn's exclusions, whether the re-evaluated option list shrinks or grows.
  const withHelper = ["agent", "custom_helper", "get_subagent_result", "read", "steer_subagent", "workflow_result"];
  const withoutHelper = withHelper.filter((tool) => tool !== "custom_helper");
  for (const listed of [false, true]) for (const [initial, change, expected] of [["[\"custom_helper\"]", "exclusions.pop()", withoutHelper], ["[]", "exclusions.push(\"custom_helper\")", withHelper]] as const) {
    alsoListed = listed;
    requests.length = 0;
    childOptions = {};
    const label = JSON.stringify({ listed, initial, change });
    await workflow.execute(`handle-${String(listed)}-${initial}`, { name: "frozen-handle-exclusions", script: `const exclusions = ${initial};\nconst h = agent.create({ name: "h", excludeTools: exclusions });\nawait h.send("PARENT_TASK ONE");\n${change};\nreturn await h.send("PARENT_TASK TWO");`, foreground: true }, new AbortController().signal, undefined, context);
    assert.deepEqual(requests.map(({ task, tools }) => [task.includes("CHILD_TASK") ? "child" : "parent", tools]), [["parent", expected], ["child", expected], ["parent", expected], ["child", expected]], label);
  }
  // A registered function that runs again on workflow_retry re-evaluates excludeTools for the same logical identity; the
  // retried agent and its new children keep the frozen exclusions, and the hook's listed name does not fail the agent.
  alsoListed = true;
  failSetupOnce = true;
  requests.length = 0;
  childOptions = {};
  await assert.rejects(workflow.execute("delegate", { name: "frozen-retry-exclusions", script: "return await delegate({});", foreground: true }, new AbortController().signal, undefined, context), (error: unknown) => error instanceof WorkflowError);
  assert.equal(requests.length, 0, "the first run fails in setup before any provider request");
  let failedRunId: string | undefined;
  for (const runId of await listRunIds(root.cwd, "session", root.cwd)) {
    const loaded = await new RunStore(root.cwd, "session", runId, root.cwd).load();
    if (loaded.snapshot.metadata.name === "frozen-retry-exclusions" && loaded.run.state === "failed") failedRunId = runId;
  }
  assert.ok(failedRunId);
  await retry.execute("retry", { runId: failedRunId, foreground: true }, new AbortController().signal, undefined, context);
  assert.equal(delegations, 2, "the retry ran the incomplete function again with an empty exclusion list");
  assert.deepEqual(requests.map(({ task, tools }) => [task.includes("CHILD_TASK") ? "child" : "parent", tools]), [["parent", withoutHelper], ["child", withoutHelper]]);
});

void test("a stored configuration keeps its frozen exclusions on resume, whatever the re-evaluated options say", async (t) => {
  const { root, requests } = await fixture(t);
  const helper = { name: "custom_helper", label: "Helper", description: "Setup-provided helper", parameters: { type: "object", properties: {} }, async execute() { return { content: [], details: undefined }; } } as unknown as import("@earendil-works/pi-coding-agent").ToolDefinition;
  const agentSetupHooks: NonNullable<AgentExecutionRoot["agentSetupHooks"]> = [{ name: "helper", priority: 0, setup(agent) {
    agent.sessionInput.customTools = [...(agent.sessionInput.customTools ?? []), helper];
    agent.sessionInput.tools = [...agent.sessionInput.tools, "custom_helper"];
  } }];
  const store = new RunStore(root.cwd, "session", "run", root.cwd);
  await store.create({ id: "run", workflowName: "parity", cwd: root.cwd, sessionId: "session", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return null", args: null, metadata: { name: "parity" }, launchMode: "foreground", settings: { concurrency: 1 }, models: ["fixture/fixture-model"], tools: ["read", "write"], schemas: [], agentConfigurations: {} }));
  // Each execution uses a new executor, as a cold resume or retry in another process would.
  const execute = (agentOptions: Record<string, JsonValue>, agentNodeId: string) => new WorkflowAgentExecutor({ ...root, runStore: store, agentSetupHooks }, localAgentTransport).execute("ROOT_TASK", run(agentOptions, { agentNodeId }));
  assert.equal((await execute({ excludeTools: ["custom_helper"] }, "frozen")).value, "ok");
  const stored = (await store.load()).snapshot.agentConfigurations.frozen;
  assert.ok(stored);
  assert.deepEqual(stored.excludeTools, ["custom_helper"]);
  assert.deepEqual(requests.map(({ tools }) => tools), [["read", "workflow_result", "write"]]);
  requests.length = 0;
  assert.equal((await execute({}, "frozen")).value, "ok");
  assert.deepEqual(requests.map(({ tools }) => tools), [["read", "workflow_result", "write"]], "the resumed identity keeps excluding the hook's tool");
  // A configuration without the field was prepared before exclusions were frozen. Its exclusions are unknown, whatever the
  // re-evaluated options say, so it never resumes: neither from the run store nor when handed over directly.
  const legacy: Record<string, unknown> = { ...stored };
  Reflect.deleteProperty(legacy, "excludeTools");
  const decodedLegacy = decodePreparedAgentConfiguration(legacy);
  assert.ok(decodedLegacy);
  await store.saveAgentConfiguration("legacy", decodedLegacy);
  requests.length = 0;
  const legacyRejected = (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE" && /predates frozen excludeTools/.test(error.message);
  for (const agentOptions of [{ excludeTools: ["custom_helper"] }, {}, { excludeTools: [] }] as Array<Record<string, JsonValue>>) {
    await assert.rejects(execute(agentOptions, "legacy"), legacyRejected, JSON.stringify(agentOptions));
    await assert.rejects(new WorkflowAgentExecutor({ ...root, agentSetupHooks }, localAgentTransport).execute("ROOT_TASK", run(agentOptions, { configuration: decodedLegacy })), legacyRejected, JSON.stringify(agentOptions));
  }
  assert.equal(requests.length, 0);
  // Stored exclusions are validated like the option, and cannot contradict the frozen tools.
  assert.equal(decodePreparedAgentConfiguration({ ...stored, excludeTools: [42] }), undefined);
  for (const excludeTools of [["read"], ["workflow_result"], ["wr*"], ["!read"]]) {
    await store.saveAgentConfiguration("invalid", { ...stored, excludeTools });
    requests.length = 0;
    await assert.rejects(execute({}, "invalid"), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE", JSON.stringify(excludeTools));
    assert.equal(requests.length, 0);
  }
});
