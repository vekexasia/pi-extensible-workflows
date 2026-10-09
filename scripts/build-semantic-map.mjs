import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import * as esbuild from "esbuild";

// `--root=<checkout>` builds an isolated copy with the same generator and this checkout's declared esbuild.
const rootArgument = process.argv.slice(2).find((argument) => argument.startsWith("--root="));
const root = rootArgument ? resolve(rootArgument.slice("--root=".length)) : join(dirname(fileURLToPath(import.meta.url)), "..");
const trajectory = join(root, "packages/core/trajectory");
const vendor = join(trajectory, "vendor/archify");
const assets = join(trajectory, "src/assets");
/** Canonical placeholder for the build stamp; every generated reference holds it while the stamp is hashed. */
const STAMP_PLACEHOLDER = "__SEMANTIC_MAP_BUILD_STAMP__";
const normalize = (value) => value.replace(/\r\n/g, "\n");
async function writeIfChanged(path, value) {
  try { if ((await readFile(path, "utf8")) === value) return; } catch { /* New generated output. */ }
  await writeFile(path, value, "utf8");
}
function replaceOnce(value, find, replacement, description) {
  const first = value.indexOf(find);
  if (first < 0 || value.indexOf(find, first + find.length) >= 0) throw new Error(`Expected exactly one ${description}`);
  return value.slice(0, first) + replacement + value.slice(first + find.length);
}
function stampPlaceholders(value, description) {
  if (!value.includes(STAMP_PLACEHOLDER)) throw new Error(`Expected a build stamp placeholder in ${description}`);
  return value.replaceAll(STAMP_PLACEHOLDER, stamp);
}
async function bundle(entry) {
  const result = await esbuild.build({
    entryPoints: [join(trajectory, entry)],
    // Explicit so a copied checkout never picks up a different tsconfig from its parent directories.
    tsconfig: join(root, "packages/core/tsconfig.json"),
    bundle: true, write: false, platform: "browser", format: "iife", target: ["es2022"], minify: true,
    define: { [STAMP_PLACEHOLDER]: JSON.stringify(STAMP_PLACEHOLDER) },
    legalComments: "none", charset: "utf8"
  });
  if (result.outputFiles.length !== 1) throw new Error(`Semantic Map bundler produced an unexpected output count for ${entry}`);
  return normalize(result.outputFiles[0].text).trim();
}

const sourceInfo = JSON.parse(await readFile(join(vendor, "source.json"), "utf8"));
const rawInput = await readFile(join(vendor, "template.html"));
const inputBytes = Buffer.from(normalize(rawInput.toString("utf8")), "utf8");
const inputHash = createHash("sha256").update(inputBytes).digest("hex");
if (inputHash !== sourceInfo.sha256) throw new Error(`Pinned Archify template checksum mismatch: ${inputHash}`);
let viewerHtml = inputBytes.toString("utf8");
const patches = JSON.parse(normalize(await readFile(join(vendor, "patches.json"), "utf8")));
for (const patch of patches) {
  const count = viewerHtml.split(patch.find).length - 1;
  if (count !== 1) throw new Error(`Archify patch anchor must match once, found ${String(count)}: ${patch.find.slice(0, 100)}`);
  viewerHtml = viewerHtml.replace(patch.find, patch.replacement);
}
viewerHtml = viewerHtml.replaceAll("[PROJECT NAME]", "Trajectory Semantic Map").replaceAll("[VISUAL PRESET]", "classic");
viewerHtml = replaceOnce(viewerHtml, '<html lang="en"', '<html data-embed="true" lang="en"', "embedded viewer root");
viewerHtml = replaceOnce(viewerHtml, "Trajectory Semantic Map Architecture Diagram", "Trajectory Session Semantic Map", "viewer document title");
viewerHtml = replaceOnce(viewerHtml, "<h1>Trajectory Semantic Map Architecture</h1>", "<h1>Selected workflow/session</h1>", "viewer heading");
viewerHtml = replaceOnce(viewerHtml, "[Subtitle description]", "Live metadata from the selected Trajectory target", "viewer subtitle");
// Never ship the vendor's sample AWS diagram as the initial or failed session view.
const slotStart = "<!-- ARCHIFY:SVG_SLOT_START -->";
const slotEnd = "<!-- ARCHIFY:SVG_SLOT_END -->";
const startAt = viewerHtml.indexOf(slotStart);
const endAt = viewerHtml.indexOf(slotEnd, startAt);
if (startAt < 0 || endAt < 0) throw new Error("Pinned Archify SVG slot is unavailable");
const slot = viewerHtml.slice(startAt, endAt + slotEnd.length);
const defsStart = slot.indexOf("<defs>");
const defsEnd = slot.indexOf("</defs>", defsStart);
if (defsStart < 0 || defsEnd < 0) throw new Error("Pinned Archify SVG definitions are unavailable");
const emptyCanvas = `${slotStart}\n      <svg viewBox="0 0 1000 680" role="img" aria-label="Selected workflow/session semantic map">\n        ${slot.slice(defsStart, defsEnd + "</defs>".length)}\n        <rect width="100%" height="100%" fill="url(#grid)" />\n      </svg>\n      ${slotEnd}\n      <p id="semantic-map-loading" role="status">Waiting for selected workflow/session data…</p>`;
viewerHtml = replaceOnce(viewerHtml, slot, emptyCanvas, "empty session canvas");
// Metadata retains the three canonical versioned URLs. The trusted parent fetches JS/CSS, not the opaque frame.
viewerHtml = replaceOnce(viewerHtml, `<link rel="stylesheet" href="/semantic-map.css?v=${STAMP_PLACEHOLDER}">`, `<meta name="semantic-map-style" content="/semantic-map.css?v=${STAMP_PLACEHOLDER}">`, "viewer stylesheet metadata");
viewerHtml = replaceOnce(viewerHtml, `<script src="/semantic-map.js?v=${STAMP_PLACEHOLDER}"></script>`, `<meta name="semantic-map-script" content="/semantic-map.js?v=${STAMP_PLACEHOLDER}">`, "viewer script metadata");

