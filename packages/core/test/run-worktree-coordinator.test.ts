import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { RunWorktreeCoordinator } from "../src/run-worktree-coordinator.js";
import { canonicalPath } from "../src/paths.js";

function barrier() { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "run-coordinator-")), path = join(root, "runs", "run");
  return { root, path, coordinator: new RunWorktreeCoordinator(path) };
}
function claimPath(path: string) { const namespace = join(dirname(path), ".worktree-transactions"); const name = readdirSync(namespace)[0]; assert.ok(name); return join(namespace, name); }
const unproven = (error: unknown) => error instanceof Error && "cleanupUnproven" in error && error.cleanupUnproven === true;

void test("run coordinator serializes instances and cancels a queued waiter without draining its holder", async () => {
  const f = fixture(), entered = barrier(), release = barrier();
  const order: number[] = [];
  const first = f.coordinator.run(undefined, async () => { order.push(1); entered.release(); await release.promise; });
  await entered.promise;
  const controller = new AbortController();
  const cancelled = new RunWorktreeCoordinator(f.path).run(controller.signal, async () => { order.push(2); });
  const rejected = assert.rejects(cancelled, { code: "CANCELLED" });
  const third = new RunWorktreeCoordinator(f.path).run(undefined, async () => { order.push(3); });
  controller.abort(); await rejected;
  assert.deepEqual(order, [1]);
  release.release(); await Promise.all([first, third]);
  assert.deepEqual(order, [1, 3]);
  assert.deepEqual(readdirSync(join(dirname(f.path), ".worktree-transactions")), []);
  rmSync(f.root, { recursive: true, force: true });
});

void test("separately loaded coordinator graphs share the process FIFO", async () => {
  const f = fixture(), entered = barrier(), release = barrier();
  const alternate = await import(`${new URL("../src/run-worktree-coordinator.js", import.meta.url).href}?separate-graph` ) as { RunWorktreeCoordinator: typeof RunWorktreeCoordinator };
  let secondEntered = false;
  const first = f.coordinator.run(undefined, async () => { entered.release(); await release.promise; });
  await entered.promise;
  const controller = new AbortController();
  const second = new alternate.RunWorktreeCoordinator(f.path).run(controller.signal, async () => { secondEntered = true; });
  const rejected = assert.rejects(second, { code: "CANCELLED" });
  controller.abort(); await rejected;
  assert.equal(secondEntered, false);
  release.release(); await first;
  rmSync(f.root, { recursive: true, force: true });
});

