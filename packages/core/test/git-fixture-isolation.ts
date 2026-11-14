import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitFixtureEnvironment } from "./git-fixture.js";

// This is a direct node --test launch, not an npm runner policy. Never use a real HOME/key/socket.
export function assertGitFixturesIsolated(targets: readonly { url: URL; pattern: string; count: number }[]): void {
  const first = targets[0];
  assert.ok(first, "at least one real test target is required");
  const root = mkdtempSync(join(tmpdir(), "git-fixture-poison-"));
  try {
    const home = join(root, "home"), hooks = join(root, "hooks"), template = join(root, "template");
    mkdirSync(home); mkdirSync(hooks); mkdirSync(join(template, "hooks"), { recursive: true });
    const marker = join(root, "signer-called"), hookMarker = join(root, "hook-called");
    const signer = join(root, "fake-ssh-sign");
    writeFileSync(signer, `#!/bin/sh\nprintf called >> '${marker}'\nexit 99\n`, { mode: 0o700 });
    const hook = `#!/bin/sh\nprintf called >> '${hookMarker}'\nexit 98\n`;
    writeFileSync(join(hooks, "pre-commit"), hook, { mode: 0o700 });
    writeFileSync(join(template, "hooks", "pre-commit"), hook, { mode: 0o700 });
    const config = `[user]\n name = Hostile Identity\n email = hostile@example.invalid\n signingKey = key::synthetic-not-a-key\n[commit]\n gpgSign = true\n[gpg]\n format = ssh\n[gpg "ssh"]\n program = ${signer}\n`;
    writeFileSync(join(home, ".gitconfig"), config);
    const env: NodeJS.ProcessEnv = { ...gitFixtureEnvironment(), HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_GLOBAL: join(home, ".gitconfig"), GIT_CONFIG_SYSTEM: join(home, ".gitconfig"), SSH_AUTH_SOCK: join(root, "nonexistent-agent"), GIT_TEMPLATE_DIR: template };
    delete env.NODE_TEST_CONTEXT;
    // First exercise signing alone: a refusing hook must not hide an unsafe signer invocation.
    const run = (target = first) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=${target.pattern}`, target.url.pathname], { env, encoding: "utf8", timeout: 30000 });
    delete env.GIT_TEMPLATE_DIR;
    for (const target of targets) {
      const signed = run(target), output = `${signed.stdout}\n${signed.stderr}`;
      assert.equal(existsSync(marker), false, `global fake signer invoked\n${output}`);
      assert.equal(signed.status, 0, output);
      assert.match(output, new RegExp(`# pass ${String(target.count)}\\b`), "must actually run the named cases, not silently run zero tests");
    }
    env.GIT_TEMPLATE_DIR = template;
    env.GIT_CONFIG_COUNT = "2"; env.GIT_CONFIG_KEY_0 = "commit.gpgSign"; env.GIT_CONFIG_VALUE_0 = "true";
    env.GIT_CONFIG_KEY_1 = "core.hooksPath"; env.GIT_CONFIG_VALUE_1 = hooks;
    const injected = run();
    assert.equal(injected.status, 0, `${injected.stdout}\n${injected.stderr}`);
    assert.match(injected.stdout, new RegExp(`# pass ${String(first.count)}\\b`));
    assert.equal(existsSync(marker), false);
    assert.equal(existsSync(hookMarker), false);
    assert.equal(readFileSync(join(home, ".gitconfig"), "utf8"), config);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
