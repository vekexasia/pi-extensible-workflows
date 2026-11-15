import { initializeGitFixture } from "./git-fixture.js";
import { physicalOwnerDirectory } from "./worktree-owner-fixture.js";
import assert from "node:assert/strict";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WorkflowOwnership } from "../src/ownership.js";
import { runWorkflow, executeShellCommand } from "../src/execution.js";

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean, description: string, timeout = 6000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) { assert.ok(Date.now() < end, description); await pause(20); }
}
function processes() {
  return execFileSync("ps", ["-axo", "pid=,pgid=,stat=,args="], { encoding: "utf8" }).split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    return match ? [{ pid: Number(match[1]), group: Number(match[2]), state: match[3] ?? "", args: match[4] ?? "" }] : [];
  });
}
function repo(): string {
  const cwd = mkdtempSync(join(tmpdir(), "lease-client-"));
  initializeGitFixture(cwd);
  return cwd;
}
const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

for (const mode of ["retained-worktree", "retained-unknown", "drained-success", "error-while-pending", "never-close-pending"]) {
  void test(`deferred broker closure preserves real ownership and bounded secondary evidence: ${mode}`, { timeout: 20_000 }, async () => {
    const cwd = repo();
    const fixture = join(cwd, "deferred-close.mjs");
    writeFileSync(fixture, `
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {existsSync,readFileSync} from "node:fs";
import {Server} from "node:net";
import {WorkflowOwnership} from ${JSON.stringify(new URL("../src/ownership.js", import.meta.url).href)};
import {LeaseCommandBroker} from ${JSON.stringify(new URL("../src/lease-command.js", import.meta.url).href)};
import {OwnedCommandCleanupError} from ${JSON.stringify(new URL("../src/owned-process.js", import.meta.url).href)};
import {WorkflowError} from ${JSON.stringify(new URL("../src/types.js", import.meta.url).href)};
import {PhysicalWorktreeLease,worktreeLeaseIdentity,worktreeOwnerDirectory} from ${JSON.stringify(new URL("../src/worktree-lease.js", import.meta.url).href)};
import {runWorkflow} from ${JSON.stringify(new URL("../src/execution.js", import.meta.url).href)};
const cwd=${JSON.stringify(cwd)},mode=${JSON.stringify(mode)};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done});return {promise,resolve}};
const closeStarted=deferred(),commandStarted=deferred(),commandRelease=deferred(),closingTurn=deferred();
const originalClose=Server.prototype.close,originalDispose=LeaseCommandBroker.prototype.dispose;
let releaseClose,privateDirectory,primaryFailure,disposals=0,commandFinished=false;
Server.prototype.close=function(callback){return originalClose.call(this,error=>{releaseClose=()=>callback(mode==="drained-success"?error:new Error("secondary asynchronous listener failure"));closeStarted.resolve()})};
LeaseCommandBroker.prototype.dispose=async function(){disposals++;return originalDispose.call(this)};
const execute=async()=>{
  if(mode.endsWith("pending")){commandStarted.resolve();await commandRelease.promise;commandFinished=true;return {exitCode:0,stdout:"",stderr:""}}
  primaryFailure=mode==="retained-unknown"?new OwnedCommandCleanupError("original cleanup uncertainty"):new WorkflowError("WORKTREE_FAILED","original physical verification failure");
  throw primaryFailure;
};
const ownership=new WorkflowOwnership(cwd,"deferred-close","s",new AbortController().signal,execute);
try {
const identity=await worktreeLeaseIdentity(cwd),ownerFile=worktreeOwnerDirectory(identity)+"/owner.json";
const reference=await ownership.enter(cwd,undefined,new AbortController().signal);
const ownerBefore=readFileSync(ownerFile,"utf8");
const ticket=await ownership.command(reference.scope,"exit 0",{timeoutMs:1000});
privateDirectory=/'([^']+)\\/client\\.cjs'/.exec(ticket)?.[1];assert.ok(privateDirectory);
let command;
if(mode.endsWith("pending")){
  command=ownership.shell(reference.scope,"component barrier",{});await commandStarted.promise;
}else if(mode!=="drained-success"){
  await assert.rejects(ownership.shell(reference.scope,"injected adapter fault",{}),/original/);
}
const start=Date.now();
const finalizing=ownership.finalize();let settled=false;
void finalizing.then(()=>{settled=true},()=>{settled=true});
await closeStarted.promise;
assert.equal(ownership.finalize(),finalizing,"finalize must preserve promise identity");
// A check-phase barrier distinguishes an observed pending close from a no-op rejection handler.
setImmediate(()=>setImmediate(closingTurn.resolve));await closingTurn.promise;
assert.equal(settled,false,"finalization must observe the deferred callback even after prior retention");
assert.equal(readFileSync(ownerFile,"utf8"),ownerBefore);
if(mode!=="never-close-pending")releaseClose();
if(mode==="error-while-pending"){
  await new Promise(setImmediate);
  assert.equal(settled,false,"listener failure must not skip an actual pending command");
  assert.equal(commandFinished,false);assert.equal(disposals,0);
  commandRelease.resolve();await command;
}
const execution=runWorkflow('try { throw new Error("authored catch"); } catch {} return "PASS";',null,ownership.decorate({}));
void execution.result.catch(()=>undefined);
const messages=(error,seen=new Set())=>{if(!error||seen.has(error))return [];seen.add(error);return [error.message,...messages(error.cause,seen),...(error.errors??[]).flatMap(item=>messages(item,seen))]};
if(mode==="drained-success"){
  await finalizing;assert.equal(await execution.result,"PASS");assert.equal(existsSync(ownerFile),false);assert.equal(disposals,1);
}else{
  let failure;
  await assert.rejects(finalizing,error=>{failure=error;return error instanceof OwnedCommandCleanupError&&error.cleanupUnproven===true});
  await assert.rejects(execution.result,error=>error===failure);
  await assert.rejects(ownership.leave(reference.scope),error=>error===failure,"leave and finalize expose the same evidence");
  assert.equal(ownership.finalize(),finalizing);
  assert.equal(readFileSync(ownerFile,"utf8"),ownerBefore);
  assert.equal(disposals,0,"retained or undrained scope must not dispose broker resources");
  assert.equal(existsSync(privateDirectory+"/client.cjs"),true);
  await assert.rejects(PhysicalWorktreeLease.acquire(identity,{runId:"next",sessionId:"s",executionId:"next"}),/physical owner/);
  if(mode==="never-close-pending"){
    assert.ok(Date.now()-start>=10_000,"use the existing real drain deadline, not an invented shorter budget");
    assert.match(failure.message,/lease drain failed/);assert.equal(commandFinished,false,"unknown command must still own its component lifeline");
    releaseClose();await new Promise(setImmediate);
    commandRelease.resolve();await command;
    assert.equal(readFileSync(ownerFile,"utf8"),ownerBefore,"late cleanup cannot release retained ownership");
  }else if(mode==="error-while-pending"){
    assert.match(failure.message,/secondary asynchronous listener failure/);assert.equal(commandFinished,true);
  }else{
    const original=mode==="retained-unknown"?"original cleanup uncertainty":"original physical verification failure";
    assert.match(failure.message,/secondary asynchronous listener failure/);
    assert.equal(failure.message.split(original).length-1,1,"original diagnostic must not be duplicated");
    assert.equal(failure.message.split("secondary asynchronous listener failure").length-1,1,"secondary diagnostic must not be duplicated");
    assert.ok(messages(failure).some(message=>message===primaryFailure.message),"original cause remains accessible");
    assert.ok(messages(failure).some(message=>message==="secondary asynchronous listener failure"),"secondary callback cause remains accessible");
  }
}
} finally {
  Server.prototype.close=originalClose;LeaseCommandBroker.prototype.dispose=originalDispose;
  if(privateDirectory)await fs.rm(privateDirectory,{recursive:true,force:true});
}
process.exit(0);
`);
    try { await promisify(execFile)(process.execPath, [fixture], { timeout: 17_000 }); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}

for (const mode of ["temp", "write", "listen", "rollback", "rollback-close", "server-close", "close", "dispose", "release"]) {
  void test(`broker initialization/finalization fault is sticky and releases only proven cleanup: ${mode}`, { timeout: 15_000 }, async () => {
    const cwd = repo();
    const fixture = join(cwd, "broker-fault.mjs");
    writeFileSync(fixture, `
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import {existsSync} from "node:fs";
import {Server} from "node:net";
import {syncBuiltinESMExports} from "node:module";
import {WorkflowOwnership} from ${JSON.stringify(new URL("../src/ownership.js", import.meta.url).href)};
import {LeaseCommandBroker} from ${JSON.stringify(new URL("../src/lease-command.js", import.meta.url).href)};
import {PhysicalWorktreeLease,worktreeLeaseIdentity,worktreeOwnerDirectory} from ${JSON.stringify(new URL("../src/worktree-lease.js", import.meta.url).href)};
import {runWorkflow,executeShellCommand} from ${JSON.stringify(new URL("../src/execution.js", import.meta.url).href)};
const cwd=${JSON.stringify(cwd)}, mode=${JSON.stringify(mode)};
const original={write:fs.writeFile,temp:fs.mkdtemp,rm:fs.rm,listen:Server.prototype.listen,close:Server.prototype.close};
const fault=code=>Object.assign(new Error("injected "+code),{code});
fs.mkdtemp=async(prefix,...args)=>{if(mode==="temp"&&prefix==="/tmp/pi-lt-")throw fault("ENOSPC");return original.temp(prefix,...args)};
let privateDirectory;
fs.writeFile=async(path,...args)=>{if(String(path).endsWith("/client.cjs")&&["write","rollback","rollback-close"].includes(mode)){privateDirectory=String(path).slice(0,-11);throw fault("EACCES")}return original.write(path,...args)};
fs.rm=async(path,...args)=>{if(mode==="rollback"&&String(path).includes("/pi-lt-"))throw fault("EPERM");return original.rm(path,...args)};
Server.prototype.listen=function(...args){if(mode==="listen"){queueMicrotask(()=>this.emit("error",fault("EMFILE")));return this}return original.listen.apply(this,args)};
if(["rollback-close","server-close"].includes(mode))Server.prototype.close=function(callback){return original.close.call(this,()=>callback(fault("server close failed")))};
if(mode==="close")LeaseCommandBroker.prototype.closeAdmission=function(){throw fault("close failed")};
if(mode==="dispose")LeaseCommandBroker.prototype.dispose=async function(){throw fault("dispose failed")};
if(mode==="release")PhysicalWorktreeLease.prototype.release=async function(){throw fault("release failed")};
syncBuiltinESMExports();
const ownership=new WorkflowOwnership(cwd,"fault","s",new AbortController().signal,executeShellCommand);
const retained=["rollback","rollback-close","server-close","close","dispose","release"].includes(mode);
let failure;
try {
  await assert.rejects(runWorkflow('try { await withWorktreeLease(args,async lease=>{try{await lease.command("touch forbidden",{timeoutMs:1000})}catch{}})}catch{} return "PASS";',cwd,ownership.decorate({})).result,error=>{failure=error;return error.code===(mode==="release"?"WORKTREE_FAILED":"SHELL_FAILED")});
  assert.equal(failure.cleanupUnproven===true,["rollback","rollback-close","server-close","close","dispose"].includes(mode));
  if(mode.startsWith("rollback"))assert.match(failure.message,/EACCES/);
  await assert.rejects(ownership.finalize(),error=>error===failure);
  assert.equal(existsSync(cwd+"/forbidden"),false);
  const identity=await worktreeLeaseIdentity(cwd);
  assert.equal(existsSync(worktreeOwnerDirectory(identity)),retained);
  if(retained)await assert.rejects(PhysicalWorktreeLease.acquire(identity,{runId:"next",sessionId:"s",executionId:"next"}),/physical owner/);
  else await (await PhysicalWorktreeLease.acquire(identity,{runId:"next",sessionId:"s",executionId:"next"})).release();
} finally {
  fs.writeFile=original.write;fs.mkdtemp=original.temp;fs.rm=original.rm;Server.prototype.listen=original.listen;Server.prototype.close=original.close;syncBuiltinESMExports();
  if(privateDirectory)await original.rm(privateDirectory,{recursive:true,force:true});
}
process.exit(0);
`);
    try { await promisify(execFile)(process.execPath, [fixture], { timeout: 10_000 }); }
    finally { rmSync(cwd, { recursive: true, force: true }); }
  });
}

for (const reuse of ["once", "sequential"]) for (const mode of ["inherit", "ignore"]) for (const signal of ["SIGTERM", "SIGKILL", "deadline"] as const) {
  void test(`actual ticket client ${signal} drains a resistant adapter descendant with ${mode} stdio before scope release${reuse === "sequential" ? " (sequential)" : ""}`, { skip: process.platform !== "darwin" && process.platform !== "linux", timeout: 30_000 }, async (t) => {
    const cwd = repo();
    const fixture = join(cwd, "adapter.cjs");
    const leaderFile = join(cwd, "leader.json"), descendantFile = join(cwd, "descendant.json");
    writeFileSync(fixture, `
const fs=require("node:fs"),cp=require("node:child_process");
const group=Number(cp.execFileSync("ps",["-o","pgid=","-p",String(process.pid)],{encoding:"utf8"}).trim());
if(process.argv[2]==="descendant") { process.on("SIGTERM",()=>{}); fs.writeFileSync(${JSON.stringify(descendantFile)},JSON.stringify({pid:process.pid,group})); }
else { fs.writeFileSync(${JSON.stringify(leaderFile)},JSON.stringify({pid:process.pid,group})); cp.spawn(process.execPath,[__filename,"descendant"],{stdio:${JSON.stringify(mode)}}); }
setInterval(()=>{},1000);
`);
    const controller = new AbortController();
    const ownership = new WorkflowOwnership(cwd, "ticket-run", "session", controller.signal, executeShellCommand);
    let client: ChildProcess | undefined;
    let clientClosed: Promise<void> | undefined;
    const execution = runWorkflow(`return await withWorktreeLease(args.cwd, async lease => { const ticket = await lease.command(args.command, {timeoutMs:args.timeout,...(args.reuse === "sequential" ? {reuse:args.reuse} : {})}); return await agent(ticket); });`, { cwd, reuse, timeout: signal === "deadline" ? 1000 : 20000, command: `exec ${quote(process.execPath)} ${quote(fixture)}` }, ownership.decorate({
      agent: async (command) => new Promise((resolve, reject) => {
        client = spawn("/bin/sh", ["-c", command], { stdio: ["ignore", "pipe", "pipe"] });
        const launched = client;
        clientClosed = new Promise((done) => launched.once("close", () => { done(); }));
        launched.stdout?.resume(); launched.stderr?.resume();
        launched.once("error", reject);
        launched.once("close", (exitCode) => { resolve({ exitCode }); });
      }),
    }), controller.signal);
    void execution.result.catch(() => undefined);
    try {
      await until(() => existsSync(descendantFile), "actual adapter descendant must be ready");
      const owned = JSON.parse(readFileSync(leaderFile, "utf8")) as { pid: number; group: number };
      const descendant = JSON.parse(readFileSync(descendantFile, "utf8")) as { pid: number; group: number };
      assert.equal(owned.group, descendant.group);
      assert.ok(processes().some((p) => p.pid === descendant.pid && p.group === owned.group && p.args.includes(fixture)), "fresh argv and PGID authorize owned process assertions");
      const launched = client;
      assert.ok(launched?.pid);
      assert.ok(processes().some((p) => p.pid === launched.pid && p.args.includes("/pi-lt-") && p.args.includes("/client.cjs")), "fresh ChildProcess must be the exec-replaced ticket client");
      if (signal !== "deadline") launched.kill(signal);
      await assert.rejects(Promise.race([execution.result, pause(6000).then(() => { throw new Error("ticket cancellation waited for its long deadline"); })]), signal === "deadline" ? /timed out/ : /client disconnected/);
      assert.deepEqual(processes().filter((p) => p.group === owned.group && !p.state.startsWith("Z")), [], "group must be quiescent before settlement");
      assert.equal(existsSync(await physicalOwnerDirectory(cwd)), false);
      t.diagnostic(JSON.stringify({ client: launched.pid, group: owned.group, descendant: descendant.pid, quiescentBeforeRelease: true }));
    } finally {
      controller.abort();
      const launched = client;
      if (launched && launched.exitCode === null && launched.signalCode === null && processes().some((p) => p.pid === launched.pid && p.args.includes("/client.cjs"))) launched.kill("SIGKILL");
      for (const group of new Set(processes().filter((p) => p.args.includes(fixture) && !p.state.startsWith("Z")).map((p) => p.group))) {
        try { process.kill(-group, "SIGKILL"); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); }
      }
      await until(() => !processes().some((p) => p.args.includes(fixture) && !p.state.startsWith("Z")), "fixture cleanup must complete");
      await execution.result.catch(() => undefined);
      await clientClosed;
      rmSync(cwd, { recursive: true, force: true });
    }
  });
}

void test("ticket scope closure invalidates original and copied private ticket material", { timeout: 30_000 }, async () => {
  const cwd = repo();
  const controller = new AbortController();
  const ownership = new WorkflowOwnership(cwd, "stale", "session", controller.signal, executeShellCommand);
  const marker = join(cwd, "forbidden");
  const copy = join(cwd, "copy.json");
  try {
    const reference = await ownership.enter(cwd, undefined, controller.signal);
    const command = await ownership.command(reference.scope, `touch ${quote(marker)}`, { timeoutMs: 1000 });
    const ticketFile = /'([^']+ticket-\d+\.json)'$/.exec(command)?.[1];
    assert.ok(ticketFile);
    writeFileSync(copy, readFileSync(ticketFile));
    await ownership.leave(reference.scope);
    await ownership.finalize();
    for (const stale of [command, command.replace(ticketFile, copy)]) {
      const child = spawn("/bin/sh", ["-c", stale], { stdio: "ignore" });
      const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
      assert.notEqual(code, 0);
    }
    assert.equal(existsSync(marker), false);
  } finally { controller.abort(); rmSync(cwd, { recursive: true, force: true }); }
});

