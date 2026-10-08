import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { canonicalPath, piResourceContains, piResourcePath, sameFilesystemPath } from "../src/paths.js";

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
  assert.match(pathsSource, /export function canonicalPath\(/);
  for (const source of sources.slice(1)) assert.doesNotMatch(source, /realpathSync|export function (?:canonicalPath|sameFilesystemPath)\(/);
  for (const source of sources) assert.doesNotMatch(source, /function\s+(?:canonicalSourcePath|canonicalRoleDirectory|canonical)\s*\(/);
  assert.doesNotMatch(sources[5] ?? "", /realpathSync/);
});

void test("contributed resource paths are normalized and contained exactly as Pi's resource loader attributes them", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "workflow-containment-"));
  const home = process.env.HOME;
  t.after(() => { rmSync(directory, { recursive: true, force: true }); process.env.HOME = home; });
  process.env.HOME = join(directory, "home");
  const cwd = join(directory, "project");
  assert.equal(piResourcePath("~", cwd), join(directory, "home"));
  assert.equal(piResourcePath("~/generated", cwd), join(directory, "home", "generated"));
  assert.equal(piResourcePath(pathToFileURL(join(directory, "url skill")).href, cwd), join(directory, "url skill"));
  assert.equal(piResourcePath("../relative", cwd), join(directory, "relative"));
  assert.equal(piResourcePath(`  ${join(directory, "padded")}  `, cwd), join(directory, "padded"));
  assert.equal(piResourcePath("<inline:tool>", cwd), "<inline:tool>");
  assert.equal(piResourcePath("builtin:skills", cwd), "builtin:skills");
  // Lexical, like Pi's source attribution: a symlinked contribution owns what is walked under it, not its target's siblings.
  mkdirSync(join(directory, "skills", "one"), { recursive: true });
  symlinkSync(join(directory, "skills"), join(directory, "alias"));
  assert.equal(piResourceContains(join(directory, "alias"), join(directory, "alias", "one", "SKILL.md")), true);
  assert.equal(piResourceContains(join(directory, "alias"), join(directory, "skills", "one", "SKILL.md")), false);
  assert.equal(piResourceContains(join(directory, "skills"), join(directory, "skills")), true);
  assert.equal(piResourceContains(join(directory, "skills"), join(directory, "skills-other", "SKILL.md")), false);
  assert.equal(piResourceContains(join(directory, "skills"), directory), false);
});
