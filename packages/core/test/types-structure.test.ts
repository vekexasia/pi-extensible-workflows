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



void test("AgentOptions documents extension passthrough keys", () => {
  const source = readFileSync(typesPath, "utf8");
  const declarationStart = source.indexOf("export interface AgentOptions");
  assert.notEqual(declarationStart, -1, "AgentOptions declaration must exist");
  const documentation = source.slice(Math.max(0, declarationStart - 400), declarationStart);
  assert.match(documentation, /extra keys are reserved for extensions/i);
  assert.match(documentation, /forwarded as JSON/i);
  assert.match(documentation, /core options remain typed/i);
});

void test("consumer payloads have no typed role option or presentation field", () => {
  for (const path of [typesPath, decodersPath, resolve(sourceRoot, "../subagents/src/contracts.ts"), resolve(sourceRoot, "../subagents/src/view.ts")]) {
    assert.doesNotMatch(readFileSync(path, "utf8"), /\brole\?:\s*string\b/, path);
  }
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

void test("project settings overrides are derived from the global settings shape", () => {
  const source = readFileSync(typesPath, "utf8");
  assert.match(source, /export type WorkflowSettingsOverrides = Partial<Omit<WorkflowSettings, "backgroundWidget" \| "codemodeTools">>;/);
  assert.doesNotMatch(source, /export interface WorkflowSettingsOverrides/);
});