void test("cleanup uncertainty is sticky above cancellation and retains physical ownership after late cleanup", { timeout: 30_000 }, async () => {
  const cwd = repo();
  const fixture = join(cwd, "uncertain.cjs"), leaderFile = join(cwd, "leader.json"), resultFile = join(cwd, "result.json"), cancelFile = join(cwd, "cancel");
  writeFileSync(fixture, `const fs=require("node:fs"),cp=require("node:child_process"); process.on("SIGTERM",()=>{}); fs.writeFileSync(${JSON.stringify(leaderFile)},JSON.stringify({pid:process.pid,parent:process.ppid,group:Number(cp.execFileSync("ps",["-o","pgid=","-p",String(process.pid)],{encoding:"utf8"}).trim())})); setInterval(()=>{},1000);`);
  const hostFile = join(cwd, "host.mjs");
  writeFileSync(hostFile, `
import fs from "node:fs";
import {WorkflowOwnership} from ${JSON.stringify(new URL("../src/ownership.js", import.meta.url).href)};
import {runWorkflow,executeShellCommand} from ${JSON.stringify(new URL("../src/execution.js", import.meta.url).href)};
const controller=new AbortController();
const poll=setInterval(()=>{if(fs.existsSync(${JSON.stringify(cancelFile)}))controller.abort()},10);
const ownership=new WorkflowOwnership(${JSON.stringify(cwd)},"uncertain","s",controller.signal,executeShellCommand);
const execution=runWorkflow('try { await withWorktreeLease(args.cwd, async lease => { try { await lease.shell(args.command); } catch {} return "PASS"; }); } catch {} return "PASS";',${JSON.stringify({ cwd, command: `exec ${quote(process.execPath)} ${quote(fixture)}` })},ownership.decorate({}),controller.signal);
try { const value=await execution.result; fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({value})); }
catch(error) { fs.writeFileSync(${JSON.stringify(resultFile)},JSON.stringify({code:error.code,cleanupUnproven:error.cleanupUnproven,message:error.message})); }
finally { clearInterval(poll); }
`);
  const host = spawn(process.execPath, [hostFile], { stdio: "ignore" });
  const closed = new Promise<void>((resolve) => host.once("close", () => { resolve(); }));
  let helper: ReturnType<typeof processes>[number] | undefined;
  try {
    await until(() => existsSync(leaderFile), "uncertain command ready");
    const leader = JSON.parse(readFileSync(leaderFile, "utf8")) as { pid: number; parent: number; group: number };
    helper = processes().find((p) => p.pid === leader.parent && p.args.includes("/pi-owned-") && p.args.includes("/supervisor.cjs"));
    assert.ok(helper);
    assert.ok(processes().some((p) => p.pid === host.pid && p.args.includes(hostFile)));
    process.kill(helper.pid, "SIGSTOP");
    writeFileSync(cancelFile, "cancel");
    await until(() => existsSync(resultFile), "host must report uncertainty", 12_000);
    const result = JSON.parse(readFileSync(resultFile, "utf8")) as { cleanupUnproven?: boolean; code?: string };
    assert.equal(result.cleanupUnproven, true);
    assert.equal(result.code, "SHELL_FAILED");
    assert.equal(existsSync(join(await physicalOwnerDirectory(cwd), "owner.json")), true);
    const current = helper;
    process.kill(current.pid, "SIGCONT");
    await until(() => !processes().some((p) => (p.group === leader.group || p.pid === current.pid && p.args === current.args) && !p.state.startsWith("Z")), "late supervisor cleanup must actually finish");
    assert.equal(existsSync(join(await physicalOwnerDirectory(cwd), "owner.json")), true, "late cleanup must not clear physical retention");
    await closed;
  } finally {
    const current = helper;
    if (current && processes().some((p) => p.pid === current.pid && p.args === current.args && !p.state.startsWith("Z"))) process.kill(current.pid, "SIGCONT");
    for (const group of new Set(processes().filter((p) => p.args.includes(fixture) && !p.state.startsWith("Z")).map((p) => p.group))) { try { process.kill(-group, "SIGKILL"); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); } }
    if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await closed;
    await until(() => !processes().some((p) => p.args.includes(fixture) && !p.state.startsWith("Z")), "uncertain fixture cleanup");
    rmSync(cwd, { recursive: true, force: true });
  }
});

