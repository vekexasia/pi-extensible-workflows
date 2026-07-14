import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { doctor, doctorExitCode, formatDoctorReport, type DoctorPiState } from "../src/doctor.js";
import { runCli } from "../src/cli.js";

function pi(overrides: Partial<DoctorPiState> = {}): DoctorPiState {
  return {
    trust: { required: true, trusted: true, source: "test trust" },
    activeTools: ["read", "grep"],
    knownModels: ["openai/gpt"],
    availableModels: ["openai/gpt"],
    extensionErrors: [],
    workflows: {},
    extensionVersions: {},
    ...overrides,
  };
}

function fixture(): { root: string; cwd: string; agentDir: string; settingsPath: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-workflows-doctor-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  mkdirSync(join(cwd, ".pi", "piworkflows", "roles"), { recursive: true });
  mkdirSync(join(agentDir, "agents"), { recursive: true });
  mkdirSync(join(root, "piworkflows", "roles"), { recursive: true });
  return { root, cwd, agentDir, settingsPath: join(root, "missing-settings.json") };
}

void test("doctor reports role errors, warnings, overrides, and extension failures", async () => {
  const paths = fixture();
  writeFileSync(join(paths.root, "piworkflows", "roles", "override.md"), "Global role");
  writeFileSync(join(paths.cwd, ".pi", "piworkflows", "roles", "override.md"), "Project role");
  writeFileSync(join(paths.cwd, ".pi", "piworkflows", "roles", "tool-typo.md"), "---\ntools: [read, cat]\n---\nCheck tools");
  writeFileSync(join(paths.cwd, ".pi", "piworkflows", "roles", "thinking.md"), "---\nthinking: hihg\n---\nThink");
  writeFileSync(join(paths.cwd, ".pi", "piworkflows", "roles", "malformed-model.md"), "---\nmodel: gpt-5\n---\nModel");
  writeFileSync(join(paths.cwd, ".pi", "piworkflows", "roles", "unavailable-model.md"), "---\nmodel: other/model\n---\nModel");
  writeFileSync(join(paths.cwd, ".pi", "piworkflows", "roles", "empty.md"), "---\ntools: [read]\n---\n");
  writeFileSync(join(paths.cwd, ".pi", "piworkflows", "roles", "placeholder.md"), "Use {{tools}} here");
  writeFileSync(join(paths.cwd, ".pi", "piworkflows", "roles", "empty-frontmatter.md"), "---\n---\nBody");

  const report = await doctor({ ...paths, activeTools: ["read"], discoverPi: async () => pi({ activeTools: ["cat"], extensionErrors: [{ path: "/bad-extension.ts", message: "load failed" }] }) });
  const codes = report.diagnostics.map(({ code }) => code);
  assert.ok(codes.includes("ROLE_TOOL_INACTIVE"));
  assert.ok(codes.includes("ROLE_FRONTMATTER"));
  assert.ok(codes.includes("MODEL_INVALID"));
  assert.ok(codes.includes("MODEL_UNAVAILABLE"));
  assert.ok(codes.includes("ROLE_BODY_EMPTY"));
  assert.ok(codes.includes("ROLE_PLACEHOLDER"));
  assert.ok(codes.includes("EXTENSION_LOAD"));
  assert.ok(!report.diagnostics.some(({ source }) => source?.endsWith("empty-frontmatter.md")));
  const project = report.roles.find((role) => role.name === "override" && role.scope === "project");
  const global = report.roles.find((role) => role.name === "override" && role.scope === "global");
  assert.ok(project);
  assert.ok(global);
  assert.equal(project.overrides, join(paths.root, "piworkflows", "roles", "override.md"));
  assert.equal(global.overriddenBy, join(paths.cwd, ".pi", "piworkflows", "roles", "override.md"));
  assert.equal(global.active, false);
  assert.equal(doctorExitCode(report), 1);
  assert.match(formatDoctorReport(report), /Fix: Use a tool listed under Active tools/);
});

