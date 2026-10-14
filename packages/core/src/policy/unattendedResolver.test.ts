import { describe, expect, it } from 'vitest';
import { resolveAsk } from './unattendedResolver.js';
import { MAX_REFUSAL_TEXT_CHARS, refusalTextOf } from './refusalText.js';

describe('what happens to a question the CLI wants to put to a human', () => {
  it('is turned into a refusal when nobody watches the session', () => {
    expect(resolveAsk({ isUnwatched: true, askBecomesDeny: true })).toBe('deny');
  });

  it('stays a question when a human watches the session', () => {
    expect(resolveAsk({ isUnwatched: false, askBecomesDeny: true })).toBe('ask');
  });

  it('stays a question when the operator turned the conversion off', () => {
    expect(resolveAsk({ isUnwatched: true, askBecomesDeny: false })).toBe('ask');
  });
});

describe('the refusal text the session reads', () => {
  const refusal = { ruleId: 'no-forced-recursive-rm', reason: 'rm -rf asks for a confirmation nobody sees.', alternative: 'Use `rm -r <path>`.' };

  it('names the rule, the reason and the alternative', () => {
    const text = refusalTextOf({ ...refusal, isUnwatched: true });

    expect(text).toContain('[no-forced-recursive-rm]');
    expect(text).toContain('rm -rf asks for a confirmation nobody sees.');
    expect(text).toContain('Alternative: Use `rm -r <path>`.');
  });

  it('tells an unwatched session why it was refused instead of asked, and where to turn', () => {
    const text = refusalTextOf({ ...refusal, isUnwatched: true });

    expect(text).toContain('No human is watching this session');
    expect(text).toContain('message_parent');
  });

  it('does not claim nobody is watching a session a human watches', () => {
    expect(refusalTextOf({ ...refusal, isUnwatched: false })).not.toContain('No human is watching');
  });

  it('never exceeds the budget, however long the rule texts are', () => {
    const text = refusalTextOf({ ruleId: 'r', reason: 'x'.repeat(2000), alternative: 'y'.repeat(2000), isUnwatched: true });

    expect(text.length).toBeLessThanOrEqual(MAX_REFUSAL_TEXT_CHARS);
    expect(text).toContain('message_parent');
  });
});
