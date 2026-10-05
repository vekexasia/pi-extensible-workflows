import type { ExtensionToolContext, ToolLoadout, ToolLoadoutChanges } from "@earendil-works/pi-coding-agent";
import { WorkflowError, type JsonValue } from "./types.js";
import { errorText, jsonValue, object } from "./utils.js";
import { RPC_LIMIT_BYTES } from "./execution.js";
import { scriptToolReferences } from "./validation.js";

type ScriptTool = ExtensionToolContext["tools"][number];
type ScriptToolOutcome = Awaited<ReturnType<ExtensionToolContext["executeTool"]>>;

/** Workflow and subagent tools stay out of scripts, so a run cannot launch or control runs. Codemode is model-only and never callable. */
export function scriptToolExcluded(name: string): boolean {
  return name === "workflow" || name.startsWith("workflow_") || name.startsWith("subagents_");
}
/** The identifier scripts use for a tool, the same as Pi codemode's, so its `tools.<id>(args)` lines apply to workflow scripts. */
export function scriptToolIdentifier(name: string): string {
  let identifier = "";
  for (const char of name) identifier += (identifier === "" ? /^[A-Za-z_$]$/ : /^[A-Za-z0-9_$]$/).test(char) ? char : "_";
  return identifier || "_";
}
/** The context of a Pi tool call, whose `executeTool()` runs session tools; absent for commands, session events, and headless launches. */
export function scriptToolContext(ctx: unknown): ExtensionToolContext | undefined {
  return object(ctx) && typeof ctx.executeTool === "function" && Array.isArray(ctx.tools) ? ctx as unknown as ExtensionToolContext : undefined;
}
export function scriptToolIdentifiers(context: ExtensionToolContext | undefined): string[] {
  return (context?.tools ?? []).filter(({ name }) => !scriptToolExcluded(name)).map(({ name }) => scriptToolIdentifier(name));
}
// NOTE: a launch rejects identifiers that several tools share; a later tool set may still collide, and the first match wins.
export function scriptTool(context: ExtensionToolContext, identifier: string): ScriptTool | undefined {
  return context.tools.find(({ name }) => !scriptToolExcluded(name) && scriptToolIdentifier(name) === identifier);
}
/**
 * What a script call resolves to, as in codemode: the structured content of a tool with an output
 * schema, also for error results that carry one, otherwise its text; other failures throw. The value
 * is normalized through JSON and size-checked before it is journaled, so a replay returns the same value.
 */
export function scriptToolValue(tool: ScriptTool, outcome: ScriptToolOutcome): JsonValue {
  const structured = tool.outputSchema === undefined ? undefined : outcome.result.structuredContent;
  const text = outcome.result.content.flatMap((item) => item.type === "text" ? [item.text] : []).join("\n");
  if (structured === undefined && outcome.isError) throw new WorkflowError("TOOL_FAILED", `${tool.name}: ${text || "failed"}`);
  let value: unknown;
  try { value = JSON.parse(JSON.stringify(structured ?? text)) as unknown; } catch (error) { throw new WorkflowError("TOOL_FAILED", `${tool.name} returned a result that is not JSON: ${errorText(error)}`); }
  if (!jsonValue(value)) throw new WorkflowError("TOOL_FAILED", `${tool.name} returned a result that is not JSON`);
  if (Buffer.byteLength(JSON.stringify(value)) > RPC_LIMIT_BYTES) throw new WorkflowError("TOOL_FAILED", `${tool.name} returned more than the 10 MB workflow RPC limit`);
  return value;
}
/** Fails a launch whose script names a tool this session cannot call, before any agent runs. */
export function validateScriptToolReferences(script: string, context: ExtensionToolContext | undefined): void {
  const references = scriptToolReferences(script);
  if (!references?.length) return;
  if (!context) throw new WorkflowError("UNKNOWN_TOOL", `Workflow scripts can call session tools only when launched by the workflow tool; this launch has none for ${references.map((name) => `tools.${name}`).join(", ")}`);
  const identifiers = scriptToolIdentifiers(context);
  const unknown = references.filter((name) => !identifiers.includes(name));
  if (unknown.length) throw new WorkflowError("UNKNOWN_TOOL", `Workflow script calls tools this session cannot call: ${unknown.map((name) => `tools.${name}`).join(", ")}`);
  const ambiguous = references.filter((name) => identifiers.indexOf(name) !== identifiers.lastIndexOf(name));
  if (ambiguous.length) throw new WorkflowError("UNKNOWN_TOOL", `Workflow script calls tools whose names collide after normalization: ${ambiguous.map((name) => `tools.${name}`).join(", ")}`);
}
function describeScriptOutput(schema: unknown): string | undefined {
  if (!object(schema) || schema.type !== "object" || !object(schema.properties)) return schema === undefined ? undefined : "a JSON value";
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  return `\`{ ${Object.keys(schema.properties).map((name) => required.has(name) ? name : `${name}?`).join(", ")} }\``;
}
/**
 * Tells the model what `tools.<id>(args)` resolves to for declared tools with an output schema; the
 * workflow description says that the others resolve to their text. With codemode active its own
 * identical `Codemode:` lines say this, and pi keeps only one description per tool, so this defers.
 */
export function prepareScriptToolLoadout(loadout: ToolLoadout): ToolLoadoutChanges | undefined {
  if (loadout.declared.some(({ name }) => name === "codemode")) return undefined;
  const callable = new Set(loadout.callable.map(({ name }) => name));
  const descriptions: Record<string, string> = {};
  for (const tool of loadout.declared) {
    const output = callable.has(tool.name) && !scriptToolExcluded(tool.name) ? describeScriptOutput(tool.outputSchema) : undefined;
    if (output) descriptions[tool.name] = `${tool.description.trim()}\n\nWorkflow scripts: \`tools.${scriptToolIdentifier(tool.name)}(args)\` resolves to ${output}.`;
  }
  return { descriptions };
}
