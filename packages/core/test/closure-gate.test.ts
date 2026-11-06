import assert from "node:assert/strict";
import test from "node:test";
import { closureDigest, closureGate } from "../starter/closure-gate.js";
import type { ShellResult, WorkflowFunctionContext } from "../src/index.js";

const input = { worktree: "closure-gate" };
const head = "abc123";
const diff = "diff --git a/file b/file\n";
const digest = "a852ae8ac61a0407ba03a7bca20fc13daca5350f2e0929ff4cba2c95e3355f8a";

function contextFor(
  shellResults: readonly (ShellResult | Error)[],
): { context: WorkflowFunctionContext; calls: { command: string; timeoutMs?: number | undefined }[]; worktrees: number } {
  let shellIndex = 0;
  let worktrees = 0;
  const calls: { command: string; timeoutMs?: number | undefined }[] = [];
  const context = {
    shell: async (command: string, options?: { timeoutMs?: number }) => {
      calls.push({ command, timeoutMs: options?.timeoutMs });
      const result = shellResults[shellIndex++];
      if (result instanceof Error) throw result;
      return result ?? { exitCode: 0, stdout: "", stderr: "" };
    },
    withWorktree: async (_name: string, callback: (reference: { path: string; branch: string }) => unknown) => {
      worktrees += 1;
      return callback({ path: "/actual/worktree", branch: "closure-gate" });
    },
  } as unknown as WorkflowFunctionContext;
  return { context, calls, get worktrees() { return worktrees; } };
}

function cleanHarness(): ReturnType<typeof contextFor> {
  return contextFor([
    { exitCode: 0, stdout: `${head}\n`, stderr: "" },
    { exitCode: 0, stdout: "", stderr: "" },
    { exitCode: 0, stdout: diff, stderr: "" },
  ]);
}

function untrackedHarness(): ReturnType<typeof contextFor> {
  return contextFor([
    { exitCode: 0, stdout: `${head}\n`, stderr: "" },
    { exitCode: 0, stdout: "?? extra.txt\n", stderr: "" },
    { exitCode: 0, stdout: diff, stderr: "" },
  ]);
}

void test("a clean tree returns the exact head and digest", async () => {
  const harness = cleanHarness();

  const result = await closureGate.run(input, harness.context);

  assert.deepEqual(result, { ok: true, head, digest, problems: [] });
  assert.deepEqual(harness.calls, [
    { command: "git rev-parse HEAD", timeoutMs: 120_000 },
    { command: "git status --porcelain=v1 --untracked-files=all", timeoutMs: 120_000 },
    { command: "git diff --no-ext-diff --no-color HEAD --", timeoutMs: 120_000 },
  ]);
  assert.equal(harness.worktrees, 1);
});

void test("an untracked path not in the allowlist is a problem", async () => {
  const harness = untrackedHarness();

  const result = await closureGate.run(input, harness.context);

  assert.deepEqual(result, { ok: false, head, digest, problems: ["Untracked path is not allowed: extra.txt"] });
});

void test("an allowed untracked path does not fail the gate", async () => {
  const harness = untrackedHarness();

  const result = await closureGate.run({ ...input, allowedUntracked: ["extra.txt"] }, harness.context);

  assert.deepEqual(result, { ok: true, head, digest, problems: [] });
});

void test("a host shell failure is returned and never thrown", async () => {
  const harness = contextFor([new Error("shell unavailable")]);

  const result = await closureGate.run(input, harness.context);

  assert.deepEqual(result, { ok: false, head: "", digest: "", problems: ["git rev-parse HEAD failed: shell unavailable"] });
});

void test("an expected digest mismatch names both digests", async () => {
  const harness = cleanHarness();

  const result = await closureGate.run({ ...input, expectedDigest: "0".repeat(64) }, harness.context);

  assert.deepEqual(result, {
    ok: false,
    head,
    digest,
    problems: [`Expected digest ${"0".repeat(64)} does not match computed digest ${digest}.`],
  });
});

