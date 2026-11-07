import { closureGate } from "./closure-gate.js";
import {
  registerWorkflowExtension,
  type WorkflowExtension,
  type WorkflowModelAliasResolverContext,
} from "../src/index.js";
import { reviewLoop } from "./review-loop.js";
import { specRedGreen } from "./spec-red-green.js";

const resolveRootModel = ({ rootModel }: Readonly<WorkflowModelAliasResolverContext>): string => `${rootModel.provider}/${rootModel.model}`;

const extension: WorkflowExtension = {
  source: import.meta.url,
  dependencies: ["typebox"],
  version: "1.0.0",
  headline: "Developer-review starter workflows",
  functions: { reviewLoop, specRedGreen, closureGate },
  modelAliases: {
    "reviewer-model": { resolve: resolveRootModel },
    "developer-model": { resolve: resolveRootModel },
    "scout-model": { resolve: resolveRootModel },
    "oracle-model": { resolve: resolveRootModel },
    "researcher-model": { resolve: resolveRootModel },
  },
};

export default function (): void {
  registerWorkflowExtension(extension);
}
