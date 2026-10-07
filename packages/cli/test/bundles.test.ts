import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { portableEngineVersion, writePortableWorkflowBundle } from "../src/bundles.js";
import { readCliTestBundleState, readCliTestManifest, writeCliTestExtensionSource } from "./support.js";

type BundlePayload = { register: (registerWorkflowExtension: (extension: unknown) => void) => Promise<void> };

void test("bundles an extension module with runtime and local lexical dependencies", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-source-"));
  const previousApi = (globalThis as typeof globalThis & { __pi_bundle_api?: unknown }).__pi_bundle_api;
  try {
    const helper = join(root, "helper.mjs");
    writeFileSync(helper, 'export const suffix = "!";\n');
    const extension = join(root, "source-extension.mjs");
    writeFileSync(extension, [
      'import { Type } from "typebox";',
      'import { suffix } from "./helper.mjs";',
      'import { registerWorkflowExtension } from "pi-extensible-workflows";',
      'const prefix = "bundle:";',
      "function label(value) { return prefix + value; }",
      "const input = Type.Object({ value: Type.String() });",
      "export default function extension() {",
      '  registerWorkflowExtension({ version: "1.0.0", headline: "Source extension", functions: { sourceWorkflow: { description: "Source workflow", input, output: Type.String(), run(value) { return label(value.value) + suffix; } } } });',
      "}",
      "",
    ].join("\n"));
    const resource = join(root, "resource-extension.mjs");
    writeFileSync(resource, [
      'import { registerWorkflowExtension as register } from "pi-extensible-workflows";',
      "export default function resource() {",
      '  register({ version: "1.0.0", headline: "Resource extension", functions: { resourceWorkflow: { description: "Resource workflow", input: { type: "object" }, output: { type: "string" }, run() { return "resource"; } } } });',
      "}",
      "",
    ].join("\n"));
    const destination = join(root, "bundle");
    const manifest = await writePortableWorkflowBundle({
      destination,
      command: "source-bundle",
      workflow: { name: "sourceWorkflow", version: "1.0.0", headline: "Source extension", description: "Source workflow", input: { type: "object" }, output: { type: "string" } },
      source: { module: pathToFileURL(extension).href, export: "default" },
      dependencies: ["typebox"],
      piVersion: "unknown",
      engineVersion: "unknown",
      resources: { extensions: [resource] },
    });
    assert.equal(manifest.version, 2);
    assert.deepEqual(manifest.source, { module: "source-extension.mjs", export: "default" });
    assert.deepEqual(manifest.dependencies, ["typebox"]);
    assert.equal(typeof manifest.bundler?.esbuild, "string");
    const registered: Array<{ functions?: Record<string, { run: (input: { value: string }) => string }> }> = [];
    const api = { registerWorkflowExtension: (value: unknown) => registered.push(value as typeof registered[number]) };
    (globalThis as typeof globalThis & { __pi_bundle_api: unknown }).__pi_bundle_api = api;
    const payload = await import(pathToFileURL(join(destination, "payload", "workflow.mjs")).href) as BundlePayload;
    await payload.register(api.registerWorkflowExtension);
    assert.equal(registered.length, 2);
    assert.equal(registered.find((extension) => extension.functions?.resourceWorkflow)?.functions?.resourceWorkflow?.run({ value: "ok" }), "resource");
    assert.equal(registered.find((extension) => extension.functions?.sourceWorkflow)?.functions?.sourceWorkflow?.run({ value: "ok" }), "bundle:ok!");
  } finally {
    if (previousApi === undefined) delete (globalThis as typeof globalThis & { __pi_bundle_api?: unknown }).__pi_bundle_api;
    else (globalThis as typeof globalThis & { __pi_bundle_api: unknown }).__pi_bundle_api = previousApi;
    rmSync(root, { recursive: true, force: true });
  }
});

