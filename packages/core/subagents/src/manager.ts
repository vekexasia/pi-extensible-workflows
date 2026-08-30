import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
  addAccounting,
  errorCode,
  errorText,
  finiteNumber,
  isNodeError,
  jsonValue,
  loadAgentDefinitions,
  loadingRegistry,
  localAgentTransport,
  resolveAgentResourcePolicy,
  resolveWorkflowSettings,
  roleNameOf,
  sanitizeDisplayText,
  sumAccounting,
  structuralPath,
  validateModelAliasAvailability,
  WorkflowAgentExecutor,
  WorkflowError,
  workflowSettingsPath,
  type AgentActivity,
  type AgentAccounting,
  type AgentAttempt,
  type AgentAttemptSummary,
  type AgentExecutionOptions,
  type AgentExecutionRoot,
  type AgentProgress,
  type AgentToolCallProgress,
  type JsonSchema,
  type JsonValue,
  type ModelSpec,
  type WorkflowAgentSessionState,
  type WorkflowRunContext,
  SerialLane,
} from "../../src/index.js";
import { atomicJson, json as readJson, processAlive } from "../../src/persistence.js";
import {
  SUBAGENT_ATTEMPT_DETAILS_LIMIT,
  SUBAGENT_MAX_RETRIES,
  SUBAGENT_SYSTEM_PROMPT_LIMIT,
  SUBAGENTS_TOOL_NAMES,
  normalizeSubagentRunRequest,
  type SubagentInspectRequest,
  type SubagentLiveness,
  type SubagentAttemptActionData,
  type SubagentManager,
  type SubagentManagerContext,
  type SubagentManagerDependencies,
  type SubagentNotification,
  type SubagentOwnerMarker,
  type SubagentProgress,
  type SubagentRunRequest,
  type SubagentStatus,
} from "./contracts.js";
import { createRunStoreWorktreeAdapter, defaultWorktreeHome, type SubagentWorktreeContext, type SubagentWorktreeHandle } from "./worktree.js";

const WORKFLOW_NAME = "subagents";
const STORAGE_DIRECTORY = "subagents";
const OWNER_FILE = "owner.json";
const OWNER_WRITE_GRACE_MS = 30_000;
const MAX_STORAGE_OWNER_ATTEMPTS = 8;
const MAX_TERMINAL_SUMMARIES = 128;
const MAX_PENDING_STEERING_MESSAGES = 16;
const MAX_PERSISTED_ATTEMPT_ARRAY_ITEMS = SUBAGENT_MAX_RETRIES + 1;
const MAX_PERSISTED_ATTEMPT_STRING_CHARS = 4096;
const MAX_PERSISTED_ATTEMPT_LOCATOR_CHARS = 16 * 1024;
const SUBAGENT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
class InvalidPersistedSubagentStatusError extends WorkflowError {
  constructor() { super("INTERNAL_ERROR", "Persisted subagent status is invalid"); }
}
const EXCLUDED_TOOLS = new Set<string>([
  ...SUBAGENTS_TOOL_NAMES,
  "workflow",
  "workflow_respond",
  "workflow_stop",
  "workflow_status",
  "workflow_resume",
  "workflow_retry",
  "workflow_catalog",
]);

type ModelIdentity = { provider: string; id: string };
type SubagentState = SubagentStatus["state"];
type SubagentFailure = { code: string; message: string };
type PersistedSubagentStatus = SubagentStatus & { startedAt: number; finishedAt?: number; owner?: SubagentOwnerMarker; worktreeContext?: SubagentWorktreeContext };
type SubagentSession = NonNullable<AgentAttempt["liveSession"]>;
type SubagentSessionLifecycle = Pick<SubagentSession, "abort" | "dispose">;
type SessionCleanupState = { abort?: Promise<void>; dispose?: Promise<void> };
type TerminalSummary = PersistedSubagentStatus;
type SteerHandler = (message: string) => void | Promise<void>;
type ForegroundResult =
  | { readonly id: string; readonly state: "completed"; readonly value: JsonValue }
  | { readonly id: string; readonly state: "failed"; readonly error: SubagentFailure }
  | { readonly id: string; readonly state: "stopped" };
type PersistedProgress = SubagentProgress;
type LiveRun = {
  readonly id: string;
  readonly sessionId: string;
  readonly request: Readonly<SubagentRunRequest>;
  readonly directory: string;
  readonly startedAt: number;
  readonly owner: SubagentOwnerMarker;
  readonly controller: AbortController;
  readonly promise: Promise<unknown>;
  readonly terminal: Promise<ForegroundResult>;
  readonly resolveTerminal: (result: ForegroundResult) => void;
  readonly update: ((status: SubagentStatus) => void) | undefined;
  readonly observe: ((status: SubagentStatus) => void) | undefined;
  state: SubagentState;
  finishedAt?: number;
  error: SubagentFailure | undefined;
  value: JsonValue | undefined;
  cancelled: boolean;
  session: SubagentSessionLifecycle | undefined;
  readonly sessionCleanups: WeakMap<SubagentSessionLifecycle, SessionCleanupState>;
  readonly activeSessions: Set<SubagentSessionLifecycle>;
  progress: PersistedProgress | undefined;
  activeAttempt: number | undefined;
  readonly finalizedAttemptAccounting: Map<number, AgentAccounting>;
  attemptDetails: readonly AgentAttemptSummary[] | undefined;
  attempts: number | undefined;
  prepared: Readonly<import("../../src/index.js").PreparedAgentSession> | undefined;
  handoff: import("../../src/index.js").LiveSessionHandoff | undefined;
  worktree: SubagentWorktreeHandle | undefined;
  worktreeContext: SubagentWorktreeContext | undefined;
  worktreeCleanup: Promise<void> | undefined;
  steerHandler: SteerHandler | undefined;
  pendingSteers: string[];
  steerFlush: Promise<void> | undefined;
  externalAbort: (() => void) | undefined;
  externalSignal: AbortSignal | undefined;
  executorOwnsSession: boolean;
  disposed: boolean;
  concurrencyReleased: boolean;
  notificationSent: boolean;
  terminalResolved: boolean;
  writes: SerialLane;
};
type SubagentOwnerLease = {
  readonly token: string;
  release(): Promise<void>;
};

function modelNames(models: readonly ModelIdentity[]): Set<string> {
  return new Set(models.map(({ provider, id }) => `${provider}/${id}`));
}

function rootModel(context: Readonly<SubagentManagerContext>): ModelSpec {
  const model = context.extensionContext.model;
  if (!model || typeof model.provider !== "string" || typeof model.id !== "string" || !model.provider || !model.id) throw new WorkflowError("UNKNOWN_MODEL", "A current model is required to run a subagent");
  const thinking = context.extensionContext.thinkingLevel;
  return { provider: model.provider, model: model.id, ...(thinking === undefined ? {} : { thinking }) };
}
function executionRoot(context: Readonly<SubagentManagerContext>, dependencies: Readonly<SubagentManagerDependencies>, signal: AbortSignal, runId: string, worktree: SubagentWorktreeHandle | undefined): AgentExecutionRoot {
  const extensionContext = context.extensionContext;
  const model = rootModel(context);
  const agentDir = dependencies.agentDir ?? getAgentDir();
  const trustedProject = extensionContext.isProjectTrusted();
  const settingsPath = workflowSettingsPath(agentDir);
  const settings = resolveWorkflowSettings(extensionContext.cwd, trustedProject, settingsPath);
  const resourcePolicy = resolveAgentResourcePolicy(extensionContext.cwd, trustedProject, settingsPath);
  const knownModels = modelNames(extensionContext.modelRegistry.getAll());
  const availableModels = modelNames(extensionContext.modelRegistry.getAvailable());
  const rootModelName = `${model.provider}/${model.model}`;
  knownModels.add(rootModelName);
  availableModels.add(rootModelName);
  const staticAliases = settings.effective.modelAliases ?? {};
  const activeTools = dependencies.getActiveTools?.() ?? [];
  const tools = new Set(activeTools.filter((tool) => !EXCLUDED_TOOLS.has(tool)));
  const sessionId = extensionContext.sessionManager.getSessionId();
  const run: WorkflowRunContext = {
    cwd: extensionContext.cwd,
    sessionId,
    runId,
    workflow: { name: WORKFLOW_NAME },
    args: null,
    signal,
  };
  const registry = loadingRegistry();
  return {
    cwd: extensionContext.cwd,
    model,
    tools,
    resourceSelectors: resourcePolicy.effective,
    ...(worktree === undefined ? {} : { runStore: worktree.runStore }),
    agentDir,
    availableModels,
    knownModels,
    ...(Object.keys(staticAliases).length ? { modelAliases: staticAliases } : {}),
    settingsPath: settings.sources.modelAliases,
    agentDefinitions: loadAgentDefinitions(extensionContext.cwd, agentDir, trustedProject),
    agentSetupHooks: registry.agentSetupHooks(),
    agentResourcePolicy: () => structuredClone(resourcePolicy),
    runContext: run,
    ...(dependencies.onResourceWarning ? { onResourceWarning: dependencies.onResourceWarning } : {}),
  };
}

async function addDynamicAliases(context: Readonly<SubagentManagerContext>, signal: AbortSignal, root: AgentExecutionRoot): Promise<AgentExecutionRoot> {
  const registry = loadingRegistry();
  if (registry.modelAliases().length === 0) return root;
  const staticAliases = root.modelAliases ?? {};
  const dynamicAliases = await registry.resolveModelAliases({ cwd: context.extensionContext.cwd, projectTrusted: context.extensionContext.isProjectTrusted(), rootModel: root.model, knownModels: root.knownModels ?? new Set(), availableModels: root.availableModels ?? new Set(), signal }, new Set(Object.keys(staticAliases)));
  validateModelAliasAvailability(dynamicAliases, Object.keys(dynamicAliases), root.availableModels ?? new Set(), root.knownModels ?? new Set(), root.settingsPath);
  return { ...root, modelAliases: { ...dynamicAliases, ...staticAliases } };
}

