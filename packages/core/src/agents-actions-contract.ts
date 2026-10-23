import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { SubagentStatus } from "../subagents/src/contracts.js";
import type { AwaitingCheckpoint } from "./decoders.js";
import type { WorkflowProgressStyles } from "./host-view.js";
import type { WorkflowArtifact } from "./workflow-artifacts.js";

/**
 * Ports of the actions /workflow and /subagents offer on a run, an agent or a subagent, so the /agents workspace, Pi's
 * dialogs and the rpc pickers run the same code.
 *
 * Hexagonal: an AgentsActionProvider is the driving port. Its implementations hold the action rules and talk to the
 * host's run operations and the subagent manager; they never touch ctx.ui or a TUI. Whatever they ask of the person
 * goes through the driven port ActionUi, which the callers adapt: src/pi-action-ui.ts to Pi's own dialogs (the pickers
 * outside the TUI use it too), the workspace's in-place adapter to its status row and an alternate-screen editor for
 * copies and external editors.
 */

/** What an action applies to; every SessionTreeNode of a run or of the Subagents group carries one. */
export type AgentsActionTarget =
  /** A run's root, phases, operation scopes and shells. */
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "workflow-agent"; readonly runId: string; readonly agentId: string }
  | { readonly kind: "subagent"; readonly id: string }
  /** The Subagents group. */
  | { readonly kind: "subagents" };

export interface AgentsAction {
  readonly label: string;
  /**
   * Runs inside the workspace and uses only `notify` and `openArtifact` of its ActionUi: the copies and the external
   * editors. Every other action runs once the workspace has stepped aside, with Pi's dialogs.
   */
  readonly inPlace?: true;
}

/** The labels every provider runs inside the workspace: the copies and the external editors. */
const IN_PLACE_LABELS: ReadonlySet<string> = new Set(["Copy run path", "Copy run ID", "Copy agent ID", "Copy branch", "Copy worktree path", "Open script in editor", "Open diff in editor", "Open prompt in editor", "Open system prompt in editor", "Open result in editor"]);
/** A provider's label as a menu action, marked in place when it is one of IN_PLACE_LABELS. */
export function agentsAction(label: string): AgentsAction { return IN_PLACE_LABELS.has(label) ? { label, inPlace: true } : { label }; }

/** Driven port: everything an action may ask of the person or show them. */
export interface ActionUi {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  confirm(title: string, message: string): Promise<boolean>;
  select(title: string, options: readonly string[]): Promise<string | undefined>;
  input(title: string, placeholder?: string): Promise<string | undefined>;
  /** Free text of several lines (Steer, the prompt of Edit and retry), prefilled with `prefill` when given; undefined when cancelled. */
  editText(title: string, prefill?: string): Promise<string | undefined>;
  /** The checkpoint shown in full, then Approve or Reject; undefined when cancelled. */
  reviewCheckpoint(checkpoint: AwaitingCheckpoint): Promise<"Approve" | "Reject" | undefined>;
  /** Opens the artifact in the configured external editor and returns after it exits; reports a missing editor or a failed exit itself. */
  openArtifact(artifact: WorkflowArtifact, label: string): Promise<void>;
  /** The progress line of a long action (Stop); undefined clears it. */
  status(text: string | undefined): void;
  /** Pi's working message, for registered agent-attempt actions. A detached action passes its `owner`: the loop clears the message only for the action that set it last. */
  setWorkingMessage(message?: string, owner?: object): void;
}

/** Driving port: the actions of the targets one provider owns. */
export interface AgentsActionProvider {
  /** Labels in menu order for a target this provider owns, [] for any other; never "Back". Reads current state on every call. */
  actions(target: AgentsActionTarget): Promise<readonly AgentsAction[]>;
  /**
   * Runs a label this provider offers now: it re-checks first, and a label no longer offered is reported through
   * `ui.notify` and does nothing. Failures are reported through `ui.notify` as the dashboards report them, not thrown.
   * `select` is the node key to select afterwards (the new run after a subagent Retry or Edit and retry).
   */
  run(target: AgentsActionTarget, label: string, ui: ActionUi): Promise<{ readonly select?: string }>;
}

/** A subagent as the /subagents list names it and details it. */
export interface SubagentPresentation {
  /** The request's label, told apart by its short id when another subagent has the same one; the short id without a label. */
  readonly name: string;
  /** The /subagents detail rows (state, model, tokens, cost, error, ...). */
  details(styles: WorkflowProgressStyles, now: number): readonly string[];
}

/** Driven port of the session source: reads what only the subagents extension knows (the request files under its storage). */
export interface SubagentPresenter {
  /**
   * One entry per id that `listed` has, from what the source already read: `listed` is this session's subagents as the
   * manager lists them, `inspected` what inspecting each id returned (absent or undefined when it failed).
   */
  describe(ids: readonly string[], listed: readonly SubagentStatus[], inspected: ReadonlyMap<string, unknown>): Promise<ReadonlyMap<string, SubagentPresentation>>;
}

/**
 * Published once by the subagents extension entry (subagents/src/index.ts) through src/subagent-actions-handle.ts. Its
 * provider and presenter work for one command context (its cwd and Pi session), so the core host asks for them each time
 * /agents opens.
 */
export interface SubagentsHandle {
  actions(ctx: ExtensionCommandContext): AgentsActionProvider;
  presenter(ctx: ExtensionCommandContext): SubagentPresenter;
}
