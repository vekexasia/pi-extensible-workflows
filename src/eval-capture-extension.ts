import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WORKFLOW_TOOL_DESCRIPTION, WORKFLOW_TOOL_LABEL, WORKFLOW_TOOL_PARAMETERS, WORKFLOW_TOOL_PROMPT_SNIPPET } from "./index.js";

export const CAPTURE_IDENTITY = "pi-workflows-eval-capture-v1";

export function resolveWorkflowSkillPath(): string {
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    const candidate = join(directory, "skills", "pi-workflows", "SKILL.md");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new Error("Could not resolve skills/pi-workflows/SKILL.md from the eval extension");
}

export default function evalCaptureExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "workflow",
    label: WORKFLOW_TOOL_LABEL,
    description: WORKFLOW_TOOL_DESCRIPTION,
    promptSnippet: WORKFLOW_TOOL_PROMPT_SNIPPET,
    parameters: WORKFLOW_TOOL_PARAMETERS,
    async execute(_id: string, params: { name?: string; workflow?: string }) {
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ captured: true, launchBudget: 0, name: params.name ?? params.workflow ?? "workflow" }) }],
        details: { captured: true, captureIdentity: CAPTURE_IDENTITY, realWorkflowAgentsLaunched: 0, launchBudget: 0 },
      };
    },
  } as never);
}