void test("bundle rejects Pi package imports even when declared", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-external-dependency-"));
  try {
    const extension = join(root, "external-extension.mjs");
    writeFileSync(extension, 'import { something } from "@earendil-works/pi-ai"; export default function () { return something; }\n');
    for (const dependencies of [undefined, ["@earendil-works/pi-ai"]]) {
      await assert.rejects(writePortableWorkflowBundle({
        destination: join(root, "bundle"),
        command: "external-bundle",
        workflow: { name: "sourceWorkflow", version: "1.0.0", headline: "Source extension", description: "Source extension", input: { type: "object" }, output: { type: "string" } },
        source: { module: pathToFileURL(extension).href, export: "default" },
        ...(dependencies ? { dependencies } : {}),
        piVersion: "unknown",
        engineVersion: "unknown",
      }), /Pi packages \(@earendil-works\/\*\) cannot be bundled; use the pi-extensible-workflows API instead/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("bundle rejects a source module without the selected export", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-export-"));
  try {
    const extension = join(root, "named-extension.mjs");
    writeFileSync(extension, "export function named() {}\n");
    await assert.rejects(writePortableWorkflowBundle({
      destination: join(root, "bundle"),
      command: "export-bundle",
      workflow: { name: "sourceWorkflow", version: "1.0.0", headline: "Source extension", description: "Source extension", input: { type: "object" }, output: { type: "string" } },
      source: { module: pathToFileURL(extension).href, export: "default" },
      piVersion: "unknown",
      engineVersion: "unknown",
    }), /does not export default/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("bundle reports when esbuild is not installed in the project", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-esbuild-"));
  const previousCwd = process.cwd();
  try {
    const extension = join(root, "source-extension.mjs");
    writeFileSync(extension, "export default function extension() {}\n");
    process.chdir(root);
    await assert.rejects(writePortableWorkflowBundle({
      destination: join(root, "bundle"),
      command: "missing-esbuild",
      workflow: { name: "sourceWorkflow", version: "1.0.0", headline: "Source extension", description: "Source extension", input: { type: "object" }, output: { type: "string" } },
      source: { module: pathToFileURL(extension).href, export: "default" },
      piVersion: "unknown",
      engineVersion: "unknown",
    }), /Install esbuild in the project/);
  } finally {
    process.chdir(previousCwd);
    rmSync(root, { recursive: true, force: true });
  }
});
void test("bundle rejects undeclared package imports", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-dependency-"));
  try {
    const extension = join(root, "undeclared-extension.mjs");
    writeFileSync(extension, 'import { Type } from "typebox"; export default function () { void Type; }\n');
    await assert.rejects(writePortableWorkflowBundle({
      destination: join(root, "bundle"),
      command: "undeclared-bundle",
      workflow: { name: "sourceWorkflow", version: "1.0.0", headline: "Source extension", description: "Source workflow", input: { type: "object" }, output: { type: "string" } },
      source: { module: pathToFileURL(extension).href, export: "default" },
      piVersion: "unknown",
      engineVersion: "unknown",
    }), /Undeclared dependencies: typebox/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("bundle ignores dynamic import text in comments and strings", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-dynamic-text-"));
  try {
    const extension = join(root, "dynamic-text-extension.mjs");
    writeFileSync(extension, 'const text = "import(specifier)"; // import(specifier)\nexport default function extension() { return text; }\n');
    await writePortableWorkflowBundle({
      destination: join(root, "bundle"),
      command: "dynamic-text-bundle",
      workflow: { name: "sourceWorkflow", version: "1.0.0", headline: "Source extension", description: "Source extension", input: { type: "object" }, output: { type: "string" } },
      source: { module: pathToFileURL(extension).href, export: "default" },
      piVersion: "unknown",
      engineVersion: "unknown",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
void test("bundle rejects unsupported dynamic imports", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-dynamic-"));
  try {
    const sources = {
      "dynamic-extension.mjs": 'export default function extension(specifier) { return import(specifier); }\n',
      "regex-extension.mjs": "const quote = /'/;\nexport default function extension(s) { return [quote, import(s)]; }\n",
    };
    for (const [name, source] of Object.entries(sources)) {
      const extension = join(root, name);
      writeFileSync(extension, source);
      await assert.rejects(writePortableWorkflowBundle({
        destination: join(root, "bundle"),
        command: "dynamic-bundle",
        workflow: { name: "sourceWorkflow", version: "1.0.0", headline: "Source extension", description: "Source workflow", input: { type: "object" }, output: { type: "string" } },
        source: { module: pathToFileURL(extension).href, export: "default" },
        piVersion: "unknown",
        engineVersion: "unknown",
      }), new RegExp(`Unsupported dynamic import in .*${name}: dynamic imports must use a string-literal module path`));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("bundle shim omits invalid emitted names", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-"));
  try {
    const extension = join(root, "invalid-extension.mjs");
    writeFileSync(extension, 'import { "invalid-name" as validName } from "pi-extensible-workflows";\n');
    const source = join(root, "source-extension.mjs");
    writeFileSync(source, "export default function extension() {}\n");
    const destination = join(root, "bundle");
    await writePortableWorkflowBundle({
      destination,
      command: "invalid-name-bundle",
      workflow: { name: "bundle-test", version: "1.0.0", headline: "Bundle test", description: "Bundle test", input: { type: "object" }, output: { type: "string" } },
      source: { module: pathToFileURL(source).href, export: "default" },
      piVersion: "unknown",
      engineVersion: "unknown",
      resources: { extensions: [extension] },
    });

    const shim = readFileSync(join(destination, "payload", "node_modules", "pi-extensible-workflows", "index.mjs"), "utf8");
    assert.equal(shim, "\n");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("portable bundle setup and launch preserve generic requirements without a roles runtime", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-runtime-"));
  t.after(() => { rmSync(root, { recursive: true, force: true }); });
  const agentDir = join(root, "agent");
  const engineDirectory = join(agentDir, "npm", "node_modules", "@piewf");
  mkdirSync(engineDirectory, { recursive: true });
  symlinkSync(process.cwd(), join(engineDirectory, "cli"));
  const workflow = { name: "bundleRuntime", version: "1.0.0", headline: "Bundle", description: "Generic bundle runtime", input: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false }, output: { type: "integer" } };
  const source = writeCliTestExtensionSource(join(root, "extension.mjs"), workflow, "async run(input) { return input.value; }");
  const environment = { ...process.env, PATH: `${resolve("../../node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}`, HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" };
  const create = async (command: string, extra: Partial<Parameters<typeof writePortableWorkflowBundle>[0]> = {}) => {
    const destination = join(root, command);
    await writePortableWorkflowBundle({ destination, command, workflow, source, piVersion: "1.0.0", engineVersion: portableEngineVersion(), ...extra });
    return destination;
  };
  const run = (directory: string, args: string[]) => spawnSync(process.execPath, [join(directory, "payload", "runner.mjs"), ...args], { cwd: root, env: environment, encoding: "utf8", timeout: 30_000 });
  const bundle = await create("success");
  assert.deepEqual(readCliTestManifest(join(bundle, "manifest.json")).requirements, { aliases: [], tools: [], commands: [], environment: [] });
  assert.equal(existsSync(join(bundle, "payload", "node_modules", "@piewf", "pi-ext-roles")), false);
  const setup = run(bundle, ["setup", "--yes"]);
  assert.equal(setup.status, 0, setup.stderr);
  const launched = run(bundle, ["7"]);
  assert.equal(launched.status, 0, launched.stderr);
  assert.equal(launched.stdout.trim(), "7");
  const statePath = join(bundle, "bundle-state.json");
  const state = readCliTestBundleState(statePath);
  writeFileSync(statePath, JSON.stringify({ ...state, engine: "0.0.0" }));
  assert.match(run(bundle, ["7"]).stderr, /Bundle setup is missing or stale/);
  const mismatch = await create("pi-mismatch", { piVersion: "0.82.0" });
  assert.match(run(mismatch, ["setup", "--yes"]).stderr, /Bundle requires Pi 0\.82\.0; found 1\.0\.0/);
  const missingEngine = await create("missing-engine", { engineVersion: "0.0.0" });
  assert.match(run(missingEngine, ["7"]).stderr, /no installation is performed during launch/);
  assert.match(run(missingEngine, ["setup"]).stderr, /compatible @piewf\/cli package is missing/);
  const tools = await create("builtin-tools", { requirements: { tools: ["grep", "find", "ls"] } });
  const toolsSetup = run(tools, ["setup", "--yes"]);
  assert.equal(toolsSetup.status, 0, toolsSetup.stderr);
  const skill = join(root, "selected-skill");
  mkdirSync(skill);
  writeFileSync(join(skill, "SKILL.md"), "---\nname: selected-skill\ndescription: Selected bundle skill\n---\nSkill instructions");
  const skills = await create("skills", { resources: { skills: [skill] } });
  assert.deepEqual(readCliTestManifest(join(skills, "manifest.json")).payload?.skills, ["selected-skill"]);
  const skillsSetup = run(skills, ["setup", "--yes"]);
  assert.equal(skillsSetup.status, 0, skillsSetup.stderr);
  const skillsLaunch = run(skills, ["7"]);
  assert.equal(skillsLaunch.status, 0, skillsLaunch.stderr);
  assert.equal(skillsLaunch.stdout.trim(), "7");
  for (const [command, requirements, error] of [
    ["missing-command", { commands: ["piewf-fixture-missing-command"] }, /Missing required external command/],
    ["missing-alias", { aliases: ["piewf-fixture-missing-alias"] }, /Required model alias is unknown/],
    ["missing-environment", { environment: ["PIEWF_FIXTURE_MISSING_ENV"] }, /Missing required environment variable/],
    ["missing-tool", { tools: ["piewf-fixture-missing-tool"] }, /Required Pi tool is unavailable/],
  ] as const) {
    const failing = await create(command, { requirements });
    const result = run(failing, ["setup", "--yes"]);
    assert.notEqual(result.status, 0, result.stderr);
    assert.match(result.stderr, error);
    assert.equal(existsSync(join(failing, "bundle-state.json")), false);
  }
});
