import type { SubagentsHandle } from "./agents-actions-contract.js";

const SUBAGENTS_HANDLE_KEY = Symbol.for("pi-extensible-workflows.subagents-handle");
const globalSubagentsHandles = globalThis as typeof globalThis & Record<symbol, SubagentsHandle | undefined>;

/** The subagents extension entry publishes its actions and presenter; the core host, another bundle, reads them when /agents opens. */
export function setSubagentsHandle(handle: SubagentsHandle | undefined): void { globalSubagentsHandles[SUBAGENTS_HANDLE_KEY] = handle; }
export function getSubagentsHandle(): SubagentsHandle | undefined { return globalSubagentsHandles[SUBAGENTS_HANDLE_KEY]; }
export function clearSubagentsHandle(handle: SubagentsHandle): void { if (globalSubagentsHandles[SUBAGENTS_HANDLE_KEY] === handle) globalSubagentsHandles[SUBAGENTS_HANDLE_KEY] = undefined; }
