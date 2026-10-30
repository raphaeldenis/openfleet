export type Biller = 'subscription' | 'api';

export type CostStatus = 'reported' | 'unpriced';

export interface UsageRow {
  messageId: string;
  timestamp: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUsd: number | null;
  costStatus: CostStatus;
}

export interface ParseResult {
  rows: UsageRow[];
  skippedLineCount: number;
  /** The skipped lines that no honest transcript writes; a subset of skippedLineCount. */
  rejectedLineCount: number;
}

export interface LedgerRow extends UsageRow {
  sessionId: string;
  billingCode: string;
  biller: Biller;
}

export interface UsageTotals {
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  reportedCostUsd: number;
  unpricedMessageCount: number;
}
