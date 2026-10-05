import assert from "node:assert/strict";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { readdirSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
// Root `test:tools` runs only this file, so importing the Semantic Map generator regressions registers them in the same run.
import "./build-semantic-map.test.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runner = resolve(repositoryRoot, "scripts/run-workspace-tests.mjs");
const fixtureRoot = "test/fixtures/workspace-test-runner";

function executeRunner(pattern, marker, extra = [], env = {}) {
  const childEnv = { ...process.env, RUNNER_TEST_MARKER: marker, ...env };
  const cleanEnv = Object.fromEntries(Object.entries(childEnv).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
  return spawnSync(process.execPath, [runner, "--workspace=core", `--pattern=${pattern}`, "--agent-dir", "--unset-herdr", "--concurrency=1", ...extra], {
    cwd: repositoryRoot,
    env: cleanEnv,
    encoding: "utf8",
    timeout: 15_000,
  });
}

function waitFor(predicate, timeoutMs) {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const poll = () => {
      if (predicate()) resolvePromise();
      else if (Date.now() - started >= timeoutMs) reject(new Error("Timed out waiting for the isolated test worker"));
      else globalThis.setTimeout(poll, 20);
    };
    poll();
  });
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error?.code === "EPERM") return true; return false; }
}

void test("workspace test runner honors file selection, env isolation and exit status", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "piewf-workspace-tools-"));
  const marker = resolve(directory, "selected.json");
  try {
    const selected = executeRunner(`${fixtureRoot}/failing.test.mjs`, marker, [], {
      HERDR_ENV: "1", HERDR_PANE_ID: "personal-pane", HERDR_SOCKET_PATH: "personal-socket", HERDR_TAB_ID: "personal-tab", HERDR_WORKSPACE_ID: "personal-workspace",
      TEST_FILES: `${fixtureRoot}/selected.test.mjs`,
    });
    assert.equal(selected.status, 0, selected.stderr || selected.stdout);
    const isolated = JSON.parse(readFileSync(marker, "utf8"));
    assert.equal(isolated.home, dirname(isolated.agent));
    assert.equal(isolated.temp, isolated.home);

    const failed = executeRunner(`${fixtureRoot}/failing.test.mjs`, marker);
    assert.equal(failed.status, 1, failed.stderr || failed.stdout);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("workspace test runner cancellation terminates its owned process tree and removes isolation", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "piewf-workspace-cancel-"));
  const marker = resolve(directory, "worker.json");
  const childEnv = { ...process.env, RUNNER_TEST_MARKER: marker };
  const cleanEnv = Object.fromEntries(Object.entries(childEnv).filter(([key]) => key !== "NODE_TEST_CONTEXT"));
  const child = spawn(process.execPath, [runner, "--workspace=core", `--pattern=${fixtureRoot}/long.test.mjs`, "--agent-dir", "--concurrency=1", "--cancel-after-ms=800"], {
    cwd: repositoryRoot,
    env: cleanEnv,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitFor(() => existsSync(marker), 8_000);
    const { workerHome, childPid } = JSON.parse(readFileSync(marker, "utf8"));
    const exit = await new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolvePromise({ code, signal }));
    });
    assert.deepEqual(exit, { code: 143, signal: null }, stderr);
    assert.equal(existsSync(workerHome), false, "per-test HOME and temp directory were not cleaned");
    // The runner must wait for its owned tree before exiting, so the descendant is already gone here.
    assert.equal(processAlive(childPid), false, "owned descendant survived runner cancellation");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    rmSync(directory, { recursive: true, force: true });
  }
});

void test("workspace test runner timeout fails the file and stops its owned descendants", (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "piewf-workspace-timeout-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const marker = resolve(directory, "worker.json");
  const result = spawnSync(process.execPath, [runner, "--workspace=core", `--pattern=${fixtureRoot}/long.test.mjs`, "--agent-dir", "--concurrency=1", "--timeout=1500"], {
    cwd: repositoryRoot, env: runnerEnvironment({ RUNNER_TEST_MARKER: marker }), encoding: "utf8", timeout: 20_000, windowsHide: true,
  });
  const { workerHome, childPid } = JSON.parse(readFileSync(marker, "utf8"));
  const survived = processAlive(childPid);
  // Cleanup for a fail-first run only: the PID was created by this test seconds ago.
  if (survived) try { process.kill(childPid); } catch { /* Already gone. */ }
  assert.equal(result.status, 1, `${String(result.error)} ${result.stderr}`);
  assert.match(result.stderr, /FAILED .*long\.test\.mjs \(exit 1\)/);
  assert.equal(survived, false, "owned descendant survived the file timeout");
  assert.equal(existsSync(workerHome), false, "per-test HOME and temp directory were not cleaned");
});

