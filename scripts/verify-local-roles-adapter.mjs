import assert from "node:assert/strict";
import console from "node:console";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import { fileURLToPath } from "node:url";

// Paired verification requires local builds. Never obtain either product from npm.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tarballs = resolve(process.argv[2] ?? "");
assert.ok(process.argv[2], "Usage: node scripts/verify-local-roles-adapter.mjs <local-tarball-directory>");
const packed = readdirSync(tarballs);
const products = ["pi-extensible-workflows-", "piewf-cli-", "piewf-pi-ext-roles-"];
const paths = products.map(prefix => {
  const matches = packed.filter(name => name.startsWith(prefix) && name.endsWith(".tgz"));
  assert.equal(matches.length, 1, `Expected one local ${prefix} tarball`);
  return join(tarballs, matches[0]);
});
const work = mkdtempSync(join(tmpdir(), "piewf-local-roles-"));
const install = join(work, "install");
const payloads = [];
let failNext = false;
let onFailure;
let interruptedChild;
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  payloads.push(payload);
  if (failNext) { failNext = false; onFailure?.(); onFailure = undefined; response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "paired deliberate failure", type: "invalid_request_error" } })); return; }
  const task = JSON.stringify(payload.messages.filter(message => message.role === "user").at(-1)?.content ?? "");
  if (task.includes('COLD_INTERRUPTION') && interruptedChild) { const child=interruptedChild;interruptedChild=undefined;child.kill('SIGKILL');response.destroy();return; }
  const called = payload.messages.flatMap(message => message.tool_calls ?? []);
  const nested = task.includes("NESTED_PARENT");
  const name = nested && !called.some(call => call.function.name === "agent") ? "agent" : nested && !called.some(call => call.function.name === "get_subagent_result") ? "get_subagent_result" : "workflow_result";
  const childResult = payload.messages.filter(message => message.role === "tool").map(message => { try { return JSON.parse(message.content); } catch { return {}; } }).find(value => value.id);
  const args = name === "agent" ? { prompt: "NESTED_CHILD", label: "child", role: "reviewer", tools: ["!*", "read"] } : name === "get_subagent_result" ? { id: childResult.id } : { result: "paired-ok" };
  response.writeHead(200, { "content-type": "text/event-stream" });
  const chunk = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: "paired", object: "chat.completion.chunk", created: 0, model: payload.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
  response.end(chunk({ role: "assistant", tool_calls: [{ index: 0, id: "paired-call", type: "function", function: { name, arguments: JSON.stringify(args) } }] }) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
});
async function command(executable, args, options = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd ?? install, env: { ...process.env, HOME: work, PI_OFFLINE: "1", ...options.env }, stdio: ["ignore", "pipe", "pipe"] });
    if (options.env?.PAIR_INTERRUPT === 'true') interruptedChild = child;
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", text => { stdout += text; });
    child.stderr.setEncoding("utf8").on("data", text => { stderr += text; });
    const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 60000);
    child.on("error", reject);
    child.on("close", code => { clearTimeout(timeout); accept({ code, stdout, stderr }); });
  });
}
function put(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function json(path, content) { put(path, JSON.stringify(content)); }
function system(payload) { return payload.messages.filter(message => message.role === "system").map(message => message.content).join("\n"); }
function names(payload) { return payload.tools.map(tool => tool.function.name).sort(); }
try {
  mkdirSync(install);
  const installed = await command("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--omit=dev", ...paths]);
  assert.equal(installed.code, 0, installed.stderr);
  const modules = join(install, "node_modules");
  put(join(install, 'paired-types.ts'), `import type {ExtensionAPI} from '@earendil-works/pi-coding-agent'; import * as registry from 'pi-extensible-workflows/registry'; import {registerWorkflowRoles} from '@piewf/pi-ext-roles/workflow'; export function verify(pi:ExtensionAPI){registerWorkflowRoles(pi,registry);}`);
  const typecheck = await command(join(root,'node_modules/.bin/tsc'), ['--noEmit','--strict','--skipLibCheck','--module','NodeNext','--target','ES2022','paired-types.ts']);
  assert.equal(typecheck.code,0,typecheck.stdout+typecheck.stderr);
  const core = join(modules, "pi-extensible-workflows");
  const roles = join(modules, "@piewf/pi-ext-roles");
  const cli = join(modules, "@piewf/cli/dist/src/cli.js");
  await new Promise(accept => server.listen(0, "127.0.0.1", accept));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const sdkScript = join(install, "paired-sdk.mjs");
  put(sdkScript, `
import assert from 'node:assert/strict';
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager } from '@earendil-works/pi-coding-agent';
const options=JSON.parse(process.env.PAIR_OPTIONS);
const services=await createAgentSessionServices({cwd:process.env.PAIR_CWD,agentDir:process.env.PI_CODING_AGENT_DIR,resourceLoaderReloadOptions:{resolveProjectTrust:async()=>process.env.PAIR_TRUST==='true'}});
const extensions=services.resourceLoader.getExtensions();
const {session}=await createAgentSessionFromServices({services,sessionManager:SessionManager.inMemory(process.env.PAIR_CWD,{id:process.env.PAIR_SESSION_ID})});
try {
 assert.deepEqual(extensions.errors,[]);
 await session.bindExtensions({mode:'print'});
 const tools=extensions.extensions.flatMap(extension=>[...extension.tools.values()].map(({definition})=>definition));
 if(process.env.PAIR_TOOL==='executor') {
  const {loadingRegistry}=await import('pi-extensible-workflows/registry');
  const {WorkflowAgentExecutor}=await import('./node_modules/pi-extensible-workflows/dist/src/agent-execution.js');
  const model={provider:session.model.provider,model:session.model.id};
  const models=new Set(services.modelRuntime.getAvailableSnapshot().map(model=>model.provider+'/'+model.id));
  const executor=new WorkflowAgentExecutor({cwd:process.env.PAIR_CWD,agentDir:process.env.PI_CODING_AGENT_DIR,projectTrusted:false,model,tools:new Set(['read']),knownModels:models,availableModels:models,agentPreparationHooks:loadingRegistry().agentPreparationHooks()});
  let configuration;
  const result=await executor.execute('ROOT_WITHOUT_THINKING',{label:'root-test',workflowName:'paired',agentOptions:options,onConfiguration(value){configuration=value;}});
  console.log(JSON.stringify({configuration,result:result.value}));
 } else if(process.env.PAIR_TOOL==='resume') {
  const command=extensions.extensions.flatMap(extension=>[...extension.commands.values()]).find(command=>command.name==='workflow');assert.ok(command);
  const ctx=session.extensionRunner.createContext();const notices=[];let picked=false,used=false;
  const select=async(prompt,choices)=>{
   if(choices.includes('Skip')) return 'Skip';
   if(prompt==='Workflows\\n') {if(picked)return 'Close';picked=true;return choices.find(choice=>choice.includes(options.runId.slice(0,8)))??choices[0];}
   if(prompt.startsWith('Resume '))return 'Foreground';
   if(!used&&choices.includes('Resume')){used=true;return 'Resume';}
   return 'Back';
  };
  await command.handler('',{...ctx,hasUI:true,mode:'rpc',ui:{select,confirm:async()=>true,notify:(text)=>notices.push(text)}});
  console.log(JSON.stringify(notices));
 } else {
  const tool=tools.find(tool=>tool.name===process.env.PAIR_TOOL);assert.ok(tool);
  const result=await tool.execute('paired-id',options,new AbortController().signal,undefined,session.extensionRunner.createContext());
  console.log(JSON.stringify(result));
 }
} finally { try {await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});} finally {session.dispose();} }
`);
  const { RunStore, listRunIds, listPersistedSessionIds } = await import(pathToFileURL(join(core, "dist/src/persistence.js")));
  let number = 0;
  async function fixture({ loaded = true, reverse = false, standalone = false, trusted = false, roleBody = "ROLE_APPEND", roleHeader = "", shared = {} } = {}) {
    const directory = join(work, `case-${++number}`), agentDir = join(directory, "agent"), cwd = join(directory, "project");
    mkdirSync(cwd, { recursive: true });
    const extensionPaths = [join(core, standalone ? "dist/subagents/index.js" : "dist/src/index.js")];
    if (loaded) { if (reverse) extensionPaths.unshift(join(roles, "src/extension.ts")); else extensionPaths.push(join(roles, "src/extension.ts")); }
    json(join(agentDir, "settings.json"), { extensions: extensionPaths, defaultProvider: "paired", defaultModel: "root", defaultThinkingLevel: "off", defaultProjectTrust: trusted ? "always" : "never", retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" });
    json(join(agentDir, "models.json"), { providers: { paired: { api: "openai-completions", apiKey: "fixture", baseUrl, models: ["root", "role", "call"].map(id => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })) } } });
    put(join(agentDir, "AGENTS.md"), "GLOBAL_AGENTS"); put(join(cwd, "AGENTS.md"), "CWD_AGENTS");
    put(join(agentDir, "APPEND_SYSTEM.md"), "EXISTING_APPEND");
    put(join(agentDir, "pi-ext-roles/roles/reviewer.md"), `---\nmodel: paired/role:off\ntools: ['!*', read]\n${roleHeader}\n---\n${roleBody}`);
    json(join(agentDir, "pi-ext-roles/settings.json"), shared);
    return { directory, agentDir, cwd, env: { PI_CODING_AGENT_DIR: agentDir, PAIR_CWD: cwd, PAIR_SESSION_ID: `paired-${number}`, PAIR_TRUST: String(trusted) } };
  }
  async function sdk(f, options, tool = "workflow") {
    const result = await command(process.execPath, [sdkScript], { env: { ...f.env, PAIR_OPTIONS: JSON.stringify(options), PAIR_TOOL: tool } });
    return result;
  }
  async function run(f, options, entry = "sdk", script = `return await agent('PAIRED_TASK',${JSON.stringify(options)});`) {
    const before = payloads.length;
    let result;
    if (entry === "sdk") result = await sdk(f, { name: "paired", script, foreground: true });
    else { const path = join(f.cwd, "workflow.js"); put(path, script); result = await command(process.execPath, [cli, "run", "--script", path, "--name", "paired"], { cwd: f.cwd, env: f.env }); }
    return { ...result, payloads: payloads.slice(before) };
  }
  const implicitFixture = await fixture();
  rmSync(join(implicitFixture.agentDir, 'pi-ext-roles/roles/reviewer.md'));
  put(join(implicitFixture.agentDir, 'pi-ext-roles/roles/custom.md'), 'CUSTOM_MODEL_FREE');
  for (const role of [undefined, 'developer', 'oracle', 'researcher', 'reviewer', 'scout', 'custom']) {
    const before = payloads.length;
    const implicit = await sdk(implicitFixture, role === undefined ? {} : { role }, 'executor');
    assert.equal(implicit.code, 0, implicit.stderr);
    const outcome = JSON.parse(implicit.stdout);
    assert.deepEqual(outcome.configuration.model, { provider: 'paired', model: 'root' });
    assert.equal(outcome.result, 'paired-ok');
    assert.equal(payloads.length, before + 1);
    assert.equal(payloads[before].model, 'root');
  }
  const opaqueImplicit = await sdk(await fixture({ loaded: false }), { role: 42 }, 'executor');
  assert.equal(opaqueImplicit.code, 0, opaqueImplicit.stderr);
  assert.deepEqual(JSON.parse(opaqueImplicit.stdout).configuration.model, { provider: 'paired', model: 'root' });
  const beforeInvalidImplicit = payloads.length;
  const invalidImplicit = await sdk(implicitFixture, { role: 42 }, 'executor');
  assert.equal(invalidImplicit.code, 1);
  assert.match(invalidImplicit.stderr, /preparation schema: roles/);
  assert.equal(payloads.length, beforeInvalidImplicit);
  console.log('paired: SDK executor spawning with inherited ModelSpec without thinking, no role, five fallbacks, custom model-free, absent opaque option and loaded schema passed');
  for (const entry of ["sdk", "cli"]) {
    const loaded = await run(await fixture(), { role: "reviewer" }, entry);
    assert.equal(loaded.code, 0, loaded.stderr); assert.match(loaded.stdout, /paired-ok/);
    assert.equal(loaded.payloads[0].model, "role"); assert.match(system(loaded.payloads[0]), /EXISTING_APPEND[\s\S]*ROLE_APPEND/);
    assert.match(system(loaded.payloads[0]), /GLOBAL_AGENTS/); assert.match(system(loaded.payloads[0]), /CWD_AGENTS/);
    assert.deepEqual(names(loaded.payloads[0]), ["read", "workflow_result"]);
    const absent = await run(await fixture({ loaded: false }), { role: 42 }, entry);
    assert.equal(absent.code, 0, absent.stderr); assert.match(absent.stdout, /paired-ok/); assert.equal(absent.payloads[0].model, "root");
    const invalid = await run(await fixture(), { role: 42 }, entry);
    assert.equal(invalid.payloads.length, 0); assert.match(invalid.stdout + invalid.stderr, /schema/i);
    console.log(`${entry}: loaded/absent/schema passed`);
  }
  for (const entry of ['sdk', 'cli']) {
    const orderedFixture = await fixture({ roleHeader: 'skills: [authorized]\nextensions: ["**/*", "builtin:*"]' });
    put(join(orderedFixture.agentDir, 'skills/authorized/SKILL.md'), '---\nname: authorized\ndescription: AUTHORIZED_SKILL_DESCRIPTION\n---\nfixture');
    const selectedFactory = join(orderedFixture.agentDir, 'authorized.mjs');
    const selectedMarker = join(orderedFixture.directory, 'authorized-loaded');
    put(selectedFactory, `import {appendFileSync} from 'node:fs';export default function(){appendFileSync(${JSON.stringify(selectedMarker)},'loaded\\n');}`);
    const settings = JSON.parse(readFileSync(join(orderedFixture.agentDir, 'settings.json'), 'utf8'));
    settings.extensions.push(selectedFactory);
    json(join(orderedFixture.agentDir, 'settings.json'), settings);
    json(join(orderedFixture.agentDir, 'pi-extensible-workflows/settings.json'), { tools: ['!*', 'read'], skills: ['!*'], extensions: ['!*'] });
    const ordered = await run(orderedFixture, { role: 'reviewer', tools: ['write'] }, entry);
    assert.equal(ordered.code, 0, ordered.stdout + ordered.stderr);
    assert.match(ordered.stdout, /paired-ok/);
    assert.deepEqual(names(ordered.payloads[0]), ['read', 'workflow_result', 'write']);
    assert.match(system(ordered.payloads[0]), /AUTHORIZED_SKILL_DESCRIPTION/);
    assert.equal(readFileSync(selectedMarker, 'utf8'), 'loaded\nloaded\n', 'role may reenable a root-authorized factory excluded by consumer defaults');
  }
  console.log('paired: ordered consumer defaults, role and call reenable authorized tools/skills/extensions in SDK/CLI passed');
  for(const entry of ['sdk','cli']) {
    const contributedFixture=await fixture({reverse:entry==='cli'});
    const contributor=join(install,`paired-contributor-${number}.mjs`);
    const contributedRoles=join(contributedFixture.directory,'contributed-roles');put(join(contributedRoles,'audit.md'),'---\nmodel: paired/role:off\ntools: ["!*", read]\n---\nACTIVE_CONTRIBUTED_ROLE');
    put(contributor,`import {registerRoleContribution} from '@piewf/pi-ext-roles';export default function(pi){registerRoleContribution(pi,{owner:import.meta.url,roleDirectories:[${JSON.stringify(contributedRoles)}]});}`);
    const settings=JSON.parse(readFileSync(join(contributedFixture.agentDir,'settings.json'),'utf8'));settings.extensions.push(contributor);json(join(contributedFixture.agentDir,'settings.json'),settings);
    const contributed=await run(contributedFixture,{role:'audit'},entry);
    assert.equal(contributed.code,0,contributed.stderr);assert.match(contributed.stdout,/paired-ok/);assert.match(system(contributed.payloads[0]),/ACTIVE_CONTRIBUTED_ROLE/);
  }
  console.log('paired: SDK/CLI contributors collected after real session_start in both load orders passed');
  for (const entry of ['sdk', 'cli']) {
    const override = await run(await fixture({ reverse: true, roleBody: "ROLE_BASE", roleHeader: "overrideSystemPrompt: true\ncontextFiles: [global]" }), { role: "reviewer", model: "paired/call:off", contextFiles: [], systemPrompt: "CALL_BASE", systemPromptAppend: "CALL_APPEND" }, entry);
    assert.equal(override.code, 0, override.stderr); assert.match(override.stdout, /paired-ok/); assert.equal(override.payloads[0].model, "call"); assert.match(system(override.payloads[0]), /CALL_BASE[\s\S]*CALL_APPEND/);
    assert.doesNotMatch(system(override.payloads[0]), /ROLE_BASE|GLOBAL_AGENTS|CWD_AGENTS/);
  }
  const shared = await run(await fixture({ shared: { modelAliases: { chosen: "paired/call:off" }, tools: ["!*", "read"] } }), { model: "chosen" });
  assert.match(shared.stdout, /paired-ok/); assert.equal(shared.payloads[0].model, "call"); assert.deepEqual(names(shared.payloads[0]), ["read", "workflow_result"]);
  for (const entry of ['sdk', 'cli']) {
    for (const loaded of [false, true]) {
      const aliasFixture = await fixture({ loaded });
      json(join(aliasFixture.agentDir, 'pi-extensible-workflows/settings.json'), { modelAliases: { chosen: 'paired/call' } });
      const aliasCall = await run(aliasFixture, { model: 'chosen' }, entry);
      assert.equal(aliasCall.code, 0, aliasCall.stdout + aliasCall.stderr);
      assert.match(aliasCall.stdout, /paired-ok/); assert.equal(aliasCall.payloads.length, 1); assert.equal(aliasCall.payloads[0].model, 'call');
      const sessions = await listPersistedSessionIds(aliasFixture.cwd, work);
      const ids = await listRunIds(aliasFixture.cwd, sessions[0], work);
      const configuration = Object.values((await new RunStore(aliasFixture.cwd, sessions[0], ids[0], work).load()).snapshot.agentConfigurations)[0];
      assert.deepEqual(configuration.model, { provider: 'paired', model: 'call' });
    }
    const aliasRoleFixture = await fixture();
    json(join(aliasRoleFixture.agentDir, 'pi-extensible-workflows/settings.json'), { modelAliases: { selected: 'paired/call' } });
    put(join(aliasRoleFixture.agentDir, 'pi-ext-roles/roles/reviewer.md'), '---\nmodel: selected\n---\nALIAS_WITHOUT_THINKING');
    const aliasRole = await run(aliasRoleFixture, { role: 'reviewer' }, entry);
    assert.equal(aliasRole.code, 0, aliasRole.stdout + aliasRole.stderr);
    assert.match(aliasRole.stdout, /paired-ok/); assert.equal(aliasRole.payloads.length, 1); assert.equal(aliasRole.payloads[0].model, 'call');
  }
  console.log('paired: SDK/CLI call aliases with and without plugin and role aliases without thinking passed');
  const standaloneFixture = await fixture({ standalone: true });
  const start = payloads.length;
  const standalone = await sdk(standaloneFixture, { prompt: "STANDALONE", role: "reviewer", mode: "foreground" }, "subagents_run");
  assert.match(standalone.stdout, /paired-ok/); assert.equal(payloads[start].model, "role"); assert.match(JSON.stringify(payloads[start].messages), /Agent: reviewer/);
  const absentStandaloneFixture = await fixture({ standalone: true, loaded: false });
  const beforeAbsentStandalone = payloads.length;
  const absentStandalone = await sdk(absentStandaloneFixture, { prompt: 'STANDALONE_OPAQUE', role: 42, mode: 'foreground' }, 'subagents_run');
  assert.equal(absentStandalone.code, 0, absentStandalone.stderr); assert.match(absentStandalone.stdout, /paired-ok/); assert.equal(payloads[beforeAbsentStandalone].model, 'root');
  const beforeInvalidStandalone = payloads.length;
  const invalidStandalone = await sdk(await fixture({ standalone: true }), { prompt: 'STANDALONE_SCHEMA', role: 42, mode: 'foreground' }, 'subagents_run');
  assert.match(invalidStandalone.stdout + invalidStandalone.stderr, /schema/i); assert.equal(payloads.length, beforeInvalidStandalone);
  const handles = await run(await fixture(), {}, "sdk", "const h=agent.create({name:'review',role:'reviewer'}); const first=await h.send('HANDLE_FIRST'); const second=await h.send('HANDLE_SECOND'); return {first,second};");
  assert.match(handles.stdout, /paired-ok/); assert.equal(handles.payloads.length, 2); assert.ok(handles.payloads.every(payload => payload.model === "role"));
  const doctorFixture = await fixture();
  const doctor = await command(process.execPath, [cli, "doctor", "--agent-options", '{"role":"reviewer"}', "--json"], { cwd: doctorFixture.cwd, env: doctorFixture.env });
  assert.equal(doctor.code, 0, doctor.stderr); assert.equal(JSON.parse(doctor.stdout).agentInspection.model.model, "role");
  console.log("paired: load order, call override, context scopes, shared alias/defaults, standalone-only, handle, doctor passed");
  const retryFixture = await fixture();
  failNext = true;
  const failed = await run(retryFixture, { role: 'reviewer' });
  assert.equal(failed.code, 1); assert.equal(failed.payloads.length, 1);
  const runIds = await listRunIds(retryFixture.cwd, retryFixture.env.PAIR_SESSION_ID, work);
  assert.equal(runIds.length, 1);
  const store = new RunStore(retryFixture.cwd, retryFixture.env.PAIR_SESSION_ID, runIds[0], work);
  const frozen = await store.load();
  assert.equal(frozen.snapshot.identityVersion, 6);
  assert.equal(Object.keys(frozen.snapshot.agentConfigurations).length, 1);
  rmSync(join(retryFixture.agentDir, 'pi-ext-roles/roles/reviewer.md'));
  const beforeRetry = payloads.length;
  const retried = await sdk(retryFixture, {runId:runIds[0],expectedState:'failed',foreground:true}, 'workflow_retry');
  assert.equal(retried.code, 0, retried.stderr); assert.match(retried.stdout, /paired-ok/);
  assert.equal(payloads[beforeRetry].model, 'role'); assert.match(system(payloads[beforeRetry]), /ROLE_APPEND/);
  for (const recovery of ['retry', 'resume']) {
    for (const loaded of [false, true]) {
      const aliasFixture = await fixture({ loaded });
      const settingsPath = join(aliasFixture.agentDir, 'pi-extensible-workflows/settings.json');
      json(settingsPath, { modelAliases: { call: 'paired/role:off' } });
      if (recovery === 'retry') failNext = true;
      else aliasFixture.env.PAIR_INTERRUPT = 'true';
      const task = recovery === 'retry' ? 'ALIAS_FAILURE' : 'COLD_INTERRUPTION';
      const failure = await run(aliasFixture, {}, 'sdk', `await agent('${task}',{model:'call:off'});return await agent('NEW_ALIAS_IDENTITY',{model:'call:off'});`);
      assert.equal(failure.code, recovery === 'retry' ? 1 : null, failure.stdout + failure.stderr);
      assert.equal(failure.payloads.length, 1); assert.equal(failure.payloads[0].model, 'role');
      delete aliasFixture.env.PAIR_INTERRUPT;
      const ids = await listRunIds(aliasFixture.cwd, aliasFixture.env.PAIR_SESSION_ID, work);
      assert.equal(ids.length, 1);
      json(settingsPath, {});
      const before = payloads.length;
      const recovered = await sdk(aliasFixture, { runId: ids[0], ...(recovery === 'retry' ? { expectedState: 'failed', foreground: true } : {}) }, recovery === 'retry' ? 'workflow_retry' : 'resume');
      assert.match(recovered.stdout + recovered.stderr, /UNKNOWN_MODEL/);
      assert.equal(payloads.length - before, 1, 'frozen identity executes but removed alias must not fall through for the new identity');
      assert.equal(payloads[before].model, 'role');
    }
  }
  console.log('paired: retry/cold resume preserve frozen models and block removed original aliases for new identities with or without plugin passed');
  // Kill the actual SDK host after configuration persistence and provider request dispatch.
  const coldFixture=await fixture();coldFixture.env.PAIR_INTERRUPT='true';
  const resumePolicy = join(install, 'paired-resume-policy.mjs');
  put(resumePolicy, `import {loadingRegistry,registerWorkflowExtension} from 'pi-extensible-workflows/registry';export default function(){if(loadingRegistry().frozen)return;registerWorkflowExtension({version:'1.0.0',headline:'Resume policy',modelAliases:{current:{resolve:()=> 'paired/call:off'}},functions:{resumeReview:{description:'Prepare one agent before interruption and another after resume',input:{type:'object',additionalProperties:false},output:{type:'string'},async run(_input,context){await context.agent('COLD_INTERRUPTION',{role:'reviewer'});return context.agent('NEW_AFTER_RESUME',{role:'oracle'});}}}});}`);
  const coldSettingsPath = join(coldFixture.agentDir, 'settings.json');
  const coldSettings = JSON.parse(readFileSync(coldSettingsPath, 'utf8')); coldSettings.extensions.push(resumePolicy); json(coldSettingsPath, coldSettings);
  const killed=await run(coldFixture,{},'sdk','return await resumeReview({});');
  assert.equal(killed.code,null);assert.equal(killed.payloads.length,1);delete coldFixture.env.PAIR_INTERRUPT;
  const coldIds=await listRunIds(coldFixture.cwd,coldFixture.env.PAIR_SESSION_ID,work);assert.equal(coldIds.length,1);
  const coldStore = new RunStore(coldFixture.cwd, coldFixture.env.PAIR_SESSION_ID, coldIds[0], work);
  assert.equal(Object.keys((await coldStore.load()).snapshot.agentConfigurations).length, 1);
  rmSync(join(coldFixture.agentDir,'pi-ext-roles/roles/reviewer.md'));
  put(join(coldFixture.agentDir, 'pi-ext-roles/roles/oracle.md'), '---\nmodel: current\ncontextFiles: []\n---\nNEW_ROLE_AFTER_RESUME');
  const beforeResume = payloads.length;
  const resumed = await sdk(coldFixture, {runId:coldIds[0]}, 'resume');
  assert.equal(resumed.code, 0, resumed.stderr); assert.match(resumed.stdout, /completed/);
  assert.equal(payloads.length - beforeResume, 2);
  assert.equal(payloads[beforeResume].model, 'role'); assert.match(system(payloads[beforeResume]), /ROLE_APPEND/);
  assert.equal(payloads[beforeResume + 1].model, 'call'); assert.match(system(payloads[beforeResume + 1]), /NEW_ROLE_AFTER_RESUME/);
  assert.doesNotMatch(system(payloads[beforeResume + 1]), /GLOBAL_AGENTS|CWD_AGENTS/);
  assert.equal(Object.keys((await coldStore.load()).snapshot.agentConfigurations).length, 2);
  const standaloneFail = await fixture({standalone:true}); failNext=true;
  const badStandalone = await sdk(standaloneFail,{prompt:'STANDALONE_RETRY',role:'reviewer',mode:'foreground'},'subagents_run');
  const badId=JSON.parse(badStandalone.stdout).details.id;
  rmSync(join(standaloneFail.agentDir,'pi-ext-roles/roles/reviewer.md'));
  const retriedStandalone=await sdk(standaloneFail,{id:badId},'subagents_retry');
  assert.equal(retriedStandalone.code,0,retriedStandalone.stderr); assert.match(retriedStandalone.stdout,/paired-ok/);
  console.log('paired: frozen retry/cold resume, new registered-function agent resolves live role/dynamic alias (#284), standalone retry after role deletion passed');
  const nestedFixture = await fixture({ roleHeader: 'skills: ["*"]\nextensions: ["**/*", "builtin:*"]' });
  for (const name of ['kept','excluded']) put(join(nestedFixture.agentDir,'skills',name,'SKILL.md'),`---\nname: ${name}\ndescription: ${name.toUpperCase()}_SKILL_DESCRIPTION\n---\n${name}`);
  const capability = join(nestedFixture.agentDir,'capability.mjs');
  put(capability,`import {Type} from '@earendil-works/pi-ai'; export default function(pi){pi.registerTool({name:'agent',label:'Agent capability',description:'Root capability',parameters:Type.Object({}),execute:async()=>({content:[],details:{}})});}`);
  const excludedFactory=join(nestedFixture.agentDir,'excluded.mjs'),marker=join(nestedFixture.directory,'factory-loaded');
  put(excludedFactory,`import {appendFileSync} from 'node:fs';export default function(){appendFileSync(${JSON.stringify(marker)},'loaded\\n');}`);
  const nestedSettings = JSON.parse(readFileSync(join(nestedFixture.agentDir,'settings.json'),'utf8')); nestedSettings.extensions.push(capability,excludedFactory); json(join(nestedFixture.agentDir,'settings.json'),nestedSettings);
  // Extension modules resolve dependencies from the local install only.
  put(capability,readFileSync(capability,'utf8').replace("'@earendil-works/pi-ai'",JSON.stringify(pathToFileURL(join(modules,'@earendil-works/pi-ai/dist/index.js')).href)));
  const parentOptions={tools:['!*','agent','read'],skills:['!*','kept'],extensions:['!*',join(roles,'src/extension.ts'),capability]};
  const nestedResult = await run(nestedFixture,parentOptions,'sdk',`return await agent('NESTED_PARENT',${JSON.stringify(parentOptions)});`);
  assert.equal(nestedResult.code,0,nestedResult.stderr); assert.match(nestedResult.stdout,/paired-ok/);
  const childPayload=nestedResult.payloads.find(payload=>payload.messages.some(message=>message.role==='user'&&JSON.stringify(message.content).includes('NESTED_CHILD')));
  assert.ok(childPayload,JSON.stringify(nestedResult.payloads.map(payload=>payload.messages))); assert.equal(childPayload.model,'role'); assert.match(system(childPayload),/ROLE_APPEND/);
  assert.deepEqual(names(childPayload),['read','workflow_result']);
  assert.match(system(childPayload),/KEPT_SKILL_DESCRIPTION/);assert.doesNotMatch(system(childPayload),/EXCLUDED_SKILL_DESCRIPTION/);
  assert.equal(readFileSync(marker,'utf8'),'loaded\n','selected-out factory must run only in the root inventory session, never in parent/child sessions');
  console.log('paired: nested role preparation and parent tool/skill/extension ceilings, excluded factory never spawned passed');
  for (const entry of ['sdk', 'cli']) {
    const narrowed = await fixture({ trusted: true });
    const projectMarker = join(narrowed.directory, 'project-loaded');
    put(join(narrowed.cwd, '.pi/extensions/project.js'), `import {appendFileSync} from 'node:fs';export default function(){appendFileSync(${JSON.stringify(projectMarker)},'loaded\\n');}`);
    put(join(narrowed.cwd, '.pi/skills/project-secret/SKILL.md'), '---\nname: project-secret\ndescription: PROJECT_SKILL_DENIED\n---\nfixture');
    put(join(narrowed.cwd, '.pi/APPEND_SYSTEM.md'), 'PROJECT_APPEND_DENIED');
    put(join(narrowed.cwd, '.pi/pi-ext-roles/roles/reviewer.md'), '---\ntools: [read]\n---\nPROJECT_ROLE_DENIED');
    const policy = join(narrowed.agentDir, 'trust-policy.mjs');
    put(policy, `import {loadingRegistry,registerWorkflowExtension} from ${JSON.stringify(pathToFileURL(join(core, 'dist/src/registry.js')).href)};
      import {Type} from ${JSON.stringify(pathToFileURL(join(modules, '@earendil-works/pi-ai/dist/index.js')).href)};
      export default function(pi){
        pi.registerTool({name:'agent',label:'Agent',description:'Root capability',parameters:Type.Object({}),execute:async()=>({content:[],details:{}})});
        if(loadingRegistry().frozen)return;
        registerWorkflowExtension({version:'1.0.0',headline:'Trust narrowing',agentSetupHooks:{narrow:{setup(agent){if(agent.sessionInput.sessionLabel.includes(':parent:'))agent.sessionInput.resourcePolicy.projectTrusted=false;}}}});
      }`);
    const settings = JSON.parse(readFileSync(join(narrowed.agentDir, 'settings.json'), 'utf8'));
    settings.extensions.push(policy); json(join(narrowed.agentDir, 'settings.json'), settings);
    const result = await run(narrowed, {}, entry, "return agent('NESTED_PARENT',{label:'parent',tools:['!*','agent','read']});");
    assert.equal(result.code, 0, result.stderr); assert.match(result.stdout, /paired-ok/);
    const child = result.payloads.find(payload => payload.messages.some(message => message.role === 'user' && JSON.stringify(message.content).includes('NESTED_CHILD')));
    assert.ok(child); assert.equal(child.model, 'role'); assert.match(system(child), /ROLE_APPEND/);
    assert.doesNotMatch(system(child), /PROJECT_ROLE_DENIED|PROJECT_APPEND_DENIED|PROJECT_SKILL_DENIED/);
    assert.equal(readFileSync(projectMarker, 'utf8'), 'loaded\n', 'project factory runs in the trusted root only, never in parent or child');
    const sessionIds = await listPersistedSessionIds(narrowed.cwd, work); assert.equal(sessionIds.length, 1);
    const runIds = await listRunIds(narrowed.cwd, sessionIds[0], work); assert.equal(runIds.length, 1);
    const configurations = Object.values((await new RunStore(narrowed.cwd, sessionIds[0], runIds[0], work).load()).snapshot.agentConfigurations);
    assert.equal(configurations.find(configuration => configuration.label === 'parent').projectTrusted, true);
    assert.equal(configurations.find(configuration => configuration.label === 'child').projectTrusted, false);
    console.log(`${entry}: setup-narrowed trust reaches nested plugin preparation and SDK factory materialization`);
  }
  for(const role of ['developer','oracle','researcher','reviewer','scout']) {
    const builtinFixture=await fixture();rmSync(join(builtinFixture.agentDir,'pi-ext-roles/roles/reviewer.md'));
    const builtin=await run(builtinFixture,{role});assert.equal(builtin.code,0,builtin.stderr);assert.match(builtin.stdout,/paired-ok/);
  }
  console.log('paired: all five model-free fallback roles run with native default tools passed');
  const settingsFixture=await fixture({shared:{extensionSettings:{shared:'shared',replace:'shared'}},roleHeader:'extensionSettings: {replace: role, policy: role}'});
  json(join(settingsFixture.agentDir,'pi-extensible-workflows/settings.json'),{extensionSettings:{replace:'consumer',consumer:'consumer'}});
  const observer=join(settingsFixture.agentDir,'settings-observer.mjs'),settingsMarker=join(settingsFixture.directory,'settings-observed.jsonl');
  put(observer,`import {appendFileSync} from 'node:fs';export default function(pi){pi.on('session_start',event=>{if(event.settings)appendFileSync(${JSON.stringify(settingsMarker)},JSON.stringify(event.settings)+'\\n');});}`);
  const observerSettings=JSON.parse(readFileSync(join(settingsFixture.agentDir,'settings.json'),'utf8'));observerSettings.extensions.push(observer);json(join(settingsFixture.agentDir,'settings.json'),observerSettings);
  const deliveredSettings=await run(settingsFixture,{role:'reviewer',extensionSettings:{replace:'call',call:'call'}});
  assert.equal(deliveredSettings.code,0,deliveredSettings.stderr);
  assert.deepEqual(JSON.parse(readFileSync(settingsMarker,'utf8').trim().split('\n').at(-1)),{shared:'shared',replace:'call',consumer:'consumer',policy:'role',call:'call'});
  const scopeFixture = await fixture({ roleHeader: 'contextFiles: [global]' });
  const scoped = await run(scopeFixture,{role:'reviewer'});
  assert.equal(scoped.code,0,scoped.stderr); assert.match(system(scoped.payloads[0]),/GLOBAL_AGENTS/); assert.doesNotMatch(system(scoped.payloads[0]),/CWD_AGENTS/);
  const base = await run(await fixture({roleBody:'ROLE_BASE',roleHeader:'overrideSystemPrompt: true'}),{role:'reviewer'});
  assert.equal(base.code,0,base.stderr); assert.match(system(base.payloads[0]),/ROLE_BASE/); assert.doesNotMatch(system(base.payloads[0]),/expert coding assistant/);
  const deniedFixture = await fixture();
  put(join(deniedFixture.cwd,'.pi/pi-ext-roles/roles/reviewer.md'),'MALFORMED_PROJECT_ROLE');
  put(join(deniedFixture.cwd,'.pi/APPEND_SYSTEM.md'),'PROJECT_APPEND_DENIED');
  const denied = await run(deniedFixture,{role:'reviewer'});
  assert.equal(denied.code,0,denied.stderr); assert.match(system(denied.payloads[0]),/ROLE_APPEND/); assert.doesNotMatch(system(denied.payloads[0]),/MALFORMED_PROJECT_ROLE|PROJECT_APPEND_DENIED/);
  const trustFixture = await fixture({trusted:true});
  put(join(trustFixture.cwd,'.pi/APPEND_SYSTEM.md'),'TRUSTED_PROJECT_APPEND'); failNext=true;
  const trustFailure = await run(trustFixture,{role:'reviewer'}); assert.equal(trustFailure.code,1);
  const trustedIds = await listRunIds(trustFixture.cwd,trustFixture.env.PAIR_SESSION_ID,work);
  const trustSettingsPath=join(trustFixture.agentDir,'settings.json'), trustSettings=JSON.parse(readFileSync(trustSettingsPath,'utf8')); trustSettings.defaultProjectTrust='never';json(trustSettingsPath,trustSettings);trustFixture.env.PAIR_TRUST='false';
  const beforeLostTrust=payloads.length;
  const lostTrust=await sdk(trustFixture,{runId:trustedIds[0],expectedState:'failed',foreground:true},'workflow_retry');
  assert.equal(lostTrust.code,1);assert.match(lostTrust.stderr,/trust|untrusted/i);assert.equal(payloads.length,beforeLostTrust);
  const retryTurnFixture=await fixture(); failNext=true;onFailure=()=>rmSync(join(retryTurnFixture.agentDir,'pi-ext-roles/roles/reviewer.md'));
  const retryTurn=await run(retryTurnFixture,{role:'reviewer',retries:1});
  assert.equal(retryTurn.code,0,retryTurn.stderr);assert.equal(retryTurn.payloads.length,2);assert.ok(retryTurn.payloads.every(payload=>payload.model==='role'&&system(payload).includes('ROLE_APPEND')));
  const handleFrozenFixture=await fixture();
  const remove=process.execPath+' -e '+JSON.stringify(`require('node:fs').unlinkSync(${JSON.stringify(join(handleFrozenFixture.agentDir,'pi-ext-roles/roles/reviewer.md'))})`);
  const handleFrozen=await run(handleFrozenFixture,{},'sdk',`const h=agent.create({name:'frozen',role:'reviewer'}); await h.send('FIRST'); await shell(${JSON.stringify(remove)}); return await h.send('SECOND');`);
  assert.equal(handleFrozen.code,0,handleFrozen.stderr);assert.equal(handleFrozen.payloads.length,2);assert.ok(handleFrozen.payloads.every(payload=>payload.model==='role'));
  const standaloneConfigurationPath=join(standaloneFail.agentDir,'subagents',badId,'configuration.json');
  const standaloneConfiguration=JSON.parse(readFileSync(standaloneConfigurationPath,'utf8'));assert.equal(standaloneConfiguration.version,1);
  json(standaloneConfigurationPath,{version:1,definitions:{reviewer:{prompt:'OLD_ROLE_SNAPSHOT'}}});
  const oldStandalone=await sdk(standaloneFail,{id:badId},'subagents_retry');assert.equal(oldStandalone.code,1);assert.match(oldStandalone.stderr,/configuration|incompatible/i);
  const snapshotPath=join(store.directory,'snapshot.json');json(snapshotPath,{...frozen.snapshot,identityVersion:5});
  await assert.rejects(store.load(),/snapshot.*invalid|incompatible/i);
  console.log('paired: TS contract, delivered settings precedence, base override, AGENTS scopes, denied/lost trust, per-agent retry, frozen handle, old snapshots rejected passed');
  const prefixScript=join(install,'paired-prefix.mjs');
  put(prefixScript,`
import assert from 'node:assert/strict';
import {createAgentSession,DefaultResourceLoader,ModelRuntime,SessionManager,SettingsManager} from '@earendil-works/pi-coding-agent';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
const requireSdk=createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const ai=new URL('../node_modules/@earendil-works/pi-ai/dist/',import.meta.resolve('@earendil-works/pi-coding-agent'));
const {streamSimple}=await import(new URL('api/openai-codex-responses.js',ai));
const {getModel}=await import(new URL('compat.js',ai));
const {Type}=await import(pathToFileURL(requireSdk.resolve('typebox')));
const cwd=process.env.PAIR_CWD,agentDir=process.env.PI_CODING_AGENT_DIR;
const model={...getModel('openai-codex','gpt-5.6-luna'),baseUrl:'https://fixture.invalid'};
assert.equal(model.compat.supportsAdditionalTools,true);
const token='x.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture'}})).toString('base64url')+'.x';
const names=['web_search','web_fetch','web_source_check','web_result'];
const payloads=[],forced=[],errors=[];
const settingsManager=SettingsManager.inMemory({retry:{enabled:false},compaction:{enabled:false},cacheWarming:'off',defaultTools:[]});
const loader=new DefaultResourceLoader({cwd,agentDir,settingsManager,noContextFiles:true,noSkills:true,noThemes:true,noPromptTemplates:true,additionalExtensionPaths:${JSON.stringify([join(core,'dist/src/index.js'),join(roles,'src/extension.ts')])},appendSystemPrompt:['EXISTING_APPEND'],extensionFactories:[pi=>{
 for(const name of names)pi.registerTool({name,label:name,description:name,parameters:Type.Object({}),execute:async()=>({content:[],details:{}})});
 pi.registerTool({name:'web_enable',label:'Web enable',description:'Activate tools',parameters:Type.Object({}),execute:async()=>{pi.setActiveTools([...pi.getActiveTools(),...names]);return {content:[{type:'text',text:'enabled'}],details:{}};}});
 pi.on('session_start',()=>pi.setActiveTools(pi.getActiveTools().filter(name=>!names.includes(name))));
 pi.on('before_agent_start',event=>forced.push(event.systemPromptOptions.forceSystemPrompt));
 pi.on('before_provider_request',event=>payloads.push(structuredClone(event.payload)));
}]});
await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
const runtime=await ModelRuntime.create({authPath:agentDir+'/auth.json',modelsPath:null,modelsStorePath:agentDir+'/prefix-models.json',refreshOnCreate:false});
runtime.registerProvider('openai-codex',{api:'openai-codex-responses',apiKey:token,models:[model]});
let calls=0;
runtime.streamSimple=(_model,context,options)=>streamSimple(model,context,{...options,apiKey:token,transport:'sse',fetch:async()=>{
 const call=++calls;assert.ok(call<=3);
 const item=call===2?{type:'function_call',id:'fc_fixture',call_id:'call_fixture',name:'web_enable',arguments:'{}'}:{type:'message',id:'msg_'+call,role:'assistant',content:[{type:'output_text',text:'ok',annotations:[]}]};
 const events=[{type:'response.created',response:{id:'resp_'+call}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'resp_'+call,status:'completed',output:[item],usage:{input_tokens:0,output_tokens:0,total_tokens:0,input_tokens_details:{cached_tokens:0}}}}];
 return new Response(events.map(event=>'data: '+JSON.stringify(event)+'\\n\\n').join(''),{headers:{'content-type':'text/event-stream'}});
}});
const {session}=await createAgentSession({cwd,agentDir,resourceLoader:loader,settingsManager,modelRuntime:runtime,model,thinkingLevel:'off',sessionManager:SessionManager.inMemory(cwd)});
try {
 session.subscribe(event=>{if(event.type==='extension_error')errors.push(event);});await session.bindExtensions({mode:'print'});
 assert.ok(session.getAllTools().some(tool=>tool.name==='workflow'));
 await session.prompt('reply ok');await session.prompt('call web_enable');assert.equal(calls,3);
 const [first,second,third]=payloads;assert.deepEqual(second.tools,first.tools);assert.deepEqual(third.tools,first.tools);
 assert.deepEqual(second.input.slice(0,first.input.length),first.input);assert.deepEqual(third.input.slice(0,second.input.length),second.input);
 assert.deepEqual(third.input.filter(item=>item.type==='additional_tools').flatMap(item=>item.tools.map(tool=>tool.name)).sort(),names.sort());
 assert.equal(third.instructions,first.instructions);assert.match(third.instructions,/EXISTING_APPEND[\\s\\S]*Workflow role descriptions:/);
 assert.deepEqual(forced,[undefined,undefined]);assert.deepEqual(errors,[]);console.log('paired #311: anchored tools/prefix, append preserved, additional_tools activation passed');
} finally {try{await session.extensionRunner.emit({type:'session_shutdown',reason:'quit'});}finally{session.dispose();}}
`);
  const prefixFixture=await fixture();
  const prefix=await command(process.execPath,[prefixScript],{env:prefixFixture.env});assert.equal(prefix.code,0,prefix.stderr);process.stdout.write(prefix.stdout);
  console.log(`Paired runtime verification passed (${payloads.length} local HTTP requests plus 3 synthetic Codex requests; no remote-cache evidence).`);
} finally {
  server.closeAllConnections(); await new Promise(accept => server.close(accept));
  rmSync(work, { recursive: true, force: true });
}
