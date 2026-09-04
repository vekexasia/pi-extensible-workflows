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
type Host = { readonly home: string; readonly workflow: TestTool; readonly retry: TestTool; readonly context: Record<string, unknown>; readonly opened: readonly SessionInput[]; readonly prompts: readonly string[] };

/** Hosts one workflow extension whose fake sessions persist their turns as JSONL, like Pi does. */
function host(failTurn?: number): Host {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-handles-"));
  const sessions = join(home, "sessions");
  mkdirSync(sessions, { recursive: true });
  const opened: SessionInput[] = [];
  const prompts: string[] = [];
  let created = 0;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    opened.push(input);
    const index = ++created;
    const sessionFile = input.sessionPath ?? join(sessions, `session-${String(index)}.jsonl`);
    if (!input.sessionPath) writeFileSync(sessionFile, "");
    return {
      sessionId: `session-${String(index)}`, sessionFile,
      messages: [{ role: "assistant", content: [{ type: "text", text: `reply-${String(index)}` }] }],
      getSessionStats: () => ({ tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 }, cost: 0 }),
      prompt: async (text: string) => {
        prompts.push(text);
        appendFileSync(sessionFile, `${JSON.stringify({ role: "user", text })}\n`);
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
  return { home, workflow, retry, context: { cwd: home, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }, opened, prompts };
}
function launch(current: Host, name: string): Promise<unknown> {
  return current.workflow.execute(name, { name, script, foreground: true }, new AbortController().signal, undefined, current.context);
}
async function loadUntil(home: string, runId: string, state: PersistedRun["state"]): Promise<PersistedRun> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = (await new RunStore(home, "session", runId, home).load()).run;
    if (current.state === state) return current;
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${runId} to become ${state}`);
}
function handleAgent(run: PersistedRun, turn: number): AgentRecord {
  const agent = run.agents.find((candidate) => candidate.handle === "author" && candidate.turn === turn);
  assert.ok(agent, `run has no handle turn ${String(turn)}`);
  return agent;
}

void test("sequential handle sends continue one transcript from a per-turn session copy", async () => {
  const current = host();
  const result = decodeTestToolResult(await launch(current, "handle-sequential"));
  const store = new RunStore(current.home, "session", decodeTestRunDetails(result.details).runId, current.home);
  assert.deepEqual(JSON.parse(readFileSync(join(store.directory, "result.json"), "utf8")), { first: "reply-1", second: "reply-2" });
  const turnInput = join(store.directory, "handles", "author", "turn-2-input.jsonl");
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
  const turnInput = join(store.directory, "handles", "author", "turn-2-input.jsonl");
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
