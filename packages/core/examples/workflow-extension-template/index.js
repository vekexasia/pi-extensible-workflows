import { registerWorkflowExtension } from "pi-extensible-workflows";

const templateExtension = {
  version: "1.0.0",
  source: import.meta.url,
  headline: "Workflow extension template",
  functions: {
    greet: {
      description: "Return a greeting for one person.",
      input: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
        additionalProperties: false,
      },
      output: { type: "string" },
      run(input) {
        return `Hello, ${String(input.name)}!`;
      },
    },
  },
  // Packaged resources must be absolute paths or file URLs. This URL stays
  // correct when the extension is copied or installed elsewhere.
  roleDirectories: [new URL("./roles/", import.meta.url)],
  // Optional advanced example: select an available model without naming a
  // provider-specific model in the extension.
  modelAliases: {
    "template-model": {
      resolve({ availableModels, rootModel }) {
        const root = `${rootModel.provider}/${rootModel.model}`;
        return availableModels.has(root) ? root : availableModels.values().next().value ?? root;
      },
    },
  },
  // Optional advanced example: mutate setup only for explicitly opted-in
  // agents. Setup hooks are trusted code and should stay narrowly scoped.
  agentSetupHooks: {
    templateAdvisor: {
      setup(agent, context) {
        if (context.signal.aborted || agent.options.templateAdvisor !== true) return;
        const suffix = "\n\nAdvisor: call out one concrete risk and one next check.";
        const existing = agent.sessionInput.systemPromptAppend;
        agent.sessionInput.systemPromptAppend = existing ? existing + suffix : suffix;
      },
    },
  },
};

export default function extension() {
  registerWorkflowExtension(templateExtension);
}
