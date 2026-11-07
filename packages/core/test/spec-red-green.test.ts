import assert from "node:assert/strict";
import test from "node:test";
import { specRedGreen } from "../starter/spec-red-green.js";
import type { SpecVerdict } from "../starter/spec-contract.js";
import type { ShellResult, WorkflowFunctionContext } from "../src/index.js";

const input = {
  specPath: "/tmp/spec.md",
  worktree: "spec-red-green",
  redCommand: "npm test -- red",
  greenCommand: "npm test -- green",
  timeoutMs: 25,
};

const spec = [
  "## Specs",
  "S1: User can log in",
  "S2: User can log out",
  "",
  "## Tasks",
  "T1 Spec: S1",
  "T2 Spec: S2",
].join("\n");

const verdicts: SpecVerdict[] = [
  { requirementId: "S1", verdict: "pass", evidence: ["login test"] },
  { requirementId: "S2", verdict: "pass", evidence: ["logout test"] },
];

function redGreenShell(): ShellResult[] {
  return [
    { exitCode: 0, stdout: spec, stderr: "" },
    { exitCode: 1, stdout: "", stderr: "red failed" },
    { exitCode: 0, stdout: "", stderr: "" },
  ];
}

function contextFor(
  shellResults: readonly ShellResult[],
  options: { approved?: boolean; writtenVerdicts?: SpecVerdict[]; checkpointError?: Error; worktreeError?: Error; agentError?: Error } = {},
): { context: WorkflowFunctionContext; calls: string[]; checkpoints: number; worktrees: number; worktreeNames: string[]; agents: number; agentPolicies: { role: unknown; contextFiles: unknown; skills: unknown }[] } {
  let shellIndex = 0;
  let checkpoints = 0;
  let worktrees = 0;
  let agents = 0;
  const calls: string[] = [];
  const worktreeNames: string[] = [];
  const agentPolicies: { role: unknown; contextFiles: unknown; skills: unknown }[] = [];
  const context = {
    shell: async (command: string) => {
      calls.push(command);
      return shellResults[shellIndex++] ?? { exitCode: 0, stdout: "", stderr: "" };
    },
    checkpoint: async () => {
      checkpoints += 1;
      if (options.checkpointError) throw options.checkpointError;
      return options.approved ?? true;
    },
    withWorktree: async (name: string, callback: (reference: { path: string; branch: string }) => unknown) => {
      worktrees += 1;
      worktreeNames.push(name);
      if (options.worktreeError) throw options.worktreeError;
      return callback({ path: "/actual/worktree", branch: "spec-red-green" });
    },
    agent: Object.assign(async (_prompt: string, agentCallOptions?: Readonly<Record<string, unknown>>) => {
      agents += 1;
      agentPolicies.push({ role: agentCallOptions?.role, contextFiles: agentCallOptions?.contextFiles, skills: agentCallOptions?.skills });
      if (options.agentError) throw options.agentError;
      return { verdicts: options.writtenVerdicts ?? verdicts };
    }, { create: () => { throw new Error("unused"); } }),
  } as unknown as WorkflowFunctionContext;
  return {
    context,
    calls,
    worktreeNames,
    agentPolicies,
    get checkpoints() { return checkpoints; },
    get worktrees() { return worktrees; },
    get agents() { return agents; },
  };
}

void test("runs RED, writer, and GREEN and returns complete verdicts", async () => {
  const harness = contextFor(redGreenShell());

  const result = await specRedGreen.run(input, harness.context);

  assert.deepEqual(result, { ok: true, requirements: 2, verdicts, problems: [] });
  assert.deepEqual(harness.calls, ["cat -- '/tmp/spec.md'", "npm test -- red", "npm test -- green"]);
  assert.equal(harness.checkpoints, 1);
  assert.equal(harness.worktrees, 1);
  assert.equal(harness.agents, 1);
  assert.deepEqual(harness.agentPolicies, [{
    role: "developer",
    contextFiles: ["global", "project", "cwd"],
    skills: ["engineering-excellence", "tigerstyle", "typescript-advanced"],
  }]);
});

