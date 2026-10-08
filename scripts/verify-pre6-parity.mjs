import assert from "node:assert/strict";
import console from "node:console";
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath, pathToFileURL } from "node:url";

// Pre6 parity regressions through installed local tarballs, real Pi/piewf CLIs and the default local transport.
// A local OpenAI-compatible SSE provider records the model, tools and system prompt of every request.
// Never obtain products from npm. Old (pre6) tarballs are optional controls.
const usage = "Usage: PI_OFFLINE=1 node scripts/verify-pre6-parity.mjs <new-tarball-directory> [--old <pre6-tarball-directory>] [--legacy <pre-freeze-6.x-tarball-directory>] [--only <case,...>] [--report <path>] [--inject-old-failure <case>]";
const argv = process.argv.slice(2);
assert.ok(argv[0] && !argv[0].startsWith("--"), usage);
const option = (name) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
const only = option("--only")?.split(",");
const report = option("--report");
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const work = mkdtempSync(join(tmpdir(), "piewf-pre6-parity-"));

function tarballs(directory, prefixes) {
  const packed = readdirSync(directory);
  return prefixes.map((prefix) => {
    const matches = packed.filter((name) => name.startsWith(prefix) && name.endsWith(".tgz"));
    assert.equal(matches.length, 1, `Expected one local ${prefix} tarball in ${directory}`);
    return join(directory, matches[0]);
  });
}
function put(path, content) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content); }
function json(path, content) { put(path, JSON.stringify(content)); }
function readJson(path) { return JSON.parse(readFileSync(path, "utf8")); }
function text(content) { return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => part.text ?? "").join("") : content == null ? "" : JSON.stringify(content); }

