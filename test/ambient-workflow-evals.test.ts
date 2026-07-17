import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  AMBIENT_CAPTURE_NOTE,
  createAmbientCaseWorktree,
  createAmbientFixtureRepository,
  formatAmbientSummary,
  removeAmbientCaseWorktree,
  removeAmbientFixtureRepository,
  runAmbientPiProcess,
  runAmbientWorkflowEvals,
  assertAmbientOptIn,
} from "../src/ambient-workflow-evals.js";

void test("ambient evals require explicit opt-in and execute capture safely", async () => {
  assert.throws(() => { assertAmbientOptIn({}); }, /PI_WORKFLOW_EVAL_AMBIENT=1/);
  const artifactsDir = mkdtempSync(join(tmpdir(), "pi-workflow-ambient-artifacts-"));
  const fakeRoot = mkdtempSync(join(tmpdir(), "pi-workflow-ambient-parent-"));
  const fakePi = join(fakeRoot, "fake-pi.mjs");
  writeFileSync(fakePi, `#!/usr/bin/env node\nimport { mkdirSync, writeFileSync } from "node:fs"; import { join } from "node:path"; const args = process.argv.slice(2); const value = name => args[args.indexOf(name) + 1]; const dir = value("--session-dir"); const id = value("--session-id"); mkdirSync(dir, { recursive: true }); const rows = [{ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: process.cwd() }, { type: "message", id: "call", parentId: null, timestamp: new Date().toISOString(), message: { role: "assistant", content: [{ type: "toolCall", id: "workflow-call", name: "workflow", arguments: { name: "ambient-capture", script: "return 'captured';", foreground: true } }], provider: "fake", model: "model", usage: { input: 2, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.001 } } } }, { type: "message", id: "result", parentId: "call", timestamp: new Date().toISOString(), message: { role: "toolResult", toolCallId: "workflow-call", toolName: "workflow", content: [{ type: "text", text: "captured" }], details: { captureIdentity: "pi-extensible-workflows-eval-capture-v1", realWorkflowAgentsLaunched: 0 }, isError: false } }]; writeFileSync(join(dir, "ambient.jsonl"), rows.map(JSON.stringify).join("\\n") + "\\n");`);
  chmodSync(fakePi, 0o755);
  const result = await runAmbientWorkflowEvals({
    cases: [{ id: "captured", prompt: "ignored", timeoutMs: 2_000, maxCost: 0.01 }],
    provider: "fake", model: "model", piCommand: fakePi, artifactsDir, environment: { PI_WORKFLOW_EVAL_AMBIENT: "1" },
  });
  const captured = result.cases[0];
  assert.ok(captured);
  assert.equal(captured.status, "passed");
  assert.equal(captured.manifest.invocationMode, "ambient-capture-only");
  assert.equal(captured.manifest.workflowCallCount, 1);
  assert.equal(captured.manifest.cleanup.captureIdentityVerified, true);
  assert.equal(captured.manifest.cleanup.realWorkflowAgentsLaunched, 0);
  assert.equal(captured.manifest.cleanup.worktreeRemoved, true);
  assert.equal(captured.manifest.cleanup.fixtureRepoRemoved, true);
  assert.equal(captured.manifest.cleanup.tempRootRemoved, true);
  assert.match(formatAmbientSummary(result), /Ambient Tier D \(ambient-capture-only\)/);
  assert.match(formatAmbientSummary(result), new RegExp(AMBIENT_CAPTURE_NOTE.slice(0, 24)));
  const artifact = JSON.parse(readFileSync(join(artifactsDir, "captured.json"), "utf8")) as { manifest: { fixtureFileList: string[] } };
  assert.ok(artifact.manifest.fixtureFileList.includes("package.json"));
  assert.ok(artifact.manifest.fixtureFileList.includes("README.md"));
});

