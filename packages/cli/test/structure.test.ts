import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
function source(name: string): string { return readFileSync(resolve(sourceRoot, name), "utf8"); }
function importsFrom(text: string, symbol: string): boolean {
  return new RegExp(`import\\s+(?:type\\s+)?(?:\\w+\\s*,\\s*)?\\{[^}]*\\b${symbol}\\b[^}]*\\}\\s+from\\s+["']pi-extensible-workflows["']`, "s").test(text);
}

void test("the CLI reuses the core vocabularies and guards instead of restating them", () => {
  const cleanup = source("doctor-cleanup.ts");
  for (const symbol of ["AGENT_STATES", "BUDGET_DIMENSIONS", "BUDGET_EVENT_TYPES", "HARD_TERMINAL_RUN_STATES", "isThinkingLevel", "object"]) assert.equal(importsFrom(cleanup, symbol), true, `doctor-cleanup must import ${symbol} from the core package`);
  assert.doesNotMatch(cleanup, /["']completed["']\s*,\s*["']failed["']\s*,\s*["']stopped["']/, "hard-terminal run states are core vocabulary");
  assert.doesNotMatch(cleanup, /["']queued["']\s*,\s*["']running["']\s*,\s*["']waiting_for_child["']/, "agent states are core vocabulary");
  assert.doesNotMatch(cleanup, /["']tokens["']\s*,\s*["']costUsd["']/, "budget dimensions are core vocabulary");
  assert.doesNotMatch(cleanup, /["']soft_crossed["']\s*,\s*["']hard_overrun["']/, "budget event types are core vocabulary");
  assert.doesNotMatch(cleanup, /["']off["']\s*,\s*["']minimal["']/, "thinking levels are core vocabulary");
  assert.doesNotMatch(cleanup, /^type SchedulerState = /m, "the scheduler persists agent states");
  assert.doesNotMatch(cleanup, /^function object\(/m);

  const inspector = source("session-inspector.ts");
  assert.equal(importsFrom(inspector, "parseThinking"), true);
  assert.doesNotMatch(inspector, /["']off["']\s*,\s*["']minimal["']/);
  assert.doesNotMatch(inspector, /^function isThinkingLevel\(/m);

  const cli = source("cli.ts");
  assert.equal(importsFrom(cli, "object"), true);
  assert.doesNotMatch(cli, /^function object\(/m);
});
