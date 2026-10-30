import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase } from '../db/database.js';
import { recentLogLines } from '../logger.js';
import { createTempDirTracker } from '../tempDirTracker.js';
import { TranscriptUsageIngestion } from './transcriptUsageIngestion.js';
import { UsageLedgerService } from './usageLedgerService.js';

const tempDirs = createTempDirTracker();
afterEach(() => tempDirs.removeAll());

const assistantLine = (id: string, messageText: string) =>
  JSON.stringify({ type: 'assistant', timestamp: '2026-10-30T10:00:00.000Z', message: { id, model: 'model-a', content: [{ type: 'text', text: messageText }], usage: { input_tokens: 120, output_tokens: 30 } } });

const writeTranscript = (lines: string[]): string => {
  const path = join(tempDirs.make('of-usage-ingest-'), 'transcript.jsonl');
  writeFileSync(path, lines.join('\n'));
  return path;
};

const everyStoredValue = (db: DatabaseSync): string => {
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[];
  return JSON.stringify(tables.map(({ name }) => db.prepare(`SELECT * FROM "${name}"`).all()));
};

function newIngestion(options: { transcriptFile?: string; parents?: Record<string, string> } = {}) {
  const db = openDatabase(':memory:');
  const ledger = new UsageLedgerService(db);
  const readTextFile = vi.fn((path: string) => readFileSync(path, 'utf8'));
  const ingestion = new TranscriptUsageIngestion({
    ledger,
    trustedTranscriptFileOf: () => options.transcriptFile,
    parentOf: (sessionId) => options.parents?.[sessionId],
    readTextFile,
  });
  return { db, ledger, ingestion, readTextFile };
}

describe('TranscriptUsageIngestion', () => {
  it('records the token counts of the trusted transcript of the session', () => {
    const { ledger, ingestion } = newIngestion({ transcriptFile: writeTranscript([assistantLine('m1', 'hello')]) });

    ingestion.ingestAtStop('s1');

    expect(ledger.dailyUsage({ sessionId: 's1' }).map(({ inputTokens, outputTokens }) => [inputTokens, outputTokens])).toEqual([[120, 30]]);
  });

  it('keeps the text of the messages out of the database, the logs and the API answers', async () => {
    const canary = `canary-${randomUUID()}`;
    const brokenLine = `{"type":"assistant","message":{"content":"${canary}`;
    const transcriptFile = writeTranscript([assistantLine('m1', canary), brokenLine, `plain text ${canary}`]);
    const { db, ledger, ingestion } = newIngestion({ transcriptFile });

    ingestion.ingestAtStop('s1');

    expect(ledger.dailyUsage({}).length).toBe(1);
    expect(everyStoredValue(db)).not.toContain(canary);
    expect(JSON.stringify(ledger.dailyUsage({}))).not.toContain(canary);
    expect(recentLogLines().join('\n')).not.toContain(canary);
  });

  it('reads nothing when the session has no trusted transcript', () => {
    const { ledger, ingestion, readTextFile } = newIngestion({ transcriptFile: undefined });

    ingestion.ingestAtStop('s1');

    expect(readTextFile).not.toHaveBeenCalled();
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

  it('does not throw when the file cannot be read, and logs a fixed message without the error text', () => {
    const canary = `canary-${randomUUID()}`;
    const db = openDatabase(':memory:');
    const ingestion = new TranscriptUsageIngestion({
      ledger: new UsageLedgerService(db),
      trustedTranscriptFileOf: () => '/trusted/transcript.jsonl',
      parentOf: () => undefined,
      readTextFile: () => { throw new Error(canary); },
    });

    expect(() => ingestion.ingestAtStop('s1')).not.toThrow();

    expect(recentLogLines().join('\n')).not.toContain(canary);
    expect(recentLogLines().join('\n')).toContain('usage ingestion');
  });
});
