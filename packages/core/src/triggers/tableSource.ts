import type { DsRowChange, DsRowHistoryEntry, Session, TriggerWhen } from '@openfleet/shared';
import { evaluateConditions } from '../playbooks/kernel/conditionEvaluator.js';
import { log } from '../logger.js';
import type { SessionService } from '../sessions/sessionService.js';
import type { DataStoreRepository } from '../stores/dataStoreRepository.js';
import type { FireLedger } from './fireLedger.js';
import { kernelConditionsOf } from './kernelConditions.js';
import { TABLE_CURSOR_KIND, type TriggerCursors } from './triggerCursors.js';
import { CHAIN_CAUSE_WINDOW_MINUTES, MAX_EVENT_JSON_CHARS, type TriggerEngine } from './triggerEngine.js';
import type { TriggerRecord, TriggerRepository } from './triggerRepository.js';

const CHANGES_PER_PAGE = 200;
/** What one run reads and offers before it hands the rest to the next tick, so a long history never holds the daemon. */
export const MAX_PAGES_PER_RUN = 10;
export const MAX_OFFERS_PER_RUN = 500;
export const NEXT_TICK_DELAY_MS = 1000;
const MINUTE_MS = 60_000;

type TableWhen = Extract<TriggerWhen, { source: 'data_store_query' }>;
type TableTrigger = TriggerRecord & { when: TableWhen };
const isTableTrigger = (trigger: TriggerRecord): trigger is TableTrigger => trigger.when.source === 'data_store_query';

/** What a table trigger remembers: the last change of the history it has dealt with, the row count of the store at that change, and how many changes were too large to offer. */
interface TableCursor { kind: typeof TABLE_CURSOR_KIND; seq: number; count: number; tooLarge: number }
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const isTableCursor = (value: unknown): value is TableCursor => {
  const candidate = value as Partial<TableCursor> | null;
  return candidate?.kind === TABLE_CURSOR_KIND && isCount(candidate.seq) && isCount(candidate.count) && isCount(candidate.tooLarge);
};

interface Offer { dedupKey: string; event: Record<string, unknown>; dueAtMs: number; causedByChainDepth?: number }
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

const rowCountChangeOf = (change: DsRowChange): number => (isCreation(change) ? 1 : isDeletion(change) ? -1 : 0);
const actorLabelOf = (session: Pick<Session, 'emoji' | 'name'>): string => `${session.emoji} ${session.name}`;

export interface TableSourceDeps {
  stores: Pick<DataStoreRepository, 'findStore' | 'findRow' | 'countRows' | 'latestSeq' | 'changesAfter' | 'onChangeRecorded'>;
  triggers: Pick<TriggerRepository, 'listArmed'>;
  cursors: Pick<TriggerCursors, 'read' | 'save'>;
  engine: Pick<TriggerEngine, 'submit' | 'submitBacklog'>;
  sessions: Pick<SessionService, 'list' | 'get'>;
  ledger: Pick<FireLedger, 'causesOf'>;
  schedule: (callback: () => void, delayMs: number) => () => void;
  /** Called with the trigger id for each change not offered because the message of that trigger set its author going. */
  onOfferSuppressedByCause: (triggerId: string) => void;
}

/**
 * Offers the engine the changes of a data store: a new row, a row whose cells changed, a row count that reaches a threshold. It reads the change history of
 * the store from the position its cursor holds, one page at a time: a page is offered to the engine (the ledger keeps the fire, once per dedup key), then the cursor moves past it.
 * A daemon that stops between the two offers the page again, and the ledger absorbs it: nothing is lost, nothing fires twice. A trigger starts at the end of the history when it is armed.
 * A change is never offered to the trigger whose message set its author going; another trigger receives it one step deeper in the chain.
 */
export class TableSource {
  private unsubscribe: (() => void) | undefined;
  private readonly polling = new Set<string>();
  private readonly changedWhilePolling = new Set<string>();
  private readonly pendingTicks = new Map<string, () => void>();
  /** The catch-ups under way, by trigger: the last change they must reach. Until they reach it the changes are judged as a backlog; after it, as live writes. */
  private readonly catchUps = new Map<string, number>();