function runnerEnvironment(extra) {
  return Object.fromEntries(Object.entries({ ...process.env, ...extra }).filter(([key]) => key !== "NODE_TEST_CONTEXT" && key.toUpperCase() !== "TEST_FILES"));
}

const selectionRoot = `${fixtureRoot}/selection`;
const excludedFixture = `${selectionRoot}/excluded.test.mjs`;

// Runs the selection fixtures (alpha, excluded, "spaced name") and returns the basenames that actually executed.
function runSelection(t, { testFiles, patterns = [`${selectionRoot}/*.test.mjs`], excludes = [] }) {
  const directory = mkdtempSync(resolve(tmpdir(), "piewf-workspace-select-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const log = resolve(directory, "ran.log");
  const env = runnerEnvironment({ RUNNER_TEST_LOG: log });
  if (testFiles !== undefined) env.TEST_FILES = testFiles;
  const args = [runner, "--workspace=core", ...patterns.map((pattern) => `--pattern=${pattern}`), ...excludes.map((path) => `--exclude=${path}`), "--concurrency=2", "--unset-herdr"];
  const result = spawnSync(process.execPath, args, { cwd: repositoryRoot, env, encoding: "utf8", timeout: 20_000, windowsHide: true });
  const ran = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean).sort() : [];
  return { status: result.status, output: `${result.stderr}${result.stdout}`, ran };
}

void test("workspace test runner selects TEST_FILES JSON arrays, including a real filename with spaces", (t) => {
  const spaced = runSelection(t, { testFiles: JSON.stringify([`${selectionRoot}/spaced name.test.mjs`]) });
  assert.equal(spaced.status, 0, spaced.output);
  assert.deepEqual(spaced.ran, ["spaced name.test.mjs"]);

  // Globs expand relative to the workspace, duplicates collapse, and exclusions apply to glob matches.
  const globbed = runSelection(t, { testFiles: JSON.stringify([`${selectionRoot}/*.test.mjs`, `${selectionRoot}\\alpha.test.mjs`]), excludes: [excludedFixture] });
  assert.equal(globbed.status, 0, globbed.output);
  assert.deepEqual(globbed.ran, ["alpha.test.mjs", "spaced name.test.mjs"]);

  // An exact file path is an explicit request and runs even when the manifest excludes it.
  const explicit = runSelection(t, { testFiles: JSON.stringify([excludedFixture]), excludes: [excludedFixture] });
  assert.equal(explicit.status, 0, explicit.output);
  assert.deepEqual(explicit.ran, ["excluded.test.mjs"]);
});

void test("workspace test runner keeps discovery exclusions and legacy TEST_FILES separators", (t) => {
  const discovered = runSelection(t, { excludes: [excludedFixture] });
  assert.equal(discovered.status, 0, discovered.output);
  assert.deepEqual(discovered.ran, ["alpha.test.mjs", "spaced name.test.mjs"]);

  const legacy = runSelection(t, { testFiles: ` ${selectionRoot}/alpha.test.mjs;${excludedFixture}\t${selectionRoot}/alpha.test.mjs\n`, excludes: [excludedFixture] });
  assert.equal(legacy.status, 0, legacy.output);
  assert.deepEqual(legacy.ran, ["alpha.test.mjs", "excluded.test.mjs"]);

  const legacyGlob = runSelection(t, { testFiles: `${selectionRoot}/*.test.mjs`, excludes: [excludedFixture] });
  assert.equal(legacyGlob.status, 0, legacyGlob.output);
  assert.deepEqual(legacyGlob.ran, ["alpha.test.mjs", "spaced name.test.mjs"]);
});

void test("workspace test runner rejects malformed or unmatched TEST_FILES before running any test", (t) => {
  const cases = [
    [`[${JSON.stringify(`${selectionRoot}/alpha.test.mjs`)}`, /TEST_FILES.*JSON/],
    ["[]", /TEST_FILES/],
    ["[1]", /TEST_FILES/],
    ['[""]', /TEST_FILES/],
    [JSON.stringify([`${selectionRoot}/alpha.test.mjs`, `${selectionRoot}/missing.test.mjs`]), /missing\.test\.mjs/],
    [`${selectionRoot}/spaced name.test.mjs`, /TEST_FILES.*spaced/],
    [JSON.stringify(["../cli/package.json"]), /outside the workspace/],
  ];
  for (const [testFiles, message] of cases) {
    const result = runSelection(t, { testFiles });
    assert.equal(result.status, 2, `${testFiles}: ${result.output}`);
    assert.match(result.output, message, testFiles);
    assert.deepEqual(result.ran, [], testFiles);
  }
});

void test("workspace test runner isolates personal variables case-insensitively without changing the parent", (t) => {
  const directory = mkdtempSync(resolve(tmpdir(), "piewf-workspace-env-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const personal = resolve(directory, "personal");
  mkdirSync(resolve(personal, "temp"), { recursive: true });
  const marker = resolve(directory, "selected.json");
  const isolatedNames = new Set(["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP", "PI_CODING_AGENT_DIR", "HERDR_ENV", "HERDR_PANE_ID"]);
  // Mixed-case spellings exercise Windows case-insensitive environment names.
  const personalEnv = {
    Home: personal, UserProfile: personal, AppData: resolve(personal, "AppData/Roaming"), LocalAppData: resolve(personal, "AppData/Local"),
    TmpDir: resolve(personal, "temp"), Tmp: resolve(personal, "temp"), Temp: resolve(personal, "temp"), Pi_Coding_Agent_Dir: resolve(personal, "agent"),
    Herdr_Env: "1", Herdr_Pane_Id: "personal-pane",
  };
  const env = Object.fromEntries(Object.entries(runnerEnvironment({})).filter(([key]) => !isolatedNames.has(key.toUpperCase())));
  Object.assign(env, personalEnv, { RUNNER_TEST_MARKER: marker, TEST_FILES: JSON.stringify([`${fixtureRoot}/selected.test.mjs`]) });
  const parentBefore = JSON.stringify(process.env);
  const personalBefore = readdirSync(personal, { recursive: true }).sort();
  const result = spawnSync(process.execPath, [runner, "--workspace=core", `--pattern=${fixtureRoot}/failing.test.mjs`, "--agent-dir", "--unset-herdr", "--concurrency=1"], {
    cwd: repositoryRoot, env, encoding: "utf8", timeout: 20_000, windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const { home, isolatedEnv } = JSON.parse(readFileSync(marker, "utf8"));
  const keys = isolatedEnv.map(([key]) => key.toUpperCase()).sort();
  assert.deepEqual(keys, ["APPDATA", "HOME", "LOCALAPPDATA", "PI_CODING_AGENT_DIR", "TEMP", "TMP", "TMPDIR", "USERPROFILE"]);
  for (const [key, value] of isolatedEnv) {
    assert.ok(value === home || value.startsWith(`${home}${sep}`), `${key}=${value} is not inside the isolated home`);
    assert.ok(!Object.values(personalEnv).includes(value), `${key} leaked a personal value`);
  }
  assert.notEqual(home, personal);
  assert.equal(existsSync(home), false, "isolated home was not removed");
  assert.equal(JSON.stringify(process.env), parentBefore);
  assert.deepEqual(readdirSync(personal, { recursive: true }).sort(), personalBefore);
});

// Builds a throwaway repository layout around a copy of workspace-build.mjs. Fake TypeScript/esbuild packages record
// each step, and bin/esbuild is a native-looking (non-JavaScript) file as esbuild installs it on Linux/macOS.
function fakeBuildRepository(t) {
  const root = mkdtempSync(resolve(tmpdir(), "piewf-workspace-build-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const log = resolve(root, "steps.jsonl");
  const write = (path, content) => { mkdirSync(dirname(resolve(root, path)), { recursive: true }); writeFileSync(resolve(root, path), content); };
  mkdirSync(resolve(root, "scripts"));
  copyFileSync(resolve(repositoryRoot, "scripts/workspace-build.mjs"), resolve(root, "scripts/workspace-build.mjs"));
  const record = (step) => `require("node:fs").appendFileSync(process.env.FAKE_BUILD_LOG, JSON.stringify(${step}) + "\\n");`;
  write("scripts/build-semantic-map.mjs", `import { createRequire } from "node:module"; const require = createRequire(import.meta.url); ${record(`{ step: "semantic-map", cwd: process.cwd() }`)}\n`);
  write("package.json", JSON.stringify({ name: "fake-root", private: true, workspaces: ["packages/core", "packages/cli"] }));
  for (const name of ["core", "cli"]) write(`packages/${name}/package.json`, JSON.stringify({ name: `fake-${name}`, type: "module" }));
  write("packages/core/starter/roles/role.md", "role");
  write("packages/core/trajectory/src/assets/asset.txt", "asset");
  write("node_modules/typescript/package.json", JSON.stringify({ name: "typescript" }));
  write("node_modules/typescript/bin/tsc", `${record(`{ step: "tsc", cwd: process.cwd(), args: process.argv.slice(2) }`)}
if (require("node:path").basename(process.cwd()) === "cli") { require("node:fs").mkdirSync("dist/src", { recursive: true }); for (const file of ["cli.js", "pi-role.js"]) require("node:fs").writeFileSync("dist/src/" + file, ""); }
`);
  write("node_modules/esbuild/package.json", JSON.stringify({ name: "esbuild", main: "lib/main.js", bin: { esbuild: "bin/esbuild" } }));
  write("node_modules/esbuild/lib/main.js", `exports.build = async (options) => { ${record(`{ step: "esbuild", cwd: process.cwd(), options }`)} return { errors: [], warnings: [] }; };\n`);
  write("node_modules/esbuild/bin/esbuild", new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0xff, 0xfe]));
  chmodSync(resolve(root, "node_modules/esbuild/bin/esbuild"), 0o755);
  const run = (target) => spawnSync(process.execPath, [resolve(root, "scripts/workspace-build.mjs"), target], { cwd: root, env: { ...process.env, FAKE_BUILD_LOG: log }, encoding: "utf8", windowsHide: true, timeout: 15_000 });
  const steps = () => readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  return { root, run, steps };
}

void test("workspace build bundles through the esbuild API without running bin/esbuild through Node", (t) => {
  const { root, run, steps } = fakeBuildRepository(t);
  const result = run("core");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const core = resolve(root, "packages/core");
  const recorded = steps();
  assert.deepEqual(recorded.map((entry) => entry.step), ["semantic-map", "tsc", "esbuild", "esbuild"]);
  assert.deepEqual(recorded[1].args, ["-p", "tsconfig.json"]);
  const common = { bundle: true, format: "esm", platform: "node", sourcemap: true, sourcesContent: false, absWorkingDir: core, logLevel: "warning" };
  assert.deepEqual(recorded[2].options, { ...common, entryPoints: ["src/index.ts", "starter/index.ts", "subagents/index.ts", "trajectory/index.ts"], packages: "external", outbase: ".", outdir: "dist" });
  assert.deepEqual(recorded[3].options, { ...common, entryPoints: ["trajectory/src/server.ts"], outfile: "dist/trajectory/src/server.js" });
  for (const path of ["dist/starter/roles/role.md", "dist/trajectory/src/assets/asset.txt", "dist/trajectory/assets/asset.txt"]) assert.ok(existsSync(resolve(core, path)), path);
});

void test("workspace CLI build rebuilds core before compiling the CLI", (t) => {
  const { root, run, steps } = fakeBuildRepository(t);
  const result = run("cli");
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.deepEqual(steps().map((entry) => `${entry.step}:${entry.cwd === resolve(root, "packages/cli") ? "cli" : "core"}`), ["semantic-map:core", "tsc:core", "esbuild:core", "esbuild:core", "tsc:cli"]);
});

void test("Semantic Map acceptance harness keeps the original 10-cycle heap warm-up by default; other values are explicit diagnostics", async () => {
  const harness = await import(new URL("./trajectory-semantic-map-acceptance.mjs", import.meta.url).href);
  assert.equal(harness.ORIGINAL_HEAP_WARMUPS, 10);
  const defaults = harness.parseArgs([]);
  assert.equal(defaults.heapWarmups, 10);
  assert.deepEqual({ warmups: defaults.warmups, opens: defaults.opens, ordinarySeconds: defaults.ordinarySeconds, heapCycles: defaults.heapCycles }, { warmups: 10, opens: 50, ordinarySeconds: 600, heapCycles: 50 });
  assert.equal(harness.parseArgs(["--heap-warmups", "50"]).heapWarmups, 50);
});

void test("CI browser evidence rejects skipped, failed, cancelled or missing required-browser results", async () => {
  const { tapProblems } = await import(new URL("./ci-browser-evidence.mjs", import.meta.url).href);
  const summary = (pass, skipped, fail = 0) => `# tests ${String(pass + skipped + fail)}\n# pass ${String(pass)}\n# fail ${String(fail)}\n# cancelled 0\n# skipped ${String(skipped)}\n# todo 0\n`;
  assert.deepEqual(tapProblems(`${summary(52, 0)}${summary(79, 0)}`), []);
  assert.deepEqual(tapProblems(summary(51, 1)), ["skipped: 1"]);
  assert.deepEqual(tapProblems(summary(51, 0, 1)), ["fail: 1"]);
  assert.deepEqual(tapProblems("ok 1 - nothing summarized\n"), ["no TAP summary found"]);
});
