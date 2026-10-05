import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";
import { testExtensionApi } from "./support.js";
import workflowExtension, { RPC_LIMIT_BYTES, RunStore, WorkflowAgentExecutor, canonicalPath, createLaunchSnapshot, loadAgentDefinitions, resolveAgentResourcePolicy, resolveWorkflowSettings, runWorkflow, validateWorkflowLaunch, WorkflowError } from "../src/index.js";
import { listRunIds } from "../src/persistence.js";
import type { SessionInput } from "../src/agent-execution.js";
import { testTransport, type TestPiSession } from "./test-transport.js";
import { executeShellCommand } from "../src/execution.js";

type WorkflowCommand = (args: string, context: unknown) => Promise<void>;
async function resumeFromDashboard(command: WorkflowCommand, source: Record<string, unknown>, runId: string): Promise<void> {
  let picked = false;
  let used = false;
  const baseUi = source.ui as { notify: (message: string) => void };
  await command("", { ...source, hasUI: true, mode: "rpc", ui: { ...baseUi, select: async (prompt: string, options: string[]) => {
    if (options.includes("Skip")) return "Skip";
    if (prompt === "Workflows\n") { if (picked) return "Close"; picked = true; return options.find((option) => option.includes(runId)) ?? options[0] ?? "Close"; }
    if (prompt.startsWith("Resume ")) return "Foreground";
    if (options.includes("Resume")) { if (used) return "Back"; used = true; return "Resume"; }
    return "Back";
  } } });
}
void test("untrusted project policy cannot influence launch validation", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust-launch-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const globalSettingsPath = join(agentDir, "pi-extensible-workflows", "settings.json");
  const projectSettingsPath = join(cwd, ".pi", "pi-extensible-workflows", "settings.json");
  mkdirSync(join(agentDir, "pi-extensible-workflows", "roles"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
  writeFileSync(join(agentDir, "pi-extensible-workflows", "roles", "safe.md"), "Global role");
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "roles", "reviewer.md"), "Untrusted project role");
  writeFileSync(globalSettingsPath, JSON.stringify({ concurrency: 3, skills: ["global-only"], extensions: ["/global-only.ts"] }));
  writeFileSync(projectSettingsPath, JSON.stringify({ concurrency: 1, modelAliases: { reviewer: "evil/provider" }, skills: ["project-only"], extensions: ["/project-only.ts"] }));

  const resolution = resolveWorkflowSettings(cwd, false, globalSettingsPath);
  assert.equal(resolution.projectTrusted, false);
  assert.deepEqual(resolution.project, {});
  assert.deepEqual(resolution.effective, resolution.global);
  assert.deepEqual(resolution.effective.skills, ["global-only"]);
  const roles = loadAgentDefinitions(cwd, agentDir, false);
  assert.equal(roles.reviewer, undefined);
  assert.deepEqual(roles.safe, { prompt: "Global role" });

  assert.throws(() => validateWorkflowLaunch({ name: "untrusted", script: `return agent("review", { role: "reviewer" });` }, { cwd, agentDir, projectTrusted: false, availableModels: new Set(["openai/gpt"]), rootTools: new Set(), knownModels: new Set(["openai/gpt"]), settingsPath: globalSettingsPath }), (error: unknown) => error instanceof WorkflowError && error.code === "UNKNOWN_AGENT_TYPE");
  assert.deepEqual(await listRunIds(cwd, "session", root), []);
});

