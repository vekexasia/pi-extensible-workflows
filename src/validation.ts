import { atomicWriteFile } from "./persistence.js";
import { mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";
import { Script } from "node:vm";
import { Value } from "typebox/value";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { WorkflowError } from "./types.js";
import type { AgentDefinition, AgentResourceExclusions, AgentResourcePolicy, CheckpointInput, JsonSchema, JsonValue, LaunchSnapshot, PreflightCapabilities, PreflightResult, ShellOptions, StaticWorkflowCall, StaticWorkflowExecution, StaticWorkflowScope, ValidatedWorkflowLaunch, WorkflowCallKind, WorkflowErrorCode, WorkflowMetadata, WorkflowSettings, WorkflowValidationContext, WorkflowValidationParameters } from "./types.js";
import type { WorkflowRegistryApi } from "./registry.js";
import { deepFreeze, errorText, fail, jsonValue, mergeAgentResourceExclusions, modelAliasName, modelCapability, object, parseThinking, positiveInteger, resolveModelReference, unknownModel, validateModelAliases } from "./utils.js";
import { WORKFLOW_CALL_KINDS } from "./types.js";

export const DEFAULT_SETTINGS: Readonly<WorkflowSettings> = Object.freeze({ concurrency: 8 });

export function validateCheckpoint(value: unknown): CheckpointInput {
  if (!object(value) || Object.keys(value).some((key) => !["name", "prompt", "context"].includes(key)) || typeof value.name !== "string" || value.name.trim() === "" || typeof value.prompt !== "string" || !jsonValue(value.context)) fail("INVALID_METADATA", "checkpoint requires only name, prompt, and JSON context");
  if (Buffer.byteLength(value.prompt) > 1024) fail("INVALID_METADATA", "checkpoint prompt exceeds 1024 UTF-8 bytes");
  if (Buffer.byteLength(JSON.stringify(value.context)) > 4096) fail("INVALID_METADATA", "checkpoint context exceeds 4096 UTF-8 bytes");
  return { name: value.name, prompt: value.prompt, context: value.context };
}

export function workflowSettingsPath(agentDir = getAgentDir()): string { return join(agentDir, ROLE_DIRECTORY, "settings.json"); }
export function workflowProjectSettingsPath(cwd: string): string { return join(cwd, ".pi", ROLE_DIRECTORY, "settings.json"); }
const EMPTY_AGENT_RESOURCE_EXCLUSIONS: AgentResourceExclusions = Object.freeze({ skills: [], extensions: [] });
function normalizedResourcePath(value: string, settingsPath: string): string {
  let expanded = value === "~" ? homedir() : value.startsWith("~/") || value.startsWith("~\\") ? join(homedir(), value.slice(2)) : value;
  if (expanded.startsWith("file://")) expanded = fileURLToPath(expanded);
  const resolved = resolve(dirname(settingsPath), expanded);
  try { return realpathSync(resolved); } catch { return resolved; }
}
function validateAgentResourceExclusions(value: unknown, settingsPath: string, errorCode: "INVALID_SETTINGS" | "INVALID_METADATA" = "INVALID_SETTINGS"): AgentResourceExclusions | undefined {
  if (value === undefined) return undefined;
  const base = `${settingsPath}.disabledAgentResources`;
  if (!object(value)) fail(errorCode, `${base} must be an object`);
  for (const key of Object.keys(value)) if (key !== "skills" && key !== "extensions") fail(errorCode, `${base}.${key} is not supported`);
  const normalized: { skills: string[]; extensions: string[] } = { skills: [], extensions: [] };
  for (const kind of ["skills", "extensions"] as const) {
    const entries = value[kind];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) fail(errorCode, `${base}.${kind} must be an array`);
    const seen = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (typeof entry !== "string" || !entry.trim()) fail(errorCode, `${base}.${kind}[${String(index)}] must be a non-empty string`);
      let selector = entry.trim();
      if (kind === "extensions") {
        try { selector = normalizedResourcePath(selector, settingsPath); } catch (error) { fail(errorCode, `${base}.${kind}[${String(index)}] must be a valid path: ${errorText(error)}`); }
      }
      if (!seen.has(selector)) { seen.add(selector); normalized[kind].push(selector); }
    }
  }
  return Object.freeze({ skills: Object.freeze(normalized.skills), extensions: Object.freeze(normalized.extensions) });
}
export function loadSettings(path = workflowSettingsPath()): Readonly<WorkflowSettings> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return DEFAULT_SETTINGS;
    fail("CONFIG_ERROR", `Invalid workflow settings JSON at ${path}: ${errorText(error)}`);
  }
  if (!object(parsed)) fail("INVALID_SETTINGS", `Workflow settings at ${path} must be an object`);
  const allowed = new Set(["concurrency", "modelAliases", "disabledAgentResources"]);
  const unknown = Object.keys(parsed).find((key) => !allowed.has(key));
  if (unknown) fail("INVALID_SETTINGS", `Unknown workflow setting at ${path}: ${unknown}`);
  const concurrency = parsed.concurrency === undefined ? DEFAULT_SETTINGS.concurrency : parsed.concurrency;
  if (!positiveInteger(concurrency) || concurrency > 16) fail("INVALID_SETTINGS", `${path}.concurrency must be an integer from 1 to 16`);
  const modelAliases = parsed.modelAliases === undefined ? undefined : validateModelAliases(parsed.modelAliases, path);
  const disabledAgentResources = validateAgentResourceExclusions(parsed.disabledAgentResources, path);
  return Object.freeze({ concurrency, ...(modelAliases ? { modelAliases } : {}), ...(disabledAgentResources ? { disabledAgentResources } : {}) });
}
export function resolveAgentResourcePolicy(cwd: string, projectTrusted: boolean, globalSettingsPath = workflowSettingsPath()): AgentResourcePolicy {
  const projectSettingsPath = workflowProjectSettingsPath(cwd);
  const global = loadSettings(globalSettingsPath).disabledAgentResources ?? EMPTY_AGENT_RESOURCE_EXCLUSIONS;
  const project = projectTrusted ? loadSettings(projectSettingsPath).disabledAgentResources ?? EMPTY_AGENT_RESOURCE_EXCLUSIONS : EMPTY_AGENT_RESOURCE_EXCLUSIONS;
  const effective = mergeAgentResourceExclusions(global, project);
  return { globalSettingsPath, projectSettingsPath, projectTrusted, global, project, effective, unmatchedSkills: [], unmatchedExtensions: [] };
}
export function saveModelAliases(path = workflowSettingsPath(), aliases: Readonly<Record<string, string>> = {}): void {
  const normalized = validateModelAliases(aliases, path);
  let parsed: Record<string, unknown> = {};
  try {
    loadSettings(path);
    parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFile(path, `${JSON.stringify({ ...parsed, modelAliases: normalized }, null, 2)}\n`, true);
}

export function parseRoleMarkdown(content: string, strict = false, rolePath?: string): AgentDefinition {
  if (!strict) {
    if (!content.startsWith("---\n")) return { prompt: content };
    const end = content.indexOf("\n---", 4);
    if (end < 0) return { prompt: content };
    const meta: Record<string, string> = {};
    for (const line of content.slice(4, end).split("\n")) {
      const match = /^(model|thinking|tools|description)\s*:\s*(.+)$/.exec(line.trim());
      if (match?.[1] && match[2]) meta[match[1]] = match[2].trim();
    }
    const tools = meta.tools ? meta.tools.replace(/^\[|\]$/g, "").split(",").map((tool) => tool.trim().replace(/^[']|[']$/g, "").replace(/^["]|["]$/g, "")).filter(Boolean) : undefined;
    const thinking = meta.thinking?.replace(/^[']|[']$/g, "").replace(/^["]|["]$/g, "");
    if (thinking && !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking)) fail("INVALID_METADATA", `Invalid role thinking level: ${thinking}`);
    const definition: AgentDefinition = { prompt: content.slice(end + 4).replace(/^\n/, "") };
    if (meta.model) definition.model = meta.model.replace(/^[']|[']$/g, "").replace(/^["]|["]$/g, "");
    if (meta.description) definition.description = meta.description.replace(/^[']|[']$/g, "").replace(/^["]|["]$/g, "");
    if (thinking) definition.thinking = thinking as NonNullable<AgentDefinition["thinking"]>;
    if (tools) definition.tools = tools;
    return definition;
  }
  const normalized = content.replace(/\r\n?/g, "\n");
  if (normalized.startsWith("---\n") && normalized.indexOf("\n---", 3) < 0) fail("INVALID_METADATA", "Role frontmatter is missing its closing delimiter");
  let parsed: ReturnType<typeof parseFrontmatter>;
  try { parsed = parseFrontmatter(content); }
  catch (error) { fail("INVALID_METADATA", `Invalid role frontmatter: ${errorText(error)}`); }
  if (!object(parsed.frontmatter)) fail("INVALID_METADATA", "Role frontmatter must be an object");
  const { model, thinking, tools, description, disabledAgentResources } = parsed.frontmatter;
  if (model !== undefined && (typeof model !== "string" || model.trim() === "")) fail("INVALID_METADATA", "Role model must be a non-empty string");
  if (thinking !== undefined && (typeof thinking !== "string" || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinking))) fail("INVALID_METADATA", `Invalid role thinking level: ${typeof thinking === "string" ? thinking : typeof thinking}`);
  if (description !== undefined && (typeof description !== "string" || description.trim() === "" || description.length > 1024 || /[\r\n]/.test(description))) fail("INVALID_METADATA", "Role description must be a non-empty single-line string of at most 1024 characters");
  if (tools !== undefined && (!Array.isArray(tools) || tools.some((tool) => typeof tool !== "string" || tool.trim() === ""))) fail("INVALID_METADATA", "Role tools must be an array of non-empty strings");
  const normalizedResources = validateAgentResourceExclusions(disabledAgentResources, rolePath ?? "<role>", "INVALID_METADATA");
  return { prompt: parsed.body, ...(typeof description === "string" ? { description: description.trim() } : {}), ...(typeof model === "string" ? { model: model.trim() } : {}), ...(typeof thinking === "string" ? { thinking: thinking as NonNullable<AgentDefinition["thinking"]> } : {}), ...(Array.isArray(tools) ? { tools: tools.map((tool) => (tool as string).trim()) } : {}), ...(normalizedResources ? { disabledAgentResources: normalizedResources } : {}) };
}