// ---- Scripted provider -------------------------------------------------------------------------
// Prompts carry STEPS:<base64url json>:END. The spec lists tool calls to issue in order, then the
// final workflow_result (when offered) or plain text. failAt/killAt inject one-shot faults by key.
const consumed = new Set();
const requests = [];
let killTarget;
function steps(who, spec = {}) { return `${who} STEPS:${Buffer.from(JSON.stringify({ who, ...spec })).toString("base64url")}:END`; }
function specOf(payload) {
  const messages = payload.messages ?? [];
  const lastUser = messages.findLastIndex((message) => message.role === "user");
  const match = /STEPS:([A-Za-z0-9_-]+):END/.exec(text(messages[lastUser]?.content));
  return { lastUser, spec: match ? JSON.parse(Buffer.from(match[1], "base64url").toString()) : undefined };
}
const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const payload = JSON.parse(Buffer.concat(chunks).toString());
  const messages = payload.messages ?? [];
  const { lastUser, spec } = specOf(payload);
  const turn = messages.slice(lastUser + 1);
  const calls = turn.filter((message) => message.role === "assistant").flatMap((message) => message.tool_calls ?? []);
  const results = turn.filter((message) => message.role === "tool").map((message) => text(message.content));
  const tools = (payload.tools ?? []).map((tool) => tool.function?.name).sort();
  const system = messages.filter((message) => message.role === "system" || message.role === "developer").map((message) => text(message.content)).join("\n");
  requests.push({ who: spec?.who ?? "none", step: calls.length, model: payload.model, effort: payload.reasoning_effort ?? null, tools, system, user: text(messages[lastUser]?.content), results, payload });
  const fault = (name) => spec?.[name] && spec[name].step === calls.length && !consumed.has(spec[name].key) && consumed.add(spec[name].key);
  if (fault("killAt")) { const child = killTarget; killTarget = undefined; child?.kill("SIGKILL"); response.destroy(); return; }
  if (fault("failAt")) { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { message: "e2e deliberate failure", type: "invalid_request_error" } })); return; }
  const lastId = [...results].reverse().map((value) => /"id"\s*:\s*"([^"]+)"/.exec(value)?.[1]).find(Boolean);
  const fill = (value) => JSON.parse(JSON.stringify(value ?? {}).replaceAll("$id", lastId ?? "missing-id"));
  const step = spec?.steps?.[calls.length];
  let delta, finish = "tool_calls";
  const call = (name, args) => ({ role: "assistant", tool_calls: [{ index: 0, id: `e2e-${String(requests.length)}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] });
  if (step) delta = call(step.tool, fill(step.args));
  else if (tools.includes("workflow_result") && !calls.some((value) => value.function.name === "workflow_result")) delta = call("workflow_result", { result: spec?.result === "$results" ? results.join("\n") : spec?.result ?? `${spec?.who ?? "agent"}-ok` });
  else { delta = { role: "assistant", content: spec?.text ?? "done" }; finish = "stop"; }
  const chunk = (value, finish_reason = null) => `data: ${JSON.stringify({ id: "e2e", object: "chat.completion.chunk", created: 0, model: payload.model, choices: [{ index: 0, delta: value, finish_reason }] })}\n\n`;
  response.writeHead(200, { "content-type": "text/event-stream" });
  response.end(chunk(delta) + chunk({}, finish) + "data: [DONE]\n\n");
});
function since(before, who) { return requests.slice(before).filter((value) => who === undefined || value.who === who); }

// ---- Products, fixtures and entry points -------------------------------------------------------
function command(executable, args, { cwd, env = {}, timeout = 120000, interruptible = false, input } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(executable, args, { cwd, env: { ...process.env, HOME: work, PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0", NO_COLOR: "1", ...env }, stdio: [input?.start ? "pipe" : "ignore", "pipe", "pipe"] });
    if (interruptible) killTarget = child;
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value) => { stdout += value; input?.onStdout?.(child, value, stdout); });
    child.stderr.setEncoding("utf8").on("data", (value) => { stderr += value; });
    const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeout);
    child.on("error", reject);
    child.on("close", (code, signal) => { clearTimeout(timer); accept({ code, signal, stdout, stderr }); });
    input?.start?.(child);
  });
}
async function installProduct(kind, directory) {
  const prefixes = kind === "new" ? ["pi-extensible-workflows-", "piewf-cli-", "piewf-pi-ext-roles-"] : ["pi-extensible-workflows-", "piewf-cli-"];
  const install = join(work, `install-${kind}`);
  mkdirSync(install);
  const installed = await command("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--omit=dev", "--no-audit", "--no-fund", ...tarballs(directory, prefixes)], { cwd: install, timeout: 300000 });
  assert.equal(installed.code, 0, installed.stderr);
  const modules = join(install, "node_modules"), core = join(modules, "pi-extensible-workflows");
  const persistence = await import(pathToFileURL(join(core, "dist/src/persistence.js")).href);
  const view = await import(pathToFileURL(join(core, "dist/src/host-view.js")).href);
  const pi = join(modules, "@earendil-works/pi-coding-agent", readJson(join(modules, "@earendil-works/pi-coding-agent/package.json")).bin.pi);
  return { kind, install, modules, core, cli: join(modules, "@piewf/cli/dist/src/cli.js"), pi, roles: kind === "new" ? join(modules, "@piewf/pi-ext-roles") : undefined, persistence, view,
    // Each version's supported role/shared-settings namespace.
    namespace: kind === "new" ? "pi-ext-roles" : "pi-extensible-workflows" };
}
let fixtures = 0;
function fixture(p, { roles = true, trusted = false, git = false, extensions = [] } = {}) {
  const directory = join(work, `case-${String(++fixtures)}`), agentDir = join(directory, "agent"), cwd = join(directory, "project"), sessions = join(directory, "sessions");
  mkdirSync(cwd, { recursive: true });
  const paths = [join(p.core, "dist/src/index.js"), join(p.core, "dist/starter/index.js"), join(p.core, "dist/subagents/index.js"), ...(roles && p.roles ? [join(p.roles, "src/extension.ts")] : []), ...extensions];
  json(join(agentDir, "settings.json"), { extensions: paths, defaultProvider: "e2e", defaultModel: "root", defaultThinkingLevel: "off", defaultProjectTrust: trusted ? "always" : "never", retry: { enabled: false }, compaction: { enabled: false }, cacheWarming: "off" });
  const model = (id) => ({ id, name: id, reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
  json(join(agentDir, "models.json"), { providers: { e2e: { api: "openai-completions", apiKey: "fixture", baseUrl, models: ["root", "role", "call", "alt"].map(model) }, keyless: { api: "openai-completions", baseUrl, models: [model("other")] } } });
  json(join(agentDir, "auth.json"), {});
  put(join(agentDir, "AGENTS.md"), "GLOBAL_AGENTS"); put(join(directory, "AGENTS.md"), "PROJECT_AGENTS"); put(join(cwd, "AGENTS.md"), "CWD_AGENTS");
  put(join(agentDir, "APPEND_SYSTEM.md"), "EXISTING_APPEND");
  if (git) {
    put(join(cwd, ".gitignore"), ".pi/\n");
    const gitCommand = (...args) => execFileSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, stdio: "pipe" });
    gitCommand("init", "-q", "-b", "main"); gitCommand("add", "."); gitCommand("commit", "-q", "-m", "fixture");
  }
  const env = { PI_CODING_AGENT_DIR: agentDir };
  const extend = (...extra) => { const settings = readJson(join(agentDir, "settings.json")); settings.extensions.push(...extra); json(join(agentDir, "settings.json"), settings); };
  return { p, directory, agentDir, cwd, sessions, env, extend, role: (name, body, scope = agentDir) => put(join(scope === agentDir ? agentDir : join(scope, ".pi"), p.namespace, "roles", `${name}.md`), body) };
}
let scripts = 0;
async function piewf(f, script, { approve = false, interruptible = false, args = [] } = {}) {
  const path = join(f.directory, `workflow-${String(++scripts)}.js`);
  put(path, script);
  return command(process.execPath, [injecting ? join(f.p.install, "injected-missing-cli.js") : f.p.cli, "run", "--script", path, "--name", "e2e", ...(approve ? ["--approve"] : []), ...args], { cwd: f.cwd, env: f.env, interruptible });
}
function events(stdout) { return stdout.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }); }
function toolEnds(stdout, name) { return events(stdout).filter((event) => event.type === "tool_execution_end" && (name === undefined || event.toolName === name)); }
function resultText(end) { return text(end?.result?.content); }
// Real Pi CLI in JSON print mode. The root model follows STEPS, so the root session invokes extension tools itself.
async function pi(f, prompt, { session, resume = false, approve = false, interruptible = false, onEvent } = {}) {
  const sessionArgs = session === undefined ? ["--no-session"] : ["--session-dir", f.sessions, resume ? "--session" : "--session-id", session];
  let pending = "";
  const input = onEvent && { onStdout(_child, chunk) { pending += chunk; const lines = pending.split("\n"); pending = lines.pop() ?? ""; for (const event of events(lines.join("\n"))) onEvent(event); } };
  return command(process.execPath, [injecting ? join(f.p.install, "injected-missing-pi.js") : f.p.pi, "--print", "--mode", "json", "--offline", ...sessionArgs, ...(approve ? ["--approve"] : []), prompt], { cwd: f.cwd, env: f.env, interruptible, ...(input ? { input } : {}) });
}
function rootCalls(...calls) { return steps("root", { steps: calls.map(([tool, args]) => ({ tool, args })) }); }
// Interrupted runs resume only from the interactive picker. Pi RPC cannot answer dialogs raised during
// startup session_start (its stdin reader attaches afterwards), so drive the real TUI through a pty
// (util-linux `script`): pick this run, wait for a terminal persisted state, then quit.
function quoted(value) { return `'${value.replaceAll("'", "'\\''")}'`; }
async function piResume(f, session, runId, isTerminal, workflowName = "cold") {
  const label = `Resume: ${workflowName} (${runId.slice(0, 8)})`;
  let answered = false, done = false, poll;
  const escape = String.fromCharCode(27), bell = String.fromCharCode(7);
  const plain = (value) => value.replace(new RegExp(`${escape}\\[[0-9;?]*[A-Za-z]|${escape}\\][^${bell}]*${bell}|${escape}[()][A-Z0-9]`, "g"), "");
  const tui = `stty cols 160 rows 50; exec ${quoted(process.execPath)} ${quoted(f.p.pi)} --offline --session-dir ${quoted(f.sessions)} --session ${quoted(session)}`;
  const result = await command("script", ["-q", "-f", "-c", tui, "/dev/null"], { cwd: f.cwd, env: { ...f.env, TERM: "xterm-256color" }, timeout: 120000, input: {
    start(child) {
      const tick = async () => {
        if (done) return;
        if (answered && await isTerminal()) { done = true; child.stdin.write("\x03"); setTimeout(() => { child.stdin.write("\x03"); setTimeout(() => { child.stdin.end(); }, 500); }, 500); return; }
        poll = setTimeout(() => { void tick(); }, 200);
      };
      child.on("close", () => { done = true; clearTimeout(poll); });
      void tick();
    },
    onStdout(child, _chunk, all) { if (!answered && new RegExp(`→ ${label.replace(/[()]/g, "\\$&")}`).test(plain(all))) { answered = true; child.stdin.write("\r"); } },
  } });
  return { ...result, answered, screen: plain(result.stdout) };
}
async function runsOf(f, session) {
  const { listPersistedSessionIds, listRunIds, RunStore } = f.p.persistence;
  const sessionIds = session === undefined ? await listPersistedSessionIds(f.cwd, work) : [session];
  const loaded = [];
  for (const sessionId of sessionIds) for (const runId of await listRunIds(f.cwd, sessionId, work)) { const store = new RunStore(f.cwd, sessionId, runId, work); loaded.push({ sessionId, runId, directory: store.directory, ...(await store.load()) }); }
  return loaded;
}
function observer(f) {
  const path = join(f.directory, "session-start.jsonl"), module = join(f.agentDir, "observer.mjs");
  put(module, `import {appendFileSync} from 'node:fs';export default function(pi){pi.on('session_start',(event,ctx)=>{appendFileSync(${JSON.stringify(path)},JSON.stringify({child:pi.getAllTools().some(tool=>tool.name==='workflow_result'),cwd:ctx.cwd,settings:event.settings??null})+'\\n');});}`);
  f.extend(module);
  return () => existsSync(path) ? readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];
}
function registryUrl(p) { return JSON.stringify(pathToFileURL(join(p.core, "dist/src/registry.js")).href); }
// Nested agents need an `agent` capability in the root ceiling; parents then select it explicitly.
function agentCapability(f) {
  const module = join(f.agentDir, "agent-capability.mjs");
  put(module, `import {Type} from ${JSON.stringify(pathToFileURL(join(f.p.modules, "@earendil-works/pi-ai/dist/index.js")).href)};export default function(pi){pi.registerTool({name:'agent',label:'Agent capability',description:'Root capability',parameters:Type.Object({}),execute:async()=>({content:[],details:{}})});}`);
  f.extend(module);
}

// ---- Case runner -------------------------------------------------------------------------------
// `old` describes the pre6 control: "none" skips it; "same" runs it, and every check must pass. Scenarios with a known
// pre6 difference assert pre6's actual behavior (exit status, diagnostics, requests, tools) affirmatively for the old
// product, so an unrelated failure can never pass as an expected difference.
// --inject-old-failure <case> replaces that case's pre6 CLI entry points with a missing file, proving such failures exit 1.
const results = [];
const cases = [];
const injectOldFailure = option("--inject-old-failure");
let injecting = false;
function scenario(name, concern, { old = "none" } = {}, body) { cases.push({ name, concern, old, body }); }
async function execute(product, item) {
  if (only && !only.includes(item.name)) return;
  const failures = [], notes = [];
  injecting = product.kind === "old" && item.name === injectOldFailure;
  const t = {
    check(condition, message, detail) { if (!condition) failures.push(detail === undefined ? message : `${message}: ${typeof detail === "string" ? detail.slice(0, 600) : JSON.stringify(detail).slice(0, 600)}`); return Boolean(condition); },
    note(message) { notes.push(message); },
  };
  const started = Date.now();
  try { await item.body(product, t); } catch (error) { failures.push(`threw: ${error instanceof Error ? error.stack ?? error.message : String(error)}`.slice(0, 1200)); }
  injecting = false;
  const outcome = failures.length ? (product.kind === "old" ? "deviated" : "fail") : "pass";
  const result = { case: item.name, concern: item.concern, product: product.kind, outcome, expected: "pass", ms: Date.now() - started, failures, notes };
  results.push(result);
  console.log(`${outcome === "pass" ? "PASS" : "FAIL"} [${product.kind}] ${item.name}${product.kind === "old" ? " (pre6 control)" : ""}`);
  for (const failure of failures) console.log(`  - ${failure}`);
  for (const value of notes) console.log(`  * ${value}`);
}

// ---- Audited outcomes --------------------------------------------------------------------------
scenario("cli-unrelated-extension-failure", "cliExtensionFailure", { old: "same" }, async (p, t) => {
  for (const kind of ["throw", "syntax"]) {
    const f = fixture(p, { roles: false });
    put(join(f.agentDir, "extensions/broken.ts"), kind === "syntax" ? "export default function ( {" : "export default function () { throw new Error('E2E_UNRELATED_EXTENSION_FAILURE'); }");
    const ok = await piewf(f, "return 'e2e-unaffected';");
    t.check(ok.code === 0 && /e2e-unaffected/.test(ok.stdout), `${kind}: unrelated broken global extension must not block piewf run`, ok.stderr);
    // Pre6 ignored the failure silently; the warning is an intentional addition.
    if (p.kind === "new") t.check(/broken\.ts/.test(ok.stderr), `${kind}: load failure remains visible as a warning`, ok.stderr);
    const missing = await piewf(f, "return await e2eMissingFunction();");
    t.check(missing.code !== 0 && /e2eMissingFunction is not defined/.test(missing.stderr), `${kind}: a workflow needing missing capability fails with its own error`, missing.stderr);
  }
});

// A configured roles plugin that fails to load must not leave `role` silently ignored with lost restrictions.
scenario("cli-required-plugin-failure", "cliExtensionFailure", { old: "none" }, async (p, t) => {
  const auditor = "---\ndescription: Auditor\ntools: ['!*', read]\n---\nAUDITOR_ROLE";
  const script = (marker) => `await shell(${JSON.stringify(`printf side-effect > ${marker}`)}); return await agent(${JSON.stringify(steps("auditor"))}, {role:'auditor'});`;
  // The real roles plugin, copied beside the installed products so its imports resolve, made to fail at load.
  const broken = fixture(p, { roles: false });
  const copy = join(p.modules, "@piewf", `pi-ext-roles-broken-${String(fixtures)}`);
  execFileSync("cp", ["-R", p.roles, copy]);
  put(join(copy, "src/extension.ts"), `${readFileSync(join(copy, "src/extension.ts"), "utf8")}\nthrow new Error("E2E_ROLES_PLUGIN_LOAD_FAILURE");\n`);
  broken.extend(join(copy, "src/extension.ts"));
  broken.role("auditor", auditor);
  let marker = join(broken.cwd, "marker"), before = requests.length;
  const failed = await piewf(broken, script(marker));
  t.check(failed.code !== 0 && /E2E_ROLES_PLUGIN_LOAD_FAILURE/.test(failed.stderr) && /role has no owner proven to have loaded while extensions failed to load/.test(failed.stderr), "a failed configured roles plugin fails the role call closed with the load diagnostic", failed.stderr.slice(-500));
  t.check(requests.length === before && !existsSync(marker) && (await runsOf(broken)).length === 0, "no provider request, shell effect or run before the fail-closed rejection", { requests: requests.length - before, marker: existsSync(marker) });
  // The same plugin failing after it registered its hook: the orphaned registration must not count as an owner.
  const late = fixture(p, { roles: false });
  const lateCopy = join(p.modules, "@piewf", `pi-ext-roles-late-${String(fixtures)}`);
  execFileSync("cp", ["-R", p.roles, lateCopy]);
  const entry = readFileSync(join(lateCopy, "src/extension.ts"), "utf8");
  t.check(entry.includes("registerWorkflowRoles(api, registry, import.meta.url);"), "the packed roles entry registers with its source", entry.slice(-300));
  put(join(lateCopy, "src/extension.ts"), entry.replace("registerWorkflowRoles(api, registry, import.meta.url);", "registerWorkflowRoles(api, registry, import.meta.url);\n  throw new Error(\"E2E_ROLES_FAILED_AFTER_REGISTRATION\");"));
  late.extend(join(lateCopy, "src/extension.ts"));
  late.role("auditor", auditor);
  marker = join(late.cwd, "marker"); before = requests.length;
  const orphaned = await piewf(late, script(marker));
  t.check(orphaned.code !== 0 && /E2E_ROLES_FAILED_AFTER_REGISTRATION/.test(orphaned.stderr) && /these workflow registrations cannot be proven to come from a loaded extension: Pi roles/.test(orphaned.stderr), "a plugin that failed after registering its hook stops the CLI before anything runs", orphaned.stderr.slice(-500));
  t.check(requests.length === before && !existsSync(marker), "no provider request or shell effect after the orphaned registration", { requests: requests.length - before });
  // A generic policy that registers a declared hook, would initialize on session_start, then throws.
  const policy = fixture(p, { roles: false });
  put(join(policy.agentDir, "extensions/policy.js"), `import {registerWorkflowExtension} from ${registryUrl(p)};export default function(pi){let ready=false;pi.on('session_start',()=>{ready=true;});registerWorkflowExtension({version:'1.0.0',headline:'policy',source:import.meta.url,agentPreparationHooks:{policy:{optionsSchema:{type:'object',properties:{persona:{type:'string'}},additionalProperties:true},prepare(configuration,context){if(ready&&context.options.persona==='auditor')configuration.tools=['!*','read'];}}}});throw new Error('E2E_POLICY_FAILED_AFTER_REGISTRATION');}`);
  marker = join(policy.cwd, "marker"); before = requests.length;
  const policyRun = await piewf(policy, `await shell(${JSON.stringify(`printf side-effect > ${marker}`)}); return await agent(${JSON.stringify(steps("auditor"))}, {persona:'auditor'});`);
  t.check(policyRun.code !== 0 && /these workflow registrations cannot be proven to come from a loaded extension: policy/.test(policyRun.stderr) && requests.length === before && !existsSync(marker), "a generic policy failing after registration stops the CLI before anything runs", policyRun.stderr.slice(-400));
  // A working roles plugin beside an unrelated failure keeps enforcing the role.
  const healthy = fixture(p);
  put(join(healthy.agentDir, "extensions/broken.ts"), "export default function () { throw new Error('E2E_UNRELATED_EXTENSION_FAILURE'); }");
  healthy.role("auditor", auditor);
  marker = join(healthy.cwd, "marker"); before = requests.length;
  const restricted = await piewf(healthy, script(marker));
  const request = since(before, "auditor")[0];
  t.check(restricted.code === 0 && /broken\.ts/.test(restricted.stderr), "working roles plugin plus unrelated failure completes with a warning", restricted.stderr.slice(-400));
  t.check(JSON.stringify(request?.tools) === JSON.stringify(["read", "workflow_result"]) && /AUDITOR_ROLE/.test(request?.system ?? ""), "the role's restrictions and instructions still apply", request?.tools);
  // An intentionally absent roles plugin ignores `role`, as the core contract states.
  const absent = fixture(p, { roles: false });
  absent.role("auditor", auditor);
  marker = join(absent.cwd, "marker"); before = requests.length;
  const ignored = await piewf(absent, script(marker));
  const plain = since(before, "auditor")[0];
  t.check(ignored.code === 0 && !/Warning:/.test(ignored.stderr) && plain?.tools.includes("write") && !/AUDITOR_ROLE/.test(plain.system), "without the plugin and without load failures the role is ignored", plain?.tools);
});

// Every preparation failure of a statically complete call stops before effects; a hook that reads a dynamic option
// sees the same options whether the call passes a literal object or a variable.
scenario("static-unknown-role", "modelPreflight/preparationErrors", { old: "same" }, async (p, t) => {
  const f = fixture(p);
  const marker = join(f.cwd, "marker");
  const before = requests.length;
  const result = await piewf(f, `await shell(${JSON.stringify(`printf side-effect > ${marker}`)}); return await agent(${JSON.stringify(steps("unknown-role"))}, {role:'reviwer'});`);
  t.check(result.code !== 0 && /reviwer/.test(result.stderr), "an unknown static role fails", result.stderr.slice(-300));
  t.check(!existsSync(marker) && (await runsOf(f)).length === 0 && requests.length === before, "before shell effects, run persistence or provider requests");
  if (p.kind === "new") t.check(/metadata is invalid: Unknown agent role: reviwer|INVALID_METADATA/.test(result.stderr) && !/INTERNAL_ERROR/.test(result.stderr), "reported as invalid agent metadata with the role diagnostic", result.stderr.slice(-300));
});

scenario("dynamic-option-hook", "modelPreflight", { old: "none" }, async (p, t) => {
  const f = fixture(p, { roles: false });
  put(join(f.agentDir, "extensions/by-label.js"), `import {registerWorkflowExtension} from ${registryUrl(p)};export default function(){registerWorkflowExtension({version:'1.0.0',headline:'by label',agentPreparationHooks:{bylabel:{prepare(configuration,context){configuration.model=context.options.label==='cheap'?'e2e/call:off':'keyless/other:off';}}}});}`);
  for (const [form, script] of [["literal variable", `const label = 'cheap'; return await agent(${JSON.stringify(steps("by-label-direct"))}, {label});`], ["object variable", `const options = {label:'cheap'}; return await agent(${JSON.stringify(steps("by-label-object"))}, options);`]]) {
    const who = form === "literal variable" ? "by-label-direct" : "by-label-object";
    const before = requests.length;
    const result = await piewf(f, script);
    t.check(result.code === 0 && since(before, who).length === 1 && since(before, who)[0].model === "call", `${form}: the hook sees the actual label and the run completes with one request`, result.stderr.slice(-300));
  }
});

scenario("static-model-preflight", "modelPreflight", { old: "same" }, async (p, t) => {
  const cases = { unknown: "e2e/missing:off", invalidAlias: "nosuchalias", knownUnavailable: "keyless/other:off" };
  for (const [name, model] of Object.entries(cases)) {
    const f = fixture(p);
    const marker = join(f.cwd, "marker");
    const before = requests.length;
    const result = await piewf(f, `await shell(${JSON.stringify(`printf side-effect > ${marker}`)}); return await agent(${JSON.stringify(steps("preflight"))}, {model:${JSON.stringify(model)}});`);
    t.check(result.code !== 0 && /UNKNOWN_MODEL|unavailable model|Unknown model/i.test(result.stderr), `${name}: static invalid model fails`, result.stderr);
    t.check(!existsSync(marker), `${name}: shell side effect must not run before static model rejection`);
    t.check((await runsOf(f)).length === 0, `${name}: no run is persisted for a statically rejected script`);
    t.check(requests.length === before, `${name}: zero provider requests`);
  }
  if (p.kind === "new") {
    for (const plugin of [true, false]) {
      const f = fixture(p, { roles: plugin });
      json(join(f.agentDir, "pi-ext-roles/settings.json"), { modelAliases: { shared: "e2e/call:off" } });
      const before = requests.length;
      const result = await piewf(f, `return await agent(${JSON.stringify(steps("plugin-alias"))}, {model:'shared'});`);
      if (plugin) {
        t.check(result.code === 0 && /plugin-alias-ok/.test(result.stdout), "plugin-only shared alias passes static preflight", result.stderr);
        t.check(since(before, "plugin-alias")[0]?.model === "call", "plugin-only shared alias resolves its physical model", since(before).map((value) => value.model));
      } else t.check(result.code !== 0 && /UNKNOWN_MODEL|Unknown model/i.test(result.stderr) && requests.length === before, "without plugin the shared alias stays unknown", result.stderr);
    }
  }
});

scenario("nested-unknown-model-code", "nestedErrors", { old: "same" }, async (p, t) => {
  for (const plugin of p.kind === "new" ? [true, false] : [false]) {
    const f = fixture(p, { roles: plugin });
    const child = steps("child");
    const parent = steps("parent", { steps: [{ tool: "agent", args: { prompt: child, label: "child", model: "e2e/missing:off" } }, { tool: "get_subagent_result", args: { id: "$id" } }], result: "$results" });
    agentCapability(f);
    const result = await piewf(f, `return await agent(${JSON.stringify(parent)}, {label:'parent', tools:['agent']});`);
    t.check(result.code === 0, `plugin=${String(plugin)}: parent completes after collecting child failure`, result.stderr);
    t.check(/UNKNOWN_MODEL/.test(result.stdout) && !/AGENT_FAILED/.test(result.stdout), `plugin=${String(plugin)}: nested child failure keeps UNKNOWN_MODEL`, result.stdout);
  }
});

scenario("nested-scope-and-sibling-configurations", "nestedScope", { old: "same" }, async (p, t) => {
  for (const worktree of [false, true]) {
    const f = fixture(p, { git: worktree });
    const child = (label) => steps(label);
    const parent = steps("parent", { steps: [
      { tool: "agent", args: { prompt: child("sibling-alt"), label: "child", model: "e2e/alt:off" } }, { tool: "get_subagent_result", args: { id: "$id" } },
      { tool: "agent", args: { prompt: child("sibling-default"), label: "child" } }, { tool: "get_subagent_result", args: { id: "$id" } },
    ], result: "$results" });
    agentCapability(f);
    const inner = `parallel("branch",{left:()=>agent(${JSON.stringify(parent)},{label:"parent",tools:["agent"]})})`;
    const before = requests.length;
    const result = await piewf(f, worktree ? `return await withWorktree("wt", () => ${inner});` : `return await ${inner};`);
    t.check(result.code === 0, `worktree=${String(worktree)}: run completes`, result.stderr);
    t.check(since(before, "sibling-alt")[0]?.model === "alt" && since(before, "sibling-default")[0]?.model === "root", `worktree=${String(worktree)}: sibling children with the same label keep distinct configurations`, since(before).map(({ who, model }) => `${who}:${model}`));
    const [loaded] = await runsOf(f);
    const children = loaded?.run.agents.filter((agent) => agent.parentId) ?? [];
    t.check(children.length === 2 && children.every((agent) => JSON.stringify(agent.structuralPath) === JSON.stringify(["branch", "left"])), `worktree=${String(worktree)}: persisted children retain parent structural scope`, children.map((agent) => agent.structuralPath));
    const view = loaded ? p.view.formatWorkflowProgress(loaded.run, "*", undefined, Date.now()) : "";
    t.check(/branch > left[\s\S]*#1 \S+ parent[\s\S]*\n {6}#2 \S+ child[\s\S]*\n {6}#3 \S+ child/.test(view) && !/\n {2}Agents\n/.test(view), `worktree=${String(worktree)}: project progress renderer nests children under the parent scope`, view);
  }
});

// Children of a handle turn keep the turn's scope but own their identity; same-label siblings stay distinct.
scenario("nested-handle-child-identity", "nestedScope/identity", { old: "none" }, async (p, t) => {
  const f = fixture(p, { roles: false });
  agentCapability(f);
  const log = join(f.directory, "identities.jsonl");
  put(join(f.agentDir, "extensions/identity.js"), `import {appendFileSync} from 'node:fs';import {registerWorkflowExtension} from ${registryUrl(p)};export default function(){registerWorkflowExtension({version:'1.0.0',headline:'identity',agentSetupHooks:{identity:{setup(agent,context){appendFileSync(${JSON.stringify(log)},JSON.stringify({label:agent.sessionInput.sessionLabel.split(':')[1],identity:context.identity})+'\\n');}}}});}`);
  const parent = steps("handle-parent", { steps: [
    { tool: "agent", args: { prompt: steps("handle-child-alt"), label: "child", model: "e2e/alt:off" } }, { tool: "get_subagent_result", args: { id: "$id" } },
    { tool: "agent", args: { prompt: steps("handle-child-default"), label: "child" } }, { tool: "get_subagent_result", args: { id: "$id" } },
  ], result: "$results" });
  const result = await piewf(f, `const h = agent.create({name:'h', label:'h', tools:['agent']}); return await h.send(${JSON.stringify(parent)});`);
  t.check(result.code === 0, "handle turn with two same-label children completes", result.stderr.slice(-300));
  const seen = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
  const parentIdentity = seen.find((entry) => entry.label === "h")?.identity;
  const children = seen.filter((entry) => entry.label === "child").map((entry) => entry.identity);
  t.check(parentIdentity?.handle === "h" && parentIdentity.turn === 1, "the handle turn keeps its handle identity", parentIdentity);
  t.check(children.length === 2 && children.every((identity) => identity.handle === undefined && identity.turn === undefined && /^child:agent\/handle\/h\/turn%3A1\/spawn:\d+\/child$/.test(identity.callSite) && identity.callSite === children[0].callSite) && JSON.stringify(children.map((identity) => identity.occurrence)) === "[1,2]", "children own a call site under the turn's spawn, without its handle or turn, with distinct occurrences", children);
  const [loaded] = await runsOf(f);
  const records = loaded?.run.agents.filter((agent) => agent.parentId) ?? [];
  t.check(records.length === 2 && records.every((agent) => agent.handle === undefined && agent.turn === undefined), "persisted child records carry no handle or turn", records.map(({ handle, turn }) => ({ handle, turn })));
  t.check(JSON.stringify(records.map((agent) => loaded.snapshot.agentConfigurations[agent.id]?.model.model)) === JSON.stringify(["alt", "root"]), "same-label siblings freeze independent configurations", records.map((agent) => agent.id));
});

// Pre6 spread excludeTools into Pi's session options: the root exclusion worked, but children regained the tool,
// invalid names were accepted, and subagents_run had no such parameter. Each product's actual behavior is asserted.
scenario("excluded-tools-ceilings", "excludedTools", { old: "same" }, async (p, t) => {
  const f = fixture(p, { roles: false });
  agentCapability(f);
  let before = requests.length;
  const root = await piewf(f, `return await agent(${JSON.stringify(steps("excluded"))}, {label:'excluded', excludeTools:['write']});`);
  t.check(root.code === 0, "root agent with excludeTools completes", root.stderr);
  t.check(since(before, "excluded")[0] && !since(before, "excluded")[0].tools.includes("write") && since(before, "excluded")[0].tools.includes("read"), "root excludeTools removes write but keeps other tools", since(before, "excluded")[0]?.tools);
  before = requests.length;
  const parent = steps("ceiling-parent", { steps: [{ tool: "agent", args: { prompt: steps("ceiling-child"), label: "child", tools: ["write"] } }, { tool: "get_subagent_result", args: { id: "$id" } }], result: "$results" });
  const nested = await piewf(f, `return await agent(${JSON.stringify(parent)}, {label:'parent', tools:['agent'], excludeTools:['write']});`);
  const childRequest = since(before, "ceiling-child")[0];
  t.check(!since(before, "ceiling-parent")[0]?.tools.includes("write"), "nested parent excludeTools removes write", since(before, "ceiling-parent")[0]?.tools);
  if (p.kind === "new") t.check(childRequest === undefined && /UNKNOWN_TOOL/.test(nested.stdout + nested.stderr), "nested child cannot regain a tool excluded from its parent: it fails with UNKNOWN_TOOL before any request", childRequest?.tools ?? nested.stdout.slice(-300));
  else t.check(nested.code === 0 && childRequest?.tools.includes("write") === true, "pre6: the nested child regained write and ran", childRequest?.tools ?? nested.stderr.slice(-300));
  if (p.kind === "new") {
    before = requests.length;
    // Workflow warnings are session entries; read them from the real Pi CLI session file.
    const warned = await pi(f, rootCalls(["workflow", { name: "excluded-unknown", foreground: true, script: `return await agent(${JSON.stringify(steps("excluded-unknown"))}, {excludeTools:['no_such_tool']});` }]), { session: "excluded-unknown" });
    const sessionText = existsSync(f.sessions) ? readdirSync(f.sessions, { recursive: true }).filter((name) => String(name).endsWith(".jsonl")).map((name) => readFileSync(join(f.sessions, String(name)), "utf8")).join("\n") : "";
    t.check(toolEnds(warned.stdout, "workflow")[0]?.isError !== true && /excludeTools names no root or custom tool of this agent: no_such_tool/.test(sessionText) && since(before, "excluded-unknown").length === 1, "an unknown excluded name only warns", sessionText.slice(-300) || warned.stderr.slice(-300));
    // A custom tool that only a setup hook adds, and lists by name, is excluded too, on every attempt of the agent.
    const custom = fixture(p, { roles: false });
    put(join(custom.agentDir, "extensions/helper.js"), `import {registerWorkflowExtension} from ${registryUrl(p)};const helper={name:'custom_helper',label:'Helper',description:'Setup-provided helper',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'helped'}],details:{}})};export default function(){registerWorkflowExtension({version:'1.0.0',headline:'helper',source:import.meta.url,agentSetupHooks:{helper:{setup(agent){agent.sessionInput.customTools=[...(agent.sessionInput.customTools??[]),helper];agent.sessionInput.tools=[...agent.sessionInput.tools,'custom_helper'];}}}});}`);
    before = requests.length;
    await piewf(custom, `return await agent(${JSON.stringify(steps("custom-control"))}, {});`);
    t.check(since(before, "custom-control")[0]?.tools.includes("custom_helper") === true, "control: the setup hook's custom tool reaches the provider", since(before, "custom-control")[0]?.tools);
    before = requests.length;
    const excludedCustom = await piewf(custom, `return await agent(${JSON.stringify(steps("custom-excluded", { failAt: { key: `custom-${String(fixtures)}`, step: 0 } }))}, {excludeTools:['custom_helper'], retries: 1});`);
    const attempts = since(before, "custom-excluded");
    t.check(excludedCustom.code === 0 && attempts.length >= 2 && attempts.every((value) => !value.tools.includes("custom_helper")), "excludeTools removes the setup hook's custom tool on the first attempt and the retry", attempts.map((value) => value.tools));
  }
  for (const invalid of [["wr*"], ["!write"], ["workflow_result"]]) {
    before = requests.length;
    const rejected = await piewf(f, `return await agent(${JSON.stringify(steps("excluded-invalid"))}, {excludeTools:${JSON.stringify(invalid)}});`);
    if (p.kind === "new") t.check(rejected.code !== 0 && /excludeTools/.test(rejected.stderr) && requests.length === before, `invalid excludeTools ${JSON.stringify(invalid)} fails with metadata error before any provider request`, rejected.stderr.slice(-300));
    else t.check(since(before, "excluded-invalid").length > 0 && !/excludeTools/.test(rejected.stderr), `pre6: invalid excludeTools ${JSON.stringify(invalid)} was accepted and reached the provider`, rejected.stderr.slice(-300));
  }
  const standalone = fixture(p, { roles: false });
  before = requests.length;
  const result = await pi(standalone, rootCalls(["subagents_run", { prompt: steps("standalone-excluded"), label: "probe", mode: "foreground", excludeTools: ["write"] }]));
  const end = toolEnds(result.stdout, "subagents_run")[0];
  const request = since(before, "standalone-excluded")[0];
  t.check(end !== undefined, "standalone subagents_run executed through the real Pi CLI", result.stderr);
  if (p.kind === "new") t.check(end?.isError !== true && request !== undefined && !request.tools.includes("write") && request.tools.includes("read"), "standalone subagents_run honors excludeTools", { isError: end?.isError, tools: request?.tools, text: resultText(end).slice(0, 300) });
  else t.check(end?.isError === true && /excludeTools/.test(resultText(end)) && request === undefined, "pre6: subagents_run rejected excludeTools by schema before any request", { isError: end?.isError, text: resultText(end).slice(0, 300) });
});

// Exclusions are frozen with each logical identity's configuration: a handle's later turn and a workflow_retry that
// re-evaluates excludeTools through a registered function keep the first exclusions, for the agent and its new children.
scenario("frozen-excluded-tools", "excludedTools/recovery", { old: "none" }, async (p, t) => {
  const f = fixture(p, { roles: false });
  agentCapability(f);
  const marker = join(f.directory, "delegated-once");
  const nested = (who) => steps(who, { steps: [{ tool: "agent", args: { prompt: steps(`${who}-child`), label: "child" } }, { tool: "get_subagent_result", args: { id: "$id" } }], result: "$results" });
  const retried = steps("fx-retried", { failAt: { key: `fx-${String(fixtures)}`, step: 0 }, steps: [{ tool: "agent", args: { prompt: steps("fx-retried-child"), label: "child" } }, { tool: "get_subagent_result", args: { id: "$id" } }], result: "$results" });
  // The setup hook adds custom_helper and lists it by name; the function excludes it only the first time it runs.
  put(join(f.agentDir, "extensions/helper.js"), `import {existsSync,writeFileSync} from 'node:fs';import {registerWorkflowExtension} from ${registryUrl(p)};const helper={name:'custom_helper',label:'Helper',description:'Setup-provided helper',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'helped'}],details:{}})};export default function(){registerWorkflowExtension({version:'1.0.0',headline:'helper',source:import.meta.url,agentSetupHooks:{helper:{setup(agent){agent.sessionInput.customTools=[...(agent.sessionInput.customTools??[]),helper];agent.sessionInput.tools=[...agent.sessionInput.tools,'custom_helper'];}}},functions:{delegate:{description:'Delegates with exclusions that change when it runs again',input:{type:'object'},output:{type:'string'},run:async(_input,context)=>{const first=!existsSync(${JSON.stringify(marker)});if(first)writeFileSync(${JSON.stringify(marker)},'1');const value=await context.agent(${JSON.stringify(retried)},{label:'fn',tools:['agent'],excludeTools:first?['custom_helper']:[]});return typeof value==='string'?value:JSON.stringify(value);}}}});}`);
  let before = requests.length;
  const handle = await piewf(f, `const exclusions = ['custom_helper'];
