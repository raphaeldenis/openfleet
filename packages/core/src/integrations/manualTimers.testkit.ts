/** Timers a test drives by hand: nothing here waits for wall-clock time. */
export const createManualTimers = () => {
  const armed: { onElapsed: () => void; delayMs: number; isCancelled: boolean }[] = [];
  return {
    startTimer: (onElapsed: () => void, delayMs: number): (() => void) => {
      const timer = { onElapsed, delayMs, isCancelled: false };
      armed.push(timer);
      return () => { timer.isCancelled = true; };
    },
    armedCount: () => armed.length,
    cancelledCount: () => armed.filter((timer) => timer.isCancelled).length,
    delaysArmed: () => armed.map((timer) => timer.delayMs),
    /** Fires every timer that is still armed, as if its delay had passed. */
    elapseAll: () => { for (const timer of armed.filter((candidate) => !candidate.isCancelled)) { timer.isCancelled = true; timer.onElapsed(); } },
  };
};

export type ManualTimers = ReturnType<typeof createManualTimers>;

const nextTurnOfTheEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** Lets pending promise callbacks and socket events run. */
export const settle = async (turns = 5): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) await nextTurnOfTheEventLoop();
};

/** Waits for a condition by yielding to the event loop, with no duration: a condition that never holds fails by the test runner's own limit. */
export const until = async (condition: () => boolean): Promise<void> => {
  while (!condition()) await nextTurnOfTheEventLoop();
};

export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
};
