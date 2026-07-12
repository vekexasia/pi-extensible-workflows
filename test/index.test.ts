import assert from "node:assert/strict";
import test from "node:test";
import workflowExtension from "../src/index.js";

void test("registers the workflow tool and singular command", async () => {
  const tools: Array<{ name: string; execute: () => Promise<unknown> }> = [];
  const commands: Array<{ name: string; options: { handler: (args: string, ctx: unknown) => Promise<void> } }> = [];
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
    registerCommand(name: string, options: (typeof commands)[number]["options"]) { commands.push({ name, options }); },
  };

  workflowExtension(pi as never);

  assert.deepEqual(tools.map(({ name }) => name), ["workflow"]);
  assert.deepEqual(commands.map(({ name }) => name), ["workflow"]);
  const tool = tools[0];
  assert.ok(tool);
  await assert.rejects(tool.execute(), /not implemented/);
});