void test("host SIGKILL drains ticket command groups and leaves stale physical ownership", { timeout: 30_000 }, async () => {
  const cwd = repo(), fixture = join(cwd, "hard-death.cjs"), ready = join(cwd, "ready.json"), receipt = join(cwd, "receipt");
  writeFileSync(fixture, `const fs=require("node:fs"),cp=require("node:child_process"); process.on("SIGTERM",()=>{}); const group=Number(cp.execFileSync("ps",["-o","pgid=","-p",String(process.pid)],{encoding:"utf8"}).trim()); fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,parent:process.ppid,group})); setInterval(()=>{},1000);`);
  const hostFile = join(cwd, "ticket-host.mjs");
  writeFileSync(hostFile, `
import fs from "node:fs"; import {spawn} from "node:child_process";
import {WorkflowOwnership} from ${JSON.stringify(new URL("../src/ownership.js", import.meta.url).href)};
import {runWorkflow,executeShellCommand} from ${JSON.stringify(new URL("../src/execution.js", import.meta.url).href)};
const ownership=new WorkflowOwnership(${JSON.stringify(cwd)},"hard-death","s",new AbortController().signal,executeShellCommand);
const bridge=ownership.decorate({agent: async command => new Promise((resolve,reject)=>{ const client=spawn("/bin/sh",["-c",command],{stdio:"ignore"}); client.once("error",reject); client.once("close",exitCode=>resolve({exitCode})); })});
await runWorkflow('return await withWorktreeLease(args.cwd, async lease => await agent(await lease.command(args.command,{timeoutMs:20000})));',${JSON.stringify({ cwd, command: `exec ${quote(process.execPath)} ${quote(fixture)}` })},bridge).result;
fs.writeFileSync(${JSON.stringify(receipt)},"PASS");
`);
  const host = spawn(process.execPath, [hostFile], { stdio: "ignore" });
  const closed = new Promise<void>((resolve) => host.once("close", () => { resolve(); }));
  try {
    await until(() => existsSync(ready), "ticket adapter must be ready");
    const owned = JSON.parse(readFileSync(ready, "utf8")) as { pid: number; parent: number; group: number };
    assert.ok(processes().some((p) => p.pid === owned.pid && p.group === owned.group && p.args.includes(fixture)));
    const ownerFile = join(await physicalOwnerDirectory(cwd), "owner.json");
    const ownerBefore = readFileSync(ownerFile, "utf8");
    host.kill("SIGKILL"); await closed;
    await until(() => !processes().some((p) => p.group === owned.group && !p.state.startsWith("Z")), "independent supervisor must drain after host death");
    assert.equal(existsSync(receipt), false);
    assert.equal(readFileSync(ownerFile, "utf8"), ownerBefore);
    const { PhysicalWorktreeLease, worktreeLeaseIdentity } = await import("../src/worktree-lease.js");
    await assert.rejects(PhysicalWorktreeLease.acquire(await worktreeLeaseIdentity(cwd), {runId:"next",sessionId:"s",executionId:"next"}), /physical owner/);
  } finally {
    if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
    await closed;
    for (const group of new Set(processes().filter((p) => p.args.includes(fixture) && !p.state.startsWith("Z")).map((p) => p.group))) { try { process.kill(-group, "SIGKILL"); } catch (error) { assert.equal((error as NodeJS.ErrnoException).code, "ESRCH"); } }
    await until(() => !processes().some((p) => p.args.includes(fixture) && !p.state.startsWith("Z")), "host death fixture cleanup");
    rmSync(cwd, { recursive: true, force: true });
  }
});

