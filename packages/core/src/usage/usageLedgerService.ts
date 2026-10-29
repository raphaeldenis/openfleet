import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { inTransaction } from '../db/transaction.js';
import { buildLedgerRows } from './aggregateUsage.js';
import { parseUsageLines } from './parseUsageLines.js';
import type { Biller, CostStatus, LedgerRow } from './types.js';

const UTC_DAY_KEY_LENGTH = 'YYYY-MM-DD'.length;

export interface IngestTranscriptInput {
  sessionId: string;
  biller: Biller;
  transcriptText: string;
  billingCodeOf: (sessionId: string) => string;
}

export interface IngestResult {
  messageCount: number;
  skippedLineCount: number;
}

export interface UsageDailyRow {
  dayUtc: string;
  model: string;
  sessionId: string;
  billingCode: string;
  biller: Biller;
  costStatus: CostStatus;
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  /** The sum of the reported costs; null for an unpriced bucket. */
  costUsd: number | null;
}

export interface UsageDailyFilter {
  fromDayUtc?: string;
  toDayUtc?: string;
  sessionId?: string;
  billingCode?: string;
  model?: string;
}

type BucketKey = Pick<UsageDailyRow, 'dayUtc' | 'model' | 'sessionId' | 'billingCode' | 'biller' | 'costStatus'>;

interface BucketRow {
  day_utc: string; model: string; session_id: string; billing_code: string; biller: Biller; cost_status: CostStatus;
  message_count: number; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number;
  cost_usd: number | null;
}

const toDailyRow = (row: BucketRow): UsageDailyRow => ({
  dayUtc: row.day_utc, model: row.model, sessionId: row.session_id, billingCode: row.billing_code, biller: row.biller, costStatus: row.cost_status,
  messageCount: row.message_count, inputTokens: row.input_tokens, outputTokens: row.output_tokens,
  cacheReadInputTokens: row.cache_read_input_tokens, cacheCreationInputTokens: row.cache_creation_input_tokens, costUsd: row.cost_usd,
});

const bucketKeyOfLedgerRow = (row: LedgerRow): BucketKey => ({
  dayUtc: new Date(row.timestamp).toISOString().slice(0, UTC_DAY_KEY_LENGTH),
  model: row.model, sessionId: row.sessionId, billingCode: row.billingCode, biller: row.biller, costStatus: row.costStatus,
});

const bucketKeyOfStoredMessage = (row: BucketRow): BucketKey => toDailyRow(row);

const identityOf = (key: BucketKey) => JSON.stringify([key.dayUtc, key.model, key.sessionId, key.billingCode, key.biller, key.costStatus]);

/**
 * Stores per-message usage and the daily buckets derived from it. A message is identified by its session and id, so
 * ingesting the same text again changes nothing and a message seen again replaces its earlier counts. It reads no file:
 * the caller hands over the transcript text.
 */
export class UsageLedgerService {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  ingestTranscript({ sessionId, biller, transcriptText, billingCodeOf }: IngestTranscriptInput): IngestResult {
    const { rows, skippedLineCount } = parseUsageLines(transcriptText);
    const ledgerRows = buildLedgerRows({ sessionId, biller, rows, billingCodeOf });
    inTransaction(this.db, 'usage_ingest', () => {
      const touchedBuckets = new Map<string, BucketKey>();
      for (const ledgerRow of ledgerRows) {
        const previousVersion = this.storedMessage(ledgerRow);
        if (previousVersion) this.touch(touchedBuckets, bucketKeyOfStoredMessage(previousVersion));
        this.upsertMessage(ledgerRow);
        this.touch(touchedBuckets, bucketKeyOfLedgerRow(ledgerRow));
      }
      for (const bucket of touchedBuckets.values()) this.rebuildBucket(bucket);
    });
    return { messageCount: ledgerRows.length, skippedLineCount };
  }

  dailyUsage(filter: UsageDailyFilter): UsageDailyRow[] {
    const conditions: string[] = [];
    const parameters: SQLInputValue[] = [];
    const addCondition = (condition: string, value: string | undefined) => {
      if (value === undefined) return;
      conditions.push(condition);
      parameters.push(value);
    };
    addCondition('day_utc >= ?', filter.fromDayUtc);
    addCondition('day_utc <= ?', filter.toDayUtc);
    addCondition('session_id = ?', filter.sessionId);
    addCondition('billing_code = ?', filter.billingCode);
    addCondition('model = ?', filter.model);
    const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
    const rows = this.db.prepare(`SELECT * FROM usage_daily ${where} ORDER BY day_utc, model, session_id, billing_code, biller, cost_status`).all(...parameters) as unknown as BucketRow[];
    return rows.map(toDailyRow);
  }

  private touch(touchedBuckets: Map<string, BucketKey>, bucket: BucketKey): void {
    touchedBuckets.set(identityOf(bucket), bucket);
  }

  private storedMessage({ sessionId, messageId }: LedgerRow): BucketRow | undefined {
    return this.db.prepare(`SELECT day_utc, model, session_id, billing_code, biller, cost_status, 0 AS message_count, 0 AS input_tokens, 0 AS output_tokens, 0 AS cache_read_input_tokens, 0 AS cache_creation_input_tokens, NULL AS cost_usd
      FROM usage_messages WHERE session_id = ? AND message_id = ?`).get(sessionId, messageId) as BucketRow | undefined;
  }

  private upsertMessage(row: LedgerRow): void {
    const { dayUtc } = bucketKeyOfLedgerRow(row);
    this.db.prepare(`INSERT INTO usage_messages (session_id, message_id, day_utc, model, billing_code, biller, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost_usd, cost_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (session_id, message_id) DO UPDATE SET day_utc = excluded.day_utc, model = excluded.model, billing_code = excluded.billing_code, biller = excluded.biller,
        input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, cache_read_input_tokens = excluded.cache_read_input_tokens,
        cache_creation_input_tokens = excluded.cache_creation_input_tokens, cost_usd = excluded.cost_usd, cost_status = excluded.cost_status`)
      .run(row.sessionId, row.messageId, dayUtc, row.model, row.billingCode, row.biller, row.inputTokens, row.outputTokens, row.cacheReadInputTokens, row.cacheCreationInputTokens, row.costUsd, row.costStatus);
  }

  private rebuildBucket(bucket: BucketKey): void {
    const keyParameters = [bucket.dayUtc, bucket.model, bucket.sessionId, bucket.billingCode, bucket.biller, bucket.costStatus];
    const sameBucket = 'day_utc = ? AND model = ? AND session_id = ? AND billing_code = ? AND biller = ? AND cost_status = ?';
    this.db.prepare(`DELETE FROM usage_daily WHERE ${sameBucket}`).run(...keyParameters);
    this.db.prepare(`INSERT INTO usage_daily (day_utc, model, session_id, billing_code, biller, cost_status, message_count, input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens, cost_usd)
      SELECT day_utc, model, session_id, billing_code, biller, cost_status, COUNT(*), SUM(input_tokens), SUM(output_tokens), SUM(cache_read_input_tokens), SUM(cache_creation_input_tokens),
        CASE cost_status WHEN 'reported' THEN SUM(cost_usd) END
      FROM usage_messages WHERE ${sameBucket}
      GROUP BY day_utc, model, session_id, billing_code, biller, cost_status`).run(...keyParameters);
  }
}
