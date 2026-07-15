import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import {
  AuthStorage,
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  hasTrustRequiringProjectResources,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  parseModelReference,
  parseRoleMarkdown,
  preflight,
  workflowDslRegistry,
  WorkflowError,
  type WorkflowScriptDefinition,
  type WorkflowSettings,
} from "./index.js";
import type { AgentDefinition } from "./agent-execution.js";

export type DoctorSeverity = "error" | "warning";
export interface DoctorDiagnostic { severity: DoctorSeverity; code: string; message: string; source?: string; hint?: string }
export interface DoctorRole { name: string; path: string; scope: "global" | "project"; active: boolean; overrides?: string; overriddenBy?: string }
export interface DoctorWorkflow { name: string; description: string; valid: boolean }
export interface DoctorTrust { required: boolean; trusted: boolean; source: string }
export interface DoctorPiState {
  trust: DoctorTrust;
  activeTools: readonly string[];
  knownModels: readonly string[];
  availableModels: readonly string[];
  extensionErrors: readonly { path?: string; message: string }[];
  workflows: Readonly<Record<string, WorkflowScriptDefinition>>;
  extensionVersions: Readonly<Record<string, string>>;
}
export interface DoctorReport {
  cwd: string;
  agentDir: string;
  settingsPath: string;
  settings: Readonly<WorkflowSettings>;
  trust: DoctorTrust;
  activeTools: readonly string[];
  roles: readonly DoctorRole[];
  workflows: readonly DoctorWorkflow[];
  diagnostics: readonly DoctorDiagnostic[];
}
export interface DoctorOptions {
  cwd?: string;
  agentDir?: string;
  settingsPath?: string;
  discoverPi?: (cwd: string, agentDir: string) => Promise<DoctorPiState>;
  activeTools?: readonly string[];
}

const THINKING_HINT = "Use off, minimal, low, medium, high, xhigh, or max.";

function canonical(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); } catch { return absolute; }
}

function readAuthStorage(agentDir: string): AuthStorage {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(agentDir, "auth.json"), "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Pi auth.json must be an object");
    return AuthStorage.inMemory(parsed as NonNullable<Parameters<typeof AuthStorage.inMemory>[0]>);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return AuthStorage.inMemory();
    throw error;
  }
}

function savedTrust(cwd: string, agentDir: string): boolean | undefined {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(join(agentDir, "trust.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Pi trust.json must be an object");
  let current = canonical(cwd);
  while (current !== dirname(current)) {
    const value = (parsed as Record<string, unknown>)[current];
    if (value === true || value === false) return value;
    current = dirname(current);
  }
  const value = (parsed as Record<string, unknown>)[current];
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
    const services = await createAgentSessionServices({
      cwd,
      agentDir,
      settingsManager,
      authStorage: readAuthStorage(agentDir),
      resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true },
      resourceLoaderReloadOptions: { resolveProjectTrust: async () => trusted },
    });
    const allModels = services.modelRegistry.getAll();
    const availableModels = services.modelRegistry.getAvailable();
    const model = availableModels[0] ?? allModels[0];
    if (!model) throw new Error("Pi has no models registered");
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(), model });
    const activeTools = session.agent.state.tools.map(({ name }) => name).filter((name) => name !== "workflow" && name !== "workflow_respond");
    session.dispose();
    const extensions = services.resourceLoader.getExtensions();
    return {
      trust: { required, trusted, source },
      activeTools,
      knownModels: allModels.map(({ provider, id }) => `${provider}/${id}`),
      availableModels: availableModels.map(({ provider, id }) => `${provider}/${id}`),
      extensionErrors: [
        ...extensions.errors.map(({ path, error }) => ({ path, message: error })),
        ...services.diagnostics.filter(({ type }) => type === "error").map(({ message }) => ({ message })),
      ],
      workflows: workflowDslRegistry.workflows(),
      extensionVersions: workflowDslRegistry.versions(),
    };
  } finally {
    if (previousOffline === undefined) delete process.env.PI_OFFLINE;
    else process.env.PI_OFFLINE = previousOffline;
  }
}

function roleFiles(dir: string): string[] {
  try { return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isFile() && extname(entry.name) === ".md").map((entry) => join(dir, entry.name)).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}

function diagnostic(severity: DoctorSeverity, code: string, message: string, source?: string, hint?: string): DoctorDiagnostic {
  return { severity, code, message, ...(source ? { source } : {}), ...(hint ? { hint } : {}) };
}

