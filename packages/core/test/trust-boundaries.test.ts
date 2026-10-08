import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { testExtensionApi } from "./support.js";
import workflowExtension, { RPC_LIMIT_BYTES, RunStore, createLaunchSnapshot, runWorkflow, WorkflowError } from "../src/index.js";
import { listRunIds } from "../src/persistence.js";


import { executeShellCommand } from "../src/execution.js";




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
  await store.create({ id: "run", workflowName: "trust", cwd: repo, sessionId: "session", state: "running", agents: [], agentSessions: [] }, createLaunchSnapshot({ script: "return true;", args: null, metadata: { name: "trust" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: [], agentConfigurations: {}, schemas: [] }));
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