void test("independent process claim queues, admits cancellation, then releases only its own claim", async (t) => {
  const f = fixture();
  const source = new URL("../src/run-worktree-coordinator.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `import {RunWorktreeCoordinator} from ${JSON.stringify(source)}; await new RunWorktreeCoordinator(${JSON.stringify(f.path)}).run(undefined, async () => {process.send('ready');await new Promise(resolve => process.once('message', resolve));});process.disconnect();`], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.diagnostic(`owned coordinator child pid=${String(child.pid)} command=${process.execPath} --input-type=module -e`);
  let stderr = ""; child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => { if (code === 0) resolve(); else reject(new Error(`Child exited ${String(code)}: ${stderr}`)); }); });
  try {
    await Promise.race([new Promise<void>((resolve) => { child.once("message", () => { resolve(); }); }), closed.then(() => { throw new Error("Child exited before admission"); })]);
    const owner = join(claimPath(f.path), "owner.json"), bytes = readFileSync(owner), inode = statSync(owner).ino;
    const controller = new AbortController(), contended = barrier(), originalMkdir = fs.mkdir.bind(fs);
    t.mock.method(fs, "mkdir", (async (...args: Parameters<typeof fs.mkdir>) => {
      try { return await originalMkdir(...args); }
      catch (error) { if (String(args[0]) === canonicalPath(dirname(owner))) contended.release(); throw error; }
    }) as typeof fs.mkdir); syncBuiltinESMExports();
    const waiting = f.coordinator.run(controller.signal, async () => { assert.fail("cancelled cross-process waiter entered"); });
    const rejected = assert.rejects(waiting, { code: "CANCELLED" });
    await contended.promise; controller.abort(); await rejected;
    assert.deepEqual(readFileSync(owner), bytes); assert.equal(statSync(owner).ino, inode);
    let entered = false;
    const next = f.coordinator.run(undefined, async () => { entered = true; });
    child.send("release"); await closed; await next; assert.equal(entered, true);
  } finally { if (child.connected) child.send("release"); await closed; t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const phase of ["initialization", "release"] as const) void test(`independent process delayed ${phase} never poisons a healthy queue`, async (t) => {
  const f = fixture();
  const source = new URL("../src/run-worktree-coordinator.js", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import fs from 'node:fs/promises';
    import {syncBuiltinESMExports} from 'node:module';
    const commands = new Set(), waiting = new Map();
    process.on('message', name => { const resolve = waiting.get(name); if (resolve) {waiting.delete(name); resolve();} else commands.add(name); });
    const wait = name => commands.delete(name) ? Promise.resolve() : new Promise(resolve => waiting.set(name, resolve));
    const phase = ${JSON.stringify(phase)};
    const pause = async () => {process.send('paused'); await wait('continue');};
    const mkdir = fs.mkdir.bind(fs), unlink = fs.unlink.bind(fs);
    fs.mkdir = async (...args) => {const result = await mkdir(...args); if (phase === 'initialization' && String(args[0]).includes('/.worktree-transactions/') && !args[1]?.recursive) await pause(); return result;};
    fs.unlink = async (...args) => {const result = await unlink(...args); if (phase === 'release' && String(args[0]).endsWith('/owner.json')) await pause(); return result;};
    syncBuiltinESMExports();
    const {RunWorktreeCoordinator} = await import(${JSON.stringify(source)});
    await new RunWorktreeCoordinator(${JSON.stringify(f.path)}).run(undefined, async () => {process.send('held'); await wait('release');});
    process.disconnect();
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.diagnostic(`owned coordinator child pid=${String(child.pid)} phase=${phase} command=${process.execPath} --input-type=module -e`);
  let stderr = ""; child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
  const seen = new Set<string>(), messages = new Map<string, () => void>();
  child.on("message", (message) => { if (typeof message === "string") { seen.add(message); messages.get(message)?.(); } });
  const closed = new Promise<void>((resolve, reject) => { child.once("error", reject); child.once("exit", (code) => { if (code === 0) resolve(); else reject(new Error(`Child exited ${String(code)}: ${stderr}`)); }); });
  const message = (name: string) => Promise.race([seen.has(name) ? Promise.resolve() : new Promise<void>((resolve) => { messages.set(name, resolve); }), closed.then(() => { throw new Error(`Child exited before ${name}`); })]);
  try {
    if (phase === "release") { await message("held"); child.send("release"); }
    await message("paused");
    const path = claimPath(f.path), inode = statSync(path).ino;
    assert.equal(existsSync(join(path, "owner.json")), false);
    const controller = new AbortController();
    let settled = false;
    const waiting = f.coordinator.run(controller.signal, async () => { assert.fail("incomplete healthy claim admitted"); });
    const observed = waiting.finally(() => { settled = true; });
    void observed.catch(() => undefined);
    // Deliberately exceed the old one-observation grace period while the independent holder is paused.
    await delay(125);
    assert.equal(settled, false, "a healthy unpublished/releasing owner must remain queued");
    const rejected = assert.rejects(observed, (error: unknown) => error instanceof Error && "code" in error && error.code === "CANCELLED" && /unpublished|initializ|releas/i.test(error.message));
    controller.abort(); await rejected;
    assert.equal(statSync(path).ino, inode); assert.equal(existsSync(join(path, "owner.json")), false);
    let entered = false;
    const next = new RunWorktreeCoordinator(f.path).run(undefined, async () => { entered = true; });
    child.send("continue");
    if (phase === "initialization") { await message("held"); child.send("release"); }
    await closed; await next; assert.equal(entered, true);
    assert.deepEqual(readdirSync(join(dirname(f.path), ".worktree-transactions")), []);
  } finally {
    if (child.connected) { child.send("continue"); child.send("release"); }
    await closed; rmSync(f.root, { recursive: true, force: true });
  }
});

for (const mismatch of ["nonce", "inode"] as const) void test(`coordinator ${mismatch} mismatch retains claim and poisons every instance`, async () => {
  const f = fixture(); let owner = "", bytes = "";
  try {
    await assert.rejects(f.coordinator.run(undefined, async () => {
      owner = join(claimPath(f.path), "owner.json"); bytes = readFileSync(owner, "utf8");
      if (mismatch === "inode") { renameSync(owner, `${owner}.replaced`); writeFileSync(owner, bytes); }
      else writeFileSync(owner, bytes.replace(/"nonce":"[^"]+"/, '"nonce":"replacement"'));
    }), unproven);
    const after = readFileSync(owner, "utf8");
    await assert.rejects(new RunWorktreeCoordinator(f.path).run(undefined, async () => { assert.fail("retained claim admitted"); }), unproven);
    assert.equal(readFileSync(owner, "utf8"), after); assert.equal(existsSync(owner), true);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

void test("exclusive pending owner partial-write failure retains private bytes without publishing authority", async (t) => {
  const f = fixture(), original = fs.open.bind(fs);
  t.mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
    const file = await original(...args);
    if (String(args[0]).includes(".owner.json-") && String(args[0]).endsWith(".pending")) {
      const write = file.writeFile.bind(file);
      file.writeFile = (async () => { await write("{"); throw new Error("injected partial owner write"); });
    }
    return file;
  }) as typeof fs.open); syncBuiltinESMExports();
  try {
    await assert.rejects(f.coordinator.run(undefined, async () => { assert.fail("partial claim entered"); }), unproven);
    const path = claimPath(f.path), pending = readdirSync(path);
    assert.equal(pending.length, 1); const name = pending[0]; assert.ok(name); assert.match(name, /^\.owner\.json-.*\.pending$/);
    const material = join(path, name); assert.equal(readFileSync(material, "utf8"), "{");
    assert.equal(existsSync(join(path, "owner.json")), false);
    const inode = statSync(material).ino, directoryInode = statSync(path).ino;
    await assert.rejects(new RunWorktreeCoordinator(f.path).run(undefined, async () => undefined), unproven);
    assert.equal(readFileSync(material, "utf8"), "{"); assert.equal(statSync(material).ino, inode); assert.equal(statSync(path).ino, directoryInode);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const fault of ["sync", "close", "link", "unlink"] as const) void test(`owner ${fault} uncertainty retains its claim and known private material`, async (t) => {
  const f = fixture(), originalOpen = fs.open.bind(fs), originalLink = fs.link.bind(fs), originalUnlink = fs.unlink.bind(fs);
  t.mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
    const file = await originalOpen(...args);
    if (String(args[0]).endsWith(".pending")) {
      if (fault === "sync") file.sync = async () => { throw new Error("injected owner sync failure"); };
      if (fault === "close") { const close = file.close.bind(file); file.close = async () => { await close(); throw new Error("injected owner close failure"); }; }
    }
    return file;
  }) as typeof fs.open);
  t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => { if (fault === "link") throw new Error("injected owner link failure"); return originalLink(...args); });
  t.mock.method(fs, "unlink", async (...args: Parameters<typeof fs.unlink>) => { if (fault === "unlink" && String(args[0]).endsWith(".pending")) throw new Error("injected pending unlink failure"); return originalUnlink(...args); }); syncBuiltinESMExports();
  try {
    await assert.rejects(f.coordinator.run(undefined, async () => { assert.fail("uncertain claim entered"); }), unproven);
    const path = claimPath(f.path), pending = readdirSync(path).find((name) => name.endsWith(".pending")); assert.ok(pending);
    const material = join(path, pending), bytes = readFileSync(material), inode = statSync(material).ino;
    assert.equal((JSON.parse(bytes.toString()) as { state: string }).state, "active");
    assert.equal(existsSync(join(path, "owner.json")), fault === "unlink");
    await assert.rejects(new RunWorktreeCoordinator(f.path).run(undefined, async () => undefined), unproven);
    assert.deepEqual(readFileSync(material), bytes); assert.equal(statSync(material).ino, inode);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.root, { recursive: true, force: true }); }
});

