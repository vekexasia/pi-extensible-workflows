import { spawn, type ChildProcess } from "node:child_process";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { CAPTURE_IDENTITY } from "./eval-capture-extension.js";
import { isObject } from "./index.js";
import { extractCapturedWorkflows, extractParentOracleFile, findSessionFile } from "./workflow-evals.js";

export const AMBIENT_OPT_IN = "PI_WORKFLOW_EVAL_AMBIENT";
export const AMBIENT_CAPTURE_NOTE = "Ambient Tier D uses the explicit capture extension. Pi 0.80.6 orders CLI extensions before discovered extensions and the first tool registration wins, so ambient tools and skills remain available while workflow execution stays capture-only.";
export const AMBIENT_INVOCATION_MODE = "ambient-capture-only";

export interface AmbientEvalCase {
  id: string;
  prompt: string;
  timeoutMs: number;
  maxCost: number;
}

export const AMBIENT_WORKFLOW_EVAL_CASES: readonly AmbientEvalCase[] = Object.freeze([
  { id: "ambient-fix-bug", prompt: "Inspect this repository, find the deliberate bug, fix it, and verify the fix with the existing test and lint scripts. Use the normal ambient Pi resources. If you would delegate work, the workflow call is capture-only.", timeoutMs: 30_000, maxCost: 0.1 },
  { id: "ambient-review", prompt: "Inspect the repository's source, tests, and configuration. Report the bug and the smallest safe fix, using normal ambient Pi resources. If you would delegate work, the workflow call is capture-only.", timeoutMs: 30_000, maxCost: 0.1 },
]);

export interface AmbientFixtureRepository {
  root: string;
  fixtureRoot: string;
  worktreesRoot: string;
  fixtureFiles: readonly string[];
}

export interface AmbientCaseWorktree {
  id: string;
  path: string;
  fixtureFiles: readonly string[];
  gitStatusBefore: readonly string[];
}

export interface AmbientCleanup {
  processExited: boolean;
  processGroupTerminated: boolean;
  worktreeRemoved: boolean;
  fixtureRepoRemoved: boolean;
  tempRootRemoved: boolean;
  captureIdentityVerified: boolean;
  realWorkflowAgentsLaunched: number;
}

export interface AmbientManifest {
  invocationMode: string;
  fixtureRoot: string;
  worktreePath: string;
  ambientAgentDir: string;
  fixtureFileList: readonly string[];
  gitStatusBefore: readonly string[];
  gitStatusAfter: readonly string[];
  parentToolSequence: readonly string[];
  skillReads: readonly string[];
  workflowCalls: readonly unknown[];
  workflowCallCount: number;
  tokenCost: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number; models: readonly { model: string; cost: number }[] };
  cleanup: AmbientCleanup;
}

export interface AmbientCaseResult {
  id: string;
  status: "passed" | "failed" | "timed_out" | "budget_exceeded";
  workflows: readonly unknown[];
  accounting: AmbientManifest["tokenCost"];
  accountingTrustworthy: boolean;
  diagnostics: readonly string[];
  errors: readonly string[];
  manifest: AmbientManifest;
}

export interface AmbientWorkflowEvalRunOptions {
  cases?: readonly AmbientEvalCase[];
  caseIds?: readonly string[];
  provider?: string;
  model?: string;
  thinking?: string;
  piCommand?: string;
  artifactsDir?: string;
  environment?: NodeJS.ProcessEnv;
}

export interface AmbientWorkflowEvalRunResult {
  artifactDir: string;
  cases: readonly AmbientCaseResult[];
  spent: number;
  mode: string;
}

