import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import workflowExtension, { createLaunchSnapshot, DEFAULT_SETTINGS, loadSettings, preflight, WorkflowError } from "../src/index.js";

const capabilities = {
  models: new Set(["openai/gpt"]), tools: new Set(["read"]), agentTypes: new Set(["reviewer"]), extensions: { git: "1.2.3" },
};
const valid = `export const meta = { name: "review", description: "Review code", phases: ["check"], extensions: [{name:"git",version:"^1.0.0"}] };
phase("check"); agent("do it", { name: "reviewer", model: "openai/gpt", tools: ["read"], agentType: "reviewer" });`;

void test("registers the workflow tool and singular command", async () => {
  const tools: Array<{ name: string; execute: () => Promise<unknown> }> = [];
  const commands: Array<{ name: string; options: { handler: (args: string, ctx: unknown) => Promise<void> } }> = [];
  const pi = {
    registerTool(tool: (typeof tools)[number]) { tools.push(tool); },
    registerCommand(name: string, options: (typeof commands)[number]["options"]) { commands.push({ name, options }); },
  };
  workflowExtension(pi as never);
  assert.deepEqual(tools.map(({ name }) => name), ["workflow"]);
  assert.deepEqual(commands.map(({ name }) => name), ["workflow"]);
  const tool = tools[0];
  assert.ok(tool);
  await assert.rejects(tool.execute(), /not implemented/);
});

void test("strict settings use defaults and reject unknown or unsafe values", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-workflows-"));
  assert.equal(loadSettings(join(dir, "missing.json")), DEFAULT_SETTINGS);
  const path = join(dir, "settings.json");
  writeFileSync(path, JSON.stringify({ concurrency: 4, maxAgents: 20, agentTimeoutMs: 500 }));
  assert.deepEqual(loadSettings(path), { concurrency: 4, maxAgents: 20, agentTimeoutMs: 500 });
  writeFileSync(path, JSON.stringify({ concurrency: 17 }));
  assert.throws(() => loadSettings(path), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SETTINGS");
  writeFileSync(path, JSON.stringify({ surprise: true }));
  assert.throws(() => loadSettings(path), /Unknown workflow setting/);
});

void test("preflight accepts the complete static contract", () => {
  const result = preflight(valid, capabilities, [{ type: "object", properties: { value: { type: "string" } } }]);
  assert.equal(result.metadata.name, "review");
  assert.deepEqual(result.referenced, { phases: ["check"], models: ["openai/gpt"], tools: ["read"], agentTypes: ["reviewer"] });
  assert.ok(Object.isFrozen(result.metadata));
});

void test("preflight rejects every static boundary before run creation", () => {
  let created = 0;
  const createRun = (script: string) => { preflight(script, capabilities); created += 1; };
  const cases: Array<[string, string]> = [
    ["const x = ;", "INVALID_SYNTAX"],
    ["export const meta = {name:'',description:'x'};", "INVALID_METADATA"],
    [`export const meta={name:'x',description:'x'}; agent('a')`, "INVALID_METADATA"],
    [`export const meta={name:'x',description:'x',phases:['a','a']};`, "DUPLICATE_NAME"],
    [`export const meta={name:'x',description:'x',phases:['a']}; phase('b')`, "UNKNOWN_PHASE"],
    [`export const meta={name:'x',description:'x'}; agent('a',{name:'n',model:'missing'})`, "UNKNOWN_MODEL"],
    [`export const meta={name:'x',description:'x'}; agent('a',{name:'n',tools:['bash']})`, "UNKNOWN_TOOL"],
    [`export const meta={name:'x',description:'x'}; agent('a',{name:'n',agentType:'writer'})`, "UNKNOWN_AGENT_TYPE"],
    [`export const meta={name:'x',description:'x',extensions:[{name:'nope',version:'1.0.0'}]};`, "MISSING_EXTENSION"],
    [`export const meta={name:'x',description:'x'}; agent('a',{name:'same'}); agent('b',{name:'same'})`, "DUPLICATE_NAME"],
  ];
  for (const [script, code] of cases) assert.throws(() => { createRun(script); }, (error: unknown) => error instanceof WorkflowError && error.code === code);
  assert.equal(created, 0);
  assert.throws(() => preflight(`export const meta={name:'x',description:'x'};`, capabilities, [{}]), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SCHEMA");
});

void test("preflight rejects non-JSON schemas, incompatible extension versions, and unnamed structured work", () => {
  const base = `export const meta={name:'x',description:'x'};`;
  assert.throws(() => preflight(base, capabilities, [{ type: "object", properties: { bad: () => true } }]), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SCHEMA");
  assert.throws(() => preflight(`export const meta={name:'x',description:'x',extensions:[{name:'git',version:'^1.2.3'}]};`, { ...capabilities, extensions: { git: "1.0.0" } }), (error: unknown) => error instanceof WorkflowError && error.code === "INCOMPATIBLE_EXTENSION");
  assert.throws(() => preflight(`${base} parallel([{run:()=>1}], {name:'batch'})`, capabilities), /Every parallel task/);
  assert.throws(() => preflight(`${base} parallel([{name:'task',run:()=>1}])`, capabilities), /parallel requires/);
  assert.throws(() => preflight(`${base} pipeline([{value:1}], {name:'stage',run:value=>value})`, capabilities), /Every pipeline item/);
  assert.throws(() => preflight(`${base} pipeline([{name:'item',value:1}], value=>value, {name:'pipe'})`, capabilities), /Every pipeline stage/);
  preflight(`${base} parallel([{name:'task',run:()=>1}], {name:'batch'}); pipeline([{name:'item',value:1}], {name:'stage',run:value=>value}, {name:'pipe'})`, capabilities);
});

void test("launch snapshots are detached and deeply immutable", () => {
  const input = { script: valid, args: { nested: [1] }, metadata: { name: "x", description: "x" }, settings: { concurrency: 1, maxAgents: 1, agentTimeoutMs: null }, models: ["openai/gpt"], tools: ["read"], agentTypes: ["reviewer"], extensions: { git: "1.2.3" }, schemas: [{ type: "object" }] };
  const snapshot = createLaunchSnapshot(input);
  input.args.nested.push(2);
  assert.deepEqual(snapshot.args, { nested: [1] });
  assert.ok(Object.isFrozen(snapshot.args));
  assert.ok(Object.isFrozen(snapshot.schemas[0]));
});