import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadSettings, resolveWorkflowSettings, preflight, selectResourcesByLayers, WorkflowAgentExecutor, WorkflowError } from "../src/index.js";
import { decodeLaunchSnapshot } from "../src/decoders.js";

void test("resource selectors use ordered last-match-wins rules", () => {
  const candidates = ["review-skill", "experimental-skill", "/opt/reviewer.mjs", "/opt/unsafe.mjs", "read", "write"];
  assert.deepEqual(selectResourcesByLayers([["review-*"]], candidates), candidates);
  assert.deepEqual(selectResourcesByLayers([["*", "!experimental-*"]], candidates), ["review-skill", "/opt/reviewer.mjs", "/opt/unsafe.mjs", "read", "write"]);
  assert.deepEqual(selectResourcesByLayers([["!*", "review-*"]], candidates), ["review-skill"]);
  assert.deepEqual(selectResourcesByLayers([["*", "!write", "write"]], candidates), candidates);
  const layeredCandidates = ["security-skill", "other-skill", "experimental-skill"];
  assert.deepEqual(selectResourcesByLayers([["*", "!experimental-*"], ["!security-skill"], ["security-skill"]], layeredCandidates), ["security-skill", "other-skill"]);
});

void test("decodes legacy extension settings in launch snapshots", () => {
  const snapshot = decodeLaunchSnapshot({ identityVersion: 6, script: "return null;", args: null, metadata: { name: "legacy" }, settings: { concurrency: 1, extensions: { herdr: { enableFullyInspectableMode: true } } }, models: [], tools: [], agentConfigurations: {}, schemas: [] });
  assert.deepEqual(snapshot?.settings, { concurrency: 1, extensionSettings: { herdr: { enableFullyInspectableMode: true } } });
});

void test("tool selectors cannot widen the root boundary", () => {
  const executor = new WorkflowAgentExecutor({ cwd: "/tmp", model: { provider: "test", model: "model" }, tools: new Set(["read", "grep"]), resourceSelectors: { tools: ["!*", "read"] }, availableModels: new Set(["test/model"]) });
  assert.deepEqual(executor.resolve({ label: "agent", workflowName: "test", tools: ["!*", "grep"] }).tools, ["grep"]);
  assert.throws(() => executor.resolve({ label: "agent", workflowName: "test", tools: ["!*", "/not-a-tool"] }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
  assert.throws(() => executor.resolve({ label: "agent", workflowName: "test", effectiveTools: ["/not-a-tool"] }, ["read"]), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
});

void test("static selector validation is not skipped by dynamic options", () => {
  assert.throws(() => preflight("const label = process.env.LABEL; agent(\"x\", { tools: [1], label });", { models: new Set(["test/model"]), tools: new Set(["read"]), }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});

void test("root selectors intersect inherited tools while calls cannot escape them", () => {
  const executor = new WorkflowAgentExecutor({ cwd: "/tmp", model: { provider: "test", model: "model" }, tools: new Set(["read", "grep", "bash"]), resourceSelectors: { tools: ["read", "grep"] }, availableModels: new Set(["test/model"]) });
  assert.deepEqual(executor.resolve({ label: "child", workflowName: "test" }, ["read"]).tools, ["read"]);
  assert.throws(() => executor.resolve({ label: "child", workflowName: "test", tools: ["grep"] }, ["read"]), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
});

void test("settings expose direct resource selectors without role ownership", (t) => {
  const root = mkdtempSync(join(tmpdir(), "workflow-selector-settings-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); });
  const globalPath = join(root, "settings.json");
  const cwd = join(root, "project");
  writeFileSync(globalPath, JSON.stringify({ skills: ["*", "!experimental-*"], extensions: ["**/*"], tools: ["*", "!write"] }));
  assert.deepEqual(loadSettings(globalPath).tools, ["*", "!write"]);
  const projectPath = join(cwd, ".pi", "pi-extensible-workflows", "settings.json");
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  writeFileSync(projectPath, JSON.stringify({ tools: ["!*", "read"] }));
  assert.deepEqual(resolveWorkflowSettings(cwd, true, globalPath).effective.tools, ["*", "!write", "!*", "read"]);
  assert.deepEqual(resolveWorkflowSettings(cwd, false, globalPath).effective.tools, ["*", "!write"]);
  writeFileSync(globalPath, JSON.stringify({ disabledAgentResources: { skills: ["old"] } }));
  assert.throws(() => { loadSettings(globalPath); }, /use skills, extensions, and tools selectors/);
});
