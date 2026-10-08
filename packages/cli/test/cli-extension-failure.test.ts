import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test, { type TestContext } from "node:test";

// Pre-6 contract: an unrelated extension load failure does not block the headless CLI; it is reported on stderr.
const cli = resolve("dist/src/cli.js");
const loadFailure = "UNRELATED_EXTENSION_FAILURE";
const warning = new RegExp(`Warning: .*broken\\.mjs: .*${loadFailure}`);
const input = { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false };

type Fixture = { root: string; cwd: string; agentDir: string; run: (args: readonly string[]) => { status: number | null; stdout: string; stderr: string } };

function fixture(t: TestContext, extensions: Record<string, string>): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "piewf-cli-extension-failure-")));
  t.after(() => { rmSync(root, { recursive: true, force: true }); });
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const extensionDir = join(root, "extensions");
  mkdirSync(join(cwd, "node_modules"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(extensionDir, "node_modules"), { recursive: true });
  symlinkSync(resolve("../core"), join(extensionDir, "node_modules", "pi-extensible-workflows"));
  symlinkSync(resolve("../../node_modules/esbuild"), join(cwd, "node_modules", "esbuild"));
  const paths = Object.entries(extensions).map(([name, source]) => {
    const path = join(extensionDir, name);
    writeFileSync(path, source);
    return path;
  });
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: paths }));
  writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "test" } }));
  const env = { PATH: process.env.PATH ?? "", HOME: root, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NO_COLOR: "1" };
  return { root, cwd, agentDir, run: (args) => {
    const result = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8", timeout: 60_000 });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  } };
}

function workflowExtension(name: string, beforeRegister = ""): string {
  return [
    'import { registerWorkflowExtension } from "pi-extensible-workflows";',
    "export default function extension() {",
    beforeRegister,
    `  registerWorkflowExtension({ version: "1.0.0", headline: ${JSON.stringify(name)}, source: import.meta.url, functions: { ${name}: { description: ${JSON.stringify(name)}, input: ${JSON.stringify(input)}, output: { type: "integer" }, async run(input) { return input.value; } } } });`,
    "}",
    "",
  ].join("\n");
}

const healthy = workflowExtension("cliHealthy");
const broken = workflowExtension("cliBroken", `  throw new Error(${JSON.stringify(loadFailure)});`);

void test("run, run --script, export, and bundle tolerate an unrelated failed extension with stderr diagnostics", (t) => {
  const paths = fixture(t, { "healthy.mjs": healthy, "broken.mjs": broken });
  writeFileSync(join(paths.cwd, "workflow.js"), "return true;\n");

  const script = paths.run(["run", "--script", "workflow.js"]);
  assert.equal(script.status, 0, script.stderr);
  assert.equal(script.stdout, "true\n");
  assert.match(script.stderr, warning);
  assert.match(script.stderr, /Run ID: [0-9a-f-]+/);

  const named = paths.run(["run", "cliHealthy", "--value", "3"]);
  assert.equal(named.status, 0, named.stderr);
  assert.equal(named.stdout, "3\n");
  assert.match(named.stderr, warning);

  const launcher = join(paths.root, "bin", "cli-healthy");
  const exported = paths.run(["export", "cliHealthy", "--output", launcher]);
  assert.equal(exported.status, 0, exported.stderr);
  assert.equal(existsSync(launcher), true);
  assert.match(exported.stderr, warning);

  const bundle = join(paths.root, "bundle");
  const bundled = paths.run(["bundle", "cliHealthy", "--name", "cli-healthy", "--output", bundle]);
  assert.equal(bundled.status, 0, bundled.stderr);
  assert.equal(existsSync(join(bundle, "manifest.json")), true);
  assert.match(bundled.stderr, warning);
});

void test("CLI entrypoints still fail when the requested workflow belongs to the failed extension", (t) => {
  const paths = fixture(t, { "healthy.mjs": healthy, "broken.mjs": broken });
  writeFileSync(join(paths.cwd, "workflow.js"), "return await cliBroken(args);\n");

  const script = paths.run(["run", "--script", "workflow.js", "--input", '{"value":1}']);
  assert.equal(script.status, 1);
  assert.equal(script.stdout, "");
  assert.match(script.stderr, warning);
  assert.match(script.stderr, /Run ID: [0-9a-f-]+/);
  assert.match(script.stderr, /cliBroken is not defined/);

  for (const args of [["run", "cliBroken", "--value", "1"], ["export", "cliBroken", "--output", join(paths.root, "bin", "cli-broken")], ["bundle", "cliBroken", "--output", join(paths.root, "broken-bundle")]]) {
    const result = paths.run(args);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, warning);
    assert.match(result.stderr, /Error: Unknown workflow function: cliBroken/);
  }
  assert.equal(existsSync(join(paths.root, "bin", "cli-broken")), false);
  assert.equal(existsSync(join(paths.root, "broken-bundle")), false);
});

