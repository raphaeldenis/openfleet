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
export const cpuMillisecondsToRun = <Input = string>(inputOfSize: (size: number) => Input, run: (input: Input) => unknown): MillisecondsAtSize => {
  const inputsBySize = new Map<number, Input>();
  return (size) => {
    const input = inputsBySize.has(size) ? (inputsBySize.get(size) as Input) : inputOfSize(size);
    inputsBySize.set(size, input);
    return cpuMillisecondsOf(() => run(input));
  };
};

const cpuMillisecondsSince = (startedAt: NodeJS.CpuUsage) => {
  const { user, system } = process.cpuUsage(startedAt);
  return (user + system) / 1000;
};

/** Returns the CPU time the process spends in `work`; the slices the scheduler gives to other processes do not count. */
export const cpuMillisecondsOf = (work: () => unknown): number => {
  const startedAt = process.cpuUsage();
  work();
  return cpuMillisecondsSince(startedAt);
};

/** Async twin of `cpuMillisecondsOf`: CPU time of the whole process while `work` settles, waits on I/O excluded. */
export const cpuMillisecondsOfAsync = async (work: () => Promise<unknown>): Promise<number> => {
  const startedAt = process.cpuUsage();
  await work();
  return cpuMillisecondsSince(startedAt);
};

const DEFAULT_CEILING_ROUNDS = 5;

/** Keeps the fastest CPU time of `rounds` runs: contention only ever adds time, so the minimum is the cost of the code. */
export const bestCpuMillisecondsOf = (work: () => unknown, rounds = DEFAULT_CEILING_ROUNDS): number => {
  let best = Infinity;
  for (let round = 0; round < rounds; round++) best = Math.min(best, cpuMillisecondsOf(work));
  return best;
};

export const bestCpuMillisecondsOfAsync = async (work: () => Promise<unknown>, rounds = DEFAULT_CEILING_ROUNDS): Promise<number> => {
  let best = Infinity;
  for (let round = 0; round < rounds; round++) best = Math.min(best, await cpuMillisecondsOfAsync(work));
  return best;
};

export const expectBestCpuUnder = (work: () => unknown, ceilingMilliseconds: number, rounds = DEFAULT_CEILING_ROUNDS) => {
  const best = bestCpuMillisecondsOf(work, rounds);

  if (best >= ceilingMilliseconds) throw new Error(`The fastest of ${rounds} runs took ${best.toFixed(1)} ms of CPU, the ceiling is ${ceilingMilliseconds} ms`);
};

export const expectBestCpuUnderAsync = async (work: () => Promise<unknown>, ceilingMilliseconds: number, rounds = DEFAULT_CEILING_ROUNDS) => {
  const best = await bestCpuMillisecondsOfAsync(work, rounds);

  if (best >= ceilingMilliseconds) throw new Error(`The fastest of ${rounds} runs took ${best.toFixed(1)} ms of CPU, the ceiling is ${ceilingMilliseconds} ms`);
};