const bridgePath = join(trajectory, "src/semantic-map/bridge.ts");
const bridgeSource = normalize(await readFile(bridgePath, "utf8"));
const bridgeStart = "export const SEMANTIC_MAP_BRIDGE_CLIENT = `";
const bridgeEnd = "`;\n\nexport const SEMANTIC_MAP_BRIDGE_LIMITS";
const bridgeStartAt = bridgeSource.indexOf(bridgeStart);
const bridgeEndAt = bridgeSource.indexOf(bridgeEnd, bridgeStartAt + bridgeStart.length);
if (bridgeStartAt < 0 || bridgeEndAt < 0 || bridgeSource.indexOf(bridgeStart, bridgeStartAt + bridgeStart.length) >= 0 || bridgeSource.slice(bridgeStartAt + bridgeStart.length, bridgeEndAt).includes("`")) {
  throw new Error("Could not extract the single, literal child-side MessagePort bridge source");
}
const childBridge = bridgeSource.slice(bridgeStartAt + bridgeStart.length, bridgeEndAt).trim();
viewerHtml = replaceOnce(viewerHtml, "</body>", `<script data-semantic-map-bootstrap>\n${childBridge.replaceAll("</script", "<\\/script")}\n</script>\n</body>`, "independent inline child bootstrap");

const shellPath = join(assets, "index.html");
let shell = normalize(await readFile(shellPath, "utf8"));
// Generated stamp markers are removed before hashing so earlier outputs never feed back into the next stamp.
shell = shell.replace(/\s*<meta name="semantic-map-build" content="[0-9a-f]{16}">\n/g, "\n");
const appOpen = "<script data-semantic-map-app>";
const appOpenAt = shell.indexOf(appOpen);
const appCloseAt = shell.indexOf("</script>", appOpenAt + appOpen.length);
if (appOpenAt < 0 || appCloseAt < 0 || shell.indexOf(appOpen, appOpenAt + appOpen.length) >= 0) throw new Error("Expected one generated Semantic Map app script in the main Trajectory shell");
const appMarker = "__SEMANTIC_MAP_APP_BUNDLE__";
const canonicalShell = shell.slice(0, appOpenAt + appOpen.length) + `\n${appMarker}\n  ` + shell.slice(appCloseAt);
const appBundle = await bundle("src/semantic-map/index.ts");
const viewerBundle = await bundle("src/semantic-map/viewer.ts");
const cssInput = normalize(await readFile(join(trajectory, "src/semantic-map.css"), "utf8"));

