import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateWorkflowLaunch, WorkflowError, WORKFLOW_RETRY_PARAMETERS, WORKFLOW_TOOL_DESCRIPTION, WORKFLOW_TOOL_LABEL, WORKFLOW_TOOL_PARAMETERS, WORKFLOW_TOOL_PROMPT_SNIPPET } from "../../src/index.js";

export const CAPTURE_IDENTITY = "pi-extensible-workflows-eval-capture-v1";
export const CAPTURE_ERROR_PREFIX = `${CAPTURE_IDENTITY}:`;

export function resolveWorkflowSkillPath(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, "skills", "pi-extensible-workflows", "SKILL.md");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Could not resolve skills/pi-extensible-workflows/SKILL.md from the eval extension");
}

export default function evalCaptureExtension(pi: Pick<ExtensionAPI, "getActiveTools" | "registerTool">): void {
  pi.registerTool(defineTool({
    name: "workflow",
    label: WORKFLOW_TOOL_LABEL,
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_TOOL_PROMPT_SNIPPET,
    parameters: WORKFLOW_TOOL_PARAMETERS,
    async execute(_id, params, _signal, _onUpdate, ctx) {
      try {
        if (!ctx.model) throw new WorkflowError("UNKNOWN_MODEL", "A launching model is required");
        const rootModel = `${ctx.model.provider}/${ctx.model.id}`;
        const availableModels = new Set(ctx.modelRegistry.getAvailable().map((model) => `${model.provider}/${model.id}`));
        availableModels.add(rootModel);
        const rootTools = new Set(pi.getActiveTools().filter((name) => name !== "workflow" && name !== "workflow_respond" && name !== "workflow_catalog"));
        const validated = validateWorkflowLaunch(params, { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted(), availableModels, rootTools });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ captured: true, validated: true, launchBudget: 0, name: validated.checked.metadata.name }) }],
          details: { captured: true, captureIdentity: CAPTURE_IDENTITY, realWorkflowAgentsLaunched: 0, launchBudget: 0, validation: { valid: true, script: validated.script, metadata: validated.checked.metadata } },
        };
      } catch (error) {
        if (error instanceof WorkflowError) throw new WorkflowError(error.code, `${CAPTURE_ERROR_PREFIX}${error.code}: ${error.message}`);
        throw error;
      }
    },
  }));
  pi.registerTool(defineTool({
    name: "workflow_retry",
    label: "Workflow Retry",
    description: "Capture a recovery selection without executing it",
    parameters: WORKFLOW_RETRY_PARAMETERS,
    async execute(_id, params) {
      if (!params.runId.trim()) throw new WorkflowError("RESUME_INCOMPATIBLE", `${CAPTURE_ERROR_PREFIX}RESUME_INCOMPATIBLE: workflow_retry requires an explicit run ID`);
      const selection = { tool: "workflow_retry", arguments: { runId: params.runId } };
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ captured: true, ...selection }) }],
        details: { captured: true, captureIdentity: CAPTURE_IDENTITY, realWorkflowAgentsLaunched: 0, selection },
      };
    },
  }));
}