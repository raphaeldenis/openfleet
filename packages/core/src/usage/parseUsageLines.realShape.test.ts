import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseUsageLines } from './parseUsageLines.js';

const realShapeTranscriptText = readFileSync(new URL('./__fixtures__/real-shape-usage.jsonl', import.meta.url), 'utf8');

describe('parseUsageLines on the real-shape fixture', () => {
  it('reads every line of the fixture without skipping any', () => {
    const result = parseUsageLines(realShapeTranscriptText);

    expect(result.skippedLineCount).toBe(0);
  });

  it('merges the repeated lines of one message id into a single row', () => {
    const result = parseUsageLines(realShapeTranscriptText);

    expect(result.rows.map((row) => row.messageId)).toEqual(['m1']);
  });

  it('reads the model, the zoned timestamp and the four token counts as written in the transcript', () => {
    const [row] = parseUsageLines(realShapeTranscriptText).rows;

    expect(row).toMatchObject({
      model: 'claude-opus-4-6',
      timestamp: '2026-10-26T15:51:33.610Z',
      inputTokens: 3,
      outputTokens: 288,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 6012,
    });
  });

  it('marks the row unpriced because the real lines carry no cost field', () => {
    const [row] = parseUsageLines(realShapeTranscriptText).rows;

    expect(row).toMatchObject({ costUsd: null, costStatus: 'unpriced' });
  });
});
