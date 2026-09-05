import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { testExtensionApi } from "./support.js";
import workflowExtension, { createLaunchSnapshot, FairAgentScheduler, inspectWorkflowScript, preflight, RPC_LIMIT_BYTES, RunStore, runWorkflow, WorkflowError, type JsonValue } from "../src/index.js";
import { listRunIds } from "../src/persistence.js";
import { decodeOwnershipRecords } from "../src/decoders.js";

const capabilities = {
  models: new Set(["openai/gpt"]), tools: new Set(["read"]), agentTypes: new Set(["reviewer"]),
};
const valid = `phase("check"); agent("review", { role: "reviewer" }); agent("custom", { model: "openai/gpt:high", tools: ["read"] });`;
void test("rejects legacy persisted role override fields", () => {
  assert.equal(decodeOwnershipRecords([{ id: "owner", label: "owner", state: "completed", options: { label: "owner", cwd: "/repo", tools: [], role: { name: "reviewer", model: "old/model" } } }]), undefined);
});
void test("preflight accepts the complete static contract", () => {
  const metadata = { name: "review", description: "Review code" };
  const result = preflight(valid, capabilities, [{ type: "object", properties: { value: { type: "string" } } }], metadata);
  assert.equal(result.metadata.name, "review");
  assert.equal(result.dynamicAgentRoles, false);
  assert.equal(preflight(`agent("x", { role: args.role })`, capabilities).dynamicAgentRoles, true);
  assert.deepEqual(result.referenced, { phases: ["check"], models: ["openai/gpt"], tools: ["read"], agentTypes: ["reviewer"] });
  assert.deepEqual(preflight(valid.replace("openai/gpt:high", "openai/gpt:high"), capabilities, [], metadata).referenced.models, ["openai/gpt"]);
  assert.ok(Object.isFrozen(result.metadata));
  const staticSchema = { type: "object", properties: { answer: { type: "number" } } };
  assert.deepEqual(preflight(`agent("x",{outputSchema:${JSON.stringify(staticSchema)}})`, capabilities).schemas, [staticSchema]);
  preflight(`agent("x",{timeoutMs:0,timeoutMs:10})`, capabilities);
  preflight(`agent("x",{timeoutMs:0,...{timeoutMs:10}})`, capabilities);
});
void test("preflight accepts role names with call-level overrides", () => {
  const script = `agent("x", { role: "reviewer", model: "openai/gpt:high", tools: ["read"], contextFiles: ["cwd"] })`;
  const result = preflight(script, capabilities);
  assert.equal(result.dynamicAgentRoles, false);
  assert.deepEqual(result.referenced, { phases: [], models: ["openai/gpt"], tools: ["read"], agentTypes: ["reviewer"] });
  assert.equal(preflight(`agent("x",{role: args.role})`, capabilities).dynamicAgentRoles, true);
  assert.equal(preflight(`agent("x",{role:"reviewer"})`, capabilities).dynamicAgentRoles, false);
  const inspected = inspectWorkflowScript(script);
  const inspectedCall = inspected[0];
  assert.ok(inspectedCall);
  assert.equal(inspectedCall.kind, "agent");
  assert.equal(inspectedCall.role, "reviewer");
  assert.equal(inspectedCall.model, "openai/gpt:high");
  assert.deepEqual(inspectedCall.options, { role: "reviewer", model: "openai/gpt:high", tools: ["read"], contextFiles: ["cwd"] });
});