void test("ambient fixture cases use separate disposable worktrees and clean success, failure, and timeout", async () => {
  const repository = createAmbientFixtureRepository();
  const fakeRoot = mkdtempSync(join(tmpdir(), "pi-workflow-ambient-fake-pi-"));
  const fakePi = join(fakeRoot, "fake-pi.mjs");
  writeFileSync(fakePi, `#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
writeFileSync(join(process.cwd(), "invocation.json"), JSON.stringify(args));
appendFileSync(join(process.cwd(), "src/score.js"), "\\n// edited only in this worktree\\n");
`);
  chmodSync(fakePi, 0o755);
  const original = readFileSync(join(repository.fixtureRoot, "src/score.js"), "utf8");
  const paths: string[] = [];
  try {
    const first = createAmbientCaseWorktree(repository, "first");
    paths.push(first.path);
    assert.deepEqual(first.gitStatusBefore, []);
    for (const file of ["package.json", "README.md", "tsconfig.json", "config/project.json", "src/score.js", "src/summary.js", "test/score.test.js", "test/summary.test.js"]) assert.ok(existsSync(join(first.path, file)), file);
    const packageJson = JSON.parse(readFileSync(join(first.path, "package.json"), "utf8")) as { scripts: { test: string; lint: string } };
    assert.equal(packageJson.scripts.test, "node --test test/*.test.js");
    assert.equal(packageJson.scripts.lint.includes("server"), false);
    const success = await runAmbientPiProcess({ worktree: first.path, sessionDir: join(repository.root, "sessions", "first"), prompt: "ignored", provider: "fake", model: "model", piCommand: fakePi, timeoutMs: 2_000, maxCost: 1 });
    assert.equal(success.exitCode, 0);
    assert.equal(success.timedOut, false);
    assert.ok(JSON.parse(readFileSync(join(first.path, "invocation.json"), "utf8")) instanceof Array);
    const args = JSON.parse(readFileSync(join(first.path, "invocation.json"), "utf8")) as string[];
    for (const forbidden of ["--no-extensions", "--no-skills", "--no-context-files", "--no-builtin-tools", "--tools"]) assert.equal(args.includes(forbidden), false, forbidden);
    assert.equal(args.includes("--extension"), true);
    assert.equal(args.includes("--provider"), true);
    assert.equal(args.includes("--model"), true);
    assert.notEqual(readFileSync(join(first.path, "src/score.js"), "utf8"), original);
    assert.equal(readFileSync(join(repository.fixtureRoot, "src/score.js"), "utf8"), original);
    assert.equal(removeAmbientCaseWorktree(repository, first), true);
    assert.equal(existsSync(first.path), false);

    const second = createAmbientCaseWorktree(repository, "second");
    paths.push(second.path);
    assert.notEqual(second.path, paths[0]);
    const failingPi = join(fakeRoot, "failing-pi.mjs");
    writeFileSync(failingPi, "#!/usr/bin/env node\nprocess.exit(7);\n");
    chmodSync(failingPi, 0o755);
    const failure = await runAmbientPiProcess({ worktree: second.path, sessionDir: join(repository.root, "sessions", "second"), prompt: "ignored", provider: "fake", model: "model", piCommand: failingPi, timeoutMs: 2_000, maxCost: 1 });
    assert.equal(failure.exitCode, 7);
    assert.equal(failure.timedOut, false);
    assert.equal(removeAmbientCaseWorktree(repository, second), true);
    assert.equal(existsSync(second.path), false);

    const third = createAmbientCaseWorktree(repository, "timeout");
    const slowPi = join(fakeRoot, "slow-pi.mjs");
    writeFileSync(slowPi, "#!/usr/bin/env node\nsetInterval(() => {}, 1_000);\n");
    chmodSync(slowPi, 0o755);
    const timeout = await runAmbientPiProcess({ worktree: third.path, sessionDir: join(repository.root, "sessions", "timeout"), prompt: "ignored", provider: "fake", model: "model", piCommand: slowPi, timeoutMs: 50, maxCost: 1 });
    assert.equal(timeout.timedOut, true);
    assert.equal(timeout.processGroupTerminated, true);
    assert.equal(removeAmbientCaseWorktree(repository, third), true);
    assert.equal(existsSync(third.path), false);
  } finally {
    assert.equal(removeAmbientFixtureRepository(repository), true);
    assert.equal(existsSync(repository.root), false);
    assert.equal(paths.every((path) => !existsSync(path)), true);
  }
});
