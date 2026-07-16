import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { CAPTURE_ERROR_PREFIX, CAPTURE_IDENTITY, resolveWorkflowSkillPath } from "./eval-capture-extension.js";
export { resolveWorkflowSkillPath } from "./eval-capture-extension.js";
import { ERROR_CODES, inspectWorkflowScript, loadAgentDefinitions, runWorkflow, WorkflowError, type AgentIdentity, type JsonSchema, type JsonValue, type StaticWorkflowCall, type WorkflowErrorCode } from "./index.js";

export type SignificantAction = { kind: "tool"; name: string } | { kind: "text" } | { kind: "thinking" };
export type SequenceExpectation = readonly string[] | { equals?: readonly string[]; startsWith?: readonly string[] };
export type JsonResultType = "null" | "boolean" | "number" | "integer" | "string" | "array" | "object";
export interface JsonResultShape { type?: JsonResultType; equals?: JsonValue; nonEmpty?: boolean; requiredKeys?: readonly string[]; propertyTypes?: Readonly<Record<string, JsonResultType>>; forbiddenProperties?: readonly string[]; count?: number; minCount?: number; properties?: Readonly<Record<string, JsonResultShape>>; }
export interface ExpectedReplayResult { workflowIndex?: number; equals?: JsonValue; match?: JsonResultShape }
export interface OutputSchemaShape { type?: string; requiredKeys?: readonly string[]; propertyTypes?: Readonly<Record<string, string>>; forbiddenProperties?: readonly string[]; count?: number; minCount?: number; }
export interface AgentPolicyExpectation {
  callIndex: number;
  role?: string;
  model?: string;
  forbidOptions?: readonly ("role" | "model" | "thinking" | "tools" | "isolation" | "retries")[];
  tools?: { mode: "omitted" | "empty" | "exact"; values?: readonly string[] };
}
export interface AgentOrderExpectation { role?: string; model?: string; promptIncludes?: string }
export interface DataFlowExpectation { binding: string; toAgentIndex: number }
export interface ParentAssistantBatch { index: number; parts: readonly JsonValue[]; tools: readonly string[]; usage?: ParentUsage }
export interface ParentToolResult { toolCallId?: string; details?: JsonValue; isError?: boolean; text?: string }
export interface ParentUsage { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number; models: readonly { model: string; cost: number }[] }
export interface ParentOracle { assistantBatches: readonly ParentAssistantBatch[]; workflowToolResults: readonly ParentToolResult[]; skillReads: readonly string[]; firstSignificantAction?: SignificantAction; firstTool?: string; firstBatchToolSequence: readonly string[]; toolsBeforeFirstWorkflow: readonly string[]; firstWorkflowBatchToolSequence: readonly string[]; parentToolSequence: readonly string[]; workflowCallCount: number; usage: ParentUsage }
export interface CapturedWorkflowCall { batch: number; toolCallId?: string; arguments: JsonValue; script?: string }

export interface EvalExpectations {
  firstSignificantAction?: SignificantAction;
  firstTool?: string;
  firstBatchToolSequence?: SequenceExpectation;
  parentToolSequence?: SequenceExpectation;
  workflowCallCount?: number | { min?: number; max?: number };
  requiredOperations?: readonly StaticWorkflowCall["kind"][];
  forbiddenOperations?: readonly StaticWorkflowCall["kind"][];
  requiredRoles?: readonly string[];
  minimumAgentCalls?: number;
  requireOutputSchema?: OutputSchemaShape | boolean;
  expectedResults?: readonly ExpectedReplayResult[];
  agentPolicies?: readonly AgentPolicyExpectation[];
  requiredAgentOrder?: readonly AgentOrderExpectation[];
  requiredDataFlow?: readonly DataFlowExpectation[];
}
export interface SemanticCriterion { id: string; description: string }
export interface WorkflowEvalCase { id: string; prompt: string; timeoutMs?: number; maxCost: number; expectations: EvalExpectations; expectedWorkflowCalls?: number; semanticCriteria?: readonly SemanticCriterion[] }
export interface ReplayAgentCall { prompt: string; options: Readonly<Record<string, JsonValue>>; identity: AgentIdentity }
export interface ReplayTrace { agentCalls: readonly ReplayAgentCall[]; phases: readonly string[]; logs: readonly string[]; maxConcurrentAgents: number }
export interface ReplayReport { script: string; result?: JsonValue; trace?: ReplayTrace; error?: string }
export interface ProductionValidationReport { callIndex: number; valid: boolean; errorCode?: WorkflowErrorCode; message?: string }
export interface CriterionResult { id: string; pass: boolean; evidence: string }
export interface StaticCandidateReport { callIndices: readonly number[]; criteria: readonly CriterionResult[]; passed: boolean }
export interface SemanticJudgeReport { criteria: readonly CriterionResult[]; usage: ParentUsage; raw: string }
export type EvalAccounting = ParentUsage;
export interface EvalMetrics {
  parentUsageThroughCandidate: ParentUsage | null;
  parentOutputTokensThroughCandidate: number | null;
  nonWorkflowToolSequenceBeforeCandidate: readonly string[];
  nonWorkflowToolCallCountBeforeCandidate: number;
  workflowCallCountBeforeCandidate: number;
  invalidWorkflowCallCount: number;
  productionValidationErrorCodes: readonly string[];
  candidateCallIndices: readonly number[];
  staticCandidates: readonly StaticCandidateReport[];
  semanticCriteria: readonly CriterionResult[];
  anyValidCandidate: boolean;
  requiredWorkflowCallCount: number;
  surplusWorkflowCallCount: number;
}
export interface EvalCaseResult {
  id: string;
  status: "passed" | "failed" | "timed_out" | "budget_exceeded" | "skipped";
  limits: { timeoutMs?: number; maxCost: number };
  oracle?: ParentOracle;
  workflows: readonly CapturedWorkflowCall[];
  productionValidation: readonly ProductionValidationReport[];
  semanticJudge?: SemanticJudgeReport;
  metrics: EvalMetrics;
  accounting: EvalAccounting;
  accountingTrustworthy: boolean;
  diagnostics: readonly string[];
  errors: readonly string[];
  cleanup: { processExited: boolean; processGroupTerminated: boolean; tempRootRemoved: boolean; captureIdentityVerified: boolean; realWorkflowAgentsLaunched: number | null };
}

const CASE_PROCESS_GRACE_MS = 1_000;
export const SAFE_PARENT_EVAL_TOOLS = Object.freeze(["read", "grep", "find", "workflow"] as const);
const EVAL_MODEL_TOKEN = "$EVAL_MODEL";
const naturalExpectations = (extra: EvalExpectations = {}): EvalExpectations => ({ workflowCallCount: { min: 1 }, ...extra });
const semantic = (description: string): readonly SemanticCriterion[] => [{ id: "intent", description }];

