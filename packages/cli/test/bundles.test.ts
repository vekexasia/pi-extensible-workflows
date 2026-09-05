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
    const destination = join(root, "bundle");
    writePortableWorkflowBundle({
      destination,
      command: "aliased-bundle",
      workflow: { name: "bundle-test", version: "1.0.0", headline: "Bundle test", description: "Bundle test", input: { type: "object" }, output: { type: "string" } },
      functionSource: "(input) => input",
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

void test("bundle shim omits invalid emitted names", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-bundle-"));
  try {
    const extension = join(root, "invalid-extension.mjs");
    writeFileSync(extension, 'import { "invalid-name" as validName } from "pi-extensible-workflows";\n');
    const destination = join(root, "bundle");
    writePortableWorkflowBundle({
      destination,
      command: "invalid-name-bundle",
      workflow: { name: "bundle-test", version: "1.0.0", headline: "Bundle test", description: "Bundle test", input: { type: "object" }, output: { type: "string" } },
      functionSource: "(input) => input",
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
