import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const generator = join(repositoryRoot, "scripts/build-semantic-map.mjs");
const inputs = [
  "scripts/build-semantic-map.mjs",
  "packages/core/tsconfig.json",
  "packages/core/trajectory/src/semantic-map-build.ts",
  "packages/core/trajectory/src/semantic-map.css",
  "packages/core/trajectory/src/semantic-map/adapter.ts",
  "packages/core/trajectory/src/semantic-map/bridge.ts",
  "packages/core/trajectory/src/semantic-map/index.ts",
  "packages/core/trajectory/src/semantic-map/renderer.ts",
  "packages/core/trajectory/src/semantic-map/layout.ts",
  "packages/core/trajectory/src/semantic-map/viewer.ts",
  "packages/core/trajectory/src/assets/index.html",
  "packages/core/trajectory/vendor/archify/template.html",
  "packages/core/trajectory/vendor/archify/patches.json",
  "packages/core/trajectory/vendor/archify/source.json"
];
const assetNames = ["index.html", "semantic-map.html", "semantic-map.js", "semantic-map.css"];
const generatedFiles = [...assetNames.map((name) => `packages/core/trajectory/src/assets/${name}`), "packages/core/trajectory/src/semantic-map-assets.ts"];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

let sandbox;
test.before(async () => { sandbox = await mkdtemp(join(tmpdir(), "semantic-map-build-")); });
test.after(async () => { if (sandbox) await rm(sandbox, { recursive: true, force: true }); });

