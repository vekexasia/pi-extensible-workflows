import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { herdrPaneCommand, herdrPaneId, openHerdrPane } from "../src/herdr.js";
import { runCli } from "../src/cli.js";

void test("gates Herdr actions on the managed pane environment", () => {
  assert.equal(herdrPaneId({ HERDR_ENV: "0", HERDR_PANE_ID: "pane" }), undefined);
  assert.equal(herdrPaneId({ HERDR_ENV: "1" }), undefined);
  assert.equal(herdrPaneId({ HERDR_ENV: "1", HERDR_PANE_ID: " opaque-pane " }), "opaque-pane");
});

void test("targets the declared Herdr pane, chooses geometry, and escapes pane commands", async () => {
  const previousEnvironment = { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_CODING_AGENT_SESSION_DIR: process.env.PI_CODING_AGENT_SESSION_DIR };
  process.env.HERDR_ENV = "1";
  process.env.HERDR_PANE_ID = "declared-pane";
  process.env.PI_CODING_AGENT_DIR = "/tmp/agent dir";
  process.env.PI_CODING_AGENT_SESSION_DIR = "/tmp/session's dir";
  try {
    const command = herdrPaneCommand({ action: "fork", cwd: "/tmp/work dir", original: "/tmp/original's.jsonl", readOnly: true });
    assert.match(command, /cd '\/tmp\/work dir'/);
    assert.match(command, /PI_CODING_AGENT_DIR='\/tmp\/agent dir'/);
    assert.match(command, /PI_CODING_AGENT_SESSION_DIR='\/tmp\/session'\\''s dir'/);
    assert.match(command, /pi --fork '\/tmp\/original'\\''s\.jsonl' --tools 'read,grep,find,ls'/);
    assert.doesNotMatch(command, /npx/);

    const calls: string[][] = [];
    const runner = async (args: readonly string[]): Promise<string> => {
      calls.push([...args]);
      if (args[1] === "layout") return JSON.stringify({ result: { layout: { panes: [{ pane_id: "declared-pane", rect: { width: 20, height: 80 } }] } } });
      if (args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: "opaque:new-pane" } } });
      return "";
    };
    assert.equal(await openHerdrPane({ action: "transcript", cwd: "/tmp/work", original: "/tmp/transcript.jsonl" }, runner), "opaque:new-pane");
    assert.deepEqual(calls.slice(0, 2), [
      ["pane", "layout", "--pane", "declared-pane"],
      ["pane", "split", "declared-pane", "--direction", "down", "--no-focus"],
    ]);
    const runCall = calls[2];
    assert.ok(runCall);
    assert.equal(runCall[0], "pane");
    assert.equal(runCall[1], "run");
    assert.equal(runCall[2], "opaque:new-pane");

    const failingCalls: string[][] = [];
    const failingRunner = async (args: readonly string[]): Promise<string> => {
      failingCalls.push([...args]);
      if (args[1] === "layout") return JSON.stringify({ result: { layout: { panes: [{ pane_id: "declared-pane", rect: { width: 100, height: 20 } }] } } });
      if (args[1] === "split") return JSON.stringify({ result: { pane: { pane_id: "created-only-by-this-action" } } });
      if (args[1] === "run") throw new Error("startup failed");
      return "";
    };
    await assert.rejects(openHerdrPane({ action: "inspect", cwd: "/tmp/work", sessionId: "session" }, failingRunner), /startup failed/);
    assert.deepEqual(failingCalls.at(-1), ["pane", "close", "created-only-by-this-action"]);
  } finally {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) Reflect.deleteProperty(process.env, name);
      else process.env[name] = value;
    }
  }
});

void test("renders the transcript CLI command to stdout", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-transcript-cli-"));
  const session = join(root, "session.jsonl");
  writeFileSync(session, `${JSON.stringify({ type: "session", version: 3, id: "session", timestamp: "2026-01-01T00:00:00.000Z", cwd: root })}\n${JSON.stringify({ type: "message", id: "message", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "hello" } })}\n`);
  const output: string[] = [];
  assert.equal(await runCli(["transcript", session], {}, (text) => output.push(text)), 0);
  assert.match(output.join(""), /\[user\][\s\S]*hello/);
});