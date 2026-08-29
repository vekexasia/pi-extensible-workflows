import { atomicWriteFile } from "./persistence.js";
import { mkdirSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as acorn from "acorn";
import { Script } from "node:vm";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, AgentResourceSelectors, AgentResourceSelectorSet, AgentResourcePolicy, CheckpointInput, ContextFileScope, JsonSchema, JsonValue, PreflightCapabilities, PreflightResult, ShellOptions, StaticWorkflowCall, StaticWorkflowExecution, StaticWorkflowScope, ValidatedWorkflowLaunch, WorkflowCallKind, WorkflowErrorCode, WorkflowExtensionMetadata, WorkflowExtensionSettings, WorkflowMetadata, WorkflowRetentionSettings, WorkflowRoleDirectoryRegistration, WorkflowSettings, WorkflowSettingsOverrides, WorkflowSettingsResolution, WorkflowSettingsSources, WorkflowValidationContext, WorkflowValidationParameters } from "./types.js";
import type { WorkflowRegistryApi } from "./registry.js";
import { registeredWorkflowRoleDirectoryRegistrations } from "./registry.js";
import { annotateModelAliasError, assertModelThinking, deepFreeze, errorText, fail, isNodeError, jsonObject, jsonValue, modelAliasName, modelCapability, object, positiveInteger, resolveModelReference, resourcePatternHasMagic, unknownModel, validateModelAliases, validateResourcePattern } from "./utils.js";
import { WORKFLOW_CALL_KINDS } from "./types.js";

export const DEFAULT_SETTINGS: Readonly<WorkflowSettings> = Object.freeze({ concurrency: 8, backgroundWidget: true });
export function validateCheckpoint(value: unknown): CheckpointInput {
  if (!object(value) || Object.keys(value).some((key) => !["name", "prompt", "context"].includes(key)) || typeof value.name !== "string" || value.name.trim() === "" || typeof value.prompt !== "string" || !jsonValue(value.context)) fail("INVALID_METADATA", "checkpoint requires only name, prompt, and JSON context");
  if (Buffer.byteLength(value.prompt) > 1024) fail("INVALID_METADATA", "checkpoint prompt exceeds 1024 UTF-8 bytes");
  if (Buffer.byteLength(JSON.stringify(value.context)) > 4096) fail("INVALID_METADATA", "checkpoint context exceeds 4096 UTF-8 bytes");
  return { name: value.name, prompt: value.prompt, context: value.context };
}

