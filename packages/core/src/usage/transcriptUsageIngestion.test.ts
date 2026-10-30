import { randomUUID } from 'node:crypto';
import { appendFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { recentLogLines } from '../logger.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { readTranscriptChunk } from '../todos/transcriptChunkReader.js';
import { TranscriptUsageIngestion, USAGE_INGESTION_CHUNK_BYTES } from './transcriptUsageIngestion.js';
import { UsageLedgerService, type UsageLedgerLimits } from './usageLedgerService.js';

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.removeAll());

const SMALL_CHUNK_BYTES = 1024;

const assistantLine = (id: string, messageText: string, model = 'model-a') =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-10-30T10:00:00.000Z', message: { id, model, content: [{ type: 'text', text: messageText }], usage: { input_tokens: 120, output_tokens: 30 } } });

const linesText = (lines: string[]): string => lines.map((line) => `${line}\n`).join('');

const writeTranscript = (lines: string[]): string => {
  const path = join(tempDirs.make('of-usage-ingest-'), 'transcript.jsonl');
  writeFileSync(path, linesText(lines));
  return path;
};

const everyStoredValue = (db: DatabaseSync): string => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return JSON.stringify(tables.map(({ name }) => db.prepare(`SELECT * FROM "${name}"`).all()));
};

const storedMessageCount = (db: DatabaseSync): number => (db.prepare('SELECT COUNT(*) AS total FROM usage_messages').get() as { total: number }).total;

const SESSION_CREATED_AT = '2026-10-29T00:00:00.000Z';
const NOW_MS = Date.parse('2026-10-30T12:00:00.000Z');

interface NewIngestionOptions {
  transcriptFile?: string;
  parents?: Record<string, string>;
  chunkBytes?: number;
  readChunk?: typeof readTranscriptChunk;
  ledgerLimits?: UsageLedgerLimits;
  createdAt?: string | undefined;
}

function newIngestion(options: NewIngestionOptions = {}) {
  const db = openDatabase(':memory:');
  const ledger = new UsageLedgerService(db, options.ledgerLimits);
  const readChunk = vi.fn(options.readChunk ?? readTranscriptChunk);
  const createdAt = 'createdAt' in options ? options.createdAt : SESSION_CREATED_AT;
  const ingestion = new TranscriptUsageIngestion({
    ledger,
    trustedTranscriptFileOf: () => options.transcriptFile,
    parentOf: (sessionId) => options.parents?.[sessionId],
    createdAtOf: () => createdAt,
    clock: () => NOW_MS,
    readChunk,
    chunkBytes: options.chunkBytes,
  });
  return { db, ledger, ingestion, readChunk };
}

describe('TranscriptUsageIngestion', () => {
  it('records the token counts of the trusted transcript of the session', () => {
    const { ledger, ingestion } = newIngestion({ transcriptFile: writeTranscript([assistantLine('m1', 'hello')]) });

    ingestion.ingestAtStop('s1');

    expect(ledger.dailyUsage({ sessionId: 's1' }).map(({ inputTokens, outputTokens }) => [inputTokens, outputTokens])).toEqual([[120, 30]]);
  });

  it('keeps the text of the messages, forged ids and forged models out of the database, the logs and the API answers', () => {
    const canary = `canary-${randomUUID()}`;
    const forgedId = `${canary} forged id`;
    const forgedModel = `${canary}/forged model`;
    const brokenLine = `{"type":"assistant","message":{"content":"${canary}`;
    const transcriptFile = writeTranscript([assistantLine('m1', canary), assistantLine(forgedId, 'x'), assistantLine('m2', 'x', forgedModel), brokenLine, `plain text ${canary}`]);
    const { db, ledger, ingestion } = newIngestion({ transcriptFile });

    ingestion.ingestAtStop('s1');

    expect(ledger.dailyUsage({}).map(({ messageCount }) => messageCount)).toEqual([1]);
    expect(everyStoredValue(db)).not.toContain(canary);
    expect(JSON.stringify(ledger.dailyUsage({}))).not.toContain(canary);
    expect(recentLogLines().join('\n')).not.toContain(canary);
  });

  it('logs a fixed message with the count of the rejected lines', () => {
    const forgedLine = assistantLine('forged id with spaces', 'x');
    const { ingestion } = newIngestion({ transcriptFile: writeTranscript([forgedLine, assistantLine('m1', 'x')]) });

    ingestion.ingestAtStop('s-rejecting');

    expect(recentLogLines().join('\n')).toContain('usage ingestion: lines that no honest transcript writes were rejected');
  });

  it('reads nothing when the session has no trusted transcript', () => {
    const { ledger, ingestion, readChunk } = newIngestion({ transcriptFile: undefined });

    ingestion.ingestAtStop('s1');

    expect(readChunk).not.toHaveBeenCalled();
    expect(ledger.dailyUsage({})).toEqual([]);
  });

  it('bills the root session of the lineage', () => {
    const { ledger, ingestion } = newIngestion({ transcriptFile: writeTranscript([assistantLine('m1', 'hi')]), parents: { child: 'middle', middle: 'root' } });

    ingestion.ingestAtStop('child');

    expect(ledger.dailyUsage({ sessionId: 'child' }).map(({ billingCode, biller }) => [billingCode, biller])).toEqual([['root', 'subscription']]);
  });

  it('stops at a lineage that loops instead of walking forever', () => {
    const { ledger, ingestion } = newIngestion({ transcriptFile: writeTranscript([assistantLine('m1', 'hi')]), parents: { a: 'b', b: 'a' } });

    expect(() => ingestion.ingestAtStop('a')).not.toThrow();

    expect(ledger.dailyUsage({ sessionId: 'a' })).toHaveLength(1);
  });

  it('throws an error with a fixed message, without the error text, when the file cannot be read', () => {
    const canary = `canary-${randomUUID()}`;
    const { ingestion } = newIngestion({ transcriptFile: '/trusted/transcript.jsonl', readChunk: () => { throw new Error(canary); } });

    const failure = (() => { try { ingestion.ingestAtStop('s1'); } catch (error) { return error as Error; } })();

    expect(failure?.message).toContain('usage ingestion');
    expect(failure?.message).not.toContain(canary);
  });

  describe('bounded incremental reading', () => {
    const manyMessages = (count: number) => Array.from({ length: count }, (_, index) => assistantLine(`m${index}`, 'x'.repeat(100)));

    it('asks for at most the chunk size at each Stop', () => {
      const { ingestion, readChunk } = newIngestion({ transcriptFile: writeTranscript(manyMessages(40)), chunkBytes: SMALL_CHUNK_BYTES });

      ingestion.ingestAtStop('s1');

      expect(readChunk.mock.calls.map(([, request]) => request.maxBytes)).toEqual([SMALL_CHUNK_BYTES]);
    });

    it('catches a large transcript up over several Stops without counting a message twice', () => {
      const { db, ingestion } = newIngestion({ transcriptFile: writeTranscript(manyMessages(40)), chunkBytes: SMALL_CHUNK_BYTES });

      ingestion.ingestAtStop('s1');
      const countAfterFirstStop = storedMessageCount(db);
      for (let stop = 0; stop < 40; stop += 1) ingestion.ingestAtStop('s1');

      expect(countAfterFirstStop).toBeGreaterThan(0);
      expect(countAfterFirstStop).toBeLessThan(40);
      expect(storedMessageCount(db)).toBe(40);
    });

    it('resumes from the cursor: a second Stop reads only the lines appended since', () => {
      const transcriptFile = writeTranscript([assistantLine('m1', 'a')]);
      const { db, ingestion, readChunk } = newIngestion({ transcriptFile });
      ingestion.ingestAtStop('s1');

      appendFileSync(transcriptFile, linesText([assistantLine('m2', 'b')]));
      ingestion.ingestAtStop('s1');

      expect(storedMessageCount(db)).toBe(2);
      expect(readChunk.mock.calls[1]?.[1].offset).toBeGreaterThan(0);
    });

    it('leaves an incomplete last line for the next Stop', () => {
      const transcriptFile = writeTranscript([assistantLine('m1', 'a')]);
      appendFileSync(transcriptFile, assistantLine('m2', 'b'));
      const { db, ingestion } = newIngestion({ transcriptFile });

      ingestion.ingestAtStop('s1');
      const countWithPartialLine = storedMessageCount(db);
      appendFileSync(transcriptFile, '\n');
      ingestion.ingestAtStop('s1');

      expect([countWithPartialLine, storedMessageCount(db)]).toEqual([1, 2]);
    });

    it('skips a line longer than the chunk and keeps ingesting the lines after it', () => {
      const oversizedLine = assistantLine('m-big', 'y'.repeat(SMALL_CHUNK_BYTES * 3));
      const { db, ingestion } = newIngestion({ transcriptFile: writeTranscript([oversizedLine, assistantLine('m2', 'b')]), chunkBytes: SMALL_CHUNK_BYTES });

      for (let stop = 0; stop < 10; stop += 1) ingestion.ingestAtStop('s1');

      expect((db.prepare("SELECT message_id FROM usage_messages ORDER BY message_id").all() as { message_id: string }[]).map((row) => row.message_id)).toEqual(['m2']);
    });

    it('does not parse the tail of a skipped oversized line as a line of its own', () => {
      const tailThatLooksLikeALine = assistantLine('m-tail', 'x');
      const oversizedLine = `${'z'.repeat(SMALL_CHUNK_BYTES)}${tailThatLooksLikeALine}`;
      const { db, ingestion } = newIngestion({ transcriptFile: writeTranscript([oversizedLine, assistantLine('m2', 'b')]), chunkBytes: SMALL_CHUNK_BYTES });

      for (let stop = 0; stop < 10; stop += 1) ingestion.ingestAtStop('s1');

      expect((db.prepare('SELECT message_id FROM usage_messages ORDER BY message_id').all() as { message_id: string }[]).map((row) => row.message_id)).toEqual(['m2']);
    });

    it('starts over from the beginning of a file that replaced the transcript', () => {
      const transcriptFile = writeTranscript([assistantLine('m1', 'a')]);
      const { db, ingestion } = newIngestion({ transcriptFile });
      ingestion.ingestAtStop('s1');
      const replacement = join(tempDirs.make('of-usage-replacement-'), 'replacement.jsonl');
      writeFileSync(replacement, linesText([assistantLine('r1', 'a'), assistantLine('r2', 'b')]));
      renameSync(replacement, transcriptFile);

      ingestion.ingestAtStop('s1');
      ingestion.ingestAtStop('s1');

      expect(storedMessageCount(db)).toBe(3);
    });

    it('does not follow a symbolic link planted in place of the transcript', () => {
      const realFile = writeTranscript([assistantLine('m1', 'a')]);
      const linkPath = join(tempDirs.make('of-usage-link-'), 'transcript.jsonl');
      symlinkSync(realFile, linkPath);
      const { db, ingestion } = newIngestion({ transcriptFile: linkPath });

      const outcome = (() => { try { ingestion.ingestAtStop('s1'); return 'returned'; } catch { return 'failed'; } })();

      expect(storedMessageCount(db)).toBe(0);
      expect(outcome).toBe('failed');
    });
  });

  describe('CPU bounds of one Stop', () => {
    const DAY_MS = 24 * 60 * 60 * 1000;
    const SHARED_LOG_MESSAGE_WHEN_FULL = 'usage ingestion: the session reached its message limit, ingesting nothing more for it';

    const lineAt = (id: string, timestamp: string) => assistantLine(id, 'x').replace('2026-10-30T10:00:00.000Z', timestamp);

    const storedIds = (db: DatabaseSync) => (db.prepare('SELECT message_id FROM usage_messages ORDER BY message_id').all() as { message_id: string }[]).map((row) => row.message_id);

    it('rejects the messages dated before the session was created or in the future, and warns', () => {
      const lines = [
        lineAt('too-old', '2026-10-27T00:00:00.000Z'),
        lineAt('day-before-creation', '2026-10-28T06:00:00.000Z'),
        lineAt('tomorrow', '2026-10-31T11:00:00.000Z'),
        lineAt('too-far', '2026-11-05T00:00:00.000Z'),
        lineAt('year-9999', '9999-12-31T00:00:00.000Z'),
      ];
      const { db, ingestion } = newIngestion({ transcriptFile: writeTranscript(lines) });

      ingestion.ingestAtStop('s-window');

      expect(storedIds(db)).toEqual(['day-before-creation', 'tomorrow']);
      expect(recentLogLines().filter((line) => line.includes('s-window') && line.includes('"rejectedLineCount":3'))).toHaveLength(1);
    });

    it('reads nothing of a session whose creation date is unknown', () => {
      const { readChunk, ingestion } = newIngestion({ transcriptFile: writeTranscript([assistantLine('m1', 'a')]), createdAt: undefined });

      ingestion.ingestAtStop('s1');

      expect(readChunk).not.toHaveBeenCalled();
    });

    it('stops reading a session that holds the maximum of messages and warns once with a fixed message', () => {
      const sessionId = `s-full-${randomUUID()}`;
      const { db, ingestion, readChunk } = newIngestion({
        transcriptFile: writeTranscript(Array.from({ length: 5 }, (_, index) => assistantLine(`m${index}`, 'x'))),
        chunkBytes: SMALL_CHUNK_BYTES,
        ledgerLimits: { maxBucketsPerChunk: 32, maxMessagesPerSession: 3 },
      });

      for (let stop = 0; stop < 10; stop += 1) ingestion.ingestAtStop(sessionId);

      const warningsForTheSession = recentLogLines().filter((line) => line.includes(SHARED_LOG_MESSAGE_WHEN_FULL) && line.includes(sessionId));
      expect(storedMessageCount(db)).toBe(3);
      expect(warningsForTheSession).toHaveLength(1);
      expect(readChunk.mock.calls.length).toBeLessThanOrEqual(2);
    });

    describe('one mebibyte of forged lines with distinct days and models', () => {
      const BOUNDED_STOP_BUDGET_MS = 1000;
      const PASSES = 3;
      const FORGED_LINE_PREFIX = '{"type":"assistant","timestamp":"';

      const forgedMebibyte = (timestampOf: (index: number) => string): string => {
        const lines: string[] = [];
        let bytes = 0;
        for (let index = 0; bytes < USAGE_INGESTION_CHUNK_BYTES - 200; index += 1) {
          const line = `${FORGED_LINE_PREFIX}${timestampOf(index)}","message":{"id":"f${index}","model":"m${index}","usage":{"input_tokens":1}}}\n`;
          lines.push(line);
          bytes += line.length;
        }
        return lines.join('');
      };

      const bestStopDurationMs = (transcriptText: string): { bestMs: number; storedMessages: number } => {
        const transcriptFile = join(tempDirs.make('of-usage-forged-'), 'transcript.jsonl');
        writeFileSync(transcriptFile, transcriptText);
        const durations: number[] = [];
        let storedMessages = 0;
        for (let pass = 0; pass < PASSES; pass += 1) {
          const { db, ingestion } = newIngestion({ transcriptFile });
          const startedAt = performance.now();
          ingestion.ingestAtStop('s-forged');
          durations.push(performance.now() - startedAt);
          storedMessages = storedMessageCount(db);
        }
        return { bestMs: Math.min(...durations), storedMessages };
      };

      const MAX_STORED_MESSAGES_OF_ONE_STOP = 32;

      it.each([
        ['distinct models inside the accepted window', (index: number) => new Date(NOW_MS - (index % 3) * DAY_MS).toISOString()],
        ['distinct days across the years 1000 to 9999', (index: number) => new Date(Date.UTC(1000, 0, 1) + index * 200 * DAY_MS).toISOString()],
      ])('keeps a Stop under the time budget: %s', (_name, timestampOf) => {
        const { bestMs, storedMessages } = bestStopDurationMs(forgedMebibyte(timestampOf));

        expect(bestMs).toBeLessThan(BOUNDED_STOP_BUDGET_MS);
        expect(storedMessages).toBeLessThanOrEqual(MAX_STORED_MESSAGES_OF_ONE_STOP);
      }, 120_000);
    });
  });
});
