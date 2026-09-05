import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { doctor, doctorExitCode, formatDoctorReport, type DoctorPiState } from "../src/doctor.js";
import { writePortableWorkflowBundle } from "../src/bundles.js";
import { formatWorkflowCliHelp, parseDoctorArgs, parseDoctorCleanupArgs, parseScriptWorkflowCliArgs, parseWorkflowCliArgs, runCli } from "../src/cli.js";
import { registerWorkflowExtension, resetWorkflowRegistry, WorkflowRegistry } from "pi-extensible-workflows";
import { cliTestErrorOutput, isCliTestBundleExtension, isCliTestBundleModule, readCliTestBundleState, readCliTestManifest, readCliTestPackageMetadata, writeCliTestExtensionSource, type CliTestBundleExtension } from "./support.js";
import { registerCliExtension } from "./fixtures/cli-workflow-extension.js";

function pi(overrides: Partial<DoctorPiState> = {}): DoctorPiState {
  return {
    trust: { required: true, trusted: true, source: "test trust" },
    activeTools: ["read", "grep"],
    knownModels: ["openai/gpt"],
    availableModels: ["openai/gpt"],
    extensionErrors: [],
    functions: {},
    ...overrides,
  };
}

function fixture(): { root: string; cwd: string; agentDir: string; settingsPath: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-extensible-workflows-doctor-")));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(join(agentDir, "pi-extensible-workflows", "roles"), { recursive: true });
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "test" } }));
  return { root, cwd, agentDir, settingsPath: join(root, "missing-settings.json") };
}

async function withHome<T>(home: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try { return await action(); }
  finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
}
async function withHomeAndCwd<T>(home: string, cwd: string, action: () => Promise<T>): Promise<T> {
  const previousHome = process.env.HOME;
  const previousCwd = process.cwd();
  process.env.HOME = home;
  process.chdir(cwd);
  try { return await action(); }
  finally { process.chdir(previousCwd); if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome; }
}

function runIsolatedCli(paths: { root: string; cwd: string; agentDir: string }, functionDefinition: string, args: readonly string[], abort = false): { status: number | null; stdout: string; stderr: string } {
  const script = join(paths.root, "isolated-cli.mjs");
  const indexUrl = pathToFileURL(join(process.cwd(), "../core", "dist", "src", "index.js")).href;
  const cliUrl = pathToFileURL(join(process.cwd(), "dist", "src", "cli.js")).href;
  writeFileSync(script, [`import { registerWorkflowExtension } from ${JSON.stringify(indexUrl)};`, `import { runCli } from ${JSON.stringify(cliUrl)};`, `registerWorkflowExtension({ version: "1.0.0", headline: "Isolated CLI", functions: { ${functionDefinition} } });`, "const controller = new AbortController();", abort ? "setImmediate(() => controller.abort());" : "", `const exit = await runCli(${JSON.stringify(args)}, { cwd: ${JSON.stringify(paths.cwd)}, agentDir: ${JSON.stringify(paths.agentDir)}, signal: controller.signal, stderr: (text) => process.stderr.write(text) });`, "process.exitCode = exit;"].join("\n"));
  const result = spawnSync(process.execPath, [script], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, env: { ...process.env, HOME: paths.root, PI_CODING_AGENT_DIR: paths.agentDir, PI_OFFLINE: "1" } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}
void test("doctor reports malformed settings and Pi discovery rejection diagnostics", async () => {
  const paths = fixture();
  writeFileSync(paths.settingsPath, "{\n");
  const report = await withHome(paths.root, () => doctor({ ...paths, discoverPi: async () => { throw new Error("discovery exploded"); } }));
  const settings = report.diagnostics.find(({ code }) => code === "SETTINGS_INVALID");
  const discovery = report.diagnostics.find(({ code }) => code === "PI_DISCOVERY");
  assert.ok(settings);
  assert.equal(settings.source, paths.settingsPath);
  assert.ok(discovery);
  assert.match(discovery.message, /discovery exploded/);
  assert.match(discovery.hint ?? "", /rerun doctor/);
  assert.equal(doctorExitCode(report), 1);
});
void test("doctor discovers per-file symlinked role files", async () => {
  const paths = fixture();
  const target = join(paths.root, "source-role.md");
  const link = join(paths.agentDir, "pi-extensible-workflows", "roles", "linked.md");
  writeFileSync(target, "---\ndescription: Linked role\n---\nLinked body");
  symlinkSync(target, link);
  symlinkSync(join(paths.root, "missing-role.md"), join(paths.agentDir, "pi-extensible-workflows", "roles", "dangling.md"));
  writeFileSync(join(paths.agentDir, "pi-extensible-workflows", "roles", "sibling.md"), "Sibling role");
  const report = await withHome(paths.root, () => doctor({ ...paths, role: "linked", discoverPi: async () => pi({ knownModels: [], availableModels: [] }) }));
  const role = report.roles.find(({ name, scope }) => name === "linked" && scope === "global");
  assert.ok(role);
  assert.equal(role.path, link);
  assert.equal(report.diagnostics.some(({ code }) => code === "ROLE_NOT_FOUND"), false);
  assert.ok(report.roles.some(({ name, scope }) => name === "sibling" && scope === "global"));
});
void test("doctor discovers Pi through local auth, models, and trust fixtures", async () => {
  const paths = fixture();
  writeFileSync(join(paths.cwd, ".pi", "settings.json"), "{}");
  writeFileSync(join(paths.agentDir, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "local-fixture" } }));
  writeFileSync(join(paths.agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "fixture", models: [{ id: "fixture-model", name: "Fixture model", input: ["text"], contextWindow: 1_024, maxTokens: 128 }] } } }));
  writeFileSync(join(paths.agentDir, "trust.json"), JSON.stringify({ [realpathSync(paths.cwd)]: true }));
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "local.md"), "---\nmodel: fixture/fixture-model:medium\n---\nLocal role");
  const before = readdirSync(paths.root, { recursive: true }).map(String).sort();
  const report = await withHomeAndCwd(paths.root, paths.cwd, () => doctor(paths));
  const after = readdirSync(paths.root, { recursive: true }).map(String).sort();
  assert.deepEqual(after, before);
  assert.deepEqual(report.trust, { required: true, trusted: true, source: "saved Pi trust decision" });
  assert.deepEqual(report.roles.map(({ name, scope, active }) => ({ name, scope, active })), [{ name: "local", scope: "project", active: true }]);
  assert.equal(report.diagnostics.some(({ code }) => code === "PI_DISCOVERY" || code.startsWith("MODEL_")), false);
  assert.equal(doctorExitCode(report), 0);
});

void test("doctor reports malformed auth and trust discovery diagnostics", async () => {
  const cases = [
    ["auth.json", "{\n", /Expected property name/],
    ["trust.json", "[]", /trust\.json must be an object/],
  ] as const;
  for (const [file, contents, message] of cases) {
    const paths = fixture();
    writeFileSync(join(paths.cwd, ".pi", "settings.json"), "{}");
    writeFileSync(join(paths.agentDir, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "local-fixture" } }));
    writeFileSync(join(paths.agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "fixture", models: [{ id: "fixture-model" }] } } }));
    writeFileSync(join(paths.agentDir, "trust.json"), JSON.stringify({ [realpathSync(paths.cwd)]: true }));
    writeFileSync(join(paths.agentDir, file), contents);
    const report = await withHomeAndCwd(paths.root, paths.cwd, () => doctor(paths));
    const discovery = report.diagnostics.find(({ code }) => code === "PI_DISCOVERY");
    assert.ok(discovery, file);
    assert.match(discovery.message, message, file);
    assert.equal(doctorExitCode(report), 1, file);
  }
});

void test("doctor reports role errors, warnings, overrides, and extension failures", async () => {
  const paths = fixture();
  mkdirSync(join(paths.cwd, ".pi", "piworkflows", "roles"), { recursive: true });
  writeFileSync(join(paths.cwd, ".pi", "piworkflows", "roles", "old-project.md"), "Ignored old project role");
  writeFileSync(join(paths.agentDir, "pi-extensible-workflows", "roles", "override.md"), "Global role");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "override.md"), "Project role");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "tool-typo.md"), "---\ntools: [read, cat]\n---\nCheck tools");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "thinking.md"), "---\nthinking: hihg\n---\nThink");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "malformed-model.md"), "---\nmodel: gpt-5\n---\nModel");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "unavailable-model.md"), "---\nmodel: other/model:high\n---\nModel");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "empty.md"), "---\ntools: [read]\n---\n");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "placeholder.md"), "Use {{tools}} here");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "empty-frontmatter.md"), "---\n---\nBody");

  const report = await withHome(paths.root, () => doctor({ ...paths, activeTools: ["read"], discoverPi: async () => pi({ activeTools: ["cat"], extensionErrors: [{ path: "/bad-extension.ts", message: "load failed" }] }) }));
  const codes = report.diagnostics.map(({ code }) => code);
  assert.ok(codes.includes("ROLE_TOOL_INACTIVE"));
  assert.ok(codes.includes("ROLE_FRONTMATTER"));
  assert.ok(codes.includes("MODEL_INVALID"));
  assert.ok(codes.includes("MODEL_UNAVAILABLE"));
  assert.ok(codes.includes("ROLE_BODY_EMPTY"));
  assert.ok(codes.includes("ROLE_PLACEHOLDER"));
  assert.ok(codes.includes("EXTENSION_LOAD"));
  assert.ok(!report.diagnostics.some(({ source }) => source?.endsWith("empty-frontmatter.md")));
  assert.ok(!report.roles.some(({ name }) => name === "old-project"));
  const project = report.roles.find((role) => role.name === "override" && role.scope === "project");
  const global = report.roles.find((role) => role.name === "override" && role.scope === "global");
  assert.ok(project);
  assert.ok(global);
  assert.equal(project.overrides, join(paths.agentDir, "pi-extensible-workflows", "roles", "override.md"));
  assert.equal(global.overriddenBy, join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "override.md"));
  assert.equal(global.active, false);
  assert.equal(doctorExitCode(report), 1);
  assert.match(formatDoctorReport(report), /Fix: Use a tool listed under Pi active tools/);
});

