import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { doctor, doctorExitCode, formatDoctorReport, type DoctorPiState } from "../src/doctor.js";
import { writePortableWorkflowBundle } from "../src/bundles.js";
import { formatWorkflowCliHelp, parseDoctorCleanupArgs, parseWorkflowCliArgs, runCli } from "../src/cli.js";
import { registerWorkflowExtension, WorkflowRegistry, type JsonValue, type WorkflowExtension } from "pi-extensible-workflows";

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

const cliExtension: WorkflowExtension = {
  version: "1.0.0",
  headline: "CLI test workflows",
  description: "Workflows for CLI acceptance tests",
  functions: {
    cliEcho: {
      description: "Echo a CLI issue",
      input: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false },
      output: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false },
      run: (input) => ({ issue: input.issue as JsonValue }),
    },
    cliRuntime: {
      description: "Runtime progress",
      input: { type: "object", additionalProperties: false },
      output: { type: "boolean" },
      run: async () => { await new Promise<void>((resolve) => setTimeout(resolve, 1_100)); return true; },
    },
  },
};
function registerCliExtension(): void { registerWorkflowExtension(cliExtension); }

function runIsolatedCli(paths: { root: string; cwd: string; agentDir: string }, functionDefinition: string, args: readonly string[], abort = false): { status: number | null; stdout: string; stderr: string } {
  const script = join(paths.root, "isolated-cli.mjs");
  const indexUrl = pathToFileURL(join(process.cwd(), "../core", "dist", "src", "index.js")).href;
  const cliUrl = pathToFileURL(join(process.cwd(), "dist", "src", "cli.js")).href;
  writeFileSync(script, [`import { registerWorkflowExtension } from ${JSON.stringify(indexUrl)};`, `import { runCli } from ${JSON.stringify(cliUrl)};`, `registerWorkflowExtension({ version: "1.0.0", headline: "Isolated CLI", description: "Isolated CLI test", functions: { ${functionDefinition} } });`, "const controller = new AbortController();", abort ? "setImmediate(() => controller.abort());" : "", `const exit = await runCli(${JSON.stringify(args)}, { cwd: ${JSON.stringify(paths.cwd)}, agentDir: ${JSON.stringify(paths.agentDir)}, signal: controller.signal, stderr: (text) => process.stderr.write(text) });`, "process.exitCode = exit;"].join("\n"));
  const result = spawnSync(process.execPath, [script], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000, env: { ...process.env, HOME: paths.root, PI_CODING_AGENT_DIR: paths.agentDir, PI_OFFLINE: "1" } });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