void test("sequential ticket reuses only its fixed binding after quiescence with fresh execution identities", { timeout: 20_000 }, async () => {
  const { LeaseCommandBroker } = await import("../src/lease-command.js");
  const { createConnection } = await import("node:net");
  const cwd = repo(), marker = join(cwd, "runs");
  const controller = new AbortController();
  const failures: Error[] = [];
  const broker = await LeaseCommandBroker.create(cwd, controller.signal, (work) => work(), (error) => { failures.push(error); });
  const options = { timeoutMs: 3000, reuse: "sequential" } as const;
  try {
    const command = await broker.ticket(`printf run >> ${quote(marker)}; sleep 0.15; printf done`, options);
    const ticketFile = /'([^']+ticket-\d+\.json)'$/.exec(command)?.[1]; assert.ok(ticketFile);
    const ticket = JSON.parse(readFileSync(ticketFile, "utf8")) as { socket: string; id: string; secret: string };
    const request = () => new Promise<{ executionId?: string; exitCode?: number }>((resolve, reject) => {
      const socket = createConnection(ticket.socket); let text = "";
      socket.on("connect", () => { socket.write(`${JSON.stringify({ id: ticket.id, secret: ticket.secret })}\n`); });
      socket.on("data", (chunk: Buffer) => { text += chunk.toString(); });
      socket.once("error", reject);
      socket.once("close", () => {
        const result = text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as { type?: string; executionId?: string; exitCode?: number }).find((message) => message.type === "result");
        resolve(result ?? {});
      });
    });
    const first = request();
    await until(() => existsSync(marker), "first adapter entered");
    assert.deepEqual(await request(), {}, "concurrent socket must be refused without cancelling the admitted adapter");
    const one = await first;
    assert.equal(one.exitCode, 0);
    const child = spawn("/bin/sh", ["-c", command], { stdio: "ignore" });
    const code = await new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    assert.equal(code, 0, "the same actual client launcher must run sequentially twice");
    const again = spawn("/bin/sh", ["-c", command], { stdio: "ignore" });
    assert.equal(await new Promise((resolve) => again.once("close", resolve)), 0);
    const three = await request();
    assert.equal(three.exitCode, 0);
    assert.equal(typeof one.executionId, "string"); assert.equal(typeof three.executionId, "string");
    assert.notEqual(one.executionId, three.executionId);
    assert.equal(readFileSync(marker, "utf8"), "runrunrunrun");
    assert.deepEqual(failures, []);
    const critic = await broker.ticket("printf critic", options);
    const criticChild = spawn("/bin/sh", ["-c", critic], { stdio: "ignore" });
    assert.equal(await new Promise((resolve) => criticChild.once("close", resolve)), 0);
  } finally { controller.abort(); await broker.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});

