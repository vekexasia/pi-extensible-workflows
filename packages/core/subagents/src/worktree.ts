import { join } from "node:path";
import { LAUNCH_SNAPSHOT_IDENTITY_VERSION, RunStore, type LaunchSnapshot, type PersistedRun, type WorktreeReference } from "../../src/index.js";

export interface SubagentWorktreeContext {
  readonly cwd: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly name: string;
  readonly owner: string;
  readonly copyIncludes?: boolean;
}

export interface SubagentWorktreeRunStore {
  recordSystemPrompt(entry: { sessionId: string; attempt: number; turn: number; prompt: string }): Promise<void>;
  validateWorktree(owner: string, cwd?: string): Promise<WorktreeReference>;
  worktree(owner: string, options?: Readonly<{ copyIncludes?: boolean }>): Promise<WorktreeReference>;
  snapshotWorktree(owner: string): Promise<string>;
}

export interface SubagentWorktreeHandle {
  readonly path: string;
  readonly branch: string;
  readonly cwd: string;
  readonly runStore: SubagentWorktreeRunStore;
  cleanup(): Promise<void>;
}

export interface SubagentWorktreeAdapter {
  create(context: Readonly<SubagentWorktreeContext>): Promise<SubagentWorktreeHandle>;
  cleanup?(context: Readonly<SubagentWorktreeContext>): Promise<void>;
}

function syntheticRun(context: Readonly<SubagentWorktreeContext>): PersistedRun {
  return {
    id: context.runId,
    workflowName: "subagents",
    cwd: context.cwd,
    sessionId: context.sessionId,
    state: "running",
    agentSessions: [],
    agents: [],
  };
}

function syntheticSnapshot(): LaunchSnapshot {
  return {
    identityVersion: LAUNCH_SNAPSHOT_IDENTITY_VERSION,
    launchMode: "background",
    script: "return null;",
    args: null,
    metadata: { name: "subagents" },
    settings: { concurrency: 1 },
    models: [],
    tools: [],
    agentTypes: [],
    schemas: [],
  };
}
export function createRunStoreWorktreeAdapter(home: string): SubagentWorktreeAdapter {
  let createQueue: Promise<void> = Promise.resolve();
  return {
    create(context) {
      const operation = createQueue.then(async () => {
        const store = new RunStore(context.cwd, context.sessionId, context.runId, home);
        await store.create(syntheticRun(context), syntheticSnapshot());
        try {
          const reference = await store.worktree(context.owner, { copyIncludes: context.copyIncludes !== false });
          let cleaned = false;
          return {
            path: reference.path,
            branch: reference.branch,
            cwd: reference.cwd,
            runStore: store,
            async cleanup() {
              if (cleaned) return;
              cleaned = true;
              await store.delete(true);
            },
          };
        } catch (error) {
          await store.delete(true).catch(() => undefined);
          throw error;
        }
      });
      // Git worktree metadata is shared by all RunStore instances for this adapter.
      createQueue = operation.then(() => undefined, () => undefined);
      return operation;
    },
    async cleanup(context) {
      await new RunStore(context.cwd, context.sessionId, context.runId, home).delete(true);
    },
  };
}

export function defaultWorktreeHome(storageDirectory: string): string {
  return join(storageDirectory, ".worktrees");
}
