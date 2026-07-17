import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectWorkflowScript, validateWorkflowLaunch, WorkflowError } from "../src/index.js";
import { assertEvalScriptSafe, captureValidationReports, evalExpectationErrors, extractCapturedWorkflows, extractParentOracle, INITIAL_WORKFLOW_EVAL_CASES, matchesJsonResult, matchesJsonSchema, matchesOutputSchema, parseSemanticJudge, replayExpectationErrors, replayWorkflowScript, resolveWorkflowSkillPath, selectStaticCandidate, staticExpectationResults, runIsolatedProcess, runWorkflowEvals, type ParentOracle } from "../src/workflow-evals.js";

const schema = { type: "object", properties: { answer: { type: "number" }, label: { type: "string" } }, required: ["answer", "label"], additionalProperties: false };
void test("defines the cheap initial evaluation matrix", () => {
  assert.deepEqual(INITIAL_WORKFLOW_EVAL_CASES.map(({ id }) => id), ["direct-answer", "two-agents", "required-role", "custom-model-read", "role-model-mixed", "parallel", "pipeline", "mixed-parallel-pipeline", "output-schema"]);
  assert.equal(INITIAL_WORKFLOW_EVAL_CASES.every(({ timeoutMs, maxCost }) => timeoutMs === undefined && maxCost > 0), true);
  assert.equal(INITIAL_WORKFLOW_EVAL_CASES.slice(1).every(({ prompt }) => !prompt.includes("workflow") && !prompt.includes("script:") && !prompt.includes("return agent(")), true);
  assert.match(resolveWorkflowSkillPath(), /skills\/pi-extensible-workflows\/SKILL\.md$/);
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

void test("matches captured validation results by tool-call id and retains schema-boundary errors", () => {
  const oracle = extractParentOracle([
    { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "bad", name: "workflow", arguments: [] }, { type: "toolCall", id: "good", name: "workflow", arguments: { name: "good", workflow: "registered" } }] } },
    { type: "message", message: { role: "toolResult", toolCallId: "good", toolName: "workflow", content: [{ type: "text", text: "captured" }], details: { captureIdentity: "pi-extensible-workflows-eval-capture-v1", realWorkflowAgentsLaunched: 0, validation: { valid: true, script: "return 1" } }, isError: false } },
    { type: "message", message: { role: "toolResult", toolCallId: "bad", toolName: "workflow", content: [{ type: "text", text: "Tool input validation failed" }], isError: true } },
  ]);
  const calls = extractCapturedWorkflows(oracle);
  assert.deepEqual(calls.map(({ toolCallId, arguments: args, script }) => ({ toolCallId, args, script })), [{ toolCallId: "bad", args: [], script: undefined }, { toolCallId: "good", args: { name: "good", workflow: "registered" }, script: "return 1" }]);
  assert.deepEqual(captureValidationReports(oracle, calls), { reports: [{ callIndex: 0, valid: false, message: "Tool input validation failed" }, { callIndex: 1, valid: true }], errors: [], verified: true });
});

