import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { canonicalPath, projectStorageKey, safePart, sameFilesystemPath, structuralPath } from "../src/paths.js";

function lowerDrive(path: string): string { return /^[A-Z]:/.test(path) ? `${path.charAt(0).toLowerCase()}${path.slice(1)}` : path; }
function caseAliases(path: string): string[] {
  // Only case spellings the filesystem really resolves to the same object count as aliases.
  return [path.toUpperCase(), path.toLowerCase()].filter((alias) => alias !== path && existsSync(alias));
}
function lexicalStorageKey(path: string): string {
  const exact = resolve(path);
  return `${safePart(basename(exact)) || "root"}-${createHash("sha256").update(exact).digest("hex").slice(0, 12)}`;
}

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

void test("canonical paths converge drive, separator, case, and junction aliases with spaces and Unicode", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflows-paths alias ü-"));
  try {
    const real = join(root, "Réal Project Ω");
    const other = join(root, "Other Project Ω");
    const junction = join(root, "Junction Alias ü");
    await mkdir(real);
    await mkdir(other);
    await writeFile(join(real, "Entry File.js"), "export {};\n");
    await symlink(real, junction, process.platform === "win32" ? "junction" : "dir");
    // The operating system, not paths.ts, is the oracle for the physical spelling.
    const physical = realpathSync.native(real);
    const physicalFile = realpathSync.native(join(real, "Entry File.js"));

    const aliases = [real, `${real}${sep}`, join(real, "..", basename(real)), real.split(sep).join("/"), junction, join(junction, "."), lowerDrive(real), lowerDrive(junction), ...caseAliases(real), ...caseAliases(junction)];
    if (process.platform === "win32") {
      assert.notEqual(lowerDrive(real), real, "Windows fixtures must exercise a drive-letter alias");
      assert.ok(caseAliases(real).length > 0, "Windows fixtures must exercise an effective case alias");
    }
    for (const alias of new Set(aliases)) {
      assert.equal(canonicalPath(alias), physical, alias);
      assert.equal(sameFilesystemPath(alias, real), true, alias);
      assert.equal(sameFilesystemPath(alias, other), false, alias);
    }
    const fileAliases = [join(real, "Entry File.js"), join(junction, "Entry File.js"), lowerDrive(join(real, "Entry File.js")), ...caseAliases(join(junction, "Entry File.js"))];
    for (const alias of new Set(fileAliases)) {
      assert.equal(canonicalPath(alias), physicalFile, alias);
      assert.equal(sameFilesystemPath(alias, join(real, "Entry File.js")), true, alias);
    }

    const missing = join("Missing Dir ü", "entry.js");
    assert.equal(canonicalPath(join(junction, missing)), resolve(junction, missing));
    assert.equal(canonicalPath(join(real, missing)), resolve(real, missing));
    assert.equal(sameFilesystemPath(join(junction, missing), join(real, missing)), false);
    assert.equal(sameFilesystemPath(join(real, missing), join(real, missing)), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("file symlink aliases converge when the platform grants symlink creation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-workflows-paths file-link ü-"));
  try {
    const target = join(root, "Target File ü.js");
    const link = join(root, "Link File ü.js");
    await writeFile(target, "export {};\n");
    try { await symlink(target, link, "file"); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (process.platform === "win32" && code === "EPERM") { t.skip("file-symlink capability unavailable: EPERM without SeCreateSymbolicLinkPrivilege/Developer Mode; directory junction aliases are covered separately"); return; }
      throw error;
    }
    assert.equal(canonicalPath(link), realpathSync.native(target));
    assert.equal(sameFilesystemPath(link, target), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

void test("persisted project and structural identities stay lexical across filesystem aliases", async () => {
  if (process.platform === "win32") {
    assert.equal(projectStorageKey("C:\\Work Space\\Réal Project Ω"), "R_al_Project__-3846dd68edfa");
    assert.equal(projectStorageKey("C:/Work Space/Réal Project Ω/"), "R_al_Project__-3846dd68edfa");
    assert.equal(projectStorageKey("c:\\work space\\réal project ω"), "r_al_project__-acb1f6d5b732");
  } else {
    assert.equal(projectStorageKey("/work space/Réal Project Ω"), "R_al_Project__-1c291c1ca140");
  }
  assert.equal(structuralPath("Réal Project", "a b/c"), "R%C3%A9al%20Project/a%20b%2Fc");
  const root = await mkdtemp(join(tmpdir(), "pi-workflows-paths storage ü-"));
  try {
    const real = join(root, "Réal Project Ω");
    const junction = join(root, "Junction Alias ü");
    await mkdir(real);
    await symlink(real, junction, process.platform === "win32" ? "junction" : "dir");
    for (const path of [real, junction, lowerDrive(real), ...caseAliases(real)]) assert.equal(projectStorageKey(path), lexicalStorageKey(path), path);
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
