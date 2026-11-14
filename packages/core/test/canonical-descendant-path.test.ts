import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalDescendantPath, canonicalPath } from "../src/paths.js";

void test("canonicalDescendantPath retains canonical identity for missing children through directory aliases", () => {
  const home = mkdtempSync(join(tmpdir(), "canonical-descendant-")), root = join(home, "root"), alias = join(home, "alias");
  mkdirSync(root); symlinkSync(root, alias, "dir");
  try {
    assert.equal(canonicalDescendantPath(alias, join(alias, "missing", "child")), join(canonicalPath(root), "missing", "child"));
    assert.equal(canonicalDescendantPath(root, root), canonicalPath(root));
    if (process.platform === "darwin") {
      const privateHome = canonicalPath(home), temporaryHome = privateHome.replace(/^\/private\/tmp\//, "/tmp/");
      assert.equal(canonicalDescendantPath(temporaryHome, join(temporaryHome, "absent")), join(privateHome, "absent"));
    }
  } finally { rmSync(home, { recursive: true, force: true }); }
});

void test("canonicalDescendantPath rejects traversal missing anchors and escaping or dangling symlinks", () => {
  const home = mkdtempSync(join(tmpdir(), "canonical-boundary-")), root = join(home, "root"), outside = join(home, "outside");
  mkdirSync(root); mkdirSync(outside); symlinkSync(outside, join(root, "escape"), "dir"); symlinkSync(join(home, "absent"), join(root, "dangling"), "dir");
  try {
    assert.throws(() => canonicalDescendantPath(root, join(root, "..", "outside", "missing")), /escapes/);
    assert.throws(() => canonicalDescendantPath(root, join(root, "escape", "missing")), /symlink boundary/);
    assert.throws(() => canonicalDescendantPath(root, join(root, "dangling", "missing")));
    assert.throws(() => canonicalDescendantPath(join(home, "absent"), join(home, "absent", "child")));
  } finally { rmSync(home, { recursive: true, force: true }); }
});
