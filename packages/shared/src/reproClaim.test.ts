import { describe, expect, it } from 'vitest';
import { MAX_REPRO_COMMAND_CHARS, MAX_REPRO_OUTPUT_CHARS, ReproClaimSchema, REPRO_CLAIM_EXAMPLE, REPRO_STATUSES, SHAPE_MESSAGE } from './reproClaim.js';

/** The cap describeError applies to the message of an error envelope. */
const MAX_ERROR_MESSAGE_CHARS = 300;

const executed = { claim: 'the filter is missing', status: 'proven', command: 'pnpm vitest run filter.test.ts', output: 'FAIL filter.test.ts > shows the filter' };
const issueMessagesOf = (input: unknown) => {
  const parsed = ReproClaimSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((issue) => issue.message);
};

describe('ReproClaimSchema', () => {
  it('lists the three statuses', () => {
    expect(REPRO_STATUSES).toEqual(['proven', 'plausible', 'not_reproduced']);
  });

  it.each([
    ['a proven claim with its command and output', executed],
    ['a plausible claim with its command and output', { ...executed, status: 'plausible' }],
    ['a not_reproduced claim with no command and no output', { claim: 'read in src/a.ts:12', status: 'not_reproduced' }],
    ['a not_reproduced claim that still gives its attempt', { claim: 'read in src/a.ts:12', status: 'not_reproduced', command: 'pnpm test', output: 'green' }],
    ['an output of the maximum length', { ...executed, output: 'x'.repeat(MAX_REPRO_OUTPUT_CHARS) }],
    ['a command of the maximum length', { ...executed, command: 'x'.repeat(MAX_REPRO_COMMAND_CHARS) }],
    ['an output on several lines', { ...executed, output: 'line one\nline two' }],
  ])('accepts %s', (_name, input) => {
    expect(ReproClaimSchema.safeParse(input).success).toBe(true);
  });

  it.each([
    ['a proven claim without command', { claim: 'c', status: 'proven', output: 'red' }],
    ['a proven claim without output', { claim: 'c', status: 'proven', command: 'pnpm test' }],
    ['a plausible claim without evidence', { claim: 'c', status: 'plausible' }],
    ['a proven claim whose output is blank', { ...executed, output: '  \n ' }],
    ['a proven claim whose command is blank', { ...executed, command: '   ' }],
    ['a claim without status', { claim: 'c' }],
    ['an unknown status', { ...executed, status: 'PROUVÉ' }],
    ['an empty claim', { ...executed, claim: '' }],
    ['a claim of 301 characters', { ...executed, claim: 'x'.repeat(301) }],
    ['a command over the maximum length', { ...executed, command: 'x'.repeat(MAX_REPRO_COMMAND_CHARS + 1) }],
    ['an output over the maximum length', { ...executed, output: 'x'.repeat(MAX_REPRO_OUTPUT_CHARS + 1) }],
    ['the former plain text form', 'the filter is missing'],
  ])('refuses %s', (_name, input) => {
    expect(ReproClaimSchema.safeParse(input).success).toBe(false);
  });

  it('teaches the whole new form to a reporter that still sends a plain text claim', () => {
    const messages = issueMessagesOf('the filter is missing');

    expect(messages).toEqual([expect.stringContaining(SHAPE_MESSAGE)]);
    expect(REPRO_CLAIM_EXAMPLE).toMatch(/claim:.*status:.*command:.*output:/);
  });

  it('tells a reporter whose proven claim lacks evidence to run it or to label it not_reproduced', () => {
    const [message] = issueMessagesOf({ claim: 'c', status: 'proven' });

    expect(message).toContain('not_reproduced');
    expect(message).toContain(SHAPE_MESSAGE);
  });

  it('tells a reporter whose status is unknown the three statuses', () => {
    const [message] = issueMessagesOf({ ...executed, status: 'maybe' });

    expect(message).toContain('proven | plausible | not_reproduced');
    expect(message).toContain(SHAPE_MESSAGE);
  });

  it.each([
    ['a plain text claim', 'the filter is missing'],
    ['a proven claim without evidence', { claim: 'c', status: 'proven' }],
    ['an unknown status', { ...executed, status: 'maybe' }],
  ])('keeps the message for %s within the 300 characters the error envelope allows', (_name, input) => {
    const [message] = issueMessagesOf(input);

    expect(message!.length).toBeLessThanOrEqual(MAX_ERROR_MESSAGE_CHARS);
  });
});
