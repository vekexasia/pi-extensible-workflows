import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "acorn";

// Portable on Windows and POSIX: every Node entrypoint runs on process.execPath, npm runs through npm_execpath,
// PATH uses path.delimiter, and tar only ever sees relative paths (GNU tar would read "C:" as a remote host).
// External tools required beyond Node/npm: `tar` (bsdtar ships with Windows 10+), plus cmd.exe/PowerShell on
// Windows or /bin/sh on POSIX for the public npm wrapper smokes. Registry, network and audit errors fail visibly.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const isWindows = process.platform === "win32";
const work = mkdtempSync(resolve(tmpdir(), "piewf-packages-"));
const output = process.argv[2] ? resolve(process.argv[2]) : resolve(work, "tarballs");
const agentRoot = resolve(work, "agent");
const installRoot = resolve(agentRoot, "npm");
const home = resolve(work, "home");
const workspaces = ["packages/core", "packages/cli", "packages/extensions/herdr"];
const changelogStaged = [resolve(root, "packages/core/CHANGELOG.md"), resolve(root, ".tmp/core-changelog-staged")];
// A freshly installed tree is cold (first import may be scanned file by file on Windows), so smokes get a generous bound.
const smokeTimeout = 180_000;
const herdrVariables = new Set(["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID"]);