export const INITIAL_WORKFLOW_EVAL_CASES: readonly WorkflowEvalCase[] = Object.freeze([
  { id: "direct-answer", prompt: "Answer this directly in one short sentence: what is two plus two? Do not use tools.", maxCost: 0.1, expectations: { firstSignificantAction: { kind: "text" }, workflowCallCount: 0, parentToolSequence: [] }, expectedWorkflowCalls: 0 },
  { id: "two-agents", prompt: "Investigate this repository from two independent angles: inspect the API surface and inspect the user-facing behavior. Combine both findings into one concise plain-text comparison.", maxCost: 0.1, expectations: naturalExpectations({ minimumAgentCalls: 2 }), semanticCriteria: semantic("The workflow independently inspects API and user-facing behavior, then combines both findings into one concise comparison.") },
  { id: "required-role", prompt: "Have a reviewer assess the change and return a short review. Choose the repository's reviewer role rather than improvising a role.", maxCost: 0.1, expectations: naturalExpectations({ requiredRoles: ["reviewer"], agentPolicies: [{ callIndex: 0, role: "reviewer", forbidOptions: ["model", "thinking", "tools"] }] }), semanticCriteria: semantic("A reviewer-role agent assesses the change and its result is returned.") },
  { id: "custom-model-no-tools", prompt: `Delegate a short synthesis to one subagent using the explicit model ${EVAL_MODEL_TOKEN}, without filesystem access and with an explicit empty tools list.`, maxCost: 0.1, expectations: naturalExpectations({ agentPolicies: [{ callIndex: 0, model: EVAL_MODEL_TOKEN, tools: { mode: "empty" } }] }), semanticCriteria: semantic("One explicitly selected no-tools model performs the requested synthesis.") },
  { id: "custom-model-read", prompt: `Delegate inspection of README.md to one subagent using the explicit model ${EVAL_MODEL_TOKEN}, with exactly the read tool and no others.`, maxCost: 0.1, expectations: naturalExpectations({ agentPolicies: [{ callIndex: 0, model: EVAL_MODEL_TOKEN, tools: { mode: "exact", values: ["read"] } }] }), semanticCriteria: semantic("The selected model reads README.md with only the read tool.") },
  { id: "role-model-mixed", prompt: `Obtain a reviewer-role assessment first, then use a separate subagent with the explicit model ${EVAL_MODEL_TOKEN} and tools: [] to synthesize the final text.`, maxCost: 0.1, expectations: naturalExpectations({ minimumAgentCalls: 2, agentPolicies: [{ callIndex: 0, role: "reviewer", forbidOptions: ["model", "thinking", "tools"] }, { callIndex: 1, model: EVAL_MODEL_TOKEN, tools: { mode: "empty" } }] }), semanticCriteria: semantic("The reviewer assessment is produced first and passed to a separate no-tools synthesis agent.") },
  { id: "parallel", prompt: "Run the independent API and UI checks at the same time, then report both outcomes together.", maxCost: 0.1, expectations: naturalExpectations({ requiredOperations: ["parallel"], minimumAgentCalls: 2 }), semanticCriteria: semantic("Independent API and UI checks run in parallel and both outcomes are combined.") },
  { id: "pipeline", prompt: "Process the API and UI artifacts through the same ordered normalization and finalization stages, preserving each item's result.", maxCost: 0.1, expectations: naturalExpectations({ requiredOperations: ["pipeline"] }), semanticCriteria: semantic("API and UI items pass through the same ordered normalization and finalization stages.") },
  { id: "mixed-parallel-pipeline", prompt: "Run the API and UI reviews concurrently, then pass each review through the same ordered summarization stage before combining the results.", maxCost: 0.1, expectations: naturalExpectations({ requiredOperations: ["parallel", "pipeline"], minimumAgentCalls: 2 }), semanticCriteria: semantic("API and UI reviews run concurrently before each follows the same ordered summarization path.") },
  { id: "output-schema", prompt: "Use one scout-role subagent for a structured report containing a numeric count and a text summary, and use that structured result in the final answer.", maxCost: 0.1, expectations: naturalExpectations({ requiredRoles: ["scout"], agentPolicies: [{ callIndex: 0, role: "scout", forbidOptions: ["model", "thinking", "tools"] }], requireOutputSchema: { type: "object", requiredKeys: ["count", "summary"], propertyTypes: { count: "number", summary: "string" }, forbiddenProperties: ["extra"], count: 1 } }), semanticCriteria: semantic("A scout returns the requested count/summary structure and that result feeds the final answer.") },
  { id: "multiple-workflows", prompt: "Use two separate workflow runs: one to inspect the API and one to inspect the UI. Each run should return a short textual result, then combine those results.", maxCost: 0.1, expectations: { workflowCallCount: { min: 2 } }, expectedWorkflowCalls: 2, semanticCriteria: semantic("Two separate workflows inspect API and UI respectively and provide results that can be combined.") },
]);


function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function isJson(value: unknown): value is JsonValue { if (value === null || typeof value === "string" || typeof value === "boolean") return true; if (typeof value === "number") return Number.isFinite(value); if (Array.isArray(value)) return value.every(isJson); return isObject(value) && Object.values(value).every(isJson); }
function asJsonObject(value: unknown): Readonly<Record<string, JsonValue>> | undefined { return isObject(value) && Object.values(value).every(isJson) ? value as Readonly<Record<string, JsonValue>> : undefined; }
function jsonType(value: JsonValue): JsonResultType { if (value === null) return "null"; if (Array.isArray(value)) return "array"; if (typeof value === "number") return Number.isInteger(value) ? "integer" : "number"; if (typeof value === "object") return "object"; if (typeof value === "string") return "string"; if (typeof value === "boolean") return "boolean"; return "null"; }
function jsonTypeMatches(value: JsonValue, expected: JsonResultType): boolean { const actual = jsonType(value); return actual === expected || expected === "number" && actual === "integer"; }
function equalJson(left: JsonValue, right: JsonValue): boolean { if (left === right) return true; if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => equalJson(value, right[index] as JsonValue)); if (isObject(left) && isObject(right)) { const leftKeys = Object.keys(left); const rightKeys = Object.keys(right); return leftKeys.length === rightKeys.length && leftKeys.every((key) => Object.prototype.hasOwnProperty.call(right, key) && equalJson(left[key] as JsonValue, right[key] as JsonValue)); } return false; }
type SequenceShape = { equals?: readonly string[]; startsWith?: readonly string[] };
function isSequenceShape(value: SequenceExpectation): value is SequenceShape { return !Array.isArray(value); }
function sequenceMatches(actual: readonly string[], expected: SequenceExpectation): boolean { if (!isSequenceShape(expected)) return equalJson(actual as JsonValue, expected as JsonValue); if (expected.equals !== undefined && !sequenceMatches(actual, expected.equals)) return false; return expected.startsWith === undefined || expected.startsWith.every((name: string, index: number) => actual[index] === name); }
function countFor(value: JsonValue): number | undefined { if (Array.isArray(value)) return value.length; if (isObject(value)) return Object.keys(value).length; return undefined; }
export function matchesJsonResult(shape: JsonResultShape, value: JsonValue): boolean {
  if (shape.equals !== undefined && !equalJson(shape.equals, value)) return false;
  if (shape.type !== undefined && !jsonTypeMatches(value, shape.type)) return false;
  if (shape.nonEmpty && (value === "" || value === null || Array.isArray(value) && value.length === 0 || isObject(value) && Object.keys(value).length === 0)) return false;
  const objectValue = isObject(value) ? value : undefined;
  if (shape.requiredKeys && (!objectValue || shape.requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(objectValue, key)))) return false;
  if (shape.forbiddenProperties && objectValue && shape.forbiddenProperties.some((key) => Object.prototype.hasOwnProperty.call(objectValue, key))) return false;
  if (shape.propertyTypes && (!objectValue || Object.entries(shape.propertyTypes).some(([key, type]) => !Object.prototype.hasOwnProperty.call(objectValue, key) || !jsonTypeMatches(objectValue[key] as JsonValue, type)))) return false;
  if (shape.properties && (!objectValue || Object.entries(shape.properties).some(([key, nested]) => !Object.prototype.hasOwnProperty.call(objectValue, key) || !matchesJsonResult(nested, objectValue[key] as JsonValue)))) return false;
  const count = countFor(value);
  if (shape.count !== undefined && count !== shape.count) return false;
  if (shape.minCount !== undefined && (count === undefined || count < shape.minCount)) return false;
  return true;
}
function schemaTypeMatches(actual: unknown, expected: string): boolean { return actual === expected || expected === "number" && actual === "integer"; }
function matchesOutputSchemaShape(shape: OutputSchemaShape, schema: JsonSchema): boolean {
  if (shape.type !== undefined && !schemaTypeMatches(schema.type, shape.type)) return false;
  const properties = isObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required.filter((key): key is string => typeof key === "string") : [];
  if (shape.requiredKeys && shape.requiredKeys.some((key) => !required.includes(key))) return false;
  if (shape.forbiddenProperties?.some((key) => Object.prototype.hasOwnProperty.call(properties, key))) return false;
  if (shape.propertyTypes && Object.entries(shape.propertyTypes).some(([key, type]) => !isObject(properties[key]) || !schemaTypeMatches(properties[key].type, type))) return false;
  return true;
}
export function matchesOutputSchema(shape: OutputSchemaShape, schema: JsonSchema): boolean { return matchesOutputSchemaShape(shape, schema); }

function usageFrom(message: Record<string, unknown>): { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number; model: string } | undefined {
  if (message.role !== "assistant" || !isObject(message.usage)) return undefined;
  const usage = message.usage;
  const cost = isObject(usage.cost) && typeof usage.cost.total === "number" ? usage.cost.total : 0;
  const responseModel = typeof message.responseModel === "string" ? message.responseModel : message.model;
  const model = typeof message.provider === "string" && typeof responseModel === "string" ? `${message.provider}/${responseModel}` : "unknown/unknown";
  return { input: typeof usage.input === "number" ? usage.input : 0, output: typeof usage.output === "number" ? usage.output : 0, cacheRead: typeof usage.cacheRead === "number" ? usage.cacheRead : 0, cacheWrite: typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0, totalTokens: typeof usage.totalTokens === "number" ? usage.totalTokens : (typeof usage.input === "number" ? usage.input : 0) + (typeof usage.output === "number" ? usage.output : 0) + (typeof usage.cacheRead === "number" ? usage.cacheRead : 0) + (typeof usage.cacheWrite === "number" ? usage.cacheWrite : 0), cost, model };
}

