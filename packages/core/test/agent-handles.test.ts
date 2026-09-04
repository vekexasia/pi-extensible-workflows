import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { decodeTestRunDetails, decodeTestRunStart, decodeTestToolResult, testExtensionApi } from "./support.js";
import workflowExtension, { preflight, RunStore, runWorkflow, WorkflowError, type AgentRecord, type JsonValue, type PersistedRun } from "../src/index.js";
import type { SessionInput } from "../src/agent-execution.js";
import { listRunIds } from "../src/persistence.js";
import { agentHandleTurnPath } from "../src/execution.js";
import { testTransport, type TestPiSession } from "./test-transport.js";

const capabilities = { models: new Set(["openai/gpt"]), tools: new Set(["read"]), agentTypes: new Set(["reviewer"]) };
const script = `const author = agent.create({ name: "author" });
const first = await author.send("first draft");
const second = await author.send("apply findings");
return { first, second };`;

type TestTool = { name: string; execute: (...args: unknown[]) => Promise<unknown> };
type Host = { readonly home: string; readonly workflow: TestTool; readonly retry: TestTool; readonly context: Record<string, unknown>; readonly opened: readonly SessionInput[]; readonly openedInput: readonly string[]; readonly prompts: readonly string[] };
const terminalProviderError = { role: "assistant", content: [{ type: "text", text: "" }], stopReason: "error", errorMessage: "MODEL_UNAVAILABLE" };

/** Hosts one workflow extension whose fake sessions persist their turns as JSONL, like Pi does. */
function host(failTurn?: number, providerErrorSession?: number, onPrompt?: (text: string, count: number) => void): Host {
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
        onPrompt?.(text, prompts.length);
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
  assert.deepEqual(preflight(`const a = agent.create({ name: "author", role: "reviewer", model: "openai/gpt:high", tools: ["read"] }); return a.send("x");`, capabilities).referenced, { phases: [], models: ["openai/gpt"], tools: ["read"], agentTypes: ["reviewer"] });
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
