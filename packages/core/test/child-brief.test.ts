import assert from "node:assert/strict";
import test from "node:test";
import {
  CHILD_BRIEF_CHANGES_POLICIES,
  CHILD_BRIEF_REPORT_MODES,
  type ChildBriefChangesPolicy,
  type ChildBriefReportMode,
  type GovernedChildBrief,
  WorkflowError,
} from "../src/types.js";
import { preflight, validateAgentOptions, validateChildBrief } from "../src/validation.js";
import { WorkflowAgentExecutor, type AgentExecutionRoot } from "../src/agent-execution.js";

void test("child brief vocabulary defines shared changes and report policies", () => {
  const expectedChanges = ["none", "commit", "keep"] as const satisfies readonly ChildBriefChangesPolicy[];
  const expectedReports = ["minimal", "full", "evidence"] as const satisfies readonly ChildBriefReportMode[];
  assert.deepEqual(CHILD_BRIEF_CHANGES_POLICIES, expectedChanges);
  assert.deepEqual(CHILD_BRIEF_REPORT_MODES, expectedReports);
});

void test("validateChildBrief accepts valid complete and minimal briefs", () => {
  const minimal: GovernedChildBrief = { prompt: "Run targeted analysis" };
  assert.deepEqual(validateChildBrief(minimal), minimal);

  const full: GovernedChildBrief = {
    prompt: "Investigate security boundary",
    intent: "Security audit",
    changes: "none",
    tools: ["read", "grep"],
    excludeTools: ["bash"],
    outputSchema: { type: "object", properties: { verdict: { type: "string" } } },
    report: "evidence",
    timeoutMs: 30000,
  };
  assert.deepEqual(validateChildBrief(full), full);
});

void test("validateChildBrief rejects non-objects and unknown properties", () => {
  for (const bad of [null, undefined, "prompt", 42, [], true]) {
    assert.throws(
      () => validateChildBrief(bad),
      (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA",
      JSON.stringify(bad),
    );
  }

  assert.throws(
    () => validateChildBrief({ prompt: "Do work", unknownKey: "forbidden" }),
    (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA" && /unknown/i.test(error.message),
  );
});

void test("validateChildBrief enforces policies and types strictly", () => {
  assert.throws(
    () => validateChildBrief({ prompt: "" }),
    (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA",
  );
  assert.throws(
    () => validateChildBrief({ prompt: "ok", changes: "invalid" as unknown as ChildBriefChangesPolicy }),
    (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA",
  );
  assert.throws(
    () => validateChildBrief({ prompt: "ok", report: "unsupported" as unknown as ChildBriefReportMode }),
    (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA",
  );
  assert.throws(
    () => validateChildBrief({ prompt: "ok", timeoutMs: -1 }),
    (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA",
  );
  assert.throws(
    () => validateChildBrief({ prompt: "ok", excludeTools: ["workflow_result"] }),
    (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA",
  );
});

void test("validateAgentOptions recognizes brief as a core option and validates it", () => {
  const options = {
    label: "auditor",
    brief: {
      prompt: "Review diff",
      changes: "none" as const,
      report: "minimal" as const,
    },
  };
  assert.deepEqual(validateAgentOptions(options), options);

  assert.throws(
    () => validateAgentOptions({ brief: { prompt: "ok", changes: "bad-change-policy" as unknown as ChildBriefChangesPolicy } }),
    (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA",
  );
});

void test("workflow preflight validates static child briefs in scripts", () => {
  const capabilities = {
    models: new Set(["fixture/model:high"]),
    tools: new Set(["read", "write"]),
  };

  assert.doesNotThrow(() => {
    preflight(
      `agent("Investigate", { brief: { prompt: "Investigate", changes: "none", report: "evidence" } });`,
      capabilities,
    );
  });

  assert.throws(
    () => {
      preflight(
        `agent("Investigate", { brief: { prompt: "Investigate", changes: "corrupt" } });`,
        capabilities,
      );
    },
    (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA",
  );
});

void test("brief changes: none automatically excludes mutating tools", async () => {
  const root: AgentExecutionRoot = {
    cwd: process.cwd(),
    projectTrusted: false,
    model: { provider: "fixture", model: "fixture-model" },
    tools: new Set(["read", "write", "edit", "replace_in_file", "apply_patch", "bash"]),
    knownModels: new Set(["fixture/fixture-model"]),
    availableModels: new Set(["fixture/fixture-model"]),
  };
  const executor = new WorkflowAgentExecutor(root);

  const confReadOnly = await executor.prepare({
    label: "auditor",
    workflowName: "governance",
    agentOptions: {
      brief: {
        prompt: "Audit only",
        changes: "none",
      },
    },
  });
  assert.deepEqual(confReadOnly.tools, ["read", "bash"]);

  const confCustomExclude = await executor.prepare({
    label: "auditor",
    workflowName: "governance",
    agentOptions: {
      brief: {
        prompt: "Audit only",
        changes: "none",
        excludeTools: ["bash"],
      },
    },
  });
  assert.deepEqual(confCustomExclude.tools, ["read"]);
});

