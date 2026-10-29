import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { applyMigrations } from '../db/migrate.js';
import { UsageLedgerService } from './usageLedgerService.js';

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

const newService = () => {
  const db = new DatabaseSync(':memory:');
  applyMigrations(db);
  return new UsageLedgerService(db);
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

    expect(result).toEqual({ messageCount: 2, skippedLineCount: 1 });
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