const FIXTURE_FILES: Readonly<Record<string, string>> = Object.freeze({
  "package.json": `{
  "name": "ambient-fixture",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "node --test test/*.test.js",
    "lint": "node -p 1"
  }
}
`,
  "README.md": `# Ambient fixture

This small repository is safe to inspect and edit. The source contains one deliberate bug.

Use npm test and npm run lint. Neither script starts a server.
`,
  "tsconfig.json": `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "strict": true
  }
}
`,
  "config/project.json": `{
  "name": "ambient-fixture",
  "checks": ["test", "lint"]
}
`,
  "src/score.js": `export function isPassing(score) {
  return score >= 0;
}
`,
  "src/summary.js": `export function summarize(scores) {
  return { count: scores.length, total: scores.reduce((sum, score) => sum + score, 0) };
}
`,
  "test/score.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { isPassing } from "../src/score.js";

test("zero is not a passing score", () => {
  assert.equal(isPassing(0), false);
});

test("positive scores pass", () => {
  assert.equal(isPassing(3), true);
});
`,
  "test/summary.test.js": `import assert from "node:assert/strict";
import test from "node:test";
import { summarize } from "../src/summary.js";

test("summarizes scores", () => {
  assert.deepEqual(summarize([2, 3]), { count: 2, total: 5 });
});
`,
});

const FIXED_GIT_NAME = "pi-extensible-workflows ambient fixture";
const FIXED_GIT_EMAIL = "ambient-fixture@example.invalid";

function git(cwd: string, args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function gitStatus(cwd: string): readonly string[] {
  const output = git(cwd, ["status", "--short"]);
  return output ? output.split("\n") : [];
}

function fixtureFileList(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === ".git") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(relative(root, path));
    }
  };
  visit(root);
  return files;
}

export function createAmbientFixtureRepository(parent = tmpdir()): AmbientFixtureRepository {
  const root = mkdtempSync(join(parent, "pi-workflow-ambient-"));
  const fixtureRoot = join(root, "fixture");
  const worktreesRoot = join(root, "worktrees");
  mkdirSync(join(fixtureRoot, "config"), { recursive: true });
  mkdirSync(join(fixtureRoot, "src"), { recursive: true });
  mkdirSync(join(fixtureRoot, "test"), { recursive: true });
  mkdirSync(worktreesRoot, { recursive: true });
  for (const [path, content] of Object.entries(FIXTURE_FILES)) writeFileSync(join(fixtureRoot, path), content, { mode: 0o600 });
  git(fixtureRoot, ["init", "--quiet"]);
  git(fixtureRoot, ["config", "user.name", FIXED_GIT_NAME]);
  git(fixtureRoot, ["config", "user.email", FIXED_GIT_EMAIL]);
  git(fixtureRoot, ["add", "."]);
  execFileSync("git", ["commit", "--quiet", "--no-gpg-sign", "-m", "Initial ambient fixture"], { cwd: fixtureRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_NAME: FIXED_GIT_NAME, GIT_AUTHOR_EMAIL: FIXED_GIT_EMAIL, GIT_COMMITTER_NAME: FIXED_GIT_NAME, GIT_COMMITTER_EMAIL: FIXED_GIT_EMAIL } });
  return { root, fixtureRoot, worktreesRoot, fixtureFiles: fixtureFileList(fixtureRoot) };
}

export function createAmbientCaseWorktree(repository: AmbientFixtureRepository, id: string): AmbientCaseWorktree {
  const safeId = id.replace(/[^A-Za-z0-9._-]+/g, "-");
  const path = join(repository.worktreesRoot, `${safeId}-${randomUUID()}`);
  mkdirSync(path, { recursive: true });
  rmSync(path, { recursive: true, force: true });
  git(repository.fixtureRoot, ["worktree", "add", "--detach", "--quiet", path, "HEAD"]);
  return { id, path, fixtureFiles: repository.fixtureFiles, gitStatusBefore: gitStatus(path) };
}

export function removeAmbientCaseWorktree(repository: AmbientFixtureRepository, worktree: AmbientCaseWorktree): boolean {
  try { git(repository.fixtureRoot, ["worktree", "remove", "--force", worktree.path]); } catch { rmSync(worktree.path, { recursive: true, force: true }); }
  try { git(repository.fixtureRoot, ["worktree", "prune", "--expire", "now"]); } catch { /* Best effort after a forced removal. */ }
  return !existsSync(worktree.path);
}

export function removeAmbientFixtureRepository(repository: AmbientFixtureRepository): boolean {
  rmSync(repository.root, { recursive: true, force: true });
  return !existsSync(repository.root);
}

function terminateProcess(child: ChildProcess, signal: NodeJS.Signals): boolean {
  try {
    if (child.pid && process.platform !== "win32") process.kill(-child.pid, signal);
    else child.kill(signal);
    return true;
  } catch {
    return false;
  }
}

async function killProcessGroup(child: ChildProcess): Promise<boolean> {
  let terminated = terminateProcess(child, "SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (child.exitCode === null) terminated = terminateProcess(child, "SIGKILL") || terminated;
  return terminated;
}

export interface AmbientPiProcessInput {
  worktree: string;
  sessionDir: string;
  sessionId?: string;
  prompt: string;
  provider: string;
  model: string;
  thinking?: string;
  piCommand?: string;
  timeoutMs: number;
  maxCost: number;
  environment?: NodeJS.ProcessEnv;
}

export interface AmbientPiProcessResult {
  exitCode: number | null;
  timedOut: boolean;
  budgetExceeded: boolean;
  processGroupTerminated: boolean;
  stdout: string;
  stderr: string;
}

function usageCost(message: unknown): number {
  if (typeof message !== "object" || message === null || !("usage" in message)) return 0;
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null || !("cost" in usage)) return 0;
  const cost = usage.cost;
  return typeof cost === "object" && cost !== null && "total" in cost && typeof cost.total === "number" ? cost.total : 0;
}

export async function runAmbientPiProcess(input: AmbientPiProcessInput): Promise<AmbientPiProcessResult> {
  const captureExtension = fileURLToPath(new URL("./eval-capture-extension.js", import.meta.url));
  const args = ["--mode", "json", "--session-dir", input.sessionDir, "--session-id", input.sessionId ?? randomUUID(), "--extension", captureExtension, "--provider", input.provider, "--model", input.model, "--thinking", input.thinking ?? "off", "--print", input.prompt];
  mkdirSync(input.sessionDir, { recursive: true });
  const controller = new AbortController();
  let timedOut = false;
  let budgetExceeded = false;
  let processGroupTerminated = false;
  let totalCost = 0;
  let stdout = "";
  let stderr = "";
  let killPromise: Promise<boolean> | undefined;
  const child = spawn(input.piCommand ?? process.env.PI_WORKFLOW_EVAL_PI ?? "pi", args, {
    cwd: input.worktree,
    env: { ...process.env, ...input.environment, PI_CODING_AGENT_SESSION_DIR: input.sessionDir },
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    signal: controller.signal,
  });
  const requestKill = (): Promise<boolean> => { killPromise ??= killProcessGroup(child); return killPromise; };
  const inspect = (line: string): void => {
    try {
      const event = JSON.parse(line) as unknown;
      if (typeof event !== "object" || event === null || !("type" in event) || event.type !== "message_end" || !("message" in event)) return;
      totalCost += usageCost(event.message);
      if (totalCost > input.maxCost && !budgetExceeded) {
        budgetExceeded = true;
        controller.abort();
        void requestKill().then((terminated) => { processGroupTerminated ||= terminated; });
      }
    } catch { /* Ignore non-JSON diagnostics in print mode. */ }
  };
  let lineBuffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = `${stdout}${chunk.toString()}`.slice(-64_000);
    lineBuffer += chunk.toString();
    const lines = lineBuffer.split("\n");
    lineBuffer = lines.pop() ?? "";
    for (const line of lines) if (line) inspect(line);
  });
  child.stderr.on("data", (chunk: Buffer) => { stderr = `${stderr}${chunk.toString()}`.slice(-64_000); });
  child.once("error", () => { /* close still reports the terminated child. */ });
  const close = new Promise<number | null>((resolve) => { child.once("close", (code) => { resolve(code); }); });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
    void requestKill().then((terminated) => { processGroupTerminated ||= terminated; });
  }, input.timeoutMs);
  const exitCode = await close;
  clearTimeout(timer);
  if (lineBuffer) inspect(lineBuffer);
  if (killPromise) processGroupTerminated ||= await killPromise;
  return { exitCode, timedOut, budgetExceeded, processGroupTerminated, stdout, stderr };
}

function emptyAccounting(): AmbientManifest["tokenCost"] {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0, models: [] };
}

function ambientAgentDir(environment: NodeJS.ProcessEnv): string {
  return environment.PI_CODING_AGENT_DIR ?? process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

type AmbientCaseResultDraft = Omit<AmbientCaseResult, "manifest"> & { manifest: Omit<AmbientManifest, "gitStatusAfter"> };
function emptyResult(candidate: AmbientEvalCase, repository: AmbientFixtureRepository, worktree: AmbientCaseWorktree, environment: NodeJS.ProcessEnv, error: string): AmbientCaseResultDraft {
  const accounting = emptyAccounting();
  return {
    id: candidate.id, status: "failed", workflows: [], accounting, accountingTrustworthy: false, diagnostics: [], errors: [error],
    manifest: {
      invocationMode: AMBIENT_INVOCATION_MODE, fixtureRoot: repository.fixtureRoot, worktreePath: worktree.path, ambientAgentDir: ambientAgentDir(environment), fixtureFileList: worktree.fixtureFiles, gitStatusBefore: worktree.gitStatusBefore, parentToolSequence: [], skillReads: [], workflowCalls: [], workflowCallCount: 0, tokenCost: accounting,
      cleanup: { processExited: false, processGroupTerminated: false, worktreeRemoved: false, fixtureRepoRemoved: false, tempRootRemoved: false, captureIdentityVerified: false, realWorkflowAgentsLaunched: 0 },
    },
  };
}

async function runAmbientCase(repository: AmbientFixtureRepository, candidate: AmbientEvalCase, artifactsDir: string, environment: NodeJS.ProcessEnv, provider: string, model: string, thinking?: string, piCommand?: string): Promise<AmbientCaseResult> {
  const worktree = createAmbientCaseWorktree(repository, candidate.id);
  const sessionId = randomUUID();
  const sessionDir = join(repository.root, "sessions", candidate.id);
  let result: AmbientCaseResultDraft | undefined;
  let failure: string | undefined;
  let gitStatusAfter: readonly string[];
  try {
    const pi = await runAmbientPiProcess({ worktree: worktree.path, sessionDir, sessionId, prompt: candidate.prompt, provider, model, ...(thinking ? { thinking } : {}), ...(piCommand ? { piCommand } : {}), timeoutMs: candidate.timeoutMs, maxCost: candidate.maxCost, environment });
    const sessionFile = findSessionFile(sessionDir, sessionId);
    if (!sessionFile) failure = "Ambient parent session was not written.";
    else {
      const oracle = extractParentOracleFile(sessionFile);
      const workflows = extractCapturedWorkflows(oracle);
      const captureIdentityVerified = oracle.workflowToolResults.length === oracle.workflowCallCount && oracle.workflowToolResults.every(({ details, isError }) => isObject(details) && details.captureIdentity === CAPTURE_IDENTITY && details.realWorkflowAgentsLaunched === 0 && isError !== true);
      const errors = captureIdentityVerified ? [] : ["Ambient workflow tool results did not prove capture-only execution."];
      const status: AmbientCaseResult["status"] = pi.timedOut ? "timed_out" : pi.budgetExceeded ? "budget_exceeded" : pi.exitCode !== 0 || errors.length ? "failed" : "passed";
      result = {
        id: candidate.id, status, workflows, accounting: oracle.usage, accountingTrustworthy: !pi.timedOut && !pi.budgetExceeded && pi.exitCode === 0, diagnostics: [pi.stderr].filter(Boolean), errors,
        manifest: {
          invocationMode: AMBIENT_INVOCATION_MODE, fixtureRoot: repository.fixtureRoot, worktreePath: worktree.path, ambientAgentDir: ambientAgentDir(environment), fixtureFileList: worktree.fixtureFiles, gitStatusBefore: worktree.gitStatusBefore, parentToolSequence: oracle.parentToolSequence, skillReads: oracle.skillReads, workflowCalls: workflows, workflowCallCount: oracle.workflowCallCount, tokenCost: oracle.usage,
          cleanup: { processExited: pi.exitCode !== null, processGroupTerminated: pi.processGroupTerminated, worktreeRemoved: false, fixtureRepoRemoved: false, tempRootRemoved: false, captureIdentityVerified, realWorkflowAgentsLaunched: 0 },
        },
      };
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    try { gitStatusAfter = gitStatus(worktree.path); } catch { gitStatusAfter = ["<unavailable>"]; }
    const worktreeRemoved = removeAmbientCaseWorktree(repository, worktree);
    if (!result) result = emptyResult(candidate, repository, worktree, environment, failure ?? "Ambient case produced no result.");
    const cleanup = { ...result.manifest.cleanup, worktreeRemoved };
    result = { ...result, manifest: { ...result.manifest, cleanup } };
  }

  const finalized: AmbientCaseResult = { ...result, manifest: { ...result.manifest, gitStatusAfter } };
  writeFileSync(join(artifactsDir, `${candidate.id}.json`), `${JSON.stringify(finalized, null, 2)}\n`, { mode: 0o600 });
  return finalized;
}
export function assertAmbientOptIn(environment: NodeJS.ProcessEnv = process.env): void {
  if (environment[AMBIENT_OPT_IN] !== "1") throw new Error(`Ambient Tier D evals are opt-in. Set ${AMBIENT_OPT_IN}=1 to run them.`);
}

export async function runAmbientWorkflowEvals(options: AmbientWorkflowEvalRunOptions = {}): Promise<AmbientWorkflowEvalRunResult> {
  const environment = { ...process.env, ...options.environment };
  assertAmbientOptIn(environment);
  const provider = options.provider ?? environment.PI_WORKFLOW_EVAL_PROVIDER;
  const model = options.model ?? environment.PI_WORKFLOW_EVAL_MODEL;
  if (!provider || !model) throw new Error("Set --provider and --model (or PI_WORKFLOW_EVAL_PROVIDER and PI_WORKFLOW_EVAL_MODEL) before running ambient evals.");
  const candidates = (options.cases ?? AMBIENT_WORKFLOW_EVAL_CASES).filter((candidate) => !options.caseIds?.length || options.caseIds.includes(candidate.id));
  const artifactsDir = options.artifactsDir ?? join(process.cwd(), ".tmp", "workflow-evals-ambient", new Date().toISOString().replace(/[:.]/g, "-"));
  mkdirSync(artifactsDir, { recursive: true, mode: 0o700 });
  const repository = createAmbientFixtureRepository();
  const results: AmbientCaseResult[] = [];
  try {
    for (const candidate of candidates) results.push(await runAmbientCase(repository, candidate, artifactsDir, environment, provider, model, options.thinking, options.piCommand));
    return { artifactDir: artifactsDir, cases: results, spent: results.reduce((sum, result) => sum + result.accounting.cost, 0), mode: AMBIENT_INVOCATION_MODE };
  } finally {
    const fixtureRepoRemoved = removeAmbientFixtureRepository(repository);
    for (const [index, current] of results.entries()) {
      const cleanup = { ...current.manifest.cleanup, fixtureRepoRemoved, tempRootRemoved: fixtureRepoRemoved };
      const updated = { ...current, manifest: { ...current.manifest, cleanup } };
      results[index] = updated;
      writeFileSync(join(artifactsDir, `${current.id}.json`), `${JSON.stringify(updated, null, 2)}\n`, { mode: 0o600 });
    }
  }
}

export function formatAmbientSummary(result: AmbientWorkflowEvalRunResult): string {
  const rows = result.cases.map((item) => `${item.id}: ${item.status} (${item.accounting.cost.toFixed(4)} USD, ${String(item.accounting.totalTokens)} tok, ${String(item.manifest.workflowCallCount)} workflow calls)`);
  return [`Ambient Tier D (${result.mode}): ${String(result.cases.length)} cases, ${result.spent.toFixed(4)} USD spent`, AMBIENT_CAPTURE_NOTE, ...rows, `Artifacts: ${result.artifactDir}`].join("\n");
}

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main(): Promise<void> {
  assertAmbientOptIn();
  const args = process.argv.slice(2);
  const provider = option(args, "--provider");
  const model = option(args, "--model");
  const thinking = option(args, "--thinking");
  const piCommand = option(args, "--pi");
  const artifactsDir = option(args, "--artifacts");
  const caseIds = option(args, "--case")?.split(",").map((item) => item.trim()).filter(Boolean);
  const result = await runAmbientWorkflowEvals({
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(thinking ? { thinking } : {}),
    ...(piCommand ? { piCommand } : {}),
    ...(artifactsDir ? { artifactsDir } : {}),
    ...(caseIds?.length ? { caseIds } : {}),
  });
  process.stdout.write(`${formatAmbientSummary(result)}\n`);
  if (result.cases.some((item) => item.status !== "passed")) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) void main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