export function extractParentOracle(entries: readonly unknown[]): ParentOracle {
  const batches: ParentAssistantBatch[] = [];
  const workflowToolResults: ParentToolResult[] = [];
  const modelCosts = new Map<string, number>();
  const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
  for (const entry of entries) {
    if (!isObject(entry) || entry.type !== "message" || !isObject(entry.message)) continue;
    const message = entry.message;
    if (message.role === "toolResult" && message.toolName === "workflow") {
      const details = isJson(message.details) ? { details: message.details } : {};
      const text = Array.isArray(message.content) ? message.content.flatMap((part) => isObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n") : "";
      workflowToolResults.push({ ...(typeof message.toolCallId === "string" ? { toolCallId: message.toolCallId } : {}), ...details, ...(typeof message.isError === "boolean" ? { isError: message.isError } : {}), ...(text ? { text } : {}) });
      continue;
    }
    if (message.role !== "assistant") continue;
    const rawParts = Array.isArray(message.content) ? message.content : [];
    const parts = rawParts.filter(isJson);
    const tools = parts.flatMap((part) => isObject(part) && part.type === "toolCall" && typeof part.name === "string" ? [part.name] : []);
    const usage = usageFrom(message);
    batches.push({ index: batches.length, parts, tools, ...(usage ? { usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, totalTokens: usage.totalTokens, cost: usage.cost, models: [{ model: usage.model, cost: usage.cost }] } } : {}) });
    if (usage) {
      totals.input += usage.input; totals.output += usage.output; totals.cacheRead += usage.cacheRead; totals.cacheWrite += usage.cacheWrite; totals.totalTokens += usage.totalTokens; totals.cost += usage.cost;
      modelCosts.set(usage.model, (modelCosts.get(usage.model) ?? 0) + usage.cost);
    }
  }
  const firstBatch = batches[0];
  const parentToolSequence = batches.flatMap(({ tools }) => tools);
  const firstWorkflowIndex = parentToolSequence.indexOf("workflow");
  const firstWorkflowBatch = batches.find(({ tools }) => tools.includes("workflow"));
  const skillReads = batches.flatMap(({ parts }) => parts.flatMap((part) => {
    if (!isObject(part) || part.type !== "toolCall" || part.name !== "read" || !isObject(part.arguments) || typeof part.arguments.path !== "string" || !/SKILL\.md$/.test(part.arguments.path)) return [];
    return [part.arguments.path];
  }));
  let firstSignificantAction: SignificantAction | undefined;
  for (const part of batches.flatMap(({ parts }) => parts)) {
    if (!isObject(part)) continue;
    if (part.type === "toolCall" && typeof part.name === "string" && part.name.trim()) { firstSignificantAction = { kind: "tool", name: part.name }; break; }
    if (part.type === "text" && typeof part.text === "string" && part.text.trim()) { firstSignificantAction = { kind: "text" }; break; }
    if (part.type === "thinking" && typeof part.thinking === "string" && part.thinking.trim()) { firstSignificantAction = { kind: "thinking" }; break; }
  }
  return { assistantBatches: batches, workflowToolResults, skillReads, ...(firstSignificantAction ? { firstSignificantAction } : {}), ...(parentToolSequence[0] ? { firstTool: parentToolSequence[0] } : {}), firstBatchToolSequence: firstBatch?.tools ?? [], toolsBeforeFirstWorkflow: firstWorkflowIndex < 0 ? parentToolSequence : parentToolSequence.slice(0, firstWorkflowIndex), firstWorkflowBatchToolSequence: firstWorkflowBatch?.tools ?? [], parentToolSequence, workflowCallCount: parentToolSequence.filter((name) => name === "workflow").length, usage: { ...totals, models: [...modelCosts].map(([model, cost]) => ({ model, cost })) } };
}

export function extractParentOracleFile(path: string): ParentOracle {
  const entries = readFileSync(path, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as unknown);
  return extractParentOracle(entries);
}

function resultForCall(oracle: ParentOracle, call: CapturedWorkflowCall, callIndex: number): ParentToolResult | undefined {
  return call.toolCallId ? oracle.workflowToolResults.find(({ toolCallId }) => toolCallId === call.toolCallId) ?? oracle.workflowToolResults[callIndex] : oracle.workflowToolResults[callIndex];
}

export function extractCapturedWorkflows(oracle: ParentOracle): CapturedWorkflowCall[] {
  let callIndex = 0;
  return oracle.assistantBatches.flatMap((batch) => batch.parts.flatMap((part) => {
    if (!isObject(part) || part.type !== "toolCall" || part.name !== "workflow") return [];
    const index = callIndex++;
    const args = isJson(part.arguments) ? part.arguments : null;
    const toolCallId = typeof part.id === "string" ? part.id : undefined;
    const call = { batch: batch.index, ...(toolCallId ? { toolCallId } : {}), arguments: args };
    const result = resultForCall(oracle, call, index);
    const details = result ? asJsonObject(result.details) : undefined;
    const validation = details && isObject(details.validation) ? details.validation : undefined;
    const validatedScript = validation && typeof validation.script === "string" ? validation.script : undefined;
    const argsObject = asJsonObject(args);
    return [{ ...call, ...(typeof argsObject?.script === "string" ? { script: argsObject.script } : validatedScript ? { script: validatedScript } : {}) }];
  }));
}

function validationErrorCode(text: string): WorkflowErrorCode | undefined {
  const prefixed = text.match(new RegExp(`${CAPTURE_ERROR_PREFIX}([A-Z_]+):`))?.[1];
  if (prefixed && ERROR_CODES.includes(prefixed as WorkflowErrorCode)) return prefixed as WorkflowErrorCode;
  return ERROR_CODES.find((code) => text.includes(code));
}

export function captureValidationReports(oracle: ParentOracle, calls: readonly CapturedWorkflowCall[]): { reports: ProductionValidationReport[]; errors: string[]; verified: boolean } {
  const errors: string[] = [];
  const reports = calls.map((call, callIndex): ProductionValidationReport => {
    const result = resultForCall(oracle, call, callIndex);
    const details = result ? asJsonObject(result.details) : undefined;
    const validation = details && isObject(details.validation) ? details.validation : undefined;
    if (result && !result.isError && details?.captureIdentity === CAPTURE_IDENTITY && details.realWorkflowAgentsLaunched === 0 && validation?.valid === true) return { callIndex, valid: true };
    const text = result?.text ?? "";
    if (result?.isError) {
      const errorCode = validationErrorCode(text);
      return { callIndex, valid: false, ...(errorCode ? { errorCode } : {}), ...(text ? { message: text } : {}) };
    }
    errors.push(`workflow ${String(callIndex)} did not return a recognized production-validation capture result`);
    return { callIndex, valid: false, ...(text ? { message: text } : {}) };
  });
  if (oracle.workflowToolResults.length !== calls.length) errors.push(`capture had ${String(oracle.workflowToolResults.length)} workflow tool results for ${String(calls.length)} calls`);
  return { reports, errors, verified: errors.length === 0 };
}

export function evalExpectationErrors(oracle: ParentOracle, expectations: EvalExpectations): string[] {
  const errors: string[] = [];
  if (expectations.firstSignificantAction && JSON.stringify(oracle.firstSignificantAction) !== JSON.stringify(expectations.firstSignificantAction)) errors.push(`first significant action was ${JSON.stringify(oracle.firstSignificantAction)}`);
  if (expectations.firstTool !== undefined && oracle.firstTool !== expectations.firstTool) errors.push(`first tool was ${String(oracle.firstTool)}`);
  if (expectations.firstBatchToolSequence && !sequenceMatches(oracle.firstBatchToolSequence, expectations.firstBatchToolSequence)) errors.push(`first batch tools were ${JSON.stringify(oracle.firstBatchToolSequence)}`);
  if (expectations.parentToolSequence && !sequenceMatches(oracle.parentToolSequence, expectations.parentToolSequence)) errors.push(`parent tools were ${JSON.stringify(oracle.parentToolSequence)}`);
  if (expectations.workflowCallCount !== undefined) {
    const { min, max } = typeof expectations.workflowCallCount === "number" ? { min: expectations.workflowCallCount, max: expectations.workflowCallCount } : expectations.workflowCallCount;
    if (min !== undefined && oracle.workflowCallCount < min || max !== undefined && oracle.workflowCallCount > max) errors.push(`workflow call count was ${String(oracle.workflowCallCount)}`);
  }
  return errors;
}