void test("captures production-validated calls without execution and judges the first static candidate", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-fake-pi-"));
  const piPath = join(root, "fake-pi.mjs");
  writeFileSync(piPath, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const args = process.argv.slice(2); const value = name => args[args.indexOf(name) + 1]; if (args.includes("--no-tools")) { console.log(JSON.stringify({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: JSON.stringify({ criteria: [{ id: "intent", pass: true, evidence: "reviewer agent returns the review" }] }) }], provider: "fake", model: "judge", usage: { input: 5, output: 6, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } } })); process.exit(0); } const sessionDir = value("--session-dir"); const id = value("--session-id"); if (!value("--skill")?.endsWith("skills/pi-extensible-workflows/SKILL.md")) process.exit(2); if (!value("--extension")?.endsWith("/eval-capture-extension.js")) process.exit(3); mkdirSync(sessionDir, { recursive: true }); const script = 'return await agent("fake", { role: "reviewer" });'; const rows = [{ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: process.cwd() }, { type: "message", id: "bad", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "bad-call", name: "workflow", arguments: { script } }], provider: "fake", model: "parent", usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } } } }, { type: "message", id: "bad-result", parentId: "bad", timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "bad-call", toolName: "workflow", content: [{ type: "text", text: "pi-extensible-workflows-eval-capture-v1:INVALID_METADATA: Inline workflows require name" }], isError: true } }, { type: "message", id: "good", parentId: "bad-result", timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "good-call", name: "workflow", arguments: { name: "review", script } }], provider: "fake", model: "parent", usage: { input: 2, output: 4, cacheRead: 0, cost: { total: 0.01 } } } }, { type: "message", id: "good-result", parentId: "good", timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "good-call", toolName: "workflow", content: [{ type: "text", text: "captured" }], details: { captureIdentity: "pi-extensible-workflows-eval-capture-v1", realWorkflowAgentsLaunched: 0, validation: { valid: true, script } }, isError: false } }]; writeFileSync(join(sessionDir, "parent.jsonl"), rows.map(JSON.stringify).join("\\n") + "\\n");`);
  chmodSync(piPath, 0o755);
  const result = await runIsolatedProcess<{ status: string; workflows: unknown[]; productionValidation: Array<{ valid: boolean; errorCode?: string }>; semanticJudge?: { criteria: unknown[] }; metrics: { candidateCallIndices: number[]; invalidWorkflowCallCount: number; surplusWorkflowCallCount: number; parentOutputTokensThroughCandidate: number }; accounting: { totalTokens: number; cost: number }; cleanup: { captureIdentityVerified: boolean; realWorkflowAgentsLaunched: number; tempRootRemoved: boolean } }>({ case: { id: "capture", prompt: "review this", timeoutMs: 2_000, maxCost: 1, expectations: { workflowCallCount: { min: 1 }, requiredRoles: ["reviewer"] }, semanticCriteria: [{ id: "intent", description: "Return a reviewer assessment." }] }, model: "fake/model", piCommand: piPath, maxCost: 1 }, { childPath: join(process.cwd(), "dist/src/workflow-evals-child.js"), timeoutMs: 5_000 });
  assert.ok(result.value);
  assert.equal(result.value.status, "passed");
  assert.equal(result.value.workflows.length, 2);
  assert.deepEqual(result.value.productionValidation, [{ callIndex: 0, valid: false, errorCode: "INVALID_METADATA", message: "pi-extensible-workflows-eval-capture-v1:INVALID_METADATA: Inline workflows require name" }, { callIndex: 1, valid: true }]);
  assert.deepEqual(result.value.metrics.candidateCallIndices, [1]);
  assert.equal(result.value.metrics.invalidWorkflowCallCount, 1);
  assert.equal(result.value.metrics.surplusWorkflowCallCount, 0);
  assert.equal(result.value.metrics.parentOutputTokensThroughCandidate, 7);
  assert.equal(result.value.semanticJudge?.criteria.length, 1);
  assert.equal(result.value.accounting.totalTokens, 22);
  assert.equal(result.value.accounting.cost, 0.04);
  assert.equal(result.value.cleanup.captureIdentityVerified, true);
  assert.equal(result.value.cleanup.realWorkflowAgentsLaunched, 0);
  assert.equal(result.value.cleanup.tempRootRemoved, true);
});

void test("selects the required valid workflow set and records surplus valid calls", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-multiple-valid-"));
  const piPath = join(root, "fake-pi.mjs");
  writeFileSync(piPath, [
    "#!/usr/bin/env node",
    "import { mkdirSync, writeFileSync } from 'node:fs'; import { join } from 'node:path';",
    "const args = process.argv.slice(2); const value = name => args[args.indexOf(name) + 1];",
    "if (args.includes('--no-tools')) { console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ criteria: [{ id: 'intent', pass: true, evidence: 'two valid workflow calls' }] }) }], provider: 'fake', model: 'judge', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } } } })); process.exit(0); }",
    "const sessionDir = value('--session-dir'); const id = value('--session-id'); mkdirSync(sessionDir, { recursive: true });",
    "const scripts = ['return agent(\"api\")', 'return agent(\"ui\")', 'return agent(\"surplus\")'];",
    "const rows = [{ type: 'session', version: 3, id, cwd: process.cwd() }];",
    `for (const [index, script] of scripts.entries()) { const toolCallId = 'call-' + index; rows.push({ type: 'message', message: { role: 'assistant', content: [{ type: 'toolCall', id: toolCallId, name: 'workflow', arguments: { name: 'workflow-' + index, script } }] } }, { type: 'message', message: { role: 'toolResult', toolCallId, toolName: 'workflow', content: [{ type: 'text', text: 'captured' }], details: { captureIdentity: 'pi-extensible-workflows-eval-capture-v1', realWorkflowAgentsLaunched: 0, validation: { valid: true, script } }, isError: false } }); }`,
    "writeFileSync(join(sessionDir, 'parent.jsonl'), rows.map(JSON.stringify).join('\\n') + '\\n');",
  ].join("\n"));
  chmodSync(piPath, 0o755);
  const result = await runIsolatedProcess<{ status: string; workflows: unknown[]; productionValidation: Array<{ valid: boolean }>; semanticJudge?: { criteria: unknown[] }; metrics: { candidateCallIndices: number[]; surplusWorkflowCallCount: number }; }>({ case: { id: "multiple-valid", prompt: "delegate twice", timeoutMs: 2_000, maxCost: 1, expectations: { workflowCallCount: { min: 2 }, minimumAgentCalls: 2 }, expectedWorkflowCalls: 2, semanticCriteria: [{ id: "intent", description: "Use both results." }] }, model: "fake/model", piCommand: piPath, maxCost: 1 }, { childPath: join(process.cwd(), "dist/src/workflow-evals-child.js"), timeoutMs: 5_000 });
  assert.ok(result.value);
  assert.equal(result.value.status, "passed");
  assert.equal(result.value.workflows.length, 3);
  assert.equal(result.value.productionValidation.filter(({ valid }) => valid).length, 3);
  assert.deepEqual(result.value.metrics.candidateCallIndices, [0, 1]);
  assert.equal(result.value.metrics.surplusWorkflowCallCount, 1);
  assert.equal(result.value.semanticJudge?.criteria.length, 1);
  rmSync(root, { recursive: true, force: true });
});

void test("skips the semantic judge when every captured call fails production validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-invalid-"));
  const piPath = join(root, "fake-pi.mjs");
  const marker = join(root, "judge-ran");
  writeFileSync(piPath, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const args = process.argv.slice(2); const value = name => args[args.indexOf(name) + 1]; if (args.includes("--no-tools")) { writeFileSync(${JSON.stringify(marker)}, "unexpected"); process.exit(9); } const dir = value("--session-dir"); const id = value("--session-id"); mkdirSync(dir, { recursive: true }); const rows = [{ type: "session", version: 3, id, cwd: process.cwd() }, { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "bad", name: "workflow", arguments: { script: "return 1" } }], provider: "fake", model: "parent", usage: { input: 1, output: 1, cost: { total: 0.01 } } } }, { type: "message", message: { role: "toolResult", toolCallId: "bad", toolName: "workflow", content: [{ type: "text", text: "pi-extensible-workflows-eval-capture-v1:INVALID_METADATA: Inline workflows require name" }], isError: true } }]; writeFileSync(join(dir, "parent.jsonl"), rows.map(JSON.stringify).join("\\n") + "\\n");`);
  chmodSync(piPath, 0o755);
  const result = await runIsolatedProcess<{ status: string; semanticJudge?: unknown; metrics: { anyValidCandidate: boolean }; errors: string[] }>({ case: { id: "invalid", prompt: "delegate", timeoutMs: 2_000, maxCost: 1, expectations: { workflowCallCount: { min: 1 } }, semanticCriteria: [{ id: "intent", description: "delegate" }] }, model: "fake/model", piCommand: piPath, maxCost: 1 }, { childPath: join(process.cwd(), "dist/src/workflow-evals-child.js"), timeoutMs: 5_000 });
  assert.ok(result.value);
  assert.equal(result.value.status, "failed");
  assert.equal(result.value.metrics.anyValidCandidate, false);
  assert.equal(result.value.semanticJudge, undefined);
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
  assert.ok(matchesJsonSchema(schema, replayed.result));
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
  const staticResults = staticExpectationResults(staticCalls, { requiredAgentOrder: [{ role: "reviewer" }, { model: "p/m" }], requiredDataFlow: [{ binding: "review", toAgentIndex: 1 }], agentPolicies: [{ callIndex: 1, tools: { mode: "empty" }, forbidOptions: ["isolation", "retries"] }], requiredAgentStructures: [{ execution: "sequential", agents: [{ role: "reviewer" }, { model: "p/m" }] }] });
  assert.equal(staticResults.every(({ pass }) => pass), true);
  const dynamicOptions = inspectWorkflowScript('agent("x", { tools: [], isolation: mode, outputSchema: schema })')[0];
  assert.ok(dynamicOptions);
  assert.deepEqual(dynamicOptions.options?.tools, []);
  assert.deepEqual(dynamicOptions.optionKeys, ["tools", "isolation", "outputSchema"]);
  const forbiddenResult = staticExpectationResults([{ batch: 0, arguments: {}, script: 'parallel("p", { one: () => agent("x") })' }], { forbiddenOperations: ["pipeline"] })[0];
  assert.ok(forbiddenResult);
  assert.equal(forbiddenResult.pass, true);
  const parallelStructure = staticExpectationResults([{ batch: 0, arguments: {}, script: 'parallel("p", { one: () => agent("api"), two: () => agent("ui") }); agent("after")' }], { requiredAgentStructures: [{ execution: "parallel", operation: "parallel", agents: [{ promptIncludes: "api" }, { promptIncludes: "ui" }] }, { execution: "sequential", agents: [{ promptIncludes: "after" }] }] });
  assert.equal(parallelStructure.every(({ pass }) => pass), true);
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
  assert.throws(() => validateWorkflowLaunch({ name: "bad", script: 'agent("x", { role: "reviewer", model: "p/m" })' }, { cwd: process.cwd(), projectTrusted: true, availableModels: new Set(["p/m"]), rootTools: new Set() }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});

