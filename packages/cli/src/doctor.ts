
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, type Credential } from "@earendil-works/pi-ai";
import { createEventBus, ModelRuntime, createAgentSessionFromServices, createAgentSessionServices, getAgentDir, hasTrustRequiringProjectResources, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createLocalPiSession, prepareAgentSetupForInspection, selectResourcesByLayers, unmatchedResourcePatterns, validateAgentOptions, type AgentExecutionRoot, type AgentTransport, type JsonValue, type ModelSpec, DEFAULT_SETTINGS, canonicalPath, reachableTools, errorText, isNodeError, isObject, loadSettings, resolveAgentResourcePolicy, resolveWorkflowSettings, resolveModelReference, parseThinking, registeredWorkflowFunctions, workflowProjectSettingsPath, workflowSettingsPath, type AgentResourcePolicy, type WorkflowCatalogModelAlias, type WorkflowFunction, type WorkflowSettings, type WorkflowSettingsSources } from "pi-extensible-workflows";
import { loadingRegistry, type WorkflowRegistryApi } from "pi-extensible-workflows";

export type DoctorSeverity = "error" | "warning";
export interface DoctorDiagnostic { severity: DoctorSeverity; code: string; message: string; source?: string; hint?: string }
export interface DoctorFunction { name: string; description: string; valid: boolean }
export interface DoctorTrust { required: boolean; trusted: boolean; source: string }
export interface DoctorAgentInspection {
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
  dispose?: () => Promise<void>;
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
  functions: readonly DoctorFunction[];
  resourcePolicy: AgentResourcePolicy;
  modelAliases: readonly WorkflowCatalogModelAlias[];
  agentInspection?: DoctorAgentInspection;
  diagnostics: readonly DoctorDiagnostic[];
}
export interface DoctorOptions {
  cwd?: string;
  agentDir?: string;
  settingsPath?: string;
  agentOptions?: Readonly<Record<string, import("pi-extensible-workflows").JsonValue>>;
  prompt?: string;
  discoverPi?: (cwd: string, agentDir: string) => Promise<DoctorPiState>;
  activeTools?: readonly string[];
  registry?: WorkflowRegistryApi;
}


const AGENT_RESOURCE_SELECTOR_MIGRATION_ISSUE = "https://github.com/vekexasia/pi-extensible-workflows/issues/205";
const AGENT_RESOURCE_SELECTOR_MIGRATION_MESSAGE = `\`disabledAgentResources\` is no longer supported by #205. Migrate to direct \`skills\`, \`extensions\`, and \`tools\` selectors: legacy patterns exclude resources and \`!pattern\` re-enables them, while new selectors include matches and \`!pattern\` excludes them. See ${AGENT_RESOURCE_SELECTOR_MIGRATION_ISSUE}`;

