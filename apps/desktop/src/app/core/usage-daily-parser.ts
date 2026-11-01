export interface UsageDailyRow {
  readonly dayUtc: string;
  readonly model: string;
  readonly sessionId: string;
  readonly billingCode: string;
  readonly biller: 'subscription' | 'api';
  readonly costStatus: 'reported' | 'unpriced';
  readonly messageCount: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  /** The sum of the reported costs; null for an unpriced bucket. */
  readonly costUsd: number | null;
}

const UTC_DAY = /^\d{4}-\d{2}-\d{2}$/;
const BILLERS: readonly unknown[] = ['subscription', 'api'];
const COST_STATUSES: readonly unknown[] = ['reported', 'unpriced'];

const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isNonEmptyText = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
const isCost = (value: unknown): value is number | null => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);

function parseRow(candidate: unknown): UsageDailyRow | null {
  const isObject = candidate !== null && typeof candidate === 'object';
  if (!isObject) return null;
  const row = candidate as Partial<Record<keyof UsageDailyRow, unknown>>;
  const hasReadableDay = typeof row.dayUtc === 'string' && UTC_DAY.test(row.dayUtc);
  const hasReadableLabels = isNonEmptyText(row.model) && isNonEmptyText(row.sessionId) && typeof row.billingCode === 'string' && BILLERS.includes(row.biller) && COST_STATUSES.includes(row.costStatus);
  const hasReadableCounts = [row.messageCount, row.inputTokens, row.outputTokens, row.cacheReadInputTokens, row.cacheCreationInputTokens].every(isCount);
  const isReadable = hasReadableDay && hasReadableLabels && hasReadableCounts && isCost(row.costUsd);
  return isReadable ? (row as unknown as UsageDailyRow) : null;
}

/** Reads the daemon's answer to GET /api/usage/daily; null when the body or any bucket is unreadable, so a bad answer never shows as zeros. */
export function parseUsageDaily(body: unknown): UsageDailyRow[] | null {
  const items = body !== null && typeof body === 'object' ? (body as { items?: unknown }).items : undefined;
  if (!Array.isArray(items)) return null;
  const rows = items.map(parseRow);
  const hasUnreadableRow = rows.includes(null);
  return hasUnreadableRow ? null : (rows as UsageDailyRow[]);
}
