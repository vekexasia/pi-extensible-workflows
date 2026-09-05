import { randomUUID } from "node:crypto";
import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { FairAgentScheduler, WorkflowAgentExecutor, type AgentProviderFailure, type AgentProviderRecovery } from "./agent-execution.js";
import { listRunIds, RunStore, structuralPath as operationPath, type PersistedRun } from "./persistence.js";
import { budgetUsage, budgetRelaxed, mergeBudget, resumeBudgetAllowed, validateBudget, validateBudgetPatch, WorkflowBudgetRuntime } from "./budget.js";
import { aliasDrift, createLaunchSnapshot, errorCode, errorText, jsonValue, object } from "./utils.js";
import { LAUNCH_SNAPSHOT_IDENTITY_VERSION, WorkflowError, type BudgetApprovalRequest, type JsonValue, type LaunchSnapshot, type ModelSpec, type RunState, type WorkflowMetadata, type WorkflowRetryProvenance, type WorkflowWorktreeReference } from "./types.js";
import { RunLifecycle, WorkflowEventPublisher, withWorkflowFunctions, workflowRunContext, type WorkflowRunRecord, type WorkflowToolUpdate } from "./host-runtime.js";
import { runWorkflow } from "./execution.js";
import { createWorkflowFailureDiagnostics, formatWorkflowFailureDelivery, formatWorkflowFailureDeliveryFallback, failureDiagnosticsFrom, completionDeliveryFromStore, incompleteRetryPaths, markWorkflowFailureDiagnostics, workflowFailedAt, type CompletionDeliveryContext, type CompletionDeliveryResult } from "./host-delivery.js";

export type WorkflowRecoveryContext = { model: { provider: string; id: string } | undefined; modelRegistry: { getAll?: () => readonly import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>[]; getAvailable?: () => readonly import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api>[]; find?: (provider: string, model: string) => import("@earendil-works/pi-ai").Model<import("@earendil-works/pi-ai").Api> | undefined; refresh?: () => Promise<void>; getError?: () => string | undefined } | undefined; deliveryContext: CompletionDeliveryContext; signal?: AbortSignal; resolvedAliases?: Readonly<Record<string, string>>; blockedAliases?: ReadonlySet<string>; blockedAliasTargets?: Readonly<Record<string, string>> };
export type WorkflowRecoveryDependencies = {
  pi: Pick<ExtensionAPI, "getThinkingLevel">;
  home: string | undefined;
  runs: Map<string, WorkflowRunRecord>;
  scheduler: FairAgentScheduler;
  eventPublisher: WorkflowEventPublisher;
  persistRunState: (store: RunStore, metadata: WorkflowMetadata, update: (run: PersistedRun) => PersistedRun | Promise<PersistedRun>) => Promise<PersistedRun>;
  projectTrusted: (context: unknown) => boolean;
  resumeHostContext: (context: unknown) => WorkflowRecoveryContext;
  ensureSessionLease: (cwd: string, sessionId: string) => Promise<void>;
  coordinateRunMutation?: <T>(task: () => Promise<T>) => Promise<T>;
  createAgentExecutor: (root: Omit<import("./agent-execution.js").AgentExecutionRoot, "agentDir" | "agentSetupHooks">) => WorkflowAgentExecutor;
  activeSnapshotTools: (tools: readonly string[], active: ReadonlySet<string> | "session") => Set<string>;
  frozenResourcePolicy: (policy: import("./types.js").AgentResourcePolicy) => () => import("./types.js").AgentResourcePolicy;
  resolveLaunchPrologue: (input: { snapshot: Readonly<LaunchSnapshot>; cwd: string; trustedProject: boolean; rootModel: ModelSpec; modelRegistry?: WorkflowRecoveryContext["modelRegistry"]; signal: AbortSignal; resolvedAliases?: Readonly<Record<string, string>>; blockedAliases?: ReadonlySet<string>; blockedAliasTargets?: Readonly<Record<string, string>>; withPreflight: boolean }) => Promise<{ active: Set<string>; settingsPath: string; currentPolicy: import("./types.js").AgentResourcePolicy; previousAliases: Readonly<Record<string, string>>; knownModels: ReadonlySet<string>; availableModels: ReadonlySet<string>; currentAliases: Readonly<Record<string, string>>; blockedAliases: ReadonlySet<string>; blockedAliasTargets: Readonly<Record<string, string>>; snapshot: Readonly<LaunchSnapshot>; script: string | undefined }>;
  workflowAgentHandler: (store: RunStore, metadata: WorkflowMetadata, lifecycle: RunLifecycle, executor: WorkflowAgentExecutor, cwd: string, runId: string) => (prompt: string, options: Readonly<Record<string, JsonValue>>, signal: AbortSignal, identity: import("./types.js").AgentIdentity) => Promise<JsonValue>;
  shellForRun: (store: RunStore, metadata: WorkflowMetadata, lifecycle: RunLifecycle, command: string, options: import("./types.js").ShellOptions, signal: AbortSignal, identity: import("./types.js").ShellIdentity) => Promise<import("./types.js").ShellResult>;
  resolveWorktree: (store: RunStore, metadata: WorkflowMetadata, owner: string) => Promise<Readonly<WorkflowWorktreeReference>>;
  checkpointBridge: (runId: string, store: RunStore, metadata: WorkflowMetadata, foreground: boolean, ui?: { select?: (prompt: string, options: string[]) => Promise<string | undefined> }, headless?: boolean) => (raw: Readonly<Record<string, JsonValue>>, signal: AbortSignal) => Promise<boolean>;
  phaseBridge: (store: RunStore, metadata: WorkflowMetadata, lifecycle: RunLifecycle) => (phase: string) => Promise<void>;
  logBridge: (store: RunStore, lifecycle: RunLifecycle, workflowName: string) => (message: string) => Promise<void>;
  lifecycleFor: (store: RunStore, state: RunState, metadata: WorkflowMetadata) => RunLifecycle;
  createProviderErrorRecovery: (host: unknown, fallbackModels: ReadonlySet<string>, abort: () => void) => ((failure: AgentProviderFailure) => Promise<AgentProviderRecovery>) | undefined;
  cleanupTerminalRun: (runId: string) => Promise<void>;
  deliver: (content: string) => void;
  deliverTerminal: (store: RunStore, content: string | (() => string | Promise<string>), failure?: boolean) => Promise<void>;
  workflowToolUpdate: (run: PersistedRun) => WorkflowToolUpdate;
  registry: import("./registry.js").WorkflowRegistryApi;
  modelSpec: (value: string, fallback: ModelSpec) => ModelSpec;
};

