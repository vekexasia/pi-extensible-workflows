import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import * as acorn from "acorn";
import { Script } from "node:vm";
import type { CheckpointInput, JsonSchema, JsonValue, PreflightCapabilities, PreflightResult, ShellOptions, StaticWorkflowCall, StaticWorkflowExecution, StaticWorkflowScope, ValidatedWorkflowLaunch, WorkflowCallKind, WorkflowErrorCode, WorkflowMetadata, WorkflowValidationContext, WorkflowValidationParameters } from "./types.js";
import type { WorkflowRegistryApi } from "./registry.js";
import { assertModelThinking, validateSchema, deepFreeze, errorText, fail, jsonObject, jsonValue, object, positiveInteger, resourcePatternHasMagic } from "./utils.js";
import { WORKFLOW_CALL_KINDS } from "./types.js";
export { validateSchema } from "./utils.js";

import { validateContextFileScopes, validateSelectorList } from "./settings.js";
export { DEFAULT_SETTINGS, loadCodemodeToolsSetting, loadSettings, loadSettingsOverrides, resolveAgentResourcePolicy, resolveWorkflowSettings, saveModelAliases, validateContextFileScopes, validateModelAliasAvailability, validateSelectorList, validateWorkflowExtensionSettings, workflowProjectSettingsPath, workflowSettingsPath, workflowToolExposure } from "./settings.js";

export function validateCheckpoint(value: unknown): CheckpointInput {
  if (!object(value) || Object.keys(value).some((key) => !["name", "prompt", "context"].includes(key)) || typeof value.name !== "string" || value.name.trim() === "" || typeof value.prompt !== "string" || !jsonValue(value.context)) fail("INVALID_METADATA", "checkpoint requires only name, prompt, and JSON context");
  if (Buffer.byteLength(value.prompt) > 1024) fail("INVALID_METADATA", "checkpoint prompt exceeds 1024 UTF-8 bytes");
  if (Buffer.byteLength(JSON.stringify(value.context)) > 4096) fail("INVALID_METADATA", "checkpoint context exceeds 4096 UTF-8 bytes");
  return { name: value.name, prompt: value.prompt, context: value.context };
}

function validateWorkflowMetadata(value: unknown): WorkflowMetadata {
  if (!object(value) || typeof value.name !== "string" || value.name.trim() === "") fail("INVALID_METADATA", "Workflow metadata requires a non-empty name");
  if (value.description !== undefined && (typeof value.description !== "string" || value.description.trim() === "")) fail("INVALID_METADATA", "Workflow description must be a non-empty string when provided");
  if (Object.keys(value).some((key) => !["name", "description"].includes(key))) fail("INVALID_METADATA", "Unknown workflow metadata");
  return Object.freeze({ name: value.name.trim(), ...(typeof value.description === "string" ? { description: value.description.trim() } : {}) });
}

function workflowBody(script: string): string {
  if (typeof script !== "string" || script.trim() === "") fail("INVALID_SYNTAX", "Workflow script must be non-empty");
  try {
    const program = acorn.parse(script, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true });
    const first = program.body[0];
    if (first?.type === "ExportNamedDeclaration" && first.declaration?.type === "VariableDeclaration") {
      const declarator = first.declaration.declarations[0];
      if (declarator?.id.type === "Identifier" && declarator.id.name === "meta") return script.slice(first.end).replace(/^\s*/, "");
    }
    return script;
  } catch (error) { fail("INVALID_SYNTAX", `Invalid workflow syntax: ${errorText(error)}`); }
}

function parseWorkflow(script: string): acorn.Program {
  const body = workflowBody(script);
  try {
    new Script(`(async()=>{${body}\n})`);
    return acorn.parse(body, { ecmaVersion: "latest", sourceType: "module", allowReturnOutsideFunction: true });
  } catch (error) { fail("INVALID_SYNTAX", `Invalid workflow syntax: ${errorText(error)}`); }
}

type WorkflowCall = acorn.CallExpression & { callee: acorn.Identifier & { name: WorkflowCallKind } };

function isAcornNode(value: unknown): value is acorn.AnyNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}
/** The static name of an object property or record key; computed keys and non-literal expressions have none. */
function propertyKeyName(property: acorn.Property | acorn.AssignmentProperty): string | undefined {
  return property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
}
function astChildren(node: acorn.AnyNode): acorn.AnyNode[] {
  const children: acorn.AnyNode[] = [];
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) {
      for (const child of value) if (isAcornNode(child)) children.push(child);
    } else if (isAcornNode(value)) children.push(value);
  }
  return children;
}
function isWorkflowCallKind(value: unknown): value is WorkflowCallKind {
  return typeof value === "string" && WORKFLOW_CALL_KINDS.some((kind) => kind === value);
}
function isWorkflowCall(node: acorn.AnyNode): node is WorkflowCall {
  return node.type === "CallExpression" && node.callee.type === "Identifier" && isWorkflowCallKind(node.callee.name);
}
function workflowCallKind(node: acorn.AnyNode): WorkflowCallKind | undefined {
  return isWorkflowCall(node) ? node.callee.name : undefined;
}
function workflowCalls(program: acorn.Program): WorkflowCall[] {
  const calls: WorkflowCall[] = [];
  const visit = (node: acorn.AnyNode): void => {
    if (isWorkflowCall(node)) calls.push(node);
    for (const child of astChildren(node)) visit(child);
  };
  visit(program);
  return calls.sort((left, right) => left.start - right.start);
}

