interface TrailingRequest {
  task: () => void;
  cancelTimer: () => void;
}

export interface PerSessionTrailingThrottleOptions {
  windowMs: number;
  /** Milliseconds on a monotonic clock; defaults to performance.now. */
  clock?: () => number;
  /** Runs an admitted task off the caller's stack; defaults to setImmediate. */
  schedule?: (task: () => void) => void;
  /** Starts a timer and returns the function that cancels it; defaults to an unreferenced setTimeout. */
  startTimer?: (task: () => void, delayMs: number) => () => void;
}

const startUnreferencedTimer = (task: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(task, delayMs);
  timer.unref();
  return () => clearTimeout(timer);
};

const readMonotonicClock = (): number => performance.now();

/**
 * Runs at most one task per session in each window. The first request of a window runs at once; the requests made while the
 * window is open collapse into one trailing task that runs when the window ends, so the last request is delayed, never lost.
 * A trailing task replaces the earlier one: the tasks of a session read everything that exists when they run.
 * A session that is forgotten loses its trailing task; dispose runs the trailing tasks of all sessions instead.
 */
export class PerSessionTrailingThrottle {
  private readonly lastRunStartedAt = new Map<string, number>();
  private readonly trailingRequests = new Map<string, TrailingRequest>();
  private readonly generationOfSession = new Map<string, symbol>();
  private readonly windowMs: number;
  private readonly clock: () => number;
  private readonly schedule: (task: () => void) => void;
  private readonly startTimer: (task: () => void, delayMs: number) => () => void;
  private isDisposed = false;

  constructor({ windowMs, clock = readMonotonicClock, schedule = setImmediate, startTimer = startUnreferencedTimer }: PerSessionTrailingThrottleOptions) {
    this.windowMs = windowMs;
    this.clock = clock;
    this.schedule = schedule;
    this.startTimer = startTimer;
  }

  request(sessionId: string, task: () => void): void {
    if (this.isDisposed) return;
    const now = this.clock();
    const lastRunStartedAt = this.lastRunStartedAt.get(sessionId);
    const windowEndsAt = lastRunStartedAt === undefined ? now : lastRunStartedAt + this.windowMs;
    const isInsideTheWindow = now < windowEndsAt;
    if (!isInsideTheWindow) return this.runOffTheCallerStack(sessionId, task, now);
    const trailingRequest = this.trailingRequests.get(sessionId);
    if (trailingRequest) {
      trailingRequest.task = task;
      return;
    }
    const delayUntilWindowEnds = Math.min(windowEndsAt - now, this.windowMs);
    const cancelTimer = this.startTimer(() => this.runTrailing(sessionId), delayUntilWindowEnds);
    this.trailingRequests.set(sessionId, { task, cancelTimer });
  }

  /** Drops the pending and trailing tasks of the session and its window. */
  forget(sessionId: string): void {
    this.dropTrailingRequest(sessionId);
    this.lastRunStartedAt.delete(sessionId);
    this.generationOfSession.delete(sessionId);
  }

  /** Cancels every timer, runs the trailing task of each session one last time and ignores the requests that follow. */
  dispose(): void {
    this.isDisposed = true;
    const pendingTrailingRequests = [...this.trailingRequests.values()];
    pendingTrailingRequests.forEach(({ cancelTimer }) => cancelTimer());
    this.trailingRequests.clear();
    this.lastRunStartedAt.clear();
    pendingTrailingRequests.forEach(({ task }) => task());
  }

  private dropTrailingRequest(sessionId: string): void {
    this.trailingRequests.get(sessionId)?.cancelTimer();
    this.trailingRequests.delete(sessionId);
  }

  private runOffTheCallerStack(sessionId: string, task: () => void, now: number): void {
    this.dropTrailingRequest(sessionId);
    this.lastRunStartedAt.set(sessionId, now);
    const generation = this.generationOf(sessionId);
    this.schedule(() => {
      const wasForgottenMeanwhile = this.generationOfSession.get(sessionId) !== generation;
      if (wasForgottenMeanwhile) return;
      task();
    });
  }

  private generationOf(sessionId: string): symbol {
    const knownGeneration = this.generationOfSession.get(sessionId);
    if (knownGeneration) return knownGeneration;
    const newGeneration = Symbol(sessionId);
    this.generationOfSession.set(sessionId, newGeneration);
    return newGeneration;
  }

  private runTrailing(sessionId: string): void {
    const trailingRequest = this.trailingRequests.get(sessionId);
    if (!trailingRequest) return;
    this.trailingRequests.delete(sessionId);
    this.lastRunStartedAt.set(sessionId, this.clock());
    trailingRequest.task();
  }
}
