import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { doctor, doctorExitCode, formatDoctorReport, type DoctorPiState } from "../src/doctor.js";
import { formatWorkflowCliHelp, parseWorkflowCliArgs, runCli } from "../src/cli.js";
import { registerWorkflowExtension, type JsonValue, type WorkflowExtension } from "../src/index.js";

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
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-doctor-"));
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
  },
};
function registerCliExtension(): void { registerWorkflowExtension(cliExtension); }

function runIsolatedCli(paths: { root: string; cwd: string; agentDir: string }, functionDefinition: string, args: readonly string[], abort = false): { status: number | null; stdout: string; stderr: string } {
  const script = join(paths.root, "isolated-cli.mjs");
  const indexUrl = pathToFileURL(join(process.cwd(), "dist", "src", "index.js")).href;
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
  assert.deepEqual(report.resourcePolicy.effective.skills, ["global-skill", "missing-skill", "project-skill"]);
  assert.deepEqual(report.resourcePolicy.effective.extensions, [globalExtension, projectExtension]);
  assert.deepEqual(report.resourcePolicy.unmatchedSkills, ["missing-skill"]);
  assert.deepEqual(report.resourcePolicy.unmatchedExtensions, []);
  assert.equal(report.diagnostics.filter(({ code }) => code === "AGENT_RESOURCE_UNMATCHED").length, 1);
  assert.match(formatDoctorReport(report), /Effective skills: global-skill, missing-skill, project-skill/);
});
void test("doctor excludes workflow_catalog from active capabilities and output", async () => {
  const paths = fixture();
  const report = await withHome(paths.root, () => doctor({ ...paths, activeTools: ["read", "workflow", "workflow_respond", "workflow_catalog"], discoverPi: async () => pi({ activeTools: ["read", "workflow", "workflow_respond", "workflow_catalog"] }) }));
  assert.deepEqual(report.activeTools, ["read"]);
  assert.doesNotMatch(formatDoctorReport(report), /workflow_catalog/);
});
void test("package bin and CLI expose doctor and inspector commands", async () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { bin?: Record<string, string> };
  assert.equal(pkg.bin?.["pi-extensible-workflows"], "./dist/src/cli.js");
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
  assert.equal(output, "Usage: pi-extensible-workflows doctor | inspect [session-id] | transcript <session-file>\n");
  const bin = join(paths.root, "bin", "pi-extensible-workflows");
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
  assert.equal(readFileSync(destination, "utf8"), `#!/bin/sh\nexec node '${cliPath}' run 'cliEcho' "$@"\n`);
  assert.match(output, /Exported .*cli-echo/);
  assert.match(warning, /not in PATH/);

  const fakeBin = join(paths.root, "fake-bin");
  const runner = join(fakeBin, "node");
  const capture = join(paths.root, "launcher-args.json");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(runner, `#!${process.execPath}\nimport { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.CAPTURE, JSON.stringify(process.argv.slice(2)));\n`);
  chmodSync(runner, 0o755);
  execFileSync(destination, ["value with spaces", "--quoted", "a'b"], { env: { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}`, CAPTURE: capture }, encoding: "utf8" });
  assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), [cliPath, "run", "cliEcho", "value with spaces", "--quoted", "a'b"]);
  const indexUrl = pathToFileURL(join(process.cwd(), "dist", "src", "index.js")).href;
  const cliUrl = pathToFileURL(cliPath).href;
  writeFileSync(runner, `#!${process.execPath}\nimport { registerWorkflowExtension } from ${JSON.stringify(indexUrl)};\nimport { runCli } from ${JSON.stringify(cliUrl)};\nregisterWorkflowExtension({ version: "1.0.0", headline: "Real runner", description: "Real runner", functions: { cliEcho: { description: "Echo", input: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, output: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, run: (input) => ({ issue: input.issue }) } } });\nprocess.exitCode = await runCli(process.argv.slice(3), { stderr: (text) => process.stderr.write(text) });\n`);
  chmodSync(runner, 0o755);
  const realOutput = execFileSync(destination, ["7"], { cwd: paths.cwd, env: { ...process.env, HOME: paths.root, PI_CODING_AGENT_DIR: paths.agentDir, PI_OFFLINE: "1", PATH: `${fakeBin}:${process.env.PATH ?? ""}` }, encoding: "utf8" });
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
  assert.match(readFileSync(destination, "utf8"), /^#!\/bin\/sh\n/);
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
void test("CLI validates registered function output schemas", () => {
  const paths = fixture();
  const result = runIsolatedCli(paths, `cliBadOutput: { description: "Return an invalid result", input: { type: "object", additionalProperties: false }, output: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false }, run: () => ({ issue: "not an integer" }) }`, ["run", "cliBadOutput"]);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Invalid output from cliBadOutput|invalid output/i);
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