const ROLE_DIRECTORY = "pi-extensible-workflows";

export function workflowRoleDirectories(agentDir = getAgentDir()): readonly string[] {
  return [join(agentDir, ROLE_DIRECTORY, "roles")];
}

function projectRoleDirectories(root: string): readonly string[] {
  return [join(root, ROLE_DIRECTORY, "roles")];
}

function readAgentDefinitions(dir: string): Record<string, AgentDefinition> {
  try {
    return Object.fromEntries(readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && extname(entry.name) === ".md")
      .map((entry) => { const path = join(dir, entry.name); return [basename(entry.name, ".md"), parseRoleMarkdown(readFileSync(path, "utf8"), true, path)]; }));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function readRoleDefinitions(dirs: readonly string[]): Record<string, AgentDefinition> {
  return Object.fromEntries(dirs.flatMap((dir) => Object.entries(readAgentDefinitions(dir))));
}

export function loadAgentDefinitions(cwd: string, agentDir = getAgentDir(), projectTrusted = true): Readonly<Record<string, AgentDefinition>> {
  return deepFreeze({ ...readRoleDefinitions(workflowRoleDirectories(agentDir)), ...(projectTrusted ? readRoleDefinitions(projectRoleDirectories(join(cwd, ".pi"))) : {}) });
}
function validateRolePolicies(definitions: Readonly<Record<string, AgentDefinition>>, roles: readonly string[], availableModels: ReadonlySet<string>, rootTools: ReadonlySet<string>, aliases: Readonly<Record<string, string>> = {}, knownModels = availableModels, settingsPath?: string): void {
  for (const role of roles) {
    const definition = definitions[role];
    if (!definition) continue;
    if (definition.model !== undefined) {
      const resolved = modelCapability(definition.model, aliases, knownModels, settingsPath);
      if (!availableModels.has(resolved)) {
        if (modelAliasName(definition.model, aliases)) unknownModel(definition.model, resolved, settingsPath);
        fail("UNKNOWN_MODEL", `Unknown model for role ${role}: ${resolved}`);
      }
    }
    const missingTool = (definition.tools ?? [...rootTools]).find((tool) => !rootTools.has(tool));
    if (missingTool) fail("UNKNOWN_TOOL", `Unknown tool for role ${role}: ${missingTool}`);
  }
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

type WorkflowCall = acorn.CallExpression & { callee: acorn.Identifier };

function astNode(value: unknown): value is acorn.AnyNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
}
function astChildren(node: acorn.AnyNode): acorn.AnyNode[] {
  const children: acorn.AnyNode[] = [];
  for (const value of Object.values(node) as unknown[]) {
    if (Array.isArray(value)) {
      for (const child of value) if (astNode(child)) children.push(child);
    } else if (astNode(value)) children.push(value);
  }
  return children;
}
function workflowCallKind(node: acorn.AnyNode): WorkflowCallKind | undefined {
  if (node.type !== "CallExpression" || node.callee.type !== "Identifier") return undefined;
  const kind = node.callee.name as WorkflowCallKind;
  return WORKFLOW_CALL_KINDS.includes(kind) ? kind : undefined;
}
function workflowCalls(program: acorn.Program): WorkflowCall[] {
  const calls: WorkflowCall[] = [];
  const visit = (node: acorn.AnyNode): void => {
    if (workflowCallKind(node)) calls.push(node as WorkflowCall);
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
      const key = node.key.type === "Identifier" ? node.key.name : node.key.type === "Literal" ? String(node.key.value) : undefined;
      if (scope?.key === null && key) current = { ...current, structure: [...current.structure.slice(0, -1), { ...scope, key }] };
    }
    const operation = workflowCallKind(node);
    if (operation) {
      const call = node as WorkflowCall;
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
function hasIdentifier(node: acorn.AnyNode, name: string): boolean {
  if (node.type === "Identifier" && node.name === name) return true;
  return astChildren(node).some((child) => hasIdentifier(child, name));
}

type StaticWorkflowContext = { execution: StaticWorkflowExecution; structure: readonly StaticWorkflowScope[] };

const INTERNAL_AGENT_NAME = "__pi_extensible_workflows_agent";
const INTERNAL_WORKTREE_NAME = "__pi_extensible_workflows_withWorktree";
const INTERNAL_SHELL_NAME = "__pi_extensible_workflows_shell";

function callHasTrailingComma(source: string, call: WorkflowCall): boolean {
  let previous: acorn.Token | undefined;
  let current: acorn.Token | undefined;
  for (const token of acorn.tokenizer(source.slice(call.start, call.end), { ecmaVersion: "latest", sourceType: "module" })) {
    previous = current;
    current = token;
  }
  return current?.type.label === ")" && previous?.type.label === ",";
}

export function instrumentWorkflow(script: string): string {
  const body = workflowBody(script);
  if (!body.trim()) return body;
  const program = parseWorkflow(body);
  if (hasIdentifier(program, INTERNAL_AGENT_NAME)) fail("INVALID_METADATA", `${INTERNAL_AGENT_NAME} is reserved for workflow agent instrumentation`);
  if (hasIdentifier(program, INTERNAL_WORKTREE_NAME)) fail("INVALID_METADATA", `${INTERNAL_WORKTREE_NAME} is reserved for workflow withWorktree instrumentation`);
  if (hasIdentifier(program, INTERNAL_SHELL_NAME)) fail("INVALID_METADATA", `${INTERNAL_SHELL_NAME} is reserved for workflow shell instrumentation`);
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
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
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
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
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
  return template.replace(/{{|}}|{([A-Za-z_$][\w$]*)}/g, (match, key: string | undefined) => match === "{{" ? "{" : match === "}}" ? "}" : typeof values[key as string] === "string" ? values[key as string] as string : JSON.stringify(values[key as string], null, 2));
}

export function validateSchema(schema: unknown, at = "schema"): asserts schema is JsonSchema {
  if (!object(schema) || Object.getPrototypeOf(schema) !== Object.prototype || !jsonValue(schema)) fail("INVALID_SCHEMA", `${at} must be a plain JSON-compatible Schema object`);
  if (typeof schema.type !== "string" && !Array.isArray(schema.type) && schema.$ref === undefined && schema.anyOf === undefined && schema.oneOf === undefined && schema.allOf === undefined && schema.const === undefined && schema.enum === undefined) fail("INVALID_SCHEMA", `${at} has no JSON Schema shape`);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) fail("INVALID_SCHEMA", `${at}.required must be an array of strings`);
  if (schema.properties !== undefined && !object(schema.properties)) fail("INVALID_SCHEMA", `${at}.properties must be an object`);
}

const AGENT_OPTION_KEYS = new Set(["label", "model", "thinking", "tools", "role", "outputSchema", "retries", "timeoutMs"]);
function validateAgentOption(key: string, value: unknown, aliases?: Readonly<Record<string, string>>, knownModels?: ReadonlySet<string>, settingsPath?: string): void {
  switch (key) {
    case "label":
      if (typeof value !== "string" || !value.trim()) fail("INVALID_METADATA", "agent label must be a non-empty string");
      break;
    case "model":
      if (typeof value !== "string" || !value.trim()) fail("INVALID_METADATA", "agent model must be a non-empty string");
      if (aliases !== undefined) resolveModelReference(value, aliases, knownModels, settingsPath);
      break;
    case "thinking":
      if (typeof value !== "string" || !parseThinking(value)) fail("INVALID_METADATA", "agent thinking must be off, minimal, low, medium, high, xhigh, or max");
      break;
    case "tools":
      if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string")) fail("INVALID_METADATA", "agent tools must be an array of strings");
      break;
    case "role":
      if (typeof value !== "string" || !value.trim()) fail("INVALID_METADATA", "agent role must be a non-empty string");
      break;
    case "outputSchema":
      validateSchema(value, "agent outputSchema");
      break;
    case "retries":
      if (!Number.isInteger(value) || (value as number) < 0) fail("INVALID_METADATA", "agent retries must be a non-negative integer");
      break;
    case "timeoutMs":
      if (value !== null && !positiveInteger(value)) fail("INVALID_METADATA", "agent timeoutMs must be null or a positive integer");
      break;
  }
}
export function validateAgentOptions(value: unknown): Readonly<Record<string, JsonValue>> {
  if (!object(value) || !jsonValue(value)) fail("INVALID_METADATA", "agent options must be a JSON object");
  for (const [key, option] of Object.entries(value)) if (AGENT_OPTION_KEYS.has(key)) validateAgentOption(key, option);
  if (typeof value.role === "string" && ["model", "thinking", "tools"].some((key) => Object.prototype.hasOwnProperty.call(value, key))) fail("INVALID_METADATA", "Role agents must not specify model, thinking, or tools");
  return value;
}
const SHELL_OPTION_KEYS = new Set(["timeoutMs", "env"]);
export function validateShellOptions(value: unknown): ShellOptions {
  if (value === undefined) return {};
  if (!object(value) || !jsonValue(value) || Object.keys(value).some((key) => !SHELL_OPTION_KEYS.has(key))) fail("INVALID_METADATA", "shell options must contain only timeoutMs and env");
  if (value.timeoutMs !== undefined && !positiveInteger(value.timeoutMs)) fail("INVALID_METADATA", "shell timeoutMs must be a positive integer");
  if (value.env !== undefined && (!object(value.env) || Object.values(value.env).some((entry) => typeof entry !== "string"))) fail("INVALID_METADATA", "shell env must be an object of strings");
  return { ...(value.timeoutMs === undefined ? {} : { timeoutMs: value.timeoutMs }), ...(value.env === undefined ? {} : { env: value.env as Record<string, string> }) };
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
      const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
      const child = staticValue(property.value);
      if (!key || !child.known) return { known: false };
      value[key] = child.value;
    }
    return { known: true, value };
  }
  return { known: false };
}



