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
  return { root, cwd, agentDir, settingsPath: join(root, "missing-settings.json") };
}

async function withHome<T>(home: string, action: () => Promise<T>): Promise<T> {
  const previous = process.env.HOME;
  process.env.HOME = home;
  try { return await action(); }
  finally { if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous; }
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
void test("doctor preflights every registered workflow", async () => {
  const paths = fixture();
  writeFileSync(join(paths.agentDir, "pi-extensible-workflows", "roles", "reviewer.md"), "Review");
  const workflows = {
    "test.missing-role": { description: "missing role", script: `agent("x",{role:"missing"});` },
    "test.missing-tool": { description: "missing tool", script: `agent("x",{tools:["cat"]});` },
    "test.bad-meta": { description: "bad meta", script: `const x = ;` },
  };
  const report = await withHome(paths.root, () => doctor({ ...paths, discoverPi: async () => pi({ workflows }) }));
  assert.deepEqual(report.workflows.map(({ name, valid }) => [name, valid]), [
    ["test.bad-meta", false],
    ["test.missing-role", false],
    ["test.missing-tool", false],
  ]);
  assert.ok(report.diagnostics.some(({ code, message }) => code === "WORKFLOW_UNKNOWN_AGENT_TYPE" && /missing/.test(message)));
  assert.ok(report.diagnostics.some(({ code, message }) => code === "WORKFLOW_UNKNOWN_TOOL" && /cat/.test(message)));
  assert.ok(report.diagnostics.some(({ code }) => code === "WORKFLOW_INVALID_SYNTAX"));
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
  for (const heading of ["## Environment", "## Trust/resources", "## Active tools", "## Roles", "## Reusable workflows", "## Diagnostics", "## Summary"]) assert.match(output, new RegExp(heading));
  let inspected: string | undefined;
  assert.equal(await runCli(["inspect", "session-a"], { inspect: async (sessionId) => { inspected = sessionId; } }), 0);
  assert.equal(inspected, "session-a");
  output = "";
  assert.equal(await runCli([], {}, (text) => { output += text; }), 1);
  assert.equal(output, "Usage: pi-extensible-workflows doctor | inspect [session-id]\n");
  const bin = join(paths.root, "bin", "pi-extensible-workflows");
  mkdirSync(join(paths.root, "bin"), { recursive: true });
  symlinkSync(join(process.cwd(), "dist", "src", "cli.js"), bin);
  const linkedOutput = execFileSync(bin, ["doctor"], { cwd: paths.cwd, env: { ...process.env, HOME: paths.root }, encoding: "utf8" });
  assert.match(linkedOutput, /^# pi-extensible-workflows doctor/m);
  assert.equal(existsSync(join(paths.root, ".pi", "agent", "auth.json")), false);
});
