import { constants, type BigIntStats } from "node:fs";
import { open, stat, type FileHandle } from "node:fs/promises";
import { TRANSCRIPT_CHUNK_BYTES, TRANSCRIPT_LARGE_RECORD_BYTES, type TranscriptPoll, type TranscriptRecord, type TranscriptSource } from "./transcript-source.js";
import type { WorkflowAgentSessionReference } from "./types.js";

/** Bytes per read while looking for the newline of a line longer than the chunk. */
const SCAN_BLOCK_BYTES = 64 * 1024;
/** Pi bounds its own session header scan to 1 MiB (MAX_SESSION_HEADER_SCAN_BYTES). */
const HEADER_LIMIT_BYTES = 1024 * 1024;
const NEWLINE = 0x0a;
//NOTE: Windows has neither flag; there the open is a plain read-only open.
const { O_NONBLOCK = 0, O_NOFOLLOW = 0 } = constants as Partial<typeof constants>;
const OPEN_FLAGS = constants.O_RDONLY | O_NONBLOCK | O_NOFOLLOW;

interface OpenFile { readonly handle: FileHandle; readonly dev: bigint; readonly ino: bigint; size: number; start: number; end: number }
interface Closed { readonly status: "waiting" | "unavailable"; readonly reason?: string }

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function errorCode(error: unknown): string | undefined { return isRecord(error) && typeof error.code === "string" ? error.code : undefined; }
function unavailable(reason: string): Closed { return { status: "unavailable", reason }; }
function failure(error: unknown): Closed { return unavailable(`cannot read the session file (${errorCode(error) ?? (error instanceof Error ? error.message : String(error))})`); }
function sessionFilePath(reference: WorkflowAgentSessionReference | undefined): string | undefined {
  const locator = reference?.locator;
  return isRecord(locator) && typeof locator.sessionFile === "string" && locator.sessionFile !== "" ? locator.sessionFile : undefined;
}
function parseValue(line: Buffer): unknown { try { return JSON.parse(line.toString("utf8")); } catch { return undefined; } }
function parseRecord(line: Buffer, offset: number): TranscriptRecord {
  const value = parseValue(line);
  return isRecord(value) ? { kind: "entry", offset, bytes: line.length, value } : { kind: "unreadable", offset, bytes: line.length };
}

async function readAt(handle: FileHandle, position: number, length: number): Promise<Buffer> {
  const buffer = Buffer.allocUnsafe(length);
  let filled = 0;
  while (filled < length) {
    const { bytesRead } = await handle.read(buffer, filled, length - filled, position + filled);
    if (bytesRead === 0) break;
    filled += bytesRead;
  }
  return buffer.subarray(0, filled);
}
/** Position of the first newline in [from, to), read in blocks; -1 when there is none. */
async function newlineAfter(handle: FileHandle, from: number, to: number): Promise<number> {
  for (let position = from; position < to; position += SCAN_BLOCK_BYTES) {
    const block = await readAt(handle, position, Math.min(SCAN_BLOCK_BYTES, to - position));
    const index = block.indexOf(NEWLINE);
    if (index !== -1) return position + index;
  }
  return -1;
}
/** Position of the last newline in [0, to), read backward in blocks; -1 when there is none. */
async function newlineBefore(handle: FileHandle, to: number): Promise<number> {
  for (let end = to; end > 0; end -= SCAN_BLOCK_BYTES) {
    const position = Math.max(0, end - SCAN_BLOCK_BYTES);
    const index = (await readAt(handle, position, end - position)).lastIndexOf(NEWLINE);
    if (index !== -1) return position + index;
  }
  return -1;
}

/** Opens `path` once and runs the identity checks on that descriptor; on success the descriptor is the only way the file is read. */
async function openChecked(path: string, sessionId: string): Promise<OpenFile | Closed> {
  let handle: FileHandle;
  try { handle = await open(path, OPEN_FLAGS); } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return { status: "waiting" };
    if (code === "ELOOP") return unavailable("the session path is a symbolic link");
    if (code === "EACCES" || code === "EPERM") return unavailable("the session file is not readable");
    return failure(error);
  }
  const rejected = async (closed: Closed): Promise<Closed> => { await handle.close().catch(() => undefined); return closed; };
  try {
    const stats: BigIntStats = await handle.stat({ bigint: true });
    if (!stats.isFile()) return await rejected(unavailable("the session path is not a regular file"));
    const size = Number(stats.size);
    const headerEnd = await newlineAfter(handle, 0, Math.min(size, HEADER_LIMIT_BYTES + 1));
    if (headerEnd === -1) return await rejected(size <= HEADER_LIMIT_BYTES ? { status: "waiting" } : unavailable("the session header is longer than 1 MiB"));
    const header = parseValue(await readAt(handle, 0, headerEnd));
    if (!isRecord(header) || header.type !== "session" || typeof header.id !== "string") return await rejected(unavailable("the file does not start with a pi session header"));
    if (header.id !== sessionId) return await rejected(unavailable("the file belongs to another session"));
    return { handle, dev: stats.dev, ino: stats.ino, size, start: 0, end: 0 };
  } catch (error) { return await rejected(failure(error)); }
}

/**
 * The transcript of one pi session file. Reads the last chunk first, earlier chunks on request and complete lines appended
 * since the previous poll; lines longer than the chunk or than `largeRecordBytes` stay unread until loadRecord.
 */
