#!/usr/bin/env node
// CI helper for the required-browser job (.github/workflows/check.yml). Plain Node, so it runs the same under pwsh and bash.
//
//   node scripts/ci-browser-evidence.mjs require-chrome      fail unless PI_TRAJECTORY_CHROME names an existing file
//   node scripts/ci-browser-evidence.mjs tap <file.tap>      fail unless every TAP summary has pass > 0 and 0 fail/cancelled/skipped/todo
//   node scripts/ci-browser-evidence.mjs checksums <dir>     write <dir>/SHA256SUMS for every regular file below <dir>
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Returns the problems in TAP output; an empty list means every summary block is complete and skip-free. */
export function tapProblems(text) {
  const counts = (name) => [...text.matchAll(new RegExp(`^# ${name} (\\d+)\\s*$`, "gm"))].map((match) => Number(match[1]));
  const pass = counts("pass");
  const problems = [];
  if (pass.length === 0) problems.push("no TAP summary found");
  if (pass.some((value) => value === 0)) problems.push("a TAP summary has 0 passing tests");
  for (const name of ["fail", "cancelled", "skipped", "todo"]) {
    const values = counts(name);
    if (values.length !== pass.length) problems.push(`${name}: expected ${String(pass.length)} summary counts, found ${String(values.length)}`);
    if (values.some((value) => value !== 0)) problems.push(`${name}: ${values.join(",")}`);
  }
  return problems;
}

function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? files(path) : entry.isFile() ? [path] : [];
  });
}

function main([mode, target]) {
  if (mode === "require-chrome") {
    const chrome = process.env.PI_TRAJECTORY_CHROME;
    if (!chrome || !existsSync(chrome) || !statSync(chrome).isFile()) { process.stderr.write(`PI_TRAJECTORY_CHROME must name an existing Chrome/Chromium executable; got ${JSON.stringify(chrome ?? null)}\n`); return 1; }
    process.stdout.write(`Required browser: ${chrome}\n`);
    return 0;
  }
  if (mode === "tap" && target) {
    const problems = tapProblems(readFileSync(target, "utf8"));
    process.stdout.write(problems.length ? `Incomplete required browser suite:\n${problems.join("\n")}\n` : "Required browser suite: every test passed, none skipped\n");
    return problems.length ? 1 : 0;
  }
  if (mode === "checksums" && target) {
    const root = resolve(target);
    const lines = files(root).filter((path) => relative(root, path) !== "SHA256SUMS").sort().map((path) => `${createHash("sha256").update(readFileSync(path)).digest("hex")}  ${relative(root, path).split("\\").join("/")}`);
    writeFileSync(join(root, "SHA256SUMS"), `${lines.join("\n")}\n`);
    process.stdout.write(`${String(lines.length)} files hashed into ${join(root, "SHA256SUMS")}\n`);
    return 0;
  }
  process.stderr.write("Usage: node scripts/ci-browser-evidence.mjs require-chrome | tap <file> | checksums <dir>\n");
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
