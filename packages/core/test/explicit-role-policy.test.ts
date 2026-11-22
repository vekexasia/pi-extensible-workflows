import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import workflowExtension from "../src/index.js";
import { registerWorkflowExtension, resetWorkflowRegistry } from "../src/registry.js";
import { WorkflowError, type JsonValue, type SessionInput } from "../src/types.js";
import { createSubagentManager } from "../subagents/src/index.js";
import { testExtensionApi, testExtensionContextFor } from "./support.js";
import { testTransport } from "./test-transport.js";

function fixture(t: TestContext, enabled: boolean | undefined) {
  const cwd = mkdtempSync(join(realpathSync(tmpdir()), "explicit-role-policy-"));
  const agentDir = join(cwd, "agent");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({
    ...(enabled === undefined ? {} : { extensionSettings: { workflow: { requireExplicitRole: enabled } } }),
  }));
  resetWorkflowRegistry();
  t.after(() => { resetWorkflowRegistry(); rmSync(cwd, { recursive: true, force: true }); });
  return { cwd, agentDir };
}
function registerRoles() {
  registerWorkflowExtension({ version: "1.0.0", headline: "Role integration fixture", agentPreparationHooks: {
    roles: { optionsSchema: { type: "object", properties: { role: { type: "string", minLength: 1 } }, additionalProperties: true }, prepare(configuration, context) {
      if (context.options.role === undefined) return;
      if (context.options.role !== "reviewer") throw new WorkflowError("INVALID_METADATA", "Unknown role; choose reviewer");
      configuration.systemPromptAppend = "Review carefully";
    } },
  } });
}
const models = [{ provider: "test", id: "model" }];
const session = () => ({ sessionId: "fixture", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), async prompt() {}, dispose() {} });

for (const enabled of [undefined, false, true]) {
  void test(`standalone launches enforce explicit roles only when enabled=${String(enabled)}`, async (t) => {
    const { cwd, agentDir } = fixture(t, enabled);
    registerRoles();
    const launches: SessionInput[] = [];
    const manager = createSubagentManager({ agentDir, storageDir: join(cwd, "subagents"), getActiveTools: () => ["read"], transport: testTransport(async (input) => { launches.push(input); return session(); }) });
    t.after(async () => { await manager.dispose?.(); });
    const context = { toolCallId: "test", signal: undefined, onUpdate: undefined, waitForForeground: true, extensionContext: testExtensionContextFor({ cwd, model: models[0], thinkingLevel: "off", modelRegistry: { getAll: () => models, getAvailable: () => models }, sessionManager: { getSessionId: () => "session" }, isProjectTrusted: () => false }) };
    const requests: Array<Record<string, JsonValue>> = enabled ? [{}, { label: "reviewer" }, { role: "" }, { role: "  " }, { role: 42 }, { role: "unknown" }] : [{}];
    for (const request of requests) {
      const result = await manager.run({ prompt: "task", mode: "foreground", ...request }, context);
      assert.ok(result && typeof result === "object" && "state" in result);
      assert.equal(result.state, enabled ? "failed" : "completed", JSON.stringify(result));
      if (enabled) assert.match(JSON.stringify(result), /explicit.*role.*required/i);
    }
    assert.equal(launches.length, enabled ? 0 : 1);
    const valid = await manager.run({ prompt: "task", mode: "foreground", role: "reviewer" }, context);
    assert.ok(valid && typeof valid === "object" && "state" in valid);
    assert.equal(valid.state, "completed");
    assert.equal(launches.at(-1)?.systemPromptAppend, "Review carefully");
  });
}

void test("workflow dynamic calls, handles and nested tools require their own role before session creation", async (t) => {
  const { cwd, agentDir } = fixture(t, true);
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let shutdown: (() => Promise<void>) | undefined;
  const launches: SessionInput[] = [];
  const children: unknown[] = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, on(name: string, handler: unknown) { if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getActiveTools: () => ["agent", "read"] }), cwd, async () => {}, testTransport(async (input) => {
    launches.push(input);
    return { ...session(), async prompt() {
      if (!input.sessionLabel.includes(":parent:")) return;
      const agent = input.customTools?.find(({ name }) => name === "agent");
      const collect = input.customTools?.find(({ name }) => name === "get_subagent_result");
      assert.ok(agent && collect);
      for (const role of [undefined, "", "unknown", "reviewer"]) {
        const launched = await agent.execute("child", { prompt: "child", label: "child", ...(role === undefined ? {} : { role }) }, new AbortController().signal, undefined, undefined as never);
        const result = await collect.execute("collect", launched.details, new AbortController().signal, undefined, undefined as never);
        children.push(result.details);
      }
    } };
  }), agentDir);
  t.after(async () => { await shutdown?.(); });
  registerRoles();
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd, hasUI: false, model: models[0], modelRegistry: { getAll: () => models, getAvailable: () => models }, sessionManager: { getSessionId: () => "session" } };
  for (const script of [
    'const opts = JSON.parse("{}"); return agent("task", opts);',
    'const opts = JSON.parse("{\\"role\\":\\"unknown\\"}"); return agent("task", opts);',
    'const worker = agent.create({ name: "reviewer" }); return worker.send("task");',
  ]) {
    await assert.rejects(workflow.execute("call", { name: "roles", script, foreground: true }, new AbortController().signal, undefined, context), /explicit.*role.*required/i);
  }
  assert.equal(launches.length, 0);
  await workflow.execute("parent", { name: "roles", script: 'return agent("task", { label: "parent", role: "reviewer" });', foreground: true }, new AbortController().signal, undefined, context);
  assert.equal(launches.length, 2, "only the parent and explicitly valid nested child start");
  assert.equal(children.length, 4);
  for (const result of children.slice(0, 3)) assert.match(JSON.stringify(result), /explicit.*role.*required/i);
  assert.doesNotMatch(JSON.stringify(children[3]), /explicit.*role.*required/i);
});
