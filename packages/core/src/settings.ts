import { atomicWriteFile } from "./persistence.js";
import { mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ToolAnnotations } from "@earendil-works/pi-coding-agent";
import type { AgentResourcePolicy, AgentResourceSelectors, AgentResourceSelectorSet, ContextFileScope, JsonValue, WorkflowExtensionSettings, WorkflowRetentionSettings, WorkflowSettings, WorkflowSettingsOverrides, WorkflowSettingsResolution, WorkflowSettingsSources } from "./types.js";
import { isContextFileScope } from "./types.js";
import { annotateModelAliasError, deepFreeze, errorText, fail, isNodeError, jsonValue, modelCapability, object, positiveInteger, resourcePatternHasMagic, unknownModel, validateModelAliases, validateResourcePattern, validWorkflowExtensionNamespace } from "./utils.js";
import { canonicalPath } from "./paths.js";

const ROLE_DIRECTORY = "pi-extensible-workflows";
export const DEFAULT_SETTINGS: Readonly<WorkflowSettings> = Object.freeze({ concurrency: 8, backgroundWidget: true });
export function workflowSettingsPath(agentDir = getAgentDir()): string { return join(agentDir, ROLE_DIRECTORY, "settings.json"); }
export function workflowProjectSettingsPath(cwd: string): string { return join(cwd, ".pi", ROLE_DIRECTORY, "settings.json"); }
function normalizedResourcePath(value: string, settingsPath: string): string {
  // Built-in extensions are named `builtin:<name>`, not by a path.
  if (value === "*" || value.startsWith("builtin:")) return value;
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
    return `${canonicalPath(prefix)}${suffix}`;
  }
  return canonicalPath(resolved);
}
export function validateSelectorList(value: unknown, path: string, kind: "skills" | "extensions" | "tools", errorCode: "INVALID_SETTINGS" | "INVALID_METADATA" = "INVALID_SETTINGS", normalizeExtensions = true): readonly string[] | undefined {
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
export function validateContextFileScopes(value: unknown, rolePath: string): readonly ContextFileScope[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every(isContextFileScope)) fail("INVALID_METADATA", `${rolePath}.contextFiles must be an array containing only global, project, or cwd`);
  return [...value];
}
export function validateWorkflowExtensionSettings(value: unknown, settingsPath: string, errorCode: "INVALID_SETTINGS" | "INVALID_METADATA" = "INVALID_SETTINGS"): WorkflowExtensionSettings | undefined {
  if (value === undefined) return undefined;
  const base = `${settingsPath}.extensionSettings`;
  if (!object(value)) fail(errorCode, `${base} must be an object`);
  const normalized: Record<string, JsonValue> = {};
  for (const [namespace, raw] of Object.entries(value)) {
    if (!validWorkflowExtensionNamespace(namespace)) fail(errorCode, `${base} contains an invalid namespace: ${namespace}`);
    if (namespace === "herdr") {
      if (!object(raw)) fail(errorCode, `${base}.herdr must be an object`);
      if (Object.keys(raw).some((key) => key !== "enableFullyInspectableMode")) fail(errorCode, `${base}.herdr contains an unsupported setting`);
      if (raw.enableFullyInspectableMode !== undefined && typeof raw.enableFullyInspectableMode !== "boolean") fail(errorCode, `${base}.herdr.enableFullyInspectableMode must be a boolean`);
      normalized.herdr = Object.freeze({ ...(raw.enableFullyInspectableMode === undefined ? {} : { enableFullyInspectableMode: raw.enableFullyInspectableMode }) });
      continue;
    }
    if (namespace === "trajectory") {
      if (!object(raw)) fail(errorCode, `${base}.trajectory must be an object`);
      if (Object.keys(raw).some((key) => key !== "port")) fail(errorCode, `${base}.trajectory contains an unsupported setting`);
      if (raw.port !== undefined && (!positiveInteger(raw.port) || raw.port > 65535)) fail(errorCode, `${base}.trajectory.port must be an integer from 1 to 65535`);
      normalized.trajectory = Object.freeze({ ...(raw.port === undefined ? {} : { port: raw.port }) });
      continue;
    }
    if (!jsonValue(raw)) fail(errorCode, `${base}.${namespace} must be JSON-compatible`);
    normalized[namespace] = structuredClone(raw);
  }
  return deepFreeze(normalized as WorkflowExtensionSettings);
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
  const allowed = new Set(["concurrency", "modelAliases", "skills", "extensions", "extensionSettings", "tools", "retention", ...(partial ? [] : ["backgroundWidget", "codemodeTools"]) ]);
  const unknown = Object.keys(parsed).find((key) => !allowed.has(key));
  if (Object.prototype.hasOwnProperty.call(parsed, "disabledAgentResources")) fail("INVALID_SETTINGS", `disabledAgentResources is no longer supported; use skills, extensions, and tools selectors (settings: ${path})`);
  if (unknown) fail("INVALID_SETTINGS", `Unknown workflow setting at ${path}: ${unknown}`);
  const concurrency = parsed.concurrency === undefined ? (partial ? undefined : DEFAULT_SETTINGS.concurrency) : parsed.concurrency;
  if (concurrency !== undefined && (!positiveInteger(concurrency) || concurrency > 16)) fail("INVALID_SETTINGS", `${path}.concurrency must be an integer from 1 to 16`);
  const backgroundWidget = parsed.backgroundWidget === undefined ? (partial ? undefined : DEFAULT_SETTINGS.backgroundWidget) : parsed.backgroundWidget;
  if (backgroundWidget !== undefined && typeof backgroundWidget !== "boolean") fail("INVALID_SETTINGS", `${path}.backgroundWidget must be a boolean`);
  const codemodeTools = parsed.codemodeTools;
  if (codemodeTools !== undefined && codemodeTools !== "all" && codemodeTools !== "read-only" && codemodeTools !== "none") fail("INVALID_SETTINGS", `${path}.codemodeTools must be "all", "read-only", or "none"`);
  const modelAliases = parsed.modelAliases === undefined ? undefined : validateModelAliases(parsed.modelAliases, path);
  const skills = validateSelectorList(parsed.skills, path, "skills");
  const tools = validateSelectorList(parsed.tools, path, "tools");
  const extensions = validateSelectorList(parsed.extensions, path, "extensions");
  const extensionSettings = parsed.extensionSettings === undefined ? undefined : validateWorkflowExtensionSettings(parsed.extensionSettings, path, "INVALID_SETTINGS");
  const retention = validateRetention(parsed.retention, path);
  return Object.freeze({
    ...(concurrency === undefined ? {} : { concurrency }), ...(backgroundWidget === undefined ? {} : { backgroundWidget }), ...(codemodeTools === undefined ? {} : { codemodeTools }), ...(modelAliases === undefined ? {} : { modelAliases }),
    ...(skills === undefined ? {} : { skills }), ...(extensions === undefined ? {} : { extensions }),
    ...(extensionSettings === undefined ? {} : { extensionSettings }), ...(tools === undefined ? {} : { tools }), ...(retention === undefined ? {} : { retention }),
  });
}
export function loadSettings(path = workflowSettingsPath()): Readonly<WorkflowSettings> { return parseSettings(path, false); }
const READ_ONLY_WORKFLOW_TOOLS: ReadonlySet<string> = new Set(["workflow_status", "workflow_catalog", "subagents_inspect"]);
/**
 * Exposure and annotations of a workflow or subagent tool. Under the global `codemodeTools` setting,
 * `model-only` keeps the model's direct access and stops codemode scripts from calling the tool.
 * Tools are registered once at load, so the setting is global and applies after a reload.
 * Read-only tools carry `readOnlyHint` so permission extensions need not confirm them.
 */
export function workflowToolExposure(name: string, codemodeTools: WorkflowSettings["codemodeTools"]): { exposure?: "model-only"; annotations?: ToolAnnotations } {
  const readOnly = READ_ONLY_WORKFLOW_TOOLS.has(name);
  return { ...(codemodeTools === "none" || (codemodeTools === "read-only" && !readOnly) ? { exposure: "model-only" as const } : {}), ...(readOnly ? { annotations: { readOnlyHint: true } } : {}) };
}
/** The `codemodeTools` setting at load time. Invalid settings keep the default; launches report them. */
export function loadCodemodeToolsSetting(agentDir?: string): WorkflowSettings["codemodeTools"] {
  try { return loadSettings(workflowSettingsPath(agentDir)).codemodeTools; } catch { return undefined; }
}
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
  const extensionSettings = projectHas("extensionSettings") ? project.extensionSettings : global.extensionSettings;
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

