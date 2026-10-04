import { describe, expect, it } from 'vitest';
import type { GitPort } from '../notes/gitPort.js';
import { withGitTimeBudget } from './timeBudgetedGitPort.js';

const BUDGET_MS = 4_000;

function recordingGit(output = ' M a.ts') {
  const timeoutsAsked: (number | undefined)[] = [];
  const git: GitPort = {
    statusShort: (_directory, options) => { timeoutsAsked.push(options?.timeoutMs); return output; },
    diffStatOf: (_directory, options) => { timeoutsAsked.push(options?.timeoutMs); return output; },
  };
  return { git, timeoutsAsked };
}

function clockAt(startMs: number) {
  let nowMs = startMs;
  return { nowMs: () => nowMs, advance: (ms: number) => { nowMs += ms; } };
}

describe('withGitTimeBudget', () => {
  it('hands each call the time that is left, not a timeout of its own', () => {
    const { git, timeoutsAsked } = recordingGit();
    const clock = clockAt(1_000);
    const budgeted = withGitTimeBudget(git, { budgetMs: BUDGET_MS, nowMs: clock.nowMs });

    budgeted.statusShort('/repo');
    clock.advance(1_500);
    budgeted.diffStatOf('/repo');

    expect(timeoutsAsked).toEqual([4_000, 2_500]);
  });

  it('answers what the wrapped port answers while the budget lasts', () => {
    const { git } = recordingGit(' M a.ts');
    const budgeted = withGitTimeBudget(git, { budgetMs: BUDGET_MS, nowMs: clockAt(0).nowMs });

    expect(budgeted.statusShort('/repo')).toBe(' M a.ts');
  });

  it('refuses every call once the budget is spent, without reaching git', () => {
    const { git, timeoutsAsked } = recordingGit();
    const clock = clockAt(0);
    const budgeted = withGitTimeBudget(git, { budgetMs: BUDGET_MS, nowMs: clock.nowMs });
    budgeted.statusShort('/repo');
    clock.advance(BUDGET_MS);

    expect(() => budgeted.statusShort('/repo')).toThrow(/budget/);
    expect(() => budgeted.diffStatOf('/repo')).toThrow(/budget/);
    expect(timeoutsAsked).toHaveLength(1);
  });

  it('starts counting at the first call, not when the port is wrapped', () => {
    const { git, timeoutsAsked } = recordingGit();
    const clock = clockAt(0);
    const budgeted = withGitTimeBudget(git, { budgetMs: BUDGET_MS, nowMs: clock.nowMs });

    clock.advance(10_000);
    budgeted.statusShort('/repo');

    expect(timeoutsAsked).toEqual([4_000]);
  });
});
