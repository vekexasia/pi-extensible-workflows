import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";
import type { AgentDefinition, AgentResourceSelectorSources, AgentResourceSelectors, ContextFileScope, ModelSpec, WorkflowExtensionMetadata, WorkflowExtensionSettings, WorkflowRoleDirectoryRegistration } from "./types.js";
import { registeredWorkflowRoleDirectoryRegistrations } from "./registry.js";
import { resolveWorkflowSettings, validateContextFileScopes, validateSelectorList, validateWorkflowExtensionSettings, workflowSettingsPath } from "./settings.js";
import { assertModelThinking, deepFreeze, object, errorText, fail, isNodeError, modelAliasName, modelCapability, resourcePatternHasMagic, resolveModelReference, selectResourcesByLayers, unmatchedResourcePatterns } from "./utils.js";
import { canonicalPath, extensionIdentity } from "./paths.js";

const ROLE_DIRECTORY = "pi-extensible-workflows";
// Preserve the role-file base when a discovered definition is resolved again through the public API.
const roleDefinitionPaths = new WeakMap<AgentDefinition, string>();

export function parseRoleMarkdown(content: string, strict = false, rolePath?: string): AgentDefinition {
  if (!strict) {
    if (!content.startsWith("---\n")) return { prompt: content };
    const end = content.indexOf("\n---", 4);
    if (end < 0) return { prompt: content };
    const meta: Record<string, string> = {};
    for (const line of content.slice(4, end).split("\n")) {
      const match = /^(model|tools|skills|extensions|description|overrideSystemPrompt|override_system_prompt|is_system_prompt|contextFiles|extensionSettings|disabledAgentResources|thinking)\s*:\s*(.+)$/.exec(line.trim());
      if (match?.[1] === "disabledAgentResources") fail("INVALID_METADATA", "disabledAgentResources is no longer supported; use skills, extensions, and tools selectors");
      if (match?.[1] === "thinking") fail("INVALID_METADATA", "Role thinking is not supported; put it on model as provider/model:thinking");
      if (match?.[1] && match[2]) meta[match[1]] = match[2].trim();
    }
    const unquote = (v: string) => v.replace(/^['"]|['"]$/g, "");
    const parseList = (value: string | undefined): string[] | undefined => value === undefined ? undefined : value.replace(/^\[|\]$/g, "").split(",").map((entry) => unquote(entry.trim())).filter(Boolean);
    const tools = parseList(meta.tools);
    const skills = parseList(meta.skills);
    const extensions = parseList(meta.extensions);
    let extensionSettings: unknown;
    if (meta.extensionSettings !== undefined) {
      try { extensionSettings = JSON.parse(meta.extensionSettings) as unknown; }
      catch (error) { fail("INVALID_METADATA", `Invalid role extensionSettings: ${errorText(error)}`); }
    }
    const rolePathValue = rolePath ?? "<role>";
    const normalizedExtensionSettings = validateWorkflowExtensionSettings(extensionSettings, rolePathValue, "INVALID_METADATA");
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
    if (normalizedExtensionSettings !== undefined) definition.extensionSettings = normalizedExtensionSettings;
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
  const { model, tools, skills, extensions, extensionSettings, description, contextFiles } = parsed.frontmatter;
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
  const normalizedExtensionSettings = validateWorkflowExtensionSettings(extensionSettings, rolePathValue, "INVALID_METADATA");
  const normalizedDescription = typeof description === "string" ? description.trim() : undefined;
  const normalizedModel = typeof model === "string" ? model.trim() : undefined;
  if (normalizedModel !== undefined) assertModelThinking(normalizedModel, "Role model");
  const definition: AgentDefinition = { prompt: parsed.body };
  if (normalizedDescription !== undefined) definition.description = normalizedDescription;
  if (normalizedModel !== undefined) definition.model = normalizedModel;
  if (normalizedTools !== undefined) definition.tools = normalizedTools;
  if (normalizedSkills !== undefined) definition.skills = normalizedSkills;
  if (normalizedExtensions !== undefined) definition.extensions = normalizedExtensions;
  if (normalizedExtensionSettings !== undefined) definition.extensionSettings = normalizedExtensionSettings;
  if (typeof overrideSystemPrompt === "boolean") definition.overrideSystemPrompt = overrideSystemPrompt;
  if (normalizedContextFiles !== undefined) definition.contextFiles = normalizedContextFiles;
  return definition;
}

export function workflowRoleDirectories(agentDir = getAgentDir()): readonly string[] {
  return [join(agentDir, ROLE_DIRECTORY, "roles")];
}

function projectRoleDirectories(root: string): readonly string[] {
  return [join(root, ROLE_DIRECTORY, "roles")];
}

type RoleDirectorySource = { path: string; extension?: WorkflowExtensionMetadata; builtin?: true };
export type WorkflowRoleDirectoryInput = string | WorkflowRoleDirectoryRegistration;
type RoleFile = { name: string; path: string; source: RoleDirectorySource };
function roleDirectorySources(dirs: readonly WorkflowRoleDirectoryInput[]): RoleDirectorySource[] {
  const seen = new Set<string>();
  return dirs.flatMap((value) => {
    const source = typeof value === "string" ? { path: value } : { path: value.path, extension: value.extension, ...(value.builtin === true ? { builtin: true as const } : {}) };
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

export interface RoleDiscoveryOptions {
  cwd: string;
  agentDir?: string;
  projectTrusted?: boolean;
  extensionRoleDirectories?: readonly WorkflowRoleDirectoryInput[];
}
export interface RoleResourceCandidates {
  skills?: readonly string[];
  extensions?: readonly string[];
  tools?: readonly string[];
}
export interface RoleResolutionOptions extends RoleDiscoveryOptions {
  definition?: AgentDefinition;
  definitions?: Readonly<Record<string, AgentDefinition>>;
  model?: string;
  modelOverride?: ModelSpec;
  rootModel?: ModelSpec;
  rootTools?: ReadonlySet<string> | readonly string[];
  inheritedTools?: readonly string[];
  availableModels?: ReadonlySet<string>;
  knownModels?: ReadonlySet<string>;
  modelAliases?: Readonly<Record<string, string>>;
  blockedAliases?: ReadonlySet<string>;
  blockedAliasTargets?: Readonly<Record<string, string>>;
  settingsPath?: string;
  selectorSources?: AgentResourceSelectorSources;
  resources?: RoleResourceCandidates;
  tools?: readonly string[];
  skills?: readonly string[];
  extensions?: readonly string[];
  contextFiles?: readonly ContextFileScope[];
  effectiveTools?: readonly string[];
}
export interface ResolvedRole {
  name?: string;
  definition?: AgentDefinition;
  model?: ModelSpec;
  requestedModel?: string;
  tools?: readonly string[];
  prompt: string;
  overrideSystemPrompt: boolean;
  systemPrompt: { mode: "override" | "append"; text: string };
  contextFiles?: readonly ContextFileScope[];
  extensionSettings?: Readonly<WorkflowExtensionSettings>;
  selectorSources: AgentResourceSelectorSources;
  selectorLayers: { skills: readonly (readonly string[] | undefined)[]; extensions: readonly (readonly string[] | undefined)[]; tools: readonly (readonly string[] | undefined)[] };
  selectedSkills?: readonly string[];
  selectedExtensions?: readonly string[];
  unmatchedSkills?: readonly string[];
  unmatchedExtensions?: readonly string[];
  unmatchedTools?: readonly string[];
}

type RoleEntry = { name: string; path: string; definition: AgentDefinition; source: RoleDirectorySource };
function roleEntries(dirs: readonly WorkflowRoleDirectoryInput[], extension: boolean): Record<string, RoleEntry> {
  const files = scanRoleFiles(dirs, extension);
  const starterFiles = files.filter(({ source }) => source.builtin === true);
  const regularFiles = files.filter(({ source }) => source.builtin !== true);
  if (extension) {
    const byName = new Map<string, RoleFile[]>();
    for (const file of regularFiles) byName.set(file.name, [...(byName.get(file.name) ?? []), file]);
    for (const [name, matches] of byName) if (matches.length > 1) fail("INVALID_METADATA", `Duplicate extension role "${name}": ${matches.map(({ path, source }) => `${roleDirectoryLabel(source)} role directory "${source.path}" (${path})`).join("; ")}`);
  }
  const read = (roleFiles: readonly RoleFile[]): Record<string, RoleEntry> => Object.fromEntries(roleFiles.map(({ name, path, source }) => {
    try {
      const definition = parseRoleMarkdown(readFileSync(path, "utf8"), true, path);
      roleDefinitionPaths.set(definition, path);
      return [name, { name, path, source, definition }];
    }
    catch (error) {
      if (extension) fail("INVALID_METADATA", `${roleDirectoryLabel(source)} role directory "${source.path}" contains invalid role "${name}" at "${path}": ${errorText(error)}`);
      throw error;
    }
  }));
  return extension ? { ...read(starterFiles), ...read(regularFiles) } : read(files);
}
type ResolvedRoleDiscoveryOptions = { cwd: string; agentDir: string; projectTrusted: boolean; extensionRoleDirectories: readonly WorkflowRoleDirectoryInput[] };
function discoveryInput(input: RoleDiscoveryOptions): ResolvedRoleDiscoveryOptions {
  return { cwd: input.cwd, agentDir: input.agentDir ?? getAgentDir(), projectTrusted: input.projectTrusted ?? true, extensionRoleDirectories: input.extensionRoleDirectories ?? registeredWorkflowRoleDirectoryRegistrations() };
}
function discoveredRoleEntries(input: RoleDiscoveryOptions): Record<string, RoleEntry> {
  const resolved = discoveryInput(input);
  return {
    ...roleEntries(resolved.extensionRoleDirectories, true),
    ...roleEntries(workflowRoleDirectories(resolved.agentDir), false),
    ...(resolved.projectTrusted ? roleEntries(projectRoleDirectories(join(resolved.cwd, ".pi")), false) : {}),
  };
}
export function loadProjectAgentDefinitions(cwd: string): Readonly<Record<string, AgentDefinition>> {
  return deepFreeze(Object.fromEntries(Object.entries(roleEntries(projectRoleDirectories(join(cwd, ".pi")), false)).map(([name, entry]) => [name, entry.definition])));
}
export function discoverRoles(input: RoleDiscoveryOptions): Readonly<Record<string, AgentDefinition>> {
  return deepFreeze(Object.fromEntries(Object.entries(discoveredRoleEntries(input)).map(([name, entry]) => [name, entry.definition])));
}
export function loadRole(name: string, input: RoleDiscoveryOptions): AgentDefinition {
  const entry = discoveredRoleEntries(input)[name];
  if (!entry) fail("UNKNOWN_AGENT_TYPE", `Unknown agent role: ${name}`);
  return entry.definition;
}
export function loadAgentDefinitions(cwd: string, agentDir = getAgentDir(), projectTrusted = true, extensionRoleDirectories: readonly WorkflowRoleDirectoryInput[] = registeredWorkflowRoleDirectoryRegistrations()): Readonly<Record<string, AgentDefinition>> {
  return discoverRoles({ cwd, agentDir, projectTrusted, extensionRoleDirectories });
}

export function canonicalExtensionSelector(selector: string, base = process.cwd()): string {
  const negated = selector.startsWith("!");
  const body = negated ? selector.slice(1) : selector;
  // Built-in extensions are named `builtin:<name>`, not by a path.
  if (body === "*" || body === "**" || body.startsWith("**/") || body.startsWith("builtin:")) return selector;
  const resolved = resolve(base, body);
  if (resourcePatternHasMagic(body)) return `${negated ? "!" : ""}${resolved}`;
  return `${negated ? "!" : ""}${canonicalPath(resolved)}`;
}
function selectorsFromSettings(settings: { skills?: readonly string[]; extensions?: readonly string[]; tools?: readonly string[] }): AgentResourceSelectors {
  return { ...(settings.skills === undefined ? {} : { skills: settings.skills }), ...(settings.extensions === undefined ? {} : { extensions: settings.extensions }), ...(settings.tools === undefined ? {} : { tools: settings.tools }) };
}
function rootToolNames(value: ReadonlySet<string> | readonly string[] | undefined): readonly string[] | undefined {
  return value === undefined ? undefined : value instanceof Set ? [...value] : [...value];
}
function roleDefinitionFor(name: string | undefined, options: RoleResolutionOptions): { definition?: AgentDefinition; path?: string } {
  if (name === undefined) return {};
  if (options.definition !== undefined) {
    const path = roleDefinitionPaths.get(options.definition);
    return { definition: options.definition, ...(path === undefined ? {} : { path }) };
  }
  if (options.definitions?.[name] !== undefined) {
    const definition = options.definitions[name];
    const path = roleDefinitionPaths.get(definition);
    return { definition, ...(path === undefined ? {} : { path }) };
  }
  const entries = discoveredRoleEntries(options);
  const entry = entries[name];
  if (!entry) fail("UNKNOWN_AGENT_TYPE", `Unknown agent role: ${name}`);
  return entry;
}
/** Without a supplied root/tool/resource boundary, this API reports selector layers but does not infer available resources; tools and model remain undefined when no candidates are supplied. When selector sources are supplied, model aliases default to none and blocked aliases are not applied unless provided. */
export function resolveRole(name: string | undefined, options: RoleResolutionOptions): ResolvedRole {
  const { definition, path } = roleDefinitionFor(name, options);
  const settings = options.selectorSources === undefined ? resolveWorkflowSettings(options.cwd, options.projectTrusted ?? true, options.settingsPath ?? workflowSettingsPath(options.agentDir ?? getAgentDir())) : undefined;
  const baseSources = options.selectorSources ?? { global: selectorsFromSettings(settings?.global ?? {}), project: selectorsFromSettings(settings?.project ?? {}) };
  const canonicalSources = (sources: AgentResourceSelectorSources): AgentResourceSelectorSources => ({
    ...sources,
    global: { ...sources.global, ...(sources.global.extensions === undefined ? {} : { extensions: sources.global.extensions.map((selector) => canonicalExtensionSelector(selector, options.cwd)) }) },
    project: { ...sources.project, ...(sources.project.extensions === undefined ? {} : { extensions: sources.project.extensions.map((selector) => canonicalExtensionSelector(selector, options.cwd)) }) },
    ...(sources.role === undefined ? {} : { role: { ...sources.role, ...(sources.role.extensions === undefined ? {} : { extensions: sources.role.extensions.map((selector) => canonicalExtensionSelector(selector, options.cwd)) }) } }),
    ...(sources.call === undefined ? {} : { call: { ...sources.call, ...(sources.call.extensions === undefined ? {} : { extensions: sources.call.extensions.map((selector) => canonicalExtensionSelector(selector, options.cwd)) }) } }),
  });
  const roleLayer = definition?.skills !== undefined || definition?.extensions !== undefined || definition?.tools !== undefined ? { ...(definition.skills === undefined ? {} : { skills: definition.skills }), ...(definition.extensions === undefined ? {} : { extensions: definition.extensions.map((selector) => canonicalExtensionSelector(selector, path ? dirname(path) : options.cwd)) }), ...(definition.tools === undefined ? {} : { tools: definition.tools }) } : baseSources.role;
  const callLayer = options.skills !== undefined || options.extensions !== undefined || options.tools !== undefined ? { ...(options.skills === undefined ? {} : { skills: options.skills }), ...(options.extensions === undefined ? {} : { extensions: options.extensions.map((selector) => canonicalExtensionSelector(selector, options.cwd)) }), ...(options.tools === undefined ? {} : { tools: options.tools }) } : baseSources.call;
  const selectorSources = canonicalSources({ global: baseSources.global, project: baseSources.project, ...(roleLayer === undefined ? {} : { role: roleLayer }), ...(callLayer === undefined ? {} : { call: callLayer }) });
  const callSelectors = selectorSources.call;
  const roleSelectors = selectorSources.role;
  const selectorLayers = {
    skills: [selectorSources.global.skills, selectorSources.project.skills, roleSelectors?.skills, callSelectors?.skills],
    extensions: [selectorSources.global.extensions, selectorSources.project.extensions, roleSelectors?.extensions, callSelectors?.extensions],
    tools: [selectorSources.global.tools, selectorSources.project.tools, roleSelectors?.tools, callSelectors?.tools],
  };
  const resources = options.resources ?? {};
  const candidateTools = options.inheritedTools ?? rootToolNames(options.rootTools) ?? resources.tools;
  const tools = options.effectiveTools ?? (candidateTools === undefined ? undefined : selectResourcesByLayers(selectorLayers.tools, candidateTools));
  const rootTools = rootToolNames(options.rootTools);
  if (rootTools !== undefined) {
    const outsideEffectiveTool = options.effectiveTools?.find((tool) => !candidateTools?.includes(tool));
    if (outsideEffectiveTool) fail("UNKNOWN_TOOL", `Tool is outside the launching session boundary: ${outsideEffectiveTool}`);
    const outsideCallTool = (options.tools ?? []).find((tool) => !tool.startsWith("!") && !resourcePatternHasMagic(tool) && !candidateTools?.includes(tool));
    if (outsideCallTool) fail("UNKNOWN_TOOL", `Tool is outside the launching session boundary: ${outsideCallTool}`);
    const outsideRootTool = tools?.find((tool) => !rootTools.includes(tool));
    if (outsideRootTool) fail("UNKNOWN_TOOL", `Tool is outside the launching session boundary: ${outsideRootTool}`);
  }
  const selectedSkills = resources.skills === undefined ? undefined : selectResourcesByLayers(selectorLayers.skills, resources.skills);
  const extensionResources = resources.extensions?.map((extension) => extensionIdentity(extension));
  const selectedExtensions = extensionResources === undefined ? undefined : selectResourcesByLayers(selectorLayers.extensions, extensionResources);
  const unmatchedSkills = resources.skills === undefined ? undefined : unmatchedResourcePatterns(selectorLayers.skills.flatMap((layer) => layer ?? []), resources.skills);
  const unmatchedExtensions = extensionResources === undefined ? undefined : unmatchedResourcePatterns(selectorLayers.extensions.flatMap((layer) => layer ?? []), extensionResources);
  const unmatchedTools = candidateTools === undefined ? undefined : unmatchedResourcePatterns(selectorLayers.tools.flatMap((layer) => layer ?? []), candidateTools);
  const aliases = options.modelAliases ?? settings?.effective.modelAliases ?? {};
  const requestedModel = options.model ?? (definition?.model && definition.thinking && !definition.model.includes(":") ? `${definition.model}:${definition.thinking}` : definition?.model);
  const blockedAlias = requestedModel?.split(":", 1)[0];
  if (requestedModel !== undefined && blockedAlias && options.blockedAliases?.has(blockedAlias) && !modelAliasName(requestedModel, aliases)) {
    const target = options.blockedAliasTargets?.[blockedAlias];
    fail("UNKNOWN_MODEL", `Unknown model alias ${requestedModel}${target ? ` resolved to ${target}` : ""}${options.settingsPath ? ` (settings: ${options.settingsPath})` : ""}`);
  }
  let model = options.modelOverride;
  if (model === undefined && requestedModel !== undefined) {
    assertModelThinking(requestedModel);
    model = resolveModelReference(requestedModel, aliases, options.knownModels ?? options.availableModels, options.settingsPath ?? settings?.sources.modelAliases);
  }
  if (model === undefined) model = options.rootModel;
  const availableModels = options.knownModels ?? options.availableModels ?? (options.rootModel === undefined ? undefined : new Set([modelCapability(options.rootModel)]));
  if (model !== undefined && availableModels !== undefined && !availableModels.has(modelCapability(model))) fail("UNKNOWN_MODEL", `Unknown model${requestedModel ? ` ${requestedModel} resolved to ${modelCapability(model)}` : ""}${options.settingsPath ? ` (settings: ${options.settingsPath})` : ""}`);
  const prompt = definition?.prompt ?? "";
  const overrideSystemPrompt = definition?.overrideSystemPrompt === true;
  const contextFiles = options.contextFiles ?? definition?.contextFiles;
  return { ...(name === undefined ? {} : { name }), ...(definition === undefined ? {} : { definition }), ...(model === undefined ? {} : { model }), ...(modelAliasName(requestedModel ?? "", aliases) && requestedModel ? { requestedModel } : {}), ...(tools === undefined ? {} : { tools }), prompt, overrideSystemPrompt, systemPrompt: { mode: overrideSystemPrompt ? "override" : "append", text: prompt }, ...(contextFiles === undefined ? {} : { contextFiles: [...contextFiles] }), ...(definition?.extensionSettings === undefined ? {} : { extensionSettings: definition.extensionSettings }), selectorSources, selectorLayers, ...(selectedSkills === undefined ? {} : { selectedSkills }), ...(selectedExtensions === undefined ? {} : { selectedExtensions }), ...(unmatchedSkills === undefined ? {} : { unmatchedSkills }), ...(unmatchedExtensions === undefined ? {} : { unmatchedExtensions }), ...(unmatchedTools === undefined ? {} : { unmatchedTools }) };
}
