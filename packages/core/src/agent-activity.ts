import { statSync } from "node:fs";
import { SETTLED_AGENT_STATES, WORKFLOW_AGENT_STALL_THRESHOLD_MS, type AgentRecord, type AgentState, type RunState } from "./types.js";

/**
 * How long an agent may go without an event before the widget and the /agents sidebar say so.
 *
 * Deliberately shorter than the core's own stall threshold. That one answers
 * "is this agent dead"; this one answers "should you go and look". An agent
 * asking a question in its own pane produces exactly this signature — no tool
 * calls, no events, waiting on a person — and the core cannot see it, since the
 * pane is a separate process. Three minutes is longer than any single stretch
 * of thinking and far shorter than the ten minutes it takes to be declared
 * stalled.
 */
const QUIET_MS = 3 * 60 * 1000;

/** The core's own threshold for calling an agent stalled outright. */
const STALL_MS = WORKFLOW_AGENT_STALL_THRESHOLD_MS;

/**
 * When an agent's own transcript was last written.
 *
 * The agent record carries the session for each attempt, so the file belongs
 * to this agent alone. Taking the newest write across every session in the run
 * — as a whole-run reading does — lets one busy agent vouch for a silent one:
 * the pair look equally alive while only one of them is.
 *
 * Stat results are cached for the life of a frame. Without that the check is
 * one stat per agent per repaint, several times a second, for a number that
 * cannot have changed between two rows of the same frame.
 */
export function lastTranscriptWrite(agent: AgentRecord, cache: Map<string, number | undefined>): number | undefined {
  const details = agent.attemptDetails ?? [];
  let newest: number | undefined;
  // Only this agent's attempts: a retry writes a new transcript, and the
  // latest one is what says whether it is still moving.
  for (const detail of details) {
    const locator = detail.session?.locator as { sessionFile?: string } | undefined;
    const file = locator?.sessionFile;
    if (!file) continue;
    if (!cache.has(file)) {
      try {
        cache.set(file, statSync(file).mtimeMs);
      } catch {
        // The transcript moved or was cleaned up; another attempt may answer.
        cache.set(file, undefined);
      }
    }
    const mtime = cache.get(file);
    if (mtime !== undefined && (newest === undefined || mtime > newest)) newest = mtime;
  }
  return newest;
}

/** How long a running agent has been silent, once that crosses the quiet threshold. */
export type Silence = { readonly kind: "quiet" | "stalled"; readonly ms: number };

/**
 * Whether an agent last active at `lastActivityAt` is quiet or stalled at `now`, and for how long; undefined while it is not or the time is unknown.
 *
 * An agent thinking hard looks exactly like an agent whose transport died: both
 * are a spinner that does not stop. Silence separates them. Workflow agents pass
 * agentLastActivity, subagents the last event of their progress; only a running agent is asked.
 */
export function agentSilence(lastActivityAt: number | undefined, now: number): Silence | undefined {
  if (lastActivityAt === undefined || !Number.isFinite(lastActivityAt)) return undefined;
  const ms = now - lastActivityAt;
  if (ms < QUIET_MS) return undefined;
  return { kind: ms >= STALL_MS ? "stalled" : "quiet", ms };
}

/** The newest sign of life of an agent: its last event or its transcript's last write, whichever is later; undefined when neither is known. */
export function agentLastActivity(agent: AgentRecord, cache: Map<string, number | undefined>): number | undefined {
  const last = Math.max(agent.lastEventAt ?? 0, lastTranscriptWrite(agent, cache) ?? 0);
  return last === 0 ? undefined : last;
}

/** Whether an agent is really working: not settled, in a run that is running, pausing or awaiting input (parallel agents go on). A run reaches paused only once no agent is active, and budget_exhausted and interrupted are terminal: an agent recorded running there is a leftover. */
export function agentIsLive(agentState: AgentState, runState: RunState | undefined): boolean {
  return !SETTLED_AGENT_STATES.has(agentState) && (runState === "running" || runState === "pausing" || runState === "awaiting_input");
}

const ACTIVE_AGENT_STATES: ReadonlySet<AgentState> = new Set(["running", "waiting_for_child", "retrying", "paused"]);
/** Whether a crash left an agent active in a run that is not live (see agentIsLive): drawn quiet, with no growing clock. A queued agent never started, so it is not one. */
export function agentIsLeftover(agentState: AgentState, runState: RunState | undefined): boolean {
  return ACTIVE_AGENT_STATES.has(agentState) && !agentIsLive(agentState, runState);
}
