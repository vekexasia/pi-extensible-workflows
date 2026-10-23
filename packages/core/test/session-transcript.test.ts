import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { observeSessionTranscriptReads, openSessionTranscript, type TranscriptRecord, type TranscriptSource } from "../src/session-transcript.js";
import type { WorkflowAgentSessionReference } from "../src/types.js";

const root = mkdtempSync(join(tmpdir(), "pi-session-transcript-"));
const defaultAgentDir = join(root, "default-agent");
process.env.PI_CODING_AGENT_DIR = defaultAgentDir;
process.on("exit", () => { rmSync(root, { recursive: true, force: true }); });
let fixtureCount = 0;
function fixture(): string { fixtureCount += 1; return mkdtempSync(join(root, `case-${String(fixtureCount)}-`)); }

function headerLine(id: string): string { return JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-10-15T00:00:00.000Z", cwd: "/repo" }); }
function reference(sessionFile: string, sessionId = "session-1", transport = "local"): WorkflowAgentSessionReference { return { transport, sessionId, locator: { sessionFile } }; }
function message(index: number, text = `message ${String(index)}`): string { return JSON.stringify({ type: "message", id: `m${String(index)}`, message: { role: "user", content: text } }); }

interface Line { readonly bytes: number; readonly text: string }
function completeLines(content: Buffer): Line[] {
  const lines: Line[] = [];
  let start = 0;
  for (let index = content.indexOf(10); index !== -1; index = content.indexOf(10, start)) {
    lines.push({ bytes: index - start, text: content.subarray(start, index).toString("utf8") });
    start = index + 1;
  }
  return lines;
}
function span(record: TranscriptRecord): { bytes: number } { return { bytes: record.bytes }; }

async function everyRecord(source: TranscriptSource): Promise<TranscriptRecord[]> {
  const first = await source.poll();
  assert.equal(first.status, "available", first.reason);
  return [...first.appended];
}

void test("the first poll returns each complete line of the file exactly once", async () => {
  const directory = fixture();
  const path = join(directory, "session.jsonl");
  const body = [headerLine("session-1"), message(1), message(2, "x".repeat(90)), "", message(3, "é😀 multibyte"), message(4, "y".repeat(300)), "not json", message(5), message(6, "z".repeat(40))];
  writeFileSync(path, `${body.join("\n")}\n${message(7).slice(0, 10)}`);
  const content = Buffer.from(`${body.join("\n")}\n`);
  const lines = completeLines(content);
  const source = openSessionTranscript(reference(path));
  try {
    const records = await everyRecord(source);
    assert.deepEqual(records.map(span), lines.map(({ bytes }) => ({ bytes })));
    for (const [index, record] of records.entries()) {
      let parsed: unknown;
      try { parsed = JSON.parse(lines[index]?.text ?? ""); } catch { parsed = undefined; }
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) assert.equal(record.kind, "entry");
      else assert.equal(record.kind, "unreadable");
    }
  } finally { await source.close(); }
});

void test("a trailing line without a newline is held back until it is complete", async () => {
  const path = join(fixture(), "session.jsonl");
  const line = message(2);
  writeFileSync(path, `${headerLine("session-1")}\n${message(1)}\n${line.slice(0, 12)}`);
  const source = openSessionTranscript(reference(path));
  try {
    const first = await source.poll();
    assert.equal(first.status, "available");
    assert.equal(first.reset, false);
        assert.deepEqual(first.appended.map((record) => record.kind), ["entry", "entry"]);
    assert.deepEqual((await source.poll()).appended, []);
    appendFileSync(path, line.slice(12, 20));
    assert.deepEqual((await source.poll()).appended, []);
    appendFileSync(path, `${line.slice(20)}\n${message(3).slice(0, 5)}`);
    const completed = await source.poll();
    assert.deepEqual(completed, { status: "available", reset: false, appended: [{ kind: "entry", bytes: Buffer.byteLength(line), value: JSON.parse(line) as unknown }] });
  } finally { await source.close(); }
});

