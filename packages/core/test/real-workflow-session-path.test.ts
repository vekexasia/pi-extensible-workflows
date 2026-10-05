import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const coreRoot = resolve(fileURLToPath(new URL("..", import.meta.url)), "..");
const realSessionTest = resolve(coreRoot, "dist/test/real-workflow-session.test.js");

void test("relative PI_WORKFLOW_TRACE_DIR is rooted at packages/core, not the caller cwd", () => {
  const executionRoot = mkdtempSync(join(tmpdir(), "pi-workflow-trace-dir-cwd-"));
  const fakePi = join(executionRoot, "fake-pi.mjs");
  const relativeTraceDir = `trace-dir-${String(process.pid)}-${String(Date.now())}`;
  const packageTraceDir = resolve(coreRoot, relativeTraceDir);
  const cwdTraceDir = resolve(executionRoot, relativeTraceDir);
  writeFileSync(join(executionRoot, "auth.json"), "{}");
  writeFileSync(fakePi, `process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "workflow_catalog", args: {} }) + "\\n");
process.stdout.write(JSON.stringify({ type: "tool_execution_start", toolName: "workflow", args: { name: "tddDev", script: "async function tddDev() { return 'npm test'; }" } }) + "\\n");
`);
  rmSync(packageTraceDir, { recursive: true, force: true });

  try {
    const result = spawnSync(process.execPath, ["--test", "--test-timeout=120000", "--test-force-exit", realSessionTest], {
      cwd: executionRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        HOME: executionRoot,
        NODE_TEST_CONTEXT: undefined,
        PI_WORKFLOW_REAL_SESSION: "1",
        PI_WORKFLOW_TEST_FUNCTION: "tddDev",
        PI_WORKFLOW_EVAL_SOURCE_AGENT_DIR: executionRoot,
        PI_WORKFLOW_TEST_PI: fakePi,
        PI_WORKFLOW_TRACE_DIR: relativeTraceDir,
      },
      timeout: 120_000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.ok(existsSync(join(packageTraceDir, "trace.jsonl")), `Expected trace under ${packageTraceDir}; output:\n${result.stdout}`);
    assert.equal(existsSync(join(cwdTraceDir, "trace.jsonl")), false, `Trace unexpectedly followed process.cwd(): ${cwdTraceDir}`);
  } finally {
    rmSync(packageTraceDir, { recursive: true, force: true });
    rmSync(executionRoot, { recursive: true, force: true });
  }
});
