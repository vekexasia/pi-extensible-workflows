import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type Credential } from "@earendil-works/pi-ai";
import {
  ModelRuntime,
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  hasTrustRequiringProjectResources,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SETTINGS,
  createLocalPiSession,
  errorText,
  isNodeError,
  isObject,
  loadSettings,
  prepareAgentSetupForInspection,
  resolveAgentResourcePolicy,
  resolveWorkflowSettings,
  resolveModelReference,
  resourcePatternHasMagic,
  parseThinking,
  parseRoleMarkdown,
  registeredWorkflowFunctions,
  registeredWorkflowRoleDirectoryRegistrations,
  workflowRoleDirectories,
  workflowProjectSettingsPath,
  workflowSettingsPath,
  type AgentExecutionOptions,
  type AgentExecutionRoot,
  type AgentResourcePolicy,
  type AgentTransport,
  type WorkflowCatalogModelAlias,
  type WorkflowExtensionMetadata,
  type WorkflowFunction,
  type WorkflowRoleDirectoryRegistration,
  type WorkflowSettings,
  type WorkflowSettingsSources,
} from "pi-extensible-workflows";
import type { AgentDefinition } from "pi-extensible-workflows";
import { loadingRegistry, type WorkflowRegistryApi } from "pi-extensible-workflows";
import { selectResourcesByLayers, unmatchedResourcePatterns } from "pi-extensible-workflows";

export type DoctorSeverity = "error" | "warning";
export interface DoctorDiagnostic { severity: DoctorSeverity; code: string; message: string; source?: string; hint?: string }
export interface DoctorRole { name: string; path: string; scope: "extension" | "global" | "project"; active: boolean; overrides?: string; overriddenBy?: string; extension?: WorkflowExtensionMetadata }
export interface DoctorFunction { name: string; description: string; valid: boolean }
export interface DoctorTrust { required: boolean; trusted: boolean; source: string }
export interface DoctorRoleInspection {
  role: string;
  path: string;
  model: { provider: string; model: string; thinking?: string; inherited?: boolean };
  tools: readonly string[];
  resources: { selectors: { skills: readonly string[]; extensions: readonly string[]; tools: readonly string[] }; skills: readonly string[]; extensions: readonly string[]; tools: readonly string[]; unmatchedSkills: readonly string[]; unmatchedExtensions: readonly string[]; unmatchedTools: readonly string[]; selectorSources?: NonNullable<AgentResourcePolicy["selectorSources"]> };
  systemPrompt: { probe: string; expandedProbe: string; text: string; source?: string };
  setup: { hooks: readonly string[]; diagnostics: readonly DoctorDiagnostic[] };
}
export interface DoctorPiState {
  trust: DoctorTrust;
  model?: { provider: string; model: string; thinking?: string };
  activeTools: readonly string[];
  knownModels: readonly string[];
  availableModels: readonly string[];
  extensionErrors: readonly { path?: string; message: string }[];
  extensions?: readonly string[];
  skills?: readonly string[];
  functions: Readonly<Record<string, WorkflowFunction>>;
}
export interface DoctorReport {
  cwd: string;
  agentDir: string;
  settingsPath: string;
  settings: Readonly<WorkflowSettings>;
  settingsSources: WorkflowSettingsSources;
  trust: DoctorTrust;
  activeTools: readonly string[];
  piExtensions: readonly string[];
  piSkills: readonly string[];
  roles: readonly DoctorRole[];
  functions: readonly DoctorFunction[];
  resourcePolicy: AgentResourcePolicy;
  modelAliases: readonly WorkflowCatalogModelAlias[];
  roleTarget?: string;
  roleInspection?: DoctorRoleInspection;
  diagnostics: readonly DoctorDiagnostic[];
}
export interface DoctorOptions {
  cwd?: string;
  agentDir?: string;
  settingsPath?: string;
  role?: string;
  prompt?: string;
  discoverPi?: (cwd: string, agentDir: string) => Promise<DoctorPiState>;
  activeTools?: readonly string[];
  registry?: WorkflowRegistryApi;
}

const THINKING_HINT = "Use off, minimal, low, medium, high, xhigh, or max.";
const AGENT_RESOURCE_SELECTOR_MIGRATION_ISSUE = "https://github.com/vekexasia/pi-extensible-workflows/issues/205";
const AGENT_RESOURCE_SELECTOR_MIGRATION_MESSAGE = `\`disabledAgentResources\` is no longer supported by #205. Migrate to direct \`skills\`, \`extensions\`, and \`tools\` selectors: legacy patterns exclude resources and \`!pattern\` re-enables them, while new selectors include matches and \`!pattern\` excludes them. See ${AGENT_RESOURCE_SELECTOR_MIGRATION_ISSUE}`;

function usesLegacySettings(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, "disabledAgentResources");
  } catch { return false; }
}
function usesLegacyRoleSelectors(path: string): boolean {
  try { return /^\s*disabledAgentResources\s*:/m.test(readFileSync(path, "utf8")); }
  catch { return false; }
}

function canonical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}
function isDynamicModelAlias(value: string, aliases: ReadonlySet<string>): boolean {
  const match = /^([^/\s:]+)(?::([^\s]+))?$/.exec(value);
  const name = match?.[1];
  return Boolean(name && (match[2] === undefined || parseThinking(match[2]) !== undefined) && aliases.has(name));
}
function isCredential(value: unknown): value is Credential {
  if (!isObject(value)) return false;
  if (value.type === "api_key") return (value.key === undefined || typeof value.key === "string") && (value.env === undefined || isObject(value.env) && Object.values(value.env).every((entry) => typeof entry === "string"));
  return value.type === "oauth" && typeof value.refresh === "string" && typeof value.access === "string" && typeof value.expires === "number";
}
async function readCredentials(agentDir: string): Promise<InMemoryCredentialStore> {
  const credentials = new InMemoryCredentialStore();
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
    if (!isObject(parsed)) throw new Error("Pi auth.json must be an object");
    await Promise.all(Object.entries(parsed).flatMap(([provider, credential]) => isCredential(credential) ? [credentials.modify(provider, async () => credential)] : []));
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  return credentials;
}