void test("a line over 4 MiB is an entry of the first poll, as Pi reads it", async () => {
  const path = join(fixture(), "session.jsonl");
  const line = message(1, "z".repeat(4 * 1024 * 1024 + 1));
  writeFileSync(path, `${headerLine("session-1")}\n${line}\n${message(2)}\n`);
  const source = openSessionTranscript(reference(path));
  try {
    const first = await source.poll();
    assert.deepEqual(first.appended.map((record) => record.kind), ["entry", "entry", "entry"]);
    assert.equal(first.appended[1]?.bytes, Buffer.byteLength(line));
    const appended = message(3, "a".repeat(5 * 1024 * 1024));
    appendFileSync(path, appended.slice(0, 600));
    assert.deepEqual((await source.poll()).appended, []);
    appendFileSync(path, `${appended.slice(600)}\n`);
    assert.deepEqual((await source.poll()).appended.map((record) => record.kind), ["entry"]);
  } finally { await source.close(); }
});

void test("unreadable lines are marked, not dropped", async () => {
  const path = join(fixture(), "session.jsonl");
  writeFileSync(path, `${[headerLine("session-1"), "{broken", "[1,2]", "\"text\"", "null", "42", message(1)].join("\n")}\n`);
  const source = openSessionTranscript(reference(path));
  try {
    const first = await source.poll();
    assert.deepEqual(first.appended.map((record) => record.kind), ["entry", "unreadable", "unreadable", "unreadable", "unreadable", "unreadable", "entry"]);
    const lines = completeLines(readFileSync(path));
    assert.deepEqual(first.appended.slice(1, -1), lines.slice(1, -1).map(({ bytes }) => ({ kind: "unreadable", bytes })));
  } finally { await source.close(); }
});

void test("a shrunken file resets to the whole re-validated file", async () => {
  const path = join(fixture(), "session.jsonl");
  writeFileSync(path, `${headerLine("session-1")}\n${message(1)}\n${message(2)}\n`);
  const source = openSessionTranscript(reference(path));
  try {
    assert.equal((await source.poll()).appended.length, 3);
    const inode = statSync(path).ino;
    writeFileSync(path, `${headerLine("session-1")}\n${message(9)}\n`);
    assert.equal(statSync(path).ino, inode);
    const reset = await source.poll();
    assert.equal(reset.status, "available");
    assert.equal(reset.reset, true);
    assert.deepEqual(reset.appended.map((record) => record.kind === "entry" ? record.value.id : record.kind), ["session-1", "m9"]);
    appendFileSync(path, `${message(10)}\n`);
    const next = await source.poll();
    assert.equal(next.reset, false);
    assert.deepEqual(next.appended.map((record) => record.kind === "entry" ? record.value.id : record.kind), ["m10"]);
  } finally { await source.close(); }
});

void test("another file renamed over the path resets, and a foreign one is unavailable without returning its records", async () => {
  const directory = fixture();
  const path = join(directory, "session.jsonl");
  writeFileSync(path, `${headerLine("session-1")}\n${message(1)}\n`);
  const source = openSessionTranscript(reference(path));
  try {
    assert.equal((await source.poll()).appended.length, 2);
    const replacement = join(directory, "replacement.jsonl");
    writeFileSync(replacement, `${headerLine("session-1")}\n${message(1)}\n${message(2)}\n${message(3)}\n`);
    renameSync(replacement, path);
    const renamed = await source.poll();
    assert.equal(renamed.status, "available");
    assert.equal(renamed.reset, true);
    assert.deepEqual(renamed.appended.map((record) => record.kind === "entry" ? record.value.id : record.kind), ["session-1", "m1", "m2", "m3"]);
    const foreign = join(directory, "foreign.jsonl");
    writeFileSync(foreign, `${headerLine("session-2")}\n${message(1)}\n${message(2)}\n${message(3)}\n${message(4)}\n`);
    renameSync(foreign, path);
    const rejected = await source.poll();
    assert.equal(rejected.status, "unavailable");
    assert.equal(rejected.reset, true);
    assert.deepEqual(rejected.appended, []);
    assert.match(rejected.reason ?? "", /session/);
    const again = await source.poll();
    assert.equal(again.status, "unavailable");
    assert.equal(again.reset, false);
    assert.deepEqual(again.appended, []);
    rmSync(path);
    const missing = await source.poll();
    assert.equal(missing.status, "waiting");
    assert.equal(missing.reset, false);
    writeFileSync(path, `${headerLine("session-1")}\n${message(5)}\n`);
    const back = await source.poll();
    assert.equal(back.status, "available");
    assert.deepEqual(back.appended.map((record) => record.kind === "entry" ? record.value.id : record.kind), ["session-1", "m5"]);
  } finally { await source.close(); }
});