const h = agent.create({ name: 'h', tools: ['agent'], excludeTools: exclusions });
await h.send(${JSON.stringify(nested("fx-one"))});
exclusions.pop();
return await h.send(${JSON.stringify(nested("fx-two"))});`);
  const handleRequests = ["fx-one", "fx-one-child", "fx-two", "fx-two-child"].map((who) => since(before, who)[0]);
  t.check(handle.code === 0 && handleRequests.every((value) => value !== undefined && value.tools.includes("read") && !value.tools.includes("custom_helper")), "both handle turns and their children keep the first turn's exclusion after the option list is emptied", handleRequests.map((value) => value?.tools ?? null).concat([handle.stderr.slice(-300)]));
  before = requests.length;
  await piewf(f, `const h = agent.create({ name: 'h', tools: ['agent'] });
return await h.send(${JSON.stringify(nested("fx-control"))});`);
  t.check(since(before, "fx-control")[0]?.tools.includes("custom_helper") === true && since(before, "fx-control-child")[0]?.tools.includes("custom_helper") === true, "control: without the exclusion the hook's tool reaches the handle and its child", [since(before, "fx-control")[0]?.tools, since(before, "fx-control-child")[0]?.tools]);
  const failed = await pi(f, rootCalls(["workflow", { name: "frozen-retry", foreground: true, script: "return await delegate({});" }]), { session: "frozen-retry" });
  const [source] = await runsOf(f, "frozen-retry");
  const frozen = Object.values(source?.snapshot.agentConfigurations ?? {});
  t.check(source?.run.state === "failed" && existsSync(marker) && frozen.length === 1 && JSON.stringify(frozen[0]?.excludeTools) === '["custom_helper"]', "the first run fails at the provider after freezing the function agent's exclusion", { state: source?.run.state, excludeTools: frozen.map((value) => value.excludeTools), text: resultText(toolEnds(failed.stdout, "workflow")[0]).slice(0, 200) });
  before = requests.length;
  const retry = await pi(f, rootCalls(["workflow_retry", { runId: source?.runId ?? "missing", expectedState: "failed", foreground: true }]), { session: "frozen-retry", resume: true });
  const [agentRequest, childRequest] = [since(before, "fx-retried")[0], since(before, "fx-retried-child")[0]];
  const child = (await runsOf(f, "frozen-retry")).find((value) => value.run.parentRunId === source?.runId);
  t.check(child?.run.state === "completed" && agentRequest !== undefined && childRequest !== undefined && !agentRequest.tools.includes("custom_helper") && !childRequest.tools.includes("custom_helper"), "workflow_retry re-runs the function with no exclusions, yet the same identity and its new child keep the frozen exclusion", { state: child?.run.state, agent: agentRequest?.tools, child: childRequest?.tools, text: resultText(toolEnds(retry.stdout, "workflow_retry")[0]).slice(0, 200) });
});

scenario("dynamic-resources", "dynamicSkills", { old: "same" }, async (p, t) => {
  const f = fixture(p, { roles: false });
  const generated = join(f.directory, "generated/generated-skill/SKILL.md");
  put(generated, "---\nname: generated-skill\ndescription: GENERATED_SKILL_MARKER\n---\nbody");
  put(join(f.agentDir, "skills/static-skill/SKILL.md"), "---\nname: static-skill\ndescription: STATIC_SKILL_MARKER\n---\nbody");
  agentCapability(f);
  // Pi expands `~` and file: URLs in contributed paths; HOME is the harness work directory.
  put(join(work, `tilde-${String(fixtures)}/tilde-skill/SKILL.md`), "---\nname: tilde-skill\ndescription: TILDE_SKILL_MARKER\n---\nbody");
  put(join(f.directory, "url dir/url-skill/SKILL.md"), "---\nname: url-skill\ndescription: URL_SKILL_MARKER\n---\nbody");
  put(join(f.agentDir, "extensions/dynamic.js"), `export default (pi)=>{pi.on('resources_discover',()=>({skillPaths:[${JSON.stringify(dirname(generated))}, ${JSON.stringify(`~/tilde-${String(fixtures)}`)}, ${JSON.stringify(pathToFileURL(join(f.directory, "url dir")).href)}]}));}`);
  let before = requests.length;
  const result = await piewf(f, `return await agent(${JSON.stringify(steps("dynamic-root"))}, {label:'root'});`);
  t.check(result.code === 0 && /GENERATED_SKILL_MARKER/.test(since(before, "dynamic-root")[0]?.system ?? ""), "root workflow agent sees resources_discover skill", result.stderr);
  t.check(/STATIC_SKILL_MARKER/.test(since(before, "dynamic-root")[0]?.system ?? ""), "static control skill present");
  t.check(/TILDE_SKILL_MARKER/.test(since(before, "dynamic-root")[0]?.system ?? "") && /URL_SKILL_MARKER/.test(since(before, "dynamic-root")[0]?.system ?? ""), "~ and file: URL contributions reach the root agent");
  before = requests.length;
  const parent = steps("dynamic-parent", { steps: [{ tool: "agent", args: { prompt: steps("dynamic-child"), label: "child" } }, { tool: "get_subagent_result", args: { id: "$id" } }] });
  await piewf(f, `return await agent(${JSON.stringify(parent)}, {label:'parent', tools:['agent']});`);
  t.check(/GENERATED_SKILL_MARKER/.test(since(before, "dynamic-parent")[0]?.system ?? "") && /GENERATED_SKILL_MARKER/.test(since(before, "dynamic-child")[0]?.system ?? ""), "nested parent and child see dynamic skill", since(before).map((value) => value.who));
  before = requests.length;
  const excluded = steps("dynamic-excluded-parent", { steps: [{ tool: "agent", args: { prompt: steps("dynamic-excluded-child"), label: "child", skills: ["generated-skill"] } }, { tool: "get_subagent_result", args: { id: "$id" } }] });
  await piewf(f, `return await agent(${JSON.stringify(excluded)}, {label:'parent', tools:['agent'], skills:['!generated-skill']});`);
  t.check(!/GENERATED_SKILL_MARKER/.test(since(before, "dynamic-excluded-parent")[0]?.system ?? "x"), "parent negation removes the dynamic skill", since(before).map((value) => value.who));
  // Pre6 let the child re-select a skill its parent excluded; the parent ceiling is an intentional, stricter deviation.
  if (p.kind === "new") t.check(since(before, "dynamic-excluded-child").length > 0 && !/GENERATED_SKILL_MARKER/.test(since(before, "dynamic-excluded-child")[0]?.system ?? "x"), "parent exclusion is a ceiling for the nested child", since(before).map((value) => value.who));
  before = requests.length;
  const standalone = await pi(f, rootCalls(["subagents_run", { prompt: steps("dynamic-standalone"), label: "probe", mode: "foreground" }]));
  t.check(/GENERATED_SKILL_MARKER/.test(since(before, "dynamic-standalone")[0]?.system ?? ""), "standalone subagent sees dynamic skill", standalone.stderr.slice(-400));
});

scenario("worktree-project-role-and-settings", "worktreePolicy", { old: "same" }, async (p, t) => {
  const f = fixture(p, { trusted: true, git: true });
  f.role("audit", "---\ndescription: Project audit\nmodel: e2e/call:off\ntools: ['!*', read]\n---\nPROJECT_AUDIT_ROLE", f.cwd);
  f.role("developer", "---\ndescription: Project developer\ntools: ['!*', read]\n---\nPROJECT_DEVELOPER_ROLE", f.cwd);
  json(join(f.cwd, ".pi", p.namespace, "settings.json"), { tools: ["!*", "read", "write"] });
  for (const role of ["audit", "developer"]) {
    const before = requests.length;
    const result = await piewf(f, `return await withWorktree("scope", () => agent(${JSON.stringify(steps(`wt-${role}`))}, {role:${JSON.stringify(role)}}));`, { approve: true });
    const request = since(before, `wt-${role}`)[0];
    t.check(result.code === 0, `${role}: ignored launch-project role resolves inside a worktree`, result.stderr.slice(-400));
    t.check(new RegExp(`PROJECT_${role.toUpperCase()}_ROLE`).test(request?.system ?? ""), `${role}: project role body (not a fallback) reaches the provider`, request?.system.slice(-300));
    t.check(JSON.stringify(request?.tools) === JSON.stringify(["read", "workflow_result"]), `${role}: project role and settings selectors apply`, request?.tools);
  }
  let before = requests.length;
  await piewf(f, `return await withWorktree("scope2", () => agent(${JSON.stringify(steps("wt-norole"))}, {}));`, { approve: true });
  t.check(JSON.stringify(since(before, "wt-norole")[0]?.tools) === JSON.stringify(["read", "workflow_result", "write"]), "ignored project shared settings apply without role inside a worktree", since(before, "wt-norole")[0]?.tools);
  before = requests.length;
  const standalone = await pi(f, rootCalls(["subagents_run", { prompt: steps("wt-standalone"), role: "audit", worktree: "scope3", mode: "foreground" }]), { approve: true });
  const end = toolEnds(standalone.stdout, "subagents_run")[0];
  t.check(!end?.isError && /PROJECT_AUDIT_ROLE/.test(since(before, "wt-standalone")[0]?.system ?? ""), "standalone worktree subagent resolves launch-project role", resultText(end).slice(0, 400) || standalone.stderr.slice(-400));
});

scenario("project-extension-settings-replace", "projectSettings", { old: "same" }, async (p, t) => {
  for (const projectMap of [{}, { replace: { value: "project" } }]) {
    const f = fixture(p, { trusted: true });
    const seen = observer(f);
    json(join(f.agentDir, p.namespace, "settings.json"), { extensionSettings: { keep: { enabled: true }, replace: { value: "global" } } });
    json(join(f.cwd, ".pi", p.namespace, "settings.json"), { extensionSettings: projectMap });
    const result = await piewf(f, `return await agent(${JSON.stringify(steps("settings"))}, {});`, { approve: true });
    t.check(result.code === 0, "run completes", result.stderr);
    const child = seen().filter((value) => value.child).at(-1);
    t.check(JSON.stringify(child?.settings) === JSON.stringify(projectMap), `trusted project extensionSettings ${JSON.stringify(projectMap)} replaces the global map (pre6)`, child?.settings);
  }
});

// Pre6 moved the agent into both directories and executed the foreign project's extension; both are asserted for pre6.
scenario("setup-hook-cwd", "setupCwd", { old: "same" }, async (p, t) => {
  for (const target of ["sub", "foreign"]) {
    const f = fixture(p, { roles: false, trusted: true });
    const sub = join(f.cwd, "sub"), foreign = join(f.directory, "foreign"), loaded = join(f.directory, "FOREIGN_EXTENSION_LOADED");
    mkdirSync(sub, { recursive: true });
    put(join(foreign, ".pi/extensions/foreign.js"), `import {writeFileSync} from 'node:fs';export default function(){writeFileSync(${JSON.stringify(loaded)},'loaded');}`);
    put(join(f.agentDir, "extensions/cwd-hook.js"), `import {registerWorkflowExtension} from ${registryUrl(p)};export default function(){registerWorkflowExtension({version:'1.0.0',headline:'cwd hook',agentSetupHooks:{cwdhook:{setup(agent){agent.sessionInput.cwd=${JSON.stringify(target === "sub" ? sub : foreign)};}}}});}`);
    const before = requests.length;
    const result = await piewf(f, `return await agent(${JSON.stringify(steps("cwd", { steps: [{ tool: "bash", args: { command: "pwd -P" } }], result: "$results" }))});`, { approve: true });
    // Deliberate deviation from pre6: even a subdirectory would switch Pi's cwd-derived trust, settings and .pi resources.
    const moved = target === "sub" ? sub : foreign;
    if (p.kind === "new") {
      t.check(result.code !== 0 && /INVALID_METADATA|metadata is invalid: Agent setup cannot change cwd/.test(result.stderr) && since(before).length === 0, `${target}: setup-hook cwd change is rejected before any provider request`, result.stdout + result.stderr.slice(-300));
      if (target === "foreign") t.check(!existsSync(loaded), "foreign project extension is never executed");
    } else {
      t.check(result.code === 0 && since(before, "cwd").some((value) => value.results.some((output) => output.includes(moved))), `pre6: ${target}: the agent ran in the hook's cwd`, result.stderr.slice(-300));
      if (target === "foreign") t.check(existsSync(loaded), "pre6: the foreign project extension was executed");
    }
  }
});

