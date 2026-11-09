import type { FireLedger } from './fireLedger.js';

export const DEFAULT_FIRE_RETENTION_DAYS = 90;
export const FIRE_PRUNE_BATCH_SIZE = 1000;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
export const FIRE_PRUNE_INTERVAL_MS = MILLISECONDS_PER_DAY;
const FROM_THE_FIRST_ROW = 0;

/** How much a purge did: the events it forgot, in how many batches (the last one finds less than a full batch). */
export interface FirePruneReport {
  forgotten: number;
  batches: number;
}

export type LetTheEventLoopRun = () => Promise<void>;

const letTheEventLoopRunOnRealLoop: LetTheEventLoopRun = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Forgets the events of the fires that ended a long time ago, a batch at a time, once a day; it hands the event loop back between two batches and never lets a failure reach its caller. */
export class FireRetention {
  private cancelNextRun: (() => void) | undefined;
  private isStopped = false;

  constructor(private readonly deps: {
    ledger: Pick<FireLedger, 'forgetSettledEvents'>;
    clock: () => number;
    schedule: (callback: () => void, delayMs: number) => () => void;
    retentionDays: number;
    onFailure: (error: unknown) => void;
    /** Resolves once the event loop has served what waits for it; defaults to a turn of the real loop. */
    letTheEventLoopRun?: LetTheEventLoopRun;
  }) {}

  /** Arms the daily run; the first one is a day from now. */
  start(): void {
    this.isStopped = false;
    this.scheduleNextRun();
  }

  /** Cancels the next run and ends a purge under way at its next batch. */
  stop(): void {
    this.isStopped = true;
    this.cancelNextRun?.();
    this.cancelNextRun = undefined;
  }

  async forgetOldEvents(): Promise<FirePruneReport> {
    const { ledger, clock, retentionDays, onFailure, letTheEventLoopRun = letTheEventLoopRunOnRealLoop } = this.deps;
    const settledBefore = new Date(clock() - retentionDays * MILLISECONDS_PER_DAY).toISOString();
    const report: FirePruneReport = { forgotten: 0, batches: 0 };
    let afterRowid = FROM_THE_FIRST_ROW;
    try {
      let isLastBatch = false;
      while (!isLastBatch && !this.isStopped) {
        const batch = ledger.forgetSettledEvents({ settledBefore, afterRowid, batchSize: FIRE_PRUNE_BATCH_SIZE });
        afterRowid = batch.lastRowid;
        isLastBatch = batch.forgotten < FIRE_PRUNE_BATCH_SIZE;
        report.forgotten += batch.forgotten;
        report.batches += 1;
        await letTheEventLoopRun();
      }
    } catch (error) {
      onFailure(error);
    }
    return report;
  }

  private scheduleNextRun(): void {
    this.cancelNextRun = this.deps.schedule(() => {
      this.scheduleNextRun();
      void this.forgetOldEvents();
    }, FIRE_PRUNE_INTERVAL_MS);
  }
}
