# pi-workflows
Deterministic multi-agent workflow orchestration for Pi

Pi extensions can register workflow DSL macros during extension load:

```ts
import { registerWorkflowDslExtension } from "pi-workflows";

registerWorkflowDslExtension({
  name: "git",
  version: "1.0.0",
  headline: "Git operations",
  description: "Reusable Git workflow macros",
  methods: {
    status: {
      description: "Read repository status",
      input: { type: "object", properties: {}, additionalProperties: false },
      output: { type: "object", properties: { clean: { type: "boolean" } }, required: ["clean"] },
      async run(_input, { agent }) {
        return agent("Inspect git status", { name: "git-status" });
      },
    },
  },
});
```

The method is available to workflows as `extensions.git.status(...)`. Calls validate input and output and replay as a single journaled macro.