export function replayExpectationErrors(calls: readonly CapturedWorkflowCall[], reports: readonly ReplayReport[], expectations: EvalExpectations): string[] {
  const errors: string[] = [];
  const staticCalls = calls.flatMap((call) => { try { return call.script ? inspectWorkflowScript(call.script) : []; } catch { return []; } });
  for (const kind of expectations.requiredOperations ?? []) if (!staticCalls.some((call) => call.kind === kind)) errors.push(`replay had no ${kind} call`);
  for (const role of expectations.requiredRoles ?? []) if (!staticCalls.some((call) => call.kind === "agent" && call.role === role)) errors.push(`replay had no agent role ${role}`);
  const agentCalls = reports.flatMap((report) => report.trace?.agentCalls ?? []);
  if (expectations.minimumAgentCalls !== undefined && agentCalls.length < expectations.minimumAgentCalls) errors.push(`replay had ${String(agentCalls.length)} agent calls`);
  for (const policy of expectations.agentPolicies ?? []) {
    const call = agentCalls[policy.callIndex];
    if (!call) { errors.push(`agent policy ${String(policy.callIndex)} had no matching call`); continue; }
    if (policy.role !== undefined && call.options.role !== policy.role) errors.push(`agent ${String(policy.callIndex)} role was ${JSON.stringify(call.options.role)}`);
    if (policy.model !== undefined && call.options.model !== policy.model) errors.push(`agent ${String(policy.callIndex)} model was ${JSON.stringify(call.options.model)}`);
    for (const option of policy.forbidOptions ?? []) if (Object.prototype.hasOwnProperty.call(call.options, option)) errors.push(`agent ${String(policy.callIndex)} unexpectedly specified ${option}`);
    if (policy.tools) {
      const present = Object.prototype.hasOwnProperty.call(call.options, "tools");
      const tools = Array.isArray(call.options.tools) ? call.options.tools : [];
      if (policy.tools.mode === "omitted" && present) errors.push(`agent ${String(policy.callIndex)} tools were not omitted`);
      if (policy.tools.mode === "empty" && (!present || tools.length !== 0)) errors.push(`agent ${String(policy.callIndex)} tools were not explicitly empty`);
      if (policy.tools.mode === "exact" && (!present || JSON.stringify(tools) !== JSON.stringify(policy.tools.values ?? []))) errors.push(`agent ${String(policy.callIndex)} tools were ${JSON.stringify(tools)}`);
    }
  }
  const runtimeSchemas = agentCalls.flatMap(({ options }) => isObject(options.outputSchema) ? [options.outputSchema] : []);
  const staticSchemas = staticCalls.flatMap((call) => call.kind === "agent" && call.outputSchema ? [call.outputSchema] : []);
  const outputSchemas = runtimeSchemas.length ? runtimeSchemas : staticSchemas;
  if (expectations.requireOutputSchema) {
    if (typeof expectations.requireOutputSchema === "boolean") { if (!outputSchemas.length) errors.push("replay had no outputSchema"); }
    else {
      const shape = expectations.requireOutputSchema;
      if (shape.count !== undefined && outputSchemas.length !== shape.count) errors.push(`replay had ${String(outputSchemas.length)} output schemas`);
      if (shape.minCount !== undefined && outputSchemas.length < shape.minCount) errors.push(`replay had ${String(outputSchemas.length)} output schemas`);
      if (!outputSchemas.some((schemaValue) => matchesOutputSchemaShape(shape, schemaValue))) errors.push("replay had no outputSchema matching the required shape");
    }
  }
  for (const [expectedIndex, expected] of (expectations.expectedResults ?? []).entries()) {
    const index = expected.workflowIndex ?? expectedIndex;
    const report = reports[index];
    if (!report || report.error || report.result === undefined) { errors.push(`replay result ${String(index)} was unavailable`); continue; }
    if (expected.equals !== undefined && !equalJson(expected.equals, report.result)) errors.push(`replay result ${String(index)} did not equal the expected JSON`);
    if (expected.match && !matchesJsonResult(expected.match, report.result)) errors.push(`replay result ${String(index)} did not match the expected shape`);
  }
  return errors;
}

function staticCallRows(calls: readonly CapturedWorkflowCall[]): Array<{ call: StaticWorkflowCall; source: string }> {
  return calls.flatMap(({ script }) => {
    if (!script) return [];
    try { return inspectWorkflowScript(script).map((call) => ({ call, source: script.slice(call.start, call.end) })); }
    catch { return []; }
  });
}

export function staticExpectationResults(calls: readonly CapturedWorkflowCall[], expectations: EvalExpectations): CriterionResult[] {
  const rows = staticCallRows(calls);
  const staticCalls = rows.map(({ call }) => call);
  const agentRows = rows.filter(({ call }) => call.kind === "agent");
  const agentCalls = agentRows.map(({ call }) => call);
  const results: CriterionResult[] = [];
  const add = (id: string, pass: boolean, evidence: string) => { results.push({ id, pass, evidence }); };
  if (calls.some((call) => !call.script)) add("script", false, "A selected workflow had no resolved script.");
  for (const kind of expectations.requiredOperations ?? []) add(`operation:${kind}`, staticCalls.some((call) => call.kind === kind), `Required ${kind} operation.`);
  for (const kind of expectations.forbiddenOperations ?? []) add(`forbidden-operation:${kind}`, !staticCalls.some((call) => call.kind === kind), `Forbidden ${kind} operation.`);
  for (const role of expectations.requiredRoles ?? []) add(`role:${role}`, agentCalls.some((call) => call.role === role), `Required agent role ${role}.`);
  if (expectations.minimumAgentCalls !== undefined) add("minimum-agent-calls", agentCalls.length >= expectations.minimumAgentCalls, `Found ${String(agentCalls.length)} static agent calls; required ${String(expectations.minimumAgentCalls)}.`);
  for (const policy of expectations.agentPolicies ?? []) {
    const call = agentCalls[policy.callIndex];
    const options = call?.options ?? {};
    const optionKeys = new Set(call?.optionKeys ?? Object.keys(options));
    const failures: string[] = [];
    if (!call) failures.push("missing call");
    if (call && policy.role !== undefined && call.role !== policy.role) failures.push(`role ${JSON.stringify(call.role)}`);
    if (call && policy.model !== undefined && call.model !== policy.model) failures.push(`model ${JSON.stringify(call.model)}`);
    for (const option of policy.forbidOptions ?? []) if (optionKeys.has(option)) failures.push(`specified ${option}`);
    if (policy.tools) {
      const present = optionKeys.has("tools");
      const tools = Array.isArray(options.tools) ? options.tools : [];
      if (policy.tools.mode === "omitted" && present) failures.push("tools present");
      if (policy.tools.mode === "empty" && (!present || tools.length !== 0)) failures.push("tools not empty");
      if (policy.tools.mode === "exact" && (!present || JSON.stringify(tools) !== JSON.stringify(policy.tools.values ?? []))) failures.push(`tools ${JSON.stringify(tools)}`);
    }
    add(`agent-policy:${String(policy.callIndex)}`, failures.length === 0, failures.length ? failures.join(", ") : "Agent policy matched.");
  }
  if (expectations.requireOutputSchema) {
    const schemas = agentCalls.flatMap((call) => call.outputSchema ? [call.outputSchema] : []);
    const shape = expectations.requireOutputSchema;
    const pass = typeof shape === "boolean" ? schemas.length > 0 : (shape.count === undefined || schemas.length === shape.count) && (shape.minCount === undefined || schemas.length >= shape.minCount) && schemas.some((schemaValue) => matchesOutputSchemaShape(shape, schemaValue));
    add("output-schema", pass, `Found ${String(schemas.length)} matching candidate schemas.`);
  }
  if (expectations.requiredAgentOrder) {
    const order = expectations.requiredAgentOrder;
    const pass = order.every((expected, index) => { const call = agentCalls[index]; return Boolean(call) && (expected.role === undefined || call?.role === expected.role) && (expected.model === undefined || call?.model === expected.model) && (expected.promptIncludes === undefined || call?.prompt?.includes(expected.promptIncludes)); });
    add("agent-order", pass, `Checked ${String(order.length)} ordered agent selectors.`);
  }
  for (const flow of expectations.requiredDataFlow ?? []) {
    const source = agentRows[flow.toAgentIndex]?.source ?? "";
    const escaped = flow.binding.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pass = new RegExp(`prompt\\s*\\([\\s\\S]*\\{${escaped}\\}[\\s\\S]*\\{[\\s\\S]*\\b${escaped}\\b`).test(source);
    add(`data-flow:${flow.binding}:${String(flow.toAgentIndex)}`, pass, `Expected prompt interpolation of ${flow.binding} into agent ${String(flow.toAgentIndex)}.`);
  }
  return results;
}

