import { describe, expect, it } from 'vitest';
import { MAX_IDENTIFIER_LENGTH, MAX_LINE_LENGTH, MAX_TOKEN_COUNT, parseUsageLines } from './parseUsageLines.js';

interface LineOverrides {
  id?: string;
  timestamp?: string;
  model?: string;
  usage?: Record<string, unknown> | null;
  costUSD?: unknown;
}

function assistantLine(overrides: LineOverrides = {}): string {
  const usage = overrides.usage === undefined
    ? { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30, cache_creation_input_tokens: 40 }
    : overrides.usage;
  const entry: Record<string, unknown> = {
    type: 'assistant',
    timestamp: overrides.timestamp ?? '2026-10-01T10:00:00.000Z',
    message: { id: overrides.id ?? 'msg_1', model: overrides.model ?? 'model-a', content: 'fixture', usage },
  };
  if (overrides.costUSD !== undefined) entry.costUSD = overrides.costUSD;
  return JSON.stringify(entry);
}

describe('parseUsageLines', () => {
  it('returns one row with the four token counts of a valid assistant line', () => {
    const result = parseUsageLines(assistantLine());

    expect(result.skippedLineCount).toBe(0);
    expect(result.rows).toEqual([
      {
        messageId: 'msg_1',
        timestamp: '2026-10-01T10:00:00.000Z',
        model: 'model-a',
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 30,
        cacheCreationInputTokens: 40,
        costUsd: null,
        costStatus: 'unpriced',
      },
    ]);
  });

  it('skips and counts an assistant line without usage', () => {
    const result = parseUsageLines(assistantLine({ usage: null }));

    expect(result.rows).toEqual([]);
    expect(result.skippedLineCount).toBe(1);
  });

  it.each(['2026-10-01 23:30:00', '2026-10-01T23:30:00', 'Oct 1 2026', '2026-10-01', '2026-13-01T10:00:00Z'])(
    'skips and counts a line whose timestamp %s has no ISO date-time with a zone',
    (timestamp) => {
      const result = parseUsageLines(assistantLine({ timestamp }));

      expect(result.rows).toEqual([]);
      expect(result.skippedLineCount).toBe(1);
    },
  );

  it('skips and counts malformed JSON without throwing', () => {
    const transcript = ['{"type":"assistant"', 'not json', '[1,2]'].join('\n');

    const result = parseUsageLines(transcript);

    expect(result.rows).toEqual([]);
    expect(result.skippedLineCount).toBe(3);
  });

  it('skips a line whose token count is negative, fractional or unsafe', () => {
    const transcript = [
      assistantLine({ id: 'msg_neg', usage: { input_tokens: -1, output_tokens: 0 } }),
      assistantLine({ id: 'msg_frac', usage: { input_tokens: 1.5, output_tokens: 0 } }),
      assistantLine({ id: 'msg_big', usage: { input_tokens: 2 ** 60, output_tokens: 0 } }),
    ].join('\n');

    const result = parseUsageLines(transcript);

    expect(result.rows).toEqual([]);
    expect(result.skippedLineCount).toBe(3);
  });

  it('ignores lines that are not assistant lines', () => {
    const userLine = JSON.stringify({ type: 'user', timestamp: '2026-10-01T10:00:00.000Z', message: { content: 'fixture' } });

    const result = parseUsageLines(userLine);

    expect(result.rows).toEqual([]);
    expect(result.skippedLineCount).toBe(1);
  });

  it('keeps the last line of a message id that appears several times', () => {
    const transcript = [
      assistantLine({ id: 'msg_1', usage: { input_tokens: 1, output_tokens: 1 } }),
      assistantLine({ id: 'msg_2', usage: { input_tokens: 5, output_tokens: 5 } }),
      assistantLine({ id: 'msg_1', usage: { input_tokens: 1, output_tokens: 99 } }),
    ].join('\n');

    const result = parseUsageLines(transcript);

    expect(result.rows.map((row) => [row.messageId, row.outputTokens])).toEqual([
      ['msg_1', 99],
      ['msg_2', 5],
    ]);
    expect(result.skippedLineCount).toBe(0);
  });

  it('keeps rows of several models', () => {
    const transcript = [
      assistantLine({ id: 'msg_1', model: 'model-a' }),
      assistantLine({ id: 'msg_2', model: 'model-b' }),
    ].join('\n');

    const result = parseUsageLines(transcript);

    expect(result.rows.map((row) => row.model)).toEqual(['model-a', 'model-b']);
  });

  it('reads a reported cost as reported', () => {
    const result = parseUsageLines(assistantLine({ costUSD: 0.0123 }));

    expect(result.rows[0]).toMatchObject({ costUsd: 0.0123, costStatus: 'reported' });
  });

  it('leaves the cost absent and unpriced when the line carries no usable cost', () => {
    const transcript = [
      assistantLine({ id: 'msg_none' }),
      assistantLine({ id: 'msg_text', costUSD: 'free' }),
      assistantLine({ id: 'msg_negative', costUSD: -1 }),
    ].join('\n');

    const result = parseUsageLines(transcript);

    expect(result.rows.map((row) => [row.costUsd, row.costStatus])).toEqual([
      [null, 'unpriced'],
      [null, 'unpriced'],
      [null, 'unpriced'],
    ]);
  });

  it('returns no rows and no skipped lines for an empty transcript', () => {
    expect(parseUsageLines('')).toEqual({ rows: [], skippedLineCount: 0, rejectedLineCount: 0 });
    expect(parseUsageLines('\n\n')).toEqual({ rows: [], skippedLineCount: 0, rejectedLineCount: 0 });
  });

  describe('hostile values', () => {
    it.each([
      ['a message id with a forbidden character', { id: 'msg 1' }],
      ['a message id longer than the limit', { id: 'm'.repeat(MAX_IDENTIFIER_LENGTH + 1) }],
      ['a model with a forbidden character', { model: 'model/<a>' }],
      ['a model longer than the limit', { model: 'm'.repeat(MAX_IDENTIFIER_LENGTH + 1) }],
      ['a token count above the realistic limit', { usage: { input_tokens: MAX_TOKEN_COUNT + 1, output_tokens: 0 } }],
    ])('rejects, skips and counts a line with %s', (_name, overrides) => {
      const result = parseUsageLines(assistantLine(overrides));

      expect(result.rows).toEqual([]);
      expect(result.skippedLineCount).toBe(1);
      expect(result.rejectedLineCount).toBe(1);
    });

    it('accepts an id and a model at the limits of the pattern', () => {
      const atLimit = 'Az09_.:-'.padEnd(MAX_IDENTIFIER_LENGTH, 'x');

      const result = parseUsageLines(assistantLine({ id: atLimit, model: atLimit, usage: { input_tokens: MAX_TOKEN_COUNT, output_tokens: 0 } }));

      expect(result.rows).toHaveLength(1);
      expect(result.rejectedLineCount).toBe(0);
    });

    it('rejects, skips and counts a line longer than the limit without parsing it', () => {
      const oversizedLine = assistantLine({ id: 'msg_1' }).padEnd(MAX_LINE_LENGTH + 1, ' ');

      const result = parseUsageLines(oversizedLine);

      expect(result.rows).toEqual([]);
      expect(result.skippedLineCount).toBe(1);
      expect(result.rejectedLineCount).toBe(1);
    });

    it('does not count an ordinary non-assistant line as rejected', () => {
      const result = parseUsageLines(JSON.stringify({ type: 'user', message: { content: 'x' } }));

      expect(result.skippedLineCount).toBe(1);
      expect(result.rejectedLineCount).toBe(0);
    });
  });

  it('treats a missing cache count as zero', () => {
    const result = parseUsageLines(assistantLine({ usage: { input_tokens: 3, output_tokens: 4 } }));

    expect(result.rows[0]).toMatchObject({ inputTokens: 3, outputTokens: 4, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 });
  });
});
