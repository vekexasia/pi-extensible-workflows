import { AGENT_STATES, RUN_STATES, THINKING_LEVELS, type AgentAccounting, type AgentActivity, type AgentAttemptSummary, type AgentContinuity, type AgentDefinition, type AgentRecord, type AgentResourceInspection, type AgentResourceSelectors, type BudgetApprovalRequest, type BudgetDimension, type BudgetEvent, type ContextFileScope, type JsonValue, type LaunchSnapshot, type ModelSpec, type RunRecord, type WorkflowBudgetUsage, type WorkflowRetentionSettings, type WorkflowRunEvent } from "./types.js";
import type { OwnershipRecord, ScheduledAgentOptions } from "./agent-execution.js";
import { finiteNumber, isWorkflowErrorCode, jsonValue, object } from "./utils.js";

export interface EffectiveSystemPrompt { sessionId: string; attempt: number; turn: number; sha256: string; prompt: string }
export type PersistedRun = RunRecord;
export interface RunSummaryAgent { id: string; name: string; label?: string; state: string; role?: string; attempts: number }
export interface RunSummaryArtifacts { runDirectory: string; statePath: string; journalPath: string; snapshotPath: string; workflowPath: string; resultPath: string; summaryPath: string }
export interface RunSummary { schemaVersion: 1; runId: string; sessionId: string; workflowName: string; state: RunRecord["state"]; createdAt: string; updatedAt: string; terminalAt?: string; usage: WorkflowBudgetUsage; agents: readonly RunSummaryAgent[]; error?: RunRecord["error"]; failedAt?: string; replayablePaths: readonly string[]; incompletePaths: readonly string[]; artifacts: RunSummaryArtifacts }
export interface CompletedOperation { path: string; value: JsonValue }
export interface AwaitingCheckpoint { path: string; name: string; prompt: string; context: JsonValue }
export type PendingWorkflowDecision = BudgetApprovalRequest
export type PersistedOwnershipNode = OwnershipRecord
export type Journal = { completed: Record<string, CompletedOperation>; awaiting?: Record<string, AwaitingCheckpoint>; decisions?: Record<string, PendingWorkflowDecision> };
type PersistedAgentSession = RunRecord["agentSessions"][number];
type PersistedAgent = RunRecord["agents"][number];
type PersistedPhaseRecord = NonNullable<RunRecord["phaseHistory"]>[number];
type PersistedShellActivity = NonNullable<RunRecord["activeShellsByPhase"]>[number];
type PersistedDelivery = NonNullable<RunRecord["delivery"]>;
type PersistedIdentity = NonNullable<ScheduledAgentOptions["agentIdentity"]>;
type PersistedOptions = ScheduledAgentOptions;

const INVALID_PERSISTED_VALUE = Symbol("invalid persisted value");

function integer(value: unknown): value is number { return finiteNumber(value) && Number.isInteger(value); }
function safePositiveInteger(value: unknown): value is number { return integer(value) && Number.isSafeInteger(value) && value > 0; }
export function positiveInteger(value: unknown): value is number { return integer(value) && value > 0; }
function isThinking(value: unknown): value is NonNullable<ModelSpec["thinking"]> { return THINKING_LEVELS.some((level) => level === value); }
function isContextFileScope(value: unknown): value is ContextFileScope { return ["global", "project", "cwd"].some((candidate) => candidate === value); }
function isLaunchMode(value: unknown): value is NonNullable<LaunchSnapshot["launchMode"]> { return value === "foreground" || value === "background"; }
function isRunState(value: unknown): value is RunRecord["state"] { return RUN_STATES.some((candidate) => candidate === value); }
function isAgentState(value: unknown): value is PersistedAgent["state"] { return AGENT_STATES.some((candidate) => candidate === value); }
function isAgentContinuity(value: unknown): value is AgentContinuity { return value === "fresh" || value === "continued"; }
function isBudgetDimension(value: unknown): value is BudgetDimension { return ["tokens", "costUsd", "durationMs", "agentLaunches"].some((candidate) => candidate === value); }
function isBudgetEventType(value: unknown): value is NonNullable<RunRecord["budgetEvents"]>[number]["type"] { return ["soft_crossed", "hard_overrun", "hard_exhausted", "adjustment_requested", "adjustment_approved", "adjustment_rejected"].some((candidate) => candidate === value); }
function optionalString(value: unknown): string | undefined | typeof INVALID_PERSISTED_VALUE { return value === undefined || typeof value === "string" ? value : INVALID_PERSISTED_VALUE; }
function optionalNumber(value: unknown): number | undefined | typeof INVALID_PERSISTED_VALUE { return value === undefined || finiteNumber(value) ? value : INVALID_PERSISTED_VALUE; }
function optionalBoolean(value: unknown): boolean | undefined | typeof INVALID_PERSISTED_VALUE { return value === undefined || typeof value === "boolean" ? value : INVALID_PERSISTED_VALUE; }
function decodeArray<T>(value: unknown, decoder: (value: unknown) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const decoded: T[] = [];
  for (const entry of value) {
    const result = decoder(entry);
    if (result === undefined) return undefined;
    decoded.push(result);
  }
  return decoded;
}
function decodeStringArray(value: unknown): string[] | undefined { return decodeArray(value, (entry) => typeof entry === "string" ? entry : undefined); }
function decodeJsonValue(value: unknown): JsonValue | undefined { return jsonValue(value) ? value : undefined; }
function decodeJsonObject(value: unknown): Record<string, JsonValue> | undefined {
  if (!object(value) || !jsonValue(value)) return undefined;
  const entries: Array<[string, JsonValue]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (!jsonValue(entry)) return undefined;
    entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}
