import { ERROR_CODES, LAUNCH_SNAPSHOT_IDENTITY_VERSION, WorkflowError, type JsonValue, type ModelSpec, type WorkflowErrorCode } from "./types.js";

export function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
export { object as isObject };
export function jsonValue(value: unknown, seen = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || seen.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== "string")) return false;
  seen.add(value);
  const valid = (Array.isArray(value) ? Array.from(value) : keys.map((key) => (value as Record<string, unknown>)[key as string])).every((item) => jsonValue(item, seen));
  seen.delete(value);
  return valid;
}
export function jsonObject(value: unknown): value is Record<string, JsonValue> { return jsonValue(value) && object(value); }
export function positiveInteger(value: unknown): value is number { return Number.isInteger(value) && (value as number) > 0; }
export function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
export function errorText(error: unknown): string { return error && typeof error === "object" && typeof (error as { message?: unknown }).message === "string" ? (error as { message: string }).message : error instanceof Error ? error.message : String(error); }
export function errorCode(error: unknown): WorkflowErrorCode | undefined {
  if (error instanceof WorkflowError) return ERROR_CODES.includes(error.code) ? error.code : undefined;
  if (!error || typeof error !== "object") return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && ERROR_CODES.includes(code as WorkflowErrorCode) ? code as WorkflowErrorCode : undefined;
}
export function fail(code: WorkflowErrorCode, message: string): never { throw new WorkflowError(code, message); }

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
const MODEL_ALIAS_NAME = /^[A-Za-z][A-Za-z0-9_-]*$/;
export function parseThinking(value: unknown): ModelSpec["thinking"] | undefined { return typeof value === "string" && THINKING_LEVELS.includes(value as (typeof THINKING_LEVELS)[number]) ? value as ModelSpec["thinking"] : undefined; }
export function parseModelReference(value: string): ModelSpec {
  const match = /^([^/:\s]+)\/([^:\s]+)(?::([^:\s]+))?$/.exec(value);
  if (!match?.[1] || !match[2]) fail("UNKNOWN_MODEL", `Invalid model spec: ${value}`);
  const thinking = match[3];
  if (thinking && !THINKING_LEVELS.includes(thinking as (typeof THINKING_LEVELS)[number])) fail("UNKNOWN_MODEL", `Invalid thinking level: ${thinking}`);
  return { provider: match[1], model: match[2], ...(thinking ? { thinking: thinking as NonNullable<ModelSpec["thinking"]> } : {}) };
}
export function modelAliasName(value: string, aliases: Readonly<Record<string, string>>): string | undefined {
  const name = /^([^/:\s]+)(?::[^:\s]+)?$/.exec(value)?.[1];
  return name && Object.prototype.hasOwnProperty.call(aliases, name) ? name : undefined;
}
export function resolveModelReference(value: string, aliases: Readonly<Record<string, string>> = {}, knownModels?: ReadonlySet<string>, settingsPath?: string): ModelSpec {
  const unknownModel = (target: string): never => fail("UNKNOWN_MODEL", `Unknown model ${target}${settingsPath ? ` (settings: ${settingsPath})` : ""}`);
  const resolve = (reference: string, chain: readonly string[]): ModelSpec => {
    if (reference.includes("/")) return parseModelReference(reference);
    const match = /^([^:\s]+)(?::([^:\s]+))?$/.exec(reference);
    const thinking = match?.[2];
    if (!match?.[1] || thinking && !THINKING_LEVELS.includes(thinking as (typeof THINKING_LEVELS)[number])) unknownModel(reference);
    const alias = modelAliasName(reference, aliases);
    if (alias) {
      if (chain.includes(alias)) fail("UNKNOWN_MODEL", `Circular model alias: ${[...chain, alias].join(" -> ")}${settingsPath ? ` (settings: ${settingsPath})` : ""}`);
      const parsed = resolve(aliases[alias] as string, [...chain, alias]);
      return thinking ? { ...parsed, thinking: thinking as NonNullable<ModelSpec["thinking"]> } : parsed;
    }
    const candidates = [...(knownModels ?? [])].filter((model) => model.slice(model.indexOf("/") + 1) === match?.[1]);
    if (candidates.length === 1) {
      const parsed = parseModelReference(candidates[0] as string);
      return thinking ? { ...parsed, thinking: thinking as NonNullable<ModelSpec["thinking"]> } : parsed;
    }
    return unknownModel(reference);
  };
  return resolve(value, []);
}
export function modelCapability(value: string | ModelSpec, aliases?: Readonly<Record<string, string>>, knownModels?: ReadonlySet<string>, settingsPath?: string): string {
  const parsed = typeof value === "string" ? resolveModelReference(value, aliases, knownModels, settingsPath) : value;
  return `${parsed.provider}/${parsed.model}`;
}
export function validateModelAliases(value: unknown, settingsPath = "workflow settings"): Readonly<Record<string, string>> {
  if (!object(value)) fail("CONFIG_ERROR", `modelAliases must be an object (settings: ${settingsPath})`);
  const aliases: Record<string, string> = {};
  for (const [name, target] of Object.entries(value)) {
    if (!MODEL_ALIAS_NAME.test(name)) fail("CONFIG_ERROR", `Invalid model alias name: ${name} (settings: ${settingsPath})`);
    if (typeof target !== "string" || !target.trim()) fail("CONFIG_ERROR", `Invalid model alias target for ${name} (settings: ${settingsPath})`);
    aliases[name] = target;
  }
  for (const name of Object.keys(aliases)) { try { resolveModelReference(name, aliases); } catch (error) { fail("CONFIG_ERROR", `Invalid model alias target for ${name}: ${errorText(error)} (settings: ${settingsPath})`); } }
  return Object.freeze(aliases);
}
export function mergeAgentResourceExclusions(...values: (import("./types.js").AgentResourceExclusions | undefined)[]): import("./types.js").AgentResourceExclusions { return { skills: [...new Set(values.flatMap((value) => value?.skills ?? []))], extensions: [...new Set(values.flatMap((value) => value?.extensions ?? []))] }; }
export function createLaunchSnapshot(input: Omit<import("./types.js").LaunchSnapshot, "identityVersion"> & { identityVersion?: number }): Readonly<import("./types.js").LaunchSnapshot> { return deepFreeze(structuredClone({ ...input, launchKind: input.launchKind ?? (input.functionName ? "function" : "inline"), identityVersion: input.identityVersion ?? LAUNCH_SNAPSHOT_IDENTITY_VERSION })); }
export function loadLaunchSnapshot(input: import("./types.js").LaunchSnapshot): Readonly<import("./types.js").LaunchSnapshot> { return deepFreeze(structuredClone(input)); }