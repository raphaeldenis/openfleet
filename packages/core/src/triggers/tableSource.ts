import type { DsRowChange, DsRowHistoryEntry, TriggerWhen } from '@openfleet/shared';
import { log } from '../logger.js';
import type { DataStoreRepository } from '../stores/dataStoreRepository.js';
import { TABLE_CURSOR_KIND, type TriggerCursors } from './triggerCursors.js';
import type { TriggerEngine } from './triggerEngine.js';
import type { TriggerRecord, TriggerRepository } from './triggerRepository.js';

const CHANGES_PER_READ = 200;

type TableWhen = Extract<TriggerWhen, { source: 'data_store_query' }>;
type TableTrigger = TriggerRecord & { when: TableWhen };
const isTableTrigger = (trigger: TriggerRecord): trigger is TableTrigger => trigger.when.source === 'data_store_query';

/** What a table trigger remembers: the last change of the history it has looked at, and whether the row count met its threshold then. */
interface TableCursor { kind: typeof TABLE_CURSOR_KIND; seq: number; met: boolean }
const isTableCursor = (value: unknown): value is TableCursor => {
  const candidate = value as Partial<TableCursor> | null;
  return candidate?.kind === TABLE_CURSOR_KIND && Number.isSafeInteger(candidate.seq) && typeof candidate.met === 'boolean';
};

interface Offer { dedupKey: string; event: Record<string, unknown>; dueAtMs: number }
type Mode = 'live' | 'backlog';

const isCreation = (change: DsRowChange): boolean => (change as { kind?: unknown }).kind === 'create';
const isDeletion = (change: DsRowChange): boolean => (change as { kind?: unknown }).kind === 'delete';
const isCellDiff = (change: DsRowChange): change is Record<string, { from: unknown; to: unknown }> => typeof (change as { kind?: unknown }).kind !== 'string';

const COMPARISONS: Readonly<Record<NonNullable<TableWhen['op']>, (count: number, value: number) => boolean>> = {
  eq: (count, value) => count === value,
  gt: (count, value) => count > value,
  gte: (count, value) => count >= value,
  lt: (count, value) => count < value,
  lte: (count, value) => count <= value,
};

export interface TableSourceDeps {
  stores: Pick<DataStoreRepository, 'findStore' | 'findRow' | 'countRows' | 'latestSeq' | 'changesAfter' | 'onChangeRecorded'>;
  triggers: Pick<TriggerRepository, 'listArmed'>;
  cursors: Pick<TriggerCursors, 'read' | 'save'>;
  engine: Pick<TriggerEngine, 'submit' | 'submitBacklog'>;
}

/**
 * Offers the engine the changes of a data store: a new row, a row whose cells changed, a row count that reaches a threshold. It reads the change history of
 * the store from the position its cursor holds, so a restart loses nothing and a change is looked at once. A trigger starts at the end of the history when it is armed:
 * what happened before is not offered. A change written by the trigger itself is never offered back to it. The ledger keeps a change from firing twice.
 */
export class TableSource {
  private unsubscribe: (() => void) | undefined;
  private readonly polling = new Set<string>();
  private readonly changedWhilePolling = new Set<string>();

  constructor(private readonly deps: TableSourceDeps) {}