void test("a removed path resets to waiting", async () => {
  const path = join(fixture(), "session.jsonl");
  writeFileSync(path, `${headerLine("session-1")}\n`);
  const source = openSessionTranscript(reference(path));
  try {
    assert.equal((await source.poll()).status, "available");
    rmSync(path);
    assert.deepEqual(await source.poll(), { status: "waiting", reset: true, appended: [] });
  } finally { await source.close(); }
});

void test("later reads go through the validated descriptor", { skip: process.getuid?.() === 0 }, async () => {
  const path = join(fixture(), "session.jsonl");
  writeFileSync(path, `${headerLine("session-1")}\n${message(1)}\n`);
  const source = openSessionTranscript(reference(path));
  try {
    assert.equal((await source.poll()).status, "available");
    chmodSync(path, 0o200);
    appendFileSync(path, `${message(2)}\n`);
    const next = await source.poll();
    assert.equal(next.status, "available");
    assert.deepEqual(next.appended.map((record) => record.kind === "entry" ? record.value.id : record.kind), ["m2"]);
  } finally { chmodSync(path, 0o600); await source.close(); }
});

function userMessage(text: string): Parameters<SessionManager["appendMessage"]>[0] { return { role: "user", content: [{ type: "text", text }], timestamp: Date.now() }; }
function managerReference(manager: SessionManager, transport = "local"): WorkflowAgentSessionReference {
  const sessionFile = manager.getSessionFile();
  assert.ok(sessionFile);
  return { transport, sessionId: manager.getSessionId(), locator: { sessionFile } };
}
function sessionFileOf(sessionReference: WorkflowAgentSessionReference): string {
  const locator = sessionReference.locator;
  assert.ok(typeof locator === "object" && locator !== null && !Array.isArray(locator) && typeof locator.sessionFile === "string");
  return locator.sessionFile;
}
async function assertPiSession(sessionReference: WorkflowAgentSessionReference, texts: readonly string[]): Promise<void> {
  const source = openSessionTranscript(sessionReference);
  try {
    const poll = await source.poll();
    assert.equal(poll.status, "available", poll.reason);
    const [header, ...rest] = poll.appended;
    assert.ok(header?.kind === "entry");
    assert.equal(header.value.type, "session");
    assert.equal(header.value.id, sessionReference.sessionId);
    const shown = rest.flatMap((record) => {
      if (record.kind !== "entry" || record.value.type !== "message") return [];
      const value = record.value.message as { content: { text: string }[] };
      return value.content.map(({ text }) => text);
    });
    assert.deepEqual(shown, texts);
  } finally { await source.close(); }
}

