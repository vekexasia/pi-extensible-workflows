import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir, stat } from "node:fs/promises";
import test from "node:test";
import { SEMANTIC_MAP_ASSET_MANIFEST, SEMANTIC_MAP_BUILD_STAMP } from "../src/semantic-map-assets.js";

void test("Semantic Map build publishes three stamped assets at one canonical package location", async () => {
  assert.match(SEMANTIC_MAP_BUILD_STAMP, /^[0-9a-f]{16}$/);
  const names = ["semantic-map.html", "semantic-map.js", "semantic-map.css"] as const;
  const canonicalDirectory = new URL("../assets/", import.meta.url);
  const serverDirectory = new URL("../src/assets/", import.meta.url);
  const manifest = JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")) as { files?: string[] };
  for (const name of names) {
    const asset = new URL(name, canonicalDirectory);
    const info = await stat(asset);
    assert.ok(info.isFile() && info.size > 0, `${name} is generated into the canonical dist/trajectory/assets package location`);
    assert.deepEqual(await readFile(new URL(name, serverDirectory)), await readFile(asset), `${name} remains available in the source-compatible dist asset tree`);
    assert.ok(manifest.files?.includes(`!dist/trajectory/src/assets/${name}`));
    assert.ok(manifest.files?.includes(`!trajectory/src/assets/${name}`));
  }
  assert.ok(manifest.files?.includes("!trajectory/src/semantic-map.css"), "the authored stylesheet is build input, not a second distributed browser stylesheet");
  const [html, js, css, canonicalNames] = await Promise.all([
    readFile(new URL("semantic-map.html", canonicalDirectory), "utf8"),
    readFile(new URL("semantic-map.js", canonicalDirectory), "utf8"),
    readFile(new URL("semantic-map.css", canonicalDirectory), "utf8"),
    readdir(canonicalDirectory)
  ]);
  assert.ok(html.includes(`<meta name="semantic-map-build" content="${SEMANTIC_MAP_BUILD_STAMP}">`));
  assert.ok(html.includes(`<meta name="semantic-map-style" content="/semantic-map.css?v=${SEMANTIC_MAP_BUILD_STAMP}">`) && html.includes(`<meta name="semantic-map-script" content="/semantic-map.js?v=${SEMANTIC_MAP_BUILD_STAMP}">`), "viewer asset metadata carries the build version");
  assert.ok(js.includes(`build ${SEMANTIC_MAP_BUILD_STAMP}`));
  assert.ok(css.includes(`Semantic Map ${SEMANTIC_MAP_BUILD_STAMP}`));
  assert.deepEqual(canonicalNames.filter((name) => name.startsWith("semantic-map.")).sort(), [...names].sort());
  assert.ok(Buffer.byteLength(html) + Buffer.byteLength(js) + Buffer.byteLength(css) < 1_000_000);
});

void test("Semantic Map starts with an empty session canvas, never the vendor example architecture", async () => {
  const html = await readFile(new URL("../assets/semantic-map.html", import.meta.url), "utf8");
  const start = html.indexOf("<!-- ARCHIFY:SVG_SLOT_START -->");
  const end = html.indexOf("<!-- ARCHIFY:SVG_SLOT_END -->", start);
  assert.ok(start >= 0 && end > start);
  const canvas = html.slice(start, end);
  assert.doesNotMatch(canvas, /CloudFront|AWS Region|Auth Provider|FastAPI|PostgreSQL|Browser\/Mobile/);
  assert.ok(html.includes('data-embed="true"'));
  assert.ok(html.includes('id="semantic-map-loading"'));
  assert.ok(html.includes("<script data-semantic-map-bootstrap>"));
  assert.ok(html.includes('type:"viewer-listening"'));
  assert.doesNotMatch(html, /<script src="\/semantic-map\.js|<link rel="stylesheet" href="\/semantic-map\.css/);
});

void test("Semantic Map manifest digests the final parent and browser asset bytes of the loaded build", async () => {
  assert.equal(SEMANTIC_MAP_ASSET_MANIFEST.schema, 1);
  assert.equal(SEMANTIC_MAP_ASSET_MANIFEST.stamp, SEMANTIC_MAP_BUILD_STAMP);
  assert.equal(SEMANTIC_MAP_ASSET_MANIFEST.versionParameter, "v");
  assert.deepEqual(Object.keys(SEMANTIC_MAP_ASSET_MANIFEST.assets).sort(), ["index.html", "semantic-map.css", "semantic-map.html", "semantic-map.js"]);
  assert.ok(Object.isFrozen(SEMANTIC_MAP_ASSET_MANIFEST) && Object.isFrozen(SEMANTIC_MAP_ASSET_MANIFEST.assets));
  for (const directory of [new URL("../assets/", import.meta.url), new URL("../src/assets/", import.meta.url)]) {
    for (const [name, expected] of Object.entries(SEMANTIC_MAP_ASSET_MANIFEST.assets)) {
      const bytes = await readFile(new URL(name, directory));
      assert.equal(bytes.length, expected.bytes, `${name} size matches the manifest`);
      assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256, `${name} bytes match the manifest`);
    }
  }
  const parent = await readFile(new URL("../src/assets/index.html", import.meta.url), "utf8");
  assert.ok(parent.includes(`searchParams.set("v","${SEMANTIC_MAP_BUILD_STAMP}")`), "parent iframe URL carries the same version");
  assert.ok(!parent.includes("semantic-map.html?"), "parent has no unversioned iframe URL");
});
