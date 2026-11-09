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
): { context: WorkflowFunctionContext; roles: string[]; handles: { name: unknown; label: unknown; role: unknown; sends: string[] }[]; reviewers: { label: unknown; prompt: string }[] } {
  let reviewIndex = 0;
  const roles: string[] = [];
  const handles: { name: unknown; label: unknown; role: unknown; sends: string[] }[] = [];
  const reviewers: { label: unknown; prompt: string }[] = [];
  const agent = async (prompt: string, options?: Readonly<{ role?: string; label?: string }>) => {
    roles.push(options?.role ?? "none");
    reviewers.push({ label: options?.label, prompt });
    return reviews[reviewIndex++] ?? reviews.at(-1);
  };
  const create = (options: Readonly<{ name: string; label?: string; role?: string }>) => {
    const handle = { name: options.name, label: options.label, role: options.role, sends: [] as string[] };
    handles.push(handle);
    return { name: options.name, send: async (prompt: string) => { roles.push(options.role ?? "none"); handle.sends.push(prompt); return options.role === "reviewer" ? reviews[reviewIndex++] ?? reviews.at(-1) : "implemented"; } };
  };
  const context = { agent: Object.assign(agent, { create }), prompt: (template: string, values: Readonly<Record<string, unknown>>) => template.replace(/\{(\w+)\}/g, (_match, key: string) => JSON.stringify(values[key])) } as unknown as WorkflowFunctionContext;
  return { context, roles, handles, reviewers };
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

void test("reviewLoop creates one developer handle and a fresh labelled reviewer per iteration", async () => {
  const { context, handles, reviewers } = reviewContext([
    { pass: false, findings: ["Fix the issue"] },
    { pass: true, findings: [] },
  ]);

  await reviewLoop.run({ task: "Implement the change", maxIterations: 3 }, context);

  assert.equal(handles.length, 1);
  const [developer] = handles;
  assert.ok(developer);
  assert.deepEqual([developer.name, developer.label, developer.role], ["developer", "Developer", "developer"]);
  assert.equal(developer.sends.length, 2);
  assert.match(developer.sends[0] ?? "", /Implement the change/);
  assert.match(developer.sends[1] ?? "", /Fix the issue/);
  assert.doesNotMatch(developer.sends[1] ?? "", /Implement the change/);
  assert.deepEqual(reviewers.map(({ label }) => label), ["Reviewer 1", "Reviewer 2"]);
  for (const { prompt } of reviewers) assert.match(prompt, /actual current implementation against the entire original task/);
});

void test("reviewLoop with sharedReviewer keeps one reviewer handle across iterations", async () => {
  const { context, roles, handles, reviewers } = reviewContext([
    { pass: false, findings: ["Fix the issue"] },
    { pass: true, findings: [] },
  ]);

  const result = await reviewLoop.run({ task: "Implement the change", maxIterations: 3, sharedReviewer: true }, context);

  assert.equal(result.pass, true);
  assert.equal(result.iterations, 2);
  assert.deepEqual(roles, ["developer", "reviewer", "developer", "reviewer"]);
  assert.equal(reviewers.length, 0);
  assert.deepEqual(handles.map(({ name, label, role }) => [name, label, role]), [["developer", "Developer", "developer"], ["reviewer", "Reviewer", "reviewer"]]);
  const reviewer = handles[1];
  assert.ok(reviewer);
  assert.equal(reviewer.sends.length, 2);
  assert.match(reviewer.sends[0] ?? "", /Implement the change/);
  assert.match(reviewer.sends[1] ?? "", /addressed your previous findings/);
  assert.doesNotMatch(reviewer.sends[1] ?? "", /Implement the change/);
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