function combinations(values: readonly number[], count: number, start = 0, prefix: readonly number[] = []): number[][] {
  if (prefix.length === count) return [[...prefix]];
  const output: number[][] = [];
  for (let index = start; index <= values.length - (count - prefix.length); index += 1) output.push(...combinations(values, count, index + 1, [...prefix, values[index] as number]));
  return output;
}

export function selectStaticCandidate(calls: readonly CapturedWorkflowCall[], validations: readonly ProductionValidationReport[], expectations: EvalExpectations, requiredCount = 1): { callIndices: readonly number[]; reports: readonly StaticCandidateReport[] } {
  if (requiredCount === 0) return { callIndices: [], reports: [] };
  const validIndices = validations.filter(({ valid }) => valid).map(({ callIndex }) => callIndex);
  const reports: StaticCandidateReport[] = [];
  for (const callIndices of combinations(validIndices, requiredCount)) {
    const criteria = staticExpectationResults(callIndices.map((index) => calls[index] as CapturedWorkflowCall), expectations);
    const report = { callIndices, criteria, passed: criteria.every(({ pass }) => pass) };
    reports.push(report);
    if (report.passed) return { callIndices, reports };
  }
  return { callIndices: [], reports };
}

export function assertEvalScriptSafe(script: string): void {
  for (const call of inspectWorkflowScript(script)) if (call.kind === "agent" && typeof call.retries === "number" && call.retries > 0) throw new WorkflowError("INVALID_METADATA", "Evaluation scripts must not request retries > 0");
}

function exampleForSchema(schema: JsonSchema): JsonValue {
  if (Object.prototype.hasOwnProperty.call(schema, "const") && isJson(schema.const)) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length && isJson(schema.enum[0])) return schema.enum[0];
  for (const key of ["anyOf", "oneOf", "allOf"]) { const choices = schema[key]; if (Array.isArray(choices) && isObject(choices[0])) return exampleForSchema(choices[0]); }
  const type = typeof schema.type === "string" ? schema.type : Array.isArray(schema.type) ? schema.type.find((item): item is string => typeof item === "string" && item !== "null") : undefined;
  if (type === "object" || isObject(schema.properties)) {
    const properties = isObject(schema.properties) ? schema.properties : {};
    return Object.fromEntries(Object.entries(properties).flatMap(([key, value]) => isObject(value) ? [[key, exampleForSchema(value)]] : []));
  }
  if (type === "array") return [];
  if (type === "number" || type === "integer") return 1;
  if (type === "boolean") return true;
  return "fake";
}

export function matchesJsonSchema(schema: JsonSchema, value: JsonValue): boolean { return Value.Check(schema as never, value); }

export async function replayWorkflowScript(script: string, args: JsonValue = null, signal?: AbortSignal): Promise<{ result: JsonValue; trace: ReplayTrace }> {
  assertEvalScriptSafe(script);
  const agentCalls: ReplayAgentCall[] = [];
  const phases: string[] = [];
  const logs: string[] = [];
  let active = 0;
  let maxConcurrentAgents = 0;
  const execution = runWorkflow(script, args, {
    agent: async (prompt, options, agentSignal, identity) => {
      if (typeof options.retries === "number" && options.retries > 0) throw new WorkflowError("INVALID_METADATA", "Evaluation retries are disabled");
      agentCalls.push({ prompt, options: structuredClone(options), identity });
      active += 1; maxConcurrentAgents = Math.max(maxConcurrentAgents, active);
      try {
        await new Promise<void>((resolve) => setTimeout(resolve, 10));
        const outputSchema = options.outputSchema;
        if (isObject(outputSchema)) {
          const value = exampleForSchema(outputSchema);
          if (!matchesJsonSchema(outputSchema, value)) throw new WorkflowError("RESULT_INVALID", "Fake agent result does not match outputSchema");
          return value;
        }
        return `fake:${prompt}`;
      } finally { active -= 1; }
    },
    phase: (name) => { phases.push(name); },
    log: (message) => { logs.push(message); },
  }, signal);
  const result = await execution.result;
  return { result, trace: { agentCalls, phases, logs, maxConcurrentAgents } };
}

export async function replayCapturedWorkflows(calls: readonly CapturedWorkflowCall[], args: JsonValue = null, signal?: AbortSignal): Promise<ReplayReport[]> {
  const reports: ReplayReport[] = [];
  for (const call of calls) {
    if (!call.script) { reports.push({ script: "", error: "workflow call did not contain an inline script" }); continue; }
    try { const replayed = await replayWorkflowScript(call.script, args, signal); reports.push({ script: call.script, result: replayed.result, trace: replayed.trace }); } catch (error) { reports.push({ script: call.script, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) }); }
  }
  return reports;
}

export interface CaptureCaseInput { case: WorkflowEvalCase; model: string; provider?: string; thinking?: string; piCommand?: string; maxCost: number }
interface PiRunResult { exitCode: number | null; timedOut: boolean; budgetExceeded: boolean; processGroupTerminated: boolean; stderr: string; error?: string }


function terminateProcess(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try { if (child.pid && globalThis.process.platform !== "win32") globalThis.process.kill(-child.pid, signal); else child.kill(signal); return true; } catch { return false; }
}
async function killProcessGroup(child: ChildProcess): Promise<boolean> {
  let terminated = terminateProcess(child, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (child.exitCode === null) terminated = terminateProcess(child, "SIGKILL") || terminated;
  return terminated;
}

async function runPiCapture(input: CaptureCaseInput, cwd: string, home: string, sessionDir: string, sessionId: string): Promise<PiRunResult> {
  const args = ["--offline", "--no-extensions", "--extension", fileURLToPath(new URL("./eval-capture-extension.js", import.meta.url)), "--no-skills", "--skill", resolveWorkflowSkillPath(), "--no-context-files", "--no-builtin-tools", "--tools", SAFE_PARENT_EVAL_TOOLS.join(","), "--mode", "json", "--session-dir", sessionDir, "--session-id", sessionId];
  if (input.model.includes("/")) args.push("--model", input.model); else { if (input.provider) args.push("--provider", input.provider); args.push("--model", input.model); }
  args.push("--thinking", input.thinking ?? "off");
  args.push("--print", input.case.prompt);
  const controller = new AbortController();
  let timedOut = false; let budgetExceeded = false; let processGroupTerminated = false; let streamCost = 0; let lineBuffer = ""; let stderr = ""; let spawnError: string | undefined; let killPromise: Promise<boolean> | undefined;
  const child = spawn(input.piCommand ?? process.env.PI_WORKFLOW_EVAL_PI ?? "pi", args, { cwd, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], signal: controller.signal });
  const requestKill = (): Promise<boolean> => { killPromise ??= killProcessGroup(child); return killPromise; };
  const inspectLine = (line: string) => {
    try { const event = JSON.parse(line) as unknown; if (!isObject(event) || event.type !== "message_end" || !isObject(event.message)) return; const usage = usageFrom(event.message); if (!usage) return; streamCost += usage.cost; if (streamCost > input.maxCost && !budgetExceeded) { budgetExceeded = true; controller.abort(); void requestKill().then((terminated) => { processGroupTerminated ||= terminated; }); } } catch { /* The JSON stream may contain a diagnostic line. */ }
  };
  child.stdout.on("data", (chunk: Buffer) => { lineBuffer += chunk.toString(); const lines = lineBuffer.split("\n"); lineBuffer = lines.pop() ?? ""; for (const line of lines) if (line) inspectLine(line); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-64_000); });
  child.once("error", (error: Error) => { spawnError = error.message; });
  const close = new Promise<number | null>((resolve) => { child.once("close", (code) => { resolve(code); }); });
  const timer = input.case.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; controller.abort(); void requestKill().then((terminated) => { processGroupTerminated ||= terminated; }); }, input.case.timeoutMs);
  const exitCode = await close; if (timer) clearTimeout(timer);
  if (lineBuffer) inspectLine(lineBuffer);
  if (killPromise) processGroupTerminated ||= await killPromise;
  return { exitCode, timedOut, budgetExceeded, processGroupTerminated, stderr, ...(spawnError ? { error: spawnError } : {}) };
}

