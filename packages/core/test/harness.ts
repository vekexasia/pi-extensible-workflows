/**
 * Test fixture harness for pi-extensible-workflows.
 *
 * Creates a temp project directory, writes persisted run fixtures with a
 * predetermined session ID, then launches a real Pi session in a herdr pane
 * with `pi --no-extensions -e ./dist/src/index.js --session-id <id>`.
 *
 * Fixtures are written BEFORE Pi starts, so session_start cold-recovers
 * interrupted/paused runs automatically. `/workflow` sees all fixtures
 * because the session ID matches.
 *
 * Requires: HERDR_ENV=1, pi CLI with auth, built dist/.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import {
  createLaunchSnapshot,
  DEFAULT_SETTINGS,
  RunStore,
  type AgentRecord,
  type AgentAttemptSummary,
  type ModelSpec,
  type RunState,
  type AgentState,
  type WorkflowErrorShape,
  type WorkflowSettings,
  type JsonValue,
} from "../src/index.js";
import type { PersistedRun } from "../src/persistence.js";

// ── Inputs ─────────────────────────────────────────────────────────────────

export interface AgentInput {
  id?: string;
  name?: string;
  state?: AgentState;
  parentId?: string;
  model?: Partial<ModelSpec>;
  tools?: readonly string[];
  attempts?: number;
  attemptDetails?: readonly AgentAttemptSummary[];
  accounting?: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
  toolCalls?: readonly { id: string; name: string; state: "running" | "completed" | "failed" }[];
}

export interface RunInput {
  id?: string;
  workflowName?: string;
  state?: RunState;
  phase?: string;
  agents?: AgentInput[];
  error?: WorkflowErrorShape;
  agentSessions?: readonly { transport: string; sessionId: string; locator?: JsonValue }[];
  snapshot?: Partial<{
    script: string;
    args: JsonValue;
    models: string[];
    tools: string[];
    settings: Partial<WorkflowSettings>;
  }>;
  checkpoints?: readonly { name: string; prompt: string; context?: JsonValue }[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function herdr(...args: string[]): string {
  return execFileSync("herdr", args, { encoding: "utf8", timeout: 30_000 }).trim();
}

function herdrJson(...args: string[]): unknown {
  return JSON.parse(herdr(...args));
}
const TEST_WORKSPACE_LABEL = "pi-workflows-tests";

function testWorkspace(): string {
  const listed = herdrJson("workspace", "list") as { result: { workspaces: Array<{ workspace_id: string; label: string }> } };
  const existing = listed.result.workspaces.find(({ label }) => label === TEST_WORKSPACE_LABEL);
  if (existing) return existing.workspace_id;
  const created = herdrJson("workspace", "create", "--cwd", resolve("."), "--label", TEST_WORKSPACE_LABEL, "--no-focus") as { result: { workspace: { workspace_id: string } } };
  return created.result.workspace.workspace_id;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Harness ────────────────────────────────────────────────────────────────

export class TestHarness {
  readonly cwd: string;
  readonly sessionId: string;
  private readonly model: string | undefined;
  private readonly agentDir: string | undefined;
  private readonly homeDir: string | undefined;
  private readonly environment: Readonly<Record<string, string>>;
  private paneId: string | undefined;
  private agentCounter = 0;
  private runCounter = 0;

  private constructor(cwd: string, sessionId: string, model?: string, agentDir?: string, homeDir?: string, environment: Readonly<Record<string, string>> = {}) {
    this.cwd = cwd;
    this.sessionId = sessionId;
    this.model = model;
    this.agentDir = agentDir;
    this.homeDir = homeDir;
    this.environment = environment;
  }

  /**
   * Create a harness with a fresh temp cwd and a fixed session ID.
   * Add fixtures with `addRun()`, then call `launch()`.
   */
  static create(options: { prefix?: string; model?: string; sessionId?: string; agentDir?: string; homeDir?: string; environment?: Readonly<Record<string, string>> } = {}): TestHarness {
    const cwd = mkdtempSync(join(tmpdir(), `pi-wf-${options.prefix ?? "test"}-`));
    const sessionId = options.sessionId ?? randomUUID();
    return new TestHarness(cwd, sessionId, options.model, options.agentDir, options.homeDir, options.environment);
  }

  // ── Agent builder ──────────────────────────────────────────────────────

  agent(input: AgentInput = {}): AgentRecord {
    this.agentCounter += 1;
    const n = this.agentCounter;
    const id = input.id ?? `agent-${String(n)}`;
    return {
      id,
      name: input.name ?? `agent-${String(n)}`,
      path: id,
      state: input.state ?? "completed",
      ...(input.parentId ? { parentId: input.parentId } : {}),
      model: {
        provider: input.model?.provider ?? "openai",
        model: input.model?.model ?? "gpt",
        ...(input.model?.thinking ? { thinking: input.model.thinking } : {}),
      },
      tools: input.tools ?? [],
      attempts: input.attempts ?? 1,
      ...(input.attemptDetails ? { attemptDetails: input.attemptDetails } : {}),
      ...(input.accounting ? { accounting: input.accounting } : {}),
      ...(input.toolCalls ? { toolCalls: input.toolCalls } : {}),
    };
  }

  // ── Run creation ───────────────────────────────────────────────────────

  /** Add a persisted run fixture. Can be called before or after launch(). */
  async addRun(input: RunInput = {}): Promise<RunStore> {
    this.runCounter += 1;
    const id = input.id ?? randomUUID();
    const workflowName = input.workflowName ?? `workflow-${String(this.runCounter)}`;
    const state = input.state ?? "completed";
    const agents = (input.agents ?? []).map((a) => this.agent(a));

    const si = input.snapshot ?? {};
    const snapshot = createLaunchSnapshot({
      script: si.script ?? `export const meta={name:'${workflowName}',description:'${workflowName}'}`,
      args: si.args ?? null,
      metadata: { name: workflowName, description: workflowName },
      settings: { ...DEFAULT_SETTINGS, ...si.settings },
      models: si.models ?? ["openai/gpt"],
      tools: si.tools ?? ["read"],
      agentTypes: [],
      schemas: [],
    });

    const run: PersistedRun = {
      id,
      workflowName,
      cwd: this.cwd,
      sessionId: this.sessionId,
      state,
      ...(input.phase ? { phase: input.phase } : {}),
      agents,
      ...(input.error ? { error: input.error } : {}),
      agentSessions: (input.agentSessions ?? []).map((session) => ({ transport: session.transport, sessionId: session.sessionId, ...(session.locator === undefined ? {} : { locator: session.locator }) })),
    };

    const store = new RunStore(this.cwd, this.sessionId, id);
    await store.create(run, snapshot);

    if (input.checkpoints) {
      for (const cp of input.checkpoints) {
        await store.awaitCheckpoint({
          path: `checkpoint/${cp.name}`,
          name: cp.name,
          prompt: cp.prompt,
          context: cp.context ?? null,
        });
      }
    }

    return store;
  }

  // ── Pi lifecycle ───────────────────────────────────────────────────────

  /**
   * Launch Pi with either the source extension or the only package installed
   * in agentDir. Fixtures written before this call are visible immediately —
   * interrupted runs are cold-recovered by session_start.
   */
  async launch(options: { installedExtensions?: boolean } = {}): Promise<void> {
    if (this.paneId) throw new Error("Already launched");
    if (options.installedExtensions && !this.agentDir) throw new Error("agentDir is required for installed extensions");

    const extensionPath = resolve("dist/src/index.js");
    const tabResult = herdrJson(
      "tab", "create", "--workspace", testWorkspace(), "--cwd", this.cwd,
      "--label", `pi-wf-${this.sessionId.slice(0, 8)}`, "--no-focus",
    ) as { result: { root_pane: { pane_id: string } } };
    this.paneId = tabResult.result.root_pane.pane_id;

    const modelFlag = this.model ? ` --model ${this.model}` : "";
    const installedFlag = options.installedExtensions ? "" : ` --no-extensions -e ${extensionPath}`;
    const environment = [
      ...Object.entries(this.environment),
      ...(this.homeDir ? [["HOME", this.homeDir] as const] : []),
      ...(this.agentDir ? [["PI_CODING_AGENT_DIR", this.agentDir] as const] : []),
    ];
    const environmentPrefix = environment.map(([name, value]) => `${name}=${JSON.stringify(value)}`).join(" ");
    const cmd = `${environmentPrefix}${environmentPrefix ? " " : ""}pi${installedFlag} --no-builtin-tools${modelFlag} --session-id ${this.sessionId}`;
    herdr("pane", "run", this.paneId, cmd);

    // Wait for Pi to be ready
    try {
      await this.waitFor("ctrl", 15_000);
    } catch {
      const screen = this.readPane();
      throw new Error(`Pi did not start within 15s. Screen:\n${screen}`);
    }
    // Let session_start finish cold recovery
    await sleep(500);
  }

  /** Send a line to the Pi pane (types text + Enter). */
  send(text: string): void {
    if (!this.paneId) throw new Error("Not launched");
    herdr("pane", "run", this.paneId, text);
  }

  /** Wait for text to appear in the pane. */
  async waitFor(match: string, timeoutMs = 10_000): Promise<void> {
    if (!this.paneId) throw new Error("Not launched");
    const deadline = Date.now() + timeoutMs;
    do {
      if (this.readPane().includes(match)) return;
      await sleep(100);
    } while (Date.now() < deadline);
    throw new Error(`Timed out waiting for ${match}`);
  }

  /** Read recent pane content (plain text, soft-wraps joined). */
  readPane(lines = 80): string {
    if (!this.paneId) throw new Error("Not launched");
    return herdr("pane", "read", this.paneId, "--source", "recent-unwrapped", "--lines", String(lines));
  }

  /** Read the current terminal viewport. */
  readVisiblePane(): string {
    if (!this.paneId) throw new Error("Not launched");
    return herdr("pane", "read", this.paneId, "--source", "visible");
  }

  /** Current pane width in columns. */
  paneWidth(): number {
    if (!this.paneId) throw new Error("Not launched");
    const layout = herdrJson("pane", "layout", "--pane", this.paneId) as { result: { layout: { area: { width: number } } } };
    return layout.result.layout.area.width;
  }

  /** Send a keypress (e.g. "Enter", "Escape", "j", "k"). */
  sendKey(key: string): void {
    if (!this.paneId) throw new Error("Not launched");
    herdr("pane", "send-keys", this.paneId, key);
  }

  /** Close the Pi pane. */
  async close(): Promise<void> {
    if (!this.paneId) return;
    try {
      herdr("pane", "send-keys", this.paneId, "q");
      await sleep(200);
      herdr("pane", "run", this.paneId, "/quit");
      await sleep(500);
    } catch { /* pane may already be gone */ }
    try { herdr("pane", "close", this.paneId); } catch { /* ok */ }
    this.paneId = undefined;
  }
}