function usesLegacySettings(path: string): boolean {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isObject(parsed) && Object.prototype.hasOwnProperty.call(parsed, "disabledAgentResources");
  } catch { return false; }
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
  let current = canonicalPath(cwd);
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
    const bus = createEventBus();
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      modelRuntime,
      resourceLoaderOptions: { eventBus: bus, noPromptTemplates: true, noThemes: true, noContextFiles: true },
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => trusted },
    });
    const allModels = services.modelRuntime.getModels();
    const availableModels = await services.modelRuntime.getAvailable();
    const model = availableModels[0] ?? allModels[0];
    if (!model) throw new Error("Pi has no models registered");
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(), model });
    try {
      await session.bindExtensions({ mode: "print" });
      const activeTools = reachableTools({ getActiveTools: () => session.getActiveToolNames(), getAllTools: () => session.getAllTools() }).filter((name) => name !== "workflow" && name !== "workflow_respond" && name !== "workflow_catalog");
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
        dispose: async () => { try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }); } finally { session.dispose(); bus.clear(); } },
      };
    } catch (error) { session.dispose(); bus.clear(); throw error; }
  } finally {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  }
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
function matchResourcePolicy(policy: AgentResourcePolicy, pi: DoctorPiState): AgentResourcePolicy {
  const extensions = [...new Set((pi.extensions ?? []).map(canonicalPath))];
  const skills = [...new Set(pi.skills ?? [])];
  const tools = [...new Set(pi.activeTools)];
  const layers = policy.selectorSources;
  const selectedSkills = selectResourcesByLayers([layers.global.skills, layers.project.skills], skills);
  const selectedExtensions = selectResourcesByLayers([layers.global.extensions, layers.project.extensions], extensions);
  const selectedTools = selectResourcesByLayers([layers.global.tools, layers.project.tools], tools);
  return { ...policy, selectedSkills, selectedExtensions, selectedTools, unmatchedSkills: unmatchedResourcePatterns(policy.effective.skills, skills), unmatchedExtensions: unmatchedResourcePatterns(policy.effective.extensions, extensions), unmatchedTools: unmatchedResourcePatterns(policy.effective.tools ?? [], tools) };
}
async function inspectAgentSession(cwd: string, agentDir: string, agentOptions: Readonly<Record<string, JsonValue>>, basePolicy: AgentResourcePolicy, rootModel: ModelSpec, activeTools: readonly string[], aliases: Readonly<Record<string, string>>, knownModels: ReadonlySet<string>, availableModels: ReadonlySet<string>, settingsPath: string, extensionSettings: Readonly<WorkflowSettings["extensionSettings"]>, prompt: string, registry: WorkflowRegistryApi, diagnostics: DoctorDiagnostic[]): Promise<DoctorAgentInspection | undefined> {
  const transport: AgentTransport = { id: "doctor-local", createSession: async () => { throw new Error("Doctor inspection does not create transport sessions"); } };
  const root: AgentExecutionRoot = { cwd, projectTrusted: basePolicy.projectTrusted, model: rootModel, tools: new Set(activeTools), resourceSelectors: basePolicy.effective, agentDir, extensionSettings, modelAliases: aliases, knownModels, availableModels, settingsPath, onResourceWarning: (message) => { diagnostics.push(diagnostic("warning", "AGENT_RESOURCE_UNMATCHED", message)); }, agentPreparationHooks: registry.agentPreparationHooks(), validateExtensionSettings: (settings, context) => { registry.validateExtensionSettings(settings, context); }, agentSetupHooks: registry.agentSetupHooks(), agentResourcePolicy: () => structuredClone(basePolicy) };
  const validated = validateAgentOptions(agentOptions);
  const prepared = await prepareAgentSetupForInspection(root, prompt, { label: "doctor", workflowName: "doctor", agentOptions: validated }, transport);
  if (prepared.failure) throw prepared.failure.error;
  const session = await createLocalPiSession({ ...prepared.setup.sessionInput, sessionManager: SessionManager.inMemory() });
  try {
    const result = await session.preparePrompt(prepared.setup.prompt);
    const resources = session.getResourceInspection();
    const policy = prepared.setup.sessionInput.resourcePolicy ?? basePolicy;
    const setupDiagnostics = [...resources.diagnostics, ...result.diagnostics].map((item) => diagnostic(item.type === "error" ? "error" : "warning", "AGENT_INSPECTION", item.message, item.source));
    return { model: prepared.setup.sessionInput.model, tools: session.agent?.state.tools.map(({ name }) => name) ?? prepared.setup.sessionInput.tools, resources: { selectors: { skills: [...policy.effective.skills], extensions: [...policy.effective.extensions], tools: [...(policy.effective.tools ?? [])] }, skills: resources.skills, extensions: resources.extensions, tools: policy.selectedTools ?? prepared.setup.sessionInput.tools, unmatchedSkills: policy.unmatchedSkills, unmatchedExtensions: policy.unmatchedExtensions, unmatchedTools: policy.unmatchedTools ?? [], selectorSources: policy.selectorSources }, systemPrompt: { probe: prompt, expandedProbe: result.expandedPrompt, text: result.systemPrompt, ...(resources.systemPromptSource ? { source: resources.systemPromptSource } : {}) }, setup: { hooks: prepared.summary.hookNames, diagnostics: setupDiagnostics } };
  } catch (error) { diagnostics.push(diagnostic("error", "AGENT_INSPECTION", errorText(error))); return undefined; }
  finally { await session.dispose(); }
}
function resourcePolicySource(settingsSource: string): string { return settingsSource; }
function validateDoctorExtensionSettings(registry: WorkflowRegistryApi, value: Readonly<WorkflowSettings["extensionSettings"]>, source: "global" | "project" | "effective", cwd: string, projectTrusted: boolean, settingsPath: string, diagnostics: DoctorDiagnostic[]): void {
  try { registry.validateExtensionSettings(value, { source, cwd, projectTrusted, settingsPath }); }
  catch (error) { diagnostics.push(diagnostic("error", "SETTINGS_INVALID", errorText(error), `${settingsPath}.extensionSettings`, "Fix the extension-owned settings reported in this error.")); }
}
export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = canonicalPath(options.cwd ?? process.cwd());
  const agentDir = canonicalPath(options.agentDir ?? getAgentDir());
  const settingsPath = canonicalPath(options.settingsPath ?? workflowSettingsPath(agentDir));
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
  const registry = options.registry ?? loadingRegistry();
  try {
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
    if (resolved.global.extensionSettings !== undefined) validateDoctorExtensionSettings(registry, resolved.global.extensionSettings, "global", cwd, pi.trust.trusted, resolved.globalSettingsPath, diagnostics);
    if (pi.trust.trusted && resolved.project.extensionSettings !== undefined) validateDoctorExtensionSettings(registry, resolved.project.extensionSettings, "project", cwd, true, resolved.projectSettingsPath, diagnostics);
    validateDoctorExtensionSettings(registry, resolved.effective.extensionSettings, "effective", cwd, pi.trust.trusted, settingsSources.extensionSettings ?? settingsPath, diagnostics);
  } catch (error) {
    const message = errorText(error);
    const source = [projectSettingsPath].find(path => message.includes(path)) ?? settingsPath;
    if (!diagnostics.some(({ code, source: itemSource }) => code === "SETTINGS_INVALID" && itemSource === source)) diagnostics.push(diagnostic("error", "SETTINGS_INVALID", message, source, "Fix or remove the invalid workflow settings file."));
  }
  let resourcePolicy: AgentResourcePolicy;
  try { resourcePolicy = matchResourcePolicy(resolveAgentResourcePolicy(cwd, pi.trust.trusted, settingsPath), pi); }
  catch (error) { diagnostics.push(diagnostic("error", "SETTINGS_INVALID", errorText(error), settingsPath)); resourcePolicy = emptyResourcePolicy(settingsPath, cwd, pi.trust.trusted); }
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
  const registeredModelAliases = registry.modelAliases();
  const modelAliases: WorkflowCatalogModelAlias[] = [
    ...Object.keys(aliases).map((name) => ({ name, kind: "static" as const, provenance: settingsSources.modelAliases })),
    ...registeredModelAliases.map(({ name, version, headline }) => ({ name, kind: "dynamic" as const, provenance: `extension: ${headline}`, version, headline })),
  ].sort((left, right) => left.name.localeCompare(right.name) || left.kind.localeCompare(right.kind));
  let agentInspection: DoctorAgentInspection | undefined;
  if (options.agentOptions !== undefined) {
    try {
      const rootReference = pi.model ? `${pi.model.provider}/${pi.model.model}` : pi.availableModels[0] ?? pi.knownModels[0];
      if (!rootReference) throw new Error("Cannot inspect an agent because Pi has no registered model");
      const thinking = parseThinking(pi.model?.thinking);
      const rootModel = pi.model ? { provider: pi.model.provider, model: pi.model.model, ...(thinking ? { thinking } : {}) } : resolveModelReference(rootReference, aliases, knownModels, settingsPath);
      const dynamic = await registry.resolveModelAliases({ cwd, projectTrusted: pi.trust.trusted, rootModel, knownModels, availableModels, signal: new AbortController().signal }, new Set(Object.keys(aliases)));
      agentInspection = await inspectAgentSession(cwd, agentDir, options.agentOptions, resourcePolicy, rootModel, [...activeTools], { ...dynamic, ...aliases }, knownModels, availableModels, settingsPath, settings.extensionSettings, options.prompt ?? "", registry, diagnostics);
      if (agentInspection) diagnostics.push(...agentInspection.setup.diagnostics);
    } catch (error) { diagnostics.push(diagnostic("error", "AGENT_INSPECTION", errorText(error), settingsPath)); }
  }

  const functions: DoctorFunction[] = [];
  for (const [name, fn] of Object.entries(pi.functions).sort(([left], [right]) => left.localeCompare(right))) {
    functions.push({ name, description: fn.description, valid: true });
  }

  const severityOrder: Record<DoctorSeverity, number> = { error: 0, warning: 1 };
  diagnostics.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity] || (left.source ?? "").localeCompare(right.source ?? "") || left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
  return { cwd, agentDir, settingsPath, settings, settingsSources, trust: pi.trust, activeTools: [...activeTools].sort(), piExtensions: [...new Set((pi.extensions ?? []).map(canonicalPath))].sort(), piSkills: [...new Set(pi.skills ?? [])].sort(), functions, modelAliases, resourcePolicy, ...(agentInspection ? { agentInspection } : {}), diagnostics };
  } finally { await pi.dispose?.(); }
}