export function workflowSettingsPath(agentDir = getAgentDir()): string { return join(agentDir, ROLE_DIRECTORY, "settings.json"); }
export function workflowProjectSettingsPath(cwd: string): string { return join(cwd, ".pi", ROLE_DIRECTORY, "settings.json"); }
function normalizedResourcePath(value: string, settingsPath: string): string {
  if (value === "*") return value;
  let expanded = value === "~" ? homedir() : value.startsWith("~/") || value.startsWith("~\\") ? join(homedir(), value.slice(2)) : value;
  if (expanded.startsWith("file://")) expanded = fileURLToPath(expanded);
  const resolved = resolve(dirname(settingsPath), expanded);
  if (expanded === "**" || expanded.startsWith("**/") || expanded.startsWith("**\\")) return expanded;
  if (resourcePatternHasMagic(expanded)) {
    const magicIndex = resolved.search(/[*?\x5b\x5d{}()]/);
    const separatorIndex = Math.max(resolved.lastIndexOf("/", magicIndex), resolved.lastIndexOf("\\", magicIndex));
    const rootBoundary = separatorIndex === 0 || (separatorIndex === 2 && /^[A-Za-z]:[\\/]/.test(resolved));
    const prefix = rootBoundary ? resolved.slice(0, separatorIndex + 1) : separatorIndex >= 0 ? resolved.slice(0, separatorIndex) : resolved;
    const suffix = rootBoundary ? resolved.slice(separatorIndex + 1) : separatorIndex >= 0 ? resolved.slice(separatorIndex) : "";
    try { return `${realpathSync(prefix)}${suffix}`; } catch { return resolved; }
  }
  try { return realpathSync(resolved); } catch { return resolved; }
}
function validateSelectorList(value: unknown, path: string, kind: "skills" | "extensions" | "tools", errorCode: "INVALID_SETTINGS" | "INVALID_METADATA" = "INVALID_SETTINGS", normalizeExtensions = true): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) fail(errorCode, `${path}.${kind} must be an array`);
  const normalized: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !entry.trim()) fail(errorCode, `${path}.${kind}[${String(index)}] must be a non-empty string`);
    let selector = entry.trim();
    if (kind === "extensions" && normalizeExtensions) {
      const negated = selector.startsWith("!");
      const body = negated ? selector.slice(1) : selector;
      if (!body) fail(errorCode, `${path}.${kind}[${String(index)}] must be a valid minimatch pattern: Empty minimatch pattern ${JSON.stringify(selector)}`);
      try { selector = `${negated ? "!" : ""}${normalizedResourcePath(body, path)}`; } catch (error) { fail(errorCode, `${path}.${kind}[${String(index)}] must be a valid path: ${errorText(error)}`); }
    }
    try { validateResourcePattern(selector); } catch (error) { fail(errorCode, `${path}.${kind}[${String(index)}] must be a valid minimatch pattern: ${errorText(error)}`); }
    normalized.push(selector);
  }
  return Object.freeze(normalized);
}
function selectorsFromSettings(settings: Readonly<WorkflowSettings | WorkflowSettingsOverrides>): AgentResourceSelectors {
  return {
    ...(settings.skills === undefined ? {} : { skills: settings.skills }),
    ...(settings.extensions === undefined ? {} : { extensions: settings.extensions }),
    ...(settings.tools === undefined ? {} : { tools: settings.tools }),
  };
}
function selectorSet(value: AgentResourceSelectors | undefined): AgentResourceSelectorSet { return { skills: [...(value?.skills ?? [])], extensions: [...(value?.extensions ?? [])], ...(value?.tools === undefined ? {} : { tools: [...value.tools] }) }; }
const CONTEXT_FILE_SCOPES = ["global", "project", "cwd"] as const;
function isContextFileScope(value: unknown): value is ContextFileScope { return CONTEXT_FILE_SCOPES.some((scope) => scope === value); }
function validateContextFileScopes(value: unknown, rolePath: string): readonly ContextFileScope[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((scope) => !isContextFileScope(scope))) fail("INVALID_METADATA", `${rolePath}.contextFiles must be an array containing only global, project, or cwd`);
  return value.map((scope) => {
    if (!isContextFileScope(scope)) fail("INVALID_METADATA", `${rolePath}.contextFiles must be an array containing only global, project, or cwd`);
    return scope;
  });
}
function validateWorkflowExtensions(value: unknown, settingsPath: string, errorCode: "INVALID_SETTINGS" | "INVALID_METADATA" = "INVALID_SETTINGS"): WorkflowExtensionSettings | undefined {
  if (value === undefined) return undefined;
  const base = `${settingsPath}.extensionSettings`;
  if (!object(value)) fail(errorCode, `${base} must be an object`);
  if (Object.keys(value).some((key) => key !== "herdr" && key !== "trajectory")) fail(errorCode, `${base} contains an unsupported extension setting`);
  const herdr = value.herdr === undefined ? undefined : (() => {
    if (!object(value.herdr)) fail(errorCode, `${base}.herdr must be an object`);
    if (Object.keys(value.herdr).some((key) => key !== "enableFullyInspectableMode")) fail(errorCode, `${base}.herdr contains an unsupported setting`);
    if (value.herdr.enableFullyInspectableMode !== undefined && typeof value.herdr.enableFullyInspectableMode !== "boolean") fail(errorCode, `${base}.herdr.enableFullyInspectableMode must be a boolean`);
    return Object.freeze({ ...(value.herdr.enableFullyInspectableMode === undefined ? {} : { enableFullyInspectableMode: value.herdr.enableFullyInspectableMode }) });
  })();
  const trajectory = value.trajectory === undefined ? undefined : (() => {
    if (!object(value.trajectory)) fail(errorCode, `${base}.trajectory must be an object`);
    if (Object.keys(value.trajectory).some((key) => key !== "port" && key !== "themes")) fail(errorCode, `${base}.trajectory contains an unsupported setting`);
    if (value.trajectory.port !== undefined && (!positiveInteger(value.trajectory.port) || value.trajectory.port > 65535)) fail(errorCode, `${base}.trajectory.port must be an integer from 1 to 65535`);
    if (value.trajectory.themes !== undefined && typeof value.trajectory.themes !== "boolean") fail(errorCode, `${base}.trajectory.themes must be a boolean`);
    return Object.freeze({ ...(value.trajectory.port === undefined ? {} : { port: value.trajectory.port }), themes: value.trajectory.themes ?? false });
  })();
  return Object.freeze({ ...(herdr === undefined ? {} : { herdr }), ...(trajectory === undefined ? {} : { trajectory }) });
}
function positiveRetentionInteger(value: unknown): value is number { return positiveInteger(value) && Number.isSafeInteger(value); }
function validateRetention(value: unknown, settingsPath: string): Readonly<WorkflowRetentionSettings> | undefined {
  if (value === undefined) return undefined;
  const base = `${settingsPath}.retention`;
  if (!object(value)) fail("INVALID_SETTINGS", `${base} must be an object`);
  const unknown = Object.keys(value).find((key) => key !== "olderThanDays" && key !== "maxTerminalRuns");
  if (unknown) fail("INVALID_SETTINGS", `Unknown retention setting at ${base}: ${unknown}`);
  if (value.olderThanDays !== undefined && !positiveRetentionInteger(value.olderThanDays)) fail("INVALID_SETTINGS", `${base}.olderThanDays must be a positive integer`);
  if (value.maxTerminalRuns !== undefined && !positiveRetentionInteger(value.maxTerminalRuns)) fail("INVALID_SETTINGS", `${base}.maxTerminalRuns must be a positive integer`);
  return Object.freeze({ ...(value.olderThanDays === undefined ? {} : { olderThanDays: value.olderThanDays }), ...(value.maxTerminalRuns === undefined ? {} : { maxTerminalRuns: value.maxTerminalRuns }) });
}
function parseSettings(path: string, partial: false): Readonly<WorkflowSettings>;
function parseSettings(path: string, partial: true): Readonly<WorkflowSettingsOverrides>;
function parseSettings(path: string, partial: boolean): Readonly<WorkflowSettings | WorkflowSettingsOverrides> {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) {
    if (isNodeError(error, "ENOENT")) return partial ? Object.freeze({}) : DEFAULT_SETTINGS;
    fail("CONFIG_ERROR", `Invalid workflow settings JSON at ${path}: ${errorText(error)}`);
  }
  if (!object(parsed)) fail("INVALID_SETTINGS", `Workflow settings at ${path} must be an object`);
  const allowed = new Set(["concurrency", "modelAliases", "skills", "extensions", "extensionSettings", "tools", "retention", ...(partial ? [] : ["backgroundWidget"]) ]);
  const unknown = Object.keys(parsed).find((key) => !allowed.has(key));
  if (Object.prototype.hasOwnProperty.call(parsed, "disabledAgentResources")) fail("INVALID_SETTINGS", `disabledAgentResources is no longer supported; use skills, extensions, and tools selectors (settings: ${path})`);
  if (unknown) fail("INVALID_SETTINGS", `Unknown workflow setting at ${path}: ${unknown}`);
  const concurrency = parsed.concurrency === undefined ? (partial ? undefined : DEFAULT_SETTINGS.concurrency) : parsed.concurrency;
  if (concurrency !== undefined && (!positiveInteger(concurrency) || concurrency > 16)) fail("INVALID_SETTINGS", `${path}.concurrency must be an integer from 1 to 16`);
  const backgroundWidget = parsed.backgroundWidget === undefined ? (partial ? undefined : DEFAULT_SETTINGS.backgroundWidget) : parsed.backgroundWidget;
  if (backgroundWidget !== undefined && typeof backgroundWidget !== "boolean") fail("INVALID_SETTINGS", `${path}.backgroundWidget must be a boolean`);
  const modelAliases = parsed.modelAliases === undefined ? undefined : validateModelAliases(parsed.modelAliases, path);
  const skills = validateSelectorList(parsed.skills, path, "skills");
  const tools = validateSelectorList(parsed.tools, path, "tools");
  const extensions = validateSelectorList(parsed.extensions, path, "extensions");
  const extensionSettings = parsed.extensionSettings === undefined ? undefined : validateWorkflowExtensions(parsed.extensionSettings, path);
  const retention = validateRetention(parsed.retention, path);
  return Object.freeze({
    ...(concurrency === undefined ? {} : { concurrency }), ...(backgroundWidget === undefined ? {} : { backgroundWidget }), ...(modelAliases === undefined ? {} : { modelAliases }),
    ...(skills === undefined ? {} : { skills }), ...(extensions === undefined ? {} : { extensions }),
    ...(extensionSettings === undefined ? {} : { extensionSettings }), ...(tools === undefined ? {} : { tools }), ...(retention === undefined ? {} : { retention }),
  });
}
export function loadSettings(path = workflowSettingsPath()): Readonly<WorkflowSettings> { return parseSettings(path, false); }
export function loadSettingsOverrides(path: string): Readonly<WorkflowSettingsOverrides> { return parseSettings(path, true); }
export function resolveWorkflowSettings(cwd: string, projectTrusted: boolean, globalSettingsPath = workflowSettingsPath()): WorkflowSettingsResolution {
  const projectSettingsPath = workflowProjectSettingsPath(cwd);
  const global = loadSettings(globalSettingsPath);
  const project: Readonly<WorkflowSettingsOverrides> = projectTrusted ? loadSettingsOverrides(projectSettingsPath) : Object.freeze({});
  const projectHas = (key: keyof WorkflowSettingsOverrides): boolean => Object.prototype.hasOwnProperty.call(project, key);
  const sourceFor = (key: "skills" | "extensions" | "tools"): string => projectHas(key) ? projectSettingsPath : globalSettingsPath;
  const globalSelectors = selectorsFromSettings(global);
  const projectSelectors = selectorsFromSettings(project);
  const effectiveSelectors = selectorSet({
    skills: [...(globalSelectors.skills ?? []), ...(projectSelectors.skills ?? [])],
    extensions: [...(globalSelectors.extensions ?? []), ...(projectSelectors.extensions ?? [])],
    ...(globalSelectors.tools === undefined && projectSelectors.tools === undefined ? {} : { tools: [...(globalSelectors.tools ?? []), ...(projectSelectors.tools ?? [])] }),
  });
  const hasExtensionSelectors = global.extensions !== undefined || project.extensions !== undefined;
  const configuredExtensionSettings = projectHas("extensionSettings") ? project.extensionSettings : global.extensionSettings;
  const extensionSettings = configuredExtensionSettings;
  const sources: WorkflowSettingsSources = {
    concurrency: projectHas("concurrency") ? projectSettingsPath : globalSettingsPath,
    modelAliases: projectHas("modelAliases") ? projectSettingsPath : globalSettingsPath,
    skills: sourceFor("skills"), extensions: sourceFor("extensions"), tools: sourceFor("tools"),
    ...(extensionSettings === undefined ? {} : { extensionSettings: projectHas("extensionSettings") ? projectSettingsPath : globalSettingsPath }),
    ...(project.retention === undefined && global.retention === undefined ? {} : { retention: project.retention === undefined ? globalSettingsPath : projectSettingsPath }),
  };
  const effective = Object.freeze({
    concurrency: project.concurrency ?? global.concurrency,
    backgroundWidget: global.backgroundWidget ?? true,
    ...(projectHas("modelAliases") ? { modelAliases: project.modelAliases } : global.modelAliases === undefined ? {} : { modelAliases: global.modelAliases }),
    ...(effectiveSelectors.skills.length ? { skills: effectiveSelectors.skills } : global.skills !== undefined || project.skills !== undefined ? { skills: effectiveSelectors.skills } : {}),
    ...(hasExtensionSelectors ? { extensions: effectiveSelectors.extensions } : {}),
    ...(extensionSettings === undefined ? {} : { extensionSettings }),
    ...(effectiveSelectors.tools?.length ? { tools: effectiveSelectors.tools } : global.tools !== undefined || project.tools !== undefined ? { tools: effectiveSelectors.tools } : {}),
    ...((project.retention ?? global.retention) === undefined ? {} : { retention: project.retention ?? global.retention }),
  });
  return { globalSettingsPath, projectSettingsPath, projectTrusted, global, project, effective, sources };
}
export function validateModelAliasAvailability(aliases: Readonly<Record<string, string>>, names: readonly string[], availableModels: ReadonlySet<string>, knownModels: ReadonlySet<string>, settingsPath?: string): void {
  for (const name of names) {
    try {
      const target = modelCapability(name, aliases, knownModels, settingsPath);
      if (!availableModels.has(target)) unknownModel(name, target, settingsPath);
    } catch (error) { throw annotateModelAliasError(error, name); }
  }
}
export function resolveAgentResourcePolicy(cwd: string, projectTrusted: boolean, globalSettingsPath = workflowSettingsPath()): AgentResourcePolicy {
  const resolved = resolveWorkflowSettings(cwd, projectTrusted, globalSettingsPath);
  const global = selectorSet(selectorsFromSettings(resolved.global));
  const project = selectorSet(selectorsFromSettings(resolved.project));
  const effective = selectorSet(selectorsFromSettings(resolved.effective));
  return { globalSettingsPath: resolved.globalSettingsPath, projectSettingsPath: resolved.projectSettingsPath, projectTrusted, global, project, effective, unmatchedSkills: [], unmatchedExtensions: [], unmatchedTools: [], selectorSources: { global: selectorsFromSettings(resolved.global), project: selectorsFromSettings(resolved.project) } };
}
export function saveModelAliases(path = workflowSettingsPath(), aliases: Readonly<Record<string, string>> = {}): void {
  const normalized = validateModelAliases(aliases, path);
  let parsed: unknown = {};
  try {
    loadSettings(path);
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  if (!object(parsed)) fail("INVALID_SETTINGS", `Workflow settings at ${path} must be an object`);
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
      const match = /^(model|tools|skills|extensions|description|overrideSystemPrompt|override_system_prompt|is_system_prompt|contextFiles|disabledAgentResources|thinking)\s*:\s*(.+)$/.exec(line.trim());
      if (match?.[1] === "disabledAgentResources") fail("INVALID_METADATA", "disabledAgentResources is no longer supported; use skills, extensions, and tools selectors");
      if (match?.[1] === "thinking") fail("INVALID_METADATA", "Role thinking is not supported; put it on model as provider/model:thinking");
      if (match?.[1] && match[2]) meta[match[1]] = match[2].trim();
    }
    const unquote = (v: string) => v.replace(/^['"]|['"]$/g, "");
    const parseList = (value: string | undefined): string[] | undefined => value === undefined ? undefined : value.replace(/^\[|\]$/g, "").split(",").map((entry) => unquote(entry.trim())).filter(Boolean);
    const tools = parseList(meta.tools);
    const skills = parseList(meta.skills);
    const extensions = parseList(meta.extensions);
    const definition: AgentDefinition = { prompt: content.slice(end + 4).replace(/^\n/, "") };
    if (meta.model) {
      const model = unquote(meta.model);
      assertModelThinking(model, "Role model");
      definition.model = model;
    }
    if (meta.description) definition.description = unquote(meta.description);
    if (tools) definition.tools = tools;
    if (skills) definition.skills = skills;
    if (extensions) definition.extensions = extensions;
    const overrideSystemPrompt = meta.overrideSystemPrompt ?? meta.override_system_prompt ?? meta.is_system_prompt;
    const contextFiles = meta.contextFiles ? meta.contextFiles.replace(/^\[|\]$/g, "").split(",").map((scope) => unquote(scope.trim())).filter(Boolean) : undefined;
    const normalizedContextFiles = validateContextFileScopes(contextFiles, "role");
    if (overrideSystemPrompt) definition.overrideSystemPrompt = overrideSystemPrompt === "true";
    if (normalizedContextFiles) definition.contextFiles = normalizedContextFiles;
    return definition;
  }
  const normalized = content.replace(/\r\n?/g, "\n");
  if (normalized.startsWith("---\n") && normalized.indexOf("\n---", 3) < 0) fail("INVALID_METADATA", "Role frontmatter is missing its closing delimiter");
  let parsed: ReturnType<typeof parseFrontmatter>;
  try { parsed = parseFrontmatter(content); }
  catch (error) { fail("INVALID_METADATA", `Invalid role frontmatter: ${errorText(error)}`); }
  if (!object(parsed.frontmatter)) fail("INVALID_METADATA", "Role frontmatter must be an object");
  const { model, tools, skills, extensions, description, contextFiles } = parsed.frontmatter;
  if (Object.prototype.hasOwnProperty.call(parsed.frontmatter, "disabledAgentResources")) fail("INVALID_METADATA", "disabledAgentResources is no longer supported; use skills, extensions, and tools selectors");
  if (Object.prototype.hasOwnProperty.call(parsed.frontmatter, "thinking")) fail("INVALID_METADATA", "Role thinking is not supported; put it on model as provider/model:thinking");
  const overrideSystemPrompt = parsed.frontmatter.overrideSystemPrompt ?? parsed.frontmatter.override_system_prompt ?? parsed.frontmatter.is_system_prompt;
  if (model !== undefined && (typeof model !== "string" || model.trim() === "")) fail("INVALID_METADATA", "Role model must be a non-empty string");
  if (description !== undefined && (typeof description !== "string" || description.trim() === "" || description.length > 1024 || /[\r\n]/.test(description))) fail("INVALID_METADATA", "Role description must be a non-empty single-line string of at most 1024 characters");
  if (overrideSystemPrompt !== undefined && typeof overrideSystemPrompt !== "boolean") fail("INVALID_METADATA", "Role overrideSystemPrompt must be a boolean");
  const normalizedContextFiles = validateContextFileScopes(contextFiles, rolePath ?? "<role>");
  const rolePathValue = rolePath ?? "<role>";
  const normalizedTools = validateSelectorList(tools, rolePathValue, "tools", "INVALID_METADATA");
  const normalizedSkills = validateSelectorList(skills, rolePathValue, "skills", "INVALID_METADATA");
  const normalizedExtensions = validateSelectorList(extensions, rolePathValue, "extensions", "INVALID_METADATA");
  const normalizedDescription = typeof description === "string" ? description.trim() : undefined;
  const normalizedModel = typeof model === "string" ? model.trim() : undefined;
  if (normalizedModel !== undefined) assertModelThinking(normalizedModel, "Role model");
  const definition: AgentDefinition = { prompt: parsed.body };
  if (normalizedDescription !== undefined) definition.description = normalizedDescription;
  if (normalizedModel !== undefined) definition.model = normalizedModel;
  if (normalizedTools !== undefined) definition.tools = normalizedTools;
  if (normalizedSkills !== undefined) definition.skills = normalizedSkills;
  if (normalizedExtensions !== undefined) definition.extensions = normalizedExtensions;
  if (typeof overrideSystemPrompt === "boolean") definition.overrideSystemPrompt = overrideSystemPrompt;
  if (normalizedContextFiles !== undefined) definition.contextFiles = normalizedContextFiles;
  return definition;
}

const ROLE_DIRECTORY = "pi-extensible-workflows";

export function workflowRoleDirectories(agentDir = getAgentDir()): readonly string[] {
  return [join(agentDir, ROLE_DIRECTORY, "roles")];
}

function projectRoleDirectories(root: string): readonly string[] {
  return [join(root, ROLE_DIRECTORY, "roles")];
}

type RoleDirectorySource = { path: string; extension?: WorkflowExtensionMetadata };
export type WorkflowRoleDirectoryInput = string | WorkflowRoleDirectoryRegistration;
type RoleFile = { name: string; path: string; source: RoleDirectorySource };
function roleDirectorySources(dirs: readonly WorkflowRoleDirectoryInput[]): RoleDirectorySource[] {
  const seen = new Set<string>();
  return dirs.flatMap((value) => {
    const source = typeof value === "string" ? { path: value } : { path: value.path, extension: value.extension };
    if (seen.has(source.path)) return [];
    seen.add(source.path);
    return [source];
  });
}
function roleDirectoryLabel(source: RoleDirectorySource, extension = true): string {
  return source.extension ? `Extension "${source.extension.headline}" (${source.extension.version})` : extension ? "Registered workflow extension" : "Standard workflow";
}
function isRoleFile(dir: string, entry: import("node:fs").Dirent): boolean {
  if (extname(entry.name) !== ".md") return false;
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return statSync(join(dir, entry.name)).isFile(); }
  catch (error) { if (isNodeError(error, "ENOENT")) return false; throw error; }
}
function scanRoleFiles(dirs: readonly WorkflowRoleDirectoryInput[], extension: boolean): RoleFile[] {
  const files: RoleFile[] = [];
  for (const source of roleDirectorySources(dirs)) {
    let entries: import("node:fs").Dirent[];
    try { entries = readdirSync(source.path, { withFileTypes: true }); }
    catch (error) {
      if (!extension && isNodeError(error, "ENOENT")) continue;
      fail("INVALID_METADATA", `${roleDirectoryLabel(source, extension)} role directory "${source.path}" could not be scanned: ${errorText(error)}`);
    }
    for (const entry of entries) if (isRoleFile(source.path, entry)) files.push({ name: basename(entry.name, ".md"), path: join(source.path, entry.name), source });
  }
  return files.sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
}
function readRoleDefinitions(dirs: readonly WorkflowRoleDirectoryInput[], extension = false): Record<string, AgentDefinition> {
  const files = scanRoleFiles(dirs, extension);
  if (extension) {
    const byName = new Map<string, RoleFile[]>();
    for (const file of files) byName.set(file.name, [...(byName.get(file.name) ?? []), file]);
    for (const [name, matches] of byName) if (matches.length > 1) fail("INVALID_METADATA", `Duplicate extension role "${name}": ${matches.map(({ path, source }) => `${roleDirectoryLabel(source)} role directory "${source.path}" (${path})`).join("; ")}`);
  }
  return Object.fromEntries(files.map(({ name, path, source }) => {
    try { return [name, parseRoleMarkdown(readFileSync(path, "utf8"), true, path)]; }
    catch (error) {
      if (extension) fail("INVALID_METADATA", `${roleDirectoryLabel(source)} role directory "${source.path}" contains invalid role "${name}" at "${path}": ${errorText(error)}`);
      throw error;
    }
  }));
}
export function loadAgentDefinitions(cwd: string, agentDir = getAgentDir(), projectTrusted = true, extensionRoleDirectories: readonly WorkflowRoleDirectoryInput[] = registeredWorkflowRoleDirectoryRegistrations()): Readonly<Record<string, AgentDefinition>> {
  return deepFreeze({ ...readRoleDefinitions(extensionRoleDirectories, true), ...readRoleDefinitions(workflowRoleDirectories(agentDir)), ...(projectTrusted ? readRoleDefinitions(projectRoleDirectories(join(cwd, ".pi"))) : {}) });
}
function validateRolePolicies(definitions: Readonly<Record<string, AgentDefinition>>, roles: readonly string[], availableModels: ReadonlySet<string>, aliases: Readonly<Record<string, string>> = {}, knownModels = availableModels, settingsPath?: string): void {
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
    // Role tools absent from the session are tolerated at launch: the runtime resolve emits a
    // warning and the agent runs without them. Doctor still reports unmatched patterns.
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

type WorkflowCall = acorn.CallExpression & { callee: acorn.Identifier & { name: WorkflowCallKind } };

function isAcornNode(value: unknown): value is acorn.AnyNode {
  return typeof value === "object" && value !== null && "type" in value && typeof value.type === "string";
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
      const key = node.key.type === "Identifier" ? node.key.name : node.key.type === "Literal" ? String(node.key.value) : undefined;
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
  return template.replace(/{{|}}|{([A-Za-z_$][\w$]*)}/g, (match, key: string | undefined) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    if (typeof key !== "string") return match;
    const value = values[key];
    return typeof value === "string" ? value : JSON.stringify(value, null, 2);
  });
}

