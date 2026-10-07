import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { URL, fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { createAgentSession, createEventBus, DefaultResourceLoader, ExtensionRunner, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { streamSimple } from '@earendil-works/pi-ai/api/openai-codex-responses';
import { getModel } from '@earendil-works/pi-ai/compat';
import { Type } from 'typebox';
import workflowExtension from '../dist/src/host.js';
import starter from '../dist/starter/index.js';
import { collectRoleContributions } from '@piewf/pi-ext-roles';
import { resetWorkflowRegistry } from '../dist/src/index.js';
const url = path => pathToFileURL(path).href;
const core = fileURLToPath(new URL('..',import.meta.url));
const put=(path,text)=>{mkdirSync(dirname(path),{recursive:true});writeFileSync(path,text);return path;};

for(const order of ['host-first','contributor-first','standalone-only']) test(`real loader/runner workflow and standalone setup: ${order}`,async t=>{
 const dir=mkdtempSync(join(tmpdir(),'roles-live-')),cwd=join(dir,'project'),agentDir=join(dir,'agent');mkdirSync(cwd,{recursive:true});
 resetWorkflowRegistry();t.after(()=>{resetWorkflowRegistry();rmSync(dir,{recursive:true,force:true});delete globalThis.__rolesInputs;});
 globalThis.__rolesInputs=[];
 const transport=`import {testTransport} from ${JSON.stringify(url(join(core,'dist/test/test-transport.js')))};
const transport=testTransport(async input=>{globalThis.__rolesInputs.push(input);return {sessionId:'fixture',messages:[{role:'assistant',content:[{type:'text',text:'ok'}]}],getSessionStats:()=>({tokens:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0},cost:0}),prompt:async()=>{},dispose(){}};});`;
 const host=put(join(dir,'host.mjs'),`import host from ${JSON.stringify(url(join(core,'dist/src/index.js')))};${transport}export default pi=>host(pi,${JSON.stringify(dir)},undefined,transport,${JSON.stringify(agentDir)});`);
 const subagents=put(join(dir,'subagents.mjs'),`import {registerSubagentsExtension} from ${JSON.stringify(url(join(core,'dist/subagents/index.js')))};${transport}export default pi=>registerSubagentsExtension(pi,{managerDependencies:{agentDir:${JSON.stringify(agentDir)},transport}});`);
 const contributor=put(join(dir,'contributor.mjs'),`import {registerRoleContribution} from ${JSON.stringify(import.meta.resolve('@piewf/pi-ext-roles'))};export default pi=>registerRoleContribution(pi,{owner:import.meta.url,roleDirectories:['./roles']});`);
 put(join(dir,'roles/apionly.md'),'---\ndescription: API only\n---\nAPI_ROLE_PROMPT');
 const disabled=put(join(agentDir,'extensions/disabled.mjs'),'export default ()=>{throw new Error("disabled factory executed")};');
 put(join(cwd,'.pi/extensions/untrusted.mjs'),'export default ()=>{throw new Error("untrusted factory executed")};');
 put(join(agentDir,'settings.json'),JSON.stringify({extensions:[`-${disabled}`],cacheWarming:'off',defaultProjectTrust:'never'}));
 const template=join(core,'examples/workflow-extension-template/index.js');
 const bus=createEventBus(),settings=SettingsManager.create(cwd,agentDir);settings.setProjectTrusted(false);
 const loader=new DefaultResourceLoader({cwd,agentDir,eventBus:bus,settingsManager:settings,additionalExtensionPaths:order==='standalone-only'?[subagents,contributor,template]:order==='host-first'?[host,subagents,contributor,template]:[contributor,template,subagents,host],noSkills:true,noThemes:true,noPromptTemplates:true});
 await loader.reload();const loaded=loader.getExtensions();assert.deepEqual(loaded.errors,[]);
 assert.equal(collectRoleContributions(bus,{activeOnly:true}).length,0);
 const manager=SessionManager.inMemory(cwd),registry={getAvailable:()=>[{provider:'fixture',id:'model'}],getAll:()=>[{provider:'fixture',id:'model'}]};
 const runner=new ExtensionRunner(loaded.extensions,loaded.runtime,cwd,manager,registry);
 const errors=[];runner.onError(e=>errors.push(e));
 runner.bindCore({refreshTools(){},sendMessage(){},sendUserMessage(){},appendEntry(){},getActiveTools:()=>['read','workflow'],getAllTools:()=>[{name:'read'},{name:'workflow'}],getThinkingLevel:()=> 'medium'}, {getModel:()=>({provider:'fixture',id:'model'}),isProjectTrusted:()=>false,isIdle:()=>true,getSignal:()=>new AbortController().signal,hasPendingMessages:()=>false});
 runner.setUIContext(undefined,'print');
 await runner.emit({type:'session_start',reason:'startup'});assert.deepEqual(errors,[]);
 const collected=collectRoleContributions(bus,{activeOnly:true});assert.ok(collected.some(s=>s.owner===contributor));assert.ok(collected.some(s=>s.owner===template));
 const ctx=runner.createContext();
 const workflow=runner.getToolDefinition('workflow');
 if(order!=='standalone-only') { assert.ok(workflow);
 await workflow.execute('workflow-call',{name:'api-role',foreground:true,script:'return agent("inspect", {role:"apionly"});'},new AbortController().signal,undefined,ctx);
 assert.match(globalThis.__rolesInputs[0]?.systemPromptAppend ?? '',/API_ROLE_PROMPT/); }
 const standalone=runner.getToolDefinition('subagents_run');assert.ok(standalone);
 await standalone.execute('standalone-call',{prompt:'inspect',role:'apionly',mode:'foreground'},new AbortController().signal,undefined,ctx);
 assert.match(globalThis.__rolesInputs[order==='standalone-only'?0:1]?.systemPromptAppend ?? '',/API_ROLE_PROMPT/);
 if(workflow) { await workflow.execute('template-call',{name:'template-role',foreground:true,script:'return agent("inspect", {role:"reviewer"});'},new AbortController().signal,undefined,ctx);
 assert.match(globalThis.__rolesInputs[2]?.systemPromptAppend ?? '',/Review the requested change/); }
 await runner.emit({type:'session_shutdown',reason:'quit'});runner.invalidate();bus.clear();assert.deepEqual(errors,[]);
});

for(const entry of ['src/index.ts','dist/src/index.js']) test(`workflow legacy sources strict membership matches actual loaded ${entry}`,async t=>{
 const dir=mkdtempSync(join(tmpdir(),'roles-entry-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));resetWorkflowRegistry();
 const bus=createEventBus(),path=join(core,entry),settings=SettingsManager.create(dir,join(dir,'agent'));settings.setProjectTrusted(false);
 const loader=new DefaultResourceLoader({cwd:dir,agentDir:join(dir,'agent'),settingsManager:settings,eventBus:bus,additionalExtensionPaths:[path],noSkills:true,noThemes:true,noPromptTemplates:true});await loader.reload();const loaded=loader.getExtensions();assert.deepEqual(loaded.errors,[]);
 assert.ok(collectRoleContributions(bus,loaded).some(s=>s.scope==='global'&&s.owner===path));
 const runner=new ExtensionRunner(loaded.extensions,loaded.runtime,dir,SessionManager.inMemory(dir),{getAvailable:()=>[],getAll:()=>[]});
 await runner.emit({type:'session_shutdown',reason:'quit'});runner.invalidate();bus.clear();resetWorkflowRegistry();
});

for(const entries of [['dist/src/index.js','dist/subagents/index.js'],['dist/subagents/index.js']]) test(`session_start migration notice without a selected role: ${entries.join(',')}`,async t=>{
 const dir=mkdtempSync(join(tmpdir(),'roles-warning-')),agentDir=join(dir,'agent');t.after(()=>{rmSync(dir,{recursive:true,force:true});resetWorkflowRegistry();});
 put(join(agentDir,'pi-extensible-workflows/roles/old.md'),'Old role');
 const bus=createEventBus(),manager=SessionManager.inMemory(dir),messages=[];
 const wrappers=entries.map((entry,i)=>put(join(dir,`entry-${i}.mjs`),`import extension from ${JSON.stringify(url(join(core,entry)))};export default pi=>${entry.includes('subagents')?`extension(pi,{managerDependencies:{agentDir:${JSON.stringify(agentDir)}}})`:`extension(pi,${JSON.stringify(dir)},undefined,undefined,${JSON.stringify(agentDir)})`};`));
 for(let reload=0;reload<2;reload++) {
  resetWorkflowRegistry();const settings=SettingsManager.create(dir,agentDir);settings.setProjectTrusted(false);
  const loader=new DefaultResourceLoader({cwd:dir,agentDir,settingsManager:settings,eventBus:bus,additionalExtensionPaths:wrappers,noSkills:true,noThemes:true,noPromptTemplates:true});await loader.reload();const loaded=loader.getExtensions();assert.deepEqual(loaded.errors,[]);
  const runner=new ExtensionRunner(loaded.extensions,loaded.runtime,dir,manager,{getAvailable:()=>[],getAll:()=>[]});const errors=[];runner.onError(e=>errors.push(e));
  runner.bindCore({refreshTools(){},sendMessage(){},sendUserMessage(){},appendEntry(){},getActiveTools:()=>[],getAllTools:()=>[],getThinkingLevel:()=> 'medium'},{getModel:()=>({provider:'fixture',id:'model'}),isProjectTrusted:()=>false,isIdle:()=>true,getSignal:()=>new AbortController().signal,hasPendingMessages:()=>false});
  const ui={...runner.getUIContext(),notify:(message,type)=>{if(type==='warning')messages.push(message);}};
  runner.setUIContext(ui,'rpc');await runner.emit({type:'session_start',reason:'startup'});assert.equal(messages.length,reload===0?0:1);
  runner.setUIContext(ui,'tui');await runner.emit({type:'session_start',reason:'startup'});assert.equal(messages.length,1);
  if(reload===1) {manager.newSession();await runner.emit({type:'session_start',reason:'new'});assert.equal(messages.length,2);}
  await runner.emit({type:'session_shutdown',reason:'reload'});runner.invalidate();assert.deepEqual(errors,[]);
 }
 bus.clear();
});

for (const order of ['host-first', 'contributor-first']) for (const active of [false, true]) test(`independent tool-less contribution uses final runner membership: ${order}, active=${active}`, async t => {
 const dir=mkdtempSync(join(tmpdir(),'roles-old-membership-')),agentDir=join(dir,'agent');
 resetWorkflowRegistry();t.after(()=>{resetWorkflowRegistry();rmSync(dir,{recursive:true,force:true});});
 const host=put(join(dir,'host.mjs'),`import host from ${JSON.stringify(url(join(core,'dist/src/index.js')))};export default pi=>host(pi,${JSON.stringify(dir)},undefined,undefined,${JSON.stringify(agentDir)});`);
 const contributor=put(join(dir,'contributor.mjs'),`import {registerRoleContribution} from ${JSON.stringify(import.meta.resolve('@piewf/pi-ext-roles'))};export default pi=>registerRoleContribution(pi,{owner:import.meta.url,roleDirectories:[${JSON.stringify(join(dir,'roles'))}]});`);
 put(join(dir,'roles/oldonly.md'),'Old sourced role');
 const bus=createEventBus(),settings=SettingsManager.create(dir,agentDir);settings.setProjectTrusted(false);
 const loader=new DefaultResourceLoader({cwd:dir,agentDir,eventBus:bus,settingsManager:settings,additionalExtensionPaths:order==='host-first'?[host,contributor]:[contributor,host],noSkills:true,noThemes:true,noPromptTemplates:true});
 await loader.reload();const loaded=loader.getExtensions();assert.deepEqual(loaded.errors,[]);
 const {activeRoleDirectories,discoverRoles}=await import('../dist/src/roles.js');
 const {loadingRegistry,registerWorkflowExtension}=await import('../dist/src/registry.js');
 assert.equal(collectRoleContributions(bus,{activeOnly:true}).length,0);
 const runner=new ExtensionRunner(loaded.extensions.filter(extension=>active||extension.resolvedPath!==contributor),loaded.runtime,dir,SessionManager.inMemory(dir),{getAvailable:()=>[],getAll:()=>[]});
 const errors=[];runner.onError(error=>errors.push(error));
 runner.bindCore({refreshTools(){},sendMessage(){},sendUserMessage(){},appendEntry(){},getActiveTools:()=>[],getAllTools:()=>[],getThinkingLevel:()=> 'medium'},{getModel:()=>({provider:'fixture',id:'model'}),isProjectTrusted:()=>false,isIdle:()=>true,getSignal:()=>new AbortController().signal,hasPendingMessages:()=>false});
 runner.setUIContext(undefined,'print');
 await runner.emit({type:'session_start',reason:'startup'});assert.deepEqual(errors,[]);
 const sources=activeRoleDirectories(bus);
 assert.equal(sources.some(source=>source.owner===contributor),active);
 assert.equal(Boolean(discoverRoles({cwd:dir,agentDir,extensionRoleDirectories:sources}).oldonly),active);
 assert.deepEqual(collectRoleContributions(bus,[host]).filter(source=>source.owner===contributor),[]);
 assert.equal(loadingRegistry().frozen,true);
 assert.throws(()=>registerWorkflowExtension({version:'1.0.0',headline:'Late',roleDirectories:[join(dir,'late')]}),error=>error.code==='INVALID_METADATA'&&error.message.includes('registerRoleContribution'));
 await runner.emit({type:'session_shutdown',reason:'quit'});runner.invalidate();bus.clear();assert.deepEqual(errors,[]);
});

// Real SDK handlers and Codex serializer; only the SSE replies are simulated, not cache hits.
for (const withStarter of [false, true]) test(`dynamic tools preserve the provider prefix: core${withStarter ? '+starter' : ''} (#311)`, async t => {
 const dir=mkdtempSync(join(tmpdir(),'workflow-tool-prefix-')),agentDir=join(dir,'agent');
 mkdirSync(agentDir,{recursive:true});
 t.after(()=>{resetWorkflowRegistry();rmSync(dir,{recursive:true,force:true});});
 const catalog=getModel('openai-codex','gpt-5.6-luna');assert.ok(catalog);
 const model={...catalog,baseUrl:'https://fixture.invalid'};
 assert.equal(model.compat.supportsMidConvoSystemMessages,true);
 assert.equal(model.compat.supportsAdditionalTools,true);
 const token='x.'+Buffer.from(JSON.stringify({'https://api.openai.com/auth':{chatgpt_account_id:'fixture'}})).toString('base64url')+'.x';
 const names=['web_search','web_fetch','web_source_check','web_result'];
 const payloads=[],errors=[],forced=[];
 const settingsManager=SettingsManager.inMemory({compaction:{enabled:false},retry:{enabled:false},cacheWarming:'off',defaultTools:[]});
 const loader=new DefaultResourceLoader({cwd:dir,agentDir,settingsManager,noContextFiles:true,noSkills:true,noThemes:true,noPromptTemplates:true,appendSystemPrompt:['EXISTING APPEND'],extensionFactories:[pi=>{
  workflowExtension(pi,dir,undefined,undefined,agentDir);
  if(withStarter)starter();
  for(const name of names)pi.registerTool({name,label:name,description:'Fixture '+name,parameters:Type.Object({}),execute:()=>{throw new Error('web backend must not run');}});
  pi.registerTool({name:'web_enable',label:'Enable Web Access',description:'Activate four web tools.',parameters:Type.Object({}),execute:async()=>{
   pi.setActiveTools([...pi.getActiveTools(),...names]);
   return {content:[{type:'text',text:'Enabled: '+names.join(', ')}],details:{enabled:names}};
  }});
  pi.on('session_start',()=>{pi.setActiveTools(pi.getActiveTools().filter(name=>!names.includes(name)));});
  pi.on('before_agent_start',event=>{forced.push(event.systemPromptOptions.forceSystemPrompt);});
  pi.on('before_provider_request',event=>{payloads.push(globalThis.structuredClone(event.payload));});
 }]});
 await loader.reload();assert.deepEqual(loader.getExtensions().errors,[]);
 const runtime=await ModelRuntime.create({authPath:join(agentDir,'auth.json'),modelsPath:null,modelsStorePath:join(agentDir,'models-cache.json'),refreshOnCreate:false});
 runtime.registerProvider('openai-codex',{api:'openai-codex-responses',apiKey:token,models:[model]});
 let calls=0;
 runtime.streamSimple=(_model,context,options)=>streamSimple(model,context,{...options,apiKey:token,transport:'sse',fetch:async()=>{
  const call=++calls;
  assert.ok(call<=3,'unexpected extra model request');
  const item=call===2?{type:'function_call',id:'fc_fixture',call_id:'call_fixture',name:'web_enable',arguments:'{}'}:{type:'message',id:'msg_'+call,role:'assistant',content:[{type:'output_text',text:'ok',annotations:[]}]};
  const events=[{type:'response.created',response:{id:'resp_'+call}},{type:'response.output_item.added',output_index:0,item},{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:'resp_'+call,status:'completed',output:[item],usage:{input_tokens:0,output_tokens:0,total_tokens:0,input_tokens_details:{cached_tokens:0}}}}];
  return new globalThis.Response(events.map(event=>'data: '+JSON.stringify(event)+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});
 }});
 const {session}=await createAgentSession({cwd:dir,agentDir,resourceLoader:loader,settingsManager,modelRuntime:runtime,model,thinkingLevel:'off',sessionManager:SessionManager.inMemory(dir)});
 try {
  session.subscribe(event=>{if(event.type==='extension_error')errors.push(event);});
  await session.bindExtensions({});
  assert.ok(names.every(name=>!session.getActiveToolNames().includes(name)));
  await session.prompt('reply ok');
  assert.equal(session.getLastAssistantText(),'ok');
  await session.prompt('call web_enable');
  assert.equal(calls,3);assert.equal(payloads.length,3);
  assert.equal(session.messages.filter(message=>message.role==='toolResult'&&message.toolName==='web_enable'&&!message.isError).length,1);
  assert.ok(names.every(name=>session.getActiveToolNames().includes(name)));
  const [first,second,third]=payloads;
  assert.deepEqual(second.tools,first.tools);
  assert.deepEqual(third.tools,first.tools,'top-level tools must remain anchored to the initial request');
  const additions=third.input.filter(item=>item.type==='additional_tools');
  assert.equal(additions.length,1);
  assert.deepEqual(additions[0].tools.map(tool=>tool.name).sort(),[...names].sort());
  assert.deepEqual(second.input.slice(0,first.input.length),first.input);
  assert.deepEqual(third.input.slice(0,second.input.length),second.input,'no earlier transcript items lost');
  assert.equal(second.instructions,first.instructions);assert.equal(third.instructions,first.instructions);
  assert.match(third.instructions,/EXISTING APPEND[\s\S]*Workflow role descriptions:/);
  for(const name of ['developer','reviewer','scout','oracle','researcher'])assert.ok(third.instructions.includes('`'+name+'`'));
  assert.deepEqual(forced,[undefined,undefined]);assert.deepEqual(errors,[]);
  t.diagnostic(JSON.stringify({tools:payloads.map(payload=>payload.tools.length),additional_tools:payloads.map(payload=>payload.input.filter(item=>item.type==='additional_tools').length)}));
 } finally {
  try {await session.extensionRunner?.emit({type:'session_shutdown',reason:'quit'});} finally {session.dispose();}
 }
});