function addUsage(left: ParentUsage, right: ParentUsage): ParentUsage {
  const models = new Map<string, number>();
  for (const item of [...left.models, ...right.models]) models.set(item.model, (models.get(item.model) ?? 0) + item.cost);
  return { input: left.input + right.input, output: left.output + right.output, cacheRead: left.cacheRead + right.cacheRead, cacheWrite: left.cacheWrite + right.cacheWrite, totalTokens: left.totalTokens + right.totalTokens, cost: left.cost + right.cost, models: [...models].map(([model, cost]) => ({ model, cost })) };
}

export function parseSemanticJudge(raw: string, criteria: readonly SemanticCriterion[]): CriterionResult[] {
  const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned) as unknown;
  const parsedCriteria = isObject(parsed) ? parsed.criteria : undefined;
  if (!Array.isArray(parsedCriteria)) throw new Error("Semantic judge must return a criteria array.");
  const criteriaValues = parsedCriteria as unknown[];
  return criteria.map(({ id }) => {
    const item = criteriaValues.find((candidate) => isObject(candidate) && candidate.id === id);
    if (!isObject(item) || typeof item.pass !== "boolean" || typeof item.evidence !== "string" || !item.evidence.trim()) throw new Error(`Semantic judge omitted criterion ${id}.`);
    return { id, pass: item.pass, evidence: item.evidence.trim() };
  });
}

interface JudgeProcessResult extends PiRunResult { raw: string; usage: ParentUsage }

function semanticJudgePrompt(evalCase: WorkflowEvalCase, calls: readonly CapturedWorkflowCall[], cwd: string, home: string): string {
  const roles = loadAgentDefinitions(cwd, join(home, ".pi"));
  const usedRoles = new Set(calls.flatMap(({ script }) => { try { return script ? inspectWorkflowScript(script).flatMap((call) => call.kind === "agent" && call.role ? [call.role] : []) : []; } catch { return []; } }));
  const roleText = [...usedRoles].map((role) => `${role}: ${roles[role]?.description ?? "no description"}`).join("\n") || "none";
  const docs = "agent(prompt, options) delegates; parallel(name, tasks) runs independent tasks concurrently; pipeline(name, items, stages) applies ordered stages; prompt(template, data) carries values into prompts. A role owns model/thinking/tools policy.";
  return `Judge whether the captured workflow design satisfies each criterion. Do not execute it. Return only JSON: {"criteria":[{"id":"criterion id","pass":true,"evidence":"specific script evidence"}]}.\n\nOriginal request:\n${evalCase.prompt}\n\nCriteria:\n${JSON.stringify(evalCase.semanticCriteria ?? [])}\n\nDSL:\n${docs}\n\nRelevant roles:\n${roleText}\n\nCaptured workflow script(s):\n${calls.map((call, index) => `--- ${String(index)} ---\n${call.script ?? "<missing>"}`).join("\n")}`;
}

async function runSemanticJudge(input: CaptureCaseInput, calls: readonly CapturedWorkflowCall[], cwd: string, home: string, sessionDir: string, maxCost: number): Promise<JudgeProcessResult> {
  const args = ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-tools", "--mode", "json", "--session-dir", sessionDir, "--session-id", randomUUID()];
  if (input.model.includes("/")) args.push("--model", input.model); else { if (input.provider) args.push("--provider", input.provider); args.push("--model", input.model); }
  args.push("--thinking", "off", "--print", semanticJudgePrompt(input.case, calls, cwd, home));
  const controller = new AbortController();
  let timedOut = false; let budgetExceeded = false; let processGroupTerminated = false; let stderr = ""; let spawnError: string | undefined; let killPromise: Promise<boolean> | undefined; let lineBuffer = ""; let raw = ""; let usage = emptyAccounting();
  const child = spawn(input.piCommand ?? process.env.PI_WORKFLOW_EVAL_PI ?? "pi", args, { cwd, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], signal: controller.signal });
  const requestKill = (): Promise<boolean> => { killPromise ??= killProcessGroup(child); return killPromise; };
  const inspectLine = (line: string) => {
    try {
      const event: unknown = JSON.parse(line);
      if (!isObject(event) || event.type !== "message_end" || !isObject(event.message) || event.message.role !== "assistant") return;
      const measured = usageFrom(event.message);
      if (measured) usage = addUsage(usage, { input: measured.input, output: measured.output, cacheRead: measured.cacheRead, cacheWrite: measured.cacheWrite, totalTokens: measured.totalTokens, cost: measured.cost, models: [{ model: measured.model, cost: measured.cost }] });
      if (Array.isArray(event.message.content)) raw = event.message.content.flatMap((part) => isObject(part) && part.type === "text" && typeof part.text === "string" ? [part.text] : []).join("\n");
      if (usage.cost > maxCost && !budgetExceeded) { budgetExceeded = true; controller.abort(); void requestKill().then((terminated) => { processGroupTerminated ||= terminated; }); }
    } catch { /* Ignore diagnostics in the JSON stream. */ }
  };
  child.stdout.on("data", (chunk: Buffer) => { lineBuffer += chunk.toString(); const lines = lineBuffer.split("\n"); lineBuffer = lines.pop() ?? ""; for (const line of lines) if (line) inspectLine(line); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-64_000); });
  child.once("error", (error: Error) => { spawnError = error.message; });
  const close = new Promise<number | null>((resolve) => { child.once("close", resolve); });
  const timer = input.case.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; controller.abort(); void requestKill().then((terminated) => { processGroupTerminated ||= terminated; }); }, input.case.timeoutMs);
  const exitCode = await close; if (timer) clearTimeout(timer); if (lineBuffer) inspectLine(lineBuffer); if (killPromise) processGroupTerminated ||= await killPromise;
  return { raw, usage, exitCode, timedOut, budgetExceeded, processGroupTerminated, stderr, ...(spawnError ? { error: spawnError } : {}) };
}

function seedEvalProject(cwd: string, home: string, model: string): void {
  const source = process.env.PI_WORKFLOW_EVAL_SOURCE_PROJECT_DIR;
  if (!source) return;
  const excluded = new Set([".git", "node_modules", "dist", ".tmp"]);
  for (const entry of readdirSync(source)) {
    if (excluded.has(entry)) continue;
    cpSync(join(source, entry), join(cwd, entry), { recursive: true, filter: (path) => !excluded.has(basename(path)) });
  }
  const roles = join(source, ".pi", "piworkflows", "roles");
  const roleTargets = [join(home, ".pi", "piworkflows", "roles"), join(cwd, ".pi", "piworkflows", "roles")];
  if (!existsSync(roles)) return;
  cpSync(roles, roleTargets[0] as string, { recursive: true });
  for (const target of roleTargets) {
    if (!existsSync(target)) continue;
    for (const name of readdirSync(target).filter((entry) => entry.endsWith(".md"))) {
      const path = join(target, name);
      const content = readFileSync(path, "utf8");
      const frontmatterEnd = content.startsWith("---\n") ? content.indexOf("\n---", 4) : -1;
      if (frontmatterEnd >= 0) writeFileSync(path, `${content.slice(0, frontmatterEnd).replace(/^model:.*$/m, `model: ${model}`)}${content.slice(frontmatterEnd)}`);
    }
  }
}

async function findParentSession(cwd: string, sessionDir: string, sessionId: string): Promise<string | undefined> {
  try { const sessions = await SessionManager.list(cwd, sessionDir); const found = sessions.find((session) => session.id === sessionId); if (found) return found.path; } catch { /* Fall through to the JSONL scan. */ }
  const visit = (directory: string): string | undefined => {
    if (!existsSync(directory)) return undefined;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { const found = visit(path); if (found) return found; }
      else if (entry.name.endsWith(".jsonl")) {
        try { const header = JSON.parse(readFileSync(path, "utf8").split("\n")[0] ?? "{}") as unknown; if (isObject(header) && header.id === sessionId) return path; } catch { /* Ignore incomplete files. */ }
      }
    }
    return undefined;
  };
  return visit(sessionDir);
}