void test("doctor validates role tool selectors like runtime", async () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-extensible-workflows", "roles", "selectors.md"), "---\ntools: [\"!*\", \"r*\", read, cat]\n---\nInspect selectors");
  const report = await withHome(paths.root, () => doctor({ ...paths, discoverPi: async () => pi({ activeTools: ["read"] }) }));
  assert.deepEqual(report.diagnostics.filter(({ code }) => code === "ROLE_TOOL_INACTIVE").map(({ message }) => message), ["Tool is unknown or inactive: cat"]);
});

void test("doctor rejects invalid role descriptions", async () => {
  const paths = fixture();
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "empty-description.md"), "---\ndescription: ''\n---\nRole");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "long-description.md"), `---\ndescription: ${"x".repeat(1025)}\n---\nRole`);
  const report = await withHome(paths.root, () => doctor({ ...paths, discoverPi: async () => pi() }));
  const sources = report.diagnostics.filter(({ code }) => code === "ROLE_FRONTMATTER").map(({ source }) => source);
  assert.ok(sources.includes(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "empty-description.md")));
  assert.ok(sources.includes(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "long-description.md")));
});
void test("doctor reports every registered function", async () => {
  const paths = fixture();
  const functions: DoctorPiState["functions"] = {
    missingRole: { description: "missing role", input: { type: "object" }, output: { type: "string" }, run: () => "role" },
    missingTool: { description: "missing tool", input: { type: "object" }, output: { type: "string" }, run: () => "tool" },
    badMeta: { description: "bad metadata", input: { type: "object" }, output: { type: "string" }, run: () => "meta" },
  };
  const report = await withHome(paths.root, () => doctor({ ...paths, discoverPi: async () => pi({ functions }) }));
  assert.deepEqual(report.functions.map(({ name, valid }) => [name, valid]), [
    ["badMeta", true],
    ["missingRole", true],
    ["missingTool", true],
  ]);
  assert.equal(report.diagnostics.some(({ code }) => code.startsWith("FUNCTION_")), false);
});
void test("doctor reports dynamic model alias provenance", async () => {
  const paths = fixture();
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Model policy", modelAliases: { reviewer: { resolve: () => "openai/gpt" } } });
  const report = await withHome(paths.root, () => doctor({ ...paths, registry, discoverPi: async () => pi() }));
  assert.deepEqual(report.modelAliases, [{ name: "reviewer", kind: "dynamic", provenance: "extension: Model policy", version: "1.0.0", headline: "Model policy" }]);
  assert.match(formatDoctorReport(report), /\[dynamic\] `reviewer` \(extension: Model policy\)/);
});
void test("doctor accepts role files using unshadowed dynamic model aliases without resolving them", async () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-extensible-workflows", "roles", "reviewer.md"), "---\nmodel: policy-model\n---\nReview");
  const registry = new WorkflowRegistry();
  let calls = 0;
  registry.register({ version: "1.0.0", headline: "Model policy", modelAliases: { "policy-model": { resolve: () => { calls += 1; return "openai/gpt"; } } } });
  const report = await withHome(paths.root, () => doctor({ ...paths, registry, discoverPi: async () => pi() }));
  assert.equal(calls, 0);
  assert.equal(report.diagnostics.some(({ code }) => code === "MODEL_INVALID" || code === "MODEL_UNAVAILABLE"), false);
  assert.equal(doctorExitCode(report), 0);
});
void test("doctor leaves static settings aliases shadowing dynamic aliases", async () => {
  const paths = fixture();
  writeFileSync(paths.settingsPath, JSON.stringify({ modelAliases: { "policy-model": "other/model" } }));
  writeFileSync(join(paths.agentDir, "pi-extensible-workflows", "roles", "reviewer.md"), "---\nmodel: policy-model\n---\nReview");
  const registry = new WorkflowRegistry();
  let calls = 0;
  registry.register({ version: "1.0.0", headline: "Model policy", modelAliases: { "policy-model": { resolve: () => { calls += 1; return "openai/gpt"; } } } });
  const report = await withHome(paths.root, () => doctor({ ...paths, registry, discoverPi: async () => pi() }));
  assert.equal(calls, 0);
  assert.equal(report.diagnostics.some(({ code }) => code === "MODEL_INVALID"), false);
  assert.ok(report.diagnostics.some(({ code }) => code === "MODEL_UNAVAILABLE"));
});
void test("doctor reports registered functions without model availability probes", async () => {
  const paths = fixture();
  const functions: DoctorPiState["functions"] = { unavailable: { description: "unavailable model", input: { type: "object" }, output: { type: "string" }, run: () => "ok" } };
  const report = await withHome(paths.root, () => doctor({ ...paths, discoverPi: async () => pi({ availableModels: [], functions }) }));
  assert.equal(report.functions.find(({ name }) => name === "unavailable")?.valid, true);
});
void test("role-targeted doctor inspects effective resources and prepares hooks without provider execution", async () => {
  const paths = fixture();
  writeFileSync(join(paths.cwd, ".pi", "settings.json"), "{}");
  writeFileSync(join(paths.agentDir, "auth.json"), JSON.stringify({ fixture: { type: "api_key", key: "local-fixture" } }));
  writeFileSync(join(paths.agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "fixture", models: [{ id: "fixture-model", name: "Fixture model", reasoning: true, input: ["text"], contextWindow: 1_024, maxTokens: 128 }, { id: "override-model", name: "Override model", reasoning: true, input: ["text"], contextWindow: 1_024, maxTokens: 128 }] } } }));
  writeFileSync(join(paths.agentDir, "trust.json"), JSON.stringify({ [realpathSync(paths.cwd)]: true }));
  mkdirSync(join(paths.agentDir, "skills", "review-skill"), { recursive: true });
  writeFileSync(join(paths.agentDir, "skills", "review-skill", "SKILL.md"), "---\nname: review-skill\ndescription: Review\n---\nReview skill");
  mkdirSync(join(paths.agentDir, "skills", "invalid_skill"), { recursive: true });
  writeFileSync(join(paths.agentDir, "skills", "invalid_skill", "SKILL.md"), "---\ndescription: Invalid name fixture\n---\nInvalid skill");
  mkdirSync(join(paths.agentDir, "extensions"), { recursive: true });
  const shutdownMarker = join(paths.root, "doctor-shutdown.marker");
  writeFileSync(join(paths.agentDir, "extensions", "doctor-hook.ts"), `import { appendFileSync } from "node:fs"; export default (pi) => { pi.on('before_agent_start', (event) => ({ systemPrompt: event.systemPrompt + '\\nHOOK:' + event.prompt })); pi.on('session_shutdown', async () => { await new Promise((resolve) => setTimeout(resolve, 25)); appendFileSync(${JSON.stringify(shutdownMarker)}, 'shutdown'); }); };
`);
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "reviewer.md"), "---\nmodel: fixture/fixture-model:high\ntools: [read, grep]\nskills: [\"*\", \"!review-skill\"]\nextensions: [\"**/*\", \"!missing-extension\"]\n---\nReview role");
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Doctor setup", agentSetupHooks: { adjust: { setup(agent, context) { assert.equal(context.mode, "inspection"); assert.equal(agent.prepared.model.model, "fixture-model"); assert.equal(agent.prepared.model.thinking, "high"); agent.options.model = "fixture/override-model:low"; agent.options.tools = ["grep"]; } } } });
  const report = await withHomeAndCwd(paths.root, paths.cwd, () => doctor({ ...paths, role: "reviewer", registry, discoverPi: async () => pi({ activeTools: ["read", "grep"], knownModels: ["fixture/fixture-model", "fixture/override-model"], availableModels: ["fixture/fixture-model", "fixture/override-model"], model: { provider: "fixture", model: "fixture-model", thinking: "medium" } }) }));
  const inspection = report.roleInspection;
  assert.ok(inspection);
  assert.equal(inspection.model.model, "override-model");
  assert.notEqual(inspection.model.inherited, true);
  assert.equal(inspection.model.thinking, "low");
  assert.ok(inspection.resources.skills.includes("invalid_skill"));
  const invalidSkillDiagnostic = report.diagnostics.find(({ message }) => message.includes("invalid characters"));
  assert.ok(invalidSkillDiagnostic);
  assert.equal(invalidSkillDiagnostic.severity, "warning");
  assert.equal(invalidSkillDiagnostic.source, join(paths.agentDir, "skills", "invalid_skill", "SKILL.md"));
  assert.equal(inspection.resources.skills.includes("review-skill"), false);
  assert.deepEqual(inspection.resources.unmatchedExtensions, [`!${join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "missing-extension")}`]);
  assert.ok(inspection.setup.hooks.includes("adjust"));
  assert.ok(inspection.setup.diagnostics.every(({ severity }) => severity !== "error"), JSON.stringify(report.diagnostics));
  assert.ok(inspection.systemPrompt.text.includes("HOOK:"));
  assert.match(inspection.systemPrompt.text, /Review role/);
  assert.equal(report.diagnostics.some(({ code, severity }) => code === "ROLE_INSPECTION" && severity === "error"), false);
  assert.equal(readFileSync(shutdownMarker, "utf8"), "shutdown");
  assert.equal(doctorExitCode(report), 0);
  const formatted = formatDoctorReport(report);
  assert.match(formatted, /## Role inspection/);
  for (const heading of ["## Environment", "## Trust/resources", "## Workflow agent resource selectors", "## Active tools", "## Roles", "## Model aliases", "## Reusable functions"]) assert.doesNotMatch(formatted, new RegExp(heading));
  assert.match(formatted, /Role: `reviewer`/);
  assert.match(formatted, /- Tools:\n[ ]{2}- `grep`/);
  assert.match(formatted, /- Role skill selectors:\n[ ]{2}- `\*`\n[ ]{2}- `!review-skill`/);
  assert.match(formatted, /- Effective skills:\n(?:[ ]{2}- .+\n)+/);
  assert.match(formatted, /- Effective extensions:\n(?:[ ]{2}- .+\n)+/);
  assert.match(formatted, /- Applied setup hooks:\n[ ]{2}- `adjust`/);
  assert.match(formatted, /Final system prompt[\s\S]*HOOK:/);
  let jsonOutput = "";
  assert.equal(await withHomeAndCwd(paths.root, paths.cwd, () => runCli(["doctor", "--role", "reviewer", "--json"], { ...paths, registry, discoverPi: async () => pi({ activeTools: ["read", "grep"], knownModels: ["fixture/fixture-model", "fixture/override-model"], availableModels: ["fixture/fixture-model", "fixture/override-model"], model: { provider: "fixture", model: "fixture-model", thinking: "medium" } }) }, (text) => { jsonOutput += text; })), 0);
  const jsonReport = JSON.parse(jsonOutput) as { roleTarget: string; roleInspection: { role: string; model: { model: string } } };
  assert.equal(jsonReport.roleTarget, "reviewer");
  assert.equal(jsonReport.roleInspection.role, "reviewer");
  assert.equal(jsonReport.roleInspection.model.model, "override-model");
});
void test("role-targeted doctor preserves role-not-found diagnostics in focused output", async () => {
  const paths = fixture();
  const report = await withHome(paths.root, () => doctor({ ...paths, role: "missing", discoverPi: async () => pi() }));
  const formatted = formatDoctorReport(report);
  assert.equal(report.roleInspection, undefined);
  assert.match(formatted, /## Role inspection/);
  assert.match(formatted, /Role: `missing`/);
  assert.match(formatted, /ROLE_NOT_FOUND/);
  assert.match(formatted, /1 error\(s\), 0 warning\(s\)/);
  for (const heading of ["## Environment", "## Trust/resources", "## Active tools", "## Roles", "## Model aliases", "## Reusable functions"]) assert.doesNotMatch(formatted, new RegExp(heading));
});

void test("doctor respects untrusted projects and does not mutate fixtures", async () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-extensible-workflows", "roles", "same.md"), "Global");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "same.md"), "---\ntools: [cat]\ndisabledAgentResources: {}\n---\nProject");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "settings.json"), JSON.stringify({ disabledAgentResources: {} }));
  const before = readdirSync(paths.root, { recursive: true }).map(String).sort();
  const report = await withHome(paths.root, () => doctor({ ...paths, discoverPi: async () => pi({ trust: { required: true, trusted: false, source: "saved Pi trust decision" } }) }));
  const after = readdirSync(paths.root, { recursive: true }).map(String).sort();
  assert.deepEqual(after, before);
  assert.ok(report.diagnostics.some(({ code }) => code === "PROJECT_UNTRUSTED"));
  assert.ok(!report.diagnostics.some(({ code }) => code === "ROLE_TOOL_INACTIVE"));
  assert.equal(report.roles.find((role) => role.scope === "project")?.active, false);
  assert.equal(report.diagnostics.some(({ code }) => code === "AGENT_RESOURCE_SELECTOR_MIGRATION"), false);
  assert.equal(doctorExitCode(report), 0);
});
void test("doctor reports errors for legacy agent resource selectors in active settings and roles", async () => {
  const paths = fixture();
  const globalSettings = join(paths.agentDir, "pi-extensible-workflows", "settings.json");
  const projectSettings = join(paths.cwd, ".pi", "pi-extensible-workflows", "settings.json");
  const globalRole = join(paths.agentDir, "pi-extensible-workflows", "roles", "global.md");
  const projectRole = join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "project.md");
  const directRole = join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "direct.md");
  writeFileSync(globalSettings, JSON.stringify({ disabledAgentResources: {} }));
  writeFileSync(projectSettings, JSON.stringify({ disabledAgentResources: { skills: [], extensions: [] } }));
  writeFileSync(globalRole, "---\ndisabledAgentResources: {}\n---\nGlobal role");
  writeFileSync(projectRole, "---\ndisabledAgentResources:\n  skills: []\n  extensions: []\n---\nProject role");
  writeFileSync(directRole, "---\nskills: []\nextensions: []\ntools: [read]\n---\nDirect selectors");
  const report = await withHome(paths.root, () => doctor({ ...paths, settingsPath: globalSettings, discoverPi: async () => pi() }));
  const migrations = report.diagnostics.filter(({ code }) => code === "AGENT_RESOURCE_SELECTOR_MIGRATION");
  assert.deepEqual(migrations.map(({ source }) => source).sort(), [
    `${globalSettings}.disabledAgentResources`,
    `${projectSettings}.disabledAgentResources`,
    globalRole,
    projectRole,
  ].sort());
  assert.ok(migrations.every(({ severity, message, hint }) => severity === "error" && message.includes("#205") && message.includes("pattern") && message.includes("skills") && message.includes("extensions") && message.includes("tools") && hint?.includes("!*")));
  assert.ok(report.diagnostics.some(({ code, source }) => code === "SETTINGS_INVALID" && source === globalSettings));
  assert.ok(report.diagnostics.some(({ code }) => code === "ROLE_LOAD_BLOCKED"));
  assert.doesNotMatch(formatDoctorReport(report), /direct\.md.*AGENT_RESOURCE_SELECTOR_MIGRATION/);
  assert.match(formatDoctorReport(report), /https:\/\/github\.com\/vekexasia\/pi-extensible-workflows\/issues\/205/);
  assert.match(formatDoctorReport(report), /unavailable: role loading failed/);
  assert.equal(doctorExitCode(report), 1);
});
void test("doctor warns when a positive-only tool selector cannot form an allow-list", async () => {
  const paths = fixture();
  const globalSettings = join(paths.agentDir, "pi-extensible-workflows", "settings.json");
  writeFileSync(globalSettings, JSON.stringify({ tools: ["read"] }));
  const report = await withHome(paths.root, () => doctor({ ...paths, settingsPath: globalSettings, discoverPi: async () => pi() }));
  const warning = report.diagnostics.find(({ code }) => code === "AGENT_RESOURCE_TOOL_SELECTOR_ALLOWLIST");
  assert.ok(warning);
  assert.equal(warning.severity, "warning");
  assert.equal(warning.source, `${globalSettings}.tools`);
  assert.match(warning.hint ?? "", /!\*/);
  assert.equal(doctorExitCode(report), 0);
});
void test("doctor reports effective resource selectors and unmatched patterns", async () => {
  const paths = fixture();
  const globalSettings = join(paths.agentDir, "pi-extensible-workflows", "settings.json");
  const globalExtension = join(paths.agentDir, "extensions", "interactive.ts");
  const projectExtension = join(paths.cwd, ".pi", "project.ts");
  mkdirSync(join(paths.agentDir, "extensions"), { recursive: true });
  writeFileSync(globalSettings, JSON.stringify({ skills: ["!*", "global-skill"], extensions: ["!*", globalExtension] }));
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "settings.json"), JSON.stringify({ skills: ["!*", "project-skill"], extensions: ["!*", "../project.ts"] }));
  const report = await withHome(paths.root, () => doctor({ ...paths, settingsPath: globalSettings, discoverPi: async () => pi({ extensions: [globalExtension, projectExtension], skills: ["global-skill", "project-skill"] }) }));
  assert.deepEqual(report.resourcePolicy.selectedSkills, ["project-skill"]);
  assert.deepEqual(report.resourcePolicy.selectedExtensions, [projectExtension]);
  assert.deepEqual(report.resourcePolicy.unmatchedSkills, []);
  assert.deepEqual(report.resourcePolicy.unmatchedExtensions, []);
  assert.equal(report.diagnostics.filter(({ code }) => code === "AGENT_RESOURCE_UNMATCHED").length, 0);
  const formatted = formatDoctorReport(report);
  assert.match(formatted, /Effective skills: project-skill/);
  assert.match(formatted, /## Pi active extensions/);
  assert.match(formatted, /## Pi active skills/);
  assert.match(formatted, /Global skills: !\*, global-skill/);
  assert.match(formatted, /Project skills: !\*, project-skill/);
  assert.match(formatted, /Global extensions:[\s\S]*interactive\.ts/);
  assert.match(formatted, /Project extensions:[\s\S]*project\.ts/);
});
void test("doctor attributes unmatched replacement selectors to the project settings field", async () => {
  const paths = fixture();
  const globalSettings = join(paths.agentDir, "pi-extensible-workflows", "settings.json");
  const projectSettings = join(paths.cwd, ".pi", "pi-extensible-workflows", "settings.json");
  writeFileSync(globalSettings, JSON.stringify({ skills: ["same-selector"] }));
  writeFileSync(projectSettings, JSON.stringify({ skills: ["same-selector"] }));
  const report = await withHome(paths.root, () => doctor({ ...paths, settingsPath: globalSettings, discoverPi: async () => pi({ skills: [] }) }));
  assert.equal(report.settingsSources.skills, projectSettings);
  assert.deepEqual(report.diagnostics.filter(({ code }) => code === "AGENT_RESOURCE_UNMATCHED").map(({ source }) => source), [`${projectSettings}.skills`, `${projectSettings}.skills`]);
});
void test("doctor reports matched glob exclusions and unmatched exceptions", async () => {
  const paths = fixture();
  const globalSettings = join(paths.agentDir, "pi-extensible-workflows", "settings.json");
  const globalExtension = join(paths.agentDir, "extensions", "interactive.ts");
  const projectExtension = join(paths.cwd, ".pi", "project.ts");
  mkdirSync(join(paths.agentDir, "extensions"), { recursive: true });
  writeFileSync(globalSettings, JSON.stringify({ skills: ["*", "!my-project-*", "!missing-*"], extensions: ["**/*", `!${projectExtension}`, `!${join(paths.root, "missing.ts")}`] }));
  const report = await withHome(paths.root, () => doctor({ ...paths, settingsPath: globalSettings, discoverPi: async () => pi({ extensions: [globalExtension, projectExtension], skills: ["my-project-skill", "other-skill"] }) }));
  assert.deepEqual(report.resourcePolicy.selectedSkills, ["other-skill"]);
  assert.deepEqual(report.resourcePolicy.selectedExtensions, [globalExtension]);
  assert.deepEqual(report.resourcePolicy.unmatchedSkills, ["!missing-*"]);
  assert.deepEqual(report.resourcePolicy.unmatchedExtensions, [`!${join(paths.root, "missing.ts")}`]);
  assert.match(formatDoctorReport(report), /Effective skills: other-skill/);
});
void test("doctor excludes workflow_catalog from active capabilities and output", async () => {
  const paths = fixture();
  const report = await withHome(paths.root, () => doctor({ ...paths, activeTools: ["read", "workflow", "workflow_respond", "workflow_catalog"], discoverPi: async () => pi({ activeTools: ["read", "workflow", "workflow_respond", "workflow_catalog"] }) }));
  assert.deepEqual(report.activeTools, ["read"]);
  assert.doesNotMatch(formatDoctorReport(report), /workflow_catalog/);
});
void test("package bin and CLI expose doctor and inspector commands", async () => {
  const pkg = readCliTestPackageMetadata(join(process.cwd(), "package.json"));
  assert.equal(pkg.bin?.piewf, "./dist/src/cli.js");
  const paths = fixture();
  let output = "";
  const exit = await withHome(paths.root, () => runCli(["doctor"], { ...paths, discoverPi: async () => pi({ knownModels: [], availableModels: [] }) }, (text) => { output += text; }));
  assert.equal(exit, 0);
  for (const heading of ["## Environment", "## Trust/resources", "## Pi active tools", "## Pi active extensions", "## Pi active skills", "## Workflow agent resource selectors", "## Roles", "## Reusable functions", "## Diagnostics", "## Summary"]) assert.match(output, new RegExp(heading));
  assert.doesNotMatch(output, /## Role inspection/);
  output = "";
  assert.equal(await withHome(paths.root, () => runCli(["doctor", "--json"], { ...paths, discoverPi: async () => pi({ knownModels: [], availableModels: [] }) }, (text) => { output += text; })), 0);
  const jsonReport = JSON.parse(output) as { cwd: string; activeTools: readonly string[]; diagnostics: readonly unknown[] };
  assert.equal(jsonReport.cwd, paths.cwd);
  assert.deepEqual(jsonReport.activeTools, ["grep", "read"]);
  assert.ok(Array.isArray(jsonReport.diagnostics));
  let inspected: string | undefined;
  assert.equal(await runCli(["inspect", "session-a"], { inspect: async (sessionId) => { inspected = sessionId; } }), 0);
  assert.equal(inspected, "session-a");
  output = "";
  assert.equal(await runCli([], {}, (text) => { output += text; }), 1);
  assert.equal(output, "Usage: piewf doctor [role] [--role <role>] [--prompt <text>] [--json] | inspect [session-id] [--json|--summary] [--failed] | transcript <session-file> | share <run-id> | bundle <workflow-name> [--name <command>] [--output <path>] [--force] | run <workflow-name> [workflow arguments] | run --script <path> [--name <workflow-name>] [--input <json>] | export <workflow-name> [--name <command>] [--output <path>] [--force] [--bundle]\n");
  const bin = join(paths.root, "bin", "piewf");
  mkdirSync(join(paths.root, "bin"), { recursive: true });
  symlinkSync(join(process.cwd(), "dist", "src", "cli.js"), bin);
  const linkedOutput = execFileSync(bin, ["doctor"], { cwd: paths.cwd, env: { ...process.env, HOME: paths.root }, encoding: "utf8" });
  assert.match(linkedOutput, /^# pi-extensible-workflows doctor/m);
  assert.equal(existsSync(join(paths.root, ".pi", "agent", "auth.json")), false);
});
void test("doctor parser accepts role and prompt probes", () => {
  assert.deepEqual(parseDoctorArgs(["--role", "reviewer", "--prompt=check this", "--json"]), { role: "reviewer", prompt: "check this", json: true });
  assert.deepEqual(parseDoctorArgs(["--json"]), { json: true });
  assert.deepEqual(parseDoctorArgs(["reviewer"]), { role: "reviewer" });
  assert.throws(() => parseDoctorArgs(["--role", "reviewer", "other"]), /Unexpected argument/);
  assert.throws(() => parseDoctorArgs(["--prompt", "check this"]), /--prompt requires --role/);
});
void test("CLI workflow arguments cover schema types, defaults, enums, and missing values", () => {
  const schema = { type: "object", properties: { issue: { type: "integer", description: "Issue number" }, label: { type: "string" }, ratio: { type: "number" }, mode: { type: "string", enum: ["fast", "safe"] }, verbose: { type: "boolean", default: false }, format: { type: "string", default: "plain" }, tags: { type: "array", items: { type: "string", enum: ["one", "two"] } }, scores: { type: "array", items: { type: "number" } } }, required: ["issue"], additionalProperties: false };
  assert.deepEqual(parseWorkflowCliArgs(schema, ["123", "--label", "hello", "--ratio=1.5", "--mode", "fast", "--tags", "one", "--tags=two", "--scores", "2.5", "--scores=3"]), { issue: 123, label: "hello", ratio: 1.5, mode: "fast", verbose: false, format: "plain", tags: ["one", "two"], scores: [2.5, 3] });
  assert.deepEqual(parseWorkflowCliArgs(schema, ["--input", "{\"issue\":7}"]), { issue: 7, verbose: false, format: "plain" });
  assert.throws(() => parseWorkflowCliArgs(schema, []), /Missing required argument: issue/);
  assert.throws(() => parseWorkflowCliArgs(schema, ["--label"]), /Missing value for --label/);
  assert.throws(() => parseWorkflowCliArgs(schema, ["--ratio", "--mode", "fast"]), /Missing value for --ratio/);
  assert.throws(() => parseWorkflowCliArgs(schema, ["--mode", "slow", "1"]), /Invalid value for enum/);
  assert.throws(() => parseWorkflowCliArgs(schema, ["123", "--tags", "three"]), /Invalid value for enum/);
  assert.throws(() => parseWorkflowCliArgs(schema, ["not-an-integer"]), /Invalid integer/);
  assert.throws(() => parseWorkflowCliArgs(schema, ["1", "--unknown"]), /Unknown option/);
  const help = formatWorkflowCliHelp({ name: "developIssue", version: "1.0.0", headline: "Test", description: "Develop issue", input: schema, output: { type: "string" } });
  assert.match(help, /Issue number/);
  assert.match(help, /--tags <string>.*enum="one","two"/);
  assert.ok(help.includes("  --approve".padEnd(28) + "Trust project resources for this launch"));
  assert.ok(help.includes("  --no-approve".padEnd(28) + "Do not trust project resources for this launch"));
  assert.ok(help.includes("  --".padEnd(28) + "End launcher option parsing; pass later tokens to workflow input"));
});
void test("CLI parser handles delimiter passthrough, negated booleans, and negative numeric positionals", () => {
  const stringSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
  const booleanSchema = { type: "object", properties: { issue: { type: "integer" }, verbose: { type: "boolean", default: true } }, required: ["issue"], additionalProperties: false };
  const integerSchema = { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false };
  const numberSchema = { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false };
  assert.deepEqual(parseWorkflowCliArgs(stringSchema, ["--", "--approve"]), { value: "--approve" });
  assert.equal(parseWorkflowCliArgs(booleanSchema, ["1", "--no-verbose"]).verbose, false);
  assert.deepEqual(parseWorkflowCliArgs(integerSchema, ["-7"]), { value: -7 });
  assert.deepEqual(parseWorkflowCliArgs(numberSchema, ["-1.5"]), { value: -1.5 });
});
void test("CLI script workflow parser derives names and accepts JSON input", () => {
  assert.deepEqual(parseScriptWorkflowCliArgs(["--script", "packs/feature-implementation.js", "--input", '{"specPath":"specs/uart.md"}']), { help: false, scriptPath: "packs/feature-implementation.js", name: "feature-implementation", args: { specPath: "specs/uart.md" } });
  assert.deepEqual(parseScriptWorkflowCliArgs(["--script=workflow.js", "--name=nightly", "--input=null"]), { help: false, scriptPath: "workflow.js", name: "nightly", args: null });
  assert.deepEqual(parseScriptWorkflowCliArgs(["--script", "workflow.js", "--help"]), { help: true });
  assert.throws(() => parseScriptWorkflowCliArgs([]), /Missing required option: --script/);
  assert.throws(() => parseScriptWorkflowCliArgs(["--script", "workflow.js", "--unknown"]), /Unknown option/);
  assert.throws(() => parseScriptWorkflowCliArgs(["--script", "workflow.js", "--name", " "]), /Missing value for --name/);
});
void test("headless CLI runs a file-backed workflow through the existing runtime", () => {
  const paths = fixture();
  writeFileSync(join(paths.cwd, "workflow.js"), "export const meta = { name: 'ignored' };\nreturn args.value;\n");
  const result = runIsolatedCli(paths, 'placeholder: { description: "Placeholder", input: { type: "object", additionalProperties: false }, output: { type: "boolean" }, run: () => true }', ["run", "--script", "workflow.js", "--input", '{"value":"from-file"}']);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '"from-file"\n');
  assert.match(result.stderr, /Workflow: workflow/);
  assert.match(result.stderr, /Run ID: [0-9a-f-]+/);
});

void test("exported launchers are executable and delegate unchanged arguments", async () => {
  registerCliExtension();
  const paths = fixture();
  let output = "";
  let warning = "";
  await withHome(paths.root, () => runCli(["export", "cliEcho"], { cwd: paths.cwd, agentDir: paths.agentDir, stderr: (text) => { warning += text; } }, (text) => { output += text; }));
  const destination = join(paths.root, ".local", "bin", "cli-echo");
  const cliPath = join(process.cwd(), "dist", "src", "cli.js");
  assert.equal(lstatSync(destination).isSymbolicLink(), false);
  const launcher = readFileSync(destination, "utf8");
  assert.match(launcher, /^#!\/usr\/bin\/env node\n/);
  assert.match(launcher, /import\.meta\.resolve\("@piewf\/cli"\)/);
  assert.match(launcher, /@piewf\/cli/);
  assert.match(output, /Exported .*cli-echo/);
  assert.match(warning, /not in PATH/);

  const packageRoot = join(paths.agentDir, "npm", "node_modules", "@piewf/cli");
  const fallbackCli = join(packageRoot, "dist", "src");
  const indexUrl = pathToFileURL(join(process.cwd(), "../core", "dist", "src", "index.js")).href;
  mkdirSync(fallbackCli, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@piewf/cli", version: "4.0.2" }));
  writeFileSync(join(fallbackCli, "cli.js"), `import { registerWorkflowExtension } from ${JSON.stringify(indexUrl)};\nimport { runCli } from ${JSON.stringify(pathToFileURL(cliPath).href)};\nregisterWorkflowExtension({ version: "1.0.0", headline: "Real runner", functions: { cliEcho: { description: "Echo", input: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, output: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, run: (input) => ({ issue: input.issue }) } } });\nexport { runCli };\n`);
  const realOutput = execFileSync(destination, ["7"], { cwd: paths.cwd, env: { ...process.env, HOME: paths.root, PI_CODING_AGENT_DIR: paths.agentDir, PI_OFFLINE: "1" }, encoding: "utf8" });
  assert.equal(realOutput, '{"issue":7}\n');
});

void test("export refuses existing files and replaces them only with --force", async () => {
  registerCliExtension();
  const paths = fixture();
  const destination = join(paths.root, "bin", "cli-echo");
  mkdirSync(join(paths.root, "bin"), { recursive: true });
  writeFileSync(destination, "keep me\n");
  let error = "";
  assert.equal(await runCli(["export", "cliEcho", "--output", destination], { cwd: paths.cwd, agentDir: paths.agentDir, stderr: (text) => { error += text; } }), 1);
  assert.equal(readFileSync(destination, "utf8"), "keep me\n");
  assert.match(error, /use --force/);
  registerCliExtension();
  assert.equal(await runCli(["export", "cliEcho", "--output", destination, "--force"], { cwd: paths.cwd, agentDir: paths.agentDir }, () => {}), 0);
  assert.match(readFileSync(destination, "utf8"), /^#!\/usr\/bin\/env node\n/);
  registerCliExtension();

  const target = join(paths.root, "bin", "target");
  const link = join(paths.root, "bin", "cli-link");
  writeFileSync(target, "keep target\n");
  symlinkSync(target, link);
  assert.equal(await runCli(["export", "cliEcho", "--output", link], { cwd: paths.cwd, agentDir: paths.agentDir, stderr: (text) => { error += text; } }), 1);
  assert.equal(lstatSync(link).isSymbolicLink(), true);
  assert.equal(readFileSync(target, "utf8"), "keep target\n");
  registerCliExtension();
  assert.equal(await runCli(["export", "cliEcho", "--output", link, "--force"], { cwd: paths.cwd, agentDir: paths.agentDir }, () => {}), 0);
  assert.equal(lstatSync(link).isSymbolicLink(), false);
  assert.equal(readFileSync(target, "utf8"), "keep target\n");
  const directory = join(paths.root, "bin", "destination-directory");
  mkdirSync(directory);
  registerCliExtension();
  assert.equal(await runCli(["export", "cliEcho", "--output", directory, "--force"], { cwd: paths.cwd, agentDir: paths.agentDir, stderr: () => {} }), 1);
  assert.equal(lstatSync(directory).isDirectory(), true);
});
void test("export bundle forwards explicit trust override", async () => {
  registerCliExtension();
  const paths = fixture();
  writeFileSync(join(paths.cwd, ".pi", "settings.json"), "{}");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "reviewer.md"), "---\nmodel: openai/gpt:medium\n---\nReview the result");
  const destination = join(paths.root, "bundle");
  assert.equal(await runCli(["export", "cliEcho", "--bundle", "--approve", "--output", destination, "--role", "reviewer"], { cwd: paths.cwd, agentDir: paths.agentDir, stderr: () => {} }, () => {}), 0);
  assert.deepEqual(readCliTestManifest(join(destination, "manifest.json")).requirements.roles, ["reviewer"]);
});
void test("portable bundle export rejects extensions without source provenance", () => {
  const paths = fixture();
  const result = runIsolatedCli(paths, `cliEcho: { description: "Echo", input: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, output: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, run: (input) => ({ issue: input.issue }) }`, ["bundle", "cliEcho", "--output", join(paths.root, "bundle")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not exportable; add `source: import\.meta\.url`/);
});
void test("portable bundle export writes a self-contained payload and external-runtime launcher", async () => {
  registerCliExtension();
  const paths = fixture();
  const destination = join(paths.root, "bundle");
  let output = "";
  assert.equal(await runCli(["bundle", "cliEcho", "--output", destination], { cwd: paths.cwd, agentDir: paths.agentDir, stderr: () => {} }, (text) => { output += text; } ), 0);
  const manifest = readCliTestManifest(join(destination, "manifest.json"));
  assert.deepEqual({ format: manifest.format, version: manifest.version, command: manifest.command }, { format: "pi-extensible-workflows-bundle", version: 2, command: "cli-echo" });
  assert.equal(manifest.workflow.name, "cliEcho");
  assert.deepEqual(manifest.requirements, { roles: [], aliases: [], tools: [], commands: [], environment: [] });
  assert.notEqual(manifest.runtime.pi, "");
  assert.notEqual(manifest.runtime["@piewf/cli"], "unknown");
  assert.equal(lstatSync(join(destination, "cli-echo")).mode & 0o111, 0o111);
  assert.match(readFileSync(join(destination, "cli-echo"), "utf8"), /payload\/runner\.mjs/);
  assert.match(readFileSync(join(destination, "payload", "workflow.mjs"), "utf8"), /registerWorkflowExtension/);
  assert.match(readFileSync(join(destination, "payload", "runner.mjs"), "utf8"), /@piewf\/cli@/);
  assert.match(output, /Run .* setup/);
  writeFileSync(join(paths.agentDir, "pi-extensible-workflows", "roles", "reviewer.md"), "---\nmodel: openai/gpt:medium\n---\nReview the result");
  registerCliExtension();
  const selectedDestination = join(paths.root, "selected-bundle");
  assert.equal(await runCli(["bundle", "cliEcho", "--output", selectedDestination, "--role", "reviewer", "--command", "git", "--environment", "REVIEW_TOKEN"], { cwd: paths.cwd, agentDir: paths.agentDir, stderr: () => {} }), 0);
  const selectedManifest = readCliTestManifest(join(selectedDestination, "manifest.json"));
  assert.deepEqual(selectedManifest.requirements, { roles: ["reviewer"], aliases: [], tools: [], commands: ["git"], environment: ["REVIEW_TOKEN"] });
  assert.match(readFileSync(join(selectedDestination, "payload", "workflow.mjs"), "utf8"), /roleDirectories/);
  assert.match(readFileSync(join(selectedDestination, "payload", "roles", "reviewer.md"), "utf8"), /Review the result/);
});
void test("CLI validates registered function output schemas", () => {
  const paths = fixture();
  const result = runIsolatedCli(paths, `cliBadOutput: { description: "Return an invalid result", input: { type: "object", additionalProperties: false }, output: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, run: () => ({ issue: "not an integer" }) }`, ["run", "cliBadOutput"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Invalid output from cliBadOutput|invalid output/i);
});

void test("headless CLI reports the run ID when execution fails", () => {
  const paths = fixture();
  const result = runIsolatedCli(paths, `cliFail: { description: "Fail", input: { type: "object", additionalProperties: false }, output: { type: "string" }, run: () => { throw new Error("boom"); } }`, ["run", "cliFail"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Run ID: [0-9a-f-]+/);
});

void test("CLI progress stays on stderr and the final result stays on stdout", async () => {
  registerCliExtension();
  const paths = fixture();
  let stdout = "";
  let stderr = "";
  const exit = await runCli(["run", "cliEcho", "7"], { cwd: paths.cwd, agentDir: paths.agentDir, stderr: (text) => { stderr += text; } }, (text) => { stdout += text; });
  assert.equal(exit, 0);
  assert.equal(stdout, '{"issue":7}\n');
  assert.match(stderr, /Workflow: cliEcho/);
  assert.match(stderr, /Run ID: [0-9a-f-]+/);
  assert.equal(stderr.includes("\u001b["), false);
});
void test("CLI TTY progress repaints and respects terminal width", async () => {
  registerCliExtension();
  const paths = fixture();
  let stdout = "";
  let stderr = "";
  const previousColumns = process.stderr.columns;
  Object.defineProperty(process.stderr, "columns", { configurable: true, value: 20 });
  try {
    assert.equal(await runCli(["run", "cliEcho", "7"], { cwd: paths.cwd, agentDir: paths.agentDir, isTTY: true, stderr: (text) => { stderr += text; } }, (text) => { stdout += text; }), 0);
  } finally {
    Object.defineProperty(process.stderr, "columns", { configurable: true, value: previousColumns });
  }
  assert.equal(stdout, '{"issue":7}\n');
  assert.ok(stderr.includes("\u001b[?25l"));
  assert.ok(stderr.includes("\u001b[1A"));
  assert.match(stderr, /…/);
});
void test("CLI TTY progress disables colors with NO_COLOR", async () => {
  registerCliExtension();
  const paths = fixture();
  let stderr = "";
  const previousNoColor = process.env.NO_COLOR;
  process.env.NO_COLOR = "1";
  try {
    assert.equal(await runCli(["run", "cliEcho", "7"], { cwd: paths.cwd, agentDir: paths.agentDir, isTTY: true, stderr: (text) => { stderr += text; } }, () => {}), 0);
  } finally {
    if (previousNoColor === undefined) delete process.env.NO_COLOR; else process.env.NO_COLOR = previousNoColor;
  }
  assert.match(stderr, /Workflow: cliEcho/);
  assert.equal(stderr.includes("\u001b["), false);
});
void test("CLI TTY progress updates runtime between workflow snapshots", async () => {
  registerCliExtension();
  const paths = fixture();
  let stderr = "";
  assert.equal(await runCli(["run", "cliRuntime"], { cwd: paths.cwd, agentDir: paths.agentDir, isTTY: true, stderr: (text) => { stderr += text; } }, () => {}), 0);
  assert.match(stderr, /\[running\].*runtime=1s/);
});
void test("headless CLI trust overrides are honored without leaking into workflow arguments", () => {
  const paths = fixture();
  const approved = runIsolatedCli(paths, `cliTrust: { description: "Trust override", input: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, output: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, run: (input) => ({ issue: input.issue }) }`, ["run", "--approve", "cliTrust", "7"]);
  assert.equal(approved.status, 0);
  assert.equal(approved.stdout, '{"issue":7}\n');
  const unapproved = runIsolatedCli(paths, `cliTrust: { description: "Trust override", input: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, output: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, run: (input) => ({ issue: input.issue }) }`, ["run", "--no-approve", "cliTrust", "7"]);
  assert.equal(unapproved.status, 0);
  assert.equal(unapproved.stdout, '{"issue":7}\n');
  const conflict = runIsolatedCli(paths, `cliTrust: { description: "Trust override", input: { type: "object", additionalProperties: false }, output: { type: "boolean" }, run: () => true }`, ["run", "--approve", "--no-approve", "cliTrust"]);
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /cannot be combined/);
});
void test("isolated CLI passes post-delimiter trust-like literals to workflows", () => {
  const paths = fixture();
  const result = runIsolatedCli(paths, `cliLiteral: { description: "Echo a literal option", input: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, output: { type: "string" }, run: (input) => input.value }`, ["run", "--approve", "cliLiteral", "--", "--approve"]);
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '"--approve"\n');
});

void test("CLI cancellation aborts the workflow and exits non-zero", () => {
  const paths = fixture();
  const result = runIsolatedCli(paths, `cliCancel: { description: "Wait for cancellation", input: { type: "object", additionalProperties: false }, output: { type: "string" }, run: (_input, context) => new Promise((resolve, reject) => { const cancel = () => reject(new Error("cancel observed")); if (context.run.signal.aborted) cancel(); else context.run.signal.addEventListener("abort", cancel, { once: true }); }) }`, ["run", "cliCancel"], true);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /cancelled/i);
});

void test("headless CLI checkpoints fail explicitly", () => {
  const paths = fixture();
  const result = runIsolatedCli(paths, `cliCheckpoint: { description: "Reach an unsupported checkpoint", input: { type: "object", additionalProperties: false }, output: { type: "boolean" }, run: (_input, context) => context.checkpoint({ name: "approval", prompt: "Approve?", context: null }) }`, ["run", "cliCheckpoint"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Headless CLI checkpoints are unsupported/);
});
void test("headless runtime cleanup runs for non-execution CLI paths", async () => {
  const paths = fixture();
  const options = { cwd: paths.cwd, agentDir: paths.agentDir, stderr: () => {}, write: () => {} };
  registerCliExtension();
  assert.equal(await runCli(["run", "cliEcho", "--help"], options), 0);
  assert.doesNotThrow(() => { registerCliExtension(); });
  assert.equal(await runCli(["run", "cliEcho"], options), 1);
  assert.doesNotThrow(() => { registerCliExtension(); });
  assert.equal(await runCli(["run", "missing"], options), 1);
  assert.doesNotThrow(() => { registerCliExtension(); });
  assert.equal(await runCli(["export", "cliEcho", "--help"], options), 0);
  assert.doesNotThrow(() => { registerCliExtension(); });
  assert.equal(await runCli(["export", "missing"], options), 1);
  assert.doesNotThrow(() => { registerCliExtension(); });
  const destination = join(paths.root, "existing");
  writeFileSync(destination, "keep\n");
  assert.equal(await runCli(["export", "cliEcho", "--output", destination], options), 1);
  assert.doesNotThrow(() => { registerCliExtension(); });
});
void test("doctor cleanup parses a positive age and confirmation flag", () => {
  assert.deepEqual(parseDoctorCleanupArgs(["--older-than-days", "30", "--yes"]), { olderThanDays: 30, yes: true });
  assert.deepEqual(parseDoctorCleanupArgs([]), { olderThanDays: 90, yes: false });
  assert.throws(() => parseDoctorCleanupArgs(["--older-than-days", "0"]), /positive integer/);
  assert.throws(() => parseDoctorCleanupArgs(["--older-than-days", "1.5"]), /positive integer/);
});
void test("doctor diagnoses extension role directories with extension provenance", async () => {
  const paths = fixture();
  const missing = join(paths.root, "missing-roles");
  const empty = join(paths.root, "empty-roles");
  const first = join(paths.root, "first-roles");
  const second = join(paths.root, "second-roles");
  mkdirSync(empty);
  mkdirSync(first);
  mkdirSync(second);
  writeFileSync(join(first, "same.md"), "First role");
  writeFileSync(join(first, "unique.md"), "---\ndisabledAgentResources: {}\n---\nUnique role");
  writeFileSync(join(second, "same.md"), "Second role");
  writeFileSync(join(second, "broken.md"), "---\ndescription: [broken\n---\nBroken");
  registerWorkflowExtension({ version: "1.0.0", headline: "Role package", roleDirectories: [missing, empty, first, pathToFileURL(second)] });
  const report = await doctor({ ...paths, discoverPi: async () => pi() });
  const codes = report.diagnostics.map(({ code }) => code);
  assert.ok(codes.includes("ROLE_DIRECTORY"));
  assert.ok(codes.includes("ROLE_DIRECTORY_EMPTY"));
  assert.ok(codes.includes("ROLE_DUPLICATE"));
  assert.ok(codes.includes("ROLE_FRONTMATTER"));
  assert.ok(report.diagnostics.every(({ message }) => !message.includes("scandir") || message.includes("Role package")));
  assert.equal(report.roles.find(({ name, scope }) => name === "unique" && scope === "extension")?.extension?.headline, "Role package");
  assert.ok(report.diagnostics.some(({ code, source }) => code === "AGENT_RESOURCE_SELECTOR_MIGRATION" && source === join(first, "unique.md")));
  assert.equal(doctorExitCode(report), 1);
  const formatted = formatDoctorReport({ ...report, diagnostics: [] });
  assert.ok(formatted.includes(`Extension "Role package" (1.0.0) role directory "${first}"`));
});
void test("doctor reports regular extension roles overriding bundled starter roles", async () => {
  const paths = fixture();
  const regular = join(paths.root, "regular-roles");
  const starter = join(process.cwd(), "../core/dist/starter/roles");
  mkdirSync(regular);
  writeFileSync(join(regular, "developer.md"), "User developer role");
  resetWorkflowRegistry();
  registerWorkflowExtension({
    version: "1.0.0",
    headline: "User roles",
    modelAliases: Object.fromEntries(["developer", "reviewer", "scout", "oracle", "researcher"].map((name) => [`${name}-model`, { resolve: () => "openai/gpt" }])),
    roleDirectories: [starter, regular],
  });
  try {
    const report = await withHome(paths.root, () => doctor({ ...paths, discoverPi: async () => pi({ activeTools: ["read", "grep", "find", "ls", "bash"] }) }));
    const starterRole = report.roles.find(({ name, scope, path }) => name === "developer" && scope === "extension" && path.startsWith(starter));
    const userRole = report.roles.find(({ name, scope, path }) => name === "developer" && scope === "extension" && path === join(regular, "developer.md"));
    assert.ok(starterRole);
    assert.ok(userRole);
    assert.equal(starterRole.active, false);
    assert.equal(starterRole.overriddenBy, userRole.path);
    assert.equal(userRole.active, true);
    assert.equal(userRole.overrides, starterRole.path);
    assert.equal(report.diagnostics.some(({ code }) => code === "ROLE_DUPLICATE"), false);
  } finally {
    resetWorkflowRegistry();
  }
});
void test("doctor recognizes starter roles from Pi's package installation", async () => {
  const paths = fixture();
  const packageRoot = join(paths.root, "pi-install", "node_modules", "pi-extensible-workflows");
  const starter = join(packageRoot, "dist", "starter", "roles");
  const regular = join(paths.root, "regular-roles");
  mkdirSync(starter, { recursive: true });
  mkdirSync(regular);
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-extensible-workflows" }));
  writeFileSync(join(starter, "developer.md"), "Bundled developer role");
  writeFileSync(join(regular, "developer.md"), "User developer role");
  writeFileSync(join(paths.agentDir, "models.json"), JSON.stringify({ providers: { openai: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", apiKey: "fixture", models: [{ id: "gpt", name: "GPT", input: ["text"], contextWindow: 1_024, maxTokens: 128 }] } } }));
  resetWorkflowRegistry();
  registerWorkflowExtension({ version: "1.0.0", headline: "Pi starter and user roles", roleDirectories: [starter, regular] });
  try {
    const report = await withHome(paths.root, () => doctor({ ...paths, role: "developer", discoverPi: async () => pi() }));
    const starterRole = report.roles.find(({ name, path }) => name === "developer" && path === join(starter, "developer.md"));
    const userRole = report.roles.find(({ name, path }) => name === "developer" && path === join(regular, "developer.md"));
    assert.ok(starterRole);
    assert.ok(userRole);
    assert.equal(starterRole.active, false);
    assert.equal(starterRole.overriddenBy, userRole.path);
    assert.equal(userRole.active, true);
    assert.equal(userRole.overrides, starterRole.path);
    assert.equal(report.roleInspection?.path, userRole.path);
    assert.equal(report.diagnostics.some(({ code }) => code === "ROLE_DUPLICATE" || code === "ROLE_NOT_FOUND"), false);
  } finally {
    resetWorkflowRegistry();
  }
});
void test("portable bundles load method shorthand functions and selected payload resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-payload-"));
  const resource = join(root, "resource.txt");
  writeFileSync(resource, "portable resource\n");
  const destination = join(root, "bundle");
  const workflow = { name: "methodWorkflow", version: "1.0.0", headline: "Bundle", description: "Bundle method", input: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false }, output: { type: "integer" } };
  const source = writeCliTestExtensionSource(join(root, "method-extension.mjs"), workflow, "async run(input) { return input.value; }");
  const manifest = await writePortableWorkflowBundle({ destination, command: "method-workflow", workflow, source, aliasTargets: { fast: "openai/gpt" }, resources: { static: [resource] }, piVersion: ">=0.80.9 <0.81.0", engineVersion: ">=5.0.0 <6.0.0" });
  assert.match(manifest.runtime.pi, /^>=/);
  assert.deepEqual(manifest.aliasTargets, { fast: "openai/gpt" });
  assert.deepEqual(manifest.payload?.static, ["resource.txt"]);
  assert.equal(readFileSync(join(destination, "payload", "resources", "resource.txt"), "utf8"), "portable resource\n");
  let registered: CliTestBundleExtension | undefined;
  const imported: unknown = await import(`${pathToFileURL(join(destination, "payload", "workflow.mjs")).href}?test=${String(Date.now())}`);
  if (!isCliTestBundleModule(imported)) throw new Error("Invalid bundle module");
  await imported.register((extension: unknown) => {
    if (!isCliTestBundleExtension(extension)) throw new Error("Invalid bundle extension");
    registered = extension;
  });
  const method = registered?.functions?.methodWorkflow;
  assert.ok(method);
  assert.equal(await method.run({ value: 7 }), 7);
});
void test("portable bundles name dependency packages and entry points by their payload paths", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-dependencies-"));
  const dependency = join(root, "scoped-source");
  mkdirSync(dependency);
  writeFileSync(join(dependency, "package.json"), JSON.stringify({ name: "@scope/example" }));
  writeFileSync(join(dependency, "index.js"), "export const dependency = true;\n");
  const entryPoint = join(root, "entry-point.mjs");
  writeFileSync(entryPoint, "export const entryPoint = true;\n");
  const destination = join(root, "bundle");
  const workflow = { name: "dependencyWorkflow", version: "1.0.0", headline: "Bundle", description: "Bundle dependencies", input: { type: "object", additionalProperties: false }, output: { type: "boolean" } };
  const source = writeCliTestExtensionSource(join(root, "dependency-extension.mjs"), workflow, "async run() { return true; }");
  const manifest = await writePortableWorkflowBundle({ destination, command: "dependency-workflow", workflow, source, resources: { dependencies: [dependency, entryPoint] }, piVersion: ">=0.80.9 <0.81.0", engineVersion: ">=5.0.0 <6.0.0" });
  assert.deepEqual(manifest.payload?.dependencies, ["@scope/example", "entry-point.mjs"]);
  assert.equal(readFileSync(join(destination, "payload", "node_modules", "@scope", "example", "package.json"), "utf8"), JSON.stringify({ name: "@scope/example" }));
  assert.equal(readFileSync(join(destination, "payload", "node_modules", "@scope", "example", "index.js"), "utf8"), "export const dependency = true;\n");
  assert.equal(readFileSync(join(destination, "payload", "node_modules", "entry-point.mjs"), "utf8"), "export const entryPoint = true;\n");
});
void test("portable bundle setup resolves an external runtime, launches, and fails closed on requirements", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-e2e-"));
  const agentDir = join(root, "agent");
  const piRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(agentDir, "npm", "node_modules", "@piewf"), { recursive: true });
  mkdirSync(join(piRoot, "dist", "core", "tools"), { recursive: true });
  symlinkSync(process.cwd(), join(agentDir, "npm", "node_modules", "@piewf/cli"));
  symlinkSync(join(process.cwd(), "../../node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"), join(piRoot, "dist", "index.js"));
  symlinkSync(join(process.cwd(), "../../node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "tools", "index.js"), join(piRoot, "dist", "core", "tools", "index.js"));
  writeFileSync(join(piRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.80.9" }));
  const piExecutable = join(piRoot, "dist", "pi");
  writeFileSync(piExecutable, "#!/usr/bin/env node\nif (process.argv[2] === \"--version\") console.log(\"0.82.0\");\n", { mode: 0o755 });
  chmodSync(piExecutable, 0o755);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:@piewf/cli"] }));
  const workflow = { name: "e2e", version: "1.0.0", headline: "Bundle", description: "Bundle e2e", input: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false }, output: { type: "integer" } };
  const environment = { ...process.env, PATH: `${join(piRoot, "dist")}:${process.env.PATH ?? ""}`, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  const sourcePath = join(root, "e2e-extension.mjs");
  writeFileSync(sourcePath, [
    'import { registerWorkflowExtension } from "pi-extensible-workflows";',
    'import { Type } from "typebox";',
    "const increment = 1;",
    "function normalize(value) { return value + increment - 1; }",
    "export default function extension() {",
    '  registerWorkflowExtension({ version: "1.0.0", headline: "Bundle e2e", functions: { e2e: { description: "Bundle e2e", input: Type.Object({ value: Type.Integer() }, { additionalProperties: false }), output: Type.Integer(), run(input) { return normalize(input.value); } } } });',
    "}",
    "",
  ].join("\n"));
  const source = { module: pathToFileURL(sourcePath).href, export: "default" };
  const create = async (name: string, requirements: Record<string, readonly string[]>, piVersion = ">=0.82.0 <0.83.0", aliasTargets?: Readonly<Record<string, string>>): Promise<string> => { const destination = join(root, name); await writePortableWorkflowBundle({ destination, command: name, workflow, source, dependencies: ["typebox"], requirements, ...(aliasTargets ? { aliasTargets } : {}), piVersion, engineVersion: ">=5.0.0 <6.0.0" }); return destination; };
  const runFailure = (bundle: string): string => { try { execFileSync(bundle, ["setup", "--yes"], { env: environment, encoding: "utf8", stdio: "pipe" }); return ""; } catch (error) { return cliTestErrorOutput(error); } };
  const launchFailure = (bundle: string): string => { try { execFileSync(bundle, ["7"], { env: environment, encoding: "utf8", stdio: "pipe" }); return ""; } catch (error) { return cliTestErrorOutput(error); } };
  const setupResult = (bundle: string): ReturnType<typeof spawnSync> => spawnSync(join(bundle, basename(bundle)), ["setup", "--yes"], { env: environment, encoding: "utf8" });
  const bundle = await create("e2e", { roles: [], aliases: [], tools: [], commands: [], environment: [] });
  assert.equal(readCliTestManifest(join(bundle, "manifest.json")).version, 2);
  execFileSync(join(bundle, "e2e"), ["setup", "--yes"], { env: environment, encoding: "utf8" });
  assert.ok(existsSync(join(bundle, "bundle-state.json")));
  assert.equal(execFileSync(join(bundle, "e2e"), ["7"], { env: environment, encoding: "utf8" }).trim(), "7");
  // Hand-written version 1 fixture (stringified run, no bundled extension) on the current launcher scaffolding.
  const v1Bundle = await create("v1-e2e", { roles: [], aliases: [], tools: [], commands: [], environment: [] });
  rmSync(join(v1Bundle, "payload", "extension.mjs"));
  rmSync(join(v1Bundle, "payload", "node_modules"), { recursive: true });
  writeFileSync(join(v1Bundle, "manifest.json"), JSON.stringify({ format: "pi-extensible-workflows-bundle", version: 1, command: "v1-e2e", workflow, runtime: { pi: ">=0.82.0 <0.83.0", "@piewf/cli": ">=5.0.0 <6.0.0" }, requirements: { roles: [], aliases: [], tools: [], commands: [], environment: [] } }, null, 2));
  writeFileSync(join(v1Bundle, "payload", "workflow.mjs"), [
    "const run = async function run(input) { return input.value; };",
    "export async function register(registerWorkflowExtension) {",
    `  registerWorkflowExtension({ version: "1.0.0", headline: "Portable workflow bundle", functions: { e2e: { description: ${JSON.stringify(workflow.description)}, input: ${JSON.stringify(workflow.input)}, output: ${JSON.stringify(workflow.output)}, run } } });`,
    "}",
    "",
  ].join("\n"));
  execFileSync(join(v1Bundle, "v1-e2e"), ["setup", "--yes"], { env: environment, encoding: "utf8" });
  assert.equal(readCliTestBundleState(join(v1Bundle, "bundle-state.json")).version, 1);
  assert.equal(execFileSync(join(v1Bundle, "v1-e2e"), ["7"], { env: environment, encoding: "utf8" }).trim(), "7");
  const statePath = join(bundle, "bundle-state.json");
  const state = readCliTestBundleState(statePath);
  state.engine = "0.0.0";
  writeFileSync(statePath, JSON.stringify(state));
  assert.match(launchFailure(join(bundle, "e2e")), /Bundle setup is missing or stale/);
  const piMismatch = await create("pi-mismatch", { roles: [], aliases: [], tools: [], commands: [], environment: [] }, ">=0.81.0 <0.82.0");
  assert.match(launchFailure(join(piMismatch, "pi-mismatch")), /Bundle requires Pi >=0\.81\.0 <0\.82\.0; found 0\.82\.0/);
  const builtinTools = await create("builtin-tools", { roles: [], aliases: [], tools: ["grep", "find", "ls"], commands: [], environment: [] });
  execFileSync(join(builtinTools, "builtin-tools"), ["setup", "--yes"], { env: environment, encoding: "utf8" });
  const skillSource = join(root, "selected-skill");
  mkdirSync(skillSource);
  writeFileSync(join(skillSource, "SKILL.md"), "---\nname: selected-skill\ndescription: Selected bundle skill\n---\nSelected skill instructions");
  const skillBundle = join(root, "skill-bundle");
  await writePortableWorkflowBundle({ destination: skillBundle, command: "skill-bundle", workflow, source, dependencies: ["typebox"], resources: { skills: [skillSource] }, piVersion: ">=0.82.0 <0.83.0", engineVersion: ">=5.0.0 <6.0.0" });
  const skillManifest = readCliTestManifest(join(skillBundle, "manifest.json"));
  assert.deepEqual(skillManifest.payload?.skills, ["selected-skill"]);
  execFileSync(join(skillBundle, "skill-bundle"), ["setup", "--yes"], { env: environment, encoding: "utf8" });
  assert.equal(execFileSync(join(skillBundle, "skill-bundle"), ["7"], { env: environment, encoding: "utf8" }).trim(), "7");
  const missingCommand = await create("missing-command", { roles: [], aliases: [], tools: [], commands: ["bundle-command-that-is-not-installed"], environment: [] });
  assert.match(runFailure(join(missingCommand, "missing-command")), /Missing required external command/);
  const missingAlias = await create("missing-alias", { roles: [], aliases: ["missing-model"], tools: [], commands: [], environment: [] });
  assert.match(runFailure(join(missingAlias, "missing-alias")), /Required model alias is unknown/);
  const missingEnvironment = await create("missing-environment", { roles: [], aliases: [], tools: [], commands: [], environment: ["BUNDLE_REQUIRED_ENV"] });
  const environmentFailure = setupResult(missingEnvironment);
  assert.notEqual(environmentFailure.status, 0);
  assert.match(String(environmentFailure.stderr), /Missing required environment variable: BUNDLE_REQUIRED_ENV/);
  assert.equal(existsSync(join(missingEnvironment, "bundle-state.json")), false);
  const unavailableTool = await create("unavailable-tool", { roles: [], aliases: [], tools: ["not-a-pi-tool"], commands: [], environment: [] });
  const toolFailure = setupResult(unavailableTool);
  assert.notEqual(toolFailure.status, 0);
  assert.match(String(toolFailure.stderr), /Required Pi tool is unavailable: not-a-pi-tool/);
  assert.equal(existsSync(join(unavailableTool, "bundle-state.json")), false);
  writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { unavailable: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", models: [{ id: "offline-model" }] } } }));
  const unavailableAlias = await create("unavailable-alias", { roles: [], aliases: ["offline"], tools: [], commands: [], environment: [] }, ">=0.82.0 <0.83.0", { offline: "unavailable/offline-model" });
  const aliasFailure = setupResult(unavailableAlias);
  assert.notEqual(aliasFailure.status, 0);
  assert.match(String(aliasFailure.stderr), /Required model alias is unavailable: offline -> unavailable\/offline-model/);
  assert.equal(existsSync(join(unavailableAlias, "bundle-state.json")), false);
});
void test("portable bundle setup installs a missing compatible engine and fails closed for install errors or incompatible versions", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-install-"));
  const agentDir = join(root, "agent");
  const piRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(piRoot, "dist", "core", "tools"), { recursive: true });
  symlinkSync(join(process.cwd(), "../../node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"), join(piRoot, "dist", "index.js"));
  symlinkSync(join(process.cwd(), "../../node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "tools", "index.js"), join(piRoot, "dist", "core", "tools", "index.js"));
  writeFileSync(join(piRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.80.9" }));
  const piExecutable = join(piRoot, "dist", "pi");
  writeFileSync(piExecutable, `#!/usr/bin/env node
import { cpSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") console.log("0.82.0");
else if (args[0] !== "install") process.exit(2);
else if (process.env.BUNDLE_INSTALL_MODE === "fail") { console.error("fake install failed"); process.exit(23); }
else {
  const target = join(process.env.PI_CODING_AGENT_DIR, "npm", "node_modules", "@piewf", "cli");
  rmSync(target, { recursive: true, force: true });
  cpSync(process.env.BUNDLE_ENGINE_SOURCE, target, { recursive: true });
  rmSync(join(target, "node_modules"), { recursive: true, force: true }); // fixture builds its own node_modules; drop whatever the engine source copied
  mkdirSync(join(target, "node_modules"), { recursive: true });
  symlinkSync(process.env.BUNDLE_CORE_SOURCE, join(target, "node_modules", "pi-extensible-workflows"));
  mkdirSync(join(target, "node_modules", "@earendil-works"), { recursive: true });
  symlinkSync(process.env.BUNDLE_AGENT_SOURCE, join(target, "node_modules", "@earendil-works", "pi-coding-agent"));
  symlinkSync(process.env.BUNDLE_TYPEBOX_SOURCE, join(target, "node_modules", "typebox"));
  symlinkSync(process.env.BUNDLE_PI_AI_SOURCE, join(target, "node_modules", "@earendil-works", "pi-ai"));
  if (process.env.BUNDLE_INSTALL_MODE === "incompatible") writeFileSync(join(target, "package.json"), JSON.stringify({ name: "@piewf/cli", version: "3.0.0" }));
}` , { mode: 0o755 });
  chmodSync(piExecutable, 0o755);
  const workflow = { name: "install", version: "1.0.0", headline: "Bundle", description: "Bundle install", input: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false }, output: { type: "integer" } };
  const typeboxSource = dirname(dirname(createRequire(import.meta.url).resolve("typebox")));
  const environment = { ...process.env, PATH: `${join(piRoot, "dist")}:${process.env.PATH ?? ""}`, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", BUNDLE_ENGINE_SOURCE: process.cwd(), BUNDLE_CORE_SOURCE: join(process.cwd(), "../core"), BUNDLE_AGENT_SOURCE: join(process.cwd(), "../../node_modules/@earendil-works/pi-coding-agent"), BUNDLE_TYPEBOX_SOURCE: typeboxSource, BUNDLE_PI_AI_SOURCE: join(process.cwd(), "../../node_modules/@earendil-works/pi-ai") };
  const source = writeCliTestExtensionSource(join(root, "install-extension.mjs"), workflow, "async run(input) { return input.value; }");
  const create = async (name: string): Promise<string> => { const destination = join(root, name); await writePortableWorkflowBundle({ destination, command: name, workflow, source, piVersion: ">=0.82.0 <0.83.0", engineVersion: ">=5.0.0 <6.0.0" }); return destination; };
  const runSetup = (bundle: string, mode: string): ReturnType<typeof spawnSync> => spawnSync(join(bundle, basename(bundle)), ["setup", "--yes"], { env: { ...environment, BUNDLE_INSTALL_MODE: mode }, encoding: "utf8" });
  const installed = await create("installed");
  const success = runSetup(installed, "success");
  assert.equal(success.status, 0, String(success.stderr));
  const installedPackage = readCliTestPackageMetadata(join(agentDir, "npm", "node_modules", "@piewf", "cli", "package.json"));
  const packageMetadata = readCliTestPackageMetadata(join(process.cwd(), "package.json"));
   assert.equal(installedPackage.version, packageMetadata.version);
  assert.ok(existsSync(join(installed, "bundle-state.json")));
  assert.equal(execFileSync(join(installed, "installed"), ["7"], { env: environment, encoding: "utf8" }).trim(), "7");
  rmSync(join(agentDir, "npm"), { recursive: true, force: true });
  const failed = await create("failed");
  const failure = runSetup(failed, "fail");
  assert.notEqual(failure.status, 0);
  assert.match(String(failure.stderr), /fake install failed/);
  assert.equal(existsSync(join(failed, "bundle-state.json")), false);
  rmSync(join(agentDir, "npm"), { recursive: true, force: true });
  const incompatible = await create("incompatible");
  const mismatch = runSetup(incompatible, "incompatible");
  assert.notEqual(mismatch.status, 0);
  assert.match(String(mismatch.stderr), /installed an incompatible/);
  assert.equal(existsSync(join(incompatible, "bundle-state.json")), false);
});
void test("portable bundles can load a selected workflow extension with its module state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-extension-"));
  const extension = join(root, "workflow.mjs");
  writeFileSync(extension, `import { registerWorkflowExtension } from "pi-extensible-workflows";\nconst suffix = "!";\nexport default function extension() { registerWorkflowExtension({ version: "1.0.0", headline: "Bundled extension", functions: { extensionSelected: { description: "Selected", input: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, output: { type: "string" }, run(input) { return input.value + suffix; } } } }); }\n`);
  const destination = join(root, "bundle");
  const selectedWorkflow = { name: "selected", version: "1.0.0", headline: "Bundle", description: "Bundle", input: { type: "object" }, output: { type: "string" } };
  const source = writeCliTestExtensionSource(join(root, "selected-source.mjs"), selectedWorkflow, 'run() { return "workflow"; }');
  await writePortableWorkflowBundle({ destination, command: "selected", workflow: selectedWorkflow, source, resources: { extensions: [extension] }, piVersion: ">=0.80.9 <0.81.0", engineVersion: ">=5.0.0 <6.0.0" });
  const registrations: CliTestBundleExtension[] = [];
  const register = (value: unknown): void => {
    if (!isCliTestBundleExtension(value)) throw new Error("Invalid bundle extension");
    registrations.push(value);
  };
  Reflect.set(globalThis, "__pi_bundle_api", { registerWorkflowExtension: register });
  try {
    const imported: unknown = await import(`${pathToFileURL(join(destination, "payload", "workflow.mjs")).href}?extension=${String(Date.now())}`);
    if (!isCliTestBundleModule(imported)) throw new Error("Invalid bundle module");
    await imported.register(register);
  } finally { Reflect.deleteProperty(globalThis, "__pi_bundle_api"); }
  const selected = registrations.find((extension) => extension.functions?.extensionSelected)?.functions?.extensionSelected;
  const workflow = registrations.find((extension) => extension.functions?.selected)?.functions?.selected;
  assert.ok(selected);
  assert.ok(workflow);
  assert.equal(selected.run({ value: "ok" }), "ok!");
  assert.equal(workflow.run({}), "workflow");
});
