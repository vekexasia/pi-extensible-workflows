import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

function source(name: string): string {
  return readFileSync(resolve(sourceRoot, name), "utf8");
}

function importsFrom(sourceText: string, symbol: string, module: string): boolean {
  return new RegExp(`import\\s+(?:type\\s+)?\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s+from\\s+["']${module}["']`, "s").test(sourceText);
}

void test("Pi runtime derives thinking validation from the canonical types vocabulary", () => {
  const types = source("types.ts");
  const utils = source("utils.ts");
  const adapter = source("pi-runtime-adapter.ts");
  const consumers = [adapter, source("decoders.ts")];

  assert.match(types, /export const THINKING_LEVELS = \[[^\]]+\] as const;/);
  assert.match(types, /export type ThinkingLevel = \(typeof THINKING_LEVELS\)\[number\];/);
  assert.equal(importsFrom(utils, "THINKING_LEVELS", "\\./types\\.js"), true, "utils owns the single thinking-level guard");
  for (const consumer of consumers) {
    assert.doesNotMatch(consumer, /["']off["']\s*,\s*["']minimal["']\s*,\s*["']low["']\s*,\s*["']medium["']\s*,\s*["']high["']\s*,\s*["']xhigh["']\s*,\s*["']max["']/);
    assert.doesNotMatch(consumer, /THINKING_LEVELS\.some\(/, "consumers go through isThinkingLevel() instead of scanning the list");
  }
  assert.doesNotMatch(adapter, /^\s*const THINKING_LEVELS\s*=/m);
});

void test("scheduler and persistence state validation use the canonical agent-state vocabulary", () => {
  const types = source("types.ts");
  const execution = source("agent-execution.ts");
  const decoders = source("decoders.ts");

  assert.match(types, /export const AGENT_STATES = \[[^\]]+\] as const;/);
  assert.match(types, /export type AgentState = \(typeof AGENT_STATES\)\[number\];/);
  assert.equal(importsFrom(execution, "AgentState", "\\./types\\.js"), true);
  assert.match(execution, /state: AgentState;/);
  assert.doesNotMatch(execution, /state:\s*["']queued["']\s*\|/);

  assert.equal((decoders.match(/AGENT_STATES\.(?:some|includes)\s*\(/g) ?? []).length, 1);
  assert.doesNotMatch(decoders, /function isOwnershipState\s*\(/);
});

void test("host runtime and workflow evals reuse the shared workflow-error guard", () => {
  for (const [name, utilsModule] of [["host-runtime.ts", "\\./utils\\.js"], ["../evals/src/workflow-evals.ts", "\\.\\./\\.\\./src/utils\\.js"]] as const) {
    const sourceText = source(name);
    assert.equal(importsFrom(sourceText, "isWorkflowErrorCode", utilsModule), true, `${name} must import the shared guard directly from utils`);
    assert.doesNotMatch(sourceText, /function isWorkflowErrorCode\s*\(/, `${name} must not define a local guard`);
  }
});

void test("context-file scopes are declared once in types and reused by every consumer", () => {
  const types = source("types.ts");
  assert.match(types, /export type ContextFileScope = \(typeof CONTEXT_FILE_SCOPES\)\[number\];/);
  for (const name of ["decoders.ts", "validation.ts", "host.ts", "agent-execution.ts"]) {
    const consumer = source(name);
    assert.equal(importsFrom(consumer, "isContextFileScope", "\\./types\\.js"), true, `${name} must import the shared scope guard`);
    assert.doesNotMatch(consumer, /["']global["']\s*,\s*["']project["']\s*,\s*["']cwd["']/, `${name} must not restate the scope list`);
    assert.doesNotMatch(consumer, /===\s*["']global["']\s*\|\|/, `${name} must not restate the scope comparison chain`);
    assert.doesNotMatch(consumer, /!==\s*["']global["']\s*&&/, `${name} must not restate the scope comparison chain`);
    assert.doesNotMatch(consumer, /function isContextFileScope\s*\(/, `${name} must not define a local scope guard`);
  }
});

void test("budget dimensions and event types are declared once in types and reused", () => {
  const types = source("types.ts");
  assert.match(types, /export type BudgetDimension = \(typeof BUDGET_DIMENSIONS\)\[number\];/);
  assert.match(types, /export type BudgetEventType = \(typeof BUDGET_EVENT_TYPES\)\[number\];/);
  for (const name of ["budget.ts", "decoders.ts", "host-view.ts", "background-widget.ts"]) {
    const consumer = source(name);
    assert.equal(importsFrom(consumer, "BUDGET_DIMENSIONS", "\\./types\\.js"), true, `${name} must import the shared dimension list`);
    assert.doesNotMatch(consumer, /["']tokens["']\s*,\s*["']costUsd["']\s*,\s*["']durationMs["']\s*,\s*["']agentLaunches["']/, `${name} must not restate the dimension list`);
  }
  const decoders = source("decoders.ts");
  assert.equal(importsFrom(decoders, "BUDGET_EVENT_TYPES", "\\./types\\.js"), true);
  assert.doesNotMatch(decoders, /["']soft_crossed["']\s*,\s*["']hard_overrun["']/);
});

void test("thinking-level validation reuses the shared utils guard", () => {
  const utils = source("utils.ts");
  assert.match(utils, /export function isThinkingLevel\(/);
  for (const name of ["decoders.ts", "pi-runtime-adapter.ts"]) {
    const consumer = source(name);
    assert.equal(importsFrom(consumer, "isThinkingLevel", "\\./utils\\.js"), true, `${name} must import the shared guard`);
    assert.doesNotMatch(consumer, /function isThinking\s*\(/, `${name} must not define a local thinking guard`);
  }
});

void test("terminal run and settled agent vocabularies are not restated locally", () => {
  for (const name of ["store.ts", "background-widget.ts", "host-view.ts"]) {
    const consumer = source(name);
    assert.equal(importsFrom(consumer, "HARD_TERMINAL_RUN_STATES", "\\./types\\.js"), true, `${name} must import HARD_TERMINAL_RUN_STATES`);
    assert.doesNotMatch(consumer, /["']completed["']\s*,\s*["']failed["']\s*,\s*["']stopped["']/, `${name} must not restate the hard-terminal run states`);
    assert.doesNotMatch(consumer, /===\s*["']completed["']\s*\|\|\s*\w+\s*===\s*["']failed["']\s*\|\|\s*\w+\s*===\s*["']stopped["']/, `${name} must not restate the hard-terminal comparison chain`);
  }
  const execution = source("agent-execution.ts");
  assert.equal(importsFrom(execution, "SETTLED_AGENT_STATES", "\\./types\\.js"), true);
  assert.doesNotMatch(execution, /\[\s*["']completed["']\s*,\s*["']failed["']\s*,\s*["']cancelled["']\s*\]/);
});

void test("shared helpers replace local re-implementations", () => {
  const decoders = source("decoders.ts");
  assert.doesNotMatch(decoders, /^export function positiveInteger\s*\(/m, "decoders must not export a second positiveInteger");
  assert.equal(importsFrom(decoders, "positiveInteger", "\\./utils\\.js"), true);
  assert.equal(importsFrom(source("store.ts"), "positiveInteger", "\\./utils\\.js"), true);

  const execution = source("agent-execution.ts");
  assert.doesNotMatch(execution, /^export interface AgentDefinition\b/m, "AgentDefinition is declared in types.ts");
  assert.doesNotMatch(execution, /input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0/, "agent-execution must use zeroAccounting()");
  assert.equal(importsFrom(execution, "zeroAccounting", "\\./types\\.js"), true);

  const view = source("host-view.ts");
  assert.doesNotMatch(view, /input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0/, "host-view must use sumAccounting()");
  assert.equal(importsFrom(view, "sumAccounting", "\\./types\\.js"), true);

  const types = source("types.ts");
  assert.match(types, /^\s{2}accounting\?: AgentAccounting;$/m, "AgentRecord.accounting must reuse AgentAccounting");

  const registry = source("registry.ts");
  assert.equal(importsFrom(registry, "MODEL_ALIAS_NAME", "\\./utils\\.js"), true);
  assert.doesNotMatch(registry, /\/\^\[A-Za-z\]\[A-Za-z0-9_-\]\*\$\//);
});

void test("agent setup hooks are ordered by one shared comparator", () => {
  for (const name of ["registry.ts", "agent-execution.ts"]) {
    const consumer = source(name);
    assert.equal(importsFrom(consumer, "byPriorityThenName", "\\./utils\\.js"), true, `${name} must import byPriorityThenName`);
    assert.doesNotMatch(consumer, /left\.priority - right\.priority/, `${name} must not restate the hook comparator`);
  }
});

void test("hard-terminal narrowing goes through the shared type guard", () => {
  const types = source("types.ts");
  assert.match(types, /export function isHardTerminalRunState\(/);
  const host = source("host.ts");
  assert.equal(importsFrom(host, "isHardTerminalRunState", "\\./types\\.js"), true);
  assert.doesNotMatch(host, /as "completed" \| "failed" \| "stopped"/, "host.ts must not cast into the hard-terminal union");
  assert.doesNotMatch(host, /state === "completed" \|\| [\w.]+state === "failed" \|\| [\w.]+state === "stopped"/, "host.ts must not restate the hard-terminal chain");
});

void test("subagent decoding reuses the shared thinking and number guards", () => {
  const decode = source("../subagents/src/decode.ts");
  assert.equal(importsFrom(decode, "parseThinking", "\\.\\./\\.\\./src/utils\\.js"), true);
  assert.equal(importsFrom(decode, "finiteNumber", "\\.\\./\\.\\./src/utils\\.js"), true);
  assert.doesNotMatch(decode, /function thinkingValue\(/);
  assert.doesNotMatch(decode, /function finiteNumber\(/);
  assert.doesNotMatch(decode, /type ModelThinking = /);
  assert.doesNotMatch(decode, /["']off["']\s*\|\s*["']minimal["']/);
});

void test("manual deletion and retention derive run dependencies from one function", () => {
  const navigator = source("host-navigator.ts");
  assert.equal(importsFrom(navigator, "runDependencyIds", "\\./retention\\.js"), true);
  assert.doesNotMatch(navigator, /direct\.add\(run\.retry\.lineageRootRunId\)/);
  const retention = source("retention.ts");
  assert.match(retention, /export function runDependencyIds\(/);
  assert.doesNotMatch(retention, /dependencies\.add\(loaded\.run\.retry\.lineageRootRunId\)/);
});

void test("host session cleanup is released through one path", () => {
  const host = source("host.ts");
  assert.equal((host.match(/clearSubagentStatusObserver\(\);/g) ?? []).length, 1, "session_start failure and session_shutdown must share releaseSessionResources()");
  assert.match(host, /const releaseSessionResources = async \(\) => \{/);
  assert.equal((host.match(/await releaseSessionResources\(\);/g) ?? []).length, 2, "session_start failure and session_shutdown are the two call sites");
});

void test("the subagent manager reuses the shared number and thinking guards", () => {
  const manager = source("../subagents/src/manager.ts");
  assert.doesNotMatch(manager, /^function finite\(/m, "finiteNumber is already imported from the core");
  assert.doesNotMatch(manager, /thinking !== "off" && thinking !== "minimal"/, "thinking levels are validated by isThinkingLevel()");
  assert.match(manager, /\bisThinkingLevel\b/);
});

void test("run states that end execution without a failure are one shared vocabulary", () => {
  const types = source("types.ts");
  assert.match(types, /export function isExternallyEndedRunState\(/);
  for (const name of ["host.ts", "host-recovery.ts"]) {
    const consumer = source(name);
    assert.equal(importsFrom(consumer, "isExternallyEndedRunState", "\\./types\\.js"), true, `${name} must import the shared guard`);
    assert.doesNotMatch(consumer, /\["stopped", "interrupted", "budget_exhausted"\]/, `${name} must not restate the externally-ended states`);
    assert.doesNotMatch(consumer, /=== "stopped" \|\| [\w.]+ === "interrupted" \|\| [\w.]+ === "budget_exhausted"/, `${name} must not restate the externally-ended comparison chain`);
  }
});

void test("the Pi runtime runner reuses shared message and error helpers", () => {
  const runner = source("pi-runtime-runner.ts");
  assert.doesNotMatch(runner, /^function errorText\(/m, "errorText is owned by utils");
  assert.equal(importsFrom(runner, "errorText", "\\./utils\\.js"), true);
  assert.doesNotMatch(runner, /^function isEmptyAbortedAssistant\(/m);
  assert.doesNotMatch(source("agent-execution.ts"), /^function isEmptyAbortedAssistant\(/m);
  assert.match(source("pi-runtime-adapter.ts"), /^export function isEmptyAbortedAssistant\(/m);
  for (const name of ["pi-runtime-runner.ts", "agent-execution.ts"]) assert.equal(importsFrom(source(name), "isEmptyAbortedAssistant", "\\./pi-runtime-adapter\\.js"), true, name);
});
