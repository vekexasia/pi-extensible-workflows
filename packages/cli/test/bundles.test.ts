import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { writePortableWorkflowBundle } from "../src/bundles.js";

type BundlePayload = { register: (registerWorkflowExtension: (extension: unknown) => void) => Promise<void> };

void test("bundle loads extensions with aliased workflow API imports", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-"));
  const previousApi = (globalThis as typeof globalThis & { __pi_bundle_api?: unknown }).__pi_bundle_api;
  try {
    const extension = join(root, "aliased-extension.mjs");
    writeFileSync(extension, [
      'import { registerWorkflowExtension as register } from "pi-extensible-workflows";',
      "export default function extension() {",
      '  register({ version: "1.0.0", headline: "Aliased extension", functions: {} });',
      "}",
      "",
    ].join("\n"));
    const source = join(root, "source-extension.mjs");
    writeFileSync(source, [
      'import { registerWorkflowExtension } from "pi-extensible-workflows";',
      "export default function extension() {",
      '  registerWorkflowExtension({ version: "1.0.0", headline: "Source extension", functions: { "bundle-test": { description: "Bundle test", input: { type: "object" }, output: { type: "string" }, run: (input) => input } } });',
      "}",
      "",
    ].join("\n"));
    const destination = join(root, "bundle");
    await writePortableWorkflowBundle({
      destination,
      command: "aliased-bundle",
      workflow: { name: "bundle-test", version: "1.0.0", headline: "Bundle test", description: "Bundle test", input: { type: "object" }, output: { type: "string" } },
      source: { module: pathToFileURL(source).href, export: "default" },
      piVersion: "unknown",
      engineVersion: "unknown",
      resources: { extensions: [extension] },
    });

    const registered: unknown[] = [];
    (globalThis as typeof globalThis & { __pi_bundle_api: unknown }).__pi_bundle_api = { registerWorkflowExtension: (value: unknown) => registered.push(value) };
    const payload = await import(pathToFileURL(join(destination, "payload", "workflow.mjs")).href) as BundlePayload;
    await payload.register((value: unknown) => registered.push(value));

    assert.equal(registered.length, 2);
    assert.deepEqual(registered[0], { version: "1.0.0", headline: "Aliased extension", functions: {} });
  } finally {
    if (previousApi === undefined) delete (globalThis as typeof globalThis & { __pi_bundle_api?: unknown }).__pi_bundle_api;
    else (globalThis as typeof globalThis & { __pi_bundle_api: unknown }).__pi_bundle_api = previousApi;
    rmSync(root, { recursive: true, force: true });
  }
});

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
      'import { registerWorkflowExtension } from "pi-extensible-workflows";',
      "export default function resource() {",
      '  registerWorkflowExtension({ version: "1.0.0", headline: "Resource extension", functions: { resourceWorkflow: { description: "Resource workflow", input: { type: "object" }, output: { type: "string" }, run() { return "resource"; } } } });',
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
