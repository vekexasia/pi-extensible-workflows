import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { highlightCode, initTheme, SessionManager, truncateToVisualLines, type SessionEntry, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { formatBudgetStatus, inspectWorkflowScript, type ModelSpec, type StaticWorkflowCall } from "./index.js";
import { listRunIds, RunStore, type PersistedRun } from "./persistence.js";

export interface ModelUsage { model: string; cost: number }
export interface AttemptReport { attempt: number; prompt: string; model: string; thinking?: ModelSpec["thinking"]; cost: number; models: readonly ModelUsage[]; error?: string }
export interface AgentReport { name: string; label?: string; state: string; role?: string; requestedModel?: string; model: string; thinking?: ModelSpec["thinking"]; cost: number; attempts: readonly AttemptReport[] }
export interface WorkflowReport { name: string; description?: string; status: string; runId?: string; script?: string; calls: readonly StaticWorkflowCall[]; parseError?: string; cost: number; models: readonly ModelUsage[]; agents: readonly AgentReport[]; budget?: PersistedRun["budget"]; budgetVersion?: number; usage?: PersistedRun["usage"]; budgetEvents?: PersistedRun["budgetEvents"]; events?: readonly { type: string; message: string }[] }
export interface SessionReport { id: string; cwd: string; path: string; cost: number; models: readonly ModelUsage[]; workflows: readonly WorkflowReport[]; totalCost: number; totalModels: readonly ModelUsage[] }
export interface InspectorViewState { view: "list" | "detail" | "script"; selected: number; scroll: number }

type TranscriptSummary = { prompt?: string; cost: number; models: readonly ModelUsage[]; model?: string; thinking?: ModelSpec["thinking"] };
type ToolResult = { toolCallId: string; isError: boolean; content: unknown; details?: unknown };
type WorkflowCall = { id: string; arguments: Record<string, unknown> };
type LoadedRun = { run: PersistedRun; snapshot: Readonly<{ script: string; metadata: { description?: string } }> };

function text(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: unknown[] = content;
  return parts.flatMap((part) => typeof part === "object" && part !== null && "type" in part && part.type === "text" && "text" in part && typeof part.text === "string" ? [part.text] : []).join("");
}

function transcriptPartLines(part: unknown): string[] {
  if (typeof part !== "object" || part === null || !("type" in part)) return [];
  const value = part as Record<string, unknown>;
  if (value.type === "text" && typeof value.text === "string") return value.text.split("\n");
  if (value.type === "thinking" && typeof value.thinking === "string") return ["Thinking:", ...value.thinking.split("\n")];
  if (value.type === "toolCall" && typeof value.name === "string") return [`Tool call: ${value.name}`, JSON.stringify(value.arguments, null, 2)];
  if (value.type === "image") return ["[image]"];
  return [];
}

function transcriptMessageLines(message: unknown): string[] {
  if (typeof message !== "object" || message === null) return ["(invalid message)"];
  const value = message as Record<string, unknown>;
  const role = typeof value.role === "string" ? value.role : "message";
  const label = role === "toolResult" && typeof value.toolName === "string" ? `${role}: ${value.toolName}` : role === "custom" && typeof value.customType === "string" ? `${role}: ${value.customType}` : role;
  const content = Array.isArray(value.content) ? value.content.flatMap(transcriptPartLines) : typeof value.content === "string" ? value.content.split("\n") : [];
  return [`[${label}]`, ...(content.length ? content : ["(empty)"])];
}

export function transcriptLines(entries: readonly SessionEntry[]): string[] {
  if (!entries.length) return ["(no active transcript entries)"];
  return entries.flatMap((entry, index) => {
    const lines = entry.type === "message" ? transcriptMessageLines(entry.message) : entry.type === "model_change" ? [`[model] ${entry.provider}/${entry.modelId}`] : entry.type === "thinking_level_change" ? [`[thinking] ${entry.thinkingLevel}`] : entry.type === "compaction" ? ["[compaction]", ...entry.summary.split("\n")] : entry.type === "branch_summary" ? ["[branch summary]", ...entry.summary.split("\n")] : entry.type === "custom_message" ? [`[custom_message: ${entry.customType}]`, ...(typeof entry.content === "string" ? entry.content.split("\n") : entry.content.flatMap(transcriptPartLines))] : entry.type === "custom" ? [`[custom: ${entry.customType}]`] : entry.type === "label" ? [`[label] ${entry.label ?? ""}`] : [`[session info] ${entry.name ?? ""}`];
    return index ? ["", ...lines] : lines;
  });
}

function mergedModels(groups: readonly (readonly ModelUsage[])[]): ModelUsage[] {
  const totals = new Map<string, number>();
  for (const group of groups) for (const item of group) totals.set(item.model, (totals.get(item.model) ?? 0) + item.cost);
  return [...totals].map(([model, cost]) => ({ model, cost })).sort((a, b) => b.cost - a.cost || a.model.localeCompare(b.model));
}

const thinkingLevels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
function parsedThinking(value: unknown): ModelSpec["thinking"] | undefined {
  return typeof value === "string" && thinkingLevels.includes(value as (typeof thinkingLevels)[number]) ? value as ModelSpec["thinking"] : undefined;
}

function modelName(provider: unknown, model: unknown): string | undefined {
  return typeof provider === "string" && provider && typeof model === "string" && model ? `${provider}/${model}` : undefined;
}

function transcript(manager: SessionManager): TranscriptSummary {
  const models = new Map<string, number>();
  let cost = 0;
  let prompt: string | undefined;
  let model: string | undefined;
  let thinking: ModelSpec["thinking"] | undefined;
  for (const entry of manager.getEntries()) {
    if (entry.type === "model_change") {
      model = modelName(entry.provider, entry.modelId);
      if (!model) throw new Error("Invalid model policy");
      continue;
    }
    if (entry.type === "thinking_level_change") {
      thinking = parsedThinking(entry.thinkingLevel);
      if (thinking === undefined) throw new Error("Invalid thinking policy");
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "user" && prompt === undefined) {
      const full = text(message.content);
      const marker = "\n\nTask:\n";
      prompt = full.includes(marker) ? full.slice(full.indexOf(marker) + marker.length) : full;
    }
    if (message.role === "assistant") {
      const actualModel = modelName(message.provider, message.model);
      const messageCost = message.usage.cost.total;
      if (!actualModel || typeof messageCost !== "number" || !Number.isFinite(messageCost)) throw new Error("Invalid assistant policy");
      model = actualModel;
      cost += messageCost;
      models.set(actualModel, (models.get(actualModel) ?? 0) + messageCost);
    }
  }
  return { ...(prompt !== undefined ? { prompt } : {}), cost, models: [...models].map(([model, modelCost]) => ({ model, cost: modelCost })), ...(model !== undefined ? { model } : {}), ...(thinking !== undefined ? { thinking } : {}) };
}

function readTranscript(path: string): TranscriptSummary | undefined {
  try {
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) return undefined;
    const manager = SessionManager.open(path);
    if (!manager.getHeader()) return undefined;
    const summary = transcript(manager);
    return summary.model === undefined ? undefined : summary;
  } catch { return undefined; }
}

