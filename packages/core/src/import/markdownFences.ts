const BACKTICK = '`';

export const longestBacktickRun = (value: string): number =>
  Math.max(0, ...(value.match(/`+/g) ?? []).map((run) => run.length));

export const delimiterLongerThanAnyBacktickRunIn = (value: string, { minimumLength }: { minimumLength: number }): string =>
  BACKTICK.repeat(Math.max(minimumLength, longestBacktickRun(value) + 1));