function json(path) { return JSON.parse(readFileSync(path, "utf8")); }
function sha(algorithm, bytes, encoding = "hex") { return createHash(algorithm).update(bytes).digest(encoding); }
function runNpm(args, options) {
  const npmExecPath = process.env.npm_execpath;
  if (!npmExecPath || !existsSync(npmExecPath)) throw new Error("npm_execpath is unavailable; invoke this verifier with npm run test:packages.");
  const result = spawnSync(process.execPath, [npmExecPath, ...args], { encoding: "utf8", stdio: "pipe", ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`npm ${args[0]} failed (${String(result.status)}):\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result;
}
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
function treeDigests(directory) {
  return new Map(files(directory).map((path) => [relative(directory, path).replaceAll("\\", "/"), sha("sha256", readFileSync(path))]));
}
/** Every installed copy of a package name anywhere below node_modules, so a second (registry) copy cannot hide. */
function installedCopies(base, name, found = []) {
  const modules = resolve(base, "node_modules");
  if (!existsSync(modules)) return found;
  for (const entry of readdirSync(modules, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    const scoped = entry.name.startsWith("@") ? readdirSync(resolve(modules, entry.name), { withFileTypes: true }).filter((child) => child.isDirectory()).map((child) => resolve(modules, entry.name, child.name)) : [resolve(modules, entry.name)];
    for (const directory of scoped) {
      const manifestPath = resolve(directory, "package.json");
      if (existsSync(manifestPath) && json(manifestPath).name === name) found.push(directory);
      installedCopies(directory, name, found);
    }
  }
  return found;
}
/** Node resolution of a dependency from one installed package directory. */
function resolveInstalled(fromDirectory, name) {
  for (let directory = fromDirectory; ; directory = dirname(directory)) {
    const candidate = packagePath(directory, name);
    if (existsSync(resolve(candidate, "package.json"))) return candidate;
    if (dirname(directory) === directory) return undefined;
  }
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
/** Copies an environment and replaces PATH under whatever key casing it already has (Windows keeps one of "Path"/"PATH"). */
function withPath(env, directories) {
  const keys = Object.keys(env).filter((key) => key.toUpperCase() === "PATH");
  const current = keys.map((key) => env[key]).find((value) => typeof value === "string") ?? "";
  const next = Object.fromEntries(Object.entries(env).filter(([key]) => !keys.includes(key)));
  next[keys[0] ?? "PATH"] = [...directories, current].filter(Boolean).join(delimiter);
  return next;
}
/** Isolated profile for every consumer command: no personal home, app data or Pi agent directory, no Herdr pane. */
const consumerEnv = withPath({
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !herdrVariables.has(name))),
  HOME: home, USERPROFILE: home, APPDATA: resolve(home, "AppData", "Roaming"), LOCALAPPDATA: resolve(home, "AppData", "Local"),
  PI_CODING_AGENT_DIR: agentRoot, PI_OFFLINE: "1"
}, [dirname(process.execPath)]);
function checked(label, result, expect) {
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0 || !expect(text, result)) throw new Error(`${label} failed (${String(result.status)}):\n${text}`);
  return text;
}
/** Runs a public npm bin wrapper the way a user's shell would: cmd.exe and PowerShell on Windows, /bin/sh elsewhere. */
function publicWrappers(bin, args, env) {
  const binDirectory = resolve(installRoot, "node_modules", ".bin");
  const options = { cwd: work, encoding: "utf8", env, timeout: smokeTimeout };
  if (!isWindows) return [["sh", spawnSync("/bin/sh", ["-c", `"$0" "$@"`, resolve(binDirectory, bin), ...args], options)]];
  const quote = (value) => { if (/["%!^&|<>\r\n]/.test(value)) throw new Error(`cmd.exe smoke argument is not literal: ${value}`); return `"${value}"`; };
  const comspec = process.env.ComSpec ?? resolve(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  const line = [quote(resolve(binDirectory, `${bin}.cmd`)), ...args.map(quote)].join(" ");
  return [
    ["cmd", spawnSync(comspec, ["/d", "/s", "/c", `"${line}"`], { ...options, windowsVerbatimArguments: true })],
    ["powershell", spawnSync("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", resolve(binDirectory, `${bin}.ps1`), ...args], options)]
  ];
}

let exitCode = 0;
try {
  mkdirSync(output, { recursive: true });
  mkdirSync(resolve(home, "AppData", "Roaming"), { recursive: true });
  mkdirSync(resolve(home, "AppData", "Local"), { recursive: true });
  // The core prepack stages the root changelog and postpack removes it; refuse to start over foreign or leftover files.
  const preexisting = changelogStaged.filter((path) => existsSync(path));
  if (preexisting.length) throw new Error(`Core changelog staging is not clean before packing: ${preexisting.join(", ")}`);
  const packages = workspaces.map((workspace) => ({ workspace, manifest: json(resolve(root, workspace, "package.json")) }));
  for (const { workspace } of packages) runNpm(["pack", `--workspace=${workspace}`, "--pack-destination", output], { cwd: root, timeout: 600_000 });
  const leftover = changelogStaged.filter((path) => existsSync(path));
  if (leftover.length) throw new Error(`Core postpack did not clean its staged changelog: ${leftover.join(", ")}`);

  const errors = [];
  const checksums = [];
  const extractedTrees = new Map();
  for (const { workspace, manifest } of packages) {
    const tarball = resolve(output, tarballName(manifest));
    const bytes = readFileSync(tarball);
    checksums.push({ file: basename(tarball), bytes: bytes.byteLength, sha256: sha("sha256", bytes), integrity: `sha512-${sha("sha512", bytes, "base64")}` });
    const slug = manifest.name.replace(/^@/, "").replaceAll("/", "-");
    const extracted = resolve(work, "extracted", slug);
    mkdirSync(extracted, { recursive: true });
    copyFileSync(tarball, resolve(work, "extracted", `${slug}.tgz`));
    execFileSync("tar", ["-xzf", `../${slug}.tgz`, "--strip-components=1"], { cwd: extracted, stdio: "pipe", timeout: 60_000 });
    extractedTrees.set(manifest.name, treeDigests(extracted));
    const packed = json(resolve(extracted, "package.json"));
    for (const field of ["name", "version", "dependencies", "peerDependencies", "engines"]) if (JSON.stringify(packed[field]) !== JSON.stringify(manifest[field])) errors.push(`${manifest.name}: packed ${field} differs from ${workspace}/package.json`);
    const packedFiles = files(extracted);
    const relativeFiles = packedFiles.map((path) => relative(extracted, path).replaceAll("\\", "/"));
    const entrypoints = [packed.main, ...strings(packed.bin), ...strings(packed.exports), ...strings(packed.pi?.extensions)].filter((path) => typeof path === "string" && path.startsWith("./"));
    for (const entrypoint of entrypoints) if (!existsSync(resolve(extracted, entrypoint))) errors.push(`${manifest.name}: missing entrypoint ${entrypoint}`);
    for (const file of packedFiles.filter((path) => path.startsWith(resolve(extracted, "dist")) && (filePathHasTestDirectory(path.slice(extracted.length + 1)) || path.includes(".test.")))) errors.push(`${manifest.name}: published test artifact ${file.slice(extracted.length + 1)}`);
    for (const file of packedFiles.filter((path) => path.endsWith(".js"))) {
      const source = readFileSync(file, "utf8");
      for (const specifier of relativeImports(source)) if (!existsSync(resolve(dirname(file), specifier))) errors.push(`${manifest.name}: ${file.slice(extracted.length + 1)} imports missing ${specifier}`);
      const sourceMap = /\/\/# sourceMappingURL=(\S+)\s*$/.exec(source)?.[1];
      if (sourceMap && !sourceMap.startsWith("data:") && !existsSync(resolve(dirname(file), sourceMap))) errors.push(`${manifest.name}: ${file.slice(extracted.length + 1)} references missing source map ${sourceMap}`);
    }
    if (manifest.name === "pi-extensible-workflows") {
      const semanticAssets = relativeFiles.filter((path) => /^.*\/semantic-map\.(html|js|css)$/.test(path)).sort();
      const expectedAssets = ["dist/trajectory/assets/semantic-map.css", "dist/trajectory/assets/semantic-map.html", "dist/trajectory/assets/semantic-map.js"];
      if (JSON.stringify(semanticAssets) !== JSON.stringify(expectedAssets)) errors.push(`${manifest.name}: expected one canonical copy of each Semantic Map browser asset, found ${JSON.stringify(semanticAssets)}`);
      if (!relativeFiles.includes("trajectory/vendor/archify/LICENSE")) errors.push(`${manifest.name}: missing Archify and embedded-font license notices`);
      for (const forbidden of ["trajectory/vendor/archify/template.html", "trajectory/test/fixtures/semantic-map-feasibility/archify-template.html"]) if (relativeFiles.includes(forbidden)) errors.push(`${manifest.name}: packaged pinned vendor input ${forbidden}`);
      if (relativeFiles.some((path) => path.includes("semantic-map-feasibility"))) errors.push(`${manifest.name}: packaged Semantic Map test fixture`);
      if (!relativeFiles.includes("CHANGELOG.md") || !readFileSync(resolve(extracted, "CHANGELOG.md")).equals(readFileSync(resolve(root, "CHANGELOG.md")))) errors.push(`${manifest.name}: packed CHANGELOG.md is missing or differs from the root changelog staged by prepack`);
    }
  }
  if (errors.length) throw new Error(errors.join("\n"));
  writeFileSync(resolve(output, "SHA256SUMS"), checksums.map(({ file, sha256 }) => `${sha256}  ${file}`).join("\n") + "\n");
  writeFileSync(resolve(output, "checksums.json"), `${JSON.stringify(checksums, null, 2)}\n`);
  for (const { file, bytes, sha256 } of checksums) process.stdout.write(`Tarball ${file}: ${String(bytes)} B sha256 ${sha256}\n`);

  // Install the three tarballs together, with install scripts enabled as a real consumer would run them.
  const tarballs = packages.map(({ manifest }) => resolve(output, tarballName(manifest)));
  runNpm(["install", "--prefix", installRoot, "--omit=dev", "--legacy-peer-deps", "--no-fund", ...tarballs], { cwd: work, env: consumerEnv, timeout: 600_000 });
  const lock = json(resolve(installRoot, "package-lock.json"));
  for (const { manifest } of packages) {
    const copies = installedCopies(installRoot, manifest.name);
    if (copies.length !== 1 || copies[0] !== packagePath(installRoot, manifest.name)) errors.push(`${manifest.name}: expected exactly one top-level installed copy, found ${JSON.stringify(copies.map((copy) => relative(installRoot, copy)))}`);
    const entry = lock.packages?.[`node_modules/${manifest.name}`];
    const checksum = checksums.find(({ file }) => file === tarballName(manifest));
    if (typeof entry?.resolved !== "string" || !entry.resolved.startsWith("file:") || (entry.integrity !== undefined && entry.integrity !== checksum?.integrity)) errors.push(`${manifest.name}: installed from ${JSON.stringify(entry?.resolved)} instead of the candidate tarball`);
    const installed = treeDigests(packagePath(installRoot, manifest.name));
    for (const [file, digest] of extractedTrees.get(manifest.name) ?? []) if (installed.get(file) !== digest) errors.push(`${manifest.name}: installed ${file} differs from the candidate tarball`);
    for (const [name, range] of Object.entries(manifest.dependencies ?? {})) {
      const dependency = resolveInstalled(packagePath(installRoot, manifest.name), name);
      if (!dependency) errors.push(`${manifest.name}: declared dependency ${name} is not installed`);
      else if (/^\d+\.\d+\.\d+$/.test(range) && json(resolve(dependency, "package.json")).version !== range) errors.push(`${manifest.name}: ${name} resolved to ${String(json(resolve(dependency, "package.json")).version)}, expected exactly ${range}`);
    }
  }
  if (resolveInstalled(packagePath(installRoot, "@piewf/cli"), "pi-extensible-workflows") !== packagePath(installRoot, "pi-extensible-workflows")) errors.push("@piewf/cli does not resolve the candidate pi-extensible-workflows");
  if (errors.length) throw new Error(errors.join("\n"));
  process.stdout.write(`Installed consumer: ${String(packages.length)} candidate packages, one copy each, byte-identical to their tarballs; @piewf/cli resolves the candidate core.\n`);

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
  process.stdout.write(checked("Installed Semantic Map consumer", spawnSync(process.execPath, [semanticConsumer, corePackage], { cwd: work, encoding: "utf8", env: consumerEnv, timeout: smokeTimeout }), (text) => text.includes("Installed Semantic Map consumer passed")));
  const restored = treeDigests(corePackage);
  for (const [file, digest] of extractedTrees.get("pi-extensible-workflows") ?? []) if (restored.get(file) !== digest) throw new Error(`Installed ${file} was not restored after the A/B probe`);

  // Programmatic smokes resolve the published JS entrypoints; public smokes go through npm's generated wrappers.
  const cliPackage = packagePath(installRoot, "@piewf/cli");
  const cliBin = json(resolve(cliPackage, "package.json")).bin;
  const node = (entrypoint, args, env = consumerEnv) => spawnSync(process.execPath, [resolve(cliPackage, entrypoint), ...args], { cwd: work, encoding: "utf8", env, timeout: smokeTimeout });
  checked("piewf run --help (JS entrypoint)", node(cliBin.piewf, ["run", "--help"]), (text) => text.includes("Usage: piewf run"));
  checked("pi-role --help (JS entrypoint)", node(cliBin["pi-role"], ["--help"]), (text) => text.includes("Usage: pi-role <role>") && text.includes("developer"));
  let wrappers = 0;
  for (const [shell, result] of publicWrappers("piewf", ["run", "--help"], consumerEnv)) { checked(`piewf run --help (${shell} wrapper)`, result, (text) => text.includes("Usage: piewf run")); wrappers += 1; }
  for (const [shell, result] of publicWrappers("pi-role", ["--help"], consumerEnv)) { checked(`pi-role --help (${shell} wrapper)`, result, (text) => text.includes("Usage: pi-role <role>") && text.includes("developer")); wrappers += 1; }

  // A stand-in `pi` that prints its argv as JSON proves pi-role passes arguments literally, without calling a model.
  const fakeBin = resolve(work, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  const fakePi = "#!/usr/bin/env node\nprocess.stdout.write(\"PI_ARGV=\" + JSON.stringify(process.argv.slice(2)) + \"\\n\");\n";
  if (isWindows) {
    writeFileSync(resolve(fakeBin, "fake-pi.mjs"), fakePi);
    // npm cmd-shim layout, so the launcher runs the script on Node with literal argv instead of through cmd.exe.
    writeFileSync(resolve(fakeBin, "pi.cmd"), "@ECHO off\r\nSETLOCAL\r\nSET dp0=%~dp0\r\nnode \"%dp0%\\fake-pi.mjs\" %*\r\n");
  } else writeFileSync(resolve(fakeBin, "pi"), fakePi, { mode: 0o755 });
  const launchEnv = withPath(consumerEnv, [fakeBin]);
  const literal = "hello \"quoted\" & | %PATH% $HOME ^ (x) 'y' \u00fc";
  const launchArguments = (text) => { const line = text.split(/\r?\n/).find((entry) => entry.startsWith("PI_ARGV=")); return line ? JSON.parse(line.slice("PI_ARGV=".length)) : []; };
  const launched = (expectedPrompt) => (text) => { const args = launchArguments(text); return !args.includes("--model") && args.includes("--append-system-prompt") && JSON.stringify(args.slice(-2)) === JSON.stringify(["-p", expectedPrompt]) && text.includes("developer-model"); };
  checked("pi-role developer launch (JS entrypoint, literal argv)", node(cliBin["pi-role"], ["developer", "-p", literal], launchEnv), launched(literal));
  for (const [shell, result] of publicWrappers("pi-role", ["developer", "-p", "hello world"], launchEnv)) { checked(`pi-role developer launch (${shell} wrapper)`, result, launched("hello world")); wrappers += 1; }

  // Pi >=1.0.1 fixes its shrinkwrapped brace-expansion dependency; no per-advisory exception is needed.
  // Report failures after the remaining smokes, so every later consumer check is still reached.
  let auditFailure;
  try {
    const audit = runNpm(["audit", "--prefix", installRoot, "--omit=dev"], { cwd: work, env: consumerEnv, timeout: 300_000 });
    process.stdout.write(`npm audit: ${(audit.stdout ?? "").trim().split(/\r?\n/).at(-1) ?? ""}\n`);
  } catch (error) {
    auditFailure = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${auditFailure}\n`);
  }

  // Pi discovery in the isolated agent directory, using the Pi installed as the CLI's own declared dependency.
  const localPackages = ["pi-extensible-workflows", "@piewf/herdr"].map((name) => packagePath(installRoot, name));
  const extensionCount = localPackages.reduce((count, directory) => count + strings(json(resolve(directory, "package.json")).pi?.extensions).length, 0);
  const piPackage = resolveInstalled(cliPackage, "@earendil-works/pi-coding-agent");
  if (!piPackage) throw new Error("@earendil-works/pi-coding-agent is not installed for @piewf/cli");
  const piEntrypoint = resolve(piPackage, strings(json(resolve(piPackage, "package.json")).bin)[0] ?? "");
  const pi = (args, input) => spawnSync(process.execPath, [piEntrypoint, ...args], { cwd: work, encoding: "utf8", env: consumerEnv, input, timeout: smokeTimeout });
  for (const directory of localPackages) checked(`pi install ${basename(directory)}`, pi(["install", directory]), () => true);
  checked("pi list", pi(["list"]), (text) => localPackages.every((directory) => text.includes(basename(directory))));
  checked("Pi package discovery", pi(["--mode", "rpc"], ""), (text) => !/Failed to load extension|Cannot find module/.test(text));

  process.stdout.write(`Consumer smokes passed: ${String(packages.length)} tarballs, ${String(localPackages.length)} local Pi packages, ${String(extensionCount)} discovered extensions and ${String(wrappers)} public wrapper smokes.\n`);
  if (auditFailure !== undefined) throw new Error("Package verification failed: npm audit reported vulnerabilities in the installed consumer (output above).");
  process.stdout.write("Package verification passed.\n");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (existsSync(work)) { process.stderr.write(`Could not remove verifier work directory ${work}\n`); exitCode = 1; }
}
process.exitCode = exitCode;
