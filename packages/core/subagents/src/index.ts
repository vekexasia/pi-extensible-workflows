import { join } from "node:path";
import { defineTool, getAgentDir, type AgentToolResult, type ExtensionAPI, type ExtensionContext, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { WorkflowError, loadingRegistry } from "../../src/index.js";
import { clearSubagentManager, setSubagentManager } from "../../src/subagent-manager-handle.js";
import type { SubagentIdRequest, SubagentInspectRequest, SubagentManager, SubagentManagerContext, SubagentNotification, SubagentsExtension, SubagentsExtensionOptions, SubagentRunRequest, SubagentStatus, SubagentSteerRequest } from "./contracts.js";
import { createSubagentManager } from "./manager.js";
import { registerSubagentNavigator } from "./navigator.js";
import { createSubagentBackgroundWidget, renderSubagentCall, renderSubagentControlCall, renderSubagentControlResult, renderSubagentInspectCall, renderSubagentInspectResult, renderSubagentResult } from "./view.js";
import {
  normalizeSubagentRunRequest,
  SUBAGENTS_ID_PARAMETERS,
  SUBAGENTS_INSPECT_PARAMETERS,
  SUBAGENTS_RETRY_PARAMETERS,
  SUBAGENTS_RUN_PARAMETERS,
  SUBAGENTS_STEER_PARAMETERS,
  SUBAGENTS_STOP_PARAMETERS,
} from "./contracts.js";

export * from "./contracts.js";
export * from "./decode.js";
export { createSubagentManager, createUnavailableSubagentManager } from "./manager.js";
export { createRunStoreWorktreeAdapter, defaultWorktreeHome } from "./worktree.js";
export type { SubagentWorktreeAdapter, SubagentWorktreeContext, SubagentWorktreeHandle, SubagentWorktreeRunStore } from "./worktree.js";

type SubagentsExtensionAPI = Pick<ExtensionAPI, "registerTool"> & Partial<Pick<ExtensionAPI, "getActiveTools" | "on" | "sendMessage" | "registerCommand">>;

function validateSubagentRunRequest(value: unknown): SubagentRunRequest {
  return normalizeSubagentRunRequest(value);
}

function validateSubagentIdRequest(value: unknown, operation: string): SubagentIdRequest {
  if (!Value.Check(SUBAGENTS_ID_PARAMETERS, value)) throw new WorkflowError("INVALID_METADATA", `Invalid ${operation} parameters`);
  return value;
}

function validateSubagentInspectRequest(value: unknown): SubagentInspectRequest {
  if (!Value.Check(SUBAGENTS_INSPECT_PARAMETERS, value)) throw new WorkflowError("INVALID_METADATA", "Invalid subagents_inspect parameters");
  return value;
}

function validateSubagentSteerRequest(value: unknown): SubagentSteerRequest {
  if (!Value.Check(SUBAGENTS_STEER_PARAMETERS, value)) throw new WorkflowError("INVALID_METADATA", "Invalid subagents_steer parameters");
  return value;
}

function serialize(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : String(value);
  } catch {
    return String(value);
  }
}

function toolResult(value: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text: serialize(value) }], details: value };
}