function workflowCallsWithStructure(program: acorn.Program): Array<{ call: WorkflowCall; execution: StaticWorkflowExecution; structure: readonly StaticWorkflowScope[] }> {
  const calls: Array<{ call: WorkflowCall; execution: StaticWorkflowExecution; structure: readonly StaticWorkflowScope[] }> = [];
  const visit = (node: acorn.AnyNode, context: StaticWorkflowContext): void => {
    let current = context;
    if (node.type === "Property" && current.structure.length) {
      const scope = current.structure.at(-1);
      const key = propertyKeyName(node);
      if (scope?.key === null && key) current = { ...current, structure: [...current.structure.slice(0, -1), { ...scope, key }] };
    }
    if (isWorkflowCall(node)) {
      const call = node;
      const operation = call.callee.name;
      const execution = operation === "parallel" ? "parallel" : operation === "pipeline" ? "sequential" : current.execution;
      calls.push({ call, execution, structure: current.structure });
      for (const [index, argument] of call.arguments.entries()) {
        if (argument.type === "SpreadElement") continue;
        const scopeKind = operation === "parallel" && index === 1 ? "parallel" : operation === "pipeline" && index === 2 ? "pipeline" : undefined;
        visit(argument, scopeKind ? { execution, structure: [...current.structure, { kind: scopeKind, name: staticString(callArgument(call, 0)), key: null }] } : current);
      }
      return;
    }
    for (const child of astChildren(node)) visit(child, current);
  };
  visit(program, { execution: "sequential", structure: [] });
  return calls.sort((left, right) => left.call.start - right.call.start);
}
function memberCall(node: acorn.AnyNode | undefined, objectName: string, propertyName: string): boolean {
  if (node?.type !== "CallExpression" || node.callee.type !== "MemberExpression" || node.callee.computed || node.callee.object.type !== "Identifier" || node.callee.object.name !== objectName || node.callee.property.type !== "Identifier") return false;
  return node.callee.property.name === propertyName;
}
function mapCallback(node: acorn.AnyNode): acorn.AnyNode | undefined {
  if (!memberCall(node, "Promise", "all") && !memberCall(node, "Promise", "allSettled")) return undefined;
  if (node.type !== "CallExpression") return undefined;
  const source = node.arguments[0];
  if (source?.type !== "CallExpression" || source.callee.type !== "MemberExpression" || source.callee.computed || source.callee.property.type !== "Identifier" || !["map", "flatMap"].includes(source.callee.property.name)) return undefined;
  const callback = source.arguments[0];
  return callback?.type === "ArrowFunctionExpression" || callback?.type === "FunctionExpression" ? callback : undefined;
}
function hasUnscopedAgent(node: acorn.AnyNode, scoped = false): boolean {
  const operation = workflowCallKind(node);
  if (operation === "agent") return !scoped;
  const nestedScope = scoped || operation === "parallel" || operation === "pipeline";
  return astChildren(node).some((child) => hasUnscopedAgent(child, nestedScope));
}
function validateObviousConcurrentAgentCalls(program: acorn.Program): void {
  const visit = (node: acorn.AnyNode): void => {
    const callback = mapCallback(node);
    if (callback && hasUnscopedAgent(callback)) fail("INVALID_METADATA", "Promise.all/map agent fan-out cannot prove stable call-site identity; use parallel(...) or pipeline(...)");
    for (const child of astChildren(node)) visit(child);
  };
  visit(program);
}
function validateDirectPrimitiveReferences(program: acorn.AnyNode, name: string): void {
  const visit = (node: acorn.AnyNode, parent?: acorn.AnyNode): void => {
    if (node.type === "Identifier" && node.name === name) {
      const directCall = parent?.type === "CallExpression" && parent.callee === node;
      const propertyKey = parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand;
      if (!directCall && !propertyKey) fail("INVALID_METADATA", `${name} calls must use a direct ${name}(...) call; aliases and indirect calls are unsupported`);
    }
    for (const child of astChildren(node)) visit(child, node);
  };
  visit(program);
}
function validateRemovedWorkflowPrimitives(program: acorn.AnyNode, code: WorkflowErrorCode): void {
  const visit = (node: acorn.AnyNode): void => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && node.callee.name === "conversation") fail(code, "conversation() was removed; pass prior agent results explicitly");
    for (const child of astChildren(node)) visit(child);
  };
  visit(program);
}
function validateDirectAgentReferences(program: acorn.AnyNode, code: WorkflowErrorCode): void {
  const visit = (node: acorn.AnyNode, parent?: acorn.AnyNode, grandparent?: acorn.AnyNode): void => {
    if (node.type === "Identifier" && node.name === "agent") {
      const directCall = parent?.type === "CallExpression" && parent.callee === node;
      const createCall = parent?.type === "MemberExpression" && parent.object === node && !parent.computed && parent.property.type === "Identifier" && parent.property.name === "create" && grandparent?.type === "CallExpression" && grandparent.callee === parent;
      const propertyName = parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand || parent?.type === "MemberExpression" && parent.property === node && !parent.computed;
      if (!directCall && !createCall && !propertyName) fail(code, "agent calls must use a direct agent(...) or agent.create(...) call; aliases and indirect calls are unsupported");
    }
    for (const child of astChildren(node)) visit(child, node, parent);
  };
  visit(program);
}
function agentCreateCalls(program: acorn.Program): acorn.CallExpression[] {
  const calls: acorn.CallExpression[] = [];
  const visit = (node: acorn.AnyNode): void => {
    if (node.type === "CallExpression" && node.callee.type === "MemberExpression" && !node.callee.computed && node.callee.object.type === "Identifier" && node.callee.object.name === "agent" && node.callee.property.type === "Identifier" && node.callee.property.name === "create") calls.push(node);
    for (const child of astChildren(node)) visit(child);
  };
  visit(program);
  return calls;
}
function hasIdentifier(node: acorn.AnyNode, name: string): boolean {
  if (node.type === "Identifier" && node.name === name) return true;
  return astChildren(node).some((child) => hasIdentifier(child, name));
}

