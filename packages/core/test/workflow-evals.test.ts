import assert from "node:assert/strict";
import { spawnSyncExecutable } from "../src/process-launcher.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callUnchecked, executeToolCall, testExtensionContext, testExtensionApi } from "./support.js";
import { Compile } from "typebox/compile";
import { inspectWorkflowScript, WorkflowError } from "../src/index.js";
import evalCaptureExtension from "../evals/src/eval-capture-extension.js";
import { assertEvalScriptSafe, captureEvalCase, captureValidationReports, evalExpectationErrors, extractCapturedWorkflows, extractParentOracle, extractParentToolCalls, findSessionFile, formatEvalSummary, INITIAL_WORKFLOW_EVAL_CASES, loadWorkflowEvalCases, matchesJsonResult, matchesJsonSchema, matchesOutputSchema, parseSemanticJudge, recoverySelectionErrors, replayExpectationErrors, replayWorkflowScript, resolveWorkflowSkillPath, selectStaticCandidate, staticExpectationResults, runIsolatedProcess, runWorkflowEvals, validateWorkflowEvalCases, type ParentOracle } from "../evals/src/workflow-evals.js";

const schema = { type: "object", properties: { answer: { type: "number" }, label: { type: "string" } }, required: ["answer", "label"], additionalProperties: false };
function assertRecord(value: unknown): asserts value is Record<string, unknown> { assert.ok(typeof value === "object" && value !== null && !Array.isArray(value)); }
function assertArray(value: unknown): asserts value is unknown[] { assert.ok(Array.isArray(value)); }
void test("defines the cheap initial evaluation matrix", () => {
  assert.deepEqual(INITIAL_WORKFLOW_EVAL_CASES.map(({ id }) => id), ["custom-model-read", "direct-answer", "mixed-parallel-pipeline", "output-schema", "parallel", "pipeline", "ready-for-agent-parallel-merge", "recovery-completed-worktree", "recovery-failed-run", "required-role", "role-model-mixed", "two-agents"]);
  assert.equal(INITIAL_WORKFLOW_EVAL_CASES.every(({ timeoutMs, maxCost }) => timeoutMs === undefined && maxCost > 0), true);
  const ordinaryCases = INITIAL_WORKFLOW_EVAL_CASES.filter(({ id }) => !id.startsWith("recovery-"));
  assert.equal(ordinaryCases.slice(1).every(({ prompt }) => !prompt.includes("workflow") && !prompt.includes("script:") && !prompt.includes("return agent(")), true);
  assert.ok(resolveWorkflowSkillPath().endsWith(join("skills", "pi-extensible-workflows", "SKILL.md")));
});
void test("finds matching session JSONL files recursively", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-session-files-"));
  try {
    const nested = join(root, "nested");
    mkdirSync(nested);
    writeFileSync(join(root, "incomplete.jsonl"), "{");
    const match = join(nested, "session.jsonl");
    writeFileSync(match, `${JSON.stringify({ id: "target" })}\n`);
    assert.equal(findSessionFile(root, "target"), match);
    assert.equal(findSessionFile(root, "missing"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("loads YAML cases in deterministic filename order and preserves model tokens", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-cases-"));
  try {
    writeFileSync(join(root, "z.yaml"), "id: z\nprompt: z\nmaxCost: 1\nexpectations: {}\n");
    writeFileSync(join(root, "a.yaml"), "id: a\nprompt: a\nmaxCost: 1\nexpectations: {}\n");
    const cases = loadWorkflowEvalCases(root);
    assert.deepEqual(cases.map(({ id }) => id), ["a", "z"]);
    assert.equal(INITIAL_WORKFLOW_EVAL_CASES.find(({ id }) => id === "custom-model-read")?.prompt.includes("$EVAL_MODEL"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("reports YAML paths and field paths for case validation failures", () => {
  const failures = [
    ["unknown.yaml", "id: bad\nprompt: bad\nmaxCost: 1\nexpectations:\n  nope: true\n", "expectations.nope"],
    ["type.yaml", "id: bad\nprompt: bad\nmaxCost: bad\nexpectations: {}\n", "maxCost"],
    ["value.yaml", "id: bad\nprompt: bad\nmaxCost: 1\nexpectations:\n  requiredOperations: [invalid]\n", "expectations.requiredOperations[0]"],
    ["malformed.yaml", "id: [\n", "<document>"],
  ] as const;
  for (const [name, content, field] of failures) {
    const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-invalid-"));
    try {
      writeFileSync(join(root, name), content);
      assert.throws(() => loadWorkflowEvalCases(root), (error: unknown) => error instanceof Error && error.message.includes(name) && error.message.includes(`field ${field}`));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-duplicate-"));
  try {
    const content = "id: same\nprompt: same\nmaxCost: 1\nexpectations: {}\n";
    writeFileSync(join(root, "a.yaml"), content);
    writeFileSync(join(root, "b.yaml"), content);
    assert.throws(() => loadWorkflowEvalCases(root), (error: unknown) => error instanceof Error && error.message.includes("b.yaml") && error.message.includes("field id"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("validates programmatic case overrides before starting Pi", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-override-"));
  const marker = join(root, "called");
  const piPath = join(root, "fake-pi.mjs");
  writeFileSync(piPath, `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "called");\n`);
  try {
    const invalid = { id: "invalid", prompt: "ignored", maxCost: 1, expectations: { unknown: true } };
    await assert.rejects(() => callUnchecked(runWorkflowEvals, undefined, [{ model: "fake/model", piCommand: piPath, cases: [invalid] }]), /options\.cases\[0\].*expectations\.unknown/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("does not publish the eval harness, cases, or fixtures", () => {
  const result = spawnSyncExecutable("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: process.cwd(), encoding: "utf8" });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr.toString());
  const reports = JSON.parse(result.stdout.toString()) as Array<{ files?: Array<{ path: string }> }>;
  const files = reports[0]?.files?.map(({ path }) => path) ?? [];
  assert.ok(files.length > 0);
  assert.equal(files.some((path) => path.startsWith("evals/") || path.startsWith("dist/evals/") || path.startsWith("test/")), false, "eval harness files must stay out of the published package");
});


void test("extracts the parent oracle in assistant-batch and content-part order", () => {
  const parent = extractParentOracle([
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "thinking out loud" }, { type: "toolCall", name: "workflow", id: "one", arguments: { name: "one", script: "return 1;" } }] } },
    { type: "message", message: { role: "toolResult", toolName: "workflow" } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", id: "two", arguments: {} }, { type: "toolCall", name: "workflow", id: "three", arguments: { name: "two", script: "return 2;" } }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "text", text: "child transcript must not be passed here" }] } },
  ]);
  assert.deepEqual(parent.assistantBatches.map(({ tools }) => tools), [["workflow"], ["read", "workflow"], []]);
  assert.deepEqual(parent.assistantBatches[1]?.parts.map((part) => (part as { type?: string }).type), ["toolCall", "toolCall"]);
  assert.deepEqual(parent.firstSignificantAction, { kind: "text" });
  assert.equal(parent.firstTool, "workflow");
  assert.deepEqual(parent.firstBatchToolSequence, ["workflow"]);
  assert.deepEqual(parent.parentToolSequence, ["workflow", "read", "workflow"]);
  assert.equal(parent.workflowCallCount, 2);
  const calls = extractCapturedWorkflows(parent);
  assert.deepEqual(calls.map(({ batch, script }) => ({ batch, script })), [{ batch: 0, script: "return 1;" }, { batch: 1, script: "return 2;" }]);
});
void test("captures exact recovery selections without executing recovery", async () => {
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ details?: unknown }> }> = [];
  evalCaptureExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, getActiveTools: () => ["workflow", "workflow_retry"] }));
  const retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(retry);
  const result = await executeToolCall(retry, "retry-call", { runId: "failed-run-42" }, testExtensionContext) as { details?: unknown };
  assert.deepEqual(result.details, { captured: true, captureIdentity: "pi-extensible-workflows-eval-capture-v1", realWorkflowAgentsLaunched: 0, selection: { tool: "workflow_retry", arguments: { runId: "failed-run-42" } } });
  const oracle = extractParentOracle([
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "workflow_retry", arguments: { runId: "failed-run-42" } }] } },
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "workflow", arguments: { name: "borrow-worktree", script: "return true;", parentRunId: "completed-run-42" } }] } },
  ]);
  assert.deepEqual(extractParentToolCalls(oracle), [
    { name: "workflow_retry", arguments: { runId: "failed-run-42" } },
    { name: "workflow", arguments: { name: "borrow-worktree", script: "return true;", parentRunId: "completed-run-42" } },
  ]);
  assert.deepEqual(recoverySelectionErrors({ id: "recovery-failed-run" }, extractParentOracle([{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "workflow_retry", arguments: { runId: "failed-run-42" } }] } }])), []);
  assert.deepEqual(recoverySelectionErrors({ id: "recovery-completed-worktree" }, extractParentOracle([{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "workflow", arguments: { name: "borrow-worktree", script: "return true;", parentRunId: "completed-run-42" } }] } }])), []);
});
void test("fixture scoring rejects completed-worktree recovery with wrong arguments", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-recovery-worktree-args-"));
  const piPath = join(root, "fake-pi.mjs");
  writeFileSync(piPath, `import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const args = process.argv.slice(2); const value = name => args[args.indexOf(name) + 1]; const sessionDir = value("--session-dir"); const id = value("--session-id"); mkdirSync(sessionDir, { recursive: true }); const assistant = { role: "assistant", content: [{ type: "toolCall", name: "workflow", arguments: { name: "borrow-worktree", script: "return true;", parentRunId: "wrong-run" } }] }; writeFileSync(join(sessionDir, "parent.jsonl"), [{ type: "session", version: 3, id, cwd: process.cwd() }, { type: "message", message: assistant }].map(JSON.stringify).join("\\n") + "\\n");`);
  try {
    const result = await captureEvalCase({ case: { id: "recovery-completed-worktree", prompt: "borrow completed-run-42", maxCost: 1, expectedWorkflowCalls: 1, expectations: { firstTool: "workflow", firstBatchToolSequence: ["workflow"], parentToolSequence: ["workflow"], workflowCallCount: 1 } }, model: "fake/model", piCommand: piPath, maxCost: 1 });
    assert.equal(result.status, "failed");
    assert.ok(result.errors.some((error) => error.includes("completed-run-42")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("eval Pi children get an isolated profile, temp and no Herdr pane variables", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi workflow eval env ü-"));
  const piPath = join(root, "fake pi.mjs");
  const capture = join(root, "env.json");
  // No shebang or executable bit: the launcher runs Node entrypoints on process.execPath on every platform.
  writeFileSync(piPath, `import { writeFileSync } from "node:fs"; const keys = ["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "PI_CODING_AGENT_DIR", "TEMP", "TMP", "TMPDIR", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "Herdr_Tab_Id"]; writeFileSync(${JSON.stringify(capture)}, JSON.stringify(Object.fromEntries(keys.map((key) => [key, process.env[key] ?? null])))); process.exit(0);\n`);
  const previous = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH, Herdr_Tab_Id: process.env.Herdr_Tab_Id };
  Object.assign(process.env, { HERDR_ENV: "1", HERDR_PANE_ID: "parent-pane", HERDR_SOCKET_PATH: join(root, "herdr.sock"), Herdr_Tab_Id: "parent-tab" });
  try {
    await captureEvalCase({ case: { id: "isolated-env", prompt: "noop", maxCost: 1, expectations: {} }, model: "fake/model", piCommand: piPath, maxCost: 1 });
    const env = JSON.parse(readFileSync(capture, "utf8")) as Record<string, string | null>;
    for (const key of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "Herdr_Tab_Id"]) assert.equal(env[key], null, key);
    const home = env.HOME ?? "";
    assert.match(home, /pi-workflow-capture-[^\\/]+[\\/]home$/);
    assert.equal(env.USERPROFILE, home);
    for (const key of ["APPDATA", "LOCALAPPDATA", "PI_CODING_AGENT_DIR", "TEMP", "TMP", "TMPDIR"]) assert.ok(env[key]?.startsWith(home), `${key}=${String(env[key])}`);
    assert.equal(existsSync(home), false, "the disposable case root is removed");
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) Reflect.deleteProperty(process.env, key); else process.env[key] = value;
    rmSync(root, { recursive: true, force: true });
  }
});
void test("fixture scoring rejects a recovery tool call with the wrong run ID", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-recovery-args-"));
  const piPath = join(root, "fake-pi.mjs");
  writeFileSync(piPath, `import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const args = process.argv.slice(2); const value = name => args[args.indexOf(name) + 1]; const sessionDir = value("--session-dir"); const id = value("--session-id"); mkdirSync(sessionDir, { recursive: true }); const assistant = { role: "assistant", content: [{ type: "toolCall", name: "workflow_retry", arguments: { runId: "wrong-run" } }] }; writeFileSync(join(sessionDir, "parent.jsonl"), [{ type: "session", version: 3, id, cwd: process.cwd() }, { type: "message", message: assistant }].map(JSON.stringify).join("\\n") + "\\n");`);
  try {
    const result = await captureEvalCase({ case: { id: "recovery-failed-run", prompt: "retry failed-run-42", maxCost: 1, expectedWorkflowCalls: 0, expectations: { firstTool: "workflow_retry", firstBatchToolSequence: ["workflow_retry"], parentToolSequence: ["workflow_retry"], workflowCallCount: 0 } }, model: "fake/model", piCommand: piPath, maxCost: 1 });
    assert.equal(result.status, "failed");
    assert.ok(result.errors.some((error) => error.includes("failed-run-42")));
    assert.deepEqual(recoverySelectionErrors({ id: "recovery-failed-run" }, result.oracle as ParentOracle), result.errors.filter((error) => error.includes("failed-run-42")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("matches captured validation results by tool-call id and retains schema-boundary errors", () => {
  const oracle = extractParentOracle([
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "bad", name: "workflow", arguments: [] }, { type: "toolCall", id: "good", name: "workflow", arguments: { name: "registered", script: "return 1" } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "good", toolName: "workflow", content: [{ type: "text", text: "captured" }], details: { captureIdentity: "pi-extensible-workflows-eval-capture-v1", realWorkflowAgentsLaunched: 0, validation: { valid: true, script: "return 1" } }, isError: false } },
    { type: "message", message: { role: "toolResult", toolCallId: "bad", toolName: "workflow", content: [{ type: "text", text: "Tool input validation failed" }], isError: true } },
  ]);
  const calls = extractCapturedWorkflows(oracle);
  assert.deepEqual(calls.map(({ toolCallId, arguments: args, script }) => ({ toolCallId, args, script })), [{ toolCallId: "bad", args: [], script: undefined }, { toolCallId: "good", args: { name: "registered", script: "return 1" }, script: "return 1" }]);
  assert.deepEqual(captureValidationReports(oracle, calls), { reports: [{ callIndex: 0, valid: false, message: "Tool input validation failed" }, { callIndex: 1, valid: true }], errors: [], verified: true });
});

void test("captures production-validated calls without execution and judges the first static candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-fake-pi-"));
  const piPath = join(root, "fake-pi.mjs");
  writeFileSync(piPath, `import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const args = process.argv.slice(2); const value = name => args[args.indexOf(name) + 1]; if (args.includes("--no-tools")) { console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ criteria: [{ id: "intent", pass: true, evidence: "reviewer agent returns the review" }] }) }], provider: "fake", model: "judge", usage: { input: 5, output: 6, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } } })); process.exit(0); } const sessionDir = value("--session-dir"); const id = value("--session-id"); if (!value("--skill")?.endsWith(join("skills", "pi-extensible-workflows", "SKILL.md"))) process.exit(2); if (!value("--extension")?.endsWith(join("eval-capture-extension.js"))) process.exit(3); mkdirSync(sessionDir, { recursive: true }); const script = 'return await agent("fake", { role: "reviewer" });'; const rows = [{ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: process.cwd() }, { type: "message", id: "bad", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "bad-call", name: "workflow", arguments: { script } }], provider: "fake", model: "parent", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } } }, { type: "message", id: "bad-result", parentId: "bad", timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "bad-call", toolName: "workflow", content: [{ type: "text", text: "pi-extensible-workflows-eval-capture-v1:INVALID_METADATA: Inline workflows require name" }], isError: true } }, { type: "message", id: "good", parentId: "bad-result", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "good-call", name: "workflow", arguments: { name: "review", script } }], provider: "fake", model: "parent", usage: { input: 2, output: 4, cacheRead: 0, cost: { total: 0.01 } } } }, { type: "message", id: "good-result", parentId: "good", timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "good-call", toolName: "workflow", content: [{ type: "text", text: "captured" }], details: { captureIdentity: "pi-extensible-workflows-eval-capture-v1", realWorkflowAgentsLaunched: 0, validation: { valid: true, script } }, isError: false } }]; writeFileSync(join(sessionDir, "parent.jsonl"), rows.map(JSON.stringify).join("\\n") + "\\n");`);
  const result = await runIsolatedProcess({ case: { id: "capture", prompt: "review this", timeoutMs: 10_000, maxCost: 1, expectations: { workflowCallCount: { min: 1 }, requiredRoles: ["reviewer"] }, semanticCriteria: [{ id: "intent", description: "Return a reviewer assessment." }] }, model: "fake/model", piCommand: piPath, maxCost: 1 }, { childPath: join(process.cwd(), "dist/evals/src/workflow-evals-child.js"), timeoutMs: 25_000 });
  assertRecord(result.value);
  assert.equal(result.value.status, "passed");
  assertArray(result.value.workflows);
  assert.equal(result.value.workflows.length, 2);
  assertArray(result.value.productionValidation);
  assert.deepEqual(result.value.productionValidation, [{ callIndex: 0, valid: false, errorCode: "INVALID_METADATA", message: "pi-extensible-workflows-eval-capture-v1:INVALID_METADATA: Inline workflows require name" }, { callIndex: 1, valid: true }]);
  assertRecord(result.value.metrics);
  assertArray(result.value.metrics.candidateCallIndices);
  assert.deepEqual(result.value.metrics.candidateCallIndices, [1]);
  assert.equal(result.value.metrics.invalidWorkflowCallCount, 1);
  assert.equal(result.value.metrics.surplusWorkflowCallCount, 0);
  assert.equal(result.value.metrics.parentOutputTokensThroughCandidate, 7);
  const semanticJudge = result.value.semanticJudge;
  assertRecord(semanticJudge);
  assertArray(semanticJudge.criteria);
  assert.equal(semanticJudge.criteria.length, 1);
  const accounting = result.value.accounting;
  assertRecord(accounting);
  assert.equal(accounting.totalTokens, 22);
  assert.equal(accounting.cost, 0.04);
  const cleanup = result.value.cleanup;
  assertRecord(cleanup);
  assert.equal(cleanup.captureIdentityVerified, true);
  assert.equal(cleanup.realWorkflowAgentsLaunched, 0);
  assert.equal(cleanup.tempRootRemoved, true);
});

