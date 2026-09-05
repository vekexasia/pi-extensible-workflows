import { Type, type Static } from "typebox";
import {
  defineWorkflowFunction,
  type JsonValue,
} from "pi-extensible-workflows";

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

    for (let iterations = 1; iterations <= maxIterations; iterations += 1) {
      const devPrompt =
        iterations === 1
          ? prompt("Implement this task:\n\n{task}", { task })
          : prompt(
              `Address the previous review findings and complete the task.
<original_task>{task}</original_task>
<last_review>{review}</last_review>`,
              { task, review: review.findings },
            );
      devResult = await agent(devPrompt, { role: "developer" });
      review = await agent(
        prompt(
          `Review the implementation against the task. Set pass=true only when the task is complete and correct. The developer may have addressed a previous review run of yours. So its summary is related to the last round of review if present.
<original_task>{task}</original_task>
<last_review>{review}</last_review>
<dev_summary>{devResult}</dev_summary>`,
          { task, devResult, review: review.findings },
        ),
        { role: "reviewer", outputSchema: reviewSchema },
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

export const reviewLoopInputSchema = reviewLoop.input;
export const reviewLoopOutputSchema = reviewLoop.output;