scenario("builtin-alias-precedence", "builtinModels/aliasVisibility", { old: "none" }, async (p, t) => {
  for (const entry of ["workflow", "standalone"]) {
    const f = fixture(p);
    json(join(f.agentDir, "pi-ext-roles/settings.json"), { modelAliases: { "reviewer-model": "e2e/call:off", chosen: "e2e/alt:off" } });
    for (const [label, options, expected] of [["shared-over-dynamic", { role: "reviewer", model: "reviewer-model" }, "call"], ["shared-only", { model: "chosen" }, "alt"], ["fallback-role", { role: "reviewer" }, "call"]]) {
      const before = requests.length;
      const who = `${entry}-${label}`;
      const call = entry === "workflow" ? ["workflow", { name: "aliases", foreground: true, script: `return await agent(${JSON.stringify(steps(who))}, ${JSON.stringify({ label: "probe", ...options })});` }] : ["subagents_run", { prompt: steps(who), label: "probe", mode: "foreground", ...options }];
      const result = await pi(f, rootCalls(call));
      t.check(since(before, who)[0]?.model === expected, `${who}: physical model ${expected}`, since(before, who)[0]?.model ?? resultText(toolEnds(result.stdout)[0]).slice(0, 300));
    }
  }
  const core = fixture(p);
  json(join(core.agentDir, "pi-extensible-workflows/settings.json"), { modelAliases: { "reviewer-model": "e2e/alt:off" } });
  json(join(core.agentDir, "pi-ext-roles/settings.json"), { modelAliases: { "reviewer-model": "e2e/call:off" } });
  const before = requests.length;
  await piewf(core, `return await agent(${JSON.stringify(steps("consumer-over-shared"))}, {model:'reviewer-model'});`);
  t.check(since(before, "consumer-over-shared")[0]?.model === "alt", "explicit consumer static alias overlays shared and dynamic aliases", since(before, "consumer-over-shared")[0]?.model);
});