function resultRunId(result: ToolResult | undefined): string | undefined {
  if (!result) return undefined;
  if (typeof result.details === "object" && result.details !== null && "runId" in result.details && typeof result.details.runId === "string") return result.details.runId;
  const raw = text(result.content);
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null && "runId" in parsed && typeof parsed.runId === "string" ? parsed.runId : undefined;
  } catch { return undefined; }
}

function workflowEntries(manager: SessionManager): { calls: WorkflowCall[]; results: Map<string, ToolResult> } {
  const calls: WorkflowCall[] = [];
  const results = new Map<string, ToolResult>();
  for (const entry of manager.getEntries()) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role === "assistant") for (const part of message.content) {
      if (part.type === "toolCall" && part.name === "workflow") calls.push({ id: part.id, arguments: part.arguments });
    }
    if (message.role === "toolResult" && message.toolName === "workflow") results.set(message.toolCallId, { toolCallId: message.toolCallId, isError: message.isError, content: message.content, details: message.details as unknown });
  }
  return { calls, results };
}

async function loadRuns(cwd: string, sessionId: string, home: string): Promise<Map<string, LoadedRun>> {
  const runs = new Map<string, LoadedRun>();
  for (const runId of await listRunIds(cwd, sessionId, home)) {
    try { runs.set(runId, await new RunStore(cwd, sessionId, runId, home).load()); } catch { /* Ignore corrupt or concurrently removed runs. */ }
  }
  return runs;
}

