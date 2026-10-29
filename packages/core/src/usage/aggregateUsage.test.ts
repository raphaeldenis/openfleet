import { describe, expect, it } from 'vitest';
import { aggregateByDayUtc, aggregateByLineage, aggregateByModel, aggregateBySession, buildLedgerRows } from './aggregateUsage.js';
import type { LedgerRow, UsageRow } from './types.js';

function usageRow(overrides: Partial<UsageRow> = {}): UsageRow {
  return {
    messageId: 'msg_1',
    timestamp: '2026-10-01T10:00:00.000Z',
    model: 'model-a',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadInputTokens: 30,
    cacheCreationInputTokens: 40,
    costUsd: null,
    costStatus: 'unpriced',
    ...overrides,
  };
}

function ledgerRow(overrides: Partial<LedgerRow> = {}): LedgerRow {
  return { ...usageRow(), sessionId: 'session_1', billingCode: 'root_1', biller: 'subscription', ...overrides };
}

describe('buildLedgerRows', () => {
  it('stamps each row with the caller-supplied session, biller and the billing code the resolver returns', () => {
    const rows = [usageRow({ messageId: 'msg_1' }), usageRow({ messageId: 'msg_2' })];

    const ledgerRows = buildLedgerRows({
      sessionId: 'child_1',
      biller: 'api',
      rows,
      billingCodeOf: (sessionId) => (sessionId === 'child_1' ? 'root_9' : 'unknown'),
    });

    expect(ledgerRows.map((row) => [row.messageId, row.sessionId, row.billingCode, row.biller])).toEqual([
      ['msg_1', 'child_1', 'root_9', 'api'],
      ['msg_2', 'child_1', 'root_9', 'api'],
    ]);
  });
});

describe('aggregateBySession', () => {
  it('sums the tokens and counts the messages of each session', () => {
    const rows = [
      ledgerRow({ sessionId: 'session_1', inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4 }),
      ledgerRow({ sessionId: 'session_1', inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 30, cacheCreationInputTokens: 40 }),
      ledgerRow({ sessionId: 'session_2', inputTokens: 100, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }),
    ];

    const totals = aggregateBySession(rows);

    expect(totals.get('session_1')).toMatchObject({
      messageCount: 2,
      inputTokens: 11,
      outputTokens: 22,
      cacheReadInputTokens: 33,
      cacheCreationInputTokens: 44,
    });
    expect(totals.get('session_2')).toMatchObject({ messageCount: 1, inputTokens: 100 });
  });

  it('sums only the reported cost and counts the unpriced messages apart', () => {
    const rows = [
      ledgerRow({ costUsd: 0.25, costStatus: 'reported' }),
      ledgerRow({ costUsd: 0.5, costStatus: 'reported' }),
      ledgerRow({ costUsd: null, costStatus: 'unpriced' }),
    ];

    const totals = aggregateBySession(rows).get('session_1');

    expect(totals).toMatchObject({ reportedCostUsd: 0.75, unpricedMessageCount: 1, messageCount: 3 });
  });

  it('returns an empty map for no rows', () => {
    expect(aggregateBySession([]).size).toBe(0);
  });

  it('keeps a total above Number.MAX_SAFE_INTEGER as a number that is no longer an exact integer', () => {
    const rows = [
      ledgerRow({ inputTokens: Number.MAX_SAFE_INTEGER }),
      ledgerRow({ inputTokens: Number.MAX_SAFE_INTEGER }),
    ];

    const totals = aggregateBySession(rows).get('session_1');

    expect(typeof totals?.inputTokens).toBe('number');
    expect(totals?.inputTokens).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    expect(Number.isSafeInteger(totals?.inputTokens)).toBe(false);
  });
});

describe('aggregateByLineage', () => {
  it('groups the sessions that share a billing code', () => {
    const rows = [
      ledgerRow({ sessionId: 'root_1', billingCode: 'root_1', inputTokens: 1 }),
      ledgerRow({ sessionId: 'child_1', billingCode: 'root_1', inputTokens: 2 }),
      ledgerRow({ sessionId: 'other', billingCode: 'root_2', inputTokens: 4 }),
    ];

    const totals = aggregateByLineage(rows);

    expect(totals.get('root_1')).toMatchObject({ messageCount: 2, inputTokens: 3 });
    expect(totals.get('root_2')).toMatchObject({ messageCount: 1, inputTokens: 4 });
  });

  it('groups rows built with an injected resolver under the root of their lineage', () => {
    const parentOf: Record<string, string> = { child_1: 'root_1', grandchild_1: 'child_1' };
    const billingCodeOf = (sessionId: string): string => {
      let current = sessionId;
      while (parentOf[current] !== undefined) current = parentOf[current] as string;
      return current;
    };
    const rows = ['root_1', 'child_1', 'grandchild_1'].flatMap((sessionId) =>
      buildLedgerRows({ sessionId, biller: 'subscription', rows: [usageRow({ messageId: `msg_${sessionId}` })], billingCodeOf }),
    );

    const totals = aggregateByLineage(rows);

    expect([...totals.keys()]).toEqual(['root_1']);
    expect(totals.get('root_1')?.messageCount).toBe(3);
  });
});

describe('aggregateByDayUtc', () => {
  it('puts the last millisecond of a UTC day and the first instant of the next day in different days', () => {
    const rows = [
      usageRow({ messageId: 'msg_late', timestamp: '2026-10-01T23:59:59.999Z', inputTokens: 1 }),
      usageRow({ messageId: 'msg_early', timestamp: '2026-10-02T00:00:00Z', inputTokens: 2 }),
    ];

    const totals = aggregateByDayUtc(rows);

    expect(totals.get('2026-10-01')).toMatchObject({ messageCount: 1, inputTokens: 1 });
    expect(totals.get('2026-10-02')).toMatchObject({ messageCount: 1, inputTokens: 2 });
  });

  it('files a timestamp with a UTC offset under its UTC day', () => {
    const rows = [usageRow({ timestamp: '2026-10-02T01:30:00+02:00' })];

    const totals = aggregateByDayUtc(rows);

    expect([...totals.keys()]).toEqual(['2026-10-01']);
  });
});

describe('aggregateByModel', () => {
  it('keeps one total per model', () => {
    const rows = [
      usageRow({ model: 'model-a', outputTokens: 5 }),
      usageRow({ model: 'model-b', outputTokens: 7 }),
      usageRow({ model: 'model-a', outputTokens: 1 }),
    ];

    const totals = aggregateByModel(rows);

    expect(totals.get('model-a')).toMatchObject({ messageCount: 2, outputTokens: 6 });
    expect(totals.get('model-b')).toMatchObject({ messageCount: 1, outputTokens: 7 });
  });
});
