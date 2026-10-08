import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { readCliTestManifest } from "./support.js";

// Pre-6 contract: bundled factories run without a Pi API, so guarded native registrations are skipped in the recipient.
const cli = resolve("dist/src/cli.js");
const input = { type: "object", properties: { value: { type: "integer" } }, required: ["value"], additionalProperties: false };
const source = [
  'import { registerWorkflowExtension } from "pi-extensible-workflows";',
  "export default function extension(pi) {",
  "  if (pi) {",
  '    pi.registerCommand("guarded-native", { description: "Native Pi command", handler: async () => {} });',
  '    pi.on("session_start", () => {});',
  "  }",
  `  registerWorkflowExtension({ version: "1.0.0", headline: "Guarded", source: import.meta.url, functions: { guardedFactory: { description: "Guarded factory", input: ${JSON.stringify(input)}, output: { type: "integer" }, async run(input) { return input.value; } } } });`,
  "}",
  "",
].join("\n");
const resource = [
  'import { registerWorkflowExtension } from "pi-extensible-workflows";',
  "export default function resource(pi) {",
  '  if (pi) pi.on("session_start", () => {});',
  '  registerWorkflowExtension({ version: "1.0.0", headline: "Resource", functions: { guardedResource: { description: "Resource", input: { type: "object" }, output: { type: "string" }, run() { return "resource"; } } } });',
  "}",
  "",
].join("\n");

type Result = { status: number | null; stdout: string; stderr: string };

function environment(root: string, agentDir: string): NodeJS.ProcessEnv {
  return { PATH: `${resolve("../../node_modules/.bin")}${delimiter}${process.env.PATH ?? ""}`, HOME: join(root, "home"), PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NO_COLOR: "1" };
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Result {
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function writeExtension(directory: string, core: string): string {
  mkdirSync(join(directory, "node_modules"), { recursive: true });
  symlinkSync(core, join(directory, "node_modules", "pi-extensible-workflows"));
  const path = join(directory, "guarded.mjs");
  writeFileSync(path, source);
  return path;
}

// Uses the real `piewf bundle` entrypoint; the source extension loads through Pi with a real `pi` API.
function bundleGuarded(t: TestContext): { root: string; bundle: string; sourcePath: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "piewf-bundle-native-factory-")));
  t.after(() => { rmSync(root, { recursive: true, force: true }); });
  const project = join(root, "project");
  const agentDir = join(root, "source-agent");
  mkdirSync(join(project, "node_modules"), { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true });
  symlinkSync(resolve("../../node_modules/esbuild"), join(project, "node_modules", "esbuild"));
  const sourcePath = writeExtension(join(root, "source"), resolve("../core"));
  const resourcePath = join(root, "resource.mjs");
  writeFileSync(resourcePath, resource);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [sourcePath] }));
  const bundle = join(root, "bundle");
  const bundled = run(process.execPath, [cli, "bundle", "guardedFactory", "--name", "guarded", "--output", bundle, "--extension", resourcePath], project, environment(root, agentDir));
  assert.equal(bundled.status, 0, bundled.stderr);
  assert.deepEqual(readCliTestManifest(join(bundle, "manifest.json")).payload?.extensions, ["resource.mjs"]);
  return { root, bundle, sourcePath };
}

function setupAndLaunch(root: string, bundle: string, agentDir: string): { setup: Result; launch: Result } {
  const project = join(root, "recipient-project");
  mkdirSync(project, { recursive: true });
  const env = environment(root, agentDir);
  const launcher = join(bundle, "guarded");
  return { setup: run(launcher, ["setup", "--yes"], project, env), launch: run(launcher, ["7"], project, env) };
}

void test("bundled guarded registerCommand and pi.on factories set up and launch in a recipient without the source extension", (t) => {
  const { root, bundle } = bundleGuarded(t);
  const agentDir = join(root, "recipient-agent");
  mkdirSync(join(agentDir, "npm", "node_modules", "@piewf"), { recursive: true });
  symlinkSync(process.cwd(), join(agentDir, "npm", "node_modules", "@piewf", "cli"));
  const { setup, launch } = setupAndLaunch(root, bundle, agentDir);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /Bundle setup complete\./);
  assert.equal(launch.status, 0, launch.stderr);
  assert.equal(launch.stdout, "7\n");
  assert.doesNotMatch(launch.stderr, /Warning:|Error/);
});

