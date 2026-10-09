import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
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
    const relativeFiles = packedFiles.map((path) => path.slice(extracted.length + 1));
    const entrypoints = [packed.main, ...strings(packed.bin), ...strings(packed.exports), ...strings(packed.pi?.extensions)].filter((path) => typeof path === "string" && path.startsWith("./"));
    for (const entrypoint of entrypoints) if (!existsSync(resolve(extracted, entrypoint))) errors.push(`${manifest.name}: missing entrypoint ${entrypoint}`);
    for (const file of packedFiles.filter((path) => path.startsWith(resolve(extracted, "dist")) && (filePathHasTestDirectory(path.slice(extracted.length + 1)) || path.includes(".test.")))) errors.push(`${manifest.name}: published test artifact ${file.slice(extracted.length + 1)}`);
    for (const file of packedFiles.filter((path) => path.endsWith(".js"))) {
      for (const specifier of relativeImports(readFileSync(file, "utf8"))) if (!existsSync(resolve(dirname(file), specifier))) errors.push(`${manifest.name}: ${file.slice(extracted.length + 1)} imports missing ${specifier}`);
    }
    if (manifest.name === "pi-extensible-workflows") {
      const semanticAssets = relativeFiles.filter((path) => /^.*\/semantic-map\.(html|js|css)$/.test(path)).sort();
      const expectedAssets = ["dist/trajectory/assets/semantic-map.css", "dist/trajectory/assets/semantic-map.html", "dist/trajectory/assets/semantic-map.js"];
      if (JSON.stringify(semanticAssets) !== JSON.stringify(expectedAssets)) errors.push(`${manifest.name}: expected one canonical copy of each Semantic Map browser asset, found ${JSON.stringify(semanticAssets)}`);
      if (!relativeFiles.includes("trajectory/vendor/archify/LICENSE")) errors.push(`${manifest.name}: missing Archify and embedded-font license notices`);
      for (const forbidden of ["trajectory/vendor/archify/template.html", "trajectory/test/fixtures/semantic-map-feasibility/archify-template.html"]) if (relativeFiles.includes(forbidden)) errors.push(`${manifest.name}: packaged pinned vendor input ${forbidden}`);
      if (relativeFiles.some((path) => path.includes("semantic-map-feasibility"))) errors.push(`${manifest.name}: packaged Semantic Map test fixture`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));

  const tarballs = packages.map(({ manifest }) => resolve(output, tarballName(manifest)));
  execFileSync("npm", ["install", "--prefix", installRoot, "--ignore-scripts", "--omit=dev", "--legacy-peer-deps", ...tarballs], { stdio: "pipe", timeout: 120_000 });
  const semanticConsumer = resolve(work, "semantic-map-installed-consumer.mjs");
  writeFileSync(semanticConsumer, [
    'import assert from "node:assert/strict";',
    'import { createHash } from "node:crypto";',
    'import { createServer } from "node:http";',
    'import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";',
    'import { tmpdir } from "node:os";',
    'import { join, resolve } from "node:path";',
    'import { pathToFileURL } from "node:url";',
    'const packageRoot = resolve(process.argv[2]);',
    'const assetsRoot = resolve(packageRoot, "dist/trajectory/assets");',
    'const parentShell = resolve(packageRoot, "dist/trajectory/src/assets/index.html");',
    'const { createTrajectoryServer } = await import(pathToFileURL(resolve(packageRoot, "dist/trajectory/src/server.js")).href);',
    'const { SEMANTIC_MAP_ASSET_MANIFEST: manifest } = await import(pathToFileURL(resolve(packageRoot, "dist/trajectory/src/semantic-map-assets.js")).href);',
    'const stamp = manifest.stamp;',
    'assert.match(stamp, /^[0-9a-f]{16}$/);',
    'const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");',
    'const expected = new Map([["/semantic-map.html", ["text/html; charset=utf-8", "semantic-map.html"]], ["/semantic-map.js", ["application/javascript; charset=utf-8", "semantic-map.js"]], ["/semantic-map.css", ["text/css; charset=utf-8", "semantic-map.css"]]]);',
    'for (const [, [, filename]] of expected) { const bytes = readFileSync(resolve(assetsRoot, filename)); assert.equal(bytes.byteLength, manifest.assets[filename].bytes, filename); assert.equal(digest(bytes), manifest.assets[filename].sha256, filename); }',
    'assert.equal(digest(readFileSync(parentShell)), manifest.assets["index.html"].sha256, "installed parent shell matches the manifest");',
    'const root = mkdtempSync(join(tmpdir(), "piewf-installed-semantic-map-"));',
    'const probe = createServer();',
    'await new Promise((resolve, reject) => { probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve); });',
    'const address = probe.address(); assert.ok(address && typeof address !== "string");',
    'await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));',
    'const port = address.port;',
    'const server = createTrajectoryServer(port, join(root, "trajectory.lock"), { fingerprint: "installed-semantic-map-consumer" });',
    'await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });',
    'const base = "http://127.0.0.1:" + String(port);',
    'const noStore = (response, label) => { assert.equal(response.headers.get("cache-control"), "no-store", label); assert.equal(response.headers.get("x-content-type-options"), "nosniff", label); };',
    'const restores = [];',
    'let rawBytes = 0; let rejected = 0; let incoherent = 0;',
    'try {',
    '  const parent = await fetch(base + "/");',
    '  assert.equal(parent.status, 200);',
    '  noStore(parent, "/");',
    '  assert.match(parent.headers.get("content-security-policy") || "", /frame-src \'self\'/);',
    '  assert.ok((await parent.text()).includes(stamp), "parent shell requests the viewer build it was built with");',
    '  for (const [route, [mime, filename]] of expected) {',
    '    const response = await fetch(base + route + "?v=" + stamp + (route.endsWith(".html") ? "&embed=1" : ""));',
    '    assert.equal(response.status, 200, route);',
    '    assert.equal(response.headers.get("content-type"), mime, route);',
    '    noStore(response, route);',
    '    assert.equal(response.headers.get("referrer-policy"), "no-referrer", route);',
    '    const actual = Buffer.from(await response.arrayBuffer());',
    '    const packaged = readFileSync(resolve(assetsRoot, filename));',
    '    assert.deepEqual(actual, packaged, route + " is served from the installed canonical package asset");',
    '    assert.equal(Number(response.headers.get("content-length")), packaged.byteLength, route);',
    '    rawBytes += actual.byteLength;',
    '    if (route.endsWith(".html")) {',
    '      const html = actual.toString("utf8");',
    '      assert.ok(html.includes("semantic-map.js?v=" + stamp) && html.includes("semantic-map.css?v=" + stamp), "viewer requests its own build");',
    '      assert.match(response.headers.get("content-security-policy") || "", /connect-src \'none\'/);',
    '    }',
    '    for (const query of ["", "?v=", "?v=0000000000000000", "?v=" + stamp + "&v=" + stamp, "?v=" + stamp.toUpperCase(), "?build=ignored"].filter((query) => query !== "?v=" + stamp)) {',
    '      const stale = await fetch(base + route + query);',
    '      assert.equal(stale.status, 404, route + query);',
    '      noStore(stale, route + query);',
    '      rejected += 1;',
    '    }',
    '  }',
    '  // In-place replacement of the installed files beside the running server fails closed, then recovers when restored.',
    '  const replace = (path, bytes) => { const original = readFileSync(path); restores.push(() => writeFileSync(path, original)); writeFileSync(path, bytes); return original; };',
    '  const css = resolve(assetsRoot, "semantic-map.css");',
    '  const cssBytes = replace(css, readFileSync(css).subarray(0, 64));',
    '  for (const route of expected.keys()) { const response = await fetch(base + route + "?v=" + stamp); assert.equal(response.status, 503, "truncated css: " + route); noStore(response, route); incoherent += 1; }',
    '  writeFileSync(css, Buffer.from(cssBytes.toString("utf8").replace(/[a-z]/, "Z")));',
    '  assert.equal((await fetch(base + "/semantic-map.css?v=" + stamp)).status, 503, "same-size replacement"); incoherent += 1;',
    '  restores.pop()();',
    '  assert.equal((await fetch(base + "/semantic-map.css?v=" + stamp)).status, 200, "restored css");',
    '  replace(parentShell, Buffer.concat([readFileSync(parentShell), Buffer.from("<!-- B -->")]));',
    '  const parentB = await fetch(base + "/"); assert.equal(parentB.status, 503, "parent B"); noStore(parentB, "parent B"); incoherent += 1;',
    '  restores.pop()();',
    '  assert.equal((await fetch(base + "/")).status, 200, "restored parent");',
    '  assert.equal((await fetch(base + "/semantic-map.json")).status, 404);',
    '  assert.equal((await fetch(base + "/semantic-map.js?v=" + stamp, { method: "POST" })).status, 404);',
    '  assert.equal((await fetch(base + "/semantic-map.js?v=" + stamp, { headers: { origin: "http://evil.test" } })).status, 403);',
    '  process.stdout.write("Installed Semantic Map consumer passed: stamp=" + stamp + ", routes=3, rawBytes=" + String(rawBytes) + ", rejectedVersions=" + String(rejected) + ", incoherent503=" + String(incoherent) + ".\\n");',
    '} finally {',
    '  for (const restore of restores.reverse()) restore();',
    '  server.closeAllConnections(); server.closeIdleConnections();',
    '  await new Promise((resolve) => server.close(() => resolve()));',
    '  rmSync(root, { recursive: true, force: true });',
    '}'
  ].join("\n"));
  const corePackage = packagePath(installRoot, "pi-extensible-workflows");
  const semanticResult = spawnSync(process.execPath, [semanticConsumer, corePackage], { cwd: work, encoding: "utf8", env: { ...process.env, PI_OFFLINE: "1" }, timeout: 30_000 });
  if (semanticResult.error) throw semanticResult.error;
  if (semanticResult.status !== 0) throw new Error(`Installed Semantic Map consumer failed:\n${semanticResult.stderr}`);
  process.stdout.write(semanticResult.stdout);

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