type StaticWorkflowContext = { execution: StaticWorkflowExecution; structure: readonly StaticWorkflowScope[] };

const INTERNAL_AGENT_NAME = "__pi_extensible_workflows_agent";
const INTERNAL_WORKTREE_NAME = "__pi_extensible_workflows_withWorktree";
const INTERNAL_SHELL_NAME = "__pi_extensible_workflows_shell";
const RESERVED_IDENTIFIERS = [[INTERNAL_AGENT_NAME, "agent"], [INTERNAL_WORKTREE_NAME, "withWorktree"], [INTERNAL_SHELL_NAME, "shell"]] as const;
/** Workflow source must not mention the identifiers instrumentation rewrites primitive calls into. */
function assertNoReservedIdentifiers(program: acorn.Program): void {
  for (const [name, primitive] of RESERVED_IDENTIFIERS) if (hasIdentifier(program, name)) fail("INVALID_METADATA", `${name} is reserved for workflow ${primitive} instrumentation`);
}

function callHasTrailingComma(source: string, call: WorkflowCall): boolean {
  let previous: acorn.Token | undefined;
  let current: acorn.Token | undefined;
  for (const token of acorn.tokenizer(source.slice(call.start, call.end), { ecmaVersion: "latest", sourceType: "module" })) {
    previous = current;
    current = token;
  }
  return current?.type.label === ")" && previous?.type.label === ",";
}

/**
 * The `tools.<id>` members a workflow script names statically. Any other use of `tools`, such as a
 * local declaration that shadows the global or passing it around, makes the set unknowable: undefined.
 */
export function scriptToolReferences(script: string): string[] | undefined {
  const body = workflowBody(script);
  if (!body.trim()) return [];
  const names = new Set<string>();
  const opaque = (node: acorn.AnyNode, parent?: acorn.AnyNode): boolean => {
    if (node.type === "Identifier" && node.name === "tools") {
      if (parent?.type === "MemberExpression" && parent.object === node && !parent.computed && parent.property.type === "Identifier") names.add(parent.property.name);
      else if (!(parent?.type === "Property" && parent.key === node && !parent.computed && !parent.shorthand || parent?.type === "MemberExpression" && parent.property === node && !parent.computed)) return true;
    }
    return astChildren(node).some((child) => opaque(child, node));
  };
  return opaque(parseWorkflow(body)) ? undefined : [...names];
}