async function agentReport(agent: PersistedRun["agents"][number]): Promise<AgentReport> {
  const fallbackModel = `${agent.model.provider}/${agent.model.model}`;
  const fallbackThinking = agent.model.thinking;
  const attempts: AttemptReport[] = [];
  for (const attempt of agent.attemptDetails ?? []) {
    const log = readTranscript(attempt.sessionFile);
    if (log) {
      const model = log.model ?? fallbackModel;
      const cost = log.cost;
      attempts.push({
        attempt: attempt.attempt,
        prompt: log.prompt ?? "(transcript unavailable)",
        model,
        ...(log.thinking !== undefined ? { thinking: log.thinking } : {}),
        cost,
        models: log.models.length ? log.models : [{ model, cost }],
        ...(attempt.error ? { error: `${attempt.error.code}: ${attempt.error.message}` } : {}),
      });
      continue;
    }
    const cost = attempt.accounting.cost;
    attempts.push({
      attempt: attempt.attempt,
      prompt: "(transcript unavailable)",
      model: fallbackModel,
      ...(fallbackThinking !== undefined ? { thinking: fallbackThinking } : {}),
      cost,
      models: [{ model: fallbackModel, cost }],
      ...(attempt.error ? { error: `${attempt.error.code}: ${attempt.error.message}` } : {}),
    });
  }
  if (!attempts.length) {
    const cost = agent.accounting?.cost ?? 0;
    attempts.push({ attempt: 1, prompt: "(transcript unavailable)", model: fallbackModel, ...(fallbackThinking !== undefined ? { thinking: fallbackThinking } : {}), cost, models: [{ model: fallbackModel, cost }] });
  }
  const latest = attempts[attempts.length - 1];
  return { name: agent.name, ...(agent.label ? { label: agent.label } : {}), state: agent.state, ...(agent.role ? { role: agent.role } : {}), ...(agent.requestedModel ? { requestedModel: agent.requestedModel } : {}), model: latest?.model ?? fallbackModel, ...(latest?.thinking !== undefined ? { thinking: latest.thinking } : {}), cost: attempts.reduce((sum, attempt) => sum + attempt.cost, 0), attempts };
}

export function matchSession(query: string, sessions: readonly SessionInfo[]): SessionInfo {
  const exact = sessions.filter(({ id }) => id === query);
  if (exact[0]) return exact[0];
  const partial = sessions.filter(({ id }) => id.startsWith(query));
  if (partial.length === 1 && partial[0]) return partial[0];
  if (!partial.length) throw new Error(`Session not found: ${query}`);
  throw new Error(`Session ID is ambiguous: ${query}`);
}

export async function loadSessionReport(path: string, home = homedir()): Promise<SessionReport> {
  const manager = SessionManager.open(path);
  const header = manager.getHeader();
  if (!header) throw new Error(`Invalid session file: ${path}`);
  const parent = transcript(manager);
  const { calls, results } = workflowEntries(manager);
  const runs = await loadRuns(header.cwd, header.id, home);
  const workflows: WorkflowReport[] = [];
  for (const call of calls) {
    const result = results.get(call.id);
    const runId = resultRunId(result);
    const loaded = runId ? runs.get(runId) : undefined;
    const args = call.arguments;
    const agents = loaded ? await Promise.all(loaded.run.agents.map(agentReport)) : [];
    const models = mergedModels(agents.flatMap(({ attempts }) => attempts.map(({ models: attemptModels }) => attemptModels)));
    const name = typeof args.name === "string" ? args.name : typeof args.workflow === "string" ? args.workflow : loaded?.run.workflowName ?? "workflow";
    const description = typeof args.description === "string" ? args.description : loaded?.snapshot.metadata.description;
    const script = typeof args.script === "string" && args.script.trim() ? args.script : loaded?.snapshot.script;
    let staticCalls: StaticWorkflowCall[] = [];
    let parseError: string | undefined;
    if (script) {
      try { staticCalls = inspectWorkflowScript(script); }
      catch (error) { parseError = error instanceof Error ? error.message : String(error); }
    }
    workflows.push({
      name,
      ...(description ? { description } : {}),
      status: loaded?.run.state ?? (result ? result.isError ? "failed" : "completed" : "pending"),
      ...(runId ? { runId } : {}),
      ...(script ? { script } : {}),
      calls: staticCalls,
      ...(parseError ? { parseError } : {}),
      cost: agents.reduce((sum, agent) => sum + agent.cost, 0),
      models,
      agents,
      ...(loaded?.run.budget ? { budget: loaded.run.budget } : {}),
      ...(loaded?.run.budgetVersion !== undefined ? { budgetVersion: loaded.run.budgetVersion } : {}),
      ...(loaded?.run.usage ? { usage: loaded.run.usage } : {}),
      ...(loaded?.run.budgetEvents ? { budgetEvents: loaded.run.budgetEvents } : {}),
      ...(loaded?.run.events?.length ? { events: loaded.run.events } : {})
    });
  }
  const workflowCost = workflows.reduce((sum, workflow) => sum + workflow.cost, 0);
  return {
    id: header.id, cwd: header.cwd, path, cost: parent.cost, models: parent.models, workflows,
    totalCost: parent.cost + workflowCost,
    totalModels: mergedModels([parent.models, ...workflows.map(({ models }) => models)]),
  };
}