async function copyInputs(name, transform = (value) => value) {
  const root = join(sandbox, name);
  for (const path of inputs) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), transform(await readFile(join(repositoryRoot, path)), path));
  }
  return root;
}
async function build(root) {
  const { stdout } = await run(process.execPath, [generator, `--root=${root}`], { cwd: root, windowsHide: true, timeout: 60_000 });
  const outputs = Object.fromEntries(await Promise.all(generatedFiles.map(async (path) => [path, await readFile(join(root, path))])));
  const assetsTs = outputs["packages/core/trajectory/src/semantic-map-assets.ts"].toString("utf8");
  const stamp = /export const SEMANTIC_MAP_BUILD_STAMP = "([0-9a-f]{16})";/.exec(assetsTs)?.[1];
  assert.ok(stamp, "generated module exports a 16-hex build stamp");
  assert.ok(stdout.includes(`Semantic Map ${stamp}:`));
  return { stamp, outputs, assetsTs };
}
function assertContract({ stamp, outputs, assetsTs }) {
  const text = (name) => outputs[`packages/core/trajectory/src/assets/${name}`].toString("utf8");
  const html = text("semantic-map.html");
  const parent = text("index.html");
  for (const name of assetNames) {
    const bytes = outputs[`packages/core/trajectory/src/assets/${name}`];
    assert.ok(!bytes.toString("utf8").includes("__SEMANTIC_MAP_BUILD_STAMP__"), `${name} has no unresolved placeholder`);
    assert.ok(!bytes.includes(13), `${name} is emitted with LF line endings`);
    assert.ok(assetsTs.includes(`${JSON.stringify(name)}: Object.freeze({ bytes: ${String(bytes.length)}, sha256: "${sha256(bytes)}" })`), `manifest digests the final ${name} bytes`);
  }
  assert.equal((assetsTs.match(/sha256: "[0-9a-f]{64}"/g) ?? []).length, 4, "manifest covers parent plus exactly three browser assets");
  assert.ok(assetsTs.includes("stamp: SEMANTIC_MAP_BUILD_STAMP") && assetsTs.includes('versionParameter: "v"'));
  const references = [...html.matchAll(/<meta name="semantic-map-(?:style|script)" content="\/semantic-map\.(css|js)\?v=([^"]*)"/g)];
  assert.deepEqual(references.map((match) => match[1]).sort(), ["css", "js"], "viewer HTML references exactly one stylesheet and one script");
  assert.deepEqual([...new Set(references.map((match) => match[2]))], [stamp], "viewer JS/CSS references carry the build stamp");
  assert.ok(!/semantic-map\.(?:css|js)"/.test(html), "no unversioned viewer asset reference remains");
  assert.ok(html.includes(`<meta name="semantic-map-build" content="${stamp}">`));
  assert.ok(parent.includes(`<meta name="semantic-map-build" content="${stamp}">`));
  assert.match(parent, new RegExp(`new URL\\("\\./semantic-map\\.html",location\\.href\\);\\w+\\.searchParams\\.set\\("v","${stamp}"\\)`), "parent iframe URL carries the same version first");
  assert.ok(!parent.includes("semantic-map.html?"), "parent has no unversioned iframe URL");
  assert.ok(text("semantic-map.js").startsWith(`/* Archify `) && text("semantic-map.js").includes(`build ${stamp}; licenses: trajectory/vendor/archify/LICENSE`));
  assert.ok(text("semantic-map.js").includes(`build:"${stamp}"`), "viewer API reports the same build stamp");
  assert.ok(text("semantic-map.css").startsWith(`/* Semantic Map ${stamp} */\n`));
}

void test("Semantic Map build is deterministic, current, and publishes one stamp across parent, HTML, JS and CSS", async () => {
  const root = await copyInputs("repeat");
  const first = await build(root);
  const second = await build(root);
  assert.equal(second.stamp, first.stamp);
  for (const path of generatedFiles) assert.deepEqual(second.outputs[path], first.outputs[path], `${path} is byte-identical across rebuilds`);
  assertContract(first);
  for (const path of generatedFiles) assert.equal(sha256(first.outputs[path]), sha256(await readFile(join(repositoryRoot, path))), `checked-in ${path} matches a fresh offline build`);
  const assetDirectory = await readdir(join(root, "packages/core/trajectory/src/assets"));
  assert.deepEqual(assetDirectory.filter((name) => name.startsWith("semantic-map")).sort(), ["semantic-map.css", "semantic-map.html", "semantic-map.js"], "no fourth browser asset is emitted");
});

void test("CRLF inputs produce the same stamp and bytes as LF inputs", async () => {
  const lf = await build(await copyInputs("lf"));
  const crlf = await build(await copyInputs("crlf", (bytes) => Buffer.from(bytes.toString("utf8").replace(/\r?\n/g, "\r\n"), "utf8")));
  assert.equal(crlf.stamp, lf.stamp);
  for (const path of generatedFiles) assert.deepEqual(crlf.outputs[path], lf.outputs[path], `${path} ignores input line endings`);
});

void test("generated outputs never feed the next stamp", async () => {
  const root = await copyInputs("recursion");
  const clean = await build(root);
  const assets = join(root, "packages/core/trajectory/src/assets");
  for (const name of ["semantic-map.html", "semantic-map.js", "semantic-map.css"]) await writeFile(join(assets, name), "stale generated bytes\n");
  await writeFile(join(root, "packages/core/trajectory/src/semantic-map-assets.ts"), 'export const SEMANTIC_MAP_BUILD_STAMP = "0000000000000000";\n');
  const parent = clean.outputs["packages/core/trajectory/src/assets/index.html"].toString("utf8")
    .replace(`content="${clean.stamp}"`, 'content="0123456789abcdef"')
    .replace(/(<script data-semantic-map-app>\n)[^\n]*(\n)/, "$1stale app bundle$2");
  await writeFile(join(assets, "index.html"), parent);
  const rebuilt = await build(root);
  assert.equal(rebuilt.stamp, clean.stamp);
  for (const path of generatedFiles) assert.deepEqual(rebuilt.outputs[path], clean.outputs[path], `${path} is independent of previous generated output`);
});

void test("a pertinent input change moves the stamp once and stays stable", async () => {
  const baseline = await build(await copyInputs("baseline"));
  const root = await copyInputs("changed", (bytes, path) => path.endsWith("semantic-map.css") ? Buffer.concat([bytes, Buffer.from("\n.semantic-map-t07-probe { color: inherit; }\n")]) : bytes);
  const changed = await build(root);
  assert.notEqual(changed.stamp, baseline.stamp);
  assertContract(changed);
  const again = await build(root);
  assert.equal(again.stamp, changed.stamp);
  for (const path of generatedFiles) assert.deepEqual(again.outputs[path], changed.outputs[path]);
});

void test("pinned Archify provenance is still enforced", async () => {
  const root = await copyInputs("tampered", (bytes, path) => path.endsWith("vendor/archify/template.html") ? Buffer.concat([bytes, Buffer.from("<!-- tampered -->\n")]) : bytes);
  await assert.rejects(run(process.execPath, [generator, `--root=${root}`], { cwd: root, windowsHide: true, timeout: 60_000 }), /Pinned Archify template checksum mismatch/);
});
