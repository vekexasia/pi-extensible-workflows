import assert from "node:assert/strict";
import { type ChildProcess } from "node:child_process";
import { spawnExecutable, terminateProcessTree } from "../src/process-launcher.js";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createAmbientCaseWorktree, createAmbientFixtureRepository, removeAmbientCaseWorktree, removeAmbientFixtureRepository } from "../evals/src/ambient-workflow-evals.js";
import { resolveWorkflowSkillPath } from "../evals/src/workflow-evals.js";
import { decodeTestJsonRecord } from "./support.js";

const enabled = process.env.PI_WORKFLOW_REAL_SESSION === "1";
const functionName = process.env.PI_WORKFLOW_TEST_FUNCTION ?? "tddDev";
const defaultPrompt = functionName === "developUntilApproved"
  ? "Add and export a clampScore(score) function from src/score.js that clamps numeric scores to the inclusive range 0 through 10. Have a developer implement the change, then have a reviewer inspect the implementation and tests; iterate until the reviewer approves. Use the reusable workflow capabilities available in this session and do not implement the feature directly."
  : "Add and export a grade(score) function from src/score.js. It must return 'fail' below 1, 'pass' from 1 through 4, and 'distinction' from 5 upward. Use the reusable TDD workflow capability available in this session with npm test; do not implement the feature directly.";

function terminate(child: ChildProcess): void { void terminateProcessTree(child, "SIGTERM"); }

void test(`a clean real Pi session composes ${functionName} in a workflow script`, { skip: !enabled, timeout: 120_000 }, async () => {
  const sourceAgentDir = process.env.PI_WORKFLOW_EVAL_SOURCE_AGENT_DIR;
  assert.ok(sourceAgentDir, "Set PI_WORKFLOW_EVAL_SOURCE_AGENT_DIR to the Pi agent directory containing auth.json");
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-real-session-"));
  const agentDir = join(root, "agent");
  const sessionDir = join(root, "sessions");
  const packageRoot = resolve(fileURLToPath(new URL("..", import.meta.url)), "..");
  const configuredTraceDir = process.env.PI_WORKFLOW_TRACE_DIR;
  const artifactDir = configuredTraceDir === undefined
    ? resolve(packageRoot, ".tmp", "workflow-real-session")
    : resolve(packageRoot, configuredTraceDir);
  const tracePath = join(artifactDir, "trace.jsonl");
  const repository = createAmbientFixtureRepository(root);
  const worktree = createAmbientCaseWorktree(repository, "real-session");
  mkdirSync(agentDir, { recursive: true, mode: 0o700 });
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  mkdirSync(artifactDir, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", "models.json"]) {
    const source = join(sourceAgentDir, name);
    if (existsSync(source)) copyFileSync(source, join(agentDir, name));
  }
  assert.ok(existsSync(join(agentDir, "auth.json")), `Missing ${join(sourceAgentDir, "auth.json")}`);

  const args = [
    "--offline", "--no-extensions",
    "--extension", fileURLToPath(new URL("../src/index.js", import.meta.url)),
    "--extension", fileURLToPath(new URL("./fixtures/tdd-workflow-extension.js", import.meta.url)),
    "--no-skills", "--skill", resolveWorkflowSkillPath(),
    "--no-context-files", "--no-prompt-templates", "--no-themes", "--no-approve",
    "--tools", "read,bash,grep,find,ls,workflow,workflow_catalog",
    "--provider", "openai-codex", "--model", process.env.PI_WORKFLOW_TEST_MODEL ?? "gpt-5.6-luna", "--thinking", "medium",
    "--mode", "json", "--session-dir", sessionDir, "--session-id", "00000000-0000-4000-8000-000000000001", "--print", process.env.PI_WORKFLOW_TEST_PROMPT ?? defaultPrompt,
  ];

  let buffer = "";
  const lines: string[] = [];
  let workflowCall: Record<string, unknown> | undefined;
  const child = spawnExecutable(process.env.PI_WORKFLOW_TEST_PI ?? "pi", args, {
    cwd: worktree.path,
    env: { ...process.env, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const complete = buffer.split("\n");
    buffer = complete.pop() ?? "";
    for (const line of complete) {
      if (!line || workflowCall) continue;
      lines.push(line);
      try {
        const event = decodeTestJsonRecord(line);
        if (event.type === "tool_execution_start" && event.toolName === "workflow") {
          workflowCall = event;
          writeFileSync(tracePath, `${lines.join("\n")}\n`, { mode: 0o600 });
          terminate(child);
        }
      } catch { /* Preserve non-JSON diagnostics for the assertion below. */ }
    }
  });

  try {
    const exitCode = await new Promise<number | null>((resolveClose, reject) => {
      child.once("error", reject);
      child.once("close", resolveClose);
    });
    if (!workflowCall && buffer) lines.push(buffer);
    if (!existsSync(tracePath)) writeFileSync(tracePath, `${lines.join("\n")}\n`, { mode: 0o600 });
    assert.ok(workflowCall, `Pi exited ${String(exitCode)} before calling workflow. stderr: ${stderr}\nTrace: ${tracePath}`);
    assert.doesNotThrow(() => { for (const line of lines) decodeTestJsonRecord(line); });
    const catalogCalls = lines.map((line) => decodeTestJsonRecord(line)).filter((event) => event.type === "tool_execution_start" && event.toolName === "workflow_catalog");
    assert.ok(catalogCalls.length > 0, `workflow_catalog was not called. Trace: ${tracePath}`);
    const callArgs = workflowCall.args as { name?: unknown; script?: unknown; workflow?: unknown };
    assert.equal(callArgs.workflow, undefined, `The removed workflow selector was used. Trace: ${tracePath}`);
    assert.equal(typeof callArgs.name, "string", `Expected a named workflow. Trace: ${tracePath}`);
    assert.equal(typeof callArgs.script, "string", `Expected an inline workflow script. Trace: ${tracePath}`);
    assert.match(callArgs.script as string, new RegExp(`\\b${functionName}\\s*\\(`));
    if (functionName === "tddDev") assert.match(callArgs.script as string, /npm test/);
    process.stdout.write(`Real workflow trace: ${tracePath}\n`);
  } finally {
    terminate(child);
    removeAmbientCaseWorktree(repository, worktree);
    removeAmbientFixtureRepository(repository);
    rmSync(root, { recursive: true, force: true });
  }
});
