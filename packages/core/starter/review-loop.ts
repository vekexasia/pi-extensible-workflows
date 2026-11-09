import { Type, type Static } from "typebox";
import {
  defineWorkflowFunction,
  type JsonValue,
} from "../src/index.js";

export const reviewLoop = defineWorkflowFunction({
  description:
    "Run developer and reviewer agents until review passes or the iteration limit is reached",
  async run({ task, maxIterations = 5, sharedReviewer = false }, { agent, prompt }) {
    const reviewSchema = Type.Object(
      {
        pass: Type.Boolean(),
        findings: Type.Array(Type.String()),
      },
      { additionalProperties: false },
    );
    let devResult: JsonValue = null;
    let review: Static<typeof reviewSchema> = { pass: false, findings: [] };
    // One developer keeps its transcript across iterations; each reviewer starts fresh unless sharedReviewer is set.
    const developer = agent.create({ name: "developer", label: "Developer", role: "developer" });
    const reviewer = sharedReviewer ? agent.create({ name: "reviewer", label: "Reviewer", role: "reviewer" }) : undefined;

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
      if (reviewer && iterations > 1) {
        review = await reviewer.send(
          prompt(
            `The developer addressed your previous findings. Review the actual current implementation again against the entire original task. Inspect the code and run relevant checks yourself. Do not rely on the developer summary; it may be incomplete or wrong. Set pass=true only when the whole task is complete and correct.
<dev_summary>{devResult}</dev_summary>`,
            { devResult },
          ),
          { outputSchema: reviewSchema },
        );
      } else {
        const reviewPrompt = prompt(
          `Review the actual current implementation against the entire original task. Inspect the code and run relevant checks yourself. Do not rely on the developer summary or on previous findings; they may be incomplete or wrong. Set pass=true only when the whole task is complete and correct.
<original_task>{task}</original_task>
<previous_review_findings>{review}</previous_review_findings>
<dev_summary>{devResult}</dev_summary>`,
          { task, devResult, review: review.findings },
        );
        review = reviewer
          ? await reviewer.send(reviewPrompt, { outputSchema: reviewSchema })
          : await agent(reviewPrompt, { label: `Reviewer ${String(iterations)}`, role: "reviewer", outputSchema: reviewSchema });
      }

      if (review.pass) return { pass: true, iterations, devResult, review };
    }

    return { pass: false, iterations: maxIterations, devResult, review };
  },
  input: Type.Object(
    {
      task: Type.String(),
      maxIterations: Type.Optional(Type.Integer({ minimum: 1 })),
      sharedReviewer: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  output: Type.Object(
    {
      pass: Type.Boolean(),
      iterations: Type.Integer(),
      devResult: Type.Any(),
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

