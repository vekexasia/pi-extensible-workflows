import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { piArguments, resolvePiArguments, runPiRole } from "../src/pi-role.js";

function fixture(): { cwd: string; agentDir: string } {
  const root = mkdtempSync(join(tmpdir(), "pi-role-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "project");
  mkdirSync(join(agentDir, "pi-extensible-workflows", "roles"), { recursive: true });
  mkdirSync(join(agentDir, "skills", "tigerstyle"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(agentDir, "skills", "tigerstyle", "SKILL.md"), "---\nname: tigerstyle\ndescription: Tiger style\n---\nbody\n");
  writeFileSync(join(agentDir, "pi-extensible-workflows", "settings.json"), JSON.stringify({ modelAliases: { "dev-model": "openai/gpt-5:high" }, skills: ["!*"] }));
  writeFileSync(join(agentDir, "pi-extensible-workflows", "roles", "developer.md"), "---\nmodel: dev-model\ntools: [\"!*\", read, bash, view_image]\nskills: [tigerstyle]\ncontextFiles: []\n---\nBe a developer.\n");
  writeFileSync(join(agentDir, "pi-extensible-workflows", "roles", "plain.md"), "---\noverrideSystemPrompt: true\ncontextFiles: [global]\n---\nOverride.\n");
  writeFileSync(join(agentDir, "pi-extensible-workflows", "roles", "starterish.md"), "---\nmodel: not-configured-model\n---\nS.\n");
  writeFileSync(join(agentDir, "pi-extensible-workflows", "roles", "dupes.md"), "---\ncontextFiles: [global, global, global]\n---\nD.\n");
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "local.md"), "Project role.\n");
  return { cwd, agentDir };
}

void test("pi-role translates a resolved role into pi startup arguments", async () => {
  const { cwd, agentDir } = fixture();
  try {
    const args = await resolvePiArguments("developer", ["--continue"], cwd, agentDir);
    assert.deepEqual(args.slice(0, 4), ["--model", "openai/gpt-5:high", "--tools", "read,bash,view_image"]);
    assert.deepEqual(args.slice(4, 7), ["--no-skills", "--skill", join(agentDir, "skills", "tigerstyle", "SKILL.md")]);
    assert.equal(args[7], "--no-extensions");
    assert.deepEqual(args.slice(-4), ["--append-system-prompt", "Be a developer.", "--no-context-files", "--continue"]);
    assert.ok(!args.includes("--extension"), "no extensions discovered in the fixture");
    await assert.rejects(resolvePiArguments("plain", [], cwd, agentDir), /subset of context file scopes/);
    await assert.rejects(resolvePiArguments("missing", [], cwd, agentDir), /Unknown agent role: missing/);
  } finally { rmSync(join(cwd, ".."), { recursive: true, force: true }); }
});

void test("pi-role falls back to pi's default model when a role alias is not configured", async () => {
  const { cwd, agentDir } = fixture();
  const written: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => { written.push(String(chunk)); return true; };
  try {
    const args = await resolvePiArguments("starterish", [], cwd, agentDir);
    assert.ok(!args.includes("--model"), "no --model when the alias cannot be resolved");
    assert.deepEqual(args.slice(-2), ["--append-system-prompt", "S."]);
    assert.match(written.join(""), /Unknown model not-configured-model.*default model/);
    await assert.rejects(resolvePiArguments("dupes", [], cwd, agentDir), /subset of context file scopes/, "duplicate scopes do not add up to the full set");
  } finally { process.stderr.write = original; rmSync(join(cwd, ".."), { recursive: true, force: true }); }
});

void test("pi-role trust flags follow pi: last flag wins, nothing after -- counts, project roles need trust", async () => {
  const { cwd, agentDir } = fixture();
  try {
    await assert.rejects(resolvePiArguments("local", [], cwd, agentDir), /Unknown agent role: local/, "no saved trust decision: project roles stay out");
    await assert.rejects(resolvePiArguments("local", ["--", "--approve"], cwd, agentDir), /Unknown agent role: local/);
    await assert.rejects(resolvePiArguments("local", ["--approve", "--no-approve"], cwd, agentDir), /Unknown agent role: local/);
    const args = await resolvePiArguments("local", ["--no-approve", "-a"], cwd, agentDir);
    assert.deepEqual(args.slice(-4), ["--append-system-prompt", "Project role.\n", "--no-approve", "-a"]);
  } finally { rmSync(join(cwd, ".."), { recursive: true, force: true }); }
});

void test("pi-role launches the installed Pi Node shim with literal arguments and propagates its exit code", async () => {
  const { cwd, agentDir } = fixture();
  const root = join(cwd, "..", "process launch fixture with spaces");
  const bin = join(root, "npm bin with spaces");
  mkdirSync(bin, { recursive: true });
  const entry = join(bin, "pi entry.mjs");
  const capture = join(root, "captured arguments.json");
  writeFileSync(entry, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.PI_LAUNCH_CAPTURE, JSON.stringify(process.argv.slice(2))); process.exitCode = Number(process.env.PI_LAUNCH_EXIT);\n");
  const shim = join(bin, "pi.cmd");
  if (process.platform === "win32") writeFileSync(shim, String.raw`@ECHO off
IF EXIST "%dp0%\node.exe" (SET "_prog=%dp0%\node.exe") ELSE (SET "_prog=node")
"%_prog%" "%dp0%\pi entry.mjs" %*
`);
  else {
    // POSIX npm bins are executable Node files named without an extension; strip `.cmd` (not a backslash) here.
    writeFileSync(shim.replace(/\.cmd$/i, ""), `#!/usr/bin/env node
import { writeFileSync } from 'node:fs'; writeFileSync(process.env.PI_LAUNCH_CAPTURE, JSON.stringify(process.argv.slice(2))); process.exitCode = Number(process.env.PI_LAUNCH_EXIT);
`);
    chmodSync(shim.replace(/\.cmd$/i, ""), 0o755);
  }
  const originalPath = process.env.PATH;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.PI_LAUNCH_CAPTURE = capture;
    process.env.PI_LAUNCH_EXIT = "7";
    process.env.PATH = process.platform === "win32" ? bin : `${bin}${delimiter}${originalPath ?? ""}`;
    assert.equal(await runPiRole(["developer", "--print", "argument with spaces & symbols", "café"]), 7);
    const captured = JSON.parse(readFileSync(capture, "utf8")) as string[];
    assert.deepEqual(captured.slice(-3), ["--print", "argument with spaces & symbols", "café"]);
  } finally {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    delete process.env.PI_LAUNCH_CAPTURE;
    delete process.env.PI_LAUNCH_EXIT;
    rmSync(join(cwd, ".."), { recursive: true, force: true });
  }
});

void test("pi-role leaves context files to pi and uses --system-prompt for overriding roles", () => {
  const base = { prompt: "P", overrideSystemPrompt: true, systemPrompt: { mode: "override" as const, text: "P" }, selectorSources: { global: {}, project: {} }, selectorLayers: { skills: [undefined], extensions: [undefined], tools: [undefined] } };
  assert.deepEqual(piArguments(base, new Map(), ["-p", "hi"]), ["--no-skills", "--no-extensions", "--system-prompt", "P", "-p", "hi"]);
  assert.deepEqual(piArguments({ ...base, contextFiles: ["global", "project", "cwd"] }, new Map(), []), ["--no-skills", "--no-extensions", "--system-prompt", "P"]);
});
