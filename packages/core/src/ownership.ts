import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { executeShellCommand } from "./execution.js";
import { LeaseCommandBroker } from "./lease-command.js";
import { OwnedCommandCleanupError } from "./owned-process.js";
import { sameFilesystemPath } from "./paths.js";
import { PhysicalWorktreeLease, worktreeLeaseIdentity } from "./worktree-lease.js";
import { WorkflowError, type ShellOptions, type LeaseCommandOptions, type ShellResult, type WorkflowBridge, type WorkflowLeaseBridge, type WorkflowWorktreeReference } from "./types.js";
import { errorText } from "./utils.js";
import { validateShellCommand, validateShellOptions, validateLeaseCommandOptions } from "./validation.js";

type Scope = {
  id: string; owner: PhysicalWorktreeLease; controller: AbortController; pending: Set<Promise<unknown>>;
  open: boolean; detachAbort?: () => void; taint?: WorkflowError; retain: boolean; broker?: Promise<LeaseCommandBroker>; closing?: Promise<void>;
};
const currentScope = new AsyncLocalStorage<Scope>();

/** Execution-local authority. Nothing here is a persisted success receipt. */
export class WorkflowOwnership implements WorkflowLeaseBridge {
  #scopes = new Map<string, Scope>();
  #entering = new Set<Promise<unknown>>();
  #closed = false;
  #taint: WorkflowError | undefined;
  readonly #executionId = randomUUID();
  constructor(private readonly root: string, private readonly runId: string, private readonly sessionId: string, private readonly signal: AbortSignal, private readonly executeShell: typeof executeShellCommand, private readonly resolveWorktree?: (owner: string) => Promise<Readonly<WorkflowWorktreeReference>>, private readonly gate?: { enter(signal?: AbortSignal): Promise<void>; leave(): Promise<void> }) {
    signal.addEventListener("abort", () => {
      this.#closed = true;
      for (const scope of this.#scopes.values()) { this.#fail(scope, new WorkflowError("CANCELLED", "Worktree scope cancelled")); scope.open = false; scope.controller.abort(); }
    }, { once: true });
  }
  current(): string | undefined { return currentScope.getStore()?.id; }
  #scope(id: string): Scope {
    const scope = this.#scopes.get(id);
    if (!scope || !scope.open || this.#closed || this.signal.aborted) throw new WorkflowError("WORKTREE_FAILED", "Worktree lease scope is closed or unavailable");
    if (scope.taint) throw scope.taint;
    return scope;
  }
  #fail(scope: Scope, error: unknown): void {
    const typed = error instanceof WorkflowError ? error : new WorkflowError("WORKTREE_FAILED", errorText(error));
    const unproven = error instanceof OwnedCommandCleanupError || error instanceof Error && "cleanupUnproven" in error && error.cleanupUnproven === true;
    if (unproven || typed.code === "WORKTREE_FAILED" && !scope.retain) scope.taint = typed;
    else scope.taint ??= typed;
    if (unproven || typed.code === "WORKTREE_FAILED" && !(this.#taint instanceof OwnedCommandCleanupError)) this.#taint = typed;
    else this.#taint ??= typed;
    if (unproven || typed.code === "WORKTREE_FAILED") scope.retain = true;
  }
  async enter(path: string, worktreeOwner: string | undefined, signal: AbortSignal): Promise<{ scope: string; path: string }> {
    if (typeof path !== "string" || !path.trim()) throw new WorkflowError("INVALID_METADATA", "withWorktreeLease path must be non-empty");
    if (this.#closed || this.signal.aborted || signal.aborted) throw new WorkflowError("CANCELLED", "Worktree lease admission is closed");
    if (process.platform !== "darwin" && process.platform !== "linux") throw new WorkflowError("WORKTREE_FAILED", "Worktree ownership requires macOS or Linux supervision");
    const entering = (async () => {
      const identity = await worktreeLeaseIdentity(path);
      const allowed = worktreeOwner ? (await this.resolveWorktree?.(worktreeOwner))?.path : this.root;
      if (!allowed || !sameFilesystemPath(identity.path, allowed)) throw new WorkflowError("WORKTREE_FAILED", "Lease path must equal the launch root or active managed worktree");
      const owner = await PhysicalWorktreeLease.acquire(identity, { runId: this.runId, sessionId: this.sessionId, executionId: this.#executionId });
      const scope: Scope = { id: randomUUID(), owner, controller: new AbortController(), pending: new Set(), open: true, retain: false };
      this.#scopes.set(scope.id, scope);
      const abort = () => { this.#fail(scope, new WorkflowError("CANCELLED", "Worktree scope cancelled")); scope.open = false; scope.controller.abort(); };
      signal.addEventListener("abort", abort, { once: true });
      scope.detachAbort = () => { signal.removeEventListener("abort", abort); };
      if (this.#closed || this.signal.aborted || signal.aborted) { this.#fail(scope, new WorkflowError("CANCELLED", "Worktree lease admission closed during acquisition")); await this.leave(scope.id); throw new WorkflowError("CANCELLED", "Worktree lease cancelled"); }
      return { scope: scope.id, path: identity.path };
    })();
    this.#entering.add(entering);
    try { return await entering; }
    catch (error) {
      if (error instanceof OwnedCommandCleanupError) this.#taint = error;
      else if (error instanceof WorkflowError && error.code === "WORKTREE_FAILED") this.#taint ??= error;
      throw error;
    } finally { this.#entering.delete(entering); }
  }
  async within<T>(id: string | undefined, work: () => Promise<T>): Promise<T> {
    const scope = id ?? this.current();
    return scope ? currentScope.run(this.#scope(scope), work) : work();
  }
  async associate<T>(id: string | undefined, work: () => Promise<T>): Promise<T> {
    const scoped = id ?? this.current();
    if (!scoped) return work();
    const scope = this.#scope(scoped);
    const operation = (async () => {
      await scope.owner.verify().catch((error: unknown) => { this.#fail(scope, error); throw error; });
      if (!scope.open || this.#closed || this.signal.aborted) throw new WorkflowError("CANCELLED", "Worktree scope closed before work admission");
      return currentScope.run(scope, work);
    })();
    // Register before the first asynchronous verification can race scope closure.
    scope.pending.add(operation);
    try { return await operation; }
    catch (error) {
      if (error instanceof OwnedCommandCleanupError || error instanceof WorkflowError && ["CANCELLED", "AGENT_TIMEOUT", "BUDGET_EXHAUSTED", "SHELL_FAILED"].includes(error.code)) this.#fail(scope, error);
      throw error;
    } finally { scope.pending.delete(operation); }
  }
  async #command<T extends ShellResult | number | null>(scope: Scope, work: () => Promise<T>, admit = true): Promise<T> {
    return this.associate(scope.id, async () => {
      if (admit) await this.gate?.enter(AbortSignal.any([this.signal, scope.controller.signal]));
      try {
        try {
          const result = await work();
          if (result === null || typeof result === "object" && result.exitCode === null) this.#fail(scope, new WorkflowError("SHELL_FAILED", "Leased command terminated by signal"));
          return result;
        } catch (error) { this.#fail(scope, error); throw error; }
      } finally { if (admit) await this.gate?.leave(); }
    });
  }
  async shell(id: string, command: string, options: ShellOptions): Promise<ShellResult> {
    const scope = this.#scope(id);
    const validated = validateShellOptions(options);
    return this.#command(scope, () => this.executeShell(validateShellCommand(command), validated, AbortSignal.any([this.signal, scope.controller.signal]), scope.owner.identity.path));
  }
  async command(id: string, command: string, options: LeaseCommandOptions): Promise<string> {
    const scope = this.#scope(id);
    const validated = validateLeaseCommandOptions(options);
    return this.associate(id, async () => {
      scope.broker ??= LeaseCommandBroker.create(scope.owner.identity.path, AbortSignal.any([this.signal, scope.controller.signal]), (work) => this.#command(scope, work), (error) => { this.#fail(scope, error); });
      const broker = await scope.broker;
      return broker.ticket(validateShellCommand(command), validated);
    });
  }
  async leave(id: string): Promise<void> {
    const scope = this.#scopes.get(id);
    if (!scope) throw new WorkflowError("WORKTREE_FAILED", "Worktree lease scope is closed or unavailable");
    scope.closing ??= this.#close(scope);
    return scope.closing;
  }
  async #close(scope: Scope): Promise<void> {
    scope.open = false;
    scope.detachAbort?.();
    scope.controller.abort();
    if (scope.broker) (await scope.broker).closeAdmission();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...scope.pending]),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { const error = new OwnedCommandCleanupError("lease work did not drain"); this.#fail(scope, error); reject(error); }, 10_000); }),
      ]);
    } finally { if (timer) clearTimeout(timer); }
    if (!scope.retain) {
      try { await scope.owner.release(); }
      catch (error) { this.#fail(scope, error); }
    }
    if (!scope.retain && scope.broker) await (await scope.broker).dispose();
    if (!scope.retain) this.#scopes.delete(scope.id);
    if (scope.taint) throw scope.taint;
  }
  async finalize(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled([...this.#entering]);
    await Promise.allSettled([...this.#scopes.values()].map((scope) => this.leave(scope.id)));
    if (this.#taint) throw this.#taint;
  }
  decorate(bridge: WorkflowBridge): WorkflowBridge {
    const tracked = <T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal) => this.associate(undefined, () => {
      const scope = currentScope.getStore();
      return work(scope ? AbortSignal.any([signal, scope.controller.signal]) : signal);
    });
    const agent = bridge.agent, shell = bridge.shell, tool = bridge.tool, worktree = bridge.worktree;
    return { ...bridge, capabilities: Object.freeze({ ...bridge.capabilities, sequentialLeaseCommands: true }), leases: this,
      ...(worktree ? { worktree: (owner: string, signal: AbortSignal, options?: import("./types.js").WorkflowWorktreeOptions) => tracked((scopedSignal) => worktree(owner, scopedSignal, options), signal) } : {}),
      ...(agent ? { agent: (...args: Parameters<NonNullable<WorkflowBridge["agent"]>>) => tracked((signal) => agent(args[0], args[1], signal, args[3]), args[2]) } : {}),
      ...(shell ? { shell: (...args: Parameters<NonNullable<WorkflowBridge["shell"]>>) => {
        const scope = currentScope.getStore();
        // Recorded shells already enter the lifecycle in their bridge; live/ticket commands do not.
        return scope ? this.#command(scope, () => shell(args[0], args[1], AbortSignal.any([args[2], scope.controller.signal]), args[3]), false) : shell(...args);
      } } : {}),
      ...(tool ? { tool: (...args: Parameters<NonNullable<WorkflowBridge["tool"]>>) => tracked((signal) => tool(args[0], args[1], signal, args[3]), args[2]) } : {}),
    };
  }
}
