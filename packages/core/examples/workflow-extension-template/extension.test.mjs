import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createEventBus, discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";
import { beginWorkflowExtensionLoading, loadingRegistry, registeredWorkflowFunctions, resetWorkflowRegistry, workflowCatalog } from "pi-extensible-workflows";

test("discovers the copied directory as a trusted Pi extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-extension-template-"));
  try {
    const destination = join(root, ".pi", "extensions", "workflow-extension-template");
    await mkdir(join(root, "node_modules"), { recursive: true });
    const packageEntry = fileURLToPath(import.meta.resolve("pi-extensible-workflows"));
    const packageRoot = join(dirname(packageEntry), "..", "..");
    await symlink(packageRoot, join(root, "node_modules", "pi-extensible-workflows"), "dir");
    await cp(dirname(fileURLToPath(import.meta.url)), destination, { recursive: true });
    const result = await discoverAndLoadExtensions([], root, join(root, ".pi", "agent"));
    assert.equal(result.errors.length, 0);
    assert.equal(result.extensions.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  resetWorkflowRegistry();
  const { default: extension } = await import("./index.js");
  beginWorkflowExtensionLoading();
  const bus = createEventBus();
  extension({ events: bus });

  const catalog = workflowCatalog();
  assert.deepEqual(catalog.functions.map(({ name }) => name), ["greet"]);
  assert.deepEqual(catalog.modelAliasEntries?.filter(({ name }) => name === "template-model").map(({ name, kind }) => ({ name, kind })), [{ name: "template-model", kind: "dynamic" }]);
  assert.equal(await registeredWorkflowFunctions().greet.run({ name: "Ada" }, {}), "Hello, Ada!");

  for (const [name, availableModels, expected] of [["root-model", ["example/root"], "example/root"], ["available-fallback", ["example/available"], "example/available"], ["no-model-fallback", [], "example/root"]]) {
    const resolved = await loadingRegistry().resolveModelAliases({ cwd: process.cwd(), projectTrusted: true, rootModel: { provider: "example", model: "root" }, knownModels: new Set(["example/root", "example/available"]), availableModels: new Set(availableModels), signal: new AbortController().signal });
    assert.deepEqual(resolved, { "template-model": expected }, name);
  }

  const hook = loadingRegistry().agentSetupHooks().find(({ name }) => name === "templateAdvisor");
  assert.ok(hook);
  const hookCases = [
    { options: {}, append: undefined, aborted: false },
    { options: { templateAdvisor: true }, append: "Existing", expected: "Existing\n\nAdvisor: call out one concrete risk and one next check.", aborted: false },
    { options: { templateAdvisor: true }, append: "Existing", expected: "Existing", aborted: true },
  ];
  for (const current of hookCases) {
    const controller = new AbortController(); if (current.aborted) controller.abort();
    const agent = { prompt: "Review this", options: current.options, sessionInput: current.append === undefined ? {} : { systemPromptAppend: current.append } };
    await hook.setup(agent, { signal: controller.signal });
    assert.equal(agent.sessionInput.systemPromptAppend, current.expected);
  }
});
