import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { callUnchecked, decodeTestJson, decodeTestJsonRecord, decodeTestRunStart, decodeTestToolResult, isTestRecord, isTestWorkflowFailureDiagnostics, testExtensionApi, testExtensionContext } from "./support.js";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, ERROR_CODES, formatWorkflowFailure, formatWorkflowFailureDelivery, formatWorkflowFailureDiagnostics, RunStore, WorkflowError, WorkflowRegistry, type PersistedRun, type WorkflowFailureDiagnostics, type WorkflowFunctionContext } from "../src/index.js";
import type { SessionInput } from "../src/agent-execution.js";
import { testTransport, type TestPiSession } from "./test-transport.js";
import { contextualWorkflowAction } from "./support.js";

type ToolResultHandler = (event: ToolResultEvent, ctx: ExtensionContext) => unknown;
function isToolResultHandler(value: unknown): value is ToolResultHandler {
  return typeof value === "function";
}
void test("rejects global collisions, invalid metadata, schemas, input, and output", async () => {
  const registry = new WorkflowRegistry();
  const extension = { version: "1.0.0", headline: "Demo", functions: { run: { description: "Run", input: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, output: { type: "string" }, run: () => 1 } } };
  registry.register(extension);
  assert.throws(() => { registry.register(extension); }, (error: unknown) => error instanceof WorkflowError && error.code === "GLOBAL_COLLISION");
  assert.throws(() => { registry.register({ version: "1.0.0", headline: "Other", functions: { run: extension.functions.run } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "GLOBAL_COLLISION");
  const crossType = new WorkflowRegistry();
  crossType.register(extension);
  const variableExtension = { version: "1.0.0", headline: "Variables", variables: { run: { description: "Run", schema: { type: "string" }, resolve: () => "ok" } } };
  assert.throws(() => { crossType.register(variableExtension); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  for (const name of ["agent", "Date", "process", "extensions"]) {
    assert.throws(() => { new WorkflowRegistry().register({ ...extension, functions: { [name]: extension.functions.run } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "GLOBAL_COLLISION");
  }
  assert.throws(() => { new WorkflowRegistry().register({ ...extension, functions: { __pi_extensible_workflows_internal: extension.functions.run } }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => { callUnchecked(registry.register.bind(registry), undefined, [{ ...extension, version: undefined }]); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => { callUnchecked(registry.register.bind(registry), undefined, [{ ...extension, workflows: { "release.check": { description: "Release", script: "return 1;" } } }]); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => { new WorkflowRegistry().register({ ...extension, version: "v1" }); }, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => { new WorkflowRegistry().register({ ...extension, functions: { run: { ...extension.functions.run, description: "", input: { type: "string" } } } }); }, WorkflowError);
  const journal = { get: () => undefined, put: () => {} };
  const context: WorkflowFunctionContext = { run: Object.freeze({ cwd: "/repo", sessionId: "session", runId: "run", workflow: Object.freeze({ name: "test" }), args: null, signal: new AbortController().signal }), invoke: async () => null, agent: async () => null, shell: async () => ({ exitCode: 0, stdout: "", stderr: "" }), prompt: (template: string) => template, parallel: async () => { throw new Error("unused"); }, pipeline: async () => { throw new Error("unused"); }, withWorktree: async () => { throw new Error("unused"); }, checkpoint: async () => true, phase: () => {}, log: () => {} };
  await assert.rejects(registry.invokeFunction("run", { value: 1 }, context, "bad-input", journal), (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID");
  await assert.rejects(registry.invokeFunction("run", { value: "x" }, context, "bad-output", journal), (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID");
});
void test("presents every workflow error code as factual prose", () => {
  for (const code of ERROR_CODES) {
    const prose = formatWorkflowFailure(new WorkflowError(code, `${code}: model-or-role detail 123e4567-e89b-12d3-a456-426614174000\n    at internal-callsite-id`));
    assert.match(prose, /model-or-role detail/);
    assert.doesNotMatch(prose, new RegExp(`\\b${code}\\b`));
    assert.doesNotMatch(prose, /123e4567-e89b-12d3-a456-426614174000|internal-callsite-id/);
  }
  assert.equal(formatWorkflowFailure(new Error("The release was rejected by the approval gate.")), "The release was rejected by the approval gate.");
  assert.equal(formatWorkflowFailure("plain thrown value"), "The workflow failed with value plain thrown value.");
  const owned = formatWorkflowFailure(new WorkflowError("RUN_OWNED", "Pi session session-a is already owned by process 42"));
  assert.doesNotMatch(owned, /session-a|process 42/);
  const composed = formatWorkflowFailure(new WorkflowError("INTERNAL_ERROR", "Nested UNKNOWN_MODEL: missing/provider"));
  assert.match(composed, /missing\/provider/);
  assert.doesNotMatch(composed, /UNKNOWN_MODEL/);
});
void test("formats background failure delivery as one concise human-readable line", () => {
  const diagnostic: WorkflowFailureDiagnostics = {
    runId: "run-130", workflowName: "background-audit", state: "failed", failedAt: "agent/review",
    error: { code: "AGENT_FAILED", message: "provider failed\nwith a diagnostic" },
    completedSiblingPaths: [],
    retry: { sourceRunId: "run-130", action: 'workflow_retry({ runId: "run-130" })', completedPaths: [], incompletePaths: ["agent/review"], namedWorktrees: [], warning: "retry warning" },
    artifacts: { runDirectory: "/tmp/run-130", statePath: "/tmp/run-130/state.json", journalPath: "/tmp/run-130/journal.json" },
  };
  const delivery = formatWorkflowFailureDelivery(diagnostic);
  assert.equal(delivery.includes("\n"), false);
  assert.match(delivery, /Workflow background-audit failed/);
  assert.match(delivery, /runId=run-130/);
  assert.match(delivery, /error=AGENT_FAILED: provider failed with a diagnostic/);
  assert.match(delivery, /failed path=agent\/review/);
  assert.match(delivery, /next action: workflow_retry\(\{ runId: "run-130" \}\)/);
  assert.match(delivery, /artifacts: .*state\.json .*journal\.json/);
  assert.doesNotMatch(delivery, /^\s*\{/);
  const unicode = formatWorkflowFailureDelivery({ ...diagnostic, error: { code: "AGENT_FAILED", message: "😀".repeat(5000) } });
  assert.ok(Buffer.byteLength(unicode) <= 4096);
  assert.doesNotMatch(unicode, /�/);
});
void test("foreground workflow failures preserve codes while returning main-agent prose", async () => {
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> };
  const tools: Tool[] = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-foreground-failure-"));
  workflowExtension(testExtensionApi({ registerTool(tool: Tool) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await assert.rejects(tool.execute("id", { name: "custom", script: "throw new Error('The release was rejected by the approval gate.');", foreground: true }, new AbortController().signal, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "INTERNAL_ERROR" && error.message === "The release was rejected by the approval gate.");
  await assert.rejects(tool.execute("id", { name: "value", script: "throw 'plain thrown value';", foreground: true }, new AbortController().signal, undefined, context), (error: unknown) => error instanceof WorkflowError && error.code === "INTERNAL_ERROR" && error.message === "The workflow encountered an internal error: plain thrown value.");
});
void test("foreground failure diagnostics advertise valid named worktrees", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-named-worktree-diagnostics-"));
  const cwd = join(home, "repo");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "test"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  writeFileSync(join(cwd, "tracked.txt"), "tracked");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "initial"]);
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let toolResultHandler: ((event: object, ctx: object) => Promise<unknown>) | undefined;
  let partialPath = "";
  let failBad = true;
  let goodAttempts = 0;
  let badAttempts = 0;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => ({
    sessionId: input.sessionLabel, sessionFile: `/sessions/${input.sessionLabel}.jsonl`,
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    prompt: async () => {
      if (input.sessionLabel.includes(":good:")) goodAttempts += 1;
      if (input.sessionLabel.includes(":bad:")) {
        badAttempts += 1;
        partialPath = join(input.cwd, "partial.txt");
        if (failBad) { writeFileSync(partialPath, "partial"); failBad = false; throw new Error("named worktree failure"); }
        assert.equal(existsSync(partialPath), true);
        assert.equal(readFileSync(partialPath, "utf8"), "partial");
      }
    },
    steer: async () => {},
    dispose() {},
  });
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on(name: string, handler: unknown) { if (name === "tool_result") toolResultHandler = handler as typeof toolResultHandler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow && toolResultHandler);
  const context = { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await assert.rejects(workflow.execute("named-worktree-diagnostics", { name: "named-worktree-diagnostics", script: `return withWorktree("diagnostic-tree", async () => parallel("branches", { good: () => agent("good", {label:"good"}), bad: () => agent("bad", {label:"bad"}) }));`, foreground: true }, new AbortController().signal, undefined, context), WorkflowError);
  const patched = await toolResultHandler({ type: "tool_result", toolName: "workflow", toolCallId: "named-worktree-diagnostics", input: {}, content: [{ type: "text", text: "old" }], details: {}, isError: true }, {});
  assert.ok(patched);
  const result = decodeTestToolResult(patched);
  const diagnostic = decodeTestJson(result.content[0]?.text ?? "null", isTestWorkflowFailureDiagnostics);
  assert.ok(diagnostic.retry);
  assert.equal(diagnostic.retry.action, `workflow_retry({ runId: ${JSON.stringify(diagnostic.retry.sourceRunId)} })`);
  assert.deepEqual(diagnostic.retry.namedWorktrees, ["diagnostic-tree"]);
  const retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(retry);
  const started = decodeTestToolResult(await retry.execute("retry-from-diagnostic", { runId: diagnostic.retry.sourceRunId, foreground: false }, undefined, undefined, context));
  const childId = decodeTestRunStart(started.content[0]?.text ?? "null").runId;
  let child: PersistedRun | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    child = (await new RunStore(cwd, "session", childId, home).load()).run;
    if (child.state === "completed" || child.state === "failed") break;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(child?.state, "completed");
  assert.equal(goodAttempts, 1);
  assert.equal(badAttempts, 2);
  assert.equal(readFileSync(partialPath, "utf8"), "partial");
});
void test("foreground failures patch finalized tool results with bounded diagnostics", async () => {
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
  const tools: Tool[] = [];
  let toolResultHandler: ToolResultHandler | undefined;
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-failure-diagnostics-"));
  const createSession = async (input: SessionInput): Promise<TestPiSession> => ({
    sessionId: `diagnostic-${input.sessionLabel}`, sessionFile: `/sessions/${input.sessionLabel}.jsonl`,
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    async prompt() { if (input.sessionLabel.includes(":bad:")) throw new Error(`provider failed ${"😀".repeat(5000)}`); },
    steer: async () => {},
    dispose() {},
  });
  workflowExtension(testExtensionApi({
    registerTool(tool: Tool) { tools.push(tool); }, registerCommand() {},
    on(name: string, handler: unknown) { if (name === "tool_result" && isToolResultHandler(handler)) toolResultHandler = handler; },
    getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"],
  }), home, async () => {}, testTransport(createSession));
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool && toolResultHandler);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await assert.rejects(tool.execute("workflow-call", { name: "diagnostics", script: `return parallel("reviewers", { good: () => agent("good", {label:"good"}), bad: () => agent("bad", {label:"bad"}) });`, foreground: true }, new AbortController().signal, undefined, context), WorkflowError);
  const patched = await toolResultHandler({ type: "tool_result", toolName: "workflow", toolCallId: "workflow-call", input: {}, content: [{ type: "text", text: "old" }], details: {}, isError: true }, testExtensionContext);
  assert.ok(patched);
  const result = decodeTestToolResult(patched);
  const diagnostic = decodeTestJson(result.content[0]?.text ?? "null", isTestWorkflowFailureDiagnostics);
  if (!isTestRecord(result.details)) throw new Error("Failure result details were not an object");
  const { run, ...resultDiagnostic } = result.details;
  assert.deepEqual(resultDiagnostic, diagnostic);
  assert.ok(run);
  assert.equal(result.isError, true);
  assert.equal(diagnostic.workflowName, "diagnostics");
  assert.equal(diagnostic.state, "failed");
  assert.match(diagnostic.failedAt ?? "", /bad/);
  assert.equal(diagnostic.error.code, "AGENT_FAILED");
  assert.match(diagnostic.error.message, /provider failed/);
  assert.ok(diagnostic.failedAgent);
  assert.equal(diagnostic.failedAgent.role, undefined);
  assert.deepEqual(diagnostic.failedAgent.structuralPath, ["reviewers", "bad"]);
  assert.equal(diagnostic.failedAgent.attempt, 1);
  const locator = diagnostic.failedAgent.session?.locator;
  const sessionFile = typeof locator === "object" && locator !== null && !Array.isArray(locator) && typeof locator.sessionFile === "string" ? locator.sessionFile : "";
  assert.match(sessionFile, /diagnostics:bad:attempt-1/);
  assert.ok(diagnostic.completedSiblingAgents);
  assert.deepEqual(diagnostic.completedSiblingAgents.map(({ label, role, structuralPath }) => ({ label, role, structuralPath })), [{ label: "good", role: undefined, structuralPath: ["reviewers", "good"] }]);
  assert.deepEqual(diagnostic.completedSiblingPaths, [["reviewers", "good"]]);
  assert.match(formatWorkflowFailureDiagnostics(diagnostic), /Completed sibling agents: good path=reviewers > good/);
  assert.ok(diagnostic.retry);
  assert.equal(diagnostic.retry.action, `workflow_retry({ runId: ${JSON.stringify(diagnostic.retry.sourceRunId)} })`);
  assert.ok(diagnostic.retry.sourceRunId);
  assert.ok(diagnostic.retry.completedPaths.length > 0);
  assert.ok(diagnostic.retry.incompletePaths.length > 0);
  assert.match(diagnostic.retry.warning, /external side effects.*not guaranteed exactly once/i);
  assert.match(formatWorkflowFailureDiagnostics(diagnostic), /Retry: workflow_retry\(\{ runId:/);
  assert.match(diagnostic.artifacts.statePath, /state\.json$/);
  assert.match(diagnostic.artifacts.journalPath, /journal\.json$/);
  assert.ok(Buffer.byteLength(result.content[0]?.text ?? "") <= 4096);
  assert.doesNotMatch(result.content[0]?.text ?? "", /�/);
  await assert.rejects(tool.execute("empty-workflow-call", { name: "empty-diagnostic", script: "throw new Error('');", foreground: true }, new AbortController().signal, undefined, context), WorkflowError);
  const emptyPatched = await toolResultHandler({ type: "tool_result", toolName: "workflow", toolCallId: "empty-workflow-call", input: {}, content: [{ type: "text", text: "old" }], details: {}, isError: true }, testExtensionContext);
  assert.ok(emptyPatched);
  const emptyResult = decodeTestToolResult(emptyPatched);
  const emptyDiagnostic = decodeTestJsonRecord(emptyResult.content[0]?.text ?? "null");
  if (!isTestRecord(emptyDiagnostic.error) || typeof emptyDiagnostic.error.message !== "string") throw new Error("Empty failure diagnostic was malformed");
  if (!isTestRecord(emptyResult.details)) throw new Error("Empty failure result details were not an object");
  const { run: emptyRun, ...emptyResultDiagnostic } = emptyResult.details;
  assert.deepEqual(emptyResultDiagnostic, emptyDiagnostic);
  assert.ok(emptyRun);
  assert.equal(emptyResult.isError, true);
  assert.equal(emptyDiagnostic.error.message, "The workflow failed without an error message.");
});
void test("foreground failure results reload settled sibling agent states", async () => {
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  let toolResultHandler: ToolResultHandler | undefined;
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-final-failure-state-"));
  let releaseGood!: () => void;
  const goodHold = new Promise<void>((resolve) => { releaseGood = resolve; });
  let goodActive = false;
  let goodAborted = false;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    return {
      sessionId: `final-failure-${input.sessionLabel}`, sessionFile: `/sessions/final-failure-${input.sessionLabel}.jsonl`,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      async prompt(text) {
        if (text.includes("Task:\ngood")) { goodActive = true; await goodHold; if (goodAborted) throw new WorkflowError("CANCELLED", "good cancelled"); return; }
        throw new Error("sibling failure");
      },
      abort: async () => { if (goodActive) { goodAborted = true; releaseGood(); } },
      steer: async () => {},
      dispose() {},
    };
  };
  workflowExtension(testExtensionApi({
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {},
    on(name: string, handler: unknown) { if (name === "tool_result" && isToolResultHandler(handler)) toolResultHandler = handler; },
    getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"],
  }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow && toolResultHandler);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const running = workflow.execute("final-failure", { name: "final-failure", concurrency: 2, script: `return parallel("siblings", { good: () => agent("good"), bad: () => agent("bad") });`, foreground: true }, new AbortController().signal, undefined, context);
  const rejected = assert.rejects(running, WorkflowError);
  await rejected;
  const patched = await toolResultHandler({ type: "tool_result", toolName: "workflow", toolCallId: "final-failure", input: {}, content: [{ type: "text", text: "old" }], details: {}, isError: true }, testExtensionContext);
  assert.ok(patched);
  const result = decodeTestToolResult(patched);
  if (!isTestRecord(result.details) || !isTestRecord(result.details.run) || !Array.isArray(result.details.run.agents)) throw new Error("Final failure result did not include persisted agents");
  const states = new Map(result.details.run.agents.filter(isTestRecord).flatMap((agent) => Array.isArray(agent.structuralPath) && typeof agent.structuralPath.at(-1) === "string" ? [[agent.structuralPath.at(-1) as string, agent.state] as const] : []));
  assert.equal(states.get("good"), "cancelled");
  assert.equal(states.get("bad"), "failed");
});
void test("failure diagnostics retain identity and retry fields when long sibling lists are truncated", async () => {
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
  const tools: Tool[] = [];
  let toolResultHandler: ToolResultHandler | undefined;
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-long-diagnostics-"));
  const siblings = Array.from({ length: 40 }, (_, index) => {
    const label = `sibling-${String(index)}-${"long-label-".repeat(12)}`;
    return `${JSON.stringify(`sibling_${String(index)}`)}: () => agent(${JSON.stringify(`work-${String(index)}`)}, { label: ${JSON.stringify(label)} })`;
  }).join(", ");
  const script = `return parallel("reviewers", { ${siblings}, bad: () => agent("bad", { label: "bad" }) });`;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => ({
    sessionId: `long-diagnostics-${input.sessionLabel}`, sessionFile: `/sessions/long-diagnostics-${input.sessionLabel}.jsonl`,
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    prompt: async () => { if (input.sessionLabel.includes(":bad:")) throw new Error(`long sibling failure ${"x".repeat(2000)}`); },
    steer: async () => {},
    dispose() {},
  });
  workflowExtension(testExtensionApi({
    registerTool(tool: Tool) { tools.push(tool); }, registerCommand() {},
    on(name: string, handler: unknown) { if (name === "tool_result" && isToolResultHandler(handler)) toolResultHandler = handler; },
    getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"],
  }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow && toolResultHandler);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await assert.rejects(workflow.execute("long-diagnostic-call", { name: "long-diagnostics", script, foreground: true }, new AbortController().signal, undefined, context), WorkflowError);
  const patched = await toolResultHandler({ type: "tool_result", toolName: "workflow", toolCallId: "long-diagnostic-call", input: {}, content: [{ type: "text", text: "old" }], details: {}, isError: true }, testExtensionContext);
  assert.ok(patched);
  const result = decodeTestToolResult(patched);
  const diagnostic = decodeTestJson(result.content[0]?.text ?? "null", isTestWorkflowFailureDiagnostics);
  if (!isTestRecord(result.details)) throw new Error("Long failure result details were not an object");
  assert.equal(result.isError, true);
  assert.ok(Buffer.byteLength(result.content[0]?.text ?? "") <= 4096);
  assert.equal(diagnostic.runId, result.details.runId);
  assert.equal(diagnostic.state, "failed");
  assert.equal(diagnostic.retry?.action, `workflow_retry({ runId: ${JSON.stringify(diagnostic.runId)} })`);
});
void test("failure diagnostics include replayable shell operations", async () => {
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
  const tools: Tool[] = [];
  let toolResultHandler: ToolResultHandler | undefined;
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shell-diagnostics-"));
  workflowExtension(testExtensionApi({
    registerTool(tool: Tool) { tools.push(tool); }, registerCommand() {},
    on(name: string, handler: unknown) { if (name === "tool_result" && isToolResultHandler(handler)) toolResultHandler = handler; },
    getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "shell"],
  }), home);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow && toolResultHandler);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await assert.rejects(workflow.execute("shell-diagnostics", { name: "shell-diagnostics", script: `await shell("printf ok"); throw new Error("boom");`, foreground: true }, new AbortController().signal, undefined, context), WorkflowError);
  const patched = await toolResultHandler({ type: "tool_result", toolName: "workflow", toolCallId: "shell-diagnostics", input: {}, content: [{ type: "text", text: "old" }], details: {}, isError: true }, testExtensionContext);
  assert.ok(patched);
  const diagnostic = decodeTestJson(decodeTestToolResult(patched).content[0]?.text ?? "null", isTestWorkflowFailureDiagnostics);
  assert.ok(diagnostic.retry?.completedPaths.some((path) => path.startsWith("shell/")));
});
void test("background and cold-resumed terminal failures deliver artifacts without retry advice", async () => {
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
  const tools: Tool[] = [];
  const messages: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-terminal-failure-delivery-"));
  const sessionId = "session";
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    return {
      sessionId: `terminal-delivery-${input.sessionLabel}`, sessionFile: `/sessions/terminal-delivery-${input.sessionLabel}.jsonl`,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
      getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      prompt: async () => { await hold; },
      steer: async () => {},
      abort: async () => { release(); },
      dispose() {},
    };
  };
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  workflowExtension(testExtensionApi({
    registerTool(tool: Tool) { tools.push(tool); },
    registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; },
    on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; },
    sendMessage(message: { content: string }) { messages.push(message.content); },
    getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"],
  }), home, async () => {}, testTransport(createSession));
  const stop = tools.find(({ name }) => name === "workflow_stop");
  assert.ok(start && command && stop);
  const snapshot = (name: string, script: string) => createLaunchSnapshot({ script, args: null, metadata: { name }, launchMode: "background", settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] });
  const stopped = new RunStore(home, sessionId, "stopped-run", home);
  const interrupted = new RunStore(home, sessionId, "interrupted-run", home);
  const waitingScript = "phase('build'); return await agent('wait');";
  await stopped.create({ id: stopped.runId, workflowName: "stopped-run", cwd: home, sessionId, state: "interrupted", agents: [], agentSessions: [], delivery: { mode: "background", state: "pending" } }, snapshot("stopped-run", waitingScript));
  await interrupted.create({ id: interrupted.runId, workflowName: "interrupted-run", cwd: home, sessionId, state: "interrupted", agents: [], agentSessions: [], delivery: { mode: "background", state: "pending" } }, snapshot("interrupted-run", waitingScript));
  const exhausted = new RunStore(home, sessionId, "exhausted-run", home);
  await exhausted.create({ id: exhausted.runId, workflowName: "exhausted-run", cwd: home, sessionId, state: "budget_exhausted", agents: [], agentSessions: [], delivery: { mode: "background", state: "pending" } }, snapshot("exhausted-run", "throw Object.assign(new Error('budget exhausted'), { code: 'BUDGET_EXHAUSTED' });"));
  const context = { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => sessionId }, ui: { notify() {} } };
  const waitFor = async (store: RunStore, predicate: (run: PersistedRun) => boolean): Promise<PersistedRun> => {
    for (let attempt = 0; attempt < 200; attempt += 1) { const run = (await store.load()).run; if (predicate(run)) return run; await new Promise<void>((resolve) => setImmediate(resolve)); }
    throw new Error(`Timed out waiting for ${store.runId}`);
  };
  const delivered = async (name: string): Promise<string> => {
    for (let attempt = 0; attempt < 200; attempt += 1) { const message = messages.find((candidate) => candidate.includes(`Workflow ${name} failed`)); if (message) return message; await new Promise<void>((resolve) => setTimeout(resolve, 10)); }
    throw new Error(`Timed out waiting for delivery ${name}`);
  };
  try {
    await start({}, context);
    await contextualWorkflowAction(command, context, stopped.runId, "Resume", "Background");
    await waitFor(stopped, (run) => run.state === "running");
    await stop.execute("stop", { runId: stopped.runId });
    const stoppedMessage = await delivered("stopped-run");
    await contextualWorkflowAction(command, context, exhausted.runId, "Resume unchanged", "Background");
    const exhaustedMessage = await delivered("exhausted-run");
    await contextualWorkflowAction(command, context, interrupted.runId, "Resume", "Background");
    await waitFor(interrupted, (run) => run.state === "running");
    await shutdown?.();
    const interruptedMessage = await delivered("interrupted-run");
    for (const [name, message, code] of [["stopped-run", stoppedMessage, "CANCELLED"], ["interrupted-run", interruptedMessage, "CANCELLED"], ["exhausted-run", exhaustedMessage, "BUDGET_EXHAUSTED"]] as const) {
      assert.match(message, new RegExp(`error=${code}:`));
      assert.match(message, new RegExp(`runDirectory=.*${name}`));
      assert.match(message, /statePath=.*state\.json/);
      assert.match(message, /journalPath=.*journal\.json/);
      assert.doesNotMatch(message, /workflow_retry/);
    }
  } finally {
    await shutdown?.();
  }
});
void test("background failure diagnostics drive workflow_retry with the advertised run ID", async () => {
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
  const tools: Tool[] = [];
  const delivered: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-background-retry-diagnostics-"));
  const cwd = join(home, "repo");
  mkdirSync(cwd);
  execFileSync("git", ["init", "-q", cwd]);
  execFileSync("git", ["-C", cwd, "config", "user.name", "test"]);
  execFileSync("git", ["-C", cwd, "config", "user.email", "test@example.com"]);
  writeFileSync(join(cwd, "tracked.txt"), "tracked");
  execFileSync("git", ["-C", cwd, "add", "."]);
  execFileSync("git", ["-C", cwd, "commit", "-qm", "initial"]);
  let failBad = true;
  let goodAttempts = 0;
  let badAttempts = 0;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => ({
    sessionId: input.sessionLabel, sessionFile: `/sessions/${input.sessionLabel}.jsonl`,
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    prompt: async () => {
      if (input.sessionLabel.includes(":good:")) goodAttempts += 1;
      if (input.sessionLabel.includes(":bad:")) { badAttempts += 1; if (failBad) { failBad = false; throw new Error("background retry failure"); } }
    },
    steer: async () => {},
    dispose() {},
  });
  workflowExtension(testExtensionApi({ registerTool(tool: Tool) { tools.push(tool); }, registerCommand() {}, on() {}, sendMessage(message: { content: string }) { delivered.push(message.content); }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(workflow && retry);
  const context = { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await workflow.execute("background-retry", { name: "background-retry", script: `return withWorktree("background-tree", async () => parallel("branches", { good: () => agent("good", {label:"good"}), bad: () => agent("bad", {label:"bad"}) }));` }, undefined, undefined, context);
  let diagnosticMessage: string | undefined;
  // Background delivery includes worktree creation; the bound covers slow CI runners, not a fixed expected latency.
  for (let attempt = 0; attempt < 1_000 && !diagnosticMessage; attempt += 1) {
    diagnosticMessage = delivered.find((message) => message.includes(" failed (runId="));
    if (!diagnosticMessage) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(diagnosticMessage);
  const sourceRunId = /runId=([^;) ]+)/.exec(diagnosticMessage)?.[1];
  if (!sourceRunId) throw new Error("Background failure did not include a run ID");
  assert.match(diagnosticMessage, /next action: workflow_retry\(\{ runId: /);
  assert.match(diagnosticMessage, /statePath=.*state\.json/);
  assert.match(diagnosticMessage, /journalPath=.*journal\.json/);
  const started = decodeTestToolResult(await retry.execute("background-retry-child", { runId: sourceRunId }, undefined, undefined, context));
  const childId = decodeTestRunStart(started.content[0]?.text ?? "null").runId;
  let child: PersistedRun | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    child = (await new RunStore(cwd, "session", childId, home).load()).run;
    if (child.state === "completed" || child.state === "failed") break;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(child?.state, "completed");
  assert.equal(goodAttempts, 1);
  assert.equal(badAttempts, 2);
});
void test("failed retry diagnostics preserve retry provenance", async () => {
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
  const tools: Tool[] = [];
  const delivered: string[] = [];
  const diagnostics: Array<{ runId: string }> = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-retry-diagnostic-paths-"));
  const cwd = join(home, "repo");
  mkdirSync(cwd);
  let firstAttempts = 0;
  let secondAttempts = 0;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => ({
    sessionId: input.sessionLabel, sessionFile: `/sessions/${input.sessionLabel}.jsonl`,
    messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
    getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
    prompt: async () => {
      if (input.sessionLabel.includes(":first:")) { firstAttempts += 1; if (firstAttempts === 1) throw new Error("first attempt failed"); }
      if (input.sessionLabel.includes(":second:")) { secondAttempts += 1; throw new Error("second attempt failed"); }
    },
    steer: async () => {},
    dispose() {},
  });
  workflowExtension(testExtensionApi({ registerTool(tool: Tool) { tools.push(tool); }, registerCommand() {}, on() {}, sendMessage(message: { content: string }) {
    delivered.push(message.content);
    const runId = /runId=([^;) ]+)/.exec(message.content)?.[1];
    if (runId && message.content.includes(" failed (runId=")) diagnostics.push({ runId });
  }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(workflow && retry);
  const context = { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await workflow.execute("retry-diagnostic-source", { name: "retry-diagnostic-source", script: `return pipeline("stages", { item: "input" }, { first: value => agent("first", {label:"first"}), second: value => agent("second", {label:"second"}) });` }, undefined, undefined, context);
  for (let attempt = 0; attempt < 100 && diagnostics.length < 1; attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  assert.equal(diagnostics.length, 1);
  const sourceDiagnostic = diagnostics[0];
  if (!sourceDiagnostic) throw new Error("Source failure was not delivered");
  const started = decodeTestToolResult(await retry.execute("retry-diagnostic-child", { runId: sourceDiagnostic.runId }, undefined, undefined, context));
  const childId = decodeTestRunStart(started.content[0]?.text ?? "null").runId;
  for (let attempt = 0; attempt < 100 && !diagnostics.some((diagnostic) => diagnostic.runId === childId); attempt += 1) await new Promise<void>((resolve) => setTimeout(resolve, 10));
  const childDiagnostic = diagnostics.find((diagnostic) => diagnostic.runId === childId);
  if (!childDiagnostic) throw new Error("Child failure was not delivered");
  const childRun = (await new RunStore(cwd, "session", childId, home).load()).run;
  assert.equal(childRun.state, "failed");
  if (!childRun.retry) throw new Error("Child retry provenance was not persisted");
  const nextStarted = decodeTestToolResult(await retry.execute("retry-diagnostic-next-child", { runId: childId }, undefined, undefined, context));
  const nextChildId = decodeTestRunStart(nextStarted.content[0]?.text ?? "null").runId;
  let nextChild: PersistedRun | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    nextChild = (await new RunStore(cwd, "session", nextChildId, home).load()).run;
    if (nextChild.state === "completed" || nextChild.state === "failed") break;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(nextChild);
  assert.ok(nextChild.retry);
  assert.equal(firstAttempts, 2);
  assert.equal(secondAttempts, 2);
});
void test("background failures and workflow responses deliver prose to the main agent", async () => {
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details?: { runId?: string; accepted?: boolean } }> };
  const tools: Tool[] = [];
  const delivered: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-background-failure-"));
  workflowExtension(testExtensionApi({ registerTool(tool: Tool) { tools.push(tool); }, registerCommand() {}, on() {}, sendMessage(message: { content: string }) { delivered.push(message.content); }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_respond"] }), home);
  const tool = tools.find(({ name }) => name === "workflow");
  assert.ok(tool);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await tool.execute("id", { name: "custom-background", script: "throw Object.assign(new Error('The approval gate rejected the release.'), {code:'ENOSPC'});" }, new AbortController().signal, undefined, context);
  await tool.execute("id", { name: "value-background", script: "throw 'background value';" }, new AbortController().signal, undefined, context);
  for (let attempt = 0; attempt < 100 && delivered.filter((message) => message.includes(" failed (runId=")).length < 2; attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const failures = delivered.filter((message) => message.includes(" failed (runId="));
  assert.equal(failures.length, 2);
  assert.ok(failures.some((message) => message.includes("approval gate rejected the release.")));
  assert.ok(failures.some((message) => message.includes("background value")));
  assert.ok(failures.every((message) => !message.includes("\n") && /runId=/.test(message) && /statePath=.*state\.json/.test(message) && /journalPath=.*journal\.json/.test(message) && /next action: workflow_retry\(\{ runId: /.test(message)));
});
void test("workflow_respond keeps asynchronous failures on the prose delivery path", async () => {
  type Tool = { name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; details?: { runId?: string; accepted?: boolean } }> };
  const tools: Tool[] = [];
  const delivered: string[] = [];
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-respond-failure-"));
  workflowExtension(testExtensionApi({ registerTool(tool: Tool) { tools.push(tool); }, registerCommand() {}, on() {}, sendMessage(message: { content: string }) { delivered.push(message.content); }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "workflow_respond"] }), home);
  const workflow = tools.find(({ name }) => name === "workflow");
  const respond = tools.find(({ name }) => name === "workflow_respond");
  assert.ok(workflow && respond);
  const context = { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  const started = await workflow.execute("id", { name: "respond-failure", script: "const approved = await checkpoint({name:'ship', prompt:'Ship?', context:null}); if (approved) throw new Error('The release was rejected after approval.'); return approved;" }, new AbortController().signal, undefined, context);
  const runId = (JSON.parse(started.content[0]?.text ?? "{}") as { runId?: string }).runId;
  assert.ok(runId);
  for (let attempt = 0; attempt < 100 && !delivered.some((message) => message.includes("Ship?")); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  const response = await respond.execute("id", { runId, name: "ship", approved: true }, undefined, undefined, context);
  assert.equal(response.details?.accepted, true);
  for (let attempt = 0; attempt < 100 && !delivered.some((message) => message.includes("The release was rejected after approval.")); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(delivered.some((message) => message.includes("The release was rejected after approval.")));
  const diagnosticMessage = delivered.find((message) => message.includes(`runId=${runId}`) && message.includes(" failed (runId="));
  assert.ok(diagnosticMessage);
  assert.doesNotMatch(diagnosticMessage, /\n/);
  assert.match(diagnosticMessage, /error=INTERNAL_ERROR: The release was rejected after approval\./);
  assert.match(diagnosticMessage, /statePath=.*state\.json/);
  assert.match(diagnosticMessage, /journalPath=.*journal\.json/);
});
