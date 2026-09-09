import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalPath, sameFilesystemPath } from "../src/paths.js";

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../src");
const identitySources = [
  resolve(sourceRoot, "paths.ts"),
  resolve(sourceRoot, "trajectory.ts"),
  resolve(sourceRoot, "registry.ts"),
  resolve(sourceRoot, "agent-execution.ts"),
  resolve(sourceRoot, "validation.ts"),
  resolve(sourceRoot, "../trajectory/src/server.ts"),
  resolve(sourceRoot, "../../cli/src/doctor.ts"),
  resolve(sourceRoot, "../../cli/src/cli.ts"),
];

void test("canonical paths resolve portable symlink aliases and missing descendants", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflows-paths-"));
  try {
    const real = join(root, "real");
    const alias = join(root, "alias");
    const other = join(root, "other");
    await mkdir(real);
    await mkdir(other);
    await symlink(real, alias, process.platform === "win32" ? "junction" : "dir");

    assert.equal(canonicalPath(alias), canonicalPath(real));
    assert.equal(sameFilesystemPath(alias, real), true);

    const missing = "not-yet-created/entry.js";
    assert.equal(canonicalPath(join(alias, missing)), resolve(alias, missing));
    assert.equal(sameFilesystemPath(join(alias, missing), join(real, missing)), false);
    assert.equal(sameFilesystemPath(real, other), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("physical path identity has one canonicalization owner", async () => {
  const sources = await Promise.all(identitySources.map((path) => readFile(path, "utf8")));
  const pathsSource = sources[0] ?? "";
  assert.equal((pathsSource.match(/^export function canonicalPath\(/gm) ?? []).length, 1);
  assert.equal((pathsSource.match(/^export function sameFilesystemPath\(/gm) ?? []).length, 1);
  for (const source of sources) assert.doesNotMatch(source, /function\s+(?:canonicalSourcePath|canonicalRoleDirectory|canonical)\s*\(/);
  assert.doesNotMatch(sources[5] ?? "", /realpathSync/);
});
