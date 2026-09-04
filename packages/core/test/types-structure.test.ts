import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
const typesPath = resolve(sourceRoot, "types.ts");
const decodersPath = resolve(sourceRoot, "decoders.ts");
const persistencePath = resolve(sourceRoot, "persistence.ts");
const storePath = resolve(sourceRoot, "store.ts");

function interfaceFields(source: string, name: string): string[] {
  const match = source.match(new RegExp(`export interface ${name} \\{([\\s\\S]*?)\\n\\}`));
  const body = match?.[1];
  assert.ok(body, `${name} must use a multiline declaration`);
  return body.split("\n").filter((line) => line.trim() !== "").map((line) => {
    const field = /^\x20{2}([A-Za-z_$][\w$]*)\??:/.exec(line);
    const fieldName = field?.[1];
    assert.ok(fieldName, `${name} must have one property per indented line: ${line}`);
    return fieldName;
  });
}

void test("large public and persisted records keep one property per line", () => {
  const source = readFileSync(typesPath, "utf8");
  const expected = {
    AgentResourcePolicy: ["globalSettingsPath", "projectSettingsPath", "projectTrusted", "global", "project", "effective", "selectedSkills", "selectedExtensions", "selectedTools", "unmatchedSkills", "unmatchedExtensions", "unmatchedTools", "selectorSources"],
    AgentRecord: ["systemPrompt", "prompt", "id", "name", "label", "path", "state", "parentId", "structuralPath", "resultPath", "parentBreadcrumb", "worktreeOwner", "handle", "turn", "continuity", "role", "requestedModel", "model", "tools", "toolDefinitions", "attempts", "startedAt", "durationMs", "attemptDetails", "accounting", "toolCalls", "activity", "lastEventAt"],
    RunRecord: ["id", "workflowName", "cwd", "sessionId", "state", "agentSessions", "parentRunId", "retry", "phase", "phaseHistory", "phaseHistoryIndex", "agents", "activeShells", "activeShellStartedAt", "activeShellsByPhase", "error", "failedAt", "budget", "budgetVersion", "usage", "budgetEvents", "events", "delivery"],
    LaunchSnapshot: ["identityVersion", "launchMode", "script", "args", "metadata", "settings", "settingsSources", "budget", "settingsPath", "modelAliases", "phases", "models", "tools", "agentTypes", "roles", "projectRoles", "schemas"],
  } as const;

  for (const [name, fields] of Object.entries(expected)) {
    assert.deepEqual(interfaceFields(source, name), fields, `${name} field layout or order changed`);
  }
});

void test("AgentOptions documents extension passthrough keys", () => {
  const source = readFileSync(typesPath, "utf8");
  const declarationStart = source.indexOf("export interface AgentOptions");
  assert.notEqual(declarationStart, -1, "AgentOptions declaration must exist");
  const documentation = source.slice(Math.max(0, declarationStart - 400), declarationStart);
  assert.match(documentation, /extra keys are reserved for extensions/i);
  assert.match(documentation, /forwarded as JSON/i);
  assert.match(documentation, /core options remain typed/i);
});

void test("persistence keeps one name for the persisted run type", () => {
  const decoders = readFileSync(decodersPath, "utf8");
  const persistence = readFileSync(persistencePath, "utf8");
  const store = readFileSync(storePath, "utf8");

  const persistedRunAliases = [...decoders.matchAll(/^export type ([A-Za-z_$][\w$]*) = (?:RunRecord|PersistedRun);$/gm)].map((match) => match[1]);
  assert.deepEqual(persistedRunAliases, ["PersistedRun"], "PersistedRun must be the only alias for RunRecord");
  assert.doesNotMatch(decoders, /\bLoadedPersistedRun\b/, "LoadedPersistedRun must not be reintroduced");
  assert.doesNotMatch(persistence, /\bLoadedPersistedRun\b/, "persistence exports must use the canonical run type name");
  assert.doesNotMatch(store, /\bLoadedPersistedRun\b/, "RunStore must use PersistedRun for loaded runs");
  assert.match(store, /async load\(\): Promise<\{ run: PersistedRun;/, "RunStore.load() must return the canonical run type");
});
