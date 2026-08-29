import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { join, resolve } from "node:path";
import test from "node:test";
import { testExtensionApi } from "./support.js";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, formatNavigatorDashboard, formatNavigatorRun, loadAgentDefinitions, loadSettings, parseRoleMarkdown, preflight, registerWorkflowExtension, resourcePatternMatches, resolveAgentResourcePolicy, resolveModelReference, resolveWorkflowSettings, RunStore, runWorkflow, saveModelAliases, selectResourcesByLayers, structuralPath, validateModelAliases, WorkflowAgentExecutor, WORKFLOW_RUN_COMPLETED_EVENT, WORKFLOW_RUN_RESUMED_EVENT, WORKFLOW_RUN_STARTED_EVENT, WorkflowError, WorkflowRegistry } from "../src/index.js";
import type { SessionInput } from "../src/agent-execution.js";
import { listRunIds } from "../src/persistence.js";
import { testTransport, type TestPiSession } from "./test-transport.js";

void test("loads markdown agent roles only from canonical global and project directories", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-roles-"));
  const cwd = join(home, "project");
  const defaultAgentDir = join(home, ".pi", "agent");
  const customAgentDir = join(home, "custom-agent");
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    mkdirSync(join(defaultAgentDir, "pi-extensible-workflows", "roles"), { recursive: true });
    mkdirSync(join(home, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
    mkdirSync(join(home, ".pi", "piworkflows", "roles"), { recursive: true });
    mkdirSync(join(cwd, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
    mkdirSync(join(cwd, ".pi", "piworkflows", "roles"), { recursive: true });
    writeFileSync(join(defaultAgentDir, "pi-extensible-workflows", "roles", "global.md"), "---\ndescription: Global review\nmodel: openai/gpt:high\ntools: [read, grep]\n---\nGlobal role");
    writeFileSync(join(defaultAgentDir, "pi-extensible-workflows", "roles", "collision.md"), "Canonical collision");
    writeFileSync(join(defaultAgentDir, "pi-extensible-workflows", "roles", "multiline.md"), "---\ntools:\n  - read\n  - grep\n---\nMultiline role");
    writeFileSync(join(home, ".pi", "pi-extensible-workflows", "roles", "old-global.md"), "Ignored old global role");
    writeFileSync(join(home, ".pi", "piworkflows", "roles", "old-legacy.md"), "Ignored legacy role");
    writeFileSync(join(cwd, ".pi", "piworkflows", "roles", "old-project.md"), "Ignored old project role");
    writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "reviewer.md"), "Review role");
    writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "shadowed.md"), "Project shadowed role");
    const roles = loadAgentDefinitions(cwd);
    assert.deepEqual(roles.global, { prompt: "Global role", description: "Global review", model: "openai/gpt:high", tools: ["read", "grep"] });
    assert.equal(roles.reviewer?.prompt, "Review role");
    assert.deepEqual(roles.collision, { prompt: "Canonical collision" });
    assert.deepEqual(roles.shadowed, { prompt: "Project shadowed role" });
    assert.deepEqual(roles.multiline, { prompt: "Multiline role", tools: ["read", "grep"] });
    assert.equal(roles["old-global"], undefined);
    assert.equal(roles["old-legacy"], undefined);
    assert.equal(roles["old-project"], undefined);
    const untrusted = loadAgentDefinitions(cwd, undefined, false);
    assert.equal(untrusted.reviewer, undefined);
    assert.deepEqual(untrusted.collision, { prompt: "Canonical collision" });
    process.env.PI_CODING_AGENT_DIR = customAgentDir;
    mkdirSync(join(customAgentDir, "pi-extensible-workflows", "roles"), { recursive: true });
    writeFileSync(join(customAgentDir, "pi-extensible-workflows", "roles", "custom.md"), "Custom role");
    writeFileSync(join(customAgentDir, "pi-extensible-workflows", "roles", "collision.md"), "Custom collision");
    const customRoles = loadAgentDefinitions(cwd);
    assert.deepEqual(customRoles.custom, { prompt: "Custom role" });
    assert.deepEqual(customRoles.collision, { prompt: "Custom collision" });
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
void test("loads markdown agent roles deployed as per-file symlinks", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-extensible-workflows-symlinked-roles-")));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const roleDirectory = join(agentDir, "pi-extensible-workflows", "roles");
  const target = join(root, "source-role.md");
  mkdirSync(roleDirectory, { recursive: true });
  writeFileSync(target, "---\ndescription: Linked role\n---\nLinked body");
  symlinkSync(target, join(roleDirectory, "linked.md"));
  symlinkSync(join(root, "missing-role.md"), join(roleDirectory, "dangling.md"));
  writeFileSync(join(roleDirectory, "sibling.md"), "Sibling role");
  const roles = loadAgentDefinitions(cwd, agentDir, true, []);
  assert.deepEqual(roles.linked, { prompt: "Linked body", description: "Linked role" });
  assert.deepEqual(roles.sibling, { prompt: "Sibling role" });
});