function validateModel(value: string, known: ReadonlySet<string>, available: ReadonlySet<string>, source: string, diagnostics: DoctorDiagnostic[]): void {
  try {
    const parsed = parseModelReference(value);
    const name = `${parsed.provider}/${parsed.model}`;
    if (!known.has(name) || !available.has(name)) diagnostics.push(diagnostic("warning", "MODEL_UNAVAILABLE", `Model is valid-shaped but unavailable: ${name}`, source));
  } catch (error) {
    diagnostics.push(diagnostic("error", "MODEL_INVALID", (error as Error).message, source, (error as Error).message.includes("thinking") ? THINKING_HINT : "Use provider/model or provider/model:thinking."));
  }
}

function inspectRole(path: string, activeTools: ReadonlySet<string>, knownModels: ReadonlySet<string>, availableModels: ReadonlySet<string>, diagnostics: DoctorDiagnostic[]): AgentDefinition | undefined {
  let definition: AgentDefinition;
  try { definition = parseRoleMarkdown(readFileSync(path, "utf8"), true); }
  catch (error) {
    diagnostics.push(diagnostic("error", "ROLE_FRONTMATTER", (error as Error).message, path, "Fix the role YAML frontmatter."));
    return undefined;
  }
  const body = definition.prompt ?? "";
  if (body.trim() === "") diagnostics.push(diagnostic("warning", "ROLE_BODY_EMPTY", "Role body is empty", path));
  if (Buffer.byteLength(body) > 50 * 1024) diagnostics.push(diagnostic("warning", "ROLE_BODY_LARGE", "Role body exceeds 50KB", path));
  if (/{{\s*[^{}]+\s*}}/.test(body)) diagnostics.push(diagnostic("warning", "ROLE_PLACEHOLDER", "Role body contains an unsupported placeholder-looking token", path));
  if (definition.model) validateModel(definition.model, knownModels, availableModels, path, diagnostics);
  for (const tool of definition.tools ?? []) if (!activeTools.has(tool)) diagnostics.push(diagnostic("error", "ROLE_TOOL_INACTIVE", `Tool is unknown or inactive: ${tool}`, path, "Use a tool listed under Active tools or enable its Pi extension."));
  return definition;
}

class DoctorModelSet extends Set<string> {
  override has(value: string): boolean { parseModelReference(value); return true; }
}

