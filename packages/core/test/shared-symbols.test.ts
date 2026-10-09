import assert from "node:assert/strict";
import test from "node:test";
import { decodeOwnershipRecords } from "../src/decoders.js";
import { AGENT_STATES, ERROR_CODES, THINKING_LEVELS, type ModelSpec, type ThinkingLevel } from "../src/types.js";
import { assertModelThinking, finiteNumber, isWorkflowErrorCode, parseModelReference, parseThinking } from "../src/utils.js";

void test("shared workflow error-code guard recognizes the public error vocabulary", () => {
  for (const code of ERROR_CODES) assert.equal(isWorkflowErrorCode(code), true);
  for (const value of ["NOT_A_WORKFLOW_ERROR", "", null, 42, undefined]) assert.equal(isWorkflowErrorCode(value), false);
});

void test("shared finite-number guard accepts only finite numbers", () => {
  for (const value of [0, -1, Number.MIN_VALUE, Number.MAX_VALUE]) assert.equal(finiteNumber(value), true);
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, "1", null, undefined]) assert.equal(finiteNumber(value), false);
});

void test("shared thinking vocabulary drives model parsing and remains type-safe", () => {
  const expected = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const satisfies readonly ThinkingLevel[];
  assert.deepEqual(THINKING_LEVELS, expected);

  for (const level of THINKING_LEVELS) {
    assert.equal(parseThinking(level), level);
    assert.deepEqual(parseModelReference(`provider/model:${level}`), { provider: "provider", model: "model", thinking: level } satisfies ModelSpec);
  }
  assert.equal(parseThinking("invalid"), undefined);
});

void test("model references keep a colon-bearing model id and still read a thinking suffix", () => {
  assert.deepEqual(parseModelReference("deepseek/deepseek-v4.1-flash:nitro"), { provider: "deepseek", model: "deepseek-v4.1-flash:nitro" } satisfies ModelSpec);
  assert.deepEqual(parseModelReference("openrouter/deepseek/deepseek-v4.1-flash:nitro:high"), { provider: "openrouter", model: "deepseek/deepseek-v4.1-flash:nitro", thinking: "high" } satisfies ModelSpec);
  for (const level of THINKING_LEVELS) {
    assert.deepEqual(parseModelReference(`provider/model:segment:${level}`), { provider: "provider", model: "model:segment", thinking: level } satisfies ModelSpec);
  }
  // A trailing segment that names no thinking level is indistinguishable from a model id, so it stays one.
  assert.deepEqual(parseModelReference("provider/model:invalid"), { provider: "provider", model: "model:invalid" } satisfies ModelSpec);
  assert.throws(() => parseModelReference("provider/model:"), /Invalid model spec/);
  assert.throws(() => parseModelReference("provider/:high"), /Invalid model spec/);
  // Namespaced provider ids keep their slash.
  assert.deepEqual(parseModelReference("openrouter/anthropic/claude-opus-5.5"), { provider: "openrouter", model: "anthropic/claude-opus-5.5" } satisfies ModelSpec);
  assert.deepEqual(parseModelReference("openrouter/anthropic/claude-opus-5.5:high"), { provider: "openrouter", model: "anthropic/claude-opus-5.5", thinking: "high" } satisfies ModelSpec);
  assert.throws(() => parseModelReference("provider/model: extra"), /Invalid model spec/);
});

void test("role and agent model declarations still demand an explicit thinking level", () => {
  assert.throws(() => { assertModelThinking("openrouter/deepseek/deepseek-v4.1-flash:nitro"); }, /must be provider\/model:thinking/);
  assert.doesNotThrow(() => { assertModelThinking("openrouter/deepseek/deepseek-v4.1-flash:nitro:high"); });
  assert.doesNotThrow(() => { assertModelThinking("provider/model:high"); });
});

void test("ownership decoding accepts every shared agent state and rejects unknown states", () => {
  const options = { label: "worker", cwd: "/repo", tools: [] };
  const records = AGENT_STATES.map((state) => ({ id: state, label: state, state, options }));

  assert.deepEqual(decodeOwnershipRecords(records), records);
  assert.equal(decodeOwnershipRecords([{ ...records[0], state: "unknown" }]), undefined);
});
