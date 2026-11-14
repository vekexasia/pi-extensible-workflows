import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import workflowExtension, { registerWorkflowExtension, workflowSettingsPath } from "../src/index.js";
import { RunStore } from "../src/persistence.js";
import { DEFAULT_SETTINGS } from "../src/settings.js";
import { createLaunchSnapshot } from "../src/validation.js";
import { runManagedWorktreeCommand } from "../src/managed-worktree.js";
import { PhysicalWorktreeLease, validateWorktreeLeaseIdentity, worktreeLeaseIdentity } from "../src/worktree-lease.js";
import { fixtureGit, initializeGitFixture } from "./git-fixture.js";
import { testExtensionApi } from "./support.js";

const [root, mode, encodedRedirects] = process.argv.slice(2);
assert.ok(root && mode && encodedRedirects);
const redirects = JSON.parse(encodedRedirects) as string[];
const cwd = join(root, "A"), foreign = join(root, "B"), home = join(root, "home");
mkdirSync(home);
for (const repo of [cwd, foreign]) {
  initializeGitFixture(repo);
  fixtureGit(repo, "commit", "--allow-empty", "-qm", "fixture");
}
const sourceHead = fixtureGit(cwd, "rev-parse", "HEAD"), foreignHead = fixtureGit(foreign, "rev-parse", "HEAD");
const sourceRefs = fixtureGit(cwd, "show-ref"), foreignRefs = fixtureGit(foreign, "show-ref");
const setupMarker = join(root, "setup"), callbackMarker = join(root, "callback");
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
const settings = workflowSettingsPath(join(home, "agent"));
mkdirSync(dirname(settings), { recursive: true });
writeFileSync(settings, JSON.stringify({ worktreeSetup: [`touch ${quote(setupMarker)}`] }));
const original = { ...process.env };
try {
  if (mode === "policy") {
    const hooks = join(root, "policy-hooks"), marker = join(root, "hook-policy"), signer = join(root, "fake-signer"), signed = join(root, "signer-policy");
    mkdirSync(hooks);
    writeFileSync(join(hooks, "post-checkout"), `#!/bin/sh\ngit config --get commit.gpgsign > ${quote(marker)}\n`, { mode: 0o700 });
    writeFileSync(signer, `#!/bin/sh\nprintf called > ${quote(signed)}\nexit 91\n`, { mode: 0o700 });
    const config = [["core.hooksPath", hooks], ["commit.gpgSign", "true"], ["gpg.format", "ssh"], ["gpg.ssh.program", signer], ["user.signingKey", "key::synthetic-not-a-real-key"]];
    process.env.GIT_CONFIG_COUNT = String(config.length);
    config.forEach(([key, value], index) => { process.env[`GIT_CONFIG_KEY_${String(index)}`] = key; process.env[`GIT_CONFIG_VALUE_${String(index)}`] = value; });
    const snapshot = createLaunchSnapshot({ script: "return null;", args: null, metadata: { name: "policy" }, settings: DEFAULT_SETTINGS, models: [], tools: [], agentConfigurations: {}, schemas: [] });
    const store = new RunStore(cwd, "session", "policy", home);
    await store.create({ id: "policy", cwd, sessionId: "session", workflowName: "policy", state: "running", agents: [], agentSessions: [] }, snapshot);
    const managed = await store.worktree("gate", { expectedTip: sourceHead, fresh: true, setup: "none" });
    assert.equal(readFileSync(marker, "utf8"), "true\n", "effective config-injected checkout hook and signing policy remain visible");
    await assert.rejects(runManagedWorktreeCommand("git commit --allow-empty -qm policy", managed.path, new AbortController().signal), /Managed worktree command exited/);
    assert.equal(readFileSync(signed, "utf8"), "called", "fake signer must be called instead of bypassing operator signing policy");
  } else if (mode === "cleanup" || mode === "missing-cleanup") {
    const snapshot = createLaunchSnapshot({ script: "return null;", args: null, metadata: { name: "cleanup" }, settings: DEFAULT_SETTINGS, models: [], tools: [], agentConfigurations: {}, schemas: [] });
    const store = new RunStore(cwd, "session", "cleanup", home);
    await store.create({ id: "cleanup", cwd, sessionId: "session", workflowName: "cleanup", state: "running", agents: [], agentSessions: [] }, snapshot);
    const managed = await store.worktree("gate", { expectedTip: sourceHead, fresh: true, setup: "none" });
    const identity = await worktreeLeaseIdentity(managed.path);
    if (mode === "missing-cleanup") rmSync(managed.path, { recursive: true, force: true });
    const records = readFileSync(join(store.directory, "worktrees.json"), "utf8");
    for (const redirect of redirects) {
      process.env[redirect] = join(foreign, ".git");
      await assert.rejects(runManagedWorktreeCommand(`touch ${quote(callbackMarker)}`, cwd, new AbortController().signal), new RegExp(redirect));
      assert.equal(existsSync(callbackMarker), false);
      await assert.rejects(PhysicalWorktreeLease.acquire(identity, { runId: "r", sessionId: "s", executionId: "e" }, "cleanup"), new RegExp(redirect));
      await assert.rejects(validateWorktreeLeaseIdentity(identity, "cleanup"), new RegExp(redirect));
      await assert.rejects(store.delete(true), new RegExp(redirect));
      assert.equal(readFileSync(join(store.directory, "worktrees.json"), "utf8"), records);
      assert.equal(existsSync(identity.gitDirectory), true);
      assert.equal(existsSync(managed.path), mode === "cleanup");
      assert.equal(existsSync(join(foreign, ".git", "pi-worktree-owners")), false);
      Reflect.deleteProperty(process.env, redirect);
      await assert.rejects(runManagedWorktreeCommand(`touch ${quote(callbackMarker)}`, cwd, new AbortController().signal, { [redirect]: join(foreign, ".git") }), new RegExp(redirect));
      assert.equal(existsSync(callbackMarker), false);
    }
  } else {
    const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<unknown> }> = [];
    workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, on() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"] }), home, async () => {}, undefined, join(home, "agent"));
    let entered = 0;
    registerWorkflowExtension({ version: "1.0.0", headline: "Git redirect fixture", functions: { redirectRegistered: { description: "Lease or materialize the launch repository", input: { type: "object" }, output: { type: "null" }, run: async (_input, context) => {
      const callback = async () => { entered += 1; writeFileSync(callbackMarker, "entered"); return null; };
      return mode.endsWith("managed") ? context.withWorktree("gate", callback, { expectedTip: sourceHead, fresh: true }) : context.withWorktreeLease(cwd, callback);
    } } } });
    const workflow = tools.find((tool) => tool.name === "workflow"); assert.ok(workflow);
    const context = { cwd, hasUI: false, model: { provider: "fixture", id: "offline" }, sessionManager: { getSessionId: () => "redirect" } };
    const script = mode.startsWith("registered") ? "return await redirectRegistered({});" : mode.endsWith("managed") ? 'return await withWorktree("gate", async () => { await shell("touch " + args.marker); }, {expectedTip:args.tip,fresh:true});' : 'return await withWorktreeLease(args.cwd, async lease => { await lease.shell("touch " + args.marker); });';
    if (mode === "legacy") {
      process.env.GIT_DIR = join(foreign, ".git");
      const result = await workflow.execute("legacy", { name: "legacy", script: 'return (await shell("git rev-parse --absolute-git-dir")).stdout.trim();', foreground: true }, new AbortController().signal, undefined, context);
      assert.ok(JSON.stringify(result).includes(join(foreign, ".git")), "ordinary unleased shell retains Git redirect intent");
    } else for (const redirect of redirects) {
      process.env[redirect] = join(foreign, ".git");
      await assert.rejects(workflow.execute(redirect, { name: "redirect", script, args: { cwd, marker: callbackMarker, tip: sourceHead }, foreground: true }, new AbortController().signal, undefined, context), new RegExp(redirect));
      assert.equal(entered, 0);
      assert.equal(existsSync(callbackMarker), false);
      assert.equal(existsSync(setupMarker), false);
      assert.equal(existsSync(join(cwd, ".git", "pi-worktree-owners")), false);
      assert.equal(existsSync(join(cwd, ".git", "worktrees")), false);
      assert.equal(existsSync(join(foreign, ".git", "pi-worktree-owners")), false);
      assert.equal(fixtureGit(cwd, "show-ref"), sourceRefs);
      assert.equal(fixtureGit(foreign, "show-ref"), foreignRefs);
      const markers = (path: string): string[] => readdirSync(path, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? markers(join(path, entry.name)) : entry.name.endsWith(".creating") ? [entry.name] : []);
      assert.deepEqual(markers(home), [], "admission rejection must not persist any materialization intent");
      Reflect.deleteProperty(process.env, redirect);
    }
  }
  assert.equal(fixtureGit(cwd, "rev-parse", "HEAD"), sourceHead);
  assert.equal(fixtureGit(foreign, "rev-parse", "HEAD"), foreignHead);
  console.log(`verified ${mode}`);
} finally {
  for (const key of Object.keys(process.env)) Reflect.deleteProperty(process.env, key);
  Object.assign(process.env, original);
}
