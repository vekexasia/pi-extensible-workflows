/* eslint-disable @typescript-eslint/no-deprecated */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Value } from "typebox/value";
import { getAgentDir, parseFrontmatter, SessionManager } from "@earendil-works/pi-coding-agent";
import { CAPTURE_ERROR_PREFIX, CAPTURE_IDENTITY, resolveWorkflowSkillPath } from "./eval-capture-extension.js";
export { resolveWorkflowSkillPath } from "./eval-capture-extension.js";
import { ERROR_CODES, inspectWorkflowScript, loadAgentDefinitions, runWorkflow, WorkflowError, type AgentIdentity, type JsonSchema, type JsonValue, type StaticWorkflowCall, type StaticWorkflowExecution, type WorkflowErrorCode } from "./index.js";

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
  /** @deprecated Compatibility expectation for the legacy agent isolation shorthand; prefer withWorktree scopes. */
  isolation?: "worktree";
  forbidOptions?: readonly ("role" | "model" | "thinking" | "tools" | "isolation" | "retries")[];
  tools?: { mode: "omitted" | "empty" | "exact"; values?: readonly string[] };
}
export interface AgentStructureExpectation { execution: StaticWorkflowExecution; operation?: "parallel" | "pipeline"; agents: readonly AgentOrderExpectation[] }
export interface AgentOrderExpectation { role?: string; model?: string; promptIncludes?: string; execution?: StaticWorkflowExecution }
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
  requiredAgentStructures?: readonly AgentStructureExpectation[];
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
export const SAFE_PARENT_EVAL_TOOLS = Object.freeze(["read", "grep", "find", "bash", "workflow"] as const);
const EVAL_MODEL_TOKEN = "$EVAL_MODEL";
const semantic = (description: string): readonly SemanticCriterion[] => [{ id: "intent", description }];
const JSON_RESULT_TYPES = ["null", "boolean", "number", "integer", "string", "array", "object"] as const;
const WORKFLOW_CALL_KINDS = ["agent", "parallel", "pipeline", "checkpoint", "phase", "withWorktree"] as const;
const AGENT_OPTION_NAMES = ["role", "model", "thinking", "tools", "isolation", "retries"] as const;
const expectationKeys = ["firstSignificantAction", "firstTool", "firstBatchToolSequence", "parentToolSequence", "workflowCallCount", "requiredOperations", "forbiddenOperations", "requiredRoles", "minimumAgentCalls", "requireOutputSchema", "expectedResults", "agentPolicies", "requiredAgentOrder", "requiredAgentStructures", "requiredDataFlow"] as const;
const caseKeys = ["id", "prompt", "timeoutMs", "maxCost", "expectations", "expectedWorkflowCalls", "semanticCriteria"] as const;
const shapeKeys = ["type", "equals", "nonEmpty", "requiredKeys", "propertyTypes", "forbiddenProperties", "count", "minCount", "properties"] as const;
const outputShapeKeys = ["type", "requiredKeys", "propertyTypes", "forbiddenProperties", "count", "minCount"] as const;

