export type MillisecondsAtSize = (size: number) => number;

export interface LinearGrowthBudget {
  smallSize: number;
  largeSize: number;
  rounds?: number;
  noiseFloorMilliseconds?: number;
  maxGrowthRatio?: number;
  ceilingMilliseconds?: number;
}

const DEFAULT_ROUNDS = 5;
const DEFAULT_NOISE_FLOOR_MILLISECONDS = 5;
const DEFAULT_MAX_GROWTH_RATIO = 8;
const DEFAULT_CEILING_MILLISECONDS = 2000;

/** Runs `measure` on both sizes round after round, so machine contention hits both alike, and keeps the fastest run of each. */
export const bestMillisecondsAtBothSizes = (measure: MillisecondsAtSize, { smallSize, largeSize, rounds = DEFAULT_ROUNDS }: LinearGrowthBudget) => {
  let small = Infinity;
  let large = Infinity;
  for (let round = 0; round < rounds; round++) {
    small = Math.min(small, measure(smallSize));
    large = Math.min(large, measure(largeSize));
  }
  return { small, large };
};

/**
 * Returns the reasons the cost is not linear; an empty list means it is.
 * The growth ratio only counts when the fastest small run clears the noise floor: the ratio of two tiny times is noise.
 * The absolute ceiling on the large size always counts.
 */
export const linearGrowthProblems = (measure: MillisecondsAtSize, budget: LinearGrowthBudget): string[] => {
  const { noiseFloorMilliseconds = DEFAULT_NOISE_FLOOR_MILLISECONDS, maxGrowthRatio = DEFAULT_MAX_GROWTH_RATIO, ceilingMilliseconds = DEFAULT_CEILING_MILLISECONDS } = budget;
  const { small, large } = bestMillisecondsAtBothSizes(measure, budget);
  const problems: string[] = [];

  const isSmallRunReliable = small >= noiseFloorMilliseconds;
  const growthRatio = large / small;
  if (isSmallRunReliable && growthRatio >= maxGrowthRatio) {
    problems.push(`${budget.largeSize / budget.smallSize}x the input cost ${growthRatio.toFixed(1)}x (${large.toFixed(1)} ms against ${small.toFixed(1)} ms), the bound is ${maxGrowthRatio}x`);
  }
  if (large >= ceilingMilliseconds) {
    problems.push(`the large input took ${large.toFixed(1)} ms, the ceiling is ${ceilingMilliseconds} ms`);
  }
  return problems;
};

export const expectLinearGrowth = (measure: MillisecondsAtSize, budget: LinearGrowthBudget) => {
  const problems = linearGrowthProblems(measure, budget);

  if (problems.length > 0) throw new Error(`Growth is not linear: ${problems.join('; ')}`);
};

/**
 * Builds each text once, then measures the CPU time `run` spends on it.
 * CPU time ignores the slices the scheduler gives to other processes, which stretch a long run more than a short one.
 */
export const cpuMillisecondsToRun = (textOfSize: (size: number) => string, run: (text: string) => unknown): MillisecondsAtSize => {
  const textsBySize = new Map<number, string>();
  return (size) => {
    const text = textsBySize.get(size) ?? textOfSize(size);
    textsBySize.set(size, text);
    const startedAt = process.cpuUsage();
    run(text);
    const { user, system } = process.cpuUsage(startedAt);
    return (user + system) / 1000;
  };
};
