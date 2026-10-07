import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { type TestContext } from "node:test";
import workflowExtension, { resolveWorkflowSettings, workflowCatalog, workflowCatalogIndex } from "../src/index.js";
import { testExtensionApi } from "./support.js";

function fixture(t: TestContext) {
  const home = mkdtempSync(join(tmpdir(), "workflow-global-alias-migration-"));
  const agentDir = join(home, "agent"), cwd = join(home, "project");
  const globalSettingsPath = join(agentDir, "pi-extensible-workflows", "settings.json");
  const projectPaths = [join(cwd, ".pi", "pi-ext-roles", "settings.json"), join(cwd, ".pi", "pi-extensible-workflows", "settings.json")];
  for (const [path, settings] of [
    [join(agentDir, "pi-ext-roles", "settings.json"), { modelAliases: { overridden: "shared/model" } }],
    [globalSettingsPath, { backgroundWidget: false, modelAliases: { overridden: "workflow/model", consumer: "workflow/model" } }],
    ...projectPaths.map((path) => [path, { modelAliases: { project: "project/model" } }] as const),
  ] as const) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(settings));
  }
  const previousCwd = process.cwd(), previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.chdir(cwd);
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(home, { recursive: true, force: true });
  });
  return { home, agentDir, cwd, globalSettingsPath, projectPaths };
}

void test("host initialization registers workflow aliases independently without project trust", (t) => {
  const { home, agentDir, cwd, globalSettingsPath, projectPaths } = fixture(t);
  // Invalid project JSON proves initialization and untrusted routing never read either project file.
  for (const path of projectPaths) writeFileSync(path, "{");
  type Definition = { provider: string; id: string; route: (request: { thinkingLevel: string }, ctx: unknown) => { model: unknown; thinkingLevel: string } };
  const definitions: Definition[] = [];
  workflowExtension(Object.assign(testExtensionApi(), { registerVirtualModel: (definition: Definition) => { definitions.push(definition); } }), home, undefined, undefined, agentDir);
  assert.deepEqual(definitions.map(({ provider, id }) => `${provider}/${id}`).sort(), ["workflow/consumer", "workflow/overridden"]);
  const shared = { provider: "shared", id: "model" }, consumer = { provider: "workflow", id: "model" };
  const ctx = { cwd, isProjectTrusted: () => false, modelRegistry: { getAll: () => [shared, consumer], find: (provider: string, id: string) => [shared, consumer].find((model) => model.provider === provider && model.id === id) } };
  assert.equal(definitions.find(({ id }) => id === "shared"), undefined);
  assert.deepEqual(definitions.find(({ id }) => id === "overridden")?.route({ thinkingLevel: "low" }, ctx), { model: consumer, thinkingLevel: "low" });
  assert.equal(resolveWorkflowSettings(cwd, false, globalSettingsPath).effective.backgroundWidget, false);
});

void test("context-free public catalogs compose global aliases without project reads and preserve redaction", (t) => {
  const { home, cwd, globalSettingsPath, projectPaths } = fixture(t);
  const context = { cwd, projectTrusted: true, globalSettingsPath };
  const explicitBefore = workflowCatalog(context), indexBefore = workflowCatalogIndex(context);
  assert.deepEqual(explicitBefore.modelAliases, resolveWorkflowSettings(cwd, true, globalSettingsPath).effective.modelAliases);
  assert.equal(explicitBefore.modelAliases?.project, "project/model");
  for (const path of projectPaths) writeFileSync(path, "{");
  for (const catalog of [workflowCatalog(), workflowCatalogIndex()]) {
    assert.deepEqual(catalog.modelAliases, { overridden: "workflow/model", consumer: "workflow/model" });
    assert.deepEqual(catalog.modelAliasEntries?.map(({ name, kind, provenance }) => ({ name, kind, provenance })), ["consumer", "overridden"].map((name) => ({ name, kind: "static", provenance: "global settings" })));
    assert.equal(Object.getOwnPropertyDescriptor(catalog, "modelAliases")?.enumerable, false);
    assert.equal(Object.isFrozen(catalog.modelAliases), true);
    assert.deepEqual(Object.keys(catalog).sort(), ["functions", "modelAliasEntries"]);
    assert.doesNotMatch(JSON.stringify(catalog), /shared\/model|workflow\/model|project/);
  }
  for (const path of projectPaths) writeFileSync(path, JSON.stringify({ modelAliases: { project: "project/model" } }));
  assert.deepEqual(workflowCatalog(context), explicitBefore);
  assert.deepEqual(workflowCatalogIndex(context), indexBefore);
  assert.deepEqual(workflowCatalog(context).modelAliases, explicitBefore.modelAliases);
  const emptyContext = { cwd, projectTrusted: false, globalSettingsPath: join(home, "other-agent", "pi-extensible-workflows", "settings.json") };
  for (const catalog of [workflowCatalog(emptyContext), workflowCatalogIndex(emptyContext)]) {
    assert.deepEqual(catalog.modelAliases, { overridden: "workflow/model", consumer: "workflow/model" });
  }
});
