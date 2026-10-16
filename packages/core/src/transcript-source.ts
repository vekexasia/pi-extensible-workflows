import type { WorkflowAgentSessionEvent } from "./types.js";

/**
 * Contract between the session transcript reader (session-transcript.ts) and the /agents transcript
 * (transcript-components.ts, agents-workspace.ts). The reader shows the full history of one pi session file: the
 * last chunk first, earlier chunks on request down to byte 0, and complete lines appended since the previous poll.
 */

/** Bytes read per chunk when the pane opens and per loadEarlier call. */
export const TRANSCRIPT_CHUNK_BYTES = 4 * 1024 * 1024;
/** Lines longer than this are returned as `large` records; their content is read only by loadRecord. */
export const TRANSCRIPT_LARGE_RECORD_BYTES = 1024 * 1024;
/** Tool results are folded to this many lines until the reader expands them. */
export const TRANSCRIPT_FOLDED_RESULT_LINES = 10;

/** One line of the session file, in file order. `offset` and `bytes` cover the line without its newline. */
export type TranscriptRecord =
  | { readonly kind: "entry"; readonly offset: number; readonly bytes: number; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: "large"; readonly offset: number; readonly bytes: number }
  | { readonly kind: "unreadable"; readonly offset: number; readonly bytes: number };

/**
 * `waiting`: no file yet (pi writes a session file lazily) or the reference has no locator while the agent may still
 * write one. `unavailable`: the file failed the identity checks or cannot be read; `reason` says why.
 */
export type TranscriptSourceStatus = "waiting" | "available" | "unavailable";

export interface TranscriptPoll {
  readonly status: TranscriptSourceStatus;
  /** The source started over (the path now names another file, or the file shrank): drop every record shown so far. */
  readonly reset: boolean;
  /** After a reset or on the first available poll: the last chunk. Otherwise: complete lines appended since the previous poll. */
  readonly appended: readonly TranscriptRecord[];
  /** The earliest record loaded so far starts at byte 0. */
  readonly atStart: boolean;
  readonly reason?: string;
}

/**
 * Callers never overlap calls on one source. Every read goes through the one descriptor the identity checks ran on.
 * A trailing line without a newline is not returned until it is complete.
 */
export interface TranscriptSource {
  poll(): Promise<TranscriptPoll>;
  /** The chunk before the earliest loaded record, starting at a line boundary; empty when already at the start. */
  loadEarlier(): Promise<{ readonly records: readonly TranscriptRecord[]; readonly atStart: boolean }>;
  /** Reads one `large` record in full; returns an `entry` or an `unreadable` record for the same range. */
  loadRecord(record: { readonly offset: number; readonly bytes: number }): Promise<TranscriptRecord>;
  /** Closes the descriptor; later calls return status `unavailable`. */
  close(): Promise<void>;
}

/** The in-process session of a running agent, when the dashboard has one whose reference matches the attempt shown. */
export interface TranscriptLiveStream {
  subscribe(listener: (event: WorkflowAgentSessionEvent) => void): () => void;
}
