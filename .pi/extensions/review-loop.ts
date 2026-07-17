import {
  registerWorkflowExtension,
  type JsonSchema,
  type JsonValue,
  type WorkflowExtension,
} from "../../src/index.js";

const inputSchema: JsonSchema = {
  type: "object",
  properties: {
    task: { type: "string" },
    maxIterations: { type: "integer", minimum: 1 },
  },
  required: ["task"],
  additionalProperties: false,
};

const reviewSchema: JsonSchema = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    findings: { type: "array", items: { type: "string" } },
  },
  required: ["pass", "findings"],
  additionalProperties: false,
};

const outputSchema: JsonSchema = {
  type: "object",
  properties: {
    pass: { type: "boolean" },
    iterations: { type: "integer" },
    devResult: {},
    review: { type: "object" },
  },
  required: ["pass", "iterations", "devResult", "review"],
  additionalProperties: false,
};

export const reviewLoopExtension: WorkflowExtension = {
  namespace: "reviewLoop",
  version: "1.0.0",
  headline: "Developer-review loop",
  description: "Runs developer and reviewer agents until review passes",
  functions: {
    developUntilApproved: {
      description: "Run developer and reviewer agents until review passes or the iteration limit is reached",
      input: inputSchema,
      output: outputSchema,
      async run(input, { agent, prompt }) {
        const { task, maxIterations = 5 } = input as unknown as {
          task: string;
          maxIterations?: number;
        };
        let devResult: JsonValue = null;
        let review: JsonValue = { pass: false };

        for (let iterations = 1; iterations <= maxIterations; iterations += 1) {
          const devPrompt = iterations === 1
            ? prompt("Implement this task:\n\n{task}", { task })
            : prompt("Address the previous review findings and complete the task.\n\nTask:\n{task}\n\nPrevious review:\n{review}", { task, review });
          devResult = await agent(devPrompt, { role: "developer" });
          review = await agent(prompt("Review the implementation against the task. Set pass=true only when the task is complete and correct.\n\nTask:\n{task}\n\nDeveloper result:\n{devResult}", { task, devResult }), {
            role: "reviewer",
            outputSchema: reviewSchema,
          });

          if ((review as { pass: boolean }).pass) return { pass: true, iterations, devResult, review };
        }

        return { pass: false, iterations: maxIterations, devResult, review };
      },
    },
  },
};

registerWorkflowExtension(reviewLoopExtension);

export default function (): void {}
