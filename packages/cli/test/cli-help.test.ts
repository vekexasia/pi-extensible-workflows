import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { runCli } from "../src/cli.js";

const packageJson = JSON.parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json"), "utf8")) as { version: string };
const topLevelHelp = `piewf - run, inspect and share Pi extensible workflows from the terminal

Usage:
  piewf <command> [options]

Commands:
  run <workflow-name> [args]      Run a registered workflow headlessly
  run --script <path>             Run a workflow from a JavaScript file
  export <workflow-name>          Export a workflow as a standalone launcher
  bundle <workflow-name>          Package a workflow as a portable bundle
  inspect [session-id]            Inspect workflow runs (interactive, --json or --summary)
  transcript <session-file>       Print a readable transcript of a session file
  share <run-id>                  Upload a run report as a secret GitHub gist
  doctor                          Check the workflow setup and report problems
  doctor cleanup                  Remove old persisted run data

Global options:
  -h, --help                      Show this help
  -v, --version                   Show the piewf version

Run 'piewf <command> --help' for the options of a command.
`;

function invoke(args: readonly string[]): Promise<{ exit: number; stdout: string; stderr: string }> {
  let stdout = "";
  let stderr = "";
  return runCli(args, { stderr: (text) => { stderr += text; } }, (text) => { stdout += text; }).then((exit) => ({ exit, stdout, stderr }));
}

void test("global version flags print the installed CLI package version", async () => {
  for (const flag of ["--version", "-v"]) {
    const result = await invoke([flag]);
    assert.equal(result.exit, 0);
    assert.equal(result.stdout, `${packageJson.version}\n`);
    assert.equal(result.stderr, "");
  }
});

void test("global help flags and help command print structured help", async () => {
  for (const args of [["--help"], ["-h"], ["help"]]) {
    const result = await invoke(args);
    assert.equal(result.exit, 0);
    assert.equal(result.stdout, topLevelHelp);
    assert.equal(result.stderr, "");
  }
});

void test("missing and unknown commands print structured help on stderr", async () => {
  const missing = await invoke([]);
  assert.equal(missing.exit, 1);
  assert.equal(missing.stdout, "");
  assert.equal(missing.stderr, topLevelHelp);

  const unknown = await invoke(["foo"]);
  assert.equal(unknown.exit, 1);
  assert.equal(unknown.stdout, "");
  assert.equal(unknown.stderr, `Unknown command: foo\n${topLevelHelp}`);
});

void test("all top-level commands handle help without running", async () => {
  const cases: readonly [readonly string[], RegExp][] = [
    [["run", "--help"], /^Usage: piewf run /],
    [["export", "--help"], /^Usage: piewf export /],
    [["bundle", "--help"], /^Usage: piewf bundle /],
    [["doctor", "--help"], /^Usage: piewf doctor /],
    [["doctor", "cleanup", "--help"], /^Usage: piewf doctor cleanup /],
    [["inspect", "--help"], /^Usage: piewf inspect /],
    [["transcript", "--help"], /^Usage: piewf transcript /],
    [["share", "--help"], /^Usage: piewf share /],
  ];
  for (const [args, usage] of cases) {
    const result = await invoke(args);
    assert.equal(result.exit, 0, args.join(" "));
    assert.match(result.stdout, usage);
    assert.equal(result.stderr, "");
  }
  const share = await invoke(["share", "--help"]);
  assert.match(share.stdout, /static Trajectory report[\s\S]*gh CLI/);
});

void test("inspect and transcript help do not invoke their handlers", async () => {
  let inspected = false;
  let transcribed = false;
  let stdout = "";
  assert.equal(await runCli(["inspect", "-h"], { inspect: async () => { inspected = true; } }, (text) => { stdout += text; }), 0);
  assert.equal(await runCli(["transcript", "--help"], { transcript: async () => { transcribed = true; } }, (text) => { stdout += text; }), 0);
  assert.equal(inspected, false);
  assert.equal(transcribed, false);
  assert.match(stdout, /Usage: piewf inspect/);
  assert.match(stdout, /Usage: piewf transcript/);
});

void test("invalid transcript invocations print transcript usage on stderr", async () => {
  const usage = ["Usage: piewf transcript <session-file>", "", "Arguments:", "  <session-file>".padEnd(28) + "Path to a Pi session JSONL file", "", "Options:", "  -h, --help".padEnd(28) + "Show this help"].join("\n") + "\n";
  for (const args of [["transcript"], ["transcript", "first", "second"]]) {
    const result = await invoke(args);
    assert.equal(result.exit, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, usage);
  }
});
