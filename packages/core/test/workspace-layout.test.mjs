import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(coreRoot, "../..");
const cliRoot = resolve(repositoryRoot, "packages/cli");
const readPackage = (path) => JSON.parse(readFileSync(path, "utf8"));

test("the published core package includes compiled subagents", () => {
  const core = readPackage(resolve(coreRoot, "package.json"));
  assert.ok(core.files.includes("dist/subagents"));
});

test("the repository keeps the public package in the core workspace", () => {
  const root = readPackage(resolve(repositoryRoot, "package.json"));
  const core = readPackage(resolve(coreRoot, "package.json"));
  const cli = readPackage(resolve(cliRoot, "package.json"));

  assert.equal(root.private, true);
  assert.deepEqual(root.workspaces, ["packages/cli", "packages/core", "packages/extensions/*"]);
  assert.deepEqual(root.pi.extensions, ["./packages/core/src/index.ts", "./packages/core/starter/index.ts", "./packages/core/subagents/index.ts", "./packages/core/trajectory/index.ts"]);
  assert.equal(core.name, "pi-extensible-workflows");
  assert.equal(core.version, root.version);
  assert.notEqual(core.private, true);
  assert.deepEqual(core.pi.extensions, ["./dist/src/index.js", "./dist/starter/index.js", "./dist/subagents/index.js", "./dist/trajectory/index.js"]);
  assert.deepEqual(core.exports, {
    ".": "./dist/src/index.js",
    "./persistence": "./dist/src/persistence.js",
    "./types": "./dist/src/types.js",
    "./utils": "./dist/src/utils.js",
    "./budget": "./dist/src/budget.js",
    "./validation": "./dist/src/validation.js",
    "./registry": "./dist/src/registry.js",
    "./runtime": "./dist/src/runtime/index.js",
    "./trajectory": "./dist/trajectory/index.js"
  });
  assert.equal(core.bin, undefined);
  assert.ok(core.files.includes("starter"));
  assert.ok(core.files.includes("dist/trajectory"));
  assert.ok(core.files.includes("!dist/**/test/**"));
  assert.ok(core.files.includes("!dist/**/*.test.*"));
  assert.ok(core.files.includes("trajectory/index.ts"));
  assert.ok(core.files.includes("trajectory/src"));
  assert.ok(core.files.includes("subagents/index.ts"));
  assert.ok(core.files.includes("subagents/src"));
  assert.ok(core.files.includes("subagents/README.md"));
  assert.ok(core.files.includes("CHANGELOG.md"));
  assert.match(core.scripts.prepack, /stage-core-changelog\.mjs stage/);
  assert.match(core.scripts.postpack, /stage-core-changelog\.mjs clean/);
  assert.equal(cli.name, "@piewf/cli");
  assert.equal(cli.version, root.version);
  assert.equal(cli.bin.piewf, "./dist/src/cli.js");
  assert.equal(cli.publishConfig.access, "public");
});

test("pack staging does not overwrite a package-local changelog", () => {
  const destination = resolve(coreRoot, "CHANGELOG.md");
  const script = resolve(repositoryRoot, "scripts/stage-core-changelog.mjs");
  writeFileSync(destination, "package-local changelog");
  try {
    assert.throws(() => execFileSync(process.execPath, [script, "stage"], { stdio: "pipe" }), /Refusing to overwrite/);
    execFileSync(process.execPath, [script, "clean"]);
    assert.equal(readFileSync(destination, "utf8"), "package-local changelog");
  } finally {
    rmSync(destination, { force: true });
    execFileSync(process.execPath, [script, "clean"]);
  }
});
