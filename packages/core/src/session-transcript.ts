import { constants, type BigIntStats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import type { WorkflowAgentSessionReference } from "./types.js";
import { sessionFile } from "./trajectory.js";
import { object } from "./utils.js";

/** Pi bounds its own session header scan to 1 MiB (MAX_SESSION_HEADER_SCAN_BYTES). */
const HEADER_LIMIT_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
//NOTE: Windows has no O_NONBLOCK; there the open is a plain read-only open.
const { O_NONBLOCK = 0 } = constants as Partial<typeof constants>;
const OPEN_FLAGS = constants.O_RDONLY | O_NONBLOCK;

/** One line of the session file, in file order. `bytes` covers the line without its newline. */
export type TranscriptRecord =
  | { readonly kind: "entry"; readonly bytes: number; readonly value: Readonly<Record<string, unknown>> }
  | { readonly kind: "unreadable"; readonly bytes: number };

/**
 * `waiting`: no file yet (pi writes a session file lazily) or the reference has no locator while the agent may still
 * write one. `unavailable`: the file failed the identity checks or cannot be read; `reason` says why.
 */
export type TranscriptSourceStatus = "waiting" | "available" | "unavailable";

export interface TranscriptPoll {
  readonly status: TranscriptSourceStatus;
  /** The source started over (the path now names another file, or the file shrank): drop every record shown so far. */
  readonly reset: boolean;
  /** After a reset or on the first available poll: every complete line. Otherwise: complete lines appended since the previous poll. */
  readonly appended: readonly TranscriptRecord[];
  readonly reason?: string;
}

/**
 * Callers never overlap calls on one source. Every read goes through the one descriptor the identity checks ran on.
 * A trailing line without a newline is not returned until it is complete.
 */
export interface TranscriptSource {
  poll(): Promise<TranscriptPoll>;
  /** Closes the descriptor; later calls return status `unavailable`. */
  close(): Promise<void>;
}

interface OpenFile { readonly handle: FileHandle; readonly dev: bigint; readonly ino: bigint; size: number; end: number }
interface Closed { readonly status: "waiting" | "unavailable"; readonly reason?: string }

function errorCode(error: unknown): string | undefined { return object(error) && typeof error.code === "string" ? error.code : undefined; }
function unavailable(reason: string): Closed { return { status: "unavailable", reason }; }
function failure(error: unknown): Closed { return unavailable(`cannot read the session file (${errorCode(error) ?? (error instanceof Error ? error.message : String(error))})`); }
function parseValue(line: Buffer): unknown { try { return JSON.parse(line.toString("utf8")); } catch { return undefined; } }
function parseRecord(line: Buffer): TranscriptRecord {
  const value = parseValue(line);
  return object(value) ? { kind: "entry", bytes: line.length, value } : { kind: "unreadable", bytes: line.length };
}

let readObserver: ((bytes: number) => void) | undefined;
/** Test hook: `observer` receives the byte count of every read the readers make; undefined removes it. */
export function observeSessionTranscriptReads(observer: ((bytes: number) => void) | undefined): void { readObserver = observer; }

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  readObserver?.(filled);
  return buffer.subarray(0, filled);
}
/** Opens `path` once and runs the identity checks on that descriptor; on success the descriptor is the only way the file is read. */
async function openChecked(path: string, sessionId: string): Promise<OpenFile | Closed> {
  let handle: FileHandle;
  try { handle = await open(path, OPEN_FLAGS); } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { status: "waiting" };
    if (code === "EACCES" || code === "EPERM") return unavailable("the session file is not readable");
    return failure(error);
  }
  const rejected = async (closed: Closed): Promise<Closed> => { await handle.close().catch(() => undefined); return closed; };
  try {
    const stats: BigIntStats = await handle.stat({ bigint: true });
    if (!stats.isFile()) return await rejected(unavailable("the session path is not a regular file"));
    const size = Number(stats.size);
    const head = await readAt(handle, 0, Math.min(size, HEADER_LIMIT_BYTES + 1));
    const headerEnd = head.indexOf(NEWLINE);
    if (headerEnd === -1) return await rejected(size <= HEADER_LIMIT_BYTES ? { status: "waiting" } : unavailable("the session header is longer than 1 MiB"));
    const header = parseValue(head.subarray(0, headerEnd));
    if (!object(header) || header.type !== "session" || typeof header.id !== "string") return await rejected(unavailable("the file does not start with a pi session header"));
    if (header.id !== sessionId) return await rejected(unavailable("the file belongs to another session"));
    return { handle, dev: stats.dev, ino: stats.ino, size, end: 0 };
  } catch (error) { return await rejected(failure(error)); }
}

/** The transcript of one pi session file: all of it on the first poll, then the complete lines appended since the previous poll. */
export function openSessionTranscript(reference: WorkflowAgentSessionReference | undefined): TranscriptSource {
  const path = sessionFile(reference);
  let closed = false;
  let file: OpenFile | undefined;

  /** The complete lines of [end, size). */
  const linesTo = async (current: OpenFile, size: number): Promise<TranscriptRecord[]> => {
    //NOTE: a short read means the file shrank since the last poll; the next poll resets.
    const buffer = await readAt(current.handle, current.end, size - current.end);
    const records: TranscriptRecord[] = [];
    let start = 0;
    for (let index = buffer.indexOf(NEWLINE); index !== -1; index = buffer.indexOf(NEWLINE, start)) {
      records.push(parseRecord(buffer.subarray(start, index)));
      start = index + 1;
    }
    current.end += start;
    current.size = size;
    return records;
  };
  const drop = async (): Promise<void> => {
    const current = file;
    file = undefined;
    await current?.handle.close().catch(() => undefined);
  };
  const closedPoll = (closedState: Closed, reset: boolean): TranscriptPoll => ({ status: closedState.status, reset, appended: [], ...(closedState.reason === undefined ? {} : { reason: closedState.reason }) });
  const openPoll = async (filePath: string, sessionId: string, reset: boolean): Promise<TranscriptPoll> => {
    const opened = await openChecked(filePath, sessionId);
    if (!("handle" in opened)) return closedPoll(opened, reset);
    file = opened;
    return { status: "available", reset, appended: await linesTo(opened, opened.size) };
  };
  const poll = async (filePath: string, sessionId: string): Promise<TranscriptPoll> => {
    const current = file;
    if (current === undefined) return openPoll(filePath, sessionId, false);
    const descriptor = await current.handle.stat({ bigint: true });
    const named = await stat(filePath, { bigint: true }).catch(() => undefined);
    const size = Number(descriptor.size);
    // Pi appends to a session file it wrote, but rewrites one in place when it migrates an older session version on open, and another file can be renamed over the path.
    //NOTE: a rewrite in place that leaves the file at least as long as before is not detected.
    if (named === undefined || named.dev !== current.dev || named.ino !== current.ino || size < current.size) {
      await drop();
      return openPoll(filePath, sessionId, true);
    }
    if (size === current.size) return { status: "available", reset: false, appended: [] };
    return { status: "available", reset: false, appended: await linesTo(current, size) };
  };

  return {
    async poll() {
      if (closed) return closedPoll(unavailable("the transcript source is closed"), false);
      if (path === undefined || reference === undefined) return closedPoll({ status: "waiting" }, false);
      const hadFile = file !== undefined;
      try { return await poll(path, reference.sessionId); } catch (error) {
        await drop();
        return closedPoll(failure(error), hadFile);
      }
    },
    async close() {
      closed = true;
      await drop();
    },
  };
}
