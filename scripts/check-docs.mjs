/* global process */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const docsDir = fileURLToPath(new URL("../docs/", import.meta.url));
const requiredFiles = ["index.html", "developers.html", "agents.html", "styles.css"];
const errors = [];
const files = new Set(readdirSync(docsDir));

for (const file of requiredFiles) {
  if (!files.has(file)) errors.push(`missing docs file: ${file}`);
}

const htmlFiles = [...files].filter((file) => extname(file) === ".html");
const idsByFile = new Map();
for (const file of htmlFiles) {
  const source = readFileSync(resolve(docsDir, file), "utf8");
  idsByFile.set(file, new Set([...source.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1])));
}
for (const file of htmlFiles) {
  const source = readFileSync(resolve(docsDir, file), "utf8");
  for (const match of source.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const target = match[1];
    if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
    const [path, fragment] = target.split("#", 2);
    const targetFile = path ? resolve(docsDir, dirname(file), path) : resolve(docsDir, file);
    const relativeTarget = targetFile.slice(docsDir.length).replace(/^\/+/, "");
    if (!existsSync(targetFile)) {
      errors.push(`${file}: broken link ${target}`);
      continue;
    }
    if (fragment) {
      const targetName = path ? relativeTarget : file;
      if (!idsByFile.get(targetName)?.has(fragment)) errors.push(`${file}: missing anchor ${target}`);
    }
  }
}

const landing = readFileSync(resolve(docsDir, "index.html"), "utf8");
for (const link of ["developers.html", "agents.html"]) {
  if (!landing.includes(`href="${link}"`)) errors.push(`landing page does not link to ${link}`);
}
if (!htmlFiles.every((file) => readFileSync(resolve(docsDir, file), "utf8").includes("language-"))) errors.push("every HTML page must contain a syntax-highlighted example");

if (errors.length) {
  console.error(errors.map((error) => `docs check: ${error}`).join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Docs check passed: ${htmlFiles.length} HTML pages and ${requiredFiles.length} required files.`);
}