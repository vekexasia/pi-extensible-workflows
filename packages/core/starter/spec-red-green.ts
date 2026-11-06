import { Type } from "typebox";
import { defineWorkflowFunction, errorText } from "../src/index.js";
import { contextPolicyFor } from "./context-policy.js";
import { parseSpecDocument, parseTaskSpecLinks, validateSpecCoverage } from "./spec-contract.js";

const verdictSchema = Type.Object(
  {
    requirementId: Type.String(),
    verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail"), Type.Literal("unverified")]),
    evidence: Type.Array(Type.String()),
  },
  { additionalProperties: false },
);

export const specRedGreen = defineWorkflowFunction({
  description: "Run a pinned spec through RED, implementation, GREEN, and per-requirement verdict coverage",
  async run({ specPath, worktree, redCommand, greenCommand, timeoutMs = 120_000 }, context) {
    if (/['\n\r`]/.test(specPath)) return { ok: false, requirements: 0, verdicts: [], problems: ["specPath contains forbidden shell characters."] };
    const normalizedWorktree = worktree.trim();
    if (!normalizedWorktree) return { ok: false, requirements: 0, verdicts: [], problems: ["worktree must be non-empty."] };
    if (normalizedWorktree.startsWith("-")) return { ok: false, requirements: 0, verdicts: [], problems: ["worktree must not start with '-'."] };
    if (/[\\/]/.test(normalizedWorktree)) return { ok: false, requirements: 0, verdicts: [], problems: ["worktree must not contain path separators."] };

    let specText: string;
    try {
      const result = await context.shell(`cat -- '${specPath}'`, { timeoutMs });
      if (result.exitCode !== 0) return { ok: false, requirements: 0, verdicts: [], problems: [`Failed to read spec with exit code ${String(result.exitCode)}.`] };
      specText = result.stdout;
    } catch (error) {
      return { ok: false, requirements: 0, verdicts: [], problems: [`Failed to read spec: ${errorText(error)}`] };
    }

    let spec: ReturnType<typeof parseSpecDocument>;
    let tasks: ReturnType<typeof parseTaskSpecLinks>;
    try {
      spec = parseSpecDocument(specText);
      tasks = parseTaskSpecLinks(specText);
    } catch (error) {
      return { ok: false, requirements: 0, verdicts: [], problems: [errorText(error)] };
    }

    let approved: boolean;
    try {
      approved = await context.checkpoint({
        name: "approve-spec",
        prompt: "Approve the pinned spec and its requirement ids before implementation.",
        context: { specPath, requirementIds: spec.map(({ id }) => id) },
      });
    } catch (error) {
      return { ok: false, requirements: spec.length, verdicts: [], problems: [`Checkpoint failed: ${errorText(error)}`] };
    }
    if (!approved) return { ok: false, requirements: spec.length, verdicts: [], problems: ["Spec was not approved."] };

    try {
      return await context.withWorktree(normalizedWorktree, async (reference) => {
        let red;
        try {
          red = await context.shell(redCommand, { timeoutMs });
        } catch (error) {
          return { ok: false, requirements: spec.length, verdicts: [], problems: [`RED failed: ${errorText(error)}`] };
        }
        if (red.exitCode === 0) return { ok: false, requirements: spec.length, verdicts: [], problems: ["RED passed, which proves nothing."] };

        const outputSchema = Type.Object({ verdicts: Type.Array(verdictSchema) }, { additionalProperties: false });
        const developerPolicy = contextPolicyFor("developer");
        let written;
        try {
          written = await context.agent(
            `Implement the pinned spec by reference. Read the spec at ${specPath}. Cover requirement ids ${spec.map(({ id }) => id).join(", ")} in worktree ${reference.path}. Return one verdict per requirement with concise evidence.`,
            { label: "Spec writer", role: "developer", contextFiles: [...developerPolicy.contextFiles], skills: [...developerPolicy.skills], outputSchema, timeoutMs },
          );
        } catch (error) {
          return { ok: false, requirements: spec.length, verdicts: [], problems: [`Agent failed: ${errorText(error)}`] };
        }
        const verdicts = written.verdicts;
        const serializableVerdicts = verdicts.map(({ requirementId, verdict, evidence }) => ({ requirementId, verdict, evidence: [...evidence] }));
        let green;
        try {
          green = await context.shell(greenCommand, { timeoutMs });
        } catch (error) {
          return { ok: false, requirements: spec.length, verdicts: serializableVerdicts, problems: [`GREEN failed: ${errorText(error)}`] };
        }
        if (green.exitCode !== 0) return { ok: false, requirements: spec.length, verdicts: serializableVerdicts, problems: [`GREEN failed with exit code ${String(green.exitCode)}.`] };

        const coverage = validateSpecCoverage(spec, tasks, verdicts);
        if (!coverage.ok) return { ok: false, requirements: spec.length, verdicts: serializableVerdicts, problems: coverage.problems };
        return { ok: true, requirements: spec.length, verdicts: serializableVerdicts, problems: [] };
      });
    } catch (error) {
      return { ok: false, requirements: spec.length, verdicts: [], problems: [`withWorktree failed: ${errorText(error)}`] };
    }
  },
  input: Type.Object(
    {
      specPath: Type.String(),
      worktree: Type.String(),
      redCommand: Type.String(),
      greenCommand: Type.String(),
      timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      ok: Type.Boolean(),
      requirements: Type.Integer({ minimum: 0 }),
      verdicts: Type.Array(verdictSchema),
      problems: Type.Array(Type.String()),
    },
    { additionalProperties: false },
  ),
});