void test("filesystem aliases neither widen untrusted project policy nor bypass global exclusions", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust alias ü-"));
  try {
    const project = join(root, "Project Ω");
    const projectAlias = join(root, "Project Junction ü");
    const agentDir = join(root, "Agent Dir ü");
    const extensions = join(root, "Extensions Ω");
    const extensionsAlias = join(root, "Extensions Junction ü");
    const guarded = join(extensions, "Guarded Ext.ts");
    const globalSettingsPath = join(agentDir, "pi-extensible-workflows", "settings.json");
    mkdirSync(join(agentDir, "pi-extensible-workflows", "roles"), { recursive: true });
    mkdirSync(join(project, ".pi", "pi-extensible-workflows", "roles"), { recursive: true });
    mkdirSync(extensions);
    writeFileSync(guarded, "export default () => {};\n");
    symlinkSync(project, projectAlias, process.platform === "win32" ? "junction" : "dir");
    symlinkSync(extensions, extensionsAlias, process.platform === "win32" ? "junction" : "dir");
    const physicalGuarded = realpathSync.native(guarded);
    const drive = (path: string): string => /^[A-Z]:/.test(path) ? `${path.charAt(0).toLowerCase()}${path.slice(1)}` : path;
    const upper = guarded.toUpperCase();
    const guardedAliases = [join(extensionsAlias, "Guarded Ext.ts"), drive(guarded).split(sep).join("/"), ...(upper !== guarded && existsSync(upper) ? [upper] : [])];
    if (process.platform === "win32") assert.equal(guardedAliases.length, 3, "Windows fixtures must exercise junction, drive/separator, and case aliases");
    writeFileSync(join(agentDir, "pi-extensible-workflows", "roles", "safe.md"), "Global role");
    writeFileSync(join(project, ".pi", "pi-extensible-workflows", "roles", "reviewer.md"), "Untrusted project role");
    writeFileSync(globalSettingsPath, JSON.stringify({ skills: ["global-only"], extensions: ["*", ...guardedAliases.map((alias) => `!${alias}`)] }));
    writeFileSync(join(project, ".pi", "pi-extensible-workflows", "settings.json"), JSON.stringify({ skills: ["project-only"], extensions: [join(extensionsAlias, "Guarded Ext.ts")] }));

    const projectAliases = [projectAlias, drive(projectAlias), ...(existsSync(projectAlias.toUpperCase()) && projectAlias.toUpperCase() !== projectAlias ? [projectAlias.toUpperCase()] : [])];
    for (const cwd of projectAliases) {
      const resolution = resolveWorkflowSettings(cwd, false, globalSettingsPath);
      assert.equal(resolution.projectTrusted, false);
      assert.deepEqual(resolution.project, {});
      assert.deepEqual(resolution.effective.skills, ["global-only"]);
      assert.deepEqual(resolution.effective.extensions, ["*", ...guardedAliases.map(() => `!${physicalGuarded}`)], cwd);
      assert.equal(canonicalPath(guarded), physicalGuarded);
      const policy = resolveAgentResourcePolicy(cwd, false, globalSettingsPath);
      assert.equal(policy.projectTrusted, false);
      assert.equal(policy.effective.skills.includes("project-only"), false);
      assert.ok(policy.effective.extensions.every((selector) => selector === "*" || selector === `!${physicalGuarded}`));
      const roles = loadAgentDefinitions(cwd, agentDir, false);
      assert.equal(roles.reviewer, undefined);
      assert.deepEqual(roles.safe, { prompt: "Global role" });
    }

    const missingAlias = join(extensionsAlias, "Missing Ext ü.ts");
    writeFileSync(globalSettingsPath, JSON.stringify({ extensions: [`!${missingAlias}`] }));
    assert.deepEqual(resolveWorkflowSettings(projectAlias, false, globalSettingsPath).effective.extensions, [`!${missingAlias}`]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("workflow JavaScript cannot cross filesystem, network, or process boundaries", async () => {
  const run = runWorkflow(`const escape = (() => { try { globalThis.constructor.constructor("return require('node:fs')")(); return "escaped"; } catch { return "blocked"; } })(); return { process: typeof process, require: typeof require, fetch: typeof fetch, websocket: typeof WebSocket, escape };`);
  assert.deepEqual(await run.result, { process: "undefined", require: "undefined", fetch: "undefined", websocket: "undefined", escape: "blocked" });
});

void test("forged worktree metadata cannot redirect cleanup", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust-worktree-"));
  const repo = join(home, "repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
  writeFileSync(join(repo, "tracked.txt"), "initial");
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "initial"]);
  execFileSync("git", ["-C", repo, "branch", "keep-me"]);

  const store = new RunStore(repo, "session", "run", home);
  await store.create({ id: "run", workflowName: "trust", cwd: repo, sessionId: "session", state: "running", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "trust" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: [], roles: {}, schemas: [] }));
  const owned = await store.worktree("worker");
  writeFileSync(join(store.directory, "worktrees.json"), JSON.stringify([{ ...owned, path: repo, cwd: repo, branch: "keep-me" }]));

  await assert.rejects(store.delete(true), (error: unknown) => error instanceof WorkflowError && error.code === "WORKTREE_FAILED");
  assert.equal(existsSync(repo), true);
  assert.equal(existsSync(owned.path), true);
  assert.doesNotThrow(() => execFileSync("git", ["-C", repo, "rev-parse", "--verify", "keep-me"], { stdio: "ignore" }));
});