void test("strict role frontmatter rejects malformed metadata", () => {
  const invalid = [
    "---\ntools: read\n---\nbody",
    "---\ntools: [read, 2]\n---\nbody",
    "---\ntools: [read, '']\n---\nbody",
    "---\ndescription: |\n  line one\n  line two\n---\nbody",
  ];
  for (const content of invalid) assert.throws(() => parseRoleMarkdown(content, true), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});

void test("strips single and double quotes from loose role metadata even when unpaired", () => {
  assert.deepEqual(parseRoleMarkdown("---\nmodel: 'openai/gpt:high\"\ntools: ['read\", \"grep']\nskills: ['role-skill\", \"other-skill']\nextensions: ['role.ts\", \"other.ts']\ndescription: 'Review role\"\ncontextFiles: ['global\", \"project']\n---\nbody", false), {
    prompt: "body",
    model: "openai/gpt:high",
    tools: ["read", "grep"],
    skills: ["role-skill", "other-skill"],
    extensions: ["role.ts", "other.ts"],
    description: "Review role",
    contextFiles: ["global", "project"],
  });
  assert.throws(() => parseRoleMarkdown("---\nmodel: openai/gpt\nthinking: high\n---\nbody", false), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});

void test("accepts role system prompt override metadata", () => {
  for (const key of ["overrideSystemPrompt", "override_system_prompt", "is_system_prompt"]) {
    assert.deepEqual(parseRoleMarkdown(`---\n${key}: true\n---\nbody`, true), { prompt: "body", overrideSystemPrompt: true });
  }
  assert.deepEqual(parseRoleMarkdown("---\noverrideSystemPrompt: false\n---\nbody", true), { prompt: "body", overrideSystemPrompt: false });
  assert.throws(() => parseRoleMarkdown("---\noverrideSystemPrompt: yes\n---\nbody", true), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});
void test("parses and validates role context file scopes", () => {
  assert.deepEqual(parseRoleMarkdown("---\ncontextFiles: [global, project, cwd]\n---\nbody", true), { prompt: "body", contextFiles: ["global", "project", "cwd"] });
  assert.deepEqual(parseRoleMarkdown("---\ncontextFiles: []\n---\nbody", true), { prompt: "body", contextFiles: [] });
  for (const content of ["---\ncontextFiles: global\n---\nbody", "---\ncontextFiles: [global, repository]\n---\nbody", "---\ncontextFiles: [2]\n---\nbody"]) assert.throws(() => parseRoleMarkdown(content, true), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
});
void test("strict role selectors normalize relative and portable extension paths", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-extensible-workflows-role-resources-")));
  const rolePath = join(root, "roles", "reviewer.md");
  const extension = join(root, "role-extension.ts");
  mkdirSync(join(root, "roles"), { recursive: true });
  writeFileSync(extension, "");
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  try {
    const definition = parseRoleMarkdown(`---\nskills: [role-skill, role-skill]\nextensions:\n  - "../role-extension.ts"\n  - "~/role-extension.ts"\n  - "${pathToFileURL(extension).href}"\n---\nbody`, true, rolePath);
    assert.deepEqual(definition, { prompt: "body", skills: ["role-skill", "role-skill"], extensions: [extension, extension, extension] });
    for (const content of [
      "---\nskills: role-skill\n---\nbody",
      "---\nskills: [role-skill, 2]\n---\nbody",
      "---\nskills: [role-skill, '']\n---\nbody",
      "---\nextensions: [2]\n---\nbody",
    ]) assert.throws(() => parseRoleMarkdown(content, true, rolePath), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  }
});

void test("rejects invalid role policy before persisting a run", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-role-policy-"));
  const cwd = join(home, "project");
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "broken.md"), "---\nmodel: missing/model:low\n---\nBroken role");
  const tools: Array<{ name: string; execute: (id?: unknown, params?: unknown, signal?: unknown, update?: unknown, ctx?: unknown) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["read", "workflow"] }), home);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  await assert.rejects(workflow.execute("id", { name: "invalid-role", script: `return agent("inspect", { role: "broken" });` }, new AbortController().signal, undefined, { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL");
  assert.deepEqual(await listRunIds(cwd, "session", home), []);
  await assert.rejects(workflow.execute("id", { name: "invalid-schema", script: `return agent("inspect", { outputSchema: [] });` }, new AbortController().signal, undefined, { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SCHEMA");
  assert.deepEqual(await listRunIds(cwd, "session", home), []);
});

void test("production role policy uses role defaults with call-level overrides", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-role-execution-"));
  const cwd = join(home, "project");
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "reviewer.md"), "---\nmodel: openai/gpt:high\ntools: [\"!*\", read]\n---\nReview role");
  for (const role of Object.keys(loadAgentDefinitions(cwd, undefined, false))) {
    if (role !== "reviewer") writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", `${role}.md`), "---\nmodel: openai/gpt:high\ntools: [\"!*\", read]\n---\nTest role");
  }
  const inputs: SessionInput[] = [];
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    inputs.push(input);
    return { sessionId: `session-${String(inputs.length)}`, sessionFile: `/sessions/${String(inputs.length)}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {} };
  };
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["read", "agent", "workflow"] }), home, async () => {}, testTransport(createSession));
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" } };
  const staticResult = await workflow.execute("id", { name: "static-overrides", script: "return agent(\"inspect\", { role: \"reviewer\", model: \"openai/gpt:low\" });", foreground: true }, new AbortController().signal, undefined, context) as { content: Array<{ text?: string }> };
  assert.equal(JSON.parse(staticResult.content[0]?.text ?? "null"), "done");
  assert.ok(inputs.some(({ model }) => model.provider === "openai" && model.model === "gpt" && model.thinking === "low"));
  const dynamicResult = await workflow.execute("id", { name: "dynamic-overrides", script: "const options = { role: args.role }; options.model = args.value; return agent(\"inspect\", options);", args: { role: "reviewer", value: "openai/gpt:low" }, foreground: true }, new AbortController().signal, undefined, context) as { content: Array<{ text?: string }> };
  assert.equal(JSON.parse(dynamicResult.content[0]?.text ?? "null"), "done");
  const result = await workflow.execute("id", { name: "role-only", script: "return agent(\"inspect\", { role: \"reviewer\", retries: 1, timeoutMs: 100 });", foreground: true }, new AbortController().signal, undefined, context) as { content: Array<{ text?: string }> };
  assert.equal(JSON.parse(result.content[0]?.text ?? "null"), "done");
  assert.deepEqual(inputs.at(-1) && { model: inputs.at(-1)?.model, thinking: inputs.at(-1)?.model.thinking, tools: inputs.at(-1)?.tools, systemPromptAppend: inputs.at(-1)?.systemPromptAppend }, { model: { provider: "openai", model: "gpt", thinking: "high" }, thinking: "high", tools: ["read"], systemPromptAppend: "Review role" });
});

void test("default settings follow the effective agent directory", () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-settings-"));
  const agentDir = join(home, ".pi", "agent");
  const customAgentDir = join(home, "custom-agent");
  const previousHome = process.env.HOME;
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.HOME = home;
  delete process.env.PI_CODING_AGENT_DIR;
  try {
    mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
    writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ concurrency: 4 }));
    assert.deepEqual(loadSettings(), { concurrency: 4, backgroundWidget: true });
    process.env.PI_CODING_AGENT_DIR = customAgentDir;
    mkdirSync(join(customAgentDir, "pi-extensible-workflows"), { recursive: true });
    writeFileSync(join(customAgentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ concurrency: 6 }));
    assert.deepEqual(loadSettings(), { concurrency: 6, backgroundWidget: true });
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});

void test("strict settings use defaults and reject unknown or unsafe values", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-"));
  assert.equal(loadSettings(join(dir, "missing.json")), DEFAULT_SETTINGS);
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({ concurrency: 4 }));
  assert.deepEqual(loadSettings(path), { concurrency: 4, backgroundWidget: true });
  writeFileSync(path, JSON.stringify({ backgroundWidget: false }));
  assert.equal(loadSettings(path).backgroundWidget, false);
  writeFileSync(path, JSON.stringify({ backgroundWidget: "yes" }));
  assert.throws(() => loadSettings(path), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SETTINGS");
  writeFileSync(path, JSON.stringify({ extensionSettings: { herdr: { enableFullyInspectableMode: true } } }));
  assert.equal(loadSettings(path).extensionSettings?.herdr?.enableFullyInspectableMode, true);
  writeFileSync(path, JSON.stringify({ extensionSettings: { trajectory: { port: 7432 } } }));
  assert.deepEqual(loadSettings(path).extensionSettings?.trajectory, { port: 7432, themes: false });
  writeFileSync(path, JSON.stringify({ extensionSettings: { trajectory: { themes: true } } }));
  assert.deepEqual(loadSettings(path).extensionSettings?.trajectory, { themes: true });
  writeFileSync(path, JSON.stringify({ extensionSettings: { trajectory: { port: 7432, themes: true } } }));
  assert.deepEqual(loadSettings(path).extensionSettings?.trajectory, { port: 7432, themes: true });
  writeFileSync(path, JSON.stringify({ extensionSettings: { trajectory: {} } }));
  assert.deepEqual(loadSettings(path).extensionSettings?.trajectory, { themes: false });
  for (const value of [0, -1, 1.5, "7432", 65536]) {
    writeFileSync(path, JSON.stringify({ extensionSettings: { trajectory: { port: value } } }));
    assert.throws(() => loadSettings(path), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SETTINGS");
  }
  writeFileSync(path, JSON.stringify({ extensionSettings: { trajectory: { port: 7432, themes: "yes" } } }));
  assert.throws(() => loadSettings(path), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SETTINGS");
  writeFileSync(path, JSON.stringify({ extensionSettings: { trajectory: { port: 7432, theme: true } } }));
  assert.throws(() => loadSettings(path), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SETTINGS");
  writeFileSync(path, JSON.stringify({ extensionSettings: { herdr: { enableFullyInspectableMode: "yes" } } }));
  assert.throws(() => loadSettings(path), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SETTINGS");
  writeFileSync(path, JSON.stringify({ agentTimeoutMs: 500 }));
  assert.throws(() => loadSettings(path), /Unknown workflow setting/);
  writeFileSync(path, JSON.stringify({ concurrency: 17 }));
  assert.throws(() => loadSettings(path), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SETTINGS");
  writeFileSync(path, JSON.stringify({ surprise: true }));
  assert.throws(() => loadSettings(path), /Unknown workflow setting/);
});

void test("workflow extension wires the background widget from global settings", () => {
  const install = (settings: string | undefined) => {
    const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-widget-host-"));
    const agentDir = join(root, "agent");
    if (settings !== undefined) {
      mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
      writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), settings);
    }
    const renderers: string[] = [];
    const shortcuts: string[] = [];
    workflowExtension(testExtensionApi({
      registerEntryRenderer(type) { renderers.push(type); },
      registerShortcut(shortcut) { shortcuts.push(shortcut); },
      events: { on: () => () => {}, emit: () => {} },
    }), root, undefined, undefined, agentDir);
    return { renderers, shortcuts };
  };

  assert.deepEqual(install(undefined), { renderers: ["workflow-log", "piewf-run-receipt"], shortcuts: ["alt+o"] });
  assert.deepEqual(install(JSON.stringify({ backgroundWidget: false })), { renderers: ["workflow-log"], shortcuts: [] });
  assert.deepEqual(install("{"), { renderers: ["workflow-log", "piewf-run-receipt"], shortcuts: ["alt+o"] });
});

void test("composes trusted resource selectors and ignores untrusted project selectors", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-resources-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const globalPath = join(home, ".pi", "agent", "pi-extensible-workflows", "settings.json");
  const projectPath = join(cwd, ".pi", "pi-extensible-workflows", "settings.json");
  const extension = join(home, "interactive-only.ts");
  mkdirSync(join(home, ".pi", "agent", "pi-extensible-workflows"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  writeFileSync(globalPath, JSON.stringify({ concurrency: 4, modelAliases: { reviewer: "openai/gpt" }, skills: ["*", "!learning-opportunities"], extensions: ["**/*", `!${extension}`] }));
  writeFileSync(projectPath, JSON.stringify({ skills: ["*", "!project-only"], extensions: ["**/*", "!../project-only.ts"] }));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const trusted = resolveAgentResourcePolicy(cwd, true, globalPath);
    assert.deepEqual(trusted.effective.skills, ["*", "!learning-opportunities", "*", "!project-only"]);
    assert.deepEqual(trusted.effective.extensions, ["**/*", `!${extension}`, "**/*", `!${join(cwd, ".pi", "project-only.ts")}`]);
    assert.equal(loadSettings(globalPath).modelAliases?.reviewer, "openai/gpt");
    const untrusted = resolveAgentResourcePolicy(cwd, false, globalPath);
    assert.deepEqual(untrusted.effective.skills, ["*", "!learning-opportunities"]);
    assert.deepEqual(untrusted.effective.extensions, ["**/*", `!${extension}`]);
  } finally {
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
  }
});
void test("validates minimatch resource selectors and resolves extension globs", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-globs-"));
  const path = join(root, "settings.json");
  writeFileSync(path, JSON.stringify({ skills: ["*", "!my-project-*", "{one,two}"], extensions: ["**/*", "!../../extensions/**"] }));
  assert.deepEqual(loadSettings(path).skills, ["*", "!my-project-*", "{one,two}"]);
  assert.deepEqual(loadSettings(path).extensions, ["**/*", `!${resolve(root, "../../extensions/**")}`]);
  writeFileSync(path, JSON.stringify({ skills: [""] }));
  assert.throws(() => loadSettings(path), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SETTINGS" && error.message.includes(`${path}.skills[0]`));
  writeFileSync(path, JSON.stringify({ extensions: ["!"] }));
  assert.throws(() => loadSettings(path), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SETTINGS" && error.message.includes(`${path}.extensions[0]`));
});
void test("preserves rooted extension glob selectors", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-rooted-globs-"));
  const path = join(root, "settings.json");
  const cases = [["/*.ts", "/extension.ts"], ["/?mp/**", "/tmp/extension.ts"], ["/[tv]mp/**", "/tmp/extension.ts"], ["/**/*.ts", "/tmp/extension.ts"]] as const;
  for (const [selector, resource] of cases) {
    writeFileSync(path, JSON.stringify({ extensions: [selector] }));
    const normalized = loadSettings(path).extensions?.[0] ?? "";
    assert.equal(normalized, selector);
    assert.equal(resourcePatternMatches(resource, normalized), true);
  }
});
void test("matches Windows extension paths using portable glob separators", () => {
  const disabled = "C:\\agent\\extensions\\disabled.ts";
  const allowed = "C:\\agent\\extensions\\allowed.ts";
  assert.equal(resourcePatternMatches(disabled, "C:\\agent\\extensions\\*.ts"), true);
  assert.equal(resourcePatternMatches(disabled, disabled), true);
  assert.deepEqual(selectResourcesByLayers([["C:\\agent\\extensions\\**\\*.ts", `!${allowed}`]], [disabled, allowed]), [disabled]);
});
void test("canonicalizes symlinked extension glob prefixes", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-extensible-workflows-symlink-globs-")));
  const path = join(root, "settings.json");
  const realExtensions = join(root, "real", "extensions");
  mkdirSync(realExtensions, { recursive: true });
  symlinkSync(realExtensions, join(root, "link"));
  writeFileSync(path, JSON.stringify({ extensions: ["link/*.ts"] }));
  const normalized = loadSettings(path).extensions ?? [];
  assert.deepEqual(normalized, [join(realExtensions, "*.ts")]);
  assert.equal(resourcePatternMatches(join(realExtensions, "extension.ts"), normalized[0] ?? ""), true);
});
void test("accepts Minimatch character class forms", () => {
  const path = join(mkdtempSync(join(tmpdir(), "pi-extensible-workflows-character-classes-")), "settings.json");
  const selectors = ["[[:alpha:]]", "[]]"];
  writeFileSync(path, JSON.stringify({ skills: selectors }));
  assert.deepEqual(loadSettings(path).skills, selectors);
  assert.equal(resourcePatternMatches("a", "[[:alpha:]]"), true);
  assert.equal(resourcePatternMatches("]", "[]]"), true);
});
void test("preserves ordered duplicate resource selectors", () => {
  assert.deepEqual(selectResourcesByLayers([["*", "!*", "*"]], ["resource"]), ["resource"]);
});
void test("validates and resolves portable model aliases", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-aliases-"));
  const path = join(dir, "settings.json");
  const aliases = { "reviewer-model": "anthropic/opus:high", "cheap-model": "reviewer-model:low", "inherited-model": "reviewer-model", opus: "openai/gpt" };
  writeFileSync(path, JSON.stringify({ concurrency: 4, modelAliases: aliases }));
  assert.deepEqual(loadSettings(path).modelAliases, aliases);
  assert.deepEqual(resolveModelReference("reviewer-model", aliases, new Set(["anthropic/opus"])), { provider: "anthropic", model: "opus", thinking: "high" });
  assert.deepEqual(resolveModelReference("reviewer-model:low", aliases, new Set(["anthropic/opus"])), { provider: "anthropic", model: "opus", thinking: "low" });
  assert.deepEqual(resolveModelReference("cheap-model", aliases, new Set(["anthropic/opus"])), { provider: "anthropic", model: "opus", thinking: "low" });
  assert.deepEqual(resolveModelReference("cheap-model:xhigh", aliases, new Set(["anthropic/opus"])), { provider: "anthropic", model: "opus", thinking: "xhigh" });
  assert.deepEqual(resolveModelReference("inherited-model", aliases, new Set(["anthropic/opus"])), { provider: "anthropic", model: "opus", thinking: "high" });
  assert.deepEqual(resolveModelReference("opus", aliases, new Set(["openai/opus", "anthropic/opus"])), { provider: "openai", model: "gpt" });
  assert.throws(() => validateModelAliases({ "bad/name": "p/m" }, path), (error: unknown) => error instanceof WorkflowError && error.code === "CONFIG_ERROR");
  assert.throws(() => validateModelAliases({ chained: "missing-alias" }, path), (error: unknown) => error instanceof WorkflowError && error.code === "CONFIG_ERROR" && error.message.includes("missing-alias") && error.message.includes(path));
  assert.throws(() => validateModelAliases({ first: "second", second: "first" }, path), (error: unknown) => error instanceof WorkflowError && error.code === "CONFIG_ERROR" && error.message.includes("Circular model alias") && error.message.includes(path));
  assert.throws(() => validateModelAliases({ invalidTarget: "provider/model:turbo" }, path), (error: unknown) => error instanceof WorkflowError && error.code === "CONFIG_ERROR");
  const checked = preflight('agent("x", { model: "cheap-model:xhigh" })', { models: new Set(["anthropic/opus"]), knownModels: new Set(["anthropic/opus"]), tools: new Set(), agentTypes: new Set(), modelAliases: aliases, settingsPath: path });
  assert.deepEqual(checked.referenced.models, ["anthropic/opus"]);
  assert.throws(() => preflight('agent("x", { model: "reviewer-model" })', { models: new Set(["openai/gpt"]), knownModels: new Set(["openai/gpt"]), tools: new Set(), agentTypes: new Set(), modelAliases: { "reviewer-model": "anthropic/opus" }, settingsPath: path }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL" && error.message.includes("reviewer-model") && error.message.includes("anthropic/opus") && error.message.includes(path));
  const executor = new WorkflowAgentExecutor({ cwd: dir, model: { provider: "openai", model: "gpt", thinking: "medium" }, tools: new Set(), knownModels: new Set(["openai/gpt", "anthropic/opus"]), modelAliases: aliases, agentDefinitions: { reviewer: { model: "cheap-model:xhigh" } }, settingsPath: path });
  const direct = executor.resolve({ label: "direct", workflowName: "test", model: "cheap-model:minimal" });
  assert.equal(direct.model.thinking, "minimal");
  assert.equal(direct.requestedModel, "cheap-model:minimal");
  assert.equal(executor.resolve({ label: "role", workflowName: "test", role: "reviewer" }).model.thinking, "xhigh");
  assert.throws(() => executor.resolve({ label: "missing", workflowName: "test", model: "missing-model" }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL");
  const blocked = new WorkflowAgentExecutor({ cwd: dir, model: { provider: "openai", model: "gpt", thinking: "medium" }, tools: new Set(), knownModels: new Set(["openai/gpt", "anthropic/opus"]), modelAliases: {}, blockedAliases: new Set(["reviewer-model"]), blockedAliasTargets: { "reviewer-model": "anthropic/opus:high" }, settingsPath: path });
  assert.throws(() => blocked.resolve({ label: "deleted", workflowName: "test", model: "reviewer-model:low" }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_MODEL" && error.message.includes("reviewer-model:low") && error.message.includes("anthropic/opus:high") && error.message.includes(path));
  saveModelAliases(path, { "reviewer-model": "anthropic/opus:high" });
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")), { concurrency: 4, modelAliases: { "reviewer-model": "anthropic/opus:high" } });
  const malformed = "{\n  \"concurrency\": 4,";
  writeFileSync(path, malformed);
  assert.throws(() => { saveModelAliases(path, { "reviewer-model": "anthropic/opus:high" }); }, (error: unknown) => error instanceof WorkflowError && error.code === "CONFIG_ERROR");
  assert.equal(readFileSync(path, "utf8"), malformed);
});
void test("workflow TUI manages aliases without runs and preserves settings", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-alias-tui-"));
  const cwd = join(home, "project");
  const agentDir = join(home, "agent");
  const settingsPath = join(agentDir, "pi-extensible-workflows", "settings.json");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ concurrency: 3 }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const notices: string[] = [];
  const confirmations: string[] = [];
  let menuCalls = 0;
  let targetCalls = 0;
  let inputCalls = 0;
  let openedAliases = false;
  const select = async (prompt: string, options: string[]) => {
    if (prompt === "Workflows\n") { assert.ok(options.includes("Model aliases")); if (openedAliases) return "Close"; openedAliases = true; return "Model aliases"; }
    if (prompt.startsWith("Model aliases")) { menuCalls += 1; return (["Add alias", "Edit portable", "Delete portable", "Back"][menuCalls - 1] ?? "Back"); }
    targetCalls += 1;
    return targetCalls === 1 ? "Manual model ID" : "openai/gpt";
  };
  const ctx = {
    cwd, mode: "tui", hasUI: true, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" },
    modelRegistry: { getAvailable: () => [{ provider: "openai", id: "gpt" }] },
    ui: {
      notify(message: string) { notices.push(message); },
      confirm: async (_title: string, message: string) => { confirmations.push(message); return true; },
      select,
      input: async () => { inputCalls += 1; return inputCalls === 1 ? "portable" : "private/model:high"; },
    },
  };
  try {
    workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home);
    assert.ok(start && command);
    await start({}, ctx);
    await command("", ctx);
    assert.equal(inputCalls, 2);
    assert.equal(targetCalls, 2);
    assert.ok(notices.some((message) => message.includes("not currently available")));
    assert.ok(confirmations.some((message) => /Future workflow resumes/.test(message)));
    assert.deepEqual(JSON.parse(readFileSync(settingsPath, "utf8")), { concurrency: 3, modelAliases: {} });
  } finally {
    await shutdown?.();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
void test("active run keeps its alias snapshot after settings edits", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-alias-active-"));
  const settingsPath = join(dir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ modelAliases: { reviewer: "old/model" } }));
  const inputs: SessionInput[] = [];
  const executor = new WorkflowAgentExecutor({ cwd: dir, model: { provider: "root", model: "model", thinking: "medium" }, tools: new Set(), knownModels: new Set(["root/model", "old/model", "new/model"]), modelAliases: validateModelAliases({ reviewer: "old/model" }, settingsPath), settingsPath }, testTransport(async (input) => {
    inputs.push(input);
    return { sessionId: `active-${String(inputs.length)}`, sessionFile: `/sessions/active-${String(inputs.length)}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {} };
  }));
  await executor.execute("before", { label: "before", workflowName: "active", model: "reviewer" });
  saveModelAliases(settingsPath, { reviewer: "new/model" });
  await executor.execute("after", { label: "after", workflowName: "active", model: "reviewer" });
  assert.deepEqual(inputs.map(({ model }) => ({ provider: model.provider, model: model.model })), [{ provider: "old", model: "model" }, { provider: "old", model: "model" }]);
});
void test("resume reloads aliases for pending and retried calls while replaying completed calls", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-alias-resume-"));
  const cwd = join(home, "project");
  const agentDir = join(home, "agent");
  const settingsPath = join(agentDir, "pi-extensible-workflows", "settings.json");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  const oldAliases = { reviewer: "old/model" };
  const newAliases = { reviewer: "new/model" };
  writeFileSync(settingsPath, JSON.stringify({ concurrency: 2, modelAliases: oldAliases, skills: ["old-skill"], extensions: [join(agentDir, "old.ts")] }));
  const script = `const replayed = await agent("replayed", { model: "reviewer" }); const pending = await agent("pending", { model: "reviewer", label: "pending", retries: 1 }); const fresh = await agent("fresh", { model: "reviewer" }); return { replayed, pending, fresh };`;
  const replayPaths: string[] = [];
  await runWorkflow(script, null, { agent: async (_prompt, _options, _signal, identity) => { replayPaths.push(structuralPath("agent", ...identity.structuralPath, `callsite:${identity.callSite}`, `occurrence:${String(identity.occurrence)}`)); return "original"; } }).result;
  const store = new RunStore(cwd, "session", "run", home);
  await store.create({ id: "run", workflowName: "alias-resume", cwd, sessionId: "session", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script, args: null, metadata: { name: "alias-resume" }, settings: { concurrency: 2, modelAliases: oldAliases }, modelAliases: oldAliases, models: ["root/model", "old/model"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  await store.complete(replayPaths[0] as string, "replayed");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  writeFileSync(settingsPath, JSON.stringify({ concurrency: 6, modelAliases: newAliases, skills: ["new-skill"], extensions: [join(agentDir, "new.ts")] }));
  const inputs: SessionInput[] = [];
  let failedPending = false;
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    inputs.push(input);
    return {
      sessionId: `alias-${String(inputs.length)}`, sessionFile: `/sessions/alias-${String(inputs.length)}.jsonl`,
      messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }),
      prompt: async (text: string) => { if (text.includes("pending") && !failedPending) { failedPending = true; throw new Error("retry pending"); } },
      steer: async () => {}, dispose() {},
    };
  };
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let pickerSelected = false;
  const ctx = {
    cwd, mode: "rpc", hasUI: true, model: { provider: "root", id: "model" }, sessionManager: { getSessionId: () => "session" },
    modelRegistry: { getAll: () => [{ provider: "root", id: "model" }, { provider: "new", id: "model" }] },
    ui: { notify() {}, select: async (prompt: string, options: string[]) => {
      if (options.includes("Skip")) return "Skip";
      if (prompt === "Workflows\n") { if (pickerSelected) return "Close"; pickerSelected = true; return options.find((option) => option.includes("alias-resume")) ?? "Close"; }
      if (prompt.startsWith("Resume ")) return "Foreground";
      if (options.includes("Resume")) return "Resume";
      return "Back";
    } },
  };
  try {
    const events: Array<{ channel: string; data: unknown }> = [];
    workflowExtension(testExtensionApi({ registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], events: { emit(channel: string, data: unknown) { events.push({ channel, data }); } } }), home, async () => {}, testTransport(createSession));
    assert.ok(start && command);
    await start({}, ctx);
    await command("", ctx);
    for (let attempt = 0; attempt < 1000; attempt += 1) {
      if ((await store.load()).run.state === "completed" && events.some(({ channel }) => channel === WORKFLOW_RUN_COMPLETED_EVENT)) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    const loaded = await store.load();
    assert.equal(loaded.run.state, "completed");
    assert.equal(loaded.snapshot.settings.concurrency, 2);
    assert.equal(loaded.snapshot.settingsSources, undefined);
    assert.equal(inputs.length, 3);
    assert.deepEqual(inputs.map(({ model }) => ({ provider: model.provider, model: model.model })), [{ provider: "new", model: "model" }, { provider: "new", model: "model" }, { provider: "new", model: "model" }]);
    assert.deepEqual(inputs.map(({ resourcePolicy }) => resourcePolicy?.effective), [{ skills: ["new-skill"], extensions: [join(agentDir, "new.ts")] }, { skills: ["new-skill"], extensions: [join(agentDir, "new.ts")] }, { skills: ["new-skill"], extensions: [join(agentDir, "new.ts")] }]);
    assert.deepEqual(loaded.snapshot.modelAliases, newAliases);
    assert.deepEqual(loaded.run.events, [{ type: "warning", message: "Model alias mappings changed on resume: reviewer: old/model -> new/model" }]);
    assert.match(formatNavigatorRun(loaded, [], []), /Model alias mappings changed on resume/);
    assert.equal(events.filter(({ channel }) => channel === WORKFLOW_RUN_STARTED_EVENT).length, 0);
    assert.equal(events.filter(({ channel }) => channel === WORKFLOW_RUN_RESUMED_EVENT).length, 1);
    assert.ok(events.some(({ channel }) => channel === WORKFLOW_RUN_COMPLETED_EVENT));
  } finally {
    await shutdown?.();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
});
void test("persists resume snapshots and warning events", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-resume-snapshot-"));
  const cwd = join(home, "project");
  const store = new RunStore(cwd, "session", "run", home);
  const initial = createLaunchSnapshot({ script: "return true", args: null, metadata: { name: "resume" }, settings: { ...DEFAULT_SETTINGS, modelAliases: { reviewer: "openai/gpt" } }, modelAliases: { reviewer: "openai/gpt" }, models: ["openai/gpt"], tools: [], agentTypes: [], schemas: [] });
  await store.create({ id: "run", workflowName: "resume", cwd, sessionId: "session", state: "interrupted", agents: [], agentSessions: [] }, initial);
  const next = createLaunchSnapshot({ ...initial, settings: { ...initial.settings, modelAliases: { reviewer: "anthropic/opus" } }, modelAliases: { reviewer: "anthropic/opus" } });
  await store.saveSnapshot(next);
  await store.appendEvent({ type: "warning", message: "reviewer: openai/gpt -> anthropic/opus" });
  await store.appendEvent({ type: "warning", message: "reviewer: openai/gpt -> anthropic/opus" });
  const loaded = await store.load();
  assert.deepEqual(loaded.snapshot.modelAliases, { reviewer: "anthropic/opus" });
  assert.deepEqual(loaded.run.events, [{ type: "warning", message: "reviewer: openai/gpt -> anthropic/opus" }]);
  assert.match(formatNavigatorDashboard(loaded.run, [], []), /reviewer: openai\/gpt -> anthropic\/opus/);
});
void test("workflow catalog exposes aliases without guidance metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-catalog-aliases-"));
  const agentDir = join(dir, "agent");
  const path = join(agentDir, "pi-extensible-workflows", "settings.json");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(path, JSON.stringify({ modelAliases: { reviewer: "anthropic/opus:high" } }));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    const registry = new WorkflowRegistry();
    assert.deepEqual(registry.catalog().modelAliases, { reviewer: "anthropic/opus:high" });
    assert.deepEqual(registry.catalogIndex().modelAliases, { reviewer: "anthropic/opus:high" });
  } finally { if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous; }
});

