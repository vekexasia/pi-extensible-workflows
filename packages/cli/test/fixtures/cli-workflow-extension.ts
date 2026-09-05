import { registerWorkflowExtension, type WorkflowExtension } from "pi-extensible-workflows";

const extension: WorkflowExtension = {
  version: "1.0.0",
  headline: "CLI test workflows",
  source: import.meta.url,
  functions: {
    cliEcho: {
      description: "Echo a CLI issue",
      input: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false },
      output: { type: "object", properties: { issue: { type: "integer" } }, required: ["issue"], additionalProperties: false },
      run: (input) => ({ issue: input.issue }),
    },
    cliRuntime: {
      description: "Runtime progress",
      input: { type: "object", additionalProperties: false },
      output: { type: "boolean" },
      run: async () => { await new Promise<void>((resolve) => setTimeout(resolve, 1_100)); return true; },
    },
  },
};

export function registerCliExtension(): void { registerWorkflowExtension(extension); }
export default function (): void { registerCliExtension(); }