void test("doctor rejects invalid role descriptions", async () => {
  const paths = fixture();
  writeFileSync(join(paths.cwd, ".pi", "piworkflows", "roles", "empty-description.md"), "---\ndescription: ''\n---\nRole");
  writeFileSync(join(paths.cwd, ".pi", "piworkflows", "roles", "long-description.md"), `---\ndescription: ${"x".repeat(1025)}\n---\nRole`);
  const report = await doctor({ ...paths, discoverPi: async () => pi() });
  const sources = report.diagnostics.filter(({ code }) => code === "ROLE_FRONTMATTER").map(({ source }) => source);
  assert.ok(sources.includes(join(paths.cwd, ".pi", "piworkflows", "roles", "empty-description.md")));
  assert.ok(sources.includes(join(paths.cwd, ".pi", "piworkflows", "roles", "long-description.md")));
});
void test("doctor preflights every registered workflow", async () => {
  const paths = fixture();
  writeFileSync(join(paths.root, "piworkflows", "roles", "reviewer.md"), "Review");
  const workflows = {
    "test.missing-role": { description: "missing role", script: `export const meta={name:"missing_role",description:"missing role"}; agent("x",{name:"a",role:"missing"});` },
    "test.missing-tool": { description: "missing tool", script: `export const meta={name:"missing_tool",description:"missing tool"}; agent("x",{name:"a",tools:["cat"]});` },
    "test.bad-meta": { description: "bad meta", script: `const meta={name:"bad",description:"bad"};` },
  };
  const report = await doctor({ ...paths, discoverPi: async () => pi({ workflows }) });
  assert.deepEqual(report.workflows.map(({ name, valid }) => [name, valid]), [
    ["test.bad-meta", false],
    ["test.missing-role", false],
    ["test.missing-tool", false],
  ]);
  assert.ok(report.diagnostics.some(({ code, message }) => code === "WORKFLOW_UNKNOWN_AGENT_TYPE" && /missing/.test(message)));
  assert.ok(report.diagnostics.some(({ code, message }) => code === "WORKFLOW_UNKNOWN_TOOL" && /cat/.test(message)));
  assert.ok(report.diagnostics.some(({ code }) => code === "WORKFLOW_INVALID_METADATA"));
});

void test("doctor respects untrusted projects and does not mutate fixtures", async () => {
  const paths = fixture();
  writeFileSync(join(paths.root, "piworkflows", "roles", "same.md"), "Global");
  writeFileSync(join(paths.cwd, ".pi", "piworkflows", "roles", "same.md"), "---\ntools: [cat]\n---\nProject");
  const before = readdirSync(paths.root, { recursive: true }).map(String).sort();
  const report = await doctor({ ...paths, discoverPi: async () => pi({ trust: { required: true, trusted: false, source: "saved Pi trust decision" } }) });
  const after = readdirSync(paths.root, { recursive: true }).map(String).sort();
  assert.deepEqual(after, before);
  assert.ok(report.diagnostics.some(({ code }) => code === "PROJECT_UNTRUSTED"));
  assert.ok(!report.diagnostics.some(({ code }) => code === "ROLE_TOOL_INACTIVE"));
  assert.equal(report.roles.find((role) => role.scope === "project")?.active, false);
  assert.equal(doctorExitCode(report), 0);
});

void test("package bin and CLI expose only the doctor command shape", async () => {
  const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { bin?: Record<string, string> };
  assert.equal(pkg.bin?.["pi-workflows"], "./dist/src/cli.js");
  const paths = fixture();
  let output = "";
  const exit = await runCli(["doctor"], { ...paths, discoverPi: async () => pi({ knownModels: [], availableModels: [] }) }, (text) => { output += text; });
  assert.equal(exit, 0);
  for (const heading of ["## Environment", "## Trust/resources", "## Active tools", "## Roles", "## Reusable workflows", "## Diagnostics", "## Summary"]) assert.match(output, new RegExp(heading));
  output = "";
  assert.equal(await runCli([], {}, (text) => { output += text; }), 1);
  assert.equal(output, "Usage: pi-workflows doctor\n");
  const bin = join(paths.root, "pi-workflows");
  symlinkSync(join(process.cwd(), "dist", "src", "cli.js"), bin);
  const linkedOutput = execFileSync(bin, ["doctor"], { cwd: paths.cwd, env: { ...process.env, HOME: paths.root }, encoding: "utf8" });
  assert.match(linkedOutput, /^# pi-workflows doctor/m);
  assert.equal(existsSync(join(paths.root, ".pi", "agent", "auth.json")), false);
});
