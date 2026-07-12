import { Type } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function workflowExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "workflow",
    label: "Workflow",
    description: "Run a deterministic JavaScript workflow",
    parameters: Type.Object({
      script: Type.String({ description: "Immutable JavaScript workflow source" }),
      args: Type.Optional(Type.Unknown({ description: "JSON-compatible workflow arguments" })),
      foreground: Type.Optional(Type.Boolean({ description: "Wait for completion instead of running in the background" })),
    }),
    async execute() {
      throw new Error("Workflow execution is not implemented yet");
    },
  });

  pi.registerCommand("workflow", {
    description: "Inspect and control workflows for this Pi session",
    handler: async (_args, ctx) => {
      ctx.ui.notify("No workflow runs in this session.", "info");
    },
  });
}