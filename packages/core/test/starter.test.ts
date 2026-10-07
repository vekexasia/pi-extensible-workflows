import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import starter from "../starter/index.js";
import { reviewLoop } from "../starter/review-loop.js";
import { runWorkflow } from "../src/execution.js";
import { beginWorkflowExtensionLoading, loadingRegistry, resetWorkflowRegistry, type WorkflowFunctionContext, WorkflowRegistry } from "../src/index.js";

void test("starter prompt agent examples execute with a task and role", async () => {
  for (const [name, role] of [["council", "oracle"], ["deep-research", "researcher"], ["parallel-review", "reviewer"], ["parallel-scout", "scout"]] as const) {
    const source = readFileSync(new URL(`../../starter/prompts/${name}.md`, import.meta.url), "utf8");
    const call = /`(agent\([^`]*role:[^`]*\))`/.exec(source)?.[1];
    assert.ok(call, `${name}: missing role example`);
    const result = await runWorkflow(`const taskPrompt = "Bounded task with context"; return await ${call};`, null, {
      agent: async (task, options) => {
        assert.equal(task, "Bounded task with context");
        assert.equal(options.role, role);
        return "verified";
      },
    }).result;
    assert.equal(result, "verified");
  }
});

function registerStarter() {
  resetWorkflowRegistry();
  beginWorkflowExtensionLoading();
  starter();
  return loadingRegistry();
}

function reviewContext(
  reviews: readonly { pass: boolean; findings: string[] }[],
): { context: WorkflowFunctionContext; roles: string[] } {
  let reviewIndex = 0;
  const roles: string[] = [];
  const context = {
    agent: async (_prompt: string, options?: Readonly<{ role?: string }>) => {
      const role = options?.role ?? "developer";
      roles.push(role);
      return role === "reviewer" ? reviews[reviewIndex++] ?? reviews.at(-1) : "implemented";
    },
    prompt: (template: string) => template,
  } as unknown as WorkflowFunctionContext;
  return { context, roles };
}
void test("records and validates portable workflow source metadata", () => {
  const workflow = { description: "Portable", input: { type: "object" }, output: { type: "boolean" }, run: () => true };
  const extension = { version: "1.0.0", headline: "Portable extension", source: "file:///portable-extension.mjs", dependencies: ["typebox"], functions: { portable: workflow } };
  const registry = new WorkflowRegistry();
  registry.register(extension);
  assert.deepEqual(registry.functionSources(), { portable: { module: "file:///portable-extension.mjs", export: "default", dependencies: ["typebox"] } });
  assert.throws(() => { new WorkflowRegistry().register({ ...extension, source: "" }); }, /source/);
  assert.throws(() => { new WorkflowRegistry().register({ ...extension, dependencies: ["typebox", "typebox"] }); }, /dependencies/);
  assert.throws(() => { new WorkflowRegistry().register({ ...extension, dependencies: ["invalid package"] }); }, /dependencies/);
});
void test("reviewLoop passes after a reviewer approves", async () => {
  const { context, roles } = reviewContext([
    { pass: false, findings: ["Fix the issue"] },
    { pass: true, findings: [] },
  ]);

  const result = await reviewLoop.run({ task: "Implement the change", maxIterations: 2 }, context);

  assert.equal(result.pass, true);
  assert.equal(result.iterations, 2);
  assert.deepEqual(roles, ["developer", "reviewer", "developer", "reviewer"]);
});

void test("reviewLoop fails when the iteration limit is reached", async () => {
  const { context, roles } = reviewContext([
    { pass: false, findings: ["First finding"] },
    { pass: false, findings: ["Second finding"] },
  ]);

  const result = await reviewLoop.run({ task: "Implement the change", maxIterations: 2 }, context);

  assert.equal(result.pass, false);
  assert.equal(result.iterations, 2);
  assert.deepEqual(result.review.findings, ["Second finding"]);
  assert.deepEqual(roles, ["developer", "reviewer", "developer", "reviewer"]);
});

void test("static settings aliases shadow starter dynamic aliases", async () => {
  const registry = registerStarter();
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-starter-"));
  const settingsPath = join(home, "settings.json");
  try {
    writeFileSync(settingsPath, JSON.stringify({ modelAliases: { "reviewer-model": "static/reviewer" } }));
    const catalog = registry.catalog({ cwd: home, projectTrusted: false, globalSettingsPath: settingsPath });
    assert.deepEqual(catalog.modelAliases, { "reviewer-model": "static/reviewer" });

    const resolved = await registry.resolveModelAliases(
      {
        cwd: home,
        projectTrusted: false,
        rootModel: { provider: "dynamic", model: "root" },
        knownModels: new Set(["dynamic/root"]),
        availableModels: new Set(["dynamic/root"]),
        signal: new AbortController().signal,
      },
      new Set(Object.keys(catalog.modelAliases ?? {})),
    );
    assert.deepEqual(resolved, { "developer-model": "dynamic/root", "scout-model": "dynamic/root", "oracle-model": "dynamic/root", "researcher-model": "dynamic/root" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
