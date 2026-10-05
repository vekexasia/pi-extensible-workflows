import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import test from "node:test";

void test("workspace test workers receive isolated temporary Pi and home paths", () => {
  assert.equal(process.env.HOME, process.env.USERPROFILE);
  assert.equal(process.env.TMPDIR, process.env.TMP);
  assert.equal(process.env.TMPDIR, process.env.TEMP);
  assert.ok(process.env.PI_CODING_AGENT_DIR);
  assert.equal(existsSync(process.env.PI_CODING_AGENT_DIR), false);
  for (const name of ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_BIN_PATH", "HERDR_STARTUP_CWD"]) assert.equal(process.env[name], undefined);
  const isolatedNames = new Set(["HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TMPDIR", "TMP", "TEMP", "PI_CODING_AGENT_DIR", "HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_BIN_PATH", "HERDR_STARTUP_CWD"]);
  // Raw key spelling is recorded so the parent test can detect case-variant duplicates on Windows.
  const isolatedEnv = Object.entries(process.env).filter(([key]) => isolatedNames.has(key.toUpperCase()));
  writeFileSync(process.env.RUNNER_TEST_MARKER, JSON.stringify({ home: process.env.HOME, temp: process.env.TMPDIR, agent: process.env.PI_CODING_AGENT_DIR, isolatedEnv }));
});
