import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { Component, TUI } from "@earendil-works/pi-tui";
import type { WorkflowProgressStyles } from "./host-view.js";
import type { TranscriptLiveStream, TranscriptRecord, TranscriptSource } from "./transcript-source.js";
import type { WorkflowAgentSessionEvent, WorkflowAgentSessionReference } from "./types.js";

/**
 * Contract of the /agents workspace: a full-screen alternate screen over Pi with the session's agents on the left and
 * the selected agent's transcript, drawn with Pi's own message components, on the right. TranscriptView is
 * implemented by src/transcript-components.ts, openAgentsWorkspace by src/agents-workspace.ts and SessionAgentsSource
 * by src/session-agents.ts; src/host.ts wires them into the /agents command.
 *
 * Verified in a live Pi 1.1.0 TUI (tuiMode fullscreen):
 * - ctx.ui.custom({ overlay: true }) whose factory stops the parent TUI ({ preserveScreen: true }), starts a
 *   TuiAltScreen on parent.terminal, and on exit stops it and runs parent.start() + parent.renderNow(false) restores Pi.
 * - VStack [title shrink 0, body grow 1 basis 0, hint shrink 0]; stack entries shrink by default, so fixed rows need
 *   shrink 0. Body: HStack [sidebar basis 24..42 shrink 0, ScrollView({ follow: "end", primary: true }) grow 1].
 * - The primary ScrollView receives pgup/pgdn and the tui.altScreen.* actions (search included) whatever has focus.
 * - Input listeners added after construction run after the viewport listener; while alt.hasOverlay() (the search box)
 *   every key except ctrl+c belongs to the overlay.
 * - ToolExecutionComponent renders with Pi's built-in definitions (createReadToolDefinition(cwd) and the other
 *   create*ToolDefinition) and falls back to a generic block for unknown tools; it needs the alt screen as its TUI.
 *   setExpanded toggles the tool output. Mouse input was not exercised.
 */

/** An agent of the sidebar tree: what the workspace needs to show its transcript. */
export interface SessionAgent {
  /** Stable across refreshes: `run:<runId>:<agentId>` or `subagent:<id>`. */
  readonly key: string;
  readonly name: string;
  readonly state: string;
  /** Model, tokens and cost as the dashboards show them; the workspace adds "#position/count" and the name. */
  readonly summary: string;
  /** Working directory of the attempt; tool renderers resolve paths against it. */
  readonly cwd: string;
  /** Latest attempt number; a change shows a fresh transcript. */
  readonly attempt: number | undefined;
  /** The record belongs to this Pi session (and project); when false the session file is never opened. */
  readonly owned: boolean;
  readonly session: WorkflowAgentSessionReference | undefined;
  /** The in-process session of the shown attempt, only when its reference matches `session`. */
  readonly live: TranscriptLiveStream | undefined;
  /** One line of current activity while running. */
  readonly activity: string | undefined;
  readonly running: boolean;
}

/**
 * One node of the sidebar tree: each workflow run's /workflow tree (run root, phases,
 * operation scopes, shells, agents), then a "Subagents" group with one child per standalone subagent.
 */
export interface SessionTreeNode {
  /** Stable across refreshes: `run:<runId>` for a run root, `run:<runId>:node:<WorkflowPhaseTree node id>` for its other nodes, the agent's key for an agent, `subagents` for the group. */
  readonly key: string;
  /** Undefined for a run root and the group. */
  readonly parentKey: string | undefined;
  /** 0 for a run root and the group; a run's other nodes one level below their /workflow tree depth (where the phases share the root's 0); the subagents at 1. */
  readonly depth: number;
  readonly kind: "run" | "phase" | "operation" | "shell" | "agent" | "group";
  /**
   * The expansion a node takes the first time a list contains it: a run root while its run is not in a hard terminal state, its
   * other nodes workflowPhaseTreeInitialExpanded of the run; the group while one of its subagents runs.
   */
  readonly initiallyExpanded: boolean;
  /**
   * The node's row, its ▾/▸ icon (when it has children) at display column 2 + 2 * depth. A run root and the group are headers:
   * selection arrow, icon, bold label, two spaces, a summary (the run's state glyph, done/total agents, cost and runtime; the
   * group's counts and cost). Every other node is its /workflow tree row at `depth`: arrow, indent, ▾/▸/•/◇ icon, label, " · ", state glyph.
   */
  line(styles: WorkflowProgressStyles, selected: boolean, expanded: boolean): string;
  /** What the right pane shows for a node that is not an agent, as /workflow details it without its enter hints; empty for an agent, which shows its transcript. */
  details(styles: WorkflowProgressStyles, now: number): readonly string[];
  /** The title row of a node that is not an agent: its label and state. */
  title(styles: WorkflowProgressStyles): string;
  /** Set only for kind "agent". */
  readonly agent: SessionAgent | undefined;
}

export interface SessionAgentsSource {
  /** The sidebar tree of the current Pi session in sidebar order (a parent before its children); called when the workspace opens and on every refresh tick. */
  list(): Promise<readonly SessionTreeNode[]>;
}

/** The transcript pane's content: one Pi component per record, kept in file order. */
export interface TranscriptView {
  /** Mounted by the workspace inside its primary ScrollView. */
  readonly component: Component;
  /** Drops every record and the live message. */
  reset(): void;
  append(records: readonly TranscriptRecord[]): void;
  /** Records of an earlier chunk, in file order, placed before the first record. */
  prepend(records: readonly TranscriptRecord[]): void;
  /** Swaps a `large` record for the full record read later (same offset). */
  replace(record: TranscriptRecord): void;
  /** The `large` records not loaded yet, in file order. */
  pendingLarge(): readonly { readonly offset: number; readonly bytes: number }[];
  /** Tool output expanded or collapsed (Pi's app.tools.expand). */
  setExpanded(expanded: boolean): void;
  /** Session events of the live attempt: message_start/message_update/message_end draw the message being generated. */
  live(event: WorkflowAgentSessionEvent): void;
  dispose(): void;
}

/** `ui` is the workspace's TuiAltScreen; `cwd` is the agent's attempt directory. */
export type CreateTranscriptView = (options: { readonly ui: TUI; readonly cwd: string }) => TranscriptView;

export interface AgentsWorkspaceOptions {
  readonly agents: SessionAgentsSource;
  /** Opens the reader for an owned agent (openSessionTranscript); not called for an agent that is not owned. */
  readonly openSource: (agent: SessionAgent) => TranscriptSource;
  readonly createView: CreateTranscriptView;
  /** Agent selected when the workspace opens, its ancestors expanded; the first agent node in sidebar order otherwise. */
  readonly initialKey?: string;
  readonly pollIntervalMs?: number;
}

/** Resolves when the user leaves the workspace and Pi's own TUI is back. */
export type OpenAgentsWorkspace = (ctx: ExtensionCommandContext, options: AgentsWorkspaceOptions) => Promise<void>;