void test("returns the parser message without reaching the checkpoint", async () => {
  const harness = contextFor([
    { exitCode: 0, stdout: "## Specs\nnot a requirement", stderr: "" },
  ]);

  const result = await specRedGreen.run(input, harness.context);

  assert.deepEqual(result, { ok: false, requirements: 0, verdicts: [], problems: ["Invalid spec line 2: expected an S-id requirement"] });
  assert.equal(harness.checkpoints, 0);
  assert.equal(harness.worktrees, 0);
});

void test("rejects a spec with no requirements before the checkpoint", async () => {
  const harness = contextFor([
    { exitCode: 0, stdout: "## Tasks\nT1 Spec: S1", stderr: "" },
  ]);

  const result = await specRedGreen.run(input, harness.context);

  assert.deepEqual(result, {
    ok: false,
    requirements: 0,
    verdicts: [],
    problems: ["Spec has no requirements: expected a '## Specs' section with S-id lines."],
  });
  assert.equal(harness.checkpoints, 0);
  assert.equal(harness.worktrees, 0);
});

void test("stops when the pinned spec is declined", async () => {
  const harness = contextFor([{ exitCode: 0, stdout: spec, stderr: "" }], { approved: false });

  const result = await specRedGreen.run(input, harness.context);

  assert.deepEqual(result, { ok: false, requirements: 2, verdicts: [], problems: ["Spec was not approved."] });
  assert.equal(harness.worktrees, 0);
  assert.equal(harness.agents, 0);
});

void test("returns checkpoint host failures", async () => {
  const harness = contextFor([{ exitCode: 0, stdout: spec, stderr: "" }], { checkpointError: new Error("checkpoint unavailable") });

  const result = await specRedGreen.run(input, harness.context);

  assert.deepEqual(result, { ok: false, requirements: 2, verdicts: [], problems: ["Checkpoint failed: checkpoint unavailable"] });
  assert.equal(harness.worktrees, 0);
});

void test("returns withWorktree host failures", async () => {
  const harness = contextFor([{ exitCode: 0, stdout: spec, stderr: "" }], { worktreeError: new Error("worktree unavailable") });

  const result = await specRedGreen.run(input, harness.context);

  assert.deepEqual(result, { ok: false, requirements: 2, verdicts: [], problems: ["withWorktree failed: worktree unavailable"] });
  assert.equal(harness.worktrees, 1);
  assert.equal(harness.agents, 0);
});

void test("rejects a RED command that passes", async () => {
  const harness = contextFor([
    { exitCode: 0, stdout: spec, stderr: "" },
    { exitCode: 0, stdout: "", stderr: "" },
  ]);

  const result = await specRedGreen.run(input, harness.context);

  assert.deepEqual(result, { ok: false, requirements: 2, verdicts: [], problems: ["RED passed, which proves nothing."] });
  assert.equal(harness.agents, 0);
});

void test("reports a non-zero GREEN exit code", async () => {
  const harness = contextFor([
    { exitCode: 0, stdout: spec, stderr: "" },
    { exitCode: 1, stdout: "", stderr: "red failed" },
    { exitCode: 7, stdout: "", stderr: "green failed" },
  ]);

  const result = await specRedGreen.run(input, harness.context);

  assert.deepEqual(result, { ok: false, requirements: 2, verdicts, problems: ["GREEN failed with exit code 7."] });
});

void test("returns coverage problems from the writer verdicts", async () => {
  const incompleteVerdicts = [verdicts[0] as SpecVerdict];
  const harness = contextFor(redGreenShell(), { writtenVerdicts: incompleteVerdicts });

  const result = await specRedGreen.run(input, harness.context);

  assert.deepEqual(result, { ok: false, requirements: 2, verdicts: incompleteVerdicts, problems: ["Spec S2 has no verdict."] });
});

