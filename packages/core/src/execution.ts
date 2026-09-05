import { fork, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { RunStore, structuralPath as operationPath } from "./persistence.js";
import type { AgentAttempt } from "./agent-execution.js";
import type { AgentIdentity, AgentAttemptSummary, FunctionIdentity, JsonValue, ShellIdentity, ShellOptions, ShellResult, WorkflowAgentSessionReference, WorkflowBridge, WorkflowErrorCode, WorkflowExecution } from "./types.js";
import { WorkflowError, roleNameOf, sumAccounting, zeroAccounting } from "./types.js";
import { asWorkflowError, errorText, fail, isWorkflowAuthored, isWorkflowErrorCode, jsonValue, markWorkflowAuthored, object, positiveInteger } from "./utils.js";
import { instrumentWorkflow, validateAgentOptions, validateShellCommand, validateShellOptions } from "./validation.js";

export const RPC_LIMIT_BYTES = 10 * 1024 * 1024;
type WorkerErrorShape = { code?: string; message: string; authored?: boolean; failedAt?: string };
export const HEARTBEAT_TIMEOUT_MS = 5000;
type RpcMessage =
  | { type: "heartbeat" }
  | { type: "result"; value: JsonValue }
  | { type: "error"; error: WorkerErrorShape }
  | { type: "rpc"; id: number; method: string; args: JsonValue[] }
  | { type: "rpcResult"; id: number; ok: true; value: JsonValue }
  | { type: "rpcResult"; id: number; ok: false; error: WorkerErrorShape }
  | { type: "cancel" };
function hasOwn(value: object, key: string): boolean { return Object.prototype.hasOwnProperty.call(value, key); }
function isWorkerErrorShape(value: unknown): value is WorkerErrorShape {
  return object(value) && typeof value.message === "string" && (value.code === undefined || typeof value.code === "string") && (value.authored === undefined || typeof value.authored === "boolean") && (value.failedAt === undefined || typeof value.failedAt === "string");
}
function isRpcMessage(value: unknown): value is RpcMessage {
  if (!object(value) || typeof value.type !== "string") return false;
  if (value.type === "heartbeat" || value.type === "cancel") return true;
  if (value.type === "result") return hasOwn(value, "value") && jsonValue(value.value);
  if (value.type === "error") return isWorkerErrorShape(value.error);
  if (value.type === "rpc") return positiveInteger(value.id) && typeof value.method === "string" && Boolean(value.method.trim()) && Array.isArray(value.args) && value.args.every((arg) => jsonValue(arg));
  if (value.type === "rpcResult") {
    if (!positiveInteger(value.id) || typeof value.ok !== "boolean") return false;
    if (value.ok) return hasOwn(value, "value") && !hasOwn(value, "error") && jsonValue(value.value);
    return !hasOwn(value, "value") && isWorkerErrorShape(value.error);
  }
  return false;
}
const HEARTBEAT_INTERVAL_MS = 1000;

const OUTCOME_ERRORS = new Set<string>(["AGENT_TIMEOUT", "AGENT_FAILED", "RESULT_INVALID"]);
const WORK_RESULT_BRAND = "__workResult";

const childSource = String.raw`
"use strict";
const { AsyncLocalStorage } = require("node:async_hooks");
const vm = require("node:vm");
const LIMIT = parseInt(process.argv[2], 10);
const config = JSON.parse(process.argv[3]);
for (const key of ["getBuiltinModule","binding","_linkedBinding","dlopen","kill","abort","exit","reallyExit","_kill","umask","chdir","setuid","setgid","seteuid","setegid","setgroups","initgroups"]) {
  if (key in process) process[key] = undefined;
}
let nextId = 0;
let cancelled = false;
const pending = new Map();
const inflight = new Set();
const hasMessage = error => Boolean(error && typeof error === "object" && typeof error.message === "string");
const errorText = error => hasMessage(error) ? error.message : String(error);
const errorCode = error => { if (!error || typeof error !== "object") return undefined; const code = error.code; return typeof code === "string" ? code : undefined; };
const errorAuthored = error => Boolean(error && typeof error === "object" && error.authored === true);
const workerError = error => { const code = errorCode(error); return { code: code || "INTERNAL_ERROR", message: errorText(error), ...(error && typeof error === "object" && typeof error.failedAt === "string" ? { failedAt: error.failedAt } : {}), ...(errorAuthored(error) || hasMessage(error) && !code ? { authored: true } : {}) }; };
const workflowError = error => Object.assign(new Error(errorText(error)), workerError(error));
function send(value) {
  const json = JSON.stringify(value);
  if (json === undefined || Buffer.byteLength(json) > LIMIT) throw Object.assign(new Error("RPC value exceeds the 10 MB JSON boundary"), { code: "RPC_LIMIT_EXCEEDED" });
  process.send(json);
}
function rpc(method, args) {
  if (cancelled) throw Object.assign(new Error("Workflow cancelled"), { code: "CANCELLED" });
  const id = ++nextId;
  send({ type: "rpc", id, method, args });
  const promise = new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  inflight.add(promise);
  void promise.then(() => inflight.delete(promise), () => inflight.delete(promise));
  return promise;
}
process.on("message", raw => {
  let message;
  try {
    if (typeof raw !== "string" || Buffer.byteLength(raw) > LIMIT) throw Object.assign(new Error("RPC value exceeds the 10 MB JSON boundary"), { code: "RPC_LIMIT_EXCEEDED" });
    message = JSON.parse(raw);
  } catch (error) { send({ type: "error", error: workerError(error) }); return; }
  if (message.type === "cancel") { cancelled = true; for (const { reject } of pending.values()) reject(Object.assign(new Error("Workflow cancelled"), { code: "CANCELLED" })); pending.clear(); return; }
  if (message.type !== "rpcResult") return;
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.ok) request.resolve(message.value);
  else request.reject(workflowError(message.error));
});
const heartbeat = setInterval(() => send({ type: "heartbeat" }), ${HEARTBEAT_INTERVAL_MS});
send({ type: "heartbeat" });
const BRAND = "${WORK_RESULT_BRAND}";
const workError = (code, message) => Object.assign(new Error(message), { code });
const isBranded = value => value && typeof value === "object" && value[BRAND] === true;
const unwrap = result => {
  if (!isBranded(result)) return result;
  if (result.ok) return result.value;
  throw Object.assign(workflowError(result.error), { failedAt: result.failedAt });
};
const named = (value, kind) => { if (typeof value !== "string" || !value.trim()) throw workError("INVALID_METADATA", kind + " requires a stable explicit name"); return value; };
// Each argument is one path segment. A failedAt coming back from a nested operation is already a
// full path, so it is passed through untouched: feeding it here would encode its separators again.
const path = (...names) => names.map(encodeURIComponent).join("/");
const inheritedAgentPath = new AsyncLocalStorage();
const agentOccurrences = new Map();
const agentInflight = new Set();
const shellOccurrences = new Map();
const worktreeOwners = new AsyncLocalStorage();
const rejectAgent = () => { throw workError("INVALID_METADATA", "Workflow agent calls must use a direct agent(...) call; aliases and indirect calls are unsupported"); };
const guardedAgentResult = result => Object.defineProperties(result, {
  toJSON: { value() { throw workError("INVALID_METADATA", "Workflow agent result is a Promise; await it before serialization"); } },
  toString: { value() { throw workError("INVALID_METADATA", "Workflow agent result is a Promise; await it before interpolation"); } },
  [Symbol.toPrimitive]: { value() { throw workError("INVALID_METADATA", "Workflow agent result is a Promise; await it before interpolation"); } },
});
const rejectShell = () => { throw workError("INVALID_METADATA", "Workflow shell calls must use a direct shell(...) call; aliases and indirect calls are unsupported"); };
const rejectWorktree = () => { throw workError("INVALID_METADATA", "withWorktree calls must use a direct withWorktree(...) call; aliases and indirect calls are unsupported"); };
const internalWithWorktree = async (...values) => {
  if (values.length !== 2) throw workError("INVALID_METADATA", "withWorktree requires a name and callback");
  const name = values[0];
  const callback = values[1];
  if (typeof name !== "string" || !name.trim()) throw workError("INVALID_METADATA", "withWorktree name must be a non-empty string");
  if (typeof callback !== "function") throw workError("INVALID_METADATA", "withWorktree callback must be a function");
  const owner = path("worktree", "named", name.trim());
  const reference = await rpc("worktree", [owner]);
  if (!reference || typeof reference !== "object" || typeof reference.path !== "string" || typeof reference.branch !== "string") throw workError("WORKTREE_FAILED", "Worktree reference is invalid");
  return await worktreeOwners.run(owner, () => callback(Object.freeze({ path: reference.path, branch: reference.branch })));
};
const internalAgent = (...values) => {
  const callSite = values.pop();
  if (typeof callSite !== "string") throw workError("INTERNAL_ERROR", "Missing workflow agent call-site identity");
  const inherited = inheritedAgentPath.getStore() || [];
  const occurrenceKey = JSON.stringify([inherited, callSite]);
  if (agentInflight.has(occurrenceKey)) throw workError("INVALID_METADATA", "Concurrent agent calls from the same source call site are unsupported; use parallel(...) or pipeline(...)");
  agentInflight.add(occurrenceKey);
  const occurrence = (agentOccurrences.get(occurrenceKey) || 0) + 1;
  agentOccurrences.set(occurrenceKey, occurrence);
  const options = values.length < 2 || values[1] === undefined ? {} : values[1];
  const worktreeOwner = worktreeOwners.getStore();
  const identity = { structuralPath: [...inherited], callSite, occurrence, ...(worktreeOwner ? { worktreeOwner } : {}) };
  let result;
  try {
    result = rpc("agent", [values[0], options, identity]).then(unwrap);
  } catch (error) {
    agentInflight.delete(occurrenceKey);
    throw error;
  }
  void result.then(() => agentInflight.delete(occurrenceKey), () => agentInflight.delete(occurrenceKey));
  return guardedAgentResult(result);
};
const AGENT_HANDLE_KEYS = ["name", "role", "model", "tools", "skills", "extensions", "contextFiles", "label"];
const agentHandleNames = new Set();
const agentHandleInflight = new Set();
const internalAgentCreate = (...values) => {
  if (values.length !== 1 || !values[0] || typeof values[0] !== "object" || Array.isArray(values[0])) throw workError("INVALID_METADATA", "agent.create requires one options object");
  const options = values[0];
  const name = named(options.name, "agent.create");
  const unsupported = Object.keys(options).find(key => !AGENT_HANDLE_KEYS.includes(key));
  if (unsupported) throw workError("INVALID_METADATA", "agent.create option is unsupported: " + unsupported);
  if (agentHandleNames.has(name)) throw workError("INVALID_METADATA", "Duplicate agent handle name: " + name);
  agentHandleNames.add(name);
  const config = Object.freeze(Object.fromEntries(Object.entries(options).filter(([key]) => key !== "name")));
  const worktreeOwner = worktreeOwners.getStore();
  // The turn counter is arrival-ordered, so a handle must stay in the scope that created it: sends racing across
  // parallel branches would otherwise take each other's journal path on replay.
  const scope = JSON.stringify(inheritedAgentPath.getStore() || []);
  let turn = 0;
  const send = (...sent) => {
    if (sent.length < 1 || sent.length > 2) throw workError("INVALID_METADATA", "send requires a prompt and optional options");
    if (typeof sent[0] !== "string") throw workError("INVALID_METADATA", "send prompt must be a string");
    const sendOptions = sent.length < 2 || sent[1] === undefined ? {} : sent[1];
    if (!sendOptions || typeof sendOptions !== "object" || Array.isArray(sendOptions) || Object.keys(sendOptions).some(key => key !== "outputSchema" && key !== "timeoutMs")) throw workError("INVALID_METADATA", "send options must contain only outputSchema and timeoutMs");
    if (JSON.stringify(inheritedAgentPath.getStore() || []) !== scope) throw workError("INVALID_METADATA", "Agent handle sends must run in the scope that created the handle: " + name);
    if (agentHandleInflight.has(name)) throw workError("INVALID_METADATA", "Concurrent send(...) calls on one agent handle are unsupported; await each turn");
    agentHandleInflight.add(name);
    turn += 1;
    const identity = { structuralPath: [...(inheritedAgentPath.getStore() || [])], callSite: "handle:" + name, occurrence: turn, handle: name, turn, ...(worktreeOwner ? { worktreeOwner } : {}) };
    let result;
    try {
      result = rpc("agent", [sent[0], { ...config, ...sendOptions }, identity]).then(unwrap);
    } catch (error) {
      agentHandleInflight.delete(name);
      throw error;
    }
    void result.then(() => agentHandleInflight.delete(name), () => agentHandleInflight.delete(name));
    return guardedAgentResult(result);
  };
  return Object.freeze({ name, send });
};
const internalShell = (...values) => {
  const callSite = values.pop();
  if (typeof callSite !== "string") throw workError("INTERNAL_ERROR", "Missing workflow shell call-site identity");
  if (values.length !== 1 && values.length !== 2) throw workError("INVALID_METADATA", "shell requires a command string and optional options");
  const command = values[0];
  if (typeof command !== "string") throw workError("INVALID_METADATA", "shell command must be a string");
  const options = values.length < 2 || values[1] === undefined ? {} : values[1];
  if (!options || typeof options !== "object" || Array.isArray(options) || Object.keys(options).some(key => key !== "timeoutMs" && key !== "env")) throw workError("INVALID_METADATA", "shell options must contain only timeoutMs and env");
  if (options.timeoutMs !== undefined && (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)) throw workError("INVALID_METADATA", "shell timeoutMs must be a positive integer");
  if (options.env !== undefined && (!options.env || typeof options.env !== "object" || Array.isArray(options.env) || Object.values(options.env).some(value => typeof value !== "string"))) throw workError("INVALID_METADATA", "shell env must be an object of strings");
  const inherited = inheritedAgentPath.getStore() || [];
  const worktreeOwner = worktreeOwners.getStore();
  const occurrenceKey = JSON.stringify([inherited, callSite, worktreeOwner || null]);
  const occurrence = (shellOccurrences.get(occurrenceKey) || 0) + 1;
  shellOccurrences.set(occurrenceKey, occurrence);
  const identity = { structuralPath: [...inherited], callSite, occurrence, ...(worktreeOwner ? { worktreeOwner } : {}) };
  const result = rpc("shell", [command, options, identity]);
  Object.defineProperties(result, {
    toJSON: { value() { throw workError("INVALID_METADATA", "Workflow shell result is a Promise; await it before serialization"); } },
    toString: { value() { throw workError("INVALID_METADATA", "Workflow shell result is a Promise; await it before interpolation"); } },
    [Symbol.toPrimitive]: { value() { throw workError("INVALID_METADATA", "Workflow shell result is a Promise; await it before interpolation"); } },
  });
  return result;
};
const shell = rejectShell;
const agent = Object.freeze(Object.assign(rejectAgent, { create: internalAgentCreate }));
const promptPath = (at, key) => /^[A-Za-z_$][\w$]*$/.test(key) ? at + "." + key : at + "[" + JSON.stringify(key) + "]";
const plainPromptObject = value => {
  const proto = Object.getPrototypeOf(value);
  return proto === null || Object.getPrototypeOf(proto) === null && Object.prototype.hasOwnProperty.call(proto, "constructor") && typeof proto.constructor === "function" && Function.prototype.toString.call(proto.constructor) === Function.prototype.toString.call(Object);
};
const promptValue = (value, at, seen) => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" must be a finite number"); return; }
  if (typeof value !== "object") throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" cannot be " + typeof value);
  if (typeof value.then === "function") throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" is a Promise or thenable; await it before calling prompt()");
  if (!Array.isArray(value) && !plainPromptObject(value)) throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" must be a plain object");
  if (seen.has(value)) throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" contains a cycle");
  const keys = Reflect.ownKeys(value);
  const symbol = keys.find(key => typeof key === "symbol");
  if (symbol) throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" contains a symbol key");
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) promptProperty(value, String(index), at + "[" + index + "]", seen);
    for (const key of keys) {
      const index = Number(key);
      if (key !== "length" && !(Number.isInteger(index) && index >= 0 && index < value.length && String(index) === key)) promptProperty(value, key, promptPath(at, key), seen);
    }
  } else for (const key of keys) promptProperty(value, key, promptPath(at, key), seen);
  seen.delete(value);
};
const promptProperty = (value, key, at, seen) => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor && (descriptor.get || descriptor.set)) throw workError("INVALID_METADATA", "Prompt value \"" + at + "\" cannot use getters or setters");
  promptValue(descriptor && descriptor.value, at, seen);
};
const prompt = (template, values) => {
  if (typeof template !== "string") throw workError("INVALID_METADATA", "prompt() template must be a string");
  if (!values || typeof values !== "object" || Array.isArray(values) || !plainPromptObject(values)) throw workError("INVALID_METADATA", "prompt() values must be a plain object");
  const placeholders = [...template.matchAll(/{{|}}|{([A-Za-z_$][\w$]*)}/g)].flatMap(match => match[1] === undefined ? [] : [match[1]]);
  const used = new Set(placeholders);
  const keys = Reflect.ownKeys(values);
  const symbol = keys.find(key => typeof key === "symbol");
  if (symbol) throw workError("INVALID_METADATA", "prompt() values must use string keys");
  const missing = placeholders.find(key => !Object.prototype.hasOwnProperty.call(values, key));
  if (missing) throw workError("INVALID_METADATA", "Missing prompt value \"" + missing + "\"");
  const unused = keys.find(key => !used.has(key));
  if (unused !== undefined) throw workError("INVALID_METADATA", "Unused prompt value \"" + unused + "\"");
  for (const key of keys) promptProperty(values, key, key, new Set());
  return template.replace(/{{|}}|{([A-Za-z_$][\w$]*)}/g, (match, key) => match === "{{" ? "{" : match === "}}" ? "}" : typeof values[key] === "string" ? values[key] : JSON.stringify(values[key], null, 2));
};
const checkpoint = input => rpc("checkpoint", [input]).then(unwrap);
const phase = name => rpc("phase", [name]);
const log = message => rpc("log", [message]);
const functionOccurrences = new Map();
const functionIdentity = name => {
  const structuralPath = inheritedAgentPath.getStore() || [];
  const key = JSON.stringify([structuralPath, name]);
  const occurrence = (functionOccurrences.get(key) || 0) + 1;
  functionOccurrences.set(key, occurrence);
  const worktreeOwner = worktreeOwners.getStore();
  return { path: path("function", ...structuralPath, name, String(occurrence)), structuralPath: [...structuralPath], occurrence, ...(worktreeOwner ? { worktreeOwner } : {}) };
};
const functions = Object.freeze(Object.fromEntries(Object.entries(config.functions || {}).map(([local, target]) => [local, (...values) => {
  if (values.length !== 1 || !values[0] || typeof values[0] !== "object" || Array.isArray(values[0])) throw workError("RESULT_INVALID", local + " requires exactly one JSON object argument");
  const identity = functionIdentity(target.name);
  const result = rpc("function", [target.name, values[0], identity]).then(unwrap);
  Object.defineProperty(result, "toJSON", { value() { throw workError("INVALID_METADATA", "Workflow function result is a Promise; await it before serialization"); } });
  return result;
}])));
const recordEntries = (value, kind) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw workError("INVALID_METADATA", kind + " must be a record");
  return Object.entries(value);
};
const parallel = async (operationName, tasks) => {
  named(operationName, "parallel");
  const entries = recordEntries(tasks, "parallel tasks");
  for (const [name, run] of entries) {
    named(name, "parallel task");
    if (typeof run !== "function") throw workError("INVALID_METADATA", "parallel task values must be run functions");
  }
  const results = await Promise.all(entries.map(async ([name, run]) => {
    // Captured outside the scope's run() so the fallback failedAt below is absolute: a plain throw
    // inside a nested scope must still name the full outer path, or sibling scopes with the same
    // inner names become indistinguishable in diagnostics and retry provenance.
    const parent = inheritedAgentPath.getStore() || [];
    try {
      return { name, ok: true, value: await inheritedAgentPath.run([...parent, operationName, name], run) };
    } catch (error) {
      if (errorCode(error) === "CANCELLED") throw error;
      const failedAt = error && typeof error === "object" && typeof error.failedAt === "string" ? error.failedAt : undefined;
      return { name, ok: false, failedAt: failedAt || path(...parent, operationName, name), error: workerError(error) };
    }
  }));
  const failure = results.find(result => !result.ok);
  if (failure) throw Object.assign(workflowError(failure.error), { failedAt: failure.failedAt });
  return Object.fromEntries(results.map(result => [result.name, result.value]));
};
const pipeline = async (operationName, items, stages) => {
  named(operationName, "pipeline");
  const itemEntries = recordEntries(items, "pipeline items");
  const stageEntries = recordEntries(stages, "pipeline stages");
  if (!stageEntries.length) throw workError("INVALID_METADATA", "pipeline requires at least one stage");
  for (const [name] of itemEntries) named(name, "pipeline item");
  for (const [stageName, run] of stageEntries) {
    named(stageName, "pipeline stage");
    if (typeof run !== "function") throw workError("INVALID_METADATA", "pipeline stage values must be run functions");
  }
  const results = await Promise.all(itemEntries.map(async ([name, initial]) => {
    let value = initial;
    // See the parallel fallback above: parent makes the stage-level failedAt fallback absolute.
    const parent = inheritedAgentPath.getStore() || [];
    let failedAt = path(...parent, operationName, name);
    try {
      for (const [stageName, run] of stageEntries) {
        failedAt = path(...parent, operationName, name, stageName);
        value = await inheritedAgentPath.run([...parent, operationName, name, stageName], () => run(value));
      }
      return { name, ok: true, value };
    } catch (error) {
      if (errorCode(error) === "CANCELLED") throw error;
      const nestedFailedAt = error && typeof error === "object" && typeof error.failedAt === "string" ? error.failedAt : undefined;
      return { name, ok: false, failedAt: nestedFailedAt || failedAt, error: workerError(error) };
    }
  }));
  const failure = results.find(result => !result.ok);
  if (failure) throw Object.assign(workflowError(failure.error), { failedAt: failure.failedAt });
  return Object.fromEntries(results.map(result => [result.name, result.value]));
};
const safeMath = Object.fromEntries(Object.getOwnPropertyNames(Math).filter(name => name !== "random").map(name => [name, Math[name]]));
const sandbox = { agent, shell, withWorktree: rejectWorktree, prompt, checkpoint, parallel, pipeline, phase, log, args: config.args, Promise, JSON, Math: Object.freeze(safeMath) };
for (const [name, fn] of Object.entries(functions)) Object.defineProperty(sandbox, name, { value: fn, writable: false, configurable: false });
for (const name of ["Date","eval","Function","WebAssembly","process","require","module","exports","console","fetch","XMLHttpRequest","WebSocket","performance","crypto","setTimeout","setInterval","setImmediate","queueMicrotask","Intl","SharedArrayBuffer","Atomics"]) sandbox[name] = undefined;
const context = vm.createContext(sandbox, { codeGeneration: { strings: false, wasm: false } });
const body = config.script;
Promise.resolve().then(() => new vm.Script("(async(__pi_extensible_workflows_agent,__pi_extensible_workflows_withWorktree,__pi_extensible_workflows_shell)=>{" + body + "\n})", { filename: "workflow.js" }).runInContext(context)(internalAgent, internalWithWorktree, internalShell))
  .then(async value => { await Promise.all(inflight); send({ type: "result", value: value === undefined ? null : value }); })
  .catch(error => send({ type: "error", error: workerError(error) }))
  .finally(() => clearInterval(heartbeat));
`;

export function encoded(value: JsonValue): string;
export function encoded(value: unknown): asserts value is JsonValue;
export function encoded(value: unknown): string {
  if (!jsonValue(value)) fail("RPC_LIMIT_EXCEEDED", "RPC values must be JSON-compatible");
  const json = JSON.stringify(value);
  if (Buffer.byteLength(json) > RPC_LIMIT_BYTES) fail("RPC_LIMIT_EXCEEDED", "RPC value exceeds the 10 MB JSON boundary");
  return json;
}

function encodedRpcResult(id: number, value: JsonValue): string {
  return encoded({ type: "rpcResult", id, ok: true, value });
}

function readAgentIdentity(value: unknown): AgentIdentity {
  if (!object(value)) fail("INTERNAL_ERROR", "Invalid workflow agent identity");
  const structuralPath = value.structuralPath;
  const callSite = value.callSite;
  const occurrence = value.occurrence;
  const worktreeOwner = value.worktreeOwner;
  const parentBreadcrumb = value.parentBreadcrumb;
  const handle = value.handle;
  const turn = value.turn;
  if (!Array.isArray(structuralPath) || !structuralPath.every((part): part is string => typeof part === "string" && Boolean(part.trim())) || typeof callSite !== "string" || !callSite || !positiveInteger(occurrence) || parentBreadcrumb !== undefined && (typeof parentBreadcrumb !== "string" || !parentBreadcrumb.trim()) || worktreeOwner !== undefined && (typeof worktreeOwner !== "string" || !worktreeOwner) || handle !== undefined && (typeof handle !== "string" || !handle.trim() || !positiveInteger(turn))) fail("INTERNAL_ERROR", "Invalid workflow agent identity");
  return { structuralPath: [...structuralPath], callSite, occurrence, ...(typeof parentBreadcrumb === "string" ? { parentBreadcrumb } : {}), ...(typeof worktreeOwner === "string" ? { worktreeOwner } : {}), ...(typeof handle === "string" ? { handle, turn: turn as number } : {}) };
}
function readFunctionIdentity(value: unknown): FunctionIdentity {
  if (!object(value)) fail("INTERNAL_ERROR", "Invalid workflow function identity");
  const path = value.path;
  const structuralPath = value.structuralPath;
  const occurrence = value.occurrence;
  const worktreeOwner = value.worktreeOwner;
  if (typeof path !== "string" || !path || !Array.isArray(structuralPath) || !structuralPath.every((part): part is string => typeof part === "string" && Boolean(part.trim())) || !positiveInteger(occurrence) || worktreeOwner !== undefined && (typeof worktreeOwner !== "string" || !worktreeOwner)) fail("INTERNAL_ERROR", "Invalid workflow function identity");
  return { path, structuralPath: [...structuralPath], occurrence, ...(typeof worktreeOwner === "string" ? { worktreeOwner } : {}) };
}
function readShellIdentity(value: unknown): ShellIdentity {
  const identity = readAgentIdentity(value);
  return { structuralPath: identity.structuralPath, callSite: identity.callSite, occurrence: identity.occurrence, ...(identity.worktreeOwner ? { worktreeOwner: identity.worktreeOwner } : {}) };
}
export function agentHandleTurnPath(handle: string, turn: number): string {
  return operationPath("agent", "handle", handle, `turn:${String(turn)}`);
}
export function agentIdentityPath(identity: AgentIdentity): string {
  if (identity.handle !== undefined && identity.turn !== undefined) return agentHandleTurnPath(identity.handle, identity.turn);
  return operationPath("agent", ...identity.structuralPath, `callsite:${identity.callSite}`, `occurrence:${String(identity.occurrence)}`);
}
export function shellIdentityPath(identity: ShellIdentity): string {
  return operationPath("shell", ...(identity.worktreeOwner ? ["worktree", identity.worktreeOwner] : []), ...identity.structuralPath, `callsite:${identity.callSite}`, `occurrence:${String(identity.occurrence)}`);
}
export function readShellResult(value: unknown): ShellResult {
  if (!object(value) || (value.exitCode !== null && !Number.isInteger(value.exitCode)) || typeof value.stdout !== "string" || typeof value.stderr !== "string") fail("SHELL_FAILED", "Shell bridge returned an invalid result");
  return { exitCode: value.exitCode as number | null, stdout: value.stdout, stderr: value.stderr };
}
export function agentWorktree(identity: AgentIdentity): { worktreeOwner?: string } {
  return identity.worktreeOwner ? { worktreeOwner: identity.worktreeOwner } : {};
}
function shellProcessKill(child: ChildProcess): void {
  let forceKill: ReturnType<typeof setTimeout> | undefined;
  const killProcessTree = (signal: "SIGTERM" | "SIGKILL") => {
    try {
      if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
      else if (child.pid && process.platform === "win32") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore", windowsHide: true });
        killer.unref();
      } else child.kill(signal);
    } catch {
      try { child.kill(signal); } catch { /* The process may already have exited. */ }
    }
  };
  child.once("close", () => { if (forceKill) clearTimeout(forceKill); });
  killProcessTree("SIGTERM");
  forceKill = setTimeout(() => { forceKill = undefined; killProcessTree("SIGKILL"); }, 1000);
  forceKill.unref();
}
export function executeShellCommand(command: string, options: ShellOptions, signal: AbortSignal, cwd = process.cwd()): Promise<ShellResult> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try { child = spawn(command, { shell: true, cwd, env: { ...process.env, ...(options.env ?? {}) }, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { reject(new WorkflowError("SHELL_FAILED", errorText(error))); return; }
    let settled = false;
    let timedOut = false;
    let outputBytes = 0;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    let stdout = "";
    let stderr = "";
    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
    };
    const failShell = (error: WorkflowError) => {
      if (settled) return;
      settled = true;
      cleanup();
      shellProcessKill(child);
      reject(error);
    };
    const onAbort = () => { failShell(new WorkflowError("CANCELLED", "Workflow cancelled")); };
    const capture = (target: "stdout" | "stderr", chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.byteLength;
      if (outputBytes > RPC_LIMIT_BYTES) { failShell(new WorkflowError("RPC_LIMIT_EXCEEDED", "Shell result exceeds the 10 MB JSON boundary")); return; }
      if (target === "stdout") stdout += stdoutDecoder.write(chunk); else stderr += stderrDecoder.write(chunk);
    };
    child.stdout?.on("data", (chunk: Buffer) => { capture("stdout", chunk); });
    child.stderr?.on("data", (chunk: Buffer) => { capture("stderr", chunk); });
    child.once("error", (error) => { failShell(new WorkflowError("SHELL_FAILED", errorText(error))); });
    child.once("close", (exitCode) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout += stdoutDecoder.end();
      stderr += stderrDecoder.end();
      if (signal.aborted) { reject(new WorkflowError("CANCELLED", "Workflow cancelled")); return; }
      if (timedOut) { reject(new WorkflowError("SHELL_FAILED", `Shell command timed out after ${String(options.timeoutMs)}ms`)); return; }
      const result = { exitCode: exitCode === null ? null : exitCode, stdout, stderr };
      try { encodedRpcResult(Number.MAX_SAFE_INTEGER, result); } catch (error) { reject(error instanceof WorkflowError ? error : new WorkflowError("RPC_LIMIT_EXCEEDED", errorText(error))); return; }
      resolve(result);
    });
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    if (options.timeoutMs !== undefined) timeout = setTimeout(() => { timedOut = true; shellProcessKill(child); }, options.timeoutMs);
  });
}
function workflowErrorFromWorker(error: WorkerErrorShape): WorkflowError {
  const code = isWorkflowErrorCode(error.code) ? error.code : "INTERNAL_ERROR";
  const typed = markWorkflowAuthored(new WorkflowError(code, error.message), Boolean(error.authored) || error.code === undefined);
  return error.failedAt === undefined ? typed : Object.assign(typed, { failedAt: error.failedAt });
}
export function runWorkflow(script: string, args: JsonValue = null, bridge: WorkflowBridge = {}, signal?: AbortSignal): WorkflowExecution {
  encoded(args);
  const config = JSON.stringify({ script: instrumentWorkflow(script), args: structuredClone(args), functions: bridge.functions ?? {} });
  const childDir = realpathSync(mkdtempSync(join(tmpdir(), "pi-wf-")));
  const childFile = join(childDir, "child.cjs");
  writeFileSync(childFile, childSource);
  const child: ChildProcess = fork(childFile, [String(RPC_LIMIT_BYTES), config], {
    execArgv: (() => {
      const filtered: string[] = [];
      const skip = new Set(["--input-type", "-e", "--eval", "-p", "--print"]);
      let skipNext = false;
      for (const arg of process.execArgv) {
        if (skipNext) { skipNext = false; continue; }
        if (skip.has(arg) || skip.has(arg.split("=")[0] ?? "")) { if (!arg.includes("=")) skipNext = true; continue; }
        filtered.push(arg);
      }
      return [...filtered, "--max-old-space-size=128", "--permission", `--allow-fs-read=${childDir}`];
    })(),
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    serialization: "advanced",
  });
  const controller = new AbortController();
  let settled = false;
  let rejectResult: (error: WorkflowError) => void = () => undefined;
  let lastHeartbeatAt = performance.now();
  let lastWatchdogCheckAt = lastHeartbeatAt;
  const watchdog = setInterval(() => {
    const now = performance.now();
    // A check delayed enough to bridge the normal heartbeat margin makes elapsed time unreliable.
    const watchdogCheckWasDelayed = now - lastWatchdogCheckAt >= HEARTBEAT_TIMEOUT_MS - HEARTBEAT_INTERVAL_MS;
    lastWatchdogCheckAt = now;
    if (watchdogCheckWasDelayed) { lastHeartbeatAt = now; return; }
    if (now - lastHeartbeatAt >= HEARTBEAT_TIMEOUT_MS) stop("WORKER_UNRESPONSIVE", "Workflow worker missed its five-second heartbeat");
  }, HEARTBEAT_INTERVAL_MS);
  const result = new Promise<JsonValue>((resolve, reject) => {
    rejectResult = reject;
    child.on("message", (raw: unknown) => {
      try {
        if (typeof raw !== "string" || Buffer.byteLength(raw) > RPC_LIMIT_BYTES) fail("RPC_LIMIT_EXCEEDED", "RPC value exceeds the 10 MB JSON boundary");
        const parsed: unknown = JSON.parse(raw);
        if (!isRpcMessage(parsed)) fail("INTERNAL_ERROR", "Worker RPC message is invalid");
        const message = parsed;
        if (message.type === "heartbeat") { lastHeartbeatAt = performance.now(); return; }
        if (message.type === "result") { encoded(message.value); finish(); resolve(message.value); return; }
        if (message.type === "error") { controller.abort(); finish(); reject(workflowErrorFromWorker(message.error)); return; }
        if (message.type === "rpc") void handleRpc(message.id, message.method, message.args);
      } catch (error) { stop(error instanceof WorkflowError ? error.code : "INTERNAL_ERROR", errorText(error)); }
    });
    child.on("error", (error: Error) => { stop("INTERNAL_ERROR", error.message); });
    child.on("exit", (code) => { if (!settled && code !== 0) stop("INTERNAL_ERROR", `Workflow child exited with code ${String(code)}`); });
  });
  function killChild() {
    if (!child.killed) {
      child.kill("SIGTERM");
      setTimeout(() => { if (!child.killed) child.kill("SIGKILL"); }, 1000).unref();
    }
  }
  function finish() { settled = true; clearInterval(watchdog); signal?.removeEventListener("abort", cancel); killChild(); rmSync(childDir, { recursive: true, force: true }); }
  function stop(code: WorkflowErrorCode, message: string) { if (settled) return; controller.abort(); finish(); rejectResult(new WorkflowError(code, message)); }
  function branded(result: Record<string, JsonValue>): JsonValue { return { ...result, [WORK_RESULT_BRAND]: true }; }
  async function handleRpc(id: number, method: string, values: JsonValue[]) {
    try {
      encoded(values);
      let value: JsonValue = null;
      if (method === "agent") {
        if (!bridge.agent) fail("AGENT_FAILED", "No agent bridge is available");
        if (typeof values[0] !== "string") fail("INTERNAL_ERROR", "agent prompt must be a string");
        const opts = validateAgentOptions(values[1]);
        const identity = readAgentIdentity(values[2]);
        const path = agentIdentityPath(identity);
        const label = typeof opts.label === "string" ? opts.label : roleNameOf(opts.role) ?? "agent";
        try {
          const result = await bridge.agent(values[0], opts, controller.signal, identity);
          value = branded({ name: label, ok: true, value: result ?? null });
        } catch (error) {
          const typed = asWorkflowError(error);
          if (!OUTCOME_ERRORS.has(typed.code)) throw typed;
          value = branded({ name: label, ok: false, failedAt: path, error: { code: typed.code, message: typed.message, ...(isWorkflowAuthored(typed) ? { authored: true } : {}) } });
        }
      } else if (method === "shell") {
        if (!bridge.shell) fail("SHELL_FAILED", "No shell bridge is available");
        const command = validateShellCommand(values[0]);
        const options = validateShellOptions(values[1]);
        const identity = readShellIdentity(values[2]);
        const result = readShellResult(await bridge.shell(command, options, controller.signal, identity));
        if (!jsonValue(result)) fail("RPC_LIMIT_EXCEEDED", "RPC values must be JSON-compatible");
        value = result;
      } else if (method === "checkpoint") {
        if (!bridge.checkpoint || !object(values[0])) fail("INTERNAL_ERROR", "checkpoint requires an available bridge and object input");
        const name = typeof values[0].name === "string" ? values[0].name : "checkpoint";
        try {
          const result = await bridge.checkpoint(values[0], controller.signal);
          if (typeof result !== "boolean") fail("INTERNAL_ERROR", "checkpoint must return a boolean");
          value = branded({ name, ok: true, value: result ? "approved" : "rejected" });
        } catch (error) {
          const typed = asWorkflowError(error);
          if (!OUTCOME_ERRORS.has(typed.code)) throw typed;
          value = branded({ name, ok: false, failedAt: name, error: { code: typed.code, message: typed.message, ...(isWorkflowAuthored(typed) ? { authored: true } : {}) } });
        }
      } else if (method === "function") {
        if (!bridge.function || typeof values[0] !== "string" || !object(values[1])) fail("INTERNAL_ERROR", "function requires an available bridge, name, and object input");
        const identity = readFunctionIdentity(values[2]);
        const name = values[0];
        const expectedPath = operationPath("function", ...identity.structuralPath, name, String(identity.occurrence));
        if (identity.path !== expectedPath) fail("INTERNAL_ERROR", "Workflow function identity path is inconsistent");
        try {
          const result = await bridge.function(values[0], values[1], controller.signal, identity);
          value = branded({ name, ok: true, value: result ?? null });
        } catch (error) {
          const typed = asWorkflowError(error);
          if (!OUTCOME_ERRORS.has(typed.code)) throw typed;
          value = branded({ name, ok: false, failedAt: name, error: { code: typed.code, message: typed.message, ...(isWorkflowAuthored(typed) ? { authored: true } : {}) } });
        }
      } else if (method === "worktree") {
        if (!bridge.worktree || typeof values[0] !== "string" || !values[0]) fail("INTERNAL_ERROR", "worktree requires an active host bridge and scope");
        value = await bridge.worktree(values[0], controller.signal);
      } else if (method === "phase") {
        if (typeof values[0] !== "string") fail("INTERNAL_ERROR", "phase name must be a string");
        await bridge.phase?.(values[0]);
      } else if (method === "log") {
        if (typeof values[0] !== "string") fail("INTERNAL_ERROR", "log message must be a string");
        await bridge.log?.(values[0]);
      }
      else fail("INTERNAL_ERROR", `Unknown worker RPC method: ${method}`);
      encoded(value);
      child.send(encodedRpcResult(id, value));
    } catch (error) {
      const typed = asWorkflowError(error);
      child.send(encoded({ type: "rpcResult", id, ok: false, error: { code: typed.code, message: typed.message, ...(isWorkflowAuthored(typed) ? { authored: true } : {}) } }));
    }
  }
  function cancel() {
    if (settled) return;
    controller.abort();
    child.send(encoded({ type: "cancel" }));
    stop("CANCELLED", "Workflow cancelled");
  }
  if (signal?.aborted) cancel(); else signal?.addEventListener("abort", cancel, { once: true });
  return { result, cancel };
}
function attemptSummary(attempt: AgentAttempt, accounting = attempt.accounting): AgentAttemptSummary {
  return { attempt: attempt.attempt, transport: attempt.transport, ...(attempt.session ? { session: attempt.session } : {}), ...(attempt.error ? { error: attempt.error } : {}), accounting, setup: attempt.setup };
}
export async function persistActiveAgentAttempt(store: RunStore, id: string, active: AgentAttempt): Promise<void> {
  await store.updateState((run) => {
    const agent = run.agents.find((candidate) => candidate.id === id);
    if (!agent) throw new WorkflowError("INTERNAL_ERROR", `Missing production ownership record: ${id}`);
    const accounting = zeroAccounting();
    const detail = attemptSummary(active, accounting);
    const details = [...(agent.attemptDetails ?? []).filter((candidate) => candidate.attempt !== active.attempt), detail];
    const session = active.session;
    const agentSessions = session && !run.agentSessions.some(({ transport, sessionId }) => transport === session.transport && sessionId === session.sessionId) ? [...run.agentSessions, session] : run.agentSessions;
    return { ...run, agents: run.agents.map((candidate) => candidate.id === id ? { ...candidate, attempts: Math.max(candidate.attempts, active.attempt), attemptDetails: details } : candidate), agentSessions };
  });
}

export async function persistAgentAttempts(store: RunStore, id: string, attempts: readonly AgentAttempt[]): Promise<void> {
  await store.updateState((run) => {
    const agent = run.agents.find((candidate) => candidate.id === id);
    if (!agent) throw new WorkflowError("INTERNAL_ERROR", `Missing production ownership record: ${id}`);
    const total = sumAccounting(attempts.map((attempt) => attempt.accounting));
    const attemptDetails = attempts.map((attempt) => attemptSummary(attempt));
    const sessions = attempts.map((attempt) => attempt.session).filter((session): session is WorkflowAgentSessionReference => session !== undefined);
    const sessionKeys = new Set(sessions.map(({ transport, sessionId }) => `${transport}:${sessionId}`));
    return { ...run, agents: run.agents.map((candidate) => candidate.id === id ? { ...candidate, attempts: attempts.length, attemptDetails, accounting: total } : candidate), agentSessions: [...run.agentSessions.filter(({ transport, sessionId }) => !sessionKeys.has(`${transport}:${sessionId}`)), ...sessions] };
  });
}
export type { AgentIdentity, FunctionIdentity, ShellIdentity, WorkflowBridge, WorkflowExecution } from "./types.js";