  constructor(private readonly deps: TableSourceDeps) {}

  /** Offers what was written while the daemon was stopped, as a catch-up that ends at the last change of the history, then follows the writes. */
  start(): void {
    this.unsubscribe = this.deps.stores.onChangeRecorded((storeId) => this.pollStore(storeId));
    for (const trigger of this.armedTableTriggers()) {
      this.guarded(() => {
        const cursor = this.cursorOf(trigger);
        const latestSeq = this.deps.stores.latestSeq(trigger.when.storeId);
        if (cursor !== undefined && latestSeq > cursor.seq) this.catchUps.set(trigger.id, latestSeq);
        this.poll(trigger, 'tick');
      });
    }
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    for (const cancel of this.pendingTicks.values()) cancel();
    this.pendingTicks.clear();
    this.catchUps.clear();
  }

  /** Puts the cursor of a trigger that was just armed at the end of the history: it never moves back, and what was written while the trigger was disarmed is not offered. */
  startFromNow(trigger: TriggerRecord): void {
    if (!isTableTrigger(trigger)) return;
    this.guarded(() => {
      const { stores, cursors } = this.deps;
      const isStoreOfTheProject = stores.findStore(trigger.when.storeId)?.projectId === trigger.projectId;
      if (!isStoreOfTheProject) return;
      this.catchUps.delete(trigger.id);
      const previous = this.cursorOf(trigger);
      const seq = Math.max(previous?.seq ?? 0, stores.latestSeq(trigger.when.storeId));
      cursors.save(trigger.id, { kind: TABLE_CURSOR_KIND, seq, count: stores.countRows(trigger.when.storeId), tooLarge: previous?.tooLarge ?? 0 } satisfies TableCursor);
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
    for (const trigger of this.armedTableTriggers().filter((candidate) => candidate.when.storeId === storeId)) this.guarded(() => this.poll(trigger, 'write'));
  }

  /**
   * A write that happens while the trigger is being polled is read in the next turn, never inside the current one. A write that happens during a catch-up
   * is left to the tick that carries the catch-up on: it must not spend the rest of the backlog as single live offers.
   */
  private poll(trigger: TableTrigger, origin: 'write' | 'tick'): void {
    if (origin === 'write' && this.catchUps.has(trigger.id)) return;
    if (this.polling.has(trigger.id)) {
      this.changedWhilePolling.add(trigger.id);
      return;
    }
    this.polling.add(trigger.id);
    try {
      do {
        this.changedWhilePolling.delete(trigger.id);
        this.readChangesOf(trigger);
      } while (this.changedWhilePolling.has(trigger.id));
    } finally {
      this.polling.delete(trigger.id);
    }
  }

  /** One run: reads pages within the budget; the changes up to the end of a catch-up are a backlog, the ones after it are live writes. */
  private readChangesOf(trigger: TableTrigger): void {
    const { stores, cursors } = this.deps;
    const storeId = trigger.when.storeId;
    const isStoreOfTheProject = stores.findStore(storeId)?.projectId === trigger.projectId;
    if (!isStoreOfTheProject) return void this.catchUps.delete(trigger.id);

    const startingCursor = this.cursorOf(trigger);
    if (startingCursor === undefined) return this.startFromNow(trigger);

    let cursor = startingCursor;
    let latestOffer: Offer | undefined;
    let isHoldingTheLatestOffer = false;
    let pagesLeft = MAX_PAGES_PER_RUN;
    let offersLeft = MAX_OFFERS_PER_RUN;
    let reachedTheEnd = false;
    const offerTheLatestOfTheCatchUp = () => {
      if (!isHoldingTheLatestOffer) return;
      this.offer(trigger, latestOffer === undefined ? [] : [latestOffer], 'backlog');
      cursors.save(trigger.id, cursor);
      latestOffer = undefined;
      isHoldingTheLatestOffer = false;
    };

    while (pagesLeft > 0 && offersLeft > 0) {
      const catchUpEnd = this.catchUps.get(trigger.id);
      const isCatchingUp = catchUpEnd !== undefined && cursor.seq < catchUpEnd;
      if (catchUpEnd !== undefined && !isCatchingUp) {
        offerTheLatestOfTheCatchUp();
        this.catchUps.delete(trigger.id);
      }
      const keepsOnlyTheLatestOffer = isCatchingUp && trigger.policy.backlogPolicy === 'fire_latest_only';
      const pageSize = keepsOnlyTheLatestOffer ? CHANGES_PER_PAGE : Math.min(CHANGES_PER_PAGE, offersLeft);
      const changesRead = stores.changesAfter(storeId, cursor.seq, pageSize);
      const changes = isCatchingUp ? changesRead.filter((change) => change.seq <= (catchUpEnd ?? Infinity)) : changesRead;
      reachedTheEnd = changes.length === 0;
      if (reachedTheEnd) break;
      pagesLeft -= 1;

      const page = this.walk(trigger, cursor, changes);
      cursor = page.cursor;
      if (keepsOnlyTheLatestOffer) {
        latestOffer = page.offers.filter((offer) => this.passesTheConditions(trigger, offer)).at(-1) ?? latestOffer;
        isHoldingTheLatestOffer = true;
        continue;
      }
      offersLeft -= page.offers.length;
      this.offer(trigger, page.offers, isCatchingUp ? 'backlog' : 'live');
      cursors.save(trigger.id, cursor);
    }
    offerTheLatestOfTheCatchUp();
    if (reachedTheEnd) return void this.catchUps.delete(trigger.id);
    if (!this.catchUps.has(trigger.id)) this.catchUps.set(trigger.id, stores.latestSeq(storeId));
    this.continueOnTheNextTick(trigger.id);
  }

  /** Hands a page to the engine; the ledger keeps what it accepts before the caller moves the cursor. */
  private offer(trigger: TableTrigger, offers: Offer[], mode: Mode): void {
    const { engine } = this.deps;
    if (mode === 'backlog') {
      if (offers.length > 0) engine.submitBacklog({ triggerId: trigger.id, offers });
      return;
    }
    for (const offer of offers) engine.submit({ triggerId: trigger.id, dedupKey: offer.dedupKey, event: offer.event, ...(offer.causedByChainDepth !== undefined && { causedByChainDepth: offer.causedByChainDepth }) });
  }

  /** One tick per trigger at a time. */
  private continueOnTheNextTick(triggerId: string): void {
    if (this.pendingTicks.has(triggerId)) return;
    const cancel = this.deps.schedule(() => {
      this.pendingTicks.delete(triggerId);
      const trigger = this.armedTableTriggers().find((candidate) => candidate.id === triggerId);
      if (trigger === undefined) return void this.catchUps.delete(triggerId);
      this.guarded(() => this.poll(trigger, 'tick'));
    }, NEXT_TICK_DELAY_MS);
    this.pendingTicks.set(triggerId, cancel);
  }

  private passesTheConditions(trigger: TableTrigger, offer: Offer): boolean {
    return evaluateConditions(kernelConditionsOf(trigger.conditions), { event: offer.event });
  }

  private cursorOf(trigger: TriggerRecord): TableCursor | undefined {
    const stored = this.deps.cursors.read(trigger.id);
    return isTableCursor(stored) ? stored : undefined;
  }

  /** Reads one page in the order of the journal: the row count is followed change by change, so each crossing of the threshold is the offer of the change that crossed it. */
  private walk(trigger: TableTrigger, from: TableCursor, changes: DsRowHistoryEntry[]): { offers: Offer[]; cursor: TableCursor } {
    const offers: Offer[] = [];
    const causesOfLabel = new Map<string, { triggerIds: Set<string>; chainDepth: number }>();
    let count = from.count;
    let tooLarge = from.tooLarge;
    for (const change of changes) {
      const countBefore = count;
      count += rowCountChangeOf(change.change);
      const event = this.eventOf(trigger, change, { countBefore, countAfter: count });
      if (event === undefined) continue;

      const causes = this.causesOf(change, trigger.projectId, causesOfLabel);
      const isOwnEffect = causes.triggerIds.has(trigger.id);
      if (isOwnEffect) {
        this.deps.onOfferSuppressedByCause(trigger.id);
        continue;
      }
      if (JSON.stringify(event).length > MAX_EVENT_JSON_CHARS) {
        tooLarge += 1;
        log('warn', `trigger ${trigger.id}: change ${change.id} of the table holds more than ${MAX_EVENT_JSON_CHARS} characters and is not offered (${tooLarge} so far)`);
        continue;
      }
      const dueAtMs = Date.parse(change.createdAt);
      const causedByChainDepth = causes.chainDepth > 0 ? causes.chainDepth : undefined;
      const dedupKey = trigger.when.event === 'row_count' ? `row_count:${change.seq}` : `row:${change.id}`;
      offers.push({ dedupKey, event, dueAtMs: Number.isFinite(dueAtMs) ? dueAtMs : 0, ...(causedByChainDepth !== undefined && { causedByChainDepth }) });
    }
    return { offers, cursor: { kind: TABLE_CURSOR_KIND, seq: changes.at(-1)!.seq, count, tooLarge } };
  }

  /** The event a change gives this trigger; undefined when the change is not one it waits for. */
  private eventOf(trigger: TableTrigger, change: DsRowHistoryEntry, counts: { countBefore: number; countAfter: number }): Record<string, unknown> | undefined {
    const { event, storeId, op, value } = trigger.when;
    const store = { id: storeId };
    if (event === 'row_count') {
      const hasCrossed = op !== undefined && value !== undefined && COMPARISONS[op](counts.countAfter, value) && !COMPARISONS[op](counts.countBefore, value);
      return hasCrossed ? { store, row: { count: counts.countAfter } } : undefined;
    }
    const isWanted = event === 'new_matching_rows' ? isCreation(change.change) : isCellDiff(change.change);
    if (!isWanted) return undefined;
    const row = this.deps.stores.findRow(change.rowId, storeId);
    if (row === undefined) return undefined;
    const previous = isCellDiff(change.change) ? Object.fromEntries(Object.entries(change.change).map(([columnId, { from }]) => [columnId, from])) : undefined;
    return { store, row: { id: row.id, ...row.data }, ...(previous !== undefined && { previous }) };
  }

  /**
   * The triggers whose message set the author of a write going, and how deep their chain is. An agent writes as "<emoji> <name>": the sessions that carry that label and
   * their ancestors are the author; a fire that sent a message to one of them in the hour before the write is its cause.
   */
  private causesOf(change: DsRowHistoryEntry, projectId: string, cache: Map<string, { triggerIds: Set<string>; chainDepth: number }>): { triggerIds: Set<string>; chainDepth: number } {
    const none = { triggerIds: new Set<string>(), chainDepth: 0 };
    if (change.actorKind !== 'agent') return none;
    const key = `${change.actorLabel}|${change.createdAt}`;
    const known = cache.get(key);
    if (known !== undefined) return known;

    const authorIds = this.authorSessionIdsOf(change.actorLabel, projectId);
    const writtenAtMs = Date.parse(change.createdAt);
    const isDated = Number.isFinite(writtenAtMs) && authorIds.length > 0;
    const causes = isDated
      ? this.deps.ledger.causesOf({ sessionIds: authorIds, sinceIso: new Date(writtenAtMs - CHAIN_CAUSE_WINDOW_MINUTES * MINUTE_MS).toISOString(), untilIso: change.createdAt })
      : [];
    const result = { triggerIds: new Set(causes.map((cause) => cause.triggerId)), chainDepth: Math.max(0, ...causes.map((cause) => cause.chainDepth)) };
    cache.set(key, result);
    return result;
  }

  /** The sessions of the project that carry the label, and their ancestors of the same project. */
  private authorSessionIdsOf(actorLabel: string, projectId: string): string[] {
    const { sessions } = this.deps;
    const isOfTheProject = (session: Session) => session.projectId === projectId;
    const namesake = sessions.list().filter((session) => isOfTheProject(session) && actorLabelOf(session) === actorLabel);
    const withAncestors = new Set<string>();
    for (const session of namesake) {
      for (let current: Session | undefined = session; current !== undefined && isOfTheProject(current) && !withAncestors.has(current.id); current = current.parentId === undefined ? undefined : sessions.get(current.parentId)) {
        withAncestors.add(current.id);
      }
    }
    return [...withAncestors];
  }
}