void test("rejects a writer verdict with empty evidence", async () => {
  const incompleteEvidenceVerdicts: SpecVerdict[] = [
    { requirementId: "S1", verdict: "pass", evidence: [] },
    { requirementId: "S2", verdict: "pass", evidence: ["logout test"] },
  ];
  const harness = contextFor(redGreenShell(), { writtenVerdicts: incompleteEvidenceVerdicts });

  const result = await specRedGreen.run(input, harness.context);

  assert.deepEqual(result, {
    ok: false,
    requirements: 2,
    verdicts: incompleteEvidenceVerdicts,
    problems: ["Verdict for spec S1 has no evidence."],
  });
});

void test("rejects a writer verdict recording a failure", async () => {
  const failedVerdicts: SpecVerdict[] = [
    { requirementId: "S1", verdict: "fail", evidence: ["login test failed"] },
    { requirementId: "S2", verdict: "pass", evidence: ["logout test"] },
  ];
  const harness = contextFor(redGreenShell(), { writtenVerdicts: failedVerdicts });

  const result = await specRedGreen.run(input, harness.context);

  assert.deepEqual(result, {
    ok: false,
    requirements: 2,
    verdicts: failedVerdicts,
    problems: ["Verdict for spec S1 is fail, not pass."],
  });
});

void test("trims the worktree name before handing it to withWorktree", async () => {
  const harness = contextFor(redGreenShell());

  const result = await specRedGreen.run({ ...input, worktree: "  spec-red-green  " }, harness.context);

  assert.deepEqual(result, { ok: true, requirements: 2, verdicts, problems: [] });
  assert.deepEqual(harness.worktreeNames, ["spec-red-green"]);
});

void test("quotes a semicolon-containing spec path as one shell argument", async () => {
  const harness = contextFor(redGreenShell());

  const result = await specRedGreen.run({ ...input, specPath: "/tmp/spec.md; echo INJECTED" }, harness.context);

  assert.deepEqual(result, { ok: true, requirements: 2, verdicts, problems: [] });
  assert.equal(harness.calls[0], "cat -- '/tmp/spec.md; echo INJECTED'");
});

void test("passes shell substitutions in commands through unchanged", async () => {
  const harness = contextFor(redGreenShell());

  const result = await specRedGreen.run({ ...input, redCommand: 'echo "$HOME"', greenCommand: "echo $(echo green)" }, harness.context);

  assert.deepEqual(result, { ok: true, requirements: 2, verdicts, problems: [] });
  assert.deepEqual(harness.calls, ["cat -- '/tmp/spec.md'", 'echo "$HOME"', "echo $(echo green)"]);
});

void test("rejects an empty worktree before host calls", async () => {
  const harness = contextFor([]);

  const result = await specRedGreen.run({ ...input, worktree: "" }, harness.context);

  assert.deepEqual(result, { ok: false, requirements: 0, verdicts: [], problems: ["worktree must be non-empty."] });
  assert.equal(harness.calls.length, 0);
});

void test("rejects a worktree with a leading dash before host calls", async () => {
  const harness = contextFor([]);

  const result = await specRedGreen.run({ ...input, worktree: "-feature" }, harness.context);

  assert.deepEqual(result, { ok: false, requirements: 0, verdicts: [], problems: ["worktree must not start with '-'."] });
  assert.equal(harness.calls.length, 0);
});

void test("rejects a worktree path before host calls", async () => {
  const harness = contextFor([]);

  const result = await specRedGreen.run({ ...input, worktree: "/tmp/feature" }, harness.context);

  assert.deepEqual(result, { ok: false, requirements: 0, verdicts: [], problems: ["worktree must not contain path separators."] });
  assert.equal(harness.calls.length, 0);
});

void test("rejects forbidden spec path characters before reading the spec", async () => {
  const harness = contextFor([]);

  const result = await specRedGreen.run({ ...input, specPath: "/tmp/spec'evil.md" }, harness.context);

  assert.deepEqual(result, { ok: false, requirements: 0, verdicts: [], problems: ["specPath contains forbidden shell characters."] });
  assert.equal(harness.calls.length, 0);
  assert.equal(harness.checkpoints, 0);
  assert.equal(harness.worktrees, 0);
});