void test("CLI initialization fails with load diagnostics when the workflow tool is truly unavailable", (t) => {
  // A loaded extension owns the `workflow` tool name, so Pi omits the replaceable CLI runtime, but it cannot execute.
  const shadow = 'export default function extension(pi) { pi.registerTool({ name: "workflow", label: "Workflow", description: "Not executable", parameters: { type: "object", properties: {} } }); }\n';
  const paths = fixture(t, { "shadow.mjs": shadow, "broken.mjs": broken });
  writeFileSync(join(paths.cwd, "workflow.js"), "return true;\n");
  for (const args of [["run", "--script", "workflow.js"], ["run", "cliBroken", "--value", "1"], ["export", "cliBroken"], ["bundle", "cliBroken"]]) {
    const result = paths.run(args);
    assert.equal(result.status, 1, args.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /^Error: The workflow runtime could not be initialized\n.*broken\.mjs: .*UNRELATED_EXTENSION_FAILURE/m);
    assert.doesNotMatch(result.stderr, /Run ID|Warning:/);
  }
});

// A configured preparation plugin that restricts tools, as a role plugin does, declares the option it owns and its source.
function personaPlugin({ before = "", after = "", source = true }: { before?: string; after?: string; source?: boolean } = {}): string {
  return persona.replace("BEFORE_REGISTER", before).replace("AFTER_REGISTER", after).replace("SOURCE", source ? "source: import.meta.url," : "");
}
const persona = [
  'import { registerWorkflowExtension } from "pi-extensible-workflows";',
  "export default function extension() {",
  "  BEFORE_REGISTER",
  '  registerWorkflowExtension({ version: "1.0.0", headline: "Persona", SOURCE agentPreparationHooks: { persona: { optionsSchema: { type: "object", properties: { persona: { type: "string" } }, additionalProperties: true }, prepare(configuration, context) { if (context.options.persona === "auditor") configuration.tools = ["!*", "read"]; } } } });',
  "  AFTER_REGISTER",
  "}",
  "",
].join("\n");