void test("workflow catalog and session_start tolerate malformed settings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-catalog-malformed-"));
  const agentDir = join(dir, "agent");
  const path = join(agentDir, "pi-extensible-workflows", "settings.json");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(path, "{");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    assert.deepEqual(new WorkflowRegistry().catalog(), { functions: [] });
    const tools: Array<{ name: string }> = [];
    let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
    let shutdown: (() => Promise<void>) | undefined;
    workflowExtension(testExtensionApi({ registerTool(tool: { name: string }) { tools.push(tool); }, registerCommand() {}, getActiveTools: () => ["workflow"], on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; } }), dir);
    registerWorkflowExtension({ version: "1.0.0", headline: "Malformed settings", functions: { verify: { description: "Verify", input: { type: "object" }, output: { type: "boolean" }, run: () => true } } });
    assert.ok(start && shutdown);
    await start({}, { cwd: dir, sessionManager: { getSessionId: () => "malformed" } });
    assert.equal(tools.some(({ name }) => name === "workflow_catalog"), true);
    await shutdown();
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
  }
});

void test("resolves trusted project settings with replacement and inheritance semantics", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-project-settings-"));
  const home = join(root, "home");
  const cwd = join(root, "project");
  const globalPath = join(home, "agent", "pi-extensible-workflows", "settings.json");
  const projectPath = join(cwd, ".pi", "pi-extensible-workflows", "settings.json");
  mkdirSync(join(home, "agent", "pi-extensible-workflows"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  writeFileSync(globalPath, JSON.stringify({ concurrency: 6, modelAliases: { reviewer: "openai/gpt" }, skills: ["global"], extensions: ["/global.ts"] }));
  writeFileSync(projectPath, JSON.stringify({ concurrency: 2, modelAliases: {}, skills: [], extensions: [] }));
  const trusted = resolveWorkflowSettings(cwd, true, globalPath);
  assert.equal(trusted.effective.concurrency, 2);
  assert.deepEqual(trusted.effective.modelAliases, {});
  assert.deepEqual(trusted.effective.skills, ["global"]);
  assert.equal(trusted.sources.modelAliases, projectPath);
  assert.equal(trusted.effective.backgroundWidget, true);
  writeFileSync(projectPath, JSON.stringify({ concurrency: 3 }));
  const partial = resolveWorkflowSettings(cwd, true, globalPath);
  assert.equal(partial.effective.concurrency, 3);
  assert.deepEqual(partial.effective.modelAliases, { reviewer: "openai/gpt" });
  assert.deepEqual(partial.effective.skills, ["global"]);
  writeFileSync(projectPath, JSON.stringify({ backgroundWidget: false }));
  assert.throws(() => resolveWorkflowSettings(cwd, true, globalPath), /Unknown workflow setting/);
  writeFileSync(projectPath, "{ malformed");
  assert.doesNotThrow(() => resolveWorkflowSettings(cwd, false, globalPath));
  assert.throws(() => resolveWorkflowSettings(cwd, true, globalPath), /Invalid workflow settings JSON/);
});
void test("workflow_catalog reports effective project settings without registered functions", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-project-catalog-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const globalPath = join(agentDir, "pi-extensible-workflows", "settings.json");
  const projectPath = join(cwd, ".pi", "pi-extensible-workflows", "settings.json");
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  writeFileSync(globalPath, JSON.stringify({ concurrency: 6 }));
  writeFileSync(projectPath, JSON.stringify({ concurrency: 2 }));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const tools: Array<{ name: string; execute?: (...args: never[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  try {
    workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getActiveTools: () => ["workflow"], on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; } }), root);
    assert.ok(start && shutdown);
    await start({}, { cwd, isProjectTrusted: () => true, sessionManager: { getSessionId: () => "catalog" } });
    const catalogTool = tools.find(({ name }) => name === "workflow_catalog");
    assert.ok(catalogTool?.execute);
    const catalog = JSON.parse((await catalogTool.execute()).content[0]?.text ?? "null") as { settings: { concurrency: number; sources: { concurrency: string } } };
    assert.equal(catalog.settings.concurrency, 2);
    assert.equal(catalog.settings.sources.concurrency, projectPath);
  } finally {
    await shutdown?.();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  }
});
