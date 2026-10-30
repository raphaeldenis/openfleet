import type { ParseResult, UsageRow } from './types.js';

const ZONED_ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

export const MAX_IDENTIFIER_LENGTH = 128;
const IDENTIFIER_PATTERN = new RegExp(`^[A-Za-z0-9_.:-]{1,${MAX_IDENTIFIER_LENGTH}}$`);

/** A realistic ceiling for one count of one message: 1000 times a large context window. */
export const MAX_TOKEN_COUNT = 1_000_000_000;

/** A line longer than this is not parsed. */
export const MAX_LINE_LENGTH = 512 * 1024;

type TokenField = 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens';

type LineOutcome = { kind: 'row'; row: UsageRow } | { kind: 'skipped' } | { kind: 'rejected' };

const SKIPPED: LineOutcome = { kind: 'skipped' };
const REJECTED: LineOutcome = { kind: 'rejected' };

// Returns one row per assistant message id found in the transcript text, the last line of an id winning, in order
// of first appearance. A non-empty line that yields no row (malformed JSON, not an assistant line, no usable usage)
// is counted in skippedLineCount; a line replaced by a later line of the same id is not.
// A line that no honest transcript writes (too long, an id or model outside IDENTIFIER_PATTERN, a count above
// MAX_TOKEN_COUNT) is skipped too and also counted in rejectedLineCount.
export function parseUsageLines(transcriptText: string): ParseResult {
  const rowsByMessageId = new Map<string, UsageRow>();
  let skippedLineCount = 0;
  let rejectedLineCount = 0;
  for (const line of transcriptText.split('\n')) {
    const isBlankLine = line.trim() === '';
    if (isBlankLine) continue;
    const outcome = outcomeOfLine(line);
    if (outcome.kind === 'row') {
      rowsByMessageId.set(outcome.row.messageId, outcome.row);
      continue;
    }
    skippedLineCount += 1;
    if (outcome.kind === 'rejected') rejectedLineCount += 1;
  }
  return { rows: [...rowsByMessageId.values()], skippedLineCount, rejectedLineCount };
}

function outcomeOfLine(line: string): LineOutcome {
  const isOversized = line.length > MAX_LINE_LENGTH;
  if (isOversized) return REJECTED;
  const entry = parseJsonObject(line);
  if (!entry) return SKIPPED;
  const isAssistantLine = entry.type === 'assistant';
  if (!isAssistantLine) return SKIPPED;
  const message = entry.message;
  if (!isRecord(message)) return SKIPPED;
  const usage = message.usage;
  if (!isRecord(usage)) return SKIPPED;
  const { id, model } = message;
  const { timestamp } = entry;
  if (typeof id !== 'string' || id === '') return SKIPPED;
  if (typeof model !== 'string' || model === '') return SKIPPED;
  const hasHostileIdentifier = !IDENTIFIER_PATTERN.test(id) || !IDENTIFIER_PATTERN.test(model);
  if (hasHostileIdentifier) return REJECTED;
  const hasValidTimestamp = typeof timestamp === 'string' && ZONED_ISO_TIMESTAMP.test(timestamp) && !Number.isNaN(Date.parse(timestamp));
  if (!hasValidTimestamp) return SKIPPED;
  const inputTokens = tokenCount(usage, 'input_tokens');
  const outputTokens = tokenCount(usage, 'output_tokens');
  const cacheReadInputTokens = tokenCount(usage, 'cache_read_input_tokens');
  const cacheCreationInputTokens = tokenCount(usage, 'cache_creation_input_tokens');
  const counts = [inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens];
  const hasExcessiveTokenCount = counts.some((count) => count !== undefined && count > MAX_TOKEN_COUNT);
  if (hasExcessiveTokenCount) return REJECTED;
  const hasUnusableTokenCount = counts.includes(undefined);
  if (hasUnusableTokenCount) return SKIPPED;
  const reportedCost = entry.costUSD;
  const hasReportedCost = typeof reportedCost === 'number' && Number.isFinite(reportedCost) && reportedCost >= 0;
  return {
    kind: 'row',
    row: {
      messageId: id,
      timestamp,
      model,
      inputTokens: inputTokens as number,
      outputTokens: outputTokens as number,
      cacheReadInputTokens: cacheReadInputTokens as number,
      cacheCreationInputTokens: cacheCreationInputTokens as number,
      costUsd: hasReportedCost ? reportedCost : null,
      costStatus: hasReportedCost ? 'reported' : 'unpriced',
    },
  };
}

// An absent field counts as zero; a present field that is not a non-negative safe integer makes the count unusable.
function tokenCount(usage: Record<string, unknown>, field: TokenField): number | undefined {
  const value = usage[field];
  if (value === undefined) return 0;
  const isUsable = typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  return isUsable ? value : undefined;
}

function parseJsonObject(line: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(line);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