void test("accepted shell stays host-trusted while oversized RPC results are never journaled", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust-shell-"));
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust-shell-cwd-"));
  const marker = join(cwd, "shell-marker");
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, undefined, undefined, home);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const context = { cwd, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" } };
  const trustedScript = `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "host-trusted");process.stdout.write("trusted");process.stderr.write("diagnostic");process.exit(7)`;
  const trustedCommand = `${process.execPath} -e ${JSON.stringify(trustedScript)}`;
  const trusted = await workflow.execute("id", { name: "trusted-shell", script: `return await shell(${JSON.stringify(trustedCommand)});`, foreground: true }, new AbortController().signal, undefined, context);
  assert.deepEqual(JSON.parse(trusted.content[0]?.text ?? "null"), { exitCode: 7, stdout: "trusted", stderr: "diagnostic" });
  assert.equal(readFileSync(marker, "utf8"), "host-trusted");

  const oversizedHome = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust-shell-large-"));
  const oversizedCwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust-shell-large-cwd-"));
  const oversizedMarker = join(oversizedCwd, "shell-marker");
  const oversizedTools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof oversizedTools)[number]) { oversizedTools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), oversizedHome, undefined, undefined, oversizedHome);
  const oversizedWorkflow = oversizedTools.find(({ name }) => name === "workflow");
  assert.ok(oversizedWorkflow);
  const oversizedScript = `require("node:fs").writeFileSync(${JSON.stringify(oversizedMarker)}, "ran");process.stdout.write("x".repeat(${String(RPC_LIMIT_BYTES - 32)}))`;
  const oversizedCommand = `${process.execPath} -e ${JSON.stringify(oversizedScript)}`;
  await assert.rejects(oversizedWorkflow.execute("id", { name: "oversized-shell", script: `return await shell(${JSON.stringify(oversizedCommand)});`, foreground: true }, new AbortController().signal, undefined, { cwd: oversizedCwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "RPC_LIMIT_EXCEEDED");
  assert.equal(readFileSync(oversizedMarker, "utf8"), "ran");
  const [runId] = await listRunIds(oversizedCwd, "session", oversizedHome);
  assert.ok(runId);
  const journal = JSON.parse(readFileSync(join(new RunStore(oversizedCwd, "session", runId, oversizedHome).directory, "journal.json"), "utf8")) as { completed: Record<string, unknown> };
  assert.deepEqual(journal.completed, {});
});

void test("retry attempts refresh global and role exclusions without reviving project policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust-retry-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const settingsPath = join(agentDir, "pi-extensible-workflows", "settings.json");
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ skills: ["global-first"], extensions: [] }));
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "settings.json"), JSON.stringify({ skills: ["project-must-stay-ignored"], extensions: [] }));
  const inputs: SessionInput[] = [];
  let sessions = 0;
  const executor = new WorkflowAgentExecutor({ cwd, model: { provider: "openai", model: "gpt" }, tools: new Set(), availableModels: new Set(["openai/gpt"]), agentDefinitions: { reviewer: { skills: ["role-only"], extensions: [] } }, agentResourcePolicy: () => resolveAgentResourcePolicy(cwd, false, settingsPath) }, testTransport(async (input): Promise<TestPiSession> => {
    inputs.push(input);
    const session = ++sessions;
    return { sessionId: `retry-${String(session)}`, sessionFile: `/sessions/retry-${String(session)}.jsonl`, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => { if (session === 1) { writeFileSync(settingsPath, JSON.stringify({ skills: ["global-second"], extensions: [] })); throw new Error("retry"); } }, dispose() {} };
  }));

  assert.equal((await executor.execute("inspect", { label: "reviewer", workflowName: "trust", role: "reviewer", retries: 1 })).value, "done");
  assert.deepEqual(inputs.map(({ resourcePolicy }) => resourcePolicy?.effective.skills), [["global-first", "role-only"], ["global-second", "role-only"]]);
  assert.ok(inputs.every(({ resourcePolicy }) => !resourcePolicy?.effective.skills.includes("project-must-stay-ignored")));
});

