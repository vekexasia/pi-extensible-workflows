import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const executionPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/execution.ts");

void test("the host serializes worker-facing errors through one helper", () => {
  const source = readFileSync(executionPath, "utf8");
  assert.equal((source.match(/^function workerErrorShape\(/gm) ?? []).length, 1, "workerErrorShape() must be declared once");
  assert.equal((source.match(/\.\.\.\(isWorkflowAuthored\(typed\) \? \{ authored: true \} : \{\}\)/g) ?? []).length, 1, "the authored-flag spread must live only inside workerErrorShape()");
  assert.equal((source.match(/workerErrorShape\(typed\)/g) ?? []).length, 4, "agent, checkpoint, function outcomes and the RPC failure envelope reuse the helper");
});