export function instrumentWorkflow(script: string): string {
  const body = workflowBody(script);
  if (!body.trim()) return body;
  const program = parseWorkflow(body);
  assertNoReservedIdentifiers(program);
  validateRemovedWorkflowPrimitives(program, "INVALID_METADATA");
  const calls = workflowCalls(program).filter((call) => ["agent", "withWorktree", "shell"].includes(call.callee.name));
  const edits = calls.flatMap((call) => {
    const replacement = { start: call.callee.start, end: call.callee.end, text: call.callee.name === "agent" ? INTERNAL_AGENT_NAME : call.callee.name === "withWorktree" ? INTERNAL_WORKTREE_NAME : INTERNAL_SHELL_NAME };
    if (call.callee.name === "withWorktree") return [replacement];
    const callSite = `${String(call.start)}:${String(call.end)}`;
    const hiddenArgument = call.arguments.length === 0 || callHasTrailingComma(body, call) ? "" : ", ";
    return [replacement, { start: call.end - 1, end: call.end - 1, text: `${hiddenArgument}${JSON.stringify(callSite)}` }];
  }).sort((left, right) => right.start - left.start);
  let instrumented = body;
  for (const edit of edits) instrumented = instrumented.slice(0, edit.start) + edit.text + instrumented.slice(edit.end);
  return instrumented;
}

function literalString(node: acorn.AnyNode | undefined): string | undefined {
  return node?.type === "Literal" && typeof node.value === "string" ? node.value : undefined;
}

function propertyNode(node: acorn.AnyNode | undefined, name: string): acorn.AnyNode | undefined {
  if (node?.type !== "ObjectExpression") return undefined;
  for (let index = node.properties.length - 1; index >= 0; index -= 1) {
    const property = node.properties[index];
    if (!property || property.type === "SpreadElement" || property.computed) return undefined;
    const key = propertyKeyName(property);
    if (key === name) return property.value;
  }
  return undefined;
}

function stableName(node: acorn.AnyNode | undefined): boolean | undefined {
  if (!node) return false;
  if (node.type !== "ObjectExpression") {
    if (["Literal", "ArrayExpression", "ArrowFunctionExpression", "FunctionExpression", "ClassExpression", "TemplateLiteral", "UnaryExpression", "UpdateExpression", "BinaryExpression"].includes(node.type)) return false;
    return undefined;
  }
  let result: boolean | undefined = false;
  for (const property of node.properties) {
    if (property.type === "SpreadElement" || property.computed) { result = undefined; continue; }
    const key = propertyKeyName(property);
    if (key !== "name") continue;
    const value = literalString(property.value);
    result = value === undefined ? property.value.type === "Literal" ? false : undefined : value.trim() !== "";
  }
  return result;
}



export function workflowPrompt(template: string, values: Readonly<Record<string, JsonValue>>): string {
  if (typeof template !== "string") fail("INVALID_METADATA", "prompt() template must be a string");
  if (!object(values) || Array.isArray(values) || !jsonValue(values)) fail("INVALID_METADATA", "prompt() values must be a plain JSON-compatible object");
  const placeholders = [...template.matchAll(/{{|}}|{([A-Za-z_$][\w$]*)}/g)].flatMap((match) => match[1] === undefined ? [] : [match[1]]);
  const used = new Set(placeholders);
  const keys = Object.keys(values);
  const missing = placeholders.find((key) => !Object.prototype.hasOwnProperty.call(values, key));
  if (missing) fail("INVALID_METADATA", `Missing prompt value "${missing}"`);
  const unused = keys.find((key) => !used.has(key));
  if (unused !== undefined) fail("INVALID_METADATA", `Unused prompt value "${unused}"`);
  return template.replace(/{{|}}|{([A-Za-z_$][\w$]*)}/g, (match, key: string | undefined) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    if (typeof key !== "string") return match;
    const value = values[key];
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  });
}