void test("doctor reports role errors, warnings, overrides, and extension failures", async () => {
  const paths = fixture();
  mkdirSync(join(paths.cwd, ".pi", "piworkflows", "roles"), { recursive: true });
  writeFileSync(join(paths.cwd, ".pi", "piworkflows", "roles", "old-project.md"), "Ignored old project role");
  writeFileSync(join(paths.agentDir, "pi-extensible-workflows", "roles", "override.md"), "Global role");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "override.md"), "Project role");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "tool-typo.md"), "---\ntools: [read, cat]\n---\nCheck tools");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "thinking.md"), "---\nthinking: hihg\n---\nThink");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "malformed-model.md"), "---\nmodel: gpt-5\n---\nModel");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "unavailable-model.md"), "---\nmodel: other/model\n---\nModel");
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
  assert.match(formatDoctorReport(report), /Fix: Use a tool listed under Active tools/);
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
  registry.register({ version: "1.0.0", headline: "Model policy", description: "Selects models", modelAliases: { reviewer: { resolve: () => "openai/gpt" } } });
  const report = await withHome(paths.root, () => doctor({ ...paths, registry, discoverPi: async () => pi() }));
  assert.deepEqual(report.modelAliases, [{ name: "reviewer", kind: "dynamic", provenance: "extension: Model policy", version: "1.0.0", headline: "Model policy", extensionDescription: "Selects models" }]);
  assert.match(formatDoctorReport(report), /\[dynamic\] `reviewer` \(extension: Model policy\)/);
});
void test("doctor accepts role files using unshadowed dynamic model aliases without resolving them", async () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-extensible-workflows", "roles", "reviewer.md"), "---\nmodel: policy-model\n---\nReview");
  const registry = new WorkflowRegistry();
  let calls = 0;
  registry.register({ version: "1.0.0", headline: "Model policy", description: "Selects models", modelAliases: { "policy-model": { resolve: () => { calls += 1; return "openai/gpt"; } } } });
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
  registry.register({ version: "1.0.0", headline: "Model policy", description: "Selects models", modelAliases: { "policy-model": { resolve: () => { calls += 1; return "openai/gpt"; } } } });
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

void test("doctor respects untrusted projects and does not mutate fixtures", async () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-extensible-workflows", "roles", "same.md"), "Global");
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "roles", "same.md"), "---\ntools: [cat]\n---\nProject");
  const before = readdirSync(paths.root, { recursive: true }).map(String).sort();
  const report = await withHome(paths.root, () => doctor({ ...paths, discoverPi: async () => pi({ trust: { required: true, trusted: false, source: "saved Pi trust decision" } }) }));
  const after = readdirSync(paths.root, { recursive: true }).map(String).sort();
  assert.deepEqual(after, before);
  assert.ok(report.diagnostics.some(({ code }) => code === "PROJECT_UNTRUSTED"));
  assert.ok(!report.diagnostics.some(({ code }) => code === "ROLE_TOOL_INACTIVE"));
  assert.equal(report.roles.find((role) => role.scope === "project")?.active, false);
  assert.equal(doctorExitCode(report), 0);
});
void test("doctor reports effective resource exclusions and unmatched selectors", async () => {
  const paths = fixture();
  const globalSettings = join(paths.agentDir, "pi-extensible-workflows", "settings.json");
  const globalExtension = join(paths.agentDir, "extensions", "interactive.ts");
  const projectExtension = join(paths.cwd, ".pi", "project.ts");
  mkdirSync(join(paths.agentDir, "extensions"), { recursive: true });
  writeFileSync(globalSettings, JSON.stringify({ disabledAgentResources: { skills: ["global-skill", "missing-skill"], extensions: [globalExtension] } }));
  writeFileSync(join(paths.cwd, ".pi", "pi-extensible-workflows", "settings.json"), JSON.stringify({ disabledAgentResources: { skills: ["project-skill"], extensions: ["../project.ts"] } }));
  const report = await withHome(paths.root, () => doctor({ ...paths, settingsPath: globalSettings, discoverPi: async () => pi({ extensions: [globalExtension, projectExtension], skills: ["global-skill", "project-skill"] }) }));
  assert.deepEqual(report.resourcePolicy.effective.skills, ["project-skill"]);
  assert.deepEqual(report.resourcePolicy.effective.extensions, [projectExtension]);
  assert.deepEqual(report.resourcePolicy.unmatchedSkills, []);
  assert.deepEqual(report.resourcePolicy.unmatchedExtensions, []);
  assert.equal(report.diagnostics.filter(({ code }) => code === "AGENT_RESOURCE_UNMATCHED").length, 0);
  assert.match(formatDoctorReport(report), /Effective skills: project-skill/);
});
void test("doctor attributes unmatched replacement selectors to the project settings field", async () => {
  const paths = fixture();
  const globalSettings = join(paths.agentDir, "pi-extensible-workflows", "settings.json");
  const projectSettings = join(paths.cwd, ".pi", "pi-extensible-workflows", "settings.json");
  writeFileSync(globalSettings, JSON.stringify({ disabledAgentResources: { skills: ["same-selector"] } }));
  writeFileSync(projectSettings, JSON.stringify({ disabledAgentResources: { skills: ["same-selector"] } }));
  const report = await withHome(paths.root, () => doctor({ ...paths, settingsPath: globalSettings, discoverPi: async () => pi({ skills: [] }) }));
  assert.equal(report.settingsSources.disabledAgentResources, projectSettings);
  assert.deepEqual(report.diagnostics.filter(({ code }) => code === "AGENT_RESOURCE_UNMATCHED").map(({ source }) => source), [`${projectSettings}.disabledAgentResources.skills`]);
});
void test("doctor reports matched glob exclusions and unmatched exceptions", async () => {
  const paths = fixture();
  const globalSettings = join(paths.agentDir, "pi-extensible-workflows", "settings.json");
  const globalExtension = join(paths.agentDir, "extensions", "interactive.ts");
  const projectExtension = join(paths.cwd, ".pi", "project.ts");
  mkdirSync(join(paths.agentDir, "extensions"), { recursive: true });
  writeFileSync(globalSettings, JSON.stringify({ disabledAgentResources: { skills: ["*", "!my-project-*", "!missing-*"], extensions: ["**/*", `!${projectExtension}`, `!${join(paths.root, "missing.ts")}`] } }));
  const report = await withHome(paths.root, () => doctor({ ...paths, settingsPath: globalSettings, discoverPi: async () => pi({ extensions: [globalExtension, projectExtension], skills: ["my-project-skill", "other-skill"] }) }));
  assert.deepEqual(report.resourcePolicy.excludedSkills, ["other-skill"]);
  assert.deepEqual(report.resourcePolicy.excludedExtensions, [globalExtension]);
  assert.deepEqual(report.resourcePolicy.unmatchedSkills, ["!missing-*"]);
  assert.deepEqual(report.resourcePolicy.unmatchedExtensions, [`!${join(paths.root, "missing.ts")}`]);
  assert.match(formatDoctorReport(report), /Excluded skills: other-skill/);
});
void test("doctor excludes workflow_catalog from active capabilities and output", async () => {
  const paths = fixture();
  const report = await withHome(paths.root, () => doctor({ ...paths, activeTools: ["read", "workflow", "workflow_respond", "workflow_catalog"], discoverPi: async () => pi({ activeTools: ["read", "workflow", "workflow_respond", "workflow_catalog"] }) }));
  assert.deepEqual(report.activeTools, ["read"]);
  assert.doesNotMatch(formatDoctorReport(report), /workflow_catalog/);
});
void test("package bin and CLI expose doctor and inspector commands", async () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { bin?: Record<string, string> };
  assert.equal(pkg.bin?.piewf, "./dist/src/cli.js");
  const paths = fixture();
  let output = "";
  const exit = await withHome(paths.root, () => runCli(["doctor"], { ...paths, discoverPi: async () => pi({ knownModels: [], availableModels: [] }) }, (text) => { output += text; }));
  assert.equal(exit, 0);
  for (const heading of ["## Environment", "## Trust/resources", "## Active tools", "## Roles", "## Reusable functions", "## Diagnostics", "## Summary"]) assert.match(output, new RegExp(heading));
  let inspected: string | undefined;
  assert.equal(await runCli(["inspect", "session-a"], { inspect: async (sessionId) => { inspected = sessionId; } }), 0);
  assert.equal(inspected, "session-a");
  output = "";
  assert.equal(await runCli([], {}, (text) => { output += text; }), 1);
  assert.equal(output, "Usage: piewf doctor | inspect [session-id] [--json|--summary] [--failed] | transcript <session-file> | bundle <workflow-name> [--name <command>] [--output <path>] [--force] | run <workflow-name> [workflow arguments] | export <workflow-name> [--name <command>] [--output <path>] [--force] [--bundle]\n");
  const bin = join(paths.root, "bin", "piewf");
  mkdirSync(join(paths.root, "bin"), { recursive: true });
  symlinkSync(join(process.cwd(), "dist", "src", "cli.js"), bin);
  const linkedOutput = execFileSync(bin, ["doctor"], { cwd: paths.cwd, env: { ...process.env, HOME: paths.root }, encoding: "utf8" });
  assert.match(linkedOutput, /^# pi-extensible-workflows doctor/m);
  assert.equal(existsSync(join(paths.root, ".pi", "agent", "auth.json")), false);
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
  const help = formatWorkflowCliHelp({ name: "developIssue", version: "1.0.0", headline: "Test", extensionDescription: "Test", description: "Develop issue", input: schema, output: { type: "string" } });
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
  assert.match(launcher, /import\.meta\.resolve\("pi-extensible-workflows-cli"\)/);
  assert.match(launcher, /pi-extensible-workflows-cli/);
  assert.match(output, /Exported .*cli-echo/);
  assert.match(warning, /not in PATH/);

  const packageRoot = join(paths.agentDir, "npm", "node_modules", "pi-extensible-workflows-cli");
  const fallbackCli = join(packageRoot, "dist", "src");
  const indexUrl = pathToFileURL(join(process.cwd(), "../core", "dist", "src", "index.js")).href;
  mkdirSync(fallbackCli, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-extensible-workflows-cli", version: "3.4.2" }));
  writeFileSync(join(fallbackCli, "cli.js"), `import { registerWorkflowExtension } from ${JSON.stringify(indexUrl)};\nimport { runCli } from ${JSON.stringify(pathToFileURL(cliPath).href)};\nregisterWorkflowExtension({ version: "1.0.0", headline: "Real runner", description: "Real runner", functions: { cliEcho: { description: "Echo", input: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, output: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, run: (input) => ({ issue: input.issue }) } } });\nexport { runCli };\n`);
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
void test("portable bundle export writes a self-contained payload and external-runtime launcher", async () => {
  registerCliExtension();
  const paths = fixture();
  const destination = join(paths.root, "bundle");
  let output = "";
  assert.equal(await runCli(["bundle", "cliEcho", "--output", destination], { cwd: paths.cwd, agentDir: paths.agentDir, stderr: () => {} }, (text) => { output += text; } ), 0);
  const manifest = JSON.parse(readFileSync(join(destination, "manifest.json"), "utf8")) as { format: string; version: number; command: string; workflow: { name: string; input: unknown; output: unknown }; runtime: { pi: string; "pi-extensible-workflows-cli": string }; requirements: { commands: string[]; environment: string[] } };
  assert.deepEqual({ format: manifest.format, version: manifest.version, command: manifest.command }, { format: "pi-extensible-workflows-bundle", version: 1, command: "cli-echo" });
  assert.equal(manifest.workflow.name, "cliEcho");
  assert.deepEqual(manifest.requirements, { roles: [], aliases: [], tools: [], commands: [], environment: [] });
  assert.notEqual(manifest.runtime.pi, "");
  assert.notEqual(manifest.runtime["pi-extensible-workflows-cli"], "unknown");
  assert.equal(lstatSync(join(destination, "cli-echo")).mode & 0o111, 0o111);
  assert.match(readFileSync(join(destination, "cli-echo"), "utf8"), /payload\/runner\.mjs/);
  assert.match(readFileSync(join(destination, "payload", "workflow.mjs"), "utf8"), /registerWorkflowExtension/);
  assert.match(readFileSync(join(destination, "payload", "runner.mjs"), "utf8"), /pi-extensible-workflows-cli@/);
  assert.match(output, /Run .* setup/);
  writeFileSync(join(paths.agentDir, "pi-extensible-workflows", "roles", "reviewer.md"), "---\nmodel: openai/gpt\n---\nReview the result");
  registerCliExtension();
  const selectedDestination = join(paths.root, "selected-bundle");
  assert.equal(await runCli(["bundle", "cliEcho", "--output", selectedDestination, "--role", "reviewer", "--command", "git", "--environment", "REVIEW_TOKEN"], { cwd: paths.cwd, agentDir: paths.agentDir, stderr: () => {} }), 0);
  const selectedManifest = JSON.parse(readFileSync(join(selectedDestination, "manifest.json"), "utf8")) as { requirements: { roles: string[]; commands: string[]; environment: string[] } };
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
  writeFileSync(join(first, "unique.md"), "Unique role");
  writeFileSync(join(second, "same.md"), "Second role");
  writeFileSync(join(second, "broken.md"), "---\ndescription: [broken\n---\nBroken");
  registerWorkflowExtension({ version: "1.0.0", headline: "Role package", description: "Role package for doctor", roleDirectories: [missing, empty, first, pathToFileURL(second)] });
  const report = await doctor({ ...paths, discoverPi: async () => pi() });
  const codes = report.diagnostics.map(({ code }) => code);
  assert.ok(codes.includes("ROLE_DIRECTORY"));
  assert.ok(codes.includes("ROLE_DIRECTORY_EMPTY"));
  assert.ok(codes.includes("ROLE_DUPLICATE"));
  assert.ok(codes.includes("ROLE_FRONTMATTER"));
  assert.ok(report.diagnostics.every(({ message }) => !message.includes("scandir") || message.includes("Role package")));
  assert.equal(report.roles.find(({ name, scope }) => name === "unique" && scope === "extension")?.extension?.headline, "Role package");
  assert.equal(doctorExitCode(report), 1);
  const formatted = formatDoctorReport({ ...report, diagnostics: [] });
  assert.ok(formatted.includes(`Extension "Role package" (1.0.0) role directory "${first}"`));
});
void test("portable bundles load method shorthand functions and selected payload resources", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-payload-"));
  const resource = join(root, "resource.txt");
  writeFileSync(resource, "portable resource\n");
  const destination = join(root, "bundle");
  const workflow = { name: "methodWorkflow", version: "1.0.0", headline: "Bundle", extensionDescription: "Bundle", description: "Bundle method", input: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false }, output: { type: "integer" } };
  const manifest = writePortableWorkflowBundle({ destination, command: "method-workflow", workflow, functionSource: "async run(input) { return input.value; }", aliasTargets: { fast: "openai/gpt" }, resources: { static: [resource] }, piVersion: ">=0.80.9 <0.81.0", engineVersion: ">=3.4.0 <3.5.0" });
  assert.match(manifest.runtime.pi, /^>=/);
  assert.deepEqual(manifest.aliasTargets, { fast: "openai/gpt" });
  assert.deepEqual(manifest.payload?.static, ["resource.txt"]);
  assert.equal(readFileSync(join(destination, "payload", "resources", "resource.txt"), "utf8"), "portable resource\n");
  type BundleFunction = { run: (input: Record<string, unknown>) => unknown };
  type BundleExtension = { functions?: Record<string, BundleFunction> };
  let registered: BundleExtension | undefined;
  const module = await import(`${pathToFileURL(join(destination, "payload", "workflow.mjs")).href}?test=${String(Date.now())}`) as { register: (register: (extension: unknown) => void) => Promise<void> };
  await module.register((extension: unknown) => { registered = extension as BundleExtension; });
  const method = registered?.functions?.methodWorkflow;
  assert.ok(method);
  assert.equal(await method.run({ value: 7 }), 7);
});
void test("portable bundle setup resolves an external runtime, launches, and fails closed on requirements", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-e2e-"));
  const agentDir = join(root, "agent");
  const piRoot = join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  mkdirSync(join(agentDir, "npm", "node_modules"), { recursive: true });
  mkdirSync(join(piRoot, "dist", "core", "tools"), { recursive: true });
  symlinkSync(process.cwd(), join(agentDir, "npm", "node_modules", "pi-extensible-workflows-cli"));
  symlinkSync(join(process.cwd(), "../../node_modules", "@earendil-works", "pi-coding-agent", "dist", "index.js"), join(piRoot, "dist", "index.js"));
  symlinkSync(join(process.cwd(), "../../node_modules", "@earendil-works", "pi-coding-agent", "dist", "core", "tools", "index.js"), join(piRoot, "dist", "core", "tools", "index.js"));
  writeFileSync(join(piRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.80.9" }));
  const piExecutable = join(piRoot, "dist", "pi");
  writeFileSync(piExecutable, "#!/usr/bin/env node\nif (process.argv[2] === \"--version\") console.log(\"0.82.0\");\n", { mode: 0o755 });
  chmodSync(piExecutable, 0o755);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: ["npm:pi-extensible-workflows-cli"] }));
  const workflow = { name: "e2e", version: "1.0.0", headline: "Bundle", extensionDescription: "Bundle", description: "Bundle e2e", input: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false }, output: { type: "integer" } };
  const environment = { ...process.env, PATH: `${join(piRoot, "dist")}:${process.env.PATH ?? ""}`, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  const create = (name: string, requirements: Record<string, readonly string[]>) => { const destination = join(root, name); writePortableWorkflowBundle({ destination, command: name, workflow, functionSource: "async run(input) { return input.value; }", requirements, piVersion: ">=0.82.0 <0.83.0", engineVersion: ">=3.4.0 <3.5.0" }); return destination; };
  const bundle = create("e2e", { roles: [], aliases: [], tools: [], commands: [], environment: [] });
  execFileSync(join(bundle, "e2e"), ["setup", "--yes"], { env: environment, encoding: "utf8" });
  assert.ok(existsSync(join(bundle, "bundle-state.json")));
  assert.equal(execFileSync(join(bundle, "e2e"), ["7"], { env: environment, encoding: "utf8" }).trim(), "7");
  const builtinTools = create("builtin-tools", { roles: [], aliases: [], tools: ["grep", "find", "ls"], commands: [], environment: [] });
  execFileSync(join(builtinTools, "builtin-tools"), ["setup", "--yes"], { env: environment, encoding: "utf8" });
  const skillSource = join(root, "selected-skill");
  mkdirSync(skillSource);
  writeFileSync(join(skillSource, "SKILL.md"), "---\nname: selected-skill\ndescription: Selected bundle skill\n---\nSelected skill instructions");
  const skillBundle = join(root, "skill-bundle");
  writePortableWorkflowBundle({ destination: skillBundle, command: "skill-bundle", workflow, functionSource: "async run(input) { return input.value; }", resources: { skills: [skillSource] }, piVersion: ">=0.82.0 <0.83.0", engineVersion: ">=3.4.0 <3.5.0" });
  const skillManifest = JSON.parse(readFileSync(join(skillBundle, "manifest.json"), "utf8")) as { payload?: { skills?: string[] } };
  assert.deepEqual(skillManifest.payload?.skills, ["selected-skill"]);
  execFileSync(join(skillBundle, "skill-bundle"), ["setup", "--yes"], { env: environment, encoding: "utf8" });
  assert.equal(execFileSync(join(skillBundle, "skill-bundle"), ["7"], { env: environment, encoding: "utf8" }).trim(), "7");
  const runFailure = (bundle: string): string => { try { execFileSync(bundle, ["setup", "--yes"], { env: environment, encoding: "utf8", stdio: "pipe" }); return ""; } catch (error) { return String((error as { stderr?: unknown }).stderr ?? error); } };
  const missingCommand = create("missing-command", { roles: [], aliases: [], tools: [], commands: ["bundle-command-that-is-not-installed"], environment: [] });
  assert.match(runFailure(join(missingCommand, "missing-command")), /Missing required external command/);
  const missingAlias = create("missing-alias", { roles: [], aliases: ["missing-model"], tools: [], commands: [], environment: [] });
  assert.match(runFailure(join(missingAlias, "missing-alias")), /Required model alias is unknown/);
});
void test("portable bundles can load a selected workflow extension with its module state", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-extension-"));
  const extension = join(root, "workflow.mjs");
  writeFileSync(extension, `import { registerWorkflowExtension } from "pi-extensible-workflows";\nconst suffix = "!";\nexport default function extension() { registerWorkflowExtension({ version: "1.0.0", headline: "Bundled extension", description: "Bundled extension", functions: { extensionSelected: { description: "Selected", input: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, output: { type: "string" }, run(input) { return input.value + suffix; } } } }); }\n`);
  const destination = join(root, "bundle");
  writePortableWorkflowBundle({ destination, command: "selected", workflow: { name: "selected", version: "1.0.0", headline: "Bundle", extensionDescription: "Bundle", description: "Bundle", input: { type: "object" }, output: { type: "string" } }, functionSource: '() => "workflow"', resources: { extensions: [extension] }, piVersion: ">=0.80.9 <0.81.0", engineVersion: ">=3.4.0 <3.5.0" });
  type BundleFunction = { run: (input: Record<string, unknown>) => unknown };
  type BundleExtension = { functions?: Record<string, BundleFunction> };
  const registrations: BundleExtension[] = [];
  const globals = globalThis as typeof globalThis & { __pi_bundle_api?: { registerWorkflowExtension: (extension: unknown) => void } };
  const register = (value: unknown): void => { registrations.push(value as BundleExtension); };
  globals.__pi_bundle_api = { registerWorkflowExtension: register };
  try {
    const module = await import(`${pathToFileURL(join(destination, "payload", "workflow.mjs")).href}?extension=${String(Date.now())}`) as { register: (register: (extension: unknown) => void) => Promise<void> };
    await module.register(register);
  } finally { delete globals.__pi_bundle_api; }
  const selected = registrations.find((extension) => extension.functions?.extensionSelected)?.functions?.extensionSelected;
  const workflow = registrations.find((extension) => extension.functions?.selected)?.functions?.selected;
  assert.ok(selected);
  assert.ok(workflow);
  assert.equal(selected.run({ value: "ok" }), "ok!");
  assert.equal(workflow.run({}), "workflow");
});
