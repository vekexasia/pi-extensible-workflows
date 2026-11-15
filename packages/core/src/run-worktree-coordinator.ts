import { createHash, randomUUID } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { canonicalDescendantPath } from "./paths.js";
import { WorkflowError } from "./types.js";
import { isNodeError } from "./utils.js";
import { OwnedCommandCleanupError } from "./owned-process.js";

type Identity = { dev: number; ino: number };
type Waiter = { enter: () => void; reject: (error: unknown) => void; signal: AbortSignal | undefined; abort: () => void };
type Queue = { busy: boolean; waiters: Waiter[]; poison?: Error };
const registryKey = Symbol.for("pi-extensible-workflows.run-worktree-transactions.v1");
const processRegistry = globalThis as typeof globalThis & Record<symbol, Map<string, Queue> | undefined>;
const queues = processRegistry[registryKey] ??= new Map<string, Queue>();
export const legacyWorktreeAdmission = Symbol("legacyWorktreeAdmission");
const sameIdentity = (left: Identity, right: Identity) => left.dev === right.dev && left.ino === right.ino;
const cancelled = () => new WorkflowError("CANCELLED", "Worktree transaction admission cancelled");
const recovery = (key: string) => new OwnedCommandCleanupError(`Worktree transaction requires explicit recovery: ${key}`);

/** An invocation-local capability. It must be passed explicitly, never inherited by asynchronous children. */
export interface RunWorktreeGuard {
  readonly runKey: string;
  assertCurrent(runKey: string): void;
  retain(error: Error): void;
}

/**
 * Private worktree-inventory fence, not a state.json/journal lock. Upgrade requires old writers stopped.
 * Unpublished/crashed claims never expire: without a caller signal they wait for explicit operator recovery.
 */
export class RunWorktreeCoordinator {
  constructor(private readonly runDirectory: string) {}