function savedTrust(cwd: string, agentDir: string): boolean | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8")); }
  catch (error) { if (isNodeError(error, "ENOENT")) return undefined; throw error; }
  if (!isObject(parsed)) throw new Error("Pi trust.json must be an object");
  let current = canonical(cwd);
  while (current !== dirname(current)) {
    const value = parsed[current];
    if (value === true || value === false) return value;
    current = dirname(current);
  }
  const value = parsed[current];
  return value === true || value === false ? value : undefined;
}

async function discoverPi(cwd: string, agentDir: string): Promise<DoctorPiState> {
  const required = hasTrustRequiringProjectResources(cwd);
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const saved = required ? savedTrust(cwd, agentDir) : true;
  const fallback = settingsManager.getDefaultProjectTrust();
  const trusted = !required || saved !== undefined ? Boolean(saved) : fallback === "always";
  const source = !required ? "no trust-gated project resources" : saved !== undefined ? "saved Pi trust decision" : `headless defaultProjectTrust=${fallback}`;
  const previousOffline = process.env.PI_OFFLINE;
  process.env.PI_OFFLINE = "1";
  try {
    const modelRuntime = await ModelRuntime.create({ credentials: await readCredentials(agentDir), modelsPath: join(agentDir, "models.json"), modelsStore: new InMemoryModelsStore() });
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: { noPromptTemplates: true, noThemes: true, noContextFiles: true },
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => trusted },
    });
    const allModels = services.modelRuntime.getModels();
    const availableModels = await services.modelRuntime.getAvailable();
    const model = availableModels[0] ?? allModels[0];
    if (!model) throw new Error("Pi has no models registered");
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(), model });
    const activeTools = session.agent.state.tools.map(({ name }) => name).filter((name) => name !== "workflow" && name !== "workflow_respond" && name !== "workflow_catalog");
    const extensions = services.resourceLoader.getExtensions();
    const skills = services.resourceLoader.getSkills().skills;
    return {
      trust: { required, trusted, source },
      model: { provider: model.provider, model: model.id, thinking: session.thinkingLevel },
      activeTools,
      knownModels: allModels.map(({ provider, id }) => `${provider}/${id}`),
      availableModels: availableModels.map(({ provider, id }) => `${provider}/${id}`),
      extensions: extensions.extensions.map(({ resolvedPath }) => resolvedPath),
      skills: skills.map(({ name }) => name),
      extensionErrors: [
        ...extensions.errors.map(({ path, error }) => ({ path, message: error })),
        ...services.diagnostics.filter(({ type }) => type === "error").map(({ message }) => ({ message })),
      ],
      functions: registeredWorkflowFunctions(),
    };
  } finally {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  }
}

function isRoleFile(dir: string, entry: import("node:fs").Dirent): boolean {
  if (extname(entry.name) !== ".md") return false;
  if (entry.isFile()) return true;
  if (!entry.isSymbolicLink()) return false;
  try { return statSync(join(dir, entry.name)).isFile(); }
  catch (error) { if (isNodeError(error, "ENOENT")) return false; throw error; }
}
function roleFiles(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => isRoleFile(dir, entry)).map((entry) => join(dir, entry.name)).sort(); }
  catch (error) { if (isNodeError(error, "ENOENT")) return []; throw error; }
}