const AGENT_OPTION_KEYS = new Set(["label", "model", "tools", "excludeTools", "skills", "extensions", "contextFiles", "outputSchema", "retries", "timeoutMs"]);
export function isCoreAgentOption(key: string): boolean { return AGENT_OPTION_KEYS.has(key); }
function validateAgentOption(key: string, value: unknown): void {
  switch (key) {
    case "label":
      if (typeof value !== "string" || !value.trim()) fail("INVALID_METADATA", "agent label must be a non-empty string");
      break;
    case "model":
      if (typeof value !== "string" || !value.trim()) fail("INVALID_METADATA", "agent model must be a non-empty string");
      assertModelThinking(value, "agent model");
      break;
    case "tools":
    case "skills":
    case "extensions":
      validateSelectorList(value, "agent options", key, "INVALID_METADATA", key !== "extensions");
      break;
    case "excludeTools":
      if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string" || !tool.trim() || tool !== tool.trim() || tool.startsWith("!") || resourcePatternHasMagic(tool))) fail("INVALID_METADATA", "agent excludeTools must be an array of exact tool names");
      if (value.includes("workflow_result")) fail("INVALID_METADATA", "agent excludeTools cannot remove workflow_result");
      break;
    case "contextFiles":
      validateContextFileScopes(value, "agent options");
      break;
    case "outputSchema":
      validateSchema(value, "agent outputSchema");
      break;
    case "retries":
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) fail("INVALID_METADATA", "agent retries must be a non-negative integer");
      break;
    case "timeoutMs":
      if (value !== null && !positiveInteger(value)) fail("INVALID_METADATA", "agent timeoutMs must be null or a positive integer");
      break;
  }
}
export function validateAgentOptions(value: unknown): Readonly<Record<string, JsonValue>> {
  if (!object(value) || !jsonValue(value)) fail("INVALID_METADATA", "agent options must be a JSON object");
  if (Object.prototype.hasOwnProperty.call(value, "thinking")) fail("INVALID_METADATA", "agent thinking is not supported; use model provider/model:thinking");
  for (const [key, option] of Object.entries(value)) if (AGENT_OPTION_KEYS.has(key)) validateAgentOption(key, option);
  return value;
}
const SHELL_OPTION_KEYS = new Set(["timeoutMs", "env"]);
function isStringRecord(value: unknown): value is Record<string, string> { return object(value) && Object.values(value).every((entry) => typeof entry === "string"); }
export function validateShellOptions(value: unknown): ShellOptions {
  if (value === undefined) return {};
  if (!object(value) || !jsonValue(value) || Object.keys(value).some((key) => !SHELL_OPTION_KEYS.has(key))) fail("INVALID_METADATA", "shell options must contain only timeoutMs and env");
  if (value.timeoutMs !== undefined && !positiveInteger(value.timeoutMs)) fail("INVALID_METADATA", "shell timeoutMs must be a positive integer");
  const env = value.env;
  if (env !== undefined && !isStringRecord(env)) fail("INVALID_METADATA", "shell env must be an object of strings");
  return { ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }), ...(env === undefined ? {} : { env }) };
}
export function validateShellCommand(value: unknown): string {
  if (typeof value !== "string") fail("INVALID_METADATA", "shell command must be a string");
  return value;
}

type StaticValue = { known: true; value: unknown } | { known: false };

function staticValue(node: acorn.AnyNode | undefined): StaticValue {
  if (!node) return { known: false };
  if (node.type === "Literal") return { known: true, value: node.value };
  if (node.type === "UnaryExpression" && (node.operator === "-" || node.operator === "+")) {
    const argument = staticValue(node.argument);
    return argument.known && typeof argument.value === "number" ? { known: true, value: node.operator === "-" ? -argument.value : argument.value } : { known: false };
  }
  if (node.type === "ArrayExpression") {
    const values: unknown[] = [];
    for (const element of node.elements) {
      if (!element || element.type === "SpreadElement") return { known: false };
      const value = staticValue(element);
      if (!value.known) return { known: false };
      values.push(value.value);
    }
    return { known: true, value: values };
  }
  if (node.type === "ObjectExpression") {
    const value: Record<string, unknown> = {};
    for (const property of node.properties) {
      if (property.type === "SpreadElement" || property.computed) return { known: false };
      const key = propertyKeyName(property);
      const child = staticValue(property.value);
      if (!key || !child.known) return { known: false };
      value[key] = child.value;
    }
    return { known: true, value };
  }
  return { known: false };
}



function callArgument(call: acorn.CallExpression, index: number): acorn.AnyNode | undefined {
  const argument = call.arguments[index];
  return argument?.type === "SpreadElement" ? undefined : argument;
}

function staticString(node: acorn.AnyNode | undefined): string | null {
  const value = staticValue(node);
  return value.known && typeof value.value === "string" ? value.value : null;
}

export function inspectWorkflowScript(script: string): StaticWorkflowCall[] {
  return workflowCallsWithStructure(parseWorkflow(script)).map(({ call, execution, structure }) => {
    const kind = call.callee.name;
    const first = callArgument(call, 0);
    const options = callArgument(call, 1);
    const placement = { execution, structure };
    if (kind === "agent") {
      const retries = staticValue(propertyNode(options, "retries"));
      const outputSchema = staticValue(propertyNode(options, "outputSchema"));
      const staticOutputSchema = outputSchema.known && jsonObject(outputSchema.value) ? outputSchema.value : undefined;
      const optionKeys = options?.type === "ObjectExpression" ? options.properties.flatMap((property) => {
        if (property.type === "SpreadElement" || property.computed) return [];
        const key = propertyKeyName(property);
        return key ? [key] : [];
      }) : [];
      const knownOptionEntries: Array<[string, JsonValue]> = [];
      for (const key of optionKeys) {
        const value = staticValue(propertyNode(options, key));
        if (value.known && jsonValue(value.value)) knownOptionEntries.push([key, value.value]);
      }
      const knownOptions: Record<string, JsonValue> = Object.fromEntries(knownOptionEntries);
      const base = { ...placement, kind, start: call.start, end: call.end, name: null, prompt: staticString(first), model: staticString(propertyNode(options, "model")), label: staticString(propertyNode(options, "label")) };
      return { ...base, ...(retries.known && typeof retries.value === "number" ? { retries: retries.value } : {}), ...(staticOutputSchema === undefined ? {} : { outputSchema: staticOutputSchema }), ...(optionKeys.length ? { options: knownOptions, optionKeys } : {}) };
    }
    if (kind === "checkpoint") return { ...placement, kind, start: call.start, end: call.end, name: staticString(propertyNode(first, "name")), prompt: staticString(propertyNode(first, "prompt")), model: null };
    if (kind === "shell") return { ...placement, kind, start: call.start, end: call.end, name: staticString(first), prompt: null, model: null };
    return { ...placement, kind, start: call.start, end: call.end, name: staticString(first), prompt: null, model: null };
  });
}

