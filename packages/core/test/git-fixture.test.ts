import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixtureGit, fixtureGitSync, gitFixtureEnvironment, initializeGitFixture } from "./git-fixture.js";

void test("gitFixtureEnvironment isolates configuration, identity, repository redirects and agent without global mutation", () => {
  const inherited = { PATH: process.env.PATH, HOME: "/synthetic/unsafe-home", SSH_AUTH_SOCK: "/synthetic/socket", SSH_AGENT_PID: "1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "commit.gpgSign", GIT_CONFIG_VALUE_0: "true", GIT_CONFIG_PARAMETERS: "injected", GIT_CONFIG_GLOBAL: "/synthetic/global", GIT_DIR: "/synthetic/git", GIT_WORK_TREE: "/synthetic/worktree", GIT_INDEX_FILE: "/synthetic/index", GIT_AUTHOR_NAME: "Hostile", GIT_COMMITTER_EMAIL: "hostile@example.invalid", GIT_TEMPLATE_DIR: "/synthetic/template" };
  const before = { ...inherited };
  const env = gitFixtureEnvironment(inherited);
  assert.deepEqual(inherited, before);
  assert.equal(env.HOME, inherited.HOME);
  assert.equal(env.GIT_CONFIG_GLOBAL, "/dev/null");
  assert.equal(env.GIT_CONFIG_SYSTEM, "/dev/null");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  for (const key of ["SSH_AUTH_SOCK", "SSH_AGENT_PID", "GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_PARAMETERS", "GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_AUTHOR_NAME", "GIT_COMMITTER_EMAIL", "GIT_TEMPLATE_DIR"]) assert.equal(env[key], undefined, key);
});

void test("initializeGitFixture seeds private policy before commits and linked worktrees inherit it", () => {
  const root = mkdtempSync(join(tmpdir(), "git-fixture-contract-")), repo = join(root, "repo"), linked = join(root, "linked");
  try {
    initializeGitFixture(repo);
    fixtureGit(repo, "commit", "--allow-empty", "-qm", "initial");
    assert.equal(fixtureGit(repo, "log", "-1", "--format=%an|%ae|%cn|%ce"), "Fixture|fixture@example.invalid|Fixture|fixture@example.invalid");
    assert.equal(fixtureGit(repo, "config", "--local", "--get", "commit.gpgSign"), "false");
    const hooks = fixtureGit(repo, "config", "--local", "--get", "core.hooksPath");
    assert.equal(existsSync(hooks), true);
    fixtureGit(repo, "worktree", "add", "-qb", "linked", linked);
    assert.equal(fixtureGit(linked, "config", "--get", "core.hooksPath"), hooks);
    fixtureGit(linked, "commit", "--allow-empty", "-qm", "linked");
    const config = readFileSync(join(repo, ".git", "config"), "utf8");
    assert.throws(() => { initializeGitFixture(repo); }, /new disposable/);
    assert.throws(() => { initializeGitFixture(linked); }, /new disposable/);
    assert.equal(readFileSync(join(repo, ".git", "config"), "utf8"), config);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void test("initializeGitFixture bare policy is private and existing bare config is never reseeded", () => {
  const root = mkdtempSync(join(tmpdir(), "git-fixture-bare-"));
  try {
    initializeGitFixture(root, true);
    assert.equal(fixtureGit(root, "config", "--local", "--get", "commit.gpgSign"), "false");
    assert.equal(existsSync(join(root, "fixture-hooks")), true);
    const config = readFileSync(join(root, "config"), "utf8");
    assert.throws(() => { initializeGitFixture(root, true); }, /new disposable/);
    assert.equal(readFileSync(join(root, "config"), "utf8"), config);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void test("fixtureGit preserves intentional fixture-local refusing hooks and fake SSH signing", () => {
  const root = mkdtempSync(join(tmpdir(), "git-fixture-intentional-"));
  try {
    initializeGitFixture(root);
    const hooks = fixtureGit(root, "config", "--get", "core.hooksPath"), hook = join(hooks, "pre-commit"), hookMarker = join(root, "hook-marker");
    writeFileSync(hook, `#!/bin/sh\nprintf hook > '${hookMarker}'\nexit 23\n`, { mode: 0o700 });
    assert.throws(() => fixtureGit(root, "commit", "--allow-empty", "-qm", "refused"));
    assert.equal(readFileSync(hookMarker, "utf8"), "hook");
    rmSync(hook);
    const signer = join(root, "fake-ssh-sign"), marker = join(root, "signer-marker");
    writeFileSync(signer, `#!/bin/sh\nprintf fake > '${marker}'\nexit 24\n`, { mode: 0o700 });
    for (const [key, value] of [["commit.gpgSign", "true"], ["gpg.format", "ssh"], ["gpg.ssh.program", signer], ["user.signingKey", "key::synthetic-not-a-key"]] as const) fixtureGit(root, "config", "--local", key, value);
    assert.throws(() => fixtureGitSync(["-C", root, "commit", "--allow-empty", "-qm", "fake-sign"], { stdio: "pipe" }));
    assert.equal(readFileSync(marker, "utf8"), "fake");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