void test("stops after a persisted validated capture without another parent turn", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-stop-after-capture-"));
  const piPath = join(root, "fake-pi.mjs");
  const marker = join(root, "extra-parent-turn");
  try {
    writeFileSync(piPath, `import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const args = process.argv.slice(2); const value = name => args[args.indexOf(name) + 1]; if (args.includes("--no-tools")) { console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ criteria: [{ id: "intent", pass: true, evidence: "capture persisted" }] }) }], provider: "fake", model: "judge", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } } })); process.exit(0); } const sessionDir = value("--session-dir"); const id = value("--session-id"); mkdirSync(sessionDir, { recursive: true }); const sessionPath = join(sessionDir, "parent.jsonl"); const script = 'return agent("captured")'; const assistant = { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "workflow", arguments: { name: "captured", script } }], provider: "fake", model: "parent", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } }; const result = { role: "toolResult", toolCallId: "call-1", toolName: "workflow", content: [{ type: "text", text: "captured" }], details: { captureIdentity: "pi-extensible-workflows-eval-capture-v1", realWorkflowAgentsLaunched: 0, validation: { valid: true, script } }, isError: false }; const rows = [{ type: "session", version: 3, id, cwd: process.cwd() }, { type: "message", message: assistant }]; writeFileSync(sessionPath, rows.map(JSON.stringify).join("\\n") + "\\n"); console.log(JSON.stringify({ type: "message_end", message: assistant })); setTimeout(() => { rows.push({ type: "message", message: result }); writeFileSync(sessionPath, rows.map(JSON.stringify).join("\\n") + "\\n"); console.log(JSON.stringify({ type: "message_end", message: result })); console.log(JSON.stringify({ type: "turn_end", message: assistant, toolResults: [result] })); setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "extra-parent-turn"), 2_000); }, 50); setInterval(() => {}, 1000);`);
    const result = await captureEvalCase({ case: { id: "capture-stop", prompt: "capture one workflow", timeoutMs: 1_000, maxCost: 1, expectations: { workflowCallCount: 1 }, semanticCriteria: [{ id: "intent", description: "Capture the workflow." }] }, model: "fake/model", piCommand: piPath, maxCost: 1 });
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.equal(result.oracle?.assistantBatches.length, 1);
    assert.equal(result.workflows.length, 1);
    assert.equal(result.accounting.totalTokens, 7);
    assert.equal(result.accountingTrustworthy, true);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("stops at agent_end when no workflow call occurs", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-agent-end-"));
  const piPath = join(root, "fake-pi.mjs");
  const marker = join(root, "extra-parent-turn");
  try {
    writeFileSync(piPath, `import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const args = process.argv.slice(2); const value = name => args[args.indexOf(name) + 1]; const sessionDir = value("--session-dir"); const id = value("--session-id"); mkdirSync(sessionDir, { recursive: true }); const assistant = { role: "assistant", content: [{ type: "text", text: "direct answer" }], provider: "fake", model: "parent", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } }; writeFileSync(join(sessionDir, "parent.jsonl"), [{ type: "session", version: 3, id, cwd: process.cwd() }, { type: "message", message: assistant }].map(JSON.stringify).join("\\n") + "\\n"); console.log(JSON.stringify({ type: "message_end", message: assistant })); console.log(JSON.stringify({ type: "agent_end", messages: [assistant] })); setTimeout(() => writeFileSync(${JSON.stringify(marker)}, "extra-parent-turn"), 2_000); setInterval(() => {}, 1000);`);
    const result = await captureEvalCase({ case: { id: "direct-stop", prompt: "answer directly", timeoutMs: 1_000, maxCost: 1, expectations: { workflowCallCount: 0 }, expectedWorkflowCalls: 0 }, model: "fake/model", piCommand: piPath, maxCost: 1 });
    assert.equal(result.status, "passed", JSON.stringify(result));
    assert.equal(result.oracle?.assistantBatches.length, 1);
    assert.equal(result.workflows.length, 0);
    assert.equal(result.accounting.totalTokens, 5);
    assert.equal(result.accountingTrustworthy, true);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("selects the required valid workflow set and records surplus valid calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-multiple-valid-"));
  const piPath = join(root, "fake-pi.mjs");
  writeFileSync(piPath, [
    "import { mkdirSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';",
    "const args = process.argv.slice(2); const value = name => args[args.indexOf(name) + 1];",
    "if (args.includes('--no-tools')) { console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ criteria: [{ id: 'intent', pass: true, evidence: 'two valid workflow calls' }] }) }], provider: 'fake', model: 'judge', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } } })); process.exit(0); }",
    "const sessionDir = value('--session-dir'); const id = value('--session-id'); mkdirSync(sessionDir, { recursive: true });",
    "const scripts = ['return agent(\"api\")', 'return agent(\"ui\")', 'return agent(\"surplus\")'];",
    "const rows = [{ type: 'session', version: 3, id, cwd: process.cwd() }];",
    `for (const [index, script] of scripts.entries()) { const toolCallId = 'call-' + index; rows.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: 'workflow', arguments: { name: 'workflow-' + index, script } }] } }, { type: 'message', message: { role: 'toolResult', toolCallId, toolName: 'workflow', content: [{ type: 'text', text: 'captured' }], details: { captureIdentity: 'pi-extensible-workflows-eval-capture-v1', realWorkflowAgentsLaunched: 0, validation: { valid: true, script } }, isError: false } }); }`,
    "writeFileSync(join(sessionDir, 'parent.jsonl'), rows.map(JSON.stringify).join('\\n') + '\\n');",
  ].join("\n"));
  const result = await runIsolatedProcess({ case: { id: "multiple-valid", prompt: "delegate twice", timeoutMs: 10_000, maxCost: 1, expectations: { workflowCallCount: { min: 2 }, minimumAgentCalls: 2 }, expectedWorkflowCalls: 2, semanticCriteria: [{ id: "intent", description: "Use both results." }] }, model: "fake/model", piCommand: piPath, maxCost: 1 }, { childPath: join(process.cwd(), "dist/evals/src/workflow-evals-child.js"), timeoutMs: 25_000 });
  assertRecord(result.value);
  assert.equal(result.value.status, "passed");
  assertArray(result.value.workflows);
  assert.equal(result.value.workflows.length, 3);
  assertArray(result.value.productionValidation);
  assert.equal(result.value.productionValidation.filter((item) => { assertRecord(item); return item.valid === true; }).length, 3);
  assertRecord(result.value.metrics);
  assertArray(result.value.metrics.candidateCallIndices);
  assert.deepEqual(result.value.metrics.candidateCallIndices, [0, 1]);
  assert.equal(result.value.metrics.surplusWorkflowCallCount, 1);
  const semanticJudge = result.value.semanticJudge;
  assertRecord(semanticJudge);
  assertArray(semanticJudge.criteria);
  assert.equal(semanticJudge.criteria.length, 1);
  rmSync(root, { recursive: true, force: true });
});

void test("skips the semantic judge when every captured call fails production validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-invalid-"));
  const piPath = join(root, "fake-pi.mjs");
  const marker = join(root, "judge-ran");
  writeFileSync(piPath, `import { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const args = process.argv.slice(2); const value = name => args[args.indexOf(name) + 1]; if (args.includes("--no-tools")) { writeFileSync(${JSON.stringify(marker)}, "unexpected"); process.exit(9); } const dir = value("--session-dir"); const id = value("--session-id"); mkdirSync(dir, { recursive: true }); const rows = [{ type: "session", version: 3, id, cwd: process.cwd() }, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "bad", name: "workflow", arguments: { script: "return 1" } }], provider: "fake", model: "parent", usage: { input: 1, output: 1, cost: { total: 0.01 } } } }, { type: "message", message: { role: "toolResult", toolCallId: "bad", toolName: "workflow", content: [{ type: "text", text: "pi-extensible-workflows-eval-capture-v1:INVALID_METADATA: Inline workflows require name" }], isError: true } }]; writeFileSync(join(dir, "parent.jsonl"), rows.map(JSON.stringify).join("\\n") + "\\n");`);
  const result = await runIsolatedProcess({ case: { id: "invalid", prompt: "delegate", timeoutMs: 10_000, maxCost: 1, expectations: { workflowCallCount: { min: 1 } }, semanticCriteria: [{ id: "intent", description: "delegate" }] }, model: "fake/model", piCommand: piPath, maxCost: 1 }, { childPath: join(process.cwd(), "dist/evals/src/workflow-evals-child.js"), timeoutMs: 25_000 });
  assertRecord(result.value);
  assert.equal(result.value.status, "failed");
  assertRecord(result.value.metrics);
  assert.equal(result.value.metrics.anyValidCandidate, false);
  assert.equal(result.value.semanticJudge, undefined);
  assertArray(result.value.errors);
  assert.match(result.value.errors.join("\n"), /Catastrophic validity failure/);
  assert.equal(existsSync(marker), false);
  rmSync(root, { recursive: true, force: true });
});