void test("cold resume rejects persisted project roles before launching them", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust-resume-"));
  const cwd = join(home, "project");
  mkdirSync(cwd, { recursive: true });
  const store = new RunStore(cwd, "session", "run", home);
  await store.create({ id: "run", workflowName: "untrusted", cwd, sessionId: "session", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: `return agent("review", { role: "reviewer" });`, args: null, metadata: { name: "untrusted" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentTypes: ["reviewer"], roles: { reviewer: { prompt: "project role" } }, projectRoles: ["reviewer"], schemas: [] }));

  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  let launched = 0;
  const createSession = async (): Promise<TestPiSession> => { launched += 1; throw new Error("must not launch"); };
  const notices: string[] = [];
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, isProjectTrusted: () => false, ui: { notify(message: string) { notices.push(message); } } };
  workflowExtension(testExtensionApi({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession), home);
  const startHandler = start;
  const commandHandler = command;
  assert.ok(startHandler && commandHandler);
  await startHandler({}, context);
  assert.equal((await store.load()).run.state, "interrupted");
  await resumeFromDashboard(commandHandler, context, "run");
  assert.ok(notices.some((message) => /untrusted project/.test(message)));
  assert.equal(launched, 0);
  assert.deepEqual((await store.load()).run.agents, []);
  await shutdown?.();
});

void test("cold resume propagates persisted roles with current global selectors", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust-cold-policy-"));
  const cwd = join(home, "project");
  const agentDir = join(home, "agent");
  const settingsPath = join(agentDir, "pi-extensible-workflows", "settings.json");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  mkdirSync(join(cwd, ".pi", "pi-extensible-workflows"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ skills: ["global-cold"], extensions: [] }));
  writeFileSync(join(cwd, ".pi", "pi-extensible-workflows", "settings.json"), JSON.stringify({ skills: ["project-ignored"], extensions: [] }));
  const store = new RunStore(cwd, "session", "run", home);
  await store.create({ id: "run", workflowName: "cold-policy", cwd, sessionId: "session", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: `return agent("review", { role: "reviewer" });`, args: null, metadata: { name: "cold-policy" }, settings: { concurrency: 1, skills: ["stale-snapshot"], extensions: [] }, models: ["openai/gpt"], tools: [], agentTypes: ["reviewer"], roles: { reviewer: { prompt: "Cold-resumed reviewer role", skills: ["role-cold"], extensions: [] } }, projectRoles: [], schemas: [] }));

  const inputs: SessionInput[] = [];
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    inputs.push(input);
    return { transport: "local", session: { transport: "local", sessionId: "cold-session", locator: { sessionFile: "/sessions/cold-session.jsonl" } }, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {} };
  };
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, isProjectTrusted: () => false, ui: { notify() {} } };
  workflowExtension(testExtensionApi({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, testTransport(createSession), agentDir);
  assert.ok(start && command);
  await start({}, context);
  await resumeFromDashboard(command, context, "run");
  for (let attempt = 0; attempt < 1_000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await store.load()).run.state, "completed");
  assert.equal(inputs.length, 1);
  const policy = inputs[0]?.resourcePolicy;
  assert.ok(policy);
  assert.equal(inputs[0]?.systemPromptAppend, "Cold-resumed reviewer role");
  assert.deepEqual(policy.effective.skills, ["global-cold", "role-cold"]);
  assert.equal(policy.effective.skills.includes("project-ignored"), false);
  await shutdown?.();
});

