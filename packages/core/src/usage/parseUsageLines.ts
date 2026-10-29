import type { ParseResult, UsageRow } from './types.js';

type TokenField = 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens';

// Returns one row per assistant message id found in the transcript text, the last line of an id winning, in order
// of first appearance. A non-empty line that yields no row (malformed JSON, not an assistant line, no usable usage)
// is counted in skippedLineCount; a line replaced by a later line of the same id is not.
export function parseUsageLines(transcriptText: string): ParseResult {
  const rowsByMessageId = new Map<string, UsageRow>();
  let skippedLineCount = 0;
  for (const line of transcriptText.split('\n')) {
    const isBlankLine = line.trim() === '';
    if (isBlankLine) continue;
    const row = usageRowOfLine(line);
    if (!row) {
      skippedLineCount += 1;
      continue;
    }
    rowsByMessageId.set(row.messageId, row);
  }
  return { rows: [...rowsByMessageId.values()], skippedLineCount };
}

function usageRowOfLine(line: string): UsageRow | undefined {
  const entry = parseJsonObject(line);
  if (!entry) return undefined;
  const isAssistantLine = entry.type === 'assistant';
  if (!isAssistantLine) return undefined;
  const message = entry.message;
  if (!isRecord(message)) return undefined;
  const usage = message.usage;
  if (!isRecord(usage)) return undefined;
  const { id, model } = message;
  const { timestamp } = entry;
  if (typeof id !== 'string' || id === '') return undefined;
  if (typeof model !== 'string' || model === '') return undefined;
  const hasValidTimestamp = typeof timestamp === 'string' && !Number.isNaN(Date.parse(timestamp));
  if (!hasValidTimestamp) return undefined;
  const inputTokens = tokenCount(usage, 'input_tokens');
  const outputTokens = tokenCount(usage, 'output_tokens');
  const cacheReadInputTokens = tokenCount(usage, 'cache_read_input_tokens');
  const cacheCreationInputTokens = tokenCount(usage, 'cache_creation_input_tokens');
  const hasUnusableTokenCount = [inputTokens, outputTokens, cacheReadInputTokens, cacheCreationInputTokens].includes(undefined);
  if (hasUnusableTokenCount) return undefined;
  const reportedCost = entry.costUSD;
  const hasReportedCost = typeof reportedCost === 'number' && Number.isFinite(reportedCost) && reportedCost >= 0;
  return {
    messageId: id,
    timestamp,
    model,
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
    cacheReadInputTokens: cacheReadInputTokens as number,
    cacheCreationInputTokens: cacheCreationInputTokens as number,
    costUsd: hasReportedCost ? reportedCost : null,
    costStatus: hasReportedCost ? 'reported' : 'unpriced',
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