function roleFilesFrom(dirs: readonly string[]): string[] {
  const paths = dirs.flatMap((dir) => roleFiles(dir));
  return [...new Map(paths.map((path) => [basename(path, ".md"), path])).values()].sort();
}
type ExtensionRoleFile = { name: string; path: string; directory: string; extension: WorkflowExtensionMetadata; builtin?: true };
type ExtensionRoleScan = { files: ExtensionRoleFile[]; empty: WorkflowRoleDirectoryRegistration[]; errors: Array<{ registration: WorkflowRoleDirectoryRegistration; error: unknown }> };
function extensionLabel(extension: WorkflowExtensionMetadata): string { return `Extension "${extension.headline}" (${extension.version})`; }
function scanExtensionRoleFiles(registrations: readonly WorkflowRoleDirectoryRegistration[]): ExtensionRoleScan {
  const files: ExtensionRoleFile[] = [];
  const empty: WorkflowRoleDirectoryRegistration[] = [];
  const errors: Array<{ registration: WorkflowRoleDirectoryRegistration; error: unknown }> = [];
  for (const registration of registrations) {
    try {
      const entries = readdirSync(registration.path, { withFileTypes: true });
      const roleFiles = entries.filter((entry) => isRoleFile(registration.path, entry));
      if (!roleFiles.length) empty.push(registration);
      for (const entry of roleFiles) files.push({ name: basename(entry.name, ".md"), path: join(registration.path, entry.name), directory: registration.path, extension: registration.extension, ...(registration.builtin === true ? { builtin: true as const } : {}) });
    } catch (error) { errors.push({ registration, error }); }
  }
  files.sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
  return { files, empty, errors };
}
function roleProvenance(source?: { directory: string; extension: WorkflowExtensionMetadata }): string {
  return source ? `${extensionLabel(source.extension)} role directory "${source.directory}"` : "Role";
}
function diagnostic(severity: DoctorSeverity, code: string, message: string, source?: string, hint?: string): DoctorDiagnostic {
  return { severity, code, message, ...(source ? { source } : {}), ...(hint ? { hint } : {}) };
}
function legacyAgentResourceSelectorDiagnostic(source: string): DoctorDiagnostic {
  return diagnostic("error", "AGENT_RESOURCE_SELECTOR_MIGRATION", AGENT_RESOURCE_SELECTOR_MIGRATION_MESSAGE, source, "Replace disabledAgentResources with direct selectors and use !* before positive allow-list patterns.");
}
function positiveOnlyToolSelectorDiagnostic(source: string, selectors: readonly string[] | undefined): DoctorDiagnostic | undefined {
  if (!selectors?.length || selectors.some((selector) => selector.startsWith("!"))) return undefined;
  return diagnostic("warning", "AGENT_RESOURCE_TOOL_SELECTOR_ALLOWLIST", "Positive-only tool selectors do not restrict the default-enabled candidate set.", `${source}.tools`, "Prepend !* before positive patterns to make this an allow-list.");
}
function emptyResourcePolicy(globalSettingsPath: string, cwd: string, projectTrusted: boolean): AgentResourcePolicy {
  const empty = { skills: [], extensions: [], tools: [] };
  return { globalSettingsPath, projectSettingsPath: workflowProjectSettingsPath(cwd), projectTrusted, global: empty, project: empty, effective: empty, unmatchedSkills: [], unmatchedExtensions: [], unmatchedTools: [], selectorSources: { global: {}, project: {} } };
}
function validateModel(value: string, known: ReadonlySet<string>, available: ReadonlySet<string>, source: string, diagnostics: DoctorDiagnostic[], aliases: Readonly<Record<string, string>>, dynamicAliases: ReadonlySet<string>, settingsPath: string): void {
  if (isDynamicModelAlias(value, dynamicAliases)) return;
  try {
    const parsed = resolveModelReference(value, aliases, known, settingsPath);
    const name = `${parsed.provider}/${parsed.model}`;
    if (!known.has(name) || !available.has(name)) diagnostics.push(diagnostic("warning", "MODEL_UNAVAILABLE", `Model is valid-shaped but unavailable: ${name}`, source));
  } catch (error) {
    const message = errorText(error);
    diagnostics.push(diagnostic("error", "MODEL_INVALID", message, source, message.includes("thinking") ? THINKING_HINT : "Use provider/model:thinking."));
  }
}

function inspectRole(path: string, activeTools: ReadonlySet<string>, knownModels: ReadonlySet<string>, availableModels: ReadonlySet<string>, diagnostics: DoctorDiagnostic[], aliases: Readonly<Record<string, string>>, dynamicAliases: ReadonlySet<string>, settingsPath: string, source?: { directory: string; extension: WorkflowExtensionMetadata }): AgentDefinition | undefined {
  let definition: AgentDefinition;
  try { definition = parseRoleMarkdown(readFileSync(path, "utf8"), true, path); }
  catch (error) {
    if (usesLegacyRoleSelectors(path)) {
      diagnostics.push(legacyAgentResourceSelectorDiagnostic(path));
      return undefined;
    }
    const message = errorText(error);
    diagnostics.push(diagnostic("error", "ROLE_FRONTMATTER", source ? `${roleProvenance(source)} contains invalid role at "${path}": ${message}` : message, path, "Fix the role YAML frontmatter."));
    return undefined;
  }
  const toolSelectorDiagnostic = positiveOnlyToolSelectorDiagnostic(path, definition.tools);
  if (toolSelectorDiagnostic) diagnostics.push(toolSelectorDiagnostic);
  const body = definition.prompt ?? "";
  if (body.trim() === "") diagnostics.push(diagnostic("warning", "ROLE_BODY_EMPTY", "Role body is empty", path));
  if (Buffer.byteLength(body) > 50 * 1024) diagnostics.push(diagnostic("warning", "ROLE_BODY_LARGE", "Role body exceeds 50KB", path));
  if (/{{\s*[^{}]+\s*}}/.test(body)) diagnostics.push(diagnostic("warning", "ROLE_PLACEHOLDER", "Role body contains an unsupported placeholder-looking token", path));
  if (definition.model) validateModel(definition.model, knownModels, availableModels, path, diagnostics, aliases, dynamicAliases, settingsPath);
  for (const selector of definition.tools ?? []) {
    const tool = selector.startsWith("!") ? selector.slice(1) : selector;
    if (!selector.startsWith("!") && !resourcePatternHasMagic(selector) && !activeTools.has(tool)) diagnostics.push(diagnostic("error", "ROLE_TOOL_INACTIVE", `Tool is unknown or inactive: ${tool}`, path, "Use a tool listed under Pi active tools or enable its Pi extension."));
  }
  return definition;
}

