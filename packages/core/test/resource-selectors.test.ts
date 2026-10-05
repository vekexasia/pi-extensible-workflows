import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadSettings, parseRoleMarkdown, preflight, prepareAgentSetupForInspection, resolveWorkflowSettings, selectResourcesByLayers, localAgentTransport, WorkflowAgentExecutor, WorkflowError } from "../src/index.js";
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

void test("settings and roles expose direct selector fields", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-resource-selectors-"));
  const globalPath = join(root, "settings.json");
  const cwd = join(root, "project");
  writeFileSync(globalPath, JSON.stringify({ skills: ["*", "!experimental-*"], extensions: ["**/*"], tools: ["*", "!write"] }));
  const settings = loadSettings(globalPath);
  assert.deepEqual(settings.skills, ["*", "!experimental-*"]);
  assert.deepEqual(settings.extensions, ["**/*"]);
  assert.deepEqual(settings.tools, ["*", "!write"]);
  assert.deepEqual(resolveWorkflowSettings(cwd, false, globalPath).effective.tools, ["*", "!write"]);
  const projectSettingsPath = join(cwd, ".pi", "pi-extensible-workflows", "settings.json");
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  writeFileSync(projectSettingsPath, JSON.stringify({ skills: ["project-*"], extensions: ["!**/unsafe.mjs"], tools: ["!*", "read"] }));
  assert.deepEqual(resolveWorkflowSettings(cwd, true, globalPath).effective, { concurrency: 8, backgroundWidget: true, skills: ["*", "!experimental-*", "project-*"], extensions: ["**/*", "!**/unsafe.mjs"], tools: ["*", "!write", "!*", "read"] });
  assert.deepEqual(parseRoleMarkdown("---\nskills: [review-*]\nextensions: [\"**/*\"]\ntools: [\"!*\", read]\n---\nReview", true, join(root, "reviewer.md")), { prompt: "Review", skills: ["review-*"], extensions: ["**/*"], tools: ["!*", "read"] });
  const legacyPath = join(root, "legacy.json");
  writeFileSync(legacyPath, JSON.stringify({ disabledAgentResources: { skills: ["old"] } }));
  assert.throws(() => loadSettings(legacyPath), (error: unknown) => error instanceof WorkflowError && error.message.includes("use skills, extensions, and tools selectors"));
  const legacyWithUnknownPath = join(root, "legacy-with-unknown.json");
  writeFileSync(legacyWithUnknownPath, JSON.stringify({ stale: true, disabledAgentResources: { skills: ["old"] } }));
  assert.throws(() => loadSettings(legacyWithUnknownPath), (error: unknown) => error instanceof WorkflowError && error.message.includes("use skills, extensions, and tools selectors"));
});

void test("decodes legacy extension settings in launch snapshots", () => {
  const snapshot = decodeLaunchSnapshot({ script: "return null;", args: null, metadata: { name: "legacy" }, settings: { concurrency: 1, extensions: { herdr: { enableFullyInspectableMode: true } } }, models: [], tools: [], agentTypes: [], schemas: [] });
  assert.deepEqual(snapshot?.settings, { concurrency: 1, extensionSettings: { herdr: { enableFullyInspectableMode: true } } });
});

void test("tool selectors cannot widen the root boundary", () => {
  const executor = new WorkflowAgentExecutor({ cwd: "/tmp", model: { provider: "test", model: "model" }, tools: new Set(["read", "grep"]), resourceSelectors: { tools: ["!*", "read"] }, availableModels: new Set(["test/model"]) });
  assert.deepEqual(executor.resolve({ label: "agent", workflowName: "test", tools: ["!*", "grep"] }).tools, ["grep"]);
  assert.throws(() => executor.resolve({ label: "agent", workflowName: "test", tools: ["!*", "/not-a-tool"] }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
  assert.throws(() => executor.resolve({ label: "agent", workflowName: "test", effectiveTools: ["/not-a-tool"] }, ["read"]), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
});

void test("child capability selectors can re-enable discovered skills and extensions", async () => {
  const policy = {
    globalSettingsPath: "/settings.json",
    projectSettingsPath: "/project/settings.json",
    projectTrusted: true,
    global: { skills: ["*", "!operator-skill"], extensions: ["**/*", "!**/unsafe.mjs"] },
    project: { skills: [], extensions: [] },
    effective: { skills: ["*", "!operator-skill"], extensions: ["**/*", "!**/unsafe.mjs"] },
    unmatchedSkills: [],
    unmatchedExtensions: [],
    unmatchedTools: [],
    selectorSources: { global: { skills: ["*", "!operator-skill"], extensions: ["**/*", "!**/unsafe.mjs"] }, project: {} },
  };
  const prepared = await prepareAgentSetupForInspection({ cwd: "/tmp", model: { provider: "test", model: "model" }, tools: new Set(["read"]), availableModels: new Set(["test/model"]), agentResourcePolicy: () => structuredClone(policy) }, "child", { label: "child", workflowName: "test", skills: ["operator-skill"], extensions: ["/opt/unsafe.mjs"], tools: ["!*", "read"] }, localAgentTransport);
  // Call-level extension paths are resolved against the cwd; on Windows a rooted path gains the current drive.
  assert.deepEqual(prepared.setup.sessionInput.resourcePolicy?.effective, { skills: ["*", "!operator-skill", "operator-skill"], extensions: ["**/*", "!**/unsafe.mjs", resolve("/opt/unsafe.mjs")], tools: ["!*", "read"] });
});

void test("capability layers preserve default-enabled candidates and parent boundaries", () => {
  const executor = new WorkflowAgentExecutor({ cwd: "/tmp", model: { provider: "test", model: "model" }, tools: new Set(["read", "grep", "bash"]), resourceSelectors: { tools: ["*", "!bash"] }, agentDefinitions: { reviewer: { tools: ["read"] } }, availableModels: new Set(["test/model"]) });
  assert.deepEqual(executor.resolve({ label: "agent", workflowName: "test", role: "reviewer" }).tools, ["read", "grep"]);
  assert.deepEqual(executor.resolve({ label: "agent", workflowName: "test", role: "reviewer", tools: ["grep"] }).tools, ["read", "grep"]);
  assert.deepEqual(executor.resolve({ label: "agent", workflowName: "test", tools: [] }).tools, ["read", "grep"]);
});

void test("static selector validation is not skipped by dynamic options", () => {
  assert.throws(() => preflight("const label = process.env.LABEL; agent(\"x\", { tools: [1], label });", { models: new Set(["test/model"]), tools: new Set(["read"]), agentTypes: new Set() }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});

void test("global and role selectors intersect inherited tools while calls cannot escape them", () => {
  const executor = new WorkflowAgentExecutor({ cwd: "/tmp", model: { provider: "test", model: "model" }, tools: new Set(["read", "grep", "bash"]), resourceSelectors: { tools: ["read", "grep"] }, availableModels: new Set(["test/model"]) });
  assert.deepEqual(executor.resolve({ label: "child", workflowName: "test" }, ["read"]).tools, ["read"]);
  assert.throws(() => executor.resolve({ label: "child", workflowName: "test", tools: ["grep"] }, ["read"]), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_TOOL");
});