function evalField(path: string, key: string): string { return path ? `${path}.${key}` : key; }
function evalValidationError(source: string, path: string, message: string): never { throw new Error(`YAML ${source} field ${path}: ${message}`); }
function evalObject(value: unknown, source: string, path: string): Record<string, unknown> { if (!isObject(value)) evalValidationError(source, path, "must be an object"); return value; }
function evalKeys(value: Record<string, unknown>, allowed: readonly string[], source: string, path: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) evalValidationError(source, evalField(path, key), "unknown field"); }
function evalRequired(value: Record<string, unknown>, key: string, source: string, path: string): unknown { if (!Object.prototype.hasOwnProperty.call(value, key)) evalValidationError(source, evalField(path, key), "is required"); return value[key]; }
function evalString(value: unknown, source: string, path: string, nonEmpty = false): string { if (typeof value !== "string" || nonEmpty && !value.trim()) evalValidationError(source, path, nonEmpty ? "must be a non-empty string" : "must be a string"); return value; }
function evalNumber(value: unknown, source: string, path: string, integer = false, positive = false): number { if (typeof value !== "number" || !Number.isFinite(value) || integer && !Number.isInteger(value) || positive && value <= 0) evalValidationError(source, path, positive ? "must be a positive number" : integer ? "must be a non-negative integer" : "must be a finite number"); return value; }
function evalNonNegativeInteger(value: unknown, source: string, path: string): number { const result = evalNumber(value, source, path, true); if (result < 0) evalValidationError(source, path, "must be a non-negative integer"); return result; }
function evalStringArray(value: unknown, source: string, path: string): void { if (!Array.isArray(value)) evalValidationError(source, path, "must be an array of strings"); for (const [index, item] of value.entries()) evalString(item, source, `${path}[${String(index)}]`); }
function evalEnum(value: unknown, values: readonly string[], source: string, path: string): string { const result = evalString(value, source, path); if (!values.includes(result)) evalValidationError(source, path, `must be one of ${values.join(", ")}`); return result; }
function evalEnumArray(value: unknown, values: readonly string[], source: string, path: string): void { evalStringArray(value, source, path); for (const [index, item] of (value as string[]).entries()) evalEnum(item, values, source, `${path}[${String(index)}]`); }
function evalJson(value: unknown, seen = new Set<object>()): value is JsonValue { if (value === null || typeof value === "string" || typeof value === "boolean") return true; if (typeof value === "number") return Number.isFinite(value); if (!Array.isArray(value) && !isObject(value)) return false; if (seen.has(value)) return false; seen.add(value); const valid = Array.isArray(value) ? value.every((item) => evalJson(item, seen)) : Object.getPrototypeOf(value) === Object.prototype && Object.values(value).every((item) => evalJson(item, seen)); seen.delete(value); return valid; }
function evalJsonValue(value: unknown, source: string, path: string): void { if (!evalJson(value)) evalValidationError(source, path, "must be a JSON-compatible value"); }
function evalStringMap(value: unknown, source: string, path: string, values: readonly string[]): void { const object = evalObject(value, source, path); for (const [key, item] of Object.entries(object)) evalEnum(item, values, source, evalField(path, key)); }
function evalSequence(value: unknown, source: string, path: string): void { if (Array.isArray(value)) { evalStringArray(value, source, path); return; } const object = evalObject(value, source, path); evalKeys(object, ["equals", "startsWith"], source, path); if (!Object.keys(object).length) evalValidationError(source, path, "must contain equals or startsWith"); for (const key of ["equals", "startsWith"]) if (Object.prototype.hasOwnProperty.call(object, key)) evalStringArray(object[key], source, evalField(path, key)); }
function evalJsonShape(value: unknown, source: string, path: string): void { const object = evalObject(value, source, path); evalKeys(object, shapeKeys, source, path); if (Object.prototype.hasOwnProperty.call(object, "type")) evalEnum(object.type, JSON_RESULT_TYPES, source, evalField(path, "type")); if (Object.prototype.hasOwnProperty.call(object, "equals")) evalJsonValue(object.equals, source, evalField(path, "equals")); if (Object.prototype.hasOwnProperty.call(object, "nonEmpty") && typeof object.nonEmpty !== "boolean") evalValidationError(source, evalField(path, "nonEmpty"), "must be a boolean"); for (const key of ["requiredKeys", "forbiddenProperties"]) if (Object.prototype.hasOwnProperty.call(object, key)) evalStringArray(object[key], source, evalField(path, key)); if (Object.prototype.hasOwnProperty.call(object, "propertyTypes")) evalStringMap(object.propertyTypes, source, evalField(path, "propertyTypes"), JSON_RESULT_TYPES); for (const key of ["count", "minCount"]) if (Object.prototype.hasOwnProperty.call(object, key)) evalNonNegativeInteger(object[key], source, evalField(path, key)); if (Object.prototype.hasOwnProperty.call(object, "properties")) { const properties = evalObject(object.properties, source, evalField(path, "properties")); for (const [key, nested] of Object.entries(properties)) evalJsonShape(nested, source, evalField(evalField(path, "properties"), key)); } if (typeof object.count === "number" && typeof object.minCount === "number" && object.minCount > object.count) evalValidationError(source, path, "minCount cannot exceed count"); }
function evalOutputShape(value: unknown, source: string, path: string): void { const object = evalObject(value, source, path); evalKeys(object, outputShapeKeys, source, path); if (Object.prototype.hasOwnProperty.call(object, "type")) evalEnum(object.type, JSON_RESULT_TYPES, source, evalField(path, "type")); for (const key of ["requiredKeys", "forbiddenProperties"]) if (Object.prototype.hasOwnProperty.call(object, key)) evalStringArray(object[key], source, evalField(path, key)); if (Object.prototype.hasOwnProperty.call(object, "propertyTypes")) evalStringMap(object.propertyTypes, source, evalField(path, "propertyTypes"), JSON_RESULT_TYPES); for (const key of ["count", "minCount"]) if (Object.prototype.hasOwnProperty.call(object, key)) evalNonNegativeInteger(object[key], source, evalField(path, key)); if (typeof object.count === "number" && typeof object.minCount === "number" && object.minCount > object.count) evalValidationError(source, path, "minCount cannot exceed count"); }
function evalAgentSelector(value: unknown, source: string, path: string): void { const object = evalObject(value, source, path); evalKeys(object, ["role", "model", "promptIncludes", "execution"], source, path); for (const key of ["role", "model", "promptIncludes"]) if (Object.prototype.hasOwnProperty.call(object, key)) evalString(object[key], source, evalField(path, key)); if (Object.prototype.hasOwnProperty.call(object, "execution")) evalEnum(object.execution, ["parallel", "sequential"], source, evalField(path, "execution")); }
function evalAgentPolicy(value: unknown, source: string, path: string): void { const object = evalObject(value, source, path); evalKeys(object, ["callIndex", "role", "model", "isolation", "forbidOptions", "tools"], source, path); evalNonNegativeInteger(evalRequired(object, "callIndex", source, path), source, evalField(path, "callIndex")); for (const key of ["role", "model"]) if (Object.prototype.hasOwnProperty.call(object, key)) evalString(object[key], source, evalField(path, key)); if (Object.prototype.hasOwnProperty.call(object, "isolation")) evalEnum(object.isolation, ["worktree"], source, evalField(path, "isolation")); if (Object.prototype.hasOwnProperty.call(object, "forbidOptions")) evalEnumArray(object.forbidOptions, AGENT_OPTION_NAMES, source, evalField(path, "forbidOptions")); if (Object.prototype.hasOwnProperty.call(object, "tools")) { const tools = evalObject(object.tools, source, evalField(path, "tools")); evalKeys(tools, ["mode", "values"], source, evalField(path, "tools")); evalEnum(tools.mode, ["omitted", "empty", "exact"], source, evalField(evalField(path, "tools"), "mode")); if (Object.prototype.hasOwnProperty.call(tools, "values")) evalStringArray(tools.values, source, evalField(evalField(path, "tools"), "values")); } }
function evalExpectations(value: unknown, source: string, path: string): EvalExpectations { const object = evalObject(value, source, path); evalKeys(object, expectationKeys, source, path); if (Object.prototype.hasOwnProperty.call(object, "firstSignificantAction")) { const action = evalObject(object.firstSignificantAction, source, evalField(path, "firstSignificantAction")); evalKeys(action, ["kind", "name"], source, evalField(path, "firstSignificantAction")); const kind = evalEnum(action.kind, ["tool", "text", "thinking"], source, evalField(evalField(path, "firstSignificantAction"), "kind")); if (kind === "tool") evalString(evalRequired(action, "name", source, evalField(path, "firstSignificantAction")), source, evalField(evalField(path, "firstSignificantAction"), "name"), true); else if (Object.prototype.hasOwnProperty.call(action, "name")) evalValidationError(source, evalField(evalField(path, "firstSignificantAction"), "name"), "is only valid for kind tool"); } if (Object.prototype.hasOwnProperty.call(object, "firstTool")) evalString(object.firstTool, source, evalField(path, "firstTool"), true); for (const key of ["firstBatchToolSequence", "parentToolSequence"]) if (Object.prototype.hasOwnProperty.call(object, key)) evalSequence(object[key], source, evalField(path, key)); if (Object.prototype.hasOwnProperty.call(object, "workflowCallCount")) { const count = object.workflowCallCount; if (typeof count === "number") evalNonNegativeInteger(count, source, evalField(path, "workflowCallCount")); else { const range = evalObject(count, source, evalField(path, "workflowCallCount")); evalKeys(range, ["min", "max"], source, evalField(path, "workflowCallCount")); if (!Object.keys(range).length) evalValidationError(source, evalField(path, "workflowCallCount"), "must contain min or max"); for (const key of ["min", "max"]) if (Object.prototype.hasOwnProperty.call(range, key)) evalNonNegativeInteger(range[key], source, evalField(evalField(path, "workflowCallCount"), key)); if (typeof range.min === "number" && typeof range.max === "number" && range.min > range.max) evalValidationError(source, evalField(path, "workflowCallCount"), "min cannot exceed max"); } } for (const key of ["requiredOperations", "forbiddenOperations"]) if (Object.prototype.hasOwnProperty.call(object, key)) evalEnumArray(object[key], WORKFLOW_CALL_KINDS, source, evalField(path, key)); for (const key of ["requiredRoles"]) if (Object.prototype.hasOwnProperty.call(object, key)) evalStringArray(object[key], source, evalField(path, key)); if (Object.prototype.hasOwnProperty.call(object, "minimumAgentCalls")) evalNonNegativeInteger(object.minimumAgentCalls, source, evalField(path, "minimumAgentCalls")); if (Object.prototype.hasOwnProperty.call(object, "requireOutputSchema")) { if (typeof object.requireOutputSchema !== "boolean") evalOutputShape(object.requireOutputSchema, source, evalField(path, "requireOutputSchema")); } if (Object.prototype.hasOwnProperty.call(object, "expectedResults")) { if (!Array.isArray(object.expectedResults)) evalValidationError(source, evalField(path, "expectedResults"), "must be an array"); for (const [index, item] of object.expectedResults.entries()) { const expected = evalObject(item, source, `${path}.expectedResults[${String(index)}]`); evalKeys(expected, ["workflowIndex", "equals", "match"], source, `${path}.expectedResults[${String(index)}]`); if (Object.prototype.hasOwnProperty.call(expected, "workflowIndex")) evalNonNegativeInteger(expected.workflowIndex, source, `${path}.expectedResults[${String(index)}].workflowIndex`); if (Object.prototype.hasOwnProperty.call(expected, "equals")) evalJsonValue(expected.equals, source, `${path}.expectedResults[${String(index)}].equals`); if (Object.prototype.hasOwnProperty.call(expected, "match")) evalJsonShape(expected.match, source, `${path}.expectedResults[${String(index)}].match`); if (!Object.prototype.hasOwnProperty.call(expected, "equals") && !Object.prototype.hasOwnProperty.call(expected, "match")) evalValidationError(source, `${path}.expectedResults[${String(index)}]`, "must contain equals or match"); } } if (Object.prototype.hasOwnProperty.call(object, "agentPolicies")) { if (!Array.isArray(object.agentPolicies)) evalValidationError(source, evalField(path, "agentPolicies"), "must be an array"); for (const [index, item] of object.agentPolicies.entries()) evalAgentPolicy(item, source, `${path}.agentPolicies[${String(index)}]`); } for (const key of ["requiredAgentOrder"]) if (Object.prototype.hasOwnProperty.call(object, key)) { if (!Array.isArray(object[key])) evalValidationError(source, evalField(path, key), "must be an array"); for (const [index, item] of object[key].entries()) evalAgentSelector(item, source, `${path}.${key}[${String(index)}]`); } if (Object.prototype.hasOwnProperty.call(object, "requiredAgentStructures")) { if (!Array.isArray(object.requiredAgentStructures)) evalValidationError(source, evalField(path, "requiredAgentStructures"), "must be an array"); for (const [index, item] of object.requiredAgentStructures.entries()) { const structure = evalObject(item, source, `${path}.requiredAgentStructures[${String(index)}]`); evalKeys(structure, ["execution", "operation", "agents"], source, `${path}.requiredAgentStructures[${String(index)}]`); evalEnum(evalRequired(structure, "execution", source, `${path}.requiredAgentStructures[${String(index)}]`), ["parallel", "sequential"], source, `${path}.requiredAgentStructures[${String(index)}].execution`); if (Object.prototype.hasOwnProperty.call(structure, "operation")) evalEnum(structure.operation, ["parallel", "pipeline"], source, `${path}.requiredAgentStructures[${String(index)}].operation`); const agents = evalRequired(structure, "agents", source, `${path}.requiredAgentStructures[${String(index)}]`); if (!Array.isArray(agents)) evalValidationError(source, `${path}.requiredAgentStructures[${String(index)}].agents`, "must be a non-empty array"); if (!agents.length) evalValidationError(source, `${path}.requiredAgentStructures[${String(index)}].agents`, "must be a non-empty array"); for (const [agentIndex, agent] of agents.entries()) evalAgentSelector(agent, source, `${path}.requiredAgentStructures[${String(index)}].agents[${String(agentIndex)}]`); } } if (Object.prototype.hasOwnProperty.call(object, "requiredDataFlow")) { if (!Array.isArray(object.requiredDataFlow)) evalValidationError(source, evalField(path, "requiredDataFlow"), "must be an array"); for (const [index, item] of object.requiredDataFlow.entries()) { const flow = evalObject(item, source, `${path}.requiredDataFlow[${String(index)}]`); evalKeys(flow, ["binding", "toAgentIndex"], source, `${path}.requiredDataFlow[${String(index)}]`); evalString(evalRequired(flow, "binding", source, `${path}.requiredDataFlow[${String(index)}]`), source, `${path}.requiredDataFlow[${String(index)}].binding`, true); evalNonNegativeInteger(evalRequired(flow, "toAgentIndex", source, `${path}.requiredDataFlow[${String(index)}]`), source, `${path}.requiredDataFlow[${String(index)}].toAgentIndex`); } } return object; }
function evalCase(value: unknown, source: string): WorkflowEvalCase { const object = evalObject(value, source, "<case>"); evalKeys(object, caseKeys, source, ""); evalString(evalRequired(object, "id", source, ""), source, "id", true); evalString(evalRequired(object, "prompt", source, ""), source, "prompt", true); if (Object.prototype.hasOwnProperty.call(object, "timeoutMs")) evalNumber(object.timeoutMs, source, "timeoutMs", true, true); evalNumber(evalRequired(object, "maxCost", source, ""), source, "maxCost", false, true); evalExpectations(evalRequired(object, "expectations", source, ""), source, "expectations"); if (Object.prototype.hasOwnProperty.call(object, "expectedWorkflowCalls")) evalNonNegativeInteger(object.expectedWorkflowCalls, source, "expectedWorkflowCalls"); if (Object.prototype.hasOwnProperty.call(object, "semanticCriteria")) { if (!Array.isArray(object.semanticCriteria)) evalValidationError(source, "semanticCriteria", "must be an array"); const ids = new Set<string>(); for (const [index, item] of object.semanticCriteria.entries()) { const criterion = evalObject(item, source, `semanticCriteria[${String(index)}]`); evalKeys(criterion, ["id", "description"], source, `semanticCriteria[${String(index)}]`); const id = evalString(evalRequired(criterion, "id", source, `semanticCriteria[${String(index)}]`), source, `semanticCriteria[${String(index)}].id`, true); evalString(evalRequired(criterion, "description", source, `semanticCriteria[${String(index)}]`), source, `semanticCriteria[${String(index)}].description`, true); if (ids.has(id)) evalValidationError(source, `semanticCriteria[${String(index)}].id`, `duplicate criterion id ${JSON.stringify(id)}`); ids.add(id); } } return object as unknown as WorkflowEvalCase; }
function evalYaml(content: string, source: string): unknown { try { const parsed = parseFrontmatter(`---\n${content.replace(/\r\n?/g, "\n")}\n---\n`); if (parsed.body.trim()) evalValidationError(source, "<document>", "must contain one YAML document"); return parsed.frontmatter; } catch (error) { if (error instanceof Error && error.message.startsWith("YAML ")) throw error; evalValidationError(source, "<document>", `malformed YAML: ${error instanceof Error ? error.message : String(error)}`); } }
function evalCasesDirectory(): string { const moduleDirectory = dirname(fileURLToPath(import.meta.url)); const candidates = [join(moduleDirectory, "../evals/cases"), join(moduleDirectory, "../../evals/cases")]; const found = candidates.find((candidate) => existsSync(candidate)); if (!found) evalValidationError(candidates[0] as string, "<document>", "cases directory not found"); return found; }
export function validateWorkflowEvalCase(value: unknown, source = "case"): WorkflowEvalCase { return evalCase(value, source); }
export function validateWorkflowEvalCases(values: readonly unknown[], source = "cases"): readonly WorkflowEvalCase[] { if (!Array.isArray(values)) evalValidationError(source, "<document>", "must be an array"); const cases = values.map((value, index) => evalCase(value, `${source}[${String(index)}]`)); const seen = new Map<string, string>(); for (const [index, candidate] of cases.entries()) { const path = `${source}[${String(index)}]`; const first = seen.get(candidate.id); if (first) evalValidationError(source, `${path}.id`, `duplicate id ${JSON.stringify(candidate.id)} (first declared at ${first})`); seen.set(candidate.id, `${path}.id`); } return cases; }
export function loadWorkflowEvalCases(directory = evalCasesDirectory()): readonly WorkflowEvalCase[] { let entries: Array<{ name: string; isFile(): boolean }>; try { entries = readdirSync(directory, { withFileTypes: true, encoding: "utf8" }); } catch (error) { evalValidationError(directory, "<document>", `cannot read cases directory: ${error instanceof Error ? error.message : String(error)}`); } const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".yaml")).map((entry) => entry.name).sort((left, right) => left < right ? -1 : left > right ? 1 : 0); if (!files.length) evalValidationError(directory, "<document>", "no .yaml case files found"); const cases: WorkflowEvalCase[] = []; const seen = new Map<string, string>(); for (const file of files) { const source = join(directory, file); const candidate = evalCase(evalYaml(readFileSync(source, "utf8"), source), source); const first = seen.get(candidate.id); if (first) evalValidationError(source, "id", `duplicate id ${JSON.stringify(candidate.id)} (first declared at ${first} field id)`); seen.set(candidate.id, source); cases.push(candidate); } return Object.freeze(cases); }
export const INITIAL_WORKFLOW_EVAL_CASES: readonly WorkflowEvalCase[] = loadWorkflowEvalCases();


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
    if (policy.isolation !== undefined && call.options.isolation !== policy.isolation) errors.push(`agent ${String(policy.callIndex)} isolation was ${JSON.stringify(call.options.isolation)}`);
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
function matchesAgentExpectation(call: StaticWorkflowCall | undefined, expected: AgentOrderExpectation): boolean {
  if (!call) return false;
  return (expected.role === undefined || call.role === expected.role) && (expected.model === undefined || call.model === expected.model) && (expected.promptIncludes === undefined || call.prompt?.includes(expected.promptIncludes) === true) && (expected.execution === undefined || (call.execution ?? "sequential") === expected.execution);
}
function structureGroupKey(call: StaticWorkflowCall, kind: "parallel" | "pipeline"): string | undefined {
  const scopes = (call.structure ?? []).filter((scope) => scope.kind === kind);
  return scopes.length ? JSON.stringify(scopes.map(({ kind: scopeKind, name }) => [scopeKind, name])) : undefined;
}
function distinctAgentMatches(rows: readonly StaticWorkflowCall[], expected: readonly AgentOrderExpectation[]): boolean {
  const used = new Set<number>();
  return expected.every((selector) => {
    const index = rows.findIndex((call, candidateIndex) => !used.has(candidateIndex) && matchesAgentExpectation(call, selector));
    if (index < 0) return false;
    used.add(index);
    return true;
  });
}
function agentStructureMatches(rows: readonly { call: StaticWorkflowCall; source: string }[], expected: AgentStructureExpectation): boolean {
  const agents = rows.filter(({ call }) => call.kind === "agent").map(({ call }) => call);
  if (expected.execution === "parallel") {
    const groups = new Map<string, StaticWorkflowCall[]>();
    for (const call of agents) {
      if ((call.execution ?? "sequential") !== "parallel" || expected.operation && !(call.structure ?? []).some((scope) => scope.kind === expected.operation)) continue;
      const key = structureGroupKey(call, "parallel");
      if (key) groups.set(key, [...(groups.get(key) ?? []), call]);
    }
    return [...groups.values()].some((group) => distinctAgentMatches(group, expected.agents));
  }
  const candidates = agents.filter((call) => (call.execution ?? "sequential") === "sequential" && (!expected.operation || (call.structure ?? []).some((scope) => scope.kind === expected.operation)));
  let start = 0;
  return expected.agents.every((selector) => {
    const index = candidates.findIndex((call, candidateIndex) => candidateIndex >= start && matchesAgentExpectation(call, selector));
    if (index < 0) return false;
    start = index + 1;
    return true;
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
    if (call && policy.isolation !== undefined && options.isolation !== policy.isolation) failures.push(`isolation ${JSON.stringify(options.isolation)}`);
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
    const pass = order.every((expected, index) => matchesAgentExpectation(agentCalls[index], expected));
    add("agent-order", pass, `Checked ${String(order.length)} ordered agent selectors.`);
  }
  for (const [index, structure] of (expectations.requiredAgentStructures ?? []).entries()) {
    const pass = agentStructureMatches(rows, structure);
    add(`agent-structure:${String(index)}`, pass, `Required ${structure.execution} agent structure${structure.operation ? ` in ${structure.operation}` : ""}.`);
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
interface PiRunResult { exitCode: number | null; timedOut: boolean; budgetExceeded: boolean; processGroupTerminated: boolean; stoppedIntentionally: boolean; stderr: string; error?: string }
const reportProgress = (message: string): void => { if (process.env.PI_WORKFLOW_EVAL_PROGRESS === "1") process.stderr.write(`[eval] ${message}\n`); };


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
  let timedOut = false; let budgetExceeded = false; let processGroupTerminated = false; let stoppedIntentionally = false; let workflowCallSeen = false; let streamCost = 0; let lineBuffer = ""; let stderr = ""; let spawnError: string | undefined; let killPromise: Promise<boolean> | undefined;
  const child = spawn(input.piCommand ?? process.env.PI_WORKFLOW_EVAL_PI ?? "pi", args, { cwd, env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: join(home, ".pi", "agent"), PI_CODING_AGENT_SESSION_DIR: sessionDir, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"], signal: controller.signal });
  const requestKill = (): Promise<boolean> => { killPromise ??= killProcessGroup(child); return killPromise; };
  const stopIntentionally = (): void => { if (stoppedIntentionally) return; stoppedIntentionally = true; void requestKill().then((terminated) => { processGroupTerminated ||= terminated; }); };
  const isValidatedCapture = (value: unknown): boolean => {
    if (!isObject(value) || value.toolName !== "workflow" || value.isError === true) return false;
    const details = isObject(value.details) ? value.details : undefined;
    const validation = details && isObject(details.validation) ? details.validation : undefined;
    return details?.captureIdentity === CAPTURE_IDENTITY && details.realWorkflowAgentsLaunched === 0 && validation?.valid === true;
  };
  const inspectLine = (line: string) => {
    try {
      const event = JSON.parse(line) as unknown;
      if (!isObject(event)) return;
      if (event.type === "message_end" && isObject(event.message)) {
        const tools = Array.isArray(event.message.content) ? event.message.content.flatMap((part) => isObject(part) && part.type === "toolCall" && typeof part.name === "string" ? [part.name] : []) : [];
        if (tools.includes("workflow")) workflowCallSeen = true;
        if (tools.length) reportProgress(`${input.case.id}: parent tools: ${tools.join(", ")}`);
        const usage = usageFrom(event.message);
        if (!usage) return;
        streamCost += usage.cost;
        reportProgress(`${input.case.id}: parent turn complete, ${String(usage.totalTokens)} tokens, $${streamCost.toFixed(4)} total`);
        if (streamCost > input.maxCost && !budgetExceeded) { budgetExceeded = true; controller.abort(); void requestKill().then((terminated) => { processGroupTerminated ||= terminated; }); }
        return;
      }
      if (event.type === "turn_end") {
        const toolResults = Array.isArray(event.toolResults) ? event.toolResults : [];
        if (toolResults.some((result) => isObject(result) && result.toolName === "workflow")) workflowCallSeen = true;
        if (toolResults.some(isValidatedCapture)) stopIntentionally();
        return;
      }
      if (event.type === "agent_end" && !workflowCallSeen) {
        const messages: unknown[] = Array.isArray(event.messages) ? event.messages as unknown[] : [];
        let assistant: unknown;
        for (let index = messages.length - 1; index >= 0; index -= 1) {
          const message = messages[index];
          if (isObject(message) && message.role === "assistant") { assistant = message; break; }
        }
        if (isObject(assistant) && (assistant.stopReason === "error" || assistant.stopReason === "aborted")) return;
        stopIntentionally();
      }
    } catch { /* The JSON stream may contain a diagnostic line. */ }
  };
  child.stdout.on("data", (chunk: Buffer) => { lineBuffer += chunk.toString(); const lines = lineBuffer.split("\n"); lineBuffer = lines.pop() ?? ""; for (const line of lines) if (line) inspectLine(line); });
  child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-64_000); });
  child.once("error", (error: Error) => { spawnError = error.message; });
  const close = new Promise<number | null>((resolve) => { child.once("close", (code) => { resolve(code); }); });
  const timer = input.case.timeoutMs === undefined ? undefined : setTimeout(() => { timedOut = true; controller.abort(); void requestKill().then((terminated) => { processGroupTerminated ||= terminated; }); }, input.case.timeoutMs);
  const exitCode = await close; if (timer) clearTimeout(timer);
  if (lineBuffer) inspectLine(lineBuffer);
  if (killPromise) processGroupTerminated ||= await killPromise;
  return { exitCode, timedOut, budgetExceeded, processGroupTerminated, stoppedIntentionally, stderr, ...(spawnError ? { error: spawnError } : {}) };
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
  const roles = loadAgentDefinitions(cwd, join(home, ".pi", "agent"));
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
  return { raw, usage, exitCode, timedOut, budgetExceeded, processGroupTerminated, stoppedIntentionally: false, stderr, ...(spawnError ? { error: spawnError } : {}) };
}

function seedEvalProject(cwd: string, home: string, model: string): void {
  const source = process.env.PI_WORKFLOW_EVAL_SOURCE_PROJECT_DIR;
  if (!source) return;
  const excluded = new Set([".git", "node_modules", "dist", ".tmp"]);
  for (const entry of readdirSync(source)) {
    if (excluded.has(entry)) continue;
    cpSync(join(source, entry), join(cwd, entry), { recursive: true, filter: (path) => !excluded.has(basename(path)) });
  }
  const roles = join(source, "test", "fixtures", "workflow-eval-roles");
  const target = join(home, ".pi", "agent", "pi-extensible-workflows", "roles");
  if (!existsSync(roles)) return;
  mkdirSync(target, { recursive: true, mode: 0o700 });
  cpSync(roles, target, { recursive: true });
  for (const name of readdirSync(target).filter((entry) => entry.endsWith(".md"))) {
    const path = join(target, name);
    const content = readFileSync(path, "utf8");
    const frontmatterEnd = content.startsWith("---\n") ? content.indexOf("\n---", 4) : -1;
    if (frontmatterEnd >= 0) writeFileSync(path, `${content.slice(0, frontmatterEnd).replace(/^model:.*$/m, `model: ${model}`)}${content.slice(frontmatterEnd)}`);
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
    reportProgress(`${input.case.id}: parent model starting`);
    const pi = await runPiCapture(input, cwd, home, sessionDir, sessionId);
    reportProgress(`${input.case.id}: parent model finished`);
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
    const parentUsageThroughCandidate = usageThroughCandidate(oracle, workflows, selection.callIndices);
    const parentAccounting = parentUsageThroughCandidate ?? oracle.usage;
    const unsafeTool = oracle.parentToolSequence.find((tool) => !SAFE_PARENT_EVAL_TOOLS.includes(tool as (typeof SAFE_PARENT_EVAL_TOOLS)[number]));
    const errors = [...evalExpectationErrors(oracle, input.case.expectations), ...validation.errors, ...(unsafeTool ? [`parent tool is outside the safe eval allowlist: ${unsafeTool}`] : [])];
    if (requiredCount > 0 && selection.callIndices.length === 0) errors.push("Catastrophic validity failure: no production-valid workflow candidate satisfied static expectations.");
    let judge: SemanticJudgeReport | undefined;
    let judgeProcess: JudgeProcessResult | undefined;
    if (selection.callIndices.length > 0) {
      const criteria = input.case.semanticCriteria ?? semantic("The workflow design is semantically appropriate for the original request.");
      const judgeCase = { ...input.case, semanticCriteria: criteria };
      reportProgress(`${input.case.id}: semantic judge starting`);
      judgeProcess = await runSemanticJudge({ ...input, case: judgeCase }, selection.callIndices.map((index) => workflows[index] as CapturedWorkflowCall), cwd, home, sessionDir, Math.max(0, input.maxCost - parentAccounting.cost));
      reportProgress(`${input.case.id}: semantic judge finished`);
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
    const before = preliminaryTools(oracle, selection.callIndices[0]);
    const accounting = addUsage(parentAccounting, judgeProcess?.usage ?? emptyAccounting());
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
    const intentionalStop = pi.stoppedIntentionally && (pi.exitCode === 0 || pi.exitCode === null || pi.exitCode === 143);
    const piSucceeded = pi.exitCode === 0 || intentionalStop;
    const status: EvalCaseResult["status"] = timedOut ? "timed_out" : overBudget ? "budget_exceeded" : errors.length || !piSucceeded ? "failed" : "passed";
    const result: EvalCaseResult = { id: input.case.id, status, limits: { ...(input.case.timeoutMs === undefined ? {} : { timeoutMs: input.case.timeoutMs }), maxCost: input.maxCost }, oracle, workflows, productionValidation: validation.reports, ...(judge ? { semanticJudge: judge } : {}), metrics, accounting, accountingTrustworthy: !timedOut && piSucceeded && (!judgeProcess || judgeProcess.exitCode === 0), diagnostics: diagnostics.filter(Boolean), errors, cleanup: { processExited: (pi.exitCode !== null || pi.stoppedIntentionally) && (!judgeProcess || judgeProcess.exitCode !== null), processGroupTerminated: pi.processGroupTerminated || Boolean(judgeProcess?.processGroupTerminated), tempRootRemoved: false, captureIdentityVerified: validation.verified, realWorkflowAgentsLaunched: validation.verified ? 0 : null } };
    return withTempRootRemoved(result);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

export interface IsolatedProcessOptions { childPath: string; timeoutMs?: number; env?: NodeJS.ProcessEnv; onStderr?: (chunk: string) => void }
export interface IsolatedProcessResult<T> { value?: T; timedOut: boolean; exitCode: number | null; processGroupTerminated: boolean; stderr: string; error?: string }
export async function runIsolatedProcess<T>(payload: unknown, options: IsolatedProcessOptions): Promise<IsolatedProcessResult<T>> {
  const root = mkdtempSync(join(tmpdir(), "pi-workflow-eval-case-")); const inputPath = join(root, "input.json"); const outputPath = join(root, "output.json");
  try {
    writeFileSync(inputPath, `${JSON.stringify({ payload, outputPath })}\n`, { mode: 0o600 });
    const controller = new AbortController();
    const child = spawn(process.execPath, [options.childPath, inputPath], { cwd: root, env: { ...process.env, ...options.env, HOME: join(root, "home"), PI_CODING_AGENT_DIR: join(root, "home", ".pi", "agent"), PI_CODING_AGENT_SESSION_DIR: join(root, "sessions"), PI_WORKFLOW_EVAL_CASE_ROOT: root }, detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"], signal: controller.signal });
    let timedOut = false; let processGroupTerminated = false; let stderr = ""; let processError: string | undefined; let killPromise: Promise<boolean> | undefined;
    child.stderr.on("data", (chunk: Buffer) => { const text = chunk.toString(); stderr = `${stderr}${text}`.slice(-64_000); options.onStderr?.(text); });
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

export interface WorkflowEvalRunOptions { cases?: readonly WorkflowEvalCase[]; caseIds?: readonly string[]; model?: string; provider?: string; thinking?: string; piCommand?: string; timeoutMs?: number; spendCeiling?: number; artifactsDir?: string; onProgress?: (message: string) => void }

function materializeCase(candidate: WorkflowEvalCase, model: string): WorkflowEvalCase {
  return JSON.parse(JSON.stringify(candidate).replaceAll(EVAL_MODEL_TOKEN, model)) as WorkflowEvalCase;
}
export interface WorkflowEvalRunResult { artifactDir: string; cases: readonly EvalCaseResult[]; spent: number; skipped: readonly string[] }

export async function runWorkflowEvals(options: WorkflowEvalRunOptions = {}): Promise<WorkflowEvalRunResult> {
  const model = options.model ?? process.env.PI_WORKFLOW_EVAL_MODEL;
  if (!model) throw new Error("Set --model or PI_WORKFLOW_EVAL_MODEL before running model evals.");
  const explicitModel = model.includes("/") ? model : options.provider ? `${options.provider}/${model}` : model;
  const candidates = options.cases ?? INITIAL_WORKFLOW_EVAL_CASES;
  validateWorkflowEvalCases(candidates, options.cases ? "options.cases" : "evals/cases");
  const cases = candidates.filter((candidate) => !options.caseIds?.length || options.caseIds.includes(candidate.id)).map((candidate) => materializeCase(candidate, explicitModel));
  const sourceAgentDir = getAgentDir();
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
    const started = Date.now();
    options.onProgress?.(`[eval] ${candidate.id}: starting, budget $${input.maxCost.toFixed(2)}, timeout ${input.case.timeoutMs === undefined ? "off" : `${String(input.case.timeoutMs)}ms`}`);
    const isolated = await runIsolatedProcess<EvalCaseResult>(input, { childPath: fileURLToPath(new URL("./workflow-evals-child.js", import.meta.url)), ...(input.case.timeoutMs === undefined ? {} : { timeoutMs: input.case.timeoutMs * 2 + CASE_PROCESS_GRACE_MS }), env: { PI_WORKFLOW_EVAL_SOURCE_AGENT_DIR: sourceAgentDir, PI_WORKFLOW_EVAL_SOURCE_PROJECT_DIR: process.cwd(), PI_WORKFLOW_EVAL_PROGRESS: options.onProgress ? "1" : "0" }, ...(options.onProgress ? { onStderr: (chunk: string) => { for (const line of chunk.trimEnd().split("\n")) if (line) options.onProgress?.(line); } } : {}) });
    const childStderr = isolated.stderr.split("\n").filter((line) => !line.startsWith("[eval] ")).join("\n").trim();
    const diagnostics = [childStderr, isolated.error ? `Case process error: ${isolated.error}` : ""].filter(Boolean);
    const trustworthy = Boolean(isolated.value) && !isolated.timedOut && isolated.exitCode === 0 && !isolated.error && Boolean(isolated.value?.accountingTrustworthy);
    const untrustedStatus: EvalCaseResult["status"] = isolated.timedOut ? "timed_out" : isolated.value?.status === "timed_out" || isolated.value?.status === "budget_exceeded" ? isolated.value.status : "failed";
    const base = isolated.value ?? resultFromFailure(input, untrustedStatus, [isolated.timedOut ? "Case process timed out." : isolated.error ? isolated.error : "Case process returned no artifact.", ...diagnostics], isolated.exitCode !== null, isolated.processGroupTerminated, diagnostics, input.maxCost);
    const result: EvalCaseResult = { ...base, ...(trustworthy ? {} : { status: untrustedStatus, accounting: { ...base.accounting, cost: input.maxCost }, accountingTrustworthy: false }), diagnostics: [...base.diagnostics, ...diagnostics] };
    spent += result.accounting.cost;
    options.onProgress?.(`[eval] ${candidate.id}: ${result.status} after ${((Date.now() - started) / 1000).toFixed(1)}s, $${result.accounting.cost.toFixed(4)}, ${String(result.accounting.totalTokens)} tokens`);
    results.push(result); writeFileSync(join(artifactDir, `${candidate.id}.json`), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
  }
  return { artifactDir, cases: results, spent, skipped };
}

export function formatEvalSummary(result: WorkflowEvalRunResult): string {
  const rows = result.cases.flatMap((item) => {
    const invalid = item.productionValidation.filter(({ valid }) => !valid);
    const staticCriteria = item.metrics.staticCandidates.flatMap(({ criteria }) => criteria).filter(({ pass }) => !pass);
    const semantic = item.metrics.semanticCriteria.map(({ id, pass, evidence }) => `  judge ${pass ? "PASS" : "FAIL"} ${id}: ${evidence}`);
    return [
      `${item.id}: ${item.status}`,
      `  usage: $${item.accounting.cost.toFixed(4)}, ${String(item.accounting.totalTokens)} tokens (${String(item.accounting.input)} input, ${String(item.accounting.output)} output, ${String(item.accounting.cacheRead)} cache read)`,
      `  workflows: ${String(item.workflows.length)} captured, ${String(item.productionValidation.filter(({ valid }) => valid).length)} production-valid`,
      ...invalid.map(({ callIndex, errorCode, message }) => `  validation FAIL call ${String(callIndex)}${errorCode ? ` ${errorCode}` : ""}: ${message ?? "unknown error"}`),
      ...staticCriteria.map(({ id, evidence }) => `  static FAIL ${id}: ${evidence}`),
      ...semantic,
      ...item.errors.map((error) => `  error: ${error}`),
    ];
  });
  return [`Workflow evals: ${String(result.cases.length)} cases, $${result.spent.toFixed(4)} spent`, ...rows, result.skipped.length ? `Skipped: ${result.skipped.join(", ")}` : "", `Artifacts: ${result.artifactDir}`].filter(Boolean).join("\n");
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
  const result = await runWorkflowEvals({ ...(model ? { model } : {}), ...(provider ? { provider } : {}), ...(thinking ? { thinking } : {}), ...(piCommand ? { piCommand } : {}), ...(artifactsDir ? { artifactsDir } : {}), spendCeiling: Number(value("--spend-ceiling") ?? process.env.PI_WORKFLOW_EVAL_SPEND_CEILING ?? "1"), ...(timeoutValue ? { timeoutMs: timeoutValue } : {}), ...(caseIds?.length ? { caseIds } : {}), onProgress: (message) => { process.stderr.write(`${message}\n`); } });
  process.stdout.write(`${formatEvalSummary(result)}\n`);
  if (result.cases.some((item) => item.status !== "passed")) process.exitCode = 1;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });