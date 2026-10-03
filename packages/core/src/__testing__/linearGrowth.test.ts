import { describe, expect, it } from 'vitest';
import { cpuMillisecondsOfAsync, cpuMillisecondsToRun, expectBestCpuUnder, expectLinearGrowth, linearGrowthProblems, type MillisecondsAtSize } from './linearGrowth.js';

const budget = { smallSize: 1000, largeSize: 4000 };
const linearCost: MillisecondsAtSize = (size) => size / 10;
const quadraticCost: MillisecondsAtSize = (size) => (size * size) / 10_000;

/** Replays a fixed sequence of timings per size, as a loaded machine would produce them. */
const replayed = (timingsBySize: Record<number, number[]>): MillisecondsAtSize => {
  const nextIndexBySize = new Map<number, number>();
  return (size) => {
    const index = nextIndexBySize.get(size) ?? 0;
    nextIndexBySize.set(size, index + 1);
    return timingsBySize[size]?.[index] ?? Infinity;
  };
};

describe('linearGrowthProblems', () => {
  it('accepts a linear cost', () => {
    expect(linearGrowthProblems(linearCost, budget)).toEqual([]);
  });

  it('rejects a quadratic cost, and the failure names the ratio', () => {
    const problems = linearGrowthProblems(quadraticCost, budget);

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('4x the input cost 16.0x');
  });

  it('rejects a cost above the ceiling even when the ratio is linear', () => {
    const problems = linearGrowthProblems((size) => size, { ...budget, ceilingMilliseconds: 3000 });

    expect(problems).toEqual(['the large input took 4000.0 ms, the ceiling is 3000 ms']);
  });

  it('ignores the ratio when the fastest small run stays under the noise floor', () => {
    const tinySmallRunsThenOrdinaryLargeRuns = (size: number) => (size === budget.smallSize ? 0.5 : 20);

    expect(linearGrowthProblems(tinySmallRunsThenOrdinaryLargeRuns, budget)).toEqual([]);
  });

  it('keeps the fastest run of each size, so a few contended runs do not fail a linear cost', () => {
    const contendedLargeRuns = replayed({ 1000: [50, 52, 51, 50, 53], 4000: [900, 200, 205, 700, 800] });

    expect(linearGrowthProblems(contendedLargeRuns, { ...budget, rounds: 5 })).toEqual([]);
  });

  it('still fails a quadratic cost when contention inflates some runs', () => {
    const contendedQuadraticRuns = replayed({ 1000: [50, 90, 51, 70, 80], 4000: [900, 800, 810, 1200, 805] });

    expect(linearGrowthProblems(contendedQuadraticRuns, { ...budget, rounds: 5 })).toHaveLength(1);
  });

  it('times the small and the large input alternately', () => {
    const sizesInCallOrder: number[] = [];

    linearGrowthProblems((size) => (sizesInCallOrder.push(size), size / 10), { ...budget, rounds: 3 });

    expect(sizesInCallOrder).toEqual([1000, 4000, 1000, 4000, 1000, 4000]);
  });
});

describe('cpuMillisecondsToRun', () => {
  const budgetOfRealWork = { smallSize: 4_000, largeSize: 16_000 };
  const burn = (iterations: number) => {
    let sink = 0;
    for (let step = 0; step < iterations; step++) sink = (sink + step) % 1_000_003;
    return sink;
  };
  const textOfSize = (size: number) => 'a'.repeat(size);

  it('accepts a function whose real work grows linearly', () => {
    const measure = cpuMillisecondsToRun(textOfSize, (text) => burn(text.length * 2_000));

    expect(linearGrowthProblems(measure, budgetOfRealWork)).toEqual([]);
  }, 30_000);

  it('rejects a function whose real work grows quadratically', () => {
    const measure = cpuMillisecondsToRun(textOfSize, (text) => burn((text.length * text.length) / 4));

    expect(linearGrowthProblems(measure, budgetOfRealWork)).not.toEqual([]);
  }, 30_000);
});

describe('the shape of a list-of-short-strings test, as in describeError', () => {
  const shortStrings = (count: number) => Array.from({ length: count }, (_, index) => `s${index}`);
  const dedupedInLinearTime = (items: string[]) => [...new Set(items)];
  const dedupedInQuadraticTime = (items: string[]) => items.filter((item, index) => items.indexOf(item) === index);
  const budgetOfShortStrings = { smallSize: 5_000, largeSize: 20_000 };

  it('passes when the work on the strings is linear', () => {
    const measure = cpuMillisecondsToRun(shortStrings, dedupedInLinearTime);

    expect(() => expectLinearGrowth(measure, budgetOfShortStrings)).not.toThrow();
  }, 30_000);

  it('fails when the work on the strings is quadratic', () => {
    const measure = cpuMillisecondsToRun(shortStrings, dedupedInQuadraticTime);

    expect(() => expectLinearGrowth(measure, budgetOfShortStrings)).toThrow('Growth is not linear');
  }, 60_000);

  it('fails an absolute ceiling the quadratic work exceeds, whatever the load', () => {
    const items = shortStrings(20_000);

    expect(() => expectBestCpuUnder(() => dedupedInQuadraticTime(items), 1)).toThrow('the ceiling is 1 ms');
  }, 60_000);
});

describe('expectBestCpuUnder', () => {
  it('passes work far below the ceiling', () => {
    expect(() => expectBestCpuUnder(() => 1 + 1, 100)).not.toThrow();
  });

  it('keeps the cheapest run: one expensive first run does not fail it', () => {
    let runs = 0;
    const expensiveOnlyOnTheFirstRun = () => { if (runs++ === 0) for (let step = 0; step < 3e8; step++); };

    expect(() => expectBestCpuUnder(expensiveOnlyOnTheFirstRun, 50)).not.toThrow();
  }, 30_000);

  it('does not count time spent waiting, only CPU time', async () => {
    const cpuMilliseconds = await cpuMillisecondsOfAsync(() => new Promise((resolve) => setTimeout(resolve, 200)));

    expect(cpuMilliseconds).toBeLessThan(50);
  });
});

describe('expectLinearGrowth', () => {
  it('passes on a linear cost', () => {
    expect(() => expectLinearGrowth(linearCost, budget)).not.toThrow();
  });

  it('throws on a quadratic cost', () => {
    expect(() => expectLinearGrowth(quadraticCost, budget)).toThrow('Growth is not linear');
  });
});
