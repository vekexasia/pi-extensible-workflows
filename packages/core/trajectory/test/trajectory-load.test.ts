import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workflowExtension from "../../src/index.js";
import { trajectoryRunUsage, type TrajectoryPublisherMetadata } from "../../src/trajectory.js";
import { setTrajectoryHost, type TrajectoryPublisherProvider } from "../../src/trajectory-host-handle.js";
import type { AgentActivity } from "../../src/types.js";
import { testExtensionApi, waitForIssue105 } from "../../test/support.js";
import { testTransport, type TestPiSession } from "../../test/test-transport.js";
import { LOAD_FIXTURE_DEFAULTS, loadFixtureDescriptor, loadFixtureRuns, loadPublisherInput, writeLoadFixture } from "./load-fixture.js";

/** Lists the JSON paths whose values differ, so a test can pin exactly what a live tick changes. */
function changedPaths(left: unknown, right: unknown, path = ""): string[] {
  if (left === right) return [];
  if (!left || !right || typeof left !== "object" || typeof right !== "object" || Array.isArray(left) !== Array.isArray(right)) return [path];
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return [...keys].flatMap((key) => changedPaths((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key], `${path}/${key}`));
}

void test("Trajectory load fixture is deterministic and sized like the copied 102-run session", () => {
  const fixture = loadFixtureDescriptor("/fixture-root", 0);
  const runs = loadFixtureRuns(fixture);
  assert.deepEqual(loadFixtureRuns(fixture), runs);
  const totals = { state: 0, systemPrompts: 0, prompts: 0, attemptDetails: 0 };
  for (const { run, snapshot } of runs) {
    totals.state += Buffer.byteLength(JSON.stringify(run)) + Buffer.byteLength(JSON.stringify(snapshot));
    for (const agent of run.agents) {
      totals.systemPrompts += Buffer.byteLength(agent.systemPrompt ?? "");
      totals.prompts += Buffer.byteLength(agent.prompt ?? "");
      totals.attemptDetails += Buffer.byteLength(JSON.stringify(agent.attemptDetails));
    }
  }
  const near = (actual: number, expected: number, tolerance: number) => { assert.ok(Math.abs(actual - expected) <= expected * tolerance, `${String(actual)} is not within ${String(tolerance * 100)}% of ${String(expected)}`); };
  near(totals.state, 8_990_000, 0.05);
  near(totals.systemPrompts, 4_550_000, 0.05);
  near(totals.prompts, 1_570_000, 0.05);
  near(totals.attemptDetails, 1_350_000, 0.05);
  assert.equal(runs.length, LOAD_FIXTURE_DEFAULTS.runs);
  assert.deepEqual(runs.filter(({ run }) => run.state === "running").map(({ run }) => run.id), [fixture.activeRunId]);
  assert.deepEqual(runs.flatMap(({ run }) => run.agents.filter((agent) => agent.state === "running").map((agent) => agent.id)), [fixture.varyingAgentId]);
});

void test("Trajectory load publisher ignores clock-only ticks and reports one agent's activity", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "trajectory-load-fixture-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await writeLoadFixture(root, 0, { ...LOAD_FIXTURE_DEFAULTS, runs: 3 });
  const live: { clock: number; activity?: AgentActivity } = { clock: 1_000_000 };
  const input = loadPublisherInput(fixture, { now: () => live.clock, activity: () => live.activity });

  const first = await input.loadMetadata();
  assert.equal(first.runs.length, 3);
  assert.deepEqual(await input.loadMetadata(), first);

  live.clock += 1_000;
  const ticked = await input.loadMetadata();
  assert.equal(ticked.runs[0]?.run.id, fixture.activeRunId);
  assert.deepEqual(changedPaths(first, ticked), []);

  live.activity = { kind: "tool", text: "step 1" };
  const active = await input.loadMetadata();
  const agentIndex = active.runs[0]?.run.agents.findIndex((agent) => agent.id === fixture.varyingAgentId);
  assert.deepEqual(changedPaths(ticked, active), [`/runs/0/run/agents/${String(agentIndex)}/activity`]);
});

void test("Trajectory publishes a running run unchanged when only the clock advances, then its exact duration once it finishes", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: 1_700_000_000_000 });
  const home = await mkdtemp(join(tmpdir(), "trajectory-load-clock-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  let provider: TrajectoryPublisherProvider | undefined;
  setTrajectoryHost({ open: async () => {}, autoAttach(candidate) { provider = candidate; }, close: async () => {} });
  t.after(() => { setTrajectoryHost(undefined); });
  const gate: { started: boolean; release?: () => void } = { started: false };
  const released = new Promise<void>((resolve) => { gate.release = resolve; });
  const createSession = async (): Promise<TestPiSession> => ({ sessionId: "clock-session", messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => { gate.started = true; await released; }, steer: async () => {}, dispose() {} });
  const tools: { name: string; execute: (...args: unknown[]) => Promise<unknown> }[] = [];
  workflowExtension(testExtensionApi({ registerTool(tool) { tools.push(tool as (typeof tools)[number]); }, getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd: home, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } };
  await workflow.execute("id", { name: "clock-only", script: "return await agent('work');" }, new AbortController().signal, undefined, context);
  await waitForIssue105(() => gate.started);
  assert.ok(provider);
  const input = provider(context);
  let before = await input.loadMetadata();
  // Launch persistence settles asynchronously; the frozen clock keeps every later difference substantive.
  await waitForIssue105(async () => { const next = await input.loadMetadata(); const settled = JSON.stringify(next) === JSON.stringify(before); before = next; return settled; });
  assert.equal(before.runs[0]?.run.state, "running");

  t.mock.timers.tick(1_000);
  assert.deepEqual(changedPaths(before, await input.loadMetadata()), []);

  gate.release?.();
  let finished: TrajectoryPublisherMetadata | undefined;
  const started = performance.now(); let checks = 0;
  try { await waitForIssue105(async () => { checks += 1; finished = await input.loadMetadata(); return finished.runs[0]?.run.state === "completed"; }); }
  catch {
    const failedAt = Math.round(performance.now() - started);
    let slow = 0;
    for (; slow < 150; slow += 1) { await new Promise((resolve) => setTimeout(resolve, 200)); finished = await input.loadMetadata(); if (finished.runs[0]?.run.state === "completed") break; }
    assert.fail(`DEBUG not completed after ${String(checks)} checks, ${String(failedAt)} ms; slow polling (200 ms) ${slow < 150 ? `completed after ${String(slow + 1)} more polls` : "never completed in 30 s"}, total ${String(Math.round(performance.now() - started))} ms, state ${String(finished?.runs[0]?.run.state)}`);
  }
  assert.equal(finished?.runs[0]?.run.usage?.durationMs, 1_000);
});

void test("Trajectory run usage keeps live usage except a running run's clock-driven duration", () => {
  const live = { tokens: 9, costUsd: 0.5, durationMs: 7_000, agentLaunches: 2 };
  const persisted = { tokens: 4, costUsd: 0.1, durationMs: 3_000, agentLaunches: 1 };
  assert.deepEqual(trajectoryRunUsage("running", live, persisted), { ...live, durationMs: 3_000 });
  assert.equal(trajectoryRunUsage("running", live, undefined), live);
  for (const state of ["pausing", "paused", "awaiting_input", "budget_exhausted", "completed", "failed", "stopped"] as const) assert.equal(trajectoryRunUsage(state, live, persisted), live);
});
