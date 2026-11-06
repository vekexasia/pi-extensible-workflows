import { Type, type Static } from "typebox";
import {
  defineWorkflowFunction,
  type JsonValue,
} from "../src/index.js";
import { contextPolicyFor } from "./context-policy.js";

export const reviewLoop = defineWorkflowFunction({
  description:
    "Run developer and reviewer agents until review passes or the iteration limit is reached",
  async run({ task, maxIterations = 5 }, { agent, prompt }) {
    const reviewSchema = Type.Object(
      {
        pass: Type.Boolean(),
        findings: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    );
    let devResult: JsonValue = null;
    let review: Static<typeof reviewSchema> = { pass: false, findings: [] };
    // One developer keeps its transcript across iterations; each reviewer starts fresh.
    const developerPolicy = contextPolicyFor("developer");
    const developer = agent.create({
      name: "developer",
      label: "Developer",
      role: "developer",
      contextFiles: [...developerPolicy.contextFiles],
      skills: [...developerPolicy.skills],
    });

    for (let iterations = 1; iterations <= maxIterations; iterations += 1) {
      const devPrompt =
        iterations === 1
          ? prompt("Implement this task:\n\n{task}", { task })
          : prompt(
              `Address the latest review findings and complete the original task.
<last_review>{review}</last_review>`,
              { review: review.findings },
            );
      devResult = await developer.send(devPrompt);
      const reviewerPolicy = contextPolicyFor("reviewer");
      review = await agent(
        prompt(
          `Review the actual current implementation against the entire original task. Inspect the code and run relevant checks yourself. Do not rely on the developer summary or on previous findings; they may be incomplete or wrong. Set pass=true only when the whole task is complete and correct.
<original_task>{task}</original_task>
<previous_review_findings>{review}</previous_review_findings>
<dev_summary>{devResult}</dev_summary>`,
          { task, devResult, review: review.findings },
        ),
        {
          label: `Reviewer ${String(iterations)}`,
          role: "reviewer",
          contextFiles: [...reviewerPolicy.contextFiles],
          skills: [...reviewerPolicy.skills],
          outputSchema: reviewSchema,
        },
      );

      if (review.pass) return { pass: true, iterations, devResult, review };
    }

    return { pass: false, iterations: maxIterations, devResult, review };
  },
  input: Type.Object(
    {
      task: Type.String(),
      maxIterations: Type.Optional(Type.Integer({ minimum: 1 })),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      pass: Type.Boolean(),
      iterations: Type.Integer(),
      devResult: Type.Unknown(),
      review: Type.Object(
        {
          pass: Type.Boolean(),
          findings: Type.Array(Type.String()),
        },
        { additionalProperties: false },
      ),
    },
    { additionalProperties: false },
  ),
});