void test("packed engine sets up and launches a guarded bundle when the recipient also loads the source extension", (t) => {
  const { root, bundle } = bundleGuarded(t);
  const tarballs = join(root, "tarballs");
  mkdirSync(tarballs);
  for (const workspace of ["../core", "."]) execFileSync("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", tarballs], { cwd: resolve(workspace), stdio: "pipe", timeout: 120_000 });
  const agentDir = join(root, "recipient-agent");
  const modules = join(agentDir, "npm", "node_modules");
  const core = join(modules, "pi-extensible-workflows");
  const engine = join(modules, "@piewf", "cli");
  mkdirSync(core, { recursive: true });
  mkdirSync(engine, { recursive: true });
  const workspaceModules = resolve("../../node_modules");
  for (const name of readdirSync(workspaceModules)) if (name !== "pi-extensible-workflows" && name !== "@piewf" && name !== ".bin") symlinkSync(join(workspaceModules, name), join(modules, name));
  for (const tarball of readdirSync(tarballs)) execFileSync("tar", ["-xzf", join(tarballs, tarball), "-C", tarball.startsWith("piewf-cli-") ? engine : core, "--strip-components=1"], { stdio: "pipe" });
  assert.equal(existsSync(join(engine, "dist", "src", "cli.js")), true);
  assert.equal(existsSync(join(core, "dist", "src", "index.js")), true);
  const recipientSource = writeExtension(join(root, "recipient-source"), core);
  writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ extensions: [recipientSource] }));
  const detached = join(root, "detached-bundle");
  cpSync(bundle, detached, { recursive: true });
  rmSync(bundle, { recursive: true, force: true });
  const { setup, launch } = setupAndLaunch(root, detached, agentDir);
  assert.equal(setup.status, 0, setup.stderr);
  assert.match(setup.stdout, /@piewf\/cli: \d+\.\d+\.\d+/);
  assert.equal(launch.status, 0, launch.stderr);
  assert.equal(launch.stdout, "7\n");
  assert.match(launch.stderr, /Warning: .*recipient-source\/guarded\.mjs: .*Global name is already registered: guardedFactory/);
});

void test("bundled registrations keep their bundled module source while factories still run without a Pi API", async (t) => {
  const { bundle } = bundleGuarded(t);
  const registered: Array<{ source?: string; functions?: Record<string, unknown> }> = [];
  const payload = await import(pathToFileURL(join(bundle, "payload", "workflow.mjs")).href) as { register: (register: (extension: { source?: string; functions?: Record<string, unknown> }) => void) => Promise<void> };
  await payload.register((extension) => { registered.push(extension); });
  const sourceOf = (name: string) => registered.find((extension) => extension.functions?.[name] !== undefined)?.source;
  assert.equal(sourceOf("guardedResource"), pathToFileURL(join(bundle, "payload", "extensions", "resource.mjs")).href, "a secondary bundled module stays attributed for catalog provenance and re-export");
  assert.equal(sourceOf("guardedFactory"), pathToFileURL(join(bundle, "payload", "extension.mjs")).href);
});

// A bundle's own preparation hook registered before Pi loads the recipient's extensions is proven to have loaded, so an
// unrelated recipient load failure must not turn its declared option into an ownerless one.
const hooked = [
  'import { registerWorkflowExtension } from "pi-extensible-workflows";',
  "export default function extension() {",
  '  registerWorkflowExtension({ version: "1.0.0", headline: "Bundled audit", source: import.meta.url,',
  '    functions: { bundledAudit: { description: "Audit", input: { type: "object", properties: {}, additionalProperties: false }, output: { type: "string" }, async run(_input, context) { return await context.agent("TASK", { persona: "auditor" }); } } },',
  '    agentPreparationHooks: { persona: { optionsSchema: { type: "object", properties: { persona: { type: "string" } }, additionalProperties: true }, prepare(configuration, context) { if (context.options.persona === "auditor") configuration.tools = ["!*", "read"]; } } } });',
  "}",
  "",
].join("\n");