/** Every option is a preparation input, because any hook may read it; one dynamic value leaves the whole call to runtime. */
function staticPreparationOptions(node: acorn.AnyNode | undefined, omitted?: string): Record<string, JsonValue> | undefined {
  if (node?.type !== "ObjectExpression") return undefined;
  const options = new Map<string, JsonValue>();
  for (const property of node.properties) {
    if (property.type === "SpreadElement" || property.computed) return undefined;
    const key = propertyKeyName(property);
    if (key === undefined) return undefined;
    if (key === omitted) continue;
    const value = staticValue(property.value);
    // NOTE: an output schema only shapes the result, so a computed one (a const declared elsewhere) does not hide the call.
    if (key === "outputSchema" && !value.known) continue;
    if (!value.known || !jsonValue(value.value)) return undefined;
    options.set(key, value.value);
  }
  return Object.fromEntries(options);
}
/**
 * A handle prepares its first turn with the create options merged with that send's options, so create options are complete
 * only when every use of the handle provably passes no send options: `agent.create(...).send(prompt)` directly, or a
 * `const` handle whose every reference is `handle.send(prompt)`. Computed access, destructuring, aliases or any other
 * use leave the handle to runtime.
 */
function handlesWithCompleteOptions(program: acorn.Program): acorn.CallExpression[] {
  const parents = new Map<acorn.AnyNode, acorn.AnyNode>();
  const references = new Map<string, acorn.AnyNode[]>();
  const visit = (node: acorn.AnyNode): void => {
    if (node.type === "Identifier") references.set(node.name, [...(references.get(node.name) ?? []), node]);
    for (const child of astChildren(node)) { parents.set(child, node); visit(child); }
  };
  visit(program);
  const plainSend = (member: acorn.AnyNode | undefined): boolean => {
    const call = member ? parents.get(member) : undefined;
    return member?.type === "MemberExpression" && !member.computed && member.property.type === "Identifier" && member.property.name === "send"
      && call?.type === "CallExpression" && call.callee === member && call.arguments.length <= 1 && call.arguments.every((argument) => argument.type !== "SpreadElement");
  };
  return agentCreateCalls(program).filter((create) => {
    const parent = parents.get(create);
    if (parent?.type === "MemberExpression" && parent.object === create) return plainSend(parent);
    const declaration = parent ? parents.get(parent) : undefined;
    if (parent?.type !== "VariableDeclarator" || parent.init !== create || parent.id.type !== "Identifier" || declaration?.type !== "VariableDeclaration" || declaration.kind !== "const") return false;
    const name = parent.id.name;
    return (references.get(name) ?? []).every((reference) => reference === parent.id || (parents.get(reference)?.type === "MemberExpression" && (parents.get(reference) as acorn.MemberExpression).object === reference && plainSend(parents.get(reference))));
  });
}
/**
 * Distinct, completely static option objects of agent(...) and agent.create(...) calls, so launch can inspect them
 * before any effect. Calls with any dynamic option stay runtime-checked, and so do handles whose sends may add options.
 */
