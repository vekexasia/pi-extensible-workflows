import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import test from "node:test";
import starter from "../starter/index.js";
import { reviewLoop } from "../starter/review-loop.js";
import {
  beginWorkflowExtensionLoading,
  loadingRegistry,
  parseRoleMarkdown,
  registeredWorkflowFunctions,
  registeredWorkflowRoleDirectoryRegistrations,
  resetWorkflowRegistry,
  type WorkflowFunctionContext,
  WorkflowRegistry,
} from "../src/index.js";

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

void test("registers the starter function, aliases, and packaged roles", async () => {
  const registry = registerStarter();

  assert.deepEqual(Object.keys(registeredWorkflowFunctions()), ["reviewLoop"]);
  assert.deepEqual(
    await registry.resolveModelAliases({
      cwd: "/project",
      projectTrusted: true,
      rootModel: { provider: "example", model: "root" },
      knownModels: new Set(["example/root"]),
      availableModels: new Set(["example/root"]),
      signal: new AbortController().signal,
    }),
    { "developer-model": "example/root", "reviewer-model": "example/root", "scout-model": "example/root", "oracle-model": "example/root", "researcher-model": "example/root" },
  );

  const registration = registeredWorkflowRoleDirectoryRegistrations();
  assert.equal(registration.length, 1);
  assert.deepEqual(
    registration[0] && Object.keys(registration[0]).sort(),
    ["builtin", "extension", "path"],
  );
  assert.match(registration[0]?.path ?? "", /starter[\\/]roles[\\/]?$/);
  assert.equal(registration[0]?.builtin, true);
});
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
void test("marks a symlinked starter roles directory as builtin", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-starter-role-link-"));
  const link = join(root, "roles");
  symlinkSync(fileURLToPath(new URL("../starter/roles/", import.meta.url)), link, "dir");
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Starter roles", roleDirectories: [link] });
  assert.equal(registry.roleDirectoryRegistrations()[0]?.builtin, true);
});
void test("marks starter roles from a separate package installation as builtin", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-starter-package-"));
  const packageRoot = join(root, "node_modules", "pi-extensible-workflows");
  const roleDirectory = join(packageRoot, "dist", "starter", "roles");
  mkdirSync(roleDirectory, { recursive: true });
  writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "pi-extensible-workflows" }));
  const registry = new WorkflowRegistry();
  registry.register({ version: "1.0.0", headline: "Starter roles", roleDirectories: [roleDirectory] });
  try {
    assert.equal(registry.roleDirectoryRegistrations()[0]?.builtin, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

void test("packages portable role settings without forbidden overrides", () => {
  registerStarter();
  const roles = new URL("../starter/roles/", import.meta.url);
  const developer = parseRoleMarkdown(readFileSync(new URL("developer.md", roles), "utf8"), true);
  const reviewer = parseRoleMarkdown(readFileSync(new URL("reviewer.md", roles), "utf8"), true);
  assert.deepEqual(
    { description: developer.description, model: developer.model, tools: developer.tools, skills: developer.skills, overrideSystemPrompt: developer.overrideSystemPrompt },
    { description: "Developer focused agent", model: "developer-model", tools: undefined, skills: undefined, overrideSystemPrompt: undefined },
  );
  assert.deepEqual(
    { model: reviewer.model, tools: reviewer.tools, skills: reviewer.skills, overrideSystemPrompt: reviewer.overrideSystemPrompt },
    { model: "reviewer-model", tools: ["!*", "read", "grep", "find", "ls"], skills: undefined, overrideSystemPrompt: undefined },
  );
  assert.equal(reviewer.tools?.includes("bash"), false);
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