export function openSessionTranscript(reference: WorkflowAgentSessionReference | undefined, options: { chunkBytes?: number; largeRecordBytes?: number } = {}): TranscriptSource {
  const chunkBytes = options.chunkBytes ?? TRANSCRIPT_CHUNK_BYTES;
  const largeBytes = options.largeRecordBytes ?? TRANSCRIPT_LARGE_RECORD_BYTES;
  const path = sessionFilePath(reference);
  let closed = false;
  let file: OpenFile | undefined;

  /** Appends a record per line of `buffer`, which ends with a newline; `base` is the file offset of buffer[0]. */
  const pushLines = (records: TranscriptRecord[], buffer: Buffer, base: number): void => {
    let start = 0;
    for (let index = buffer.indexOf(NEWLINE); index !== -1; index = buffer.indexOf(NEWLINE, start)) {
      const line = buffer.subarray(start, index);
      records.push(line.length > largeBytes ? { kind: "large", offset: base + start, bytes: line.length } : parseRecord(line, base + start));
      start = index + 1;
    }
  };
  /** The lines before `limit` (a line boundary) that fit in one chunk, or the one longer line ending there. */
  const chunkBefore = async (handle: FileHandle, limit: number): Promise<{ records: TranscriptRecord[]; start: number }> => {
    // The window also holds the newline ending the chunk and the byte before its first line, so a line of exactly chunkBytes fits.
    const base = Math.max(0, limit - chunkBytes - 2);
    //NOTE: a short read means the file shrank since the last poll; the next poll resets.
    const buffer = await readAt(handle, base, limit - base);
    const records: TranscriptRecord[] = [];
    const first = base === 0 ? -1 : buffer.indexOf(NEWLINE);
    if (base === 0 || (first !== -1 && first < buffer.length - 1)) {
      pushLines(records, buffer.subarray(first + 1), base + first + 1);
      return { records, start: base + first + 1 };
    }
    const start = await newlineBefore(handle, base) + 1;
    records.push({ kind: "large", offset: start, bytes: limit - 1 - start });
    return { records, start };
  };
  /** Complete lines in [from, size); a trailing line without a newline is left for a later poll. */
  const linesFrom = async (handle: FileHandle, from: number, size: number): Promise<{ records: TranscriptRecord[]; end: number }> => {
    const records: TranscriptRecord[] = [];
    let position = from;
    while (position < size) {
      const buffer = await readAt(handle, position, Math.min(chunkBytes + 1, size - position));
      const last = buffer.lastIndexOf(NEWLINE);
      if (last !== -1) { pushLines(records, buffer.subarray(0, last + 1), position); position += last + 1; continue; }
      if (buffer.length <= chunkBytes) break;
      const newline = await newlineAfter(handle, position + buffer.length, size);
      if (newline === -1) break;
      records.push({ kind: "large", offset: position, bytes: newline - position });
      position = newline + 1;
    }
    return { records, end: position };
  };
  const drop = async (): Promise<void> => {
    const current = file;
    file = undefined;
    await current?.handle.close().catch(() => undefined);
  };
  const closedPoll = (closedState: Closed, reset: boolean): TranscriptPoll => ({ status: closedState.status, reset, appended: [], atStart: true, ...(closedState.reason === undefined ? {} : { reason: closedState.reason }) });
  const openPoll = async (filePath: string, sessionId: string, reset: boolean): Promise<TranscriptPoll> => {
    const opened = await openChecked(filePath, sessionId);
    if (!("handle" in opened)) return closedPoll(opened, reset);
    file = opened;
    const end = await newlineBefore(opened.handle, opened.size) + 1;
    const chunk = await chunkBefore(opened.handle, end);
    opened.start = chunk.start;
    opened.end = end;
    return { status: "available", reset, appended: chunk.records, atStart: chunk.start === 0 };
  };
  const poll = async (filePath: string, sessionId: string): Promise<TranscriptPoll> => {
    const current = file;
    if (current === undefined) return openPoll(filePath, sessionId, false);
    const descriptor = await current.handle.stat({ bigint: true });
    const named = await stat(filePath, { bigint: true }).catch(() => undefined);
    const size = Number(descriptor.size);
    if (named === undefined || named.dev !== current.dev || named.ino !== current.ino || size < current.size) {
      await drop();
      return openPoll(filePath, sessionId, true);
    }
    current.size = size;
    const appended = await linesFrom(current.handle, current.end, size);
    current.end = appended.end;
    return { status: "available", reset: false, appended: appended.records, atStart: current.start === 0 };
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
    async loadEarlier() {
      const current = file;
      if (closed || current === undefined || current.start === 0) return { records: [], atStart: true };
      const chunk = await chunkBefore(current.handle, current.start);
      current.start = chunk.start;
      return { records: chunk.records, atStart: chunk.start === 0 };
    },
    async loadRecord(record) {
      const current = file;
      const buffer = closed || current === undefined ? undefined : await readAt(current.handle, record.offset, record.bytes);
      return buffer?.length === record.bytes ? parseRecord(buffer, record.offset) : { kind: "unreadable", offset: record.offset, bytes: record.bytes };
    },
    async close() {
      closed = true;
      await drop();
    },
  };
}