void test("isolates eval cases in separate OS processes and cleans up timed-out groups", async () => {
  const child = mkdtempSync(join(tmpdir(), "pi-workflow-eval-test-child-"));
  const childPath = join(child, "child.mjs");
  writeFileSync(childPath, `import { readFileSync, writeFileSync } from "node:fs"; const input = JSON.parse(readFileSync(process.argv[2], "utf8")); writeFileSync(input.outputPath, JSON.stringify({ pid: process.pid, cwd: process.cwd(), home: process.env.HOME, caseRoot: process.env.PI_WORKFLOW_EVAL_CASE_ROOT, marker: input.payload.marker }));`);
  const first = await runIsolatedProcess<{ pid: number; cwd: string; home: string; caseRoot: string; marker: string }>({ marker: "first" }, { childPath });
  const second = await runIsolatedProcess<{ pid: number; cwd: string; home: string; caseRoot: string; marker: string }>({ marker: "second" }, { childPath, timeoutMs: 2_000 });
  assert.ok(first.value);
  assert.ok(second.value);
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
  writeFileSync(fakePi, "#!/usr/bin/env node\nprocess.exit(7);\n");
  chmodSync(fakePi, 0o755);
  try {
    const result = await runWorkflowEvals({
      cases: [
        { id: "first", prompt: "ignored", timeoutMs: 2_000, maxCost: 0.1, expectations: {} },
        { id: "second", prompt: "ignored", timeoutMs: 2_000, maxCost: 0.1, expectations: {} },
      ],
      model: "fake/model",
      piCommand: fakePi,
      artifactsDir: join(root, "artifacts"),
      spendCeiling: 0.15,
    });
    assert.deepEqual(result.cases.map(({ accounting, limits }) => [accounting.cost.toFixed(2), limits.maxCost.toFixed(2)]), [["0.10", "0.10"], ["0.05", "0.05"]]);
    assert.equal(result.spent.toFixed(2), "0.15");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});