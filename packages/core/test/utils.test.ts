import assert from "node:assert/strict";
import test from "node:test";
import { byPriorityThenName, coerceWorkflowError, isThinkingLevel, MODEL_ALIAS_NAME, SerialLane } from "../src/utils.js";
import { CONTEXT_FILE_SCOPES, HARD_TERMINAL_RUN_STATES, isContextFileScope, isExternallyEndedRunState, isHardTerminalRunState, RUN_STATES, THINKING_LEVELS, WorkflowError } from "../src/types.js";

void test("SerialLane runs queued tasks one at a time in submission order", async () => {
  const lane = new SerialLane();
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const first = lane.run(async () => {
    order.push("first:start");
    await firstGate;
    order.push("first:end");
    return "first";
  });
  const second = lane.run(async () => {
    order.push("second");
    return "second";
  });

  await Promise.resolve();
  assert.deepEqual(order, ["first:start"]);
  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
});

void test("coerceWorkflowError reuses a WorkflowError with the requested code", () => {
  const original = new WorkflowError("WORKTREE_FAILED", "worktree detail");

  assert.strictEqual(coerceWorkflowError("WORKTREE_FAILED", original), original);
  assert.equal(original.code, "WORKTREE_FAILED");
  assert.equal(original.message, "worktree detail");
});

void test("coerceWorkflowError wraps different-code and non-WorkflowError failures", () => {
  const differentCode = new WorkflowError("RESUME_INCOMPATIBLE", "resume detail");
  const wrappedDifferentCode = coerceWorkflowError("WORKTREE_FAILED", differentCode);
  assert.notStrictEqual(wrappedDifferentCode, differentCode);
  assert.ok(wrappedDifferentCode instanceof WorkflowError);
  assert.equal(wrappedDifferentCode.code, "WORKTREE_FAILED");
  assert.equal(wrappedDifferentCode.message, "resume detail");

  const original = new Error("filesystem detail");
  const wrappedError = coerceWorkflowError("RESUME_INCOMPATIBLE", original);
  assert.notStrictEqual(wrappedError, original);
  assert.ok(wrappedError instanceof WorkflowError);
  assert.equal(wrappedError.code, "RESUME_INCOMPATIBLE");
  assert.equal(wrappedError.message, "filesystem detail");
});

void test("SerialLane absorbs a failed task for subsequent tasks without hiding its error", async () => {
  const lane = new SerialLane();
  const failure = new Error("lane task failed");
  const failed = lane.run(async () => { throw failure; });
  const succeeding = lane.run(async () => "recovered");

  await assert.rejects(failed, failure);
  assert.equal(await succeeding, "recovered");
});

void test("shared vocabulary guards accept their members and reject strangers", () => {
  for (const scope of CONTEXT_FILE_SCOPES) assert.equal(isContextFileScope(scope), true);
  assert.equal(isContextFileScope("home"), false);
  assert.equal(isContextFileScope(undefined), false);
  for (const level of THINKING_LEVELS) assert.equal(isThinkingLevel(level), true);
  assert.equal(isThinkingLevel("ultra"), false);
  assert.equal(isThinkingLevel(1), false);
  assert.equal(MODEL_ALIAS_NAME.test("fast-1_x"), true);
  assert.equal(MODEL_ALIAS_NAME.test("1fast"), false);
});

void test("byPriorityThenName orders hooks by ascending priority and then by name", () => {
  const hooks = [{ name: "b", priority: 10 }, { name: "a", priority: 10 }, { name: "z", priority: 1 }, { name: "a", priority: 20 }];
  assert.deepEqual([...hooks].sort(byPriorityThenName).map(({ name, priority }) => `${name}:${String(priority)}`), ["z:1", "a:10", "b:10", "a:20"]);
});

void test("isHardTerminalRunState narrows to the states a run can never leave", () => {
  for (const state of RUN_STATES) assert.equal(isHardTerminalRunState(state), HARD_TERMINAL_RUN_STATES.has(state), state);
  assert.deepEqual(RUN_STATES.filter(isHardTerminalRunState), ["completed", "failed", "stopped"]);
});


void test("isExternallyEndedRunState narrows to stop, interruption, and budget exhaustion", () => {
  assert.deepEqual(RUN_STATES.filter(isExternallyEndedRunState), ["stopped", "interrupted", "budget_exhausted"]);
});