void test("real pi session files: default location, agentDir sessions, custom path, attempt copy and herdr transport", async () => {
  const directory = fixture();
  const cwd = join(directory, "project");
  const agentDir = join(directory, "agent");

  const defaultManager = SessionManager.create(cwd);
  defaultManager.appendSessionInfo("workflow:agent:attempt-1");
  const defaultReference = managerReference(defaultManager);
  const lazy = openSessionTranscript(defaultReference);
  try { assert.equal((await lazy.poll()).status, "waiting"); } finally { await lazy.close(); }
  defaultManager.appendMessage(userMessage("default location"));
  assert.equal(dirname(dirname(sessionFileOf(defaultReference))), join(defaultAgentDir, "sessions"));
  await assertPiSession(defaultReference, ["default location"]);

  const agentManager = SessionManager.create(cwd, join(agentDir, "sessions"));
  agentManager.appendSessionInfo("workflow:agent:attempt-1");
  agentManager.appendMessage(userMessage("agent directory"));
  const agentReference = managerReference(agentManager);
  await assertPiSession(agentReference, ["agent directory"]);
  await assertPiSession({ ...agentReference, transport: "herdr" }, ["agent directory"]);

  const customPath = join(directory, "session-without-extension");
  const customManager = SessionManager.open(customPath, join(agentDir, "sessions"), cwd);
  customManager.appendMessage(userMessage("custom path"));
  const customReference = managerReference(customManager);
  assert.equal(sessionFileOf(customReference), customPath);
  await assertPiSession(customReference, ["custom path"]);

  const source = sessionFileOf(agentReference);
  const attemptPath = join(dirname(source), `${basename(source, ".jsonl")}-attempt-2.jsonl`);
  copyFileSync(source, attemptPath);
  const attemptManager = SessionManager.open(attemptPath, join(agentDir, "sessions"), cwd);
  attemptManager.appendMessage(userMessage("second attempt"));
  const attemptReference = managerReference(attemptManager);
  assert.equal(attemptReference.sessionId, agentReference.sessionId);
  await assertPiSession(attemptReference, ["agent directory", "second attempt"]);
  await assertPiSession({ ...attemptReference, transport: "herdr" }, ["agent directory", "second attempt"]);
});

async function settled(promise: Promise<unknown>): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => { reject(new Error("call did not return")); }, 5000); })]); } finally { clearTimeout(timer); }
}

void test("files without a matching pi session header are unavailable", async () => {
  const directory = fixture();
  const cases: [string, string][] = [["no-header.jsonl", `${message(1)}\n`], ["foreign.jsonl", `${headerLine("session-2")}\n${message(1)}\n`], ["not-json.jsonl", "garbage\n"], ["no-id.jsonl", `${JSON.stringify({ type: "session" })}\n`]];
  for (const [name, content] of cases) {
    const path = join(directory, name);
    writeFileSync(path, content);
    const source = openSessionTranscript(reference(path));
    try {
      const poll = await source.poll();
      assert.equal(poll.status, "unavailable", name);
      assert.deepEqual(poll.appended, []);
      assert.ok(poll.reason, name);
    } finally { await source.close(); }
  }
});

void test("a directory and a FIFO are unavailable, a symlink to a session file is read as the file", async () => {
  const directory = fixture();
  const targets: string[] = [directory];
  if (process.platform !== "win32") {
    const fifo = join(directory, "fifo.jsonl");
    assert.equal(spawnSync("mkfifo", [fifo]).status, 0);
    targets.push(fifo);
  }
  for (const path of targets) {
    const source = openSessionTranscript(reference(path));
    const poll = await settled(source.poll()) as Awaited<ReturnType<TranscriptSource["poll"]>>;
    assert.equal(poll.status, "unavailable", path);
    assert.ok(poll.reason, path);
    await settled(source.close());
    await settled(source.close());
  }
  if (process.platform === "win32") return;
  const real = join(directory, "real.jsonl");
  writeFileSync(real, `${headerLine("session-1")}\n`);
  const link = join(directory, "link.jsonl");
  symlinkSync(real, link);
  const source = openSessionTranscript(reference(link));
  try { assert.equal((await source.poll()).status, "available"); } finally { await source.close(); }
});

