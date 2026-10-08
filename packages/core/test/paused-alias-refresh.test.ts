import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import workflowExtension, { registerWorkflowExtension, RunStore } from "../src/index.js";
import { loadingRegistry } from "../src/registry.js";
import { contextualWorkflowAction, testExtensionApi } from "./support.js";

type ToolLike = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
type WorkflowCommand = Parameters<typeof contextualWorkflowAction>[0];

function sse(response: ServerResponse, name: string, args: unknown): void {
  response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
  const chunk = (choice: Record<string, unknown>) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [choice] })}\n\n`;
  response.end(`${chunk({ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call-${name}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null })}${chunk({ index: 0, delta: {}, finish_reason: "tool_calls" })}data: [DONE]\n\n`);
}
async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let attempt = 0; attempt < 2000; attempt += 1) { if (await condition()) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail(`timed out waiting for ${what}`);
}

type PausedFixture = { run(script: string, context?: Record<string, unknown>): Promise<{ runId: string; store: RunStore; pauseAfterA(): Promise<void>; resume(): Promise<void> }>; requests: Array<{ task: string; model: string }>; observed: Array<{ label: string; alias: string | undefined; dynamic: readonly string[] | undefined }>; setTarget(value: string): void };
// Real default local transport and a local OpenAI-compatible provider. Agent a's request is held until the run is
// pausing; once paused, the test changes host state and resumes from the navigator.
async function pausedFixture(t: TestContext): Promise<PausedFixture> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "workflow-paused-alias-")));
  const cwd = join(home, "project");
  const agentDir = join(home, "agent");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  const requests: Array<{ task: string; model: string }> = [];
  let releaseA: (() => void) | undefined;
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body) as { model: string; messages: Array<{ role: string; content?: unknown }> };
      const task = JSON.stringify(payload.messages.find(({ role }) => role === "user")?.content ?? "");
      requests.push({ task, model: payload.model });
      const answer = () => { sse(response, "workflow_result", { result: task.includes("TASK_A") ? "a-ok" : "b-ok" }); };
      if (task.includes("TASK_A")) releaseA = () => { releaseA = undefined; answer(); }; else answer();
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const model = (id: string) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1_000 });
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, api: "openai-completions", apiKey: "fixture", models: [model("one"), model("two")] } } }));
  writeFileSync(join(agentDir, "auth.json"), "{}");
  let shutdown: (() => Promise<void>) | undefined;
  t.after(async () => { releaseA?.(); await shutdown?.(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); rmSync(home, { recursive: true, force: true }); loadingRegistry().freeze(); });
  const tools: ToolLike[] = [];
  let command: WorkflowCommand | undefined;
  workflowExtension(testExtensionApi({
    registerTool(tool: ToolLike) { tools.push(tool); },
    registerCommand(_name: string, value: { handler: WorkflowCommand }) { command = value.handler; },
    on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; },
    getActiveTools: () => ["read"],
    getThinkingLevel: () => "off",
  }), home, async () => {}, undefined, agentDir);
  let target = "fixture/one";
  const observed: PausedFixture["observed"] = [];
  registerWorkflowExtension({ version: "1.0.0", headline: "Live alias", modelAliases: { dyn: { resolve: () => target } }, agentPreparationHooks: { observe: { prepare(_configuration, context) {
    if (context.mode === "execution") observed.push({ label: String(context.options.label), alias: context.defaults.modelAliases.dyn, dynamic: context.defaults.dynamicModelAliasNames });
  } } } });
  const models = [{ provider: "fixture", id: "one" }, { provider: "fixture", id: "two" }];
  const base = { cwd, hasUI: false, model: { provider: "fixture", id: "one" }, modelRegistry: { getAll: () => models, getAvailable: () => models }, isProjectTrusted: () => false, sessionManager: { getSessionId: () => "session" }, ui: { notify() {} } };
  return {
    requests, observed, setTarget(value) { target = value; },
    async run(script, extra = {}) {
      const workflow = tools.find(({ name }) => name === "workflow");
      assert.ok(workflow && command);
      const handler = command;
      const context = { ...base, ...extra };
      const started = await workflow.execute("call", { name: "paused-alias", script }, new AbortController().signal, undefined, context) as { details: { runId: string } };
      const runId = started.details.runId;
      const store = new RunStore(cwd, "session", runId, home);
      return {
        runId, store,
        async pauseAfterA() {
          await until(() => releaseA !== undefined, "agent a's provider request");
          await contextualWorkflowAction(handler, context, runId, "Pause");
          assert.equal((await store.load()).run.state, "pausing");
          releaseA?.();
          await until(async () => (await store.load()).run.state === "paused", "the paused state");
        },
        async resume() { await contextualWorkflowAction(handler, context, runId, "Resume"); },
      };
    },
  };
}

void test("a live paused resume prepares new identities with the refreshed dynamic aliases", async (t) => {
  const fixture = await pausedFixture(t);
  const launched = await fixture.run('const a = await agent("TASK_A", { label: "a", model: "dyn" }); const b = await agent("TASK_B", { label: "b", model: "dyn" }); return [a, b];');
  await launched.pauseAfterA();
  fixture.setTarget("fixture/two");
  await launched.resume();
  await until(async () => (await launched.store.load()).run.state === "completed", "completion");
  assert.deepEqual(fixture.requests.map(({ task, model }) => [task.includes("TASK_A") ? "a" : "b", model]), [["a", "one"], ["b", "two"]]);
  assert.deepEqual(fixture.observed, [{ label: "a", alias: "fixture/one", dynamic: ["dyn"] }, { label: "b", alias: "fixture/two", dynamic: ["dyn"] }]);
  assert.equal((await launched.store.load()).snapshot.modelAliases?.dyn, "fixture/two", "the refreshed snapshot records the current alias");
});

void test("reported extension load failures keep failing ownerless options closed after a paused resume replaces the executor", async (t) => {
  const fixture = await pausedFixture(t);
  const launched = await fixture.run('const a = await agent("TASK_A", { label: "a" }); const options = { label: "b", role: ["aud", "itor"].join("") }; return await agent("TASK_B", options);', { extensionLoadErrors: ["/extensions/roles.mjs: E2E_ROLES_FAILED"], loadedExtensionPaths: [] });
  await launched.pauseAfterA();
  await launched.resume();
  await until(async () => ["completed", "failed"].includes((await launched.store.load()).run.state), "a terminal state");
  const loaded = await launched.store.load();
  assert.equal(loaded.run.state, "failed");
  assert.equal(loaded.run.error?.code, "INVALID_METADATA");
  assert.match(loaded.run.error.message, /role has no owner proven to have loaded[\s\S]*E2E_ROLES_FAILED/);
  assert.deepEqual(fixture.requests.map(({ task }) => task.includes("TASK_A") ? "a" : "b"), ["a"], "the ownerless agent never reached the provider");
});
