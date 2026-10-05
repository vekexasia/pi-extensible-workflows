import assert from "node:assert/strict";
import { findExecutable, spawnExecutable, spawnSyncExecutable, resolveExecutable, stopProcessTree, terminateProcessTree } from "../src/process-launcher.js";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve as resolvePath } from "node:path";
import test from "node:test";
import { sameFilesystemPath } from "../src/paths.js";
import { createProcessFixture, isProcessAlive, launch, LITERAL_ARGUMENTS, parseCapture, readPid, spawnSentinel, waitFor, withoutEnvKey } from "./process-fixtures.js";

const windows = process.platform === "win32";

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnExecutable(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    child.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code) => { resolve({ code, stdout, stderr }); });
  });
}

void test("Node entrypoints preserve literal argv and paths containing spaces and Unicode", async () => {
  const root = mkdtempSync(join(tmpdir(), "piewf process argv café with spaces-"));
  const workingDirectory = join(root, "project directory");
  const binDirectory = join(root, "npm bin");
  const entry = join(binDirectory, "fake pi entry.mjs");
  const capture = join(root, "captured invocation.json");
  mkdirSync(workingDirectory, { recursive: true });
  mkdirSync(binDirectory, { recursive: true });
  writeFileSync(entry, "import { writeFileSync } from 'node:fs'; writeFileSync(process.env.LAUNCH_CAPTURE, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() })); process.exitCode = process.argv.includes('--exit-seven') ? 7 : 0;\n");
  try {
    const values = ["space value", "café", "& | < > ^ % ! $ ' \\\"", "", "--exit-seven"];
    const result = await run(entry, values, workingDirectory, { ...process.env, LAUNCH_CAPTURE: capture });
    assert.equal(result.code, 7, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(capture, "utf8")), { args: values, cwd: workingDirectory });
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void test("npm launches its Node entrypoint and preserves the installed npm version", () => {
  const result = spawnSyncExecutable("npm", ["--version"], { encoding: "utf8", timeout: 30_000 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr.toString());
  assert.match(result.stdout.toString().trim(), /^\d+\.\d+\.\d+/);
});

void test("Windows npm command shims resolve to their Node entrypoint without cmd.exe argument parsing", async () => {
  if (process.platform !== "win32") return;
  const root = mkdtempSync(join(tmpdir(), "piewf shim with spaces-"));
  const nested = join(root, "node_modules", "fake package");
  const shim = join(root, "pi role.cmd");
  const entry = join(nested, "cli entry.mjs");
  mkdirSync(nested, { recursive: true });
  writeFileSync(entry, "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(shim, `@ECHO off\r\nIF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")\r\n"%_prog%" "%dp0%\\node_modules\\fake package\\cli entry.mjs" %*\r\n`);
  try {
    const values = ["a b", "éclair", "& ^ % ! | < >", "quote\"inside"];
    const result = await run(shim, values, root, process.env);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), values);
    const pathEnv = { pAtH: root, pAtHeXt: ".CMD" } as NodeJS.ProcessEnv;
    const resolved = resolveExecutable("pi role", values, pathEnv);
    assert.equal(resolved.command, process.execPath);
    assert.deepEqual(resolved.args, [entry, ...values]);
    assert.equal(delimiter, ";");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void test("relative Node entrypoints resolve against the child cwd for async and sync launches", async () => {
  const fixture = createProcessFixture();
  try {
    const entry = fixture.writeCapture(join("bin", "capture entry.mjs"));
    assert.equal(sameFilesystemPath(process.cwd(), fixture.project), false);
    const isolated = ["HOME", "USERPROFILE", "APPDATA", "PI_CODING_AGENT_DIR", "TEMP", "TMP", "TMPDIR"];
    const env = { ...fixture.env, CAPTURE_ENV_KEYS: isolated.join(",") };
    for (const kind of ["auto", "node"] as const) {
      const outcome = await launch(join("bin", "capture entry.mjs"), LITERAL_ARGUMENTS, { cwd: fixture.project, env }, { kind });
      assert.equal(outcome.error, undefined, outcome.stderr);
      assert.equal(outcome.code, 0, outcome.stderr);
      const capture = parseCapture(outcome);
      assert.deepEqual(capture.args, LITERAL_ARGUMENTS);
      assert.equal(sameFilesystemPath(capture.cwd, fixture.project), true, capture.cwd);
      for (const name of isolated) assert.ok(capture.env[name]?.startsWith(fixture.root), `${name}=${String(capture.env[name])}`);
      const sync = spawnSyncExecutable(join("bin", "capture entry.mjs"), LITERAL_ARGUMENTS, { cwd: fixture.project, env, encoding: "utf8", windowsHide: true }, { kind });
      assert.equal(sync.error, undefined);
      assert.equal(sync.status, 0, String(sync.stderr));
      const syncCapture = parseCapture({ stdout: String(sync.stdout), stderr: String(sync.stderr) });
      assert.deepEqual(syncCapture.args, LITERAL_ARGUMENTS);
      assert.equal(sameFilesystemPath(syncCapture.cwd, fixture.project), true);
    }
    assert.deepEqual(resolveExecutable(join("bin", "capture entry.mjs"), ["x"], env, { cwd: fixture.project }), { command: process.execPath, args: [entry, "x"], via: "node" });
  } finally { fixture.cleanup(); }
});

void test("npm resolves from an isolated PATH to its Node entrypoint with a distinct child cwd", async () => {
  const fixture = createProcessFixture();
  try {
    const resolved = resolveExecutable("npm", ["--version"], fixture.env, { cwd: fixture.project });
    assert.equal(resolved.via, windows ? "node" : "executable");
    if (windows) {
      assert.equal(resolved.command, process.execPath);
      assert.match(resolved.args[0] ?? "", /npm-cli\.js$/);
    }
    const outcome = await launch("npm", ["--version"], { cwd: fixture.project, env: fixture.env });
    assert.equal(outcome.error, undefined, outcome.stderr);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.match(outcome.stdout.trim(), /^\d+\.\d+\.\d+/);
  } finally { fixture.cleanup(); }
});

void test("Windows PATH resolution honors quoted entries, key casing aliases, PATHEXT, junctions and real executables", async () => {
  if (!windows) return;
  const fixture = createProcessFixture();
  try {
    const quoted = join(fixture.root, "tools; with semicolon & (parens)");
    const entry = fixture.writeCapture("capture.mjs", quoted);
    fixture.writeNpmShim(quoted, "pi role", entry);
    const nativeDirectory = join(fixture.root, "native bin");
    fixture.linkNodeExecutable(nativeDirectory, "node copy.exe");
    const junction = join(fixture.root, "junction bin");
    symlinkSync(nativeDirectory, junction, "junction");
    const inherited = fixture.env.PATH ?? "";
    // Node keeps the lexicographically first duplicate key ("PATH" < "Path"); the resolver must agree.
    const env: NodeJS.ProcessEnv = { ...withoutEnvKey(withoutEnvKey(fixture.env, "PATH"), "PATHEXT"), Path: join(fixture.root, "missing"), PATH: `"${quoted}";${junction};${inherited}`, pAtHeXt: ".exe;.CMD" };
    const shim = await launch("PI ROLE", LITERAL_ARGUMENTS, { cwd: fixture.project, env });
    assert.equal(shim.error, undefined, shim.stderr);
    assert.equal(shim.code, 0, shim.stderr);
    assert.deepEqual(parseCapture(shim).args, LITERAL_ARGUMENTS);
    const native = resolveExecutable("node copy", [entry], env, { cwd: fixture.project });
    assert.equal(native.via, "executable");
    assert.equal(sameFilesystemPath(native.command, join(nativeDirectory, "node copy.exe")), true);
    const executed = await launch("node copy", [entry, ...LITERAL_ARGUMENTS], { cwd: fixture.project, env });
    assert.equal(executed.error, undefined, executed.stderr);
    assert.deepEqual(parseCapture(executed).args, LITERAL_ARGUMENTS);
    const sync = spawnSyncExecutable("pi role", ["a b"], { cwd: fixture.project, env, encoding: "utf8", windowsHide: true });
    assert.equal(sync.status, 0, String(sync.stderr));
    assert.deepEqual(parseCapture({ stdout: String(sync.stdout), stderr: "" }).args, ["a b"]);
  } finally { fixture.cleanup(); }
});

void test("Windows non-shim batch files require an explicit launch and then receive literal arguments", async () => {
  if (!windows) return;
  const fixture = createProcessFixture();
  try {
    const directory = join(fixture.root, "batch dir & more");
    const entry = fixture.writeCapture("capture.mjs", directory);
    const batch = fixture.writeBatchForwarder(directory, "forward tool", entry);
    const injected = join(fixture.root, "injected.txt");
    const hostile = [...LITERAL_ARGUMENTS, `& echo pwned > "${injected}"`, "\" & echo pwned > injected.txt & \"", "100%", "%%", "^^", "!PIEWF_FORWARD_NODE!"];
    const env = { ...fixture.env, PATH: `${directory};${fixture.env.PATH ?? ""}` };
    assert.throws(() => resolveExecutable("forward tool", hostile, env, { cwd: fixture.project }), (error: NodeJS.ErrnoException) => error.code === "EINVAL");
    const rejected = await launch("forward tool", hostile, { cwd: fixture.project, env });
    assert.equal(rejected.error?.code, "EINVAL");
    assert.equal(rejected.child, undefined);
    const rejectedSync = spawnSyncExecutable("forward tool", hostile, { cwd: fixture.project, env, encoding: "utf8" });
    assert.equal((rejectedSync.error as NodeJS.ErrnoException | undefined)?.code, "EINVAL");
    assert.equal(rejectedSync.status, null);
    const resolved = resolveExecutable("forward tool", hostile, env, { cwd: fixture.project, allowBatchFile: true });
    assert.equal(resolved.via, "batch");
    assert.equal(resolved.windowsVerbatimArguments, true);
    const outcome = await launch("forward tool", hostile, { cwd: fixture.project, env }, { allowBatchFile: true });
    assert.equal(outcome.error, undefined, outcome.stderr);
    assert.equal(outcome.code, 0, outcome.stderr);
    const capture = parseCapture(outcome);
    assert.deepEqual(capture.args, hostile);
    assert.equal(sameFilesystemPath(capture.cwd, fixture.project), true);
    const sync = spawnSyncExecutable(batch, hostile, { cwd: fixture.project, env, encoding: "utf8", windowsHide: true }, { allowBatchFile: true });
    assert.equal(sync.status, 0, String(sync.stderr));
    assert.deepEqual(parseCapture({ stdout: String(sync.stdout), stderr: "" }).args, hostile);
    assert.equal(existsSync(injected), false);
    assert.equal(existsSync(join(fixture.project, "injected.txt")), false);
    assert.throws(() => resolveExecutable(batch, ["line\nbreak"], env, { allowBatchFile: true }), (error: NodeJS.ErrnoException) => error.code === "EINVAL");
  } finally { fixture.cleanup(); }
});

function posixQuote(value: string): string { return `'${value.split("'").join("'\\''")}'`; }

void test("intentional shell launches keep appended arguments literal", async () => {
  const fixture = createProcessFixture();
  try {
    const entry = fixture.writeCapture("capture.mjs");
    const command = windows ? `"${process.execPath}" "${entry}"` : `${posixQuote(process.execPath)} ${posixQuote(entry)}`;
    const outcome = await launch(command, LITERAL_ARGUMENTS, { cwd: fixture.project, env: fixture.env }, { kind: "shell" });
    assert.equal(outcome.error, undefined, outcome.stderr);
    assert.equal(outcome.code, 0, outcome.stderr);
    assert.deepEqual(parseCapture(outcome).args, LITERAL_ARGUMENTS);
  } finally { fixture.cleanup(); }
});

void test("launch errors stay distinguishable from nonzero exits for async and sync launches", async () => {
  const fixture = createProcessFixture();
  try {
    fixture.writeCapture("capture.mjs");
    const env = { ...fixture.env, CAPTURE_EXIT: "7", CAPTURE_STDERR: "failed on purpose" };
    const failed = await launch("./capture.mjs", [], { cwd: fixture.project, env });
    assert.equal(failed.error, undefined);
    assert.equal(failed.code, 7);
    assert.equal(failed.stderr, "failed on purpose");
    const missing = await launch("piewf-definitely-missing-command", ["x"], { cwd: fixture.project, env });
    assert.equal(missing.error?.code, "ENOENT");
    const missingNode = await launch("missing entry.mjs", [], { cwd: fixture.project, env }, { kind: "node" });
    assert.equal(missingNode.error?.code, "ENOENT");
    assert.equal(missingNode.child, undefined);
    const failedSync = spawnSyncExecutable("./capture.mjs", [], { cwd: fixture.project, env, encoding: "utf8" });
    assert.equal(failedSync.error, undefined);
    assert.equal(failedSync.status, 7);
    const missingSync = spawnSyncExecutable("piewf-definitely-missing-command", [], { cwd: fixture.project, env, encoding: "utf8" });
    assert.equal((missingSync.error as NodeJS.ErrnoException | undefined)?.code, "ENOENT");
    assert.equal(missingSync.status, null);
    const missingNodeSync = spawnSyncExecutable("missing entry.mjs", [], { cwd: fixture.project, env, encoding: "utf8" }, { kind: "node" });
    assert.equal((missingNodeSync.error as NodeJS.ErrnoException | undefined)?.code, "ENOENT");
    assert.equal(missingNodeSync.stdout, "");
  } finally { fixture.cleanup(); }
});

async function assertOwnedTreeStopped(reason: "timeout" | "cancelled"): Promise<void> {
  const fixture = createProcessFixture();
  const sentinel = spawnSentinel(fixture.env);
  try {
    fixture.writeCapture("capture.mjs");
    const pidFile = join(fixture.root, "grandchild.pid");
    const controller = new AbortController();
    const env = { ...fixture.env, CAPTURE_HANG: "1", CAPTURE_GRANDCHILD_PID_FILE: pidFile };
    const pending = launch("./capture.mjs", [], { cwd: fixture.project, env }, undefined, reason === "timeout" ? { timeoutMs: 3_000 } : { signal: controller.signal });
    assert.equal(await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, "utf8") !== ""), true);
    const grandchild = readPid(pidFile);
    assert.equal(isProcessAlive(grandchild), true);
    if (reason === "cancelled") controller.abort();
    const outcome = await pending;
    const child = outcome.child as ChildProcess;
    assert.equal(outcome.stopped, reason);
    assert.equal(outcome.error, undefined);
    assert.notEqual(child.exitCode ?? child.signalCode, null);
    assert.equal(await waitFor(() => !isProcessAlive(grandchild)), true, `grandchild ${String(grandchild)} survived`);
    assert.equal(isProcessAlive(sentinel.pid ?? -1), true);
    // An exited child is never tree-killed again on Windows: its PID may already belong to an unrelated process.
    if (windows) assert.equal(await terminateProcessTree(child, "SIGTERM"), false);
    assert.deepEqual(await stopProcessTree(child), { exited: true, terminated: false });
    assert.equal(isProcessAlive(sentinel.pid ?? -1), true);
  } finally {
    sentinel.kill();
    await waitFor(() => sentinel.exitCode !== null || sentinel.signalCode !== null);
    fixture.cleanup();
  }
}

void test("timeouts stop only the owned process tree and wait for exit", async () => { await assertOwnedTreeStopped("timeout"); });
void test("cancellation stops only the owned process tree and waits for exit", async () => { await assertOwnedTreeStopped("cancelled"); });

void test("findExecutable and relative PATH entries resolve against the child cwd", () => {
  const fixture = createProcessFixture();
  try {
    const entry = fixture.writeCapture(join("local bin", windows ? "tool.exe" : "tool"));
    // PATHEXT is pinned lowercase: the resolver appends configured extensions verbatim and paths.ts does not fold case aliases.
    const env = { ...withoutEnvKey(withoutEnvKey(fixture.env, "PATH"), "PATHEXT"), PATH: "local bin", PATHEXT: ".exe" };
    assert.equal(findExecutable("tool", env, fixture.project), resolvePath(entry));
  } finally { fixture.cleanup(); }
});