scenario("bundle-guarded-native-factory", "bundleFacade", { old: "same" }, async (p, t) => {
  for (const guard of ["if (pi) pi.registerCommand('e2e-native', { description: 'native', handler: async () => {} });", "if (pi) pi.on('session_start', () => {});"]) {
    const f = fixture(p, { roles: false });
    const source = join(p.install, `bundle-factory-${String(fixtures)}.mjs`);
    put(source, `import { registerWorkflowExtension } from "pi-extensible-workflows";\nexport default function extension(pi) {\n  ${guard}\n  registerWorkflowExtension({ version: "1.0.0", headline: "E2E", source: import.meta.url, functions: { e2eBundle: { description: "E2E", input: { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false }, output: { type: "integer" }, async run(input) { return input.value; } } } });\n}\n`);
    f.extend(source);
    symlinkSync(p.modules, join(f.cwd, "node_modules"));
    const output = join(f.directory, "bundle");
    const bundled = await command(process.execPath, [p.cli, "bundle", "e2eBundle", "--name", "e2e-bundle", "--output", output], { cwd: f.cwd, env: f.env });
    t.check(bundled.code === 0, "piewf bundle accepts a guarded native factory", bundled.stdout + bundled.stderr);
    const recipient = join(f.directory, "recipient");
    mkdirSync(join(recipient, "npm"), { recursive: true }); symlinkSync(p.modules, join(recipient, "npm/node_modules"));
    json(join(recipient, "settings.json"), { defaultProvider: "e2e", defaultModel: "root" }); put(join(recipient, "models.json"), readFileSync(join(f.agentDir, "models.json")));
    const launcher = join(output, "e2e-bundle");
    const setup = await command(launcher, ["setup", "--yes"], { cwd: f.cwd, env: { PI_CODING_AGENT_DIR: recipient } });
    t.check(setup.code === 0, "packed recipient setup runs the guarded factory without a native Pi API", setup.stdout + setup.stderr);
    const launched = await command(launcher, ["7"], { cwd: f.cwd, env: { PI_CODING_AGENT_DIR: recipient } });
    t.check(launched.code === 0 && /^7$/m.test(launched.stdout), "packed recipient launch returns the function value", launched.stdout + launched.stderr);
  }
});

