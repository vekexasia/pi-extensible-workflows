import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { validateWorkflowLaunch, WorkflowError, WORKFLOW_TOOL_DESCRIPTION, WORKFLOW_TOOL_LABEL, WORKFLOW_TOOL_PARAMETERS, WORKFLOW_TOOL_PROMPT_SNIPPET, type WorkflowValidationParameters } from "./index.js";

export const CAPTURE_IDENTITY = "pi-extensible-workflows-eval-capture-v1";
export const CAPTURE_ERROR_PREFIX = `${CAPTURE_IDENTITY}:`;

interface CaptureContext {
  cwd: string;
  model?: { provider: string; id: string };
  modelRegistry?: { getAvailable(): Array<{ provider: string; id: string }> };
  isProjectTrusted?: () => boolean;
}

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

export default function evalCaptureExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "workflow",
    label: WORKFLOW_TOOL_LABEL,
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_TOOL_PROMPT_SNIPPET,
    parameters: WORKFLOW_TOOL_PARAMETERS,
    async execute(_id: string, params: WorkflowValidationParameters, _signal: AbortSignal, _onUpdate: unknown, ctx: CaptureContext) {
      try {
        if (!ctx.model) throw new WorkflowError("UNKNOWN_MODEL", "A launching model is required");
        const rootModel = `${ctx.model.provider}/${ctx.model.id}`;
        const availableModels = new Set((ctx.modelRegistry?.getAvailable() ?? [ctx.model]).map((model) => `${model.provider}/${model.id}`));
        availableModels.add(rootModel);
        const rootTools = new Set(pi.getActiveTools().filter((name) => name !== "workflow" && name !== "workflow_respond" && name !== "workflow_catalog"));
        const validated = validateWorkflowLaunch(params, { cwd: ctx.cwd, projectTrusted: ctx.isProjectTrusted?.() ?? true, availableModels, rootTools });
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ captured: true, validated: true, launchBudget: 0, name: validated.checked.metadata.name }) }],
          details: { captured: true, captureIdentity: CAPTURE_IDENTITY, realWorkflowAgentsLaunched: 0, launchBudget: 0, validation: { valid: true, script: validated.script, metadata: validated.checked.metadata, roles: validated.roleNames } },
        };
      } catch (error) {
        if (error instanceof WorkflowError) throw new WorkflowError(error.code, `${CAPTURE_ERROR_PREFIX}${error.code}: ${error.message}`);
        throw error;
      }
    },
  } as never);
}