function count(report: DoctorReport, severity: DoctorSeverity): number { return report.diagnostics.filter((item) => item.severity === severity).length; }
export function doctorExitCode(report: DoctorReport): 0 | 1 { return count(report, "error") > 0 ? 1 : 0; }
function nestedValues(label: string, values: readonly string[]): string[] {
  return [`- ${label}:`, ...(values.length ? values.map((value) => `  - \`${value}\``) : ["  - (none)"])];
}
function agentInspectionLines(inspection: DoctorAgentInspection): string[] {
  return [
    `- Model: \`${inspection.model.provider}/${inspection.model.model}\` (${inspection.model.inherited ? "inherited, " : ""}${inspection.model.thinking ?? "off"})`,
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
  if (report.agentInspection) {
    const lines = [
      "# pi-extensible-workflows doctor",
      "",
      "## Agent inspection",
      ...agentInspectionLines(report.agentInspection),
      "",
      "## Diagnostics",
      ...(report.diagnostics.length ? report.diagnostics.map((item) => `- [${item.severity}] ${item.code}${item.source ? ` \`${item.source}\`` : ""}: ${item.message}${item.hint ? ` Fix: ${item.hint}` : ""}`) : ["- [ok] No diagnostics"]),
      "",
      "## Summary",
      `- ${String(count(report, "error"))} error(s), ${String(count(report, "warning"))} warning(s)`,
    ];
    return `${lines.join("\n")}\n`;
  }
  const lines = [
    "# pi-extensible-workflows doctor",
    "",
    "## Environment",
    `- CWD: \`${report.cwd}\``,
    `- Agent dir: \`${report.agentDir}\``,
    `- Global workflow settings: \`${report.settingsPath}\``,
    `- Project workflow settings: \`${report.resourcePolicy.projectSettingsPath}\` (${report.resourcePolicy.projectTrusted ? "trusted" : "ignored: project untrusted"})`,
    `- Effective setting sources: concurrency=\`${report.settingsSources.concurrency}\`, modelAliases=\`${report.settingsSources.modelAliases}\`, skills=\`${report.settingsSources.skills ?? "(none)"}\`, extensions=\`${report.settingsSources.extensions ?? "(none)"}\`, extensionSettings=\`${report.settingsSources.extensionSettings ?? "(none)"}\`, tools=\`${report.settingsSources.tools ?? "(none)"}\``,
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