// A bundle's own preparation hook, registered before Pi loads the recipient's extensions, keeps owning its option and
// restricting tools beside an unrelated recipient load failure.
scenario("bundle-hook-beside-recipient-failure", "bundleFacade/cliExtensionFailure", { old: "none" }, async (p, t) => {
  const f = fixture(p, { roles: false });
  const source = join(p.install, `bundle-hook-${String(fixtures)}.mjs`);
  put(source, `import { registerWorkflowExtension } from "pi-extensible-workflows";\nexport default function extension() {\n  registerWorkflowExtension({ version: "1.0.0", headline: "Bundled audit", source: import.meta.url, functions: { e2eAudit: { description: "Audit", input: { type: "object", properties: {}, additionalProperties: false }, output: { type: "string" }, async run(_input, context) { return await context.agent(${JSON.stringify(steps("bundle-hook"))}, { persona: "auditor" }); } } }, agentPreparationHooks: { persona: { optionsSchema: { type: "object", properties: { persona: { type: "string" } }, additionalProperties: true }, prepare(configuration, context) { if (context.options.persona === "auditor") configuration.tools = ["!*", "read"]; } } } });\n}\n`);
  f.extend(source);
  symlinkSync(p.modules, join(f.cwd, "node_modules"));
  const output = join(f.directory, "bundle");
  const bundled = await command(process.execPath, [p.cli, "bundle", "e2eAudit", "--name", "e2e-audit", "--output", output], { cwd: f.cwd, env: f.env });
  t.check(bundled.code === 0, "piewf bundle accepts the hooked function", bundled.stdout + bundled.stderr);
  const recipient = join(f.directory, "recipient");
  mkdirSync(join(recipient, "npm"), { recursive: true }); symlinkSync(p.modules, join(recipient, "npm/node_modules"));
  const broken = join(f.directory, "recipient-broken.mjs");
  put(broken, "export default function () { throw new Error('E2E_RECIPIENT_UNRELATED_FAILURE'); }\n");
  json(join(recipient, "settings.json"), { defaultProvider: "e2e", defaultModel: "root", extensions: [broken] }); put(join(recipient, "models.json"), readFileSync(join(f.agentDir, "models.json")));
  const launcher = join(output, "e2e-audit");
  const setup = await command(launcher, ["setup", "--yes"], { cwd: f.cwd, env: { PI_CODING_AGENT_DIR: recipient } });
  t.check(setup.code === 0, "packed recipient setup", setup.stdout + setup.stderr);
  const before = requests.length;
  const launched = await command(launcher, [], { cwd: f.cwd, env: { PI_CODING_AGENT_DIR: recipient } });
  const request = since(before, "bundle-hook")[0];
  t.check(launched.code === 0 && /E2E_RECIPIENT_UNRELATED_FAILURE/.test(launched.stderr), "the bundled workflow runs beside the recipient's unrelated failure, with a warning", launched.stdout + launched.stderr.slice(-400));
  t.check(JSON.stringify(request?.tools) === JSON.stringify(["read", "workflow_result"]), "the bundled hook still restricts tools", request?.tools);
});

scenario("context-file-scopes", "contextIdentity", { old: "same" }, async (p, t) => {
  const f = fixture(p, { git: true, trusted: true });
  const scopes = { global: ["GLOBAL_AGENTS"], project: ["PROJECT_AGENTS"], cwd: ["CWD_AGENTS"] };
  for (const [scope, expected] of Object.entries(scopes)) {
    const before = requests.length;
    await piewf(f, `return await agent(${JSON.stringify(steps(`ctx-${scope}`))}, {contextFiles:[${JSON.stringify(scope)}]});`, { approve: true });
    const system = since(before, `ctx-${scope}`)[0]?.system ?? "";
    const present = ["GLOBAL_AGENTS", "PROJECT_AGENTS", "CWD_AGENTS"].filter((marker) => system.includes(marker));
    t.check(JSON.stringify(present) === JSON.stringify(expected), `call contextFiles [${scope}] selects only that scope`, present);
  }
  if (p.kind === "new") {
    f.role("scoped", "---\ndescription: scoped\ncontextFiles: [project]\n---\nSCOPED_ROLE");
    const before = requests.length;
    await piewf(f, `return await agent(${JSON.stringify(steps("ctx-role"))}, {role:'scoped'});`, { approve: true });
    const system = since(before, "ctx-role")[0]?.system ?? "";
    t.check(/SCOPED_ROLE/.test(system) && /PROJECT_AGENTS/.test(system) && !/GLOBAL_AGENTS|CWD_AGENTS/.test(system), "role contextFiles [project] selects only ancestor project files", system.slice(0, 400));
  }
  const edit = `printf LAUNCH_EDIT > ${join(f.cwd, "AGENTS.md")}`;
  const before = requests.length;
  const result = await piewf(f, `return await withWorktree("ctx", async () => { await shell(${JSON.stringify(edit)}); return agent(${JSON.stringify(steps("ctx-worktree"))}, {contextFiles:['cwd','global']}); });`, { approve: true });
  const system = since(before, "ctx-worktree")[0]?.system ?? "";
  t.check(result.code === 0 && /CWD_AGENTS/.test(system) && /GLOBAL_AGENTS/.test(system) && !/LAUNCH_EDIT/.test(system), "worktree agent reads cwd context from its worktree checkout, not the launch directory", result.stderr.slice(-300) + system.slice(0, 300));
});

scenario("role-override-prompt-conflict", "rolesAdapter", { old: "none" }, async (p, t) => {
  for (const systemPrompt of ["CALL_BASE", ""]) {
    const f = fixture(p);
    const seen = observer(f);
    f.role("reviewer", "---\nmodel: e2e/role:off\noverrideSystemPrompt: true\n---\nROLE_BASE");
    const before = requests.length;
    const result = await piewf(f, `return await agent(${JSON.stringify(steps("conflict"))}, {role:'reviewer', systemPrompt:${JSON.stringify(systemPrompt)}});`);
    t.check(result.code !== 0 && /INVALID_METADATA|overrideSystemPrompt/.test(result.stderr), `systemPrompt=${JSON.stringify(systemPrompt)}: conflict is rejected`, result.stderr.slice(-300));
    t.check(since(before).length === 0 && seen().every((value) => !value.child), `systemPrompt=${JSON.stringify(systemPrompt)}: rejected before child session creation`, seen());
  }
  const f = fixture(p);
  f.role("reviewer", "---\nmodel: e2e/role:off\noverrideSystemPrompt: true\n---\nROLE_BASE");
  const before = requests.length;
  await piewf(f, `return await agent(${JSON.stringify(steps("override-append"))}, {role:'reviewer', systemPromptAppend:'CALL_APPEND'});`);
  const system = since(before, "override-append")[0]?.system ?? "";
  t.check(/^ROLE_BASE[\s\S]*CALL_APPEND/.test(system) && !/expert coding assistant/.test(system), "override role base with call append, in order", system.slice(0, 300));
});

scenario("structured-append-prefix-311", "rolesAdapter#311", { old: "none" }, async (p, t) => {
  const f = fixture(p);
  f.role("reviewer", "---\ndescription: REVIEWER_DESCRIPTION\nmodel: e2e/role:off\n---\nROLE_APPEND");
  put(join(f.cwd, "notes.txt"), "notes");
  // A tool that activates another tool mid-session changes the provider tool inventory.
  const enable = join(f.agentDir, "enable-tool.mjs");
  put(enable, `import {Type} from ${JSON.stringify(pathToFileURL(join(p.modules, "@earendil-works/pi-ai/dist/index.js")).href)};export default function(pi){pi.registerTool({name:'e2e_extra',label:'Extra',description:'Extra tool',parameters:Type.Object({}),execute:async()=>({content:[{type:'text',text:'extra'}],details:{}})});pi.registerTool({name:'e2e_enable',label:'Enable',description:'Activate e2e_extra',parameters:Type.Object({}),execute:async()=>{pi.setActiveTools([...pi.getActiveTools(),'e2e_extra']);return {content:[{type:'text',text:'enabled'}],details:{}};}});pi.on('session_start',()=>{pi.setActiveTools(pi.getActiveTools().filter(name=>name!=='e2e_extra'));});}`);
  f.extend(enable);
  let before = requests.length;
  const result = await pi(f, rootCalls(["read", { path: "notes.txt" }], ["e2e_enable", {}]));
  const root = since(before, "root");
  t.check(result.code === 0 && root.length === 3, "root Pi CLI session made three provider requests", root.length);
  t.check(root.every((value) => value.system === root[0].system), "system prompt stays byte-identical across root turns while the tool inventory changes");
  t.check(JSON.stringify(root[1]?.tools) === JSON.stringify(root[0]?.tools) && !root[0]?.tools.includes("e2e_extra") && root[2]?.tools.includes("e2e_extra"), "tool inventory actually changed after activation", root.map((value) => value.tools.length));
  const prefix = (earlier, later) => JSON.stringify(later.payload.messages.slice(0, earlier.payload.messages.length)) === JSON.stringify(earlier.payload.messages);
  t.check(root.length === 3 && prefix(root[0], root[1]) && prefix(root[1], root[2]), "earlier ordered message blocks are an unchanged prefix of later requests");
  t.check(/EXISTING_APPEND[\s\S]*Role options \(pi-ext-roles\)[\s\S]*REVIEWER_DESCRIPTION/.test(root[0]?.system ?? ""), "existing append precedes structured role guidance", root[0]?.system.slice(-600));
  before = requests.length;
  await piewf(f, `return await agent(${JSON.stringify(steps("child-order", { steps: [{ tool: "read", args: { path: "notes.txt" } }] }))}, {role:'reviewer'});`);
  const child = since(before, "child-order");
  const system = child[0]?.system ?? "";
  t.check(child.length === 2 && child[0].system === child[1].system, "child system prompt stable across turns", child.length);
  const order = ["expert coding assistant", "EXISTING_APPEND", "ROLE_APPEND", "GLOBAL_AGENTS", "CWD_AGENTS"].map((marker) => system.indexOf(marker));
  t.check(order.every((index, position) => index >= 0 && (position === 0 || index > order[position - 1])), "child blocks ordered: Pi base, existing append, role append, then context files", order);
});

