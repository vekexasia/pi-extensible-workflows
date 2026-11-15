import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import type { executeShellCommand } from "./execution.js";
import { LeaseCommandBroker } from "./lease-command.js";
import { OwnedCommandCleanupError } from "./owned-process.js";
import { PhysicalWorktreeLease, sameWorktreeLeaseIdentity, worktreeLeaseIdentity } from "./worktree-lease.js";
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
  #admissionController = new AbortController();
  #finalizing = false;
  #finalization?: Promise<void>;
  #cancelledAdmissionDuringFinalization = false;
  #taint: WorkflowError | undefined;
  readonly #executionId = randomUUID();
  constructor(private readonly root: string, private readonly runId: string, private readonly sessionId: string, private readonly signal: AbortSignal, private readonly executeShell: typeof executeShellCommand, private readonly resolveWorktree?: (owner: string, admissionSignal: AbortSignal) => Promise<Readonly<WorkflowWorktreeReference>>, private readonly gate?: { enter(signal?: AbortSignal): Promise<void>; leave(): Promise<void> }) {
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
  #fail(scope: Scope, error: unknown, includePriorFailure = false): void {
    const typed = error instanceof WorkflowError ? error : new WorkflowError("WORKTREE_FAILED", errorText(error));
    const priority = (failure: WorkflowError | undefined) => !failure ? -1 : failure instanceof OwnedCommandCleanupError || "cleanupUnproven" in failure && failure.cleanupUnproven === true ? 3 : failure.code === "WORKTREE_FAILED" ? 2 : failure.code === "CANCELLED" ? 0 : 1;
    const update = (prior: WorkflowError | undefined): WorkflowError => {
      if (includePriorFailure && prior && prior !== typed && priority(typed) >= priority(prior)) {
        const failure = new OwnedCommandCleanupError(`${typed.message}; prior failure: ${prior.message}`);
        Object.defineProperty(failure, "cause", { value: new AggregateError([prior, typed], "Lease cleanup failures") });
        return failure;
      }
      return !prior || priority(typed) > priority(prior) ? typed : prior;
    };
    const prior = scope.taint;
    scope.taint = update(prior);
    this.#taint = this.#taint === prior ? scope.taint : update(this.#taint);
    if (priority(typed) >= 2) scope.retain = true;
  }
  async enter(path: string, worktreeOwner: string | undefined, signal: AbortSignal): Promise<{ scope: string; path: string }> {
    if (typeof path !== "string" || !path.trim()) throw new WorkflowError("INVALID_METADATA", "withWorktreeLease path must be non-empty");
    if (this.#closed || this.signal.aborted || signal.aborted) throw new WorkflowError("CANCELLED", "Worktree lease admission is closed");
    if (process.platform !== "darwin" && process.platform !== "linux") throw new WorkflowError("WORKTREE_FAILED", "Worktree ownership requires macOS or Linux supervision");
    const admissionSignal = AbortSignal.any([signal, this.signal, this.#admissionController.signal]);
    const assertAdmission = () => { if (admissionSignal.aborted) throw new WorkflowError("CANCELLED", "Worktree lease admission cancelled"); };
    const entering = (async () => {
      assertAdmission();
      const identity = await worktreeLeaseIdentity(path);
      assertAdmission();
      const allowed = worktreeOwner ? (await this.resolveWorktree?.(worktreeOwner, admissionSignal))?.path : this.root;
      assertAdmission();
      const allowedIdentity = allowed ? await worktreeLeaseIdentity(allowed) : undefined;
      assertAdmission();
      if (!allowedIdentity || !sameWorktreeLeaseIdentity(identity, allowedIdentity)) throw new WorkflowError("WORKTREE_FAILED", "Lease path must equal the launch root or active managed worktree");
      const owner = await PhysicalWorktreeLease.acquire(identity, { runId: this.runId, sessionId: this.sessionId, executionId: this.#executionId });
      const scope: Scope = { id: randomUUID(), owner, controller: new AbortController(), pending: new Set(), open: true, retain: false };
      this.#scopes.set(scope.id, scope);
      const abort = () => { this.#fail(scope, new WorkflowError("CANCELLED", "Worktree scope cancelled")); scope.open = false; scope.controller.abort(); };
      signal.addEventListener("abort", abort, { once: true });
      scope.detachAbort = () => { signal.removeEventListener("abort", abort); };
      if (admissionSignal.aborted || this.#closed) { this.#fail(scope, new WorkflowError("CANCELLED", "Worktree lease admission closed during acquisition")); await this.leave(scope.id); throw new WorkflowError("CANCELLED", "Worktree lease cancelled"); }
      return { scope: scope.id, path: identity.path };
    })();
    this.#entering.add(entering);
    try { return await entering; }
    catch (error) {
      const externallyAborted = [signal, this.signal].some((current) => current.aborted);
      if (this.#finalizing && this.#admissionController.signal.aborted && !externallyAborted && error instanceof WorkflowError && error.code === "CANCELLED") this.#cancelledAdmissionDuringFinalization = true;
      if (error instanceof OwnedCommandCleanupError && !(this.#taint instanceof OwnedCommandCleanupError)) this.#taint = error;
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
    const uncertain = (context: string, error: unknown) => {
      const failure = new OwnedCommandCleanupError(`${context}: ${errorText(error)}`);
      Object.defineProperty(failure, "cause", { value: error });
      this.#fail(scope, failure, true);
    };
    let broker: LeaseCommandBroker | undefined;
    const admissionClosed = (async () => {
      if (!scope.broker) return;
      try { broker = await scope.broker; }
      catch (error) { this.#fail(scope, error); return; }
      try { await broker.closeAdmission(); }
      catch (error) { uncertain("broker admission closure failed", error); }
    })();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.allSettled([...scope.pending, admissionClosed]),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { reject(new OwnedCommandCleanupError("lease work did not drain")); }, 10_000); }),
      ]);
    } catch (error) { uncertain("lease drain failed", error); }
    finally { if (timer) clearTimeout(timer); }
    if (!scope.retain && broker) {
      try { await broker.dispose(); }
      catch (error) { uncertain("broker disposal failed", error); }
    }
    if (!scope.retain) {
      try { await scope.owner.release(); this.#scopes.delete(scope.id); }
      catch (error) { this.#fail(scope, error, true); }
    }
    if (scope.taint) throw scope.taint;
  }
  finalize(): Promise<void> {
    if (this.#finalization) return this.#finalization;
    this.#closed = true;
    this.#finalizing = true;
    // Admission only: owned commands keep their scope/supervisor lifelines until close drains them.
    this.#admissionController.abort();
    this.#finalization = (async () => {
      await Promise.allSettled([...this.#entering]);
      await Promise.all([...this.#scopes.values()].map(async (scope) => {
        try { await this.leave(scope.id); }
        catch (error) { this.#fail(scope, error instanceof WorkflowError ? error : new OwnedCommandCleanupError(`Lease closure failed: ${errorText(error)}`)); }
      }));
      if (this.#taint) throw this.#taint;
      if (this.#cancelledAdmissionDuringFinalization) throw new WorkflowError("CANCELLED", "Pending worktree admission cancelled during finalization");
    })();
    return this.#finalization;
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