void test("preflight rejects every static boundary before run creation", () => {
  let created = 0;
  const createRun = (script: string) => { preflight(script, capabilities, [], { name: "test" }); created += 1; };
  const cases: Array<[string, string]> = [
    ["const x = ;", "INVALID_SYNTAX"],
    [`agent('a',{model:'missing'})`, "UNKNOWN_MODEL"],
    [`agent('a',{model:'openai/gpt:turbo'})`, "UNKNOWN_MODEL"],
    [`agent('a',{tools:['bash']})`, "UNKNOWN_TOOL"],
    [`agent('a',{role:'writer'})`, "UNKNOWN_AGENT_TYPE"],
    [`agent('a',{role:{name:'reviewer'}})`, "INVALID_METADATA"],
    [`agent('a',{role:'reviewer',tools:['bash']})`, "UNKNOWN_TOOL"],
    [`agent('a',{outputSchema:[]})`, "INVALID_SCHEMA"],
    [`agent('a',{label:' '})`, "INVALID_METADATA"],
    [`agent('a',{timeoutMs:0})`, "INVALID_METADATA"],
    [`agent('a',{retries:-1})`, "INVALID_METADATA"],
  ];
  for (const [script, code] of cases) assert.throws(() => { createRun(script); }, (error: unknown) => error instanceof WorkflowError && error.code === code);
  assert.equal(created, 0);
  assert.equal(preflight("phase('dynamic')", capabilities, [], { name: "minimal" }).metadata.name, "minimal");
  assert.throws(() => preflight("return 1", capabilities, [], { name: "" }), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => preflight("return 1", capabilities, [{}]), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SCHEMA");
});

void test("host rejects malformed dynamic agent options before launching", async () => {
  let launched = false;
  for (const options of ["null", "{label:' '}", "{tools:1}", "{timeoutMs:0}", "{retries:-1}", "{role:{}}", "{role:{name:'reviewer'}}"]) {
    await assert.rejects(runWorkflow(`return agent('a',${options});`, null, { agent: async () => { launched = true; return null; } }).result, (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  }
  assert.equal(launched, false);
});
void test("passes explicit and extension agent options through the workflow boundary", async () => {
  let label: unknown;
  let received: unknown;
  const result = await runWorkflow("return agent('a', { label: 'API inspection', advisor: true, nested: { enabled: true } });", null, { agent: async (_prompt, options) => { label = options.label; received = options; return "done"; } }).result;
  assert.equal(result, "done");
  assert.equal(label, "API inspection");
  assert.deepEqual(received, { label: "API inspection", advisor: true, nested: { enabled: true } });
});
void test("passes role names and call-level overrides through the workflow boundary", async () => {
  let received: unknown;
  const result = await runWorkflow("return agent('a', { role: 'reviewer', contextFiles: ['cwd'], model: 'openai/gpt:high', tools: ['read'] });", null, { agent: async (_prompt, options) => { received = options; return "done"; } }).result;
  assert.equal(result, "done");
  assert.deepEqual(received, { role: "reviewer", contextFiles: ["cwd"], model: "openai/gpt:high", tools: ["read"] });
});
void test("preflight enforces object-key combinators without agent names", () => {
  const base = "return 1;";
  assert.throws(() => preflight(base, capabilities, [{ type: "object", properties: { bad: () => true } }]), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_SCHEMA");
  assert.throws(() => preflight(`${base} parallel([{name:'task',run:()=>1}], {name:'batch'})`, capabilities), /operation name string and tasks record/);
  assert.throws(() => preflight(`${base} pipeline([{name:'item',value:1}], {name:'stage',run:value=>value}, {name:'pipe'})`, capabilities), /operation name string, items record, and stages record/);
  assert.doesNotThrow(() => preflight(`${base} agent('top-level')`, capabilities));
  preflight(`${base} parallel('batch',{task:()=>agent('inherited')}); pipeline('pipe',{item:1},{stage:value=>agent(String(value))})`, capabilities);
});

void test("AST preflight ignores DSL-looking non-executable text and member calls", () => {
  const script = `const text = "agent() checkpoint({}) phase('ghost') name: 'fake' model: 'missing' tools: ['bash'] role: 'writer'";
    const pattern = /agent() checkpoint({}) phase('ghost') model:'missing'/;
    const template = \`parallel() pipeline() agent() phase('ghost') model: 'missing'\`;
    // agent('comment') checkpoint({name:'comment'}) phase('ghost') model:'missing' tools:['bash'] role:'writer'
    object.agent('member'); object.checkpoint({}); object.phase('ghost'); object.parallel([]); object.pipeline([]);
    const unrelated = {model:'missing', tools:['bash'], role:'writer'};
    phase('real');
    agent("Explain agent() Promise behavior; name: 'fake'; model: 'missing'; tools: ['bash']; role: 'writer'", {model:'openai/gpt:high',tools:['read']});`;
  assert.deepEqual(preflight(script, capabilities).referenced, { phases: ["real"], models: ["openai/gpt"], tools: ["read"], agentTypes: [] });
});

void test("AST preflight distinguishes executable calls from prompt text", () => {
  const capabilitiesWithNames = capabilities;
  assert.doesNotThrow(() => preflight(`agent("name: 'fake'")`, capabilitiesWithNames));
  assert.throws(() => preflight(`checkpoint({prompt:"name: 'fake'",context:null})`, capabilitiesWithNames), /checkpoint requires a stable explicit name/);
  assert.doesNotThrow(() => preflight("const text = `${agent(\"name: 'fake'\")}`;", capabilitiesWithNames));
});

void test("AST preflight validates combinator signatures", () => {
  const base = "";
  assert.throws(() => preflight(`${base} parallel({task:()=>1}, 'batch')`, capabilities), /parallel requires/);
  assert.throws(() => preflight(`${base} pipeline('pipe', {item:1})`, capabilities), /pipeline requires/);
  preflight(`${base} agent('x', options); checkpoint(input); parallel(...batch); pipeline(...pipe);`, capabilities);
});

void test("launch snapshots are detached and deeply immutable", () => {
  const input = { script: `return withWorktree("snapshot", async () => true);`, args: { nested: [1] }, metadata: { name: "x", description: "x" }, settings: { concurrency: 1 }, models: ["openai/gpt"], tools: ["read"], agentTypes: ["reviewer"], roles: { reviewer: { prompt: "original", skills: ["role-skill"], extensions: ["/role-extension.ts"] } }, projectRoles: ["reviewer"], schemas: [{ type: "object" }] };
  const snapshot = createLaunchSnapshot(input);
  input.args.nested.push(2);
  input.roles.reviewer.prompt = "mutated";
  input.roles.reviewer.skills.push("mutated");
  assert.deepEqual(snapshot.args, { nested: [1] });
  assert.equal(snapshot.identityVersion, 5);
  assert.equal(snapshot.roles?.reviewer?.prompt, "original");
  assert.deepEqual(snapshot.roles.reviewer.skills, ["role-skill"]);
  assert.ok(Object.isFrozen(snapshot.args));
  assert.ok(Object.isFrozen(snapshot.schemas[0]));
});

void test("worker exposes deterministic core globals and JSON RPC only", async () => {
  const phases: string[] = [];
  const script = `export const meta={name:'x',description:'x'};
    if (typeof process !== 'undefined' || typeof require !== 'undefined' || typeof console !== 'undefined' || typeof Date !== 'undefined' || typeof setTimeout !== 'undefined' || typeof Math.random !== 'undefined') throw new Error('unsafe global');
    await phase('build'); const decision = await checkpoint({name:'gate'}); if (decision !== 'approved') throw new Error('rejected'); return agent('echo');`
  const run = runWorkflow(script, { n: 2 }, {
    phase(name) { phases.push(name); },
    checkpoint() { return true; },
    agent(prompt, options) { return Promise.resolve({ prompt, options }); },
  });
  assert.deepEqual(await run.result, { prompt: "echo", options: {} });
  assert.deepEqual(phases, ["build"]);
});

void test("prompt interpolates exact values with JSON formatting and escaped braces", async () => {
  const run = runWorkflow(`export const meta={name:'prompt',description:'prompt'};
    return prompt('raw={raw}; again={raw}; number={number}; bool={bool}; nil={nil}; array={array}; object={object}; escaped={{raw}} }}', {
      raw: 'verbatim', number: 3, bool: false, nil: null, array: [1, {ok:true}], object: {nested:['x']}
    });`);
  assert.equal(await run.result, `raw=verbatim; again=verbatim; number=3; bool=false; nil=null; array=[
  1,
  {
    "ok": true
  }
]; object={
  "nested": [
    "x"
  ]
}; escaped={raw} }`);
});

void test("prompt validates array expando values without changing JSON array rendering", async () => {
  const run = runWorkflow(`export const meta={name:'array-expandos',description:'array expandos'};
    const safe=[1,{ok:true}]; safe.note='ignored';
    const withFunction=[]; withFunction.extra=()=>1;
    const withCycle=[]; withCycle.extra=withCycle;
    const message=value=>{try{prompt('{value}',{value});return 'no error'}catch(error){return error.message}};
    return {rendered:prompt('{value}',{value:safe}),functionError:message(withFunction),cycleError:message(withCycle)};`);
  const result = await run.result as { rendered: string; functionError: string; cycleError: string };
  assert.equal(result.rendered, `[
  1,
  {
    "ok": true
  }
]`);
  assert.match(result.functionError, /value\.extra.*function/i);
  assert.match(result.cycleError, /value\.extra.*cycle/i);
});

void test("prompt rejects missing, unused, and recursively unsafe values with key-aware errors", async () => {
  const run = runWorkflow(`export const meta={name:'invalid-prompt',description:'invalid prompt'};
    const cycle={}; cycle.self=cycle;
    const accessor={}; Object.defineProperty(accessor,'nested',{enumerable:true,get(){return 1}});
    const customPrototype=Object.create({constructor:Object}); customPrototype.nested=1;
    const invalidConstructorPrototype=Object.create(Object.create(null,{constructor:{value:42}}));
    const cases=[
      ['missing',()=>prompt('{value}',{})],
      ['unused',()=>prompt('plain',{value:1})],
      ['template',()=>prompt(42,{})],
      ['values',()=>prompt('plain',[])],
      ['promise',()=>prompt('{value}',{value:Promise.resolve(1)})],
      ['nested promise',()=>prompt('{value}',{value:{nested:Promise.resolve(1)}})],
      ['thenable',()=>prompt('{value}',{value:{nested:{then(){}}}})],
      ['function',()=>prompt('{value}',{value:()=>1})],
      ['undefined',()=>prompt('{value}',{value:undefined})],
      ['symbol',()=>prompt('{value}',{value:Symbol('x')})],
      ['bigint',()=>prompt('{value}',{value:1n})],
      ['cycle',()=>prompt('{value}',{value:cycle})],
      ['infinite',()=>prompt('{value}',{value:Infinity})],
      ['instance',()=>prompt('{value}',{value:new (class Example {})()})],
      ['accessor',()=>prompt('{value}',{value:accessor})],
      ['custom prototype',()=>prompt('{value}',{value:customPrototype})],
      ['invalid prototype constructor',()=>prompt('{value}',{value:invalidConstructorPrototype})],
    ];
    return Object.fromEntries(cases.map(([name,run])=>{try{run();return [name,'no error']}catch(error){return [name,error.message]}}));`);
  const errors = await run.result as Record<string, string>;
  assert.match(errors.missing ?? "", /Missing prompt value "value"/);
  assert.match(errors.unused ?? "", /Unused prompt value "value"/);
  assert.match(errors.template ?? "", /template must be a string/);
  assert.match(errors.values ?? "", /values must be a plain object/);
  assert.match(errors.promise ?? "", /value.*Promise.*await/i);
  assert.match(errors["nested promise"] ?? "", /value\.nested.*Promise.*await/i);
  assert.match(errors.thenable ?? "", /value\.nested.*thenable.*await/i);
  assert.match(errors.function ?? "", /value.*function/i);
  assert.match(errors.undefined ?? "", /value.*undefined/i);
  assert.match(errors.symbol ?? "", /value.*symbol/i);
  assert.match(errors.bigint ?? "", /value.*bigint/i);
  assert.match(errors.cycle ?? "", /value\.self.*cycle/i);
  assert.match(errors.infinite ?? "", /value.*finite/i);
  assert.match(errors.instance ?? "", /value.*plain object/i);
  assert.match(errors.accessor ?? "", /value\.nested.*getters or setters/i);
  assert.match(errors["custom prototype"] ?? "", /value.*plain object/i);
  assert.match(errors["invalid prototype constructor"] ?? "", /value.*plain object/i);
});

void test("agent Promises reject serialization and string coercion but retain await and concurrency", async () => {
  const started: string[] = [];
  const run = runWorkflow(`export const meta={name:'agent-promises',description:'agent promises'};
    const first=agent('first'); const second=agent('second');
    let serialized; try{JSON.stringify(first)}catch(error){serialized=error.message}
    let interpolated; try{prompt('{report}',{report:first})}catch(error){interpolated=error.message}
    let stringified; try{first.toString()}catch(error){stringified=error.message}
    let coerced; try{'prefix '+first}catch(error){coerced=error.message}
    let agentInput; try{agent('prefix '+first)}catch(error){agentInput=error.message}
    let logInput; try{log('prefix '+first)}catch(error){logInput=error.message}
    let promptTemplate; try{prompt('prefix '+first,{})}catch(error){promptTemplate=error.message}
    const values=await Promise.all([first,second]);
    return {serialized,interpolated,stringified,coerced,agentInput,logInput,promptTemplate,awaited:JSON.stringify(values)};`, null, {
    async agent(text) { started.push(text); return text; },
  });
  const result = await run.result as { serialized: string; interpolated: string; stringified: string; coerced: string; agentInput: string; logInput: string; promptTemplate: string; awaited: string };
  assert.match(result.serialized, /agent result.*Promise.*await.*serialization/i);
  assert.match(result.interpolated, /report.*Promise.*await.*prompt/i);
  for (const error of [result.stringified, result.coerced, result.agentInput, result.logInput, result.promptTemplate]) assert.match(error, /agent result.*Promise.*await.*interpolation/i);
  assert.deepEqual(started, ["first", "second"]);
  assert.deepEqual(JSON.parse(result.awaited), ["first", "second"]);
});

void test("agent and checkpoint calls expose bare values and typed failures", async () => {
  assert.equal(await runWorkflow(`return agent('direct');`, null, { agent: async () => "value" }).result, "value");
  for (const [code, message] of [["AGENT_FAILED", "failed"], ["AGENT_TIMEOUT", "timed out"], ["RESULT_INVALID", "invalid"]] as const) {
    await assert.rejects(runWorkflow(`return agent('direct');`, null, { agent: async () => { throw new WorkflowError(code, message); } }).result,
      (error: unknown) => error instanceof WorkflowError && error.code === code && error.message === message);
  }
});

void test("parallel and pipeline return keyed bare values in input order", async () => {
  assert.deepEqual(await runWorkflow(`return parallel('batch',{first:()=>1,second:()=>0,third:()=>null});`).result, { first: 1, second: 0, third: null });
  assert.deepEqual(await runWorkflow(`return pipeline('pipe',{first:1,second:2},{double:value=>value*2,increment:value=>value+1});`).result, { first: 3, second: 5 });
  assert.deepEqual(await runWorkflow(`const reports=await parallel('reports',{lint:()=>agent('lint'),tests:()=>agent('tests')}); return {reports,rendered:prompt('{reports}',{reports})};`, null, { agent: async (prompt) => prompt === "lint" ? "clean" : { passed: true } }).result, {
    reports: { lint: "clean", tests: { passed: true } },
    rendered: `{
  "lint": "clean",
  "tests": {
    "passed": true
  }
}`,
  });
  assert.deepEqual(await runWorkflow(`return {parallel:await parallel('empty',{}),pipeline:await pipeline('empty',{}, {pass:value=>value})};`).result, { parallel: {}, pipeline: {} });
  let launched = false;
  await assert.rejects(runWorkflow(`return parallel('invalid',{first:()=>agent('no launch'),broken:1});`, null, { agent: async () => { launched = true; return null; } }).result, /task values must be run functions/);
  await assert.rejects(runWorkflow(`return pipeline('invalid',{first:1},{start:value=>agent(String(value)),broken:1});`, null, { agent: async () => { launched = true; return null; } }).result, /stage values must be run functions/);
  assert.equal(launched, false);
});

void test("combinator failures wait for siblings and preserve deterministic typed errors", async () => {
  let releaseParallel!: () => void;
  const parallelSibling = new Promise<JsonValue>((resolve) => { releaseParallel = () => { resolve("done"); }; });
  let settled = false;
  const parallelCalls: string[] = [];
  const parallelRun = runWorkflow(`return parallel('batch',{first:()=>agent('fail'),second:()=>agent('slow')});`, null, {
    agent: async (prompt) => { parallelCalls.push(prompt); if (prompt === "fail") throw new WorkflowError("AGENT_FAILED", "first failed"); return parallelSibling; },
  });
  void parallelRun.result.finally(() => { settled = true; }).catch(() => undefined);
  while (parallelCalls.length < 2) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releaseParallel();
  await assert.rejects(parallelRun.result, (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === "first failed");

  let releasePipeline!: () => void;
  const pipelineSibling = new Promise<JsonValue>((resolve) => { releasePipeline = () => { resolve(2); }; });
  settled = false;
  const pipelineCalls: string[] = [];
  const pipelineRun = runWorkflow(`return pipeline('pipe',{first:1,second:2},{run:value=>agent(String(value))});`, null, {
    agent: async (prompt) => { pipelineCalls.push(prompt); if (prompt === "1") throw new WorkflowError("RESULT_INVALID", "bad item"); return pipelineSibling; },
  });
  void pipelineRun.result.finally(() => { settled = true; }).catch(() => undefined);
  while (pipelineCalls.length < 2) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  releasePipeline();
  await assert.rejects(pipelineRun.result, (error: unknown) => error instanceof WorkflowError && error.code === "RESULT_INVALID" && error.message === "bad item");

  await assert.rejects(runWorkflow(`return parallel('ordered',{first:()=>{throw Object.assign(new Error('first'),{code:'AGENT_TIMEOUT'})},second:()=>{throw Object.assign(new Error('second'),{code:'AGENT_FAILED'})}});`).result,
    (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_TIMEOUT" && error.message === "first");
  await assert.rejects(runWorkflow(`return parallel('outer',{nested:()=>pipeline('inner',{item:1},{fail:()=>{throw Object.assign(new Error('nested'),{code:'AGENT_FAILED'})}})});`).result,
    (error: unknown) => error instanceof WorkflowError && error.code === "AGENT_FAILED" && error.message === "nested");
});
void test("direct workflow agents use call-site and occurrence identity", async () => {
  const source = `let values=[]; for(let index=0;index<2;index+=1) values.push(await agent("loop")); values.push(await agent("once")); return values;`;
  let launched = false;
  await assert.rejects(runWorkflow("return agent()", null, { agent: async () => { launched = true; return null; } }).result, /agent prompt must be a string/);
  assert.equal(launched, false);
  const identities: Array<{ structuralPath: string[]; callSite: string; occurrence: number }> = [];
  const run = runWorkflow(source, null, { agent: async (prompt, _options, _signal, identity) => { identities.push(identity as typeof identities[number]); return prompt; } });
  assert.deepEqual(await run.result, ["loop", "loop", "once"]);
  const [firstIdentity, secondIdentity, thirdIdentity] = identities;
  assert.ok(firstIdentity && secondIdentity && thirdIdentity);
  assert.equal(firstIdentity.occurrence, 1);
  assert.equal(secondIdentity.occurrence, 2);
  assert.notEqual(firstIdentity.callSite, thirdIdentity.callSite);
});
void test("rejects removed persistent conversation primitive and passes prior results explicitly", async () => {
  assert.deepEqual(await runWorkflow(`const previous = await agent("first"); return await agent(prompt("Use {previous}", { previous }));`, null, { agent: async (prompt) => prompt }).result, "Use first");
  assert.throws(() => preflight(`conversation("developer")`, capabilities), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA" && /removed/.test(error.message));
  assert.throws(() => preflight(`conversation("developer")`, capabilities, [], { name: "legacy" }, true), (error: unknown) => error instanceof WorkflowError && error.code === "RESUME_INCOMPATIBLE" && /removed/.test(error.message));
  assert.deepEqual(inspectWorkflowScript(`conversation("developer")`), []);
});

void test("withWorktree returns bare values and propagates one owner through parallel and pipeline", async () => {
  const identities: Array<{ prompt: string; worktreeOwner?: string }> = [];
  const result = await runWorkflow(`const shared = await withWorktree("shared", async () => ({
    parallel: await parallel("batch", { first: () => agent("first"), second: () => agent("second") }),
    pipeline: await pipeline("pipe", { one: 1, two: 2 }, { review: value => agent(String(value)) }),
  })); return { shared, outside: await agent("outside") };`, null, {
    agent: async (prompt, _options, _signal, identity) => { identities.push({ prompt, ...(identity.worktreeOwner ? { worktreeOwner: identity.worktreeOwner } : {}) }); return prompt; },
    worktree: async () => ({ path: "/worktrees/shared", branch: "branch" }),
  }).result;
  assert.deepEqual(result, { shared: { parallel: { first: "first", second: "second" }, pipeline: { one: "1", two: "2" } }, outside: "outside" });
  const scoped = identities.filter(({ prompt }) => prompt !== "outside");
  assert.equal(new Set(scoped.map(({ worktreeOwner }) => worktreeOwner)).size, 1);
  assert.ok(scoped[0]?.worktreeOwner);
  assert.equal(identities.find(({ prompt }) => prompt === "outside")?.worktreeOwner, undefined);
});
void test("withWorktree callbacks receive frozen public references", async () => {
  let materialized = 0;
  const result = await runWorkflow(`return await withWorktree("public", async (reference) => ({ value: { path: reference.path, branch: reference.branch }, keys: Object.keys(reference), frozen: Object.isFrozen(reference) }));`, null, {
    worktree: async () => { materialized += 1; return { path: "/worktrees/public", branch: "public-branch" }; },
  }).result;
  assert.deepEqual(result, { value: { path: "/worktrees/public", branch: "public-branch" }, keys: ["path", "branch"], frozen: true });
  assert.equal(materialized, 1);
});

void test("withWorktree requires explicit named scopes", async () => {
  const materializedOwners: string[] = [];
  const materialize = async (owner: string) => { materializedOwners.push(owner); return { path: "/worktrees/empty", branch: "branch" }; };
  assert.deepEqual(await runWorkflow(`return await withWorktree("empty", async () => ({ ok: true }));`, null, { worktree: materialize }).result, { ok: true });
  assert.deepEqual(materializedOwners, ["worktree/named/empty"]);
  assert.deepEqual(inspectWorkflowScript(`withWorktree("shared", async () => agent("x"));`).map(({ kind, name }) => ({ kind, name })), [{ kind: "withWorktree", name: "shared" }, { kind: "agent", name: null }]);
  for (const source of [`withWorktree(() => 1)`, `withWorktree("", () => 1)`, `withWorktree(1, () => 1)`, `withWorktree("shared", 1)`, `withWorktree("shared", () => 1, 2)`]) assert.throws(() => preflight(source, capabilities), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  assert.throws(() => preflight(`const alias = withWorktree; alias(() => 1);`, capabilities), /direct withWorktree.*aliases.*unsupported/i);
  await assert.rejects(runWorkflow(`return await withWorktree(() => agent("same"));`).result, /withWorktree requires a name and callback/i);
  await assert.rejects(runWorkflow(`return await withWorktree("scope", 1);`).result, /withWorktree callback must be a function/i);
  await assert.rejects(runWorkflow(`const alias = withWorktree; return alias(() => 1);`).result, /direct withWorktree.*aliases.*unsupported/i);
});
void test("parallel identities do not depend on completion order", async () => {
  const resolvers = new Map<string, () => void>();
  const identities: Array<{ structuralPath: string[]; callSite: string; occurrence: number }> = [];
  const run = runWorkflow(`return parallel("batch",{first:()=>agent("first"),second:()=>agent("second")});`, null, {
    agent: async (prompt, _options, _signal, identity) => {
      identities.push(identity as typeof identities[number]);
      return new Promise<string>((resolve) => { resolvers.set(prompt, () => { resolve(prompt); }); });
    },
  });
  while (resolvers.size < 2) await new Promise((resolve) => setImmediate(resolve));
  const second = resolvers.get("second");
  const first = resolvers.get("first");
  assert.ok(second && first);
  second(); first();
  assert.deepEqual(await run.result, { first: "first", second: "second" });
  assert.deepEqual(identities.map(({ structuralPath, occurrence }) => ({ structuralPath, occurrence })).sort((left, right) => left.structuralPath.join("/").localeCompare(right.structuralPath.join("/"))), [{ structuralPath: ["batch", "first"], occurrence: 1 }, { structuralPath: ["batch", "second"], occurrence: 1 }]);
});

void test("aliases and reserved internals are rejected before the agent bridge while extension options pass through", async () => {
  let launched = false;
  await assert.rejects(runWorkflow(`const alias=agent; return alias("no");`, null, { agent: async () => { launched = true; return null; } }).result, /direct agent.*aliases.*unsupported/i);
  assert.equal(launched, false);
  assert.throws(() => preflight(`__pi_extensible_workflows_agent("x", {}, "0:1")`, capabilities), /reserved for workflow agent instrumentation/);
  assert.throws(() => runWorkflow(`return __pi_extensible_workflows_agent("x", {}, "0:1")`, null, { agent: async () => { launched = true; return null; } }), /reserved for workflow agent instrumentation/);
  await assert.rejects(runWorkflow(`const internal=globalThis["__pi_extensible_workflows"+"_agent"]; return internal("x", {}, "0:1");`, null, { agent: async () => { launched = true; return null; } }).result, /not a function/);
  assert.equal(launched, false);
  assert.doesNotThrow(() => preflight(`agent("x",{name:"old",continueFrom:"old"})`, capabilities));
  assert.equal(await runWorkflow(`return agent("x",{[args.key]:"old"});`, { key: "name" }, { agent: async () => { launched = true; return "ok"; } }).result, "ok");
  assert.equal(launched, true);
});

void test("worker cancellation is immediate even for runaway synchronous code", async () => {
  const run = runWorkflow(`export const meta={name:'x',description:'x'}; while(true){}`);
  const started = performance.now();
  run.cancel();
  await assert.rejects(run.result, (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  assert.ok(performance.now() - started < 1000);
});

void test("permission-sandboxed child cannot read files, reach network, or spawn processes", async () => {
  const fsRead = runWorkflow(`export const meta={name:'x',description:'x'}; return 'leaked';`);
  assert.deepEqual(await fsRead.result, "leaked");
  const hostile = runWorkflow(`export const meta={name:'hostile',description:'hostile'}; try { const fs = globalThis.constructor.constructor('return require("node:fs")')(); return fs.readFileSync('/etc/hostname','utf8'); } catch(e) { return 'blocked:'+e.code; }`);
  const result = await hostile.result as string;
  assert.match(result, /blocked:/);
});

void test("workflow workers support a symlinked temporary directory", async () => {
  const tmpdirVariable = process.platform === "win32" ? "TEMP" : "TMPDIR";
  const originalTmpdir = process.env[tmpdirVariable];
  const root = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-symlinked-tmp-"));
  const realTmpdir = join(root, "real");
  const symlinkedTmpdir = join(root, "link");
  mkdirSync(realTmpdir);
  symlinkSync(realTmpdir, symlinkedTmpdir, process.platform === "win32" ? "junction" : "dir");
  process.env[tmpdirVariable] = symlinkedTmpdir;

  try {
    assert.equal(await runWorkflow("return 42;").result, 42);
  } finally {
    if (originalTmpdir === undefined) {
      if (tmpdirVariable === "TEMP") delete process.env.TEMP;
      else delete process.env.TMPDIR;
    } else process.env[tmpdirVariable] = originalTmpdir;
    rmSync(root, { recursive: true, force: true });
  }
});

void test("workflow cancellation reaches an active top-level scheduler agent", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const scheduler = new FairAgentScheduler(async ({ signal }) => {
    markStarted();
    await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
    throw new WorkflowError("CANCELLED", "cancelled");
  }, 1);
  scheduler.addRun("run", 1);
  const run = runWorkflow(`export const meta={name:'x',description:'x'}; return await agent('wait');`, null, {
    agent: async (_prompt, _options, signal) => {
      const spawned = scheduler.spawn("run", "wait", { label: "wait", cwd: "/repo", tools: [] });
      const cancel = () => { scheduler.cancel(spawned.id); };
      signal.addEventListener("abort", cancel, { once: true });
      const outcome = await spawned.result.finally(() => { signal.removeEventListener("abort", cancel); });
      if (!outcome.ok) throw new WorkflowError("CANCELLED", outcome.error.message);
      return outcome.value;
    },
  });
  await started;
  run.cancel();
  await assert.rejects(run.result, (error: unknown) => error instanceof WorkflowError && error.code === "CANCELLED");
  await scheduler.flush();
  assert.deepEqual(scheduler.snapshot().map(({ state }) => state), ["cancelled"]);
});

void test("workflow failure aborts in-flight bridge work", async () => {
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  let markAborted!: () => void;
  const aborted = new Promise<void>((resolve) => { markAborted = resolve; });
  const run = runWorkflow(`await Promise.all([shell("wait"), Promise.reject(new Error("boom"))]);`, null, {
    shell: async (_command, _options, signal) => {
      markStarted();
      await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { resolve(); }, { once: true }); });
      markAborted();
      throw new WorkflowError("CANCELLED", "cancelled");
    },
  });
  await started;
  await assert.rejects(run.result, /boom/);
  await aborted;
});

void test("worker watchdog terminates a synchronous heartbeat stall after five seconds", { timeout: 7000 }, async () => {
  const run = runWorkflow(`export const meta={name:'x',description:'x'}; while(true){}`);
  const started = performance.now();
  await assert.rejects(run.result, (error: unknown) => error instanceof WorkflowError && error.code === "WORKER_UNRESPONSIVE");
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 4900 && elapsed < 6500, `watchdog fired after ${String(elapsed)}ms`);
});
void test("worker watchdog tolerates a delayed parent event loop while agent work is pending", { timeout: 8000 }, async () => {
  let started!: () => void;
  let release!: () => void;
  let agentCalls = 0;
  const agentStarted = new Promise<void>((resolve) => { started = resolve; });
  const agentResult = new Promise<string>((resolve) => { release = () => { resolve("done"); }; });
  const run = runWorkflow(`return await agent("wait");`, null, { agent: async () => { agentCalls += 1; started(); return agentResult; } });
  await agentStarted;
  execFileSync(process.execPath, ["-e", "Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5500)"]);
  await new Promise<void>((resolve) => setImmediate(resolve));
  release();
  assert.equal(await run.result, "done");
  assert.equal(agentCalls, 1);
});

void test("worker enforces 10 MB boundaries on individual and final JSON values", async () => {
  const oversized = "x".repeat(RPC_LIMIT_BYTES);
  assert.throws(() => runWorkflow(`export const meta={name:'x',description:'x'};`, oversized), (error: unknown) => error instanceof WorkflowError && error.code === "RPC_LIMIT_EXCEEDED");
  const run = runWorkflow(`export const meta={name:'x',description:'x'}; return 'x'.repeat(${String(RPC_LIMIT_BYTES)});`);
  await assert.rejects(run.result, (error: unknown) => error instanceof WorkflowError && error.code === "RPC_LIMIT_EXCEEDED");
  let called = false;
  const rendered = runWorkflow(`export const meta={name:'x',description:'x'}; return agent(prompt('{text}',{text:'x'.repeat(${String(RPC_LIMIT_BYTES)})}));`, null, { agent: async () => { called = true; return null; } });
  await assert.rejects(rendered.result, (error: unknown) => error instanceof WorkflowError && error.code === "RPC_LIMIT_EXCEEDED");
  assert.equal(called, false);
});
void test("shell calls use deterministic identity, preserve nonzero results, and validate the DSL boundary", async () => {
  const identities: Array<{ callSite: string; occurrence: number; structuralPath: readonly string[] }> = [];
  const run = runWorkflow(`for (let index = 0; index < 2; index += 1) { const result = await shell(index === 0 ? "ok" : "failed", { timeoutMs: 50, env: { CI: "1" } }); if (result.exitCode !== 0) return result; } return await parallel("checks", { one: () => shell("one"), two: () => shell("two") });`, null, {
    shell: async (command, options, signal, identity) => {
      assert.equal(signal.aborted, false);
      assert.deepEqual(options, command === "ok" || command === "failed" ? { timeoutMs: 50, env: { CI: "1" } } : {});
      identities.push({ callSite: identity.callSite, occurrence: identity.occurrence, structuralPath: identity.structuralPath });
      return command === "failed" ? { exitCode: 7, stdout: "out", stderr: "err" } : { exitCode: 0, stdout: command, stderr: "" };
    },
  });
  const result = await run.result;
  assert.deepEqual(result, { exitCode: 7, stdout: "out", stderr: "err" });
  assert.equal(identities.length, 2);
  const [firstIdentity, secondIdentity] = identities;
  assert.ok(firstIdentity && secondIdentity);
  assert.equal(firstIdentity.occurrence, 1);
  assert.equal(firstIdentity.callSite, secondIdentity.callSite);
  assert.throws(() => preflight("const alias = shell; return alias(\"x\");", capabilities), (error: unknown) => error instanceof WorkflowError && error.code === "INVALID_METADATA");
  const [shellCall] = inspectWorkflowScript("return shell(\"x\");");
  assert.ok(shellCall);
  assert.equal(shellCall.kind, "shell");
});
void test("production shell executes in the workflow cwd with merged environment", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shell-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {} }), home);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shell-cwd-"));
  const result = await workflow.execute("id", { name: "shell", script: "return await shell(\"node -e \\\"process.stdout.write(process.env.SHELL_TEST);process.stderr.write('err');process.exit(3)\\\"\", { env: { SHELL_TEST: \"yes\" } });", foreground: true }, new AbortController().signal, undefined, { cwd, model: { provider: "openai", id: "gpt", contextWindow: 1_000_000, maxTokens: 1_000 }, getContextUsage: () => ({ tokens: 0, contextWindow: 1_000_000 }), sessionManager: { getSessionId: () => "session" } });
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? "null"), { exitCode: 3, stdout: "yes", stderr: "err" });
});
void test("production shell does not journal results that exceed the complete RPC boundary", async () => {
  const home = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shell-boundary-"));
  const tools: Array<{ name: string; execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }> }> }> = [];
  workflowExtension(testExtensionApi({ registerTool(tool: (typeof tools)[number]) { tools.push(tool); }, registerCommand() {}, getThinkingLevel: () => "medium", getActiveTools: () => ["workflow"], on() {} }), home);
  const workflow = tools.find(({ name }) => name === "workflow");
  assert.ok(workflow);
  const cwd = mkdtempSync(join(tmpdir(), "pi-extensible-workflows-shell-boundary-cwd-"));
  const command = `node -e "process.stdout.write('x'.repeat(${String(RPC_LIMIT_BYTES - 80)}))"`;
  await assert.rejects(workflow.execute("id", { name: "shell-boundary", script: `return await shell(${JSON.stringify(command)});`, foreground: true }, new AbortController().signal, undefined, { cwd, model: { provider: "openai", id: "gpt" }, sessionManager: { getSessionId: () => "session" } }), (error: unknown) => error instanceof WorkflowError && error.code === "RPC_LIMIT_EXCEEDED");
  const [runId] = await listRunIds(cwd, "session", home);
  assert.ok(runId);
  const journal = JSON.parse(readFileSync(join(new RunStore(cwd, "session", runId, home).directory, "journal.json"), "utf8")) as { completed: Record<string, unknown> };
  assert.deepEqual(journal.completed, {});
});