void test("a bundled preparation hook keeps owning its option beside an unrelated recipient load failure", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "piewf-bundle-hook-")));
  t.after(() => { rmSync(root, { recursive: true, force: true }); });
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
      response.end(`${chunk({ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: "result", type: "function", function: { name: "workflow_result", arguments: JSON.stringify({ result: "audited" }) } }] }, finish_reason: null })}${chunk({ index: 0, delta: {}, finish_reason: "tool_calls" })}data: [DONE]\n\n`);
    });
  });
  await new Promise<void>((accept) => { server.listen(0, "127.0.0.1", accept); });
  t.after(async () => { server.closeAllConnections(); await new Promise((accept) => server.close(accept)); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const project = join(root, "project");
  const sourceAgent = join(root, "source-agent");
  mkdirSync(join(project, "node_modules"), { recursive: true });
  mkdirSync(join(sourceAgent), { recursive: true });
  mkdirSync(join(root, "home"), { recursive: true });
  symlinkSync(resolve("../../node_modules/esbuild"), join(project, "node_modules", "esbuild"));
  const sourceDirectory = join(root, "source");
  mkdirSync(join(sourceDirectory, "node_modules"), { recursive: true });
  symlinkSync(resolve("../core"), join(sourceDirectory, "node_modules", "pi-extensible-workflows"));
  writeFileSync(join(sourceDirectory, "hooked.mjs"), hooked);
  writeFileSync(join(sourceAgent, "settings.json"), JSON.stringify({ extensions: [join(sourceDirectory, "hooked.mjs")] }));
  const bundle = join(root, "bundle");
  const bundled = run(process.execPath, [cli, "bundle", "bundledAudit", "--name", "audit", "--output", bundle], project, environment(root, sourceAgent));
  assert.equal(bundled.status, 0, bundled.stderr);
  const launch = async (extensions: string[]) => {
    const agentDir = join(root, `recipient-${String(extensions.length)}`);
    mkdirSync(join(agentDir, "npm", "node_modules", "@piewf"), { recursive: true });
    symlinkSync(process.cwd(), join(agentDir, "npm", "node_modules", "@piewf", "cli"));
    writeFileSync(join(agentDir, "models.json"), JSON.stringify({ providers: { fixture: { baseUrl: `http://127.0.0.1:${String(address.port)}/v1`, api: "openai-completions", apiKey: "fixture", models: [{ id: "root", name: "root", reasoning: false, input: ["text"], contextWindow: 100_000, maxTokens: 1_000 }] } } }));
    writeFileSync(join(agentDir, "auth.json"), "{}");
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ defaultProvider: "fixture", defaultModel: "root", defaultThinkingLevel: "off", extensions }));
    const recipient = join(root, `recipient-project-${String(extensions.length)}`);
    mkdirSync(recipient, { recursive: true });
    const env = environment(root, agentDir);
    assert.equal(run(join(bundle, "audit"), ["setup", "--yes"], recipient, env).status, 0);
    return new Promise<Result>((accept) => {
      const child = spawn(join(bundle, "audit"), [], { cwd: recipient, env });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8").on("data", (value: string) => { stdout += value; });
      child.stderr.setEncoding("utf8").on("data", (value: string) => { stderr += value; });
      child.on("close", (status) => { accept({ status, stdout, stderr }); });
    });
  };
  const healthy = await launch([]);
  assert.equal(healthy.status, 0, healthy.stderr);
  const broken = join(root, "broken.mjs");
  writeFileSync(broken, 'export default function () { throw new Error("RECIPIENT_UNRELATED_FAILURE"); }\n');
  const degraded = await launch([broken]);
  assert.equal(degraded.status, 0, degraded.stderr);
  assert.match(degraded.stderr, /Warning: .*broken\.mjs: .*RECIPIENT_UNRELATED_FAILURE/);
  assert.equal(degraded.stdout, "\"audited\"\n");
  assert.deepEqual(requests, [["read", "workflow_result"], ["read", "workflow_result"]], "the bundled hook restricts tools in both recipients");
});