function workflowRecoveryGuidance(action: "resume" | "retry", state: RunState): string {
  if (action === "resume") {
    if (state === "failed") return "Failed workflow runs must use workflow_retry({ runId })";
    if (state === "completed") return "Completed workflow runs have no recovery action";
    if (state === "stopped") return "Stopped workflow runs have no recovery action; launch a new workflow";
    if (state === "interrupted") return "Interrupted workflow runs must be resumed from the interactive /workflow picker";
    return `Only budget-exhausted runs can be resumed with workflow_resume; source is ${state}`;
  }
  if (state === "budget_exhausted") return "Budget-exhausted workflow runs must use workflow_resume({ runId, budget? })";
  if (state === "completed") return "Completed workflow runs have no recovery action";
  if (state === "stopped") return "Stopped workflow runs cannot be retried; launch a new workflow";
  if (state === "interrupted") return "Interrupted workflow runs must be resumed from the interactive /workflow picker";
  return `Only failed workflow runs can be retried; source is ${state}`;
}
function assertExpectedWorkflowState(expectedState: string | undefined, actualState: RunState): void {
  if (expectedState !== undefined && expectedState !== actualState) throw new WorkflowError("RESUME_INCOMPATIBLE", `Workflow run state changed: expected state ${expectedState}, actual state ${actualState}`);
}
export function persistedFailure(run: PersistedRun, error: WorkflowError): PersistedRun { const failedAt = workflowFailedAt(error); return { ...run, error: { code: error.code, message: error.message, ...(failedAt ? { failedAt } : {}) }, ...(failedAt ? { failedAt } : {}) }; }

export function createWorkflowRecovery(deps: WorkflowRecoveryDependencies) {
  const { pi, home, runs, scheduler, eventPublisher, persistRunState, projectTrusted, resumeHostContext, ensureSessionLease, createAgentExecutor, activeSnapshotTools, frozenResourcePolicy, resolveLaunchPrologue, workflowAgentHandler, shellForRun, resolveWorktree, checkpointBridge, phaseBridge, logBridge, lifecycleFor, createProviderErrorRecovery, cleanupTerminalRun, deliver, deliverTerminal, workflowToolUpdate, registry, modelSpec } = deps;
  const coordinateRunMutation = deps.coordinateRunMutation ?? (<T>(task: () => Promise<T>): Promise<T> => task());
  type BudgetDecisionResult = { state: "running" | "completed" | "budget_exhausted"; approved: boolean; value?: JsonValue; run?: PersistedRun; completion?: CompletionDeliveryResult };
  const budgetDecisionDelivery = (metadata: WorkflowMetadata, request: BudgetApprovalRequest) => `Workflow ${metadata.name} budget adjustment ${request.proposalId} for run ${request.runId} requires approval. Consumed usage: ${JSON.stringify(request.consumed)}. Previous limits: ${JSON.stringify(request.previous)}. Proposed limits: ${JSON.stringify(request.proposed)}. Respond with workflow_respond using proposalId ${request.proposalId}.`;
  const appendBudgetDecisionEvent = async (run: WorkflowRunRecord, request: BudgetApprovalRequest, type: "adjustment_requested" | "adjustment_approved" | "adjustment_rejected") => {
    run.budget.recordEvent({ type, budgetVersion: request.budgetVersion, dimensions: [], usage: structuredClone(request.consumed), limits: structuredClone(request.proposed), at: Date.now(), proposalId: request.proposalId, previous: structuredClone(request.previous), proposed: structuredClone(request.proposed) });
    await persistRunState(run.store, run.metadata, (current) => ({ ...current, ...run.budget.snapshot() }));
  };
  const answerBudgetDecision = async (runId: string, proposalId: string, approved: boolean, silent = false, context?: unknown, signal?: AbortSignal, waitForCompletion = true): Promise<BudgetDecisionResult | undefined> => {
    const run = runs.get(runId);
    if (!run) return undefined;
    const request = await run.store.answerWorkflowDecision(proposalId, approved);
    if (!request) return undefined;
    await appendBudgetDecisionEvent(run, request, approved ? "adjustment_approved" : "adjustment_rejected");
    const result = await applyBudgetDecision(request, approved, context, signal, waitForCompletion);
    if (!silent) deliver(`Workflow ${run.metadata.name} budget adjustment ${proposalId}: ${approved ? "Approved" : "Rejected"}.`);
    return result;
  };
  const refreshPausedRunAliases = async (run: WorkflowRunRecord, context?: { model: { provider: string; id: string } | undefined; modelRegistry: WorkflowRecoveryContext["modelRegistry"]; projectTrusted?: boolean }) => {
    const loaded = await run.store.load();
    const trustedProject = context?.projectTrusted ?? run.projectTrusted();
    const rootModel = context?.model ? { ...run.model, provider: context.model.provider, model: context.model.id } : run.model;
    const { settingsPath, currentPolicy, previousAliases, knownModels, availableModels, currentAliases, blockedAliases, blockedAliasTargets, snapshot } = await resolveLaunchPrologue({ snapshot: loaded.snapshot, cwd: run.store.cwd, trustedProject, rootModel, ...(context?.modelRegistry ? { modelRegistry: context.modelRegistry } : {}), signal: run.abortController.signal, withPreflight: false });
    await run.store.saveSnapshot(snapshot);
    scheduler.updateRunLimit(run.store.runId, snapshot.settings.concurrency);
    run.executor = createAgentExecutor({ cwd: run.store.cwd, model: run.model, tools: activeSnapshotTools(snapshot.tools, "session"), resourceSelectors: currentPolicy.effective, availableModels, knownModels, modelAliases: currentAliases, blockedAliases, blockedAliasTargets, settingsPath, agentDefinitions: snapshot.roles ?? {}, runStore: run.store, providerPause: async () => { deliver(`Workflow ${snapshot.metadata.name} paused: provider limit.`); await run.lifecycle.providerPause(); }, agentResourcePolicy: frozenResourcePolicy(currentPolicy) });
    run.executor.setRunContext(workflowRunContext(run.store.cwd, run.store.sessionId, run.store.runId, loaded.snapshot.metadata, loaded.snapshot.args, run.abortController.signal));
    const drift = aliasDrift(previousAliases, currentAliases);
    if (drift.length) await run.store.appendEvent({ type: "warning", message: `Model alias mappings changed on resume: ${drift.join("; ")}` });
  };
  const recoveryUi = (context: unknown): { hasUI: boolean; ui: { select?: (prompt: string, options: string[]) => Promise<string | undefined> } } => {
    const host = object(context) ? context : undefined;
    const ui = host && object(host.ui) ? host.ui as { select?: (prompt: string, options: string[]) => Promise<string | undefined> } : {};
    return { hasUI: host?.hasUI === true, ui };
  };
  type ColdResumeResult = { value: JsonValue; resultPath: string; resultBytes: number; completion: CompletionDeliveryResult };
  const coldResumeRun = async (run: WorkflowRunRecord, hasUI: boolean, ui: { select?: (prompt: string, options: string[]) => Promise<string | undefined> }, trustedProject: boolean, context?: { model: { provider: string; id: string } | undefined; modelRegistry: WorkflowRecoveryContext["modelRegistry"]; deliveryContext: CompletionDeliveryContext; signal?: AbortSignal | undefined; resolvedAliases?: Readonly<Record<string, string>>; blockedAliases?: ReadonlySet<string>; blockedAliasTargets?: Readonly<Record<string, string>> }, modeOverride?: boolean, waitForCompletion = true): Promise<ColdResumeResult | undefined> => {
    const loaded = await run.store.load();
    const foreground = modeOverride ?? (loaded.run.delivery?.mode === "foreground" || (loaded.run.delivery?.mode === "background" && loaded.run.delivery.toolCallId !== undefined) || (loaded.run.delivery === undefined && loaded.snapshot.launchMode === "foreground"));
    if (loaded.run.activeShells !== undefined || loaded.run.activeShellStartedAt !== undefined || loaded.run.activeShellsByPhase !== undefined) {
      await persistRunState(run.store, run.metadata, (current) => {
        const next = { ...current };
        delete next.activeShells;
        delete next.activeShellStartedAt;
        delete next.activeShellsByPhase;
        return next;
      });
    }
    await run.store.validateRetrySource();
    await run.store.validateBorrowedWorktrees();
    if (loaded.snapshot.identityVersion !== LAUNCH_SNAPSHOT_IDENTITY_VERSION) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow launch snapshot identity version is incompatible");
    if (loaded.snapshot.roles === undefined) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow role definitions are missing from the launch snapshot");
    if ((loaded.snapshot.projectRoles?.length ?? 0) > 0 && !trustedProject) throw new WorkflowError("RESUME_INCOMPATIBLE", "Cannot restore project roles in an untrusted project");
    const missingRole = loaded.snapshot.agentTypes.find((role) => !loaded.snapshot.roles?.[role]);
    if (missingRole) throw new WorkflowError("RESUME_INCOMPATIBLE", `Role definition is missing from the launch snapshot: ${missingRole}`);
    const rootModel = context?.model ? { ...run.model, provider: context.model.provider, model: context.model.id } : run.model;
    const controller = new AbortController();
    if (context?.signal?.aborted) controller.abort(); else { context?.signal?.addEventListener("abort", () => { controller.abort(); }, { once: true }); }
    run.abortController = controller;
    const { settingsPath, currentPolicy, previousAliases, knownModels, availableModels, currentAliases, blockedAliases, blockedAliasTargets, snapshot, script } = await resolveLaunchPrologue({ snapshot: loaded.snapshot, cwd: run.store.cwd, trustedProject, rootModel, ...(context?.modelRegistry ? { modelRegistry: context.modelRegistry } : {}), signal: controller.signal, ...(context?.resolvedAliases ? { resolvedAliases: context.resolvedAliases } : {}), ...(context?.blockedAliases ? { blockedAliases: context.blockedAliases } : {}), ...(context?.blockedAliasTargets ? { blockedAliasTargets: context.blockedAliasTargets } : {}), withPreflight: true });
    if (!script) throw new WorkflowError("INTERNAL_ERROR", "Resume preflight did not produce a launch script");
    const persistedSnapshot = modeOverride === undefined ? snapshot : createLaunchSnapshot({ ...snapshot, launchMode: foreground ? "foreground" : "background" });
    await run.store.saveSnapshot(persistedSnapshot);
    if (modeOverride !== undefined) await persistRunState(run.store, run.metadata, (current) => ({ ...current, delivery: { ...(current.delivery ?? {}), mode: foreground ? "foreground" : "background", state: foreground ? "attached" : "pending" } }));
    scheduler.updateRunLimit(run.store.runId, snapshot.settings.concurrency);
    run.executor = createAgentExecutor({ cwd: run.store.cwd, model: rootModel, tools: activeSnapshotTools(snapshot.tools, "session"), resourceSelectors: currentPolicy.effective, availableModels, knownModels, modelAliases: currentAliases, blockedAliases, blockedAliasTargets, settingsPath, agentDefinitions: snapshot.roles ?? {}, runStore: run.store, providerPause: async () => { deliver(`Workflow ${snapshot.metadata.name} paused: provider limit.`); await run.lifecycle.providerPause(); }, agentResourcePolicy: frozenResourcePolicy(currentPolicy) });
    const drift = aliasDrift(previousAliases, currentAliases);
    if (drift.length) await run.store.appendEvent({ type: "warning", message: `Model alias mappings changed on resume: ${drift.join("; ")}` });
    const runContext = workflowRunContext(run.store.cwd, run.store.sessionId, run.store.runId, loaded.snapshot.metadata, loaded.snapshot.args, controller.signal);
    run.executor.setRunContext(runContext);
    await scheduler.cancelRun(run.store.runId);
    await run.lifecycle.resume();
    const execution = runWorkflow(script, loaded.snapshot.args, withWorkflowFunctions({ shell: (command, options, signal, identity) => shellForRun(run.store, run.metadata, run.lifecycle, command, options, signal, identity), agent: workflowAgentHandler(run.store, run.metadata, run.lifecycle, run.executor, run.store.cwd, run.store.runId), worktree: async (owner) => resolveWorktree(run.store, run.metadata, owner), checkpoint: checkpointBridge(run.store.runId, run.store, run.metadata, foreground, hasUI ? ui : undefined), phase: phaseBridge(run.store, run.metadata, run.lifecycle), log: logBridge(run.store, run.lifecycle, run.metadata.name) }, run.store, runContext, registry), controller.signal);
    run.execution = execution;
    const completion = execution.result.then(async (value) => {
      await scheduler.flush(run.store.runId);
      if (run.budget.hardExhausted) throw new WorkflowError("BUDGET_EXHAUSTED", "Budgeted work was attempted after hard exhaustion");
      const resultPath = await run.store.saveResult(value);
      const resultBytes = await run.store.resultBytes();
      await run.lifecycle.terminal("completed", "completed");
      await eventPublisher.runCompleted(run.store, run.metadata, resultPath);
      return { value, resultPath, resultBytes };
    }).catch(async (error: unknown) => {
      await scheduler.flush(run.store.runId);
      const typed = error instanceof WorkflowError ? error : new WorkflowError(errorCode(error) ?? "INTERNAL_ERROR", errorText(error));
      if (!["stopped", "interrupted", "budget_exhausted"].includes(run.lifecycle.state)) await run.lifecycle.terminal(typed.code === "BUDGET_EXHAUSTED" ? "budget_exhausted" : "failed", typed.code);
      const persisted = await persistRunState(run.store, run.metadata, (current) => persistedFailure({ ...current, ...run.budget.snapshot() }, typed));
      const state = run.lifecycle.state === "stopped" || run.lifecycle.state === "interrupted" || run.lifecycle.state === "budget_exhausted" ? run.lifecycle.state : "failed";
      if (state === "failed") retryReservations.delete(persisted.retry?.lineageRootRunId ?? run.store.runId);
      await eventPublisher.runFailed(run.store, run.metadata, typed, state);
      run.update?.(workflowToolUpdate(persisted));
      if (!["stopped", "interrupted", "budget_exhausted"].includes(run.lifecycle.state)) { const diagnostic = await createWorkflowFailureDiagnostics(run.store, run.metadata, typed, persisted); markWorkflowFailureDiagnostics(typed, diagnostic); }
      throw typed;
    }).finally(() => cleanupTerminalRun(run.store.runId));
    run.completion = completion;
    if (!foreground || !waitForCompletion) {
      void completion.then(async (result) => {
        await deliverTerminal(run.store, async () => (await completionDeliveryFromStore({ mode: "background", name: run.metadata.name, runId: run.store.runId, value: result.value, resultPath: result.resultPath, resultBytes: result.resultBytes, store: run.store, ...(context === undefined ? {} : { context: context.deliveryContext }) })).content);
      }, async (error: unknown) => {
        const diagnostic = failureDiagnosticsFrom(error);
        await deliverTerminal(run.store, diagnostic ? formatWorkflowFailureDelivery(diagnostic) : formatWorkflowFailureDeliveryFallback(run.metadata.name, run.store.runId, run.store.directory, error), true);
      });
      return undefined;
    }
    try {
      const result = await completion;
      await run.store.updateState((current) => current.delivery?.mode === "foreground" && (current.delivery.state === "attached" || current.delivery.state === "pending") ? { ...current, delivery: { ...current.delivery, state: "delivered" } } : current);
      const completionResult = await completionDeliveryFromStore({ mode: "foreground", name: run.metadata.name, runId: run.store.runId, value: result.value, resultPath: result.resultPath, resultBytes: result.resultBytes, store: run.store, ...(context === undefined ? {} : { context: context.deliveryContext }) });
      return { ...result, completion: completionResult };
    } catch (error) {
      await run.store.updateState((current) => current.delivery?.mode === "foreground" && (current.delivery.state === "attached" || current.delivery.state === "pending") ? { ...current, delivery: { ...current.delivery, state: "delivered" } } : current);
      throw error;
    }
  };
  const applyBudgetDecision = async (request: BudgetApprovalRequest, approved: boolean, context?: unknown, signal?: AbortSignal, waitForCompletion = true): Promise<BudgetDecisionResult> => {
    const run = runs.get(request.runId);
    if (!run) throw new WorkflowError("RESUME_INCOMPATIBLE", `Unknown workflow run: ${request.runId}`);
    if (!approved) return { state: "budget_exhausted", approved: false };
    const nextBudget = validateBudget(request.proposed);
    const nextVersion = request.budgetVersion + 1;
    const runtime = new WorkflowBudgetRuntime(nextBudget, nextVersion, request.consumed, run.budget.events, { active: false });
    run.budget = runtime;
    await persistRunState(run.store, run.metadata, (current) => { const next = { ...current, ...runtime.snapshot(), budgetVersion: nextVersion }; if (nextBudget) next.budget = nextBudget; else delete next.budget; return next; });
    const { hasUI, ui } = recoveryUi(context);
    const completed = await coldResumeRun(run, hasUI, ui, projectTrusted(context), { ...resumeHostContext(context), ...(signal ? { signal } : {}) }, request.foreground, waitForCompletion);
    if (completed) return { state: "completed", approved: true, value: completed.value, run: (await run.store.load()).run, completion: completed.completion };
    return { state: "running", approved: true };
  };
  const resumeWorkflowRun = async (runId: string, rawPatch?: unknown, context?: unknown, signal?: AbortSignal, modeOverride?: boolean, waitForCompletion = true, expectedState?: string): Promise<Record<string, JsonValue>> => {
    const run = runs.get(runId);
    if (!run) {
      const host = object(context) ? context : {};
      const cwd = typeof host.cwd === "string" ? host.cwd : undefined;
      const sessionManager = object(host.sessionManager) ? host.sessionManager : undefined;
      const sessionId = typeof sessionManager?.getSessionId === "function" ? String(Reflect.apply(sessionManager.getSessionId, sessionManager, [])) : undefined;
      if (cwd && sessionId) {
        try {
          const state = (await new RunStore(cwd, sessionId, runId, home).load()).run.state;
          assertExpectedWorkflowState(expectedState, state);
          throw new WorkflowError("RESUME_INCOMPATIBLE", workflowRecoveryGuidance("resume", state));
        } catch (error) {
          if (error instanceof WorkflowError) throw error;
        }
      }
      throw new WorkflowError("RESUME_INCOMPATIBLE", `Unknown workflow run ${runId} in the current project and Pi session`);
    }
    const loaded = await run.store.load();
    assertExpectedWorkflowState(expectedState, loaded.run.state);
    if (loaded.run.state !== "budget_exhausted") throw new WorkflowError("RESUME_INCOMPATIBLE", workflowRecoveryGuidance("resume", loaded.run.state));
    const currentBudget = validateBudget(loaded.run.budget ?? loaded.snapshot.budget);
    const patch = rawPatch === undefined ? {} : validateBudgetPatch(rawPatch);
    const nextBudget = mergeBudget(currentBudget, patch);
    const usage = budgetUsage(loaded.run.usage);
    if (!resumeBudgetAllowed(nextBudget, usage)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Every exhausted hard budget must be raised above retained usage or removed");
    if (budgetRelaxed(currentBudget, nextBudget)) {
      const proposalId = randomUUID();
      const request: BudgetApprovalRequest = { kind: "budget", proposalId, runId, consumed: usage, previous: currentBudget ?? {}, proposed: nextBudget ?? {}, budgetVersion: loaded.run.budgetVersion ?? 1, ...(modeOverride === undefined ? {} : { foreground: modeOverride }) };
      await run.store.requestWorkflowDecision(request);
      await appendBudgetDecisionEvent(run, request, "adjustment_requested");
      deliver(budgetDecisionDelivery(run.metadata, request));
      return { state: "awaiting_approval", proposalId };
    }
    const changed = JSON.stringify(currentBudget ?? {}) !== JSON.stringify(nextBudget ?? {});
    if (changed) {
      const nextVersion = (loaded.run.budgetVersion ?? 1) + 1;
      const runtime = new WorkflowBudgetRuntime(nextBudget, nextVersion, usage, loaded.run.budgetEvents, { active: false });
      run.budget = runtime;
      await persistRunState(run.store, run.metadata, (current) => { const next = { ...current, ...runtime.snapshot(), budgetVersion: nextVersion }; if (nextBudget) next.budget = nextBudget; else delete next.budget; return next; });
    }
    const { hasUI, ui } = recoveryUi(context);
    const completed = await coldResumeRun(run, hasUI, ui, projectTrusted(context), { ...resumeHostContext(context), ...(signal ? { signal } : {}) }, modeOverride, waitForCompletion);
    if (completed) {
      const persistedRun = structuredClone((await run.store.load()).run);
      if (!jsonValue(persistedRun)) throw new WorkflowError("RESUME_INCOMPATIBLE", "Persisted run is not JSON-compatible");
      return { state: "completed", runId, value: completed.value, run: persistedRun, completion: { content: completed.completion.content, inlined: completed.completion.inlined } };
    }
    return { state: "running" };
  };
  const retryReservations = new Set<string>();
  const retryWorkflowRunUnlocked = async (runId: string, context: unknown, signal?: AbortSignal, modeOverride?: boolean, expectedState?: string): Promise<{ runId: string; parentRunId: string; state: "running" | "completed"; value?: JsonValue; run?: PersistedRun; completion?: CompletionDeliveryResult }> => {
    if (typeof runId !== "string" || !runId.trim()) throw new WorkflowError("RESUME_INCOMPATIBLE", "workflow_retry requires an explicit run ID");
    const host = object(context) ? context : {};
    const cwd = typeof host.cwd === "string" ? host.cwd : undefined;
    const sessionManager = object(host.sessionManager) ? host.sessionManager : undefined;
    const sessionId = typeof sessionManager?.getSessionId === "function" ? String(Reflect.apply(sessionManager.getSessionId, sessionManager, [])) : undefined;
    if (!cwd || !sessionId) throw new WorkflowError("RESUME_INCOMPATIBLE", "workflow_retry requires the current project and Pi session");
    await ensureSessionLease(cwd, sessionId);
    const sourceStore = new RunStore(cwd, sessionId, runId, home);
    let loaded: { run: PersistedRun; snapshot: Readonly<LaunchSnapshot> };
    try { loaded = await sourceStore.load(); } catch (error) { throw new WorkflowError("RESUME_INCOMPATIBLE", `Unknown workflow run ${runId} in the current project and Pi session: ${errorText(error)}`); }
    assertExpectedWorkflowState(expectedState, loaded.run.state);
    if (loaded.run.state !== "failed") throw new WorkflowError("RESUME_INCOMPATIBLE", workflowRecoveryGuidance("retry", loaded.run.state));
    if (loaded.run.retry && (typeof loaded.run.retry.sourceRunId !== "string" || !loaded.run.retry.sourceRunId || typeof loaded.run.retry.lineageRootRunId !== "string" || !loaded.run.retry.lineageRootRunId || !Array.isArray(loaded.run.retry.completedPaths) || loaded.run.retry.completedPaths.some((path) => typeof path !== "string") || !Array.isArray(loaded.run.retry.incompletePaths) || loaded.run.retry.incompletePaths.some((path) => typeof path !== "string") || !Array.isArray(loaded.run.retry.namedWorktrees) || loaded.run.retry.namedWorktrees.some((name) => typeof name !== "string"))) throw new WorkflowError("RESUME_INCOMPATIBLE", "The source retry provenance is incomplete");
    const lineageRootRunId = loaded.run.retry?.lineageRootRunId ?? loaded.run.id;
    if (retryReservations.has(lineageRootRunId)) throw new WorkflowError("RESUME_INCOMPATIBLE", `An active retry already owns lineage ${lineageRootRunId}`);
    const activeStates = new Set<RunState>(["queued", "running", "pausing", "paused", "awaiting_input", "interrupted", "budget_exhausted"]);
    for (const candidateId of await listRunIds(cwd, sessionId, home)) {
      if (candidateId === runId) continue;
      const candidate = new RunStore(cwd, sessionId, candidateId, home);
      try {
        const candidateRun = (await candidate.load()).run;
        if (activeStates.has(candidateRun.state) && candidateRun.retry?.lineageRootRunId === lineageRootRunId) throw new WorkflowError("RESUME_INCOMPATIBLE", `An active retry child already exists for source lineage ${lineageRootRunId}`);
      } catch (error) {
        if (error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE") throw error;
      }
    }
    retryReservations.add(lineageRootRunId);
    let childStarted = false;
    try {
      const trustedProject = projectTrusted(context);
      await sourceStore.validateRetrySource();
      await sourceStore.validateBorrowedWorktrees();
      if (loaded.snapshot.identityVersion !== LAUNCH_SNAPSHOT_IDENTITY_VERSION) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow launch snapshot identity version is incompatible");
      if (loaded.snapshot.roles === undefined) throw new WorkflowError("RESUME_INCOMPATIBLE", "Workflow role definitions are missing from the launch snapshot");
      if ((loaded.snapshot.projectRoles?.length ?? 0) > 0 && !trustedProject) throw new WorkflowError("RESUME_INCOMPATIBLE", "Cannot restore project roles in an untrusted project");
      const missingRole = loaded.snapshot.agentTypes.find((role) => !loaded.snapshot.roles?.[role]);
      if (missingRole) throw new WorkflowError("RESUME_INCOMPATIBLE", `Role definition is missing from the launch snapshot: ${missingRole}`);
      const modelRegistry = resumeHostContext(context).modelRegistry;
      const hostModel = object(host.model) && typeof host.model.provider === "string" && typeof host.model.id === "string" ? { provider: host.model.provider, id: host.model.id } : { provider: "", id: "" };
      const rootModel: ModelSpec = { provider: hostModel.provider, model: hostModel.id, thinking: pi.getThinkingLevel() };
      const { active, settingsPath, currentPolicy, knownModels, availableModels, currentAliases, blockedAliases, blockedAliasTargets, snapshot: childBaseSnapshot } = await resolveLaunchPrologue({ snapshot: loaded.snapshot, cwd, trustedProject, rootModel, ...(modelRegistry ? { modelRegistry } : {}), signal: signal ?? new AbortController().signal, withPreflight: true });
      await sourceStore.validateNamedWorktrees();
      for (const name of loaded.run.retry?.namedWorktrees ?? []) await sourceStore.resolveNamedWorktree(name);
      const completedPaths = (await sourceStore.replayableOperations()).map(({ path }) => path);
      const incompletePaths = incompleteRetryPaths([...(loaded.run.retry?.incompletePaths ?? []), ...loaded.run.agents.filter((agent) => agent.state !== "completed").map((agent) => operationPath("agent", ...(agent.structuralPath ?? [])))], completedPaths);
      const namedWorktrees = [...new Set([...(loaded.run.retry?.namedWorktrees ?? []), ...(await sourceStore.worktrees()).filter(({ owner }) => owner.startsWith(`${operationPath("worktree", "named")}/`)).map(({ owner }) => decodeURIComponent(owner.split("/").at(-1) ?? owner))])];
      const budget = validateBudget(loaded.run.budget ?? loaded.snapshot.budget);
      const childRunId = randomUUID();
      const childStore = new RunStore(cwd, sessionId, childRunId, home);
      const childSnapshot = childBaseSnapshot;
      const childBudget = new WorkflowBudgetRuntime(budget, loaded.run.budgetVersion ?? 1, loaded.run.usage, loaded.run.budgetEvents);
      const childInitialBudget = childBudget.snapshot();
      const retry: WorkflowRetryProvenance = { sourceRunId: loaded.run.id, lineageRootRunId, completedPaths, incompletePaths, namedWorktrees };
      await childStore.create({ id: childRunId, workflowName: loaded.snapshot.metadata.name, cwd, sessionId, state: "interrupted", parentRunId: loaded.run.id, retry, agents: [], agentSessions: [], ...(budget ? { budget } : {}), budgetVersion: loaded.run.budgetVersion ?? 1, ...childInitialBudget }, childSnapshot);
      const fallbackModel: ModelSpec = { provider: hostModel.provider, model: hostModel.id, thinking: pi.getThinkingLevel() };
      const model = modelSpec(loaded.snapshot.models[0] ?? "", fallbackModel);
      const lifecycle = lifecycleFor(childStore, "interrupted", loaded.snapshot.metadata);
      const abortController = new AbortController();
      const providerErrorRecovery = createProviderErrorRecovery(context, availableModels, () => { abortController.abort(); });
      const providerPause = async () => { deliver(`Workflow ${loaded.snapshot.metadata.name} paused: provider limit.`); await lifecycle.providerPause(); };
      const childRun = { executor: createAgentExecutor({ cwd, model, tools: activeSnapshotTools(loaded.snapshot.tools, active), resourceSelectors: currentPolicy.effective, availableModels, knownModels, modelAliases: currentAliases, blockedAliases, blockedAliasTargets, settingsPath, agentDefinitions: loaded.snapshot.roles ?? {}, runStore: childStore, providerPause, agentResourcePolicy: frozenResourcePolicy(currentPolicy) }), store: childStore, metadata: loaded.snapshot.metadata, model, lifecycle, budget: childBudget, abortController, projectTrusted: () => projectTrusted(context), checkpointResolvers: new Map(), ...(providerErrorRecovery ? { providerErrorRecovery } : {}) };
      runs.set(childRunId, childRun);
      scheduler.addRun(childRunId, loaded.snapshot.settings.concurrency, () => { childBudget.checkAgentLaunch(); });
      await eventPublisher.runStarted(childStore, loaded.snapshot.metadata);
      const { hasUI, ui } = recoveryUi(context);
      const completed = await coldResumeRun(childRun, hasUI, ui, trustedProject, { model: hostModel, modelRegistry, deliveryContext: resumeHostContext(context).deliveryContext, resolvedAliases: currentAliases, blockedAliases, blockedAliasTargets, ...(signal ? { signal } : {}) }, modeOverride);
      const completion = runs.get(childRunId)?.completion;
      if (completion) {
        childStarted = true;
        void completion.then(() => { retryReservations.delete(lineageRootRunId); }, () => { retryReservations.delete(lineageRootRunId); });
      } else if (completed) {
        childStarted = true;
        retryReservations.delete(lineageRootRunId);
      }
      if (completed) return { runId: childRunId, parentRunId: loaded.run.id, state: "completed", value: completed.value, run: (await childStore.load()).run, completion: completed.completion };
      return { runId: childRunId, parentRunId: loaded.run.id, state: "running" };
    } finally {
      if (!childStarted) retryReservations.delete(lineageRootRunId);
    }
  };
  const retryWorkflowRun = (runId: string, context: unknown, signal?: AbortSignal, modeOverride?: boolean, expectedState?: string) => coordinateRunMutation(() => retryWorkflowRunUnlocked(runId, context, signal, modeOverride, expectedState));
  return { refreshPausedRunAliases, coldResumeRun, applyBudgetDecision, answerBudgetDecision, budgetDecisionDelivery, resumeWorkflowRun, retryWorkflowRun };
}
