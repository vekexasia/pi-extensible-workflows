import assert from "node:assert/strict";
import test from "node:test";
import { Value } from "typebox/value";
import { reviewLoopExtension } from "../.pi/extensions/review-loop.js";
import type { JsonValue, WorkflowFunctionContext } from "../src/index.js";

void test("developer-review loop feeds failed review into the next iteration", async () => {
  const calls: Array<{ prompt: string; options: unknown }> = [];
  const responses: JsonValue[] = [
    "first implementation",
    { pass: false, findings: ["fix it"] },
    "second implementation",
    { pass: true, findings: [] },
  ];
  const context: WorkflowFunctionContext = {
    agent: async (...args) => {
      calls.push({ prompt: String(args[0]), options: args[1] });
      return responses[calls.length - 1] ?? null;
    },
    prompt: (template, values) => template.replace(/{(\w+)}/g, (_match, key: string) => typeof values[key] === "string" ? values[key] : JSON.stringify(values[key], null, 2)),
    parallel: async () => null,
    pipeline: async () => null,
    withWorktree: async () => null,
    checkpoint: async () => true,
    phase() {},
    log() {},
    run: {
      cwd: "/repo",
      sessionId: "session",
      runId: "run",
      workflow: { name: "test" },
      args: null,
      signal: new AbortController().signal,
    },
  };
  const definition = reviewLoopExtension.functions?.developUntilApproved;
  assert.ok(definition);

  const input = {
    task: "Add the feature",
    maxIterations: 3,
  };
  assert.equal(Value.Check(definition.input, input), true);
  assert.equal(Value.Check(definition.input, { ...input, devPrompt: "override" }), false);

  const result = await definition.run(input, context);

  assert.deepEqual(result, {
    pass: true,
    iterations: 2,
    devResult: "second implementation",
    review: { pass: true, findings: [] },
  });
  assert.match(calls[2]?.prompt ?? "", /Previous review:[\s\S]*fix it/);
  assert.match(calls[3]?.prompt ?? "", /Developer result:[\s\S]*second implementation/);
});