const ansi = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m", inverse: "\x1b[7m" };
const style = (code: string, value: string) => `${code}${value}${ansi.reset}`;
const money = (cost: number) => `$${cost < 0.01 && cost > 0 ? cost.toFixed(4) : cost.toFixed(2)}`;
const modelSummary = (models: readonly ModelUsage[]) => models.length ? models.map(({ model, cost }) => `${model} ${money(cost)}`).join(" · ") : "(none)";

function wrapped(lines: readonly string[], width: number): string[] {
  return lines.flatMap((line) => line ? truncateToVisualLines(line, Number.MAX_SAFE_INTEGER, Math.max(1, width), 0).visualLines : [""]);
}

function detailLines(workflow: WorkflowReport): string[] {
  const lines = [
    style(ansi.bold + ansi.cyan, workflow.name),
    `${workflow.status} · ${money(workflow.cost)}${workflow.runId ? ` · ${workflow.runId}` : ""}`,
    workflow.description ?? "",
    ...(workflow.events?.length ? ["", style(ansi.bold, "Run events"), ...workflow.events.map((event) => `${event.type}: ${event.message}`)] : []),
    "",
    ...(workflow.budget ? formatBudgetStatus({ budget: workflow.budget, ...(workflow.budgetVersion !== undefined ? { budgetVersion: workflow.budgetVersion } : {}), ...(workflow.usage ? { usage: workflow.usage } : {}), ...(workflow.budgetEvents ? { budgetEvents: workflow.budgetEvents } : {}) }).map((line) => `Budget ${line}`) : []),
    style(ansi.bold, "Models"),
    modelSummary(workflow.models),
    "",
    style(ansi.bold, "Static workflow calls"),
    ...(workflow.parseError ? [style(ansi.red, `Parse error: ${workflow.parseError}`)] : workflow.calls.length ? workflow.calls.map((call, index) => {
      const fields = [call.name ? `name=${JSON.stringify(call.name)}` : "", call.prompt ? `prompt=${JSON.stringify(call.prompt)}` : call.kind === "agent" || call.kind === "checkpoint" ? "prompt=<dynamic>" : "", call.label ? `label=${call.label}` : "", call.role ? `role=${call.role}` : "", call.model ? `model=${call.model}` : ""].filter(Boolean);
      return `${String(index + 1)}. ${call.kind}${fields.length ? ` · ${fields.join(" · ")}` : ""}`;
    }) : ["(none)"]),
    "",
    style(ansi.bold, "Agents and runtime prompts"),
  ];
  if (!workflow.agents.length) lines.push("(no agent run was persisted)");
  for (const agent of workflow.agents) {
    lines.push("", style(agent.state === "completed" ? ansi.green : agent.state === "failed" ? ansi.red : ansi.yellow, `${agent.label ?? agent.name} [${agent.state}]`), `${agent.role ? `role=${agent.role} · ` : ""}${agent.requestedModel ? `requested=${agent.requestedModel} · ` : ""}${agent.model}${agent.thinking !== undefined ? `:${agent.thinking}` : ""} · ${money(agent.cost)}`);
    for (const attempt of agent.attempts) {
      lines.push(`Attempt ${String(attempt.attempt)} · ${attempt.model}${attempt.thinking !== undefined ? `:${attempt.thinking}` : ""} · ${money(attempt.cost)}${attempt.error ? ` · ${attempt.error}` : ""}`, `Prompt: ${attempt.prompt}`);
    }
  }
  return lines.filter((line, index) => line || index !== 2);
}

let themeReady = false;
function highlighted(script: string): string[] {
  if (!themeReady) { initTheme(undefined, false); themeReady = true; }
  return highlightCode(script, "javascript");
}

export function renderInspector(report: SessionReport, state: InspectorViewState, width = 80, height = 24, highlighter: (script: string) => string[] = highlighted): string[] {
  const usableWidth = Math.max(1, width);
  const selected = report.workflows[state.selected];
  if (state.view === "list") {
    const header = wrapped([
      style(ansi.bold + ansi.cyan, "Pi workflow session inspector"),
      `${report.id} · ${report.cwd}`,
      `Total ${money(report.totalCost)} · parent ${money(report.cost)}`,
      modelSummary(report.totalModels),
      "",
      style(ansi.bold, `Workflows (${String(report.workflows.length)})`),
    ], usableWidth);
    const rows = report.workflows.length ? report.workflows.map((workflow, index) => `${index === state.selected ? style(ansi.inverse, ">") : " "} ${workflow.name} · ${workflow.status} · ${money(workflow.cost)} · ${String(workflow.agents.length)} agents`) : ["No workflow calls found."];
    const footer = wrapped(["", style(ansi.dim, "↑↓ select · enter details · q quit")], usableWidth);
    const room = Math.max(1, height - header.length - footer.length);
    const start = Math.max(0, Math.min(state.selected - Math.floor(room / 2), rows.length - room));
    return [...header, ...rows.slice(start, start + room).map((line) => wrapped([line], usableWidth)[0] ?? ""), ...footer].slice(0, height);
  }
  if (!selected) return wrapped(["No workflow selected.", style(ansi.dim, "esc back · q quit")], usableWidth).slice(0, height);
  const title = state.view === "script" ? `${selected.name} · script` : `${selected.name} · details`;
  const body = state.view === "script" ? selected.script ? highlighter(selected.script) : ["Script unavailable."] : detailLines(selected);
  const fitted = wrapped(body, usableWidth);
  const header = wrapped([style(ansi.bold + ansi.cyan, title)], usableWidth);
  const hint = state.view === "script" ? "↑↓/pgup/pgdn scroll · esc details · q quit" : "↑↓/pgup/pgdn scroll · s script · esc workflows · q quit";
  const footer = wrapped([style(ansi.dim, hint)], usableWidth);
  const room = Math.max(1, height - header.length - footer.length);
  const scroll = Math.max(0, Math.min(state.scroll, Math.max(0, fitted.length - room)));
  return [...header, ...fitted.slice(scroll, scroll + room), ...footer].slice(0, height);
}

function nextState(current: InspectorViewState, key: string, workflowCount: number): InspectorViewState {
  if (current.view === "list") {
    if (key === "up") return { ...current, selected: Math.max(0, current.selected - 1) };
    if (key === "down") return { ...current, selected: Math.min(Math.max(0, workflowCount - 1), current.selected + 1) };
    if (key === "return" && workflowCount) return { ...current, view: "detail", scroll: 0 };
    return current;
  }
  if (key === "escape" || key === "left") return { ...current, view: current.view === "script" ? "detail" : "list", scroll: 0 };
  if ((key === "s" || key === "tab") && current.view === "detail") return { ...current, view: "script", scroll: 0 };
  const delta = key === "up" ? -1 : key === "down" ? 1 : key === "pageup" ? -10 : key === "pagedown" ? 10 : 0;
  return delta ? { ...current, scroll: Math.max(0, current.scroll + delta) } : current;
}

export async function showSessionInspector(report: SessionReport): Promise<void> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("The session inspector requires an interactive terminal.");
  let state: InspectorViewState = { view: "list", selected: 0, scroll: 0 };
  const render = () => { stdout.write(`\x1b[H\x1b[2J${renderInspector(report, state, stdout.columns || 80, stdout.rows || 24).join("\n")}`); };
  await new Promise<void>((resolve) => {
    const wasRaw = stdin.isRaw;
    const done = () => {
      stdin.off("keypress", onKey);
      stdout.off("resize", render);
      stdin.setRawMode(wasRaw);
      if (!wasRaw) stdin.pause();
      stdout.write("\x1b[?25h\x1b[?1049l");
      resolve();
    };
    const onKey = (value: string, key: { name?: string; ctrl?: boolean }) => {
      if ((key.ctrl && key.name === "c") || value === "q") { done(); return; }
      state = nextState(state, value === "s" ? "s" : key.name ?? value, report.workflows.length);
      render();
    };
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on("keypress", onKey);
    stdout.on("resize", render);
    stdout.write("\x1b[?1049h\x1b[?25l");
    render();
  });
}

async function askSessionId(): Promise<string> {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error("Pass a session ID when stdin is not interactive.");
  const prompt = createInterface({ input: stdin, output: stdout });
  try { return (await prompt.question("Session ID: ")).trim(); } finally { prompt.close(); }
}
export async function resolveSession(query: string, sessionDir = process.env.PI_CODING_AGENT_SESSION_DIR): Promise<SessionInfo> {
  return matchSession(query, await SessionManager.listAll(sessionDir));
}

export async function runSessionInspector(sessionId?: string): Promise<void> {
  const query = sessionId?.trim() || await askSessionId();
  if (!query) throw new Error("Session ID is required.");
  const session = await resolveSession(query);
  await showSessionInspector(await loadSessionReport(session.path));
}