import type { GitPort } from '../notes/gitPort.js';

export interface GitTimeBudgetOptions {
  budgetMs: number;
  nowMs?: () => number;
}

/**
 * One time budget shared by every git call made through the returned port, counted from its first call.
 * Each call may only run for the time left, and a call made after the budget is spent throws without starting git,
 * so a caller that makes many calls (a manager and its children) is held for `budgetMs` in total, not per command.
 */
export function withGitTimeBudget(git: GitPort, { budgetMs, nowMs = Date.now }: GitTimeBudgetOptions): GitPort {
  let startedAtMs: number | undefined;

  const timeLeftMs = (): number => {
    startedAtMs ??= nowMs();
    return budgetMs - (nowMs() - startedAtMs);
  };

  const withinBudget = (ask: (timeoutMs: number) => string): string => {
    const timeoutMs = timeLeftMs();
    if (timeoutMs <= 0) throw new Error('git time budget spent');
    return ask(timeoutMs);
  };

  return {
    statusShort: (directory) => withinBudget((timeoutMs) => git.statusShort(directory, { timeoutMs })),
    diffStatOf: (directory) => withinBudget((timeoutMs) => git.diffStatOf(directory, { timeoutMs })),
  };
}