scenario("retry-frozen-and-new-identities", "recovery", { old: "none" }, async (p, t) => {
  const f = fixture(p);
  const roleV1 = "---\ndescription: v1\nmodel: e2e/role:off\n---\nROLE_V1";
  f.role("reviewer", roleV1);
  const script = `const a = await agent(${JSON.stringify(steps("retry-a", { failAt: { key: `retry-${String(fixtures)}`, step: 0 } }))}, {role:'reviewer', label:'a'});\nconst b = await agent(${JSON.stringify(steps("retry-b"))}, {role:'reviewer', label:'b'});\nreturn {a, b};`;
  const failed = await pi(f, rootCalls(["workflow", { name: "retry", foreground: true, script }]), { session: "retry-session" });
  t.check(toolEnds(failed.stdout, "workflow")[0]?.isError === true || /failed/.test(resultText(toolEnds(failed.stdout, "workflow")[0])), "first run fails at agent a", resultText(toolEnds(failed.stdout, "workflow")[0]).slice(0, 300));
  const [source] = await runsOf(f, "retry-session");
  t.check(source?.run.state === "failed", "failed state persisted before the CLI returned", source?.run.state);
  f.role("reviewer", "---\ndescription: v2\nmodel: e2e/alt:off\n---\nROLE_V2");
  const before = requests.length;
  const retried = await pi(f, rootCalls(["workflow_retry", { runId: source?.runId ?? "missing", expectedState: "failed", foreground: true }]), { session: "retry-session", resume: true });
  const a = since(before, "retry-a")[0], b = since(before, "retry-b")[0];
  t.check(a?.model === "role" && /ROLE_V1/.test(a.system) && !/ROLE_V2/.test(a.system), "retried logical agent keeps its frozen role configuration", a && { model: a.model });
  t.check(b?.model === "alt" && /ROLE_V2/.test(b.system), "new logical identity resolves the edited role", b && { model: b.model });
  const runs = await runsOf(f, "retry-session");
  const child = runs.find((value) => value.run.parentRunId === source?.runId);
  t.check(child?.run.state === "completed" && /retry-b-ok/.test(resultText(toolEnds(retried.stdout, "workflow_retry")[0])), "retry child completion persisted and delivered", { state: child?.run.state, text: resultText(toolEnds(retried.stdout, "workflow_retry")[0]).slice(0, 200) });
});

// A packaged fallback role's default `<role>-model` alias is frozen per logical identity across retry; new identities
// see the edited alias. A virtual workflow/<alias> root model reaches the provider as its physical target.
scenario("builtin-default-alias-freeze", "recovery/builtinModels", { old: "none" }, async (p, t) => {
  const f = fixture(p);
  json(join(f.agentDir, "pi-ext-roles/settings.json"), { modelAliases: { "reviewer-model": "e2e/role:off" } });
  const script = `const a = await agent(${JSON.stringify(steps("bd-a", { failAt: { key: `bd-${String(fixtures)}`, step: 0 } }))}, {role:'reviewer', label:'a'});\nconst b = await agent(${JSON.stringify(steps("bd-b"))}, {role:'reviewer', label:'b'});\nreturn {a, b};`;
  await pi(f, rootCalls(["workflow", { name: "builtin-default", foreground: true, script }]), { session: "builtin-default" });
  const [source] = await runsOf(f, "builtin-default");
  t.check(source?.run.state === "failed", "first run fails at agent a", source?.run.state);
  json(join(f.agentDir, "pi-ext-roles/settings.json"), { modelAliases: { "reviewer-model": "e2e/alt:off" } });
  const before = requests.length;
  await pi(f, rootCalls(["workflow_retry", { runId: source?.runId ?? "missing", expectedState: "failed", foreground: true }]), { session: "builtin-default", resume: true });
  t.check(since(before, "bd-a")[0]?.model === "role", "retried a keeps its frozen default-alias model", since(before, "bd-a")[0]?.model);
  t.check(since(before, "bd-b")[0]?.model === "alt", "new identity b resolves the edited default alias", since(before, "bd-b")[0]?.model);
  const virtual = fixture(p);
  json(join(virtual.agentDir, "pi-extensible-workflows/settings.json"), { modelAliases: { cheap: "e2e/call" } });
  const settings = readJson(join(virtual.agentDir, "settings.json"));
  json(join(virtual.agentDir, "settings.json"), { ...settings, defaultProvider: "workflow", defaultModel: "cheap", defaultThinkingLevel: "low" });
  const beforeVirtual = requests.length;
  const result = await piewf(virtual, `return await agent(${JSON.stringify(steps("virtual-root"))}, {role:'reviewer'});`);
  const request = since(beforeVirtual, "virtual-root")[0];
  t.check(result.code === 0 && request?.model === "call", "a fallback role without its alias inherits the virtual root model's physical target", { code: result.code, model: request?.model, stderr: result.stderr.slice(-300) });
});

scenario("nested-retry-siblings", "recovery/nestedScope", { old: "none" }, async (p, t) => {
  const f = fixture(p);
  f.role("reviewer", "---\nmodel: e2e/role:off\n---\nROLE_V1");
  agentCapability(f);
  const key = `nested-retry-${String(fixtures)}`;
  const parent = steps("nr-parent", { failAt: { key, step: 4 }, steps: [
    { tool: "agent", args: { prompt: steps("nr-alt"), label: "child", role: "reviewer", model: "e2e/alt:off" } }, { tool: "get_subagent_result", args: { id: "$id" } },
    { tool: "agent", args: { prompt: steps("nr-default"), label: "child", role: "reviewer" } }, { tool: "get_subagent_result", args: { id: "$id" } },
  ], result: "$results" });
  const script = `return await parallel("branch", {left: () => agent(${JSON.stringify(parent)}, {label:'parent', role:'reviewer', tools:['agent']})});`;
  await pi(f, rootCalls(["workflow", { name: "nested-retry", foreground: true, script }]), { session: "nested-retry" });
  const [source] = await runsOf(f, "nested-retry");
  t.check(source?.run.state === "failed", "parent failure persisted", source?.run.state);
  f.role("reviewer", "---\nmodel: e2e/call:off\n---\nROLE_V2");
  const before = requests.length;
  await pi(f, rootCalls(["workflow_retry", { runId: source?.runId ?? "missing", expectedState: "failed", foreground: true }]), { session: "nested-retry", resume: true });
  const parentRequest = since(before, "nr-parent")[0], alt = since(before, "nr-alt")[0], fallback = since(before, "nr-default")[0];
  t.check(parentRequest?.model === "role" && /ROLE_V1/.test(parentRequest.system), "retried parent keeps frozen configuration", parentRequest?.model);
  t.check(alt?.model === "alt" && fallback !== undefined && fallback.model !== "alt", "retried siblings keep distinct configurations", [alt?.model, fallback?.model]);
  // Children are new spawns of the retried parent attempt, so they prepare against the current (V2) role.
  t.check(fallback?.model === "call" && /ROLE_V2/.test(fallback.system) && !/ROLE_V1/.test(fallback.system), "the retried parent's new default child uses the current V2 role and model", fallback && { model: fallback.model });
  t.check(/ROLE_V2/.test(alt?.system ?? "") && !/ROLE_V1/.test(alt?.system ?? ""), "the retried parent's new explicit-model child keeps its call model with the current V2 role body", alt?.system.slice(0, 200));
  const child = (await runsOf(f, "nested-retry")).find((value) => value.run.parentRunId === source?.runId);
  const nested = child?.run.agents.filter((agent) => agent.parentId) ?? [];
  t.check(child?.run.state === "completed" && nested.length === 2 && nested.every((agent) => JSON.stringify(agent.structuralPath) === JSON.stringify(["branch", "left"])), "retried nested children retain structural scope", nested.map((agent) => agent.structuralPath));
});

scenario("cold-interruption-resume", "recovery", { old: "none" }, async (p, t) => {
  const f = fixture(p);
  f.role("reviewer", "---\nmodel: e2e/role:off\n---\nROLE_V1");
  const script = `const a = await agent(${JSON.stringify(steps("cold-a", { killAt: { key: `cold-${String(fixtures)}`, step: 0 } }))}, {role:'reviewer', label:'a'});\nconst b = await agent(${JSON.stringify(steps("cold-b"))}, {role:'oracle', label:'b'});\nreturn {a, b};`;
  const killed = await pi(f, rootCalls(["workflow", { name: "cold", foreground: true, script }]), { session: "cold-session", interruptible: true });
  t.check(killed.signal === "SIGKILL", "Pi CLI host killed during agent a provider request", { code: killed.code, signal: killed.signal });
  const [source] = await runsOf(f, "cold-session");
  t.check(source !== undefined && Object.keys(source.snapshot.agentConfigurations).length === 1, "agent a configuration persisted before the provider request", source && Object.keys(source.snapshot.agentConfigurations));
  f.role("reviewer", "---\nmodel: e2e/alt:off\n---\nROLE_V2");
  f.role("oracle", "---\nmodel: e2e/call:off\ncontextFiles: []\n---\nNEW_ORACLE_AFTER_RESUME");
  const before = requests.length;
  const terminal = async () => ["completed", "failed", "stopped"].includes((await runsOf(f, "cold-session")).find((value) => value.runId === source?.runId)?.run.state ?? "");
  const resumed = await piResume(f, "cold-session", source?.runId ?? "missing-run-id", terminal);
  t.check(resumed.answered && /Resumed workflow cold\./.test(resumed.screen), "interactive TUI picker offered and resumed the interrupted run", resumed.screen.slice(-600));
  const a = since(before, "cold-a")[0], b = since(before, "cold-b")[0];
  t.check(a?.model === "role" && /ROLE_V1/.test(a.system), "resumed agent a keeps frozen configuration", a?.model ?? resumed.stdout.slice(-600));
  t.check(b?.model === "call" && /NEW_ORACLE_AFTER_RESUME/.test(b.system) && !/GLOBAL_AGENTS|CWD_AGENTS/.test(b.system), "new identity b resolves current role after resume", b?.model);
  const after = (await runsOf(f, "cold-session")).find((value) => value.runId === source?.runId);
  t.check(after?.run.state === "completed" && Object.keys(after.snapshot.agentConfigurations).length === 2, "resumed completion and both configurations persisted", after?.run.state);
});

