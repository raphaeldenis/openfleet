import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../db/migrate.js';
import { DEFAULT_USAGE_LEDGER_LIMITS, UsageLedgerService, type IngestTranscriptInput, type TimestampWindow, type UsageDailyFilter, type UsageLedgerLimits } from './usageLedgerService.js';

interface LineOverrides {
  id: string;
  timestamp: string;
  model: string;
  outputTokens?: number;
  costUSD?: number;
}

function assistantLine({ id, timestamp, model, outputTokens = 20, costUSD }: LineOverrides): string {
  const usage = { input_tokens: 10, output_tokens: outputTokens, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 };
  const entry: Record<string, unknown> = { type: 'assistant', timestamp, message: { id, model, content: 'fixture', usage } };
  if (costUSD !== undefined) entry.costUSD = costUSD;
  return JSON.stringify(entry);
}

const transcriptOf = (...lines: string[]) => lines.join('\n');
const DAY_ONE = '2026-10-01T10:00:00.000Z';
const DAY_TWO = '2026-10-02T23:59:59.000Z';
const rootBillingCode = () => 'root-lead';

const EVERY_INSTANT: TimestampWindow = { earliestMs: -8.64e15, latestMs: 8.64e15 };

type IngestInput = Omit<IngestTranscriptInput, 'timestampWindow'> & Partial<Pick<IngestTranscriptInput, 'timestampWindow'>>;

const newService = (limits?: UsageLedgerLimits) => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  const service = new UsageLedgerService(db, limits);
  return {
    ingestTranscript: (input: IngestInput) => service.ingestTranscript({ timestampWindow: EVERY_INSTANT, ...input }),
    dailyUsage: (filter: UsageDailyFilter) => service.dailyUsage(filter),
  };
};

const sessionOne = transcriptOf(
  assistantLine({ id: 'm1', timestamp: DAY_ONE, model: 'model-a', costUSD: 0.5 }),
  assistantLine({ id: 'm2', timestamp: DAY_ONE, model: 'model-b' }),
);
const sessionTwo = transcriptOf(
  assistantLine({ id: 'm3', timestamp: DAY_TWO, model: 'model-a', costUSD: 0.25 }),
  assistantLine({ id: 'm4', timestamp: DAY_TWO, model: 'model-a', costUSD: 0.25 }),
);

const tokensOfOneMessage = { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 };