export function validateSchema(schema: unknown, at = "schema"): asserts schema is JsonSchema {
  if (!object(schema) || Object.getPrototypeOf(schema) !== Object.prototype || !jsonValue(schema)) fail("INVALID_SCHEMA", `${at} must be a plain JSON-compatible Schema object`);
  if (typeof schema.type !== "string" && !Array.isArray(schema.type) && schema.$ref === undefined && schema.anyOf === undefined && schema.oneOf === undefined && schema.allOf === undefined && schema.const === undefined && schema.enum === undefined) fail("INVALID_SCHEMA", `${at} has no JSON Schema shape`);
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string"))) fail("INVALID_SCHEMA", `${at}.required must be an array of strings`);
  if (schema.properties !== undefined && !object(schema.properties)) fail("INVALID_SCHEMA", `${at}.properties must be an object`);
}

const AGENT_OPTION_KEYS = new Set(["label", "model", "tools", "skills", "extensions", "contextFiles", "role", "outputSchema", "retries", "timeoutMs"]);
function validateAgentOption(key: string, value: unknown, aliases?: Readonly<Record<string, string>>, knownModels?: ReadonlySet<string>, settingsPath?: string): void {
  switch (key) {
    case "label":
      if (typeof value !== "string" || !value.trim()) fail("INVALID_METADATA", "agent label must be a non-empty string");
      break;
    case "model":
      if (typeof value !== "string" || !value.trim()) fail("INVALID_METADATA", "agent model must be a non-empty string");
      assertModelThinking(value, "agent model");
      if (aliases !== undefined) resolveModelReference(value, aliases, knownModels, settingsPath);
      break;
    case "tools":
    case "skills":
    case "extensions":
      validateSelectorList(value, "agent options", key, "INVALID_METADATA", key !== "extensions");
      break;
    case "contextFiles":
      validateContextFileScopes(value, "agent options");
      break;
    case "role":
      if (typeof value !== "string" || !value.trim()) fail("INVALID_METADATA", "agent role must be a non-empty string");
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

function staticRoleName(node: acorn.AnyNode | undefined): string | null {
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
        const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
        return key ? [key] : [];
      }) : [];
      const knownOptionEntries: Array<[string, JsonValue]> = [];
      for (const key of optionKeys) {
        const value = staticValue(propertyNode(options, key));
        if (value.known && jsonValue(value.value)) knownOptionEntries.push([key, value.value]);
      }
      const knownOptions: Record<string, JsonValue> = Object.fromEntries(knownOptionEntries);
      const base = { ...placement, kind, start: call.start, end: call.end, name: null, prompt: staticString(first), model: staticString(propertyNode(options, "model")), label: staticString(propertyNode(options, "label")), role: staticRoleName(propertyNode(options, "role")) };
      return { ...base, ...(retries.known && typeof retries.value === "number" ? { retries: retries.value } : {}), ...(staticOutputSchema === undefined ? {} : { outputSchema: staticOutputSchema }), ...(optionKeys.length ? { options: knownOptions, optionKeys } : {}) };
    }
    if (kind === "checkpoint") return { ...placement, kind, start: call.start, end: call.end, name: staticString(propertyNode(first, "name")), prompt: staticString(propertyNode(first, "prompt")), model: null, role: null };
    if (kind === "shell") return { ...placement, kind, start: call.start, end: call.end, name: staticString(first), prompt: null, model: null, role: null };
    return { ...placement, kind, start: call.start, end: call.end, name: staticString(first), prompt: null, model: null, role: null };
  });
}