void test("static workflow inspection exposes roles, retries, schemas, and execution structure", () => {
  const calls = inspectWorkflowScript(`phase("review"); await parallel("batch", { one: () => agent("one", { role: "scout" }), two: () => agent("two", { retries: 0, outputSchema: ${JSON.stringify(schema)} }) }); await pipeline("pipe", { item: 1 }, { check: value => agent("check:" + value) }); await agent("after");`);
  assert.deepEqual(calls.map(({ kind, name, role, retries, outputSchema, execution, structure }) => ({ kind, name, role, retries: retries ?? null, hasSchema: outputSchema !== undefined, execution, structure })), [
    { kind: "phase", name: "review", role: null, retries: null, hasSchema: false, execution: "sequential", structure: [] },
    { kind: "parallel", name: "batch", role: null, retries: null, hasSchema: false, execution: "parallel", structure: [] },
    { kind: "agent", name: null, role: "scout", retries: null, hasSchema: false, execution: "parallel", structure: [{ kind: "parallel", name: "batch", key: "one" }] },
    { kind: "agent", name: null, role: null, retries: 0, hasSchema: true, execution: "parallel", structure: [{ kind: "parallel", name: "batch", key: "two" }] },
    { kind: "pipeline", name: "pipe", role: null, retries: null, hasSchema: false, execution: "sequential", structure: [] },
    { kind: "agent", name: null, role: null, retries: null, hasSchema: false, execution: "sequential", structure: [{ kind: "pipeline", name: "pipe", key: "check" }] },
    { kind: "agent", name: null, role: null, retries: null, hasSchema: false, execution: "sequential", structure: [] },
  ]);
  assert.equal(inspectWorkflowScript(`agent("label", { label: "named" })`)[0]?.label, "named");
  assert.deepEqual(inspectWorkflowScript(`agent("read", { tools: [] })`)[0]?.options, { tools: [] });
  assertEvalScriptSafe(`agent("safe", { retries: 0 });`);
  assert.throws(() => { assertEvalScriptSafe(`agent("unsafe", { retries: 1 });`); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.deepEqual(evalExpectationErrors(extractParentOracle([{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "workflow", arguments: {} }, { type: "toolCall", name: "read", arguments: {} }] } }]), { firstBatchToolSequence: { startsWith: ["workflow"] }, parentToolSequence: { equals: ["workflow", "read"] }, workflowCallCount: { min: 1, max: 2 } }), []);
  assert.equal(evalExpectationErrors(extractParentOracle([{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read", arguments: {} }, { type: "toolCall", name: "workflow", arguments: {} }] } }]), { firstTool: "workflow" }).length, 1);
});

void test("replays parallel and pipeline composition with prompt interpolation and ordered stages", async () => {
  const replayed = await replayWorkflowScript(`const reports = await parallel("review", { api: () => agent("API", { role: "scout" }), ui: () => agent("UI", { role: "scout" }) }); const synthesis = await agent(prompt("Reports: {reports}", { reports }), { role: "synth" }); return await pipeline("finish", { result: synthesis }, { normalize: value => value.toUpperCase(), mark: value => value + "!" });`);
  assert.deepEqual(replayed.result, { result: "FAKE:REPORTS: {\n  \"API\": \"FAKE:API\",\n  \"UI\": \"FAKE:UI\"\n}!" });
  assert.equal(replayed.trace.maxConcurrentAgents, 2);
  assert.deepEqual(replayed.trace.agentCalls.map(({ prompt, options }) => ({ prompt, role: options.role })), [
    { prompt: "API", role: "scout" },
    { prompt: "UI", role: "scout" },
    { prompt: "Reports: {\n  \"api\": \"fake:API\",\n  \"ui\": \"fake:UI\"\n}", role: "synth" },
  ]);
  assert.deepEqual(replayed.trace.agentCalls.slice(0, 2).map(({ identity }) => identity.structuralPath), [["review", "api"], ["review", "ui"]]);
  assert.deepEqual(replayed.trace.agentCalls[2]?.identity.structuralPath, []);
});

void test("replay keeps pipeline stages sequential for each keyed item", async () => {
  const replayed = await replayWorkflowScript(`return pipeline("pipe", { item: "seed" }, { first: value => agent("first:" + value), second: value => agent("second:" + value) });`);
  assert.deepEqual(replayed.result, { item: "fake:second:fake:first:seed" });
  assert.deepEqual(replayed.trace.agentCalls.map(({ prompt, identity }) => ({ prompt, path: identity.structuralPath })), [
    { prompt: "first:seed", path: ["pipe", "item", "first"] },
    { prompt: "second:fake:first:seed", path: ["pipe", "item", "second"] },
  ]);
});

void test("replays outputSchema values and checks their shape", async () => {
  const replayed = await replayWorkflowScript(`const result = await agent("count", { role: "reviewer", outputSchema: ${JSON.stringify(schema)} }); return result;`);
  assert.ok(matchesJsonSchema(Compile(schema), replayed.result));
  assert.deepEqual(replayed.result, { answer: 1, label: "fake" });
  const firstAgent = replayed.trace.agentCalls[0];
  assert.ok(firstAgent);
  assert.equal(firstAgent.options.role, "reviewer");
  assert.deepEqual(firstAgent.options.outputSchema, schema);
  assert.equal(matchesJsonResult({ type: "object", requiredKeys: ["answer"], propertyTypes: { answer: "integer" }, forbiddenProperties: ["extra"] }, replayed.result), true);
  assert.equal(matchesJsonResult({ type: "object", propertyTypes: { answer: "number" } }, replayed.result), true);
  assert.equal(matchesJsonResult({ nonEmpty: true }, "done"), true);
  assert.equal(matchesJsonResult({ nonEmpty: true }, ""), false);
  assert.equal(matchesOutputSchema({ type: "object", requiredKeys: ["answer", "label"], propertyTypes: { answer: "number", label: "string" }, forbiddenProperties: ["extra"] }, schema), true);
  assert.equal(matchesOutputSchema({ type: "object", propertyTypes: { answer: "number" } }, { type: "object", properties: { answer: { type: "integer" } } }), true);
  assert.equal(matchesOutputSchema({ type: "object", requiredKeys: ["answer"], propertyTypes: { answer: "string" } }, schema), false);
  const semanticErrors = replayExpectationErrors([{ batch: 0, arguments: { script: `return agent("count", { outputSchema: ${JSON.stringify(schema)} });` }, script: `return agent("count", { outputSchema: ${JSON.stringify(schema)} });` }], [{ script: "", result: { answer: 1, label: "fake" } }], { requireOutputSchema: { type: "object", requiredKeys: ["answer", "label"], propertyTypes: { answer: "number", label: "string" } }, expectedResults: [{ equals: { answer: 2, label: "fake" } }] });
  assert.deepEqual(semanticErrors, ["replay result 0 did not equal the expected JSON"]);
  assert.deepEqual(replayExpectationErrors([{ batch: 0, arguments: {}, script: `return agent("count", { role: "reviewer", outputSchema: ${JSON.stringify(schema)} });` }], [{ script: "", result: replayed.result, trace: replayed.trace }], { agentPolicies: [{ callIndex: 0, role: "reviewer", forbidOptions: ["model", "thinking", "tools"] }] }), []);
  assert.ok(replayExpectationErrors([{ batch: 0, arguments: {}, script: `return agent("read", { tools: ["read", "bash"] });` }], [{ script: "", result: "ok", trace: { ...replayed.trace, agentCalls: [{ ...firstAgent, options: { tools: ["read", "bash"] } }] } }], { agentPolicies: [{ callIndex: 0, tools: { mode: "exact", values: ["read"] } }] }).some((error) => error.includes("tools were")));
  assert.ok(replayExpectationErrors([{ batch: 0, arguments: { script: `return agent("count", { outputSchema: { type: "object" } });` }, script: `return agent("count", { outputSchema: { type: "object" } });` }], [{ script: "", result: {} }], { requireOutputSchema: { type: "object", requiredKeys: ["answer"] } }).some((error) => error.includes("no outputSchema matching")));
  const staticCalls = [{ batch: 0, arguments: {}, script: `const review = await agent("review", { role: "reviewer" }); return agent(prompt("Use {review}", { review }), { model: "p/m", tools: [] });` }];
  const staticResults = staticExpectationResults(staticCalls, { requiredAgentOrder: [{ role: "reviewer" }, { model: "p/m" }], requiredDataFlow: [{ binding: "review", toAgentIndex: 1 }], agentPolicies: [{ callIndex: 1, tools: { mode: "empty" }, forbidOptions: ["retries"] }], requiredAgentStructures: [{ execution: "sequential", agents: [{ role: "reviewer" }, { model: "p/m" }] }] });
  assert.equal(staticResults.every(({ pass }) => pass), true);
  const dynamicOptions = inspectWorkflowScript('agent("x", { tools: [], outputSchema: schema })')[0];
  assert.ok(dynamicOptions);
  assert.deepEqual(dynamicOptions.options?.tools, []);
  assert.deepEqual(dynamicOptions.optionKeys, ["tools", "outputSchema"]);
  const forbiddenResult = staticExpectationResults([{ batch: 0, arguments: {}, script: 'parallel("p", { one: () => agent("x") })' }], { forbiddenOperations: ["pipeline"] })[0];
  assert.ok(forbiddenResult);
  assert.equal(forbiddenResult.pass, true);
  const parallelStructure = staticExpectationResults([{ batch: 0, arguments: {}, script: 'parallel("p", { one: () => agent("api"), two: () => agent("ui") }); agent("after")' }], { requiredAgentStructures: [{ execution: "parallel", operation: "parallel", agents: [{ promptIncludes: "api" }, { promptIncludes: "ui" }] }, { execution: "sequential", agents: [{ promptIncludes: "after" }] }] });
  assert.equal(parallelStructure.every(({ pass }) => pass), true);
  const isolatedScript = 'const results = await parallel("fixes", { one: () => withWorktree("one", () => agent("one", { role: "developer" })), two: () => withWorktree("two", () => agent("two", { role: "developer" })) }); return agent(prompt("merge {results}", { results }), { role: "developer" });';
  const isolatedExpectations = { requiredOperations: ["withWorktree" as const], agentPolicies: [{ callIndex: 0, role: "developer" }, { callIndex: 1, role: "developer" }, { callIndex: 2, role: "developer" }], requiredDataFlow: [{ binding: "results", toAgentIndex: 2 }] };
  assert.equal(staticExpectationResults([{ batch: 0, arguments: {}, script: isolatedScript }], isolatedExpectations).every(({ pass }) => pass), true);
  assert.deepEqual(inspectWorkflowScript(isolatedScript).filter(({ kind }) => kind === "withWorktree").map(({ name }) => name), ["one", "two"]);
  const isolatedReplay = await replayWorkflowScript(isolatedScript);
  assert.deepEqual(replayExpectationErrors([{ batch: 0, arguments: {}, script: isolatedScript }], [{ script: isolatedScript, ...isolatedReplay }], isolatedExpectations), []);
  const setCalls = [
    { batch: 0, arguments: {}, script: 'agent("wrong", { role: "scout" })' },
    { batch: 1, arguments: {}, script: 'agent("review", { role: "reviewer" })' },
    { batch: 2, arguments: {}, script: 'agent("finish")' },
  ];
  assert.deepEqual(selectStaticCandidate(setCalls, setCalls.map((_, callIndex) => ({ callIndex, valid: true })), { agentPolicies: [{ callIndex: 0, role: "reviewer" }], minimumAgentCalls: 2 }, 2).callIndices, [1, 2]);
  const multipleValidCalls = [
    { batch: 0, arguments: {}, script: 'agent("api")' },
    { batch: 1, arguments: {}, script: 'agent("ui")' },
    { batch: 2, arguments: {}, script: 'agent("surplus")' },
  ];
  assert.deepEqual(selectStaticCandidate(multipleValidCalls, multipleValidCalls.map((_, callIndex) => ({ callIndex, valid: true })), { minimumAgentCalls: 1 }, 2).callIndices, [0, 1]);
  assert.deepEqual(selectStaticCandidate(staticCalls, [{ callIndex: 0, valid: true }], { requiredRoles: ["reviewer"] }).callIndices, [0]);
  assert.deepEqual(parseSemanticJudge('{"criteria":[{"id":"intent","pass":true,"evidence":"agent returns review"}]}', [{ id: "intent", description: "review" }]), [{ id: "intent", pass: true, evidence: "agent returns review" }]);
});

void test("isolates eval cases in separate OS processes and cleans up timed-out groups", async () => {
  const child = mkdtempSync(join(tmpdir(), "pi-workflow-eval-test-child-"));
  const childPath = join(child, "child.mjs");
  writeFileSync(childPath, `import { readFileSync, writeFileSync } from "node:fs"; const input = JSON.parse(readFileSync(process.argv[2], "utf8")); writeFileSync(input.outputPath, JSON.stringify({ pid: process.pid, cwd: process.cwd(), home: process.env.HOME, caseRoot: process.env.PI_WORKFLOW_EVAL_CASE_ROOT, marker: input.payload.marker }));`);
  const first = await runIsolatedProcess({ marker: "first" }, { childPath });
  const second = await runIsolatedProcess({ marker: "second" }, { childPath, timeoutMs: 2_000 });
  assertRecord(first.value);
  assertRecord(second.value);
  assert.equal(first.value.marker, "first");
  assert.equal(second.value.marker, "second");
  assert.notEqual(first.value.pid, second.value.pid);
  assert.notEqual(first.value.cwd, second.value.cwd);
  assert.notEqual(first.value.home, second.value.home);
  assert.equal(first.value.caseRoot, first.value.cwd);
  assert.equal(second.value.caseRoot, second.value.cwd);
  const slowPath = join(child, "slow.mjs");
  writeFileSync(slowPath, "setTimeout(() => {}, 10_000);");
  const timedOut = await runIsolatedProcess(slowPath, { childPath: slowPath, timeoutMs: 50 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.processGroupTerminated, true);
  assert.equal(timedOut.value, undefined);
});

void test("parent oracle accounting ignores child-style entries", () => {
  const oracle: ParentOracle = extractParentOracle([{ type: "message", message: { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "ok" }], usage: { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, cost: { total: 0.25 } } } }]);
  assert.deepEqual(oracle.usage, { input: 2, output: 3, cacheRead: 4, cacheWrite: 5, totalTokens: 14, cost: 0.25, models: [{ model: "p/m", cost: 0.25 }] });
});

void test("uses the effective remaining spend ceiling for untrusted case fallbacks", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-budget-"));
  const fakePi = join(root, "fake-pi.mjs");
  const seededRole = join(root, "seeded-role");
  writeFileSync(fakePi, `import { existsSync, readFileSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const globalRole = join(process.env.HOME, ".pi", "agent", "pi-extensible-workflows", "roles", "developer.md"); const projectRole = join(process.cwd(), ".pi", "pi-extensible-workflows", "roles", "developer.md"); if (!existsSync(globalRole) || existsSync(projectRole)) { console.error(JSON.stringify({ globalRole, exists: existsSync(globalRole), projectRole, projectExists: existsSync(projectRole) })); process.exit(8); } const content = readFileSync(globalRole, "utf8"); if (!content.includes("model: fake/model") || !content.includes("tools: [read, grep, find, bash]")) { console.error(content); process.exit(9); } writeFileSync(${JSON.stringify(join(root, "seeded-role"))}, "ok"); process.exit(7);\n`);
  try {
    const progress: string[] = [];
    const result = await runWorkflowEvals({
      cases: [
        { id: "first", prompt: "ignored", timeoutMs: 2_000, maxCost: 0.1, expectations: {} },
        { id: "second", prompt: "ignored", timeoutMs: 2_000, maxCost: 0.1, expectations: {} },
      ],
      model: "fake/model",
      piCommand: fakePi,
      artifactsDir: join(root, "artifacts"),
      spendCeiling: 0.15,
      onProgress: (message) => { progress.push(message); },
    });
    assert.deepEqual(result.cases.map(({ accounting, limits }) => [accounting.cost.toFixed(2), limits.maxCost.toFixed(2)]), [["0.10", "0.10"], ["0.05", "0.05"]]);
    assert.equal(result.spent.toFixed(2), "0.15");
    assert.equal(existsSync(seededRole), true, JSON.stringify(result.cases));
    assert.match(progress.join("\n"), /first: starting[\s\S]*first: failed/);
    assert.match(formatEvalSummary(result), /first: failed[\s\S]*error:[\s\S]*Artifacts:/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("validates the complete eval contract and rejects shape and range errors", () => {
  const valid = {
    id: "complete", prompt: "Run every check", timeoutMs: 1000, maxCost: 0.5, expectedWorkflowCalls: 2,
    expectations: {
      firstSignificantAction: { kind: "tool", name: "workflow" }, firstTool: "workflow",
      firstBatchToolSequence: { startsWith: ["workflow"] }, parentToolSequence: { equals: ["workflow", "read"] },
      workflowCallCount: { min: 1, max: 2 }, requiredOperations: ["agent", "parallel"], forbiddenOperations: ["shell"],
      requiredRoles: ["reviewer"], minimumAgentCalls: 2, requireOutputSchema: { type: "object", requiredKeys: ["answer"], propertyTypes: { answer: "number" }, minCount: 1 },
      expectedResults: [{ workflowIndex: 0, match: { type: "object", properties: { answer: { type: "number", nonEmpty: true } } } }],
      agentPolicies: [{ callIndex: 0, role: "reviewer", model: "fake/model", forbidOptions: ["retries"], tools: { mode: "exact", values: ["read"] } }],
      requiredAgentOrder: [{ role: "reviewer", execution: "sequential" }],
      requiredAgentStructures: [{ execution: "parallel", operation: "parallel", agents: [{ role: "reviewer", promptIncludes: "review" }] }],
      requiredDataFlow: [{ binding: "review", toAgentIndex: 1 }],
    },
    semanticCriteria: [{ id: "quality", description: "The answer is useful" }],
  };
  assert.deepEqual(validateWorkflowEvalCases([valid], "complete"), [valid]);
  const failures: readonly [string, unknown][] = [
    ["timeoutMs", { ...valid, timeoutMs: 0 }], ["maxCost", { ...valid, maxCost: 0 }],
    ["expectations.firstSignificantAction.name", { ...valid, expectations: { ...valid.expectations, firstSignificantAction: { kind: "text", name: "invalid" } } }],
    ["expectations.workflowCallCount", { ...valid, expectations: { ...valid.expectations, workflowCallCount: { min: 2, max: 1 } } }],
    ["expectations.requireOutputSchema", { ...valid, expectations: { ...valid.expectations, requireOutputSchema: { type: "object", count: 1, minCount: 2 } } }],
    ["expectations.expectedResults[0]", { ...valid, expectations: { ...valid.expectations, expectedResults: [{}] } }],
    ["expectations.requiredAgentStructures[0].agents", { ...valid, expectations: { ...valid.expectations, requiredAgentStructures: [{ execution: "parallel", agents: [] }] } }],
    ["expectations.agentPolicies[0].callIndex", { ...valid, expectations: { ...valid.expectations, agentPolicies: [{ ...valid.expectations.agentPolicies[0], callIndex: -1 }] } }],
  ];
  for (const [field, value] of failures) assert.throws(() => validateWorkflowEvalCases([value], "complete"), (error: unknown) => error instanceof Error && error.message.includes(`field ${field}`));
});
void test("keeps isolated child missing-output, invalid-JSON, and failure results stable", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-child-paths-"));
  try {
    const cases = [
      ["missing", "process.exit(0);", { exitCode: 0, error: undefined }],
      ["invalid-json", "import { readFileSync, writeFileSync } from 'node:fs'; const input = JSON.parse(readFileSync(process.argv[2], 'utf8')); writeFileSync(input.outputPath, '{not-json');", { exitCode: 0, error: /Invalid child JSON/ }],
      ["failure", "process.exit(7);", { exitCode: 7, error: undefined }],
    ] as const;
    for (const [name, script, expected] of cases) {
      const childPath = join(root, `${name}.mjs`); writeFileSync(childPath, script);
      const result = await runIsolatedProcess({ case: name }, { childPath });
      assert.equal(result.value, undefined); assert.equal(result.timedOut, false); assert.equal(result.exitCode, expected.exitCode);
      if (expected.error instanceof RegExp) assert.match(result.error ?? "", expected.error); else assert.equal(result.error, expected.error);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
