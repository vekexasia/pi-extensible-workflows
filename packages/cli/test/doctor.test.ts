import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";

import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";





import { doctor, doctorExitCode, formatDoctorReport, type DoctorPiState } from "../src/doctor.js";
import { writePortableWorkflowBundle } from "../src/bundles.js";
import { formatWorkflowCliHelp, parseDoctorCleanupArgs, parseScriptWorkflowCliArgs, parseWorkflowCliArgs, runCli } from "../src/cli.js";
import { WorkflowRegistry } from "pi-extensible-workflows";

import { isCliTestBundleExtension, isCliTestBundleModule, readCliTestPackageMetadata, writeCliTestExtensionSource, type CliTestBundleExtension } from "./support.js";
import { registerCliExtension } from "./fixtures/cli-workflow-extension.js";

function pi(overrides: Partial<DoctorPiState> = {}): DoctorPiState {
  return {
    trust: { required: true, trusted: true, source: "test trust" },
    activeTools: ["read", "grep", "bash", "find", "ls"],
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
void test("doctor reports extension validator diagnostics", async () => {
  const paths = fixture();
  writeFileSync(paths.settingsPath, JSON.stringify({ extensionSettings: { acme: { enabled: "yes" } } }));
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Acme settings", validateSettings: (_settings, context) => { if (context.source === "global") throw new Error("acme.enabled must be a boolean"); } });
  const report = await withHome(paths.root, () => doctor({ ...paths, registry, discoverPi: async () => pi() }));
  const invalid = report.diagnostics.find(({ code }) => code === "SETTINGS_INVALID");
  assert.ok(invalid);
  assert.equal(invalid.source, `${paths.settingsPath}.extensionSettings`);
  assert.match(invalid.message, /Acme settings/);
  assert.match(invalid.message, /global/);
  assert.match(invalid.message, /acme\.enabled/);
  assert.equal(doctorExitCode(report), 1);
});

void test("doctor rejects invalid settings introduced by agent preparation", async (t) => {
  const paths = fixture();
  t.after(() => { rmSync(paths.root, { recursive: true, force: true }); });
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Guard", validateSettings: (settings) => {
    if (settings.guard !== undefined) throw new Error("guard.invalid is forbidden");
  }, agentPreparationHooks: { invalid: { prepare(configuration) { configuration.settings = { ...configuration.settings, guard: { invalid: true } }; } } } });
  const report = await withHome(paths.root, () => doctor({ ...paths, registry, agentOptions: {}, discoverPi: async () => pi({ model: { provider: "openai-codex", model: "gpt-5.6-sol" }, knownModels: ["openai-codex/gpt-5.6-sol"], availableModels: ["openai-codex/gpt-5.6-sol"] }) }));
  assert.equal(report.agentInspection, undefined);
  assert.ok(report.diagnostics.some(({ code, message }) => code === "AGENT_INSPECTION" && /guard.invalid is forbidden/.test(message)));
  assert.equal(doctorExitCode(report), 1);
});

