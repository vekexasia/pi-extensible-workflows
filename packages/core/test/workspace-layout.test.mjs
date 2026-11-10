import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runInNewContext } from "node:vm";

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
  assert.equal(cli.bin["pi-role"], undefined);
  assert.equal(core.dependencies["@piewf/pi-ext-roles"], undefined);
  assert.equal(cli.dependencies["@piewf/pi-ext-roles"], undefined);
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

for (const cpus of [1, 2]) {
  test(`core test runner limits parallel files to ${cpus} available CPU(s)`, () => {
    const root = mkdtempSync(join(tmpdir(), "pi-core-runner-"));
    try {
      const preload = join(root, "cpus.cjs");
      writeFileSync(preload, `require("node:os").availableParallelism = () => ${cpus};`);
      const traces = Array.from({ length: 4 }, (_, index) => join(root, `${index}.json`));
      const files = traces.map((trace, index) => {
        const file = join(root, `${index}.test.mjs`);
        writeFileSync(file, `import { writeFileSync } from "node:fs";
const start = Date.now();
await new Promise((resolve) => setTimeout(resolve, 250));
writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ start, end: Date.now() }));`);
        return file;
      });
      execFileSync("sh", ["-c", readPackage(resolve(coreRoot, "package.json")).scripts["test:run"]], {
        cwd: coreRoot,
        env: {
          ...process.env,
          PATH: `${dirname(process.execPath)}:${process.env.PATH}`,
          NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --require=${JSON.stringify(preload)}`,
          NODE_TEST_CONTEXT: undefined,
          TEST_FILES: files.join(" "),
        },
        stdio: "pipe",
      });
      const events = traces.flatMap((trace) => {
        const { start, end } = readPackage(trace);
        return [{ time: start, delta: 1 }, { time: end, delta: -1 }];
      }).sort((left, right) => left.time - right.time || left.delta - right.delta);
      let active = 0;
      let peak = 0;
      for (const { delta } of events) { active += delta; peak = Math.max(peak, active); }
      assert.ok(peak <= cpus, `${peak} test files ran together on ${cpus} CPU(s)`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}


test("Trajectory browser selection prefers stable Chrome, preserving overrides and Chromium fallback", () => {
  const source = readFileSync(resolve(coreRoot, "trajectory/test/trajectory-browser.test.ts"), "utf8");
  const selection = source.match(/function findBrowser\(\): string \| undefined \{[\s\S]*?\n\}/)?.[0];
  assert.ok(selection, "browser selector not found");
  const stable = "/usr/bin/google-chrome";
  const snapshot = "/usr/bin/chromium";
  for (const [override, available, expected] of [
    [undefined, [stable, snapshot], stable],
    ["/custom/chrome", [stable, snapshot, "/custom/chrome"], "/custom/chrome"],
    [undefined, [snapshot], snapshot],
    ["/missing/chrome", [stable, snapshot], stable],
  ]) {
    const selected = runInNewContext(`(${selection.replace("(): string | undefined", "()")})()`, {
      process: { env: { PI_TRAJECTORY_CHROME: override } },
      homedir: () => "/unused", readdirSync: () => [], execFileSync: () => "", join,
      existsSync: (path) => available.includes(path),
    });
    assert.equal(selected, expected);
  }
});
