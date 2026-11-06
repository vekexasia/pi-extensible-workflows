import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSpecDocument,
  parseTaskSpecLinks,
  validateSpecCoverage,
  type SpecRequirement,
} from "../starter/spec-contract.js";

void test("parses requirements and task spec links from their sections", () => {
  const markdown = `# Contract

## Specs
S1. Retries stop after three attempts.
S2) Rejects an empty id:
S3: Keeps the message verbatim.

## Tasks
T1 Implement retries. Spec: S1, S2
T2 Preserve the message. Spec: S3

## Notes
This is not part of the contract.
`;

  assert.deepEqual(parseSpecDocument(markdown), [
    { id: "S1", statement: "Retries stop after three attempts." },
    { id: "S2", statement: "Rejects an empty id:" },
    { id: "S3", statement: "Keeps the message verbatim." },
  ]);
  assert.deepEqual(parseTaskSpecLinks(markdown), [
    { taskId: "T1", specIds: ["S1", "S2"] },
    { taskId: "T2", specIds: ["S3"] },
  ]);
});

void test("returns no requirements when the Specs section is missing", () => {
  assert.deepEqual(parseSpecDocument("# Contract\n## Tasks\nT1 Implement it. Spec: S1\n"), []);
});

void test("returns no task links when the Tasks section is missing", () => {
  assert.deepEqual(parseTaskSpecLinks("# Contract\n## Specs\nS1. First.\n"), []);
});

void test("ignores task lines without a Spec fragment", () => {
  assert.deepEqual(
    parseTaskSpecLinks("## Tasks\nT1 Implement it. Spec: S1\nT2 Document it without a link.\n"),
    [{ taskId: "T1", specIds: ["S1"] }],
  );
});

void test("rejects a duplicate spec id with its document line and no partial data", () => {
  let result: SpecRequirement[] | undefined;
  assert.throws(
    () => {
      result = parseSpecDocument("## Specs\nS1. First\nS1) Second\n");
    },
    /duplicate spec id S1 on line 3/i,
  );
  assert.equal(result, undefined);
});

void test("rejects an empty statement with its document line and no partial data", () => {
  let result: SpecRequirement[] | undefined;
  assert.throws(
    () => {
      result = parseSpecDocument("# Contract\n## Specs\nS1.   \n");
    },
    /empty statement for S1 on line 3/i,
  );
  assert.equal(result, undefined);
});

void test("rejects a Specs section with no requirements", () => {
  let result: SpecRequirement[] | undefined;
  assert.throws(
    () => {
      result = parseSpecDocument("# Contract\n## Specs\n\n## Tasks\n");
    },
    /## Specs section has no requirements/i,
  );
  assert.equal(result, undefined);
});

void test("rejects a non-requirement line inside Specs with its document line", () => {
  let result: SpecRequirement[] | undefined;
  assert.throws(
    () => {
      result = parseSpecDocument("## Specs\nnot a requirement\n");
    },
    /invalid spec line 2/i,
  );
  assert.equal(result, undefined);
});

void test("rejects a task that repeats a spec id with its document line and no partial data", () => {
  let result: { taskId: string; specIds: string[] }[] | undefined;
  assert.throws(
    () => {
      result = parseTaskSpecLinks("## Tasks\nT1 Implement it. Spec: S1, S1\n");
    },
    /duplicate spec id S1 in task T1 on line 2/i,
  );
  assert.equal(result, undefined);
});

void test("accepts exact spec coverage", () => {
  const spec = [
    { id: "S1", statement: "First." },
    { id: "S2", statement: "Second." },
  ] as const;
  const tasks = [
    { taskId: "T1", specIds: ["S1"] },
    { taskId: "T2", specIds: ["S2"] },
  ] as const;
  const verdicts = [
    { requirementId: "S1", verdict: "pass", evidence: ["test 1"] },
    { requirementId: "S2", verdict: "unverified", evidence: ["not run"] },
  ] as const;

  assert.deepEqual(validateSpecCoverage(spec, tasks, verdicts), { ok: true, problems: [] });
});

