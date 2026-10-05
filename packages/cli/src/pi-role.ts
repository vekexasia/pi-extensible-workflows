#!/usr/bin/env node
import { constants } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DefaultPackageManager, DefaultResourceLoader, ProjectTrustStore, SettingsManager, getAgentDir } from "@earendil-works/pi-coding-agent";
import { discoverRoles, loadRole, resolveRole, type ResolvedRole, type WorkflowRoleDirectoryInput } from "pi-extensible-workflows/roles";
import { CONTEXT_FILE_SCOPES, WorkflowError, errorText, resourcePatternHasMagic, sameFilesystemPath, type AgentDefinition } from "pi-extensible-workflows";
import { spawnExecutable } from "pi-extensible-workflows/process";

// Pi builtin tools stand in for the workflow session boundary; extension tool names selected by the role pass through.
const PI_BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

function starterRoleDirectories(): WorkflowRoleDirectoryInput[] {
  const core = dirname(fileURLToPath(import.meta.resolve("pi-extensible-workflows")));
  return [{ path: resolve(core, "../starter/roles"), extension: { version: "0.0.0", headline: "Starter roles" }, builtin: true }];
}

function projectTrust(cwd: string, agentDir: string, args: readonly string[]): boolean {
  const end = args.indexOf("--");
  const flag = args.slice(0, end < 0 ? args.length : end).filter((arg) => ["--approve", "-a", "--no-approve", "-na"].includes(arg)).at(-1); // last wins, as in pi
  if (flag) return flag === "--approve" || flag === "-a";
  return new ProjectTrustStore(agentDir).get(cwd) ?? false; // no saved decision: project roles, settings, and resources stay out
}

export function piArguments(role: ResolvedRole, skillPaths: ReadonlyMap<string, string>, rest: readonly string[]): string[] {
  const argv: string[] = [];
  if (role.model) argv.push("--model", `${role.model.provider}/${role.model.model}${role.model.thinking ? `:${role.model.thinking}` : ""}`);
  if (role.selectorLayers.tools.some((layer) => layer !== undefined)) argv.push("--tools", (role.tools ?? []).join(","));
  argv.push("--no-skills");
  for (const name of role.selectedSkills ?? []) argv.push("--skill", skillPaths.get(name) ?? name);
  argv.push("--no-extensions");
  for (const path of role.selectedExtensions ?? []) argv.push("--extension", path);
  if (role.systemPrompt.text) argv.push(role.systemPrompt.mode === "override" ? "--system-prompt" : "--append-system-prompt", role.systemPrompt.text);
  if (role.contextFiles !== undefined && new Set(role.contextFiles).size < CONTEXT_FILE_SCOPES.length) {
    if (role.contextFiles.length > 0) throw new Error(`Role ${role.name ?? ""} selects a subset of context file scopes (${role.contextFiles.join(", ")}); pi-role only supports all scopes or none`);
    argv.push("--no-context-files");
  }
  return [...argv, ...rest];
}

export async function resolvePiArguments(name: string, rest: readonly string[], cwd = process.cwd(), agentDir = getAgentDir()): Promise<string[]> {
  const projectTrusted = projectTrust(cwd, agentDir, rest);
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  settingsManager.setProjectTrusted(projectTrusted);
  const discovered = await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve();
  const visible = ({ enabled, metadata }: { enabled: boolean; metadata: { scope: string } }) => enabled && (projectTrusted || metadata.scope !== "project");
  const extensions = [...new Set(discovered.extensions.filter(visible).map(({ path }) => path))];
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, additionalSkillPaths: [...new Set(discovered.skills.filter(visible).map(({ path }) => path))] });
  await loader.reload();
  const skillPaths = new Map(loader.getSkills().skills.map(({ name: skill, filePath }) => [skill, filePath]));
  const discovery = { cwd, agentDir, projectTrusted, extensionRoleDirectories: starterRoleDirectories() };
  const resolveWith = (definition: AgentDefinition): ResolvedRole => {
    const requestedTools = resolveRole(name, { ...discovery, definition }).selectorLayers.tools.flatMap((layer) => layer ?? []).filter((selector) => !selector.startsWith("!") && !resourcePatternHasMagic(selector));
    return resolveRole(name, { ...discovery, definition, resources: { extensions, skills: [...skillPaths.keys()], tools: [...new Set([...PI_BUILTIN_TOOLS, ...requestedTools])] } });
  };
  const definition = loadRole(name, discovery);
  let role: ResolvedRole;
  try { role = resolveWith(definition); }
  catch (error) {
    // Starter roles use aliases the workflow extension resolves against the launching session's model; standalone, pi's default model plays that part.
    if (!(error instanceof WorkflowError) || error.code !== "UNKNOWN_MODEL") throw error;
    process.stderr.write(`pi-role: ${errorText(error)}; starting pi with its default model\n`);
    const withoutModel = { ...definition };
    delete withoutModel.model;
    role = resolveWith(withoutModel);
  }
  return piArguments(role, skillPaths, rest);
}

function usage(cwd: string, agentDir: string): string {
  const roles = discoverRoles({ cwd, agentDir, projectTrusted: projectTrust(cwd, agentDir, []), extensionRoleDirectories: starterRoleDirectories() });
  const lines = Object.entries(roles).map(([name, { description }]) => `  ${name.padEnd(16)}${description ?? ""}`);
  return `Usage: pi-role <role> [pi arguments...]\n\nRoles:\n${lines.join("\n")}\n\nProject roles need pi's saved trust decision or --approve.\n`;
}

export async function runPiRole(argv: readonly string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (!name || name === "--help" || name === "-h") { process.stdout.write(usage(process.cwd(), getAgentDir())); return name ? 0 : 1; }
  let args: string[];
  try { args = await resolvePiArguments(name, rest); }
  catch (error) { process.stderr.write(`pi-role: ${errorText(error)}\n`); return 1; }
  return new Promise((done) => {
    const ignoreInterrupt = () => {}; // The terminal child handles Ctrl+C; wait for its exit status.
    let settled = false;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      process.removeListener("SIGINT", ignoreInterrupt);
      done(code);
    };
    let child: ReturnType<typeof spawnExecutable>;
    try { child = spawnExecutable("pi", args, { stdio: "inherit", windowsHide: false }); }
    catch (error) { process.stderr.write(`pi-role: ${errorText(error)}\n`); finish(1); return; }
    process.on("SIGINT", ignoreInterrupt);
    child.once("error", (error) => { process.stderr.write(`pi-role: ${errorText(error)}\n`); finish(1); });
    child.once("exit", (code, signal) => { finish(signal ? 128 + constants.signals[signal] : code ?? 1); });
  });
}

if (process.argv[1] && sameFilesystemPath(fileURLToPath(import.meta.url), process.argv[1])) {
  process.exitCode = await runPiRole(process.argv.slice(2));
}
