import { chmod, cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaces = {
  core: resolve(repositoryRoot, "packages/core"),
  cli: resolve(repositoryRoot, "packages/cli"),
  herdr: resolve(repositoryRoot, "packages/extensions/herdr"),
};

function runNode(entrypoint, args, cwd) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entrypoint, ...args], { cwd, stdio: "inherit", windowsHide: true });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${entrypoint} failed${signal ? ` with ${signal}` : ` with exit code ${String(code)}`}`));
    });
  });
}

async function removeDist(workspace) {
  await rm(resolve(workspace, "dist"), { recursive: true, force: true });
}

async function runPackageTool(workspace, packageName, entrypoint, args) {
  const require = createRequire(resolve(workspace, "package.json"));
  await runNode(require.resolve(`${packageName}/${entrypoint}`), args, workspace);
}

async function buildCore() {
  const workspace = workspaces.core;
  await removeDist(workspace);
  await runNode(resolve(repositoryRoot, "scripts/build-semantic-map.mjs"), [], workspace);
  await runPackageTool(workspace, "typescript", "bin/tsc", ["-p", "tsconfig.json"]);
  await cp(resolve(workspace, "starter/roles"), resolve(workspace, "dist/starter/roles"), { recursive: true });
  await cp(resolve(workspace, "trajectory/src/assets"), resolve(workspace, "dist/trajectory/src/assets"), { recursive: true });
  await cp(resolve(workspace, "trajectory/src/assets"), resolve(workspace, "dist/trajectory/assets"), { recursive: true });
  // Use the declared esbuild JavaScript API: on non-Windows installs bin/esbuild may be the native executable, not JS.
  const esbuild = createRequire(resolve(workspace, "package.json"))("esbuild");
  const common = { bundle: true, format: "esm", platform: "node", sourcemap: true, sourcesContent: false, absWorkingDir: workspace, logLevel: "warning" };
  await esbuild.build({ ...common, entryPoints: ["src/index.ts", "starter/index.ts", "subagents/index.ts", "trajectory/index.ts"], packages: "external", outbase: ".", outdir: "dist" });
  await esbuild.build({ ...common, entryPoints: ["trajectory/src/server.ts"], outfile: "dist/trajectory/src/server.js" });
}

async function buildCli() {
  const workspace = workspaces.cli;
  await buildCore();
  await removeDist(workspace);
  await runPackageTool(workspace, "typescript", "bin/tsc", ["-p", "tsconfig.json"]);
  // Keep executable bits in tarballs on POSIX; Windows npm shims use the bin manifest.
  for (const file of ["dist/src/cli.js", "dist/src/pi-role.js"]) await chmod(resolve(workspace, file), 0o755);
}

async function buildHerdr() {
  const workspace = workspaces.herdr;
  await removeDist(workspace);
  await runPackageTool(workspace, "typescript", "bin/tsc", ["-p", "tsconfig.json"]);
}

const target = process.argv[2];
if (!Object.hasOwn(workspaces, target)) {
  process.stderr.write("Usage: node scripts/workspace-build.mjs <core|cli|herdr>\n");
  process.exitCode = 2;
} else {
  try {
    if (target === "core") await buildCore();
    else if (target === "cli") await buildCli();
    else await buildHerdr();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
