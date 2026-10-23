import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { addAccounting, createLaunchSnapshot, DEFAULT_SETTINGS, zeroAccounting, type AgentAccounting, type AgentRecord } from "../src/index.js";
import { validAgentSpeed } from "../src/agent-speed.js";
import { RunStore } from "../src/persistence.js";
import { accountingValue, attemptValue } from "../subagents/src/decode.js";

const SPEED = { messages: 2, outputTokens: 100, generationMs: 4_000, firstTokenMs: 600 };
const base = { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, cost: 0.5 };
const launch = createLaunchSnapshot({ script: "export const meta={name:'x',description:'x'}", args: null, metadata: { name: "x", description: "x" }, settings: DEFAULT_SETTINGS, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [] });
const agent = (accounting: AgentAccounting): AgentRecord => ({ id: "a", name: "a", path: "a", state: "completed", model: { provider: "openai", model: "gpt" }, tools: [], attempts: 1, accounting, attemptDetails: [{ attempt: 1, transport: "local", setup: { hookNames: [], model: { provider: "openai", model: "gpt" }, tools: [], cwd: "/repo" }, accounting }] });
const runWith = (cwd: string, accounting: AgentAccounting) => ({ id: "run-a", workflowName: "x", cwd, sessionId: "session-a", state: "completed" as const, agents: [agent(accounting)], agentSessions: [] });

void test("addAccounting adds speed only when a side has it", () => {
  assert.equal("speed" in addAccounting(zeroAccounting(), zeroAccounting()), false);
  assert.deepEqual(addAccounting({ ...zeroAccounting(), speed: SPEED }, zeroAccounting()).speed, SPEED);
  assert.deepEqual(addAccounting(zeroAccounting(), { ...zeroAccounting(), speed: SPEED }).speed, SPEED);
  assert.deepEqual(addAccounting({ ...zeroAccounting(), speed: SPEED }, { ...zeroAccounting(), speed: SPEED }).speed, { messages: 4, outputTokens: 200, generationMs: 8_000, firstTokenMs: 1_200 });
});

void test("speed counters must be consistent", () => {
  assert.deepEqual(validAgentSpeed(SPEED), SPEED);
  for (const bad of [{ ...SPEED, messages: 0 }, { ...SPEED, outputTokens: 1 }, { ...SPEED, generationMs: -1 }, { ...SPEED, firstTokenMs: Number.NaN }, { ...SPEED, messages: 1.5 }, [], null, "x"]) assert.equal(validAgentSpeed(bad), undefined);
});

void test("a run keeps speed across load and updateState, an old run decodes without it, an invalid speed is rejected", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-ewf-speed-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session-a", "run-a", home);
  await store.create(runWith(cwd, { ...base, speed: SPEED }), launch);
  await store.updateState((current) => ({ ...current, phase: "x" }));
  const loaded = (await store.load()).run.agents[0];
  assert.ok(loaded);
  assert.deepEqual(loaded.accounting?.speed, SPEED);
  assert.deepEqual(loaded.attemptDetails?.[0]?.accounting.speed, SPEED);

  const old = new RunStore(cwd, "session-a", "run-old", home);
  await old.create({ ...runWith(cwd, base), id: "run-old" }, launch);
  const oldAgent = (await old.load()).run.agents[0];
  assert.equal(oldAgent?.accounting && "speed" in oldAgent.accounting, false);

  const file = join(store.directory, "state.json");
  const state = JSON.parse(readFileSync(file, "utf8")) as { agents: { accounting: { speed: unknown } }[] };
  const [first] = state.agents;
  assert.ok(first);
  first.accounting.speed = { ...SPEED, messages: 0 };
  writeFileSync(file, JSON.stringify(state));
  await assert.rejects(store.load());
});

void test("subagent status decoders keep a valid speed, accept its absence and reject an invalid one", () => {
  assert.deepEqual(accountingValue({ ...base, speed: SPEED }), { ...base, speed: SPEED });
  assert.deepEqual(accountingValue(base), base);
  assert.equal(accountingValue({ ...base, speed: { ...SPEED, outputTokens: 0 } }), undefined);
  const attempt = { attempt: 1, transport: "local", setup: { hookNames: [], model: { provider: "p", model: "m" }, tools: [], cwd: "/repo" }, accounting: { ...base, speed: SPEED } };
  assert.deepEqual(attemptValue(attempt)?.accounting.speed, SPEED);
});
