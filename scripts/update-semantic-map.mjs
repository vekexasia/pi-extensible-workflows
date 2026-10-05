import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index]; const value = process.argv[index + 1];
  if (!name?.startsWith("--") || !value || args.has(name)) throw new Error("Usage: node scripts/update-semantic-map.mjs --source <local-template.html> --revision <40-hex-commit> --version-label <upstream-label> --sha256 <64-hex-sha256>");
  args.set(name, value);
}
const source = args.get("--source"); const revision = args.get("--revision"); const versionLabel = args.get("--version-label"); const expectedHash = args.get("--sha256");
if (!source || !revision || !versionLabel?.trim() || !expectedHash || !/^[0-9a-f]{40}$/i.test(revision) || !/^[0-9a-f]{64}$/i.test(expectedHash)) throw new Error("Explicit reviewed source, upstream commit, version label, and SHA-256 are required");
const rawBytes = await readFile(resolve(source));
const bytes = Buffer.from(rawBytes.toString("utf8").replace(/\r\n/g, "\n"), "utf8");
const hash = createHash("sha256").update(bytes).digest("hex");
if (hash !== expectedHash.toLowerCase()) throw new Error(`Supplied checksum does not match local source: ${hash}`);
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const vendor = join(root, "packages/core/trajectory/vendor/archify");
const sourceInfo = JSON.parse(await readFile(join(vendor, "source.json"), "utf8"));
if (revision.toLowerCase() === sourceInfo.revision) throw new Error("An upstream source update must name a different reviewed commit");
await writeFile(join(vendor, "template.html"), bytes);
sourceInfo.revision = revision.toLowerCase();
sourceInfo.versionLabel = versionLabel.trim();
sourceInfo.sha256 = hash;
await writeFile(join(vendor, "source.json"), `${JSON.stringify(sourceInfo, null, 2)}\n`, "utf8");
process.stdout.write(`Pinned local template ${revision} (${hash}). Review license and every patch anchor, then run node scripts/build-semantic-map.mjs and browser tests.\n`);