function executionOptions(request: Readonly<SubagentRunRequest>, onAttempt: NonNullable<AgentExecutionOptions["onAttempt"]>, onProgress: NonNullable<AgentExecutionOptions["onProgress"]>): AgentExecutionOptions {
  const role = request.role;
  const label = request.label ?? roleNameOf(role) ?? "subagent";
  return {
    label,
    workflowName: WORKFLOW_NAME,
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.tools === undefined ? {} : { tools: request.tools }),
    ...(request.skills === undefined ? {} : { skills: request.skills }),
    ...(request.extensions === undefined ? {} : { extensions: request.extensions }),
    ...(request.contextFiles === undefined ? {} : { contextFiles: request.contextFiles as NonNullable<AgentExecutionOptions["contextFiles"]> }),
    ...(role === undefined ? {} : { role }),
    ...(request.worktree === undefined ? {} : { worktreeOwner: structuralPath("worktree", "named", request.worktree) }),
    ...(request.outputSchema === undefined ? {} : { schema: request.outputSchema as JsonSchema }),
    ...(request.retries === undefined ? {} : { retries: request.retries }),
    ...(request.timeoutMs === undefined ? {} : { timeoutMs: request.timeoutMs }),
    onAttempt,
    onProgress,
  };
}

function effectiveConcurrency(context: Readonly<SubagentManagerContext>, dependencies: Readonly<SubagentManagerDependencies>): number {
  return resolveWorkflowSettings(context.extensionContext.cwd, context.extensionContext.isProjectTrusted(), workflowSettingsPath(dependencies.agentDir ?? getAgentDir())).effective.concurrency;
}

function storageDirectory(dependencies: Readonly<SubagentManagerDependencies>): string {
  return dependencies.storageDir ?? join(dependencies.agentDir ?? getAgentDir(), STORAGE_DIRECTORY);
}

function runDirectory(root: string, id: string): string { return join(root, id); }
function requestPath(directory: string): string { return join(directory, "request.json"); }
function statusPath(directory: string): string { return join(directory, "status.json"); }
function resultPath(directory: string): string { return join(directory, "result.json"); }
function failurePath(directory: string): string { return join(directory, "failure.json"); }

async function secureDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
}

async function currentProcessStart(): Promise<number> {
  if (process.platform === "linux") {
    try { return (await stat(`/proc/${String(process.pid)}`)).ctimeMs; }
    catch (error) { if (!isNodeError(error, "ENOENT")) throw error; }
  }
  return Math.max(0, Date.now() - Math.floor(process.uptime() * 1000));
}

function decodeOwnerMarker(value: unknown): SubagentOwnerMarker | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const pid = record.pid;
  const processStart = record.processStart;
  const sessionId = record.sessionId;
  const token = record.token;
  const acquiredAt = record.acquiredAt;
  if (typeof pid !== "number" || !Number.isSafeInteger(pid) || pid < 0 || !finiteNumber(processStart) || processStart < 0 || typeof sessionId !== "string" || !sessionId.trim() || typeof token !== "string" || !token.trim() || typeof acquiredAt !== "number" || !Number.isSafeInteger(acquiredAt) || acquiredAt < 0) return undefined;
  return { pid, processStart, sessionId, token, acquiredAt };
}

async function createOwnerMarker(liveness: SubagentLiveness | undefined): Promise<SubagentOwnerMarker> {
  const pid = liveness?.pid ?? process.pid;
  const processStart = liveness?.processStart ?? await currentProcessStart();
  const sessionId = liveness?.sessionId ?? `${String(pid)}:${String(processStart)}`;
  const token = liveness?.token ?? randomUUID();
  if (!Number.isSafeInteger(pid) || pid < 0 || !finiteNumber(processStart) || processStart < 0 || typeof sessionId !== "string" || !sessionId.trim() || typeof token !== "string" || !token.trim()) throw new WorkflowError("INTERNAL_ERROR", "Invalid subagent storage owner identity");
  return { pid, processStart, sessionId, token, acquiredAt: Date.now() };
}


async function ownerIsLive(owner: SubagentOwnerMarker, liveness: SubagentLiveness | undefined): Promise<boolean> {
  if (liveness?.isLive) {
    try { return await liveness.isLive(owner); }
    catch { return true; }
  }
  if (liveness?.pid !== undefined && liveness.processStart !== undefined && owner.pid === liveness.pid && owner.processStart === liveness.processStart) return true;
  return processAlive(owner.pid, owner.processStart);
}

async function restoreOwnerMarker(path: string, stale: string): Promise<void> {
  try { await link(stale, path); }
  catch (error) { if (!isNodeError(error, "EEXIST") && !isNodeError(error, "ENOENT")) throw error; }
  await rm(stale, { force: true });
}

