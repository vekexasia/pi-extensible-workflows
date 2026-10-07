import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(resolve(tmpdir(), "piewf-packages-"));
const output = process.argv[2] ? resolve(process.argv[2]) : resolve(work, "tarballs");
const agentRoot = resolve(work, "packed", "consumer", "agent");
const installRoot = resolve(agentRoot, "npm");
const workspaces = ["packages/core", "packages/cli", "packages/extensions/herdr"];

function json(path) { return JSON.parse(readFileSync(path, "utf8")); }
function packagePath(base, name) { return resolve(base, "node_modules", ...name.split("/")); }
function tarballName({ name, version }) { return `${name.replace(/^@/, "").replaceAll("/", "-")}-${version}.tgz`; }
function files(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const target = resolve(path, entry.name);
    return entry.isDirectory() ? files(target) : [target];
  });
}
function strings(value) {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(strings);
  if (value && typeof value === "object") return Object.values(value).flatMap(strings);
  return [];
}
function filePathHasTestDirectory(path) { return path.split(/[\\/]/).includes("test"); }
function relativeImports(source) {
  const imports = [];
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if ((value.type === "ImportDeclaration" || value.type === "ExportNamedDeclaration" || value.type === "ExportAllDeclaration") && typeof value.source?.value === "string") imports.push(value.source.value);
    if (value.type === "ImportExpression" && typeof value.source?.value === "string") imports.push(value.source.value);
    for (const child of Object.values(value)) {
      if (!child || typeof child !== "object") continue;
      if (Array.isArray(child)) child.forEach(visit);
      else visit(child);
    }
  };
  visit(parse(source, { ecmaVersion: "latest", sourceType: "module" }));
  return imports.filter((specifier) => specifier.startsWith("."));
}