void test("a matching expected digest passes", async () => {
  const harness = cleanHarness();

  const result = await closureGate.run({ ...input, expectedDigest: digest }, harness.context);

  assert.deepEqual(result, { ok: true, head, digest, problems: [] });
});

void test("an empty worktree fails before any host call", async () => {
  const harness = contextFor([]);

  const result = await closureGate.run({ worktree: "" }, harness.context);

  assert.deepEqual(result, { ok: false, head: "", digest: "", problems: ["worktree must be non-empty."] });
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.worktrees, 0);
});

void test("a separator-containing worktree fails before any host call", async () => {
  const harness = contextFor([]);

  const result = await closureGate.run({ worktree: "feature/one" }, harness.context);

  assert.deepEqual(result, { ok: false, head: "", digest: "", problems: ["worktree must not contain path separators."] });
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.worktrees, 0);
});

void test("a baseRef with a disallowed character fails before any host call", async () => {
  const harness = contextFor([]);

  const result = await closureGate.run({ ...input, baseRef: "main;git status" }, harness.context);

  assert.deepEqual(result, { ok: false, head: "", digest: "", problems: ["baseRef contains disallowed characters."] });
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.worktrees, 0);
});

void test("a baseRef of two dashes fails before any host call", async () => {
  const harness = contextFor([]);

  const result = await closureGate.run({ ...input, baseRef: "--" }, harness.context);

  assert.deepEqual(result, { ok: false, head: "", digest: "", problems: ["baseRef must start with an alphanumeric character."] });
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.worktrees, 0);
});

void test("an empty baseRef fails before any host call", async () => {
  const harness = contextFor([]);

  const result = await closureGate.run({ ...input, baseRef: "" }, harness.context);

  assert.deepEqual(result, { ok: false, head: "", digest: "", problems: ["baseRef must be non-empty when supplied."] });
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.worktrees, 0);
});

void test("an empty HEAD is a problem instead of a clean tree", async () => {
  const harness = contextFor([{ exitCode: 0, stdout: "\n", stderr: "" }]);

  const result = await closureGate.run(input, harness.context);

  assert.deepEqual(result, {
    ok: false,
    head: "",
    digest: "",
    problems: ["git rev-parse HEAD returned an empty or truncated commit id."],
  });
  assert.equal(harness.calls.length, 1);
});

void test("an empty diff with tracked modifications is an inconsistency", async () => {
  const harness = contextFor([
    { exitCode: 0, stdout: `${head}\n`, stderr: "" },
    { exitCode: 0, stdout: " M file.txt\n", stderr: "" },
    { exitCode: 0, stdout: "", stderr: "" },
  ]);

  const result = await closureGate.run({ ...input, expectedDigest: closureDigest(head, "") }, harness.context);

  assert.deepEqual(result, {
    ok: false,
    head,
    digest: closureDigest(head, ""),
    problems: ["git diff produced no output while git status lists tracked modifications: file.txt"],
  });
});

void test("a dirty tracked tree without an expected digest is a problem", async () => {
  const harness = contextFor([
    { exitCode: 0, stdout: `${head}\n`, stderr: "" },
    { exitCode: 0, stdout: " M file.txt\n", stderr: "" },
    { exitCode: 0, stdout: diff, stderr: "" },
  ]);

  const result = await closureGate.run(input, harness.context);

  assert.deepEqual(result, {
    ok: false,
    head,
    digest,
    problems: ["Tracked modifications without a pinned expectedDigest cannot establish provenance: file.txt"],
  });
});

void test("a dot-segment worktree fails before any host call", async () => {
  const harness = contextFor([]);

  const result = await closureGate.run({ worktree: ".." }, harness.context);

  assert.deepEqual(result, { ok: false, head: "", digest: "", problems: ["worktree must not be a dot segment."] });
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.worktrees, 0);
});

void test("closureDigest is deterministic and changes when the diff changes", () => {
  const first = closureDigest(head, diff);
  const second = closureDigest(head, diff);
  const changed = closureDigest(head, `${diff}changed\n`);

  assert.equal(first, second);
  assert.notEqual(first, changed);
});