function validateStaticAgentOptions(node: acorn.AnyNode | undefined, aliases: Readonly<Record<string, string>> = {}, knownModels?: ReadonlySet<string>, settingsPath?: string): void {
  if (node?.type !== "ObjectExpression") return;
  for (const key of AGENT_OPTION_KEYS) {
    const value = staticValue(propertyNode(node, key));
    if (value.known) validateAgentOption(key, value.value, aliases, knownModels, settingsPath);
  }
}
function hasDynamicAgentRole(node: acorn.AnyNode | undefined): boolean {
  if (!node) return false;
  if (node.type !== "ObjectExpression") return true;
  for (let index = node.properties.length - 1; index >= 0; index -= 1) {
    const property = node.properties[index];
    if (!property || property.type === "SpreadElement" || property.computed) return true;
    const key = property.key.type === "Identifier" ? property.key.name : property.key.type === "Literal" ? String(property.key.value) : undefined;
    if (key === "role") {
      const roleValue = staticValue(property.value);
      if (roleValue.known && typeof roleValue.value === "string") return false;
      return true;
    }
  }
  return false;
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
  if (hasIdentifier(program, INTERNAL_AGENT_NAME)) fail("INVALID_METADATA", `${INTERNAL_AGENT_NAME} is reserved for workflow agent instrumentation`);
  if (hasIdentifier(program, INTERNAL_WORKTREE_NAME)) fail("INVALID_METADATA", `${INTERNAL_WORKTREE_NAME} is reserved for workflow withWorktree instrumentation`);
  if (hasIdentifier(program, INTERNAL_SHELL_NAME)) fail("INVALID_METADATA", `${INTERNAL_SHELL_NAME} is reserved for workflow shell instrumentation`);
  validateDirectPrimitiveReferences(program, "withWorktree");
  validateRemovedWorkflowPrimitives(program, compatibility ? "RESUME_INCOMPATIBLE" : "INVALID_METADATA");
  validateDirectPrimitiveReferences(program, "shell");
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
  const staticSchemas: JsonSchema[] = [];
  for (const call of agentCalls) {
    const value = staticValue(propertyNode(call.arguments[1], "outputSchema"));
    if (!value.known) continue;
    const schema = value.value;
    validateSchema(schema, `agent outputSchema[${String(staticSchemas.length)}]`);
    staticSchemas.push(schema);
  }
  checkedSchemas.push(...staticSchemas);
  const modelRefs = agentCalls.flatMap((call) => { const requested = literalString(propertyNode(call.arguments[1], "model")); return requested === undefined ? [] : [{ requested, resolved: modelCapability(requested, capabilities.modelAliases, capabilities.knownModels ?? capabilities.models, capabilities.settingsPath) }]; });
  const models = modelRefs.map(({ resolved }) => resolved);
  const tools = agentCalls.flatMap((call) => {
    const value = propertyNode(call.arguments[1], "tools");
    return value?.type === "ArrayExpression" ? value.elements.flatMap((element) => { const tool = element && element.type !== "SpreadElement" ? literalString(element) : undefined; return tool === undefined ? [] : [tool]; }) : [];
  });
  const agentTypes = agentCalls.flatMap((call) => { const value = staticRoleName(propertyNode(call.arguments[1], "role")); return value === null ? [] : [value]; });
  for (const pattern of tools) {
    const body = pattern.startsWith("!") ? pattern.slice(1) : pattern;
    if (!pattern.startsWith("!") && !resourcePatternHasMagic(pattern) && !capabilities.tools.has(body)) fail("UNKNOWN_TOOL", `Unknown tool: ${body}`);
  }
  const missingModel = capabilities.skipModelAvailability ? undefined : modelRefs.find(({ resolved }) => !capabilities.models.has(resolved));
  if (missingModel) {
    if (modelAliasName(missingModel.requested, capabilities.modelAliases ?? {})) unknownModel(missingModel.requested, missingModel.resolved, capabilities.settingsPath);
    fail("UNKNOWN_MODEL", `Unknown model: ${missingModel.resolved}`);
  }
  const missingType = agentTypes.find((type) => !capabilities.agentTypes.has(type));
  if (missingType) fail("UNKNOWN_AGENT_TYPE", `Unknown agent type: ${missingType}`);
  return Object.freeze({ metadata: deepFreeze(checkedMetadata), referenced: deepFreeze({ phases, models, tools, agentTypes }), schemas: deepFreeze(checkedSchemas), dynamicAgentRoles });
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
  const globalAgentDefinitions = loadAgentDefinitions(context.cwd, context.agentDir, false, registry && typeof registry.roleDirectoryRegistrations === "function" ? registry.roleDirectoryRegistrations() : registry && typeof registry.roleDirectories === "function" ? registry.roleDirectories() : undefined);
  const projectAgentDefinitions = context.projectTrusted ? readRoleDefinitions(projectRoleDirectories(join(context.cwd, ".pi"))) : {};
  const agentDefinitions = deepFreeze({ ...globalAgentDefinitions, ...projectAgentDefinitions });
  const aliases = context.modelAliases ?? {};
  const knownModels = context.knownModels ?? context.availableModels;
  const checked = preflight(script, { models: context.availableModels, tools: context.rootTools, agentTypes: new Set(Object.keys(agentDefinitions)), modelAliases: aliases, knownModels, ...(context.settingsPath ? { settingsPath: context.settingsPath } : {}) }, [], metadata);
  const roleNames = checked.dynamicAgentRoles ? Object.keys(agentDefinitions) : checked.referenced.agentTypes;
  validateRolePolicies(agentDefinitions, roleNames, context.availableModels, aliases, knownModels, context.settingsPath);
  return { script, checked, agentDefinitions, projectAgentDefinitions, roleNames };
}

export { createLaunchSnapshot, loadLaunchSnapshot } from "./utils.js";