void test("missing, unset and incomplete session files are waiting", async () => {
  const directory = fixture();
  for (const sessionReference of [undefined, { transport: "local", sessionId: "session-1" }, { transport: "local", sessionId: "session-1", locator: { sessionFile: "" } }, { transport: "local", sessionId: "session-1", locator: "file" }, reference(join(directory, "missing", "session.jsonl"))]) {
    const source = openSessionTranscript(sessionReference);
    assert.deepEqual(await source.poll(), { status: "waiting", reset: false, appended: [] });
    await source.close();
  }
  const path = join(directory, "session.jsonl");
  writeFileSync(path, "");
  const source = openSessionTranscript(reference(path));
  try {
    assert.equal((await source.poll()).status, "waiting");
    appendFileSync(path, headerLine("session-1").slice(0, 20));
    assert.equal((await source.poll()).status, "waiting");
    appendFileSync(path, `${headerLine("session-1").slice(20)}\n`);
    const ready = await source.poll();
    assert.equal(ready.status, "available");
    assert.equal(ready.reset, false);
    assert.equal(ready.appended.length, 1);
  } finally { await source.close(); }
});

void test("a first line without a newline is waiting up to 1 MiB and unavailable beyond it", async () => {
  const directory = fixture();
  const exact = join(directory, "exact.jsonl");
  writeFileSync(exact, "x".repeat(1024 * 1024));
  const atLimit = openSessionTranscript(reference(exact));
  try { assert.equal((await atLimit.poll()).status, "waiting"); } finally { await atLimit.close(); }
  const over = join(directory, "over.jsonl");
  writeFileSync(over, "x".repeat(1024 * 1024 + 1));
  const beyond = openSessionTranscript(reference(over));
  try {
    const poll = await beyond.poll();
    assert.equal(poll.status, "unavailable");
    assert.match(poll.reason ?? "", /longer than 1 MiB/);
    assert.deepEqual(poll.appended, []);
  } finally { await beyond.close(); }
});

void test("close makes later calls unavailable", async () => {
  const path = join(fixture(), "session.jsonl");
  writeFileSync(path, `${headerLine("session-1")}\n${message(1)}\n`);
  const source = openSessionTranscript(reference(path));
  assert.equal((await source.poll()).status, "available");
  await source.close();
  const after = await source.poll();
  assert.equal(after.status, "unavailable");
  assert.deepEqual(after.appended, []);
  await source.close();
  const never = openSessionTranscript(reference(path));
  await never.close();
  assert.equal((await never.poll()).status, "unavailable");
});

void test("a poll of an unchanged file reads nothing", async () => {
  const path = join(fixture(), "session.jsonl");
  writeFileSync(path, `${headerLine("session-1")}\n${message(1)}\n`);
  const source = openSessionTranscript(reference(path));
  let bytes = 0;
  try {
    await source.poll();
    observeSessionTranscriptReads((count) => { bytes += count; });
    const poll = await source.poll();
    assert.equal(poll.reset, false);
    assert.deepEqual(poll.appended, []);
    assert.equal(bytes, 0);
  } finally { observeSessionTranscriptReads(undefined); await source.close(); }
});

void test("a poll after a one-line append reads the growth, not the file", async () => {
  const path = join(fixture(), "session.jsonl");
  const big = "x".repeat(40_000);
  writeFileSync(path, `${headerLine("session-1")}\n${Array.from({ length: 200 }, (_, index) => message(index, big)).join("\n")}\n`);
  const source = openSessionTranscript(reference(path));
  let bytes = 0;
  try {
    await source.poll();
    const line = `${message(500)}\n`;
    appendFileSync(path, line);
    observeSessionTranscriptReads((count) => { bytes += count; });
    const poll = await source.poll();
    assert.equal(poll.appended.length, 1);
    assert.equal(bytes, Buffer.byteLength(line));
  } finally { observeSessionTranscriptReads(undefined); await source.close(); }
});