export function staticAgentPreparationOptions(script: string, registered: Readonly<Record<string, { run: (...args: never[]) => unknown }>> = {}): Array<Readonly<Record<string, JsonValue>>> {
  const program = parseWorkflow(script);
  const sources = [program, ...registeredFunctionPrograms(program, registered)];
  const distinct = new Map<string, Readonly<Record<string, JsonValue>>>();
  for (const source of sources) for (const options of programAgentOptions(source)) distinct.set(JSON.stringify(options), deepFreeze(options));
  return [...distinct.values()];
}
/** Programs of the registered functions the script calls by name, so their agents are inspected before launch like inline ones. */
function registeredFunctionPrograms(program: acorn.Program, registered: Readonly<Record<string, { run: (...args: never[]) => unknown }>>): acorn.Program[] {
  const called = new Set<string>();
  const visit = (node: acorn.AnyNode): void => {
    if (node.type === "CallExpression" && node.callee.type === "Identifier" && Object.prototype.hasOwnProperty.call(registered, node.callee.name)) called.add(node.callee.name);
    for (const child of astChildren(node)) visit(child);
  };
  visit(program);
  const programs: acorn.Program[] = [];
  for (const name of called) {
    const source = registered[name]?.run.toString() ?? "";
    // A method prints as `async run(...) {}`, which only parses inside an object literal.
    for (const wrapped of [`(${source})`, `({${source}})`]) {
      try { programs.push(acorn.parse(wrapped, { ecmaVersion: "latest", sourceType: "module" })); break; } catch { /* try the next form; an unparsable function stays runtime-checked */ }
    }
  }
  return programs;
}
function programAgentOptions(program: acorn.Program): Array<Readonly<Record<string, JsonValue>>> {
  const calls = workflowCalls(program).filter((call) => call.callee.name === "agent").map((call) => call.arguments.some((argument) => argument.type === "SpreadElement") ? undefined : call.arguments.length < 2 ? {} : staticPreparationOptions(callArgument(call, 1)));
  const handles = handlesWithCompleteOptions(program).map((call) => staticPreparationOptions(callArgument(call, 0), "name"));
  return [...calls, ...handles].filter((options): options is Record<string, JsonValue> => options !== undefined);
}

function validateStaticAgentOptions(node: acorn.AnyNode | undefined): void {
  if (node?.type !== "ObjectExpression") return;
  for (const key of AGENT_OPTION_KEYS) {
    const value = staticValue(propertyNode(node, key));
    if (value.known) validateAgentOption(key, value.value);
  }
}
function validateStaticShellOptions(call: WorkflowCall): void {
  if (call.arguments.some((argument) => argument.type === "SpreadElement")) return;
  if (call.arguments.length !== 1 && call.arguments.length !== 2) fail("INVALID_METADATA", "shell requires a command string and optional options");
  const command = staticValue(callArgument(call, 0));
  if (command.known) validateShellCommand(command.value);
  const options = staticValue(callArgument(call, 1));
  if (options.known) validateShellOptions(options.value);
}

function validateStaticWithWorktree(call: WorkflowCall, compatibility: boolean): void {
  if (call.arguments.some((argument) => argument.type === "SpreadElement")) return;
  if (call.arguments.length !== 2) fail(compatibility ? "RESUME_INCOMPATIBLE" : "INVALID_METADATA", "withWorktree requires a name and callback");
  const callback = call.arguments[1];
  if (staticValue(callback).known) fail("INVALID_METADATA", "withWorktree callback must be a function");
  const name = staticValue(callArgument(call, 0));
  if (name.known && (typeof name.value !== "string" || !name.value.trim())) fail("INVALID_METADATA", "withWorktree name must be a non-empty string");
}
export function preflight(script: string, capabilities: PreflightCapabilities, schemas: readonly unknown[] = [], metadata: WorkflowMetadata = { name: "workflow" }, compatibility = false): PreflightResult {
  const checkedMetadata = validateWorkflowMetadata(metadata);
  const program = parseWorkflow(script);
  assertNoReservedIdentifiers(program);
  validateDirectPrimitiveReferences(program, "withWorktree");
  validateRemovedWorkflowPrimitives(program, compatibility ? "RESUME_INCOMPATIBLE" : "INVALID_METADATA");
  validateDirectPrimitiveReferences(program, "shell");
  validateDirectAgentReferences(program, compatibility ? "RESUME_INCOMPATIBLE" : "INVALID_METADATA");
  const checkedSchemas: JsonSchema[] = [];
  for (const [index, schema] of schemas.entries()) {
    validateSchema(schema, `schema[${String(index)}]`);
    checkedSchemas.push(schema);
  }
  const calls = workflowCalls(program);
  validateObviousConcurrentAgentCalls(program);
  const phases = calls.filter((call) => call.callee.name === "phase").map((call) => literalString(call.arguments[0])).filter((phase): phase is string => phase !== undefined);
  for (const call of calls) {
    const operation = call.callee.name;
    if (operation === "agent") validateStaticAgentOptions(call.arguments[1]);
    if (operation === "withWorktree") validateStaticWithWorktree(call, compatibility);
    if (operation === "shell") validateStaticShellOptions(call);
    if ((operation === "parallel" || operation === "pipeline") && call.arguments.some((argument) => argument.type === "SpreadElement")) continue;
    if (operation === "checkpoint" && stableName(call.arguments[0]) === false) fail("INVALID_METADATA", `${operation} requires a stable explicit name`);
    if (operation === "parallel" && (call.arguments.length !== 2 || !literalString(call.arguments[0])?.trim() || call.arguments[1]?.type !== "ObjectExpression")) fail("INVALID_METADATA", "parallel requires an operation name string and tasks record");
    if (operation === "pipeline" && (call.arguments.length !== 3 || !literalString(call.arguments[0])?.trim() || call.arguments[1]?.type !== "ObjectExpression" || call.arguments[2]?.type !== "ObjectExpression")) fail("INVALID_METADATA", "pipeline requires an operation name string, items record, and stages record");
  }
  const handleOptions = agentCreateCalls(program).map((call) => {
    const options = call.arguments.length === 1 ? callArgument(call, 0) : undefined;
    if (options?.type !== "ObjectExpression" || !literalString(propertyNode(options, "name"))?.trim()) fail("INVALID_METADATA", "agent.create requires an options object with a stable explicit name");
    validateStaticAgentOptions(options);
    return options;
  });
  const agentOptions = [...calls.filter((call) => call.callee.name === "agent").map((call) => callArgument(call, 1)), ...handleOptions];
  const staticSchemas: JsonSchema[] = [];
  for (const options of agentOptions) {
    const value = staticValue(propertyNode(options, "outputSchema"));
    if (!value.known) continue;
    const schema = value.value;
    validateSchema(schema, `agent outputSchema[${String(staticSchemas.length)}]`);
    staticSchemas.push(schema);
  }
  checkedSchemas.push(...staticSchemas);
  const models: string[] = [];
  const tools = agentOptions.flatMap((options) => {
    const value = propertyNode(options, "tools");
    return value?.type === "ArrayExpression" ? value.elements.flatMap((element) => { const tool = element && element.type !== "SpreadElement" ? literalString(element) : undefined; return tool === undefined ? [] : [tool]; }) : [];
  });
  for (const pattern of tools) {
    const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    if (!pattern.startsWith("!") && !resourcePatternHasMagic(pattern) && !capabilities.tools.has(body)) fail("UNKNOWN_TOOL", `Unknown tool: ${body}`);
  }
  return Object.freeze({ metadata: deepFreeze(checkedMetadata), referenced: deepFreeze({ phases, models, tools }), schemas: deepFreeze(checkedSchemas) });
}