function emptyAccounting(cost = 0): EvalAccounting { return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost, models: [] }; }
function emptyMetrics(requiredWorkflowCallCount = 1): EvalMetrics { return { parentUsageThroughCandidate: null, parentOutputTokensThroughCandidate: null, nonWorkflowToolSequenceBeforeCandidate: [], nonWorkflowToolCallCountBeforeCandidate: 0, workflowCallCountBeforeCandidate: 0, invalidWorkflowCallCount: 0, productionValidationErrorCodes: [], candidateCallIndices: [], staticCandidates: [], semanticCriteria: [], anyValidCandidate: false, requiredWorkflowCallCount, surplusWorkflowCallCount: 0 }; }
function resultFromFailure(input: CaptureCaseInput, status: EvalCaseResult["status"], errors: readonly string[], processExited = true, processGroupTerminated = false, diagnostics: readonly string[] = [], cost = 0): EvalCaseResult { const required = input.case.expectedWorkflowCalls ?? (input.case.expectations.workflowCallCount === 0 ? 0 : 1); return { id: input.case.id, status, limits: { ...(input.case.timeoutMs === undefined ? {} : { timeoutMs: input.case.timeoutMs }), maxCost: input.maxCost }, workflows: [], productionValidation: [], metrics: emptyMetrics(required), accounting: emptyAccounting(cost), accountingTrustworthy: false, diagnostics, errors, cleanup: { processExited, processGroupTerminated, tempRootRemoved: false, captureIdentityVerified: false, realWorkflowAgentsLaunched: null } }; }

function withTempRootRemoved(result: EvalCaseResult): EvalCaseResult { return { ...result, cleanup: { ...result.cleanup, tempRootRemoved: true } }; }

function seedPiIdentity(home: string): void {
  const source = process.env.PI_WORKFLOW_EVAL_SOURCE_AGENT_DIR;
  if (!source) return;
  const target = join(home, ".pi", "agent");
  mkdirSync(target, { recursive: true, mode: 0o700 });
  for (const name of ["auth.json", "models.json"]) {
    const path = join(source, name);
    if (existsSync(path)) {
      const destination = join(target, name);
      copyFileSync(path, destination);
      chmodSync(destination, 0o600);
    }
  }
}

function usageThroughCandidate(oracle: ParentOracle, calls: readonly CapturedWorkflowCall[], indices: readonly number[]): ParentUsage | null {
  const last = indices.at(-1);
  if (last === undefined) return null;
  return oracle.assistantBatches.filter(({ index }) => index <= (calls[last]?.batch ?? -1)).reduce((sum, batch) => addUsage(sum, batch.usage ?? emptyAccounting()), emptyAccounting());
}

function preliminaryTools(oracle: ParentOracle, firstCandidateIndex: number | undefined): string[] {
  if (firstCandidateIndex === undefined) return [];
  let seen = 0; const tools: string[] = [];
  for (const tool of oracle.parentToolSequence) {
    if (tool === "workflow") { if (seen === firstCandidateIndex) break; seen += 1; }
    else tools.push(tool);
  }
  return tools;
}

export async function captureEvalCase(input: CaptureCaseInput): Promise<EvalCaseResult> {
  const root = mkdtempSync(join(process.env.PI_WORKFLOW_EVAL_CASE_ROOT ?? tmpdir(), "pi-workflow-capture-"));
  const cwd = join(root, "project"); const home = join(root, "home"); const sessionDir = join(root, "sessions"); const sessionId = randomUUID();
  try {
    mkdirSync(cwd, { recursive: true }); mkdirSync(home, { recursive: true }); mkdirSync(sessionDir, { recursive: true }); seedPiIdentity(home); seedEvalProject(cwd, home, input.model.includes("/") ? input.model : input.provider ? `${input.provider}/${input.model}` : input.model);
    const pi = await runPiCapture(input, cwd, home, sessionDir, sessionId);
    const diagnostics = [pi.stderr, pi.error ? `Pi process error: ${pi.error}` : ""].filter(Boolean);
    const sessionFile = await findParentSession(cwd, sessionDir, sessionId);
    if (!sessionFile) {
      const status = pi.timedOut ? "timed_out" : pi.budgetExceeded ? "budget_exceeded" : "failed";
      return withTempRootRemoved(resultFromFailure(input, status, ["Parent Pi session was not written."], pi.exitCode !== null, pi.processGroupTerminated, diagnostics));
    }
    const oracle = extractParentOracleFile(sessionFile);
    const workflows = extractCapturedWorkflows(oracle);
    const validation = captureValidationReports(oracle, workflows);
    const requiredCount = input.case.expectedWorkflowCalls ?? (input.case.expectations.workflowCallCount === 0 ? 0 : 1);
    const selection = selectStaticCandidate(workflows, validation.reports, input.case.expectations, requiredCount);
    const unsafeTool = oracle.parentToolSequence.find((tool) => !SAFE_PARENT_EVAL_TOOLS.includes(tool as (typeof SAFE_PARENT_EVAL_TOOLS)[number]));
    const errors = [...evalExpectationErrors(oracle, input.case.expectations), ...validation.errors, ...(unsafeTool ? [`parent tool is outside the safe eval allowlist: ${unsafeTool}`] : [])];
    if (requiredCount > 0 && selection.callIndices.length === 0) errors.push("Catastrophic validity failure: no production-valid workflow candidate satisfied static expectations.");
    let judge: SemanticJudgeReport | undefined;
    let judgeProcess: JudgeProcessResult | undefined;
    if (selection.callIndices.length > 0) {
      const criteria = input.case.semanticCriteria ?? semantic("The workflow design is semantically appropriate for the original request.");
      const judgeCase = { ...input.case, semanticCriteria: criteria };
      judgeProcess = await runSemanticJudge({ ...input, case: judgeCase }, selection.callIndices.map((index) => workflows[index] as CapturedWorkflowCall), cwd, home, sessionDir, Math.max(0, input.maxCost - oracle.usage.cost));
      diagnostics.push(judgeProcess.stderr, judgeProcess.error ? `Judge process error: ${judgeProcess.error}` : "");
      if (judgeProcess.exitCode !== 0 || judgeProcess.error) errors.push("Semantic judge process failed.");
      else {
        try {
          const criterionResults = parseSemanticJudge(judgeProcess.raw, criteria);
          judge = { criteria: criterionResults, usage: judgeProcess.usage, raw: judgeProcess.raw };
          if (criterionResults.some(({ pass }) => !pass)) errors.push("Semantic judge rejected one or more criteria.");
        } catch (error) { errors.push(`Invalid semantic judge output: ${error instanceof Error ? error.message : String(error)}`); }
      }
    }
    const parentUsageThroughCandidate = usageThroughCandidate(oracle, workflows, selection.callIndices);
    const before = preliminaryTools(oracle, selection.callIndices[0]);
    const accounting = addUsage(oracle.usage, judgeProcess?.usage ?? emptyAccounting());
    const metrics: EvalMetrics = {
      parentUsageThroughCandidate,
      parentOutputTokensThroughCandidate: parentUsageThroughCandidate?.output ?? null,
      nonWorkflowToolSequenceBeforeCandidate: before,
      nonWorkflowToolCallCountBeforeCandidate: before.length,
      workflowCallCountBeforeCandidate: selection.callIndices[0] ?? oracle.workflowCallCount,
      invalidWorkflowCallCount: validation.reports.filter(({ valid }) => !valid).length,
      productionValidationErrorCodes: validation.reports.flatMap(({ errorCode }) => errorCode ? [errorCode] : []),
      candidateCallIndices: selection.callIndices,
      staticCandidates: selection.reports,
      semanticCriteria: judge?.criteria ?? [],
      anyValidCandidate: selection.callIndices.length > 0,
      requiredWorkflowCallCount: requiredCount,
      surplusWorkflowCallCount: Math.max(0, validation.reports.filter(({ valid }) => valid).length - requiredCount),
    };
    const timedOut = pi.timedOut || Boolean(judgeProcess?.timedOut);
    const overBudget = pi.budgetExceeded || Boolean(judgeProcess?.budgetExceeded) || accounting.cost > input.maxCost;
    const status: EvalCaseResult["status"] = timedOut ? "timed_out" : overBudget ? "budget_exceeded" : errors.length || pi.exitCode !== 0 ? "failed" : "passed";
    const result: EvalCaseResult = { id: input.case.id, status, limits: { ...(input.case.timeoutMs === undefined ? {} : { timeoutMs: input.case.timeoutMs }), maxCost: input.maxCost }, oracle, workflows, productionValidation: validation.reports, ...(judge ? { semanticJudge: judge } : {}), metrics, accounting, accountingTrustworthy: !timedOut && pi.exitCode === 0 && (!judgeProcess || judgeProcess.exitCode === 0), diagnostics: diagnostics.filter(Boolean), errors, cleanup: { processExited: pi.exitCode !== null && (!judgeProcess || judgeProcess.exitCode !== null), processGroupTerminated: pi.processGroupTerminated || Boolean(judgeProcess?.processGroupTerminated), tempRootRemoved: false, captureIdentityVerified: validation.verified, realWorkflowAgentsLaunched: validation.verified ? 0 : null } };
    return withTempRootRemoved(result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export interface IsolatedProcessOptions { childPath: string; timeoutMs?: number; env?: NodeJS.ProcessEnv }
export interface IsolatedProcessResult<T> { value?: T; timedOut: boolean; exitCode: number | null; processGroupTerminated: boolean; stderr: string; error?: string }
export async function runIsolatedProcess<T>(payload: unknown, options: IsolatedProcessOptions): Promise<IsolatedProcessResult<T>> {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-case-")); const inputPath = join(root, "input.json"); const outputPath = join(root, "output.json");
  try {
    writeFileSync(inputPath, `${JSON.stringify({ payload, outputPath })}\n`, { mode: 0o600 });
    const controller = new AbortController();
    const child = spawn(process.execPath, [options.childPath, inputPath], { cwd: root, env: { ...process.env, ...options.env, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "home", ".pi", "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), PI_WORKFLOW_EVAL_CASE_ROOT: root }, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"], signal: controller.signal });
    let timedOut = false; let processGroupTerminated = false; let stderr = ""; let processError: string | undefined; let killPromise: Promise<boolean> | undefined;
    child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-64_000); });
    child.once("error", (error: Error) => { processError = error.message; });
    const close = new Promise<number | null>((resolve) => { child.once("close", (code) => { resolve(code); }); });
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; controller.abort(); killPromise ??= killProcessGroup(child); void killPromise.then((terminated) => { processGroupTerminated ||= terminated; }); }, options.timeoutMs);
    const exitCode = await close; if (timer) clearTimeout(timer);
    if (killPromise) processGroupTerminated ||= await killPromise;
    if (!existsSync(outputPath)) return { timedOut, exitCode, processGroupTerminated, stderr, ...(processError ? { error: processError } : {}) };
    try {
      const value = JSON.parse(readFileSync(outputPath, "utf8")) as T;
      return { value, timedOut, exitCode, processGroupTerminated, stderr, ...(processError ? { error: processError } : {}) };
    } catch (error) {
      return { timedOut, exitCode, processGroupTerminated, stderr, error: `Invalid child JSON: ${error instanceof Error ? error.message : String(error)}` };
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export interface WorkflowEvalRunOptions { cases?: readonly WorkflowEvalCase[]; caseIds?: readonly string[]; model?: string; provider?: string; thinking?: string; piCommand?: string; timeoutMs?: number; spendCeiling?: number; artifactsDir?: string }

function materializeCase(candidate: WorkflowEvalCase, model: string): WorkflowEvalCase {
  return JSON.parse(JSON.stringify(candidate).replaceAll(EVAL_MODEL_TOKEN, model)) as WorkflowEvalCase;
}
export interface WorkflowEvalRunResult { artifactDir: string; cases: readonly EvalCaseResult[]; spent: number; skipped: readonly string[] }

export async function runWorkflowEvals(options: WorkflowEvalRunOptions = {}): Promise<WorkflowEvalRunResult> {
  const model = options.model ?? process.env.PI_WORKFLOW_EVAL_MODEL;
  if (!model) throw new Error("Set --model or PI_WORKFLOW_EVAL_MODEL before running model evals.");
  const explicitModel = model.includes("/") ? model : options.provider ? `${options.provider}/${model}` : model;
  const cases = (options.cases ?? INITIAL_WORKFLOW_EVAL_CASES).filter((candidate) => !options.caseIds?.length || options.caseIds.includes(candidate.id)).map((candidate) => materializeCase(candidate, explicitModel));
  const sourceAgentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  const ceiling = options.spendCeiling ?? Number(process.env.PI_WORKFLOW_EVAL_SPEND_CEILING ?? "1");
  if (!Number.isFinite(ceiling) || ceiling <= 0) throw new Error("spend ceiling must be positive");
  const artifactDir = options.artifactsDir ?? join(process.cwd(), ".tmp", "workflow-evals", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(artifactDir, { recursive: true });
  const results: EvalCaseResult[] = []; const skipped: string[] = []; let spent = 0;
  for (const candidate of cases) {
    const remaining = ceiling - spent;
    if (remaining <= 0) {
      const skippedResult = resultFromFailure({ case: { ...candidate, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }, model, maxCost: candidate.maxCost }, "skipped", ["Run spend ceiling reached."]);
      skipped.push(candidate.id); results.push(skippedResult); writeFileSync(join(artifactDir, `${candidate.id}.json`), `${JSON.stringify(skippedResult, null, 2)}\n`, { mode: 0o600 });
      continue;
    }
    const input: CaptureCaseInput = { case: { ...candidate, ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) }, model, ...(options.provider ? { provider: options.provider } : {}), ...(options.thinking ? { thinking: options.thinking } : {}), ...(options.piCommand ? { piCommand: options.piCommand } : {}), maxCost: Math.min(candidate.maxCost, remaining) };
    const isolated = await runIsolatedProcess<EvalCaseResult>(input, { childPath: fileURLToPath(new URL("./workflow-evals-child.js", import.meta.url)), ...(input.case.timeoutMs === undefined ? {} : { timeoutMs: input.case.timeoutMs * 2 + CASE_PROCESS_GRACE_MS }), env: { PI_WORKFLOW_EVAL_SOURCE_AGENT_DIR: sourceAgentDir, PI_WORKFLOW_EVAL_SOURCE_PROJECT_DIR: process.cwd() } });
    const diagnostics = [isolated.stderr, isolated.error ? `Case process error: ${isolated.error}` : ""].filter(Boolean);
    const trustworthy = Boolean(isolated.value) && !isolated.timedOut && isolated.exitCode === 0 && !isolated.error && Boolean(isolated.value?.accountingTrustworthy);
    const untrustedStatus: EvalCaseResult["status"] = isolated.timedOut ? "timed_out" : isolated.value?.status === "timed_out" || isolated.value?.status === "budget_exceeded" ? isolated.value.status : "failed";
    const base = isolated.value ?? resultFromFailure(input, untrustedStatus, [isolated.timedOut ? "Case process timed out." : isolated.error ? isolated.error : "Case process returned no artifact.", ...diagnostics], isolated.exitCode !== null, isolated.processGroupTerminated, diagnostics, input.maxCost);
    const result: EvalCaseResult = { ...base, ...(trustworthy ? {} : { status: untrustedStatus, accounting: { ...base.accounting, cost: input.maxCost }, accountingTrustworthy: false }), diagnostics: [...base.diagnostics, ...diagnostics] };
    spent += result.accounting.cost;
    results.push(result); writeFileSync(join(artifactDir, `${candidate.id}.json`), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
  return { artifactDir, cases: results, spent, skipped };
}

export function formatEvalSummary(result: WorkflowEvalRunResult): string {
  const rows = result.cases.map((item) => `${item.id}: ${item.status} (${item.accounting.cost.toFixed(4)} USD, ${String(item.accounting.totalTokens)} tok, ${String(item.workflows.length)} workflow calls)`);
  return [`Workflow evals: ${String(result.cases.length)} cases, ${result.spent.toFixed(4)} USD spent`, ...rows, result.skipped.length ? `Skipped: ${result.skipped.join(", ")}` : ""].filter(Boolean).join("\n");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2); const value = (name: string) => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
  const caseIds = value("--case")?.split(",").map((item) => item.trim()).filter(Boolean);
  const model = value("--model");
  const provider = value("--provider");
  const thinking = value("--thinking");
  const piCommand = value("--pi");
  const artifactsDir = value("--artifacts");
  const timeoutValue = Number(value("--timeout-ms") ?? "0");
  const result = await runWorkflowEvals({ ...(model ? { model } : {}), ...(provider ? { provider } : {}), ...(thinking ? { thinking } : {}), ...(piCommand ? { piCommand } : {}), ...(artifactsDir ? { artifactsDir } : {}), spendCeiling: Number(value("--spend-ceiling") ?? process.env.PI_WORKFLOW_EVAL_SPEND_CEILING ?? "1"), ...(timeoutValue ? { timeoutMs: timeoutValue } : {}), ...(caseIds?.length ? { caseIds } : {}) });
  process.stdout.write(`${formatEvalSummary(result)}\n`);
  if (result.cases.some((item) => item.status !== "passed")) process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });