import { log } from '../logger.js';
import { readTranscriptChunk, type ChunkRead } from '../todos/transcriptChunkReader.js';
import type { UsageLedgerService } from './usageLedgerService.js';

/** The most bytes of a transcript read at one Stop; a larger backlog is caught up over the following Stops. */
export const USAGE_INGESTION_CHUNK_BYTES = 1024 * 1024;

const WHOLE_FILE_FROM_THE_START = Number.MAX_SAFE_INTEGER;

const INGESTION_FAILED_MESSAGE = 'usage ingestion: the transcript could not be ingested, recording nothing';

/** A message may be dated this long before its session was created or after now. */
const TIMESTAMP_TOLERANCE_MS = 24 * 60 * 60 * 1000;

export interface TranscriptUsageIngestionDeps {
  ledger: Pick<UsageLedgerService, 'ingestTranscript'>;
  /** The path of the session's own transcript when it passed the daemon's trust checks, else undefined. */
  trustedTranscriptFileOf: (sessionId: string) => string | undefined;
  parentOf: (sessionId: string) => string | undefined;
  /** The ISO creation date of the session, or undefined for an unknown session, whose transcript is then not read. */
  createdAtOf: (sessionId: string) => string | undefined;
  /** Epoch milliseconds; defaults to Date.now. */
  clock?: () => number;
  readChunk?: typeof readTranscriptChunk;
  /** Defaults to USAGE_INGESTION_CHUNK_BYTES. */
  chunkBytes?: number;
}

interface Cursor {
  path: string;
  inode: number;
  offset: number;
  /** True while the cursor sits inside a skipped oversized line, whose remaining bytes up to the next line break are not a line. */
  insideSkippedLine: boolean;
}

/** Drops the end of an oversized line: everything up to and including the first line break. */
const withoutLineTail = (text: string): string => {
  const lineBreak = text.indexOf('\n');
  return lineBreak === -1 ? '' : text.slice(lineBreak + 1);
};

/**
 * Hands the new complete lines of a session's transcript to the usage ledger when the operator has enabled the ingestion.
 * Each call reads at most USAGE_INGESTION_CHUNK_BYTES past the session's cursor, which lives in memory: after a restart the
 * transcript is read again from its start, chunk by chunk over the following Stops (the ledger upsert is idempotent).
 * The ledger keeps the token counts of the assistant lines and nothing else; this class stores, returns and logs no text of the file.
 */
export class TranscriptUsageIngestion {
  private readonly cursors = new Map<string, Cursor>();
  private readonly fullSessions = new Set<string>();

  constructor(private readonly deps: TranscriptUsageIngestionDeps) {}

  /** Throws an error with a fixed message when the ingestion fails; the caller decides what a failure counts for. */
  ingestAtStop(sessionId: string): void {
    try {
      this.ingestNextChunk(sessionId);
    } catch {
      throw new Error(INGESTION_FAILED_MESSAGE);
    }
  }

  forget(sessionId: string): void {
    this.cursors.delete(sessionId);
    this.fullSessions.delete(sessionId);
  }

  private ingestNextChunk(sessionId: string): void {
    if (this.fullSessions.has(sessionId)) return;
    const transcriptFile = this.deps.trustedTranscriptFileOf(sessionId);
    const createdAt = this.deps.createdAtOf(sessionId);
    if (transcriptFile === undefined || createdAt === undefined) return;
    const cursor = this.cursorFor(sessionId, transcriptFile);
    const read = this.readFrom(transcriptFile, cursor);
    if (read.kind === 'nothing') return;
    if (read.kind === 'reset') {
      this.cursors.delete(sessionId);
      return;
    }
    const startedInsideSkippedLine = cursor?.insideSkippedLine === true;
    const readNoLine = read.text === '';
    const advancedPastSkippedLine = readNoLine && read.nextOffset > (cursor?.offset ?? 0);
    const insideSkippedLine = readNoLine ? advancedPastSkippedLine || startedInsideSkippedLine : false;
    const transcriptText = startedInsideSkippedLine ? withoutLineTail(read.text) : read.text;
    this.cursors.set(sessionId, { path: transcriptFile, inode: read.inode, offset: read.nextOffset, insideSkippedLine });
    if (transcriptText === '') return;
    const timestampWindow = { earliestMs: Date.parse(createdAt) - TIMESTAMP_TOLERANCE_MS, latestMs: (this.deps.clock ?? Date.now)() + TIMESTAMP_TOLERANCE_MS };
    const { rejectedLineCount, sessionIsFull } = this.deps.ledger.ingestTranscript({ sessionId, biller: 'subscription', transcriptText, billingCodeOf: (id) => this.rootOf(id), timestampWindow });
    if (rejectedLineCount > 0) log('warn', 'usage ingestion: lines that no honest transcript writes were rejected', undefined, { code: 'usage_lines_rejected', sessionId, rejectedLineCount });
    if (sessionIsFull) this.stopIngestingFullSession(sessionId);
  }

  private stopIngestingFullSession(sessionId: string): void {
    this.fullSessions.add(sessionId);
    log('warn', 'usage ingestion: the session reached its message limit, ingesting nothing more for it', undefined, { code: 'usage_session_full', sessionId });
  }

  private cursorFor(sessionId: string, transcriptFile: string): Cursor | undefined {
    const cursor = this.cursors.get(sessionId);
    const followsAnotherFile = cursor !== undefined && cursor.path !== transcriptFile;
    return followsAnotherFile ? undefined : cursor;
  }

  private readFrom(transcriptFile: string, cursor: Cursor | undefined): ChunkRead {
    const readChunk = this.deps.readChunk ?? readTranscriptChunk;
    return readChunk(transcriptFile, { offset: cursor?.offset ?? 0, inode: cursor?.inode, maxBytes: this.deps.chunkBytes ?? USAGE_INGESTION_CHUNK_BYTES, windowBytes: WHOLE_FILE_FROM_THE_START });
  }

  private rootOf(sessionId: string): string {
    const visited = new Set<string>();
    let current = sessionId;
    while (!visited.has(current)) {
      visited.add(current);
      const parent = this.deps.parentOf(current);
      if (parent === undefined) return current;
      current = parent;
    }
    return current;
  }
}
