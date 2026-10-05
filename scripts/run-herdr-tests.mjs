import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.HERDR_ENV !== "1") {
  process.stdout.write("Skipping Herdr integration tests: HERDR_ENV=1 is required; run inside a Herdr pane to exercise them.\n");
} else {
  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "piewf-herdr-test-"));
  try {
    const child = spawn(process.execPath, [
      "--expose-gc", "--test", "--test-concurrency=1", "--test-timeout=180000", "--test-force-exit", "--test-reporter=dot",
      "dist/test/navigator.test.js", "dist/test/trajectory-e2e.test.js",
    ], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../packages/core"),
      env: { ...process.env, TMPDIR: temporaryDirectory, TMP: temporaryDirectory, TEMP: temporaryDirectory },
      stdio: "inherit",
      windowsHide: true,
    });
    const code = await new Promise((resolvePromise, reject) => {
      child.once("error", reject);
      child.once("close", (exitCode, signal) => resolvePromise(signal ? 1 : exitCode ?? 1));
    });
    process.exitCode = code;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}