async function providerFixture(t: TestContext, extensions: Record<string, string>) {
  const requests: string[][] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      const payload = JSON.parse(body) as { tools?: Array<{ function?: { name?: string } }> };
      requests.push((payload.tools ?? []).map((tool) => tool.function?.name ?? "").sort());
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "close" });
      const chunk = (choice: Record<string, unknown>) => `data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "fixture", choices: [choice] })}\n\n`;
      response.end(`${chunk({ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "result", type: "function", function: { name: "workflow_result", arguments: JSON.stringify({ result: "agent-ok" }) } }] }, finish_reason: null })}${chunk({ index: 0, delta: {}, finish_reason: "tool_calls" })}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((accept) => { server.listen(0, "127.0.0.1", accept); });
  t.after(async () => { server.closeAllConnections(); await new Promise((accept) => server.close(accept)); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const paths = fixture(t, extensions);
  writeFileSync(join(paths.agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id: "root", name: "root", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1_000 }] } } }));
  const settingsPath = join(paths.agentDir, "settings.json");
  writeFileSync(settingsPath, JSON.stringify({ ...JSON.parse(readFileSync(settingsPath, "utf8")) as object, defaultProvider: "fixture", defaultModel: "root", defaultThinkingLevel: "off" }));
  const env = { PATH: process.env.PATH ?? "", HOME: paths.root, PI_CODING_AGENT_DIR: paths.agentDir, PI_OFFLINE: "1", NO_COLOR: "1" };
  const run = (script: string) => new Promise<{ status: number | null; stdout: string; stderr: string }>((accept) => {
    writeFileSync(join(paths.cwd, "workflow.js"), script);
    const child = spawn(process.execPath, [cli, "run", "--script", "workflow.js"], { cwd: paths.cwd, env });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
    child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
    child.on("close", (status) => { accept({ status, stdout, stderr }); });
  });
  return { ...paths, requests, run };
}

function unprovenRegistrations(headline: string): RegExp { return new RegExp(`Extensions failed to load, and these workflow registrations cannot be proven to come from a loaded extension: .*${headline}`); }

void test("a factory that fails after registering cannot leave executable hooks or functions behind", async (t) => {
  const marker = "MARKER_WRITTEN";
  const resetting = [
    'import { writeFileSync } from "node:fs";',
    'import { registerWorkflowExtension } from "pi-extensible-workflows";',
    "export default function extension() {",
    `  registerWorkflowExtension({ version: "1.0.0", headline: "Resetting", source: import.meta.url, functions: { orphanFunction: { description: "Orphan", input: ${JSON.stringify(input)}, output: { type: "integer" }, async run(input) { writeFileSync(${JSON.stringify(marker)}, "x"); return input.value; } } }, agentPreparationHooks: { reset: { priority: 99, prepare(configuration) { configuration.tools = ["*"]; } } } });`,
    '  throw new Error("ORPHAN_FAILURE");',
    "}",
    "",
  ].join("\n");
  const paths = await providerFixture(t, { "persona.mjs": personaPlugin(), "resetting.mjs": resetting });
  const hook = await paths.run('return await agent("task", { persona: "auditor" });\n');
  assert.equal(hook.status, 1, hook.stderr);
  assert.match(hook.stderr, unprovenRegistrations("Resetting"));
  assert.match(hook.stderr, /ORPHAN_FAILURE/);
  const fn = await paths.run("return await orphanFunction({ value: 1 });\n");
  assert.equal(fn.status, 1, fn.stderr);
  assert.match(fn.stderr, unprovenRegistrations("Resetting"));
  assert.deepEqual(paths.requests, [], "nothing reached the provider");
  assert.equal(existsSync(join(paths.cwd, marker)), false, "the orphaned function never ran");
  // Control: the same healthy plugin alone restricts tools to read.
  const control = await providerFixture(t, { "persona.mjs": personaPlugin() });
  assert.equal((await control.run('return await agent("task", { persona: "auditor" });\n')).status, 0);
  assert.deepEqual(control.requests, [["read", "workflow_result"]]);
});

void test("a failed preparation plugin cannot leave its option silently ignored, unlike an intentionally absent plugin", async (t) => {
  const marker = "MARKER_WRITTEN";
  const script = `await shell("printf x > ${marker}"); return await agent("task", { persona: "auditor" });\n`;
  const failed = await providerFixture(t, { "persona.mjs": personaPlugin({ before: `throw new Error(${JSON.stringify(loadFailure)});` }) });
  const rejected = await failed.run(script);
  assert.equal(rejected.status, 1, rejected.stderr);
  assert.match(rejected.stderr, /Warning: .*persona\.mjs: .*UNRELATED_EXTENSION_FAILURE/);
  assert.match(rejected.stderr, /persona has no owner proven to have loaded while extensions failed to load: .*persona\.mjs/);
  assert.deepEqual(failed.requests, [], "no provider request after a fail-closed launch");
  assert.equal(existsSync(join(failed.cwd, marker)), false, "rejected before shell effects");

  // A factory that registers its hook and then throws leaves an orphaned registration, with or without a source:
  // the CLI stops before running anything.
  for (const source of [true, false]) {
    const late = await providerFixture(t, { "persona.mjs": personaPlugin({ after: `throw new Error(${JSON.stringify(loadFailure)});`, source }) });
    const orphaned = await late.run(script);
    assert.equal(orphaned.status, 1, orphaned.stderr);
    assert.match(orphaned.stderr, unprovenRegistrations("Persona"));
    assert.deepEqual(late.requests, []);
    assert.equal(existsSync(join(late.cwd, marker)), false);
  }

  const healthy = await providerFixture(t, { "persona.mjs": personaPlugin(), "broken.mjs": broken });
  const restricted = await healthy.run(script);
  assert.equal(restricted.status, 0, restricted.stderr);
  assert.match(restricted.stderr, warning);
  assert.equal(restricted.stdout, "\"agent-ok\"\n");
  assert.deepEqual(healthy.requests, [["read", "workflow_result"]], "the loaded plugin still restricts tools beside an unrelated failure");

  // Without a declared source, a registration cannot be proven to come from a loaded extension beside a failure: the
  // documented restriction stops the CLI.
  const unproven = await providerFixture(t, { "persona.mjs": personaPlugin({ source: false }), "broken.mjs": broken });
  const uncertain = await unproven.run(script);
  assert.equal(uncertain.status, 1, uncertain.stderr);
  assert.match(uncertain.stderr, unprovenRegistrations("Persona"));
  assert.deepEqual(unproven.requests, []);

  const absent = await providerFixture(t, {});
  const ignored = await absent.run(script);
  assert.equal(ignored.status, 0, ignored.stderr);
  assert.doesNotMatch(ignored.stderr, /Warning:/);
  assert.ok((absent.requests[0] ?? []).includes("write"), "an intentionally absent plugin leaves its option ignored");

  const unrelated = await providerFixture(t, { "broken.mjs": broken });
  const plain = await unrelated.run('return await agent("task", { label: "core-only" });\n');
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stderr, warning);
  assert.equal(unrelated.requests.length, 1);
});