async function writeOwnerMarker(path: string, marker: SubagentOwnerMarker): Promise<void> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(path, "wx", 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify(marker)}\n`, "utf8");
    await handle.close();
    handle = undefined;
    await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await rm(path, { force: true });
    throw error;
  }
}

async function releaseOwnerMarker(path: string, token: string): Promise<void> {
  let marker: SubagentOwnerMarker | undefined;
  try { marker = decodeOwnerMarker(JSON.parse(await readFile(path, "utf8"))); }
  catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    // A malformed or replaced marker cannot prove this manager still owns the storage.
    return;
  }
  if (marker?.token === token) await rm(path, { force: true });
}

async function acquireStorageOwner(root: string, owner: SubagentOwnerMarker, liveness: SubagentLiveness | undefined): Promise<SubagentOwnerLease | undefined> {
  await secureDirectory(root);
  const path = join(root, OWNER_FILE);
  for (let attempt = 0; attempt < MAX_STORAGE_OWNER_ATTEMPTS; attempt += 1) {
    const marker: SubagentOwnerMarker = { ...owner, acquiredAt: Date.now() };
    try {
      await writeOwnerMarker(path, marker);
      return { token: marker.token, release: () => releaseOwnerMarker(path, marker.token) };
    } catch (error) {
      if (!isNodeError(error, "EEXIST")) throw error;
    }
    let existingText: string;
    try { existingText = await readFile(path, "utf8"); }
    catch (error) { if (isNodeError(error, "ENOENT")) continue; throw error; }
    let existing: SubagentOwnerMarker | undefined;
    try { existing = decodeOwnerMarker(JSON.parse(existingText)); }
    catch { existing = undefined; }
    if (existing) {
      if (await ownerIsLive(existing, liveness)) return undefined;
    } else {
      let age: number;
      try { age = Math.max(0, Date.now() - (await stat(path)).mtimeMs); }
      catch (error) { if (isNodeError(error, "ENOENT")) continue; throw error; }
      if (age < OWNER_WRITE_GRACE_MS) return undefined;
    }
    const stale = `${path}.${randomUUID()}.stale`;
    try { await rename(path, stale); }
    catch (error) { if (isNodeError(error, "ENOENT")) continue; throw error; }
    let movedText: string;
    try { movedText = await readFile(stale, "utf8"); }
    catch (error) { if (isNodeError(error, "ENOENT")) continue; throw error; }
    const moved = (() => { try { return decodeOwnerMarker(JSON.parse(movedText)); } catch { return undefined; } })();
    const same = existing ? moved?.token === existing.token : movedText === existingText;
    if (!same) { await restoreOwnerMarker(path, stale); continue; }
    await rm(stale, { force: true });
  }
  return undefined;
}

function validSubagentId(id: string): boolean { return SUBAGENT_ID_PATTERN.test(id); }

function checkedRequest(request: unknown): SubagentRunRequest {
  return normalizeSubagentRunRequest(request);
}

function checkedId(request: Readonly<{ id: string }>): string {
  if (typeof request.id !== "string" || !validSubagentId(request.id)) throw new WorkflowError("RUN_NOT_FOUND", `Unknown subagent ${request.id}`);
  return request.id;
}

function failureFrom(error: unknown): SubagentFailure {
  return { code: errorCode(error) ?? "AGENT_FAILED", message: errorText(error) };
}

function internalStorageError(error: unknown, operation: string): WorkflowError {
  return new WorkflowError("INTERNAL_ERROR", `${operation}: ${errorText(error)}`);
}

function boundedAttemptText(value: string): string { return value.length > MAX_PERSISTED_ATTEMPT_STRING_CHARS ? value.slice(0, MAX_PERSISTED_ATTEMPT_STRING_CHARS) : value; }
function boundedAttemptStrings(values: readonly string[]): readonly string[] { return values.slice(0, MAX_PERSISTED_ATTEMPT_ARRAY_ITEMS).map(boundedAttemptText); }
function boundedAttemptLocator(value: JsonValue | undefined): JsonValue | undefined {
  if (value === undefined) return undefined;
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { return undefined; }
  return serialized.length > MAX_PERSISTED_ATTEMPT_LOCATOR_CHARS ? undefined : structuredClone(value);
}
function boundedAttemptSetup(setup: AgentAttempt["setup"]): AgentAttemptSummary["setup"] {
  const resources = setup.resourceSelectors;
  return {
    hookNames: boundedAttemptStrings(setup.hookNames),
    model: { provider: boundedAttemptText(setup.model.provider), model: boundedAttemptText(setup.model.model), ...(setup.model.thinking === undefined ? {} : { thinking: setup.model.thinking }) },
    tools: boundedAttemptStrings(setup.tools),
    cwd: boundedAttemptText(setup.cwd),
    ...(resources === undefined ? {} : { resourceSelectors: { selectors: { skills: boundedAttemptStrings(resources.selectors.skills), extensions: boundedAttemptStrings(resources.selectors.extensions), tools: boundedAttemptStrings(resources.selectors.tools ?? []) }, skills: boundedAttemptStrings(resources.skills), extensions: boundedAttemptStrings(resources.extensions), tools: boundedAttemptStrings(resources.tools), unmatchedSkills: boundedAttemptStrings(resources.unmatchedSkills), unmatchedExtensions: boundedAttemptStrings(resources.unmatchedExtensions), unmatchedTools: boundedAttemptStrings(resources.unmatchedTools) } }),
  };
}
type ProgressSnapshotInput = Pick<AgentProgress, "accounting" | "toolCalls" | "state" | "activity" | "lastEventAt">;
function portableProgress(progress: ProgressSnapshotInput, includeActivity = false): PersistedProgress {
  return {
    accounting: structuredClone(progress.accounting),
    toolCalls: structuredClone(progress.toolCalls),
    ...(progress.state === undefined ? {} : { state: { model: { ...progress.state.model }, ...(progress.state.thinking === undefined ? {} : { thinking: progress.state.thinking }), tools: [...progress.state.tools] } }),
    ...(includeActivity && progress.activity !== undefined ? { activity: { ...progress.activity, text: sanitizeDisplayText(progress.activity.text) } } : {}),
    ...(progress.lastEventAt === undefined ? {} : { lastEventAt: progress.lastEventAt }),
  };
}
function statusFields(run: LiveRun): Pick<SubagentStatus, "progress"> {
  return run.progress === undefined ? {} : { progress: portableProgress(run.progress) };
}
function withoutOwner(status: PersistedSubagentStatus): PersistedSubagentStatus {
  const next = { ...status };
  delete next.owner;
  return next;
}
function persistedStatus(run: LiveRun): PersistedSubagentStatus {
  const status: PersistedSubagentStatus = {
    id: run.id,
    sessionId: run.sessionId,
    state: run.state,
    startedAt: run.startedAt,
    owner: { ...run.owner },
    ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
    ...(run.worktree === undefined ? {} : { worktree: { path: run.worktree.path, branch: run.worktree.branch } }),
    ...(run.worktreeContext === undefined ? {} : { worktreeContext: { ...run.worktreeContext } }),
    ...(run.error === undefined ? {} : { error: run.error }),
    ...(run.attempts === undefined ? {} : { attempts: run.attempts }),
    ...(run.attemptDetails === undefined ? {} : { attemptDetails: structuredClone(run.attemptDetails) }),
    ...statusFields(run),
  };
  return run.state === "running" ? status : withoutOwner(status);
}

function decodeFailure(value: unknown): SubagentFailure | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as { message?: unknown };
  const code = errorCode(value);
  return code && typeof record.message === "string" ? { code, message: record.message } : undefined;
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}
function attemptNumberValue(value: unknown): number | undefined {
  const attempt = recordValue(value)?.attempt;
  return typeof attempt === "number" && Number.isSafeInteger(attempt) && attempt >= 1 ? attempt : undefined;
}
function finalizedAttemptValue(value: unknown): boolean {
  const record = recordValue(value);
  return record !== undefined && (Object.prototype.hasOwnProperty.call(record, "result") || Object.prototype.hasOwnProperty.call(record, "error"));
}
function accountingValue(value: unknown): AgentAccounting | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const input = record.input;
  const output = record.output;
  const cacheRead = record.cacheRead;
  const cacheWrite = record.cacheWrite;
  const cost = record.cost;
  if (!finite(input) || !finite(output) || !finite(cacheRead) || !finite(cacheWrite) || !finite(cost)) return undefined;
  return { input, output, cacheRead, cacheWrite, cost };
}
function legacyAccountingValue(record: Record<string, unknown>): AgentAccounting | undefined {
  const accounting = accountingValue(record.accounting);
  if (record.accounting !== undefined && !accounting) return undefined;
  const usage = record.usage;
  if (usage === undefined) return accounting;
  if (typeof usage !== "object" || usage === null || Array.isArray(usage)) return undefined;
  const tokens = (usage as Record<string, unknown>).tokens;
  if (typeof tokens !== "object" || tokens === null || Array.isArray(tokens)) return undefined;
  const tokenRecord = tokens as Record<string, unknown>;
  const input = tokenRecord.input;
  const output = tokenRecord.output;
  const cacheRead = tokenRecord.cacheRead;
  const cacheWrite = tokenRecord.cacheWrite;
  const cost = (usage as Record<string, unknown>).cost;
  if (!finite(input) || !finite(output) || !finite(cacheRead) || !finite(cacheWrite) || !finite(tokenRecord.total) || !finite(cost)) return undefined;
  return accounting ?? { input, output, cacheRead, cacheWrite, cost };
}
function activityValue(value: unknown): AgentActivity | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return (record.kind === "reasoning" || record.kind === "tool" || record.kind === "text") && typeof record.text === "string" ? { kind: record.kind, text: record.text } : undefined;
}
function toolCallsValue(value: unknown): readonly AgentToolCallProgress[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const calls: AgentToolCallProgress[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return undefined;
    const record = item as Record<string, unknown>;
    if (typeof record.id !== "string" || typeof record.name !== "string" || (record.state !== "running" && record.state !== "completed" && record.state !== "failed")) return undefined;
    calls.push({ id: record.id, name: record.name, state: record.state });
  }
  return calls;
}
function stringArrayValue(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string");
  return strings.length === value.length ? strings : undefined;
}
function modelValue(value: unknown): ModelSpec | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const thinking = record.thinking;
  if (typeof record.provider !== "string" || !record.provider.trim() || typeof record.model !== "string" || !record.model.trim() || thinking !== undefined && thinking !== "off" && thinking !== "minimal" && thinking !== "low" && thinking !== "medium" && thinking !== "high" && thinking !== "xhigh" && thinking !== "max") return undefined;
  return { provider: record.provider, model: record.model, ...(thinking === undefined ? {} : { thinking }) };
}
function sessionReferenceValue(value: unknown): AgentAttemptSummary["session"] | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const transport = record.transport;
  const sessionId = record.sessionId;
  const rawLocator = record.locator;
  if (typeof transport !== "string" || !transport.trim() || typeof sessionId !== "string" || !sessionId.trim()) return undefined;
  if (rawLocator !== undefined && !jsonValue(rawLocator)) return undefined;
  const locator = rawLocator === undefined ? undefined : boundedAttemptLocator(rawLocator);
  return { transport: boundedAttemptText(transport), sessionId: boundedAttemptText(sessionId), ...(locator === undefined ? {} : { locator }) };
}
function resourceSummaryValue(value: unknown): NonNullable<AgentAttemptSummary["setup"]["resourceSelectors"]> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const selectorRecord = record.selectors;
  if (typeof selectorRecord !== "object" || selectorRecord === null || Array.isArray(selectorRecord)) return undefined;
  const skills = stringArrayValue(record.skills);
  const extensions = stringArrayValue(record.extensions);
  const tools = stringArrayValue(record.tools);
  const selectorSkills = stringArrayValue((selectorRecord as Record<string, unknown>).skills);
  const selectorExtensions = stringArrayValue((selectorRecord as Record<string, unknown>).extensions);
  const selectorTools = stringArrayValue((selectorRecord as Record<string, unknown>).tools);
  const unmatchedSkills = stringArrayValue(record.unmatchedSkills);
  const unmatchedExtensions = stringArrayValue(record.unmatchedExtensions);
  const unmatchedTools = stringArrayValue(record.unmatchedTools);
  if (!skills || !extensions || !tools || !selectorSkills || !selectorExtensions || !selectorTools || !unmatchedSkills || !unmatchedExtensions || !unmatchedTools) return undefined;
  return { selectors: { skills: selectorSkills, extensions: selectorExtensions, tools: selectorTools }, skills, extensions, tools, unmatchedSkills, unmatchedExtensions, unmatchedTools };
}
function setupSummaryValue(value: unknown): NonNullable<AgentAttemptSummary["setup"]> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const hookNames = stringArrayValue(record.hookNames);
  const tools = stringArrayValue(record.tools);
  const model = modelValue(record.model);
  const resources = record.resourceSelectors === undefined ? undefined : resourceSummaryValue(record.resourceSelectors);
  if (!hookNames || !tools || !model || typeof record.cwd !== "string" || !record.cwd.trim() || record.resourceSelectors !== undefined && !resources) return undefined;
  return { hookNames, model, tools, cwd: record.cwd, ...(resources === undefined ? {} : { resourceSelectors: resources }) };
}
function attemptSummaryValue(value: unknown): AgentAttemptSummary | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const attempt = record.attempt;
  const transport = record.transport;
  const session = record.session === undefined ? undefined : sessionReferenceValue(record.session);
  const setup = setupSummaryValue(record.setup);
  const accounting = accountingValue(record.accounting);
  const error = record.error === undefined ? undefined : decodeFailure(record.error);
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1 || typeof transport !== "string" || !transport.trim() || !setup || !accounting || record.session !== undefined && !session || record.error !== undefined && !error) return undefined;
  return {
    attempt,
    transport: boundedAttemptText(transport),
    ...(session === undefined ? {} : { session }),
    ...(error === undefined ? {} : { error: { code: boundedAttemptText(error.code), message: boundedAttemptText(error.message) } }),
    accounting: { ...accounting },
    setup: boundedAttemptSetup(setup),
  };
}
function isSessionLifecycle(value: unknown): value is SubagentSessionLifecycle {
  const record = recordValue(value);
  return Boolean(record && typeof record.abort === "function" && typeof record.dispose === "function");
}
function isLiveSession(value: unknown): value is SubagentSession {
  const record = recordValue(value);
  return Boolean(isSessionLifecycle(value) && record && sessionReferenceValue(record.reference) && typeof record.getState === "function" && typeof record.getSessionStats === "function" && typeof record.getLastAssistant === "function" && typeof record.subscribe === "function" && typeof record.prompt === "function" && typeof record.steer === "function");
}
function isPreparedSession(value: unknown): value is NonNullable<AgentAttempt["prepared"]> {
  const record = recordValue(value);
  const model = modelValue(record?.model);
  const tools = stringArrayValue(record?.tools);
  if (!record || !model || !tools || typeof record.cwd !== "string" || !record.cwd.trim() || typeof record.sessionLabel !== "string") return false;
  const textFields = ["initialPrompt", "agentDir", "systemPromptPath", "systemPromptAppend", "piRuntimeError"];
  if (textFields.some((field) => record[field] !== undefined && typeof record[field] !== "string")) return false;
  if (record.systemPrompt !== undefined && (typeof record.systemPrompt !== "string" || record.systemPrompt.length > SUBAGENT_SYSTEM_PROMPT_LIMIT)) return false;
  const runtime = recordValue(record.piRuntime);
  if (record.piRuntime !== undefined && (!runtime || typeof runtime.executable !== "string" || !runtime.executable.trim() || runtime.entrypoint !== undefined && (typeof runtime.entrypoint !== "string" || !runtime.entrypoint.trim()))) return false;
  return true;
}
function isLiveSessionHandoff(value: unknown): value is NonNullable<AgentAttempt["handoff"]> {
  const record = recordValue(value);
  return Boolean(record && (record.state === "local-running" || record.state === "handoff-pending" || record.state === "herdr-running" || record.state === "returning-local" || record.state === "completed") && typeof record.transferred === "boolean" && typeof record.observe === "function" && typeof record.request === "function" && typeof record.waitForTakeover === "function" && typeof record.takeover === "function" && typeof record.waitForResume === "function" && typeof record.release === "function");
}
type ValidExecutionResult = { readonly value: JsonValue; readonly attempts: readonly unknown[] };
function executionResultValue(value: unknown): ValidExecutionResult | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const result = record.value;
  const attempts = record.attempts;
  if (!jsonValue(result) || !Array.isArray(attempts) || attempts.length > MAX_PERSISTED_ATTEMPT_ARRAY_ITEMS) return undefined;
  return { value: result, attempts };
}
function sessionStateValue(value: unknown): NonNullable<SubagentProgress["state"]> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const model = modelValue(record.model);
  const rawTools = record.tools;
  if (!model || !Array.isArray(rawTools)) return undefined;
  const tools = rawTools.filter((tool): tool is string => typeof tool === "string");
  if (tools.length !== rawTools.length) return undefined;
  if (record.thinking !== undefined && typeof record.thinking !== "string") return undefined;
  const thinking = typeof record.thinking === "string" ? record.thinking as NonNullable<WorkflowAgentSessionState["thinking"]> : undefined;
  return { model: { ...model, ...(thinking === undefined ? {} : { thinking }) }, ...(thinking === undefined ? {} : { thinking }), tools };
}
function progressValue(value: unknown): SubagentProgress | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const accounting = accountingValue(record.accounting);
  const toolCalls = toolCallsValue(record.toolCalls);
  const state = record.state === undefined ? undefined : sessionStateValue(record.state);
  if (!accounting || !toolCalls || (record.state !== undefined && state === undefined)) return undefined;
  const activity = record.activity === undefined ? undefined : activityValue(record.activity);
  if (record.activity !== undefined && activity === undefined) return undefined;
  if (record.lastEventAt !== undefined && (!Number.isSafeInteger(record.lastEventAt) || (record.lastEventAt as number) < 0)) return undefined;
  return { accounting, toolCalls, ...(state === undefined ? {} : { state }), ...(activity === undefined ? {} : { activity }), ...(record.lastEventAt === undefined ? {} : { lastEventAt: record.lastEventAt as number }) };
}
function legacyProgressValue(record: Record<string, unknown>): SubagentProgress | undefined {
  const accounting = legacyAccountingValue(record);
  const toolCalls = record.toolCalls === undefined ? [] : toolCallsValue(record.toolCalls);
  if (!accounting || !toolCalls) return undefined;
  const activity = record.activity === undefined ? undefined : activityValue(record.activity);
  if (record.activity !== undefined && activity === undefined) return undefined;
  if (record.lastEventAt !== undefined && (!Number.isSafeInteger(record.lastEventAt) || (record.lastEventAt as number) < 0)) return undefined;
  return { accounting, toolCalls, ...(activity === undefined ? {} : { activity }), ...(record.lastEventAt === undefined ? {} : { lastEventAt: record.lastEventAt as number }) };
}
function worktreeValue(value: unknown): { path: string; branch: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  return typeof record.path === "string" && record.path.trim() && typeof record.branch === "string" && record.branch.trim() ? { path: record.path, branch: record.branch } : undefined;
}
function worktreeContextValue(value: unknown): SubagentWorktreeContext | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const context = typeof record.cwd === "string" && typeof record.sessionId === "string" && typeof record.runId === "string" && typeof record.name === "string" && typeof record.owner === "string" ? { cwd: record.cwd, sessionId: record.sessionId, runId: record.runId, name: record.name, owner: record.owner } : undefined;
  if (!context || !context.cwd.trim() || !context.sessionId.trim() || !context.runId.trim() || !context.name.trim() || !context.owner.trim()) return undefined;
  return context;
}
function decodeStatus(value: unknown, id: string, includeAttemptMetadata = true): PersistedSubagentStatus | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.id !== id || !validSubagentId(id) || (record.state !== "running" && record.state !== "completed" && record.state !== "failed" && record.state !== "stopped") || typeof record.startedAt !== "number" || !Number.isSafeInteger(record.startedAt) || record.startedAt < 0) return undefined;
  const persistedSessionId = record.sessionId;
  if (persistedSessionId !== undefined && (typeof persistedSessionId !== "string" || !persistedSessionId.trim())) return undefined;
  const owner = record.owner === undefined ? undefined : decodeOwnerMarker(record.owner);
  if (record.owner !== undefined && owner === undefined) return undefined;
  const error = record.error === undefined ? undefined : decodeFailure(record.error);
  if (record.error !== undefined && error === undefined) return undefined;
  if (record.finishedAt !== undefined && (typeof record.finishedAt !== "number" || !Number.isSafeInteger(record.finishedAt) || record.finishedAt < record.startedAt)) return undefined;
  const worktree = record.worktree === undefined ? undefined : worktreeValue(record.worktree);
  const worktreeContext = record.worktreeContext === undefined ? undefined : worktreeContextValue(record.worktreeContext);
  if (record.worktree !== undefined && worktree === undefined || record.worktreeContext !== undefined && worktreeContext === undefined) return undefined;
  if (worktreeContext && (worktreeContext.runId !== id || worktreeContext.owner !== structuralPath("worktree", "named", worktreeContext.name))) return undefined;
  const sessionId = persistedSessionId ?? worktreeContext?.sessionId;
  const progress = record.progress === undefined ? legacyProgressValue(record) : progressValue(record.progress);
  if (record.progress !== undefined && progress === undefined) return undefined;
  const legacyAccounting = record.accounting === undefined && record.usage === undefined ? undefined : legacyAccountingValue(record);
  const legacyActivity = record.activity === undefined ? undefined : activityValue(record.activity);
  const legacyToolCalls = record.toolCalls === undefined ? undefined : toolCallsValue(record.toolCalls);
  if (record.accounting !== undefined && !legacyAccounting || record.usage !== undefined && !legacyAccounting || record.activity !== undefined && !legacyActivity || record.toolCalls !== undefined && !legacyToolCalls || record.lastEventAt !== undefined && (!Number.isSafeInteger(record.lastEventAt) || (record.lastEventAt as number) < 0)) return undefined;
  if (includeAttemptMetadata && record.systemPrompt !== undefined && (typeof record.systemPrompt !== "string" || record.systemPrompt.length > SUBAGENT_SYSTEM_PROMPT_LIMIT)) return undefined;
  const attempts = record.attempts;
  if (attempts !== undefined && (typeof attempts !== "number" || !Number.isSafeInteger(attempts) || attempts < 1)) return undefined;
  const attemptDetails = includeAttemptMetadata && record.attemptDetails !== undefined ? Array.isArray(record.attemptDetails) && record.attemptDetails.length <= SUBAGENT_ATTEMPT_DETAILS_LIMIT ? record.attemptDetails.map(attemptSummaryValue) : undefined : undefined;
  if (includeAttemptMetadata && record.attemptDetails !== undefined && (!attemptDetails || attemptDetails.some((attempt): attempt is undefined => attempt === undefined))) return undefined;
  if (includeAttemptMetadata && attempts !== undefined && attemptDetails?.some((attempt) => attempt !== undefined && attempt.attempt > attempts)) return undefined;
  return { id, ...(sessionId === undefined ? {} : { sessionId }), state: record.state, startedAt: record.startedAt, ...(attempts === undefined ? {} : { attempts }), ...(attemptDetails === undefined ? {} : { attemptDetails: attemptDetails.filter((attempt): attempt is AgentAttemptSummary => attempt !== undefined) }), ...(record.finishedAt === undefined ? {} : { finishedAt: record.finishedAt }), ...(owner === undefined ? {} : { owner }), ...(worktree === undefined ? {} : { worktree }), ...(worktreeContext === undefined ? {} : { worktreeContext }), ...(error === undefined ? {} : { error }), ...(progress === undefined ? {} : { progress }) };
}
function publicStatus(status: SubagentStatus, includeAttemptMetadata = false, includeActivity = false): SubagentStatus {
  return {
    id: status.id,
    ...(status.sessionId === undefined ? {} : { sessionId: status.sessionId }),
    ...(status.attempts === undefined ? {} : { attempts: status.attempts }),
    ...(includeAttemptMetadata && status.attemptDetails !== undefined ? { attemptDetails: structuredClone(status.attemptDetails) } : {}),
    state: status.state,
    ...(status.startedAt === undefined ? {} : { startedAt: status.startedAt }),
    ...(status.finishedAt === undefined ? {} : { finishedAt: status.finishedAt }),
    ...(status.worktree === undefined ? {} : { worktree: { ...status.worktree } }),
    ...(status.error === undefined ? {} : { error: { ...status.error } }),
    ...(status.progress === undefined ? {} : { progress: portableProgress(status.progress, includeActivity) }),
  };
}
function liveStatus(run: LiveRun): PersistedSubagentStatus {
  const persisted = persistedStatus(run);
  return run.progress === undefined ? persisted : { ...persisted, progress: portableProgress(run.progress, true) };
}
function emitUpdate(run: LiveRun): void {
  const live = liveStatus(run);
  try { run.update?.(publicStatus(live, false, true)); } catch { /* Rendering must not affect execution. */ }
  try { run.observe?.(publicStatus(live, true, true)); } catch { /* A widget failure is display-only. */ }
}

async function createRunStorage(root: string, id: string, request: Readonly<SubagentRunRequest>, status: PersistedSubagentStatus): Promise<string> {
  await secureDirectory(root);
  const directory = runDirectory(root, id);
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
    await chmod(directory, 0o700);
    await atomicJson(requestPath(directory), request);
    await atomicJson(statusPath(directory), status);
    return directory;
  } catch (error) {
    if (created) await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function loadPersistedStatus(root: string, id: string, includeAttemptMetadata = true): Promise<PersistedSubagentStatus> {
  try {
    const value = await readJson(statusPath(runDirectory(root, id)));
    const status = decodeStatus(value, id, includeAttemptMetadata);
    if (!status) throw new InvalidPersistedSubagentStatusError();
    return status;
  } catch (error) {
    if (isNodeError(error, "ENOENT")) throw new WorkflowError("RUN_NOT_FOUND", `Unknown subagent ${id}`);
    if (error instanceof InvalidPersistedSubagentStatusError) throw error;
    if (error instanceof SyntaxError) throw new InvalidPersistedSubagentStatusError();
    if (error instanceof WorkflowError) throw error;
    throw internalStorageError(error, `Unable to read subagent ${id} status`);
  }
}
async function loadPersistedRequest(root: string, id: string): Promise<SubagentRunRequest> {
  try {
    return checkedRequest(await readJson(requestPath(runDirectory(root, id))));
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw internalStorageError(error, `Unable to read subagent ${id} request`);
  }
}

async function loadPersistedFailure(root: string, id: string): Promise<SubagentFailure> {
  try {
    const failure = decodeFailure(await readJson(failurePath(runDirectory(root, id))));
    if (!failure) throw new WorkflowError("INTERNAL_ERROR", "Persisted subagent failure is invalid");
    return failure;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw internalStorageError(error, `Unable to read subagent ${id} failure`);
  }
}

async function loadPersistedResult(root: string, id: string): Promise<JsonValue> {
  try {
    const value = await readJson(resultPath(runDirectory(root, id)));
    if (!jsonValue(value)) throw new WorkflowError("INTERNAL_ERROR", "Persisted subagent result is not a JSON value");
    return value;
  } catch (error) {
    if (error instanceof WorkflowError) throw error;
    throw internalStorageError(error, `Unable to read subagent ${id} result`);
  }
}

async function loadOptionalJson(path: string): Promise<unknown> {
  try {
    return await readJson(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return undefined;
    throw error;
  }
}

function orphanedFailure(): SubagentFailure {
  return { code: "INTERNAL_ERROR", message: "Subagent run was interrupted before completion" };
}

function reconciledStatus(status: PersistedSubagentStatus, state: Exclude<SubagentState, "running">, finishedAt: number, error?: SubagentFailure): PersistedSubagentStatus {
  const next: PersistedSubagentStatus = {
    ...status,
    state,
    finishedAt,
    ...(error === undefined ? {} : { error }),
  };
  return withoutOwner(next);
}

function withoutWorktree(status: PersistedSubagentStatus): PersistedSubagentStatus {
  const next = { ...status };
  delete next.worktree;
  delete next.worktreeContext;
  return next;
}

async function reconcilePersistedResult(root: string, id: string, status: PersistedSubagentStatus): Promise<PersistedSubagentStatus> {
  if (status.state !== "running") return status;
  const directory = runDirectory(root, id);
  const result = await loadOptionalJson(resultPath(directory));
  if (result === undefined) return status;
  if (!jsonValue(result)) throw new WorkflowError("INTERNAL_ERROR", "Persisted subagent result is not a JSON value");
  const completed = reconciledStatus(status, "completed", Math.max(Date.now(), status.startedAt));
  await atomicJson(statusPath(directory), completed);
  return completed;
}

async function reconcilePersistedRun(root: string, id: string, status: PersistedSubagentStatus): Promise<PersistedSubagentStatus> {
  const afterResult = await reconcilePersistedResult(root, id, status);
  if (afterResult.state !== "running") return afterResult;
  const directory = runDirectory(root, id);
  const failureValue = await loadOptionalJson(failurePath(directory));
  const failure = failureValue === undefined ? orphanedFailure() : decodeFailure(failureValue);
  if (!failure) throw new WorkflowError("INTERNAL_ERROR", "Persisted subagent failure is invalid");
  const failed = reconciledStatus(afterResult, "failed", Math.max(Date.now(), afterResult.startedAt), failure);
  await atomicJson(failurePath(directory), failure);
  await atomicJson(statusPath(directory), failed);
  return failed;
}

type InterruptedWorktreeCleanup = (root: string, id: string, status: PersistedSubagentStatus) => Promise<boolean>;
async function persistReconciliationFailure(root: string, id: string, status: PersistedSubagentStatus, error: unknown): Promise<void> {
  if (status.state !== "running") return;
  let persisted: PersistedSubagentStatus;
  try { persisted = await loadPersistedStatus(root, id); }
  catch { return; }
  if (persisted.state !== "running") return;
  const failure = failureFrom(error);
  const failed = reconciledStatus(persisted, "failed", Math.max(Date.now(), persisted.startedAt), failure);
  try {
    await atomicJson(statusPath(runDirectory(root, id)), failed);
  } catch {
    // A run without a writable status file stays isolated from healthy records.
    return;
  }
  try {
    await atomicJson(failurePath(runDirectory(root, id)), failure);
  } catch {
    // The terminal status retains the recovery failure when its detail file cannot be written.
  }
}
async function reconcilePersistedRuns(root: string, liveness: SubagentLiveness | undefined, cleanupWorktree?: InterruptedWorktreeCleanup): Promise<ReadonlyMap<string, WorkflowError>> {
  await secureDirectory(root);
  const entries = await readdir(root, { withFileTypes: true });
  const errors = new Map<string, WorkflowError>();
  for (const entry of entries) {
    if (!entry.isDirectory() || !validSubagentId(entry.name)) continue;
    let status: PersistedSubagentStatus;
    try {
      status = await loadPersistedStatus(root, entry.name, false);
    } catch (error) {
      if (error instanceof WorkflowError && (error.code === "RUN_NOT_FOUND" || error instanceof InvalidPersistedSubagentStatusError)) continue;
      errors.set(entry.name, error instanceof WorkflowError ? error : internalStorageError(error, `Unable to reconcile subagent ${entry.name} status`));
      continue;
    }
    if (status.state !== "running" && status.worktreeContext === undefined && status.worktree === undefined) continue;
    if (status.state === "running" && status.owner !== undefined && await ownerIsLive(status.owner, liveness)) continue;
    try {
      if (status.state === "running") status = await reconcilePersistedResult(root, entry.name, status);
      let cleaned = false;
      if (status.worktreeContext !== undefined && cleanupWorktree !== undefined) {
        cleaned = await cleanupWorktree(root, entry.name, status);
      }
      if (status.state === "running") status = await reconcilePersistedRun(root, entry.name, status);
      if (cleaned || (status.worktreeContext === undefined && status.worktree !== undefined)) {
        status = withoutOwner(withoutWorktree(status));
        await atomicJson(statusPath(runDirectory(root, entry.name)), status);
      }
    } catch (error) {
      await persistReconciliationFailure(root, entry.name, status, error);
    }
  }
  return errors;
}

function enqueueWrite(run: LiveRun, operation: () => Promise<void>): Promise<void> {
  return run.writes.run(operation);
}

function terminalSummary(run: LiveRun): TerminalSummary {
  return persistedStatus(run);
}

function unavailable(operation: string): { ok: false; error: { code: "SUBAGENTS_NOT_CONFIGURED"; message: string } } {
  return { ok: false, error: { code: "SUBAGENTS_NOT_CONFIGURED", message: `Subagent manager does not implement ${operation} yet.` } };
}

class PersistentSubagentManager implements SubagentManager {
  private readonly activeRuns = new Map<string, LiveRun>();
  private activeRunCount = 0;
  private readonly terminalSummaries = new Map<string, TerminalSummary>();
  private readonly reconciliationErrors = new Map<string, WorkflowError>();
  private readonly notificationPromises = new Set<Promise<void>>();
  private readonly initialization: Promise<void>;
  private readonly worktreeAdapter: NonNullable<SubagentManagerDependencies["worktreeAdapter"]>;
  private initializationError: WorkflowError | undefined;
  private storageOwner: SubagentOwnerLease | undefined;
  private runOwner: SubagentOwnerMarker | undefined;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly dependencies: Readonly<SubagentManagerDependencies>) {
    this.worktreeAdapter = dependencies.worktreeAdapter ?? createRunStoreWorktreeAdapter(defaultWorktreeHome(storageDirectory(dependencies)));
    this.initialization = this.initialize();
  }
  private async initialize(): Promise<void> {
    try {
      const owner = await createOwnerMarker(this.dependencies.liveness);
      this.runOwner = owner;
      this.storageOwner = await acquireStorageOwner(storageDirectory(this.dependencies), owner, this.dependencies.liveness);
      if (!this.storageOwner) return;
      const cleanup = this.worktreeAdapter.cleanup?.bind(this.worktreeAdapter);
      const errors = await reconcilePersistedRuns(storageDirectory(this.dependencies), this.dependencies.liveness, async (_root, _id, status) => {
        const worktreeContext = status.worktreeContext;
        if (!cleanup || !worktreeContext) return false;
        await cleanup(worktreeContext);
        return true;
      });
      for (const [id, error] of errors) this.reconciliationErrors.set(id, error);
    } catch (error: unknown) {
      this.initializationError = error instanceof WorkflowError ? error : internalStorageError(error, "Unable to reconcile subagent storage");
    }
  }

  private async ensureInitialized(): Promise<void> {
    await this.initialization;
    if (this.initializationError) throw this.initializationError;
  }
  async run(request: Readonly<SubagentRunRequest>, context: Readonly<SubagentManagerContext>): Promise<unknown> {
    const run = await this.start(checkedRequest(request), context);
    emitUpdate(run);
    if (run.request.mode !== "foreground") return { id: run.id, state: "running" };
    return run.terminal;
  }

  private async start(snapshot: SubagentRunRequest, context: Readonly<SubagentManagerContext>): Promise<LiveRun> {
    await this.ensureInitialized();
    if (this.disposed) throw new WorkflowError("CANCELLED", "Subagent manager is disposed");
    if (context.signal?.aborted) throw new WorkflowError("CANCELLED", "Subagent cancelled");
    const id = randomUUID();
    const startedAt = Date.now();
    const sessionId = context.extensionContext.sessionManager.getSessionId();
    if (!sessionId.trim()) throw new WorkflowError("INTERNAL_ERROR", "Current Pi session identity is unavailable");
    const owner = this.runOwner;
    if (!owner) throw new WorkflowError("INTERNAL_ERROR", "Subagent storage owner identity is unavailable");
    const concurrency = effectiveConcurrency(context, this.dependencies);
    if (this.activeRunCount >= concurrency) throw new WorkflowError("AGENT_FAILED", `Subagent concurrency limit reached (${String(this.activeRunCount)}/${String(concurrency)} active runs); no queue is maintained. Retry after an active run settles.`);
    this.activeRunCount += 1;
    const controller = new AbortController();
    const initialStatus: PersistedSubagentStatus = { id, sessionId, state: "running", startedAt, owner: { ...owner } };
    let directory: string;
    try {
      directory = await createRunStorage(storageDirectory(this.dependencies), id, snapshot, initialStatus);
    } catch (error) {
      this.activeRunCount -= 1;
      if (error instanceof WorkflowError) throw error;
      throw internalStorageError(error, `Unable to start subagent ${id}`);
    }
    const current: { run?: LiveRun } = {};
    let resolveTerminal!: (result: ForegroundResult) => void;
    const terminal = new Promise<ForegroundResult>((resolve) => { resolveTerminal = resolve; });
    const executorOwnership = { default: true };
    const execution: Promise<unknown> = Promise.resolve().then(async () => {
      const live = current.run;
      if (!live || live.disposed || controller.signal.aborted) throw new WorkflowError("CANCELLED", "Subagent cancelled");
      const worktreeContext = snapshot.worktree === undefined ? undefined : {
        cwd: context.extensionContext.cwd,
        sessionId,
        runId: id,
        name: snapshot.worktree,
        owner: structuralPath("worktree", "named", snapshot.worktree),
      };
      if (worktreeContext !== undefined) {
        live.worktreeContext = worktreeContext;
        await enqueueWrite(live, () => atomicJson(statusPath(live.directory), persistedStatus(live)));
      }
      const worktree = worktreeContext === undefined ? undefined : await this.worktreeAdapter.create(worktreeContext);
      if (worktree) {
        live.worktree = worktree;
        await enqueueWrite(live, () => atomicJson(statusPath(live.directory), persistedStatus(live)));
        if (!this.canSteer(live)) {
          await this.cleanupWorktree(live);
          throw new WorkflowError("CANCELLED", "Subagent cancelled");
        }
      }
      const baseRoot = executionRoot(context, this.dependencies, controller.signal, id, worktree);
      const root = loadingRegistry().modelAliases().length === 0 ? baseRoot : await addDynamicAliases(context, controller.signal, baseRoot);
      const transport = this.dependencies.transport ?? localAgentTransport;
      const injectedExecutor = this.dependencies.createExecutor?.(root, transport);
      executorOwnership.default = injectedExecutor === undefined;
      if (current.run) current.run.executorOwnsSession = executorOwnership.default;
      const setSteer = (handler: SteerHandler): void => {
        const run = current.run;
        if (run) this.registerSteerHandler(run, handler);
      };
      const options = executionOptions(snapshot, async (attempt: unknown) => {
        const run = current.run;
        if (!run) return;
        const record = recordValue(attempt);
        const summary = attemptSummaryValue(attempt);
        const liveSession = isSessionLifecycle(record?.liveSession) ? record.liveSession : undefined;
        const prepared = isPreparedSession(record?.prepared) ? record.prepared : undefined;
        const handoff = isLiveSessionHandoff(record?.handoff) ? record.handoff : undefined;
        if (run.disposed) {
          if (liveSession && !run.executorOwnsSession) void this.cleanupSession(run, true, true, liveSession).catch(() => undefined);
          return;
        }
        if (liveSession) {
          const previousSession = run.session;
          run.activeSessions.add(liveSession);
          run.session = liveSession;
          run.prepared = prepared;
          run.handoff = handoff;
          if (previousSession && previousSession !== liveSession) {
            if (run.executorOwnsSession) run.activeSessions.delete(previousSession);
            else void this.cleanupSession(run, true, false, previousSession).catch(() => undefined);
          }
          if (run.controller.signal.aborted) void this.cleanupSession(run, !run.executorOwnsSession, true, liveSession).catch(() => undefined);
        } else if (summary && record?.session === undefined) {
          run.session = undefined;
          run.prepared = undefined;
          run.handoff = undefined;
        }
        this.recordAttempt(run, attempt, finalizedAttemptValue(attempt));
        try {
          await enqueueWrite(run, () => atomicJson(statusPath(run.directory), persistedStatus(run)));
        } catch {
          // Attempt metadata remains available in memory when status storage is unavailable.
        }
        if (run.state !== "running") return;
        emitUpdate(run);
      }, (progress) => this.recordProgress(current.run, progress));
      if (injectedExecutor) return injectedExecutor.execute(snapshot.prompt, options, controller.signal, setSteer);
      return new WorkflowAgentExecutor(root, transport).execute(snapshot.prompt, options, controller.signal, [], setSteer);
    });
    const onStatus = this.dependencies.onStatus;
    const run: LiveRun = { id, sessionId, request: snapshot, directory, startedAt, owner: { ...owner }, controller, promise: execution, terminal, resolveTerminal, update: snapshot.mode === "foreground" ? context.onUpdate : undefined, observe: onStatus === undefined ? undefined : (status) => { onStatus(status, snapshot); }, state: "running", error: undefined, value: undefined, cancelled: false, session: undefined, sessionCleanups: new WeakMap(), activeSessions: new Set(), prepared: undefined, handoff: undefined, progress: undefined, activeAttempt: undefined, finalizedAttemptAccounting: new Map(), attemptDetails: undefined, attempts: undefined, worktree: undefined, worktreeContext: undefined, worktreeCleanup: undefined, steerHandler: undefined, pendingSteers: [], steerFlush: undefined, externalAbort: undefined, externalSignal: undefined, executorOwnsSession: executorOwnership.default, disposed: false, concurrencyReleased: false, notificationSent: false, terminalResolved: false, writes: new SerialLane() };
    current.run = run;
    this.activeRuns.set(id, run);
    const externalSignal = context.signal;
    if (externalSignal) {
      const abort = () => { this.abortRun(run); };
      run.externalAbort = abort;
      run.externalSignal = externalSignal;
      externalSignal.addEventListener("abort", abort, { once: true });
      if (externalSignal.aborted) this.abortRun(run);
    }
    this.observe(run);
    return run;
  }
  getAttemptActionData(id: string): Readonly<SubagentAttemptActionData> | undefined {
    const run = this.activeRuns.get(id);
    const attempt = run?.attemptDetails?.at(-1);
    if (!run || run.disposed || !attempt) return undefined;
    const liveSession = isLiveSession(run.session) ? run.session : undefined;
    const live = run.state === "running" && liveSession && attempt.session && liveSession.reference.transport === attempt.session.transport && liveSession.reference.sessionId === attempt.session.sessionId ? liveSession : undefined;
    return {
      attempt: structuredClone(attempt),
      ...(attempt.session === undefined ? {} : { session: structuredClone(attempt.session) }),
      ...(live === undefined ? {} : { liveSession: live, ...(run.prepared === undefined ? {} : { prepared: run.prepared }), ...(run.handoff === undefined ? {} : { handoff: run.handoff }) }),
      signal: run.controller.signal,
    };
  }

  async inspect(request: Readonly<SubagentInspectRequest>, context: Readonly<SubagentManagerContext>): Promise<unknown> {
    await this.ensureInitialized();
    if (request.id !== undefined) {
      const id = checkedId({ id: request.id });
      const active = this.activeRuns.get(id);
      const status = active ? persistedStatus(active) : this.terminalSummaries.get(id) ?? await loadPersistedStatus(storageDirectory(this.dependencies), id);
      const inspection = publicStatus(status, context.includeAttemptMetadata === true);
      if (status.state === "completed") return { ...inspection, value: await loadPersistedResult(storageDirectory(this.dependencies), id) };
      if (status.state === "failed") {
        const failure = status.error ?? await loadPersistedFailure(storageDirectory(this.dependencies), id);
        return { ...inspection, error: { ...failure } };
      }
      return inspection;
    }
    return this.inspectList();
  }
  private async inspectList(): Promise<unknown> {
    const root = storageDirectory(this.dependencies);
    await secureDirectory(root);
    const entries = await readdir(root, { withFileTypes: true });
    const statuses: Array<{ readonly status: SubagentStatus; readonly startedAt: number }> = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || !validSubagentId(entry.name)) continue;
      // Keep list/reconciliation available; direct lookup still re-reads and reports the error.
      if (this.reconciliationErrors.has(entry.name)) continue;
      try {
        const active = this.activeRuns.get(entry.name);
        const status = publicStatus(active ? persistedStatus(active) : this.terminalSummaries.get(entry.name) ?? await loadPersistedStatus(root, entry.name, false));
        if (status.startedAt === undefined) continue;
        statuses.push({ status, startedAt: status.startedAt });
      } catch (error) {
        if (error instanceof WorkflowError && (error.code === "RUN_NOT_FOUND" || error instanceof InvalidPersistedSubagentStatusError)) continue;
        throw error;
      }
    }
    statuses.sort((left, right) => left.startedAt - right.startedAt || (left.status.id < right.status.id ? -1 : left.status.id > right.status.id ? 1 : 0));
    return statuses.map(({ status }) => status);
  }

  async steer(request: Readonly<{ id: string; message: string }>): Promise<unknown> {
    const id = checkedId(request);
    if (typeof request.message !== "string") throw new WorkflowError("INVALID_METADATA", "Invalid subagents_steer parameters");
    await this.ensureInitialized();
    const run = this.activeRuns.get(id);
    if (!run || !this.canSteer(run)) throw new WorkflowError("AGENT_FAILED", `Subagent ${id} is not running`);
    if (run.pendingSteers.length + (run.steerFlush === undefined ? 0 : 1) >= MAX_PENDING_STEERING_MESSAGES) throw new WorkflowError("AGENT_FAILED", `Steering queue is full for subagent ${id}`);
    run.pendingSteers.push(request.message);
    this.flushSteers(run);
    return { id, accepted: true };
  }

  async stop(request: Readonly<{ id: string }>): Promise<unknown> {
    const id = checkedId(request);
    await this.ensureInitialized();
    const run = this.activeRuns.get(id);
    if (!run) return publicStatus(await loadPersistedStatus(storageDirectory(this.dependencies), id));
    if (run.state !== "running") return publicStatus(persistedStatus(run));
    await this.stopRun(run, false);
    return publicStatus(persistedStatus(run));
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposePromise = (async () => {
      await this.initialization;
      this.disposed = true;
      const runs = [...this.activeRuns.values()];
      await Promise.allSettled(runs.map((run) => this.stopRun(run, true)));
      await Promise.allSettled([...this.notificationPromises]);
      const owner = this.storageOwner;
      this.storageOwner = undefined;
      await owner?.release();
    })();
    return this.disposePromise;
  }

  async retry(request: Readonly<{ id: string }>, context: Readonly<SubagentManagerContext>): Promise<unknown> {
    const id = checkedId(request);
    await this.ensureInitialized();
    const active = this.activeRuns.get(id);
    const status = active ? persistedStatus(active) : this.terminalSummaries.get(id) ?? await loadPersistedStatus(storageDirectory(this.dependencies), id);
    if (status.state !== "failed" && status.state !== "stopped") throw new WorkflowError("AGENT_FAILED", `Subagent ${id} is not retryable`);
    const requestSnapshot = await loadPersistedRequest(storageDirectory(this.dependencies), id);
    const retryRequest = context.waitForForeground === false && requestSnapshot.mode === "foreground" ? { ...requestSnapshot, mode: "background" as const } : requestSnapshot;
    const run = await this.start(retryRequest, context);
    emitUpdate(run);
    if (run.request.mode !== "foreground") return { id: run.id, state: "running" };
    return run.terminal;
  }

  private releaseConcurrency(run: LiveRun): void {
    if (run.concurrencyReleased) return;
    run.concurrencyReleased = true;
    this.activeRunCount -= 1;
  }

  private canSteer(run: LiveRun): boolean {
    return !run.disposed && run.state === "running" && !run.controller.signal.aborted;
  }
  private terminalOrDisposed(run: LiveRun): boolean { return run.disposed || run.state === "stopped"; }

  private registerSteerHandler(run: LiveRun, handler: SteerHandler): void {
    if (!this.canSteer(run)) {
      run.pendingSteers.length = 0;
      return;
    }
    run.steerHandler = handler;
    this.flushSteers(run);
  }

  private flushSteers(run: LiveRun): void {
    if (!run.steerHandler || run.steerFlush || run.disposed) return;
    const flush = (async () => {
      while (run.pendingSteers.length > 0) {
        if (!this.canSteer(run)) {
          run.pendingSteers.length = 0;
          return;
        }
        const message = run.pendingSteers.shift();
        const handler = run.steerHandler;
        if (message === undefined || !handler) {
          if (message !== undefined) run.pendingSteers.unshift(message);
          return;
        }
        try {
          const result = handler(message);
          if (result && typeof result === "object" && "then" in result && typeof result.then === "function") await result;
        } catch {
          run.steerHandler = undefined;
          run.pendingSteers.length = 0;
          return;
        }
      }
    })();
    run.steerFlush = flush;
    void flush.then(() => {
      if (run.steerFlush === flush) run.steerFlush = undefined;
      if (this.canSteer(run) && run.steerHandler && run.pendingSteers.length > 0) this.flushSteers(run);
    }, () => {
      if (run.steerFlush === flush) run.steerFlush = undefined;
      run.pendingSteers.length = 0;
    });
  }

  private abortRun(run: LiveRun): void {
    if (run.disposed || run.state !== "running") return;
    if (run.request.mode === "foreground") run.cancelled = true;
    run.controller.abort();
    this.clearSteering(run);
    void this.cleanupSessions(run, false).catch(() => undefined);
    if (run.request.mode === "foreground") void this.settleFailure(run, new WorkflowError("CANCELLED", "Subagent cancelled")).catch(() => undefined);
  }

  private clearSteering(run: LiveRun): void {
    run.steerHandler = undefined;
    run.pendingSteers.length = 0;
  }

  private async recordProgress(run: LiveRun | undefined, progress: AgentProgress): Promise<void> {
    if (!run || !this.canSteer(run)) return;
    if (run.activeAttempt !== undefined && run.finalizedAttemptAccounting.has(run.activeAttempt)) return;
    const snapshot = portableProgress(progress, true);
    const accounting = addAccounting(sumAccounting(run.finalizedAttemptAccounting.values()), progress.accounting);
    // Agent progress is a current-attempt snapshot. Do not retain a field-wise maximum: it can combine values from different snapshots.
    run.progress = { ...snapshot, accounting };
    emitUpdate(run);
    if (!progress.persist) return;
    await enqueueWrite(run, () => atomicJson(statusPath(run.directory), persistedStatus(run)));
  }

  private recordAttempt(run: LiveRun, value: unknown, finalized = false): void {
    const record = recordValue(value);
    const attempt = attemptNumberValue(value);
    if (attempt !== undefined) run.activeAttempt = attempt;
    const summary = attemptSummaryValue(value);
    if (summary) {
      run.attempts = Math.max(run.attempts ?? 0, summary.attempt);
      run.attemptDetails = [...(run.attemptDetails ?? []), summary].slice(-SUBAGENT_ATTEMPT_DETAILS_LIMIT);
    }
    if (!finalized) return;
    const accounting = summary?.accounting ?? accountingValue(record?.accounting);
    if (attempt === undefined || accounting === undefined) return;
    if (run.finalizedAttemptAccounting.size >= MAX_PERSISTED_ATTEMPT_ARRAY_ITEMS && !run.finalizedAttemptAccounting.has(attempt)) return;
    run.finalizedAttemptAccounting.set(attempt, accounting);
    const cumulative = sumAccounting(run.finalizedAttemptAccounting.values());
    run.progress = run.progress === undefined ? { accounting: cumulative, toolCalls: [] } : { ...run.progress, accounting: cumulative };
  }


  private async stopRun(run: LiveRun, disposeSession: boolean): Promise<void> {
    if (run.state === "running") {
      run.state = "stopped";
      this.releaseConcurrency(run);
      run.finishedAt = Date.now();
      emitUpdate(run);
      const sessionCleanup = this.cleanupSessions(run, disposeSession);
      run.controller.abort();
      this.clearSteering(run);
      this.removeExternalAbort(run);
      let statusError: unknown;
      try {
        await enqueueWrite(run, () => atomicJson(statusPath(run.directory), persistedStatus(run)));
      } catch (error) {
        statusError = error;
      }
      const cleanupErrors = await sessionCleanup;
      if (disposeSession) this.clearAttemptLiveReferences(run);
      else {
        run.prepared = undefined;
        run.handoff = undefined;
      }
      let worktreeError: unknown;
      let worktreeCleaned = false;
      try {
        worktreeCleaned = await this.cleanupWorktree(run);
      } catch (error) {
        worktreeError = error;
      }
      if (worktreeCleaned) {
        try {
          await enqueueWrite(run, () => atomicJson(statusPath(run.directory), persistedStatus(run)));
        } catch (error) {
          statusError ??= error;
        }
      }
      emitUpdate(run);
      this.resolveTerminal(run);
      if (disposeSession) {
        run.disposed = true;
        this.removeLiveRun(run);
      }
      if (statusError) throw internalStorageError(statusError, `Unable to stop subagent ${run.id}`);
      if (cleanupErrors.length > 0) throw new WorkflowError("INTERNAL_ERROR", `Unable to stop subagent ${run.id}: ${errorText(cleanupErrors[0])}`);
      if (worktreeError) throw new WorkflowError("WORKTREE_FAILED", `Unable to clean up subagent ${run.id} worktree: ${errorText(worktreeError)}`);
      return;
    }
    if (disposeSession) {
      run.disposed = true;
      this.clearSteering(run);
      await this.cleanupSessions(run, true);
      const worktreeCleaned = await this.cleanupWorktree(run);
      if (worktreeCleaned) await enqueueWrite(run, () => atomicJson(statusPath(run.directory), persistedStatus(run)));
      this.resolveTerminal(run);
      this.removeLiveRun(run);
    }
  }

  private async cleanupSessions(run: LiveRun, dispose: boolean, abort = true): Promise<unknown[]> {
    const errors: unknown[] = [];
    for (const session of [...run.activeSessions]) errors.push(...await this.cleanupSession(run, dispose, abort, session));
    return errors;
  }

  private async waitForSessionAborts(run: LiveRun): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const session of run.activeSessions) {
      const abort = run.sessionCleanups.get(session)?.abort;
      if (abort) pending.push(abort);
    }
    await Promise.allSettled(pending);
  }

  private async cleanupSession(run: LiveRun, dispose: boolean, abort = true, session = run.session): Promise<unknown[]> {
    if (!session) return [];
    run.activeSessions.add(session);
    let cleanup = run.sessionCleanups.get(session);
    if (!cleanup) {
      cleanup = {};
      run.sessionCleanups.set(session, cleanup);
    }
    const errors: unknown[] = [];
    if (abort) {
      if (!cleanup.abort) cleanup.abort = Promise.resolve().then(() => session.abort());
      await cleanup.abort.then(() => undefined, (error: unknown) => { errors.push(error); });
    }
    if (dispose) {
      if (!abort && cleanup.abort) await cleanup.abort.then(() => undefined, () => undefined);
      if (!cleanup.dispose) cleanup.dispose = Promise.resolve().then(() => session.dispose());
      await cleanup.dispose.then(() => undefined, (error: unknown) => { errors.push(error); });
      run.activeSessions.delete(session);
      if (run.session === session) run.session = undefined;
    }
    return errors;
  }

  private clearAttemptLiveReferences(run: LiveRun): void {
    run.session = undefined;
    run.activeSessions.clear();
    run.prepared = undefined;
    run.handoff = undefined;
  }

  private async cleanupWorktree(run: LiveRun): Promise<boolean> {
    const worktree = run.worktree;
    let cleanup = run.worktreeCleanup;
    if (cleanup === undefined) {
      if (!worktree || run.worktreeContext === undefined) return false;
      cleanup = Promise.resolve().then(() => worktree.cleanup());
      run.worktreeCleanup = cleanup;
    }
    await cleanup;
    run.worktree = undefined;
    run.worktreeContext = undefined;
    return true;
  }

  private removeExternalAbort(run: LiveRun): void {
    const listener = run.externalAbort;
    const signal = run.externalSignal;
    if (listener && signal) signal.removeEventListener("abort", listener);
    run.externalAbort = undefined;
    run.externalSignal = undefined;
  }

  private observe(run: LiveRun): void {
    void run.promise.then(
      (result) => this.settleSuccess(run, result),
      (error: unknown) => this.settleFailure(run, error),
    ).catch((error: unknown) => this.settleFailure(run, error)).catch(() => undefined);
  }

  private async settleSuccess(run: LiveRun, result: unknown): Promise<void> {
    if (run.disposed || run.state !== "running") {
      if (!run.disposed && run.state === "stopped") await this.finishTerminal(run);
      return;
    }
    try {
      const executionResult = executionResultValue(result);
      if (!executionResult) throw new WorkflowError("INTERNAL_ERROR", "Subagent executor returned an invalid result");
      for (const attempt of executionResult.attempts) this.recordAttempt(run, attempt, true);
      const value = structuredClone(executionResult.value);
      await enqueueWrite(run, () => atomicJson(resultPath(run.directory), value));
      run.value = value;
      if (this.terminalOrDisposed(run)) {
        await this.finishTerminal(run);
        return;
      }
      run.state = "completed";
      this.releaseConcurrency(run);
      run.finishedAt = Date.now();
      await this.finishTerminal(run);
    } catch (error) {
      await this.settleFailure(run, error);
    }
  }

  private async settleFailure(run: LiveRun, error: unknown): Promise<void> {
    if (run.disposed || run.state !== "running") {
      if (!run.disposed && run.state === "stopped") await this.finishTerminal(run);
      return;
    }
    const candidate = recordValue(error)?.attempts;
    if (Array.isArray(candidate)) {
      for (const attempt of candidate.slice(0, MAX_PERSISTED_ATTEMPT_ARRAY_ITEMS)) {
        const record = recordValue(attempt);
        if (record) this.recordAttempt(run, attempt, true);
      }
    }
    run.state = "failed";
    this.releaseConcurrency(run);
    run.error = run.cancelled ? { code: "CANCELLED", message: "Subagent cancelled" } : failureFrom(error);
    run.finishedAt = Date.now();
    try {
      await enqueueWrite(run, () => atomicJson(failurePath(run.directory), run.error));
    } catch (persistenceError) {
      run.error = { code: "INTERNAL_ERROR", message: errorText(persistenceError) };
    }
    await this.finishTerminal(run);
  }

  private resolveTerminal(run: LiveRun): void {
    if (run.terminalResolved) return;
    run.terminalResolved = true;
    if (run.state === "completed" && run.value !== undefined) {
      run.resolveTerminal({ id: run.id, state: "completed", value: structuredClone(run.value) });
      return;
    }
    if (run.state === "failed") {
      run.resolveTerminal({ id: run.id, state: "failed", error: { ...(run.error ?? { code: "AGENT_FAILED", message: "Subagent failed" }) } });
      return;
    }
    run.resolveTerminal({ id: run.id, state: "stopped" });
  }

  private async finishTerminal(run: LiveRun): Promise<void> {
    if (run.disposed) {
      this.resolveTerminal(run);
      return;
    }
    run.finishedAt ??= Date.now();
    emitUpdate(run);
    this.clearSteering(run);
    this.removeExternalAbort(run);
    if (!run.executorOwnsSession) await this.cleanupSessions(run, true, false);
    else if (run.request.mode === "foreground") await this.waitForSessionAborts(run);
    this.clearAttemptLiveReferences(run);
    try {
      await this.cleanupWorktree(run);
    } catch {
      // Keep the terminal result and recovery context when cleanup must be retried later.
    }
    emitUpdate(run);
    try {
      await enqueueWrite(run, () => atomicJson(statusPath(run.directory), persistedStatus(run)));
    } catch {
      // The terminal state remains available in memory when storage becomes unavailable.
    }
    this.resolveTerminal(run);
    this.removeLiveRun(run);
    if (run.state === "completed" || run.state === "failed") this.notify(run);
  }

  private notify(run: LiveRun): void {
    if (run.request.mode === "foreground") return;
    const notify = this.dependencies.notify;
    if (!notify || run.notificationSent || run.disposed) return;
    run.notificationSent = true;
    const role = roleNameOf(run.request.role) ?? "none";
    const label = run.request.label?.trim() || (role === "none" ? "subagent" : role);
    const notification: SubagentNotification = { id: run.id, label, role, state: run.state as "completed" | "failed", ...(run.error === undefined ? {} : { error: run.error }) };
    const pending = Promise.resolve().then(() => notify(notification));
    this.notificationPromises.add(pending);
    void pending.then(() => { this.notificationPromises.delete(pending); }, () => { this.notificationPromises.delete(pending); });
  }

  private removeLiveRun(run: LiveRun): void {
    if (this.activeRuns.get(run.id) !== run) return;
    this.activeRuns.delete(run.id);
    this.terminalSummaries.delete(run.id);
    this.terminalSummaries.set(run.id, terminalSummary(run));
    while (this.terminalSummaries.size > MAX_TERMINAL_SUMMARIES) {
      const oldest = this.terminalSummaries.keys().next().value;
      if (oldest === undefined) break;
      this.terminalSummaries.delete(oldest);
    }
  }
}

export function createUnavailableSubagentManager(): SubagentManager {
  return {
    run: async () => unavailable("run"),
    inspect: async () => unavailable("inspect"),
    steer: async () => unavailable("steer"),
    stop: async () => unavailable("stop"),
    retry: async () => unavailable("retry"),
  };
}
export function createSubagentManager(dependencies: SubagentManagerDependencies = {}): SubagentManager {
  const manager: SubagentManager = new PersistentSubagentManager(dependencies);
  return {
    run: (request, context) => manager.run(request, context),
    inspect: (request, context) => manager.inspect(request, context),
    getAttemptActionData: (id) => manager.getAttemptActionData?.(id),
    steer: (request, context) => manager.steer(request, context),
    stop: (request, context) => manager.stop(request, context),
    retry: (request, context) => manager.retry(request, context),
    dispose: async () => { await manager.dispose?.(); },
  };
}