function managerContext(toolCallId: string, signal: AbortSignal | undefined, onUpdate: ((value: AgentToolResult<unknown>) => void) | undefined, context: ExtensionContext): SubagentManagerContext {
  return {
    toolCallId,
    signal,
    onUpdate: onUpdate === undefined ? undefined : (value) => { onUpdate(toolResult(value)); },
    extensionContext: context,
  };
}
export function createSubagentTools(manager: SubagentManager): readonly ToolDefinition[] {
  return [
    defineTool({
      name: "subagents_run",
      label: "Subagents Run",
      description: "Start a durable subagent run. Background mode returns its ID immediately; foreground mode waits and returns the terminal value or error in this tool call. Use the ID with subagents_inspect, subagents_steer, subagents_stop, or subagents_retry.",
      promptSnippet: "Run durable subagents in background by default; inspect, steer, stop, or retry them with the other subagents tools.",
      promptGuidelines: [
        "Runs are background by default; choose mode: \"foreground\" only when the terminal envelope is needed in this turn.",
        "Do not poll a running ID; use subagents_inspect({ id }) when you need its current status or terminal result.",
      ],
      parameters: SUBAGENTS_RUN_PARAMETERS,
      async execute(toolCallId, params, signal, onUpdate, context) {
        return toolResult(await manager.run(validateSubagentRunRequest(params), managerContext(toolCallId, signal, onUpdate, context)));
      },
      renderCall(args) { return renderSubagentCall(args); },
      renderResult(result, options, theme, context) { return renderSubagentResult(result, options, theme, context); },
    }),
    defineTool({
      name: "subagents_inspect",
      label: "Subagents Inspect",
      description: "Inspect durable subagent runs. Omit id for ordered run summaries, or provide id for detailed status, progress, activity, accounting, tool calls, timestamps, worktree metadata, and a terminal value or error when available.",
      parameters: SUBAGENTS_INSPECT_PARAMETERS,
      async execute(toolCallId, params, signal, onUpdate, context) {
        return toolResult(await manager.inspect(validateSubagentInspectRequest(params), managerContext(toolCallId, signal, onUpdate, context)));
      },
      renderCall(args, theme) { return renderSubagentInspectCall(args, theme); },
      renderResult(result, options, theme, context) { return renderSubagentInspectResult(result, options, theme, context.args); },
    }),
    defineTool({
      name: "subagents_steer",
      label: "Subagents Steer",
      description: "Send a message to a running subagent. The message is queued safely if its steering handler is not ready; settled runs cannot be steered.",
      parameters: SUBAGENTS_STEER_PARAMETERS,
      async execute(toolCallId, params, signal, onUpdate, context) {
        return toolResult(await manager.steer(validateSubagentSteerRequest(params), managerContext(toolCallId, signal, onUpdate, context)));
      },
      renderCall(args, theme) { return renderSubagentControlCall("subagents_steer", args, theme); },
      renderResult(result, _options, theme) { return renderSubagentControlResult(result, theme); },
    }),
    defineTool({
      name: "subagents_stop",
      label: "Subagents Stop",
      description: "Stop one running subagent, abort its active session, persist state \"stopped\", and clean its worktree without affecting sibling runs.",
      parameters: SUBAGENTS_STOP_PARAMETERS,
      async execute(toolCallId, params, signal, onUpdate, context) {
        return toolResult(await manager.stop(validateSubagentIdRequest(params, "subagents_stop"), managerContext(toolCallId, signal, onUpdate, context)));
      },
      renderCall(args, theme) { return renderSubagentControlCall("subagents_stop", args, theme); },
      renderResult(result, _options, theme) { return renderSubagentControlResult(result, theme); },
    }),
    defineTool({
      name: "subagents_retry",
      label: "Subagents Retry",
      description: "Start a fresh run from a failed or stopped subagent's persisted request. The new run gets a new ID and preserves its original background or foreground mode.",
      parameters: SUBAGENTS_RETRY_PARAMETERS,
      async execute(toolCallId, params, signal, onUpdate, context) {
        return toolResult(await manager.retry(validateSubagentIdRequest(params, "subagents_retry"), managerContext(toolCallId, signal, onUpdate, context)));
      },
      renderCall(args, theme) { return renderSubagentControlCall("subagents_retry", args, theme); },
      renderResult(result, options, theme, context) { return renderSubagentResult(result, options, theme, context); },
    }),
  ];
}

