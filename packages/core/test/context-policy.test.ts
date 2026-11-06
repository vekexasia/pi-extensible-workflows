import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTEXT_POLICIES,
  contextPolicyFor,
  missingSkillPaths,
  type StarterRole,
} from "../starter/context-policy.js";
import { reviewLoop } from "../starter/review-loop.js";
import type { WorkflowFunctionContext } from "../src/index.js";

const roles = ["developer", "reviewer", "researcher", "scout", "oracle"] as const satisfies readonly StarterRole[];

void test("resolves every role to its own total policy", () => {
  assert.deepEqual(Object.keys(CONTEXT_POLICIES).sort(), [...roles].sort());
  for (const role of roles) assert.equal(contextPolicyFor(role), CONTEXT_POLICIES[role]);
});

void test("rejects an unknown role by naming it", () => {
  assert.throws(() => contextPolicyFor("unknown-role"), /unknown-role/);
});

void test("reports missing skills in policy order", () => {
  const policies = [CONTEXT_POLICIES.developer, CONTEXT_POLICIES.reviewer];
  const installed = (skill: string) => skill === policies[0]?.skills[0] ? `/skills/${skill}/SKILL.md` : undefined;

  assert.deepEqual(missingSkillPaths(policies, installed), [
    ...policies[0]?.skills.slice(1).map((skill) => ({ role: "developer", skill })) ?? [],
    ...policies[1]?.skills.map((skill) => ({ role: "reviewer", skill })) ?? [],
  ]);
});

void test("returns no missing skills when every listed skill is installed", () => {
  assert.deepEqual(missingSkillPaths(Object.values(CONTEXT_POLICIES), (skill) => `/skills/${skill}/SKILL.md`), []);
});

void test("reviewLoop passes each role's complete context policy to its agents", async () => {
  const calls: { role: string | undefined; contextFiles: readonly string[] | undefined; skills: readonly string[] | undefined }[] = [];
  const reviewerResult = { pass: true, findings: [] as string[] };
  const agent = Object.assign(
    async (_prompt: string, options?: Readonly<{ role?: string; contextFiles?: readonly string[]; skills?: readonly string[] }>) => {
      calls.push({ role: options?.role, contextFiles: options?.contextFiles, skills: options?.skills });
      return reviewerResult;
    },
    {
      create: (options: Readonly<{ name: string; role?: string; contextFiles?: readonly string[]; skills?: readonly string[] }>) => {
        calls.push({ role: options.role, contextFiles: options.contextFiles, skills: options.skills });
        return { name: options.name, send: async () => "implemented" };
      },
    },
  );
  const context = { agent, prompt: (template: string) => template } as unknown as WorkflowFunctionContext;

  await reviewLoop.run({ task: "Implement the change", maxIterations: 1 }, context);

  assert.deepEqual(calls, [
    {
      role: "developer",
      contextFiles: ["global", "project", "cwd"],
      skills: ["engineering-excellence", "tigerstyle", "typescript-advanced"],
    },
    {
      role: "reviewer",
      contextFiles: ["global", "project"],
      skills: ["code-review", "tigerstyle"],
    },
  ]);
});