void test("sequential bindings preserve product nonzero but reject replacement protocol and authenticated material changes", { timeout: 15_000 }, async () => {
  const { LeaseCommandBroker } = await import("../src/lease-command.js");
  const { createConnection } = await import("node:net");
  const { validateShellOptions } = await import("../src/validation.js");
  const cwd = repo(), marker = join(cwd, "runs");
  const broker = await LeaseCommandBroker.create(cwd, new AbortController().signal, (work) => work(), () => undefined);
  const execute = (command: string) => new Promise<number | null>((resolve, reject) => { const child = spawn("/bin/sh", ["-c", command], { stdio: "ignore" }); child.once("error", reject); child.once("close", resolve); });
  try {
    assert.throws(() => validateShellOptions({ timeoutMs: 1000, reuse: "sequential" }), /Unknown|Unsupported|only|option/);
    const command = await broker.ticket(`printf run >> ${quote(marker)}; exit 7`, { timeoutMs: 1000, reuse: "sequential", env: { PRIVATE_FIXTURE_VALUE: "private-fixture-value" } });
    assert.equal(command.includes("private-fixture-value"), false);
    const file = /'([^']+ticket-\d+\.json)'$/.exec(command)?.[1]; assert.ok(file);
    const material = readFileSync(file, "utf8"), ticket = JSON.parse(material) as { socket: string; id: string; secret: string };
    assert.equal(command.includes(ticket.secret), false);
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection(ticket.socket); socket.once("error", reject);
      socket.on("connect", () => { socket.write(`${JSON.stringify({ id: ticket.id, secret: ticket.secret, command: "touch forbidden" })}\n`); });
      socket.on("data", () => assert.fail("replacement protocol must not produce a result")); socket.once("close", resolve);
    });
    assert.equal(existsSync(marker), false);
    writeFileSync(file, `${material} `);
    assert.notEqual(await execute(command), 0);
    assert.equal(existsSync(marker), false);
    writeFileSync(file, material);
    const clientFile = join(broker.directory, "client.cjs"), client = readFileSync(clientFile, "utf8");
    writeFileSync(clientFile, "process.exit(0)");
    assert.notEqual(await execute(command), 0, "a tampered client cannot fabricate a passing process exit");
    assert.equal(existsSync(marker), false);
    writeFileSync(clientFile, client);
    assert.equal(await execute(command), 7); assert.equal(await execute(command), 7);
    assert.equal(readFileSync(marker, "utf8"), "runrun");
    const once = await broker.ticket("exit 0", { timeoutMs: 1000 });
    assert.equal(await execute(once), 0); assert.notEqual(await execute(once), 0);
  } finally { await broker.dispose(); rmSync(cwd, { recursive: true, force: true }); }
});

