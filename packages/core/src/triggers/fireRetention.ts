import type { FireLedger } from './fireLedger.js';

export const DEFAULT_FIRE_RETENTION_DAYS = 90;
export const FIRE_PRUNE_BATCH_SIZE = 1000;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
export const FIRE_PRUNE_INTERVAL_MS = MILLISECONDS_PER_DAY;

/** How much a prune did: the fires it removed, in how many batches (the last one finds less than a full batch). */
export interface FirePruneReport {
  removed: number;
  batches: number;
}

/** Forgets the fires that ended a long time ago, a batch at a time, and never lets a failure reach its caller. */
export class FireRetention {
  private lastPrunedAtMs: number | undefined;

  constructor(private readonly deps: {
    ledger: Pick<FireLedger, 'pruneSettled'>;
    clock: () => number;
    retentionDays: number;
    onFailure: (error: unknown) => void;
  }) {}

  pruneAtBoot(): FirePruneReport {
    return this.prune();
  }

  /** Prunes when a day has passed since the last prune; a call in between costs one comparison. */
  pruneWhenDue(): void {
    const { clock } = this.deps;
    const isPruneDue = this.lastPrunedAtMs === undefined || clock() - this.lastPrunedAtMs >= FIRE_PRUNE_INTERVAL_MS;
    if (isPruneDue) this.prune();
  }

  private prune(): FirePruneReport {
    const { ledger, clock, retentionDays, onFailure } = this.deps;
    const now = clock();
    this.lastPrunedAtMs = now;
    const settledBefore = new Date(now - retentionDays * MILLISECONDS_PER_DAY).toISOString();
    const report: FirePruneReport = { removed: 0, batches: 0 };
    try {
      let removedInBatch: number;
      do {
        removedInBatch = ledger.pruneSettled({ settledBefore, batchSize: FIRE_PRUNE_BATCH_SIZE });
        report.removed += removedInBatch;
        report.batches += 1;
      } while (removedInBatch === FIRE_PRUNE_BATCH_SIZE);
    } catch (error) {
      onFailure(error);
    }
    return report;
  }
}