// The packaged fallback role's default alias is frozen for the interrupted identity across cold resume.
scenario("builtin-default-cold-resume", "recovery/builtinModels", { old: "none" }, async (p, t) => {
  const f = fixture(p);
  json(join(f.agentDir, "pi-ext-roles/settings.json"), { modelAliases: { "reviewer-model": "e2e/role:off" } });
  const script = `const a = await agent(${JSON.stringify(steps("bcold-a", { killAt: { key: `bcold-${String(fixtures)}`, step: 0 } }))}, {role:'reviewer', label:'a'});\nconst b = await agent(${JSON.stringify(steps("bcold-b"))}, {role:'reviewer', label:'b'});\nreturn {a, b};`;
  const killed = await pi(f, rootCalls(["workflow", { name: "cold", foreground: true, script }]), { session: "bcold-session", interruptible: true });
  t.check(killed.signal === "SIGKILL", "Pi CLI host killed during agent a", { code: killed.code, signal: killed.signal });
  const [source] = await runsOf(f, "bcold-session");
  json(join(f.agentDir, "pi-ext-roles/settings.json"), { modelAliases: { "reviewer-model": "e2e/alt:off" } });
  const before = requests.length;
  const terminal = async () => ["completed", "failed", "stopped"].includes((await runsOf(f, "bcold-session")).find((value) => value.runId === source?.runId)?.run.state ?? "");
  const resumed = await piResume(f, "bcold-session", source?.runId ?? "missing-run-id", terminal);
  t.check(resumed.answered, "interactive TUI picker resumed the interrupted run", resumed.screen.slice(-400));
  t.check(since(before, "bcold-a")[0]?.model === "role", "resumed a keeps its frozen default-alias model", since(before, "bcold-a")[0]?.model);
  t.check(since(before, "bcold-b")[0]?.model === "alt", "new identity b resolves the edited default alias", since(before, "bcold-b")[0]?.model);
});

// A cold-resumed parent spawns its children again as new identities: the completed pre-crash child and the new child
// have distinct identities, and the new child prepares against the edited role.
scenario("nested-child-cold-resume-identity", "recovery/nestedScope/identity", { old: "none" }, async (p, t) => {
  const f = fixture(p);
  agentCapability(f);
  f.role("reviewer", "---\nmodel: e2e/role:off\n---\nCHILD_ROLE_V1");
  const log = join(f.directory, "identities.jsonl");
  put(join(f.agentDir, "extensions/identity.js"), `import {appendFileSync} from 'node:fs';import {registerWorkflowExtension} from ${registryUrl(p)};export default function(){registerWorkflowExtension({version:'1.0.0',headline:'identity',agentSetupHooks:{identity:{setup(agent,context){appendFileSync(${JSON.stringify(log)},JSON.stringify({label:agent.sessionInput.sessionLabel.split(':')[1],identity:context.identity})+'\\n');}}}});}`);
  const parent = steps("ncr-parent", { killAt: { key: `ncr-${String(fixtures)}`, step: 2 }, steps: [{ tool: "agent", args: { prompt: steps("ncr-child"), label: "child", role: "reviewer" } }, { tool: "get_subagent_result", args: { id: "$id" } }], result: "$results" });
  const killed = await pi(f, rootCalls(["workflow", { name: "cold", foreground: true, script: `return await agent(${JSON.stringify(parent)}, {label:'parent', tools:['agent']});` }]), { session: "ncr-session", interruptible: true });
  t.check(killed.signal === "SIGKILL" && requests.find((value) => value.who === "ncr-child")?.model === "role", "host killed after the first child completed with the V1 role", { signal: killed.signal, model: requests.find((value) => value.who === "ncr-child")?.model });
  const [source] = await runsOf(f, "ncr-session");
  f.role("reviewer", "---\nmodel: e2e/alt:off\n---\nCHILD_ROLE_V2");
  const before = requests.length;
  const terminal = async () => ["completed", "failed", "stopped"].includes((await runsOf(f, "ncr-session")).find((value) => value.runId === source?.runId)?.run.state ?? "");
  const resumed = await piResume(f, "ncr-session", source?.runId ?? "missing-run-id", terminal);
  t.check(resumed.answered, "interactive TUI picker resumed the interrupted run", resumed.screen.slice(-400));
  const children = (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)) : []).filter((entry) => entry.label === "child").map((entry) => entry.identity);
  t.check(children.length === 2 && children[0].callSite !== children[1].callSite && children.every((identity) => identity.occurrence === 1 && identity.handle === undefined), "the pre-crash child and the respawned child have distinct identities", children.map((identity) => identity.callSite));
  const respawned = since(before, "ncr-child")[0];
  t.check(respawned?.model === "alt" && /CHILD_ROLE_V2/.test(respawned.system), "the respawned child prepares against the edited role", respawned?.model);
  t.check((await runsOf(f, "ncr-session")).find((value) => value.runId === source?.runId)?.run.state === "completed", "the resumed run completes");
});

// --legacy: 6.x products whose prepared configurations have no frozen excludeTools. A run they persisted and that a host
// upgraded to the new products cold-resumes must not regain the tools its first preparation excluded.
let legacy;
scenario("legacy-exclusions-upgrade-cold-resume", "excludedTools/recovery", { old: "none" }, async (p, t) => {
  if (!t.check(legacy !== undefined, "requires --legacy products that predate frozen excludeTools")) return;
  const f = fixture(legacy, { roles: false });
  agentCapability(f);
  const marker = join(f.directory, "delegated-once");
  const prompt = steps("lx-agent", { killAt: { key: `lx-${String(fixtures)}`, step: 0 }, steps: [{ tool: "agent", args: { prompt: steps("lx-child"), label: "child" } }, { tool: "get_subagent_result", args: { id: "$id" } }], result: "$results" });
  const helper = `import {existsSync,writeFileSync} from 'node:fs';import {registerWorkflowExtension} from ${registryUrl(legacy)};const helper={name:'custom_helper',label:'Helper',description:'Setup-provided helper',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'helped'}],details:{}})};export default function(){registerWorkflowExtension({version:'1.0.0',headline:'helper',source:import.meta.url,agentSetupHooks:{helper:{setup(agent){agent.sessionInput.customTools=[...(agent.sessionInput.customTools??[]),helper];agent.sessionInput.tools=[...agent.sessionInput.tools,'custom_helper'];}}},functions:{delegate:{description:'Delegates with exclusions that change when it runs again',input:{type:'object'},output:{type:'string'},run:async(_input,context)=>{const first=!existsSync(${JSON.stringify(marker)});if(first)writeFileSync(${JSON.stringify(marker)},'1');const value=await context.agent(${JSON.stringify(prompt)},{label:'fn',tools:['agent'],excludeTools:first?['custom_helper']:[]});return typeof value==='string'?value:JSON.stringify(value);}}}});}`;
  put(join(f.agentDir, "extensions/helper.js"), helper);
  const killed = await pi(f, rootCalls(["workflow", { name: "legacy-exclusions", foreground: true, script: "return await delegate({});" }]), { session: "lx-session", interruptible: true });
  const first = requests.find((value) => value.who === "lx-agent");
  const [source] = await runsOf(f, "lx-session");
  const stored = Object.values(source?.snapshot.agentConfigurations ?? {});
  t.check(killed.signal === "SIGKILL" && first !== undefined && !first.tools.includes("custom_helper") && stored.length === 1 && stored[0].excludeTools === undefined, "the legacy host excluded custom_helper, persisted a configuration without frozen exclusions and was killed", { signal: killed.signal, tools: first?.tools, stored: stored.map((value) => Object.keys(value)) });
  // Upgrade in place, as a package update would: the legacy installation's core package now holds the new core, so the
  // frozen extension identities, agent directory, session and run stay the same.
  rmSync(legacy.core, { recursive: true, force: true });
  execFileSync("cp", ["-R", p.core, legacy.core]);
  t.check(readFileSync(join(legacy.core, "dist/src/index.js"), "utf8") === readFileSync(join(p.core, "dist/src/index.js"), "utf8"), "the legacy installation now runs the new core");
  const before = requests.length;
  const terminal = async () => ["completed", "failed", "stopped"].includes((await runsOf(f, "lx-session")).find((value) => value.runId === source?.runId)?.run.state ?? "");
  const resumed = await piResume(f, "lx-session", source?.runId ?? "missing-run-id", terminal, "legacy-exclusions");
  const run = (await runsOf(f, "lx-session")).find((value) => value.runId === source?.runId)?.run;
  t.check(resumed.answered, "the upgraded host's TUI picker resumed the interrupted run", resumed.screen.slice(-400));
  t.check(run?.state === "failed" && /predates frozen excludeTools/.test(JSON.stringify(run.error ?? "")) && since(before).every((value) => !value.who.startsWith("lx-")), "the cold resume fails with RESUME_INCOMPATIBLE before any request instead of guessing the exclusions", { state: run?.state, error: run?.error, requests: since(before).map((value) => ({ who: value.who, tools: value.tools })) });
});

scenario("completion-persisted-before-delivery", "delivery", { old: "same" }, async (p, t) => {
  const f = fixture(p, { roles: false });
  // Read the persisted run synchronously when the host emits the delivered tool result.
  const runsDirectory = () => { const base = join(work, ".pi/workflows/projects"); return existsSync(base) ? readdirSync(base).map((project) => join(base, project, "sessions/deliver/runs")).filter((path) => existsSync(path)).flatMap((path) => readdirSync(path).map((run) => join(path, run))) : []; };
  let atDelivery;
  const result = await pi(f, rootCalls(["workflow", { name: "deliver", foreground: true, script: `return await agent(${JSON.stringify(steps("deliver", { result: "DELIVERED_VALUE" }))}, {label:'deliver'});` }]), { session: "deliver", onEvent(event) {
    if (event.type !== "tool_execution_end" || event.toolName !== "workflow" || atDelivery) return;
    const [run] = runsDirectory();
    const read = (name) => { try { return readFileSync(join(run, name), "utf8"); } catch { return ""; } };
    atDelivery = { state: read("state.json"), result: read("result.json") };
  } });
  const end = toolEnds(result.stdout, "workflow")[0];
  t.check(result.code === 0 && /DELIVERED_VALUE/.test(resultText(end)), "foreground workflow tool result delivered", resultText(end).slice(0, 300));
  t.check(/"completed"/.test(atDelivery?.state ?? "") && /DELIVERED_VALUE/.test(atDelivery?.result ?? ""), "terminal state and result were already persisted when the tool result was emitted", atDelivery);
  const [loaded] = await runsOf(f, "deliver");
  t.check(loaded?.run.state === "completed" && loaded.run.agents.every((agent) => agent.state === "completed"), "terminal run and agent states persisted", loaded?.run.state);
  t.note(`persisted delivery=${JSON.stringify(loaded?.run.delivery ?? null)}`);
});

// ---- Main --------------------------------------------------------------------------------------
await new Promise((accept) => { server.listen(0, "127.0.0.1", accept); });
const baseUrl = `http://127.0.0.1:${String(server.address().port)}/v1`;
try {
  const products = [await installProduct("new", resolve(argv[0]))];
  if (option("--legacy")) legacy = await installProduct("legacy", resolve(option("--legacy")));
  if (option("--old")) products.push(await installProduct("old", resolve(option("--old"))));
  for (const product of products) for (const item of cases) if (product.kind === "new" || item.old !== "none") await execute(product, item);
  const regressions = results.filter((value) => value.product === "new" && value.outcome === "fail");
  const controls = results.filter((value) => value.product === "old" && value.outcome === "deviated");
  if (report) json(resolve(report), { results, root, requests: requests.map((value) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== "payload"))) });
  console.log(`pre6 parity: ${String(results.filter((value) => value.product === "new" && value.outcome === "pass").length)} new passed, ${String(regressions.length)} new failed; ${String(controls.length)} pre6 controls deviated; ${String(requests.length)} local provider requests.`);
  process.exitCode = regressions.length || controls.length ? 1 : 0;
} finally {
  killTarget?.kill("SIGKILL");
  server.closeAllConnections(); await new Promise((accept) => { server.close(accept); });
  if (process.env.E2E_KEEP !== "1") rmSync(work, { recursive: true, force: true });
  else console.log(`kept ${work}`);
}