void test("infrastructure-failed sequential binding refuses later executions and callback PASS cannot clear taint", { timeout: 15_000 }, async () => {
  const cwd = repo(), marker = join(cwd, "runs");
  const controller = new AbortController();
  const ownership = new WorkflowOwnership(cwd, "failed-reuse", "s", controller.signal, executeShellCommand);
  const reference = await ownership.enter(cwd, undefined, controller.signal);
  const execute = (command: string) => new Promise<number | null>((resolve, reject) => { const child = spawn("/bin/sh", ["-c", command], { stdio: "ignore" }); child.once("error", reject); child.once("close", resolve); });
  try {
    const command = await ownership.command(reference.scope, `printf run >> ${quote(marker)}; kill -KILL $$`, { timeoutMs: 1000, reuse: "sequential" });
    assert.notEqual(await execute(command), 0);
    assert.notEqual(await execute(command), 0);
    assert.equal(readFileSync(marker, "utf8"), "run");
    await assert.rejects(ownership.command(reference.scope, "printf forbidden", { timeoutMs: 1000, reuse: "sequential" }), /signal/);
    await assert.rejects(ownership.leave(reference.scope), /signal/);
    await assert.rejects(ownership.finalize(), /signal/);
  } finally { controller.abort(); await ownership.finalize().catch(() => undefined); rmSync(cwd, { recursive: true, force: true }); }
});
