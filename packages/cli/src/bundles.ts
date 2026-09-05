import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { AgentDefinition, WorkflowCatalogFunction } from "pi-extensible-workflows";

export interface PortableWorkflowManifest {
  format: "pi-extensible-workflows-bundle";
  version: 1;
  command: string;
  workflow: { name: string; description: string; input: Record<string, unknown>; output: Record<string, unknown> };
  runtime: { pi: string; "@piewf/cli": string };
  requirements: { roles: readonly string[]; aliases: readonly string[]; tools: readonly string[]; commands: readonly string[]; environment: readonly string[] };
  aliasTargets?: Readonly<Record<string, string>>;
  payload?: { extensions?: readonly string[]; skills?: readonly string[]; static?: readonly string[]; dependencies?: readonly string[] };
}

export interface PortableWorkflowBundleResources {
  extensions?: readonly string[];
  skills?: readonly string[];
  static?: readonly string[];
  dependencies?: readonly string[];
}

export interface PortableWorkflowBundleInput {
  destination: string;
  command: string;
  workflow: WorkflowCatalogFunction;
  functionSource: string;
  piVersion?: string;
  engineVersion?: string;
  force?: boolean;
  requirements?: Partial<PortableWorkflowManifest["requirements"]>;
  aliasTargets?: Readonly<Record<string, string>>;
  roles?: Readonly<Record<string, AgentDefinition>>;
  resources?: PortableWorkflowBundleResources;
}

type PackageMetadata = {
  name?: string;
  version?: string;
  bin?: string | Record<string, string>;
};

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isJsonObject(value) ? value : undefined;
  } catch { return undefined; }
}

function readPackageMetadata(path: string): PackageMetadata | undefined {
  const value = readJsonObject(path);
  if (!value) return undefined;
  const metadata: PackageMetadata = {};
  if (typeof value.name === "string") metadata.name = value.name;
  if (typeof value.version === "string") metadata.version = value.version;
  if (typeof value.bin === "string") metadata.bin = value.bin;
  else if (isJsonObject(value.bin)) {
    const bin: Record<string, string> = {};
    let valid = true;
    for (const [name, entry] of Object.entries(value.bin)) {
      if (typeof entry !== "string") { valid = false; break; }
      bin[name] = entry;
    }
    if (valid) metadata.bin = bin;
  }
  return metadata;
}

function packageJson(): PackageMetadata {
  const directory = dirname(fileURLToPath(import.meta.url));
  for (const path of [join(directory, "../package.json"), join(directory, "../../package.json")]) {
    const metadata = readPackageMetadata(path);
    if (metadata) return metadata;
  }
  return {};
}

export function portableEngineVersion(): string {
  const version = packageJson().version;
  return typeof version === "string" && version.trim() ? version.trim() : "unknown";
}

