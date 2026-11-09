import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeTestRunDetails, decodeTestRunStart, decodeTestToolResult, testExtensionApi } from "./support.js";
import workflowExtension, { preflight, registerWorkflowExtension, resetWorkflowRegistry, RunStore, runWorkflow, WorkflowError, type AgentRecord, type JsonValue, type PersistedRun, type WorkflowFunction } from "../src/index.js";
import { reviewLoop } from "../starter/review-loop.js";
import type { SessionInput } from "../src/agent-execution.js";
import { listRunIds } from "../src/persistence.js";
import { agentHandleTurnPath } from "../src/execution.js";
import { testTransport, type TestPiSession } from "./test-transport.js";

const capabilities = { models: new Set(["openai/gpt"]), tools: new Set(["read"]), };
const script = `const author = agent.create({ name: "author" });
const first = await author.send("first draft");
const second = await author.send("apply findings");
return { first, second };`;

type TestTool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
type Host = { readonly home: string; readonly workflow: TestTool; readonly retry: TestTool; readonly context: Record<string, unknown>; readonly opened: readonly SessionInput[]; readonly openedInput: readonly string[]; readonly prompts: readonly string[] };
const terminalProviderError = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "MODEL_UNAVAILABLE" };

/** Hosts one workflow extension whose fake sessions persist their turns as JSONL, like Pi does. */
function host(failTurn?: number, providerErrorSession?: number, onPrompt?: (text: string, count: number, input: SessionInput) => void | Promise<void>): Host {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-handles-"));
  const sessions = join(home, "sessions");
  mkdirSync(sessions, { recursive: true });
  const opened: SessionInput[] = [];
  const openedInput: string[] = [];
  const prompts: string[] = [];
  let created = 0;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    opened.push(input);
    openedInput.push(input.sessionPath ? readFileSync(input.sessionPath, "utf8") : "");
    const index = ++created;
    const sessionFile = input.sessionPath ?? join(sessions, `session-${String(index)}.jsonl`);
    if (!input.sessionPath) writeFileSync(sessionFile, "");
    return {
      sessionId: `session-${String(index)}`, sessionFile,
      messages: [index === providerErrorSession ? terminalProviderError : { role: "assistant", content: [{ type: "text", text: `reply-${String(index)}` }] }],
      getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
      prompt: async (text: string) => {
        prompts.push(text);
        appendFileSync(sessionFile, `${JSON.stringify({ role: "user", text })}\n`);
        await onPrompt?.(text, prompts.length, input);
        if (failTurn !== undefined && prompts.length === failTurn) throw new Error("send failed");
      },
      dispose() {},
    };
  };
  const tools: TestTool[] = [];
  workflowExtension(testExtensionApi({ registerTool(tool: TestTool) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  const retry = tools.find(({ name }) => name === "workflow_retry");
  assert.ok(workflow && retry);
  return { home, workflow, retry, context: { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }, opened, openedInput, prompts };
}
function launch(current: Host, name: string): Promise<unknown> {
  return current.workflow.execute(name, { name, script, foreground: true }, new AbortController().signal, undefined, current.context);
}
async function loadUntil(home: string, runId: string, state: PersistedRun["state"]): Promise<PersistedRun> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = (await new RunStore(home, "session", runId, home).load()).run;
    // The host persists a terminal failed state before its error, so wait for both.
    if (current.state === state && (state !== "failed" || current.error !== undefined)) return current;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${runId} to become ${state}`);
}
function handleAgent(run: PersistedRun, turn: number): AgentRecord {
  const agent = run.agents.find((candidate) => candidate.handle === "author" && candidate.turn === turn);
  assert.ok(agent, `run has no handle turn ${String(turn)}`);
  return agent;
}
/** Drops an attempt field a dying host never got to persist, leaving the record a crash left behind. */
async function forgetAttemptField(store: RunStore, turn: number, field: "error" | "session"): Promise<void> {
  await store.updateState((run) => ({ ...run, agents: run.agents.map((agent) => agent.handle === "author" && agent.turn === turn && agent.attemptDetails ? { ...agent, attemptDetails: agent.attemptDetails.map((detail) => ({ attempt: detail.attempt, transport: detail.transport, setup: detail.setup, accounting: detail.accounting, ...(field === "error" || !detail.error ? {} : { error: detail.error }), ...(field === "session" || !detail.session ? {} : { session: detail.session }) })) } : agent) }));
}
async function retried(current: Host, runId: string): Promise<string> {
  const started = decodeTestRunStart(decodeTestToolResult(await current.retry.execute("retry", { runId, foreground: false }, undefined, undefined, current.context)).content[0]?.text ?? "null");
  return started.runId;
}
function onlyRunId(runIds: readonly string[]): string {
  const runId = runIds[0];
  assert.ok(runId);
  return runId;
}

void test("sequential handle sends continue one transcript from a per-turn session copy", async () => {
  const current = host();
  const result = decodeTestToolResult(await launch(current, "handle-sequential"));
  const store = new RunStore(current.home, "session", decodeTestRunDetails(result.details).runId, current.home);
  assert.deepEqual(JSON.parse(readFileSync(join(store.directory, "result.json"), "utf8")), { first: "reply-1", second: "reply-2" });
  const turnInput = join(store.directory, "handles", "author", "turn-2-input-attempt-1.jsonl");
  assert.equal(current.opened[0]?.sessionPath, undefined);
  assert.equal(current.opened[1]?.sessionPath, turnInput);
  // Fresh and continued sends deliver exactly the supplied text; the workflow_result contract lives in the tool.
  assert.deepEqual(current.prompts, ["first draft", "apply findings"]);
  assert.match(current.opened[1].resultTool?.description ?? "", /exactly once/);
  assert.equal(current.opened[1].systemPromptAppend, "");
  const transcript = readFileSync(turnInput, "utf8");
  assert.match(transcript, /first draft/);
  assert.match(transcript, /apply findings/);
  const run = (await store.load()).run;
  assert.deepEqual([handleAgent(run, 1).continuity, handleAgent(run, 2).continuity], ["fresh", "continued"]);
  assert.deepEqual(await store.replay(agentHandleTurnPath("author", 1)), { path: agentHandleTurnPath("author", 1), value: "reply-1" });
  assert.deepEqual(await store.replay(agentHandleTurnPath("author", 2)), { path: agentHandleTurnPath("author", 2), value: "reply-2" });
});

void test("a crashed handle send leaves its turn incomplete and journals only earlier turns", async () => {
  const current = host(2);
  await assert.rejects(launch(current, "handle-crash"), WorkflowError);
  const runId = (await listRunIds(current.home, "session", current.home))[0];
  assert.ok(runId);
  const store = new RunStore(current.home, "session", runId, current.home);
  const summary = await store.loadSummary();
  assert.equal(summary.state, "failed");
  assert.deepEqual(summary.replayablePaths, [agentHandleTurnPath("author", 1)]);
  assert.deepEqual(summary.incompletePaths, [agentHandleTurnPath("author", 2)]);
  assert.equal(await store.replay(agentHandleTurnPath("author", 2)), undefined);
});

void test("retrying a crashed send replays completed turns and continues from the copied session file", async () => {
  const current = host(2);
  await assert.rejects(launch(current, "handle-retry"), WorkflowError);
  const sourceId = (await listRunIds(current.home, "session", current.home))[0];
  assert.ok(sourceId);
  const started = decodeTestRunStart(decodeTestToolResult(await current.retry.execute("retry", { runId: sourceId, foreground: false }, undefined, undefined, current.context)).content[0]?.text ?? "null");
  const run = await loadUntil(current.home, started.runId, "completed");
  const store = new RunStore(current.home, "session", started.runId, current.home);
  assert.deepEqual(current.prompts.filter((prompt) => prompt.includes("first draft")).length, 1);
  const turnInput = join(store.directory, "handles", "author", "turn-2-input-attempt-1.jsonl");
  assert.equal(current.opened.at(-1)?.sessionPath, turnInput);
  assert.match(readFileSync(turnInput, "utf8"), /first draft/);
  assert.equal(handleAgent(run, 2).continuity, "continued");
  assert.deepEqual(await store.replay(agentHandleTurnPath("author", 2)), { path: agentHandleTurnPath("author", 2), value: `reply-${String(current.opened.length)}` });
});

void test("overlapping sends on one handle are rejected", async () => {
  const overlap = `const author = agent.create({ name: "author" });
const first = author.send("one");
let code = "none";
try { author.send("two"); } catch (failure) { code = failure.code; }
await first;
return code;`;
  const value: JsonValue = await runWorkflow(overlap, null, { agent: async () => "done" }).result;
  assert.equal(value, "INVALID_METADATA");
});

void test("duplicate handle names are rejected and non-literal names fail preflight", async () => {
  const duplicate = `agent.create({ name: "author" });
try { agent.create({ name: "author" }); } catch (failure) { return failure.code; }
return "accepted";`;
  assert.equal(await runWorkflow(duplicate, null, { agent: async () => "done" }).result, "INVALID_METADATA");
  assert.throws(() => preflight(`const a = agent.create({ name: args.name }); return a.send("x");`, capabilities), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => preflight(`const a = agent.create(); return a.send("x");`, capabilities), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.deepEqual(preflight(`const a = agent.create({ name: "author", role: "reviewer", model: "openai/gpt:high", tools: ["read"] }); return a.send("x");`, capabilities).referenced, { phases: [], models: [], tools: ["read"] });
});

void test("a provider-recovery attempt on a handle turn reopens a clean per-turn copy", async () => {
  const current = host(undefined, 2);
  const titles: string[] = [];
  const context = { cwd: current.home, mode: "tui", hasUI: true, model: { provider: "openai", id: "gpt" }, modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt" }, { provider: "anthropic", id: "opus" }] }, sessionManager: { getSessionId: () => "session" }, ui: { select: async (title: string) => { titles.push(title); return titles.length === 1 ? "Change model" : "anthropic/opus"; } } };
  const result = decodeTestToolResult(await current.workflow.execute("handle-provider-recovery", { name: "handle-provider-recovery", script, foreground: true }, new AbortController().signal, undefined, context));
  const store = new RunStore(current.home, "session", decodeTestRunDetails(result.details).runId, current.home);
  assert.deepEqual(JSON.parse(readFileSync(join(store.directory, "result.json"), "utf8")), { first: "reply-1", second: "reply-3" });
  assert.equal(current.opened.length, 3);
  assert.notEqual(current.opened[2]?.sessionPath, current.opened[1]?.sessionPath);
  assert.match(current.openedInput[2] ?? "", /first draft/);
  assert.doesNotMatch(current.openedInput[2] ?? "", /apply findings/);
});

void test("a send after a failed send continues from the last successful turn", async () => {
  const current = host(2);
  const recovering = `const author = agent.create({ name: "author" });
const first = await author.send("first draft");
let failure = "none";
try { await author.send("boom"); } catch (error) { failure = error.code; }
const third = await author.send("third pass");
return { first, failure, third };`;
  const result = decodeTestToolResult(await current.workflow.execute("handle-after-failure", { name: "handle-after-failure", script: recovering, foreground: true }, new AbortController().signal, undefined, current.context));
  const store = new RunStore(current.home, "session", decodeTestRunDetails(result.details).runId, current.home);
  assert.deepEqual(JSON.parse(readFileSync(join(store.directory, "result.json"), "utf8")), { first: "reply-1", failure: "AGENT_FAILED", third: "reply-3" });
  assert.match(current.openedInput.at(-1) ?? "", /first draft/);
  assert.doesNotMatch(current.openedInput.at(-1) ?? "", /boom/);
});

void test("a send whose prior turns never completed starts fresh", async () => {
  const current = host(1);
  const fresh = `const author = agent.create({ name: "author" });
let failure = "none";
try { await author.send("boom"); } catch (error) { failure = error.code; }
const second = await author.send("second try");
return { failure, second };`;
  const result = decodeTestToolResult(await current.workflow.execute("handle-fresh-after-failure", { name: "handle-fresh-after-failure", script: fresh, foreground: true }, new AbortController().signal, undefined, current.context));
  const store = new RunStore(current.home, "session", decodeTestRunDetails(result.details).runId, current.home);
  assert.deepEqual(JSON.parse(readFileSync(join(store.directory, "result.json"), "utf8")), { failure: "AGENT_FAILED", second: "reply-2" });
  assert.equal(current.opened.at(-1)?.sessionPath, undefined);
  const run = (await store.load()).run;
  assert.equal(handleAgent(run, 2).continuity, "fresh");
});

void test("aliased and computed agent references fail preflight", () => {
  const invalid = (error: unknown): boolean => error instanceof WorkflowError && error.code === "INVALID_METADATA";
  assert.throws(() => preflight(`const create = agent.create; const a = create({ name: args.name }); return a.send("x");`, capabilities), invalid);
  assert.throws(() => preflight(`const a = agent["create"]({ name: args.name }); return a.send("x");`, capabilities), invalid);
  assert.throws(() => preflight(`const alias = agent; return alias("work");`, capabilities), invalid);
  assert.throws(() => preflight(`const alias = agent; return alias("work");`, capabilities, [], { name: "workflow" }, true), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE");
});

void test("sends from a structural scope other than the creating one are rejected", async () => {
  const branched = `const author = agent.create({ name: "author" });
await author.send("one");
try { await parallel("branches", { left: () => author.send("two") }); } catch (failure) { return failure.code; }
return "accepted";`;
  assert.equal(await runWorkflow(branched, null, { agent: async () => "done" }).result, "INVALID_METADATA");
});

void test("handle send results reject serialization and interpolation before they are awaited", async () => {
  const misuse = `const author = agent.create({ name: "author" });
const pending = author.send("one");
const codes = [];
for (const misuse of [() => JSON.stringify(pending), () => pending.toString(), () => \`\${pending}\`, () => pending + ""]) {
  try { misuse(); codes.push("accepted"); } catch (failure) { codes.push(failure.code); }
}
await pending;
return codes;`;
  assert.deepEqual(await runWorkflow(misuse, null, { agent: async () => "done" }).result, ["INVALID_METADATA", "INVALID_METADATA", "INVALID_METADATA", "INVALID_METADATA"]);
});

void test("a handle name needing encoding round-trips its journal path and turn copy", async () => {
  const current = host();
  const name = "my handle/á";
  const encoded = `const author = agent.create({ name: ${JSON.stringify(name)} });
const first = await author.send("first draft");
const second = await author.send("apply findings");
return { first, second };`;
  const result = decodeTestToolResult(await current.workflow.execute("handle-encoded", { name: "handle-encoded", script: encoded, foreground: true }, new AbortController().signal, undefined, current.context));
  const store = new RunStore(current.home, "session", decodeTestRunDetails(result.details).runId, current.home);
  assert.deepEqual(JSON.parse(readFileSync(join(store.directory, "result.json"), "utf8")), { first: "reply-1", second: "reply-2" });
  assert.equal(agentHandleTurnPath(name, 2), "agent/handle/my%20handle%2F%C3%A1/turn%3A2");
  const turnInput = join(store.directory, "handles", encodeURIComponent(name), "turn-2-input-attempt-1.jsonl");
  assert.equal(current.opened[1]?.sessionPath, turnInput);
  assert.match(readFileSync(turnInput, "utf8"), /first draft/);
  assert.deepEqual(await store.replay(agentHandleTurnPath(name, 2)), { path: agentHandleTurnPath(name, 2), value: "reply-2" });
});

void test("an interrupted send never becomes a continuation source for a later turn", async () => {
  const current = host(undefined, undefined, (_text, count) => { if (count >= 2 && count <= 4) throw new Error("send failed"); });
  const interrupted = `const author = agent.create({ name: "author" });
const first = await author.send("first draft");
let failure = "none";
try { await author.send("boom"); } catch (error) { failure = error.code; }
const third = await author.send("third pass");
return { first, failure, third };`;
  await assert.rejects(current.workflow.execute("handle-interrupted", { name: "handle-interrupted", script: interrupted, foreground: true }, new AbortController().signal, undefined, current.context), WorkflowError);
  const sourceStore = new RunStore(current.home, "session", onlyRunId(await listRunIds(current.home, "session", current.home)), current.home);
  // A host dying mid-send leaves the running attempt persisted with its session locator and no error.
  await forgetAttemptField(sourceStore, 2, "error");
  const crashed = handleAgent((await sourceStore.load()).run, 2).attemptDetails?.at(-1);
  assert.ok(crashed?.session?.locator && !crashed.error);
  assert.equal(await sourceStore.replay(agentHandleTurnPath("author", 2)), undefined);
  const run = await loadUntil(current.home, await retried(current, sourceStore.runId), "completed");
  assert.equal(handleAgent(run, 3).continuity, "continued");
  assert.match(current.openedInput.at(-1) ?? "", /first draft/);
  assert.doesNotMatch(current.openedInput.at(-1) ?? "", /boom/);
});

void test("a journaled turn without a recorded session fails the next send loudly", async () => {
  const current = host(3);
  const three = `const author = agent.create({ name: "author" });
const first = await author.send("first draft");
const second = await author.send("apply findings");
const third = await author.send("third pass");
return { first, second, third };`;
  await assert.rejects(current.workflow.execute("handle-sessionless", { name: "handle-sessionless", script: three, foreground: true }, new AbortController().signal, undefined, current.context), WorkflowError);
  const sourceStore = new RunStore(current.home, "session", onlyRunId(await listRunIds(current.home, "session", current.home)), current.home);
  await forgetAttemptField(sourceStore, 2, "session");
  const run = await loadUntil(current.home, await retried(current, sourceStore.runId), "failed");
  assert.equal(run.error?.code, "AGENT_FAILED");
  assert.match(run.error.message, /cannot continue from its previous turn/);
});

const reviewSchemaReply = (pass: boolean, findings: string[]) => ({ pass, findings });
/** Answers reviewer sessions through their structured result tool, as a provider would. */
function reviewerReplies(replies: readonly { pass: boolean; findings: string[] }[]): (text: string, count: number, input: SessionInput) => Promise<void> {
  let next = 0;
  return async (text, _count, input) => {
    if (!text.includes("Review the actual current implementation")) return;
    await input.resultTool?.execute("review", replies[Math.min(next++, replies.length - 1)], new AbortController().signal, undefined, undefined as never);
  };
}
/** A host whose registry holds exactly these functions; the registry is process-global, so each test starts it clean. */
function functionHost(functions: Readonly<Record<string, WorkflowFunction>>, ...args: Parameters<typeof host>): Host {
  resetWorkflowRegistry();
  const current = host(...args);
  registerWorkflowExtension({ version: "1.0.0", headline: "Handle functions", functions });
  return current;
}
async function runFunction(current: Host, name: string, source: string): Promise<{ readonly store: RunStore; readonly result: unknown; readonly run: PersistedRun }> {
  const result = decodeTestToolResult(await current.workflow.execute(name, { name, script: source, foreground: true }, new AbortController().signal, undefined, current.context));
  const store = new RunStore(current.home, "session", decodeTestRunDetails(result.details).runId, current.home);
  return { store, result: JSON.parse(readFileSync(join(store.directory, "result.json"), "utf8")), run: (await store.load()).run };
}
const labelOf = (agent: AgentRecord): string => agent.label ?? agent.name;
const draftFunction: WorkflowFunction = { description: "Two drafts", input: { type: "object" }, output: { type: "object" }, async run(_input, context) {
  const developer = context.agent.create({ name: "developer", label: "Developer" });
  const first = await developer.send("first draft");
  const second = await developer.send("apply findings");
  return { first, second };
} };

void test("a registered function handle continues one transcript across real host turns", async () => {
  const current = functionHost({ drafter: draftFunction });
  const { store, result, run } = await runFunction(current, "function-handle-sequential", "return await drafter({});");
  assert.deepEqual(result, { first: "reply-1", second: "reply-2" });
  const turns = run.agents.filter((agent) => agent.handle !== undefined);
  assert.deepEqual(turns.map((agent) => [agent.turn, agent.continuity, labelOf(agent)]), [[1, "fresh", "Developer"], [2, "continued", "Developer"]]);
  const handle = turns[0]?.handle;
  assert.ok(handle);
  assert.ok(handle.startsWith("function-handle/"));
  assert.equal(turns[1]?.handle, handle);
  const turnInput = join(store.directory, "handles", encodeURIComponent(handle), "turn-2-input-attempt-1.jsonl");
  assert.equal(current.opened[0]?.sessionPath, undefined);
  assert.equal(current.opened[1]?.sessionPath, turnInput);
  assert.match(readFileSync(turnInput, "utf8"), /first draft/);
  assert.match(current.openedInput[1] ?? "", /first draft/);
  assert.deepEqual(await store.replay(agentHandleTurnPath(handle, 2)), { path: agentHandleTurnPath(handle, 2), value: "reply-2" });
});

void test("repeated function invocations and a same-named script handle keep separate transcripts", async () => {
  const current = functionHost({ drafter: draftFunction });
  const { result, run } = await runFunction(current, "function-handle-collisions", `const author = agent.create({ name: "developer" });
const scripted = await author.send("script turn");
const first = await drafter({});
const second = await drafter({});
return { scripted, first, second };`);
  assert.deepEqual(result, { scripted: "reply-1", first: { first: "reply-2", second: "reply-3" }, second: { first: "reply-4", second: "reply-5" } });
  assert.equal(new Set(run.agents.filter((agent) => agent.handle !== undefined).map((agent) => agent.handle)).size, 3);
  assert.deepEqual(current.opened.map((input) => input.sessionPath === undefined), [true, true, false, true, false]);
  assert.doesNotMatch(current.openedInput[2] ?? "", /script turn/);
  assert.equal((current.openedInput[4] ?? "").split("first draft").length, 2);
});

void test("reviewLoop keeps one developer transcript, uses fresh reviewers, and stops on the first pass", async () => {
  const current = functionHost({ reviewLoop }, undefined, undefined, reviewerReplies([reviewSchemaReply(false, ["Fix A"]), reviewSchemaReply(true, [])]));
  const { result, run } = await runFunction(current, "review-loop-bridge", `return await reviewLoop({ task: "Build the widget", maxIterations: 5 });`);
  assert.deepEqual(result, { pass: true, iterations: 2, devResult: "reply-3", review: { pass: true, findings: [] } });
  assert.equal(current.opened.length, 4);
  assert.deepEqual(run.agents.map((agent) => [labelOf(agent), agent.turn ?? null, agent.continuity ?? null]), [["Developer", 1, "fresh"], ["Reviewer 1", null, null], ["Developer", 2, "continued"], ["Reviewer 2", null, null]]);
  assert.match(current.prompts[0] ?? "", /Implement this task:\n\nBuild the widget/);
  assert.match(current.prompts[2] ?? "", /Fix A/);
  assert.doesNotMatch(current.prompts[2] ?? "", /Build the widget/);
  assert.match(current.openedInput[2] ?? "", /Build the widget/);
  for (const index of [1, 3]) {
    assert.equal(current.opened[index]?.sessionPath, undefined);
    assert.equal(current.openedInput[index], "");
    assert.match(current.prompts[index] ?? "", /Review the actual current implementation against the entire original task/);
    assert.match(current.prompts[index] ?? "", /Build the widget/);
  }
});

void test("reviewLoop with sharedReviewer continues one reviewer transcript", async () => {
  const current = functionHost({ reviewLoop }, undefined, undefined, reviewerReplies([reviewSchemaReply(false, ["Fix A"]), reviewSchemaReply(true, [])]));
  const { result, run } = await runFunction(current, "review-loop-shared", `return await reviewLoop({ task: "Build the widget", maxIterations: 5, sharedReviewer: true });`);
  assert.deepEqual(result, { pass: true, iterations: 2, devResult: "reply-3", review: { pass: true, findings: [] } });
  assert.deepEqual(run.agents.map((agent) => [labelOf(agent), agent.turn ?? null, agent.continuity ?? null]), [["Developer", 1, "fresh"], ["Reviewer", 1, "fresh"], ["Developer", 2, "continued"], ["Reviewer", 2, "continued"]]);
  assert.match(current.prompts[1] ?? "", /Build the widget/);
  assert.doesNotMatch(current.prompts[3] ?? "", /Build the widget/);
  assert.match(current.openedInput[3] ?? "", /Build the widget/);
});

void test("reviewLoop returns the last failing review at the iteration limit", async () => {
  const current = functionHost({ reviewLoop }, undefined, undefined, reviewerReplies([reviewSchemaReply(false, ["Still wrong"])]));
  const { result, run } = await runFunction(current, "review-loop-limit", `return await reviewLoop({ task: "Build the widget", maxIterations: 2 });`);
  assert.deepEqual(result, { pass: false, iterations: 2, devResult: "reply-3", review: { pass: false, findings: ["Still wrong"] } });
  assert.equal(current.opened.length, 4);
  assert.deepEqual(run.agents.map(labelOf), ["Developer", "Reviewer 1", "Developer", "Reviewer 2"]);
});

void test("a function handle send honours outputSchema and rejects unsupported options without a turn", async () => {
  const answer = async (text: string, _count: number, input: SessionInput): Promise<void> => { if (text.includes("structured")) await input.resultTool?.execute("structured", { answer: "yes" }, new AbortController().signal, undefined, undefined as never); };
  const current = functionHost({ structured: { description: "Structured", input: { type: "object" }, output: { type: "object" }, async run(_input, context) {
    const developer = context.agent.create({ name: "developer" });
    let code = "none";
    try { await developer.send("rejected", { label: "nope" } as never); } catch (error) { code = error instanceof WorkflowError ? error.code : "other"; }
    const value = await developer.send("structured", { outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false }, timeoutMs: 60_000 });
    return { code, value };
  } } }, undefined, undefined, answer);
  const { result, run } = await runFunction(current, "function-handle-schema", "return await structured({});");
  assert.deepEqual(result, { code: "INVALID_METADATA", value: { answer: "yes" } });
  assert.deepEqual(run.agents.map((agent) => agent.turn), [1]);
  assert.equal(current.prompts.length, 1);
  assert.match(current.prompts[0] ?? "", /structured/);
});

void test("retrying a function whose later handle turn failed replays completed turns and continues the transcript", async () => {
  const current = functionHost({ drafter: draftFunction }, 2);
  await assert.rejects(current.workflow.execute("function-handle-retry", { name: "function-handle-retry", script: "return await drafter({});", foreground: true }, new AbortController().signal, undefined, current.context), WorkflowError);
  const sourceStore = new RunStore(current.home, "session", onlyRunId(await listRunIds(current.home, "session", current.home)), current.home);
  const failed = (await sourceStore.load()).run.agents.filter((agent) => agent.handle !== undefined);
  const handle = failed[0]?.handle;
  assert.ok(handle);
  const summary = await sourceStore.loadSummary();
  assert.deepEqual(summary.replayablePaths.filter((path) => path.startsWith("agent/")), [agentHandleTurnPath(handle, 1)]);
  assert.equal(await sourceStore.replay(agentHandleTurnPath(handle, 2)), undefined);
  assert.equal(await sourceStore.replay("function/drafter/1"), undefined);
  const run = await loadUntil(current.home, await retried(current, sourceStore.runId), "completed");
  assert.equal(current.prompts.filter((prompt) => prompt.includes("first draft")).length, 1);
  assert.equal(current.prompts.filter((prompt) => prompt.includes("apply findings")).length, 2);
  const retriedTurn = run.agents.find((agent) => agent.handle === handle && agent.turn === 2);
  assert.equal(retriedTurn?.continuity, "continued");
  assert.match(current.openedInput.at(-1) ?? "", /first draft/);
  assert.doesNotMatch(current.openedInput.at(-1) ?? "", /apply findings/);
});

void test("handle sends rebuild workflow_result for each send's schema", async () => {
  const current = host(undefined, undefined, async (text, _count, input) => { if (text === "structured") await input.resultTool?.execute("structured", { answer: "yes" }, new AbortController().signal, undefined, undefined as never); });
  const schemaScript = `const dev = agent.create({ name: "dev" });
const a = await dev.send("plain");
const b = await dev.send("structured", { outputSchema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"], additionalProperties: false } });
return { a, b };`;
  await current.workflow.execute("schema-sends", { name: "schema-sends", script: schemaScript, foreground: true }, new AbortController().signal, undefined, current.context);
  const store = new RunStore(current.home, "session", onlyRunId(await listRunIds(current.home, "session", current.home)), current.home);
  const outcome = JSON.parse(readFileSync(join(store.directory, "result.json"), "utf8")) as { a: unknown; b: unknown };
  assert.deepEqual(outcome.b, { answer: "yes" });
  assert.equal(typeof outcome.a, "string");
  assert.deepEqual(current.prompts.slice(0, 2), ["plain", "structured"]);
  assert.match(current.opened[0]?.resultTool?.description ?? "", /\{ result: "final response" \}/);
  assert.match(current.opened[1]?.resultTool?.description ?? "", /matching the required schema/);
});