  /** Offers what was written while the daemon was stopped, then follows the writes. */
  start(): void {
    this.unsubscribe = this.deps.stores.onChangeRecorded((storeId) => this.pollStore(storeId));
    for (const trigger of this.armedTableTriggers()) this.guarded(() => this.poll(trigger, 'backlog'));
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  /** Puts the cursor of a trigger that was just armed at the end of the history: it never moves back, and what was written while the trigger was disarmed is not offered. */
  startFromNow(trigger: TriggerRecord): void {
    if (!isTableTrigger(trigger)) return;
    this.guarded(() => {
      const { stores, cursors } = this.deps;
      const isStoreOfTheProject = stores.findStore(trigger.when.storeId)?.projectId === trigger.projectId;
      if (!isStoreOfTheProject) return;
      const previousSeq = this.cursorOf(trigger)?.seq ?? 0;
      const seq = Math.max(previousSeq, stores.latestSeq(trigger.when.storeId));
      cursors.save(trigger.id, { kind: TABLE_CURSOR_KIND, seq, met: this.countMeetsThreshold(trigger) } satisfies TableCursor);
    });
  }

  private guarded(work: () => void): void {
    try {
      work();
    } catch (error) {
      log('error', 'the table source failed on a trigger', error);
    }
  }

  private armedTableTriggers(): TableTrigger[] {
    return this.deps.triggers.listArmed().filter(isTableTrigger);
  }

  private pollStore(storeId: string): void {
    for (const trigger of this.armedTableTriggers().filter((candidate) => candidate.when.storeId === storeId)) this.guarded(() => this.poll(trigger, 'live'));
  }

  /** A write that happens while the trigger is being polled (an action that writes) is read in the next turn, never inside the current one. */
  private poll(trigger: TableTrigger, mode: Mode): void {
    if (this.polling.has(trigger.id)) {
      this.changedWhilePolling.add(trigger.id);
      return;
    }
    this.polling.add(trigger.id);
    try {
      do {
        this.changedWhilePolling.delete(trigger.id);
        this.readChangesOf(trigger, mode);
      } while (this.changedWhilePolling.has(trigger.id));
    } finally {
      this.polling.delete(trigger.id);
    }
  }

  private readChangesOf(trigger: TableTrigger, mode: Mode): void {
    const { stores, cursors, engine } = this.deps;
    const storeId = trigger.when.storeId;
    const isStoreOfTheProject = stores.findStore(storeId)?.projectId === trigger.projectId;
    if (!isStoreOfTheProject) return;

    const startingCursor = this.cursorOf(trigger);
    if (startingCursor === undefined) return this.startFromNow(trigger);

    let cursor = startingCursor;
    const backlogOffers: Offer[] = [];
    for (let changes = stores.changesAfter(storeId, cursor.seq, CHANGES_PER_READ); changes.length > 0; changes = stores.changesAfter(storeId, cursor.seq, CHANGES_PER_READ)) {
      const offers = changes.flatMap((change) => this.offersOf(trigger, change));
      const hasChangeByAnother = changes.some((change) => !this.isWrittenBy(trigger, change));
      const countOffer = this.countOfferOf(trigger, { cursor, lastChange: changes.at(-1)!, hasChangeByAnother });
      const allOffers = [...offers, ...countOffer.offers];
      cursor = { kind: TABLE_CURSOR_KIND, seq: changes.at(-1)!.seq, met: countOffer.met };
      if (mode === 'backlog') backlogOffers.push(...allOffers);
      else for (const offer of allOffers) engine.submit({ triggerId: trigger.id, dedupKey: offer.dedupKey, event: offer.event });
      cursors.save(trigger.id, cursor);
    }
    if (backlogOffers.length > 0) engine.submitBacklog({ triggerId: trigger.id, offers: backlogOffers });
  }

  private cursorOf(trigger: TableTrigger | TriggerRecord): TableCursor | undefined {
    const stored = this.deps.cursors.read(trigger.id);
    return isTableCursor(stored) ? stored : undefined;
  }

  private isWrittenBy(trigger: TableTrigger, change: DsRowHistoryEntry): boolean {
    return change.actorKind === 'trigger' && change.actorLabel === trigger.id;
  }

  private offersOf(trigger: TableTrigger, change: DsRowHistoryEntry): Offer[] {
    if (this.isWrittenBy(trigger, change)) return [];
    const wantsNewRows = trigger.when.event === 'new_matching_rows' && isCreation(change.change);
    const wantsUpdates = trigger.when.event === 'row_updated' && isCellDiff(change.change);
    if (!wantsNewRows && !wantsUpdates) return [];

    const row = this.deps.stores.findRow(change.rowId, trigger.when.storeId);
    if (row === undefined) return [];
    const rowEvent = { id: row.id, ...row.data };
    const previous = isCellDiff(change.change) ? Object.fromEntries(Object.entries(change.change).map(([columnId, { from }]) => [columnId, from])) : undefined;
    const event = { store: { id: trigger.when.storeId }, row: rowEvent, ...(previous !== undefined && { previous }) };
    return [{ dedupKey: `row:${change.id}`, event, dueAtMs: this.dueAtMsOf(change) }];
  }

  /** For `row_count`: an offer when the count reaches the threshold after having been off it, caused by a change that the trigger did not write. */
  private countOfferOf(trigger: TableTrigger, { cursor, lastChange, hasChangeByAnother }: { cursor: TableCursor; lastChange: DsRowHistoryEntry; hasChangeByAnother: boolean }): { offers: Offer[]; met: boolean } {
    if (trigger.when.event !== 'row_count') return { offers: [], met: false };
    const met = this.countMeetsThreshold(trigger);
    const hasJustReachedIt = met && !cursor.met && hasChangeByAnother;
    if (!hasJustReachedIt) return { offers: [], met };
    const event = { store: { id: trigger.when.storeId }, row: { count: this.deps.stores.countRows(trigger.when.storeId) } };
    return { offers: [{ dedupKey: `row_count:${lastChange.seq}`, event, dueAtMs: this.dueAtMsOf(lastChange) }], met };
  }

  private countMeetsThreshold(trigger: TableTrigger): boolean {
    const { op, value } = trigger.when;
    if (trigger.when.event !== 'row_count' || op === undefined || value === undefined) return false;
    return COMPARISONS[op](this.deps.stores.countRows(trigger.when.storeId), value);
  }

  private dueAtMsOf(change: DsRowHistoryEntry): number {
    const writtenAtMs = Date.parse(change.createdAt);
    return Number.isFinite(writtenAtMs) ? writtenAtMs : 0;
  }
}
