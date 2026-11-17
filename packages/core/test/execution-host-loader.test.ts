import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";

const execution = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../src/execution.js")).href;

// A host that runs extensions under a Node loader puts it in process.execArgv: PiG starts its extension host with
// `--import file:///…/runtime/register-loader.mjs`. The worker is forked with the host's flags under --permission and may read
// only its own directory, so such a loader could never load there: before the fix the worker ended at start ("Workflow child
// exited with code 1"). Each spelling of a loader flag is dropped, on the command line and in NODE_OPTIONS; the host itself still ran its loader.
void test("a workflow runs when the host process was started with a loader outside the worker's directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "pew loader-"));
  try {
    const esm = join(dir, "loader.mjs");
    const cjs = join(dir, "loader.cjs");
    // Each loader leaves a mark where the host can see it: a --loader module runs off the main thread.
    const ran = join(dir, "ran");
    writeFileSync(esm, `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(ran)}, "1");\n`);
    writeFileSync(cjs, `require("node:fs").writeFileSync(${JSON.stringify(ran)}, "1");\n`);
    const script = `
      const { runWorkflow } = await import(${JSON.stringify(execution)});
      const value = await runWorkflow("return 2 + 3;").result;
      process.stdout.write(JSON.stringify(value));`;
    for (const flags of [
      ["--import", pathToFileURL(esm).href],
      [`--import=${pathToFileURL(esm).href}`],
      ["--require", cjs],
      [`--require=${cjs}`],
      ["-r", cjs],
      ["--loader", pathToFileURL(esm).href],
      [`--loader=${pathToFileURL(esm).href}`],
      ["--experimental-loader", pathToFileURL(esm).href],
      [`--experimental-loader=${pathToFileURL(esm).href}`],
      [`--experimental_loader=${pathToFileURL(esm).href}`],
    ]) {
      rmSync(ran, { force: true });
      const run = spawnSync(process.execPath, [...flags, "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 });
      assert.ok(existsSync(ran), `${flags.join(" ")}: control: the host's own loader did not run`);
      assert.equal(run.status, 0, `${flags.join(" ")}: the host process failed:\n${run.stderr}`);
      assert.equal(run.stdout, "5", flags.join(" "));
    }
    // The same loaders set in NODE_OPTIONS (quoted, behind an empty "" Node drops), beside options that are not loaders: the worker
    // keeps those (--disable-proto=throw is seen from the workflow). A value ending in a backslash must be written back escaped, or
    // Node refuses the worker's NODE_OPTIONS as an unterminated string and the worker ends at start.
    rmSync(ran, { force: true });
    const options = `-r "" "${cjs}" --experimental_loader=${pathToFileURL(esm).href} --disable-proto=throw "--title=a \\"b\\"" --title=a\\`;
    const proto = script.replace("return 2 + 3;", 'try { ({}).__proto__; return \\"proto\\"; } catch { return \\"no proto\\"; }');
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", proto], { encoding: "utf8", timeout: 60_000, env: { ...process.env, NODE_OPTIONS: options } });
    assert.ok(existsSync(ran), "NODE_OPTIONS: control: the host's own loader did not run");
    assert.equal(run.status, 0, `NODE_OPTIONS: the host process failed:\n${run.stderr}`);
    assert.equal(run.stdout, '"no proto"', "NODE_OPTIONS");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
