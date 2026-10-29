import type { Biller, LedgerRow, UsageRow, UsageTotals } from './types.js';

interface BuildLedgerRowsInput {
  sessionId: string;
  biller: Biller;
  rows: UsageRow[];
  billingCodeOf: (sessionId: string) => string;
}

const UTC_DAY_KEY_LENGTH = 'YYYY-MM-DD'.length;

// Stamps usage rows with the session, biller and billing code the caller supplies; none of them is inferred.
export function buildLedgerRows({ sessionId, biller, rows, billingCodeOf }: BuildLedgerRowsInput): LedgerRow[] {
  const billingCode = billingCodeOf(sessionId);
  return rows.map((row) => ({ ...row, sessionId, billingCode, biller }));
}

export function aggregateBySession(rows: LedgerRow[]): Map<string, UsageTotals> {
  return aggregateBy(rows, (row) => row.sessionId);
}

export function aggregateByLineage(rows: LedgerRow[]): Map<string, UsageTotals> {
  return aggregateBy(rows, (row) => row.billingCode);
}

// Keys are UTC calendar days (YYYY-MM-DD).
export function aggregateByDayUtc(rows: UsageRow[]): Map<string, UsageTotals> {
  return aggregateBy(rows, (row) => new Date(row.timestamp).toISOString().slice(0, UTC_DAY_KEY_LENGTH));
}

export function aggregateByModel(rows: UsageRow[]): Map<string, UsageTotals> {
  return aggregateBy(rows, (row) => row.model);
}

// Sums are plain numbers: past Number.MAX_SAFE_INTEGER a total is approximate. The cost sums reported costs only;
// unpriced messages are counted apart.
function aggregateBy<Row extends UsageRow>(rows: Row[], keyOf: (row: Row) => string): Map<string, UsageTotals> {
  const totalsByKey = new Map<string, UsageTotals>();
  for (const row of rows) {
    const key = keyOf(row);
    const totals = totalsByKey.get(key) ?? emptyTotals();
    totals.messageCount += 1;
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.cacheReadInputTokens += row.cacheReadInputTokens;
    totals.cacheCreationInputTokens += row.cacheCreationInputTokens;
    if (row.costStatus === 'reported' && row.costUsd !== null) totals.reportedCostUsd += row.costUsd;
    else totals.unpricedMessageCount += 1;
    totalsByKey.set(key, totals);
  }
  return totalsByKey;
}

function emptyTotals(): UsageTotals {
  return {
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    reportedCostUsd: 0,
    unpricedMessageCount: 0,
  };
}