describe('UsageLedgerService', () => {
  it('aggregates two synthetic transcripts over two models and two days', () => {
    const service = newService();

    service.ingestTranscript({ sessionId: 's1', biller: 'subscription', transcriptText: sessionOne, billingCodeOf: rootBillingCode });
    service.ingestTranscript({ sessionId: 's2', biller: 'api', transcriptText: sessionTwo, billingCodeOf: () => 'root-other' });

    expect(service.dailyUsage({})).toEqual([
      { dayUtc: '2026-10-01', model: 'model-a', sessionId: 's1', billingCode: 'root-lead', biller: 'subscription', costStatus: 'reported', messageCount: 1, ...tokensOfOneMessage, costUsd: 0.5 },
      { dayUtc: '2026-10-01', model: 'model-b', sessionId: 's1', billingCode: 'root-lead', biller: 'subscription', costStatus: 'unpriced', messageCount: 1, ...tokensOfOneMessage, costUsd: null },
      { dayUtc: '2026-10-02', model: 'model-a', sessionId: 's2', billingCode: 'root-other', biller: 'api', costStatus: 'reported', messageCount: 2, inputTokens: 20, outputTokens: 40, cacheReadInputTokens: 60, cacheCreationInputTokens: 80, costUsd: 0.5 },
    ]);
  });

  it('changes nothing when the same transcript text is ingested again', () => {
    const service = newService();
    service.ingestTranscript({ sessionId: 's1', biller: 'subscription', transcriptText: sessionOne, billingCodeOf: rootBillingCode });
    const before = service.dailyUsage({});

    service.ingestTranscript({ sessionId: 's1', biller: 'subscription', transcriptText: sessionOne, billingCodeOf: rootBillingCode });

    expect(service.dailyUsage({})).toEqual(before);
  });

  it('counts a message once when its id appears twice in the stream', () => {
    const service = newService();
    const line = assistantLine({ id: 'm1', timestamp: DAY_ONE, model: 'model-a', costUSD: 0.5 });

    service.ingestTranscript({ sessionId: 's1', biller: 'subscription', transcriptText: transcriptOf(line, line), billingCodeOf: rootBillingCode });

    expect(service.dailyUsage({}).map((row) => row.messageCount)).toEqual([1]);
  });

  it('prices a message with no costUSD as unpriced with no cost', () => {
    const service = newService();

    service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: assistantLine({ id: 'm1', timestamp: DAY_ONE, model: 'model-a' }), billingCodeOf: rootBillingCode });

    expect(service.dailyUsage({})).toMatchObject([{ costStatus: 'unpriced', costUsd: null, messageCount: 1 }]);
  });

  it('replaces the counts of a message that grew between two ingestions instead of adding them', () => {
    const service = newService();
    const partial = assistantLine({ id: 'm1', timestamp: DAY_ONE, model: 'model-a', outputTokens: 5 });
    const complete = assistantLine({ id: 'm1', timestamp: DAY_ONE, model: 'model-a', outputTokens: 50 });
    service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: partial, billingCodeOf: rootBillingCode });

    service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: complete, billingCodeOf: rootBillingCode });

    expect(service.dailyUsage({})).toMatchObject([{ outputTokens: 50, messageCount: 1 }]);
  });

  it('moves a message to the new bucket when its billing code changes, leaving no empty bucket behind', () => {
    const service = newService();
    service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: sessionOne, billingCodeOf: () => 'old-root' });

    service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: sessionOne, billingCodeOf: () => 'new-root' });

    expect(new Set(service.dailyUsage({}).map((row) => row.billingCode))).toEqual(new Set(['new-root']));
  });

  it('counts the same message id of two sessions separately', () => {
    const service = newService();
    const text = assistantLine({ id: 'shared', timestamp: DAY_ONE, model: 'model-a' });

    service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: text, billingCodeOf: rootBillingCode });
    service.ingestTranscript({ sessionId: 's2', biller: 'api', transcriptText: text, billingCodeOf: rootBillingCode });

    expect(service.dailyUsage({}).map((row) => row.sessionId)).toEqual(['s1', 's2']);
  });

  it('reports the lines it skipped and the messages it read', () => {
    const service = newService();

    const result = service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: transcriptOf(sessionOne, 'not json'), billingCodeOf: rootBillingCode });

    expect(result).toEqual({ messageCount: 2, skippedLineCount: 1, rejectedLineCount: 0, sessionIsFull: false });
  });

  it('stores nothing and counts the lines whose model has a forbidden character or whose id is oversized', () => {
    const service = newService();
    const forgedModel = assistantLine({ id: 'm1', timestamp: DAY_ONE, model: 'x'.repeat(10_000) });
    const forgedId = assistantLine({ id: 'm'.repeat(10_000), timestamp: DAY_ONE, model: 'model-a' });

    const result = service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: transcriptOf(forgedModel, forgedId), billingCodeOf: rootBillingCode });

    expect(result).toEqual({ messageCount: 0, skippedLineCount: 2, rejectedLineCount: 2, sessionIsFull: false });
    expect(service.dailyUsage({})).toEqual([]);
  });

  it('does not overflow the bucket sums with more than 1024 forged lines at the largest safe count', () => {
    const service = newService();
    const forgedLines = Array.from({ length: 1100 }, (_, index) => JSON.stringify({
      type: 'assistant', timestamp: DAY_ONE,
      message: { id: `forged-${index}`, model: 'model-a', content: 'fixture', usage: { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 0 } },
    }));
    const ingest = () => service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: transcriptOf(...forgedLines, sessionOne), billingCodeOf: rootBillingCode });

    expect(ingest).not.toThrow();

    expect(service.dailyUsage({ sessionId: 's1' }).reduce((total, bucket) => total + bucket.messageCount, 0)).toBe(2);
  });

  describe('CPU bounds of one ingestion', () => {
    const modelsOf = (service: ReturnType<typeof newService>) => service.dailyUsage({}).map((row) => row.model);

    it('rejects and counts the messages whose timestamp is outside the window', () => {
      const service = newService();
      const timestampWindow = { earliestMs: Date.parse('2026-10-01T00:00:00.000Z'), latestMs: Date.parse('2026-10-03T00:00:00.000Z') };
      const text = transcriptOf(
        assistantLine({ id: 'm1', timestamp: DAY_ONE, model: 'model-a' }),
        assistantLine({ id: 'm2', timestamp: '0001-01-01T00:00:00.000Z', model: 'model-a' }),
        assistantLine({ id: 'm3', timestamp: '9999-12-31T00:00:00.000Z', model: 'model-a' }),
      );

      const result = service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: text, billingCodeOf: rootBillingCode, timestampWindow });

      expect(result).toEqual({ messageCount: 1, skippedLineCount: 2, rejectedLineCount: 2, sessionIsFull: false });
      expect(service.dailyUsage({}).map((row) => row.dayUtc)).toEqual(['2026-10-01']);
    });

    it('rejects and counts the messages that would touch more buckets than the budget of one ingestion', () => {
      const service = newService({ maxBucketsPerChunk: 2, maxMessagesPerSession: 1000 });
      const text = transcriptOf(...['a', 'b', 'c', 'd'].map((letter) => assistantLine({ id: `m-${letter}`, timestamp: DAY_ONE, model: `model-${letter}` })));

      const result = service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: text, billingCodeOf: rootBillingCode });

      expect(result).toMatchObject({ messageCount: 2, rejectedLineCount: 2 });
      expect(modelsOf(service)).toEqual(['model-a', 'model-b']);
    });

    it('keeps admitting messages that fall in a bucket already admitted once the budget is spent', () => {
      const service = newService({ maxBucketsPerChunk: 2, maxMessagesPerSession: 1000 });
      const text = transcriptOf(
        assistantLine({ id: 'm1', timestamp: DAY_ONE, model: 'model-a' }),
        assistantLine({ id: 'm2', timestamp: DAY_ONE, model: 'model-b' }),
        assistantLine({ id: 'm3', timestamp: DAY_ONE, model: 'model-c' }),
        assistantLine({ id: 'm4', timestamp: DAY_ONE, model: 'model-a' }),
      );

      const result = service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: text, billingCodeOf: rootBillingCode });

      expect(result).toMatchObject({ messageCount: 3, rejectedLineCount: 1 });
    });

    it('counts the bucket a stored message leaves in the budget of one ingestion', () => {
      const service = newService({ maxBucketsPerChunk: 2, maxMessagesPerSession: 1000 });
      const original = transcriptOf(assistantLine({ id: 'm1', timestamp: DAY_ONE, model: 'model-a' }), assistantLine({ id: 'm2', timestamp: DAY_ONE, model: 'model-b' }));
      const moved = transcriptOf(assistantLine({ id: 'm1', timestamp: DAY_ONE, model: 'model-c' }), assistantLine({ id: 'm2', timestamp: DAY_ONE, model: 'model-d' }));
      service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: original, billingCodeOf: rootBillingCode });

      const result = service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: moved, billingCodeOf: rootBillingCode });

      expect(result).toMatchObject({ messageCount: 1, rejectedLineCount: 1 });
      expect(modelsOf(service)).toEqual(['model-b', 'model-c']);
    });

    const seedMessages = (db: DatabaseSync, { idPrefix, model, count }: { idPrefix: string; model: (position: string) => string; count: number }) =>
      db.exec(`WITH RECURSIVE seeded(position) AS (SELECT 0 UNION ALL SELECT position + 1 FROM seeded WHERE position < ${count - 1})
        INSERT INTO usage_messages (session_id, message_id, day_utc, model, billing_code, biller, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost_usd, cost_status)
        SELECT 's1', '${idPrefix}' || position, '2026-10-01', ${model('position')}, 'root-lead', 'api', 1, 1, 1, 1, NULL, 'unpriced' FROM seeded`);

    it('rewrites the largest allowed number of buckets of a session one message short of its maximum within a time budget far under the per-bucket rebuild cost', () => {
      const REWRITE_BUDGET_MS = 150;
      const db = new DatabaseSync(':memory:');
      applyMigrations(db);
      const rewrittenCount = DEFAULT_USAGE_LEDGER_LIMITS.maxBucketsPerChunk / 2;
      seedMessages(db, { idPrefix: 'seeded-', model: () => "'model-seeded'", count: DEFAULT_USAGE_LEDGER_LIMITS.maxMessagesPerSession - DEFAULT_USAGE_LEDGER_LIMITS.maxBucketsPerChunk });
      seedMessages(db, { idPrefix: 'live-', model: (position) => `'model-old-' || ${position}`, count: rewrittenCount });
      const service = new UsageLedgerService(db);
      const sameMessagesWithOtherModels = transcriptOf(...Array.from({ length: rewrittenCount }, (_, index) => assistantLine({ id: `live-${index}`, timestamp: DAY_ONE, model: `model-new-${index}` })));

      const startedAt = performance.now();
      const result = service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: sameMessagesWithOtherModels, billingCodeOf: rootBillingCode, timestampWindow: EVERY_INSTANT });
      const durationMs = performance.now() - startedAt;

      const models = service.dailyUsage({ sessionId: 's1' }).map((row) => row.model);
      expect(result).toMatchObject({ messageCount: rewrittenCount, rejectedLineCount: 0 });
      expect(models.filter((model) => model.startsWith('model-old-'))).toEqual([]);
      expect(models.filter((model) => model.startsWith('model-new-'))).toHaveLength(rewrittenCount);
      expect(durationMs).toBeLessThan(REWRITE_BUDGET_MS);
    });

    it('rebuilds the largest allowed number of buckets of a session that reaches its maximum within the time budget', () => {
      const WORST_CASE_BUDGET_MS = 1500;
      const db = new DatabaseSync(':memory:');
      applyMigrations(db);
      seedMessages(db, { idPrefix: 'seeded-', model: () => "'model-seeded'", count: DEFAULT_USAGE_LEDGER_LIMITS.maxMessagesPerSession - DEFAULT_USAGE_LEDGER_LIMITS.maxBucketsPerChunk });
      const service = new UsageLedgerService(db);
      const oneMessagePerBucket = transcriptOf(...Array.from({ length: DEFAULT_USAGE_LEDGER_LIMITS.maxBucketsPerChunk }, (_, index) => assistantLine({ id: `last-${index}`, timestamp: DAY_ONE, model: `model-${index}` })));

      const startedAt = performance.now();
      const result = service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: oneMessagePerBucket, billingCodeOf: rootBillingCode, timestampWindow: EVERY_INSTANT });
      const durationMs = performance.now() - startedAt;

      expect(result).toMatchObject({ messageCount: DEFAULT_USAGE_LEDGER_LIMITS.maxBucketsPerChunk, sessionIsFull: true });
      expect(durationMs).toBeLessThan(WORST_CASE_BUDGET_MS);
    });

    it('stores no new message of a session that holds the maximum, reports it full, and leaves other sessions alone', () => {
      const service = newService({ maxBucketsPerChunk: 32, maxMessagesPerSession: 2 });
      const threeMessages = transcriptOf(...['1', '2', '3'].map((suffix) => assistantLine({ id: `m${suffix}`, timestamp: DAY_ONE, model: 'model-a' })));

      const first = service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: threeMessages, billingCodeOf: rootBillingCode });
      const later = service.ingestTranscript({ sessionId: 's1', biller: 'api', transcriptText: assistantLine({ id: 'm4', timestamp: DAY_ONE, model: 'model-a' }), billingCodeOf: rootBillingCode });
      service.ingestTranscript({ sessionId: 's2', biller: 'api', transcriptText: threeMessages, billingCodeOf: rootBillingCode });

      expect([first.messageCount, first.sessionIsFull, later.messageCount, later.sessionIsFull]).toEqual([2, true, 0, true]);
      expect(service.dailyUsage({ sessionId: 's1' }).map((row) => row.messageCount)).toEqual([2]);
      expect(service.dailyUsage({ sessionId: 's2' }).map((row) => row.messageCount)).toEqual([2]);
    });
  });

  it('filters by day range, session, billing code and model', () => {
    const service = newService();
    service.ingestTranscript({ sessionId: 's1', biller: 'subscription', transcriptText: sessionOne, billingCodeOf: rootBillingCode });
    service.ingestTranscript({ sessionId: 's2', biller: 'api', transcriptText: sessionTwo, billingCodeOf: () => 'root-other' });

    const byDay = service.dailyUsage({ fromDayUtc: '2026-10-02', toDayUtc: '2026-10-02' });
    const bySession = service.dailyUsage({ sessionId: 's1' });
    const byCode = service.dailyUsage({ billingCode: 'root-other' });
    const byModel = service.dailyUsage({ model: 'model-b' });

    expect([byDay.length, bySession.length, byCode.length, byModel.length]).toEqual([1, 2, 1, 1]);
  });
});