try {
  mkdirSync(output, { recursive: true });
  const packages = workspaces.map((workspace) => ({ workspace, manifest: json(resolve(root, workspace, "package.json")) }));
  for (const { workspace } of packages) execFileSync("npm", ["pack", `--workspace=${workspace}`, "--pack-destination", output], { cwd: root, stdio: "pipe", timeout: 120_000 });

  const errors = [];
  for (const { manifest } of packages) {
    const tarball = resolve(output, tarballName(manifest));
    const extracted = resolve(work, "extracted", manifest.name.replaceAll("/", "-"));
    mkdirSync(extracted, { recursive: true });
    execFileSync("tar", ["-xzf", tarball, "-C", extracted, "--strip-components=1"], { stdio: "pipe", timeout: 30_000 });
    const packed = json(resolve(extracted, "package.json"));
    if (packed.dependencies?.["@piewf/pi-ext-roles"]) errors.push(`${manifest.name}: roles must remain optional`);
    const packedFiles = files(extracted);
    const entrypoints = [packed.main, ...strings(packed.bin), ...strings(packed.exports), ...strings(packed.pi?.extensions)].filter((path) => typeof path === "string" && path.startsWith("./"));
    for (const entrypoint of entrypoints) if (!existsSync(resolve(extracted, entrypoint))) errors.push(`${manifest.name}: missing entrypoint ${entrypoint}`);
    for (const file of packedFiles.filter((path) => path.startsWith(resolve(extracted, "dist")) && (filePathHasTestDirectory(path.slice(extracted.length + 1)) || path.includes(".test.")))) errors.push(`${manifest.name}: published test artifact ${file.slice(extracted.length + 1)}`);
    for (const file of packedFiles.filter((path) => path.endsWith(".js"))) {
      for (const specifier of relativeImports(readFileSync(file, "utf8"))) if (!existsSync(resolve(dirname(file), specifier))) errors.push(`${manifest.name}: ${file.slice(extracted.length + 1)} imports missing ${specifier}`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));

  const tarballs = packages.map(({ manifest }) => resolve(output, tarballName(manifest)));
  execFileSync("npm", ["install", "--prefix", installRoot, "--ignore-scripts", "--omit=dev", "--legacy-peer-deps", ...tarballs], { stdio: "pipe", timeout: 120_000 });
  const cli = spawnSync(resolve(installRoot, "node_modules", ".bin", "piewf"), ["run", "--help"], { cwd: work, encoding: "utf8" });
  const cliOutput = `${cli.stdout ?? ""}${cli.stderr ?? ""}`;
  if (cli.error) throw cli.error;
  if (cli.status !== 0 || !cliOutput.includes("Usage: piewf run")) throw new Error(`Standalone CLI smoke test failed (${String(cli.status)}):\n${cliOutput}`);
  if (existsSync(packagePath(installRoot, "@piewf/pi-ext-roles"))) throw new Error("Workflows installed the optional roles package");
  const smokeEnv = { ...process.env, HOME: work, PI_CODING_AGENT_DIR: resolve(work, "isolated-agent"), PI_OFFLINE: "1" };
  const importSmoke = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import * as root from 'pi-extensible-workflows';
    import * as types from 'pi-extensible-workflows/types';
    import * as validation from 'pi-extensible-workflows/validation';
    for (const name of ['parseRoleMarkdown', 'discoverRoles', 'resolveRole', 'roleNameOf']) assert.equal(name in root, false);
    await assert.rejects(import('pi-extensible-workflows/roles'), error => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
    await assert.rejects(import('@piewf/cli/pi-role'), error => error.code === 'ERR_PACKAGE_PATH_NOT_EXPORTED');
    assert.equal(types.LAUNCH_SNAPSHOT_IDENTITY_VERSION, 6);
    assert.deepEqual(validation.validateAgentOptions({role: 42}), {role: 42});
    const registry = new root.WorkflowRegistry();
    registry.register({version:'1.0.0', headline:'Preparation', agentPreparationHooks:{ generic:{prepare() {}} }});
    assert.equal(registry.agentPreparationHooks().length, 1);
  `], { cwd: installRoot, encoding: "utf8", env: smokeEnv, timeout: 30_000 });
  if (importSmoke.error) throw importSmoke.error;
  if (importSmoke.status !== 0) throw new Error(`Generic API imports failed:\n${importSmoke.stderr}`);
  // ponytail: npm audit has no per-advisory ignore. These brace-expansion advisories come from the
  // npm-shrinkwrap.json of @earendil-works/pi-coding-agent@1.0.0, which pins 5.0.9 (fixed in 5.0.12)
  // and cannot be overridden by a dependent. Drop them once Pi ships an updated shrinkwrap.
  const ignoredAdvisories = new Set(["https://github.com/advisories/GHSA-q2hr-2g5m-vwhr", "https://github.com/advisories/GHSA-qhr7-859c-m2p7", "https://github.com/advisories/GHSA-6j4f-fj2g-mc7p"]);
  const audit = spawnSync("npm", ["audit", "--prefix", installRoot, "--omit=dev", "--json"], { encoding: "utf8", timeout: 60_000 });
  if (audit.error) throw audit.error;
  const report = JSON.parse(audit.stdout);
  if (report.error) throw new Error(`npm audit failed: ${JSON.stringify(report.error)}`);
  // Every vulnerable package traces back to an advisory object in some `via` list; string entries name other vulnerable packages.
  const advisories = Object.values(report.vulnerabilities ?? {}).flatMap(({ via }) => via.filter((entry) => typeof entry === "object"));
  const reported = advisories.filter(({ url }) => !ignoredAdvisories.has(url));
  if (reported.length) throw new Error(`npm audit found vulnerabilities:\n${[...new Set(reported.map(({ name, severity, url }) => `${name} (${severity}): ${url}`))].join("\n")}`);

  const localPackages = ["pi-extensible-workflows", "@piewf/herdr"].map((name) => packagePath(installRoot, name));
  const extensionCount = localPackages.reduce((count, directory) => count + strings(json(resolve(directory, "package.json")).pi?.extensions).length, 0);
  const pi = resolve(root, "node_modules/.bin/pi");
  const herdrVariables = new Set(["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]);
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !herdrVariables.has(name))), PI_CODING_AGENT_DIR: agentRoot, PI_OFFLINE: "1" };
  for (const directory of localPackages) {
    const installation = spawnSync(pi, ["install", directory], { cwd: work, encoding: "utf8", env, timeout: 30_000 });
    if (installation.error) throw installation.error;
    if (installation.status !== 0) throw new Error(`Pi local package installation failed (${String(installation.status)}):\n${installation.stdout ?? ""}${installation.stderr ?? ""}`);
  }
  const result = spawnSync(pi, ["--mode", "rpc"], { cwd: work, encoding: "utf8", env, input: "", timeout: 30_000 });
  const outputText = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0 || /Failed to load extension|Cannot find module/.test(outputText)) throw new Error(`Pi package discovery smoke test failed (${String(result.status)}):\n${outputText}`);

  process.stdout.write(`Package verification passed: ${packages.length} tarballs, ${localPackages.length} local Pi packages, and ${extensionCount} discovered extensions.\n`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
