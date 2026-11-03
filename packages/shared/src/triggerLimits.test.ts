import { describe, expect, it } from 'vitest';
import { escapedControlsOf, MAX_RUN_INPUT_DEPTH, MAX_RUN_INPUT_KEYS, MAX_RUN_INPUT_NODES, TriggerRunSchema, TriggerWhenSchema } from './triggers.js';

const runWith = (inputs: unknown) => TriggerRunSchema.safeParse({ kind: 'run_playbook', playbookId: 'p1', inputs });
const nested = (depth: number): unknown => (depth === 0 ? 'leaf' : { next: nested(depth - 1) });

describe('the inputs of a run_playbook RUN are bounded', () => {
  it('accepts a modest object, an object with as many levels as the depth limit and none at all', () => {
    expect(runWith({ ticket: 'CCM-1', count: 3, tags: ['a', 'b'] }).success).toBe(true);
    expect(runWith(nested(MAX_RUN_INPUT_DEPTH)).success).toBe(true);
    expect(TriggerRunSchema.safeParse({ kind: 'run_playbook', playbookId: 'p1' }).success).toBe(true);
  });

  it('refuses one level more than the depth limit', () => {
    expect(runWith(nested(MAX_RUN_INPUT_DEPTH + 1)).success).toBe(false);
  });

  it('refuses more top-level keys than the cap', () => {
    const keys = (count: number) => Object.fromEntries(Array.from({ length: count }, (_, position) => [`k${position}`, 1]));

    expect(runWith(keys(MAX_RUN_INPUT_KEYS)).success).toBe(true);
    expect(runWith(keys(MAX_RUN_INPUT_KEYS + 1)).success).toBe(false);
  });

  it('refuses a tree with more nodes than the cap, whatever its depth and top-level width', () => {
    expect(runWith({ list: Array.from({ length: MAX_RUN_INPUT_NODES }, () => 1) }).success).toBe(false);
  });

  it('refuses a tree deeper than the cap', () => {
    expect(runWith({ a: nested(MAX_RUN_INPUT_DEPTH + 2) }).success).toBe(false);
  });

  it('refuses a serialized size above the cap and a key that is too long', () => {
    expect(runWith({ text: 'x'.repeat(9000) }).success).toBe(false);
    expect(runWith({ [`k${'y'.repeat(100)}`]: 1 }).success).toBe(false);
  });

  it('refuses a value JSON cannot hold', () => {
    expect(runWith({ big: 10n }).success).toBe(false);
    expect(runWith({ fn: () => 1 }).success).toBe(false);
  });
});

describe('the cron expression and the time zone are bounded', () => {
  const cron = (expression: string, timezone = 'Europe/Paris') => TriggerWhenSchema.safeParse({ source: 'cron', expression, timezone });

  it('accepts a normal expression and refuses one longer than 100 characters, however many fields it has', () => {
    expect(cron('*/5 9-17 * * 1-5').success).toBe(true);
    expect(cron(`${Array.from({ length: 40 }, (_, minute) => minute).join(',')} * * * *`).success).toBe(false);
    expect(cron(`${'1,'.repeat(100000)}1 * * * *`).success).toBe(false);
  });

  it('refuses a time zone longer than 64 characters before looking it up', () => {
    expect(cron('* * * * *', 'Europe/Paris').success).toBe(true);
    expect(cron('* * * * *', `Europe/${'P'.repeat(100000)}`).success).toBe(false);
  });
});

describe('escapedControlsOf', () => {
  it('shows a control character as its code and keeps line breaks, tabs and printable text', () => {
    const escape = String.fromCharCode(27);
    const nul = String.fromCharCode(0);

    expect(escapedControlsOf(`a${nul}b${escape}[31mc\nd\te`)).toBe('a\\u0000b\\u001b[31mc\nd\te');
  });

  it('shows the format characters that hide text, such as a right-to-left override', () => {
    expect(escapedControlsOf(`ab‮cd`)).toBe('ab\\u202ecd');
  });
});