function matchResourcePolicy(policy: AgentResourcePolicy, pi: DoctorPiState): AgentResourcePolicy {
  const extensions = [...new Set((pi.extensions ?? []).map(canonical))];
  const skills = [...new Set(pi.skills ?? [])];
  const tools = [...new Set(pi.activeTools)];
  const layers = policy.selectorSources;
  const selectedSkills = selectResourcesByLayers([layers.global.skills, layers.project.skills], skills);
  const selectedExtensions = selectResourcesByLayers([layers.global.extensions, layers.project.extensions], extensions);
  const selectedTools = selectResourcesByLayers([layers.global.tools, layers.project.tools], tools);
  return { ...policy, selectedSkills, selectedExtensions, selectedTools, unmatchedSkills: unmatchedResourcePatterns(policy.effective.skills, skills), unmatchedExtensions: unmatchedResourcePatterns(policy.effective.extensions, extensions), unmatchedTools: unmatchedResourcePatterns(policy.effective.tools ?? [], tools) };
}
async function inspectRoleSession(cwd: string, agentDir: string, roleName: string, definition: AgentDefinition, rolePath: string, basePolicy: AgentResourcePolicy, rootModel: { provider: string; model: string; thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max" }, activeTools: readonly string[], aliases: Readonly<Record<string, string>>, knownModels: ReadonlySet<string>, availableModels: ReadonlySet<string>, settingsPath: string, prompt: string, hooks: NonNullable<AgentExecutionRoot["agentSetupHooks"]>, diagnostics: DoctorDiagnostic[]): Promise<DoctorRoleInspection | undefined> {
  const setupDiagnostics: DoctorDiagnostic[] = [];
  const signal = new AbortController().signal;
  const transport: AgentTransport = { id: "doctor-local", createSession: async () => { throw new Error("Doctor inspection does not create transport sessions"); } };
  const run = { cwd, sessionId: "doctor", runId: "doctor", workflow: { name: "doctor" }, args: null, signal };
  const root: AgentExecutionRoot = { cwd, model: { ...rootModel }, tools: new Set(activeTools), agentDefinitions: { [roleName]: definition }, agentDir, modelAliases: aliases, knownModels, availableModels, settingsPath, agentSetupHooks: hooks, agentResourcePolicy: () => structuredClone(basePolicy), runContext: run };
  const options: AgentExecutionOptions = { label: roleName, workflowName: "doctor", role: roleName };
  let prepared: Awaited<ReturnType<typeof prepareAgentSetupForInspection>>;
  try { prepared = await prepareAgentSetupForInspection(root, prompt, options, transport); }
  catch (error) { setupDiagnostics.push(diagnostic("error", "ROLE_INSPECTION", errorText(error), rolePath)); diagnostics.push(...setupDiagnostics); return undefined; }
  if (prepared.failure) {
    const error = prepared.failure.error;
    const code = prepared.failure.hook ? "ROLE_SETUP_HOOK" : "ROLE_INSPECTION";
    setupDiagnostics.push(diagnostic("error", code, `${prepared.failure.hook ? `Role setup hook ${prepared.failure.hook} failed: ` : ""}${errorText(error)}`, prepared.failure.hook ?? rolePath));
    diagnostics.push(...setupDiagnostics);
    return undefined;
  }
  const session = await (async () => { try { return await createLocalPiSession({ ...prepared.setup.sessionInput, sessionManager: SessionManager.inMemory() }); } catch (error) { setupDiagnostics.push(diagnostic("error", "ROLE_INSPECTION", errorText(error), rolePath)); return undefined; } })();
  if (!session) { diagnostics.push(...setupDiagnostics); return undefined; }
  try {
    const promptResult = await session.preparePrompt(prompt);
    const resources = session.getResourceInspection();
    const state = session.agent?.state;
    const inherited = prepared.setup.sessionInput.model.provider === rootModel.provider && prepared.setup.sessionInput.model.model === rootModel.model && prepared.setup.sessionInput.model.thinking === rootModel.thinking;
    const actualModel = session.model?.provider && (session.model.model ?? session.model.id) ? { provider: session.model.provider, model: session.model.model ?? session.model.id ?? prepared.setup.sessionInput.model.model, ...(session.thinkingLevel ? { thinking: session.thinkingLevel } : {}), ...(inherited ? { inherited: true } : {}) } : { ...prepared.setup.sessionInput.model, ...(inherited ? { inherited: true } : {}) };
    const policy = prepared.setup.sessionInput.resourcePolicy ?? basePolicy;
    for (const item of [...resources.diagnostics, ...promptResult.diagnostics]) setupDiagnostics.push(diagnostic(item.type === "error" ? "error" : "warning", "ROLE_INSPECTION", item.message, item.source));
    return { role: roleName, path: rolePath, model: actualModel, tools: state?.tools.map(({ name }) => name) ?? [...prepared.setup.sessionInput.tools], resources: { selectors: { skills: [...policy.effective.skills], extensions: [...policy.effective.extensions], tools: [...(policy.effective.tools ?? [])] }, skills: policy.selectedSkills ?? resources.skills, extensions: policy.selectedExtensions ?? resources.extensions, tools: policy.selectedTools ?? prepared.setup.sessionInput.tools, unmatchedSkills: policy.unmatchedSkills, unmatchedExtensions: policy.unmatchedExtensions, unmatchedTools: policy.unmatchedTools ?? [], selectorSources: policy.selectorSources }, systemPrompt: { probe: prompt, expandedProbe: promptResult.expandedPrompt, text: promptResult.systemPrompt, ...(resources.systemPromptSource ? { source: resources.systemPromptSource } : {}) }, setup: { hooks: prepared.summary.hookNames, diagnostics: setupDiagnostics } };
  } catch (error) { setupDiagnostics.push(diagnostic("error", "ROLE_INSPECTION", errorText(error), rolePath)); diagnostics.push(...setupDiagnostics); return undefined; }
  finally { await session.dispose(); }
}
function resourcePolicySource(settingsSource: string): string { return settingsSource; }
export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = canonical(options.cwd ?? process.cwd());
  const agentDir = canonical(options.agentDir ?? getAgentDir());
  const settingsPath = canonical(options.settingsPath ?? workflowSettingsPath(agentDir));
  const projectSettingsPath = workflowProjectSettingsPath(cwd);
  const legacyGlobalSettings = usesLegacySettings(settingsPath);
  const diagnostics: DoctorDiagnostic[] = [];
  let settings = DEFAULT_SETTINGS;
  try { settings = loadSettings(settingsPath); }
  catch (error) { diagnostics.push(diagnostic("error", "SETTINGS_INVALID", errorText(error), settingsPath, "Fix or remove the invalid workflow settings file.")); }
  let settingsSources: WorkflowSettingsSources = { concurrency: settingsPath, modelAliases: settingsPath, skills: settingsPath, extensions: settingsPath, tools: settingsPath };

  let pi: DoctorPiState;
  try { pi = await (options.discoverPi ?? discoverPi)(cwd, agentDir); }
  catch (error) {
    diagnostics.push(diagnostic("error", "PI_DISCOVERY", `Pi headless discovery failed: ${errorText(error)}`, undefined, "Open and trust the project in Pi, fix extension errors, then rerun doctor."));
    pi = { trust: { required: false, trusted: false, source: "discovery failed" }, activeTools: [], knownModels: [], availableModels: [], extensionErrors: [], functions: {} };
  }
  if (options.activeTools) pi = { ...pi, activeTools: options.activeTools.filter((tool) => tool !== "workflow" && tool !== "workflow_respond" && tool !== "workflow_catalog") };
  if (pi.trust.required && !pi.trust.trusted) diagnostics.push(diagnostic("warning", "PROJECT_UNTRUSTED", "Pi project resources are inactive because the project is not trusted", cwd, "Open this project in Pi, choose Trust, then rerun doctor."));
  const legacyProjectSettings = pi.trust.trusted && usesLegacySettings(projectSettingsPath);
  if (legacyGlobalSettings) diagnostics.push(legacyAgentResourceSelectorDiagnostic(`${settingsPath}.disabledAgentResources`));
  if (legacyProjectSettings) diagnostics.push(legacyAgentResourceSelectorDiagnostic(`${projectSettingsPath}.disabledAgentResources`));
  for (const error of pi.extensionErrors) diagnostics.push(diagnostic("error", "EXTENSION_LOAD", error.message, error.path, "Fix or disable the failing Pi extension."));
  try {
    const resolved = resolveWorkflowSettings(cwd, pi.trust.trusted, settingsPath);
    settings = resolved.effective;
    settingsSources = resolved.sources;
  } catch (error) {
    const message = errorText(error);
    const source = message.includes(projectSettingsPath) ? projectSettingsPath : settingsPath;
    if (!diagnostics.some(({ code, source: itemSource }) => code === "SETTINGS_INVALID" && itemSource === source)) diagnostics.push(diagnostic("error", "SETTINGS_INVALID", message, source, "Fix or remove the invalid workflow settings file."));
  }
  let resourcePolicy: AgentResourcePolicy;
  try {
    resourcePolicy = matchResourcePolicy(resolveAgentResourcePolicy(cwd, pi.trust.trusted, settingsPath), pi);
  } catch (error) {
    const message = errorText(error);
    const source = message.includes(projectSettingsPath) ? projectSettingsPath : settingsPath;
    if (!diagnostics.some(({ code, source: itemSource }) => code === "SETTINGS_INVALID" && itemSource === source)) diagnostics.push(diagnostic("error", "SETTINGS_INVALID", message, source, "Fix or remove the invalid workflow settings file."));
    resourcePolicy = emptyResourcePolicy(settingsPath, cwd, pi.trust.trusted);
  }
  for (const [source, selectors] of [[resourcePolicy.globalSettingsPath, resourcePolicy.selectorSources.global.tools], [resourcePolicy.projectSettingsPath, resourcePolicy.selectorSources.project.tools]] as const) {
    const toolSelectorDiagnostic = positiveOnlyToolSelectorDiagnostic(source, selectors);
    if (toolSelectorDiagnostic) diagnostics.push(toolSelectorDiagnostic);
  }
  for (const skill of resourcePolicy.unmatchedSkills) diagnostics.push(diagnostic("warning", "AGENT_RESOURCE_UNMATCHED", `Skill selector currently matches no discovered skill: ${skill}`, `${resourcePolicySource(settingsSources.skills ?? settingsPath)}.skills`));
  for (const extension of resourcePolicy.unmatchedExtensions) diagnostics.push(diagnostic("warning", "AGENT_RESOURCE_UNMATCHED", `Extension selector currently matches no discovered extension source: ${extension}`, `${resourcePolicySource(settingsSources.extensions ?? settingsPath)}.extensions`));
  for (const tool of resourcePolicy.unmatchedTools ?? []) diagnostics.push(diagnostic("warning", "AGENT_RESOURCE_UNMATCHED", `Tool selector currently matches no root tool: ${tool}`, `${resourcePolicySource(settingsSources.tools ?? settingsPath)}.tools`));

  const activeTools = new Set(pi.activeTools);
  const knownModels = new Set(pi.knownModels);
  const availableModels = new Set(pi.availableModels);
  const aliases = settings.modelAliases ?? {};
  const registry = options.registry ?? loadingRegistry();
  const registeredModelAliases = registry.modelAliases();
  const dynamicAliases = new Set(registeredModelAliases.map(({ name }) => name).filter((name) => !Object.prototype.hasOwnProperty.call(aliases, name)));
  const modelAliases: WorkflowCatalogModelAlias[] = [
    ...Object.keys(aliases).map((name) => ({ name, kind: "static" as const, provenance: settingsSources.modelAliases })),
    ...registeredModelAliases.map(({ name, version, headline }) => ({ name, kind: "dynamic" as const, provenance: `extension: ${headline}`, version, headline })),
  ].sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
  const roles: DoctorRole[] = [];
  const definitions = new Map<string, AgentDefinition>();
  const extensionScan = scanExtensionRoleFiles(registeredWorkflowRoleDirectoryRegistrations());
  for (const { registration, error } of extensionScan.errors) {
    const message = errorText(error);
    diagnostics.push(diagnostic("error", "ROLE_DIRECTORY", `${extensionLabel(registration.extension)} role directory "${registration.path}" could not be scanned: ${message}`, registration.path, "Fix or remove the registered role directory."));
  }
  for (const registration of extensionScan.empty) diagnostics.push(diagnostic("warning", "ROLE_DIRECTORY_EMPTY", `${extensionLabel(registration.extension)} role directory "${registration.path}" contains no .md role files`, registration.path, "Add packaged role files or remove the directory registration."));
  const extensionFilesByName = new Map<string, ExtensionRoleFile[]>();
  for (const file of extensionScan.files) extensionFilesByName.set(file.name, [...(extensionFilesByName.get(file.name) ?? []), file]);
  const duplicateExtensionNames = new Set<string>();
  const extensionPaths = new Map<string, string>();
  const starterOverrides = new Map<string, string>();
  const starterOverriddenBy = new Map<string, string>();
  for (const [name, matches] of extensionFilesByName) {
    const regularMatches = matches.filter(({ builtin }) => builtin !== true);
    const starterMatches = matches.filter(({ builtin }) => builtin === true);
    if (regularMatches.length > 1) {
      duplicateExtensionNames.add(name);
      diagnostics.push(diagnostic("error", "ROLE_DUPLICATE", `Duplicate extension role "${name}": ${regularMatches.map(({ path, directory, extension }) => `${extensionLabel(extension)} role directory "${directory}" (${path})`).join("; ")}`, regularMatches[0]?.path, "Keep one extension role with this name; global and project roles may override packaged defaults."));
      continue;
    }
    const extension = regularMatches[0] ?? starterMatches[0];
    if (extension) extensionPaths.set(name, extension.path);
    const regular = regularMatches[0];
    const starter = starterMatches[0];
    if (regular && starter) {
      starterOverrides.set(regular.path, starter.path);
      starterOverriddenBy.set(starter.path, regular.path);
    }
  }
  for (const file of extensionScan.files) {
    const starterPath = starterOverrides.get(file.path);
    const overriddenBy = starterOverriddenBy.get(file.path);
    roles.push({ name: file.name, path: file.path, scope: "extension", active: overriddenBy === undefined, extension: file.extension, ...(starterPath ? { overrides: starterPath } : {}), ...(overriddenBy ? { overriddenBy } : {}) });
    const definition = inspectRole(file.path, activeTools, knownModels, availableModels, diagnostics, aliases, dynamicAliases, settingsPath, { directory: file.directory, extension: file.extension });
    if (duplicateExtensionNames.has(file.name)) continue;
    if (extensionPaths.get(file.name) !== file.path) continue;
    if (definition) definitions.set(file.name, definition);
  }
  const globalPaths = new Map<string, string>();
  const globalRoleDirs = workflowRoleDirectories(agentDir);
  for (const path of roleFilesFrom(globalRoleDirs)) {
    const name = basename(path, ".md");
    const extensionPath = extensionPaths.get(name);
    roles.push({ name, path, scope: "global", active: true, ...(extensionPath ? { overrides: extensionPath } : {}) });
    globalPaths.set(name, path);
    if (extensionPath) {
      const extension = roles.find((role) => role.path === extensionPath);
      if (extension) { extension.active = false; extension.overriddenBy = path; }
    }
    const definition = inspectRole(path, activeTools, knownModels, availableModels, diagnostics, aliases, dynamicAliases, settingsPath);
    if (definition) definitions.set(name, definition); else definitions.delete(name);
  }
  for (const path of roleFilesFrom([join(cwd, ".pi", "pi-extensible-workflows", "roles")])) {
    const name = basename(path, ".md");
    const globalPath = globalPaths.get(name);
    const extensionPath = extensionPaths.get(name);
    const overriddenPath = globalPath ?? extensionPath;
    const active = pi.trust.trusted;
    roles.push({ name, path, scope: "project", active, ...(active && overriddenPath ? { overrides: overriddenPath } : {}) });
    if (!active) continue;
    if (globalPath) {
      const global = roles.find((role) => role.path === globalPath);
      if (global) { global.active = false; global.overriddenBy = path; }
    } else if (extensionPath) {
      const extension = roles.find((role) => role.path === extensionPath);
      if (extension) { extension.active = false; extension.overriddenBy = path; }
    }
    const definition = inspectRole(path, activeTools, knownModels, availableModels, diagnostics, aliases, dynamicAliases, settingsPath);
    if (definition) definitions.set(name, definition); else definitions.delete(name);
  }
  const rolePaths = new Set(roles.map(({ path }) => path));
  if (diagnostics.some(({ code, source }) => source !== undefined && rolePaths.has(source) && (code === "ROLE_FRONTMATTER" || code === "AGENT_RESOURCE_SELECTOR_MIGRATION"))) diagnostics.push(diagnostic("error", "ROLE_LOAD_BLOCKED", "Workflow role loading is blocked because the runtime rejects the complete role set when any active role file is invalid.", undefined, "Fix the reported role file before launching workflows."));
  let roleInspection: DoctorRoleInspection | undefined;
  if (options.role !== undefined) {
    const activeRole = roles.find(({ name, active }) => name === options.role && active);
    const definition = activeRole ? definitions.get(options.role) : undefined;
    if (!activeRole || !definition) diagnostics.push(diagnostic("error", "ROLE_NOT_FOUND", `Active role not found: ${options.role}`, options.role));
    else {
      const rootReference = pi.model ? `${pi.model.provider}/${pi.model.model}` : pi.availableModels[0] ?? pi.knownModels[0];
      if (!rootReference) diagnostics.push(diagnostic("error", "ROLE_INSPECTION_MODEL", "Cannot inspect a role because Pi has no registered model"));
      else {
        let rootModel: ReturnType<typeof resolveModelReference>;
        try {
          if (pi.model) { const thinking = parseThinking(pi.model.thinking); rootModel = { provider: pi.model.provider, model: pi.model.model, ...(thinking ? { thinking } : {}) }; } else rootModel = resolveModelReference(rootReference, aliases, knownModels, settingsPath);
          let roleAliases = aliases;
          if (definition.model && isDynamicModelAlias(definition.model, dynamicAliases)) {
            const dynamic = await registry.resolveModelAliases({ cwd, projectTrusted: pi.trust.trusted, rootModel, knownModels, availableModels, signal: new AbortController().signal });
            roleAliases = { ...aliases, ...dynamic };
          }
          roleInspection = await inspectRoleSession(cwd, agentDir, options.role, definition, activeRole.path, resourcePolicy, rootModel, [...activeTools], roleAliases, knownModels, availableModels, settingsPath, options.prompt ?? "", registry.agentSetupHooks(), diagnostics);
          if (roleInspection) diagnostics.push(...roleInspection.setup.diagnostics);
        } catch (error) { diagnostics.push(diagnostic("error", "ROLE_INSPECTION_MODEL", errorText(error), activeRole.path)); }
      }
    }
  }

  const functions: DoctorFunction[] = [];
  for (const [name, fn] of Object.entries(pi.functions).sort(([left], [right]) => left.localeCompare(right))) {
    functions.push({ name, description: fn.description, valid: true });
  }

  const severityOrder: Record<DoctorSeverity, number> = { error: 0, warning: 1 };
  diagnostics.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity] || (left.source ?? "").localeCompare(right.source ?? "") || left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
  roles.sort((left, right) => left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope));
  return { cwd, agentDir, settingsPath, settings, settingsSources, trust: pi.trust, activeTools: [...activeTools].sort(), piExtensions: [...new Set((pi.extensions ?? []).map(canonical))].sort(), piSkills: [...new Set(pi.skills ?? [])].sort(), roles, functions, modelAliases, resourcePolicy, ...(options.role !== undefined ? { roleTarget: options.role } : {}), ...(roleInspection ? { roleInspection } : {}), diagnostics };
}

