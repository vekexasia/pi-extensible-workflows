import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { formatTokens } from "../src/background-widget.js";
import { WORKFLOW_PHASE_STATES, shellActivityFor } from "../src/host-phases.js";
import { formatAgentDetail } from "../src/host-view.js";
import { WORKFLOW_AGENT_STALL_THRESHOLD_MS } from "../src/types.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
function source(name: string): string { return readFileSync(resolve(sourceRoot, name), "utf8"); }
function count(text: string, pattern: RegExp): number { return (text.match(pattern) ?? []).length; }

void test("phase states are one exported vocabulary shared by the phase model and the dashboard", () => {
  assert.deepEqual([...WORKFLOW_PHASE_STATES], ["not started", "running", "completed", "failed", "cancelled", "interrupted", "budget_exhausted"]);
  const phases = source("host-phases.ts");
  assert.match(phases, /export type WorkflowPhaseState = \(typeof WORKFLOW_PHASE_STATES\)\[number\];/);
  const view = source("host-view.ts");
  assert.doesNotMatch(view, /\["not started", "running", "completed"/, "the dashboard must iterate WORKFLOW_PHASE_STATES");
  assert.match(view, /\bWORKFLOW_PHASE_STATES\b/);
});

void test("the dashboard reuses the phase model's shell-activity lookup", () => {
  assert.deepEqual(shellActivityFor({ activeShellsByPhase: [{ phaseIndex: 0, active: 0, startedAt: 1 }, { phaseIndex: 1, active: 2, startedAt: 5 }] }, 1), { phaseIndex: 1, active: 2, startedAt: 5 });
  assert.equal(shellActivityFor({ activeShellsByPhase: [{ phaseIndex: 0, active: 0, startedAt: 1 }] }, 0), undefined, "an idle phase reports no activity");
  assert.equal(shellActivityFor({}, 0), undefined);
  const view = source("host-view.ts");
  assert.doesNotMatch(view, /function phaseShellActivity\(/, "host-view must not duplicate shellActivityFor");
  assert.match(view, /\bshellActivityFor\b/);
});

void test("agent detail formatting derives stall and duration through the shared helpers", () => {
  const view = source("host-view.ts");
  assert.equal(count(view, /WORKFLOW_AGENT_STALL_THRESHOLD_MS/g), 2, "the stall threshold is consulted only by stalledDuration() (plus its import)");
  assert.equal(count(view, /^function elapsedDurationMs\(/gm), 1);
  assert.equal(count(view, /Number\.isFinite\(agent\.durationMs\)/g), 1, "duration fallbacks go through elapsedDurationMs()");
  assert.equal(count(view, /^type (?:WorkflowControlResult|CatalogToolResult) = /gm), 1, "tool result shapes are declared once");
  assert.doesNotMatch(view, /function workflowControlValue\(/, "workflowControlValue only forwarded to catalogResultValue");

  const now = 10_000_000;
  const stalled = formatAgentDetail({ state: "running", lastEventAt: now - WORKFLOW_AGENT_STALL_THRESHOLD_MS - 60_000, startedAt: now - 120_000 }, undefined, now);
  assert.ok(stalled.some((line) => line.includes("stalled? 11m")), stalled.join("\n"));
  assert.ok(stalled.some((line) => line === "Duration: 2m"), stalled.join("\n"));
  const finished = formatAgentDetail({ state: "completed", startedAt: now - 5_000, finishedAt: now - 2_000 }, undefined, now);
  assert.ok(finished.some((line) => line === "Duration: 3s"), finished.join("\n"));
  const recorded = formatAgentDetail({ state: "completed", startedAt: now - 5_000, durationMs: 1_500 }, undefined, now);
  assert.ok(recorded.some((line) => line === "Duration: 1s"), recorded.join("\n"));
  assert.equal(formatAgentDetail({ state: "running", lastEventAt: now - 1_000 }, undefined, now).some((line) => line.includes("stalled?")), false);
});

void test("token formatting is shared between the progress views and the background widget", () => {
  assert.equal(formatTokens(undefined), "");
  assert.equal(formatTokens(0), "");
  assert.equal(formatTokens(999), "999t");
  assert.equal(formatTokens(1_500), "1.5kt");
  assert.equal(formatTokens(12_400), "12kt");
  const view = source("host-view.ts");
  assert.doesNotMatch(view, /^function formatWorkflowTokens\(/m, "host-view must reuse formatTokens from the widget module");
  assert.match(view, /import \{[^}]*\bformatTokens\b[^}]*\} from "\.\/background-widget\.js";/);
});