void test("cold resume preserves current tool selectors at the session boundary", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-trust-cold-tools-"));
  const cwd = join(home, "project");
  const agentDir = join(home, "agent");
  const settingsPath = join(agentDir, "pi-extensible-workflows", "settings.json");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(agentDir, "pi-extensible-workflows"), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify({ tools: ["*", "!write"] }));
  const store = new RunStore(cwd, "session", "run", home);
  await store.create({ id: "run", workflowName: "cold-tools", cwd, sessionId: "session", state: "interrupted", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: `return agent("review", { role: "reviewer" });`, args: null, metadata: { name: "cold-tools" }, settings: { concurrency: 1, tools: ["read", "write"] }, models: ["openai/gpt"], tools: ["read", "write"], agentTypes: ["reviewer"], roles: { reviewer: { prompt: "Cold-resumed reviewer role" } }, projectRoles: [], schemas: [] }));
  const inputs: SessionInput[] = [];
  const createSession = async (input: SessionInput): Promise<TestPiSession> => {
    inputs.push(input);
    return { transport: "local", session: { transport: "local", sessionId: "cold-tools-session", locator: { sessionFile: "/sessions/cold-tools-session.jsonl" } }, messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }], getSessionStats: () => ({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }, cost: 0 }), prompt: async () => {}, steer: async () => {}, dispose() {} };
  };
  let start: ((event: unknown, ctx: unknown) => Promise<void>) | undefined;
  let command: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  let shutdown: (() => Promise<void>) | undefined;
  const context = { cwd, hasUI: false, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" }, isProjectTrusted: () => false, ui: { notify() {} } };
  workflowExtension(testExtensionApi({ on(name: string, handler: unknown) { if (name === "session_start") start = handler as typeof start; if (name === "session_shutdown") shutdown = handler as typeof shutdown; }, registerTool() {}, registerCommand(_name: string, value: { handler: NonNullable<typeof command> }) { command = value.handler; }, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow", "read", "write"] }), home, async () => {}, testTransport(createSession), agentDir);
  assert.ok(start && command);
  await start({}, context);
  await resumeFromDashboard(command, context, "run");
  for (let attempt = 0; attempt < 1_000 && (await store.load()).run.state !== "completed"; attempt += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal((await store.load()).run.state, "completed");
  assert.equal(inputs.length, 1);
  assert.deepEqual(inputs[0]?.tools, ["read"]);
  await shutdown?.();
});
void test("rejects oversized raw shell output and terminates its process group", { skip: process.platform === "win32", timeout: 15_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-raw-shell-limit-"));
  const survivor = join(cwd, "survivor");
  const survivorScript = `setTimeout(() => require("node:fs").writeFileSync(${JSON.stringify(survivor)}, "survived"), 500);`;
  const script = `const { spawn } = require("node:child_process"); spawn(process.execPath, ["-e", ${JSON.stringify(survivorScript)}], { stdio: "ignore" }); process.stdout.write("x".repeat(${String(RPC_LIMIT_BYTES + 1)})); setTimeout(() => {}, 10_000);`;
  const command = `${process.execPath} -e ${JSON.stringify(script)}`;
  await assert.rejects(executeShellCommand(command, {}, new AbortController().signal, cwd), (error: unknown) => error instanceof WorkflowError && error.code === "RPC_LIMIT_EXCEEDED");
  await new Promise((resolve) => setTimeout(resolve, 750));
  assert.equal(existsSync(survivor), false);
});
void test("pre-aborted shell launch cancels without leaving a child process group", { skip: process.platform === "win32", timeout: 5_000 }, async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-pre-aborted-shell-"));
  const parentPid = join(cwd, "parent.pid");
  const childPid = join(cwd, "child.pid");
  const survivor = join(cwd, "survivor");
  const survivorScript = `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(childPid)}, String(process.pid)); setTimeout(() => fs.writeFileSync(${JSON.stringify(survivor)}, "survived"), 250); setInterval(() => {}, 1_000);`;
  const script = `const fs = require("node:fs"); const { spawn } = require("node:child_process"); fs.writeFileSync(${JSON.stringify(parentPid)}, String(process.pid)); spawn(process.execPath, ["-e", ${JSON.stringify(survivorScript)}], { stdio: "ignore" }); setInterval(() => {}, 1_000);`;
  const command = `${process.execPath} -e ${JSON.stringify(script)}`;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(executeShellCommand(command, {}, controller.signal, cwd), (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  await new Promise((resolve) => setTimeout(resolve, 1_500));
  assert.equal(existsSync(survivor), false);
  for (const pidPath of [parentPid, childPid]) {
    if (!existsSync(pidPath)) continue;
    const pid = Number(readFileSync(pidPath, "utf8"));
    assert.throws(() => process.kill(-pid, 0), (error: unknown) => (error as NodeJS.ErrnoException).code === "ESRCH");
  }
});
