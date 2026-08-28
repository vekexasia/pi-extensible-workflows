import { randomBytes } from "node:crypto";
import { existsSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { createServer } from "node:net";
import type { Socket } from "node:net";
import { join } from "node:path";
import { createExtensionRuntime, ExtensionRunner, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentEndEvent, AgentStartEvent, ExtensionAPI, ExtensionContext, InlineExtension, SessionShutdownEvent, SessionStartEvent, TurnEndEvent } from "@earendil-works/pi-coding-agent";
import {
  WORKFLOW_BLOCKED_EVENT,
  WORKFLOW_RUN_COMPLETED_EVENT,
  WORKFLOW_RUN_STATE_CHANGED_EVENT,
  createHerdrAgentReporter,
  createToolTimingExtension,
  errorText,
  herdrAvailable,
  herdrCommandRunner,
  loadSettings,
  openHerdrLivePane,
  waitForHerdrPane,
  registerWorkflowExtension,
  workflowSettingsPath,
} from "pi-extensible-workflows";
import type {
  AgentAttemptAction,
  AgentAttemptActionContext,
  StandaloneAgentAttemptActionContext,
  AgentIdentity,
  AgentSetup,
  AgentSetupContext,
  AgentSetupHook,
  AgentTransport,
  HerdrAgentReporter,
  HerdrAgentStatus,
  HerdrCommandRunner,
  HerdrWorkspacePane,
  HerdrWorkspacePaneRequest,
  PreparedAgentSession,
  ContextFile,
  WorkflowAgentMessage,
  WorkflowAgentSession,
  WorkflowAgentSessionReference,
  WorkflowExtension,
  WorkflowRunContext,
  WorkflowSettings,
  HerdrExtensionSettings,
} from "pi-extensible-workflows";

type HerdrSettings = Pick<WorkflowSettings, "extensions" | "extensionSettings">;
type HerdrConfig = HerdrExtensionSettings;
type HerdrResourcePaths = { extensions: readonly string[]; skills: readonly string[] };
type HerdrModelContext = { readonly model: ExtensionContext["model"]; readonly modelRegistry: ModelRegistry | undefined };
type HerdrSession = Omit<WorkflowAgentSession, "getLastAssistant" | "abort"> & { getLastAssistant?(): WorkflowAgentMessage | undefined; abort(): Promise<void>; getHerdrResourcePaths?(): HerdrResourcePaths | undefined; getHerdrContextFiles?(): readonly ContextFile[] | undefined; getHerdrModelContext?(): HerdrModelContext | undefined };
type SessionReference = Parameters<HerdrAgentReporter["reportSession"]>[0];
type ToolCallContent = { type: "toolCall"; name?: string };
type LifecycleState = "idle" | "working" | "blocked";
type LifecycleReport = { state: LifecycleState; message: string | undefined };
type HerdrBlockedEvent = { active: boolean; label?: string };
type ExtensionBridge = { extensionPath: string; close(): Promise<void> };
type CommandFiles = { systemPrompt: string | undefined; appendPrompt: string | undefined; contextPrompt: string | undefined; prompt: string | undefined; command(value: string): string; close(): Promise<void> };
type HerdrToolDefinition = NonNullable<PreparedAgentSession["customTools"]>[number];
type HerdrCommandResult = Awaited<ReturnType<typeof openHerdrLivePane>>;
type ToolBridgeRequest = { toolCallId: string; name: string; params: unknown };
type ToolBridgeMessage = { type: "update"; value: unknown } | { type: "error"; error: string } | { type: "result"; value: unknown };
type WorkspaceManager = { open(run: Readonly<WorkflowRunContext>, request: HerdrWorkspacePaneRequest): Promise<HerdrWorkspacePane>; close(runId: string): Promise<void>; closeAll(): Promise<void> };
type LaunchPaneOptions = { session: HerdrSession; prepared: Readonly<PreparedAgentSession>; identity: Readonly<AgentIdentity>; run?: Readonly<WorkflowRunContext> | undefined; attempt: number; runner: HerdrCommandRunner; fullyInspectable: boolean; env: NodeJS.ProcessEnv; signal: AbortSignal; prompt?: string | undefined; workspaces?: WorkspaceManager | undefined; tuiIndex?: number | undefined; tuiLabel?: string | undefined; directPrompt?: boolean | undefined; onStatus?: ((state: HerdrAgentStatus) => void | Promise<void>) | undefined };
type PaneHandle = { pane: string; monitor: Promise<"closed" | "exited" | "idle" | "aborted">; reporter: HerdrAgentReporter; closeRemote(): Promise<void>; close(): Promise<void> };
type HerdrBreadcrumbIdentity = Omit<AgentIdentity, "structuralPath"> & { structuralPath?: readonly string[] };
type CompletedSessionContext = { attempt?: { setup?: { cwd?: string } }; run?: { cwd?: string } };
type HerdrAttemptActionContext = AgentAttemptActionContext | StandaloneAgentAttemptActionContext;
export interface HerdrExtensionOptions { env?: NodeJS.ProcessEnv; runner?: HerdrCommandRunner; workspaces?: WorkspaceManager; agentDir?: string }
type HerdrExtensionOverrides = Pick<HerdrExtensionOptions, "env" | "runner" | "workspaces">;
export interface HerdrExtension extends WorkflowExtension { agentAttemptActions: { openSession: AgentAttemptAction; openLiveSession: AgentAttemptAction }; agentSetupHooks: { fullyInspectable: AgentSetupHook } }

function agentDir(): string { return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"); }

function settings(agentDirectory = agentDir()): HerdrSettings {
  try { return loadSettings(workflowSettingsPath(agentDirectory)); }
  catch { return {}; }
}

function herdrConfig(agentDirectory = agentDir()): HerdrConfig {
  const workflowSettings = settings(agentDirectory);
  return workflowSettings.extensionSettings?.herdr ?? {};
}

export function isFullyInspectableMode(agentDirectory = agentDir()): boolean { return herdrConfig(agentDirectory).enableFullyInspectableMode === true; }

export function breadcrumbLabel(identity: Readonly<HerdrBreadcrumbIdentity>, attempt = 1): string {
  const parts = [
    ...(identity.structuralPath ?? []),
    ...(identity.parentBreadcrumb ? [identity.parentBreadcrumb] : []),
    ...(identity.worktreeOwner ? [`worktree:${identity.worktreeOwner}`] : []),
    identity.callSite,
  ].filter((part) => typeof part === "string" && part.trim());
  return `${parts.join(" > ")} #${String(attempt)}`;
}

function quote(value: string): string { return `'${value.replace(/'/g, `'\\''`)}'`; }
function messageContent(message: unknown): unknown { return message !== null && typeof message === "object" && !Array.isArray(message) ? (message as Record<string, unknown>).content : undefined; }
function hasToolCall(message: unknown): boolean { const content = messageContent(message); return Array.isArray(content) && content.some((part: unknown): part is ToolCallContent => part !== null && typeof part === "object" && (part as { type?: unknown }).type === "toolCall"); }
function hasNamedToolCall(message: unknown, name: string): boolean { const content = messageContent(message); return Array.isArray(content) && content.some((part: unknown): part is ToolCallContent => part !== null && typeof part === "object" && (part as { type?: unknown }).type === "toolCall" && (part as ToolCallContent).name === name); }
function needsContinuation(message: WorkflowAgentMessage | undefined): boolean { return !message || message.stopReason === "aborted" || hasToolCall(message); }
function usableCwd(cwd: string | undefined): boolean {
  if (typeof cwd !== "string" || !cwd.trim()) return false;
  try { return statSync(cwd).isDirectory(); } catch { return false; }
}
function completedSessionCwd(context: Readonly<CompletedSessionContext>): string | undefined { return [context.attempt?.setup?.cwd, context.run?.cwd].find(usableCwd); }
function formatContextFiles(files: readonly ContextFile[]): string { return files.length ? `<project_context>\n\nProject-specific instructions and guidelines:\n\n${files.map(({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`).join("\n\n")}\n</project_context>\n` : ""; }
function createCommandFiles(prepared: Readonly<PreparedAgentSession>, prompt: string | undefined, directPrompt: boolean, contextFiles: readonly ContextFile[] | undefined): CommandFiles {
  const paths: string[] = [];
  const create = (kind: string, value: string): string => {
    const path = join(tmpdir(), `pi-herdr-${kind}-${String(process.pid)}-${randomBytes(6).toString("hex")}.txt`);
    writeFileSync(path, value, { encoding: "utf8", mode: 0o600 });
    paths.push(path);
    return path;
  };
  const files = {
    systemPrompt: prepared.systemPrompt === undefined ? undefined : create("system-prompt", prepared.systemPrompt),
    appendPrompt: prepared.systemPromptAppend ? create("append-prompt", prepared.systemPromptAppend) : undefined,
    contextPrompt: contextFiles && formatContextFiles(contextFiles) ? create("context-prompt", formatContextFiles(contextFiles)) : undefined,
    prompt: prompt === undefined || directPrompt ? undefined : create("prompt", prompt),
  };
  return { ...files, command(value: string): string { return `sh ${quote(create("command", `${value}\n`))}`; }, async close(): Promise<void> { for (const path of paths) { try { unlinkSync(path); } catch { /* Cleanup is best effort after the child exits. */ } } } };
}
function resourcePaths(session: HerdrSession): HerdrResourcePaths {
  const value = session.getHerdrResourcePaths?.();
  if (!value || typeof value !== "object") return { extensions: [], skills: [] };
  return {
    extensions: Array.isArray(value.extensions) ? value.extensions.filter((path): path is string => typeof path === "string") : [],
    skills: Array.isArray(value.skills) ? value.skills.filter((path): path is string => typeof path === "string") : [],
  };
}
function sessionPath(reference: WorkflowAgentSessionReference | undefined): string | undefined {
  const locator = reference?.locator;
  return locator && typeof locator === "object" && !Array.isArray(locator) && typeof locator.sessionFile === "string" ? locator.sessionFile : undefined;
}

function materializeSessionForHandoff(session: HerdrSession, prepared: Readonly<PreparedAgentSession>): void {
  const path = sessionPath(session.reference);
  if (!path || existsSync(path)) return;
  const manager = SessionManager.inMemory(prepared.cwd, session.reference.sessionId ? { id: session.reference.sessionId } : undefined);
  manager.appendSessionInfo(prepared.sessionLabel);
  const header = manager.getHeader();
  if (!header) throw new Error("Herdr cannot materialize a workflow session without a session header.");
  const content = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  try { writeFileSync(path, content, { encoding: "utf8", flag: "wx", mode: 0o600 }); }
  catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; }
}

async function createBridgeContext(session: HerdrSession, prepared: Readonly<PreparedAgentSession>): Promise<(signal: AbortSignal, abort: () => void) => ExtensionContext> {
  const reference = session.reference;
  const path = sessionPath(reference);
  const sessionManager = path && existsSync(path) ? SessionManager.open(path, undefined, prepared.cwd) : SessionManager.inMemory(prepared.cwd, { id: reference.sessionId });
  const shared = session.getHerdrModelContext?.();
  let fallbackRegistry: ModelRegistry | undefined;
  if (shared?.modelRegistry === undefined) {
    const directory = prepared.agentDir ?? agentDir();
    const modelRuntime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: join(directory, "models.json") });
    fallbackRegistry = new ModelRegistry(modelRuntime);
  }
  const modelRegistry = shared?.modelRegistry ?? fallbackRegistry;
  if (modelRegistry === undefined) throw new Error("Herdr cannot bridge tools without the local model registry.");
  const model = shared?.model ?? modelRegistry.find(prepared.model.provider, prepared.model.model);
  const runner = new ExtensionRunner([], createExtensionRuntime(), prepared.cwd, sessionManager, modelRegistry);
  runner.setUIContext(undefined, "tui");
  const baseContext = runner.createContext();
  return (signal, abort) => new Proxy(baseContext, {
    get(target, property, receiver) {
      const current = session.getHerdrModelContext?.();
      if (property === "model") return current?.model ?? model;
      if (property === "modelRegistry") return current?.modelRegistry ?? modelRegistry;
      if (property === "thinkingLevel") return prepared.model.thinking;
      if (property === "isIdle") return () => false;
      if (property === "isProjectTrusted") return () => prepared.resourcePolicy?.projectTrusted ?? true;
      if (property === "signal") return signal;
      if (property === "abort") return abort;
      const reflected: unknown = Reflect.get(target, property, receiver);
      return reflected;
    },
  });
}
function inspectSessionCommand(reference: WorkflowAgentSessionReference): string {
  const source = sessionPath(reference) ?? reference.sessionId;
  return `pi --session ${quote(source)} --tools ${quote("read,grep,find,ls")}`;
}
function inlineFactorySource(extension: InlineExtension): string {
  const factory = typeof extension === "function" ? extension : typeof extension === "object" && typeof extension.factory === "function" ? extension.factory : undefined;
  if (!factory) throw new Error("Herdr live sessions cannot transfer an invalid inline extension factory.");
  const source = Function.prototype.toString.call(factory);
  if (source.includes("[native code]")) throw new Error("Herdr live sessions cannot transfer a native inline extension factory.");
  return source;
}
function createInlineExtensionBridge(prepared: Readonly<PreparedAgentSession>): ExtensionBridge | undefined {
  const timingFactory = createToolTimingExtension();
  const factories = prepared.extensionFactories?.includes(timingFactory) ? [...(prepared.extensionFactories ?? [])] : [...(prepared.extensionFactories ?? []), timingFactory];
  const extensionPath = join(tmpdir(), `pi-herdr-extensions-${String(process.pid)}-${randomBytes(6).toString("hex")}.mjs`);
  const source = `const factories = [${factories.map(inlineFactorySource).join(",")}];\nexport default async function(pi) { for (const factory of factories) await factory(pi); }\n`;
  writeFileSync(extensionPath, source, { encoding: "utf8", mode: 0o600 });
  return { extensionPath, async close() { try { unlinkSync(extensionPath); } catch { /* Cleanup is best effort after the child exits. */ } } };
}
function isToolBridgeRequest(value: unknown): value is ToolBridgeRequest {
  return value !== null && typeof value === "object" && typeof (value as Record<string, unknown>).toolCallId === "string" && typeof (value as Record<string, unknown>).name === "string";
}
function toolBridgeRequest(value: unknown): ToolBridgeRequest {
  if (isToolBridgeRequest(value)) return value;
  const name = value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>).name : undefined;
  throw new Error(`Unknown Herdr tool: ${String(name)}`);
}

async function createToolBridge(session: HerdrSession, prepared: Readonly<PreparedAgentSession>): Promise<ExtensionBridge | undefined> {
  const definitions: HerdrToolDefinition[] = [...(prepared.customTools ?? []), ...(prepared.resultTool ? [prepared.resultTool] : [])];
  if (!definitions.length) return undefined;
  const bridgeContext = await createBridgeContext(session, prepared);
  const specs = definitions.map((definition: HerdrToolDefinition) => {
    const { name, label, description, promptSnippet, promptGuidelines, parameters, renderShell, executionMode } = definition;
    return { name, label, description, ...(promptSnippet === undefined ? {} : { promptSnippet }), ...(promptGuidelines === undefined ? {} : { promptGuidelines }), parameters, ...(renderShell === undefined ? {} : { renderShell }), ...(executionMode === undefined ? {} : { executionMode }) };
  });
  const socketPath = join(tmpdir(), `pi-herdr-tools-${String(process.pid)}-${randomBytes(6).toString("hex")}.sock`);
  const extensionPath = join(tmpdir(), `pi-herdr-tools-${String(process.pid)}-${randomBytes(6).toString("hex")}.mjs`);
  const source = `import net from "node:net";\nconst socketPath = ${JSON.stringify(socketPath)};\nconst tools = ${JSON.stringify(specs)};\nfunction callTool(toolCallId, name, params, signal, onUpdate) {\n  return new Promise((resolve, reject) => {\n    const socket = net.createConnection(socketPath);\n    let buffer = "";\n    let settled = false;\n    const finish = (error, value) => { if (settled) return; settled = true; signal?.removeEventListener("abort", abort); socket.destroy(); error ? reject(error) : resolve(value); };\n    const abort = () => finish(new Error("Herdr tool call aborted"));\n    socket.setEncoding("utf8");\n    socket.on("connect", () => socket.write(JSON.stringify({ toolCallId, name, params }) + "\\n"));\n    socket.on("data", (chunk) => { buffer += chunk.toString(); let newline; while ((newline = buffer.indexOf("\\n")) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue; let message; try { message = JSON.parse(line); } catch { continue; } if (message.type === "update") onUpdate?.(message.value); else if (message.type === "error") finish(new Error(message.error)); else if (message.type === "result") finish(undefined, message.value); } });\n    socket.on("error", (error) => finish(error));\n    socket.on("close", () => finish(new Error("Herdr tool bridge closed")));\n    signal?.addEventListener("abort", abort, { once: true });\n  });\n}\nexport default function(pi) { for (const tool of tools) pi.registerTool({ ...tool, async execute(toolCallId, params, signal, onUpdate) { return callTool(toolCallId, tool.name, params, signal, onUpdate); } }); }\n`;
  writeFileSync(extensionPath, source, { encoding: "utf8", mode: 0o600 });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    const controller = new AbortController();
    let buffer = "";
    let handled = false;
    const send = (message: ToolBridgeMessage): void => { if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`); };
    const handle = async (value: unknown): Promise<void> => {
      if (handled) return;
      handled = true;
      try {
        const request = toolBridgeRequest(value);
        const definition = definitions.find(({ name }) => name === request.name);
        if (!definition) { send({ type: "error", error: `Unknown Herdr tool: ${request.name}` }); return; }
        const result = await definition.execute(request.toolCallId, request.params, controller.signal, (update: unknown) => { send({ type: "update", value: update }); }, bridgeContext(controller.signal, () => { controller.abort(); }));
        send({ type: "result", value: result });
      } catch (error) {
        send({ type: "error", error: errorText(error) });
      }
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { buffer += chunk.toString(); let newline; while ((newline = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); if (!line) continue; try { void handle(JSON.parse(line)); } catch (error) { send({ type: "error", error: errorText(error) }); } } });
    socket.on("close", () => { controller.abort(); sockets.delete(socket); });
    socket.on("error", () => { controller.abort(); sockets.delete(socket); });
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(socketPath, () => { server.removeListener("error", reject); resolve(); }); });
  let closed = false;
  return { extensionPath, async close() {
    if (closed) return;
    closed = true;
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => { resolve(); }));
    try { unlinkSync(extensionPath); } catch { /* Cleanup is best effort after the child exits. */ }
    try { unlinkSync(socketPath); } catch { /* Cleanup is best effort after the child exits. */ }
  } };
}

function sessionCommand(session: HerdrSession, prepared: Readonly<PreparedAgentSession>, prompt: string | undefined, bridges: readonly ExtensionBridge[], files: CommandFiles, directPrompt: boolean): string {
  const runtime = prepared.piRuntime;
  const entrypoint = runtime?.entrypoint;
  if (!runtime || typeof runtime.executable !== "string" || !runtime.executable || entrypoint !== undefined && (typeof entrypoint !== "string" || !entrypoint)) {
    const reason = typeof prepared.piRuntimeError === "string" && prepared.piRuntimeError ? ` (${prepared.piRuntimeError})` : "";
    const error = new Error(`Herdr cannot launch workflow agent: originating Pi runtime is unavailable${reason}.`);
    if (reason) error.cause = new Error(prepared.piRuntimeError);
    throw error;
  }
  const source = sessionPath(session.reference);
  if (!source) throw new Error("Herdr cannot hand off a live session without a transferable session file.");
  const sessionArg = `--session ${quote(source)}`;
  const model = `${prepared.model.provider}/${prepared.model.model}${prepared.model.thinking ? `:${prepared.model.thinking}` : ""}`;
  const toolNames = [...new Set([...prepared.tools, ...(prepared.customTools ?? []).map(({ name }) => name), ...(prepared.resultTool ? [prepared.resultTool.name] : [])])];
  const tools = toolNames.length ? ` --tools ${quote(toolNames.join(","))}` : " --no-tools";
  const systemPrompt = prepared.systemPrompt !== undefined ? ` --system-prompt ${quote(files.systemPrompt ?? "")}` : prepared.systemPromptPath ? ` --system-prompt ${quote(prepared.systemPromptPath)}` : "";
  const appendPrompt = files.appendPrompt ? ` --append-system-prompt ${quote(files.appendPrompt)}` : "";
  const contextPrompt = files.contextPrompt ? ` --append-system-prompt ${quote(files.contextPrompt)}` : "";
  const contextFiles = prepared.contextFiles === undefined ? "" : " --no-context-files";
  const loaded = resourcePaths(session);
  const allowedSkills = [...new Set([...(prepared.additionalSkillPaths ?? []), ...loaded.skills])];
  const skills = prepared.resourcePolicy ? ` --no-skills${allowedSkills.map((path) => ` --skill ${quote(path)}`).join("")}` : allowedSkills.map((path) => ` --skill ${quote(path)}`).join("");
  const allowedExtensions = [...new Set(loaded.extensions)];
  const bridgeExtensions = bridges.filter(Boolean).map(({ extensionPath }) => ` --extension ${quote(extensionPath)}`).join("");
  const extensions = prepared.resourcePolicy ? ` --no-extensions${allowedExtensions.map((path) => ` --extension ${quote(path)}`).join("")}${bridgeExtensions}` : bridgeExtensions;
  const trust = prepared.resourcePolicy?.projectTrusted === false ? " --no-approve" : prepared.resourcePolicy?.projectTrusted === true ? " --approve" : "";
  const environment = [prepared.agentDir ? `PI_CODING_AGENT_DIR=${quote(prepared.agentDir)}` : "", "PI_EXTENSIBLE_WORKFLOWS_HERDR_OWNER=1"].filter(Boolean).join(" ");
  const message = prompt === undefined ? "" : directPrompt ? ` ${quote(prompt)}` : ` @${quote(files.prompt ?? "")}`;
  return `${environment} ${quote(runtime.executable)}${entrypoint ? ` ${quote(entrypoint)}` : ""} ${sessionArg} --model ${quote(model)}${tools}${systemPrompt}${appendPrompt}${contextPrompt}${contextFiles}${skills}${extensions}${trust}${message}`;
}

function paneId(value: HerdrCommandResult): string { return typeof value === "string" ? value : value.paneId; }

function workspacePane(value: HerdrCommandResult): HerdrWorkspacePane {
  if (typeof value === "string") throw new Error("Herdr did not create a workspace pane.");
  return value;
}

function createWorkflowWorkspaces(runner: HerdrCommandRunner): WorkspaceManager {
  const workspaces = new Map<string, Promise<string>>();
  return {
    async open(run: Readonly<WorkflowRunContext>, request: HerdrWorkspacePaneRequest): Promise<HerdrWorkspacePane> {
      const existing = workspaces.get(run.runId);
      if (existing) return workspacePane(await openHerdrLivePane({ ...request, workspaceId: await existing }, runner));
      const opening = openHerdrLivePane({ ...request, workspaceLabel: `workflow ${run.workflow.name}` }, runner);
      const workspace = opening.then((pane) => {
        if (typeof pane === "string") throw new Error("Herdr did not create a workspace pane.");
        return pane.workspaceId;
      });
      workspaces.set(run.runId, workspace);
      try { return workspacePane(await opening); } catch (error) { workspaces.delete(run.runId); await workspace.catch(() => undefined); throw error; }
    },
    async close(runId: string): Promise<void> {
      const workspace = workspaces.get(runId);
      workspaces.delete(runId);
      if (workspace) await workspace.then((id) => runner(["workspace", "close", id])).catch(() => undefined);
    },
    async closeAll(): Promise<void> { await Promise.all([...workspaces.keys()].map((runId) => this.close(runId))); },
  };
}

async function launchPane({ session, prepared, identity, run, attempt, runner, fullyInspectable, env, signal, prompt, workspaces, tuiIndex, tuiLabel, directPrompt = false, onStatus }: LaunchPaneOptions): Promise<PaneHandle> {
  const label = fullyInspectable && typeof tuiIndex === "number" && Number.isInteger(tuiIndex) && tuiIndex > 0 && typeof tuiLabel === "string" && tuiLabel.trim() ? `#${String(tuiIndex)} ${tuiLabel}` : fullyInspectable ? breadcrumbLabel(identity, attempt) : prepared.sessionLabel;
  const bridge = await createToolBridge(session, prepared);
  let inlineBridge: ExtensionBridge | undefined;
  let commandFiles: CommandFiles | undefined;
  let pane: string | undefined;
  try {
    inlineBridge = createInlineExtensionBridge(prepared);
    const selectedContextFiles = prepared.contextFiles === undefined ? undefined : session.getHerdrContextFiles?.() ?? [];
    commandFiles = createCommandFiles(prepared, prompt, directPrompt, selectedContextFiles);
    const bridges = [bridge, inlineBridge].filter((value): value is ExtensionBridge => Boolean(value));
    const command = commandFiles.command(sessionCommand(session, prepared, prompt, bridges, commandFiles, directPrompt));
    let opened: HerdrCommandResult;
    if (fullyInspectable) {
      if (!workspaces || !run) throw new Error("Herdr fully inspectable mode is missing its workspace context.");
      opened = await workspaces.open(run, { cwd: prepared.cwd, tabLabel: label, command });
    } else {
      opened = await openHerdrLivePane({ action: "live", cwd: prepared.cwd, command, ...(env.HERDR_PANE_ID ? { paneId: env.HERDR_PANE_ID } : {}) }, runner);
    }
    pane = paneId(opened);
    if (!pane) throw new Error("Herdr did not create a pane.");
    let remoteClosed = false;
    const openedPane = pane;
    const closeRemote = async (): Promise<void> => {
      if (remoteClosed) return;
      remoteClosed = true;
      await runner(fullyInspectable && typeof opened !== "string" ? ["tab", "close", opened.tabId] : ["pane", "close", openedPane]).catch(() => undefined);
    };
    const reporter = createHerdrAgentReporter(openedPane, label, runner);
    const reference = session.reference;
    const path = sessionPath(reference);
    const sessionRef: SessionReference = path ? { sessionId: reference.sessionId, sessionPath: path } : { sessionId: reference.sessionId };
    try {
      await reporter.reportSession(sessionRef, "workflow-agent");
    } catch (error) {
      await closeRemote();
      throw error;
    }
    const monitor = waitForHerdrPane(openedPane, runner, { signal, ...(prepared.piRuntime?.entrypoint ? { originatingEntrypoint: prepared.piRuntime.entrypoint } : {}), ...(onStatus ? { onStatus } : {}) }).then(async (reason) => {
      await closeRemote();
      await reporter.release();
      await bridge?.close();
      await inlineBridge?.close();
      await commandFiles?.close();
      return reason;
    }).catch(async (error: unknown) => {
      await closeRemote();
      await reporter.release().catch(() => undefined);
      await bridge?.close();
      await inlineBridge?.close();
      await commandFiles?.close();
      throw error;
    });
    return { pane: openedPane, monitor, reporter, closeRemote, close: async () => { await bridge?.close(); await inlineBridge?.close(); await commandFiles?.close(); } };
  } catch (error) {
    if (pane && !fullyInspectable) await runner(["pane", "close", pane]).catch(() => undefined);
    await bridge?.close();
    await inlineBridge?.close();
    await commandFiles?.close();
    throw error;
  }
}

function herdrTransport(agent: AgentSetup, context: Readonly<AgentSetupContext>, runner: HerdrCommandRunner, fullyInspectable: boolean, env: NodeJS.ProcessEnv, workspaces: WorkspaceManager) {
  const local = agent.transport;
  const transport: AgentTransport = {
    id: "herdr",
    async createSession(prepared, sessionContext) {
      const session: HerdrSession = await local.createSession(prepared, sessionContext);
      const suspendAndLaunch = async (prompt: string | undefined): Promise<PaneHandle> => {
        let suspended = false;
        try {
          if (session.suspendForHandoff) { await session.suspendForHandoff(); suspended = true; }
          else { await session.abort(); suspended = true; }
          materializeSessionForHandoff(session, prepared);
          return await launchPane({ session, prepared, identity: context.identity, run: context.run, attempt: sessionContext.attempt, runner, fullyInspectable, env, signal: sessionContext.signal, prompt, workspaces, tuiIndex: context.tuiIndex, tuiLabel: context.tuiLabel });
        } catch (error) {
          if (suspended) { try { await session.resumeFromHandoff?.(); } catch { /* Preserve the pane launch failure. */ } }
          throw error;
        }
      };
      const inFlight = new Set<Promise<PaneHandle>>();
      let disposed = false;
      const isDisposed = (): boolean => disposed;
      let sharedLaunch: Promise<PaneHandle> | undefined;
      const beginLaunch = (prompt: string | undefined, retry = false): Promise<PaneHandle> => {
        if (isDisposed()) return Promise.reject(new Error("Herdr workflow session is disposed"));
        // Joined callers share the first launch; the executor normally serializes prompts, so later text is not sent separately.
        if (sharedLaunch) return sharedLaunch;
        const next = (async () => {
          try { return await suspendAndLaunch(prompt); }
          catch (error) { if (!retry || isDisposed()) throw error; return suspendAndLaunch(prompt); }
        })();
        sharedLaunch = next;
        inFlight.add(next);
        void next.then(() => { inFlight.delete(next); if (sharedLaunch === next) sharedLaunch = undefined; }, () => { inFlight.delete(next); if (sharedLaunch === next) sharedLaunch = undefined; });
        return next;
      };
      let opened;
      try {
        opened = await beginLaunch(prepared.initialPrompt);
      } catch (error) {
        await session.dispose().catch(() => undefined);
        throw error;
      }
      let disposal: Promise<void> | undefined;
      let active: PaneHandle | undefined = opened;
      return {
        ...session,
        getLastAssistant(this: HerdrSession): WorkflowAgentMessage | undefined { return session.getLastAssistant?.call(this); },
        reference: { ...session.reference, transport: "herdr" },
        async prompt(text) {
          if (disposed) throw new Error("Herdr workflow session is disposed");
          let current = active;
          if (!current) {
            const pending = inFlight.values().next().value;
            current = pending ? await pending : await beginLaunch(text, true);
          }
          active = current;
          let monitorFailed = false;
          let monitorError: unknown;
          let resumeFailed = false;
          let resumeError: unknown;
          try {
            await current.monitor;
          } catch (error) {
            monitorFailed = true;
            monitorError = error;
          } finally {
            try { await session.resumeFromHandoff?.(); }
            catch (error) { resumeFailed = true; resumeError = error; }
            finally { if (active === current) active = undefined; }
          }
          if (monitorFailed) throw monitorError;
          if (resumeFailed) throw resumeError;
          let assistant = session.getLastAssistant?.();
          const resultTool = prepared.resultTool;
          const resultSubmitted = resultTool !== undefined && hasNamedToolCall(assistant, resultTool.name);
          const incomplete = needsContinuation(assistant);
          if (!resultSubmitted && incomplete) {
            await session.prompt("Continue the task from the current session state.");
            assistant = session.getLastAssistant?.();
          }
          return assistant ? { assistant } : {};
        },
        async abort() { await session.abort(); },
        async dispose() {
          if (disposal) { await disposal; return; }
          disposed = true;
          disposal = (async () => {
            const pendingLaunches = [...inFlight];
            if (pendingLaunches.length > 0) {
              const results = await Promise.allSettled(pendingLaunches);
              if (!active) { for (const result of results) { if (result.status === "fulfilled") { active = result.value; break; } } }
            }
            if (active) {
              await active.closeRemote();
              await active.close();
            }
            await session.dispose();
          })();
          await disposal;
        }
      };
    },
  };
  return transport;
}

async function abortSession(session: { abort?: () => Promise<void> }): Promise<void> { await session.abort?.(); }
function hasExtensionHooks(value: unknown): value is ExtensionAPI {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as { on?: unknown; events?: { on?: unknown } };
  return typeof candidate.on === "function" && typeof candidate.events?.on === "function";
}
function isHerdrBlockedEvent(value: unknown): value is HerdrBlockedEvent {
  return value !== null && typeof value === "object" && typeof (value as Record<string, unknown>).active === "boolean" && ((value as Record<string, unknown>).label === undefined || typeof (value as Record<string, unknown>).label === "string");
}

function registerLifecycleHooks(pi: ExtensionAPI | null | undefined, runner: HerdrCommandRunner, env: NodeJS.ProcessEnv): void {
  const pane = env.HERDR_PANE_ID;
  if (!pane || !hasExtensionHooks(pi)) return;
  pi.events.on(WORKFLOW_BLOCKED_EVENT, (data) => { if (isHerdrBlockedEvent(data)) pi.events.emit("herdr:blocked", data); });
  if (env.PI_EXTENSIBLE_WORKFLOWS_HERDR_OWNER !== "1") return;
  const reporter = createHerdrAgentReporter(pane, "pi", runner);
  let sessionRef: SessionReference = {};
  let rootSession = false;
  let agentActive = false;
  let blockedCount = 0;
  let blockedMessage: string | undefined;
  let lastState: LifecycleState | undefined;
  let lastMessage: string | undefined;
  let queuedState: LifecycleReport | undefined;
  let stateReport: Promise<void> = Promise.resolve();
  const refresh = (ctx: ExtensionContext): SessionReference => {
    const path = ctx.sessionManager.getSessionFile();
    const id = ctx.sessionManager.getSessionId();
    sessionRef = { ...(typeof id === "string" ? { sessionId: id } : {}), ...(typeof path === "string" ? { sessionPath: path } : {}) };
    return sessionRef;
  };
  const desiredState = (): LifecycleReport => blockedCount > 0 ? { state: "blocked", message: blockedMessage } : agentActive ? { state: "working", message: undefined } : { state: "idle", message: undefined };
  const drainState = async (): Promise<void> => {
    while (queuedState) {
      const next = queuedState;
      queuedState = undefined;
      await reporter.reportState(next.state, next.message, sessionRef);
    }
  };
  const publishState = (force = false): void => {
    const next = desiredState();
    if (!force && next.state === lastState && next.message === lastMessage) return;
    lastState = next.state;
    lastMessage = next.message;
    queuedState = next;
    stateReport = stateReport.then(drainState, drainState);
  };
  pi.events.on("herdr:blocked", (data) => {
    if (!rootSession) return;
    const blocked = isHerdrBlockedEvent(data) ? data : { active: false };
    if (!blocked.active) { blockedCount = Math.max(0, blockedCount - 1); if (blockedCount === 0) blockedMessage = undefined; }
    else { blockedCount += 1; blockedMessage = blocked.label; }
    publishState();
  });
  pi.on("session_start", async (event: SessionStartEvent, ctx: ExtensionContext) => {
    rootSession = true;
    refresh(ctx);
    await reporter.reportSession(sessionRef, event.reason);
    agentActive = !ctx.isIdle();
    publishState(true);
    await stateReport;
  });
  pi.on("agent_start", async (_event: AgentStartEvent, ctx: ExtensionContext) => {
    if (!rootSession) return;
    refresh(ctx);
    await reporter.reportSession(sessionRef);
    agentActive = true;
    publishState();
    await stateReport;
  });
  pi.on("turn_end", async (event: TurnEndEvent) => {
    if (!rootSession) return;
    agentActive = hasToolCall(event.message) && !hasNamedToolCall(event.message, "workflow_result");
    publishState();
    await stateReport;
  });
  pi.on("agent_settled", async () => { if (!rootSession) return; agentActive = false; publishState(); await stateReport; });
  pi.on("agent_end", async (_event: AgentEndEvent, ctx: ExtensionContext) => { if (!rootSession || !ctx.isIdle()) return; agentActive = false; publishState(); await stateReport; });
  pi.on("session_shutdown", async (event: SessionShutdownEvent) => { if (event.reason === "quit") await reporter.release(); });
}

export function createHerdrExtension(options: HerdrExtensionOptions = {}): HerdrExtension {
  const env = options.env ?? process.env;
  const runner = options.runner ?? herdrCommandRunner;
  const workspaces = options.workspaces ?? createWorkflowWorkspaces(runner);
  const fullyInspectable = isFullyInspectableMode(options.agentDir);
  type ActionContext = HerdrAttemptActionContext;
  const sessionCwd = (context: ActionContext): string | undefined => completedSessionCwd("run" in context ? context : { attempt: context.attempt });
  const actionIdentity = (context: ActionContext): AgentIdentity => {
    const parentBreadcrumb = "run" in context ? context.agent.parentBreadcrumb : undefined;
    return { structuralPath: context.agent.structuralPath ?? [], ...(parentBreadcrumb ? { parentBreadcrumb } : {}), callSite: context.agent.label ?? context.agent.name, occurrence: context.attempt.attempt };
  };
  const openSessionVisible = (context: ActionContext): boolean => herdrAvailable(env) && !context.liveSession && (context.agent.state === "completed" || context.agent.state === "failed" || context.agent.state === "cancelled" || context.agent.state === "stopped") && Boolean(context.session?.sessionId && sessionCwd(context));
  const openSession = async (context: ActionContext): Promise<void> => {
    const session = context.session;
    const cwd = sessionCwd(context);
    if (!session || context.liveSession || !cwd) return;
    await openHerdrLivePane({ action: "live", cwd, command: inspectSessionCommand(session), ...(env.HERDR_PANE_ID ? { paneId: env.HERDR_PANE_ID } : {}) }, runner);
  };
  const openLiveVisible = (context: ActionContext): boolean => herdrAvailable(env) && !fullyInspectable && Boolean(context.liveSession && sessionPath(context.liveSession.reference) && context.prepared && context.handoff);
  const openLive = async (context: ActionContext): Promise<void> => {
    const session = context.liveSession;
    const prepared = context.prepared;
    const handoff = context.handoff;
    if (!session || !prepared || !handoff) return;
    if (!sessionPath(session.reference)) throw new Error("Herdr cannot hand off a live session without a transferable session file.");
    const label = typeof context.agent.label === "string" && context.agent.label.trim() ? context.agent.label : typeof context.agent.name === "string" && context.agent.name.trim() ? context.agent.name : "workflow agent";
    let lastWorkingMessage: string | undefined;
    const setWorkingMessage = (state?: string): void => {
      const message = state ? `${label}: ${state}` : undefined;
      if (message === lastWorkingMessage) return;
      lastWorkingMessage = message;
      context.ui.setWorkingMessage?.(message);
    };
    const handoffReleased = (): boolean => handoff.state === "completed";
    const handoffCancelled = (): boolean => context.signal.aborted || handoffReleased();
    setWorkingMessage("queued (waiting for a turn boundary)");
    await handoff.request(async () => {
      setWorkingMessage("opening pane");
      const continueTask = needsContinuation(session.getLastAssistant());
      let opened: PaneHandle | undefined;
      let suspended = false;
      let reportedWorking = false;
      let lastState = "working";
      let displayedState: HerdrAgentStatus | undefined;
      const reportStatus = (state: HerdrAgentStatus): void => {
        lastState = state;
        if (state === "working") reportedWorking = true;
        if (displayedState !== state) { displayedState = state; setWorkingMessage(state); }
      };
      try {
        await abortSession(session);
        if (handoffCancelled()) return;
        if (session.suspendForHandoff) await session.suspendForHandoff();
        suspended = true;
        if (handoffCancelled()) return;
        opened = await launchPane({ session, prepared, identity: actionIdentity(context), attempt: context.attempt.attempt, runner, fullyInspectable: false, env, signal: context.signal, prompt: continueTask ? "Continue the current workflow task from this session." : undefined, directPrompt: continueTask, onStatus: reportStatus });
        if (handoffCancelled()) { if (handoffReleased()) await opened.closeRemote().catch(() => undefined); await opened.monitor; return; }
        handoff.takeover();
        if (displayedState === undefined || lastState === "idle") { displayedState = "working"; setWorkingMessage("working"); reportedWorking = true; }
        await opened.monitor;
      } finally {
        try {
          if (reportedWorking) setWorkingMessage(lastState === "done" ? "completed" : "idle");
        } finally {
          try {
            if (suspended) await session.resumeFromHandoff?.();
          } finally {
            if (reportedWorking) { await new Promise<void>((resolve) => setTimeout(resolve, 50)); setWorkingMessage(); }
          }
        }
      }
    }).finally(() => { setWorkingMessage(); });
  };
  return {
    version: "1.0.0",
    headline: "Herdr workflow integration",
    agentAttemptActions: {
      openSession: {
        label: "Open session in Herdr pane",
        visible: openSessionVisible,
        run: openSession,
        visibleStandalone: openSessionVisible,
        runStandalone: openSession,
      },
      openLiveSession: {
        label: "Open live session in Herdr pane",
        visible: openLiveVisible,
        run: openLive,
        visibleStandalone: openLiveVisible,
        runStandalone: openLive,
      },
    },
    agentSetupHooks: {
      fullyInspectable: {
        setup(agent, context) {
          if (context.mode === "inspection" || !fullyInspectable || !herdrAvailable(env)) return;
          agent.transport = herdrTransport(agent, context, runner, true, env, workspaces);
        },
      },
    },
  };
}

export function registerHerdrExtension(options: HerdrExtensionOptions = {}): boolean {
  const env = options.env ?? process.env;
  if (!herdrAvailable(env)) return false;
  registerWorkflowExtension(createHerdrExtension(options));
  return true;
}

function isRunEvent(value: unknown): value is { runId: string } {
  return value !== null && typeof value === "object" && typeof (value as Record<string, unknown>).runId === "string";
}
function isTerminalRunState(value: unknown): value is "failed" | "stopped" | "interrupted" | "budget_exhausted" {
  return value === "failed" || value === "stopped" || value === "interrupted" || value === "budget_exhausted";
}

function registerWorkspaceLifecycle(pi: ExtensionAPI | null | undefined, workspaces: WorkspaceManager): void {
  if (!hasExtensionHooks(pi)) return;
  pi.events.on(WORKFLOW_RUN_COMPLETED_EVENT, (event) => { if (isRunEvent(event)) void workspaces.close(event.runId); });
  pi.events.on(WORKFLOW_RUN_STATE_CHANGED_EVENT, (event) => { if (isRunEvent(event) && isTerminalRunState((event as { state?: unknown }).state)) void workspaces.close(event.runId); });
  pi.on("session_shutdown", async () => { await workspaces.closeAll(); });
}

export default function extension(pi: ExtensionAPI, overrides: HerdrExtensionOverrides = {}): void {
  const runner = overrides.runner ?? herdrCommandRunner;
  const workspaces = overrides.workspaces ?? createWorkflowWorkspaces(runner);
  const options = { env: overrides.env ?? process.env, runner, workspaces };
  if (registerHerdrExtension(options)) {
    registerLifecycleHooks(pi, runner, options.env);
    registerWorkspaceLifecycle(pi, workspaces);
  }
}