void test("external unpublished crashed pending material waits abortably without being adopted or poisoned", async () => {
  const f = fixture(), hash = (await import("node:crypto")).createHash;
  mkdirSync(dirname(f.path), { recursive: true });
  const key = (await import("../src/paths.js")).canonicalDescendantPath(dirname(f.path), f.path);
  const path = join(dirname(f.path), ".worktree-transactions", hash("sha256").update(key).digest("hex")); mkdirSync(path, { recursive: true });
  const pending = join(path, ".owner.json-crashed.pending"); writeFileSync(pending, "{"); const inode = statSync(pending).ino;
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const waiting = f.coordinator.run(controller.signal, async () => { assert.fail("crashed pending adopted"); });
      const rejected = assert.rejects(waiting, (error: unknown) => error instanceof Error && "code" in error && error.code === "CANCELLED" && /unpublished.*explicit operator recovery/.test(error.message));
      await delay(75); controller.abort(); await rejected;
      assert.equal(readFileSync(pending, "utf8"), "{"); assert.equal(statSync(pending).ino, inode); assert.equal(existsSync(join(path, "owner.json")), false);
    }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

void test("retained claim is explicit on disk and guard capability expires", async () => {
  const f = fixture(); let expired: (() => void) | undefined, bytes = "", inode = 0;
  try {
    await assert.rejects(f.coordinator.run(undefined, async (guard) => {
      const owner = join(claimPath(f.path), "owner.json"); bytes = readFileSync(owner, "utf8"); inode = statSync(owner).ino;
      expired = () => { guard.assertCurrent(guard.runKey); }; guard.retain(new Error("retained rollback"));
    }), /retained rollback/);
    assert.throws(() => { expired?.(); }, /not current/);
    const path = claimPath(f.path), owner = join(path, "owner.json");
    assert.equal(readFileSync(owner, "utf8"), bytes); assert.equal(statSync(owner).ino, inode);
    const retained = JSON.parse(readFileSync(join(path, "retained.json"), "utf8")) as { key: string; nonce: string; directory: { dev: number; ino: number }; state: string };
    const active = JSON.parse(bytes) as { key: string; nonce: string };
    assert.equal(retained.state, "retained"); assert.equal(retained.key, active.key); assert.equal(retained.nonce, active.nonce);
    assert.deepEqual(retained.directory, { dev: statSync(path).dev, ino: statSync(path).ino });
    await assert.rejects(new RunWorktreeCoordinator(f.path).run(undefined, async () => undefined), /retained rollback/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

void test("partial retained publication preserves immutable owner and sticky original failure", async (t) => {
  const f = fixture(), original = fs.open.bind(fs), sticky = new Error("original retained transaction failure");
  let ownerBytes = "", ownerInode = 0;
  t.mock.method(fs, "open", (async (...args: Parameters<typeof fs.open>) => {
    const file = await original(...args);
    if (String(args[0]).includes(".retained.json-")) { const write = file.writeFile.bind(file); file.writeFile = async () => { await write("{"); throw new Error("partial retained write"); }; }
    return file;
  }) as typeof fs.open); syncBuiltinESMExports();
  try {
    await assert.rejects(f.coordinator.run(undefined, async (guard) => {
      const owner = join(claimPath(f.path), "owner.json"); ownerBytes = readFileSync(owner, "utf8"); ownerInode = statSync(owner).ino; guard.retain(sticky);
    }), (error: unknown) => unproven(error) && error instanceof Error && error.cause === sticky);
    const path = claimPath(f.path), owner = join(path, "owner.json"), pending = readdirSync(path).find((name) => name.startsWith(".retained.json-")); assert.ok(pending);
    assert.equal(readFileSync(owner, "utf8"), ownerBytes); assert.equal(statSync(owner).ino, ownerInode);
    assert.equal(readFileSync(join(path, pending), "utf8"), "{"); assert.equal(existsSync(join(path, "retained.json")), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.root, { recursive: true, force: true }); }
});

for (const published of [false, true]) void test(`explicit malformed retention blocks ${published ? "published" : "unpublished"} claims without mutation`, async () => {
  const f = fixture();
  const hash = (await import("node:crypto")).createHash;
  mkdirSync(dirname(f.path), { recursive: true });
  const key = (await import("../src/paths.js")).canonicalDescendantPath(dirname(f.path), f.path);
  const path = join(dirname(f.path), ".worktree-transactions", hash("sha256").update(key).digest("hex")); mkdirSync(path, { recursive: true });
  const retained = join(path, "retained.json"); writeFileSync(retained, "{"); const inode = statSync(retained).ino;
  const owner = join(path, "owner.json"), bytes = JSON.stringify({ version: 1, key, nonce: "external", state: "active" });
  if (published) writeFileSync(owner, bytes);
  try {
    await assert.rejects(f.coordinator.run(undefined, async () => { assert.fail("retention admitted"); }), /explicit recovery/);
    assert.equal(readFileSync(retained, "utf8"), "{"); assert.equal(statSync(retained).ino, inode);
    assert.equal(existsSync(owner), published); if (published) assert.equal(readFileSync(owner, "utf8"), bytes);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

void test("unexpected retained marker refuses healthy release without replacing owner or blocker", async () => {
  const f = fixture(); let path = "", ownerBytes = "", ownerInode = 0, retainedInode = 0;
  try {
    await assert.rejects(f.coordinator.run(undefined, async () => {
      path = claimPath(f.path); const owner = join(path, "owner.json"); ownerBytes = readFileSync(owner, "utf8"); ownerInode = statSync(owner).ino;
      const retained = join(path, "retained.json"); writeFileSync(retained, "external-retention"); retainedInode = statSync(retained).ino;
    }), unproven);
    assert.equal(readFileSync(join(path, "owner.json"), "utf8"), ownerBytes); assert.equal(statSync(join(path, "owner.json")).ino, ownerInode);
    assert.equal(readFileSync(join(path, "retained.json"), "utf8"), "external-retention"); assert.equal(statSync(join(path, "retained.json")).ino, retainedInode);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

void test("owner no-replace publication refuses EEXIST and preserves both private pending and foreign owner", async (t) => {
  const f = fixture(), original = fs.link.bind(fs); let foreignInode = 0;
  t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
    if (String(args[1]).endsWith("/owner.json")) { writeFileSync(String(args[1]), "foreign"); foreignInode = statSync(String(args[1])).ino; }
    return original(...args);
  }); syncBuiltinESMExports();
  try {
    await assert.rejects(f.coordinator.run(undefined, async () => { assert.fail("foreign owner adopted"); }), unproven);
    const path = claimPath(f.path), owner = join(path, "owner.json");
    assert.equal(readFileSync(owner, "utf8"), "foreign"); assert.equal(statSync(owner).ino, foreignInode);
    const pending = readdirSync(path).find((name) => name.endsWith(".pending")); assert.ok(pending);
    assert.equal((JSON.parse(readFileSync(join(path, pending), "utf8")) as { state: string }).state, "active");
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); rmSync(f.root, { recursive: true, force: true }); }
});

void test("canonical alias paths share one FIFO and retained poison", async () => {
  const f = fixture(), entered = barrier(), release = barrier();
  mkdirSync(dirname(f.path), { recursive: true });
  const alias = join(f.root, "alias"); symlinkSync(dirname(f.path), alias, "dir");
  const first = f.coordinator.run(undefined, async () => { entered.release(); await release.promise; });
  await entered.promise; const controller = new AbortController();
  try {
    const second = new RunWorktreeCoordinator(join(alias, "run")).run(controller.signal, async () => { assert.fail("canonical alias bypassed holder"); });
    const rejected = assert.rejects(second, { code: "CANCELLED" }); controller.abort(); await rejected;
  } finally { release.release(); await first; rmSync(f.root, { recursive: true, force: true }); }
});

for (const bytes of ["{", JSON.stringify({ version: 1, key: "wrong", nonce: "old", state: "active", pid: 2147483647, startedAt: 0 })]) void test(`external malformed/crashed claim is never reclaimed: ${bytes}`, async () => {
  const f = fixture();
  const hash = (await import("node:crypto")).createHash;
  mkdirSync(dirname(f.path), { recursive: true });
  const key = (await import("../src/paths.js")).canonicalDescendantPath(dirname(f.path), f.path);
  const path = join(dirname(f.path), ".worktree-transactions", hash("sha256").update(key).digest("hex")); mkdirSync(path, { recursive: true });
  const owner = join(path, "owner.json"); writeFileSync(owner, bytes); const inode = statSync(owner).ino;
  try {
    await assert.rejects(f.coordinator.run(undefined, async () => { assert.fail("unproven external claim entered"); }), /explicit recovery/);
    assert.equal(readFileSync(owner, "utf8"), bytes); assert.equal(statSync(owner).ino, inode);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
