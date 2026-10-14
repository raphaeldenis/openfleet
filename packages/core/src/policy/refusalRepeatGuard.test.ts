import { describe, expect, it } from 'vitest';
import { RefusalRepeatGuard } from './refusalRepeatGuard.js';

const SECOND_MS = 1000;

function guardAt(settings = { count: 3, windowSeconds: 300 }) {
  let nowMs = 0;
  const guard = new RefusalRepeatGuard({ clock: () => nowMs, settings: () => settings });
  return { guard, advanceSeconds: (seconds: number) => { nowMs += seconds * SECOND_MS; } };
}
const refusal = { sessionId: 'child', ruleId: 'no-forced-recursive-rm' };

describe('the guard against a child that keeps hitting the same rule', () => {
  it('stays quiet for the first two refusals and speaks at the third', () => {
    const { guard } = guardAt();

    const answers = [guard.registerAndShouldEscalate(refusal), guard.registerAndShouldEscalate(refusal), guard.registerAndShouldEscalate(refusal)];

    expect(answers).toEqual([false, false, true]);
  });

  it('speaks once per window, however many refusals follow', () => {
    const { guard } = guardAt();
    const answers = Array.from({ length: 6 }, () => guard.registerAndShouldEscalate(refusal));

    expect(answers.filter(Boolean)).toHaveLength(1);
  });

  it('speaks again when the window has passed and the child is still stuck', () => {
    const { guard, advanceSeconds } = guardAt();
    for (let attempt = 0; attempt < 3; attempt += 1) guard.registerAndShouldEscalate(refusal);

    advanceSeconds(301);
    const answers = Array.from({ length: 3 }, () => guard.registerAndShouldEscalate(refusal));

    expect(answers).toEqual([false, false, true]);
  });

  it('forgets refusals older than the window', () => {
    const { guard, advanceSeconds } = guardAt();
    guard.registerAndShouldEscalate(refusal);
    guard.registerAndShouldEscalate(refusal);

    advanceSeconds(301);

    expect(guard.registerAndShouldEscalate(refusal)).toBe(false);
  });

  it('counts each session and each rule on its own', () => {
    const { guard } = guardAt();
    guard.registerAndShouldEscalate(refusal);
    guard.registerAndShouldEscalate({ sessionId: 'other', ruleId: refusal.ruleId });

    expect(guard.registerAndShouldEscalate({ sessionId: 'child', ruleId: 'another-rule' })).toBe(false);
  });

  it('follows the threshold the operator configures', () => {
    const { guard } = guardAt({ count: 1, windowSeconds: 60 });

    expect(guard.registerAndShouldEscalate(refusal)).toBe(true);
  });
});
