import { execFileSync, type ExecFileSyncOptions, type ExecFileSyncOptionsWithStringEncoding, type ExecFileSyncOptionsWithBufferEncoding } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Only pass this environment to Git operating on owned disposable test repositories. */
export function gitFixtureEnvironment(inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = Object.fromEntries(Object.entries(inherited).filter(([key]) =>
    !key.startsWith("GIT_CONFIG") && !/^(GIT_(AUTHOR|COMMITTER)_|GIT_(DIR|COMMON_DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|TEMPLATE_DIR|SSH|SSH_COMMAND|ASKPASS)$|SSH_AUTH_SOCK$|SSH_AGENT_PID$)/.test(key)));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" };
}

export function fixtureGitSync(args: readonly string[], options: ExecFileSyncOptionsWithStringEncoding): string;
export function fixtureGitSync(args: readonly string[], options?: ExecFileSyncOptionsWithBufferEncoding): Buffer;
export function fixtureGitSync(args: readonly string[], options: ExecFileSyncOptions): string | Buffer;
export function fixtureGitSync(args: readonly string[], options: ExecFileSyncOptions = {}): string | Buffer {
  return execFileSync("git", args, { ...options, env: gitFixtureEnvironment(options.env) });
}

export function fixtureGit(cwd: string, ...args: string[]): string {
  return fixtureGitSync(["-C", cwd, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Seed only a newly allocated fixture, never an existing repository or linked worktree. */
export function initializeGitFixture(directory: string, bare = false): void {
  if (!isAbsolute(directory) || existsSync(join(directory, ".git")) || existsSync(join(directory, "HEAD")) || existsSync(join(directory, "config"))) throw new Error("Git fixture must be a new disposable repository");
  execFileSync("git", ["init", "--template=", "-q", ...(bare ? ["--bare"] : []), directory], { env: gitFixtureEnvironment() });
  const gitDirectory = bare ? directory : join(directory, ".git");
  const hooks = join(gitDirectory, "fixture-hooks");
  mkdirSync(hooks);
  for (const [key, value] of [["user.name", "Fixture"], ["user.email", "fixture@example.invalid"], ["commit.gpgSign", "false"], ["tag.gpgSign", "false"], ["core.hooksPath", hooks]] as const) {
    fixtureGit(directory, "config", "--local", key, value);
  }
}
