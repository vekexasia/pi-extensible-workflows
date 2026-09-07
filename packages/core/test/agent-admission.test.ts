import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workflowExtension, { type SessionInput } from "../src/index.js";
import { testExtensionApi } from "./support.js";
import { testTransport, type TestPiSession } from "./test-transport.js";

// Several launches: a regression to "whichever replay lookup finishes first" is intermittent.
void test("concurrently issued agent calls start in call order under a concurrency limit", { timeout: 60_000 }, async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-admission-"));
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  const starts: string[] = [];
  let sessionCount = 0;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    const label = input.sessionLabel.split(":")[1] ?? "unknown";
    return {
      sessionId: `${label}-${String(++sessionCount)}`, sessionFile: `/sessions/${label}.jsonl`,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      prompt: async () => { starts.push(label); }, abort: async () => {}, steer: async () => {}, dispose() {},
    };
  };
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const labels = ["first", "second", "third", "fourth"];
  const script = `return await Promise.all([${labels.map((label) => `agent(${JSON.stringify(label)}, { label: ${JSON.stringify(label)} })`).join(", ")}]);`;
  for (let launch = 0; launch < 6; launch += 1) {
    starts.length = 0;
    await workflow.execute(`launch-${String(launch)}`, { name: "admission-order", script, concurrency: 1, foreground: true }, new AbortController().signal, undefined, context);
    assert.deepEqual(starts, labels, `launch ${String(launch)} started agents out of call order`);
  }
});
