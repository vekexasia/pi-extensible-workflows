import { finiteNumber, jsonValue, parseThinking } from "../../src/utils.js";
import type { AgentAttemptSummary } from "../../src/types.js";
import { SUBAGENT_ATTEMPT_DETAILS_LIMIT, type SubagentProgress, type SubagentStatus } from "./contracts.js";

function objectValue(value: unknown): Record<string, unknown> | undefined { return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function resourceSummaryValue(value: unknown): NonNullable<AgentAttemptSummary["setup"]["resourceSelectors"]> | undefined {
  const record = objectValue(value);
  const selectors = objectValue(record?.selectors);
  const skills = stringArrayValue(record?.skills);
  const extensions = stringArrayValue(record?.extensions);
  const tools = stringArrayValue(record?.tools);
  const selectorSkills = stringArrayValue(selectors?.skills);
  const selectorExtensions = stringArrayValue(selectors?.extensions);
  const selectorTools = stringArrayValue(selectors?.tools);
  const unmatchedSkills = stringArrayValue(record?.unmatchedSkills);
  const unmatchedExtensions = stringArrayValue(record?.unmatchedExtensions);
  const unmatchedTools = stringArrayValue(record?.unmatchedTools);
  if (!record || !selectors || !skills || !extensions || !tools || !selectorSkills || !selectorExtensions || !selectorTools || !unmatchedSkills || !unmatchedExtensions || !unmatchedTools) return undefined;
  return { selectors: { skills: selectorSkills, extensions: selectorExtensions, tools: selectorTools }, skills, extensions, tools, unmatchedSkills, unmatchedExtensions, unmatchedTools };
}
function nonnegativeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function stringArrayValue(value: unknown): readonly string[] | undefined { return Array.isArray(value) && value.length <= 256 && value.every((item) => typeof item === "string") ? value : undefined; }
function accountingValue(value: unknown): SubagentProgress["accounting"] | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  const input = record.input;
  const output = record.output;
  const cacheRead = record.cacheRead;
  const cacheWrite = record.cacheWrite;
  const cost = record.cost;
  if (!finiteNumber(input) || !finiteNumber(output) || !finiteNumber(cacheRead) || !finiteNumber(cacheWrite) || !finiteNumber(cost)) return undefined;
  return { input, output, cacheRead, cacheWrite, cost };
}
function legacyAccountingValue(record: Record<string, unknown>): SubagentProgress["accounting"] | undefined {
  const accounting = accountingValue(record.accounting);
  if (record.accounting !== undefined && !accounting) return undefined;
  const usage = record.usage;
  if (usage === undefined) return accounting;
  const usageRecord = objectValue(usage);
  const tokens = objectValue(usageRecord?.tokens);
  if (!usageRecord || !tokens || !finiteNumber(tokens.input) || !finiteNumber(tokens.output) || !finiteNumber(tokens.cacheRead) || !finiteNumber(tokens.cacheWrite) || !finiteNumber(tokens.total) || !finiteNumber(usageRecord.cost)) return undefined;
  return accounting ?? { input: tokens.input, output: tokens.output, cacheRead: tokens.cacheRead, cacheWrite: tokens.cacheWrite, cost: usageRecord.cost };
}
function activityValue(value: unknown): NonNullable<SubagentProgress["activity"]> | undefined {
  const record = objectValue(value);
  return record && (record.kind === "reasoning" || record.kind === "tool" || record.kind === "text") && typeof record.text === "string" ? { kind: record.kind, text: record.text } : undefined;
}
function toolCallsValue(value: unknown): SubagentProgress["toolCalls"] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const calls: SubagentProgress["toolCalls"][number][] = [];
  for (const item of value) {
    const record = objectValue(item);
    if (!record || typeof record.id !== "string" || typeof record.name !== "string" || record.state !== "running" && record.state !== "completed" && record.state !== "failed") return undefined;
    calls.push({ id: record.id, name: record.name, state: record.state });
  }
  return calls;
}
function sessionReferenceValue(value: unknown): AgentAttemptSummary["session"] | undefined {
  const record = objectValue(value);
  const transport = record?.transport;
  const sessionId = record?.sessionId;
  if (!record || typeof transport !== "string" || !transport.trim() || typeof sessionId !== "string" || !sessionId.trim()) return undefined;
  return { transport, sessionId, ...(record.locator === undefined || !jsonValue(record.locator) ? {} : { locator: record.locator }) };
}
export function subagentErrorValue(value: unknown): { readonly code: string; readonly message: string } | undefined {
  const record = objectValue(value);
  return record && typeof record.code === "string" && typeof record.message === "string" ? { code: record.code, message: record.message } : undefined;
}
function worktreeValue(value: unknown): { readonly path: string; readonly branch: string } | undefined {
  const record = objectValue(value);
  return record && typeof record.path === "string" && record.path.trim() && typeof record.branch === "string" && record.branch.trim() ? { path: record.path, branch: record.branch } : undefined;
}
function progressValue(value: unknown): SubagentProgress | undefined {
  const record = objectValue(value);
  if (!record) return undefined;
  const accounting = accountingValue(record.accounting);
  const toolCalls = toolCallsValue(record.toolCalls);
  if (!accounting || !toolCalls) return undefined;
  const activity = record.activity === undefined ? undefined : activityValue(record.activity);
  if (record.activity !== undefined && activity === undefined) return undefined;
  const rawState = record.state;
  let state: SubagentProgress["state"];
  if (rawState !== undefined) {
    const stateRecord = objectValue(rawState);
    const model = objectValue(stateRecord?.model);
    const tools = stringArrayValue(stateRecord?.tools);
    if (!stateRecord || !model || !tools || typeof model.provider !== "string" || typeof model.model !== "string") return undefined;
    const thinking = parseThinking(model.thinking);
    if (model.thinking !== undefined && thinking === undefined) return undefined;
    state = { model: { provider: model.provider, model: model.model, ...(thinking === undefined ? {} : { thinking }) }, tools };
  }
  const lastEventAt = record.lastEventAt;
  if (lastEventAt !== undefined && !nonnegativeInteger(lastEventAt)) return undefined;
  return { accounting, toolCalls, ...(state === undefined ? {} : { state }), ...(activity === undefined ? {} : { activity }), ...(lastEventAt === undefined ? {} : { lastEventAt }) };
}
function legacyProgressValue(record: Record<string, unknown>): SubagentProgress | undefined {
  const accounting = legacyAccountingValue(record);
  const toolCalls = record.toolCalls === undefined ? [] : toolCallsValue(record.toolCalls);
  if (!accounting || !toolCalls) return undefined;
  const activity = record.activity === undefined ? undefined : activityValue(record.activity);
  const lastEventAt = record.lastEventAt;
  if (record.activity !== undefined && activity === undefined || lastEventAt !== undefined && !nonnegativeInteger(lastEventAt)) return undefined;
  return { accounting, toolCalls, ...(activity === undefined ? {} : { activity }), ...(lastEventAt === undefined ? {} : { lastEventAt }) };
}
export function attemptValue(value: unknown): AgentAttemptSummary | undefined {
  const record = objectValue(value);
  const setup = objectValue(record?.setup);
  const model = objectValue(setup?.model);
  const hookNames = stringArrayValue(setup?.hookNames);
  const tools = stringArrayValue(setup?.tools);
  const resources = setup?.resourceSelectors === undefined ? undefined : resourceSummaryValue(setup.resourceSelectors);
  const accounting = accountingValue(record?.accounting);
  const session = record?.session === undefined ? undefined : sessionReferenceValue(record.session);
  const error = record?.error === undefined ? undefined : subagentErrorValue(record.error);
  const thinking = parseThinking(model?.thinking);
  if (!record || !nonnegativeInteger(record.attempt) || record.attempt < 1 || typeof record.transport !== "string" || !record.transport.trim() || !setup || typeof setup.cwd !== "string" || !setup.cwd.trim() || !model || typeof model.provider !== "string" || !model.provider.trim() || typeof model.model !== "string" || !model.model.trim() || model.thinking !== undefined && thinking === undefined || !hookNames || !tools || setup.resourceSelectors !== undefined && resources === undefined || !accounting || record.session !== undefined && session === undefined || record.error !== undefined && error === undefined) return undefined;
  return {
    attempt: record.attempt,
    transport: record.transport,
    setup: { hookNames, model: { provider: model.provider, model: model.model, ...(thinking === undefined ? {} : { thinking }) }, tools, cwd: setup.cwd, ...(resources === undefined ? {} : { resourceSelectors: resources }) },
    accounting,
    ...(session === undefined ? {} : { session }),
    ...(error === undefined ? {} : { error }),
  };
}
export function statusValue(value: unknown): SubagentStatus | undefined {
  const record = objectValue(value);
  const id = record?.id;
  const state = record?.state;
  if (!record || typeof id !== "string" || !id || state !== "running" && state !== "completed" && state !== "failed" && state !== "stopped") return undefined;
  const startedAt = record.startedAt;
  const finishedAt = record.finishedAt;
  if (startedAt !== undefined && !nonnegativeInteger(startedAt) || finishedAt !== undefined && (!nonnegativeInteger(finishedAt) || typeof startedAt === "number" && finishedAt < startedAt)) return undefined;
  const sessionId = record.sessionId;
  if (sessionId !== undefined && (typeof sessionId !== "string" || !sessionId.trim())) return undefined;
  const worktree = record.worktree === undefined ? undefined : worktreeValue(record.worktree);
  if (record.worktree !== undefined && worktree === undefined) return undefined;
  const error = record.error === undefined ? undefined : subagentErrorValue(record.error);
  if (record.error !== undefined && error === undefined) return undefined;
  const attempts = record.attempts;
  if (attempts !== undefined && (!nonnegativeInteger(attempts) || attempts < 1)) return undefined;
  const attemptDetails = record.attemptDetails === undefined ? undefined : Array.isArray(record.attemptDetails) ? record.attemptDetails.slice(-SUBAGENT_ATTEMPT_DETAILS_LIMIT).map(attemptValue) : undefined;
  if (record.attemptDetails !== undefined && (!attemptDetails || attemptDetails.some((attempt): attempt is undefined => attempt === undefined))) return undefined;
  const progress = record.progress === undefined ? legacyProgressValue(record) : progressValue(record.progress);
  if (record.progress !== undefined && progress === undefined) return undefined;
  return {
    id,
    ...(sessionId === undefined ? {} : { sessionId }),
    state,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(worktree === undefined ? {} : { worktree }),
    ...(error === undefined ? {} : { error }),
    ...(attempts === undefined ? {} : { attempts }),
    ...(attemptDetails === undefined ? {} : { attemptDetails: attemptDetails.filter((attempt): attempt is AgentAttemptSummary => attempt !== undefined) }),
    ...(progress === undefined ? {} : { progress }),
  };
}