export function validateWorkflowLaunch(params: WorkflowValidationParameters, context: WorkflowValidationContext, registry?: WorkflowRegistryApi): ValidatedWorkflowLaunch {
  return validateWorkflowLaunchWithRegistry(params, context, registry);
}
export function validateWorkflowLaunchWithRegistry(params: WorkflowValidationParameters, context: WorkflowValidationContext, registry?: WorkflowRegistryApi): ValidatedWorkflowLaunch {
  if (Object.prototype.hasOwnProperty.call(params, "maxAgentLaunches")) fail("INVALID_METADATA", "maxAgentLaunches has been removed; use budget.agentLaunches");
  const hasScript = params.script !== undefined;
  const hasScriptPath = params.scriptPath !== undefined;
  if (hasScript && hasScriptPath) fail("INVALID_METADATA", "Provide either script or scriptPath, not more than one");
  const scriptPath = typeof params.scriptPath === "string" ? params.scriptPath.trim() : undefined;
  if (hasScriptPath && !scriptPath) fail("INVALID_METADATA", "scriptPath must be a non-empty path");
  let fileScript: string | undefined;
  if (scriptPath !== undefined) {
    try { fileScript = readFileSync(resolve(context.cwd, scriptPath), "utf8"); }
    catch (error) { fail("INVALID_SYNTAX", `Cannot read workflow script file ${scriptPath}: ${errorText(error)}`); }
  }
  const rawName: unknown = params.name;
  const explicitName = typeof rawName === "string" ? rawName.trim() : "";
  if (!explicitName) fail("INVALID_METADATA", "Workflow name must be non-empty");
  const script = typeof params.script === "string" && params.script.trim() ? params.script : fileScript ?? "";
  if (!script) fail("INVALID_SYNTAX", "Provide script or scriptPath");
  const metadata = validateWorkflowMetadata({ name: explicitName, ...(typeof params.description === "string" ? { description: params.description } : {}) });
  const checked = preflight(script, { models: context.availableModels, tools: context.rootTools, modelAliases: context.modelAliases ?? {}, knownModels: context.knownModels ?? context.availableModels, ...(context.settingsPath ? { settingsPath: context.settingsPath } : {}) }, [], metadata);
  registry?.validateExtensionSettings(context.extensionSettings, { source: "effective", cwd: context.cwd, projectTrusted: context.projectTrusted, ...(context.settingsPath ? { settingsPath: context.settingsPath } : {}) });
  return { script, checked };
}

export { createLaunchSnapshot, loadLaunchSnapshot } from "./utils.js";