function count(report: DoctorReport, severity: DoctorSeverity): number { return report.diagnostics.filter((item) => item.severity === severity).length; }
export function doctorExitCode(report: DoctorReport): 0 | 1 { return count(report, "error") > 0 ? 1 : 0; }
function nestedValues(label: string, values: readonly string[]): string[] {
  return [`- ${label}:`, ...(values.length ? values.map((value) => `  - \`${value}\``) : ["  - (none)"])];
}
function roleSelectorSourceLines(sources: NonNullable<DoctorRoleInspection["resources"]["selectorSources"]>): string[] {
  return [
    ...nestedValues("Global skill selectors", sources.global.skills ?? []),
    ...nestedValues("Global extension selectors", sources.global.extensions ?? []),
    ...nestedValues("Global tool selectors", sources.global.tools ?? []),
    ...nestedValues("Project skill selectors", sources.project.skills ?? []),
    ...nestedValues("Project extension selectors", sources.project.extensions ?? []),
    ...nestedValues("Project tool selectors", sources.project.tools ?? []),
    ...(sources.role === undefined ? [] : [
      ...nestedValues("Role skill selectors", sources.role.skills ?? []),
      ...nestedValues("Role extension selectors", sources.role.extensions ?? []),
      ...nestedValues("Role tool selectors", sources.role.tools ?? []),
    ]),
    ...(sources.call === undefined ? [] : [
      ...nestedValues("Call skill selectors", sources.call.skills ?? []),
      ...nestedValues("Call extension selectors", sources.call.extensions ?? []),
      ...nestedValues("Call tool selectors", sources.call.tools ?? []),
    ]),
  ];
}
function roleInspectionLines(inspection: DoctorRoleInspection): string[] {
  return [
    `- Role: \`${inspection.role}\` - \`${inspection.path}\``,
    `- Model: \`${inspection.model.provider}/${inspection.model.model}\` (${inspection.model.inherited ? "inherited, " : ""}${inspection.model.thinking ?? "off"})`,
    ...(inspection.resources.selectorSources ? roleSelectorSourceLines(inspection.resources.selectorSources) : []),
    ...nestedValues("Tools", inspection.tools),
    ...nestedValues("Configured skill selectors", inspection.resources.selectors.skills),
    ...nestedValues("Effective skills", inspection.resources.skills),
    ...nestedValues("Configured extension selectors", inspection.resources.selectors.extensions),
    ...nestedValues("Effective extensions", inspection.resources.extensions),
    ...nestedValues("Configured tool selectors", inspection.resources.selectors.tools),
    ...nestedValues("Effective tools", inspection.resources.tools),
    ...nestedValues("Unmatched skills", inspection.resources.unmatchedSkills),
    ...nestedValues("Unmatched extensions", inspection.resources.unmatchedExtensions),
    ...nestedValues("Unmatched tools", inspection.resources.unmatchedTools),
    `- Prompt probe: ${inspection.systemPrompt.probe ? JSON.stringify(inspection.systemPrompt.probe) : "empty"}`,
    `- Expanded probe: ${JSON.stringify(inspection.systemPrompt.expandedProbe)}`,
    `- System prompt source: ${inspection.systemPrompt.source ?? "(none)"}`,
    "### Final system prompt",
    "```",
    inspection.systemPrompt.text,
    "```",
    ...nestedValues("Applied setup hooks", inspection.setup.hooks),
    `- Setup diagnostics: ${String(inspection.setup.diagnostics.length)}`,
  ];
}

export function formatDoctorReport(report: DoctorReport): string {
  if (report.roleInspection || report.roleTarget !== undefined) {
    const lines = [
      "# pi-extensible-workflows doctor",
      "",
      "## Role inspection",
      ...(report.roleInspection ? roleInspectionLines(report.roleInspection) : [`- Role: \`${report.roleTarget ?? "(unknown)"}\``, "- Inspection unavailable"]),
      "",
      "## Diagnostics",
      ...(report.diagnostics.length ? report.diagnostics.map((item) => `- [${item.severity}] ${item.code}${item.source ? ` \`${item.source}\`` : ""}: ${item.message}${item.hint ? ` Fix: ${item.hint}` : ""}`) : ["- [ok] No diagnostics"]),
      "",
      "## Summary",
      `- ${String(count(report, "error"))} error(s), ${String(count(report, "warning"))} warning(s)`,
    ];
    return `${lines.join("\n")}\n`;
  }
  const roleLoadingFailed = report.diagnostics.some(({ code }) => code === "ROLE_LOAD_BLOCKED");
  const lines = [
    "# pi-extensible-workflows doctor",
    "",
    "## Environment",
    `- CWD: \`${report.cwd}\``,
    `- Agent dir: \`${report.agentDir}\``,
    `- Global workflow settings: \`${report.settingsPath}\``,
    `- Project workflow settings: \`${report.resourcePolicy.projectSettingsPath}\` (${report.resourcePolicy.projectTrusted ? "trusted" : "ignored: project untrusted"})`,
    `- Effective setting sources: concurrency=\`${report.settingsSources.concurrency}\`, modelAliases=\`${report.settingsSources.modelAliases}\`, skills=\`${report.settingsSources.skills ?? "(none)"}\`, extensions=\`${report.settingsSources.extensions ?? "(none)"}\`, tools=\`${report.settingsSources.tools ?? "(none)"}\``,
    `- Limits: concurrency=${String(report.settings.concurrency)}`,
    "",
    "## Trust/resources",
    `- [${report.trust.trusted ? "ok" : "warning"}] ${report.trust.source}`,
    "",
    "## Pi active tools",
    ...(report.activeTools.length ? report.activeTools.map((tool) => `- \`${tool}\``) : ["- None resolved"]),
    "",
    "## Pi active extensions",
    ...(report.piExtensions.length ? report.piExtensions.map((extension) => `- \`${extension}\``) : ["- None resolved"]),
    "",
    "## Pi active skills",
    ...(report.piSkills.length ? report.piSkills.map((skill) => `- \`${skill}\``) : ["- None resolved"]),
    "",
    "## Workflow agent resource selectors",
    `- Global settings: \`${report.resourcePolicy.globalSettingsPath}\``,
    `- Global skills: ${report.resourcePolicy.global.skills.join(", ") || "(none)"}`,
    `- Global extensions: ${report.resourcePolicy.global.extensions.join(", ") || "(none)"}`,
    `- Global tools: ${(report.resourcePolicy.global.tools ?? []).join(", ") || "(none)"}`,
    `- Project settings: \`${report.resourcePolicy.projectSettingsPath}\` (${report.resourcePolicy.projectTrusted ? "trusted" : "ignored: project untrusted"})`,
    `- Project skills: ${report.resourcePolicy.project.skills.join(", ") || "(none)"}`,
    `- Project extensions: ${report.resourcePolicy.project.extensions.join(", ") || "(none)"}`,
    `- Project tools: ${(report.resourcePolicy.project.tools ?? []).join(", ") || "(none)"}`,
    `- Effective skills: ${(report.resourcePolicy.selectedSkills ?? []).join(", ") || "(none)"}`,
    `- Effective extensions: ${(report.resourcePolicy.selectedExtensions ?? []).join(", ") || "(none)"}`,
    `- Effective tools: ${(report.resourcePolicy.selectedTools ?? []).join(", ") || "(none)"}`,
    `- Unmatched skills: ${report.resourcePolicy.unmatchedSkills.join(", ") || "(none)"}`,
    `- Unmatched extensions: ${report.resourcePolicy.unmatchedExtensions.join(", ") || "(none)"}`,
    `- Unmatched tools: ${(report.resourcePolicy.unmatchedTools ?? []).join(", ") || "(none)"}`,
    "",
    "## Roles",
    ...(report.roles.length ? report.roles.map((role) => `- \`${role.name}\` (${role.scope}, ${role.active ? roleLoadingFailed ? "unavailable: role loading failed" : "active" : role.overriddenBy ? `overridden by ${role.overriddenBy}` : "inactive: project untrusted"}) - \`${role.path}\`${role.extension ? `; ${extensionLabel(role.extension)} role directory "${dirname(role.path)}"` : ""}${role.overrides ? `; overrides \`${role.overrides}\`` : ""}`) : ["- None found"]),
    "",
    "## Model aliases",
    ...(report.modelAliases.length ? report.modelAliases.map((alias) => `- [${alias.kind}] \`${alias.name}\`${alias.kind === "static" ? ` -> ${report.settings.modelAliases?.[alias.name] ?? "(unresolved)"}` : ""} (${alias.provenance})`) : ["- None registered"]),
    "",
    "## Reusable functions",
    ...(report.functions.length ? report.functions.map((fn) => `- [${fn.valid ? "ok" : "error"}] \`${fn.name}\` - ${fn.description}`) : ["- None registered"]),
    "",
    "## Diagnostics",
    ...(report.diagnostics.length ? report.diagnostics.map((item) => `- [${item.severity}] ${item.code}${item.source ? ` \`${item.source}\`` : ""}: ${item.message}${item.hint ? ` Fix: ${item.hint}` : ""}`) : ["- [ok] No diagnostics"]),
    "",
    "## Summary",
    `- ${String(count(report, "error"))} error(s), ${String(count(report, "warning"))} warning(s)`,
  ];
  return `${lines.join("\n")}\n`;
}
