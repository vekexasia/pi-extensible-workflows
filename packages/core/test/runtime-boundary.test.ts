import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src/runtime");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : entry.name.endsWith(".ts") ? [path] : [];
  });
}

void test("the runtime boundary has no Pi SDK imports", () => {
  for (const path of sourceFiles(runtimeRoot)) assert.doesNotMatch(readFileSync(path, "utf8"), /@earendil-works\//, path);
});