// Authored inputs only: generated assets and src/semantic-map-assets.ts are never hashed.
const sourceFiles = [
  "scripts/build-semantic-map.mjs",
  "packages/core/trajectory/src/semantic-map-build.ts",
  "packages/core/trajectory/src/semantic-map/adapter.ts",
  "packages/core/trajectory/src/semantic-map/bridge.ts",
  "packages/core/trajectory/src/semantic-map/index.ts",
  "packages/core/trajectory/src/semantic-map/renderer.ts",
  "packages/core/trajectory/src/semantic-map/layout.ts",
  "packages/core/trajectory/src/semantic-map/viewer.ts",
  "packages/core/trajectory/src/semantic-map.css",
  "packages/core/trajectory/vendor/archify/patches.json",
  "packages/core/trajectory/vendor/archify/source.json"
];
const stampHash = createHash("sha256");
const hashPart = (name, value) => {
  const bytes = Buffer.from(value, "utf8");
  stampHash.update(`${name}\0${String(bytes.length)}\0`).update(bytes);
};
hashPart("template", inputBytes.toString("utf8"));
hashPart("viewer.html", viewerHtml);
hashPart("shell", canonicalShell);
hashPart("app", appBundle);
hashPart("viewer.js", viewerBundle);
hashPart("bridge", childBridge);
for (const path of sourceFiles) hashPart(path, normalize(await readFile(join(root, path), "utf8")));
const stamp = stampHash.digest("hex").slice(0, 16);

const finalViewerHtml = stampPlaceholders(viewerHtml, "viewer HTML");
const generatedAppScript = `<script data-semantic-map-app>\n${stampPlaceholders(appBundle, "parent app bundle")}\n  </script>`;
const appHtml = replaceOnce(shell, shell.slice(appOpenAt, appCloseAt + "</script>".length), generatedAppScript, "main app script");
const stampedAppHtml = replaceOnce(appHtml, "</head>", `  <meta name="semantic-map-build" content="${stamp}">\n</head>`, "main shell head close");
const js = `/* Archify ${sourceInfo.revision}; build ${stamp}; licenses: trajectory/vendor/archify/LICENSE */\n${stampPlaceholders(viewerBundle, "viewer bundle")}\n`;
const css = `/* Semantic Map ${stamp} */\n${cssInput}`;
const outputs = [
  ["index.html", normalize(stampedAppHtml)],
  ["semantic-map.html", normalize(finalViewerHtml)],
  ["semantic-map.js", normalize(js)],
  ["semantic-map.css", normalize(css)]
];
for (const [name, value] of outputs) if (value.includes(STAMP_PLACEHOLDER)) throw new Error(`Unresolved build stamp placeholder in ${name}`);
const manifestAssets = outputs.map(([name, value]) => {
  const bytes = Buffer.from(value, "utf8");
  return `    ${JSON.stringify(name)}: Object.freeze({ bytes: ${String(bytes.length)}, sha256: ${JSON.stringify(createHash("sha256").update(bytes).digest("hex"))} })`;
}).join(",\n");
const tsStamp = `/** Generated offline by scripts/build-semantic-map.mjs; included in Trajectory lock identity. */
export const SEMANTIC_MAP_BUILD_STAMP = ${JSON.stringify(stamp)};
export type SemanticMapAssetName = "index.html" | "semantic-map.html" | "semantic-map.js" | "semantic-map.css";
export type SemanticMapAssetDigest = Readonly<{ bytes: number; sha256: string }>;
/** Expected final bytes of the parent shell and the three browser assets for this build; a server constant, not a browser asset. */
export const SEMANTIC_MAP_ASSET_MANIFEST: Readonly<{ schema: 1; stamp: string; versionParameter: "v"; assets: Readonly<Record<SemanticMapAssetName, SemanticMapAssetDigest>> }> = Object.freeze({
  schema: 1,
  stamp: SEMANTIC_MAP_BUILD_STAMP,
  versionParameter: "v",
  assets: Object.freeze({
${manifestAssets}
  })
});
`;
await Promise.all([
  ...outputs.map(([name, value]) => writeIfChanged(join(assets, name), value)),
  writeIfChanged(join(trajectory, "src/semantic-map-assets.ts"), tsStamp)
]);
process.stdout.write(`Semantic Map ${stamp}: ${Buffer.byteLength(outputs[1][1])} B HTML, ${Buffer.byteLength(outputs[2][1])} B JS, ${Buffer.byteLength(outputs[3][1])} B CSS\n`);
