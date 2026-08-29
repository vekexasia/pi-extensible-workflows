import {
  registerWorkflowExtension,
  type WorkflowExtension,
} from "../src/index.js";
import { reviewLoop } from "./review-loop.js";

const extension: WorkflowExtension = {
  version: "1.0.0",
  headline: "Developer-review starter workflows",
  functions: { reviewLoop },
  modelAliases: {
    "reviewer-model": {
      resolve: ({ rootModel }) => `${rootModel.provider}/${rootModel.model}`,
    },
    "developer-model": {
      resolve: ({ rootModel }) => `${rootModel.provider}/${rootModel.model}`,
    },
    "scout-model": {
      resolve: ({ rootModel }) => `${rootModel.provider}/${rootModel.model}`,
    },
    "oracle-model": {
      resolve: ({ rootModel }) => `${rootModel.provider}/${rootModel.model}`,
    },
    "researcher-model": {
      resolve: ({ rootModel }) => `${rootModel.provider}/${rootModel.model}`,
    },
  },
  roleDirectories: [new URL("./roles/", import.meta.url)],
};

export default function (): void {
  registerWorkflowExtension(extension);
}
