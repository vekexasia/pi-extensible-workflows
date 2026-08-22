import type { RuntimeJsonSchema } from "./agent-runner.js";

export const defaultWorkflowResultSchema: RuntimeJsonSchema = {
  type: "object",
  properties: { result: { type: "string" } },
  required: ["result"],
  additionalProperties: false,
};