export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const cwd = canonical(options.cwd ?? process.cwd());
  const agentDir = canonical(options.agentDir ?? getAgentDir());
  const settingsPath = canonical(options.settingsPath ?? join(homedir(), ".pi", "workflows", "settings.json"));
  const diagnostics: DoctorDiagnostic[] = [];
  let settings = DEFAULT_SETTINGS;
  try { settings = loadSettings(settingsPath); }
  catch (error) { diagnostics.push(diagnostic("error", "SETTINGS_INVALID", (error as Error).message, settingsPath, "Fix or remove the invalid workflow settings file.")); }

  let pi: DoctorPiState;
  try { pi = await (options.discoverPi ?? discoverPi)(cwd, agentDir); }
  catch (error) {
    diagnostics.push(diagnostic("error", "PI_DISCOVERY", `Pi headless discovery failed: ${(error as Error).message}`, undefined, "Open and trust the project in Pi, fix extension errors, then rerun doctor."));
    pi = { trust: { required: false, trusted: false, source: "discovery failed" }, activeTools: [], knownModels: [], availableModels: [], extensionErrors: [], workflows: {}, extensionVersions: {} };
  }
  if (options.activeTools) pi = { ...pi, activeTools: options.activeTools };
  if (pi.trust.required && !pi.trust.trusted) diagnostics.push(diagnostic("warning", "PROJECT_UNTRUSTED", "Pi project resources are inactive because the project is not trusted", cwd, "Open this project in Pi, choose Trust, then rerun doctor."));
  for (const error of pi.extensionErrors) diagnostics.push(diagnostic("error", "EXTENSION_LOAD", error.message, error.path, "Fix or disable the failing Pi extension."));

  const activeTools = new Set(pi.activeTools);
  const knownModels = new Set(pi.knownModels);
  const availableModels = new Set(pi.availableModels);
  const roles: DoctorRole[] = [];
  const definitions = new Map<string, AgentDefinition>();
  const globalPaths = new Map<string, string>();
  const globalRoleDir = join(dirname(agentDir), "piworkflows", "roles");
  for (const path of roleFiles(globalRoleDir)) {
    const name = basename(path, ".md");
    roles.push({ name, path, scope: "global", active: true });
    globalPaths.set(name, path);
    const definition = inspectRole(path, activeTools, knownModels, availableModels, diagnostics);
    if (definition) definitions.set(name, definition);
  }
  for (const path of roleFiles(join(cwd, ".pi", "piworkflows", "roles"))) {
    const name = basename(path, ".md");
    const globalPath = globalPaths.get(name);
    const active = pi.trust.trusted;
    roles.push({ name, path, scope: "project", active, ...(active && globalPath ? { overrides: globalPath } : {}) });
    if (!active) continue;
    if (globalPath) {
      const global = roles.find((role) => role.path === globalPath);
      if (global) { global.active = false; global.overriddenBy = path; }
    }
    const definition = inspectRole(path, activeTools, knownModels, availableModels, diagnostics);
    if (definition) definitions.set(name, definition); else definitions.delete(name);
  }

  const workflows: DoctorWorkflow[] = [];
  for (const [name, workflow] of Object.entries(pi.workflows).sort(([left], [right]) => left.localeCompare(right))) {
    let valid = true;
    try {
      const checked = preflight(workflow.script, {
        models: new DoctorModelSet(pi.knownModels),
        tools: activeTools,
        agentTypes: new Set(definitions.keys()),
        extensions: pi.extensionVersions,
      }, [], { name, description: workflow.description, ...(workflow.extensions ? { extensions: workflow.extensions } : {}) });
      for (const model of checked.referenced.models) if (!knownModels.has(model) || !availableModels.has(model)) diagnostics.push(diagnostic("warning", "MODEL_UNAVAILABLE", `Model is valid-shaped but unavailable: ${model}`, name));
    } catch (error) {
      valid = false;
      const typed = error instanceof WorkflowError ? error : new WorkflowError("INTERNAL_ERROR", String(error));
      diagnostics.push(diagnostic("error", `WORKFLOW_${typed.code}`, typed.message, name, "Fix the registered workflow source or its referenced role/tool/model/extension."));
    }
    workflows.push({ name, description: workflow.description, valid });
  }

  const severityOrder: Record<DoctorSeverity, number> = { error: 0, warning: 1 };
  diagnostics.sort((left, right) => severityOrder[left.severity] - severityOrder[right.severity] || (left.source ?? "").localeCompare(right.source ?? "") || left.code.localeCompare(right.code) || left.message.localeCompare(right.message));
  roles.sort((left, right) => left.name.localeCompare(right.name) || left.scope.localeCompare(right.scope));
  return { cwd, agentDir, settingsPath, settings, trust: pi.trust, activeTools: [...activeTools].sort(), roles, workflows, diagnostics };
}

function count(report: DoctorReport, severity: DoctorSeverity): number { return report.diagnostics.filter((item) => item.severity === severity).length; }

export function doctorExitCode(report: DoctorReport): 0 | 1 { return count(report, "error") > 0 ? 1 : 0; }

export function formatDoctorReport(report: DoctorReport): string {
  const lines = [
    "# pi-workflows doctor",
    "",
    "## Environment",
    `- CWD: \`${report.cwd}\``,
    `- Agent dir: \`${report.agentDir}\``,
    `- Workflow settings: \`${report.settingsPath}\``,
    `- Limits: concurrency=${String(report.settings.concurrency)}, maxAgentLaunches=${String(report.settings.maxAgentLaunches)}`,
    "",
    "## Trust/resources",
    `- [${report.trust.trusted ? "ok" : "warning"}] ${report.trust.source}`,
    "",
    "## Active tools",
    ...(report.activeTools.length ? report.activeTools.map((tool) => `- \`${tool}\``) : ["- None resolved"]),
    "",
    "## Roles",
    ...(report.roles.length ? report.roles.map((role) => `- \`${role.name}\` (${role.scope}, ${role.active ? "active" : role.overriddenBy ? `overridden by ${role.overriddenBy}` : "inactive: project untrusted"}) - \`${role.path}\`${role.overrides ? `; overrides \`${role.overrides}\`` : ""}`) : ["- None found"]),
    "",
    "## Reusable workflows",
    ...(report.workflows.length ? report.workflows.map((workflow) => `- [${workflow.valid ? "ok" : "error"}] \`${workflow.name}\` - ${workflow.description}`) : ["- None registered"]),
    "",
    "## Diagnostics",
    ...(report.diagnostics.length ? report.diagnostics.map((item) => `- [${item.severity}] ${item.code}${item.source ? ` \`${item.source}\`` : ""}: ${item.message}${item.hint ? ` Fix: ${item.hint}` : ""}`) : ["- [ok] No diagnostics"]),
    "",
    "## Summary",
    `- ${String(count(report, "error"))} error(s), ${String(count(report, "warning"))} warning(s)`,
  ];
  return `${lines.join("\n")}\n`;
}