export function portablePiVersion(): string {
  const command = process.platform === "win32" ? "pi.cmd" : "pi";
  const result = spawnSync(command, ["--version"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return "unknown";
  return result.stdout.trim().split(/\r?\n/, 1)[0] ?? "unknown";
}

function shellLauncher(): string {
  return "#!/bin/sh\nset -eu\nROOT=$(CDPATH= cd -- \"$(dirname -- \"$0\")\" && pwd)\nexec node \"$ROOT/payload/runner.mjs\" \"$@\"\n";
}

function windowsLauncher(): string {
  return "@echo off\r\nnode \"%~dp0payload\\runner.mjs\" %*\r\n";
}

function runnerSource(): string {
  return [
    "import { accessSync, constants, existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';",
    "import { homedir } from 'node:os';",
    "import { delimiter, dirname, join, sep } from 'node:path';",
    "import { createInterface } from 'node:readline/promises';",
    "import { spawnSync } from 'node:child_process';",
    "import { createRequire } from 'node:module';",
    "import { fileURLToPath, pathToFileURL } from 'node:url';",
    "const bundleRoot = dirname(dirname(fileURLToPath(import.meta.url)));",
    "const manifest = JSON.parse(readFileSync(join(bundleRoot, 'manifest.json'), 'utf8'));",
    "function bundleSkillPaths() { return (manifest.payload?.skills ?? []).map((name) => join(bundleRoot, 'payload', 'skills', name)); }",
    "function run(command, args) {",
    "  const result = spawnSync(command, args, { encoding: 'utf8' });",
    "  if (result.error) throw result.error;",
    "  return { status: result.status, stdout: String(result.stdout ?? ''), stderr: String(result.stderr ?? '') };",
    "}",
    "function piCommand() {",
    "  const names = process.platform === 'win32' ? ['pi.cmd', 'pi'] : ['pi'];",
    "  for (const entry of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {",
    "    for (const name of names) {",
    "      const candidate = join(entry, name);",
    "      try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* Continue searching PATH. */ }",
    "    }",
    "  }",
    "  throw new Error('Pi was not found on PATH. Install Pi through npm before running this bundle.');",
    "}",
    "function packageRoot(start) {",
    "  let current = dirname(realpathSync(start));",
    "  while (true) {",
    "    const candidates = [current, join(current, '..', '@earendil-works', 'pi-coding-agent'), join(current, '..', 'pi-coding-agent')];",
    "    for (const candidate of candidates) { try { const pkg = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8')); if (pkg.name === '@earendil-works/pi-coding-agent') return candidate; } catch { /* Continue to the next package candidate. */ } }",
    "    const parent = dirname(current);",
    "    if (parent === current) return undefined;",
    "    current = parent;",
    "  }",
    "}",
    "function assertNpmPi(pi) {",
    "  const resolved = realpathSync(pi);",
    "  if (!resolved.includes(`${sep}node_modules${sep}`) || !packageRoot(pi)) throw new Error('The pi executable is not an npm installation. Install Pi through npm and retry.');",
    "}",
    "function codingAgentIndex(pi) {",
    "  const root = packageRoot(pi);",
    "  const index = root && join(root, 'dist', 'index.js');",
    "  if (!index || !existsSync(index)) throw new Error('The npm Pi installation does not expose its SDK. Reinstall Pi through npm and retry.');",
    "  return index;",
    "}",
    "function packageVersion(root) {",
    "  try { return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version; } catch { return undefined; }",
    "}",
    "function versionParts(value) {",
    "  const match = /(?:^|[^0-9])(\\d+)\\.(\\d+)\\.(\\d+)(?:$|[^0-9])/.exec(String(value));",
    "  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;",
    "}",
    "function compare(left, right) { return left[0] - right[0] || left[1] - right[1] || left[2] - right[2]; }",
    "function rangeClauses(range) {",
    "  const clauses = String(range).trim().split(/\\s+/).map((token) => /^(>=|<=|>|<|=|~|\\^)?(\\d+)\\.(\\d+)\\.(\\d+)$/.exec(token));",
    "  return clauses.every(Boolean) ? clauses.map((match) => ({ operator: match[1] ?? '=', version: [Number(match[2]), Number(match[3]), Number(match[4])] })) : undefined;",
    "}",
    "function satisfies(value, range) {",
    "  if (range === 'unknown') return true;",
    "  const actual = versionParts(value);",
    "  const clauses = rangeClauses(range);",
    "  if (!actual || !clauses) return false;",
    "  return clauses.every(({ operator, version }) => {",
    "    if (operator === '=') return compare(actual, version) === 0;",
    "    if (operator === '>') return compare(actual, version) > 0;",
    "    if (operator === '>=') return compare(actual, version) >= 0;",
    "    if (operator === '<') return compare(actual, version) < 0;",
    "    if (operator === '<=') return compare(actual, version) <= 0;",
    "    const upper = operator === '~' ? [version[0], version[1] + 1, 0] : version[0] > 0 ? [version[0] + 1, 0, 0] : version[1] > 0 ? [0, version[1] + 1, 0] : [0, 0, version[2] + 1];",
    "    return compare(actual, version) >= 0 && compare(actual, upper) < 0;",
    "  });",
    "}",
    "function installationVersion(range) { return String(range).match(/\\d+\\.\\d+\\.\\d+/)?.[0] ?? 'unknown'; }",
    "async function engineCandidates(pi) {",
    "  const agent = await import(pathToFileURL(codingAgentIndex(pi)).href);",
    "  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');",
    "  const settings = agent.SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });",
    "  const manager = new agent.DefaultPackageManager({ cwd: process.cwd(), agentDir, settingsManager: settings });",
    "  const configured = manager.listConfiguredPackages();",
    "  const roots = configured.filter((entry) => /^npm:@piewf\\/cli(?:@|$)/.test(entry.source)).map((entry) => entry.installedPath);",
    "  roots.push(join(agentDir, 'npm', 'node_modules', '@piewf', 'cli'));",
    "  return [...new Set(roots.filter((root) => typeof root === 'string' && existsSync(join(root, 'package.json'))))];",
    "}",
    "async function findEngine(pi) {",
    "  for (const root of await engineCandidates(pi)) {",
    "    const version = packageVersion(root);",
    "    if (typeof version === 'string' && satisfies(version, manifest.runtime['@piewf/cli'])) return { root: realpathSync(root), version };",
    "  }",
    "  return undefined;",
    "}",
    "async function confirmInstall(pi, expected) {",
    "  const spec = `npm:@piewf/cli@${installationVersion(expected)}`;",
    "  if (!(process.stdin.isTTY && process.stderr.isTTY)) throw new Error(`The compatible @piewf/cli package is missing. Re-run '${manifest.command} setup --yes' to approve: ${pi} install ${spec}`);",
    "  const prompt = createInterface({ input: process.stdin, output: process.stderr });",
    "  try { const answer = await prompt.question(`Install ${spec} through Pi now? [y/N] `); return /^y(es)?$/i.test(answer.trim()); } finally { prompt.close(); }",
    "}",
    "async function ensureEngine(pi, allowInstall, approve) {",
    "  const expected = manifest.runtime['@piewf/cli'];",
    "  let engine = await findEngine(pi);",
    "  if (engine) return engine;",
    "  if (!allowInstall) throw new Error(`Compatible @piewf/cli${expected === 'unknown' ? '' : `@${expected}`} is not installed through Pi. Run '${manifest.command} setup' first; no installation is performed during launch.`);",
    "  if (expected === 'unknown') throw new Error('The bundle does not record a compatible @piewf/cli version. Re-export the bundle.');",
    "  if (!approve && !(await confirmInstall(pi, expected))) throw new Error('Installation was not approved.');",
    "  const spec = `npm:@piewf/cli@${installationVersion(expected)}`;",
    "  if (spec.endsWith('@unknown')) throw new Error('The bundle does not record a compatible @piewf/cli version. Re-export the bundle.');",
    "  const result = run(pi, ['install', spec]);",
    "  if (result.status !== 0) throw new Error(`Pi could not install ${spec}: ${result.stderr.trim() || 'installation failed'}`);",
    "  engine = await findEngine(pi);",
    "  if (!engine) throw new Error(`Pi installed an incompatible @piewf/cli version; expected ${expected}.`);",
    "  return engine;",
    "}",
    "function readJson(path) { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; } }",
    "function projectTrusted(agent, agentDir) {",
    "  const settings = agent.SettingsManager.create(process.cwd(), agentDir, { projectTrusted: false });",
    "  if (!agent.hasTrustRequiringProjectResources(process.cwd())) return true;",
    "  const saved = new agent.ProjectTrustStore(agentDir).get(process.cwd());",
    "  return saved === true || saved === null && settings.getDefaultProjectTrust() === 'always';",
    "}",
    "function workflowSettings(agent, agentDir) {",
    "  const global = readJson(join(agentDir, 'pi-extensible-workflows', 'settings.json'));",
    "  const project = projectTrusted(agent, agentDir) ? readJson(join(process.cwd(), '.pi', 'pi-extensible-workflows', 'settings.json')) : {};",
    "  return { ...(global.modelAliases ?? {}), ...(project.modelAliases ?? {}) };",
    "}",
    "function concreteModel(value) { return String(value).split(':', 1)[0]; }",
    "function qualifyModel(value, known) {",
    "  const concrete = concreteModel(value);",
    "  if (known.has(concrete)) return concrete;",
    "  const matches = [...known].filter((model) => model.endsWith('/' + concrete));",
    "  return matches.length === 1 ? matches[0] : concrete;",
    "}",
    "function resolveAlias(name, targets, settings, known, chain = []) {",
    "  const target = targets[name] ?? settings[name] ?? (known.has(name) ? name : undefined);",
    "  if (!target) { const matches = [...known].filter((model) => model.endsWith('/' + name)); return matches.length === 1 ? matches[0] : undefined; }",
    "  if (chain.includes(name)) throw new Error(`Model alias cycle: ${[...chain, name].join(' -> ')}`);",
    "  const concrete = concreteModel(target);",
    "  return targets[concrete] || settings[concrete] ? resolveAlias(concrete, targets, settings, known, [...chain, name]) : qualifyModel(concrete, known);",
    "}",
    "async function recipientInventory(pi) {",
    "  const agent = await import(pathToFileURL(codingAgentIndex(pi)).href);",
    "  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');",
    "  const modelRuntime = await agent.ModelRuntime.create({ authPath: join(agentDir, 'auth.json'), modelsPath: join(agentDir, 'models.json') });",
    "  const services = await agent.createAgentSessionServices({ cwd: process.cwd(), agentDir, modelRuntime, resourceLoaderOptions: { additionalSkillPaths: bundleSkillPaths(), noPromptTemplates: true, noThemes: true, noContextFiles: true } });",
    "  const knownModels = new Set(services.modelRuntime.getModels().map((model) => `${model.provider}/${model.id}`));",
    "  const availableModels = new Set((await services.modelRuntime.getAvailable()).map((model) => `${model.provider}/${model.id}`));",
    "  const sdkRoot = packageRoot(pi);",
    "  const toolsIndex = sdkRoot && join(sdkRoot, 'dist', 'core', 'tools', 'index.js');",
    "  if (!toolsIndex || !existsSync(toolsIndex)) throw new Error('The npm Pi installation does not expose its built-in tool inventory. Reinstall Pi through npm and retry.');",
    "  const toolsModule = await import(pathToFileURL(toolsIndex).href);",
    "  if (!(toolsModule.allToolNames instanceof Set)) throw new Error('The npm Pi installation does not expose its built-in tool inventory. Reinstall Pi through npm and retry.');",
    "  const tools = new Set(toolsModule.allToolNames);",
    "  for (const extension of services.resourceLoader.getExtensions().extensions) for (const tool of extension.tools.keys()) tools.add(tool);",
    "  return { agent, agentDir, knownModels, availableModels, tools };",
    "}",
    "async function dynamicAliasTargets(api, inventory, settings) {",
    "  const targets = {};",
    "  const registry = typeof api.loadingRegistry === 'function' ? api.loadingRegistry() : undefined;",
    "  const aliases = new Map((registry?.modelAliases?.() ?? []).map((alias) => [alias.name, alias]));",
    "  const first = [...inventory.knownModels][0] ?? 'unknown/unknown';",
    "  const separator = first.indexOf('/');",
    "  const rootModel = { provider: separator < 0 ? '' : first.slice(0, separator), model: separator < 0 ? first : first.slice(separator + 1) };",
    "  for (const name of manifest.requirements.aliases) {",
    "    if (manifest.aliasTargets?.[name] || settings[name]) continue;",
    "    const alias = aliases.get(name);",
    "    if (!alias) continue;",
    "    const target = await alias.resolve({ cwd: process.cwd(), projectTrusted: projectTrusted(inventory.agent, inventory.agentDir), rootModel, knownModels: new Set(inventory.knownModels), availableModels: new Set(inventory.availableModels), signal: new AbortController().signal });",
    "    if (typeof target !== 'string' || !target.trim()) throw new Error(`Model alias resolver returned an invalid target for ${name}.`);",
    "    targets[name] = target.trim();",
    "  }",
    "  return targets;",
    "}",
    "async function checkRequirements(pi, api) {",
    "  const inventory = await recipientInventory(pi);",
    "  for (const command of manifest.requirements.commands) {",
    "    const result = spawnSync(command, ['--version'], { stdio: 'ignore' });",
    "    if (result.error || result.status !== 0) throw new Error(`Missing required external command: ${command}`);",
    "  }",
    "  for (const name of manifest.requirements.environment) if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);",
    "  for (const tool of manifest.requirements.tools) if (!inventory.tools.has(tool)) throw new Error(`Required Pi tool is unavailable: ${tool}. Enable the tool or install the extension that provides it.`);",
    "  const settings = workflowSettings(inventory.agent, inventory.agentDir);",
    "  const dynamicTargets = await dynamicAliasTargets(api, inventory, settings);",
    "  const targets = { ...dynamicTargets, ...(manifest.aliasTargets ?? {}) };",
    "  for (const name of manifest.requirements.aliases) {",
    "    const target = resolveAlias(name, targets, settings, inventory.knownModels);",
    "    if (!target || !inventory.knownModels.has(target)) throw new Error(`Required model alias is unknown: ${name}${target ? ` (resolved target: ${target})` : ''}. Pi does not recognize this model.`);",
    "    if (!inventory.availableModels.has(target)) throw new Error(`Required model alias is unavailable: ${name} -> ${target}. Configure authentication for this model before launching the bundle.`);",
    "  }",
    "}",
    "function piVersion(pi) {",
    "  const result = run(pi, ['--version']);",
    "  return result.status === 0 ? result.stdout.trim().split(/\\r?\\n/, 1)[0] : 'unknown';",
    "}",
    "function assertPiVersion(pi) {",
    "  const expected = manifest.runtime.pi;",
    "  const actual = piVersion(pi);",
    "  if (!satisfies(actual, expected)) throw new Error(`Bundle requires Pi ${expected}; found ${actual}.`);",
    "}",
    "function saveState(pi, engine) {",
    "  writeFileSync(join(bundleRoot, 'bundle-state.json'), JSON.stringify({ format: manifest.format, version: manifest.version, pi: piVersion(pi), engine: engine.version, checkedAt: new Date().toISOString() }, null, 2) + '\\n', { mode: 0o600 });",
    "}",
    "function assertSetupState(pi, engine) {",
    "  const state = readJson(join(bundleRoot, 'bundle-state.json'));",
    "  if (state.format !== manifest.format || state.version !== manifest.version || typeof state.checkedAt !== 'string' || !satisfies(state.pi, manifest.runtime.pi) || !satisfies(state.engine, manifest.runtime['@piewf/cli'])) throw new Error(`Bundle setup is missing or stale. Run '${manifest.command} setup' before launching.`);",
    "}",
    "async function loadPayload(engine) {",
    "  const engineIndex = pathToFileURL(createRequire(pathToFileURL(join(engine.root, 'dist', 'src', 'cli.js'))).resolve('pi-extensible-workflows')).href;",
    "  const api = await import(engineIndex);",
    "  globalThis.__pi_bundle_api = api;",
    "  const payload = await import(pathToFileURL(join(bundleRoot, 'payload', 'workflow.mjs')).href + '?bundle=' + String(Date.now()));",
    "  await payload.register(api.registerWorkflowExtension);",
    "  return { api, payload };",
    "}",
    "async function setup(argv) {",
    "  if (argv.some((arg) => arg !== '--yes' && arg !== '--help' && arg !== '-h')) throw new Error('Usage: ' + manifest.command + ' setup [--yes]');",
    "  if (argv.includes('--help') || argv.includes('-h')) { console.log('Usage: ' + manifest.command + ' setup [--yes]'); return; }",
    "  const approve = argv.includes('--yes');",
    "  const pi = piCommand();",
    "  assertNpmPi(pi);",
    "  assertPiVersion(pi);",
    "  const engine = await ensureEngine(pi, true, approve);",
    "  const { api } = await loadPayload(engine);",
    "  await checkRequirements(pi, api);",
    "  saveState(pi, engine);",
    "  console.log('Bundle setup complete.');",
    "  console.log('Pi: ' + piVersion(pi));",
    "  console.log('@piewf/cli: ' + engine.version);",
    "}",
    "async function launch(argv) {",
    "  const pi = piCommand();",
    "  assertNpmPi(pi);",
    "  assertPiVersion(pi);",
    "  const engine = await ensureEngine(pi, false, false);",
    "  assertSetupState(pi, engine);",
    "  const { api } = await loadPayload(engine);",
    "  await checkRequirements(pi, api);",
    "  const cli = await import(pathToFileURL(join(engine.root, 'dist', 'src', 'cli.js')).href);",
    "  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), '.pi', 'agent');",
    "  return cli.runCli(['run', manifest.workflow.name, ...argv], { cwd: process.cwd(), agentDir, skillPaths: bundleSkillPaths(), stderr: (text) => process.stderr.write(text) });",
    "}",
    "const argv = process.argv.slice(2);",
    "try {",
    "  if (argv[0] === 'setup') await setup(argv.slice(1));",
    "  else process.exitCode = await launch(argv);",
    "} catch (error) {",
    "  console.error('Bundle error: ' + (error instanceof Error ? error.message : String(error)));",
    "  process.exitCode = 1;",
    "}",
  ].join("\n") + "\n";
}

export function normalizePortableFunctionSource(functionSource: string): string {
  const source = functionSource.trim();
  if (!source || source.includes("[native code]")) throw new Error("Workflow function source is unavailable");
  if (/^(async\s+)?run\s*\(/.test(source)) return source.replace(/^(async\s+)?run\s*\(/, "$1function run(");
  if (/^\*\s*run\s*\(/.test(source)) return source.replace(/^\*\s*run\s*\(/, "function* run(");
  return source;
}

function workflowModule(workflow: WorkflowCatalogFunction, functionSource: string, withRoles: boolean, aliasTargets: Readonly<Record<string, string>>, extensionModules: readonly string[]): string {
  const aliases = Object.entries(aliasTargets);
  const source = normalizePortableFunctionSource(functionSource);
  return [
    `const run = ${source};`,
    "export async function register(registerWorkflowExtension) {",
    ...extensionModules.map((name, index) => `  const extension${String(index)} = await import(${JSON.stringify(`./extensions/${name}`)});`),
    ...extensionModules.map((_name, index) => `  if (typeof extension${String(index)}.default === "function") await extension${String(index)}.default();`),
    "  registerWorkflowExtension({",
    `    version: ${JSON.stringify("1.0.0")},`,
    `    headline: ${JSON.stringify("Portable workflow bundle")},`,
    ...(withRoles ? [`    roleDirectories: [new URL("./roles", import.meta.url)],`] : []),
    ...(aliases.length ? [`    modelAliases: { ${aliases.map(([name, target]) => `${JSON.stringify(name)}: { resolve: () => ${JSON.stringify(target)} }`).join(", ")} },`] : []),
    "    functions: {",
    `      [${JSON.stringify(workflow.name)}]: {`,
    `        description: ${JSON.stringify(workflow.description)},`,
    `        input: ${JSON.stringify(workflow.input)},`,
    `        output: ${JSON.stringify(workflow.output)},`,
    "        run,",
    "      },",
    "    },",
    "  });",
    "}",
    "",
  ].join("\n");
}

function roleMarkdown(role: AgentDefinition): string {
  const metadata = ["---"];
  if (role.description !== undefined) metadata.push(`description: ${JSON.stringify(role.description)}`);
  if (role.model !== undefined) metadata.push(`model: ${JSON.stringify(role.model)}`);
  if (role.thinking !== undefined) metadata.push(`thinking: ${JSON.stringify(role.thinking)}`);
  if (role.tools !== undefined) metadata.push(`tools: ${JSON.stringify(role.tools)}`);
  if (role.overrideSystemPrompt !== undefined) metadata.push(`overrideSystemPrompt: ${String(role.overrideSystemPrompt)}`);
  if (role.contextFiles !== undefined) metadata.push(`contextFiles: ${JSON.stringify(role.contextFiles)}`);
  if (role.skills !== undefined) metadata.push(`skills: ${JSON.stringify(role.skills)}`);
  if (role.extensions !== undefined) metadata.push(`extensions: ${JSON.stringify(role.extensions)}`);
  metadata.push("---");
  return `${metadata.join("\n")}\n${role.prompt ?? ""}\n`;
}

function copyResources(root: string, resources: PortableWorkflowBundleResources | undefined): PortableWorkflowManifest["payload"] {
  if (!resources) return undefined;
  const payload: NonNullable<PortableWorkflowManifest["payload"]> = {};
  const sensitive = (source: string): boolean => {
    const name = basename(source).toLowerCase();
    return ["auth.json", "models.json", ".env", ".npmrc"].includes(name) || name.endsWith(".pem") || name.endsWith(".key");
  };
  const copy = (kind: "extensions" | "skills" | "static" | "dependencies", paths: readonly string[] | undefined): void => {
    if (!paths?.length) return;
    const names: string[] = [];
    for (const source of paths) {
      if (!existsSync(source)) throw new Error(`Bundle resource does not exist: ${source}`);
      if (sensitive(source)) throw new Error(`Bundle resource may contain credentials and cannot be selected: ${source}`);
      let name = basename(source);
      if (kind === "dependencies") {
        const packageName = readPackageMetadata(join(source, "package.json"))?.name;
        if (typeof packageName === "string" && packageName.trim()) name = packageName;
      }
      if (!name || name === "." || name === ".." || name.includes("\\") || name.startsWith("/")) throw new Error(`Invalid bundle resource name: ${name}`);
      if (names.includes(name)) throw new Error(`Duplicate bundle resource name: ${name}`);
      const destination = kind === "dependencies" ? join(root, "payload", "node_modules", ...name.split("/")) : join(root, "payload", kind === "static" ? "resources" : kind, name);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(source, destination, { recursive: true });
      names.push(name);
    }
    payload[kind] = names;
  };
  copy("extensions", resources.extensions);
  copy("skills", resources.skills);
  copy("static", resources.static);
  copy("dependencies", resources.dependencies);
  return Object.keys(payload).length ? payload : undefined;
}

function extensionPackageShim(paths: readonly string[]): string {
  const importedNames = new Set<string>();
  for (const path of paths) {
    if (!/\.(?:c|m)?js$/.test(path)) throw new Error(`Selected extension must be a JavaScript module file: ${path}`);
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/import\s*\{([^}]+)\}\s*from\s*["']pi-extensible-workflows["']/g)) {
      for (const part of (match[1] ?? "").split(",")) {
        const pieces = part.trim().split(/\s+as\s+/);
        const imported = pieces[0]?.trim();
        const local = pieces[1]?.trim() ?? imported;
        if (imported && local && /^[A-Za-z_$][\w$]*$/.test(local)) importedNames.add(imported);
      }
    }
  }
  return [...importedNames].map((name) => `export const ${name} = globalThis.__pi_bundle_api.${name};`).join("\n") + "\n";
}

export function writePortableWorkflowBundle(input: PortableWorkflowBundleInput): PortableWorkflowManifest {
  const engineVersion = input.engineVersion ?? portableEngineVersion();
  const manifest: PortableWorkflowManifest = {
    format: "pi-extensible-workflows-bundle",
    version: 1,
    command: input.command,
    workflow: { name: input.workflow.name, description: input.workflow.description, input: input.workflow.input, output: input.workflow.output },
    runtime: { pi: input.piVersion?.trim() || "unknown", "@piewf/cli": engineVersion.trim() || "unknown" },
    requirements: {
      roles: input.requirements?.roles ?? Object.keys(input.roles ?? {}),
      aliases: input.requirements?.aliases ?? [],
      tools: input.requirements?.tools ?? [],
      commands: input.requirements?.commands ?? [],
      environment: input.requirements?.environment ?? [],
    },
    ...(input.aliasTargets && Object.keys(input.aliasTargets).length ? { aliasTargets: Object.freeze({ ...input.aliasTargets }) } : {}),
  };
  const parent = dirname(input.destination);
  mkdirSync(parent, { recursive: true });
  if (existsSync(input.destination) && !input.force) throw new Error(`Destination already exists: ${input.destination}; use --force to replace it`);
  const temporary = mkdtempSync(join(parent, ".pi-extensible-workflows-bundle-"));
  try {
    const payload = join(temporary, "payload");
    mkdirSync(payload);
    const roles = input.roles ?? {};
    if (Object.keys(roles).length) {
      const roleDirectory = join(payload, "roles");
      mkdirSync(roleDirectory);
      for (const [name, role] of Object.entries(roles)) {
        if (!name || name === "." || name === ".." || name.includes("/") || name.includes("\\")) throw new Error(`Invalid role name for bundle: ${name}`);
        writeFileSync(join(roleDirectory, `${name}.md`), roleMarkdown(role), { encoding: "utf8", mode: 0o600 });
      }
    }
    const copiedPayload = copyResources(temporary, input.resources);
    if (copiedPayload) manifest.payload = copiedPayload;
    const extensionPaths = input.resources?.extensions ?? [];
    const extensionModules = extensionPaths.map((source) => basename(source));
    if (extensionPaths.length) {
      const packageDirectory = join(payload, "node_modules", "pi-extensible-workflows");
      mkdirSync(packageDirectory, { recursive: true });
      writeFileSync(join(packageDirectory, "package.json"), '{"type":"module","exports":"./index.mjs"}\n', { encoding: "utf8", mode: 0o600 });
      writeFileSync(join(packageDirectory, "index.mjs"), extensionPackageShim(extensionPaths), { encoding: "utf8", mode: 0o600 });
    }
    writeFileSync(join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(payload, "workflow.mjs"), workflowModule(input.workflow, input.functionSource, Object.keys(roles).length > 0, input.aliasTargets ?? {}, extensionModules), { encoding: "utf8", mode: 0o600 });
    writeFileSync(join(payload, "runner.mjs"), runnerSource(), { encoding: "utf8", mode: 0o700 });
    const launcher = join(temporary, input.command);
    writeFileSync(launcher, shellLauncher(), { encoding: "utf8", mode: 0o755 });
    chmodSync(launcher, 0o755);
    writeFileSync(join(temporary, `${input.command}.cmd`), windowsLauncher(), { encoding: "utf8", mode: 0o644 });
    if (input.force) rmSync(input.destination, { recursive: true, force: true });
    renameSync(temporary, input.destination);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
  return manifest;
}