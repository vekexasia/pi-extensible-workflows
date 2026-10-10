import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { processAlive } from "../src/session-lease.js";

const linux = { skip: process.platform === "linux" ? false : "needs /proc" };
const BTIME = 1_700_000_000;
const TICKS = 5_000;
const tickRate = Number(execFileSync("getconf", ["CLK_TCK"], { encoding: "utf8" }).trim());
const START_MS = BTIME * 1000 + (TICKS / tickRate) * 1000;

function fakeProc(comm: string, stat?: string): string {
  const root = mkdtempSync(join(tmpdir(), "fake-proc-"));
  writeFileSync(join(root, "stat"), `cpu 1 2 3\nbtime ${String(BTIME)}\n`);
  mkdirSync(join(root, String(process.pid)));
  const rest = ["S", ...Array.from({ length: 18 }, () => "0"), String(TICKS), "0"].join(" ");
  if (stat !== "missing") writeFileSync(join(root, String(process.pid), "stat"), stat ?? `${String(process.pid)} (${comm}) ${rest}\n`);
  return root;
}

void test("a pid started within the margin after the stamp is alive", linux, async () => {
  const root = fakeProc("node");
  try {
    assert.equal(await processAlive(process.pid, START_MS - 59_000, root), true);
    assert.equal(await processAlive(process.pid, START_MS - 61_000, root), false);
    assert.equal(await processAlive(process.pid, START_MS + 1, root), true);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

void test("command names with spaces and parentheses do not shift the start field", linux, async () => {
  const root = fakeProc(") (a b) (");
  try { assert.equal(await processAlive(process.pid, START_MS - 61_000, root), false); assert.equal(await processAlive(process.pid, START_MS, root), true); }
  finally { rmSync(root, { recursive: true, force: true }); }
});

void test("an unreadable or unparsable stat file leaves a signalable pid alive", linux, async () => {
  for (const stat of ["missing", "garbage"]) {
    const root = fakeProc("node", stat);
    try { assert.equal(await processAlive(process.pid, START_MS - 3_600_000, root), true); }
    finally { rmSync(root, { recursive: true, force: true }); }
  }
});

void test("a spawned child is alive against the running kernel when stamped after it started", linux, async () => {
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{},10000)"], { stdio: "ignore" });
  try {
    assert.ok(child.pid);
    assert.equal(await processAlive(child.pid, Date.now()), true);
    assert.equal(await processAlive(child.pid, Date.now() - 3_600_000), false);
  } finally { child.kill(); }
});
