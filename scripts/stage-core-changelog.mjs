import { createHash } from "node:crypto";
import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repository root is derived from this script's location so an isolated copy only touches its own tree.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(root, "CHANGELOG.md");
const destination = resolve(root, "packages/core/CHANGELOG.md");
const marker = resolve(root, ".tmp", "core-changelog-staged");
const markerOwner = "pi-extensible-workflows/stage-core-changelog";
const action = process.argv[2];

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

// Returns the staged digest recorded by this script, or undefined for a marker it does not own.
// A legacy empty marker (written by earlier versions) owns only a byte-identical copy of the root changelog.
function ownedDigest() {
  const text = readFileSync(marker, "utf8");
  if (text === "") return existsSync(source) ? digest(readFileSync(source)) : undefined;
  try {
    const parsed = JSON.parse(text);
    if (parsed?.owner === markerOwner && typeof parsed.sha256 === "string" && /^[0-9a-f]{64}$/.test(parsed.sha256)) return parsed.sha256;
  } catch { /* foreign marker */ }
  return undefined;
}

function preflight() {
  const problems = [];
  if (existsSync(destination)) problems.push(`${destination} already exists; it is not overwritten or removed by staging`);
  if (existsSync(marker)) problems.push(`${marker} already exists; run "node scripts/stage-core-changelog.mjs clean" after an interrupted pack or inspect the marker manually`);
  return problems;
}

function stage() {
  const problems = preflight();
  if (existsSync(destination)) throw new Error(`Refusing to overwrite ${destination}`);
  if (problems.length > 0) throw new Error(`Refusing to stage: ${problems.join("; ")}`);
  const bytes = readFileSync(source);
  let createdMarker = false;
  let createdDestination = false;
  try {
    mkdirSync(dirname(marker), { recursive: true });
    writeFileSync(marker, `${JSON.stringify({ owner: markerOwner, version: 1, sha256: digest(bytes), bytes: bytes.length })}\n`, { flag: "wx" });
    createdMarker = true;
    copyFileSync(source, destination, constants.COPYFILE_EXCL);
    createdDestination = true;
    if (digest(readFileSync(destination)) !== digest(bytes)) throw new Error(`Staged ${destination} does not match ${source}`);
  } catch (error) {
    // Undo only what this invocation created; never remove pre-existing files or markers.
    if (createdDestination) rmSync(destination, { force: true });
    if (createdMarker) rmSync(marker, { force: true });
    throw error;
  }
}

function clean() {
  if (!existsSync(marker)) return;
  const owned = ownedDigest();
  if (owned === undefined) throw new Error(`Refusing to clean: ${marker} was not written by this script; inspect it manually`);
  if (existsSync(destination)) {
    if (digest(readFileSync(destination)) !== owned) throw new Error(`Refusing to remove ${destination}: it changed after staging; inspect it manually`);
    rmSync(destination);
  }
  rmSync(marker);
}

try {
  if (action === "stage") stage();
  else if (action === "clean") clean();
  else if (action === "preflight") {
    const problems = preflight();
    if (problems.length > 0) throw new Error(`Core changelog staging preflight failed: ${problems.join("; ")}`);
  } else throw new Error("Expected stage, clean or preflight");
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
