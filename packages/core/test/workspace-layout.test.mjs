import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
    "./process": "./dist/src/process-launcher.js",
    "./budget": "./dist/src/budget.js",
    "./validation": "./dist/src/validation.js",
    "./roles": "./dist/src/roles.js",
    "./registry": "./dist/src/registry.js",
    "./runtime": "./dist/src/runtime/index.js",
    "./trajectory": "./dist/trajectory/index.js"
  });
  assert.equal(core.bin, undefined);
  assert.ok(core.files.includes("starter"));
  assert.ok(core.files.includes("dist/trajectory"));
  assert.ok(core.files.includes("!dist/**/test/**"));
  assert.ok(core.files.includes("!dist/**/*.test.*"));
  for (const path of ["dist/trajectory/src/assets/semantic-map.html", "dist/trajectory/src/assets/semantic-map.js", "dist/trajectory/src/assets/semantic-map.css", "trajectory/src/assets/semantic-map.html", "trajectory/src/assets/semantic-map.js", "trajectory/src/assets/semantic-map.css", "trajectory/src/semantic-map.css"]) assert.ok(core.files.includes(`!${path}`));
  assert.ok(core.files.includes("trajectory/vendor/archify/LICENSE"));
  assert.match(core.scripts.build, /workspace-build\.mjs core/);
  assert.match(core.scripts["test:run"], /run-workspace-tests\.mjs/);
  assert.match(core.scripts["test:subagents"], /run-workspace-tests\.mjs/);
  assert.match(cli.scripts.build, /workspace-build\.mjs cli/);
  assert.match(cli.scripts["test:run"], /run-workspace-tests\.mjs/);
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
  assert.equal(cli.bin["pi-role"], "./dist/src/pi-role.js");
  assert.equal(cli.publishConfig.access, "public");
});

// Staging tests run a copy of the script inside a temporary repository layout; they never touch this checkout's
// packages/core/CHANGELOG.md or .tmp/core-changelog-staged.
function stagingSandbox(t) {
  const root = mkdtempSync(resolve(tmpdir(), "piewf-changelog-stage-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(resolve(root, "scripts"));
  mkdirSync(resolve(root, "packages/core"), { recursive: true });
  copyFileSync(resolve(repositoryRoot, "scripts/stage-core-changelog.mjs"), resolve(root, "scripts/stage-core-changelog.mjs"));
  writeFileSync(resolve(root, "CHANGELOG.md"), "# Changelog\r\n\n- root entry\n");
  const run = (action) => spawnSync(process.execPath, [resolve(root, "scripts/stage-core-changelog.mjs"), action], { cwd: root, encoding: "utf8", windowsHide: true, timeout: 10_000 });
  return { root, run, destination: resolve(root, "packages/core/CHANGELOG.md"), marker: resolve(root, ".tmp/core-changelog-staged") };
}

test("pack staging does not overwrite or remove a package-local changelog", (t) => {
  const { run, destination, marker } = stagingSandbox(t);
  writeFileSync(destination, "package-local changelog");
  assert.notEqual(run("preflight").status, 0);
  const staged = run("stage");
  assert.equal(staged.status, 1);
  assert.match(staged.stderr, /Refusing to overwrite/);
  assert.equal(existsSync(marker), false);
  assert.equal(run("clean").status, 0);
  assert.equal(readFileSync(destination, "utf8"), "package-local changelog");
});

test("pack staging never adopts, overwrites or deletes a marker it does not own", (t) => {
  const { run, destination, marker } = stagingSandbox(t);
  mkdirSync(dirname(marker), { recursive: true });
  writeFileSync(marker, "someone else's staging");
  assert.notEqual(run("preflight").status, 0);
  assert.equal(run("stage").status, 1);
  assert.equal(readFileSync(marker, "utf8"), "someone else's staging");
  assert.equal(existsSync(destination), false);
  writeFileSync(destination, "user file");
  const cleaned = run("clean");
  assert.equal(cleaned.status, 1);
  assert.match(cleaned.stderr, /not written by this script/);
  assert.equal(readFileSync(marker, "utf8"), "someone else's staging");
  assert.equal(readFileSync(destination, "utf8"), "user file");
});

test("pack staging owns exactly its copy and cleans it without touching unrelated files", (t) => {
  const { root, run, destination, marker } = stagingSandbox(t);
  mkdirSync(resolve(root, ".tmp"));
  writeFileSync(resolve(root, ".tmp/unrelated"), "keep");
  assert.equal(run("preflight").status, 0);
  const staged = run("stage");
  assert.equal(staged.status, 0, staged.stderr);
  assert.deepEqual(readFileSync(destination), readFileSync(resolve(root, "CHANGELOG.md")));
  assert.match(readFileSync(marker, "utf8"), /stage-core-changelog/);
  // An interrupted pack leaves the staging behind; staging again refuses and clean recovers only the owned copy.
  assert.equal(run("stage").status, 1);
  assert.equal(run("clean").status, 0);
  assert.equal(existsSync(destination), false);
  assert.equal(existsSync(marker), false);
  assert.equal(readFileSync(resolve(root, ".tmp/unrelated"), "utf8"), "keep");
  assert.equal(run("preflight").status, 0);
});

test("pack staging preserves a staged changelog edited after staging", (t) => {
  const { run, destination, marker } = stagingSandbox(t);
  assert.equal(run("stage").status, 0);
  writeFileSync(destination, "edited by the user");
  const cleaned = run("clean");
  assert.equal(cleaned.status, 1);
  assert.match(cleaned.stderr, /changed after staging/);
  assert.equal(readFileSync(destination, "utf8"), "edited by the user");
  assert.equal(existsSync(marker), true);
});

test("failed pack staging leaves no owned staging behind", (t) => {
  const { root, run, destination, marker } = stagingSandbox(t);
  rmSync(resolve(root, "CHANGELOG.md"));
  assert.equal(run("stage").status, 1);
  assert.equal(existsSync(destination), false);
  assert.equal(existsSync(marker), false);
});
