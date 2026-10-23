import type { ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { errorText } from "./utils.js";
import type { ActionUi, AgentsActionProvider } from "./agents-actions-contract.js";
import type { AgentsWorkspaceExit, DetachedSink, AgentsWorkspaceOptions, OpenAgentsWorkspace } from "./agents-workspace.js";
import type { SessionAgentsSource, SessionTreeNode } from "./session-agents.js";

/** One loop at a time, across the extension bundles that each load their own copy of this module: a second alternate screen would stay over Pi. */
const LOOP_KEY = Symbol.for("pi-extensible-workflows.agents-workspace-loop");
const globalLoops = globalThis as typeof globalThis & Record<symbol, true | undefined>;
/** What a detached action reports to, per process: an action outlives the loop that started it, and a later loop's workspace must get its messages. */
const DETACHED_KEY = Symbol.for("pi-extensible-workflows.agents-detached-ui");
interface DetachedUi { sink?: DetachedSink | undefined; working?: string | undefined; workingOwner?: object | undefined; inPi?: boolean }
const globalDetached = globalThis as typeof globalThis & Record<symbol, DetachedUi | undefined>;

export interface AgentsWorkspaceLoop {
  readonly open: OpenAgentsWorkspace;
  /** What every open of the workspace gets as it is. */
  readonly options: Pick<AgentsWorkspaceOptions, "agents" | "openSource" | "createView" | "pollIntervalMs" | "editorCommand" | "changes" | "shutdown">;
  /** The menus' providers, in menu order; none: the workspace gets no actions, so it has no menu and never steps aside. */
  readonly providers: readonly AgentsActionProvider[];
  /** The node selected at the first open. */
  readonly initialKey?: string;
  /** The ActionUi a step-aside action runs with (Pi's dialogs); `onNotify` gets every notice it shows. */
  readonly actionUi: (onNotify: (message: string, level?: "info" | "warning" | "error") => void) => ActionUi;
  /** Whether a list has something to show; checked before every open. */
  readonly hasContent: (nodes: readonly SessionTreeNode[]) => boolean;
  readonly onEmpty: () => void;
}

/** The source's nodes; undefined when it cannot list them. */
async function listNodes(source: SessionAgentsSource): Promise<readonly SessionTreeNode[] | undefined> {
  try { return await source.list(); } catch { return undefined; }
}
/** The source whose first list() is `nodes`, already listed for the emptiness check; later lists go to the source (a refresh must see changes). */
function seeded(source: SessionAgentsSource, nodes: readonly SessionTreeNode[]): SessionAgentsSource {
  let first: readonly SessionTreeNode[] | undefined = nodes;
  return { list: async () => { const seed = first; first = undefined; return seed ?? source.list(); } };
}
/** Runs the label with the provider that offered it, which re-checks it, and clears its status once it settled; the node to select afterwards. */
async function runAction(exit: AgentsWorkspaceExit, ui: ActionUi): Promise<string | undefined> {
  //NOTE: a provider reports its failures through ui.notify; one that throws ends the command, the status cleared.
  try { return (await exit.provider.run(exit.target, exit.label, ui)).select; } finally { ui.status(undefined); }
}

/**
 * Opens the workspace, runs the action it stepped aside for with Pi's dialogs, and opens it again as it was, on the node
 * the action selected, with the action's notices; until the user leaves it, the context's signal or the options' shutdown aborts, or the source has
 * nothing to show (onEmpty). A list that fails still opens the workspace: its title says why. An action that waits (a
 * Foreground resume) keeps Pi's screen until it settles; a registered agent-attempt action is only started (runAgentAction,
 * performAction), so the workspace opens again at once and this loop never waits on a Herdr pane.
 */
export async function runAgentsWorkspace(ctx: ExtensionContext, loop: AgentsWorkspaceLoop): Promise<void> {
  if (globalLoops[LOOP_KEY]) { ctx.ui.notify("The agents workspace is already opening or open.", "info"); return; }
  globalLoops[LOOP_KEY] = true;
  try {
    // What a detached action reports shows in the open workspace's status row; with none open it goes to Pi.
    let notices: string[] = [];
    const piUi = loop.actionUi((message) => { notices.push(message); });
    const state = (globalDetached[DETACHED_KEY] ??= {});
    // Pi's own ui is never called after the shutdown: a detached action can settle after /reload or /new, on a stale context.
    const toPi = (call: () => void): void => {
      if (loop.options.shutdown?.aborted) return;
      try { call(); } catch { /* a stale context: there is nothing left to show it to */ }
    };
    const detached: AgentsWorkspaceOptions["detached"] = (next) => {
      state.sink = next;
      // From now on the workspace shows the message; a message Pi was given while it was closed would stay on Pi's next turn.
      if (state.inPi) { state.inPi = false; toPi(() => { piUi.setWorkingMessage(undefined); }); }
      next.working(state.working);
      return () => { if (state.sink === next) state.sink = undefined; };
    };
    let reopen: Pick<AgentsWorkspaceOptions, "initialKey" | "state" | "notices"> = loop.initialKey === undefined ? {} : { initialKey: loop.initialKey };
    for (;;) {
      const nodes = await listNodes(loop.options.agents);
      if (loop.options.shutdown?.aborted) return;
      if (nodes !== undefined && !loop.hasContent(nodes)) { loop.onEmpty(); return; }
      const options = { ...loop.options, ...(nodes === undefined ? {} : { agents: seeded(loop.options.agents, nodes) }), detached };
      let exit: AgentsWorkspaceExit | undefined;
      // The same notice at the same level in /agents, /workflow and /subagents.
      // A command context is Pi's session context plus session controls the workspace never calls (runner.js createCommandContext).
      try { exit = await loop.open(ctx as ExtensionCommandContext, { ...options, ...(loop.providers.length > 0 ? { actions: loop.providers } : {}), ...reopen }); }
      catch (error) { toPi(() => { ctx.ui.notify(`agents workspace failed: ${errorText(error)}`, "error"); }); return; }
      if (exit === undefined || loop.options.shutdown?.aborted || ctx.signal?.aborted) return;
      notices = [];
      const ui: ActionUi = {
        ...piUi,
        status: (text) => { toPi(() => { piUi.status(text); }); },
        notify: (message, level) => { if (state.sink) state.sink.notice(message, level); else toPi(() => { piUi.notify(message, level); }); },
        // Recorded whether or not a workspace is open: a detached action sets its first messages before the workspace opens again.
        setWorkingMessage: (message, owner) => {
          if (owner !== undefined && !message && owner !== state.workingOwner) return;
          state.working = message || undefined;
          state.workingOwner = state.working === undefined ? undefined : owner;
          if (state.sink) state.sink.working(state.working); else { state.inPi = state.working !== undefined; toPi(() => { piUi.setWorkingMessage(message); }); }
        },
      };
      const select = await runAction(exit, ui);
      if (loop.options.shutdown?.aborted || ctx.signal?.aborted) return;
      reopen = { state: exit.state, ...(select === undefined ? {} : { initialKey: select }), ...(notices.length > 0 ? { notices } : {}) };
    }
  } finally { globalLoops[LOOP_KEY] = undefined; }
}