function callArgument(call: WorkflowCall, index: number): acorn.AnyNode | undefined {
  const argument = call.arguments[index];
  return argument?.type === "SpreadElement" ? undefined : argument;
}

function staticString(node: acorn.AnyNode | undefined): string | null {
  const value = staticValue(node);
  return value.known && typeof value.value === "string" ? value.value : null;
}

export function inspectWorkflowScript(script: string): StaticWorkflowCall[] {
  return workflowCallsWithStructure(parseWorkflow(script)).map(({ call, execution, structure }) => {
    const kind = call.callee.name as StaticWorkflowCall["kind"];
    const first = callArgument(call, 0);
    const options = callArgument(call, 1);
    const placement = { execution, structure };
    if (kind === "agent") {
      const retries = staticValue(propertyNode(options, "retries"));
      const outputSchema = staticValue(propertyNode(options, "outputSchema"));
      const optionKeys = options?.type === "ObjectExpression" ? options.properties.flatMap((property) => {
        if (property.type === "SpreadElement" || property.computed) return [];
        const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
        return key ? [key] : [];
      }) : [];
      const knownOptions = Object.fromEntries(optionKeys.flatMap((key) => { const value = staticValue(propertyNode(options, key)); return value.known && jsonValue(value.value) ? [[key, value.value]] : []; })) as Record<string, JsonValue>;
      const base = { ...placement, kind, start: call.start, end: call.end, name: null, prompt: staticString(first), model: staticString(propertyNode(options, "model")), label: staticString(propertyNode(options, "label")), role: staticString(propertyNode(options, "role")) };
      return { ...base, ...(retries.known && typeof retries.value === "number" ? { retries: retries.value } : {}), ...(outputSchema.known && object(outputSchema.value) ? { outputSchema: outputSchema.value as JsonSchema } : {}), ...(optionKeys.length ? { options: knownOptions, optionKeys } : {}) };
    }
    if (kind === "checkpoint") return { ...placement, kind, start: call.start, end: call.end, name: staticString(propertyNode(first, "name")), prompt: staticString(propertyNode(first, "prompt")), model: null, role: null };
    if (kind === "shell") return { ...placement, kind, start: call.start, end: call.end, name: staticString(first), prompt: null, model: null, role: null };
    return { ...placement, kind, start: call.start, end: call.end, name: staticString(first), prompt: null, model: null, role: null };
  });
}