function notificationContent(notification: SubagentNotification): string {
  const label = notification.label?.trim();
  const role = notification.role?.trim() || "none";
  const identity = label ? `${label} role=${role} (${notification.id})` : `${notification.id} role=${role}`;
  if (notification.state === "completed") return `Subagent ${identity} completed. Inspect it with subagents_inspect({ id: "${notification.id}" }).`;
  return `Subagent ${identity} failed: ${notification.error?.message ?? "unknown error"}. Inspect it with subagents_inspect({ id: "${notification.id}" }).`;
}
function managerDependencies(options: SubagentsExtensionOptions, activeTools: (() => readonly string[]) | undefined, notify: ((notification: SubagentNotification) => void | Promise<void>) | undefined, onStatus: ((status: Readonly<SubagentStatus>, request: Readonly<SubagentRunRequest>) => void) | undefined, onResourceWarning?: (message: string) => void): SubagentsExtensionOptions["managerDependencies"] {
  const dependencies = options.managerDependencies;
  const next = {
    ...(dependencies ?? {}),
    ...(activeTools !== undefined && dependencies?.getActiveTools === undefined ? { getActiveTools: activeTools } : {}),
    ...(notify !== undefined && dependencies?.notify === undefined ? { notify } : {}),
    ...(onStatus !== undefined && dependencies?.onStatus === undefined ? { onStatus } : {}),
    ...(onResourceWarning !== undefined && dependencies?.onResourceWarning === undefined ? { onResourceWarning } : {}),
  };
  return Object.keys(next).length === 0 ? dependencies : next;
}
function storageDirectory(options: SubagentsExtensionOptions): string {
  const dependencies = options.managerDependencies;
  return dependencies?.storageDir ?? join(dependencies?.agentDir ?? getAgentDir(), "subagents");
}

export function createSubagentsExtension(options: SubagentsExtensionOptions = {}, activeTools?: () => readonly string[], notify?: (notification: SubagentNotification) => void | Promise<void>, onStatus?: (status: Readonly<SubagentStatus>, request: Readonly<SubagentRunRequest>) => void, onResourceWarning?: (message: string) => void): SubagentsExtension {
  const manager = options.manager ?? createSubagentManager(managerDependencies(options, activeTools, notify, onStatus, onResourceWarning));
  const extension = { manager, tools: createSubagentTools(manager) };
  return extension;
}

export function registerSubagentsExtension(pi: SubagentsExtensionAPI, options: SubagentsExtensionOptions = {}): SubagentsExtension {
  const getActiveTools = pi.getActiveTools;
  const activeTools = getActiveTools === undefined ? undefined : () => getActiveTools.call(pi);
  const sendMessage = pi.sendMessage;
  const notify = sendMessage === undefined ? undefined : (notification: SubagentNotification): void => {
    sendMessage.call(pi, { customType: "subagents", content: notificationContent(notification), display: true, details: notification }, { deliverAs: "steer", triggerTurn: true });
  };
  const onResourceWarning = sendMessage === undefined ? undefined : (message: string): void => {
    sendMessage.call(pi, { customType: "subagents", content: `Warning: ${message}`, display: true }, { deliverAs: "steer" });
  };
  const widget = createSubagentBackgroundWidget();
  const extension = createSubagentsExtension(options, activeTools, notify, (status, request) => { widget.update(status, request); const registry = loadingRegistry(); if (typeof registry.observeSubagentStatus === "function") registry.observeSubagentStatus(status, request); }, onResourceWarning);
  for (const tool of extension.tools) pi.registerTool(tool);
  if (pi.registerCommand !== undefined) registerSubagentNavigator(pi.registerCommand.bind(pi), extension.manager, storageDirectory(options), options.clipboard);
  if (pi.on !== undefined) {
    setSubagentManager(extension.manager);
    pi.on("session_start", (_event, context) => { widget.start(context); });
    pi.on("session_shutdown", async () => {
      try {
        widget.dispose();
        await extension.manager.dispose?.();
      } finally {
        clearSubagentManager(extension.manager);
      }
    });
  }
  return extension;
}

export default function extension(pi: ExtensionAPI, options: SubagentsExtensionOptions = {}): void {
  registerSubagentsExtension(pi, options);
}