void test("doctor keeps unknown JSON options out of internal execution controls", async (t) => {
  const paths = fixture();
  t.after(() => { rmSync(paths.root, { recursive: true, force: true }); });
  const agentOptions = { projectTrusted: false, capabilities: { tools: [], skills: [], extensions: [] }, configuration: { invalid: true } };
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Observe", agentPreparationHooks: { observe: { prepare(_configuration, context) {
    assert.equal(context.projectTrusted, true);
    assert.deepEqual(context.options, agentOptions);
  } } } });
  const report = await withHome(paths.root, () => doctor({ ...paths, registry, agentOptions, discoverPi: async () => pi({ model: { provider: "openai-codex", model: "gpt-5.6-sol" }, knownModels: ["openai-codex/gpt-5.6-sol"], availableModels: ["openai-codex/gpt-5.6-sol"] }) }));
  assert.deepEqual(report.diagnostics, []);
  assert.ok(report.agentInspection);
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
void test("doctor reports registered functions without model availability probes", async () => {
  const paths = fixture();
  const functions: DoctorPiState["functions"] = { unavailable: { description: "unavailable model", input: { type: "object" }, output: { type: "string" }, run: () => "ok" } };
  const report = await withHome(paths.root, () => doctor({ ...paths, discoverPi: async () => pi({ availableModels: [], functions }) }));
  assert.equal(report.functions.find(({ name }) => name === "unavailable")?.valid, true);
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
  for (const heading of ["## Environment", "## Trust/resources", "## Pi active tools", "## Pi active extensions", "## Pi active skills", "## Workflow agent resource selectors", "## Reusable functions", "## Diagnostics", "## Summary"]) assert.match(output, new RegExp(heading));
  assert.doesNotMatch(output, /## Role inspection/);
  output = "";
  assert.equal(await withHome(paths.root, () => runCli(["doctor", "--json"], { ...paths, discoverPi: async () => pi({ knownModels: [], availableModels: [] }) }, (text) => { output += text; })), 0);
  const jsonReport = JSON.parse(output) as { cwd: string; activeTools: readonly string[]; diagnostics: readonly unknown[] };
  assert.equal(jsonReport.cwd, paths.cwd);
  assert.deepEqual(jsonReport.activeTools, ["bash", "find", "grep", "ls", "read"]);
  assert.ok(Array.isArray(jsonReport.diagnostics));
  let inspected: string | undefined;
  assert.equal(await runCli(["inspect", "session-a"], { inspect: async (sessionId) => { inspected = sessionId; } }), 0);
  assert.equal(inspected, "session-a");
  output = "";
  assert.equal(await runCli([], {}, (text) => { output += text; }), 1);
  assert.equal(output, "Usage: piewf doctor [--agent-options <json>] [--prompt <text>] [--json] | inspect [session-id] [--json|--summary] [--failed] | transcript <session-file> | share <run-id> | bundle <workflow-name> [--name <command>] [--output <path>] [--force] | run <workflow-name> [workflow arguments] | run --script <path> [--name <workflow-name>] [--input <json>] | export <workflow-name> [--name <command>] [--output <path>] [--force] [--bundle]\n");
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
  const help = formatWorkflowCliHelp({ name: "developIssue", version: "1.0.0", headline: "Test", description: "Develop issue", input: schema, output: { type: "string" } });
  assert.match(help, /Issue number/);
  assert.match(help, /--tags <string>.*enum="one","two"/);
  assert.ok(help.includes("  --approve".padEnd(28) + "Trust project resources for this launch"));
  assert.ok(help.includes("  --no-approve".padEnd(28) + "Do not trust project resources for this launch"));
  assert.ok(help.includes("  --".padEnd(28) + "End launcher option parsing; pass later tokens to workflow input"));
});
void test("CLI number arguments reject blanks without changing valid numeric inputs", () => {
  const schema = { type: "object", properties: { value: { type: "number" }, values: { type: "array", items: { type: "number" } } } };
  for (const raw of ["", " ", "\t\n", "NaN", "Infinity", "1e309", "1oops"]) {
    for (const args of [[`--value=${raw}`], ["--value", raw], ["--values", raw]]) {
      assert.throws(() => parseWorkflowCliArgs(schema, args), /Invalid number/, JSON.stringify(args));
    }
    assert.throws(() => parseWorkflowCliArgs({ ...schema, required: ["value"] }, [raw]), /Invalid number/);
  }
  for (const [raw, value] of [["0", 0], ["-1.5", -1.5], ["1e2", 100], [" 2.5 ", 2.5]] as const) {
    assert.deepEqual(parseWorkflowCliArgs(schema, ["--value", raw, "--values", raw]), { value, values: [value] });
  }
});
void test("headless CLI rejects blank numbers before creating a run and persists valid results", () => {
  const paths = fixture();
  const definition = 'numericEcho: { description: "Echo a number", input: { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false }, output: { type: "number" }, run: (input) => input.value }';
  try {
    const invalid = runIsolatedCli(paths, definition, ["run", "numericEcho", "--value="]);
    assert.equal(invalid.status, 1, invalid.stderr);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /Error: Invalid number/);
    assert.doesNotMatch(invalid.stderr, /Run ID:/);
    assert.equal(readdirSync(paths.root, { recursive: true }).some((path) => String(path).endsWith("snapshot.json")), false);
    const valid = runIsolatedCli(paths, definition, ["run", "numericEcho", "--value=0"]);
    assert.equal(valid.status, 0, valid.stderr);
    assert.equal(valid.stdout, "0\n");
    assert.match(valid.stderr, /Run ID: [0-9a-f-]+/);
    const results = readdirSync(paths.root, { recursive: true }).map(String).filter((path) => path.endsWith("/result.json"));
    assert.equal(results.length, 1);
    assert.equal(readFileSync(join(paths.root, results[0] ?? ""), "utf8").trim(), "0");
  } finally { rmSync(paths.root, { recursive: true, force: true }); }
});
void test("CLI parser handles delimiter passthrough, negated booleans, and negative numeric positionals", () => {
  const stringSchema = { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false };
  const booleanSchema = { type: "object", properties: { issue: { type: "integer" }, verbose: { type: "boolean", default: true } }, required: ["issue"], additionalProperties: false };
  const integerSchema = { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false };
  const numberSchema = { type: "object", properties: { value: { type: "number" } }, required: ["value"], additionalProperties: false };
  for (const value of ["--help", "-h", "--", "--approve"]) {
    assert.deepEqual(parseWorkflowCliArgs(stringSchema, ["--", value]), { value });
  }
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

void test("headless CLI preserves inter-extension communication during shutdown on success and failure", () => {
  for (const [script, status] of [["return true;", 0], ["throw new Error('deliberate failure');", 1]] as const) {
    const paths = fixture();
    try {
      const events = join(paths.root, "lifecycle.log");
      const listener = join(paths.agentDir, "listener.js");
      const emitter = join(paths.agentDir, "emitter.js");
      writeFileSync(listener, `import { appendFileSync } from 'node:fs';
export default function(pi) { pi.events.on('cleanup-fixture', () => appendFileSync(${JSON.stringify(events)}, 'event-cleanup\\n')); }
`);
      writeFileSync(emitter, `import { appendFileSync } from 'node:fs';
export default function(pi) {
  pi.on('session_start', () => appendFileSync(${JSON.stringify(events)}, 'start\\n'));
  pi.on('session_shutdown', () => { appendFileSync(${JSON.stringify(events)}, 'shutdown\\n'); pi.events.emit('cleanup-fixture', {}); });
}
`);
      writeFileSync(join(paths.agentDir, "settings.json"), JSON.stringify({ extensions: [listener, emitter] }));
      writeFileSync(join(paths.cwd, "workflow.js"), script);
      const result = runIsolatedCli(paths, 'placeholder: { description: "Placeholder", input: { type: "object" }, output: { type: "boolean" }, run: () => true }', ["run", "--script", "workflow.js"]);
      assert.equal(result.status, status, result.stderr);
      assert.equal(readFileSync(events, "utf8"), "start\nshutdown\nevent-cleanup\n");
    } finally { rmSync(paths.root, { recursive: true, force: true }); }
  }
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
void test("portable bundle export rejects extensions without source provenance", () => {
  const paths = fixture();
  const result = runIsolatedCli(paths, `cliEcho: { description: "Echo", input: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, output: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, run: (input) => ({ issue: input.issue }) }`, ["bundle", "cliEcho", "--output", join(paths.root, "bundle")]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not exportable; add `source: import\.meta\.url`/);
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
for (const value of ["--help", "-h", "--", "--approve"]) {
  void test(`isolated CLI passes post-delimiter literal ${value} to workflows`, () => {
    const paths = fixture();
    try {
      const result = runIsolatedCli(paths, `cliLiteral: { description: "Echo a literal option", input: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false }, output: { type: "string" }, run: (input) => input.value }`, ["run", "--approve", "cliLiteral", "--", value]);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${JSON.stringify(value)}\n`);
      assert.match(result.stderr, /Run ID: [0-9a-f-]+/);
    } finally { rmSync(paths.root, { recursive: true, force: true }); }
  });
}

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

void test("doctor uses generic preparation for opaque options without contacting a provider", async () => {
  const paths = fixture();
  const registry = new WorkflowRegistry();
  let calls = 0;
  registry.register({ version: "1.0.0", headline: "Inspection policy", agentPreparationHooks: { policy: { prepare(configuration, context) {
    calls += 1;
    assert.equal(context.mode, "inspection");
    assert.deepEqual(context.options, { policy: "read" });
    configuration.tools = ["!*", "read"];
    configuration.systemPromptAppend = "GENERIC_POLICY_APPEND";
  } } } });
  const report = await withHome(paths.root, () => doctor({ ...paths, registry, agentOptions: { policy: "read" }, prompt: "inspect this", discoverPi: async () => pi({ model: { provider: "openai-codex", model: "gpt-5.6-sol", thinking: "off" }, knownModels: ["openai-codex/gpt-5.6-sol"], availableModels: ["openai-codex/gpt-5.6-sol"] }) }));
  assert.equal(calls, 1);
  assert.deepEqual(report.agentInspection?.tools, ["read"]);
  assert.match(report.agentInspection.systemPrompt.text, /GENERIC_POLICY_APPEND/);
  assert.deepEqual(report.diagnostics.filter(({ severity }) => severity === "error"), []);
});