void test("reports a missing verdict by spec id", () => {
  const result = validateSpecCoverage(
    [{ id: "S1", statement: "First." }, { id: "S2", statement: "Second." }],
    [{ taskId: "T1", specIds: ["S1", "S2"] }],
    [{ requirementId: "S1", verdict: "pass", evidence: [] }],
  );

  assert.deepEqual(result, {
    ok: false,
    problems: [
      "Spec S2 has no verdict.",
      "Verdict for spec S1 has no evidence.",
    ],
  });
});

void test("reports duplicate verdicts by spec id", () => {
  const result = validateSpecCoverage(
    [{ id: "S1", statement: "First." }],
    [{ taskId: "T1", specIds: ["S1"] }],
    [
      { requirementId: "S1", verdict: "pass", evidence: ["passed"] },
      { requirementId: "S1", verdict: "fail", evidence: ["failed"] },
    ],
  );

  assert.deepEqual(result, {
    ok: false,
    problems: ["Duplicate verdict for spec S1."],
  });
});

void test("reports a verdict for an unknown spec id", () => {
  const result = validateSpecCoverage(
    [{ id: "S1", statement: "First." }],
    [{ taskId: "T1", specIds: ["S1"] }],
    [
      { requirementId: "S1", verdict: "pass", evidence: [] },
      { requirementId: "S9", verdict: "fail", evidence: ["test 9"] },
    ],
  );

  assert.deepEqual(result, {
    ok: false,
    problems: [
      "Verdict for spec S1 has no evidence.",
      "Verdict references unknown spec id S9.",
    ],
  });
});

void test("reports a task that references an unknown spec id", () => {
  const result = validateSpecCoverage(
    [{ id: "S1", statement: "First." }],
    [{ taskId: "T1", specIds: ["S1", "S9"] }],
    [{ requirementId: "S1", verdict: "pass", evidence: [] }],
  );

  assert.deepEqual(result, {
    ok: false,
    problems: [
      "Task T1 references unknown spec id S9.",
      "Verdict for spec S1 has no evidence.",
    ],
  });
});

void test("reports a spec id referenced by no task", () => {
  const result = validateSpecCoverage(
    [{ id: "S1", statement: "First." }, { id: "S2", statement: "Second." }],
    [{ taskId: "T1", specIds: ["S1"] }],
    [
      { requirementId: "S1", verdict: "pass", evidence: [] },
      { requirementId: "S2", verdict: "pass", evidence: [] },
    ],
  );

  assert.deepEqual(result, {
    ok: false,
    problems: [
      "Spec S2 is referenced by no task.",
      "Verdict for spec S1 has no evidence.",
      "Verdict for spec S2 has no evidence.",
    ],
  });
});

void test("reports a task with no existing spec reference", () => {
  const result = validateSpecCoverage(
    [{ id: "S1", statement: "First." }],
    [{ taskId: "T1", specIds: [] }],
    [{ requirementId: "S1", verdict: "pass", evidence: [] }],
  );

  assert.deepEqual(result, {
    ok: false,
    problems: [
      "Task T1 references no existing spec id.",
      "Spec S1 is referenced by no task.",
      "Verdict for spec S1 has no evidence.",
    ],
  });
});

void test("reports a verdict with no evidence by spec id", () => {
  const result = validateSpecCoverage(
    [{ id: "S1", statement: "First." }, { id: "S2", statement: "Second." }],
    [{ taskId: "T1", specIds: ["S1", "S2"] }],
    [
      { requirementId: "S1", verdict: "pass", evidence: [] },
      { requirementId: "S2", verdict: "fail", evidence: ["failed"] },
    ],
  );

  assert.deepEqual(result, {
    ok: false,
    problems: ["Verdict for spec S1 has no evidence."],
  });
});
