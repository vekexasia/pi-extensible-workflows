import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { hostSessionContext, withoutActiveShells } from "../src/host-runtime.js";
import type { PersistedRun } from "../src/persistence.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");

function source(name: string): string {
  return readFileSync(resolve(sourceRoot, name), "utf8");
}

function count(text: string, pattern: RegExp): number {
  return (text.match(pattern) ?? []).length;
}

void test("withoutActiveShells strips only the transient shell activity fields", () => {
  const run = { id: "run", workflowName: "wf", cwd: "/tmp", sessionId: "s", state: "interrupted", agentSessions: [], agents: [], phase: "build", activeShells: 2, activeShellStartedAt: 10, activeShellsByPhase: [{ phaseIndex: 0, active: 2, startedAt: 10 }] } satisfies PersistedRun;
  const cleared = withoutActiveShells(run);
  assert.deepEqual(cleared, { id: "run", workflowName: "wf", cwd: "/tmp", sessionId: "s", state: "interrupted", agentSessions: [], agents: [], phase: "build" });
  assert.equal(run.activeShells, 2, "the input run is not mutated");
  assert.equal(Object.hasOwn(cleared, "activeShells"), false);
  assert.equal(Object.hasOwn(cleared, "activeShellStartedAt"), false);
  assert.equal(Object.hasOwn(cleared, "activeShellsByPhase"), false);
});

void test("hostSessionContext reads the project cwd and Pi session ID from an extension context", () => {
  assert.deepEqual(hostSessionContext(undefined), {});
  assert.deepEqual(hostSessionContext({ cwd: 42 }), {});
  assert.deepEqual(hostSessionContext({ cwd: "/repo" }), { cwd: "/repo" });
  assert.deepEqual(hostSessionContext({ cwd: "/repo", sessionManager: { getSessionId: () => "session-1" } }), { cwd: "/repo", sessionId: "session-1" });
  assert.deepEqual(hostSessionContext({ sessionManager: { getSessionId: "nope" } }), {});
});

void test("host modules share the transient shell-activity reset instead of restating the deletes", () => {
  assert.match(source("host-runtime.ts"), /export function withoutActiveShells\(/);
  for (const name of ["host.ts", "host-recovery.ts"]) {
    const text = source(name);
    assert.doesNotMatch(text, /delete next\.activeShellStartedAt;/, `${name} must use withoutActiveShells()`);
    assert.match(text, /\bwithoutActiveShells\b/, `${name} must import and use withoutActiveShells()`);
  }
});

void test("host modules resolve the Pi session through one helper", () => {
  assert.match(source("host-runtime.ts"), /export function hostSessionContext\(/);
  for (const name of ["host.ts", "host-recovery.ts"]) {
    const text = source(name);
    assert.doesNotMatch(text, /Reflect\.apply\(sessionManager\.getSessionId/, `${name} must not re-implement session ID extraction`);
    assert.ok(text.includes("hostSessionContext("), `${name} must use hostSessionContext()`);
  }
});

void test("trajectory loaders reuse one live-overlay function per subject", () => {
  const host = source("host.ts");
  assert.match(host, /createTrajectoryRunLoader\(cwd, sessionId, home, overlayLiveRun\)/);
  assert.match(host, /createTrajectoryRunMetadataLoader\(cwd, sessionId, home, overlayLiveRun\)/);
  assert.match(host, /createTrajectorySubagentLoader\(cwd, sessionId, extensionAgentDir, overlayLiveSubagent\)/);
  assert.match(host, /createTrajectorySubagentMetadataLoader\(cwd, sessionId, extensionAgentDir, overlayLiveSubagent\)/);
  assert.equal(count(host, /live\.status\.attemptDetails\?\.at\(-1\) \?\? subagent\.attempt/g), 1, "the subagent overlay body must exist once");
});

void test("recovery validates a resumable snapshot in one place", () => {
  const recovery = source("host-recovery.ts");
  assert.equal(count(recovery, /function assertResumableSnapshot\(/g), 1);
  assert.equal(count(recovery, /identity version is incompatible/g), 1);
  assert.equal(count(recovery, /Role definition is missing from the launch snapshot/g), 1);
  assert.equal(count(recovery, /assertResumableSnapshot\(/g), 3, "declaration plus the cold-resume and retry call sites");
});

void test("host modules import shared types instead of inline import() types", () => {
  for (const name of ["host.ts", "host-runtime.ts", "host-recovery.ts", "host-navigator.ts"]) {
    assert.doesNotMatch(source(name), /import\("\.\/(?:types|persistence|budget|agent-execution|registry)\.js"\)\./, `${name} must import its types at the top of the module`);
  }
  const host = source("host.ts");
  assert.doesNotMatch(host, /^type WorkflowEventSink = /m, "host.ts must reuse the event sink type from host-runtime");
  assert.doesNotMatch(host, /^type ModelRegistryCapability = /m, "host.ts must reuse the model registry capability type from host-recovery");
});