function decodeStringMap(value: unknown): Record<string, string> | undefined {
  if (!object(value)) return undefined;
  const entries: Array<[string, string]> = [];
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") return undefined;
    entries.push([key, entry]);
  }
  return Object.fromEntries(entries);
}
function decodeRecord<T>(value: unknown, decoder: (value: unknown) => T | undefined): Record<string, T> | undefined {
  if (!object(value)) return undefined;
  const entries: Array<[string, T]> = [];
  for (const [key, entry] of Object.entries(value)) {
    const decoded = decoder(entry);
    if (decoded === undefined) return undefined;
    entries.push([key, decoded]);
  }
  return Object.fromEntries(entries);
}

function decodeModelSpec(value: unknown): ModelSpec | undefined {
  if (!object(value) || typeof value.provider !== "string" || typeof value.model !== "string") return undefined;
  const thinking = value.thinking;
  if (thinking !== undefined && !isThinking(thinking)) return undefined;
  return { provider: value.provider, model: value.model, ...(isThinking(thinking) ? { thinking } : {}) };
}
function decodeAgentResourceSelectors(value: unknown): AgentResourceSelectors | undefined {
  if (!object(value)) return undefined;
  const skills = value.skills === undefined ? undefined : decodeStringArray(value.skills);
  const extensions = value.extensions === undefined ? undefined : decodeStringArray(value.extensions);
  const tools = value.tools === undefined ? undefined : decodeStringArray(value.tools);
  if (value.skills !== undefined && !skills || value.extensions !== undefined && !extensions || value.tools !== undefined && !tools) return undefined;
  return { ...(skills === undefined ? {} : { skills }), ...(extensions === undefined ? {} : { extensions }), ...(tools === undefined ? {} : { tools }) };
}
function decodeContextFileScopes(value: unknown): ContextFileScope[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const scopes: ContextFileScope[] = [];
  for (const scope of value) {
    if (!isContextFileScope(scope)) return undefined;
    scopes.push(scope);
  }
  return scopes;
}
function decodeAgentDefinition(value: unknown): AgentDefinition | undefined {
  if (!object(value)) return undefined;
  const prompt = optionalString(value.prompt);
  const description = optionalString(value.description);
  const model = optionalString(value.model);
  const thinking = value.thinking;
  const tools = value.tools === undefined ? undefined : decodeStringArray(value.tools);
  const skills = value.skills === undefined ? undefined : decodeStringArray(value.skills);
  const extensions = value.extensions === undefined ? undefined : decodeStringArray(value.extensions);
  const overrideSystemPrompt = optionalBoolean(value.overrideSystemPrompt);
  const contextFiles = value.contextFiles === undefined ? undefined : decodeContextFileScopes(value.contextFiles);
  if (prompt === INVALID_PERSISTED_VALUE || description === INVALID_PERSISTED_VALUE || model === INVALID_PERSISTED_VALUE || overrideSystemPrompt === INVALID_PERSISTED_VALUE) return undefined;
  if (thinking !== undefined && !isThinking(thinking) || value.tools !== undefined && !tools || value.skills !== undefined && !skills || value.extensions !== undefined && !extensions || value.contextFiles !== undefined && !contextFiles) return undefined;
  const foldedModel = typeof model === "string" && thinking !== undefined && !model.includes(":") ? `${model}:${thinking}` : model;
  return {
    ...(prompt === undefined ? {} : { prompt }), ...(description === undefined ? {} : { description }), ...(foldedModel === undefined ? {} : { model: foldedModel }),
    ...(tools === undefined ? {} : { tools }), ...(skills === undefined ? {} : { skills }), ...(extensions === undefined ? {} : { extensions }), ...(overrideSystemPrompt === undefined ? {} : { overrideSystemPrompt }), ...(contextFiles === undefined ? {} : { contextFiles }),
  };
}
function decodeWorkflowMetadata(value: unknown): LaunchSnapshot["metadata"] | undefined {
  if (!object(value) || typeof value.name !== "string") return undefined;
  const description = optionalString(value.description);
  if (description === INVALID_PERSISTED_VALUE) return undefined;
  return { name: value.name, ...(description === undefined ? {} : { description }) };
}
function decodeWorkflowExtensions(value: unknown): { herdr?: { enableFullyInspectableMode?: boolean }; trajectory?: { port?: number; themes: boolean } } | undefined {
  if (!object(value) || Object.keys(value).some((key) => key !== "herdr" && key !== "trajectory")) return undefined;
  const herdr = value.herdr === undefined ? undefined : (() => {
    if (!object(value.herdr) || Object.keys(value.herdr).some((key) => key !== "enableFullyInspectableMode")) return undefined;
    const enableFullyInspectableMode = optionalBoolean(value.herdr.enableFullyInspectableMode);
    if (enableFullyInspectableMode === INVALID_PERSISTED_VALUE) return undefined;
    return { enableFullyInspectableMode };
  })();
  if (value.herdr !== undefined && herdr === undefined) return undefined;
  const trajectory = value.trajectory === undefined ? undefined : (() => {
    if (!object(value.trajectory) || Object.keys(value.trajectory).some((key) => key !== "port" && key !== "themes")) return undefined;
    const port = value.trajectory.port;
    if (port !== undefined && (!safePositiveInteger(port) || port > 65535)) return undefined;
    const themes = optionalBoolean(value.trajectory.themes);
    if (themes === INVALID_PERSISTED_VALUE) return undefined;
    return { ...(port === undefined ? {} : { port }), themes: themes ?? false };
  })();
  if (value.trajectory !== undefined && trajectory === undefined) return undefined;
  return { ...(herdr === undefined ? {} : { herdr: { ...(herdr.enableFullyInspectableMode === undefined ? {} : { enableFullyInspectableMode: herdr.enableFullyInspectableMode }) } }), ...(trajectory === undefined ? {} : { trajectory }) };
}
function decodeBudgetLimits(value: unknown): NonNullable<NonNullable<RunRecord["budget"]>[BudgetDimension]> | undefined {
  if (!object(value)) return undefined;
  const soft = optionalNumber(value.soft);
  const hard = optionalNumber(value.hard);
  if (soft === INVALID_PERSISTED_VALUE || hard === INVALID_PERSISTED_VALUE) return undefined;
  return { ...(soft === undefined ? {} : { soft }), ...(hard === undefined ? {} : { hard }) };
}
function decodeBudget(value: unknown): NonNullable<RunRecord["budget"]> | undefined {
  if (!object(value)) return undefined;
  const budget: NonNullable<RunRecord["budget"]> = {};
  for (const dimension of ["tokens", "costUsd", "durationMs", "agentLaunches"] as const) {
    const raw = value[dimension];
    if (raw === undefined) continue;
    const limits = decodeBudgetLimits(raw);
    if (limits === undefined) return undefined;
    budget[dimension] = limits;
  }
  return budget;
}
function decodeRetention(value: unknown): Readonly<WorkflowRetentionSettings> | typeof INVALID_PERSISTED_VALUE {
  if (!object(value) || Object.keys(value).some((key) => key !== "olderThanDays" && key !== "maxTerminalRuns")) return INVALID_PERSISTED_VALUE;
  const olderThanDays = value.olderThanDays;
  const maxTerminalRuns = value.maxTerminalRuns;
  if (olderThanDays !== undefined && !safePositiveInteger(olderThanDays) || maxTerminalRuns !== undefined && !safePositiveInteger(maxTerminalRuns)) return INVALID_PERSISTED_VALUE;
  return Object.freeze({ ...(olderThanDays === undefined ? {} : { olderThanDays }), ...(maxTerminalRuns === undefined ? {} : { maxTerminalRuns }) });
}
function decodeWorkflowSettings(value: unknown): LaunchSnapshot["settings"] | undefined {
  if (!object(value) || !positiveInteger(value.concurrency)) return undefined;
  const backgroundWidget = optionalBoolean(value.backgroundWidget);
  const modelAliases = value.modelAliases === undefined ? undefined : decodeStringMap(value.modelAliases);
  const skills = value.skills === undefined ? undefined : decodeStringArray(value.skills);
  const tools = value.tools === undefined ? undefined : decodeStringArray(value.tools);
  const legacyExtensionSettings = value.extensions !== undefined && object(value.extensions) ? decodeWorkflowExtensions(value.extensions) : undefined;
  const extensions = value.extensions === undefined || object(value.extensions) ? undefined : decodeStringArray(value.extensions);
  const extensionSettings = value.extensionSettings === undefined ? undefined : decodeWorkflowExtensions(value.extensionSettings);
  const effectiveExtensionSettings = extensionSettings ?? legacyExtensionSettings;
  const retention = value.retention === undefined ? undefined : decodeRetention(value.retention);
  if (backgroundWidget === INVALID_PERSISTED_VALUE || (value.modelAliases !== undefined && !modelAliases) || value.skills !== undefined && !skills || value.tools !== undefined && !tools || value.extensions !== undefined && !extensions && !legacyExtensionSettings || value.extensionSettings !== undefined && !extensionSettings || retention === INVALID_PERSISTED_VALUE) return undefined;
  return {
    concurrency: value.concurrency,
    ...(backgroundWidget === undefined ? {} : { backgroundWidget }), ...(modelAliases === undefined ? {} : { modelAliases }), ...(skills === undefined ? {} : { skills }), ...(tools === undefined ? {} : { tools }),
    ...(extensions === undefined ? {} : { extensions }), ...(effectiveExtensionSettings === undefined ? {} : { extensionSettings: effectiveExtensionSettings }), ...(retention === undefined ? {} : { retention }),
  };
}
function decodeWorkflowSettingsSources(value: unknown): NonNullable<LaunchSnapshot["settingsSources"]> | undefined {
  if (!object(value) || typeof value.concurrency !== "string" || typeof value.modelAliases !== "string") return undefined;
  const skills = value.skills === undefined ? undefined : typeof value.skills === "string" ? value.skills : undefined;
  const extensions = value.extensions === undefined ? undefined : typeof value.extensions === "string" ? value.extensions : undefined;
  const tools = value.tools === undefined ? undefined : typeof value.tools === "string" ? value.tools : undefined;
  const extensionSettings = value.extensionSettings === undefined ? undefined : typeof value.extensionSettings === "string" ? value.extensionSettings : undefined;
  const retention = value.retention === undefined ? undefined : typeof value.retention === "string" ? value.retention : undefined;
  if (value.skills !== undefined && skills === undefined || value.extensions !== undefined && extensions === undefined || value.tools !== undefined && tools === undefined || value.extensionSettings !== undefined && extensionSettings === undefined || value.retention !== undefined && retention === undefined) return undefined;
  return { concurrency: value.concurrency, modelAliases: value.modelAliases, ...(skills === undefined ? {} : { skills }), ...(extensions === undefined ? {} : { extensions }), ...(tools === undefined ? {} : { tools }), ...(extensionSettings === undefined ? {} : { extensionSettings }), ...(retention === undefined ? {} : { retention }) };
}
function decodeIdentity(value: unknown): PersistedIdentity | undefined {
  if (!object(value) || typeof value.callSite !== "string" || !positiveInteger(value.occurrence)) return undefined;
  const structuralPath = decodeStringArray(value.structuralPath);
  const parentBreadcrumb = optionalString(value.parentBreadcrumb);
  const worktreeOwner = optionalString(value.worktreeOwner);
  const handle = optionalString(value.handle);
  if (!structuralPath || parentBreadcrumb === INVALID_PERSISTED_VALUE || worktreeOwner === INVALID_PERSISTED_VALUE || handle === INVALID_PERSISTED_VALUE || handle !== undefined && !positiveInteger(value.turn)) return undefined;
  return { structuralPath, callSite: value.callSite, occurrence: value.occurrence, ...(parentBreadcrumb === undefined ? {} : { parentBreadcrumb }), ...(worktreeOwner === undefined ? {} : { worktreeOwner }), ...(handle === undefined ? {} : { handle, turn: value.turn as number }) };
}
function decodeScheduledAgentOptions(value: unknown): PersistedOptions | undefined {
  if (!object(value) || typeof value.label !== "string" || typeof value.cwd !== "string") return undefined;
  const tools = decodeStringArray(value.tools);
  const skills = value.skills === undefined ? undefined : decodeStringArray(value.skills);
  const extensions = value.extensions === undefined ? undefined : decodeStringArray(value.extensions);
  if (!tools) return undefined;
  const requestedLabel = optionalString(value.requestedLabel);
  const parentBreadcrumb = optionalString(value.parentBreadcrumb);
  const worktreeOwner = optionalString(value.worktreeOwner);
  const model = optionalString(value.model);
  const role = typeof value.role === "string" ? value.role : undefined;
  const contextFiles = value.contextFiles === undefined ? undefined : decodeContextFileScopes(value.contextFiles);
  const schema = value.schema === undefined ? undefined : decodeJsonObject(value.schema);
  const retries = optionalNumber(value.retries);
  const timeoutMs = value.timeoutMs;
  const agentOptions = value.agentOptions === undefined ? undefined : decodeJsonObject(value.agentOptions);
  const agentIdentity = value.agentIdentity === undefined ? undefined : decodeIdentity(value.agentIdentity);
  const sessionPath = optionalString(value.sessionPath);
  const continuity = value.continuity === undefined ? undefined : isAgentContinuity(value.continuity) ? value.continuity : INVALID_PERSISTED_VALUE;
  if (sessionPath === INVALID_PERSISTED_VALUE || continuity === INVALID_PERSISTED_VALUE || requestedLabel === INVALID_PERSISTED_VALUE || parentBreadcrumb === INVALID_PERSISTED_VALUE || worktreeOwner === INVALID_PERSISTED_VALUE || model === INVALID_PERSISTED_VALUE || value.skills !== undefined && !skills || value.extensions !== undefined && !extensions || (value.role !== undefined && typeof value.role !== "string") || (value.contextFiles !== undefined && !contextFiles) || (value.schema !== undefined && !schema) || retries === INVALID_PERSISTED_VALUE || (retries !== undefined && !integer(retries)) || (timeoutMs !== undefined && timeoutMs !== null && !finiteNumber(timeoutMs)) || (value.agentOptions !== undefined && !agentOptions) || (value.agentIdentity !== undefined && !agentIdentity)) return undefined;
  return {
    label: value.label,
    ...(requestedLabel === undefined ? {} : { requestedLabel }),
    ...(parentBreadcrumb === undefined ? {} : { parentBreadcrumb }),
    cwd: value.cwd,
    tools,
    ...(skills === undefined ? {} : { skills }), ...(extensions === undefined ? {} : { extensions }),
    ...(worktreeOwner === undefined ? {} : { worktreeOwner }),
    ...(model === undefined ? {} : { model }),
    ...(role === undefined ? {} : { role }),
    ...(contextFiles === undefined ? {} : { contextFiles }),
    ...(schema === undefined ? {} : { schema }),
    ...(retries === undefined ? {} : { retries }),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(sessionPath === undefined ? {} : { sessionPath }),
    ...(continuity === undefined ? {} : { continuity }),
    ...(agentOptions === undefined ? {} : { agentOptions }),
    ...(agentIdentity === undefined ? {} : { agentIdentity }),
  };
}
function decodeAgentSession(value: unknown): PersistedAgentSession | undefined {
  if (!object(value) || typeof value.transport !== "string" || typeof value.sessionId !== "string") return undefined;
  const locator = value.locator === undefined ? undefined : decodeJsonValue(value.locator);
  if (value.locator !== undefined && locator === undefined) return undefined;
  return { transport: value.transport, sessionId: value.sessionId, ...(locator === undefined ? {} : { locator }) };
}
function decodeAgentAccounting(value: unknown): AgentAccounting | undefined {
  if (!object(value) || !finiteNumber(value.input) || !finiteNumber(value.output) || !finiteNumber(value.cacheRead) || !finiteNumber(value.cacheWrite) || !finiteNumber(value.cost)) return undefined;
  return { input: value.input, output: value.output, cacheRead: value.cacheRead, cacheWrite: value.cacheWrite, cost: value.cost };
}
function decodeAgentActivity(value: unknown): AgentActivity | undefined {
  if (!object(value) || typeof value.text !== "string") return undefined;
  const kind = value.kind;
  if (kind !== "reasoning" && kind !== "tool" && kind !== "text") return undefined;
  return { kind, text: value.text };
}
function decodeAgentToolCall(value: unknown): NonNullable<AgentRecord["toolCalls"]>[number] | undefined {
  if (!object(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
  const state = value.state;
  if (state !== "running" && state !== "completed" && state !== "failed") return undefined;
  return { id: value.id, name: value.name, state };
}
function decodeAgentResourceInspection(value: unknown): AgentResourceInspection | undefined {
  if (!object(value)) return undefined;
  const selectors = decodeAgentResourceSelectors(value.selectors);
  const skills = decodeStringArray(value.skills);
  const extensions = decodeStringArray(value.extensions);
  const tools = decodeStringArray(value.tools);
  const unmatchedSkills = decodeStringArray(value.unmatchedSkills);
  const unmatchedExtensions = decodeStringArray(value.unmatchedExtensions);
  const unmatchedTools = decodeStringArray(value.unmatchedTools);
  const rawSources = value.selectorSources;
  const sourceRecord = object(rawSources) ? rawSources : undefined;
  const sources = sourceRecord === undefined ? undefined : {
    global: decodeAgentResourceSelectors(sourceRecord.global),
    project: decodeAgentResourceSelectors(sourceRecord.project),
    ...(sourceRecord.role === undefined ? {} : { role: decodeAgentResourceSelectors(sourceRecord.role) }),
    ...(sourceRecord.call === undefined ? {} : { call: decodeAgentResourceSelectors(sourceRecord.call) }),
  };
  if (!selectors || !skills || !extensions || !tools || !unmatchedSkills || !unmatchedExtensions || !unmatchedTools || rawSources !== undefined && (!sources || !sources.global || !sources.project || sources.role === undefined && sourceRecord?.role !== undefined || sources.call === undefined && sourceRecord?.call !== undefined)) return undefined;
  return { selectors: { skills: [...(selectors.skills ?? [])], extensions: [...(selectors.extensions ?? [])], tools: [...(selectors.tools ?? [])] }, skills, extensions, tools, unmatchedSkills, unmatchedExtensions, unmatchedTools, ...(sources === undefined ? {} : { selectorSources: { global: sources.global ?? {}, project: sources.project ?? {}, ...(sources.role === undefined ? {} : { role: sources.role }), ...(sources.call === undefined ? {} : { call: sources.call }) } }) };
}
function decodeAgentSetupSummary(value: unknown): NonNullable<NonNullable<AgentRecord["attemptDetails"]>[number]["setup"]> | undefined {
  if (!object(value) || typeof value.cwd !== "string") return undefined;
  const hookNames = decodeStringArray(value.hookNames);
  const tools = decodeStringArray(value.tools);
  const model = decodeModelSpec(value.model);
  const resourceSelectors = value.resourceSelectors === undefined ? undefined : decodeAgentResourceInspection(value.resourceSelectors);
  if (!hookNames || !tools || !model || value.resourceSelectors !== undefined && !resourceSelectors) return undefined;
  return { hookNames, model, tools, cwd: value.cwd, ...(resourceSelectors === undefined ? {} : { resourceSelectors }) };
}
function decodeAttemptError(value: unknown): NonNullable<NonNullable<AgentRecord["attemptDetails"]>[number]["error"]> | undefined {
  if (!object(value) || typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  return { code: value.code, message: value.message };
}
function decodeAgentAttempt(value: unknown): AgentAttemptSummary | undefined {
  if (!object(value) || !positiveInteger(value.attempt) || typeof value.transport !== "string") return undefined;
  const session = value.session === undefined ? undefined : decodeAgentSession(value.session);
  const setup = decodeAgentSetupSummary(value.setup);
  const error = value.error === undefined ? undefined : decodeAttemptError(value.error);
  const accounting = decodeAgentAccounting(value.accounting);
  if (!setup || !accounting || value.session !== undefined && !session || value.error !== undefined && !error) return undefined;
  return { attempt: value.attempt, transport: value.transport, setup, accounting, ...(session === undefined ? {} : { session }), ...(error === undefined ? {} : { error }) };
}
function decodeAgent(value: unknown): AgentRecord | undefined {
  if (!object(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.path !== "string" || !isAgentState(value.state) || !integer(value.attempts)) return undefined;
  const model = decodeModelSpec(value.model);
  const tools = decodeStringArray(value.tools);
  const systemPrompt = optionalString(value.systemPrompt);
  const prompt = optionalString(value.prompt);
  const label = optionalString(value.label);
  const parentId = optionalString(value.parentId);
  const structuralPath = value.structuralPath === undefined ? undefined : decodeStringArray(value.structuralPath);
  const resultPath = optionalString(value.resultPath);
  const parentBreadcrumb = optionalString(value.parentBreadcrumb);
  const worktreeOwner = optionalString(value.worktreeOwner);
  const handle = optionalString(value.handle);
  const continuity = value.continuity === undefined ? undefined : isAgentContinuity(value.continuity) ? value.continuity : INVALID_PERSISTED_VALUE;
  const role = optionalString(value.role);
  const requestedModel = optionalString(value.requestedModel);
  const startedAt = optionalNumber(value.startedAt);
  const durationMs = optionalNumber(value.durationMs);
  const attemptDetails = value.attemptDetails === undefined ? undefined : decodeArray(value.attemptDetails, decodeAgentAttempt);
  const accounting = value.accounting === undefined ? undefined : decodeAgentAccounting(value.accounting);
  const toolCalls = value.toolCalls === undefined ? undefined : decodeArray(value.toolCalls, decodeAgentToolCall);
  const activity = value.activity === undefined ? undefined : decodeAgentActivity(value.activity);
  const lastEventAt = optionalNumber(value.lastEventAt);
  if (systemPrompt === INVALID_PERSISTED_VALUE || prompt === INVALID_PERSISTED_VALUE || label === INVALID_PERSISTED_VALUE || parentId === INVALID_PERSISTED_VALUE || resultPath === INVALID_PERSISTED_VALUE || parentBreadcrumb === INVALID_PERSISTED_VALUE || worktreeOwner === INVALID_PERSISTED_VALUE || role === INVALID_PERSISTED_VALUE || requestedModel === INVALID_PERSISTED_VALUE || startedAt === INVALID_PERSISTED_VALUE || durationMs === INVALID_PERSISTED_VALUE || lastEventAt === INVALID_PERSISTED_VALUE || handle === INVALID_PERSISTED_VALUE || continuity === INVALID_PERSISTED_VALUE || handle !== undefined && !positiveInteger(value.turn)) return undefined;
  if (!model || !tools || value.structuralPath !== undefined && !structuralPath || value.attemptDetails !== undefined && !attemptDetails || value.accounting !== undefined && !accounting || value.toolCalls !== undefined && !toolCalls || value.activity !== undefined && !activity) return undefined;
  return {
    ...(systemPrompt === undefined ? {} : { systemPrompt }),
    ...(prompt === undefined ? {} : { prompt }),
    id: value.id,
    name: value.name,
    ...(label === undefined ? {} : { label }),
    path: value.path,
    state: value.state,
    ...(parentId === undefined ? {} : { parentId }),
    ...(structuralPath === undefined ? {} : { structuralPath }),
    ...(resultPath === undefined ? {} : { resultPath }),
    ...(parentBreadcrumb === undefined ? {} : { parentBreadcrumb }),
    ...(worktreeOwner === undefined ? {} : { worktreeOwner }),
    ...(handle === undefined ? {} : { handle, turn: value.turn as number }),
    ...(continuity === undefined ? {} : { continuity }),
    ...(role === undefined ? {} : { role }),
    ...(requestedModel === undefined ? {} : { requestedModel }),
    model,
    tools,
    attempts: value.attempts,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(attemptDetails === undefined ? {} : { attemptDetails }),
    ...(accounting === undefined ? {} : { accounting }),
    ...(toolCalls === undefined ? {} : { toolCalls }),
    ...(activity === undefined ? {} : { activity }),
    ...(lastEventAt === undefined ? {} : { lastEventAt }),
  };
}
function decodeRetry(value: unknown): NonNullable<RunRecord["retry"]> | undefined {
  if (!object(value) || typeof value.sourceRunId !== "string" || typeof value.lineageRootRunId !== "string") return undefined;
  const completedPaths = decodeStringArray(value.completedPaths);
  const incompletePaths = decodeStringArray(value.incompletePaths);
  const namedWorktrees = decodeStringArray(value.namedWorktrees);
  if (!completedPaths || !incompletePaths || !namedWorktrees) return undefined;
  return { sourceRunId: value.sourceRunId, lineageRootRunId: value.lineageRootRunId, completedPaths, incompletePaths, namedWorktrees };
}
function decodeWorkflowError(value: unknown): NonNullable<RunRecord["error"]> | undefined {
  if (!object(value) || typeof value.code !== "string" || typeof value.message !== "string") return undefined;
  const code = isWorkflowErrorCode(value.code) ? value.code : "INTERNAL_ERROR";
  const failedAt = optionalString(value.failedAt);
  if (failedAt === INVALID_PERSISTED_VALUE) return undefined;
  return { code, message: value.message, ...(failedAt === undefined ? {} : { failedAt }) };
}
function decodeUsage(value: unknown): WorkflowBudgetUsage | undefined {
  if (!object(value) || !finiteNumber(value.tokens) || !finiteNumber(value.costUsd) || !finiteNumber(value.durationMs) || !finiteNumber(value.agentLaunches)) return undefined;
  return { tokens: value.tokens, costUsd: value.costUsd, durationMs: value.durationMs, agentLaunches: value.agentLaunches };
}
function decodeBudgetEvent(value: unknown): BudgetEvent | undefined {
  if (!object(value) || !isBudgetEventType(value.type) || !integer(value.budgetVersion) || !finiteNumber(value.at)) return undefined;
  const dimensions = decodeArray(value.dimensions, (entry) => isBudgetDimension(entry) ? entry : undefined);
  const usage = decodeUsage(value.usage);
  const limits = decodeBudget(value.limits);
  const proposalId = optionalString(value.proposalId);
  const previous = value.previous === undefined ? undefined : decodeBudget(value.previous);
  const proposed = value.proposed === undefined ? undefined : decodeBudget(value.proposed);
  if (!dimensions || !usage || !limits || proposalId === INVALID_PERSISTED_VALUE || value.previous !== undefined && !previous || value.proposed !== undefined && !proposed) return undefined;
  return { type: value.type, budgetVersion: value.budgetVersion, dimensions, usage, limits, at: value.at, ...(proposalId === undefined ? {} : { proposalId }), ...(previous === undefined ? {} : { previous }), ...(proposed === undefined ? {} : { proposed }) };
}
function decodePhaseRecord(value: unknown): PersistedPhaseRecord | undefined {
  if (!object(value) || typeof value.phase !== "string" || !integer(value.afterAgent)) return undefined;
  return { phase: value.phase, afterAgent: value.afterAgent };
}
function decodeShellActivity(value: unknown): PersistedShellActivity | undefined {
  if (!object(value) || !integer(value.phaseIndex) || !integer(value.active) || !finiteNumber(value.startedAt)) return undefined;
  return { phaseIndex: value.phaseIndex, active: value.active, startedAt: value.startedAt };
}
function decodeRunEvent(value: unknown): WorkflowRunEvent | undefined {
  if (!object(value) || typeof value.type !== "string" || typeof value.message !== "string") return undefined;
  const timestamp = optionalNumber(value.timestamp);
  if (timestamp === INVALID_PERSISTED_VALUE) return undefined;
  return { type: value.type, message: value.message, ...(timestamp === undefined ? {} : { timestamp }) };
}
function decodeDelivery(value: unknown): PersistedDelivery | undefined {
  if (!object(value)) return undefined;
  const mode = value.mode;
  const state = value.state;
  if (mode !== "foreground" && mode !== "background" || state !== "attached" && state !== "pending" && state !== "delivered") return undefined;
  const toolCallId = optionalString(value.toolCallId);
  if (toolCallId === INVALID_PERSISTED_VALUE) return undefined;
  return { mode, state, ...(toolCallId === undefined ? {} : { toolCallId }) };
}
export function decodePersistedRun(value: unknown, allowLegacyAgentSessions = false): PersistedRun | undefined {
  if (!object(value) || typeof value.id !== "string" || typeof value.workflowName !== "string" || typeof value.cwd !== "string" || typeof value.sessionId !== "string" || !isRunState(value.state)) return undefined;
  const agentSessions = value.agentSessions === undefined && allowLegacyAgentSessions ? [] : decodeArray(value.agentSessions, decodeAgentSession);
  const agents = decodeArray(value.agents, decodeAgent);
  const parentRunId = optionalString(value.parentRunId);
  const retry = value.retry === undefined ? undefined : decodeRetry(value.retry);
  const phase = optionalString(value.phase);
  const phaseHistory = value.phaseHistory === undefined ? undefined : decodeArray(value.phaseHistory, decodePhaseRecord);
  const phaseHistoryIndex = optionalNumber(value.phaseHistoryIndex);
  const activeShells = optionalNumber(value.activeShells);
  const activeShellStartedAt = optionalNumber(value.activeShellStartedAt);
  const activeShellsByPhase = value.activeShellsByPhase === undefined ? undefined : decodeArray(value.activeShellsByPhase, decodeShellActivity);
  const error = value.error === undefined ? undefined : decodeWorkflowError(value.error);
  const failedAt = optionalString(value.failedAt);
  const budget = value.budget === undefined ? undefined : decodeBudget(value.budget);
  const budgetVersion = optionalNumber(value.budgetVersion);
  const usage = value.usage === undefined ? undefined : decodeUsage(value.usage);
  const budgetEvents = value.budgetEvents === undefined ? undefined : decodeArray(value.budgetEvents, decodeBudgetEvent);
  const events = value.events === undefined ? undefined : decodeArray(value.events, decodeRunEvent);
  const delivery = value.delivery === undefined ? undefined : decodeDelivery(value.delivery);
  if (!agentSessions || !agents || parentRunId === INVALID_PERSISTED_VALUE || value.retry !== undefined && !retry || phase === INVALID_PERSISTED_VALUE || value.phaseHistory !== undefined && !phaseHistory || phaseHistoryIndex === INVALID_PERSISTED_VALUE || activeShells === INVALID_PERSISTED_VALUE || activeShellStartedAt === INVALID_PERSISTED_VALUE || value.activeShellsByPhase !== undefined && !activeShellsByPhase || value.error !== undefined && !error || failedAt === INVALID_PERSISTED_VALUE || value.budget !== undefined && !budget || budgetVersion === INVALID_PERSISTED_VALUE || value.budgetVersion !== undefined && !integer(budgetVersion) || value.usage !== undefined && !usage || value.budgetEvents !== undefined && !budgetEvents || value.events !== undefined && !events || value.delivery !== undefined && !delivery) return undefined;
  if (value.agentSessions === undefined && !allowLegacyAgentSessions) return undefined;
  return {
    id: value.id,
    workflowName: value.workflowName,
    cwd: value.cwd,
    sessionId: value.sessionId,
    state: value.state,
    agentSessions,
    ...(parentRunId === undefined ? {} : { parentRunId }),
    ...(retry === undefined ? {} : { retry }),
    ...(phase === undefined ? {} : { phase }),
    ...(phaseHistory === undefined ? {} : { phaseHistory }),
    ...(phaseHistoryIndex === undefined ? {} : { phaseHistoryIndex }),
    agents,
    ...(activeShells === undefined ? {} : { activeShells }),
    ...(activeShellStartedAt === undefined ? {} : { activeShellStartedAt }),
    ...(activeShellsByPhase === undefined ? {} : { activeShellsByPhase }),
    ...(error === undefined ? {} : { error }),
    ...(failedAt === undefined ? {} : { failedAt }),
    ...(budget === undefined ? {} : { budget }),
    ...(budgetVersion === undefined ? {} : { budgetVersion }),
    ...(usage === undefined ? {} : { usage }),
    ...(budgetEvents === undefined ? {} : { budgetEvents }),
    ...(events === undefined ? {} : { events }),
    ...(delivery === undefined ? {} : { delivery }),
  };
}
export function isPersistedRun(value: unknown): value is PersistedRun { return decodePersistedRun(value) !== undefined; }
export function decodeLaunchSnapshot(value: unknown): LaunchSnapshot | undefined {
  if (!object(value) || typeof value.script !== "string") return undefined;
  const identityVersion = optionalNumber(value.identityVersion);
  const launchMode = value.launchMode;
  const args = decodeJsonValue(value.args);
  const metadata = decodeWorkflowMetadata(value.metadata);
  const settings = decodeWorkflowSettings(value.settings);
  const settingsSources = value.settingsSources === undefined ? undefined : decodeWorkflowSettingsSources(value.settingsSources);
  const budget = value.budget === undefined ? undefined : decodeBudget(value.budget);
  const settingsPath = optionalString(value.settingsPath);
  const modelAliases = value.modelAliases === undefined ? undefined : decodeStringMap(value.modelAliases);
  const phases = value.phases === undefined ? undefined : decodeStringArray(value.phases);
  const models = decodeStringArray(value.models);
  const tools = decodeStringArray(value.tools);
  const agentTypes = decodeStringArray(value.agentTypes);
  const roles = value.roles === undefined ? undefined : decodeRecord(value.roles, decodeAgentDefinition);
  const projectRoles = value.projectRoles === undefined ? undefined : decodeStringArray(value.projectRoles);
  const schemas = decodeArray(value.schemas, decodeJsonObject);
  if (identityVersion === INVALID_PERSISTED_VALUE || value.identityVersion !== undefined && !integer(identityVersion) || launchMode !== undefined && !isLaunchMode(launchMode) || args === undefined || !metadata || !settings || value.settingsSources !== undefined && !settingsSources || value.budget !== undefined && !budget || settingsPath === INVALID_PERSISTED_VALUE || value.modelAliases !== undefined && !modelAliases || value.phases !== undefined && !phases || !models || !tools || !agentTypes || value.roles !== undefined && !roles || value.projectRoles !== undefined && !projectRoles || !schemas) return undefined;
  return {
    ...(identityVersion === undefined ? {} : { identityVersion }),
    ...(launchMode === undefined ? {} : { launchMode }),
    script: value.script,
    args,
    metadata,
    settings,
    ...(settingsSources === undefined ? {} : { settingsSources }),
    ...(budget === undefined ? {} : { budget }),
    ...(settingsPath === undefined ? {} : { settingsPath }),
    ...(modelAliases === undefined ? {} : { modelAliases }),
    ...(phases === undefined ? {} : { phases }),
    models,
    tools,
    agentTypes,
    ...(roles === undefined ? {} : { roles }),
    ...(projectRoles === undefined ? {} : { projectRoles }),
    schemas,
  };
}

export function decodeSessionOwner(value: unknown): SessionOwner | undefined {
  if (!object(value) || !positiveInteger(value.pid) || typeof value.token !== "string" || !value.token || !finiteNumber(value.startedAt)) return undefined;
  return { pid: value.pid, token: value.token, startedAt: value.startedAt };
}
function decodeOwnershipRecord(value: unknown): OwnershipRecord | undefined {
  if (!object(value) || typeof value.id !== "string" || typeof value.label !== "string" || !isAgentState(value.state)) return undefined;
  const parentId = optionalString(value.parentId);
  const prompt = optionalString(value.prompt);
  const options = decodeScheduledAgentOptions(value.options);
  if (parentId === INVALID_PERSISTED_VALUE || prompt === INVALID_PERSISTED_VALUE || !options) return undefined;
  return { id: value.id, label: value.label, state: value.state, options, ...(parentId === undefined ? {} : { parentId }), ...(prompt === undefined ? {} : { prompt }) };
}
export function decodeOwnershipRecords(value: unknown): OwnershipRecord[] | undefined { return decodeArray(value, decodeOwnershipRecord); }
function decodeWorktreeReference(value: unknown): WorktreeReference | undefined {
  if (!object(value) || typeof value.owner !== "string" || typeof value.path !== "string" || typeof value.branch !== "string" || typeof value.cwd !== "string" || typeof value.base !== "string") return undefined;
  return { owner: value.owner, path: value.path, branch: value.branch, cwd: value.cwd, base: value.base };
}
export function decodeWorktreeReferences(value: unknown): WorktreeReference[] | undefined { return decodeArray(value, decodeWorktreeReference); }
function decodeBorrowedWorktreeBinding(value: unknown): BorrowedWorktreeBinding | undefined {
  if (!object(value) || typeof value.name !== "string" || typeof value.sourceRunId !== "string" || typeof value.owner !== "string") return undefined;
  return { name: value.name, sourceRunId: value.sourceRunId, owner: value.owner };
}
export function decodeBorrowedWorktreeBindings(value: unknown): BorrowedWorktreeBinding[] | undefined { return decodeArray(value, decodeBorrowedWorktreeBinding); }
function decodeCompletedOperation(value: unknown): CompletedOperation | undefined {
  if (!object(value) || typeof value.path !== "string") return undefined;
  const decodedValue = decodeJsonValue(value.value);
  if (decodedValue === undefined) return undefined;
  return { path: value.path, value: decodedValue };
}
function decodeAwaitingCheckpoint(value: unknown): AwaitingCheckpoint | undefined {
  if (!object(value) || typeof value.path !== "string" || typeof value.name !== "string" || typeof value.prompt !== "string") return undefined;
  const context = decodeJsonValue(value.context);
  if (context === undefined) return undefined;
  return { path: value.path, name: value.name, prompt: value.prompt, context };
}
function decodePendingWorkflowDecision(value: unknown): PendingWorkflowDecision | undefined {
  if (!object(value) || value.kind !== "budget" || typeof value.proposalId !== "string" || typeof value.runId !== "string" || !integer(value.budgetVersion)) return undefined;
  const consumed = decodeUsage(value.consumed);
  const previous = decodeBudget(value.previous);
  const proposed = decodeBudget(value.proposed);
  const foreground = optionalBoolean(value.foreground);
  if (!consumed || !previous || !proposed || foreground === INVALID_PERSISTED_VALUE) return undefined;
  return { kind: "budget", proposalId: value.proposalId, runId: value.runId, consumed, previous, proposed, budgetVersion: value.budgetVersion, ...(foreground === undefined ? {} : { foreground }) };
}
export function decodeJournal(value: unknown): Journal | undefined {
  if (!object(value)) return undefined;
  const completed = decodeRecord(value.completed, decodeCompletedOperation);
  const awaiting = value.awaiting === undefined ? undefined : decodeRecord(value.awaiting, decodeAwaitingCheckpoint);
  const decisions = value.decisions === undefined ? undefined : decodeRecord(value.decisions, decodePendingWorkflowDecision);
  if (!completed || value.awaiting !== undefined && !awaiting || value.decisions !== undefined && !decisions) return undefined;
  return { completed, ...(awaiting === undefined ? {} : { awaiting }), ...(decisions === undefined ? {} : { decisions }) };
}
export function decodeBooleanCheckpointResult(value: unknown): boolean | undefined { return typeof value === "boolean" ? value : undefined; }
export function decodeSummaryProjection(value: unknown): Partial<RunSummary> | undefined {
  if (!object(value)) return undefined;
  const createdAt = optionalString(value.createdAt);
  const updatedAt = optionalString(value.updatedAt);
  const terminalAt = optionalString(value.terminalAt);
  if (createdAt === INVALID_PERSISTED_VALUE || updatedAt === INVALID_PERSISTED_VALUE || terminalAt === INVALID_PERSISTED_VALUE) return undefined;
  return { ...(createdAt === undefined ? {} : { createdAt }), ...(updatedAt === undefined ? {} : { updatedAt }), ...(terminalAt === undefined ? {} : { terminalAt }) };
}
function decodeEffectiveSystemPrompt(value: unknown): EffectiveSystemPrompt | undefined {
  if (!object(value) || typeof value.sessionId !== "string" || !positiveInteger(value.attempt) || !positiveInteger(value.turn) || typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(value.sha256) || typeof value.prompt !== "string") return undefined;
  return { sessionId: value.sessionId, attempt: value.attempt, turn: value.turn, sha256: value.sha256, prompt: value.prompt };
}
export function decodeSystemPromptArtifact(value: unknown): { version: number; format?: unknown; storage?: unknown; entries?: EffectiveSystemPrompt[] } | undefined {
  if (!object(value) || !finiteNumber(value.version)) return undefined;
  const entries = value.entries === undefined ? undefined : decodeArray(value.entries, decodeEffectiveSystemPrompt);
  if (value.entries !== undefined && !entries) return undefined;
  return { version: value.version, ...(value.format === undefined ? {} : { format: value.format }), ...(value.storage === undefined ? {} : { storage: value.storage }), ...(entries === undefined ? {} : { entries }) };
}
export interface WorktreeReference { owner: string; path: string; branch: string; cwd: string; base: string }
export interface BorrowedWorktreeBinding { name: string; sourceRunId: string; owner: string }
export type SessionOwner = { pid: number; token: string; startedAt: number };