function validateStaticAgentOptions(node: acorn.AnyNode | undefined, aliases: Readonly<Record<string, string>> = {}, knownModels?: ReadonlySet<string>, settingsPath?: string): void {
  if (node?.type !== "ObjectExpression") return;
  const options = staticValue(node);
  if (options.known && object(options.value) && typeof options.value.role === "string" && ["model", "thinking", "tools"].some((key) => Object.prototype.hasOwnProperty.call(options.value as Record<string, unknown>, key))) fail("INVALID_METADATA", "Role agents must not specify model, thinking, or tools");
  for (const key of AGENT_OPTION_KEYS) {
    const value = staticValue(propertyNode(node, key));
    if (value.known) validateAgentOption(key, value.value, aliases, knownModels, settingsPath);
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


function hasDynamicAgentRole(node: acorn.AnyNode | undefined): boolean {
  if (!node) return false;
  if (node.type !== "ObjectExpression") return true;
  for (let index = node.properties.length - 1; index >= 0; index -= 1) {
    const property = node.properties[index];
    if (!property || property.type === "SpreadElement" || property.computed) return true;
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
    if (key === "role") return literalString(property.value) === undefined;
  }
  return false;
}
export function preflight(script: string, capabilities: PreflightCapabilities, schemas: readonly unknown[] = [], metadata: WorkflowMetadata = { name: "workflow" }, compatibility = false): PreflightResult {
  const checkedMetadata = validateWorkflowMetadata(metadata);
  const program = parseWorkflow(script);
  if (hasIdentifier(program, INTERNAL_AGENT_NAME)) fail("INVALID_METADATA", `${INTERNAL_AGENT_NAME} is reserved for workflow agent instrumentation`);
  if (hasIdentifier(program, INTERNAL_WORKTREE_NAME)) fail("INVALID_METADATA", `${INTERNAL_WORKTREE_NAME} is reserved for workflow withWorktree instrumentation`);
  if (hasIdentifier(program, INTERNAL_SHELL_NAME)) fail("INVALID_METADATA", `${INTERNAL_SHELL_NAME} is reserved for workflow shell instrumentation`);
  validateDirectPrimitiveReferences(program, "withWorktree");
  validateRemovedWorkflowPrimitives(program, compatibility ? "RESUME_INCOMPATIBLE" : "INVALID_METADATA");
  validateDirectPrimitiveReferences(program, "shell");
  for (const [index, schema] of schemas.entries()) validateSchema(schema, `schema[${String(index)}]`);
  const calls = workflowCalls(program);
  const phases = calls.filter((call) => call.callee.name === "phase").map((call) => literalString(call.arguments[0])).filter((phase): phase is string => phase !== undefined);
  for (const call of calls) {
    const operation = call.callee.name;
    if (operation === "agent") validateStaticAgentOptions(call.arguments[1], capabilities.modelAliases ?? {}, capabilities.knownModels ?? capabilities.models, capabilities.settingsPath);
    if (operation === "withWorktree") validateStaticWithWorktree(call, compatibility);
    if (operation === "shell") validateStaticShellOptions(call);
    if ((operation === "parallel" || operation === "pipeline") && call.arguments.some((argument) => argument.type === "SpreadElement")) continue;
    if (operation === "checkpoint" && stableName(call.arguments[0]) === false) fail("INVALID_METADATA", `${operation} requires a stable explicit name`);
    if (operation === "parallel" && (call.arguments.length !== 2 || !literalString(call.arguments[0])?.trim() || call.arguments[1]?.type !== "ObjectExpression")) fail("INVALID_METADATA", "parallel requires an operation name string and tasks record");
    if (operation === "pipeline" && (call.arguments.length !== 3 || !literalString(call.arguments[0])?.trim() || call.arguments[1]?.type !== "ObjectExpression" || call.arguments[2]?.type !== "ObjectExpression")) fail("INVALID_METADATA", "pipeline requires an operation name string, items record, and stages record");
  }
  const agentCalls = calls.filter((call) => call.callee.name === "agent");
  const dynamicAgentRoles = agentCalls.some((call) => hasDynamicAgentRole(call.arguments[1]));
  const staticSchemas = agentCalls.flatMap((call) => { const value = staticValue(propertyNode(call.arguments[1], "outputSchema")); return value.known ? [value.value] : []; });
  for (const [index, schema] of staticSchemas.entries()) validateSchema(schema, `agent outputSchema[${String(index)}]`);
  const checkedSchemas = [...schemas, ...staticSchemas];
  const modelRefs = agentCalls.flatMap((call) => { const requested = literalString(propertyNode(call.arguments[1], "model")); return requested === undefined ? [] : [{ requested, resolved: modelCapability(requested, capabilities.modelAliases, capabilities.knownModels ?? capabilities.models, capabilities.settingsPath) }]; });
  const models = modelRefs.map(({ resolved }) => resolved);
  const tools = agentCalls.flatMap((call) => {
    const value = propertyNode(call.arguments[1], "tools");
    return value?.type === "ArrayExpression" ? value.elements.flatMap((element) => { const tool = element && element.type !== "SpreadElement" ? literalString(element) : undefined; return tool === undefined ? [] : [tool]; }) : [];
  });
  const agentTypes = agentCalls.flatMap((call) => { const value = literalString(propertyNode(call.arguments[1], "role")); return value === undefined ? [] : [value]; });
  const missingModel = capabilities.skipModelAvailability ? undefined : modelRefs.find(({ resolved }) => !capabilities.models.has(resolved));
  if (missingModel) {
    if (modelAliasName(missingModel.requested, capabilities.modelAliases ?? {})) unknownModel(missingModel.requested, missingModel.resolved, capabilities.settingsPath);
    fail("UNKNOWN_MODEL", `Unknown model: ${missingModel.resolved}`);
  }
  const missingTool = tools.find((tool) => !capabilities.tools.has(tool));
  if (missingTool) fail("UNKNOWN_TOOL", `Unknown tool: ${missingTool}`);
  const missingType = agentTypes.find((type) => !capabilities.agentTypes.has(type));
  if (missingType) fail("UNKNOWN_AGENT_TYPE", `Unknown agent type: ${missingType}`);
  return Object.freeze({ metadata: deepFreeze(checkedMetadata), referenced: deepFreeze({ phases, models, tools, agentTypes }), schemas: deepFreeze(checkedSchemas) as readonly JsonSchema[], dynamicAgentRoles });
}



function functionLaunchScript(name: string): string { return `return await ${name}(args);`; }

export function validateWorkflowLaunch(params: WorkflowValidationParameters, context: WorkflowValidationContext, registry?: WorkflowRegistryApi): ValidatedWorkflowLaunch {
  return validateWorkflowLaunchWithRegistry(params, context, registry);
}
export function validateWorkflowLaunchWithRegistry(params: WorkflowValidationParameters, context: WorkflowValidationContext, registry?: WorkflowRegistryApi): ValidatedWorkflowLaunch {
  if (Object.prototype.hasOwnProperty.call(params, "maxAgentLaunches")) fail("INVALID_METADATA", "maxAgentLaunches has been removed; use budget.agentLaunches");
  if (params.script !== undefined && params.workflow !== undefined) fail("INVALID_METADATA", "Provide either script or workflow, not both");
  const functionName = typeof params.workflow === "string" ? params.workflow : undefined;
  const workflowName = functionName ?? (typeof params.name === "string" ? params.name.trim() : "");
  if (functionName === undefined && !workflowName) fail("INVALID_METADATA", "Inline workflow launches require a non-empty name");
  const fn = functionName === undefined ? undefined : registry?.function(functionName);
  if (functionName !== undefined && !registry) fail("MISSING_WORKFLOW", `Registered function is unavailable: ${functionName}`);
  const args = params.args === undefined ? null : params.args;
  if (functionName !== undefined && fn && (!object(args) || !jsonValue(args) || !Value.Check(fn.input, args))) fail("RESULT_INVALID", `Invalid input for ${functionName}`);
  const script = functionName !== undefined && fn ? functionLaunchScript(functionName) : typeof params.script === "string" && params.script.trim() ? params.script : "";
  if (!script) fail("INVALID_SYNTAX", "Provide script or registered function");
  const metadata = validateWorkflowMetadata({ name: workflowName, ...(typeof params.description === "string" ? { description: params.description } : fn?.description ? { description: fn.description } : {}) });
  const globalAgentDefinitions = loadAgentDefinitions(context.cwd, context.agentDir, false);
  const projectAgentDefinitions = context.projectTrusted ? readRoleDefinitions(projectRoleDirectories(join(context.cwd, ".pi"))) : {};
  const agentDefinitions = deepFreeze({ ...globalAgentDefinitions, ...projectAgentDefinitions });
  const aliases = context.modelAliases ?? {};
  const knownModels = context.knownModels ?? context.availableModels;
  const checked = preflight(script, { models: context.availableModels, tools: context.rootTools, agentTypes: new Set(Object.keys(agentDefinitions)), modelAliases: aliases, knownModels, ...(context.settingsPath ? { settingsPath: context.settingsPath } : {}) }, [], metadata);
  const roleNames = checked.dynamicAgentRoles ? Object.keys(agentDefinitions) : checked.referenced.agentTypes;
  validateRolePolicies(agentDefinitions, roleNames, context.availableModels, context.rootTools, aliases, knownModels, context.settingsPath);
  return { script, checked, agentDefinitions, projectAgentDefinitions, roleNames, ...(functionName ? { functionName } : {}) };
}



export function launchScriptForSnapshot(snapshot: Readonly<LaunchSnapshot>, registry: WorkflowRegistryApi): string {
  if (snapshot.launchKind === "function") {
    if (!snapshot.functionName) fail("RESUME_INCOMPATIBLE", "Persisted registered function launch is missing its function name");
    try { registry.function(snapshot.functionName); } catch (error) { if (error instanceof WorkflowError && error.code === "MISSING_WORKFLOW") throw new WorkflowError("RESUME_INCOMPATIBLE", `Persisted registered function is unavailable: ${snapshot.functionName}`); throw error; }
    return functionLaunchScript(snapshot.functionName);
  }
  if (snapshot.launchKind === "inline") return snapshot.script;
  fail("RESUME_INCOMPATIBLE", "This persisted run uses the removed registered-workflow format; launch it again as a registered function or inline script");
}

export { createLaunchSnapshot, loadLaunchSnapshot } from "./utils.js";
