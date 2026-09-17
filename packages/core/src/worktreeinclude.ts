import { cp, lstat, mkdir, readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Minimatch } from "minimatch";
import { git } from "./io.js";

const MANIFEST = ".worktreeinclude";
const LOCAL_MANIFEST = ".worktreeinclude.local";

type IncludeRule = {
  readonly negative: boolean;
  readonly directory: boolean;
  readonly matcher: Minimatch;
};

function gitPaths(output: string): string[] {
  let directory: string | undefined;
  return output.split("\0").filter(Boolean).sort().filter((path) => {
    if (directory !== undefined && path.startsWith(directory)) return false;
    if (path.endsWith("/")) directory = path;
    return true;
  });
}

async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function parseRules(text: string, source: string): IncludeRule[] {
  const rules: IncludeRule[] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const escapedMarker = line.startsWith("\\#") || line.startsWith("\\!");
    if (!line || (!escapedMarker && line.startsWith("#"))) continue;
    const negative = !escapedMarker && line.startsWith("!");
    const body = negative || escapedMarker ? line.slice(1) : line;
    if (!body) throw new Error(`${source} contains an empty pattern`);
    const normalized = body;
    const directory = normalized.endsWith("/");
    const withoutSlash = normalized.replace(/^\/+|\/+$/g, "");
    if (!withoutSlash) throw new Error(`${source} contains an empty pattern`);
    const anchored = normalized.startsWith("/");
    const pattern = withoutSlash;
    const matcher = new Minimatch(pattern, { dot: true, nonegate: true, nocomment: true, matchBase: !anchored && !pattern.includes("/") });
    if (matcher.makeRe() === false) throw new Error(`${source} contains an invalid pattern ${JSON.stringify(line)}`);
    rules.push({ negative, directory, matcher });
  }
  return rules;
}

function ruleMatches(rule: IncludeRule, path: string): boolean {
  const parts = path.split("/");
  for (let index = parts.length; index > 0; index -= 1) {
    if (rule.directory && index === parts.length) continue;
    if (rule.matcher.match(parts.slice(0, index).join("/"))) return true;
  }
  return false;
}

function selected(path: string, rules: readonly IncludeRule[]): boolean {
  let included = false;
  for (const rule of rules) if (ruleMatches(rule, path)) included = !rule.negative;
  return included;
}

function selectedPaths(paths: readonly string[], rules: readonly IncludeRule[]): string[] {
  return paths.filter((path) => path !== MANIFEST && path !== LOCAL_MANIFEST && selected(path, rules));
}

async function expandDirectory(root: string, path: string): Promise<string[]> {
  const directory = path.endsWith("/") ? path.slice(0, -1) : path;
  const entries = await readdir(join(root, ...directory.split("/")), { withFileTypes: true });
  const descendants = await Promise.all(entries.map(async (entry) => {
    const child = `${directory}/${entry.name}`;
    return entry.isDirectory() ? expandDirectory(root, `${child}/`) : [child];
  }));
  return descendants.flat();
}

async function selectedIgnoredPaths(root: string, paths: readonly string[], rules: readonly IncludeRule[]): Promise<string[]> {
  const wholeDirectories = rules.length > 0 && rules.every((rule) => rule.directory && !rule.negative);
  const selectedPaths: string[] = [];
  for (const path of paths) {
    if (!path.endsWith("/")) {
      if (path !== MANIFEST && path !== LOCAL_MANIFEST && selected(path, rules)) selectedPaths.push(path);
      continue;
    }
    if (wholeDirectories && selected(path, rules)) {
      selectedPaths.push(path);
      continue;
    }
    for (const descendant of await expandDirectory(root, path)) if (selected(descendant, rules)) selectedPaths.push(descendant);
  }
  return selectedPaths.sort();
}

export async function worktreeIncludePlan(root: string): Promise<readonly string[]> {
  const manifest = await optionalText(join(root, MANIFEST));
  const localManifest = await optionalText(join(root, LOCAL_MANIFEST));
  if (manifest === undefined && localManifest === undefined) return [];

  const rules = [
    ...(manifest === undefined ? [] : parseRules(manifest, MANIFEST)),
    ...(localManifest === undefined ? [] : parseRules(localManifest, LOCAL_MANIFEST)),
  ];
  if (rules.length === 0 && localManifest === undefined) return [];
  const [trackedOutput, ignoredOutput, unignoredOutput] = await Promise.all([
    git(root, ["ls-files", "-z"]),
    git(root, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  ]);
  const tracked = gitPaths(trackedOutput);
  const ignored = gitPaths(ignoredOutput);
  const unignored = gitPaths(unignoredOutput);
  if (localManifest !== undefined && !ignored.includes(LOCAL_MANIFEST)) throw new Error(`${LOCAL_MANIFEST} must be ignored and untracked`);
  if (rules.length === 0) return [];

  const selectedTracked = selectedPaths(tracked, rules);
  const firstTracked = selectedTracked[0];
  if (firstTracked !== undefined) throw new Error(`worktree include selected tracked path: ${firstTracked}`);
  const selectedUnignored = selectedPaths(unignored, rules);
  const firstUnignored = selectedUnignored[0];
  if (firstUnignored !== undefined) throw new Error(`worktree include selected path that is not ignored by Git: ${firstUnignored}`);
  return selectedIgnoredPaths(root, ignored, rules);
}

export async function copyWorktreeIncludes(root: string, destination: string, paths: readonly string[]): Promise<void> {
  for (const path of paths) {
    const source = join(root, ...path.split("/"));
    const target = join(destination, ...path.split("/"));
    try {
      await lstat(target);
      throw new Error(`worktree include destination collides with existing content: ${path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true, force: false, errorOnExist: true, verbatimSymlinks: true });
  }
}