  async run<T>(signal: AbortSignal | undefined, work: (guard: RunWorktreeGuard) => Promise<T>): Promise<T> {
    if (signal?.aborted) throw cancelled();
    const runs = dirname(this.runDirectory);
    await mkdir(runs, { recursive: true, mode: 0o700 });
    const key = canonicalDescendantPath(runs, this.runDirectory);
    let queue = queues.get(key);
    if (!queue) { queue = { busy: false, waiters: [] }; queues.set(key, queue); }
    const current = queue;
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        signal, reject, enter: resolve,
        abort: () => {
          const index = current.waiters.indexOf(waiter);
          if (index < 0) return;
          current.waiters.splice(index, 1);
          signal?.removeEventListener("abort", waiter.abort);
          reject(cancelled());
        },
      };
      if (current.poison) { reject(current.poison); return; }
      if (signal?.aborted) { reject(cancelled()); return; }
      if (!current.busy) { current.busy = true; resolve(); return; }
      current.waiters.push(waiter);
      signal?.addEventListener("abort", waiter.abort, { once: true });
    });
    let active = true;
    const guard: RunWorktreeGuard = {
      runKey: key,
      assertCurrent: (expected) => { if (!active || expected !== key) throw new Error("Worktree transaction guard is not current for this run"); },
      retain: (error) => { if (!active) throw new Error("Worktree transaction guard expired"); current.poison ??= error; },
    };
    let claim: Awaited<ReturnType<typeof this.claim>> | undefined;
    let value!: T;
    let failed = false;
    let failure: unknown;
    try {
      if (signal?.aborted) throw cancelled();
      claim = await this.claim(key, signal, guard);
      if (signal?.aborted) throw cancelled();
      value = await work(guard);
    } catch (error) { failed = true; failure = error; }
    if (claim) {
      try {
        await claim.verify();
        if (current.poison) {
          // Diagnostic blocker only: the immutable owner receipt remains the sole release authority.
          await claim.retain();
        } else {
          await unlink(claim.ownerPath);
          await claim.verifyDirectory();
          await rmdir(claim.path);
        }
      } catch (error) {
        current.poison = error instanceof OwnedCommandCleanupError && !current.poison ? error : Object.assign(new OwnedCommandCleanupError(`Worktree transaction release is unproven: ${key}`), { cause: current.poison ?? error });
      }
    }
    active = false;
    current.busy = false;
    if (current.poison) {
      for (const waiter of current.waiters.splice(0)) { waiter.signal?.removeEventListener("abort", waiter.abort); waiter.reject(current.poison); }
    } else {
      const next = current.waiters.shift();
      if (next) { current.busy = true; next.signal?.removeEventListener("abort", next.abort); next.enter(); }
      else if (queues.get(key) === current) queues.delete(key);
    }
    if (current.poison) throw current.poison;
    if (failed) throw failure;
    return value;
  }

  private async assertNotRetained(path: string, key: string): Promise<void> {
    try { await lstat(join(path, "retained.json")); }
    catch (error) { if (isNodeError(error, "ENOENT")) return; throw error; }
    throw recovery(key);
  }

  private async claim(key: string, signal: AbortSignal | undefined, guard: RunWorktreeGuard) {
    const namespace = join(dirname(key), ".worktree-transactions");
    await mkdir(namespace, { recursive: true, mode: 0o700 });
    const namespaceInfo = await lstat(namespace);
    if (!namespaceInfo.isDirectory() || namespaceInfo.isSymbolicLink()) throw recovery(key);
    const path = join(namespace, createHash("sha256").update(key).digest("hex"));
    const ownerPath = join(path, "owner.json");
    let waitingFor: string | undefined;
    const admissionCancelled = () => waitingFor === undefined ? cancelled() : new WorkflowError("CANCELLED", `Worktree transaction admission cancelled while waiting for ${waitingFor}: ${key}. Claims are never reclaimed; crashed claims require explicit operator recovery.`);
    for (;;) {
      if (signal?.aborted) throw admissionCancelled();
      try { await mkdir(path, { mode: 0o700 }); break; }
      catch (error) { if (!isNodeError(error, "EEXIST")) throw error; }
      let directory: Identity | undefined;
      let unpublished = false;
      try {
        const info = await lstat(path);
        directory = info;
        if (!info.isDirectory() || info.isSymbolicLink()) throw recovery(key);
        // Even an unpublished owner cannot hide an explicit retention blocker.
        await this.assertNotRetained(path, key);
        const owner = await lstat(ownerPath);
        if (!owner.isFile() || owner.isSymbolicLink() || owner.size > 16_384) throw recovery(key);
        const bytes = await readFile(ownerPath, "utf8");
        if (!sameIdentity(directory, await lstat(path)) || !sameIdentity(owner, await lstat(ownerPath))) continue;
        await this.assertNotRetained(path, key);
        const parsed: unknown = JSON.parse(bytes);
        if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || parsed.version !== 1 || !("key" in parsed) || parsed.key !== key || !("nonce" in parsed) || typeof parsed.nonce !== "string" || !parsed.nonce || !("state" in parsed) || parsed.state !== "active") throw recovery(key);
      } catch (error) {
        if (isNodeError(error, "ENOENT")) unpublished = true;
        else {
          // The old directory may have disappeared and a successor may already be initializing.
          try { if (directory && !sameIdentity(directory, await lstat(path))) continue; }
          catch (missing) { if (isNodeError(missing, "ENOENT")) continue; }
          const failure = recovery(key); guard.retain(failure); throw failure;
        }
      }
      // Missing publication is initializing/releasing/unknown, never a stale-owner or poison deadline.
      waitingFor = unpublished ? "an unpublished owner (initializing/releasing/unknown)" : "an active owner";
      try { await delay(25, undefined, { signal }); }
      catch { throw admissionCancelled(); }
    }
    try {
      const directory = await lstat(path);
      const nonce = randomUUID();
      const bytes = JSON.stringify({ version: 1, key, nonce, state: "active" });
      const verifyDirectory = async () => {
        const actual = await lstat(path);
        if (!actual.isDirectory() || actual.isSymbolicLink() || !sameIdentity(directory, actual)) throw recovery(key);
      };
      const publish = async (name: string, material: string) => {
        const pending = join(path, `.${name}-${nonce}.pending`), target = join(path, name);
        const file = await open(pending, "wx", 0o600);
        let receipt: Identity;
        try { receipt = await file.stat(); await file.writeFile(material); await file.sync(); }
        finally { await file.close(); }
        await verifyDirectory();
        // Hard-link publication is atomic and cannot replace an existing capability or blocker.
        await link(pending, target);
        await verifyDirectory();
        const actual = await lstat(target), staged = await lstat(pending);
        if (!actual.isFile() || actual.isSymbolicLink() || !sameIdentity(receipt, actual) || !sameIdentity(receipt, staged) || await readFile(target, "utf8") !== material) throw recovery(key);
        await unlink(pending);
        return receipt;
      };
      const owner = await publish("owner.json", bytes);
      const verify = async () => {
        await verifyDirectory();
        const actual = await lstat(ownerPath);
        if (!actual.isFile() || actual.isSymbolicLink() || !sameIdentity(owner, actual) || await readFile(ownerPath, "utf8") !== bytes) throw recovery(key);
        await this.assertNotRetained(path, key);
        const entries = await readdir(path);
        if (entries.length !== 1 || entries[0] !== "owner.json") throw recovery(key);
      };
      const retain = () => publish("retained.json", JSON.stringify({ version: 1, key, nonce, directory: { dev: directory.dev, ino: directory.ino }, state: "retained" }));
      await verify();
      return { path, ownerPath, verify, verifyDirectory, retain };
    } catch (error) {
      const failure = Object.assign(new OwnedCommandCleanupError(`Worktree transaction claim is incomplete: ${key}`), { cause: error });
      guard.retain(failure);
      throw failure;
    }
  }
}
