interface CpuUsage { user: number; system: number }
interface ProcessWithCpuUsage { cpuUsage(previous?: CpuUsage): CpuUsage }

const DEFAULT_ROUNDS = 5;

const processOfTheTestRunner = (globalThis as { process?: ProcessWithCpuUsage }).process;

const cpuMillisecondsSince = (startedAt: CpuUsage | undefined, startedAtWallClock: number): number => {
  if (!processOfTheTestRunner || !startedAt) return performance.now() - startedAtWallClock;
  const { user, system } = processOfTheTestRunner.cpuUsage(startedAt);
  return (user + system) / 1000;
};

/** Returns the CPU time the test process spends while `work` settles; the slices the scheduler gives to other processes do not count. */
export const cpuMillisecondsOfAsync = async (work: () => unknown): Promise<number> => {
  const startedAtWallClock = performance.now();
  const startedAt = processOfTheTestRunner?.cpuUsage();
  await work();
  return cpuMillisecondsSince(startedAt, startedAtWallClock);
};

/** Keeps the fastest CPU time of `rounds` runs: contention only ever adds time, so the minimum is the cost of the code. */
export const expectBestCpuUnderAsync = async (work: () => unknown, ceilingMilliseconds: number, rounds = DEFAULT_ROUNDS): Promise<void> => {
  let best = Infinity;
  for (let round = 0; round < rounds; round++) best = Math.min(best, await cpuMillisecondsOfAsync(work));

  if (best >= ceilingMilliseconds) throw new Error(`The fastest of ${rounds} runs took ${best.toFixed(1)} ms of CPU, the ceiling is ${ceilingMilliseconds} ms`);
};

export const expectBestCpuUnder = (work: () => unknown, ceilingMilliseconds: number, rounds = DEFAULT_ROUNDS): void => {
  let best = Infinity;
  for (let round = 0; round < rounds; round++) {
    const startedAtWallClock = performance.now();
    const startedAt = processOfTheTestRunner?.cpuUsage();
    work();
    best = Math.min(best, cpuMillisecondsSince(startedAt, startedAtWallClock));
  }

  if (best >= ceilingMilliseconds) throw new Error(`The fastest of ${rounds} runs took ${best.toFixed(1)} ms of CPU, the ceiling is ${ceilingMilliseconds} ms`);
};
